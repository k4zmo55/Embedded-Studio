// @ts-check
/**
 * Alt durum çubuğu (ES-201): Build · Flash · Debug · Run · Terminal ve prob bilgisi.
 * Sadece Embedded Studio projesi açıkken görünür (embedded-studio.json); bağlam anahtarı embeddedStudio.projectOpen.
 */
const vscode = require('vscode');
const { t } = require('./i18n');

class StatusBar {
  /** @param {import('./actions').ProjectActions} actions @param {() => any} getProject */
  constructor(actions, getProject) {
    this.actions = actions;
    this.getProject = getProject;
    const item = (priority, command) => {
      const i = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
      i.command = command;
      return i;
    };
    this.items = {
      build: item(99, 'embeddedStudio.build'),
      flash: item(98, 'embeddedStudio.flash'),
      debug: item(97, 'embeddedStudio.debug'),
      run: item(96, 'embeddedStudio.run'),
      terminal: item(95, 'embeddedStudio.terminal'),
      probe: item(94, 'embeddedStudio.probe')
    };
    this.refresh();
  }

  dispose() {
    Object.values(this.items).forEach((i) => i.dispose());
  }

  /** Görünürlük ve metinler: proje durumu ve son derleme/prob sonucu */
  refresh() {
    const p = this.getProject();
    vscode.commands.executeCommand('setContext', 'embeddedStudio.projectOpen', !!p);
    const all = Object.values(this.items);
    if (!p) {
      all.forEach((i) => i.hide());
      return;
    }
    const s = this.actions.state;
    const busy = (kind) => s.running === kind;
    const mcu = p.lib.mcus[p.design.mcuId];
    const { build, flash, debug, run, terminal, probe } = this.items;

    const counts = s.ok === null ? '' : s.ok && !s.warnings ? ' $(check)' : ` $(error) ${s.errors} $(warning) ${s.warnings}`;
    build.text = `${busy('build') ? '$(sync~spin)' : '$(tools)'} Build${busy('build') ? '' : counts}`;
    build.tooltip = `${t('Derle ({0})', p.design.build.type)} · F7${s.ok === null ? '' : `\n${t('Son derleme: {0} hata, {1} uyarı', s.errors, s.warnings)}`}`;
    build.backgroundColor = s.ok === false ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
    flash.text = `${busy('flash') ? '$(sync~spin)' : '$(zap)'} Flash`;
    flash.tooltip = `${t('Derle ve yükle (hedef durdurulmuş kalır)')} · Shift+F7`;
    debug.text = '$(debug-alt) Debug';
    debug.tooltip = `${t('Derle, yükle ve main\'de dur (Cortex-Debug)')} · F5`;
    run.text = `${busy('run') ? '$(sync~spin)' : '$(play)'} Run`;
    run.tooltip = `${t('Derle, yükle ve debugger olmadan çalıştır')} · Ctrl+F5`;
    terminal.text = '$(terminal) Terminal';
    terminal.tooltip = t('Seri port terminalini aç');

    // Prob: önce USB taraması (tak/çıkar), sorgu yapıldıysa hedef kimliği
    const pr = s.probe;
    const usb = s.probes;
    const debugProbe = usb && usb.find((x) => x.interfaceCfg);
    const volts = pr && pr.voltage ? `${Number(pr.voltage).toFixed(2)} V` : null;
    let warn = false;
    if (busy('probe')) probe.text = `$(sync~spin) ${t('Prob aranıyor…')}`;
    else if (pr && pr.ok && pr.target) {
      warn = pr.match === false;
      probe.text = `${warn ? '$(warning)' : '$(plug)'} ${[pr.probe, `${pr.target.name.split(' /')[0]} rev ${pr.target.rev}`, volts].filter(Boolean).join(' · ')}`;
    } else if (pr && pr.ok) probe.text = `$(plug) ${[pr.probe, pr.core, volts].filter(Boolean).join(' · ')}`;
    else if (usb && !usb.length) probe.text = `$(debug-disconnect) ${t('Prob yok')}`;
    else if (debugProbe && pr && !pr.ok) { warn = true; probe.text = `$(plug) ${debugProbe.label} · ${t('hedef yok')}`; }
    else if (debugProbe) probe.text = `$(plug) ${debugProbe.label}`;
    else if (usb && usb.length) probe.text = `$(plug) ${usb[0].label}`;
    else if (pr) { warn = true; probe.text = `$(debug-disconnect) ${t('Prob yok')}`; }
    else probe.text = `$(plug) ${mcu.name}`;
    const lines = [t('Proje: {0}', mcu.name)];
    if (usb && usb.length) lines.push(...usb.map((x) => `${x.label}${x.serial ? ` · ${x.serial}` : ''}${x.port ? ` · ${x.port}` : ''}`));
    if (pr && pr.target) lines.push(`${pr.target.name} · DEV_ID 0x${pr.target.devId.toString(16).toUpperCase()} · rev ${pr.target.rev}${pr.target.flashKB ? ` · ${pr.target.flashKB} KB` : ''}`);
    if (pr && pr.match === false) lines.push(t('Projedeki işlemciyle uyuşmuyor!'));
    if (pr && !pr.ok && pr.error) lines.push(pr.error);
    lines.push(t('Ayrıntılı rapor için tıklayın.'));
    probe.tooltip = lines.join('\n');
    probe.backgroundColor = warn ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
    all.forEach((i) => i.show());
  }
}

module.exports = { StatusBar };
