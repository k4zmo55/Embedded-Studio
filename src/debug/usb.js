// @ts-check
/**
 * USB prob ve kart algılama (ES-202), yerel modül gerektirmeden:
 *  Windows : PowerShell + CIM (Win32_PnPEntity); tak/çıkar için Win32_DeviceChangeEvent dinleyen kalıcı süreç
 *  Linux   : /sys/bus/usb/devices ve /sys/class/tty (yoklama)
 *  macOS   : ioreg -p IOUSB (yoklama)
 * classify() saf fonksiyondur: ham USB listesinden problar, DFU önyükleyicisi ve UART köprüleri.
 */
const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

/** ST-Link ürün kimlikleri */
const STLINK = { 0x3744: 'V1', 0x3748: 'V2', 0x374B: 'V2-1', 0x374A: 'V2-1', 0x3752: 'V2-1', 0x374D: 'V3 (loader)', 0x374E: 'V3', 0x374F: 'V3', 0x3753: 'V3', 0x3754: 'V3', 0x3757: 'V3PWR' };
/** USB-UART köprüleri (UART önyükleyicisi ya da seri terminal için) */
const UART_BRIDGES = { 0x1A86: 'CH340/CH341', 0x10C4: 'CP210x', 0x0403: 'FTDI', 0x067B: 'PL2303' };

/**
 * @typedef {{ vid: number, pid: number, serial?: string, name?: string, port?: string, iface?: number }} UsbDevice
 * @typedef {{ kind: 'stlink'|'jlink'|'cmsis-dap'|'dfu'|'uart', label: string, serial?: string, port?: string, version?: string, interfaceCfg?: string }} Probe
 */

/** @param {UsbDevice[]} devices @returns {Probe[]} */
function classify(devices) {
  const probes = [];
  const byKey = new Map();
  const ports = devices.filter((d) => d.port);
  for (const d of devices.filter((x) => !x.port && x.iface === undefined)) {
    let p = null;
    if (d.vid === 0x0483 && STLINK[d.pid]) p = { kind: 'stlink', label: `ST-Link ${STLINK[d.pid]}`, version: STLINK[d.pid], interfaceCfg: 'interface/stlink.cfg' };
    else if (d.vid === 0x0483 && d.pid === 0xDF11) p = { kind: 'dfu', label: 'STM32 USB DFU (bootloader)' };
    else if (d.vid === 0x1366) p = { kind: 'jlink', label: 'SEGGER J-Link', interfaceCfg: 'interface/jlink.cfg' };
    else if ((d.vid === 0x0D28 && d.pid === 0x0204) || /CMSIS-DAP/i.test(d.name || '')) p = { kind: 'cmsis-dap', label: d.vid === 0x0D28 ? 'DAPLink (CMSIS-DAP)' : 'CMSIS-DAP', interfaceCfg: 'interface/cmsis-dap.cfg' };
    if (!p) continue;
    if (d.serial) p.serial = d.serial;
    const key = `${d.vid}:${d.pid}:${d.serial || probes.length}`;
    if (byKey.has(key)) continue;
    byKey.set(key, p);
    probes.push(p);
  }
  for (const d of ports) {
    // Probun sanal seri portu (ST-Link VCP): aynı VID/PID'li proba ekle
    const owner = d.vid === 0x0483 && STLINK[d.pid] ? probes.find((p) => p.kind === 'stlink' && (!d.serial || !p.serial || p.serial === d.serial)) : null;
    if (owner) owner.port = owner.port || d.port;
    else if (UART_BRIDGES[d.vid]) probes.push({ kind: 'uart', label: `${UART_BRIDGES[d.vid]} UART`, port: d.port });
  }
  return probes;
}

const run = (file, args, timeout = 8000) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout, maxBuffer: 1 << 22 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

/** "USB\VID_0483&PID_374B\066DFF485671..." → { vid, pid, serial, iface } */
function parseWinId(id) {
  const m = /VID_([0-9A-F]{4})&PID_([0-9A-F]{4})(?:&MI_([0-9A-F]{2}))?\\(.*)$/i.exec(id || '');
  if (!m) return null;
  // Bileşik aygıtın arayüz örneklerinde (MI_xx) seri numarası yerine "6&1a2b…&0&0000" gibi bir yol vardır
  const serial = m[3] || /&/.test(m[4]) ? undefined : m[4];
  return { vid: parseInt(m[1], 16), pid: parseInt(m[2], 16), iface: m[3] !== undefined ? parseInt(m[3], 16) : undefined, serial };
}

async function listWindows() {
  const ps = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance -ClassName Win32_PnPEntity -Filter \"PNPDeviceID LIKE 'USB%' OR PNPDeviceID LIKE 'FTDIBUS%'\" | Select-Object PNPDeviceID,Name | ConvertTo-Json -Compress";
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps]);
  let rows = [];
  try {
    rows = JSON.parse(out || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) rows = [rows];
  const devices = [];
  for (const r of rows) {
    const id = parseWinId(String(r.PNPDeviceID).replace(/^FTDIBUS\\VID_/i, 'USB\\VID_').replace(/\+PID_/i, '&PID_'));
    if (!id) continue;
    const port = (String(r.Name || '').match(/\((COM\d+)\)/) || [])[1];
    devices.push({ ...id, name: r.Name, ...(port ? { port, iface: id.iface } : {}) });
  }
  return devices;
}

function readSys(dir, f) {
  try {
    return fs.readFileSync(path.join(dir, f), 'utf8').trim();
  } catch {
    return undefined;
  }
}

async function listLinux() {
  const base = '/sys/bus/usb/devices';
  const devices = [];
  let names = [];
  try {
    names = fs.readdirSync(base);
  } catch {
    return [];
  }
  for (const n of names) {
    const dir = path.join(base, n);
    const vid = readSys(dir, 'idVendor');
    if (!vid) continue;
    devices.push({ vid: parseInt(vid, 16), pid: parseInt(readSys(dir, 'idProduct') || '0', 16), serial: readSys(dir, 'serial'), name: readSys(dir, 'product') });
  }
  for (const tty of (() => { try { return fs.readdirSync('/sys/class/tty').filter((x) => /^tty(ACM|USB)\d+$/.test(x)); } catch { return []; } })()) {
    let dir;
    try {
      dir = fs.realpathSync(path.join('/sys/class/tty', tty, 'device'));
    } catch {
      continue;
    }
    for (let i = 0; i < 3 && dir && !readSys(dir, 'idVendor'); i++) dir = path.dirname(dir);
    const vid = readSys(dir, 'idVendor');
    if (vid) devices.push({ vid: parseInt(vid, 16), pid: parseInt(readSys(dir, 'idProduct') || '0', 16), serial: readSys(dir, 'serial'), port: `/dev/${tty}` });
  }
  return devices;
}

async function listMac() {
  const out = await run('ioreg', ['-p', 'IOUSB', '-l', '-w0']);
  const devices = [];
  for (const block of out.split(/\+-o /).slice(1)) {
    const num = (k) => { const m = new RegExp(`"${k}" = (\\d+)`).exec(block); return m ? Number(m[1]) : undefined; };
    const str = (k) => (new RegExp(`"${k}" = "([^"]*)"`).exec(block) || [])[1];
    const vid = num('idVendor');
    if (vid === undefined) continue;
    devices.push({ vid, pid: num('idProduct') || 0, serial: str('USB Serial Number'), name: str('USB Product Name') });
  }
  try {
    for (const n of fs.readdirSync('/dev').filter((x) => /^cu\.(usbmodem|usbserial|SLAB|wchusbserial)/.test(x))) {
      // macOS'ta portun USB kimliği ioreg'den eşleştirilmeden: ST-Link VCP'si usbmodem olarak görünür
      devices.push({ vid: /usbmodem/.test(n) ? 0x0483 : 0x1A86, pid: /usbmodem/.test(n) ? 0x374B : 0, port: `/dev/${n}` });
    }
  } catch { /* /dev okunamadı */ }
  return devices;
}

/** Bağlı USB aygıtlarının ham listesi */
function listUsb() {
  if (process.platform === 'win32') return listWindows();
  if (process.platform === 'darwin') return listMac();
  return listLinux();
}

/**
 * Tak/çıkar izleyici: değişiklikte onChange çağrılır (Windows'ta olay, diğerlerinde 2-3 sn yoklama).
 * @returns {{ dispose(): void }}
 */
function watchUsb(onChange) {
  let timer = null, proc = null, last = '';
  const poll = async () => {
    const sig = JSON.stringify(await listUsb());
    if (sig !== last) {
      last = sig;
      onChange();
    }
  };
  if (process.platform === 'win32') {
    const ps = 'Register-WmiEvent -Class Win32_DeviceChangeEvent -SourceIdentifier es; while ($true) { $null = Wait-Event -SourceIdentifier es; Remove-Event -SourceIdentifier es; [Console]::Out.WriteLine("change"); [Console]::Out.Flush() }';
    let debounce = null;
    try {
      proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
      proc.stdout.on('data', () => {
        clearTimeout(debounce);
        debounce = setTimeout(onChange, 800); // sürücü kurulumu birkaç olay üretir
      });
      proc.on('error', () => { proc = null; timer = setInterval(poll, 3000); });
    } catch {
      timer = setInterval(poll, 3000);
    }
  } else {
    timer = setInterval(poll, process.platform === 'darwin' ? 3000 : 2000);
  }
  return {
    dispose() {
      clearInterval(timer);
      try { proc && proc.kill(); } catch { /* kapandı */ }
    }
  };
}

module.exports = { classify, parseWinId, listUsb, watchUsb, STLINK, UART_BRIDGES };
