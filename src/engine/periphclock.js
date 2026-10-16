// @ts-check
/**
 * Clock sekmesindeki "Çevre birimi saatleri" tablosu: her çevre biriminin saat kaynağı ve kod üretiminin
 * kullanacağı ayar (UART BRR ve hata payı, SPI bölücü, timer ön bölücü, ADC saati). Hesaplar kod üretimiyle aynıdır.
 */
const { familyOf, kernelClock, timerClock } = require('../codegen/families');

const KERNEL_LABEL = { pclk1: 'APB1', pclk2: 'APB2', pclk3: 'APB3', pclk4: 'APB4', hclk: 'AHB', hsi: 'HSI', pllq: 'PLL1Q' };

/** @returns {{ name: string, type: string, source: string, mhz: number, baud?: number, brr?: number, errPct?: number, speedKHz?: number, div?: number, outMHz?: number, psc?: number, tickMHz?: number, hz?: number }[]} */
function periphClockTable(mcu, result, clock) {
  const f = clock.freq;
  const fam = familyOf(mcu);
  return Object.entries(result.peripherals).filter(([name]) => mcu.peripherals[name]).map(([name, p]) => {
    if (p.type === 'pwm') {
      const key = timerClock(mcu, name);
      const mhz = f[key];
      const psc = Math.max(0, Math.round(mhz) - 1);
      return { name, type: p.type, source: `${key === 'tim2' ? 'APB2' : 'APB1'} timer`, mhz, psc, tickMHz: mhz / (psc + 1), hz: p.frequencyHz };
    }
    if (p.type === 'adc') {
      // Kod üretimiyle aynı: F1/F4/F7 PCLK2 bölücü, diğerleri senkron HCLK ya da (H7) per_ck
      if (fam.ip.adc === 'f1' || fam.ip.adc === 'f4') {
        const max = fam.ip.adc === 'f1' ? 14 : 36;
        const div = [2, 4, 6, 8].find((d) => f.pclk2 / d <= max) || 8;
        return { name, type: p.type, source: 'APB2', mhz: f.pclk2, div, outMHz: f.pclk2 / div };
      }
      if (fam.ip.adc === 'h7') return { name, type: p.type, source: 'per_ck (HSI)', mhz: f.hsi, div: 4, outMHz: f.hsi / 4 };
      if (fam.ip.adc === 'g0') {
        const div = f.pclk1 / 2 <= (fam.key === 'g0' ? 35 : 14) ? 2 : 4;
        return { name, type: p.type, source: 'APB', mhz: f.pclk1, div, outMHz: f.pclk1 / div };
      }
      const max = { f3: 72, g4: 60, l4: 80, u5: 55 }[fam.key] || 50;
      const div = fam.key === 'u5' ? 4 : [1, 2, 4].find((d) => f.hclk / d <= max) || 4;
      return { name, type: p.type, source: 'AHB', mhz: f.hclk, div, outMHz: f.hclk / div };
    }
    const key = kernelClock(mcu, name);
    const mhz = f[key];
    const row = { name, type: p.type, source: KERNEL_LABEL[key] || key, mhz };
    if (p.type === 'uart') {
      const brr = Math.round((mhz * 1e6) / p.baud);
      return { ...row, baud: p.baud, brr, errPct: (((mhz * 1e6) / brr - p.baud) / p.baud) * 100 };
    }
    if (p.type === 'i2c') return { ...row, speedKHz: p.speedHz / 1000 };
    if (p.type === 'spi') {
      let div = 2;
      while (div < 256 && (mhz * 1e6) / div > Math.min(p.speedHz, 10e6)) div *= 2;
      return { ...row, div, outMHz: mhz / div };
    }
    return row;
  });
}

module.exports = { periphClockTable };
