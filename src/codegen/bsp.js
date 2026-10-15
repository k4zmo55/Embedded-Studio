// @ts-check
/**
 * BSP (board support) katmanı üretimi: board.h, bsp.h, bsp.c, board.c, stm32f4xx_it.c
 * İki altyapı: 'hal' (STM32 HAL) ve 'register' (CMSIS başlıklarıyla doğrudan register erişimi).
 * Sürücüler ve uygulama kodu sadece bsp.h API'sini görür.
 */
const { parseSignal } = require('../engine/pinAssigner');

const HANDLE_PREFIX = { I2C: 'hi2c', SPI: 'hspi', USART: 'huart', UART: 'huart', ADC: 'hadc', TIM: 'htim' };
const HAL_TYPE = { i2c: 'I2C_HandleTypeDef', spi: 'SPI_HandleTypeDef', uart: 'UART_HandleTypeDef', adc: 'ADC_HandleTypeDef', pwm: 'TIM_HandleTypeDef' };
const cIdent = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');
const handleOf = (periph) => {
  const m = /^(I2C|SPI|USART|UART|ADC|TIM)(\d+)$/.exec(periph);
  if (!m) throw new Error(`Çevre birimi adı çözülemedi: ${periph}`);
  return `${HANDLE_PREFIX[m[1]]}${m[2]}`;
};
const indent = (code, n = 2) => code.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
const hz = (mhz) => Math.round(mhz * 1e6);

/** Üretim bağlamı: bus indeksleri, pin listesi, zamanlama hesapları. */
function makeContext(design, lib, result, clock) {
  const mcu = lib.mcus[design.mcuId];
  const periphs = Object.entries(result.peripherals).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }));
  const byType = (t) => periphs.filter(([, p]) => p.type === t).map(([n]) => n);
  const buses = { i2c: byType('i2c'), spi: byType('spi'), uart: byType('uart'), pwm: byType('pwm'), adc: byType('adc') };
  const busId = (periph) => `BSP_${periph}`;
  const f = clock.freq;
  const pclkOf = (periph) => (mcu.peripherals[periph].bus === 'APB2' ? f.pclk2 : f.pclk1);
  const timclkOf = (periph) => (mcu.peripherals[periph].bus === 'APB2' ? f.tim2 : f.tim1);

  // Pin isimleri: bus pinleri sinyal adıyla (I2C1_SCL), GPIO pinleri komponent adıyla (LED_1_A).
  const label = (id) => design.instances.find((i) => i.id === id)?.label ?? id;
  const pinName = (c) => (c.kind === 'gpio' || c.cs ? `${cIdent(label(c.instId))}_${cIdent(c.compPin)}` : c.signal);
  const pins = [];
  const seen = new Set();
  for (const c of result.connections) {
    if (seen.has(c.mcuPin)) continue;
    seen.add(c.mcuPin);
    const comp = lib.components[design.instances.find((i) => i.id === c.instId)?.componentId] || {};
    const n = Number(c.mcuPin.slice(2));
    let mode, pull = 'none', otype = 'pp';
    if (c.kind === 'i2c') { mode = 'af'; otype = 'od'; pull = 'up'; }
    else if (c.kind === 'adc') mode = 'analog';
    else if (c.signal === 'GPIO_Output') mode = 'out';
    else if (c.signal === 'GPIO_Input') { mode = 'in'; if (comp.id === 'button') pull = 'up'; }
    else { mode = 'af'; if (c.kind === 'uart') pull = 'up'; }
    pins.push({
      conn: c, name: pinName(c), port: c.mcuPin[1], n, mode, pull, otype, af: c.af,
      initHigh: c.signal === 'GPIO_Output' && !!c.cs
    });
  }
  const ports = [...new Set(pins.map((p) => p.port))].sort();

  // SPI bölücü: breadboard için 10 MHz üst sınır.
  const spiDiv = (periph, speedHz) => {
    const target = Math.min(speedHz, 10e6);
    let div = 2;
    while (div < 256 && hz(pclkOf(periph)) / div > target) div *= 2;
    return div;
  };
  // Timer: ~1 MHz sayaç.
  const timTiming = (periph, freqHz) => {
    const clk = hz(timclkOf(periph));
    const psc = Math.max(0, Math.round(clk / 1e6) - 1);
    const tick = clk / (psc + 1);
    return { psc, arr: Math.max(1, Math.round(tick / freqHz) - 1), tick };
  };
  // ADC saati en fazla 36 MHz.
  const adcDiv = [2, 4, 6, 8].find((d) => f.pclk2 / d <= 36) || 8;

  return { mcu, periphs, buses, busId, pclkOf, timclkOf, pins, ports, spiDiv, timTiming, adcDiv, clock, label, pinName };
}

// ------------------------------------------------------------------ board.h
function boardHeader(x, design, result, framework, stamp) {
  const f = x.clock.freq;
  const pinDefs = [];
  const seen = new Set();
  for (const c of result.connections) {
    const name = x.pinName(c);
    if (seen.has(name)) continue;
    seen.add(name);
    pinDefs.push(`#define ${name}_Port GPIO${c.mcuPin[1]}\n#define ${name}_Pin  (1U << ${Number(c.mcuPin.slice(2))})`);
  }
  const addrDefs = design.instances.filter((i) => result.addresses[i.id]).map((i) => `#define ${cIdent(i.label)}_ADDR ${result.addresses[i.id]}`);
  return `${stamp}#ifndef BOARD_H
#define BOARD_H

#include ${framework === 'hal' ? `"${x.mcu.halHeader}"` : `"${x.mcu.device.cmsisHeader}"`}
#include <stdint.h>

/* ---- Saat ağacı (Clock sekmesinden) ---- */
#define BOARD_SYSCLK_HZ ${hz(f.sysclk)}U
#define BOARD_HCLK_HZ   ${hz(f.hclk)}U
#define BOARD_PCLK1_HZ  ${hz(f.pclk1)}U
#define BOARD_PCLK2_HZ  ${hz(f.pclk2)}U

/* ---- Pin atamaları ---- */
${pinDefs.join('\n') || '/* yok */'}

/* ---- I2C adresleri (7-bit) ---- */
${addrDefs.join('\n') || '/* yok */'}

void Board_Init(void);
void Error_Handler(void);

#endif
`;
}

// ------------------------------------------------------------------ bsp.h
function bspHeader(x, result, stamp) {
  const ids = [];
  for (const t of ['i2c', 'spi', 'uart', 'pwm']) x.buses[t].forEach((p, i) => ids.push(`#define ${x.busId(p)} ${i}`));
  const tele = Object.entries(result.peripherals).find(([, p]) => p.telemetry)?.[0];
  return `${stamp}#ifndef BSP_H
#define BSP_H

#include "board.h"

/* Bus kimlikleri: sürücüler çevre birimini bu numaralarla seçer. */
${ids.join('\n') || '/* bus yok */'}
#define BSP_TELEMETRY_UART ${tele ? x.busId(tele) : '(-1)'}

uint32_t bsp_millis(void);
void bsp_delay_ms(uint32_t ms);

/* Dönüş değerleri: 0 = başarılı, < 0 = hata (NACK, zaman aşımı). */
int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len);
int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len);
int bsp_i2c_probe(uint8_t bus, uint8_t addr7);
int bsp_spi_transfer(uint8_t bus, const uint8_t *tx, uint8_t *rx, uint16_t len);
int bsp_uart_write(uint8_t bus, const uint8_t *data, uint16_t len);
void bsp_uart_start_rx(uint8_t bus);
/* Kesme içinden her alınan byte için çağrılır. Uygulama bu weak fonksiyonu ezer. */
void bsp_uart_rx_callback(uint8_t bus, uint8_t byte);
void bsp_uart_irq(uint8_t bus);

void bsp_gpio_write(GPIO_TypeDef *port, uint16_t pin, int level);
int bsp_gpio_read(GPIO_TypeDef *port, uint16_t pin);
void bsp_gpio_toggle(GPIO_TypeDef *port, uint16_t pin);
uint16_t bsp_adc_read(uint8_t channel);
void bsp_pwm_set(uint8_t timer, uint8_t channel, uint32_t compare);

#endif
`;
}

// ------------------------------------------------------------------ HAL
function halBspSource(x, stamp) {
  const arr = (t, type) => (x.buses[t].length ? `static ${type} *const ${t}_bus[] = { ${x.buses[t].map((p) => '&' + handleOf(p)).join(', ')} };` : '');
  const ext = x.periphs.map(([n, p]) => `extern ${HAL_TYPE[p.type]} ${handleOf(n)};`).join('\n');
  const adc = x.buses.adc[0];
  return `${stamp}#include "bsp.h"

${ext}

${[arr('i2c', 'I2C_HandleTypeDef'), arr('spi', 'SPI_HandleTypeDef'), arr('uart', 'UART_HandleTypeDef'), arr('pwm', 'TIM_HandleTypeDef')].filter(Boolean).join('\n')}

uint32_t bsp_millis(void) { return HAL_GetTick(); }
void bsp_delay_ms(uint32_t ms) { HAL_Delay(ms); }

int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len)
{
${x.buses.i2c.length ? '  return HAL_I2C_Mem_Read(i2c_bus[bus], (uint16_t)(addr7 << 1), reg, I2C_MEMADD_SIZE_8BIT, buf, len, 50) == HAL_OK ? 0 : -1;' : '  (void)bus; (void)addr7; (void)reg; (void)buf; (void)len;\n  return -1;'}
}

int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len)
{
${x.buses.i2c.length ? '  return HAL_I2C_Mem_Write(i2c_bus[bus], (uint16_t)(addr7 << 1), reg, I2C_MEMADD_SIZE_8BIT, (uint8_t *)buf, len, 50) == HAL_OK ? 0 : -1;' : '  (void)bus; (void)addr7; (void)reg; (void)buf; (void)len;\n  return -1;'}
}

int bsp_i2c_probe(uint8_t bus, uint8_t addr7)
{
${x.buses.i2c.length ? '  return HAL_I2C_IsDeviceReady(i2c_bus[bus], (uint16_t)(addr7 << 1), 3, 20) == HAL_OK ? 0 : -1;' : '  (void)bus; (void)addr7;\n  return -1;'}
}

int bsp_spi_transfer(uint8_t bus, const uint8_t *tx, uint8_t *rx, uint16_t len)
{
${x.buses.spi.length ? '  return HAL_SPI_TransmitReceive(spi_bus[bus], (uint8_t *)tx, rx, len, 50) == HAL_OK ? 0 : -1;' : '  (void)bus; (void)tx; (void)rx; (void)len;\n  return -1;'}
}

int bsp_uart_write(uint8_t bus, const uint8_t *data, uint16_t len)
{
${x.buses.uart.length ? '  return HAL_UART_Transmit(uart_bus[bus], (uint8_t *)data, len, 100) == HAL_OK ? 0 : -1;' : '  (void)bus; (void)data; (void)len;\n  return -1;'}
}
${x.buses.uart.length ? `
static uint8_t uart_rx_byte[${x.buses.uart.length}];

void bsp_uart_start_rx(uint8_t bus)
{
  HAL_UART_Receive_IT(uart_bus[bus], &uart_rx_byte[bus], 1);
}

void HAL_UART_RxCpltCallback(UART_HandleTypeDef *huart)
{
  for (uint8_t i = 0; i < sizeof uart_rx_byte; i++) {
    if (huart == uart_bus[i]) {
      bsp_uart_rx_callback(i, uart_rx_byte[i]);
      HAL_UART_Receive_IT(huart, &uart_rx_byte[i], 1);
    }
  }
}

/* Taşma (overrun) gibi hatalarda HAL alımı durdurur; yeniden başlat. */
void HAL_UART_ErrorCallback(UART_HandleTypeDef *huart)
{
  for (uint8_t i = 0; i < sizeof uart_rx_byte; i++) {
    if (huart == uart_bus[i]) HAL_UART_Receive_IT(huart, &uart_rx_byte[i], 1);
  }
}
` : `
void bsp_uart_start_rx(uint8_t bus) { (void)bus; }
`}
void bsp_uart_irq(uint8_t bus)
{
${x.buses.uart.length ? '  HAL_UART_IRQHandler(uart_bus[bus]);' : '  (void)bus;'}
}

__attribute__((weak)) void bsp_uart_rx_callback(uint8_t bus, uint8_t byte)
{
  (void)bus;
  (void)byte;
}

void bsp_gpio_write(GPIO_TypeDef *port, uint16_t pin, int level)
{
  HAL_GPIO_WritePin(port, pin, level ? GPIO_PIN_SET : GPIO_PIN_RESET);
}

int bsp_gpio_read(GPIO_TypeDef *port, uint16_t pin)
{
  return HAL_GPIO_ReadPin(port, pin) == GPIO_PIN_SET;
}

void bsp_gpio_toggle(GPIO_TypeDef *port, uint16_t pin)
{
  HAL_GPIO_TogglePin(port, pin);
}

uint16_t bsp_adc_read(uint8_t channel)
{
${adc ? `  /* RTOS'ta birden çok task ADC okuyorsa bu fonksiyonu bir mutex ile koruyun. */
  extern ADC_HandleTypeDef ${handleOf(adc)};
  ADC_ChannelConfTypeDef c = {0};
  uint16_t v = 0;
  c.Channel = channel;
  c.Rank = 1;
  c.SamplingTime = ADC_SAMPLETIME_84CYCLES;
  if (HAL_ADC_ConfigChannel(&${handleOf(adc)}, &c) != HAL_OK) return 0;
  HAL_ADC_Start(&${handleOf(adc)});
  if (HAL_ADC_PollForConversion(&${handleOf(adc)}, 10) == HAL_OK) v = (uint16_t)HAL_ADC_GetValue(&${handleOf(adc)});
  HAL_ADC_Stop(&${handleOf(adc)});
  return v;` : '  (void)channel;\n  return 0;'}
}

void bsp_pwm_set(uint8_t timer, uint8_t channel, uint32_t compare)
{
${x.buses.pwm.length ? '  /* TIM_CHANNEL_1..4 = 0x0, 0x4, 0x8, 0xC */\n  __HAL_TIM_SET_COMPARE(pwm_bus[timer], (uint32_t)(channel - 1U) * 4U, compare);' : '  (void)timer; (void)channel; (void)compare;'}
}
`;
}

function halBoardSource(x, design, stamp) {
  const c = x.clock.config;
  const f = x.clock.freq;
  const ahbDiv = c.ahb === 1 ? 'RCC_SYSCLK_DIV1' : `RCC_SYSCLK_DIV${c.ahb}`;
  const osc = c.sysclkSource === 'HSI' && c.pllSource !== 'HSE'
    ? `osc.OscillatorType = RCC_OSCILLATORTYPE_HSI;
  osc.HSIState = RCC_HSI_ON;
  osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;`
    : `osc.OscillatorType = RCC_OSCILLATORTYPE_${c.pllSource === 'HSE' || c.sysclkSource === 'HSE' ? 'HSE' : 'HSI'};
  ${c.pllSource === 'HSE' || c.sysclkSource === 'HSE' ? 'osc.HSEState = RCC_HSE_ON;' : 'osc.HSIState = RCC_HSI_ON;\n  osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;'}`;
  const pll = c.sysclkSource === 'PLL'
    ? `osc.PLL.PLLState = RCC_PLL_ON;
  osc.PLL.PLLSource = RCC_PLLSOURCE_${c.pllSource};
  osc.PLL.PLLM = ${c.M};
  osc.PLL.PLLN = ${c.N};
  osc.PLL.PLLP = RCC_PLLP_DIV${c.P};
  osc.PLL.PLLQ = ${c.Q};`
    : 'osc.PLL.PLLState = RCC_PLL_NONE;';

  const gpio = x.pins.map((p) => {
    const mode = { af: p.otype === 'od' ? 'GPIO_MODE_AF_OD' : 'GPIO_MODE_AF_PP', analog: 'GPIO_MODE_ANALOG', out: 'GPIO_MODE_OUTPUT_PP', in: 'GPIO_MODE_INPUT' }[p.mode];
    const pull = { none: 'GPIO_NOPULL', up: 'GPIO_PULLUP' }[p.pull];
    const init = p.mode === 'out' ? `  HAL_GPIO_WritePin(GPIO${p.port}, GPIO_PIN_${p.n}, ${p.initHigh ? 'GPIO_PIN_SET' : 'GPIO_PIN_RESET'});\n` : '';
    return `  /* P${p.port}${p.n}: ${p.conn.signal} */
${init}  g.Pin = GPIO_PIN_${p.n};
  g.Mode = ${mode};
  g.Pull = ${pull};
  g.Speed = GPIO_SPEED_FREQ_VERY_HIGH;
  g.Alternate = ${p.af !== undefined ? `GPIO_AF${p.af}_${p.conn.peripheral}` : '0'};
  HAL_GPIO_Init(GPIO${p.port}, &g);`;
  });

  const inits = x.periphs.map(([name, p]) => {
    const h = handleOf(name);
    const clk = `__HAL_RCC_${name}_CLK_ENABLE();`;
    let body;
    if (p.type === 'i2c') {
      body = `${clk}
${h}.Instance = ${name};
${h}.Init.ClockSpeed = ${p.speedHz};
${h}.Init.DutyCycle = I2C_DUTYCYCLE_2;
${h}.Init.OwnAddress1 = 0;
${h}.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
${h}.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
${h}.Init.OwnAddress2 = 0;
${h}.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
${h}.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;
if (HAL_I2C_Init(&${h}) != HAL_OK) Error_Handler();`;
    } else if (p.type === 'spi') {
      const div = x.spiDiv(name, p.speedHz);
      body = `${clk}
${h}.Instance = ${name};
${h}.Init.Mode = SPI_MODE_MASTER;
${h}.Init.Direction = SPI_DIRECTION_2LINES;
${h}.Init.DataSize = SPI_DATASIZE_8BIT;
${h}.Init.CLKPolarity = SPI_POLARITY_LOW;
${h}.Init.CLKPhase = SPI_PHASE_1EDGE;
${h}.Init.NSS = SPI_NSS_SOFT;
${h}.Init.BaudRatePrescaler = SPI_BAUDRATEPRESCALER_${div}; /* ${(x.pclkOf(name) / div).toFixed(3)} MHz */
${h}.Init.FirstBit = SPI_FIRSTBIT_MSB;
${h}.Init.TIMode = SPI_TIMODE_DISABLE;
${h}.Init.CRCCalculation = SPI_CRCCALCULATION_DISABLE;
${h}.Init.CRCPolynomial = 10;
if (HAL_SPI_Init(&${h}) != HAL_OK) Error_Handler();`;
    } else if (p.type === 'uart') {
      const mode = p.pins.TX && p.pins.RX ? 'UART_MODE_TX_RX' : p.pins.TX ? 'UART_MODE_TX' : 'UART_MODE_RX';
      body = `${clk}
${h}.Instance = ${name};
${h}.Init.BaudRate = ${p.baud};
${h}.Init.WordLength = UART_WORDLENGTH_8B;
${h}.Init.StopBits = UART_STOPBITS_1;
${h}.Init.Parity = UART_PARITY_NONE;
${h}.Init.Mode = ${mode};
${h}.Init.HwFlowCtl = UART_HWCONTROL_NONE;
${h}.Init.OverSampling = UART_OVERSAMPLING_16;
if (HAL_UART_Init(&${h}) != HAL_OK) Error_Handler();
/* FreeRTOS uyumlu öncelik (configMAX_SYSCALL_INTERRUPT_PRIORITY = 5) */
HAL_NVIC_SetPriority(${name}_IRQn, 6, 0);
HAL_NVIC_EnableIRQ(${name}_IRQn);`;
    } else if (p.type === 'adc') {
      body = `${clk}
${h}.Instance = ${name};
${h}.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV${x.adcDiv}; /* ${(x.clock.freq.pclk2 / x.adcDiv).toFixed(2)} MHz */
${h}.Init.Resolution = ADC_RESOLUTION_12B;
${h}.Init.ScanConvMode = DISABLE;
${h}.Init.ContinuousConvMode = DISABLE;
${h}.Init.DiscontinuousConvMode = DISABLE;
${h}.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
${h}.Init.ExternalTrigConv = ADC_SOFTWARE_START;
${h}.Init.DataAlign = ADC_DATAALIGN_RIGHT;
${h}.Init.NbrOfConversion = 1;
${h}.Init.DMAContinuousRequests = DISABLE;
${h}.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
if (HAL_ADC_Init(&${h}) != HAL_OK) Error_Handler();`;
    } else if (p.type === 'pwm') {
      const t = x.timTiming(name, p.frequencyHz);
      const chans = p.channels.map((ch) => `TIM_CHANNEL_${ch.channel.replace('CH', '')}`);
      body = `TIM_OC_InitTypeDef oc = {0};
${clk}
${h}.Instance = ${name};
${h}.Init.Prescaler = ${t.psc}; /* ${(t.tick / 1e6).toFixed(3)} MHz sayaç */
${h}.Init.CounterMode = TIM_COUNTERMODE_UP;
${h}.Init.Period = ${t.arr}; /* ${p.frequencyHz} Hz */
${h}.Init.ClockDivision = TIM_CLOCKDIVISION_DIV1;
${h}.Init.AutoReloadPreload = TIM_AUTORELOAD_PRELOAD_ENABLE;
if (HAL_TIM_PWM_Init(&${h}) != HAL_OK) Error_Handler();
oc.OCMode = TIM_OCMODE_PWM1;
oc.Pulse = 0;
oc.OCPolarity = TIM_OCPOLARITY_HIGH;
oc.OCFastMode = TIM_OCFAST_DISABLE;
${chans.map((ch) => `if (HAL_TIM_PWM_ConfigChannel(&${h}, &oc, ${ch}) != HAL_OK) Error_Handler();\nHAL_TIM_PWM_Start(&${h}, ${ch});`).join('\n')}`;
    }
    return { fn: `MX_${name}_Init`, code: `static void MX_${name}_Init(void)\n{\n${indent(body)}\n}` };
  });

  return `${stamp}#include "board.h"

${x.periphs.map(([n, p]) => `${HAL_TYPE[p.type]} ${handleOf(n)};`).join('\n')}

/* SYSCLK ${f.sysclk} MHz, HCLK ${f.hclk} MHz, APB1 ${f.pclk1} MHz, APB2 ${f.pclk2} MHz, Flash ${x.clock.latency} WS */
static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = {0};
  RCC_ClkInitTypeDef clk = {0};

  __HAL_RCC_PWR_CLK_ENABLE();
  __HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);

  ${osc}
  ${pll}
  if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();

  clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2;
  clk.SYSCLKSource = RCC_SYSCLKSOURCE_${c.sysclkSource === 'PLL' ? 'PLLCLK' : c.sysclkSource};
  clk.AHBCLKDivider = ${ahbDiv};
  clk.APB1CLKDivider = RCC_HCLK_DIV${c.apb1};
  clk.APB2CLKDivider = RCC_HCLK_DIV${c.apb2};
  if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_${x.clock.latency}) != HAL_OK) Error_Handler();
}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};

${[...new Set(['H', ...x.ports])].sort().map((p) => `  __HAL_RCC_GPIO${p}_CLK_ENABLE();`).join('\n')}

${gpio.join('\n\n')}
}

${inits.map((i) => i.code).join('\n\n')}

void Board_Init(void)
{
  HAL_Init();
  SystemClock_Config();
  MX_GPIO_Init();
${inits.map((i) => `  ${i.fn}();`).join('\n')}
}

void Error_Handler(void)
{
  __disable_irq();
  while (1) {
  }
}
`;
}

// ------------------------------------------------------------------ Register (bare-metal)
const HPRE = { 1: 0, 2: 8, 4: 9, 8: 10, 16: 11, 64: 12, 128: 13, 256: 14, 512: 15 };
const PPRE = { 1: 0, 2: 4, 4: 5, 8: 6, 16: 7 };
const ENR = (periph, mcu) => {
  const bus = mcu.peripherals[periph].bus;
  return `RCC->${bus}ENR |= RCC_${bus}ENR_${periph}EN;`;
};

function regBspSource(x, stamp) {
  const list = (t) => x.buses[t].join(', ');
  const i2c = x.buses.i2c.length, spi = x.buses.spi.length, uart = x.buses.uart.length, pwm = x.buses.pwm.length;
  return `${stamp}#include "bsp.h"

#define BSP_TIMEOUT_MS 10U

volatile uint32_t bsp_ticks; /* SysTick_Handler her 1 ms'de artırır */

${i2c ? `static I2C_TypeDef *const i2c_bus[] = { ${list('i2c')} };` : ''}
${spi ? `static SPI_TypeDef *const spi_bus[] = { ${list('spi')} };` : ''}
${uart ? `static USART_TypeDef *const uart_bus[] = { ${list('uart')} };` : ''}
${pwm ? `static TIM_TypeDef *const pwm_bus[] = { ${list('pwm')} };` : ''}

uint32_t bsp_millis(void) { return bsp_ticks; }

void bsp_delay_ms(uint32_t ms)
{
  uint32_t start = bsp_ticks;
  while ((bsp_ticks - start) < ms) {
  }
}
${i2c ? `
/* ---- I2C (F4 eski tip I2C çevre birimi, yoklamalı) ---- */
static int i2c_wait(I2C_TypeDef *i2c, uint32_t flag)
{
  uint32_t start = bsp_ticks;
  while (!(i2c->SR1 & flag)) {
    if (i2c->SR1 & (I2C_SR1_AF | I2C_SR1_BERR | I2C_SR1_ARLO)) {
      i2c->SR1 &= ~(I2C_SR1_AF | I2C_SR1_BERR | I2C_SR1_ARLO);
      i2c->CR1 |= I2C_CR1_STOP;
      return -1;
    }
    if ((bsp_ticks - start) > BSP_TIMEOUT_MS) {
      i2c->CR1 |= I2C_CR1_STOP;
      return -1;
    }
  }
  return 0;
}

static int i2c_idle(I2C_TypeDef *i2c)
{
  uint32_t start = bsp_ticks;
  while ((i2c->SR2 & I2C_SR2_BUSY) || (i2c->CR1 & I2C_CR1_STOP)) {
    if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
  }
  return 0;
}

static int i2c_start(I2C_TypeDef *i2c, uint8_t addr8)
{
  i2c->CR1 |= I2C_CR1_START;
  if (i2c_wait(i2c, I2C_SR1_SB)) return -1;
  i2c->DR = addr8;
  return i2c_wait(i2c, I2C_SR1_ADDR);
}

int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  if (i2c_idle(i2c) || i2c_start(i2c, (uint8_t)(addr7 << 1))) return -1;
  (void)i2c->SR2; /* ADDR temizle */
  i2c->DR = reg;
  for (uint16_t i = 0; i < len; i++) {
    if (i2c_wait(i2c, I2C_SR1_TXE)) return -1;
    i2c->DR = buf[i];
  }
  if (i2c_wait(i2c, I2C_SR1_BTF)) return -1;
  i2c->CR1 |= I2C_CR1_STOP;
  return 0;
}

int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  if (len == 0) return 0;
  if (i2c_idle(i2c) || i2c_start(i2c, (uint8_t)(addr7 << 1))) return -1;
  (void)i2c->SR2;
  i2c->DR = reg;
  if (i2c_wait(i2c, I2C_SR1_BTF)) return -1;
  i2c->CR1 |= I2C_CR1_ACK;
  if (i2c_start(i2c, (uint8_t)((addr7 << 1) | 1U))) return -1; /* tekrarlı START */
  if (len == 1) {
    i2c->CR1 &= ~I2C_CR1_ACK;
    __disable_irq();
    (void)i2c->SR2;
    i2c->CR1 |= I2C_CR1_STOP;
    __enable_irq();
    if (i2c_wait(i2c, I2C_SR1_RXNE)) return -1;
    buf[0] = (uint8_t)i2c->DR;
    return 0;
  }
  (void)i2c->SR2;
  for (uint16_t i = 0; i < len; i++) {
    if (i2c_wait(i2c, I2C_SR1_RXNE)) return -1;
    if (i == len - 2U) {
      /* Sondan bir önceki byte: son byte'ı NACK + STOP ile bitir. Kesme araya girmesin. */
      __disable_irq();
      buf[i] = (uint8_t)i2c->DR;
      i2c->CR1 &= ~I2C_CR1_ACK;
      i2c->CR1 |= I2C_CR1_STOP;
      __enable_irq();
    } else {
      buf[i] = (uint8_t)i2c->DR;
    }
  }
  return 0;
}

int bsp_i2c_probe(uint8_t bus, uint8_t addr7)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  if (i2c_idle(i2c)) return -1;
  int r = i2c_start(i2c, (uint8_t)(addr7 << 1));
  (void)i2c->SR2;
  i2c->CR1 |= I2C_CR1_STOP;
  return r;
}
` : `
int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len) { (void)bus; (void)addr7; (void)reg; (void)buf; (void)len; return -1; }
int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len) { (void)bus; (void)addr7; (void)reg; (void)buf; (void)len; return -1; }
int bsp_i2c_probe(uint8_t bus, uint8_t addr7) { (void)bus; (void)addr7; return -1; }
`}
int bsp_spi_transfer(uint8_t bus, const uint8_t *tx, uint8_t *rx, uint16_t len)
{
${spi ? `  SPI_TypeDef *spi = spi_bus[bus];
  for (uint16_t i = 0; i < len; i++) {
    uint32_t start = bsp_ticks;
    while (!(spi->SR & SPI_SR_TXE)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
    *(volatile uint8_t *)&spi->DR = tx ? tx[i] : 0xFF;
    while (!(spi->SR & SPI_SR_RXNE)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
    uint8_t b = *(volatile uint8_t *)&spi->DR;
    if (rx) rx[i] = b;
  }
  while (spi->SR & SPI_SR_BSY) {
  }
  return 0;` : '  (void)bus; (void)tx; (void)rx; (void)len;\n  return -1;'}
}

int bsp_uart_write(uint8_t bus, const uint8_t *data, uint16_t len)
{
${uart ? `  USART_TypeDef *u = uart_bus[bus];
  for (uint16_t i = 0; i < len; i++) {
    uint32_t start = bsp_ticks;
    while (!(u->SR & USART_SR_TXE)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
    u->DR = data[i];
  }
  while (!(u->SR & USART_SR_TC)) {
  }
  return 0;` : '  (void)bus; (void)data; (void)len;\n  return -1;'}
}

void bsp_uart_start_rx(uint8_t bus)
{
${uart ? '  uart_bus[bus]->CR1 |= USART_CR1_RXNEIE;' : '  (void)bus;'}
}

void bsp_uart_irq(uint8_t bus)
{
${uart ? `  USART_TypeDef *u = uart_bus[bus];
  uint32_t sr = u->SR;
  if (sr & (USART_SR_RXNE | USART_SR_ORE)) {
    uint8_t b = (uint8_t)u->DR; /* SR sonra DR okumak ORE bayrağını da temizler */
    if (sr & USART_SR_RXNE) bsp_uart_rx_callback(bus, b);
  }` : '  (void)bus;'}
}

__attribute__((weak)) void bsp_uart_rx_callback(uint8_t bus, uint8_t byte)
{
  (void)bus;
  (void)byte;
}

void bsp_gpio_write(GPIO_TypeDef *port, uint16_t pin, int level)
{
  port->BSRR = level ? pin : ((uint32_t)pin << 16);
}

int bsp_gpio_read(GPIO_TypeDef *port, uint16_t pin)
{
  return (port->IDR & pin) != 0;
}

void bsp_gpio_toggle(GPIO_TypeDef *port, uint16_t pin)
{
  uint32_t odr = port->ODR;
  port->BSRR = ((odr & pin) << 16) | (~odr & pin);
}

uint16_t bsp_adc_read(uint8_t channel)
{
${x.buses.adc.length ? `  uint32_t start = bsp_ticks;
  ADC1->SQR3 = channel;
  ADC1->CR2 |= ADC_CR2_SWSTART;
  while (!(ADC1->SR & ADC_SR_EOC)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return 0;
  return (uint16_t)ADC1->DR;` : '  (void)channel;\n  return 0;'}
}

void bsp_pwm_set(uint8_t timer, uint8_t channel, uint32_t compare)
{
${pwm ? '  (&pwm_bus[timer]->CCR1)[channel - 1U] = compare;' : '  (void)timer; (void)channel; (void)compare;'}
}
`;
}

function regBoardSource(x, design, stamp) {
  const c = x.clock.config;
  const f = x.clock.freq;
  const mcu = x.mcu;
  const useHse = c.pllSource === 'HSE' || c.sysclkSource === 'HSE';
  const sw = { HSI: 'RCC_CFGR_SW_HSI', HSE: 'RCC_CFGR_SW_HSE', PLL: 'RCC_CFGR_SW_PLL' }[c.sysclkSource];
  const sws = { HSI: 'RCC_CFGR_SWS_HSI', HSE: 'RCC_CFGR_SWS_HSE', PLL: 'RCC_CFGR_SWS_PLL' }[c.sysclkSource];
  const MODE = { in: 0, out: 1, af: 2, analog: 3 };
  const gpio = x.pins.map((p) => {
    const pre = p.mode === 'out' ? `  GPIO${p.port}->BSRR = ${p.initHigh ? `1U << ${p.n}` : `1U << (${p.n} + 16)`};\n` : '';
    return `${pre}  gpio_config(GPIO${p.port}, ${p.n}, ${MODE[p.mode]}U, ${p.otype === 'od' ? 1 : 0}U, ${p.pull === 'up' ? 1 : 0}U, ${p.af ?? 0}U); /* ${p.conn.signal} */`;
  });

  const inits = x.periphs.map(([name, p]) => {
    let body;
    if (p.type === 'i2c') {
      const pclk = Math.round(x.pclkOf(name));
      const fast = p.speedHz > 100000;
      const ccr = fast ? Math.max(1, Math.ceil((x.pclkOf(name) * 1e6) / (3 * p.speedHz))) : Math.max(4, Math.ceil((x.pclkOf(name) * 1e6) / (2 * p.speedHz)));
      const trise = fast ? Math.floor((pclk * 300) / 1000) + 1 : pclk + 1;
      body = `${ENR(name, mcu)}
${name}->CR1 = I2C_CR1_SWRST;
${name}->CR1 = 0;
${name}->CR2 = ${pclk}U; /* PCLK1 MHz */
${name}->CCR = ${fast ? 'I2C_CCR_FS | ' : ''}${ccr}U; /* ${p.speedHz / 1000} kHz */
${name}->TRISE = ${trise}U;
${name}->CR1 = I2C_CR1_PE;`;
    } else if (p.type === 'spi') {
      const div = x.spiDiv(name, p.speedHz);
      body = `${ENR(name, mcu)}
${name}->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | (${Math.log2(div) - 1}U << SPI_CR1_BR_Pos); /* /${div} = ${(x.pclkOf(name) / div).toFixed(3)} MHz, mod 0 */
${name}->CR1 |= SPI_CR1_SPE;`;
    } else if (p.type === 'uart') {
      const brr = Math.round((x.pclkOf(name) * 1e6) / p.baud);
      body = `${ENR(name, mcu)}
${name}->BRR = ${brr}U; /* ${p.baud} baud @ ${x.pclkOf(name)} MHz */
${name}->CR1 = ${p.pins.TX ? 'USART_CR1_TE | ' : ''}${p.pins.RX ? 'USART_CR1_RE | ' : ''}USART_CR1_UE;
NVIC_SetPriority(${name}_IRQn, 6); /* FreeRTOS: configMAX_SYSCALL_INTERRUPT_PRIORITY (5) altı */
NVIC_EnableIRQ(${name}_IRQn);`;
    } else if (p.type === 'adc') {
      const pre = { 2: 0, 4: 1, 6: 2, 8: 3 }[x.adcDiv];
      body = `${ENR(name, mcu)}
ADC1_COMMON->CCR = (ADC1_COMMON->CCR & ~ADC_CCR_ADCPRE) | (${pre}U << ADC_CCR_ADCPRE_Pos); /* PCLK2/${x.adcDiv} */
${name}->CR1 = 0; /* 12 bit */
${name}->SMPR2 = 0x24924924U; /* kanal 0-9: 84 döngü örnekleme */
${name}->SMPR1 = 0x00924924U; /* kanal 10-17: 84 döngü örnekleme */
${name}->CR2 = ADC_CR2_ADON;`;
    } else if (p.type === 'pwm') {
      const t = x.timTiming(name, p.frequencyHz);
      const lines = p.channels.map((ch) => {
        const n = Number(ch.channel.replace('CH', ''));
        const reg = n <= 2 ? 'CCMR1' : 'CCMR2';
        const shift = n % 2 === 1 ? 0 : 8;
        return `${name}->${reg} |= (6U << ${shift + 4}) | (1U << ${shift + 3}); /* CH${n}: PWM mod 1, önyükleme */
${name}->CCER |= 1U << ${(n - 1) * 4};`;
      });
      body = `${ENR(name, mcu)}
${name}->PSC = ${t.psc}U; /* ${(t.tick / 1e6).toFixed(3)} MHz sayaç */
${name}->ARR = ${t.arr}U; /* ${p.frequencyHz} Hz */
${lines.join('\n')}
${name}->CR1 = TIM_CR1_ARPE;
${name}->EGR = TIM_EGR_UG;
${name}->CR1 |= TIM_CR1_CEN;`;
    }
    return { fn: `init_${name.toLowerCase()}`, code: `static void init_${name.toLowerCase()}(void)\n{\n${indent(body)}\n}` };
  });

  const ports = [...new Set(x.ports)];
  return `${stamp}#include "board.h"

/* SYSCLK ${f.sysclk} MHz, HCLK ${f.hclk} MHz, APB1 ${f.pclk1} MHz, APB2 ${f.pclk2} MHz, Flash ${x.clock.latency} WS */
static void clock_init(void)
{
  uint32_t start;
  RCC->APB1ENR |= RCC_APB1ENR_PWREN;
  PWR->CR |= PWR_CR_VOS; /* Ölçek 1: en yüksek frekans */
${useHse ? `  RCC->CR |= RCC_CR_HSEON;
  for (start = 0; !(RCC->CR & RCC_CR_HSERDY); start++) {
    if (start > 1000000U) Error_Handler(); /* kristal başlamadı */
  }
` : ''}  FLASH->ACR = FLASH_ACR_PRFTEN | FLASH_ACR_ICEN | FLASH_ACR_DCEN | (${x.clock.latency}U << FLASH_ACR_LATENCY_Pos);
  RCC->CFGR = (${HPRE[c.ahb]}U << RCC_CFGR_HPRE_Pos) | (${PPRE[c.apb1]}U << RCC_CFGR_PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_CFGR_PPRE2_Pos);
${c.sysclkSource === 'PLL' ? `  RCC->PLLCFGR = (${c.M}U << RCC_PLLCFGR_PLLM_Pos) | (${c.N}U << RCC_PLLCFGR_PLLN_Pos) | (${c.P / 2 - 1}U << RCC_PLLCFGR_PLLP_Pos) |
                 (${c.Q}U << RCC_PLLCFGR_PLLQ_Pos)${c.pllSource === 'HSE' ? ' | RCC_PLLCFGR_PLLSRC_HSE' : ''};
  RCC->CR |= RCC_CR_PLLON;
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
` : ''}  RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_SW) | ${sw};
  while ((RCC->CFGR & RCC_CFGR_SWS) != ${sws}) {
  }
  SystemCoreClockUpdate();
}

/* mode: 0 giriş, 1 çıkış, 2 alternatif, 3 analog | od: open-drain | pullup | af: alternatif fonksiyon */
static void gpio_config(GPIO_TypeDef *p, uint32_t pin, uint32_t mode, uint32_t od, uint32_t pullup, uint32_t af)
{
  p->AFR[pin >> 3] = (p->AFR[pin >> 3] & ~(0xFU << ((pin & 7U) * 4U))) | (af << ((pin & 7U) * 4U));
  p->OTYPER = (p->OTYPER & ~(1U << pin)) | (od << pin);
  p->OSPEEDR |= 3U << (pin * 2U);
  p->PUPDR = (p->PUPDR & ~(3U << (pin * 2U))) | (pullup << (pin * 2U));
  p->MODER = (p->MODER & ~(3U << (pin * 2U))) | (mode << (pin * 2U));
}

static void gpio_init(void)
{
  RCC->AHB1ENR |= ${ports.length ? ports.map((p) => `RCC_AHB1ENR_GPIO${p}EN`).join(' | ') : '0'};
  (void)RCC->AHB1ENR; /* saat açıldıktan sonra kısa gecikme */
${gpio.join('\n')}
}

${inits.map((i) => i.code).join('\n\n')}

void Board_Init(void)
{
  clock_init();
  SysTick_Config(SystemCoreClock / 1000U); /* 1 ms tick */
  gpio_init();
${inits.map((i) => `  ${i.fn}();`).join('\n')}
}

void Error_Handler(void)
{
  __disable_irq();
  while (1) {
  }
}
`;
}

// ------------------------------------------------------------------ kesmeler
function itSource(x, design, framework, stamp, user) {
  const uartIrqs = x.buses.uart.map((p) => `void ${p}_IRQHandler(void)\n{\n  bsp_uart_irq(${x.busId(p)});\n}`);
  const tick = framework === 'hal' ? '  HAL_IncTick();' : '  bsp_ticks++;';
  return `${stamp}#include "bsp.h"
${design.rtos ? '#include "FreeRTOS.h"\n#include "task.h"\n\nextern void xPortSysTickHandler(void);\n' : ''}${framework === 'register' ? 'extern volatile uint32_t bsp_ticks;\n' : ''}${user('Includes')}

void NMI_Handler(void) { while (1) {} }
void HardFault_Handler(void) { while (1) {} }
void MemManage_Handler(void) { while (1) {} }
void BusFault_Handler(void) { while (1) {} }
void UsageFault_Handler(void) { while (1) {} }
void DebugMon_Handler(void) {}
${design.rtos ? '/* SVC_Handler ve PendSV_Handler FreeRTOSConfig.h içinde port fonksiyonlarına yönlendirildi. */' : 'void SVC_Handler(void) {}\nvoid PendSV_Handler(void) {}'}

void SysTick_Handler(void)
{
${tick}
${design.rtos ? '  if (xTaskGetSchedulerState() != taskSCHEDULER_NOT_STARTED) {\n    xPortSysTickHandler();\n  }\n' : ''}${indent(user('SysTick'))}
}

${uartIrqs.join('\n\n')}

${user('Handlers')}
`;
}

/**
 * Profesyonel bare-metal: tasarıma bağlı kesmeler (SysTick, UART, RTOS'a göre SVC/PendSV) üretilen bu dosyada durur;
 * kullanıcıya ait stm32f4xx_it.c (faultStarter) sadece hata işleyicilerini içerir ve bir daha yazılmaz.
 */
function irqSource(x, design, stamp) {
  const uartIrqs = x.buses.uart.map((p) => `void ${p}_IRQHandler(void)\n{\n  bsp_uart_irq(${x.busId(p)});\n}`);
  return `${stamp}#include "bsp.h"
${design.rtos ? '#include "FreeRTOS.h"\n#include "task.h"\n\nextern void xPortSysTickHandler(void);\n' : ''}extern volatile uint32_t bsp_ticks;

/* Kendi 1 ms işinizi eklemek için bu weak fonksiyonu kendi dosyanızda tanımlayın. */
__attribute__((weak)) void bsp_systick_hook(void) {}

void SysTick_Handler(void)
{
  bsp_ticks++;
${design.rtos ? '  if (xTaskGetSchedulerState() != taskSCHEDULER_NOT_STARTED) {\n    xPortSysTickHandler();\n  }\n' : ''}  bsp_systick_hook();
}
${design.rtos ? '\n/* SVC_Handler ve PendSV_Handler FreeRTOSConfig.h içinde port fonksiyonlarına yönlendirildi. */\n' : '\nvoid SVC_Handler(void) {}\nvoid PendSV_Handler(void) {}\n'}
${uartIrqs.join('\n\n')}
`;
}

/** Profesyonel bare-metal: hata işleyicileri. Kendi kesmelerinizi Handlers bloğuna yazın; SysTick/UART bsp_irq.c'de. */
function faultStarter(stamp, user) {
  return `${stamp}#include "bsp.h"
${user('Includes')}

void NMI_Handler(void) { while (1) {} }
void HardFault_Handler(void) { while (1) {} }
void MemManage_Handler(void) { while (1) {} }
void BusFault_Handler(void) { while (1) {} }
void UsageFault_Handler(void) { while (1) {} }
void DebugMon_Handler(void) {}

${user('Handlers')}
`;
}

module.exports = { makeContext, boardHeader, bspHeader, halBspSource, halBoardSource, regBspSource, regBoardSource, itSource, irqSource, faultStarter, cIdent, handleOf, indent };
