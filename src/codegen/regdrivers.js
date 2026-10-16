// @ts-check
/**
 * ES-107: register seviyesinde örnek çevre birimi sürücüleri (drivers/reg/es_*.c/h).
 *
 * - Sadece CMSIS cihaz başlığına bağlıdır (DMA kullanan UART/ADC işlevleri es_dma.h'yi de kullanır).
 * - Projenin işlemcisine göre üretilir: aile farkları (F1 GPIO'nun CRL/CRH'si, TIMINGR'li I2C, DMAMUX …) ayrı
 *   kod yollarıyla, okunabilirlik için tek ailenin kodu yazılır. Her dosyanın başında açıklama, kullanım örneği ve
 *   ilgili reference manual bölümü bulunur.
 * - Bir kez oluşturulur ('once'), sonra kullanıcınındır: kopyalanabilir, değiştirilebilir.
 */
const { familyOf } = require('./families');
const reg = require('./regcode');

/** Reference manual bölüm başlıkları (ST'nin kullandığı adlar). Bölüm numaraları data/rm-sections.json'dan (varsa). */
const CHAPTER = {
  rcc: 'Reset and clock control (RCC)', gpio: 'General-purpose I/Os (GPIO)', exti: 'Extended interrupts and events controller (EXTI)',
  syscfg: 'System configuration controller (SYSCFG)', afio: 'Alternate function I/Os (AFIO)', uart: 'Universal synchronous/asynchronous receiver transmitter (USART)',
  spi: 'Serial peripheral interface (SPI)', i2c: 'Inter-integrated circuit (I2C) interface', tim: 'General-purpose timers (TIMx)',
  adc: 'Analog-to-digital converter (ADC)', dac: 'Digital-to-analog converter (DAC)', dma: 'Direct memory access controller (DMA)',
  dmamux: 'DMA request multiplexer (DMAMUX)', gpdma: 'General purpose direct memory access controller (GPDMA)', iwdg: 'Independent watchdog (IWDG)',
  wwdg: 'System window watchdog (WWDG)', crc: 'Cyclic redundancy check calculation unit (CRC)', flash: 'Embedded flash memory (FLASH)'
};

let SECTIONS = {};
try {
  SECTIONS = require('../../data/rm-sections.json');
} catch {
  SECTIONS = {};
}

/** Sürücü listesi: arayüz ve üretim için. requires: birlikte üretilmesi gereken sürücüler. */
const DRIVERS = [
  { id: 'rcc', title: 'RCC / saat', desc: 'Saat ağacı kurulumu (bu projenin Clock ayarı) ve HCLK/PCLK frekanslarını register\'lardan okuma.' },
  { id: 'gpio', title: 'GPIO', desc: 'Pin modu, çekme direnci, çıkış tipi, alternatif fonksiyon; yazma/okuma/tersleme.' },
  { id: 'exti', title: 'EXTI', desc: 'GPIO pin kesmesi: kenar seçimi, bayrak, NVIC kesme numarası.', requires: ['gpio'] },
  { id: 'uart', title: 'UART', desc: 'Yoklamalı gönderme/alma, kesmeyle halka tampona alma, DMA ile gönderme.', requires: ['dma'] },
  { id: 'spi', title: 'SPI', desc: 'Master, mod 0-3, bölücü; tam çift yönlü aktarım.' },
  { id: 'i2c', title: 'I2C', desc: 'Master; 100/400 kHz zamanlaması çalışma anında hesaplanır; yazma, okuma, register okuma/yazma.' },
  { id: 'tim', title: 'TIM', desc: 'PWM, input capture (periyot ölçümü), encoder modu.' },
  { id: 'adc', title: 'ADC', desc: 'Tek kanal okuma ve DMA ile sürekli çok kanallı tarama.', requires: ['dma'] },
  { id: 'dac', title: 'DAC', desc: '12 bit DAC çıkışı (kanal 1/2).', needs: (m) => !!m.device.ll.dac },
  { id: 'dma', title: 'DMA', desc: 'Çevre ↔ bellek aktarımı; bu işlemci için UART, ADC ve SPI istek eşlemeleri hazır.' },
  { id: 'iwdg', title: 'IWDG', desc: 'Bağımsız watchdog: milisaniye cinsinden zaman aşımı, besleme.' },
  { id: 'wwdg', title: 'WWDG', desc: 'Pencereli watchdog: sayaç ve pencere ayarı.' },
  { id: 'crc', title: 'CRC', desc: 'Donanım CRC-32 (polinom 0x04C11DB7).' },
  { id: 'flash', title: 'FLASH', desc: 'Kilit açma, sayfa/sektör silme, programlama (bu işlemcinin flash düzeniyle).' }
];

/** Seçilen sürücüler + bağımlılıkları, bu işlemcide olmayanlar hariç. */
function resolveDrivers(mcu, ids) {
  const out = new Set();
  const add = (id) => {
    const d = DRIVERS.find((x) => x.id === id);
    if (!d || out.has(id) || (d.needs && !d.needs(mcu))) return;
    out.add(id);
    (d.requires || []).forEach(add);
  };
  (ids || []).forEach(add);
  return DRIVERS.map((d) => d.id).filter((id) => out.has(id));
}

const hex = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0') + 'U';

function context(mcu, clock) {
  const fam = familyOf(mcu);
  const rm = ((mcu.referenceManual || '').match(/\/(rm\d+)/i) || [])[1];
  const ll = mcu.device.ll || {};
  return { mcu, fam, k: fam.key, ll, rm: rm ? rm.toUpperCase() : null, clock, header: fam.cmsisHeader };
}

/** "RM0090 §8 General-purpose I/Os (GPIO)" (bölüm numarası bilinmiyorsa sadece başlık) */
function rmRef(x, ...keys) {
  keys = [...new Set(keys)];
  if (!x.rm) return keys.map((k) => CHAPTER[k]).join('; ');
  return keys.map((k) => {
    const sec = (SECTIONS[x.rm] || {})[k];
    return `${x.rm}${sec ? ` §${sec}` : ''} "${CHAPTER[k]}"`;
  }).join('; ');
}

/** Dosya başlığı */
function banner(x, file, what, keys, usage) {
  // Örnek kod blok yorumun içinde: iç /* … */ yorumları // biçimine çevir (iç içe yorum olmaz)
  if (usage) usage = usage.replace(/\/\*\s*/g, '// ').replace(/\s*\*\//g, '');
  return `/*
 * ${file} — ${what}
 * Embedded Studio örnek register sürücüsü · ${x.mcu.name} (${x.fam.series})
 *
 * Bu dosya bir kez oluşturuldu ve artık sizindir: Embedded Studio buna bir daha yazmaz. Sadece CMSIS cihaz
 * başlığına (${x.header}) bağlıdır; başka projeye kopyalayıp değiştirebilirsiniz.
 * Kaynak: ${rmRef(x, ...keys)}
 * Gerçek kartta denenmemiştir; kritik kullanımda reference manual ile doğrulayın.
${usage ? ` *\n * Kullanım:\n${usage.split('\n').map((l) => ` *   ${l}`.trimEnd()).join('\n')}\n` : ''} */
`;
}

/** RCC saat açma satırı (MCU tanımındaki enr/enrBit; elle girilmiş F411 tanımında bus adından) */
const enableLine = (x, name) => {
  const p = x.mcu.peripherals[name];
  return p.enr ? `RCC->${p.enr} |= ${p.enrBit};` : `RCC->${p.bus}ENR |= RCC_${p.bus}ENR_${name}EN;`;
};

/** Türdeki tüm çevre birimleri için saat açma fonksiyonu gövdesi */
function clockSwitch(x, type, arg) {
  const names = Object.entries(x.mcu.peripherals).filter(([, p]) => p.type === type).map(([n]) => n)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const lines = names.map((n) => `#if defined(${n})\n  if (${arg} == ${n}) ${enableLine(x, n)}\n#endif`);
  return `${lines.join('\n')}\n  (void)RCC->CR; /* saat açıldıktan sonra kısa gecikme */`;
}

const guard = (name) => `ES_${name.toUpperCase()}_H`;
const header = (x, name, body) => `#ifndef ${guard(name)}
#define ${guard(name)}

#include "${x.header}"
#include <stdint.h>

#ifndef ES_TIMEOUT
#define ES_TIMEOUT 1000000U /* yoklama döngüsü üst sınırı (döngü sayısı) */
#endif

${body}
#endif
`;

// ================================================================== RCC
function rcc(x) {
  const k = x.k;
  // Bölücü kodları: AHB 0xxx=/1, 1000=/2 … ; APB 0xx=/1, 100=/2 …
  let regs;
  if (k === 'h7') regs = { hpre: 'RCC->D1CFGR & RCC_D1CFGR_HPRE) >> RCC_D1CFGR_HPRE_Pos', p1: 'RCC->D2CFGR & RCC_D2CFGR_D2PPRE1) >> RCC_D2CFGR_D2PPRE1_Pos', p2: 'RCC->D2CFGR & RCC_D2CFGR_D2PPRE2) >> RCC_D2CFGR_D2PPRE2_Pos' };
  else if (k === 'u5') regs = { hpre: 'RCC->CFGR2 & RCC_CFGR2_HPRE) >> RCC_CFGR2_HPRE_Pos', p1: 'RCC->CFGR2 & RCC_CFGR2_PPRE1) >> RCC_CFGR2_PPRE1_Pos', p2: 'RCC->CFGR2 & RCC_CFGR2_PPRE2) >> RCC_CFGR2_PPRE2_Pos' };
  else if (x.fam.apbCount === 1) regs = { hpre: 'RCC->CFGR & RCC_CFGR_HPRE) >> RCC_CFGR_HPRE_Pos', p1: 'RCC->CFGR & RCC_CFGR_PPRE) >> RCC_CFGR_PPRE_Pos', p2: null };
  else regs = { hpre: 'RCC->CFGR & RCC_CFGR_HPRE) >> RCC_CFGR_HPRE_Pos', p1: 'RCC->CFGR & RCC_CFGR_PPRE1) >> RCC_CFGR_PPRE1_Pos', p2: 'RCC->CFGR & RCC_CFGR_PPRE2) >> RCC_CFGR_PPRE2_Pos' };
  const c = x.clock.config, f = x.clock.freq;
  const init = reg.clockInit({ mcu: x.mcu, fam: x.fam, clock: x.clock })
    .replace('static void clock_init(void)', 'int es_clock_init(void)')
    .replace('Error_Handler(); /* kristal başlamadı */', 'return -1; /* kristal başlamadı */')
    .replace(/  SystemCoreClockUpdate\(\);\n}$/, '  SystemCoreClockUpdate();\n  return 0;\n}');
  const h = header(x, 'rcc', `/* Saat ağacını kurar (oluşturulduğu andaki Clock ayarı: ${c.sysclkSource === 'PLL' ? `${c.pllSource} → PLL` : c.sysclkSource}, SYSCLK ${f.sysclk} MHz).
 * Board_Init() zaten aynı kurulumu yapar; bu fonksiyon kendi başlatma akışınızı yazmak isterseniz içindir.
 * Dönüş: 0 başarılı, -1 HSE kristali başlamadı. */
int es_clock_init(void);

/* Register'lardan okunan güncel frekanslar (Hz). SystemCoreClockUpdate() çağrılmış olmalı. */
uint32_t es_rcc_hclk_hz(void);
uint32_t es_rcc_pclk1_hz(void);
uint32_t es_rcc_pclk2_hz(void);
/* AHB bölücüsü (bilgi için: SystemCoreClock zaten bölünmüş HCLK değeridir) */
uint32_t es_rcc_ahb_div(void);
`);
  const cfile = `${banner(x, 'es_rcc.c', 'saat ağacı ve frekans okuma', ['rcc'], 'es_clock_init();\nuint32_t pclk1 = es_rcc_pclk1_hz(); /* UART/I2C bölücüsü hesaplamak için */')}#include "es_rcc.h"

static uint32_t ahb_div(uint32_t code) { static const uint8_t sh[8] = { 1, 2, 3, 4, 6, 7, 8, 9 }; return code < 8U ? 1U : 1UL << sh[code - 8U]; }
static uint32_t apb_div(uint32_t code) { return code < 4U ? 1U : 1UL << (code - 3U); }

uint32_t es_rcc_hclk_hz(void)
{
${k === 'h7' ? '  /* H7: SystemCoreClock CPU saatidir; HCLK = SystemD2Clock */\n  return SystemD2Clock;' : '  /* CMSIS SystemCoreClock = HCLK */\n  return SystemCoreClock;'}
}

uint32_t es_rcc_pclk1_hz(void)
{
  return es_rcc_hclk_hz() / apb_div((${regs.p1});
}

uint32_t es_rcc_pclk2_hz(void)
{
${regs.p2 ? `  return es_rcc_hclk_hz() / apb_div((${regs.p2});` : '  return es_rcc_pclk1_hz(); /* tek APB */'}
}

uint32_t es_rcc_ahb_div(void)
{
  return ahb_div((${regs.hpre});
}

${init}
`;
  return { 'es_rcc.h': banner(x, 'es_rcc.h', 'saat ağacı ve frekans okuma', ['rcc']) + h, 'es_rcc.c': cfile };
}

// ================================================================== GPIO
function portsOf(x) {
  const ports = new Set(x.mcu.pins.map((p) => p.name[1]));
  if (x.mcu.device.oscPort) ports.add(x.mcu.device.oscPort);
  return [...ports].sort();
}

function gpio(x) {
  const v1 = x.fam.ip.gpio === 'v1';
  const en = x.mcu.device.gpioEnr || { reg: 'AHB1ENR', bit: 'RCC_AHB1ENR_GPIO{P}EN' };
  const h = header(x, 'gpio', `typedef enum { ES_GPIO_INPUT, ES_GPIO_OUTPUT, ES_GPIO_AF, ES_GPIO_ANALOG } es_gpio_mode_t;
typedef enum { ES_GPIO_NOPULL, ES_GPIO_PULLUP, ES_GPIO_PULLDOWN } es_gpio_pull_t;
typedef enum { ES_GPIO_PUSHPULL, ES_GPIO_OPENDRAIN } es_gpio_otype_t;

/* Portun saatini açar (GPIOA, GPIOB …). */
void es_gpio_clock_enable(GPIO_TypeDef *port);

/* Pini yapılandırır. af: alternatif fonksiyon numarası (datasheet "Alternate function mapping").
${v1 ? ' * F1: AF numarası yoktur (af yok sayılır); çevre birimi pini sabittir ya da AFIO remap ile değişir.\n * F1: alternatif fonksiyonun GİRİŞ tarafı (USART RX, SPI MISO) ES_GPIO_INPUT ile yapılandırılır.\n' : ''} */
void es_gpio_init(GPIO_TypeDef *port, uint32_t pin, es_gpio_mode_t mode, es_gpio_pull_t pull, es_gpio_otype_t otype, uint32_t af);

static inline void es_gpio_write(GPIO_TypeDef *port, uint32_t pin, int level) { port->BSRR = level ? (1UL << pin) : (1UL << (pin + 16U)); }
static inline int es_gpio_read(GPIO_TypeDef *port, uint32_t pin) { return (int)((port->IDR >> pin) & 1U); }
/* BSRR ile atomik tersleme (kesmede başka pin değişse bile güvenli) */
static inline void es_gpio_toggle(GPIO_TypeDef *port, uint32_t pin)
{
  uint32_t odr = port->ODR;
  port->BSRR = ((odr & (1UL << pin)) << 16) | (~odr & (1UL << pin));
}
`);
  const clock = portsOf(x).map((p) => `#if defined(GPIO${p})\n  if (port == GPIO${p}) RCC->${en.reg} |= ${en.bit.replace('{P}', p)};\n#endif`).join('\n');
  const init = v1 ? `void es_gpio_init(GPIO_TypeDef *port, uint32_t pin, es_gpio_mode_t mode, es_gpio_pull_t pull, es_gpio_otype_t otype, uint32_t af)
{
  /* CRL (pin 0-7) / CRH (pin 8-15): pin başına 4 bit = CNF[1:0] MODE[1:0] */
  volatile uint32_t *cr = pin < 8U ? &port->CRL : &port->CRH;
  uint32_t shift = (pin & 7U) * 4U, cfg;
  (void)af;
  switch (mode) {
  case ES_GPIO_ANALOG: cfg = 0x0U; break;                                     /* CNF=00 MODE=00 */
  case ES_GPIO_INPUT: cfg = pull == ES_GPIO_NOPULL ? 0x4U : 0x8U; break;       /* yüzen / çekme dirençli */
  case ES_GPIO_OUTPUT: cfg = (otype == ES_GPIO_OPENDRAIN ? 0x4U : 0x0U) | 0x3U; break; /* 50 MHz */
  default: cfg = 0x8U | (otype == ES_GPIO_OPENDRAIN ? 0x4U : 0x0U) | 0x3U; break;      /* alternatif çıkış */
  }
  if (mode == ES_GPIO_INPUT && pull != ES_GPIO_NOPULL) es_gpio_write(port, pin, pull == ES_GPIO_PULLUP); /* ODR çekme yönünü seçer */
  *cr = (*cr & ~(0xFU << shift)) | (cfg << shift);
}` : `void es_gpio_init(GPIO_TypeDef *port, uint32_t pin, es_gpio_mode_t mode, es_gpio_pull_t pull, es_gpio_otype_t otype, uint32_t af)
{
  /* Sıra önemli: önce AF, çıkış tipi, hız ve çekme; MODER en son (pin geçici olarak yanlış modda kalmasın) */
  port->AFR[pin >> 3] = (port->AFR[pin >> 3] & ~(0xFUL << ((pin & 7U) * 4U))) | ((af & 0xFU) << ((pin & 7U) * 4U));
  port->OTYPER = (port->OTYPER & ~(1UL << pin)) | ((uint32_t)otype << pin);
  port->OSPEEDR |= 3UL << (pin * 2U);
  port->PUPDR = (port->PUPDR & ~(3UL << (pin * 2U))) | ((uint32_t)pull << (pin * 2U));
  port->MODER = (port->MODER & ~(3UL << (pin * 2U))) | ((uint32_t)mode << (pin * 2U));
#if defined(GPIO_ASCR_ASC0)
  if (mode == ES_GPIO_ANALOG) port->ASCR |= 1UL << pin; /* L47x: analog anahtarı ADC'ye bağla */
#endif
}`;
  const c = `${banner(x, 'es_gpio.c', 'GPIO', ['gpio'], `es_gpio_clock_enable(GPIOA);\nes_gpio_init(GPIOA, 5, ES_GPIO_OUTPUT, ES_GPIO_NOPULL, ES_GPIO_PUSHPULL, 0);\nes_gpio_toggle(GPIOA, 5);${v1 ? '' : '\n/* USART2 TX, AF7 (F4 örneği; numara datasheet tablosundan) */\nes_gpio_init(GPIOA, 2, ES_GPIO_AF, ES_GPIO_PULLUP, ES_GPIO_PUSHPULL, 7);'}`)}#include "es_gpio.h"

void es_gpio_clock_enable(GPIO_TypeDef *port)
{
${clock}
  (void)RCC->${en.reg};
}

${init}
`;
  return { 'es_gpio.h': banner(x, 'es_gpio.h', 'GPIO', ['gpio']) + h, 'es_gpio.c': c };
}

// ================================================================== EXTI
/** EXTI hattı → kesme adı: EXTI0, EXTI9_5 (5..9), EXTI0_1, EXTI4_15, EXTI2_TSC (F3) */
function extiRanges(names) {
  return names.map((n) => {
    const parts = n.replace(/^EXTI/, '').split('_').filter((p) => /^\d+$/.test(p)).map(Number);
    const lo = Math.min(...parts), hi = Math.max(...parts);
    return { name: n, lo, hi };
  }).sort((a, b) => a.lo - b.lo);
}

function exti(x) {
  const k = x.k;
  const ll = x.ll;
  const kind = k === 'f1' ? 'afio' : k === 'g0' || k === 'u5' ? 'exti' : 'syscfg';
  const R = k === 'l4' || k === 'g4' ? { imr: 'EXTI->IMR1', rtsr: 'EXTI->RTSR1', ftsr: 'EXTI->FTSR1', pr: 'EXTI->PR1' }
    : k === 'h7' ? { imr: 'EXTI_D1->IMR1', rtsr: 'EXTI->RTSR1', ftsr: 'EXTI->FTSR1', pr: 'EXTI_D1->PR1' }
    : kind === 'exti' ? { imr: 'EXTI->IMR1', rtsr: 'EXTI->RTSR1', ftsr: 'EXTI->FTSR1' }
    : { imr: 'EXTI->IMR', rtsr: 'EXTI->RTSR', ftsr: 'EXTI->FTSR', pr: 'EXTI->PR' };
  const ranges = extiRanges(ll.exti || ['EXTI0', 'EXTI1', 'EXTI2', 'EXTI3', 'EXTI4', 'EXTI9_5', 'EXTI15_10']);
  const irq = ranges.map((r) => `  if (pin <= ${r.hi}U) return ${r.name}_IRQn;`).join('\n');
  const h = header(x, 'exti', `typedef enum { ES_EXTI_RISING = 1, ES_EXTI_FALLING = 2, ES_EXTI_BOTH = 3 } es_exti_edge_t;

/* port'un pin numaralı hattını kesme kaynağı yapar (aynı numaralı hattı tek port kullanabilir).
 * Pini önce es_gpio_init(..., ES_GPIO_INPUT, ...) ile giriş yapın. NVIC'i açmak için:
 *   NVIC_SetPriority(es_exti_irqn(pin), 6); NVIC_EnableIRQ(es_exti_irqn(pin)); */
void es_exti_init(GPIO_TypeDef *port, uint32_t pin, es_exti_edge_t edge);
/* Hattın bekleyen bayrağı var mı; temizle (kesme işleyicisinde çağırın) */
int es_exti_pending(uint32_t pin);
void es_exti_clear(uint32_t pin);
/* Hattın NVIC kesme numarası (${ranges.map((r) => r.name).join(', ')}) */
IRQn_Type es_exti_irqn(uint32_t pin);
`);
  const portIndex = '(uint32_t)(((uint32_t)port - GPIOA_BASE) / (GPIOB_BASE - GPIOA_BASE))';
  let route;
  if (kind === 'afio') route = `  RCC->APB2ENR |= RCC_APB2ENR_AFIOEN;\n  AFIO->EXTICR[pin >> 2] = (AFIO->EXTICR[pin >> 2] & ~(0xFUL << ((pin & 3U) * 4U))) | (idx << ((pin & 3U) * 4U));`;
  else if (kind === 'syscfg') route = `  ${ll.syscfg ? `RCC->${ll.syscfg.reg} |= ${ll.syscfg.bit};` : 'RCC->APB2ENR |= RCC_APB2ENR_SYSCFGEN;'}\n  SYSCFG->EXTICR[pin >> 2] = (SYSCFG->EXTICR[pin >> 2] & ~(0xFUL << ((pin & 3U) * 4U))) | (idx << ((pin & 3U) * 4U));`;
  else route = '  /* EXTI kendi EXTICR register\'larına sahiptir: hat başına 8 bit port seçimi */\n  EXTI->EXTICR[pin >> 2] = (EXTI->EXTICR[pin >> 2] & ~(0xFFUL << ((pin & 3U) * 8U))) | (idx << ((pin & 3U) * 8U));';
  const pending = kind === 'exti' ? 'return ((EXTI->RPR1 | EXTI->FPR1) >> pin) & 1U;' : `return (int)((${R.pr} >> pin) & 1U);`;
  const clear = kind === 'exti' ? 'EXTI->RPR1 = 1UL << pin; /* yükselen ve düşen kenar bayrakları ayrı */\n  EXTI->FPR1 = 1UL << pin;' : `${R.pr} = 1UL << pin; /* 1 yazarak temizlenir */`;
  const c = `${banner(x, 'es_exti.c', 'harici kesme (EXTI)', ['exti', kind === 'afio' ? 'afio' : kind === 'syscfg' ? 'syscfg' : 'exti'], `es_gpio_clock_enable(GPIOC);\nes_gpio_init(GPIOC, 13, ES_GPIO_INPUT, ES_GPIO_PULLUP, ES_GPIO_PUSHPULL, 0);\nes_exti_init(GPIOC, 13, ES_EXTI_FALLING);\nNVIC_EnableIRQ(es_exti_irqn(13));\n/* ${ranges.find((r) => r.lo <= 13 && r.hi >= 13)?.name || 'EXTI15_10'}_IRQHandler içinde: if (es_exti_pending(13)) { es_exti_clear(13); ... } */`)}#include "es_exti.h"

void es_exti_init(GPIO_TypeDef *port, uint32_t pin, es_exti_edge_t edge)
{
  uint32_t idx = ${portIndex}; /* GPIOA = 0, GPIOB = 1 … */
${route}
  if (edge & ES_EXTI_RISING) ${R.rtsr} |= 1UL << pin; else ${R.rtsr} &= ~(1UL << pin);
  if (edge & ES_EXTI_FALLING) ${R.ftsr} |= 1UL << pin; else ${R.ftsr} &= ~(1UL << pin);
  es_exti_clear(pin);
  ${R.imr} |= 1UL << pin;
}

int es_exti_pending(uint32_t pin)
{
  ${pending}
}

void es_exti_clear(uint32_t pin)
{
  ${clear}
}

IRQn_Type es_exti_irqn(uint32_t pin)
{
${irq}
  return ${ranges[ranges.length - 1].name}_IRQn;
}
`;
  return { 'es_exti.h': banner(x, 'es_exti.h', 'harici kesme (EXTI)', ['exti']) + h, 'es_exti.c': c };
}

/**
 * Seçilen sürücülerin dosyaları: { 'es_gpio.h': içerik, … }
 * @param {any} mcu @param {string[]} ids @param {any} clock computeClock() sonucu (RCC ve ADC örnekleri için)
 */
function regDriverFiles(mcu, ids, clock) {
  const io = require('./regdrivers-io');
  const sys = require('./regdrivers-sys');
  const gen = { rcc, gpio, exti, uart: io.uart, spi: io.spi, i2c: io.i2c, tim: io.tim, adc: sys.adc, dac: sys.dac, dma: sys.dma, iwdg: sys.iwdg, wwdg: sys.wwdg, crc: sys.crc, flash: sys.flash };
  const x = context(mcu, clock);
  const out = {};
  for (const id of resolveDrivers(mcu, ids)) Object.assign(out, gen[id](x));
  return out;
}

module.exports = { DRIVERS, resolveDrivers, regDriverFiles, context, banner, header, enableLine, clockSwitch, rmRef, hex, CHAPTER, rcc, gpio, exti };
