/* Profesyonel mod: "Kod Üret" önizlemesi. Hangi dosyaların ekleneceği, güncelleneceği, kaldırılacağı ve
 * kullanıcının değiştirdiği üretilmiş dosyalar gösterilir. Dosyaya tıklayınca VS Code fark görünümü açılır;
 * "Uygula" ile yazılır (eklenti: generate.apply). */
(function () {
  const { t, h, post, modal } = ES;

  function section(title, files, cls, hint, clickable = true) {
    if (!files.length) return null;
    return h('div', { class: `set-files ${cls}` },
      h('div', { class: 'set-files-head', text: `${title} (${files.length})` }),
      hint ? h('div', { class: 'hint', text: hint }) : null,
      ...files.map((f) => (clickable
        ? h('button', { class: 'link mono', title: t('Farkı göster'), onclick: () => post({ type: 'gen.diff', path: f }) }, f)
        : h('div', { class: 'mono', text: f }))));
  }
  const note = (level, text) => h('div', { class: `note ${level}` }, h('span', { class: 'ic', text: level === 'warn' ? '!' : 'i' }), h('span', { text }));

  ES.on('gen.preview', (m) => {
    const r = m.report;
    const body = h('div', { class: 'gen-preview' },
      m.owned ? note('info', t('Bare-metal profesyonel mod: main.c ve kendi dosyalarınıza dokunulmaz; sadece sürücü, BSP, kesme ve derleme dosyaları yazılır.')) : null,
      h('p', { class: 'hint', text: t('Dosyaya tıklayınca mevcut hali ile üretilecek hali yan yana açılır.') }),
      section(t('Eklenecek'), r.added, 'add'),
      section(t('Güncellenecek'), r.updated, 'mod'),
      section(t('Kaldırılacak'), r.removed, 'del', '', false),
      section(t('Değiştirdiğiniz üretilmiş dosyalar'), r.conflicts.map((f) => `${f}.new`), 'mod', t('Üzerine yazılmaz; yeni hali yanına .new uzantısıyla yazılır.')),
      section(t('Değiştirdiğiniz, artık üretilmeyen dosyalar'), r.preserved, 'del', t('.embedded-studio/removed/ altına taşınır.'), false),
      r.orphans.length ? note('warn', t('Kaldırılan sensörlere ait kodunuz silinmez; dosyanın sonundaki "Orphaned" bloğuna taşınır.')) : null,
      !r.added.length && !r.updated.length && !r.removed.length && !r.conflicts.length && !r.preserved.length ? h('p', { class: 'hint', text: t('Dosya içerikleri aynı; sadece kayıt güncellenir.') }) : null);
    modal({
      title: t('Kod Üret: önizleme'), width: 640, body,
      buttons: [{ label: t('Vazgeç') }, { label: t('Uygula'), id: 'gen-apply', primary: true, action: () => post({ type: 'generate.apply' }) }]
    });
  });
})();
