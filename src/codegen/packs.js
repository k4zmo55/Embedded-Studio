// @ts-check
/**
 * Üçüncü parti yazılım paketleri: STM32 HAL, CMSIS ve FreeRTOS.
 *
 * Paketler bir kez eklentinin global depolama alanına (git, sadece gereken klasörler) indirilir,
 * sonra her projeye ihtiyaç kadarı kopyalanır. Böylece proje kendi başına derlenebilir kalır.
 *
 * Paket anahtarları: 'core' (CMSIS çekirdek), 'freertos', 'device' / 'device-<aile>' (CMSIS cihaz), 'hal' / 'hal-<aile>'.
 * F4 eski sürümlerle aynı önbellek klasörlerini kullanır ('device', 'hal'), böylece yeniden indirilmez.
 */
const fs = require('fs');
const path = require('path');
const { layout } = require('./layout');
const { family, familyOf } = require('./families');
const { execFile } = require('child_process');

/** FreeRTOS portları (bkz. build.js rtosPort) */
const RTOS_PORTS = ['ARM_CM0', 'ARM_CM3', 'ARM_CM4F', 'ARM_CM33_NTZ'];
const FIXED = {
  core: { url: 'https://github.com/STMicroelectronics/cmsis-core.git', sparse: ['CMSIS/Core/Include'] },
  freertos: { url: 'https://github.com/FreeRTOS/FreeRTOS-Kernel.git', sparse: ['include', ...RTOS_PORTS.map((p) => `portable/GCC/${p}`), 'portable/MemMang'] }
};

const deviceKey = (fam) => (fam === 'f4' ? 'device' : `device-${fam}`);
const halKey = (fam) => (fam === 'f4' ? 'hal' : `hal-${fam}`);
/** 'device-g0' → { kind: 'device', fam: 'g0' } */
const parseKey = (key) => {
  const [kind, fam] = key.split('-');
  return { kind, fam: fam || 'f4' };
};

/** Paket anahtarından depo adresi ve indirilecek klasörler. */
function repoOf(key) {
  if (FIXED[key]) return FIXED[key];
  const { kind, fam } = parseKey(key);
  const f = family(fam);
  if (kind === 'device') return { url: f.cmsisRepo, sparse: ['Include', 'Source/Templates'] };
  if (kind === 'hal') return { url: f.halRepo, sparse: ['Inc', 'Src'] };
  throw new Error(`Bilinmeyen paket: ${key}`);
}

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.longpaths=true', ...args], { cwd, windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`git ${args[0]}: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

const has = (cache, key) => fs.existsSync(path.join(cache, key, '.es-ok'));

/** Eksik paketleri indirir. log: ilerleme mesajları için. */
async function ensurePacks(cache, needs, log = () => {}) {
  fs.mkdirSync(cache, { recursive: true });
  for (const key of needs) {
    const dir = path.join(cache, key);
    const repo = repoOf(key);
    const sparse = repo.sparse.join(',');
    if (has(cache, key)) {
      // Eski sürümün indirdiği paket daha az klasör içeriyorsa (ör. yeni FreeRTOS portları) sadece klasör listesini genişlet
      if (fs.readFileSync(path.join(dir, '.es-ok'), 'utf8').split('\n')[1] === sparse) continue;
      log(`${key} güncelleniyor...`);
      await git(['sparse-checkout', 'set', ...repo.sparse], dir);
      fs.writeFileSync(path.join(dir, '.es-ok'), `${new Date().toISOString()}\n${sparse}`);
      continue;
    }
    fs.rmSync(dir, { recursive: true, force: true });
    log(`${key} indiriliyor...`);
    await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', repo.url, dir]);
    await git(['sparse-checkout', 'set', ...repo.sparse], dir);
    fs.writeFileSync(path.join(dir, '.es-ok'), `${new Date().toISOString()}\n${sparse}`);
  }
}

function copyDir(src, dst, filter = () => true) {
  if (!fs.existsSync(src)) throw new Error(`Paket klasörü bulunamadı: ${src}`);
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d, filter);
    else if (filter(e.name)) fs.copyFileSync(s, d);
  }
}

function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

/**
 * Projede eksik olan paket parçalarının listesi.
 * @param {string} rtosPort derlenecek FreeRTOS portu (ARM_CM4F, ARM_CM0, ARM_CM33_NTZ/non_secure …)
 */
function missingInProject(root, mcu, framework, rtos, rtosPort = 'ARM_CM4F') {
  const fam = familyOf(mcu);
  const L = layout(framework, fam.key);
  const need = [];
  if (!fs.existsSync(path.join(root, L.cmsisCore, 'core_cm4.h'))) need.push('core');
  if (!fs.existsSync(path.join(root, L.startupDir, mcu.device.startup)) || !fs.existsSync(path.join(root, L.systemC))
    || !fs.existsSync(path.join(root, L.deviceInc, `${mcu.device.define.toLowerCase()}.h`))) need.push(deviceKey(fam.key));
  if (framework === 'hal' && !fs.existsSync(path.join(root, L.hal, 'Inc', fam.halHeader))) need.push(halKey(fam.key));
  if (rtos && (!fs.existsSync(path.join(root, L.rtos, 'tasks.c')) || !fs.existsSync(path.join(root, L.rtos, 'portable/GCC', rtosPort, 'port.c')))) need.push('freertos');
  return need;
}

/** Önbellekteki paketlerden projeye gerekenleri, altyapının klasör yapısına göre kopyalar (bkz. layout.js). */
function installIntoProject(cache, root, mcu, keys, framework = 'hal') {
  const fam = familyOf(mcu);
  const L = layout(framework, fam.key);
  const h = (p) => p.endsWith('.h');
  for (const key of keys) {
    const src = path.join(cache, key);
    const { kind } = parseKey(key);
    if (key === 'core') copyDir(path.join(src, 'CMSIS/Core/Include'), path.join(root, L.cmsisCore), h);
    else if (kind === 'device') {
      copyDir(path.join(src, 'Include'), path.join(root, L.deviceInc), h);
      copyFile(path.join(src, 'Source/Templates', fam.systemC), path.join(root, L.systemC));
      copyFile(path.join(src, 'Source/Templates/gcc', mcu.device.startup), path.join(root, L.startupDir, mcu.device.startup));
    } else if (kind === 'hal') {
      const H = layout('hal', fam.key).hal;
      copyDir(path.join(src, 'Inc'), path.join(root, H, 'Inc'));
      copyDir(path.join(src, 'Src'), path.join(root, H, 'Src'), (n) => !n.includes('template'));
    } else if (key === 'freertos') {
      const dst = path.join(root, L.rtos);
      copyDir(path.join(src, 'include'), path.join(dst, 'include'), h);
      for (const f of ['tasks.c', 'queue.c', 'list.c', 'timers.c', 'event_groups.c', 'stream_buffer.c', 'LICENSE.md']) {
        if (fs.existsSync(path.join(src, f))) copyFile(path.join(src, f), path.join(dst, f));
      }
      for (const port of RTOS_PORTS) {
        if (fs.existsSync(path.join(src, 'portable/GCC', port))) copyDir(path.join(src, 'portable/GCC', port), path.join(dst, 'portable/GCC', port));
      }
      copyFile(path.join(src, 'portable/MemMang/heap_4.c'), path.join(dst, 'portable/MemMang/heap_4.c'));
    }
  }
}

/** HAL yapılandırma şablonu (projede ya da önbellekte). */
function halConfTemplate(cache, root, mcu) {
  const fam = familyOf(mcu);
  const H = layout('hal', fam.key).hal;
  for (const p of [path.join(root, H, 'Inc', fam.halConfTemplate), path.join(cache, halKey(fam.key), 'Inc', fam.halConfTemplate)]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return undefined;
}

/** Bir MCU için gereken tüm paket anahtarları (testler ve önceden indirme için). */
const packsFor = (mcu, framework, rtos) => ['core', deviceKey(familyOf(mcu).key), ...(framework === 'hal' ? [halKey(familyOf(mcu).key)] : []), ...(rtos ? ['freertos'] : [])];

module.exports = { ensurePacks, installIntoProject, missingInProject, halConfTemplate, repoOf, packsFor, parseKey, RTOS_PORTS };
