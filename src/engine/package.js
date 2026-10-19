// @ts-check
/**
 * ES-1002: işlemci paketi ve fiziksel pinler (data/mcus/<id>.json → "package"; tools/mcu/gen-package.js üretir).
 * Pin atayıcı "pins" alanını kullanmaya devam eder; buradaki işlevler Pinout görünümü (ES-1004) ve pin bilgisi içindir.
 */

/** Her fiziksel ped bir kez (aynı pedi paylaşan ikincil girdiler, ör. G0 "PA9 [PA11]", hariç) */
function pads(mcu) {
  return ((mcu.package && mcu.package.pins) || []).filter((p) => !p.alt);
}

/** Bir GPIO'nun pedi (asıl girdi); yoksa null */
function padFor(mcu, gpio) {
  return pads(mcu).find((p) => p.gpio === gpio) || null;
}

/** Aynı pedin ikincil girdileri (yeniden eşlenebilen GPIO ya da paylaşılan özel işlev) */
function alternates(mcu, pad) {
  return ((mcu.package && mcu.package.pins) || []).filter((p) => p.alt && p.pos === pad.pos);
}

/**
 * Kenarlı paketlerde (LQFP / QFN) pedin kenarı ve kenardaki sırası. Datasheet'teki üstten görünüş: 1. pin sol kenarın
 * üstünde, numaralar saat yönünün tersine artar — sol (yukarıdan aşağı), alt (soldan sağa), sağ (aşağıdan yukarı),
 * üst (sağdan sola). TSSOP / SO: sol (yukarıdan aşağı), sağ (aşağıdan yukarı).
 * @returns {{ side: 'left'|'bottom'|'right'|'top', index: number, perSide: number } | null}
 */
function sideOf(pkg, pos) {
  const n = Number(pos);
  if (!pkg || !pkg.sides || !Number.isInteger(n) || n < 1 || n > pkg.pinCount) return null;
  const perSide = pkg.pinCount / pkg.sides;
  const i = n - 1;
  const order = pkg.sides === 4 ? ['left', 'bottom', 'right', 'top'] : ['left', 'right'];
  return { side: /** @type {any} */ (order[Math.floor(i / perSide)]), index: i % perSide, perSide };
}

module.exports = { pads, padFor, alternates, sideOf };
