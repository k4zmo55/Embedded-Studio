// @ts-check
/**
 * STM32 saat ağacı modeli (CubeMX "Clock Configuration" karşılığı). Model MCU tanımındaki clock.model'den gelir:
 *
 *  f4  (F4, F7)        HSI/HSE ─ /M ─ ×N ─┬─ /P ─ PLLCLK      └─ /Q ─ 48 MHz
 *  mul (F0, F1, F3)    HSI/2 ya da HSE/PREDIV(M) ─ ×PLLMUL(N) ─ PLLCLK
 *  mnr (G0, G4, L4, U5) HSI16/HSE ─ /M ─ ×N ─ /R ─ PLLCLK
 *  h7  (H7)            HSI64/HSE ─ /DIVM1 ─ ×N1 ─┬─ /P1 ─ PLLCLK  └─ /Q1 ─ SPI1-3 çekirdek saati
 *
 *  SYSCLK (HSI | HSE | PLLCLK) ─ /AHB ─ HCLK ─┬─ /APB1 ─ PCLK1 (TIM ×2)   (F0/G0'da tek APB)
 *                                              └─ /APB2 ─ PCLK2 (TIM ×2)   (H7 APB3/APB4, U5 APB3 = APB1 bölücüsü)
 */
const { t } = require('../i18n');

/** @typedef {{ pllSource: 'HSE'|'HSI', sysclkSource: 'PLL'|'HSE'|'HSI', hseMHz: number,
 *              M: number, N: number, P?: number, Q?: number, R?: number, ahb: number, apb1: number, apb2?: number }} ClockConfig */

const round = (v) => Math.round(v * 1e6) / 1e6;
/** [min, max] aralığı (2 eleman) ya da izin verilen değer listesi */
const allowed = (spec, v) => (spec.length === 2 ? v >= spec[0] && v <= spec[1] : spec.includes(v));
const values = (spec) => (spec.length === 2 ? Array.from({ length: spec[1] - spec[0] + 1 }, (_, i) => spec[0] + i) : spec);
const modelOf = (def) => def.model || 'f4';
const apbCountOf = (def) => (def.limits.apb2 === undefined ? 1 : 2);

/** Saat yapılandırmasını hesaplar ve sınırları denetler. */
function computeClock(mcu, cfg) {
  const def = mcu.clock;
  const model = modelOf(def);
  const c = { ...def.default, ...(cfg || {}) };
  /** @type {{ level: 'error'|'warn', field: string, text: string }[]} */
  const issues = [];
  const L = def.limits;
  const err = (field, text) => issues.push({ level: 'error', field, text });
  const pllUsed = c.sysclkSource === 'PLL';
  const hse = c.pllSource === 'HSE';

  let pllIn, vco = 0, pllclk, aux = 0;
  if (model === 'mul') {
    // F303xE gibi bazı modellerde HSI de PREDIV'den geçer (hsiPrediv); diğerlerinde HSI/2 sabit
    pllIn = hse ? c.hseMHz / c.M : def.hsiPrediv ? def.hsiMHz / c.M : def.hsiMHz / (def.hsiPllDiv || 2);
    pllclk = pllIn * c.N;
    vco = pllclk;
  } else {
    pllIn = (hse ? c.hseMHz : def.hsiMHz) / c.M;
    vco = pllIn * c.N;
    pllclk = vco / (model === 'mnr' ? c.R : c.P);
    if (model === 'f4' || model === 'h7') aux = vco / c.Q;
  }
  const sysclk = pllUsed ? pllclk : c.sysclkSource === 'HSE' ? c.hseMHz : def.hsiMHz;
  const hclk = sysclk / c.ahb;
  const pclk1 = hclk / c.apb1;
  const pclk2 = apbCountOf(def) === 2 ? hclk / c.apb2 : pclk1;
  // Referans kılavuz: APB bölücü 1 değilse timer saati PCLK'nın iki katıdır.
  const tim1 = c.apb1 === 1 ? pclk1 : pclk1 * 2;
  const tim2 = apbCountOf(def) === 2 ? (c.apb2 === 1 ? pclk2 : pclk2 * 2) : tim1;

  if (hse || c.sysclkSource === 'HSE') {
    if (c.hseMHz < def.hseRange[0] || c.hseMHz > def.hseRange[1]) err('hse', t('HSE {0}-{1} MHz aralığında olmalı.', def.hseRange[0], def.hseRange[1]));
  }
  if (pllUsed) {
    if (model === 'mul') {
      if ((hse || def.hsiPrediv) && !allowed(def.pllM, c.M)) err('M', t('M {0}-{1} aralığında olmalı.', def.pllM[0], def.pllM[def.pllM.length - 1]));
      if (!allowed(def.pllN, c.N)) err('N', t('N {0}-{1} aralığında olmalı.', def.pllN[0], def.pllN[def.pllN.length - 1]));
      if (pllclk < L.pllOut[0] || pllclk > L.pllOut[1]) err('N', t('PLL çıkışı {0} MHz; {1}-{2} MHz olmalı.', round(pllclk), L.pllOut[0], L.pllOut[1]));
    } else {
      if (pllIn < L.vcoIn[0] || pllIn > L.vcoIn[1]) err('M', t('PLL girişi {0} MHz; {1}-{2} MHz olmalı (M\'yi ayarlayın, 2 MHz önerilir).', round(pllIn), L.vcoIn[0], L.vcoIn[1]));
      if (vco < L.vcoOut[0] || vco > L.vcoOut[1]) err('N', t('VCO çıkışı {0} MHz; {1}-{2} MHz olmalı.', round(vco), L.vcoOut[0], L.vcoOut[1]));
      if (!allowed(def.pllM, c.M)) err('M', t('M {0}-{1} aralığında olmalı.', def.pllM[0], def.pllM[def.pllM.length - 1]));
      if (!allowed(def.pllN, c.N)) err('N', t('N {0}-{1} aralığında olmalı.', def.pllN[0], def.pllN[def.pllN.length - 1]));
      if (model === 'f4' && !allowed(def.pllQ, c.Q)) err('Q', t('Q {0}-{1} aralığında olmalı.', def.pllQ[0], def.pllQ[1]));
      if (model === 'mnr' && !allowed(def.pllR, c.R)) err('R', t('R şu değerlerden biri olmalı: {0}.', def.pllR.join(', ')));
      if (model === 'h7' && !allowed(def.pllP, c.P)) err('P', t('P şu değerlerden biri olmalı: {0}.', '2, 4 … 128'));
    }
  }
  if (sysclk > L.sysclk + 1e-9) err('sysclk', t('SYSCLK {0} MHz; en fazla {1} MHz.', round(sysclk), L.sysclk));
  if (hclk > L.hclk + 1e-9) err('hclk', t('HCLK {0} MHz; en fazla {1} MHz.', round(hclk), L.hclk));
  if (pclk1 > L.apb1 + 1e-9) err('apb1', t('APB1 {0} MHz; en fazla {1} MHz.', round(pclk1), L.apb1));
  if (apbCountOf(def) === 2 && pclk2 > L.apb2 + 1e-9) err('apb2', t('APB2 {0} MHz; en fazla {1} MHz.', round(pclk2), L.apb2));
  if (pclk1 < 4) issues.push({ level: 'warn', field: 'apb1', text: t('I2C 400 kHz (fast mode) için PCLK1 en az 4 MHz olmalı.') });
  if (model === 'f4' && pllUsed && Math.abs(aux - 48) > 0.01) issues.push({ level: 'warn', field: 'Q', text: t('48 MHz çıkışı {0} MHz. USB/SDIO kullanılmıyorsa sorun değil.', round(aux)) });
  if (model === 'h7' && pllUsed && aux > L.pllq + 1e-9) err('Q', t('PLL1Q {0} MHz; SPI1-3 çekirdek saati en fazla {1} MHz.', round(aux), L.pllq));

  const row = def.flashLatency.find(([max]) => hclk <= max) || def.flashLatency[def.flashLatency.length - 1];
  return {
    config: c,
    model,
    freq: {
      hsi: def.hsiMHz, hse: c.hseMHz, pllIn: round(pllIn), vco: round(vco), pllclk: round(pllclk),
      pll48: model === 'f4' ? round(aux) : 0, pllq: model === 'h7' ? round(aux) : 0,
      sysclk: round(sysclk), hclk: round(hclk), pclk1: round(pclk1), pclk2: round(pclk2), pclk3: round(pclk1), pclk4: round(pclk1),
      tim1: round(tim1), tim2: round(tim2)
    },
    latency: row[1],
    // Yüksek frekans modları: F4/F7 over-drive, G4 boost (R1MODE=0), U5 EPOD booster
    overdrive: !!def.overdriveAbove && sysclk > def.overdriveAbove + 1e-9,
    boost: !!def.boostAbove && sysclk > def.boostAbove + 1e-9,
    epod: !!def.epodAbove && sysclk > def.epodAbove + 1e-9,
    issues,
    ok: !issues.some((i) => i.level === 'error')
  };
}

/** Hedef SYSCLK'ya ulaşan geçerli bir PLL yapılandırması bulur. */
function solveClock(mcu, cfg, targetMHz) {
  const def = mcu.clock;
  const model = modelOf(def);
  const L = def.limits;
  const base = { ...def.default, ...(cfg || {}), sysclkSource: 'PLL' };
  const hse = base.pllSource === 'HSE';
  const src = hse ? base.hseMHz : def.hsiMHz;
  const target = Math.min(targetMHz, L.sysclk);
  let best = null;
  const consider = (score, fields) => { if (!best || score < best.score) best = { score, ...fields }; };

  if (model === 'mul') {
    for (const M of hse || def.hsiPrediv ? values(def.pllM) : [base.M]) {
      const pin = hse || def.hsiPrediv ? src / M : def.hsiMHz / (def.hsiPllDiv || 2);
      for (const N of values(def.pllN)) {
        const f = pin * N;
        if (f < L.pllOut[0] || f > L.pllOut[1] || f > L.sysclk + 1e-9) continue;
        consider(Math.abs(f - target) * 1000 + M, { M, N });
      }
    }
  } else {
    for (const M of values(def.pllM)) {
      const pin = src / M;
      if (pin < L.vcoIn[0] || pin > L.vcoIn[1]) continue;
      for (const D of model === 'mnr' ? def.pllR : def.pllP) {
        const N = Math.round((target * D) / pin);
        if (!allowed(def.pllN, N)) continue;
        const vco = pin * N;
        if (vco < L.vcoOut[0] || vco > L.vcoOut[1]) continue;
        const f = vco / D;
        if (f > L.sysclk + 1e-9) continue;
        if (model === 'f4') {
          const Q = Math.max(def.pllQ[0], Math.min(def.pllQ[1], Math.round(vco / 48)));
          // Puan: hedefe yakınlık, sonra 48 MHz doğruluğu, sonra 2 MHz PLL girişi (en iyi jitter).
          consider(Math.abs(f - target) * 1000 + Math.abs(vco / Q - 48) * 10 + Math.abs(pin - 2), { M, N, P: D, Q });
        } else if (model === 'h7') {
          const Q = def.pllQ.find((q) => vco / q <= L.pllq + 1e-9);
          if (!Q) continue;
          consider(Math.abs(f - target) * 1000 + D + Math.abs(pin - 8) / 100, { M, N, P: D, Q });
        } else {
          consider(Math.abs(f - target) * 1000 + D + Math.abs(pin - 8) / 100, { M, N, R: D });
        }
      }
    }
  }
  if (!best) return null;
  const { score, ...fields } = best;
  const c = { ...base, ...fields };
  const sys = computeClock(mcu, { ...c, ahb: 1, apb1: 1, apb2: 1 }).freq.sysclk;
  c.ahb = def.ahb.find((d) => sys / d <= L.hclk + 1e-9) ?? 1;
  const hclk = sys / c.ahb;
  c.apb1 = def.apb.find((d) => hclk / d <= L.apb1 + 1e-9) ?? 16;
  if (apbCountOf(def) === 2) c.apb2 = def.apb.find((d) => hclk / d <= L.apb2 + 1e-9) ?? 16;
  return c;
}

module.exports = { computeClock, solveClock, apbCountOf, values };
