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
        text: `${name} (${p.pins.SCL}/${p.pins.SDA}, ${p.speedHz / 1000} kHz): ${members.map((m) => `${m.label}@${result.addresses[m.id]}`).join(', ')}.` +
          (noPullup.length ? ' Hatta 4.7 kΩ pull-up direnci ekleyin.' : ' Modüllerde pull-up var; birden çok modülde paralel pull-up değeri düşebilir, gerekirse birini sökün.')
      });
    }
    if (p.type === 'spi') {
      notes.push({ level: 'info', text: `${name} (SCK ${p.pins.SCK}): ${p.members.map(label).join(', ')}. Her cihazın kendi CS hattı GPIO olarak atandı.` });
    }
    if (p.type === 'uart') {
      notes.push({ level: 'info', text: `${name} (TX ${p.pins.TX ?? '-'}, RX ${p.pins.RX ?? '-'}) @ ${p.baud} baud → ${p.members.map(label).join(', ')}. TX↔RX çapraz bağlandı.` });
    }
    if (p.type === 'pwm') {
      notes.push({ level: 'info', text: `${name} PWM @ ${p.frequencyHz} Hz: ${p.channels.map((c) => `${c.channel}→${c.pin}`).join(', ')}.` });
    }
  }

  for (const pw of result.power) {
    if (pw.net === '5V') {
      notes.push({ level: 'warn', text: `${label(pw.instId)} 5V besleme istiyor. Beslemeyi 5V'tan alın; sinyal hattı 3.3V, çoğu modül için yeterli ama datasheet'i kontrol edin.` });
    }
  }

  if (!Object.values(result.peripherals).some((p) => p.telemetry)) {
    notes.push({ level: 'warn', text: 'Telemetri hattı yok. Canlı izleme için "USB-UART" komponentini ekleyin.' });
  }

  const sensors = design.instances.filter((i) => (lib.components[i.componentId]?.sampleMs ?? 0) > 0);
  const rates = new Set(sensors.map((i) => lib.components[i.componentId].sampleMs));
  if (!design.rtos && rates.size >= 3) {
    notes.push({ level: 'info', text: `${rates.size} farklı örnekleme periyodu var. FreeRTOS ile her sensörü ayrı task'ta çalıştırmak zamanlamayı sadeleştirir.` });
  }
  if (design.rtos) {
    const plan = rtosPlan(design, lib);
    const prios = plan.tasks.map((t) => `${t.name}(${t.periodMs}ms→P${t.priority})`).join(', ');
    notes.push({ level: 'info', text: `FreeRTOS: ${plan.tasks.length} uygulama task'ı + Monitor. Rate-monotonic öncelik: ${prios || '-'}. Heap ${plan.heapBytes} byte (${mcu.ramKB} KB RAM mevcut). Paylaşılan I2C/SPI bus'ları mutex ile korunuyor.` });
  }

  const free = mcu.pins.filter((p) => !p.reserved && !result.pinUsage[p.name]).length;
  notes.push({ level: 'info', text: `${mcu.name}: ${Object.keys(result.pinUsage).length} pin kullanımda/rezerve, ${free} boş pin. SWD (PA13/PA14) programlama için ayrıldı.` });

  return notes;
}

/** Basit anahtar kelime eşleştirme ile doğal dil isteğinden komponent önerir. */
function suggestFromText(text, lib) {
  const t = text.toLocaleLowerCase('tr');
  const hits = Object.values(lib.components)
    .map((c) => ({ c, n: c.keywords.filter((k) => t.includes(k)).length }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n)
    .map((x) => x.c);
  if (!hits.length) {
    return { components: [], reply: 'Bu istekle eşleşen bir komponent bulamadım. "sıcaklık", "ivme", "ekran", "gps", "servo" gibi ifadeler deneyin.' };
  }
  const ids = hits.map((c) => c.id);
  if (!ids.includes('usb_uart')) ids.push('usb_uart');
  const names = ids.map((id) => lib.components[id].name).join(', ');
  return { components: ids, reply: `Önerim: ${names}. Test sonuçlarını izleyebilmeniz için USB-UART telemetri hattını da ekledim.` };
}

/** @type {LlmProvider} */
const ruleBasedProvider = {
  async suggest(text, lib) {
    return suggestFromText(text, lib);
  }
};

module.exports = { analyze, suggestFromText, ruleBasedProvider };
