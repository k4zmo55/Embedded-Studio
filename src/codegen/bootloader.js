// @ts-check
/**
 * Güvenli bootloader şablonu (ES-303): flash bölümleme, imaj başlığı + CRC32, açılışta doğrulama, uygulamaya atlama,
 * UART üzerinden güncelleme (paket başına CRC ve ACK/NACK), watchdog ve yarıda kalan güncellemede güvenli bekleme.
 *
 * Bellek düzeni:
 *   0x08000000                 bootloader (baştaki sektör / sayfalar)
 *   slot = 0x08000000 + boot   uygulama yuvası: 1 KB başlık bölgesi (es_image_region_t)
 *   slot + 0x400               uygulamanın vektör tablosu (VTOR hizası bütün ailelerde ≤ 1 KB)
 *   RAM sonu - 16              bootloader ↔ uygulama ortak alan (güncelleme isteği; resetten sonra korunur)
 *
 * Başlıktaki boyut, CRC ve commit derlemeden sonra cmake/es-image.cmake ile yazılır (ELF, .bin, .hex).
 * Güncellemede commit en son, CRC doğrulandıktan sonra yazılır: yarıda kalan güncelleme commit'siz kalır,
 * bootloader uygulamayı çalıştırmaz ve yeni güncelleme bekler.
 *
 * ES-304: Ed25519 imzası (başlık bölgesinde 0x40), A/B düzeni (yuva ikiye bölünür: uygulama ana yuvadan çalışır,
 * güncelleme hazırlık yuvasına yazılır, doğrulanınca ana yuvaya kopyalanır; eskisi doğrulamadan önce silinmez) ve
 * sürüm tabanlı geri dönüş koruması (ana yuvadakinden düşük sürüm reddedilir).
 */
const { familyOf } = require('./families');
const { regDriverFiles } = require('./regdrivers');
const ed25519 = require('./ed25519');

const HDR = 0x400;
const COMMIT_OFF = 0x3e0;
const IMAGE_MAGIC = 0x474d4945; // "EIMG"
const COMMIT_MAGIC = 0x54494d43; // "CMIT"
const REQUEST_MAGIC = 0x51455242; // "BREQ"
const SIG_OFF = 0x40;
const SIG_MAGIC = 0x47495345; // "ESIG"
const STATE_OFF = 0x3c0;
const DONE_MAGIC = 0x454e4f44; // "DONE": hazırlık yuvasındaki imaj işlendi (kuruldu ya da reddedildi)
const BOOT_VERSION = [1, 1];
const FLASH_BASE = 0x08000000;
const RAM_BASE = 0x20000000;
/** Cortex-M0'da (F0) VTOR yok: uygulamanın vektör tablosu RAM başına kopyalanır, RAM'in ilk 0xC0 baytı ayrılır */
const F0_VECTORS = 0xc0;

const DEFAULT_BOOT = {
  enabled: false, sizeKB: 0, uart: '', tx: '', rx: '', baud: 115200, waitMs: 300, hwCrc: true, version: '1.0.0',
  // ES-304
  layout: 'single', signing: false, pubKey: '', rollback: true, minVersion: '0.0.0'
};
const VERSION_RE = /^\d{1,3}\.\d{1,3}\.\d{1,5}$/;

const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** Bootloader bölgesi için seçilebilecek boyutlar (KB): sektör / sayfa sınırları, flash'ın en fazla yarısı */
function sizeOptions(mcu) {
  const f = mcu.device.flash;
  const half = mcu.device.flashKB / 2;
  const out = [];
  if (f.type === 'sector') {
    for (const [off, size, , bank] of f.sectors) if (bank === 1 && off + size <= half) out.push(off + size);
  } else {
    for (const kb of [4, 8, 12, 16, 24, 32, 48, 64]) if (kb % f.pageKB === 0 && kb <= half) out.push(kb);
  }
  return out;
}

/** Varsayılan boyut: en az 16 KB (H7'de ilk sektör 128 KB, F7'de 32 KB) */
function defaultSize(mcu) {
  const o = sizeOptions(mcu);
  return o.find((kb) => kb >= 16) || o[o.length - 1];
}

/** Bootloader UART'ı için seçenekler: TX ve RX pini (AF numarasıyla) olan USART/UART'lar */
function uartOptions(mcu) {
  const by = {};
  for (const p of mcu.pins || []) {
    for (const f of p.functions || []) {
      const m = /^((?:US|U)ART\d+)_(TX|RX)$/.exec(f.signal);
      if (!m) continue;
      const u = (by[m[1]] = by[m[1]] || { inst: m[1], tx: [], rx: [] });
      u[m[2].toLowerCase()].push({ pin: p.name, af: f.af });
    }
  }
  return Object.values(by).filter((u) => u.tx.length && u.rx.length).sort((a, b) => a.inst.localeCompare(b.inst, 'en', { numeric: true }));
}

/**
 * Ayarları tamamlar. preferred: tasarımda USB-UART komponentinin bağlı olduğu UART ({ inst, tx, rx }) — varsa o seçilir.
 * @returns {typeof DEFAULT_BOOT}
 */
function normalizeBoot(b, mcu, preferred) {
  const s = { ...DEFAULT_BOOT, ...(b && typeof b === 'object' ? b : {}) };
  s.enabled = !!s.enabled;
  const sizes = sizeOptions(mcu);
  if (!sizes.includes(Number(s.sizeKB))) s.sizeKB = defaultSize(mcu);
  s.sizeKB = Number(s.sizeKB);
  const opts = uartOptions(mcu);
  const valid = (u, tx, rx) => { const o = opts.find((x) => x.inst === u); return o && o.tx.some((p) => p.pin === tx) && o.rx.some((p) => p.pin === rx); };
  if (!valid(s.uart, s.tx, s.rx)) {
    const pick = preferred && valid(preferred.inst, preferred.tx, preferred.rx) ? preferred
      : valid('USART1', 'PA9', 'PA10') ? { inst: 'USART1', tx: 'PA9', rx: 'PA10' }
        : opts[0] ? { inst: opts[0].inst, tx: opts[0].tx[0].pin, rx: opts[0].rx[0].pin } : null;
    Object.assign(s, pick ? { uart: pick.inst, tx: pick.tx, rx: pick.rx } : { uart: '', tx: '', rx: '' });
  }
  s.baud = [9600, 19200, 38400, 57600, 115200, 230400, 460800].includes(Number(s.baud)) ? Number(s.baud) : 115200;
  s.waitMs = Math.max(0, Math.min(5000, Math.round(Number(s.waitMs)) || 0));
  s.hwCrc = s.hwCrc !== false;
  s.version = VERSION_RE.test(String(s.version)) ? String(s.version) : '1.0.0';
  s.layout = s.layout === 'ab' && abSplit(mcu, s.sizeKB) ? 'ab' : 'single';
  s.signing = !!s.signing;
  s.pubKey = /^[0-9a-f]{64}$/i.test(String(s.pubKey)) ? String(s.pubKey).toLowerCase() : '';
  s.rollback = s.rollback !== false;
  s.minVersion = VERSION_RE.test(String(s.minVersion)) ? String(s.minVersion) : '0.0.0';
  return s;
}

/** Yuvadaki silme birimleri (bootloader bölgesinden sonrası) */
function slotUnits(mcu, sizeKB) {
  const f = mcu.device.flash;
  const bootSize = sizeKB * 1024;
  const units = [];
  if (f.type === 'sector') {
    for (const [off, size] of f.sectors) if (off * 1024 >= bootSize) units.push({ addr: FLASH_BASE + off * 1024, size: size * 1024 });
  } else {
    for (let a = FLASH_BASE + bootSize; a < FLASH_BASE + mcu.device.flashKB * 1024; a += f.pageKB * 1024) units.push({ addr: a, size: f.pageKB * 1024 });
  }
  return units;
}

/**
 * ES-304 A/B: yuvayı silme birimi sınırında ana yuva + hazırlık yuvasına böler. Ana yuva hazırlık yuvasından büyük
 * olamaz (imaj ikisine de sığmalı); en büyük ana yuva seçilir. Bölünemiyorsa (tek sektör, < 8 KB) null.
 */
function abSplit(mcu, sizeKB) {
  const units = slotUnits(mcu, sizeKB);
  const all = units.reduce((a, u) => a + u.size, 0);
  let sum = 0, best = null;
  for (let k = 1; k < units.length; k++) {
    sum += units[k - 1].size;
    if (sum <= all - sum) best = { primary: sum, stage: all - sum, stageBase: units[k].addr };
  }
  return best && best.primary >= 8 * 1024 ? best : null;
}

/** Açık anahtar (32 bayt, onaltılık) → anahtar kimliği (ilk 8 bayt) */
const keyId = (pubHex) => String(pubHex || '').slice(0, 16);

/** Sürüm metni → 0xMMmmpppp */
function versionWord(v) {
  const [a, b, c] = String(v).split('.').map(Number);
  return (((a & 0xff) << 24) | ((b & 0xff) << 16) | (c & 0xffff)) >>> 0;
}

/** Bellek bölümleri */
function partition(mcu, boot) {
  const f = mcu.device.flash;
  const k = familyOf(mcu).key;
  const bootSize = boot.sizeKB * 1024;
  const flashSize = mcu.device.flashKB * 1024;
  const slotBase = FLASH_BASE + bootSize;
  // Yuvadaki silme birimleri (sektör / sayfa): bootloader bunları güncellemede siler
  const units = slotUnits(mcu, boot.sizeKB);
  const f0 = k === 'f0';
  const ramEnd = RAM_BASE + mcu.device.ramKB * 1024;
  // ES-304 A/B: uygulama ana yuvada (slotSize), güncelleme hazırlık yuvasına
  const ab = boot.layout === 'ab' ? abSplit(mcu, boot.sizeKB) : null;
  const slotSize = ab ? ab.primary : flashSize - bootSize;
  return {
    bootBase: FLASH_BASE, bootSize, slotBase, slotSize, hdr: HDR, vectors: slotBase + HDR, commitOff: COMMIT_OFF,
    ab: !!ab, stageBase: ab ? ab.stageBase : 0, stageSize: ab ? ab.stage : 0, imageMax: slotSize - HDR,
    ramBase: RAM_BASE, ramEnd, shared: ramEnd - 16, appRamOffset: f0 ? F0_VECTORS : 0, remapVectors: f0,
    progUnit: Math.max(4, f.unit), units, pageType: f.type
  };
}

// ------------------------------------------------------------------ C kaynakları
/** Ortak imaj başlığı (bootloader ve uygulama) */
function imageHeader() {
  return `/* Embedded Studio (ES-303/304): uygulama imaj başlığı. Bootloader ve uygulama aynı tanımı kullanır; değiştirmeyin.
 *
 * Yuva düzeni:  [es_image_region_t: 1 KB] [vektör tablosu] [kod ve veri ...]
 *   0x000 başlık (64 bayt)    0x040 imza bloğu (80 bayt)    0x3C0 durum (32 bayt)    0x3E0 commit (32 bayt)
 * image_size, image_crc, hdr_crc ve commit derlemeden sonra cmake/es-image.cmake ile yazılır; imza bloğunu
 * Embedded Studio imzalarken doldurur. Durum ve commit bloklarını yalnızca bootloader yazar (güncellemede atlanır).
 * CRC: CRC-32 (IEEE 802.3 / zlib), polinom 0xEDB88320 (yansıtılmış), başlangıç ve son XOR 0xFFFFFFFF.
 * İmza: Ed25519 (RFC 8032), ileti = başlık (64 bayt) || imaj (image_size bayt). */
#ifndef ES_IMAGE_H
#define ES_IMAGE_H

#include <stdint.h>

#define ES_IMAGE_MAGIC        ${hex(IMAGE_MAGIC)}U /* "EIMG" */
#define ES_IMAGE_HDR_VERSION  1U
#define ES_IMAGE_REGION       ${hex(HDR, 4)}U      /* başlık bölgesi: vektör tablosu yuva + bu kadar ileride */
#define ES_IMAGE_COMMIT_OFF   ${hex(COMMIT_OFF, 4)}U      /* commit bloğu: 32 bayt, ayrı bir programlama birimi */
#define ES_IMAGE_COMMIT_MAGIC ${hex(COMMIT_MAGIC)}U /* "CMIT": imaj doğrulandıktan sonra yazılır */
#define ES_BOOT_REQUEST_MAGIC ${hex(REQUEST_MAGIC)}U /* "BREQ": uygulama güncelleme ister (ortak RAM) */
#define ES_IMAGE_SIG_OFF      ${hex(SIG_OFF, 4)}U
#define ES_IMAGE_SIG_MAGIC    ${hex(SIG_MAGIC)}U /* "ESIG" */
#define ES_IMAGE_SIG_ED25519  1U
#define ES_IMAGE_STATE_OFF    ${hex(STATE_OFF, 4)}U      /* durum bloğu: 32 bayt, ayrı bir programlama birimi */
#define ES_IMAGE_DONE_MAGIC   ${hex(DONE_MAGIC)}U /* "DONE": A/B hazırlık yuvasındaki imaj işlendi */

typedef struct {
  uint32_t magic;        /* ES_IMAGE_MAGIC */
  uint16_t hdr_version;  /* ES_IMAGE_HDR_VERSION */
  uint16_t hdr_size;     /* sizeof(es_image_hdr_t) */
  uint32_t image_size;   /* vektör tablosundan sona bayt (4'ün katı) */
  uint32_t image_crc;    /* image_size baytın CRC-32'si */
  uint32_t fw_version;   /* (major << 24) | (minor << 16) | yama */
  uint32_t vector_addr;  /* vektör tablosu adresi (yuva + ES_IMAGE_REGION) */
  uint32_t flags;        /* ayrılmış (0) */
  char build_id[32];     /* git kısa özeti ya da derleme zamanı */
  uint32_t hdr_crc;      /* bu alana kadarki baytların CRC-32'si */
} es_image_hdr_t;

typedef struct {
  uint32_t magic;        /* ES_IMAGE_SIG_MAGIC (imzasız imajda 0) */
  uint16_t alg;          /* ES_IMAGE_SIG_ED25519 */
  uint16_t sig_size;     /* 64 */
  uint8_t key_id[8];     /* açık anahtarın ilk 8 baytı */
  uint8_t sig[64];       /* Ed25519(başlık || imaj) */
} es_image_sig_t;

typedef struct {
  es_image_hdr_t hdr;
  es_image_sig_t sig;
  uint8_t reserved[ES_IMAGE_STATE_OFF - sizeof(es_image_hdr_t) - sizeof(es_image_sig_t)];
  uint32_t state[8];     /* A/B hazırlık yuvasında: state[0] == ES_IMAGE_DONE_MAGIC (işlendi) */
  uint32_t commit[8];    /* commit[0] == ES_IMAGE_COMMIT_MAGIC: imaj tam ve doğrulanmış */
} es_image_region_t;

#if defined(__STDC_VERSION__) && __STDC_VERSION__ >= 201112L
_Static_assert(sizeof(es_image_hdr_t) == 64, "es_image_hdr_t 64 bayt olmalı");
_Static_assert(sizeof(es_image_sig_t) == 80, "es_image_sig_t 80 bayt olmalı");
_Static_assert(ES_IMAGE_STATE_OFF + 32U == ES_IMAGE_COMMIT_OFF, "durum bloğu commit'ten hemen önce");
_Static_assert(sizeof(es_image_region_t) == ES_IMAGE_REGION, "es_image_region_t 1 KB olmalı");
#endif

#endif /* ES_IMAGE_H */
`;
}

/** Bootloader yapılandırması */
function bootConfig(mcu, boot, part) {
  const k = familyOf(mcu).key;
  const pin = (name) => ({ port: `GPIO${name[1]}`, n: Number(name.slice(2)) });
  const u = uartOptions(mcu).find((x) => x.inst === boot.uart);
  const tx = u && u.tx.find((p) => p.pin === boot.tx);
  const rx = u && u.rx.find((p) => p.pin === boot.rx);
  const t = pin(boot.tx || 'PA9'), r = pin(boot.rx || 'PA10');
  const hwCrc = boot.hwCrc && !['f1', 'f4'].includes(k); // F1/F2/F4 CRC biriminde bit ters çevirme yok: yazılım
  const pub = boot.signing && boot.pubKey ? boot.pubKey.match(/../g).map((x) => '0x' + x) : null;
  return `/* Embedded Studio (ES-303/304): bootloader yapılandırması — ${mcu.name}. Her "Kod Üret"te yeniden yazılır;
 * değiştirmek için Proje Ayarları > Bootloader. */
#ifndef ES_BOOT_CONFIG_H
#define ES_BOOT_CONFIG_H

#define ES_BOOT_VERSION_MAJOR ${BOOT_VERSION[0]}U
#define ES_BOOT_VERSION_MINOR ${BOOT_VERSION[1]}U

/* Bellek düzeni */
#define ES_BOOT_BASE     ${hex(part.bootBase)}U
#define ES_BOOT_SIZE     ${hex(part.bootSize)}U /* ${boot.sizeKB} KB */
#define ES_SLOT_BASE     ${hex(part.slotBase)}U /* ana yuva: uygulama buradan çalışır */
#define ES_SLOT_SIZE     ${hex(part.slotSize)}U /* ${part.slotSize / 1024} KB */
#define ES_APP_VECTORS   ${hex(part.vectors)}U
#define ES_IMAGE_MAX     ${hex(part.imageMax)}U /* başlık bölgesinden sonra en fazla imaj boyutu */

/* ES-304 A/B: ${part.ab ? 'güncelleme hazırlık yuvasına yazılır, doğrulanınca ana yuvaya kopyalanır' : "kapalı (tek yuva: güncelleme ana yuvaya yazılır, eskisi START'ta silinir)"} */
#define ES_BOOT_AB       ${part.ab ? 1 : 0}
#define ES_STAGE_BASE    ${hex(part.stageBase)}U${part.ab ? ` /* ${part.stageSize / 1024} KB */` : ''}
#define ES_STAGE_SIZE    ${hex(part.stageSize)}U
#define ES_RECV_BASE     ${part.ab ? 'ES_STAGE_BASE' : 'ES_SLOT_BASE'} /* güncellemenin yazıldığı yuva */
#define ES_RAM_BASE      ${hex(part.ramBase)}U
#define ES_RAM_END       ${hex(part.ramEnd)}U
#define ES_BOOT_SHARED   ((volatile uint32_t *)${hex(part.shared)}U) /* 4 kelime; resetten sonra korunur */
#define ES_PROG_UNIT     ${part.progUnit}U /* flash programlama birimi (bayt) */
#define ES_REMAP_VECTORS ${part.remapVectors ? 1 : 0} /* Cortex-M0: VTOR yok, vektörler RAM'e kopyalanır */

/* Güncelleme UART'ı: ${boot.uart} TX ${boot.tx} (AF${tx ? tx.af : '?'}), RX ${boot.rx} (AF${rx ? rx.af : '?'}), ${boot.baud} baud 8N1 */
#define ES_BOOT_UART     ${boot.uart || 'USART1'}
#define ES_BOOT_TX_PORT  ${t.port}
#define ES_BOOT_TX_PIN   ${t.n}U
#define ES_BOOT_TX_AF    ${tx && tx.af !== undefined ? tx.af : 0}U
#define ES_BOOT_RX_PORT  ${r.port}
#define ES_BOOT_RX_PIN   ${r.n}U
#define ES_BOOT_RX_AF    ${rx && rx.af !== undefined ? rx.af : 0}U
#define ES_BOOT_BAUD     ${boot.baud}U
#define ES_UART_ISR      ${['f1', 'f4'].includes(k) ? 0 : 1} /* 1: ISR/RDR/TDR (USART v2+), 0: SR/DR */

/* Açılışta güncelleme penceresi: bu sürede bootloader'a bir paket gelirse güncelleme moduna geçilir (0: kapalı) */
#define ES_BOOT_WAIT_MS  ${boot.waitMs}U
/* Güncelleme sırasında bağımsız watchdog (IWDG): paket gelmezse reset; commit'siz imaj çalıştırılmaz */
#define ES_BOOT_WDG_MS   10000U
/* İmaj CRC'si donanım CRC birimiyle (bit ters çevirme destekleyen ailelerde) */
#define ES_BOOT_HW_CRC   ${hwCrc ? 1 : 0}

/* ES-304 imza doğrulaması (Ed25519): ${pub ? `anahtar kimliği ${keyId(boot.pubKey)}. İmzasız ya da başka anahtarla imzalı imaj
 * güncellemede kabul edilmez (SWD ile yazılan ana yuva imzasız da çalışır: bootloader bölgesini RDP/WRP ile koruyun). */
#define ES_BOOT_SIGNED   1
#define ES_BOOT_PUBKEY   { ${pub.slice(0, 16).join(', ')}, \
                           ${pub.slice(16).join(', ')} }` : boot.signing ? `açık ama açık anahtar yok. */
#error "Bootloader imzası açık ama açık anahtar yok: Proje Ayarları > Bootloader > Anahtar üret / içe aktar, sonra Kod Üret."
#define ES_BOOT_SIGNED   0` : `kapalı. */
#define ES_BOOT_SIGNED   0`}

/* ES-304 geri dönüş koruması: ana yuvadakinden (ve en düşük sürümden) küçük sürüm reddedilir */
#define ES_BOOT_ROLLBACK ${boot.rollback ? 1 : 0}
#define ES_BOOT_MIN_VERSION ${hex(versionWord(boot.minVersion))}U /* ${boot.minVersion} */

#endif /* ES_BOOT_CONFIG_H */
`;
}

/** Taşınabilir çekirdek: paketler, komutlar, doğrulama (donanımdan bağımsız; bilgisayarda da derlenip test edilir) */
function coreHeader() {
  return `/* Embedded Studio (ES-303/304): bootloader çekirdeği. Donanımdan bağımsızdır; donanım işlevleri es_boot_port.* içinde.
 *
 * UART paket biçimi (bayt sırası küçük uçlu):
 *   istek : A5 | komut (1) | uzunluk (2) | veri | CRC-32 (komut..veri, 4)
 *   yanıt : A5 | durum (79 ACK / 1F NACK) | kod (1) | uzunluk (2) | veri | CRC-32 (durum..veri, 4)
 * Komutlar: 01 INFO, 02 START (toplam boyut [+ 64 bayt başlık]), 03 DATA (ofset + veri), 04 END (doğrula + commit
 * [+ A/B: ana yuvaya kur]), 05 BOOT (reset). Protokol 2 (ES-304): INFO'da yuva düzeni, imza ve sürüm tabanı. */
#ifndef ES_BOOT_CORE_H
#define ES_BOOT_CORE_H

#include <stdint.h>
#include "es_image.h"

#define ES_BOOT_PROTOCOL 2U
#define ES_BOOT_SOF      0xA5U
#define ES_BOOT_ACK      0x79U
#define ES_BOOT_NACK     0x1FU
#define ES_BOOT_MAX_DATA 1024U
#define ES_BOOT_INFO_SIZE 180U

enum { ES_CMD_INFO = 1, ES_CMD_START = 2, ES_CMD_DATA = 3, ES_CMD_END = 4, ES_CMD_BOOT = 5 };
/* NACK kodları */
enum { ES_ERR_OK = 0, ES_ERR_FRAME = 1, ES_ERR_CMD = 2, ES_ERR_ARG = 3, ES_ERR_STATE = 4, ES_ERR_FLASH = 5, ES_ERR_VERIFY = 6, ES_ERR_ROLLBACK = 7 };
/* Doğrulama sonucu */
enum { ES_IMG_OK = 0, ES_IMG_MAGIC = 1, ES_IMG_HDR_CRC = 2, ES_IMG_SIZE = 3, ES_IMG_COMMIT = 4, ES_IMG_CRC = 5, ES_IMG_VECTORS = 6,
       ES_IMG_SIG = 7, ES_IMG_ROLLBACK = 8 };
/* INFO bayrakları */
#define ES_INFO_AB       1U
#define ES_INFO_SIGNED   2U
#define ES_INFO_ROLLBACK 4U
/* es_boot_install sonucu */
enum { ES_INSTALL_NONE = 0, ES_INSTALL_DONE = 1, ES_INSTALL_REJECTED = 2, ES_INSTALL_FAILED = 3 };

/* Port (donanım) işlevleri: es_boot_port.c (kart) ya da test sahtesi */
void es_port_putc(uint8_t c);
int es_port_getc(uint32_t timeout_ms);              /* -1: zaman aşımı */
uint32_t es_port_ms(void);
int es_port_flash_erase(uint32_t addr, uint32_t len); /* [addr, addr+len) aralığını kapsayan birimleri siler; 0 başarılı */
int es_port_flash_write(uint32_t addr, const uint8_t *data, uint32_t len); /* len: ES_PROG_UNIT katı; 0 başarılı */
const uint8_t *es_port_flash_ptr(uint32_t addr);    /* flash'ı okumak için */
uint32_t es_port_image_crc(const uint8_t *p, uint32_t n); /* donanım CRC'si olabilir; yoksa es_crc32 */
uint32_t es_port_device_id(void);
void es_port_wdg_refresh(void);
void es_port_reset(void);

/* Çekirdek */
uint32_t es_crc32(uint32_t crc, const void *data, uint32_t n); /* crc: önceki değer (ilk çağrıda 0) */
int es_image_check(uint32_t base, int need_commit); /* base'deki imaj (ana ya da hazırlık yuvası; ana yuva için bağlanmış): ES_IMG_* */
int es_image_verify_sig(uint32_t base);            /* imza (ES_BOOT_SIGNED); kapalıysa ES_IMG_OK */
int es_boot_validate(int need_commit);              /* ana yuva: ES_IMG_* */
uint32_t es_boot_floor(void);                       /* kabul edilecek en düşük sürüm: ES_BOOT_MIN_VERSION ya da ana yuvadaki */
/* A/B: hazırlık yuvasında kurulmamış (ya da ana yuva bozuksa yedek) imaj varsa doğrulayıp ana yuvaya kopyalar.
 * ES_INSTALL_*; reddedilirse *detail = ES_IMG_*. Tek yuvada her zaman ES_INSTALL_NONE. */
int es_boot_install(uint8_t *detail);
/* Paketleri işler. idle_ms > 0 ise o sürede hiç geçerli paket gelmezse 0 döner (açılış penceresi); paket geldiyse
 * ya da idle_ms == 0 ise sonsuza dek çalışır (BOOT komutu reset atar). */
int es_boot_serve(uint32_t idle_ms);

#endif /* ES_BOOT_CORE_H */
`;
}

function coreSource() {
  return `/* Embedded Studio (ES-303/304): bootloader çekirdeği — paket ayrıştırma, komutlar, imaj doğrulama, imza, A/B kurulum. */
#include <string.h>
#include "es_boot_config.h"
#include "es_boot_core.h"
#include "es_ed25519.h"

/* ---- CRC-32 (zlib): tablo flash'ta (1 KB) */
static const uint32_t crc_table[256] = {
${crcTableC()}
};

uint32_t es_crc32(uint32_t crc, const void *data, uint32_t n)
{
  const uint8_t *p = (const uint8_t *)data;
  crc = ~crc;
  while (n--) crc = crc_table[(crc ^ *p++) & 0xFFU] ^ (crc >> 8);
  return ~crc;
}

static uint32_t rd32(const uint8_t *p) { return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24); }
static void wr32(uint8_t *p, uint32_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24); }
static const es_image_region_t *region(uint32_t base) { return (const es_image_region_t *)(const void *)es_port_flash_ptr(base); }

/* ---- imaj doğrulama */
int es_image_check(uint32_t base, int need_commit)
{
  const es_image_region_t *r = region(base);
  const es_image_hdr_t *h = &r->hdr;
  if (h->magic != ES_IMAGE_MAGIC || h->hdr_version != ES_IMAGE_HDR_VERSION || h->hdr_size != sizeof(es_image_hdr_t)) return ES_IMG_MAGIC;
  if (es_crc32(0, h, (uint32_t)((const uint8_t *)&h->hdr_crc - (const uint8_t *)h)) != h->hdr_crc) return ES_IMG_HDR_CRC;
  if (h->image_size < 8U || (h->image_size & 3U) || h->image_size > ES_IMAGE_MAX || h->vector_addr != ES_APP_VECTORS) return ES_IMG_SIZE;
  if (need_commit && r->commit[0] != ES_IMAGE_COMMIT_MAGIC) return ES_IMG_COMMIT;
  const uint8_t *img = es_port_flash_ptr(base + ES_IMAGE_REGION);
  if (es_port_image_crc(img, h->image_size) != h->image_crc) return ES_IMG_CRC;
  const uint32_t *v = (const uint32_t *)(const void *)img;
  /* İlk yığın işaretçisi RAM'de, reset vektörü ana yuvada ve Thumb */
  if (v[0] < ES_RAM_BASE || v[0] > ES_RAM_END || (v[0] & 3U)) return ES_IMG_VECTORS;
  if (v[1] < ES_APP_VECTORS || v[1] >= ES_SLOT_BASE + ES_SLOT_SIZE || !(v[1] & 1U)) return ES_IMG_VECTORS;
  return ES_IMG_OK;
}

int es_boot_validate(int need_commit) { return es_image_check(ES_SLOT_BASE, need_commit); }

void es_ed25519_yield(void) { es_port_wdg_refresh(); }

#if ES_BOOT_SIGNED
static const uint8_t pubkey[32] = ES_BOOT_PUBKEY;

/* Ed25519(başlık (64 bayt) || imaj); imza bloğu başlık bölgesinde (0x40). Anahtar kimliği = açık anahtarın ilk 8 baytı. */
int es_image_verify_sig(uint32_t base)
{
  const es_image_region_t *r = region(base);
  const es_image_sig_t *s = &r->sig;
  if (s->magic != ES_IMAGE_SIG_MAGIC || s->alg != ES_IMAGE_SIG_ED25519 || s->sig_size != 64U || memcmp(s->key_id, pubkey, 8) != 0) return ES_IMG_SIG;
  static es_sha512_t c; /* yığında değil: küçük RAM'li işlemciler */
  uint8_t h[64];
  es_sha512_init(&c);
  es_sha512_update(&c, s->sig, 32);
  es_sha512_update(&c, pubkey, 32);
  es_sha512_update(&c, &r->hdr, sizeof r->hdr);
  const uint8_t *p = es_port_flash_ptr(base + ES_IMAGE_REGION);
  for (uint32_t o = 0; o < r->hdr.image_size; o += 4096U) {
    uint32_t n = r->hdr.image_size - o < 4096U ? r->hdr.image_size - o : 4096U;
    es_sha512_update(&c, p + o, n);
    es_port_wdg_refresh();
  }
  es_sha512_final(&c, h);
  return es_ed25519_verify(s->sig, pubkey, h) == 0 ? ES_IMG_OK : ES_IMG_SIG;
}
#else
int es_image_verify_sig(uint32_t base)
{
  (void)base;
  return ES_IMG_OK;
}
#endif

uint32_t es_boot_floor(void)
{
  uint32_t f = ES_BOOT_MIN_VERSION;
  if (es_image_check(ES_SLOT_BASE, 1) == ES_IMG_OK && region(ES_SLOT_BASE)->hdr.fw_version > f) f = region(ES_SLOT_BASE)->hdr.fw_version;
  return f;
}

/* Alınan ya da kurulacak imaj: biçim + CRC, sürüm tabanı, imza (en pahalısı en son) */
static int accept(uint32_t base, int need_commit, uint32_t floor_version)
{
  int v = es_image_check(base, need_commit);
  if (v != ES_IMG_OK) return v;
#if ES_BOOT_ROLLBACK
  if (region(base)->hdr.fw_version < floor_version) return ES_IMG_ROLLBACK;
#else
  (void)floor_version;
#endif
  return es_image_verify_sig(base);
}

/* Bir programlama birimine 32 bitlik işaret yazar (commit, kuruldu) */
static int write_mark(uint32_t addr, uint32_t magic)
{
  uint8_t c[ES_PROG_UNIT < 4U ? 4U : ES_PROG_UNIT];
  memset(c, 0xFF, sizeof c);
  wr32(c, magic);
  return es_port_flash_write(addr, c, sizeof c);
}

/* base'deki yuvaya yazar; işaret blokları (kuruldu + commit: 0x3C0–0x3FF) atlanır — onları yalnızca bootloader,
 * doğrulamadan sonra yazar — tamamı 0xFF olan birimler de */
static int write_slot(uint32_t base, uint32_t off, const uint8_t *p, uint32_t n)
{
  static uint8_t unit[ES_PROG_UNIT];
  for (uint32_t i = 0; i < n; i += ES_PROG_UNIT) {
    uint32_t o = off + i;
    uint32_t k = n - i < ES_PROG_UNIT ? n - i : ES_PROG_UNIT;
    if (o + ES_PROG_UNIT > ES_IMAGE_STATE_OFF && o < ES_IMAGE_REGION) continue;
    memset(unit, 0xFF, sizeof unit);
    memcpy(unit, p + i, k);
    int blank = 1;
    for (uint32_t j = 0; j < ES_PROG_UNIT; j++) if (unit[j] != 0xFFU) { blank = 0; break; }
    if (blank) continue;
    if (es_port_flash_write(base + o, unit, ES_PROG_UNIT)) return -1;
    es_port_wdg_refresh();
  }
  return 0;
}

#if ES_BOOT_AB
/* Hazırlık yuvasındaki doğrulanmış imajı ana yuvaya kopyalar. Ana yuvanın commit'i en son, ardından hazırlık yuvasına
 * "kuruldu" yazılır. Kesilirse ana yuva commit'siz kalır; bir sonraki açılışta kopyalama baştan yapılır. */
static int copy_stage(void)
{
  uint32_t n = ES_IMAGE_REGION + region(ES_STAGE_BASE)->hdr.image_size;
  if (es_port_flash_erase(ES_SLOT_BASE, n)) return -1;
  if (write_slot(ES_SLOT_BASE, 0, es_port_flash_ptr(ES_STAGE_BASE), n)) return -1;
  if (es_image_check(ES_SLOT_BASE, 0) != ES_IMG_OK) return -1;
  if (write_mark(ES_SLOT_BASE + ES_IMAGE_COMMIT_OFF, ES_IMAGE_COMMIT_MAGIC)) return -1;
  if (es_image_check(ES_SLOT_BASE, 1) != ES_IMG_OK) return -1;
  if (region(ES_STAGE_BASE)->state[0] == ES_IMAGE_DONE_MAGIC) return 0; /* yedekten kurtarma: işaret zaten var */
  return write_mark(ES_STAGE_BASE + ES_IMAGE_STATE_OFF, ES_IMAGE_DONE_MAGIC);
}

int es_boot_install(uint8_t *detail)
{
  const es_image_region_t *s = region(ES_STAGE_BASE);
  *detail = 0;
  if (s->hdr.magic != ES_IMAGE_MAGIC || s->commit[0] != ES_IMAGE_COMMIT_MAGIC) return ES_INSTALL_NONE;
  int done = s->state[0] == ES_IMAGE_DONE_MAGIC;
  int primary = es_image_check(ES_SLOT_BASE, 1) == ES_IMG_OK;
  if (primary && done) return ES_INSTALL_NONE;
  if (primary && memcmp(&s->hdr, &region(ES_SLOT_BASE)->hdr, sizeof s->hdr) == 0) {
    /* Kopyalandı, "kuruldu" yazılamadan kesilmiş */
    (void)write_mark(ES_STAGE_BASE + ES_IMAGE_STATE_OFF, ES_IMAGE_DONE_MAGIC);
    return ES_INSTALL_NONE;
  }
  /* Bekleyen güncelleme ya da ana yuva bozuk (hazırlık yuvasındaki son imajdan kurtarma) */
  int v = accept(ES_STAGE_BASE, 1, primary ? es_boot_floor() : ES_BOOT_MIN_VERSION);
  if (v != ES_IMG_OK) {
    if (!done) (void)write_mark(ES_STAGE_BASE + ES_IMAGE_STATE_OFF, ES_IMAGE_DONE_MAGIC); /* her açılışta yeniden denenmesin */
    *detail = (uint8_t)v;
    return ES_INSTALL_REJECTED;
  }
  return copy_stage() ? ES_INSTALL_FAILED : ES_INSTALL_DONE;
}
#else
int es_boot_install(uint8_t *detail)
{
  *detail = 0;
  return ES_INSTALL_NONE;
}
#endif

/* ---- paketler */
static uint8_t frame[4U + 4U + ES_BOOT_MAX_DATA + 4U];
static uint32_t total;   /* START ile bildirilen toplam boyut (yuva başından) */
static uint32_t written; /* sıradaki beklenen ofset */
static uint32_t vfloor;  /* START'ta (silmeden önce) belirlenen en düşük sürüm */
static int started;

static void reply(uint8_t status, uint8_t code, const uint8_t *data, uint16_t len)
{
  uint8_t head[4] = { status, code, (uint8_t)len, (uint8_t)(len >> 8) };
  uint8_t c[4];
  uint32_t crc = es_crc32(es_crc32(0, head, 4), data, len);
  wr32(c, crc);
  es_port_putc(ES_BOOT_SOF);
  for (uint32_t i = 0; i < 4U; i++) es_port_putc(head[i]);
  for (uint32_t i = 0; i < len; i++) es_port_putc(data[i]);
  for (uint32_t i = 0; i < 4U; i++) es_port_putc(c[i]);
}
static void ack(const uint8_t *data, uint16_t len) { reply(ES_BOOT_ACK, ES_ERR_OK, data, len); }
static void nack(uint8_t code, uint8_t detail) { reply(ES_BOOT_NACK, code, &detail, 1); }

/* Bir paket okur: komut ve veri uzunluğu; -1 zaman aşımı (hiç bayt yok), -2 bozuk paket */
static int read_frame(uint32_t first_timeout, uint8_t *cmd, uint16_t *len)
{
  int c;
  do {
    c = es_port_getc(first_timeout);
    if (c < 0) return -1;
  } while (c != ES_BOOT_SOF);
  for (uint32_t i = 0; i < 3U; i++) {
    if ((c = es_port_getc(100)) < 0) return -2;
    frame[i] = (uint8_t)c;
  }
  uint16_t n = (uint16_t)(frame[1] | (frame[2] << 8));
  if (n > ES_BOOT_MAX_DATA + 4U) return -2;
  for (uint32_t i = 0; i < n + 4U; i++) {
    if ((c = es_port_getc(100)) < 0) return -2;
    frame[3U + i] = (uint8_t)c;
  }
  if (es_crc32(0, frame, 3U + n) != rd32(&frame[3U + n])) return -2;
  *cmd = frame[0];
  *len = n;
  return 0;
}

static void cmd_info(void)
{
  static uint8_t d[ES_BOOT_INFO_SIZE];
  memset(d, 0, sizeof d);
  d[0] = ES_BOOT_PROTOCOL;
  d[1] = ES_BOOT_VERSION_MAJOR;
  d[2] = ES_BOOT_VERSION_MINOR;
  d[3] = (uint8_t)es_boot_validate(1); /* ana yuvadaki uygulama (0: geçerli) */
  wr32(&d[4], ES_SLOT_BASE);
  wr32(&d[8], ES_SLOT_SIZE);
  d[12] = (uint8_t)ES_BOOT_MAX_DATA; d[13] = (uint8_t)(ES_BOOT_MAX_DATA >> 8);
  d[14] = (uint8_t)ES_PROG_UNIT; d[15] = (uint8_t)(ES_PROG_UNIT >> 8);
  wr32(&d[16], es_port_device_id());
  memcpy(&d[20], es_port_flash_ptr(ES_SLOT_BASE), sizeof(es_image_hdr_t));
  /* Protokol 2 (ES-304) */
  wr32(&d[84], (ES_BOOT_AB ? ES_INFO_AB : 0U) | (ES_BOOT_SIGNED ? ES_INFO_SIGNED : 0U) | (ES_BOOT_ROLLBACK ? ES_INFO_ROLLBACK : 0U));
  wr32(&d[88], ES_STAGE_BASE);
  wr32(&d[92], ES_STAGE_SIZE);
  wr32(&d[96], ES_IMAGE_MAX);
  wr32(&d[100], es_boot_floor());
#if ES_BOOT_SIGNED
  memcpy(&d[104], pubkey, 8);
#endif
#if ES_BOOT_AB
  d[112] = (uint8_t)es_image_check(ES_STAGE_BASE, 1);
  d[113] = region(ES_STAGE_BASE)->state[0] == ES_IMAGE_DONE_MAGIC;
  memcpy(&d[116], es_port_flash_ptr(ES_STAGE_BASE), sizeof(es_image_hdr_t));
#endif
  ack(d, sizeof d);
}

static void cmd_start(uint16_t len)
{
  if (len != 4U && len != 4U + sizeof(es_image_hdr_t)) { nack(ES_ERR_ARG, 0); return; }
  uint32_t size = rd32(&frame[3]);
  if (size < ES_IMAGE_REGION + 8U || size > ES_IMAGE_REGION + ES_IMAGE_MAX) { nack(ES_ERR_ARG, 1); return; }
  started = 0;
  vfloor = es_boot_floor(); /* tek yuvada eski imaj birazdan silinir */
  if (len > 4U) {
    /* Başlık önceden geldiyse: silmeden önce yuva ve sürüm denetimi */
    es_image_hdr_t h;
    memcpy(&h, &frame[7], sizeof h);
    if (h.magic != ES_IMAGE_MAGIC || h.vector_addr != ES_APP_VECTORS) { nack(ES_ERR_ARG, 2); return; }
#if ES_BOOT_ROLLBACK
    if (h.fw_version < vfloor) { nack(ES_ERR_ROLLBACK, 0); return; }
#endif
  }
  if (es_port_flash_erase(ES_RECV_BASE, size)) { nack(ES_ERR_FLASH, 0); return; }
  total = size;
  written = 0;
  started = 1;
  ack(0, 0);
}

static void cmd_data(uint16_t len)
{
  if (!started) { nack(ES_ERR_STATE, 0); return; }
  if (len < 5U) { nack(ES_ERR_ARG, 0); return; }
  uint32_t off = rd32(&frame[3]);
  uint32_t n = len - 4U;
  /* Önceki ACK kaybolup aynı paket yeniden geldiyse: yazmadan onayla */
  if (off + n == written && off < written) { ack(0, 0); return; }
  if (off != written || off + n > total || ((n % ES_PROG_UNIT) && off + n != total)) { nack(ES_ERR_ARG, 1); return; }
  if (write_slot(ES_RECV_BASE, off, &frame[7], n)) { nack(ES_ERR_FLASH, 0); return; }
  /* Yazılanı geri oku */
  const uint8_t *f = es_port_flash_ptr(ES_RECV_BASE + off);
  for (uint32_t i = 0; i < n; i++) {
    uint32_t o = off + i;
    if (o >= ES_IMAGE_STATE_OFF && o < ES_IMAGE_REGION) continue;
    if (f[i] != frame[7U + i]) { nack(ES_ERR_VERIFY, 0); return; }
  }
  written = off + n;
  ack(0, 0);
}

static void cmd_end(void)
{
  if (!started || written != total) { nack(ES_ERR_STATE, 0); return; }
#if ES_BOOT_AB
  vfloor = es_boot_floor(); /* ana yuva yerinde */
#endif
  int v = accept(ES_RECV_BASE, 0, vfloor);
  if (v != ES_IMG_OK) { nack(ES_ERR_VERIFY, (uint8_t)v); return; }
  /* Commit: ayrı programlama birimi; yazıldıktan sonra imaj çalıştırılabilir (A/B: kurulabilir) */
  if (write_mark(ES_RECV_BASE + ES_IMAGE_COMMIT_OFF, ES_IMAGE_COMMIT_MAGIC)) { nack(ES_ERR_FLASH, 1); return; }
  v = es_image_check(ES_RECV_BASE, 1);
  if (v != ES_IMG_OK) { nack(ES_ERR_VERIFY, (uint8_t)v); return; }
  started = 0;
#if ES_BOOT_AB
  /* Yeni imaj doğrulandı: ancak şimdi ana yuva silinip yerine kopyalanır */
  if (copy_stage()) { nack(ES_ERR_FLASH, 2); return; }
#endif
  ack(0, 0);
}

int es_boot_serve(uint32_t idle_ms)
{
  int active = idle_ms == 0U;
  uint32_t t0 = es_port_ms();
  for (;;) {
    uint8_t cmd;
    uint16_t len;
    es_port_wdg_refresh();
    uint32_t wait = 200U;
    if (!active) {
      uint32_t el = es_port_ms() - t0;
      if (el >= idle_ms) return 0;
      wait = idle_ms - el;
    }
    int r = read_frame(wait, &cmd, &len);
    if (r == -1) continue;
    if (r == -2) { nack(ES_ERR_FRAME, 0); continue; }
    active = 1;
    switch (cmd) {
      case ES_CMD_INFO: cmd_info(); break;
      case ES_CMD_START: cmd_start(len); break;
      case ES_CMD_DATA: cmd_data(len); break;
      case ES_CMD_END: cmd_end(); break;
      case ES_CMD_BOOT:
        ack(0, 0);
        es_port_reset(); /* temiz açılış: watchdog durur, imaj doğrulanıp çalıştırılır */
        return 1;
      default: nack(ES_ERR_CMD, cmd); break;
    }
  }
}
`;
}

/** CRC-32 tablosu (C dizisi) */
function crcTableC() {
  const rows = [];
  const tab = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    tab.push(hex(c >>> 0) + 'U');
  }
  for (let i = 0; i < 256; i += 6) rows.push('  ' + tab.slice(i, i + 6).join(', ') + ',');
  return rows.join('\n').replace(/,$/, '');
}

/** STM32 port katmanı: UART, flash, SysTick, IWDG, CRC, uygulamaya atlama */
function portSource(mcu, boot, part) {
  const k = familyOf(mcu).key;
  const v1 = k === 'f1'; // F1: GPIO CRL/CRH; RX giriş
  const ll = mcu.device.ll || {};
  const syscfg = ll.syscfg;
  const units = part.units;
  return `/* Embedded Studio (ES-303): bootloader port katmanı — ${mcu.name}. Register sürücüleri (reg/) ve CMSIS kullanır. */
#include "${familyOf(mcu).cmsisHeader}"
#include "es_boot_config.h"
#include "es_boot_core.h"
#include "es_boot_port.h"
#include "es_gpio.h"
#include "es_uart.h"
#include "es_flash.h"
#include "es_iwdg.h"

static volatile uint32_t ticks;
static int wdg_on;

void SysTick_Handler(void) { ticks++; }
uint32_t es_port_ms(void) { return ticks; }

void es_port_init(void)
{
  SystemCoreClockUpdate(); /* resetten sonraki saat (HSI / MSI); APB bölücüleri 1 */
  SysTick_Config(SystemCoreClock / 1000U);
  es_gpio_clock_enable(ES_BOOT_TX_PORT);
  es_gpio_clock_enable(ES_BOOT_RX_PORT);
  es_gpio_init(ES_BOOT_TX_PORT, ES_BOOT_TX_PIN, ES_GPIO_AF, ES_GPIO_NOPULL, ES_GPIO_PUSHPULL, ES_BOOT_TX_AF);
  es_gpio_init(ES_BOOT_RX_PORT, ES_BOOT_RX_PIN, ${v1 ? 'ES_GPIO_INPUT' : 'ES_GPIO_AF'}, ES_GPIO_PULLUP, ES_GPIO_PUSHPULL, ES_BOOT_RX_AF);
  es_uart_clock_enable(ES_BOOT_UART);
  es_uart_init(ES_BOOT_UART, SystemCoreClock, ES_BOOT_BAUD);
}

void es_port_putc(uint8_t c) { es_uart_putc(ES_BOOT_UART, c); }

int es_port_getc(uint32_t timeout_ms)
{
  uint32_t t0 = ticks;
  do {
#if ES_UART_ISR
    uint32_t isr = ES_BOOT_UART->ISR;
    if (isr & USART_ISR_ORE) ES_BOOT_UART->ICR = USART_ICR_ORECF;
#if defined(USART_ISR_RXNE_RXFNE)
    if (isr & USART_ISR_RXNE_RXFNE) return (int)(ES_BOOT_UART->RDR & 0xFFU);
#else
    if (isr & USART_ISR_RXNE) return (int)(ES_BOOT_UART->RDR & 0xFFU);
#endif
#else
    if (ES_BOOT_UART->SR & (USART_SR_RXNE | USART_SR_ORE)) {
      uint32_t sr = ES_BOOT_UART->SR;
      uint32_t d = ES_BOOT_UART->DR; /* SR sonra DR okumak ORE'yi de temizler */
      if (sr & USART_SR_RXNE) return (int)(d & 0xFFU);
    }
#endif
  } while (ticks - t0 < timeout_ms);
  return -1;
}

${units.length > 64 ? `/* Yuvadaki silme birimleri: ${units.length} sayfa, hepsi ${units[0].size / 1024} KB, ${hex(units[0].addr)}'den başlayarak */` : `/* Yuvadaki silme birimleri (${part.pageType === 'sector' ? 'sektörler' : 'sayfalar'}) */
static const struct { uint32_t addr, size; } units[] = {
${units.map((x) => `  { ${hex(x.addr)}U, ${hex(x.size)}U },`).join('\n')}
};`}

int es_port_flash_erase(uint32_t addr, uint32_t len)
{
  int r = 0;
  es_flash_unlock();
${units.length > 64 ? `  for (uint32_t a = ${hex(units[0].addr)}U; a < ES_SLOT_BASE + ES_SLOT_SIZE && !r; a += ${hex(units[0].size)}U) {
    if (a + ${hex(units[0].size)}U <= addr || a >= addr + len) continue;
    r = es_flash_erase(a);
    es_port_wdg_refresh();
  }` : `  for (uint32_t i = 0; i < sizeof units / sizeof units[0] && !r; i++) {
    if (units[i].addr + units[i].size <= addr || units[i].addr >= addr + len) continue;
    r = es_flash_erase(units[i].addr);
    es_port_wdg_refresh();
  }`}
  es_flash_lock();
  return r;
}

int es_port_flash_write(uint32_t addr, const uint8_t *data, uint32_t len)
{
  es_flash_unlock();
  int r = es_flash_program(addr, data, len);
  es_flash_lock();
  return r;
}

const uint8_t *es_port_flash_ptr(uint32_t addr) { return (const uint8_t *)addr; }

uint32_t es_port_image_crc(const uint8_t *p, uint32_t n)
{
#if ES_BOOT_HW_CRC && defined(CRC_CR_REV_IN) && defined(CRC_CR_REV_OUT)
  /* Donanım CRC: kelime bazında bit ters çevirme (REV_IN = 11), çıkış ters (REV_OUT), başlangıç 0xFFFFFFFF;
   * küçük uçlu kelimelerle yazılınca zlib CRC-32'nin aynısı (son XOR yazılımda). */
  ${ll.crc ? `RCC->${ll.crc.reg} |= ${ll.crc.bit};` : '/* CRC saat bayrağı bulunamadı */'}
  (void)RCC->CR;
  CRC->INIT = 0xFFFFFFFFU;
  CRC->CR = CRC_CR_REV_IN | CRC_CR_REV_OUT | CRC_CR_RESET;
  const uint32_t *w = (const uint32_t *)(const void *)p;
  for (uint32_t i = 0; i < n / 4U; i++) {
    CRC->DR = w[i];
    if ((i & 0x3FFU) == 0U) es_port_wdg_refresh();
  }
  return ~CRC->DR;
#else
  return es_crc32(0, p, n);
#endif
}

uint32_t es_port_device_id(void)
{
#if defined(DBGMCU)
  return DBGMCU->IDCODE & 0xFFFU;
#elif defined(DBG)
  return DBG->IDCODE & 0xFFFU; /* G0 */
#else
  return 0;
#endif
}

void es_port_wdg_start(void)
{
  es_iwdg_start(ES_BOOT_WDG_MS);
  wdg_on = 1;
}

void es_port_wdg_refresh(void)
{
  if (wdg_on) es_iwdg_refresh();
}

void es_port_reset(void)
{
  uint32_t t0 = ticks;
  while (ticks - t0 < 20U) {
  } /* son yanıt gönderilsin */
  NVIC_SystemReset();
}

/* Uygulamaya atlama: kesmeleri ve kullanılan birimleri kapat, VTOR (Cortex-M0'da RAM'e kopyala + yeniden eşle), MSP, reset vektörü */
void es_port_jump(void)
{
  const uint32_t *v = (const uint32_t *)ES_APP_VECTORS;
  __disable_irq();
  SysTick->CTRL = 0;
  SysTick->VAL = 0;
  ES_BOOT_UART->CR1 = 0;
  for (uint32_t i = 0; i < sizeof NVIC->ICER / sizeof NVIC->ICER[0]; i++) {
    NVIC->ICER[i] = 0xFFFFFFFFU;
    NVIC->ICPR[i] = 0xFFFFFFFFU;
  }
#if ES_REMAP_VECTORS
  /* Cortex-M0: vektör tablosu RAM başına (uygulama RAM'i 0x${part.appRamOffset.toString(16).toUpperCase()}'den başlar), SYSCFG MEM_MODE = SRAM */
  volatile uint32_t *ram = (volatile uint32_t *)ES_RAM_BASE;
  for (uint32_t i = 0; i < ${part.appRamOffset / 4}U; i++) ram[i] = v[i];
  ${syscfg ? `RCC->${syscfg.reg} |= ${syscfg.bit};` : '/* SYSCFG saati */'}
  SYSCFG->CFGR1 = (SYSCFG->CFGR1 & ~SYSCFG_CFGR1_MEM_MODE) | SYSCFG_CFGR1_MEM_MODE;
#else
  SCB->VTOR = ES_APP_VECTORS;
#endif
  __DSB();
  __ISB();
  __set_MSP(v[0]);
  __enable_irq();
  ((void (*)(void))v[1])();
  for (;;) {
  }
}
`;
}

function portHeader() {
  return `/* Embedded Studio (ES-303): STM32'ye özgü port işlevleri (es_boot_core.h'dekilere ek) */
#ifndef ES_BOOT_PORT_H
#define ES_BOOT_PORT_H

void es_port_init(void);
void es_port_wdg_start(void);
void es_port_jump(void);

#endif
`;
}

function bootMain(userBlock) {
  return `/* Embedded Studio (ES-303/304): bootloader ana programı.
 * Açılış: (0) A/B düzeninde hazırlık yuvasında kurulmamış imaj varsa doğrulanıp ana yuvaya kopyalanır;
 * (1) uygulama güncelleme istediyse (ortak RAM'de ES_BOOT_REQUEST_MAGIC) ya da geçerli imaj yoksa
 * güncelleme modu; (2) yoksa ES_BOOT_WAIT_MS boyunca UART'tan paket beklenir; gelmezse imaj doğrulanıp çalıştırılır.
 * Kendi eklemelerinizi USER CODE bloklarına yazın (ör. bir düğmeyle güncelleme moduna girme, durum LED'i). */
#include "es_boot_config.h"
#include "es_boot_core.h"
#include "es_boot_port.h"
${userBlock('Includes')}

int main(void)
{
  es_port_init();
${userBlock('Init').split('\n').map((l) => '  ' + l).join('\n')}
#if ES_BOOT_AB
  uint8_t detail;
  (void)es_boot_install(&detail); /* kesilen kurulum da burada tamamlanır */
#endif
  uint32_t request = ES_BOOT_SHARED[0];
  ES_BOOT_SHARED[0] = 0;
  int force = request == ES_BOOT_REQUEST_MAGIC;
${userBlock('Force').split('\n').map((l) => '  ' + l).join('\n')}
  if (!force && es_boot_validate(1) == ES_IMG_OK) {
    if (ES_BOOT_WAIT_MS == 0U || es_boot_serve(ES_BOOT_WAIT_MS) == 0) es_port_jump();
  }
  /* Güncelleme modu: watchdog açık; paket gelmezse reset olur, commit'siz imaj yine çalıştırılmaz */
  es_port_wdg_start();
  es_boot_serve(0);
  for (;;) {
  }
}
`;
}

/** Uygulama tarafı: başlık örneği (.es_header) ve güncelleme isteği */
function appHeaderSource() {
  return `/* Embedded Studio (ES-303): uygulama imaj başlığı. Bağlayıcı bunu yuvanın başına (.es_header) koyar;
 * boyut, CRC ve commit derlemeden sonra cmake/es-image.cmake ile doldurulur. Sürüm: Proje Ayarları > Bootloader. */
#include "es_image.h"

#ifndef ES_FW_VERSION
#define ES_FW_VERSION 0x01000000U
#endif
#ifndef ES_BUILD_ID
#define ES_BUILD_ID "dev"
#endif
#ifndef ES_APP_VECTORS
#error "ES_APP_VECTORS tanımlı değil (cmake/embedded-studio.cmake)"
#endif

__attribute__((section(".es_header"), used))
const es_image_region_t es_image = {
  .hdr = {
    .magic = ES_IMAGE_MAGIC,
    .hdr_version = ES_IMAGE_HDR_VERSION,
    .hdr_size = sizeof(es_image_hdr_t),
    .image_size = 0xFFFFFFFFU,
    .image_crc = 0xFFFFFFFFU,
    .fw_version = ES_FW_VERSION,
    .vector_addr = ES_APP_VECTORS,
    .flags = 0,
    .build_id = ES_BUILD_ID,
    .hdr_crc = 0xFFFFFFFFU,
  },
  .sig = { 0 }, /* Embedded Studio imzalarken doldurur (ES-304) */
  .reserved = { 0 },
  .state = { 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU },
  .commit = { 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU, 0xFFFFFFFFU },
};
`;
}

function appApiHeader() {
  return `/* Embedded Studio (ES-303): uygulamadan bootloader işlevleri */
#ifndef ES_BOOT_H
#define ES_BOOT_H

#include <stdint.h>
#include "es_image.h"

/* Bu uygulamanın başlığı (sürüm, derleme kimliği) */
extern const es_image_region_t es_image;

/* Bootloader'a güncelleme modunda girmek için reset atar (geri dönmez) */
void es_boot_request_update(void);

#endif
`;
}

function appApiSource(mcu, part) {
  return `/* Embedded Studio (ES-303): uygulamadan bootloader işlevleri */
#include "${familyOf(mcu).cmsisHeader}"
#include "es_boot.h"

#define ES_BOOT_SHARED ((volatile uint32_t *)${hex(part.shared)}U) /* RAM sonu - 16: bağlayıcı betiği bu alanı ayırır */

void es_boot_request_update(void)
{
  ES_BOOT_SHARED[0] = ES_BOOT_REQUEST_MAGIC;
  __DSB();
  NVIC_SystemReset();
}
`;
}

/** Derleme sonrası başlık: boyut, CRC, başlık CRC'si, commit (cmake -P) ve bootloader + uygulama birleşik HEX */
function imageScript() {
  return `# Embedded Studio (ES-303): uygulama imajına başlık yazar ya da bootloader + uygulama HEX'lerini birleştirir.
# Her "Kod Üret"te yeniden yazılır. Kullanım (embedded-studio.cmake çağırır):
#   cmake -DMODE=header -DELF=app.elf -DOBJCOPY=arm-none-eabi-objcopy -P es-image.cmake
#   cmake -DMODE=merge -DBOOT_HEX=boot.hex -DAPP_HEX=app.hex -DOUT=full.hex -P es-image.cmake
# CRC-32 (zlib) CMake ile hesaplanır: ek araç gerekmez (64 KB ≈ 1 sn).
cmake_minimum_required(VERSION 3.20)

if(MODE STREQUAL "merge")
  # file(STRINGS) Intel HEX'i kendiliğinden ikiliye çevirir: metin olarak oku
  file(READ "\${BOOT_HEX}" a)
  file(READ "\${APP_HEX}" b)
  string(REGEX REPLACE ":00000001FF[\\r\\n]*" "" a "\${a}")
  # Giriş noktası bootloader'ınki kalsın (uygulamanın başlangıç adresi kaydı, tip 05, çıkarılır)
  string(REGEX REPLACE ":04000005[0-9A-Fa-f]+[\\r\\n]*" "" b "\${b}")
  file(WRITE "\${OUT}" "\${a}\${b}")
  return()
endif()

set(REGION 1024)
set(COMMIT_OFF 992)
set(COMMIT_MAGIC 0x54494D43)

# CRC-32 tablosu
set(TABLE "")
foreach(i RANGE 255)
  set(c \${i})
  foreach(k RANGE 7)
    math(EXPR lsb "\${c} & 1")
    if(lsb)
      math(EXPR c "(\${c} >> 1) ^ 0xEDB88320")
    else()
      math(EXPR c "\${c} >> 1")
    endif()
  endforeach()
  list(APPEND TABLE \${c})
endforeach()

# BYTES: "AA;BB;..." onaltılık bayt listesi
function(es_crc32 out)
  set(crc 4294967295)
  foreach(b IN LISTS ARGN)
    math(EXPR idx "(\${crc} ^ 0x\${b}) & 255")
    list(GET TABLE \${idx} t)
    math(EXPR crc "((\${crc} >> 8) & 0xFFFFFF) ^ \${t}")
  endforeach()
  math(EXPR crc "\${crc} ^ 0xFFFFFFFF")
  set(\${out} \${crc} PARENT_SCOPE)
endfunction()

# 32 bit değer → küçük uçlu 4 bayt (onaltılık liste)
function(es_le32 out value)
  math(EXPR v "\${value}" OUTPUT_FORMAT HEXADECIMAL)
  string(SUBSTRING "\${v}" 2 -1 v)
  string(LENGTH "\${v}" n)
  while(n LESS 8)
    string(PREPEND v "0")
    math(EXPR n "\${n} + 1")
  endwhile()
  string(TOUPPER "\${v}" v)
  string(SUBSTRING "\${v}" 6 2 b0)
  string(SUBSTRING "\${v}" 4 2 b1)
  string(SUBSTRING "\${v}" 2 2 b2)
  string(SUBSTRING "\${v}" 0 2 b3)
  set(\${out} \${b0} \${b1} \${b2} \${b3} PARENT_SCOPE)
endfunction()

get_filename_component(dir "\${ELF}" DIRECTORY)
set(raw "\${dir}/es_image_raw.bin")
execute_process(COMMAND "\${OBJCOPY}" --gap-fill 0xFF -O binary "\${ELF}" "\${raw}" RESULT_VARIABLE rc)
if(rc)
  message(FATAL_ERROR "es-image: objcopy başarısız (\${rc})")
endif()
file(READ "\${raw}" data HEX)
string(TOUPPER "\${data}" data)
string(LENGTH "\${data}" n)
math(EXPR size "\${n} / 2 - \${REGION}")
if(size LESS 8)
  message(FATAL_ERROR "es-image: imaj çok küçük ya da .es_header yok")
endif()
math(EXPR start "\${REGION} * 2")
string(SUBSTRING "\${data}" \${start} -1 image)
# 4'ün katına 0xFF ile tamamla (cihazda silinmiş flash)
math(EXPR pad "(4 - \${size} % 4) % 4")
set(i 0)
while(i LESS pad)
  string(APPEND image "FF")
  math(EXPR i "\${i} + 1")
endwhile()
math(EXPR size "\${size} + \${pad}")
string(REGEX MATCHALL ".." ibytes "\${image}")
es_crc32(crc \${ibytes})

# Başlık: ilk 60 bayt (magic … build_id) ELF'teki gibi; boyut ve CRC alanları değişir
string(SUBSTRING "\${data}" 0 2048 region)
string(REGEX MATCHALL ".." rb "\${region}")
list(SUBLIST rb 0 4 magic)
if(NOT "\${magic}" STREQUAL "45;49;4D;47")
  message(FATAL_ERROR "es-image: .es_header başında ES_IMAGE_MAGIC yok (\${magic})")
endif()
es_le32(sz \${size})
es_le32(cc \${crc})
list(SUBLIST rb 0 8 h0)
list(SUBLIST rb 16 44 h1)
set(hdr \${h0} \${sz} \${cc} \${h1})
es_crc32(hcrc \${hdr})
es_le32(hc \${hcrc})
list(SUBLIST rb 64 928 mid)
es_le32(cm \${COMMIT_MAGIC})
set(newregion \${hdr} \${hc} \${mid} \${cm})
foreach(i RANGE 1 28)
  list(APPEND newregion FF)
endforeach()

# Intel HEX → ikili → ELF'in .es_header bölümüne
set(lines "")
foreach(off RANGE 0 1008 16)
  list(SUBLIST newregion \${off} 16 rec)
  math(EXPR hi "(\${off} >> 8) & 255")
  math(EXPR lo "\${off} & 255")
  set(sum 0)
  math(EXPR sum "16 + \${hi} + \${lo}")
  set(line ":10")
  math(EXPR a "\${off}" OUTPUT_FORMAT HEXADECIMAL)
  string(SUBSTRING "\${a}" 2 -1 a)
  string(LENGTH "\${a}" al)
  while(al LESS 4)
    string(PREPEND a "0")
    math(EXPR al "\${al} + 1")
  endwhile()
  string(APPEND line "\${a}00")
  foreach(b IN LISTS rec)
    string(APPEND line "\${b}")
    math(EXPR sum "\${sum} + 0x\${b}")
  endforeach()
  math(EXPR cs "(256 - (\${sum} & 255)) & 255" OUTPUT_FORMAT HEXADECIMAL)
  string(SUBSTRING "\${cs}" 2 -1 cs)
  string(LENGTH "\${cs}" cl)
  if(cl LESS 2)
    string(PREPEND cs "0")
  endif()
  string(TOUPPER "\${line}\${cs}" line)
  string(APPEND lines "\${line}\\n")
endforeach()
string(APPEND lines ":00000001FF\\n")
file(WRITE "\${dir}/es_image_hdr.hex" "\${lines}")
execute_process(COMMAND "\${OBJCOPY}" -I ihex -O binary "\${dir}/es_image_hdr.hex" "\${dir}/es_image_hdr.bin" RESULT_VARIABLE rc)
if(NOT rc)
  execute_process(COMMAND "\${OBJCOPY}" --update-section ".es_header=\${dir}/es_image_hdr.bin" "\${ELF}" RESULT_VARIABLE rc)
endif()
if(rc)
  message(FATAL_ERROR "es-image: başlık ELF'e yazılamadı (\${rc})")
endif()
file(REMOVE "\${raw}" "\${dir}/es_image_hdr.hex" "\${dir}/es_image_hdr.bin")
math(EXPR crchex "\${crc}" OUTPUT_FORMAT HEXADECIMAL)
message(STATUS "es-image: \${size} bayt, CRC-32 \${crchex}")
`;
}

/** Bootloader linker betiği için parametreler */
const bootLinker = (part) => ({ origin: part.bootBase, length: part.bootSize, header: false, shared: true, ramOffset: 0 });
const appLinker = (part) => ({ origin: part.slotBase, length: part.slotSize, header: true, shared: true, ramOffset: part.appRamOffset });

/**
 * Üretilecek dosyalar.
 * @param {{ design: any, mcu: any, clock: any, P: any, boot: any, userBlock: (n: string, s?: string) => string }} o
 * @returns {{ path: string, content: string, kind?: string }[]}
 */
function bootFiles(o) {
  const { mcu, boot, P, userBlock } = o;
  const part = partition(mcu, boot);
  const files = [
    { path: 'bootloader/es_image.h', content: imageHeader() },
    { path: 'bootloader/es_boot_config.h', content: bootConfig(mcu, boot, part) },
    { path: 'bootloader/es_boot_core.h', content: coreHeader() },
    { path: 'bootloader/es_boot_core.c', content: coreSource() },
    { path: 'bootloader/es_ed25519.h', content: ed25519.header() },
    { path: 'bootloader/es_ed25519.c', content: ed25519.source() },
    { path: 'bootloader/es_boot_port.h', content: portHeader() },
    { path: 'bootloader/es_boot_port.c', content: portSource(mcu, boot, part) },
    { path: 'bootloader/main.c', content: bootMain(userBlock), kind: 'user' },
    { path: `${P.src}/es_image.c`, content: appHeaderSource() },
    { path: `${P.inc}/es_boot.h`, content: appApiHeader() },
    { path: `${P.src}/es_boot.c`, content: appApiSource(mcu, part) },
    { path: 'cmake/es-image.cmake', content: imageScript() }
  ];
  for (const [n, content] of Object.entries(regDriverFiles(mcu, ['gpio', 'uart', 'flash', 'iwdg'], o.clock))) files.push({ path: `bootloader/reg/${n}`, content });
  return files;
}

module.exports = {
  DEFAULT_BOOT, HDR, COMMIT_OFF, IMAGE_MAGIC, COMMIT_MAGIC, REQUEST_MAGIC, SIG_OFF, SIG_MAGIC, STATE_OFF, DONE_MAGIC, BOOT_VERSION,
  sizeOptions, defaultSize, uartOptions, normalizeBoot, versionWord, slotUnits, abSplit, keyId, partition, bootFiles, bootLinker, appLinker,
  imageHeader, coreHeader, coreSource, crcTableC
};
