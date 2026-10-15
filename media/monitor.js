/* Monitör sekmesi: özelleştirilebilir widget panosu + RTOS task tablosu. */
(function () {
  const { t, h, $, post, state, ui, update, icon, modal, cIdent, toast } = ES;
  const mon = { running: false, channels: new Map(), tasks: new Map(), log: [], dirty: false };
  let editing = false;
  let built = new Map(); // widget id -> { cfg, inst }
  let lastKey = '';

  function mount(parent) {
    parent.append(h('main', { id: 'monitor', class: 'tab-pane' },
      h('div', { class: 'mon-main' },
        h('div', { class: 'mon-bar' },
          h('button', { id: 'mon-toggle', onclick: toggle }, icon('play', 12), h('span', { text: t('Başlat') })),
          h('span', { class: 'live', id: 'live', text: t('Durdu') }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'hint', text: t('Kaynak: simülasyon (firmware ile aynı $V/$T protokolü)') }),
          h('button', { class: 'ghost small', id: 'mon-edit', onclick: () => { editing = !editing; lastKey = ''; render(); } }, icon('edit', 12), h('span', { text: t('Düzenle') })),
          h('button', { class: 'ghost small', onclick: addWidgetDialog }, icon('plus', 12), 'Widget'),
          h('button', { class: 'ghost small', onclick: clear }, t('Temizle'))),
        h('div', { class: 'dash', id: 'dash' })),
      h('aside', { class: 'mon-side' },
        h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('RTOS task\'ları') })),
        h('div', { id: 'tasks' }),
        h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('Komponent durumu') })),
        h('div', { class: 'log', id: 'log' }))));
  }

  function toggle() {
    if (!mon.running) clear();
    post({ type: mon.running ? 'monitor.stop' : 'monitor.start' });
  }
  function clear() {
    mon.channels.clear();
    mon.tasks.clear();
    mon.log = [];
    for (const w of built.values()) w.inst && w.inst.reset && w.inst.reset();
    lastKey = '';
    render();
  }

  // ---------------------------------------------------------------- widget yapılandırması
  /** Tasarımdaki her komponent için varsayılan widget listesi. */
  function defaults(inst) {
    const c = state.lib.components[inst.componentId];
    if (!c || !c.telemetry || !c.telemetry.length) return [];
    const L = cIdent(inst.label);
    const list = c.monitor && c.monitor.length ? c.monitor : [{ type: 'chart', channels: c.telemetry.map((t) => t.id) }];
    return list.map((w, i) => ({ ...w, id: `${inst.id}:${i}`, inst: inst.id, channels: w.channels.map((ch) => `${L}.${ch}`) }));
  }

  /** Kayıtlı düzeni tasarımla senkronlar: silinen komponentlerin widget'larını atar, yenilerinkini ekler. */
  function widgets() {
    const d = state.design;
    const m = d.monitor || { widgets: null, hidden: [] };
    const ids = new Set(d.instances.map((i) => i.id));
    let list = m.widgets ? m.widgets.filter((w) => w.inst === 'SYS' || ids.has(w.inst)) : [];
    const covered = new Set(list.map((w) => w.inst));
    for (const inst of d.instances) {
      if (!covered.has(inst.id) && !(m.hidden || []).includes(inst.id)) list.push(...defaults(inst));
    }
    // etiket değiştiyse kanal adlarını güncelle
    list = list.map((w) => {
      const inst = d.instances.find((i) => i.id === w.inst);
      if (!inst) return w;
      const L = cIdent(inst.label);
      return { ...w, channels: w.channels.map((ch) => `${L}.${ch.split('.')[1]}`) };
    });
    if (d.rtos && !list.some((w) => w.inst === 'SYS') && !(m.hidden || []).includes('SYS')) list.push({ id: 'SYS:heap', inst: 'SYS', type: 'chart', channels: ['SYS.heap_free'] });
    return list;
  }

  function saveWidgets(list, hidden) {
    const m = state.design.monitor || {};
    state.design.monitor = { widgets: list, hidden: hidden || m.hidden || [] };
    lastKey = '';
    update();
  }

  // ---------------------------------------------------------------- veri
  const ctx = {
    series: (ch) => (mon.channels.get(ch) || { data: [] }).data,
    last: (ch) => {
      const d = (mon.channels.get(ch) || { data: [] }).data;
      return d.length ? d[d.length - 1].v : undefined;
    },
    unit: (ch) => {
      if (ch === 'SYS.heap_free') return 'B';
      const [owner, id] = ch.split('.');
      const inst = state.design && state.design.instances.find((i) => cIdent(i.label) === owner);
      const c = inst && state.lib.components[inst.componentId];
      return (c && c.telemetry && c.telemetry.find((t) => t.id === id)?.unit) || '';
    },
    short: (ch) => ch.split('.')[1] || ch,
    post
  };

  ES.on('telemetry', (m) => {
    const now = Date.now();
    for (const it of m.items) {
      if (it.type === 'value' && Number.isFinite(it.value)) {
        let ch = mon.channels.get(it.channel);
        if (!ch) mon.channels.set(it.channel, (ch = { data: [] }));
        ch.data.push({ t: now, v: it.value });
        if (ch.data.length > 600) ch.data.shift();
      } else if (it.type === 'task') mon.tasks.set(it.name, it);
      else if (it.type === 'status' || it.type === 'info' || it.type === 'text') {
        mon.log.push(it);
        if (mon.log.length > 40) mon.log.shift();
      }
    }
    if (!mon.dirty) {
      mon.dirty = true;
      // rAF kısıtlı ortamlarda (gizli/arka plan webview) gecikebilir; zamanlayıcı yedeği hangisi önce gelirse.
      const run = () => {
        if (!mon.dirty) return;
        mon.dirty = false;
        if (ui.tab === 'monitor') render();
      };
      requestAnimationFrame(run);
      setTimeout(run, 150);
    }
  });
  ES.on('monitor', (m) => {
    mon.running = m.running;
    if (ui.tab === 'monitor') render();
  });

  // ---------------------------------------------------------------- çizim
  function render() {
    if (!$('dash') || !state.design) return;
    $('live').classList.toggle('on', mon.running);
    $('live').textContent = mon.running ? t('Canlı · simülasyon') : t('Durdu');
    $('mon-toggle').replaceChildren(icon(mon.running ? 'pause' : 'play', 12), h('span', { text: mon.running ? t('Durdur') : t('Başlat') }));
    $('mon-edit').classList.toggle('active', editing);

    const list = widgets();
    const key = JSON.stringify(list) + editing;
    const dash = $('dash');
    if (key !== lastKey) {
      lastKey = key;
      built = new Map();
      dash.classList.toggle('editing', editing);
      if (!list.length) {
        dash.replaceChildren(h('div', { class: 'mon-empty' }, t('İzlenecek kanal yok. Tasarıma sensör ekleyin ya da "+ Widget" ile ekleyin.')));
      } else {
        dash.replaceChildren(...list.map((w, idx) => card(w, idx, list)));
      }
    }
    for (const w of built.values()) {
      try { w.inst.update(); } catch (e) { /* veri gelmeden bazı widget'lar boş kalır */ }
    }
    renderSide();
  }

  function titleOf(w) {
    if (w.inst === 'SYS') return t('Sistem');
    const inst = state.design.instances.find((i) => i.id === w.inst);
    return inst ? inst.label : w.inst;
  }

  function card(w, idx, list) {
    const T = ES.widgets.types[w.type] || ES.widgets.types.chart;
    const inst = T.create(w, ctx);
    built.set(w.id, { cfg: w, inst });
    const ids = w.channels.map((c) => c.split('.')[1]);
    const head = h('div', { class: 'w-head' },
      editing ? h('span', { class: 'drag', title: t('Sürükleyerek taşı') }, icon('drag', 14)) : null,
      h('span', { class: 'w-title', text: titleOf(w) }),
      h('span', { class: 'w-sub', text: editing ? '' : `${T.label}${w.channels.length > 1 ? '' : ' · ' + ids[0]}` }),
      editing ? h('select', {
        'aria-label': t('Widget türü'),
        onchange: (e) => saveWidgets(list.map((x) => (x.id === w.id ? { ...x, type: e.target.value } : x)))
      }, ...Object.entries(ES.widgets.types).filter(([, t]) => t.ok(w.channels.length, ids)).map(([k, t]) => h('option', { value: k, selected: k === w.type, text: t.label }))) : null,
      editing ? h('select', {
        'aria-label': t('Boyut'),
        onchange: (e) => saveWidgets(list.map((x) => (x.id === w.id ? { ...x, size: e.target.value } : x)))
      }, ...[['s', t('Küçük')], ['m', t('Geniş')], ['l', t('Büyük')]].map(([k, l]) => h('option', { value: k, selected: (w.size || 's') === k, text: l }))) : null,
      editing ? h('button', {
        class: 'icon', title: t('Widget\'ı kaldır'),
        onclick: () => {
          const rest = list.filter((x) => x.id !== w.id);
          const hidden = [...((state.design.monitor || {}).hidden || [])];
          if (!rest.some((x) => x.inst === w.inst)) hidden.push(w.inst); // bu komponentin hepsi silindiyse varsayılanları geri getirme
          saveWidgets(rest, hidden);
        }
      }, icon('close', 12)) : null);
    const el = h('div', { class: `w-card size-${w.size || 's'} t-${w.type}`, draggable: editing ? 'true' : null, 'data-idx': idx }, head, h('div', { class: 'w-body' }, inst.el));
    if (editing) {
      el.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/plain', String(idx)); el.classList.add('dragging'); });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('drop'); });
      el.addEventListener('dragleave', () => el.classList.remove('drop'));
      el.addEventListener('drop', (e) => {
        e.preventDefault();
        const from = Number(e.dataTransfer.getData('text/plain'));
        const to = idx;
        if (from === to) return;
        const copy = list.slice();
        const [moved] = copy.splice(from, 1);
        copy.splice(to, 0, moved);
        saveWidgets(copy);
      });
    }
    return el;
  }

  function addWidgetDialog() {
    const sources = state.design.instances.map((inst) => ({ inst, c: state.lib.components[inst.componentId] })).filter((x) => x.c && x.c.telemetry && x.c.telemetry.length);
    if (state.design.rtos) sources.push({ inst: { id: 'SYS', label: 'SYS' }, c: { name: t('Sistem'), telemetry: [{ id: 'heap_free', unit: 'B' }] } });
    if (!sources.length) return toast('warn', t('Ölçüm üreten komponent yok.'));
    const st = { src: 0, chans: new Set(), type: 'chart' };
    const body = h('div', { class: 'add-widget' });
    const draw = () => {
      const src = sources[st.src];
      const ids = [...st.chans];
      const types = Object.entries(ES.widgets.types).filter(([, t]) => ids.length && t.ok(ids.length, ids));
      if (!types.some(([k]) => k === st.type)) st.type = types.length ? types[0][0] : 'chart';
      body.replaceChildren(
        h('label', { class: 'field' }, h('span', { class: 'label', text: t('Kaynak') }),
          h('select', { onchange: (e) => { st.src = Number(e.target.value); st.chans = new Set(); draw(); } },
            ...sources.map((x, i) => h('option', { value: i, selected: i === st.src, text: `${x.inst.label} · ${x.c.name}` })))),
        h('div', { class: 'field' }, h('span', { class: 'label', text: t('Kanallar') }),
          h('div', { class: 'chans' }, ...src.c.telemetry.map((t) => h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: st.chans.has(t.id), onchange: (e) => { e.target.checked ? st.chans.add(t.id) : st.chans.delete(t.id); draw(); } }),
            h('span', { text: `${t.id}${t.unit ? ` (${t.unit})` : ''}` }))))),
        h('label', { class: 'field' }, h('span', { class: 'label', text: t('Görünüm') }),
          h('select', { disabled: !types.length, onchange: (e) => (st.type = e.target.value) }, ...types.map(([k, t]) => h('option', { value: k, selected: k === st.type, text: t.label })))));
    };
    draw();
    modal({
      title: t('Widget ekle'), body, width: 420,
      buttons: [{ label: t('Vazgeç') }, {
        label: t('Ekle'), primary: true,
        action: () => {
          if (!st.chans.size) { toast('warn', t('En az bir kanal seçin.')); return false; }
          const src = sources[st.src];
          const L = src.inst.id === 'SYS' ? 'SYS' : cIdent(src.inst.label);
          const list = widgets();
          list.push({ id: `${src.inst.id}:u${Date.now().toString(36)}`, inst: src.inst.id, type: st.type, channels: [...st.chans].map((c) => `${L}.${c}`), size: st.type === 'imu' ? 'l' : st.type === 'gps' || st.type === 'chart' ? 'm' : 's' });
          const hidden = ((state.design.monitor || {}).hidden || []).filter((x) => x !== src.inst.id);
          saveWidgets(list, hidden);
        }
      }]
    });
  }

  function renderSide() {
    const tasks = [...mon.tasks.values()].sort((a, b) => b.prio - a.prio || a.name.localeCompare(b.name));
    $('tasks').replaceChildren(tasks.length
      ? h('table', { class: 'tasks' },
        h('tr', {}, ...['Task', t('Durum'), t('Ö.'), 'Stack', 'CPU'].map((x) => h('th', { text: x }))),
        ...tasks.map((tk) => {
          const bar = h('div');
          bar.style.width = `${Math.max(0, Math.min(100, tk.cpu))}%`;
          return h('tr', {},
            h('td', { text: tk.name, title: tk.name }),
            h('td', {}, h('span', { class: `state ${tk.state}`, text: tk.state })),
            h('td', { class: 'num', text: tk.prio }),
            h('td', { class: `num${tk.stackFree < 40 ? ' bad' : ''}`, title: t('En düşük boş stack (word)'), text: tk.stackFree }),
            h('td', { class: 'num' }, `${tk.cpu.toFixed(1)}%`, h('div', { class: 'bar' }, bar)));
        }))
      : h('div', { class: 'hint pad', text: state.design && state.design.rtos ? t('Monitör başlatıldığında FreeRTOS task\'ları burada görünür.') : t('FreeRTOS kapalı. Üst çubuktan açabilirsiniz.') }));
    $('log').replaceChildren(...mon.log.slice().reverse().map((l) => {
      if (l.type === 'status') return h('div', {}, h('span', { text: `${l.source}: ` }), h('span', { class: /^OK/.test(l.text) ? 'ok' : 'bad', text: l.text }));
      if (l.type === 'info') return h('div', { class: 'hint', text: `▶ ${l.project} · ${l.mcu} · ${l.rtos}` });
      return h('div', { class: 'hint', text: l.text });
    }));
  }

  ES.tabs.monitor = { mount, render: () => { lastKey = ''; if (ui.tab === 'monitor') render(); }, onShow: () => { lastKey = ''; render(); } };
  ES.on('layout', () => { if (ui.tab === 'monitor') { lastKey = ''; render(); } });
  window.addEventListener('resize', () => { if (ui.tab === 'monitor') render(); });
})();
