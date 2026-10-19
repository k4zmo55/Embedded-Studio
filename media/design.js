/* Tasarım sekmesi: kütüphane, KiCad tarzı şema, bağlantılar, asistan. */
(function () {
  const { t, h, s, $, cIdent, post, state, ui, saveUi, update, icon, contextMenu, closeMenu, modal, showTip, hideTip, placeTip, toast, isTyping, KIND_LABEL } = ES;

  let view = null;
  let lastLayoutKey = '';
  let userView = false; // kullanıcı yakınlaştırdı/kaydırdıysa yerleşim değişince görünümü bozma
  let highlight = null;
  let selected = null;
  let libFilter = '';
  const conversation = [];

  // ================================================================ iskelet
  function mount(parent) {
    parent.append(h('main', { id: 'design', class: 'tab-pane' },
      h('aside', { class: 'lib-pane' },
        h('div', { class: 'pane-head' },
          h('span', { class: 'pane-title', text: t('Kütüphane') }),
          h('button', { class: 'small', id: 'lib-add', title: t('Kütüphaneye komponent dosyası ekle'), onclick: (e) => libAddMenu(e) }, icon('plus', 12), t('Ekle'))),
        h('div', { class: 'search' }, icon('search', 13),
          h('input', { type: 'text', id: 'lib-search', placeholder: t('Ara: sensör, I2C, gps…'), oninput: (e) => { libFilter = e.target.value.toLocaleLowerCase('tr'); renderLibrary(); } })),
        h('div', { id: 'library' })),
      h('div', { class: 'canvas-wrap', id: 'canvas-wrap' },
        // ES-1008: şema ile yalnızca işlemci (Pinout) görünümü arasında geçiş; aynı tasarım verisi
        h('div', { class: 'view-toggle', role: 'tablist', 'aria-label': t('Görünüm') },
          h('button', { id: 'view-schematic', role: 'tab', class: 'small', onclick: () => setView('schematic') }, t('Şema')),
          h('button', { id: 'view-pinout', role: 'tab', class: 'small', onclick: () => setView('pinout') }, 'Pinout')),
        h('div', { id: 'design-pinout', class: 'design-pinout', hidden: true }),
        s('svg', { id: 'schematic', tabindex: '0', 'aria-label': t('Devre şeması') }),
        h('div', { class: 'canvas-tools' },
          h('button', { class: 'ghost small icon', id: 'undo', title: t('Geri al (Ctrl+Z)'), 'aria-label': t('Geri al'), onclick: () => ES.undo() }, icon('undo', 14)),
          h('button', { class: 'ghost small icon', id: 'redo', title: t('Yinele (Ctrl+Y)'), 'aria-label': t('Yinele'), onclick: () => ES.redo() }, icon('redo', 14)),
          h('button', { class: 'ghost small', title: t('Şemayı sığdır'), onclick: () => { view = null; renderSchematic(); } }, icon('fit', 13), t('Sığdır'))),
        h('div', { class: 'legend' }, ...Object.entries(KIND_LABEL).map(([k, l]) => h('span', { class: `k-${k}`, text: l }))),
        h('div', { class: 'canvas-hint', id: 'canvas-hint', text: t('Sağ tık: ekle · Komponente sağ tık: bağlantılar, aynala, datasheet, sil · Del: seçiliyi sil') })),
      h('aside', { class: 'right-pane', id: 'right-pane' },
        h('div', { class: 'pane-head' },
          h('span', { class: 'pane-title', text: t('Bağlantılar') }),
          h('span', { class: 'spacer' }),
          h('button', { class: 'ghost small', id: 'pinned-btn', title: t('Elle sabitlenmiş pinler'), onclick: () => openPinned() }, t('Sabit pinler')),
          h('button', { class: 'icon', title: t('Paneli kapat'), onclick: () => setRightPanel(false) }, icon('close', 13))),
        h('details', { id: 'notes-box', class: 'notes-box', ontoggle: (e) => { ui.notesOpen = e.target.open; saveUi(); } },
          h('summary', {}, h('span', { text: t('Asistan notları') }), h('span', { id: 'notes-badges' })),
          h('div', { class: 'notes', id: 'notes' })),
        h('div', { id: 'conns' })),
      h('section', { class: 'dock', id: 'dock' },
        h('div', { class: 'dock-head', onclick: () => { ui.assistantOpen = !ui.assistantOpen; saveUi(); applyLayout(); } },
          h('span', { class: 'pane-title', text: t('Asistan') }),
          h('span', { class: 'hint', text: t('Projenin ne yapacağını yaz; uygun komponentleri önersin.') }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'chev', id: 'dock-chev' }, icon('chevron', 14))),
        h('div', { class: 'dock-body' },
          h('div', { class: 'dock-input' },
            h('textarea', {
              id: 'ask', rows: 3,
              placeholder: t('Ör: Sıcaklık ve ivme ölçüp OLED ekranda gösteren, GPS konumunu kaydeden pilli bir cihaz.'),
              onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) ask(); }
            }),
            h('div', { class: 'row' }, h('span', { class: 'hint', text: 'Ctrl+Enter' }), h('span', { class: 'spacer' }), h('button', { onclick: ask }, t('Öner')))),
          h('div', { class: 'dock-log', id: 'dock-log' })))));
    initCanvas();
    document.getElementById('notes-box').open = !!ui.notesOpen;
    applyLayout();
  }

  /** ES-1008: Design'daki görünüm; seçilmediyse Profesyonel modda Pinout, Acemi'de şema */
  const designView = () => (state.design && state.design.designView) || (ES.modeId() === 'pro' ? 'pinout' : 'schematic');
  function setView(v) {
    if (!state.design || designView() === v) return;
    state.design.designView = v;
    update();
    applyView();
  }
  function applyView() {
    const wrap = $('canvas-wrap');
    if (!wrap || !state.design) return;
    const pin = designView() === 'pinout';
    wrap.classList.toggle('pinout-view', pin);
    $('design-pinout').hidden = !pin;
    $('view-schematic').classList.toggle('active', !pin);
    $('view-pinout').classList.toggle('active', pin);
    $('view-schematic').setAttribute('aria-selected', String(!pin));
    $('view-pinout').setAttribute('aria-selected', String(pin));
    if (pin && ui.tab === 'design') {
      ES.tabs.pinout.attach($('design-pinout'));
      ES.tabs.pinout.draw();
    }
  }

  function applyLayout() {
    const d = $('design');
    if (!d) return;
    d.classList.toggle('no-right', !ui.rightPanel);
    d.classList.toggle('dock-closed', !ui.assistantOpen);
    ES.emit('layout');
  }
  function setRightPanel(v) {
    ui.rightPanel = v;
    saveUi();
    applyLayout();
  }

  // ================================================================ tasarım işlemleri
  function nextLabel(componentId) {
    const base = cIdent(componentId);
    let n = 1;
    while (state.design.instances.some((i) => i.label === `${base}_${n}`)) n++;
    return `${base}_${n}`;
  }
  function addComponent(componentId, silent) {
    state.design.instances.push({ id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), componentId, label: nextLabel(componentId) });
    if (!silent) update();
  }
  function removeComponent(id) {
    const inst = state.design.instances.find((i) => i.id === id);
    if (!inst) return;
    state.design.instances = state.design.instances.filter((i) => i.id !== id);
    for (const k of Object.keys(state.design.locks || {})) if (k.startsWith(id + '.')) delete state.design.locks[k];
    if (selected === id) selected = null;
    hideTip();
    update();
    toast('info', t('{0} tasarımdan çıkarıldı. Geri almak için Ctrl+Z.', inst.label));
  }
  function toggleMirror(id) {
    const inst = state.design.instances.find((i) => i.id === id);
    inst.mirror = !inst.mirror;
    update();
  }
  function setLock(key, pin) {
    state.design.locks = state.design.locks || {};
    if (pin === 'auto') delete state.design.locks[key];
    else state.design.locks[key] = pin;
    update();
  }
  const comp = (inst) => state.lib.components[inst.componentId];

  // ================================================================ kütüphane
  function libAddMenu(e) {
    const r = e.currentTarget.getBoundingClientRect();
    contextMenu(r.left, r.bottom + 4, [
      { label: t('Yeni komponent oluştur…'), icon: 'edit', action: () => ES.creator.open(null, 'new') },
      '-',
      { label: t('Komponent dosyası yükle (.json)…'), icon: 'upload', action: () => post({ type: 'lib.import' }) },
      { label: t('Örnek şablonu aç'), icon: 'file', action: () => post({ type: 'lib.template' }) }
    ]);
  }

  /** Kütüphane öğesine sağ tık: ekle, düzenle, kopyala, kaldır. */
  function libItemMenu(x, y, c) {
    const user = c.source === 'user';
    contextMenu(x, y, [
      { label: t('Tasarıma ekle'), icon: 'plus', action: () => addComponent(c.id) },
      user ? { label: t('Düzenle…'), icon: 'edit', action: () => ES.creator.open(c, 'edit') } : { label: t('Kopyasını düzenle…'), icon: 'edit', hint: t('hazır komponent'), action: () => ES.creator.open(c, 'copy') },
      { label: 'Datasheet', icon: 'pdf', disabled: !c.datasheet, action: () => post({ type: 'datasheet', componentId: c.id }) },
      ...(user ? ['-', { label: t('Kütüphaneden kaldır'), icon: 'trash', danger: true, action: () => post({ type: 'lib.remove', id: c.id }) }] : [])
    ]);
  }

  function renderLibrary() {
    if (!state.lib) return;
    const groups = {};
    const match = (c) => !libFilter || [c.name, c.id, c.category, c.interface, ...(c.keywords || [])].join(' ').toLocaleLowerCase('tr').includes(libFilter);
    for (const c of Object.values(state.lib.components).filter(match)) (groups[c.category || t('Diğer')] = groups[c.category || t('Diğer')] || []).push(c);
    const list = $('library');
    if (!Object.keys(groups).length) {
      list.replaceChildren(h('div', { class: 'hint pad', text: t('Eşleşen komponent yok.') }));
      return;
    }
    list.replaceChildren(...Object.entries(groups).map(([cat, items]) =>
      h('details', { class: 'lib-group', open: true },
        h('summary', { text: cat }),
        ...items.map((c) => h('div', {
          class: 'lib-item', tabindex: '0', role: 'button', 'aria-label': t('{0} ekle', c.name),
          onclick: () => addComponent(c.id),
          oncontextmenu: (e) => { e.preventDefault(); hideTip(); libItemMenu(e.clientX, e.clientY, c); },
          onkeydown: (e) => { if (e.key === 'Enter') addComponent(c.id); },
          onmouseenter: (e) => showTip(e.clientX, e.clientY, compCard(c)),
          onmousemove: (e) => placeTip(e.clientX, e.clientY),
          onmouseleave: hideTip
        },
        h('span', { class: 'name', text: c.name }),
        c.source === 'user' ? h('span', { class: 'chip user', text: t('kullanıcı') }) : null,
        h('span', { class: `iface k-${c.interface}`, text: KIND_LABEL[c.interface] || c.interface }),
        c.source === 'user' ? h('button', { class: 'icon tiny', title: t('Kütüphaneden kaldır'), onclick: (e) => { e.stopPropagation(); post({ type: 'lib.remove', id: c.id }); } }, icon('trash', 12)) : h('span', { class: 'add', text: '+' }))))));
  }

  /** Üzerine gelince açılan komponent kartı. */
  function compCard(c, inst) {
    const rows = [[t('Arayüz'), KIND_LABEL[c.interface] || c.interface]];
    if (c.i2c) rows.push([t('I2C adresi'), inst && state.result.addresses[inst.id] ? state.result.addresses[inst.id] : [c.i2c.address, ...(c.i2c.altAddresses || [])].join(' / ')]);
    if (c.uart) rows.push(['Baud', String(c.uart.baud)]);
    if (c.spi) rows.push([t('SPI hız'), `${c.spi.maxSpeedHz / 1e6} MHz`]);
    if (c.voltage) rows.push([t('Besleme'), `${c.voltage.min}–${c.voltage.max} V`]);
    if (c.sampleMs) rows.push([t('Örnekleme'), `${c.sampleMs} ms`]);
    if (inst) {
      const conns = state.result.connections.filter((x) => x.instId === inst.id);
      if (conns.length) rows.push([t('Bağlantı'), conns.map((x) => `${x.compPin}→${x.mcuPin}`).join('  ')]);
    } else {
      rows.push([t('Pinler'), c.pins.map((p) => p.name).join(', ')]);
    }
    if (c.telemetry && c.telemetry.length) rows.push([t('Ölçümler'), c.telemetry.map((m) => `${m.id}${m.unit ? ` (${m.unit})` : ''}`).join(', ')]);
    return h('div', { class: 'comp-card' },
      ES.mode().art ? h('div', { class: 'card-art' }, ES.art(c)) : null,
      h('div', { class: 'card-body' },
        h('div', { class: 'card-title' }, h('strong', { text: inst ? inst.label : c.name }), h('span', { class: `iface k-${c.interface}`, text: KIND_LABEL[c.interface] || c.interface })),
        inst ? h('div', { class: 'hint', text: c.name }) : null,
        h('p', { text: c.description || '' }),
        h('dl', {}, ...rows.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', { text: v })])),
        c.datasheet ? h('div', { class: 'hint ds' }, icon('pdf', 14), h('span', { text: inst ? t('Sağ tık → Datasheet') : t('Datasheet mevcut') })) : null));
  }

  // ================================================================ sağ panel: notlar + bağlantılar
  function renderNotes() {
    const all = [...state.result.messages, ...state.notes];
    const ic = { error: '✕', warn: '!', info: 'i' };
    $('notes').replaceChildren(...all.map((n) => h('div', { class: `note ${n.level}` }, h('span', { class: 'ic', text: ic[n.level] }), h('span', { text: n.text }))));
    const err = all.filter((n) => n.level === 'error').length, warn = all.filter((n) => n.level === 'warn').length;
    $('notes-badges').replaceChildren(...[
      err ? h('span', { class: 'badge err', title: t('Hata'), text: String(err) }) : null,
      warn ? h('span', { class: 'badge warn', title: t('Uyarı'), text: String(warn) }) : null,
      h('span', { class: 'badge', title: t('Toplam not'), text: String(all.length) })].filter(Boolean));
  }

  // ES-1001: bus komponentinin türü (I2C / SPI / UART) ve seçilebilecek çevre birimi örnekleri
  const busType = (c) => ['i2c', 'spi', 'uart'].find((x) => c.pins.some((p) => p.role.startsWith(x + '.'))) || null;
  const periphsOf = (type) => Object.entries(state.lib.mcus[state.design.mcuId].peripherals || {}).filter(([, v]) => v.type === type).map(([k]) => k);

  /** Seçenek metni: "PB10 · I2C2_SCL · BME280_1.SCL — neden" */
  /** ES-1003: "PA12 [Pin_Led]" */
  const pinText = (pin) => { const l = (state.design.pinLabels || {})[pin]; return l ? `${pin} [${l}]` : pin; };
  function choiceText(ch) {
    const sig = /^GPIO_/.test(ch.signal) ? '' : ` · ${ch.signal}`;
    return `${pinText(ch.pin)}${sig}${ch.user ? ` · ${ch.user}` : ''}${ch.conflict ? ' ⚠' : ''}${ch.disabled ? ` — ${ch.reason}` : ''}`;
  }

  /**
   * Dolu pin seçildi: CubeMX'teki gibi açıkça sorulur. "Taşı": diğer komponentin bu pine kilidi kalkar, otomatik
   * atama onu başka bir pine taşır (kilitli pin önce ayrılır). Vazgeç: seçim geri alınır.
   */
  function confirmConflict(key, ch, onMove, onCancel) {
    const [instId, compPin] = key.split('.');
    const inst = state.design.instances.find((i) => i.id === instId);
    let moved = false;
    modal({
      title: t('{0} kullanımda', ch.pin),
      width: 440,
      onClose: () => { if (!moved) onCancel(); },
      body: h('div', {},
        h('p', { text: t('{0} şu anda {1} tarafından kullanılıyor.', ch.pin, ch.user) }),
        h('p', { class: 'hint', text: ch.pinMode ? t('{0}.{1} bu pine sabitlenirse pindeki Pinout ayarı ({2}) kaldırılır.', inst ? inst.label : instId, compPin, ch.user)
          : t('{0}.{1} bu pine sabitlenirse diğer bağlantı otomatik olarak başka bir uygun pine taşınır.', inst ? inst.label : instId, compPin) })),
      buttons: [
        { label: t('Vazgeç') },
        { label: ch.pinMode ? t('Pinout ayarını kaldır') : t('Diğerini taşı'), primary: true, id: 'conflict-move', action: () => { moved = true; onMove(); } }
      ]
    });
  }

  /** ES-1005: Pinout'ta pine verilmiş GPIO modunu kaldırır (update çağıran yapar) */
  function clearPinMode(pin) {
    const m = { ...(state.design.pinModes || {}) };
    delete m[pin];
    state.design.pinModes = m;
  }

  /** Diğer komponentlerin bu pine kilitleri (çakışmada "taşı" ile kaldırılır) */
  const locksOnPin = (pin, exceptInst) => Object.entries(state.design.locks || {}).filter(([k, v]) => v === pin && !k.startsWith(exceptInst + '.')).map(([k]) => k);

  /**
   * Bir komponentin bağlantı tablosu.
   * staged verilirse değişiklikler sadece staged'e yazılır (modal: Kaydet ile uygulanır).
   */
  function connTable(inst, staged) {
    const c = comp(inst);
    const conns = state.result.connections.filter((x) => x.instId === inst.id);
    const lockOf = (key) => (staged ? staged.locks[key] : state.design.locks && state.design.locks[key]);
    const issues = state.result.lockIssues || {};
    const rows = c.pins.map((p) => {
      const key = `${inst.id}.${p.name}`;
      if (p.role === 'power' || p.role === 'ground') {
        const net = state.result.power.find((x) => x.instId === inst.id && x.compPin === p.name)?.net ?? '';
        return h('tr', {}, h('td', { text: p.name }), h('td', { class: 'hint', text: p.role === 'ground' ? t('Toprak') : t('Besleme') }), h('td', { class: net === 'GND' ? 'k-gpio' : 'k-pwm', text: net }));
      }
      const conn = conns.find((x) => x.compPin === p.name);
      const list = (state.result.choices || {})[key] || (state.result.options[key] || []).map((pin) => ({ pin, signal: '' }));
      const locked = lockOf(key);
      const setPin = (pin, release = []) => {
        if (staged) {
          if (pin === 'auto') delete staged.locks[key];
          else staged.locks[key] = pin;
          staged.release = [...new Set([...(staged.release || []), ...release])];
        } else {
          state.design.locks = state.design.locks || {};
          for (const k of release) delete state.design.locks[k];
          setLock(key, pin);
        }
      };
      // Çevre birimine göre gruplu (CubeMX: I2C1 / I2C2 …); GPIO'da boş / kullanımda
      const groups = new Map();
      for (const ch of list) {
        const g = ch.periph || (ch.user && !(conn && conn.mcuPin === ch.pin) ? t('Kullanımda') : t('Boş pinler'));
        groups.set(g, [...(groups.get(g) || []), ch]);
      }
      const opt = (ch) => h('option', {
        value: `${ch.pin}|${ch.signal}`, disabled: !!ch.disabled, title: ch.reason || '',
        selected: locked === ch.pin && (!conn || conn.mcuPin !== ch.pin || !ch.signal || conn.signal === ch.signal || /^GPIO_/.test(ch.signal)),
        text: choiceText({ ...ch, user: conn && conn.mcuPin === ch.pin ? '' : ch.user, conflict: ch.conflict && !(conn && conn.mcuPin === ch.pin) })
      });
      const sel = h('select', {
        'aria-label': t('{0} {1} MCU pini', inst.label, p.name), 'data-key': key,
        onchange: (e) => {
          const v = e.target.value;
          if (v === 'auto') return setPin('auto');
          const [pin, signal] = v.split('|');
          const ch = list.find((x) => x.pin === pin && x.signal === signal) || { pin };
          if (ch.conflict && !(conn && conn.mcuPin === pin)) {
            confirmConflict(key, ch, () => { if (ch.pinMode) clearPinMode(pin); setPin(pin, locksOnPin(pin, inst.id)); }, () => { e.target.value = locked ? [...e.target.options].find((o) => o.value.startsWith(locked + '|'))?.value || 'auto' : 'auto'; });
          } else setPin(pin);
        }
      },
      h('option', { value: 'auto', text: conn ? t('Otomatik ({0})', pinText(conn.mcuPin)) : t('Otomatik') }),
      ...[...groups].sort(([a], [b]) => (a === t('Kullanımda')) - (b === t('Kullanımda')) || a.localeCompare(b, 'en', { numeric: true })).map(([g, chs]) => (groups.size > 1 || list[0]?.periph ? h('optgroup', { label: g }, ...chs.map(opt)) : chs.map(opt))).flat());
      const issue = !staged && locked ? issues[key] : null;
      return h('tr', { class: issue ? 'lock-bad' : '' },
        h('td', { text: p.name }),
        h('td', {}, sel),
        h('td', { class: conn ? `k-${conn.kind}` : 'hint' },
          locked ? h('button', { class: 'lock link', title: issue || t('Elle sabitlendi — tıkla: kilidi kaldır'), 'aria-label': t('{0} kilidini kaldır', p.name), onclick: () => setPin('auto') }, issue ? '⚠ ' : '● ') : null,
          conn ? conn.signal : '—'));
    });
    // ES-1001: çevre birimi örneği (I2C1 / I2C2 …): seçilince grubun pinleri o birimde aranır
    let periphSel = null;
    const type = busType(c);
    if (type) {
      const list = periphsOf(type);
      const current = staged ? staged.periph : (inst.options && inst.options.periph) || 'auto';
      const now = conns.find((x) => x.kind === type && x.peripheral)?.peripheral;
      periphSel = h('select', {
        class: 'periph-sel', title: t('Çevre birimi'), 'aria-label': t('{0} çevre birimi', inst.label),
        onchange: (e) => {
          const v = e.target.value;
          // Seçilen birime uymayan kendi bus kilitleri kalkar
          const misfit = c.pins.filter((p) => p.role.startsWith(type + '.')).map((p) => `${inst.id}.${p.name}`)
            .filter((k) => { const pin = lockOf(k); return pin && v !== 'auto' && !((state.result.choices || {})[k] || []).some((ch) => ch.pin === pin && ch.periph === v); });
          if (staged) { staged.periph = v; for (const k of misfit) delete staged.locks[k]; } else {
            for (const k of misfit) delete state.design.locks[k];
            const o = { ...(inst.options || {}) };
            if (v === 'auto') delete o.periph; else o.periph = v;
            inst.options = o;
            update();
          }
        }
      }, h('option', { value: 'auto', text: now ? `${now} · ${t('oto')}` : t('Otomatik') }),
      ...list.map((x) => h('option', { value: x, selected: current === x, text: x })));
    }
    let addrSel = null;
    if (c.i2c) {
      const addrs = [c.i2c.address, ...(c.i2c.altAddresses || [])];
      const current = staged ? staged.address : (inst.options && inst.options.address) || 'auto';
      addrSel = h('select', {
        title: t('I2C adresi'), 'aria-label': t('I2C adresi'),
        onchange: (e) => {
          if (staged) staged.address = e.target.value;
          else {
            const o = { ...(inst.options || {}) };
            if (e.target.value === 'auto') delete o.address; else o.address = e.target.value;
            inst.options = o;
            update();
          }
        }
      }, h('option', { value: 'auto', text: t('adres: auto ({0})', state.result.addresses[inst.id] || '-') }),
      ...addrs.map((a) => h('option', { value: a, text: t('adres: {0}', a), selected: current === a })));
    }
    return { table: h('table', { class: 'pins' }, ...rows), addrSel, periphSel };
  }

  function renderConnections() {
    const cards = state.design.instances.map((inst) => {
      const c = comp(inst);
      if (!c) return null;
      const { table, addrSel, periphSel } = connTable(inst);
      return h('div', {
        class: `conn-card${selected === inst.id ? ' sel' : ''}`, 'data-inst': inst.id,
        onmouseenter: () => setHighlight(inst.id), onmouseleave: () => setHighlight(null),
        oncontextmenu: (e) => { e.preventDefault(); compMenu(e.clientX, e.clientY, inst); }
      },
      h('div', { class: 'conn-head' },
        h('span', { class: `iface k-${c.interface}`, text: KIND_LABEL[c.interface] || c.interface }),
        h('span', { class: 'title', title: c.name, text: inst.label }),
        periphSel,
        addrSel,
        h('button', { class: 'icon', title: t('Tasarımdan çıkar'), 'aria-label': t('{0} sil', inst.label), onclick: () => removeComponent(inst.id) }, icon('trash', 13))),
      table);
    });
    $('conns').replaceChildren(...cards.filter(Boolean));
    const n = Object.keys(state.design.locks || {}).length;
    const b = $('pinned-btn');
    if (b) b.textContent = n ? t('Sabit pinler ({0})', n) : t('Sabit pinler');
  }

  /** ES-1001: elle sabitlenmiş bütün pinler (CubeMX'teki pinned pins listesi): kaldır / hepsini kaldır */
  function openPinned() {
    const locks = state.design.locks || {};
    const issues = state.result.lockIssues || {};
    const label = (k) => { const [id, pin] = k.split('.'); const i = state.design.instances.find((x) => x.id === id); return `${i ? i.label : id}.${pin}`; };
    const keys = Object.keys(locks).sort((a, b) => label(a).localeCompare(label(b)));
    const m = modal({
      title: t('Sabit pinler'),
      width: 460,
      body: keys.length ? h('table', { class: 'pins pinned-list' }, ...keys.map((k) => h('tr', { class: issues[k] ? 'lock-bad' : '' },
        h('td', { class: 'mono', text: label(k) }),
        h('td', { class: 'mono', text: locks[k] }),
        h('td', { class: 'hint', text: issues[k] || '' }),
        h('td', {}, h('button', { class: 'ghost small', 'data-key': k, onclick: () => { delete state.design.locks[k]; update(); m.close(); openPinned(); } }, t('Kaldır'))))))
        : h('p', { class: 'hint', text: t('Sabitlenmiş pin yok: bütün pinleri asistan atıyor. Bağlantılar tablosunda bir pin seçmek onu sabitler.') }),
      buttons: [
        ...(keys.length ? [{ label: t('Hepsini kaldır'), id: 'pinned-clear', action: () => { state.design.locks = {}; update(); toast('info', t('{0} sabit pin kaldırıldı.', keys.length)); } }] : []),
        { label: t('Kapat'), primary: true }
      ]
    });
  }

  /** Sağ tık → Bağlantılar: aynı tablo, Kaydet / Kapat ile. */
  function openConnections(inst) {
    const locks = {};
    for (const [k, v] of Object.entries(state.design.locks || {})) if (k.startsWith(inst.id + '.')) locks[k] = v;
    const staged = { locks, address: (inst.options && inst.options.address) || 'auto', periph: (inst.options && inst.options.periph) || 'auto', mirror: !!inst.mirror, release: [] };
    const { table, addrSel, periphSel } = connTable(inst, staged);
    const c = comp(inst);
    modal({
      title: t('{0} · Bağlantılar', inst.label),
      width: 520,
      body: h('div', { class: 'conn-modal' },
        h('div', { class: 'conn-modal-top' },
          ES.mode().art ? h('div', { class: 'conn-modal-art' }, ES.art(c)) : null,
          h('div', {},
            h('div', { class: 'hint', text: c.name }),
            periphSel,
            addrSel,
            h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: staged.mirror, onchange: (e) => (staged.mirror = e.target.checked) }), h('span', { text: t('Yönü değiştir (aynala)') })))),
        h('div', { class: 'conn-card flat' }, table),
        h('p', { class: 'hint', text: t('"Otomatik" pinler asistan tarafından atanır. Elle seçtiğiniz pin kilitlenir ve geri kalan atama ona göre yeniden çözülür.') })),
      buttons: [
        { label: t('Kapat') },
        {
          label: t('Kaydet'), primary: true,
          action: () => {
            state.design.locks = state.design.locks || {};
            for (const k of Object.keys(state.design.locks)) if (k.startsWith(inst.id + '.')) delete state.design.locks[k];
            for (const k of staged.release) delete state.design.locks[k];
            Object.assign(state.design.locks, staged.locks);
            const o = {};
            if (staged.address !== 'auto') o.address = staged.address;
            if (staged.periph !== 'auto') o.periph = staged.periph;
            inst.options = o;
            inst.mirror = staged.mirror;
            update();
            toast('info', t('{0} bağlantıları kaydedildi.', inst.label));
          }
        }
      ]
    });
  }

  // ================================================================ sağ tık menüleri
  function compMenu(x, y, inst) {
    const c = comp(inst);
    selected = inst.id;
    applyHighlight();
    contextMenu(x, y, [
      { label: t('Bağlantılar…'), icon: 'link', action: () => openConnections(inst) },
      { label: t('Yönü değiştir (aynala)'), icon: 'mirror', action: () => toggleMirror(inst.id) },
      { label: 'Datasheet', icon: 'pdf', hint: c.datasheet ? 'PDF' : t('yok'), disabled: !c.datasheet, action: () => post({ type: 'datasheet', componentId: c.id }) },
      '-',
      { label: t('Sil'), icon: 'trash', hint: 'Del', danger: true, action: () => removeComponent(inst.id) }
    ]);
  }

  function addSubmenu() {
    const box = h('div', { class: 'ctx-pick' });
    const list = h('div', { class: 'ctx-pick-list' });
    const fill = (q) => {
      const items = Object.values(state.lib.components).filter((c) => !q || [c.name, c.category, c.interface, ...(c.keywords || [])].join(' ').toLocaleLowerCase('tr').includes(q));
      list.replaceChildren(...items.map((c) => h('div', {
        class: 'ctx-item', onclick: () => { closeMenu(); addComponent(c.id); }
      }, h('span', { class: `iface k-${c.interface}`, text: KIND_LABEL[c.interface] || c.interface }), h('span', { class: 'ctx-label', text: c.name }), h('span', { class: 'ctx-hint', text: c.category || '' }))));
      if (!items.length) list.append(h('div', { class: 'hint pad', text: t('Bulunamadı') }));
    };
    box.append(h('input', { type: 'text', placeholder: t('Ara…'), oninput: (e) => fill(e.target.value.toLocaleLowerCase('tr')), onkeydown: (e) => e.stopPropagation() }), list);
    fill('');
    return box;
  }

  function canvasMenu(x, y) {
    selected = null;
    applyHighlight();
    contextMenu(x, y, [
      { label: t('Komponent ekle'), icon: 'plus', submenu: addSubmenu },
      { label: t('Sığdır'), icon: 'fit', action: () => { view = null; renderSchematic(); } },
      '-',
      { label: ui.rightPanel ? t('Bağlantılar panelini gizle') : t('Bağlantılar panelini göster'), icon: 'panel', action: () => setRightPanel(!ui.rightPanel) }
    ]);
  }

  /** ES-1003: MCU pinine sağ tık: etiket gir / değiştir / kaldır */
  function pinMenu(x, y, pin) {
    const lbl = (state.design.pinLabels || {})[pin];
    const mcu = state.lib.mcus[state.design.mcuId];
    contextMenu(x, y, [
      { label: lbl ? t('Etiketi değiştir ({0})…', lbl) : t('{0} için etiket gir…', pin), icon: 'edit', action: () => labelDialog(pin) },
      { label: t('Etiketi kaldır'), icon: 'trash', disabled: !lbl, action: () => setLabel(pin, '') },
      '-',
      { label: t('{0} datasheet', mcu.name), icon: 'pdf', action: () => post({ type: 'datasheet', componentId: '@mcu' }) }
    ]);
  }

  function setLabel(pin, label) {
    const next = { ...(state.design.pinLabels || {}) };
    if (label) next[pin] = label; else delete next[pin];
    state.design.pinLabels = next;
    update();
  }

  // Motorla aynı kurallar (src/engine/labels.js); son karar eklentide, burada yazarken uyarmak için
  const C_WORDS = new Set('auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while bool true false NULL'.split(' '));
  function labelProblem(pin, v) {
    if (!v) return '';
    if (v.length > 40) return t('Etiket en fazla {0} karakter olabilir.', 40);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return t('Etiket harf ya da _ ile başlamalı; yalnızca harf, rakam ve _ içerebilir (C tanımlayıcısı).');
    if (C_WORDS.has(v)) return t('"{0}" C anahtar kelimesi; etiket olamaz.', v);
    if (/^__/.test(v) || /^_[A-Z]/.test(v)) return t('"{0}" C derleyicisine ayrılmış ad biçiminde (__ ya da _ + büyük harf).', v);
    const other = Object.entries(state.design.pinLabels || {}).find(([p, l]) => p !== pin && l === v);
    if (other) return t('"{0}" etiketi {1} pininde de var; etiketler benzersiz olmalı.', v, other[0]);
    return '';
  }

  function labelDialog(pin) {
    const cur = (state.design.pinLabels || {})[pin] || '';
    const err = h('div', { class: 'dbg-msg error', id: 'label-err', hidden: true });
    const input = h('input', {
      id: 'label-input', type: 'text', class: 'mono', value: cur, placeholder: 'Pin_Led', maxlength: 40, spellcheck: false,
      oninput: () => { const e = labelProblem(pin, input.value.trim()); err.textContent = e; err.hidden = !e; },
      onkeydown: (e) => { if (e.key === 'Enter') document.querySelector('#label-save').click(); }
    });
    modal({
      title: t('{0} · Etiket', pin),
      width: 420,
      body: h('div', {},
        h('label', { for: 'label-input', class: 'hint', text: t('Kodda {0}_Pin ve {0}_GPIO_Port olarak üretilir (board.h). Boş bırakmak etiketi kaldırır.', input.value || '<etiket>') }),
        input, err),
      buttons: [
        { label: t('Kapat') },
        {
          label: t('Kaydet'), primary: true, id: 'label-save',
          action: () => {
            const v = input.value.trim();
            const e = labelProblem(pin, v);
            if (e) { err.textContent = e; err.hidden = false; return false; }
            setLabel(pin, v);
            return undefined;
          }
        }
      ]
    });
    setTimeout(() => { input.focus(); input.select(); }, 0);
  }

  function mcuMenu(x, y) {
    const mcu = state.lib.mcus[state.design.mcuId];
    contextMenu(x, y, [
      { label: t('{0} datasheet', mcu.name), icon: 'pdf', action: () => post({ type: 'datasheet', componentId: '@mcu' }) },
      { label: 'Reference manual', icon: 'pdf', disabled: !mcu.referenceManual, action: () => post({ type: 'openExternal', url: mcu.referenceManual }) },
      '-',
      { label: t('Clock ayarları'), icon: 'clock', action: () => ES.setTab('clock') },
      { label: t('Komponent ekle'), icon: 'plus', submenu: addSubmenu }
    ]);
  }

  // ================================================================ asistan
  function ask() {
    const ta = $('ask');
    const text = ta.value.trim();
    if (!text) return;
    post({ type: 'ask', text });
  }
  ES.on('suggestion', (m) => {
    conversation.unshift(m);
    $('ask').value = '';
    renderDock();
  });
  function renderDock() {
    const log = $('dock-log');
    if (!conversation.length) {
      log.replaceChildren(h('div', { class: 'hint pad', text: t('Öneriler burada görünecek. İsterseniz tek tek, isterseniz hepsini ekleyebilirsiniz.') }));
      return;
    }
    log.replaceChildren(...conversation.slice(0, 8).map((m) => h('div', { class: 'msg' },
      h('div', { class: 'msg-q', text: m.question }),
      h('div', { class: 'msg-a', text: m.reply }),
      m.components.length ? h('div', { class: 'chips' },
        ...m.components.map((id) => h('button', { class: 'chip-btn', title: t('Ekle'), onclick: () => addComponent(id) }, '+ ' + state.lib.components[id].name)),
        h('button', {
          class: 'small',
          onclick: () => {
            for (const id of m.components) {
              if (id === 'usb_uart' && state.design.instances.some((i) => i.componentId === id)) continue;
              addComponent(id, true);
            }
            update();
          }
        }, t('Hepsini ekle'))) : null)));
  }

  // ================================================================ şema
  const P = 22, MW = 230, STUB = 22, CW = 120, CSTUB = 16, LANE = 7;
  const isPow = (p) => p.role === 'power' || p.role === 'ground';

  function layout() {
    const mcu = state.lib.mcus[state.design.mcuId];
    const leftPins = mcu.pins.filter((p) => p.side === 'left');
    const rightPins = mcu.pins.filter((p) => p.side !== 'left');
    const MH = (Math.max(leftPins.length, rightPins.length) + 1) * P;
    const mpos = {};
    leftPins.forEach((p, i) => (mpos[p.name] = { x: -STUB, y: (i + 1) * P, side: 'left', pin: p }));
    rightPins.forEach((p, i) => (mpos[p.name] = { x: MW + STUB, y: (i + 1) * P, side: 'right', pin: p }));
    const conns = state.result.connections;

    const comps = state.design.instances.map((inst) => {
      const c = comp(inst);
      if (!c) return null;
      const cs = conns.filter((x) => x.instId === inst.id && mpos[x.mcuPin]);
      const l = cs.filter((x) => mpos[x.mcuPin].side === 'left').length;
      const avgY = cs.length ? cs.reduce((a, x) => a + mpos[x.mcuPin].y, 0) / cs.length : 1e9;
      const sig = c.pins.filter((p) => !isPow(p)), pow = c.pins.filter(isPow);
      const rows = Math.max(sig.length, pow.length);
      return { inst, comp: c, cs, sig, pow, mirror: !!inst.mirror, side: l * 2 > cs.length ? 'left' : l * 2 < cs.length ? 'right' : '', avgY, h: (rows + 1) * P };
    }).filter(Boolean);
    for (const c of comps) {
      if (c.side) continue;
      const nl = comps.filter((x) => x.side === 'left').length, nr = comps.filter((x) => x.side === 'right').length;
      c.side = nl <= nr ? 'left' : 'right';
    }
    const byId = Object.fromEntries(comps.map((c) => [c.inst.id, c]));

    const wires = conns.filter((x) => mpos[x.mcuPin] && byId[x.instId]).map((x) => ({ c: x, comp: byId[x.instId], compSide: byId[x.instId].side, pinSide: mpos[x.mcuPin].side }));
    const lanes = { left: [], right: [] };
    for (const w of wires) {
      lanes[w.compSide].push({ w, role: 'comp' });
      if (w.compSide !== w.pinSide) lanes[w.pinSide].push({ w, role: 'pin' });
    }
    const laneX = (side, k) => (side === 'left' ? -STUB - 16 - k * LANE : MW + STUB + 16 + k * LANE);
    const pinEndX = { left: laneX('left', lanes.left.length) - 14, right: laneX('right', lanes.right.length) + 14 };

    const pos = {};
    for (const side of ['left', 'right']) {
      let cursor = -20;
      for (const c of comps.filter((x) => x.side === side).sort((a, b) => a.avgY - b.avgY)) {
        const extra = c.mirror ? c.sig.length * 6 + 14 : 0; // aynalı: kablolar üstten dolaşır
        const want = c.avgY < 1e9 ? c.avgY - c.h / 2 : cursor;
        const top = Math.max(cursor + extra, want);
        const boxX = side === 'left' ? pinEndX.left - CSTUB - CW : pinEndX.right + CSTUB;
        pos[c.inst.id] = { top, boxX, side };
        // aynalı değilse sinyal pinleri MCU'ya bakan kenarda
        c.facingLeft = side === 'right';
        c.pinY = {};
        c.sig.forEach((p, i) => (c.pinY[p.name] = top + (i + 1) * P));
        c.pow.forEach((p, i) => (c.pinY[p.name] = top + (i + 1) * P));
        cursor = top + c.h + 46;
      }
    }

    const span = (e) => Math.abs(e.w.comp.pinY[e.w.c.compPin] - mpos[e.w.c.mcuPin].y) + (e.role === 'pin' ? 1000 : 0);
    for (const side of ['left', 'right']) {
      lanes[side].sort((a, b) => span(a) - span(b));
      lanes[side].forEach((e, k) => (e.w[e.role === 'comp' ? 'compLane' : 'pinLane'] = laneX(side, k)));
    }
    let crossK = 0;
    for (const w of wires) {
      const c = w.comp, p = pos[c.inst.id];
      const sy = c.pinY[w.c.compPin];
      const ex = mpos[w.c.mcuPin].x, ey = mpos[w.c.mcuPin].y;
      const pts = [];
      if (c.mirror) {
        // Sinyal pini dış kenarda: dışarı çık, komponentin üstünden dolaş.
        const k = c.sig.findIndex((x) => x.name === w.c.compPin);
        const out = w.compSide === 'left' ? -1 : 1;
        const farX = w.compSide === 'left' ? p.boxX - CSTUB : p.boxX + CW + CSTUB;
        const ox = farX + out * (8 + k * 6);
        const ty = p.top - 24 - k * 6;
        pts.push([farX, sy], [ox, sy], [ox, ty], [w.compLane, ty]);
      } else {
        pts.push([pinEndX[w.compSide], sy], [w.compLane, sy]);
      }
      if (w.compSide === w.pinSide) pts.push([w.compLane, ey], [ex, ey]);
      else {
        const ty = -18 - crossK++ * LANE;
        pts.push([w.compLane, ty], [w.pinLane, ty], [w.pinLane, ey], [ex, ey]);
      }
      w.d = 'M' + pts.map((q) => q.join(',')).join(' L');
      w.ey = ey;
      w.jx = w.compSide === w.pinSide ? w.compLane : w.pinLane;
    }
    const minX = Math.min(pinEndX.left - CSTUB - CW - 70, -STUB) - 30;
    const maxX = Math.max(pinEndX.right + CSTUB + CW + 70, MW + STUB) + 30;
    const tops = comps.map((c) => (pos[c.inst.id] ? pos[c.inst.id].top - 40 - (c.mirror ? c.sig.length * 6 : 0) : 0));
    const maxY = Math.max(MH, ...comps.map((c) => (pos[c.inst.id] ? pos[c.inst.id].top + c.h : 0))) + 40;
    const minY = Math.min(-60 - crossK * LANE, ...tops);
    return { mcu, mpos, MH, comps, pos, wires, bounds: { minX, maxX, minY, maxY } };
  }

  function renderSchematic() {
    if (!state.result || !$('schematic')) return;
    const svg = $('schematic');
    const L = layout();
    // Komponent eklenip çıkınca her zaman, yerleşim başka sebeple büyüyüp küçülünce (bağlantılar yeniden
    // çözüldü, aynalama…) kullanıcı görünümü elle değiştirmediyse yeniden sığdır: hiçbir komponent ekran dışında kalmasın.
    const b0 = L.bounds;
    const key = `${state.design.mcuId}|${state.design.instances.length}`;
    const boundsKey = [b0.minX, b0.minY, b0.maxX, b0.maxY].map(Math.round).join(',');
    if (!view || key !== lastLayoutKey || (!userView && boundsKey !== view.boundsKey)) {
      view = { x: b0.minX, y: b0.minY, w: b0.maxX - b0.minX, h: b0.maxY - b0.minY, boundsKey };
      lastLayoutKey = key;
      userView = false;
    }
    svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    const g = s('g');
    const grid = s('g');
    const b = L.bounds;
    for (let x = Math.floor(b.minX / 44) * 44; x < b.maxX; x += 44) {
      for (let y = Math.floor(b.minY / 44) * 44; y < b.maxY; y += 44) grid.append(s('circle', { class: 'grid-dot', cx: x, cy: y, r: 0.9 }));
    }
    g.append(grid);

    const wireG = s('g');
    const shared = {};
    for (const w of L.wires) (shared[w.c.mcuPin] = shared[w.c.mcuPin] || []).push(w);
    for (const w of L.wires) {
      wireG.append(s('path', { class: `wire w-${w.c.kind}${w.c.locked ? ' locked' : ''}`, d: w.d, 'data-inst': w.c.instId },
        s('title', { text: `${w.c.signal}: ${w.c.mcuPin} ↔ ${w.comp.inst.label}.${w.c.compPin}` })));
    }
    for (const list of Object.values(shared)) {
      if (list.length < 2) continue;
      const far = list.reduce((a, w) => (Math.abs(w.jx) > Math.abs(a.jx) ? w : a));
      for (const w of list) if (w !== far) wireG.append(s('circle', { class: `junction w-${w.c.kind}`, cx: w.jx, cy: w.ey, r: 2.6 }));
    }
    g.append(wireG);

    // MCU sembolü
    const sigOf = {};
    for (const c of state.result.connections) sigOf[c.mcuPin] = c;
    const mcuG = s('g', {
      class: 'mcu',
      oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); mcuMenu(e.clientX, e.clientY); }
    },
    s('text', { class: 'sym-title', x: 0, y: -26, text: 'U1' }),
    s('text', { class: 'sym-sub', x: 0, y: -12, text: `${L.mcu.name} · ${L.mcu.board}` }),
    s('rect', { class: 'mcu-body', x: 0, y: 0, width: MW, height: L.MH, rx: 2 }));
    const labels = state.design.pinLabels || {};
    const labelIssues = state.result.labelIssues || {};
    for (const [name, p] of Object.entries(L.mpos)) {
      const left = p.side === 'left';
      const edge = left ? 0 : MW;
      const c = sigOf[name];
      // ES-1003: etiketli pinde ad yerine etiket; pin adı ipucunda
      const lbl = labels[name];
      const shown = lbl && lbl.length > 16 ? lbl.slice(0, 15) + '…' : lbl;
      const tip = [lbl ? `${name} · ${lbl}` : '', labelIssues[name] ? `⚠ ${labelIssues[name]}` : '', p.pin.reserved, p.pin.note, ...p.pin.functions.map((f) => f.signal)].filter(Boolean).join(' · ') || 'GPIO';
      const onPin = (e) => { e.preventDefault(); e.stopPropagation(); pinMenu(e.clientX, e.clientY, name); };
      mcuG.append(
        s('line', { class: 'pin-line', x1: edge, y1: p.y, x2: p.x, y2: p.y, oncontextmenu: onPin }),
        s('text', {
          class: `pin-name${p.pin.reserved ? ' reserved' : ''}${lbl ? ' pin-label' : ''}${labelIssues[name] ? ' bad' : ''}`, 'data-pin': name,
          x: left ? 6 : MW - 6, y: p.y + 3.5, 'text-anchor': left ? 'start' : 'end', text: shown || name, oncontextmenu: onPin
        }, s('title', { text: tip })));
      const tag = p.pin.reserved || (c ? c.signal : (state.result.pinModes || {})[name] || '');
      if (tag) {
        // Etiket uzunsa sinyal adı biraz içeri kayar (10 px mono ≈ 6 px / karakter)
        const off = Math.max(42, 6 + (shown || name).length * 6.2 + 8);
        mcuG.append(s('text', { class: `pin-sig ${c ? `w-${c.kind}` : p.pin.reserved ? 'pin-name reserved' : 'w-gpio pin-mode'}`, x: left ? off : MW - off, y: p.y + 3.5, 'text-anchor': left ? 'start' : 'end', text: tag }));
      }
    }
    g.append(mcuG);

    for (const c of L.comps) {
      const pos = L.pos[c.inst.id];
      if (!pos) continue;
      const left = pos.side === 'left';
      // Normal: sinyal pinleri MCU'ya bakan kenarda; aynalı: ters.
      const sigOnRight = left !== c.mirror;
      const cg = s('g', {
        class: `comp${selected === c.inst.id ? ' sel' : ''}`, 'data-inst': c.inst.id,
        onmouseenter: (e) => { setHighlight(c.inst.id); showTip(e.clientX, e.clientY, compCard(c.comp, c.inst)); },
        onmousemove: (e) => placeTip(e.clientX, e.clientY),
        onmouseleave: () => { setHighlight(null); hideTip(); },
        onclick: (e) => { e.stopPropagation(); select(c.inst.id); },
        ondblclick: (e) => { e.stopPropagation(); hideTip(); openConnections(c.inst); },
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); hideTip(); compMenu(e.clientX, e.clientY, c.inst); }
      },
      s('rect', { class: 'sel-ring', x: pos.boxX - 6, y: pos.top - 26, width: CW + 12, height: c.h + 46, rx: 4 }),
      s('text', { class: 'sym-title', x: pos.boxX, y: pos.top - 8, text: c.inst.label }),
      s('rect', { class: 'sym-body', x: pos.boxX, y: pos.top, width: CW, height: c.h, rx: 2 }),
      s('text', { class: 'sym-sub', x: pos.boxX + CW / 2, y: pos.top + c.h + 14, 'text-anchor': 'middle', text: c.comp.name + (c.mirror ? '  ⇋' : '') }));
      for (const p of c.comp.pins) {
        const y = c.pinY[p.name];
        const pow = isPow(p);
        const onRight = pow ? !sigOnRight : sigOnRight;
        const edge = onRight ? pos.boxX + CW : pos.boxX;
        const dir = onRight ? 1 : -1;
        const outX = edge + dir * CSTUB;
        cg.append(
          s('line', { class: 'pin-line', x1: edge, y1: y, x2: outX, y2: y }),
          s('text', { class: 'pin-name', x: edge - dir * 6, y: y + 3.5, 'text-anchor': onRight ? 'end' : 'start', text: p.name }));
        if (pow) {
          const net = state.result.power.find((x) => x.instId === c.inst.id && x.compPin === p.name)?.net ?? '';
          cg.append(powerSymbol(outX, y, dir, p.role, net));
        } else if (!c.cs.some((x) => x.compPin === p.name)) {
          cg.append(s('text', { class: 'pin-sig pin-name reserved', x: outX + dir * 4, y: y + 3.5, 'text-anchor': onRight ? 'start' : 'end', text: 'NC' }));
        }
      }
      g.append(cg);
    }
    svg.replaceChildren(g);
    applyHighlight();
    $('canvas-hint').classList.toggle('show', state.design.instances.length <= 1);
  }

  function powerSymbol(x, y, dir, role, net) {
    const x1 = x + dir * 8;
    if (role === 'ground') {
      return s('g', { class: 'n-ground' },
        s('line', { x1: x, y1: y, x2: x1, y2: y, 'stroke-width': 1.4 }),
        s('line', { x1, y1: y - 6, x2: x1, y2: y + 6, 'stroke-width': 1.6 }),
        s('line', { x1: x1 + dir * 3, y1: y - 4, x2: x1 + dir * 3, y2: y + 4, 'stroke-width': 1.4 }),
        s('line', { x1: x1 + dir * 6, y1: y - 2, x2: x1 + dir * 6, y2: y + 2, 'stroke-width': 1.2 }));
    }
    return s('g', { class: 'n-power' },
      s('line', { x1: x, y1: y, x2: x1, y2: y, 'stroke-width': 1.4 }),
      s('line', { x1, y1: y - 6, x2: x1, y2: y + 6, 'stroke-width': 1.8 }),
      s('text', { class: 'net-label', x: x1 + dir * 4, y: y + 3.5, 'text-anchor': dir > 0 ? 'start' : 'end', text: net }));
  }

  function select(id) {
    selected = id;
    applyHighlight();
    $('schematic').focus({ preventScroll: true });
  }
  function setHighlight(id) {
    highlight = id;
    applyHighlight();
  }
  function applyHighlight() {
    const svg = $('schematic');
    if (!svg) return;
    svg.classList.toggle('dim', !!highlight);
    svg.querySelectorAll('[data-inst]').forEach((el) => {
      el.classList.toggle('hl', el.getAttribute('data-inst') === highlight);
      el.classList.toggle('sel', el.getAttribute('data-inst') === selected);
    });
    document.querySelectorAll('.conn-card[data-inst]').forEach((el) => {
      el.classList.toggle('hl', el.getAttribute('data-inst') === highlight);
      el.classList.toggle('sel', el.getAttribute('data-inst') === selected);
    });
  }

  function initCanvas() {
    const svg = $('schematic');
    const toSvg = (cx, cy) => {
      const m = svg.getScreenCTM();
      if (!m) return { x: 0, y: 0 };
      const pt = new DOMPoint(cx, cy).matrixTransform(m.inverse());
      return { x: pt.x, y: pt.y };
    };
    const setView = () => svg.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    svg.addEventListener('wheel', (e) => {
      if (!view) return;
      e.preventDefault();
      const f = e.deltaY > 0 ? 1.12 : 1 / 1.12;
      const p = toSvg(e.clientX, e.clientY);
      view = { ...view, x: p.x - (p.x - view.x) * f, y: p.y - (p.y - view.y) * f, w: view.w * f, h: view.h * f };
      userView = true;
      setView();
    }, { passive: false });
    let drag = null;
    svg.addEventListener('mousedown', (e) => {
      if (!view || e.button !== 0) return;
      drag = { start: toSvg(e.clientX, e.clientY), moved: false, sx: e.clientX, sy: e.clientY };
    });
    window.addEventListener('mousemove', (e) => {
      if (!drag || !view) return;
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) {
        drag.moved = true;
        svg.classList.add('panning');
        hideTip();
      }
      if (!drag.moved) return;
      const p = toSvg(e.clientX, e.clientY);
      view = { ...view, x: view.x - (p.x - drag.start.x), y: view.y - (p.y - drag.start.y) };
      userView = true;
      setView();
    });
    window.addEventListener('mouseup', () => {
      drag = null;
      svg.classList.remove('panning');
    });
    svg.addEventListener('click', () => { selected = null; applyHighlight(); });
    svg.addEventListener('contextmenu', (e) => { e.preventDefault(); canvasMenu(e.clientX, e.clientY); });
    document.addEventListener('keydown', (e) => {
      if (ui.tab !== 'design' || isTyping() || document.querySelector('.modal-overlay')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        removeComponent(selected);
      } else if (e.key === 'Escape') {
        selected = null;
        closeMenu();
        applyHighlight();
      }
    });
  }

  // ================================================================ dışa açılanlar
  ES.tabs.design = {
    mount,
    render() {
      applyLayout();
      $('undo').disabled = !ES.canUndo();
      $('redo').disabled = !ES.canRedo();
      renderLibrary();
      renderNotes();
      renderConnections();
      renderSchematic();
      renderDock();
      applyView();
    },
    onShow: () => { renderSchematic(); applyView(); },
    designView: () => designView(),
    // ES-1005: Pinout sekmesi aynı pencereleri kullanır
    labelDialog: (pin) => labelDialog(pin),
    confirmConflict: (key, ch, onMove, onCancel) => confirmConflict(key, ch, onMove, onCancel),
    locksOnPin: (pin, exceptInst) => locksOnPin(pin, exceptInst),
    setRightPanel,
    renderLibrary,
    /** Kütüphanede varsa hemen, yoksa kütüphane yenilenince tasarıma ekler. */
    addWhenAvailable(id) {
      if (state.lib.components[id]) return addComponent(id);
      const once = () => { if (state.lib.components[id]) addComponent(id); };
      ES.on('init', once);
    }
  };
  ES.compCard = compCard;
  ES.on('init', () => { if ($('library')) renderLibrary(); });
})();
