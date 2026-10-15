// @ts-check
/**
 * STM32F4 saat ağacı modeli (CubeMX "Clock Configuration" karşılığı).
 *
 *  HSI ─┐            ┌─ /P ─ PLLCLK ─┐
 *       ├─ /M ─ ×N ──┤               ├─ SYSCLK ─ /AHB ─ HCLK ─┬─ /APB1 ─ PCLK1 (TIM ×2)
 *  HSE ─┘            └─ /Q ─ 48 MHz  │                        └─ /APB2 ─ PCLK2 (TIM ×2)
 *              HSI / HSE ────────────┘
 */
const { t } = require('../i18n');

/** @typedef {{ pllSource: 'HSE'|'HSI', sysclkSource: 'PLL'|'HSE'|'HSI', hseMHz: number,
 *              M: number, N: number, P: number, Q: number, ahb: number, apb1: number, apb2: number }} ClockConfig */

const round = (v) => Math.round(v * 1e6) / 1e6;

/** Saat yapılandırmasını hesaplar ve sınırları denetler. */
function computeClock(mcu, cfg) {
  const def = mcu.clock;
  const c = { ...def.default, ...(cfg || {}) };
  /** @type {{ level: 'error'|'warn', field: string, text: string }[]} */
  const issues = [];
  const L = def.limits;

  const pllIn = (c.pllSource === 'HSE' ? c.hseMHz : def.hsiMHz) / c.M;
  const vco = pllIn * c.N;
  const pllclk = vco / c.P;
  const pll48 = vco / c.Q;
  const pllUsed = c.sysclkSource === 'PLL';
  const sysclk = pllUsed ? pllclk : c.sysclkSource === 'HSE' ? c.hseMHz : def.hsiMHz;
  const hclk = sysclk / c.ahb;
  const pclk1 = hclk / c.apb1;
  const pclk2 = hclk / c.apb2;
  // Referans kılavuz: APB bölücü 1 değilse timer saati PCLK'nın iki katıdır.
  const tim1 = c.apb1 === 1 ? pclk1 : pclk1 * 2;
  const tim2 = c.apb2 === 1 ? pclk2 : pclk2 * 2;

  const err = (field, text) => issues.push({ level: 'error', field, text });
  if (c.hseMHz < def.hseRange[0] || c.hseMHz > def.hseRange[1]) err('hse', t('HSE {0}-{1} MHz aralığında olmalı.', def.hseRange[0], def.hseRange[1]));
  if (pllUsed || c.pllSource) {
    if (pllUsed && (pllIn < L.vcoIn[0] || pllIn > L.vcoIn[1])) err('M', t('PLL girişi {0} MHz; {1}-{2} MHz olmalı (M\'yi ayarlayın, 2 MHz önerilir).', round(pllIn), L.vcoIn[0], L.vcoIn[1]));
    if (pllUsed && (vco < L.vcoOut[0] || vco > L.vcoOut[1])) err('N', t('VCO çıkışı {0} MHz; {1}-{2} MHz olmalı.', round(vco), L.vcoOut[0], L.vcoOut[1]));
    if (c.M < def.pllM[0] || c.M > def.pllM[1]) err('M', t('M {0}-{1} aralığında olmalı.', def.pllM[0], def.pllM[1]));
    if (c.N < def.pllN[0] || c.N > def.pllN[1]) err('N', t('N {0}-{1} aralığında olmalı.', def.pllN[0], def.pllN[1]));
    if (c.Q < def.pllQ[0] || c.Q > def.pllQ[1]) err('Q', t('Q {0}-{1} aralığında olmalı.', def.pllQ[0], def.pllQ[1]));
  }
  if (sysclk > L.sysclk + 1e-9) err('sysclk', t('SYSCLK {0} MHz; en fazla {1} MHz.', round(sysclk), L.sysclk));
  if (hclk > L.hclk + 1e-9) err('hclk', t('HCLK {0} MHz; en fazla {1} MHz.', round(hclk), L.hclk));
  if (pclk1 > L.apb1 + 1e-9) err('apb1', t('APB1 {0} MHz; en fazla {1} MHz.', round(pclk1), L.apb1));
  if (pclk2 > L.apb2 + 1e-9) err('apb2', t('APB2 {0} MHz; en fazla {1} MHz.', round(pclk2), L.apb2));
  if (pclk1 < 4) issues.push({ level: 'warn', field: 'apb1', text: t('I2C 400 kHz (fast mode) için PCLK1 en az 4 MHz olmalı.') });
  if (pllUsed && Math.abs(pll48 - 48) > 0.01) issues.push({ level: 'warn', field: 'Q', text: t('48 MHz çıkışı {0} MHz. USB/SDIO kullanılmıyorsa sorun değil.', round(pll48)) });

  const latency = (def.flashLatency.find(([max]) => hclk <= max) || def.flashLatency[def.flashLatency.length - 1])[1];

  return {
    config: c,
    freq: { hsi: def.hsiMHz, hse: c.hseMHz, pllIn: round(pllIn), vco: round(vco), pllclk: round(pllclk), pll48: round(pll48),
      sysclk: round(sysclk), hclk: round(hclk), pclk1: round(pclk1), pclk2: round(pclk2), tim1: round(tim1), tim2: round(tim2) },
    latency,
    issues,
    ok: !issues.some((i) => i.level === 'error')
  };
}

/** Hedef SYSCLK'ya ulaşan geçerli bir PLL yapılandırması bulur (48 MHz çıkışını da tutturmaya çalışır). */
function solveClock(mcu, cfg, targetMHz) {
  const def = mcu.clock;
  const base = { ...def.default, ...(cfg || {}), sysclkSource: 'PLL' };
  const src = base.pllSource === 'HSE' ? base.hseMHz : def.hsiMHz;
  const target = Math.min(targetMHz, def.limits.sysclk);
  let best = null;
  for (let M = def.pllM[0]; M <= def.pllM[1]; M++) {
    const pin = src / M;
    if (pin < def.limits.vcoIn[0] || pin > def.limits.vcoIn[1]) continue;
    for (const P of def.pllP) {
      const N = Math.round((target * P) / pin);
      if (N < def.pllN[0] || N > def.pllN[1]) continue;
      const vco = pin * N;
      if (vco < def.limits.vcoOut[0] || vco > def.limits.vcoOut[1]) continue;
      const f = vco / P;
      if (f > def.limits.sysclk + 1e-9) continue;
      let Q = Math.round(vco / 48);
      Q = Math.max(def.pllQ[0], Math.min(def.pllQ[1], Q));
      // Puan: hedefe yakınlık, sonra 48 MHz doğruluğu, sonra 2 MHz PLL girişi (en iyi jitter).
      const score = Math.abs(f - target) * 1000 + Math.abs(vco / Q - 48) * 10 + Math.abs(pin - 2);
      if (!best || score < best.score) best = { score, M, N, P, Q };
    }
  }
  if (!best) return null;
  const c = { ...base, M: best.M, N: best.N, P: best.P, Q: best.Q, ahb: 1 };
  const hclk = (src / c.M) * c.N / c.P;
  c.apb1 = def.apb.find((d) => hclk / d <= def.limits.apb1 + 1e-9) ?? 16;
  c.apb2 = def.apb.find((d) => hclk / d <= def.limits.apb2 + 1e-9) ?? 16;
  return c;
}

module.exports = { computeClock, solveClock };
