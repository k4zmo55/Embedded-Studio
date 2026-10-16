/* Konsol panelinde FreeRTOS sekmesi (ES-209): görevler (durum, öncelik, yığın, tepe değeri, CPU %), kuyruk/semafor/mutex,
 * zamanlayıcılar, heap ve uyarılar; görevin call stack'i (kayıtlı bağlam + yığın taraması). */
(function () {
  const { t, h, $, post, hex, modal } = ES;
  const R = { data: null, live: false, timer: 0, busy: false, stack: null, dlg: null, body: null };
  const D = () => ES.dbg || {};
  const TC = () => ES.traceConsole;
  const STATE = () => ({ running: t('Çalışıyor'), ready: t('Hazır'), blocked: t('Bekliyor'), suspended: t('Askıda'), deleted: t('Silindi') });
  const QTYPE = () => ({ queue: t('kuyruk'), mutex: 'mutex', recursive: t('özyinelemeli mutex'), counting: t('sayan semafor'), binary: t('ikili semafor'), set: t('kuyruk kümesi') });

  function refresh() {
    if (!D().connected) return;
    R.busy = true;
    post({ type: 'debug.rtos' });
    setTimeout(() => { R.busy = false; }, 4000);
  }
  function schedule() {
    clearInterval(R.timer);
    if (R.live && D().connected) R.timer = setInterval(() => { if (TC()?.visible === 'rtos' && !R.busy) refresh(); }, 1000);
  }

  ES.on('debug.rtosData', (m) => {
    R.busy = false;
    R.data = m;
    TC()?.refreshCtl('rtos');
    TC()?.refresh('rtos');
  });
  ES.on('debug.status', (m) => {
    if (!m.connected) { R.data = null; R.live = false; schedule(); }
    // Bağlanınca bir kez okunur (sekme açıksa)
    else if (!R.data && TC()?.visible === 'rtos') refresh();
  });
  ES.on('debug.rtosStack', (m) => {
    R.stack = m;
    if (!R.dlg) {
      R.body = h('div', { class: 'rtos-stack' });
      R.dlg = modal({ title: t('Görev call stack\'i'), width: 680, body: R.body, buttons: [{ label: t('Kapat'), primary: true }], onClose: () => { R.dlg = null; } });
    }
    renderStack();
  });

  const signed = (n) => (n >= 0 ? `+${n}` : String(n));
  const bytes = (n) => (n >= 10240 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

  function ctl() {
    const conn = !!D().connected, d = R.data;
    const sum = d && !d.error ? [
      d.running ? t('Zamanlayıcı çalışıyor') : t('Zamanlayıcı başlamadı'),
      `tick ${d.tick}`, t('{0} görev', d.tasks.length),
      d.heap && d.heap.total ? t('heap {0} / {1} boş (en az {2})', bytes(d.heap.free), bytes(d.heap.total), bytes(d.heap.minEver)) : ''
    ].filter(Boolean).join(' · ') : '';
    return [
      h('button', { class: 'small', id: 'rtos-refresh', disabled: !conn, onclick: refresh }, t('Yenile')),
      h('label', { class: 'check', title: t('Hedef durdurulmadan saniyede bir okunur; çalışırken listeler okuma sırasında değişebilir.') },
        h('input', { type: 'checkbox', id: 'rtos-live', checked: R.live, disabled: !conn, onchange: (e) => { R.live = e.target.checked; schedule(); if (R.live) refresh(); } }), h('span', { text: t('Canlı (1 sn)') })),
      h('span', { class: 'hint', id: 'rtos-sum', text: sum }),
      d && d.cfgSource ? h('span', { class: 'hint', title: t('TCB yerleşimi bu dosyadaki ayarlardan hesaplandı'), text: `· ${d.cfgSource}` }) : null
    ].filter(Boolean);
  }

  function msg() {
    const d = R.data;
    if (!D().connected) return { level: '', text: t('FreeRTOS görevlerini görmek için hedefe bağlanın.') };
    if (!d) return { level: '', text: t('Görev listesini okumak için "Yenile".') };
    if (d.error) return { level: 'error', text: d.error };
    const w = d.warnings || [];
    if (w.length) return { level: w.some((x) => x.level === 'error') ? 'error' : 'warn', text: w.map((x) => x.text).join('  ·  ') };
    return null;
  }

  function stackCell(x) {
    if (!x.stackSize) return h('span', { class: 'hint', title: t('Yığın boyutu bilinmiyor: configRECORD_STACK_HIGH_ADDRESS 1 yapın.'), text: x.freeMin !== null ? t('en az {0} B boş', x.freeMin) : '?' });
    const peak = x.freeMin !== null ? x.stackSize - x.freeMin : x.used;
    const pct = (v) => Math.min(100, Math.max(0, (100 * v) / x.stackSize));
    const level = x.overflow ? 'bad' : x.freeMin !== null && x.freeMin < Math.max(64, x.stackSize * 0.1) ? 'warn' : '';
    return h('span', { class: `stk ${level}`, title: t('Şu an {0} B kullanılıyor; en kötü durumda {1} B (tepe). Toplam {2} B.', x.used ?? '?', peak ?? '?', x.stackSize) },
      h('span', { class: 'stk-bar' }, h('span', { class: 'stk-peak', style: `width:${pct(peak || 0).toFixed(1)}%` }), h('span', { class: 'stk-now', style: `width:${pct(x.used || 0).toFixed(1)}%` })),
      h('span', { class: 'mono', text: `${peak ?? '?'}/${x.stackSize}` }));
  }

  function view(box) {
    const d = R.data;
    if (!d || d.error) {
      box.replaceChildren(h('div', { class: 'hint pad', text: t('Görev listesi, kuyruklar, zamanlayıcılar ve heap ELF\'teki çekirdek sembolleri ve FreeRTOSConfig.h ile doğrudan bellekten okunur. VS Code debug oturumunda (Cortex-Debug, rtos) görev başına call stack CALL STACK görünümündedir.') }));
      return;
    }
    const S = STATE(), QT = QTYPE();
    const warnTask = new Set((d.warnings || []).filter((w) => w.task).map((w) => w.task));
    const halted = d.state === 'halted';
    const tasks = h('table', { class: 'regs rtos', id: 'rtos-tasks' },
      h('tr', {}, ...[t('Görev'), t('Durum'), t('Öncelik'), t('Yığın (tepe/toplam B)'), 'CPU %', t('Bekliyor'), 'TCB', ''].map((x) => h('th', { text: x }))),
      ...d.tasks.map((x) => h('tr', { class: `${x.state}${warnTask.has(x.name) ? ' warnrow' : ''}` },
        h('td', { class: 'mono', text: x.name }),
        h('td', {}, h('span', { class: `st st-${x.state}`, text: S[x.state] || x.state })),
        h('td', { class: 'mono', text: x.basePriority !== undefined && x.basePriority !== x.priority ? `${x.priority} ↑${x.basePriority}` : String(x.priority), title: x.basePriority !== x.priority ? t('Öncelik kalıtımı: taban öncelik {0}', x.basePriority) : '' }),
        h('td', {}, stackCell(x)),
        h('td', { class: 'mono val', text: x.cpu !== undefined ? x.cpu.toFixed(1) : '—', title: x.cpu === undefined ? t('configGENERATE_RUN_TIME_STATS kapalı') : t('Son iki okuma arasındaki pay') }),
        h('td', { class: 'hint', text: x.waiting ? (x.waiting.dir === 'recv' ? t('alma: {0}', x.waiting.name) : x.waiting.dir === 'send' ? t('gönderme: {0}', x.waiting.name) : t('olay / bildirim')) : x.mutexesHeld ? t('{0} mutex tutuyor', x.mutexesHeld) : '' }),
        h('td', { class: 'mono hint', text: hex(x.tcb) }),
        h('td', {}, h('button', {
          class: 'ghost small rtos-cs', 'data-task': x.name, disabled: x.state === 'running' && !halted || x.state === 'deleted',
          title: x.state === 'running' && !halted ? t('Çalışan görev için hedefi durdurun.') : t('Kayıtlı bağlam ve olası çağrı zinciri'),
          onclick: () => post({ type: 'debug.rtosStack', tcb: x.tcb })
        }, 'Call stack')))));
    const parts = [tasks];
    parts.push(h('div', { class: 'rtos-sec', text: t('Kuyruklar, semaforlar, mutexler') }));
    parts.push(d.queues.length ? h('table', { class: 'regs rtos', id: 'rtos-queues' },
      h('tr', {}, ...[t('Ad'), t('Tür'), t('Doluluk'), t('Bekleyenler'), t('Sahibi')].map((x) => h('th', { text: x }))),
      ...d.queues.map((q) => {
        const sem = q.itemSize === 0;
        const fill = q.type === 'mutex' || q.type === 'recursive' ? (q.waiting ? t('serbest') : t('alınmış')) : sem ? `${q.waiting}/${q.length}` : `${q.waiting}/${q.length} × ${q.itemSize} B`;
        const waiters = [...q.receiversNames.map((n) => `${n} ←`), ...q.sendersNames.map((n) => `${n} →`)].join(', ');
        return h('tr', {},
          h('td', { class: 'mono', text: q.name || hex(q.handle) }), h('td', { text: QT[q.type] || q.type }),
          h('td', { class: 'mono', text: fill }), h('td', { class: 'hint', text: waiters }),
          h('td', { class: 'mono', text: q.holderName ? q.holderName + (q.recursive ? ` ×${q.recursive}` : '') : '' }));
      }))
      : h('div', { class: 'hint pad', text: t('Kayıtlı kuyruk yok. Görmek için configQUEUE_REGISTRY_SIZE > 0 yapın ve vQueueAddToRegistry(handle, "ad") çağırın.') }));
    parts.push(h('div', { class: 'rtos-sec', text: t('Zamanlayıcılar') }));
    parts.push(d.timers.length ? h('table', { class: 'regs rtos', id: 'rtos-timers' },
      h('tr', {}, ...[t('Ad'), t('Periyot'), t('Tür'), t('Sonraki (tick)'), t('Geri çağrı')].map((x) => h('th', { text: x }))),
      ...d.timers.map((x) => h('tr', {},
        h('td', { class: 'mono', text: x.name }), h('td', { class: 'mono', text: `${x.period} tick` }),
        h('td', { text: x.autoReload ? t('otomatik yenilenen') : t('tek seferlik') }),
        h('td', { class: 'mono', text: `${x.expiry}${d.tick !== undefined ? ` (${signed((x.expiry - d.tick) | 0)})` : ''}` }),
        h('td', { class: 'mono', text: x.callbackName || hex(x.callback) }))))
      : h('div', { class: 'hint pad', text: t('Etkin zamanlayıcı yok (configUSE_TIMERS kapalı ya da hepsi durmuş).') }));
    box.replaceChildren(...parts);
  }

  function renderStack() {
    const box = R.body, m = R.stack;
    if (!box || !m) return;
    if (m.error) { box.replaceChildren(h('div', { class: 'dbg-msg error', text: m.error })); return; }
    const src = (f) => f.source && f.source.line
      ? h('a', { href: '#', class: 'src-link', title: f.source.file, onclick: (e) => { e.preventDefault(); post({ type: 'debug.source', file: f.source.file, line: f.source.line }); } }, `${f.source.file.replace(/\\/g, '/').split('/').slice(-2).join('/')}:${f.source.line}`)
      : null;
    const KIND = { pc: 'PC', lr: 'LR', stack: t('yığın') };
    const regs = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xpsr', 'xPSR', 'exc'].filter((n) => m.regs[n] !== undefined);
    box.replaceChildren(...[
      h('div', { class: 'fault-ctx' }, h('span', { class: 'badge', text: m.task }),
        h('span', { class: 'hint', text: m.live ? t('Çalışan görev: çekirdek register\'ları') : t('Kayıtlı bağlam ({0})', m.fpu ? 'FPU' : t('FPU\'suz')) })),
      h('h4', { text: t('Olası çağrı zinciri') }),
      h('table', { class: 'regs', id: 'rtos-frames' }, ...m.frames.map((f, i) => h('tr', {},
        h('td', { class: 'mono hint', text: `#${i}` }), h('td', { class: 'mono', text: f.func || '?' }),
        h('td', { class: 'mono val', text: hex(f.pc) }), h('td', {}, src(f)), h('td', { class: 'hint', text: KIND[f.kind] })))),
      h('div', { class: 'hint', text: t('PC ve LR kayıtlı bağlamdan; sonraki satırlar yığında bir çağrı komutundan sonrasını gösteren adreslerdir (derleyici çerçeve bilgisi kullanılmaz, eski çağrılar da görünebilir). Kesin call stack için VS Code debug oturumunu kullanın.') }),
      !m.elf ? h('div', { class: 'hint', text: t('ELF yok: çağrı komutu denetlenmedi, kaynak satırı gösterilemiyor.') }) : null,
      h('h4', { text: t('Register\'lar') }),
      h('div', { class: 'fault-regs mono' }, ...regs.map((n) => h('span', {}, h('b', { text: n === 'exc' ? 'EXC_RETURN' : n.toUpperCase() }), ' ', hex(m.regs[n]))))
    ].filter(Boolean));
  }

  /** Düz metin (Kaydet) */
  function save() {
    const d = R.data;
    if (!d || d.error) return '';
    const S = STATE();
    const L = [`tick ${d.tick} · ${d.tasks.length} task`];
    for (const x of d.tasks) L.push([x.name.padEnd(16), (S[x.state] || x.state).padEnd(10), `prio ${x.priority}`, `stack ${x.stackSize ? `${x.stackSize - (x.freeMin ?? 0)}/${x.stackSize}` : '?'} B`, x.cpu !== undefined ? `${x.cpu.toFixed(1)}%` : ''].join('  '));
    for (const q of d.queues) L.push(`${q.name || hex(q.handle)}  ${q.type}  ${q.waiting}/${q.length}${q.holderName ? '  holder ' + q.holderName : ''}`);
    for (const x of d.timers) L.push(`timer ${x.name}  ${x.period} tick  ${x.autoReload ? 'auto' : 'once'}  ${x.callbackName || ''}`);
    if (d.heap) L.push(`heap free ${d.heap.free} / ${d.heap.total}, min ${d.heap.minEver}`);
    for (const w of d.warnings || []) L.push(`! ${w.text}`);
    return L.join('\n');
  }

  ES.consoleTabs = ES.consoleTabs || {};
  ES.consoleTabs.rtos = {
    label: 'FreeRTOS', ctl, view, msg, save,
    running: () => R.live && !!D().connected,
    clear() { R.data = null; },
    onShow() { if (!R.data && D().connected) refresh(); }
  };
})();
