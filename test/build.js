// Entegrasyon testi: paketleri indirir, HAL ve register projelerini üretir, arm-none-eabi-gcc ile derler.
// Gerekenler: git, cmake, ninja, arm-none-eabi-gcc. Çalıştırma: node test/build.js [önbellek klasörü] [çıktı klasörü]
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { loadLibrary } = require('../src/library');
const { assign } = require('../src/engine/pinAssigner');
const { computeClock } = require('../src/engine/clock');
const { generate, GENERATOR_VERSION } = require('../src/codegen/generator');
const { writeProject, designFingerprint } = require('../src/codegen/merge');
const packs = require('../src/codegen/packs');

const os = require('os');
const cache = process.argv[2] || path.join(os.tmpdir(), 'es-packs');
const outRoot = process.argv[3] || path.join(os.tmpdir(), 'es-build');
const lib = loadLibrary(path.join(__dirname, '..'));
const ids = ['usb_uart', 'bme280', 'mpu6050', 'ssd1306', 'w25q32', 'neo6m', 'led', 'button', 'potentiometer', 'servo_sg90'];

(async () => {
  await packs.ensurePacks(cache, ['core', 'device', 'hal', 'freertos'], (m) => console.log('  ' + m));
  const variants = [['hal', true], ['hal', false], ['register', true], ['register', false]];
  let failed = 0;
  for (const [framework, rtos] of variants) {
    const name = `t_${framework}_${rtos ? 'rtos' : 'bare'}`;
    const root = path.join(outRoot, name);
    fs.rmSync(root, { recursive: true, force: true });
    const design = {
      mcuId: 'stm32f411ceu6', framework, rtos, project: { name },
      instances: ids.map((c, i) => ({ id: 'i' + i, componentId: c, label: `${c.toUpperCase()}_1` })), locks: {}
    };
    const mcu = lib.mcus[design.mcuId];
    const result = assign(design, lib);
    const clock = computeClock(mcu, design.clock);
    packs.installIntoProject(cache, root, mcu, packs.missingInProject(root, mcu, framework, rtos));
    const gen = generate(design, lib, result, clock, { halConfTemplate: packs.halConfTemplate(cache, root) });
    writeProject(root, gen, { fingerprint: designFingerprint(design, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
    try {
      execSync('cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Debug', { cwd: root, stdio: 'pipe' });
      const out = execSync('cmake --build build', { cwd: root, stdio: 'pipe' }).toString();
      const warn = out.split('\n').filter((l) => /warning:/.test(l) && /Core|Components/.test(l));
      const size = out.split('\n').filter((l) => /FLASH:|RAM:/.test(l)).map((l) => l.trim().replace(/\s+/g, ' ')).join(' | ');
      console.log(`OK   ${name}  ${size}${warn.length ? `\n     ${warn.length} uyarı:\n     ` + warn.slice(0, 8).join('\n     ') : ''}`);
    } catch (e) {
      failed++;
      const text = (e.stdout || '').toString() + (e.stderr || '').toString();
      console.log(`FAIL ${name}\n` + text.split('\n').filter((l) => /error|undefined|Error/.test(l)).slice(0, 25).join('\n'));
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
