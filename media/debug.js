/* Debug sekmesi: bağlantı (simülasyon / OpenOCD + ST-Link), çalıştırma kontrolü,
 * core register'lar, çevre birimi register'ları (bit alanlarıyla), değişken izleme, bellek. */
(function () {
  const { h, $, post, state, ui, icon, hex, toast } = ES;
  const dbg = {
    connected: false, connecting: false, mode: 'sim', state: '', error: '',
    defs: [], used: [], source: '',
    periph: null, open: new Set(), filter: '',
    values: {}, prev: {}, core: null, coreErr: '',
    memAddr: 0x20000000, mem: null,
    symbols: [], symSource: '', watch: [], symFilter: '',
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
        h('select', { id: 'dbg-mode', 'aria-label': 'Bağlantı türü', onchange: (e) => (dbg.mode = e.target.value) },
          h('option', { value: 'sim', text: 'Simülasyon (kart yok)' }),
          h('option', { value: 'openocd', text: 'OpenOCD · ST-Link' })),
        h('button', { id: 'dbg-conn', onclick: () => (dbg.connected ? post({ type: 'debug.disconnect' }) : connect()) }, 'Bağlan'),
        h('span', { id: 'dbg-state', class: 'badge' }),
        h('span', { class: 'sep' }),
        h('button', { class: 'ghost small', id: 'dbg-halt', title: 'Durdur (halt)', onclick: () => cmd('halt') }, icon('pause', 12), 'Durdur'),
        h('button', { class: 'ghost small', id: 'dbg-resume', title: 'Devam et', onclick: () => cmd('resume') }, icon('play', 12), 'Devam'),
        h('button', { class: 'ghost small', id: 'dbg-step', title: 'Tek komut adım', onclick: () => cmd('step') }, icon('step', 12), 'Adım'),
        h('button', { class: 'ghost small', id: 'dbg-reset', title: 'Reset', onclick: () => cmd('reset') }, icon('reset', 12), 'Reset'),
        h('span', { class: 'sep' }),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: dbg.auto, onchange: (e) => { dbg.auto = e.target.checked; schedule(); } }), h('span', { text: 'Canlı' })),
        h('select', { 'aria-label': 'Yenileme aralığı', onchange: (e) => { dbg.interval = Number(e.target.value); schedule(); } },
          ...[[250, '250 ms'], [500, '500 ms'], [1000, '1 sn']].map(([v, l]) => h('option', { value: v, selected: v === dbg.interval, text: l }))),
        h('span', { class: 'spacer' }),
        h('button', { class: 'ghost small', onclick: () => post({ type: 'build' }) }, 'Derle'),
        h('button', { class: 'small', onclick: () => post({ type: 'flash' }) }, 'Yükle')),
      h('div', { class: 'dbg-msg', id: 'dbg-msg' }),
      h('div', { class: 'dbg-grid' },
        h('section', { class: 'dbg-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: 'Core register\'lar' })),
          h('div', { id: 'dbg-core' }),
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: 'Değişkenler (izleme)' }), h('button', { class: 'ghost small', onclick: () => post({ type: 'debug.symbols' }) }, 'ELF\'ten yükle')),
          h('div', { class: 'search' }, icon('search', 13), h('input', { type: 'text', id: 'dbg-sym', placeholder: 'Değişken ara ve ekle…', oninput: (e) => { dbg.symFilter = e.target.value; renderSymbols(); } })),
          h('div', { id: 'dbg-symlist', class: 'symlist' }),
          h('div', { id: 'dbg-watch' })),
        h('section', { class: 'dbg-col wide' },
          h('div', { class: 'pane-head' },
            h('span', { class: 'pane-title', text: 'Çevre birimi register\'ları' }),
            h('span', { class: 'hint', id: 'dbg-src' }),
            h('span', { class: 'spacer' }),
            h('button', { class: 'ghost small', title: 'Tam CMSIS-SVD tanımını indir', onclick: () => post({ type: 'debug.svd' }) }, 'SVD indir')),
          h('div', { class: 'periph-split' },
            h('div', { class: 'periph-list' },
              h('div', { class: 'search' }, icon('search', 13), h('input', { type: 'text', placeholder: 'Çevre birimi…', oninput: (e) => { dbg.filter = e.target.value.toUpperCase(); renderPeriphList(); } })),
              h('div', { id: 'dbg-plist' })),
            h('div', { class: 'periph-regs', id: 'dbg-regs' }))),
        h('section', { class: 'dbg-col' },
          h('div', { class: 'pane-head' }, h('span', { class: 'pane-title', text: 'Bellek' })),
          h('div', { class: 'mem-bar' },
            h('input', { type: 'text', id: 'mem-addr', class: 'mono', value: hex(dbg.memAddr), 'aria-label': 'Adres', onkeydown: (e) => { if (e.key === 'Enter') goMem(); } }),
            h('button', { class: 'small', onclick: goMem }, 'Git'),
            h('button', { class: 'ghost small', onclick: () => setMem(0x20000000) }, 'SRAM'),
            h('button', { class: 'ghost small', onclick: () => setMem(0x08000000) }, 'Flash')),
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
  });
  ES.on('debug.regs', (m) => {
    dbg.defs = m.peripherals;
    dbg.used = m.used;
    dbg.source = m.source;
    if (!dbg.periph || !dbg.defs.find((p) => p.name === dbg.periph)) dbg.periph = dbg.defs.find((p) => dbg.used.includes(p.name))?.name || dbg.defs[0]?.name;
    renderPeriphList();
    renderRegs();
  });
  ES.on('debug.symbols', (m) => {
    dbg.symbols = m.symbols;
    dbg.symSource = m.source || '';
    if (m.error) toast(m.symbols.length ? 'info' : 'warn', m.symbols.length ? `ELF yok; simülasyon için örnek değişkenler gösteriliyor.` : m.error);
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
    renderBar();
    renderRegs();
    renderCore();
    renderMem();
    renderWatch();
  });

  // ---------------------------------------------------------------- okuma döngüsü
  function schedule() {
    clearInterval(dbg.timer);
    if (dbg.connected && dbg.auto) dbg.timer = setInterval(() => { if (ui.tab === 'debug') poll(); }, dbg.interval);
  }

  function readsFor() {
    const reads = [];
    const halted = dbg.state === 'halted';
    const p = dbg.defs.find((x) => x.name === dbg.periph);
    if (p) {
      // Ardışık register'ları tek okumada birleştir; yan etkili olanları çalışırken atla.
      const regs = p.registers.filter((r) => halted || !sideEffect(p, r)).sort((a, b) => a.offset - b.offset);
      let run = null;
      for (const r of regs) {
        if (run && r.offset === run.end && run.words < 64) { run.words++; run.end += 4; }
        else { run = { key: `p:${p.name}:${r.offset}`, addr: p.base + r.offset, words: 1, end: r.offset + 4 }; reads.push(run); }
      }
    }
    reads.push({ key: 'mem', addr: dbg.memAddr, words: 64 });
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
      if (!k.startsWith(`p:${periph.name}:`)) continue;
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
    $('dbg-conn').textContent = dbg.connecting ? 'Bağlanıyor…' : dbg.connected ? 'Bağlantıyı kes' : 'Bağlan';
    $('dbg-conn').disabled = dbg.connecting;
    const st = $('dbg-state');
    st.textContent = dbg.connected ? (dbg.state === 'halted' ? 'DURDU' : dbg.state === 'running' ? 'ÇALIŞIYOR' : dbg.state.toUpperCase()) : 'BAĞLI DEĞİL';
    st.className = `badge ${dbg.connected ? (dbg.state === 'halted' ? 'warn' : 'ok') : ''}`;
    for (const id of ['dbg-halt', 'dbg-resume', 'dbg-step', 'dbg-reset']) $(id).disabled = !dbg.connected;
    $('dbg-step').disabled = !dbg.connected || dbg.state !== 'halted';
    const msg = $('dbg-msg');
    msg.className = `dbg-msg${dbg.error ? ' error' : ''}`;
    msg.textContent = dbg.error || (dbg.connected
      ? (dbg.mode === 'sim' ? 'Simülasyon: register değerleri tasarımınızdan (pinler, saat ağacı, çevre birimleri) hesaplanır; Board_Init sonrası beklenen durumu gösterir.' : 'Kart bağlı. Register\'lar çalışırken okunur; DR/SR2 gibi okunması bayrak temizleyen register\'lar sadece hedef durduğunda okunur.')
      : 'Kart yoksa "Simülasyon" ile deneyin. Gerçek kart için ST-Link\'i takın ve "OpenOCD · ST-Link" seçin.');
  }

  function renderPeriphList() {
    const list = $('dbg-plist');
    if (!list) return;
    const match = (p) => !dbg.filter || p.name.includes(dbg.filter);
    const used = dbg.defs.filter((p) => dbg.used.includes(p.name) && match(p));
    const rest = dbg.defs.filter((p) => !dbg.used.includes(p.name) && match(p));
    const item = (p) => h('div', { class: `p-item${p.name === dbg.periph ? ' active' : ''}`, onclick: () => { dbg.periph = p.name; dbg.open.clear(); renderPeriphList(); renderRegs(); poll(); } },
      dbg.used.includes(p.name) ? h('span', { class: 'dot' }) : null, h('span', { text: p.name }), h('span', { class: 'hint', text: hex(p.base) }));
    list.replaceChildren(...[
      used.length ? h('div', { class: 'p-group', text: 'Projede kullanılan' }) : null, ...used.map(item),
      rest.length ? h('div', { class: 'p-group', text: 'Diğer' }) : null, ...rest.map(item)].filter(Boolean));
    $('dbg-src').textContent = dbg.source;
  }

  function bitsText(v, f) {
    const val = ((v >>> f.lsb) & (f.width >= 32 ? 0xffffffff : (1 << f.width) - 1)) >>> 0;
    return f.width === 1 ? String(val) : f.width <= 4 ? `0b${val.toString(2).padStart(f.width, '0')} (${val})` : `${val} (0x${val.toString(16).toUpperCase()})`;
  }

  function renderRegs() {
    const box = $('dbg-regs');
    if (!box) return;
    const p = dbg.defs.find((x) => x.name === dbg.periph);
    if (!p) { box.replaceChildren(h('div', { class: 'hint pad', text: 'Bağlanınca register tanımları yüklenir.' })); return; }
    if (!dbg.connected) dbg.values = {};
    const halted = dbg.state === 'halted';
    const rows = [];
    for (const r of p.registers) {
      const v = wordAt(p, r.offset);
      const pv = wordAt(p, r.offset, dbg.prev);
      const changed = v !== undefined && pv !== undefined && v !== pv;
      const skipped = !halted && sideEffect(p, r);
      const open = dbg.open.has(r.name);
      rows.push(h('tr', { class: `reg${changed ? ' changed' : ''}${open ? ' open' : ''}`, onclick: () => { open ? dbg.open.delete(r.name) : dbg.open.add(r.name); renderRegs(); } },
        h('td', { class: 'mono' }, h('span', { class: 'tw', text: r.fields.length ? (open ? '▾' : '▸') : '' }), r.name),
        h('td', { class: 'mono hint', text: `+0x${r.offset.toString(16).toUpperCase().padStart(2, '0')}` }),
        h('td', { class: 'mono val', title: skipped ? 'Okuması bayrak temizler; hedef durunca okunur.' : '', text: skipped ? '(durdurunca)' : v === undefined ? '—' : hex(v) }),
        h('td', { class: 'hint desc', text: r.desc || '' })));
      if (open && v !== undefined && !skipped) {
        for (const f of r.fields) {
          const set = ((v >>> f.lsb) & ((1 << Math.min(f.width, 31)) - 1)) !== 0;
          rows.push(h('tr', { class: 'field-row' },
            h('td', { class: 'mono' }, h('span', { class: `bit${f.width === 1 && set ? ' on' : ''}` }), f.name),
            h('td', { class: 'mono hint', text: f.width === 1 ? `[${f.lsb}]` : `[${f.lsb + f.width - 1}:${f.lsb}]` }),
            h('td', { class: 'mono', text: bitsText(v, f) }),
            h('td', { class: 'hint desc', text: f.desc || '' })));
        }
      }
    }
    box.replaceChildren(h('div', { class: 'regs-head' }, h('strong', { text: p.name }), h('span', { class: 'hint mono', text: hex(p.base) }), h('span', { class: 'hint', text: 'Satıra tıklayınca bit alanları açılır. Değişen değerler vurgulanır.' })),
      h('table', { class: 'regs' }, h('tr', {}, ...['Register', 'Offset', 'Değer', 'Açıklama'].map((t) => h('th', { text: t }))), ...rows));
  }

  const CORE = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xPSR'];
  function renderCore() {
    const box = $('dbg-core');
    if (!box) return;
    if (!dbg.connected) { box.replaceChildren(h('div', { class: 'hint pad', text: 'Bağlı değil.' })); return; }
    if (dbg.state !== 'halted' || !dbg.core) {
      box.replaceChildren(h('div', { class: 'hint pad' }, dbg.coreErr || 'Hedef çalışıyor. Core register\'ları görmek için ', h('button', { class: 'small', onclick: () => cmd('halt') }, 'Durdur')));
      return;
    }
    const x = dbg.core.xPSR >>> 0;
    const flags = ['N', 'Z', 'C', 'V'].map((f, i) => h('span', { class: `flag${x & (1 << (31 - i)) ? ' on' : ''}`, text: f }));
    box.replaceChildren(h('table', { class: 'regs core' }, ...CORE.map((n) => h('tr', {},
      h('td', { class: 'mono', text: n }),
      h('td', { class: 'mono val', text: dbg.core[n] === undefined ? '—' : hex(dbg.core[n]) }),
      h('td', { class: 'mono hint', text: n === 'xPSR' ? '' : dbg.core[n] === undefined ? '' : String(dbg.core[n] | 0) })))),
    h('div', { class: 'flags' }, h('span', { class: 'hint', text: 'xPSR bayrakları' }), ...flags, h('span', { class: 'hint mono', text: `ISR ${x & 0x1ff}` })));
  }

  function renderSymbols() {
    const list = $('dbg-symlist');
    if (!list) return;
    const q = dbg.symFilter.toLowerCase();
    if (!q) { list.replaceChildren(...(dbg.symbols.length ? [h('div', { class: 'hint pad', text: `${dbg.symbols.length} değişken (${dbg.symSource || 'ELF'}). Aramak için yazın.` })] : [])); return; }
    const hits = dbg.symbols.filter((sym) => sym.name.toLowerCase().includes(q)).slice(0, 12);
    list.replaceChildren(...hits.map((sym) => h('div', {
      class: 'sym', onclick: () => {
        if (!dbg.watch.some((w) => w.name === sym.name)) dbg.watch.push({ ...sym, fmt: sym.size === 4 ? 'hex' : 'dec' });
        dbg.symFilter = '';
        $('dbg-sym').value = '';
        renderSymbols();
        renderWatch();
        poll();
      }
    }, h('span', { class: 'mono', text: sym.name }), h('span', { class: 'hint mono', text: `${hex(sym.addr)} · ${sym.size} B` }))));
  }

  function decode(w, words) {
    const bytes = [];
    for (const v of words) for (let i = 0; i < 4; i++) bytes.push((v >>> (8 * i)) & 0xff);
    const b = bytes.slice(w.addr & 3, (w.addr & 3) + Math.max(1, w.size));
    const n = Math.min(4, b.length);
    let u = 0;
    for (let i = n - 1; i >= 0; i--) u = u * 256 + b[i];
    if (w.size > 4) return b.slice(0, 16).map((x) => x.toString(16).padStart(2, '0')).join(' ') + (w.size > 16 ? ' …' : '');
    if (w.fmt === 'hex') return hex(u, n * 2);
    if (w.fmt === 'float' && n === 4) { const dv = new DataView(new ArrayBuffer(4)); dv.setUint32(0, u, false); return dv.getFloat32(0).toPrecision(7); }
    if (w.fmt === 'sdec') return String(n === 1 ? (u << 24) >> 24 : n === 2 ? (u << 16) >> 16 : u | 0);
    return String(u >>> 0);
  }

  function renderWatch() {
    const box = $('dbg-watch');
    if (!box) return;
    if (!dbg.watch.length) { box.replaceChildren(h('div', { class: 'hint pad', text: 'İzlenen değişken yok.' })); return; }
    box.replaceChildren(h('table', { class: 'regs' }, ...dbg.watch.map((w, i) => {
      const words = dbg.values[`w:${w.name}`];
      return h('tr', {},
        h('td', { class: 'mono', title: hex(w.addr), text: w.name }),
        h('td', { class: 'mono val', text: words ? decode(w, words) : '—' }),
        h('td', {}, w.size <= 4 ? h('select', { class: 'tiny', onchange: (e) => { w.fmt = e.target.value; renderWatch(); } },
          ...[['dec', 'u'], ['sdec', 'i'], ['hex', 'hex'], ['float', 'f32']].filter(([k]) => k !== 'float' || w.size === 4).map(([k, l]) => h('option', { value: k, selected: w.fmt === k, text: l }))) : null),
        h('td', {}, h('button', { class: 'icon tiny', title: 'Kaldır', onclick: () => { dbg.watch.splice(i, 1); renderWatch(); } }, icon('close', 11))));
    })));
  }

  function setMem(a) {
    dbg.memAddr = a >>> 0;
    $('mem-addr').value = hex(dbg.memAddr);
    dbg.mem = null;
    poll();
  }
  function goMem() {
    const v = parseInt($('mem-addr').value.replace(/^0x/i, ''), 16);
    if (Number.isNaN(v)) return toast('warn', 'Geçerli bir onaltılık adres girin (ör. 0x20000000).');
    setMem(v & ~3);
  }
  function renderMem() {
    const box = $('dbg-mem');
    if (!box) return;
    const words = dbg.values.mem;
    if (!words) { box.replaceChildren(h('div', { class: 'hint pad', text: dbg.connected ? 'Okunuyor…' : 'Bağlı değil.' })); return; }
    const rows = [];
    for (let r = 0; r < words.length / 4; r++) {
      const ws = words.slice(r * 4, r * 4 + 4);
      const bytes = ws.flatMap((v) => [0, 1, 2, 3].map((i) => (v >>> (8 * i)) & 0xff));
      rows.push(h('div', { class: 'mem-row' },
        h('span', { class: 'hint', text: hex(dbg.memAddr + r * 16) }),
        h('span', { text: bytes.map((b) => b.toString(16).padStart(2, '0')).join(' ') }),
        h('span', { class: 'ascii', text: bytes.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('') })));
    }
    box.replaceChildren(...rows);
  }

  ES.tabs.debug = {
    mount,
    render() { renderBar(); renderPeriphList(); renderRegs(); renderCore(); renderMem(); renderWatch(); },
    onShow() { this.render(); if (dbg.connected) poll(); }
  };
})();
