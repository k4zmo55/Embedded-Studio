// ES-303: bootloader çekirdeğinin (bootloader/es_boot_core.c) bilgisayarda testi. Çekirdek gcc ile derlenir; flash bir
// dosyadır (silinmemiş bayta yazma reddedilir: ECC'li flash'taki gibi); eklentinin güncelleme istemcisi (esboot.js)
// stdin/stdout üzerinden konuşur. Gerekenler: PATH'te gcc (Windows'ta MinGW/WinLibs).
// Çalıştırma: node test/boot-core.js [çalışma klasörü]
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { loadLibrary } = require('../src/library');
const bl = require('../src/codegen/bootloader');
const eb = require('../src/debug/esboot');

const work = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'es-boot-core'));
const lib = loadLibrary(path.join(__dirname, '..'));

const HOST = `/* Bilgisayar portu: flash bir dosyada, UART stdin/stdout */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#include <io.h>
#include <fcntl.h>
#endif
#include "es_boot_config.h"
#include "es_boot_core.h"

#define FLASH_BASE 0x08000000U
static uint8_t flash[ES_SLOT_BASE - FLASH_BASE + ES_SLOT_SIZE];
static const char *file;
static const uint32_t units[][2] = { HOST_UNITS };

static void save(void) { FILE *f = fopen(file, "wb"); fwrite(flash, 1, sizeof flash, f); fclose(f); }

void es_port_putc(uint8_t c) { putchar(c); }
int es_port_getc(uint32_t timeout_ms)
{
  (void)timeout_ms;
  fflush(stdout);
  int c = getchar();
  if (c == EOF) { save(); exit(0); }
  return c;
}
uint32_t es_port_ms(void) { return (uint32_t)(clock() * 1000 / CLOCKS_PER_SEC); }
int es_port_flash_erase(uint32_t addr, uint32_t len)
{
  for (size_t i = 0; i < sizeof units / sizeof units[0]; i++) {
    if (units[i][0] + units[i][1] <= addr || units[i][0] >= addr + len) continue;
    memset(&flash[units[i][0] - FLASH_BASE], 0xFF, units[i][1]);
  }
  return 0;
}
int es_port_flash_write(uint32_t addr, const uint8_t *data, uint32_t len)
{
  if ((addr | len) % ES_PROG_UNIT || addr < ES_SLOT_BASE || addr + len > ES_SLOT_BASE + ES_SLOT_SIZE) return -1;
  for (uint32_t i = 0; i < len; i++) if (flash[addr - FLASH_BASE + i] != 0xFFU) { fprintf(stderr, "silinmemis bayta yazma @%08X\\n", (unsigned)(addr + i)); return -1; }
  memcpy(&flash[addr - FLASH_BASE], data, len);
  return 0;
}
const uint8_t *es_port_flash_ptr(uint32_t addr) { return &flash[addr - FLASH_BASE]; }
uint32_t es_port_image_crc(const uint8_t *p, uint32_t n) { return es_crc32(0, p, n); }
uint32_t es_port_device_id(void) { return 0x431; }
void es_port_wdg_refresh(void) {}
void es_port_reset(void) { fflush(stdout); save(); exit(3); }

int main(int argc, char **argv)
{
#ifdef _WIN32
  _setmode(_fileno(stdin), _O_BINARY);
  _setmode(_fileno(stdout), _O_BINARY);
#endif
  file = argv[1];
  memset(flash, 0xFF, sizeof flash);
  FILE *f = fopen(file, "rb");
  if (f) { size_t n = fread(flash, 1, sizeof flash, f); (void)n; fclose(f); }
  if (argc > 2) { printf("%d", es_boot_validate(1)); return 0; }
  es_boot_serve(0);
  return 0;
}
`;

function build(mcuId) {
  const mcu = lib.mcus[mcuId];
  const boot = bl.normalizeBoot({ enabled: true }, mcu);
  const part = bl.partition(mcu, boot);
  const dir = path.join(work, mcuId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = bl.bootFiles({ mcu, boot, P: { src: 'src', inc: 'inc' }, clock: null, userBlock: (n) => `/* ${n} */` });
  for (const f of files.filter((x) => /bootloader\/es_(image|boot_config|boot_core)\./.test(x.path))) fs.writeFileSync(path.join(dir, path.basename(f.path)), f.content);
  // Bilgisayarda: yuvayı kapsayan birimler (çok sayfalıysa ilk 64'ü yeter)
  const units = part.units.slice(0, 64).map((u) => `{ 0x${u.addr.toString(16)}U, 0x${u.size.toString(16)}U }`).join(', ');
  fs.writeFileSync(path.join(dir, 'host.c'), HOST.replace('HOST_UNITS', units));
  const exe = path.join(dir, process.platform === 'win32' ? 'boot_host.exe' : 'boot_host');
  execFileSync('gcc', ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-o', exe, 'host.c', 'es_boot_core.c'], { cwd: dir, stdio: 'pipe' });
  return { mcu, part, dir, exe, flash: path.join(dir, 'flash.bin') };
}

/** Bootloader sürecini başlatır; istemci stdin/stdout'a bağlı */
function run(h, opts = {}) {
  const p = spawn(h.exe, [h.flash], { stdio: ['pipe', 'pipe', 'pipe'] });
  let err = '';
  p.stderr.on('data', (d) => (err += d));
  let corrupt = opts.corruptFirst || 0;
  const client = new eb.EsBootClient({
    write: (b) => {
      // İlk n paketi bozarak gönder: bootloader NACK(FRAME) döner, istemci yeniden dener
      if (corrupt > 0) { corrupt--; const c = Buffer.from(b); c[c.length - 1] ^= 0xff; p.stdin.write(c); } else p.stdin.write(b);
    }
  }, { timeoutMs: 3000 });
  p.stdout.on('data', (d) => client.feed(d));
  const exit = new Promise((r) => p.on('exit', (code) => r(code)));
  return { client, exit, kill: () => p.stdin.end(), stderr: () => err, proc: p };
}
const validate = (h) => Number(execFileSync(h.exe, [h.flash, 'v']).toString());

(async () => {
  try {
    execFileSync('gcc', ['--version'], { stdio: 'pipe' });
  } catch {
    console.log('gcc bulunamadı; test atlandı.');
    return;
  }
  let passed = 0;
  const ok = (name) => { passed++; console.log('  ✓ ' + name); };
  for (const id of ['stm32f411ceu6', 'stm32h743zit6', 'stm32l476rgt6', 'stm32f103c8t6']) {
    const h = build(id);
    const img = eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, size: 6000, version: '2.3.17', buildId: 'abc1234' });
    // 1) Boş cihaz: imaj yok
    let s = run(h);
    let info = await s.client.info();
    assert.strictEqual(info.app, 1);
    assert.strictEqual(info.slotBase, h.part.slotBase);
    assert.strictEqual(info.progUnit, h.part.progUnit);
    assert.strictEqual(info.deviceId, 0x431);
    // 2) Güncelleme + BOOT (reset)
    const stages = new Set();
    const r = await s.client.update(img, { boot: true, progress: (st) => stages.add(st) });
    assert.strictEqual(r.header.version, '2.3.17');
    assert.ok(stages.has('erase') && stages.has('write') && stages.has('verify'));
    assert.strictEqual(await s.exit, 3, 'BOOT: reset');
    assert.strictEqual(s.stderr(), '', 'commit bloğu iki kez yazılmadı');
    assert.strictEqual(validate(h), 0, 'resetten sonra imaj geçerli');
    // 3) INFO başlığı gösteriyor
    s = run(h);
    info = await s.client.info();
    assert.deepStrictEqual([info.app, info.header.version, info.header.buildId], [0, '2.3.17', 'abc1234']);
    // 4) Yarıda kalan güncelleme: commit yok → çalıştırılmaz
    await s.client.request(eb.CMD.START, Buffer.from(Uint32Array.of(img.length).buffer), 30000);
    const first = Buffer.alloc(4 + 1024);
    img.copy(first, 4, 0, 1024);
    await s.client.request(eb.CMD.DATA, first);
    s.kill();
    await s.exit;
    assert.strictEqual(validate(h), 4, 'yarıda kalan güncelleme: commit yok');
    // 5) Bozuk paketler yeniden denenir; sıra dışı DATA reddedilir; gövdesi bozuk imaj END'de NACK
    s = run(h, { corruptFirst: 2 });
    info = await s.client.info();
    assert.strictEqual(info.app, 4);
    await s.client.request(eb.CMD.START, Buffer.from(Uint32Array.of(img.length).buffer), 30000);
    const bad = Buffer.alloc(4 + 16);
    bad.writeUInt32LE(4096, 0);
    await assert.rejects(() => s.client.request(eb.CMD.DATA, bad), /geçersiz argüman/);
    const broken = Buffer.from(img);
    broken[eb.REGION + 100] ^= 0x01; // başlık CRC'si sağlam, imaj CRC'si bozuk
    let last;
    for (let off = 0; off < broken.length; off += 1024) {
      const part = broken.subarray(off, Math.min(broken.length, off + 1024));
      last = Buffer.alloc(4 + part.length);
      last.writeUInt32LE(off, 0);
      part.copy(last, 4);
      await s.client.request(eb.CMD.DATA, last);
    }
    await assert.rejects(() => s.client.request(eb.CMD.END), (e) => e.code === 6 && e.detail === 5);
    // Aynı DATA paketi yeniden gelirse (ACK kaybı) yazmadan onaylanır
    await s.client.request(eb.CMD.DATA, last);
    s.kill();
    await s.exit;
    assert.strictEqual(validate(h), 4, 'doğrulanmayan imaj commit almaz');
    // 6) Yeniden tam güncelleme, BOOT'suz
    s = run(h);
    await s.client.update(eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, size: 20000, version: '3.0.0' }));
    s.kill();
    await s.exit;
    assert.strictEqual(validate(h), 0);
    // 7) Başka yuva için derlenmiş imaj gönderilmeden reddedilir
    s = run(h);
    await assert.rejects(() => s.client.update(eb.buildImage({ slotBase: h.part.slotBase + 0x4000 })), /başka bir yuva/);
    s.kill();
    await s.exit;
    ok(`${id}: yuva ${h.part.slotBase.toString(16)} (${h.part.slotSize / 1024} KB), yazma birimi ${h.part.progUnit} B — güncelleme, reset, yarıda kalma, bozuk paket, bozuk imaj, yinelenen paket, yanlış yuva`);
  }
  console.log(`\nboot-core: ${passed} test geçti`);
})().catch((e) => { console.error(e); process.exit(1); });
