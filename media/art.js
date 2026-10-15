/* Komponent görselleri: üzerine gelince açılan kartta gösterilir.
 * comp.image varsa o kullanılır; yoksa comp.art bilgisinden basit bir modül çizimi üretilir. */
(function () {
  const { s, h } = ES;
  const W = 220, H = 130;

  function header(pins, y, x0, x1) {
    const g = s('g');
    const n = pins.length;
    const step = Math.min(18, (x1 - x0) / Math.max(n, 1));
    const start = (x0 + x1) / 2 - (step * (n - 1)) / 2;
    pins.forEach((p, i) => {
      const x = start + i * step;
      g.append(
        s('rect', { x: x - 4, y: y - 4, width: 8, height: 8, rx: 1, fill: '#1a1a1a' }),
        s('circle', { cx: x, cy: y, r: 2.4, fill: '#d4a72c' }),
        s('text', { x, y: y - 8, 'font-size': 6.5, 'text-anchor': 'middle', fill: '#f0f0f0', 'font-family': 'monospace', text: p.name }));
    });
    return g;
  }

  function chip(shape, label, cx, cy) {
    const g = s('g');
    if (shape === 'oled') {
      g.append(
        s('rect', { x: cx - 70, y: cy - 34, width: 140, height: 62, rx: 3, fill: '#0b0f1a', stroke: '#2a3a5a' }),
        s('rect', { x: cx - 62, y: cy - 27, width: 124, height: 48, fill: '#05070d' }),
        s('text', { x: cx - 56, y: cy - 12, 'font-size': 9, fill: '#7fd3ff', 'font-family': 'monospace', text: 'Embedded' }),
        s('text', { x: cx - 56, y: cy + 2, 'font-size': 9, fill: '#7fd3ff', 'font-family': 'monospace', text: 'Studio  24.3C' }),
        s('rect', { x: cx - 56, y: cy + 8, width: 60, height: 5, fill: '#7fd3ff', opacity: 0.8 }));
      return g;
    }
    if (shape === 'metal-lid') {
      g.append(
        s('rect', { x: cx - 16, y: cy - 16, width: 32, height: 32, rx: 2, fill: '#c9ced6', stroke: '#8a9099' }),
        s('circle', { cx: cx + 9, cy: cy - 9, r: 2, fill: '#5d636b' }),
        s('text', { x: cx, y: cy + 4, 'font-size': 6.5, 'text-anchor': 'middle', fill: '#333', 'font-family': 'monospace', text: label }));
      return g;
    }
    const wide = shape === 'soic';
    const w = wide ? 40 : 26, hh = wide ? 22 : 26;
    for (let i = 0; i < 4; i++) {
      const o = -hh / 2 + 4 + (i * (hh - 8)) / 3;
      if (wide) {
        g.append(s('rect', { x: cx - w / 2 + 4 + i * ((w - 12) / 3), y: cy - hh / 2 - 4, width: 3, height: 4, fill: '#bbb' }));
        g.append(s('rect', { x: cx - w / 2 + 4 + i * ((w - 12) / 3), y: cy + hh / 2, width: 3, height: 4, fill: '#bbb' }));
      } else {
        g.append(s('rect', { x: cx - w / 2 - 3, y: cy + o - 1, width: 3, height: 2, fill: '#bbb' }));
        g.append(s('rect', { x: cx + w / 2, y: cy + o - 1, width: 3, height: 2, fill: '#bbb' }));
      }
    }
    g.append(
      s('rect', { x: cx - w / 2, y: cy - hh / 2, width: w, height: hh, rx: 2, fill: '#1c1c1c' }),
      s('circle', { cx: cx - w / 2 + 4, cy: cy - hh / 2 + 4, r: 1.3, fill: '#555' }),
      s('text', { x: cx, y: cy + 3, 'font-size': 6, 'text-anchor': 'middle', fill: '#ddd', 'font-family': 'monospace', text: label }));
    return g;
  }

  function moduleBoard(comp, art) {
    const color = art.board || '#1d4f91';
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': comp.name });
    const pins = comp.pins || [];
    const bw = Math.max(110, Math.min(200, pins.length * 20 + 40));
    const x0 = (W - bw) / 2;
    svg.append(
      s('rect', { x: x0, y: 8, width: bw, height: H - 16, rx: 6, fill: color }),
      s('rect', { x: x0 + 3, y: 11, width: bw - 6, height: H - 22, rx: 4, fill: 'none', stroke: 'rgba(255,255,255,.12)' }),
      s('circle', { cx: x0 + 9, cy: 16, r: 3.2, fill: '#0d0d0d', stroke: '#d4a72c', 'stroke-width': 1.2 }),
      s('circle', { cx: x0 + bw - 9, cy: 16, r: 3.2, fill: '#0d0d0d', stroke: '#d4a72c', 'stroke-width': 1.2 }));
    if (art.antenna) {
      svg.append(s('rect', { x: W / 2 - 26, y: 18, width: 52, height: 40, rx: 3, fill: '#e8dcc0', stroke: '#b8a77e' }), s('rect', { x: W / 2 - 18, y: 26, width: 36, height: 24, fill: '#d6c497' }));
      svg.append(chip('metal-lid', art.chip, W / 2 + 50, 50));
    } else if (art.usb) {
      svg.append(s('rect', { x: x0 - 6, y: 34, width: 26, height: 30, rx: 2, fill: '#c9ced6', stroke: '#8a9099' }));
      svg.append(chip('soic', art.chip, W / 2 + 10, 50));
    } else {
      svg.append(chip(art.chipShape, art.chip ?? comp.name, W / 2, art.chipShape === 'oled' ? 50 : 52));
    }
    svg.append(header(pins, H - 20, x0 + 10, x0 + bw - 10));
    return svg;
  }

  function special(comp, art) {
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': comp.name });
    const cx = W / 2;
    if (art.shape === 'led') {
      svg.append(
        s('line', { x1: cx - 8, y1: 70, x2: cx - 8, y2: 122, stroke: '#bbb', 'stroke-width': 2.5 }),
        s('line', { x1: cx + 8, y1: 70, x2: cx + 8, y2: 112, stroke: '#bbb', 'stroke-width': 2.5 }),
        s('rect', { x: cx - 20, y: 62, width: 40, height: 8, rx: 2, fill: art.color, opacity: 0.85 }),
        s('path', { d: `M${cx - 16},64 V34 a16,16 0 0 1 32,0 V64 Z`, fill: art.color, opacity: 0.9 }),
        s('ellipse', { cx: cx - 6, cy: 34, rx: 4, ry: 10, fill: '#fff', opacity: 0.35 }),
        s('text', { x: cx + 14, y: 120, 'font-size': 8, fill: 'currentColor', text: 'A (+)' }),
        s('text', { x: cx - 44, y: 120, 'font-size': 8, fill: 'currentColor', text: 'K (−)' }));
    } else if (art.shape === 'button') {
      svg.append(
        s('rect', { x: cx - 32, y: 30, width: 64, height: 64, rx: 4, fill: '#2a2a2a', stroke: '#555' }),
        s('circle', { cx, cy: 62, r: 20, fill: '#111', stroke: '#444', 'stroke-width': 3 }),
        ...[[-32, 38], [32, 38], [-32, 86], [32, 86]].map(([dx, y]) => s('rect', { x: cx + dx - 6 + (dx > 0 ? 6 : 0), y: y - 2, width: 6, height: 4, fill: '#bbb' })));
    } else if (art.shape === 'pot') {
      svg.append(
        s('rect', { x: cx - 36, y: 50, width: 72, height: 44, rx: 4, fill: '#2b5ea8' }),
        s('circle', { cx, cy: 50, r: 26, fill: '#c9ced6', stroke: '#8a9099', 'stroke-width': 2 }),
        s('line', { x1: cx, y1: 50, x2: cx + 14, y2: 30, stroke: '#333', 'stroke-width': 3, 'stroke-linecap': 'round' }),
        ...[-18, 0, 18].map((dx) => s('rect', { x: cx + dx - 2, y: 94, width: 4, height: 26, fill: '#bbb' })));
    } else if (art.shape === 'servo') {
      svg.append(
        s('rect', { x: cx - 60, y: 46, width: 120, height: 52, rx: 4, fill: '#2b6cb0' }),
        s('rect', { x: cx - 76, y: 56, width: 152, height: 8, rx: 2, fill: '#2b6cb0' }),
        s('circle', { cx: cx - 30, cy: 46, r: 14, fill: '#2b6cb0' }),
        s('circle', { cx: cx - 30, cy: 40, r: 6, fill: '#f0f0f0' }),
        s('path', { d: `M${cx - 30},34 L${cx + 10},28 a5,5 0 0 1 0,10 L${cx - 30},46 Z`, fill: '#f0f0f0' }),
        s('text', { x: cx + 18, y: 80, 'font-size': 11, 'font-weight': 700, fill: '#fff', text: 'SG90' }),
        s('path', { d: `M${cx + 60},80 C${cx + 80},80 ${cx + 80},110 ${cx + 96},110`, fill: 'none', stroke: '#e0a030', 'stroke-width': 3 }));
    }
    return svg;
  }

  /** Komponent görseli (img ya da üretilmiş SVG). */
  ES.art = function (comp) {
    if (comp.image && /^(https?:|data:|vscode-|file:)/.test(comp.image)) {
      return h('img', { src: comp.image, alt: comp.name, class: 'art-img' });
    }
    const art = comp.art || { board: '#3b4252', chip: comp.name.slice(0, 8), chipShape: 'qfn' };
    return art.shape ? special(comp, art) : moduleBoard(comp, art);
  };
})();
