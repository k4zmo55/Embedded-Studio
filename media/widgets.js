/* Monitör widget'ları. Her widget: create(cfg, ctx) -> { el, update() }.
 * cfg: { type, channels: ['BME280_1.temp', ...], min, max, style }
 * ctx: { series(ch) -> [{t, v}], last(ch), unit(ch), short(ch), post } */
(function () {
  const { h, s } = ES;
  const AXIS = ['#e5484d', '#30a46c', '#3e63dd']; // X kırmızı, Y yeşil, Z mavi
  const css = (name, fb) => getComputedStyle(document.body).getPropertyValue(name).trim() || fb;
  const palette = () => [1, 2, 3, 4, 5, 6].map((i) => css(`--s${i}`, AXIS[(i - 1) % 3]));
  /** Ölçek etiketi: aralığa göre gereksiz ondalık yok. */
  const tick = (v, span) => (span >= 20 ? v.toFixed(0) : span >= 2 ? v.toFixed(1) : v.toFixed(2));
  const fmt = (v) => {
    if (v === undefined || Number.isNaN(v)) return '—';
    const a = Math.abs(v);
    return a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : a >= 10 ? v.toFixed(2) : v.toFixed(3);
  };

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, hh = canvas.clientHeight;
    if (!w || !hh) return null;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(hh * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(hh * dpr);
    }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, hh);
    return { g, w, h: hh };
  }

  // ------------------------------------------------------------ çizgi grafik
  function chart(cfg, ctx) {
    const canvas = h('canvas', { class: 'w-chart' });
    const legend = h('div', { class: 'w-legend' });
    const el = h('div', { class: 'w-col' }, canvas, legend);
    const WINDOW = 30000;
    return {
      el,
      update() {
        const cols = palette();
        legend.replaceChildren(...cfg.channels.map((ch, i) => h('span', {}, h('i', { style: `background:${cols[i % cols.length]}` }), `${ctx.short(ch)} `, h('b', { text: `${fmt(ctx.last(ch))}${ctx.unit(ch) ? ' ' + ctx.unit(ch) : ''}` }))));
        const c = setupCanvas(canvas);
        if (!c) return;
        const { g, w, h: hh } = c;
        const now = Date.now();
        const all = cfg.channels.map((ch) => ctx.series(ch).filter((d) => now - d.t < WINDOW));
        let lo = Infinity, hi = -Infinity;
        for (const ser of all) for (const d of ser) { lo = Math.min(lo, d.v); hi = Math.max(hi, d.v); }
        if (!Number.isFinite(lo)) return;
        if (hi - lo < 1e-6) { hi += 0.5; lo -= 0.5; }
        const pad = (hi - lo) * 0.12;
        lo -= pad; hi += pad;
        const X = (t) => ((t - (now - WINDOW)) / WINDOW) * (w - 40) + 36;
        const Y = (v) => hh - 14 - ((v - lo) / (hi - lo)) * (hh - 22);
        // ızgara + eksen etiketleri
        g.strokeStyle = css('--grid', 'rgba(128,128,128,.18)');
        g.fillStyle = css('--muted-c', '#888');
        g.font = '10px sans-serif';
        g.lineWidth = 1;
        for (let i = 0; i <= 3; i++) {
          const v = lo + ((hi - lo) * i) / 3, y = Y(v);
          g.beginPath(); g.moveTo(36, y); g.lineTo(w - 4, y); g.stroke();
          g.fillText(fmt(v), 2, y + 3);
        }
        g.fillText('-30 sn', 36, hh - 2);
        g.fillText('şimdi', w - 30, hh - 2);
        all.forEach((ser, i) => {
          if (ser.length < 2) return;
          g.beginPath();
          ser.forEach((d, k) => (k ? g.lineTo(X(d.t), Y(d.v)) : g.moveTo(X(d.t), Y(d.v))));
          g.strokeStyle = cols[i % cols.length];
          g.lineWidth = 1.6;
          g.lineJoin = 'round';
          g.stroke();
        });
      }
    };
  }

  // ------------------------------------------------------------ sayısal değer
  function value(cfg, ctx) {
    const el = h('div', { class: 'w-values' });
    return {
      el,
      update() {
        el.replaceChildren(...cfg.channels.map((ch) => h('div', { class: 'w-value' },
          h('span', { class: 'w-value-n', text: fmt(ctx.last(ch)) }, h('small', { text: ctx.unit(ch) ? ' ' + ctx.unit(ch) : '' })),
          h('span', { class: 'w-value-l', text: ctx.short(ch) }))));
      }
    };
  }

  // ------------------------------------------------------------ gösterge (kadran)
  function gauge(cfg, ctx) {
    const ch = cfg.channels[0];
    const dial = cfg.style === 'dial';
    const min = cfg.min ?? 0, max = cfg.max ?? 100;
    const A0 = dial ? 180 : 150, SW = dial ? 180 : 240; // başlangıç açısı ve tarama
    const R = 62, CX = 90, CY = dial ? 82 : 80;
    const pt = (deg, r) => [CX + r * Math.cos((deg * Math.PI) / 180), CY + r * Math.sin((deg * Math.PI) / 180)];
    const arc = (a1, a2, r) => {
      const [x1, y1] = pt(a1, r), [x2, y2] = pt(a2, r);
      return `M${x1},${y1} A${r},${r} 0 ${a2 - a1 > 180 ? 1 : 0} 1 ${x2},${y2}`;
    };
    const fill = s('path', { class: 'g-fill', fill: 'none', 'stroke-width': 10, 'stroke-linecap': 'round' });
    const needle = s('line', { class: 'g-needle', x1: CX, y1: CY, 'stroke-width': 2.5, 'stroke-linecap': 'round' });
    const val = s('text', { class: 'g-val', x: CX, y: CY + 26, 'text-anchor': 'middle' });
    const ticks = s('g');
    for (let i = 0; i <= 4; i++) {
      const a = A0 + (SW * i) / 4;
      const [x1, y1] = pt(a, R + 7), [x2, y2] = pt(a, R + 12), [tx, ty] = pt(a, R + 22);
      ticks.append(s('line', { class: 'g-tick', x1, y1, x2, y2 }), s('text', { class: 'g-lbl', x: tx, y: ty + 3, 'text-anchor': 'middle', text: tick(min + ((max - min) * i) / 4, max - min) }));
    }
    const svg = s('svg', { viewBox: `-24 0 228 ${dial ? 118 : 130}`, class: 'w-gauge' },
      s('path', { class: 'g-track', d: arc(A0, A0 + SW, R), fill: 'none', 'stroke-width': 10, 'stroke-linecap': 'round' }),
      fill, ticks, needle, s('circle', { class: 'g-hub', cx: CX, cy: CY, r: 5 }), val);
    return {
      el: h('div', { class: 'w-center' }, svg),
      update() {
        const v = ctx.last(ch);
        const k = v === undefined ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)));
        const a = A0 + SW * k;
        fill.setAttribute('d', k > 0.002 ? arc(A0, a, R) : '');
        const [nx, ny] = pt(a, R - 14);
        needle.setAttribute('x2', nx);
        needle.setAttribute('y2', ny);
        val.textContent = `${fmt(v)}${ctx.unit(ch) ? ' ' + ctx.unit(ch) : ''}`;
      }
    };
  }

  // ------------------------------------------------------------ termometre
  function thermo(cfg, ctx) {
    const ch = cfg.channels[0];
    const min = cfg.min ?? -10, max = cfg.max ?? 50;
    const TOP = 14, BOT = 112, X = 34;
    const level = s('rect', { class: 't-fill', x: X - 5, width: 10, rx: 5 });
    const val = s('text', { class: 'g-val', x: 145, y: 64, 'text-anchor': 'middle' });
    const ticks = s('g');
    for (let i = 0; i <= 6; i++) {
      const y = BOT - ((BOT - TOP) * i) / 6;
      ticks.append(s('line', { class: 'g-tick', x1: X + 10, y1: y, x2: X + 16, y2: y }), s('text', { class: 'g-lbl', x: X + 20, y: y + 3, text: tick(min + ((max - min) * i) / 6, max - min) }));
    }
    const minmax = s('text', { class: 'g-lbl', x: 145, y: 84, 'text-anchor': 'middle' });
    const svg = s('svg', { viewBox: '0 0 200 140', class: 'w-gauge' },
      s('rect', { class: 'g-track-fill', x: X - 8, y: TOP - 6, width: 16, height: BOT - TOP + 14, rx: 8 }),
      s('circle', { class: 'g-track-fill', cx: X, cy: BOT + 12, r: 14 }),
      level, s('circle', { class: 't-fill', cx: X, cy: BOT + 12, r: 10 }), ticks, val, minmax);
    let lo = Infinity, hi = -Infinity;
    return {
      el: h('div', { class: 'w-center' }, svg),
      update() {
        const v = ctx.last(ch);
        if (v === undefined) return;
        lo = Math.min(lo, v); hi = Math.max(hi, v);
        const k = Math.max(0, Math.min(1, (v - min) / (max - min)));
        const y = BOT - (BOT - TOP) * k;
        level.setAttribute('y', y);
        level.setAttribute('height', BOT + 12 - y);
        val.textContent = `${v.toFixed(1)}${ctx.unit(ch) ? ' ' + ctx.unit(ch) : ''}`;
        minmax.textContent = `min ${lo.toFixed(1)} · max ${hi.toFixed(1)}`;
      }
    };
  }

  // ------------------------------------------------------------ lamba (LED / buton)
  function lamp(cfg, ctx) {
    const ch = cfg.channels[0];
    const bulb = s('circle', { class: 'l-bulb', cx: 50, cy: 46, r: 26 });
    const txt = s('text', { class: 'g-val', x: 50, y: 98, 'text-anchor': 'middle' });
    const hist = h('div', { class: 'l-hist' });
    return {
      el: h('div', { class: 'w-center w-col' }, s('svg', { viewBox: '0 0 100 106', class: 'w-gauge small' }, bulb, txt), hist),
      update() {
        const v = ctx.last(ch);
        const onState = v !== undefined && v > 0.5;
        bulb.classList.toggle('on', onState);
        txt.textContent = v === undefined ? '—' : onState ? 'AÇIK / 1' : 'KAPALI / 0';
        const ser = ctx.series(ch).slice(-40);
        hist.replaceChildren(...ser.map((d) => h('i', { class: d.v > 0.5 ? 'on' : '' })));
      }
    };
  }

  // ------------------------------------------------------------ eksen çubukları
  function axesBars(channels, ctx, range) {
    const rows = channels.map((ch, i) => {
      const bar = h('div', { class: 'ax-bar' });
      const val = h('span', { class: 'ax-val' });
      return { ch, bar, val, el: h('div', { class: 'ax-row' }, h('span', { class: 'ax-name', style: `color:${AXIS[i % 3]}`, text: ctx.short(ch) }), h('div', { class: 'ax-track' }, h('div', { class: 'ax-zero' }), bar), val), color: AXIS[i % 3] };
    });
    return {
      el: h('div', { class: 'ax' }, ...rows.map((r) => r.el)),
      update() {
        for (const r of rows) {
          const v = ctx.last(r.ch) ?? 0;
          const k = Math.max(-1, Math.min(1, v / range));
          r.bar.style.background = r.color;
          r.bar.style.left = k >= 0 ? '50%' : `${50 + k * 50}%`;
          r.bar.style.width = `${Math.abs(k) * 50}%`;
          r.val.textContent = `${fmt(v)} ${ctx.unit(r.ch)}`;
        }
      }
    };
  }

  function axes(cfg, ctx) {
    const range = cfg.max ?? (ctx.unit(cfg.channels[0]) === 'g' ? 2 : 250);
    return axesBars(cfg.channels.slice(0, 3), ctx, range);
  }

  // ------------------------------------------------------------ IMU 3B
  const AIRPLANE = (() => {
    const N = [1.25, 0, 0], A = [0.35, 0, -0.17], B = [0.35, 0.15, 0], C = [0.35, 0, 0.15], D = [0.35, -0.15, 0], T = [-1.1, 0, -0.06];
    const body = '#d9dde3', dark = '#9aa3ad';
    return [
      { p: [N, A, B], c: body }, { p: [N, B, C], c: dark }, { p: [N, C, D], c: dark }, { p: [N, D, A], c: body },
      { p: [A, B, T], c: body }, { p: [B, C, T], c: dark }, { p: [C, D, T], c: dark }, { p: [D, A, T], c: body },
      { p: [[0.5, 0, 0.02], [0.08, 1.2, 0.02], [-0.14, 1.2, 0.02], [-0.22, 0, 0.02], [-0.14, -1.2, 0.02], [0.08, -1.2, 0.02]], c: '#3e63dd' },
      { p: [[-0.78, 0, -0.03], [-1.0, 0.48, -0.03], [-1.13, 0.48, -0.03], [-1.12, 0, -0.03], [-1.13, -0.48, -0.03], [-1.0, -0.48, -0.03]], c: '#3e63dd' },
      { p: [[-0.72, 0, -0.08], [-1.05, 0, -0.55], [-1.17, 0, -0.55], [-1.12, 0, -0.08]], c: '#e5484d' }
    ];
  })();

  function rot(roll, pitch, yaw) {
    const [cr, sr, cp, sp, cy, sy] = [Math.cos(roll), Math.sin(roll), Math.cos(pitch), Math.sin(pitch), Math.cos(yaw), Math.sin(yaw)];
    // R = Rz(yaw) * Ry(pitch) * Rx(roll)  (gövde -> dünya, NED)
    return [
      [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
      [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
      [-sp, cp * sr, cp * cr]
    ];
  }
  const mul = (R, v) => [R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];

  function imu(cfg, ctx) {
    const [ax, ay, az, gx, gy, gz] = cfg.channels;
    const canvas = h('canvas', { class: 'w-imu' });
    const att = h('div', { class: 'imu-att' });
    let mode = 'plane';
    const modeBtn = h('button', { class: 'ghost small', onclick: () => { mode = mode === 'plane' ? 'axes' : 'plane'; modeBtn.textContent = mode === 'plane' ? 'Eksen görünümü' : 'Uçak görünümü'; } }, 'Eksen görünümü');
    const accel = axesBars([ax, ay, az], ctx, 2);
    const gyro = gx ? axesBars([gx, gy, gz], ctx, 250) : null;
    const o = { roll: 0, pitch: 0, yaw: 0, lastT: 0 };
    const el = h('div', { class: 'w-imu-wrap' },
      h('div', { class: 'imu-view' }, canvas, h('div', { class: 'imu-tools' }, modeBtn, h('button', { class: 'ghost small', onclick: () => (o.yaw = 0) }, 'Yaw sıfırla'))),
      h('div', { class: 'imu-side' }, att, h('div', { class: 'imu-h', text: 'İvme (g)' }), accel.el, gyro ? h('div', { class: 'imu-h', text: 'Açısal hız (°/s)' }) : null, gyro ? gyro.el : null));

    function integrate() {
      // Tamamlayıcı filtre: jiroskop kısa vadede, ivmeölçer uzun vadede.
      const sa = ctx.series(ax), sb = ctx.series(ay), sc = ctx.series(az);
      const sgx = gx ? ctx.series(gx) : [], sgy = gy ? ctx.series(gy) : [], sgz = gz ? ctx.series(gz) : [];
      const n = Math.min(sa.length, sb.length, sc.length);
      for (let i = 0; i < n; i++) {
        const t = sa[i].t;
        if (t <= o.lastT) continue;
        const dt = o.lastT ? Math.min(0.5, (t - o.lastT) / 1000) : 0;
        o.lastT = t;
        const aRoll = Math.atan2(sb[i].v, sc[i].v);
        const aPitch = Math.atan2(-sa[i].v, Math.hypot(sb[i].v, sc[i].v));
        const g = (ser) => { const d = ser.find((x) => x.t >= t); return d ? (d.v * Math.PI) / 180 : 0; };
        if (sgx.length) {
          o.roll = 0.9 * (o.roll + g(sgx) * dt) + 0.1 * aRoll;
          o.pitch = 0.9 * (o.pitch + g(sgy) * dt) + 0.1 * aPitch;
          o.yaw += g(sgz) * dt;
        } else {
          o.roll = aRoll;
          o.pitch = aPitch;
        }
      }
    }

    function draw() {
      const c = setupCanvas(canvas);
      if (!c) return;
      const { g, w, h: hh } = c;
      const scale = Math.min(w, hh) * 0.32;
      const cx = w / 2, cy = hh / 2 + 6;
      // Kamera: arkadan-yukarıdan, hafif yandan bakış
      const cam = rot(0, (-22 * Math.PI) / 180, (-35 * Math.PI) / 180);
      const camT = [[cam[0][0], cam[1][0], cam[2][0]], [cam[0][1], cam[1][1], cam[2][1]], [cam[0][2], cam[1][2], cam[2][2]]];
      const proj = (v) => {
        const p = mul(camT, v); // dünya -> kamera (x: derinlik, y: sağ, z: aşağı)
        const k = 3.2 / (3.2 + p[0]);
        return { x: cx + p[1] * scale * k, y: cy + p[2] * scale * k, d: p[0] };
      };
      // Yer düzlemi ızgarası
      g.lineWidth = 1;
      g.strokeStyle = css('--grid', 'rgba(128,128,128,.2)');
      for (let i = -2; i <= 2; i++) {
        const a = proj([i * 0.6, -1.2, 0.9]), b = proj([i * 0.6, 1.2, 0.9]);
        const c1 = proj([-1.2, i * 0.6, 0.9]), d = proj([1.2, i * 0.6, 0.9]);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.moveTo(c1.x, c1.y); g.lineTo(d.x, d.y); g.stroke();
      }
      const R = rot(o.roll, o.pitch, o.yaw);
      const light = [0.3, -0.4, -0.85];
      if (mode === 'plane') {
        const faces = AIRPLANE.map((f) => {
          const wp = f.p.map((p) => mul(R, p));
          const pp = wp.map(proj);
          const u = [wp[1][0] - wp[0][0], wp[1][1] - wp[0][1], wp[1][2] - wp[0][2]];
          const v = [wp[2][0] - wp[0][0], wp[2][1] - wp[0][1], wp[2][2] - wp[0][2]];
          const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
          const len = Math.hypot(...nrm) || 1;
          const shade = 0.55 + 0.45 * Math.abs((nrm[0] * light[0] + nrm[1] * light[1] + nrm[2] * light[2]) / len);
          return { pp, depth: pp.reduce((a, p) => a + p.d, 0) / pp.length, c: f.c, shade };
        }).sort((a, b) => b.depth - a.depth);
        for (const f of faces) {
          g.beginPath();
          f.pp.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fillStyle = f.c;
          g.globalAlpha = 1;
          g.fill();
          g.fillStyle = `rgba(0,0,0,${(1 - f.shade).toFixed(2)})`;
          g.fill();
          g.strokeStyle = 'rgba(0,0,0,.35)';
          g.stroke();
        }
      }
      // Gövde eksenleri: X kırmızı (burun), Y yeşil (sağ kanat), Z mavi (aşağı)
      const o0 = proj(mul(R, [0, 0, 0]));
      const L = mode === 'plane' ? 1.55 : 1.3;
      [[L, 0, 0], [0, L, 0], [0, 0, L]].forEach((v, i) => {
        const p = proj(mul(R, v));
        g.strokeStyle = AXIS[i];
        g.fillStyle = AXIS[i];
        g.lineWidth = mode === 'plane' ? 2 : 4;
        g.beginPath(); g.moveTo(o0.x, o0.y); g.lineTo(p.x, p.y); g.stroke();
        g.beginPath(); g.arc(p.x, p.y, mode === 'plane' ? 3 : 5, 0, Math.PI * 2); g.fill();
        g.font = 'bold 11px sans-serif';
        g.fillText(['X', 'Y', 'Z'][i], p.x + 6, p.y - 4);
      });
    }

    return {
      el,
      update() {
        integrate();
        draw();
        accel.update();
        gyro && gyro.update();
        const d = (r) => ((r * 180) / Math.PI).toFixed(1).padStart(6, ' ');
        att.replaceChildren(
          h('div', {}, h('span', { text: 'Roll' }), h('b', { text: `${d(o.roll)}°` })),
          h('div', {}, h('span', { text: 'Pitch' }), h('b', { text: `${d(o.pitch)}°` })),
          h('div', {}, h('span', { text: 'Yaw' }), h('b', { text: `${d(o.yaw)}°` })));
      }
    };
  }

  // ------------------------------------------------------------ GPS
  function gps(cfg, ctx) {
    const [lat, lon, alt, sats] = cfg.channels;
    const canvas = h('canvas', { class: 'w-gps' });
    const info = h('div', { class: 'gps-info' });
    const btn = h('button', {
      class: 'ghost small',
      onclick: () => {
        const a = ctx.last(lat), b = ctx.last(lon);
        if (a !== undefined) ctx.post({ type: 'openExternal', url: `https://www.openstreetmap.org/?mlat=${a.toFixed(6)}&mlon=${b.toFixed(6)}#map=17/${a.toFixed(6)}/${b.toFixed(6)}` });
      }
    }, 'Haritada aç');
    return {
      el: h('div', { class: 'w-col' }, canvas, h('div', { class: 'gps-foot' }, info, btn)),
      update() {
        const a = ctx.series(lat), b = ctx.series(lon);
        const n = Math.min(a.length, b.length);
        const la = ctx.last(lat), lo = ctx.last(lon);
        info.replaceChildren(...[
          h('span', {}, 'Enlem ', h('b', { text: la !== undefined ? la.toFixed(6) + '°' : '—' })),
          h('span', {}, 'Boylam ', h('b', { text: lo !== undefined ? lo.toFixed(6) + '°' : '—' })),
          alt ? h('span', {}, 'İrtifa ', h('b', { text: `${fmt(ctx.last(alt))} m` })) : null,
          sats ? h('span', {}, 'Uydu ', h('b', { text: String(ctx.last(sats) ?? '—') })) : null].filter(Boolean));
        const c = setupCanvas(canvas);
        if (!c || n < 1) return;
        const { g, w, h: hh } = c;
        // Yerel metre koordinatları (eşit ölçek)
        const lat0 = a[n - 1].v, lon0 = b[n - 1].v;
        const mx = (v) => (v - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180);
        const my = (v) => (v - lat0) * 110540;
        let ext = 20;
        for (let i = 0; i < n; i++) ext = Math.max(ext, Math.abs(mx(b[i].v)), Math.abs(my(a[i].v)));
        const k = (Math.min(w, hh) / 2 - 14) / ext;
        const P = (i) => [w / 2 + mx(b[i].v) * k, hh / 2 - my(a[i].v) * k];
        // ızgara + ölçek
        g.strokeStyle = css('--grid', 'rgba(128,128,128,.2)');
        g.lineWidth = 1;
        const step = Math.pow(10, Math.floor(Math.log10(ext)));
        // ızgara tuvalin tamamını kaplasın (en/boy farklı olabilir)
        const spanX = w / 2 / k, spanY = hh / 2 / k;
        for (let m = -Math.ceil(spanX / step) * step; m <= spanX; m += step) { g.beginPath(); g.moveTo(w / 2 + m * k, 0); g.lineTo(w / 2 + m * k, hh); g.stroke(); }
        for (let m = -Math.ceil(spanY / step) * step; m <= spanY; m += step) { g.beginPath(); g.moveTo(0, hh / 2 + m * k); g.lineTo(w, hh / 2 + m * k); g.stroke(); }
        g.fillStyle = css('--muted-c', '#888');
        g.font = '10px sans-serif';
        g.fillText(`ızgara ${step} m`, 6, hh - 6);
        g.fillText('K ↑', w - 26, 14);
        g.strokeStyle = css('--info', '#3e63dd');
        g.lineWidth = 2;
        g.beginPath();
        for (let i = 0; i < n; i++) { const [x, y] = P(i); i ? g.lineTo(x, y) : g.moveTo(x, y); }
        g.stroke();
        const [x, y] = P(n - 1);
        g.fillStyle = '#e5484d';
        g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill();
        g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.stroke();
      }
    };
  }

  ES.widgets = {
    types: {
      chart: { label: 'Çizgi grafik', create: chart, ok: () => true },
      value: { label: 'Sayısal', create: value, ok: () => true },
      gauge: { label: 'Gösterge', create: gauge, ok: (n) => n === 1 },
      thermo: { label: 'Termometre', create: thermo, ok: (n) => n === 1 },
      lamp: { label: 'Lamba', create: lamp, ok: (n) => n === 1 },
      axes: { label: 'Eksen çubukları (XYZ)', create: axes, ok: (n) => n >= 3 },
      imu: { label: '3B IMU (uçak)', create: imu, ok: (n, ids) => ['ax', 'ay', 'az'].every((x) => ids.includes(x)) },
      gps: { label: 'GPS rota', create: gps, ok: (n, ids) => ids.includes('lat') && ids.includes('lon') }
    },
    fmt
  };
})();
