// @ts-check
/**
 * Çevre birimi register tanımları.
 *  - Yerleşik: STM32F411 için en sık bakılan register'lar ve bit alanları (RM0383).
 *  - SVD: tam tanım için CMSIS-SVD dosyası ayrıştırılır (parseSvd).
 *
 * Biçim: [{ name, base, group, registers: [{ name, offset, desc, fields: [{ name, lsb, width, desc }] }] }]
 */

const f = (name, lsb, width = 1, desc = '') => ({ name, lsb, width, desc });
const range = (prefix, count, width, desc = '') => Array.from({ length: count }, (_, i) => f(`${prefix}${i}`, i * width, width, desc));

const GPIO_REGS = () => [
  { name: 'MODER', offset: 0x00, desc: 'Mod: 00 giriş, 01 çıkış, 10 alternatif, 11 analog', fields: range('MODER', 16, 2) },
  { name: 'OTYPER', offset: 0x04, desc: 'Çıkış tipi: 0 push-pull, 1 open-drain', fields: range('OT', 16, 1) },
  { name: 'OSPEEDR', offset: 0x08, desc: 'Çıkış hızı', fields: range('OSPEEDR', 16, 2) },
  { name: 'PUPDR', offset: 0x0C, desc: 'Pull: 00 yok, 01 up, 10 down', fields: range('PUPDR', 16, 2) },
  { name: 'IDR', offset: 0x10, desc: 'Giriş verisi (pin seviyeleri)', fields: range('IDR', 16, 1) },
  { name: 'ODR', offset: 0x14, desc: 'Çıkış verisi', fields: range('ODR', 16, 1) },
  { name: 'AFRL', offset: 0x20, desc: 'Alternatif fonksiyon, pin 0-7', fields: range('AFSEL', 8, 4) },
  { name: 'AFRH', offset: 0x24, desc: 'Alternatif fonksiyon, pin 8-15', fields: range('AFSEL', 8, 4).map((x, i) => ({ ...x, name: `AFSEL${i + 8}` })) }
];

const I2C_REGS = () => [
  { name: 'CR1', offset: 0x00, desc: 'Kontrol 1', fields: [f('PE', 0, 1, 'Çevre birimi açık'), f('START', 8), f('STOP', 9), f('ACK', 10), f('POS', 11), f('SWRST', 15)] },
  { name: 'CR2', offset: 0x04, desc: 'Kontrol 2', fields: [f('FREQ', 0, 6, 'PCLK1 MHz'), f('ITERREN', 8), f('ITEVTEN', 9), f('ITBUFEN', 10), f('DMAEN', 11)] },
  { name: 'OAR1', offset: 0x08, fields: [f('ADD', 0, 10)] },
  { name: 'DR', offset: 0x10, fields: [f('DR', 0, 8)] },
  { name: 'SR1', offset: 0x14, desc: 'Durum 1', fields: [f('SB', 0, 1, 'START üretildi'), f('ADDR', 1, 1, 'Adres gönderildi/eşleşti'), f('BTF', 2), f('STOPF', 4), f('RXNE', 6), f('TXE', 7), f('BERR', 8, 1, 'Bus hatası'), f('ARLO', 9, 1, 'Arbitrasyon kaybı'), f('AF', 10, 1, 'ACK gelmedi (NACK)'), f('OVR', 11), f('TIMEOUT', 14)] },
  { name: 'SR2', offset: 0x18, desc: 'Durum 2', fields: [f('MSL', 0, 1, 'Master modu'), f('BUSY', 1, 1, 'Bus meşgul'), f('TRA', 2, 1, 'Gönderici')] },
  { name: 'CCR', offset: 0x1C, desc: 'Saat kontrol', fields: [f('CCR', 0, 12), f('DUTY', 14), f('F_S', 15, 1, 'Fast mode')] },
  { name: 'TRISE', offset: 0x20, fields: [f('TRISE', 0, 6)] }
];

const SPI_REGS = () => [
  { name: 'CR1', offset: 0x00, fields: [f('CPHA', 0), f('CPOL', 1), f('MSTR', 2), f('BR', 3, 3, 'Baud bölücü 2^(BR+1)'), f('SPE', 6), f('LSBFIRST', 7), f('SSI', 8), f('SSM', 9), f('DFF', 11)] },
  { name: 'CR2', offset: 0x04, fields: [f('RXDMAEN', 0), f('TXDMAEN', 1), f('SSOE', 2), f('RXNEIE', 6), f('TXEIE', 7)] },
  { name: 'SR', offset: 0x08, fields: [f('RXNE', 0), f('TXE', 1), f('MODF', 5), f('OVR', 6), f('BSY', 7)] },
  { name: 'DR', offset: 0x0C, fields: [f('DR', 0, 16)] }
];

const USART_REGS = () => [
  { name: 'SR', offset: 0x00, fields: [f('PE', 0), f('FE', 1, 1, 'Çerçeve hatası'), f('NF', 2), f('ORE', 3, 1, 'Taşma'), f('IDLE', 4), f('RXNE', 5), f('TC', 6), f('TXE', 7)] },
  { name: 'DR', offset: 0x04, fields: [f('DR', 0, 9)] },
  { name: 'BRR', offset: 0x08, desc: 'Baud = PCLK / BRR', fields: [f('DIV_Fraction', 0, 4), f('DIV_Mantissa', 4, 12)] },
  { name: 'CR1', offset: 0x0C, fields: [f('RE', 2), f('TE', 3), f('IDLEIE', 4), f('RXNEIE', 5), f('TCIE', 6), f('TXEIE', 7), f('PCE', 10), f('M', 12), f('UE', 13), f('OVER8', 15)] },
  { name: 'CR2', offset: 0x10, fields: [f('STOP', 12, 2)] },
  { name: 'CR3', offset: 0x14, fields: [f('DMAR', 6), f('DMAT', 7), f('RTSE', 8), f('CTSE', 9)] }
];

const TIM_REGS = () => [
  { name: 'CR1', offset: 0x00, fields: [f('CEN', 0, 1, 'Sayaç açık'), f('UDIS', 1), f('URS', 2), f('OPM', 3), f('DIR', 4), f('ARPE', 7)] },
  { name: 'DIER', offset: 0x0C, fields: [f('UIE', 0), f('CC1IE', 1), f('CC2IE', 2), f('CC3IE', 3), f('CC4IE', 4)] },
  { name: 'SR', offset: 0x10, fields: [f('UIF', 0), f('CC1IF', 1), f('CC2IF', 2), f('CC3IF', 3), f('CC4IF', 4)] },
  { name: 'CCMR1', offset: 0x18, fields: [f('CC1S', 0, 2), f('OC1PE', 3), f('OC1M', 4, 3, '110 = PWM1'), f('CC2S', 8, 2), f('OC2PE', 11), f('OC2M', 12, 3)] },
  { name: 'CCMR2', offset: 0x1C, fields: [f('CC3S', 0, 2), f('OC3PE', 3), f('OC3M', 4, 3), f('CC4S', 8, 2), f('OC4PE', 11), f('OC4M', 12, 3)] },
  { name: 'CCER', offset: 0x20, fields: [f('CC1E', 0), f('CC1P', 1), f('CC2E', 4), f('CC2P', 5), f('CC3E', 8), f('CC3P', 9), f('CC4E', 12), f('CC4P', 13)] },
  { name: 'CNT', offset: 0x24, desc: 'Sayaç', fields: [f('CNT', 0, 32)] },
  { name: 'PSC', offset: 0x28, desc: 'Ön bölücü', fields: [f('PSC', 0, 16)] },
  { name: 'ARR', offset: 0x2C, desc: 'Otomatik yeniden yükleme (periyot)', fields: [f('ARR', 0, 32)] },
  { name: 'CCR1', offset: 0x34, fields: [f('CCR1', 0, 32)] },
  { name: 'CCR2', offset: 0x38, fields: [f('CCR2', 0, 32)] },
  { name: 'CCR3', offset: 0x3C, fields: [f('CCR3', 0, 32)] },
  { name: 'CCR4', offset: 0x40, fields: [f('CCR4', 0, 32)] }
];

const ADC_REGS = () => [
  { name: 'SR', offset: 0x00, fields: [f('AWD', 0), f('EOC', 1, 1, 'Dönüşüm bitti'), f('JEOC', 2), f('JSTRT', 3), f('STRT', 4), f('OVR', 5)] },
  { name: 'CR1', offset: 0x04, fields: [f('AWDCH', 0, 5), f('EOCIE', 5), f('SCAN', 8), f('RES', 24, 2, '00 = 12 bit')] },
  { name: 'CR2', offset: 0x08, fields: [f('ADON', 0), f('CONT', 1), f('DMA', 8), f('ALIGN', 11), f('SWSTART', 30)] },
  { name: 'SMPR2', offset: 0x10, fields: range('SMP', 10, 3) },
  { name: 'SQR3', offset: 0x34, fields: [f('SQ1', 0, 5, 'İlk dönüştürülecek kanal')] },
  { name: 'DR', offset: 0x4C, desc: 'Son dönüşüm sonucu', fields: [f('DATA', 0, 16)] }
];

const RCC_REGS = () => [
  { name: 'CR', offset: 0x00, fields: [f('HSION', 0), f('HSIRDY', 1), f('HSEON', 16), f('HSERDY', 17), f('HSEBYP', 18), f('CSSON', 19), f('PLLON', 24), f('PLLRDY', 25)] },
  { name: 'PLLCFGR', offset: 0x04, fields: [f('PLLM', 0, 6), f('PLLN', 6, 9), f('PLLP', 16, 2, '00=/2 01=/4 10=/6 11=/8'), f('PLLSRC', 22, 1, '1 = HSE'), f('PLLQ', 24, 4)] },
  { name: 'CFGR', offset: 0x08, fields: [f('SW', 0, 2, '00 HSI, 01 HSE, 10 PLL'), f('SWS', 2, 2, 'Etkin saat kaynağı'), f('HPRE', 4, 4), f('PPRE1', 10, 3), f('PPRE2', 13, 3)] },
  { name: 'AHB1ENR', offset: 0x30, fields: [f('GPIOAEN', 0), f('GPIOBEN', 1), f('GPIOCEN', 2), f('GPIOHEN', 7), f('DMA1EN', 21), f('DMA2EN', 22)] },
  { name: 'APB1ENR', offset: 0x40, fields: [f('TIM2EN', 0), f('TIM3EN', 1), f('TIM4EN', 2), f('SPI2EN', 14), f('USART2EN', 17), f('I2C1EN', 21), f('I2C2EN', 22), f('I2C3EN', 23), f('PWREN', 28)] },
  { name: 'APB2ENR', offset: 0x44, fields: [f('TIM1EN', 0), f('USART1EN', 4), f('USART6EN', 5), f('ADC1EN', 8), f('SPI1EN', 12), f('SYSCFGEN', 14)] }
];

const FLASH_REGS = () => [
  { name: 'ACR', offset: 0x00, fields: [f('LATENCY', 0, 4, 'Bekleme durumu'), f('PRFTEN', 8), f('ICEN', 9), f('DCEN', 10)] }
];

/** STM32F411 yerleşik tanımları */
function builtinStm32f4() {
  const P = (name, base, group, regs) => ({ name, base, group, registers: regs });
  return [
    P('RCC', 0x40023800, 'Sistem', RCC_REGS()),
    P('FLASH', 0x40023C00, 'Sistem', FLASH_REGS()),
    P('GPIOA', 0x40020000, 'GPIO', GPIO_REGS()),
    P('GPIOB', 0x40020400, 'GPIO', GPIO_REGS()),
    P('GPIOC', 0x40020800, 'GPIO', GPIO_REGS()),
    P('I2C1', 0x40005400, 'I2C', I2C_REGS()),
    P('I2C2', 0x40005800, 'I2C', I2C_REGS()),
    P('I2C3', 0x40005C00, 'I2C', I2C_REGS()),
    P('SPI1', 0x40013000, 'SPI', SPI_REGS()),
    P('SPI2', 0x40003800, 'SPI', SPI_REGS()),
    P('USART1', 0x40011000, 'USART', USART_REGS()),
    P('USART2', 0x40004400, 'USART', USART_REGS()),
    P('USART6', 0x40011400, 'USART', USART_REGS()),
    P('ADC1', 0x40012000, 'ADC', ADC_REGS()),
    P('TIM2', 0x40000000, 'TIM', TIM_REGS()),
    P('TIM3', 0x40000400, 'TIM', TIM_REGS()),
    P('TIM4', 0x40000800, 'TIM', TIM_REGS())
  ];
}

// ------------------------------------------------------------------ SVD
/** Çok küçük bir XML ayrıştırıcı: SVD için yeterli (etiket, metin, öznitelik). */
function parseXml(text) {
  const root = { tag: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[3]) {
      if (m[2] === '/') { stack.pop(); continue; }
      const attrs = {};
      for (const a of (m[4] || '').matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = a[2] ?? a[3];
      const el = { tag: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (m[5] !== '/') stack.push(el);
    } else if (m[6] !== undefined) top.text += m[6];
  }
  return root;
}

const child = (el, tag) => el && el.children.find((c) => c.tag === tag);
const kids = (el, tag) => (el ? el.children.filter((c) => c.tag === tag) : []);
const txt = (el, tag) => {
  const c = child(el, tag);
  return c ? c.text.trim().replace(/\s+/g, ' ') : undefined;
};
const num = (s) => (s === undefined ? undefined : s.toLowerCase().startsWith('0x') ? parseInt(s, 16) : s.startsWith('#') ? parseInt(s.slice(1), 2) : parseInt(s, 10));

/** CMSIS-SVD dosyasını register tanımlarına çevirir. */
function parseSvd(text) {
  const doc = parseXml(text);
  const device = child(doc, 'device');
  if (!device) throw new Error('Geçerli bir SVD dosyası değil (<device> yok).');
  const raw = kids(child(device, 'peripherals'), 'peripheral');
  const byName = new Map(raw.map((p) => [txt(p, 'name'), p]));
  const regsOf = (p) => {
    let regs = kids(child(p, 'registers'), 'register');
    if (!regs.length && p.attrs.derivedFrom && byName.has(p.attrs.derivedFrom)) regs = kids(child(byName.get(p.attrs.derivedFrom), 'registers'), 'register');
    return regs.map((r) => ({
      name: txt(r, 'name'),
      offset: num(txt(r, 'addressOffset')) || 0,
      desc: txt(r, 'description') || '',
      fields: kids(child(r, 'fields'), 'field').map((fl) => {
        let lsb = num(txt(fl, 'bitOffset')), width = num(txt(fl, 'bitWidth'));
        const br = txt(fl, 'bitRange');
        if (lsb === undefined && br) {
          const [msb, l] = br.replace(/[[\]]/g, '').split(':').map(Number);
          lsb = l;
          width = msb - l + 1;
        }
        if (lsb === undefined && txt(fl, 'lsb') !== undefined) {
          lsb = num(txt(fl, 'lsb'));
          width = num(txt(fl, 'msb')) - lsb + 1;
        }
        return { name: txt(fl, 'name'), lsb: lsb || 0, width: width || 1, desc: txt(fl, 'description') || '' };
      }).sort((a, b) => a.lsb - b.lsb)
    })).sort((a, b) => a.offset - b.offset);
  };
  const peripherals = raw.map((p) => {
    const base = byName.get(p.attrs.derivedFrom);
    return {
      name: txt(p, 'name'),
      base: num(txt(p, 'baseAddress')),
      group: txt(p, 'groupName') || (base && txt(base, 'groupName')) || 'Diğer',
      registers: regsOf(p)
    };
  }).filter((p) => p.registers.length);
  return { device: txt(device, 'name'), peripherals };
}

module.exports = { builtinStm32f4, parseSvd, parseXml };
