// Entegrasyon testi: paketleri indirir, HAL ve register projelerini üretir, arm-none-eabi-gcc ile derler.
// Gerekenler: git, cmake, ninja, arm-none-eabi-gcc.
// Çalıştırma: node test/build.js [önbellek klasörü] [çıktı klasörü] [filtre: düzenli ifade, ör. "stm32g0|stm32g4" ya da "f411"]
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const { loadLibrary } = require('../src/library');
const { assign } = require('../src/engine/pinAssigner');
const { computeClock, solveClock } = require('../src/engine/clock');
const { generate, GENERATOR_VERSION } = require('../src/codegen/generator');
const { writeProject, designFingerprint } = require('../src/codegen/merge');
const packs = require('../src/codegen/packs');
const cm = require('../src/codegen/build');
const { DRIVERS, resolveDrivers } = require('../src/codegen/regdrivers');

/** Örnek sürücülerin tüm API'sini çağıran dosya; constructor ile .init_array'de tutulur, böylece bağlanır da. */
function regDriverUsage(mcu, ids) {
  const has = new Set(resolveDrivers(mcu, ids));
  const tim = Object.keys(mcu.peripherals).find((p) => mcu.peripherals[p].type === 'pwm');
  const L = [];
  for (const id of has) L.push(`#include "es_${id}.h"`);
  if (has.has('trace')) L.push('int _write(int fd, char *ptr, int len);');
  L.push('', '__attribute__((constructor)) static void es_usage(void)', '{');
  if (has.has('rcc')) L.push('  (void)es_clock_init();', '  (void)es_rcc_ahb_div();');
  if (has.has('gpio')) L.push('  es_gpio_clock_enable(GPIOA);', '  es_gpio_init(GPIOA, 5, ES_GPIO_OUTPUT, ES_GPIO_NOPULL, ES_GPIO_PUSHPULL, 0);', '  es_gpio_toggle(GPIOA, 5);', '  (void)es_gpio_read(GPIOA, 5);');
  if (has.has('exti')) L.push('  es_exti_init(GPIOA, 0, ES_EXTI_BOTH);', '  NVIC_EnableIRQ(es_exti_irqn(0));', '  if (es_exti_pending(0)) es_exti_clear(0);');
  if (has.has('dma')) L.push('  es_dma_clock_enable();');
  if (has.has('uart')) L.push('  static es_uart_ring_t ring;', '  static uint8_t msg[4] ES_DMA_BUFFER;', '  es_uart_clock_enable(USART1);', '  es_uart_init(USART1, es_rcc_pclk2_hz(), 115200);', '  es_uart_write(USART1, "x", 1);', '  (void)es_uart_getc(USART1);',
    '  es_uart_rx_irq_start(USART1, USART1_IRQn, 6);', '  es_uart_irq_handler(USART1, &ring);', '  if (es_uart_available(&ring)) (void)es_uart_read(&ring);', '  (void)es_uart_write_dma(USART1, &ES_DMA_USART1_TX, msg, sizeof msg);', '  while (es_uart_dma_busy(&ES_DMA_USART1_TX)) {', '  }');
  if (has.has('spi')) L.push('  es_spi_clock_enable(SPI1);', '  es_spi_init(SPI1, 3, 0);', '  (void)es_spi_xfer(SPI1, 0x9F);');
  if (has.has('i2c')) L.push('  uint8_t v = 0;', '  es_i2c_clock_enable(I2C1);', '  (void)es_i2c_init(I2C1, es_rcc_pclk1_hz(), 400000);', '  (void)es_i2c_probe(I2C1, 0x76);', '  (void)es_i2c_mem_read(I2C1, 0x76, 0xD0, &v, 1);', '  (void)es_i2c_mem_write(I2C1, 0x76, 0xF4, &v, 1);', '  (void)es_i2c_write(I2C1, 0x3C, &v, 1);', '  (void)es_i2c_read(I2C1, 0x3C, &v, 1);');
  if (has.has('tim') && tim) L.push(`  uint32_t ticks;`, `  es_tim_clock_enable(${tim});`, `  es_tim_pwm_init(${tim}, 1, 2U * es_rcc_pclk1_hz(), 1000);`, `  es_tim_pwm_duty(${tim}, 1, 500);`, `  es_tim_ic_init(${tim}, 1, 2U * es_rcc_pclk1_hz(), 1000000);`, `  (void)es_tim_ic_period(${tim}, 1, &ticks);`, `  es_tim_encoder_init(${tim});`, `  (void)es_tim_encoder_count(${tim});`);
  if (has.has('adc')) L.push('  static const uint8_t ch[3] = { 1, 2, 3 };', '  static uint16_t res[3] ES_DMA_BUFFER;', '  es_adc_init();', '  (void)es_adc_read(1);', '  (void)es_adc_scan_dma_start(ch, 3, res);');
  if (has.has('dac')) L.push('  es_dac_init(1);', '  es_dac_write(1, 2048);');
  if (has.has('iwdg')) L.push('  es_iwdg_start(500);', '  es_iwdg_refresh();');
  if (has.has('wwdg')) L.push('  es_wwdg_start(0x7F, 0x5F, 3);', '  es_wwdg_refresh(0x7F);');
  if (has.has('crc')) L.push('  static const uint32_t w[2] = { 1, 2 };', '  es_crc_init();', '  (void)es_crc32(w, 2);');
  if (has.has('flash')) L.push('  static const uint8_t kayit[32] = { 1 };', '  es_flash_unlock();', '  (void)es_flash_erase(ES_FLASH_BASE + ES_FLASH_SIZE - 32U);', '  (void)es_flash_program(ES_FLASH_BASE + ES_FLASH_SIZE - 32U, kayit, sizeof kayit);', '  es_flash_lock();');
  if (has.has('trace')) L.push('  es_trace_init();', '  es_itm_write(1, "x", 1);', '  (void)es_rtt_write("x", 1);', '  (void)es_rtt_getc();', '  (void)_write(1, (char *)"y", 1);');
  L.push('}', '');
  return L.join('\n');
}

const os = require('os');
const cache = process.argv[2] || path.join(os.tmpdir(), 'es-packs');
const outRoot = process.argv[3] || path.join(os.tmpdir(), 'es-build');
const filter = process.argv[4] || '';
const lib = loadLibrary(path.join(__dirname, '..'));
// Tüm IP'leri kapsar: UART (2), I2C (3 cihaz), SPI + CS, ADC, PWM, GPIO giriş/çıkış
const ALL = ['usb_uart', 'bme280', 'mpu6050', 'ssd1306', 'w25q32', 'neo6m', 'led', 'button', 'potentiometer', 'servo_sg90'];

(async () => {
  // { mcu, framework, rtos, mode, build, suffix, ids, maxClock }
  const strict = { warnings: 'strict', werror: true };
  const f411 = 'stm32f411ceu6';
  const variants = [
    ...[['hal', true], ['hal', false], ['hal', true, 'pro'], ['register', true], ['register', false], ['register', true, 'pro'], ['register', false, 'pro']]
      .map(([framework, rtos, mode]) => ({ mcu: f411, framework, rtos, mode })),
    // ES-105: derleme tipleri, sıkı uyarı + -Werror (üretilen kod uyarısız olmalı), FPU seçenekleri
    { mcu: f411, framework: 'hal', rtos: true, build: { ...strict, type: 'Release' }, suffix: 'release_strict' },
    { mcu: f411, framework: 'register', rtos: true, build: { ...strict, type: 'MinSizeRel' }, suffix: 'minsize_strict' },
    { mcu: f411, framework: 'register', rtos: true, mode: 'pro', build: { fpu: 'soft', type: 'Release', ...strict }, suffix: 'softfloat' },
    { mcu: f411, framework: 'hal', rtos: false, build: { fpu: 'softfp', type: 'RelWithDebInfo', defines: ['APP_VER="1.2"'], cflags: '-fstack-usage', ldflags: '-Wl,--cref', specs: { nano: false, nosys: true } }, suffix: 'flags' },
    // "CMake'i ben yönetiyorum": kullanıcının kendi CMakeLists.txt'si, kaynakları kendisi veriyor (NO_SOURCES)
    { mcu: f411, framework: 'register', rtos: false, mode: 'pro', build: { cmake: 'user' }, suffix: 'usercmake' }
  ];
  // ES-106: diğer işlemciler — her biri HAL ve bare-metal, RTOS'lu, sıkı uyarı + -Werror; ayrıca en yüksek saat
  for (const id of Object.keys(lib.mcus).filter((m) => m !== f411)) {
    const small = lib.mcus[id].ramKB < 16; // F030: 8 KB RAM, FreeRTOS + 10 sensör sığmaz
    const ids = small ? ['usb_uart', 'bme280', 'w25q32', 'led', 'button', 'potentiometer', 'servo_sg90'] : ALL;
    for (const framework of ['hal', 'register']) variants.push({ mcu: id, framework, rtos: !small, build: strict, ids, maxClock: true });
    // ES-107: tüm örnek register sürücüleri + hepsini çağıran kullanım dosyası (derlenir ve bağlanır)
    variants.push({ mcu: id, framework: 'register', rtos: false, mode: 'pro', build: strict, ids, suffix: 'pro', regDrivers: DRIVERS.map((d) => d.id) });
  }
  variants.push({ mcu: f411, framework: 'register', rtos: false, mode: 'pro', build: strict, suffix: 'regdrivers', regDrivers: DRIVERS.map((d) => d.id) });
  const userCmake = (name) => `cmake_minimum_required(VERSION 3.20)
set(CMAKE_TOOLCHAIN_FILE \${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake CACHE FILEPATH "")
project(${name} C ASM)
include(cmake/embedded-studio.cmake)
add_executable(\${PROJECT_NAME} \${ES_SOURCES} extra/version.c)
target_compile_definitions(\${PROJECT_NAME} PRIVATE BENIM_PROJEM=1)
embedded_studio_target(\${PROJECT_NAME} NO_SOURCES)
`;
  const re = new RegExp(filter);
  const selected = variants.filter((v) => re.test(`${v.mcu}_${v.framework}_${v.suffix || ''}`));
  const mcusUsed = [...new Set(selected.map((v) => v.mcu))];
  const need = [...new Set(mcusUsed.flatMap((id) => packs.packsFor(lib.mcus[id], 'hal', true)))];
  await packs.ensurePacks(cache, need, (m) => console.log('  ' + m));

  let failed = 0;
  for (const v of selected) {
    const { framework, rtos, mode = 'beginner', build = {}, suffix, ids = ALL, regDrivers = [] } = v;
    const short = v.mcu === f411 ? '' : `${v.mcu.replace(/^stm32/, '').slice(0, 6)}_`;
    const name = `t_${short}${framework}_${rtos ? 'rtos' : 'bare'}${mode === 'pro' ? '_pro' : ''}${suffix && suffix !== 'pro' ? '_' + suffix : ''}`;
    const root = path.join(outRoot, name);
    fs.rmSync(root, { recursive: true, force: true });
    const mcu = lib.mcus[v.mcu];
    const design = {
      mcuId: v.mcu, framework, rtos, mode, project: { name }, build, regDrivers,
      instances: ids.map((c, i) => ({ id: 'i' + i, componentId: c, label: `${c.toUpperCase()}_1` })), locks: {}
    };
    // En yüksek saat: over-drive / boost / EPOD yollarını da derle
    if (v.maxClock) design.clock = solveClock(mcu, mcu.clock.default, mcu.clock.limits.sysclk);
    const result = assign(design, lib);
    const clock = computeClock(mcu, design.clock);
    const errors = [...result.messages.filter((m) => m.level === 'error'), ...clock.issues.filter((m) => m.level === 'error')];
    packs.installIntoProject(cache, root, mcu, packs.missingInProject(root, mcu, framework, rtos, cm.rtosPort(build, mcu)), framework);
    if (build.cmake === 'user') {
      fs.mkdirSync(path.join(root, 'extra'), { recursive: true });
      fs.writeFileSync(path.join(root, 'extra/version.c'), '#ifndef BENIM_PROJEM\n#error "kullanıcı tanımı yok"\n#endif\nconst char *app_version(void) { return "1.0"; }\n');
      fs.writeFileSync(path.join(root, 'CMakeLists.txt'), userCmake(name));
    }
    const gen = generate(design, lib, result, clock, { halConfTemplate: packs.halConfTemplate(cache, root, mcu) });
    writeProject(root, gen, { fingerprint: designFingerprint(design, GENERATOR_VERSION), snapshot: { instances: [], connections: [] } });
    if (regDrivers.length) fs.writeFileSync(path.join(root, 'src/es_usage.c'), regDriverUsage(mcu, regDrivers));
    const preset = cm.presetName(cm.normalizeBuild(build).type);
    try {
      if (errors.length) throw new Error(`tasarım hatası: ${errors.map((e) => e.text).join('; ')}`);
      if (build.cmake === 'user' && fs.readFileSync(path.join(root, 'CMakeLists.txt'), 'utf8') !== userCmake(name)) throw new Error('kullanıcının CMakeLists.txt dosyası değişti');
      execSync(`cmake --preset ${preset}`, { cwd: root, stdio: 'pipe' });
      const out = execSync(`cmake --build --preset ${preset}`, { cwd: root, stdio: 'pipe' }).toString();
      const missing = ['.elf', '.hex', '.bin', '.map'].filter((x) => !fs.existsSync(path.join(root, 'build', preset, name + x)));
      if (missing.length) throw new Error(`build/${preset}/ altında eksik çıktı: ${missing.join(', ')}`);
      const warn = out.split('\n').filter((l) => /warning:/.test(l) && /Core|Components|src|drivers/.test(l));
      const size = out.split('\n').filter((l) => /FLASH:|RAM:/.test(l)).map((l) => l.trim().replace(/\s+/g, ' ')).join(' | ');
      console.log(`OK   ${name} [${preset}, ${clock.freq.sysclk} MHz]  ${size}${warn.length ? `\n     ${warn.length} uyarı:\n     ` + warn.slice(0, 8).join('\n     ') : ''}`);
    } catch (e) {
      failed++;
      const text = (e.stdout || '').toString() + (e.stderr || '').toString() || e.message;
      console.log(`FAIL ${name}\n` + text.split('\n').filter((l) => /error|undefined|Error|overflow/.test(l)).slice(0, 25).join('\n'));
    }
  }
  console.log(`\n${selected.length - failed}/${selected.length} varyant derlendi.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
