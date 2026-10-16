/* Uygulama iskeleti: üst çubuk, sekmeler, karşılama ekranı ve mesaj yönlendirme. */
(function () {
  const { h, $, post, state, ui, saveUi, update, icon, t } = ES;
  const TABS = [['design', t('Tasarım')], ['clock', 'Clock'], ['monitor', t('Monitör')], ['terminal', 'Terminal'], ['debug', 'Debug'], ['analyzer', t('Bellek raporu')], ['settings', t('Ayarlar')]];

  function skeleton() {
    const app = $('app');
    app.replaceChildren(
      h('header', { id: 'topbar' },
        h('div', { class: 'brand' }, icon('chip', 18), h('span', { text: 'Embedded Studio' })),
        h('span', { class: 'proj', id: 'proj-name' }),
        // MCU / altyapı / RTOS burada sadece özet; değiştirmek için Ayarlar sekmesi (etkilenen dosyalar orada gösterilir)
        h('button', { class: 'ghost small proj-summary', id: 'proj-summary', title: t('Proje ayarlarını aç'), onclick: () => setTab('settings') }),
        h('span', { class: 'mode-badge', id: 'mode-badge', title: t('Çalışma modu (Ayarlar sekmesinden değiştirilir)') }),
        h('span', { class: 'save-state', id: 'save-state', title: t('Tasarım her değişiklikte otomatik kaydedilir') }),
        h('span', { class: 'spacer' }),
        h('nav', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, label]) => h('button', { id: `tab-${id}`, role: 'tab', onclick: () => setTab(id) }, label))),
        h('button', { class: 'icon', id: 'toggle-right', title: t('Bağlantılar panelini aç/kapat'), onclick: () => ES.tabs.design.setRightPanel(!ui.rightPanel) }, icon('panel', 16)),
        h('button', { id: 'generate', title: t('Tasarımdan kodu üret (sadece değişenler güncellenir)'), onclick: () => post({ type: 'generate' }) }, t('Kod Üret'))),
      h('div', { id: 'welcome', class: 'welcome' }),
      h('div', { id: 'panes', class: 'panes' }));
    for (const [id] of TABS) ES.tabs[id].mount($('panes'));
  }

  function setTab(tab) {
    ui.tab = tab;
    saveUi();
    for (const [id] of TABS) {
      $(id).classList.toggle('active', id === tab);
      $(`tab-${id}`).classList.toggle('active', id === tab);
      $(`tab-${id}`).setAttribute('aria-selected', String(id === tab));
    }
    $('toggle-right').style.visibility = tab === 'design' ? 'visible' : 'hidden';
    ES.hideTip();
    ES.closeMenu();
    if (state.design) ES.tabs[tab].onShow && ES.tabs[tab].onShow();
  }
  ES.setTab = setTab;

  ES.showWelcome = (on) => {
    document.body.classList.toggle('welcome-mode', on);
  };

  ES.on('init', (m) => {
    state.lib = m.lib;
  });

  /** Moda göre sekme sırası, görünürlük, gövde sınıfı; mod değiştiyse modun ana sekmesine geç. */
  function applyMode() {
    const id = (state.design && state.design.mode) === 'pro' ? 'pro' : 'beginner';
    const m = ES.mode();
    document.body.classList.toggle('mode-pro', id === 'pro');
    const nav = document.querySelector('#topbar .tabs');
    TABS.forEach(([tab]) => ($(`tab-${tab}`).hidden = !m.tabs.includes(tab)));
    m.tabs.forEach((tab, i) => {
      const b = $(`tab-${tab}`);
      b.title = `Alt+${i + 1}`;
      nav.append(b);
    });
    $('mode-badge').textContent = id === 'pro' ? t('Profesyonel') : t('Acemi');
    $('mode-badge').className = `mode-badge ${id}`;
    if (ui.modeSeen !== id) {
      // Modun ilk açılışı: modun ana sekmesi ve varsayılan asistan durumu
      ui.modeSeen = id;
      ui.assistantOpen = m.assistant;
      saveUi();
      setTab(m.home);
    } else if (!m.tabs.includes(ui.tab)) setTab(m.home);
  }

  ES.on('state', (m) => {
    ES.showWelcome(false);
    state.design = m.design;
    state.result = m.result;
    state.notes = m.notes;
    state.clock = m.clock;
    state.project = m.project;
    const mcu = state.lib.mcus[state.design.mcuId];
    $('proj-summary').textContent = [mcu ? mcu.name : state.design.mcuId, state.design.framework === 'hal' ? 'HAL' : 'bare-metal', state.design.rtos ? 'FreeRTOS' : t('RTOS yok')].join(' · ');
    $('proj-name').textContent = state.design.project ? state.design.project.name : '';
    applyMode(); // önce: asistan paneli ve ana sekme moda göre ayarlansın, sonra çizilsin
    for (const [id] of TABS) ES.tabs[id].render();
  });

  let savedTimer = 0;
  ES.on('saving', () => {
    const el = $('save-state');
    el.className = 'save-state saving';
    el.textContent = t('Kaydediliyor…');
  });
  ES.on('saved', () => {
    const el = $('save-state');
    el.className = 'save-state saved';
    el.textContent = t('✓ Kaydedildi');
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (el.textContent = t('✓ Otomatik kayıt açık')), 2500);
  });
  ES.on('generated', (m) => {
    if (m.report.orphans && m.report.orphans.length) ES.toast('warn', t('Kaldırılan sensörlere ait kodunuz silinmedi; ilgili dosyanın sonundaki "Orphaned" bloğunda.'));
  });
  // Eklenti bir sekmeyi açtırabilir (ör. durum çubuğundaki Terminal → Monitör)
  ES.on('tab', (m) => setTab(m.tab));
  ES.on('task.done', (m) => ES.toast(m.ok ? 'info' : 'error', m.ok ? t('{0} başarılı', m.name) : t('{0} başarısız (Terminal\'e bakın)', m.name)));

  // Alt+1…9: sekmeler arasında geçiş (moddaki sıraya göre)
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || !state.design || document.body.classList.contains('welcome-mode')) return;
    const n = Number(e.key);
    const tab = n >= 1 && ES.mode().tabs[n - 1];
    if (tab) { e.preventDefault(); setTab(tab); }
  });

  // Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z): tasarım ve clock değişikliklerini geri al / yinele
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || !state.design || document.body.classList.contains('welcome-mode')) return;
    if (ES.isTyping() || document.querySelector('.modal-overlay') || !['design', 'clock'].includes(ui.tab)) return;
    const k = e.key.toLowerCase();
    if (k === 'z' && !e.shiftKey) { e.preventDefault(); ES.undo(); }
    else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); ES.redo(); }
  });

  skeleton();
  setTab(ui.tab);
  post({ type: 'ready' });
})();
