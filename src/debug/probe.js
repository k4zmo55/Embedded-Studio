// @ts-check
/** OpenOCD komutları ve çıktı ayrıştırma (vscode'a bağlı değil; birim testlerinde kullanılır). */
const { explainOpenOcd } = require('./session');
const { t } = require('../i18n');

/** openocd -f interface/stlink.cfg -f <hedef> -c "…" … */
const openocdCmd = (mcu, commands) => `openocd -f interface/stlink.cfg -f ${mcu.device.openocdTarget} ${commands.map((c) => `-c "${c}"`).join(' ')}`;

/**
 * "init; targets; shutdown" çıktısından prob ve hedef bilgisi.
 * @returns {{ ok: boolean, probe?: string, firmware?: string, voltage?: string, core?: string, error?: string, log: string }}
 */
function parseProbe(log) {
  const pick = (re) => (log.match(re) || [])[1];
  const firmware = pick(/STLINK (V\w+)/i);
  const r = {
    ok: /processor detected|Examination succeed/i.test(log),
    probe: /ST-?LINK/i.test(log) ? `ST-Link${firmware ? ` ${firmware.replace(/J\d+.*$/i, '')}` : ''}` : undefined,
    firmware,
    voltage: pick(/Target voltage: ([\d.]+)/i),
    core: pick(/(Cortex-M\d+\+?) r\dp\d processor detected/i),
    log
  };
  if (!r.ok) r.error = explainOpenOcd(log) || t('Hedef bulunamadı. Kart besleniyor ve SWD kabloları bağlı mı?');
  return r;
}

module.exports = { openocdCmd, parseProbe };
