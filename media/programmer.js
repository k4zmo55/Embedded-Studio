/* Programlayıcı sekmesi (ES-301, ES-302): bağlan / kes, flash ve RAM okuma, dosya yazma, dosyayla karşılaştırma,
 * sektör silme, option byte'lar ve işlem günlüğü. SWD/JTAG bağlantısı Debug sekmesiyle ortaktır (aynı prob, aynı OpenOCD);
 * UART'ta yongadaki sistem bootloader'ı (AN3155), USB DFU'da dfu-util ya da STM32CubeProgrammer. */
(function () {
  const { t, h, $, post, hex } = ES;
  const P = {
    connected: false, connecting: false, mode: '', state: '', error: '', transport: 'swd',
    dbg: false, boot: null, port: '', baud: '115200', entry: 'manual', bootInfo: null, dfu: null,
    wErase: true, wVerify: true, wRun: true,
    info: null, sel: new Set(), last: null, log: [], progress: null, compare: null,
    region: 'flash', addr: '0x08000000', length: '0x1000', format: 'bin', base: '0x08000000'
  };
  const TRANSPORTS = () => [['swd', 'SWD'], ['jtag', 'JTAG'], ['uart', t('UART (sistem bootloader)')], ['dfu', 'USB DFU'], ['esboot', t('UART (Embedded Studio bootloader)')]];

  function mount(parent) {
    parent.append(h('main', { id: 'programmer', class: 'tab-pane' },
      h('div', { class: 'dbg-bar', id: 'pg-bar' }),
      h('div', { id: 'pg-msg', class: 'dbg-msg', hidden: true }),
      h('div', { class: 'pg-body' },
        h('div', { class: 'pg-col' },
          h('section', { class: 'pg-card', id: 'pg-write' }),
          h('section', { class: 'pg-card', id: 'pg-read' }),
          h('section', { class: 'pg-card', id: 'pg-compare' }),
          h('section', { class: 'pg-card', id: 'pg-ob' })),
        h('div', { class: 'pg-col' },
          h('section', { class: 'pg-card', id: 'pg-boot', hidden: true }),
          h('section', { class: 'pg-card pg-sectors', id: 'pg-sectors' }),
          h('section', { class: 'pg-card', id: 'pg-log' })))));
  }

  // replaceChildren null'ı "null" metni olarak yazar
  const put = (el, ...kids) => el.replaceChildren(...kids.filter(Boolean));
  const busy = () => P.connecting || (P.progress && P.progress.pct !== null);
  const num = (s) => Number(String(s).trim());

  const BAUDS = ['115200', '57600', '38400', '19200', '9600'];
  const isUart = () => P.transport === 'uart' || P.transport === 'esboot';
  const isEs = () => P.transport === 'esboot';
  const isDfu = () => P.transport === 'dfu';
  /** Bağlantı durumu: Debug ile ortak prob bağlantısı ya da bootloader */
  function sync() {
    P.connected = P.dbg || !!(P.boot && P.boot.connected);
    if (!P.connected) { P.info = null; P.sel.clear(); P.progress = null; }
  }

  function renderBar() {
    const bootOn = !!(P.boot && P.boot.connected);
    const ports = (P.bootInfo && P.bootInfo.ports) || [];
    const state = bootOn
      ? `${P.boot.device} · ${P.boot.kind === 'esboot' ? 'Embedded Studio bootloader' : t('bootloader')} v${P.boot.version} · ${P.boot.port}`
      : P.connected ? `${P.info ? P.info.mcu + ' · ' : ''}${P.mode === 'sim' ? t('simülasyon') : 'OpenOCD'} · ${P.state || ''}` : t('bağlı değil');
    put($('pg-bar'),
      h('label', { class: 'hint', for: 'pg-transport', text: t('Bağlantı') }),
      h('select', { id: 'pg-transport', disabled: P.connected || P.connecting, onchange: (e) => { P.transport = e.target.value; P.error = ''; P.compare = null; if (isUart() || isDfu()) post({ type: 'prog.bootInfo' }); render(); } },
        ...TRANSPORTS().map(([v, l]) => h('option', { value: v, selected: v === P.transport, text: l }))),
      isUart() && !P.connected ? h('select', { id: 'pg-port', 'aria-label': t('Port'), onchange: (e) => (P.port = e.target.value) },
        ...(ports.length ? ports : [{ path: '', name: t('port yok') }]).map((x) => h('option', { value: x.path, selected: x.path === P.port, text: x.path === 'SIM' ? t('Simülasyon (bootloader)') : x.name && x.name !== x.path ? `${x.path} · ${x.name}` : x.path }))) : null,
      isUart() && !P.connected ? h('button', { class: 'ghost small icon-only', id: 'pg-ports', title: t('Portları yenile'), onclick: () => post({ type: 'prog.bootInfo' }) }, '↻') : null,
      isUart() && !P.connected ? h('select', { id: 'pg-baud', 'aria-label': 'Baud', onchange: (e) => (P.baud = e.target.value) }, ...BAUDS.map((b) => h('option', { value: b, selected: b === P.baud, text: b }))) : null,
      isUart() && !P.connected && !isEs() ? h('select', { id: 'pg-entry', 'aria-label': t('Bootloader\'a giriş'), title: t('DTR/RTS: dönüştürücünün RTS hattı BOOT0\'a, DTR hattı NRST\'ye bağlıysa bootloader\'a kendiliğinden girilir'), onchange: (e) => (P.entry = e.target.value) },
        h('option', { value: 'manual', selected: P.entry === 'manual', text: t('BOOT0 elle') }), h('option', { value: 'dtr-rts', selected: P.entry === 'dtr-rts', text: t('DTR → NRST, RTS → BOOT0') })) : null,
      isEs() && !P.connected ? h('select', { id: 'pg-entry', 'aria-label': t('Bootloader\'a giriş'), onchange: (e) => (P.esEntry = e.target.value) },
        h('option', { value: 'manual', selected: P.esEntry !== 'dtr', text: t('Kartı elle resetle') }), h('option', { value: 'dtr', selected: P.esEntry === 'dtr', text: t('DTR → NRST ile reset') })) : null,
      isDfu() ? null : P.connected
        ? h('button', { class: 'small', id: 'pg-disconnect', onclick: () => post({ type: bootOn ? 'prog.bootDisconnect' : 'debug.disconnect' }) }, t('Bağlantıyı kes'))
        : h('button', { class: 'small', id: 'pg-connect', disabled: P.connecting || (isUart() && !P.port), onclick: () => connect('openocd') }, P.connecting ? t('Bağlanıyor…') : t('Bağlan')),
      P.connected || isDfu() || isUart() ? null : h('button', { class: 'ghost small', id: 'pg-sim', disabled: P.connecting, title: t('Kart yokken: işlemci verisinden flash haritası ve örnek içerik'), onclick: () => connect('sim') }, t('Simülasyon')),
      isDfu() ? null : h('button', { class: 'ghost small', id: 'pg-refresh', disabled: !P.connected || busy(), onclick: () => post({ type: 'prog.info' }) }, t('Yenile')),
      isDfu() ? null : h('button', { class: 'ghost small', id: 'pg-reset', disabled: !P.connected || busy(), title: bootOn ? t('GO: uygulamayı 0x08000000\'dan çalıştırır, bootloader bağlantısı kapanır') : '', onclick: () => post({ type: 'prog.reset' }) }, t('Reset ve çalıştır')),
      h('span', { class: 'spacer' }),
      h('span', { class: `pg-state${P.connected ? ' on' : ''}`, id: 'pg-state', text: isDfu() ? 'USB DFU' : state }));
    const msg = $('pg-msg');
    const warn = bootOn && !P.boot.match ? t('Bağlanan işlemci ({0}) projedekiyle aynı görünmüyor; sektör haritası projedeki işlemciye göre.', P.boot.device) : '';
    const text = P.error || warn || P.note;
    msg.hidden = !text;
    msg.className = `dbg-msg${P.error ? ' error' : ''}`;
    msg.textContent = text || '';
  }

  function connect(mode) {
    P.connecting = true;
    P.error = '';
    P.note = '';
    P.compare = null;
    renderBar();
    if (isEs()) post({ type: 'prog.connect', transport: 'esboot', port: P.port, baud: Number(P.baud), entry: P.esEntry || 'manual' });
    else if (isUart()) post({ type: 'prog.connect', transport: 'uart', port: P.port, baud: Number(P.baud), entry: P.entry });
    else post({ type: 'prog.connect', mode, transport: P.transport });
  }

  /** Dosya yaz: bütün bağlantılarda (DFU'da araçla) */
  function renderWrite() {
    const off = (isDfu() ? !dfuTool() : !P.connected) || busy() || (isEs() && !(P.boot && P.boot.kind === 'esboot'));
    const check = (id, key, label, title) => h('label', { class: 'check', title: title || '' }, h('input', { type: 'checkbox', id, checked: P[key], onchange: (e) => (P[key] = e.target.checked) }), h('span', { text: label }));
    put($('pg-write'),
      h('h3', { text: t('Dosya yaz') }),
      h('div', { class: 'pg-row' },
        isDfu() || isEs() ? null : check('pg-w-erase', 'wErase', t('Gerekli sektörleri sil'), P.mode === 'openocd' && !P.boot ? t('OpenOCD program komutu gereken sektörleri kendisi siler') : ''),
        isDfu() || isEs() ? null : check('pg-w-verify', 'wVerify', t('Doğrula')),
        isEs() ? h('span', { class: 'hint', text: t('Bootloader yazarken her paketi CRC ile denetler, sonda imajı doğrular ve commit yazar.') }) : null,
        check('pg-w-run', 'wRun', t('Sonra çalıştır'))),
      h('div', { class: 'pg-row' },
        isEs() ? null : h('label', { class: 'hint', for: 'pg-w-base', text: t('.bin başlangıç adresi') }),
        isEs() ? null : h('input', { id: 'pg-w-base', class: 'mono', value: P.base, oninput: (e) => (P.base = e.target.value) }),
        h('button', { class: 'small', id: 'pg-write-go', disabled: off, onclick: () => post(isDfu()
          ? { type: 'prog.dfu', op: 'write', base: num(P.base), run: P.wRun }
          : { type: 'prog.write', base: num(P.base), erase: P.wErase, verify: P.wVerify, run: P.wRun }) }, t('Dosya seç ve yaz (.elf / .hex / .bin)…'))),
      progressBar('write') || progressBar('dfu'));
  }

  const dfuTool = () => { const x = P.bootInfo && P.bootInfo.tools; return x && (x.dfuutil.found ? 'dfu-util' : x.cubeprog.found ? 'STM32_Programmer_CLI' : ''); };

  /** UART / DFU: bootloader'a giriş talimatı, AN2606 arayüzleri, DFU araçları ve aygıtları */
  /** ES-303: Embedded Studio bootloader bilgisi */
  function renderEs(box) {
    const b = P.boot && P.boot.connected && P.boot.kind === 'esboot' ? P.boot : null;
    const d = ES.state.design || {};
    const on = d.boot && d.boot.enabled;
    put(box,
      h('h3', { text: t('Embedded Studio bootloader') }),
      b ? h('div', { class: `pg-result ${b.app === 0 ? 'ok' : 'diff'}`, id: 'pg-es-info' },
        h('div', { text: t('Bootloader v{0} · yuva {1} ({2} KB)', b.version, hex(b.slotBase), b.slotSize / 1024) }),
        h('div', { id: 'pg-es-app', text: t('Uygulama: {0}', b.appText) + (b.header ? ` · v${b.header.version} · ${b.header.buildId} · ${b.header.size} B` : '') }),
        // ES-304: güvenlik ayarları cihazdan (INFO)
        b.protocol >= 2 ? h('div', { id: 'pg-es-sec', text: [
          b.ab ? t('A/B: hazırlık yuvası {0} ({1} KB)', hex(b.stageBase), b.stageSize / 1024) : t('Tek yuva'),
          b.signed ? t('Ed25519 imzası gerekli (anahtar {0})', b.keyId) : t('imza denetimi yok'),
          b.rollback ? t('en düşük sürüm v{0}', b.floorText) : t('geri dönüş koruması kapalı')
        ].join(' · ') }) : null,
        b.stage && b.stage.header && b.stage.header.present ? h('div', { id: 'pg-es-stage', text: t('Hazırlık yuvası: v{0} · {1}{2}', b.stage.header.version, b.stage.statusText, b.stage.done ? ' · ' + t('işlendi') : '') }) : null) : null,
      on ? null : h('p', { class: 'dbg-msg error', text: t('Bu projede bootloader kapalı (Proje Ayarları > Bootloader). Karttaki bootloader başka bir projeden olabilir.') }),
      h('ol', { class: 'pg-steps', id: 'pg-steps' },
        h('li', { text: t('Bootloader ile uygulama birlikte bir kez SWD ile yüklenir (Yükle düğmesi _full.hex yazar).') }),
        h('li', { text: t('Güncelleme modu: açılış penceresinde (kartı resetleyin), uygulama es_boot_request_update() çağırınca ya da geçerli imaj yokken.') }),
        h('li', { text: t('"Dosya seç ve yaz" başlıklı uygulama imajını (<proje>.bin / .hex / .elf) gönderir; "Sonra çalıştır" bootloader\'ı yeniden başlatır.') }),
        b && b.signed ? h('li', { text: t('Cihaz imzalı imaj istiyor: imzasız dosya, bu makinedeki özel anahtarla gönderilmeden önce imzalanır.') }) : null,
        b && b.ab ? h('li', { text: t('A/B: yeni imaj önce hazırlık yuvasına yazılır; ancak doğrulandıktan sonra ana yuvaya kopyalanır. Kopyalama kesilirse bootloader açılışta tamamlar.') })
          : h('li', { text: t('Güncelleme yarıda kalırsa imaj commit almaz: bootloader uygulamayı çalıştırmaz, yeni güncelleme bekler.') })));
  }

  function renderBoot() {
    const box = $('pg-boot');
    box.hidden = !(isUart() || isDfu());
    if (box.hidden) return;
    if (isEs()) return renderEs(box);
    const bi = P.bootInfo;
    if (!bi) return put(box, h('h3', { text: t('Sistem bootloader\'ı') }), h('p', { class: 'hint', text: t('Okunuyor…') }));
    const i = bi.info;
    const b = P.boot;
    const tools = bi.tools;
    put(box,
      h('h3', { text: t('Sistem bootloader\'ı · {0}', bi.mcu) }),
      b && b.connected ? h('div', { class: 'pg-result ok', id: 'pg-boot-info' },
        h('div', { text: t('{0}, bootloader v{1}, PID 0x{2}', b.device, b.version, b.pid.toString(16).toUpperCase()) }),
        h('div', { class: 'hint', text: t('Komutlar: {0}', b.commands.join(', ')) })) : null,
      h('p', { class: 'hint', text: t('Bootloader\'a giriş ({0}):', bi.board) }),
      h('ol', { class: 'pg-steps', id: 'pg-steps' }, ...i.steps.map((x) => h('li', { text: x }))),
      i.note ? h('p', { class: 'hint', text: i.note }) : null,
      h('table', { class: 'regs pg-obt', id: 'pg-an2606' },
        h('thead', {}, h('tr', {}, h('th', { text: t('Arayüz') }), h('th', { text: t('Pinler') }))),
        h('tbody', {},
          ...i.uart.map((u) => h('tr', {}, h('td', { text: `${u.name} (UART)` }), h('td', { class: 'mono', text: `TX ${u.tx} · RX ${u.rx}` }))),
          h('tr', {}, h('td', { text: 'USB DFU' }), h('td', { class: 'mono', text: i.dfu ? `DM ${i.dfu[0]} · DP ${i.dfu[1]}` : t('yok') })),
          ...i.other.map((o) => h('tr', {}, h('td', { text: o.name }), h('td', { class: 'mono', text: o.pins }))))),
      i.other.length ? h('p', { class: 'hint', text: t('CAN / I2C / SPI bootloader\'ı için bir köprü kart (ör. başka bir MCU ya da USB-I2C/SPI dönüştürücü) gerekir; bu sürümde yalnızca UART ve USB DFU kullanılır.') }) : null,
      h('p', { class: 'hint', text: t('Pinler AN2606\'ya göredir (bootloader v{0}); işlemci revizyonunuz için AN2606\'yı doğrulayın.', i.version || '?') }),
      isDfu() ? h('div', { class: 'pg-dfu', id: 'pg-dfu' },
        h('div', { class: 'pg-row' },
          h('span', { class: tools.dfuutil.found || tools.cubeprog.found ? 'pg-state on' : 'dbg-msg error', id: 'pg-dfu-tool', text: dfuTool() ? t('Araç: {0}', dfuTool()) : t('dfu-util ya da STM32CubeProgrammer bulunamadı.') }),
          h('button', { class: 'ghost small', id: 'pg-dfu-list', disabled: !dfuTool() || busy(), onclick: () => post({ type: 'prog.dfu', op: 'list' }) }, t('Aygıtları ara')),
          h('button', { class: 'ghost small', id: 'pg-dfu-read', disabled: !dfuTool() || busy(), onclick: () => post({ type: 'prog.dfu', op: 'read' }) }, t('Flash\'ı oku…')),
          h('button', { class: 'ghost small danger', id: 'pg-dfu-erase', disabled: !dfuTool() || busy(), onclick: () => post({ type: 'prog.dfu', op: 'erase' }) }, t('Tamamını sil'))),
        dfuTool() ? null : h('p', { class: 'hint', text: `dfu-util: ${tools.dfuutil.hint || ''} · ${tools.dfuutil.install || ''}` }),
        dfuTool() ? null : h('p', { class: 'hint', text: `STM32CubeProgrammer: ${tools.cubeprog.install || ''}` }),
        P.dfu ? h('div', { class: 'hint', id: 'pg-dfu-devices' }, ...(P.dfu.devices.length ? P.dfu.devices.map((d) => h('div', { class: 'mono', text: `${d.vid}:${d.pid} alt ${d.alt} · ${d.memory ? d.memory.name + ' @' + hex(d.memory.base) + ', ' + d.memory.sectors.length + ' ' + t('sektör') : d.name}${d.serial ? ' · ' + d.serial : ''}` })) : [h('div', { text: P.dfu.raw ? t('Liste çıktı panelinde.') : t('Aygıt yok.') })])) : null) : null);
  }

  function progressBar(op) {
    const p = P.progress;
    if (!p || p.op !== op || p.pct === null) return null;
    return h('div', { class: 'pg-progress', role: 'progressbar', 'aria-valuenow': String(p.pct) }, h('div', { style: `width:${p.pct}%` }));
  }

  function renderRead() {
    const custom = P.region === 'custom';
    const info = P.info;
    const off = !P.connected || busy();
    put($('pg-read'), 
      h('h3', { text: t('Oku ve kaydet') }),
      h('div', { class: 'pg-row' },
        h('select', { id: 'pg-region', 'aria-label': t('Bölge'), onchange: (e) => { P.region = e.target.value; renderRead(); } },
          h('option', { value: 'flash', selected: P.region === 'flash', text: `Flash${info ? ` (${info.flashKB} KB)` : ''}` }),
          h('option', { value: 'ram', selected: P.region === 'ram', text: `RAM${info ? ` (${info.ramKB} KB)` : ''}` }),
          h('option', { value: 'custom', selected: custom, text: t('Adres ve uzunluk') })),
        custom ? h('input', { id: 'pg-addr', class: 'mono', value: P.addr, 'aria-label': t('Adres'), placeholder: '0x08000000', oninput: (e) => (P.addr = e.target.value) }) : null,
        custom ? h('input', { id: 'pg-length', class: 'mono', value: P.length, 'aria-label': t('Uzunluk (bayt)'), placeholder: '0x1000', oninput: (e) => (P.length = e.target.value) }) : null,
        h('select', { id: 'pg-format', 'aria-label': t('Biçim'), onchange: (e) => (P.format = e.target.value) },
          h('option', { value: 'bin', selected: P.format === 'bin', text: '.bin' }), h('option', { value: 'hex', selected: P.format === 'hex', text: '.hex' })),
        h('button', { class: 'small', id: 'pg-read-go', disabled: off, onclick: () => post({ type: 'prog.read', region: P.region, addr: num(P.addr), length: num(P.length), format: P.format }) }, t('Oku…'))),
      progressBar('read'));
  }

  function renderCompare() {
    const r = P.compare;
    put($('pg-compare'), 
      h('h3', { text: t('Dosyayla karşılaştır') }),
      h('div', { class: 'pg-row' },
        h('label', { class: 'hint', for: 'pg-base', text: t('.bin başlangıç adresi') }),
        h('input', { id: 'pg-base', class: 'mono', value: P.base, oninput: (e) => (P.base = e.target.value) }),
        h('button', { class: 'small', id: 'pg-compare-go', disabled: !P.connected || busy(), onclick: () => post({ type: 'prog.compare', base: num(P.base) }) }, t('Dosya seç (.elf / .hex / .bin)…'))),
      progressBar('compare'),
      r ? h('div', { class: `pg-result ${r.result.same ? 'ok' : 'diff'}`, id: 'pg-compare-result' },
        h('div', { text: r.result.same ? t('{0}: cihazla aynı ({1} bayt).', r.file, r.result.total) : t('{0}: {1} / {2} bayt farklı, {3} bölge.', r.file, r.result.diff, r.result.total, r.result.rangeCount) }),
        r.result.blankDevice ? h('div', { class: 'hint', text: t('Cihazda bu bölge boş (silinmiş).') }) : null,
        r.result.ranges.length && !r.result.same ? h('table', { class: 'regs pg-diff' },
          h('thead', {}, h('tr', {}, h('th', { text: t('Bölge') }), h('th', { text: t('Bayt') }))),
          h('tbody', {}, ...r.result.ranges.slice(0, 10).map((x) => h('tr', {}, h('td', { class: 'mono', text: `${hex(x.start)} – ${hex(x.end - 1)}` }), h('td', { text: String(x.end - x.start) }))))) : null,
        r.result.first.length && !r.result.same ? h('div', { class: 'hint mono', text: r.result.first.slice(0, 4).map((d) => `${hex(d.addr)}: ${t('dosya')} ${d.file.toString(16).padStart(2, '0')} ≠ ${t('cihaz')} ${d.device.toString(16).padStart(2, '0')}`).join(' · ') }) : null) : null);
  }

  function renderOb() {
    const box = $('pg-ob');
    const ob = P.info && P.info.ob;
    if (!P.info) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'hint', text: t('Bağlanınca okuma koruması (RDP), BOR, yazma koruması ve kullanıcı bitleri burada görünür.') }));
    if (!ob) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'hint', text: t('Bu işlemci ailesi için option byte tanımı yok.') }));
    if (ob.error) return put(box, h('h3', { text: t('Option bytes') }), h('p', { class: 'dbg-msg error', text: ob.error }));
    const prot = (list) => (list.length ? list.map((i) => P.info.sectors[i] ? P.info.sectors[i].num : i).join(', ') : t('yok'));
    put(box, 
      h('h3', { text: t('Option bytes') }),
      h('div', { class: `pg-rdp lvl${String(ob.rdp.level).replace('.', '')}`, id: 'pg-rdp' },
        h('b', { text: `RDP ${hex(ob.rdp.byte, 2)}` }), h('span', { text: ob.rdp.text })),
      h('table', { class: 'regs pg-obt' },
        h('tbody', {},
          ob.bor ? h('tr', {}, h('td', { text: 'BOR' }), h('td', { text: ob.bor })) : null,
          h('tr', {}, h('td', { text: t('Yazma koruması (WRP)') }), h('td', { id: 'pg-wrp', text: prot(ob.wrp) })),
          ob.pcrop.length ? h('tr', {}, h('td', { text: 'PCROP' }), h('td', { text: prot(ob.pcrop) })) : null,
          ...ob.user.map((u) => h('tr', {}, h('td', { class: 'mono', text: u.name }), h('td', { text: `${u.value} · ${u.text}` }))),
          ...ob.registers.map((r) => h('tr', { class: 'pg-raw' }, h('td', { class: 'mono', text: `${r.name} @${hex(r.addr)}` }), h('td', { class: 'mono', text: r.value === undefined ? '—' : hex(r.value) }))))),
      ...ob.notes.map((n) => h('p', { class: 'hint', text: n })),
      h('p', { class: 'hint', text: t('Salt okunur. Option byte yazma (RDP seviyesi, WRP, BOR, boot) kartla denendikten sonra eklenecek; RDP 2 kalıcıdır.') }));
  }

  function renderSectors() {
    const box = $('pg-sectors');
    const info = P.info;
    if (!info || !info.sectors) {
      put(box, h('h3', { text: t('Sektörler') }), h('p', { class: 'hint', text: P.connected ? t('Okunuyor…') : t('Bağlanınca flash sektörleri ya da sayfaları burada listelenir; seçip silebilirsiniz.') }));
      return;
    }
    const list = info.sectors;
    const banks = new Set(list.map((s) => s.phys)).size;
    const off = !P.connected || busy();
    const selSize = list.filter((s) => P.sel.has(s.index)).reduce((n, s) => n + s.size, 0);
    const toggle = (s, e) => {
      if (e.shiftKey && P.last !== null) {
        const [a, b] = [Math.min(P.last, s.index), Math.max(P.last, s.index)];
        for (let i = a; i <= b; i++) P.sel.add(i);
      } else if (P.sel.has(s.index)) P.sel.delete(s.index);
      else P.sel.add(s.index);
      P.last = s.index;
      renderSectors();
    };
    put(box, 
      h('h3', { text: t('Sektörler ({0})', list.length) }),
      h('div', { class: 'pg-row' },
        h('button', { class: 'small danger', id: 'pg-erase-sel', disabled: off || !P.sel.size, onclick: () => post({ type: 'prog.erase', indexes: [...P.sel] }) }, P.sel.size ? t('Seçilenleri sil ({0}, {1})', P.sel.size, size(selSize)) : t('Seçilenleri sil')),
        h('button', { class: 'ghost small danger', id: 'pg-erase-all', disabled: off, onclick: () => post({ type: 'prog.erase', all: true }) }, t('Tamamını sil')),
        h('button', { class: 'ghost small', id: 'pg-sel-none', disabled: !P.sel.size, onclick: () => { P.sel.clear(); renderSectors(); } }, t('Seçimi temizle')),
        h('span', { class: 'hint', text: info.source === 'static' ? t('işlemci verisinden') : info.source === 'sim' ? t('simülasyon') : t('OpenOCD\'den') })),
      progressBar('erase'),
      h('div', { class: 'pg-table' },
        h('table', { class: 'regs' },
          h('thead', {}, h('tr', {}, h('th', {}), h('th', { text: '#' }), banks > 1 ? h('th', { text: 'Bank' }) : null, h('th', { text: t('Adres') }), h('th', { text: t('Boyut') }), h('th', { text: t('Durum') }))),
          h('tbody', {}, ...list.map((s) => h('tr', { class: P.sel.has(s.index) ? 'sel' : '', onclick: (e) => { if (e.target.tagName !== 'INPUT') toggle(s, e); } },
            h('td', {}, h('input', { type: 'checkbox', id: `pg-s-${s.index}`, 'aria-label': t('Sektör {0}', s.num), checked: P.sel.has(s.index), onclick: (e) => { e.preventDefault(); toggle(s, e); } })),
            h('td', { class: 'mono', text: String(s.num) }),
            banks > 1 ? h('td', { text: String(s.phys) }) : null,
            h('td', { class: 'mono', text: hex(s.addr) }),
            h('td', { text: size(s.size) }),
            h('td', { class: s.protected ? 'warn' : 'hint', text: s.protected ? t('yazma korumalı') : '' })))))),
      h('p', { class: 'hint', text: t('Shift + tık ile aralık seçilir. Silmeden önce hedef durdurulur.') }));
  }
  const size = (n) => (n >= 1048576 ? `${n / 1048576} MB` : n >= 1024 ? `${n / 1024} KB` : `${n} B`);

  function renderLog() {
    const box = $('pg-log');
    put(box, 
      h('h3', {}, t('İşlem günlüğü'), h('button', { class: 'ghost small', id: 'pg-log-clear', style: 'margin-left:auto', disabled: !P.log.length, onclick: () => { P.log = []; renderLog(); } }, t('Temizle'))),
      h('div', { class: 'pg-logl', id: 'pg-log-list' }, ...(P.log.length ? P.log.slice().reverse().map((e) => h('div', { class: `pg-le ${e.level}` },
        h('span', { class: 'mono hint', text: new Date(e.at).toLocaleTimeString() }), h('span', { text: e.text }))) : [h('div', { class: 'hint', text: t('Henüz işlem yok.') })])));
  }

  function render() {
    if (!$('programmer')) return;
    renderBar();
    renderBoot();
    renderWrite();
    // DFU'da okuma, karşılaştırma ve silme DFU kartında (araçla); bu kartlar prob / bootloader bağlantısı içindir
    for (const id of ['pg-read', 'pg-compare', 'pg-ob', 'pg-sectors']) $(id).hidden = isDfu() || isEs();
    renderRead();
    renderCompare();
    renderOb();
    renderSectors();
    renderLog();
  }

  ES.on('debug.status', (m) => {
    P.dbg = !!m.connected;
    P.connecting = !!m.connecting;
    if (m.mode) P.mode = m.mode;
    P.state = m.state || '';
    P.error = m.error || '';
    sync();
    render();
  });
  ES.on('prog.boot', (m) => {
    P.connecting = !!m.connecting;
    if (!m.connecting) P.boot = m.connected ? m : null;
    if (m.error) P.error = m.error;
    else if (m.connected) P.error = '';
    P.note = m.note || '';
    sync();
    render();
  });
  ES.on('prog.bootInfo', (m) => {
    P.bootInfo = m;
    const ports = m.ports || [];
    if (!ports.some((x) => x.path === P.port)) P.port = (ports.find((x) => x.vcp) || ports[0] || {}).path || '';
    render();
  });
  ES.on('prog.dfu', (m) => {
    P.dfu = m;
    renderBoot();
  });
  ES.on('prog.info', (m) => {
    if (m.error) { P.error = m.error; return renderBar(); }
    P.info = m;
    for (const i of [...P.sel]) if (!m.sectors[i]) P.sel.delete(i);
    render();
  });
  ES.on('prog.progress', (m) => {
    P.progress = m;
    renderBar();
    if (m.op === 'read') renderRead();
    else if (m.op === 'compare') renderCompare();
    else if (m.op === 'write' || m.op === 'dfu') { renderWrite(); renderBoot(); }
    else renderSectors();
  });
  ES.on('prog.compare', (m) => {
    P.compare = m;
    renderCompare();
  });
  ES.on('prog.log', (m) => {
    P.log = [...P.log, m.entry].slice(-500);
    if (m.entry.level === 'ok' && P.progress && P.progress.op === 'erase') P.sel.clear();
    renderLog();
  });
  ES.on('prog.history', (m) => {
    P.log = m.entries || [];
    renderLog();
  });

  ES.tabs.programmer = { mount, render, onShow: render };
})();
