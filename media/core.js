/* Embedded Studio webview ortak altyapısı: DOM yardımcıları, mesajlaşma, durum,
 * sağ tık menüsü, modal pencere, açılır kart (popover) ve bildirimler. */
window.ES = (function () {
  // @ts-ignore - webview ortamında tanımlı
  const vscode = acquireVsCodeApi();
  const SVG = 'http://www.w3.org/2000/svg';

  function build(ns, tag, props, children) {
    const el = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'text') el.textContent = String(v);
      else if (k === 'html') el.innerHTML = v; // sadece sabit ikon SVG'leri için
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else el.setAttribute(k, String(v));
    }
    for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c);
    return el;
  }
  const h = (tag, props = {}, ...children) => build(null, tag, props, children);
  const s = (tag, props = {}, ...children) => build(SVG, tag, props, children);
  const $ = (id) => document.getElementById(id);
  const cIdent = (x) => x.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const { t } = window.ESI18N;

  // ---- mesajlaşma ----
  const listeners = {};
  const on = (type, fn) => (listeners[type] = listeners[type] || []).push(fn);
  const emit = (type, msg) => (listeners[type] || []).forEach((fn) => fn(msg));
  window.addEventListener('message', (ev) => emit(ev.data.type, ev.data));
  const post = (msg) => vscode.postMessage(msg);

  // ---- durum ----
  const state = { lib: null, design: null, result: null, notes: [], clock: null, project: null };
  const ui = Object.assign({ tab: 'design', rightPanel: true, assistantOpen: true }, vscode.getState() || {});
  const saveUi = () => vscode.setState(ui);
  // ---- geri al / yinele ----
  // Tasarımdaki her değişiklik update() ile eklentiye gider ve eklenti 'state' ile geri yollar.
  // Değişiklikten önceki hali saklarız; eklentinin kendi yaptığı değişiklikler (ör. clock çözümü) de kaydedilir.
  const hist = { undo: [], redo: [], last: null, lastAt: 0, echo: 0, root: undefined };
  const HIST_MAX = 100;
  const remember = (snap) => {
    hist.undo.push(snap);
    if (hist.undo.length > HIST_MAX) hist.undo.shift();
    hist.redo = [];
  };
  const send = () => { hist.echo++; post({ type: 'update', design: state.design }); };
  const update = () => {
    const now = JSON.stringify(state.design);
    // Art arda gelen küçük değişiklikler (ör. sürükleme) tek adım sayılır
    if (hist.last && hist.last !== now && (Date.now() - hist.lastAt > 400 || !hist.undo.length)) remember(hist.last);
    hist.lastAt = Date.now();
    hist.last = now;
    send();
  };
  function step(from, to) {
    if (!state.design || !from.length) return false;
    to.push(JSON.stringify(state.design));
    hist.last = from.pop();
    hist.lastAt = 0;
    state.design = JSON.parse(hist.last);
    send();
    return true;
  }
  const undo = () => step(hist.undo, hist.redo);
  const redo = () => step(hist.redo, hist.undo);
  on('state', (m) => {
    const root = m.project && m.project.root;
    if (root !== hist.root) Object.assign(hist, { undo: [], redo: [], last: null, root });
    const now = JSON.stringify(m.design);
    if (hist.echo > 0) hist.echo--;
    else if (hist.last && hist.last !== now) remember(hist.last);
    hist.last = now;
  });

  // ---- ikonlar (sabit SVG) ----
  const icon = (name, size = 16) => {
    const paths = {
      pdf: '<path d="M4 1h6l4 4v10H4z" fill="none" stroke="currentColor"/><path d="M10 1v4h4" fill="none" stroke="currentColor"/><rect x="1" y="8" width="10" height="5" rx="1" fill="#e5484d"/><text x="6" y="12" font-size="4.2" font-weight="700" text-anchor="middle" fill="#fff" font-family="sans-serif">PDF</text>',
      trash: '<path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      mirror: '<path d="M8 1v14" stroke="currentColor" stroke-dasharray="2 1.5"/><path d="M6 4L2 8l4 4zM10 4l4 4-4 4z" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      link: '<path d="M6.5 9.5l3-3M7 4.5l1.5-1.5a2.5 2.5 0 013.5 3.5L10.5 8M9 11.5L7.5 13a2.5 2.5 0 01-3.5-3.5L5.5 8" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.4"/>',
      fit: '<path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      clock: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      panel: '<rect x="1.5" y="2.5" width="13" height="11" rx="1" fill="none" stroke="currentColor"/><path d="M10 2.5v11" stroke="currentColor"/>',
      chevron: '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.4"/>',
      close: '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4"/>',
      upload: '<path d="M8 11V2M4.5 5.5L8 2l3.5 3.5M2 11v3h12v-3" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      file: '<path d="M4 1h6l3 3v11H4z M10 1v3h3" fill="none" stroke="currentColor" stroke-width="1.1"/>',
      undo: '<path d="M5.5 3L2.5 6l3 3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M3 6h6.5a3.5 3.5 0 010 7H6" fill="none" stroke="currentColor" stroke-width="1.3"/>',
      redo: '<path d="M10.5 3l3 3-3 3" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M13 6H6.5a3.5 3.5 0 000 7H10" fill="none" stroke="currentColor" stroke-width="1.3"/>',
      chip: '<rect x="4" y="4" width="8" height="8" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 1v3M10 1v3M6 12v3M10 12v3M1 6h3M1 10h3M12 6h3M12 10h3" stroke="currentColor" stroke-width="1.3"/>',
      play: '<path d="M4 2.5v11l9-5.5z" fill="currentColor"/>',
      pause: '<path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" fill="currentColor"/>',
      step: '<path d="M3 3v10l6-5zM10 3h2v10h-2z" fill="currentColor"/>',
      reset: '<path d="M3 8a5 5 0 109-3M12 1.5V5H8.5" fill="none" stroke="currentColor" stroke-width="1.4"/>',
      edit: '<path d="M2 14l1-4 8-8 3 3-8 8zM9.5 3.5l3 3" fill="none" stroke="currentColor" stroke-width="1.2"/>',
      drag: '<circle cx="6" cy="4" r="1.1" fill="currentColor"/><circle cx="10" cy="4" r="1.1" fill="currentColor"/><circle cx="6" cy="8" r="1.1" fill="currentColor"/><circle cx="10" cy="8" r="1.1" fill="currentColor"/><circle cx="6" cy="12" r="1.1" fill="currentColor"/><circle cx="10" cy="12" r="1.1" fill="currentColor"/>',
      search: '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.4"/>'
    };
    return h('span', { class: 'ic', html: `<svg viewBox="0 0 16 16" width="${size}" height="${size}" aria-hidden="true">${paths[name] || ''}</svg>` });
  };

  // ---- sağ tık menüsü ----
  let menuEl = null;
  function closeMenu() {
    if (menuEl) menuEl.remove();
    menuEl = null;
  }
  /** items: [{ label, icon, hint, action, disabled, danger, submenu: () => HTMLElement } | '-'] */
  function contextMenu(x, y, items) {
    closeMenu();
    const menu = h('div', { class: 'ctx-menu', role: 'menu' });
    for (const it of items) {
      if (it === '-') { menu.append(h('div', { class: 'ctx-sep' })); continue; }
      const row = h('div', {
        class: `ctx-item${it.disabled ? ' disabled' : ''}${it.danger ? ' danger' : ''}${it.submenu ? ' has-sub' : ''}`,
        role: 'menuitem', tabindex: '-1',
        onclick: (e) => {
          e.stopPropagation();
          if (it.disabled || it.submenu) return;
          closeMenu();
          it.action && it.action();
        }
      }, it.icon ? icon(it.icon, 14) : h('span', { class: 'ic' }), h('span', { class: 'ctx-label', text: it.label }), it.hint ? h('span', { class: 'ctx-hint', text: it.hint }) : null);
      if (it.submenu) {
        row.append(h('span', { class: 'ctx-arrow', text: '›' }));
        row.addEventListener('mouseenter', () => {
          menu.querySelectorAll('.ctx-sub').forEach((el) => el.remove());
          const sub = h('div', { class: 'ctx-menu ctx-sub' }, it.submenu());
          row.append(sub);
          const r = sub.getBoundingClientRect();
          if (r.right > window.innerWidth) sub.classList.add('flip');
          if (r.bottom > window.innerHeight) sub.style.top = `${Math.max(-row.offsetTop, window.innerHeight - r.bottom - 8)}px`;
          const input = sub.querySelector('input');
          if (input) input.focus();
        });
      } else {
        row.addEventListener('mouseenter', () => menu.querySelectorAll('.ctx-sub').forEach((el) => el.remove()));
      }
      menu.append(row);
    }
    document.body.append(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, window.innerWidth - r.width - 6)}px`;
    menu.style.top = `${Math.min(y, window.innerHeight - r.height - 6)}px`;
    menuEl = menu;
  }
  document.addEventListener('mousedown', (e) => { if (menuEl && !menuEl.contains(e.target)) closeMenu(); });
  window.addEventListener('blur', closeMenu);

  // ---- modal pencere ----
  /** { title, body, buttons: [{ label, primary, action, id }], width, className,
   *    beforeClose: () => false ise kapatma iptal (ör. kaydedilmemiş değişiklik) } */
  function modal(opts) {
    hideTip();
    closeMenu();
    const close = (force) => {
      if (!force && opts.beforeClose && opts.beforeClose() === false) return;
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      opts.onClose && opts.onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const overlay = h('div', { class: 'modal-overlay', onmousedown: (e) => { if (e.target === overlay) close(); } },
      h('div', { class: `modal${opts.className ? ' ' + opts.className : ''}`, role: 'dialog', 'aria-label': opts.title, style: opts.width ? `width:${opts.width}px` : null },
        h('div', { class: 'modal-head' }, h('span', { class: 'modal-title', text: opts.title }), h('button', { class: 'icon', title: t('Kapat'), onclick: () => close() }, icon('close', 14))),
        h('div', { class: 'modal-body' }, opts.body),
        h('div', { class: 'modal-foot' }, opts.footLeft || null, opts.footLeft ? h('span', { class: 'spacer' }) : null, ...(opts.buttons || []).map((b) => h('button', {
          class: b.primary ? '' : 'ghost', id: b.id,
          onclick: async () => {
            const r = b.action ? await b.action() : undefined;
            if (r === false) return;
            close(r === 'force');
          }
        }, b.label)))));
    document.body.append(overlay);
    document.addEventListener('keydown', onKey);
    return { close };
  }

  // ---- açılır kart (hover popover) ----
  let tipEl = null, tipTimer = 0;
  function showTip(x, y, content, delay = 350) {
    clearTimeout(tipTimer);
    tipTimer = setTimeout(() => {
      if (document.querySelector('.modal-overlay')) return; // pencere açıkken arkadaki kartlar görünmesin
      hideTip();
      tipEl = h('div', { class: 'popover' }, content);
      document.body.append(tipEl);
      placeTip(x, y);
    }, delay);
  }
  function placeTip(x, y) {
    if (!tipEl) return;
    const r = tipEl.getBoundingClientRect();
    let left = x + 16, top = y + 12;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 16;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    tipEl.style.left = `${Math.max(8, left)}px`;
    tipEl.style.top = `${top}px`;
  }
  function hideTip() {
    clearTimeout(tipTimer);
    if (tipEl) tipEl.remove();
    tipEl = null;
  }

  // ---- bildirim ----
  function toast(level, text) {
    let box = $('toasts');
    if (!box) document.body.append((box = h('div', { id: 'toasts', 'aria-live': 'polite' })));
    // Aynı mesaj üst üste gelmesin; en fazla 4 bildirim; hatalar daha uzun kalır, tıklayınca kapanır.
    for (const old of box.children) if (old.textContent === text) old.remove();
    while (box.children.length >= 4) box.firstChild.remove();
    const el = h('div', { class: `toast ${level}`, role: level === 'error' ? 'alert' : 'status', title: t('Kapatmak için tıklayın') }, h('span', { text }));
    const close = () => { el.classList.add('out'); setTimeout(() => el.remove(), 400); };
    el.onclick = close;
    box.append(el);
    setTimeout(close, level === 'error' ? 9000 : level === 'warn' ? 6500 : 4200);
  }
  on('toast', (m) => toast(m.level, m.text));

  const isTyping = () => {
    const a = document.activeElement;
    return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
  };
  const hex = (v, w = 8) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
  const KIND_LABEL = { i2c: 'I2C', spi: 'SPI', uart: 'UART', gpio: 'GPIO', adc: 'ADC', pwm: 'PWM' };

  return { t, h, s, $, cIdent, on, emit, post, state, ui, saveUi, update, undo, redo, canUndo: () => hist.undo.length > 0, canRedo: () => hist.redo.length > 0, icon, contextMenu, closeMenu, modal, showTip, placeTip, hideTip, toast, isTyping, hex, KIND_LABEL, tabs: {} };
})();
