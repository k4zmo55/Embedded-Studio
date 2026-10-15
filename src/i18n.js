// @ts-check
/**
 * Arayüz dili. Kaynak koddaki metinler Türkçedir; t('...') ile sarılır ve İngilizce karşılıkları
 * i18n/en.json sözlüğünde durur (anahtar = Türkçe metin). Karşılığı olmayan metin Türkçe kalır.
 * Değişkenler {0}, {1}... ile verilir: t('{0} tasarımdan çıkarıldı.', label)
 * Aynı metnin bağlama göre farklı çevirisi gerekiyorsa anahtar 'Durdur@@debug' biçiminde yazılır.
 *
 * Aynı sözlük webview'a da gönderilir (media/i18n.js). test/smoke.js, koddaki her t('...') metninin
 * sözlükte olduğunu denetler.
 */
const fs = require('fs');
const path = require('path');

const DICT_FILE = path.join(__dirname, '..', 'i18n', 'en.json');
const LANGS = ['tr', 'en'];

let lang = 'tr';
/** @type {Record<string, string>} */
let dict = {};

/** Ayar (auto | tr | en) ve VS Code dilinden etkin dili seçer. */
function resolveLanguage(setting, vscodeLanguage) {
  if (LANGS.includes(setting)) return setting;
  return String(vscodeLanguage || '').toLowerCase().startsWith('tr') ? 'tr' : 'en';
}

function loadDictionary() {
  return JSON.parse(fs.readFileSync(DICT_FILE, 'utf8'));
}

function setLanguage(l) {
  lang = LANGS.includes(l) ? l : 'tr';
  dict = lang === 'en' ? loadDictionary() : {};
}

const format = (s, args) => s.replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));

/** @param {string} s Türkçe metin @param {...any} args */
function t(s, ...args) {
  return format((lang === 'en' && dict[s]) || s.split('@@')[0], args);
}

module.exports = { t, setLanguage, resolveLanguage, loadDictionary, getLanguage: () => lang, getDictionary: () => dict, format, LANGS };
