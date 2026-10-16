// @ts-check
/**
 * Bare-metal (CMSIS register) kod üretimi, aile ve çevre birimi IP sürümüne göre (bkz. families.js).
 *  clockInit   : RCC/PWR/FLASH ile saat ağacı (Clock sekmesindeki ayar)
 *  gpioConfig  : pin yapılandırma yardımcısı (v1: F1 CRL/CRH, v2: MODER/AFR)
 *  periphInit  : I2C, SPI, U(S)ART, ADC, PWM başlatma gövdeleri
 *  bspFunctions: bsp.h API'sinin register gerçeklemesi
 * x: bsp.makeContext() bağlamı.
 */

const HPRE = { 1: 0, 2: 8, 4: 9, 8: 10, 16: 11, 64: 12, 128: 13, 256: 14, 512: 15 };
const PPRE = { 1: 0, 2: 4, 4: 5, 8: 6, 16: 7 };
const indent = (code, n = 2) => code.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

/** I2C v2 TIMINGR (fk: I2C çekirdek saati MHz). ST AN4235 hesabına yakın, standart/hızlı mod alt sınırları + pay. */
function i2cTiming(fk, speedHz) {
  const fast = speedHz > 100000;
  const tickTarget = fast ? 125e-9 : 250e-9;
  const presc = Math.min(15, Math.max(0, Math.round(fk * 1e6 * tickTarget) - 1));
  const tick = (presc + 1) / (fk * 1e6);
  const clamp = (v, max) => Math.min(max, Math.max(0, v));
  const cycles = (sec) => Math.ceil(sec / tick - 1e-6); // kayan nokta: 1.25 µs / 125 ns = 10.000000000000002
  const scll = clamp(cycles(fast ? 1.25e-6 : 4.7e-6) - 1, 255);
  const sclh = clamp(cycles(fast ? 0.5e-6 : 4.0e-6) - 1, 255);
  const sdadel = clamp(cycles(fast ? 125e-9 : 500e-9), 15);
  const scldel = clamp(cycles(fast ? 500e-9 : 1250e-9) - 1, 15);
  const v = ((presc << 28) | (scldel << 20) | (sdadel << 16) | (sclh << 8) | scll) >>> 0;
  return '0x' + v.toString(16).toUpperCase().padStart(8, '0');
}

/** SYSCLK kaynağı kodları (RCC_CFGR.SW) aileye göre. */
const SW = {
  f0: { HSI: 0, HSE: 1, PLL: 2 }, f1: { HSI: 0, HSE: 1, PLL: 2 }, f3: { HSI: 0, HSE: 1, PLL: 2 }, f4: { HSI: 0, HSE: 1, PLL: 2 }, f7: { HSI: 0, HSE: 1, PLL: 2 },
  g0: { HSI: 0, HSE: 1, PLL: 2 }, g4: { HSI: 1, HSE: 2, PLL: 3 }, l4: { HSI: 1, HSE: 2, PLL: 3 }, u5: { HSI: 1, HSE: 2, PLL: 3 }, h7: { HSI: 0, HSE: 2, PLL: 3 }
};

// ------------------------------------------------------------------ saat ağacı
function clockInit(x) {
  const c = x.clock.config;
  const f = x.clock.freq;
  const fam = x.fam.key;
  const lat = x.clock.latency;
  const useHse = c.pllSource === 'HSE' || c.sysclkSource === 'HSE';
  const useHsi = c.pllSource === 'HSI' || c.sysclkSource === 'HSI';
  const pll = c.sysclkSource === 'PLL';
  const sw = SW[fam][c.sysclkSource];
  const CFGR = fam === 'u5' ? 'CFGR1' : 'CFGR';
  const hse = `  RCC->CR |= RCC_CR_HSEON;
  for (start = 0; !(RCC->CR & RCC_CR_HSERDY); start++) {
    if (start > 1000000U) Error_Handler(); /* kristal başlamadı */
  }
`;
  const hsi = '  RCC->CR |= RCC_CR_HSION;\n  while (!(RCC->CR & RCC_CR_HSIRDY)) {\n  }\n';
  const switchTo = `  RCC->${CFGR} = (RCC->${CFGR} & ~RCC_${CFGR}_SW) | (${sw}U << RCC_${CFGR}_SW_Pos);
  while (((RCC->${CFGR} & RCC_${CFGR}_SWS) >> RCC_${CFGR}_SWS_Pos) != ${sw}U) {
  }
`;
  const osc = (useHse ? hse : '') + (useHsi ? hsi : '');
  let body;

  if (fam === 'f4' || fam === 'f7') {
    const od = x.clock.overdrive ? (fam === 'f7'
      ? '  PWR->CR1 |= PWR_CR1_ODEN; /* over-drive: SYSCLK > 180 MHz */\n  while (!(PWR->CSR1 & PWR_CSR1_ODRDY)) {\n  }\n  PWR->CR1 |= PWR_CR1_ODSWEN;\n  while (!(PWR->CSR1 & PWR_CSR1_ODSWRDY)) {\n  }\n'
      : '  PWR->CR |= PWR_CR_ODEN; /* over-drive: SYSCLK > 168 MHz */\n  while (!(PWR->CSR & PWR_CSR_ODRDY)) {\n  }\n  PWR->CR |= PWR_CR_ODSWEN;\n  while (!(PWR->CSR & PWR_CSR_ODSWRDY)) {\n  }\n') : '';
    body = `  RCC->APB1ENR |= RCC_APB1ENR_PWREN;
  ${fam === 'f7' ? 'PWR->CR1 |= PWR_CR1_VOS' : 'PWR->CR |= PWR_CR_VOS'}; /* Ölçek 1: en yüksek frekans */
${osc}  FLASH->ACR = ${fam === 'f7' ? 'FLASH_ACR_ARTEN | FLASH_ACR_PRFTEN' : 'FLASH_ACR_PRFTEN | FLASH_ACR_ICEN | FLASH_ACR_DCEN'} | (${lat}U << FLASH_ACR_LATENCY_Pos);
  RCC->CFGR = (${HPRE[c.ahb]}U << RCC_CFGR_HPRE_Pos) | (${PPRE[c.apb1]}U << RCC_CFGR_PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_CFGR_PPRE2_Pos);
${pll ? `  RCC->PLLCFGR = (${c.M}U << RCC_PLLCFGR_PLLM_Pos) | (${c.N}U << RCC_PLLCFGR_PLLN_Pos) | (${c.P / 2 - 1}U << RCC_PLLCFGR_PLLP_Pos) |
                 (${c.Q}U << RCC_PLLCFGR_PLLQ_Pos)${c.pllSource === 'HSE' ? ' | RCC_PLLCFGR_PLLSRC_HSE' : ''}
#if defined(RCC_PLLCFGR_PLLR_Pos)
                 | (2U << RCC_PLLCFGR_PLLR_Pos)
#endif
                 ;
  RCC->CR |= RCC_CR_PLLON;
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
${od}` : ''}${switchTo}`;
  } else if (fam === 'f0' || fam === 'f1' || fam === 'f3') {
    const mul = fam === 'f1' ? 'RCC_CFGR_PLLMULL_Pos' : 'RCC_CFGR_PLLMUL_Pos';
    const ppre = fam === 'f0' ? `(${PPRE[c.apb1]}U << RCC_CFGR_PPRE_Pos)` : `(${PPRE[c.apb1]}U << RCC_CFGR_PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_CFGR_PPRE2_Pos)`;
    let src;
    if (fam === 'f1') src = c.pllSource === 'HSE' ? `RCC_CFGR_PLLSRC${c.M === 2 ? ' | RCC_CFGR_PLLXTPRE' : ''}` : '0U /* HSI/2 */';
    else if (c.pllSource === 'HSE') src = 'RCC_CFGR_PLLSRC_HSE_PREDIV';
    else src = null; // HSI/2: F0'da sabit, F303xE'de PREDIV ile
    const hsiDiv = x.mcu.clock.hsiPrediv ? c.M : 2;
    const hsiSrc = `#if defined(RCC_CFGR_PLLSRC_HSI_PREDIV)
  RCC->CFGR2 = ${hsiDiv - 1}U << RCC_CFGR2_PREDIV_Pos; /* HSI/${hsiDiv} */
  RCC->CFGR |= RCC_CFGR_PLLSRC_HSI_PREDIV | ((${c.N}U - 2U) << ${mul});
#else
  RCC->CFGR |= (${c.N}U - 2U) << ${mul}; /* HSI/2 */
#endif
`;
    body = `${osc}  FLASH->ACR = FLASH_ACR_PRFTBE | (${lat}U << FLASH_ACR_LATENCY_Pos);
  RCC->CFGR = (${HPRE[c.ahb]}U << RCC_CFGR_HPRE_Pos) | ${ppre};
${pll ? `${fam !== 'f1' && c.pllSource === 'HSE' ? `  RCC->CFGR2 = (${c.M}U - 1U) << RCC_CFGR2_PREDIV_Pos; /* HSE/${c.M} */\n` : ''}${src ? `  RCC->CFGR |= ${src} | ((${c.N}U - 2U) << ${mul}); /* ×${c.N} */\n` : hsiSrc}  RCC->CR |= RCC_CR_PLLON;
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
` : ''}${switchTo}`;
  } else if (fam === 'g0' || fam === 'g4' || fam === 'l4') {
    const pwrEnr = fam === 'g0' ? 'RCC->APBENR1 |= RCC_APBENR1_PWREN;' : 'RCC->APB1ENR1 |= RCC_APB1ENR1_PWREN;';
    const rEnc = fam === 'g0' ? c.R - 1 : c.R / 2 - 1;
    const ppre = fam === 'g0' ? `(${PPRE[c.apb1]}U << RCC_CFGR_PPRE_Pos)` : `(${PPRE[c.apb1]}U << RCC_CFGR_PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_CFGR_PPRE2_Pos)`;
    const acr = fam === 'g0' ? 'FLASH_ACR_ICEN | FLASH_ACR_PRFTEN' : 'FLASH_ACR_ICEN | FLASH_ACR_DCEN | FLASH_ACR_PRFTEN';
    // G4: 80 MHz üstüne geçerken AHB bir süre /2 olmalı (RM0440 6.1.5); boost için R1MODE = 0
    const g4Step = fam === 'g4' && f.hclk > 80 && c.ahb === 1;
    body = `  ${pwrEnr}
${fam === 'g4' && x.clock.boost ? '  PWR->CR5 &= ~PWR_CR5_R1MODE; /* Range 1 boost: SYSCLK > 150 MHz */\n' : ''}${osc}  FLASH->ACR = ${acr} | (${lat}U << FLASH_ACR_LATENCY_Pos);
  while ((FLASH->ACR & FLASH_ACR_LATENCY) != (${lat}U << FLASH_ACR_LATENCY_Pos)) {
  }
${pll ? `  RCC->PLLCFGR = (${c.pllSource === 'HSE' ? 3 : 2}U << RCC_PLLCFGR_PLLSRC_Pos) | ((${c.M}U - 1U) << RCC_PLLCFGR_PLLM_Pos) | (${c.N}U << RCC_PLLCFGR_PLLN_Pos) |
                 (${rEnc}U << RCC_PLLCFGR_PLLR_Pos) | RCC_PLLCFGR_PLLREN; /* /${c.M} ×${c.N} /${c.R} */
  RCC->CR |= RCC_CR_PLLON;
  while (!(RCC->CR & RCC_CR_PLLRDY)) {
  }
` : ''}  RCC->CFGR = (RCC->CFGR & ~(RCC_CFGR_HPRE | ${fam === 'g0' ? 'RCC_CFGR_PPRE' : 'RCC_CFGR_PPRE1 | RCC_CFGR_PPRE2'})) | (${g4Step ? HPRE[2] : HPRE[c.ahb]}U << RCC_CFGR_HPRE_Pos) | ${ppre};
${switchTo}${g4Step ? `  for (volatile uint32_t i = 0; i < 200U; i++) {
  } /* en az 1 µs */
  RCC->CFGR &= ~RCC_CFGR_HPRE; /* AHB /1 */
` : ''}`;
  } else if (fam === 'u5') {
    const rge = f.pllIn > 8 ? 3 : 0;
    body = `  RCC->AHB3ENR |= RCC_AHB3ENR_PWREN;
  PWR->VOSR = (PWR->VOSR & ~PWR_VOSR_VOS) | (3U << PWR_VOSR_VOS_Pos); /* Range 1 */
  while (!(PWR->VOSR & PWR_VOSR_VOSRDY)) {
  }
  PWR->SVMCR |= PWR_SVMCR_ASV | PWR_SVMCR_IO2SV; /* VDDA (ADC) ve VDDIO2 (port G) geçerli */
${osc}  FLASH->ACR = (FLASH->ACR & ~FLASH_ACR_LATENCY) | FLASH_ACR_PRFTEN | (${lat}U << FLASH_ACR_LATENCY_Pos);
  while ((FLASH->ACR & FLASH_ACR_LATENCY) != (${lat}U << FLASH_ACR_LATENCY_Pos)) {
  }
${pll ? `  RCC->PLL1CFGR = (${c.pllSource === 'HSE' ? 3 : 2}U << RCC_PLL1CFGR_PLL1SRC_Pos) | (${rge}U << RCC_PLL1CFGR_PLL1RGE_Pos) | ((${c.M}U - 1U) << RCC_PLL1CFGR_PLL1M_Pos) |
                  (0U << RCC_PLL1CFGR_PLL1MBOOST_Pos); /* EPOD booster saati = PLL1 girişi (${f.pllIn} MHz) */
${x.clock.epod ? '  PWR->VOSR |= PWR_VOSR_BOOSTEN; /* EPOD booster: SYSCLK > 55 MHz */\n  while (!(PWR->VOSR & PWR_VOSR_BOOSTRDY)) {\n  }\n' : ''}  RCC->PLL1DIVR = ((${c.N}U - 1U) << RCC_PLL1DIVR_PLL1N_Pos) | (1U << RCC_PLL1DIVR_PLL1P_Pos) | (1U << RCC_PLL1DIVR_PLL1Q_Pos) |
                  ((${c.R}U - 1U) << RCC_PLL1DIVR_PLL1R_Pos); /* ×${c.N} /${c.R} */
  RCC->PLL1CFGR |= RCC_PLL1CFGR_PLL1REN;
  RCC->CR |= RCC_CR_PLL1ON;
  while (!(RCC->CR & RCC_CR_PLL1RDY)) {
  }
` : ''}  RCC->CFGR2 = (${HPRE[c.ahb]}U << RCC_CFGR2_HPRE_Pos) | (${PPRE[c.apb1]}U << RCC_CFGR2_PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_CFGR2_PPRE2_Pos);
  RCC->CFGR3 = (${PPRE[c.apb1]}U << RCC_CFGR3_PPRE3_Pos);
${switchTo}`;
  } else if (fam === 'h7') {
    const rge = f.pllIn < 2 ? 0 : f.pllIn < 4 ? 1 : f.pllIn < 8 ? 2 : 3;
    const wr = f.hclk <= 70 ? 0 : f.hclk <= 140 ? 1 : f.hclk <= 210 ? 2 : 3;
    body = `#if defined(PWR_CR3_SMPSEN)
  PWR->CR3 = (PWR->CR3 & ~(PWR_CR3_SMPSEN | PWR_CR3_BYPASS)) | PWR_CR3_LDOEN; /* LDO beslemesi (Nucleo varsayılanı) */
#else
  PWR->CR3 = (PWR->CR3 & ~PWR_CR3_BYPASS) | PWR_CR3_LDOEN;
#endif
  while (!(PWR->CSR1 & PWR_CSR1_ACTVOSRDY)) {
  }
  PWR->D3CR = (PWR->D3CR & ~PWR_D3CR_VOS) | PWR_D3CR_VOS; /* Ölçek 1 */
  while (!(PWR->D3CR & PWR_D3CR_VOSRDY)) {
  }
${osc}  FLASH->ACR = (${lat}U << FLASH_ACR_LATENCY_Pos) | (${wr}U << FLASH_ACR_WRHIGHFREQ_Pos);
  while ((FLASH->ACR & FLASH_ACR_LATENCY) != (${lat}U << FLASH_ACR_LATENCY_Pos)) {
  }
${pll ? `  RCC->PLLCKSELR = (${c.pllSource === 'HSE' ? 2 : 0}U << RCC_PLLCKSELR_PLLSRC_Pos) | (${c.M}U << RCC_PLLCKSELR_DIVM1_Pos);
  RCC->PLLCFGR = (${rge}U << RCC_PLLCFGR_PLL1RGE_Pos) | RCC_PLLCFGR_DIVP1EN | RCC_PLLCFGR_DIVQ1EN | RCC_PLLCFGR_DIVR1EN; /* geniş VCO */
  RCC->PLL1DIVR = ((${c.N}U - 1U) << RCC_PLL1DIVR_N1_Pos) | ((${c.P}U - 1U) << RCC_PLL1DIVR_P1_Pos) | ((${c.Q}U - 1U) << RCC_PLL1DIVR_Q1_Pos) |
                  (1U << RCC_PLL1DIVR_R1_Pos); /* ×${c.N} /P${c.P} /Q${c.Q} */
  RCC->CR |= RCC_CR_PLL1ON;
  while (!(RCC->CR & RCC_CR_PLL1RDY)) {
  }
` : ''}  RCC->D1CFGR = (${HPRE[c.ahb]}U << RCC_D1CFGR_HPRE_Pos) | (${PPRE[c.apb1]}U << RCC_D1CFGR_D1PPRE_Pos); /* D1CPRE /1 */
  RCC->D2CFGR = (${PPRE[c.apb1]}U << RCC_D2CFGR_D2PPRE1_Pos) | (${PPRE[c.apb2]}U << RCC_D2CFGR_D2PPRE2_Pos);
  RCC->D3CFGR = (${PPRE[c.apb1]}U << RCC_D3CFGR_D3PPRE_Pos);
${switchTo}  RCC->D3CCIPR = (RCC->D3CCIPR & ~RCC_D3CCIPR_ADCSEL) | (2U << RCC_D3CCIPR_ADCSEL_Pos); /* ADC: per_ck (HSI 64 MHz) */
`;
  } else {
    throw new Error(`clockInit: aile desteklenmiyor: ${fam}`);
  }
  const summary = `SYSCLK ${f.sysclk} MHz, HCLK ${f.hclk} MHz, APB1 ${f.pclk1} MHz${x.fam.apbCount > 1 ? `, APB2 ${f.pclk2} MHz` : ''}, Flash ${lat} WS`;
  return `/* ${summary} */
static void clock_init(void)
{
  uint32_t start;
  (void)start;
${body}  SystemCoreClockUpdate();
}`;
}

// ------------------------------------------------------------------ GPIO
function gpioConfig(x) {
  if (x.fam.ip.gpio === 'v1') {
    return `/* F1: mode 0 giriş, 1 çıkış, 2 alternatif çıkış, 3 analog | od: open-drain | pullup | in: alternatif giriş (RX, MISO) */
static void gpio_config(GPIO_TypeDef *p, uint32_t pin, uint32_t mode, uint32_t od, uint32_t pullup, uint32_t in)
{
  volatile uint32_t *cr = pin < 8U ? &p->CRL : &p->CRH;
  uint32_t shift = (pin & 7U) * 4U, cfg;
  if (mode == 3U) cfg = 0x0U;                                  /* analog */
  else if (mode == 0U || in) cfg = pullup ? 0x8U : 0x4U;        /* giriş: çekme dirençli / yüzen */
  else cfg = (mode == 2U ? 0x8U : 0x0U) | (od ? 0x4U : 0x0U) | 0x3U; /* çıkış 50 MHz */
  if (pullup) p->BSRR = 1U << pin;
  *cr = (*cr & ~(0xFU << shift)) | (cfg << shift);
}`;
  }
  return `/* mode: 0 giriş, 1 çıkış, 2 alternatif, 3 analog | od: open-drain | pullup | af: alternatif fonksiyon */
static void gpio_config(GPIO_TypeDef *p, uint32_t pin, uint32_t mode, uint32_t od, uint32_t pullup, uint32_t af)
{
  p->AFR[pin >> 3] = (p->AFR[pin >> 3] & ~(0xFU << ((pin & 7U) * 4U))) | (af << ((pin & 7U) * 4U));
  p->OTYPER = (p->OTYPER & ~(1U << pin)) | (od << pin);
  p->OSPEEDR |= 3U << (pin * 2U);
  p->PUPDR = (p->PUPDR & ~(3U << (pin * 2U))) | (pullup << (pin * 2U));
  p->MODER = (p->MODER & ~(3U << (pin * 2U))) | (mode << (pin * 2U));
#if defined(GPIO_ASCR_ASC0)
  if (mode == 3U) p->ASCR |= 1U << pin; /* L47x: analog anahtarı ADC'ye bağla */
#endif
}`;
}

/** gpio_init gövdesi: port saatleri + pin çağrıları */
function gpioInit(x) {
  const MODE = { in: 0, out: 1, af: 2, analog: 3 };
  const en = x.mcu.device.gpioEnr || { reg: 'AHB1ENR', bit: 'RCC_AHB1ENR_GPIO{P}EN' };
  const v1 = x.fam.ip.gpio === 'v1';
  const lines = x.pins.map((p) => {
    const pre = p.mode === 'out' ? `  GPIO${p.port}->BSRR = ${p.initHigh ? `1U << ${p.n}` : `1U << (${p.n} + 16)`};\n` : '';
    const last = v1 ? (/_(RX|MISO)$/.test(p.conn.signal) ? 1 : 0) : (p.af ?? 0);
    return `${pre}  gpio_config(GPIO${p.port}, ${p.n}, ${MODE[p.mode]}U, ${p.otype === 'od' ? 1 : 0}U, ${p.pull === 'up' ? 1 : 0}U, ${last}U); /* ${p.conn.signal} */`;
  });
  const ports = x.ports.map((p) => en.bit.replace('{P}', p));
  return `static void gpio_init(void)
{
  RCC->${en.reg} |= ${ports.length ? ports.join(' | ') : '0'};
  (void)RCC->${en.reg}; /* saat açıldıktan sonra kısa gecikme */
${v1 ? `  RCC->APB2ENR |= RCC_APB2ENR_AFIOEN;
  AFIO->MAPR = (AFIO->MAPR & ~AFIO_MAPR_SWJ_CFG) | AFIO_MAPR_SWJ_CFG_JTAGDISABLE; /* SWD kalır; PA15, PB3, PB4 serbest */
` : ''}${lines.join('\n')}
}`;
}

// ------------------------------------------------------------------ çevre birimi başlatma
const enable = (x, name) => {
  const p = x.mcu.peripherals[name];
  return p.enr ? `RCC->${p.enr} |= ${p.enrBit};` : `RCC->${p.bus}ENR |= RCC_${p.bus}ENR_${name}EN;`;
};
const irqOf = (x, name) => (x.mcu.peripherals[name].irq || name);
/** ADC örnekleme süresi kodu tüm kanallara (3 bit/kanal) */
const smprFill = (code, n) => '0x' + Array.from({ length: n }, (_, i) => code * 2 ** (3 * i)).reduce((a, b) => a + b, 0).toString(16).toUpperCase() + 'U';
const ADC_MAX = { f3: 72, g4: 60, l4: 80 };

function periphInit(x, name, p) {
  const fam = x.fam;
  const fk = x.pclkOf(name);
  if (p.type === 'i2c') {
    if (fam.ip.i2c === 'v1') {
      const pclk = Math.round(fk);
      const fast = p.speedHz > 100000;
      const ccr = fast ? Math.max(1, Math.ceil((fk * 1e6) / (3 * p.speedHz))) : Math.max(4, Math.ceil((fk * 1e6) / (2 * p.speedHz)));
      const trise = fast ? Math.floor((pclk * 300) / 1000) + 1 : pclk + 1;
      return `${enable(x, name)}
${name}->CR1 = I2C_CR1_SWRST;
${name}->CR1 = 0;
${name}->CR2 = ${pclk}U; /* PCLK1 MHz */
${name}->CCR = ${fast ? 'I2C_CCR_FS | ' : ''}${ccr}U; /* ${p.speedHz / 1000} kHz */
${name}->TRISE = ${trise}U;
${name}->CR1 = I2C_CR1_PE;`;
    }
    return `${enable(x, name)}
${name}->CR1 = 0;
${name}->TIMINGR = ${i2cTiming(fk, p.speedHz)}U; /* ${p.speedHz / 1000} kHz, I2C saati ${fk} MHz */
${name}->CR1 = I2C_CR1_PE;`;
  }
  if (p.type === 'spi') {
    const div = x.spiDiv(name, p.speedHz);
    const br = Math.log2(div) - 1;
    const note = `/${div} = ${(fk / div).toFixed(3)} MHz, mod 0`;
    if (fam.ip.spi === 'v2') {
      return `${enable(x, name)}
${name}->CFG1 = (${br}U << SPI_CFG1_MBR_Pos) | (7U << SPI_CFG1_DSIZE_Pos); /* ${note}, 8 bit */
${name}->CFG2 = SPI_CFG2_MASTER | SPI_CFG2_SSM | SPI_CFG2_AFCNTR;
${name}->CR1 = SPI_CR1_SSI;`;
    }
    return `${enable(x, name)}
${name}->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | (${br}U << SPI_CR1_BR_Pos); /* ${note} */
${fam.ip.spi === 'fifo' ? `${name}->CR2 = (7U << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH; /* 8 bit veri, 8 bitte RXNE */\n` : ''}${name}->CR1 |= SPI_CR1_SPE;`;
  }
  if (p.type === 'uart') {
    const brr = Math.round((fk * 1e6) / p.baud);
    return `${enable(x, name)}
${name}->BRR = ${brr}U; /* ${p.baud} baud @ ${fk} MHz */
${name}->CR1 = ${p.pins.TX ? 'USART_CR1_TE | ' : ''}${p.pins.RX ? 'USART_CR1_RE | ' : ''}USART_CR1_UE;
NVIC_SetPriority(${irqOf(x, name)}_IRQn, 6); /* FreeRTOS: configMAX_SYSCALL_INTERRUPT_PRIORITY (5) altı */
NVIC_EnableIRQ(${irqOf(x, name)}_IRQn);`;
  }
  if (p.type === 'adc') return adcInit(x, name);
  if (p.type === 'pwm') {
    const t = x.timTiming(name, p.frequencyHz);
    const lines = p.channels.map((ch) => {
      const n = Number(ch.channel.replace('CH', ''));
      const reg = n <= 2 ? 'CCMR1' : 'CCMR2';
      const shift = n % 2 === 1 ? 0 : 8;
      return `${name}->${reg} |= (6U << ${shift + 4}) | (1U << ${shift + 3}); /* CH${n}: PWM mod 1, önyükleme */
${name}->CCER |= 1U << ${(n - 1) * 4};`;
    });
    // Break özellikli timer'larda (TIM1/8/15/16/17/20) çıkışlar MOE ile açılır
    const moe = /^TIM(1|8|15|16|17|20)$/.test(name) ? `\n${name}->BDTR |= TIM_BDTR_MOE;` : '';
    return `${enable(x, name)}
${name}->PSC = ${t.psc}U; /* ${(t.tick / 1e6).toFixed(3)} MHz sayaç */
${name}->ARR = ${t.arr}U; /* ${p.frequencyHz} Hz */
${lines.join('\n')}${moe}
${name}->CR1 = TIM_CR1_ARPE;
${name}->EGR = TIM_EGR_UG;
${name}->CR1 |= TIM_CR1_CEN;`;
  }
  throw new Error(`periphInit: ${p.type}`);
}

function adcInit(x, name) {
  const fam = x.fam;
  const f = x.clock.freq;
  const common = x.mcu.peripherals[name].common || 'ADC1_COMMON';
  const wait = (us) => `for (volatile uint32_t i = 0; i < ${Math.ceil(us * f.sysclk / 4)}U; i++) {\n} /* ~${us} µs */`;
  const en = enable(x, name);
  switch (fam.ip.adc) {
    case 'f4': {
      const pre = { 2: 0, 4: 1, 6: 2, 8: 3 }[x.adcDiv];
      return `${en}
${common}->CCR = (${common}->CCR & ~ADC_CCR_ADCPRE) | (${pre}U << ADC_CCR_ADCPRE_Pos); /* PCLK2/${x.adcDiv} */
${name}->CR1 = 0; /* 12 bit */
${name}->SMPR2 = 0x24924924U; /* kanal 0-9: 84 döngü örnekleme */
${name}->SMPR1 = 0x00924924U; /* kanal 10-17: 84 döngü örnekleme */
${name}->CR2 = ADC_CR2_ADON;`;
    }
    case 'f1': {
      const pre = { 2: 0, 4: 1, 6: 2, 8: 3 }[x.adcDiv];
      return `RCC->CFGR = (RCC->CFGR & ~RCC_CFGR_ADCPRE) | (${pre}U << RCC_CFGR_ADCPRE_Pos); /* PCLK2/${x.adcDiv} = ${(f.pclk2 / x.adcDiv).toFixed(2)} MHz (≤14) */
${en}
${name}->SMPR2 = ${smprFill(6, 10)}; /* 71.5 döngü */
${name}->SMPR1 = ${smprFill(6, 8)};
${name}->CR2 = ADC_CR2_ADON;
${wait(2)}
${name}->CR2 |= ADC_CR2_RSTCAL;
while (${name}->CR2 & ADC_CR2_RSTCAL) {
}
${name}->CR2 |= ADC_CR2_CAL;
while (${name}->CR2 & ADC_CR2_CAL) {
}
${name}->CR2 |= ADC_CR2_EXTSEL | ADC_CR2_EXTTRIG; /* yazılımla başlatma (SWSTART) */`;
    }
    case 'g0': {
      const g0 = fam.key === 'g0';
      const div = f.pclk1 / 2 <= (g0 ? 35 : 14) ? 2 : 4;
      return `${en}
${name}->CFGR2 = (${div === 2 ? 1 : 2}U << ADC_CFGR2_CKMODE_Pos); /* PCLK/${div} = ${(f.pclk1 / div).toFixed(2)} MHz */
${g0 ? `${name}->CR |= ADC_CR_ADVREGEN;\n${wait(20)}\n` : ''}${name}->CR |= ADC_CR_ADCAL;
while (${name}->CR & ADC_CR_ADCAL) {
}
${g0 ? `${name}->SMPR = 5U << ADC_SMPR_SMP1_Pos; /* 39.5 döngü */` : `${name}->SMPR = 5U << ADC_SMPR_SMP_Pos; /* 55.5 döngü */`}
${name}->ISR = ADC_ISR_ADRDY;
${name}->CR |= ADC_CR_ADEN;
while (!(${name}->ISR & ADC_ISR_ADRDY)) {
}`;
    }
    case 'v3': {
      if (fam.key === 'u5') {
        return `${en}
RCC->CCIPR3 &= ~RCC_CCIPR3_ADCDACSEL; /* ADC çekirdek saati: HCLK */
${common}->CCR = (${common}->CCR & ~ADC_CCR_PRESC) | (2U << ADC_CCR_PRESC_Pos); /* HCLK/4 = ${(f.hclk / 4).toFixed(2)} MHz */
${name}->CR &= ~ADC_CR_DEEPPWD;
${name}->CR |= ADC_CR_ADVREGEN;
while (!(${name}->ISR & ADC_ISR_LDORDY)) {
}
${name}->CFGR1 = (${name}->CFGR1 & ~ADC_CFGR1_RES) | ADC_CFGR1_RES_0; /* 12 bit */
${name}->CR |= ADC_CR_ADCAL;
while (${name}->CR & ADC_CR_ADCAL) {
}
${name}->SMPR1 = ${smprFill(4, 10)};
${name}->SMPR2 = ${smprFill(4, 10)};
${name}->ISR = ADC_ISR_ADRDY;
${name}->CR |= ADC_CR_ADEN;
while (!(${name}->ISR & ADC_ISR_ADRDY)) {
}`;
      }
      const div = [1, 2, 4].find((d) => f.hclk / d <= ADC_MAX[fam.key]) || 4;
      const ckmode = { 1: 1, 2: 2, 4: 3 }[div];
      const f3 = fam.key === 'f3';
      return `${en}
${common}->CCR = (${common}->CCR & ~ADC_CCR_CKMODE) | (${ckmode}U << ADC_CCR_CKMODE_Pos); /* senkron HCLK/${div} = ${(f.hclk / div).toFixed(2)} MHz */
${f3 ? `${name}->CR &= ~ADC_CR_ADVREGEN;\n${name}->CR |= ADC_CR_ADVREGEN_0;` : `${name}->CR &= ~ADC_CR_DEEPPWD;\n${name}->CR |= ADC_CR_ADVREGEN;`}
${wait(20)}
${name}->CR |= ADC_CR_ADCAL;
while (${name}->CR & ADC_CR_ADCAL) {
}
${name}->SMPR1 = ${smprFill(4, 10)};
${name}->SMPR2 = ${smprFill(4, 9)};
${wait(1)}
${name}->ISR = ADC_ISR_ADRDY;
${name}->CR |= ADC_CR_ADEN;
while (!(${name}->ISR & ADC_ISR_ADRDY)) {
}`;
    }
    case 'h7':
      return `${en}
${common}->CCR = (${common}->CCR & ~(ADC_CCR_CKMODE | ADC_CCR_PRESC)) | (2U << ADC_CCR_PRESC_Pos); /* asenkron per_ck (HSI 64 MHz)/4 = 16 MHz */
${name}->CR &= ~ADC_CR_DEEPPWD;
${name}->CR |= ADC_CR_ADVREGEN;
${wait(20)}
${name}->CR |= ADC_CR_BOOST_1; /* 12.5-25 MHz aralığı */
${name}->CR |= ADC_CR_ADCALLIN | ADC_CR_ADCAL;
while (${name}->CR & ADC_CR_ADCAL) {
}
${name}->SMPR1 = ${smprFill(4, 10)};
${name}->SMPR2 = ${smprFill(4, 10)};
${name}->ISR = ADC_ISR_ADRDY;
${name}->CR |= ADC_CR_ADEN;
while (!(${name}->ISR & ADC_ISR_ADRDY)) {
}`;
    default:
      throw new Error(`adcInit: ${fam.ip.adc}`);
  }
}

// ------------------------------------------------------------------ bsp.h gerçeklemesi
const COMPAT = `/* Aileler arası CMSIS ad farkları (G0/H7/U5 FIFO'lu USART) */
#if !defined(USART_ISR_TXE) && defined(USART_ISR_TXE_TXFNF)
#define USART_ISR_TXE USART_ISR_TXE_TXFNF
#endif
#if !defined(USART_ISR_RXNE) && defined(USART_ISR_RXNE_RXFNE)
#define USART_ISR_RXNE USART_ISR_RXNE_RXFNE
#endif
#if !defined(USART_CR1_RXNEIE) && defined(USART_CR1_RXNEIE_RXFNEIE)
#define USART_CR1_RXNEIE USART_CR1_RXNEIE_RXFNEIE
#endif
#if !defined(USART_ICR_NECF) && defined(USART_ICR_NCF)
#define USART_ICR_NECF USART_ICR_NCF
#endif
`;

function i2cFunctions(x) {
  if (!x.buses.i2c.length) {
    return `
int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len) { (void)bus; (void)addr7; (void)reg; (void)buf; (void)len; return -1; }
int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len) { (void)bus; (void)addr7; (void)reg; (void)buf; (void)len; return -1; }
int bsp_i2c_probe(uint8_t bus, uint8_t addr7) { (void)bus; (void)addr7; return -1; }
`;
  }
  if (x.fam.ip.i2c === 'v1') {
    return `
/* ---- I2C (eski tip I2C çevre birimi: F1/F4, yoklamalı) ---- */
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
`;
  }
  return `
/* ---- I2C (TIMINGR tipi I2C çevre birimi, yoklamalı; 255 byte üstü RELOAD ile) ---- */
static void i2c_recover(I2C_TypeDef *i2c)
{
  i2c->CR1 &= ~I2C_CR1_PE; /* durum makinesini sıfırla */
  while (i2c->CR1 & I2C_CR1_PE) {
  }
  i2c->CR1 |= I2C_CR1_PE;
}

static int i2c_wait(I2C_TypeDef *i2c, uint32_t flag)
{
  uint32_t start = bsp_ticks;
  while (!(i2c->ISR & flag)) {
    if (i2c->ISR & (I2C_ISR_NACKF | I2C_ISR_BERR | I2C_ISR_ARLO)) {
      /* NACK'te donanım STOP gönderir */
      uint32_t t0 = bsp_ticks;
      while (!(i2c->ISR & I2C_ISR_STOPF) && (bsp_ticks - t0) <= BSP_TIMEOUT_MS) {
      }
      i2c->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF | I2C_ICR_BERRCF | I2C_ICR_ARLOCF;
      return -1;
    }
    if ((bsp_ticks - start) > BSP_TIMEOUT_MS) {
      i2c_recover(i2c);
      return -1;
    }
  }
  return 0;
}

static int i2c_idle(I2C_TypeDef *i2c)
{
  uint32_t start = bsp_ticks;
  while (i2c->ISR & I2C_ISR_BUSY) {
    if ((bsp_ticks - start) > BSP_TIMEOUT_MS) {
      i2c_recover(i2c);
      return -1;
    }
  }
  return 0;
}

/* nbytes'tan sonra kalan varsa RELOAD, yoksa autoend ? AUTOEND : (TC ile dur) */
static void i2c_cr2(I2C_TypeDef *i2c, uint8_t addr7, uint32_t remaining, uint32_t flags, int autoend)
{
  uint32_t n = remaining > 255U ? 255U : remaining;
  uint32_t mode = remaining > 255U ? I2C_CR2_RELOAD : (autoend ? I2C_CR2_AUTOEND : 0U);
  i2c->CR2 = ((uint32_t)addr7 << 1) | (n << I2C_CR2_NBYTES_Pos) | mode | flags;
}

static int i2c_send(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *first, const uint8_t *buf, uint16_t len, int autoend)
{
  uint32_t total = len + (first ? 1U : 0U), sent = 0;
  i2c_cr2(i2c, addr7, total, I2C_CR2_START, autoend);
  while (sent < total) {
    if (sent && (sent % 255U) == 0U) {
      if (i2c_wait(i2c, I2C_ISR_TCR)) return -1;
      i2c_cr2(i2c, addr7, total - sent, 0U, autoend);
    }
    if (i2c_wait(i2c, I2C_ISR_TXIS)) return -1;
    i2c->TXDR = (first && sent == 0U) ? *first : buf[sent - (first ? 1U : 0U)];
    sent++;
  }
  return 0;
}

int bsp_i2c_write(uint8_t bus, uint8_t addr7, uint8_t reg, const uint8_t *buf, uint16_t len)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  if (i2c_idle(i2c) || i2c_send(i2c, addr7, &reg, buf, len, 1)) return -1;
  if (i2c_wait(i2c, I2C_ISR_STOPF)) return -1;
  i2c->ICR = I2C_ICR_STOPCF;
  return 0;
}

int bsp_i2c_read(uint8_t bus, uint8_t addr7, uint8_t reg, uint8_t *buf, uint16_t len)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  uint32_t got = 0;
  if (len == 0) return 0;
  if (i2c_idle(i2c) || i2c_send(i2c, addr7, &reg, 0, 0, 0)) return -1;
  if (i2c_wait(i2c, I2C_ISR_TC)) return -1;
  i2c_cr2(i2c, addr7, len, I2C_CR2_START | I2C_CR2_RD_WRN, 1); /* tekrarlı START */
  while (got < len) {
    if (got && (got % 255U) == 0U) {
      if (i2c_wait(i2c, I2C_ISR_TCR)) return -1;
      i2c_cr2(i2c, addr7, len - got, I2C_CR2_RD_WRN, 1);
    }
    if (i2c_wait(i2c, I2C_ISR_RXNE)) return -1;
    buf[got++] = (uint8_t)i2c->RXDR;
  }
  if (i2c_wait(i2c, I2C_ISR_STOPF)) return -1;
  i2c->ICR = I2C_ICR_STOPCF;
  return 0;
}

int bsp_i2c_probe(uint8_t bus, uint8_t addr7)
{
  I2C_TypeDef *i2c = i2c_bus[bus];
  if (i2c_idle(i2c)) return -1;
  i2c->CR2 = ((uint32_t)addr7 << 1) | I2C_CR2_AUTOEND | I2C_CR2_START; /* 0 byte: sadece adres */
  if (i2c_wait(i2c, I2C_ISR_STOPF)) return -1;
  i2c->ICR = I2C_ICR_STOPCF;
  return 0;
}
`;
}

function spiFunction(x) {
  if (!x.buses.spi.length) return '  (void)bus; (void)tx; (void)rx; (void)len;\n  return -1;';
  if (x.fam.ip.spi === 'v2') {
    return `  SPI_TypeDef *spi = spi_bus[bus];
  uint32_t start = bsp_ticks;
  int r = 0;
  if (len == 0) return 0;
  spi->CR2 = len; /* TSIZE */
  spi->CR1 |= SPI_CR1_SPE;
  spi->CR1 |= SPI_CR1_CSTART;
  for (uint16_t i = 0; i < len && !r; i++) {
    while (!(spi->SR & SPI_SR_TXP)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) { r = -1; break; }
    if (r) break;
    *(volatile uint8_t *)&spi->TXDR = tx ? tx[i] : 0xFF;
    while (!(spi->SR & SPI_SR_RXP)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) { r = -1; break; }
    if (r) break;
    uint8_t b = *(volatile uint8_t *)&spi->RXDR;
    if (rx) rx[i] = b;
  }
  while (!r && !(spi->SR & SPI_SR_EOT)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) r = -1;
  spi->IFCR = SPI_IFCR_EOTC | SPI_IFCR_TXTFC;
  spi->CR1 &= ~SPI_CR1_SPE;
  return r;`;
  }
  return `  SPI_TypeDef *spi = spi_bus[bus];
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
  return 0;`;
}

function uartFunctions(x) {
  const uart = x.buses.uart.length;
  if (x.fam.ip.usart === 'v1') {
    return {
      write: uart ? `  USART_TypeDef *u = uart_bus[bus];
  for (uint16_t i = 0; i < len; i++) {
    uint32_t start = bsp_ticks;
    while (!(u->SR & USART_SR_TXE)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
    u->DR = data[i];
  }
  while (!(u->SR & USART_SR_TC)) {
  }
  return 0;` : '  (void)bus; (void)data; (void)len;\n  return -1;',
      irq: uart ? `  USART_TypeDef *u = uart_bus[bus];
  uint32_t sr = u->SR;
  if (sr & (USART_SR_RXNE | USART_SR_ORE)) {
    uint8_t b = (uint8_t)u->DR; /* SR sonra DR okumak ORE bayrağını da temizler */
    if (sr & USART_SR_RXNE) bsp_uart_rx_callback(bus, b);
  }` : '  (void)bus;'
    };
  }
  return {
    write: uart ? `  USART_TypeDef *u = uart_bus[bus];
  for (uint16_t i = 0; i < len; i++) {
    uint32_t start = bsp_ticks;
    while (!(u->ISR & USART_ISR_TXE)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return -1;
    u->TDR = data[i];
  }
  while (!(u->ISR & USART_ISR_TC)) {
  }
  return 0;` : '  (void)bus; (void)data; (void)len;\n  return -1;',
    irq: uart ? `  USART_TypeDef *u = uart_bus[bus];
  uint32_t isr = u->ISR;
  if (isr & USART_ISR_RXNE) bsp_uart_rx_callback(bus, (uint8_t)u->RDR);
  if (isr & (USART_ISR_ORE | USART_ISR_FE | USART_ISR_NE)) u->ICR = USART_ICR_ORECF | USART_ICR_FECF | USART_ICR_NECF;` : '  (void)bus;'
  };
}

function adcFunction(x) {
  if (!x.buses.adc.length) return '  (void)channel;\n  return 0;';
  const A = x.buses.adc[0];
  const start = '  uint32_t start = bsp_ticks;\n';
  const eoc = (sr) => `  while (!(${A}->${sr} & ADC_${sr}_EOC)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return 0;\n`;
  switch (x.fam.ip.adc) {
    case 'f4':
      return `${start}  ${A}->SQR3 = channel;\n  ${A}->CR2 |= ADC_CR2_SWSTART;\n${eoc('SR')}  return (uint16_t)${A}->DR;`;
    case 'f1':
      return `${start}  ${A}->SQR3 = channel;\n  ${A}->CR2 |= ADC_CR2_SWSTART;\n${eoc('SR')}  return (uint16_t)${A}->DR;`;
    case 'g0':
      return `${start}#if defined(ADC_ISR_CCRDY)
  ${A}->ISR = ADC_ISR_CCRDY;
  ${A}->CHSELR = 1UL << channel;
  while (!(${A}->ISR & ADC_ISR_CCRDY)) if ((bsp_ticks - start) > BSP_TIMEOUT_MS) return 0;
#else
  ${A}->CHSELR = 1UL << channel;
#endif
  ${A}->CR |= ADC_CR_ADSTART;
${eoc('ISR')}  return (uint16_t)${A}->DR;`;
    case 'v3': {
      const u5 = x.fam.key === 'u5';
      return `${start}${u5 ? `  ${A}->PCSEL |= 1UL << channel;\n` : ''}  ${A}->SQR1 = (uint32_t)channel << ADC_SQR1_SQ1_Pos;
  ${A}->CR |= ADC_CR_ADSTART;
${eoc('ISR')}  return (uint16_t)${A}->DR;`;
    }
    case 'h7':
      // H72x/H73x: ADC1/2 ön seçim register'ı ADC3 ile ortak yapıda PCSEL_RES0 adını taşır
      return `${start}  ${A}->${/^STM32H7[23]/.test(x.mcu.device.define) ? 'PCSEL_RES0' : 'PCSEL'} |= 1UL << channel;
  ${A}->SQR1 = (uint32_t)channel << ADC_SQR1_SQ1_Pos;
  ${A}->CR |= ADC_CR_ADSTART;
${eoc('ISR')}  return (uint16_t)(${A}->DR >> 4); /* 16 bit → 12 bit */`;
    default:
      throw new Error(`adcFunction: ${x.fam.ip.adc}`);
  }
}

module.exports = { clockInit, gpioConfig, gpioInit, periphInit, i2cFunctions, spiFunction, uartFunctions, adcFunction, i2cTiming, irqOf, COMPAT, HPRE, PPRE, indent };
