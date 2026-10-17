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
const { familyOf, kernelClock } = require('../codegen/families');
const { explainFlashError } = require('./flashcmd');
const trace = require('./trace');
const { parseFlashInfo, flashLayout } = require('./programmer');

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
  /**
   * @param {{ interfaceCfg?: string, targetCfg: string, transport?: string, serial?: string, speedKHz?: number, openocdPath?: string, port?: number,
   *   log?: (s: string) => void, onExit?: (reason: string) => void }} opts  port 0/verilmezse boş bir port seçilir
   */
  constructor(opts) {
    this.opts = { interfaceCfg: 'interface/stlink.cfg', openocdPath: 'openocd', port: 0, log: () => {}, onExit: () => {}, ...opts };
    this.proc = null;
    this.tcl = new TclClient();
    this.mode = 'openocd';
    this.swo = null;
    this.semiSink = null;
  }

  async connect() {
    const o = this.opts;
    // Sabit 6666 başka bir OpenOCD açıkken çakışıyordu
    const port = o.port || (await freePort());
    // ES-301: JTAG (ST-Link'te hla_jtag); SWD arayüz dosyasının varsayılanı
    const transport = o.transport === 'jtag' ? ['-c', `transport select ${/stlink/.test(o.interfaceCfg) ? 'hla_jtag' : 'jtag'}`] : [];
    const args = ['-f', o.interfaceCfg, ...transport, ...(o.serial ? ['-c', `adapter serial ${o.serial}`] : []), '-f', o.targetCfg,
      ...(o.speedKHz ? ['-c', `adapter speed ${o.speedKHz}`] : []),
      '-c', `tcl_port ${port}`, '-c', 'telnet_port disabled', '-c', 'gdb_port disabled'];
    let log = '', ready = false, timer;
    try {
      await new Promise((resolve, reject) => {
        const p = spawn(o.openocdPath, args, { windowsHide: true });
        this.proc = p;
        const onText = (d) => {
          const s = String(d);
          log += s;
          o.log(s);
          // "Listening on port" adaptör açılmadan önce de yazılır; hedef gerçekten algılanınca hazırız.
          if (!ready && /processor detected|Examination succeed/i.test(log) && /Listening on port \d+ for tcl/.test(log)) { ready = true; resolve(undefined); }
          const hata = !ready && explainOpenOcd(log);
          if (hata) reject(new Error(hata));
        };
        // OpenOCD günlüğü stderr'e, semihosting çıktısı (SYS_WRITE) stdout'a yazılır
        p.stdout.on('data', (d) => { onText(d); this.onStdout(String(d)); });
        p.stderr.on('data', onText);
        p.on('error', (e) => reject(new Error(t('openocd başlatılamadı ({0}). OpenOCD kurulu ve PATH\'te mi?', e.message))));
        p.on('exit', (code) => {
          const why = explainOpenOcd(log) || t('openocd kapandı (kod {0}).', code);
          // Bağlandıktan sonra kapanırsa (prob çekildi, kart beslemesi gitti) arayüz haberdar olsun
          if (ready && this.proc === p) { this.proc = null; this.tcl.close(); o.onExit(why); }
          reject(new Error(why));
        });
        timer = setTimeout(() => reject(new Error(t('openocd 15 sn içinde hazır olmadı.') + '\n' + log.slice(-400))), 15000);
      });
      await this.tcl.connect(port);
    } catch (e) {
      // Bağlanamayınca arkada açık kalan openocd probu kilitliyordu
      const p = this.proc;
      this.proc = null;
      try { p?.kill(); } catch { /* kapandı */ }
      this.tcl.close();
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async disconnect() {
    await this.stopSwo().catch(() => {});
    const p = this.proc;
    this.proc = null; // onExit tetiklenmesin: kapatan biziz
    if (p) try { await this.tcl.send('resume', 1000); } catch { /* zaten çalışıyor olabilir */ }
    this.tcl.close();
    try { p?.kill(); } catch { /* kapandı */ }
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

  /** Bellek yazma (çevre birimi register'ı). width: 8 | 16 | 32 */
  async writeMemory(addr, width, value) {
    const r = await this.tcl.send(`[target current] write_memory 0x${addr.toString(16)} ${width} {0x${(value >>> 0).toString(16)}}`);
    if (/error|failed|invalid/i.test(r)) throw new Error(t('Yazılamadı @0x{0}: {1}', addr.toString(16), r.trim().slice(0, 120)));
  }

  /**
   * Çekirdek register'ları. Özel register'lar (MSP/PSP, PRIMASK…, CONTROL) ve FPU (d0–d15 → s0–s31, FPSCR) ayrı okunur:
   * çekirdekte olmayan register adı tüm get_reg komutunu bozar.
   * @param {{ v6m?: boolean, fpu?: boolean }} [cpu]
   */
  async coreRegisters(cpu = {}) {
    const out = {};
    const read = async (names) => {
      const r = await this.tcl.send(`[target current] get_reg {${names.join(' ')}}`);
      // get_reg çıktısı: "r0 0x00000000 r1 0x..." (Tcl dict)
      const parts = r.trim().split(/\s+/);
      const got = {};
      for (let i = 0; i + 1 < parts.length; i += 2) if (/^0x[0-9a-f]+$/i.test(parts[i + 1])) got[parts[i]] = parts[i + 1];
      if (!Object.keys(got).length) throw new Error(t('Register okunamadı (hedef durdurulmuş olmalı): {0}', r.trim().slice(0, 120)));
      return got;
    };
    for (const [k, v] of Object.entries(await read(CORE_REGS))) out[k] = parseInt(v, 16);
    try {
      for (const [k, v] of Object.entries(await read(specialRegs(cpu)))) out[k] = parseInt(v, 16);
    } catch { /* eski OpenOCD: özel register adı yok */ }
    if (cpu.fpu) {
      try {
        Object.assign(out, splitFpu(await read([...Array(16)].map((_, i) => `d${i}`).concat('fpscr'))));
      } catch { /* FPU kapalı ya da desteklenmiyor */ }
    }
    return out;
  }

  async program(elf) {
    const r = await this.tcl.send(`program {${elf.replace(/\\/g, '/')}} verify reset`, 120000);
    if (/error|failed/i.test(r)) throw new Error(r.trim());
    return r;
  }

  /** Bayt dizisi yazma (RTT down kanalı): tek write_memory komutunda en fazla 256 bayt */
  async writeBytes(addr, bytes) {
    for (let k = 0; k < bytes.length; k += 256) {
      const part = [...bytes.subarray(k, k + 256)].map((b) => '0x' + b.toString(16)).join(' ');
      const r = await this.tcl.send(`[target current] write_memory 0x${(addr + k).toString(16)} 8 {${part}}`);
      if (/error|failed|invalid/i.test(r)) throw new Error(t('Yazılamadı @0x{0}: {1}', (addr + k).toString(16), r.trim().slice(0, 120)));
    }
  }

  // ---------------------------------------------------------------- ES-301: programlayıcı
  /** OpenOCD'nin tanıdığı flash bankaları ve sektörleri (sürücü probe eder; hedef çalışırken de okunur) */
  async flashBanks() {
    const list = await this.tryCmd('flash list');
    const count = list.ok ? (list.out.match(/\bname\b/g) || []).length : 1;
    const banks = [];
    for (let i = 0; i < Math.max(1, count); i++) {
      const r = await this.tryCmd(`flash info ${i}`, 15000);
      const info = r.ok && parseFlashInfo(r.out);
      if (!info) {
        if (i === 0) throw new Error(t('Flash bilgisi okunamadı: {0}', r.out.slice(0, 200)));
        break;
      }
      banks.push(info);
    }
    return banks;
  }

  /** ES-302: dosya yazma (OpenOCD program: gereken sektörleri siler; .bin için başlangıç adresi) */
  async programFile(file, base, verify = true) {
    const r = await this.tryCmd(`program {${file.replace(/\\/g, '/')}}${verify ? ' verify' : ''}${base !== undefined ? ` 0x${(base >>> 0).toString(16)}` : ''}`, 300000);
    if (!r.ok || /error|failed|mismatch/i.test(r.out)) throw new Error(r.out.slice(0, 300) || t('Yazma başarısız.'));
    return r.out;
  }

  /** Durdurup (reset halt) sektör siler: flash erase_sector <bank> <ilk> <son> */
  async eraseSectors(bank, first, last) {
    await this.tryCmd('reset halt', 5000);
    const r = await this.tryCmd(`flash erase_sector ${bank} ${first} ${last}`, 300000);
    if (!r.ok || /error|failed/i.test(r.out)) throw new Error(r.out.slice(0, 300) || t('Silme başarısız.'));
    return r.out;
  }

  /** Tcl komutu; hata yanıtını ayırt etmek için catch ile: { ok, out } */
  async tryCmd(cmd, timeoutMs) {
    const rc = (await this.tcl.send(`catch {${cmd}} __es_r`, timeoutMs)).trim();
    const out = (await this.tcl.send('set __es_r')).trim();
    return { ok: rc === '0', out };
  }

  /**
   * ES-208: SWO yakalama. OpenOCD 0.12+ TPIU nesnesi (`tpiu names`), yoksa 0.11'in `tpiu config` komutu.
   * Ham ITM akışı OpenOCD'nin açtığı TCP portundan okunur.
   * @param {{ cpuHz: number, swoHz: number }} cfg @param {(b: Buffer) => void} onData
   */
  async startSwo(cfg, onData) {
    await this.stopSwo();
    const port = await freePort();
    const names = await this.tryCmd('tpiu names');
    let tpiu = '';
    if (names.ok && names.out) {
      tpiu = names.out.split(/\s+/)[0];
      await this.tryCmd(`${tpiu} disable`);
      const c = await this.tryCmd(`${tpiu} configure -protocol uart -output :${port} -traceclk ${Math.round(cfg.cpuHz)} -pin-freq ${Math.round(cfg.swoHz)}`);
      const e = c.ok ? await this.tryCmd(`${tpiu} enable`) : c;
      if (!e.ok) throw new Error(explainSwo(e.out));
    } else {
      const c = await this.tryCmd(`tpiu config internal :${port} uart off ${Math.round(cfg.cpuHz)} ${Math.round(cfg.swoHz)}`);
      if (!c.ok) throw new Error(explainSwo(c.out || names.out));
    }
    const sock = await new Promise((resolve, reject) => {
      const s = net.createConnection({ port, host: '127.0.0.1' }, () => resolve(s));
      s.on('error', (e) => reject(new Error(t('SWO veri portuna bağlanılamadı: {0}', e.message))));
    });
    sock.on('data', (d) => onData(d));
    sock.on('error', () => {});
    this.swo = { sock, tpiu };
  }

  async stopSwo() {
    const s = this.swo;
    if (!s) return;
    this.swo = null;
    s.sock.destroy();
    if (this.proc) await this.tryCmd(s.tpiu ? `${s.tpiu} disable` : 'tpiu config disable').catch(() => {});
  }

  /**
   * Semihosting: OpenOCD BKPT 0xAB'de durunca isteği karşılar ve devam ettirir. Çıktı openocd'nin stdout'una gelir.
   * @param {boolean} on @param {(s: string) => void} [onText]
   */
  async semihosting(on, onText) {
    const r = await this.tryCmd(`arm semihosting ${on ? 'enable' : 'disable'}`);
    if (!r.ok) throw new Error(t('Semihosting açılamadı: {0}', r.out.slice(0, 160)));
    this.semiSink = on ? onText : null;
  }

  /** stdout'tan gelen satırlar: günlük satırları ayıklanır, kalanı semihosting çıktısıdır */
  onStdout(s) {
    if (!this.semiSink) return;
    const text = s.split(/(?<=\n)/).filter((l) => !/^(Info|Warn|Error|Debug|User)\s*:/.test(l)).join('');
    if (text) this.semiSink(text);
  }
}

/** SWO açılamadığında anlaşılır açıklama */
function explainSwo(out) {
  if (/invalid command name|unknown command/i.test(out)) return t('Bu OpenOCD sürümü SWO yakalamayı desteklemiyor (0.11 ya da daha yenisi gerekir).');
  if (/not supported|unsupported|does not support/i.test(out)) return t('Prob SWO yakalamayı desteklemiyor ya da bu frekansı veremiyor: {0}', out.slice(0, 160));
  return t('SWO başlatılamadı: {0}', out.slice(0, 200) || '?');
}

/** Sık görülen openocd hatalarını anlaşılır mesaja çevirir (yüklemeyle aynı açıklamalar; sadece ST-Link'e özel değil). */
function explainOpenOcd(log) {
  if (/couldn't bind|Address already in use/i.test(log)) return t('TCL portu kullanımda: başka bir openocd açık olabilir.');
  if (/Can't find interface|Can't find target/i.test(log)) return t('OpenOCD yapılandırma dosyası bulunamadı: {0}', (log.match(/Can't find [^\n]+/) || [''])[0]);
  return explainFlashError(log) || '';
}

/** Çekirdeğe göre özel register'lar: ARMv6-M'de (M0/M0+) BASEPRI ve FAULTMASK yok */
const specialRegs = (cpu = {}) => (cpu.v6m ? ['msp', 'psp', 'primask', 'control'] : ['msp', 'psp', 'primask', 'basepri', 'faultmask', 'control']);

/** OpenOCD d0–d15 (64 bit, "0x" + 16 hane) → s0–s31; fpscr */
function splitFpu(regs) {
  const out = {};
  for (const [k, v] of Object.entries(regs)) {
    const m = /^d(\d+)$/.exec(k);
    if (m) {
      const h = v.slice(2).padStart(16, '0');
      out[`s${2 * Number(m[1])}`] = parseInt(h.slice(8), 16);
      out[`s${2 * Number(m[1]) + 1}`] = parseInt(h.slice(0, 8), 16);
    } else out[k] = parseInt(v, 16);
  }
  return out;
}

/** Boş bir TCP portu */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address();
      srv.close(() => resolve(typeof a === 'object' && a ? a.port : 6666));
    });
  });
}

// ------------------------------------------------------------------ Simülasyon
/** Simülasyondaki RTT kontrol bloğu ve tamponları (örnek değişkenlerin 0x20000080–0x2000013F aralığından sonra) */
const SIM_RTT = { cb: 0x20000400, name: 0x20000500, upBuf: 0x20000600, upSize: 512, downBuf: 0x20000800, downSize: 64, end: 0x20000840 };

class SimTarget {
  /** @param {{ peripherals: any[], expected: Map<number, number> }} model */
  constructor(model) {
    this.mode = 'sim';
    this.model = model;
    this.halted = false;
    this.t0 = Date.now();
    this.pc = 0x08000420;
    this.rttInit();
  }
  async connect() {}
  async disconnect() {
    await this.stopSwo();
    await this.semihosting(false);
  }
  async state() { return this.halted ? 'halted' : 'running'; }
  // Durunca simülasyon zamanı da durur (Live Watch değerleri donar)
  async halt() { if (!this.halted) this.haltMs = Date.now() - this.t0; this.halted = true; }
  async resume() { if (this.halted) this.t0 = Date.now() - (this.haltMs || 0); this.halted = false; }
  async step() { this.pc += 2; }
  async reset() {
    this.t0 = Date.now(); this.pc = 0x08000420; this.halted = false;
    if (this.faultCore) for (const a of [0xe000ed24, 0xe000ed28, 0xe000ed2c, 0xe000ed34, 0xe000ed38]) this.model.expected.delete(a);
    this.faultCore = null;
    this.rttInit(); // firmware yeniden başlarken RTT bloğunu baştan kurar
    if (this.swoState) Object.assign(this.swoState, { next0: 0, next1: 0, lastMs: 0 });
  }

  // ---------------------------------------------------------------- ES-208: RTT, SWO, semihosting benzetimi
  now() { return this.halted ? this.haltMs || 0 : Date.now() - this.t0; }
  setByte(a, b) {
    const w = (a & ~3) >>> 0, sh = (a & 3) * 8;
    const cur = this.model.expected.get(w) || 0;
    this.model.expected.set(w, ((cur & ~(0xff << sh)) | ((b & 0xff) << sh)) >>> 0);
  }
  getByte(a) { return ((this.model.expected.get((a & ~3) >>> 0) || 0) >>> ((a & 3) * 8)) & 0xff; }
  async writeBytes(addr, bytes) { bytes.forEach((b, k) => this.setByte(addr + k, b)); }

  /** SEGGER_RTT_Init() benzeri: 1 up ("Terminal", 512 B) + 1 down ("Terminal", 64 B) */
  rttInit() {
    const R = SIM_RTT, set = (a, v) => this.model.expected.set(a, v >>> 0);
    for (let a = R.cb; a < R.end; a += 4) set(a, 0);
    [...Buffer.from('SEGGER RTT', 'latin1')].forEach((b, k) => this.setByte(R.cb + k, b));
    [...Buffer.from('Terminal\0', 'latin1')].forEach((b, k) => this.setByte(R.name + k, b));
    set(R.cb + 16, 1); set(R.cb + 20, 1);
    const up = R.cb + 24, down = up + 24;
    set(up, R.name); set(up + 4, R.upBuf); set(up + 8, R.upSize);
    set(down, R.name); set(down + 4, R.downBuf); set(down + 8, R.downSize);
    this.rttNext = 0;
    this.rttLine = '';
  }

  /** Benzetilen firmware: saniyede bir satır yazar, down kanalından gelen satırı yankılar */
  rttTick() {
    if (this.halted) return;
    const R = SIM_RTT, ms = this.now();
    const get = (a) => this.model.expected.get(a) || 0, set = (a, v) => this.model.expected.set(a, v >>> 0);
    const up = R.cb + 24, down = up + 24;
    let out = '';
    let wr = get(down + 12), rd = get(down + 16);
    while (rd !== wr && rd < R.downSize) {
      const c = String.fromCharCode(this.getByte(R.downBuf + rd));
      rd = (rd + 1) % R.downSize;
      if (c === '\n') { out += `> echo: ${this.rttLine.replace(/\r$/, '')}\n`; this.rttLine = ''; } else this.rttLine += c;
    }
    set(down + 16, rd);
    if (ms - this.rttNext > 10000) this.rttNext = ms - (ms % 1000);
    for (; this.rttNext <= ms; this.rttNext += 1000) {
      out += `[${(this.rttNext / 1000).toFixed(1)} s] rtt: uwTick=${this.rttNext} adc_raw=${Math.round(2048 + 1500 * Math.sin(this.rttNext / 1500))}\n`;
    }
    // NO_BLOCK_SKIP: sığmayan satır atlanır
    wr = get(up + 12); rd = get(up + 16);
    const free = rd > wr ? rd - wr - 1 : R.upSize - wr + rd - 1;
    const bytes = Buffer.from(out, 'utf8');
    if (!bytes.length || bytes.length > free) return;
    for (const b of bytes) { this.setByte(R.upBuf + wr, b); wr = (wr + 1) % R.upSize; }
    set(up + 12, wr);
  }

  /** SWO: ITM/DWT register'larında açılanlara göre gerçek paket akışı üretir (çözücü de böylece denenir) */
  async startSwo(cfg, onData) {
    await this.stopSwo();
    this.swoState = { next0: 0, next1: 0, lastMs: this.now(), prev: new Map(), n: 0, cfg };
    onData(Buffer.from([0, 0, 0, 0, 0, 0x80]));
    this.swoTimer = setInterval(() => { if (!this.halted) this.swoTick(onData).catch(() => {}); }, 50);
  }
  async stopSwo() { clearInterval(this.swoTimer); this.swoTimer = null; }

  async swoTick(onData) {
    const st = this.swoState, ms = this.now();
    const get = (a) => this.model.expected.get(a) || 0;
    const tcr = get(trace.REG.ITM_TCR), ter = get(trace.REG.ITM_TER), ctrl = get(trace.REG.DWT_CTRL);
    if (!(tcr & 1)) return;
    const out = [];
    let lastTs = st.lastMs;
    const line = (port, text, at) => {
      if (!(ter & (1 << port))) return;
      if (tcr & 2) { out.push(...trace.itmTs(Math.max(1, (at - lastTs) * 1000))); lastTs = at; }
      for (const b of Buffer.from(text, 'utf8')) out.push(...trace.itmByte(port, b));
    };
    if (ms - st.next0 > 5000) st.next0 = ms;
    for (; st.next0 <= ms; st.next0 += 500) {
      line(0, `uwTick=${st.next0} adc_raw=${Math.round(2048 + 1500 * Math.sin(st.next0 / 1500))} temp=${(24 + 3 * Math.sin(st.next0 / 4000)).toFixed(2)}\n`, st.next0);
    }
    if (ms - st.next1 > 5000) st.next1 = ms;
    for (; st.next1 <= ms; st.next1 += 2000) line(1, `[log] heartbeat #${++st.n}\n`, st.next1);
    // PC örnekleme (DWT_CTRL.PCSAMPLENA)
    if (ctrl & (1 << 12)) {
      const rate = (st.cfg.pcCfg && st.cfg.pcCfg.rate) || 1000;
      const count = Math.min(600, Math.round((rate * (ms - st.lastMs)) / 1000));
      const W = trace.SIM_FUNCS.reduce((s, f) => s + f.w, 0) + trace.SIM_SLEEP_W;
      for (let k = 0; k < count; k++) {
        let r = Math.random() * W;
        const f = trace.SIM_FUNCS.find((x) => (r -= x.w) < 0);
        if (!f) out.push(...trace.dwtPacket(2, 1, 0));
        else out.push(...trace.dwtPacket(2, 4, f.addr + 2 * Math.floor((Math.random() * f.size) / 2)));
      }
    }
    // Data trace: FUNCTION 2/3 olan karşılaştırıcılar; değer değişince yazma paketi
    for (let n = 0; n < trace.DWT_COMPARATORS; n++) {
      const base = trace.REG.DWT_COMP + n * 16, fn = get(base + 8);
      if ((fn & 0xf) !== 2 && (fn & 0xf) !== 3) continue;
      const addr = get(base), size = [1, 2, 4][(fn >> 10) & 3] || 4;
      const [w0, w1] = await this.readMemory(addr & ~3, 2);
      const v = Number((((BigInt(w1) << 32n) | BigInt(w0)) >> BigInt((addr & 3) * 8)) & ((1n << BigInt(size * 8)) - 1n));
      if (st.prev.get(n) === v) continue;
      st.prev.set(n, v);
      if ((fn & 0xf) === 3) out.push(...trace.dwtPacket(8 + 2 * n, 4, 0x08000650 + 0x1c));
      out.push(...trace.dwtPacket(16 + 2 * n + 1, size, v));
    }
    st.lastMs = ms;
    if (out.length) onData(Buffer.from(out));
  }

  /** Semihosting: çalışırken ara ara printf çıktısı */
  async semihosting(on, onText) {
    clearInterval(this.semiTimer);
    this.semiTimer = null;
    if (!on) return;
    let n = 0;
    this.semiTimer = setInterval(() => { if (!this.halted) onText(`semihosting: printf #${++n} from main() (uwTick=${this.now()})\n`); }, 1500);
  }

  /**
   * ES-207: fault benzetimi. SCB fault register'ları ve yığın çerçevesi yazılır, hedef HardFault işleyicisinde durur.
   * @param {{ CFSR: number, HFSR: number, BFAR?: number, MMFAR?: number, psp: boolean }} sc
   * @param {{ pc: number, lr: number }} at  çerçevedeki PC (fault anındaki komut) ve LR (çağıran)
   */
  async fault(sc, at) {
    const set = (a, v) => this.model.expected.set(a, v >>> 0);
    set(0xe000ed24, 0); set(0xe000ed28, sc.CFSR); set(0xe000ed2c, sc.HFSR);
    set(0xe000ed34, sc.MMFAR || 0); set(0xe000ed38, sc.BFAR || 0);
    const psp = 0x20001e40, msp = 0x2001ffa0;
    // PSP: görev yığını; MSP: işleyici push {r7, lr} yapmış (çerçeve 8 bayt ileride)
    const frameAt = sc.psp ? psp : msp + 8;
    const invstate = (sc.CFSR >>> 17) & 1;
    const frame = [0x20000104, 0, 0x2a, 0x40004400, 0x0c, at.lr | 1, at.pc & ~1, invstate ? 0 : 0x01000000];
    frame.forEach((v, i) => set(frameAt + i * 4, v));
    if (!sc.psp) { set(msp, 0x20020000); set(msp + 4, 0xfffffff9); }
    this.faultCore = { pc: 0x080001c4, lr: sc.psp ? 0xfffffffd : 0xfffffff9, sp: sc.psp ? msp : msp, msp, psp, xPSR: 0x01000003 };
    this.halted = true;
    this.haltMs = Date.now() - this.t0;
  }
  async program() { return t('simülasyon: yükleme atlandı'); }

  // ES-301: simülasyonda flash — silinmiş (0xFF) bellek ve başında örnek bir program
  simFlash() {
    if (this.flash) return this.flash;
    const f = this.model.flash || { base: 0x08000000, size: 512 * 1024, layout: [] };
    const bytes = new Uint8Array(f.size).fill(0xff);
    const words = new DataView(bytes.buffer);
    words.setUint32(0, 0x20020000, true); // ilk yığın işaretçisi
    for (let i = 1; i < 98; i++) words.setUint32(i * 4, 0x08000400 + 0x10 * i + 1, true); // vektörler (Thumb)
    let x = 0x1234567;
    for (let i = 0x400; i < Math.min(f.size, 0x3000); i++) { x = (x * 1103515245 + 12345) >>> 0; bytes[i] = x >>> 24; }
    this.flash = { ...f, bytes };
    return this.flash;
  }
  async flashBanks() {
    const f = this.simFlash();
    const banks = [];
    for (const s of f.layout) {
      if (!banks[s.bank]) banks[s.bank] = { driver: 'sim', base: s.addr, size: 0, sectors: [] };
      banks[s.bank].sectors.push({ num: s.num, addr: s.addr, size: s.size, protected: false });
      banks[s.bank].size += s.size;
    }
    return banks;
  }
  /** Silinmiş flash'a yazma: bitler yalnızca 1 → 0 değişir (gerçek flash gibi) */
  async writeFlash(addr, bytes, progress) {
    const f = this.simFlash();
    if (addr < f.base || addr + bytes.length > f.base + f.size) throw new Error(t('Adres flash dışında: 0x{0}', addr.toString(16)));
    for (let i = 0; i < bytes.length; i++) f.bytes[addr - f.base + i] &= bytes[i];
    progress && progress(bytes.length);
  }
  async eraseSectors(bank, first, last) {
    const f = this.simFlash();
    this.halted = true;
    for (const s of f.layout) if (s.bank === bank && s.num >= first && s.num <= last) f.bytes.fill(0xff, s.addr - f.base, s.addr - f.base + s.size);
    return '';
  }

  async readMemory(addr, words) {
    if (addr < SIM_RTT.end && addr + words * 4 > SIM_RTT.cb) this.rttTick();
    const ms = this.halted ? this.haltMs || 0 : Date.now() - this.t0;
    const out = [];
    for (let i = 0; i < words; i++) {
      const a = addr + i * 4;
      const fl = this.flash || (this.model.flash && a >= this.model.flash.base && a < this.model.flash.base + this.model.flash.size ? this.simFlash() : null);
      if (fl && a >= fl.base && a + 4 <= fl.base + fl.size) {
        out.push(new DataView(fl.bytes.buffer).getUint32(a - fl.base, true));
        continue;
      }
      let v = this.model.expected.get(a);
      if (v === undefined) v = 0;
      // Canlı değişen register'lar
      if (this.model.dynamic.has(a)) v = this.model.dynamic.get(a)(ms, this.halted) >>> 0;
      out.push(v >>> 0);
    }
    return out;
  }

  async coreRegisters(cpu = {}) {
    if (!this.halted) throw new Error(t('Core register\'ları okumak için hedefi durdurun.'));
    const r = {};
    CORE_REGS.forEach((n, i) => (r[n] = (0x1000 * i + 0x24) >>> 0));
    r.sp = 0x2001ffb0; r.lr = 0x08000a3d; r.pc = this.pc; r.xPSR = 0x61000000;
    for (const n of specialRegs(cpu)) r[n] = 0;
    r.msp = r.sp; r.psp = 0x20001f00;
    if (this.faultCore) Object.assign(r, this.faultCore);
    if (cpu.fpu) {
      for (let i = 0; i < 32; i++) r[`s${i}`] = 0;
      r.s0 = 0x3fc00000; // 1.5f
      r.fpscr = 0;
    }
    return r;
  }

  /** Simülasyonda yazılan değer modele işlenir (sonraki okumalarda görünür) */
  async writeMemory(addr, width, value) {
    const a = (addr & ~3) >>> 0, sh = (addr & 3) * 8;
    const m = width >= 32 ? 0xffffffff : (((1 << width) - 1) << sh) >>> 0;
    const cur = this.model.expected.get(a) || 0;
    this.model.expected.set(a, ((cur & ~m) | ((value << sh) & m)) >>> 0);
    this.model.dynamic.delete(a);
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

  // Beklenen register değerleri F4 register haritasına göre; diğer ailelerde sadece aileden bağımsız olanlar (GPIO v2, timer, ADC DR, UART BRR)
  const mcu = lib.mcus[design.mcuId];
  const fam = familyOf(mcu);
  const f4 = fam.key === 'f4';
  const c = clock.config;
  if (f4) {
  set(reg('RCC', 'CR'), 0x00000083 | (c.pllSource === 'HSE' || c.sysclkSource === 'HSE' ? 0x30000 : 0) | (c.sysclkSource === 'PLL' ? 0x3000000 : 0));
  set(reg('RCC', 'PLLCFGR'), c.M | (c.N << 6) | ((c.P / 2 - 1) << 16) | (c.pllSource === 'HSE' ? 1 << 22 : 0) | (c.Q << 24));
  const sw = { HSI: 0, HSE: 1, PLL: 2 }[c.sysclkSource];
  const HP = { 1: 0, 2: 8, 4: 9, 8: 10, 16: 11, 64: 12, 128: 13, 256: 14, 512: 15 }, PP = { 1: 0, 2: 4, 4: 5, 8: 6, 16: 7 };
  set(reg('RCC', 'CFGR'), sw | (sw << 2) | (HP[c.ahb] << 4) | (PP[c.apb1] << 10) | (PP[c.apb2] << 13));
  set(reg('FLASH', 'ACR'), clock.latency | 0x700);
  }

  const MODE = { in: 0, out: 1, af: 2, analog: 3 };
  for (const conn of result.connections) {
    const port = 'GPIO' + conn.mcuPin[1], n = Number(conn.mcuPin.slice(2));
    if (!base[port] || fam.ip.gpio !== 'v2') continue;
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
    if (p.type === 'i2c' && f4) {
      set(reg(name, 'CR1'), 0x1);
      set(reg(name, 'CR2'), Math.round(f.pclk1));
      set(reg(name, 'CCR'), p.speedHz > 100000 ? 0x8000 | Math.ceil((f.pclk1 * 1e6) / (3 * p.speedHz)) : Math.ceil((f.pclk1 * 1e6) / (2 * p.speedHz)));
      set(reg(name, 'TRISE'), p.speedHz > 100000 ? Math.floor(f.pclk1 * 0.3) + 1 : Math.round(f.pclk1) + 1);
      const sr2 = reg(name, 'SR2');
      if (sr2 !== undefined) dynamic.set(sr2, (ms) => (ms % 1000 < 60 ? 0x3 : 0));
    }
    if (p.type === 'spi' && f4) set(reg(name, 'CR1'), 0x344 | (3 << 3)), set(reg(name, 'SR'), 0x2);
    if (p.type === 'uart') {
      const pclk = mcu.peripherals[name] ? f[kernelClock(mcu, name)] : f.pclk1;
      set(reg(name, 'BRR'), Math.round((pclk * 1e6) / p.baud));
      if (f4) set(reg(name, 'CR1'), 0x200c | (p.telemetry ? 0 : 0x20));
      if (f4) set(reg(name, 'SR'), 0xc0);
    }
    if (p.type === 'adc') {
      if (f4) set(reg(name, 'CR2'), 1);
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
  if (f4) for (const [k, v] of Object.entries(en)) set(reg('RCC', k), v);
  const flash = { base: 0x08000000, size: mcu.device.flashKB * 1024, layout: flashLayout(mcu) };
  return { peripherals, expected, dynamic, flash };
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

module.exports = { OpenOcdTarget, SimTarget, SIM_RTT, explainSwo, TclClient, simModel, elfSymbols, explainOpenOcd, freePort, specialRegs, splitFpu, CORE_REGS };
