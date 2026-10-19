// ES-303/304: bootloader çekirdeğinin (bootloader/es_boot_core.c + es_ed25519.c) bilgisayarda testi. Çekirdek gcc ile
// derlenir; flash bir dosyadır (silinmemiş bayta yazma reddedilir: ECC'li flash'taki gibi); eklentinin güncelleme
// istemcisi (esboot.js) stdin/stdout üzerinden konuşur. ES-304: Ed25519 imzaları Node.js ile üretilir, A/B kurulumu
// güç kesintisi benzetimiyle (ES_CUT) denenir. Gerekenler: PATH'te gcc (Windows'ta MinGW/WinLibs).
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

const HOST = `/* Bilgisayar portu: flash bir dosyada, UART stdin/stdout.
 * ES_CUT="e,w": e. silmeden sonra w yazma daha yapılıp güç kesilir (flash kaydedilir, çıkış kodu 4). */
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
#define FLASH_END (ES_BOOT_AB ? ES_STAGE_BASE + ES_STAGE_SIZE : ES_SLOT_BASE + ES_SLOT_SIZE)
static uint8_t flash[FLASH_END - FLASH_BASE];
static const char *file;
static const uint32_t units[][2] = { HOST_UNITS };
static int cut_erase = -1, cut_writes = -1, erases;

static void save(void) { FILE *f = fopen(file, "wb"); fwrite(flash, 1, sizeof flash, f); fclose(f); }
static void power_cut(void) { fflush(stdout); save(); exit(4); }

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
  if (++erases == cut_erase && cut_writes == 0) power_cut();
  return 0;
}
int es_port_flash_write(uint32_t addr, const uint8_t *data, uint32_t len)
{
  if ((addr | len) % ES_PROG_UNIT || addr < ES_SLOT_BASE || addr + len > FLASH_END) return -1;
  for (uint32_t i = 0; i < len; i++) if (flash[addr - FLASH_BASE + i] != 0xFFU) { fprintf(stderr, "silinmemis bayta yazma @%08X\\n", (unsigned)(addr + i)); return -1; }
  memcpy(&flash[addr - FLASH_BASE], data, len);
  if (erases >= cut_erase && cut_erase > 0 && --cut_writes == 0) power_cut();
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
  const char *cut = getenv("ES_CUT");
  if (cut) sscanf(cut, "%d,%d", &cut_erase, &cut_writes);
  memset(flash, 0xFF, sizeof flash);
  FILE *f = fopen(file, "rb");
  if (f) { size_t n = fread(flash, 1, sizeof flash, f); (void)n; fclose(f); }
  if (argc > 2 && argv[2][0] == 'v') { printf("%d", es_boot_validate(1)); return 0; }
  if (argc > 2 && argv[2][0] == 'i') {
    /* Açılış: A/B kurulumu */
    uint8_t d;
    int r = es_boot_install(&d);
    save();
    printf("%d %d %d", r, d, es_boot_validate(1));
    return 0;
  }
  es_boot_serve(0);
  return 0;
}
`;

function build(mcuId, opts = {}) {
  const mcu = lib.mcus[mcuId];
  const boot = bl.normalizeBoot({ enabled: true, ...opts }, mcu);
  const part = bl.partition(mcu, boot);
  const dir = path.join(work, mcuId + (opts.layout === 'ab' ? '-ab' : ''));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const files = bl.bootFiles({ mcu, boot, P: { src: 'src', inc: 'inc' }, clock: null, userBlock: (n) => `/* ${n} */` });
  for (const f of files.filter((x) => /bootloader\/es_(image|boot_config|boot_core|ed25519)\./.test(x.path))) fs.writeFileSync(path.join(dir, path.basename(f.path)), f.content);
  const units = part.units.map((u) => `{ 0x${u.addr.toString(16)}U, 0x${u.size.toString(16)}U }`).join(', ');
  fs.writeFileSync(path.join(dir, 'host.c'), HOST.replace('HOST_UNITS', units));
  const exe = path.join(dir, process.platform === 'win32' ? 'boot_host.exe' : 'boot_host');
  execFileSync('gcc', ['-std=c11', '-O1', '-Wall', '-Wextra', '-Werror', '-Wno-unused-parameter', '-o', exe, 'host.c', 'es_boot_core.c', 'es_ed25519.c'], { cwd: dir, stdio: 'pipe' });
  return { mcu, boot, part, dir, exe, flash: path.join(dir, 'flash.bin') };
}

/** Bootloader sürecini başlatır; istemci stdin/stdout'a bağlı */
function run(h, opts = {}) {
  const p = spawn(h.exe, [h.flash], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...(opts.cut ? { ES_CUT: opts.cut } : {}) } });
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
  p.stdin.on('error', () => {}); // güç kesintisi benzetiminde süreç erken çıkar
  const exit = new Promise((r) => p.on('exit', (code) => r(code)));
  // Süreç bitince (güç kesintisi) bekleyen yanıt hatayla biter
  p.on('close', () => client.q.fail(new Error('bootloader süreci bitti')));
  return { client, exit, kill: () => p.stdin.end(), stderr: () => err, proc: p };
}
const validate = (h) => Number(execFileSync(h.exe, [h.flash, 'v']).toString());
const install = (h) => execFileSync(h.exe, [h.flash, 'i']).toString().split(' ').map(Number);
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
/** Ana yuvadaki sürüm (flash dosyasından) */
const primaryVersion = (h) => eb.parseHeader(fs.readFileSync(h.flash).subarray(h.part.slotBase - 0x08000000, h.part.slotBase - 0x08000000 + 64)).version;

/** İstemcinin ön denetimleri olmadan ham güncelleme (cihazın kendi reddini görmek için) */
async function rawUpdate(client, img, { header = true } = {}) {
  await client.request(eb.CMD.START, header ? Buffer.concat([u32(img.length), img.subarray(0, 64)]) : u32(img.length), 30000);
  for (let off = 0; off < img.length; off += 1024) {
    const part = img.subarray(off, Math.min(img.length, off + 1024));
    await client.request(eb.CMD.DATA, Buffer.concat([u32(off), part]));
  }
  await client.request(eb.CMD.END, Buffer.alloc(0), 30000);
}

async function singleSlot(id, ok) {
  const h = build(id);
  const img = eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, size: 6000, version: '2.3.17', buildId: 'abc1234' });
  // 1) Boş cihaz: imaj yok
  let s = run(h);
  let info = await s.client.info();
  assert.strictEqual(info.app, 1);
  assert.strictEqual(info.protocol, 2);
  assert.strictEqual(info.slotBase, h.part.slotBase);
  assert.strictEqual(info.progUnit, h.part.progUnit);
  assert.strictEqual(info.deviceId, 0x431);
  assert.deepStrictEqual([info.ab, info.signed, info.rollback, info.imageMax], [false, false, true, h.part.slotSize - eb.REGION]);
  // 2) Güncelleme + BOOT (reset)
  const stages = new Set();
  const r = await s.client.update(img, { boot: true, progress: (st) => stages.add(st) });
  assert.strictEqual(r.header.version, '2.3.17');
  assert.ok(stages.has('erase') && stages.has('write') && stages.has('verify'));
  assert.strictEqual(await s.exit, 3, 'BOOT: reset');
  assert.strictEqual(s.stderr(), '', 'commit bloğu iki kez yazılmadı');
  assert.strictEqual(validate(h), 0, 'resetten sonra imaj geçerli');
  // 3) INFO başlığı ve sürüm tabanını gösteriyor
  s = run(h);
  info = await s.client.info();
  assert.deepStrictEqual([info.app, info.header.version, info.header.buildId, info.floorText], [0, '2.3.17', 'abc1234', '2.3.17']);
  // ES-304: daha düşük sürüm silinmeden (START'ta) reddedilir, uygulama yerinde kalır
  const old = eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, size: 2048, version: '2.3.16' });
  await assert.rejects(() => s.client.update(old), /Geri dönüş koruması/);
  await assert.rejects(() => rawUpdate(s.client, old), (e) => e.code === 7);
  assert.strictEqual((await s.client.info()).app, 0, 'reddedilen eski sürüm uygulamayı silmedi');
  // 4) Yarıda kalan güncelleme: commit yok → çalıştırılmaz
  await s.client.request(eb.CMD.START, u32(img.length), 30000);
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
  await s.client.request(eb.CMD.START, u32(img.length), 30000);
  const bad = Buffer.alloc(4 + 16);
  bad.writeUInt32LE(4096, 0);
  await assert.rejects(() => s.client.request(eb.CMD.DATA, bad), /geçersiz argüman/);
  const broken = Buffer.from(img);
  broken[eb.REGION + 100] ^= 0x01; // başlık CRC'si sağlam, imaj CRC'si bozuk
  let last;
  for (let off = 0; off < broken.length; off += 1024) {
    const part = broken.subarray(off, Math.min(broken.length, off + 1024));
    last = Buffer.concat([u32(off), part]);
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
  await assert.rejects(() => s.client.update(eb.buildImage({ slotBase: h.part.slotBase + 0x4000, version: '9.0.0' })), /başka bir yuva/);
  s.kill();
  await s.exit;
  ok(`${id}: yuva ${h.part.slotBase.toString(16)} (${h.part.slotSize / 1024} KB), yazma birimi ${h.part.progUnit} B — güncelleme, reset, eski sürüm, yarıda kalma, bozuk paket, bozuk imaj, yinelenen paket, yanlış yuva`);
}

async function abSigned(id, ok) {
  const key = eb.generateKey();
  const other = eb.generateKey();
  const h = build(id, { layout: 'ab', signing: true, pubKey: key.pub.toString('hex'), minVersion: '1.0.0' });
  assert.ok(h.part.ab, `${id}: A/B bölünebilmeli`);
  assert.ok(h.part.stageSize >= h.part.slotSize && h.part.stageBase === h.part.slotBase + h.part.slotSize);
  const img = (version, size = 5000, k = key) => eb.signImage(eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, size, version, buildId: 'v' + version }), k.pem).bytes;
  // 1) İmzalı güncelleme: hazırlık yuvasına yazılır, END'de doğrulanıp ana yuvaya kopyalanır
  let s = run(h);
  let info = await s.client.info();
  assert.deepStrictEqual([info.ab, info.signed, info.rollback, info.keyId, info.stageBase, info.floorText], [true, true, true, key.keyId, h.part.stageBase, '1.0.0']);
  const stages = new Set();
  await s.client.update(img('2.0.0'), { progress: (st) => stages.add(st) });
  assert.ok(stages.has('install'));
  info = await s.client.info();
  assert.deepStrictEqual([info.app, info.header.version, info.stage.status, info.stage.done, info.floorText], [0, '2.0.0', 0, true, '2.0.0']);
  // 2) İmzasız, başka anahtarla imzalı, bir baytı değiştirilmiş imaj: cihaz reddeder, ana yuvadaki uygulama yerinde
  await assert.rejects(() => s.client.update(eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, version: '2.1.0' })), /imzasız/);
  await assert.rejects(() => s.client.update(img('2.1.0', 5000, other)), /başka bir anahtarla/);
  await assert.rejects(() => rawUpdate(s.client, eb.buildImage({ slotBase: h.part.slotBase, sp: h.part.shared, version: '2.1.0' })), (e) => e.code === 6 && e.detail === 7);
  await assert.rejects(() => rawUpdate(s.client, img('2.1.0', 5000, other)), (e) => e.code === 6 && e.detail === 7);
  const tampered = img('2.1.0');
  tampered[eb.REGION + 300] ^= 0x10;
  // CRC'leri yeniden hesaplanmış (saldırganın yapabileceği): yalnızca imza yakalar
  tampered.writeUInt32LE(eb.crc32(tampered.subarray(eb.REGION)), 12);
  tampered.writeUInt32LE(eb.crc32(tampered.subarray(0, 60)), 60);
  await assert.rejects(() => rawUpdate(s.client, tampered), (e) => e.code === 6 && e.detail === 7);
  // 3) Geri dönüş: eski sürüm START'ta (başlıkla) ya da END'de (eski istemci) reddedilir
  await assert.rejects(() => rawUpdate(s.client, img('1.9.9')), (e) => e.code === 7);
  await assert.rejects(() => rawUpdate(s.client, img('1.9.9'), { header: false }), (e) => e.code === 6 && e.detail === 8);
  info = await s.client.info();
  assert.deepStrictEqual([info.app, info.header.version], [0, '2.0.0'], 'reddedilen imajlar ana yuvaya dokunmadı');
  s.kill();
  await s.exit;
  assert.strictEqual(s.stderr(), '');
  // Açılışta: reddedilmiş hazırlık imajı kurulmaz
  assert.deepStrictEqual(install(h), [0, 0, 0]);
  assert.strictEqual(primaryVersion(h), '2.0.0');
  // 4) Kurulum sırasında güç kesintisi (ana yuva silindi, birkaç birim yazıldı): açılışta kurulum baştan tamamlanır
  s = run(h, { cut: '2,3' });
  await assert.rejects(() => s.client.update(img('2.1.0', 9000)));
  assert.strictEqual(await s.exit, 4, 'güç kesildi');
  assert.notStrictEqual(validate(h), 0, 'ana yuva yarım');
  assert.deepStrictEqual(install(h), [1, 0, 0], 'açılışta kuruldu');
  assert.strictEqual(primaryVersion(h), '2.1.0');
  assert.deepStrictEqual(install(h), [0, 0, 0], 'ikinci açılışta yapılacak iş yok');
  // 5) Silme anında kesinti (ana yuva tamamen boş)
  s = run(h, { cut: '2,0' });
  await assert.rejects(() => s.client.update(img('2.2.0')));
  assert.strictEqual(await s.exit, 4);
  assert.strictEqual(validate(h), 1);
  assert.deepStrictEqual(install(h), [1, 0, 0]);
  assert.strictEqual(primaryVersion(h), '2.2.0');
  // 6) Ana yuva bozulursa hazırlık yuvasındaki son imajdan kurtarılır
  const f = fs.readFileSync(h.flash);
  f[h.part.vectors - 0x08000000 + 64] ^= 0xff;
  fs.writeFileSync(h.flash, f);
  assert.strictEqual(validate(h), 5);
  assert.deepStrictEqual(install(h), [1, 0, 0], 'yedekten kurtarıldı');
  // 7) Hazırlık yuvasına güncelleme yazılırken kesinti: ana yuva sağlam, yarım imaj kurulmaz
  s = run(h);
  await s.client.request(eb.CMD.START, Buffer.concat([u32(img('2.3.0').length), img('2.3.0').subarray(0, 64)]), 30000);
  await s.client.request(eb.CMD.DATA, Buffer.concat([u32(0), img('2.3.0').subarray(0, 1024)]));
  s.kill();
  await s.exit;
  assert.deepStrictEqual(install(h), [0, 0, 0]);
  assert.strictEqual(primaryVersion(h), '2.2.0');
  // 8) BOOT: yeni imaj kurulup reset
  s = run(h);
  await s.client.update(img('3.0.0', Math.min(30000, h.part.imageMax - 4096)), { boot: true });
  assert.strictEqual(await s.exit, 3);
  assert.strictEqual(primaryVersion(h), '3.0.0');
  assert.strictEqual(s.stderr(), '', 'işaret blokları iki kez yazılmadı');
  ok(`${id}: A/B ana ${h.part.slotSize / 1024} KB + hazırlık ${h.part.stageSize / 1024} KB, Ed25519 ${key.keyId} — imzalı güncelleme, imzasız / yabancı anahtar / değiştirilmiş imaj, geri dönüş, kurulumda ve silmede güç kesintisi, yedekten kurtarma, yarım hazırlık`);
}

let passed = 0;
const ok = (name) => { passed++; console.log('  ✓ ' + name); };

(async () => {
  try {
    execFileSync('gcc', ['--version'], { stdio: 'pipe' });
  } catch {
    console.log('gcc bulunamadı; test atlandı.');
    return;
  }
  // JS benzetimi de aynı kuralları uygular
  {
    const key = eb.generateKey();
    const o = { slotBase: 0x08004000, slotSize: 0x3c000, stageBase: 0x08040000, stageSize: 0x40000, pubKey: key.pub, rollback: true };
    const { client, dev } = eb.simEsBoot(o);
    const img = (v, k = key) => eb.signImage(eb.buildImage({ slotBase: o.slotBase, version: v }), k.pem).bytes;
    await client.update(img('1.2.0'));
    assert.strictEqual(dev.validate(true), 0);
    await assert.rejects(() => rawUpdate(client, img('1.1.0')), (e) => e.code === 7);
    await assert.rejects(() => rawUpdate(client, img('1.3.0', eb.generateKey())), (e) => e.code === 6 && e.detail === 7);
    assert.ok(eb.verifySig(img('1.0.0'), key.pub) && !eb.verifySig(img('1.0.0'), eb.generateKey().pub));
    assert.strictEqual((await client.info()).header.version, '1.2.0');
    ok('benzetim (SimEsBoot): A/B, imza, geri dönüş');
  }
  for (const id of ['stm32f411ceu6', 'stm32h743zit6', 'stm32l476rgt6', 'stm32f103c8t6']) await singleSlot(id, ok);
  for (const id of ['stm32f411ceu6', 'stm32h743zit6', 'stm32l476rgt6', 'stm32f030c8t6']) await abSigned(id, ok);
  console.log(`\nboot-core: ${passed} test geçti`);
})().catch((e) => { console.error(e); process.exit(1); });
