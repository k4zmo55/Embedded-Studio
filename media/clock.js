/* Clock sekmesi: CubeMX "Clock Configuration" benzeri saat ağacı düzenleyici.
 * PLL bölümü MCU'nun saat modeline göre çizilir (src/engine/clock.js):
 *   f4 (F4/F7) /M ×N /P /Q · mul (F0/F1/F3) PREDIV ×PLLMUL · mnr (G0/G4/L4/U5) /M ×N /R · h7 /M ×N /P /Q
 * Çevre birimi tablosunu eklenti hesaplar (src/engine/periphclock.js), burada sadece gösterilir. */
(function () {
  const { t, h, s, $, post, state, update } = ES;

  const W = 1120, H = 470;

  function mount(parent) {
    parent.append(h('main', { id: 'clock', class: 'tab-pane' },
      h('div', { class: 'clock-bar' },
        h('label', {}, t('Hedef SYSCLK'),
          h('input', { type: 'number', id: 'clk-target', min: 1, max: 100, value: 100, class: 'num' }), 'MHz'),
        h('button', { onclick: () => post({ type: 'clock.solve', target: Number($('clk-target').value) || 100 }) }, t('Otomatik çöz')),
        h('span', { class: 'spacer' }),
        h('span', { id: 'clk-summary', class: 'hint' })),
      h('div', { class: 'clock-scroll' }, h('div', { class: 'clock-canvas', id: 'clock-canvas' })),
      h('div', { class: 'clock-bottom' },
        h('div', { id: 'clk-issues', class: 'notes' }),
        h('div', {}, h('h3', { text: t('Çevre birimi saatleri') }), h('div', { id: 'clk-periphs' })))));
  }

  /** Saat ayarını değiştir ve gönder. */
  function set(field, value) {
    state.design.clock = { ...state.design.clock, [field]: value };
    update();
  }

  const fmt = (v) => (v >= 100 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(3)).replace(/\.?0+$/, '');
  /** [min, max] aralığı (2 eleman) ya da değer listesi */
  const valuesOf = (spec) => (spec.length === 2 ? Array.from({ length: spec[1] - spec[0] + 1 }, (_, i) => spec[0] + i) : spec);
  let lastMcu = null;

  function render() {
    const canvas = $('clock-canvas');
    if (!canvas || !state.clock) return;
    const ck = state.clock, c = ck.config, f = ck.freq;
    const mcu = state.lib.mcus[state.design.mcuId];
    const def = mcu.clock;
    const model = ck.model || def.model || 'f4';
    const twoApb = def.limits.apb2 !== undefined;
    const bad = new Set(ck.issues.filter((i) => i.level === 'error').map((i) => i.field));
    const warnF = new Set(ck.issues.filter((i) => i.level === 'warn').map((i) => i.field));
    const L = def.limits;
    // MCU değişince hedef frekans kutusunu yeni sınırlara getir
    const target = $('clk-target');
    if (target && lastMcu !== mcu.id) {
      target.max = L.sysclk;
      target.value = L.sysclk;
      lastMcu = mcu.id;
    }

    const nodes = [];
    const box = (x, y, w, title, body, cls = '') => nodes.push(h('div', { class: `ck-node ${cls}`, style: `left:${x}px;top:${y}px;width:${w}px` }, title ? h('div', { class: 'ck-title', text: title }) : null, body));
    const freq = (v, field, max) => h('div', { class: `ck-freq${bad.has(field) ? ' bad' : warnF.has(field) ? ' warn' : ''}`, title: max ? t('En fazla {0} MHz', max) : '' }, fmt(v), h('small', { text: ' MHz' }));
    const select = (field, values, value, label) => h('select', { 'aria-label': label || field, class: bad.has(field) ? 'bad' : '', onchange: (e) => set(field, Number(e.target.value)) },
      ...values.map((v) => h('option', { value: v, selected: v === value, text: String(v) })));
    const numInput = (field, min, max, value, step = 1) => h('input', {
      type: 'number', class: `num${bad.has(field) ? ' bad' : ''}`, min, max, step, value,
      'aria-label': field,
      onchange: (e) => { const v = Number(e.target.value); if (v >= min && v <= max) set(field, v); else render(); }
    });
    const radio = (field, options, value) => h('div', { class: 'ck-radio' }, ...options.map(([v, label]) => h('label', {},
      h('input', { type: 'radio', name: field, checked: value === v, onchange: () => set(field, v) }), h('span', { text: label }))));
    const label = (x, y, text, cls = '') => nodes.push(h('div', { class: `ck-label ${cls}`, style: `left:${x}px;top:${y}px`, text }));

    // Kaynaklar
    box(20, 70, 120, model === 'h7' ? 'HSI RC (64 MHz)' : 'HSI RC', freq(f.hsi), 'src');
    box(20, 240, 120, t('HSE kristal'), h('div', { class: 'ck-row' }, numInput('hseMHz', def.hseRange[0], def.hseRange[1], c.hseMHz, 0.5), h('small', { text: 'MHz' })), `src${bad.has('hse') ? ' bad' : ''}`);
    // PLL
    const hsiFixed = model === 'mul' && !def.hsiPrediv; // F0/F1: HSI PLL'e sabit /2 ile girer
    box(190, 150, 110, t('PLL kaynağı'), radio('pllSource', [['HSI', hsiFixed ? 'HSI/2' : 'HSI'], ['HSE', 'HSE']], c.pllSource), 'mux');
    const outDiv = model === 'mnr' ? ['R', def.pllR] : model === 'mul' ? null : ['P', def.pllP];
    if (model === 'mul') {
      // PREDIV yalnız HSE yolunda; HSI sabit /2
      box(340, 160, 84, '/ PREDIV', c.pllSource === 'HSE' || !hsiFixed ? select('M', valuesOf(def.pllM), c.M) : h('div', { class: 'ck-sub', text: 'HSI/2' }));
      box(450, 160, 100, '× PLLMUL', select('N', valuesOf(def.pllN), c.N));
      label(428, 224, t('PLL giriş {0} MHz', fmt(f.pllIn)));
    } else {
      box(340, 160, 84, '/ M', select('M', valuesOf(def.pllM), c.M));
      box(450, 160, 100, '× N', numInput('N', def.pllN[0], def.pllN[def.pllN.length - 1], c.N));
      box(580, 110, 84, `/ ${outDiv[0]}`, select(outDiv[0], valuesOf(outDiv[1]), c[outDiv[0]]));
      label(428, 224, t('VCO giriş {0} MHz', fmt(f.pllIn)));
      label(450, 136, `VCO ${fmt(f.vco)} MHz`, bad.has('N') ? 'bad' : '');
    }
    if (model === 'f4') {
      box(580, 230, 84, '/ Q', select('Q', valuesOf(def.pllQ), c.Q));
      box(700, 230, 110, t('48 MHz çıkış'), freq(f.pll48, 'Q'), 'out small');
    } else if (model === 'h7') {
      box(580, 230, 84, '/ Q', select('Q', valuesOf(def.pllQ), c.Q));
      box(700, 230, 110, t('SPI1-3 çekirdek'), freq(f.pllq, 'Q', L.pllq), 'out small');
    }
    const aux = model === 'f4' || model === 'h7';
    nodes.push(h('div', { class: 'ck-pll-frame', style: 'left:320px;top:96px;width:362px;height:206px' }, h('span', { text: 'PLL' })));
    // Sistem saati
    box(700, 60, 120, t('Sistem saati'), radio('sysclkSource', [['HSI', 'HSI'], ['HSE', 'HSE'], ['PLL', 'PLLCLK']], c.sysclkSource), 'mux');
    box(850, 70, 110, 'SYSCLK', freq(f.sysclk, 'sysclk', L.sysclk), 'out');
    box(850, 170, 110, 'AHB /', select('ahb', def.ahb, c.ahb));
    box(990, 170, 110, 'HCLK', freq(f.hclk, 'hclk', L.hclk), 'out');
    box(850, 270, 110, twoApb ? 'APB1 /' : 'APB /', select('apb1', def.apb, c.apb1));
    box(990, 260, 110, twoApb ? 'PCLK1' : 'PCLK', h('div', {}, freq(f.pclk1, 'apb1', L.apb1), h('div', { class: 'ck-sub', text: `Timer ${fmt(f.tim1)} MHz` })), 'out');
    if (twoApb) {
      box(850, 370, 110, 'APB2 /', select('apb2', def.apb, c.apb2));
      box(990, 360, 110, 'PCLK2', h('div', {}, freq(f.pclk2, 'apb2', L.apb2), h('div', { class: 'ck-sub', text: `Timer ${fmt(f.tim2)} MHz` })), 'out');
    }

    // Bağlantı çizgileri
    const on = (cond) => (cond ? 'ck-wire on' : 'ck-wire');
    const pll = c.sysclkSource === 'PLL';
    const paths = [
      [c.pllSource === 'HSI' && pll, 'M140,92 H165 V185 H190'],
      [c.pllSource === 'HSE' && pll, 'M140,262 H165 V205 H190'],
      [c.sysclkSource === 'HSI', 'M140,85 H160 V40 H680 V82 H700'],
      [c.sysclkSource === 'HSE', 'M140,275 H170 V330 H690 V100 H700'],
      [pll, 'M300,190 H340'],
      [pll, 'M424,190 H450'],
      // PLL çıkışı: mul modelinde çarpandan doğrudan, diğerlerinde /P ya da /R üzerinden
      ...(model === 'mul' ? [[pll, 'M550,190 H680 V118 H700']] : [[pll, 'M550,190 H565 V140 H580'], [pll, 'M664,140 H680 V118 H700']]),
      ...(aux ? [[true, 'M550,190 H565 V260 H580'], [true, 'M664,260 H700']] : []),
      [true, 'M820,100 H850'],
      [true, 'M905,130 V170'],
      [true, 'M960,200 H990'],
      [true, 'M1045,230 V245 H905 V270'],
      [true, 'M960,300 H990'],
      ...(twoApb ? [[true, 'M905,330 V345 H835 V400 H850'], [true, 'M960,400 H990']] : [])
    ];
    const wires = s('svg', { class: 'ck-wires', width: W, height: H, viewBox: `0 0 ${W} ${H}` }, ...paths.map(([cond, d]) => s('path', { class: on(cond), d })));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.replaceChildren(wires, ...nodes);

    $('clk-summary').textContent = twoApb
      ? t('SYSCLK {0} MHz · HCLK {1} · APB1 {2} · APB2 {3} MHz · Flash {4} bekleme durumu', fmt(f.sysclk), fmt(f.hclk), fmt(f.pclk1), fmt(f.pclk2), ck.latency)
      : t('SYSCLK {0} MHz · HCLK {1} · APB {2} MHz · Flash {3} bekleme durumu', fmt(f.sysclk), fmt(f.hclk), fmt(f.pclk1), ck.latency);
    $('clk-issues').replaceChildren(...(ck.issues.length
      ? ck.issues.map((i) => h('div', { class: `note ${i.level === 'error' ? 'error' : 'warn'}` }, h('span', { class: 'ic', text: i.level === 'error' ? '✕' : '!' }), h('span', { text: i.text })))
      : [h('div', { class: 'note info' }, h('span', { class: 'ic', text: '✓' }), h('span', { text: t('Saat ağacı geçerli. Değişiklikler "Kod Üret" ile SystemClock / clock_init koduna yansır.') }))]));
    renderPeripherals();
  }

  function renderPeripherals() {
    const rows = (state.clock.periphs || []).map((r) => {
      let detail = '';
      if (r.type === 'uart') detail = t('{0} baud, BRR {1}, hata %{2}', r.baud, r.brr, r.errPct.toFixed(2));
      else if (r.type === 'i2c') detail = `${r.speedKHz} kHz${r.mhz < 4 && r.speedKHz > 100 ? ' ' + t('(PCLK1 çok düşük!)') : ''}`;
      else if (r.type === 'spi') detail = `/${r.div} → ${fmt(r.outMHz)} MHz`;
      else if (r.type === 'pwm') detail = t('PSC {0} → {1} MHz sayaç, {2} Hz', r.psc, fmt(r.tickMHz), r.hz);
      else if (r.type === 'adc') detail = `ADCCLK ${fmt(r.outMHz)} MHz (/${r.div})`;
      return h('tr', {}, h('td', { text: r.name }), h('td', { text: r.source }), h('td', { class: 'num', text: `${fmt(r.mhz)} MHz` }), h('td', { text: detail }));
    });
    $('clk-periphs').replaceChildren(rows.length
      ? h('table', { class: 'grid-table' }, h('tr', {}, ...[t('Çevre birimi'), 'Bus', t('Saat'), t('Ayar')].map((x) => h('th', { text: x }))), ...rows)
      : h('div', { class: 'hint', text: t('Henüz çevre birimi kullanan komponent yok.') }));
  }

  ES.tabs.clock = { mount, render, onShow: render };
})();
