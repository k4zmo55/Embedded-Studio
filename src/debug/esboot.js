// @ts-check
/**
 * Embedded Studio bootloader'ı (ES-303) için güncelleme istemcisi: paket biçimi, komutlar, yeniden deneme,
 * imaj başlığının çözümü ve doğrulanması. Cihaz tarafı bootloader/es_boot_core.c (C); burada aynı protokolün
 * bir benzetimi de var (kart yokken ve testlerde).
 *
 * İstek: A5 | komut | uzunluk (2, LE) | veri | CRC-32 (komut..veri)
 * Yanıt: A5 | durum (79/1F) | kod | uzunluk (2) | veri | CRC-32 (durum..veri)
 */
const { t } = require('../i18n');
const { ByteQueue } = require('./sysboot');

const SOF = 0xa5;
const ACK = 0x79;
const NACK = 0x1f;
const CMD = { INFO: 1, START: 2, DATA: 3, END: 4, BOOT: 5 };
const ERR = { 1: 'FRAME', 2: 'CMD', 3: 'ARG', 4: 'STATE', 5: 'FLASH', 6: 'VERIFY' };
const IMG = { 0: 'OK', 1: 'MAGIC', 2: 'HDR_CRC', 3: 'SIZE', 4: 'COMMIT', 5: 'CRC', 6: 'VECTORS' };
const REGION = 0x400;
const COMMIT_OFF = 0x3e0;
const IMAGE_MAGIC = 0x474d4945;
const COMMIT_MAGIC = 0x54494d43;

let TABLE = null;
/** CRC-32 (zlib); crc: önceki değer */
function crc32(data, crc = 0) {
  if (!TABLE) {
    TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
      TABLE[i] = c >>> 0;
    }
  }
  let c = ~crc >>> 0;
  for (let i = 0; i < data.length; i++) c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** Açıklamalar (arayüz ve hata metinleri) */
const imgText = (code) => ({
  0: t('geçerli'), 1: t('imaj yok (başlık bulunamadı)'), 2: t('başlık bozuk (CRC)'), 3: t('boyut ya da vektör adresi geçersiz'),
  4: t('güncelleme tamamlanmamış (commit yok)'), 5: t('imaj CRC-32 tutmuyor'), 6: t('vektör tablosu geçersiz')
}[code] || `#${code}`);
const errText = (code, detail) => ({
  1: t('paket bozuk (CRC)'), 2: t('bilinmeyen komut'), 3: t('geçersiz argüman'), 4: t('sıra hatası (önce START)'), 5: t('flash hatası'),
  6: t('doğrulama başarısız: {0}', imgText(detail))
}[code] || `#${code}`);

function frame(cmd, payload = Buffer.alloc(0)) {
  const body = Buffer.concat([Buffer.from([cmd, payload.length & 0xff, payload.length >> 8]), payload]);
  const c = Buffer.alloc(4);
  c.writeUInt32LE(crc32(body));
  return Buffer.concat([Buffer.from([SOF]), body, c]);
}

/** Başlık (64 bayt) → nesne */
function parseHeader(b) {
  const v = Buffer.from(b);
  if (v.length < 64) return null;
  const id = v.subarray(28, 60);
  const end = id.indexOf(0);
  return {
    magic: v.readUInt32LE(0), hdrVersion: v.readUInt16LE(4), hdrSize: v.readUInt16LE(6), imageSize: v.readUInt32LE(8), imageCrc: v.readUInt32LE(12),
    fwVersion: v.readUInt32LE(16), version: `${v[19]}.${v[18]}.${v.readUInt16LE(16)}`, vectorAddr: v.readUInt32LE(20), flags: v.readUInt32LE(24),
    buildId: id.subarray(0, end < 0 ? 32 : end).toString('latin1'), hdrCrc: v.readUInt32LE(60), hdrCrcOk: crc32(v.subarray(0, 60)) === v.readUInt32LE(60),
    present: v.readUInt32LE(0) === IMAGE_MAGIC
  };
}

/**
 * Yuva başından başlayan imaj (başlık bölgesi + uygulama) → doğrulama; gönderilecek bayt sayısı.
 * @param {Uint8Array} bytes
 */
function checkImage(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < REGION + 8) return { ok: false, error: t('Dosya çok küçük: başlık bölgesi (1 KB) ve vektör tablosu olmalı.') };
  const h = parseHeader(b.subarray(0, 64));
  if (!h.present) return { ok: false, error: t('Dosyanın başında Embedded Studio imaj başlığı yok. Bootloader açıkken derlenen uygulamanın .bin / .hex / .elf dosyasını seçin.') };
  if (!h.hdrCrcOk) return { ok: false, error: t('Başlık CRC\'si tutmuyor: dosya derlemeden sonra işlenmemiş (es-image.cmake) ya da bozuk.') };
  if (h.imageSize > b.length - REGION) return { ok: false, error: t('Başlıktaki boyut ({0}) dosyadan büyük.', h.imageSize) };
  const crc = crc32(b.subarray(REGION, REGION + h.imageSize));
  if (crc !== h.imageCrc) return { ok: false, error: t('İmaj CRC-32 tutmuyor (başlık {0}, hesaplanan {1}).', hex(h.imageCrc), hex(crc)) };
  return { ok: true, header: h, total: REGION + h.imageSize };
}
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** INFO yanıtı → nesne */
function parseInfo(p) {
  const b = Buffer.from(p);
  return {
    protocol: b[0], version: `${b[1]}.${b[2]}`, app: b[3], appText: imgText(b[3]), slotBase: b.readUInt32LE(4), slotSize: b.readUInt32LE(8),
    maxData: b.readUInt16LE(12), progUnit: b.readUInt16LE(14), deviceId: b.readUInt32LE(16), header: parseHeader(b.subarray(20, 84))
  };
}

class EsBootClient {
  /** @param {{ write: (b: Buffer) => void }} port */
  constructor(port, opts = {}) {
    this.port = port;
    this.q = new ByteQueue();
    this.timeout = opts.timeoutMs || 1000;
    this.retries = opts.retries ?? 3;
  }
  feed(b) { this.q.push(b); }

  async readReply(ms) {
    for (;;) {
      const [s] = await this.q.read(1, ms);
      if (s === SOF) break;
    }
    const head = await this.q.read(4, ms);
    const n = head.readUInt16LE(2);
    const rest = await this.q.read(n + 4, ms);
    const payload = rest.subarray(0, n);
    if (crc32(Buffer.concat([head, payload])) !== rest.readUInt32LE(n)) throw Object.assign(new Error(t('Yanıt bozuk (CRC).')), { retry: true });
    return { status: head[0], code: head[1], payload };
  }

  /** Komut gönderir; bozuk yanıt / zaman aşımı / paket CRC NACK'inde yeniden dener */
  async request(cmd, payload, ms = this.timeout) {
    let last;
    for (let i = 0; i <= this.retries; i++) {
      this.q.clear();
      this.port.write(frame(cmd, payload));
      try {
        const r = await this.readReply(ms);
        if (r.status === ACK) return r.payload;
        const e = Object.assign(new Error(t('Bootloader reddetti: {0}.', errText(r.code, r.payload[0]))), { code: r.code, detail: r.payload[0] });
        if (r.code !== 1) throw e; // yalnızca bozuk paket yeniden denenir
        last = e;
      } catch (e) {
        if (!e.timeout && !e.retry) throw e;
        last = e;
      }
    }
    throw last || new Error(t('Bootloader yanıt vermedi.'));
  }

  async info() { return parseInfo(await this.request(CMD.INFO)); }

  /**
   * Bütün güncelleme: START (silme), DATA, END (doğrula + commit), isteğe bağlı BOOT.
   * @param {Uint8Array} image yuva başından (başlık dahil) @param {{ boot?: boolean, progress?: (stage: string, done: number, total: number) => void }} [o]
   */
  async update(image, o = {}) {
    const chk = checkImage(image);
    if (!chk.ok) throw new Error(chk.error);
    const info = await this.info();
    if (chk.total > info.slotSize) throw new Error(t('İmaj ({0} bayt) yuvaya ({1} bayt) sığmıyor.', chk.total, info.slotSize));
    if (chk.header.vectorAddr !== info.slotBase + REGION) throw new Error(t('İmaj başka bir yuva adresi için derlenmiş ({0}); cihazdaki yuva {1}.', hex(chk.header.vectorAddr - REGION), hex(info.slotBase)));
    const total = chk.total;
    const p = o.progress || (() => {});
    p('erase', 0, total);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(total);
    await this.request(CMD.START, size, 60000);
    const unit = info.progUnit || 4;
    const chunk = Math.floor(Math.min(info.maxData || 1024, 1024) / unit) * unit;
    const img = Buffer.from(image).subarray(0, total);
    for (let off = 0; off < total; off += chunk) {
      const part = img.subarray(off, Math.min(total, off + chunk));
      const pl = Buffer.alloc(4 + part.length);
      pl.writeUInt32LE(off);
      part.copy(pl, 4);
      await this.request(CMD.DATA, pl, 5000);
      p('write', off + part.length, total);
    }
    p('verify', total, total);
    await this.request(CMD.END, Buffer.alloc(0), 30000);
    if (o.boot) await this.request(CMD.BOOT);
    return { header: chk.header, total, info };
  }
}

/**
 * Bootloader'ın JS benzetimi (es_boot_core.c ile aynı kurallar): silinmeden yazılamayan flash, commit en son,
 * paket CRC'si, sıra denetimi. Kart yokken Programlayıcı'da ve testlerde.
 */
class SimEsBoot {
  /** @param {{ slotBase: number, slotSize: number, progUnit?: number, deviceId?: number, out: (b: Buffer) => void }} o */
  constructor(o) {
    this.o = { progUnit: 4, deviceId: 0x431, ...o };
    this.flash = new Uint8Array(o.slotSize).fill(0xff);
    this.q = new ByteQueue();
    this.started = false;
    this.total = 0;
    this.written = 0;
    this.booted = 0;
    this.log = [];
    this.loop();
  }
  receive(b) { this.q.push(b); }
  reply(status, code, payload = Buffer.alloc(0)) {
    const body = Buffer.concat([Buffer.from([status, code, payload.length & 0xff, payload.length >> 8]), payload]);
    const c = Buffer.alloc(4);
    c.writeUInt32LE(crc32(body));
    this.o.out(Buffer.concat([Buffer.from([SOF]), body, c]));
  }
  ack(p) { this.reply(ACK, 0, p); }
  nack(code, detail = 0) { this.reply(NACK, code, Buffer.from([detail])); }
  validate(needCommit) {
    const f = Buffer.from(this.flash.buffer, this.flash.byteOffset);
    const h = parseHeader(f.subarray(0, 64));
    if (!h.present || h.hdrVersion !== 1 || h.hdrSize !== 64) return 1;
    if (!h.hdrCrcOk) return 2;
    if (h.imageSize < 8 || h.imageSize & 3 || h.imageSize > this.o.slotSize - REGION || h.vectorAddr !== this.o.slotBase + REGION) return 3;
    if (needCommit && f.readUInt32LE(COMMIT_OFF) !== COMMIT_MAGIC) return 4;
    if (crc32(f.subarray(REGION, REGION + h.imageSize)) !== h.imageCrc) return 5;
    const sp = f.readUInt32LE(REGION), pc = f.readUInt32LE(REGION + 4);
    if (sp < 0x20000000 || sp > 0x20200000 || sp & 3 || pc < this.o.slotBase + REGION || pc >= this.o.slotBase + this.o.slotSize || !(pc & 1)) return 6;
    return 0;
  }
  async loop() {
    for (;;) {
      let b;
      try {
        [b] = await this.q.read(1, 0);
      } catch { return; }
      if (b !== SOF) continue;
      const head = await this.q.read(3, 0);
      const n = head.readUInt16LE(1);
      const rest = await this.q.read(n + 4, 0);
      const payload = rest.subarray(0, n);
      if (crc32(Buffer.concat([head, payload])) !== rest.readUInt32LE(n)) { this.nack(1); continue; }
      this.log.push(head[0]);
      this.handle(head[0], payload);
    }
  }
  handle(cmd, p) {
    const U = this.o.progUnit;
    if (cmd === CMD.INFO) {
      const d = Buffer.alloc(84);
      d[0] = 1; d[1] = 1; d[2] = 0; d[3] = this.validate(true);
      d.writeUInt32LE(this.o.slotBase, 4); d.writeUInt32LE(this.o.slotSize, 8); d.writeUInt16LE(1024, 12); d.writeUInt16LE(U, 14); d.writeUInt32LE(this.o.deviceId, 16);
      Buffer.from(this.flash.subarray(0, 64)).copy(d, 20);
      return this.ack(d);
    }
    if (cmd === CMD.START) {
      if (p.length !== 4) return this.nack(3);
      const size = p.readUInt32LE(0);
      if (size < REGION + 8 || size > this.o.slotSize) return this.nack(3, 1);
      this.flash.fill(0xff); // benzetimde bütün yuva (gerçekte boyutu kapsayan sektörler)
      Object.assign(this, { started: true, total: size, written: 0 });
      return this.ack();
    }
    if (cmd === CMD.DATA) {
      if (!this.started) return this.nack(4);
      if (p.length < 5) return this.nack(3);
      const off = p.readUInt32LE(0), data = p.subarray(4), n = data.length;
      if (off + n === this.written && off < this.written) return this.ack();
      if (off !== this.written || off + n > this.total || (n % U && off + n !== this.total)) return this.nack(3, 1);
      for (let i = 0; i < n; i++) {
        const o = off + i;
        if (o >= COMMIT_OFF && o < COMMIT_OFF + 32) continue;
        this.flash[o] &= data[i];
      }
      this.written = off + n;
      return this.ack();
    }
    if (cmd === CMD.END) {
      if (!this.started || this.written !== this.total) return this.nack(4);
      let v = this.validate(false);
      if (v) return this.nack(6, v);
      Buffer.from(this.flash.buffer, this.flash.byteOffset).writeUInt32LE(COMMIT_MAGIC, COMMIT_OFF);
      v = this.validate(true);
      if (v) return this.nack(6, v);
      this.started = false;
      return this.ack();
    }
    if (cmd === CMD.BOOT) {
      this.ack();
      this.booted++;
      return undefined;
    }
    return this.nack(2, cmd);
  }
}

/** Benzetim çifti: istemci + cihaz bellekte bağlı */
function simEsBoot(o) {
  let dev;
  const client = new EsBootClient({ write: (b) => setImmediate(() => dev.receive(b)) }, o);
  dev = new SimEsBoot({ ...o, out: (b) => setImmediate(() => client.feed(b)) });
  return { client, dev };
}

/**
 * Test ve benzetim için örnek imaj: başlık + vektör tablosu + kod (es-image.cmake'in ürettiğinin aynısı).
 * @param {{ slotBase: number, size?: number, version?: string, buildId?: string, sp?: number }} o
 */
function buildImage(o) {
  const body = Buffer.alloc((o.size || 4096) & ~3);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + 3) & 0xff;
  body.writeUInt32LE(o.sp || 0x20020000, 0);
  body.writeUInt32LE(((o.slotBase + REGION + 0x200) | 1) >>> 0, 4);
  const r = Buffer.alloc(REGION, 0);
  r.writeUInt32LE(IMAGE_MAGIC, 0); r.writeUInt16LE(1, 4); r.writeUInt16LE(64, 6);
  r.writeUInt32LE(body.length, 8); r.writeUInt32LE(crc32(body), 12);
  const [a, b, c] = (o.version || '1.0.0').split('.').map(Number);
  r.writeUInt32LE((((a & 0xff) << 24) | ((b & 0xff) << 16) | (c & 0xffff)) >>> 0, 16);
  r.writeUInt32LE(o.slotBase + REGION, 20);
  r.write(o.buildId || 'test', 28, 31, 'latin1');
  r.writeUInt32LE(crc32(r.subarray(0, 60)), 60);
  r.fill(0xff, COMMIT_OFF);
  r.writeUInt32LE(COMMIT_MAGIC, COMMIT_OFF);
  return Buffer.concat([r, body]);
}

module.exports = { SOF, ACK, NACK, CMD, ERR, IMG, REGION, COMMIT_OFF, IMAGE_MAGIC, COMMIT_MAGIC, crc32, frame, parseHeader, parseInfo, checkImage, imgText, errText, EsBootClient, SimEsBoot, simEsBoot, buildImage };
