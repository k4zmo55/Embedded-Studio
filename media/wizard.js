/* Yeni proje sihirbazı: proje adı, konum, MCU, kod altyapısı (HAL / bare-metal), RTOS. */
(function () {
  const { h, $, post, on, icon, t } = ES;
  let info = null;
  const form = { name: 'embedded_app', location: '', mcuId: '', framework: 'hal', rtos: false, downloadPacks: true };

  function choice(group, value, title, desc, extra) {
    return h('label', { class: `choice${form[group] === value ? ' selected' : ''}` },
      h('input', { type: 'radio', name: group, value: String(value), checked: form[group] === value, onchange: () => { form[group] = value; render(); } }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }),
      extra || null);
  }

  function render() {
    const root = $('welcome');
    if (!root || !info) return;
    const nameOk = /^[A-Za-z_][A-Za-z0-9_]*$/.test(form.name);
    const where = form.location === 'here' ? info.here : form.location ? `${form.location}\\${form.name}` : '';
    root.replaceChildren(h('div', { class: 'wizard' },
      h('div', { class: 'wizard-hero' },
        h('div', { class: 'brand big' }, icon('chip', 28), h('span', { text: 'Embedded Studio' })),
        h('p', { class: 'muted', text: t('Komponentleri seç, pinleri asistan atasın, kodu üret, kartı programla ve canlı izle.') })),
      h('section', { class: 'wizard-card' },
        h('h2', { text: t('Yeni proje') }),
        h('div', { class: 'field' },
          h('label', { for: 'w-name', text: t('Proje adı') }),
          h('input', { id: 'w-name', type: 'text', value: form.name, oninput: (e) => { form.name = e.target.value; renderHint(); } }),
          h('span', { id: 'w-name-hint', class: `hint ${nameOk ? '' : 'bad'}`, text: nameOk ? t('Harf, rakam ve _ kullanın.') : t('Harf ile başlamalı; sadece harf, rakam ve _ içerebilir.') })),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Konum') }),
          h('div', { class: 'choices' },
            info.here ? choice('location', 'here', t('Bu klasör'), info.here) : null,
            h('label', { class: `choice${form.location && form.location !== 'here' ? ' selected' : ''}` },
              h('span', { class: 'choice-title', text: t('Yeni klasör') }),
              h('span', { class: 'choice-desc', text: form.location && form.location !== 'here' ? where : t('Proje adıyla yeni bir klasör oluşturulur ve VS Code onu açar.') }),
              h('button', { class: 'ghost small', onclick: (e) => { e.preventDefault(); post({ type: 'project.pickFolder' }); } }, t('Klasör seç…'))))),
        h('div', { class: 'field' },
          h('label', { for: 'w-mcu', text: t('Mikrodenetleyici') }),
          h('select', { id: 'w-mcu', onchange: (e) => (form.mcuId = e.target.value) },
            ...info.mcus.map((m) => h('option', { value: m.id, selected: m.id === form.mcuId, text: `${m.name} · ${m.board}` })))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Kod altyapısı') }),
          h('div', { class: 'choices two' },
            choice('framework', 'hal', 'STM32 HAL', t('ST\'nin donanım soyutlama kütüphanesi projeye eklenir. Hızlı geliştirme, geniş örnek desteği.')),
            choice('framework', 'register', 'Bare-metal (register)', t('Sadece CMSIS başlıkları. Çevre birimleri doğrudan register ile sürülür; küçük ve şeffaf kod.')))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('İşletim sistemi') }),
          h('div', { class: 'choices two' },
            choice('rtos', false, t('Yok (süper döngü)'), t('Sensörler ana döngüde zamanlayıcıyla okunur.')),
            choice('rtos', true, 'FreeRTOS', t('Her sensör ayrı task; task izleme monitörde görünür.')))),
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: form.downloadPacks, onchange: (e) => (form.downloadPacks = e.target.checked) }),
          h('span', { text: t('{0} kaynaklarını şimdi indir (git ile, bir kez ~30 MB)', [form.framework === 'hal' ? 'HAL' : '', 'CMSIS', form.rtos ? 'FreeRTOS' : ''].filter(Boolean).join(', ')) })),
        h('div', { class: 'wizard-actions' },
          h('button', {
            id: 'w-create',
            onclick: () => {
              if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(form.name)) return ES.toast('error', t('Geçerli bir proje adı girin.'));
              if (!form.location) return ES.toast('error', t('Bir konum seçin.'));
              post({ type: 'project.create', ...form });
            }
          }, t('Projeyi oluştur'))))));
  }

  function renderHint() {
    const ok = /^[A-Za-z_][A-Za-z0-9_]*$/.test(form.name);
    const hint = $('w-name-hint');
    if (hint) {
      hint.className = `hint ${ok ? '' : 'bad'}`;
      hint.textContent = ok ? t('Harf, rakam ve _ kullanın.') : t('Harf ile başlamalı; sadece harf, rakam ve _ içerebilir.');
    }
  }

  on('welcome', (m) => {
    info = m;
    form.name = m.defaultName || form.name;
    form.mcuId = m.mcus[0] && m.mcus[0].id;
    form.location = m.here ? 'here' : '';
    ES.showWelcome(true);
    render();
  });
  on('project.folder', (m) => {
    form.location = m.path;
    render();
  });
})();
