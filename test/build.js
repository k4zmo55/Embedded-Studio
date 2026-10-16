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
const cm = require('../src/codegen/build');

const os = require('os');
const cache = process.argv[2] || path.join(os.tmpdir(), 'es-packs');
const outRoot = process.argv[3] || path.join(os.tmpdir(), 'es-build');
const lib = loadLibrary(path.join(__dirname, '..'));
const ids = ['usb_uart', 'bme280', 'mpu6050', 'ssd1306', 'w25q32', 'neo6m', 'led', 'button', 'potentiometer', 'servo_sg90'];

(async () => {
  await packs.ensurePacks(cache, ['core', 'device', 'hal', 'freertos'], (m) => console.log('  ' + m));
  // [altyapı, RTOS, mod, derleme ayarları, ad eki]: Profesyonel bare-metal'de main.c/app.c kullanıcının (araç sadece başlangıç main.c'si yazar)
  const strict = { warnings: 'strict', werror: true };
  const variants = [
    ['hal', true], ['hal', false], ['register', true], ['register', false], ['register', true, 'pro'], ['register', false, 'pro'],
    // ES-105: derleme tipleri, sıkı uyarı + -Werror (üretilen kod uyarısız olmalı), FPU seçenekleri
    ['hal', true, 'beginner', { ...strict, type: 'Release' }, 'release_strict'],
    ['register', true, 'beginner', { ...strict, type: 'MinSizeRel' }, 'minsize_strict'],
    ['register', true, 'pro', { fpu: 'soft', type: 'Release', ...strict }, 'softfloat'],
    ['hal', false, 'beginner', { fpu: 'softfp', type: 'RelWithDebInfo', defines: ['APP_VER="1.2"'], cflags: '-fstack-usage', ldflags: '-Wl,--cref', specs: { nano: false, nosys: true } }, 'flags'],
    // "CMake'i ben yönetiyorum": kullanıcının kendi CMakeLists.txt'si, kaynakları kendisi veriyor (NO_SOURCES)
    ['register', false, 'pro', { cmake: 'user' }, 'usercmake']
  ];
  const userCmake = (name) => `cmake_minimum_required(VERSION 3.20)
set(CMAKE_TOOLCHAIN_FILE \${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake CACHE FILEPATH "")
project(${name} C ASM)
include(cmake/embedded-studio.cmake)
add_executable(\${PROJECT_NAME} \${ES_SOURCES} extra/version.c)
target_compile_definitions(\${PROJECT_NAME} PRIVATE BENIM_PROJEM=1)
embedded_studio_target(\${PROJECT_NAME} NO_SOURCES)
`;
  let failed = 0;
  for (const [framework, rtos, mode = 'beginner', build = {}, suffix] of variants) {
    const name = `t_${framework}_${rtos ? 'rtos' : 'bare'}${mode === 'pro' ? '_pro' : ''}${suffix ? '_' + suffix : ''}`;
    const root = path.join(outRoot, name);
    fs.rmSync(root, { recursive: true, force: true });
    const design = {
      mcuId: 'stm32f411ceu6', framework, rtos, mode, project: { name }, build,
      instances: ids.map((c, i) => ({ id: 'i' + i, componentId: c, label: `${c.toUpperCase()}_1` })), locks: {}
    };
    const mcu = lib.mcus[design.mcuId];
    const result = assign(design, lib);
    const clock = computeClock(mcu, design.clock);
    packs.installIntoProject(cache, root, mcu, packs.missingInProject(root, mcu, framework, rtos, cm.rtosPort(build)), framework);
    if (build.cmake === 'user') {
      fs.mkdirSync(path.join(root, 'extra'), { recursive: true });
      fs.writeFileSync(path.join(root, 'extra/version.c'), '#ifndef BENIM_PROJEM\n#error "kullanıcı tanımı yok"\n#endif\nconst char *app_version(void) { return "1.0"; }\n');
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), userCmake(name));
    }
    const gen = generate(design, lib, result, clock, { halConfTemplate: packs.halConfTemplate(cache, root) });
    writeProject(root, gen, { fingerprint: designFingerprint(design, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
    const preset = cm.presetName(cm.normalizeBuild(build).type);
    try {
      if (build.cmake === 'user' && fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8') !== userCmake(name)) throw new Error('kullanıcının CMakeLists.txt dosyası değişti');
      execSync(`cmake --preset ${preset}`, { cwd: root, stdio: 'pipe' });
      const out = execSync(`cmake --build --preset ${preset}`, { cwd: root, stdio: 'pipe' }).toString();
      const missing = ['.elf', '.hex', '.bin', '.map'].filter((x) => !fs.existsSync(path.join(root, 'build', preset, name + x)));
      if (missing.length) throw new Error(`build/${preset}/ altında eksik çıktı: ${missing.join(', ')}`);
      const warn = out.split('\n').filter((l) => /warning:/.test(l) && /Core|Components|src|drivers/.test(l));
      const size = out.split('\n').filter((l) => /FLASH:|RAM:/.test(l)).map((l) => l.trim().replace(/\s+/g, ' ')).join(' | ');
      console.log(`OK   ${name} [${preset}]  ${size}${warn.length ? `\n     ${warn.length} uyarı:\n     ` + warn.slice(0, 8).join('\n     ') : ''}`);
    } catch (e) {
      failed++;
      const text = (e.stdout || '').toString() + (e.stderr || '').toString() || e.message;
      console.log(`FAIL ${name}\n` + text.split('\n').filter((l) => /error|undefined|Error/.test(l)).slice(0, 25).join('\n'));
    }
  }
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
