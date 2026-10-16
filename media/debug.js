/* Debug sekmesi: bağlantı (simülasyon / OpenOCD + ST-Link), çalıştırma kontrolü,
 * core register'lar, çevre birimi register'ları (bit alanlarıyla), değişken izleme, bellek. */
(function () {
  const { t, h, $, post, state, ui, icon, hex, toast, modal } = ES;
  const dbg = {
    connected: false, connecting: false, mode: 'sim', state: '', error: '',
    // defs: çevre birimi listesi (register'sız); register tanımları seçilince istenir ve regs'te saklanır (ES-205)
    defs: [], used: [], source: '', regs: {}, favs: [], cpu: {}, groups: new Set(), edit: null, fpuOpen: false,
    periph: null, open: new Set(), filter: '',
    values: {}, prev: {}, core: null, coreErr: '',
    // Bellek görüntüleyici (ES-206): sayfa başı 16 bayta hizalı; memMark: gidilen sembol/adres vurgusu
    memAddr: 0x20000000, memLen: 256, memWidth: 1, memEdit: null, memMark: null,
    // Live Watch: hist[ad] = [{ t, v }] (grafik için), watchEdit: düzenlenen değişken
    symbols: [], symSource: '', watch: [], symFilter: '', hist: {}, charts: [], chartKey: '', watchEdit: null, savedWatch: null,
    auto: true, interval: 500, seq: 0, inflight: false, timer: 0
  };

  // Okunması yan etki yaratan register'lar (bayrak temizler / veri tüketir): sadece hedef durunca okunur.
  const sideEffect = (periph, reg) => {
    const g = periph.name.replace(/\d+$/, '');
    if (['USART', 'UART', 'SPI', 'I2C', 'ADC'].includes(g) && reg.name === 'DR') return true;
    return g === 'I2C' && reg.name === 'SR2';
  };

  function mount(parent) {
    parent.append(h('main', { id: 'debug', class: 'tab-pane' },
      h('div', { class: 'dbg-bar' },
        h('select', { id: 'dbg-mode', 'aria-label': t('Bağlantı türü'), onchange: (e) => (dbg.mode = e.target.value) },
          h('option', { value: 'sim', text: t('Simülasyon (kart yok)') }),
          h('option', { value: 'openocd', text: t('OpenOCD (bağlı prob)') })),
        h('button', { id: 'dbg-conn', onclick: () => (dbg.connected ? post({ type: 'debug.disconnect' }) : connect()) }, t('Bağlan')),
        h('span', { id: 'dbg-state', class: 'badge' }),
        h('span', { class: 'sep' }),
        h('button', { class: 'ghost small', id: 'dbg-halt', title: t('Durdur (halt)'), onclick: () => cmd('halt') }, icon('pause', 12), t('Durdur@@debug')),
        h('button', { class: 'ghost small', id: 'dbg-resume', title: t('Devam et'), onclick: () => cmd('resume') }, icon('play', 12), t('Devam')),
        h('button', { class: 'ghost small', id: 'dbg-step', title: t('Tek komut adım'), onclick: () => cmd('step') }, icon('step', 12), t('Adım')),
        h('button', { class: 'ghost small', id: 'dbg-reset', title: 'Reset', onclick: () => cmd('reset') }, icon('reset', 12), 'Reset'),
        h('span', { class: 'sep' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: dbg.auto, onchange: (e) => { dbg.auto = e.target.checked; schedule(); } }), h('span', { text: t('Canlı') })),
        h('select', { 'aria-label': t('Yenileme aralığı'), onchange: (e) => { dbg.interval = Number(e.target.value); schedule(); } },
          ...[[250, '250 ms'], [500, '500 ms'], [1000, '1 sn']].map(([v, l]) => h('option', { value: v, selected: v === dbg.interval, text: l }))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost small', onclick: () => post({ type: 'build' }) }, t('Derle')),
        h('button', { class: 'small', onclick: () => post({ type: 'flash' }) }, t('Yükle'))),
      h('div', { class: 'dbg-msg', id: 'dbg-msg' }),
      h('div', { class: 'dbg-grid' },
        h('section', { class: 'dbg-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('Core register\'lar') })),
          h('div', { id: 'dbg-core' }),
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('Değişkenler (izleme)') }), h('button', { class: 'ghost small', onclick: () => post({ type: 'debug.symbols' }) }, t('ELF\'ten yükle'))),
          h('div', { class: 'search' }, icon('search', 13), h('input', { type: 'text', id: 'dbg-sym', placeholder: t('Değişken ara ve ekle…'), oninput: (e) => { dbg.symFilter = e.target.value; renderSymbols(); } })),
          h('div', { id: 'dbg-symlist', class: 'symlist' }),
          h('div', { id: 'dbg-watch' }),
          h('div', { id: 'dbg-wchart', class: 'wchart' })),
        h('section', { class: 'dbg-col wide' },
          h('div', { class: 'pane-head' },
            h('span', { class: 'pane-title', text: t('Çevre birimi register\'ları') }),
            h('span', { class: 'hint', id: 'dbg-src' }),
            h('span', { class: 'spacer' }),
            h('button', { class: 'ghost small', title: t('Tam CMSIS-SVD tanımını indir'), onclick: () => post({ type: 'debug.svd' }) }, t('SVD indir'))),
          h('div', { class: 'periph-split' },
            h('div', { class: 'periph-list' },
              h('div', { class: 'search' }, icon('search', 13), h('input', { type: 'text', placeholder: t('Çevre birimi…'), oninput: (e) => { dbg.filter = e.target.value.toUpperCase(); renderPeriphList(); } })),
              h('div', { id: 'dbg-plist' })),
            h('div', { class: 'periph-regs', id: 'dbg-regs' }))),
        h('section', { class: 'dbg-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: t('Bellek') })),
          h('div', { class: 'mem-bar' },
            h('input', { type: 'text', id: 'mem-addr', class: 'mono', list: 'mem-syms', value: hex(dbg.memAddr), placeholder: t('Adres ya da sembol'), 'aria-label': t('Adres ya da sembol'), onkeydown: (e) => { if (e.key === 'Enter') goMem(); } }),
            h('datalist', { id: 'mem-syms' }),
            h('button', { class: 'small', onclick: goMem }, t('Git')),
            h('select', { id: 'mem-width', class: 'tiny', 'aria-label': t('Görünüm genişliği'), onchange: (e) => { dbg.memWidth = Number(e.target.value); dbg.memEdit = null; renderMem(); } },
              ...[[1, '8 bit'], [2, '16 bit'], [4, '32 bit']].map(([v, l]) => h('option', { value: v, selected: v === dbg.memWidth, text: l }))),
            h('button', { class: 'ghost small', title: t('Önceki sayfa'), 'aria-label': t('Önceki sayfa'), onclick: () => setMem(dbg.memAddr - dbg.memLen) }, '‹'),
            h('button', { class: 'ghost small', title: t('Sonraki sayfa'), 'aria-label': t('Sonraki sayfa'), onclick: () => setMem(dbg.memAddr + dbg.memLen) }, '›'),
            h('button', { class: 'ghost small', onclick: () => { dbg.memMark = null; setMem(0x20000000); } }, 'SRAM'),
            h('button', { class: 'ghost small', onclick: () => { dbg.memMark = null; setMem(0x08000000); } }, 'Flash'),
            h('button', { class: 'ghost small', id: 'mem-save', title: t('Bölgeyi dosyaya kaydet (.bin / .hex)'), onclick: saveMem }, t('Kaydet…'))),
          h('div', { id: 'mem-info', class: 'hint mem-info' }),
          h('div', { id: 'dbg-mem', class: 'mem' })))));
  }

  // ---------------------------------------------------------------- bağlantı
  function connect() {
    dbg.error = '';
    dbg.connecting = true;
    renderBar();
    post({ type: 'debug.connect', mode: dbg.mode });
  }
  function cmd(c) {
    if (dbg.connected) post({ type: 'debug.cmd', cmd: c });
  }

  ES.on('debug.status', (m) => {
    dbg.connected = !!m.connected;
    dbg.connecting = !!m.connecting;
    if (m.mode) dbg.mode = m.mode;
    dbg.state = m.state || '';
    dbg.error = m.error || '';
    if (!dbg.connected) { dbg.core = null; dbg.values = {}; }
    renderBar();
    renderCore();
    renderRegs();
    renderMem();
    renderWatch();
    schedule();
    if (dbg.connected) poll();
    // Kaydedilmiş izleme listesi sembollerle geri yüklenir
    if (dbg.connected && !dbg.symbols.length) post({ type: 'debug.symbols' });
  });
  ES.on('debug.regs', (m) => {
    dbg.defs = m.peripherals;
    dbg.used = m.used;
    dbg.source = m.source;
    dbg.cpu = m.cpu || {};
    dbg.regs = {};
    if (dbg.periph !== FAV && (!dbg.periph || !dbg.defs.find((p) => p.name === dbg.periph))) dbg.periph = dbg.defs.find((p) => dbg.used.includes(p.name))?.name || dbg.defs[0]?.name;
    select(dbg.periph);
  });
  ES.on('debug.periph', (m) => {
    dbg.regs[m.name] = { base: m.base, registers: m.registers };
    if (m.name === dbg.periph) { renderRegs(); poll(); }
  });
  ES.on('debug.favorites', (m) => {
    dbg.favs = m.favorites;
    if (dbg.periph === FAV && !dbg.favs.length) dbg.periph = dbg.defs[0]?.name;
    renderPeriphList();
    renderRegs();
  });
  ES.on('debug.written', () => poll());

  const FAV = '★';
  /** Çevre birimini seç; register tanımı yoksa iste */
  function select(name) {
    dbg.periph = name;
    dbg.open.clear();
    dbg.edit = null;
    if (name && name !== FAV && !dbg.regs[name]) post({ type: 'debug.periph', name });
    renderPeriphList();
    renderRegs();
    poll();
  }
  /** Görünen register'lar: [{ periph, base, reg }] (seçili çevre birimi ya da favoriler) */
  function shown() {
    if (dbg.periph === FAV) return dbg.favs.map((f) => ({ periph: f.periph, base: f.base, reg: f.reg }));
    const d = dbg.regs[dbg.periph];
    return d ? d.registers.map((reg) => ({ periph: dbg.periph, base: d.base, reg })) : [];
  }
  ES.on('debug.symbols', (m) => {
    dbg.symbols = m.symbols;
    dbg.symSource = m.source || '';
    if (m.error) toast(m.symbols.length ? 'info' : 'warn', m.symbols.length ? t('ELF yok; simülasyon için örnek değişkenler gösteriliyor.') : m.error);
    // .embedded-studio/debug.json'daki izleme listesi (ilk yüklemede)
    if (m.watch && dbg.savedWatch === null) {
      dbg.savedWatch = m.watch;
      for (const sv of m.watch) {
        const sym = dbg.symbols.find((x) => x.name === sv.name);
        if (sym && !dbg.watch.some((w) => w.name === sym.name)) dbg.watch.push({ ...sym, fmt: sv.fmt || defaultFmt(sym), graph: !!sv.graph });
      }
      renderWatch();
    }
    const dl = $('mem-syms');
    if (dl) dl.replaceChildren(...dbg.symbols.slice(0, 1000).map((x) => h('option', { value: x.name })));
    renderSymbols();
  });
  ES.on('debug.data', (m) => {
    if (m.seq !== dbg.seq) return;
    dbg.inflight = false;
    dbg.prev = dbg.values;
    dbg.values = { ...dbg.values, ...m.values };
    dbg.state = m.state;
    if (m.core) { dbg.core = m.core.error ? null : m.core; dbg.coreErr = m.core.error || ''; }
    else if (m.state !== 'halted') { dbg.coreErr = ''; }
    const errs = Object.values(m.errors || {});
    if (errs.length) dbg.error = errs[0];
    record(m.values);
    renderBar();
    if (!dbg.edit) renderRegs(); // düzenlerken yeniden çizme (yazılan kaybolmasın)
    renderCore();
    if (dbg.memEdit === null) renderMem();
    if (dbg.watchEdit === null) renderWatch();
    else renderChart();
  });

  // ---------------------------------------------------------------- okuma döngüsü
  function schedule() {
    clearInterval(dbg.timer);
    if (dbg.connected && dbg.auto) dbg.timer = setInterval(() => { if (ui.tab === 'debug') poll(); }, dbg.interval);
  }

  function readsFor() {
    const reads = [];
    const halted = dbg.state === 'halted';
    // Ardışık register'ları tek okumada birleştir; yan etkili ve salt yazılır olanları atla (çalışırken yan etkili olanlar okunmaz).
    const items = shown().filter((x) => x.reg.access !== 'wo' && (halted || !sideEffect({ name: x.periph }, x.reg)))
      .sort((a, b) => (a.periph === b.periph ? a.reg.offset - b.reg.offset : a.periph < b.periph ? -1 : 1));
    let run = null;
    for (const { periph, base, reg } of items) {
      if (run && run.periph === periph && reg.offset === run.end && run.words < 64) { run.words++; run.end += 4; }
      else if (!(run && run.periph === periph && reg.offset < run.end)) { run = { periph, key: `p:${periph}:${reg.offset}`, addr: base + reg.offset, words: 1, end: reg.offset + 4 }; reads.push(run); }
    }
    reads.push({ key: 'mem', addr: dbg.memAddr, words: dbg.memLen / 4 });
    for (const w of dbg.watch) reads.push({ key: `w:${w.name}`, addr: w.addr & ~3, words: Math.min(4, Math.ceil(((w.addr & 3) + Math.max(1, w.size)) / 4)) });
    return reads.map(({ key, addr, words }) => ({ key, addr, words }));
  }

  function poll() {
    if (!dbg.connected || dbg.inflight) return;
    dbg.inflight = true;
    dbg.seq++;
    post({ type: 'debug.read', seq: dbg.seq, reads: readsFor(), core: true });
    setTimeout(() => { dbg.inflight = false; }, 3000); // takılırsa toparla
  }

  /** Bir adresin son okunan 32-bit değeri (birleştirilmiş okumalardan). */
  function wordAt(periph, offset, src = dbg.values) {
    for (const [k, vals] of Object.entries(src)) {
      if (!k.startsWith(`p:${periph}:`)) continue;
      const start = Number(k.split(':')[2]);
      const i = (offset - start) / 4;
      if (i >= 0 && i < vals.length && Number.isInteger(i)) return vals[i];
    }
    return undefined;
  }

  // ---------------------------------------------------------------- çizim
  function renderBar() {
    if (!$('dbg-conn')) return;
    $('dbg-mode').value = dbg.mode;
    $('dbg-mode').disabled = dbg.connected;
    $('dbg-conn').textContent = dbg.connecting ? t('Bağlanıyor…') : dbg.connected ? t('Bağlantıyı kes') : t('Bağlan');
    $('dbg-conn').disabled = dbg.connecting;
    const st = $('dbg-state');
    st.textContent = dbg.connected ? (dbg.state === 'halted' ? t('DURDU') : dbg.state === 'running' ? t('ÇALIŞIYOR') : dbg.state.toUpperCase()) : t('BAĞLI DEĞİL');
    st.className = `badge ${dbg.connected ? (dbg.state === 'halted' ? 'warn' : 'ok') : ''}`;
    for (const id of ['dbg-halt', 'dbg-resume', 'dbg-step', 'dbg-reset']) $(id).disabled = !dbg.connected;
    $('dbg-step').disabled = !dbg.connected || dbg.state !== 'halted';
    const msg = $('dbg-msg');
    msg.className = `dbg-msg${dbg.error ? ' error' : ''}`;
    msg.textContent = dbg.error || (dbg.connected
      ? (dbg.mode === 'sim' ? t('Simülasyon: register değerleri tasarımınızdan (pinler, saat ağacı, çevre birimleri) hesaplanır; Board_Init sonrası beklenen durumu gösterir.') : t('Kart bağlı. Register\'lar çalışırken okunur; DR/SR2 gibi okunması bayrak temizleyen register\'lar sadece hedef durduğunda okunur.'))
      : t('Kart yoksa "Simülasyon" ile deneyin. Gerçek kart için probu (ST-Link, J-Link, CMSIS-DAP) takın ve "OpenOCD" seçin.'));
  }

  function renderPeriphList() {
    const list = $('dbg-plist');
    if (!list) return;
    const match = (p) => !dbg.filter || p.name.includes(dbg.filter) || String(p.group).toUpperCase().includes(dbg.filter);
    const used = dbg.defs.filter((p) => dbg.used.includes(p.name) && match(p));
    const item = (p) => h('div', { class: `p-item${p.name === dbg.periph ? ' active' : ''}`, title: p.desc || '', onclick: () => select(p.name) },
      dbg.used.includes(p.name) ? h('span', { class: 'dot' }) : null, h('span', { text: p.name }), h('span', { class: 'hint', text: hex(p.base) }));
    // SVD grupları (groupName): aramada hepsi açık, değilse tıklayınca açılır
    const groups = new Map();
    for (const p of dbg.defs) if (match(p)) (groups.get(p.group) || groups.set(p.group, []).get(p.group)).push(p);
    const tree = [];
    for (const [g, ps] of [...groups].sort((a, b) => String(a[0]).localeCompare(String(b[0])))) {
      const open = !!dbg.filter || dbg.groups.has(g) || ps.some((p) => p.name === dbg.periph);
      tree.push(h('div', { class: 'p-group tree', onclick: () => { dbg.groups.has(g) ? dbg.groups.delete(g) : dbg.groups.add(g); renderPeriphList(); } },
        h('span', { class: 'tw', text: open ? '▾' : '▸' }), h('span', { text: g }), h('span', { class: 'hint', text: String(ps.length) })));
      if (open) tree.push(...ps.map(item));
    }
    list.replaceChildren(...[
      dbg.favs.length ? h('div', { class: `p-item fav${dbg.periph === FAV ? ' active' : ''}`, onclick: () => select(FAV) }, h('span', { text: `★ ${t('Sabitlenenler')}` }), h('span', { class: 'hint', text: String(dbg.favs.length) })) : null,
      used.length ? h('div', { class: 'p-group', text: t('Projede kullanılan') }) : null, ...used.map(item),
      ...tree].filter(Boolean));
    $('dbg-src').textContent = dbg.source;
  }

  const ACCESS_LABEL = () => ({ ro: t('salt okunur'), wo: t('salt yazılır'), w1: t('bir kez yazılır') });
  const canWrite = (reg, f) => dbg.connected && ((f && f.access) || reg.access || 'rw') !== 'ro';

  /** Değer düzenleyici (satır içi). Enter: yaz, Esc: vazgeç */
  function editor(cur, onSave, f) {
    const done = (v) => { if (!dbg.edit) return; dbg.edit = null; if (v !== undefined) onSave(v); renderRegs(); };
    if (f && f.enums && f.enums.length) {
      return h('select', { class: 'tiny mono', autofocus: true, onchange: (e) => done(Number(e.target.value)), onblur: () => done(), onkeydown: (e) => { if (e.key === 'Escape') done(); } },
        ...(f.enums.some((x) => x.value === cur) ? [] : [h('option', { value: cur, selected: true, text: String(cur) })]),
        ...f.enums.map((x) => h('option', { value: x.value, selected: x.value === cur, text: `${x.value} · ${x.name}` })));
    }
    return h('input', { type: 'text', class: 'tiny mono', value: '0x' + (cur >>> 0).toString(16).toUpperCase(), autofocus: true, 'aria-label': t('Yeni değer'),
      onkeydown: (e) => { if (e.key === 'Enter') done(e.target.value); if (e.key === 'Escape') done(); }, onblur: () => done() });
  }
  function write(periph, reg, field, value) {
    post({ type: 'debug.write', periph, reg: reg.name, field: field ? field.name : undefined, value });
  }
  function focusEditor() {
    requestAnimationFrame(() => { const el = document.querySelector('#dbg-regs input.tiny, #dbg-regs select.tiny[autofocus]'); if (el) { el.focus(); if (el.select) el.select(); } });
  }

  function bitsText(v, f) {
    const val = ((v >>> f.lsb) & (f.width >= 32 ? 0xffffffff : (1 << f.width) - 1)) >>> 0;
    return f.width === 1 ? String(val) : f.width <= 4 ? `0b${val.toString(2).padStart(f.width, '0')} (${val})` : `${val} (0x${val.toString(16).toUpperCase()})`;
  }

  function renderRegs() {
    const box = $('dbg-regs');
    if (!box) return;
    const fav = dbg.periph === FAV;
    const sum = dbg.defs.find((x) => x.name === dbg.periph);
    if (!fav && !sum) { box.replaceChildren(h('div', { class: 'hint pad', text: t('Bağlanınca register tanımları yüklenir.') })); return; }
    if (!fav && !dbg.regs[dbg.periph]) { box.replaceChildren(h('div', { class: 'hint pad', text: t('Yükleniyor…') })); return; }
    if (!dbg.connected) dbg.values = {};
    const halted = dbg.state === 'halted';
    const favKeys = new Set(dbg.favs.map((f) => f.key));
    const AL = ACCESS_LABEL();
    const rows = [];
    for (const { periph, reg: r } of shown()) {
      const id = `${periph}.${r.name}`;
      const v = wordAt(periph, r.offset);
      const pv = wordAt(periph, r.offset, dbg.prev);
      const changed = v !== undefined && pv !== undefined && v !== pv;
      const skipped = !halted && sideEffect({ name: periph }, r);
      const open = dbg.open.has(id);
      const editing = dbg.edit === id;
      const starred = favKeys.has(id);
      const valCell = editing ? editor(v ?? r.reset ?? 0, (x) => write(periph, r, null, x))
        : r.access === 'wo' ? h('span', { class: 'hint', text: t('(salt yazılır)') })
          : skipped ? t('(durdurunca)') : v === undefined ? '—' : hex(v);
      rows.push(h('tr', { class: `reg${changed ? ' changed' : ''}${open ? ' open' : ''}`, onclick: () => { open ? dbg.open.delete(id) : dbg.open.add(id); renderRegs(); } },
        h('td', { class: 'mono' },
          h('button', { class: `star${starred ? ' on' : ''}`, title: starred ? t('Sabitlemeyi kaldır') : t('Sabitle (favori)'), 'aria-label': t('Sabitle (favori)'), onclick: (e) => { e.stopPropagation(); post({ type: 'debug.fav', key: id, on: !starred }); } }, starred ? '★' : '☆'),
          h('span', { class: 'tw', text: r.fields.length ? (open ? '▾' : '▸') : '' }), fav ? `${periph}.${r.name}` : r.name,
          r.access && r.access !== 'rw' ? h('span', { class: 'acc', text: r.access.toUpperCase(), title: AL[r.access] }) : null),
        h('td', { class: 'mono hint', text: `+0x${r.offset.toString(16).toUpperCase().padStart(2, '0')}` }),
        h('td', {
          class: `mono val${canWrite(r) ? ' editable' : ''}`,
          title: skipped ? t('Okuması bayrak temizler; hedef durunca okunur.') : canWrite(r) ? t('Değiştirmek için çift tıklayın') + (r.reset !== undefined ? ` · reset ${hex(r.reset)}` : '') : r.reset !== undefined ? `reset ${hex(r.reset)}` : '',
          onclick: (e) => { if (editing) e.stopPropagation(); },
          ondblclick: (e) => { e.stopPropagation(); if (!canWrite(r)) return; dbg.edit = id; renderRegs(); focusEditor(); }
        }, valCell),
        h('td', { class: 'hint desc', text: r.desc || '' })));
      if (open && (v !== undefined || r.access === 'wo') && !skipped) {
        const word = v ?? r.reset ?? 0;
        const pword = pv;
        for (const f of r.fields) {
          const fv = fieldValue(word, f);
          const fchanged = pword !== undefined && v !== undefined && fieldValue(pword, f) !== fv;
          const en = f.enums && f.enums.find((x) => x.value === fv);
          const fid = `${id}.${f.name}`;
          const fedit = dbg.edit === fid;
          const writable = canWrite(r, f) && r.access !== 'ro';
          let cell;
          if (fedit) cell = editor(fv, (x) => write(periph, r, f, x), f);
          else if (f.width === 1 && writable && !(f.enums && f.enums.length > 2)) {
            cell = h('label', { class: 'check', onclick: (e) => e.stopPropagation() }, h('input', { type: 'checkbox', checked: fv === 1, onchange: (e) => write(periph, r, f, e.target.checked ? 1 : 0) }), h('span', { text: String(fv) + (en ? ` · ${en.name}` : '') }));
          } else cell = bitsText(word, f) + (en ? ` · ${en.name}` : '');
          rows.push(h('tr', { class: `field-row${fchanged ? ' changed' : ''}` },
            h('td', { class: 'mono' }, h('span', { class: `bit${f.width === 1 && fv ? ' on' : ''}` }), f.name,
              f.access && f.access !== r.access && f.access !== 'rw' ? h('span', { class: 'acc', text: f.access.toUpperCase(), title: AL[f.access] }) : null),
            h('td', { class: 'mono hint', text: f.width === 1 ? `[${f.lsb}]` : `[${f.lsb + f.width - 1}:${f.lsb}]` }),
            h('td', {
              class: `mono${writable && f.width > 1 ? ' editable' : ''}`, title: writable && f.width > 1 ? t('Değiştirmek için çift tıklayın') : '',
              ondblclick: () => { if (!writable || f.width === 1 && !(f.enums && f.enums.length > 2)) return; dbg.edit = fid; renderRegs(); focusEditor(); }
            }, cell),
            h('td', { class: 'hint desc', text: en && en.desc ? `${en.desc}${f.desc ? ' — ' + f.desc : ''}` : f.desc || '' })));
        }
      }
    }
    const title = fav ? `★ ${t('Sabitlenenler')}` : sum.name;
    box.replaceChildren(h('div', { class: 'regs-head' }, h('strong', { text: title }), fav ? null : h('span', { class: 'hint mono', text: hex(sum.base) }),
      h('span', { class: 'hint', text: fav ? t('Farklı çevre birimlerinden sabitlenen register\'lar.') : (sum.desc ? sum.desc + ' · ' : '') + t('Satıra tıklayınca bit alanları açılır; değere çift tıklayınca yazılır. Değişen değerler vurgulanır.') })),
    rows.length ? h('table', { class: 'regs' }, h('tr', {}, ...['Register', 'Offset', t('Değer'), t('Açıklama')].map((x) => h('th', { text: x }))), ...rows)
      : h('div', { class: 'hint pad', text: t('Sabitlenen register yok. Register satırındaki ☆ ile ekleyin.') }));
  }
  const fieldValue = (w, f) => ((w >>> f.lsb) & (f.width >= 32 ? 0xffffffff : (1 << f.width) - 1)) >>> 0;

  const CORE = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xPSR'];
  function renderCore() {
    const box = $('dbg-core');
    if (!box) return;
    if (!dbg.connected) { box.replaceChildren(h('div', { class: 'hint pad', text: t('Bağlı değil.') })); return; }
    if (dbg.state !== 'halted' || !dbg.core) {
      box.replaceChildren(h('div', { class: 'hint pad' }, dbg.coreErr || t('Hedef çalışıyor. Core register\'ları görmek için '), h('button', { class: 'small', onclick: () => cmd('halt') }, t('Durdur@@debug'))));
      return;
    }
    const c = dbg.core;
    const x = c.xPSR >>> 0;
    const flags = ['N', 'Z', 'C', 'V'].map((f, i) => h('span', { class: `flag${x & (1 << (31 - i)) ? ' on' : ''}`, text: f }));
    const row = (n, note = '', label = n) => h('tr', {},
      h('td', { class: 'mono', text: label }),
      h('td', { class: 'mono val', text: c[n] === undefined ? '—' : hex(c[n]) }),
      h('td', { class: 'mono hint', text: note }));
    const isr = x & 0x1ff;
    // Özel register'lar (ES-205): yığın işaretçileri, kesme maskeleri, CONTROL
    const special = ['msp', 'psp', 'primask', 'basepri', 'faultmask', 'control'].filter((n) => c[n] !== undefined);
    const ctl = c.control >>> 0;
    const notes = {
      msp: c.sp === c.msp ? t('etkin SP') : '', psp: c.sp === c.psp && c.sp !== c.msp ? t('etkin SP') : '',
      primask: c.primask & 1 ? t('kesmeler kapalı') : '', faultmask: c.faultmask & 1 ? t('fault dışı her şey kapalı') : '',
      basepri: c.basepri ? t('öncelik ≥ {0} maskeli', c.basepri) : '',
      control: [ctl & 1 ? 'nPRIV' : t('ayrıcalıklı'), ctl & 2 ? 'PSP' : 'MSP', ctl & 4 ? 'FPCA' : ''].filter(Boolean).join(' · ')
    };
    const fpu = Object.keys(c).filter((n) => /^s\d+$/.test(n)).sort((a, b) => a.slice(1) - b.slice(1));
    const f32 = (u) => { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, u >>> 0); const f = dv.getFloat32(0); return Number.isFinite(f) ? String(Number(f.toPrecision(7))) : String(f); };
    box.replaceChildren(
      h('table', { class: 'regs core' }, ...CORE.map((n) => row(n, n === 'xPSR' ? (isr ? `${t('istisna')} ${isr}${isr >= 16 ? ` (IRQ ${isr - 16})` : ''}` : 'Thread') : c[n] === undefined ? '' : String(c[n] | 0)))),
      h('div', { class: 'flags' }, h('span', { class: 'hint', text: t('xPSR bayrakları') }), ...flags, h('span', { class: 'hint mono', text: `ISR ${isr}` })),
      special.length ? h('table', { class: 'regs core' }, ...special.map((n) => row(n, notes[n], n.toUpperCase()))) : null,
      fpu.length ? h('div', { class: 'p-group tree', onclick: () => { dbg.fpuOpen = !dbg.fpuOpen; renderCore(); } },
        h('span', { class: 'tw', text: dbg.fpuOpen ? '▾' : '▸' }), h('span', { text: 'FPU' }), h('span', { class: 'hint mono', text: c.fpscr !== undefined ? `FPSCR ${hex(c.fpscr)}` : '' })) : null,
      fpu.length && dbg.fpuOpen ? h('table', { class: 'regs core' }, ...fpu.map((n) => h('tr', {},
        h('td', { class: 'mono', text: n }), h('td', { class: 'mono val', text: hex(c[n]) }), h('td', { class: 'mono hint', text: f32(c[n]) })))) : null);
  }

  function renderSymbols() {
    const list = $('dbg-symlist');
    if (!list) return;
    const q = dbg.symFilter.toLowerCase();
    if (!q) { list.replaceChildren(...(dbg.symbols.length ? [h('div', { class: 'hint pad', text: t('{0} değişken ({1}). Aramak için yazın.', dbg.symbols.length, dbg.symSource || 'ELF') })] : [])); return; }
    const hits = dbg.symbols.filter((sym) => sym.name.toLowerCase().includes(q)).slice(0, 12);
    list.replaceChildren(...hits.map((sym) => h('div', {
      class: 'sym', onclick: () => {
        if (!dbg.watch.some((w) => w.name === sym.name)) dbg.watch.push({ ...sym, fmt: defaultFmt(sym), graph: false });
        dbg.symFilter = '';
        $('dbg-sym').value = '';
        saveWatch();
        renderSymbols();
        renderWatch();
        poll();
      }
    }, h('span', { class: 'mono', text: sym.name }), h('span', { class: 'hint mono', text: `${hex(sym.addr)} · ${sym.size} B` }))));
  }

  // ---------------------------------------------------------------- Live Watch (ES-206)
  const defaultFmt = (sym) => (sym.size === 4 ? 'hex' : 'dec');
  const saveWatch = () => post({ type: 'debug.watch', list: dbg.watch.map((w) => ({ name: w.name, fmt: w.fmt, graph: !!w.graph })) });

  /** Değişkenin baytları (okunan word'lerden, hizasız adres dahil) */
  function watchBytes(w, words) {
    const bytes = [];
    for (const v of words) for (let i = 0; i < 4; i++) bytes.push((v >>> (8 * i)) & 0xff);
    return bytes.slice(w.addr & 3, (w.addr & 3) + Math.max(1, w.size));
  }
  /** Sayısal değer (≤ 4 bayt; biçime göre işaretli / float) */
  function numeric(w, words) {
    const b = watchBytes(w, words);
    if (w.size > 4) return undefined;
    const n = Math.min(4, b.length);
    let u = 0;
    for (let i = n - 1; i >= 0; i--) u = u * 256 + b[i];
    if (w.fmt === 'float' && n === 4) { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, u, false); return dv.getFloat32(0); }
    if (w.fmt === 'sdec') return n === 1 ? (u << 24) >> 24 : n === 2 ? (u << 16) >> 16 : u | 0;
    return u >>> 0;
  }
  function decode(w, words) {
    if (w.size > 4) {
      const b = watchBytes(w, words);
      return b.slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join(' ') + (w.size > 16 ? ' …' : '');
    }
    const v = numeric(w, words);
    if (w.fmt === 'hex') return hex(v, Math.min(4, Math.max(1, w.size)) * 2);
    if (w.fmt === 'float') return Number.isFinite(v) ? String(Number(v.toPrecision(7))) : String(v);
    return String(v);
  }
  /** Girilen değeri değişkenin ham bitlerine çevirir (float, negatif sayı, 0x / 0b) */
  function encode(w, text) {
    const s = String(text).trim();
    if (w.fmt === 'float') {
      const f = Number(s);
      if (!Number.isFinite(f)) return undefined;
      const dv = new DataView(new ArrayBuffer(4)); dv.setFloat32(0, f); return dv.getUint32(0);
    }
    const v = /^-?0x[0-9a-f]+$/i.test(s) ? parseInt(s, 16) : /^0b[01]+$/i.test(s) ? parseInt(s.slice(2), 2) : /^-?\d+$/.test(s) ? Number(s) : NaN;
    if (!Number.isFinite(v)) return undefined;
    const bits = w.size * 8;
    if (v < -(2 ** (bits - 1)) || v >= 2 ** bits) return undefined;
    return v < 0 ? (v + 2 ** bits) >>> 0 : v;
  }
  /** Her okumada grafiği açık değişkenlerin geçmişi (son 60 sn) */
  function record(values) {
    const now = Date.now();
    for (const w of dbg.watch) {
      const words = values[`w:${w.name}`];
      if (!words || w.size > 4) continue;
      const v = numeric(w, words);
      const hs = (dbg.hist[w.name] = dbg.hist[w.name] || []);
      hs.push({ t: now, v });
      while (hs.length && now - hs[0].t > 60000) hs.shift();
    }
  }

  function renderWatch() {
    const box = $('dbg-watch');
    if (!box) return;
    if (!dbg.watch.length) { box.replaceChildren(h('div', { class: 'hint pad', text: t('İzlenen değişken yok.') })); renderChart(); return; }
    const writable = (w) => dbg.connected && [1, 2, 4].includes(w.size) && w.addr >= 0x20000000;
    box.replaceChildren(h('table', { class: 'regs watch' }, ...dbg.watch.map((w, i) => {
      const words = dbg.values[`w:${w.name}`];
      const editing = dbg.watchEdit === w.name;
      const done = (text) => {
        if (dbg.watchEdit === null) return;
        dbg.watchEdit = null;
        if (text !== undefined) {
          const raw = encode(w, text);
          if (raw === undefined) toast('warn', t('{0} için geçersiz değer: {1}', w.name, text));
          else post({ type: 'debug.memwrite', addr: w.addr, width: w.size * 8, value: raw });
        }
        renderWatch();
      };
      const cell = editing
        ? h('input', { type: 'text', class: 'tiny mono', value: words ? decode(w, words) : '0', autofocus: true, 'aria-label': t('Yeni değer'), onkeydown: (e) => { if (e.key === 'Enter') done(e.target.value); if (e.key === 'Escape') done(); }, onblur: () => done() })
        : words ? decode(w, words) : '—';
      return h('tr', {},
        h('td', { class: 'mono', title: `${hex(w.addr)} · ${w.size} B`, text: w.name }),
        h('td', {
          class: `mono val${writable(w) ? ' editable' : ''}`, title: writable(w) ? t('Değiştirmek için çift tıklayın') : '',
          ondblclick: () => { if (!writable(w)) return; dbg.watchEdit = w.name; renderWatch(); requestAnimationFrame(() => { const el = document.querySelector('#dbg-watch input.tiny'); if (el) { el.focus(); el.select(); } }); }
        }, cell),
        h('td', {}, w.size <= 4 ? h('select', { class: 'tiny', 'aria-label': t('Biçim'), onchange: (e) => { w.fmt = e.target.value; dbg.hist[w.name] = []; saveWatch(); renderWatch(); } },
          ...[['dec', 'u'], ['sdec', 'i'], ['hex', 'hex'], ['float', 'f32']].filter(([k]) => k !== 'float' || w.size === 4).map(([k, l]) => h('option', { value: k, selected: w.fmt === k, text: l }))) : null),
        h('td', {}, w.size <= 4 ? h('button', { class: `icon tiny graph${w.graph ? ' on' : ''}`, title: t('Zaman grafiğinde göster'), 'aria-label': t('Zaman grafiğinde göster'), 'aria-pressed': w.graph ? 'true' : 'false', onclick: () => { w.graph = !w.graph; saveWatch(); renderWatch(); } }, icon('chart', 12)) : null),
        h('td', {}, h('button', { class: 'icon tiny', title: t('Kaldır'), onclick: () => { dbg.watch.splice(i, 1); delete dbg.hist[w.name]; saveWatch(); renderWatch(); } }, icon('close', 11))));
    })),
    dbg.connected ? h('div', { class: 'hint pad', text: t('Live Watch: değerler hedef durdurulmadan {0} ms\'de bir okunur.', dbg.interval) }) : null);
    renderChart();
  }

  /**
   * Grafiği açık değişkenlerin zaman grafiği (monitördeki çizgi grafik bileşeni).
   * Ölçekleri çok farklı olabilir (ör. sıcaklık ve ADC ham değeri): her değişkene ayrı grafik.
   */
  function renderChart() {
    const box = $('dbg-wchart');
    if (!box) return;
    const names = dbg.watch.filter((w) => w.graph && w.size <= 4).map((w) => w.name);
    const key = names.join('|');
    if (!names.length) { box.replaceChildren(); dbg.charts = []; dbg.chartKey = ''; return; }
    if (dbg.chartKey !== key || !dbg.charts.length || !box.contains(dbg.charts[0].el)) {
      const ctx = {
        series: (n) => dbg.hist[n] || [],
        last: (n) => { const hs = dbg.hist[n]; return hs && hs.length ? hs[hs.length - 1].v : undefined; },
        unit: () => '', short: (n) => n, post
      };
      dbg.charts = names.map((n) => ES.widgets.types.chart.create({ type: 'chart', channels: [n] }, ctx));
      dbg.chartKey = key;
      box.replaceChildren(...dbg.charts.map((c) => c.el));
    }
    for (const c of dbg.charts) c.update();
  }

  // ---------------------------------------------------------------- bellek görüntüleyici (ES-206)
  /** "0x20000000", "20000000", "sembol", "sembol+0x10" → { addr, size } */
  function resolveAddr(text) {
    const s = String(text).trim();
    const m = /^([A-Za-z_][\w.$]*)\s*(?:([+-])\s*(0x[0-9a-f]+|\d+))?$/i.exec(s);
    const sym = m && dbg.symbols.find((x) => x.name === m[1]);
    if (sym) {
      const off = m[3] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : 0;
      return { addr: (sym.addr + off) >>> 0, size: off ? 0 : sym.size, name: sym.name };
    }
    if (!/^(0x)?[0-9a-f]{1,8}$/i.test(s)) return null;
    return { addr: parseInt(s.replace(/^0x/i, ''), 16) >>> 0, size: 0 };
  }
  function setMem(a) {
    dbg.memAddr = (a >>> 0) & ~0xf;
    $('mem-addr').value = hex(dbg.memAddr);
    dbg.memEdit = null;
    delete dbg.values.mem;
    delete dbg.prev.mem;
    renderMem();
    poll();
  }
  function goMem() {
    const r = resolveAddr($('mem-addr').value);
    if (!r) return toast('warn', t('Geçerli bir onaltılık adres ya da değişken adı girin (ör. 0x20000000, uwTick).'));
    dbg.memMark = { addr: r.addr, size: Math.max(1, r.size || dbg.memWidth) };
    setMem(r.addr);
    $('mem-addr').value = r.name || hex(r.addr);
  }
  function saveMem() {
    if (!dbg.connected) return toast('warn', t('Önce hedefe bağlanın.'));
    const start = h('input', { type: 'text', class: 'mono', list: 'mem-syms', value: dbg.memMark ? hex(dbg.memMark.addr) : hex(dbg.memAddr), 'aria-label': t('Başlangıç') });
    const len = h('input', { type: 'text', class: 'mono', value: String(dbg.memMark && dbg.memMark.size > 1 ? dbg.memMark.size : dbg.memLen), 'aria-label': t('Uzunluk (bayt)') });
    modal({
      title: t('Bellek bölgesini kaydet'), width: 380,
      body: h('div', {},
        h('div', { class: 'field' }, h('label', { text: t('Başlangıç (adres ya da sembol)') }), start),
        h('div', { class: 'field' }, h('label', { text: t('Uzunluk (bayt; 0x da olur)') }), len),
        h('p', { class: 'hint', text: t('.bin ham bayt, .hex Intel HEX olarak kaydedilir. En fazla 1 MB.') })),
      buttons: [
        { label: t('Vazgeç') },
        {
          label: t('Kaydet…'), primary: true, id: 'mem-save-ok', action: () => {
            const r = resolveAddr(start.value);
            const n = /^0x/i.test(len.value.trim()) ? parseInt(len.value.trim(), 16) : Number(len.value.trim());
            if (!r || !(n > 0 && n <= 1 << 20)) { toast('warn', t('Adres ya da uzunluk geçersiz.')); return false; }
            post({ type: 'debug.memsave', addr: r.addr, length: n });
          }
        }]
    });
  }
  /** Gösterilen bölgenin bilgisi: bellek türü ve uyarı */
  function regionNote(a) {
    if (a < 0x20000000) return t('Flash / kod bölgesi: salt okunur (değiştirmek için programı yükleyin).');
    if (a >= 0x40000000 && a < 0x60000000) return t('Çevre birimi bölgesi: bazı register\'ları okumak bayrak temizleyebilir.');
    if (a >= 0xe0000000) return t('Çekirdek (sistem) bölgesi.');
    return t('RAM: değere çift tıklayarak yazabilirsiniz.');
  }
  function renderMem() {
    const box = $('dbg-mem');
    if (!box) return;
    const W = dbg.memWidth;
    const info = $('mem-info');
    if (info) info.textContent = `${hex(dbg.memAddr)} – ${hex(dbg.memAddr + dbg.memLen - 1)} · ${regionNote(dbg.memAddr)}`;
    const words = dbg.values.mem;
    if (!words) { box.replaceChildren(h('div', { class: 'hint pad', text: dbg.connected ? t('Okunuyor…') : t('Bağlı değil.') })); return; }
    const bytes = words.flatMap((v) => [0, 1, 2, 3].map((i) => (v >>> (8 * i)) & 0xff));
    const pw = dbg.prev.mem;
    const prev = pw ? pw.flatMap((v) => [0, 1, 2, 3].map((i) => (v >>> (8 * i)) & 0xff)) : null;
    const base = dbg.memAddr, end = base + bytes.length;
    const syms = dbg.symbols.filter((x) => x.addr < end && x.addr + Math.max(1, x.size) > base);
    const symAt = (a) => { const x = syms.find((y) => a >= y.addr && a < y.addr + Math.max(1, y.size)); return x ? `${x.name}${a > x.addr ? '+' + (a - x.addr) : ''}` : ''; };
    const mark = dbg.memMark;
    const editable = dbg.connected && base >= 0x20000000;
    const rows = [];
    // Dar sütunda satır başına 8 bayt (16 bayt sığmayınca satırlar kırılıyordu)
    const N = box.clientWidth && box.clientWidth < 470 ? 8 : 16;
    for (let r = 0; r < bytes.length / N; r++) {
      const cells = [];
      for (let c = 0; c < N; c += W) {
        const off = r * N + c, a = base + off;
        let v = 0;
        for (let k = W - 1; k >= 0; k--) v = v * 256 + bytes[off + k];
        const changed = prev && [...Array(W).keys()].some((k) => prev[off + k] !== bytes[off + k]);
        const marked = mark && a < mark.addr + mark.size && a + W > mark.addr;
        const sym = symAt(a);
        if (dbg.memEdit === off) {
          const done = (text) => {
            if (dbg.memEdit === null) return;
            dbg.memEdit = null;
            if (text !== undefined) {
              const s = String(text).trim();
              // Hex görünümde önek yoksa onaltılık kabul edilir
              post({ type: 'debug.memwrite', addr: a, width: W * 8, value: /^[0-9a-f]+$/i.test(s) ? '0x' + s : s });
            }
            renderMem();
          };
          cells.push(h('input', { type: 'text', class: 'tiny mono mem-edit', value: v.toString(16).toUpperCase().padStart(W * 2, '0'), size: W * 2 + 2, autofocus: true, 'aria-label': t('Yeni değer'),
            onkeydown: (e) => { if (e.key === 'Enter') done(e.target.value); if (e.key === 'Escape') done(); }, onblur: () => done() }));
          continue;
        }
        cells.push(h('span', {
          class: `mc${changed ? ' changed' : ''}${marked ? ' mark' : ''}${sym ? ' sym-byte' : ''}${editable ? ' editable' : ''}`,
          title: `${hex(a)}${sym ? ' · ' + sym : ''}${W > 1 ? ` · ${v >>> 0}` : ''}`,
          ondblclick: () => {
            if (!editable) return;
            dbg.memEdit = off;
            renderMem();
            requestAnimationFrame(() => { const el = document.querySelector('#dbg-mem input.mem-edit'); if (el) { el.focus(); el.select(); } });
          }
        }, v.toString(16).padStart(W * 2, '0')));
      }
      const rb = bytes.slice(r * N, r * N + N);
      rows.push(h('div', { class: 'mem-row' },
        h('span', { class: 'hint', text: hex(base + r * N) }),
        h('span', { class: 'cells' }, ...cells),
        h('span', { class: 'ascii', text: rb.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') })));
    }
    box.replaceChildren(...rows);
  }

  ES.tabs.debug = {
    mount,
    render() { renderBar(); renderPeriphList(); renderRegs(); renderCore(); renderMem(); renderWatch(); },
    onShow() { this.render(); if (dbg.connected) poll(); }
  };
})();
