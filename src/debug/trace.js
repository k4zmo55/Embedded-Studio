// @ts-check
/**
 * SWO/ITM, SEGGER RTT, semihosting ve PC örnekleme (ES-208). vscode'a bağlı değildir (birim testli).
 *
 *  - ItmDecoder:   SWO'dan gelen ham ITM/DWT akışını paketlere ayırır (yazılım stimulus portları, PC örneği,
 *                  data trace, istisna izi, zaman damgası, taşma).
 *  - itmSetup:     ITM/DWT register yazmaları (port maskesi, zaman damgası, PC örnekleme, data trace karşılaştırıcıları).
 *  - RttClient:    hedef belleğindeki SEGGER RTT kontrol bloğunu bulur; up kanallarını okur, down kanalına yazar.
 *                  Sadece readMemory/writeMemory kullanır: her probla ve simülasyonla çalışır.
 *  - PcProfile:    PC örneklerini fonksiyonlara dağıtır (istatistiksel profil).
 *  - TraceSession: hepsini bir hedefe bağlar, webview'a toplu mesaj gönderir.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const { t } = require('../i18n');
const { readRegion } = require('./memory');

// Cortex-M debug register'ları (ARMv7-M)
const REG = {
  DEMCR: 0xe000edfc,
  ITM_STIM: 0xe0000000, ITM_TER: 0xe0000e00, ITM_TPR: 0xe0000e40, ITM_TCR: 0xe0000e80, ITM_LAR: 0xe0000fb0,
  DWT_CTRL: 0xe0001000, DWT_COMP: 0xe0001020, DWT_LAR: 0xe0001fb0
};
const UNLOCK = 0xc5acce55;
/** ARMv7-M'de DWT karşılaştırıcısı sayısı (M3/M4/M7: 4) */
const DWT_COMPARATORS = 4;

// ------------------------------------------------------------------ ITM paket çözücü
/**
 * ARMv7-M ARM, Ek D4 "Debug ITM and DWT Packet Protocol". Akış parça parça gelir: eksik paket bir sonraki
 * push()'ta tamamlanır.
 */
class ItmDecoder {
  constructor() {
    /** @type {number[]} */
    this.buf = [];
    /** Yerel zaman damgası toplamı (TPIU/ITM saat tıkı) */
    this.ts = 0;
    this.overflows = 0;
  }

  /**
   * @param {Uint8Array | number[]} bytes
   * @returns {{ type: string, [k: string]: any }[]}
   */
  push(bytes) {
    for (const b of bytes) this.buf.push(b);
    const B = this.buf, ev = [];
    let i = 0;
    // Devam bitli (C) yük: en fazla 4 bayt; tamamlanmadıysa -1
    const cont = (from) => {
      let j = from, v = 0, k = 0;
      for (;;) {
        if (j >= B.length) return { end: -1, v };
        const x = B[j++];
        v |= (x & 0x7f) << (7 * k++);
        if (!(x & 0x80) || k >= 5) return { end: j, v: v >>> 0 };
      }
    };
    while (i < B.length) {
      const h = B[i];
      if (h === 0) {
        // Senkron paketi: en az 47 sıfır bit ve 1 (… 00 00 00 00 00 80)
        let j = i;
        while (j < B.length && B[j] === 0) j++;
        if (j >= B.length) break;
        if (B[j] === 0x80) { ev.push({ type: 'sync' }); i = j + 1; } else i = j;
        continue;
      }
      if (h === 0x70) { this.overflows++; ev.push({ type: 'overflow' }); i++; continue; }
      if ((h & 0x0f) === 0) {
        // Yerel zaman damgası: kısa biçim 0TTT0000, uzun biçim 11TC0000 + devam baytları
        if (!(h & 0x80)) { this.ts += (h >> 4) & 7; ev.push({ type: 'ts', ts: this.ts }); i++; continue; }
        const c = cont(i + 1);
        if (c.end < 0) break;
        this.ts += c.v;
        ev.push({ type: 'ts', ts: this.ts, tc: (h >> 4) & 3 });
        i = c.end;
        continue;
      }
      if ((h & 0x03) === 0) {
        // Genel zaman damgası (0x94/0xB4), uzantı paketi (bit3=1) ya da ayrılmış: yükü atla
        if (h & 0x80) { const c = cont(i + 1); if (c.end < 0) break; i = c.end; } else i++;
        continue;
      }
      const n = [0, 1, 2, 4][h & 3];
      if (i + n >= B.length) break;
      let v = 0;
      for (let k = n; k >= 1; k--) v = v * 256 + B[i + k];
      const id = h >> 3;
      if (!(h & 4)) ev.push({ type: 'sw', port: id, size: n, value: v >>> 0, ts: this.ts });
      else ev.push(this.hardware(id, n, v >>> 0));
      i += 1 + n;
    }
    this.buf = B.slice(i);
    // Bozuk akışta tampon şişmesin
    if (this.buf.length > 4096) this.buf = [];
    return ev;
  }

  /** DWT donanım paketi (ayırt edici: 0 olay sayacı, 1 istisna, 2 PC örneği, 8–23 data trace) */
  hardware(id, n, v) {
    if (id === 0) return { type: 'event', value: v };
    if (id === 1) return { type: 'exception', exc: v & 0x1ff, fn: ['', 'enter', 'exit', 'return'][(v >> 12) & 3], ts: this.ts };
    if (id === 2) return n === 1 ? { type: 'pc', sleep: true } : { type: 'pc', pc: v };
    if (id >= 8 && id <= 23) {
      const cmp = (id >> 1) & 3;
      if (id < 16) return id & 1 ? { type: 'daddr', cmp, offset: v } : { type: 'dpc', cmp, pc: v };
      return { type: 'data', cmp, value: v, size: n, write: !!(id & 1), ts: this.ts };
    }
    return { type: 'hw', id, value: v };
  }
}

// ------------------------------------------------------------------ ITM / DWT ayarı
/**
 * SWO hızına göre PC örnekleme aralığı. Örnek başına 5 bayt (UART'ta 10 bit/bayt); SWO bant genişliğinin
 * yarısını geçmesin, saniyede ~10 000 örnekten fazla olmasın.
 * @returns {{ cyctap: number, postpreset: number, rate: number }}
 */
function pcSampleConfig(cpuHz, swoHz) {
  const budget = Math.min(10000, (swoHz / 10 / 5) * 0.5);
  for (const cyctap of [0, 1]) {
    const tap = cyctap ? 1024 : 64;
    for (let pp = 0; pp < 16; pp++) {
      const rate = cpuHz / (tap * (pp + 1));
      if (rate <= budget) return { cyctap, postpreset: pp, rate: Math.round(rate) };
    }
  }
  return { cyctap: 1, postpreset: 15, rate: Math.round(cpuHz / (1024 * 16)) };
}

/** SWO frekansı için TPIU bölücüsü: SWO = TRACECLKIN / (ACPR + 1). Gerçekte elde edilen frekans */
function swoPrescaler(cpuHz, swoHz) {
  const acpr = Math.max(0, Math.round(cpuHz / swoHz) - 1);
  return { acpr, actualHz: Math.round(cpuHz / (acpr + 1)) };
}

/** "0,1,5-7" ya da 0x23 → 32 bitlik port maskesi */
function parsePorts(s) {
  if (typeof s === 'number') return s >>> 0;
  const str = String(s || '').trim();
  if (/^0x[0-9a-f]+$/i.test(str)) return parseInt(str, 16) >>> 0;
  let mask = 0;
  for (const part of str.split(/[,\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return NaN;
    const a = Number(m[1]), b = m[2] === undefined ? a : Number(m[2]);
    if (a > 31 || b > 31 || b < a) return NaN;
    for (let k = a; k <= b; k++) mask |= 1 << k;
  }
  return mask >>> 0;
}

/**
 * ITM/DWT açma yazmaları: [adres, genişlik, değer] listesi (sırayla uygulanır).
 * @param {{ ports: number, ts?: boolean, pc?: { cyctap: number, postpreset: number } | null, exc?: boolean,
 *   data?: { addr: number, size: number, pc?: boolean }[] }} o
 */
function itmSetup(o) {
  /** @type {[number, number, number][]} */
  const w = [];
  w.push([REG.DEMCR, 32, 1 << 24]); // TRCENA (oku-değiştir-yaz yerine: diğer DEMCR bitleri debugger'ındır, OpenOCD tekrar kurar)
  w.push([REG.ITM_LAR, 32, UNLOCK]);
  w.push([REG.DWT_LAR, 32, UNLOCK]); // M7'de DWT kilitli gelir
  const dwt = !!(o.pc || o.exc || (o.data && o.data.length));
  // TCR: ITMENA | TSENA | SYNCENA | DWTENA (TXENA) | TraceBusID=1
  const tcr = 1 | (o.ts ? 2 : 0) | 4 | (dwt ? 8 : 0) | (1 << 16);
  w.push([REG.ITM_TCR, 32, 0]); // TCR değişirken ITM kapalı olmalı
  w.push([REG.ITM_TPR, 32, 0xf]); // tüm portlar ayrıcalıksız koddan da yazılabilsin
  w.push([REG.ITM_TER, 32, o.ports >>> 0]);
  w.push([REG.ITM_TCR, 32, tcr]);
  (o.data || []).slice(0, DWT_COMPARATORS).forEach((d, n) => w.push(...dataTraceWrites(n, d)));
  // CTRL: CYCCNTENA | POSTPRESET | POSTINIT | CYCTAP | PCSAMPLENA | EXCTRCENA
  let ctrl = 0;
  if (o.pc) ctrl |= 1 | (o.pc.postpreset << 1) | (o.pc.postpreset << 5) | (o.pc.cyctap << 9) | (1 << 12);
  if (o.exc) ctrl |= 1 << 16;
  w.push([REG.DWT_CTRL, 32, ctrl >>> 0]);
  return w;
}

/** Kapatma: PC örnekleme, istisna izi ve karşılaştırıcılar; ITM açık kalır (firmware printf'i bozulmasın) */
function itmStop() {
  /** @type {[number, number, number][]} */
  const w = [[REG.DWT_CTRL, 32, 0]];
  for (let n = 0; n < DWT_COMPARATORS; n++) w.push([REG.DWT_COMP + n * 16 + 8, 32, 0]);
  return w;
}

/**
 * DWT karşılaştırıcısı n: değişkene her erişimde veri değeri (ve isteğe bağlı PC) paketi.
 * FUNCTION 0b0010 = veri değeri, 0b0011 = PC + veri değeri; DATAVSIZE = erişim boyutu; MASK adresin alt bitlerini yok sayar.
 */
function dataTraceWrites(n, d) {
  const size = [1, 2, 4].includes(d.size) ? d.size : 4;
  const base = REG.DWT_COMP + n * 16;
  const fn = (d.pc ? 3 : 2) | ({ 1: 0, 2: 1, 4: 2 }[size] << 10);
  return [[base + 8, 32, 0], [base, 32, d.addr >>> 0], [base + 4, 32, Math.log2(size)], [base + 8, 32, fn]];
}

// ------------------------------------------------------------------ PC profili
/** Fonksiyon sembolleri (addr, size; adrese göre sıralı). Thumb bitine dikkat: nm çift adres verir. */
function functionSymbols(elf, nm = 'arm-none-eabi-nm') {
  return new Promise((resolve) => {
    if (!elf || !fs.existsSync(elf)) return resolve([]);
    execFile(nm, ['-S', '-C', '--defined-only', elf], { windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) return resolve([]);
      resolve(parseFunctions(stdout));
    });
  });
}

/** `nm -S` çıktısı → [{ name, addr, size }] (t/T/W fonksiyonlar) */
function parseFunctions(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([0-9a-f]{8}) ([0-9a-f]{8}) [tTwW] (.+)$/.exec(line.trim());
    if (m) out.push({ name: m[3], addr: parseInt(m[1], 16) & ~1, size: parseInt(m[2], 16) });
  }
  out.sort((a, b) => a.addr - b.addr);
  return out;
}

/** Bir sembolün adresi (her türden; `_SEGGER_RTT` gibi alt çizgili adlar dahil) */
function symbolAddr(elf, name, nm = 'arm-none-eabi-nm') {
  return new Promise((resolve) => {
    if (!elf || !fs.existsSync(elf)) return resolve(undefined);
    execFile(nm, ['--defined-only', elf], { windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) return resolve(undefined);
      const m = new RegExp(`^([0-9a-f]{8}) \\w ${name.replace(/[$.]/g, '\\$&')}$`, 'm').exec(stdout.replace(/\r/g, ''));
      resolve(m ? parseInt(m[1], 16) : undefined);
    });
  });
}

class PcProfile {
  /** @param {{ name: string, addr: number, size: number }[]} funcs adrese göre sıralı */
  constructor(funcs) {
    this.funcs = funcs || [];
    this.reset();
  }
  reset() {
    /** @type {Map<string, number>} */
    this.counts = new Map();
    this.total = 0;
    this.sleep = 0;
  }
  /** PC → fonksiyon adı (ikili arama; boyutu 0 olan sembolde bir sonrakine kadar) */
  lookup(pc) {
    const F = this.funcs;
    let lo = 0, hi = F.length - 1, best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (F[mid].addr <= pc) { best = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (best < 0) return null;
    const f = F[best];
    const end = f.size ? f.addr + f.size : best + 1 < F.length ? F[best + 1].addr : f.addr + 0x1000;
    return pc < end ? f.name : null;
  }
  add(pc) {
    this.total++;
    const name = this.lookup(pc & ~1) || `0x${(pc >>> 0).toString(16).padStart(8, '0')}`;
    this.counts.set(name, (this.counts.get(name) || 0) + 1);
  }
  addSleep() { this.total++; this.sleep++; }
  /** En çok örneklenen n fonksiyon; uyku (WFI/WFE) ayrı satır */
  top(n = 30) {
    const rows = [...this.counts].map(([name, count]) => ({ name, count, pct: this.total ? (100 * count) / this.total : 0 }));
    if (this.sleep) rows.push({ name: t('(uyku: WFI/WFE)'), count: this.sleep, pct: (100 * this.sleep) / this.total, sleep: true });
    return rows.sort((a, b) => b.count - a.count).slice(0, n);
  }
}

// ------------------------------------------------------------------ SEGGER RTT
const RTT_ID = 'SEGGER RTT';
const DESC_WORDS = 6; // sName, pBuffer, SizeOfBuffer, WrOff, RdOff, Flags

const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;

class RttClient {
  /** @param {any} target readMemory(addr, words), writeMemory(addr, width, value), isteğe bağlı writeBytes(addr, bytes) */
  constructor(target) {
    this.target = target;
    this.addr = 0;
    /** @type {{ index: number, dir: 'up'|'down', name: string, buf: number, size: number, desc: number }[]} */
    this.channels = [];
  }

  /**
   * Kontrol bloğunu bulur: verilen adreste (ELF'teki _SEGGER_RTT) ya da RAM'de "SEGGER RTT" kimliğini arayarak.
   * @param {{ addr?: number, ramStart?: number, ramSize?: number }} o
   */
  async find(o) {
    let addr = o.addr;
    if (addr !== undefined && !(await this.isBlock(addr))) addr = undefined;
    if (addr === undefined) addr = await this.scan(o.ramStart ?? 0x20000000, o.ramSize ?? 0x10000);
    if (addr === undefined) throw new Error(t('RTT kontrol bloğu bulunamadı. Firmware SEGGER_RTT_Init() (ya da es_trace_init()) çağırdı mı ve çalışıyor mu?'));
    this.addr = addr;
    await this.readChannels();
    return { addr, channels: this.channels };
  }

  async isBlock(addr) {
    try {
      const b = await readRegion(this.target, addr, 16);
      return Buffer.from(b).toString('latin1').startsWith(RTT_ID + '\0');
    } catch {
      return false;
    }
  }

  /** RAM'de kimliği arar (1 KB'lık parçalar, parça sınırında kalan kimlik için 16 bayt örtüşme) */
  async scan(start, size) {
    const id = Buffer.from(RTT_ID + '\0', 'latin1');
    const CH = 1024;
    for (let a = start; a < start + size; a += CH) {
      const len = Math.min(CH + 16, start + size - a);
      let b;
      try { b = Buffer.from(await readRegion(this.target, a, len)); } catch { continue; }
      const k = b.indexOf(id);
      if (k >= 0 && k % 4 === 0) return a + k;
    }
    return undefined;
  }

  async readChannels() {
    const head = await readRegion(this.target, this.addr + 16, 8);
    const maxUp = le32(head, 0), maxDown = le32(head, 4);
    if (maxUp > 16 || maxDown > 16) throw new Error(t('RTT kontrol bloğu geçersiz (kanal sayısı {0}/{1}).', maxUp, maxDown));
    const descBase = this.addr + 24;
    const d = await readRegion(this.target, descBase, (maxUp + maxDown) * DESC_WORDS * 4);
    this.channels = [];
    for (let k = 0; k < maxUp + maxDown; k++) {
      const o = k * DESC_WORDS * 4;
      const size = le32(d, o + 8), buf = le32(d, o + 4);
      if (!size || !buf) continue; // ayrılmış ama kurulmamış kanal
      const up = k < maxUp;
      this.channels.push({ index: up ? k : k - maxUp, dir: up ? 'up' : 'down', name: await this.cstr(le32(d, o)), buf, size, desc: descBase + o });
    }
    return this.channels;
  }

  async cstr(addr) {
    if (!addr) return '';
    try {
      const b = Buffer.from(await readRegion(this.target, addr, 32));
      const z = b.indexOf(0);
      return b.subarray(0, z < 0 ? 32 : z).toString('latin1');
    } catch {
      return '';
    }
  }

  /** Up kanallarındaki yeni baytlar: [{ index, bytes }] (okunan kadar RdOff ilerletilir) */
  async poll() {
    const out = [];
    for (const ch of this.channels.filter((c) => c.dir === 'up')) {
      const [wr, rd] = await this.target.readMemory(ch.desc + 12, 2);
      if (wr === rd || wr >= ch.size || rd >= ch.size) continue;
      let bytes;
      if (wr > rd) bytes = await readRegion(this.target, ch.buf + rd, wr - rd);
      else {
        const a = await readRegion(this.target, ch.buf + rd, ch.size - rd);
        const b = wr ? await readRegion(this.target, ch.buf, wr) : new Uint8Array(0);
        bytes = new Uint8Array([...a, ...b]);
      }
      await this.target.writeMemory(ch.desc + 16, 32, wr);
      out.push({ index: ch.index, bytes });
    }
    return out;
  }

  /** Down kanalına yazar; sığan bayt sayısını döndürür (dolu tampon taşırılmaz) */
  async write(index, bytes) {
    const ch = this.channels.find((c) => c.dir === 'down' && c.index === index);
    if (!ch) throw new Error(t('RTT down kanalı {0} yok.', index));
    const [wr, rd] = await this.target.readMemory(ch.desc + 12, 2);
    const free = rd > wr ? rd - wr - 1 : ch.size - wr + rd - 1;
    const n = Math.min(free, bytes.length);
    if (!n) return 0;
    const first = Math.min(n, ch.size - wr);
    await writeBytes(this.target, ch.buf + wr, bytes.subarray(0, first));
    if (n > first) await writeBytes(this.target, ch.buf, bytes.subarray(first, n));
    await this.target.writeMemory(ch.desc + 12, 32, (wr + n) % ch.size);
    return n;
  }
}

/** Bayt dizisi yazma: hedefte toplu yazma varsa onu kullanır */
async function writeBytes(target, addr, bytes) {
  if (!bytes.length) return;
  if (target.writeBytes) return target.writeBytes(addr, bytes);
  for (let k = 0; k < bytes.length; k++) await target.writeMemory(addr + k, 8, bytes[k]);
}

// ------------------------------------------------------------------ Simülasyon
/** Simülasyonda PC örneklerinin dağıldığı fonksiyonlar (ELF yokken profil de bunları kullanır) */
const SIM_FUNCS = [
  { name: 'Reset_Handler', addr: 0x08000188, size: 0x50, w: 0 },
  { name: 'main', addr: 0x08000400, size: 0xa0, w: 7 },
  { name: 'App_Loop', addr: 0x080004a0, size: 0x120, w: 9 },
  { name: 'bsp_i2c_read', addr: 0x080005c0, size: 0x90, w: 14 },
  { name: 'sensor_read', addr: 0x08000650, size: 0xe0, w: 11 },
  { name: 'telemetry_send', addr: 0x08000730, size: 0x70, w: 8 },
  { name: 'vsnprintf', addr: 0x080007a0, size: 0x400, w: 16 },
  { name: 'memcpy', addr: 0x08000ba0, size: 0x40, w: 4 },
  { name: 'HAL_Delay', addr: 0x08000be0, size: 0x30, w: 18 },
  { name: 'SysTick_Handler', addr: 0x08000c10, size: 0x10, w: 3 },
  { name: 'HAL_IncTick', addr: 0x08000c20, size: 0x20, w: 2 }
];
/** Uyku örneği ağırlığı */
const SIM_SLEEP_W = 7;

/** ITM yazılım paketi: port, 1 bayt */
const itmByte = (port, b) => [(port << 3) | 1, b & 0xff];
/** Uzun yerel zaman damgası paketi */
function itmTs(delta) {
  const out = [0xc0];
  let v = Math.max(1, delta >>> 0);
  do { const b = v & 0x7f; v >>>= 7; out.push(b | (v ? 0x80 : 0)); } while (v && out.length < 5);
  return out;
}
/** DWT donanım paketi (ayırt edici id, size 1/2/4) */
function dwtPacket(id, size, v) {
  const out = [(id << 3) | 4 | { 1: 1, 2: 2, 4: 3 }[size]];
  for (let k = 0; k < size; k++) out.push((v >>> (8 * k)) & 0xff);
  return out;
}

// ------------------------------------------------------------------ oturum
/**
 * Bir hedefin SWO/RTT/semihosting akışlarını yönetir ve webview'a toplu gönderir.
 * Mesajlar: debug.console { items: [{ src, ch, text }] }, debug.profile, debug.dtrace, debug.trace (durum)
 */
class TraceSession {
  /** @param {any} target @param {(m: any) => void} post */
  constructor(target, post) {
    this.target = target;
    this.post = post;
    this.swo = null; // { cfg, decoder, profile, text: Map<port, TextDecoder> }
    this.rtt = null; // { client, timer, decoders }
    this.semi = false;
    /** @type {{ src: string, ch: number, text: string }[]} */
    this.pending = [];
    /** @type {any[]} */
    this.dpending = [];
    this.flushTimer = setInterval(() => this.flush(), 100);
    this.profTimer = setInterval(() => this.postProfile(), 1000);
    this.lastPc = new Map();
  }

  status(extra = {}) {
    const s = this.swo;
    this.post({
      type: 'debug.trace', swo: !!s, rate: s && s.pcRate, overflows: s ? s.decoder.overflows : 0, swoHz: s && s.actualHz,
      rtt: this.rtt ? { addr: this.rtt.client.addr, channels: this.rtt.client.channels.map(({ index, dir, name, size }) => ({ index, dir, name, size })) } : null,
      semi: this.semi, ...extra
    });
  }

  emit(src, ch, text) {
    if (!text) return;
    const last = this.pending[this.pending.length - 1];
    if (last && last.src === src && last.ch === ch) last.text += text;
    else this.pending.push({ src, ch, text });
  }

  flush() {
    if (this.pending.length) { this.post({ type: 'debug.console', items: this.pending }); this.pending = []; }
    if (this.dpending.length) { this.post({ type: 'debug.dtrace', items: this.dpending }); this.dpending = []; }
  }

  /**
   * @param {{ cpuHz: number, swoHz: number, ports: number, ts?: boolean, pc?: boolean, exc?: boolean,
   *   data?: { name: string, addr: number, size: number, pc?: boolean }[], funcs?: any[] }} cfg
   */
  async startSwo(cfg) {
    await this.stopSwo();
    if (!this.target.startSwo) throw new Error(t('Bu bağlantı SWO desteklemiyor.'));
    if (!(cfg.cpuHz > 0 && cfg.swoHz > 0)) throw new Error(t('Çekirdek saati ve SWO frekansı girilmeli.'));
    if (cfg.swoHz > cfg.cpuHz) throw new Error(t('SWO frekansı çekirdek saatinden büyük olamaz.'));
    const { actualHz } = swoPrescaler(cfg.cpuHz, cfg.swoHz);
    const pc = cfg.pc ? pcSampleConfig(cfg.cpuHz, actualHz) : null;
    const s = {
      cfg, decoder: new ItmDecoder(), profile: new PcProfile(cfg.funcs || []), pcRate: pc ? pc.rate : 0, actualHz,
      /** @type {Map<number, TextDecoder>} */ text: new Map()
    };
    this.swo = s;
    try {
      await this.target.startSwo({ ...cfg, pcCfg: pc }, (bytes) => this.onSwo(s, bytes));
      for (const [a, w, v] of itmSetup({ ports: cfg.ports, ts: cfg.ts, pc, exc: cfg.exc, data: cfg.data })) await this.target.writeMemory(a, w, v);
    } catch (e) {
      this.swo = null;
      await this.target.stopSwo?.().catch(() => {});
      throw e;
    }
    this.status();
  }

  onSwo(s, bytes) {
    if (this.swo !== s) return;
    for (const e of s.decoder.push(bytes)) {
      if (e.type === 'sw') {
        if (!s.text.has(e.port)) s.text.set(e.port, new TextDecoder('utf-8'));
        const b = new Uint8Array(e.size);
        for (let k = 0; k < e.size; k++) b[k] = (e.value >>> (8 * k)) & 0xff;
        this.emit('itm', e.port, s.text.get(e.port).decode(b, { stream: true }));
      } else if (e.type === 'pc') {
        if (e.sleep) s.profile.addSleep(); else s.profile.add(e.pc);
      } else if (e.type === 'dpc') this.lastPc.set(e.cmp, e.pc);
      else if (e.type === 'data') {
        const d = (s.cfg.data || [])[e.cmp];
        this.dpending.push({ cmp: e.cmp, name: d ? d.name : `#${e.cmp}`, value: e.value, size: e.size, write: e.write, pc: this.lastPc.get(e.cmp), ts: e.ts, t: Date.now() });
        this.lastPc.delete(e.cmp);
      } else if (e.type === 'overflow' && s.decoder.overflows % 50 === 1) this.status({ warn: t('SWO taşması: veri kayboluyor. SWO frekansını artırın, PC örneklemeyi ya da port sayısını azaltın.') });
    }
    if (this.dpending.length > 2000) this.dpending.splice(0, this.dpending.length - 2000);
  }

  postProfile() {
    const s = this.swo;
    if (!s || !s.cfg.pc) return;
    this.post({ type: 'debug.profile', total: s.profile.total, rate: s.pcRate, rows: s.profile.top(40) });
  }

  resetProfile() {
    if (this.swo) this.swo.profile.reset();
    this.postProfile();
  }

  async stopSwo() {
    const s = this.swo;
    if (!s) return;
    this.swo = null;
    try { for (const [a, w, v] of itmStop()) await this.target.writeMemory(a, w, v); } catch { /* bağlantı gitmiş olabilir */ }
    await this.target.stopSwo?.().catch(() => {});
    this.flush();
    this.status();
  }

  /** @param {{ addr?: number, ramStart: number, ramSize: number, intervalMs?: number }} o */
  async startRtt(o) {
    await this.stopRtt();
    const client = new RttClient(this.target);
    await client.find(o);
    /** @type {Map<number, TextDecoder>} */
    const decoders = new Map();
    const r = { client, decoders, timer: null, busy: false };
    this.rtt = r;
    const tick = async () => {
      if (this.rtt !== r || r.busy) return;
      r.busy = true;
      try {
        for (const { index, bytes } of await client.poll()) {
          if (!decoders.has(index)) decoders.set(index, new TextDecoder('utf-8'));
          this.emit('rtt', index, decoders.get(index).decode(bytes, { stream: true }));
        }
      } catch (e) {
        // Okuma hatası (hedef resetlendi, bağlantı koptu): durdur ve bildir
        if (this.rtt === r) { this.rtt = null; clearInterval(r.timer); this.status({ error: t('RTT okunamadı: {0}', e.message) }); }
      } finally {
        r.busy = false;
      }
    };
    r.timer = setInterval(tick, o.intervalMs || 100);
    this.status();
  }

  async stopRtt() {
    if (!this.rtt) return;
    clearInterval(this.rtt.timer);
    this.rtt = null;
    this.status();
  }

  /** Down kanalına metin; satır sonu eklenir. Sığmayan kısım için hata */
  async rttSend(index, text, eol = '\n') {
    if (!this.rtt) throw new Error(t('RTT başlatılmadı.'));
    const bytes = new TextEncoder().encode(text + eol);
    const n = await this.rtt.client.write(index, bytes);
    if (n < bytes.length) throw new Error(t('RTT down tamponu dolu: {0}/{1} bayt gönderildi.', n, bytes.length));
    return n;
  }

  async semihosting(on) {
    if (!this.target.semihosting) throw new Error(t('Bu bağlantı semihosting desteklemiyor.'));
    await this.target.semihosting(on, (text) => this.emit('semi', 0, text));
    this.semi = !!on;
    this.status();
  }

  async dispose() {
    clearInterval(this.flushTimer);
    clearInterval(this.profTimer);
    await this.stopSwo().catch(() => {});
    await this.stopRtt().catch(() => {});
    if (this.semi) {
      await this.target.semihosting?.(false).catch(() => {});
      this.semi = false;
      this.status();
    }
  }
}

module.exports = {
  REG, DWT_COMPARATORS, ItmDecoder, pcSampleConfig, swoPrescaler, parsePorts, itmSetup, itmStop, dataTraceWrites,
  functionSymbols, parseFunctions, symbolAddr, PcProfile, RttClient, writeBytes, TraceSession,
  SIM_FUNCS, SIM_SLEEP_W, itmByte, itmTs, dwtPacket
};
