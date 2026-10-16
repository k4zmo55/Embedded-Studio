// @ts-check
/**
 * STM32 aileleri (ES-106). Aileler arasındaki farklar burada tek yerde durur; kod üretimi bu tanımlara göre dallanır.
 *
 *  ip.gpio   v1: F1 (CRL/CRH, AF numarası yok)            v2: diğerleri (MODER/AFR)
 *  ip.i2c    v1: F1/F4 (SR1/SR2/CCR)                      v2: diğerleri (TIMINGR/ISR/TXDR)
 *  ip.usart  v1: F1/F4 (SR/DR)                            v2: diğerleri (ISR/TDR/RDR/ICR)
 *  ip.spi    v1: F1/F4 (16 bit DR)   fifo: F0/F3/F7/G0/G4/L4 (DS + FRXTH)   v2: H7/U5 (CFG1/CFG2, TXDR/RXDR)
 *  ip.adc    f1: F1   f4: F4/F7 (SQR3, SWSTART)   g0: F0/G0 (CHSELR)   v3: F3/G4/L4/U5 (ADVREGEN, SQR1)   h7: H7 (v3 + PCSEL, BOOST)
 *  clock     f4: M/N/P/Q (F4/F7)   mul: PREDIV × PLLMUL (F0/F1/F3)   mnr: M/N/R (G0/G4/L4/U5)   h7: DIVM1/N1/P1/Q1 + alan bölücüleri
 */

const FAMILIES = {
  f0: {
    series: 'STM32F0xx', core: 'cortex-m0', fpu: null, port: 'ARM_CM0', openocd: 'target/stm32f0x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'g0' }, clock: 'mul', apbCount: 1,
    halSpeed: 'GPIO_SPEED_FREQ_HIGH', svd: 'STM32F0x0.svd'
  },
  f1: {
    series: 'STM32F1xx', core: 'cortex-m3', fpu: null, port: 'ARM_CM3', openocd: 'target/stm32f1x.cfg',
    ip: { gpio: 'v1', i2c: 'v1', usart: 'v1', spi: 'v1', adc: 'f1' }, clock: 'mul', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_HIGH'
  },
  f3: {
    series: 'STM32F3xx', core: 'cortex-m4', fpu: 'fpv4-sp-d16', port: 'ARM_CM4F', openocd: 'target/stm32f3x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'v3' }, clock: 'mul', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_HIGH'
  },
  f4: {
    series: 'STM32F4xx', core: 'cortex-m4', fpu: 'fpv4-sp-d16', port: 'ARM_CM4F', openocd: 'target/stm32f4x.cfg',
    ip: { gpio: 'v2', i2c: 'v1', usart: 'v1', spi: 'v1', adc: 'f4' }, clock: 'f4', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  f7: {
    series: 'STM32F7xx', core: 'cortex-m7', fpu: 'fpv5-d16', port: 'ARM_CM4F', openocd: 'target/stm32f7x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'f4' }, clock: 'f4', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  g0: {
    series: 'STM32G0xx', core: 'cortex-m0plus', fpu: null, port: 'ARM_CM0', openocd: 'target/stm32g0x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'g0' }, clock: 'mnr', apbCount: 1,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  g4: {
    series: 'STM32G4xx', core: 'cortex-m4', fpu: 'fpv4-sp-d16', port: 'ARM_CM4F', openocd: 'target/stm32g4x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'v3' }, clock: 'mnr', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  h7: {
    series: 'STM32H7xx', core: 'cortex-m7', fpu: 'fpv5-d16', port: 'ARM_CM4F', openocd: 'target/stm32h7x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'v2', adc: 'h7' }, clock: 'h7', apbCount: 4,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  l4: {
    series: 'STM32L4xx', core: 'cortex-m4', fpu: 'fpv4-sp-d16', port: 'ARM_CM4F', openocd: 'target/stm32l4x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'fifo', adc: 'v3' }, clock: 'mnr', apbCount: 2,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  },
  u5: {
    series: 'STM32U5xx', core: 'cortex-m33', fpu: 'fpv5-sp-d16', port: 'ARM_CM33_NTZ/non_secure', openocd: 'target/stm32u5x.cfg',
    ip: { gpio: 'v2', i2c: 'v2', usart: 'v2', spi: 'v2', adc: 'v3' }, clock: 'mnr', apbCount: 3,
    halSpeed: 'GPIO_SPEED_FREQ_VERY_HIGH'
  }
};

/** @param {string} key f0, f1 … (mcu.device.family) */
function family(key) {
  const f = FAMILIES[key || 'f4'];
  if (!f) throw new Error(`Bilinmeyen STM32 ailesi: ${key}`);
  const prefix = f.series.toLowerCase(); // stm32f4xx
  return {
    key: key || 'f4', ...f, prefix,
    halHeader: `${prefix}_hal.h`,
    cmsisHeader: `${prefix}.h`,
    systemC: `system_${prefix}.c`,
    itFile: `${prefix}_it.c`,
    halConf: `${prefix}_hal_conf.h`,
    halConfTemplate: `${prefix}_hal_conf_template.h`,
    cmsisRepo: `https://github.com/STMicroelectronics/cmsis-device-${key}.git`,
    halRepo: `https://github.com/STMicroelectronics/${prefix}-hal-driver.git`
  };
}

/** MCU tanımından aile (eski tasarımlarda family yoksa F4). */
const familyOf = (mcu) => family((mcu && mcu.device && mcu.device.family) || 'f4');

/** Çevre biriminin çekirdek (kernel) saati: computeClock().freq içindeki alan. */
function kernelClock(mcu, periph) {
  const p = mcu.peripherals[periph] || {};
  if (p.clock) return p.clock;
  return { APB1: 'pclk1', APB2: 'pclk2', APB3: 'pclk3', APB4: 'pclk4', AHB: 'hclk' }[p.bus] || 'pclk1';
}

/** Timer saati: APB bölücü 1 değilse PCLK × 2. */
const timerClock = (mcu, periph) => ((mcu.peripherals[periph] || {}).bus === 'APB2' ? 'tim2' : 'tim1');

module.exports = { FAMILIES, family, familyOf, kernelClock, timerClock };
