// @ts-check
/**
 * Bellek görüntüleyici yardımcıları (ES-206): bölge okuma, dosyaya kaydetme (ham .bin / Intel HEX),
 * yazma öncesi denetim, simülasyon için örnek değişkenler.
 */
const { t } = require('../i18n');

/** Tek okumada en fazla bu kadar word (OpenOCD TCL yanıtı uzamasın) */
const CHUNK_WORDS = 256;
/** Kaydedilebilecek en büyük bölge */
const MAX_SAVE = 1 << 20;

/** Cortex-M bellek haritası: kod bölgesi (flash, sistem belleği, option byte'lar) doğrudan yazılamaz */
const isCodeRegion = (addr) => (addr >>> 0) < 0x20000000;
/** Çevre birimi bölgesi: okuması yan etki yaratabilir */
const isPeripheral = (addr) => (addr >>> 0) >= 0x40000000 && (addr >>> 0) < 0x60000000;

/** 32 bit word'ler → bayt dizisi (little-endian) */
function wordsToBytes(words) {
  const out = new Uint8Array(words.length * 4);
  words.forEach((w, i) => { for (let k = 0; k < 4; k++) out[i * 4 + k] = (w >>> (8 * k)) & 0xff; });
  return out;
}

/** Hizasız bir bölgeyi parça parça okur → bayt dizisi */
async function readRegion(target, addr, length) {
  const start = addr & ~3, end = (addr + length + 3) & ~3;
  const words = [];
  for (let a = start; a < end; a += CHUNK_WORDS * 4) words.push(...(await target.readMemory(a, Math.min(CHUNK_WORDS, (end - a) / 4))));
  const bytes = wordsToBytes(words);
  return bytes.subarray(addr - start, addr - start + length);
}

/** Intel HEX (tip 04 genişletilmiş adres + 16 baytlık veri kayıtları + EOF) */
function toIntelHex(bytes, base) {
  const rec = (type, addr, data) => {
    const b = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
    const sum = (0x100 - (b.reduce((s, x) => s + x, 0) & 0xff)) & 0xff;
    return ':' + [...b, sum].map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join('');
  };
  const lines = [];
  let upper = -1;
  for (let i = 0; i < bytes.length;) {
    const a = (base + i) >>> 0;
    if (a >>> 16 !== upper) { upper = a >>> 16; lines.push(rec(4, 0, [upper >> 8, upper & 0xff])); }
    // Kayıt 64 KB sınırını aşmasın
    const n = Math.min(16, bytes.length - i, 0x10000 - (a & 0xffff));
    lines.push(rec(0, a & 0xffff, [...bytes.subarray(i, i + n)]));
    i += n;
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

/** Yazmadan önce: adres/genişlik/değer denetimi. Hata metni ya da '' */
function checkWrite(addr, width, value) {
  if (![8, 16, 32].includes(width)) return t('Geçersiz yazma genişliği: {0}', width);
  if (addr % (width / 8)) return t('{0} bit yazma için adres {1} bayta hizalı olmalı.', width, width / 8);
  if (isCodeRegion(addr)) return t('Flash (kod bölgesi) doğrudan yazılamaz; değiştirmek için programı yeniden yükleyin.');
  if (!Number.isFinite(value) || value < 0 || value > (width === 32 ? 0xffffffff : (1 << width) - 1)) return t('Değer {0} bite sığmıyor.', width);
  return '';
}

/** Float32 ↔ ham bit */
const floatBits = (f) => { const b = Buffer.alloc(4); b.writeFloatLE(f); return b.readUInt32LE(); };

/**
 * Simülasyon: ELF yokken Live Watch'u denemek için örnek değişkenler; değerleri zamanla değişir.
 * @returns {{ name: string, addr: number, size: number }[]}
 */
function simSymbols(model, instances) {
  const syms = instances.map((i, k) => ({ name: i.label.toLowerCase() + '_ok', addr: 0x20000100 + k * 4, size: 1 }));
  for (const s of syms) model.expected.set(s.addr, 1);
  const demo = [
    { name: 'uwTick', addr: 0x20000080, size: 4, f: (ms) => ms },
    { name: 'adc_raw', addr: 0x20000084, size: 2, f: (ms) => Math.round(2048 + 1500 * Math.sin(ms / 1500)) },
    { name: 'temperature', addr: 0x20000088, size: 4, f: (ms) => floatBits(24 + 3 * Math.sin(ms / 4000) + 0.2 * Math.sin(ms / 170)) },
    { name: 'error_count', addr: 0x2000008c, size: 4, f: (ms) => Math.floor(ms / 7000) }
  ];
  for (const d of demo) model.dynamic.set(d.addr, d.f);
  return [...syms, ...demo.map(({ name, addr, size }) => ({ name, addr, size }))];
}

module.exports = { CHUNK_WORDS, MAX_SAVE, isCodeRegion, isPeripheral, wordsToBytes, readRegion, toIntelHex, checkWrite, floatBits, simSymbols };
