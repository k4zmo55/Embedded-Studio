// @ts-check
/**
 * Tek tuşla flash (ES-203): yükleme komutunun kurulması, ilerleme/istatistik ayrıştırma ve hata açıklamaları.
 * vscode'a bağlı değildir (birim testli). Çalıştırma src/flasher.js'de.
 *
 * Araçlar:
 *  openocd  : SWD probları (ST-Link, J-Link, CMSIS-DAP). "program" komutu sadece gereken sektörleri siler.
 *  cubeprog : STM32_Programmer_CLI. ST-Link (SWD), USB DFU ve UART önyükleyicisi.
 */
const { t } = require('../i18n');

/** OpenOCD flash sürücüsü (mass_erase için) aileye göre */
const OCD_DRIVER = { f0: 'stm32f1x', f1: 'stm32f1x', f3: 'stm32f1x', f4: 'stm32f2x', f7: 'stm32f2x', g0: 'stm32l4x', g4: 'stm32l4x', l4: 'stm32l4x', u5: 'stm32l4x', h7: 'stm32h7x' };

const kindOf = (file) => (/\.bin$/i.test(file) ? 'bin' : /\.hex$/i.test(file) ? 'hex' : 'elf');
const fwd = (p) => String(p).replace(/\\/g, '/');
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/**
 * @typedef {{ tool: 'openocd'|'cubeprog', toolPath?: string, file: string, address?: number, family: string, targetCfg: string,
 *   probe?: { kind: string, interfaceCfg?: string, serial?: string, port?: string }, multipleProbes?: boolean,
 *   erase?: 'sector'|'full', verify?: boolean, reset?: boolean, underReset?: boolean, speedKHz?: number }} FlashOptions
 * @returns {{ file: string, args: string[], display: string }}
 */
function buildFlashCommand(o) {
  const kind = kindOf(o.file);
  const address = kind === 'bin' ? (o.address ?? 0x08000000) : undefined;
  const q = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  if (o.tool === 'cubeprog') {
    const p = o.probe || { kind: 'stlink' };
    const conn = p.kind === 'dfu' ? ['port=USB1']
      : p.kind === 'uart' ? [`port=${p.port || 'COM1'}`, 'br=115200']
        : ['port=SWD', ...(o.speedKHz ? [`freq=${o.speedKHz}`] : []), ...(o.underReset ? ['mode=UR', 'reset=HWrst'] : []), ...(o.multipleProbes && p.serial ? [`sn=${p.serial}`] : [])];
    const args = ['-c', ...conn, ...(o.erase === 'full' ? ['-e', 'all'] : []), '-w', o.file, ...(address !== undefined ? [hex(address)] : []),
      ...(o.verify !== false ? ['-v'] : []), ...(o.reset ? ['-rst'] : [])];
    const file = o.toolPath || 'STM32_Programmer_CLI';
    return { file, args, display: [file, ...args].map(q).join(' ') };
  }
  const p = o.probe || { kind: 'stlink', interfaceCfg: 'interface/stlink.cfg' };
  const pre = [];
  if (o.multipleProbes && p.serial) pre.push('-c', `adapter serial ${p.serial}`);
  const post = [];
  if (o.speedKHz) post.push('-c', `adapter speed ${o.speedKHz}`);
  if (o.underReset) post.push('-c', 'reset_config srst_only srst_nogate connect_assert_srst');
  if (o.erase === 'full') {
    const drv = OCD_DRIVER[o.family] || 'stm32f2x';
    post.push('-c', 'init', '-c', 'reset halt', '-c', `${drv} mass_erase 0`);
    if (o.family === 'h7') post.push('-c', `catch {${drv} mass_erase 1}`); // çift banka
  }
  const prog = ['program', `{${fwd(o.file)}}`, ...(o.verify !== false ? ['verify'] : []), ...(o.reset ? ['reset'] : []), 'exit', ...(address !== undefined ? [hex(address)] : [])].join(' ');
  const args = ['-f', p.interfaceCfg || 'interface/stlink.cfg', ...pre, '-f', o.targetCfg, ...post, '-c', prog];
  const file = o.toolPath || 'openocd';
  return { file, args, display: [file, ...args].map(q).join(' ') };
}

/** Bir çıktı satırından ilerleme: { stage, percent } (bilinmiyorsa null) */
function parseProgress(tool, line) {
  if (tool === 'cubeprog') {
    const pct = line.match(/(\d{1,3})%/g);
    if (/Erasing/i.test(line)) return { stage: 'erase', percent: 10 };
    if (/Download in Progress/i.test(line)) return { stage: 'program', percent: 20 };
    if (pct) return { stage: 'program', percent: 20 + Math.min(100, Number(pct[pct.length - 1].replace('%', ''))) * 0.6 };
    if (/Download verified|Verifying/i.test(line)) return { stage: 'verify', percent: 90 };
    return null;
  }
  if (/processor detected|Examination succeed/i.test(line)) return { stage: 'connect', percent: 10 };
  if (/mass erase/i.test(line)) return { stage: 'erase', percent: 20 };
  if (/Programming Started/i.test(line)) return { stage: 'program', percent: 30 };
  if (/wrote \d+ bytes/i.test(line)) return { stage: 'program', percent: 70 };
  if (/Verify Started/i.test(line)) return { stage: 'verify', percent: 75 };
  if (/Verified OK/i.test(line)) return { stage: 'verify', percent: 95 };
  if (/Resetting Target/i.test(line)) return { stage: 'reset', percent: 98 };
  return null;
}

/** Çıktıdan yazılan byte ve hız (aracın kendi ölçümü varsa) */
function parseStats(tool, log) {
  if (tool === 'openocd') {
    const m = /wrote (\d+) bytes from file .* in ([\d.]+)s \(([\d.]+) KiB\/s\)/i.exec(log);
    return m ? { bytes: Number(m[1]), seconds: Number(m[2]), kibps: Number(m[3]) } : null;
  }
  const m = /Time elapsed during download operation:\s*(\d+):(\d+):([\d.]+)/i.exec(log);
  return m ? { seconds: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) } : null;
}

/** Başarı ölçütü: aracın çıkış kodu yanında çıktı da kontrol edilir */
function flashSucceeded(tool, log, code, verify) {
  if (code !== 0) return false;
  if (tool === 'openocd') return /Programming Finished/i.test(log) && (!verify || /Verified OK/i.test(log));
  return /File download complete|Download verified successfully/i.test(log) && !/Error:/i.test(log);
}

/** Sık görülen hataları anlaşılır mesaja çevirir (null: bilinmiyor) */
function explainFlashError(log) {
  const L = String(log);
  if (/open failed|unable to open|no device found|LIBUSB_ERROR|No ST-?LINK detected|No debug probe detected/i.test(L)) return t('Prob bulunamadı. Prob takılı mı, sürücüsü kurulu mu, başka bir program (debug oturumu, CubeProgrammer) kullanıyor mu?');
  if (/Target voltage: 0\.\d+|target voltage may be too low|Target voltage: 0\b/i.test(L) && /unable to connect|init mode failed|Error/i.test(L)) return t('Hedef beslenmiyor (voltaj ~0 V). Kartın beslemesini ve VDD/GND bağlantısını kontrol edin.');
  if (/read.?out protect|Device Security Bit Set|device protected|RDP level 1|Flash memory read protection/i.test(L)) return t('Okuma koruması (RDP) aktif. Yüklemeden önce RDP seviye 0\'a indirilmeli; bu işlem tüm flash\'ı siler (STM32CubeProgrammer > Option bytes).');
  if (/write protect|WRP/i.test(L) && /error|failed/i.test(L)) return t('Flash yazma korumalı (WRP option byte). STM32CubeProgrammer ile korumayı kaldırın.');
  if (/unable to connect to the target|init mode failed|Error connecting DP|Cannot connect to target|DEV_TARGET_NOT_FOUND|No STM32 target found/i.test(L)) return t('Hedefe bağlanılamadı. SWDIO/SWCLK/GND bağlantılarını kontrol edin; uyku modu ya da SWD pinlerini kullanan bir program varsa "reset altında bağlan" seçeneğini açın.');
  if (/UNEXPECTED idcode|Cannot identify target|unknown device|Unknown flash device/i.test(L)) return t('Bağlı işlemci beklenen hedeften farklı. Projedeki MCU ile karttaki MCU\'yu karşılaştırın (Prob ve kart raporu).');
  if (/couldn't open .*file|No such file|does not exist|Error opening file/i.test(L)) return t('Yüklenecek dosya bulunamadı. Önce derleyin.');
  if (/timed out|timeout/i.test(L)) return t('Zaman aşımı. SWD hızını düşürmeyi deneyin.');
  if (/is not recognized|ENOENT|not found/i.test(L) && /openocd|STM32_Programmer_CLI/i.test(L)) return t('Yükleme aracı bulunamadı. Prob ve kart raporundaki kurulum bilgisine bakın.');
  if (/verify failed|Verification FAILED|contents differ/i.test(L)) return t('Doğrulama başarısız: flash\'taki veri dosyayla aynı değil. Besleme ya da bağlantı sorunu olabilir; tekrar deneyin.');
  return null;
}

module.exports = { buildFlashCommand, parseProgress, parseStats, flashSucceeded, explainFlashError, kindOf, OCD_DRIVER };
