/* Proje Ayarları sekmesi: MCU, kod altyapısı ve RTOS projenin kimliğidir; burada değiştirilir.
 * Seçimler önce taslakta tutulur, eklenti etkilenen dosyaları hesaplar (settings.preview), kullanıcı onaylayınca uygulanır. */
(function () {
  const { t, h, $, post, state, update, toast } = ES;
  let draft = null; // { mcuId, framework, rtos }
  let preview = null;
  let seq = 0;
  let toolchains = null; // algılanan araç zincirleri (build.detect)
  let lastSize = null; // son derlemenin boyut özeti (build.size)

  function mount(parent) {
    parent.append(h('main', { id: 'settings', class: 'tab-pane' }, h('div', { class: 'settings', id: 'settings-body' })));
  }

  const current = () => ({ mcuId: state.design.mcuId, framework: state.design.framework, rtos: !!state.design.rtos });
  const changed = () => draft && JSON.stringify(draft) !== JSON.stringify(current());

  function choice(group, value, title, desc) {
    const sel = draft[group] === value;
    return h('label', { class: `choice${sel ? ' selected' : ''}` },
      h('input', { type: 'radio', name: `set-${group}`, value: String(value), checked: sel, onchange: () => { draft[group] = value; requestPreview(); render(); } }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }));
  }

  function modeChoice(value, title, desc) {
    const sel = (state.design.mode || 'beginner') === value;
    return h('label', { class: `choice${sel ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'set-mode', value, checked: sel, onchange: () => { state.design.mode = value; update(); } }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }));
  }

  function requestPreview() {
    preview = null;
    if (changed()) post({ type: 'settings.preview', seq: ++seq, settings: draft });
  }

  function apply() {
    const mcuChanged = draft.mcuId !== state.design.mcuId;
    Object.assign(state.design, draft);
    if (mcuChanged) {
      state.design.locks = {};
      delete state.design.clock; // eklenti yeni MCU'nun varsayılan saat ayarını koyar
    }
    update();
    toast('info', t('Proje ayarları uygulandı. Dosyalar "Kod Üret" ile güncellenir.'));
    draft = null;
    preview = null;
    render();
  }

  function fileList(title, files, cls) {
    if (!files.length) return null;
    const shown = files.slice(0, 12);
    return h('div', { class: `set-files ${cls}` },
      h('div', { class: 'set-files-head', text: `${title} (${files.length})` }),
      ...shown.map((f) => h('div', { class: 'mono', text: f })),
      files.length > shown.length ? h('div', { class: 'hint', text: t('… ve {0} dosya daha', files.length - shown.length) }) : null);
  }

  function renderPreview() {
    if (!changed()) return h('p', { class: 'hint', text: t('Değişiklik yok.') });
    if (!preview) return h('p', { class: 'hint', text: t('Etkilenen dosyalar hesaplanıyor…') });
    const p = preview;
    return h('div', { class: 'set-preview' },
      ...p.notes.map((n) => h('div', { class: `note ${n.level}` }, h('span', { class: 'ic', text: n.level === 'warn' ? '!' : 'i' }), h('span', { text: n.text }))),
      p.generated
        ? h('div', {},
          fileList(t('Eklenecek'), p.added, 'add'),
          fileList(t('Kaldırılacak'), p.removed, 'del'),
          fileList(t('Değişecek'), p.changed, 'mod'),
          !p.added.length && !p.removed.length && !p.changed.length ? h('p', { class: 'hint', text: t('Üretilen dosyalarda değişiklik yok.') }) : null)
        : h('p', { class: 'hint', text: t('Henüz kod üretilmedi; dosyalar ilk "Kod Üret"te bu ayarlarla oluşturulur.') }),
      p.packs.length ? h('p', { class: 'hint', text: t('İndirilecek paketler: {0}', p.packs.join(', ')) }) : null);
  }

  // ---- Derleme (ES-105): değişiklikler hemen kaydedilir, dosyalara "Kod Üret" ile yazılır ----
  const BUILD_TYPES = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];
  const OPT_LEVELS = ['-O0', '-Og', '-O1', '-O2', '-O3', '-Os', '-Oz'];

  function setBuild(mutate) {
    const b = JSON.parse(JSON.stringify(state.design.build));
    mutate(b);
    state.design.build = b;
    update();
  }

  const select = (id, value, options, onchange) => h('select', { id, onchange: (e) => onchange(e.target.value) },
    ...options.map(([v, label]) => h('option', { value: v, selected: v === value, text: label })));

  function textField(id, label, value, placeholder, onchange, opts = {}) {
    const input = opts.multiline
      ? h('textarea', { id, class: 'mono', rows: 3, placeholder, value, onchange: (e) => onchange(e.target.value) })
      : h('input', { id, type: 'text', class: 'mono', placeholder, value, onchange: (e) => onchange(e.target.value.trim()) });
    return h('div', { class: 'field' }, h('label', { for: id, text: label }),
      opts.browse ? h('div', { class: 'set-inline' }, input, h('button', { class: 'ghost small', onclick: () => post({ type: 'build.pickDir', field: opts.browse }) }, t('Gözat'))) : input);
  }

  function cmakeChoice(b, value, title, desc) {
    const sel = b.cmake === value;
    return h('label', { class: `choice${sel ? ' selected' : ''}` },
      h('input', { type: 'radio', name: 'set-cmake', value, checked: sel, onchange: () => setBuild((x) => { x.cmake = value; }) }),
      h('span', { class: 'choice-title', text: title }),
      h('span', { class: 'choice-desc', text: desc }));
  }

  function usageBar(label, used, totalKB) {
    const pct = Math.min(100, (used * 100) / (totalKB * 1024));
    return h('div', { class: 'set-usage' },
      h('span', { class: 'label', text: label }),
      h('div', { class: 'bar' }, h('div', { style: `width:${pct.toFixed(1)}%`, class: pct > 90 ? 'hot' : '' })),
      h('span', { class: 'mono', text: `${(used / 1024).toFixed(1)} / ${totalKB} KB (${pct.toFixed(1)}%)` }));
  }

  function toolchainList(b) {
    if (!toolchains) return null;
    const gcc = toolchains.filter((x) => x.kind === (b.toolchain.compiler === 'clang' ? 'clang' : 'gcc'));
    if (!gcc.length) return h('p', { class: 'hint', text: b.toolchain.compiler === 'clang' ? t('Clang bulunamadı. LLVM\'i kurun ya da klasörünü elle girin.') : t('arm-none-eabi-gcc bulunamadı. Arm GNU Toolchain\'i kurun ya da klasörünü elle girin.') }) ;
    const field = b.toolchain.compiler === 'clang' ? 'llvmPath' : 'gccPath';
    return h('div', { class: 'tc-list' }, ...gcc.map((x) => {
      const active = b.toolchain[field] ? b.toolchain[field] === x.dir : x.inPath;
      return h('button', { class: `ghost small tc-item${active ? ' active' : ''}`, title: x.dir, onclick: () => setBuild((y) => { y.toolchain[field] = x.inPath ? '' : x.dir; }) },
        h('span', { text: x.version }), h('span', { class: 'hint mono', text: x.inPath ? `PATH · ${x.dir}` : x.dir }));
    }));
  }

  // ---- Örnek register sürücüleri (ES-107): bare-metal projede drivers/reg/ altına bir kez üretilir ----
  const REG_DRIVERS = [
    ['rcc', t('RCC / saat'), t('Saat kurulumu (bu projenin Clock ayarı) ve HCLK/PCLK frekanslarını register\'lardan okuma.')],
    ['gpio', 'GPIO', t('Pin modu, çekme direnci, çıkış tipi, alternatif fonksiyon; yazma, okuma, tersleme.')],
    ['exti', 'EXTI', t('GPIO pin kesmesi: kenar seçimi, bayrak, NVIC kesme numarası.')],
    ['uart', 'UART', t('Yoklamalı gönderme/alma, kesmeyle halka tampona alma, DMA ile gönderme.')],
    ['spi', 'SPI', t('Master, mod 0-3, saat bölücü; tam çift yönlü aktarım.')],
    ['i2c', 'I2C', t('Master; 100/400 kHz zamanlaması çalışma anında hesaplanır; register okuma/yazma.')],
    ['tim', 'TIM', t('PWM, input capture (periyot ölçümü), encoder modu.')],
    ['adc', 'ADC', t('Tek kanal okuma ve DMA ile sürekli çok kanallı tarama.')],
    ['dac', 'DAC', t('12 bit DAC çıkışı (kanal 1/2).')],
    ['dma', 'DMA', t('Çevre birimi ↔ bellek aktarımı; bu işlemci için UART, ADC ve SPI istek eşlemeleri hazır.')],
    ['iwdg', 'IWDG', t('Bağımsız watchdog: milisaniye cinsinden zaman aşımı.')],
    ['wwdg', 'WWDG', t('Pencereli watchdog: sayaç ve pencere ayarı.')],
    ['crc', 'CRC', t('Donanım CRC-32 (polinom 0x04C11DB7).')],
    ['flash', 'FLASH', t('Kilit açma, sayfa/sektör silme, programlama (bu işlemcinin flash düzeniyle).')],
    ['trace', 'Trace (ITM / RTT)', t('printf\'i SWO/ITM ve SEGGER RTT\'ye yönlendirme; Debug > Konsol ile okunur.')]
  ];

  /** src/codegen/regdrivers.js DRIVERS[].requires ile aynı */
  const REG_REQUIRES = { exti: ['gpio'], uart: ['dma'], adc: ['dma'] };

  function regDriverSection() {
    const mcu = state.lib.mcus[state.design.mcuId];
    const sel = new Set(state.design.regDrivers || []);
    const avail = new Set(mcu.regDriverIds || []);
    const bare = state.design.framework === 'register';
    const toggle = (id, on) => {
      const next = new Set(state.design.regDrivers || []);
      if (on) next.add(id); else next.delete(id);
      state.design.regDrivers = REG_DRIVERS.map(([i]) => i).filter((i) => next.has(i));
      update();
    };
    return h('section', { class: 'wizard-card', id: 'set-regdrivers' },
      h('h3', { text: t('Örnek register sürücüleri') }),
      bare
        ? h('p', { class: 'hint', text: t('Seçilenler "Kod Üret" ile drivers/reg/ klasörüne bir kez üretilir ve sonra sizindir (seçimi kaldırmak dosyaları silmez). Yalnızca CMSIS cihaz başlığına bağlıdır; her dosyada kullanım örneği ve reference manual bölümü vardır. UART ve ADC, DMA sürücüsünü de ekler.') })
        : h('p', { class: 'hint', text: t('Örnek register sürücüleri bare-metal (register) altyapıda kullanılır. Kod altyapısını yukarıdan değiştirebilirsiniz.') }),
      bare ? h('div', { class: 'reg-drivers' }, ...REG_DRIVERS.map(([id, title, desc]) => {
        const ok = avail.has(id);
        // Seçilenlerin bağımlılığı olarak gelen sürücü (UART/ADC → DMA, EXTI → GPIO): işaretli ve kilitli
        const by = Object.entries(REG_REQUIRES).filter(([d, reqs]) => sel.has(d) && reqs.includes(id)).map(([d]) => d.toUpperCase());
        const forced = ok && by.length > 0 && !sel.has(id);
        return h('label', { class: `check reg-driver${ok && !forced ? '' : ' disabled'}`, title: !ok ? t('{0} bu işlemcide yok.', title) : forced ? t('{0} için gerekli.', by.join(', ')) : '' },
          h('input', { type: 'checkbox', id: `set-rd-${id}`, checked: (sel.has(id) || forced) && ok, disabled: !ok || forced, onchange: (e) => toggle(id, e.target.checked) }),
          h('span', {}, h('b', { text: title }), h('span', { class: 'hint', text: ` — ${desc}` })));
      })) : null);
  }

  function buildSection() {
    const b = state.design.build;
    const mcu = state.lib.mcus[state.design.mcuId];
    const name = (state.design.project || {}).name || 'app';
    const preset = b.type.toLowerCase();
    return h('section', { class: 'wizard-card', id: 'set-build' },
      h('h3', { text: t('Derleme') }),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: t('CMake yapılandırması') }),
        h('div', { class: 'choices two' },
          cmakeChoice(b, 'tool', t('Embedded Studio yönetir'), t('CMakeLists.txt üretilir; kendi eklemeleriniz USER CODE bloklarında korunur.')),
          cmakeChoice(b, 'user', t('CMake\'i ben yönetiyorum'), t('CMakeLists.txt\'ye hiç yazılmaz. Ayarlar sadece cmake/embedded-studio.cmake dosyasına üretilir; siz include edersiniz.')))),
      b.cmake === 'user' ? h('div', { class: 'field' },
        h('span', { class: 'label', text: t('CMakeLists.txt dosyanıza ekleyin (project() satırından sonra):') }),
        h('pre', { class: 'set-snippet mono', id: 'set-cmake-snippet', text: `include(cmake/embedded-studio.cmake)\nadd_executable(\${PROJECT_NAME} <${t('kendi kaynaklarınız')}>)\nembedded_studio_target(\${PROJECT_NAME})` }),
        h('p', { class: 'hint', text: t('CMakeLists.txt yoksa bir kez başlangıç dosyası oluşturulur. Değişkenler (ES_SOURCES, ES_DEFINES …) dosyanın başında açıklanır.') })) : null,
      h('div', { class: 'set-grid' },
        h('div', { class: 'field' }, h('label', { for: 'set-build-type', text: t('Derleme tipi') }),
          select('set-build-type', b.type, BUILD_TYPES.map((x) => [x, x]), (v) => setBuild((x) => { x.type = v; }))),
        h('div', { class: 'field' }, h('label', { for: 'set-fpu', text: t('FPU / float ABI') }),
          // FPU'su olmayan çekirdek (Cortex-M0/M0+/M3): seçim kapalı, her zaman yazılım float
          mcu.fpu === null
            ? h('select', { id: 'set-fpu', disabled: true, title: t('{0} çekirdeğinde FPU yok.', mcu.core) }, h('option', { text: t('Yazılım (FPU yok)') }))
            : select('set-fpu', b.fpu, [['hard', t('Donanım (hard, {0})', mcu.fpu || 'fpv4-sp-d16')], ['softfp', t('softfp (FPU, yazılım ABI)')], ['soft', t('Yazılım (FPU yok)')]], (v) => setBuild((x) => { x.fpu = v; }))),
        h('div', { class: 'field' }, h('label', { for: 'set-warn', text: t('Uyarı seviyesi') }),
          select('set-warn', b.warnings, [['off', t('Kapalı')], ['normal', '-Wall -Wextra'], ['strict', t('Sıkı (+ -Wshadow -Wundef …)')]], (v) => setBuild((x) => { x.warnings = v; })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'set-werror', checked: b.werror, onchange: (e) => setBuild((x) => { x.werror = e.target.checked; }) }), h('span', { text: t('Uyarıları hata say (-Werror)') })))),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: t('Optimizasyon') }),
        h('div', { class: 'set-grid four' }, ...BUILD_TYPES.map((bt) => h('label', { class: 'set-opt' }, h('span', { class: 'hint', text: bt }),
          select(`set-opt-${bt}`, b.opt[bt], OPT_LEVELS.map((o) => [o, o]), (v) => setBuild((x) => { x.opt[bt] = v; })))))),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: t('C kütüphanesi (--specs)') }),
        h('div', { class: 'set-inline' },
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'set-nano', checked: b.specs.nano, onchange: (e) => setBuild((x) => { x.specs.nano = e.target.checked; }) }), h('span', { text: t('nano.specs (küçük newlib)') })),
          h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'set-nosys', checked: b.specs.nosys, onchange: (e) => setBuild((x) => { x.specs.nosys = e.target.checked; }) }), h('span', { text: t('nosys.specs (sistem çağrısı saplamaları)') })))),
      h('div', { class: 'field' },
        h('label', { class: 'check' }, h('input', { type: 'checkbox', id: 'set-stackusage', checked: b.stackUsage !== false, onchange: (e) => setBuild((x) => { x.stackUsage = e.target.checked; }) }),
          h('span', { text: t('Yığın kullanımı analizi (-fstack-usage, -fcallgraph-info): Bellek raporu sekmesinde fonksiyon başına en kötü yığın') }))),
      h('div', { class: 'set-grid two' },
        textField('set-defines', t('Tanımlar (-D), satır başına bir tane'), b.defines.join('\n'), 'APP_VERSION=1\nUSE_FULL_ASSERT', (v) => setBuild((x) => { x.defines = v.split('\n').map((s) => s.trim()).filter(Boolean); }), { multiline: true }),
        textField('set-includes', t('Ek include klasörleri, satır başına bir tane'), b.includes.join('\n'), 'lib/inc', (v) => setBuild((x) => { x.includes = v.split('\n').map((s) => s.trim()).filter(Boolean); }), { multiline: true })),
      h('div', { class: 'set-grid two' },
        textField('set-cflags', t('Ek derleyici bayrakları'), b.cflags, '-fstack-usage', (v) => setBuild((x) => { x.cflags = v; })),
        textField('set-ldflags', t('Ek bağlayıcı bayrakları'), b.ldflags, '-Wl,--cref', (v) => setBuild((x) => { x.ldflags = v; }))),
      textField('set-linker', t('Linker script (boş: üretilen)'), b.linkerScript, state.design.framework === 'hal' ? `${mcu.name}_FLASH.ld` : `linker/${mcu.name}_FLASH.ld`, (v) => setBuild((x) => { x.linkerScript = v; })),
      h('div', { class: 'field' },
        h('span', { class: 'label', text: t('Araç zinciri') }),
        h('div', { class: 'set-inline' },
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'set-cc', checked: b.toolchain.compiler === 'gcc', onchange: () => setBuild((x) => { x.toolchain.compiler = 'gcc'; }) }), h('span', { text: 'GCC (arm-none-eabi)' })),
          h('label', { class: 'check' }, h('input', { type: 'radio', name: 'set-cc', id: 'set-clang', checked: b.toolchain.compiler === 'clang', onchange: () => setBuild((x) => { x.toolchain.compiler = 'clang'; }) }), h('span', { text: t('Clang/LLVM (deneysel)') })),
          h('button', { class: 'ghost small', id: 'set-detect', onclick: () => { toolchains = null; post({ type: 'build.detect' }); render(); } }, t('Kurulu sürümleri bul'))),
        toolchainList(b)),
      textField('set-gcc', t('arm-none-eabi-gcc klasörü (boş: PATH)'), b.toolchain.gccPath, 'PATH', (v) => setBuild((x) => { x.toolchain.gccPath = v; }), { browse: 'gccPath' }),
      b.toolchain.compiler === 'clang' ? textField('set-llvm', t('LLVM bin klasörü (boş: PATH)'), b.toolchain.llvmPath, 'PATH', (v) => setBuild((x) => { x.toolchain.llvmPath = v; }), { browse: 'llvmPath' }) : null,
      b.toolchain.compiler === 'clang' ? h('p', { class: 'hint', text: t('Clang C kodunu derler; assembler, bağlayıcı ve newlib arm-none-eabi-gcc\'den gelir, bu yüzden GCC de kurulu olmalı.') }) : null,
      h('p', { class: 'hint', text: t('Takımda herkesin yolu farklıysa klasörü boş bırakıp PATH kullanın ya da ES_GCC_DIR ortam değişkenini ayarlayın.') }),
      lastSize ? h('div', { class: 'field', id: 'set-size' },
        h('span', { class: 'label', text: t('Son derleme ({0}): {1}', lastSize.config, `${lastSize.dir}/${name}{${lastSize.outputs.join(',')}}`) }),
        usageBar('Flash', lastSize.flash, lastSize.flashKB),
        usageBar('RAM', lastSize.ram, lastSize.ramKB)) : null,
      h('p', { class: 'hint', text: t('Ayarlar hemen kaydedilir; dosyalar (cmake/embedded-studio.cmake, araç zinciri) "Kod Üret" ile güncellenir. Derle/Yükle seçili tipi kullanır: build/{0}/', preset) }));
  }

  function render() {
    const box = $('settings-body');
    if (!box || !state.design || !state.lib) return;
    if (!draft) draft = current();
    const proj = state.project || {};
    // Yeniden çizimde odak kaybolmasın (Tab ile bir alandan diğerine geçerken)
    const focused = document.activeElement && box.contains(document.activeElement) ? document.activeElement.id : null;
    const scroll = $('settings') ? $('settings').scrollTop : 0;
    box.replaceChildren(
      h('h2', { text: t('Proje ayarları') }),
      h('section', { class: 'wizard-card' },
        h('div', { class: 'set-row' }, h('span', { class: 'label', text: t('Proje adı') }), h('span', { class: 'mono', text: (state.design.project || {}).name || '' })),
        h('div', { class: 'set-row' }, h('span', { class: 'label', text: t('Konum') }), h('span', { class: 'mono hint', text: proj.root || '' }))),
      h('section', { class: 'wizard-card' },
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Çalışma modu') }),
          h('div', { class: 'choices two' },
            modeChoice('beginner', t('Acemi'), t('Görsel tasarım: komponent seç, şemada bağla, pinleri ve saati asistan atasın, örnek kod üretilsin.')),
            modeChoice('pro', t('Profesyonel'), t('Debug ve test öncelikli, yoğun ve sade arayüz. Tasarım ekranı isteğe bağlı bir araç olarak kalır.')))),
        h('p', { class: 'hint', text: t('Mod sadece arayüzü değiştirir; dosyalara dokunmaz.') })),
      h('section', { class: 'wizard-card' },
        h('p', { class: 'hint', text: t('Bu ayarlar projenin kimliğidir ve üretilen dosyaların yapısını belirler. Değiştirmeden önce etkilenen dosyaları kontrol edin.') }),
        h('div', { class: 'field' },
          h('label', { for: 'set-mcu', text: t('Mikrodenetleyici') }),
          h('select', { id: 'set-mcu', onchange: (e) => { draft.mcuId = e.target.value; requestPreview(); render(); } },
            ...Object.values(state.lib.mcus).map((m) => h('option', { value: m.id, selected: m.id === draft.mcuId, text: `${m.name} · ${m.board}` })))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('Kod altyapısı') }),
          h('div', { class: 'choices two' },
            choice('framework', 'hal', 'STM32 HAL', t('ST\'nin donanım soyutlama kütüphanesi projeye eklenir. Hızlı geliştirme, geniş örnek desteği.')),
            choice('framework', 'register', 'Bare-metal (register)', t('Sadece CMSIS başlıkları. Çevre birimleri doğrudan register ile sürülür; küçük ve şeffaf kod.')))),
        h('div', { class: 'field' },
          h('span', { class: 'label', text: t('İşletim sistemi') }),
          h('div', { class: 'choices two' },
            choice('rtos', false, t('Yok (süper döngü)'), t('Sensörler ana döngüde zamanlayıcıyla okunur.')),
            choice('rtos', true, 'FreeRTOS', t('Her sensör ayrı task; task izleme monitörde görünür.'))))),
      h('section', { class: 'wizard-card', id: 'set-preview' }, h('h3', { text: t('Etki') }), renderPreview()),
      h('div', { class: 'wizard-actions' },
        h('button', { class: 'ghost', id: 'set-cancel', disabled: !changed(), onclick: () => { draft = null; preview = null; render(); } }, t('Vazgeç')),
        h('button', { id: 'set-apply', disabled: !changed() || !preview, onclick: apply }, t('Uygula'))),
      buildSection(),
      regDriverSection());
    if (focused && $(focused)) $(focused).focus();
    if ($('settings')) $('settings').scrollTop = scroll;
  }

  ES.on('build.toolchains', (m) => {
    toolchains = m.items;
    render();
  });
  ES.on('build.dir', (m) => setBuild((x) => { x.toolchain[m.field] = m.path; }));
  ES.on('build.size', (m) => {
    lastSize = m;
    render();
  });

  ES.on('settings.preview', (m) => {
    if (m.seq !== seq) return;
    preview = m;
    render();
  });

  ES.tabs.settings = {
    mount,
    // Dışarıdan (ör. geri al) tasarım değişince taslak geçersizleşmesin diye sadece değişiklik yoksa sıfırla
    render() { if (!changed()) { draft = null; preview = null; } render(); },
    onShow: render
  };
})();
