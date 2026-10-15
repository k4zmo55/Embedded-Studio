// @ts-check
/**
 * Kural tabanlı pin / çevre birimi atama motoru.
 *
 * Yapay zekâ katmanı öneri yapar, bu modül ise her zaman elektriksel ve
 * mantıksal geçerliliği garanti eder: alternatif fonksiyon uyumu, pin
 * çakışması, I2C adres çakışması, timer kanal paylaşımı.
 *
 * Kullanıcı tablodan bir pini elle seçtiğinde bu "lock" olarak gelir ve
 * motor geri kalan her şeyi bu kısıta göre yeniden çözer.
 */
const { t } = require('../i18n');

/**
 * @typedef {{ id: string, componentId: string, label: string, options?: { address?: string } }} Instance
 * @typedef {{ mcuId: string, rtos: boolean, instances: Instance[], locks?: Record<string, string> }} Design
 * @typedef {{ instId: string, compPin: string, mcuPin: string, signal: string, af?: number,
 *             peripheral?: string, kind: string, locked: boolean }} Connection
 */

const ROLE_PATTERNS = {
  'i2c.SCL': /^I2C\d+_SCL$/,
  'i2c.SDA': /^I2C\d+_SDA$/,
  'spi.SCK': /^SPI\d+_SCK$/,
  'spi.MISO': /^SPI\d+_MISO$/,
  'spi.MOSI': /^SPI\d+_MOSI$/,
  'uart.TX': /^U(S)?ART\d+_TX$/,
  'uart.RX': /^U(S)?ART\d+_RX$/,
  pwm: /^TIM\d+_CH\d$/,
  adc: /^ADC\d+_IN\d+$/
};
const GPIO_ROLES = ['gpio.out', 'gpio.in', 'spi.CS'];

/** "I2C1_SCL" -> { periph: "I2C1", fn: "SCL" } */
function parseSignal(signal) {
  const i = signal.indexOf('_');
  return { periph: signal.slice(0, i), fn: signal.slice(i + 1) };
}

/**
 * @param {Design} design
 * @param {{ mcus: Record<string, any>, components: Record<string, any> }} lib
 */
function assign(design, lib) {
  const mcu = lib.mcus[design.mcuId];
  if (!mcu) throw new Error(t('Bilinmeyen MCU: {0}', design.mcuId));
  const locks = design.locks || {};

  /** @type {Connection[]} */
  const connections = [];
  /** @type {Record<string, any>} */
  const peripherals = {};
  /** @type {{ level: 'info'|'warn'|'error', text: string }[]} */
  const messages = [];
  /** @type {Record<string, string>} */
  const addresses = {};
  /** @type {{ instId: string, compPin: string, net: string }[]} */
  const power = [];
  /** @type {Map<string, string>} pin -> kim kullanıyor */
  const used = new Map();

  const pinByName = new Map(mcu.pins.map((p) => [p.name, p]));
  for (const p of mcu.pins) if (p.reserved) used.set(p.name, p.reserved);

  const msg = (level, text) => messages.push({ level, text });
  // Az fonksiyonlu pinleri tercih et: çok yönlü pinler sonraki ihtiyaçlar için boş kalsın.
  const score = (p) => p.functions.length + (p.note ? 0.5 : 0);
  const byScore = (a, b) => score(a) - score(b);
  const peripheralsOfType = (type) =>
    Object.entries(mcu.peripherals).filter(([, v]) => v.type === type).map(([k]) => k);
  const fnOf = (pin, signal) => pin.functions.find((f) => f.signal === signal);

  const instances = design.instances
    .map((inst) => ({ ...inst, comp: lib.components[inst.componentId] }))
    .filter((inst) => {
      if (!inst.comp) msg('error', t('Kütüphanede bulunamayan komponent: {0}', inst.componentId));
      return !!inst.comp;
    });

  const connect = (inst, compPin, mcuPin, signal, kind, extra = {}) => {
    used.set(mcuPin, `${inst.label}.${compPin}`);
    connections.push({
      instId: inst.id, compPin, mcuPin, signal, kind,
      locked: locks[`${inst.id}.${compPin}`] === mcuPin,
      ...extra
    });
  };

  /** Bir lock'u doğrular; geçersizse uyarı verip yok sayar. */
  const validLock = (inst, compPin, predicate) => {
    const pinName = locks[`${inst.id}.${compPin}`];
    if (!pinName) return undefined;
    const pin = pinByName.get(pinName);
    if (!pin || pin.reserved) {
      msg('warn', t('{0}.{1} → {2} kullanılamaz (rezerve). Otomatik atanıyor.', inst.label, compPin, pinName));
      return undefined;
    }
    if (used.has(pinName)) {
      msg('warn', t('{0}.{1} → {2} zaten {3} tarafından kullanılıyor. Otomatik atanıyor.', inst.label, compPin, pinName, used.get(pinName)));
      return undefined;
    }
    if (predicate && !predicate(pin)) {
      msg('warn', t('{0}.{1} → {2} bu fonksiyonu desteklemiyor. Otomatik atanıyor.', inst.label, compPin, pinName));
      return undefined;
    }
    return pin;
  };

  /**
   * Bir çevre birimi için gereken sinyallere (SCL/SDA, SCK/MISO/MOSI...) birbirinden
   * farklı, boş pinler seçer. Basit geri izlemeli (backtracking) arama.
   * @param {string} periph @param {string[]} fns @param {Record<string, any>} fixed fn -> pin
   */
  const pickPins = (periph, fns, fixed) => {
    const candidates = fns.map((fn) => {
      if (fixed[fn]) return fnOf(fixed[fn], `${periph}_${fn}`) ? [fixed[fn]] : [];
      return mcu.pins.filter((p) => !used.has(p.name) && fnOf(p, `${periph}_${fn}`)).sort(byScore);
    });
    const chosen = [];
    const search = (i) => {
      if (i === fns.length) return true;
      for (const p of candidates[i]) {
        if (chosen.includes(p)) continue;
        chosen.push(p);
        if (search(i + 1)) return true;
        chosen.pop();
      }
      return false;
    };
    if (!search(0)) return null;
    return Object.fromEntries(fns.map((fn, i) => [fn, chosen[i]]));
  };

  /** Bir grup komponentin bus pinleri üzerindeki lock'ları toplar. */
  const collectBusLocks = (members, type) => {
    /** @type {Record<string, any>} */ const fixed = {};
    let lockPeriph;
    for (const inst of members) {
      for (const cp of inst.comp.pins) {
        if (!cp.role.startsWith(type + '.') || !ROLE_PATTERNS[cp.role]) continue;
        const fn = cp.role.split('.')[1];
        const pin = validLock(inst, cp.name, (p) => p.functions.some((f) => ROLE_PATTERNS[cp.role].test(f.signal)));
        if (!pin) continue;
        const sig = pin.functions.find((f) => ROLE_PATTERNS[cp.role].test(f.signal)).signal;
        const { periph } = parseSignal(sig);
        if (lockPeriph && lockPeriph !== periph) {
          msg('warn', t('{0}.{1} kilidi {2} gerektiriyor ama grup {3} üzerinde. Kilit yok sayıldı.', inst.label, cp.name, periph, lockPeriph));
          continue;
        }
        lockPeriph = periph;
        fixed[fn] = pin;
      }
    }
    return { fixed, lockPeriph };
  };

  /** Bus grubunu bir çevre birimine bağlar ve üyelerin pinlerini bağlar. */
  const placeBusGroup = (type, members, fns, extraInfo) => {
    const { fixed, lockPeriph } = collectBusLocks(members, type);
    const order = lockPeriph ? [lockPeriph] : peripheralsOfType(type).filter((p) => !peripherals[p]);
    for (const periph of order) {
      if (peripherals[periph] && !lockPeriph) continue;
      const pick = pickPins(periph, fns, fixed);
      if (!pick) continue;
      peripherals[periph] = {
        type,
        pins: Object.fromEntries(fns.map((fn) => [fn, pick[fn].name])),
        members: members.map((m) => m.id),
        ...extraInfo
      };
      for (const inst of members) {
        for (const cp of inst.comp.pins) {
          if (!cp.role.startsWith(type + '.')) continue;
          const fn = cp.role.split('.')[1];
          if (!pick[fn]) continue;
          const signal = `${periph}_${fn}`;
          // Bus pinleri paylaşılır: aynı MCU pinine birden çok komponent bağlanabilir.
          used.set(pick[fn].name, `${periph}_${fn}`);
          connections.push({
            instId: inst.id, compPin: cp.name, mcuPin: pick[fn].name, signal,
            af: fnOf(pick[fn], signal).af, peripheral: periph, kind: type,
            locked: locks[`${inst.id}.${cp.name}`] === pick[fn].name
          });
        }
      }
      return periph;
    }
    msg('error', t('{0} için uygun {1} pini bulunamadı. Bazı pinleri serbest bırakmayı deneyin.', members.map((m) => m.label).join(', '), type.toUpperCase()));
    return null;
  };

  const hasRole = (inst, prefix) => inst.comp.pins.some((p) => p.role.startsWith(prefix));
  const neededFns = (members, type) => {
    const all = { i2c: ['SCL', 'SDA'], spi: ['SCK', 'MISO', 'MOSI'], uart: ['TX', 'RX'] }[type];
    return all.filter((fn) => members.some((m) => m.comp.pins.some((p) => p.role === `${type}.${fn}`)));
  };

  // ---- 1) I2C: adres çakışmalarını çöz, aynı bus'ı paylaştır ----
  /** @type {{ members: any[], addrs: Set<string>, lockPeriph?: string }[]} */
  const i2cGroups = [];
  for (const inst of instances.filter((i) => hasRole(i, 'i2c.'))) {
    const cfg = inst.comp.i2c;
    const userAddr = inst.options && inst.options.address;
    const candidates = userAddr ? [userAddr] : [cfg.address, ...(cfg.altAddresses || [])];
    const { lockPeriph } = collectBusLocksQuiet(inst);
    let placed = false;
    for (const g of i2cGroups) {
      if (lockPeriph && g.lockPeriph && g.lockPeriph !== lockPeriph) continue;
      const addr = candidates.find((a) => !g.addrs.has(a.toLowerCase()));
      if (!addr) continue;
      g.members.push(inst);
      g.addrs.add(addr.toLowerCase());
      g.lockPeriph = g.lockPeriph || lockPeriph;
      addresses[inst.id] = addr;
      if (addr !== candidates[0]) {
        msg('info', t('{0}: {1} adresi bus\'ta dolu, alternatif adres {2} kullanılıyor (modüldeki ADDR/SDO pinini ayarlayın).', inst.label, candidates[0], addr));
      }
      placed = true;
      break;
    }
    if (!placed) {
      if (i2cGroups.length > 0 && !lockPeriph) {
        msg('warn', t('{0}: {1} adres(ler)i mevcut bus\'ta dolu, ayrı bir I2C bus\'a taşındı.', inst.label, candidates.join('/')));
      }
      i2cGroups.push({ members: [inst], addrs: new Set([candidates[0].toLowerCase()]), lockPeriph });
      addresses[inst.id] = candidates[0];
    }
  }
  // Lock'lu gruplar önce yerleşsin ki tercih ettikleri çevre birimini alsınlar.
  i2cGroups.sort((a, b) => Number(!!b.lockPeriph) - Number(!!a.lockPeriph));
  for (const g of i2cGroups) {
    const speedHz = Math.min(...g.members.map((m) => m.comp.i2c.maxSpeedHz || 100000), 400000);
    placeBusGroup('i2c', g.members, neededFns(g.members, 'i2c'), { speedHz });
  }

  // ---- 2) SPI: ortak SCK/MISO/MOSI, her cihaza ayrı CS ----
  const spiInsts = instances.filter((i) => hasRole(i, 'spi.'));
  if (spiInsts.length) {
    /** @type {Map<string, any[]>} */ const spiGroups = new Map();
    for (const inst of spiInsts) {
      const key = collectBusLocksQuiet(inst).lockPeriph || '*';
      spiGroups.set(key, [...(spiGroups.get(key) || []), inst]);
    }
    for (const [, members] of [...spiGroups].sort(([a], [b]) => Number(a === '*') - Number(b === '*'))) {
      const speedHz = Math.min(...members.map((m) => m.comp.spi.maxSpeedHz || 1000000));
      placeBusGroup('spi', members, neededFns(members, 'spi'), { speedHz });
    }
  }

  // ---- 3) UART: her cihaz kendi USART'ını alır ----
  for (const inst of instances.filter((i) => hasRole(i, 'uart.'))) {
    const periph = placeBusGroup('uart', [inst], neededFns([inst], 'uart'), {
      baud: inst.comp.uart.baud,
      telemetry: inst.comp.role === 'telemetry'
    });
    if (periph && inst.comp.role === 'telemetry') peripherals[periph].telemetry = true;
  }

  // ---- 4) Tekil pinler: PWM, ADC, GPIO ----
  /** @type {Map<string, number>} timer -> frekans */
  const timerFreq = new Map();
  const usedTimerChannels = new Set();
  for (const inst of instances) {
    for (const cp of inst.comp.pins) {
      if (cp.role === 'pwm') {
        const freq = (inst.comp.pwm && inst.comp.pwm.frequencyHz) || 1000;
        const ok = (p) => p.functions.some((f) => {
          if (!ROLE_PATTERNS.pwm.test(f.signal) || usedTimerChannels.has(f.signal)) return false;
          const tim = parseSignal(f.signal).periph;
          return !timerFreq.has(tim) || timerFreq.get(tim) === freq;
        });
        const locked = validLock(inst, cp.name, ok);
        const pin = locked || mcu.pins.filter((p) => !used.has(p.name) && ok(p)).sort(byScore)[0];
        if (!pin) { msg('error', t('{0}.{1} için boş PWM kanalı yok.', inst.label, cp.name)); continue; }
        // Aynı timer'ı tercih et (daha az init kodu), yoksa ilk uygun kanal.
        const fns = pin.functions.filter((f) => ROLE_PATTERNS.pwm.test(f.signal) && !usedTimerChannels.has(f.signal));
        const f = fns.find((x) => timerFreq.has(parseSignal(x.signal).periph)) || fns[0];
        const { periph, fn } = parseSignal(f.signal);
        timerFreq.set(periph, freq);
        usedTimerChannels.add(f.signal);
        peripherals[periph] = peripherals[periph] || { type: 'pwm', frequencyHz: freq, channels: [] };
        peripherals[periph].channels.push({ channel: fn, pin: pin.name, instId: inst.id });
        connect(inst, cp.name, pin.name, f.signal, 'pwm', { af: f.af, peripheral: periph });
      } else if (cp.role === 'adc') {
        const ok = (p) => p.functions.some((f) => ROLE_PATTERNS.adc.test(f.signal));
        const pin = validLock(inst, cp.name, ok) || mcu.pins.filter((p) => !used.has(p.name) && ok(p)).sort(byScore)[0];
        if (!pin) { msg('error', t('{0}.{1} için boş ADC kanalı yok.', inst.label, cp.name)); continue; }
        const f = pin.functions.find((x) => ROLE_PATTERNS.adc.test(x.signal));
        const { periph, fn } = parseSignal(f.signal);
        peripherals[periph] = peripherals[periph] || { type: 'adc', channels: [] };
        peripherals[periph].channels.push({ channel: fn, pin: pin.name, instId: inst.id });
        connect(inst, cp.name, pin.name, f.signal, 'adc', { peripheral: periph });
      }
    }
  }
  for (const inst of instances) {
    for (const cp of inst.comp.pins) {
      if (!GPIO_ROLES.includes(cp.role)) continue;
      const pin = validLock(inst, cp.name) || mcu.pins.filter((p) => !used.has(p.name)).sort(byScore)[0];
      if (!pin) { msg('error', t('{0}.{1} için boş GPIO kalmadı.', inst.label, cp.name)); continue; }
      const isOut = cp.role !== 'gpio.in';
      const spiPeriph = cp.role === 'spi.CS'
        ? connections.find((c) => c.instId === inst.id && c.kind === 'spi')?.peripheral
        : undefined;
      connect(inst, cp.name, pin.name, isOut ? 'GPIO_Output' : 'GPIO_Input', cp.role === 'spi.CS' ? 'spi' : 'gpio',
        spiPeriph ? { peripheral: spiPeriph, cs: true } : {});
    }
  }

  // ---- 5) Besleme ----
  for (const inst of instances) {
    for (const cp of inst.comp.pins) {
      if (cp.role === 'ground') power.push({ instId: inst.id, compPin: cp.name, net: 'GND' });
      if (cp.role === 'power') {
        const needs5v = inst.comp.voltage && inst.comp.voltage.min > mcu.voltage;
        power.push({ instId: inst.id, compPin: cp.name, net: needs5v ? '5V' : '3V3' });
      }
    }
  }

  // ---- 6) UI için: her komponent pini için seçilebilir MCU pinleri ----
  /** @type {Record<string, string[]>} */
  const options = {};
  for (const inst of instances) {
    for (const cp of inst.comp.pins) {
      const key = `${inst.id}.${cp.name}`;
      if (ROLE_PATTERNS[cp.role]) {
        options[key] = mcu.pins
          .filter((p) => !p.reserved && p.functions.some((f) => ROLE_PATTERNS[cp.role].test(f.signal)))
          .map((p) => p.name);
      } else if (GPIO_ROLES.includes(cp.role)) {
        options[key] = mcu.pins.filter((p) => !p.reserved).map((p) => p.name);
      }
    }
  }

  return { connections, peripherals, messages, addresses, power, options, pinUsage: Object.fromEntries(used) };

  /** Gruplama aşaması için: tek bir komponentin kilitlediği çevre birimi (mesaj üretmeden). */
  function collectBusLocksQuiet(inst) {
    for (const cp of inst.comp.pins) {
      const pinName = locks[`${inst.id}.${cp.name}`];
      const pattern = ROLE_PATTERNS[cp.role];
      if (!pinName || !pattern) continue;
      const pin = pinByName.get(pinName);
      const f = pin && pin.functions.find((x) => pattern.test(x.signal));
      if (f) return { lockPeriph: parseSignal(f.signal).periph };
    }
    return { lockPeriph: undefined };
  }
}

module.exports = { assign, parseSignal };
