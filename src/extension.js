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
const { writeProject, designFingerprint, relocateLayout, relocateFamilyFiles, removeEmptyDirs, upgradeLegacyVscode, STATE_DIR } = require('./codegen/merge');
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

/** @type {ProjectActions} */
let actions;
/** @type {StatusBar} */
let statusBar;
let libCache = null;
const packs = require('./codegen/packs');
const { parseLine, Simulator } = require('./monitor/telemetry');
const { OpenOcdTarget, SimTarget, simModel, elfSymbols } = require('./debug/session');
const { builtinStm32f4, parseSvd } = require('./debug/registers');
const i18n = require('./i18n');
const { t } = i18n;

const DESIGN_FILE = 'embedded-studio.json';
const PREVIEW_SCHEME = 'embedded-studio-preview';

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  applyLanguage();
  Studio.extensionPath = context.extensionPath;
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration?.((e) => {
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
    releaseProbe: () => Studio.current?.releaseProbe()
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
    vscode.commands.registerCommand('embeddedStudio.terminal', async () => (await Studio.show(context)).post({ type: 'tab', tab: 'monitor' })),
    vscode.commands.registerCommand('embeddedStudio.probe', () => probeCommand()),
    vscode.commands.registerCommand('embeddedStudio.flashFile', (uri) => flashFileCommand(uri)),
    vscode.commands.registerCommand('embeddedStudio.debugLaunchJson', () => launchJsonCommand()),
    vscode.commands.registerCommand('embeddedStudio.debugReset', () => actions.debugReset()),
    vscode.commands.registerCommand('embeddedStudio.disassembly', () => actions.disassembly()));

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
  d.build = cm.normalizeBuild(d.build);
  d.regDrivers = Array.isArray(d.regDrivers) ? d.regDrivers.filter((x) => typeof x === 'string') : [];
  if (!lib.mcus[d.mcuId]) d.mcuId = lib.mcus.stm32f411ceu6 ? 'stm32f411ceu6' : Object.keys(lib.mcus)[0];
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
      this.target?.disconnect().catch(() => {});
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
      return [id, { ...m, fpu: fam.fpu, apbCount: fam.apbCount, series: fam.series, regDriverIds }];
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
        this.design = this.loadDesign();
        if (this.design) this.pushState();
        else this.post({ type: 'welcome', ...welcomeInfo(this.context) });
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
      case 'debug.disconnect':
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
      case 'build':
        await actions.build();
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
    this.post({ type: 'debug.regs', peripherals: this.peripheralDefs, used: [...used, ...ports, 'RCC'], source: this.svdName || (this.peripheralDefs.length ? t('Yerleşik STM32F411 tanımları') : t('{0} için register tanımı yok: SVD indirilemedi.', this.lib.mcus[this.design.mcuId].name)) });
  }

  async connectDebug(mode) {
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
        targetCfg: mcu.device.openocdTarget, interfaceCfg: probe?.interfaceCfg,
        serial: probe && probes.filter((x) => x.kind === probe.kind).length > 1 ? probe.serial : undefined,
        speedKHz: vscode.workspace.getConfiguration?.('embeddedStudio').get('flash.speedKHz', 0) || undefined,
        log: (s) => out && out.append(s),
        onExit: (why) => {
          if (this.target !== target) return;
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
    this.post({ type: 'debug.status', connected: true, mode, state: await this.target.state() });
  }

  /** VS Code debug oturumu başlamadan önce: panelin OpenOCD bağlantısı probu bırakır */
  async releaseProbe() {
    if (!this.target || this.target.mode !== 'openocd') return;
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
    if (m.core && state === 'halted') core = await this.target.coreRegisters().catch((e) => ({ error: e.message }));
    this.post({ type: 'debug.data', seq: m.seq, values, errors, core, state });
  }

  async debugSymbols() {
    const elf = this.root && path.join(this.root, cm.elfRel(this.design));
    try {
      const syms = await elfSymbols(elf || '', cm.gccTool(this.design.build, 'nm'));
      this.post({ type: 'debug.symbols', symbols: syms, source: path.relative(this.root, elf) });
    } catch (e) {
      // Simülasyonda ELF yoksa örnek semboller göster
      const demo = this.target && this.target.mode === 'sim'
        ? this.design.instances.map((i, k) => ({ name: i.label.toLowerCase() + '_ok', addr: 0x20000100 + k * 4, size: 1 })).concat([{ name: 'uwTick', addr: 0x20000080, size: 4 }])
        : [];
      this.post({ type: 'debug.symbols', symbols: demo, error: e.message });
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
    const scripts = ['i18n.js', 'core.js', 'art.js', 'wizard.js', 'design.js', 'creator.js', 'clock.js', 'widgets.js', 'monitor.js', 'debug.js', 'settings.js', 'genpreview.js', 'main.js'];
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

module.exports = { activate, deactivate, migrate, download };
