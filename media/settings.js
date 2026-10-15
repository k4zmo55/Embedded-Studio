/* Proje Ayarları sekmesi: MCU, kod altyapısı ve RTOS projenin kimliğidir; burada değiştirilir.
 * Seçimler önce taslakta tutulur, eklenti etkilenen dosyaları hesaplar (settings.preview), kullanıcı onaylayınca uygulanır. */
(function () {
  const { t, h, $, post, state, update, toast } = ES;
  let draft = null; // { mcuId, framework, rtos }
  let preview = null;
  let seq = 0;

  function mount(parent) {
    parent.append(h('main', { id: 'settings', class: 'tab-pane' }, h('div', { class: 'settings', id: 'settings-body' })));
  }

  const current = () => ({ mcuId: state.design.mcuId, framework: state.design.framework, rtos: !!state.design.rtos });
  const changed = () => draft && JSON.stringify(draft) !== JSON.stringify(current());

  function choice(group, value, title, desc) {
    const sel = draft[group] === value;
    return h('label', { class: `choice${sel ? ' selected' : ''}` },
      h('input', { type: 'radio', name: `set-${group}`, value: String(value), checked: sel, onchange: () => { draft[group] = value; requestPreview(); render(); } }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }));
  }

  function modeChoice(value, title, desc) {
    const sel = (state.design.mode || 'beginner') === value;
    return h('label', { class: `choice${sel ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'set-mode', value, checked: sel, onchange: () => { state.design.mode = value; update(); } }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }));
  }

  function requestPreview() {
    preview = null;
    if (changed()) post({ type: 'settings.preview', seq: ++seq, settings: draft });
  }

  function apply() {
    const mcuChanged = draft.mcuId !== state.design.mcuId;
    Object.assign(state.design, draft);
    if (mcuChanged) {
      state.design.locks = {};
      delete state.design.clock; // eklenti yeni MCU'nun varsayılan saat ayarını koyar
    }
    update();
    toast('info', t('Proje ayarları uygulandı. Dosyalar "Kod Üret" ile güncellenir.'));
    draft = null;
    preview = null;
    render();
  }

  function fileList(title, files, cls) {
    if (!files.length) return null;
    const shown = files.slice(0, 12);
    return h('div', { class: `set-files ${cls}` },
      h('div', { class: 'set-files-head', text: `${title} (${files.length})` }),
      ...shown.map((f) => h('div', { class: 'mono', text: f })),
      files.length > shown.length ? h('div', { class: 'hint', text: t('… ve {0} dosya daha', files.length - shown.length) }) : null);
  }

  function renderPreview() {
    if (!changed()) return h('p', { class: 'hint', text: t('Değişiklik yok.') });
    if (!preview) return h('p', { class: 'hint', text: t('Etkilenen dosyalar hesaplanıyor…') });
    const p = preview;
    return h('div', { class: 'set-preview' },
      ...p.notes.map((n) => h('div', { class: `note ${n.level}` }, h('span', { class: 'ic', text: n.level === 'warn' ? '!' : 'i' }), h('span', { text: n.text }))),
      p.generated
        ? h('div', {},
          fileList(t('Eklenecek'), p.added, 'add'),
          fileList(t('Kaldırılacak'), p.removed, 'del'),
          fileList(t('Değişecek'), p.changed, 'mod'),
          !p.added.length && !p.removed.length && !p.changed.length ? h('p', { class: 'hint', text: t('Üretilen dosyalarda değişiklik yok.') }) : null)
        : h('p', { class: 'hint', text: t('Henüz kod üretilmedi; dosyalar ilk "Kod Üret"te bu ayarlarla oluşturulur.') }),
      p.packs.length ? h('p', { class: 'hint', text: t('İndirilecek paketler: {0}', p.packs.join(', ')) }) : null);
  }

  function render() {
    const box = $('settings-body');
    if (!box || !state.design || !state.lib) return;
    if (!draft) draft = current();
    const proj = state.project || {};
    box.replaceChildren(
      h('h2', { text: t('Proje ayarları') }),
      h('section', { class: 'wizard-card' },
        h('div', { class: 'set-row' }, h('span', { class: 'label', text: t('Proje adı') }), h('span', { class: 'mono', text: (state.design.project || {}).name || '' })),
        h('div', { class: 'set-row' }, h('span', { class: 'label', text: t('Konum') }), h('span', { class: 'mono hint', text: proj.root || '' }))),
      h('section', { class: 'wizard-card' },
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Çalışma modu') }),
          h('div', { class: 'choices two' },
            modeChoice('beginner', t('Acemi'), t('Görsel tasarım: komponent seç, şemada bağla, pinleri ve saati asistan atasın, örnek kod üretilsin.')),
            modeChoice('pro', t('Profesyonel'), t('Debug ve test öncelikli, yoğun ve sade arayüz. Tasarım ekranı isteğe bağlı bir araç olarak kalır.')))),
        h('p', { class: 'hint', text: t('Mod sadece arayüzü değiştirir; dosyalara dokunmaz.') })),
      h('section', { class: 'wizard-card' },
        h('p', { class: 'hint', text: t('Bu ayarlar projenin kimliğidir ve üretilen dosyaların yapısını belirler. Değiştirmeden önce etkilenen dosyaları kontrol edin.') }),
        h('div', { class: 'field' },
          h('label', { for: 'set-mcu', text: t('Mikrodenetleyici') }),
          h('select', { id: 'set-mcu', onchange: (e) => { draft.mcuId = e.target.value; requestPreview(); render(); } },
            ...Object.values(state.lib.mcus).map((m) => h('option', { value: m.id, selected: m.id === draft.mcuId, text: `${m.name} · ${m.board}` })))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Kod altyapısı') }),
          h('div', { class: 'choices two' },
            choice('framework', 'hal', 'STM32 HAL', t('ST\'nin donanım soyutlama kütüphanesi projeye eklenir. Hızlı geliştirme, geniş örnek desteği.')),
            choice('framework', 'register', 'Bare-metal (register)', t('Sadece CMSIS başlıkları. Çevre birimleri doğrudan register ile sürülür; küçük ve şeffaf kod.')))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('İşletim sistemi') }),
          h('div', { class: 'choices two' },
            choice('rtos', false, t('Yok (süper döngü)'), t('Sensörler ana döngüde zamanlayıcıyla okunur.')),
            choice('rtos', true, 'FreeRTOS', t('Her sensör ayrı task; task izleme monitörde görünür.'))))),
      h('section', { class: 'wizard-card', id: 'set-preview' }, h('h3', { text: t('Etki') }), renderPreview()),
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'ghost', id: 'set-cancel', disabled: !changed(), onclick: () => { draft = null; preview = null; render(); } }, t('Vazgeç')),
        h('button', { id: 'set-apply', disabled: !changed() || !preview, onclick: apply }, t('Uygula'))));
  }

  ES.on('settings.preview', (m) => {
    if (m.seq !== seq) return;
    preview = m;
    render();
  });

  ES.tabs.settings = {
    mount,
    // Dışarıdan (ör. geri al) tasarım değişince taslak geçersizleşmesin diye sadece değişiklik yoksa sıfırla
    render() { if (!changed()) { draft = null; preview = null; } render(); },
    onShow: render
  };
})();
