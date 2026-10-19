// ES-1002: işlemci tanımlarına paket ve bütün fiziksel pinleri ekler (data/mcus/<id>.json → "package").
//
//   node tools/mcu/gen-package.js <STM32_open_pin_data klasörü> [id,id,...]
//
// Pin atayıcının kullandığı "pins" (kartta çıkan GPIO'lar ve desteklenen sinyaller) ve diğer alanlara dokunulmaz;
// yalnızca "package" ve "boardPins" yazılır. Kaynak: https://github.com/STMicroelectronics/STM32_open_pin_data
// (BSD-3-Clause, © STMicroelectronics). Pin konumu ve türü <mcu>.xml'den, AF numaraları GPIO-*_Modes.xml'den.
// 5 V toleransı (FT/TT) bu veritabanında yok: datasheet'teki pin tablosundan gelir, burada tutulmaz.
const fs = require('fs');
const path = require('path');
const targets = require('./targets');
const { family } = require('../../src/codegen/families');

const [pinData] = process.argv.slice(2);
if (!pinData) {
  console.error('Kullanım: node tools/mcu/gen-package.js <STM32_open_pin_data> [id,id,...]');
  process.exit(1);
}
const out = path.join(__dirname, '..', '..', 'data', 'mcus');
const only = process.argv[3] ? new Set(process.argv[3].split(',')) : null;

const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
const gpioOf = (n) => (n.match(/^P[A-K]\d{1,2}/) || [])[0];

/** Paket adı → tür ve pin sayısı. BGA / WLCSP'de konumlar ızgara (A1, B2 …). */
function packageInfo(name) {
  const kind = (name.match(/^[A-Z]+/) || [''])[0];
  return {
    name,
    type: kind,
    pinCount: Number((name.match(/\d+/) || [0])[0]),
    grid: /BGA|WLCSP/.test(kind),
    // Kenarlarda pin olan paketler (LQFP, QFN, TSSOP, SO): kaç kenar
    sides: /QFP|QFN/.test(kind) ? 4 : /SSOP|SO/.test(kind) ? 2 : 0
  };
}

const TYPES = { 'I/O': 'io', Power: 'power', Reset: 'reset', Boot: 'boot', MonoIO: 'mono', NC: 'nc' };

/** GPIO modes XML: pin → sinyal → { af } (v2) ya da { remap } (F1: varsayılan dışı remap) */
function parseGpioModes(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const map = new Map();
  for (const m of xml.matchAll(/<GPIO_Pin\b([^>]*)>([\s\S]*?)<\/GPIO_Pin>/g)) {
    const pin = gpioOf(attr(m[1], 'Name') || '');
    if (!pin) continue;
    const sigs = map.get(pin) || new Map();
    for (const s of m[2].matchAll(/<PinSignal\b[^>]*Name="([^"]*)"[^>]*>([\s\S]*?)<\/PinSignal>/g)) {
      const af = (s[2].match(/GPIO_AF(\d+)_/) || [])[1];
      sigs.set(s[1], { af: af !== undefined ? Number(af) : undefined, defaultRemap: /DefaultRemap="true"/.test(s[2]), remap: /RemapBlock/.test(s[2]) });
    }
    map.set(pin, sigs);
  }
  return map;
}

/**
 * <mcu>.xml → paket. Her pin: konum, ad (veritabanındaki gibi, ör. "PC14-OSC32_IN"), GPIO adı, tür, GPIO modları ve bütün sinyaller.
 * @returns {{ package: any, ips: string[] }}
 */
function buildPackage(xml, modes, gpioVersion) {
  const root = (xml.match(/<Mcu\b[^>]*>/) || [''])[0];
  const pkg = packageInfo(attr(root, 'Package') || '');
  const pins = [];
  for (const m of xml.matchAll(/<Pin\b([^>]*?)(\/>|>([\s\S]*?)<\/Pin>)/g)) {
    const raw = attr(m[1], 'Name');
    const type = TYPES[attr(m[1], 'Type')] || 'other';
    const pin = { pos: attr(m[1], 'Position'), name: raw, type };
    const gpio = type === 'io' ? gpioOf(raw) : null;
    if (gpio) pin.gpio = gpio;
    const gp = (gpio && modes.get(gpio)) || new Map();
    const signals = [];
    for (const s of (m[3] || '').matchAll(/<Signal\b([^>]*)\/?>/g)) {
      const name = attr(s[1], 'Name');
      if (name === 'GPIO') {
        // U5: GPIO ve LPGPIO modları ayrı Signal girdileri; birleştirilir
        pin.modes = [...new Set([...(pin.modes || []), ...(attr(s[1], 'IOModes') || '').split(',').filter(Boolean)])];
        continue;
      }
      const g = gp.get(name);
      const sig = { signal: name };
      if (g && gpioVersion !== 'v1' && g.af !== undefined) sig.af = g.af;
      if (g && gpioVersion === 'v1' && !g.defaultRemap && g.remap) sig.remap = true;
      signals.push(sig);
    }
    if (signals.length) pin.signals = signals;
    pins.push(pin);
  }
  // Konum sırası: sayısal (QFP) ya da satır-sütun (BGA: A1, A2 … B1)
  const key = (p) => (/^\d+$/.test(p.pos) ? [0, Number(p.pos), 0] : [1, p.pos.charCodeAt(0), Number(p.pos.slice(1))]);
  pins.sort((a, b) => { const x = key(a), y = key(b); return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]; });
  // Aynı pedi paylaşan girdiler (G0: "PA11 [PA9]" / "PA9 [PA11]" SYSCFG ile yeniden eşleme, UCPD_DBCC ile PA9):
  // pedin asıl girdisi, GPIO'su başka bir konumda olmayan I/O; diğerleri alt: true (çizimde aynı kutuda seçenek)
  const gpioCount = new Map();
  for (const p of pins) if (p.gpio) gpioCount.set(p.gpio, (gpioCount.get(p.gpio) || 0) + 1);
  const byPos = new Map();
  for (const p of pins) byPos.set(p.pos, [...(byPos.get(p.pos) || []), p]);
  for (const group of byPos.values()) {
    if (group.length < 2) continue;
    const main = group.find((p) => p.type === 'io' && gpioCount.get(p.gpio) === 1) || group.find((p) => p.type === 'io') || group[0];
    for (const p of group) if (p !== main) p.alt = true;
  }
  if (!pkg.pinCount) pkg.pinCount = byPos.size;
  return { ...pkg, pins };
}

let made = 0;
for (const tg of targets) {
  if (only && !only.has(tg.id)) continue;
  const file = path.join(out, `${tg.id}.json`);
  const mcu = JSON.parse(fs.readFileSync(file, 'utf8'));
  const xml = fs.readFileSync(path.join(pinData, 'mcu', `${tg.ref}.xml`), 'utf8');
  const gpioIp = [...xml.matchAll(/<IP\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, 'Name') === 'GPIO');
  const modes = parseGpioModes(path.join(pinData, 'mcu', 'IP', `GPIO-${attr(gpioIp, 'Version')}_Modes.xml`));
  const pkg = buildPackage(xml, modes, family(tg.family).ip.gpio);
  // Denetim: pin atayıcının pinleri pakette olmalı, AF numaraları tutmalı
  const byGpio = new Map(pkg.pins.filter((p) => p.gpio && !p.alt).map((p) => [p.gpio, p]));
  const bad = [];
  if (pkg.pins.filter((p) => !p.alt).length !== pkg.pinCount) bad.push(`paket ${pkg.pinCount} pinli, ${pkg.pins.filter((p) => !p.alt).length} ped bulundu`);
  for (const p of mcu.pins) {
    const q = byGpio.get(p.name);
    if (!q) { bad.push(`${p.name} pakette yok`); continue; }
    for (const f of p.functions) {
      if (f.af === undefined) continue;
      const hit = (q.signals || []).find((s) => s.af === f.af && (s.signal === f.signal || s.signal.replace(/^ADC\d*_INP?/, 'ADC1_IN') === f.signal));
      if (!hit) bad.push(`${p.name}:${f.signal} AF${f.af} pakette yok`);
    }
  }
  if (bad.length) {
    console.log(`${tg.id.padEnd(16)} UYUŞMAZLIK\n  ${bad.join('\n  ')}`);
    process.exitCode = 1;
    continue;
  }
  // Kart verisi ayrı: hangi pin kartta neye bağlı (pin atayıcı "note" alanını da kullanmaya devam eder)
  const boardPins = Object.fromEntries(mcu.pins.filter((p) => p.note).map((p) => [p.name, p.note]));
  const next = {};
  for (const [k, v] of Object.entries(mcu)) {
    if (k === 'package' || k === 'boardPins') continue;
    next[k] = v;
    if (k === 'pins') { next.package = pkg; next.boardPins = boardPins; }
  }
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  const io = pkg.pins.filter((p) => p.type === 'io').length;
  console.log(`${tg.id.padEnd(16)} ${pkg.name.padEnd(9)} ${String(pkg.pins.length).padStart(3)} pin (${io} I/O), ${pkg.pins.reduce((s, p) => s + (p.signals || []).length, 0)} sinyal`);
  made++;
}
console.log(`${made} işlemci güncellendi`);
