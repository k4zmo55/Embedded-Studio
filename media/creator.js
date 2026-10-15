/* Komponent oluşturucu: JSON yazmadan yeni komponent tanımlama / mevcut olanı düzenleme.
 * Solda form, sağda canlı önizleme (şema sembolü, bilgi kartı, doğrulama, JSON).
 * Doğrulama tek kaynaktan: eklentideki validateComponent (comp.validate mesajı). */
(function () {
  const { t, h, s, $, post, state, icon, modal, toast, KIND_LABEL } = ES;

  const ROLES = [
    ['power', t('Besleme (VCC)')],
    ['ground', t('Toprak (GND)')],
    ['i2c.SCL', 'I2C SCL'],
    ['i2c.SDA', 'I2C SDA'],
    ['spi.SCK', t('SPI SCK (saat)')],
    ['spi.MISO', t('SPI MISO (modül → MCU)')],
    ['spi.MOSI', t('SPI MOSI (MCU → modül)')],
    ['spi.CS', t('SPI CS (seçim)')],
    ['uart.TX', t('UART: MCU TX\'e bağlanır (modülün RX\'i)')],
    ['uart.RX', t('UART: MCU RX\'e bağlanır (modülün TX\'i)')],
    ['gpio.in', t('GPIO giriş (MCU okur)')],
    ['gpio.out', t('GPIO çıkış (MCU sürer)')],
    ['adc', t('Analog çıkış (MCU ADC okur)')],
    ['pwm', t('PWM girişi (MCU PWM üretir)')]
  ];
  const INTERFACES = [
    ['i2c', 'I2C', t('Adresli iki telli bus. Birden çok cihaz aynı hatta.')],
    ['spi', 'SPI', t('Hızlı 4 telli bus; her cihaza ayrı CS.')],
    ['uart', 'UART', t('Seri port (GPS, modem, USB-seri…).')],
    ['gpio', 'GPIO', t('Dijital giriş/çıkış (buton, LED, röle…).')],
    ['adc', t('Analog'), t('Gerilim okuma (pot, LDR, analog sensör).')],
    ['pwm', 'PWM', t('Darbe genişliği (servo, motor sürücü, LED parlaklığı).')]
  ];
  /** Arayüze göre standart pin seti. */
  const DEFAULT_PINS = {
    i2c: [['VCC', 'power'], ['GND', 'ground'], ['SCL', 'i2c.SCL'], ['SDA', 'i2c.SDA']],
    spi: [['VCC', 'power'], ['GND', 'ground'], ['SCK', 'spi.SCK'], ['MISO', 'spi.MISO'], ['MOSI', 'spi.MOSI'], ['CS', 'spi.CS']],
    uart: [['VCC', 'power'], ['GND', 'ground'], ['RX', 'uart.TX'], ['TX', 'uart.RX']],
    gpio: [['VCC', 'power'], ['GND', 'ground'], ['OUT', 'gpio.in']],
    adc: [['VCC', 'power'], ['GND', 'ground'], ['OUT', 'adc']],
    pwm: [['VCC', 'power'], ['GND', 'ground'], ['SIG', 'pwm']]
  };
  const CHIP_SHAPES = [['qfn', t('QFN (kare çip)')], ['soic', t('SOIC (bacaklı)')], ['metal-lid', t('Metal kapak')], ['oled', t('Ekran')]];

  let draft = null;        // düzenlenen komponent
  let originalId = null;   // düzenleme modunda eski kimlik
  let idTouched = false;   // kullanıcı kimliği elle değiştirdi mi
  let dirty = false;
  let errors = [];
  let validated = false;  // eklentiden ilk doğrulama sonucu geldi mi
  let saving = false;     // kaydetme isteği yanıt bekliyor (çift tıklamayı engeller)
  let seq = 0;
  let dlg = null;
  let validateTimer = 0;

  const slug = (t) => t.toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c])
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(\d)/, 'k$1').slice(0, 40);

  function blank() {
    return {
      id: '', name: '', category: t('Sensör'), description: '', keywords: [], interface: 'i2c',
      voltage: { min: 3.0, max: 3.6 },
      i2c: { address: '0x40', altAddresses: [], maxSpeedHz: 400000, onboardPullups: true },
      spi: { maxSpeedHz: 1000000, mode: 0 },
      uart: { baud: 9600 },
      pwm: { frequencyHz: 50 },
      sampleMs: 1000, datasheet: '',
      art: { board: '#1d4f91', chip: '', chipShape: 'qfn' },
      pins: DEFAULT_PINS.i2c.map(([name, role]) => ({ name, role })),
      telemetry: [],
      monitor: []
    };
  }

  /** Mevcut komponentten taslak (düzenleme ya da kopya). */
  function fromComponent(c, copy) {
    const d = { ...blank(), ...JSON.parse(JSON.stringify(c)) };
    for (const k of ['i2c', 'spi', 'uart', 'pwm']) d[k] = { ...blank()[k], ...(c[k] || {}) };
    d.art = { ...blank().art, ...(c.art || {}) };
    d.imageUri = c.image && /^(https?:|data:|vscode-|http)/.test(c.image) ? c.image : undefined;
    d.image = c.imageFile && !/^https?:/.test(c.imageFile) ? c.imageFile : c.imageFile || '';
    d.keywords = c.keywords || [];
    d.monitor = c.monitor || [];
    d.telemetry = (c.telemetry || []).map((t) => ({ ...t, sim: t.sim && !t.sim.kind ? { ...t.sim } : t.sim }));
    delete d.source;
    delete d.imageFile;
    if (copy) {
      d.id = `${c.id}_ozel`;
      d.name = t('{0} (özel)', c.name);
      d.image = '';
      d.imageUri = undefined;
    }
    return d;
  }

  /** Kaydedilecek temiz nesne (eklenti tarafında da temizlenir). */
  function output() {
    const d = JSON.parse(JSON.stringify(draft));
    delete d.imageUri;
    for (const k of ['i2c', 'spi', 'uart', 'pwm']) if (d.interface !== k) delete d[k];
    if (d.i2c) d.i2c.altAddresses = (d.i2c.altAddresses || []).filter(Boolean);
    if (!d.datasheet) delete d.datasheet;
    if (!d.image) delete d.image;
    if (!d.monitor.length) delete d.monitor;
    if (!d.art.chip) d.art.chip = d.name.slice(0, 10);
    d.sampleMs = Number(d.sampleMs) || 0;
    return d;
  }

  function change(structural) {
    dirty = true;
    if (structural) renderForm();
    renderPreview();
    clearTimeout(validateTimer);
    validateTimer = setTimeout(() => { if (draft) post({ type: 'comp.validate', seq: ++seq, component: output() }); }, 150);
  }

  // ================================================================ form
  const field = (label, control, hint) => h('label', { class: 'cf-field' }, h('span', { class: 'cf-label', text: label }), control, hint ? h('span', { class: 'hint', text: hint }) : null);
  const text = (value, oninput, attrs = {}) => h('input', { type: 'text', value: value ?? '', oninput: (e) => { oninput(e.target.value); change(false); }, ...attrs });
  const num = (value, oninput, attrs = {}) => h('input', { type: 'number', class: 'num', value: value ?? '', oninput: (e) => { oninput(e.target.value === '' ? undefined : Number(e.target.value)); change(false); }, ...attrs });
  const select = (value, options, onchange, structural, attrs = {}) => h('select', { onchange: (e) => { onchange(e.target.value); change(structural); }, ...attrs },
    ...options.map(([v, l]) => h('option', { value: v, selected: String(v) === String(value), text: l })));
  const section = (title, ...children) => h('section', { class: 'cf-section' }, h('h4', { text: title }), ...children);

  function renderForm() {
    const box = $('cf-form');
    if (!box) return;
    const d = draft;
    const categories = [...new Set(Object.values(state.lib.components).map((c) => c.category).filter(Boolean))];
    const usedInDesign = originalId && state.design && state.design.instances.some((i) => i.componentId === originalId);

    const ifaceCards = h('div', { class: 'cf-ifaces' }, ...INTERFACES.map(([v, l, desc]) => h('button', {
      class: `cf-iface${d.interface === v ? ' selected' : ''}`, type: 'button', title: desc,
      onclick: () => {
        if (d.interface === v) return;
        const wasDefault = JSON.stringify(d.pins) === JSON.stringify(DEFAULT_PINS[d.interface].map(([name, role]) => ({ name, role })));
        d.interface = v;
        if (wasDefault || !d.pins.length) d.pins = DEFAULT_PINS[v].map(([name, role]) => ({ name, role }));
        change(true);
      }
    }, h('span', { class: `iface k-${v}`, text: l }), h('span', { class: 'hint', text: desc }))));

    let ifaceFields = null;
    if (d.interface === 'i2c') {
      ifaceFields = h('div', { class: 'cf-row' },
        field(t('I2C adresi (7-bit)'), text(d.i2c.address, (v) => (d.i2c.address = v.trim()), { placeholder: '0x76', class: 'mono', id: 'cf-addr' }), t('Datasheet\'te "slave address".')),
        field(t('Alternatif adresler'), text((d.i2c.altAddresses || []).join(', '), (v) => (d.i2c.altAddresses = v.split(',').map((x) => x.trim()).filter(Boolean)), { placeholder: '0x77', class: 'mono' }), t('ADDR/SDO pinine göre. Çakışmada kullanılır.')),
        field(t('En yüksek hız'), select(d.i2c.maxSpeedHz, [[100000, t('100 kHz (standart)')], [400000, '400 kHz (fast)'], [1000000, '1 MHz (fast+)']], (v) => (d.i2c.maxSpeedHz = Number(v)))),
        h('label', { class: 'check cf-check' }, h('input', { type: 'checkbox', checked: d.i2c.onboardPullups, onchange: (e) => { d.i2c.onboardPullups = e.target.checked; change(false); } }), h('span', { text: t('Modülde pull-up direnci var') })));
    } else if (d.interface === 'spi') {
      ifaceFields = h('div', { class: 'cf-row' },
        field(t('En yüksek saat (Hz)'), num(d.spi.maxSpeedHz, (v) => (d.spi.maxSpeedHz = v), { min: 1000, step: 1000 })),
        field(t('SPI modu'), select(d.spi.mode, [[0, t('Mod 0 (CPOL 0, CPHA 0)')], [1, t('Mod 1')], [2, t('Mod 2')], [3, t('Mod 3')]], (v) => (d.spi.mode = Number(v)))));
    } else if (d.interface === 'uart') {
      ifaceFields = h('div', { class: 'cf-row' },
        field(t('Baud hızı'), select(d.uart.baud, [4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => [b, String(b)]), (v) => (d.uart.baud = Number(v)))));
    } else if (d.interface === 'pwm') {
      ifaceFields = h('div', { class: 'cf-row' },
        field(t('PWM frekansı (Hz)'), num(d.pwm.frequencyHz, (v) => (d.pwm.frequencyHz = v), { min: 1 }), t('Servo için 50 Hz.')));
    }

    // ---- pinler ----
    const pinRows = d.pins.map((p, i) => h('div', { class: 'cf-pin' },
      h('span', { class: 'hint mono', text: String(i + 1) }),
      text(p.name, (v) => (p.name = v.toUpperCase()), { class: 'mono', placeholder: t('Pin adı'), 'aria-label': t('Pin {0} adı', i + 1) }),
      select(p.role, ROLES, (v) => (p.role = v), false, { 'aria-label': t('Pin {0} rolü', i + 1) }),
      h('button', { class: 'icon tiny', title: t('Yukarı'), disabled: i === 0, onclick: () => { [d.pins[i - 1], d.pins[i]] = [d.pins[i], d.pins[i - 1]]; change(true); } }, '↑'),
      h('button', { class: 'icon tiny', title: t('Aşağı'), disabled: i === d.pins.length - 1, onclick: () => { [d.pins[i + 1], d.pins[i]] = [d.pins[i], d.pins[i + 1]]; change(true); } }, '↓'),
      h('button', { class: 'icon tiny', title: t('Pini sil'), onclick: () => { d.pins.splice(i, 1); change(true); } }, icon('close', 11))));

    // ---- ölçümler ----
    const telRows = d.telemetry.map((m, i) => {
      const special = m.sim && m.sim.kind;
      if (!m.sim) m.sim = { base: 0, amp: 1, periodS: 10, noise: 0 };
      return h('div', { class: 'cf-tel' },
        text(m.id, (v) => {
          const old = m.id;
          m.id = v.trim();
          for (const w of d.monitor) w.channels = w.channels.map((c) => (c === old ? m.id : c));
        }, { class: 'mono', placeholder: t('ad (ör. temp)'), 'aria-label': t('Ölçüm {0} adı', i + 1), onchange: () => change(true) }),
        text(m.unit, (v) => (m.unit = v), { placeholder: t('birim'), class: 'unit', 'aria-label': t('Ölçüm {0} birimi', i + 1) }),
        special ? h('span', { class: 'hint', text: t('simülasyon: {0}', m.sim.kind) }) : h('span', { class: 'cf-sim', title: t('Simülasyonda üretilecek değer: taban ± genlik, periyot saniye') },
          'sim', num(m.sim.base, (v) => (m.sim.base = v ?? 0), { title: t('taban'), 'aria-label': t('taban') }),
          '±', num(m.sim.amp, (v) => (m.sim.amp = v ?? 0), { title: t('genlik'), 'aria-label': t('genlik') }),
          num(m.sim.periodS, (v) => (m.sim.periodS = v || 10), { title: t('periyot (sn)'), 'aria-label': t('periyot') }), t('sn')),
        h('button', {
          class: 'icon tiny', title: t('Ölçümü sil'),
          onclick: () => {
            d.telemetry.splice(i, 1);
            for (const w of d.monitor) w.channels = w.channels.filter((c) => c !== m.id);
            d.monitor = d.monitor.filter((w) => w.channels.length);
            change(true);
          }
        }, icon('close', 11)));
    });

    // ---- monitör ----
    const ids = d.telemetry.map((m) => m.id).filter(Boolean);
    const monRows = d.monitor.map((w, i) => {
      const okTypes = Object.entries(ES.widgets.types).filter(([, wt]) => wt.ok(w.channels.length || 1, w.channels));
      return h('div', { class: 'cf-mon' },
        select(w.type, okTypes.map(([k, wt]) => [k, wt.label]), (v) => (w.type = v), true, { 'aria-label': t('Widget türü') }),
        h('div', { class: 'cf-chans' }, ...ids.map((id) => h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: w.channels.includes(id), onchange: (e) => { w.channels = e.target.checked ? [...w.channels, id] : w.channels.filter((c) => c !== id); change(true); } }),
          h('span', { text: id })))),
        ['gauge', 'thermo'].includes(w.type) ? h('span', { class: 'cf-minmax' }, 'min', num(w.min, (v) => (w.min = v)), 'max', num(w.max, (v) => (w.max = v))) : null,
        h('button', { class: 'icon tiny', title: t('Widget\'ı sil'), onclick: () => { d.monitor.splice(i, 1); change(true); } }, icon('close', 11)));
    });

    box.replaceChildren(
      section(t('Temel bilgiler'),
        h('div', { class: 'cf-row' },
          field(t('Ad'), text(d.name, (v) => { d.name = v; if (!idTouched && !originalId) { d.id = slug(v); const el = $('cf-id'); if (el) el.value = d.id; } }, { id: 'cf-name', placeholder: t('ör. BMP180') })),
          field(t('Kimlik (id)'), text(d.id, (v) => { d.id = v.trim(); idTouched = true; }, { id: 'cf-id', class: 'mono', placeholder: 'bmp180', disabled: usedInDesign }),
            usedInDesign ? t('Tasarımda kullanıldığı için değiştirilemez.') : t('Küçük harf, rakam ve _. Kod ve dosya adında kullanılır.'))),
        h('div', { class: 'cf-row' },
          field(t('Kategori'), h('span', {}, text(d.category, (v) => (d.category = v), { list: 'cf-cats' }), h('datalist', { id: 'cf-cats' }, ...categories.map((c) => h('option', { value: c }))))),
          field(t('Örnekleme periyodu (ms)'), num(d.sampleMs, (v) => (d.sampleMs = v ?? 0), { min: 0, step: 10 }), t('0: periyodik okuma yok (ör. ekran).'))),
        field(t('Açıklama'), text(d.description, (v) => (d.description = v), { placeholder: t('Kısa açıklama') })),
        h('div', { class: 'cf-row' },
          field(t('Anahtar kelimeler'), text(d.keywords.join(', '), (v) => (d.keywords = v.split(',').map((x) => x.trim()).filter(Boolean)), { placeholder: t('basınç, barometre') }), t('Asistan bu kelimelerle önerir.')),
          field(t('Datasheet bağlantısı'), text(d.datasheet, (v) => (d.datasheet = v.trim()), { placeholder: 'https://…/datasheet.pdf' })))),
      section(t('Arayüz ve besleme'),
        ifaceCards,
        ifaceFields,
        h('div', { class: 'cf-row' },
          field(t('Besleme min (V)'), num(d.voltage.min, (v) => (d.voltage.min = v), { step: 0.1 })),
          field(t('Besleme max (V)'), num(d.voltage.max, (v) => (d.voltage.max = v), { step: 0.1 }), t('Min > 3.3 V ise 5 V hattına bağlanır.')))),
      section(t('Pinler'),
        h('p', { class: 'hint', text: t('Rol, pinin MCU tarafında neye bağlanacağını belirler. Asistan pin atamasını bu rollere göre yapar.') }),
        h('div', { class: 'cf-pins', id: 'cf-pins' }, ...pinRows),
        h('div', { class: 'cf-actions' },
          h('button', { class: 'ghost small', id: 'cf-add-pin', onclick: () => { d.pins.push({ name: `P${d.pins.length + 1}`, role: 'gpio.in' }); change(true); } }, icon('plus', 11), t('Pin ekle')),
          h('button', { class: 'ghost small', id: 'cf-fill-pins', onclick: () => { d.pins = DEFAULT_PINS[d.interface].map(([name, role]) => ({ name, role })); change(true); } }, t('{0} için standart pinler', KIND_LABEL[d.interface])))),
      section(t('Ölçümler (telemetri)'),
        h('p', { class: 'hint', text: t('Firmware\'in monitöre göndereceği değerler. Simülasyon alanları kart yokken monitörde görülecek veriyi belirler.') }),
        ...telRows,
        h('div', { class: 'cf-actions' },
          h('button', { class: 'ghost small', id: 'cf-add-tel', onclick: () => { d.telemetry.push({ id: d.telemetry.length ? `deger${d.telemetry.length + 1}` : 'deger', unit: '', sim: { base: 0, amp: 1, periodS: 10, noise: 0 } }); change(true); } }, icon('plus', 11), t('Ölçüm ekle')))),
      section(t('Monitör görünümü'),
        h('p', { class: 'hint', text: ids.length ? t('Boş bırakılırsa tüm ölçümler tek grafikte gösterilir.') : t('Önce bir ölçüm ekleyin.') }),
        ...monRows,
        h('div', { class: 'cf-actions' },
          h('button', {
            class: 'ghost small', id: 'cf-add-mon', disabled: !ids.length,
            onclick: () => {
              const now = d.telemetry.map((m) => m.id).filter(Boolean);
              if (!now.length) return;
              d.monitor.push({ type: now.length === 1 ? 'gauge' : 'chart', channels: now.slice(0, now.length === 1 ? 1 : 3) });
              change(true);
            }
          }, icon('plus', 11), t('Widget ekle')))),
      section(t('Görünüm'),
        h('div', { class: 'cf-row' },
          field(t('Kart rengi'), h('input', { type: 'color', value: d.art.board || '#1d4f91', oninput: (e) => { d.art.board = e.target.value; change(false); } })),
          field(t('Çip etiketi'), text(d.art.chip, (v) => (d.art.chip = v), { placeholder: d.name.slice(0, 10) || 'BMP180' })),
          field(t('Çip şekli'), select(d.art.chipShape, CHIP_SHAPES, (v) => (d.art.chipShape = v)))),
        h('div', { class: 'cf-actions' },
          h('button', { class: 'ghost small', onclick: () => post({ type: 'comp.pickImage' }) }, icon('upload', 11), d.image ? t('Görseli değiştir') : t('Kendi görselini seç…')),
          d.image ? h('button', { class: 'ghost small', onclick: () => { d.image = ''; d.imageUri = undefined; change(true); } }, t('Görseli kaldır')) : null,
          h('span', { class: 'hint', text: d.image ? d.image : t('Görsel seçilmezse yukarıdaki ayarlarla çizim üretilir.') }))));
  }

  // ================================================================ önizleme
  function symbol(d) {
    const P = 20, W = 110;
    const sig = d.pins.filter((p) => p.role !== 'power' && p.role !== 'ground');
    const pow = d.pins.filter((p) => p.role === 'power' || p.role === 'ground');
    const rows = Math.max(sig.length, pow.length, 1);
    const H = (rows + 1) * P;
    const svg = s('svg', { viewBox: `-60 -26 ${W + 120} ${H + 46}`, class: 'cf-symbol', role: 'img', 'aria-label': t('Şema sembolü önizlemesi') },
      s('text', { class: 'sym-title', x: 0, y: -8, text: `${(d.id || t('KOMPONENT')).toUpperCase()}_1` }),
      s('rect', { class: 'sym-body', x: 0, y: 0, width: W, height: H, rx: 2 }),
      s('text', { class: 'sym-sub', x: W / 2, y: H + 14, 'text-anchor': 'middle', text: d.name || t('Ad') }));
    const kind = (role) => (role.startsWith('i2c') ? 'i2c' : role.startsWith('spi') ? 'spi' : role.startsWith('uart') ? 'uart' : role === 'adc' ? 'adc' : role === 'pwm' ? 'pwm' : 'gpio');
    sig.forEach((p, i) => {
      const y = (i + 1) * P;
      svg.append(
        s('line', { class: `pin-line`, x1: 0, y1: y, x2: -16, y2: y }),
        s('line', { class: `wire w-${kind(p.role)}`, x1: -16, y1: y, x2: -44, y2: y }),
        s('text', { class: 'pin-name', x: 6, y: y + 3.5, text: p.name || '?' }));
    });
    pow.forEach((p, i) => {
      const y = (i + 1) * P;
      svg.append(
        s('line', { class: 'pin-line', x1: W, y1: y, x2: W + 16, y2: y }),
        s('text', { class: 'pin-name', x: W - 6, y: y + 3.5, 'text-anchor': 'end', text: p.name || '?' }),
        s('text', { class: `net-label ${p.role === 'ground' ? 'n-ground' : 'n-power'}`, x: W + 20, y: y + 3.5, text: p.role === 'ground' ? 'GND' : d.voltage.min > 3.3 ? '5V' : '3V3' }));
    });
    return svg;
  }

  function renderPreview() {
    const box = $('cf-preview');
    if (!box) return;
    const d = draft;
    const c = { ...output(), image: d.imageUri };
    box.replaceChildren(
      h('div', { class: 'cf-prev-head', text: t('Şema sembolü') }),
      h('div', { class: 'cf-prev-symbol' }, symbol(d)),
      h('div', { class: 'cf-prev-head', text: t('Bilgi kartı') }),
      h('div', { class: 'cf-prev-card' }, ES.compCard(c)),
      h('div', { class: 'cf-prev-head' }, t('Doğrulama') + ' ', !validated ? h('span', { class: 'badge', text: '…' }) : errors.length ? h('span', { class: 'badge err', text: String(errors.length) }) : h('span', { class: 'badge ok', text: '✓' })),
      h('div', { class: 'notes', id: 'cf-errors' }, ...(!validated
        ? [h('div', { class: 'note info' }, h('span', { class: 'ic', text: '…' }), h('span', { text: t('Doğrulanıyor…') }))]
        : errors.length
        ? errors.map((e) => h('div', { class: 'note error' }, h('span', { class: 'ic', text: '✕' }), h('span', { text: e })))
        : [h('div', { class: 'note info' }, h('span', { class: 'ic', text: '✓' }), h('span', { text: t('Kaydetmeye hazır.') }))])),
      h('details', { class: 'cf-json' }, h('summary', { text: 'JSON' }), h('pre', { text: JSON.stringify(output(), null, 2) })));
    const save = $('cf-save');
    const blocked = saving || !validated || errors.length > 0;
    if (save) save.disabled = blocked;
    const saveAdd = $('cf-save-add');
    if (saveAdd) saveAdd.disabled = blocked;
  }

  // ================================================================ aç / kaydet
  function open(comp, mode) {
    // mode: 'new' | 'edit' | 'copy'
    draft = comp ? fromComponent(comp, mode === 'copy') : blank();
    originalId = mode === 'edit' ? comp.id : null;
    idTouched = mode !== 'new';
    dirty = false;
    errors = [];
    validated = false;
    saving = false;
    const warn = h('span', { class: 'cf-warn', id: 'cf-warn' });
    const body = h('div', { class: 'creator' }, h('div', { class: 'cf-form', id: 'cf-form' }), h('aside', { class: 'cf-preview', id: 'cf-preview' }));
    let confirmClose = false;
    dlg = modal({
      title: mode === 'edit' ? t('Komponenti düzenle · {0}', comp.name) : mode === 'copy' ? t('Kopyasını düzenle · {0}', comp.name) : t('Yeni komponent'),
      className: 'modal-wide',
      body,
      footLeft: h('span', { class: 'cf-foot-left' },
        h('button', { class: 'ghost small', title: t('JSON dosyası olarak kaydet (paylaşmak için)'), onclick: () => post({ type: 'comp.export', component: output() }) }, t('Dışa aktar…')),
        warn),
      beforeClose: () => {
        if (!dirty || confirmClose) return true;
        confirmClose = true;
        warn.replaceChildren(t('Kaydedilmemiş değişiklikler var. Yine de kapatmak için tekrar Kapat\'a basın.'));
        return false;
      },
      onClose: () => { clearTimeout(validateTimer); dlg = null; draft = null; },
      buttons: [
        { label: t('Kapat') },
        { label: t('Kaydet'), id: 'cf-save', action: () => { save(false); return false; } },
        { label: t('Kaydet ve tasarıma ekle'), id: 'cf-save-add', primary: true, action: () => { save(true); return false; } }
      ]
    });
    renderForm();
    renderPreview();
    post({ type: 'comp.validate', seq: ++seq, component: output() });
    setTimeout(() => $('cf-name') && $('cf-name').focus(), 50);
  }

  function save(addToDesign) {
    if (!validated || saving) return;
    if (errors.length) return toast('warn', t('Önce doğrulama hatalarını düzeltin.'));
    saving = true;
    renderPreview();
    post({ type: 'comp.save', component: output(), originalId, addToDesign });
  }

  ES.on('comp.validation', (m) => {
    if (!draft || m.seq !== seq) return;
    errors = m.errors;
    validated = true;
    renderPreview();
  });
  ES.on('comp.image', (m) => {
    if (!draft) return;
    draft.image = m.image;
    draft.imageUri = m.uri;
    change(true);
  });
  ES.on('comp.result', (m) => {
    if (!draft) return;
    saving = false;
    if (!m.ok) {
      if (m.errors && m.errors.length) errors = m.errors;
      renderPreview();
      return;
    }
    dirty = false;
    const id = m.id;
    if (dlg) dlg.close(true);
    // Kütüphane yeniden yüklendikten sonra (init mesajı) tasarıma ekle
    if (m.addToDesign) ES.tabs.design.addWhenAvailable(id);
  });

  ES.creator = { open };
})();
