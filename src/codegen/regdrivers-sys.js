// @ts-check
/** ES-107 örnek sürücüleri: ADC, DAC, DMA, IWDG, WWDG, CRC, FLASH (bkz. regdrivers.js) */
const core = require('./regdrivers');
const reg = require('./regcode');

// ================================================================== DMA
/** Denetleyici tipi: kanal (F0/F1/F3/L4), kanal + DMAMUX (G0/G4), stream (F4/F7), stream + DMAMUX (H7), GPDMA (U5) */
const DMA_KIND = { f0: 'ch', f1: 'ch', f3: 'ch', l4: 'ch', g0: 'chmux', g4: 'chmux', f4: 'stream', f7: 'stream', h7: 'streammux', u5: 'gpdma' };

/**
 * İstek eşlemeleri. Sabit eşlemeli ailelerde RM'nin DMA istek tablosundan; DMAMUX/GPDMA'lı ailelerde istek numarası
 * HAL başlığındaki DMA_REQUEST_x / GPDMA1_REQUEST_x değeri, kanal serbestçe seçilir.
 *  ch: [dma, kanal, (L4) CSELR]   stream: [dma, stream, kanal]   mux: [dma, kanal/stream, istek]   gpdma: [kanal, istek]
 */
const FIXED_F1 = { ADC1: [1, 1], SPI1_RX: [1, 2], SPI1_TX: [1, 3], USART1_TX: [1, 4], USART1_RX: [1, 5], USART2_RX: [1, 6], USART2_TX: [1, 7], USART3_TX: [1, 2], USART3_RX: [1, 3] };
const FIXED_F4 = { ADC1: [2, 0, 0], SPI1_RX: [2, 2, 3], SPI1_TX: [2, 3, 3], USART1_RX: [2, 5, 4], USART1_TX: [2, 7, 4], USART2_RX: [1, 5, 4], USART2_TX: [1, 6, 4], USART3_RX: [1, 1, 4], USART3_TX: [1, 3, 4], USART6_RX: [2, 1, 5], USART6_TX: [2, 6, 5] };
const DMA_MAP = {
  f0: { ADC1: [1, 1], SPI1_RX: [1, 2], SPI1_TX: [1, 3], USART1_TX: [1, 2], USART1_RX: [1, 3], USART2_TX: [1, 4], USART2_RX: [1, 5] },
  f1: FIXED_F1,
  f3: FIXED_F1,
  l4: { ADC1: [1, 1, 0], SPI1_RX: [1, 2, 1], SPI1_TX: [1, 3, 1], USART3_TX: [1, 2, 2], USART3_RX: [1, 3, 2], USART1_TX: [1, 4, 2], USART1_RX: [1, 5, 2], USART2_RX: [1, 6, 2], USART2_TX: [1, 7, 2] },
  f4: FIXED_F4,
  f7: FIXED_F4,
  g0: { ADC1: [1, 1, 5], USART1_TX: [1, 2, 0x33], USART1_RX: [1, 3, 0x32], USART2_TX: [1, 4, 0x35], USART2_RX: [1, 5, 0x34], SPI1_TX: [1, 6, 0x11], SPI1_RX: [1, 7, 0x10] },
  g4: { ADC1: [1, 1, 5], USART1_TX: [1, 2, 25], USART1_RX: [1, 3, 24], USART2_TX: [1, 4, 27], USART2_RX: [1, 5, 26], USART3_TX: [1, 6, 29], USART3_RX: [1, 7, 28], SPI1_TX: [1, 8, 11], SPI1_RX: [2, 1, 10] },
  h7: { ADC1: [1, 0, 9], USART1_TX: [1, 1, 42], USART1_RX: [1, 2, 41], USART2_TX: [1, 3, 44], USART2_RX: [1, 4, 43], USART3_TX: [1, 5, 46], USART3_RX: [1, 6, 45], SPI1_TX: [1, 7, 38], SPI1_RX: [2, 0, 37] },
  u5: { ADC1: [0, 0], USART1_TX: [1, 25], USART1_RX: [2, 24], USART2_TX: [3, 27], USART2_RX: [4, 26], USART3_TX: [5, 29], USART3_RX: [6, 28], SPI1_TX: [7, 7], SPI1_RX: [8, 6] }
};

function dmaConst(k, name, v) {
  const kind = DMA_KIND[k];
  const inst = name.split('_')[0];
  let init;
  if (kind === 'ch') init = `{ DMA${v[0]}, DMA${v[0]}_Channel${v[1]}, ${v[1]}${k === 'l4' ? `, DMA${v[0]}_CSELR, ${v[2]}` : ''} }`;
  else if (kind === 'chmux') init = `{ DMA${v[0]}, DMA${v[0]}_Channel${v[1]}, ${v[1]}, DMAMUX1_Channel${(v[0] - 1) * 8 + v[1] - 1}, ${v[2]} }`;
  else if (kind === 'stream') init = `{ DMA${v[0]}, DMA${v[0]}_Stream${v[1]}, ${v[1]}, ${v[2]} }`;
  else if (kind === 'streammux') init = `{ DMA${v[0]}, DMA${v[0]}_Stream${v[1]}, ${v[1]}, DMAMUX1_Channel${(v[0] - 1) * 8 + v[1]}, ${v[2]} }`;
  else init = `{ GPDMA1_Channel${v[0]}, ${v[1]} }`;
  const where = kind === 'gpdma' ? `GPDMA1 kanal ${v[0]}, istek ${v[1]}` : kind === 'stream' ? `DMA${v[0]} stream ${v[1]}, kanal ${v[2]}` : kind === 'streammux' || kind === 'chmux' ? `DMA${v[0]} ${kind === 'chmux' ? 'kanal' : 'stream'} ${v[1]}, DMAMUX isteği ${v[2]}` : `DMA${v[0]} kanal ${v[1]}${k === 'l4' ? `, CSELR ${v[2]}` : ''}`;
  return { inst, name, init, where };
}

function dma(x) {
  const k = x.k;
  const kind = DMA_KIND[k];
  const ll = x.ll;
  const consts = Object.entries(DMA_MAP[k]).map(([n, v]) => dmaConst(k, n, v));
  const type = {
    ch: `typedef struct {
  DMA_TypeDef *dma;
  DMA_Channel_TypeDef *ch;
  uint8_t index; /* kanal numarası (1..) */${k === 'l4' ? '\n  DMA_Request_TypeDef *csel; /* istek seçimi (CSELR) */\n  uint8_t request;' : ''}
} es_dma_t;`,
    chmux: `typedef struct {
  DMA_TypeDef *dma;
  DMA_Channel_TypeDef *ch;
  uint8_t index; /* kanal numarası (1..) */
  DMAMUX_Channel_TypeDef *mux;
  uint8_t request; /* DMAMUX istek numarası */
} es_dma_t;`,
    stream: `typedef struct {
  DMA_TypeDef *dma;
  DMA_Stream_TypeDef *s;
  uint8_t index;   /* stream 0..7 */
  uint8_t channel; /* CHSEL */
} es_dma_t;`,
    streammux: `typedef struct {
  DMA_TypeDef *dma;
  DMA_Stream_TypeDef *s;
  uint8_t index; /* stream 0..7 */
  DMAMUX_Channel_TypeDef *mux;
  uint8_t request;
} es_dma_t;`,
    gpdma: `typedef struct {
  DMA_Channel_TypeDef *ch;
  uint8_t request; /* GPDMA1 istek numarası */
} es_dma_t;`
  }[kind];
  const h = core.header(x, 'dma', `${type}

#define ES_DMA_P2M   0x0U /* çevre birimi → bellek */
#define ES_DMA_M2P   0x1U /* bellek → çevre birimi */
#define ES_DMA_CIRC  0x2U /* dairesel (sürekli)${kind === 'gpdma' ? '; GPDMA\'da bağlı liste gerektirir, bu örnekte desteklenmez' : ''} */
#define ES_DMA_8BIT  0x00U
#define ES_DMA_16BIT 0x10U
#define ES_DMA_32BIT 0x20U

${k === 'h7' ? `/* H7: DMA1/DMA2 DTCM RAM'e (0x20000000) erişemez. DMA tamponlarını AXI SRAM'e koyun:
 *   static uint8_t buf[64] ES_DMA_BUFFER;   (linker betiğinde .dma_buffer bölümü RAM_D1'de) */
#define ES_DMA_BUFFER __attribute__((section(".dma_buffer"), aligned(32)))` : '#define ES_DMA_BUFFER /* bu ailede gerekmez */'}

/* Bu işlemci için hazır istek eşlemeleri (yoksa tanımlı değildir) */
${consts.map((d) => `#if defined(${d.inst})\nextern const es_dma_t ES_DMA_${d.name}; /* ${d.where} */\n#endif`).join('\n')}

void es_dma_clock_enable(void);
/* count: öğe sayısı (boyut ES_DMA_8/16/32BIT). 0 başarılı, -1 desteklenmeyen seçenek */
int es_dma_start(const es_dma_t *d, volatile void *periph, void *mem, uint16_t count, uint32_t flags);
void es_dma_stop(const es_dma_t *d);
int es_dma_done(const es_dma_t *d); /* aktarım bitti bayrağı (okununca temizlenir) */
uint16_t es_dma_remaining(const es_dma_t *d);
`);
  const en = [ll.dma1, ll.dma2, ll.dmamux, ll.gpdma].filter(Boolean).map((e) => `  RCC->${e.reg} |= ${e.bit};`).join('\n');
  let impl;
  if (kind === 'ch' || kind === 'chmux') {
    impl = `int es_dma_start(const es_dma_t *d, volatile void *periph, void *mem, uint16_t count, uint32_t flags)
{
  uint32_t sh = 4U * (d->index - 1U), size = (flags >> 4) & 3U;
  d->ch->CCR = 0;
  d->dma->IFCR = 0xFUL << sh; /* tüm bayrakları temizle */
${k === 'l4' ? '  d->csel->CSELR = (d->csel->CSELR & ~(0xFUL << sh)) | ((uint32_t)d->request << sh);\n' : ''}${kind === 'chmux' ? '  d->mux->CCR = d->request; /* DMAMUX: isteği kanala bağla */\n' : ''}  d->ch->CPAR = (uint32_t)periph;
  d->ch->CMAR = (uint32_t)mem;
  d->ch->CNDTR = count;
  d->ch->CCR = DMA_CCR_MINC | (size << 8) | (size << 10) | ((flags & ES_DMA_M2P) ? DMA_CCR_DIR : 0U) |
               ((flags & ES_DMA_CIRC) ? DMA_CCR_CIRC : 0U) | DMA_CCR_EN; /* PSIZE[9:8], MSIZE[11:10] */
  return 0;
}

void es_dma_stop(const es_dma_t *d)
{
  d->ch->CCR &= ~DMA_CCR_EN;
}

int es_dma_done(const es_dma_t *d)
{
  uint32_t tc = 2UL << (4U * (d->index - 1U)); /* TCIFx */
  if (!(d->dma->ISR & tc)) return 0;
  d->dma->IFCR = tc;
  return 1;
}

uint16_t es_dma_remaining(const es_dma_t *d)
{
  return (uint16_t)d->ch->CNDTR;
}`;
  } else if (kind === 'stream' || kind === 'streammux') {
    impl = `/* LISR (stream 0-3) / HISR (4-7) içinde 6 bitlik gruplar */
static const uint8_t flag_shift[4] = { 0, 6, 16, 22 };

int es_dma_start(const es_dma_t *d, volatile void *periph, void *mem, uint16_t count, uint32_t flags)
{
  uint32_t size = (flags >> 4) & 3U, sh = flag_shift[d->index & 3U];
  d->s->CR &= ~DMA_SxCR_EN;
  for (uint32_t n = 0; (d->s->CR & DMA_SxCR_EN) && n < ES_TIMEOUT; n++) {
  }
  if (d->index < 4U) d->dma->LIFCR = 0x3DUL << sh; else d->dma->HIFCR = 0x3DUL << sh;
${kind === 'streammux' ? '  d->mux->CCR = d->request; /* DMAMUX: isteği stream\'e bağla */\n' : ''}  d->s->PAR = (uint32_t)periph;
  d->s->M0AR = (uint32_t)mem;
  d->s->NDTR = count;
  d->s->FCR = 0; /* doğrudan mod (FIFO yok) */
  d->s->CR = ${kind === 'stream' ? '((uint32_t)d->channel << DMA_SxCR_CHSEL_Pos) | ' : ''}DMA_SxCR_MINC | (size << DMA_SxCR_PSIZE_Pos) | (size << DMA_SxCR_MSIZE_Pos) |
             ((flags & ES_DMA_M2P) ? DMA_SxCR_DIR_0 : 0U) | ((flags & ES_DMA_CIRC) ? DMA_SxCR_CIRC : 0U)${kind === 'streammux' ? `
#if defined(DMA_SxCR_TRBUFF)
             | DMA_SxCR_TRBUFF /* UART aktarımlarında gerekli (RM0433) */
#endif
             ` : ''};
  d->s->CR |= DMA_SxCR_EN;
  return 0;
}

void es_dma_stop(const es_dma_t *d)
{
  d->s->CR &= ~DMA_SxCR_EN;
}

int es_dma_done(const es_dma_t *d)
{
  uint32_t tc = 0x20UL << flag_shift[d->index & 3U]; /* TCIFx */
  volatile uint32_t *isr = d->index < 4U ? &d->dma->LISR : &d->dma->HISR;
  if (!(*isr & tc)) return 0;
  if (d->index < 4U) d->dma->LIFCR = tc; else d->dma->HIFCR = tc;
  return 1;
}

uint16_t es_dma_remaining(const es_dma_t *d)
{
  return (uint16_t)d->s->NDTR;
}`;
  } else {
    impl = `int es_dma_start(const es_dma_t *d, volatile void *periph, void *mem, uint16_t count, uint32_t flags)
{
  uint32_t size = (flags >> 4) & 3U, m2p = flags & ES_DMA_M2P;
  if (flags & ES_DMA_CIRC) return -1; /* GPDMA'da dairesel aktarım bağlı liste (LLI) ister */
  d->ch->CCR &= ~DMA_CCR_EN;
  d->ch->CFCR = DMA_CFCR_TCF | DMA_CFCR_HTF | DMA_CFCR_DTEF | DMA_CFCR_ULEF | DMA_CFCR_USEF | DMA_CFCR_SUSPF | DMA_CFCR_TOF;
  d->ch->CTR1 = (size << DMA_CTR1_SDW_LOG2_Pos) | (size << DMA_CTR1_DDW_LOG2_Pos) | (m2p ? DMA_CTR1_SINC : DMA_CTR1_DINC);
  d->ch->CTR2 = ((uint32_t)d->request << DMA_CTR2_REQSEL_Pos) | (m2p ? DMA_CTR2_DREQ : 0U); /* DREQ: istek hedef tarafta */
  d->ch->CBR1 = ((uint32_t)count << size) & DMA_CBR1_BNDT_Msk; /* byte cinsinden */
  d->ch->CSAR = m2p ? (uint32_t)mem : (uint32_t)periph;
  d->ch->CDAR = m2p ? (uint32_t)periph : (uint32_t)mem;
  d->ch->CLLR = 0;
  d->ch->CCR |= DMA_CCR_EN;
  return 0;
}

void es_dma_stop(const es_dma_t *d)
{
  d->ch->CCR &= ~DMA_CCR_EN;
}

int es_dma_done(const es_dma_t *d)
{
  if (!(d->ch->CSR & DMA_CSR_TCF)) return 0;
  d->ch->CFCR = DMA_CFCR_TCF;
  return 1;
}

uint16_t es_dma_remaining(const es_dma_t *d)
{
  return (uint16_t)(d->ch->CBR1 & DMA_CBR1_BNDT_Msk); /* kalan byte */
}`;
  }
  const c = `${core.banner(x, 'es_dma.c', 'DMA', [kind === 'gpdma' ? 'gpdma' : 'dma', ...(kind.includes('mux') ? ['dmamux'] : [])], `es_dma_clock_enable();\nstatic uint8_t msg[] ES_DMA_BUFFER = "merhaba\\r\\n";\nes_uart_write_dma(USART1, &ES_DMA_USART1_TX, msg, sizeof msg - 1);`)}#include "es_dma.h"

${consts.map((d) => `#if defined(${d.inst})\nconst es_dma_t ES_DMA_${d.name} = ${d.init};\n#endif`).join('\n')}

void es_dma_clock_enable(void)
{
${en}
  (void)RCC->CR;
}

${impl}
`;
  return { 'es_dma.h': core.banner(x, 'es_dma.h', 'DMA', ['dma']) + h, 'es_dma.c': c };
}

// ================================================================== ADC
function adc(x) {
  const k = x.k;
  const ip = x.fam.ip.adc;
  const adcDiv = [2, 4, 6, 8].find((d) => x.clock.freq.pclk2 / d <= (ip === 'f1' ? 14 : 36)) || 8;
  const rx = { mcu: x.mcu, fam: x.fam, clock: x.clock, adcDiv, buses: { adc: ['ADC1'] }, pclkOf: () => x.clock.freq.pclk2 };
  const init = reg.periphInit(rx, 'ADC1', { type: 'adc' });
  const read = reg.adcFunction(rx).replace('  uint32_t start = bsp_ticks;\n', '  uint32_t n = 0;\n').replace(/if \(\(bsp_ticks - start\) > BSP_TIMEOUT_MS\) return 0;/g, 'if (++n > ES_TIMEOUT) return 0;');
  // DMA ile tarama: dizi sırası (sequencer)
  const seq = ip === 'f1' || ip === 'f4'
    ? `  ADC1->SQR1 = (n - 1U) << ADC_SQR1_L_Pos;
  ADC1->SQR2 = 0;
  ADC1->SQR3 = 0;
  for (uint32_t r = 0; r < n; r++) {
    volatile uint32_t *sqr = r < 6U ? &ADC1->SQR3 : r < 12U ? &ADC1->SQR2 : &ADC1->SQR1;
    *sqr |= (uint32_t)channels[r] << (5U * (r % 6U));
  }
  ADC1->CR1 |= ADC_CR1_SCAN;
${ip === 'f4' ? '  ADC1->CR2 |= ADC_CR2_DMA | ADC_CR2_DDS | ADC_CR2_CONT;' : '  ADC1->CR2 |= ADC_CR2_DMA | ADC_CR2_CONT;'}`
    : ip === 'g0'
      ? `  /* F0/G0: kanallar maske ile seçilir, artan numara sırasıyla taranır */
  uint32_t mask = 0;
  for (uint32_t r = 0; r < n; r++) mask |= 1UL << channels[r];
#if defined(ADC_ISR_CCRDY)
  ADC1->ISR = ADC_ISR_CCRDY;
  ADC1->CHSELR = mask;
  for (uint32_t w = 0; !(ADC1->ISR & ADC_ISR_CCRDY) && w < ES_TIMEOUT; w++) {
  }
#else
  ADC1->CHSELR = mask;
#endif
  ADC1->CFGR1 |= ADC_CFGR1_DMAEN | ADC_CFGR1_DMACFG | ADC_CFGR1_CONT;`
      : `  /* SQR1: L[3:0] + SQ1..SQ4 (6 bit aralıkla), SQR2: SQ5..SQ9, SQR3: SQ10..SQ14, SQR4: SQ15..SQ16 */
  volatile uint32_t *sqr[4] = { &ADC1->SQR1, &ADC1->SQR2, &ADC1->SQR3, &ADC1->SQR4 };
  ADC1->SQR1 = (n - 1U) << ADC_SQR1_L_Pos;
  ADC1->SQR2 = ADC1->SQR3 = ADC1->SQR4 = 0;
  for (uint32_t r = 0; r < n; r++) {
    uint32_t pos = r + 1U; /* SQ1 SQR1'de 1. alan */
${k === 'h7' || k === 'u5' ? `    ADC1->${/^STM32H7[23]/.test(x.mcu.device.define) ? 'PCSEL_RES0' : 'PCSEL'} |= 1UL << channels[r];\n` : ''}    *sqr[pos / 5U] |= (uint32_t)channels[r] << (6U * (pos % 5U));
  }
${k === 'h7' ? '  ADC1->CFGR |= ADC_CFGR_DMNGT_0 | ADC_CFGR_DMNGT_1 | ADC_CFGR_CONT; /* DMA dairesel */' : k === 'u5' ? '  ADC1->CFGR1 |= ADC_CFGR1_DMNGT_0; /* DMA tek seferlik (GPDMA dairesel değil) */' : '  ADC1->CFGR |= ADC_CFGR_DMAEN | ADC_CFGR_DMACFG | ADC_CFGR_CONT;'}`;
  const start = ip === 'f1' || ip === 'f4' ? '  ADC1->CR2 |= ADC_CR2_SWSTART;' : '  ADC1->CR |= ADC_CR_ADSTART;';
  const circ = k === 'u5' ? '' : ' | ES_DMA_CIRC';
  const h = core.header(x, 'adc', `#include "es_dma.h"

/* ADC1: saat, kalibrasyon, 12 bit. Kanal girişlerini es_gpio_init(..., ES_GPIO_ANALOG, ...) ile analog yapın.
 * ADC saati oluşturulduğu andaki saat ayarına göre seçildi (HCLK ${x.clock.freq.hclk} MHz). */
void es_adc_init(void);
uint16_t es_adc_read(uint32_t channel); /* tek dönüşüm, yoklamalı (0: zaman aşımı) */

/* DMA ile tarama: channels[0..n-1] sırayla örneklenir, sonuçlar buf'a yazılır${k === 'u5' ? ' (U5: tek tarama; yeniden çağırın)' : ', sürekli (dairesel)'}.
 * Tarama başladıktan sonra es_adc_read kullanmayın. */
int es_adc_scan_dma_start(const uint8_t *channels, uint32_t n, uint16_t *buf);
`);
  const c = `${core.banner(x, 'es_adc.c', 'ADC: tek kanal ve DMA ile tarama', ['adc', 'dma'], `es_adc_init();\nuint16_t v = es_adc_read(1);\n\nstatic const uint8_t ch[] = { 1, 4, 5 };\nstatic uint16_t sonuc[3] ES_DMA_BUFFER;\nes_dma_clock_enable();\nes_adc_scan_dma_start(ch, 3, sonuc); /* sonuc[] sürekli güncellenir */`)}#include "es_adc.h"

void es_adc_init(void)
{
${init.split('\n').map((l) => (l.startsWith('#') ? l : `  ${l}`)).join('\n')}
}

uint16_t es_adc_read(uint32_t channel)
{
${read}
}

int es_adc_scan_dma_start(const uint8_t *channels, uint32_t n, uint16_t *buf)
{
  if (n == 0U || n > 16U) return -1;
${seq}
  if (es_dma_start(&ES_DMA_ADC1, (volatile void *)&ADC1->DR, buf, (uint16_t)n, ES_DMA_P2M | ES_DMA_16BIT${circ})) return -1;
${start}
  return 0;
}
`;
  return { 'es_adc.h': core.banner(x, 'es_adc.h', 'ADC', ['adc']) + h, 'es_adc.c': c };
}

// ================================================================== DAC
function dac(x) {
  const d = x.ll.dac;
  const D = d.instance;
  const h = core.header(x, 'dac', `/* ${D}: kanal 1 (PA4) / kanal 2 (PA5), 12 bit sağa hizalı. Pini es_gpio_init(..., ES_GPIO_ANALOG, ...) ile analog yapın. */
void es_dac_init(uint32_t channel);
void es_dac_write(uint32_t channel, uint16_t value12);
`);
  const c = `${core.banner(x, 'es_dac.c', 'DAC', ['dac'], 'es_dac_init(1);\nes_dac_write(1, 2048); /* ~VREF/2 */')}#include "es_dac.h"

void es_dac_init(uint32_t channel)
{
  RCC->${d.reg} |= ${d.bit};
  (void)RCC->${d.reg};
${x.k === 'u5' ? '  PWR->SVMCR |= PWR_SVMCR_ASV; /* VDDA geçerli (U5) */\n' : ''}#if defined(DAC_MCR_HFSEL)
  /* Yüksek frekans arayüz modu: AHB > 80 MHz (G4/U5) */
  ${D}->MCR = (${D}->MCR & ~DAC_MCR_HFSEL) | (SystemCoreClock > 160000000U ? DAC_MCR_HFSEL_1 : SystemCoreClock > 80000000U ? DAC_MCR_HFSEL_0 : 0U);
#endif
  ${D}->CR |= channel == 2U ? DAC_CR_EN2 : DAC_CR_EN1;
}

void es_dac_write(uint32_t channel, uint16_t value12)
{
  if (channel == 2U) ${D}->DHR12R2 = value12 & 0xFFFU;
  else ${D}->DHR12R1 = value12 & 0xFFFU;
}
`;
  return { 'es_dac.h': core.banner(x, 'es_dac.h', 'DAC', ['dac']) + h, 'es_dac.c': c };
}

// ================================================================== IWDG / WWDG / CRC
function iwdg(x) {
  const I = x.ll.iwdg || 'IWDG';
  const lsi = ['f0', 'f1', 'f3'].includes(x.k) ? 40000 : 32000;
  const h = core.header(x, 'iwdg', `#define ES_LSI_HZ ${lsi}U /* tipik LSI; gerçek değer ±%10'dan fazla sapabilir, payı bırakın */

/* Bağımsız watchdog'u başlatır (durdurulamaz). timeout_ms: en fazla ~${Math.floor((4096 * 256 * 1000) / lsi)} ms */
void es_iwdg_start(uint32_t timeout_ms);
static inline void es_iwdg_refresh(void) { ${I}->KR = 0xAAAAU; }
`);
  const c = `${core.banner(x, 'es_iwdg.c', 'bağımsız watchdog', ['iwdg'], 'es_iwdg_start(500);\nfor (;;) { /* iş */ es_iwdg_refresh(); }')}#include "es_iwdg.h"

void es_iwdg_start(uint32_t timeout_ms)
{
  uint32_t pr = 0, ticks = (ES_LSI_HZ / 1000U) * timeout_ms / 4U; /* /4 ile başla */
  while (ticks > 0xFFFU && pr < 6U) {
    ticks /= 2U;
    pr++;
  }
  if (ticks > 0xFFFU) ticks = 0xFFFU;
  if (ticks == 0U) ticks = 1U;
  ${I}->KR = 0xCCCCU; /* başlat (LSI'yı da açar) */
  ${I}->KR = 0x5555U; /* PR/RLR yazma izni */
  ${I}->PR = pr;      /* /4 · 2^pr */
  ${I}->RLR = ticks - 1U;
  for (uint32_t n = 0; ${I}->SR && n < ES_TIMEOUT; n++) {
  } /* PVU/RVU bitleri sıfırlanana dek */
  ${I}->KR = 0xAAAAU;
}
`;
  return { 'es_iwdg.h': core.banner(x, 'es_iwdg.h', 'bağımsız watchdog', ['iwdg']) + h, 'es_iwdg.c': c };
}

function wwdg(x) {
  const W = x.ll.wwdgInstance || 'WWDG';
  const e = x.ll.wwdg;
  const h = core.header(x, 'wwdg', `/* Pencereli watchdog. counter: 0x40..0x7F (0x3F'e inince reset), window: bu değerden büyükken yenilemek reset.
 * prescaler_log2: WDGTB (sayaç saati = PCLK / 4096 / 2^prescaler_log2) */
void es_wwdg_start(uint8_t counter, uint8_t window, uint32_t prescaler_log2);
static inline void es_wwdg_refresh(uint8_t counter) { ${W}->CR = counter & 0x7FU; }
`);
  const c = `${core.banner(x, 'es_wwdg.c', 'pencereli watchdog', ['wwdg'], 'es_wwdg_start(0x7F, 0x5F, 3);\n/* sayaç 0x5F altına inince ve 0x40 olmadan önce: */\nes_wwdg_refresh(0x7F);')}#include "es_wwdg.h"

void es_wwdg_start(uint8_t counter, uint8_t window, uint32_t prescaler_log2)
{
  ${e ? `RCC->${e.reg} |= ${e.bit};` : 'RCC->APB1ENR |= RCC_APB1ENR_WWDGEN;'}
  (void)RCC->CR;
  ${W}->CFR = ((prescaler_log2 << WWDG_CFR_WDGTB_Pos) & WWDG_CFR_WDGTB) | (window & 0x7FU);
  ${W}->CR = WWDG_CR_WDGA | (counter & 0x7FU);
}
`;
  return { 'es_wwdg.h': core.banner(x, 'es_wwdg.h', 'pencereli watchdog', ['wwdg']) + h, 'es_wwdg.c': c };
}

function crc(x) {
  const e = x.ll.crc;
  const h = core.header(x, 'crc', `/* CRC-32 (polinom 0x04C11DB7, başlangıç 0xFFFFFFFF, bit ters çevirme yok, son XOR yok — STM32 varsayılanı).
 * Ethernet/zlib CRC-32'si için girişi ve çıkışı bit bazında ters çevirip sonucu 0xFFFFFFFF ile XOR'layın. */
void es_crc_init(void);
uint32_t es_crc32(const uint32_t *words, uint32_t n);
`);
  const c = `${core.banner(x, 'es_crc.c', 'donanım CRC', ['crc'], 'es_crc_init();\nuint32_t c = es_crc32(veri, kelime_sayisi);')}#include "es_crc.h"

void es_crc_init(void)
{
  ${e ? `RCC->${e.reg} |= ${e.bit};` : 'RCC->AHB1ENR |= RCC_AHB1ENR_CRCEN;'}
  (void)RCC->CR;
}

uint32_t es_crc32(const uint32_t *words, uint32_t n)
{
  CRC->CR = CRC_CR_RESET;
  for (uint32_t i = 0; i < n; i++) CRC->DR = words[i];
  return CRC->DR;
}
`;
  return { 'es_crc.h': core.banner(x, 'es_crc.h', 'donanım CRC', ['crc']) + h, 'es_crc.c': c };
}

// ================================================================== FLASH
function flash(x) {
  const k = x.k;
  const F = x.mcu.device.flash;
  const kb = x.mcu.device.flashKB;
  const unit = F.unit;
  const type = ['f0', 'f1', 'f3'].includes(k) ? 'f1' : ['f4', 'f7'].includes(k) ? 'f4' : ['g0', 'g4', 'l4'].includes(k) ? 'l4' : k;
  const layout = F.type === 'sector'
    ? `/* Sektörler: { ofset, boyut, SNB, banka } */
typedef struct { uint32_t offset, size; uint8_t snb, bank; } es_sector_t;
static const es_sector_t sectors[] = {
${F.sectors.map(([off, size, snb, bank]) => `  { 0x${(off * 1024).toString(16).toUpperCase()}U, ${size * 1024}U, ${snb}, ${bank} },`).join('\n')}
};

static const es_sector_t *sector_of(uint32_t address)
{
  uint32_t off = address - ES_FLASH_BASE;
  for (uint32_t i = 0; i < sizeof sectors / sizeof sectors[0]; i++) {
    if (off >= sectors[i].offset && off < sectors[i].offset + sectors[i].size) return &sectors[i];
  }
  return 0;
}`
    : `#define ES_FLASH_PAGE_SIZE ${F.pageKB * 1024}U
#define ES_FLASH_PAGES_PER_BANK ${F.pagesPerBank}U /* ${F.banks} banka */`;
  const h = core.header(x, 'flash', `#define ES_FLASH_BASE  0x08000000U
#define ES_FLASH_SIZE  (${kb}U * 1024U)
#define ES_FLASH_ALIGN ${unit}U /* programlama birimi (byte): adres ve uzunluk bunun katı olmalı */

/* Kilidi aç / kapat. Silme ve yazma bu ikisi arasında yapılır. */
void es_flash_unlock(void);
void es_flash_lock(void);
/* address'i içeren ${F.type === 'sector' ? 'sektörü' : 'sayfayı'} siler (${F.type === 'sector' ? 'sektör boyutları farklıdır, bkz. es_flash.c' : `${F.pageKB} KB`}). 0 başarılı, -1 hata.
 * Çalışan kodun bulunduğu bölgeyi silmeyin; işlem bitene dek CPU flash'tan kod okuyamaz (bekler). */
int es_flash_erase(uint32_t address);
/* len byte yazar (ES_FLASH_ALIGN katları). Hedef silinmiş (0xFF) olmalı. 0 başarılı, -1 hata. */
int es_flash_program(uint32_t address, const void *data, uint32_t len);
`);
  let impl;
  if (type === 'f1') {
    impl = `#if defined(FLASH_SR_WRPRTERR)
#define ES_FLASH_WRPERR FLASH_SR_WRPRTERR
#else
#define ES_FLASH_WRPERR FLASH_SR_WRPERR
#endif
#define ES_FLASH_ERR (FLASH_SR_PGERR | ES_FLASH_WRPERR)

void es_flash_unlock(void)
{
  if (FLASH->CR & FLASH_CR_LOCK) {
    FLASH->KEYR = 0x45670123U;
    FLASH->KEYR = 0xCDEF89ABU;
  }
}

void es_flash_lock(void) { FLASH->CR |= FLASH_CR_LOCK; }

static int wait(void)
{
  for (uint32_t n = 0; FLASH->SR & FLASH_SR_BSY; n++) if (n > ES_TIMEOUT) return -1;
  uint32_t sr = FLASH->SR;
  FLASH->SR = sr & (FLASH_SR_EOP | ES_FLASH_ERR); /* 1 yazarak temizlenir */
  return (sr & ES_FLASH_ERR) ? -1 : 0;
}

int es_flash_erase(uint32_t address)
{
  if (wait()) return -1;
  FLASH->CR |= FLASH_CR_PER;
  FLASH->AR = address;
  FLASH->CR |= FLASH_CR_STRT;
  int r = wait();
  FLASH->CR &= ~FLASH_CR_PER;
  return r;
}

int es_flash_program(uint32_t address, const void *data, uint32_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  int r = 0;
  if ((address | len) & 1U) return -1;
  FLASH->CR |= FLASH_CR_PG;
  for (uint32_t i = 0; i < len && !r; i += 2U) {
    *(volatile uint16_t *)(address + i) = (uint16_t)(p[i] | (p[i + 1U] << 8)); /* yarım kelime */
    r = wait();
  }
  FLASH->CR &= ~FLASH_CR_PG;
  return r;
}`;
  } else if (type === 'f4') {
    impl = `#define ES_FLASH_ERR (FLASH_SR_OPERR | FLASH_SR_WRPERR | FLASH_SR_PGAERR | FLASH_SR_PGPERR${k === 'f7' ? ' | FLASH_SR_ERSERR' : ' | FLASH_SR_PGSERR'})

void es_flash_unlock(void)
{
  if (FLASH->CR & FLASH_CR_LOCK) {
    FLASH->KEYR = 0x45670123U;
    FLASH->KEYR = 0xCDEF89ABU;
  }
}

void es_flash_lock(void) { FLASH->CR |= FLASH_CR_LOCK; }

static int wait(void)
{
  for (uint32_t n = 0; FLASH->SR & FLASH_SR_BSY; n++) if (n > ES_TIMEOUT) return -1;
  uint32_t sr = FLASH->SR;
  FLASH->SR = sr & (FLASH_SR_EOP | ES_FLASH_ERR);
  return (sr & ES_FLASH_ERR) ? -1 : 0;
}

${layout}

int es_flash_erase(uint32_t address)
{
  const es_sector_t *s = sector_of(address);
  if (!s || wait()) return -1;
  /* 32 bit paralellik (PSIZE = x32): 2.7-3.6 V besleme için */
  FLASH->CR = (FLASH->CR & ~(FLASH_CR_SNB | FLASH_CR_PSIZE)) | FLASH_CR_SER | ((uint32_t)s->snb << FLASH_CR_SNB_Pos) | FLASH_CR_PSIZE_1;
  FLASH->CR |= FLASH_CR_STRT;
  int r = wait();
  FLASH->CR &= ~FLASH_CR_SER;
  return r;
}

int es_flash_program(uint32_t address, const void *data, uint32_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  int r = 0;
  if ((address | len) & 3U) return -1;
  FLASH->CR = (FLASH->CR & ~FLASH_CR_PSIZE) | FLASH_CR_PSIZE_1 | FLASH_CR_PG;
  for (uint32_t i = 0; i < len && !r; i += 4U) {
    uint32_t w = (uint32_t)p[i] | ((uint32_t)p[i + 1U] << 8) | ((uint32_t)p[i + 2U] << 16) | ((uint32_t)p[i + 3U] << 24);
    *(volatile uint32_t *)(address + i) = w;
    __DSB();
    r = wait();
  }
  FLASH->CR &= ~FLASH_CR_PG;
  return r;
}`;
  } else if (type === 'l4') {
    const bsy = k === 'g0' ? 'FLASH_SR_BSY1' : 'FLASH_SR_BSY';
    const dual = F.banks > 1;
    impl = `#define ES_FLASH_ERR (FLASH_SR_OPERR | FLASH_SR_PROGERR | FLASH_SR_WRPERR | FLASH_SR_PGAERR | FLASH_SR_SIZERR | FLASH_SR_PGSERR | FLASH_SR_MISERR | FLASH_SR_FASTERR)
${layout}

void es_flash_unlock(void)
{
  if (FLASH->CR & FLASH_CR_LOCK) {
    FLASH->KEYR = 0x45670123U;
    FLASH->KEYR = 0xCDEF89ABU;
  }
}

void es_flash_lock(void) { FLASH->CR |= FLASH_CR_LOCK; }

static int wait(void)
{
  for (uint32_t n = 0; FLASH->SR & ${bsy}; n++) if (n > ES_TIMEOUT) return -1;
  uint32_t sr = FLASH->SR;
  FLASH->SR = sr & (FLASH_SR_EOP | ES_FLASH_ERR);
  return (sr & ES_FLASH_ERR) ? -1 : 0;
}

int es_flash_erase(uint32_t address)
{
  uint32_t page = (address - ES_FLASH_BASE) / ES_FLASH_PAGE_SIZE;
  if (address < ES_FLASH_BASE || page >= ${F.pagesPerBank * F.banks}U || wait()) return -1;
${dual ? `  /* Çift banka: her bankada sayfalar 0'dan numaralanır, BKER bankayı seçer (DBANK = 1, varsayılan) */
  uint32_t bank2 = page >= ES_FLASH_PAGES_PER_BANK;
  FLASH->CR = (FLASH->CR & ~(FLASH_CR_PNB | FLASH_CR_BKER)) | FLASH_CR_PER | ((page % ES_FLASH_PAGES_PER_BANK) << FLASH_CR_PNB_Pos) | (bank2 ? FLASH_CR_BKER : 0U);` : '  FLASH->CR = (FLASH->CR & ~FLASH_CR_PNB) | FLASH_CR_PER | (page << FLASH_CR_PNB_Pos);'}
  FLASH->CR |= FLASH_CR_STRT;
  int r = wait();
  FLASH->CR &= ~FLASH_CR_PER;
  return r;
}

int es_flash_program(uint32_t address, const void *data, uint32_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  int r = 0;
  if ((address | len) & 7U) return -1;
  FLASH->CR |= FLASH_CR_PG;
  for (uint32_t i = 0; i < len && !r; i += 8U) {
    uint32_t w0, w1;
    __builtin_memcpy(&w0, p + i, 4);
    __builtin_memcpy(&w1, p + i + 4U, 4);
    *(volatile uint32_t *)(address + i) = w0; /* çift kelime: iki 32 bit yazma art arda */
    __ISB();
    *(volatile uint32_t *)(address + i + 4U) = w1;
    r = wait();
  }
  FLASH->CR &= ~FLASH_CR_PG;
  return r;
}`;
  } else if (type === 'h7') {
    const dual = F.sectors.some((s) => s[3] === 2);
    impl = `#define ES_FLASH_ERR (FLASH_SR_WRPERR | FLASH_SR_PGSERR | FLASH_SR_STRBERR | FLASH_SR_INCERR | FLASH_SR_OPERR)

${layout}

void es_flash_unlock(void)
{
  if (FLASH->CR1 & FLASH_CR_LOCK) {
    FLASH->KEYR1 = 0x45670123U;
    FLASH->KEYR1 = 0xCDEF89ABU;
  }
${dual ? `  if (FLASH->CR2 & FLASH_CR_LOCK) {
    FLASH->KEYR2 = 0x45670123U;
    FLASH->KEYR2 = 0xCDEF89ABU;
  }
` : ''}}

void es_flash_lock(void)
{
  FLASH->CR1 |= FLASH_CR_LOCK;
${dual ? '  FLASH->CR2 |= FLASH_CR_LOCK;\n' : ''}}

/* Banka register'ları: CR/SR/CCR 1 ve 2 */
static int wait(uint32_t bank)
{
  volatile uint32_t *sr = ${dual ? 'bank == 2U ? &FLASH->SR2 : ' : ''}&FLASH->SR1;
  volatile uint32_t *ccr = ${dual ? 'bank == 2U ? &FLASH->CCR2 : ' : ''}&FLASH->CCR1;
  (void)bank;
  for (uint32_t n = 0; *sr & (FLASH_SR_QW | FLASH_SR_BSY); n++) if (n > ES_TIMEOUT) return -1;
  uint32_t s = *sr;
  *ccr = s & (FLASH_SR_EOP | ES_FLASH_ERR); /* bayraklar CCR'deki aynı bitlerle temizlenir */
  return (s & ES_FLASH_ERR) ? -1 : 0;
}

int es_flash_erase(uint32_t address)
{
  const es_sector_t *s = sector_of(address);
  if (!s) return -1;
  volatile uint32_t *cr = ${dual ? 's->bank == 2U ? &FLASH->CR2 : ' : ''}&FLASH->CR1;
  if (wait(s->bank)) return -1;
  *cr = (*cr & ~(FLASH_CR_SNB | FLASH_CR_PSIZE)) | FLASH_CR_SER | ((uint32_t)s->snb << FLASH_CR_SNB_Pos) | FLASH_CR_PSIZE_1;
  *cr |= FLASH_CR_START;
  int r = wait(s->bank);
  *cr &= ~FLASH_CR_SER;
  return r;
}

int es_flash_program(uint32_t address, const void *data, uint32_t len)
{
  const es_sector_t *s = sector_of(address);
  const uint8_t *p = (const uint8_t *)data;
  int r = 0;
  if (!s || ((address | len) & 31U)) return -1;
  volatile uint32_t *cr = ${dual ? 's->bank == 2U ? &FLASH->CR2 : ' : ''}&FLASH->CR1;
  *cr |= FLASH_CR_PG;
  for (uint32_t i = 0; i < len && !r; i += 32U) {
    /* 256 bit flash kelimesi: 8 × 32 bit yazma; son yazmada programlama başlar */
    for (uint32_t w = 0; w < 8U; w++) {
      uint32_t v;
      __builtin_memcpy(&v, p + i + 4U * w, 4);
      *(volatile uint32_t *)(address + i + 4U * w) = v;
    }
    __ISB();
    __DSB();
    r = wait(s->bank);
  }
  *cr &= ~FLASH_CR_PG;
  return r;
}`;
  } else {
    impl = `#define ES_FLASH_ERR (FLASH_NSSR_OPERR | FLASH_NSSR_PROGERR | FLASH_NSSR_WRPERR | FLASH_NSSR_PGAERR | FLASH_NSSR_SIZERR | FLASH_NSSR_PGSERR)
${layout}

void es_flash_unlock(void)
{
  if (FLASH->NSCR & FLASH_NSCR_LOCK) {
    FLASH->NSKEYR = 0x45670123U;
    FLASH->NSKEYR = 0xCDEF89ABU;
  }
}

void es_flash_lock(void) { FLASH->NSCR |= FLASH_NSCR_LOCK; }

static int wait(void)
{
  for (uint32_t n = 0; FLASH->NSSR & (FLASH_NSSR_BSY | FLASH_NSSR_WDW); n++) if (n > ES_TIMEOUT) return -1;
  uint32_t sr = FLASH->NSSR;
  FLASH->NSSR = sr & (FLASH_NSSR_EOP | ES_FLASH_ERR);
  return (sr & ES_FLASH_ERR) ? -1 : 0;
}

int es_flash_erase(uint32_t address)
{
  uint32_t page = (address - ES_FLASH_BASE) / ES_FLASH_PAGE_SIZE;
  if (address < ES_FLASH_BASE || page >= ${F.pagesPerBank * F.banks}U || wait()) return -1;
  uint32_t bank2 = page >= ES_FLASH_PAGES_PER_BANK; /* SWAP_BANK = 0 varsayılır */
  FLASH->NSCR = (FLASH->NSCR & ~(FLASH_NSCR_PNB | FLASH_NSCR_BKER)) | FLASH_NSCR_PER | ((page % ES_FLASH_PAGES_PER_BANK) << FLASH_NSCR_PNB_Pos) | (bank2 ? FLASH_NSCR_BKER : 0U);
  FLASH->NSCR |= FLASH_NSCR_STRT;
  int r = wait();
  FLASH->NSCR &= ~FLASH_NSCR_PER;
  return r;
}

int es_flash_program(uint32_t address, const void *data, uint32_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  int r = 0;
  if ((address | len) & 15U) return -1;
  FLASH->NSCR |= FLASH_NSCR_PG;
  for (uint32_t i = 0; i < len && !r; i += 16U) {
    for (uint32_t w = 0; w < 4U; w++) { /* 128 bit dörtlü kelime */
      uint32_t v;
      __builtin_memcpy(&v, p + i + 4U * w, 4);
      *(volatile uint32_t *)(address + i + 4U * w) = v;
    }
    r = wait();
  }
  FLASH->NSCR &= ~FLASH_NSCR_PG;
  return r;
}`;
  }
  const lastPage = F.type === 'sector' ? F.sectors[F.sectors.length - 1] : null;
  const exampleAddr = F.type === 'sector' ? `0x${(0x08000000 + lastPage[0] * 1024).toString(16).toUpperCase()}U` : `0x${(0x08000000 + kb * 1024 - F.pageKB * 1024).toString(16).toUpperCase()}U`;
  const c = `${core.banner(x, 'es_flash.c', 'flash silme ve programlama', ['flash'], `/* Son ${F.type === 'sector' ? 'sektöre' : 'sayfaya'} ayar kaydı (uygulama kodunuzun oraya uzanmadığından emin olun) */\nstatic const uint8_t ayar[${unit < 8 ? 8 : unit}] = { 1, 2, 3, 4, 5, 6, 7, 8 };\nes_flash_unlock();\nes_flash_erase(${exampleAddr});\nes_flash_program(${exampleAddr}, ayar, sizeof ayar);\nes_flash_lock();`)}#include "es_flash.h"

${impl}
`;
  return { 'es_flash.h': core.banner(x, 'es_flash.h', 'flash silme ve programlama', ['flash']) + h, 'es_flash.c': c };
}

module.exports = { dma, adc, dac, iwdg, wwdg, crc, flash, DMA_MAP, DMA_KIND };
