// @ts-check
/**
 * Yükleme (ES-203): OpenOCD ya da STM32_Programmer_CLI'yi doğrudan çalıştırır; ilerleme bildirimi (iptal edilebilir),
 * "Embedded Studio: Yükleme" çıktı panelinde kullanılan komut ve tam çıktı, sonunda süre ve hız.
 */
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { buildFlashCommand, parseProgress, parseStats, flashSucceeded, explainFlashError } = require('./debug/flashcmd');
const { t } = require('./i18n');

let channel = null;
const output = () => (channel = channel || vscode.window.createOutputChannel('Embedded Studio: Yükleme'));

const STAGE = () => ({ connect: t('Bağlanılıyor'), erase: t('Siliniyor'), program: t('Yazılıyor'), verify: t('Doğrulanıyor'), reset: t('Yeniden başlatılıyor') });

/** Ayarlardan yükleme seçenekleri (komut ya da çağıran geçersiz kılabilir) */
function flashSettings() {
  const c = vscode.workspace.getConfiguration?.('embeddedStudio');
  const get = (k, d) => (c ? c.get(k, d) : d);
  return {
    tool: get('flash.tool', 'auto'), erase: get('flash.erase', 'sector'), verify: get('flash.verify', true),
    underReset: get('flash.connectUnderReset', false), speedKHz: get('flash.speedKHz', 0)
  };
}

/**
 * @param {import('./debug/flashcmd').FlashOptions} opts
 * @returns {Promise<{ ok: boolean, ms: number, bytes?: number, kibps?: number, error?: string, cancelled?: boolean, display: string }>}
 */
function runFlash(opts) {
  const cmd = buildFlashCommand(opts);
  const out = output();
  out.show(true);
  out.appendLine('');
  out.appendLine(`[${new Date().toLocaleTimeString()}] ${t('Yükleniyor: {0}', opts.file)}`);
  out.appendLine(`> ${cmd.display}`);
  const started = Date.now();
  return Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: t('Yükleniyor: {0}', path.basename(opts.file)), cancellable: true }, (progress, token) => new Promise((resolve) => {
    let log = '', buf = '', shown = 0, cancelled = false;
    const report = (p) => {
      if (!p || p.percent <= shown) return;
      progress.report({ increment: p.percent - shown, message: STAGE()[p.stage] || p.stage });
      shown = p.percent;
    };
    let proc;
    try {
      proc = spawn(cmd.file, cmd.args, { windowsHide: true, cwd: path.dirname(opts.file) });
    } catch (e) {
      return resolve({ ok: false, ms: 0, error: String(e.message), display: cmd.display });
    }
    const onText = (d) => {
      const s = String(d);
      log += s;
      out.append(s);
      buf += s;
      const lines = buf.split(/\r?\n|\r/);
      buf = lines.pop() || '';
      for (const l of [...lines, buf]) report(parseProgress(opts.tool, l));
    };
    proc.stdout.on('data', onText);
    proc.stderr.on('data', onText);
    token.onCancellationRequested(() => {
      cancelled = true;
      try { proc.kill(); } catch { /* kapandı */ }
    });
    proc.on('error', (e) => resolve({ ok: false, ms: Date.now() - started, error: t('{0} başlatılamadı ({1}). Kurulu ve PATH\'te mi?', cmd.file, e.message), display: cmd.display }));
    proc.on('exit', (code) => {
      const ms = Date.now() - started;
      if (cancelled) return resolve({ ok: false, ms, cancelled: true, error: t('Yükleme iptal edildi.'), display: cmd.display });
      const ok = flashSucceeded(opts.tool, log, code ?? 1, opts.verify !== false);
      const st = parseStats(opts.tool, log) || {};
      let bytes = st.bytes;
      if (!bytes) try { bytes = fs.statSync(opts.file).size; } catch { /* dosya yok */ }
      const kibps = st.kibps || (bytes && ms ? bytes / 1024 / (st.seconds || ms / 1000) : undefined);
      resolve({ ok, ms, bytes, kibps, display: cmd.display, error: ok ? undefined : explainFlashError(log) || t('Yükleme başarısız (çıkış kodu {0}). Ayrıntı "Embedded Studio: Yükleme" panelinde.', code) });
    });
  })));
}

/** Sonuç bildirimi metni */
function resultText(r, opts) {
  if (!r.ok) return r.error;
  const kb = r.bytes ? (r.bytes / 1024).toFixed(1) : '?';
  return t('Yüklendi: {0} · {1} KB · {2} sn · {3} KB/s', path.basename(opts.file), kb, (r.ms / 1000).toFixed(1), r.kibps ? r.kibps.toFixed(1) : '?')
    + (opts.verify !== false ? ` · ${t('doğrulandı')}` : '') + ` · ${opts.reset ? t('çalışıyor') : t('hedef durduruldu')}`;
}

module.exports = { runFlash, flashSettings, resultText, output };
