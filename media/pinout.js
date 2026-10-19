/* Pinout sekmesi (ES-1004): işlemci paketi pin pin, CubeMX'teki "Pinout view" gibi. Veri: mcu.package (ES-1002),
 * atama sonucu (bağlantılar, kilitler), pin etiketleri (ES-1003). Yalnızca görüntüler; pine tıklayarak atama ES-1005. */
(function () {
  const { t, h, s, $, state, ui, saveUi, showTip, placeTip, hideTip, icon } = ES;
  const PITCH = 18, PAD_LEN = 30, PAD_W = 12, MARGIN = 24, TEXT_GAP = 6, LABEL_ROOM = 120;
  const SIDES = ['left', 'bottom', 'right', 'top'];
  let view = null; // { x, y, w, h }
  let query = '';
  let drag = null;

  function mount(parent) {
    parent.append(h('main', { id: 'pinout', class: 'tab-pane' },
      h('div', { class: 'po-bar' },
        h('span', { class: 'po-title', id: 'po-title' }),
        h('span', { class: 'spacer' }),
        h('div', { class: 'search po-search' }, icon('search', 13),
          h('input', { type: 'text', id: 'po-search', placeholder: t('Pin, sinyal ya da etiket ara'), 'aria-label': t('Pin ara'), oninput: (e) => { query = e.target.value.trim(); render(); } })),
        h('span', { class: 'hint', id: 'po-found' }),
        h('button', { class: 'ghost small icon', id: 'po-zoom-in', title: t('Yakınlaştır'), 'aria-label': t('Yakınlaştır'), onclick: () => zoom(0.8) }, '+'),
        h('button', { class: 'ghost small icon', id: 'po-zoom-out', title: t('Uzaklaştır'), 'aria-label': t('Uzaklaştır'), onclick: () => zoom(1.25) }, '−'),
        h('button', { class: 'ghost small', id: 'po-fit', title: t('Sığdır'), onclick: () => { view = null; render(); } }, icon('fit', 13), t('Sığdır')),
        h('button', { class: 'ghost small', id: 'po-rotate', title: t('90° döndür'), onclick: () => { ui.pinoutRot = ((ui.pinoutRot || 0) + 1) % 4; saveUi(); view = null; render(); } }, '⟳ 90°')),
      h('div', { class: 'po-wrap', id: 'po-wrap' },
        s('svg', { id: 'po-svg', tabindex: '0', 'aria-label': t('İşlemci paketi pin görünümü') }),
        h('div', { class: 'po-legend' },
          ...[['ok', t('Atanmış')], ['warn', t('Sorunlu (kilit / etiket)')], ['sys', t('Sistem (SWD, OSC, NRST)')], ['power', t('Besleme / özel')], ['free', t('Boş G/Ç')]]
            .map(([k, l]) => h('span', { class: `po-key ${k}` }, h('i'), l)),
          h('span', { class: 'po-key' }, h('b', { text: '●' }), t('sabit pin'))))));
    const svg = $('po-svg');
    svg.addEventListener('wheel', (e) => { e.preventDefault(); zoom(e.deltaY > 0 ? 1.15 : 0.87, e); }, { passive: false });
    svg.addEventListener('mousedown', (e) => { if (e.button === 0) drag = { x: e.clientX, y: e.clientY, v: { ...view } }; });
    window.addEventListener('mousemove', (e) => {
      if (!drag || !view) return;
      const r = svg.getBoundingClientRect();
      const k = Math.max(view.w / r.width, view.h / r.height);
      view = { ...drag.v, x: drag.v.x - (e.clientX - drag.x) * k, y: drag.v.y - (e.clientY - drag.y) * k };
      applyView();
    });
    window.addEventListener('mouseup', () => { drag = null; });
  }

  function zoom(f, e) {
    if (!view) return;
    const svg = $('po-svg');
    const r = svg.getBoundingClientRect();
    // İmlecin altındaki nokta yerinde kalsın
    let cx = view.x + view.w / 2, cy = view.y + view.h / 2;
    if (e && r.width) {
      const k = Math.max(view.w / r.width, view.h / r.height);
      cx = view.x + view.w / 2 + (e.clientX - r.left - r.width / 2) * k;
      cy = view.y + view.h / 2 + (e.clientY - r.top - r.height / 2) * k;
    }
    view = { x: cx - (cx - view.x) * f, y: cy - (cy - view.y) * f, w: view.w * f, h: view.h * f };
    applyView();
  }
  function applyView() {
    const svg = $('po-svg');
    if (view) svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
  }

  /** Pedin durumu ve yanında yazacak metin */
  function padInfo(mcu, pad) {
    const gpio = pad.gpio;
    const conns = gpio ? state.result.connections.filter((c) => c.mcuPin === gpio) : [];
    const label = gpio && (state.design.pinLabels || {})[gpio];
    const appPin = gpio && mcu.pins.find((p) => p.name === gpio);
    const lockKeys = Object.entries(state.design.locks || {}).filter(([, v]) => v === gpio).map(([k]) => k);
    const lockBad = lockKeys.some((k) => (state.result.lockIssues || {})[k]);
    const labelBad = gpio && (state.result.labelIssues || {})[gpio];
    const inst = (id) => (state.design.instances.find((i) => i.id === id) || { label: id }).label;
    let cls = 'free', text = '';
    if (pad.type !== 'io') cls = pad.type === 'nc' ? 'nc' : 'power';
    else if (appPin && appPin.reserved) { cls = 'sys'; text = appPin.reserved; }
    if (conns.length) {
      cls = 'ok';
      const sig = conns[0].signal;
      // GPIO: komponent pini (CubeMX'te etiket yoksa sinyal); çevre birimi sinyalinde sinyal adı. Ayrıntı bilgi kartında
      text = /^GPIO_/.test(sig) ? [...new Set(conns.map((c) => `${inst(c.instId)}.${c.compPin}`))].join(', ') : sig;
    }
    if (label) text = label;
    if (lockBad || labelBad) cls = 'warn';
    return { cls, text, conns, label, lockKeys, lockBad, labelBad, appPin, pinned: lockKeys.length > 0 };
  }

  /** Arama: pin adı, GPIO, etiket, atanmış ya da olası sinyal */
  function matches(pad, info) {
    if (!query) return false;
    const q = query.toLowerCase();
    const hay = [pad.name, pad.gpio, pad.pos, info.label, info.text, ...(pad.signals || []).map((x) => x.signal)].filter(Boolean).map((x) => String(x).toLowerCase());
    return hay.some((x) => x === q || x.includes(q));
  }

  /** İpucu kartı: no, ad, tür, kullanım, kart notu, bütün alternatif işlevler */
  function card(mcu, pad, info) {
    const TYPE = { io: t('G/Ç'), power: t('Besleme'), reset: t('Reset'), boot: t('Boot'), mono: t('Tek işlevli'), nc: t('Bağlantısız'), other: t('Diğer') };
    const inst = (id) => (state.design.instances.find((i) => i.id === id) || { label: id }).label;
    const sigs = pad.signals || [];
    return h('div', { class: 'po-card' },
      h('div', { class: 'po-card-head' }, h('b', { text: `${pad.pos} · ${pad.name}` }), h('span', { class: 'hint', text: TYPE[pad.type] || pad.type })),
      info.label ? h('div', { text: t('Etiket: {0}', info.label) }) : null,
      info.conns.length ? h('div', { class: 'po-use' }, ...info.conns.map((c) => h('div', { text: `${c.signal} → ${inst(c.instId)}.${c.compPin}${c.af !== undefined ? ` (AF${c.af})` : ''}${c.locked ? ' ●' : ''}` }))) : null,
      info.appPin && info.appPin.reserved ? h('div', { class: 'hint', text: t('Ayrılmış: {0}', info.appPin.reserved) }) : null,
      (mcu.boardPins || {})[pad.gpio] ? h('div', { class: 'hint', text: t('Kartta: {0}', mcu.boardPins[pad.gpio]) }) : null,
      info.lockBad ? h('div', { class: 'dbg-msg error', text: info.lockKeys.map((k) => state.result.lockIssues[k]).filter(Boolean).join(' ') }) : null,
      info.labelBad ? h('div', { class: 'dbg-msg error', text: info.labelBad }) : null,
      pad.modes && pad.modes.length ? h('div', { class: 'hint', text: `GPIO: ${pad.modes.join(', ')}` }) : null,
      sigs.length ? h('div', { class: 'po-sigs' }, ...sigs.map((x) => h('span', { text: x.af !== undefined ? `${x.signal} AF${x.af}` : x.remap ? `${x.signal} (remap)` : x.signal }))) : null,
      ES.tabs.pinout.alternates(mcu, pad).map((a) => h('div', { class: 'hint', text: t('Aynı pedde: {0}', a.name) })));
  }

  /** Kenarlı paket: ped konumu (döndürmeyle) */
  function sideGeom(pkg, pos, rot) {
    const n = Number(pos);
    const per = pkg.pinCount / pkg.sides;
    const order = pkg.sides === 4 ? SIDES : ['left', 'right'];
    const raw = Math.floor((n - 1) / per);
    const idx = (n - 1) % per;
    const side = pkg.sides === 4 ? SIDES[(SIDES.indexOf(order[raw]) + rot) % 4] : order[(raw + (rot % 2 ? 1 : 0)) % 2];
    return { side, idx, per };
  }

  function render() {
    if (!state.design || !$('pinout')) return;
    const mcu = state.lib.mcus[state.design.mcuId];
    const pkg = mcu && mcu.package;
    const svg = $('po-svg');
    $('po-title').textContent = pkg ? `${mcu.name} · ${pkg.name}` : mcu ? mcu.name : '';
    if (!pkg) { svg.replaceChildren(); return; }
    const rot = ui.pinoutRot || 0;
    const pads = pkg.pins.filter((p) => !p.alt);
    const g = s('g');
    let found = 0;
    let bounds;
    if (pkg.grid) bounds = drawGrid(g, mcu, pkg, pads, (n) => (found += n));
    else bounds = drawSides(g, mcu, pkg, pads, rot, (n) => (found += n));
    svg.replaceChildren(g);
    if (!view) view = { ...bounds };
    applyView();
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    $('po-found').textContent = query ? t('{0} pin bulundu', found) : '';
  }

  function padGroup(mcu, pad, x, y, w, hgt, text, textAttr, count) {
    const info = padInfo(mcu, pad);
    const hit = matches(pad, info);
    if (hit) count(1);
    const gg = s('g', {
      class: `po-pad ${info.cls}${hit ? ' found' : ''}${info.pinned ? ' pinned' : ''}`, 'data-pos': pad.pos, 'data-pin': pad.gpio || pad.name,
      onmouseenter: (e) => showTip(e.clientX, e.clientY, card(mcu, pad, info), 150),
      onmousemove: (e) => placeTip(e.clientX, e.clientY),
      onmouseleave: () => hideTip()
    },
    s('rect', { class: 'po-box', x, y, width: w, height: hgt, rx: 1.5 }));
    gg.append(s('text', { class: 'po-name', ...text }, s('tspan', { text: pad.gpio || shortName(pad.name) })));
    if (info.text) gg.append(s('text', { class: 'po-sig', ...textAttr, text: info.text.length > 24 ? info.text.slice(0, 23) + '…' : info.text }));
    if (info.pinned) gg.append(s('circle', { class: 'po-pin-mark', cx: x + w - 3.5, cy: y + 3.5, r: 2.2 }));
    return gg;
  }
  const shortName = (n) => n.replace(/\s.*$/, '').replace(/-.*$/, '');

  function drawSides(g, mcu, pkg, pads, rot, count) {
    const per = pkg.pinCount / pkg.sides;
    const body = per * PITCH + 2 * MARGIN;
    const W = pkg.sides === 4 ? body : 200, H = body;
    g.append(s('rect', { class: 'po-body', x: 0, y: 0, width: W, height: H, rx: 4 }));
    g.append(s('text', { class: 'po-chip', x: W / 2, y: H / 2 - 6, 'text-anchor': 'middle', text: mcu.name }));
    g.append(s('text', { class: 'po-pkg', x: W / 2, y: H / 2 + 12, 'text-anchor': 'middle', text: pkg.name }));
    // 1. pin işareti: döndürmeden önce sol üst köşe
    const p1 = sideGeom(pkg, '1', rot);
    const dot = { left: [10, 10], bottom: [10, H - 10], right: [W - 10, H - 10], top: [W - 10, 10] }[p1.side];
    g.append(s('circle', { class: 'po-dot', cx: dot[0], cy: dot[1], r: 4 }));
    for (const pad of pads) {
      const { side, idx } = sideGeom(pkg, pad.pos, rot);
      // Kenar boyunca sıra yönü: sol ↓, alt →, sağ ↑, üst ←
      const along = MARGIN + (idx + 0.5) * PITCH;
      let x, y, w, hh, text, sig;
      if (side === 'left') {
        const cy = along;
        [x, y, w, hh] = [-PAD_LEN, cy - PAD_W / 2, PAD_LEN, PAD_W];
        text = { x: -PAD_LEN / 2, y: cy + 3, 'text-anchor': 'middle' };
        sig = { x: -PAD_LEN - TEXT_GAP, y: cy + 3, 'text-anchor': 'end' };
      } else if (side === 'right') {
        const cy = H - along;
        [x, y, w, hh] = [W, cy - PAD_W / 2, PAD_LEN, PAD_W];
        text = { x: W + PAD_LEN / 2, y: cy + 3, 'text-anchor': 'middle' };
        sig = { x: W + PAD_LEN + TEXT_GAP, y: cy + 3, 'text-anchor': 'start' };
      } else if (side === 'bottom') {
        const cx = along;
        [x, y, w, hh] = [cx - PAD_W / 2, H, PAD_W, PAD_LEN];
        text = { x: cx + 3, y: H + PAD_LEN / 2, 'text-anchor': 'middle', transform: `rotate(-90 ${cx + 3} ${H + PAD_LEN / 2})` };
        sig = { x: cx + 3, y: H + PAD_LEN + TEXT_GAP, 'text-anchor': 'end', transform: `rotate(-90 ${cx + 3} ${H + PAD_LEN + TEXT_GAP})` };
      } else {
        const cx = W - along;
        [x, y, w, hh] = [cx - PAD_W / 2, -PAD_LEN, PAD_W, PAD_LEN];
        text = { x: cx + 3, y: -PAD_LEN / 2, 'text-anchor': 'middle', transform: `rotate(-90 ${cx + 3} ${-PAD_LEN / 2})` };
        sig = { x: cx + 3, y: -PAD_LEN - TEXT_GAP, 'text-anchor': 'start', transform: `rotate(-90 ${cx + 3} ${-PAD_LEN - TEXT_GAP})` };
      }
      g.append(padGroup(mcu, pad, x, y, w, hh, text, sig, count));
    }
    const m = PAD_LEN + LABEL_ROOM;
    return { x: -m, y: -m, w: W + 2 * m, h: H + 2 * m };
  }

  /** BGA / WLCSP: satır harfi, sütun numarası */
  function drawGrid(g, mcu, pkg, pads, count) {
    const rows = [...new Set(pads.map((p) => p.pos.replace(/\d+$/, '')))].sort();
    const cols = Math.max(...pads.map((p) => Number(p.pos.replace(/^\D+/, '')) || 0));
    const C = 40;
    const W = cols * C + 2 * MARGIN, H = rows.length * C + 2 * MARGIN;
    g.append(s('rect', { class: 'po-body', x: 0, y: 0, width: W, height: H, rx: 4 }));
    for (const pad of pads) {
      const r = rows.indexOf(pad.pos.replace(/\d+$/, ''));
      const c = (Number(pad.pos.replace(/^\D+/, '')) || 1) - 1;
      const x = MARGIN + c * C + 4, y = MARGIN + r * C + 4;
      g.append(padGroup(mcu, pad, x, y, C - 8, C - 8, { x: x + (C - 8) / 2, y: y + 13, 'text-anchor': 'middle' }, { x: x + (C - 8) / 2, y: y + C - 12, 'text-anchor': 'middle' }, count));
    }
    return { x: -20, y: -20, w: W + 40, h: H + 40 };
  }

  /** Aynı pedin ikincil girdileri (G0: PA9 [PA11]) */
  const alternates = (mcu, pad) => mcu.package.pins.filter((p) => p.alt && p.pos === pad.pos);

  ES.tabs.pinout = {
    mount,
    render: () => { if (ui.tab === 'pinout') render(); },
    onShow: () => render(),
    alternates,
    resetView: () => { view = null; }
  };
  // İşlemci değişince görünüm yeniden sığdırılır
  let lastMcu = null;
  ES.on('state', () => { if (state.design && state.design.mcuId !== lastMcu) { lastMcu = state.design.mcuId; view = null; } });
})();
