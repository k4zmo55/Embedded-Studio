/* Programlayıcı sekmesi (ES-301): bağlan / kes, flash ve RAM okuma, dosyayla karşılaştırma, sektör silme,
 * option byte'lar ve işlem günlüğü. Bağlantı Debug sekmesiyle ortaktır (aynı prob, aynı OpenOCD). */
(function () {
  const { t, h, $, post, hex } = ES;
  const P = {
    connected: false, connecting: false, mode: '', state: '', error: '', transport: 'swd',
    info: null, sel: new Set(), last: null, log: [], progress: null, compare: null,
    region: 'flash', addr: '0x08000000', length: '0x1000', format: 'bin', base: '0x08000000'
  };
  const TRANSPORTS = () => [['swd', 'SWD'], ['jtag', 'JTAG'], ['uart', t('UART (sistem bootloader)')], ['dfu', 'USB DFU']];

  function mount(parent) {
    parent.append(h('main', { id: 'programmer', class: 'tab-pane' },
      h('div', { class: 'dbg-bar', id: 'pg-bar' }),
      h('div', { id: 'pg-msg', class: 'dbg-msg', hidden: true }),
      h('div', { class: 'pg-body' },
        h('div', { class: 'pg-col' },
          h('section', { class: 'pg-card', id: 'pg-read' }),
          h('section', { class: 'pg-card', id: 'pg-compare' }),
          h('section', { class: 'pg-card', id: 'pg-ob' })),
        h('div', { class: 'pg-col' },
          h('section', { class: 'pg-card pg-sectors', id: 'pg-sectors' }),
          h('section', { class: 'pg-card', id: 'pg-log' })))));
  }

  // replaceChildren null'ı "null" metni olarak yazar
  const put = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
  const busy = () => P.connecting || (P.progress && P.progress.pct !== null);
  const num = (s) => Number(String(s).trim());

  function renderBar() {
    const ext = P.transport === 'uart' || P.transport === 'dfu';
    put($('pg-bar'), 
      h('label', { class: 'hint', for: 'pg-transport', text: t('Bağlantı') }),
      h('select', { id: 'pg-transport', disabled: P.connected || P.connecting, onchange: (e) => { P.transport = e.target.value; renderBar(); } },
        ...TRANSPORTS().map(([v, l]) => h('option', { value: v, selected: v === P.transport, text: l }))),
      P.connected
        ? h('button', { class: 'small', id: 'pg-disconnect', onclick: () => post({ type: 'debug.disconnect' }) }, t('Bağlantıyı kes'))
        : h('button', { class: 'small', id: 'pg-connect', disabled: P.connecting || ext, onclick: () => connect('openocd') }, P.connecting ? t('Bağlanıyor…') : t('Bağlan')),
      P.connected ? null : h('button', { class: 'ghost small', id: 'pg-sim', disabled: P.connecting, title: t('Kart yokken: işlemci verisinden flash haritası ve örnek içerik'), onclick: () => connect('sim') }, t('Simülasyon')),
      h('button', { class: 'ghost small', id: 'pg-refresh', disabled: !P.connected || busy(), onclick: () => post({ type: 'prog.info' }) }, t('Yenile')),
      h('button', { class: 'ghost small', id: 'pg-reset', disabled: !P.connected || busy(), onclick: () => post({ type: 'prog.reset' }) }, t('Reset ve çalıştır')),
      h('span', { class: 'spacer' }),
      h('span', { class: `pg-state${P.connected ? ' on' : ''}`, id: 'pg-state', text: P.connected ? `${P.info ? P.info.mcu + ' · ' : ''}${P.mode === 'sim' ? t('simülasyon') : 'OpenOCD'} · ${P.state || ''}` : t('bağlı değil') }));
    const msg = $('pg-msg');
    const text = ext ? t('UART ve USB DFU üzerinden yükleme ST sistem bootloader\'ı ile yapılır (ES-302); şimdilik SWD ya da JTAG kullanın.') : P.error;
    msg.hidden = !text;
    msg.className = `dbg-msg${P.error && !ext ? ' error' : ''}`;
    msg.textContent = text || '';
  }

  function connect(mode) {
    P.connecting = true;
    P.error = '';
    renderBar();
    post({ type: 'prog.connect', mode, transport: P.transport });
  }

  function progressBar(op) {
    const p = P.progress;
    if (!p || p.op !== op || p.pct === null) return null;
    return h('div', { class: 'pg-progress', role: 'progressbar', 'aria-valuenow': String(p.pct) }, h('div', { style: `width:${p.pct}%` }));
  }

  function renderRead() {
    const custom = P.region === 'custom';
    const info = P.info;
    const off = !P.connected || busy();
    put($('pg-read'), 
      h('h3', { text: t('Oku ve kaydet') }),
      h('div', { class: 'pg-row' },
        h('select', { id: 'pg-region', 'aria-label': t('Bölge'), onchange: (e) => { P.region = e.target.value; renderRead(); } },
          h('option', { value: 'flash', selected: P.region === 'flash', text: `Flash${info ? ` (${info.flashKB} KB)` : ''}` }),
          h('option', { value: 'ram', selected: P.region === 'ram', text: `RAM${info ? ` (${info.ramKB} KB)` : ''}` }),
          h('option', { value: 'custom', selected: custom, text: t('Adres ve uzunluk') })),
        custom ? h('input', { id: 'pg-addr', class: 'mono', value: P.addr, 'aria-label': t('Adres'), placeholder: '0x08000000', oninput: (e) => (P.addr = e.target.value) }) : null,
        custom ? h('input', { id: 'pg-length', class: 'mono', value: P.length, 'aria-label': t('Uzunluk (bayt)'), placeholder: '0x1000', oninput: (e) => (P.length = e.target.value) }) : null,
        h('select', { id: 'pg-format', 'aria-label': t('Biçim'), onchange: (e) => (P.format = e.target.value) },
          h('option', { value: 'bin', selected: P.format === 'bin', text: '.bin' }), h('option', { value: 'hex', selected: P.format === 'hex', text: '.hex' })),
        h('button', { class: 'small', id: 'pg-read-go', disabled: off, onclick: () => post({ type: 'prog.read', region: P.region, addr: num(P.addr), length: num(P.length), format: P.format }) }, t('Oku…'))),
      progressBar('read'));
  }

  function renderCompare() {
    const r = P.compare;
    put($('pg-compare'), 
      h('h3', { text: t('Dosyayla karşılaştır') }),
      h('div', { class: 'pg-row' },
        h('label', { class: 'hint', for: 'pg-base', text: t('.bin başlangıç adresi') }),
        h('input', { id: 'pg-base', class: 'mono', value: P.base, oninput: (e) => (P.base = e.target.value) }),
        h('button', { class: 'small', id: 'pg-compare-go', disabled: !P.connected || busy(), onclick: () => post({ type: 'prog.compare', base: num(P.base) }) }, t('Dosya seç (.elf / .hex / .bin)…'))),
      progressBar('compare'),
      r ? h('div', { class: `pg-result ${r.result.same ? 'ok' : 'diff'}`, id: 'pg-compare-result' },
        h('div', { text: r.result.same ? t('{0}: cihazla aynı ({1} bayt).', r.file, r.result.total) : t('{0}: {1} / {2} bayt farklı, {3} bölge.', r.file, r.result.diff, r.result.total, r.result.rangeCount) }),
        r.result.blankDevice ? h('div', { class: 'hint', text: t('Cihazda bu bölge boş (silinmiş).') }) : null,
        r.result.ranges.length && !r.result.same ? h('table', { class: 'regs pg-diff' },
          h('thead', {}, h('tr', {}, h('th', { text: t('Bölge') }), h('th', { text: t('Bayt') }))),
          h('tbody', {}, ...r.result.ranges.slice(0, 10).map((x) => h('tr', {}, h('td', { class: 'mono', text: `${hex(x.start)} – ${hex(x.end - 1)}` }), h('td', { text: String(x.end - x.start) }))))) : null,
        r.result.first.length && !r.result.same ? h('div', { class: 'hint mono', text: r.result.first.slice(0, 4).map((d) => `${hex(d.addr)}: ${t('dosya')} ${d.file.toString(16).padStart(2, '0')} ≠ ${t('cihaz')} ${d.device.toString(16).padStart(2, '0')}`).join(' · ') }) : null) : null);
  }

  function renderOb() {
    const box = $('pg-ob');
    const ob = P.info && P.info.ob;
    if (!P.info) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'hint', text: t('Bağlanınca okuma koruması (RDP), BOR, yazma koruması ve kullanıcı bitleri burada görünür.') }));
    if (!ob) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'hint', text: t('Bu işlemci ailesi için option byte tanımı yok.') }));
    if (ob.error) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'dbg-msg error', text: ob.error }));
    const prot = (list) => (list.length ? list.map((i) => P.info.sectors[i] ? P.info.sectors[i].num : i).join(', ') : t('yok'));
    put(box, 
      h('h3', { text: t('Option bytes') }),
      h('div', { class: `pg-rdp lvl${String(ob.rdp.level).replace('.', '')}`, id: 'pg-rdp' },
        h('b', { text: `RDP ${hex(ob.rdp.byte, 2)}` }), h('span', { text: ob.rdp.text })),
      h('table', { class: 'regs pg-obt' },
        h('tbody', {},
          ob.bor ? h('tr', {}, h('td', { text: 'BOR' }), h('td', { text: ob.bor })) : null,
          h('tr', {}, h('td', { text: t('Yazma koruması (WRP)') }), h('td', { id: 'pg-wrp', text: prot(ob.wrp) })),
          ob.pcrop.length ? h('tr', {}, h('td', { text: 'PCROP' }), h('td', { text: prot(ob.pcrop) })) : null,
          ...ob.user.map((u) => h('tr', {}, h('td', { class: 'mono', text: u.name }), h('td', { text: `${u.value} · ${u.text}` }))),
          ...ob.registers.map((r) => h('tr', { class: 'pg-raw' }, h('td', { class: 'mono', text: `${r.name} @${hex(r.addr)}` }), h('td', { class: 'mono', text: r.value === undefined ? '—' : hex(r.value) }))))),
      ...ob.notes.map((n) => h('p', { class: 'hint', text: n })),
      h('p', { class: 'hint', text: t('Salt okunur. Option byte yazma (RDP seviyesi, WRP, BOR, boot) kartla denendikten sonra eklenecek; RDP 2 kalıcıdır.') }));
  }

  function renderSectors() {
    const box = $('pg-sectors');
    const info = P.info;
    if (!info || !info.sectors) {
      put(box, h('h3', { text: t('Sektörler') }), h('p', { class: 'hint', text: P.connected ? t('Okunuyor…') : t('Bağlanınca flash sektörleri ya da sayfaları burada listelenir; seçip silebilirsiniz.') }));
      return;
    }
    const list = info.sectors;
    const banks = new Set(list.map((s) => s.phys)).size;
    const off = !P.connected || busy();
    const selSize = list.filter((s) => P.sel.has(s.index)).reduce((n, s) => n + s.size, 0);
    const toggle = (s, e) => {
      if (e.shiftKey && P.last !== null) {
        const [a, b] = [Math.min(P.last, s.index), Math.max(P.last, s.index)];
        for (let i = a; i <= b; i++) P.sel.add(i);
      } else if (P.sel.has(s.index)) P.sel.delete(s.index);
      else P.sel.add(s.index);
      P.last = s.index;
      renderSectors();
    };
    put(box, 
      h('h3', { text: t('Sektörler ({0})', list.length) }),
      h('div', { class: 'pg-row' },
        h('button', { class: 'small danger', id: 'pg-erase-sel', disabled: off || !P.sel.size, onclick: () => post({ type: 'prog.erase', indexes: [...P.sel] }) }, P.sel.size ? t('Seçilenleri sil ({0}, {1})', P.sel.size, size(selSize)) : t('Seçilenleri sil')),
        h('button', { class: 'ghost small danger', id: 'pg-erase-all', disabled: off, onclick: () => post({ type: 'prog.erase', all: true }) }, t('Tamamını sil')),
        h('button', { class: 'ghost small', id: 'pg-sel-none', disabled: !P.sel.size, onclick: () => { P.sel.clear(); renderSectors(); } }, t('Seçimi temizle')),
        h('span', { class: 'hint', text: info.source === 'static' ? t('işlemci verisinden') : info.source === 'sim' ? t('simülasyon') : t('OpenOCD\'den') })),
      progressBar('erase'),
      h('div', { class: 'pg-table' },
        h('table', { class: 'regs' },
          h('thead', {}, h('tr', {}, h('th', {}), h('th', { text: '#' }), banks > 1 ? h('th', { text: 'Bank' }) : null, h('th', { text: t('Adres') }), h('th', { text: t('Boyut') }), h('th', { text: t('Durum') }))),
          h('tbody', {}, ...list.map((s) => h('tr', { class: P.sel.has(s.index) ? 'sel' : '', onclick: (e) => { if (e.target.tagName !== 'INPUT') toggle(s, e); } },
            h('td', {}, h('input', { type: 'checkbox', id: `pg-s-${s.index}`, 'aria-label': t('Sektör {0}', s.num), checked: P.sel.has(s.index), onclick: (e) => { e.preventDefault(); toggle(s, e); } })),
            h('td', { class: 'mono', text: String(s.num) }),
            banks > 1 ? h('td', { text: String(s.phys) }) : null,
            h('td', { class: 'mono', text: hex(s.addr) }),
            h('td', { text: size(s.size) }),
            h('td', { class: s.protected ? 'warn' : 'hint', text: s.protected ? t('yazma korumalı') : '' })))))),
      h('p', { class: 'hint', text: t('Shift + tık ile aralık seçilir. Silmeden önce hedef durdurulur.') }));
  }
  const size = (n) => (n >= 1048576 ? `${n / 1048576} MB` : n >= 1024 ? `${n / 1024} KB` : `${n} B`);

  function renderLog() {
    const box = $('pg-log');
    put(box, 
      h('h3', {}, t('İşlem günlüğü'), h('button', { class: 'ghost small', id: 'pg-log-clear', style: 'margin-left:auto', disabled: !P.log.length, onclick: () => { P.log = []; renderLog(); } }, t('Temizle'))),
      h('div', { class: 'pg-logl', id: 'pg-log-list' }, ...(P.log.length ? P.log.slice().reverse().map((e) => h('div', { class: `pg-le ${e.level}` },
        h('span', { class: 'mono hint', text: new Date(e.at).toLocaleTimeString() }), h('span', { text: e.text }))) : [h('div', { class: 'hint', text: t('Henüz işlem yok.') })])));
  }

  function render() {
    if (!$('programmer')) return;
    renderBar();
    renderRead();
    renderCompare();
    renderOb();
    renderSectors();
    renderLog();
  }

  ES.on('debug.status', (m) => {
    P.connected = !!m.connected;
    P.connecting = !!m.connecting;
    if (m.mode) P.mode = m.mode;
    P.state = m.state || '';
    P.error = m.error || '';
    if (!P.connected) { P.info = null; P.sel.clear(); P.progress = null; }
    render();
  });
  ES.on('prog.info', (m) => {
    if (m.error) { P.error = m.error; return renderBar(); }
    P.info = m;
    for (const i of [...P.sel]) if (!m.sectors[i]) P.sel.delete(i);
    render();
  });
  ES.on('prog.progress', (m) => {
    P.progress = m;
    renderBar();
    if (m.op === 'read') renderRead();
    else if (m.op === 'compare') renderCompare();
    else renderSectors();
  });
  ES.on('prog.compare', (m) => {
    P.compare = m;
    renderCompare();
  });
  ES.on('prog.log', (m) => {
    P.log = [...P.log, m.entry].slice(-500);
    if (m.entry.level === 'ok' && P.progress && P.progress.op === 'erase') P.sel.clear();
    renderLog();
  });
  ES.on('prog.history', (m) => {
    P.log = m.entries || [];
    renderLog();
  });

  ES.tabs.programmer = { mount, render, onShow: render };
})();
