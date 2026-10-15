// @ts-check
/**
 * Asistan katmanı.
 *
 * Şu an kural tabanlı çalışıyor: tasarımı analiz edip açıklama ve uyarı üretir,
 * doğal dil isteğinden komponent önerir. Sonraki adımda `LlmProvider` arayüzü
 * üzerinden gerçek bir LLM (tool use + datasheet RAG) bağlanacak. LLM önerileri
 * de yine pinAssigner tarafından doğrulanacak.
 */
const { rtosPlan } = require('../codegen/generator');
const { t } = require('../i18n');

/**
 * @typedef {{ components: string[], reply: string }} Suggestion
 * @typedef {{ suggest(text: string, lib: any): Promise<Suggestion> }} LlmProvider
 */

/** Tasarım + atama sonucundan mühendislik notları üretir. */
function analyze(design, lib, result) {
  const mcu = lib.mcus[design.mcuId];
  /** @type {{ level: 'info'|'warn'|'error', text: string }[]} */
  const notes = [];
  const label = (id) => design.instances.find((i) => i.id === id)?.label ?? id;

  for (const [name, p] of Object.entries(result.peripherals)) {
    if (p.type === 'i2c') {
      const members = p.members.map((id) => design.instances.find((i) => i.id === id)).filter(Boolean);
      const noPullup = members.filter((m) => !lib.components[m.componentId].i2c.onboardPullups);
      notes.push({
        level: noPullup.length ? 'warn' : 'info',
        text: `${name} (${p.pins.SCL}/${p.pins.SDA}, ${p.speedHz / 1000} kHz): ${members.map((m) => `${m.label}@${result.addresses[m.id]}`).join(', ')}. ` +
          (noPullup.length ? t('Hatta 4.7 kΩ pull-up direnci ekleyin.') : t('Modüllerde pull-up var; birden çok modülde paralel pull-up değeri düşebilir, gerekirse birini sökün.'))
      });
    }
    if (p.type === 'spi') {
      notes.push({ level: 'info', text: t('{0} (SCK {1}): {2}. Her cihazın kendi CS hattı GPIO olarak atandı.', name, p.pins.SCK, p.members.map(label).join(', ')) });
    }
    if (p.type === 'uart') {
      notes.push({ level: 'info', text: t('{0} (TX {1}, RX {2}) @ {3} baud → {4}. TX↔RX çapraz bağlandı.', name, p.pins.TX ?? '-', p.pins.RX ?? '-', p.baud, p.members.map(label).join(', ')) });
    }
    if (p.type === 'pwm') {
      notes.push({ level: 'info', text: `${name} PWM @ ${p.frequencyHz} Hz: ${p.channels.map((c) => `${c.channel}→${c.pin}`).join(', ')}.` });
    }
  }

  for (const pw of result.power) {
    if (pw.net === '5V') {
      notes.push({ level: 'warn', text: t('{0} 5V besleme istiyor. Beslemeyi 5V\'tan alın; sinyal hattı 3.3V, çoğu modül için yeterli ama datasheet\'i kontrol edin.', label(pw.instId)) });
    }
  }

  if (!Object.values(result.peripherals).some((p) => p.telemetry)) {
    notes.push({ level: 'warn', text: t('Telemetri hattı yok. Canlı izleme için "USB-UART" komponentini ekleyin.') });
  }

  const sensors = design.instances.filter((i) => (lib.components[i.componentId]?.sampleMs ?? 0) > 0);
  const rates = new Set(sensors.map((i) => lib.components[i.componentId].sampleMs));
  if (!design.rtos && rates.size >= 3) {
    notes.push({ level: 'info', text: t('{0} farklı örnekleme periyodu var. FreeRTOS ile her sensörü ayrı task\'ta çalıştırmak zamanlamayı sadeleştirir.', rates.size) });
  }
  if (design.rtos) {
    const plan = rtosPlan(design, lib);
    const prios = plan.tasks.map((x) => `${x.name}(${x.periodMs}ms→P${x.priority})`).join(', ');
    notes.push({ level: 'info', text: t('FreeRTOS: {0} uygulama task\'ı + Monitor. Rate-monotonic öncelik: {1}. Heap {2} byte ({3} KB RAM mevcut). Paylaşılan I2C/SPI bus\'ları mutex ile korunuyor.', plan.tasks.length, prios || '-', plan.heapBytes, mcu.ramKB) });
  }

  const free = mcu.pins.filter((p) => !p.reserved && !result.pinUsage[p.name]).length;
  notes.push({ level: 'info', text: t('{0}: {1} pin kullanımda/rezerve, {2} boş pin. SWD (PA13/PA14) programlama için ayrıldı.', mcu.name, Object.keys(result.pinUsage).length, free) });

  return notes;
}

/** Basit anahtar kelime eşleştirme ile doğal dil isteğinden komponent önerir. */
function suggestFromText(text, lib) {
  // Türkçe (İ/ı) ve İngilizce küçük harf dönüşümünün ikisine de bak: "IMU" → "imu" ve "ımu"
  const qs = [text.toLocaleLowerCase('tr'), text.toLowerCase()];
  const hits = Object.values(lib.components)
    .map((c) => ({ c, n: c.keywords.filter((k) => qs.some((q) => q.includes(k))).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.c);
  if (!hits.length) {
    return { components: [], reply: t('Bu istekle eşleşen bir komponent bulamadım. "sıcaklık", "ivme", "ekran", "gps", "servo" gibi ifadeler deneyin.') };
  }
  const ids = hits.map((c) => c.id);
  if (!ids.includes('usb_uart')) ids.push('usb_uart');
  const names = ids.map((id) => (lib.components[id].source === 'user' ? lib.components[id].name : t(lib.components[id].name))).join(', ');
  return { components: ids, reply: t('Önerim: {0}. Test sonuçlarını izleyebilmeniz için USB-UART telemetri hattını da ekledim.', names) };
}

/** @type {LlmProvider} */
const ruleBasedProvider = {
  async suggest(text, lib) {
    return suggestFromText(text, lib);
  }
};

module.exports = { analyze, suggestFromText, ruleBasedProvider };
