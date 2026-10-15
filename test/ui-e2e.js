// Uçtan uca arayüz testi: gerçek eklenti kodu (sahte vscode API ile) + gerçek webview (headless Edge/Chrome).
// İkisi bir HTTP köprüsüyle konuşur; test, Chrome DevTools Protocol ile gerçek fare/klavye olayları gönderir
// ve her adımın ekran görüntüsünü alır.
//
// Çalıştırma: node test/ui-e2e.js <çalışma klasörü> <paket önbelleği> [tarayıcı yolu]
// Gerekenler: Node 22+ (WebSocket), Edge veya Chrome, git/cmake/ninja/arm-none-eabi-gcc (derleme adımı için).
const http = require('http');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { spawn, execSync } = require('child_process');
const assert = require('assert');

const EXT = path.join(__dirname, '..');
const WORK = path.resolve(process.argv[2] || path.join(require('os').tmpdir(), 'es-ui-e2e'));
const CACHE = path.resolve(process.argv[3] || path.join(WORK, 'cache'));
const BROWSER = process.argv[4] || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const PORT = 47311, CDP_PORT = 9333;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROJECT = path.join(WORK, 'proje');
const SHOTS = path.join(WORK, 'shots');

// ------------------------------------------------------------------ sahte vscode API
const sse = [];
const backlog = [];
const recorded = { external: [], tasks: [], info: [], warn: [], errors: [], openFolder: [] };
let toWebview = (m) => { const line = `data: ${JSON.stringify(m)}\n\n`; if (!sse.length) backlog.push(line); sse.forEach((r) => r.write(line)); };
let onWebviewMessage = null;
const dialogQueue = [];
const uriOf = (p) => ({ fsPath: p, path: p, toString: () => p });
const vscodeFake = {
  Uri: { file: uriOf, parse: (u) => ({ fsPath: u, toString: () => u }), joinPath: (u, ...parts) => uriOf(path.join(u.fsPath, ...parts)) },
  ViewColumn: { One: 1, Beside: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, TaskScope: { Workspace: 2 },
  Task: class { constructor(def, scope, name, source, exec) { Object.assign(this, { def, scope, name, source, exec }); } },
  ShellExecution: class { constructor(cmd, opts) { Object.assign(this, { cmd, opts }); } },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...a) => recorded.openFolder.push(a) },
  workspace: { workspaceFolders: [{ uri: uriOf(PROJECT) }], openTextDocument: async () => ({}) },
  window: {
    createStatusBarItem: () => ({ show() {}, dispose() {} }),
    createOutputChannel: () => ({ append() {}, appendLine() {} }),
    createWebviewPanel: () => ({
      webview: {
        cspSource: ORIGIN,
        asWebviewUri: (u) => `${ORIGIN}/fs/${encodeURIComponent(u.fsPath)}`,
        set html(v) { this._html = v; }, get html() { return this._html; },
        onDidReceiveMessage: (fn) => { onWebviewMessage = fn; },
        postMessage: (m) => toWebview(m)
      },
      onDidDispose: () => {}, reveal() {}
    }),
    showOpenDialog: async () => dialogQueue.shift(),
    showInformationMessage: async (msg, ...items) => { recorded.info.push(msg); return items.includes('İndir') ? 'İndir' : undefined; },
    showWarningMessage: async (msg, opts, ...items) => { recorded.warn.push(msg); return items[0]; },
    showErrorMessage: async (msg) => { recorded.errors.push(msg); },
    showTextDocument: async () => {},
    withProgress: async (o, fn) => fn({ report() {} })
  },
  tasks: { executeTask: async (t) => recorded.tasks.push(t), onDidEndTaskProcess: () => ({ dispose() {} }) },
  env: { openExternal: async (u) => recorded.external.push(String(u.toString ? u.toString() : u)) }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeFake };

// createWebviewPanel'ı sar: son webview'ı tut
let lastWebview = null;
const origCreate = vscodeFake.window.createWebviewPanel;
vscodeFake.window.createWebviewPanel = (...a) => { const p = origCreate(...a); lastWebview = p.webview; return p; };

// ------------------------------------------------------------------ köprü sunucusu
function startServer(getHtml) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(getHtml());
      }
      if (req.url === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (req.url === '/events') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write(':ok\n\n');
        sse.push(res);
        backlog.splice(0).forEach((l) => res.write(l));
        return;
      }
      if (req.url === '/msg' && req.method === 'POST') {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => { res.end('ok'); onWebviewMessage && onWebviewMessage(JSON.parse(body)); });
        return;
      }
      if (req.url.startsWith('/fs/')) {
        const p = decodeURIComponent(req.url.slice(4).split('?')[0]);
        if (!fs.existsSync(p)) { res.writeHead(404); return res.end(); }
        const type = { '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(p)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        return res.end(fs.readFileSync(p));
      }
      res.writeHead(404);
      res.end();
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

// ------------------------------------------------------------------ CDP
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.logs = []; ws.onmessage = (e) => this.onMsg(JSON.parse(e.data)); }
  onMsg(m) {
    if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result); }
    if (m.method === 'Runtime.exceptionThrown') this.logs.push('EXCEPTION ' + JSON.stringify(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') this.logs.push('console.error ' + m.params.args.map((a) => a.value || a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') this.logs.push('log ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
  }
  send(method, params = {}) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params })); return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async rect(sel) {
    const r = await this.eval(`(() => { const el = ${sel.startsWith('(') ? sel : `document.querySelector(${JSON.stringify(sel)})`}; if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
    if (!r) throw new Error('Bulunamadı: ' + sel);
    return r;
  }
  async mouse(type, x, y, button = 'none', clickCount = 0) { await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 0 }); }
  async click(sel, button = 'left') {
    const { x, y } = await this.rect(sel);
    await this.mouse('mouseMoved', x, y);
    await this.mouse('mousePressed', x, y, button, 1);
    await this.mouse('mouseReleased', x, y, button, 1);
    await sleep(120);
  }
  async hover(sel) { const { x, y } = await this.rect(sel); await this.mouse('mouseMoved', x, y); }
  async key(key, code, vk) {
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk });
  }
  async type(text) { await this.send('Input.insertText', { text }); }
  async shot(name) {
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`    📷 ${name}.png`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 8000, what = 'koşul') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('Zaman aşımı: ' + what);
    await sleep(100);
  }
}

// ------------------------------------------------------------------ test
(async () => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.rmSync(SHOTS, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(SHOTS, { recursive: true });
  // Paket önbelleğini eklentinin global depolamasına bağla (yeniden indirmemek için)
  const globalStorage = path.join(WORK, 'global');
  fs.mkdirSync(globalStorage, { recursive: true });
  if (fs.existsSync(CACHE) && !fs.existsSync(path.join(globalStorage, 'packs'))) fs.cpSync(CACHE, path.join(globalStorage, 'packs'), { recursive: true });

  const cmds = {};
  vscodeFake.commands.registerCommand = (id, fn) => { cmds[id] = fn; return { dispose() {} }; };
  const ext = require(path.join(EXT, 'src/extension.js'));
  const ctx = { extensionPath: EXT, extensionUri: uriOf(EXT), globalStorageUri: uriOf(globalStorage), subscriptions: [] };
  ext.activate(ctx);
  await cmds['embeddedStudio.openDesigner']();

  console.log('Tarayıcı başlatılıyor…');
  // Webview HTML'ini yakalamak için createWebviewPanel'ı sarmaladık; en son webview'ı bul
  const srv = await startServer(() => {
    const raw = lastWebview._html;
    const n = /nonce-([a-z0-9]+)/.exec(raw)[1];
    const shim = `<script nonce="${n}">
      (function(){ let st; const q = []; let open = false;
        window.acquireVsCodeApi = () => ({ getState: () => st, setState: (s) => { st = s; }, postMessage: (m) => { const send = () => fetch('/msg', { method: 'POST', body: JSON.stringify(m) }); open ? send() : q.push(send); } });
        const es = new EventSource('/events'); es.onopen = () => { open = true; q.splice(0).forEach((f) => f()); }; es.onmessage = (e) => window.postMessage(JSON.parse(e.data), '*');
      })();</script>`;
    return raw.replace("default-src 'none';", `default-src 'none'; connect-src ${ORIGIN};`).replace('<div id="app"></div>', `<div id="app"></div>\n${shim}`)
      .replace('</head>', `<style>:root{--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-sideBar-background:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#026ec1;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#ccc;--vscode-menu-selectionBackground:#0078d4;--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace}</style></head>`);
  });
  const profile = path.join(WORK, 'edge-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,920', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  const targets = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch { return null; } }, 15000, 'tarayıcı');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Page.navigate', { url: ORIGIN + '/' });
  const steps = [];
  const step = async (name, fn) => {
    try { await fn(); steps.push([name, true]); console.log(`  ✓ ${name}`); }
    catch (e) { steps.push([name, false, e.message]); console.log(`  ✗ ${name}: ${e.message}`); await cdp.shot('HATA_' + name.replace(/\W+/g, '_')).catch(() => {}); }
  };
  const design = () => JSON.parse(fs.readFileSync(path.join(PROJECT, 'embedded-studio.json'), 'utf8'));
  const count = (sel) => cdp.eval(`document.querySelectorAll(${JSON.stringify(sel)}).length`);

  console.log('Senaryo');
  await step('Karşılama sihirbazı görünür', async () => {
    await until(() => cdp.eval(`document.body.classList.contains('welcome-mode') && !!document.querySelector('#w-create')`), 8000, 'sihirbaz');
    await cdp.shot('01-sihirbaz');
  });
  await step('Sihirbaz: HAL + FreeRTOS projesi oluştur', async () => {
    await cdp.eval(`document.querySelector('#w-name').value=''`);
    await cdp.click('#w-name');
    await cdp.type('demo_proje');
    await cdp.click(`(document.querySelector('input[name=rtos][value=true]').closest('label'))`);
    await cdp.click('#w-create');
    await until(() => fs.existsSync(path.join(PROJECT, 'embedded-studio.json')), 60000, 'tasarım dosyası');
    await until(() => cdp.eval(`!document.body.classList.contains('welcome-mode') && document.querySelectorAll('#schematic .comp').length >= 1`), 10000, 'tasarım ekranı');
    const d = design();
    assert.strictEqual(d.project.name, 'demo_proje');
    assert.strictEqual(d.framework, 'hal');
    assert.strictEqual(d.rtos, true);
    assert.ok(fs.existsSync(path.join(PROJECT, 'Drivers/STM32F4xx_HAL_Driver/Inc/stm32f4xx_hal.h')), 'HAL kopyalanmalı');
    assert.ok(fs.existsSync(path.join(PROJECT, '.vscode/settings.json')));
  });
  await step('Kütüphaneden komponent ekle (6 adet) + otomatik kayıt', async () => {
    for (const name of ['BME280', 'MPU-6050', 'SSD1306 OLED 128x64', 'u-blox NEO-6M GPS', 'LED', 'Servo SG90']) {
      await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === ${JSON.stringify(name)}))`);
      await sleep(250);
    }
    await until(() => design().instances.length === 7, 5000, 'otomatik kayıt');
    await until(() => cdp.eval(`document.querySelector('#save-state').textContent.includes('Kaydedildi') || document.querySelector('#save-state').textContent.includes('Otomatik')`), 4000, 'kaydedildi göstergesi');
    await sleep(400);
    await cdp.shot('02-tasarim');
  });
  await step('Komponent üzerine gelince bilgi kartı (resimli)', async () => {
    await cdp.hover(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('MPU6050_1')).querySelector('.sym-body'))`);
    await until(() => cdp.eval(`!!document.querySelector('.popover .card-art svg')`), 3000, 'popover');
    await cdp.shot('03-bilgi-karti');
    await cdp.mouse('mouseMoved', 5, 5);
  });
  await step('Sağ tık menüsü: Bağlantılar, Aynala, Datasheet, Sil', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('BME280_1')).querySelector('.sym-body'))`, 'right');
    const labels = await cdp.eval(`[...document.querySelectorAll('.ctx-menu .ctx-label')].map((e) => e.textContent)`);
    assert.deepStrictEqual(labels, ['Bağlantılar…', 'Yönü değiştir (aynala)', 'Datasheet', 'Sil']);
    assert.ok(await cdp.eval(`!!document.querySelector('.ctx-menu .ctx-item svg rect[fill="#e5484d"]')`), 'PDF ikonu');
    await cdp.shot('04-sag-tik');
  });
  await step('Bağlantılar penceresi: pin değiştir + Kaydet', async () => {
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Bağlantılar')))`);
    await until(() => cdp.eval(`!!document.querySelector('.modal')`), 2000, 'modal');
    await cdp.eval(`(() => { const s = document.querySelector('.modal table.pins select'); s.value = 'PB8'; s.dispatchEvent(new Event('change')); })()`);
    await cdp.shot('05-baglantilar-penceresi');
    assert.ok(!design().locks['c' + ''], 'Kaydet öncesi değişmemeli');
    const before = JSON.stringify(design().locks);
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Kaydet'))`);
    await until(() => JSON.stringify(design().locks) !== before, 4000, 'kilit kaydı');
    const locks = Object.values(design().locks);
    assert.ok(locks.includes('PB8'));
  });
  await step('Bağlantılar penceresi: Kapat değişiklikleri atar', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('LED_1')).querySelector('.sym-body'))`, 'right');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Bağlantılar')))`);
    await cdp.eval(`(() => { const s = document.querySelector('.modal table.pins select'); s.value = 'PA0'; s.dispatchEvent(new Event('change')); })()`);
    const before = JSON.stringify(design());
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Kapat'))`);
    await sleep(800);
    assert.strictEqual(JSON.stringify(design()), before);
  });
  await step('Aynala (yön değiştir)', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('BME280_1')).querySelector('.sym-body'))`, 'right');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('aynala')))`);
    await until(() => design().instances.find((i) => i.label === 'BME280_1').mirror === true, 3000, 'mirror');
    await sleep(300);
    await cdp.shot('06-aynalanmis');
  });
  await step('Datasheet indir (PDF) ve aç', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('BME280_1')).querySelector('.sym-body'))`, 'right');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Datasheet')))`);
    const f = path.join(PROJECT, 'docs/datasheets/bme280.pdf');
    await until(() => fs.existsSync(f), 60000, 'PDF indirme');
    assert.strictEqual(fs.readFileSync(f).subarray(0, 5).toString(), '%PDF-');
    await until(() => recorded.external.some((u) => u.endsWith('bme280.pdf')), 3000, 'PDF açma');
  });
  await step('Seçip Delete ile silme', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('LED_1')).querySelector('.sym-body'))`);
    assert.ok(await cdp.eval(`!!document.querySelector('#schematic .comp.sel')`), 'seçim');
    await cdp.key('Delete', 'Delete', 46);
    await until(() => !design().instances.some((i) => i.label === 'LED_1'), 3000, 'silme');
  });
  await step('Backspace ile silme', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('SERVO_SG90_1')).querySelector('.sym-body'))`);
    await cdp.key('Backspace', 'Backspace', 8);
    await until(() => !design().instances.some((i) => i.label === 'SERVO_SG90_1'), 3000, 'silme');
  });
  await step('Sağ tık → Komponent ekle (aramalı alt menü)', async () => {
    const r = await cdp.rect('#schematic');
    await cdp.mouse('mouseMoved', r.x - r.w / 2 + 40, r.y + r.h / 2 - 40);
    await cdp.mouse('mousePressed', r.x - r.w / 2 + 40, r.y + r.h / 2 - 40, 'right', 1);
    await cdp.mouse('mouseReleased', r.x - r.w / 2 + 40, r.y + r.h / 2 - 40, 'right', 1);
    await cdp.hover(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Komponent ekle')))`);
    await until(() => cdp.eval(`!!document.querySelector('.ctx-sub input')`), 2000, 'alt menü');
    await cdp.type('pot');
    await sleep(150);
    await cdp.shot('07-sag-tik-ekle');
    await cdp.click(`([...document.querySelectorAll('.ctx-sub .ctx-item')].find((e) => e.textContent.includes('Potansiyometre')))`);
    await until(() => design().instances.some((i) => i.componentId === 'potentiometer'), 3000, 'ekleme');
  });
  await step('Kütüphane > Ekle: JSON komponent yükleme', async () => {
    const f = path.join(WORK, 'bmp180.json');
    const lib = require(path.join(EXT, 'src/library.js'));
    const tpl = lib.componentTemplate();
    delete tpl.image;
    fs.writeFileSync(f, JSON.stringify(tpl, null, 2));
    dialogQueue.push([uriOf(f)]);
    await cdp.click('#lib-add');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('yükle')))`);
    await until(() => cdp.eval(`[...document.querySelectorAll('.lib-item .name')].some((e) => e.textContent === 'BMP180')`), 4000, 'yüklenen komponent');
    assert.ok(fs.existsSync(path.join(PROJECT, '.embedded-studio/components/bmp180.json')));
    // bozuk dosya reddedilmeli
    const bad = path.join(WORK, 'bozuk.json');
    fs.writeFileSync(bad, JSON.stringify({ id: 'Bozuk Ad', interface: 'can', pins: [] }));
    dialogQueue.push([uriOf(bad)]);
    await cdp.click('#lib-add');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('yükle')))`);
    await until(() => recorded.errors.some((m) => m.includes('bozuk.json')), 3000, 'hata mesajı');
    await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'BMP180'))`);
    await until(() => design().instances.some((i) => i.componentId === 'bmp180'), 3000, 'kullanıcı komponenti tasarımda');
  });
  await step('Asistan: öneri ve ekleme', async () => {
    await cdp.click('#ask');
    await cdp.type('Servo motoru potansiyometre ile kontrol eden bir cihaz');
    await cdp.click(`([...document.querySelectorAll('.dock-input button')].find((b) => b.textContent === 'Öner'))`);
    await until(() => cdp.eval(`document.querySelectorAll('.dock-log .msg').length > 0`), 3000, 'öneri');
    await cdp.click(`([...document.querySelectorAll('.dock-log .chip-btn')].find((b) => b.textContent.includes('Servo')))`);
    await until(() => design().instances.some((i) => i.componentId === 'servo_sg90'), 3000, 'öneriden ekleme');
    await sleep(300);
    await cdp.shot('08-asistan');
  });
  await step('Asistan notları başta kapalı; sağ panel gizlenip açılır', async () => {
    assert.strictEqual(await cdp.eval(`document.querySelector('#notes-box').open`), false);
    await cdp.click('#toggle-right');
    assert.ok(await cdp.eval(`document.querySelector('#design').classList.contains('no-right')`));
    await cdp.click('.dock-head');
    await sleep(300);
    await cdp.shot('09-panel-kapali');
    await cdp.click('.dock-head');
    await cdp.click('#toggle-right');
  });
  await step('Clock: geçersiz ayar kırmızı, otomatik çöz 84 MHz', async () => {
    await cdp.click('#tab-clock');
    await sleep(300);
    await cdp.eval(`(() => { const s = document.querySelector('select[aria-label=apb1]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
    await until(() => cdp.eval(`!!document.querySelector('.ck-freq.bad')`), 3000, 'hata vurgusu');
    await cdp.shot('10-clock-hata');
    await cdp.eval(`document.querySelector('#clk-target').value = '84'`);
    await cdp.click(`([...document.querySelectorAll('.clock-bar button')].find((b) => b.textContent === 'Otomatik çöz'))`);
    await until(() => cdp.eval(`document.querySelector('#clk-summary').textContent.startsWith('SYSCLK 84 MHz') && !document.querySelector('.ck-freq.bad')`), 3000, 'çözüm');
    await sleep(500);
    await cdp.shot('11-clock');
  });
  await step('Kod Üret: dosyalar + ikinci üretimde dosyalara dokunulmaz', async () => {
    await cdp.click('#generate');
    await until(() => fs.existsSync(path.join(PROJECT, 'Core/Src/app.c')), 20000, 'kod üretimi');
    assert.ok(fs.existsSync(path.join(PROJECT, 'AGENTS.md')));
    assert.ok(/clk\.APB1CLKDivider|osc\.PLL\.PLLN = /.test(fs.readFileSync(path.join(PROJECT, 'Core/Src/board.c'), 'utf8')));
    const mtime = fs.statSync(path.join(PROJECT, 'Core/Src/app.c')).mtimeMs;
    recorded.info.length = 0;
    await cdp.click('#generate');
    await until(() => recorded.info.some((m) => m.includes('Kod güncel')), 8000, '"kod güncel" mesajı');
    assert.strictEqual(fs.statSync(path.join(PROJECT, 'Core/Src/app.c')).mtimeMs, mtime);
  });
  await step('Üretilen proje derlenir (cmake + arm-none-eabi-gcc)', async () => {
    execSync('cmake -S . -B build -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake', { cwd: PROJECT, stdio: 'pipe' });
    const out = execSync('cmake --build build', { cwd: PROJECT, stdio: 'pipe' }).toString();
    assert.ok(fs.existsSync(path.join(PROJECT, 'build/demo_proje.elf')));
    const warn = out.split('\n').filter((l) => /warning:/.test(l) && /Core|Components/.test(l));
    assert.deepStrictEqual(warn, []);
  });
  await step('Kullanıcı kodu + sensör çıkarma: kod korunur, sürücü kaldırılır', async () => {
    const app = path.join(PROJECT, 'Core/Src/app.c');
    fs.writeFileSync(app, fs.readFileSync(app, 'utf8').replace('/* USER CODE BEGIN Globals */\n', '/* USER CODE BEGIN Globals */\nstatic uint32_t benim_sayacim;\n').replace('/* USER CODE BEGIN MPU6050_1 */\n', '/* USER CODE BEGIN MPU6050_1 */\nbenim_sayacim++;\n'));
    await cdp.click('#tab-design');
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('MPU6050_1')).querySelector('.sym-body'))`);
    await cdp.key('Delete', 'Delete', 46);
    await until(() => !design().instances.some((i) => i.label === 'MPU6050_1'), 3000, 'silme');
    await sleep(600);
    await cdp.click('#generate');
    await until(() => !fs.existsSync(path.join(PROJECT, 'Drivers/Components/mpu6050.c')), 10000, 'sürücü kaldırma');
    const t = fs.readFileSync(app, 'utf8');
    assert.ok(t.includes('static uint32_t benim_sayacim;'));
    assert.ok(/Orphaned MPU6050_1[\s\S]*benim_sayacim\+\+/.test(t));
    assert.ok(/Çıkarıldı: \*\*MPU6050_1\*\*/.test(fs.readFileSync(path.join(PROJECT, '.embedded-studio/LAST_CHANGES.md'), 'utf8')));
    execSync('cmake --build build', { cwd: PROJECT, stdio: 'pipe' });
    // IMU monitörü için geri ekle
    await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'MPU-6050'))`);
    await until(() => design().instances.some((i) => i.componentId === 'mpu6050'), 3000, 'geri ekleme');
  });
  await step('Monitör: canlı veri, 3B IMU, GPS, gösterge, task tablosu', async () => {
    await cdp.click('#tab-monitor');
    await cdp.click('#mon-toggle');
    await sleep(5000);
    assert.ok(await count('.w-card') >= 6);
    await until(async () => (await count('table.tasks tr')) >= 4, 6000, 'task tablosu').catch(async (e) => {
      throw new Error(e.message + ' | tasks: ' + await cdp.eval(`document.querySelectorAll('table.tasks').length + ' tablo, #tasks=' + document.querySelectorAll('#tasks').length + ' ' + (document.querySelector('#tasks') || {}).innerHTML?.slice(0, 160)`));
    });
    assert.ok(await cdp.eval(`(() => { const c = document.querySelector('.w-imu'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n > 1000; })()`), 'IMU canvas çizilmeli');
    await cdp.shot('12-monitor');
  });
  await step('Monitör düzenleme: tür değiştir, widget ekle', async () => {
    await cdp.click('#mon-edit');
    await cdp.eval(`(() => { const card = [...document.querySelectorAll('.w-card')].find((c) => c.querySelector('.w-title').textContent === 'POTENTIOMETER_1'); const s = card.querySelector('select'); s.value = 'chart'; s.dispatchEvent(new Event('change')); })()`);
    await until(() => (design().monitor || {}).widgets && design().monitor.widgets.some((w) => w.type === 'chart' && w.channels[0].startsWith('POTENTIOMETER_1')), 3000, 'düzen kaydı');
    await sleep(300);
    await cdp.shot('13-monitor-duzenle');
    await cdp.click(`([...document.querySelectorAll('.mon-bar button')].find((b) => b.textContent.includes('Widget')))`);
    await until(() => cdp.eval(`!!document.querySelector('.add-widget')`), 2000, 'widget penceresi');
    await cdp.eval(`(() => { const s = document.querySelector('.add-widget select'); s.value = [...s.options].findIndex((o) => o.textContent.startsWith('MPU6050_1')); s.dispatchEvent(new Event('change')); })()`);
    for (const id of ['ax', 'ay', 'az']) await cdp.click(`([...document.querySelectorAll('.add-widget .check')].find((l) => l.textContent.startsWith('${id}')))`);
    await cdp.eval(`(() => { const s = [...document.querySelectorAll('.add-widget select')][1]; s.value = 'axes'; s.dispatchEvent(new Event('change')); })()`);
    await cdp.shot('14-widget-ekle');
    const before = design().monitor.widgets.length;
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Ekle'))`);
    await until(() => design().monitor.widgets.length === before + 1 && design().monitor.widgets.some((w) => w.type === 'axes'), 3000, 'widget eklendi');
    await cdp.click('#mon-edit');
    await sleep(1200);
    await cdp.shot('15-monitor-son');
    await cdp.click('#mon-toggle');
  });
  await step('Debug (simülasyon): register, bit alanları, durdur, core, bellek, ELF değişkeni', async () => {
    await cdp.click('#tab-debug');
    await cdp.click('#dbg-conn');
    await until(() => cdp.eval(`document.querySelector('#dbg-state').textContent === 'ÇALIŞIYOR'`), 5000, 'bağlantı');
    await until(() => cdp.eval(`document.querySelectorAll('table.regs tr.reg').length > 3 && [...document.querySelectorAll('table.regs tr.reg .val')].some((e) => e.textContent.startsWith('0x'))`), 5000, 'register değerleri');
    await cdp.click(`([...document.querySelectorAll('.p-item')].find((e) => e.textContent.startsWith('GPIOB')))`);
    await sleep(800);
    await cdp.click(`([...document.querySelectorAll('tr.reg')].find((e) => e.textContent.includes('MODER')))`);
    await until(() => cdp.eval(`document.querySelectorAll('tr.field-row').length === 16`), 3000, 'bit alanları');
    await cdp.click('#dbg-halt');
    await until(() => cdp.eval(`document.querySelector('#dbg-state').textContent === 'DURDU' && document.querySelectorAll('table.regs.core tr').length === 17`), 4000, 'core register');
    await cdp.click(`([...document.querySelectorAll('.pane-head button')].find((b) => b.textContent.includes('ELF')))`);
    await sleep(800);
    await cdp.click('#dbg-sym');
    await cdp.type('bme280_1_ok');
    await cdp.click(`([...document.querySelectorAll('.sym')].find((e) => e.textContent.startsWith('bme280_1_ok')))`);
    await until(() => cdp.eval(`document.querySelectorAll('#dbg-watch tr').length === 1`), 3000, 'izleme');
    await sleep(800);
    await cdp.shot('16-debug');
  });
  await step('Debug: OpenOCD kart yokken anlaşılır hata', async () => {
    await cdp.click('#dbg-conn');
    await sleep(500);
    await cdp.eval(`(() => { const s = document.querySelector('#dbg-mode'); s.value = 'openocd'; s.dispatchEvent(new Event('change')); })()`);
    await cdp.click('#dbg-conn');
    await until(() => cdp.eval(`document.querySelector('#dbg-msg').classList.contains('error')`), 20000, 'hata mesajı');
    const msg = await cdp.eval(`document.querySelector('#dbg-msg').textContent`);
    assert.ok(/ST-Link|openocd/i.test(msg), msg);
    await cdp.shot('17-debug-openocd-hata');
  });
  await step('Tarayıcı konsolunda hata yok', async () => {
    assert.deepStrictEqual(cdp.logs, []);
  });

  const failed = steps.filter((s) => !s[1]);
  console.log(`\n${steps.length - failed.length}/${steps.length} adım geçti. Ekran görüntüleri: ${SHOTS}`);
  ws.close();
  browser.kill();
  srv.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

