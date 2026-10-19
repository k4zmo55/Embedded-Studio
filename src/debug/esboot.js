// @ts-check
/**
 * Embedded Studio bootloader'ı (ES-303) için güncelleme istemcisi: paket biçimi, komutlar, yeniden deneme,
 * imaj başlığının çözümü ve doğrulanması. Cihaz tarafı bootloader/es_boot_core.c (C); burada aynı protokolün
 * bir benzetimi de var (kart yokken ve testlerde).
 *
 * İstek: A5 | komut | uzunluk (2, LE) | veri | CRC-32 (komut..veri)
 * Yanıt: A5 | durum (79/1F) | kod | uzunluk (2) | veri | CRC-32 (durum..veri)
 *
 * ES-304: Ed25519 imzası (anahtar üretme, imzalama, doğrulama), A/B düzeni ve geri dönüş koruması (protokol 2).
 */
const crypto = require('crypto');
const { t } = require('../i18n');
const { ByteQueue } = require('./sysboot');

const SOF = 0xa5;
const ACK = 0x79;
const NACK = 0x1f;
const CMD = { INFO: 1, START: 2, DATA: 3, END: 4, BOOT: 5 };
const ERR = { 1: 'FRAME', 2: 'CMD', 3: 'ARG', 4: 'STATE', 5: 'FLASH', 6: 'VERIFY', 7: 'ROLLBACK' };
const IMG = { 0: 'OK', 1: 'MAGIC', 2: 'HDR_CRC', 3: 'SIZE', 4: 'COMMIT', 5: 'CRC', 6: 'VECTORS', 7: 'SIG', 8: 'ROLLBACK' };
const FLAG = { AB: 1, SIGNED: 2, ROLLBACK: 4 };
const REGION = 0x400;
const COMMIT_OFF = 0x3e0;
const STATE_OFF = 0x3c0;
const SIG_OFF = 0x40;
const IMAGE_MAGIC = 0x474d4945;
const COMMIT_MAGIC = 0x54494d43;
const SIG_MAGIC = 0x47495345;
const DONE_MAGIC = 0x454e4f44;
const INFO_SIZE = 180;

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
  4: t('güncelleme tamamlanmamış (commit yok)'), 5: t('imaj CRC-32 tutmuyor'), 6: t('vektör tablosu geçersiz'),
  7: t('imza yok ya da geçersiz'), 8: t('sürüm izin verilenden düşük (geri dönüş koruması)')
}[code] || `#${code}`);
const errText = (code, detail) => ({
  1: t('paket bozuk (CRC)'), 2: t('bilinmeyen komut'), 3: t('geçersiz argüman'), 4: t('sıra hatası (önce START)'), 5: t('flash hatası'),
  6: t('doğrulama başarısız: {0}', imgText(detail)), 7: t('sürüm düşürülemez (geri dönüş koruması)')
}[code] || `#${code}`);
/** 0xMMmmpppp → "M.m.p" */
const versionText = (w) => `${w >>> 24}.${(w >>> 16) & 0xff}.${w & 0xffff}`;

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
  return { ok: true, header: h, total: REGION + h.imageSize, sig: parseSig(b) };
}

/** İmza bloğu (başlık bölgesinde 0x40): magic, algoritma (1 = Ed25519), boyut, anahtar kimliği (8), imza (64) */
function parseSig(region) {
  const b = Buffer.from(region);
  if (b.length < SIG_OFF + 80) return { present: false, keyId: '', sig: null };
  const s = b.subarray(SIG_OFF, SIG_OFF + 80);
  return { present: s.readUInt32LE(0) === SIG_MAGIC && s.readUInt16LE(4) === 1 && s.readUInt16LE(6) === 64, keyId: s.subarray(8, 16).toString('hex'), sig: s.subarray(16, 80) };
}

/** İmzalanan ileti: başlık (64 bayt) || imaj */
const signedMessage = (b, h) => Buffer.concat([b.subarray(0, 64), b.subarray(REGION, REGION + h.imageSize)]);

// ---- Anahtarlar (Ed25519): özel anahtar PKCS#8 PEM, açık anahtar 32 bayt, anahtar kimliği = açık anahtarın ilk 8 baytı
const rawPublic = (key) => Buffer.from(/** @type {any} */ (key.export({ format: 'jwk' })).x, 'base64url');
const publicFromRaw = (raw) => crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(raw).toString('base64url') }, format: 'jwk' });
const keyIdOf = (pub) => Buffer.from(pub).subarray(0, 8).toString('hex');

function generateKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pub = rawPublic(publicKey);
  return { pub, keyId: keyIdOf(pub), pem: String(privateKey.export({ type: 'pkcs8', format: 'pem' })) };
}

/** PEM → { key, pub, keyId }; Ed25519 değilse hata */
function loadPrivateKey(pem) {
  let k;
  try {
    k = crypto.createPrivateKey(pem);
  } catch (e) {
    throw new Error(t('Özel anahtar okunamadı: {0}', e.message));
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new Error(t('Anahtar Ed25519 değil ({0}).', k.asymmetricKeyType));
  const pub = rawPublic(crypto.createPublicKey(k));
  return { key: k, pub, keyId: keyIdOf(pub) };
}

/** Yuva başından imajı imzalar (kopyası döner). Başlık ve CRC'ler değişmez; yalnızca imza bloğu yazılır. */
function signImage(bytes, pem) {
  const chk = checkImage(bytes);
  if (!chk.ok) throw new Error(chk.error);
  const { key, pub, keyId } = loadPrivateKey(pem);
  const out = Buffer.from(Buffer.from(bytes).subarray(0, chk.total));
  const sig = crypto.sign(null, signedMessage(out, chk.header), key);
  out.writeUInt32LE(SIG_MAGIC, SIG_OFF);
  out.writeUInt16LE(1, SIG_OFF + 4);
  out.writeUInt16LE(64, SIG_OFF + 6);
  pub.copy(out, SIG_OFF + 8, 0, 8);
  sig.copy(out, SIG_OFF + 16);
  return { bytes: out, keyId };
}

/** İmza bu açık anahtarla (32 bayt) geçerli mi */
function verifySig(bytes, pub) {
  const b = Buffer.from(bytes);
  const h = parseHeader(b.subarray(0, 64));
  const s = parseSig(b);
  if (!h || !s.present || s.keyId !== keyIdOf(pub) || b.length < REGION + h.imageSize) return false;
  return crypto.verify(null, signedMessage(b, h), publicFromRaw(pub), s.sig);
}
const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** INFO yanıtı → nesne */
function parseInfo(p) {
  const b = Buffer.from(p);
  const ext = b[0] >= 2 && b.length >= INFO_SIZE; // protokol 2 (ES-304)
  const flags = ext ? b.readUInt32LE(84) : 0;
  const floor = ext ? b.readUInt32LE(100) : 0;
  return {
    protocol: b[0], version: `${b[1]}.${b[2]}`, app: b[3], appText: imgText(b[3]), slotBase: b.readUInt32LE(4), slotSize: b.readUInt32LE(8),
    maxData: b.readUInt16LE(12), progUnit: b.readUInt16LE(14), deviceId: b.readUInt32LE(16), header: parseHeader(b.subarray(20, 84)),
    ab: !!(flags & FLAG.AB), signed: !!(flags & FLAG.SIGNED), rollback: !!(flags & FLAG.ROLLBACK),
    stageBase: ext ? b.readUInt32LE(88) : 0, stageSize: ext ? b.readUInt32LE(92) : 0, imageMax: ext ? b.readUInt32LE(96) : b.readUInt32LE(8) - REGION,
    floor, floorText: versionText(floor), keyId: flags & FLAG.SIGNED ? b.subarray(104, 112).toString('hex') : '',
    stage: flags & FLAG.AB ? { status: b[112], statusText: imgText(b[112]), done: !!b[113], header: parseHeader(b.subarray(116, 180)) } : null
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
    if (chk.total > REGION + info.imageMax) throw new Error(t('İmaj ({0} bayt) yuvaya ({1} bayt) sığmıyor.', chk.total, REGION + info.imageMax));
    if (chk.header.vectorAddr !== info.slotBase + REGION) throw new Error(t('İmaj başka bir yuva adresi için derlenmiş ({0}); cihazdaki yuva {1}.', hex(chk.header.vectorAddr - REGION), hex(info.slotBase)));
    // ES-304: göndermeden önce cihazın kurallarıyla denetlenir (cihaz yine de kendisi doğrular)
    if (info.signed && !chk.sig.present) throw new Error(t('Cihaz imzalı imaj bekliyor (anahtar {0}); imaj imzasız.', info.keyId));
    if (info.signed && chk.sig.keyId !== info.keyId) throw new Error(t('İmaj başka bir anahtarla imzalı ({0}); cihazın anahtarı {1}.', chk.sig.keyId, info.keyId));
    if (info.rollback && chk.header.fwVersion < info.floor) throw new Error(t('Geri dönüş koruması: imaj v{0}, cihaz en az v{1} kabul ediyor.', chk.header.version, info.floorText));
    const total = chk.total;
    const p = o.progress || (() => {});
    p('erase', 0, total);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(total);
    // Protokol 2: başlık da gönderilir; cihaz silmeden önce yuvayı ve sürümü denetler
    await this.request(CMD.START, info.protocol >= 2 ? Buffer.concat([size, Buffer.from(image).subarray(0, 64)]) : size, 60000);
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
    // İmza doğrulaması yavaş işlemcide saniyeler sürer; A/B'de ardından ana yuva silinip yeni imaj kopyalanır
    await this.request(CMD.END, Buffer.alloc(0), info.ab ? 180000 : 60000);
    if (info.ab) p('install', total, total);
    if (o.boot) await this.request(CMD.BOOT);
    return { header: chk.header, total, info };
  }
}

/**
 * Bootloader'ın JS benzetimi (es_boot_core.c ile aynı kurallar): silinmeden yazılamayan flash, commit en son,
 * paket CRC'si, sıra denetimi; ES-304: imza (pubKey verilirse), geri dönüş koruması, A/B (stageSize verilirse:
 * hazırlık yuvası ana yuvanın hemen ardında). Kart yokken Programlayıcı'da ve testlerde.
 */
class SimEsBoot {
  /**
   * @param {{ slotBase: number, slotSize: number, stageBase?: number, stageSize?: number, progUnit?: number, deviceId?: number,
   *   pubKey?: Uint8Array | null, rollback?: boolean, minVersion?: number, out: (b: Buffer) => void }} o
   */
  constructor(o) {
    this.o = { progUnit: 4, deviceId: 0x431, stageBase: 0, stageSize: 0, pubKey: null, rollback: false, minVersion: 0, ...o };
    this.ab = this.o.stageSize > 0;
    this.stageOff = this.ab ? this.o.stageBase - this.o.slotBase : 0;
    this.flash = new Uint8Array(this.o.slotSize + this.o.stageSize).fill(0xff);
    this.q = new ByteQueue();
    this.started = false;
    this.total = 0;
    this.written = 0;
    this.floor = 0;
    this.booted = 0;
    this.log = [];
    this.loop();
  }
  get buf() { return Buffer.from(this.flash.buffer, this.flash.byteOffset, this.flash.length); }
  get recv() { return this.ab ? this.stageOff : 0; }
  receive(b) { this.q.push(b); }
  reply(status, code, payload = Buffer.alloc(0)) {
    const body = Buffer.concat([Buffer.from([status, code, payload.length & 0xff, payload.length >> 8]), payload]);
    const c = Buffer.alloc(4);
    c.writeUInt32LE(crc32(body));
    this.o.out(Buffer.concat([Buffer.from([SOF]), body, c]));
  }
  ack(p) { this.reply(ACK, 0, p); }
  nack(code, detail = 0) { this.reply(NACK, code, Buffer.from([detail])); }
  /** off: flash'taki yuva (0 ana, stageOff hazırlık) */
  check(off, needCommit) {
    const f = this.buf.subarray(off);
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
  validate(needCommit) { return this.check(0, needCommit); }
  versionFloor() {
    const v = this.check(0, true) === 0 ? this.buf.readUInt32LE(16) : 0;
    return Math.max(this.o.minVersion >>> 0, v) >>> 0;
  }
  accept(off, needCommit, floor) {
    const v = this.check(off, needCommit);
    if (v) return v;
    if (this.o.rollback && this.buf.readUInt32LE(off + 16) < floor) return 8;
    if (this.o.pubKey && !verifySig(this.buf.subarray(off, off + REGION + this.buf.readUInt32LE(off + 8)), this.o.pubKey)) return 7;
    return 0;
  }
  /** Programlama: silinmemiş bit 0'dan 1'e dönmez */
  program(off, data) { for (let i = 0; i < data.length; i++) this.flash[off + i] &= data[i]; }
  mark(off, magic) { const b = Buffer.alloc(4); b.writeUInt32LE(magic); this.program(off, b); }
  /** Durum ve commit blokları (0x3C0–0x3FF) güncellemede atlanır */
  writeSlot(base, off, data) {
    for (let i = 0; i < data.length; i++) {
      const o = off + i;
      if (o >= STATE_OFF && o < REGION) continue;
      this.flash[base + o] &= data[i];
    }
  }
  copyStage() {
    const n = REGION + this.buf.readUInt32LE(this.stageOff + 8);
    this.flash.fill(0xff, 0, this.o.slotSize); // benzetimde bütün ana yuva (gerçekte boyutu kapsayan birimler)
    this.writeSlot(0, 0, Buffer.from(this.flash.subarray(this.stageOff, this.stageOff + n)));
    if (this.check(0, false)) return -1;
    this.mark(COMMIT_OFF, COMMIT_MAGIC);
    if (this.check(0, true)) return -1;
    if (this.buf.readUInt32LE(this.stageOff + STATE_OFF) !== DONE_MAGIC) this.mark(this.stageOff + STATE_OFF, DONE_MAGIC);
    return 0;
  }
  /** Açılıştaki kurulum (es_boot_install): { result: 0 yok | 1 kuruldu | 2 reddedildi | 3 hata, detail } */
  install() {
    if (!this.ab) return { result: 0, detail: 0 };
    const b = this.buf, s = this.stageOff;
    if (b.readUInt32LE(s) !== IMAGE_MAGIC || b.readUInt32LE(s + COMMIT_OFF) !== COMMIT_MAGIC) return { result: 0, detail: 0 };
    const done = b.readUInt32LE(s + STATE_OFF) === DONE_MAGIC;
    const primary = this.check(0, true) === 0;
    if (primary && done) return { result: 0, detail: 0 };
    if (primary && b.subarray(s, s + 64).equals(b.subarray(0, 64))) {
      this.mark(s + STATE_OFF, DONE_MAGIC);
      return { result: 0, detail: 0 };
    }
    const v = this.accept(s, true, primary ? this.versionFloor() : this.o.minVersion >>> 0);
    if (v) {
      if (!done) this.mark(s + STATE_OFF, DONE_MAGIC);
      return { result: 2, detail: v };
    }
    return { result: this.copyStage() ? 3 : 1, detail: 0 };
  }
  /** Güç kesilip yeniden açılmış gibi: yarım kalan paket durumu silinir, A/B kurulumu yapılır */
  reset() {
    this.started = false;
    return this.install();
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
      const d = Buffer.alloc(INFO_SIZE);
      d[0] = 2; d[1] = 1; d[2] = 1; d[3] = this.validate(true);
      d.writeUInt32LE(this.o.slotBase, 4); d.writeUInt32LE(this.o.slotSize, 8); d.writeUInt16LE(1024, 12); d.writeUInt16LE(U, 14); d.writeUInt32LE(this.o.deviceId, 16);
      Buffer.from(this.flash.subarray(0, 64)).copy(d, 20);
      d.writeUInt32LE((this.ab ? FLAG.AB : 0) | (this.o.pubKey ? FLAG.SIGNED : 0) | (this.o.rollback ? FLAG.ROLLBACK : 0), 84);
      d.writeUInt32LE(this.o.stageBase, 88); d.writeUInt32LE(this.o.stageSize, 92); d.writeUInt32LE(this.o.slotSize - REGION, 96); d.writeUInt32LE(this.versionFloor(), 100);
      if (this.o.pubKey) Buffer.from(this.o.pubKey).copy(d, 104, 0, 8);
      if (this.ab) {
        d[112] = this.check(this.stageOff, true);
        d[113] = this.buf.readUInt32LE(this.stageOff + STATE_OFF) === DONE_MAGIC ? 1 : 0;
        Buffer.from(this.flash.subarray(this.stageOff, this.stageOff + 64)).copy(d, 116);
      }
      return this.ack(d);
    }
    if (cmd === CMD.START) {
      if (p.length !== 4 && p.length !== 68) return this.nack(3);
      const size = p.readUInt32LE(0);
      if (size < REGION + 8 || size > this.o.slotSize) return this.nack(3, 1);
      this.started = false;
      this.floor = this.versionFloor();
      if (p.length === 68) {
        const h = parseHeader(p.subarray(4));
        if (!h.present || h.vectorAddr !== this.o.slotBase + REGION) return this.nack(3, 2);
        if (this.o.rollback && h.fwVersion < this.floor) return this.nack(7);
      }
      // benzetimde bütün yuva (gerçekte boyutu kapsayan sektörler)
      if (this.ab) this.flash.fill(0xff, this.stageOff);
      else this.flash.fill(0xff, 0, this.o.slotSize);
      Object.assign(this, { started: true, total: size, written: 0 });
      return this.ack();
    }
    if (cmd === CMD.DATA) {
      if (!this.started) return this.nack(4);
      if (p.length < 5) return this.nack(3);
      const off = p.readUInt32LE(0), data = p.subarray(4), n = data.length;
      if (off + n === this.written && off < this.written) return this.ack();
      if (off !== this.written || off + n > this.total || (n % U && off + n !== this.total)) return this.nack(3, 1);
      this.writeSlot(this.recv, off, data);
      this.written = off + n;
      return this.ack();
    }
    if (cmd === CMD.END) {
      if (!this.started || this.written !== this.total) return this.nack(4);
      if (this.ab) this.floor = this.versionFloor();
      let v = this.accept(this.recv, false, this.floor);
      if (v) return this.nack(6, v);
      this.mark(this.recv + COMMIT_OFF, COMMIT_MAGIC);
      v = this.check(this.recv, true);
      if (v) return this.nack(6, v);
      this.started = false;
      if (this.ab && this.copyStage()) return this.nack(5, 2);
      return this.ack();
    }
    if (cmd === CMD.BOOT) {
      this.ack();
      this.booted++;
      this.reset();
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
  r.fill(0xff, STATE_OFF);
  r.writeUInt32LE(COMMIT_MAGIC, COMMIT_OFF);
  return Buffer.concat([r, body]);
}

module.exports = {
  SOF, ACK, NACK, CMD, ERR, IMG, FLAG, REGION, COMMIT_OFF, STATE_OFF, SIG_OFF, IMAGE_MAGIC, COMMIT_MAGIC, SIG_MAGIC, DONE_MAGIC, crc32, frame,
  parseHeader, parseInfo, parseSig, checkImage, imgText, errText, versionText, generateKey, loadPrivateKey, keyIdOf, signImage, verifySig,
  EsBootClient, SimEsBoot, simEsBoot, buildImage
};
