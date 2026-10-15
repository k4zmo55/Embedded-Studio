/* Arayüz dili (bkz. src/i18n.js). Eklenti, sözlüğü sayfaya JSON olarak gömer: <script id="es-i18n" type="application/json">.
 * t('Türkçe metin {0}', değer) → etkin dil İngilizceyse sözlükteki karşılık, yoksa Türkçe metnin kendisi. */
window.ESI18N = (function () {
  let data = { lang: 'tr', dict: {} };
  try {
    const el = document.getElementById('es-i18n');
    if (el) data = JSON.parse(el.textContent);
  } catch { /* sözlük yoksa Türkçe */ }
  // Aynı Türkçe metnin bağlama göre farklı çevirisi için anahtar 'metin@@bağlam' olabilir; Türkçede @@ sonrası atılır.
  const t = (s, ...args) => ((data.lang === 'en' && data.dict[s]) || s.split('@@')[0]).replace(/\{(\d+)\}/g, (m, i) => (args[i] !== undefined ? String(args[i]) : m));
  document.documentElement.lang = data.lang;
  return { t, lang: data.lang, locale: data.lang === 'en' ? 'en' : 'tr' };
})();
