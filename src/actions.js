// @ts-check
/**
 * Proje eylemleri (ES-201): Derle, Yükle, Çalıştır, Debug ve prob bilgisi. Tasarımcı paneli açık olmasa da çalışır;
 * durum çubuğu butonları, komut paleti, kısayollar ve tasarımcıdaki Derle/Yükle düğmeleri aynı kodu kullanır.
 *
 *  build : CMake + Ninja görevi; bitince gcc hata/uyarı sayısı (problem matcher tanılamaları) ve boyut özeti
 *  flash : derle, sonra OpenOCD ile yükle + doğrula; hedef durdurulmuş kalır
 *  run   : derle, yükle ve çalıştır (reset), debugger olmadan
 *  debug : derle, Cortex-Debug ile başlat, main'de dur
 *  probe : OpenOCD ile bir kez bağlanıp prob/hedef bilgisini oku (sürekli algılama ES-202)
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const cm = require('./codegen/build');
const { elfSize } = require('./toolchain');
const { openocdCmd, parseProbe } = require('./debug/probe');
const { classify, listUsb } = require('./debug/usb');
const { readCommands, decodeTarget, matchesProject } = require('./debug/stm32id');
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

  /** Derle + yükle. run: yükledikten sonra çalıştır (reset), değilse hedef durdurulmuş kalır. */
  async flash(opts = { run: false }) {
    const p = this.project();
    if (!p || this.state.running) return false;
    if (!(await this.build({ quiet: true }))) return false;
    const elf = cm.elfRel(p.design);
    if (!(await this.confirm(p, elf))) return false;
    const mcu = p.lib.mcus[p.design.mcuId];
    this.set({ running: opts.run ? 'run' : 'flash' });
    const code = await this.runTask(p, opts.run ? 'run' : 'flash', opts.run ? t('Çalıştır') : t('Yükle'),
      openocdCmd(mcu, [`program ${elf} verify${opts.run ? ' reset' : ''} exit`]));
    this.set({ running: null });
    if (code === 0) this.info('info', opts.run ? t('Yüklendi ve çalışıyor: {0}', path.basename(elf)) : t('Yüklendi ve doğrulandı; hedef durduruldu: {0}', path.basename(elf)));
    else this.info('error', t('Yükleme başarısız. Prob takılı mı? Ayrıntı Terminal\'de.'));
    return code === 0;
  }

  run() {
    return this.flash({ run: true });
  }

  /** Cortex-Debug yapılandırması (launch.json'a gerek yok) */
  debugConfig(p) {
    const mcu = p.lib.mcus[p.design.mcuId];
    const svd = path.join(p.root, '.embedded-studio', `${mcu.name}.svd`);
    return {
      name: `Embedded Studio: ${p.design.project.name}`,
      type: 'cortex-debug',
      request: 'launch',
      servertype: 'openocd',
      cwd: p.root,
      executable: path.join(p.root, cm.elfRel(p.design)),
      configFiles: ['interface/stlink.cfg', mcu.device.openocdTarget],
      runToEntryPoint: 'main',
      ...(fs.existsSync(svd) ? { svdFile: svd } : {}),
      armToolchainPath: p.design.build.toolchain.gccPath || undefined
    };
  }

  async debug() {
    const p = this.project();
    if (!p || this.state.running) return false;
    if (!vscode.extensions.getExtension(CORTEX_DEBUG)) {
      const install = t('Cortex-Debug\'u kur');
      const c = await vscode.window.showWarningMessage(t('Debug için Cortex-Debug eklentisi gerekli (OpenOCD + GDB ile çalışır).'), install);
      if (c === install) await vscode.commands.executeCommand('workbench.extensions.installExtension', CORTEX_DEBUG);
      return false;
    }
    if (!(await this.build({ quiet: true }))) return false;
    return vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], this.debugConfig(p));
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
