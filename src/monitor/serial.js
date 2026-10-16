// @ts-check
/**
 * Seri port terminali (ES-211). vscode'a bağlı değildir.
 *
 * Yerel `serialport` modülü kullanılmaz (her VS Code/Electron sürümü için derlenmiş ikili gerektirir):
 *  - Windows: serial-win.ps1 yardımcısı (.NET System.IO.Ports, PowerShell'de derlenir); stdin/stdout satır protokolü.
 *  - Linux / macOS: `stty` ile ayarlanan aygıt dosyası doğrudan okunur/yazılır (DTR/RTS ve break desteklenmez).
 *  - SIM: kart yokken denemek için 115200 baud'da telemetri satırları üreten, komutlara yanıt veren sanal aygıt.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const { t } = require('../i18n');

const BAUDS = [300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400, 460800, 921600, 1000000, 2000000];
const SIM_PORT = 'SIM';
const HELPER = path.join(__dirname, 'serial-win.ps1');
const PS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER];

const run = (file, args, timeout = 8000) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

/** Etkin port adları (hızlı; değişiklik denetimi için). Windows: HKLM\HARDWARE\DEVICEMAP\SERIALCOMM */
async function quickPorts() {
  if (process.platform === 'win32') {
    const out = await run('reg', ['query', 'HKLM\\HARDWARE\\DEVICEMAP\\SERIALCOMM'], 3000);
    return parseRegPorts(out);
  }
  return posixPorts().map((p) => p.path);
}

/** `reg query` çıktısı → ['COM3', 'COM5'] */
function parseRegPorts(out) {
  const ports = [];
  for (const line of String(out).split(/\r?\n/)) {
    const m = /\sREG_SZ\s+(COM\d+)\s*$/i.exec(line);
    if (m) ports.push(m[1].toUpperCase());
  }
  return [...new Set(ports)].sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
}

/** Linux: ttyACM/ttyUSB (+ /dev/serial/by-id adları); macOS: /dev/cu.* */
function posixPorts() {
  let devs = [];
  try { devs = fs.readdirSync('/dev'); } catch { return []; }
  const mac = process.platform === 'darwin';
  const names = new Map();
  if (!mac) {
    try {
      for (const id of fs.readdirSync('/dev/serial/by-id')) names.set(fs.realpathSync(path.join('/dev/serial/by-id', id)), id.replace(/^usb-/, '').replace(/-if\d+.*$/, '').replace(/_/g, ' '));
    } catch { /* by-id yok */ }
  }
  return devs.filter((d) => (mac ? /^cu\./.test(d) && !/Bluetooth|debug-console/i.test(d) : /^tty(ACM|USB|AMA)\d+$/.test(d)))
    .map((d) => `/dev/${d}`).map((p) => ({ path: p, name: names.get(p) || p }));
}

/**
 * Port listesi: { path, name, vcp? (ST-Link/J-Link sanal COM portu), sim? }. SIM her zaman sondadır.
 * @returns {Promise<{ path: string, name: string, vcp?: boolean, sim?: boolean }[]>}
 */
async function listPorts() {
  let ports = [];
  if (process.platform === 'win32') {
    try { ports = JSON.parse((await run('powershell.exe', [...PS, '-List'], 10000)) || '[]'); } catch { ports = []; }
    if (!Array.isArray(ports)) ports = [ports];
    // WMI yanıt vermezse kayıt defterindeki adlar
    if (!ports.length) ports = (await quickPorts()).map((p) => ({ path: p, name: p }));
  } else ports = posixPorts();
  return [
    ...ports.map((p) => ({ path: p.path, name: p.name || p.path, ...(/stlink|st-link|j-link|jlink|cmsis-dap|daplink|virtual com/i.test(p.name || '') ? { vcp: true } : {}) })),
    { path: SIM_PORT, name: t('Simülasyon (kart yok)'), sim: true }
  ];
}

/** Açılış hatalarını anlaşılır cümleye çevirir */
function explainOpen(msg, port) {
  if (/UnauthorizedAccess|denied|EACCES|EBUSY|busy/i.test(msg)) return t('{0} başka bir program tarafından kullanılıyor (Tera Term, PuTTY, monitör, debug oturumu?) ya da erişim izni yok.', port);
  if (/IOException|ENOENT|does not exist|yok|not found/i.test(msg) && !/semaphore|timeout/i.test(msg)) return t('{0} bulunamadı: kart çıkarılmış ya da port adı değişmiş olabilir.', port);
  if (/ArgumentOutOfRange|baud|speed|invalid argument/i.test(msg)) return t('Bu ayarlar ({0}) aygıt tarafından desteklenmiyor.', msg.replace(/^\w+: /, '').slice(0, 80));
  return msg;
}

const PARITY = { none: 'None', even: 'Even', odd: 'Odd', mark: 'Mark', space: 'Space' };
const STOP = { 1: 'One', 1.5: 'OnePointFive', 2: 'Two' };

/** stty bağımsız değişkenleri (Linux -F, macOS -f) */
function sttyArgs(o, mac = process.platform === 'darwin') {
  const a = [mac ? '-f' : '-F', o.path, String(o.baud), 'raw', '-echo', '-echoe', '-echok', `cs${o.dataBits}`, 'clocal', '-hupcl'];
  if (o.parity === 'none') a.push('-parenb');
  else a.push('parenb', o.parity === 'odd' || o.parity === 'mark' ? 'parodd' : '-parodd', ...(o.parity === 'mark' || o.parity === 'space' ? ['cmspar'] : []));
  a.push(Number(o.stopBits) === 2 ? 'cstopb' : '-cstopb');
  a.push(o.flow === 'rtscts' ? 'crtscts' : '-crtscts');
  a.push(...(o.flow === 'xonxoff' ? ['ixon', 'ixoff'] : ['-ixon', '-ixoff']));
  return a;
}

/** Ayarları denetler ve tamamlar */
function normalizeOptions(o) {
  const baud = Math.round(Number(o.baud));
  if (!(baud >= 50 && baud <= 12000000)) throw new Error(t('Geçersiz baud hızı: {0}', o.baud));
  const dataBits = [5, 6, 7, 8].includes(Number(o.dataBits)) ? Number(o.dataBits) : 8;
  return {
    path: String(o.path || ''), baud, dataBits, parity: PARITY[o.parity] ? o.parity : 'none', stopBits: STOP[o.stopBits] ? String(o.stopBits) : '1',
    flow: ['none', 'rtscts', 'xonxoff'].includes(o.flow) ? o.flow : 'none', dtr: o.dtr !== false, rts: o.rts !== false
  };
}

/**
 * Bir seri port oturumu. Olaylar: 'data' (Buffer), 'error' (Error), 'close'.
 */
class SerialSession extends EventEmitter {
  /** @param {any} opts */
  constructor(opts) {
    super();
    this.opts = normalizeOptions(opts);
    this.open_ = false;
    this.proc = null;
    this.fd = null;
    this.sim = null;
  }
  get isOpen() { return this.open_; }

  async open() {
    const o = this.opts;
    if (!o.path) throw new Error(t('Port seçilmedi.'));
    if (o.path === SIM_PORT) {
      this.sim = new SimDevice(o, (b) => this.emit('data', b));
      this.sim.start();
    } else if (process.platform === 'win32') await this.openWin();
    else await this.openPosix();
    this.open_ = true;
  }

  openWin() {
    const o = this.opts;
    return new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', [...PS, '-Port', o.path, '-Baud', String(o.baud), '-DataBits', String(o.dataBits), '-Parity', PARITY[o.parity],
        '-StopBits', STOP[o.stopBits], '-Flow', o.flow, '-Dtr', o.dtr ? '1' : '0', '-Rts', o.rts ? '1' : '0'], { windowsHide: true });
      this.proc = p;
      let buf = '', opened = false, err = '';
      p.stdout.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).replace(/\r$/, '');
          buf = buf.slice(i + 1);
          if (line === 'O') { opened = true; resolve(undefined); } else if (line.startsWith('D ')) this.emit('data', Buffer.from(line.slice(2), 'base64'));
          else if (line.startsWith('E ')) {
            err = line.slice(2);
            if (!opened) {
              reject(new Error(explainOpen(err, o.path)));
              this.proc = null;
              try { p.kill(); } catch { /* kapandı */ }
            }
            else this.emit('error', new Error(explainOpen(err, o.path)));
          }
        }
      });
      p.stderr.on('data', (d) => { err += String(d); });
      p.on('error', (e) => reject(new Error(t('PowerShell başlatılamadı: {0}', e.message))));
      p.on('exit', (code) => {
        const was = this.open_;
        this.open_ = false;
        this.proc = null;
        if (!opened) reject(new Error(explainOpen(err.trim() || t('yardımcı süreç kapandı (kod {0})', code), o.path)));
        else if (was) this.emit('close');
      });
    });
  }

  async openPosix() {
    const o = this.opts;
    await new Promise((resolve, reject) => execFile('stty', sttyArgs(o), (e, _out, stderr) => (e ? reject(new Error(explainOpen(String(stderr || e.message), o.path))) : resolve(undefined))));
    const fd = await new Promise((resolve, reject) => fs.open(o.path, fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK, (e, f) => (e ? reject(new Error(explainOpen(e.message, o.path))) : resolve(f))));
    this.fd = fd;
    const tty = require('tty');
    const rs = new tty.ReadStream(fd);
    this.rs = rs;
    rs.on('data', (d) => this.emit('data', Buffer.from(d)));
    rs.on('error', (e) => { if (this.open_) this.emit('error', new Error(explainOpen(e.message, o.path))); this.close(); });
  }

  /** @param {Buffer|Uint8Array} data */
  write(data) {
    if (!this.open_) throw new Error(t('Port açık değil.'));
    const b = Buffer.from(data);
    if (!b.length) return;
    if (this.sim) this.sim.receive(b);
    else if (this.proc) for (let k = 0; k < b.length; k += 3072) this.proc.stdin.write(`W ${b.subarray(k, k + 3072).toString('base64')}\n`);
    else if (this.fd !== null) fs.write(this.fd, b, (e) => { if (e) this.emit('error', e); });
  }

  /** DTR / RTS (yalnızca Windows; simülasyonda DTR düşüp kalkınca aygıt yeniden başlar) */
  signals(dtr, rts) {
    this.opts.dtr = !!dtr; this.opts.rts = !!rts;
    if (this.sim) this.sim.signals(!!dtr);
    else if (this.proc) this.proc.stdin.write(`S ${dtr ? 1 : 0} ${rts ? 1 : 0}\n`);
  }

  sendBreak(ms = 250) {
    if (this.proc) this.proc.stdin.write(`B ${Math.round(ms)}\n`);
  }

  async close() {
    const was = this.open_;
    this.open_ = false;
    if (this.sim) { this.sim.stop(); this.sim = null; }
    const p = this.proc;
    if (p) {
      this.proc = null;
      try { p.stdin.write('Q\n'); } catch { /* kapandı */ }
      setTimeout(() => { try { p.kill(); } catch { /* kapandı */ } }, 800);
    }
    if (this.rs) { this.rs.destroy(); this.rs = null; }
    if (this.fd !== null) { const fd = this.fd; this.fd = null; fs.close(fd, () => {}); }
    if (was) this.emit('close');
  }
}

/**
 * Simülasyon aygıtı: 115200 8N1'de telemetri satırları; "help", "ver", "led on/off", "status" komutlarına yanıt,
 * bilinmeyen satırı yankılar. Baud/çerçeve uyuşmazsa çöp bayt üretir (gerçek karttaki gibi).
 */
class SimDevice {
  constructor(o, emit) {
    this.o = o;
    this.emit = emit;
    this.timer = null;
    this.n = 0;
    this.line = '';
    this.t0 = Date.now();
    this.led = false;
  }
  get matched() { return this.o.baud === 115200 && this.o.dataBits === 8 && this.o.parity === 'none'; }
  send(s) {
    if (this.matched) return this.emit(Buffer.from(s, 'utf8'));
    // Yanlış hız: her bayt rastgele bozulur
    const b = Buffer.from(s, 'utf8');
    for (let i = 0; i < b.length; i++) b[i] = (b[i] * 37 + 101 + (i * 13)) & 0xff;
    this.emit(b);
  }
  start() {
    this.t0 = Date.now();
    this.send('\r\nEmbedded Studio demo firmware v1.2 (simulation)\r\nType "help" for commands.\r\n');
    this.timer = setInterval(() => {
      const ms = Date.now() - this.t0;
      this.n++;
      this.send(`[${(ms / 1000).toFixed(3)}] temp=${(24 + 2 * Math.sin(ms / 3000)).toFixed(2)} adc=${Math.round(2048 + 1500 * Math.sin(ms / 1700))} led=${this.led ? 1 : 0}\r\n`);
    }, 1000);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  signals(dtr) {
    // DTR düşen kenarı: Arduino tarzı reset
    if (!dtr) { this.stop(); this.dtrLow = true; } else if (this.dtrLow) { this.dtrLow = false; this.start(); }
  }
  receive(b) {
    if (!this.matched) return;
    for (const c of b.toString('latin1')) {
      if (c === '\r' || c === '\n') {
        const cmd = this.line.trim();
        this.line = '';
        if (cmd) this.command(cmd);
      } else this.line += c;
    }
  }
  command(cmd) {
    const c = cmd.toLowerCase();
    if (c === 'help') this.send('commands: help, ver, status, led on, led off, dump\r\n');
    else if (c === 'ver') this.send('fw 1.2.0 (sim) build 2026-10-17\r\n');
    else if (c === 'status') this.send(`uptime=${Math.round((Date.now() - this.t0) / 1000)}s led=${this.led ? 'on' : 'off'} heap=12480\r\n`);
    else if (c === 'led on' || c === 'led off') { this.led = c === 'led on'; this.send(`OK led ${this.led ? 'on' : 'off'}\r\n`); }
    else if (c === 'dump') this.emit(Buffer.from([0xaa, 0x55, 0x01, 0x10, ...[...Array(16).keys()], 0x00, 0xff, 0x0d, 0x0a]));
    else this.send(`ERR unknown command: ${cmd}\r\n`);
  }
}

/** Yerel saat: SS:DD:ss.mmm */
const clock = (at) => { const d = new Date(at); return `${[d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':')}.${String(d.getMilliseconds()).padStart(3, '0')}`; };

/**
 * Log dosyası: ham (yalnızca gelen baytlar) ya da metin (satır başına zaman damgası, gönderilenler "> " ile).
 */
class SerialLog {
  /** @param {string} file @param {'text'|'raw'} format */
  constructor(file, format) {
    this.file = file;
    this.format = format;
    this.stream = fs.createWriteStream(file, { flags: 'a' });
    this.partial = '';
    this.bytes = 0;
  }
  /** @param {'rx'|'tx'} dir @param {Buffer} data */
  write(dir, data, at = Date.now()) {
    if (this.format === 'raw') {
      if (dir === 'rx') { this.stream.write(data); this.bytes += data.length; }
      return;
    }
    const stamp = () => `[${clock(at)}] `;
    if (dir === 'tx') {
      const text = `${this.partial ? '\n' : ''}${stamp()}> ${data.toString('utf8').replace(/\r?\n$/, '').replace(/\r/g, '')}\n`;
      this.partial = '';
      this.stream.write(text);
      this.bytes += text.length;
      return;
    }
    let out = '';
    for (const ch of data.toString('utf8').replace(/\r\n?/g, '\n')) {
      if (!this.partial) out += stamp();
      if (ch === '\n') { out += '\n'; this.partial = ''; } else { out += ch; this.partial = 'x'; }
    }
    this.stream.write(out);
    this.bytes += out.length;
  }
  close() { return new Promise((r) => this.stream.end(r)); }
}

module.exports = { BAUDS, SIM_PORT, quickPorts, parseRegPorts, posixPorts, listPorts, explainOpen, sttyArgs, normalizeOptions, SerialSession, SimDevice, SerialLog, clock };
