// @ts-check
/**
 * VS Code debug entegrasyonu (ES-204): Cortex-Debug yapılandırmaları, launch.json / tasks.json birleştirme,
 * donanım breakpoint sınırı ve kaynakla karışık disassembly listesi. vscode'a bağlı değildir (birim testli).
 *
 * Breakpoint, koşullu breakpoint, hit count, logpoint, adım adım çalıştırma, run to cursor, disassembly görünümü ve
 * komut adımlama VS Code'un kendi debug arayüzünden gelir; Cortex-Debug bunların hepsini destekler.
 */
const { t } = require('../i18n');

/** Flash'ta çalışan kodda her breakpoint bir FPB karşılaştırıcısı harcar (OpenOCD flash bölgesinde donanım breakpoint'i kullanır) */
const HW_BREAKPOINTS = { 'cortex-m0': 4, 'cortex-m0plus': 4, 'cortex-m3': 6, 'cortex-m4': 6, 'cortex-m7': 8, 'cortex-m33': 8 };
const hwBreakpointLimit = (core) => HW_BREAKPOINTS[core] || 6;

/** Kılıf/sıcaklık ekini atar: STM32F411CEU6 → STM32F411CE (J-Link cihaz adı, pyOCD hedefi) */
const partName = (name) => String(name).toUpperCase().replace(/^(STM32[A-Z]\d{3}[A-Z0-9]{2})[A-Z0-9]*$/, '$1');

/** GDB sunucuları: Cortex-Debug servertype ve ilgili alanlar */
const SERVERS = {
  openocd: { label: 'OpenOCD' },
  stlink: { label: 'ST-LINK GDB server' },
  pyocd: { label: 'pyOCD' },
  jlink: { label: 'J-Link GDB server' }
};

/**
 * Bir Cortex-Debug yapılandırması.
 * @param {{ name: string, server?: string, request?: 'launch'|'attach', haltOnReset?: boolean, elf: string, cwd: string,
 *   mcuName: string, targetCfg: string, interfaceCfg?: string, serial?: string, svd?: string, toolchainPath?: string,
 *   rtos?: boolean, preLaunchTask?: string, speedKHz?: number, cpuHz?: number, swo?: boolean }} o
 *   cpuHz: SWO/RTT bloklarını ekler (HCLK); swo false: çekirdekte ITM yok
 */
function cortexConfig(o) {
  const server = o.server || 'openocd';
  const c = {
    name: o.name, type: 'cortex-debug', request: o.request || 'launch', servertype: server,
    cwd: o.cwd, executable: o.elf
  };
  if (server === 'openocd') {
    c.configFiles = [o.interfaceCfg || 'interface/stlink.cfg', o.targetCfg];
    if (o.speedKHz) c.openOCDLaunchCommands = [`adapter speed ${o.speedKHz}`];
    if (o.serial) c.openOCDPreConfigLaunchCommands = [`adapter serial ${o.serial}`];
  }
  if (server === 'pyocd') c.targetId = partName(o.mcuName).toLowerCase();
  if (server === 'jlink') { c.device = partName(o.mcuName); c.interface = 'swd'; }
  if ((server === 'stlink' || server === 'jlink') && o.serial) c.serialNumber = o.serial;
  if (o.request !== 'attach') {
    // "Reset'te dur": başlatmada ve her Reset'te Reset_Handler'da durur; değilse main'e kadar çalışır
    if (o.haltOnReset) c.breakAfterReset = true;
    else c.runToEntryPoint = 'main';
  }
  if (o.svd) c.svdFile = o.svd;
  // ES-303: bootloader açıkken karta bootloader + uygulama yüklenir; semboller uygulama ELF'inden
  if (o.loadFiles && o.request !== 'attach') c.loadFiles = o.loadFiles;
  if (o.rtos) c.rtos = server === 'jlink' ? 'FreeRTOS' : server === 'openocd' ? 'auto' : undefined;
  if (o.toolchainPath) c.armToolchainPath = o.toolchainPath;
  // ES-208: SWO ve RTT konsolu. Kapalı gelir: firmware ITM/RTT'ye yazıyorsa "enabled" true yapılır
  // (Embedded Studio'nun Debug > Konsol paneli de aynı çıkışı okur; prob aynı anda tek oturuma bağlanır).
  if (o.cpuHz && o.swo !== false && server !== 'pyocd') {
    c.swoConfig = { enabled: false, cpuFrequency: o.cpuHz, swoFrequency: 2000000, source: 'probe', decoders: [{ type: 'console', label: 'ITM', port: 0 }] };
  }
  if (o.cpuHz) c.rttConfig = { enabled: false, address: 'auto', decoders: [{ label: 'RTT', port: 0, type: 'console' }] };
  if (o.preLaunchTask) c.preLaunchTask = o.preLaunchTask;
  for (const k of Object.keys(c)) if (c[k] === undefined) delete c[k];
  return c;
}

/**
 * launch.json'a yazılacak yapılandırmalar: seçilen sunucu için başlat, reset'te dur ve bağlan (attach).
 * @param {Parameters<typeof cortexConfig>[0] & { project: string }} o
 */
function launchConfigs(o) {
  const srv = SERVERS[o.server || 'openocd'].label;
  const base = `${o.project} (${srv})`;
  return [
    cortexConfig({ ...o, name: t('Debug: {0}', base) }),
    cortexConfig({ ...o, name: t('Debug, reset\'te dur: {0}', base), haltOnReset: true }),
    cortexConfig({ ...o, name: t('Bağlan (attach): {0}', base), request: 'attach', preLaunchTask: undefined })
  ];
}

/** JSONC (yorum ve sondaki virgül) → nesne. Hatalıysa null. */
function parseJsonc(text) {
  if (!text || !text.trim()) return {};
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const ch = text[i], nx = text[i + 1];
    if (str) {
      out += ch;
      if (ch === '\\') { out += nx || ''; i += 2; continue; }
      if (ch === '"') str = false;
      i++;
    } else if (ch === '"') { str = true; out += ch; i++; }
    else if (ch === '/' && nx === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (ch === '/' && nx === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; }
    else { out += ch; i++; }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
  } catch {
    return null;
  }
}

/**
 * Mevcut dosyaya yapılandırmaları ekler: aynı adlı olanları değiştirir, kullanıcınınkileri korur.
 * @param {string} text mevcut içerik (yoksa '') @param {'configurations'|'tasks'} key @param {any[]} items
 * @param {string} version @param {{ keep?: boolean }} [opt] keep: aynı adlı öğe varsa dokunma (kullanıcı değiştirmiş olabilir)
 * @returns {{ text: string, added: number, replaced: number } | null} null: dosya bozuk
 */
function mergeJsonList(text, key, items, version, opt = {}) {
  const doc = parseJsonc(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const list = Array.isArray(doc[key]) ? doc[key] : [];
  const nameOf = (x) => (key === 'tasks' ? x.label : x.name);
  let replaced = 0;
  for (const it of items) {
    const i = list.findIndex((x) => x && nameOf(x) === nameOf(it));
    if (i >= 0) { if (!opt.keep) list[i] = it; replaced++; } else list.push(it);
  }
  return { text: JSON.stringify({ version: doc.version || version, ...doc, [key]: list }, null, 2) + '\n', added: items.length - replaced, replaced };
}

/** Kod üreticinin tasks.json'a yazdığı derleme görevinin adı (Debug varsayılan) */
const buildTaskLabel = (type) => `Embedded Studio: Derle${type === 'Debug' ? '' : ` (${type})`}`;

/** preLaunchTask için derleme görevi (tasks.json) */
function buildTask(label, command, cwd = '${workspaceFolder}') {
  return {
    label, type: 'shell', command, options: { cwd },
    // PowerShell 5'te && yok
    windows: { options: { cwd, shell: { executable: 'cmd.exe', args: ['/d', '/c'] } } },
    group: 'build', problemMatcher: ['$gcc'], presentation: { reveal: 'always', clear: true }
  };
}

/**
 * Projedeki etkin breakpoint'lerin donanım sınırını aşıp aşmadığı. Adım adım çalıştırma ve run to cursor geçici olarak
 * bir karşılaştırıcı daha kullanır; bu yüzden sınır dolduğunda da uyarılır.
 * @param {{ enabled: boolean, kind: 'source'|'function'|'instruction'|'data' }[]} bps @param {string} core
 * @returns {{ used: number, limit: number, level: 'ok'|'full'|'over' }}
 */
function breakpointUsage(bps, core) {
  const used = bps.filter((b) => b.enabled && b.kind !== 'data').length;
  const limit = hwBreakpointLimit(core);
  return { used, limit, level: used > limit ? 'over' : used === limit ? 'full' : 'ok' };
}

/** Kaynakla karışık disassembly listesi için objdump argümanları */
const disassemblyArgs = (elf) => ['-d', '-S', '-C', '-l', '--no-show-raw-insn', '-w', elf];

module.exports = { cortexConfig, launchConfigs, parseJsonc, mergeJsonList, buildTask, buildTaskLabel, breakpointUsage, hwBreakpointLimit, partName, disassemblyArgs, SERVERS, HW_BREAKPOINTS };
