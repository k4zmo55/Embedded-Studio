// @ts-check
/**
 * Flash programlayıcı (ES-301): sektör/sayfa haritası, OpenOCD `flash info` çözümü, option byte'ların aileye göre
 * çözümü, Intel HEX okuma ve dosya ↔ cihaz karşılaştırması. Donanıma erişim hedef nesnesi (OpenOcdTarget / SimTarget)
 * üzerinden; bu dosya yalnızca hesap yapar.
 */
const { t } = require('../i18n');

const FLASH_BASE = 0x08000000;
const RAM_BASE = 0x20000000;

/**
 * İşlemci verisindeki (mcu.device.flash) sektör / sayfa haritası. bank / num: OpenOCD'nin erase_sector argümanları
 * (H7'de her bank ayrı OpenOCD bankasıdır; diğerlerinde bütün sektörler tek bankta sırayla numaralanır).
 * @returns {{ index: number, bank: number, num: number, phys: number, addr: number, size: number }[]}
 */
function flashLayout(mcu) {
  const f = mcu.device.flash;
  const out = [];
  if (f.type === 'sector') {
    const split = mcu.device.family === 'h7';
    f.sectors.forEach(([offKB, sizeKB, num, phys], i) => out.push({
      index: i, bank: split ? phys - 1 : 0, num: split ? num : i, phys, addr: FLASH_BASE + offKB * 1024, size: sizeKB * 1024
    }));
  } else {
    const size = f.pageKB * 1024;
    for (let b = 0; b < f.banks; b++) {
      for (let p = 0; p < f.pagesPerBank; p++) {
        const i = b * f.pagesPerBank + p;
        out.push({ index: i, bank: 0, num: i, phys: b + 1, addr: FLASH_BASE + i * size, size });
      }
    }
  }
  return out;
}

/**
 * OpenOCD `flash info <n>` çıktısı → sektörler. Örnek:
 *   #0 : stm32f2x at 0x08000000, size 0x00080000, buswidth 0, chipwidth 0
 *   	#  0: 0x00000000 (0x4000 16kB) not protected
 * @returns {{ base: number, size: number, driver: string, sectors: { num: number, addr: number, size: number, protected: boolean }[] } | null}
 */
function parseFlashInfo(text) {
  const head = /#\d+\s*:\s*(\S+)\s+at\s+0x([0-9a-f]+),\s*size\s+0x([0-9a-f]+)/i.exec(text || '');
  if (!head) return null;
  const base = parseInt(head[2], 16);
  const sectors = [];
  for (const m of text.matchAll(/#\s*(\d+):\s*0x([0-9a-f]+)\s*\(0x([0-9a-f]+)[^)]*\)\s*(not protected|protected|protection state unknown)?/gi)) {
    sectors.push({ num: Number(m[1]), addr: base + parseInt(m[2], 16), size: parseInt(m[3], 16), protected: /^protected/i.test(m[4] || '') });
  }
  return { driver: head[1], base, size: parseInt(head[3], 16), sectors };
}

/** OpenOCD bankalarından birleşik sektör listesi (flashLayout ile aynı biçim) */
function layoutFromBanks(banks) {
  const out = [];
  banks.forEach((b, bank) => b.sectors.forEach((s) => out.push({ index: out.length, bank, num: s.num, phys: bank + 1, addr: s.addr, size: s.size, protected: s.protected })));
  return out;
}

/** Seçilen sektörleri OpenOCD'nin `flash erase_sector <bank> <ilk> <son>` aralıklarına böler */
function eraseRanges(sectors, indexes) {
  const sel = sectors.filter((s) => indexes.includes(s.index)).sort((a, b) => a.bank - b.bank || a.num - b.num);
  const ranges = [];
  for (const s of sel) {
    const last = ranges[ranges.length - 1];
    if (last && last.bank === s.bank && last.last === s.num - 1) {
      last.last = s.num;
      last.size += s.size;
    } else ranges.push({ bank: s.bank, first: s.num, last: s.num, addr: s.addr, size: s.size });
  }
  return ranges;
}

// ------------------------------------------------------------------ option byte'lar
const bit = (v, n) => (v >>> n) & 1;
const bits = (v, hi, lo) => (v >>> lo) & ((1 << (hi - lo + 1)) - 1);
const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** RDP baytı → seviye (0xAA: 0, 0xCC: 2, U5'te 0x55: 0.5, diğerleri: 1) */
function rdpLevel(byte, family) {
  if (byte === 0xaa) return 0;
  if (byte === 0xcc) return 2;
  if (family === 'u5' && byte === 0x55) return 0.5;
  return 1;
}

/** Kullanıcı bitleri: [ad, bit, 1 iken anlamı, 0 iken anlamı] */
const USER = {
  watchdog: (n, name = 'IWDG_SW') => [name, n, () => t('yazılımla başlatılır'), () => t('donanım (resetten sonra çalışır)')],
  stop: (n, name = 'nRST_STOP') => [name, n, () => t('reset yok'), () => t('STOP moduna girerken reset')],
  stdby: (n, name = 'nRST_STDBY') => [name, n, () => t('reset yok'), () => t('STANDBY moduna girerken reset')],
  shdw: (n) => ['nRST_SHDW', n, () => t('reset yok'), () => t('SHUTDOWN moduna girerken reset')],
  flag: (name, n) => [name, n, () => '1', () => '0']
};

/**
 * Ailelere göre option byte register'ları (salt okunur görüntüleme; adresler ve bitler ilgili reference manual'den:
 * RM0383/RM0090 F4, RM0410 F7, RM0008 F1, RM0360 F0, RM0316 F3, RM0444 G0, RM0440 G4, RM0351/RM0394 L4, RM0456 U5, RM0433/RM0468 H7).
 * sim: simülasyonda fabrika çıkışı değerleri.
 */
const OB = {
  f4: {
    regs: { OPTCR: 0x40023c14, OPTCR1: 0x40023c18 },
    sim: { OPTCR: 0x0fffaaed, OPTCR1: 0x0fff0000 },
    decode(r, mcu, sectors) {
      const v = r.OPTCR;
      const pcrop = bit(v, 31) === 1;
      const prot = sectors.filter((s) => s.index < 12 ? !bit(v, 16 + s.index) : r.OPTCR1 !== undefined && !bit(r.OPTCR1, 16 + s.index - 12)).map((s) => s.index);
      return {
        rdp: bits(v, 15, 8), bor: [t('BOR seviye 3 (2,70–3,60 V)'), t('BOR seviye 2 (2,40–2,70 V)'), t('BOR seviye 1 (2,10–2,40 V)'), t('BOR kapalı')][bits(v, 3, 2)],
        user: [USER.watchdog(5, 'WDG_SW'), USER.stop(6), USER.stdby(7)],
        raw: v, wrp: pcrop ? [] : prot, pcrop: pcrop ? sectors.filter((s) => s.index < 12 && bit(v, 16 + s.index)).map((s) => s.index) : [],
        notes: pcrop ? [t('SPRMOD = 1: nWRP bitleri PCROP (yalnızca çalıştırılabilir) olarak yorumlanır.')] : []
      };
    }
  },
  f7: {
    regs: { OPTCR: 0x40023c14, OPTCR1: 0x40023c18 },
    sim: { OPTCR: 0xffffaafd, OPTCR1: 0x00400080 },
    decode(r, mcu, sectors) {
      const v = r.OPTCR;
      return {
        rdp: bits(v, 15, 8), bor: [t('BOR seviye 3 (2,70–3,60 V)'), t('BOR seviye 2 (2,40–2,70 V)'), t('BOR seviye 1 (2,10–2,40 V)'), t('BOR kapalı')][bits(v, 3, 2)],
        user: [USER.watchdog(5), USER.flag('WWDG_SW', 4), USER.stop(6), USER.stdby(7), USER.flag('nDBANK', 29), USER.flag('nDBOOT', 28)],
        raw: v, wrp: sectors.filter((s) => s.index < 12 && !bit(v, 16 + s.index)).map((s) => s.index), pcrop: [],
        notes: [t('Boot adresleri: BOOT_ADD0 = {0}, BOOT_ADD1 = {1}', hex8((r.OPTCR1 & 0xffff) << 14), hex8((r.OPTCR1 >>> 16) << 14))]
      };
    }
  },
  f1: {
    regs: { OBR: 0x4002201c, WRPR: 0x40022020 },
    sim: { OBR: 0x03fffffc, WRPR: 0xffffffff },
    decode(r, mcu, sectors) {
      const v = r.OBR;
      return {
        rdp: bit(v, 1) ? 0x00 : 0xaa, bor: null, user: [USER.watchdog(2, 'WDG_SW'), USER.stop(3), USER.stdby(4)],
        raw: v, wrp: wrpGroups(r.WRPR, sectors, 4), pcrop: [], notes: [t('Data0 = 0x{0}, Data1 = 0x{1}', bits(v, 17, 10).toString(16).toUpperCase(), bits(v, 25, 18).toString(16).toUpperCase())]
      };
    }
  },
  f0: {
    regs: { OBR: 0x4002201c, WRPR: 0x40022020 },
    sim: { OBR: 0x00ff7f00, WRPR: 0xffffffff },
    decode(r, mcu, sectors) {
      const v = r.OBR;
      const lvl = bits(v, 2, 1);
      return {
        rdp: lvl === 0 ? 0xaa : lvl === 3 ? 0xcc : 0x00, bor: null,
        user: [USER.watchdog(8, 'WDG_SW'), USER.stop(9), USER.stdby(10), USER.flag('nBOOT1', 12), USER.flag('VDDA_MONITOR', 13), USER.flag('RAM_PARITY_CHECK', 14)],
        raw: v, wrp: wrpGroups(r.WRPR, sectors, mcu.device.family === 'f3' ? 2 : 4), pcrop: [], notes: []
      };
    }
  },
  l4: optrFamily(0x40022020, { WRP1AR: 0x4002202c, WRP1BR: 0x40022030, WRP2AR: 0x4002204c, WRP2BR: 0x40022050 }, 0xff, 0xffeff8aa, () => [
    USER.stop(12), USER.stdby(13), USER.shdw(14), USER.watchdog(16), USER.flag('IWDG_STOP', 17), USER.flag('IWDG_STDBY', 18), USER.flag('WWDG_SW', 19),
    USER.flag('BFB2', 20), USER.flag('DUALBANK', 21), USER.flag('nBOOT1', 23), USER.flag('SRAM2_PE', 24), USER.flag('SRAM2_RST', 25), USER.flag('nSWBOOT0', 26), USER.flag('nBOOT0', 27)]),
  g4: optrFamily(0x40022020, { WRP1AR: 0x4002202c, WRP1BR: 0x40022030, WRP2AR: 0x4002204c, WRP2BR: 0x40022050 }, 0x7f, 0xfbeff8aa, () => [
    USER.stop(12), USER.stdby(13), USER.shdw(14), USER.watchdog(16), USER.flag('IWDG_STOP', 17), USER.flag('IWDG_STDBY', 18), USER.flag('WWDG_SW', 19),
    USER.flag('BFB2', 20), USER.flag('DBANK', 22), USER.flag('nBOOT1', 23), USER.flag('SRAM_PE', 24), USER.flag('CCMSRAM_RST', 25), USER.flag('nSWBOOT0', 26), USER.flag('nBOOT0', 27)]),
  g0: optrFamily(0x40022020, { WRP1AR: 0x4002202c, WRP1BR: 0x40022030 }, 0x7f, 0xfffffeaa, () => [
    USER.flag('BOR_EN', 8), USER.stop(13), USER.stdby(14), USER.shdw(15), USER.watchdog(16), USER.flag('IWDG_STOP', 17), USER.flag('IWDG_STDBY', 18), USER.flag('WWDG_SW', 19),
    USER.flag('RAM_PARITY_CHECK', 22), USER.flag('nBOOT_SEL', 24), USER.flag('nBOOT1', 25), USER.flag('nBOOT0', 26)], (v) => t('BOR yükselen eşik seviyesi {0}, düşen {1}', bits(v, 12, 11), bits(v, 10, 9))),
  u5: optrFamily(0x40022040, {}, 0, 0x1feff8aa, () => [
    USER.stop(12), USER.stdby(13), USER.shdw(14), USER.watchdog(16), USER.flag('IWDG_STOP', 17), USER.flag('IWDG_STDBY', 18), USER.flag('WWDG_SW', 19),
    USER.flag('SWAP_BANK', 20), USER.flag('DUALBANK', 21), USER.flag('nSWBOOT0', 26), USER.flag('nBOOT0', 27), USER.flag('TZEN', 31)]),
  h7: {
    regs: { OPTSR: 0x5200201c, WPSN1: 0x52002038, WPSN2: 0x52002138 },
    sim: { OPTSR: 0x1a3eaaf0, WPSN1: 0x000000ff, WPSN2: 0x000000ff },
    decode(r, mcu, sectors) {
      const v = r.OPTSR;
      return {
        rdp: bits(v, 15, 8), bor: [t('BOR kapalı'), t('BOR seviye 1 (2,1 V)'), t('BOR seviye 2 (2,4 V)'), t('BOR seviye 3 (2,7 V)')][bits(v, 3, 2)],
        user: [USER.watchdog(4, 'IWDG1_SW'), USER.stop(6, 'NRST_STOP_D1'), USER.stdby(7, 'NRST_STBY_D1'), USER.flag('SECURITY', 21), USER.flag('SWAP_BANK_OPT', 31)],
        raw: v, wrp: sectors.filter((s) => !bit(s.phys === 2 ? r.WPSN2 : r.WPSN1, s.num)).map((s) => s.index), pcrop: [], notes: []
      };
    }
  }
};
OB.f3 = OB.f0;

/** L4 / G4 / G0 / U5: FLASH_OPTR + WRPxyR (başlangıç–bitiş sayfası) */
function optrFamily(optr, wrpRegs, mask, sim, user, borText) {
  const regs = { OPTR: optr, ...wrpRegs };
  const simVals = { OPTR: sim };
  for (const k of Object.keys(wrpRegs)) simVals[k] = mask; // başlangıç > bitiş: korumasız
  return {
    regs, sim: simVals,
    decode(r, mcu, sectors) {
      const v = r.OPTR;
      const wrp = new Set();
      for (const [a, bank] of [['WRP1AR', 1], ['WRP1BR', 1], ['WRP2AR', 2], ['WRP2BR', 2]]) {
        if (r[a] === undefined) continue;
        const start = r[a] & mask, end = (r[a] >>> 16) & mask;
        if (start > end) continue;
        for (const s of sectors) {
          const local = s.phys === 1 ? s.num : s.num - sectors.filter((x) => x.phys === 1).length;
          if (s.phys === bank && local >= start && local <= end) wrp.add(s.index);
        }
      }
      const lv = bits(v, 10, 8);
      return {
        rdp: v & 0xff, bor: borText ? borText(v) : [t('BOR seviye 0 (~1,7 V)'), t('BOR seviye 1 (~2,0 V)'), t('BOR seviye 2 (~2,2 V)'), t('BOR seviye 3 (~2,5 V)'), t('BOR seviye 4 (~2,8 V)')][lv] || `BOR_LEV = ${lv}`,
        user: user(), raw: v, wrp: [...wrp].sort((a, b) => a - b), pcrop: [],
        notes: Object.keys(wrpRegs).length ? [] : [t('Yazma koruması bu ailede henüz gösterilmiyor.')]
      };
    }
  };
}

/** F0/F1/F3 WRPR: her bit `per` sayfayı korur, 0 = korumalı (son bit kalan bütün sayfalar) */
function wrpGroups(wrpr, sectors, per) {
  return sectors.filter((s) => !bit(wrpr, Math.min(31, Math.floor(s.index / per)))).map((s) => s.index);
}

/** İşlemcinin option byte tanımı (yoksa null) */
const obSpec = (mcu) => OB[mcu.device.family] || null;

/**
 * Okunan register değerleri → arayüz için özet.
 * @param {Record<string, number>} values register adı → değer
 */
function decodeOptionBytes(mcu, values, sectors) {
  const spec = obSpec(mcu);
  if (!spec) return null;
  const d = spec.decode(values, mcu, sectors);
  const level = rdpLevel(d.rdp, mcu.device.family);
  return {
    rdp: { byte: d.rdp, level, text: level === 0 ? t('Seviye 0: koruma yok') : level === 0.5 ? t('Seviye 0,5: yalnızca güvenli olmayan bölge korumalı (TrustZone)') : level === 1 ? t('Seviye 1: debug ile flash okunamaz; seviye 0\'a dönüş flash\'ı tamamen siler') : t('Seviye 2: kalıcı kilit, debug kapalı; geri dönüşü yok') },
    bor: d.bor,
    user: d.user.map(([name, n, on, off]) => ({ name, value: bit(d.raw, n), text: bit(d.raw, n) ? on() : off() })),
    wrp: d.wrp, pcrop: d.pcrop, notes: d.notes,
    registers: Object.entries(spec.regs).map(([name, addr]) => ({ name, addr, value: values[name] }))
  };
}

// ------------------------------------------------------------------ dosyalar
/**
 * Intel HEX → bitişik bölütler. Tip 00 veri, 01 son, 02 bölüt adresi, 04 genişletilmiş doğrusal adres; 03/05 yok sayılır.
 * @returns {{ addr: number, bytes: Uint8Array }[]}
 */
function parseIntelHex(text) {
  const chunks = [];
  let upper = 0;
  let lineNo = 0;
  for (const raw of text.split(/\r?\n/)) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    if (!/^:([0-9a-f]{2})+$/i.test(line)) throw new Error(t('Intel HEX satırı geçersiz ({0}. satır).', lineNo));
    const b = [];
    for (let i = 1; i < line.length; i += 2) b.push(parseInt(line.slice(i, i + 2), 16));
    const [len, hi, lo, type] = b;
    if (b.length !== len + 5) throw new Error(t('Intel HEX satır uzunluğu tutmuyor ({0}. satır).', lineNo));
    if (b.reduce((s, x) => s + x, 0) & 0xff) throw new Error(t('Intel HEX sağlama toplamı hatalı ({0}. satır).', lineNo));
    const data = b.slice(4, 4 + len);
    if (type === 0) chunks.push({ addr: (upper + ((hi << 8) | lo)) >>> 0, data });
    else if (type === 1) break;
    else if (type === 2) upper = ((data[0] << 8) | data[1]) * 16;
    else if (type === 4) upper = ((data[0] << 8) | data[1]) * 0x10000;
  }
  chunks.sort((a, b) => a.addr - b.addr);
  const out = [];
  for (const c of chunks) {
    const last = out[out.length - 1];
    if (last && last.addr + last.data.length === c.addr) last.data.push(...c.data);
    else out.push({ addr: c.addr, data: [...c.data] });
  }
  return out.map((s) => ({ addr: s.addr, bytes: Uint8Array.from(s.data) }));
}

/**
 * Dosya bölütleri ile cihazdan okunan baytları karşılaştırır.
 * @param {{ addr: number, bytes: Uint8Array }[]} segments @param {{ addr: number, bytes: Uint8Array }[]} device aynı sırada okunanlar
 */
function compareImages(segments, device, maxList = 20) {
  let total = 0, diff = 0;
  const first = [];
  const ranges = [];
  segments.forEach((s, k) => {
    const d = device[k].bytes;
    let open = null;
    for (let i = 0; i < s.bytes.length; i++) {
      total++;
      if (s.bytes[i] === d[i]) { open = null; continue; }
      diff++;
      const a = s.addr + i;
      if (first.length < maxList) first.push({ addr: a, file: s.bytes[i], device: d[i] });
      if (open && open.end === a) open.end = a + 1;
      else ranges.push((open = { start: a, end: a + 1 }));
    }
  });
  const blank = device.reduce((n, d) => n + d.bytes.filter((x) => x === 0xff).length, 0);
  return { total, diff, same: diff === 0, first, ranges: ranges.slice(0, 50), rangeCount: ranges.length, blankDevice: blank === total && total > 0 };
}

/** Okuma bölgesi: flash (bütün), RAM ya da özel adres; sınır denetimi */
function readRange(mcu, region, addr, length) {
  const flash = { addr: FLASH_BASE, length: mcu.device.flashKB * 1024 };
  const ram = { addr: RAM_BASE, length: mcu.device.ramKB * 1024 };
  if (region === 'flash') return flash;
  if (region === 'ram') return ram;
  if (!Number.isFinite(addr) || !Number.isFinite(length) || length <= 0) throw new Error(t('Adres ve uzunluk geçerli bir sayı olmalı.'));
  if (length > 16 * 1024 * 1024) throw new Error(t('En fazla 16 MB okunabilir.'));
  return { addr: addr >>> 0, length };
}

/** Sektör tablosu için kısa boyut metni */
const sizeText = (n) => (n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : n >= 1024 ? `${n / 1024} KB` : `${n} B`);

module.exports = {
  FLASH_BASE, RAM_BASE, flashLayout, parseFlashInfo, layoutFromBanks, eraseRanges, rdpLevel, obSpec, decodeOptionBytes,
  parseIntelHex, compareImages, readRange, sizeText, OB
};
