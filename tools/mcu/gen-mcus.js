// İşlemci tanımlarını üretir: data/mcus/<id>.json
//
//   node tools/mcu/gen-mcus.js <STM32_open_pin_data klasörü> <CMSIS cihaz depoları klasörü>
//
// Pin/AF verisi: https://github.com/STMicroelectronics/STM32_open_pin_data (BSD-3-Clause, © STMicroelectronics)
// CMSIS başlıkları: https://github.com/STMicroelectronics/cmsis-device-<aile> (saat açma bitleri, kesme adları)
// Elle girilen bilgiler (kart, saat ağacı): tools/mcu/targets.js
const fs = require('fs');
const path = require('path');
const targets = require('./targets');
const { family } = require('../../src/codegen/families');

const [pinData, cmsisRoot] = process.argv.slice(2);
if (!pinData || !cmsisRoot) {
  console.error('Kullanım: node tools/mcu/gen-mcus.js <STM32_open_pin_data> <cmsis-device-* klasörlerinin üstü>');
  process.exit(1);
}
const out = path.join(__dirname, '..', '..', 'data', 'mcus');
const only = process.argv[4] ? new Set(process.argv[4].split(',')) : null;

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const pinBase = (n) => (n.match(/^P[A-K]\d{1,2}/) || [])[0];

/** Desteklenen sinyaller: I2C, SPI, U(S)ART, ADC1 kanalları, timer PWM kanalları (tamamlayıcı CHxN hariç). */
function normalize(signal) {
  let m;
  if ((m = /^(I2C\d)_(SCL|SDA)$/.exec(signal))) return { signal, type: 'i2c', periph: m[1] };
  if ((m = /^(SPI\d)_(SCK|MISO|MOSI)$/.exec(signal))) return { signal, type: 'spi', periph: m[1] };
  if ((m = /^((?:USART|UART)\d+)_(TX|RX)$/.exec(signal))) return { signal, type: 'uart', periph: m[1] };
  if ((m = /^(TIM\d+)_(CH[1-4])$/.exec(signal))) return { signal, type: 'pwm', periph: m[1] };
  // ADC_IN0 (F0/G0), ADC1_IN5, ADC12_IN5, ADC123_IN5, ADC1_INP16 (H7). Sadece ADC1 kanalları.
  if ((m = /^ADC(\d*)_INP?(\d+)$/.exec(signal)) && (m[1] === '' || m[1][0] === '1')) return { signal: `ADC1_IN${m[2]}`, type: 'adc', periph: 'ADC1', analog: true };
  return null;
}

function parseMcuXml(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const ips = [...xml.matchAll(/<IP\b[^>]*>/g)].map((m) => ({ instance: attr(m[0], 'InstanceName'), name: attr(m[0], 'Name'), version: attr(m[0], 'Version') }));
  const pins = [];
  for (const m of xml.matchAll(/<Pin\b([^>]*?)(\/>|>([\s\S]*?)<\/Pin>)/g)) {
    const name = attr(m[1], 'Name');
    if (attr(m[1], 'Type') !== 'I/O' || !pinBase(name)) continue;
    const signals = [...(m[3] || '').matchAll(/<Signal\b[^>]*Name="([^"]*)"/g)].map((s) => s[1]);
    pins.push({ raw: name, name: pinBase(name), position: Number(attr(m[1], 'Position')) || 0, signals });
  }
  return { ips, pins, core: (xml.match(/<Core>([^<]*)<\/Core>/) || [])[1] };
}

/** GPIO modes XML: pin → sinyal → AF numarası (v2) ya da varsayılan remap mi (F1). */
function parseGpioModes(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const m of xml.matchAll(/<GPIO_Pin\b([^>]*)>([\s\S]*?)<\/GPIO_Pin>/g)) {
    const pin = pinBase(attr(m[1], 'Name') || '');
    if (!pin) continue;
    const sigs = map.get(pin) || new Map();
    for (const s of m[2].matchAll(/<PinSignal\b[^>]*Name="([^"]*)"[^>]*>([\s\S]*?)<\/PinSignal>/g)) {
      const af = (s[2].match(/GPIO_AF(\d+)_/) || [])[1];
      const defaultRemap = /DefaultRemap="true"/.test(s[2]);
      sigs.set(s[1], { af: af !== undefined ? Number(af) : undefined, defaultRemap });
    }
    map.set(pin, sigs);
  }
  return map;
}

/** CMSIS başlığından saat açma register'ı/biti ve kesme adları. */
function parseHeader(file) {
  const h = fs.readFileSync(file, 'utf8');
  const enr = (names) => {
    for (const n of names) {
      const m = new RegExp(`#define\\s+RCC_(\\w+?)_${n}EN\\b`).exec(h);
      if (m) return { reg: m[1], bit: `RCC_${m[1]}_${n}EN` };
    }
    return null;
  };
  const irqs = [...h.matchAll(/^\s*(\w+)_IRQn\s*=/gm)].map((m) => m[1]);
  // U5 (TrustZone): #define USART1 USART1_NS
  const instance = (n) => new RegExp(`#define\\s+${n}\\s+(\\(\\(|${n}_NS\\b)`).test(h);
  /** USART3_4_LPUART1 → [USART3, USART4, LPUART1] */
  const irqFor = (periph) => irqs.find((name) => {
    const parts = name.split('_');
    let prefix = '';
    const covered = [];
    for (const p of parts) {
      const m = /^([A-Z]+)(\d+)$/.exec(p);
      if (m) { prefix = m[1]; covered.push(p); } else if (/^\d+$/.test(p) && prefix) covered.push(prefix + p);
    }
    return covered.includes(periph);
  });
  // ADC1'in ortak bloğu: ADC1_COMMON, ADC12_COMMON, ADC123_COMMON (ADC3_COMMON/ADC4_COMMON değil)
  /** ES-107 örnek sürücüleri için: sistem birimlerinin saat bitleri, örnek adları, EXTI kesmeleri */
  const ll = () => {
    const bit = (names) => { const e = enr(names); return e ? { reg: e.reg, bit: e.bit } : null; };
    const first = (names) => names.find(instance) || null;
    const dacInst = first(['DAC1', 'DAC']);
    return {
      syscfg: bit(['SYSCFG', 'SYSCFGCOMP']), afio: bit(['AFIO']), crc: bit(['CRC']), wwdg: bit(['WWDG', 'WWDG1']),
      dma1: bit(['DMA1']), dma2: bit(['DMA2']), dmamux: bit(['DMAMUX1']), gpdma: bit(['GPDMA1']),
      dac: dacInst ? { instance: dacInst, ...bit(['DAC1', 'DAC', 'DAC12']) } : null,
      iwdg: first(['IWDG', 'IWDG1']), wwdgInstance: first(['WWDG', 'WWDG1']),
      exti: [...h.matchAll(/^\s*(EXTI\d+(?:_\w+)?)_IRQn\s*=/gm)].map((m) => m[1])
    };
  };
  const common = [...h.matchAll(/#define\s+(ADC(\d*)_COMMON)\s+(\(\(|ADC\w*_COMMON_NS\b)/g)].find((m) => m[2][0] === '1')?.[1];
  return { enr, irqFor, instance, common, ll };
}

const busOf = (reg, fam) => {
  const bus = /^APB1|^APBENR/.test(reg) ? 'APB1' : /^APB2/.test(reg) ? 'APB2' : /^APB3/.test(reg) ? 'APB3' : /^APB4/.test(reg) ? 'APB4' : 'AHB';
  return fam.apbCount === 1 && bus.startsWith('APB') ? 'APB1' : bus;
};

/** Ailelere özgü çekirdek saatleri (sıfırlama değerleri): F0/F3 I2C → HSI, H7 SPI1-3 → PLL1Q. */
function kernel(famKey, periph) {
  if ((famKey === 'f0' || famKey === 'f3') && /^I2C/.test(periph)) return 'hsi';
  if (famKey === 'h7' && /^SPI[123]$/.test(periph)) return 'pllq';
  return undefined;
}

let made = 0;
for (const tg of targets) {
  if (only && !only.has(tg.id)) continue;
  const fam = family(tg.family);
  const xml = parseMcuXml(path.join(pinData, 'mcu', `${tg.ref}.xml`));
  const gpioIp = xml.ips.find((i) => i.name === 'GPIO');
  const modes = parseGpioModes(path.join(pinData, 'mcu', 'IP', `GPIO-${gpioIp.version}_Modes.xml`));
  const header = parseHeader(path.join(cmsisRoot, `cmsis-device-${tg.family}`, 'Include', `${tg.define.toLowerCase()}.h`));
  const hasIp = new Set(xml.ips.map((i) => i.instance));

  const peripherals = {};
  const addPeriph = (name, type) => {
    if (peripherals[name] !== undefined) return peripherals[name];
    const enr = header.enr(type === 'adc' ? ['ADC1', 'ADC', 'ADC12', 'ADC123'] : [name]);
    const ok = enr && header.instance(name) && (type === 'adc' || hasIp.has(name));
    if (!ok) return (peripherals[name] = null);
    const p = { type, bus: busOf(enr.reg, fam), enr: enr.reg, enrBit: enr.bit };
    if (type === 'uart') p.irq = header.irqFor(name);
    if (type === 'uart' && !p.irq) return (peripherals[name] = null);
    if (type === 'adc' && header.common) p.common = header.common;
    const k = kernel(tg.family, name);
    if (k) p.clock = k;
    return (peripherals[name] = p);
  };

  const seen = new Set();
  const pins = [];
  for (const pin of xml.pins.sort((a, b) => a.name.localeCompare(b.name, 'en', { numeric: true }))) {
    if (seen.has(pin.name)) continue;
    seen.add(pin.name);
    const gp = modes.get(pin.name) || new Map();
    const functions = [];
    for (const s of pin.signals) {
      const n = normalize(s);
      if (!n || functions.some((f) => f.signal === n.signal)) continue;
      if (!addPeriph(n.periph, n.type)) continue;
      if (n.analog) { functions.push({ signal: n.signal }); continue; }
      const g = gp.get(s);
      if (!g) continue;
      if (fam.ip.gpio === 'v1') { if (g.defaultRemap) functions.push({ signal: n.signal }); continue; }
      if (g.af === undefined) continue;
      functions.push({ signal: n.signal, af: g.af });
    }
    const entry = { name: pin.name, side: 'left', functions };
    const sig = pin.signals.join(' ');
    if (/SWDIO|JTMS/.test(sig) && pin.name === 'PA13') entry.reserved = 'SWD SWDIO';
    else if (/SWCLK|JTCK/.test(sig) && pin.name === 'PA14') entry.reserved = 'SWD SWCLK';
    else if (/RCC_OSC32_IN/.test(sig)) entry.reserved = 'LSE OSC32_IN';
    else if (/RCC_OSC32_OUT/.test(sig)) entry.reserved = 'LSE OSC32_OUT';
    else if (/RCC_OSC_IN\b/.test(sig) && tg.hse) entry.reserved = 'HSE OSC_IN';
    else if (/RCC_OSC_OUT\b/.test(sig) && tg.hse) entry.reserved = 'HSE OSC_OUT';
    else if (/NRST/.test(pin.raw)) entry.reserved = 'NRST';
    if (tg.pinNotes[pin.name] && !entry.reserved) entry.note = tg.pinNotes[pin.name];
    pins.push(entry);
  }
  pins.forEach((p, i) => { p.side = i < Math.ceil(pins.length / 2) ? 'left' : 'right'; });
  for (const k of Object.keys(peripherals)) if (!peripherals[k]) delete peripherals[k];
  // Pinlerde hiç kullanılmayan çevre birimini listeleme
  const used = new Set(pins.flatMap((p) => p.functions.map((f) => f.signal.split('_')[0])));
  for (const k of Object.keys(peripherals)) if (!used.has(k)) delete peripherals[k];
  const sorted = Object.fromEntries(Object.entries(peripherals).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));

  const osc = xml.pins.find((p) => p.signals.includes('RCC_OSC_IN'));
  const gpioEnr = header.enr(['GPIOA', 'IOPA']);
  const mcu = {
    id: tg.id,
    name: tg.name,
    board: tg.board,
    family: fam.series.replace('xx', ''),
    core: { 'cortex-m0': 'Cortex-M0', 'cortex-m0plus': 'Cortex-M0+', 'cortex-m3': 'Cortex-M3', 'cortex-m4': 'Cortex-M4F', 'cortex-m7': 'Cortex-M7F', 'cortex-m33': 'Cortex-M33F' }[fam.core],
    flashKB: tg.flashKB,
    ramKB: tg.ramKB,
    maxClockMHz: tg.maxClockMHz,
    voltage: 3.3,
    halHeader: fam.halHeader,
    source: 'STM32_open_pin_data (© STMicroelectronics, BSD-3-Clause) ve CMSIS cihaz başlıklarından tools/mcu/gen-mcus.js ile üretildi. Saat ağacı ve kart bilgisi tools/mcu/targets.js. Kartta doğrulanmadı: üretim öncesi datasheet ile kontrol edin.',
    peripherals: sorted,
    pins,
    datasheet: tg.datasheet,
    referenceManual: tg.referenceManual,
    svdUrl: tg.svdUrl,
    device: {
      define: tg.define,
      cmsisHeader: fam.cmsisHeader,
      startup: tg.startup,
      flashKB: tg.flashKB,
      ramKB: tg.ramKB,
      openocdTarget: fam.openocd,
      family: tg.family,
      oscPort: osc ? osc.name[1] : undefined,
      gpioEnr: gpioEnr ? { reg: gpioEnr.reg, bit: gpioEnr.bit.replace(/(GPIO|IOP)A/, '$1{P}') } : undefined,
      flash: tg.flash,
      ll: header.ll()
    },
    clock: tg.clock
  };
  if (tg.verifyOnly) {
    // Elle doğrulanmış tanımla karşılaştır: üretilen AF numaraları onunla çelişmemeli
    const ref = JSON.parse(fs.readFileSync(path.join(out, `${tg.id}.json`), 'utf8'));
    const gen = new Map(pins.flatMap((p) => p.functions.map((f) => [`${p.name}:${f.signal}`, f.af])));
    const bad = ref.pins.flatMap((p) => p.functions.filter((f) => gen.get(`${p.name}:${f.signal}`) !== f.af).map((f) => `${p.name}:${f.signal} el=${f.af} üretilen=${gen.get(`${p.name}:${f.signal}`)}`));
    console.log(`${tg.id.padEnd(16)} doğrulama: ${bad.length ? 'UYUŞMAZLIK\n  ' + bad.join('\n  ') : `${ref.pins.reduce((s, p) => s + p.functions.length, 0)} elle girilmiş fonksiyonun hepsi uyuşuyor`}`);
    if (bad.length) process.exitCode = 1;
    // Pinlere dokunmadan sadece örnek sürücülerin ihtiyaç duyduğu cihaz bilgilerini güncelle
    ref.device.flash = tg.flash;
    ref.device.ll = header.ll();
    ref.device.gpioEnr = ref.device.gpioEnr || mcu.device.gpioEnr;
    fs.writeFileSync(path.join(out, `${tg.id}.json`), JSON.stringify(ref, null, 2) + '\n');
    continue;
  }
  fs.writeFileSync(path.join(out, `${tg.id}.json`), JSON.stringify(mcu, null, 2) + '\n');
  const fnCount = pins.reduce((s, p) => s + p.functions.length, 0);
  console.log(`${tg.id.padEnd(16)} ${String(pins.length).padStart(3)} pin, ${String(fnCount).padStart(4)} fonksiyon, ${Object.keys(sorted).join(' ')}`);
  made++;
}
console.log(`${made} işlemci yazıldı → ${path.relative(process.cwd(), out)}`);
