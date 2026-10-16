// @ts-check
/**
 * STM32 kimlik bilgisi (ES-202): DBGMCU_IDCODE, flash boyutu, 96 bit UID, okuma koruması (RDP).
 * Register adresleri aileye göre farklıdır (her ailenin reference manual'ındaki "Device electronic signature"
 * ve "DBGMCU" bölümleri). OpenOCD ile tek oturumda tüm aday adresler okunur (catch ile), sonra cihaz kimliğine
 * göre doğru olanlar seçilir.
 */

/** DEV_ID (IDCODE[11:0]) → cihaz ailesi. Projedeki işlemciyle karşılaştırmak için MCU tanımlarının define'ı da var. */
const DEV_IDS = {
  0x440: { name: 'STM32F030x8 / F05x', family: 'f0', defines: ['STM32F030x8'] },
  0x444: { name: 'STM32F03x', family: 'f0' },
  0x445: { name: 'STM32F04x', family: 'f0' },
  0x448: { name: 'STM32F07x', family: 'f0' },
  0x442: { name: 'STM32F09x / F030xC', family: 'f0' },
  0x412: { name: 'STM32F10x low-density', family: 'f1' },
  0x410: { name: 'STM32F10x medium-density', family: 'f1', defines: ['STM32F103xB'] },
  0x414: { name: 'STM32F10x high-density', family: 'f1' },
  0x430: { name: 'STM32F10x XL-density', family: 'f1' },
  0x418: { name: 'STM32F105/107', family: 'f1' },
  0x422: { name: 'STM32F302xB/C / F303xB/C', family: 'f3' },
  0x438: { name: 'STM32F303x6/8 / F334', family: 'f3' },
  0x446: { name: 'STM32F302xD/E / F303xD/E', family: 'f3', defines: ['STM32F303xE'] },
  0x413: { name: 'STM32F405/407/415/417', family: 'f4', defines: ['STM32F407xx'] },
  0x419: { name: 'STM32F42x/43x', family: 'f4', defines: ['STM32F429xx'] },
  0x423: { name: 'STM32F401xB/C', family: 'f4' },
  0x433: { name: 'STM32F401xD/E', family: 'f4' },
  0x431: { name: 'STM32F411xC/E', family: 'f4', defines: ['STM32F411xE'] },
  0x441: { name: 'STM32F412', family: 'f4' },
  0x421: { name: 'STM32F446', family: 'f4', defines: ['STM32F446xx'] },
  0x434: { name: 'STM32F469/479', family: 'f4' },
  0x449: { name: 'STM32F74x/75x', family: 'f7' },
  0x452: { name: 'STM32F72x/73x', family: 'f7' },
  0x451: { name: 'STM32F76x/77x', family: 'f7', defines: ['STM32F767xx'] },
  0x466: { name: 'STM32G03x/04x', family: 'g0' },
  0x460: { name: 'STM32G07x/08x', family: 'g0', defines: ['STM32G071xx'] },
  0x467: { name: 'STM32G0Bx/0Cx', family: 'g0' },
  0x468: { name: 'STM32G43x/44x', family: 'g4' },
  0x469: { name: 'STM32G47x/48x', family: 'g4', defines: ['STM32G474xx'] },
  0x479: { name: 'STM32G49x/4Ax', family: 'g4' },
  0x450: { name: 'STM32H74x/75x', family: 'h7', defines: ['STM32H743xx'] },
  0x483: { name: 'STM32H72x/73x', family: 'h7', defines: ['STM32H723xx'] },
  0x480: { name: 'STM32H7A3/7B0/7B3', family: 'h7' },
  0x464: { name: 'STM32L41x/42x', family: 'l4' },
  0x435: { name: 'STM32L43x/44x', family: 'l4', defines: ['STM32L432xx'] },
  0x462: { name: 'STM32L45x/46x', family: 'l4' },
  0x415: { name: 'STM32L47x/48x', family: 'l4', defines: ['STM32L476xx'] },
  0x461: { name: 'STM32L49x/4Ax', family: 'l4' },
  0x482: { name: 'STM32U575/585', family: 'u5', defines: ['STM32U575xx'] },
  0x481: { name: 'STM32U59x/5Ax', family: 'u5' }
};

/** Aileye göre register adresleri: IDCODE, flash boyutu (16 bit, KB), UID (3 × 32 bit), RDP register'ı */
const ADDR = {
  f0: { idcode: 0x40015800, flash: 0x1FFFF7CC, uid: 0x1FFFF7AC, rdp: 0x4002201C, rdpKind: 'obr2' },
  f1: { idcode: 0xE0042000, flash: 0x1FFFF7E0, uid: 0x1FFFF7E8, rdp: 0x4002201C, rdpKind: 'obr1' },
  f3: { idcode: 0xE0042000, flash: 0x1FFFF7CC, uid: 0x1FFFF7AC, rdp: 0x4002201C, rdpKind: 'obr2' },
  f4: { idcode: 0xE0042000, flash: 0x1FFF7A22, uid: 0x1FFF7A10, rdp: 0x40023C14, rdpKind: 'byte8' },
  f7: { idcode: 0xE0042000, flash: 0x1FF0F442, uid: 0x1FF0F420, rdp: 0x40023C14, rdpKind: 'byte8' },
  g0: { idcode: 0x40015800, flash: 0x1FFF75E0, uid: 0x1FFF7590, rdp: 0x40022020, rdpKind: 'byte0' },
  g4: { idcode: 0xE0042000, flash: 0x1FFF75E0, uid: 0x1FFF7590, rdp: 0x40022020, rdpKind: 'byte0' },
  l4: { idcode: 0xE0042000, flash: 0x1FFF75E0, uid: 0x1FFF7590, rdp: 0x40022020, rdpKind: 'byte0' },
  h7: { idcode: 0x5C001000, flash: 0x1FF1E880, uid: 0x1FF1E800, rdp: 0x5200201C, rdpKind: 'byte8' },
  u5: { idcode: 0xE0044000, flash: 0x0BFA07A0, uid: 0x0BFA0700, rdp: 0x40022040, rdpKind: 'byte0' }
};

/** Bilinen revizyon kodları (REV_ID → harf); bilinmeyenler onaltılık gösterilir. */
const REVS = {
  0x431: { 0x1000: 'A' }, 0x413: { 0x1000: 'A', 0x1001: 'Z', 0x1003: 'Y', 0x1007: '1', 0x100F: '4', 0x101F: '5' },
  0x419: { 0x1000: 'A', 0x1003: 'Y', 0x1007: '1', 0x2001: '3', 0x2003: '5' }, 0x421: { 0x1000: 'A' },
  0x451: { 0x1000: 'A', 0x1001: 'Z' }, 0x410: { 0x0000: 'A', 0x2000: 'B', 0x2001: 'Z', 0x2003: 'Y' },
  0x450: { 0x1001: 'Z', 0x1003: 'Y', 0x2001: 'X', 0x2003: 'V' }, 0x483: { 0x1000: 'A', 0x1001: 'Z' },
  0x460: { 0x1000: 'A', 0x2000: 'B' }, 0x469: { 0x1000: 'A', 0x2000: 'B', 0x2001: 'Z', 0x2002: 'Y' },
  0x415: { 0x1000: 'A', 0x1001: 'Z', 0x1003: 'Y', 0x1007: '4' }, 0x435: { 0x1000: 'A', 0x1001: 'Z', 0x2001: 'Y' },
  0x482: { 0x1000: 'A', 0x1001: 'Z', 0x2001: 'X', 0x3001: 'W' }
};

const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** OpenOCD komutları: tüm ailelerin aday adresleri (geçersiz adres hata verir; catch ile devam) */
function readCommands() {
  const cmds = [];
  const seen = new Set();
  const add = (c) => { if (!seen.has(c)) { seen.add(c); cmds.push(`catch {${c}}`); } };
  for (const a of Object.values(ADDR)) add(`mdw ${hex(a.idcode)}`);
  for (const a of Object.values(ADDR)) {
    add(`mdh ${hex(a.flash)}`);
    add(`mdw ${hex(a.uid)} 3`);
    add(`mdw ${hex(a.rdp)}`);
  }
  return cmds;
}

/** "0xe0042000: 10006431 " satırlarından adres → değer listesi */
function parseReads(log) {
  const out = new Map();
  for (const m of String(log).matchAll(/^\s*0x([0-9a-f]+):((?:\s+[0-9a-f]{4,8})+)\s*$/gim)) {
    out.set(parseInt(m[1], 16) >>> 0, m[2].trim().split(/\s+/).map((v) => parseInt(v, 16) >>> 0));
  }
  return out;
}

function rdpLevel(kind, v) {
  if (kind === 'obr1') return (v >> 1) & 1 ? 1 : 0;           // F1: RDPRT biti
  if (kind === 'obr2') { const b = (v >> 1) & 3; return b === 0 ? 0 : b === 3 ? 2 : 1; } // F0/F3: RDPRT[1:0]
  const byte = kind === 'byte8' ? (v >> 8) & 0xFF : v & 0xFF;  // F4/F7/H7: OPTCR[15:8], G0/G4/L4/U5: OPTR[7:0]
  return byte === 0xAA ? 0 : byte === 0xCC ? 2 : byte === 0x55 ? 0.5 : 1;
}

/**
 * OpenOCD okuma çıktısından hedef bilgisi. Aday IDCODE adreslerinden bilinen bir cihaz kimliği veren seçilir.
 * @returns {null | { idcode: number, devId: number, revId: number, name: string, family: string, rev: string, flashKB?: number, uid?: string, rdp?: number, defines: string[] }}
 */
function decodeTarget(log) {
  const reads = parseReads(log);
  for (const [fam, a] of Object.entries(ADDR)) {
    const v = reads.get(a.idcode);
    if (!v) continue;
    const idcode = v[0];
    const devId = idcode & 0xFFF;
    const dev = DEV_IDS[devId];
    if (!dev || dev.family !== fam) continue;
    const revId = idcode >>> 16;
    const flash = reads.get(a.flash);
    const uid = reads.get(a.uid);
    const rdp = reads.get(a.rdp);
    return {
      idcode, devId, revId, name: dev.name, family: fam,
      rev: (REVS[devId] || {})[revId] || hex(revId, 4),
      flashKB: flash && flash[0] ? flash[0] & 0xFFFF : undefined,
      uid: uid && uid.length === 3 ? uid.map((w) => w.toString(16).toUpperCase().padStart(8, '0')).reverse().join('') : undefined,
      rdp: rdp ? rdpLevel(a.rdpKind, rdp[0]) : undefined,
      defines: dev.defines || []
    };
  }
  return null;
}

/** Projedeki MCU (CMSIS define) bağlı cihazla uyuşuyor mu */
function matchesProject(target, mcu) {
  if (!target || !mcu) return null;
  const want = Object.entries(DEV_IDS).find(([, d]) => (d.defines || []).includes(mcu.device.define));
  return want ? Number(want[0]) === target.devId : target.family === (mcu.device.family || 'f4');
}

module.exports = { DEV_IDS, ADDR, readCommands, parseReads, decodeTarget, rdpLevel, matchesProject, hex };
