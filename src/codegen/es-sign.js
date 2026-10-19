#!/usr/bin/env node
// Embedded Studio (ES-305): uygulama imajını imzalar ve güncelleme paketini üretir. Bağımsızdır (yalnızca Node.js
// yerleşik modülleri); Embedded Studio bu dosyayı projeye cmake/es-sign.js olarak kopyalar, eklenti de aynı kodu kullanır.
//
// Komut satırı (CI / derleme sunucusu):
//   node cmake/es-sign.js --bin build/release/app.bin --slot 0x08004000 [--boot-hex build/release/app_boot.hex]
//                         [--key anahtar.pem] [--out klasör] [--name app] [--pub <64 onaltılık>]
// Anahtar: --key, yoksa ES_SIGN_KEY (PEM dosyasının yolu) ya da ES_SIGN_KEY_PEM (PEM içeriği; CI gizli değişkeni).
// --pub verilirse anahtarın bootloader'a gömülü açık anahtarla aynı olduğu denetlenir.
//
// Çıktılar (--out, varsayılan .bin'in klasörü):
//   <ad>_signed.bin       yuva başından imzalı imaj (Programlayıcı / UART güncellemesi)
//   <ad>_signed.hex       aynısı, Intel HEX (yuva adresinde)
//   <ad>_full_signed.hex  bootloader + imzalı uygulama (--boot-hex verilirse; üretim hattında SWD ile)
//   <ad>_update.json      sürüm bildirimi: sürüm, derleme kimliği, boyut, CRC-32, SHA-256, anahtar kimliği
//
// İmaj biçimi: es_image.h. İmza Ed25519 (RFC 8032), ileti = başlık (64 bayt) || imaj (image_size bayt);
// imza bloğu başlık bölgesinde 0x40'ta. Başlık ve CRC'ler (cmake/es-image.cmake) değişmez.
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const REGION = 0x400;
const SIG_OFF = 0x40;
const IMAGE_MAGIC = 0x474d4945;
const SIG_MAGIC = 0x47495345;
const MANIFEST_FORMAT = 'embedded-studio-update/1';

let TABLE = null;
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

const hex8 = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');

/** Başlığı doğrular; { header, total } ya da hata fırlatır */
function readImage(bytes) {
  const b = Buffer.from(bytes);
  if (b.length < REGION + 8) throw new Error('Dosya çok küçük: başlık bölgesi (1 KB) ve vektör tablosu olmalı.');
  if (b.readUInt32LE(0) !== IMAGE_MAGIC) throw new Error('Dosyanın başında Embedded Studio imaj başlığı yok (bootloader açıkken derlenen <proje>.bin olmalı).');
  if (crc32(b.subarray(0, 60)) !== b.readUInt32LE(60)) throw new Error('Başlık CRC\'si tutmuyor: dosya cmake/es-image.cmake ile işlenmemiş ya da bozuk.');
  const size = b.readUInt32LE(8);
  if (size > b.length - REGION) throw new Error(`Başlıktaki boyut (${size}) dosyadan büyük.`);
  const crc = crc32(b.subarray(REGION, REGION + size));
  if (crc !== b.readUInt32LE(12)) throw new Error(`İmaj CRC-32 tutmuyor (başlık ${hex8(b.readUInt32LE(12))}, hesaplanan ${hex8(crc)}).`);
  const fw = b.readUInt32LE(16);
  const id = b.subarray(28, 60);
  const end = id.indexOf(0);
  return {
    total: REGION + size,
    header: {
      imageSize: size, imageCrc: crc, fwVersion: fw, version: `${fw >>> 24}.${(fw >>> 16) & 0xff}.${fw & 0xffff}`, vectorAddr: b.readUInt32LE(20),
      buildId: id.subarray(0, end < 0 ? 32 : end).toString('latin1')
    }
  };
}

function rawPublic(key) {
  return Buffer.from(key.export({ format: 'jwk' }).x, 'base64url');
}

/** PEM → { key, pub, keyId } */
function loadKey(pem) {
  let k;
  try {
    k = crypto.createPrivateKey(pem);
  } catch (e) {
    throw new Error(`Özel anahtar okunamadı: ${e.message}`);
  }
  if (k.asymmetricKeyType !== 'ed25519') throw new Error(`Anahtar Ed25519 değil (${k.asymmetricKeyType}).`);
  const pub = rawPublic(crypto.createPublicKey(k));
  return { key: k, pub, keyId: pub.subarray(0, 8).toString('hex') };
}

/** İmzalı kopya: { bytes, keyId, header } */
function sign(bytes, pem) {
  const { total, header } = readImage(bytes);
  const { key, pub, keyId } = loadKey(pem);
  const out = Buffer.from(Buffer.from(bytes).subarray(0, total));
  const sig = crypto.sign(null, Buffer.concat([out.subarray(0, 64), out.subarray(REGION, total)]), key);
  out.fill(0, SIG_OFF, SIG_OFF + 80);
  out.writeUInt32LE(SIG_MAGIC, SIG_OFF);
  out.writeUInt16LE(1, SIG_OFF + 4);
  out.writeUInt16LE(64, SIG_OFF + 6);
  pub.copy(out, SIG_OFF + 8, 0, 8);
  sig.copy(out, SIG_OFF + 16);
  return { bytes: out, keyId, pub, header };
}

/** Intel HEX (kayıt başına 16 bayt, 64 KB sınırında genişletilmiş adres kaydı) */
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
    const n = Math.min(16, bytes.length - i, 0x10000 - (a & 0xffff));
    lines.push(rec(0, a & 0xffff, [...bytes.subarray(i, i + n)]));
    i += n;
  }
  lines.push(':00000001FF');
  return lines.join('\n') + '\n';
}

/**
 * İmzalı paket. o: { bin: Buffer|yol, pem, slotBase, outDir, name, bootHex?: metin|yol, pub?: Buffer|onaltılık, now?: Date }
 * Dönüş: { files: [yol], manifest }
 */
function packImage(o) {
  const bin = Buffer.isBuffer(o.bin) || o.bin instanceof Uint8Array ? Buffer.from(o.bin) : fs.readFileSync(o.bin);
  const s = sign(bin, o.pem);
  if (o.pub) {
    const want = Buffer.isBuffer(o.pub) ? o.pub : Buffer.from(String(o.pub), 'hex');
    if (!want.equals(s.pub)) throw new Error(`Anahtar (${s.keyId}) bootloader'a gömülü açık anahtarla (${want.subarray(0, 8).toString('hex')}) aynı değil.`);
  }
  const slotBase = Number(o.slotBase) >>> 0;
  if (s.header.vectorAddr !== slotBase + REGION) throw new Error(`İmaj başka bir yuva için derlenmiş (vektör ${hex8(s.header.vectorAddr)}, yuva ${hex8(slotBase)}).`);
  fs.mkdirSync(o.outDir, { recursive: true });
  const P = (suffix) => path.join(o.outDir, o.name + suffix);
  const files = [];
  const write = (f, data) => { fs.writeFileSync(f, data); files.push(f); };
  write(P('_signed.bin'), s.bytes);
  const appHex = toIntelHex(s.bytes, slotBase);
  write(P('_signed.hex'), appHex);
  if (o.bootHex) {
    const boot = /^:/.test(String(o.bootHex)) ? String(o.bootHex) : fs.readFileSync(o.bootHex, 'utf8');
    // Bootloader'ın EOF kaydı çıkarılır; giriş noktası bootloader'ınki kalır
    write(P('_full_signed.hex'), boot.replace(/:00000001FF[\r\n]*/g, '').replace(/\r?\n?$/, '\n') + appHex);
  }
  const manifest = {
    format: MANIFEST_FORMAT, name: o.name, version: s.header.version, fwVersion: hex8(s.header.fwVersion), buildId: s.header.buildId,
    slotBase: hex8(slotBase), size: s.bytes.length, imageSize: s.header.imageSize, imageCrc: hex8(s.header.imageCrc),
    sha256: crypto.createHash('sha256').update(s.bytes).digest('hex'), signature: { alg: 'Ed25519', keyId: s.keyId },
    file: path.basename(P('_signed.bin')), created: (o.now || new Date()).toISOString()
  };
  write(P('_update.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { files, manifest };
}

function cli(argv, env) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const m = /^--([a-z-]+)$/.exec(argv[i]);
    if (!m) throw new Error(`Bilinmeyen argüman: ${argv[i]}`);
    a[m[1]] = argv[++i];
  }
  if (!a.bin || !a.slot) throw new Error('Kullanım: node es-sign.js --bin <uygulama.bin> --slot <yuva adresi> [--boot-hex <boot.hex>] [--key <pem>] [--out <klasör>] [--name <ad>] [--pub <açık anahtar>]');
  const pem = a.key ? fs.readFileSync(a.key, 'utf8') : env.ES_SIGN_KEY_PEM || (env.ES_SIGN_KEY ? fs.readFileSync(env.ES_SIGN_KEY, 'utf8') : '');
  if (!pem) throw new Error('Özel anahtar yok: --key, ES_SIGN_KEY (dosya yolu) ya da ES_SIGN_KEY_PEM (içerik).');
  const r = packImage({
    bin: a.bin, pem, slotBase: Number(a.slot), outDir: a.out || path.dirname(a.bin), name: a.name || path.basename(a.bin, '.bin'),
    bootHex: a['boot-hex'], pub: a.pub
  });
  return `es-sign: v${r.manifest.version} (${r.manifest.buildId}), ${r.manifest.size} bayt, Ed25519 ${r.manifest.signature.keyId} → ${r.files.map((f) => path.basename(f)).join(', ')}`;
}

if (require.main === module) {
  try {
    console.log(cli(process.argv.slice(2), process.env));
  } catch (e) {
    console.error('es-sign: ' + e.message);
    process.exit(1);
  }
}

module.exports = { REGION, SIG_OFF, MANIFEST_FORMAT, crc32, readImage, loadKey, sign, toIntelHex, packImage, cli };
