// @ts-check
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { loadLibrary, validateComponent, componentTemplate, USER_DIR } = require('./library');
const { assign } = require('./engine/pinAssigner');
const { computeClock, solveClock } = require('./engine/clock');
const { analyze, ruleBasedProvider } = require('./ai/advisor');
const { generate, GENERATOR_VERSION } = require('./codegen/generator');
const { writeProject, designFingerprint, relocateLayout, relocateFamilyFiles, removeEmptyDirs, upgradeLegacyVscode, syncCodeIntel, STATE_DIR } = require('./codegen/merge');
const { layout } = require('./codegen/layout');
const cm = require('./codegen/build');
const { detectToolchains } = require('./toolchain');
const { familyOf } = require('./codegen/families');
const { periphClockTable } = require('./engine/periphclock');
const { DRIVERS: REG_DRIVERS } = require('./codegen/regdrivers');
const { ProjectActions } = require('./actions');
const { StatusBar } = require('./statusbar');
const { watchUsb } = require('./debug/usb');
const { detectTools } = require('./debug/tools');
const { probeReport } = require('./debug/report');

/** Klasörde (derleme klasörleri hariç) bir dosyayı arar; derinlik sınırlı */
function findFile(dir, name, depth) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  const hit = entries.find((e) => e.isFile() && e.name === name);
  if (hit) return path.join(dir, name);
  if (depth <= 0) return null;
  for (const e of entries) {
    if (!e.isDirectory() || /^(build|\.git|node_modules|\.embedded-studio)$/.test(e.name)) continue;
    const f = findFile(path.join(dir, e.name), name, depth - 1);
    if (f) return f;
  }
  return null;
}

/** @type {ProjectActions} */
let actions;
/** @type {StatusBar} */
let statusBar;
let libCache = null;
const packs = require('./codegen/packs');
const { parseLine, Simulator } = require('./monitor/telemetry');
const { OpenOcdTarget, SimTarget, simModel, elfSymbols } = require('./debug/session');
const { builtinStm32f4, parseSvd, summary, parseValue, insertField, mask } = require('./debug/registers');
const { readRegion, toIntelHex, checkWrite, simSymbols, MAX_SAVE } = require('./debug/memory');
const fault = require('./debug/fault');
const trace = require('./debug/trace');
const rtos = require('./debug/rtos');
const prog = require('./debug/programmer');
const bl = require('./codegen/bootloader');
const sysboot = require('./debug/sysboot');
const esboot = require('./debug/esboot');
const esign = require('./codegen/es-sign');
const { DEV_IDS } = require('./debug/stm32id');
const A = require('./analyzer');
const serial = require('./monitor/serial');
const i18n = require('./i18n');
const { t } = i18n;

const DESIGN_FILE = 'embedded-studio.json';
const PREVIEW_SCHEME = 'embedded-studio-preview';

// ---- ES-304/305: bootloader imza anahtarları. Özel anahtar yalnızca bu makinede (eklentinin genel depolama klasörü).
const bootKeyFile = (id) => path.join(Studio.storagePath || require('os').tmpdir(), 'keys', `es-boot-${id}.pem`);
/** Anahtar kimliğine göre bu makinedeki özel anahtar (PEM) ya da null */
function bootPrivateKey(id) {
  try {
    return id ? fs.readFileSync(bootKeyFile(id), 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * ES-305: Derle başarılıysa ve imza açıksa imzalı paket: <ad>_signed.bin/.hex, <ad>_full_signed.hex, <ad>_update.json.
 * Özel anahtar bu makinede yoksa uyarır, derlemeyi başarısız saymaz.
 */
async function packAfterBuild(p, config) {
  const mcu = p.lib.mcus[p.design.mcuId];
  if (!(p.design.boot && p.design.boot.enabled) || !mcu) return null;
  const boot = bl.normalizeBoot(p.design.boot, mcu);
  if (!boot.signing || !boot.signOnBuild || !boot.pubKey) return null;
  const design = { ...p.design, build: { ...p.design.build, type: config || p.design.build.type } };
  const elf = path.join(p.root, cm.elfRel(design));
  const dir = path.dirname(elf), base = path.basename(elf, '.elf');
  const id = bl.keyId(boot.pubKey);
  const pem = bootPrivateKey(id);
  const say = (level, text) => (Studio.current ? Studio.current.toast(level, text) : level === 'error' ? vscode.window.showErrorMessage(text) : vscode.window.showWarningMessage(text));
  if (!pem) {
    say('warn', t('İmzalı paket üretilmedi: {0} anahtarının özel kısmı bu makinede yok (Proje Ayarları > Bootloader > İçe aktar).', id));
    return null;
  }
  try {
    const bootHex = path.join(dir, `${base}_boot.hex`);
    const r = esign.packImage({ bin: path.join(dir, `${base}.bin`), pem, pub: boot.pubKey, slotBase: bl.partition(mcu, boot).slotBase, outDir: dir, name: base, bootHex: fs.existsSync(bootHex) ? bootHex : undefined });
    Studio.current?.post({ type: 'build.signed', manifest: r.manifest, files: r.files.map((f) => path.relative(p.root, f).split(path.sep).join('/')) });
    return r;
  } catch (e) {
    say('error', t('İmzalı paket üretilemedi: {0}', e.message));
    return null;
  }
}

/** ES-305: bir uygulama imajını (.bin / .hex / .elf) projenin anahtarıyla imzalar; paket dosyanın yanına yazılır */
async function signImageCommand(uri) {
  const p = currentProject();
  const boot = p && p.design.boot;
  if (!p || !boot || !boot.enabled || !boot.signing || !boot.pubKey) return vscode.window.showErrorMessage(t('Önce Proje Ayarları > Bootloader\'da imza doğrulamayı açın ve anahtar üretin.'));
  const mcu = p.lib.mcus[p.design.mcuId];
  const id = bl.keyId(boot.pubKey);
  const pem = bootPrivateKey(id);
  if (!pem) return vscode.window.showErrorMessage(t('Bu makinede {0} anahtarının özel kısmı yok.', id));
  let file = uri && uri.fsPath;
  if (!file) {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: t('İmzala'), defaultUri: vscode.Uri.file(p.root), filters: { [t('Firmware')]: ['bin', 'hex', 'elf'] } });
    if (!pick || !pick[0]) return undefined;
    file = pick[0].fsPath;
  }
  const part = bl.partition(mcu, bl.normalizeBoot(boot, mcu));
  try {
    let bin;
    if (/\.bin$/i.test(file)) bin = fs.readFileSync(file);
    else {
      let text;
      if (/\.elf$/i.test(file)) {
        const tmp = path.join(require('os').tmpdir(), `es-sign-${Date.now()}.hex`);
        await new Promise((resolve, reject) => require('child_process').execFile(cm.gccTool(p.design.build, 'objcopy'), ['-O', 'ihex', file, tmp], { windowsHide: true },
          (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(undefined))));
        text = fs.readFileSync(tmp, 'utf8');
        fs.rmSync(tmp, { force: true });
      } else text = fs.readFileSync(file, 'utf8');
      const segs = prog.parseIntelHex(text).filter((s) => s.addr >= part.slotBase && s.addr < prog.RAM_BASE);
      if (!segs.length) throw new Error(t('{0} yuva başından (0x{1}) başlamıyor.', path.basename(file), part.slotBase.toString(16).toUpperCase()));
      const hi = Math.max(...segs.map((g) => g.addr + g.bytes.length));
      bin = Buffer.alloc(hi - part.slotBase, 0xff);
      for (const g of segs) Buffer.from(g.bytes).copy(bin, g.addr - part.slotBase);
    }
    const name = path.basename(file).replace(/\.(bin|hex|elf)$/i, '').replace(/_signed$/, '');
    const r = esign.packImage({ bin, pem, pub: boot.pubKey, slotBase: part.slotBase, outDir: path.dirname(file), name });
    vscode.window.showInformationMessage(t('İmzalandı: v{0}, anahtar {1} → {2}', r.manifest.version, id, r.files.map((f) => path.basename(f)).join(', ')));
    return r;
  } catch (e) {
    vscode.window.showErrorMessage(t('İmzalanamadı: {0}', e.message));
    return undefined;
  }
}

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  applyLanguage();
  Studio.extensionPath = context.extensionPath;
  Studio.storagePath = context.globalStorageUri.fsPath;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration?.((e) => {
      if (e.affectsConfiguration('embeddedStudio.hiddenTabs')) Studio.current?.postHiddenTabs();
      if (!e.affectsConfiguration('embeddedStudio.language')) return;
      applyLanguage();
      Studio.current?.reloadHtml();
    }) || { dispose() {} },
    vscode.commands.registerCommand('embeddedStudio.openDesigner', () => Studio.show(context)),
    vscode.commands.registerCommand('embeddedStudio.newProject', async () => (await Studio.show(context)).post({ type: 'welcome', ...welcomeInfo(context) })),
    vscode.commands.registerCommand('embeddedStudio.generateCode', async () => (await Studio.show(context)).generateCode())
  );

  // Kod Üret önizlemesinde "yazılacak içerik" bu şemayla açılır (vscode.diff'in sağ tarafı)
  if (vscode.workspace.registerTextDocumentContentProvider) {
    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PREVIEW_SCHEME, {
      provideTextDocumentContent: (uri) => (Studio.current?.preview?.contents || {})[uri.path.replace(/^\//, '')] ?? ''
    }));
  }

  // ---- ES-201: proje eylemleri ve durum çubuğu (tasarımcı kapalıyken de çalışır) ----
  actions = new ProjectActions(currentProject, {
    onState: () => statusBar && statusBar.refresh(),
    onSize: (s) => Studio.current?.post({ type: 'build.size', ...s }),
    onTask: (name, ok) => Studio.current?.post(ok === null ? { type: 'task.start', name } : { type: 'task.done', name, ok }),
    releaseProbe: () => Studio.current?.releaseProbe(),
    afterBuild: (p, config) => packAfterBuild(p, config)
  });
  statusBar = new StatusBar(actions, currentProject);
  const watcher = vscode.workspace.createFileSystemWatcher?.(`**/${DESIGN_FILE}`);
  if (watcher) {
    ['onDidCreate', 'onDidDelete', 'onDidChange'].forEach((ev) => watcher[ev](() => statusBar.refresh()));
    context.subscriptions.push(watcher);
  }
  context.subscriptions.push(actions, statusBar,
    vscode.commands.registerCommand('embeddedStudio.build', () => actions.build()),
    vscode.commands.registerCommand('embeddedStudio.flash', () => actions.flash()),
    vscode.commands.registerCommand('embeddedStudio.run', () => actions.run()),
    vscode.commands.registerCommand('embeddedStudio.debug', () => actions.debug()),
    vscode.commands.registerCommand('embeddedStudio.terminal', async () => (await Studio.show(context)).post({ type: 'tab', tab: 'terminal' })),
    vscode.commands.registerCommand('embeddedStudio.probe', () => probeCommand()),
    vscode.commands.registerCommand('embeddedStudio.flashFile', (uri) => flashFileCommand(uri)),
    vscode.commands.registerCommand('embeddedStudio.debugLaunchJson', () => launchJsonCommand()),
    vscode.commands.registerCommand('embeddedStudio.debugReset', () => actions.debugReset()),
    vscode.commands.registerCommand('embeddedStudio.disassembly', () => actions.disassembly()),
    vscode.commands.registerCommand('embeddedStudio.signImage', (uri) => signImageCommand(uri)));

  // ---- ES-204: donanım breakpoint sınırı (flash'taki koda konan her breakpoint bir FPB karşılaştırıcısı harcar) ----
  const checkBps = () => {
    if (!currentProject()) return;
    actions.checkBreakpoints((vscode.debug.breakpoints || []).map((b) => ({
      enabled: b.enabled, kind: b.functionName !== undefined ? 'function' : b.location ? 'source' : 'data'
    })));
  };
  if (vscode.debug.onDidChangeBreakpoints) context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(checkBps));

  // ---- ES-202: tak/çıkar izleme; debug probu takılınca (debug oturumu yoksa) kart kendiliğinden sorgulanır ----
  let usbWatch = null;
  let lastDebugProbes = '';
  const onUsb = async () => {
    if (!currentProject()) return;
    const probes = await actions.scanUsb().catch(() => []);
    const sig = probes.filter((x) => x.interfaceCfg).map((x) => x.label + (x.serial || '')).join(',');
    const appeared = sig && sig !== lastDebugProbes;
    lastDebugProbes = sig;
    if (!sig && actions.state.probe) actions.set({ probe: null }); // prob çıkarıldı
    const busy = actions.state.running || vscode.debug.activeDebugSession || (Studio.current && Studio.current.target);
    if (appeared && !busy) actions.probe().catch(() => {});
  };
  const startWatch = () => {
    usbWatch?.dispose();
    usbWatch = null;
    if (!currentProject() || !vscode.workspace.getConfiguration?.('embeddedStudio').get('probe.autoDetect', true)) return;
    usbWatch = watchUsb(onUsb);
    onUsb();
  };
  startWatch();
  if (watcher) ['onDidCreate', 'onDidDelete'].forEach((ev) => watcher[ev](startWatch));
  context.subscriptions.push({ dispose: () => usbWatch?.dispose() });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration?.((e) => { if (e.affectsConfiguration('embeddedStudio.probe.autoDetect')) startWatch(); }) || { dispose() {} });

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  status.text = '$(circuit-board) Embedded Studio';
  status.tooltip = t('Embedded Studio tasarımcısını aç');
  status.command = 'embeddedStudio.openDesigner';
  status.show();
  context.subscriptions.push(status);

  // Klasörde bir tasarım varsa tasarımcıyı doğrudan aç.
  const root = workspaceRoot();
  if (root && fs.existsSync(path.join(root, DESIGN_FILE))) Studio.show(context);
}

const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

/** Açık proje: tasarımcı açıksa onun tasarımı, değilse embedded-studio.json (durum çubuğu ve komutlar için) */
function currentProject() {
  const root = workspaceRoot();
  if (!root || !fs.existsSync(path.join(root, DESIGN_FILE))) return null;
  if (Studio.current && Studio.current.design) return { root, design: Studio.current.design, lib: Studio.current.lib };
  try {
    if (!libCache || libCache.root !== root) libCache = { root, lib: loadLibrary(Studio.extensionPath || __dirname + '/..', root) };
    return { root, design: migrate(JSON.parse(fs.readFileSync(path.join(root, DESIGN_FILE), 'utf8')), libCache.lib), lib: libCache.lib };
  } catch {
    return null;
  }
}

/** ES-204: launch.json üret; GDB sunucusu seçilir (OpenOCD varsayılan) */
async function launchJsonCommand() {
  const { SERVERS } = require('./debug/launch');
  const hint = { openocd: t('ST-Link, J-Link, CMSIS-DAP; ek kurulum gerekmez'), stlink: t('STM32CubeIDE / STM32CubeCLT ile gelir'), pyocd: t('pip install pyocd'), jlink: t('SEGGER J-Link yazılımı') };
  const pick = await vscode.window.showQuickPick(Object.entries(SERVERS).map(([id, s]) => ({ id, label: s.label, description: hint[id] })), { title: t('GDB sunucusu') });
  if (!pick) return false;
  return actions.writeLaunchJson(pick.id);
}

/** ES-203: herhangi bir .elf / .hex / .bin dosyasını seçeneklerle yükle (gezginde sağ tık ya da komut paleti) */
async function flashFileCommand(uri) {
  const p = currentProject();
  if (!p) return vscode.window.showErrorMessage(t('Önce bir Embedded Studio projesi açın.'));
  let file = uri && uri.fsPath;
  if (!file) {
    const pick = await vscode.window.showOpenDialog({
      canSelectMany: false, defaultUri: vscode.Uri.file(path.join(p.root, cm.buildDir(p.design.build))),
      filters: { [t('Firmware')]: ['elf', 'hex', 'bin'] }, openLabel: t('Yükle')
    });
    if (!pick) return false;
    file = pick[0].fsPath;
  }
  let address;
  if (/\.bin$/i.test(file)) {
    const v = await vscode.window.showInputBox({
      prompt: t('.bin dosyası adres bilgisi taşımaz. Hangi adrese yazılsın?'), value: '0x08000000',
      validateInput: (x) => (/^0x[0-9a-f]{1,8}$/i.test(x.trim()) ? null : t('Onaltılık adres girin, ör. 0x08000000'))
    });
    if (!v) return false;
    address = parseInt(v.trim(), 16);
  }
  const set = require('./flasher').flashSettings();
  const items = [
    { id: 'reset', label: t('Yükledikten sonra çalıştır (reset)'), picked: true },
    { id: 'verify', label: t('Doğrula (verify)'), picked: set.verify },
    { id: 'full', label: t('Tam silme (tüm flash; varsayılan: sadece gereken sektörler)'), picked: set.erase === 'full' },
    { id: 'ur', label: t('Reset altında bağlan (connect under reset)'), picked: set.underReset }
  ];
  const chosen = await vscode.window.showQuickPick(items, { canPickMany: true, title: t('{0} yükleme seçenekleri', path.basename(file)) });
  if (!chosen) return false;
  const on = new Set(chosen.map((x) => x.id));
  return actions.flashFileAt(p, file, { reset: on.has('reset'), verify: on.has('verify'), erase: on.has('full') ? 'full' : 'sector', underReset: on.has('ur'), address });
}

/** Prob ve kart raporu: USB problar + OpenOCD ile hedef kimliği + araçlar; Markdown önizlemede açılır */
async function probeCommand() {
  const [r, tools] = await Promise.all([actions.probe(), detectTools().catch(() => [])]);
  const p = currentProject();
  const mcu = p ? p.lib.mcus[p.design.mcuId] : null;
  if (r.match === false) vscode.window.showWarningMessage(t('Bağlı cihaz ({0}) projedeki işlemciyle ({1}) uyuşmuyor.', r.target.name, mcu.name));
  const missing = tools.find((x) => x.required && !x.found);
  if (missing) vscode.window.showWarningMessage(t('{0} bulunamadı: {1}', missing.name, missing.hint));
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: probeReport({ result: r, tools, mcu }) });
  await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
  return r;
}

/** Arayüz dilini ayardan (embeddedStudio.language: auto | tr | en) ve VS Code dilinden belirler. */
function applyLanguage() {
  const setting = vscode.workspace.getConfiguration?.('embeddedStudio').get('language', 'auto') ?? 'auto';
  i18n.setLanguage(i18n.resolveLanguage(setting, vscode.env.language));
}

function welcomeInfo(context) {
  const lib = loadLibrary(context.extensionPath);
  const root = workspaceRoot();
  return {
    mcus: Object.values(lib.mcus).map((m) => ({ id: m.id, name: m.name, board: m.board })),
    here: root && !fs.existsSync(path.join(root, DESIGN_FILE)) ? root : undefined,
    defaultName: root ? path.basename(root).replace(/[^A-Za-z0-9_]/g, '_') : 'embedded_app'
  };
}

/** Eski sürümlerde kaydedilmiş tasarımları güncel biçime getirir. */
function migrate(design, lib) {
  const d = { ...design };
  d.framework = d.framework === 'register' ? 'register' : 'hal';
  d.mode = d.mode === 'pro' ? 'pro' : 'beginner';
  d.project = d.project || { name: 'embedded_app' };
  d.instances = d.instances || [];
  d.locks = d.locks || {};
  // ES-1003: pin etiketleri { PA12: 'Pin_Led' }
  // ES-1005: Pinout'ta komponentsiz GPIO modları { PA5: 'GPIO_Output' }
  d.pinModes = Object.fromEntries(Object.entries(d.pinModes && typeof d.pinModes === 'object' ? d.pinModes : {}).filter(([k, v]) => /^P[A-K]\d{1,2}$/.test(k) && ['GPIO_Input', 'GPIO_Output', 'GPIO_Analog'].includes(v)));
  d.pinLabels = Object.fromEntries(Object.entries(d.pinLabels && typeof d.pinLabels === 'object' ? d.pinLabels : {}).filter(([k, v]) => /^P[A-K]\d{1,2}$/.test(k) && typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
  d.build = cm.normalizeBuild(d.build);
  d.regDrivers = Array.isArray(d.regDrivers) ? d.regDrivers.filter((x) => typeof x === 'string') : [];
  if (!lib.mcus[d.mcuId]) d.mcuId = lib.mcus.stm32f411ceu6 ? 'stm32f411ceu6' : Object.keys(lib.mcus)[0];
  d.boot = bl.normalizeBoot(d.boot, lib.mcus[d.mcuId]); // ES-303
  d.clock = { ...lib.mcus[d.mcuId].clock.default, ...(d.clock || {}) };
  return d;
}

class Studio {
  /** @type {Studio | undefined} */
  static current;

  /** @param {vscode.ExtensionContext} context */
  static async show(context) {
    Studio.extensionPath = context.extensionPath;
    if (Studio.current) {
      Studio.current.panel.reveal();
      return Studio.current;
    }
    const root = workspaceRoot();
    const roots = [vscode.Uri.joinPath(context.extensionUri, 'media')];
    if (root) roots.push(vscode.Uri.file(root));
    const panel = vscode.window.createWebviewPanel('embeddedStudio.designer', 'Embedded Studio', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: roots
    });
    Studio.current = new Studio(panel, context, root);
    return Studio.current;
  }

  /** @param {vscode.WebviewPanel} panel @param {vscode.ExtensionContext} context @param {string | undefined} root */
  constructor(panel, context, root) {
    this.panel = panel;
    this.context = context;
    this.root = root;
    this.lib = loadLibrary(context.extensionPath, root);
    this.design = null;
    this.monitor = undefined;
    /** @type {any[]} */
    this.pending = [];
    this.saveTimer = undefined;
    /** @type {any} */
    this.target = null;
    /** Register tanımları: F411 için yerleşik, diğerlerinde SVD (bağlanınca indirilir) */
    this.peripheralDefs = [];
    this.svdName = '';

    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
    panel.webview.html = this.html();
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m).catch((e) => this.toast('error', e.message)), null, context.subscriptions);
    panel.onDidDispose(() => {
      this.monitor?.stop();
      this.termCloseAll();
      this.dropTrace();
      this.target?.disconnect().catch(() => {});
      this.bootTarget?.disconnect().catch(() => {});
      if (this.esboot) Promise.resolve(this.esboot.close()).catch(() => {});
      clearInterval(this.flushTimer);
      Studio.current = undefined;
    });
    this.flushTimer = setInterval(() => {
      if (!this.pending.length) return;
      this.post({ type: 'telemetry', items: this.pending });
      this.pending = [];
    }, 120);
  }

  get designPath() {
    return this.root ? path.join(this.root, DESIGN_FILE) : undefined;
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  /** Dil değişince arayüzü yeniden yükler; webview 'ready' gönderince durum yeniden yollanır. */
  reloadHtml() {
    this.panel.webview.html = this.html();
  }

  toast(level, text) {
    this.post({ type: 'toast', level, text });
  }

  /** Kütüphaneyi webview'a gönderirken yerel görselleri webview adresine çevirir. */
  libForWebview() {
    const comps = {};
    for (const [id, c] of Object.entries(this.lib.components)) {
      const copy = { ...c };
      delete copy.file;
      copy.imageFile = c.image; // oluşturucuda düzenlerken dosya adı lazım
      if (c.image && !/^https?:|^data:/.test(c.image) && c.file) {
        const abs = path.resolve(path.dirname(c.file), c.image);
        copy.image = fs.existsSync(abs) ? this.panel.webview.asWebviewUri(vscode.Uri.file(abs)).toString() : undefined;
      }
      // Hazır komponentlerin görünen metinleri arayüz diline çevrilir (kullanıcının kendi komponentleri olduğu gibi kalır).
      const shown = c.source === 'user' ? ['category'] : ['name', 'description', 'category'];
      for (const k of shown) if (copy[k]) copy[k] = t(copy[k]);
      comps[id] = copy;
    }
    // Arayüz için aile bilgisi: FPU (yoksa derleme ayarlarında FPU seçimi kapalı) ve APB sayısı
    const mcus = Object.fromEntries(Object.entries(this.lib.mcus).map(([id, m]) => {
      const fam = familyOf(m);
      // Örnek register sürücüleri: bu işlemcide üretilebilenler (ör. DAC'siz işlemcide DAC yok)
      const regDriverIds = REG_DRIVERS.filter((d) => !d.needs || d.needs(m)).map((d) => d.id);
      // ES-303: bootloader bölge boyutları ve UART seçenekleri
      const sizes = bl.sizeOptions(m);
      const boot = { sizes, uarts: bl.uartOptions(m), defaultKB: bl.defaultSize(m), ab: Object.fromEntries(sizes.map((kb) => [kb, bl.abSplit(m, kb)])) }; // ES-304
      return [id, { ...m, fpu: fam.fpu, apbCount: fam.apbCount, series: fam.series, regDriverIds, boot }];
    }));
    return { mcus, components: comps };
  }

  compute() {
    const mcu = this.lib.mcus[this.design.mcuId];
    const result = assign(this.design, this.lib);
    const notes = analyze(this.design, this.lib, result);
    const clock = computeClock(mcu, this.design.clock);
    for (const i of clock.issues) notes.unshift({ level: i.level === 'error' ? 'error' : 'warn', text: t('Saat: {0}', i.text) });
    clock.periphs = periphClockTable(mcu, result, clock);
    return { result, notes, clock };
  }

  pushState() {
    statusBar?.refresh();
    this.post({ type: 'state', design: this.design, ...this.compute(), project: { root: this.root, name: this.design.project.name } });
  }

  loadDesign() {
    if (!this.designPath || !fs.existsSync(this.designPath)) return null;
    return migrate(JSON.parse(fs.readFileSync(this.designPath, 'utf8')), this.lib);
  }

  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.post({ type: 'saving' });
    this.saveTimer = setTimeout(() => {
      if (!this.designPath) return;
      fs.writeFileSync(this.designPath, JSON.stringify(this.design, null, 2) + '\n');
      this.post({ type: 'saved', at: Date.now() });
    }, 400);
  }

  async onMessage(m) {
    switch (m.type) {
      case 'ready': {
        this.post({ type: 'init', lib: this.libForWebview() });
        this.postHiddenTabs();
        this.post({ type: 'prog.history', entries: this.progEntries || [] });
        this.design = this.loadDesign();
        if (this.design) this.pushState();
        else this.post({ type: 'welcome', ...welcomeInfo(this.context) });
        break;
      }
      case 'tabs.hide': {
        // ES-804: kullanıcı ayarı (bütün projeler), moda göre
        const cfg = vscode.workspace.getConfiguration('embeddedStudio');
        const cur = cfg.get('hiddenTabs', {}) || {};
        await cfg.update('hiddenTabs', { ...cur, [m.mode === 'pro' ? 'pro' : 'beginner']: m.hidden }, vscode.ConfigurationTarget.Global);
        break;
      }
      case 'update': {
        const hw = (d) => d && JSON.stringify([d.mcuId, d.rtos, d.framework, d.clock, d.locks, d.instances.map((i) => [i.id, i.componentId, i.label, i.options])]);
        const changed = hw(this.design) !== hw(m.design);
        if (this.design && this.design.mcuId !== m.design.mcuId) this.resetRegisterDefs();
        this.design = migrate(m.design, this.lib);
        this.pushState();
        this.scheduleSave();
        // Monitör düzeni gibi donanımı etkilemeyen değişikliklerde simülasyonları yeniden başlatma.
        if (changed && this.monitor) this.startMonitor();
        if (changed && this.target && this.target.mode === 'sim') this.connectDebug('sim');
        break;
      }
      case 'ask': {
        const s = await ruleBasedProvider.suggest(m.text, this.lib);
        this.post({ type: 'suggestion', ...s, question: m.text });
        break;
      }
      case 'generate':
        await this.generateCode();
        break;
      case 'generate.apply':
        await this.generateCode({ confirmed: true });
        break;
      case 'gen.diff':
        await this.openPreviewDiff(m.path);
        break;
      case 'settings.preview':
        this.post({ type: 'settings.preview', seq: m.seq, ...this.previewSettings(m.settings) });
        break;
      case 'build.detect':
        this.post({ type: 'build.toolchains', items: await detectToolchains() });
        break;
      // ---- ES-304: bootloader imza anahtarı ----
      case 'boot.keyStatus':
        this.postBootKey();
        break;
      case 'boot.keygen':
        await this.bootKeygen();
        break;
      case 'boot.keyImport':
        await this.bootKeyImport();
        break;
      case 'boot.keyExport':
        await this.bootKeyExport();
        break;
      case 'build.pickDir': {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: t('Bu klasörü kullan') });
        if (pick) this.post({ type: 'build.dir', field: m.field, path: pick[0].fsPath });
        break;
      }
      case 'clock.solve': {
        const cfg = solveClock(this.lib.mcus[this.design.mcuId], this.design.clock, m.target);
        if (!cfg) return this.toast('error', t('{0} MHz için geçerli bir PLL ayarı bulunamadı.', m.target));
        this.design.clock = cfg;
        this.pushState();
        this.scheduleSave();
        break;
      }
      // ---- kütüphane ----
      case 'lib.import':
        await this.importComponents();
        break;
      case 'lib.remove':
        await this.removeComponent(m.id);
        break;
      case 'lib.template': {
        const doc = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(componentTemplate(), null, 2) });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(t('Şablonu düzenleyip .json olarak kaydedin, sonra Kütüphane > Ekle ile yükleyin.'));
        break;
      }
      // ---- komponent oluşturucu ----
      case 'comp.validate':
        this.post({ type: 'comp.validation', seq: m.seq, errors: validateComponent(cleanComponent(m.component)) });
        break;
      case 'comp.save':
        await this.saveComponent(m);
        break;
      case 'comp.export': {
        const c = cleanComponent(m.component);
        const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${c.id || t('komponent')}.json`)), filters: { [t('Komponent tanımı')]: ['json'] } });
        if (uri) {
          fs.writeFileSync(uri.fsPath, JSON.stringify(c, null, 2) + '\n');
          this.toast('info', t('Dışa aktarıldı: {0}', path.basename(uri.fsPath)));
        }
        break;
      }
      case 'comp.pickImage': {
        if (!this.root) return this.toast('error', t('Görsel eklemek için önce bir proje açın.'));
        const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [t('Görsel')]: ['png', 'jpg', 'jpeg', 'svg', 'webp'] }, openLabel: t('Görsel olarak kullan') });
        if (!pick) return;
        const dir = path.join(this.root, USER_DIR);
        fs.mkdirSync(dir, { recursive: true });
        const name = `img_${Date.now().toString(36)}${path.extname(pick[0].fsPath).toLowerCase()}`;
        fs.copyFileSync(pick[0].fsPath, path.join(dir, name));
        this.post({ type: 'comp.image', image: name, uri: this.panel.webview.asWebviewUri(vscode.Uri.file(path.join(dir, name))).toString() });
        break;
      }
      case 'datasheet':
        await this.openDatasheet(m.componentId);
        break;
      case 'openExternal':
        vscode.env.openExternal(vscode.Uri.parse(m.url));
        break;
      // ---- proje ----
      case 'project.pickFolder': {
        const pick = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: t('Burada oluştur') });
        if (pick) this.post({ type: 'project.folder', path: pick[0].fsPath });
        break;
      }
      case 'project.create':
        await this.createProject(m);
        break;
      // ---- monitör ----
      case 'monitor.start':
        this.startMonitor();
        break;
      case 'monitor.stop':
        this.monitor?.stop();
        this.monitor = undefined;
        this.post({ type: 'monitor', running: false });
        break;
      // ---- debug ----
      case 'debug.connect':
        await this.connectDebug(m.mode);
        break;
      case 'prog.connect':
        await this.progConnect(m);
        break;
      case 'prog.info':
        await this.progInfo();
        break;
      case 'prog.read':
        await this.progRead(m);
        break;
      case 'prog.compare':
        await this.progCompare(m);
        break;
      case 'prog.erase':
        await this.progErase(m);
        break;
      case 'prog.reset':
        await this.progReset();
        break;
      case 'prog.write':
        await this.progWrite(m);
        break;
      case 'prog.bootInfo':
        await this.progBootInfo();
        break;
      case 'prog.bootDisconnect':
        await this.bootDisconnect();
        break;
      case 'prog.dfu':
        await this.progDfu(m);
        break;
      case 'debug.disconnect':
        await this.dropTrace();
        await this.target?.disconnect().catch(() => {});
        this.target = null;
        this.post({ type: 'debug.status', connected: false });
        break;
      case 'debug.cmd':
        await this.debugCommand(m.cmd);
        break;
      case 'debug.read':
        await this.debugRead(m);
        break;
      case 'debug.symbols':
        await this.debugSymbols();
        break;
      case 'debug.svd':
        await this.loadSvd(true);
        break;
      case 'debug.periph':
        this.postPeripheral(m.name);
        break;
      case 'debug.write':
        await this.debugWrite(m);
        break;
      case 'debug.fav':
        this.setFavorite(m.key, m.on);
        break;
      case 'debug.memwrite':
        await this.memoryWrite(m);
        break;
      case 'debug.memsave':
        await this.memorySave(m);
        break;
      case 'debug.watch':
        this.saveDebugState({ watch: m.list });
        break;
      case 'debug.fault':
        await this.faultAnalyze(m.simulate);
        break;
      case 'debug.source':
        await this.openSource(m.file, m.line);
        break;
      // ES-208: SWO/ITM, RTT, semihosting
      case 'debug.traceInfo':
        this.postTraceInfo();
        break;
      case 'debug.swo':
        await this.traceCall(() => (m.on ? this.startSwo(m) : this.trace.stopSwo()));
        break;
      case 'debug.rtt':
        await this.traceCall(() => (m.on ? this.startRtt(m) : this.trace.stopRtt()));
        break;
      case 'debug.rttSend':
        await this.traceCall(() => this.trace.rttSend(Number(m.ch) || 0, String(m.text), m.eol ?? '\n'));
        break;
      case 'debug.semi':
        await this.traceCall(() => this.trace.semihosting(!!m.on));
        break;
      case 'debug.profileReset':
        this.trace?.resetProfile();
        break;
      // ES-209: FreeRTOS
      case 'debug.rtos':
        await this.rtosSnapshot();
        break;
      case 'debug.rtosStack':
        await this.rtosStack(m.tcb);
        break;
      case 'debug.consoleSave':
        await this.saveConsole(m.text, m.name);
        break;
      case 'build':
        await actions.build();
        break;
      // ES-210: bellek kullanım raporu
      // ES-211: seri port terminali
      case 'term.init':
        this.post({ type: 'term.config', config: this.termConfig(), platform: process.platform });
        await this.termPorts(false);
        break;
      case 'term.ports':
        await this.termPorts(!!m.quick);
        break;
      case 'term.open':
        await this.termOpen(m);
        break;
      case 'term.close':
        await this.termClose(m.id);
        break;
      case 'term.send':
        this.termSend(m.id, Buffer.from(String(m.data || ''), 'base64'));
        break;
      case 'term.signals':
        this.terms.get(m.id)?.sess.signals(m.dtr, m.rts);
        break;
      case 'term.break':
        this.terms.get(m.id)?.sess.sendBreak(m.ms);
        break;
      case 'term.log':
        await this.termLog(m);
        break;
      case 'term.config':
        this.saveTermConfig(m.config);
        break;
      case 'term.save':
        await this.saveConsole(m.text, m.name);
        break;
      case 'analyzer.run':
        await this.analyzeBuild(m.config);
        break;
      case 'analyzer.source':
        await this.analyzerSource(m);
        break;
      case 'flash':
        await this.flash();
        break;
    }
  }

  // ------------------------------------------------------------------ proje
  async createProject(m) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m.name || '')) return this.toast('error', t('Proje adı harf ile başlamalı; sadece harf, rakam ve _ içerebilir.'));
    const dir = m.location === 'here' ? this.root : path.join(m.location, m.name);
    if (!dir) return this.toast('error', t('Bir konum seçin.'));
    if (fs.existsSync(path.join(dir, DESIGN_FILE))) return this.toast('error', t('Bu klasörde zaten bir Embedded Studio projesi var.'));
    fs.mkdirSync(dir, { recursive: true });
    const design = migrate({
      mcuId: m.mcuId, framework: m.framework, rtos: !!m.rtos, mode: m.mode, project: { name: m.name },
      instances: [{ id: 'c1', componentId: 'usb_uart', label: 'USB_UART_1' }], locks: {}
    }, this.lib);
    fs.writeFileSync(path.join(dir, DESIGN_FILE), JSON.stringify(design, null, 2) + '\n');
    // Otomatik kaydetme: projedeki tüm dosyalar için
    fs.mkdirSync(path.join(dir, '.vscode'), { recursive: true });
    const settings = path.join(dir, '.vscode', 'settings.json');
    if (!fs.existsSync(settings)) fs.writeFileSync(settings, JSON.stringify({ 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000 }, null, 2) + '\n');

    if (m.downloadPacks) {
      const mcu = this.lib.mcus[design.mcuId];
      const ok = await this.installPacks(dir, mcu, design.framework, design.rtos, cm.rtosPort(design.build, mcu));
      if (!ok) this.toast('warn', t('Paketler indirilemedi; Kod Üret sırasında tekrar denenecek.'));
    }
    if (dir === this.root) {
      this.design = design;
      this.pushState();
      this.toast('info', t('"{0}" projesi oluşturuldu.', m.name));
    } else {
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(dir), { forceNewWindow: false });
    }
  }

  /** HAL/CMSIS/FreeRTOS paketlerini (gerekirse indirip) projeye kopyalar. */
  async installPacks(root, mcu, framework, rtos, rtosPort = 'ARM_CM4F') {
    const need = packs.missingInProject(root, mcu, framework, rtos, rtosPort);
    if (!need.length) return true;
    const cache = path.join(this.context.globalStorageUri.fsPath, 'packs');
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Embedded Studio', cancellable: false }, async (p) => {
        await packs.ensurePacks(cache, need, (msg) => p.report({ message: msg }));
        p.report({ message: t('Projeye kopyalanıyor...') });
        packs.installIntoProject(cache, root, mcu, need, framework);
      });
      return true;
    } catch (e) {
      vscode.window.showErrorMessage(t('Paket indirilemedi: {0}. Git kurulu ve internet bağlantısı var mı?', e.message));
      return false;
    }
  }

  /**
   * Proje ayarı (MCU / altyapı / RTOS) değişirse hangi üretilen dosyaların ekleneceğini, kaldırılacağını,
   * değişeceğini hesaplar. Diske dokunmaz: iki tasarım için üretimi bellekte çalıştırıp karşılaştırır.
   */
  previewSettings(s) {
    const cur = this.design;
    const mcuChanged = s.mcuId !== cur.mcuId;
    const next = migrate({ ...cur, mcuId: s.mcuId, framework: s.framework, rtos: !!s.rtos, locks: mcuChanged ? {} : cur.locks, clock: mcuChanged ? undefined : cur.clock }, this.lib);
    const cache = path.join(this.context.globalStorageUri.fsPath, 'packs');
    const halConfTemplate = (d) => (this.root ? packs.halConfTemplate(cache, this.root, this.lib.mcus[d.mcuId]) : undefined);
    const filesOf = (d) => {
      const mcu = this.lib.mcus[d.mcuId];
      const gen = generate(d, this.lib, assign(d, this.lib), computeClock(mcu, d.clock), { halConfTemplate: halConfTemplate(d) });
      return new Map(gen.files.map((f) => [f.path, f.content]));
    };
    const notes = [];
    let a = new Map(), b = new Map();
    try {
      a = filesOf(cur);
      b = filesOf(next);
    } catch (e) {
      notes.push({ level: 'warn', text: t('Dosya listesi hesaplanamadı: {0}', e.message) });
    }
    const locks = Object.keys(cur.locks || {}).length;
    if (mcuChanged) notes.push({ level: 'warn', text: t('MCU değişince elle seçilmiş pin kilitleri ({0}) ve saat ayarları sıfırlanır; pinler yeniden atanır.', locks) });
    const famCur = familyOf(this.lib.mcus[cur.mcuId]), famNext = familyOf(this.lib.mcus[next.mcuId]);
    if (famCur.key !== famNext.key) {
      notes.push({ level: 'info', text: t('İşlemci ailesi değişiyor ({0} → {1}): CMSIS ve HAL paketleri yeni aileye göre indirilir, kesme dosyası {2} olur ve içindeki USER CODE taşınır. Eski ailenin paket klasörleri derlenmez ama silinmez.', famCur.series, famNext.series, famNext.itFile) });
    }
    if (!this.lib.mcus[next.mcuId].source.includes('DS10314') && mcuChanged) {
      notes.push({ level: 'warn', text: t('{0} tanımı ST\'nin açık pin veritabanından üretildi ve derleme testlerinden geçti, ancak gerçek kartta doğrulanmadı. Üretim öncesi pin ve saat ayarlarını datasheet ile kontrol edin.', this.lib.mcus[next.mcuId].name) });
    }
    if (s.framework !== cur.framework) {
      notes.push({ level: 'info', text: s.framework === 'hal'
        ? t('Proje STM32CubeMX klasör yapısına geçer (Core/, Drivers/) ve STM32 HAL sürücüleri eklenir. Kendi dosyalarınız ve USER CODE blokları yeni klasörlere taşınır.')
        : t('Proje sade bare-metal klasör yapısına geçer (inc/, src/, startup/, linker/, cmsis/, drivers/). Kendi dosyalarınız ve USER CODE blokları yeni klasörlere taşınır; HAL klasörü (Drivers/STM32F4xx_HAL_Driver) derlenmez ama silinmez.') });
    }
    if (!!s.rtos !== !!cur.rtos) {
      notes.push({ level: 'info', text: s.rtos
        ? t('Her sensör ayrı bir FreeRTOS task\'ında çalışır; FreeRTOS kaynakları projeye eklenir.')
        : t('Sensörler süper döngüde okunur. FreeRTOS klasörü (Middlewares/FreeRTOS) derlemeden çıkar ama silinmez.') });
    }
    notes.push({ level: 'info', text: t('USER CODE blokları arasına yazdığınız kod korunur.') });
    const names = { hal: 'STM32 HAL', device: t('CMSIS cihaz'), core: t('CMSIS çekirdek'), freertos: 'FreeRTOS' };
    const mcuNext = this.lib.mcus[next.mcuId];
    return {
      generated: !!this.root && fs.existsSync(path.join(this.root, STATE_DIR, 'manifest.json')),
      added: [...b.keys()].filter((p) => !a.has(p)).sort(),
      removed: [...a.keys()].filter((p) => !b.has(p)).sort(),
      changed: [...b.keys()].filter((p) => a.has(p) && a.get(p) !== b.get(p)).sort(),
      packs: this.root ? packs.missingInProject(this.root, mcuNext, next.framework, next.rtos, cm.rtosPort(next.build, mcuNext)).map((k) => names[packs.parseKey(k).kind]) : [],
      notes
    };
  }

  // ------------------------------------------------------------------ kod üretimi
  /**
   * Kod üretimi. Profesyonel modda önce önizleme (gen.preview): eklenecek/güncellenecek/kaldırılacak dosyalar ve
   * kullanıcının değiştirdiği üretilmiş dosyalar; kullanıcı onaylayınca (generate.apply) yazılır.
   * @param {{ confirmed?: boolean }} [opts]
   */
  async generateCode(opts = {}) {
    if (!this.design) return;
    if (!this.root) return this.toast('error', t('Kod üretmek için bir proje klasörü açın.'));
    const { result, clock } = this.compute();
    const errors = [...result.messages.filter((x) => x.level === 'error'), ...clock.issues.filter((x) => x.level === 'error')];
    if (errors.length) {
      const go = await vscode.window.showWarningMessage(t('Tasarımda {0} hata var: {1}', errors.length, errors[0].text), { modal: true }, t('Yine de üret'));
      if (go !== t('Yine de üret')) return;
    }
    const mcu = this.lib.mcus[this.design.mcuId];
    const missing = packs.missingInProject(this.root, mcu, this.design.framework, this.design.rtos, cm.rtosPort(this.design.build, mcu));
    if (missing.length) {
      const names = { hal: 'STM32 HAL', device: t('CMSIS cihaz'), core: t('CMSIS çekirdek'), freertos: 'FreeRTOS' };
      const go = await vscode.window.showInformationMessage(
        t('Derleme için şu paketler gerekiyor: {0}. İndirilsin mi? (git, bir kez ~30 MB)', missing.map((k) => names[packs.parseKey(k).kind]).join(', ')), t('İndir'), t('Şimdilik atla'));
      if (go === t('İndir')) await this.installPacks(this.root, mcu, this.design.framework, this.design.rtos, cm.rtosPort(this.design.build, mcu));
    }
    const cache = path.join(this.context.globalStorageUri.fsPath, 'packs');
    const gen = generate(this.design, this.lib, result, clock, { halConfTemplate: packs.halConfTemplate(cache, this.root, mcu) });
    const label = (id) => this.design.instances.find((i) => i.id === id)?.label ?? id;
    const snapshot = {
      framework: this.design.framework, rtos: !!this.design.rtos, clock: { sysclk: clock.freq.sysclk },
      instances: this.design.instances.map((i) => ({ id: i.id, label: i.label, componentId: i.componentId, name: this.lib.components[i.componentId]?.name })),
      connections: result.connections.map((c) => ({ instId: c.instId, compPin: c.compPin, mcuPin: c.mcuPin, signal: c.signal, label: label(c.instId) }))
    };
    const pro = this.design.mode === 'pro';
    const info = { fingerprint: designFingerprint(this.design, GENERATOR_VERSION), snapshot, protect: pro };
    if (pro && !opts.confirmed) {
      const preview = writeProject(this.root, gen, { ...info, dryRun: true });
      if (preview.upToDate) {
        vscode.window.showInformationMessage(t('Kod güncel: tasarımda değişiklik yok, hiçbir dosyaya dokunulmadı.'));
        return;
      }
      this.preview = preview;
      const { contents, ...rest } = preview;
      this.post({ type: 'gen.preview', report: rest, owned: this.design.framework === 'register' });
      return;
    }
    this.preview = null;
    // Klasör yapısı değiştiyse (HAL ↔ bare-metal) kullanıcı dosyalarını yeni yerlerine taşı
    const moved = relocateLayout(this.root, this.design.framework, gen.files);
    relocateFamilyFiles(this.root, gen.files); // işlemci ailesi değiştiyse <aile>_it.c ve USER CODE blokları
    const report = writeProject(this.root, gen, info);
    report.updated.push(...upgradeLegacyVscode(this.root, this.design.project.name));
    this.prepareCodeIntel();
    this.checkUserCmake();
    if (moved.length) {
      const old = moved[0].from.split('/')[0];
      removeEmptyDirs(this.root, ['Core/Inc', 'Core/Src', 'Drivers/Components', 'inc', 'src', 'drivers']);
      vscode.window.showInformationMessage(t('Klasör yapısı değişti: {0} kullanıcı dosyası yeni yerine taşındı (ör. {1} → {2}). Eski "{3}" klasöründe kalanlar derlenmez.', moved.length, moved[0].from, moved[0].to, old));
    }
    this.post({ type: 'generated', report });
    if (report.upToDate) {
      vscode.window.showInformationMessage(t('Kod güncel: tasarımda değişiklik yok, hiçbir dosyaya dokunulmadı.'));
      return;
    }
    const parts = [
      report.added.length && t('{0} yeni', report.added.length),
      report.updated.length && t('{0} güncellendi', report.updated.length),
      report.removed.length && t('{0} kaldırıldı', report.removed.length),
      report.preserved.length && t('{0} taşındı', report.preserved.length),
      report.conflicts.length && t('{0} korundu (.new)', report.conflicts.length)
    ].filter(Boolean).join(', ') || t('dosya içerikleri aynı');
    const warn = report.orphans.length ? ' ' + t('Kaldırılan sensörlere ait kodunuz korunup dosya sonuna taşındı.') : '';
    const appFile = `${layout(this.design.framework).src}/${pro && this.design.framework === 'register' ? 'main.c' : 'app.c'}`;
    const choice = await vscode.window.showInformationMessage(t('Kod üretildi: {0}.', parts) + warn, t('Değişiklikler'), path.basename(appFile));
    if (choice) {
      const target = choice === t('Değişiklikler') ? `${STATE_DIR}/LAST_CHANGES.md` : appFile;
      await vscode.window.showTextDocument(vscode.Uri.file(path.join(this.root, target)));
    }
  }

  /** ES-804: üst çubukta gizlenen sekmeler */
  postHiddenTabs() {
    this.post({ type: 'tabs.hidden', hidden: vscode.workspace.getConfiguration?.('embeddedStudio').get('hiddenTabs', {}) || {} });
  }

  /**
   * ES-108: clangd / C/C++ eklentisine derleme veritabanını gösterir; henüz derlenmediyse arka planda yalnızca CMake
   * yapılandırması çalıştırır ki ilk derlemeden önce de editörde yanlış "tanımsız" hataları çıkmasın.
   */
  prepareCodeIntel() {
    const type = cm.normalizeBuild(this.design.build).type;
    syncCodeIntel(this.root, type, this.design.framework === 'hal' ? `${familyOf(this.lib.mcus[this.design.mcuId]).prefix}_hal_def.h` : undefined);
    const dest = path.join(this.root, cm.buildDir(this.design.build), 'compile_commands.json');
    if (fs.existsSync(dest)) return;
    // Geçici klasörde: hemen ardından başlayan derleme build/<tip>/ altındaki CMake önbelleğiyle çakışmasın.
    // Yollar mutlak olduğundan veritabanı kopyalanınca da geçerlidir; ilk derleme üzerine yazar.
    const root = this.root;
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'es-cc-'));
    const args = ['-S', root, '-B', tmp, '-G', 'Ninja', `-DCMAKE_TOOLCHAIN_FILE=${path.join(root, 'cmake', 'arm-none-eabi.cmake')}`, `-DCMAKE_BUILD_TYPE=${type}`];
    require('child_process').execFile('cmake', args, { cwd: root, windowsHide: true, timeout: 120000 }, () => {
      try {
        const db = path.join(tmp, 'compile_commands.json');
        if (fs.existsSync(db) && !fs.existsSync(dest)) {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(db, dest);
        }
      } catch { /* derleme sırasında klasör değişmiş olabilir */ }
      fs.rmSync(tmp, { recursive: true, force: true });
    });
  }

  /** "CMake'i ben yönetiyorum": kullanıcının CMakeLists.txt'si üretilen ayarları içermiyorsa nasıl ekleneceğini söyle. */
  checkUserCmake() {
    if (this.design.build.cmake !== 'user' || !this.root) return;
    const file = path.join(this.root, 'CMakeLists.txt');
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8').includes('embedded-studio.cmake')) return;
    vscode.window.showWarningMessage(t('CMakeLists.txt, Embedded Studio\'nun ürettiği derleme ayarlarını içermiyor. project() satırından sonra include(cmake/embedded-studio.cmake) ve add_executable sonrası embedded_studio_target(<hedef>) ekleyin.'), t('CMakeLists.txt\'yi aç'))
      .then((c) => c && vscode.window.showTextDocument(vscode.Uri.file(file)));
  }

  /** Önizlemedeki bir dosya için VS Code fark görünümü: soldaki diskteki hali, sağdaki yazılacak hali. */
  async openPreviewDiff(rel) {
    if (!this.preview || !(rel in this.preview.contents) || !this.root) return;
    const right = vscode.Uri.parse(`${PREVIEW_SCHEME}:/${rel}`);
    const target = rel.endsWith('.new') ? rel.slice(0, -4) : rel;
    const abs = path.join(this.root, target);
    if (fs.existsSync(abs)) await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(abs), right, t('{0} (mevcut ↔ üretilecek)', target));
    else await vscode.window.showTextDocument(right, { preview: true });
  }

  // ------------------------------------------------------------------ kütüphane
  async importComponents() {
    if (!this.root) return this.toast('error', t('Komponent yüklemek için önce bir proje açın.'));
    const pick = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { [t('Komponent tanımı')]: ['json'] }, openLabel: t('Kütüphaneye ekle') });
    if (!pick) return;
    const dir = path.join(this.root, USER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const added = [], failed = [];
    for (const uri of pick) {
      let c;
      try {
        c = JSON.parse(fs.readFileSync(uri.fsPath, 'utf8'));
      } catch (e) {
        failed.push(t('{0}: JSON okunamadı ({1})', path.basename(uri.fsPath), e.message));
        continue;
      }
      const errs = validateComponent(c);
      if (errs.length) {
        failed.push(`${path.basename(uri.fsPath)}: ${errs.join(' ')}`);
        continue;
      }
      // Görsel yerel bir dosyaysa onu da kütüphaneye kopyala.
      if (c.image && !/^https?:|^data:/.test(c.image)) {
        const src = path.resolve(path.dirname(uri.fsPath), c.image);
        if (fs.existsSync(src)) {
          const name = `${c.id}${path.extname(src)}`;
          fs.copyFileSync(src, path.join(dir, name));
          c.image = name;
        } else {
          delete c.image;
        }
      }
      fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
      added.push(c.name);
    }
    this.reloadLibrary();
    if (added.length) this.toast('info', t('Kütüphaneye eklendi: {0}', added.join(', ')));
    if (failed.length) vscode.window.showErrorMessage(t('Yüklenemedi:') + '\n' + failed.join('\n'), { modal: true });
  }

  /** Oluşturucudan gelen komponenti doğrular ve projenin kütüphanesine yazar. */
  async saveComponent(m) {
    if (!this.root) return this.post({ type: 'comp.result', ok: false, errors: [t('Komponent kaydetmek için önce bir proje açın.')] });
    const c = cleanComponent(m.component);
    const errors = validateComponent(c);
    if (errors.length) return this.post({ type: 'comp.result', ok: false, errors });
    const existing = this.lib.components[c.id];
    const renaming = m.originalId && m.originalId !== c.id;
    if (existing && c.id !== m.originalId) {
      const what = existing.source === 'user' ? t('Projede "{0}" kimlikli bir komponent zaten var ({1}).', c.id, existing.name) : t('"{0}" hazır bir komponentin kimliği ({1}); kaydederseniz bu projede onun yerine sizinki kullanılır.', c.id, existing.name);
      const go = await vscode.window.showWarningMessage(`${what} ${t('Devam edilsin mi?')}`, { modal: true }, t('Üzerine yaz'));
      if (go !== t('Üzerine yaz')) return this.post({ type: 'comp.result', ok: false, cancelled: true, errors: [] });
    }
    const dir = path.join(this.root, USER_DIR);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2) + '\n');
    // Kimlik değiştiyse eski kullanıcı dosyasını kaldır (tasarımda kullanılmıyorsa)
    if (renaming && this.lib.components[m.originalId]?.source === 'user' && !this.design?.instances.some((i) => i.componentId === m.originalId)) {
      fs.rmSync(path.join(dir, `${m.originalId}.json`), { force: true });
    }
    this.reloadLibrary();
    this.post({ type: 'comp.result', ok: true, id: c.id, addToDesign: !!m.addToDesign });
    this.toast('info', m.originalId ? t('"{0}" kütüphaneye kaydedildi.', c.name) : t('"{0}" kütüphaneye eklendi.', c.name));
  }

  async removeComponent(id) {
    const c = this.lib.components[id];
    if (!c || c.source !== 'user') return;
    const used = this.design?.instances.some((i) => i.componentId === id);
    const go = await vscode.window.showWarningMessage(t('"{0}" kütüphaneden kaldırılsın mı?', c.name) + (used ? ' ' + t('Tasarımda kullanılıyor; önce tasarımdan çıkarın.') : ''), { modal: true }, t('Kaldır'));
    if (go !== t('Kaldır') || used) return;
    fs.rmSync(c.file, { force: true });
    this.reloadLibrary();
  }

  reloadLibrary() {
    this.lib = loadLibrary(this.context.extensionPath, this.root);
    this.post({ type: 'init', lib: this.libForWebview() });
    if (this.design) this.pushState();
  }

  async openDatasheet(componentId) {
    const item = componentId === '@mcu' ? this.lib.mcus[this.design.mcuId] : this.lib.components[componentId];
    if (!item || !item.datasheet) return this.toast('warn', t('Bu komponent için datasheet bağlantısı tanımlı değil.'));
    const dir = this.root ? path.join(this.root, 'docs', 'datasheets') : path.join(this.context.globalStorageUri.fsPath, 'datasheets');
    const file = path.join(dir, `${item.id}.pdf`);
    if (!fs.existsSync(file)) {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('{0} datasheet indiriliyor...', item.name) }, () => download(item.datasheet, file));
      } catch (e) {
        // Bazı üreticiler (ör. ST) otomatik indirmeyi engeller: tarayıcıda aç.
        this.toast('info', t('Doğrudan indirilemedi ({0}); tarayıcıda açılıyor.', e.message));
        return vscode.env.openExternal(vscode.Uri.parse(item.datasheet));
      }
    }
    await vscode.env.openExternal(vscode.Uri.file(file));
    this.toast('info', `Datasheet: ${path.relative(this.root || dir, file)}`);
  }

  // ------------------------------------------------------------------ monitör
  startMonitor() {
    this.monitor?.stop();
    this.monitor = new Simulator(this.design, this.lib, (line) => {
      const item = parseLine(line);
      if (item) this.pending.push(item);
    });
    this.monitor.start();
    this.post({ type: 'monitor', running: true, source: t('Simülasyon') });
  }

  // ------------------------------------------------------------------ debug
  /** MCU değişince register tanımlarını sıfırla (F411: yerleşik, diğerleri: SVD bekleniyor) */
  resetRegisterDefs() {
    this.svdName = '';
    this.peripheralDefs = [];
  }

  /** Yerleşik tanım sadece STM32F411 için; diğer işlemcilerde register görünümü SVD dosyasıyla çalışır. */
  builtinDefs() {
    return this.design && this.design.mcuId === 'stm32f411ceu6' ? builtinStm32f4() : [];
  }

  async loadSvd(download) {
    const mcu = this.lib.mcus[this.design.mcuId];
    if (!this.svdName) this.peripheralDefs = this.builtinDefs();
    const file = this.root && path.join(this.root, STATE_DIR, `${mcu.name}.svd`);
    if (download && file && !fs.existsSync(file) && mcu.svdUrl) {
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('SVD indiriliyor...') }, () => download_(mcu.svdUrl, file));
      } catch (e) {
        this.toast('warn', t('{0} SVD dosyası indirilemedi: {1}', mcu.name, e.message));
      }
    }
    if (file && fs.existsSync(file)) {
      const svd = parseSvd(fs.readFileSync(file, 'utf8'));
      this.peripheralDefs = svd.peripherals;
      this.svdName = t('{0} (SVD, {1} çevre birimi)', svd.device, svd.peripherals.length);
    }
    this.postRegs();
    function download_(u, f) { return download(u, f, false); }
  }

  postRegs() {
    const used = Object.keys(this.compute().result.peripherals);
    const ports = new Set(this.compute().result.connections.map((c) => 'GPIO' + c.mcuPin[1]));
    this.post({ type: 'debug.regs', peripherals: summary(this.peripheralDefs), cpu: this.cpuInfo(), used: [...used, ...ports, 'RCC'], source: this.svdName || (this.peripheralDefs.length ? t('Yerleşik STM32F411 tanımları') : t('{0} için register tanımı yok: SVD indirilemedi.', this.lib.mcus[this.design.mcuId].name)) });
    this.postFavorites();
  }

  /** @param {'sim'|string} mode @param {{ transport?: string }} [opts] transport: swd (varsayılan) | jtag */
  async connectDebug(mode, opts = {}) {
    await this.bootDisconnect(); // prob ve bootloader aynı anda programlayıcı hedefi olmasın
    await this.dropTrace();
    await this.target?.disconnect().catch(() => {});
    this.target = null;
    const mcu = this.lib.mcus[this.design.mcuId];
    if (mode === 'sim') {
      const { result, clock } = this.compute();
      if (!this.svdName && !this.peripheralDefs.length) await this.loadSvd(this.design.mcuId !== 'stm32f411ceu6');
      this.target = new SimTarget(simModel(this.design, this.lib, result, clock, this.peripheralDefs));
    } else {
      // VS Code debug oturumu (Cortex-Debug) probu tutarken ikinci bir OpenOCD açılamaz
      if (vscode.debug.activeDebugSession?.type === 'cortex-debug') {
        this.post({ type: 'debug.status', connected: false, error: t('Prob VS Code debug oturumunda kullanılıyor. Önce oturumu durdurun ya da simülasyonla bağlanın.') });
        return;
      }
      this.post({ type: 'debug.status', connected: false, connecting: true });
      const out = vscode.window.createOutputChannel ? this.outputChannel() : null;
      // Algılanan prob (J-Link, CMSIS-DAP); birden fazla aynı tür probda seri numarasıyla
      const probes = actions?.state.probes || [];
      const probe = probes.find((x) => x.interfaceCfg);
      const target = new OpenOcdTarget({
        targetCfg: mcu.device.openocdTarget, interfaceCfg: probe?.interfaceCfg, transport: opts.transport,
        serial: probe && probes.filter((x) => x.kind === probe.kind).length > 1 ? probe.serial : undefined,
        speedKHz: vscode.workspace.getConfiguration?.('embeddedStudio').get('flash.speedKHz', 0) || undefined,
        log: (s) => out && out.append(s),
        onExit: (why) => {
          if (this.target !== target) return;
          this.dropTrace();
          this.target = null;
          this.post({ type: 'debug.status', connected: false, error: why });
        }
      });
      this.target = target;
    }
    try {
      await this.target.connect();
    } catch (e) {
      this.target = null;
      this.post({ type: 'debug.status', connected: false, error: e.message });
      return;
    }
    // F411 dışındaki işlemcilerde register görünümü için SVD gerekir: yoksa indir
    if (!this.svdName) await this.loadSvd(this.design.mcuId !== 'stm32f411ceu6');
    else this.postRegs();
    this.trace = new trace.TraceSession(this.target, (x) => this.post(x));
    this.post({ type: 'debug.status', connected: true, mode, state: await this.target.state() });
    this.postTraceInfo();
  }

  // ------------------------------------------------------------------ ES-301 / ES-302: programlayıcı
  /** İşlem günlüğü: sekmede ve "Embedded Studio: Programlayıcı" çıktı panelinde */
  progLog(level, text) {
    const entry = { at: Date.now(), level, text };
    this.progEntries = [...(this.progEntries || []), entry].slice(-500);
    if (vscode.window.createOutputChannel) {
      if (!this._progOut) this._progOut = vscode.window.createOutputChannel('Embedded Studio: Programlayıcı');
      this._progOut.appendLine(`[${new Date(entry.at).toLocaleTimeString()}] ${level === 'error' ? 'HATA ' : ''}${text}`);
    }
    this.post({ type: 'prog.log', entry });
  }

  /** Programlayıcının hedefi: sistem bootloader'ı bağlıysa o, değilse Debug ile ortak prob bağlantısı */
  progT() { return this.bootTarget || this.target; }

  async progConnect(m) {
    if (m.transport === 'uart') return this.bootConnect(m);
    if (m.transport === 'esboot') return this.esbootConnect(m);
    await this.bootDisconnect();
    const mode = m.mode === 'sim' ? 'sim' : 'openocd';
    this.progLog('info', mode === 'sim' ? t('Simülasyona bağlanılıyor…') : t('Proba bağlanılıyor ({0})…', (m.transport || 'swd').toUpperCase()));
    await this.connectDebug(mode, { transport: m.transport });
    if (!this.target) return this.progLog('error', t('Bağlanılamadı.'));
    if (this.target.mode === 'sim') {
      const spec = prog.obSpec(this.lib.mcus[this.design.mcuId]);
      if (spec) for (const [name, addr] of Object.entries(spec.regs)) await this.target.writeMemory(addr, 32, spec.sim[name] >>> 0);
    }
    this.progLog('info', t('Bağlandı: {0}', this.lib.mcus[this.design.mcuId].name));
    await this.progInfo();
  }

  /**
   * ES-302: UART sistem bootloader'ı (AN3155). Port 'SIM' ise bellekte çalışan bootloader benzetimi.
   * @param {{ port: string, baud?: number, entry?: 'manual'|'dtr-rts' }} m
   */
  async bootConnect(m) {
    await this.bootDisconnect();
    if (this.target) {
      await this.dropTrace();
      await this.target.disconnect().catch(() => {});
      this.target = null;
      this.post({ type: 'debug.status', connected: false });
    }
    const mcu = this.lib.mcus[this.design.mcuId];
    const baud = Number(m.baud) || 115200;
    this.post({ type: 'prog.boot', connecting: true });
    this.progLog('info', t('Bootloader\'a bağlanılıyor: {0}, {1} baud, 8E1{2}…', m.port, baud, m.entry === 'dtr-rts' ? ', DTR/RTS' : ''));
    let target, session = null;
    try {
      if (m.port === serial.SIM_PORT) {
        const want = Object.entries(DEV_IDS).find(([, d]) => (d.defines || []).includes(mcu.device.define));
        // Sanal cihaz bağlantılar arasında korunur (işlemci değişince yenisi)
        const keep = this._simBoot && this._simBoot.mcu === mcu.id ? this._simBoot.dev : undefined;
        const { boot, dev } = sysboot.simBoot(mcu, want ? Number(want[0]) : 0x431, { dev: keep });
        this._simBoot = { mcu: mcu.id, dev };
        target = new sysboot.BootTarget(boot, mcu);
      } else {
        session = new serial.SerialSession({ path: m.port, baud, dataBits: 8, parity: 'even', stopBits: 1, flow: 'none', dtr: false, rts: false });
        await session.open();
        const boot = new sysboot.UartBootloader({ write: (b) => session.write(b) });
        session.on('data', (b) => boot.feed(b));
        session.on('error', (e) => this.progLog('error', e.message));
        const signals = (dtr, rts) => session.signals(dtr, rts);
        if (m.entry === 'dtr-rts') await sysboot.resetSequence(signals, 'enter');
        target = new sysboot.BootTarget(boot, mcu, {
          close: () => session.close(),
          exit: m.entry === 'dtr-rts' ? () => sysboot.resetSequence(signals, 'exit') : undefined
        });
      }
      const info = await target.connect();
      this.bootTarget = target;
      this.bootPort = m.port;
      const dev = DEV_IDS[info.pid];
      const match = !!(dev && (dev.defines || []).includes(mcu.device.define));
      const status = { connected: true, port: m.port, baud, version: `${info.version >> 4}.${info.version & 0xf}`, pid: info.pid, device: dev ? dev.name : t('bilinmiyor'), match, commands: info.commands };
      this.post({ type: 'prog.boot', ...status });
      this.progLog('ok', t('Bootloader v{0}, PID {1} ({2}).', status.version, '0x' + info.pid.toString(16).toUpperCase(), status.device));
      if (!match) this.progLog('warn', t('Bağlanan işlemci projedekiyle ({0}) aynı görünmüyor; sektör haritası projedeki işlemciye göre.', mcu.name));
      await this.progInfo();
    } catch (e) {
      if (session) await session.close().catch(() => {});
      this.post({ type: 'prog.boot', connected: false, error: e.message });
      this.progLog('error', e.message);
    }
  }

  async bootDisconnect(note) {
    const es = this.esboot;
    if (es) {
      this.esboot = null;
      await Promise.resolve(es.close()).catch(() => {});
      this.post({ type: 'prog.boot', connected: false, note });
      this.progLog('info', note || t('Bootloader bağlantısı kapatıldı.'));
      return;
    }
    const tg = this.bootTarget;
    if (!tg) return;
    this.bootTarget = null;
    await tg.disconnect().catch(() => {});
    this.post({ type: 'prog.boot', connected: false, note });
    this.progLog('info', note || t('Bootloader bağlantısı kapatıldı.'));
  }

  /**
   * ES-303: Embedded Studio bootloader'ına UART ile bağlanır. Bootloader yalnızca açılış penceresinde, uygulama
   * güncelleme isteyince ya da geçerli imaj yokken dinler: bağlanırken 15 sn boyunca INFO ile yoklanır (kartı resetleyin).
   * @param {{ port: string, baud?: number, entry?: string }} m
   */
  async esbootConnect(m) {
    await this.bootDisconnect();
    if (this.target) {
      await this.dropTrace();
      await this.target.disconnect().catch(() => {});
      this.target = null;
      this.post({ type: 'debug.status', connected: false });
    }
    const mcu = this.lib.mcus[this.design.mcuId];
    const boot = bl.normalizeBoot(this.design.boot, mcu);
    const part = bl.partition(mcu, boot);
    const baud = Number(m.baud) || boot.baud;
    this.post({ type: 'prog.boot', connecting: true });
    this.progLog('info', t('Embedded Studio bootloader\'ı bekleniyor: {0}, {1} baud. Kartı resetleyin (açılış penceresi {2} ms).', m.port, baud, boot.waitMs));
    let client, close = () => {}, session = null;
    try {
      if (m.port === serial.SIM_PORT) {
        // Sanal cihaz bağlantılar arasında korunur
        const pub = boot.signing && boot.pubKey ? Buffer.from(boot.pubKey, 'hex') : null;
        const key = `${mcu.id}:${part.slotBase}:${part.stageBase}:${boot.pubKey}:${boot.rollback}:${boot.minVersion}`;
        if (!this._simEs || this._simEs.key !== key) this._simEs = { key, dev: null };
        client = new esboot.EsBootClient({ write: (b) => setImmediate(() => this._simEs.dev.receive(b)) }, { timeoutMs: 250, retries: 0 });
        if (!this._simEs.dev) {
          this._simEs.dev = new esboot.SimEsBoot({
            slotBase: part.slotBase, slotSize: part.slotSize, stageBase: part.stageBase, stageSize: part.stageSize, progUnit: part.progUnit, deviceId: 0x431,
            pubKey: pub, rollback: boot.rollback, minVersion: bl.versionWord(boot.minVersion), out: (b) => setImmediate(() => client.feed(b))
          });
        }
        else this._simEs.dev.o.out = (b) => setImmediate(() => client.feed(b));
      } else {
        session = new serial.SerialSession({ path: m.port, baud, dataBits: 8, parity: 'none', stopBits: 1, flow: 'none', dtr: false, rts: false });
        await session.open();
        client = new esboot.EsBootClient({ write: (b) => session.write(b) }, { timeoutMs: 250, retries: 0 });
        session.on('data', (b) => client.feed(b));
        close = () => session.close();
        if (m.entry === 'dtr') {
          // DTR → NRST: reset darbesi, bootloader açılış penceresinde yakalanır
          session.signals(true, false);
          await new Promise((r) => setTimeout(r, 50));
          session.signals(false, false);
        }
      }
      let info = null;
      const until = Date.now() + 15000;
      while (!info && Date.now() < until) {
        try {
          info = await client.info();
        } catch (e) {
          if (!e.timeout && !e.retry) throw e;
        }
      }
      if (!info) throw new Error(t('Bootloader yanıt vermedi (15 sn). Kartı resetleyin ya da uygulamadan es_boot_request_update() çağırın; UART pinleri ve baud ayarını kontrol edin.'));
      client.timeout = 1000;
      client.retries = 3;
      this.esboot = { client, close, info, part, port: m.port };
      const dev = DEV_IDS[info.deviceId];
      const match = info.slotBase === part.slotBase;
      const status = { ...this.esbootStatus(this.esboot), baud, match: match && !!(dev && (dev.defines || []).includes(mcu.device.define)) };
      this.post({ type: 'prog.boot', ...status });
      this.progLog('ok', t('Embedded Studio bootloader v{0}; yuva 0x{1} ({2} KB); uygulama: {3}{4}.', info.version, info.slotBase.toString(16).toUpperCase(), info.slotSize / 1024, info.appText,
        status.header ? ` (v${status.header.version}, ${status.header.buildId})` : ''));
      if (info.protocol >= 2) {
        this.progLog('info', [info.ab ? t('A/B (hazırlık yuvası 0x{0})', info.stageBase.toString(16).toUpperCase()) : t('tek yuva'),
          info.signed ? t('imza gerekli, anahtar {0}', info.keyId) : t('imzasız'), info.rollback ? t('en düşük sürüm v{0}', info.floorText) : t('geri dönüş koruması kapalı')].join(' · '));
      }
      if (!match) this.progLog('warn', t('Cihazdaki yuva (0x{0}) projedekinden (0x{1}) farklı: bootloader başka ayarlarla derlenmiş.', info.slotBase.toString(16), part.slotBase.toString(16)));
      if (info.signed && boot.signing && info.keyId !== bl.keyId(boot.pubKey)) this.progLog('warn', t('Cihazın imza anahtarı ({0}) projedekinden ({1}) farklı.', info.keyId, bl.keyId(boot.pubKey)));
    } catch (e) {
      if (session) await session.close().catch(() => {});
      this.post({ type: 'prog.boot', connected: false, error: e.message });
      this.progLog('error', e.message);
    }
  }

  /** ES-303: INFO'yu yeniden sorgulayıp arayüze bildirir (Yenile, güncellemeden sonra) */
  async esbootRefresh() {
    const es = this.esboot;
    try {
      es.info = await es.client.info();
    } catch (e) {
      return this.progLog('error', e.message);
    }
    this.post({ type: 'prog.boot', ...this.esbootStatus(es), match: true });
  }

  /** Programlayıcı arayüzü için bootloader durumu (INFO) */
  esbootStatus(es) {
    const i = es.info;
    const hdr = (x) => (x && x.present ? { version: x.version, buildId: x.buildId, size: x.imageSize } : null);
    return {
      connected: true, kind: 'esboot', port: es.port, version: i.version, pid: i.deviceId, device: (DEV_IDS[i.deviceId] || {}).name || t('bilinmiyor'),
      commands: ['INFO', 'START', 'DATA', 'END', 'BOOT'], app: i.app, appText: i.appText, slotBase: i.slotBase, slotSize: i.slotSize, header: hdr(i.header),
      protocol: i.protocol, ab: i.ab, signed: i.signed, rollback: i.rollback, keyId: i.keyId, floorText: i.floorText, stageBase: i.stageBase, stageSize: i.stageSize,
      stage: i.stage ? { status: i.stage.status, statusText: i.stage.statusText, done: i.stage.done, header: i.stage.header && i.stage.header.present ? hdr(i.stage.header) : null } : null
    };
  }

  // ---- ES-304: imza anahtarı. Özel anahtar yalnızca bu makinede (eklentinin genel depolama klasörü), açık anahtar projede.
  keyFile(id) { return bootKeyFile(id); }
  privateKey(id) { return bootPrivateKey(id); }
  saveKey(k) {
    fs.mkdirSync(path.dirname(bootKeyFile(k.keyId)), { recursive: true });
    fs.writeFileSync(bootKeyFile(k.keyId), k.pem, { mode: 0o600 });
  }
  postBootKey() {
    const b = (this.design && this.design.boot) || {};
    const id = bl.keyId(b.pubKey);
    this.post({ type: 'boot.key', pubKey: b.pubKey || '', keyId: id, local: !!this.privateKey(id), file: id ? this.keyFile(id) : '' });
  }
  setBootKey(pub) {
    this.design.boot = { ...(this.design.boot || {}), signing: true, pubKey: Buffer.from(pub).toString('hex') };
    this.pushState();
    this.scheduleSave();
    this.postBootKey();
  }
  async bootKeygen() {
    const cur = this.design.boot && this.design.boot.pubKey;
    if (cur) {
      const go = await vscode.window.showWarningMessage(t('Yeni anahtar üretilsin mi? Eski anahtarla ({0}) derlenmiş bootloader\'a sahip kartlar yeni anahtarla imzalanan güncellemeleri kabul etmez; önce bootloader\'ı yeni anahtarla SWD ile yüklemeniz gerekir.', bl.keyId(cur)), { modal: true }, t('Yeni anahtar üret'));
      if (!go) return;
    }
    const k = esboot.generateKey();
    this.saveKey(k);
    this.setBootKey(k.pub);
    this.toast('info', t('Ed25519 anahtarı üretildi ({0}). Özel anahtarı yedekleyin (Dışa aktar): kaybolursa bu bootloader\'lı kartlara güncelleme gönderilemez.', k.keyId));
  }
  async bootKeyImport() {
    const pick = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { [t('Ed25519 özel anahtarı (PEM)')]: ['pem', 'key'] }, openLabel: t('İçe aktar') });
    if (!pick) return;
    try {
      const pem = fs.readFileSync(pick[0].fsPath, 'utf8');
      const k = esboot.loadPrivateKey(pem);
      this.saveKey({ keyId: k.keyId, pem: String(k.key.export({ type: 'pkcs8', format: 'pem' })) });
      this.setBootKey(k.pub);
      this.toast('info', t('Anahtar içe aktarıldı ({0}).', k.keyId));
    } catch (e) {
      this.toast('error', e.message);
    }
  }
  async bootKeyExport() {
    const id = bl.keyId(this.design.boot && this.design.boot.pubKey);
    const pem = this.privateKey(id);
    if (!pem) return this.toast('error', t('Bu makinede {0} anahtarının özel kısmı yok.', id || '—'));
    const dest = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(require('os').homedir(), `es-boot-${id}.pem`)), filters: { PEM: ['pem'] }, saveLabel: t('Dışa aktar') });
    if (!dest) return;
    fs.writeFileSync(dest.fsPath, pem, { mode: 0o600 });
    this.toast('info', t('Özel anahtar kaydedildi: {0}. Güvenli bir yerde saklayın; projeye (git) eklemeyin.', dest.fsPath));
  }

  /** ES-303: başlıklı uygulama imajını (yuva başından) bootloader'a gönderir */
  async esbootUpdate(m) {
    const es = this.esboot;
    const img = await this.progPickImage(es.info.slotBase, t('Yaz'));
    if (!img) return;
    const lo = Math.min(...img.segments.map((g) => g.addr));
    const hi = Math.max(...img.segments.map((g) => g.addr + g.bytes.length));
    if (lo !== es.info.slotBase) return this.progLog('error', t('{0} yuva başından (0x{1}) başlamıyor (0x{2}). Bootloader açıkken derlenen uygulamanın .bin / .hex / .elf dosyasını seçin; _full.hex ve _boot dosyaları değil.', path.basename(img.file), es.info.slotBase.toString(16).toUpperCase(), lo.toString(16).toUpperCase()));
    let bytes = Buffer.alloc(hi - lo, 0xff);
    for (const g of img.segments) Buffer.from(g.bytes).copy(bytes, g.addr - lo);
    let chk = esboot.checkImage(bytes);
    if (!chk.ok) return this.progLog('error', chk.error);
    // ES-304: cihaz imza istiyorsa ve imaj bu anahtarla imzalı değilse bu makinedeki özel anahtarla imzalanır
    if (es.info.signed && !(chk.sig.present && chk.sig.keyId === es.info.keyId)) {
      const pem = this.privateKey(es.info.keyId);
      if (!pem) return this.progLog('error', t('Cihaz {0} anahtarıyla imzalı imaj bekliyor; bu makinede o anahtarın özel kısmı yok (Proje Ayarları > Bootloader > Anahtarı içe aktar).', es.info.keyId));
      try {
        bytes = esboot.signImage(bytes, pem).bytes;
      } catch (e) {
        return this.progLog('error', e.message);
      }
      chk = esboot.checkImage(bytes);
      this.progLog('info', t('İmzalandı: Ed25519, anahtar {0}.', es.info.keyId));
    }
    const started = Date.now();
    this.progLog('info', t('Güncelleniyor: {0} (v{1}, {2}, {3})', path.basename(img.file), chk.header.version, chk.header.buildId, prog.sizeText(chk.total)));
    try {
      await es.client.update(bytes, {
        boot: !!m.run,
        progress: (stage, done, total) => this.post({ type: 'prog.progress', op: 'write', pct: stage === 'erase' ? 1 : Math.round((done * 100) / total) })
      });
      this.progLog('ok', t('Güncellendi ve doğrulandı: v{0}, {1} sn.', chk.header.version, ((Date.now() - started) / 1000).toFixed(1)) + (es.info.ab ? ' ' + t('Hazırlık yuvasından ana yuvaya kopyalandı.') : ''));
      if (m.run) await this.bootDisconnect(t('Bootloader yeniden başlatıldı: yeni uygulama doğrulanıp çalıştırılıyor.'));
      else await this.esbootRefresh();
    } catch (e) {
      this.progLog('error', t('Güncelleme başarısız: {0}', e.message) + ' ' + (es.info.ab ? t('A/B: ana yuvadaki uygulama değişmedi.') : t('Cihazdaki imaj commit almadığı için çalıştırılmaz; bootloader yeni güncelleme bekler.')));
    }
    this.post({ type: 'prog.progress', op: 'write', pct: null });
  }

  /** Sektör listesi (OpenOCD'den; okunamazsa işlemci verisinden) ve option byte'lar */
  async progInfo() {
    if (this.esboot) return this.esbootRefresh();
    const tg = this.progT();
    if (!tg) return this.post({ type: 'prog.info', error: t('Önce bağlanın.') });
    const mcu = this.lib.mcus[this.design.mcuId];
    let sectors, source = tg.mode === 'openocd' ? 'openocd' : tg.mode === 'sim' ? 'sim' : 'static';
    try {
      sectors = prog.layoutFromBanks(await tg.flashBanks());
    } catch (e) {
      sectors = prog.flashLayout(mcu);
      source = 'static';
      this.progLog('warn', t('Sektörler cihazdan okunamadı, işlemci verisi kullanılıyor: {0}', e.message));
    }
    let ob = null;
    const spec = prog.obSpec(mcu);
    if (tg.mode === 'bootloader') ob = { error: t('Bootloader bağlantısında option byte\'lar okunmuyor (flash arayüzü register\'ları bootloader READ komutuyla erişilemez); SWD ile bağlanın.') };
    else if (spec) {
      try {
        const values = {};
        for (const [name, addr] of Object.entries(spec.regs)) values[name] = (await tg.readMemory(addr, 1))[0];
        ob = prog.decodeOptionBytes(mcu, values, sectors);
        for (const i of ob.wrp) if (sectors[i]) sectors[i].protected = true;
      } catch (e) {
        ob = { error: e.message };
      }
    }
    this.progSectors = sectors;
    this.post({ type: 'prog.info', sectors, ob, source, flashKB: mcu.device.flashKB, ramKB: mcu.device.ramKB, mcu: mcu.name });
  }

  /** Bootloader / DFU bilgisi (AN2606) ve araçlar; Programlayıcı'da UART ya da DFU seçilince */
  async progBootInfo() {
    const mcu = this.lib.mcus[this.design.mcuId];
    const tools = this._progTools || (this._progTools = await detectTools().catch(() => []));
    const pick = (id) => { const x = tools.find((y) => y.id === id); return x ? { found: x.found, path: x.path, version: x.version, install: x.install, hint: x.hint } : { found: false }; };
    let ports = [];
    try { ports = await serial.listPorts(); } catch { /* port listesi alınamadı */ }
    this.post({ type: 'prog.bootInfo', mcu: mcu.name, board: mcu.board, info: sysboot.bootInfo(mcu), ports, tools: { dfuutil: pick('dfuutil'), cubeprog: pick('cubeprog') } });
  }

  /** Cihazdan parça parça okur (ilerleme bildirimiyle) */
  async progReadBytes(addr, length, op) {
    const chunk = this.bootTarget ? 4096 : 16 * 1024;
    const out = new Uint8Array(length);
    for (let off = 0; off < length; off += chunk) {
      const n = Math.min(chunk, length - off);
      out.set(await readRegion(this.progT(), addr + off, n), off);
      this.post({ type: 'prog.progress', op, pct: Math.round(((off + n) * 100) / length) });
    }
    return out;
  }

  async progRead(m) {
    if (!this.progT()) return this.progLog('error', t('Önce bağlanın.'));
    const mcu = this.lib.mcus[this.design.mcuId];
    let r;
    try {
      r = prog.readRange(mcu, m.region, Number(m.addr), Number(m.length));
    } catch (e) {
      return this.progLog('error', e.message);
    }
    const name = `${mcu.name}_${m.region === 'custom' ? '0x' + r.addr.toString(16).padStart(8, '0') : m.region}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${name}.${m.format === 'hex' ? 'hex' : 'bin'}`)),
      filters: { [t('Ham ikili')]: ['bin'], 'Intel HEX': ['hex'] }
    });
    if (!uri) return;
    const started = Date.now();
    this.progLog('info', t('Okunuyor: 0x{0}, {1}', r.addr.toString(16).toUpperCase().padStart(8, '0'), prog.sizeText(r.length)));
    try {
      const bytes = await this.progReadBytes(r.addr, r.length, 'read');
      fs.writeFileSync(uri.fsPath, /\.hex$/i.test(uri.fsPath) ? toIntelHex(bytes, r.addr) : bytes);
      this.progLog('ok', t('{0} kaydedildi ({1}, {2} sn).', path.basename(uri.fsPath), prog.sizeText(r.length), ((Date.now() - started) / 1000).toFixed(1)));
    } catch (e) {
      this.progLog('error', t('Okuma başarısız: {0}', e.message));
    }
    this.post({ type: 'prog.progress', op: 'read', pct: null });
  }

  /** Firmware dosyası seçtirir; dosya yolu ve flash bölütleri (.elf objcopy ile, .hex, .bin + başlangıç adresi) */
  async progPickImage(base, title) {
    const pick = await vscode.window.showOpenDialog({
      canSelectMany: false, openLabel: title, defaultUri: this.root ? vscode.Uri.file(this.root) : undefined,
      filters: { [t('Firmware')]: ['elf', 'hex', 'bin'] }
    });
    if (!pick || !pick[0]) return null;
    const file = pick[0].fsPath;
    let segments;
    try {
      if (/\.hex$/i.test(file)) segments = prog.parseIntelHex(fs.readFileSync(file, 'utf8'));
      else if (/\.elf$/i.test(file)) {
        const tmp = path.join(require('os').tmpdir(), `es-img-${Date.now()}.hex`);
        await new Promise((resolve, reject) => require('child_process').execFile(cm.gccTool(this.design.build, 'objcopy'), ['-O', 'ihex', file, tmp], { windowsHide: true },
          (e, so, se) => (e ? reject(new Error(se || e.message)) : resolve(undefined))));
        segments = prog.parseIntelHex(fs.readFileSync(tmp, 'utf8'));
        fs.rmSync(tmp, { force: true });
      } else segments = [{ addr: (Number(base) || prog.FLASH_BASE) >>> 0, bytes: new Uint8Array(fs.readFileSync(file)) }];
    } catch (e) {
      this.progLog('error', t('{0} okunamadı: {1}', path.basename(file), e.message));
      return null;
    }
    // Yalnızca kod bölgesi (flash); RAM'e yüklenen bölütler dışarıda
    segments = segments.filter((s) => s.addr < prog.RAM_BASE);
    const size = segments.reduce((n, s) => n + s.bytes.length, 0);
    if (!size) {
      this.progLog('error', t('{0} içinde flash\'a yazılacak veri yok.', path.basename(file)));
      return null;
    }
    return { file, segments, size };
  }

  /** Dosya (.bin / .hex / .elf) ↔ cihaz karşılaştırması */
  async progCompare(m) {
    if (!this.progT()) return this.progLog('error', t('Önce bağlanın.'));
    const img = await this.progPickImage(m.base);
    if (!img) return;
    this.progLog('info', t('Karşılaştırılıyor: {0} ({1})', path.basename(img.file), prog.sizeText(img.size)));
    try {
      const r = await this.progVerify(img.segments, 'compare');
      this.post({ type: 'prog.compare', file: path.basename(img.file), result: r });
      if (r.same) this.progLog('ok', t('Aynı: {0} bayt cihazdakiyle birebir eşleşiyor.', r.total));
      else this.progLog('warn', t('Farklı: {0} / {1} bayt, {2} bölgede.', r.diff, r.total, r.rangeCount) + (r.blankDevice ? ' ' + t('Cihazda bu bölge boş (silinmiş).') : ''));
    } catch (e) {
      this.progLog('error', t('Karşılaştırma başarısız: {0}', e.message));
    }
    this.post({ type: 'prog.progress', op: 'compare', pct: null });
  }

  async progVerify(segments, op) {
    const device = [];
    for (const s of segments) device.push({ addr: s.addr, bytes: await this.progReadBytes(s.addr, s.bytes.length, op) });
    return prog.compareImages(segments, device);
  }

  /**
   * Dosya yaz: gerekli sektörleri sil, yaz, doğrula, çalıştır. OpenOCD'de `program` (kendi silme ve doğrulamasıyla),
   * bootloader ve simülasyonda blok blok.
   * @param {{ base?: number, erase?: boolean, verify?: boolean, run?: boolean }} m
   */
  async progWrite(m) {
    if (this.esboot) return this.esbootUpdate(m);
    const tg = this.progT();
    if (!tg) return this.progLog('error', t('Önce bağlanın.'));
    const img = await this.progPickImage(m.base, t('Yaz'));
    if (!img) return;
    const name = path.basename(img.file);
    const started = Date.now();
    this.progLog('info', t('Yazılıyor: {0} ({1}, {2} bölüt)', name, prog.sizeText(img.size), img.segments.length));
    try {
      if (tg.mode === 'openocd') {
        this.post({ type: 'prog.progress', op: 'write', pct: 5 });
        await tg.programFile(img.file, /\.bin$/i.test(img.file) ? img.segments[0].addr : undefined, m.verify !== false);
      } else {
        const sectors = this.progSectors || prog.flashLayout(this.lib.mcus[this.design.mcuId]);
        if (m.erase !== false) {
          const need = sectors.filter((s) => img.segments.some((g) => s.addr < g.addr + g.bytes.length && g.addr < s.addr + s.size)).map((s) => s.index);
          const ranges = prog.eraseRanges(sectors, need);
          this.progLog('info', t('Siliniyor: {0} sektör ({1})', need.length, prog.sizeText(ranges.reduce((n, r) => n + r.size, 0))));
          for (const r of ranges) await tg.eraseSectors(r.bank, r.first, r.last);
        }
        let done = 0;
        for (const g of img.segments) {
          await tg.writeFlash(g.addr, g.bytes, (n) => this.post({ type: 'prog.progress', op: 'write', pct: Math.round(((done + n) * 100) / img.size) }));
          done += g.bytes.length;
        }
        if (m.verify !== false) {
          const r = await this.progVerify(img.segments, 'write');
          if (!r.same) throw new Error(t('Doğrulama başarısız: {0} bayt farklı (ilk {1}).', r.diff, '0x' + r.first[0].addr.toString(16).toUpperCase()));
        }
      }
      this.progLog('ok', t('Yazıldı: {0}, {1} sn{2}.', name, ((Date.now() - started) / 1000).toFixed(1), m.verify !== false ? ', ' + t('doğrulandı') : ''));
      if (m.run) await this.progReset();
    } catch (e) {
      this.progLog('error', t('Yazma başarısız: {0}', e.message));
    }
    this.post({ type: 'prog.progress', op: 'write', pct: null });
    if (this.progT()) await this.progInfo();
  }

  /** Reset ve çalıştır; bootloader'da GO komutu (bağlantı biter) */
  async progReset() {
    if (this.esboot) {
      try {
        await this.esboot.client.request(esboot.CMD.BOOT);
      } catch (e) {
        return this.progLog('error', e.message);
      }
      return this.bootDisconnect(t('Bootloader yeniden başlatıldı: uygulama doğrulanıp çalıştırılıyor.'));
    }
    const tg = this.progT();
    if (!tg) return;
    try {
      await tg.reset();
    } catch (e) {
      return this.progLog('error', e.message);
    }
    if (tg === this.bootTarget) return this.bootDisconnect(t('Uygulama çalıştırıldı (GO {0}); bootloader bağlantısı kapandı.', '0x08000000'));
    this.progLog('info', t('Hedef resetlendi ve çalışıyor.'));
    this.post({ type: 'debug.status', connected: true, mode: tg.mode, state: await tg.state() });
  }

  /** Seçili sektörleri ya da bütün flash'ı siler (onaylı) */
  async progErase(m) {
    const tg = this.progT();
    if (!tg || !this.progSectors) return this.progLog('error', t('Önce bağlanın.'));
    const all = !!m.all;
    const indexes = all ? this.progSectors.map((s) => s.index) : (m.indexes || []);
    const ranges = prog.eraseRanges(this.progSectors, indexes);
    if (!ranges.length) return;
    const size = ranges.reduce((n, r) => n + r.size, 0);
    const what = all ? t('Bütün flash ({0}) silinecek.', prog.sizeText(size)) : t('{0} sektör ({1}) silinecek.', indexes.length, prog.sizeText(size));
    const ok = t('Sil');
    if ((await vscode.window.showWarningMessage(what + ' ' + t('Hedef durdurulur; bu işlem geri alınamaz.'), { modal: true }, ok)) !== ok) return;
    const started = Date.now();
    this.progLog('info', what);
    try {
      let done = 0;
      for (const r of ranges) {
        await tg.eraseSectors(r.bank, r.first, r.last);
        done += r.size;
        this.post({ type: 'prog.progress', op: 'erase', pct: Math.round((done * 100) / size) });
      }
      this.progLog('ok', t('Silindi: {0} ({1} sn). Hedef durduruldu; çalıştırmak için "Reset ve çalıştır".', prog.sizeText(size), ((Date.now() - started) / 1000).toFixed(1)));
    } catch (e) {
      this.progLog('error', t('Silme başarısız: {0}', e.message));
    }
    this.post({ type: 'prog.progress', op: 'erase', pct: null });
    if (tg === this.target) this.post({ type: 'debug.status', connected: true, mode: tg.mode, state: await tg.state().catch(() => '') });
    await this.progInfo();
  }

  /**
   * ES-302: USB DFU araçla (dfu-util ya da STM32_Programmer_CLI). op: list | write | read | erase
   * @param {{ op: string, tool?: string, base?: number, length?: number, run?: boolean }} m
   */
  async progDfu(m) {
    const tools = this._progTools || (this._progTools = await detectTools().catch(() => []));
    const found = (id) => tools.find((x) => x.id === id && x.found);
    const tool = (m.tool && found(m.tool)) || found('dfuutil') || found('cubeprog');
    if (!tool) return this.progLog('error', t('USB DFU için dfu-util ya da STM32CubeProgrammer gerekir; ikisi de bulunamadı.'));
    const mcu = this.lib.mcus[this.design.mcuId];
    let file, args;
    if (m.op === 'write') {
      const img = await this.progPickImage(m.base, t('Yaz'));
      if (!img) return;
      // dfu-util ELF/HEX okumaz: bölütlerden tek .bin
      if (tool.id === 'dfuutil' && !/\.bin$/i.test(img.file)) {
        const lo = Math.min(...img.segments.map((s) => s.addr));
        const hi = Math.max(...img.segments.map((s) => s.addr + s.bytes.length));
        const bin = new Uint8Array(hi - lo).fill(0xff);
        for (const s of img.segments) bin.set(s.bytes, s.addr - lo);
        file = path.join(require('os').tmpdir(), `es-dfu-${Date.now()}.bin`);
        fs.writeFileSync(file, bin);
        m.base = lo;
      } else file = img.file;
    } else if (m.op === 'read') {
      const uri = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${mcu.name}_flash.bin`)), filters: { [t('Ham ikili')]: ['bin'] } });
      if (!uri) return;
      file = uri.fsPath;
    } else if (m.op === 'erase') {
      const ok = t('Sil');
      if ((await vscode.window.showWarningMessage(t('Bütün flash ({0}) silinecek.', prog.sizeText(mcu.device.flashKB * 1024)) + ' ' + t('Bu işlem geri alınamaz.'), { modal: true }, ok)) !== ok) return;
    }
    const length = mcu.device.flashKB * 1024;
    args = tool.id === 'dfuutil'
      ? sysboot.dfuUtilArgs({ op: m.op, file, addr: m.base, length, leave: !!m.run })
      : sysboot.cubeProgArgs({ port: 'usb1', op: m.op, file, addr: m.base, length, verify: true, go: !!m.run });
    this.progLog('info', `> ${path.basename(tool.path)} ${args.join(' ')}`);
    const out = await new Promise((resolve) => {
      let log = '', buf = '';
      const p = require('child_process').spawn(tool.path, args, { windowsHide: true });
      const onText = (d) => {
        const s = String(d);
        log += s;
        this._progOut && this._progOut.append(s);
        buf += s;
        const lines = buf.split(/\r?\n|\r/);
        buf = lines.pop() || '';
        for (const l of lines) {
          const pr = sysboot.parseDfuProgress(l) || (/(\d{1,3})%/.exec(l) && { percent: Number(/(\d{1,3})%/.exec(l)[1]) });
          if (pr) this.post({ type: 'prog.progress', op: 'dfu', pct: pr.percent });
        }
      };
      p.stdout.on('data', onText);
      p.stderr.on('data', onText);
      p.on('error', (e) => resolve({ code: -1, log: e.message }));
      p.on('exit', (code) => resolve({ code, log }));
    });
    this.post({ type: 'prog.progress', op: 'dfu', pct: null });
    if (m.op === 'list') {
      const devices = tool.id === 'dfuutil' ? sysboot.parseDfuList(out.log) : [];
      this.post({ type: 'prog.dfu', devices, raw: tool.id === 'dfuutil' ? '' : out.log.slice(-2000) });
      return this.progLog(devices.length || tool.id !== 'dfuutil' ? 'ok' : 'warn', devices.length ? t('{0} DFU aygıtı bulundu.', devices.length) : tool.id === 'dfuutil' ? t('DFU aygıtı bulunamadı. BOOT0 = 1 iken reset atın ve USB kablosunu (veri destekli) işlemcinin USB pinlerine (PA11/PA12) bağlayın.') : t('Liste çıktı panelinde.'));
    }
    // dfu-util ':leave' sonrası aygıt kaybolunca sıfır dışı kodla çıkabilir
    const ok = out.code === 0 || (m.run && /File downloaded successfully|Download done/i.test(out.log));
    if (ok) this.progLog('ok', t('DFU işlemi tamamlandı: {0}.', m.op));
    else this.progLog('error', sysboot.explainDfu(out.log) || t('DFU işlemi başarısız (kod {0}); ayrıntı çıktı panelinde.', out.code));
    if (file && m.op === 'write' && /es-dfu-\d+\.bin$/.test(file)) fs.rmSync(file, { force: true });
  }

  /** VS Code debug oturumu başlamadan önce: panelin OpenOCD bağlantısı probu bırakır */
  async releaseProbe() {
    if (!this.target || this.target.mode !== 'openocd') return;
    await this.dropTrace();
    await this.target.disconnect().catch(() => {});
    this.target = null;
    this.post({ type: 'debug.status', connected: false, error: t('Prob VS Code debug oturumuna devredildi; panel bağlantısı kapatıldı.') });
  }

  outputChannel() {
    if (!this._out) this._out = vscode.window.createOutputChannel('Embedded Studio: OpenOCD');
    return this._out;
  }

  async debugCommand(cmd) {
    if (!this.target) return;
    try {
      await this.target[cmd]();
    } catch (e) {
      this.toast('error', e.message);
    }
    this.post({ type: 'debug.status', connected: true, mode: this.target.mode, state: await this.target.state() });
  }

  async debugRead(m) {
    if (!this.target) return;
    const values = {}, errors = {};
    let core = null;
    for (const r of m.reads || []) {
      try {
        values[r.key] = await this.target.readMemory(r.addr, r.words);
      } catch (e) {
        errors[r.key] = e.message;
      }
    }
    const state = await this.target.state().catch(() => 'unknown');
    if (m.core && state === 'halted') core = await this.target.coreRegisters(this.cpuInfo()).catch((e) => ({ error: e.message }));
    this.post({ type: 'debug.data', seq: m.seq, values, errors, core, state });
  }

  /** Çekirdek: ARMv6-M mi (BASEPRI/FAULTMASK yok), FPU var mı */
  cpuInfo() {
    const fam = familyOf(this.lib.mcus[this.design.mcuId]);
    return { v6m: /cortex-m0/.test(fam.core), fpu: !!fam.fpu };
  }

  /** ES-205: çevre birimi register'ına ya da bit alanına yazma (alan için oku-değiştir-yaz) */
  async debugWrite(m) {
    if (!this.target) return;
    const p = this.peripheralDefs.find((x) => x.name === m.periph);
    const r = p && p.registers.find((x) => x.name === m.reg);
    if (!r) return this.toast('error', t('Register bulunamadı: {0}.{1}', m.periph, m.reg));
    const f = m.field && r.fields.find((x) => x.name === m.field);
    try {
      const access = (f && f.access) || r.access || 'rw';
      if (access === 'ro') throw new Error(t('{0} salt okunur.', f ? `${r.name}.${f.name}` : r.name));
      const value = typeof m.value === 'number' ? m.value >>> 0 : parseValue(m.value);
      const width = r.size || 32;
      let word = value;
      if (f) {
        // Salt yazılır register okunamaz: diğer alanlar 0 (ya da reset değeri) kabul edilir
        const cur = r.access === 'wo' ? (r.reset || 0) : (await this.target.readMemory(p.base + r.offset, 1))[0];
        word = insertField(cur, f.lsb, f.width, value);
      } else if (width < 32 && value > mask(width)) throw new Error(t('Değer alana sığmıyor: 0…{0}', mask(width)));
      await this.target.writeMemory(p.base + r.offset, width, word);
      this.post({ type: 'debug.written', periph: p.name, reg: r.name, value: word });
    } catch (e) {
      this.toast('error', e.message);
    }
  }

  /** .embedded-studio/debug.json: favori register'lar (işlemciye göre), izlenen değişkenler */
  debugState() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, STATE_DIR, 'debug.json'), 'utf8')) || {};
    } catch {
      return {};
    }
  }

  saveDebugState(patch) {
    if (!this.root) return;
    const file = path.join(this.root, STATE_DIR, 'debug.json');
    const d = { ...this.debugState(), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(d, null, 2) + '\n');
  }

  /** Favori register'lar ("GPIOA.ODR") */
  favorites() {
    const d = this.debugState();
    return (d.favorites && d.favorites[this.lib.mcus[this.design.mcuId].name]) || [];
  }

  setFavorite(key, on) {
    if (!this.root) return;
    const mcuName = this.lib.mcus[this.design.mcuId].name;
    const favorites = this.debugState().favorites || {};
    const list = (favorites[mcuName] || []).filter((x) => x !== key);
    if (on) list.push(key);
    favorites[mcuName] = list;
    this.saveDebugState({ favorites });
    this.postFavorites();
  }

  /** ES-206: bellek görüntüleyiciden yazma (8/16/32 bit) */
  async memoryWrite(m) {
    if (!this.target) return;
    try {
      const width = Number(m.width);
      const value = typeof m.value === 'number' ? m.value >>> 0 : parseValue(m.value);
      const err = checkWrite(m.addr >>> 0, width, value);
      if (err) throw new Error(err);
      await this.target.writeMemory(m.addr >>> 0, width, value);
      this.post({ type: 'debug.written', addr: m.addr });
    } catch (e) {
      this.toast('error', e.message);
    }
  }

  /** ES-206: bellek bölgesini dosyaya kaydet (.bin ham, .hex Intel HEX) */
  async memorySave(m) {
    if (!this.target) return;
    const addr = m.addr >>> 0, length = Number(m.length);
    if (!(length > 0 && length <= MAX_SAVE)) return this.toast('error', t('Bölge boyutu 1 bayt ile 1 MB arasında olmalı.'));
    const name = `mem_0x${addr.toString(16).padStart(8, '0')}_${length}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${name}.bin`)),
      filters: { [t('Ham ikili')]: ['bin'], 'Intel HEX': ['hex'] }
    });
    if (!uri) return;
    try {
      const bytes = await readRegion(this.target, addr, length);
      const file = uri.fsPath;
      if (/\.hex$/i.test(file)) fs.writeFileSync(file, toIntelHex(bytes, addr));
      else fs.writeFileSync(file, bytes);
      this.toast('info', t('{0} bayt kaydedildi: {1}', length, path.basename(file)));
    } catch (e) {
      this.toast('error', e.message);
    }
  }

  /** Favorilerin tanımları (farklı çevre birimlerinden; webview okuma listesine ekler) */
  postFavorites() {
    const favs = this.favorites().map((key) => {
      const [pn, rn] = key.split('.');
      const p = this.peripheralDefs.find((x) => x.name === pn);
      const r = p && p.registers.find((x) => x.name === rn);
      return r ? { key, periph: pn, base: p.base, reg: r } : null;
    }).filter(Boolean);
    this.post({ type: 'debug.favorites', favorites: favs });
  }

  /** Bir çevre biriminin register tanımları (webview seçince ister) */
  postPeripheral(name) {
    const p = this.peripheralDefs.find((x) => x.name === name);
    if (p) this.post({ type: 'debug.periph', name: p.name, base: p.base, registers: p.registers });
  }

  /**
   * ES-207: HardFault analizi. Hedef çalışıyorsa önce durdurulur (fault işleyicisi sonsuz döngüdedir).
   * simulate: simülasyonda önce o senaryodaki fault oluşturulur.
   */
  async faultAnalyze(simulate) {
    if (!this.target) return;
    const elf = this.root ? path.join(this.root, cm.elfRel(this.design)) : '';
    try {
      if (simulate && this.target.mode === 'sim') {
        const sc = fault.SIM_FAULTS()[simulate];
        if (!sc) throw new Error(t('Bilinmeyen senaryo: {0}', simulate));
        // ELF varsa gerçek fonksiyon adresleri: kaynak satıra gitme simülasyonda da denenebilsin
        const fn = await fault.funcAddr(elf, ['main', 'Board_Init', 'App_Init', 'HAL_Delay'], cm.gccTool(this.design.build, 'nm'));
        const inner = fn.Board_Init ?? fn.App_Init ?? fn.HAL_Delay;
        await this.target.fault(sc, fn.main !== undefined ? { pc: (inner ?? fn.main) + 8, lr: fn.main + 0x10 } : { pc: 0x08000a3c, lr: 0x08000b10 });
      }
      let halted = false;
      if ((await this.target.state()) !== 'halted') { await this.target.halt(); halted = true; }
      let tcb;
      if (this.design.rtos) tcb = (await elfSymbols(elf, cm.gccTool(this.design.build, 'nm')).catch(() => [])).find((x) => x.name === 'pxCurrentTCB')?.addr;
      const report = await fault.analyze(this.target, this.cpuInfo(), { rtos: !!this.design.rtos, tcb });
      const f = report.frame;
      const where = f && !f.invalid ? await fault.addr2line(elf, [f.pc, (f.lr & ~1) - 2], cm.gccTool(this.design.build, 'addr2line')) : [null, null];
      const src = (loc) => loc && { ...loc, file: loc.file && (path.isAbsolute(loc.file) ? loc.file : path.join(this.root, loc.file)) };
      this.post({ type: 'debug.faultReport', ...report, pcSource: src(where[0]), lrSource: src(where[1]), haltedNow: halted, elf: fs.existsSync(elf) ? path.relative(this.root, elf) : '' });
      this.post({ type: 'debug.status', connected: true, mode: this.target.mode, state: await this.target.state() });
    } catch (e) {
      this.post({ type: 'debug.faultReport', error: e.message });
    }
  }

  // ---------------------------------------------------------------- ES-208: SWO/ITM, RTT, semihosting
  async dropTrace() {
    const tr = this.trace;
    this.trace = null;
    if (tr) await tr.dispose().catch(() => {});
  }

  /** Hata webview'daki konsol durumuna yazılır (toast yerine: konsolun yanında görünsün) */
  async traceCall(fn) {
    if (!this.trace) return this.post({ type: 'debug.trace', error: t('Önce hedefe bağlanın.') });
    try {
      await fn();
    } catch (e) {
      this.trace?.status({ error: e.message });
    }
  }

  /** Konsol varsayılanları: çekirdek saati (HCLK = TRACECLKIN), SWO desteği, kayıtlı ayarlar */
  postTraceInfo() {
    const mcu = this.lib.mcus[this.design.mcuId];
    const fam = familyOf(mcu);
    const { clock } = this.compute();
    const v6m = /cortex-m0/.test(fam.core);
    this.post({
      type: 'debug.traceInfo', cpuHz: Math.round(clock.freq.hclk * 1e6), swo: !v6m, dataTrace: !v6m && fam.core !== 'cortex-m33',
      core: fam.core, settings: this.debugState().trace || {}
    });
  }

  /** @param {{ cpuHz: number, swoHz: number, ports: string, pc?: boolean, data?: string[] }} m */
  async startSwo(m) {
    const mcu = this.lib.mcus[this.design.mcuId];
    if (/cortex-m0/.test(familyOf(mcu).core)) throw new Error(t('{0} (Cortex-M0/M0+) ITM/SWO içermez; RTT ya da semihosting kullanın.', mcu.name));
    const ports = trace.parsePorts(m.ports);
    if (!Number.isFinite(ports) || !ports) throw new Error(t('Geçersiz port listesi: {0} (ör. 0 ya da 0,1,5-7)', m.ports));
    const elf = this.root ? path.join(this.root, cm.elfRel(this.design)) : '';
    const nm = cm.gccTool(this.design.build, 'nm');
    let funcs = m.pc ? await trace.functionSymbols(elf, nm) : [];
    if (m.pc && !funcs.length && this.target.mode === 'sim') funcs = trace.SIM_FUNCS;
    // Data trace: izleme listesindeki adlar → adres/boyut (ELF; simülasyonda örnek değişkenler)
    let data = [];
    if ((m.data || []).length) {
      const syms = await elfSymbols(elf, nm).catch(() => (this.target.mode === 'sim' ? simSymbols(this.target.model, this.design.instances) : []));
      data = m.data.slice(0, trace.DWT_COMPARATORS).map((name) => {
        const s = syms.find((x) => x.name === name);
        if (!s) throw new Error(t('Değişken bulunamadı: {0}', name));
        return { name, addr: s.addr, size: s.size >= 4 ? 4 : s.size >= 2 ? 2 : 1, pc: !!m.dataPc };
      });
    }
    this.saveDebugState({ trace: { ...(this.debugState().trace || {}), swoHz: m.swoHz, ports: m.ports, pc: !!m.pc, data: m.data || [] } });
    await this.trace.startSwo({ cpuHz: Number(m.cpuHz), swoHz: Number(m.swoHz), ports, pc: !!m.pc, data, funcs });
  }

  /** RTT: ELF'te _SEGGER_RTT varsa doğrudan, yoksa RAM'de arama */
  async startRtt(m) {
    const mcu = this.lib.mcus[this.design.mcuId];
    const elf = this.root ? path.join(this.root, cm.elfRel(this.design)) : '';
    let addr = m.addr ? parseValue(m.addr) : await trace.symbolAddr(elf, '_SEGGER_RTT', cm.gccTool(this.design.build, 'nm'));
    if (addr !== undefined && !Number.isFinite(addr)) addr = undefined;
    this.saveDebugState({ trace: { ...(this.debugState().trace || {}), rttAddr: m.addr || '' } });
    await this.trace.startRtt({ addr, ramStart: 0x20000000, ramSize: Math.min(512, mcu.ramKB || 64) * 1024 });
  }

  // ---------------------------------------------------------------- ES-209: FreeRTOS farkındalıklı debug
  /**
   * Çekirdek sembolleri, FreeRTOSConfig.h, fonksiyonlar ve kod (ELF değişince yenilenir).
   * Simülasyonda çekirdek yapıları hedefin belleğine kurulur.
   */
  async rtosContext() {
    const mcu = this.lib.mcus[this.design.mcuId];
    const fam = familyOf(mcu);
    if (this.target.mode === 'sim') {
      if (!this.target.rtosSyms) this.target.rtosSyms = rtos.simKernel(this.target, { names: this.design.instances.map((i) => i.label), core: fam.core, funcs: trace.SIM_FUNCS });
      return { key: 'sim', syms: rtos.symbolMap(this.target.rtosSyms), cfg: rtos.DEFAULT_CONFIG, cfgSource: t('simülasyon'), funcs: trace.SIM_FUNCS, code: null, core: fam.core, elf: '' };
    }
    const elf = this.root ? path.join(this.root, cm.elfRel(this.design)) : '';
    if (!elf || !fs.existsSync(elf)) throw new Error(t('ELF bulunamadı: {0}. Önce projeyi derleyin.', elf ? path.relative(this.root, elf) : '?'));
    const key = `${elf}:${fs.statSync(elf).mtimeMs}`;
    if (this._rtosCtx && this._rtosCtx.key === key) return this._rtosCtx;
    const nm = cm.gccTool(this.design.build, 'nm');
    const syms = rtos.symbolMap(await elfSymbols(elf, nm));
    // FreeRTOSConfig.h: üretilen yerleşimdeki yer, yoksa projede aranır
    let cfgFile = path.join(this.root, layout(this.design.framework, fam.key).inc, 'FreeRTOSConfig.h');
    if (!fs.existsSync(cfgFile)) cfgFile = findFile(this.root, 'FreeRTOSConfig.h', 4) || '';
    const cfg = cfgFile ? rtos.parseConfig(fs.readFileSync(cfgFile, 'utf8')) : rtos.DEFAULT_CONFIG;
    this._rtosCtx = {
      key, syms, cfg, cfgSource: cfgFile ? path.relative(this.root, cfgFile) : t('varsayılan (FreeRTOSConfig.h bulunamadı)'),
      funcs: await trace.functionSymbols(elf, nm), code: rtos.elfCode(elf), core: fam.core, elf
    };
    return this._rtosCtx;
  }

  async rtosSnapshot() {
    if (!this.target) return;
    try {
      if (!this.design.rtos && this.target.mode === 'sim') throw new Error(t('Bu proje FreeRTOS kullanmıyor (Ayarlar > İşletim sistemi).'));
      const c = await this.rtosContext();
      if (!this.rtosReader || this.rtosReader.key !== c.key || this.rtosReader.target !== this.target) {
        this.rtosReader = new rtos.RtosReader(this.target, c);
        this.rtosReader.key = c.key;
      }
      const snap = await this.rtosReader.snapshot();
      const prof = new trace.PcProfile(c.funcs);
      for (const tm of snap.timers) tm.callbackName = prof.lookup(tm.callback & ~1) || '';
      this.rtosLast = snap;
      this.post({ type: 'debug.rtosData', ...snap, cfgSource: c.cfgSource, state: await this.target.state().catch(() => '') });
    } catch (e) {
      this.post({ type: 'debug.rtosData', error: e.message });
    }
  }

  /** Görevin kayıtlı bağlamı ve olası çağrı zinciri (kaynak satırlarıyla) */
  async rtosStack(tcb) {
    if (!this.target) return;
    try {
      const c = await this.rtosContext();
      const task = (this.rtosLast?.tasks || []).find((x) => x.tcb === tcb);
      if (!task) throw new Error(t('Görev bulunamadı; listeyi yenileyin.'));
      const halted = (await this.target.state()) === 'halted';
      let live = null;
      if (task.state === 'running') {
        if (!halted) throw new Error(t('Çalışan görevin call stack\'i için hedefi durdurun.'));
        live = await this.target.coreRegisters(this.cpuInfo());
      }
      const ctx = await rtos.taskContext(this.target, task, c.core, live);
      if (!ctx) throw new Error(t('Görevin kayıtlı bağlamı okunamadı (yığın bozuk ya da port düzeni tanınmadı).'));
      const prof = new trace.PcProfile(c.funcs);
      const top = task.stackEnd ? task.stackEnd + 4 : task.stackSize ? task.pxStack + task.stackSize : undefined;
      const frames = await rtos.backtrace(this.target, ctx.regs, top, (a) => prof.lookup(a), c.code);
      // Dönüş adresinin bir öncesi çağrı satırıdır
      const where = await fault.addr2line(c.elf, frames.map((f) => (f.kind === 'pc' ? f.pc : f.pc - 2)), cm.gccTool(this.design.build, 'addr2line'));
      frames.forEach((f, i) => { const w = where[i]; if (w && w.file) f.source = { ...w, file: path.isAbsolute(w.file) ? w.file : path.join(this.root, w.file) }; });
      this.post({ type: 'debug.rtosStack', task: task.name, tcb, regs: ctx.regs, layout: ctx.layout, fpu: ctx.fpu, frames, live: !!live, elf: !!c.code });
    } catch (e) {
      this.post({ type: 'debug.rtosStack', tcb, error: e.message });
    }
  }

  // ---------------------------------------------------------------- ES-211: seri port terminali
  /** .embedded-studio/terminal.json: makrolar ve son kullanılan port ayarları (takımla paylaşılabilir) */
  termConfig() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.root, STATE_DIR, 'terminal.json'), 'utf8')) || {};
    } catch {
      return {};
    }
  }

  saveTermConfig(config) {
    if (!this.root) return;
    const file = path.join(this.root, STATE_DIR, 'terminal.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ ...this.termConfig(), ...config }, null, 2) + '\n');
  }

  /** Port listesi; quick: yalnızca port kümesi değiştiyse (hızlı kayıt defteri denetimi) yeniden okunur */
  async termPorts(quick) {
    const sig = (await serial.quickPorts()).join(',');
    if (quick && sig === this._portSig && this._ports) return;
    this._portSig = sig;
    this._ports = await serial.listPorts();
    this.post({ type: 'term.ports', ports: this._ports });
  }

  get terms() {
    if (!this._terms) this._terms = new Map();
    return this._terms;
  }

  async termOpen(m) {
    await this.termClose(m.id);
    const used = [...this.terms.values()].find((x) => x.sess.opts.path === m.path && m.path !== serial.SIM_PORT);
    if (used) return this.post({ type: 'term.status', id: m.id, open: false, error: t('{0} bu terminalde başka bir sekmede zaten açık.', m.path) });
    let sess;
    try {
      sess = new serial.SerialSession(m);
    } catch (e) {
      return this.post({ type: 'term.status', id: m.id, open: false, error: e.message });
    }
    const entry = { sess, pending: [], pendingBytes: 0, log: null, timer: null };
    this.terms.set(m.id, entry);
    this.post({ type: 'term.status', id: m.id, open: false, opening: true });
    sess.on('data', (b) => {
      const now = Date.now();
      entry.log?.write('rx', b, now);
      // Webview'a 50 ms'de bir toplu gönderilir; çok hızlı akışta en eski parçalar atılır (log dosyası eksiksiz kalır)
      entry.pending.push({ t: now, d: b.toString('base64') });
      entry.pendingBytes += b.length;
      while (entry.pendingBytes > 1 << 20 && entry.pending.length > 1) entry.pendingBytes -= Buffer.byteLength(entry.pending.shift().d, 'base64');
    });
    sess.on('error', (e) => this.post({ type: 'term.status', id: m.id, open: sess.isOpen, error: e.message }));
    sess.on('close', () => {
      if (this.terms.get(m.id) !== entry) return;
      this.termFlush(m.id, entry);
      clearInterval(entry.timer);
      entry.log?.close();
      this.terms.delete(m.id);
      this.post({ type: 'term.status', id: m.id, open: false, error: t('Port kapandı (kart çıkarılmış olabilir).') });
    });
    try {
      await sess.open();
    } catch (e) {
      this.terms.delete(m.id);
      return this.post({ type: 'term.status', id: m.id, open: false, error: e.message });
    }
    entry.timer = setInterval(() => this.termFlush(m.id, entry), 50);
    this.saveTermConfig({ last: { path: m.path, baud: sess.opts.baud, dataBits: sess.opts.dataBits, parity: sess.opts.parity, stopBits: sess.opts.stopBits, flow: sess.opts.flow } });
    this.post({ type: 'term.status', id: m.id, open: true, opts: sess.opts });
  }

  termFlush(id, entry) {
    if (!entry.pending.length) return;
    this.post({ type: 'term.data', id, chunks: entry.pending });
    entry.pending = [];
    entry.pendingBytes = 0;
  }

  termSend(id, data) {
    const e = this.terms.get(id);
    if (!e) return this.post({ type: 'term.status', id, open: false, error: t('Port açık değil.') });
    try {
      e.log?.write('tx', data);
      e.sess.write(data);
    } catch (err) {
      this.post({ type: 'term.status', id, open: e.sess.isOpen, error: err.message });
    }
  }

  async termClose(id) {
    const e = this.terms.get(id);
    if (!e) return;
    this.terms.delete(id);
    clearInterval(e.timer);
    this.termFlush(id, e);
    await e.log?.close();
    await e.sess.close();
    this.post({ type: 'term.status', id, open: false });
  }

  termCloseAll() {
    for (const id of [...this.terms.keys()]) this.termClose(id).catch(() => {});
  }

  /** Log dosyasına sürekli kayıt: metin (zaman damgalı) ya da ham bayt */
  async termLog(m) {
    const e = this.terms.get(m.id);
    if (!e) return;
    if (!m.on) {
      await e.log?.close();
      e.log = null;
      return this.post({ type: 'term.logging', id: m.id, file: '' });
    }
    const raw = m.format === 'raw';
    const stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${e.sess.opts.path.replace(/[^\w.-]/g, '_')}-${stamp}.${raw ? 'bin' : 'log'}`)),
      filters: raw ? { [t('Ham ikili')]: ['bin'] } : { [t('Günlük')]: ['log', 'txt'] }
    });
    if (!uri) return this.post({ type: 'term.logging', id: m.id, file: '' });
    e.log = new serial.SerialLog(uri.fsPath, raw ? 'raw' : 'text');
    this.post({ type: 'term.logging', id: m.id, file: uri.fsPath, format: raw ? 'raw' : 'text' });
  }

  // ---------------------------------------------------------------- ES-210: Build Analyzer
  analyzerElf(config) {
    const b = cm.normalizeBuild(this.design.build);
    const type = config || b.type;
    return { type, elf: path.join(this.root, cm.elfRel({ ...this.design, build: { ...this.design.build, type } })) };
  }

  /** .elf + .map + .su/.ci → bölgeler, bölümler, semboller, dosyalar, yığın; önceki derlemeyle fark */
  async analyzeBuild(config) {
    if (!this.root) return this.post({ type: 'analyzer.data', error: t('Önce bir proje açın.') });
    const { type, elf } = this.analyzerElf(config);
    try {
      if (!fs.existsSync(elf)) throw new Error(t('{0} derlemesi yok ({1}). Önce derleyin.', type, path.relative(this.root, elf)));
      const st = fs.statSync(elf);
      const parsed = A.readElf(fs.readFileSync(elf));
      const mapFile = elf.replace(/\.elf$/i, '.map');
      const map = fs.existsSync(mapFile) ? A.parseMap(fs.readFileSync(mapFile, 'utf8')) : { regions: [], inputs: [] };
      const dev = this.lib.mcus[this.design.mcuId].device;
      const regions = map.regions.length ? map.regions : A.defaultRegions(dev.flashKB, dev.ramKB);
      const usage = A.regionUsage(parsed.sections, regions);
      const symbols = A.symbolList(parsed, regions);
      // Geçmiş: ELF değiştiyse şimdiki önceki olur
      const file = path.join(this.root, STATE_DIR, 'analyzer.json');
      let hist = {};
      try { hist = JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { hist = {}; }
      const h = hist[type] || {};
      const key = `${st.size}:${Math.round(st.mtimeMs)}`;
      if (!h.current || h.current.key !== key) {
        h.previous = h.current || null;
        h.current = A.snapshot(key, usage, symbols);
        hist[type] = h;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(hist) + '\n');
      }
      const b = cm.normalizeBuild(this.design.build);
      this.post({
        type: 'analyzer.data', config: type, elf: path.relative(this.root, elf).split(path.sep).join('/'), builtAt: st.mtimeMs,
        regions: usage, sections: A.sectionList(parsed.sections, regions), symbols, files: A.fileList(map.inputs, regions),
        map: map.regions.length > 0, stack: A.stackFromDir(path.dirname(elf)), stackUsage: b.stackUsage, compiler: b.toolchain.compiler,
        diff: A.diffSnapshots(h.previous, h.current)
      });
    } catch (e) {
      this.post({ type: 'analyzer.data', config: type, error: e.message });
    }
  }

  /** Sembolün kaynağı: fonksiyon için addr2line, değişken için nm -l (ELF değişene kadar önbellekli) */
  async analyzerSource(m) {
    if (m.file && m.line) return this.openSource(path.isAbsolute(m.file) ? m.file : path.join(this.root, m.file), m.line);
    const { elf } = this.analyzerElf(m.config);
    let loc = null;
    if (m.kind === 'func') [loc] = await fault.addr2line(elf, [m.addr], cm.gccTool(this.design.build, 'addr2line'));
    else {
      const key = `${elf}:${fs.existsSync(elf) ? fs.statSync(elf).mtimeMs : 0}`;
      if (!this._nmLines || this._nmLines.key !== key) {
        const out = await new Promise((resolve) => require('child_process').execFile(cm.gccTool(this.design.build, 'nm'), ['-l', '--defined-only', elf], { windowsHide: true, maxBuffer: 1 << 26 }, (e, o) => resolve(e ? '' : o)));
        const map = new Map();
        for (const line of out.split(/\r?\n/)) {
          const x = /^[0-9a-f]+ \w (\S+)\t(.+):(\d+)$/.exec(line);
          if (x && !map.has(x[1])) map.set(x[1], { file: x[2], line: Number(x[3]) });
        }
        this._nmLines = { key, map };
      }
      loc = this._nmLines.map.get(m.name) || null;
    }
    if (!loc || !loc.file || !loc.line) return this.toast('info', t('{0} için kaynak satırı yok (kütüphaneden ya da debug bilgisi olmadan derlenmiş).', m.name));
    await this.openSource(path.isAbsolute(loc.file) ? loc.file : path.join(this.root, loc.file), loc.line);
  }

  /** Konsol çıktısını dosyaya kaydet */
  async saveConsole(text, name) {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.root || require('os').homedir(), `${name || 'console'}.log`)),
      filters: { [t('Günlük')]: ['log', 'txt'] }
    });
    if (!uri) return;
    fs.writeFileSync(uri.fsPath, String(text || ''));
    this.toast('info', t('Kaydedildi: {0}', path.basename(uri.fsPath)));
  }

  /** Kaynak dosyada satıra git */
  async openSource(file, line) {
    try {
      if (!file || !fs.existsSync(file)) throw new Error(t('Kaynak dosya bulunamadı: {0}', file || '?'));
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      await vscode.window.showTextDocument(doc, { selection: new vscode.Range(pos, pos), preview: false, viewColumn: vscode.ViewColumn.One });
    } catch (e) {
      this.toast('error', e.message);
    }
  }

  async debugSymbols() {
    const elf = this.root && path.join(this.root, cm.elfRel(this.design));
    try {
      const syms = await elfSymbols(elf || '', cm.gccTool(this.design.build, 'nm'));
      this.post({ type: 'debug.symbols', symbols: syms, source: path.relative(this.root, elf), watch: this.debugState().watch || [] });
    } catch (e) {
      // Simülasyonda ELF yoksa zamanla değişen örnek değişkenler göster
      const demo = this.target && this.target.mode === 'sim' ? simSymbols(this.target.model, this.design.instances) : [];
      this.post({ type: 'debug.symbols', symbols: demo, error: e.message, watch: this.debugState().watch || [] });
    }
  }

  async flash() {
    if (this.target && this.target.mode === 'sim') return this.toast('info', t('Simülasyon modunda yükleme yapılmaz. Gerçek kart için "OpenOCD" ile bağlanın.'));
    // Debug sekmesinde OpenOCD oturumu yoksa ortak eylem: derle, yükle, çalıştır (durum çubuğundaki Run ile aynı)
    if (!this.target) return actions.run();
    const elf = this.root && path.join(this.root, cm.elfRel(this.design));
    if (!elf || !fs.existsSync(elf)) return this.toast('warn', t('ELF bulunamadı. Önce Derle.'));
    const go = await vscode.window.showWarningMessage(t('{0} karta yüklensin mi? Karttaki mevcut program silinir.', path.basename(elf)), { modal: true }, t('Yükle'));
    if (go !== t('Yükle')) return;
    if (this.target.mode === 'openocd') {
      try {
        await this.target.program(elf);
        this.toast('info', t('Yükleme tamamlandı, kart yeniden başlatıldı.'));
      } catch (e) {
        this.toast('error', t('Yükleme başarısız: {0}', e.message));
      }
    }
  }

  html() {
    const webview = this.panel.webview;
    const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', f));
    const nonce = [...Array(32)].map(() => Math.random().toString(36)[2]).join('');
    const scripts = ['i18n.js', 'core.js', 'art.js', 'wizard.js', 'design.js', 'creator.js', 'clock.js', 'widgets.js', 'monitor.js', 'terminal.js', 'rtos.js', 'console.js', 'debug.js', 'programmer.js', 'analyzer.js', 'pinout.js', 'settings.js', 'genpreview.js', 'main.js'];
    return `<!doctype html>
<html lang="${i18n.getLanguage()}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media('designer.css')}">
<title>Embedded Studio</title>
</head>
<body>
<div id="app"></div>
<script id="es-i18n" type="application/json">${JSON.stringify({ lang: i18n.getLanguage(), dict: i18n.getDictionary() }).replace(/</g, '\\u003c')}</script>
${scripts.map((s) => `<script nonce="${nonce}" src="${media(s)}"></script>`).join('\n')}
</body>
</html>`;
  }
}

/** Webview'dan gelen taslaktan iç alanları atar, boş alanları temizler. */
function cleanComponent(raw) {
  const c = JSON.parse(JSON.stringify(raw || {}));
  for (const k of ['source', 'file', 'imageFile', 'imageUri']) delete c[k];
  for (const k of ['i2c', 'spi', 'uart', 'pwm']) if (c.interface !== k) delete c[k];
  if (!c.datasheet) delete c.datasheet;
  if (!c.image) delete c.image;
  if (Array.isArray(c.keywords)) c.keywords = c.keywords.map((x) => String(x).trim()).filter(Boolean);
  if (Array.isArray(c.monitor) && !c.monitor.length) delete c.monitor;
  return c;
}

/** URL'yi dosyaya indirir (yönlendirmeleri izler). pdf=true ise içeriğin PDF olduğunu doğrular. */
function download(url, dest, pdf = true, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) return reject(new Error('çok fazla yönlendirme'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Embedded Studio)', Accept: '*/*' }, timeout: 30000 }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).toString(), dest, pdf, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (pdf && buf.subarray(0, 5).toString() !== '%PDF-') return reject(new Error('sunucu PDF yerine web sayfası döndü'));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, buf);
        resolve(undefined);
      });
    });
    req.on('timeout', () => req.destroy(new Error('zaman aşımı')));
    req.on('error', reject);
  });
}

function deactivate() {}

module.exports = { activate, deactivate, migrate, download, packAfterBuild };
