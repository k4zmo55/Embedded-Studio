// Motor, saat ağacı, kod üretici ve birleştirme için hızlı doğrulama. Çalıştırma: node test/smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLibrary, validateComponent, componentTemplate } = require('../src/library');
const { assign } = require('../src/engine/pinAssigner');
const { computeClock, solveClock } = require('../src/engine/clock');
const { generate, GENERATOR_VERSION } = require('../src/codegen/generator');
const { writeProject, designFingerprint, mergeUserBlocks, relocateLayout } = require('../src/codegen/merge');
const { parseLine } = require('../src/monitor/telemetry');
const { simModel, SimTarget } = require('../src/debug/session');
const { builtinStm32f4 } = require('../src/debug/registers');

const lib = loadLibrary(path.join(__dirname, '..'));
const mcu = lib.mcus.stm32f411ceu6;
const inst = (componentId, n = 1) => ({ id: `${componentId}${n}`, componentId, label: `${componentId.toUpperCase()}_${n}` });
const design = (instances, extra = {}) => ({ mcuId: 'stm32f411ceu6', framework: 'hal', rtos: false, project: { name: 'smoke' }, instances, locks: {}, ...extra });
let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log('  ✓ ' + name); };

console.log('Pin atama');
test('aynı adresli iki BME280 → ikincisi 0x77, aynı bus', () => {
  const r = assign(design([inst('bme280', 1), inst('bme280', 2)]), lib);
  assert.strictEqual(r.addresses.bme2801, '0x76');
  assert.strictEqual(r.addresses.bme2802, '0x77');
  assert.deepStrictEqual(Object.keys(r.peripherals), ['I2C1']);
});
test('SCL kilidi PB10 → I2C2, SDA otomatik PB3', () => {
  const r = assign({ ...design([inst('bme280')]), locks: { 'bme2801.SCL': 'PB10' } }, lib);
  assert.strictEqual(r.peripherals.I2C2.pins.SDA, 'PB3');
});
test('rezerve pin (SWD) kilitlenemez', () => {
  const r = assign({ ...design([inst('led')]), locks: { 'led1.A': 'PA13' } }, lib);
  assert.notStrictEqual(r.connections[0].mcuPin, 'PA13');
});
test('tüm kütüphane: hiçbir pin iki sinyale atanmaz', () => {
  const r = assign(design(Object.keys(lib.components).map((c) => inst(c))), lib);
  const byPin = {};
  for (const c of r.connections) (byPin[c.mcuPin] = byPin[c.mcuPin] || new Set()).add(c.signal);
  for (const [pin, sigs] of Object.entries(byPin)) assert.strictEqual(sigs.size, 1, `${pin}: ${[...sigs]}`);
  assert.strictEqual(r.messages.filter((m) => m.level === 'error').length, 0);
});

console.log('Saat ağacı');
test('varsayılan: 25 MHz HSE → 100 MHz, APB1 50, 3 WS', () => {
  const c = computeClock(mcu, undefined);
  assert.strictEqual(c.freq.sysclk, 100);
  assert.strictEqual(c.freq.pclk1, 50);
  assert.strictEqual(c.freq.tim1, 100);
  assert.strictEqual(c.latency, 3);
  assert.ok(c.ok);
});
test('sınır dışı: APB1 /1 ile 100 MHz → hata', () => {
  const c = computeClock(mcu, { ...mcu.clock.default, apb1: 1 });
  assert.ok(!c.ok && c.issues.some((i) => i.field === 'apb1'));
});
test('çözücü: 84 MHz hedefi geçerli ve tam', () => {
  const cfg = solveClock(mcu, mcu.clock.default, 84);
  const c = computeClock(mcu, cfg);
  assert.strictEqual(c.freq.sysclk, 84);
  assert.ok(c.ok, JSON.stringify(c.issues));
});
test('çözücü: HSI kaynağıyla 100 MHz', () => {
  const cfg = solveClock(mcu, { ...mcu.clock.default, pllSource: 'HSI' }, 100);
  assert.ok(computeClock(mcu, cfg).ok);
});

console.log('Kod üretimi + birleştirme');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'es-smoke-'));
const gen = (d) => {
  const r = assign(d, lib);
  const g = generate(d, lib, r, computeClock(mcu, d.clock), {});
  return writeProject(root, g, { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: d.instances.map((i) => ({ ...i, name: i.componentId })), connections: r.connections, framework: d.framework, rtos: d.rtos } });
};
const d1 = design([inst('usb_uart'), inst('bme280'), inst('mpu6050')]);
test('ilk üretim: dosyalar ve sürücüler oluşur', () => {
  const rep = gen(d1);
  assert.ok(rep.added.includes('Core/Src/app.c'));
  assert.ok(fs.existsSync(path.join(root, 'Drivers/Components/bme280.c')));
  assert.ok(fs.existsSync(path.join(root, 'AGENTS.md')) && fs.existsSync(path.join(root, 'CLAUDE.md')));
});
test('değişiklik yoksa hiçbir dosyaya dokunulmaz', () => {
  const rep = gen(d1);
  assert.ok(rep.upToDate);
});
const app = path.join(root, 'Core/Src/app.c');
let text = fs.readFileSync(app, 'utf8');
text = text.replace('/* USER CODE BEGIN Globals */\n', '/* USER CODE BEGIN Globals */\nstatic int my_counter;\n');
text = text.replace('/* USER CODE BEGIN BME280_1 */\n', '/* USER CODE BEGIN BME280_1 */\n  if (temp_c > 30) my_counter++;\n');
text = text.replace('/* USER CODE BEGIN MPU6050_1 */\n', '/* USER CODE BEGIN MPU6050_1 */\n  my_counter += imu.ax > 1;\n');
text += '\n/* blok dışı: kaybolmalı */\n';
fs.writeFileSync(app, text);
const d2 = design([inst('usb_uart'), inst('bme280'), inst('neo6m')]);
const rep2 = gen(d2);
test('sensör değişince kullanıcı kodu korunur', () => {
  const t = fs.readFileSync(app, 'utf8');
  assert.ok(t.includes('static int my_counter;'));
  assert.ok(t.includes('if (temp_c > 30) my_counter++;'));
  assert.ok(!t.includes('blok dışı'));
});
test('çıkarılan sensörün kodu silinmez, Orphaned bloğa (#if 0) taşınır', () => {
  const t = fs.readFileSync(app, 'utf8');
  assert.ok(/USER CODE BEGIN Orphaned MPU6050_1[\s\S]*#if 0[\s\S]*imu\.ax > 1[\s\S]*#endif/.test(t));
  assert.deepStrictEqual(rep2.orphans, [{ file: 'Core/Src/app.c', blocks: ['MPU6050_1'] }]);
});
test('kullanılmayan sürücü silinir, yenisi eklenir', () => {
  assert.ok(rep2.removed.includes('Drivers/Components/mpu6050.c'));
  assert.ok(!fs.existsSync(path.join(root, 'Drivers/Components/mpu6050.c')));
  assert.ok(rep2.added.includes('Drivers/Components/nmea.c'));
});
test('değiştirilmiş üretilmiş dosya silinmez, removed/ altına taşınır', () => {
  fs.appendFileSync(path.join(root, 'Drivers/Components/nmea.c'), '\n/* kullanıcı yaması */\n');
  const rep = gen(design([inst('usb_uart'), inst('bme280')]));
  assert.ok(rep.preserved.includes('Drivers/Components/nmea.c'));
  assert.ok(fs.existsSync(path.join(root, '.embedded-studio/removed/Drivers/Components/nmea.c')));
});
test('LAST_CHANGES.md eklenen/çıkarılanı listeler', () => {
  const t = fs.readFileSync(path.join(root, '.embedded-studio/LAST_CHANGES.md'), 'utf8');
  assert.ok(/Çıkarıldı: \*\*NEO6M_1\*\*/.test(t));
});
test('ikinci kez orphan aynı kalır (iç içe #if 0 yok)', () => {
  gen(design([inst('usb_uart'), inst('bme280'), inst('led')]));
  const t = fs.readFileSync(app, 'utf8');
  assert.strictEqual((t.match(/#if 0/g) || []).length, 1);
});
test('mergeUserBlocks: CMake ve markdown blokları', () => {
  const r = mergeUserBlocks('a\n# USER CODE BEGIN X\n# USER CODE END X\n', 'z\n# USER CODE BEGIN X\nset(A 1)\n# USER CODE END X\n', 'CMakeLists.txt');
  assert.ok(r.content.includes('set(A 1)'));
});
test('bare-metal: sade klasör yapısı (inc/ src/ drivers/ linker/), HAL dosyası yok', () => {
  const d = design([inst('usb_uart'), inst('bme280'), inst('servo_sg90')], { framework: 'register', rtos: true });
  const r = assign(d, lib);
  const g = generate(d, lib, r, computeClock(mcu, d.clock), {});
  const files = g.files.map((f) => f.path);
  for (const f of ['inc/FreeRTOSConfig.h', 'inc/board.h', 'src/main.c', 'src/app.c', 'src/bsp.c', 'drivers/bme280.c', 'linker/STM32F411CEU6_FLASH.ld']) assert.ok(files.includes(f), f);
  assert.ok(!files.some((f) => f.startsWith('Core/') || f.startsWith('Drivers/') || /hal_conf/.test(f)), files.join(' '));
  const cmake = g.files.find((f) => f.path === 'cmake/embedded-studio.cmake').content;
  for (const s of ['${ES_ROOT}/src/*.c ${ES_ROOT}/drivers/*.c', 'startup/system_stm32f4xx.c', 'startup/startup_stm32f411xe.s', 'cmsis/core', 'cmsis/device', 'rtos/FreeRTOS/tasks.c', 'linker/STM32F411CEU6_FLASH.ld']) assert.ok(cmake.includes(s), s);
  assert.ok(!/Drivers|Middlewares|Core\//.test(cmake), 'CMake HAL yolları içermemeli');
});
test('HAL: CubeMX klasör yapısı korunur', () => {
  const d = design([inst('usb_uart'), inst('bme280')]);
  const files = generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}).files.map((f) => f.path);
  for (const f of ['Core/Inc/stm32f4xx_hal_conf.h', 'Core/Src/main.c', 'Drivers/Components/bme280.c', 'STM32F411CEU6_FLASH.ld']) assert.ok(files.includes(f), f);
});
test('altyapı değişince kullanıcı dosyaları ve USER CODE yeni klasöre taşınır', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-layout-'));
  const run = (d) => {
    const g = generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {});
    const moved = relocateLayout(dir, d.framework, g.files);
    writeProject(dir, g, { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
    return moved;
  };
  const hal = design([inst('usb_uart'), inst('bme280')]);
  assert.deepStrictEqual(run(hal), [], 'ilk üretimde taşıma yok');
  const app = path.join(dir, 'Core/Src/app.c');
  fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('/* USER CODE BEGIN Globals */\n', '/* USER CODE BEGIN Globals */\nstatic int benim_kodum;\n'));
  fs.writeFileSync(path.join(dir, 'Core/Src/kontrol.c'), 'int kontrol(void) { return 1; }\n');
  const moved = run({ ...hal, framework: 'register' });
  assert.ok(moved.some((m) => m.from === 'Core/Src/app.c' && m.to === 'src/app.c'), JSON.stringify(moved));
  assert.ok(moved.some((m) => m.to === 'src/kontrol.c'), 'kullanıcının kendi dosyası');
  assert.ok(fs.readFileSync(path.join(dir, 'src/app.c'), 'utf8').includes('static int benim_kodum;'), 'USER CODE korunmalı');
  assert.ok(!fs.existsSync(path.join(dir, 'Core/Src/bsp.c')) && !fs.existsSync(path.join(dir, 'Core/Inc/stm32f4xx_hal_conf.h')), 'eski üretilmiş dosyalar kaldırılmalı');
  assert.ok(!fs.existsSync(path.join(dir, 'Drivers/Components/bme280.c')) && fs.existsSync(path.join(dir, 'drivers/bme280.c')));
  // Geri dönüş: HAL
  run(hal);
  assert.ok(fs.readFileSync(path.join(dir, 'Core/Src/app.c'), 'utf8').includes('static int benim_kodum;'));
  assert.ok(fs.existsSync(path.join(dir, 'Core/Src/kontrol.c')));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('profesyonel bare-metal: app.c yok, main.c başlangıç, kesmeler bsp_irq.c, sürücüde kullanım örneği', () => {
  const d = design([inst('usb_uart'), inst('bme280'), inst('neo6m')], { framework: 'register', mode: 'pro' });
  const files = generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}).files;
  const kind = (p) => (files.find((f) => f.path === p) || {}).kind;
  assert.ok(!kind('src/app.c') && !kind('inc/app.h'), 'app.c/app.h üretilmemeli');
  assert.strictEqual(kind('src/main.c'), 'once');
  assert.strictEqual(kind('src/bsp_irq.c'), 'generated');
  const irq = files.find((f) => f.path === 'src/bsp_irq.c').content;
  assert.ok(/void SysTick_Handler/.test(irq) && /USART\d_IRQHandler/.test(irq));
  assert.ok(!/SysTick_Handler/.test(files.find((f) => f.path === 'src/stm32f4xx_it.c').content), 'SysTick iki yerde olmamalı');
  const h = files.find((f) => f.path === 'drivers/bme280.h').content;
  assert.ok(h.startsWith('// Kullanım örneği (bu projedeki BME280_1'), h.slice(0, 80));
  assert.ok(/bme280_init\(&bme280_1, BSP_I2C\d/.test(h), 'gerçek bus ile örnek');
  // HAL ve acemi bare-metal değişmedi
  const beg = generate({ ...d, mode: 'beginner' }, lib, assign(d, lib), computeClock(mcu, d.clock), {}).files.map((f) => f.path);
  assert.ok(beg.includes('src/app.c') && !beg.includes('src/bsp_irq.c'));
});
test('profesyonel: önizleme diske yazmaz; elle değiştirilen üretilmiş dosya korunur (.new); main.c\'ye dokunulmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-pro-'));
  const run = (d, extra = {}) => writeProject(dir, generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}),
    { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: [], connections: [] }, protect: true, ...extra });
  const d = design([inst('usb_uart'), inst('bme280')], { framework: 'register', mode: 'pro' });
  const dry = run(d, { dryRun: true });
  assert.ok(dry.added.includes('src/main.c') && dry.contents['src/main.c'], 'önizleme içerik verir');
  assert.ok(!fs.existsSync(path.join(dir, 'src')), 'önizleme diske yazmamalı');
  run(d);
  const main = path.join(dir, 'src/main.c'), bspC = path.join(dir, 'src/bsp.c');
  fs.writeFileSync(main, '/* benim main.c */\nint main(void) { for (;;) {} }\n');
  fs.appendFileSync(bspC, '\n/* elle yama */\n');
  const d2 = design([inst('usb_uart'), inst('bme280'), inst('mpu6050')], { framework: 'register', mode: 'pro' });
  const preview = run(d2, { dryRun: true });
  assert.ok(preview.conflicts.includes('src/bsp.c'), JSON.stringify(preview.conflicts));
  assert.ok(!fs.existsSync(bspC + '.new'), 'önizlemede .new yazılmamalı');
  const rep = run(d2);
  assert.deepStrictEqual(rep.conflicts, ['src/bsp.c']);
  assert.ok(fs.readFileSync(bspC, 'utf8').includes('/* elle yama */'), 'yama korunmalı');
  assert.ok(fs.existsSync(bspC + '.new'), 'yeni hali .new olarak');
  assert.strictEqual(fs.readFileSync(main, 'utf8'), '/* benim main.c */\nint main(void) { for (;;) {} }\n', 'main.c dokunulmamalı');
  assert.ok(fs.existsSync(path.join(dir, 'drivers/mpu6050.c')), 'yeni sürücü eklenmeli');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('acemi → profesyonel geçişi: app.c silinmez, eski kesme kodu çakışmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-mode-'));
  const run = (d) => writeProject(dir, generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}),
    { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: [], connections: [] }, protect: d.mode === 'pro' });
  const beg = design([inst('usb_uart'), inst('bme280')], { framework: 'register' });
  run(beg);
  const it = path.join(dir, 'src/stm32f4xx_it.c');
  fs.writeFileSync(it, fs.readFileSync(it, 'utf8').replace('/* USER CODE BEGIN Handlers */\n', '/* USER CODE BEGIN Handlers */\nvoid EXTI0_IRQHandler(void) {}\n'));
  run({ ...beg, mode: 'pro' });
  assert.ok(fs.existsSync(path.join(dir, 'src/app.c')), 'app.c kullanıcıda kalmalı');
  const itText = fs.readFileSync(it, 'utf8');
  assert.ok(!/^void SysTick_Handler/m.test(itText), 'SysTick artık bsp_irq.c\'de');
  assert.ok(itText.includes('void EXTI0_IRQHandler(void) {}'), 'kullanıcının kesmesi korunmalı');
  fs.rmSync(dir, { recursive: true, force: true });
});

console.log('Derleme yapılandırması (CMake)');
const cmakeOf = (d, p = 'cmake/embedded-studio.cmake') => generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}).files.find((f) => f.path === p);
test('varsayılan: ayarlar cmake/embedded-studio.cmake\'te, CMakeLists.txt ince ve USER CODE bloklu, CMakePresets.json', () => {
  const d = design([inst('usb_uart'), inst('bme280')], { rtos: true });
  const mod = cmakeOf(d).content;
  for (const s of ['function(embedded_studio_target target)', '-mfpu=fpv4-sp-d16 -mfloat-abi=hard', '$<$<CONFIG:Debug>:-Og>', '$<$<CONFIG:MinSizeRel>:-Os>',
    '--specs=nano.specs --specs=nosys.specs', 'ES_WARNINGS -Wall -Wextra', '"USE_HAL_DRIVER"', 'portable/GCC/ARM_CM4F/port.c', '.hex', '.bin', '-Wl,-Map=']) assert.ok(mod.includes(s), s);
  const lists = cmakeOf(d, 'CMakeLists.txt');
  assert.strictEqual(lists.kind, 'user');
  assert.ok(/include\(cmake\/embedded-studio\.cmake\)[\s\S]*USER CODE BEGIN Sources[\s\S]*embedded_studio_target\(\$\{PROJECT_NAME\}\)[\s\S]*USER CODE BEGIN Targets/.test(lists.content));
  assert.ok(!/-mcpu|--specs/.test(lists.content), 'bayraklar CMakeLists.txt\'de olmamalı');
  const presets = JSON.parse(cmakeOf(d, 'CMakePresets.json').content);
  assert.deepStrictEqual(presets.configurePresets.filter((p) => !p.hidden).map((p) => p.name), ['debug', 'release', 'minsizerel', 'relwithdebinfo']);
  assert.strictEqual(presets.configurePresets[0].binaryDir, '${sourceDir}/build/${presetName}');
  assert.ok(/build\/debug\/smoke\.elf/.test(cmakeOf(d, '.vscode/launch.json').content));
});
test('derleme ayarları: -O, -D, include, bayraklar, linker, specs, FPU, uyarı, araç zinciri yolu', () => {
  const d = design([inst('usb_uart')], { rtos: true, build: {
    type: 'Release', opt: { Release: '-O3' }, defines: ['APP_VER="1.2"', 'X=1'], includes: ['lib/inc', 'C:\\SDK\\inc'], cflags: '-fstack-usage', ldflags: '-Wl,--cref',
    linkerScript: 'custom.ld', specs: { nano: false, nosys: true }, fpu: 'soft', warnings: 'strict', werror: true, toolchain: { gccPath: 'C:\\Arm\\bin' } } });
  const mod = cmakeOf(d).content;
  for (const s of ['$<$<CONFIG:Release>:-O3>', '"APP_VER=\\"1.2\\""', '"X=1"', '${ES_ROOT}/lib/inc', 'C:/SDK/inc', '"-fstack-usage"', '"-Wl,--cref"',
    'set(ES_LINKER_SCRIPT "${ES_ROOT}/custom.ld")', '-mfloat-abi=soft', 'portable/GCC/ARM_CM3/port.c', '-Wshadow', '-Werror', 'CMAKE_BUILD_TYPE Release']) assert.ok(mod.includes(s), s);
  assert.ok(!/nano\.specs|-mfpu|ARM_CM4F/.test(mod), 'nano.specs, -mfpu ve ARM_CM4F olmamalı');
  assert.ok(cmakeOf(d, 'cmake/arm-none-eabi.cmake').content.includes('es_tool_dir(ES_GCC_DIR "C:/Arm/bin")'));
});
test('derleme ayarı değişince yeniden üretilir (parmak izi); bozuk ayarlar varsayılana döner', () => {
  const d = design([inst('usb_uart')]);
  assert.notStrictEqual(designFingerprint(d, GENERATOR_VERSION), designFingerprint({ ...d, build: { type: 'Release' } }, GENERATOR_VERSION));
  assert.strictEqual(designFingerprint(d, GENERATOR_VERSION), designFingerprint({ ...d, build: {} }, GENERATOR_VERSION), 'boş ayar = varsayılan');
  const { normalizeBuild } = require('../src/codegen/build');
  const b = normalizeBuild({ type: 'Hızlı', opt: { Debug: '-O9' }, fpu: 'x', warnings: 'max', cmake: 'kimse' });
  assert.deepStrictEqual([b.type, b.opt.Debug, b.fpu, b.warnings, b.cmake], ['Debug', '-Og', 'hard', 'normal', 'tool']);
});
test('"CMake\'i ben yönetiyorum": CMakeLists.txt\'ye hiç yazılmaz, embedded-studio.cmake yine güncellenir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-cmake-'));
  const run = (d) => writeProject(dir, generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}),
    { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
  const d = design([inst('usb_uart'), inst('bme280')], { framework: 'register' });
  run(d);
  const lists = path.join(dir, 'CMakeLists.txt');
  assert.ok(fs.readFileSync(lists, 'utf8').includes('USER CODE BEGIN Sources'));
  const mine = 'cmake_minimum_required(VERSION 3.20)\nproject(benim C ASM)\ninclude(cmake/embedded-studio.cmake)\nadd_executable(benim main.c)\nembedded_studio_target(benim)\n';
  fs.writeFileSync(lists, mine);
  const user = { ...d, build: { cmake: 'user', defines: ['YENI=1'] } };
  const rep = run(user);
  assert.strictEqual(fs.readFileSync(lists, 'utf8'), mine, 'kullanıcının CMakeLists.txt\'si aynen kalmalı');
  assert.ok(!rep.removed.includes('CMakeLists.txt') && !rep.preserved.includes('CMakeLists.txt'));
  assert.ok(fs.existsSync(path.join(dir, 'CMakePresets.json')), 'kullanıcıya devredilen CMakePresets.json silinmemeli');
  assert.ok(rep.updated.includes('cmake/embedded-studio.cmake') && fs.readFileSync(path.join(dir, 'cmake/embedded-studio.cmake'), 'utf8').includes('"YENI=1"'));
  // Kullanıcı CMakeLists.txt'yi silerse başlangıç dosyası bir kez oluşturulur, sonra yine dokunulmaz
  fs.unlinkSync(lists);
  run({ ...user, build: { ...user.build, defines: [] } });
  const starter = fs.readFileSync(lists, 'utf8');
  assert.ok(starter.includes('Bu CMakeLists.txt sizindir') && starter.includes('embedded_studio_target(${PROJECT_NAME})'));
  assert.ok(!/USER CODE/.test(starter));
  fs.rmSync(dir, { recursive: true, force: true });
});
test('0.4.x .vscode görevleri yeni build/debug klasörüne güncellenir; kullanıcı değiştirdiyse dokunulmaz', () => {
  const { upgradeLegacyVscode } = require('../src/codegen/merge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-vscode-'));
  fs.mkdirSync(path.join(dir, '.vscode'));
  const legacyCmd = 'cmake -S . -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake -DCMAKE_BUILD_TYPE=Debug && cmake --build build';
  fs.writeFileSync(path.join(dir, '.vscode/tasks.json'), JSON.stringify({ tasks: [{ command: legacyCmd }, { command: 'openocd -c "program build/app.elf verify reset exit"' }] }));
  fs.writeFileSync(path.join(dir, '.vscode/launch.json'), JSON.stringify({ configurations: [{ executable: 'out/benim.elf' }] }));
  assert.deepStrictEqual(upgradeLegacyVscode(dir, 'app'), ['.vscode/tasks.json']);
  const tasks = fs.readFileSync(path.join(dir, '.vscode/tasks.json'), 'utf8');
  assert.ok(tasks.includes('-B build/debug') && tasks.includes('program build/debug/app.elf') && !tasks.includes(legacyCmd), tasks);
  assert.deepStrictEqual(upgradeLegacyVscode(dir, 'app'), [], 'ikinci kez değişiklik yok');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('boyut özeti: arm-none-eabi-size çıktısı → flash = text+data, RAM = data+bss', () => {
  const { parseSize } = require('../src/toolchain');
  assert.deepStrictEqual(parseSize('   text\t   data\t    bss\t    dec\t    hex\tfilename\n  19876\t    232\t  16512\t  36620\t   8f0c\tbuild/debug/app.elf\n'),
    { text: 19876, data: 232, bss: 16512, flash: 20108, ram: 16744 });
  assert.strictEqual(parseSize('arm-none-eabi-size: x.elf: file format not recognized'), null);
});

console.log('Kütüphane, telemetri, debug');
test('tüm hazır komponentler doğrulamadan geçer', () => {
  for (const c of Object.values(lib.components)) assert.deepStrictEqual(validateComponent(c), [], c.id);
});
test('doğrulama: tekrar eden pin, eksik SCL, tanımsız monitör kanalı', () => {
  const c = componentTemplate();
  c.pins = [{ name: 'VCC', role: 'power' }, { name: 'VCC', role: 'ground' }, { name: 'SDA', role: 'i2c.SDA' }];
  c.monitor = [{ type: 'gauge', channels: ['yok'] }];
  const e = validateComponent(c).join(' | ');
  assert.ok(/tekrar ediyor: VCC/.test(e), e);
  assert.ok(/i2c\.SCL/.test(e), e);
  assert.ok(/tanımsız ölçüme bağlı: yok/.test(e), e);
});
test('şablon komponent geçerli; bozuk komponent reddedilir', () => {
  assert.deepStrictEqual(validateComponent(componentTemplate()), []);
  assert.ok(validateComponent({ id: 'X Y', interface: 'can', pins: [{ name: 'A', role: 'foo' }] }).length >= 3);
});
test('telemetri ayrıştırıcı', () => {
  assert.deepStrictEqual(parseLine('$V,BME280_1.temp,24.512'), { type: 'value', channel: 'BME280_1.temp', value: 24.512 });
  assert.strictEqual(parseLine('$T,Monitor,RUN,1,211,0.400').stackFree, 211);
});
test('debug simülasyonu: GPIOB MODER, I2C1 ve RCC beklenen değerler', async () => {
  const d = design([inst('usb_uart'), inst('bme280')]);
  const r = assign(d, lib);
  const model = simModel(d, lib, r, computeClock(mcu, d.clock), builtinStm32f4());
  const t = new SimTarget(model);
  return t.readMemory(0x40020400, 1).then(([moder]) => {
    // PB6, PB9 alternatif fonksiyon (10b)
    assert.strictEqual((moder >>> 12) & 3, 2);
    assert.strictEqual((moder >>> 18) & 3, 2);
  });
});

console.log('Arayüz dili');
test('koddaki her t() metninin İngilizcesi var, yer tutucular eşleşiyor, fazla anahtar yok', () => {
  const dict = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'i18n', 'en.json'), 'utf8'));
  const files = ['src', 'src/engine', 'src/ai', 'src/debug', 'src/monitor', 'media']
    .flatMap((d) => fs.readdirSync(path.join(__dirname, '..', d)).filter((f) => f.endsWith('.js')).map((f) => path.join(__dirname, '..', d, f)));
  const used = new Set();
  // t('...') : tek tırnaklı metin, \' kaçışı olabilir
  const re = /(?<![\w$.])t\('((?:[^'\\\n]|\\.)*)'/g;
  for (const f of files) {
    // Yorumlardaki örnek metinler sayılmasın
    const code = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    for (const m of code.matchAll(re)) used.add(m[1].replace(/\\(.)/g, (_, c) => ({ n: '\n' }[c] || c)));
  }
  const missing = [...used].filter((k) => !(k in dict) && !/^[^a-zçğıöşüA-ZÇĞİÖŞÜ]*$/.test(k));
  // Hazır komponentlerin görünen alanları da sözlükten çevrilir; dilden bağımsız olanlar ("Servo SG90") zorunlu değil
  for (const c of Object.values(lib.components)) {
    for (const k of ['name', 'description', 'category']) {
      if (!c[k]) continue;
      used.add(c[k]);
      if (/[çğıöşüÇĞİÖŞÜ]/.test(c[k]) && !(c[k] in dict)) missing.push(c[k]);
    }
  }
  const holes = (s) => (s.match(/\{\d+\}/g) || []).sort().join();
  const badHoles = Object.entries(dict).filter(([k, v]) => holes(k) !== holes(v)).map(([k]) => k);
  const unused = Object.keys(dict).filter((k) => !used.has(k));
  assert.deepStrictEqual(missing, [], 'sözlükte olmayan metinler');
  assert.deepStrictEqual(badHoles, [], 'yer tutucusu farklı çeviriler');
  assert.deepStrictEqual(unused, [], 'kullanılmayan sözlük anahtarları');
});
test('dil seçimi: ayar > VS Code dili; İngilizcede çeviri, bağlam eki ve yer tutucu', () => {
  const i18n = require('../src/i18n');
  assert.strictEqual(i18n.resolveLanguage('auto', 'tr'), 'tr');
  assert.strictEqual(i18n.resolveLanguage('auto', 'en-US'), 'en');
  assert.strictEqual(i18n.resolveLanguage('auto', 'de'), 'en');
  assert.strictEqual(i18n.resolveLanguage('tr', 'en'), 'tr');
  i18n.setLanguage('en');
  try {
    assert.strictEqual(i18n.t('{0} tasarımdan çıkarıldı. Geri almak için Ctrl+Z.', 'LED_1'), 'LED_1 removed from the design. Press Ctrl+Z to undo.');
    assert.strictEqual(i18n.t('Durdur@@debug'), 'Halt');
    assert.strictEqual(i18n.t('sözlükte olmayan'), 'sözlükte olmayan');
    assert.ok(validateComponent({}).every((e) => !/[çğıöşüÇĞİÖŞÜ]/.test(e)), 'doğrulama mesajları İngilizce');
  } finally {
    i18n.setLanguage('tr');
  }
  assert.strictEqual(i18n.t('Durdur@@debug'), 'Durdur');
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\nsmoke: ${passed} test geçti`);
