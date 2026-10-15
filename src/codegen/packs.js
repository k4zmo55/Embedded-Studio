// @ts-check
/**
 * Üçüncü parti yazılım paketleri: STM32 HAL, CMSIS ve FreeRTOS.
 *
 * Paketler bir kez eklentinin global depolama alanına (git, sadece gereken klasörler) indirilir,
 * sonra her projeye ihtiyaç kadarı kopyalanır. Böylece proje kendi başına derlenebilir kalır.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const REPOS = {
  hal: { url: 'https://github.com/STMicroelectronics/stm32f4xx-hal-driver.git', sparse: ['Inc', 'Src'] },
  device: { url: 'https://github.com/STMicroelectronics/cmsis-device-f4.git', sparse: ['Include', 'Source/Templates'] },
  core: { url: 'https://github.com/STMicroelectronics/cmsis-core.git', sparse: ['CMSIS/Core/Include'] },
  freertos: { url: 'https://github.com/FreeRTOS/FreeRTOS-Kernel.git', sparse: ['include', 'portable/GCC/ARM_CM4F', 'portable/MemMang'] }
};

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
    if (has(cache, key)) continue;
    const dir = path.join(cache, key);
    fs.rmSync(dir, { recursive: true, force: true });
    log(`${key} indiriliyor...`);
    await git(['clone', '--depth', '1', '--filter=blob:none', '--sparse', REPOS[key].url, dir]);
    await git(['sparse-checkout', 'set', ...REPOS[key].sparse], dir);
    fs.writeFileSync(path.join(dir, '.es-ok'), new Date().toISOString());
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

/** Projede eksik olan paket parçalarının listesi. */
function missingInProject(root, mcu, framework, rtos) {
  const need = [];
  if (!fs.existsSync(path.join(root, 'Drivers/CMSIS/Include/core_cm4.h'))) need.push('core');
  if (!fs.existsSync(path.join(root, 'Drivers/CMSIS/Device/ST/STM32F4xx/Source/Templates/gcc', mcu.device.startup))) need.push('device');
  if (framework === 'hal' && !fs.existsSync(path.join(root, 'Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal.h'))) need.push('hal');
  if (rtos && !fs.existsSync(path.join(root, 'Middlewares/FreeRTOS/tasks.c'))) need.push('freertos');
  return need;
}

/** Önbellekteki paketlerden projeye gerekenleri kopyalar. */
function installIntoProject(cache, root, mcu, keys) {
  const h = (p) => p.endsWith('.h');
  for (const key of keys) {
    const src = path.join(cache, key);
    if (key === 'core') copyDir(path.join(src, 'CMSIS/Core/Include'), path.join(root, 'Drivers/CMSIS/Include'), h);
    if (key === 'device') {
      const dst = path.join(root, 'Drivers/CMSIS/Device/ST/STM32F4xx');
      copyDir(path.join(src, 'Include'), path.join(dst, 'Include'), h);
      copyFile(path.join(src, 'Source/Templates/system_stm32f4xx.c'), path.join(dst, 'Source/Templates/system_stm32f4xx.c'));
      copyFile(path.join(src, 'Source/Templates/gcc', mcu.device.startup), path.join(dst, 'Source/Templates/gcc', mcu.device.startup));
    }
    if (key === 'hal') {
      copyDir(path.join(src, 'Inc'), path.join(root, 'Drivers/STM32F4xx_HAL_Driver/Inc'));
      copyDir(path.join(src, 'Src'), path.join(root, 'Drivers/STM32F4xx_HAL_Driver/Src'), (n) => !n.includes('template'));
    }
    if (key === 'freertos') {
      const dst = path.join(root, 'Middlewares/FreeRTOS');
      copyDir(path.join(src, 'include'), path.join(dst, 'include'), h);
      for (const f of ['tasks.c', 'queue.c', 'list.c', 'timers.c', 'event_groups.c', 'stream_buffer.c', 'LICENSE.md']) {
        if (fs.existsSync(path.join(src, f))) copyFile(path.join(src, f), path.join(dst, f));
      }
      copyDir(path.join(src, 'portable/GCC/ARM_CM4F'), path.join(dst, 'portable/GCC/ARM_CM4F'));
      copyFile(path.join(src, 'portable/MemMang/heap_4.c'), path.join(dst, 'portable/MemMang/heap_4.c'));
    }
  }
}

/** HAL yapılandırma şablonu (projede ya da önbellekte). */
function halConfTemplate(cache, root) {
  for (const p of [path.join(root, 'Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal_conf_template.h'), path.join(cache, 'hal/Inc/stm32f4xx_hal_conf_template.h')]) {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  }
  return undefined;
}

module.exports = { ensurePacks, installIntoProject, missingInProject, halConfTemplate, REPOS };
