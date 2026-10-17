// @ts-check
/**
 * Proje eylemleri (ES-201): Derle, Yükle, Çalıştır, Debug ve prob bilgisi. Tasarımcı paneli açık olmasa da çalışır;
 * durum çubuğu butonları, komut paleti, kısayollar ve tasarımcıdaki Derle/Yükle düğmeleri aynı kodu kullanır.
 *
 *  build : CMake + Ninja görevi; bitince gcc hata/uyarı sayısı (problem matcher tanılamaları) ve boyut özeti
 *  flash : derle, sonra OpenOCD ile yükle + doğrula; hedef durdurulmuş kalır
 *  run   : derle, yükle ve çalıştır (reset), debugger olmadan
 *  debug : derle, Cortex-Debug ile başlat, main'de dur (launch.json üretimi, breakpoint sınırı, reset, disassembly: ES-204)
 *  probe : OpenOCD ile bir kez bağlanıp prob/hedef bilgisini oku (sürekli algılama ES-202)
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cm = require('./codegen/build');
const { syncCodeIntel } = require('./codegen/merge');
const { elfSize } = require('./toolchain');
const { parseProbe } = require('./debug/probe');
const { runFlash, flashSettings, resultText } = require('./flasher');
const { detectTools } = require('./debug/tools');
const { classify, listUsb } = require('./debug/usb');
const { readCommands, decodeTarget, matchesProject } = require('./debug/stm32id');
const { cortexConfig, launchConfigs, mergeJsonList, buildTask, buildTaskLabel, breakpointUsage, disassemblyArgs, SERVERS } = require('./debug/launch');
const { familyOf } = require('./codegen/families');
const { computeClock } = require('./engine/clock');
const { t } = require('./i18n');

const SOURCE = 'Embedded Studio';
const CORTEX_DEBUG = 'marus25.cortex-debug';

/** Windows'ta varsayılan kabuk PowerShell 5 olabilir; && için cmd.exe */
const shellOpts = () => (process.platform === 'win32' ? { executable: 'cmd.exe', shellArgs: ['/d', '/c'] } : {});

class ProjectActions {
  /**
   * @param {() => ({ root: string, design: any, lib: any } | null)} getProject
   * @param {{ onState?: (s: any) => void, onSize?: (s: any) => void, onTask?: (name: string, ok: boolean | null) => void, toast?: (level: string, text: string) => void }} [hooks]
   */
  constructor(getProject, hooks = {}) {
    this.getProject = getProject;
    this.hooks = hooks;
    /** @type {{ running: string | null, errors: number, warnings: number, ok: boolean | null, probe: any, probes: any[] | null }} */
    this.state = { running: null, errors: 0, warnings: 0, ok: null, probe: null, probes: null };
    /** @type {Map<any, (code: number) => void>} */
    this.waiting = new Map();
    this.disposables = [vscode.tasks.onDidEndTaskProcess((e) => {
      const done = this.waiting.get(e.execution);
      if (done) {
        this.waiting.delete(e.execution);
        done(e.exitCode ?? 1);
      }
    })];
  }

  dispose() {
    this.disposables.forEach((d) => d.dispose());
  }

  set(patch) {
    Object.assign(this.state, patch);
    this.hooks.onState?.(this.state);
  }

  info(level, text) {
    if (this.hooks.toast) this.hooks.toast(level, text);
    else if (level === 'error') vscode.window.showErrorMessage(text);
    else if (level === 'warn') vscode.window.showWarningMessage(text);
    else vscode.window.showInformationMessage(text);
  }

  /** Proje hazır mı (açık klasör, tasarım, üretilmiş CMake) */
  project() {
    const p = this.getProject();
    if (!p) {
      this.info('error', t('Önce bir Embedded Studio projesi açın.'));
      return null;
    }
    if (!fs.existsSync(path.join(p.root, 'CMakeLists.txt'))) {
      this.info('warn', t('Önce "Kod Üret" ile projeyi oluşturun.'));
      return null;
    }
    return p;
  }

  /** Görevi çalıştırır, bitince çıkış kodunu döndürür. */
  async runTask(p, kind, name, cmd) {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const task = new vscode.Task({ type: 'embedded-studio', kind, config: p.design.build.type }, folder || vscode.TaskScope.Workspace,
      name, SOURCE, new vscode.ShellExecution(cmd, { cwd: p.root, ...shellOpts() }), ['$gcc']);
    task.presentationOptions = { reveal: vscode.TaskRevealKind.Always, clear: true };
    const execution = await vscode.tasks.executeTask(task);
    this.hooks.onTask?.(name, null);
    const code = await new Promise((resolve) => this.waiting.set(execution, resolve));
    this.hooks.onTask?.(name, code === 0);
    return code;
  }

  /** gcc problem matcher'ın bu projede bulduğu hata/uyarı sayısı */
  countDiagnostics(root) {
    let errors = 0, warnings = 0;
    for (const [uri, list] of vscode.languages.getDiagnostics()) {
      if (!uri.fsPath || !path.resolve(uri.fsPath).startsWith(path.resolve(root))) continue;
      for (const d of list) {
        if (d.source !== 'gcc') continue;
        if (d.severity === vscode.DiagnosticSeverity.Error) errors++;
        else if (d.severity === vscode.DiagnosticSeverity.Warning) warnings++;
      }
    }
    return { errors, warnings };
  }

  /** Derle. Dönüş: başarılı mı */
  async build(opts = {}) {
    const p = this.project();
    if (!p || this.state.running) return false;
    const config = p.design.build.type;
    syncCodeIntel(p.root, config, p.design.framework === 'hal' ? `${familyOf(p.lib.mcus[p.design.mcuId]).prefix}_hal_def.h` : undefined);
    this.set({ running: 'build' });
    const code = await this.runTask(p, 'build', t('Derle ({0})', config), cm.buildCommand(config));
    await new Promise((r) => setTimeout(r, 300)); // problem matcher tanılamaları görev bitişinden hemen sonra gelir
    const { errors, warnings } = this.countDiagnostics(p.root);
    const ok = code === 0;
    this.set({ running: null, ok, errors, warnings });
    if (!ok) this.info('error', t('Derleme başarısız: {0} hata, {1} uyarı. Ayrıntı Terminal ve Sorunlar panelinde.', errors, warnings));
    else if (!opts.quiet) await this.reportSize(p, config);
    return ok;
  }

  /** Derleme sonrası boyut özeti: flash/RAM kullanımı ve çıktı dosyaları (.elf, .hex, .bin, .map). */
  async reportSize(p, config) {
    const design = { ...p.design, build: { ...p.design.build, type: config || p.design.build.type } };
    const elf = path.join(p.root, cm.elfRel(design));
    const size = await elfSize(cm.gccTool(design.build, 'size'), elf);
    if (!size) return null;
    const dev = p.lib.mcus[design.mcuId].device;
    const kb = (n) => (n / 1024).toFixed(1);
    const pct = (n, totalKB) => ((n * 100) / (totalKB * 1024)).toFixed(1);
    const dir = path.dirname(elf);
    const base = path.basename(elf, '.elf');
    const outputs = ['.elf', '.hex', '.bin', '.map'].filter((x) => fs.existsSync(path.join(dir, base + x)));
    const summary = { config: design.build.type, ...size, flashKB: dev.flashKB, ramKB: dev.ramKB, dir: path.relative(p.root, dir).split(path.sep).join('/'), outputs };
    this.hooks.onSize?.(summary);
    const msg = t('Derlendi ({0}): Flash {1} KB / {2} KB (%{3}) · RAM {4} KB / {5} KB (%{6}) · {7}',
      summary.config, kb(size.flash), dev.flashKB, pct(size.flash, dev.flashKB), kb(size.ram), dev.ramKB, pct(size.ram, dev.ramKB), `${summary.dir}/${base}{${outputs.join(',')}}`);
    const warn = this.state.warnings ? ` · ${t('{0} uyarı', this.state.warnings)}` : '';
    const open = outputs.includes('.map') ? t('Map dosyasını aç') : undefined;
    vscode.window.showInformationMessage(msg + warn, ...(open ? [open] : [])).then((choice) => {
      if (choice && choice === open) vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, base + '.map')));
    });
    return summary;
  }

  /** Yükleme onayı (embeddedStudio.flash.confirm) */
  async confirm(p, elf) {
    const ask = vscode.workspace.getConfiguration?.('embeddedStudio').get('flash.confirm', false);
    if (!ask) return true;
    const go = await vscode.window.showWarningMessage(t('{0} karta yüklensin mi? Karttaki mevcut program silinir.', path.basename(elf)), { modal: true }, t('Yükle'));
    return go === t('Yükle');
  }

  /**
   * Yükleme seçenekleri: araç (OpenOCD / STM32_Programmer_CLI), prob (USB taramasından), aile ve hedef yapılandırması.
   * @param {any} p proje @param {string} file @param {{ reset?: boolean, erase?: string, verify?: boolean, underReset?: boolean, address?: number }} over
   */
  async flashOptions(p, file, over = {}) {
    const mcu = p.lib.mcus[p.design.mcuId];
    const set = flashSettings();
    const probes = this.state.probes || (await this.scanUsb().catch(() => []));
    const probe = probes.find((x) => x.interfaceCfg) || probes.find((x) => x.kind === 'dfu' || x.kind === 'uart');
    // DFU ve UART önyükleyicisi sadece CubeProgrammer ile; SWD problarında ayar (auto: OpenOCD)
    let tool = set.tool === 'cubeprog' || (probe && !probe.interfaceCfg) ? 'cubeprog' : 'openocd';
    let toolPath;
    if (tool === 'cubeprog') {
      const tools = this.tools || (this.tools = await detectTools().catch(() => []));
      const cp = tools.find((x) => x.id === 'cubeprog' && x.found);
      if (cp) toolPath = cp.path;
      else if (probe && !probe.interfaceCfg) throw new Error(t('{0} ile yüklemek için STM32CubeProgrammer gerekir: {1}', probe.label, 'https://www.st.com/en/development-tools/stm32cubeprog.html'));
      else tool = 'openocd';
    }
    return {
      tool, toolPath, file, family: mcu.device.family || 'f4', targetCfg: mcu.device.openocdTarget,
      probe, multipleProbes: probes.filter((x) => probe && x.kind === probe.kind).length > 1,
      erase: over.erase || set.erase, verify: over.verify ?? set.verify, reset: !!over.reset,
      underReset: over.underReset ?? set.underReset, speedKHz: set.speedKHz || undefined, address: over.address
    };
  }

  /** Bir dosyayı yükle (proje derlenmeden). Dönüş: başarılı mı */
  async flashFileAt(p, file, over = {}) {
    let opts;
    try {
      opts = await this.flashOptions(p, file, over);
    } catch (e) {
      this.info('error', e.message);
      return false;
    }
    this.set({ running: over.reset ? 'run' : 'flash' });
    const r = await runFlash(opts);
    this.set({ running: null, lastFlash: { ...r, file } });
    this.info(r.ok ? 'info' : r.cancelled ? 'warn' : 'error', resultText(r, opts));
    return r.ok;
  }

  /** Derle + yükle. run: yükledikten sonra çalıştır (reset), değilse hedef durdurulmuş kalır. */
  async flash(opts = { run: false }) {
    const p = this.project();
    if (!p || this.state.running) return false;
    if (!(await this.build({ quiet: true }))) return false;
    const elf = path.join(p.root, cm.elfRel(p.design));
    if (!(await this.confirm(p, elf))) return false;
    return this.flashFileAt(p, elf, { reset: !!opts.run });
  }

  run() {
    return this.flash({ run: true });
  }

  /** Debug yapılandırması girdileri: algılanan prob, seçilen GDB sunucusu, SVD, araç zinciri, RTOS */
  debugInputs(p, opts = {}) {
    const mcu = p.lib.mcus[p.design.mcuId];
    const svd = path.join(p.root, '.embedded-studio', `${mcu.name}.svd`);
    const probes = this.state.probes || [];
    const probe = probes.find((x) => x.interfaceCfg);
    const multiple = probe && probes.filter((x) => x.kind === probe.kind).length > 1;
    let server = opts.server || vscode.workspace.getConfiguration?.('embeddedStudio').get('debug.server', 'auto') || 'auto';
    // auto: J-Link probunda J-Link GDB sunucusu da olur ama OpenOCD her üç prob türünde çalışır
    if (server === 'auto') server = 'openocd';
    const elf = path.join(p.root, cm.elfRel(p.design));
    const rel = opts.relative ? (f) => '${workspaceFolder}/' + path.relative(p.root, f).replace(/\\/g, '/') : (f) => f;
    return {
      project: p.design.project.name, server, cwd: opts.relative ? '${workspaceFolder}' : p.root, elf: rel(elf),
      mcuName: mcu.name, targetCfg: mcu.device.openocdTarget, interfaceCfg: probe?.interfaceCfg,
      serial: multiple ? probe.serial : undefined, svd: fs.existsSync(svd) ? rel(svd) : undefined,
      toolchainPath: p.design.build.toolchain?.gccPath || undefined, rtos: !!p.design.rtos,
      speedKHz: flashSettings().speedKHz || undefined,
      cpuHz: Math.round(computeClock(mcu, p.design.clock).freq.hclk * 1e6), swo: !/cortex-m0/.test(familyOf(mcu).core)
    };
  }

  /** F5 ile başlatılan Cortex-Debug yapılandırması (launch.json'a gerek yok) */
  debugConfig(p) {
    return cortexConfig({ ...this.debugInputs(p), name: `Embedded Studio: ${p.design.project.name}` });
  }

  /** Cortex-Debug kurulu mu; değilse kurmayı önerir */
  async ensureCortexDebug() {
    if (vscode.extensions.getExtension(CORTEX_DEBUG)) return true;
    const install = t('Cortex-Debug\'u kur');
    const c = await vscode.window.showWarningMessage(t('Debug için Cortex-Debug eklentisi gerekli (OpenOCD + GDB ile çalışır).'), install);
    if (c === install) await vscode.commands.executeCommand('workbench.extensions.installExtension', CORTEX_DEBUG);
    return false;
  }

  async debug() {
    const p = this.project();
    if (!p || this.state.running) return false;
    if (!(await this.ensureCortexDebug())) return false;
    if (!(await this.build({ quiet: true }))) return false;
    // Tasarımcının Debug sekmesindeki OpenOCD oturumu probu tutuyorsa önce kapat (iki OpenOCD aynı probu açamaz)
    await this.hooks.releaseProbe?.();
    return vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], this.debugConfig(p));
  }

  /**
   * ES-204: .vscode/launch.json (Debug, reset'te dur, attach) ve tasks.json (preLaunchTask derleme görevi) üretir.
   * Kullanıcının kendi yapılandırmaları korunur; aynı adlı olanlar güncellenir.
   */
  async writeLaunchJson(server) {
    const p = this.project();
    if (!p) return false;
    // VS Code launch.json'u çalışma alanı klasöründen okur; proje kökü o klasörse yollar ${workspaceFolder} ile yazılır
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const same = !!ws && path.resolve(ws) === path.resolve(p.root);
    const dir = path.join(ws || p.root, '.vscode');
    const type = cm.normalizeBuild(p.design.build).type;
    const taskLabel = buildTaskLabel(type);
    const inputs = this.debugInputs(p, { server, relative: same });
    const files = [
      ['launch.json', 'configurations', launchConfigs({ ...inputs, preLaunchTask: taskLabel }), '0.2.0', {}],
      // Kod üreticinin yazdığı aynı adlı derleme görevi varsa korunur
      ['tasks.json', 'tasks', [buildTask(taskLabel, cm.buildCommand(type), same ? undefined : p.root)], '2.0.0', { keep: true }]
    ];
    const out = [];
    for (const [name, key, items, version, opt] of files) {
      const f = path.join(dir, name);
      const cur = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
      const merged = mergeJsonList(cur, key, items, version, opt);
      if (!merged) {
        this.info('error', t('{0} okunamadı (JSON hatası). Dosyayı düzeltin ya da silin; üzerine yazılmadı.', path.join('.vscode', name)));
        return false;
      }
      out.push([f, merged]);
    }
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, m] of out) fs.writeFileSync(f, m.text);
    const doc = await vscode.workspace.openTextDocument(out[0][0]);
    await vscode.window.showTextDocument(doc);
    this.info('info', t('launch.json hazır: {0} yapılandırma ({1}). Çalıştır ve Debug görünümünden seçip F5 ile başlatın.', 3, SERVERS[inputs.server].label));
    await this.ensureCortexDebug();
    return true;
  }

  /** Breakpoint sayısı donanım sınırını aşarsa bir kez uyar (VS Code breakpoint'leri değişince çağrılır) */
  checkBreakpoints(bps) {
    const p = this.getProject();
    if (!p) return null;
    const mcu = p.lib.mcus[p.design.mcuId];
    const core = familyOf(mcu).core;
    const u = breakpointUsage(bps, core);
    const key = u.level === 'ok' ? '' : `${u.level}:${u.used}`;
    if (key && key !== this.lastBpWarning) {
      this.info('warn', u.level === 'over'
        ? t('{0} etkin breakpoint var, {1} çekirdeğinde sadece {2} donanım breakpoint\'i bulunur. Flash\'taki koda fazlası konamaz; bazı breakpoint\'leri kapatın.', u.used, core, u.limit)
        : t('Donanım breakpoint\'lerinin hepsi kullanımda ({0}/{1}). Adım adım çalıştırma ve "Run to Cursor" geçici olarak bir tane daha ister; birini kapatın.', u.used, u.limit));
    }
    this.lastBpWarning = key;
    return u;
  }

  /** Debug oturumunda hedefi resetle. Cortex-Debug: "reset'te dur" yapılandırmasında Reset_Handler'da, değilse main'de durur. */
  async debugReset() {
    const s = vscode.debug.activeDebugSession;
    if (!s || s.type !== 'cortex-debug') {
      this.info('warn', t('Etkin bir Cortex-Debug oturumu yok. Önce Debug (F5) ile başlatın.'));
      return false;
    }
    await s.customRequest('reset-device', 'reset');
    return true;
  }

  /** ES-204: kaynakla karışık disassembly listesi (arm-none-eabi-objdump -d -S), build/<tip>/<ad>.lst */
  async disassembly() {
    const p = this.project();
    if (!p) return null;
    const elf = path.join(p.root, cm.elfRel(p.design));
    if (!fs.existsSync(elf) && !(await this.build({ quiet: true }))) return null;
    const lst = elf.replace(/\.elf$/, '.lst');
    const objdump = cm.gccTool(p.design.build, 'objdump');
    const text = await new Promise((resolve) => {
      let o = '', e = '';
      const proc = spawn(objdump, disassemblyArgs(elf), { cwd: p.root, windowsHide: true });
      proc.stdout.on('data', (d) => (o += d));
      proc.stderr.on('data', (d) => (e += d));
      proc.on('error', (x) => resolve({ error: x.message }));
      proc.on('exit', (code) => resolve(code === 0 ? { text: o } : { error: e.trim() || String(code) }));
    });
    if (text.error) {
      this.info('error', t('{0} çalıştırılamadı: {1}', path.basename(objdump), text.error));
      return null;
    }
    fs.writeFileSync(lst, text.text);
    const doc = await vscode.workspace.openTextDocument(lst);
    await vscode.window.showTextDocument(doc, { preview: false });
    return lst;
  }

  /** USB'deki problar (sorgu yapmadan; tak/çıkar izleyicisi çağırır) */
  async scanUsb() {
    const probes = classify(await listUsb());
    this.set({ probes });
    return probes;
  }

  /**
   * Prob ve hedef bilgisi (ES-202): USB'de prob aranır, ilk debug probuyla (ST-Link / J-Link / CMSIS-DAP) OpenOCD tek oturumda
   * bağlanıp prob firmware'i, hedef voltajı, çekirdek ve DBGMCU_IDCODE / flash boyutu / UID / RDP okunur.
   * @returns {Promise<any>}
   */
  async probe() {
    const p = this.getProject();
    const mcu = p ? p.lib.mcus[p.design.mcuId] : null;
    this.set({ running: 'probe' });
    const probes = await this.scanUsb().catch(() => []);
    const dbg = probes.find((x) => x.interfaceCfg);
    const finishWith = (r) => {
      const res = { probes, ...r };
      if (res.target && mcu) res.match = matchesProject(res.target, mcu);
      this.set({ running: null, probe: res });
      return res;
    };
    if (!dbg) {
      const other = probes.find((x) => x.kind === 'dfu' || x.kind === 'uart');
      return finishWith({ ok: false, error: other ? t('Debug probu yok; {0} bulundu.', other.label) : t('Bağlı prob yok. ST-Link\'i takın (Nucleo/Discovery kartlarında dahili).') });
    }
    const target = mcu ? mcu.device.openocdTarget : 'target/stm32f4x.cfg';
    const sameKind = probes.filter((x) => x.kind === dbg.kind).length;
    const args = ['-f', dbg.interfaceCfg, ...(sameKind > 1 && dbg.serial ? ['-c', `adapter serial ${dbg.serial}`] : []), '-f', target,
      '-c', 'init', '-c', 'targets', ...readCommands().flatMap((c) => ['-c', c]), '-c', 'shutdown'];
    const log = await new Promise((resolve) => {
      let out = '';
      let proc;
      const timer = setTimeout(() => { try { proc && proc.kill(); } catch { /* kapandı */ } resolve(out + '\n' + t('openocd 15 sn içinde yanıt vermedi.')); }, 15000);
      try {
        proc = spawn('openocd', args, { windowsHide: true });
      } catch (e) {
        clearTimeout(timer);
        return resolve(String(e.message));
      }
      const onText = (d) => { out += String(d); };
      proc.stdout.on('data', onText);
      proc.stderr.on('data', onText);
      proc.on('error', (e) => { clearTimeout(timer); resolve(out + '\n' + t('openocd başlatılamadı ({0}). OpenOCD kurulu ve PATH\'te mi?', e.message)); });
      proc.on('exit', () => { clearTimeout(timer); resolve(out); });
    });
    const base = parseProbe(log);
    return finishWith({ ...base, probe: dbg.label, serial: dbg.serial, port: dbg.port, target: base.ok ? decodeTarget(log) : null });
  }
}

module.exports = { ProjectActions };
