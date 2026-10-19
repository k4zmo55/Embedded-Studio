// @ts-check
/**
 * ST sistem bootloader'ı (ES-302): yongadaki ROM bootloader ile ST-Link olmadan yükleme.
 *  - UART protokolü (AN3155): senkron (0x7F), GET, GET_VERSION, GET_ID, READ, WRITE, ERASE / EXTENDED ERASE, GO.
 *  - Simülasyon: protokolün cihaz tarafı (kart yokken ve testlerde).
 *  - BootTarget: Programlayıcı sekmesinin kullandığı hedef arayüzü (readMemory, flashBanks, eraseSectors, writeFlash).
 *  - USB DFU (AN3156): dfu-util ya da STM32_Programmer_CLI komutları ve çıktı çözücüleri (Node'dan doğrudan USB erişimi yok).
 *  - AN2606: işlemci başına bootloader arayüzleri ve pinleri; kart başına BOOT0 talimatları.
 */
const { t } = require('../i18n');
const { flashLayout, FLASH_BASE } = require('./programmer');

const ACK = 0x79;
const NACK = 0x1f;
const CMD = {
  GET: 0x00, GET_VERSION: 0x01, GET_ID: 0x02, READ: 0x11, GO: 0x21, WRITE: 0x31, ERASE: 0x43, EXT_ERASE: 0x44,
  WRITE_PROTECT: 0x63, WRITE_UNPROTECT: 0x73, READ_PROTECT: 0x82, READ_UNPROTECT: 0x92
};
const CMD_NAMES = Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k]));
/** AN3155: tek READ / WRITE'ta en fazla 256 bayt */
const BLOCK = 256;

const hex = (v, w = 2) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
const xor = (bytes) => bytes.reduce((a, b) => a ^ b, 0);

/**
 * Gelen baytları biriktirir; read(n) n bayt gelene kadar bekler (zaman aşımıyla).
 */
class ByteQueue {
  constructor() {
    this.buf = Buffer.alloc(0);
    this.waiter = null;
  }
  push(data) {
    this.buf = Buffer.concat([this.buf, Buffer.from(data)]);
    this.check();
  }
  check() {
    const w = this.waiter;
    if (w && this.buf.length >= w.n) {
      this.waiter = null;
      clearTimeout(w.timer);
      const out = this.buf.subarray(0, w.n);
      this.buf = this.buf.subarray(w.n);
      w.resolve(Buffer.from(out));
    }
  }
  /** @returns {Promise<Buffer>} */
  read(n, ms) {
    if (this.waiter) return Promise.reject(new Error('ByteQueue: eşzamanlı okuma'));
    return new Promise((resolve, reject) => {
      const timer = ms > 0 ? setTimeout(() => {
        this.waiter = null;
        reject(Object.assign(new Error(t('Bootloader yanıt vermedi ({0} ms).', ms)), { timeout: true }));
      }, ms) : null;
      this.waiter = { n, resolve, reject, timer };
      this.check();
    });
  }
  /** Bekleyen okumayı hatayla bitirir (bağlantı koptu) */
  fail(err) {
    const w = this.waiter;
    if (!w) return;
    this.waiter = null;
    clearTimeout(w.timer);
    w.reject(err);
  }
  clear() { this.buf = Buffer.alloc(0); }
}

/**
 * AN3155 UART bootloader istemcisi.
 * @param {{ write: (b: Buffer) => void }} port  baytları cihaza gönderen nesne; gelen baytlar feed() ile verilir
 */
class UartBootloader {
  constructor(port, opts = {}) {
    this.port = port;
    this.q = new ByteQueue();
    this.timeout = opts.timeoutMs || 1000;
    this.eraseTimeout = opts.eraseTimeoutMs || 60000;
    this.commands = [];
    this.version = 0;
  }
  feed(data) { this.q.push(data); }
  send(bytes) { this.port.write(Buffer.from(bytes)); }

  async ack(ms = this.timeout, what = '') {
    const [b] = await this.q.read(1, ms);
    if (b === ACK) return;
    if (b === NACK) throw Object.assign(new Error(t('Bootloader reddetti (NACK){0}.', what ? `: ${what}` : '')), { nack: true });
    throw new Error(t('Beklenmeyen yanıt {0}{1}. Baud, parite (çift) ya da bağlantı hatalı olabilir.', hex(b), what ? ` (${what})` : ''));
  }

  /** 0x7F ile baud algılama; zaten senkronsa bootloader NACK döner, o da kabul */
  async sync(tries = 4) {
    let last;
    for (let i = 0; i < tries; i++) {
      this.q.clear();
      this.send([0x7f]);
      try {
        const [b] = await this.q.read(1, 300);
        if (b === ACK || b === NACK) return;
        last = new Error(t('Beklenmeyen yanıt {0}. Baud, parite (çift) ya da bağlantı hatalı olabilir.', hex(b)));
      } catch (e) {
        last = e;
      }
    }
    throw new Error(t('Bootloader bulunamadı: 0x7F gönderildi, yanıt gelmedi. BOOT0 = 1 iken reset atın; TX/RX çapraz, GND ortak, 8E1 olmalı.') + (last && !last.timeout ? ` (${last.message})` : ''));
  }

  async cmd(c) {
    this.send([c, c ^ 0xff]);
    await this.ack(this.timeout, CMD_NAMES[c] || hex(c));
  }
  addr(a) {
    const b = [(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff];
    return [...b, xor(b)];
  }

  async get() {
    await this.cmd(CMD.GET);
    const [n] = await this.q.read(1, this.timeout);
    const data = await this.q.read(n + 1, this.timeout);
    await this.ack();
    this.version = data[0];
    this.commands = [...data.subarray(1)];
    return { version: this.version, commands: this.commands };
  }
  async getVersion() {
    await this.cmd(CMD.GET_VERSION);
    const d = await this.q.read(3, this.timeout);
    await this.ack();
    return { version: d[0], option1: d[1], option2: d[2] };
  }
  async getId() {
    await this.cmd(CMD.GET_ID);
    const [n] = await this.q.read(1, this.timeout);
    const d = await this.q.read(n + 1, this.timeout);
    await this.ack();
    return (d[0] << 8) | d[1];
  }

  /** En fazla 256 bayt okur */
  async read(address, n) {
    if (n < 1 || n > BLOCK) throw new Error(`read: 1..${BLOCK}`);
    await this.cmd(CMD.READ);
    this.send(this.addr(address));
    await this.ack(this.timeout, t('adres {0}', hex(address, 8)));
    this.send([n - 1, (n - 1) ^ 0xff]);
    await this.ack();
    return this.q.read(n, this.timeout + n);
  }

  /** En fazla 256 bayt yazar; uzunluk 4'ün katına 0xFF ile tamamlanır */
  async write(address, bytes) {
    const pad = (4 - (bytes.length % 4)) % 4;
    const data = Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad, 0xff)]);
    if (!data.length || data.length > BLOCK) throw new Error(`write: 1..${BLOCK}`);
    await this.cmd(CMD.WRITE);
    this.send(this.addr(address));
    await this.ack(this.timeout, t('adres {0}', hex(address, 8)));
    const payload = [data.length - 1, ...data];
    this.send([...payload, xor(payload)]);
    await this.ack(this.timeout + 2000, t('yazma {0}', hex(address, 8)));
  }

  /**
   * Sayfa / sektör silme. pages: numara listesi ya da 'all' (tamamı).
   * EXTENDED ERASE (0x44) varsa 2 baytlık numaralar, yoksa eski ERASE (0x43).
   */
  async erase(pages) {
    const ext = this.commands.includes(CMD.EXT_ERASE) || !this.commands.includes(CMD.ERASE);
    if (ext) {
      await this.cmd(CMD.EXT_ERASE);
      if (pages === 'all') this.send([0xff, 0xff, 0x00]);
      else {
        const body = [((pages.length - 1) >> 8) & 0xff, (pages.length - 1) & 0xff];
        for (const p of pages) body.push((p >> 8) & 0xff, p & 0xff);
        this.send([...body, xor(body)]);
      }
    } else {
      await this.cmd(CMD.ERASE);
      if (pages === 'all') this.send([0xff, 0x00]);
      else {
        if (pages.some((p) => p > 255)) throw new Error(t('Eski ERASE komutu 255\'ten büyük sayfa numarasını desteklemiyor.'));
        const body = [pages.length - 1, ...pages];
        this.send([...body, xor(body)]);
      }
    }
    await this.ack(this.eraseTimeout, t('silme'));
  }

  /** Programı çalıştırır (bootloader'dan çıkar); adres: vektör tablosu (ör. 0x08000000) */
  async go(address) {
    await this.cmd(CMD.GO);
    this.send(this.addr(address));
    await this.ack(this.timeout, 'GO');
  }
}

// ------------------------------------------------------------------ simülasyon (cihaz tarafı)
/**
 * Sistem bootloader'ının cihaz tarafı: senkron, komutlar, flash (silinmeden yazılamaz: AND), RAM, GO.
 * @param {{ pid: number, layout: { index: number, addr: number, size: number }[], flashSize: number, ramKB: number, legacyErase?: boolean, out: (b: Buffer) => void }} o
 */
class SimBootloader {
  constructor(o) {
    this.o = o;
    this.flash = new Uint8Array(o.flashSize).fill(0xff);
    this.ram = new Uint8Array(o.ramKB * 1024);
    this.q = new ByteQueue();
    this.synced = false;
    this.running = false;
    this.version = 0x31;
    this.commands = [CMD.GET, CMD.GET_VERSION, CMD.GET_ID, CMD.READ, CMD.GO, CMD.WRITE, o.legacyErase ? CMD.ERASE : CMD.EXT_ERASE, CMD.WRITE_PROTECT, CMD.WRITE_UNPROTECT, CMD.READ_PROTECT, CMD.READ_UNPROTECT];
    this.log = [];
    this.loop();
  }
  receive(b) { if (!this.running) this.q.push(b); }
  reply(...bytes) { this.o.out(Buffer.from(bytes.flat())); }
  /** Bootloader'a yeniden giriş (BOOT0 = 1 iken reset) */
  reset() { this.synced = false; this.running = false; this.q.clear(); }
  mem(addr, n) {
    const fe = FLASH_BASE + this.flash.length;
    if (addr >= FLASH_BASE && addr + n <= fe) return { buf: this.flash, off: addr - FLASH_BASE, flash: true };
    if (addr >= 0x20000000 && addr + n <= 0x20000000 + this.ram.length) return { buf: this.ram, off: addr - 0x20000000, flash: false };
    return null;
  }
  async loop() {
    const q = this.q;
    for (;;) {
      let c;
      try {
        [c] = await q.read(1, 0);
      } catch { return; }
      if (!this.synced) {
        if (c === 0x7f) { this.synced = true; this.reply(ACK); }
        continue;
      }
      if (c === 0x7f) { this.reply(NACK); continue; }
      const [cc] = await q.read(1, 0);
      if ((c ^ cc) !== 0xff || !this.commands.includes(c)) { this.reply(NACK); continue; }
      this.log.push(CMD_NAMES[c]);
      this.reply(ACK);
      await this.run(c);
    }
  }
  async addr() {
    const b = [...(await this.q.read(5, 0))];
    if (xor(b.slice(0, 4)) !== b[4]) return null;
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }
  async run(c) {
    const q = this.q;
    if (c === CMD.GET) return this.reply(this.commands.length, this.version, this.commands, ACK);
    if (c === CMD.GET_VERSION) return this.reply(this.version, 0, 0, ACK);
    if (c === CMD.GET_ID) return this.reply(1, (this.o.pid >> 8) & 0xff, this.o.pid & 0xff, ACK);
    if (c === CMD.READ || c === CMD.WRITE || c === CMD.GO) {
      const a = await this.addr();
      if (a === null) return this.reply(NACK);
      if (c === CMD.GO) {
        if (!this.mem(a, 4)) return this.reply(NACK);
        this.reply(ACK);
        this.running = true; // uygulama çalışıyor: bootloader artık yanıt vermez
        return;
      }
      if (c === CMD.READ) {
        this.reply(ACK);
        const [n1, nc] = await q.read(2, 0);
        const m = this.mem(a, n1 + 1);
        if ((n1 ^ nc) !== 0xff || !m) return this.reply(NACK);
        return this.reply(ACK, [...m.buf.subarray(m.off, m.off + n1 + 1)]);
      }
      this.reply(ACK);
      const [n1] = await q.read(1, 0);
      const data = [...(await q.read(n1 + 1, 0))];
      const [cs] = await q.read(1, 0);
      const m = this.mem(a, n1 + 1);
      if (xor([n1, ...data]) !== cs || !m || a % 4) return this.reply(NACK);
      data.forEach((b, i) => { m.buf[m.off + i] = m.flash ? m.buf[m.off + i] & b : b; });
      return this.reply(ACK);
    }
    if (c === CMD.EXT_ERASE) {
      const [h, l] = await q.read(2, 0);
      const n = (h << 8) | l;
      if (n >= 0xfff0) {
        const [cs] = await q.read(1, 0);
        if (cs !== (h ^ l)) return this.reply(NACK);
        if (n === 0xffff) this.flash.fill(0xff);
        return this.reply(ACK);
      }
      const raw = [...(await q.read((n + 1) * 2, 0))];
      const [cs] = await q.read(1, 0);
      if (xor([h, l, ...raw]) !== cs) return this.reply(NACK);
      for (let i = 0; i < raw.length; i += 2) if (!this.erasePage((raw[i] << 8) | raw[i + 1])) return this.reply(NACK);
      return this.reply(ACK);
    }
    if (c === CMD.ERASE) {
      const [n] = await q.read(1, 0);
      if (n === 0xff) {
        const [cs] = await q.read(1, 0);
        if (cs !== 0) return this.reply(NACK);
        this.flash.fill(0xff);
        return this.reply(ACK);
      }
      const pages = [...(await q.read(n + 1, 0))];
      const [cs] = await q.read(1, 0);
      if (xor([n, ...pages]) !== cs) return this.reply(NACK);
      for (const p of pages) if (!this.erasePage(p)) return this.reply(NACK);
      return this.reply(ACK);
    }
    // Koruma komutları: iki ACK (ikincisi işlemden sonra) ve sistem reseti
    this.reply(ACK);
    if (c === CMD.READ_UNPROTECT) this.flash.fill(0xff);
    this.reset();
  }
  erasePage(p) {
    const s = this.o.layout[p];
    if (!s) return false;
    this.flash.fill(0xff, s.addr - FLASH_BASE, s.addr - FLASH_BASE + s.size);
    return true;
  }
}

// ------------------------------------------------------------------ Programlayıcı hedefi
/**
 * Programlayıcı sekmesinin hedef arayüzü bootloader üzerinden. Bootloader sektör listesi vermez: işlemci verisinden.
 * Sayfa / sektör numarası flashLayout'taki sıra numarasıdır (H7'de ikinci bankın sektörleri 8…15).
 */
class BootTarget {
  /**
   * @param {UartBootloader} boot @param {any} mcu
   * @param {{ close?: () => Promise<void> | void, exit?: () => Promise<void> | void }} [hooks]
   */
  constructor(boot, mcu, hooks = {}) {
    this.boot = boot;
    this.mcu = mcu;
    this.hooks = hooks;
    this.mode = 'bootloader';
    this.layout = flashLayout(mcu);
    this.info = null;
  }
  async connect() {
    await this.boot.sync();
    const g = await this.boot.get();
    const pid = await this.boot.getId();
    this.info = { version: g.version, commands: g.commands.map((c) => CMD_NAMES[c] || hex(c)), pid };
    return this.info;
  }
  async state() { return this.left ? 'running' : 'bootloader'; }
  async readMemory(addr, words) {
    const out = [];
    const bytes = await this.readBytes(addr, words * 4);
    for (let i = 0; i < words; i++) out.push(bytes.readUInt32LE(i * 4));
    return out;
  }
  async readBytes(addr, length) {
    const parts = [];
    for (let off = 0; off < length; off += BLOCK) parts.push(await this.boot.read(addr + off, Math.min(BLOCK, length - off)));
    return Buffer.concat(parts);
  }
  async flashBanks() {
    const banks = [];
    for (const s of this.layout) {
      if (!banks[s.bank]) banks[s.bank] = { driver: 'bootloader', base: s.addr, size: 0, sectors: [] };
      banks[s.bank].sectors.push({ num: s.num, addr: s.addr, size: s.size, protected: false });
      banks[s.bank].size += s.size;
    }
    return banks;
  }
  async eraseSectors(bank, first, last) {
    const idx = this.layout.filter((s) => s.bank === bank && s.num >= first && s.num <= last).map((s) => s.index);
    const all = idx.length === this.layout.length;
    await this.boot.erase(all ? 'all' : idx);
  }
  /** @param {(done: number) => void} [progress] */
  async writeFlash(addr, bytes, progress) {
    for (let off = 0; off < bytes.length; off += BLOCK) {
      const part = bytes.subarray(off, Math.min(bytes.length, off + BLOCK));
      // Tamamı 0xFF olan blok silinmiş flash'ta zaten öyle: atla
      if (!part.every((b) => b === 0xff)) await this.boot.write(addr + off, part);
      progress && progress(Math.min(bytes.length, off + BLOCK));
    }
  }
  /** Uygulamayı çalıştır: GO (vektör tablosu); bağlantı bootloader'dan çıkar */
  async reset() {
    await this.boot.go(FLASH_BASE);
    this.left = true;
    if (this.hooks.exit) await this.hooks.exit();
  }
  async disconnect() {
    if (this.hooks.close) await this.hooks.close();
  }
}

/**
 * Simülasyon hedefi: SimBootloader + UartBootloader bellekte bağlı. opts.dev verilirse aynı sanal cihaz yeniden
 * kullanılır (BOOT0 = 1 iken reset: flash içeriği korunur).
 */
function simBoot(mcu, pid, opts = {}) {
  let dev = opts.dev;
  const boot = new UartBootloader({ write: (b) => setImmediate(() => dev.receive(b)) }, opts);
  const out = (b) => setImmediate(() => boot.feed(b));
  if (dev) {
    dev.o.out = out;
    dev.reset();
  } else dev = new SimBootloader({ pid, layout: flashLayout(mcu), flashSize: mcu.device.flashKB * 1024, ramKB: mcu.device.ramKB, legacyErase: opts.legacyErase, out });
  return { boot, dev };
}

/**
 * DTR / RTS ile bootloader'a giriş (USB-UART dönüştürücüde RTS → BOOT0, DTR → NRST; sinyal etkinken pin düşük).
 * @param {(dtr: boolean, rts: boolean) => void} signals @param {'enter'|'exit'} what
 */
async function resetSequence(signals, what, wait = (ms) => new Promise((r) => setTimeout(r, ms))) {
  const boot0High = what === 'enter';
  signals(false, !boot0High); // BOOT0 ayarla, NRST serbest
  await wait(20);
  signals(true, !boot0High); // NRST düşük
  await wait(100);
  signals(false, !boot0High); // NRST serbest: yeni BOOT0 ile açılır
  await wait(150);
}

// ------------------------------------------------------------------ USB DFU (araçla)
/**
 * `dfu-util -l` çıktısı → aygıtlar.
 * Found DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-2", alt=0, name="@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg", serial="3276365C3430"
 */
function parseDfuList(text) {
  const out = [];
  for (const m of (text || '').matchAll(/Found DFU:\s*\[([0-9a-f]{4}):([0-9a-f]{4})\][^\n]*?alt=(\d+),\s*name="([^"]*)"(?:,\s*serial="([^"]*)")?/gi)) {
    out.push({ vid: m[1].toLowerCase(), pid: m[2].toLowerCase(), alt: Number(m[3]), name: m[4], serial: m[5] || '', st: m[1].toLowerCase() === '0483' && m[2].toLowerCase() === 'df11', memory: parseDfuMemory(m[4]) });
  }
  return out;
}

/** DfuSe bellek tanımı "@Internal Flash  /0x08000000/04*016Kg,01*064Kg" → bölümler */
function parseDfuMemory(name) {
  const m = /^@([^/]+?)\s*\/\s*(0x[0-9a-f]+)\s*\/(.+)$/i.exec((name || '').trim());
  if (!m) return null;
  let addr = parseInt(m[2], 16);
  const sectors = [];
  for (const part of m[3].split(',')) {
    const p = /^\s*(\d+)\*(\d+)\s*([BKM ])([a-g])/i.exec(part);
    if (!p) continue;
    const size = Number(p[2]) * (/k/i.test(p[3]) ? 1024 : /m/i.test(p[3]) ? 1048576 : 1);
    const attr = p[4].toLowerCase().charCodeAt(0) - 96; // a=1: okunur, b=2: silinir, d=4: yazılır
    for (let i = 0; i < Number(p[1]); i++) {
      sectors.push({ addr, size, readable: !!(attr & 1), erasable: !!(attr & 2), writable: !!(attr & 4) });
      addr += size;
    }
  }
  return { name: m[1].trim(), base: parseInt(m[2], 16), sectors };
}

/** dfu-util ilerleme satırı: "Download	[=========                ]  38%" ya da "Erase    	[====] 100%" */
function parseDfuProgress(line) {
  const m = /^(Download|Upload|Erase|Downloading|Uploading|Erasing)\b[^\d%]*?(\d{1,3})%/i.exec((line || '').trim());
  if (!m) return null;
  const k = m[1].toLowerCase();
  return { stage: k.startsWith('erase') ? 'erase' : k.startsWith('up') ? 'read' : 'program', percent: Number(m[2]) };
}

/**
 * dfu-util argümanları (DfuSe, ST VID:PID 0483:df11, alt 0 = dahili flash).
 * @param {{ op: 'list'|'write'|'read'|'erase', file?: string, addr?: number, length?: number, leave?: boolean, serial?: string }} o
 */
function dfuUtilArgs(o) {
  const dev = ['-d', '0483:df11', '-a', '0', ...(o.serial ? ['-S', o.serial] : [])];
  const at = (a, extra = '') => `${hex(a >>> 0, 8)}${extra}`;
  if (o.op === 'list') return ['-l'];
  if (o.op === 'write') return [...dev, '-s', at(o.addr ?? FLASH_BASE, o.leave ? ':leave' : ''), '-D', o.file];
  if (o.op === 'read') return [...dev, '-s', at(o.addr ?? FLASH_BASE, `:${o.length}`), '-U', o.file];
  if (o.op === 'erase') return [...dev, '-s', at(FLASH_BASE, ':mass-erase:force')];
  throw new Error(`dfuUtilArgs: ${o.op}`);
}

/**
 * STM32_Programmer_CLI argümanları: USB DFU (port=usb1) ya da UART (port=COMx).
 * @param {{ port: string, baud?: number, op: 'write'|'read'|'erase'|'list', file?: string, addr?: number, length?: number, verify?: boolean, go?: boolean }} o
 */
function cubeProgArgs(o) {
  if (o.op === 'list') return ['-l', /^usb/i.test(o.port) ? 'usb' : 'uart'];
  const conn = ['-c', `port=${o.port}`, ...(/^usb/i.test(o.port) ? [] : [`br=${o.baud || 115200}`, 'P=EVEN'])];
  if (o.op === 'write') return [...conn, '-w', o.file, ...(/\.bin$/i.test(o.file || '') ? [hex(o.addr ?? FLASH_BASE, 8)] : []), ...(o.verify ? ['-v'] : []), ...(o.go ? ['-g', hex(FLASH_BASE, 8)] : [])];
  if (o.op === 'read') return [...conn, '-r', hex(o.addr ?? FLASH_BASE, 8), String(o.length), o.file];
  if (o.op === 'erase') return [...conn, '-e', 'all'];
  throw new Error(`cubeProgArgs: ${o.op}`);
}

/** Araç çıktısındaki bilinen hatalar → anlaşılır açıklama */
function explainDfu(out) {
  if (/No DFU capable USB device|No STM32 target found|DFU device not found/i.test(out)) return t('DFU aygıtı bulunamadı. BOOT0 = 1 iken reset atın ve USB kablosunu (veri destekli) işlemcinin USB pinlerine (PA11/PA12) bağlayın.');
  if (/LIBUSB_ERROR_ACCESS|Cannot open DFU device|LIBUSB_ERROR_NOT_SUPPORTED/i.test(out)) return t('USB aygıtı açılamadı: Windows\'ta "STM32 BOOTLOADER" için WinUSB sürücüsü gerekir (Zadig ya da STM32CubeProgrammer\'ın DFU sürücüsü); Linux\'ta udev kuralı.');
  if (/More than one DFU capable USB device/i.test(out)) return t('Birden fazla DFU aygıtı bağlı; birini çıkarın ya da seri numarasını seçin.');
  return '';
}

// ------------------------------------------------------------------ AN2606 ve kartlar
/**
 * AN2606'ya göre sistem bootloader arayüzleri (bu projedeki 15 işlemci). vcp: kartın ST-LINK sanal COM portu bootloader UART'ına bağlı mı.
 * Revizyona göre farklar olabilir; ayrıntı için AN2606'daki işlemci tablosu.
 */
const BOOT = {
  stm32f030c8t6: { uart: [['USART1', 'PA9', 'PA10']], dfu: null, other: [], version: '3.1' },
  stm32f103c8t6: { uart: [['USART1', 'PA9', 'PA10']], dfu: null, other: [], version: '2.2' },
  stm32f303ret6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PD5', 'PD6']], dfu: ['PA11', 'PA12'], other: [['I2C1', 'PB6', 'PB7']], version: '4.1' },
  stm32f407vgt6: { uart: [['USART1', 'PA9', 'PA10'], ['USART3', 'PB10', 'PB11'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['CAN2', 'PB13', 'PB5']], version: '3.1', note: () => t('USB DFU için HSE (8/25 MHz) kristali gerekir; bootloader HSE\'yi kendisi algılar.') },
  stm32f411ceu6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3']], dfu: ['PA11', 'PA12'], other: [['I2C1', 'PB6', 'PB7'], ['I2C2', 'PB10', 'PB3'], ['I2C3', 'PA8', 'PB4'], ['SPI1', 'PA4–PA7'], ['SPI2', 'PB12–PB15']], version: '3.1' },
  stm32f429zit6: { uart: [['USART1', 'PA9', 'PA10'], ['USART3', 'PB10', 'PB11'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['CAN2', 'PB13', 'PB5'], ['I2C1', 'PB6', 'PB9'], ['SPI1', 'PA4–PA7'], ['SPI2', 'PI0–PI3'], ['SPI4', 'PE11–PE14']], version: '9.1' },
  stm32f446ret6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PD5', 'PD6'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['CAN2', 'PB13', 'PB5'], ['I2C1', 'PB6', 'PB7'], ['SPI1', 'PA4–PA7']], version: '9.0' },
  stm32f767zit6: { uart: [['USART1', 'PA9', 'PA10'], ['USART3', 'PB10', 'PB11'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['CAN2', 'PB13', 'PB5'], ['I2C1', 'PB6', 'PB9'], ['SPI1', 'PA4–PA7']], version: '9.3' },
  stm32g071rbt6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3']], dfu: null, other: [['I2C1', 'PB6', 'PB7'], ['I2C2', 'PB10', 'PB11'], ['SPI1', 'PA1, PA4, PA6, PA7'], ['SPI2', 'PB12–PB15']], version: '11.1', vcp: true, note: () => t('G0: flash boşsa (ilk değer 0xFFFFFFFF) BOOT0 ayarlamadan da bootloader başlar (empty check).') },
  stm32g474ret6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['FDCAN1', 'PA11', 'PA12'], ['I2C2', 'PA8', 'PA9'], ['I2C3', 'PC8', 'PC9'], ['SPI1', 'PA4–PA7'], ['SPI2', 'PB12–PB15']], version: '13.3', vcp: true },
  stm32h723zgt6: { uart: [['USART1', 'PA9', 'PA10'], ['USART1', 'PB14', 'PB15'], ['USART2', 'PA2', 'PA3'], ['USART3', 'PB10', 'PB11']], dfu: ['PA11', 'PA12'], other: [['FDCAN1', 'PD1', 'PD0'], ['I2C1', 'PB6', 'PB9'], ['SPI1', 'PA4–PA7']], version: '9.1' },
  stm32h743zit6: { uart: [['USART1', 'PA9', 'PA10'], ['USART1', 'PB14', 'PB15'], ['USART2', 'PA2', 'PA3'], ['USART3', 'PB10', 'PB11']], dfu: ['PA11', 'PA12'], other: [['FDCAN1', 'PD1', 'PD0'], ['I2C1', 'PB6', 'PB9'], ['SPI1', 'PA4–PA7']], version: '9.0' },
  stm32l432kcu6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3']], dfu: ['PA11', 'PA12'], other: [['CAN1', 'PA12', 'PA11'], ['I2C1', 'PB6', 'PB7'], ['SPI1', 'PA4–PA7']], version: '10.1' },
  stm32l476rgt6: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['CAN1', 'PB9', 'PB8'], ['I2C1', 'PB6', 'PB7'], ['I2C2', 'PB10', 'PB11'], ['I2C3', 'PC0', 'PC1'], ['SPI1', 'PA4–PA7'], ['SPI2', 'PB12–PB15']], version: '10.3', vcp: true },
  stm32u575zit6q: { uart: [['USART1', 'PA9', 'PA10'], ['USART2', 'PA2', 'PA3'], ['USART3', 'PC10', 'PC11']], dfu: ['PA11', 'PA12'], other: [['FDCAN1', 'PB9', 'PB8'], ['I2C1', 'PB6', 'PB7'], ['I2C2', 'PB10', 'PB11'], ['I2C3', 'PC0', 'PC1'], ['SPI1', 'PE13–PE15, PA4'], ['SPI2', 'PB12–PB15']], version: '9.2', vcp: true }
};

/** Kart başına bootloader'a giriş talimatı */
function bootSteps(mcu) {
  const b = mcu.board || '';
  if (/Black Pill/i.test(b)) return [t('BOOT0 düğmesini basılı tutun, NRST düğmesine basıp bırakın, sonra BOOT0\'ı bırakın.'), t('USB-C kablosuyla bağlıysa aygıt "STM32 BOOTLOADER" (DFU) olarak görünür; UART için USART1 (PA9 = TX, PA10 = RX) bir USB-UART dönüştürücüye.'), t('İlk denemede DFU görünmezse işlemi tekrarlayın (F411\'de USB algılaması sıcaklığa duyarlı olabilir).')];
  if (/Blue Pill/i.test(b)) return [t('BOOT0 köprüsünü 1\'e, BOOT1 köprüsünü 0\'a alın, RESET\'e basın.'), t('USB-UART dönüştürücü: PA9 (TX) → RX, PA10 (RX) → TX, GND ortak, 3,3 V seviyesi.'), t('F103C8\'de USB DFU bootloader yok; yalnızca UART.'), t('Yüklemeden sonra BOOT0\'ı 0\'a alıp reset atın.')];
  if (/Discovery/i.test(b)) return [t('P2 başlığındaki BOOT0 pinini VDD\'ye bağlayın, RESET\'e basın.'), t('USB DFU: CN5 (micro-USB OTG) konnektörü; UART: USART1 PA9/PA10 (PA9 aynı zamanda VBUS algılamasında kullanılır).'), t('Yüklemeden sonra BOOT0 bağlantısını kaldırıp reset atın.')];
  if (/Nucleo-.*Z/i.test(b)) return [t('CN11 pin 7 (BOOT0) ile CN11 pin 5 (VDD) arasına köprü takın, RESET (B2) düğmesine basın.'), t('ST-LINK sanal COM portu bu kartta bootloader UART\'ına bağlı değil: USART1 (PA9/PA10) ya da USART3 pinlerine ayrı bir USB-UART dönüştürücü bağlayın.'), t('USB DFU: işlemcinin USB konnektörü (CN13, USB_USER).'), t('Yüklemeden sonra köprüyü çıkarıp reset atın.')];
  if (/Nucleo-L432KC/i.test(b)) return [t('PH3-BOOT0 pinini 3V3\'e bağlayın, reset atın (L4\'te nSWBOOT0 option biti 1 olmalı; fabrika değeri öyle).'), t('ST-LINK sanal COM portu PA2/PA15\'e bağlı; bootloader USART2 PA2/PA3 kullanır: USB-UART dönüştürücüyü PA2/PA3\'e bağlayın.'), t('Kartta USB DFU konnektörü yok.')];
  if (/Nucleo/i.test(b)) {
    const vcp = (BOOT[mcu.id] || {}).vcp;
    return [t('CN7 pin 7 (BOOT0) ile CN7 pin 5 (VDD) arasına köprü takın, RESET (B2) düğmesine basın.'),
      vcp ? t('ST-LINK sanal COM portu bootloader\'ın USART2 (PA2/PA3) pinlerine bağlı: ayrı dönüştürücü gerekmez, ST-LINK\'in COM portunu seçin.') : t('ST-LINK sanal COM portu bu işlemcide bootloader UART\'ına bağlı değil: USART1 (PA9/PA10) pinlerine bir USB-UART dönüştürücü bağlayın.'),
      t('Kartta işlemcinin USB konnektörü yok; DFU için PA11/PA12\'ye USB bağlantısı gerekir.'), t('Yüklemeden sonra köprüyü çıkarıp reset atın.')];
  }
  return [t('BOOT0 pinini VDD\'ye bağlayıp reset atın (BOOT1 / nBOOT1 = 1 ise sistem belleği).'), t('USART1 (PA9 = TX, PA10 = RX) pinlerine bir USB-UART dönüştürücü bağlayın; GND ortak, 3,3 V seviyesi.'), t('Yüklemeden sonra BOOT0\'ı GND\'ye alıp reset atın.')];
}

/** Arayüz için bootloader özeti */
function bootInfo(mcu) {
  const b = BOOT[mcu.id] || { uart: [['USART1', 'PA9', 'PA10']], dfu: null, other: [] };
  return {
    uart: b.uart.map(([name, tx, rx]) => ({ name, tx, rx })), dfu: b.dfu, other: b.other.map(([name, ...pins]) => ({ name, pins: pins.join(' / ') })),
    version: b.version || '', note: b.note ? b.note() : '', steps: bootSteps(mcu), vcp: !!b.vcp
  };
}

module.exports = {
  ACK, NACK, CMD, CMD_NAMES, BLOCK, ByteQueue, UartBootloader, SimBootloader, BootTarget, simBoot, resetSequence,
  parseDfuList, parseDfuMemory, parseDfuProgress, dfuUtilArgs, cubeProgArgs, explainDfu, BOOT, bootSteps, bootInfo
};
