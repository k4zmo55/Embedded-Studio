/* Uygulama iskeleti: üst çubuk, sekmeler, karşılama ekranı ve mesaj yönlendirme. */
(function () {
  const { h, $, post, state, ui, saveUi, update, icon } = ES;
  const TABS = [['design', 'Tasarım'], ['clock', 'Clock'], ['monitor', 'Monitör'], ['debug', 'Debug']];

  function skeleton() {
    const app = $('app');
    app.replaceChildren(
      h('header', { id: 'topbar' },
        h('div', { class: 'brand' }, icon('chip', 18), h('span', { text: 'Embedded Studio' })),
        h('span', { class: 'proj', id: 'proj-name' }),
        h('label', {}, 'MCU', h('select', { id: 'mcu', onchange: (e) => { state.design.mcuId = e.target.value; state.design.locks = {}; update(); } })),
        h('label', { title: 'Kod altyapısı' }, 'Altyapı',
          h('select', { id: 'framework', onchange: (e) => { state.design.framework = e.target.value; update(); } },
            h('option', { value: 'hal', text: 'STM32 HAL' }),
            h('option', { value: 'register', text: 'Bare-metal (register)' }))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'rtos', onchange: (e) => { state.design.rtos = e.target.checked; update(); } }), h('span', { text: 'FreeRTOS' })),
        h('span', { class: 'save-state', id: 'save-state', title: 'Tasarım her değişiklikte otomatik kaydedilir' }),
        h('span', { class: 'spacer' }),
        h('nav', { class: 'tabs', role: 'tablist' }, ...TABS.map(([id, label]) => h('button', { id: `tab-${id}`, role: 'tab', onclick: () => setTab(id) }, label))),
        h('button', { class: 'icon', id: 'toggle-right', title: 'Bağlantılar panelini aç/kapat', onclick: () => ES.tabs.design.setRightPanel(!ui.rightPanel) }, icon('panel', 16)),
        h('button', { id: 'generate', title: 'Tasarımdan kodu üret (sadece değişenler güncellenir)', onclick: () => post({ type: 'generate' }) }, 'Kod Üret')),
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

  ES.on('state', (m) => {
    ES.showWelcome(false);
    state.design = m.design;
    state.result = m.result;
    state.notes = m.notes;
    state.clock = m.clock;
    state.project = m.project;
    $('mcu').replaceChildren(...Object.values(state.lib.mcus).map((x) => h('option', { value: x.id, text: x.name, selected: x.id === state.design.mcuId })));
    $('framework').value = state.design.framework;
    $('rtos').checked = !!state.design.rtos;
    $('proj-name').textContent = state.design.project ? state.design.project.name : '';
    for (const [id] of TABS) ES.tabs[id].render();
  });

  let savedTimer = 0;
  ES.on('saving', () => {
    const el = $('save-state');
    el.className = 'save-state saving';
    el.textContent = 'Kaydediliyor…';
  });
  ES.on('saved', () => {
    const el = $('save-state');
    el.className = 'save-state saved';
    el.textContent = '✓ Kaydedildi';
    clearTimeout(savedTimer);
    savedTimer = setTimeout(() => (el.textContent = '✓ Otomatik kayıt açık'), 2500);
  });
  ES.on('generated', (m) => {
    if (m.report.orphans && m.report.orphans.length) ES.toast('warn', 'Kaldırılan sensörlere ait kodunuz silinmedi; ilgili dosyanın sonundaki "Orphaned" bloğunda.');
  });
  ES.on('task.done', (m) => ES.toast(m.ok ? 'info' : 'error', `${m.name} ${m.ok ? 'başarılı' : 'başarısız (Terminal\'e bakın)'}`));

  skeleton();
  setTab(ui.tab);
  post({ type: 'ready' });
})();
