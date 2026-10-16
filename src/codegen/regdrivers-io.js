// @ts-check
/** ES-107 örnek sürücüleri: UART, SPI, I2C, TIM (bkz. regdrivers.js) */
const core = require('./regdrivers');
const { COMPAT } = require('./regcode');

// ================================================================== UART
function uart(x) {
  const v1 = x.fam.ip.usart === 'v1';
  const h = core.header(x, 'uart', `#include "es_dma.h"

#ifndef ES_UART_RING_SIZE
#define ES_UART_RING_SIZE 128U /* 2'nin kuvveti olması gerekmez */
#endif

/* Kesmeyle alma için halka tampon: her UART için bir tane tanımlayın (static es_uart_ring_t rx;) */
typedef struct {
  volatile uint16_t head, tail;
  uint8_t buf[ES_UART_RING_SIZE];
} es_uart_ring_t;

void es_uart_clock_enable(USART_TypeDef *u);
/* 8N1, gönderme + alma. pclk_hz: UART'ın bağlı olduğu bus saati (es_rcc_pclk1_hz / pclk2_hz) */
void es_uart_init(USART_TypeDef *u, uint32_t pclk_hz, uint32_t baud);

/* ---- yoklamalı (polling) ---- */
void es_uart_putc(USART_TypeDef *u, uint8_t c);
void es_uart_write(USART_TypeDef *u, const void *data, uint32_t len);
int es_uart_getc(USART_TypeDef *u); /* -1: ES_TIMEOUT döngüde veri gelmedi */

/* ---- kesme ile alma ----
 * es_uart_rx_irq_start(USART2, USART2_IRQn, 6);
 * void USART2_IRQHandler(void) { es_uart_irq_handler(USART2, &rx); } */
void es_uart_rx_irq_start(USART_TypeDef *u, IRQn_Type irq, uint32_t priority);
void es_uart_irq_handler(USART_TypeDef *u, es_uart_ring_t *ring);
uint32_t es_uart_available(const es_uart_ring_t *ring);
int es_uart_read(es_uart_ring_t *ring); /* -1: tampon boş */

/* ---- DMA ile gönderme (bekletmez) ----
 * es_uart_write_dma(USART1, &ES_DMA_USART1_TX, buf, n); while (es_uart_dma_busy(&ES_DMA_USART1_TX)) {} */
int es_uart_write_dma(USART_TypeDef *u, const es_dma_t *dma, const void *data, uint16_t len);
int es_uart_dma_busy(const es_dma_t *dma);
`);
  const R = v1
    ? { txe: 'u->SR & USART_SR_TXE', tc: 'u->SR & USART_SR_TC', rxne: 'u->SR & USART_SR_RXNE', tdr: 'u->DR', rdr: 'u->DR', tdrAddr: '&u->DR' }
    : { txe: 'u->ISR & USART_ISR_TXE', tc: 'u->ISR & USART_ISR_TC', rxne: 'u->ISR & USART_ISR_RXNE', tdr: 'u->TDR', rdr: 'u->RDR', tdrAddr: '&u->TDR' };
  const c = `${core.banner(x, 'es_uart.c', 'U(S)ART: yoklama, kesme, DMA', ['uart', 'dma'], `es_uart_clock_enable(USART2);\n/* TX/RX pinlerini es_gpio_init(..., ES_GPIO_AF, ...) ile ayarlayın */\nes_uart_init(USART2, es_rcc_pclk1_hz(), 115200);\nes_uart_write(USART2, "merhaba\\r\\n", 9);`)}#include "es_uart.h"

${COMPAT}
void es_uart_clock_enable(USART_TypeDef *u)
{
${core.clockSwitch(x, 'uart', 'u')}
}

void es_uart_init(USART_TypeDef *u, uint32_t pclk_hz, uint32_t baud)
{
  u->CR1 = 0;
  u->BRR = (pclk_hz + baud / 2U) / baud; /* 16x örnekleme: BRR = fCK / baud */
  u->CR1 = USART_CR1_TE | USART_CR1_RE | USART_CR1_UE;
}

void es_uart_putc(USART_TypeDef *u, uint8_t c)
{
  for (uint32_t n = 0; n < ES_TIMEOUT && !(${R.txe}); n++) {
  }
  ${R.tdr} = c;
}

void es_uart_write(USART_TypeDef *u, const void *data, uint32_t len)
{
  const uint8_t *p = (const uint8_t *)data;
  for (uint32_t i = 0; i < len; i++) es_uart_putc(u, p[i]);
  for (uint32_t n = 0; n < ES_TIMEOUT && !(${R.tc}); n++) {
  } /* son bitin hatta çıkmasını bekle */
}

int es_uart_getc(USART_TypeDef *u)
{
  for (uint32_t n = 0; n < ES_TIMEOUT; n++) {
    if (${R.rxne}) return (int)(${R.rdr} & 0xFFU);
  }
  return -1;
}

void es_uart_rx_irq_start(USART_TypeDef *u, IRQn_Type irq, uint32_t priority)
{
  u->CR1 |= USART_CR1_RXNEIE;
  NVIC_SetPriority(irq, priority);
  NVIC_EnableIRQ(irq);
}

void es_uart_irq_handler(USART_TypeDef *u, es_uart_ring_t *ring)
{
${v1 ? `  uint32_t sr = u->SR;
  if (sr & (USART_SR_RXNE | USART_SR_ORE)) {
    uint8_t b = (uint8_t)u->DR; /* SR sonra DR okumak ORE/FE/NE bayraklarını da temizler */
    if (sr & USART_SR_RXNE) {` : `  uint32_t isr = u->ISR;
  if (isr & (USART_ISR_ORE | USART_ISR_FE | USART_ISR_NE)) u->ICR = USART_ICR_ORECF | USART_ICR_FECF | USART_ICR_NECF;
  if (isr & USART_ISR_RXNE) {
    uint8_t b = (uint8_t)u->RDR;
    {`}
      uint16_t next = (uint16_t)((ring->head + 1U) % ES_UART_RING_SIZE);
      if (next != ring->tail) { /* doluysa yeni byte atılır */
        ring->buf[ring->head] = b;
        ring->head = next;
      }
    }
  }
}

uint32_t es_uart_available(const es_uart_ring_t *ring)
{
  return (uint32_t)((ring->head + ES_UART_RING_SIZE - ring->tail) % ES_UART_RING_SIZE);
}

int es_uart_read(es_uart_ring_t *ring)
{
  if (ring->head == ring->tail) return -1;
  uint8_t b = ring->buf[ring->tail];
  ring->tail = (uint16_t)((ring->tail + 1U) % ES_UART_RING_SIZE);
  return b;
}

int es_uart_write_dma(USART_TypeDef *u, const es_dma_t *dma, const void *data, uint16_t len)
{
  u->CR3 |= USART_CR3_DMAT;
  ${v1 ? 'u->SR &= ~USART_SR_TC;' : 'u->ICR = USART_ICR_TCCF;'}
  return es_dma_start(dma, (volatile void *)${R.tdrAddr}, (void *)(uintptr_t)data, len, ES_DMA_M2P | ES_DMA_8BIT);
}

int es_uart_dma_busy(const es_dma_t *dma)
{
  return es_dma_remaining(dma) != 0U;
}
`;
  return { 'es_uart.h': core.banner(x, 'es_uart.h', 'U(S)ART: yoklama, kesme, DMA', ['uart']) + h, 'es_uart.c': c };
}

// ================================================================== SPI
function spi(x) {
  const ip = x.fam.ip.spi;
  const h = core.header(x, 'spi', `void es_spi_clock_enable(SPI_TypeDef *spi);
/* Master, 8 bit, MSB önce, yazılım NSS (CS pinini GPIO ile sürün).
 * br: 0..7 → saat = fSPI / 2^(br+1)   mode: 0..3 (CPOL = mode>>1, CPHA = mode&1) */
void es_spi_init(SPI_TypeDef *spi, uint32_t br, uint32_t mode);
uint8_t es_spi_xfer(SPI_TypeDef *spi, uint8_t b);
/* tx NULL ise 0xFF gönderilir, rx NULL ise okunan atılır. 0 başarılı, -1 zaman aşımı */
int es_spi_transfer(SPI_TypeDef *spi, const uint8_t *tx, uint8_t *rx, uint32_t len);
`);
  const init = ip === 'v2'
    ? `  spi->CR1 = 0; /* SPE kapalıyken yapılandır */
  spi->CFG1 = ((br & 7U) << SPI_CFG1_MBR_Pos) | (7U << SPI_CFG1_DSIZE_Pos); /* 8 bit veri */
  spi->CFG2 = SPI_CFG2_MASTER | SPI_CFG2_SSM | SPI_CFG2_AFCNTR | ((mode & 2U) ? SPI_CFG2_CPOL : 0U) | ((mode & 1U) ? SPI_CFG2_CPHA : 0U);
  spi->CR1 = SPI_CR1_SSI; /* SSM=1 iken master için SSI=1 */`
    : `  spi->CR1 = SPI_CR1_MSTR | SPI_CR1_SSM | SPI_CR1_SSI | ((br & 7U) << SPI_CR1_BR_Pos) | ((mode & 2U) ? SPI_CR1_CPOL : 0U) | ((mode & 1U) ? SPI_CR1_CPHA : 0U);
${ip === 'fifo' ? '  spi->CR2 = (7U << SPI_CR2_DS_Pos) | SPI_CR2_FRXTH; /* 8 bit veri, FIFO 8 bitte RXNE */\n' : ''}  spi->CR1 |= SPI_CR1_SPE;`;
  const transfer = ip === 'v2'
    ? `  /* H7/U5 SPI: aktarım boyu TSIZE ile verilir, CSTART başlatır, EOT bitişi bildirir */
  int r = 0;
  if (len == 0U) return 0;
  spi->CR2 = len & 0xFFFFU;
  spi->CR1 |= SPI_CR1_SPE;
  spi->CR1 |= SPI_CR1_CSTART;
  for (uint32_t i = 0; i < len && !r; i++) {
    uint32_t n = 0;
    while (!(spi->SR & SPI_SR_TXP)) if (++n > ES_TIMEOUT) { r = -1; break; }
    if (r) break;
    *(volatile uint8_t *)&spi->TXDR = tx ? tx[i] : 0xFFU;
    n = 0;
    while (!(spi->SR & SPI_SR_RXP)) if (++n > ES_TIMEOUT) { r = -1; break; }
    if (r) break;
    uint8_t b = *(volatile uint8_t *)&spi->RXDR;
    if (rx) rx[i] = b;
  }
  for (uint32_t n = 0; !r && !(spi->SR & SPI_SR_EOT); n++) if (n > ES_TIMEOUT) r = -1;
  spi->IFCR = SPI_IFCR_EOTC | SPI_IFCR_TXTFC;
  spi->CR1 &= ~SPI_CR1_SPE;
  return r;`
    : `  for (uint32_t i = 0; i < len; i++) {
    uint32_t n = 0;
    while (!(spi->SR & SPI_SR_TXE)) if (++n > ES_TIMEOUT) return -1;
    *(volatile uint8_t *)&spi->DR = tx ? tx[i] : 0xFFU; /* 8 bit erişim (FIFO'lu SPI'da 16 bit yazmak 2 byte gönderir) */
    n = 0;
    while (!(spi->SR & SPI_SR_RXNE)) if (++n > ES_TIMEOUT) return -1;
    uint8_t b = *(volatile uint8_t *)&spi->DR;
    if (rx) rx[i] = b;
  }
  for (uint32_t n = 0; (spi->SR & SPI_SR_BSY) && n < ES_TIMEOUT; n++) {
  }
  return 0;`;
  const c = `${core.banner(x, 'es_spi.c', 'SPI master', ['spi'], 'es_spi_clock_enable(SPI1);\nes_spi_init(SPI1, 3, 0); /* fSPI/16, mod 0 */\nes_gpio_write(GPIOA, 4, 0); /* CS */\nuint8_t id = es_spi_xfer(SPI1, 0x9F);\nes_gpio_write(GPIOA, 4, 1);')}#include "es_spi.h"

void es_spi_clock_enable(SPI_TypeDef *spi)
{
${core.clockSwitch(x, 'spi', 'spi')}
}

void es_spi_init(SPI_TypeDef *spi, uint32_t br, uint32_t mode)
{
${init}
}

int es_spi_transfer(SPI_TypeDef *spi, const uint8_t *tx, uint8_t *rx, uint32_t len)
{
${transfer}
}

uint8_t es_spi_xfer(SPI_TypeDef *spi, uint8_t b)
{
  uint8_t r = 0xFFU;
  (void)es_spi_transfer(spi, &b, &r, 1);
  return r;
}
`;
  return { 'es_spi.h': core.banner(x, 'es_spi.h', 'SPI master', ['spi']) + h, 'es_spi.c': c };
}

// ================================================================== I2C
function i2c(x) {
  const v1 = x.fam.ip.i2c === 'v1';
  const h = core.header(x, 'i2c', `void es_i2c_clock_enable(I2C_TypeDef *i2c);
/* Master, 7 bit adres. kernel_hz: I2C çekirdek saati${v1 ? ' (PCLK1)' : ` (${x.k === 'f0' || x.k === 'f3' ? 'bu ailede sıfırlamada HSI = 8 MHz' : 'varsayılan: PCLK1'})`}; speed_hz: 100000 ya da 400000.
 * Dönüş: 0 başarılı, -1 geçersiz saat. */
int es_i2c_init(I2C_TypeDef *i2c, uint32_t kernel_hz, uint32_t speed_hz);
/* Hepsi: 0 başarılı, -1 NACK / hata / zaman aşımı */
int es_i2c_probe(I2C_TypeDef *i2c, uint8_t addr7);
int es_i2c_write(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *data, uint32_t len);
int es_i2c_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t *data, uint32_t len);
/* Cihaz register'ı: önce reg adresi yazılır, okumada tekrarlı START */
int es_i2c_mem_write(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, const uint8_t *data, uint32_t len);
int es_i2c_mem_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, uint8_t *data, uint32_t len);
`);
  const body = v1 ? `int es_i2c_init(I2C_TypeDef *i2c, uint32_t kernel_hz, uint32_t speed_hz)
{
  uint32_t mhz = kernel_hz / 1000000U, ccr;
  if (mhz < 2U || mhz > 50U) return -1;
  i2c->CR1 = I2C_CR1_SWRST;
  i2c->CR1 = 0;
  i2c->CR2 = mhz;
  if (speed_hz > 100000U) {
    ccr = (kernel_hz + 3U * speed_hz - 1U) / (3U * speed_hz); /* hızlı mod, Tlow/Thigh = 2 */
    if (ccr < 1U) ccr = 1U;
    i2c->CCR = I2C_CCR_FS | ccr;
    i2c->TRISE = mhz * 300U / 1000U + 1U; /* 300 ns */
  } else {
    ccr = (kernel_hz + 2U * speed_hz - 1U) / (2U * speed_hz);
    if (ccr < 4U) ccr = 4U;
    i2c->CCR = ccr;
    i2c->TRISE = mhz + 1U; /* 1000 ns */
  }
  i2c->CR1 = I2C_CR1_PE;
  return 0;
}

static int wait_sr1(I2C_TypeDef *i2c, uint32_t flag)
{
  for (uint32_t n = 0; n < ES_TIMEOUT; n++) {
    uint32_t sr1 = i2c->SR1;
    if (sr1 & flag) return 0;
    if (sr1 & (I2C_SR1_AF | I2C_SR1_BERR | I2C_SR1_ARLO)) {
      i2c->SR1 &= ~(I2C_SR1_AF | I2C_SR1_BERR | I2C_SR1_ARLO);
      i2c->CR1 |= I2C_CR1_STOP;
      return -1;
    }
  }
  i2c->CR1 |= I2C_CR1_STOP;
  return -1;
}

static int idle(I2C_TypeDef *i2c)
{
  for (uint32_t n = 0; n < ES_TIMEOUT; n++) if (!(i2c->SR2 & I2C_SR2_BUSY) && !(i2c->CR1 & I2C_CR1_STOP)) return 0;
  return -1;
}

static int start(I2C_TypeDef *i2c, uint8_t addr8)
{
  i2c->CR1 |= I2C_CR1_START;
  if (wait_sr1(i2c, I2C_SR1_SB)) return -1;
  i2c->DR = addr8;
  return wait_sr1(i2c, I2C_SR1_ADDR);
}

static int send(I2C_TypeDef *i2c, const uint8_t *d, uint32_t n)
{
  for (uint32_t i = 0; i < n; i++) {
    if (wait_sr1(i2c, I2C_SR1_TXE)) return -1;
    i2c->DR = d[i];
  }
  return 0;
}

/* ADDR bayrağı henüz temizlenmemişken çağrılır (RM: N=1 ve N>=2 okuma sırası) */
static int recv(I2C_TypeDef *i2c, uint8_t *buf, uint32_t len)
{
  if (len == 1U) {
    i2c->CR1 &= ~I2C_CR1_ACK;
    __disable_irq();
    (void)i2c->SR2;
    i2c->CR1 |= I2C_CR1_STOP;
    __enable_irq();
    if (wait_sr1(i2c, I2C_SR1_RXNE)) return -1;
    buf[0] = (uint8_t)i2c->DR;
    return 0;
  }
  (void)i2c->SR2;
  for (uint32_t i = 0; i < len; i++) {
    if (wait_sr1(i2c, I2C_SR1_RXNE)) return -1;
    if (i == len - 2U) {
      __disable_irq(); /* sondan bir önceki byte: son byte NACK + STOP ile biter */
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

int es_i2c_probe(I2C_TypeDef *i2c, uint8_t addr7)
{
  if (idle(i2c)) return -1;
  int r = start(i2c, (uint8_t)(addr7 << 1));
  (void)i2c->SR2;
  i2c->CR1 |= I2C_CR1_STOP;
  return r;
}

static int write2(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *a, uint32_t an, const uint8_t *b, uint32_t bn)
{
  if (idle(i2c) || start(i2c, (uint8_t)(addr7 << 1))) return -1;
  (void)i2c->SR2; /* ADDR temizle */
  if (send(i2c, a, an) || send(i2c, b, bn) || wait_sr1(i2c, I2C_SR1_BTF)) return -1;
  i2c->CR1 |= I2C_CR1_STOP;
  return 0;
}

int es_i2c_write(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *data, uint32_t len) { return write2(i2c, addr7, data, len, 0, 0); }
int es_i2c_mem_write(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, const uint8_t *data, uint32_t len) { return write2(i2c, addr7, &reg, 1, data, len); }

int es_i2c_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t *data, uint32_t len)
{
  if (len == 0U) return 0;
  if (idle(i2c)) return -1;
  i2c->CR1 |= I2C_CR1_ACK;
  if (start(i2c, (uint8_t)((addr7 << 1) | 1U))) return -1;
  return recv(i2c, data, len);
}

int es_i2c_mem_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, uint8_t *data, uint32_t len)
{
  if (len == 0U) return 0;
  if (idle(i2c) || start(i2c, (uint8_t)(addr7 << 1))) return -1;
  (void)i2c->SR2;
  i2c->DR = reg;
  if (wait_sr1(i2c, I2C_SR1_BTF)) return -1;
  i2c->CR1 |= I2C_CR1_ACK;
  if (start(i2c, (uint8_t)((addr7 << 1) | 1U))) return -1; /* tekrarlı START */
  return recv(i2c, data, len);
}` : `/* TIMINGR: ST AN4235 yaklaşımı. Standart mod: tLOW 4.7 µs, tHIGH 4.0 µs; hızlı mod: 1.25 / 0.5 µs (+ senkron gecikmeleri). */
static uint32_t timing(uint32_t fk, uint32_t speed_hz)
{
  int fast = speed_hz > 100000U;
  uint32_t presc = (uint32_t)(((uint64_t)fk * (fast ? 125U : 250U) + 500000000ULL) / 1000000000ULL); /* round(fk * tick) */
  presc = presc ? presc - 1U : 0U;
  if (presc > 15U) presc = 15U;
  uint64_t tick_ps = ((uint64_t)(presc + 1U) * 1000000000000ULL) / fk;
#define ES_CYC(ns) ((uint32_t)((((uint64_t)(ns) * 1000U) + tick_ps - 1U) / tick_ps))
  uint32_t scll = ES_CYC(fast ? 1250U : 4700U) - 1U, sclh = ES_CYC(fast ? 500U : 4000U) - 1U;
  uint32_t sdadel = ES_CYC(fast ? 125U : 500U), scldel = ES_CYC(fast ? 500U : 1250U) - 1U;
#undef ES_CYC
  if (scll > 255U) scll = 255U;
  if (sclh > 255U) sclh = 255U;
  if (sdadel > 15U) sdadel = 15U;
  if (scldel > 15U) scldel = 15U;
  return (presc << 28) | (scldel << 20) | (sdadel << 16) | (sclh << 8) | scll;
}

int es_i2c_init(I2C_TypeDef *i2c, uint32_t kernel_hz, uint32_t speed_hz)
{
  if (kernel_hz < 2000000U) return -1;
  i2c->CR1 = 0;
  i2c->TIMINGR = timing(kernel_hz, speed_hz);
  i2c->CR1 = I2C_CR1_PE; /* analog filtre açık (ANFOFF = 0) */
  return 0;
}

static void recover(I2C_TypeDef *i2c)
{
  i2c->CR1 &= ~I2C_CR1_PE; /* durum makinesini sıfırla */
  for (uint32_t n = 0; (i2c->CR1 & I2C_CR1_PE) && n < ES_TIMEOUT; n++) {
  }
  i2c->CR1 |= I2C_CR1_PE;
}

static int wait_flag(I2C_TypeDef *i2c, uint32_t flag)
{
  for (uint32_t n = 0; n < ES_TIMEOUT; n++) {
    uint32_t isr = i2c->ISR;
    if (isr & flag) return 0;
    if (isr & (I2C_ISR_NACKF | I2C_ISR_BERR | I2C_ISR_ARLO)) {
      for (uint32_t m = 0; m < ES_TIMEOUT && !(i2c->ISR & I2C_ISR_STOPF); m++) {
      } /* NACK'te donanım STOP gönderir */
      i2c->ICR = I2C_ICR_NACKCF | I2C_ICR_STOPCF | I2C_ICR_BERRCF | I2C_ICR_ARLOCF;
      return -1;
    }
  }
  recover(i2c);
  return -1;
}

static int idle(I2C_TypeDef *i2c)
{
  for (uint32_t n = 0; n < ES_TIMEOUT; n++) if (!(i2c->ISR & I2C_ISR_BUSY)) return 0;
  recover(i2c);
  return -1;
}

/* NBYTES 255'i aşarsa RELOAD; son parçada autoend ? AUTOEND : TC'de dur */
static void cr2(I2C_TypeDef *i2c, uint8_t addr7, uint32_t remaining, uint32_t flags, int autoend)
{
  uint32_t n = remaining > 255U ? 255U : remaining;
  uint32_t mode = remaining > 255U ? I2C_CR2_RELOAD : (autoend ? I2C_CR2_AUTOEND : 0U);
  i2c->CR2 = ((uint32_t)addr7 << 1) | (n << I2C_CR2_NBYTES_Pos) | mode | flags;
}

static int send(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *a, uint32_t an, const uint8_t *b, uint32_t bn, int autoend)
{
  uint32_t total = an + bn, sent = 0;
  cr2(i2c, addr7, total, I2C_CR2_START, autoend);
  while (sent < total) {
    if (sent && (sent % 255U) == 0U) {
      if (wait_flag(i2c, I2C_ISR_TCR)) return -1;
      cr2(i2c, addr7, total - sent, 0U, autoend);
    }
    if (wait_flag(i2c, I2C_ISR_TXIS)) return -1;
    i2c->TXDR = sent < an ? a[sent] : b[sent - an];
    sent++;
  }
  return 0;
}

static int recv(I2C_TypeDef *i2c, uint8_t addr7, uint8_t *d, uint32_t n)
{
  uint32_t got = 0;
  cr2(i2c, addr7, n, I2C_CR2_START | I2C_CR2_RD_WRN, 1);
  while (got < n) {
    if (got && (got % 255U) == 0U) {
      if (wait_flag(i2c, I2C_ISR_TCR)) return -1;
      cr2(i2c, addr7, n - got, I2C_CR2_RD_WRN, 1);
    }
    if (wait_flag(i2c, I2C_ISR_RXNE)) return -1;
    d[got++] = (uint8_t)i2c->RXDR;
  }
  return 0;
}

static int stop(I2C_TypeDef *i2c)
{
  if (wait_flag(i2c, I2C_ISR_STOPF)) return -1;
  i2c->ICR = I2C_ICR_STOPCF;
  return 0;
}

int es_i2c_probe(I2C_TypeDef *i2c, uint8_t addr7)
{
  if (idle(i2c)) return -1;
  i2c->CR2 = ((uint32_t)addr7 << 1) | I2C_CR2_AUTOEND | I2C_CR2_START; /* 0 byte: sadece adres */
  return stop(i2c);
}

int es_i2c_write(I2C_TypeDef *i2c, uint8_t addr7, const uint8_t *data, uint32_t len)
{
  if (len == 0U) return es_i2c_probe(i2c, addr7);
  if (idle(i2c) || send(i2c, addr7, data, len, 0, 0, 1)) return -1;
  return stop(i2c);
}

int es_i2c_mem_write(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, const uint8_t *data, uint32_t len)
{
  if (idle(i2c) || send(i2c, addr7, &reg, 1, data, len, 1)) return -1;
  return stop(i2c);
}

int es_i2c_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t *data, uint32_t len)
{
  if (len == 0U) return 0;
  if (idle(i2c) || recv(i2c, addr7, data, len)) return -1;
  return stop(i2c);
}

int es_i2c_mem_read(I2C_TypeDef *i2c, uint8_t addr7, uint8_t reg, uint8_t *data, uint32_t len)
{
  if (len == 0U) return 0;
  if (idle(i2c) || send(i2c, addr7, &reg, 1, 0, 0, 0)) return -1;
  if (wait_flag(i2c, I2C_ISR_TC)) return -1;
  if (recv(i2c, addr7, data, len)) return -1; /* tekrarlı START */
  return stop(i2c);
}`;
  const c = `${core.banner(x, 'es_i2c.c', 'I2C master', ['i2c'], `es_i2c_clock_enable(I2C1);\n/* SCL/SDA: es_gpio_init(..., ES_GPIO_AF, ES_GPIO_PULLUP, ES_GPIO_OPENDRAIN, af) */\nes_i2c_init(I2C1, ${v1 || !(x.k === 'f0' || x.k === 'f3') ? 'es_rcc_pclk1_hz()' : '8000000U /* HSI */'}, 400000);\nuint8_t id;\nes_i2c_mem_read(I2C1, 0x76, 0xD0, &id, 1); /* BME280 chip id */`)}#include "es_i2c.h"

void es_i2c_clock_enable(I2C_TypeDef *i2c)
{
${core.clockSwitch(x, 'i2c', 'i2c')}
}

${body}
`;
  return { 'es_i2c.h': core.banner(x, 'es_i2c.h', 'I2C master', ['i2c']) + h, 'es_i2c.c': c };
}

// ================================================================== TIM
function tim(x) {
  const brk = ['TIM1', 'TIM8', 'TIM15', 'TIM16', 'TIM17', 'TIM20'].map((t) => `#if defined(${t})\n  r |= (t == ${t});\n#endif`).join('\n');
  const h = core.header(x, 'tim', `void es_tim_clock_enable(TIM_TypeDef *t);

/* ---- PWM ----  timclk_hz: timer saati (APB bölücü 1 değilse PCLK × 2). Sayaç 1 MHz, ARR = 1e6/freq - 1 */
void es_tim_pwm_init(TIM_TypeDef *t, uint32_t ch, uint32_t timclk_hz, uint32_t freq_hz);
void es_tim_pwm_duty(TIM_TypeDef *t, uint32_t ch, uint32_t permille); /* 0..1000 */

/* ---- input capture: iki yükselen kenar arası süre (tick_hz çözünürlükle) ---- */
void es_tim_ic_init(TIM_TypeDef *t, uint32_t ch, uint32_t timclk_hz, uint32_t tick_hz);
int es_tim_ic_period(TIM_TypeDef *t, uint32_t ch, uint32_t *ticks); /* 1: yeni ölçüm var, 0: yok */

/* ---- encoder (TI1 + TI2, x4) ---- CH1/CH2 pinlerini AF olarak ayarlayın */
void es_tim_encoder_init(TIM_TypeDef *t);
int32_t es_tim_encoder_count(TIM_TypeDef *t); /* 16 bit işaretli sayaç */
`);
  const c = `${core.banner(x, 'es_tim.c', 'timer: PWM, input capture, encoder', ['tim'], 'es_tim_clock_enable(TIM3);\nes_tim_pwm_init(TIM3, 1, 2U * es_rcc_pclk1_hz(), 1000); /* 1 kHz */\nes_tim_pwm_duty(TIM3, 1, 250);               /* %25 */')}#include "es_tim.h"

void es_tim_clock_enable(TIM_TypeDef *t)
{
${core.clockSwitch(x, 'pwm', 't')}
}

static volatile uint32_t *ccmr(TIM_TypeDef *t, uint32_t ch) { return ch <= 2U ? &t->CCMR1 : &t->CCMR2; }
static uint32_t ccmr_shift(uint32_t ch) { return (ch & 1U) ? 0U : 8U; }
static volatile uint32_t *ccr(TIM_TypeDef *t, uint32_t ch) { return &(&t->CCR1)[ch - 1U]; }

/* Break özellikli timer'larda (TIM1/8/15/16/17/20) çıkışlar BDTR.MOE ile açılır */
static int has_break(TIM_TypeDef *t)
{
  int r = 0;
${brk}
  (void)t;
  return r;
}

void es_tim_pwm_init(TIM_TypeDef *t, uint32_t ch, uint32_t timclk_hz, uint32_t freq_hz)
{
  uint32_t s = ccmr_shift(ch);
  t->CR1 = 0;
  t->PSC = timclk_hz / 1000000U - 1U;
  t->ARR = 1000000U / freq_hz - 1U;
  *ccmr(t, ch) = (*ccmr(t, ch) & ~(0xFFUL << s)) | ((6UL << 4) | (1UL << 3)) << s; /* OCxM = PWM mod 1, OCxPE önyükleme */
  *ccr(t, ch) = 0;
  t->CCER |= 1UL << ((ch - 1U) * 4U);
#if defined(TIM_BDTR_MOE)
  if (has_break(t)) t->BDTR |= TIM_BDTR_MOE;
#endif
  t->CR1 = TIM_CR1_ARPE;
  t->EGR = TIM_EGR_UG;
  t->CR1 |= TIM_CR1_CEN;
}

void es_tim_pwm_duty(TIM_TypeDef *t, uint32_t ch, uint32_t permille)
{
  if (permille > 1000U) permille = 1000U;
  *ccr(t, ch) = (uint32_t)(((uint64_t)(t->ARR + 1U) * permille) / 1000U);
}

static uint32_t ic_last[4];

void es_tim_ic_init(TIM_TypeDef *t, uint32_t ch, uint32_t timclk_hz, uint32_t tick_hz)
{
  uint32_t s = ccmr_shift(ch);
  t->CR1 = 0;
  t->PSC = timclk_hz / tick_hz - 1U;
  t->ARR = 0xFFFFU;
  *ccmr(t, ch) = (*ccmr(t, ch) & ~(0xFFUL << s)) | ((1UL << 0) | (3UL << 4)) << s; /* CCxS = TIx, ICxF = 8 örnek filtre */
  t->CCER = (t->CCER & ~(0xFUL << ((ch - 1U) * 4U))) | (1UL << ((ch - 1U) * 4U)); /* yükselen kenar */
  t->EGR = TIM_EGR_UG;
  t->CR1 = TIM_CR1_CEN;
}

int es_tim_ic_period(TIM_TypeDef *t, uint32_t ch, uint32_t *ticks)
{
  uint32_t flag = TIM_SR_CC1IF << (ch - 1U);
  if (!(t->SR & flag)) return 0;
  uint32_t v = *ccr(t, ch); /* CCR okumak bayrağı temizler */
  *ticks = (v - ic_last[ch - 1U]) & 0xFFFFU;
  ic_last[ch - 1U] = v;
  return 1;
}

void es_tim_encoder_init(TIM_TypeDef *t)
{
  t->CR1 = 0;
  t->SMCR = (t->SMCR & ~TIM_SMCR_SMS) | TIM_SMCR_SMS_0 | TIM_SMCR_SMS_1; /* encoder mod 3: iki kenarda say */
  t->CCMR1 = (1UL << 0) | (3UL << 4) | (1UL << 8) | (3UL << 12);       /* CC1S = TI1, CC2S = TI2, filtre */
  t->CCER &= ~(TIM_CCER_CC1P | TIM_CCER_CC2P);
  t->ARR = 0xFFFFU;
  t->CNT = 0;
  t->CR1 = TIM_CR1_CEN;
}

int32_t es_tim_encoder_count(TIM_TypeDef *t)
{
  return (int32_t)(int16_t)(t->CNT & 0xFFFFU);
}
`;
  return { 'es_tim.h': core.banner(x, 'es_tim.h', 'timer: PWM, input capture, encoder', ['tim']) + h, 'es_tim.c': c };
}

module.exports = { uart, spi, i2c, tim };
