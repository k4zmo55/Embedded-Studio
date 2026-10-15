// @ts-check
/**
 * Debug oturumu: hedefe bağlanır, durdurur/çalıştırır, register ve bellek okur.
 *
 *  - OpenOcdTarget: openocd'yi başlatır ve TCL RPC (port 6666) üzerinden konuşur. ST-Link + gerçek kart gerekir.
 *  - SimTarget:     kart yokken arayüzü denemek için; tasarımdan beklenen register değerlerini üretir.
 *
 * Ortak arayüz: connect(), disconnect(), state(), halt(), resume(), step(), reset(),
 *               readMemory(addr, words) -> number[], coreRegisters() -> { r0: n, ... }, program(elf)
 */
const net = require('net');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { t } = require('../i18n');

const CORE_REGS = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'sp', 'lr', 'pc', 'xPSR'];

// ------------------------------------------------------------------ OpenOCD
class TclClient {
  constructor() {
    /** @type {net.Socket | null} */
    this.sock = null;
    this.buf = '';
    /** @type {{ cmd: string, resolve: (v: string) => void, reject: (e: Error) => void }[]} */
    this.queue = [];
    this.busy = false;
  }

  connect(port = 6666, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ port, host }, () => resolve(undefined));
      s.setEncoding('utf8');
      s.on('error', (e) => {
        reject(e);
        this.failAll(e);
      });
      s.on('close', () => this.failAll(new Error(t('OpenOCD bağlantısı kapandı'))));
      s.on('data', (d) => this.onData(String(d)));
      this.sock = s;
    });
  }

  failAll(e) {
    for (const q of this.queue) q.reject(e);
    this.queue = [];
    this.busy = false;
  }

  onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\x1a')) >= 0) {
      const reply = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      const q = this.queue.shift();
      this.busy = false;
      if (q) q.resolve(reply);
      this.pump();
    }
  }

  pump() {
    if (this.busy || !this.queue.length || !this.sock) return;
    this.busy = true;
    this.sock.write(this.queue[0].cmd + '\x1a');
  }

  /** Bir TCL komutu gönderir, yanıt metnini döndürür. Komutlar sırayla işlenir. */
  send(cmd, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const entry = { cmd, resolve, reject };
      const timer = setTimeout(() => {
        const idx = this.queue.indexOf(entry);
        if (idx >= 0) this.queue.splice(idx, 1);
        reject(new Error(t('OpenOCD yanıt vermedi: {0}', cmd)));
      }, timeoutMs);
      entry.resolve = (v) => { clearTimeout(timer); resolve(v); };
      entry.reject = (e) => { clearTimeout(timer); reject(e); };
      this.queue.push(entry);
      this.pump();
    });
  }

  close() {
    this.sock?.destroy();
    this.sock = null;
  }
}

class OpenOcdTarget {
  /** @param {{ interfaceCfg?: string, targetCfg: string, openocdPath?: string, port?: number, log?: (s: string) => void }} opts */
  constructor(opts) {
    this.opts = { interfaceCfg: 'interface/stlink.cfg', openocdPath: 'openocd', port: 6666, log: () => {}, ...opts };
    this.proc = null;
    this.tcl = new TclClient();
    this.mode = 'openocd';
  }

  async connect() {
    const o = this.opts;
    const args = ['-f', o.interfaceCfg, '-f', o.targetCfg, '-c', `tcl_port ${o.port}`, '-c', 'telnet_port disabled', '-c', 'gdb_port disabled'];
    let log = '';
    await new Promise((resolve, reject) => {
      const p = spawn(o.openocdPath, args, { windowsHide: true });
      this.proc = p;
      const onText = (d) => {
        const s = String(d);
        log += s;
        o.log(s);
        // "Listening on port" adaptör açılmadan önce de yazılır; hedef gerçekten algılanınca hazırız.
        if (/processor detected|Examination succeed/i.test(log) && /Listening on port \d+ for tcl/.test(log)) resolve(undefined);
        const hata = explainOpenOcd(log);
        if (hata) reject(new Error(hata));
      };
      p.stdout.on('data', onText);
      p.stderr.on('data', onText);
      p.on('error', (e) => reject(new Error(t('openocd başlatılamadı ({0}). OpenOCD kurulu ve PATH\'te mi?', e.message))));
      p.on('exit', (code) => reject(new Error(explainOpenOcd(log) || t('openocd kapandı (kod {0}).', code))));
      setTimeout(() => reject(new Error(t('openocd 15 sn içinde hazır olmadı.') + '\n' + log.slice(-400))), 15000);
    });
    await this.tcl.connect(o.port);
  }

  async disconnect() {
    try { await this.tcl.send('resume', 1000); } catch { /* zaten çalışıyor olabilir */ }
    this.tcl.close();
    this.proc?.kill();
    this.proc = null;
  }

  async state() {
    return (await this.tcl.send('[target current] curstate')).trim(); // running | halted | reset ...
  }
  halt() { return this.tcl.send('halt 500'); }
  resume() { return this.tcl.send('resume'); }
  step() { return this.tcl.send('step'); }
  reset() { return this.tcl.send('reset run'); }

  async readMemory(addr, words) {
    const r = await this.tcl.send(`[target current] read_memory 0x${addr.toString(16)} 32 ${words}`);
    const vals = r.trim().split(/\s+/).filter(Boolean).map((v) => parseInt(v, 16));
    if (vals.length !== words || vals.some((v) => Number.isNaN(v))) throw new Error(t('Bellek okunamadı @0x{0}: {1}', addr.toString(16), r.trim().slice(0, 120)));
    return vals;
  }

  async coreRegisters() {
    const out = {};
    const r = await this.tcl.send(`[target current] get_reg {${CORE_REGS.join(' ')}}`);
    // get_reg çıktısı: "r0 0x00000000 r1 0x..." (Tcl dict)
    const parts = r.trim().split(/\s+/);
    for (let i = 0; i + 1 < parts.length; i += 2) out[parts[i]] = parseInt(parts[i + 1], 16);
    if (!Object.keys(out).length) throw new Error(t('Register okunamadı (hedef durdurulmuş olmalı): {0}', r.trim().slice(0, 120)));
    return out;
  }

  async program(elf) {
    const r = await this.tcl.send(`program {${elf.replace(/\\/g, '/')}} verify reset`, 120000);
    if (/error|failed/i.test(r)) throw new Error(r.trim());
    return r;
  }
}

/** Sık görülen openocd hatalarını anlaşılır mesaja çevirir. */
function explainOpenOcd(log) {
  if (/open failed|unable to open|no device found|LIBUSB_ERROR/i.test(log)) return t('ST-Link bulunamadı. Programlayıcının takılı olduğundan ve sürücüsünün kurulu olduğundan emin olun.');
  if (/init mode failed|unable to connect to the target|target voltage may be too low/i.test(log)) return t('ST-Link bulundu ama hedefe bağlanılamadı. SWDIO/SWCLK/GND/3V3 kablolarını ve kartın beslemesini kontrol edin.');
  if (/couldn't bind|Address already in use/i.test(log)) return t('TCL portu (6666) kullanımda: başka bir openocd açık olabilir.');
  if (/Can't find interface|Can't find target/i.test(log)) return t('OpenOCD yapılandırma dosyası bulunamadı: {0}', (log.match(/Can't find [^\n]+/) || [''])[0]);
  return '';
}

// ------------------------------------------------------------------ Simülasyon
class SimTarget {
  /** @param {{ peripherals: any[], expected: Map<number, number> }} model */
  constructor(model) {
    this.mode = 'sim';
    this.model = model;
    this.halted = false;
    this.t0 = Date.now();
    this.pc = 0x08000420;
  }
  async connect() {}
  async disconnect() {}
  async state() { return this.halted ? 'halted' : 'running'; }
  async halt() { this.halted = true; }
  async resume() { this.halted = false; }
  async step() { this.pc += 2; }
  async reset() { this.t0 = Date.now(); this.pc = 0x08000420; this.halted = false; }
  async program() { return t('simülasyon: yükleme atlandı'); }

  async readMemory(addr, words) {
    const ms = Date.now() - this.t0;
    const out = [];
    for (let i = 0; i < words; i++) {
      const a = addr + i * 4;
      let v = this.model.expected.get(a);
      if (v === undefined) v = 0;
      // Canlı değişen register'lar
      if (this.model.dynamic.has(a)) v = this.model.dynamic.get(a)(ms, this.halted) >>> 0;
      out.push(v >>> 0);
    }
    return out;
  }

  async coreRegisters() {
    if (!this.halted) throw new Error(t('Core register\'ları okumak için hedefi durdurun.'));
    const r = {};
    CORE_REGS.forEach((n, i) => (r[n] = (0x1000 * i + 0x24) >>> 0));
    r.sp = 0x2001ffb0; r.lr = 0x08000a3d; r.pc = this.pc; r.xPSR = 0x61000000;
    return r;
  }
}

/** Tasarımdan, Board_Init sonrası beklenen register değerlerini hesaplar (simülasyon için). */
function simModel(design, lib, result, clock, peripherals) {
  const expected = new Map();
  const dynamic = new Map();
  const base = Object.fromEntries(peripherals.map((p) => [p.name, p.base]));
  const reg = (periph, name) => {
    const p = peripherals.find((x) => x.name === periph);
    const r = p && p.registers.find((x) => x.name === name);
    return r ? p.base + r.offset : undefined;
  };
  const or = (addr, v) => addr !== undefined && expected.set(addr, ((expected.get(addr) || 0) | v) >>> 0);
  const set = (addr, v) => addr !== undefined && expected.set(addr, v >>> 0);

  const c = clock.config;
  set(reg('RCC', 'CR'), 0x00000083 | (c.pllSource === 'HSE' || c.sysclkSource === 'HSE' ? 0x30000 : 0) | (c.sysclkSource === 'PLL' ? 0x3000000 : 0));
  set(reg('RCC', 'PLLCFGR'), c.M | (c.N << 6) | ((c.P / 2 - 1) << 16) | (c.pllSource === 'HSE' ? 1 << 22 : 0) | (c.Q << 24));
  const sw = { HSI: 0, HSE: 1, PLL: 2 }[c.sysclkSource];
  const HP = { 1: 0, 2: 8, 4: 9, 8: 10, 16: 11, 64: 12, 128: 13, 256: 14, 512: 15 }, PP = { 1: 0, 2: 4, 4: 5, 8: 6, 16: 7 };
  set(reg('RCC', 'CFGR'), sw | (sw << 2) | (HP[c.ahb] << 4) | (PP[c.apb1] << 10) | (PP[c.apb2] << 13));
  set(reg('FLASH', 'ACR'), clock.latency | 0x700);

  const MODE = { in: 0, out: 1, af: 2, analog: 3 };
  for (const conn of result.connections) {
    const port = 'GPIO' + conn.mcuPin[1], n = Number(conn.mcuPin.slice(2));
    if (!base[port]) continue;
    const kind = conn.kind === 'adc' ? 'analog' : conn.signal === 'GPIO_Output' ? 'out' : conn.signal === 'GPIO_Input' ? 'in' : 'af';
    or(reg(port, 'MODER'), MODE[kind] << (n * 2));
    if (conn.kind === 'i2c') or(reg(port, 'OTYPER'), 1 << n);
    or(reg(port, 'OSPEEDR'), 3 << (n * 2));
    if (conn.af !== undefined) or(reg(port, n < 8 ? 'AFRL' : 'AFRH'), conn.af << ((n & 7) * 4));
    if (conn.cs) or(reg(port, 'ODR'), 1 << n);
    if (conn.kind === 'gpio' && conn.signal === 'GPIO_Output') {
      const odr = reg(port, 'ODR'), idr = reg(port, 'IDR');
      const bit = 1 << n;
      const blink = (ms) => (Math.floor(ms / 500) % 2 ? bit : 0);
      if (odr !== undefined) dynamic.set(odr, ((prev) => (ms, h) => (prev(ms, h) & ~bit) | blink(ms))(dynamic.get(odr) || (() => expected.get(odr) || 0)));
      if (idr !== undefined) dynamic.set(idr, ((prev) => (ms, h) => (prev(ms, h) & ~bit) | blink(ms))(dynamic.get(idr) || (() => 0xffff & ~0)));
    }
  }

  const f = clock.freq;
  for (const [name, p] of Object.entries(result.peripherals)) {
    if (p.type === 'i2c') {
      set(reg(name, 'CR1'), 0x1);
      set(reg(name, 'CR2'), Math.round(f.pclk1));
      set(reg(name, 'CCR'), p.speedHz > 100000 ? 0x8000 | Math.ceil((f.pclk1 * 1e6) / (3 * p.speedHz)) : Math.ceil((f.pclk1 * 1e6) / (2 * p.speedHz)));
      set(reg(name, 'TRISE'), p.speedHz > 100000 ? Math.floor(f.pclk1 * 0.3) + 1 : Math.round(f.pclk1) + 1);
      const sr2 = reg(name, 'SR2');
      if (sr2 !== undefined) dynamic.set(sr2, (ms) => (ms % 1000 < 60 ? 0x3 : 0));
    }
    if (p.type === 'spi') set(reg(name, 'CR1'), 0x344 | (3 << 3)), set(reg(name, 'SR'), 0x2);
    if (p.type === 'uart') {
      const pclk = name === 'USART1' || name === 'USART6' ? f.pclk2 : f.pclk1;
      set(reg(name, 'BRR'), Math.round((pclk * 1e6) / p.baud));
      set(reg(name, 'CR1'), 0x200c | (p.telemetry ? 0 : 0x20));
      set(reg(name, 'SR'), 0xc0);
    }
    if (p.type === 'adc') {
      set(reg(name, 'CR2'), 1);
      const dr = reg(name, 'DR');
      if (dr !== undefined) dynamic.set(dr, (ms) => Math.round(2048 + 1500 * Math.sin(ms / 2400)));
    }
    if (p.type === 'pwm') {
      const timclk = f.tim1 * 1e6;
      const psc = Math.max(0, Math.round(timclk / 1e6) - 1);
      const arr = Math.round(1e6 / p.frequencyHz) - 1;
      set(reg(name, 'PSC'), psc);
      set(reg(name, 'ARR'), arr);
      set(reg(name, 'CR1'), 0x81);
      let ccer = 0;
      for (const ch of p.channels) {
        const n = Number(ch.channel.replace('CH', ''));
        ccer |= 1 << ((n - 1) * 4);
        or(reg(name, n <= 2 ? 'CCMR1' : 'CCMR2'), 0x68 << (n % 2 === 1 ? 0 : 8));
        const ccr = reg(name, `CCR${n}`);
        if (ccr !== undefined) dynamic.set(ccr, (ms) => Math.round(1500 + 1000 * Math.sin(ms / 1300)));
      }
      set(reg(name, 'CCER'), ccer);
      const cnt = reg(name, 'CNT');
      if (cnt !== undefined) dynamic.set(cnt, (ms, halted) => (halted ? 1234 : Math.floor((ms * 1000) % (arr + 1))));
    }
  }
  // Saat açma bitleri
  const en = { AHB1ENR: 0, APB1ENR: 0, APB2ENR: 0 };
  const ports = new Set(result.connections.map((x) => x.mcuPin[1]));
  for (const pt of ports) en.AHB1ENR |= 1 << ({ A: 0, B: 1, C: 2, H: 7 }[pt] ?? 0);
  const bits = { I2C1: ['APB1ENR', 21], I2C2: ['APB1ENR', 22], I2C3: ['APB1ENR', 23], SPI2: ['APB1ENR', 14], USART2: ['APB1ENR', 17], TIM2: ['APB1ENR', 0], TIM3: ['APB1ENR', 1], TIM4: ['APB1ENR', 2], USART1: ['APB2ENR', 4], USART6: ['APB2ENR', 5], ADC1: ['APB2ENR', 8], SPI1: ['APB2ENR', 12] };
  for (const name of Object.keys(result.peripherals)) if (bits[name]) en[bits[name][0]] |= 1 << bits[name][1];
  en.APB1ENR |= 1 << 28;
  for (const [k, v] of Object.entries(en)) set(reg('RCC', k), v);
  return { peripherals, expected, dynamic };
}

/** ELF içindeki global değişkenler (izleme listesi için). */
function elfSymbols(elfPath, nm = 'arm-none-eabi-nm') {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(elfPath)) return reject(new Error(t('ELF bulunamadı: {0}. Önce projeyi derleyin.', elfPath)));
    execFile(nm, ['-S', '-C', '--defined-only', elfPath], { windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => {
      if (err) return reject(new Error(t('{0} çalıştırılamadı: {1}', nm, err.message)));
      const syms = [];
      for (const line of stdout.split(/\r?\n/)) {
        const m = /^([0-9a-f]{8}) ([0-9a-f]{8}) ([bBdD]) (.+)$/.exec(line.trim());
        if (m && !m[4].startsWith('_') && !m[4].startsWith('.')) syms.push({ name: m[4], addr: parseInt(m[1], 16), size: parseInt(m[2], 16) });
      }
      resolve(syms.sort((a, b) => a.name.localeCompare(b.name)));
    });
  });
}

module.exports = { OpenOcdTarget, SimTarget, TclClient, simModel, elfSymbols, explainOpenOcd, CORE_REGS };
