/* Seri port terminali sekmesi (ES-211): birden fazla port (oturum sekmeleri), port ayarları, ASCII / HEX / karışık görünüm,
 * zaman damgası, satır sonu, arama, gönderme kutusu (geçmiş, tekrar, HEX), makro düğmeleri, log dosyası. */
(function () {
  const { t, h, $, post, ui, toast, modal } = ES;
  const MAX_LINES = 20000, MAX_ROWS = 2000, MAX_LINE = 1024;
  const BAUDS = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
  const T = { sessions: [], active: '', ports: [], config: null, platform: '', poll: 0, seq: 0, editMacros: false };

  const newSession = () => {
    const last = (T.config && T.config.last) || {};
    const used = new Set(T.sessions.map((s) => s.path));
    const pick = T.ports.find((p) => p.vcp && !used.has(p.path)) || T.ports.find((p) => !p.sim && !used.has(p.path)) || T.ports.find((p) => p.sim);
    return {
      id: `s${++T.seq}`, path: last.path && !used.has(last.path) && T.ports.some((p) => p.path === last.path) ? last.path : pick ? pick.path : 'SIM',
      baud: last.baud || 115200, dataBits: last.dataBits || 8, parity: last.parity || 'none', stopBits: last.stopBits || '1', flow: last.flow || 'none',
      dtr: true, rts: true, open: false, opening: false, error: '', view: 'ascii', time: true, echo: true, rxNl: 'lf', eol: '\r\n', hexIn: false,
      lines: [], rx: 0, tx: 0, lastCR: false, logging: '', search: '', hit: -1, history: [], histAt: -1, input: '', repeat: false, repeatMs: 1000, repeatTimer: 0,
      autoscroll: true, start: 0, rows: [], dirty: true, full: true
    };
  };
  /** replaceChildren null'ı "null" metni yapar: boş parçalar atılır */
  const put = (box, ...parts) => box.replaceChildren(...parts.filter((x) => x !== null && x !== undefined && x !== false));
  const cur = () => T.sessions.find((s) => s.id === T.active);
  const byId = (id) => T.sessions.find((s) => s.id === id);

  function mount(parent) {
    parent.append(h('main', { id: 'terminal', class: 'tab-pane' },
      h('div', { class: 'term-tabs', id: 'term-tabs', role: 'tablist' }),
      h('div', { class: 'term-bar', id: 'term-bar' }),
      h('div', { class: 'term-tools', id: 'term-tools' }),
      h('div', { class: 'term-out', id: 'term-out', tabindex: '0', role: 'log', 'aria-live': 'off', onscroll: onScroll }),
      h('div', { class: 'term-status', id: 'term-status' }),
      h('div', { class: 'term-macros', id: 'term-macros' }),
      h('div', { class: 'term-send', id: 'term-send' })));
  }

  // ---------------------------------------------------------------- mesajlar
  ES.on('term.config', (m) => {
    T.config = m.config || {};
    T.platform = m.platform || '';
    if (!T.sessions.length) { const s = newSession(); T.sessions.push(s); T.active = s.id; }
    render();
  });
  ES.on('term.ports', (m) => {
    T.ports = m.ports || [];
    // İlk oturum port listesi gelmeden oluşturulduysa uygun portu seç
    for (const s of T.sessions) if (!s.open && !s.touched && !T.ports.some((p) => p.path === s.path)) s.path = (newSession()).path;
    renderBar();
  });
  ES.on('term.status', (m) => {
    const s = byId(m.id);
    if (!s) return;
    s.open = !!m.open;
    s.opening = !!m.opening;
    s.error = m.error || '';
    if (!s.open) { stopRepeat(s); s.logging = ''; }
    renderTabs(); renderBar(); renderStatus(); renderSend();
  });
  ES.on('term.logging', (m) => { const s = byId(m.id); if (s) { s.logging = m.file || ''; renderStatus(); renderTools(); } });
  ES.on('term.data', (m) => {
    const s = byId(m.id);
    if (!s) return;
    for (const c of m.chunks) {
      const b = Uint8Array.from(atob(c.d), (ch) => ch.charCodeAt(0));
      s.rx += b.length;
      append(s, 'rx', b, c.t);
    }
    s.dirty = true;
    schedule();
  });

  // ---------------------------------------------------------------- veri modeli
  /** Gelen baytları satırlara böler (seçilen satır sonuna göre; çok uzun satır 1024 baytta kesilir) */
  function append(s, dir, bytes, at) {
    const L = s.lines;
    if (dir === 'tx') {
      L.push({ t: at, dir, b: Array.from(bytes), done: true });
    } else {
      let line = L.length && L[L.length - 1].dir === 'rx' && !L[L.length - 1].done ? L[L.length - 1] : null;
      for (const x of bytes) {
        // CRLF: CR'de kapanan satırın ardından gelen LF aynı satıra eklenir
        if (x === 10 && s.lastCR && (s.rxNl === 'cr' || s.rxNl === 'auto') && !line) { const prev = L[L.length - 1]; if (prev && prev.dir === 'rx') prev.b.push(x); s.lastCR = false; continue; }
        if (!line) { line = { t: at, dir, b: [], done: false }; L.push(line); }
        line.b.push(x);
        const end = s.rxNl === 'cr' ? x === 13 : s.rxNl === 'auto' ? x === 10 || x === 13 : x === 10;
        s.lastCR = x === 13;
        if (end || line.b.length >= MAX_LINE) { line.done = true; line = null; }
      }
    }
    if (L.length > MAX_LINES) {
      const cut = L.length - MAX_LINES;
      L.splice(0, cut);
      s.start = Math.max(0, s.start - cut);
      s.full = true;
    }
  }

  const visible = (s) => s.lines.filter((l) => l.dir === 'rx' || s.echo);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const stamp = (at) => { const d = new Date(at); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  const hexOf = (b) => b.map((x) => x.toString(16).toUpperCase().padStart(2, '0')).join(' ');
  const dec = new TextDecoder('utf-8');
  /** Satırın metni (satır sonları atılır; ASCII'de kontrol karakterleri ·) */
  function textOf(l, view) {
    const b = l.b.slice();
    while (b.length && (b[b.length - 1] === 10 || b[b.length - 1] === 13)) b.pop();
    if (view === 'hex') return hexOf(l.b);
    if (view === 'mixed') return b.map((x) => (x >= 32 && x < 127 ? String.fromCharCode(x) : `<${x.toString(16).toUpperCase().padStart(2, '0')}>`)).join('');
    return dec.decode(Uint8Array.from(b)).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·');
  }

  // ---------------------------------------------------------------- çizim
  let raf = 0;
  function schedule() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderOut(); renderStatus(); }); }

  function render() {
    if (!$('terminal')) return;
    renderTabs(); renderBar(); renderTools(); renderMacros(); renderSend();
    const s = cur();
    if (s) { s.full = true; s.dirty = true; }
    renderOut(); renderStatus();
  }

  function renderTabs() {
    const box = $('term-tabs');
    if (!box) return;
    put(box, ...T.sessions.map((s) => h('div', { class: `term-tab${s.id === T.active ? ' active' : ''}`, role: 'tab', 'aria-selected': String(s.id === T.active), 'data-id': s.id, onclick: () => { T.active = s.id; render(); } },
      h('span', { class: `dot${s.open ? ' on' : s.error ? ' err' : ''}` }), h('span', { text: s.path === 'SIM' ? t('Simülasyon') : s.path }),
      T.sessions.length > 1 ? h('button', { class: 'icon tiny', title: t('Sekmeyi kapat'), 'aria-label': t('Sekmeyi kapat'), onclick: (e) => { e.stopPropagation(); closeSession(s); } }, '×') : null)),
    h('button', { class: 'ghost small', id: 'term-new', title: t('Yeni port sekmesi'), onclick: () => { const s = newSession(); T.sessions.push(s); T.active = s.id; render(); } }, '+'));
  }

  function closeSession(s) {
    if (s.open) post({ type: 'term.close', id: s.id });
    stopRepeat(s);
    T.sessions = T.sessions.filter((x) => x !== s);
    if (T.active === s.id) T.active = T.sessions[0] ? T.sessions[0].id : '';
    render();
  }

  const sel = (id, label, value, options, onchange, disabled) => h('label', { class: 'term-field' }, h('span', { text: label }),
    h('select', { id, class: 'tiny', disabled, onchange: (e) => onchange(e.target.value) }, ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value), text: l }))));

  function renderBar() {
    const box = $('term-bar'), s = cur();
    if (!box || !s) return;
    const lock = s.open || s.opening;
    const ports = T.ports.length ? T.ports : [{ path: s.path, name: s.path }];
    const portOpts = ports.map((p) => [p.path, p.sim ? p.name : p.name && p.name !== p.path ? `${p.path} · ${p.name.replace(/\s*\(COM\d+\)\s*$/, '')}` : p.path]);
    if (!ports.some((p) => p.path === s.path)) portOpts.unshift([s.path, `${s.path} (${t('yok')})`]);
    const set = (k) => (v) => { s[k] = v; s.touched = true; renderBar(); };
    const custom = !BAUDS.includes(Number(s.baud));
    put(box, 
      sel('term-port', t('Port'), s.path, portOpts, set('path'), lock),
      h('button', { class: 'ghost small', id: 'term-refresh', title: t('Port listesini yenile'), 'aria-label': t('Port listesini yenile'), disabled: lock, onclick: () => post({ type: 'term.ports' }) }, '⟳'),
      sel('term-baud', 'Baud', custom ? 'custom' : s.baud, [...BAUDS.map((b) => [b, String(b)]), ['custom', t('Diğer…')]], (v) => {
        if (v === 'custom') { s.baud = s.baud || 115200; s.customBaud = true; } else { s.baud = Number(v); s.customBaud = false; }
        renderBar();
      }, lock),
      custom || s.customBaud ? h('input', { type: 'number', class: 'tiny', id: 'term-baud-custom', min: '50', value: s.baud, disabled: lock, 'aria-label': t('Özel baud'), onchange: (e) => { s.baud = Number(e.target.value); } }) : null,
      sel('term-bits', t('Veri'), s.dataBits, [[8, '8'], [7, '7'], [6, '6'], [5, '5']], (v) => { s.dataBits = Number(v); }, lock),
      sel('term-parity', t('Parite'), s.parity, [['none', t('Yok')], ['even', t('Çift')], ['odd', t('Tek')], ['mark', 'Mark'], ['space', 'Space']], (v) => { s.parity = v; }, lock),
      sel('term-stop', 'Stop', s.stopBits, [['1', '1'], ['1.5', '1.5'], ['2', '2']], (v) => { s.stopBits = v; }, lock),
      sel('term-flow', t('Akış'), s.flow, [['none', t('Yok')], ['rtscts', 'RTS/CTS'], ['xonxoff', 'XON/XOFF']], (v) => { s.flow = v; }, lock),
      h('button', { class: s.open ? 'ghost small' : 'small', id: 'term-connect', disabled: s.opening, onclick: () => (s.open ? post({ type: 'term.close', id: s.id }) : connect(s)) },
        s.opening ? t('Açılıyor…') : s.open ? t('Bağlantıyı kes') : t('Bağlan')),
      h('span', { class: 'sep' }),
      h('label', { class: 'check', title: t('Data Terminal Ready (bazı kartlarda reset hattı)') }, h('input', { type: 'checkbox', id: 'term-dtr', checked: s.dtr, disabled: !s.open || T.platform !== 'win32' && s.path !== 'SIM', onchange: (e) => { s.dtr = e.target.checked; post({ type: 'term.signals', id: s.id, dtr: s.dtr, rts: s.rts }); } }), h('span', { text: 'DTR' })),
      h('label', { class: 'check', title: 'Request To Send' }, h('input', { type: 'checkbox', id: 'term-rts', checked: s.rts, disabled: !s.open || T.platform !== 'win32' || s.flow === 'rtscts', onchange: (e) => { s.rts = e.target.checked; post({ type: 'term.signals', id: s.id, dtr: s.dtr, rts: s.rts }); } }), h('span', { text: 'RTS' })),
      h('button', { class: 'ghost small', id: 'term-break', disabled: !s.open || T.platform !== 'win32' || s.path === 'SIM', title: t('Break sinyali (250 ms)'), onclick: () => post({ type: 'term.break', id: s.id, ms: 250 }) }, 'Break'));
  }

  function connect(s) {
    s.error = '';
    s.opening = true;
    renderBar();
    post({ type: 'term.open', id: s.id, path: s.path, baud: s.baud, dataBits: s.dataBits, parity: s.parity, stopBits: s.stopBits, flow: s.flow, dtr: s.dtr, rts: s.rts });
  }

  function renderTools() {
    const box = $('term-tools'), s = cur();
    if (!box || !s) return;
    const full = () => { s.full = true; s.dirty = true; renderOut(); };
    const q = h('input', { type: 'text', id: 'term-q', class: 'tiny', placeholder: t('Ara…'), value: s.search, 'aria-label': t('Ara…'),
      oninput: (e) => { s.search = e.target.value; s.hit = -1; full(); renderStatus(); }, onkeydown: (e) => { if (e.key === 'Enter') jump(s, e.shiftKey ? -1 : 1); } });
    put(box, 
      sel('term-view', t('Görünüm'), s.view, [['ascii', 'ASCII'], ['hex', 'HEX'], ['mixed', t('Karışık')]], (v) => { s.view = v; full(); }),
      sel('term-rxnl', t('Gelen satır sonu'), s.rxNl, [['lf', 'LF'], ['cr', 'CR'], ['auto', 'CR / LF']], (v) => { s.rxNl = v; }),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'term-time', checked: s.time, onchange: (e) => { s.time = e.target.checked; full(); } }), h('span', { text: t('Zaman') })),
      h('label', { class: 'check', title: t('Gönderilenleri de göster') }, h('input', { type: 'checkbox', id: 'term-echo', checked: s.echo, onchange: (e) => { s.echo = e.target.checked; full(); } }), h('span', { text: t('Yerel yankı') })),
      h('span', { class: 'spacer' }),
      h('div', { class: 'search term-search' }, q),
      h('button', { class: 'ghost small', title: t('Önceki eşleşme (Shift+Enter)'), 'aria-label': t('Önceki eşleşme (Shift+Enter)'), onclick: () => jump(s, -1) }, '↑'),
      h('button', { class: 'ghost small', title: t('Sonraki eşleşme (Enter)'), 'aria-label': t('Sonraki eşleşme (Enter)'), onclick: () => jump(s, 1) }, '↓'),
      h('button', { class: 'ghost small', id: 'term-clear', onclick: () => { s.lines = []; s.rx = 0; s.tx = 0; s.start = 0; full(); renderStatus(); } }, t('Temizle')),
      h('button', { class: 'ghost small', id: 'term-save', title: t('Görünen oturumu metin olarak kaydet'), onclick: () => saveText(s) }, t('Kaydet…')),
      s.logging ? h('button', { class: 'small', id: 'term-log', onclick: () => post({ type: 'term.log', id: s.id, on: false }) }, t('Log durdur'))
        : h('select', { class: 'tiny', id: 'term-log', disabled: !s.open, 'aria-label': t('Log dosyasına kaydet'), onchange: (e) => { const v = e.target.value; e.target.value = ''; if (v) post({ type: 'term.log', id: s.id, on: true, format: v }); } },
          h('option', { value: '', text: t('Log başlat…') }), h('option', { value: 'text', text: t('Metin (zaman damgalı)') }), h('option', { value: 'raw', text: t('Ham bayt (.bin)') })));
  }

  function saveText(s) {
    const lines = visible(s);
    if (!lines.length) return toast('info', t('Kaydedilecek çıktı yok.'));
    post({ type: 'term.save', name: `${s.path}-terminal`, text: lines.map((l) => `${s.time ? stamp(l.t) + '  ' : ''}${l.dir === 'tx' ? '> ' : ''}${textOf(l, s.view)}`).join('\n') + '\n' });
  }

  /** Satır öğesi; arama eşleşmeleri işaretlenir */
  function row(s, l) {
    const text = textOf(l, s.view);
    const parts = [];
    if (s.time) parts.push(h('span', { class: 'ts', text: stamp(l.t) }));
    if (l.dir === 'tx') parts.push(h('span', { class: 'txm', text: '›' }));
    const q = s.search;
    if (q) {
      const low = text.toLowerCase(), ql = q.toLowerCase();
      let i = 0, k;
      const body = h('span', { class: 'tx' });
      while ((k = low.indexOf(ql, i)) >= 0) {
        if (k > i) body.append(text.slice(i, k));
        body.append(h('mark', { text: text.slice(k, k + q.length) }));
        i = k + q.length;
      }
      body.append(text.slice(i));
      parts.push(body);
    } else if (s.view === 'mixed') {
      const body = h('span', { class: 'tx' });
      for (const p of text.split(/(<[0-9A-F]{2}>)/)) if (p) body.append(/^<[0-9A-F]{2}>$/.test(p) ? h('span', { class: 'ctl', text: p.slice(1, 3) }) : p);
      parts.push(body);
    } else parts.push(h('span', { class: 'tx', text }));
    return h('div', { class: `ln ${l.dir}` }, ...parts);
  }

  function renderOut() {
    const box = $('term-out'), s = cur();
    if (!box || !s || ui.tab !== 'terminal') return;
    if (!s.dirty) return;
    s.dirty = false;
    const lines = visible(s);
    const atBottom = s.autoscroll;
    if (s.full || !s.rendered) {
      // Son MAX_ROWS satır baştan çizilir
      s.full = false;
      s.rendered = lines.slice(-MAX_ROWS);
      put(box, ...(s.rendered.length ? s.rendered.map((l) => row(s, l)) : [h('div', { class: 'hint pad', text: s.open ? t('Veri bekleniyor…') : t('Port seçip "Bağlan". Kart yoksa "Simülasyon" portunu deneyin.') })]));
    } else {
      // Artımlı: son (açık) satır yenilenir, yeni satırlar eklenir, en eskiler atılır
      const R = s.rendered;
      const last = R[R.length - 1];
      const from = last ? lines.lastIndexOf(last) : -1;
      if (last && from < 0) { s.full = true; s.dirty = true; return renderOut(); }
      if (!R.length) put(box, );
      if (last) box.lastChild.replaceWith(row(s, last));
      for (const l of lines.slice(from + 1)) { R.push(l); box.append(row(s, l)); }
      while (R.length > MAX_ROWS) { R.shift(); box.firstChild.remove(); }
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function onScroll(e) {
    const s = cur(), b = e.target;
    if (s) s.autoscroll = b.scrollTop + b.clientHeight >= b.scrollHeight - 8;
  }

  /** Aramada sonraki/önceki eşleşmeye kaydır (görünen satırlar içinde) */
  function jump(s, dir) {
    const marks = [...document.querySelectorAll('#term-out mark')];
    if (!marks.length) return;
    marks.forEach((m) => m.classList.remove('cur'));
    s.hit = ((s.hit < 0 && dir < 0 ? marks.length : s.hit) + dir + marks.length) % marks.length;
    marks[s.hit].classList.add('cur');
    s.autoscroll = false;
    marks[s.hit].scrollIntoView({ block: 'center' });
    renderStatus();
  }

  function renderStatus() {
    const box = $('term-status'), s = cur();
    if (!box || !s) return;
    let matches = 0;
    if (s.search) { const q = s.search.toLowerCase(); for (const l of visible(s)) { const x = textOf(l, s.view).toLowerCase(); let i = 0, k; while ((k = x.indexOf(q, i)) >= 0) { matches++; i = k + q.length; } } }
    box.className = `term-status${s.error ? ' error' : ''}`;
    put(box, ...[
      h('span', { text: s.error || (s.open ? t('Bağlı: {0} {1} {2}{3}{4}', s.path, s.baud, s.dataBits, { none: 'N', even: 'E', odd: 'O', mark: 'M', space: 'S' }[s.parity], s.stopBits) : t('Bağlı değil')) }),
      h('span', { class: 'mono', id: 'term-count', text: `RX ${s.rx} B · TX ${s.tx} B` }),
      s.search ? h('span', { id: 'term-matches', text: t('{0} eşleşme', matches) }) : null,
      s.logging ? h('span', { class: 'rec', title: s.logging, text: `● ${t('Log')}: ${s.logging.replace(/\\/g, '/').split('/').pop()}` }) : null
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- gönderme
  const EOL = () => [['', t('Yok')], ['\r', 'CR'], ['\n', 'LF'], ['\r\n', 'CRLF']];
  /** Gönderilecek baytlar: HEX ("AA 55 0x0D") ya da metin + satır sonu; \r \n \t \xNN kaçışları */
  function encode(s, text, eol = s.eol, hex = s.hexIn) {
    if (hex) {
      const parts = text.replace(/0x/gi, '').split(/[\s,]+/).filter(Boolean);
      if (parts.some((p) => !/^[0-9a-f]{1,2}$/i.test(p))) return null;
      return Uint8Array.from(parts.map((p) => parseInt(p, 16)));
    }
    const unesc = text.replace(/\\(r|n|t|\\|x[0-9a-fA-F]{2})/g, (_, c) => (c === 'r' ? '\r' : c === 'n' ? '\n' : c === 't' ? '\t' : c === '\\' ? '\\' : String.fromCharCode(parseInt(c.slice(1), 16))));
    const enc = new TextEncoder().encode(unesc);
    const e = new TextEncoder().encode(eol);
    const out = new Uint8Array(enc.length + e.length);
    out.set(enc); out.set(e, enc.length);
    return out;
  }
  function sendBytes(s, bytes) {
    if (!s.open) return toast('warn', t('Önce porta bağlanın.'));
    let bin = '';
    for (const x of bytes) bin += String.fromCharCode(x);
    post({ type: 'term.send', id: s.id, data: btoa(bin) });
    s.tx += bytes.length;
    append(s, 'tx', bytes, Date.now());
    s.dirty = true;
    s.autoscroll = true;
    schedule();
  }
  function sendInput(s, keep) {
    const bytes = encode(s, s.input);
    if (!bytes) return toast('warn', t('HEX biçimi: "AA 55 0D" gibi iki haneli baytlar.'));
    if (!bytes.length) return;
    sendBytes(s, bytes);
    if (s.input && s.history[s.history.length - 1] !== s.input) s.history.push(s.input);
    if (s.history.length > 100) s.history.shift();
    s.histAt = -1;
    if (!keep) { s.input = ''; const el = $('term-input'); if (el) el.value = ''; }
  }
  function stopRepeat(s) { clearInterval(s.repeatTimer); s.repeatTimer = 0; s.repeat = false; }

  function renderSend() {
    const box = $('term-send'), s = cur();
    if (!box || !s) return;
    const had = document.activeElement && document.activeElement.id === 'term-input';
    const input = h('input', { type: 'text', id: 'term-input', class: 'mono', value: s.input, placeholder: s.hexIn ? t('HEX baytlar, ör. AA 55 01 0D') : t('Gönderilecek metin (Enter); \\r \\n \\xNN kaçışları'), 'aria-label': t('Gönderilecek metin'), disabled: !s.open,
      oninput: (e) => { s.input = e.target.value; },
      onkeydown: (e) => {
        if (e.key === 'Enter') { sendInput(s, s.repeat); e.preventDefault(); } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const H = s.history;
          if (!H.length) return;
          s.histAt = e.key === 'ArrowUp' ? (s.histAt < 0 ? H.length - 1 : Math.max(0, s.histAt - 1)) : s.histAt < 0 ? -1 : s.histAt + 1;
          if (s.histAt >= H.length) s.histAt = -1;
          s.input = s.histAt < 0 ? '' : H[s.histAt];
          e.target.value = s.input;
          e.preventDefault();
        }
      } });
    put(box, 
      input,
      h('select', { class: 'tiny', id: 'term-eol', 'aria-label': t('Satır sonu'), disabled: s.hexIn, onchange: (e) => { s.eol = e.target.value; } }, ...EOL().map(([v, l]) => h('option', { value: v, selected: v === s.eol, text: l }))),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'term-hexin', checked: s.hexIn, onchange: (e) => { s.hexIn = e.target.checked; renderSend(); } }), h('span', { text: 'HEX' })),
      h('label', { class: 'check', title: t('Kutudaki veriyi aralıkla tekrar tekrar gönder') }, h('input', { type: 'checkbox', id: 'term-repeat', checked: s.repeat, disabled: !s.open, onchange: (e) => {
        if (!e.target.checked) { stopRepeat(s); return; }
        if (!encode(s, s.input) || !encode(s, s.input).length) { e.target.checked = false; return toast('warn', t('Tekrarlanacak veri yok.')); }
        s.repeat = true;
        s.repeatTimer = setInterval(() => { if (s.open) sendInput(s, true); else stopRepeat(s); }, Math.max(10, s.repeatMs));
      } }), h('span', { text: t('Tekrar') })),
      h('input', { type: 'number', class: 'tiny', id: 'term-repeat-ms', min: '10', value: s.repeatMs, disabled: s.repeat, 'aria-label': t('Tekrar aralığı (ms)'), title: t('Tekrar aralığı (ms)'), onchange: (e) => { s.repeatMs = Math.max(10, Number(e.target.value) || 1000); } }),
      h('span', { class: 'hint', text: 'ms' }),
      h('button', { class: 'small', id: 'term-send-go', disabled: !s.open, onclick: () => sendInput(s, s.repeat) }, t('Gönder')));
    if (had) { const el = $('term-input'); if (el) el.focus(); }
  }

  // ---------------------------------------------------------------- makrolar
  const macros = () => (T.config && T.config.macros) || [];
  function saveMacros(list) {
    T.config = { ...(T.config || {}), macros: list };
    post({ type: 'term.config', config: { macros: list } });
    renderMacros();
  }
  function renderMacros() {
    const box = $('term-macros'), s = cur();
    if (!box || !s) return;
    put(box, 
      h('span', { class: 'hint', text: t('Makrolar') }),
      ...macros().map((m, i) => h('button', { class: `ghost small macro${T.editMacros ? ' editing' : ''}`, 'data-macro': m.label, title: T.editMacros ? t('Düzenle') : m.hex ? `HEX: ${m.data}` : m.data,
        onclick: () => {
          if (T.editMacros) return editMacro(i);
          const b = encode(s, m.data, m.eol ? s.eol : '', !!m.hex);
          if (!b) return toast('warn', t('Makro verisi geçersiz: {0}', m.label));
          sendBytes(s, b);
        } }, m.label)),
      h('button', { class: 'ghost small', id: 'term-macro-add', title: t('Makro ekle'), 'aria-label': t('Makro ekle'), onclick: () => editMacro(-1) }, '+'),
      macros().length ? h('button', { class: `ghost small${T.editMacros ? ' active' : ''}`, id: 'term-macro-edit', onclick: () => { T.editMacros = !T.editMacros; renderMacros(); } }, T.editMacros ? t('Bitti') : t('Düzenle')) : null);
  }
  function editMacro(i) {
    const m = i >= 0 ? macros()[i] : { label: '', data: '', hex: false, eol: true };
    const label = h('input', { type: 'text', id: 'macro-label', value: m.label, 'aria-label': t('Ad') });
    const data = h('input', { type: 'text', id: 'macro-data', class: 'mono', value: m.data, 'aria-label': t('Veri') });
    const hex = h('input', { type: 'checkbox', id: 'macro-hex', checked: !!m.hex });
    const eol = h('input', { type: 'checkbox', id: 'macro-eol', checked: m.eol !== false });
    modal({
      title: i >= 0 ? t('Makroyu düzenle') : t('Yeni makro'), width: 420,
      body: h('div', {},
        h('div', { class: 'field' }, h('label', { text: t('Ad') }), label),
        h('div', { class: 'field' }, h('label', { text: t('Veri (metin; \\r \\n \\xNN) ya da HEX baytlar') }), data),
        h('label', { class: 'check' }, hex, h('span', { text: t('HEX') })), ' ',
        h('label', { class: 'check' }, eol, h('span', { text: t('Seçili satır sonunu ekle (metinde)') }))),
      buttons: [
        ...(i >= 0 ? [{ label: t('Sil'), id: 'macro-del', action: () => { saveMacros(macros().filter((_, k) => k !== i)); } }] : []),
        { label: t('Vazgeç') },
        { label: t('Kaydet'), primary: true, id: 'macro-ok', action: () => {
          const x = { label: label.value.trim(), data: data.value, hex: hex.checked, eol: eol.checked };
          if (!x.label || !x.data) { toast('warn', t('Ad ve veri gerekli.')); return false; }
          if (x.hex && !encode(cur() || newSession(), x.data, '', true)) { toast('warn', t('HEX biçimi: "AA 55 0D" gibi iki haneli baytlar.')); return false; }
          const list = macros().slice();
          if (i >= 0) list[i] = x; else list.push(x);
          saveMacros(list);
        } }]
    });
  }

  ES.tabs.terminal = {
    mount,
    render,
    onShow() {
      if (!T.config) post({ type: 'term.init' });
      else render();
      // Port listesi: sekme açıkken 2,5 sn'de bir hızlı denetim (yalnızca değişince yeniden okunur)
      clearInterval(T.poll);
      T.poll = setInterval(() => { if (ui.tab === 'terminal') post({ type: 'term.ports', quick: true }); else clearInterval(T.poll); }, 2500);
    }
  };
})();
