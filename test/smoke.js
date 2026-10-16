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

console.log('İşlemci aileleri (ES-106)');
const { familyOf } = require('../src/codegen/families');
const mcuIds = Object.keys(lib.mcus);
test('15 işlemci tanımlı; her pin fonksiyonunun çevre birimi var, saat açma biti ve UART kesmesi tanımlı', () => {
  assert.strictEqual(mcuIds.length, 15);
  for (const id of mcuIds) {
    const m = lib.mcus[id];
    familyOf(m); // bilinmeyen aile hata verir
    for (const k of ['define', 'startup', 'openocdTarget', 'family']) assert.ok(m.device[k], `${id}: device.${k}`);
    for (const p of m.pins) {
      assert.ok(/^P[A-K]\d+$/.test(p.name), `${id}: pin adı ${p.name}`);
      for (const f of p.functions) assert.ok(m.peripherals[f.signal.split('_')[0]], `${id}: ${p.name} ${f.signal} çevre birimi yok`);
    }
    assert.ok(m.pins.find((p) => p.name === 'PA13').reserved && m.pins.find((p) => p.name === 'PA14').reserved, `${id}: SWD pinleri rezerve`);
    if (id === 'stm32f411ceu6') continue; // elle girilmiş ilk tanım
    for (const [n, p] of Object.entries(m.peripherals)) {
      assert.ok(/^RCC_\w+EN$/.test(p.enrBit), `${id}: ${n} enrBit`);
      if (p.type === 'uart') assert.ok(p.irq, `${id}: ${n} irq`);
    }
    assert.ok(m.device.gpioEnr && m.device.gpioEnr.bit.includes('{P}'), `${id}: gpioEnr`);
  }
});
test('her işlemcide varsayılan ve en yüksek saat ayarı geçerli', () => {
  for (const id of mcuIds) {
    const m = lib.mcus[id];
    const d = computeClock(m, undefined);
    assert.ok(d.ok, `${id} varsayılan: ${JSON.stringify(d.issues)}`);
    const top = computeClock(m, solveClock(m, m.clock.default, m.clock.limits.sysclk));
    assert.ok(top.ok && top.freq.sysclk === m.clock.limits.sysclk, `${id} en yüksek: ${top.freq.sysclk} ${JSON.stringify(top.issues)}`);
  }
  // Yüksek frekans modları
  const at = (id, mhz) => computeClock(lib.mcus[id], solveClock(lib.mcus[id], lib.mcus[id].clock.default, mhz));
  assert.ok(at('stm32f429zit6', 180).overdrive && !at('stm32f429zit6', 168).overdrive, 'F429 over-drive > 168 MHz');
  assert.ok(at('stm32f767zit6', 216).overdrive, 'F767 over-drive');
  assert.ok(at('stm32g474ret6', 170).boost && !at('stm32g474ret6', 150).boost, 'G474 boost > 150 MHz');
  assert.ok(at('stm32u575zit6q', 160).epod, 'U575 EPOD');
  const h7 = computeClock(lib.mcus.stm32h743zit6, undefined);
  assert.strictEqual(h7.freq.pllq, 200, 'H743 SPI1-3 çekirdek saati');
  const f1 = computeClock(lib.mcus.stm32f103c8t6, undefined);
  assert.deepStrictEqual([f1.freq.sysclk, f1.freq.pclk1, f1.latency], [72, 36, 2], 'Blue Pill 8 MHz × 9');
});
test('her işlemcide pin atama: sensör seti çakışmasız yerleşir', () => {
  const ids = ['usb_uart', 'bme280', 'mpu6050', 'w25q32', 'neo6m', 'led', 'button', 'potentiometer', 'servo_sg90'];
  for (const id of mcuIds) {
    const d = { ...design(ids.map((c) => inst(c))), mcuId: id };
    const r = assign(d, lib);
    assert.deepStrictEqual(r.messages.filter((m) => m.level === 'error').map((m) => m.text), [], id);
    const pins = r.connections.map((c) => c.mcuPin);
    assert.strictEqual(new Set(pins).size, new Set(r.connections.map((c) => `${c.mcuPin}:${c.signal}`)).size, `${id}: bir pine iki sinyal`);
  }
});
test('üretilen proje aileye uyar: kesme dosyası, HAL conf, -mcpu/FPU, FreeRTOS portu', () => {
  const gen = (id, extra = {}) => {
    const d = { ...design([inst('usb_uart'), inst('bme280')], { rtos: true, ...extra }), mcuId: id };
    return generate(d, lib, assign(d, lib), computeClock(lib.mcus[id], d.clock), {}).files;
  };
  const file = (files, p) => (files.find((f) => f.path === p) || {}).content || '';
  const g0 = gen('stm32g071rbt6');
  assert.ok(file(g0, 'Core/Src/stm32g0xx_it.c') && file(g0, 'Core/Inc/stm32g0xx_hal_conf.h'), 'G0 dosya adları');
  const g0cmake = file(g0, 'cmake/embedded-studio.cmake');
  assert.ok(/-mcpu=cortex-m0plus -mthumb -mfloat-abi=soft/.test(g0cmake), 'M0+ yazılım float');
  assert.ok(g0cmake.includes('ARM_CM0/portasm.c') && g0cmake.includes('SysTick_Handler=xPortSysTickHandler'), 'CM0 portu: portasm.c ve SysTick yeniden adlandırma');
  assert.ok(g0cmake.includes('Drivers/STM32G0xx_HAL_Driver/Src/stm32g0xx_hal*.c') && g0cmake.includes('startup_stm32g071xx.s'));
  const u5 = gen('stm32u575zit6q', { framework: 'register' });
  assert.ok(/-mcpu=cortex-m33 -mthumb -mfpu=fpv5-sp-d16 -mfloat-abi=hard/.test(file(u5, 'cmake/embedded-studio.cmake')));
  assert.ok(file(u5, 'cmake/embedded-studio.cmake').includes('ARM_CM33_NTZ/non_secure/port.c'));
  assert.ok(/configENABLE_FPU\s+1/.test(file(u5, 'inc/FreeRTOSConfig.h')) && /configENABLE_TRUSTZONE\s+0/.test(file(u5, 'inc/FreeRTOSConfig.h')));
  assert.ok(file(u5, 'src/board.c').includes('PWR_VOSR_BOOSTEN'), 'U5 160 MHz: EPOD');
  const f7 = gen('stm32f767zit6', { framework: 'register' });
  assert.ok(/-mcpu=cortex-m7 .*-mfpu=fpv5-d16/.test(file(f7, 'cmake/embedded-studio.cmake')));
  const f1 = gen('stm32f103c8t6', { framework: 'register' });
  assert.ok(file(f1, 'src/board.c').includes('AFIO_MAPR_SWJ_CFG_JTAGDISABLE') && file(f1, 'src/board.c').includes('->CRL'), 'F1: CRL/CRH ve JTAG kapalı');
  assert.ok(/-mcpu=cortex-m3 .*-mfloat-abi=soft/.test(file(f1, 'cmake/embedded-studio.cmake')) && file(f1, 'cmake/embedded-studio.cmake').includes('ARM_CM3/port.c'));
  const f1hal = gen('stm32f103c8t6');
  assert.ok(!file(f1hal, 'Core/Src/board.c').includes('g.Alternate'), 'F1 HAL GPIO yapısında Alternate yok');
  // G0 USART3/4 tek kesmeyi paylaşır
  const d = { ...design([inst('usb_uart', 1), inst('usb_uart', 2), inst('neo6m', 1)], { framework: 'register' }), mcuId: 'stm32g071rbt6', locks: { 'usb_uart1.TXD': 'PB10', 'usb_uart2.TXD': 'PA0' } };
  const files = generate(d, lib, assign(d, lib), computeClock(lib.mcus.stm32g071rbt6, d.clock), {}).files;
  const it = file(files, 'src/stm32g0xx_it.c');
  assert.strictEqual((it.match(/USART3_4_LPUART1_IRQHandler/g) || []).length, 1, it);
});
test('işlemci ailesi değişince kesme dosyası yeni adına taşınır, USER CODE korunur', () => {
  const { relocateFamilyFiles } = require('../src/codegen/merge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-family-'));
  const run = (id) => {
    const d = { ...design([inst('usb_uart'), inst('led')]), mcuId: id };
    const g = generate(d, lib, assign(d, lib), computeClock(lib.mcus[id], d.clock), {});
    const moved = relocateFamilyFiles(dir, g.files);
    writeProject(dir, g, { fingerprint: designFingerprint(d, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
    return moved;
  };
  run('stm32f411ceu6');
  const f4 = path.join(dir, 'Core/Src/stm32f4xx_it.c');
  fs.writeFileSync(f4, fs.readFileSync(f4, 'utf8').replace('/* USER CODE BEGIN Handlers */\n', '/* USER CODE BEGIN Handlers */\nvoid EXTI0_IRQHandler(void) { benim(); }\n'));
  assert.deepStrictEqual(run('stm32g474ret6'), [{ from: 'Core/Src/stm32f4xx_it.c', to: 'Core/Src/stm32g4xx_it.c' }]);
  assert.ok(!fs.existsSync(f4));
  assert.ok(fs.readFileSync(path.join(dir, 'Core/Src/stm32g4xx_it.c'), 'utf8').includes('void EXTI0_IRQHandler(void) { benim(); }'));
  assert.ok(fs.existsSync(path.join(dir, 'Core/Inc/stm32g4xx_hal_conf.h')) && !fs.existsSync(path.join(dir, 'Core/Inc/stm32f4xx_hal_conf.h')), 'HAL conf yeni aileye göre');
  fs.rmSync(dir, { recursive: true, force: true });
});
test('I2C TIMINGR: ST referans değerleri (8 MHz, 100/400 kHz)', () => {
  const { i2cTiming } = require('../src/codegen/regcode');
  assert.strictEqual(i2cTiming(8, 400000), '0x00310309'); // RM/AN4235 örneği ile aynı
  assert.strictEqual(i2cTiming(8, 100000), '0x10420F12');
});
test('paketler aileye göre: F4 eski önbellek klasörü, diğerleri device-/hal-<aile>', () => {
  const packs = require('../src/codegen/packs');
  assert.deepStrictEqual(packs.packsFor(lib.mcus.stm32f411ceu6, 'hal', true), ['core', 'device', 'hal', 'freertos']);
  assert.deepStrictEqual(packs.packsFor(lib.mcus.stm32h743zit6, 'register', false), ['core', 'device-h7']);
  assert.ok(packs.repoOf('hal-g0').url.endsWith('stm32g0xx-hal-driver.git') && packs.repoOf('device-u5').url.endsWith('cmsis-device-u5.git'));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-packs-'));
  assert.deepStrictEqual(packs.missingInProject(dir, lib.mcus.stm32g071rbt6, 'hal', true, 'ARM_CM0'), ['core', 'device-g0', 'hal-g0', 'freertos']);
  fs.rmSync(dir, { recursive: true, force: true });
});
test('çevre birimi saatleri: H7 SPI1-3 PLL1Q, F0 I2C HSI, tek APB', () => {
  const { periphClockTable } = require('../src/engine/periphclock');
  const row = (id, comps, name) => {
    const d = { ...design(comps.map((c) => inst(c))), mcuId: id };
    return periphClockTable(lib.mcus[id], assign(d, lib), computeClock(lib.mcus[id], undefined)).find((r) => r.name.startsWith(name));
  };
  const spi = row('stm32h743zit6', ['w25q32'], 'SPI');
  assert.ok(['SPI1', 'SPI2', 'SPI3'].includes(spi.name) ? spi.source === 'PLL1Q' && spi.mhz === 200 : spi.source.startsWith('APB'), JSON.stringify(spi));
  const i2c = row('stm32f030c8t6', ['bme280'], 'I2C');
  assert.deepStrictEqual([i2c.source, i2c.mhz], ['HSI', 8]);
});

console.log('Örnek register sürücüleri (ES-107)');
const rd = require('../src/codegen/regdrivers');
const regFiles = (id, ids, extra = {}) => {
  const d = { ...design([inst('usb_uart')], { framework: 'register', regDrivers: ids, ...extra }), mcuId: id };
  return generate(d, lib, assign(d, lib), computeClock(lib.mcus[id], d.clock), {}).files.filter((f) => f.path.startsWith('drivers/reg/'));
};
test('bağımlılıklar çözülür; işlemcide olmayan sürücü (DAC) atlanır', () => {
  assert.deepStrictEqual(rd.resolveDrivers(lib.mcus.stm32f411ceu6, ['uart', 'dac']), ['uart', 'dma'], 'F411: DAC yok, UART DMA ister');
  assert.deepStrictEqual(rd.resolveDrivers(lib.mcus.stm32g474ret6, ['exti', 'dac']), ['gpio', 'exti', 'dac']);
  assert.strictEqual(rd.resolveDrivers(lib.mcus.stm32h743zit6, rd.DRIVERS.map((d) => d.id)).length, 14);
});
test('sadece bare-metal\'de, bir kez (once) üretilir; her dosya kaynak RM ve kullanım örneği taşır, iç içe yorum yok', () => {
  assert.strictEqual(regFiles('stm32f411ceu6', ['gpio'], { framework: 'hal' }).length, 0, 'HAL projesinde üretilmez');
  for (const id of mcuIds) {
    const files = regFiles(id, rd.DRIVERS.map((d) => d.id));
    assert.ok(files.length >= 26, `${id}: ${files.length}`);
    for (const f of files) {
      assert.strictEqual(f.kind, 'once', f.path);
      assert.ok(f.content.includes(`Kaynak: ${lib.mcus[id].referenceManual.match(/rm\d+/i)[0].toUpperCase()}`), `${id} ${f.path}: RM`);
      const head = f.content.slice(0, f.content.indexOf('*/') + 2);
      assert.ok(!/\/\*[\s\S]*\/\*/.test(head), `${id} ${f.path}: iç içe yorum`);
      assert.ok(!/bsp_|Error_Handler|HAL_/.test(f.content), `${id} ${f.path}: BSP/HAL bağımlılığı`);
    }
  }
});
test('aile farkları: F1 CRL/AFIO, G0 EXTICR ve paylaşılan kesme, H7 DMAMUX + AXI tamponu, U5 GPDMA ve NSCR', () => {
  const get = (id, file) => (regFiles(id, rd.DRIVERS.map((d) => d.id)).find((f) => f.path.endsWith(file)) || {}).content || '';
  assert.ok(get('stm32f103c8t6', 'es_gpio.c').includes('&port->CRL') && get('stm32f103c8t6', 'es_exti.c').includes('AFIO->EXTICR'));
  assert.ok(get('stm32g071rbt6', 'es_exti.c').includes('EXTI->EXTICR') && get('stm32g071rbt6', 'es_exti.c').includes('EXTI4_15_IRQn'));
  assert.ok(get('stm32f411ceu6', 'es_exti.c').includes('SYSCFG->EXTICR') && get('stm32f411ceu6', 'es_exti.c').includes('EXTI15_10_IRQn'));
  assert.ok(get('stm32h743zit6', 'es_dma.c').includes('ES_DMA_USART1_TX = { DMA1, DMA1_Stream1, 1, DMAMUX1_Channel1, 42 }'));
  assert.ok(get('stm32h743zit6', 'es_dma.h').includes('section(".dma_buffer")'));
  const d = { ...design([inst('usb_uart')], { framework: 'register' }), mcuId: 'stm32h743zit6' };
  const ld = generate(d, lib, assign(d, lib), computeClock(lib.mcus.stm32h743zit6, d.clock), {}).files.find((f) => f.path.endsWith('_FLASH.ld')).content;
  assert.ok(ld.includes('RAM_D1') && ld.includes('.dma_buffer'), 'H7 linker: AXI SRAM bölümü');
  assert.ok(get('stm32f411ceu6', 'es_dma.c').includes('ES_DMA_USART1_TX = { DMA2, DMA2_Stream7, 7, 4 }'), 'F4: DMA2 stream 7 kanal 4');
  assert.ok(get('stm32f103c8t6', 'es_dma.c').includes('ES_DMA_USART1_TX = { DMA1, DMA1_Channel4, 4 }'), 'F1: DMA1 kanal 4');
  assert.ok(get('stm32l476rgt6', 'es_dma.c').includes('ES_DMA_USART2_TX = { DMA1, DMA1_Channel7, 7, DMA1_CSELR, 2 }'), 'L4: CSELR');
  assert.ok(get('stm32u575zit6q', 'es_dma.c').includes('GPDMA1_Channel1, 25') && get('stm32u575zit6q', 'es_flash.c').includes('FLASH->NSCR'));
  assert.ok(get('stm32g071rbt6', 'es_dma.c').includes('DMAMUX1_Channel1, 51'), 'G0: USART1_TX = 0x33');
});
test('arayüzdeki sürücü listesi ve bağımlılıklar üreticiyle aynı', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'media', 'settings.js'), 'utf8');
  const ui = [...src.slice(src.indexOf('const REG_DRIVERS')).matchAll(/^\s*\['(\w+)',/gm)].map((m) => m[1]);
  assert.deepStrictEqual(ui, rd.DRIVERS.map((d) => d.id));
  const req = eval(`(${src.match(/const REG_REQUIRES = (\{[^}]*\})/)[1]})`);
  assert.deepStrictEqual(req, Object.fromEntries(rd.DRIVERS.filter((d) => d.requires).map((d) => [d.id, d.requires])));
});
test('flash düzeni: F429 çift banka SNB, F767 sektörleri, G474/L476 BKER, U5 8 KB sayfa', () => {
  const get = (id) => (regFiles(id, ['flash']).find((f) => f.path.endsWith('es_flash.c')) || {}).content;
  const f429 = get('stm32f429zit6');
  assert.ok(f429.includes('{ 0x100000U, 16384U, 16, 2 }') && f429.includes('{ 0xE0000U, 131072U, 11, 1 }'), 'F429: banka 2 SNB 16');
  assert.ok(get('stm32f767zit6').includes('{ 0x40000U, 262144U, 5, 1 }'), 'F767: sektör 5 = 256 KB');
  assert.ok(get('stm32g474ret6').includes('FLASH_CR_BKER') && get('stm32l476rgt6').includes('ES_FLASH_PAGES_PER_BANK 256U'));
  assert.ok(get('stm32u575zit6q').includes('ES_FLASH_PAGE_SIZE 8192U'));
  assert.ok(regFiles('stm32h743zit6', ['flash'])[0].content.includes('ES_FLASH_ALIGN 32U'), 'H7: 256 bit flash kelimesi');
});

console.log('Durum çubuğu ve proje eylemleri (ES-201)');
test('prob çıktısı: ST-Link sürümü, hedef voltajı, çekirdek; hata açıklaması', () => {
  const { parseProbe, openocdCmd } = require('../src/debug/probe');
  const ok = parseProbe(`Info : clock speed 2000 kHz
Info : STLINK V2J37S7 (API v2) VID:PID 0483:3748
Info : Target voltage: 3.245270
Info : [stm32f4x.cpu] Cortex-M4 r0p1 processor detected
Info : [stm32f4x.cpu] target has 6 breakpoints, 4 watchpoints`);
  assert.deepStrictEqual([ok.ok, ok.probe, ok.firmware, ok.voltage, ok.core], [true, 'ST-Link V2', 'V2J37S7', '3.245270', 'Cortex-M4']);
  const none = parseProbe('Error: open failed\nin procedure \'init\'');
  assert.ok(!none.ok && /Prob bulunamadı/.test(none.error), none.error);
  const noTarget = parseProbe('Info : STLINK V3J7M2 (API v3)\nInfo : Target voltage: 0.003\nError: init mode failed (unable to connect to the target)');
  assert.ok(!noTarget.ok && noTarget.error && noTarget.voltage === '0.003');
  assert.strictEqual(openocdCmd(lib.mcus.stm32g474ret6, ['program build/debug/a.elf verify exit']), 'openocd -f interface/stlink.cfg -f target/stm32g4x.cfg -c "program build/debug/a.elf verify exit"');
});
test('komutlar, kısayollar ve komut paleti package.json\'da; çeviriler var', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  const ids = ['build', 'flash', 'debug', 'run', 'terminal', 'probe'].map((x) => `embeddedStudio.${x}`);
  for (const id of ids) assert.ok(pkg.contributes.commands.some((c) => c.command === id), id);
  const keys = Object.fromEntries(pkg.contributes.keybindings.map((k) => [k.command, k.key]));
  assert.deepStrictEqual([keys['embeddedStudio.build'], keys['embeddedStudio.flash'], keys['embeddedStudio.debug'], keys['embeddedStudio.run']], ['f7', 'shift+f7', 'f5', 'ctrl+f5']);
  assert.ok(pkg.contributes.keybindings.every((k) => /embeddedStudio\.projectOpen/.test(k.when) && /!inDebugMode/.test(k.when)), 'kısayollar sadece projede ve debug dışında');
  for (const f of ['package.nls.json', 'package.nls.tr.json']) {
    const nls = JSON.parse(fs.readFileSync(path.join(__dirname, '..', f), 'utf8'));
    const used = JSON.stringify(pkg.contributes).match(/%[\w.]+%/g).map((x) => x.slice(1, -1));
    assert.deepStrictEqual(used.filter((k) => !(k in nls)), [], f);
  }
});

console.log('Prob ve kart algılama (ES-202)');
const usb = require('../src/debug/usb');
const sid = require('../src/debug/stm32id');
test('USB sınıflandırma: ST-Link V2-1 + sanal seri port, J-Link, DFU, CH340; bileşik arayüzler ayrı sayılmaz', () => {
  const win = [
    'USB\\VID_0483&PID_374B\\066DFF485671664867074721', 'USB\\VID_0483&PID_374B&MI_00\\6&1A2B3C&0&0000', 'USB\\VID_0483&PID_374B&MI_02\\6&1A2B3C&0&0002',
    'USB\\VID_1366&PID_0105\\000260115436', 'USB\\VID_0483&PID_DF11\\205B30915843', 'USB\\VID_1A86&PID_7523\\5&2B&0&3', 'USB\\VID_046D&PID_C52B\\5&1&0&1'
  ].map(usb.parseWinId);
  assert.deepStrictEqual(win[0], { vid: 0x0483, pid: 0x374B, iface: undefined, serial: '066DFF485671664867074721' });
  assert.strictEqual(win[1].iface, 0);
  assert.strictEqual(win[1].serial, undefined, 'arayüz örneğinde seri numarası yok');
  const devices = [win[0], win[1], { ...win[2], port: 'COM7', name: 'STMicroelectronics STLink Virtual COM Port (COM7)' }, win[3], win[4], { ...win[5], port: 'COM3' }, win[6]];
  const probes = usb.classify(devices);
  assert.deepStrictEqual(probes.map((p) => [p.kind, p.label, p.serial || null, p.port || null]), [
    ['stlink', 'ST-Link V2-1', '066DFF485671664867074721', 'COM7'],
    ['jlink', 'SEGGER J-Link', '000260115436', null],
    ['dfu', 'STM32 USB DFU (bootloader)', '205B30915843', null],
    ['uart', 'CH340/CH341 UART', null, 'COM3']
  ]);
  assert.strictEqual(probes[0].interfaceCfg, 'interface/stlink.cfg');
  assert.strictEqual(usb.classify([{ vid: 0x0483, pid: 0x374E, serial: 'X' }])[0].label, 'ST-Link V3');
  assert.strictEqual(usb.classify([{ vid: 0x0D28, pid: 0x0204, serial: 'D' }])[0].interfaceCfg, 'interface/cmsis-dap.cfg');
});
test('hedef kimliği: F411 (RDP 0), H743 rev V, F103 (RDP 1), G071; aday adresler catch ile', () => {
  assert.ok(sid.readCommands().every((c) => /^catch \{md[wh] 0x[0-9A-F]{8}( 3)?\}$/.test(c)));
  const f411 = sid.decodeTarget(`Info : [stm32f4x.cpu] Cortex-M4 r0p1 processor detected
0x40015800: 00000000
0xe0042000: 10006431
0x1fff7a22: 0200
0x1fff7a10: 00300041 30355101 32373232
0x40023c14: 0fffaaed`);
  assert.deepStrictEqual([f411.name, f411.devId, f411.rev, f411.flashKB, f411.uid, f411.rdp], ['STM32F411xC/E', 0x431, 'A', 512, '323732323035510100300041', 0]);
  assert.strictEqual(sid.matchesProject(f411, lib.mcus.stm32f411ceu6), true);
  assert.strictEqual(sid.matchesProject(f411, lib.mcus.stm32g474ret6), false);
  const h7 = sid.decodeTarget('0x5c001000: 20036450\n0x1ff1e880: 0800\n0x5200201c: 1ab0aac6');
  assert.deepStrictEqual([h7.name, h7.rev, h7.flashKB, h7.rdp], ['STM32H74x/75x', 'V', 2048, 0]);
  assert.strictEqual(sid.matchesProject(h7, lib.mcus.stm32h743zit6), true);
  const f1 = sid.decodeTarget('0xe0042000: 20036410\n0x1ffff7e0: 0040\n0x4002201c: 03fffffe');
  assert.deepStrictEqual([f1.name, f1.rev, f1.flashKB, f1.rdp], ['STM32F10x medium-density', 'Y', 64, 1]);
  const g0 = sid.decodeTarget('0x40015800: 20006460\n0x40022020: dffff8bb');
  assert.deepStrictEqual([g0.devId, g0.rdp], [0x460, 1]);
  assert.strictEqual(sid.matchesProject(g0, lib.mcus.stm32g071rbt6), true);
  assert.strictEqual(sid.decodeTarget('0xe0042000: 10006999'), null, 'bilinmeyen DEV_ID');
  assert.deepStrictEqual([sid.rdpLevel('byte0', 0xAA), sid.rdpLevel('byte0', 0xCC), sid.rdpLevel('byte8', 0x5500), sid.rdpLevel('obr2', 0x6)], [0, 2, 0.5, 2]);
});
test('prob raporu: problar, hedef, uyuşmazlık, eksik araç', () => {
  const { probeReport } = require('../src/debug/report');
  const target = sid.decodeTarget('0xe0042000: 10006469\n0x1fff75e0: 0200\n0x40022020: ffeff8aa');
  const md = probeReport({ mcu: lib.mcus.stm32f411ceu6, result: { ok: true, probes: usb.classify([{ vid: 0x0483, pid: 0x374B, serial: 'ABC' }]), core: 'Cortex-M4', voltage: '3.28', target, match: false },
    tools: [{ name: 'OpenOCD', found: false, required: true, install: 'https://x', hint: 'winget' }] });
  for (const s of ['ST-Link V2-1', '`ABC`', 'STM32G47x/48x', 'DEV_ID 0x469', '512 KB', 'Seviye 0', '⚠ Projedeki işlemci STM32F411CEU6', '3.28 V', 'gerekli, yok']) assert.ok(md.includes(s), s);
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

test('flash komutu: OpenOCD/CubeProgrammer, .bin adresi, tam silme, reset altında, hız, seri no', () => {
  const fc = require('../src/debug/flashcmd');
  const base = { file: 'C:\\p\\build\\app.elf', family: 'f4', targetCfg: 'target/stm32f4x.cfg' };
  let c = fc.buildFlashCommand({ ...base, tool: 'openocd', reset: true });
  assert.deepStrictEqual(c.args, ['-f', 'interface/stlink.cfg', '-f', 'target/stm32f4x.cfg', '-c', 'program {C:/p/build/app.elf} verify reset exit']);
  c = fc.buildFlashCommand({ ...base, tool: 'openocd', file: 'a.bin', verify: false, address: 0x08004000 });
  assert.ok(c.args[c.args.length - 1] === 'program {a.bin} exit 0x08004000', c.display);
  c = fc.buildFlashCommand({ ...base, tool: 'openocd', file: 'a.bin' });
  assert.ok(/exit 0x08000000$/.test(c.args[c.args.length - 1]), c.display);
  c = fc.buildFlashCommand({ ...base, tool: 'openocd', erase: 'full', underReset: true, speedKHz: 480, multipleProbes: true,
    probe: { kind: 'jlink', interfaceCfg: 'interface/jlink.cfg', serial: '123' } });
  const j = c.args.join(' ');
  assert.ok(j.startsWith('-f interface/jlink.cfg -c adapter serial 123 -f target/stm32f4x.cfg'), j);
  assert.ok(/adapter speed 480/.test(j) && /connect_assert_srst/.test(j) && /stm32f2x mass_erase 0/.test(j), j);
  c = fc.buildFlashCommand({ ...base, family: 'h7', tool: 'openocd', erase: 'full' });
  assert.ok(/stm32h7x mass_erase 1/.test(c.args.join(' ')), 'H7 ikinci banka');
  c = fc.buildFlashCommand({ ...base, tool: 'cubeprog', erase: 'full', underReset: true, speedKHz: 1000, reset: true });
  assert.deepStrictEqual(c.args, ['-c', 'port=SWD', 'freq=1000', 'mode=UR', 'reset=HWrst', '-e', 'all', '-w', base.file, '-v', '-rst']);
  c = fc.buildFlashCommand({ ...base, tool: 'cubeprog', file: 'x.bin', probe: { kind: 'dfu' }, verify: false });
  assert.deepStrictEqual(c.args, ['-c', 'port=USB1', '-w', 'x.bin', '0x08000000']);
  c = fc.buildFlashCommand({ ...base, tool: 'cubeprog', probe: { kind: 'uart', port: 'COM7' } });
  assert.deepStrictEqual(c.args.slice(0, 3), ['-c', 'port=COM7', 'br=115200']);
  assert.strictEqual(fc.kindOf('a.HEX'), 'hex');
});
test('flash çıktısı: ilerleme, istatistik, başarı ölçütü ve hata açıklamaları', () => {
  const fc = require('../src/debug/flashcmd');
  assert.deepStrictEqual(fc.parseProgress('openocd', '** Programming Started **'), { stage: 'program', percent: 30 });
  assert.strictEqual(fc.parseProgress('openocd', 'Info : clock speed 2000 kHz'), null);
  assert.strictEqual(fc.parseProgress('cubeprog', '  ██████ 50%').percent, 50);
  const log = 'Info : stm32f4x.cpu: hardware has 6 breakpoints\n** Programming Started **\nInfo : wrote 16384 bytes from file app.elf in 0.52s (30.769 KiB/s)\n** Programming Finished **\n** Verify Started **\n** Verified OK **\n';
  assert.deepStrictEqual(fc.parseStats('openocd', log), { bytes: 16384, seconds: 0.52, kibps: 30.769 });
  assert.strictEqual(fc.parseStats('cubeprog', 'Time elapsed during download operation: 00:00:01.250').seconds, 1.25);
  assert.ok(fc.flashSucceeded('openocd', log, 0, true));
  assert.ok(!fc.flashSucceeded('openocd', log.replace('** Verified OK **', ''), 0, true), 'verify yoksa başarısız');
  assert.ok(!fc.flashSucceeded('openocd', log, 1, true));
  assert.ok(fc.flashSucceeded('cubeprog', 'File download complete\n', 0, false));
  assert.ok(/Prob bulunamadı/.test(fc.explainFlashError('Error: open failed')));
  assert.ok(/RDP/.test(fc.explainFlashError('Error: stm32x device protected')));
  assert.ok(/beslenmiyor/.test(fc.explainFlashError('Info : Target voltage: 0.000000\nError: init mode failed (unable to connect to the target)')));
  assert.ok(/bağlanılamadı/.test(fc.explainFlashError('Error: init mode failed (unable to connect to the target)')));
  assert.ok(/Doğrulama/.test(fc.explainFlashError('Error: checksum mismatch - attempting binary compare\nverify failed')));
  assert.strictEqual(fc.explainFlashError('her şey yolunda'), null);
});

test('debug yapılandırması (ES-204): OpenOCD/ST-LINK/pyOCD/J-Link, reset\'te dur, attach, Cortex-Debug alanları', () => {
  const L = require('../src/debug/launch');
  assert.strictEqual(L.partName('STM32F411CEU6'), 'STM32F411CE');
  assert.strictEqual(L.partName('STM32H743ZIT6'), 'STM32H743ZI');
  assert.strictEqual(L.partName('STM32F103C8T6'), 'STM32F103C8');
  const o = { project: 'demo', elf: '${workspaceFolder}/build/debug/demo.elf', cwd: '${workspaceFolder}', mcuName: 'STM32F411CEU6', targetCfg: 'target/stm32f4x.cfg', preLaunchTask: 'Derle' };
  const [dbg, halt, attach] = L.launchConfigs(o);
  assert.deepStrictEqual([dbg.type, dbg.request, dbg.servertype, dbg.runToEntryPoint, dbg.preLaunchTask], ['cortex-debug', 'launch', 'openocd', 'main', 'Derle']);
  assert.deepStrictEqual(dbg.configFiles, ['interface/stlink.cfg', 'target/stm32f4x.cfg']);
  assert.ok(halt.breakAfterReset && !halt.runToEntryPoint, 'reset\'te dur: main\'e koşmaz');
  assert.ok(attach.request === 'attach' && !attach.preLaunchTask && !attach.runToEntryPoint && !attach.breakAfterReset, JSON.stringify(attach));
  assert.strictEqual(new Set([dbg.name, halt.name, attach.name]).size, 3);
  const jl = L.cortexConfig({ ...o, name: 'x', server: 'jlink', serial: '5001', rtos: true });
  assert.deepStrictEqual([jl.device, jl.interface, jl.serialNumber, jl.rtos, jl.configFiles], ['STM32F411CE', 'swd', '5001', 'FreeRTOS', undefined]);
  assert.strictEqual(L.cortexConfig({ ...o, name: 'x', server: 'pyocd' }).targetId, 'stm32f411ce');
  const st = L.cortexConfig({ ...o, name: 'x', server: 'stlink' });
  assert.ok(st.servertype === 'stlink' && !st.configFiles && !st.device);
  const oc = L.cortexConfig({ ...o, name: 'x', interfaceCfg: 'interface/cmsis-dap.cfg', serial: 'ABC', speedKHz: 1000, rtos: true, svd: 's.svd' });
  assert.deepStrictEqual([oc.configFiles[0], oc.openOCDPreConfigLaunchCommands, oc.openOCDLaunchCommands, oc.rtos, oc.svdFile], ['interface/cmsis-dap.cfg', ['adapter serial ABC'], ['adapter speed 1000'], 'auto', 's.svd']);
  assert.ok(Object.values(oc).every((v) => v !== undefined), 'tanımsız alan yazılmaz');
});
test('launch.json/tasks.json birleştirme: kullanıcı yapılandırmaları korunur, JSONC okunur, bozuk dosyaya yazılmaz', () => {
  const L = require('../src/debug/launch');
  const cur = `{
  // kullanıcının yorumu
  "version": "0.2.0",
  "configurations": [
    { "name": "Benim", "type": "cppdbg", "url": "http://x//y", }, /* blok */
    { "name": "Debug: demo (OpenOCD)", "type": "eski" },
  ],
}`;
  assert.ok(L.parseJsonc(cur).configurations[0].url === 'http://x//y', 'dizgedeki // yorum sayılmaz');
  const m = L.mergeJsonList(cur, 'configurations', [{ name: 'Debug: demo (OpenOCD)', type: 'cortex-debug' }, { name: 'Yeni', type: 'cortex-debug' }], '0.2.0');
  const doc = JSON.parse(m.text);
  assert.deepStrictEqual(doc.configurations.map((c) => [c.name, c.type]), [['Benim', 'cppdbg'], ['Debug: demo (OpenOCD)', 'cortex-debug'], ['Yeni', 'cortex-debug']]);
  assert.deepStrictEqual([m.added, m.replaced, doc.version], [1, 1, '0.2.0']);
  assert.strictEqual(JSON.parse(L.mergeJsonList('', 'tasks', [L.buildTask('Derle', 'cmake --build build/debug')], '2.0.0').text).version, '2.0.0');
  assert.strictEqual(L.mergeJsonList('{ "configurations": [ ', 'configurations', [], '0.2.0'), null);
  const task = L.buildTask('Derle', 'a && b');
  assert.ok(task.problemMatcher[0] === '$gcc' && task.windows.options.shell.executable === 'cmd.exe', 'Windows: cmd.exe');
});
test('donanım breakpoint sınırı: çekirdeğe göre, devre dışı ve veri breakpoint\'leri sayılmaz', () => {
  const L = require('../src/debug/launch');
  const bp = (n, extra = []) => [...Array(n)].map(() => ({ enabled: true, kind: 'source' })).concat(extra);
  assert.deepStrictEqual(L.breakpointUsage(bp(3), 'cortex-m0plus'), { used: 3, limit: 4, level: 'ok' });
  assert.strictEqual(L.breakpointUsage(bp(4), 'cortex-m0').level, 'full');
  assert.strictEqual(L.breakpointUsage(bp(7), 'cortex-m4').level, 'over');
  assert.strictEqual(L.breakpointUsage(bp(6, [{ enabled: false, kind: 'source' }, { enabled: true, kind: 'data' }]), 'cortex-m4').level, 'full');
  assert.strictEqual(L.breakpointUsage(bp(7), 'cortex-m7').level, 'ok');
  assert.deepStrictEqual(L.disassemblyArgs('a.elf').slice(0, 3), ['-d', '-S', '-C']);
  // Her ailenin çekirdeği tabloda
  const { FAMILIES } = require('../src/codegen/families');
  if (FAMILIES) for (const f of Object.values(FAMILIES)) assert.ok(L.HW_BREAKPOINTS[f.core], f.core);
});
test('SVD (ES-205): dim dizisi, cluster, register/peripheral kalıtımı, erişim, reset, boyut, enum', () => {
  const { parseSvd, summary } = require('../src/debug/registers');
  const svd = `<?xml version="1.0"?><device><name>TEST</name><cpu><name>CM4</name><fpuPresent>true</fpuPresent></cpu><access>read-write</access><size>32</size>
  <peripherals>
    <peripheral><name>TIM1</name><description>Gelişmiş zamanlayıcı</description><groupName>TIM</groupName><baseAddress>0x40010000</baseAddress><registers>
      <register><name>CR1</name><addressOffset>0x0</addressOffset><resetValue>0x0</resetValue><fields>
        <field><name>CEN</name><bitOffset>0</bitOffset><bitWidth>1</bitWidth><enumeratedValues>
          <enumeratedValue><name>Disabled</name><description>Sayaç kapalı</description><value>0</value></enumeratedValue>
          <enumeratedValue><name>Enabled</name><value>1</value></enumeratedValue></enumeratedValues></field>
        <field><name>CKD</name><bitRange>[9:8]</bitRange><access>read-only</access></field></fields></register>
      <register><name>SR</name><addressOffset>0x10</addressOffset><size>16</size><access>read-only</access><resetValue>0x1234</resetValue></register>
      <register derivedFrom="CR1"><name>CR1_COPY</name><addressOffset>0x20</addressOffset></register>
      <register><name>CCR%s</name><dim>4</dim><dimIncrement>4</dimIncrement><dimIndex>1-4</dimIndex><addressOffset>0x34</addressOffset></register>
      <cluster><name>CH[%s]</name><dim>2</dim><dimIncrement>0x10</dimIncrement><addressOffset>0x100</addressOffset>
        <register><name>CFG</name><addressOffset>0x4</addressOffset><access>write-only</access></register></cluster>
    </registers></peripheral>
    <peripheral derivedFrom="TIM1"><name>TIM8</name><baseAddress>0x40010400</baseAddress></peripheral>
  </peripherals></device>`;
  const r = parseSvd(svd);
  assert.deepStrictEqual(r.cpu, { name: 'CM4', fpu: true });
  const tim = r.peripherals[0];
  assert.strictEqual(tim.desc, 'Gelişmiş zamanlayıcı');
  const reg = (n) => tim.registers.find((x) => x.name === n);
  assert.deepStrictEqual(reg('CR1').fields[0].enums, [{ name: 'Disabled', value: 0, desc: 'Sayaç kapalı' }, { name: 'Enabled', value: 1, desc: '' }]);
  assert.deepStrictEqual([reg('CR1').fields[1].lsb, reg('CR1').fields[1].width, reg('CR1').fields[1].access], [8, 2, 'ro']);
  assert.ok(reg('CR1').access === undefined && reg('CR1').fields[0].access === undefined, 'rw yazılmaz');
  assert.deepStrictEqual([reg('SR').access, reg('SR').size, reg('SR').reset], ['ro', 16, 0x1234]);
  assert.strictEqual(reg('CR1_COPY').fields.length, 2, 'register derivedFrom alanları alır');
  assert.deepStrictEqual(['CCR1', 'CCR2', 'CCR3', 'CCR4'].map((n) => reg(n).offset), [0x34, 0x38, 0x3c, 0x40]);
  assert.deepStrictEqual([reg('CH0_CFG').offset, reg('CH1_CFG').offset, reg('CH1_CFG').access], [0x104, 0x114, 'wo']);
  const tim8 = r.peripherals.find((p) => p.name === 'TIM8');
  assert.deepStrictEqual([tim8.group, tim8.registers.length, tim8.base], ['TIM', tim.registers.length, 0x40010400]);
  assert.deepStrictEqual(summary(r.peripherals)[0], { name: 'TIM1', base: 0x40010000, group: 'TIM', desc: 'Gelişmiş zamanlayıcı', count: tim.registers.length });
  // İndirilmiş gerçek SVD'ler varsa (CI'da yok): hepsi ayrışır, G071'de enum, F411'de salt okunur IDR
  const dir = path.join(os.tmpdir(), 'es-svd');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.svd'))) {
      const s = parseSvd(fs.readFileSync(path.join(dir, f), 'utf8'));
      assert.ok(s.peripherals.length > 20 && s.peripherals.every((p) => Number.isFinite(p.base) && p.registers.every((x) => Number.isFinite(x.offset))), f);
    }
    const g0 = parseSvd(fs.readFileSync(path.join(dir, 'STM32G071.svd'), 'utf8'));
    assert.ok(g0.peripherals.some((p) => p.registers.some((x) => x.fields.some((fl) => fl.enums && fl.enums.length))), 'G071: enum değerleri');
    const f4 = parseSvd(fs.readFileSync(path.join(dir, 'STM32F411.svd'), 'utf8'));
    assert.strictEqual(f4.peripherals.find((p) => p.name === 'GPIOA').registers.find((x) => x.name === 'IDR').access, 'ro');
  }
});
test('register yazma: alan ekleme, değer ayrıştırma; FPU ve özel register adları', () => {
  const R = require('../src/debug/registers');
  assert.strictEqual(R.insertField(0xffffffff, 8, 2, 0), 0xfffffcff);
  assert.strictEqual(R.insertField(0, 31, 1, 1), 0x80000000);
  assert.strictEqual(R.insertField(0x12345678, 0, 32, 0xdeadbeef), 0xdeadbeef);
  assert.throws(() => R.insertField(0, 4, 3, 8), /sığmıyor/);
  assert.strictEqual(R.fieldValue(0x00000300, 8, 2), 3);
  assert.deepStrictEqual(['0x1F', '0b101', '42', '0xFFFF_FFFF'].map(R.parseValue), [31, 5, 42, 0xffffffff]);
  assert.throws(() => R.parseValue('abc'), /Geçersiz/);
  assert.throws(() => R.parseValue('0x100000000'), /Geçersiz/);
  const S = require('../src/debug/session');
  assert.deepStrictEqual(S.specialRegs({ v6m: true }), ['msp', 'psp', 'primask', 'control']);
  assert.ok(S.specialRegs({}).includes('basepri') && S.specialRegs({}).includes('faultmask'));
  assert.deepStrictEqual(S.splitFpu({ d0: '0x400000003fc00000', d15: '0x0', fpscr: '0x03000000' }), { s0: 0x3fc00000, s1: 0x40000000, s30: 0, s31: 0, fpscr: 0x03000000 });
});

(async () => {
  // Asenkron testler
  {
    const { SimTarget } = require('../src/debug/session');
    const sim = new SimTarget({ peripherals: [], expected: new Map([[0x40020014, 0x5]]), dynamic: new Map([[0x40020014, () => 1]]) });
    await sim.writeMemory(0x40020014, 32, 0xa0);
    assert.deepStrictEqual(await sim.readMemory(0x40020014, 1), [0xa0], 'yazılan değer okunur, canlı model devre dışı');
    await sim.writeMemory(0x40020016, 16, 0xbeef);
    assert.deepStrictEqual(await sim.readMemory(0x40020014, 1), [0xbeef00a0], '16 bit yazma');
    await sim.halt();
    const core = await sim.coreRegisters({ fpu: true });
    assert.ok(core.msp !== undefined && core.control === 0 && core.s0 === 0x3fc00000 && core.fpscr === 0 && core.basepri === 0);
    assert.ok(!('basepri' in await sim.coreRegisters({ v6m: true })), 'M0: BASEPRI yok');
    passed++;
    console.log('  ✓ simülasyonda register yazma ve genişletilmiş çekirdek register\'ları');
  }
  const { OpenOcdTarget, freePort } = require('../src/debug/session');
  const port = await freePort();
  assert.ok(port > 0 && port !== 6666, String(port));
  const tg = new OpenOcdTarget({ targetCfg: 'target/stm32f4x.cfg', openocdPath: 'olmayan-openocd-xyz' });
  await assert.rejects(() => tg.connect(), /başlatılamadı|olmayan/);
  assert.strictEqual(tg.proc, null, 'süreç bırakılmadı');
  passed++;
  console.log('  ✓ debug paneli oturumu: boş port seçilir; bağlanamayınca openocd kapatılır');

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`\nsmoke: ${passed} test geçti`);
})().catch((e) => { console.error(e); process.exit(1); });
