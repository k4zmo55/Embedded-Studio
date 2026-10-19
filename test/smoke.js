// Motor, saat ağacı, kod üretici ve birleştirme için hızlı doğrulama. Çalıştırma: node test/smoke.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadLibrary, validateComponent, componentTemplate } = require('../src/library');
const { assign } = require('../src/engine/pinAssigner');
const { computeClock, solveClock } = require('../src/engine/clock');
const { generate, GENERATOR_VERSION } = require('../src/codegen/generator');
const { writeProject, designFingerprint, mergeUserBlocks, relocateLayout, syncCodeIntel } = require('../src/codegen/merge');
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
test('ES-108: .clangd ve C_Cpp.default.compileCommands derleme tipine göre; kullanıcınınkine dokunulmaz', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-intel-'));
  const settings = path.join(dir, '.vscode', 'settings.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, JSON.stringify({ 'files.autoSave': 'afterDelay' }));
  let r = syncCodeIntel(dir, 'Debug');
  assert.deepStrictEqual(r.changed, ['.clangd', '.vscode/settings.json']);
  const clangd = fs.readFileSync(path.join(dir, '.clangd'), 'utf8');
  assert.match(clangd, /CompilationDatabase: build\/debug\n/);
  assert.match(clangd, /-fcallgraph-info=\*/);
  let s = JSON.parse(fs.readFileSync(settings, 'utf8'));
  assert.strictEqual(s['files.autoSave'], 'afterDelay');
  assert.strictEqual(s['C_Cpp.default.compileCommands'], '${workspaceFolder}/build/debug/compile_commands.json');
  assert.deepStrictEqual(syncCodeIntel(dir, 'Debug').changed, []);
  r = syncCodeIntel(dir, 'Release');
  assert.deepStrictEqual(r.changed, ['.clangd', '.vscode/settings.json']);
  assert.match(fs.readFileSync(path.join(dir, '.clangd'), 'utf8'), /build\/release/);
  // kullanıcının kendi .clangd'si ve farklı compileCommands değeri
  fs.writeFileSync(path.join(dir, '.clangd'), 'CompileFlags:\n  Add: [-DX]\n');
  fs.writeFileSync(settings, JSON.stringify({ 'C_Cpp.default.compileCommands': '${workspaceFolder}/out/cc.json' }));
  r = syncCodeIntel(dir, 'Debug');
  assert.deepStrictEqual(r.changed, []);
  assert.deepStrictEqual(r.skipped, ['.clangd', '.vscode/settings.json']);
  // yorumlu settings.json yeniden yazılmaz
  fs.writeFileSync(settings, '{\n  // not\n  "a": 1\n}\n');
  assert.deepStrictEqual(syncCodeIntel(dir, 'Debug').skipped, ['.clangd', '.vscode/settings.json']);
  assert.ok(fs.readFileSync(settings, 'utf8').includes('// not'));
  // eski tek build/ klasörünü gösteren değer güncellenir
  fs.writeFileSync(settings, JSON.stringify({ 'C_Cpp.default.compileCommands': '${workspaceFolder}/build/compile_commands.json' }));
  assert.ok(syncCodeIntel(dir, 'Debug').changed.includes('.vscode/settings.json'));
  // HAL: *_hal_conf.h tek başına açılınca HAL türleri gelsin
  fs.rmSync(path.join(dir, '.clangd'));
  syncCodeIntel(dir, 'Debug', 'stm32f4xx_hal_def.h');
  assert.match(fs.readFileSync(path.join(dir, '.clangd'), 'utf8'), /PathMatch: .*_hal_conf[\s\S]*-include, stm32f4xx_hal_def\.h/);
  fs.rmSync(dir, { recursive: true, force: true });
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
test('paket ve fiziksel pinler (ES-1002): ped sayısı, pin atayıcının pinleri ve AF\'leri pakette, türler, kenarlar, kart pinleri', () => {
  const pk = require('../src/engine/package');
  const PKG = { stm32f411ceu6: 'UFQFPN48', stm32f030c8t6: 'LQFP48', stm32f103c8t6: 'LQFP48', stm32f303ret6: 'LQFP64', stm32f407vgt6: 'LQFP100', stm32f429zit6: 'LQFP144',
    stm32f446ret6: 'LQFP64', stm32f767zit6: 'LQFP144', stm32h743zit6: 'LQFP144', stm32h723zgt6: 'LQFP144', stm32g071rbt6: 'LQFP64', stm32g474ret6: 'LQFP64',
    stm32l432kcu6: 'UFQFPN32', stm32l476rgt6: 'LQFP64', stm32u575zit6q: 'LQFP144' };
  for (const m of Object.values(lib.mcus)) {
    const p = m.package;
    assert.strictEqual(p.name, PKG[m.id], m.id);
    const pads = pk.pads(m);
    assert.strictEqual(pads.length, p.pinCount, `${m.id}: ped sayısı`);
    assert.deepStrictEqual(pads.map((x) => Number(x.pos)), Array.from({ length: p.pinCount }, (_, i) => i + 1), `${m.id}: 1..N`);
    assert.ok(pads.some((x) => /NRST/.test(x.name)) && pads.some((x) => x.type === 'power'), `${m.id}: NRST ve besleme`);
    for (const pin of m.pins) {
      const pad = pk.padFor(m, pin.name);
      assert.ok(pad && pad.type === 'io' && pad.modes.includes('Output'), `${m.id}: ${pin.name}`);
      for (const f of pin.functions.filter((x) => x.af !== undefined)) assert.ok(pad.signals.some((s) => s.af === f.af), `${m.id}: ${pin.name} ${f.signal} AF${f.af}`);
    }
    for (const x of pads) assert.ok(pk.sideOf(p, x.pos), `${m.id}: ${x.pos} kenarı`);
    assert.deepStrictEqual(m.boardPins, Object.fromEntries(m.pins.filter((x) => x.note).map((x) => [x.name, x.note])));
  }
  const f411 = lib.mcus.stm32f411ceu6;
  assert.deepStrictEqual(['NRST', 'BOOT0', 'PA13', 'VBAT'].map((n) => pk.pads(f411).find((x) => x.name === n || x.gpio === n).pos), ['7', '44', '34', '1']);
  assert.ok(pk.padFor(f411, 'PA9').signals.some((s) => s.signal === 'USB_OTG_FS_VBUS'), 'pin atayıcının desteklemediği sinyaller de var');
  assert.ok(pk.padFor(f411, 'PB8').signals.some((s) => s.signal === 'SDIO_D4' && s.af === 12));
  assert.deepStrictEqual([pk.sideOf(f411.package, '1'), pk.sideOf(f411.package, '13'), pk.sideOf(f411.package, '25'), pk.sideOf(f411.package, '48')],
    [{ side: 'left', index: 0, perSide: 12 }, { side: 'bottom', index: 0, perSide: 12 }, { side: 'right', index: 0, perSide: 12 }, { side: 'top', index: 11, perSide: 12 }]);
  // F1: AF numarası yok, varsayılan dışı sinyaller remap ile
  assert.deepStrictEqual(pk.padFor(lib.mcus.stm32f103c8t6, 'PB6').signals.find((s) => s.signal === 'USART1_TX'), { signal: 'USART1_TX', remap: true });
  // G0: PA11 pedinde PA9 yeniden eşlenebilir (ikincil girdi)
  const g0 = lib.mcus.stm32g071rbt6;
  assert.deepStrictEqual(pk.alternates(g0, pk.padFor(g0, 'PA11')).map((x) => x.name), ['PA9 [PA11]']);
  assert.strictEqual(pk.padFor(g0, 'PA9').pos, '37');
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
  assert.strictEqual(rd.resolveDrivers(lib.mcus.stm32h743zit6, rd.DRIVERS.map((d) => d.id)).length, 15);
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
  {
    // ES-206: bellek bölgesi okuma (hizasız, parçalı), Intel HEX, yazma denetimi, simülasyon değişkenleri
    const mem = require('../src/debug/memory');
    const { SimTarget } = require('../src/debug/session');
    const model = { peripherals: [], expected: new Map(), dynamic: new Map() };
    for (let a = 0x20000000; a < 0x20000800; a += 4) model.expected.set(a, (a - 0x20000000) / 4);
    const sim = new SimTarget(model);
    let calls = 0;
    const counted = { readMemory: (a, n) => { calls++; assert.ok(n <= mem.CHUNK_WORDS); return sim.readMemory(a, n); } };
    const bytes = await mem.readRegion(counted, 0x20000005, 1500);
    assert.strictEqual(bytes.length, 1500);
    assert.strictEqual(bytes[0], 0x00, '0x20000005 = word 1 baytı 1');
    assert.strictEqual(bytes[3], 2, '0x20000008 = word 2 baytı 0');
    assert.ok(calls === 2, `parça sayısı ${calls}`);
    // Intel HEX: genişletilmiş adres kaydı, 16 baytlık satırlar, sağlama toplamı, 64 KB sınırı
    const hx = mem.toIntelHex(Uint8Array.from([1, 2, 3]), 0x0800fffe).trim().split('\n');
    assert.deepStrictEqual(hx, [':020000040800F2', ':02FFFE000102FE', ':020000040801F1', ':0100000003FC', ':00000001FF']);
    for (const line of mem.toIntelHex(Uint8Array.from({ length: 40 }, (_, i) => i), 0x20000000).trim().split('\n')) {
      const b = line.slice(1).match(/../g).map((x) => parseInt(x, 16));
      assert.strictEqual(b.reduce((a, x) => a + x, 0) & 0xff, 0, line);
    }
    assert.match(mem.checkWrite(0x08000000, 32, 1), /Flash|yazılamaz/);
    assert.match(mem.checkWrite(0x20000001, 16, 1), /hizalı/);
    assert.match(mem.checkWrite(0x20000000, 8, 256), /sığmıyor/);
    assert.strictEqual(mem.checkWrite(0x20000002, 16, 0xffff), '');
    assert.strictEqual(mem.checkWrite(0x40020014, 32, 0xffffffff), '');
    // Örnek değişkenler zamanla değişir; durunca donar
    const syms = mem.simSymbols(model, [{ label: 'BME280_1' }]);
    assert.ok(['bme280_1_ok', 'uwTick', 'adc_raw', 'temperature'].every((n) => syms.some((x) => x.name === n)));
    const temp = syms.find((x) => x.name === 'temperature');
    const f = (await sim.readMemory(temp.addr, 1))[0];
    const fl = Buffer.alloc(4); fl.writeUInt32LE(f); assert.ok(Math.abs(fl.readFloatLE() - 24) < 4, String(fl.readFloatLE()));
    await sim.halt();
    const t1 = (await sim.readMemory(0x20000080, 1))[0];
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual((await sim.readMemory(0x20000080, 1))[0], t1, 'durunca uwTick donar');
    await sim.resume();
    await new Promise((r) => setTimeout(r, 30));
    assert.ok((await sim.readMemory(0x20000080, 1))[0] > t1, 'devam edince artar');
    await sim.writeMemory(0x20000084, 16, 0x1234);
    assert.strictEqual((await sim.readMemory(0x20000084, 1))[0] & 0xffff, 0x1234, 'değişkene yazma');
    passed++;
    console.log('  ✓ bellek görüntüleyici (ES-206): parçalı okuma, Intel HEX, yazma denetimi, canlı örnek değişkenler');
  }
  {
    // ES-207: fault register çözümü, EXC_RETURN, çerçeve, simülasyon senaryoları, addr2line
    const F = require('../src/debug/fault');
    const { SimTarget } = require('../src/debug/session');
    let d = F.decodeFault({ CFSR: (1 << 9) | (1 << 15), HFSR: 1 << 30, BFAR: 0x8, SHCSR: 0 });
    assert.deepStrictEqual(d.findings.map((x) => x.name), ['PRECISERR', 'FORCED']);
    assert.strictEqual(d.kind, 'BusFault');
    assert.deepStrictEqual(d.address, { reg: 'BFAR', value: 8 });
    assert.ok(d.causes.some((c) => /NULL/.test(c)) && /HardFault/.test(d.summary) && /BusFault/.test(d.summary), d.summary);
    assert.deepStrictEqual(d.enabled, { MemManage: false, BusFault: false, UsageFault: false });
    d = F.decodeFault({ CFSR: (1 << 1) | (1 << 7), MMFAR: 0x40004400, HFSR: 0 });
    assert.strictEqual(d.kind, 'MemManage');
    assert.ok(d.address.reg === 'MMFAR' && d.causes.some((c) => /RCC/.test(c)));
    assert.deepStrictEqual(F.decodeFault({ CFSR: (1 << 25) | (1 << 24) }).findings.map((x) => x.name), ['UNALIGNED', 'DIVBYZERO']);
    assert.ok(/sıfır/.test(F.decodeFault({ CFSR: 0, HFSR: 0 }).summary));
    assert.ok(/M0/.test(F.decodeFault({}, { v6m: true }).summary));
    assert.deepStrictEqual(F.excReturn(0xfffffffd), { psp: true, thread: true, fpuFrame: false });
    assert.deepStrictEqual(F.excReturn(0xffffffe9), { psp: false, thread: true, fpuFrame: true });
    assert.strictEqual(F.excReturn(0x08000123), null);
    const fr = F.parseFrame([1, 2, 3, 4, 12, 0x08000201, 0x08000300, 0x01000200], 0x20001000, true);
    assert.strictEqual(fr.preSp, 0x20001000 + 0x68 + 4, 'FPU çerçevesi + hizalama dolgusu');
    assert.ok(F.frameValid(fr) && !F.frameValid({ ...fr, pc: 0x20000000 }) && !F.frameValid({ ...fr, xpsr: 0 }) && F.frameValid({ ...fr, xpsr: 0 }, false));
    // Simülasyon: her senaryo analizden doğru bulguyla geçer; MSP'de itilmiş kayıtlar atlanır
    const expect = { nullwrite: ['PRECISERR', true, 0], divzero: ['DIVBYZERO', true, 0], unaligned: ['UNALIGNED', false, 8], badfunc: ['INVSTATE', true, 0], clock: ['PRECISERR', false, 8], stack: ['STKERR', true, 0] };
    for (const [k, sc] of Object.entries(F.SIM_FAULTS())) {
      const sim = new SimTarget({ peripherals: [], expected: new Map(), dynamic: new Map() });
      await sim.fault(sc, { pc: 0x08000a3c, lr: 0x08000b10 });
      const r = await F.analyze(sim, { fpu: true });
      const [name, psp, shift] = expect[k];
      assert.ok(r.decoded.findings.some((x) => x.name === name), k);
      assert.strictEqual(r.context.handler, 'HardFault', k);
      assert.ok(r.context.inFault && r.context.excReturn.psp === psp, k);
      assert.strictEqual(r.shift, shift, k + ' shift');
      assert.ok(!r.frame.invalid && r.frame.pc === 0x08000a3c && r.frame.lr === 0x08000b11, k + ' çerçeve');
      await sim.reset();
      assert.strictEqual((await sim.readMemory(F.SCB.CFSR, 1))[0], 0, 'reset fault kaydını siler');
    }
    // FreeRTOS: çalışan görev adı ve yığın başı (pxCurrentTCB)
    {
      const model = { peripherals: [], expected: new Map(), dynamic: new Map() };
      const sim = new SimTarget(model);
      await sim.fault(F.SIM_FAULTS().stack, { pc: 0x08000a3c, lr: 0x08000b10 });
      const tcb = 0x20003000, name = Buffer.from('SensorTask\0\0\0\0\0\0');
      model.expected.set(0x20000500, tcb);
      model.expected.set(tcb + 44, 3);
      model.expected.set(tcb + 48, 0x20001e20); // yığın başı: PSP'ye 32 bayt
      for (let i = 0; i < 4; i++) model.expected.set(tcb + 52 + i * 4, name.readUInt32LE(i * 4));
      const r = await F.analyze(sim, {}, { rtos: true, tcb: 0x20000500 });
      assert.deepStrictEqual(r.task, { name: 'SensorTask', tcb, stack: 0x20001e20, priority: 3 });
      assert.ok(/RTOS/.test(r.context.where) && /tükenmiş/.test(r.decoded.causes[0]), r.decoded.causes[0]);
    }
    // addr2line (derlenmiş örnek proje varsa)
    const elfDir = 'C:/Users/mehme/AppData/Local/Temp/es-build/t_f103c8_hal_rtos/build/debug/t_f103c8_hal_rtos.elf';
    if (fs.existsSync(elfDir)) {
      const fn = await F.funcAddr(elfDir, ['main', 'Board_Init']);
      assert.ok(fn.main > 0x08000000 && !(fn.main & 1), JSON.stringify(fn));
      const [a, b] = await F.addr2line(elfDir, [fn.main + 4, 0x20000000]);
      assert.ok(a && a.func === 'main' && /main\.c$/.test(a.file) && a.line > 0, JSON.stringify(a));
      assert.ok(!b || !b.file, 'RAM adresi kaynağa çözülmez');
    }
    assert.deepStrictEqual(await F.addr2line('olmayan.elf', [1]), [null]);
    passed++;
    console.log('  ✓ HardFault analizörü (ES-207): CFSR/HFSR çözümü, EXC_RETURN, çerçeve arama, senaryolar, RTOS görevi, addr2line');
  }
  {
    // ES-208: ITM paket çözücü, ITM/DWT ayarı, PC profili, RTT, simülasyonda uçtan uca konsol
    const T = require('../src/debug/trace');
    const { SimTarget, SIM_RTT, explainSwo } = require('../src/debug/session');
    const dec = new T.ItmDecoder();
    // senkron, port 0 'A', port 5 16 bit, kısa ts, taşma, PC örneği, uyku, data trace (karşılaştırıcı 1, yazma, 2 bayt), istisna girişi
    const stream = [0, 0, 0, 0, 0, 0x80, 0x01, 0x41, 0x2a, 0x34, 0x12, 0x30, 0x70, 0x17, 0x44, 0x04, 0x00, 0x08, 0x15, 0x00, 0x9e, 0xcd, 0xab, 0x0e, 0x0f, 0x10];
    // parça parça gelse de aynı sonuç
    const ev = [...dec.push(stream.slice(0, 9)), ...dec.push(stream.slice(9, 15)), ...dec.push(stream.slice(15))];
    assert.deepStrictEqual(ev.map((e) => e.type), ['sync', 'sw', 'sw', 'ts', 'overflow', 'pc', 'pc', 'data', 'exception']);
    assert.strictEqual(ev[1].port, 0); assert.strictEqual(ev[1].value, 0x41);
    assert.strictEqual(ev[2].port, 5); assert.strictEqual(ev[2].value, 0x1234); assert.strictEqual(ev[2].size, 2);
    assert.strictEqual(ev[3].ts, 3);
    assert.strictEqual(ev[5].pc, 0x08000444); assert.ok(ev[6].sleep);
    assert.deepStrictEqual([ev[7].cmp, ev[7].write, ev[7].value, ev[7].size], [1, true, 0xabcd, 2]);
    assert.deepStrictEqual([ev[8].exc, ev[8].fn], [15, 'enter']);
    assert.strictEqual(dec.overflows, 1);
    // uzun zaman damgası ve devam baytları; yarım paket beklenir
    const d2 = new T.ItmDecoder();
    assert.deepStrictEqual(d2.push([0xc0, 0x81]), []);
    assert.strictEqual(d2.push([0x01])[0].ts, 129);
    assert.deepStrictEqual(T.itmTs(129), [0xc0, 0x81, 0x01]);
    assert.strictEqual(T.parsePorts('0,1,5-7'), 0xe3);
    assert.strictEqual(T.parsePorts('0x10'), 0x10);
    assert.ok(Number.isNaN(T.parsePorts('32')) && Number.isNaN(T.parsePorts('a')));
    // PC örnekleme: SWO bant genişliğinin yarısını ve 10 kHz'i geçmez
    const pc = T.pcSampleConfig(100e6, 2e6);
    assert.ok(pc.rate <= 10000 && pc.rate > 5000, JSON.stringify(pc));
    assert.ok(T.pcSampleConfig(16e6, 500e3).rate <= 5000);
    assert.deepStrictEqual(T.swoPrescaler(84e6, 2e6), { acpr: 41, actualHz: 2000000 });
    const w = T.itmSetup({ ports: 3, ts: false, pc, data: [{ addr: 0x20000084, size: 2, pc: true }] });
    const last = (a) => w.filter((x) => x[0] === a).pop()[2];
    assert.strictEqual(last(T.REG.ITM_TER), 3);
    assert.strictEqual(last(T.REG.ITM_TCR), 1 | 4 | 8 | (1 << 16), 'ITMENA | SYNCENA | DWTENA | ATB ID 1');
    assert.ok(last(T.REG.DWT_CTRL) & (1 << 12) && last(T.REG.DWT_CTRL) & 1, 'PCSAMPLENA + CYCCNTENA');
    assert.strictEqual(last(T.REG.DWT_COMP), 0x20000084);
    assert.strictEqual(last(T.REG.DWT_COMP + 8), 3 | (1 << 10), 'PC + veri değeri, yarım word');
    assert.strictEqual(last(T.REG.DWT_LAR), 0xc5acce55);
    // nm çıktısı ve PC → fonksiyon
    const funcs = T.parseFunctions('08000400 00000040 T main\r\n08000441 00000010 t helper\n20000000 00000004 B uwTick\n');
    assert.deepStrictEqual(funcs.map((f) => [f.name, f.addr]), [['main', 0x08000400], ['helper', 0x08000440]]);
    const prof = new T.PcProfile(funcs);
    [0x08000402, 0x0800043e, 0x08000444, 0x09000000].forEach((a) => prof.add(a));
    prof.addSleep();
    const top = prof.top();
    assert.deepStrictEqual(top.map((r) => [r.name, r.count]), [['main', 2], ['helper', 1], ['0x09000000', 1], ['(uyku: WFI/WFE)', 1]]);
    assert.strictEqual(top[0].pct, 40);
    assert.ok(/0.11/.test(explainSwo('invalid command name "tpiu"')));
    // RTT: simülasyondaki kontrol bloğu RAM taramasıyla bulunur, okunur, down kanalına yazılanı firmware yankılar
    const model = { peripherals: [], expected: new Map(), dynamic: new Map() };
    const sim = new SimTarget(model);
    const rtt = new T.RttClient(sim);
    const found = await rtt.find({ ramStart: 0x20000000, ramSize: 0x4000 });
    assert.strictEqual(found.addr, SIM_RTT.cb);
    assert.deepStrictEqual(found.channels.map((c) => [c.dir, c.index, c.name, c.size]), [['up', 0, 'Terminal', 512], ['down', 0, 'Terminal', 64]]);
    await assert.rejects(() => new T.RttClient(sim).find({ ramStart: 0x20002000, ramSize: 0x1000 }), /bulunamadı/);
    const text = async () => Buffer.concat((await rtt.poll()).map((x) => Buffer.from(x.bytes))).toString();
    assert.ok(/uwTick=0 /.test(await text()), 'ilk satır');
    assert.strictEqual(await text(), '', 'okunan tekrar gelmez (RdOff ilerledi)');
    assert.strictEqual(await rtt.write(0, Buffer.from('ping\n')), 5);
    assert.ok((await text()).includes('> echo: ping'), 'down → firmware → up');
    assert.strictEqual(await rtt.write(0, Buffer.alloc(100, 0x41)), 63, 'dolu tampon taşmaz (boyut - 1)');
    // halka sınırında okuma
    const up = SIM_RTT.cb + 24;
    model.expected.set(up + 16, 510); model.expected.set(up + 12, 2);
    [0x61, 0x62].forEach((b, k) => sim.setByte(SIM_RTT.upBuf + 510 + k, b));
    [0x63, 0x64].forEach((b, k) => sim.setByte(SIM_RTT.upBuf + k, b));
    sim.halted = true; // firmware yeni satır yazmasın
    assert.strictEqual(await text(), 'abcd');
    sim.halted = false;
    // Uçtan uca: SWO (port 0/1, profil, data trace), RTT, semihosting → webview mesajları
    const msgs = [];
    const sim2 = new SimTarget({ peripherals: [], expected: new Map(), dynamic: new Map([[0x20000084, (ms) => Math.floor(ms / 40)]]) });
    const ts = new T.TraceSession(sim2, (m) => msgs.push(m));
    await assert.rejects(() => ts.startSwo({ cpuHz: 1e6, swoHz: 2e6, ports: 1 }), /büyük olamaz/);
    await ts.startSwo({ cpuHz: 100e6, swoHz: 2e6, ports: 0x3, pc: true, data: [{ name: 'adc_raw', addr: 0x20000084, size: 2 }], funcs: T.SIM_FUNCS });
    await ts.startRtt({ ramStart: 0x20000000, ramSize: 0x2000, intervalMs: 20 });
    await ts.semihosting(true);
    await new Promise((r) => setTimeout(r, 1700));
    await ts.rttSend(0, 'hi');
    await new Promise((r) => setTimeout(r, 250));
    ts.postProfile();
    await ts.dispose();
    const out = {};
    for (const it of msgs.filter((m) => m.type === 'debug.console').flatMap((m) => m.items)) out[it.src + it.ch] = (out[it.src + it.ch] || '') + it.text;
    assert.ok(/^uwTick=0 adc_raw=2048/.test(out.itm0) && out.itm0.split('\n').length >= 4, out.itm0);
    assert.ok(/heartbeat #1/.test(out.itm1), 'port 1');
    assert.ok(/> echo: hi/.test(out.rtt0) && /semihosting: printf #1/.test(out.semi0), JSON.stringify(out));
    const prof2 = msgs.filter((m) => m.type === 'debug.profile').pop();
    assert.ok(prof2.total > 1000 && prof2.rows.some((r) => r.name === 'HAL_Delay') && prof2.rows.every((r) => !/^0x/.test(r.name)), JSON.stringify(prof2.rows.slice(0, 3)));
    const dt = msgs.filter((m) => m.type === 'debug.dtrace').flatMap((m) => m.items);
    assert.ok(dt.length >= 10 && dt.every((x) => x.name === 'adc_raw' && x.write) && dt[dt.length - 1].value > dt[0].value, JSON.stringify(dt.slice(0, 2)));
    const st = msgs.filter((m) => m.type === 'debug.trace').pop();
    assert.deepStrictEqual([st.swo, st.rtt, st.semi], [false, null, false], 'dispose her şeyi kapatır');
    assert.strictEqual(sim2.model.expected.get(T.REG.DWT_CTRL), 0, 'PC örnekleme kapatıldı');
    // es_trace sürücüsü: RTT bloğu, _write, M0'da ITM yok; Cortex-Debug SWO/RTT blokları
    const rd = require('../src/codegen/regdrivers');
    const tf = rd.regDriverFiles(lib.mcus.stm32f411ceu6, ['trace'], computeClock(lib.mcus.stm32f411ceu6, lib.mcus.stm32f411ceu6.clock.default));
    assert.ok(tf['es_trace.c'].includes('es_rtt_cb_t _SEGGER_RTT;') && tf['es_trace.c'].includes('int _write(int fd') && tf['es_trace.c'].includes('ITM->PORT[port].u8'));
    const tm0 = rd.regDriverFiles(lib.mcus.stm32f030c8t6, ['trace'], computeClock(lib.mcus.stm32f030c8t6, lib.mcus.stm32f030c8t6.clock.default));
    assert.ok(!tm0['es_trace.c'].includes('ITM->') && tm0['es_trace.c'].includes('ITM yok'));
    const L = require('../src/debug/launch');
    const base = { name: 'x', elf: 'a.elf', cwd: '.', mcuName: 'STM32F411CEU6', targetCfg: 'target/stm32f4x.cfg' };
    const lc = L.cortexConfig({ ...base, cpuHz: 100e6 });
    assert.deepStrictEqual([lc.swoConfig.enabled, lc.swoConfig.cpuFrequency, lc.rttConfig.address], [false, 100e6, 'auto']);
    assert.ok(!L.cortexConfig({ ...base, cpuHz: 48e6, swo: false }).swoConfig, 'M0: SWO yok');
    assert.ok(!L.cortexConfig(base).rttConfig, 'cpuHz yoksa eklenmez');
    passed++;
    console.log('  ✓ SWO/ITM, RTT, semihosting (ES-208): paket çözücü, ITM/DWT ayarı, PC profili, RTT halkası, uçtan uca simülasyon, es_trace');
  }
  {
    // ES-209: FreeRTOS yapılandırması → yerleşim, simülasyon çekirdeği, okuyucu, bağlam ve çağrı zinciri
    const R = require('../src/debug/rtos');
    const T = require('../src/debug/trace');
    const { SimTarget } = require('../src/debug/session');
    const cfg = R.parseConfig('#define configMAX_TASK_NAME_LEN  ( 12 ) /* ad */\n#define configTOTAL_HEAP_SIZE ((size_t)13312)\n#define configUSE_MUTEXES 1U\n// #define configUSE_TRACE_FACILITY 1\n#define configCPU_CLOCK_HZ (SystemCoreClock)\n');
    assert.deepStrictEqual(cfg, { configMAX_TASK_NAME_LEN: 12, configTOTAL_HEAP_SIZE: 13312, configUSE_MUTEXES: 1 });
    // V11 tasks.c / gdb ptype/o ile doğrulanmış ofsetler
    const L0 = R.tcbLayout({ configUSE_TRACE_FACILITY: 1, configUSE_MUTEXES: 1, configGENERATE_RUN_TIME_STATS: 1 });
    assert.deepStrictEqual([L0.name, L0.tcbNum, L0.basePrio, L0.mutexes, L0.runTime, L0.end], [52, 68, 76, 80, 84, undefined]);
    const L1 = R.tcbLayout(R.DEFAULT_CONFIG);
    assert.deepStrictEqual([L1.end, L1.runTime], [68, 88]);
    assert.strictEqual(R.tcbLayout({ configMAX_TASK_NAME_LEN: 10 }).size, 64, 'ad 4 bayta hizalanır');
    assert.strictEqual(R.queueLayout({ configUSE_TRACE_FACILITY: 1 }).type, 76);
    assert.strictEqual(R.queueLayout({ configUSE_TRACE_FACILITY: 1, configSUPPORT_STATIC_ALLOCATION: 1, configUSE_QUEUE_SETS: 1 }).type, 80);
    assert.throws(() => R.tcbLayout({ portUSING_MPU_WRAPPERS: 1 }), /MPU/);
    assert.ok(R.precededByCall((a) => ({ 0x100: 0xf000, 0x102: 0xf800 })[a], 0x104), 'BL');
    assert.ok(R.precededByCall((a) => ({ 0x102: 0x4798 })[a], 0x104), 'BLX r3');
    assert.ok(!R.precededByCall((a) => ({ 0x100: 0xbf00, 0x102: 0xbf00 })[a], 0x104), 'NOP');
    // Simülasyon çekirdeği: üç çekirdek düzeninde (CM0 V11, CM4F, CM33) bağlam ve çağrı zinciri
    for (const core of ['cortex-m4', 'cortex-m0plus', 'cortex-m33']) {
      const sim = new SimTarget({ peripherals: [], expected: new Map(), dynamic: new Map() });
      const syms = R.simKernel(sim, { names: ['BME280_1', 'MPU6050_1', 'SSD1306_1'], core, funcs: T.SIM_FUNCS });
      const rd = new R.RtosReader(sim, { syms: R.symbolMap(syms), core });
      await rd.snapshot();
      await new Promise((r) => setTimeout(r, 120));
      const s = await rd.snapshot();
      const by = Object.fromEntries(s.tasks.map((x) => [x.name, x]));
      assert.deepStrictEqual(Object.keys(by).sort(), ['BME280_1', 'IDLE', 'MPU6050_1', 'Monitor', 'SSD1306_1']);
      assert.strictEqual(s.tasks[s.tasks.length - 1].name, 'IDLE', 'önceliğe göre sıralı');
      assert.strictEqual(by.MPU6050_1.state, 'suspended');
      assert.ok(['running', 'ready'].includes(by.IDLE.state) && s.tasks.filter((x) => x.state === 'running').length === 1);
      assert.deepStrictEqual(by.SSD1306_1.waiting, { name: 'lock_I2C1', dir: 'recv', type: 'mutex' });
      assert.strictEqual(by.BME280_1.mutexesHeld, 1);
      assert.ok(Math.abs(s.tasks.reduce((a, x) => a + x.cpu, 0) - 100) < 0.01 && by.IDLE.cpu > 40, JSON.stringify(s.tasks.map((x) => x.cpu)));
      assert.deepStrictEqual([by.Monitor.stackSize, by.SSD1306_1.freeMin], [1024, 24]);
      assert.ok(by.Monitor.used > 0 && by.Monitor.freeMin === by.Monitor.stackSize - by.Monitor.used, 'tepe = şu anki kullanım (dolgu bozulmamış)');
      assert.deepStrictEqual(s.queues.map((q) => [q.name, q.type]), [['SensorQ', 'queue'], ['lock_I2C1', 'mutex'], ['DataReady', 'binary']]);
      assert.deepStrictEqual([s.queues[1].holderName, s.queues[1].receiversNames], ['BME280_1', ['SSD1306_1']]);
      assert.deepStrictEqual(s.timers.map((x) => [x.name, x.period, x.autoReload]), [['Blink', 500, true], ['Watchdog', 2000, false]]);
      assert.deepStrictEqual(s.warnings.map((w) => [w.level, w.task || 'heap']), [['warn', 'SSD1306_1'], ['warn', 'heap']]);
      const task = by.MPU6050_1;
      const ctx = await R.taskContext(sim, task, core);
      const prof = new T.PcProfile(T.SIM_FUNCS);
      assert.strictEqual(prof.lookup(ctx.regs.pc), 'sensor_read', core);
      const bt = await R.backtrace(sim, ctx.regs, task.stackEnd + 4, (a) => prof.lookup(a), null);
      assert.deepStrictEqual(bt.map((f) => f.func), ['sensor_read', 'HAL_Delay', 'App_Loop', 'main'], core);
    }
    // Taşma: dolgunun ilk word'ü bozulunca hata; heap tükenince hata
    {
      const sim = new SimTarget({ peripherals: [], expected: new Map(), dynamic: new Map() });
      const rd = new R.RtosReader(sim, { syms: R.symbolMap(R.simKernel(sim, { names: ['A'], funcs: T.SIM_FUNCS })) });
      let s = await rd.snapshot();
      const a = s.tasks.find((x) => x.name === 'A');
      await sim.writeMemory(a.pxStack, 32, 0x12345678);
      s = await rd.snapshot();
      assert.ok(s.tasks.find((x) => x.name === 'A').overflow && s.warnings[0].level === 'error' && /taşmış/.test(s.warnings[0].text));
      assert.deepStrictEqual(R.warnings({ tasks: [], heap: { free: 0, minEver: 0, total: 100 } }).map((w) => w.level), ['error']);
    }
    // Çalışan görev, durdurulmuşken: çekirdek register'ları; işleyicide PSP çerçevesi
    {
      const sim = new SimTarget({ peripherals: [], expected: new Map(), dynamic: new Map() });
      const fr = [1, 2, 3, 4, 5, 0x08000a01, 0x08000660, 0x01000000];
      fr.forEach((v, i) => sim.model.expected.set(0x20003000 + i * 4, v));
      const c1 = await R.taskContext(sim, {}, 'cortex-m4', { pc: 0x08000400, lr: 0x08000501, sp: 0x20002000, xPSR: 0x01000000, psp: 0x20003000 });
      assert.deepStrictEqual([c1.layout, c1.regs.pc], ['core', 0x08000400]);
      const c2 = await R.taskContext(sim, {}, 'cortex-m4', { pc: 0x08000c10, lr: 0xfffffffd, sp: 0x2001ff00, xPSR: 0x0100000f, psp: 0x20003000 });
      assert.deepStrictEqual([c2.layout, c2.regs.pc, c2.regs.sp], ['psp', 0x08000660, 0x20003020]);
    }
    // Üretilen proje: kuyruk kaydı ve yığın üst adresi
    {
      const d = design([inst('bme280'), inst('led')], { rtos: true });
      const files = generate(d, lib, assign(d, lib), computeClock(mcu, d.clock), {}).files;
      const conf = files.find((f) => f.path.endsWith('FreeRTOSConfig.h')).content;
      const c = R.parseConfig(conf);
      assert.deepStrictEqual([c.configRECORD_STACK_HIGH_ADDRESS, c.configQUEUE_REGISTRY_SIZE], [1, 8]);
      assert.ok(files.some((f) => /vQueueAddToRegistry\(lock_I2C1, "lock_I2C1"\)/.test(f.content)) && files.some((f) => f.content.includes('vQueueAddToRegistry(tx_lock, "tx_lock")')));
    }
    // Derlenmiş gerçek proje varsa: TCB/Queue ofsetleri gdb'nin DWARF çıktısıyla aynı, ELF'ten kod okunur
    const built = 'C:/Users/mehme/AppData/Local/Temp/es-build/t_f407vg_hal_rtos';
    const elf = path.join(built, 'build/debug/t_f407vg_hal_rtos.elf');
    if (fs.existsSync(elf)) {
      const gdb = await new Promise((resolve) => require('child_process').execFile('arm-none-eabi-gdb', ['-batch', '-ex', 'ptype/o TCB_t', '-ex', 'ptype/o Queue_t', elf], { windowsHide: true }, (e, out) => resolve(e ? '' : out)));
      if (gdb) {
        const off = (field) => Number((new RegExp(`/\\*\\s+(\\d+)\\s+\\|\\s+\\d+ \\*/\\s+[^;]*\\b${field}\\b`).exec(gdb) || [])[1]);
        const pc = R.parseConfig(fs.readFileSync(path.join(built, 'Core/Inc/FreeRTOSConfig.h'), 'utf8'));
        const L = R.tcbLayout(pc), Q = R.queueLayout(pc);
        assert.deepStrictEqual([off('pcTaskName'), off('uxPriority'), off('pxStack'), off('ulRunTimeCounter'), off('uxMutexesHeld')], [L.name, L.prio, L.stack, L.runTime, L.mutexes], gdb.slice(0, 600));
        if (pc.configRECORD_STACK_HIGH_ADDRESS) assert.strictEqual(off('pxEndOfStack'), L.end);
        assert.deepStrictEqual([off('uxMessagesWaiting'), off('ucQueueType')], [Q.waiting, Q.type]);
      }
      const code = R.elfCode(elf);
      const main = (await T.functionSymbols(elf)).find((f) => f.name === 'main');
      assert.ok(code && code(main.addr) !== undefined && code(0x30000000) === undefined, 'ELF kodu okunur');
    }
    passed++;
    console.log('  ✓ FreeRTOS farkındalıklı debug (ES-209): yapılandırma → TCB/Queue yerleşimi, görev durumu, yığın tepe değeri, CPU %, kuyruk/mutex, zamanlayıcı, uyarılar, call stack');
  }
  {
    // ES-210: Build Analyzer — map, ELF, bölge kullanımı, dosyalar, fark, yığın grafiği, derleme bayrakları
    const A = require('../src/analyzer');
    const mapText = [
      'Memory Configuration', '', 'Name             Origin             Length             Attributes',
      'FLASH            0x08000000         0x00080000         xr', 'RAM              0x20000000         0x00020000         xrw',
      '*default*        0x00000000         0xffffffff', '', 'Linker script and memory map', '',
      '.text           0x08000000      0x200', ' .text.main     0x08000000       0x40 CMakeFiles/app.dir/Core/Src/main.c.obj',
      '                0x08000000                main', ' .text.a_very_long_function_name_here',
      '                0x08000040       0x80 CMakeFiles/app.dir/Core/Src/board.c.obj', ' *fill*         0x080000c0        0x4 ',
      ' .text          0x080000c4       0x30 C:/gcc/lib/thumb/libc_nano.a(lib_a-memcpy.o)',
      ' .text          0x080000f4       0x20 C:/gcc/lib/thumb/libc_nano.a(lib_a-memset.o)',
      ' .data.counter  0x20000000        0x4 CMakeFiles/app.dir/Core/Src/main.c.obj',
      ' .bss.buf       0x20000004      0x100 CMakeFiles/app.dir/Core/Src/board.c.obj', ' COMMON         0x20000104       0x10 CMakeFiles/app.dir/Core/Src/main.c.obj'
    ].join('\n');
    const map = A.parseMap(mapText);
    assert.deepStrictEqual(map.regions.map((r) => [r.name, r.length]), [['FLASH', 0x80000], ['RAM', 0x20000]]);
    assert.deepStrictEqual(map.inputs.map((x) => [x.section, x.size]), [['.text.main', 0x40], ['.text.a_very_long_function_name_here', 0x80], ['.text', 0x30], ['.text', 0x20], ['.data.counter', 4], ['.bss.buf', 0x100], ['COMMON', 0x10]]);
    const files = A.fileList(map.inputs, map.regions);
    assert.deepStrictEqual(files.map((f) => [f.name, f.flash, f.ram, f.members]), [['Core/Src/board.c', 0x80, 0x100, 0], ['Core/Src/main.c', 0x44, 0x14, 0], ['libc_nano.a', 0x50, 0, 2]]);
    // Bölge kullanımı: .data hem RAM'de hem flash'ta (LMA); .bss yalnızca RAM'de
    const secs = [
      { name: '.text', type: 1, flags: 6, addr: 0x08000000, lma: 0x08000000, size: 0x200 },
      { name: '.data', type: 1, flags: 3, addr: 0x20000000, lma: 0x08000200, size: 0x10 },
      { name: '.bss', type: 8, flags: 3, addr: 0x20000010, lma: 0x08000210, size: 0x100 },
      { name: '.debug_info', type: 1, flags: 0, addr: 0, lma: 0, size: 999 }
    ];
    const ru = A.regionUsage(secs, map.regions);
    assert.deepStrictEqual(ru.map((r) => [r.name, r.used, r.flash]), [['FLASH', 0x210, true], ['RAM', 0x110, false]]);
    assert.deepStrictEqual(ru[0].parts, [{ name: '.text', size: 0x200 }, { name: '.data', size: 0x10, load: true }]);
    assert.deepStrictEqual(A.sectionList(secs, map.regions).map((s) => [s.name, s.kind, s.loadRegion]), [['.text', 'code', ''], ['.data', 'data', 'FLASH'], ['.bss', 'bss', '']]);
    assert.deepStrictEqual(A.shortFile('C:/x/CMakeFiles/app.dir/__/lib/x.c.obj'), { name: '../lib/x.c', lib: false });
    // Önceki derlemeye göre fark
    const s1 = A.snapshot('a', ru, [{ name: 'main', kind: 'func', size: 64 }, { name: 'old', kind: 'func', size: 8 }, { name: 'buf', kind: 'data', size: 256 }]);
    const s2 = A.snapshot('b', ru.map((r) => ({ ...r, used: r.used + (r.flash ? 100 : 0) })), [{ name: 'main', kind: 'func', size: 160 }, { name: 'buf', kind: 'data', size: 256 }, { name: 'neu', kind: 'data', size: 4 }]);
    const df = A.diffSnapshots(s1, s2);
    assert.deepStrictEqual(df.regions.map((r) => [r.name, r.delta]), [['FLASH', 100], ['RAM', 0]]);
    assert.deepStrictEqual(df.symbols.map((x) => [x.name, x.delta, x.status]), [['main', 96, 'changed'], ['old', -8, 'removed'], ['neu', 4, 'new']]);
    assert.strictEqual(A.diffSnapshots(null, s2), null);
    // Yığın: .su ve .ci (static "dosya:ad", weak tanım, özyineleme, dolaylı ve kütüphane çağrısı)
    assert.deepStrictEqual(A.parseStackUsage('C:/p/main.c:7:5:main\t8\tstatic\nC:/p/x.c:5:5:dyn\t16\tdynamic,bounded\n'), [
      { file: 'C:/p/main.c', line: 7, name: 'main', bytes: 8, qual: 'static' }, { file: 'C:/p/x.c', line: 5, name: 'dyn', bytes: 16, qual: 'dynamic,bounded' }]);
    const g1 = A.parseCallgraph(`graph: { title: "a.c"
node: { title: "a.c:leaf" label: "leaf\\na.c:2:12\\n32 bytes (static)" }
node: { title: "mid" label: "mid\\na.c:3:5\\n72 bytes (static)" }
node: { title: "HAL_GetTick" label: "HAL_GetTick\\nhal.h:9:10" shape : ellipse }
node: { title: "memcpy" label: "memcpy\\nstring.h:1:1" shape : ellipse }
edge: { sourcename: "mid" targetname: "a.c:leaf" label: "a.c:3:65" }
edge: { sourcename: "mid" targetname: "HAL_GetTick" label: "a.c:3:70" }
edge: { sourcename: "mid" targetname: "memcpy" label: "a.c:3:80" }
node: { title: "rec" label: "rec\\na.c:4:5\\n8 bytes (static)" }
edge: { sourcename: "rec" targetname: "rec" label: "a.c:4:29" }
node: { title: "Task_A" label: "Task_A\\na.c:9:6\\n16 bytes (dynamic)" }
node: { title: "__indirect_call" label: "Indirect Call Placeholder" shape : ellipse }
edge: { sourcename: "Task_A" targetname: "mid" label: "a.c:9:20" }
edge: { sourcename: "Task_A" targetname: "rec" label: "a.c:9:30" }
edge: { sourcename: "Task_A" targetname: "__indirect_call" label: "a.c:9:40" }
}`);
    const g2 = A.parseCallgraph('node: { title: "hal.c:HAL_GetTick" label: "HAL_GetTick\\nhal.c:5:17\\n40 bytes (static)" }');
    assert.deepStrictEqual(g1.nodes[0], { id: 'a.c:leaf', name: 'leaf', file: 'a.c', line: 2, bytes: 32, qual: 'static', external: false });
    const rep = Object.fromEntries(A.stackReport([g1, g2]).map((f) => [f.name, f]));
    assert.deepStrictEqual([rep.mid.worst, rep.mid.path, rep.mid.unknown], [112, ['mid', 'HAL_GetTick'], ['memcpy']], 'weak tanım ada göre bulunur');
    assert.deepStrictEqual([rep.Task_A.worst, rep.Task_A.root, rep.Task_A.recursive, rep.Task_A.indirect, rep.Task_A.dynamic], [128, true, true, true, true]);
    assert.deepStrictEqual([rep.leaf.root, rep.rec.recursive, rep.HAL_GetTick.root], [false, true, false]);
    // Derleme bayrakları: varsayılan açık, kapatılabilir; GCC'ye özgü bayrak koşullu
    const cmB = require('../src/codegen/build');
    assert.strictEqual(cmB.normalizeBuild({}).stackUsage, true);
    assert.strictEqual(cmB.normalizeBuild({ stackUsage: false }).stackUsage, false);
    const gen = (b) => generate({ ...design([inst('led')]), build: b }, lib, assign(design([inst('led')]), lib), computeClock(mcu, mcu.clock.default), {}).files.find((f) => f.path === 'cmake/embedded-studio.cmake').content;
    assert.ok(gen({}).includes('-fstack-usage $<$<C_COMPILER_ID:GNU>:-fcallgraph-info=su>'));
    assert.ok(!gen({ stackUsage: false }).includes('-fstack-usage'));
    // Gerçek derleme varsa: ELF + map bölge kullanımı linker'ın --print-memory-usage değerleriyle aynı; yığın grafiği
    const bdir = 'C:/Users/mehme/AppData/Local/Temp/es-build/t_hal_rtos/build/debug';
    const belf = path.join(bdir, 't_hal_rtos.elf');
    if (fs.existsSync(belf)) {
      const e = A.readElf(fs.readFileSync(belf));
      const m = A.parseMap(fs.readFileSync(belf.replace(/\.elf$/, '.map'), 'utf8'));
      const used = Object.fromEntries(A.regionUsage(e.sections, m.regions).map((r) => [r.name, r.used]));
      // size -A: RAM adresli bölümlerin toplamı (Berkeley biçimi .init_array'i "data" sayıp RAM'e de ekler)
      const sizeA = await new Promise((r) => require('child_process').execFile('arm-none-eabi-size', ['-A', belf], (err, out) => r(out)));
      const ramA = sizeA.split(/\r?\n/).map((l) => l.trim().split(/\s+/)).filter((x) => Number(x[2]) >= 0x20000000).reduce((a, x) => a + Number(x[1]), 0);
      const size = require('../src/toolchain').parseSize(await new Promise((r) => require('child_process').execFile('arm-none-eabi-size', [belf], (err, out) => r(out))));
      assert.deepStrictEqual([used.FLASH, used.RAM], [size.flash, ramA], JSON.stringify(used));
      const syms = A.symbolList(e, m.regions);
      assert.ok(syms.find((s) => s.name === 'main' && s.kind === 'func' && s.region === 'FLASH') && syms.find((s) => s.name === 'ucHeap' && s.kind === 'data' && s.region === 'RAM'));
      assert.ok(A.fileList(m.inputs, m.regions).some((f) => f.name === 'Core/Src/main.c'));
      const st = A.stackFromDir(bdir);
      if (st) {
        const main = st.functions.find((f) => f.name === 'main');
        assert.ok(st.graph && main.root && main.worst > main.own && main.path[0] === 'main', JSON.stringify(main));
        assert.ok(st.functions.find((f) => f.name === 'Task_Monitor').root, 'görev giriş noktası');
      }
    }
    passed++;
    console.log('  ✓ Build Analyzer (ES-210): map bölgeleri ve girdiler, ELF section/sembol, bölge kullanımı, dosya katkısı, fark, yığın grafiği, -fstack-usage');
  }
  {
    // ES-211: seri port terminali — port listesi, ayarlar, stty, hata açıklamaları, simülasyon aygıtı, log
    const S = require('../src/monitor/serial');
    assert.deepStrictEqual(S.parseRegPorts('\r\nHKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM\r\n    \\Device\\USBSER000    REG_SZ    COM12\r\n    \\Device\\Serial0    REG_SZ    COM1\r\n    \\Device\\VCP0    REG_SZ    COM5\r\n'), ['COM1', 'COM5', 'COM12']);
    assert.deepStrictEqual(S.parseRegPorts(''), []);
    assert.throws(() => S.normalizeOptions({ path: 'COM3', baud: 'abc' }), /baud/);
    assert.deepStrictEqual(S.normalizeOptions({ path: 'COM3', baud: '9600', dataBits: 9, parity: 'x', stopBits: 3, flow: 'y' }),
      { path: 'COM3', baud: 9600, dataBits: 8, parity: 'none', stopBits: '1', flow: 'none', dtr: true, rts: true });
    const st = (o, mac) => S.sttyArgs({ path: '/dev/ttyACM0', baud: 115200, dataBits: 8, parity: 'none', stopBits: '1', flow: 'none', ...o }, mac).join(' ');
    assert.strictEqual(st({}, false), '-F /dev/ttyACM0 115200 raw -echo -echoe -echok cs8 clocal -hupcl -parenb -cstopb -crtscts -ixon -ixoff');
    assert.ok(st({ parity: 'odd', stopBits: '2', flow: 'rtscts', dataBits: 7 }, true).startsWith('-f /dev/ttyACM0 115200 raw -echo -echoe -echok cs7') && st({ parity: 'odd', stopBits: '2', flow: 'rtscts' }, true).includes('parenb parodd cstopb crtscts'));
    assert.ok(st({ parity: 'space' }, false).includes('parenb -parodd cmspar') && st({ flow: 'xonxoff' }, false).includes('ixon ixoff'));
    assert.ok(/kullanılıyor/.test(S.explainOpen("UnauthorizedAccessException: Access to the port 'COM5' is denied.", 'COM5')));
    assert.ok(/bulunamadı/.test(S.explainOpen("IOException: The port 'COM9' does not exist.", 'COM9')));
    assert.strictEqual(S.clock(new Date(2026, 0, 1, 9, 5, 7, 42).getTime()), '09:05:07.042');
    const ports = await S.listPorts();
    assert.deepStrictEqual(ports[ports.length - 1], { path: 'SIM', name: 'Simülasyon (kart yok)', sim: true });
    // Simülasyon aygıtı: karşılama, komut yanıtı, HEX döküm, DTR ile yeniden başlama, yanlış baud'da bozuk veri
    const sess = new S.SerialSession({ path: 'SIM', baud: 115200 });
    let rx = Buffer.alloc(0);
    sess.on('data', (b) => { rx = Buffer.concat([rx, b]); });
    await sess.open();
    assert.ok(sess.isOpen && /demo firmware/.test(rx.toString()));
    sess.write(Buffer.from('ver\r\nled on\r\n'));
    sess.write(Buffer.from('dump\n'));
    assert.ok(/fw 1\.2\.0/.test(rx.toString()) && /OK led on/.test(rx.toString()));
    assert.ok(rx.includes(Buffer.from([0xaa, 0x55, 0x01, 0x10, 0, 1, 2])), 'ikili döküm');
    rx = Buffer.alloc(0);
    sess.signals(false, true); sess.signals(true, true);
    assert.ok(/demo firmware/.test(rx.toString()), 'DTR düşüp kalkınca yeniden başlar');
    let closed = false;
    sess.on('close', () => { closed = true; });
    await sess.close();
    assert.ok(closed && !sess.isOpen);
    assert.throws(() => sess.write(Buffer.from('x')), /açık değil/);
    const bad = new S.SerialSession({ path: 'SIM', baud: 9600 });
    let junk = Buffer.alloc(0);
    bad.on('data', (b) => { junk = Buffer.concat([junk, b]); });
    await bad.open();
    assert.ok(junk.length > 20 && !/firmware/.test(junk.toString('latin1')), 'yanlış baud: okunamaz bayt');
    await bad.close();
    // Log: metin (yerel saat damgası, gönderilen "> "), ham (yalnızca gelen baytlar)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'es-serial-'));
    const lt = new S.SerialLog(path.join(dir, 'a.log'), 'text');
    const at = new Date(2026, 0, 1, 10, 0, 0, 5).getTime();
    lt.write('rx', Buffer.from('hel'), at); lt.write('rx', Buffer.from('lo\r\nwor'), at); lt.write('tx', Buffer.from('ver\r\n'), at); lt.write('rx', Buffer.from('ld\n'), at);
    await lt.close();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'a.log'), 'utf8'), '[10:00:00.005] hello\n[10:00:00.005] wor\n[10:00:00.005] > ver\n[10:00:00.005] ld\n');
    const lr = new S.SerialLog(path.join(dir, 'a.bin'), 'raw');
    lr.write('rx', Buffer.from([0, 1, 255])); lr.write('tx', Buffer.from('x')); lr.write('rx', Buffer.from([7]));
    await lr.close();
    assert.deepStrictEqual([...fs.readFileSync(path.join(dir, 'a.bin'))], [0, 1, 255, 7]);
    fs.rmSync(dir, { recursive: true, force: true });
    // Windows yardımcısı: derlenir, olmayan portta anlaşılır hata (gerçek veri alışverişi kart gerektirir)
    if (process.platform === 'win32') {
      const w = new S.SerialSession({ path: 'COM250', baud: 115200 });
      await assert.rejects(() => w.open(), /COM250 bulunamadı/);
      assert.ok(!w.isOpen && w.proc === null);
    }
    passed++;
    console.log('  ✓ Seri port terminali (ES-211): port listesi, ayarlar, stty, hata açıklamaları, simülasyon aygıtı, log, Windows yardımcısı');
  }
  {
    // ES-301: programlayıcı
    const pg = require('../src/debug/programmer');
    const { toIntelHex } = require('../src/debug/memory');
    for (const m of Object.values(lib.mcus)) {
      const l = pg.flashLayout(m);
      assert.strictEqual(l.reduce((n, s) => n + s.size, 0), m.device.flashKB * 1024, `${m.id}: sektör toplamı`);
      assert.ok(l.every((s, i) => i === 0 || s.addr === l[i - 1].addr + l[i - 1].size), `${m.id}: bitişik`);
      // Fabrika değerleri: RDP 0, yazma koruması yok
      const spec = pg.obSpec(m);
      assert.ok(spec, `${m.id}: option byte tanımı`);
      const ob = pg.decodeOptionBytes(m, spec.sim, l);
      assert.strictEqual(ob.rdp.level, 0, `${m.id}: RDP`);
      assert.deepStrictEqual(ob.wrp, [], `${m.id}: WRP`);
    }
    const h743 = pg.flashLayout(lib.mcus.stm32h743zit6);
    assert.deepStrictEqual([h743[8].bank, h743[8].num, h743[8].addr], [1, 0, 0x08100000], 'H7: ikinci bank ayrı OpenOCD bankası');
    const l476 = pg.flashLayout(lib.mcus.stm32l476rgt6);
    assert.deepStrictEqual([l476[256].bank, l476[256].num, l476[256].phys, l476[256].addr], [0, 256, 2, 0x08080000], 'L4: tek OpenOCD bankında sıralı');
    // OpenOCD flash info
    const info = pg.parseFlashInfo('#0 : stm32f2x at 0x08000000, size 0x00080000, buswidth 0, chipwidth 0\n\t#  0: 0x00000000 (0x4000 16kB) not protected\n\t#  1: 0x00004000 (0x4000 16kB) protected\n\t#  4: 0x00010000 (0x10000 64kB) not protected\nSTM32F4xx - Rev: A');
    assert.strictEqual(info.driver, 'stm32f2x');
    assert.deepStrictEqual(info.sectors.map((s) => [s.num, s.addr, s.size, s.protected]), [[0, 0x08000000, 0x4000, false], [1, 0x08004000, 0x4000, true], [4, 0x08010000, 0x10000, false]]);
    assert.strictEqual(pg.parseFlashInfo('flash bank 3 does not exist'), null);
    // Silme aralıkları: bitişik olanlar birleşir, bank sınırında bölünür
    assert.deepStrictEqual(pg.eraseRanges(h743, [0, 1, 2, 5, 7, 8, 9]).map((r) => [r.bank, r.first, r.last]), [[0, 0, 2], [0, 5, 5], [0, 7, 7], [1, 0, 1]]);
    // F411 option byte'lar: sektör 2 ve 5 korumalı, RDP 1 / 2, BOR, kullanıcı bitleri
    const f411 = lib.mcus.stm32f411ceu6, fl = pg.flashLayout(f411);
    let ob = pg.decodeOptionBytes(f411, { OPTCR: 0x0fdbbbed, OPTCR1: 0 }, fl);
    assert.deepStrictEqual(ob.wrp, [2, 5]);
    assert.strictEqual(ob.rdp.level, 1);
    assert.match(ob.bor, /kapalı/);
    assert.deepStrictEqual(ob.user.map((u) => [u.name, u.value]), [['WDG_SW', 1], ['nRST_STOP', 1], ['nRST_STDBY', 1]]);
    assert.strictEqual(pg.decodeOptionBytes(f411, { OPTCR: 0x0fffcced }, fl).rdp.level, 2);
    ob = pg.decodeOptionBytes(f411, { OPTCR: 0x8001aaed }, fl);
    assert.deepStrictEqual([ob.wrp, ob.pcrop], [[], [0]], 'SPRMOD: PCROP');
    // L476: WRP1A sayfa 3–5, WRP2A ikinci bankın 0–1. sayfası
    const l4 = lib.mcus.stm32l476rgt6;
    ob = pg.decodeOptionBytes(l4, { ...pg.obSpec(l4).sim, WRP1AR: 0x00050003, WRP2AR: 0x00010000 }, l476);
    assert.deepStrictEqual(ob.wrp, [3, 4, 5, 256, 257]);
    assert.strictEqual(pg.rdpLevel(0x55, 'u5'), 0.5);
    assert.strictEqual(pg.rdpLevel(0x55, 'f4'), 1);
    // F103 WRPR: bit 1 = 0 → sayfa 4–7 korumalı
    ob = pg.decodeOptionBytes(lib.mcus.stm32f103c8t6, { OBR: 0x03fffffe, WRPR: 0xfffffffd }, pg.flashLayout(lib.mcus.stm32f103c8t6));
    assert.deepStrictEqual([ob.wrp, ob.rdp.level], [[4, 5, 6, 7], 1]);
    // Intel HEX: memory.toIntelHex ile gidiş-dönüş, 64 KB sınırı, sağlama toplamı hatası
    const img = Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 0xff);
    const back = pg.parseIntelHex(toIntelHex(img, 0x0800ff80));
    assert.strictEqual(back.length, 1);
    assert.strictEqual(back[0].addr, 0x0800ff80);
    assert.deepStrictEqual([...back[0].bytes], [...img]);
    assert.throws(() => pg.parseIntelHex(':0400000001020304F0\n'), /sağlama/);
    // Karşılaştırma
    const dev = Uint8Array.from(img); dev[10] ^= 1; dev[11] ^= 1; dev[200] ^= 1;
    const c = pg.compareImages([{ addr: 0x100, bytes: img }], [{ addr: 0x100, bytes: dev }]);
    assert.deepStrictEqual([c.same, c.diff, c.rangeCount, c.ranges[0], c.first[0].addr], [false, 3, 2, { start: 0x10a, end: 0x10c }, 0x10a]);
    assert.ok(pg.compareImages([{ addr: 0, bytes: img }], [{ addr: 0, bytes: img }]).same);
    assert.ok(pg.compareImages([{ addr: 0, bytes: img }], [{ addr: 0, bytes: new Uint8Array(300).fill(0xff) }]).blankDevice);
    assert.deepStrictEqual(pg.readRange(f411, 'ram', 0, 0), { addr: 0x20000000, length: 128 * 1024 });
    assert.throws(() => pg.readRange(f411, 'custom', NaN, 4), /Adres/);
    // Simülasyon: bank listesi, okuma, silme
    const d411 = design([inst('usb_uart')]);
    const sm = new SimTarget(simModel(d411, lib, assign(d411, lib), computeClock(mcu, d411.clock), builtinStm32f4()));
    const banks = await sm.flashBanks();
    assert.deepStrictEqual(pg.layoutFromBanks(banks).map((s) => s.size), fl.map((s) => s.size));
    assert.strictEqual((await sm.readMemory(0x08000000, 1))[0], 0x20020000, 'vektör tablosu');
    assert.notStrictEqual((await sm.readMemory(0x08000800, 1))[0], 0xffffffff, 'örnek program');
    assert.strictEqual((await sm.readMemory(0x08004000, 1))[0], 0xffffffff, 'boş sektör');
    await sm.eraseSectors(0, 0, 0);
    assert.deepStrictEqual(await sm.readMemory(0x08000000, 2), [0xffffffff, 0xffffffff], 'silindi');
    assert.ok(await sm.state() === 'halted', 'silmeden önce durdurulur');
    passed++;
    console.log('  ✓ Programlayıcı (ES-301): 15 işlemcide sektör haritası ve fabrika option byte\'ları, flash info, silme aralıkları, RDP/WRP/PCROP/BOR, Intel HEX, karşılaştırma, simülasyon');
  }
  {
    // ES-302: sistem bootloader'ı
    const sb = require('../src/debug/sysboot');
    const pg = require('../src/debug/programmer');
    const f411 = lib.mcus.stm32f411ceu6;
    // UART protokolü (AN3155) simülasyonda: GET, GET_ID, yazma/okuma, silme, GO
    const { boot, dev } = sb.simBoot(f411, 0x431);
    const bt = new sb.BootTarget(boot, f411);
    const info = await bt.connect();
    assert.strictEqual(info.pid, 0x431);
    assert.strictEqual(info.version, 0x31);
    assert.ok(info.commands.includes('EXT_ERASE') && info.commands.includes('GO'));
    await boot.sync(); // zaten senkron: NACK da kabul
    const img = Buffer.from(Array.from({ length: 1030 }, (_, i) => (i * 31 + 7) & 0xff));
    img.fill(0xff, 256, 512); // 0xFF blok atlanır
    await bt.writeFlash(0x08000000, img);
    assert.ok((await bt.readBytes(0x08000000, 1030)).equals(img), 'yazılan okunur');
    assert.strictEqual(dev.log.filter((c) => c === 'WRITE').length, 4, '256 baytlık bloklar, 0xFF bloğu atlandı');
    assert.strictEqual((await bt.readMemory(0x08000000, 1))[0], img.readUInt32LE(0));
    // Silmeden yazma: flash bitleri yalnızca 1 → 0
    await bt.writeFlash(0x08000000, Buffer.from([0x0f, 0xf0, 0, 0]));
    assert.strictEqual((await bt.readBytes(0x08000000, 1))[0], img[0] & 0x0f);
    await bt.eraseSectors(0, 0, 0);
    assert.strictEqual((await bt.readMemory(0x08000000, 1))[0], 0xffffffff, 'sektör 0 silindi');
    // Geçersiz adres → NACK ve anlaşılır hata
    await assert.rejects(() => boot.read(0x60000000, 4), /NACK/);
    await assert.rejects(() => boot.read(0x08000000, 0), /read/);
    // Programlayıcı ile aynı arayüz: flashBanks → sektörler
    assert.deepStrictEqual(pg.layoutFromBanks(await bt.flashBanks()).map((s) => s.size), pg.flashLayout(f411).map((s) => s.size));
    await bt.writeFlash(0x08004000, Buffer.from([1, 2, 3, 4]));
    await bt.reset();
    assert.ok(dev.running, 'GO: uygulama çalışıyor');
    assert.strictEqual(await bt.state(), 'running');
    // Yeniden giriş (BOOT0 = 1 iken reset): aynı sanal cihaz, flash içeriği korunur
    const again = sb.simBoot(f411, 0x431, { dev });
    const bt2 = new sb.BootTarget(again.boot, f411);
    await bt2.connect();
    assert.ok(!dev.running);
    assert.strictEqual((await bt2.readMemory(0x08004000, 1))[0], 0x04030201, 'flash korundu');
    // Eski ERASE (F1) ve H7'nin ikinci bankı
    const f103 = lib.mcus.stm32f103c8t6;
    const s1 = sb.simBoot(f103, 0x410, { legacyErase: true });
    const b1 = new sb.BootTarget(s1.boot, f103);
    await b1.connect();
    await b1.writeFlash(0x08000400, Buffer.alloc(8, 0x11));
    await b1.eraseSectors(0, 1, 1);
    assert.deepStrictEqual([...(await b1.readBytes(0x08000400, 8))], Array(8).fill(0xff));
    assert.ok(s1.dev.log.includes('ERASE') && !s1.dev.log.includes('EXT_ERASE'));
    const h7 = lib.mcus.stm32h743zit6;
    const s7 = sb.simBoot(h7, 0x450);
    const b7 = new sb.BootTarget(s7.boot, h7);
    await b7.connect();
    await b7.writeFlash(0x08100000, Buffer.alloc(4, 0));
    await b7.eraseSectors(1, 0, 0); // bank 2'nin 0. sektörü = bootloader'da 8
    assert.strictEqual((await b7.readMemory(0x08100000, 1))[0], 0xffffffff);
    // Cihaz yokken: senkron zaman aşımı
    const none = new sb.UartBootloader({ write: () => {} });
    await assert.rejects(() => none.sync(2), /Bootloader bulunamadı/);
    // Yanlış baud / parite: çöp bayt
    const junk = new sb.UartBootloader({ write: () => setImmediate(() => junk.feed([0x55])) });
    await assert.rejects(() => junk.sync(1), /Bootloader bulunamadı.*0x55/);
    // DTR / RTS ile giriş ve çıkış: RTS → BOOT0 (etkin = düşük), DTR → NRST
    const sig = [];
    await sb.resetSequence((d, r) => sig.push([d, r]), 'enter', async () => {});
    assert.deepStrictEqual(sig, [[false, false], [true, false], [false, false]], 'BOOT0 yüksek, NRST darbesi');
    sig.length = 0;
    await sb.resetSequence((d, r) => sig.push([d, r]), 'exit', async () => {});
    assert.deepStrictEqual(sig, [[false, true], [true, true], [false, true]], 'BOOT0 düşük, NRST darbesi');
    // USB DFU: dfu-util çıktıları ve komutları
    const list = sb.parseDfuList('dfu-util 0.11\nFound DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-2", alt=1, name="@Option Bytes  /0x1FFFC000/01*016 e", serial="3276365C3430"\nFound DFU: [0483:df11] ver=2200, devnum=5, cfg=1, intf=0, path="1-2", alt=0, name="@Internal Flash  /0x08000000/04*016Kg,01*064Kg,03*128Kg", serial="3276365C3430"\n');
    assert.strictEqual(list.length, 2);
    assert.ok(list[1].st);
    assert.strictEqual(list[1].memory.base, 0x08000000);
    assert.deepStrictEqual(list[1].memory.sectors.map((s) => s.size / 1024), [16, 16, 16, 16, 64, 128, 128, 128]);
    assert.ok(list[1].memory.sectors.every((s) => s.readable && s.erasable && s.writable), 'g = okunur, silinir, yazılır');
    assert.deepStrictEqual(sb.parseDfuProgress('Download\t[=========                ]  38%     196608 bytes'), { stage: 'program', percent: 38 });
    assert.deepStrictEqual(sb.parseDfuProgress('Erase   \t[=========================] 100%'), { stage: 'erase', percent: 100 });
    assert.strictEqual(sb.parseDfuProgress('Opening DFU capable USB device...'), null);
    assert.deepStrictEqual(sb.dfuUtilArgs({ op: 'write', file: 'a.bin', addr: 0x08004000, leave: true }), ['-d', '0483:df11', '-a', '0', '-s', '0x08004000:leave', '-D', 'a.bin']);
    assert.deepStrictEqual(sb.dfuUtilArgs({ op: 'read', file: 'r.bin', length: 524288 }).slice(-4), ['-s', '0x08000000:524288', '-U', 'r.bin']);
    assert.ok(sb.dfuUtilArgs({ op: 'erase' }).includes('0x08000000:mass-erase:force'));
    assert.deepStrictEqual(sb.cubeProgArgs({ port: 'usb1', op: 'write', file: 'a.hex', verify: true, go: true }), ['-c', 'port=usb1', '-w', 'a.hex', '-v', '-g', '0x08000000']);
    assert.deepStrictEqual(sb.cubeProgArgs({ port: 'COM5', baud: 57600, op: 'write', file: 'a.bin', addr: 0x08000000 }), ['-c', 'port=COM5', 'br=57600', 'P=EVEN', '-w', 'a.bin', '0x08000000']);
    assert.match(sb.explainDfu('dfu-util: No DFU capable USB device available'), /BOOT0/);
    assert.match(sb.explainDfu('LIBUSB_ERROR_ACCESS'), /WinUSB/);
    // AN2606 tablosu ve kart talimatları: 15 işlemcinin hepsi
    for (const m of Object.values(lib.mcus)) {
      const bi = sb.bootInfo(m);
      assert.ok(sb.BOOT[m.id], `${m.id}: AN2606 kaydı`);
      assert.ok(bi.uart.length && bi.uart[0].tx && bi.steps.length >= 2, `${m.id}: UART ve talimat`);
    }
    assert.strictEqual(sb.bootInfo(lib.mcus.stm32f103c8t6).dfu, null, 'F103C8: DFU yok');
    assert.ok(sb.bootInfo(lib.mcus.stm32l476rgt6).steps.some((s) => /ST-LINK sanal COM portu bootloader/.test(s)), 'L476 Nucleo: VCP bootloader UART\'ında');
    assert.ok(sb.bootInfo(f411).steps[0].includes('BOOT0 düğmesini'), 'Black Pill');
    // Simülasyon hedefinde dosya yazma (Programlayıcı > Dosya yaz)
    const d411 = design([inst('usb_uart')]);
    const sm = new SimTarget(simModel(d411, lib, assign(d411, lib), computeClock(mcu, d411.clock), builtinStm32f4()));
    await sm.eraseSectors(0, 1, 1);
    await sm.writeFlash(0x08004000, Uint8Array.from([1, 2, 3, 4]));
    assert.strictEqual((await sm.readMemory(0x08004000, 1))[0], 0x04030201);
    await assert.rejects(() => sm.writeFlash(0x20000000, Uint8Array.from([1])), /flash dışında/);
    passed++;
    console.log('  ✓ Sistem bootloader\'ı (ES-302): AN3155 simülasyonda (GET, GET_ID, READ, WRITE, ERASE/EXT_ERASE, GO; F4, F1, H7 ikinci bank), hatalar, DTR/RTS sırası, dfu-util/CubeProgrammer komutları ve çıktıları, AN2606 tablosu');
  }
  {
    // ES-303: güvenli bootloader şablonu
    const bl = require('../src/codegen/bootloader');
    const eb = require('../src/debug/esboot');
    const cmb = require('../src/codegen/build');
    const f411 = lib.mcus.stm32f411ceu6;
    assert.deepStrictEqual(bl.sizeOptions(f411), [16, 32, 48, 64, 128, 256]);
    assert.strictEqual(bl.defaultSize(lib.mcus.stm32h743zit6), 128);
    assert.strictEqual(bl.defaultSize(lib.mcus.stm32f767zit6), 32);
    assert.deepStrictEqual(bl.sizeOptions(lib.mcus.stm32f030c8t6), [4, 8, 12, 16, 24, 32]);
    for (const m of Object.values(lib.mcus)) {
      const b = bl.normalizeBoot({ enabled: true }, m);
      const part = bl.partition(m, b);
      assert.ok(b.uart && b.tx && b.rx, `${m.id}: UART`);
      assert.strictEqual(part.slotBase + part.slotSize, 0x08000000 + m.device.flashKB * 1024, `${m.id}: yuva flash sonuna kadar`);
      assert.ok(part.units.length && part.units[0].addr === part.slotBase, `${m.id}: ilk silme birimi yuva başında`);
      assert.strictEqual(part.vectors % 0x200, 0, `${m.id}: VTOR hizası`);
    }
    // USB-UART komponentinin UART'ı tercih edilir; geçersiz seçim düzeltilir
    assert.deepStrictEqual((({ uart, tx, rx }) => [uart, tx, rx])(bl.normalizeBoot({ enabled: true }, f411, { inst: 'USART2', tx: 'PA2', rx: 'PA3' })), ['USART2', 'PA2', 'PA3']);
    assert.deepStrictEqual((({ uart, tx, rx }) => [uart, tx, rx])(bl.normalizeBoot({ enabled: true, uart: 'USART9', tx: 'PZ1' }, f411)), ['USART1', 'PA9', 'PA10']);
    assert.strictEqual(bl.normalizeBoot({ sizeKB: 20 }, f411).sizeKB, 16, 'sektör sınırında olmayan boyut düzeltilir');
    assert.strictEqual(bl.versionWord('2.1.5'), 0x02010005);
    const f0 = bl.partition(lib.mcus.stm32f030c8t6, bl.normalizeBoot({ enabled: true }, lib.mcus.stm32f030c8t6));
    assert.deepStrictEqual([f0.remapVectors, f0.appRamOffset], [true, 0xc0], 'Cortex-M0: vektörler RAM\'e');
    // Üretim: bootloader dosyaları, iki linker betiği, CMake hedefi, Yükle / Debug dosyası
    const dB = design([inst('usb_uart'), inst('led')], { framework: 'register', mode: 'pro', boot: { enabled: true, version: '3.2.1' } });
    const gB = generate(dB, lib, assign(dB, lib), computeClock(mcu, dB.clock), {});
    const byPath = Object.fromEntries(gB.files.map((f) => [f.path, f]));
    for (const f of ['bootloader/main.c', 'bootloader/es_boot_core.c', 'bootloader/es_boot_port.c', 'bootloader/es_image.h', 'bootloader/reg/es_flash.c', 'bootloader/reg/es_uart.c', 'src/es_image.c', 'src/es_boot.c', 'inc/es_boot.h', 'cmake/es-image.cmake', 'linker/STM32F411CEU6_BOOT.ld']) assert.ok(byPath[f], f);
    assert.strictEqual(byPath['bootloader/main.c'].kind, 'user');
    const appLd = byPath['linker/STM32F411CEU6_FLASH.ld'].content, bootLd = byPath['linker/STM32F411CEU6_BOOT.ld'].content;
    assert.match(appLd, /FLASH \(rx\) {2}: ORIGIN = 0x08004000, LENGTH = 496K/);
    assert.match(appLd, /KEEP\(\*\(\.es_header\)\)[\s\S]*ASSERT\(ADDR\(\.isr_vector\) == ORIGIN\(FLASH\) \+ 0x400/);
    assert.match(bootLd, /FLASH \(rx\) {2}: ORIGIN = 0x08000000, LENGTH = 16K/);
    assert.ok(!/es_header/.test(bootLd));
    for (const ld of [appLd, bootLd]) assert.match(ld, /_estack = ORIGIN\(RAM\) \+ LENGTH\(RAM\) - 16;/);
    const cfg = byPath['bootloader/es_boot_config.h'].content;
    assert.match(cfg, /ES_SLOT_BASE {5}0x08004000U/);
    assert.match(cfg, /ES_BOOT_UART {5}USART\d/);
    assert.match(cfg, /ES_BOOT_HW_CRC {3}0/, 'F4: yazılım CRC');
    const mod = byPath['cmake/embedded-studio.cmake'].content;
    assert.match(mod, /ES_APP_VECTORS=0x08004400U/);
    assert.match(mod, /VECT_TAB_OFFSET=0x00004400U/);
    assert.match(mod, /ES_FW_VERSION=0x03020001U/);
    assert.match(mod, /function\(embedded_studio_bootloader app\)/);
    assert.match(mod, /-DMODE=header/);
    assert.match(byPath['CMakeLists.txt'].content, /embedded_studio_bootloader\(\$\{PROJECT_NAME\}\)/);
    assert.match(JSON.parse(byPath['.vscode/launch.json'].content).configurations[0].loadFiles[0], /build\/debug\/smoke_full\.hex$/);
    assert.ok(!JSON.parse(byPath['.vscode/launch.json'].content).configurations[2].loadFiles, 'attach: yükleme yok');
    assert.strictEqual(cmb.flashRel(dB), 'build/debug/smoke_full.hex');
    assert.strictEqual(cmb.flashRel(design([inst('led')])), 'build/debug/smoke.elf');
    // Kapalıyken hiçbir bootloader dosyası yok, linker eskisi gibi
    const gN = generate(design([inst('led')], { framework: 'register', mode: 'pro' }), lib, assign(design([inst('led')]), lib), computeClock(mcu, undefined), {});
    assert.ok(!gN.files.some((f) => /bootloader|es_image|es-image/.test(f.path)));
    assert.match(gN.files.find((f) => /_FLASH\.ld$/.test(f.path)).content, /ORIGIN = 0x08000000, LENGTH = 512K/);
    // H7: donanım CRC, 32 baytlık yazma birimi; U5: VTOR sistem dosyasında koşulsuz (VECT_TAB_OFFSET tanımı yeter)
    const h7 = lib.mcus.stm32h743zit6;
    const ph7 = bl.partition(h7, bl.normalizeBoot({ enabled: true }, h7));
    assert.deepStrictEqual([ph7.slotBase, ph7.progUnit], [0x08020000, 32]);
    // İstemci ↔ JS benzetimi: güncelleme, sürüm, yarıda kalma, bozuk imaj
    const img = eb.buildImage({ slotBase: 0x08004000, size: 5000, version: '1.4.2', buildId: 'deadbeef' });
    assert.ok(eb.checkImage(img).ok);
    assert.strictEqual(eb.parseHeader(img).version, '1.4.2');
    const bad = Buffer.from(img); bad[eb.REGION + 9] ^= 1;
    assert.match(eb.checkImage(bad).error, /CRC-32 tutmuyor/);
    assert.match(eb.checkImage(Buffer.alloc(2048)).error, /başlığı yok/);
    const { client, dev } = eb.simEsBoot({ slotBase: 0x08004000, slotSize: 496 * 1024, progUnit: 4 });
    assert.strictEqual((await client.info()).app, 1);
    const r = await client.update(img, { boot: true });
    assert.strictEqual(r.total, img.length);
    assert.deepStrictEqual([dev.validate(true), dev.booted], [0, 1]);
    const info2 = await client.info();
    assert.deepStrictEqual([info2.app, info2.header.version, info2.header.buildId], [0, '1.4.2', 'deadbeef']);
    await client.request(eb.CMD.START, Buffer.from(Uint32Array.of(img.length).buffer));
    assert.strictEqual(dev.validate(true), 1, 'START yuvayı siler');
    const part1 = Buffer.alloc(4 + 1024); img.copy(part1, 4, 0, 1024);
    await client.request(eb.CMD.DATA, part1);
    assert.strictEqual(dev.validate(true), 4, 'yarıda: commit yok');
    await assert.rejects(() => client.request(eb.CMD.END), /sıra hatası/);
    await assert.rejects(() => client.update(eb.buildImage({ slotBase: 0x08008000 })), /başka bir yuva/);
    passed++;
    console.log('  ✓ Güvenli bootloader (ES-303): 15 işlemcide bölümleme ve UART, F0 vektör kopyası, üretilen dosyalar, linker betikleri, CMake hedefi, Yükle/Debug _full.hex, istemci ↔ benzetim (güncelleme, yarıda kalma, bozuk imaj, yanlış yuva)');

    // ES-304: A/B bölünmesi, imzalı yapılandırma, imza ve anahtarlar
    let abCount = 0;
    for (const m of Object.values(lib.mcus)) {
      if (!bl.abSplit(m, bl.defaultSize(m))) continue;
      abCount++;
      const p = bl.partition(m, bl.normalizeBoot({ enabled: true, layout: 'ab' }, m));
      assert.ok(p.ab && p.stageBase === p.slotBase + p.slotSize && p.stageBase + p.stageSize === 0x08000000 + m.device.flashKB * 1024 && p.slotSize <= p.stageSize, `${m.id}: A/B`);
      assert.ok(p.units.some((u) => u.addr === p.stageBase), `${m.id}: hazırlık yuvası silme birimi sınırında`);
      assert.strictEqual(p.imageMax, p.slotSize - 0x400);
    }
    assert.strictEqual(abCount, Object.keys(lib.mcus).length, 'her işlemcide varsayılan boyutla A/B');
    assert.deepStrictEqual(bl.abSplit(f411, 16), { primary: 240 * 1024, stage: 256 * 1024, stageBase: 0x08040000 });
    assert.deepStrictEqual(bl.normalizeBoot({ layout: 'xyz', pubKey: 'abc', minVersion: 'x' }, f411).layout, 'single');
    const key = eb.generateKey();
    const dS = design([inst('usb_uart'), inst('led')], { framework: 'register', mode: 'pro', boot: { enabled: true, layout: 'ab', signing: true, pubKey: key.pub.toString('hex'), minVersion: '1.2.0' } });
    const bS = Object.fromEntries(generate(dS, lib, assign(dS, lib), computeClock(mcu, dS.clock), {}).files.map((f) => [f.path, f]));
    const cS = bS['bootloader/es_boot_config.h'].content;
    assert.match(cS, /#define ES_BOOT_AB\s+1/);
    assert.match(cS, /#define ES_STAGE_BASE\s+0x08040000U/);
    assert.match(cS, /#define ES_RECV_BASE\s+ES_STAGE_BASE/);
    assert.match(cS, /#define ES_BOOT_SIGNED\s+1/);
    assert.ok(cS.includes([...key.pub.subarray(0, 4)].map((x) => '0x' + x.toString(16).padStart(2, '0')).join(', ')), 'açık anahtar gömülü');
    assert.match(cS, /#define ES_BOOT_MIN_VERSION 0x01020000U/);
    assert.ok(bS['bootloader/es_ed25519.c'] && bS['bootloader/es_ed25519.h']);
    assert.match(bS['linker/STM32F411CEU6_FLASH.ld'].content, /ORIGIN = 0x08004000, LENGTH = 240K/, 'uygulama yalnızca ana yuvada');
    assert.match(bS['AGENTS.md'].content, /A\/B \(ES-304\)[\s\S]*İmza \(ES-304\): Ed25519, anahtar [0-9a-f]{16}/);
    const dE = design([inst('led')], { framework: 'register', mode: 'pro', boot: { enabled: true, signing: true } });
    assert.match(generate(dE, lib, assign(dE, lib), computeClock(mcu, dE.clock), {}).files.find((f) => f.path === 'bootloader/es_boot_config.h').content, /#error "Bootloader imzası açık ama açık anahtar yok/);
    const simg = eb.signImage(img, key.pem).bytes;
    assert.ok(eb.verifySig(simg, key.pub) && !eb.verifySig(img, key.pub) && !eb.verifySig(simg, eb.generateKey().pub));
    assert.deepStrictEqual((({ present, keyId }) => [present, keyId])(eb.checkImage(simg).sig), [true, key.keyId]);
    const tam = Buffer.from(simg); tam[eb.REGION + 50] ^= 1;
    assert.ok(!eb.verifySig(tam, key.pub), 'değiştirilen imaj');
    assert.strictEqual(eb.loadPrivateKey(key.pem).keyId, key.keyId);
    const rsa = require('crypto').generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
    assert.throws(() => eb.loadPrivateKey(rsa), /Ed25519 değil/);
    assert.throws(() => eb.loadPrivateKey('çöp'), /okunamadı/);
    passed++;
    console.log('  ✓ İmza ve A/B (ES-304): 15 işlemcide A/B bölünmesi, imzalı yapılandırma (açık anahtar, en düşük sürüm), anahtarsız #error, Ed25519 imzala/doğrula, anahtar içe aktarma');

    // ES-305: imzalama ve paketleme aracı (cmake/es-sign.js = src/codegen/es-sign.js)
    const es = require('../src/codegen/es-sign');
    assert.ok(es.sign(img, key.pem).bytes.equals(simg), 'eklentinin imzasıyla bayt bayt aynı');
    assert.strictEqual(bS['cmake/es-sign.js'].content, fs.readFileSync(path.join(__dirname, '../src/codegen/es-sign.js'), 'utf8'));
    const modS = bS['cmake/embedded-studio.cmake'].content;
    assert.match(modS, /set\(ES_SIGN_KEY "\$ENV\{ES_SIGN_KEY\}"\)[\s\S]*find_program\(ES_NODE node\)/);
    assert.match(modS, new RegExp(`add_custom_target\\(\\$\\{app\\}_signed ALL[\\s\\S]*es-sign\\.js --key \\$\\{ES_SIGN_KEY\\} --pub ${key.pub.toString('hex')} --slot 0x8004000`));
    assert.ok(!/es-sign/.test(byPath['cmake/embedded-studio.cmake'].content) && !byPath['cmake/es-sign.js'], 'imza kapalıyken yok');
    assert.strictEqual(bl.normalizeBoot({ signOnBuild: false }, f411).signOnBuild, false);
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'es-sign-'));
    const bootHex = ':020000040800F2\n:0400000000000220DA\n:00000001FF\n';
    const pk = es.packImage({ bin: img, pem: key.pem, pub: key.pub, slotBase: 0x08004000, outDir: out, name: 'app', bootHex, now: new Date(0) });
    assert.deepStrictEqual(pk.files.map((f) => path.basename(f)), ['app_signed.bin', 'app_signed.hex', 'app_full_signed.hex', 'app_update.json']);
    assert.deepStrictEqual(pk.manifest, {
      format: 'embedded-studio-update/1', name: 'app', version: '1.4.2', fwVersion: '0x01040002', buildId: 'deadbeef', slotBase: '0x08004000', size: img.length,
      imageSize: img.length - 0x400, imageCrc: '0x' + img.readUInt32LE(12).toString(16).toUpperCase().padStart(8, '0'),
      sha256: require('crypto').createHash('sha256').update(simg).digest('hex'), signature: { alg: 'Ed25519', keyId: key.keyId }, file: 'app_signed.bin', created: '1970-01-01T00:00:00.000Z'
    });
    const full = fs.readFileSync(path.join(out, 'app_full_signed.hex'), 'utf8');
    assert.strictEqual((full.match(/:00000001FF/g) || []).length, 1, 'tek EOF');
    const segs = require('../src/debug/programmer').parseIntelHex(full);
    assert.strictEqual(segs[0].addr, 0x08000000);
    const app = segs.find((g) => g.addr === 0x08004000);
    assert.ok(app && Buffer.from(app.bytes).equals(simg), 'birleşik HEX\'te imzalı uygulama');
    assert.throws(() => es.packImage({ bin: img, pem: key.pem, pub: eb.generateKey().pub, slotBase: 0x08004000, outDir: out, name: 'x' }), /gömülü açık anahtarla .* aynı değil/);
    assert.throws(() => es.packImage({ bin: img, pem: key.pem, slotBase: 0x08008000, outDir: out, name: 'x' }), /başka bir yuva/);
    assert.throws(() => es.sign(bad, key.pem), /CRC-32 tutmuyor/);
    // Komut satırı: anahtar ortam değişkeninden (CI gizli değişkeni)
    fs.writeFileSync(path.join(out, 'in.bin'), img);
    assert.match(es.cli(['--bin', path.join(out, 'in.bin'), '--slot', '0x08004000', '--name', 'ci'], { ES_SIGN_KEY_PEM: key.pem }), /v1\.4\.2 \(deadbeef\).*ci_signed\.bin/);
    assert.ok(fs.readFileSync(path.join(out, 'ci_signed.bin')).equals(simg));
    assert.throws(() => es.cli(['--bin', 'a.bin', '--slot', '0x08004000'], {}), /Özel anahtar yok/);
    fs.rmSync(out, { recursive: true, force: true });
    passed++;
    console.log('  ✓ İmzalama aracı (ES-305): eklentiyle aynı imza, paket dosyaları ve sürüm bildirimi, birleşik imzalı HEX, yanlış anahtar / yuva / bozuk imaj, CMake ES_SIGN_KEY hedefi, komut satırı (ortam değişkeni)');
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
