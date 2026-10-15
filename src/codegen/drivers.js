// @ts-check
/**
 * Komponent sürücü şablonları. Sürücüler sadece bsp.h API'sini kullanır; bu sayede
 * aynı sürücü hem HAL hem register (bare-metal) altyapısında çalışır.
 *
 * Her sürücü:
 *  - files:   projeye kopyalanan genel C sürücü dosyaları (komponent kullanılmazsa silinir)
 *  - include: app.c'ye eklenecek başlık
 *  - globals: örnek (instance) başına global değişkenler
 *  - init:    App_Init() içine eklenecek kod
 *  - poll:    periyodik okuma + telemetri. ${c.user} kullanıcı kod bloğudur; okunan
 *             değişkenler bu blokta kapsam içindedir.
 *  - uartRx:  UART alma kesmesi gerekiyorsa true
 *
 * ctx (c): L (C tanımlayıcı), v (değişken adı), i2c/spi/uart ('BSP_I2C1'), addr, addrHex,
 *          pin(compPin) -> { port, pin }, adc (kanal no), pwm { timer, ch }, periodMs, user
 */

const BME280_H = `#ifndef BME280_H
#define BME280_H
#include <stdint.h>

typedef struct {
  uint8_t bus, addr;
  uint16_t T1; int16_t T2, T3;
  uint16_t P1; int16_t P2, P3, P4, P5, P6, P7, P8, P9;
  uint8_t H1, H3; int16_t H2, H4, H5; int8_t H6;
  int32_t t_fine;
} bme280_t;

int bme280_init(bme280_t *dev, uint8_t bus, uint8_t addr7);
int bme280_read(bme280_t *dev, float *temp_c, float *press_hpa, float *hum_pct);

#endif
`;

const BME280_C = `/* BME280 sürücüsü - Bosch datasheet (BST-BME280-DS002) tamsayı kompanzasyonu */
#include "bme280.h"
#include "bsp.h"

#define REG_ID        0xD0
#define REG_CALIB00   0x88
#define REG_CALIB26   0xE1
#define REG_CTRL_HUM  0xF2
#define REG_CTRL_MEAS 0xF4
#define REG_CONFIG    0xF5
#define REG_DATA      0xF7

static int wr(bme280_t *d, uint8_t reg, uint8_t val)
{
  return bsp_i2c_write(d->bus, d->addr, reg, &val, 1);
}

int bme280_init(bme280_t *d, uint8_t bus, uint8_t addr7)
{
  uint8_t id = 0, c[26], h[7];
  d->bus = bus;
  d->addr = addr7;
  if (bsp_i2c_read(bus, addr7, REG_ID, &id, 1) != 0 || id != 0x60) return -1;
  if (bsp_i2c_read(bus, addr7, REG_CALIB00, c, 26) != 0 || bsp_i2c_read(bus, addr7, REG_CALIB26, h, 7) != 0) return -1;
  d->T1 = (uint16_t)(c[1] << 8 | c[0]); d->T2 = (int16_t)(c[3] << 8 | c[2]); d->T3 = (int16_t)(c[5] << 8 | c[4]);
  d->P1 = (uint16_t)(c[7] << 8 | c[6]); d->P2 = (int16_t)(c[9] << 8 | c[8]); d->P3 = (int16_t)(c[11] << 8 | c[10]);
  d->P4 = (int16_t)(c[13] << 8 | c[12]); d->P5 = (int16_t)(c[15] << 8 | c[14]); d->P6 = (int16_t)(c[17] << 8 | c[16]);
  d->P7 = (int16_t)(c[19] << 8 | c[18]); d->P8 = (int16_t)(c[21] << 8 | c[20]); d->P9 = (int16_t)(c[23] << 8 | c[22]);
  d->H1 = c[25];
  d->H2 = (int16_t)(h[1] << 8 | h[0]); d->H3 = h[2];
  d->H4 = (int16_t)(((int8_t)h[3] * 16) | (h[4] & 0x0F));
  d->H5 = (int16_t)(((int8_t)h[5] * 16) | (h[4] >> 4));
  d->H6 = (int8_t)h[6];
  if (wr(d, REG_CTRL_HUM, 0x01) != 0) return -1;   /* nem x1 */
  if (wr(d, REG_CONFIG, 0xA0) != 0) return -1;     /* standby 1000 ms */
  return wr(d, REG_CTRL_MEAS, 0x27);               /* T x1, P x1, normal mod */
}

int bme280_read(bme280_t *d, float *temp_c, float *press_hpa, float *hum_pct)
{
  uint8_t b[8];
  if (bsp_i2c_read(d->bus, d->addr, REG_DATA, b, 8) != 0) return -1;
  int32_t adc_P = (int32_t)((uint32_t)b[0] << 12 | (uint32_t)b[1] << 4 | b[2] >> 4);
  int32_t adc_T = (int32_t)((uint32_t)b[3] << 12 | (uint32_t)b[4] << 4 | b[5] >> 4);
  int32_t adc_H = (int32_t)((uint32_t)b[6] << 8 | b[7]);

  int32_t v1 = ((((adc_T >> 3) - ((int32_t)d->T1 << 1))) * (int32_t)d->T2) >> 11;
  int32_t v2 = (((((adc_T >> 4) - (int32_t)d->T1) * ((adc_T >> 4) - (int32_t)d->T1)) >> 12) * (int32_t)d->T3) >> 14;
  d->t_fine = v1 + v2;
  *temp_c = (float)((d->t_fine * 5 + 128) >> 8) / 100.0f;

  int64_t p1 = (int64_t)d->t_fine - 128000;
  int64_t p2 = p1 * p1 * (int64_t)d->P6;
  p2 += (p1 * (int64_t)d->P5) << 17;
  p2 += ((int64_t)d->P4) << 35;
  p1 = ((p1 * p1 * (int64_t)d->P3) >> 8) + ((p1 * (int64_t)d->P2) << 12);
  p1 = ((((int64_t)1) << 47) + p1) * ((int64_t)d->P1) >> 33;
  if (p1 != 0) {
    int64_t p = 1048576 - adc_P;
    p = (((p << 31) - p2) * 3125) / p1;
    p1 = (((int64_t)d->P9) * (p >> 13) * (p >> 13)) >> 25;
    p2 = (((int64_t)d->P8) * p) >> 19;
    p = ((p + p1 + p2) >> 8) + (((int64_t)d->P7) << 4);
    *press_hpa = (float)p / 256.0f / 100.0f;
  }

  int32_t x = d->t_fine - 76800;
  x = (((((adc_H << 14) - (((int32_t)d->H4) << 20) - (((int32_t)d->H5) * x)) + 16384) >> 15) *
       (((((((x * ((int32_t)d->H6)) >> 10) * (((x * ((int32_t)d->H3)) >> 11) + 32768)) >> 10) + 2097152) *
         ((int32_t)d->H2) + 8192) >> 14));
  x = x - (((((x >> 15) * (x >> 15)) >> 7) * ((int32_t)d->H1)) >> 4);
  x = x < 0 ? 0 : x;
  x = x > 419430400 ? 419430400 : x;
  *hum_pct = (float)(x >> 12) / 1024.0f;
  return 0;
}
`;

const MPU6050_H = `#ifndef MPU6050_H
#define MPU6050_H
#include <stdint.h>

typedef struct { uint8_t bus, addr; } mpu6050_t;
typedef struct { float ax, ay, az; /* g */ float gx, gy, gz; /* derece/s */ float temp_c; } mpu6050_data_t;

int mpu6050_init(mpu6050_t *dev, uint8_t bus, uint8_t addr7);
int mpu6050_read(mpu6050_t *dev, mpu6050_data_t *out);

#endif
`;

const MPU6050_C = `#include "mpu6050.h"
#include "bsp.h"

#define REG_GYRO_CONFIG  0x1B
#define REG_ACCEL_CONFIG 0x1C
#define REG_ACCEL_XOUT_H 0x3B
#define REG_PWR_MGMT_1   0x6B
#define REG_WHO_AM_I     0x75

int mpu6050_init(mpu6050_t *d, uint8_t bus, uint8_t addr7)
{
  uint8_t who = 0, v;
  d->bus = bus;
  d->addr = addr7;
  /* Orijinal çip 0x68 döner; bazı klonlar 0x70/0x72/0x98 döner ve yine de çalışır. */
  if (bsp_i2c_read(bus, addr7, REG_WHO_AM_I, &who, 1) != 0) return -1;
  v = 0x01; /* uykudan çık, saat kaynağı: X jiroskop PLL */
  if (bsp_i2c_write(bus, addr7, REG_PWR_MGMT_1, &v, 1) != 0) return -1;
  v = 0x00; /* +-250 derece/s */
  if (bsp_i2c_write(bus, addr7, REG_GYRO_CONFIG, &v, 1) != 0) return -1;
  v = 0x00; /* +-2 g */
  return bsp_i2c_write(bus, addr7, REG_ACCEL_CONFIG, &v, 1);
}

int mpu6050_read(mpu6050_t *d, mpu6050_data_t *o)
{
  uint8_t b[14];
  if (bsp_i2c_read(d->bus, d->addr, REG_ACCEL_XOUT_H, b, 14) != 0) return -1;
  o->ax = (int16_t)(b[0] << 8 | b[1]) / 16384.0f;
  o->ay = (int16_t)(b[2] << 8 | b[3]) / 16384.0f;
  o->az = (int16_t)(b[4] << 8 | b[5]) / 16384.0f;
  o->temp_c = (int16_t)(b[6] << 8 | b[7]) / 340.0f + 36.53f;
  o->gx = (int16_t)(b[8] << 8 | b[9]) / 131.0f;
  o->gy = (int16_t)(b[10] << 8 | b[11]) / 131.0f;
  o->gz = (int16_t)(b[12] << 8 | b[13]) / 131.0f;
  return 0;
}
`;

const SSD1306_H = `#ifndef SSD1306_H
#define SSD1306_H
#include <stdint.h>

typedef struct { uint8_t bus, addr; } ssd1306_t;

int ssd1306_init(ssd1306_t *dev, uint8_t bus, uint8_t addr7);
int ssd1306_fill(ssd1306_t *dev, uint8_t pattern);

#endif
`;

const SSD1306_C = `#include "ssd1306.h"
#include "bsp.h"

static int cmd(ssd1306_t *d, uint8_t c)
{
  return bsp_i2c_write(d->bus, d->addr, 0x00, &c, 1);
}

int ssd1306_init(ssd1306_t *d, uint8_t bus, uint8_t addr7)
{
  static const uint8_t seq[] = {
    0xAE, 0xD5, 0x80, 0xA8, 0x3F, 0xD3, 0x00, 0x40, 0x8D, 0x14, 0x20, 0x00,
    0xA1, 0xC8, 0xDA, 0x12, 0x81, 0xCF, 0xD9, 0xF1, 0xDB, 0x40, 0xA4, 0xA6, 0xAF
  };
  d->bus = bus;
  d->addr = addr7;
  if (bsp_i2c_probe(bus, addr7) != 0) return -1;
  for (unsigned i = 0; i < sizeof seq; i++) {
    if (cmd(d, seq[i]) != 0) return -1;
  }
  return ssd1306_fill(d, 0x00);
}

int ssd1306_fill(ssd1306_t *d, uint8_t pattern)
{
  uint8_t row[16];
  for (unsigned i = 0; i < sizeof row; i++) row[i] = pattern;
  cmd(d, 0x21); cmd(d, 0); cmd(d, 127); /* sütun aralığı */
  cmd(d, 0x22); cmd(d, 0); cmd(d, 7);   /* sayfa aralığı */
  for (unsigned i = 0; i < 1024 / sizeof row; i++) {
    if (bsp_i2c_write(d->bus, d->addr, 0x40, row, sizeof row) != 0) return -1;
  }
  return 0;
}
`;

const W25Q_H = `#ifndef W25Q_H
#define W25Q_H
#include <stdint.h>
#include "board.h"

typedef struct { uint8_t bus; GPIO_TypeDef *cs_port; uint16_t cs_pin; } w25q_t;

int w25q_init(w25q_t *dev, uint8_t bus, GPIO_TypeDef *cs_port, uint16_t cs_pin);
uint32_t w25q_read_jedec_id(w25q_t *dev);

#endif
`;

const W25Q_C = `#include "w25q.h"
#include "bsp.h"

uint32_t w25q_read_jedec_id(w25q_t *d)
{
  uint8_t tx[4] = { 0x9F, 0, 0, 0 }, rx[4] = { 0 };
  bsp_gpio_write(d->cs_port, d->cs_pin, 0);
  bsp_spi_transfer(d->bus, tx, rx, 4);
  bsp_gpio_write(d->cs_port, d->cs_pin, 1);
  return (uint32_t)rx[1] << 16 | (uint32_t)rx[2] << 8 | rx[3];
}

int w25q_init(w25q_t *d, uint8_t bus, GPIO_TypeDef *cs_port, uint16_t cs_pin)
{
  d->bus = bus; d->cs_port = cs_port; d->cs_pin = cs_pin;
  return (w25q_read_jedec_id(d) >> 16) == 0xEF ? 0 : -1; /* 0xEF = Winbond */
}
`;

const NMEA_H = `#ifndef NMEA_H
#define NMEA_H
#include <stdint.h>

/* Konum 1e-7 derece biriminde tamsayı (u-blox ile aynı); float hassasiyet kaybı yok. */
typedef struct {
  int32_t lat_e7, lon_e7;
  int32_t alt_cm;
  uint8_t sats, fix;
  uint32_t sentences, errors;
} nmea_fix_t;

typedef struct {
  char line[100];
  uint8_t len;
  nmea_fix_t fix;
} nmea_t;

void nmea_init(nmea_t *n);
/* Bir karakter işler; geçerli bir GGA cümlesi tamamlanınca 1 döner. */
int nmea_feed(nmea_t *n, char c);

#endif
`;

const NMEA_C = `/* Minimal NMEA 0183 ayrıştırıcı: sadece GGA (konum, uydu, irtifa). Kayan nokta kullanmaz. */
#include "nmea.h"
#include <string.h>

void nmea_init(nmea_t *n)
{
  memset(n, 0, sizeof *n);
}

static int hexval(char c)
{
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/* "ddmm.mmmmm" -> 1e-7 derece */
static int32_t parse_coord(const char *s, int deg_digits, char hemi)
{
  int32_t deg = 0, min_int = 0, frac = 0, scale = 1;
  int i = 0;
  if (!*s) return 0;
  for (; i < deg_digits && s[i]; i++) deg = deg * 10 + (s[i] - '0');
  for (; s[i] && s[i] != '.'; i++) min_int = min_int * 10 + (s[i] - '0');
  if (s[i] == '.') {
    for (i++; s[i] && scale < 100000; i++) { frac = frac * 10 + (s[i] - '0'); scale *= 10; }
  }
  /* dakika * 1e5 */
  int64_t min_e5 = (int64_t)min_int * 100000 + (int64_t)frac * (100000 / scale);
  int64_t v = (int64_t)deg * 10000000 + min_e5 * 100 / 60;
  return (int32_t)((hemi == 'S' || hemi == 'W') ? -v : v);
}

static int32_t parse_cm(const char *s)
{
  int32_t sign = 1, ip = 0, frac = 0, digits = 0;
  if (*s == '-') { sign = -1; s++; }
  for (; *s && *s != '.'; s++) ip = ip * 10 + (*s - '0');
  if (*s == '.') {
    for (s++; *s && digits < 2; s++, digits++) frac = frac * 10 + (*s - '0');
  }
  while (digits++ < 2) frac *= 10;
  return sign * (ip * 100 + frac);
}

static int parse_sentence(nmea_t *n)
{
  char *f[16];
  int nf = 0;
  char *star = strchr(n->line, '*');
  if (!star || star[1] == 0 || star[2] == 0) return 0;
  uint8_t sum = 0;
  for (char *p = n->line + 1; p < star; p++) sum ^= (uint8_t)*p;
  if (((hexval(star[1]) << 4) | hexval(star[2])) != sum) { n->fix.errors++; return 0; }
  *star = 0;
  for (char *p = n->line + 1; nf < 16; ) {
    f[nf++] = p;
    p = strchr(p, ',');
    if (!p) break;
    *p++ = 0;
  }
  if (nf < 10 || strlen(f[0]) != 5 || strcmp(f[0] + 2, "GGA") != 0) return 0;
  n->fix.fix = (uint8_t)(f[6][0] ? f[6][0] - '0' : 0);
  n->fix.sats = (uint8_t)((f[7][0] ? (f[7][0] - '0') : 0) * (f[7][1] ? 10 : 1) + (f[7][1] ? f[7][1] - '0' : 0));
  if (n->fix.fix > 0) {
    n->fix.lat_e7 = parse_coord(f[2], 2, f[3][0]);
    n->fix.lon_e7 = parse_coord(f[4], 3, f[5][0]);
    n->fix.alt_cm = parse_cm(f[9]);
  }
  n->fix.sentences++;
  return 1;
}

int nmea_feed(nmea_t *n, char c)
{
  if (c == '$') { n->len = 0; }
  if (c == '\\r' || c == '\\n') {
    if (n->len == 0) return 0;
    n->line[n->len] = 0;
    n->len = 0;
    return n->line[0] == '$' ? parse_sentence(n) : 0;
  }
  if (n->len < sizeof n->line - 1) n->line[n->len++] = c;
  else n->len = 0; /* taşma: cümleyi at */
  return 0;
}
`;

/** @type {Record<string, any>} */
const DRIVERS = {
  bme280: {
    files: { 'Drivers/Components/bme280.h': BME280_H, 'Drivers/Components/bme280.c': BME280_C },
    include: 'bme280.h',
    globals: (c) => `static bme280_t ${c.v};\nstatic uint8_t ${c.v}_ok;`,
    init: (c) => `${c.v}_ok = bme280_init(&${c.v}, ${c.i2c}, ${c.addr}) == 0;
Telemetry_Status("${c.L}", ${c.v}_ok ? "OK" : "BULUNAMADI (adres ${c.addrHex}, chip id 0x60 bekleniyor)");`,
    poll: (c) => `float temp_c = 0, press_hpa = 0, hum_pct = 0;
if (!${c.v}_ok || bme280_read(&${c.v}, &temp_c, &press_hpa, &hum_pct) != 0) return;
Telemetry_Value("${c.L}.temp", temp_c);
Telemetry_Value("${c.L}.hum", hum_pct);
Telemetry_Value("${c.L}.press", press_hpa);
${c.user}`
  },
  mpu6050: {
    files: { 'Drivers/Components/mpu6050.h': MPU6050_H, 'Drivers/Components/mpu6050.c': MPU6050_C },
    include: 'mpu6050.h',
    globals: (c) => `static mpu6050_t ${c.v};\nstatic uint8_t ${c.v}_ok;`,
    init: (c) => `${c.v}_ok = mpu6050_init(&${c.v}, ${c.i2c}, ${c.addr}) == 0;
Telemetry_Status("${c.L}", ${c.v}_ok ? "OK" : "BULUNAMADI (adres ${c.addrHex})");`,
    poll: (c) => `mpu6050_data_t imu;
if (!${c.v}_ok || mpu6050_read(&${c.v}, &imu) != 0) return;
Telemetry_Value("${c.L}.ax", imu.ax);
Telemetry_Value("${c.L}.ay", imu.ay);
Telemetry_Value("${c.L}.az", imu.az);
Telemetry_Value("${c.L}.gx", imu.gx);
Telemetry_Value("${c.L}.gy", imu.gy);
Telemetry_Value("${c.L}.gz", imu.gz);
${c.user}`
  },
  ssd1306: {
    files: { 'Drivers/Components/ssd1306.h': SSD1306_H, 'Drivers/Components/ssd1306.c': SSD1306_C },
    include: 'ssd1306.h',
    globals: (c) => `static ssd1306_t ${c.v};`,
    init: (c) => `Telemetry_Status("${c.L}", ssd1306_init(&${c.v}, ${c.i2c}, ${c.addr}) == 0 ? "OK" : "BULUNAMADI (adres ${c.addrHex})");`,
    poll: null
  },
  w25q32: {
    files: { 'Drivers/Components/w25q.h': W25Q_H, 'Drivers/Components/w25q.c': W25Q_C },
    include: 'w25q.h',
    globals: (c) => `static w25q_t ${c.v};`,
    init: (c) => `Telemetry_Status("${c.L}", w25q_init(&${c.v}, ${c.spi}, ${c.pin('CS').port}, ${c.pin('CS').pin}) == 0 ? "OK" : "JEDEC ID okunamadı");`,
    poll: null
  },
  neo6m: {
    files: { 'Drivers/Components/nmea.h': NMEA_H, 'Drivers/Components/nmea.c': NMEA_C },
    include: 'nmea.h',
    uartRx: true,
    // Kesme -> halka tampon -> task içinde NMEA ayrıştırma (kesmede iş yapılmaz).
    globals: (c) => `static nmea_t ${c.v};
static volatile uint8_t ${c.v}_rb[256];
static volatile uint8_t ${c.v}_head, ${c.v}_tail;`,
    rx: (c) => `if (bus == ${c.uart}) {
  ${c.v}_rb[${c.v}_head] = byte;
  ${c.v}_head = (uint8_t)(${c.v}_head + 1); /* 256'lık tampon: uint8_t taşması = modulo */
}`,
    init: (c) => `nmea_init(&${c.v});
bsp_uart_start_rx(${c.uart});`,
    poll: (c) => `int updated = 0;
while (${c.v}_tail != ${c.v}_head) {
  updated |= nmea_feed(&${c.v}, (char)${c.v}_rb[${c.v}_tail]);
  ${c.v}_tail = (uint8_t)(${c.v}_tail + 1);
}
if (!updated) return;
const nmea_fix_t *fix = &${c.v}.fix;
Telemetry_Fixed("${c.L}.lat", fix->lat_e7, 7);
Telemetry_Fixed("${c.L}.lon", fix->lon_e7, 7);
Telemetry_Fixed("${c.L}.alt", fix->alt_cm, 2);
Telemetry_Fixed("${c.L}.sats", fix->sats, 0);
${c.user}`
  },
  usb_uart: { files: {}, include: null, globals: null, init: null, poll: null },
  led: {
    files: {},
    include: null,
    globals: null,
    init: null,
    poll: (c) => `bsp_gpio_toggle(${c.pin('A').port}, ${c.pin('A').pin});
int led_on = bsp_gpio_read(${c.pin('A').port}, ${c.pin('A').pin});
Telemetry_Value("${c.L}.state", led_on ? 1.0f : 0.0f);
${c.user}`
  },
  button: {
    files: {},
    include: null,
    globals: null,
    init: null,
    poll: (c) => `int pressed = bsp_gpio_read(${c.pin('1').port}, ${c.pin('1').pin}) == 0; /* pull-up: basılı = 0 */
Telemetry_Value("${c.L}.pressed", pressed ? 1.0f : 0.0f);
${c.user}`
  },
  potentiometer: {
    files: {},
    include: null,
    globals: null,
    init: null,
    poll: (c) => `uint16_t raw = bsp_adc_read(${c.adc});
Telemetry_Value("${c.L}.raw", (float)raw);
${c.user}`
  },
  servo_sg90: {
    files: {},
    include: null,
    globals: (c) => `static int ${c.v}_angle = 0, ${c.v}_dir = 1;`,
    init: null,
    poll: (c) => `/* Demo: 0-180 derece tarama. Darbe 500-2500 us (timer 1 MHz sayar). */
${c.v}_angle += ${c.v}_dir;
if (${c.v}_angle >= 180 || ${c.v}_angle <= 0) ${c.v}_dir = -${c.v}_dir;
bsp_pwm_set(${c.pwm.timer}, ${c.pwm.ch}, (uint32_t)(500 + ${c.v}_angle * 2000 / 180));
Telemetry_Value("${c.L}.angle", (float)${c.v}_angle);
${c.user}`
  }
};

module.exports = { DRIVERS };
