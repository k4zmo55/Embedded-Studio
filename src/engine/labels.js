// @ts-check
/**
 * ES-1003: pin etiketleri (CubeMX "User Label"). Tasarımda design.pinLabels = { PA12: 'Pin_Led' }.
 * Etiket C tanımlayıcısı olmalı: kodda <etiket>_Pin ve <etiket>_GPIO_Port olarak üretilir (board.h).
 */
const { t } = require('../i18n');

const C_KEYWORDS = new Set(('auto break case char const continue default do double else enum extern float for goto if inline int long register '
  + 'restrict return short signed sizeof static struct switch typedef union unsigned void volatile while _Bool _Complex _Imaginary _Static_assert '
  + 'bool true false NULL').split(' '));
const MAX_LEN = 40;

/** Üretilen kodda komponent pinlerinin adları (board.h: <AD>_Port / <AD>_Pin) — etiket bunlarla çakışmamalı */
const cIdent = (s) => s.toUpperCase().replace(/[^A-Z0-9]/g, '_');

/**
 * Tek bir etiketin biçim hatası ('' geçerli).
 * @param {string} label
 */
function formatError(label) {
  if (!label) return t('Etiket boş.');
  if (label.length > MAX_LEN) return t('Etiket en fazla {0} karakter olabilir.', MAX_LEN);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(label)) return t('Etiket harf ya da _ ile başlamalı; yalnızca harf, rakam ve _ içerebilir (C tanımlayıcısı).');
  if (C_KEYWORDS.has(label)) return t('"{0}" C anahtar kelimesi; etiket olamaz.', label);
  if (/^__/.test(label) || /^_[A-Z]/.test(label)) return t('"{0}" C derleyicisine ayrılmış ad biçiminde (__ ya da _ + büyük harf).', label);
  return '';
}

/**
 * Tasarımdaki etiketleri denetler.
 * @param {Record<string, string> | undefined} pinLabels
 * @param {any} mcu
 * @param {{ instId: string, compPin: string, kind: string, cs?: boolean, signal: string }[]} connections
 * @param {{ id: string, label: string }[]} instances
 * @returns {{ labels: Record<string, string>, issues: Record<string, string> }} labels: geçerli olanlar, issues: pin → neden
 */
function checkLabels(pinLabels, mcu, connections, instances) {
  const labels = {};
  const issues = {};
  const pins = new Set(mcu.pins.map((p) => p.name));
  const labelOf = (id) => (instances.find((i) => i.id === id) || { label: id }).label;
  // Komponent pinleri için üretilen adlar ve çevre birimi sinyal adları
  const taken = new Set(connections.map((c) => (c.kind === 'gpio' || c.cs ? `${cIdent(labelOf(c.instId))}_${cIdent(c.compPin)}` : c.signal)));
  const seen = new Map();
  for (const [pin, raw] of Object.entries(pinLabels || {})) {
    const label = String(raw || '').trim();
    let err = !pins.has(pin) ? t('{0} bu işlemcide yok.', pin) : formatError(label);
    if (!err && taken.has(label)) err = t('"{0}" bir komponent pini için üretilen adla çakışıyor.', label);
    if (!err && seen.has(label)) err = t('"{0}" etiketi {1} pininde de var; etiketler benzersiz olmalı.', label, seen.get(label));
    if (err) issues[pin] = err;
    else {
      labels[pin] = label;
      seen.set(label, pin);
    }
  }
  return { labels, issues };
}

/** İşlemci değişince: yeni işlemcide olan pinlerin etiketleri kalır, diğerleri listelenir */
function carryLabels(pinLabels, mcu) {
  const pins = new Set(mcu.pins.map((p) => p.name));
  const kept = {}, dropped = {};
  for (const [pin, label] of Object.entries(pinLabels || {})) (pins.has(pin) ? kept : dropped)[pin] = label;
  return { kept, dropped };
}

module.exports = { formatError, checkLabels, carryLabels, MAX_LEN };
