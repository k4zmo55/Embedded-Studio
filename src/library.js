// @ts-check
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

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
      console.warn(t('Embedded Studio: {0} okunamadı: {1}', f, e.message));
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
  if (!c || typeof c !== 'object') return [t('JSON nesnesi değil.')];
  if (!/^[a-z0-9_]+$/.test(c.id || '')) e.push(t('"id" küçük harf, rakam ve _ içermeli (ör. "bmp180").'));
  if (!c.name) e.push(t('"name" eksik.'));
  if (!INTERFACES.includes(c.interface)) e.push(t('"interface" şunlardan biri olmalı: {0}.', INTERFACES.join(', ')));
  if (!Array.isArray(c.pins) || !c.pins.length) e.push(t('"pins" dizisi eksik.'));
  else {
    for (const p of c.pins) {
      if (!p.name) e.push(t('Her pinin "name" alanı olmalı.'));
      if (!ROLES.includes(p.role)) e.push(t('Pin {0}: "role" geçersiz ({1}). Geçerli: {2}.', p.name, p.role, ROLES.join(', ')));
    }
  }
  if (c.interface === 'i2c' && !(c.i2c && /^0x[0-9a-fA-F]{2}$/.test(c.i2c.address || ''))) e.push(t('I2C komponenti için "i2c.address" (ör. "0x77") gerekli.'));
  if (c.i2c && (c.i2c.altAddresses || []).some((a) => !/^0x[0-9a-fA-F]{2}$/.test(a))) e.push(t('Alternatif I2C adresleri 0x77 biçiminde olmalı.'));
  if (c.interface === 'uart' && !(c.uart && c.uart.baud)) e.push(t('UART komponenti için "uart.baud" gerekli.'));
  if (c.interface === 'spi' && !(c.spi && c.spi.maxSpeedHz)) e.push(t('SPI komponenti için "spi.maxSpeedHz" gerekli.'));
  if (!Array.isArray(c.pins)) return e;

  // Pin tutarlılığı
  const names = c.pins.map((p) => p.name);
  const dup = names.filter((n, i) => n && names.indexOf(n) !== i);
  if (dup.length) e.push(t('Pin adı tekrar ediyor: {0}.', [...new Set(dup)].join(', ')));
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
    if (!any.some((r) => roles.includes(r))) e.push(t('{0} arayüzü için şu rollerden en az biri olan bir pin gerekli: {1}.', String(c.interface).toUpperCase(), any.join(' / ')));
  }
  const single = ['i2c.SCL', 'i2c.SDA', 'spi.SCK', 'spi.MISO', 'spi.MOSI', 'spi.CS', 'uart.TX', 'uart.RX'];
  for (const r of single) if (roles.filter((x) => x === r).length > 1) e.push(t('"{0}" rolü sadece bir pinde olabilir.', r));

  // Ölçümler ve monitör
  const tel = Array.isArray(c.telemetry) ? c.telemetry : [];
  const ids = tel.map((m) => m.id);
  for (const m of tel) if (!/^[a-z][a-z0-9_]*$/.test(m.id || '')) e.push(t('Ölçüm adı "{0}" geçersiz: küçük harfle başlamalı, harf/rakam/_ içermeli (ör. "temp").', m.id || ''));
  if (ids.some((x, i) => ids.indexOf(x) !== i)) e.push(t('Ölçüm adları benzersiz olmalı.'));
  for (const w of Array.isArray(c.monitor) ? c.monitor : []) {
    const bad = (w.channels || []).filter((ch) => !ids.includes(ch));
    if (!(w.channels || []).length) e.push(t('Monitör widget\'ı ({0}) en az bir ölçüme bağlanmalı.', w.type));
    if (bad.length) e.push(t('Monitör widget\'ı tanımsız ölçüme bağlı: {0}.', bad.join(', ')));
  }
  if (c.sampleMs !== undefined && !(Number(c.sampleMs) >= 0)) e.push(t('"sampleMs" 0 veya pozitif olmalı.'));
  return e;
}

/** Yeni komponent için örnek şablon (kullanıcı doldurur). */
function componentTemplate() {
  return {
    id: 'bmp180',
    name: 'BMP180',
    category: t('Sensör'),
    description: t('Basınç ve sıcaklık sensörü (örnek şablon, kendi komponentinize göre düzenleyin).'),
    keywords: ['basınç', 'barometre', 'pressure'],
    interface: 'i2c',
    voltage: { min: 1.8, max: 3.6 },
    i2c: { address: '0x77', altAddresses: [], maxSpeedHz: 400000, onboardPullups: true },
    sampleMs: 1000,
    datasheet: 'https://.../bmp180.pdf',
    image: t('Görsel için: proje klasörüne göre yol (ör. "images/bmp180.png") veya https adresi. Boş bırakılırsa çizim üretilir.'),
    art: { board: '#1d4f91', chip: 'BMP180', chipShape: 'metal-lid' },
    pins: [
      { name: 'VCC', role: 'power' },
      { name: 'GND', role: 'ground' },
      { name: 'SCL', role: 'i2c.SCL' },
      { name: 'SDA', role: 'i2c.SDA' }
    ],
    telemetry: [{ id: 'press', unit: 'hPa', sim: { base: 1013, amp: 2, periodS: 60, noise: 0.1 } }],
    monitor: [{ type: 'gauge', channels: ['press'], min: 950, max: 1060 }],
    _roller: t('Geçerli pin rolleri: {0}', ROLES.join(', '))
  };
}

module.exports = { loadLibrary, validateComponent, componentTemplate, USER_DIR, ROLES };
