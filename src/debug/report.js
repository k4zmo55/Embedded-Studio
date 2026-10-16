// @ts-check
/** Prob ve kart raporu (Markdown): bağlı problar, hedef kimliği, araçlar (ES-202). vscode'a bağlı değil. */
const { t } = require('../i18n');
const { hex } = require('./stm32id');

const RDP_TEXT = () => ({
  0: t('Seviye 0: koruma yok'),
  0.5: t('Seviye 0.5: TrustZone güvenli bölge korumalı'),
  1: t('Seviye 1: flash debug ile okunamaz (seviye 0\'a dönmek flash\'ı siler)'),
  2: t('Seviye 2: kalıcı koruma, debug kapalı')
});
const KIND = () => ({ stlink: 'ST-Link', jlink: 'J-Link', 'cmsis-dap': 'CMSIS-DAP', dfu: 'USB DFU', uart: 'UART' });

/**
 * @param {{ result: any, tools?: any[], mcu?: any }} o
 */
function probeReport({ result, tools = [], mcu }) {
  const r = result || {};
  const L = [`# ${t('Prob ve kart')}`, ''];
  if (mcu) L.push(t('Proje: **{0}** ({1})', mcu.name, mcu.board), '');

  L.push(`## ${t('Bağlı problar')}`, '');
  const probes = r.probes || [];
  if (!probes.length) L.push(t('USB\'de prob bulunamadı (ST-Link, J-Link, CMSIS-DAP, DFU, UART köprüsü).'), '');
  else {
    L.push(`| ${t('Tür')} | ${t('Ad')} | ${t('Seri numarası')} | ${t('Seri port')} |`, '|---|---|---|---|');
    for (const p of probes) L.push(`| ${KIND()[p.kind] || p.kind} | ${p.label} | ${p.serial ? `\`${p.serial}\`` : '—'} | ${p.port || '—'} |`);
    L.push('');
    if (probes.some((p) => p.kind === 'dfu')) L.push(`> ${t('USB DFU önyükleyicisi algılandı (BOOT0 = 1). Yüklemek için STM32CubeProgrammer gerekir.')}`, '');
    if (probes.some((p) => p.kind === 'uart')) L.push(`> ${t('UART köprüsü: kart BOOT0 = 1 ile açılırsa seri önyükleyiciyle yüklenebilir (STM32CubeProgrammer).')}`, '');
  }

  L.push(`## ${t('Hedef')}`, '');
  if (r.target) {
    const g = r.target;
    const rows = [
      [t('Cihaz'), `${g.name}`],
      [t('Kimlik'), `DEV_ID ${hex(g.devId, 3)} · REV ${g.rev} · IDCODE ${hex(g.idcode)}`],
      [t('Flash'), g.flashKB ? `${g.flashKB} KB` : '—'],
      ['UID (96 bit)', g.uid ? `\`${g.uid}\`` : '—'],
      [t('Okuma koruması (RDP)'), g.rdp === undefined ? '—' : RDP_TEXT()[g.rdp] || String(g.rdp)],
      [t('Çekirdek'), r.core || '—'],
      [t('Hedef voltajı'), r.voltage ? `${Number(r.voltage).toFixed(2)} V` : '—'],
      [t('Prob firmware'), r.firmware || '—']
    ];
    if (mcu) rows.push([t('Projeyle uyum'), r.match === false ? `⚠ ${t('Projedeki işlemci {0}; bağlı cihaz {1}.', mcu.name, g.name)}` : `✓ ${mcu.name}`]);
    L.push(`| | |`, '|---|---|', ...rows.map(([k, v]) => `| ${k} | ${v} |`), '');
  } else if (r.ok) {
    L.push(t('Hedefe bağlanıldı ama cihaz kimliği okunamadı (bilinmeyen DEV_ID ya da erişim hatası).'), '');
  } else {
    L.push(r.error ? `> ${r.error}` : t('Sorgulanmadı.'), '');
  }

  if (tools.length) {
    L.push(`## ${t('Araçlar')}`, '', `| ${t('Araç')} | ${t('Durum')} | ${t('Sürüm / yol')} | ${t('Kurulum')} |`, '|---|---|---|---|');
    for (const tl of tools) {
      L.push(`| ${tl.name} | ${tl.found ? '✓' : tl.required ? `⚠ ${t('gerekli, yok')}` : t('yok')} | ${tl.found ? `${tl.version || ''} \`${tl.path}\``.trim() : '—'} | ${tl.found ? '' : `[${t('indir')}](${tl.install}) · ${tl.hint}`} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

module.exports = { probeReport };
