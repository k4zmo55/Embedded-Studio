/* Clock sekmesi: CubeMX "Clock Configuration" benzeri saat ağacı düzenleyici. */
(function () {
  const { t, h, s, $, post, state, update, icon } = ES;

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

  function render() {
    const canvas = $('clock-canvas');
    if (!canvas || !state.clock) return;
    const ck = state.clock, c = ck.config, f = ck.freq;
    const mcu = state.lib.mcus[state.design.mcuId];
    const def = mcu.clock;
    const bad = new Set(ck.issues.filter((i) => i.level === 'error').map((i) => i.field));
    const warnF = new Set(ck.issues.filter((i) => i.level === 'warn').map((i) => i.field));
    const L = def.limits;

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
    const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

    // Kaynaklar
    box(20, 70, 120, 'HSI RC', freq(f.hsi), 'src');
    box(20, 240, 120, t('HSE kristal'), h('div', { class: 'ck-row' }, numInput('hseMHz', def.hseRange[0], def.hseRange[1], c.hseMHz, 0.5), h('small', { text: 'MHz' })), `src${bad.has('hse') ? ' bad' : ''}`);
    // PLL
    box(190, 150, 110, t('PLL kaynağı'), radio('pllSource', [['HSI', 'HSI'], ['HSE', 'HSE']], c.pllSource), 'mux');
    box(340, 160, 84, '/ M', select('M', range(def.pllM[0], def.pllM[1]), c.M));
    box(450, 160, 100, '× N', numInput('N', def.pllN[0], def.pllN[1], c.N));
    box(580, 110, 84, '/ P', select('P', def.pllP, c.P));
    box(580, 230, 84, '/ Q', select('Q', range(def.pllQ[0], def.pllQ[1]), c.Q));
    box(700, 230, 110, t('48 MHz çıkış'), freq(f.pll48, 'Q'), 'out small');
    nodes.push(h('div', { class: 'ck-label', style: 'left:428px;top:224px', text: t('VCO giriş {0} MHz', fmt(f.pllIn)) }));
    nodes.push(h('div', { class: 'ck-label', style: 'left:556px;top:224px', text: '' }));
    nodes.push(h('div', { class: `ck-label${bad.has('N') ? ' bad' : ''}`, style: 'left:450px;top:136px', text: `VCO ${fmt(f.vco)} MHz` }));
    nodes.push(h('div', { class: 'ck-pll-frame', style: 'left:320px;top:96px;width:362px;height:206px' }, h('span', { text: 'Ana PLL' })));
    // Sistem saati
    box(700, 60, 120, t('Sistem saati'), radio('sysclkSource', [['HSI', 'HSI'], ['HSE', 'HSE'], ['PLL', 'PLLCLK']], c.sysclkSource), 'mux');
    box(850, 70, 110, 'SYSCLK', freq(f.sysclk, 'sysclk', L.sysclk), 'out');
    box(850, 170, 110, 'AHB /', select('ahb', def.ahb, c.ahb));
    box(990, 170, 110, 'HCLK', freq(f.hclk, 'hclk', L.hclk), 'out');
    box(850, 270, 110, 'APB1 /', select('apb1', def.apb, c.apb1));
    box(990, 260, 110, 'PCLK1', h('div', {}, freq(f.pclk1, 'apb1', L.apb1), h('div', { class: 'ck-sub', text: `Timer ${fmt(f.tim1)} MHz` })), 'out');
    box(850, 370, 110, 'APB2 /', select('apb2', def.apb, c.apb2));
    box(990, 360, 110, 'PCLK2', h('div', {}, freq(f.pclk2, 'apb2', L.apb2), h('div', { class: 'ck-sub', text: `Timer ${fmt(f.tim2)} MHz` })), 'out');

    // Bağlantı çizgileri
    const on = (cond) => (cond ? 'ck-wire on' : 'ck-wire');
    const pll = c.sysclkSource === 'PLL';
    const wires = s('svg', { class: 'ck-wires', width: W, height: H, viewBox: `0 0 ${W} ${H}` },
      s('path', { class: on(c.pllSource === 'HSI' && pll), d: 'M140,92 H165 V185 H190' }),
      s('path', { class: on(c.pllSource === 'HSE' && pll), d: 'M140,262 H165 V205 H190' }),
      s('path', { class: on(c.sysclkSource === 'HSI'), d: 'M140,85 H160 V40 H680 V82 H700' }),
      s('path', { class: on(c.sysclkSource === 'HSE'), d: 'M140,275 H170 V330 H690 V100 H700' }),
      s('path', { class: on(pll), d: 'M300,190 H340' }),
      s('path', { class: on(pll), d: 'M424,190 H450' }),
      s('path', { class: on(pll), d: 'M550,190 H565 V140 H580' }),
      s('path', { class: on(true), d: 'M550,190 H565 V260 H580' }),
      s('path', { class: on(true), d: 'M664,260 H700' }),
      s('path', { class: on(pll), d: 'M664,140 H680 V118 H700' }),
      s('path', { class: on(true), d: 'M820,100 H850' }),
      s('path', { class: on(true), d: 'M905,130 V170' }),
      s('path', { class: on(true), d: 'M960,200 H990' }),
      s('path', { class: on(true), d: 'M1045,230 V245 H905 V270' }),
      s('path', { class: on(true), d: 'M960,300 H990' }),
      s('path', { class: on(true), d: 'M905,330 V345 H835 V400 H850' }),
      s('path', { class: on(true), d: 'M960,400 H990' }));
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    canvas.replaceChildren(wires, ...nodes);

    $('clk-summary').textContent = t('SYSCLK {0} MHz · HCLK {1} · APB1 {2} · APB2 {3} MHz · Flash {4} bekleme durumu', fmt(f.sysclk), fmt(f.hclk), fmt(f.pclk1), fmt(f.pclk2), ck.latency);
    $('clk-issues').replaceChildren(...(ck.issues.length
      ? ck.issues.map((i) => h('div', { class: `note ${i.level === 'error' ? 'error' : 'warn'}` }, h('span', { class: 'ic', text: i.level === 'error' ? '✕' : '!' }), h('span', { text: i.text })))
      : [h('div', { class: 'note info' }, h('span', { class: 'ic', text: '✓' }), h('span', { text: t('Saat ağacı geçerli. Değişiklikler "Kod Üret" ile SystemClock / clock_init koduna yansır.') }))]));
    renderPeripherals();
  }

  function renderPeripherals() {
    const f = state.clock.freq;
    const mcu = state.lib.mcus[state.design.mcuId];
    const rows = Object.entries(state.result.peripherals).map(([name, p]) => {
      const apb2 = mcu.peripherals[name].bus === 'APB2';
      const pclk = apb2 ? f.pclk2 : f.pclk1;
      const tim = apb2 ? f.tim2 : f.tim1;
      let detail = '';
      if (p.type === 'uart') {
        const brr = Math.round((pclk * 1e6) / p.baud);
        const real = (pclk * 1e6) / brr;
        const err = ((real - p.baud) / p.baud) * 100;
        detail = t('{0} baud, BRR {1}, hata %{2}', p.baud, brr, err.toFixed(2));
      } else if (p.type === 'i2c') detail = `${p.speedHz / 1000} kHz${pclk < 4 && p.speedHz > 100000 ? ' ' + t('(PCLK1 çok düşük!)') : ''}`;
      else if (p.type === 'spi') {
        let div = 2;
        while (div < 256 && (pclk * 1e6) / div > Math.min(p.speedHz, 10e6)) div *= 2;
        detail = `/${div} → ${fmt(pclk / div)} MHz`;
      } else if (p.type === 'pwm') {
        const psc = Math.max(0, Math.round(tim) - 1);
        detail = t('PSC {0} → {1} MHz sayaç, {2} Hz', psc, fmt(tim / (psc + 1)), p.frequencyHz);
      } else if (p.type === 'adc') {
        const div = [2, 4, 6, 8].find((d) => f.pclk2 / d <= 36) || 8;
        detail = `ADCCLK ${fmt(f.pclk2 / div)} MHz (/${div})`;
      }
      return h('tr', {}, h('td', { text: name }), h('td', { text: p.type === 'pwm' ? `${apb2 ? 'APB2' : 'APB1'} timer` : apb2 ? 'APB2' : 'APB1' }),
        h('td', { class: 'num', text: `${fmt(p.type === 'pwm' ? tim : pclk)} MHz` }), h('td', { text: detail }));
    });
    $('clk-periphs').replaceChildren(rows.length
      ? h('table', { class: 'grid-table' }, h('tr', {}, ...[t('Çevre birimi'), 'Bus', t('Saat'), t('Ayar')].map((x) => h('th', { text: x }))), ...rows)
      : h('div', { class: 'hint', text: t('Henüz çevre birimi kullanan komponent yok.') }));
  }

  ES.tabs.clock = { mount, render, onShow: render };
})();
