// @ts-check
/**
 * BSP (board support) katmanı üretimi: board.h, bsp.h, bsp.c, board.c, <aile>_it.c
 * İki altyapı: 'hal' (STM32 HAL) ve 'register' (CMSIS başlıklarıyla doğrudan register erişimi).
 * Sürücüler ve uygulama kodu sadece bsp.h API'sini görür. Aileye göre değişen kod: halcode.js, regcode.js.
 */
const { parseSignal } = require('../engine/pinAssigner');
const { familyOf, kernelClock, timerClock } = require('./families');
const reg = require('./regcode');
const hal = require('./halcode');

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
  const fam = familyOf(mcu);
  /** Çevre biriminin çekirdek saati (MHz): APB saati ya da aileye özgü kaynak (F0/F3 I2C → HSI, H7 SPI1-3 → PLL1Q) */
  const pclkOf = (periph) => f[kernelClock(mcu, periph)];
  const timclkOf = (periph) => f[timerClock(mcu, periph)];

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
  // ADC saati (PCLK2 bölücüsü): F4/F7 en fazla 36 MHz, F1 en fazla 14 MHz.
  const adcMax = fam.ip.adc === 'f1' ? 14 : 36;
  const adcDiv = [2, 4, 6, 8].find((d) => f.pclk2 / d <= adcMax) || 8;
  const adcChannels = [...new Set(result.connections.filter((c) => c.kind === 'adc').map((c) => Number(parseSignal(c.signal).fn.replace('IN', ''))))].sort((a, b) => a - b);

  return { mcu, fam, periphs, buses, busId, pclkOf, timclkOf, pins, ports, spiDiv, timTiming, adcDiv, adcChannels, clock, label, pinName };
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
  // ES-1003: kullanıcı pin etiketleri (CubeMX biçimi)
  const labelDefs = Object.entries(result.pinLabels || {}).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true }))
    .map(([pin, l]) => `#define ${l}_Pin ${framework === 'hal' ? `GPIO_PIN_${Number(pin.slice(2))}` : `(1U << ${Number(pin.slice(2))})`}\n#define ${l}_GPIO_Port GPIO${pin[1]}`);
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

${labelDefs.length ? `/* ---- Pin etiketleri (Pinout > Etiket gir; CubeMX'teki User Label) ---- */
${labelDefs.join('\n')}

` : ''}/* ---- I2C adresleri (7-bit) ---- */
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
${adc ? hal.adcRead(x, handleOf(adc), x.adcChannels) : '  (void)channel;\n  return 0;'}
}

void bsp_pwm_set(uint8_t timer, uint8_t channel, uint32_t compare)
{
${x.buses.pwm.length ? '  /* TIM_CHANNEL_1..4 = 0x0, 0x4, 0x8, 0xC */\n  __HAL_TIM_SET_COMPARE(pwm_bus[timer], (uint32_t)(channel - 1U) * 4U, compare);' : '  (void)timer; (void)channel; (void)compare;'}
}
`;
}

function halBoardSource(x, design, stamp) {
  const v1 = x.fam.ip.gpio === 'v1';
  const gpio = x.pins.map((p) => {
    // F1'de alternatif fonksiyonun giriş tarafı (RX, MISO) giriş olarak yapılandırılır
    const afIn = v1 && p.mode === 'af' && /_(RX|MISO)$/.test(p.conn.signal);
    const mode = afIn ? 'GPIO_MODE_INPUT' : { af: p.otype === 'od' ? 'GPIO_MODE_AF_OD' : 'GPIO_MODE_AF_PP', analog: 'ES_GPIO_MODE_ADC', out: 'GPIO_MODE_OUTPUT_PP', in: 'GPIO_MODE_INPUT' }[p.mode];
    const pull = { none: 'GPIO_NOPULL', up: 'GPIO_PULLUP' }[p.pull];
    const init = p.mode === 'out' ? `  HAL_GPIO_WritePin(GPIO${p.port}, GPIO_PIN_${p.n}, ${p.initHigh ? 'GPIO_PIN_SET' : 'GPIO_PIN_RESET'});\n` : '';
    const alt = v1 ? '' : `\n  g.Alternate = ${p.af !== undefined ? `${p.af}; /* AF${p.af}: ${p.conn.peripheral} */` : '0;'}`;
    return `  /* P${p.port}${p.n}: ${p.conn.signal} */
${init}  g.Pin = GPIO_PIN_${p.n};
  g.Mode = ${mode};
  g.Pull = ${pull};
  g.Speed = ${x.fam.halSpeed};${alt}
  HAL_GPIO_Init(GPIO${p.port}, &g);`;
  });

  const inits = x.periphs.map(([name, p]) => {
    const h = handleOf(name);
    // Saat makrosu RCC bitinin adından: ADC1 → __HAL_RCC_ADC12_CLK_ENABLE (G4/H7/U5), __HAL_RCC_ADC_CLK_ENABLE (G0/L4)
    const enrName = p.type === 'adc' && x.mcu.peripherals[name].enrBit ? x.mcu.peripherals[name].enrBit.replace(/^RCC_\w+?_(\w+)EN$/, '$1') : name;
    const clk = `__HAL_RCC_${enrName}_CLK_ENABLE();`;
    let body;
    if (p.type === 'i2c') {
      body = `${clk}
${h}.Instance = ${name};
${hal.i2cInit(x, name, p, h)}
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
${h}.Init.CRCPolynomial = 7;${x.fam.ip.spi === 'v2' ? `
${h}.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;
${h}.Init.MasterKeepIOState = SPI_MASTER_KEEP_IO_STATE_ENABLE;` : x.fam.ip.spi === 'fifo' ? `
${h}.Init.NSSPMode = SPI_NSS_PULSE_DISABLE;` : ''}
if (HAL_SPI_Init(&${h}) != HAL_OK) Error_Handler();`;
    } else if (p.type === 'uart') {
      const mode = p.pins.TX && p.pins.RX ? 'UART_MODE_TX_RX' : p.pins.TX ? 'UART_MODE_TX' : 'UART_MODE_RX';
      const irq = reg.irqOf(x, name);
      body = `${clk}
${h}.Instance = ${name};
${h}.Init.BaudRate = ${p.baud};
${h}.Init.WordLength = UART_WORDLENGTH_8B;
${h}.Init.StopBits = UART_STOPBITS_1;
${h}.Init.Parity = UART_PARITY_NONE;
${h}.Init.Mode = ${mode};
${h}.Init.HwFlowCtl = UART_HWCONTROL_NONE;
#if defined(USART_CR1_OVER8)
${h}.Init.OverSampling = UART_OVERSAMPLING_16;
#endif
if (HAL_UART_Init(&${h}) != HAL_OK) Error_Handler();
/* FreeRTOS uyumlu öncelik (configMAX_SYSCALL_INTERRUPT_PRIORITY = 5) */
HAL_NVIC_SetPriority(${irq}_IRQn, 6, 0);
HAL_NVIC_EnableIRQ(${irq}_IRQn);`;
    } else if (p.type === 'adc') {
      body = `${clk}
${h}.Instance = ${name};
${hal.adcInit(x, name, h)}`;
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
    // Kenar durumu: bodyde #if satırları girintisiz kalmalı
    return { fn: `MX_${name}_Init`, code: `static void MX_${name}_Init(void)\n{\n${indent(body).replace(/^ +#/gm, '#')}\n}` };
  });

  const oscPort = x.mcu.device.oscPort || 'H';
  return `${stamp}#include "board.h"

/* L47x: ADC pinleri analog anahtarla bağlanır */
#if defined(GPIO_MODE_ANALOG_ADC_CONTROL)
#define ES_GPIO_MODE_ADC GPIO_MODE_ANALOG_ADC_CONTROL
#else
#define ES_GPIO_MODE_ADC GPIO_MODE_ANALOG
#endif

${x.periphs.map(([n, p]) => `${HAL_TYPE[p.type]} ${handleOf(n)};`).join('\n')}

${hal.systemClock(x)}

static void MX_GPIO_Init(void)
{
  GPIO_InitTypeDef g = {0};

${[...new Set([oscPort, ...x.ports])].sort().map((p) => `  __HAL_RCC_GPIO${p}_CLK_ENABLE();`).join('\n')}
${v1 ? '  __HAL_RCC_AFIO_CLK_ENABLE();\n  __HAL_AFIO_REMAP_SWJ_NOJTAG(); /* SWD kalır; PA15, PB3, PB4 serbest */\n' : ''}
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
function regBspSource(x, stamp) {
  const list = (t) => x.buses[t].join(', ');
  const i2c = x.buses.i2c.length, spi = x.buses.spi.length, uart = x.buses.uart.length, pwm = x.buses.pwm.length;
  const u = reg.uartFunctions(x);
  return `${stamp}#include "bsp.h"

${reg.COMPAT}
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
${reg.i2cFunctions(x)}
int bsp_spi_transfer(uint8_t bus, const uint8_t *tx, uint8_t *rx, uint16_t len)
{
${reg.spiFunction(x)}
}

int bsp_uart_write(uint8_t bus, const uint8_t *data, uint16_t len)
{
${u.write}
}

void bsp_uart_start_rx(uint8_t bus)
{
${uart ? '  uart_bus[bus]->CR1 |= USART_CR1_RXNEIE;' : '  (void)bus;'}
}

void bsp_uart_irq(uint8_t bus)
{
${u.irq}
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
${reg.adcFunction(x)}
}

void bsp_pwm_set(uint8_t timer, uint8_t channel, uint32_t compare)
{
${pwm ? '  (&pwm_bus[timer]->CCR1)[channel - 1U] = compare;' : '  (void)timer; (void)channel; (void)compare;'}
}
`;
}

function regBoardSource(x, design, stamp) {
  const inits = x.periphs.map(([name, p]) => ({ fn: `init_${name.toLowerCase()}`, code: `static void init_${name.toLowerCase()}(void)\n{\n${indent(reg.periphInit(x, name, p)).replace(/^ +#/gm, '#')}\n}` }));
  return `${stamp}#include "board.h"

${reg.clockInit(x)}

${reg.gpioConfig(x)}

${reg.gpioInit(x)}

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
/** UART kesme işleyicileri; aynı IRQ'yu paylaşan birimler (ör. G0 USART3_4_LPUART1) tek işleyicide. */
function uartHandlers(x) {
  const groups = new Map();
  for (const p of x.buses.uart) {
    const irq = reg.irqOf(x, p);
    groups.set(irq, [...(groups.get(irq) || []), p]);
  }
  return [...groups].map(([irq, list]) => `void ${irq}_IRQHandler(void)\n{\n${list.map((p) => `  bsp_uart_irq(${x.busId(p)});`).join('\n')}\n}`);
}

function itSource(x, design, framework, stamp, user) {
  const uartIrqs = uartHandlers(x);
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
  const uartIrqs = uartHandlers(x);
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
