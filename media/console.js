/* Debug sekmesinin alt paneli (ES-208): SWO/ITM printf, SEGGER RTT, semihosting konsolu,
 * PC örneklemeli istatistiksel profil ve SWV data trace. Bağlantı ve sembol listesi debug.js'ten (ES.dbg). */
(function () {
  const { t, h, $, post, ui, hex, toast } = ES;
  const MAX_LINES = 5000;
  const con = {
    open: true, tab: 'itm', info: null, status: {}, error: '', warn: '', time: false,
    // Kaynak başına satırlar: [{ ch, t, text, done }]
    lines: { itm: [], rtt: [], semi: [] }, t0: Date.now(), port: 'all',
    // SWO ayarları (kayıtlı ayarlar traceInfo ile gelir)
    cpuMHz: '', swoKHz: '2000', ports: '0', pc: false, data: [], dataPc: false, rttAddr: '', rttCh: 0, eol: '\n',
    profile: null, dtrace: [], semiOn: false, dirty: false, sendHist: [], histAt: -1
  };
  const D = () => ES.dbg || {};

  function mount(el) {
    if (!el) return;
    el.replaceChildren(
      h('div', { class: 'con-head' },
        h('button', { class: 'ghost small tw-btn', id: 'con-toggle', 'aria-expanded': 'true', title: t('Konsolu daralt / genişlet'), onclick: () => { con.open = !con.open; render(); } }, '▾'),
        h('span', { class: 'pane-title', text: t('Konsol') }),
        h('div', { class: 'con-tabs', role: 'tablist' },
          ...TABS().map(([id, label]) => h('button', { class: 'con-tab', role: 'tab', id: `con-tab-${id}`, 'data-tab': id, onclick: () => { con.tab = id; con.open = true; render(); } }, label))),
        h('span', { class: 'spacer' }),
        h('span', { class: 'hint', id: 'con-stat' }),
        h('label', { class: 'check', title: t('Satır başına geliş zamanı') }, h('input', { type: 'checkbox', id: 'con-time', onchange: (e) => { con.time = e.target.checked; con.dirty = true; renderOut(); } }), h('span', { text: t('Zaman') })),
        h('button', { class: 'ghost small', id: 'con-clear', onclick: clear }, t('Temizle')),
        h('button', { class: 'ghost small', id: 'con-save', onclick: save }, t('Kaydet…'))),
      h('div', { class: 'con-body', id: 'con-body' },
        h('div', { class: 'con-ctl', id: 'con-ctl' }),
        h('div', { class: 'con-msg', id: 'con-msg', role: 'status' }),
        h('pre', { class: 'con-out', id: 'con-out', tabindex: '0', 'aria-live': 'off' }),
        h('div', { class: 'con-view', id: 'con-view' }),
        h('div', { class: 'con-input', id: 'con-input' })));
    render();
  }

  const TABS = () => [['itm', 'SWO / ITM'], ['rtt', 'RTT'], ['semi', 'Semihosting'], ['prof', t('Profil (PC örnekleme)')], ['data', 'Data trace']];
  const running = () => ({ itm: !!con.status.swo, rtt: !!con.status.rtt, semi: !!con.status.semi, prof: !!con.status.swo && con.pc, data: !!con.status.swo && con.data.length > 0 });

  // ---------------------------------------------------------------- mesajlar
  ES.on('debug.traceInfo', (m) => {
    const first = !con.info;
    con.info = m;
    if (first) {
      const s = m.settings || {};
      if (s.swoHz) con.swoKHz = String(s.swoHz / 1000);
      if (s.ports) con.ports = String(s.ports);
      con.pc = !!s.pc;
      con.data = Array.isArray(s.data) ? s.data.slice(0, 4) : [];
      con.rttAddr = s.rttAddr || '';
    }
    con.cpuMHz = String(m.cpuHz / 1e6);
    render();
  });
  ES.on('debug.trace', (m) => {
    if (m.error) { con.error = m.error; con.warn = ''; } else if (m.warn) con.warn = m.warn;
    else con.error = '';
    if ('swo' in m) con.status = m;
    con.semiOn = !!con.status.semi;
    render();
  });
  ES.on('debug.status', (m) => {
    if (!m.connected) { con.status = {}; con.semiOn = false; if (!m.connecting) con.error = ''; }
    render();
  });
  ES.on('debug.console', (m) => {
    for (const it of m.items) append(it.src, it.ch, it.text);
    con.dirty = true;
    schedule();
  });
  ES.on('debug.profile', (m) => { con.profile = m; if (con.tab === 'prof') renderView(); });
  ES.on('debug.dtrace', (m) => {
    con.dtrace.push(...m.items);
    if (con.dtrace.length > 500) con.dtrace.splice(0, con.dtrace.length - 500);
    if (con.tab === 'data') renderView();
  });

  /** Metni satırlara böler; yarım kalan satır aynı kanaldan gelen bir sonraki parçayla tamamlanır */
  function append(src, ch, text) {
    const L = con.lines[src];
    if (!L) return;
    const parts = String(text).replace(/\r\n?/g, '\n').split('\n');
    const now = Date.now();
    let open = null;
    for (let i = L.length - 1; i >= Math.max(0, L.length - 50); i--) if (L[i].ch === ch) { open = L[i].done ? null : L[i]; break; }
    parts.forEach((p, i) => {
      const last = i === parts.length - 1;
      if (i === 0 && open) { open.text += p; open.done = !last; return; }
      if (last && !p) return;
      L.push({ ch, t: now, text: p, done: !last });
    });
    if (L.length > MAX_LINES) L.splice(0, L.length - MAX_LINES);
  }

  let raf = 0;
  function schedule() {
    if (raf) return;
    raf = requestAnimationFrame(() => { raf = 0; renderOut(); });
  }

  // ---------------------------------------------------------------- eylemler
  function needConn() {
    if (D().connected) return true;
    toast('warn', t('Önce hedefe bağlanın.'));
    return false;
  }
  function startSwo() {
    if (!needConn()) return;
    const cpu = Number(con.cpuMHz), swo = Number(con.swoKHz);
    if (!(cpu > 0) || !(swo > 0)) return toast('warn', t('Çekirdek saati ve SWO frekansı girilmeli.'));
    con.error = ''; con.warn = '';
    con.profile = null;
    post({ type: 'debug.swo', on: true, cpuHz: Math.round(cpu * 1e6), swoHz: Math.round(swo * 1e3), ports: con.ports, pc: con.pc, data: con.data, dataPc: con.dataPc });
  }
  const stopSwo = () => post({ type: 'debug.swo', on: false });
  function startRtt() {
    if (!needConn()) return;
    con.error = '';
    post({ type: 'debug.rtt', on: true, addr: con.rttAddr.trim() || undefined });
  }
  function send(input) {
    const text = input.value;
    if (!con.status.rtt) return toast('warn', t('Önce RTT\'yi başlatın.'));
    post({ type: 'debug.rttSend', ch: con.rttCh, text, eol: con.eol });
    if (text && con.sendHist[con.sendHist.length - 1] !== text) con.sendHist.push(text);
    con.histAt = -1;
    input.value = '';
  }
  function clear() {
    if (con.tab === 'prof') post({ type: 'debug.profileReset' });
    else if (con.tab === 'data') con.dtrace = [];
    else con.lines[con.tab] = [];
    con.dirty = true;
    render();
  }
  function save() {
    let text;
    if (con.tab === 'prof') text = (con.profile?.rows || []).map((r) => `${r.pct.toFixed(2).padStart(6)}%  ${String(r.count).padStart(8)}  ${r.name}`).join('\n');
    else if (con.tab === 'data') text = con.dtrace.map((d) => `${new Date(d.t).toISOString()}\t${d.name}\t${d.write ? 'W' : 'R'}\t${d.value}\t${d.pc !== undefined ? hex(d.pc) : ''}`).join('\n');
    else text = lineText(con.tab);
    if (!text) return toast('info', t('Kaydedilecek çıktı yok.'));
    post({ type: 'debug.consoleSave', text: text + '\n', name: { itm: 'swo-itm', rtt: 'rtt', semi: 'semihosting', prof: 'profile', data: 'data-trace' }[con.tab] });
  }

  /** Görünen satırların metni (port süzgeci, zaman ve port öneki) */
  function lineText(src) {
    const L = con.lines[src] || [];
    const multi = src === 'itm' && new Set(L.map((l) => l.ch)).size > 1;
    const show = src === 'itm' && con.port !== 'all' ? L.filter((l) => String(l.ch) === con.port) : L;
    return show.map((l) => (con.time ? `${((l.t - con.t0) / 1000).toFixed(3).padStart(9)}  ` : '') + (multi && con.port === 'all' ? `[${l.ch}] ` : '') + l.text).join('\n');
  }

  // ---------------------------------------------------------------- çizim
  function render() {
    const root = $('dbg-console');
    if (!root) return;
    root.classList.toggle('closed', !con.open);
    $('con-toggle').textContent = con.open ? '▾' : '▸';
    $('con-toggle').setAttribute('aria-expanded', String(con.open));
    const run = running();
    for (const b of root.querySelectorAll('.con-tab')) {
      const id = b.dataset.tab;
      b.classList.toggle('active', id === con.tab);
      b.setAttribute('aria-selected', String(id === con.tab));
      b.classList.toggle('streaming', !!run[id]);
    }
    const st = con.status;
    $('con-stat').textContent = [st.swo ? `SWO ${(st.swoHz / 1e6).toFixed(3).replace(/\.?0+$/, '')} MHz` : '', st.rtt ? 'RTT' : '', st.semi ? 'Semihosting' : ''].filter(Boolean).join(' · ');
    const tm = $('con-time');
    if (tm) tm.checked = con.time;
    renderCtl();
    renderMsg();
    con.dirty = true;
    renderOut();
    renderView();
  }

  function renderMsg() {
    const el = $('con-msg');
    if (!el) return;
    const text = con.error || con.warn;
    el.className = `con-msg${con.error ? ' error' : con.warn ? ' warn' : ''}`;
    el.textContent = text;
    el.hidden = !text;
  }

  const field = (label, input) => h('label', { class: 'con-field' }, h('span', { text: label }), input);

  function renderCtl() {
    const box = $('con-ctl');
    if (!box) return;
    const st = con.status, info = con.info || {}, conn = !!D().connected;
    const parts = [];
    if (con.tab === 'itm' || con.tab === 'prof' || con.tab === 'data') {
      if (info.swo === false) {
        parts.push(h('span', { class: 'hint', text: t('{0} çekirdeğinde ITM/SWO yok. RTT ya da semihosting kullanın.', info.core || 'Cortex-M0') }));
      } else {
        parts.push(
          field(t('Çekirdek saati (MHz)'), h('input', { type: 'number', class: 'tiny', id: 'con-cpu', min: '1', step: 'any', value: con.cpuMHz, disabled: st.swo, title: t('TRACECLKIN = HCLK; projenin saat ayarından gelir'), oninput: (e) => (con.cpuMHz = e.target.value) })),
          field(t('SWO (kHz)'), h('input', { type: 'number', class: 'tiny', id: 'con-swo', min: '1', step: 'any', value: con.swoKHz, disabled: st.swo, oninput: (e) => (con.swoKHz = e.target.value) })),
          field(t('Portlar'), h('input', { type: 'text', class: 'tiny mono', id: 'con-ports', value: con.ports, disabled: st.swo, placeholder: '0,1', title: t('ITM stimulus portları: 0 ya da 0,1,5-7'), oninput: (e) => (con.ports = e.target.value) })),
          h('label', { class: 'check', title: t('DWT PC örnekleme: fonksiyonlara göre zaman dağılımı (Profil sekmesi)') }, h('input', { type: 'checkbox', id: 'con-pc', checked: con.pc, disabled: st.swo, onchange: (e) => { con.pc = e.target.checked; } }), h('span', { text: t('PC örnekleme') })),
          st.swo ? h('button', { class: 'small', id: 'con-swo-go', onclick: stopSwo }, t('Durdur@@debug')) : h('button', { class: 'small', id: 'con-swo-go', disabled: !conn, onclick: startSwo }, t('SWO başlat')));
        if (st.swo) parts.push(h('span', { class: 'hint', text: [st.rate ? t('{0} örnek/sn', st.rate) : '', st.overflows ? t('{0} taşma', st.overflows) : ''].filter(Boolean).join(' · ') }));
        if (con.tab === 'itm') {
          const ports = [...new Set(con.lines.itm.map((l) => l.ch))].sort((a, b) => a - b);
          if (ports.length > 1) parts.push(h('select', { class: 'tiny', id: 'con-port', 'aria-label': t('Port süzgeci'), onchange: (e) => { con.port = e.target.value; con.dirty = true; renderOut(); } },
            h('option', { value: 'all', text: t('Tüm portlar'), selected: con.port === 'all' }), ...ports.map((p) => h('option', { value: String(p), text: `Port ${p}`, selected: con.port === String(p) }))));
        }
      }
    } else if (con.tab === 'rtt') {
      parts.push(
        field(t('Kontrol bloğu'), h('input', { type: 'text', class: 'tiny mono', id: 'con-rtt-addr', value: con.rttAddr, disabled: st.rtt, placeholder: t('otomatik'), title: t('Boşsa ELF\'teki _SEGGER_RTT, yoksa RAM'), oninput: (e) => (con.rttAddr = e.target.value) })),
        st.rtt ? h('button', { class: 'small', id: 'con-rtt-go', onclick: () => post({ type: 'debug.rtt', on: false }) }, t('Durdur@@debug')) : h('button', { class: 'small', id: 'con-rtt-go', disabled: !conn, onclick: startRtt }, t('RTT başlat')));
      if (st.rtt) parts.push(h('span', { class: 'hint mono', id: 'con-rtt-info', text: `@${hex(st.rtt.addr)} · ` + st.rtt.channels.map((c) => `${c.dir === 'up' ? '↑' : '↓'}${c.index} ${c.name || '?'} (${c.size} B)`).join(', ') }));
    } else if (con.tab === 'semi') {
      parts.push(con.semiOn ? h('button', { class: 'small', id: 'con-semi-go', onclick: () => post({ type: 'debug.semi', on: false }) }, t('Kapat')) : h('button', { class: 'small', id: 'con-semi-go', disabled: !conn, onclick: () => { if (needConn()) post({ type: 'debug.semi', on: true }); } }, t('Semihosting aç')),
        h('span', { class: 'hint', text: t('Firmware --specs=rdimon.specs ile bağlanmalı ve başta initialise_monitor_handles() çağırmalı. Semihosting kapalıyken printf\'te (BKPT 0xAB) hedef durur. Yavaştır; zamanlamaya duyarlı kodda SWO ya da RTT kullanın.') }));
    }
    if (con.tab === 'prof' && st.swo && !con.pc) parts.push(h('span', { class: 'hint', text: t('PC örnekleme kapalı: SWO\'yu durdurup "PC örnekleme" ile yeniden başlatın.') }));
    if (con.tab === 'data' && info.swo !== false) {
      if (info.dataTrace === false) parts.push(h('span', { class: 'hint', text: t('Data trace bu çekirdekte desteklenmiyor (ARMv8-M karşılaştırıcıları farklı).') }));
      else {
        const inp = h('input', { type: 'text', class: 'tiny mono', id: 'con-dvar', list: 'mem-syms', placeholder: t('değişken'), disabled: st.swo || con.data.length >= 4 });
        const add = () => {
          const name = inp.value.trim();
          if (!name) return;
          if (!(D().symbols || []).some((s) => s.name === name)) return toast('warn', t('Değişken bulunamadı: {0}', name));
          if (!con.data.includes(name)) con.data.push(name);
          inp.value = '';
          renderCtl();
        };
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
        parts.push(h('span', { class: 'con-chips' }, ...con.data.map((n, i) => h('span', { class: 'chip mono' }, n, st.swo ? null : h('button', { class: 'icon tiny', title: t('Kaldır'), 'aria-label': t('Kaldır'), onclick: () => { con.data.splice(i, 1); renderCtl(); } }, '×')))),
          con.data.length < 4 && !st.swo ? h('span', {}, inp, h('button', { class: 'ghost small', id: 'con-dadd', onclick: add }, t('Ekle'))) : null,
          h('label', { class: 'check', title: t('Erişen komutun adresi de gönderilir (bant genişliği iki katı)') }, h('input', { type: 'checkbox', checked: con.dataPc, disabled: st.swo, onchange: (e) => { con.dataPc = e.target.checked; } }), h('span', { text: 'PC' })),
          h('span', { class: 'hint', text: t('En fazla 4 değişken (DWT karşılaştırıcısı). Değişince SWO\'yu yeniden başlatın.') }));
      }
    }
    box.replaceChildren(...parts.filter(Boolean));
    // RTT giriş satırı
    const inBox = $('con-input');
    if (con.tab === 'rtt') {
      const down = st.rtt ? st.rtt.channels.filter((c) => c.dir === 'down') : [];
      const input = h('input', { type: 'text', class: 'mono', id: 'con-send', placeholder: t('Hedefe gönder (Enter)…'), disabled: !st.rtt || !down.length, 'aria-label': t('Hedefe gönder (Enter)…') });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') send(input);
        else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          const H = con.sendHist;
          if (!H.length) return;
          con.histAt = e.key === 'ArrowUp' ? (con.histAt < 0 ? H.length - 1 : Math.max(0, con.histAt - 1)) : con.histAt < 0 ? -1 : con.histAt + 1;
          if (con.histAt >= H.length) con.histAt = -1;
          input.value = con.histAt < 0 ? '' : H[con.histAt];
          e.preventDefault();
        }
      });
      // Durum mesajıyla yeniden çizilince yazılan metin ve odak kaybolmasın
      const old = $('con-send');
      if (old) input.value = old.value;
      const hadFocus = old && document.activeElement === old;
      inBox.replaceChildren(...[
        down.length > 1 ? h('select', { class: 'tiny', 'aria-label': t('Down kanalı'), onchange: (e) => (con.rttCh = Number(e.target.value)) }, ...down.map((c) => h('option', { value: c.index, selected: c.index === con.rttCh, text: `↓${c.index} ${c.name}` }))) : null,
        input,
        h('select', { class: 'tiny', 'aria-label': t('Satır sonu'), onchange: (e) => (con.eol = e.target.value) }, ...[['\n', 'LF'], ['\r\n', 'CRLF'], ['', t('yok')]].map(([v, l]) => h('option', { value: v, selected: v === con.eol, text: l }))),
        h('button', { class: 'small', id: 'con-send-go', disabled: !st.rtt || !down.length, onclick: () => send(input) }, t('Gönder'))].filter(Boolean)); // replaceChildren null'ı "null" metni yapar
      inBox.hidden = false;
      if (hadFocus) input.focus();
    } else { inBox.replaceChildren(); inBox.hidden = true; }
  }

  function renderOut() {
    const out = $('con-out');
    if (!out || !con.dirty) return;
    const textTab = ['itm', 'rtt', 'semi'].includes(con.tab);
    out.hidden = !textTab;
    if (!textTab || !con.open || ui.tab !== 'debug') return;
    con.dirty = false;
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 4;
    const text = lineText(con.tab);
    out.textContent = text || ({ itm: t('ITM çıktısı burada görünür. Firmware\'de printf\'i ITM_SendChar()\'a yönlendirin (es_trace sürücüsü hazır).'), rtt: t('RTT çıktısı burada görünür. Firmware SEGGER RTT (ya da es_trace) ile derlenmeli.'), semi: t('Semihosting çıktısı burada görünür.') }[con.tab]);
    out.classList.toggle('empty', !text);
    if (atBottom) out.scrollTop = out.scrollHeight;
    // Port listesi yeni port gelince güncellensin
    if (con.tab === 'itm' && !$('con-port') && new Set(con.lines.itm.map((l) => l.ch)).size > 1) renderCtl();
  }

  function renderView() {
    const box = $('con-view');
    if (!box) return;
    if (con.tab === 'prof') {
      const p = con.profile;
      box.hidden = false;
      if (!p || !p.total) {
        box.replaceChildren(h('div', { class: 'hint pad', text: con.status.swo && con.pc ? t('Örnek bekleniyor…') : t('SWO\'yu "PC örnekleme" açık başlatın: çekirdeğin zamanını hangi fonksiyonda geçirdiği istatistiksel olarak ölçülür.') }));
        return;
      }
      const max = p.rows.length ? p.rows[0].pct : 100;
      box.replaceChildren(
        h('div', { class: 'hint pad', text: t('{0} örnek · ~{1} örnek/sn. Örnekleme istatistikseldir: kısa fonksiyonlar az görünebilir.', p.total, p.rate) }),
        h('table', { class: 'regs prof', id: 'con-prof' },
          h('tr', {}, ...[t('Fonksiyon'), '%', t('Örnek'), ''].map((x) => h('th', { text: x }))),
          ...p.rows.map((r) => h('tr', { class: r.sleep ? 'sleep' : '' },
            h('td', { class: 'mono', text: r.name }),
            h('td', { class: 'mono val', text: r.pct.toFixed(1) }),
            h('td', { class: 'mono hint', text: String(r.count) }),
            h('td', { class: 'barcell' }, h('span', { class: 'bar', style: `width:${Math.max(1, (100 * r.pct) / (max || 1)).toFixed(1)}%` }))))));
    } else if (con.tab === 'data') {
      box.hidden = false;
      const rows = con.dtrace.slice(-200).reverse();
      if (!rows.length) {
        box.replaceChildren(h('div', { class: 'hint pad', text: con.status.swo && con.data.length ? t('Erişim bekleniyor…') : t('Değişken ekleyip SWO\'yu başlatın: değişkene her erişimde değer (ve isteğe bağlı PC) hedef durdurulmadan gelir.') }));
        return;
      }
      box.replaceChildren(h('table', { class: 'regs', id: 'con-dtrace' },
        h('tr', {}, ...[t('Zaman'), t('Değişken'), '', t('Değer'), 'PC'].map((x) => h('th', { text: x }))),
        ...rows.map((d) => h('tr', {},
          h('td', { class: 'mono hint', text: ((d.t - con.t0) / 1000).toFixed(3) }),
          h('td', { class: 'mono', text: d.name }),
          h('td', { class: 'mono acc', text: d.write ? 'W' : 'R', title: d.write ? t('yazma') : t('okuma') }),
          h('td', { class: 'mono val', text: `${d.value} (${hex(d.value, d.size * 2)})` }),
          h('td', { class: 'mono hint', text: d.pc !== undefined ? hex(d.pc) : '' })))));
    } else { box.replaceChildren(); box.hidden = true; }
  }

  ES.traceConsole = { mount, render: () => { con.dirty = true; render(); } };
})();
