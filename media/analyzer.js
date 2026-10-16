/* Bellek raporu / Build Analyzer sekmesi (ES-210): bölge kullanımı, semboller, dosyalar, bölümler,
 * önceki derlemeye göre değişim ve yığın kullanımı tahmini. Veriyi eklenti hesaplar (src/analyzer.js). */
(function () {
  const { t, h, $, post, state, hex } = ES;
  const A = { data: null, config: '', view: 'symbols', q: '', kind: 'all', region: '', limit: 200, roots: true, sort: 'size', busy: false };
  const BUILD_TYPES = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];

  function mount(parent) {
    parent.append(h('main', { id: 'analyzer', class: 'tab-pane' },
      h('div', { class: 'an-bar' },
        h('select', { id: 'an-config', 'aria-label': t('Derleme tipi'), onchange: (e) => { A.config = e.target.value; run(); } }),
        h('button', { class: 'small', id: 'an-run', onclick: run }, t('Analiz et')),
        h('button', { class: 'ghost small', id: 'an-build', onclick: () => post({ type: 'build' }) }, t('Derle')),
        h('span', { class: 'hint', id: 'an-info' })),
      h('div', { class: 'an-body' },
        h('div', { id: 'an-msg', class: 'dbg-msg', hidden: true }),
        h('div', { id: 'an-regions', class: 'an-regions' }),
        h('div', { class: 'an-tabs', role: 'tablist', id: 'an-tabs' }),
        h('div', { id: 'an-ctl', class: 'an-ctl' }),
        h('div', { id: 'an-view', class: 'an-view' }))));
  }

  function run() {
    A.busy = true;
    render();
    post({ type: 'analyzer.run', config: A.config || undefined });
  }

  ES.on('analyzer.data', (m) => {
    A.busy = false;
    A.data = m;
    if (m.config) A.config = m.config;
    A.limit = 200;
    render();
  });
  // Derleme bitince (boyut özeti gelir) rapor açılmışsa yenilenir
  ES.on('build.size', (m) => { if (A.data && (!A.config || m.config === A.config)) run(); });

  const B = (n) => (Math.abs(n) >= 10240 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
  const signed = (n) => (n > 0 ? `+${B(n)}` : n < 0 ? `−${B(-n)}` : '0');
  const VIEWS = () => [['symbols', t('Semboller')], ['files', t('Dosyalar')], ['sections', t('Bölümler')], ['diff', t('Değişim')], ['stack', t('Yığın')]];
  const KIND = () => ({ func: t('fonksiyon'), data: t('değişken'), rodata: t('sabit veri'), code: t('kod'), bss: 'bss' });

  function render() {
    const root = $('analyzer');
    if (!root) return;
    const sel = $('an-config');
    const cur = A.config || (state.design && state.design.build && state.design.build.type) || 'Debug';
    sel.replaceChildren(...BUILD_TYPES.map((x) => h('option', { value: x, selected: x === cur, text: x })));
    $('an-run').disabled = A.busy;
    const d = A.data;
    const msg = $('an-msg');
    msg.hidden = !(d && d.error) && !A.busy;
    msg.className = `dbg-msg${d && d.error ? ' error' : ''}`;
    msg.textContent = A.busy ? t('Analiz ediliyor…') : d && d.error ? d.error : '';
    $('an-info').textContent = d && !d.error ? `${d.elf} · ${new Date(d.builtAt).toLocaleString()}${d.map ? '' : ' · ' + t('.map yok: bölgeler işlemci tanımından')}` : '';
    $('an-tabs').replaceChildren(...VIEWS().map(([id, label]) => h('button', {
      class: `con-tab${A.view === id ? ' active' : ''}`, role: 'tab', id: `an-tab-${id}`, 'aria-selected': String(A.view === id),
      onclick: () => { A.view = id; A.limit = 200; renderCtl(); renderView(); renderTabs(); }
    }, label)));
    renderRegions();
    renderCtl();
    renderView();
  }
  function renderTabs() {
    for (const b of document.querySelectorAll('#an-tabs .con-tab')) {
      const on = b.id === `an-tab-${A.view}`;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', String(on));
    }
  }

  function renderRegions() {
    const box = $('an-regions');
    const d = A.data;
    if (!d || d.error) {
      put(box, h('div', { class: 'hint pad', text: d ? '' : t('Derlenmiş ELF ve .map dosyasından bölge bazında Flash/RAM kullanımı, en büyük semboller ve dosyalar, önceki derlemeye göre değişim ve fonksiyon başına yığın kullanımı. "Analiz et" ile başlayın.') }));
      return;
    }
    const diff = d.diff ? Object.fromEntries(d.diff.regions.map((r) => [r.name, r.delta])) : {};
    put(box, ...d.regions.map((r) => {
      const pct = r.length ? (100 * r.used) / r.length : 0;
      let x = 0;
      const segs = r.parts.map((p, i) => {
        const w = r.length ? (100 * p.size) / r.length : 0;
        const el = h('span', { class: `seg c${i % 6}${p.load ? ' load' : ''}`, style: `left:${x.toFixed(2)}%;width:${w.toFixed(2)}%`, title: `${p.name}${p.load ? ' ' + t('(ilk değerler)') : ''}: ${B(p.size)}` });
        x += w;
        return el;
      });
      const dl = diff[r.name];
      return h('div', { class: `an-region${pct > 90 ? ' hot' : ''}`, 'data-region': r.name },
        h('div', { class: 'an-rhead' },
          h('strong', { text: r.name }), h('span', { class: 'hint mono', text: `${hex(r.origin)} · ${B(r.length)}` }),
          h('span', { class: 'spacer' }),
          h('span', { class: 'mono', text: `${B(r.used)} (${pct.toFixed(1)}%)` }),
          dl ? h('span', { class: `delta mono ${dl > 0 ? 'up' : 'down'}`, title: t('Önceki derlemeye göre'), text: signed(dl) }) : null,
          h('span', { class: 'hint mono', text: t('{0} boş', B(Math.max(0, r.length - r.used))) })),
        h('div', { class: 'an-rbar' }, ...segs),
        h('div', { class: 'an-legend' }, ...r.parts.slice(0, 6).map((p, i) => h('span', {}, h('i', { class: `c${i % 6}${p.load ? ' load' : ''}` }), `${p.name}${p.load ? '*' : ''} ${B(p.size)}`))));
    }));
  }

  function renderCtl() {
    const box = $('an-ctl');
    const d = A.data;
    if (!d || d.error) { put(box, ); return; }
    const search = h('input', { type: 'text', id: 'an-q', placeholder: t('Ara…'), value: A.q, 'aria-label': t('Ara…'), oninput: (e) => { A.q = e.target.value; A.limit = 200; renderView(); } });
    const parts = [h('div', { class: 'search' }, search)];
    if (A.view === 'symbols') {
      parts.push(h('select', { class: 'tiny', id: 'an-kind', 'aria-label': t('Tür'), onchange: (e) => { A.kind = e.target.value; renderView(); } },
        ...[['all', t('Tümü')], ['func', t('Fonksiyonlar')], ['data', t('Değişkenler')], ['rodata', t('Sabit veri')]].map(([v, l]) => h('option', { value: v, selected: A.kind === v, text: l }))),
      h('select', { class: 'tiny', id: 'an-region', 'aria-label': t('Bölge'), onchange: (e) => { A.region = e.target.value; renderView(); } },
        h('option', { value: '', text: t('Tüm bölgeler') }), ...d.regions.map((r) => h('option', { value: r.name, selected: A.region === r.name, text: r.name }))));
    }
    if (A.view === 'stack' && d.stack) {
      parts.push(h('label', { class: 'check', title: t('Kod içinde çağrılmayan fonksiyonlar: görevler, kesme işleyicileri, main') },
        h('input', { type: 'checkbox', id: 'an-roots', checked: A.roots, onchange: (e) => { A.roots = e.target.checked; renderView(); } }), h('span', { text: t('Yalnızca giriş noktaları') })));
    }
    put(box, ...parts);
  }

  /** replaceChildren null'ı "null" metni yapar: boş parçalar atılır */
  const put = (box, ...parts) => box.replaceChildren(...parts.filter((x) => x !== null && x !== undefined && x !== false));
  const match = (s) => !A.q || String(s).toLowerCase().includes(A.q.toLowerCase());
  const more = (n, shown) => (n > shown ? h('button', { class: 'ghost small an-more', onclick: () => { A.limit += 500; renderView(); } }, t('{0} satır daha göster', Math.min(500, n - shown))) : null);
  const srcBtn = (label, msg) => h('a', { href: '#', class: 'src-link', title: t('Kaynağa git'), onclick: (e) => { e.preventDefault(); post({ type: 'analyzer.source', config: A.config, ...msg }); } }, label);

  function renderView() {
    const box = $('an-view');
    const d = A.data;
    if (!box) return;
    if (!d || d.error) { put(box, ); return; }
    const K = KIND();
    const deltas = d.diff ? new Map(d.diff.symbols.map((x) => [`${x.kind === 'func' ? 'f' : 'd'}:${x.name}`, x.delta])) : new Map();
    if (A.view === 'symbols') {
      const rows = d.symbols.filter((s) => (A.kind === 'all' || s.kind === A.kind) && (!A.region || s.region === A.region) && match(s.name));
      const total = rows.reduce((a, s) => a + s.size, 0);
      put(box, 
        h('div', { class: 'hint pad', text: t('{0} sembol, toplam {1}. Ada tıklayınca kaynağa gidilir.', rows.length, B(total)) }),
        h('table', { class: 'regs an-table', id: 'an-symbols' },
          h('tr', {}, ...[t('Ad'), t('Boyut'), 'Δ', t('Tür'), t('Bölüm'), t('Adres')].map((x) => h('th', { text: x }))),
          ...rows.slice(0, A.limit).map((s) => {
            const dl = deltas.get(`${s.kind === 'func' ? 'f' : 'd'}:${s.name}`);
            return h('tr', {},
              h('td', { class: 'mono' }, srcBtn(s.name, { name: s.name, addr: s.addr, kind: s.kind }), s.local ? h('span', { class: 'hint', text: ' static' }) : null),
              h('td', { class: 'mono val', text: B(s.size) }),
              h('td', { class: `mono delta ${dl > 0 ? 'up' : dl < 0 ? 'down' : ''}`, text: dl ? signed(dl) : '' }),
              h('td', { class: 'hint', text: K[s.kind] }), h('td', { class: 'mono hint', text: s.section }), h('td', { class: 'mono hint', text: hex(s.addr) }));
          })),
        more(rows.length, A.limit));
    } else if (A.view === 'files') {
      const rows = d.files.filter((f) => match(f.name));
      put(box, 
        d.map ? null : h('div', { class: 'hint pad', text: t('Dosya katkıları için .map dosyası gerekir (-Wl,-Map).') }),
        h('table', { class: 'regs an-table', id: 'an-files' },
          h('tr', {}, ...[t('Dosya / kütüphane'), 'Flash', 'RAM', ''].map((x) => h('th', { text: x }))),
          ...rows.slice(0, A.limit).map((f) => h('tr', {},
            h('td', { class: 'mono', text: f.name }), h('td', { class: 'mono val', text: B(f.flash) }), h('td', { class: 'mono val', text: B(f.ram) }),
            h('td', { class: 'hint', text: f.lib ? t('kütüphane, {0} nesne', f.members) : '' })))),
        more(rows.length, A.limit));
    } else if (A.view === 'sections') {
      put(box, h('table', { class: 'regs an-table', id: 'an-sections' },
        h('tr', {}, ...[t('Bölüm'), t('Boyut'), t('Bölge'), t('Adres'), t('Yükleme adresi'), t('Tür')].map((x) => h('th', { text: x }))),
        ...d.sections.filter((s) => match(s.name)).map((s) => h('tr', {},
          h('td', { class: 'mono', text: s.name }), h('td', { class: 'mono val', text: B(s.size) }), h('td', { text: s.region }),
          h('td', { class: 'mono hint', text: hex(s.addr) }), h('td', { class: 'mono hint', text: s.loadRegion ? `${hex(s.lma)} (${s.loadRegion})` : '' }),
          h('td', { class: 'hint', text: K[s.kind] || s.kind })))));
    } else if (A.view === 'diff') {
      if (!d.diff) { put(box, h('div', { class: 'hint pad', id: 'an-nodiff', text: t('Karşılaştırılacak önceki derleme yok. Kodu değiştirip yeniden derleyince burada hangi fonksiyonun büyüdüğü görünür.') })); return; }
      const rows = d.diff.symbols.filter((x) => match(x.name));
      const ST = { new: t('yeni'), removed: t('silindi'), changed: '' };
      put(box, 
        h('div', { class: 'hint pad', text: t('{0} tarihli derlemeye göre. {1} sembol değişti.', new Date(d.diff.since).toLocaleString(), d.diff.symbols.length) }),
        h('div', { class: 'an-diffsum' }, ...d.diff.regions.map((r) => h('span', { class: 'mono' }, `${r.name}: ${B(r.before)} → ${B(r.after)} `, h('b', { class: `delta ${r.delta > 0 ? 'up' : r.delta < 0 ? 'down' : ''}`, text: signed(r.delta) })))),
        rows.length ? h('table', { class: 'regs an-table', id: 'an-diff' },
          h('tr', {}, ...[t('Ad'), t('Önce'), t('Sonra'), 'Δ', ''].map((x) => h('th', { text: x }))),
          ...rows.slice(0, A.limit).map((x) => h('tr', {},
            h('td', { class: 'mono', text: x.name }), h('td', { class: 'mono hint', text: x.before ? B(x.before) : '—' }), h('td', { class: 'mono', text: x.after ? B(x.after) : '—' }),
            h('td', { class: `mono delta ${x.delta > 0 ? 'up' : 'down'}`, text: signed(x.delta) }), h('td', { class: 'hint', text: `${K[x.kind] || ''} ${ST[x.status]}`.trim() })))) : h('div', { class: 'hint pad', text: t('Sembol boyutlarında değişiklik yok.') }),
        more(rows.length, A.limit));
    } else if (A.view === 'stack') {
      const s = d.stack;
      if (!s) {
        put(box, h('div', { class: 'hint pad', id: 'an-nostack', text: d.stackUsage
          ? t('Yığın verisi yok: projeyi yeniden derleyin (.su / .ci dosyaları derleme klasöründe oluşur).')
          : t('Yığın kullanımı analizi kapalı. Ayarlar > Derleme > "Yığın kullanımı analizi" açıp yeniden derleyin.') }));
        return;
      }
      const rows = s.functions.filter((f) => (!A.roots || f.root || !s.graph) && match(f.name));
      put(box, 
        h('div', { class: 'hint pad', text: s.graph
          ? t('En kötü durum = fonksiyonun kendi çerçevesi + en derin çağrı zinciri (-fcallgraph-info). Kesmeler ve RTOS bağlam kaydı dahil değildir; özyineleme, dolaylı ve kütüphane çağrıları işaretlenir (gerçek değer daha büyük olabilir).')
          : t('Yalnızca fonksiyonların kendi çerçeveleri (-fstack-usage). Çağrı zinciri için GCC ile derleyin (-fcallgraph-info).') }),
        h('table', { class: 'regs an-table', id: 'an-stack' },
          h('tr', {}, ...[t('Fonksiyon'), t('Kendi'), t('En kötü'), t('En derin zincir'), t('Uyarılar')].map((x) => h('th', { text: x }))),
          ...rows.slice(0, A.limit).map((f) => {
            const warn = [f.recursive && t('özyineleme'), f.indirect && t('dolaylı çağrı'), f.dynamic && t('değişken boyutlu (alloca/VLA)'),
              f.unknown.length && t('{0} kütüphane çağrısı', f.unknown.length)].filter(Boolean);
            return h('tr', { class: warn.length > (f.unknown.length ? 1 : 0) ? 'warnrow' : '' },
              h('td', { class: 'mono' }, f.file && f.line ? srcBtn(f.name, { file: f.file, line: f.line, name: f.name }) : f.name),
              h('td', { class: 'mono', text: `${f.own}` }),
              h('td', { class: 'mono val', text: `${f.worst}${f.recursive || f.indirect || f.unknown.length || f.dynamic ? '+' : ''}` }),
              h('td', { class: 'mono hint an-path', title: f.path.join(' → '), text: f.path.slice(1).join(' → ') }),
              h('td', { class: 'hint', title: f.unknown.join(', '), text: warn.join(', ') }));
          })),
        more(rows.length, A.limit));
    }
  }

  ES.tabs.analyzer = {
    mount,
    render,
    onShow() { if (!A.data && !A.busy && state.project && state.project.root) run(); else render(); }
  };
})();
