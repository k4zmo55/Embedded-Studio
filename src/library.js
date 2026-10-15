// @ts-check
const fs = require('fs');
const path = require('path');

/**
 * Komponent kütüphanesi:
 *  - Yerleşik: <eklenti>/data/components/*.json
 *  - Kullanıcı: <proje>/.embedded-studio/components/*.json (Kütüphane > Ekle ile yüklenenler)
 * Aynı id'li kullanıcı komponenti yerleşik olanı ezer.
 */
const USER_DIR = path.join('.embedded-studio', 'components');
const ROLES = ['power', 'ground', 'i2c.SCL', 'i2c.SDA', 'spi.SCK', 'spi.MISO', 'spi.MOSI', 'spi.CS', 'uart.TX', 'uart.RX', 'gpio.out', 'gpio.in', 'adc', 'pwm'];
const INTERFACES = ['i2c', 'spi', 'uart', 'gpio', 'adc', 'pwm'];

function readJsonDir(dir, source) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      c.source = source;
      c.file = path.join(dir, f);
      out.push(c);
    } catch (e) {
      console.warn(`Embedded Studio: ${f} okunamadı: ${e.message}`);
    }
  }
  return out;
}

/** @param {string} extRoot eklenti kökü @param {string} [projectRoot] açık proje */
function loadLibrary(extRoot, projectRoot) {
  const mcus = readJsonDir(path.join(extRoot, 'data', 'mcus'), 'builtin');
  const components = readJsonDir(path.join(extRoot, 'data', 'components'), 'builtin');
  if (projectRoot) {
    for (const c of readJsonDir(path.join(projectRoot, USER_DIR), 'user')) {
      if (validateComponent(c).length === 0) {
        const i = components.findIndex((x) => x.id === c.id);
        if (i >= 0) components.splice(i, 1);
        components.push(c);
      }
    }
  }
  return {
    mcus: Object.fromEntries(mcus.map((m) => [m.id, m])),
    components: Object.fromEntries(components.map((c) => [c.id, c]))
  };
}

/** Komponent tanımını doğrular; hata listesi döner (boş = geçerli). */
function validateComponent(c) {
  const e = [];
  if (!c || typeof c !== 'object') return ['JSON nesnesi değil.'];
  if (!/^[a-z0-9_]+$/.test(c.id || '')) e.push('"id" küçük harf, rakam ve _ içermeli (ör. "bmp180").');
  if (!c.name) e.push('"name" eksik.');
  if (!INTERFACES.includes(c.interface)) e.push(`"interface" şunlardan biri olmalı: ${INTERFACES.join(', ')}.`);
  if (!Array.isArray(c.pins) || !c.pins.length) e.push('"pins" dizisi eksik.');
  else {
    for (const p of c.pins) {
      if (!p.name) e.push('Her pinin "name" alanı olmalı.');
      if (!ROLES.includes(p.role)) e.push(`Pin ${p.name}: "role" geçersiz (${p.role}). Geçerli: ${ROLES.join(', ')}.`);
    }
  }
  if (c.interface === 'i2c' && !(c.i2c && /^0x[0-9a-fA-F]{2}$/.test(c.i2c.address || ''))) e.push('I2C komponenti için "i2c.address" (ör. "0x77") gerekli.');
  if (c.i2c && (c.i2c.altAddresses || []).some((a) => !/^0x[0-9a-fA-F]{2}$/.test(a))) e.push('Alternatif I2C adresleri 0x77 biçiminde olmalı.');
  if (c.interface === 'uart' && !(c.uart && c.uart.baud)) e.push('UART komponenti için "uart.baud" gerekli.');
  if (c.interface === 'spi' && !(c.spi && c.spi.maxSpeedHz)) e.push('SPI komponenti için "spi.maxSpeedHz" gerekli.');
  if (!Array.isArray(c.pins)) return e;

  // Pin tutarlılığı
  const names = c.pins.map((p) => p.name);
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) e.push(`Pin adı tekrar ediyor: ${[...new Set(dup)].join(', ')}.`);
  const roles = c.pins.map((p) => p.role);
  const need = {
    i2c: [['i2c.SCL'], ['i2c.SDA']],
    spi: [['spi.SCK'], ['spi.MOSI', 'spi.MISO']],
    uart: [['uart.TX', 'uart.RX']],
    adc: [['adc']],
    pwm: [['pwm']],
    gpio: [['gpio.in', 'gpio.out']]
  }[c.interface] || [];
  for (const any of need) {
    if (!any.some((r) => roles.includes(r))) e.push(`${String(c.interface).toUpperCase()} arayüzü için şu rollerden en az biri olan bir pin gerekli: ${any.join(' / ')}.`);
  }
  const single = ['i2c.SCL', 'i2c.SDA', 'spi.SCK', 'spi.MISO', 'spi.MOSI', 'spi.CS', 'uart.TX', 'uart.RX'];
  for (const r of single) if (roles.filter((x) => x === r).length > 1) e.push(`"${r}" rolü sadece bir pinde olabilir.`);

  // Ölçümler ve monitör
  const tel = Array.isArray(c.telemetry) ? c.telemetry : [];
  const ids = tel.map((t) => t.id);
  for (const t of tel) if (!/^[a-z][a-z0-9_]*$/.test(t.id || '')) e.push(`Ölçüm adı "${t.id || ''}" geçersiz: küçük harfle başlamalı, harf/rakam/_ içermeli (ör. "temp").`);
  if (ids.some((x, i) => ids.indexOf(x) !== i)) e.push('Ölçüm adları benzersiz olmalı.');
  for (const w of Array.isArray(c.monitor) ? c.monitor : []) {
    const bad = (w.channels || []).filter((ch) => !ids.includes(ch));
    if (!(w.channels || []).length) e.push(`Monitör widget'ı (${w.type}) en az bir ölçüme bağlanmalı.`);
    if (bad.length) e.push(`Monitör widget'ı tanımsız ölçüme bağlı: ${bad.join(', ')}.`);
  }
  if (c.sampleMs !== undefined && !(Number(c.sampleMs) >= 0)) e.push('"sampleMs" 0 veya pozitif olmalı.');
  return e;
}

/** Yeni komponent için örnek şablon (kullanıcı doldurur). */
function componentTemplate() {
  return {
    id: 'bmp180',
    name: 'BMP180',
    category: 'Sensör',
    description: 'Basınç ve sıcaklık sensörü (örnek şablon, kendi komponentinize göre düzenleyin).',
    keywords: ['basınç', 'barometre', 'pressure'],
    interface: 'i2c',
    voltage: { min: 1.8, max: 3.6 },
    i2c: { address: '0x77', altAddresses: [], maxSpeedHz: 400000, onboardPullups: true },
    sampleMs: 1000,
    datasheet: 'https://.../bmp180.pdf',
    image: 'Görsel için: proje klasörüne göre yol (ör. "images/bmp180.png") veya https adresi. Boş bırakılırsa çizim üretilir.',
    art: { board: '#1d4f91', chip: 'BMP180', chipShape: 'metal-lid' },
    pins: [
      { name: 'VCC', role: 'power' },
      { name: 'GND', role: 'ground' },
      { name: 'SCL', role: 'i2c.SCL' },
      { name: 'SDA', role: 'i2c.SDA' }
    ],
    telemetry: [{ id: 'press', unit: 'hPa', sim: { base: 1013, amp: 2, periodS: 60, noise: 0.1 } }],
    monitor: [{ type: 'gauge', channels: ['press'], min: 950, max: 1060 }],
    _roller: `Geçerli pin rolleri: ${ROLES.join(', ')}`
  };
}

module.exports = { loadLibrary, validateComponent, componentTemplate, USER_DIR, ROLES };
