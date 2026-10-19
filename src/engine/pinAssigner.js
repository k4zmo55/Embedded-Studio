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
 *
 * ES-1001: kilitli pinler otomatik atamada başkalarına verilmez (önce ayrılır); uygulanamayan kilit nedeniyle
 * lockIssues'ta döner; bus komponentinin çevre birimi örneği (I2C1/I2C2…) inst.options.periph ile seçilir;
 * arayüz için her komponent pininin seçenekleri choices'ta: pin, sinyal, çevre birimi, kim kullanıyor, devre dışı nedeni.
 */
const { t } = require('../i18n');
const { checkLabels } = require('./labels');

/**
 * @typedef {{ id: string, componentId: string, label: string, options?: { address?: string, periph?: string } }} Instance
 * @typedef {{ mcuId: string, rtos: boolean, instances: Instance[], locks?: Record<string, string>, pinLabels?: Record<string, string>, pinModes?: Record<string, string> }} Design
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
/** ES-1005: Pinout'ta komponentsiz atanabilen GPIO modları (GPIO_EXTI: NVIC ayarlarıyla ES-1007) */
const PIN_MODES = ['GPIO_Input', 'GPIO_Output', 'GPIO_Analog'];

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
  // ES-1005: Pinout'ta elle verilen GPIO modları: pin kullanıcınındır, komponentler bu pinlere atanmaz
  /** @type {Record<string, string>} */
  const pinModes = {};
  for (const [pin, mode] of Object.entries(design.pinModes || {})) {
    const p = pinByName.get(pin);
    if (!p || p.reserved || !PIN_MODES.includes(mode)) {
      msg('warn', t('{0}: {1} uygulanmadı ({2}).', pin, mode, !p ? t('bu işlemcide yok') : p.reserved ? t('ayrılmış: {0}', p.reserved) : t('desteklenmeyen mod')));
      continue;
    }
    pinModes[pin] = mode;
    used.set(pin, mode);
  }
  /** @type {Record<string, string>} uygulanamayan kilit → neden */
  const lockIssues = {};
  // Kilitli pinler: otomatik atama bunları başka bir komponent pinine vermez (kilit sahibi önce gelmese bile)
  /** @type {Map<string, string>} pin -> kilit anahtarı (inst.compPin) */
  const lockedPins = new Map();
  for (const [key, pin] of Object.entries(locks)) {
    const p = pinByName.get(pin);
    if (p && !p.reserved && !lockedPins.has(pin)) lockedPins.set(pin, key);
  }
  /** Otomatik atamada kullanılabilir mi: boş ve başka birinin kilidinde değil (instIds: kilidi sayılmayacak komponentler) */
  const freeFor = (p, instIds) => !used.has(p.name) && (!lockedPins.has(p.name) || instIds.includes(lockedPins.get(p.name).split('.')[0]));
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

  /** "c1.SCL" → "BME280_1.SCL" */
  const keyLabel = (key) => {
    const [id, pin] = key.split('.');
    const m = design.instances.find((i) => i.id === id);
    return `${m ? m.label : id}.${pin}`;
  };

  /** Kilit uygulanamadı: uyarı + arayüzde satırda neden */
  const lockIssue = (inst, compPin, text) => {
    lockIssues[`${inst.id}.${compPin}`] = text;
    msg('warn', `${inst.label}.${compPin}: ${text}`);
  };

  /** Bir lock'u doğrular; geçersizse nedenini bildirip yok sayar (otomatik atanır). */
  const validLock = (inst, compPin, predicate) => {
    const key = `${inst.id}.${compPin}`;
    const pinName = locks[key];
    if (!pinName) return undefined;
    const pin = pinByName.get(pinName);
    if (!pin || pin.reserved) {
      lockIssue(inst, compPin, t('{0} kullanılamaz (rezerve). Otomatik atandı.', pinName));
      return undefined;
    }
    if (used.has(pinName) || lockedPins.get(pinName) !== key) {
      lockIssue(inst, compPin, t('{0} zaten {1} tarafından kullanılıyor. Otomatik atandı.', pinName, used.get(pinName) || keyLabel(lockedPins.get(pinName))));
      return undefined;
    }
    if (predicate && !predicate(pin)) {
      lockIssue(inst, compPin, t('{0} bu fonksiyonu desteklemiyor. Otomatik atandı.', pinName));
      return undefined;
    }
    return pin;
  };

  /**
   * Bir çevre birimi için gereken sinyallere (SCL/SDA, SCK/MISO/MOSI...) birbirinden
   * farklı, boş pinler seçer. Basit geri izlemeli (backtracking) arama.
   * @param {string} periph @param {string[]} fns @param {Record<string, any>} fixed fn -> pin
   */
  const pickPins = (periph, fns, fixed, instIds) => {
    const candidates = fns.map((fn) => {
      if (fixed[fn]) return fnOf(fixed[fn], `${periph}_${fn}`) ? [fixed[fn]] : [];
      return mcu.pins.filter((p) => freeFor(p, instIds) && fnOf(p, `${periph}_${fn}`)).sort(byScore);
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
    // Seçilen çevre birimi örneği (I2C2 …) kilitlerden önce gelir
    let lockPeriph = members.map((m) => chosenPeriph(m, type)).find(Boolean);
    for (const inst of members) {
      for (const cp of inst.comp.pins) {
        if (!cp.role.startsWith(type + '.') || !ROLE_PATTERNS[cp.role]) continue;
        const fn = cp.role.split('.')[1];
        const pin = validLock(inst, cp.name, (p) => p.functions.some((f) => ROLE_PATTERNS[cp.role].test(f.signal)));
        if (!pin) continue;
        const sig = pin.functions.find((f) => ROLE_PATTERNS[cp.role].test(f.signal)).signal;
        const { periph } = parseSignal(sig);
        if (lockPeriph && lockPeriph !== periph) {
          lockIssue(inst, cp.name, t('{0} kilidi {1} gerektiriyor ama grup {2} üzerinde. Otomatik atandı.', pin.name, periph, lockPeriph));
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
      const pick = pickPins(periph, fns, fixed, members.map((m) => m.id));
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
    msg('error', lockPeriph
      ? t('{0} için {1} pinleri bulunamadı (boş ya da kilitlerle uyumlu değil). Başka bir {2} seçin ya da pinleri serbest bırakın.', members.map((m) => m.label).join(', '), lockPeriph, type.toUpperCase())
      : t('{0} için uygun {1} pini bulunamadı. Bazı pinleri serbest bırakmayı deneyin.', members.map((m) => m.label).join(', '), type.toUpperCase()));
    return null;
  };

  /** Komponent için seçilmiş çevre birimi örneği (options.periph), bu türde ve işlemcide varsa */
  function chosenPeriph(inst, type) {
    const want = inst.options && inst.options.periph;
    return want && mcu.peripherals[want] && mcu.peripherals[want].type === type ? want : undefined;
  }

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
    const { lockPeriph } = collectBusLocksQuiet(inst, 'i2c');
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
      const key = collectBusLocksQuiet(inst, 'spi').lockPeriph || '*';
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
        const pin = locked || mcu.pins.filter((p) => freeFor(p, [inst.id]) && ok(p)).sort(byScore)[0];
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
        const pin = validLock(inst, cp.name, ok) || mcu.pins.filter((p) => freeFor(p, [inst.id]) && ok(p)).sort(byScore)[0];
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
      const pin = validLock(inst, cp.name) || mcu.pins.filter((p) => freeFor(p, [inst.id])).sort(byScore)[0];
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
  // Pin sahipleri: hangi komponentler, hangi sinyal (bus pinleri grubun üyelerince paylaşılır)
  /** @type {Map<string, { by: string, signal: string, instIds: string[] }>} */
  const owners = new Map();
  for (const c of connections) {
    const o = owners.get(c.mcuPin) || { by: used.get(c.mcuPin) || '', signal: c.signal, instIds: [] };
    o.instIds.push(c.instId);
    owners.set(c.mcuPin, o);
  }
  const labelOf = (id) => (instances.find((i) => i.id === id) || { label: id }).label;
  /**
   * Seçenek: { pin, signal, periph?, af?, user?, conflict?, disabled?, reason? }. conflict: pin başka bir komponentte
   * (seçilirse arayüz sorar: onu taşı / vazgeç). disabled: bus grubu başka bir çevre birimine bağlı.
   */
  /** @type {Record<string, any[]>} */
  const choices = {};
  /** @type {Record<string, string[]>} */
  const options = {};
  for (const inst of instances) {
    for (const cp of inst.comp.pins) {
      const key = `${inst.id}.${cp.name}`;
      const pattern = ROLE_PATTERNS[cp.role];
      if (!pattern && !GPIO_ROLES.includes(cp.role)) continue;
      const usage = (pin, signal) => {
        if (pinModes[pin]) return { user: t('{0} (Pinout)', pinModes[pin]), conflict: true, pinMode: true };
        const o = owners.get(pin);
        if (o && !o.instIds.includes(inst.id) && o.signal !== signal) return { user: o.by, conflict: true, ownerIds: o.instIds };
        if (o && !o.instIds.includes(inst.id)) return { user: o.by, shared: true };
        if (!o && used.has(pin)) return { user: used.get(pin) };
        return {};
      };
      const list = [];
      if (pattern) {
        const type = cp.role.split('.')[0];
        const fixed = busFixed(inst, cp.name, type);
        for (const p of mcu.pins) {
          if (p.reserved) continue;
          for (const f of p.functions.filter((x) => pattern.test(x.signal))) {
            const { periph } = parseSignal(f.signal);
            const c = { pin: p.name, signal: f.signal, periph, ...(f.af !== undefined ? { af: f.af } : {}), ...usage(p.name, f.signal) };
            if (fixed && fixed.periph !== periph && type !== 'pwm' && type !== 'adc') Object.assign(c, { disabled: true, reason: fixed.reason });
            list.push(c);
          }
        }
      } else {
        for (const p of mcu.pins) if (!p.reserved) list.push({ pin: p.name, signal: cp.role === 'gpio.in' ? 'GPIO_Input' : 'GPIO_Output', ...usage(p.name, '') });
      }
      choices[key] = list;
      options[key] = [...new Set(list.map((c) => c.pin))];
    }
  }

  // ---- 7) ES-1003: pin etiketleri (geçersizler kodda kullanılmaz, notlarda nedeni) ----
  const { labels: pinLabels, issues: labelIssues } = checkLabels(design.pinLabels, mcu, connections, design.instances);
  for (const [pin, text] of Object.entries(labelIssues)) msg('warn', t('{0} etiketi kullanılmıyor: {1}', pin, text));

  return { connections, peripherals, messages, addresses, power, options, choices, lockIssues, pinLabels, labelIssues, pinModes, pinUsage: Object.fromEntries(used) };

  /**
   * Bu komponent pininin bus grubunu bir çevre birimine bağlayan şey (bu pinin kendi kilidi hariç): seçilen örnek
   * ya da grubun başka bir pinindeki kilit. Yoksa null (pin seçmek grubu taşır).
   */
  function busFixed(inst, compPin, type) {
    if (!['i2c', 'spi', 'uart'].includes(type)) return null;
    const conn = connections.find((c) => c.instId === inst.id && c.compPin === compPin);
    const group = conn && conn.peripheral && peripherals[conn.peripheral] ? peripherals[conn.peripheral].members : [inst.id];
    for (const id of group) {
      const m = instances.find((i) => i.id === id);
      const want = m && chosenPeriph(m, type);
      if (want) return { periph: want, reason: t('{0} için {1} seçili', m.label, want) };
    }
    for (const id of group) {
      const m = instances.find((i) => i.id === id);
      if (!m) continue;
      for (const p of m.comp.pins) {
        const key = `${id}.${p.name}`;
        if (key === `${inst.id}.${compPin}` || !p.role.startsWith(type + '.') || !locks[key] || lockIssues[key]) continue;
        const c = connections.find((x) => x.instId === id && x.compPin === p.name);
        if (c && c.peripheral) return { periph: c.peripheral, reason: t('grup {0} üzerinde ({1}.{2} → {3} sabit)', c.peripheral, labelOf(id), p.name, locks[key]) };
      }
    }
    return null;
  }

  /** Gruplama aşaması için: tek bir komponentin kilitlediği çevre birimi (mesaj üretmeden). */
  function collectBusLocksQuiet(inst, type) {
    const want = chosenPeriph(inst, type);
    if (want) return { lockPeriph: want };
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

module.exports = { assign, parseSignal, PIN_MODES };
