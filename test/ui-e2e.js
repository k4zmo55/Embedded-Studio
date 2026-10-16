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
// Her çalıştırmada farklı port: önceki (takılmış) bir çalıştırmayla çakışmasın.
const PORT = 40000 + Math.floor(Math.random() * 9000), CDP_PORT = 30000 + Math.floor(Math.random() * 9000);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const PROJECT = path.join(WORK, 'proje');
const SHOTS = path.join(WORK, 'shots');
// Ortam seçenekleri: ES_THEME=light|dark, ES_SIZE=1100x700 (pencere), ES_SLOW=4 (işlemci yavaşlatma; zamanlama hatalarını yakalamak için)
const THEME = process.env.ES_THEME === 'light' ? 'light' : 'dark';
const [WIN_W, WIN_H] = (process.env.ES_SIZE || '1500x920').split('x').map(Number);
const SLOW = Number(process.env.ES_SLOW) || 0;
const THEMES = {
  dark: '--vscode-editor-background:#1f1f1f;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#2b2b2b;--vscode-sideBar-background:#181818;--vscode-list-hoverBackground:#2a2d2e;--vscode-list-activeSelectionBackground:#04395e;--vscode-focusBorder:#0078d4;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#026ec1;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-input-border:#3c3c3c;--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-menu-background:#1f1f1f;--vscode-menu-foreground:#ccc;--vscode-menu-selectionBackground:#0078d4;--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace',
  light: '--vscode-editor-background:#ffffff;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#717171;--vscode-panel-border:#e5e5e5;--vscode-sideBar-background:#f8f8f8;--vscode-list-hoverBackground:#f2f2f2;--vscode-list-activeSelectionBackground:#e4e6f1;--vscode-focusBorder:#005fb8;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-button-hoverBackground:#0258a8;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-badge-background:#cccccc;--vscode-badge-foreground:#3b3b3b;--vscode-menu-background:#ffffff;--vscode-menu-foreground:#3b3b3b;--vscode-menu-selectionBackground:#005fb8;--vscode-font-family:"Segoe UI",sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:Consolas,monospace;--vscode-errorForeground:#e51400;--vscode-editorWarning-foreground:#bf8803;--vscode-editorInfo-foreground:#1a85ff;--vscode-widget-shadow:rgba(0,0,0,.16)'
};

// ------------------------------------------------------------------ sahte vscode API
const sse = [];
const backlog = [];
const recorded = { external: [], tasks: [], info: [], warn: [], errors: [], openFolder: [] };
let toWebview = (m) => { const line = `data: ${JSON.stringify(m)}\n\n`; if (!sse.length) backlog.push(line); sse.forEach((r) => r.write(line)); };
let onWebviewMessage = null;
const dialogQueue = [];
const settings = {};
const configListeners = [];
const taskEndListeners = []; // test, görev bitişini (derleme sonrası boyut özeti) elle tetikler
const uriOf = (p) => ({ fsPath: p, path: p, toString: () => p });
const vscodeFake = {
  Uri: { file: uriOf, parse: (u) => ({ fsPath: u, toString: () => u }), joinPath: (u, ...parts) => uriOf(path.join(u.fsPath, ...parts)) },
  ViewColumn: { One: 1, Beside: 2 }, StatusBarAlignment: { Left: 1 }, ProgressLocation: { Notification: 15 }, TaskScope: { Workspace: 2 },
  Task: class { constructor(def, scope, name, source, exec) { Object.assign(this, { def, definition: def, scope, name, source, exec }); } },
  ShellExecution: class { constructor(cmd, opts) { Object.assign(this, { cmd, opts }); } },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async (...a) => recorded.openFolder.push(a) },
  workspace: {
    workspaceFolders: [{ uri: uriOf(PROJECT) }], openTextDocument: async () => ({}),
    getConfiguration: () => ({ get: (k, d) => (k in settings ? settings[k] : d) }),
    onDidChangeConfiguration: (fn) => { configListeners.push(fn); return { dispose() {} }; }
  },
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
  tasks: { executeTask: async (t) => recorded.tasks.push(t), onDidEndTaskProcess: (fn) => { taskEndListeners.push(fn); return { dispose() {} }; } },
  env: { language: 'tr', openExternal: async (u) => recorded.external.push(String(u.toString ? u.toString() : u)) }
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (req, ...rest) { return req === 'vscode' ? 'vscode' : origResolve.call(this, req, ...rest); };
require.cache.vscode = { id: 'vscode', filename: 'vscode', loaded: true, exports: vscodeFake };

// createWebviewPanel'ı sar: son webview'ı tut
let lastWebview = null;
let browserProc = null;
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
        req.on('close', () => { const i = sse.indexOf(res); if (i >= 0) sse.splice(i, 1); });
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
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP yanıt vermedi: ${method} ${JSON.stringify(params).slice(0, 160)}`)); }, 20000 * Math.max(1, SLOW));
      this.pending.set(id, { resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } });
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result.value;
  }
  async rect(sel) {
    const r = await this.eval(`(() => { const el = ${sel.startsWith('(') ? sel : `document.querySelector(${JSON.stringify(sel)})`}; if (!el) return null; el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; })()`);
    if (!r) throw new Error('Bulunamadı: ' + sel);
    return r;
  }
  async mouse(type, x, y, button = 'none', clickCount = 0) { await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount, buttons: button === 'left' ? 1 : button === 'right' ? 2 : 0 }); }
  async glide(x, y) {
    if (REC && this.lastX !== undefined) {
      const steps = 10;
      for (let i = 1; i < steps; i++) {
        const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        await this.mouse('mouseMoved', this.lastX + (x - this.lastX) * e, this.lastY + (y - this.lastY) * e);
        await sleep(22);
      }
    }
    this.lastX = x;
    this.lastY = y;
    await this.mouse('mouseMoved', x, y);
  }
  async click(sel, button = 'left') {
    const { x, y } = await this.rect(sel);
    await this.glide(x, y);
    await beat(180);
    await this.mouse('mousePressed', x, y, button, 1);
    await this.mouse('mouseReleased', x, y, button, 1);
    await sleep(120);
  }
  async hover(sel) { const { x, y } = await this.rect(sel); await this.glide(x, y); }
  async key(key, code, vk, modifiers = 0) { // modifiers: 2 = Ctrl, 8 = Shift
    await this.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: vk, modifiers });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vk, modifiers });
  }
  async type(text) {
    if (!REC) return this.send('Input.insertText', { text });
    for (const ch of text) { await this.send('Input.insertText', { text: ch }); await sleep(45); }
  }
  async shot(name) {
    let r;
    try {
      r = await this.send('Page.captureScreenshot', { format: 'png' });
    } catch (e) {
      // Bir kez daha dene: sayfayı öne getir, yeni kare iste
      await this.send('Page.bringToFront').catch(() => {});
      r = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    }
    fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log(`    📷 ${name}.png`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ demo kaydı (README GIF'leri)
// ES_RECORD=<klasör> verilirse sahneler JPEG kare olarak kaydedilir; imleç görünür olur, hareketler yumuşar.
const REC = process.env.ES_RECORD;
const rec = { scene: null, n: 0, busy: false };
const beat = (ms = 450) => (REC ? sleep(ms) : Promise.resolve());
function startRecorder(cdp) {
  if (!REC) return;
  fs.mkdirSync(REC, { recursive: true });
  setInterval(async () => {
    if (!rec.scene || rec.busy) return;
    rec.busy = true;
    try {
      // Doğrudan GIF boyutunda yakala (960 px): tam çözünürlük tarayıcıyı yavaşlatıyor
      const r = await cdp.send('Page.captureScreenshot', { format: 'jpeg', quality: 85, clip: { x: 0, y: 0, width: 1500, height: 920, scale: 0.64 } });
      fs.writeFileSync(path.join(REC, `${rec.scene}_${String(rec.n++).padStart(5, '0')}_${Date.now()}.jpg`), Buffer.from(r.data, 'base64'));
    } catch { /* kare atla */ }
    rec.busy = false;
  }, 180);
}
const scene = (name) => { rec.scene = REC ? name : null; };
const CURSOR_JS = `(() => {
  if (document.getElementById('demo-cursor')) return;
  const c = document.createElement('div');
  c.id = 'demo-cursor';
  c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6 1.6L8 18z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
  c.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;pointer-events:none;transform:translate(-3px,-2px);transition:none';
  document.body.appendChild(c);
  const ring = document.createElement('div');
  ring.style.cssText = 'position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:2px solid #4aa3ff;z-index:99998;pointer-events:none;opacity:0;transition:opacity .35s, transform .35s';
  document.body.appendChild(ring);
  document.addEventListener('mousemove', (e) => { c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px'; }, true);
  document.addEventListener('mousedown', (e) => {
    ring.style.left = e.clientX + 'px'; ring.style.top = e.clientY + 'px';
    ring.style.borderColor = e.button === 2 ? '#f5a524' : '#4aa3ff';
    ring.style.transition = 'none'; ring.style.opacity = '1'; ring.style.transform = 'scale(.6)';
    requestAnimationFrame(() => { ring.style.transition = 'opacity .45s, transform .45s'; ring.style.opacity = '0'; ring.style.transform = 'scale(1.6)'; });
  }, true);
})()`;
async function until(fn, ms = 8000, what = 'koşul') {
  if (process.env.ES_RECORD) ms *= 3; // kayıt modunda her şey daha yavaş
  if (SLOW) ms *= SLOW;
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
      .replace('</head>', `<style>:root{${THEMES[THEME]}}</style></head>`).replace('<body', `<body class="vscode-${THEME}"`);
  });
  const profile = path.join(WORK, 'edge-profile');
  fs.rmSync(profile, { recursive: true, force: true });
  const browser = spawn(BROWSER, ['--headless=new', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`, `--window-size=${WIN_W},${WIN_H}`, '--hide-scrollbars',
    // Arka plan kısıtlamaları kapalı: aksi halde headless bazen kare üretmeyi geciktirip ekran görüntüsünü kilitler
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', 'about:blank'], { stdio: 'ignore' });
  browserProc = browser;
  process.on('exit', () => { try { browser.kill(); } catch {} });
  const targets = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json()).filter((t) => t.type === 'page'); } catch { return null; } }, 15000, 'tarayıcı');
  const ws = new WebSocket(targets[0].webSocketDebuggerUrl);
  await new Promise((r) => (ws.onopen = r));
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: WIN_W, height: WIN_H, deviceScaleFactor: 1, mobile: false });
  if (SLOW) await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOW });
  await cdp.send('Page.navigate', { url: ORIGIN + '/' });
  // Sayfa (ve webview betikleri) yüklenmeden adımlara başlama; yavaş makinede ilk eval body'yi bulamıyordu
  await until(() => cdp.eval(`document.readyState === 'complete' && !!document.getElementById('app')`).catch(() => false), 20000, 'sayfa yüklendi');
  if (REC) {
    await sleep(1500);
    await cdp.eval(CURSOR_JS);
    startRecorder(cdp);
  }
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
    scene('tasarim');
    for (const name of ['BME280', 'MPU-6050', 'SSD1306 OLED 128x64', 'u-blox NEO-6M GPS', 'LED', 'Servo SG90']) {
      await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === ${JSON.stringify(name)}))`);
      await sleep(250);
      await beat(250);
    }
    await until(() => design().instances.length === 7, 5000, 'otomatik kayıt');
    await until(() => cdp.eval(`document.querySelector('#save-state').textContent.includes('Kaydedildi') || document.querySelector('#save-state').textContent.includes('Otomatik')`), 4000, 'kaydedildi göstergesi');
    await sleep(400);
    await cdp.shot('02-tasarim');
  });
  await step('Komponent üzerine gelince bilgi kartı (resimli)', async () => {
    await cdp.hover(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('MPU6050_1')).querySelector('.sym-body'))`);
    await until(() => cdp.eval(`!!document.querySelector('.popover .card-art svg')`), 3000, 'popover');
    await beat(1600);
    await cdp.shot('03-bilgi-karti');
    await cdp.mouse('mouseMoved', 5, 5);
  });
  await step('Sağ tık menüsü: Bağlantılar, Aynala, Datasheet, Sil', async () => {
    await cdp.click(`([...document.querySelectorAll('#schematic .comp')].find((g) => g.textContent.includes('BME280_1')).querySelector('.sym-body'))`, 'right');
    const labels = await cdp.eval(`[...document.querySelectorAll('.ctx-menu .ctx-label')].map((e) => e.textContent)`);
    assert.deepStrictEqual(labels, ['Bağlantılar…', 'Yönü değiştir (aynala)', 'Datasheet', 'Sil']);
    assert.ok(await cdp.eval(`!!document.querySelector('.ctx-menu .ctx-item svg rect[fill="#e5484d"]')`), 'PDF ikonu');
    await beat(900);
    await cdp.shot('04-sag-tik');
  });
  await step('Bağlantılar penceresi: pin değiştir + Kaydet', async () => {
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Bağlantılar')))`);
    await until(() => cdp.eval(`!!document.querySelector('.modal')`), 2000, 'modal');
    await beat(700);
    await cdp.eval(`(() => { const s = document.querySelector('.modal table.pins select'); s.value = 'PB8'; s.dispatchEvent(new Event('change')); })()`);
    await beat(900);
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
    await beat(1200);
    await cdp.shot('06-aynalanmis');
    scene(null);
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
  await step('Geri al / yinele: Ctrl+Z, Ctrl+Y ve butonlar', async () => {
    const has = () => design().instances.some((i) => i.label === 'SERVO_SG90_1');
    assert.ok(await cdp.eval(`(document.querySelector('.toast:last-child') || {}).textContent.includes('Ctrl+Z')`), 'silme bildiriminde geri alma ipucu');
    await cdp.key('z', 'KeyZ', 90, 2);
    await until(() => has(), 3000, 'Ctrl+Z ile geri geldi');
    assert.ok(await cdp.eval(`[...document.querySelectorAll('#schematic .comp')].some((g) => g.textContent.includes('SERVO_SG90_1'))`), 'şemada görünür');
    await cdp.key('y', 'KeyY', 89, 2);
    await until(() => !has(), 3000, 'Ctrl+Y ile tekrar silindi');
    await cdp.click('#undo');
    await until(() => has(), 3000, 'buton ile geri al');
    await cdp.click('#redo');
    await until(() => !has(), 3000, 'buton ile yinele');
    assert.ok(await cdp.eval(`document.querySelector('#redo').disabled`), 'yinelenecek adım kalmadı');
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
  const setInput = (sel, value) => cdp.eval(`(() => { const el = ${sel}; el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
  const compFile = (id) => path.join(PROJECT, '.embedded-studio/components', `${id}.json`);
  await step('Komponent oluşturucu: sıfırdan komponent, doğrulama, kaydet ve tasarıma ekle', async () => {
    scene('olusturucu');
    await cdp.click('#lib-add');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Yeni komponent')))`);
    await until(() => cdp.eval(`!!document.querySelector('.creator #cf-name')`), 3000, 'oluşturucu');
    await cdp.click('#cf-name');
    await cdp.type('Sıcaklık Sensörü TMP102');
    assert.strictEqual(await cdp.eval(`document.querySelector('#cf-id').value`), 'sicaklik_sensoru_tmp102');
    await setInput(`document.querySelector('#cf-addr')`, '0x48');
    await cdp.click('#cf-add-tel');
    await setInput(`document.querySelector('.cf-tel input')`, 'temp');
    await setInput(`document.querySelectorAll('.cf-tel input')[1]`, '°C');
    await cdp.click('#cf-add-mon');
    await cdp.eval(`(() => { const s = document.querySelector('.cf-mon select'); s.value = 'thermo'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(600); // doğrulama yanıtı
    await until(() => cdp.eval(`!!document.querySelector('#cf-errors .note.info') && !document.querySelector('#cf-save-add').disabled`), 3000, 'geçerli');
    assert.ok(await cdp.eval(`document.querySelector('.cf-mon .cf-chans input').checked`), 'widget güncel ölçüme bağlı');
    await cdp.shot('18-komponent-olusturucu');
    // Hata: tekrar eden pin adı → kaydet kapalı
    await setInput(`document.querySelectorAll('.cf-pin input')[1]`, 'VCC');
    await until(() => cdp.eval(`[...document.querySelectorAll('#cf-errors .note.error')].some((e) => e.textContent.includes('tekrar ediyor')) && document.querySelector('#cf-save-add').disabled`), 3000, 'hata gösterimi');
    await cdp.shot('19-olusturucu-hata');
    await setInput(`document.querySelectorAll('.cf-pin input')[1]`, 'GND');
    await until(() => cdp.eval(`!document.querySelector('#cf-save-add').disabled`), 3000, 'düzeldi');
    await cdp.click('#cf-save-add');
    await until(() => fs.existsSync(compFile('sicaklik_sensoru_tmp102')), 4000, 'dosya');
    const c = JSON.parse(fs.readFileSync(compFile('sicaklik_sensoru_tmp102'), 'utf8'));
    assert.strictEqual(c.i2c.address, '0x48');
    assert.deepStrictEqual(c.telemetry.map((t) => t.id), ['temp']);
    assert.strictEqual(c.monitor[0].type, 'thermo');
    assert.ok(!c.spi && !c.uart && !c.imageUri && !c.source, 'temiz çıktı');
    await until(() => design().instances.some((i) => i.componentId === 'sicaklik_sensoru_tmp102'), 4000, 'tasarıma eklendi');
    await beat(1500);
    scene(null);
    assert.ok(!(await cdp.eval(`!!document.querySelector('.creator')`)), 'pencere kapanmalı');
  });
  await step('Komponent oluşturucu: düzenle (sağ tık), kopyasını düzenle, kaydedilmemiş uyarısı', async () => {
    await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'Sıcaklık Sensörü TMP102'))`, 'right');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Düzenle')))`);
    await until(() => cdp.eval(`document.querySelector('.modal-title').textContent.startsWith('Komponenti düzenle')`), 3000, 'düzenleme');
    assert.ok(await cdp.eval(`document.querySelector('#cf-id').disabled`), 'tasarımda kullanılan kimlik kilitli');
    await setInput(`[...document.querySelectorAll('.cf-field')].find((f) => f.textContent.startsWith('Açıklama')).querySelector('input')`, 'TI TMP102 dijital sıcaklık sensörü');
    await cdp.click('#cf-save');
    await until(() => JSON.parse(fs.readFileSync(compFile('sicaklik_sensoru_tmp102'), 'utf8')).description.startsWith('TI TMP102'), 4000, 'güncelleme');
    // Kaydedilmemiş değişiklik uyarısı
    await cdp.click('#lib-add');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Yeni komponent')))`);
    await cdp.click('#cf-name');
    await cdp.type('Taslak');
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Kapat'))`);
    assert.ok(await cdp.eval(`!!document.querySelector('.creator') && document.querySelector('#cf-warn').textContent.includes('Kaydedilmemiş')`), 'uyarı');
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Kapat'))`);
    await until(() => cdp.eval(`!document.querySelector('.creator')`), 2000, 'kapandı');
    // Hazır komponentin kopyası
    await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'BME280'))`, 'right');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Kopyasını')))`);
    await until(() => cdp.eval(`document.querySelector('#cf-id') && document.querySelector('#cf-id').value === 'bme280_ozel'`), 3000, 'kopya');
    await until(() => cdp.eval(`!document.querySelector('#cf-save').disabled && document.querySelector('#cf-errors').textContent.includes('Kaydetmeye hazır')`), 3000, 'kopya doğrulandı');
    // Çift tıklama: ikinci istek gönderilmemeli ("zaten var" uyarısı çıkmamalı)
    const warnsBefore = recorded.warn.length;
    await cdp.eval(`(() => { const b = document.querySelector('#cf-save'); b.click(); b.click(); })()`);
    await until(() => fs.existsSync(compFile('bme280_ozel')), 4000, 'kopya dosyası');
    await until(() => cdp.eval(`!document.querySelector('.creator')`), 3000, 'kopya penceresi kapandı');
    await sleep(300);
    assert.strictEqual(recorded.warn.length, warnsBefore, 'çift tıklamada üzerine yazma uyarısı çıkmamalı: ' + recorded.warn.slice(warnsBefore).join(' | '));
    assert.strictEqual(JSON.parse(fs.readFileSync(compFile('bme280_ozel'), 'utf8')).telemetry.length, 3);
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
    scene('clock');
    await cdp.click('#tab-clock');
    await beat(800);
    await sleep(300);
    await cdp.eval(`(() => { const s = document.querySelector('select[aria-label=apb1]'); s.value = '1'; s.dispatchEvent(new Event('change')); })()`);
    await until(() => cdp.eval(`!!document.querySelector('.ck-freq.bad')`), 3000, 'hata vurgusu');
    await cdp.shot('10-clock-hata');
    await cdp.eval(`document.querySelector('#clk-target').value = '84'`);
    await cdp.click(`([...document.querySelectorAll('.clock-bar button')].find((b) => b.textContent === 'Otomatik çöz'))`);
    await until(() => cdp.eval(`document.querySelector('#clk-summary').textContent.startsWith('SYSCLK 84 MHz') && !document.querySelector('.ck-freq.bad')`), 3000, 'çözüm');
    await sleep(500);
    await beat(1500);
    scene(null);
    await cdp.shot('11-clock');
  });
  await step('Kod Üret: dosyalar + ikinci üretimde dosyalara dokunulmaz', async () => {
    await cdp.click('#generate');
    await until(() => fs.existsSync(path.join(PROJECT, 'Core/Src/app.c')), 20000, 'kod üretimi');
    assert.ok(fs.existsSync(path.join(PROJECT, 'AGENTS.md')));
    assert.ok(fs.readFileSync(path.join(PROJECT, 'Core/Src/app.c'), 'utf8').includes('USER CODE BEGIN SICAKLIK_SENSORU_TMP102_1'), 'oluşturulan komponent kodda');
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
    scene('monitor');
    await cdp.click('#tab-monitor');
    await cdp.click('#mon-toggle');
    await sleep(5000);
    await beat(4000);
    scene(null);
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
    scene('debug');
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
    await beat(1500);
    scene(null);
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
  await step('Dar pencere: sekmeler ve debug bellek paneli görünür', async () => {
    const W = await cdp.eval('innerWidth');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1000, height: 680, deviceScaleFactor: 1, mobile: false });
    try {
      await sleep(400);
      const out = await cdp.eval(`[...document.querySelectorAll('.tabs button, #generate')].filter((b) => { const r = b.getBoundingClientRect(); return r.right > innerWidth + 1 || r.width < 20; }).map((b) => b.textContent)`);
      assert.deepStrictEqual(out, [], 'üst çubukta taşan öğe');
      assert.ok(await cdp.eval(`document.querySelector('#topbar').getBoundingClientRect().height < 50`), 'üst çubuk tek satır kalmalı (sayfa zıplamasın)');
      const mem = await cdp.eval(`(() => { const r = document.querySelector('#dbg-mem').closest('.dbg-col').getBoundingClientRect(); return r.width > 100 && r.height > 120 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1; })()`);
      assert.ok(mem, 'bellek paneli dar pencerede de görünmeli');
      await cdp.shot('20-dar-pencere');
    } finally {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: W, height: WIN_H, deviceScaleFactor: 1, mobile: false });
    }
  });
  await step('Proje ayarları: üst çubukta sadece özet; altyapı değişikliği önizlenir ve onayla uygulanır', async () => {
    assert.ok(await cdp.eval(`!document.querySelector('#topbar select') && !document.querySelector('#topbar input')`), 'üst çubukta MCU/altyapı/RTOS seçicisi kalmamalı');
    assert.strictEqual(await cdp.eval(`document.querySelector('#proj-summary').textContent`), 'STM32F411CEU6 · HAL · FreeRTOS');
    await cdp.click('#proj-summary');
    await until(() => cdp.eval(`document.querySelector('#settings').classList.contains('active')`), 3000, 'ayarlar sekmesi');
    assert.ok(await cdp.eval(`document.querySelector('#set-apply').disabled`), 'değişiklik yokken Uygula kapalı');
    const setFw = async (fw) => {
      await cdp.click(`(document.querySelector('input[name=set-framework][value=${fw}]').closest('label'))`);
      await until(() => cdp.eval(`!document.querySelector('#set-apply').disabled`), 8000, 'önizleme');
    };
    await setFw('register');
    // Proje daha önce üretildi: HAL'e ait dosyalar kaldırılacak/değişecek olarak listelenmeli
    const lists = await cdp.eval(`[...document.querySelectorAll('.set-files')].map((e) => e.className + ':' + e.children.length)`);
    assert.ok(lists.length > 0, 'etkilenen dosya listesi: ' + JSON.stringify(lists));
    assert.ok(await cdp.eval(`document.querySelector('#set-preview').textContent.includes('Drivers/STM32F4xx_HAL_Driver')`), 'HAL klasörü notu');
    await cdp.shot('24-proje-ayarlari');
    await cdp.click('#set-apply');
    await until(() => design().framework === 'register', 4000, 'bare-metal uygulandı');
    await until(() => cdp.eval(`document.querySelector('#proj-summary').textContent.includes('bare-metal')`), 3000, 'özet güncellendi');
    // Kod Üret: sade klasör yapısı, kullanıcı kodu taşınır
    const P = (p) => path.join(PROJECT, p);
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('src/app.c')) && fs.existsSync(P('linker/STM32F411CEU6_FLASH.ld')) && fs.existsSync(P('startup/system_stm32f4xx.c')), 20000, 'bare-metal dosyaları');
    assert.ok(fs.readFileSync(P('src/app.c'), 'utf8').includes('static uint32_t benim_sayacim;'), 'kullanıcı kodu taşınmalı');
    assert.ok(!fs.existsSync(P('Core/Src/app.c')) && !fs.existsSync(P('Core/Src/bsp.c')), 'eski yerde kalmamalı');
    assert.ok(recorded.info.some((m) => m.startsWith('Klasör yapısı değişti')), 'taşıma bildirimi');
    execSync('cmake -S . -B build-bm -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake && cmake --build build-bm', { cwd: PROJECT, stdio: 'pipe' });
    // HAL'e geri dön ve tekrar üret
    await setFw('hal');
    await cdp.click('#set-apply');
    await until(() => design().framework === 'hal', 4000, 'HAL geri geldi');
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('Core/Src/app.c')) && !fs.existsSync(P('src/app.c')), 20000, 'HAL dosyaları');
    assert.ok(fs.readFileSync(P('Core/Src/app.c'), 'utf8').includes('static uint32_t benim_sayacim;'));
    await cdp.click('#tab-design');
  });
  await step('Derleme ayarları: tip, -D, araç zinciri algılama; "CMake\'i ben yönetiyorum"da CMakeLists.txt\'ye dokunulmaz; Derle ve boyut özeti', async () => {
    const P = (p) => path.join(PROJECT, p);
    const setValue = (sel, v) => cdp.eval(`(() => { const e = document.querySelector('${sel}'); e.value = ${JSON.stringify(v)}; e.dispatchEvent(new Event('change')); })()`);
    await cdp.click('#tab-settings');
    await until(() => cdp.eval(`!!document.querySelector('#set-build')`), 3000, 'derleme bölümü');
    await setValue('#set-build-type', 'Release');
    await until(() => design().build.type === 'Release', 4000, 'Release kaydedildi');
    await setValue('#set-defines', 'APP_VER=7\nE2E_TEST');
    await until(() => design().build.defines.join() === 'APP_VER=7,E2E_TEST', 4000, 'tanımlar kaydedildi');
    await cdp.click('#set-detect');
    await until(() => cdp.eval(`document.querySelectorAll('.tc-item').length > 0 || /bulunamadı/.test(document.querySelector('#set-build').textContent)`), 15000, 'araç zinciri algılama');
    // CMake'i ben yönetiyorum: önce kullanıcının dosyası; üretim ona dokunmamalı
    const lists = fs.readFileSync(P('CMakeLists.txt'), 'utf8').replace('# USER CODE BEGIN Targets\n', '# USER CODE BEGIN Targets\n# benim satirim\n').replace('# Embedded Studio tarafından üretildi.', '# Benim dosyam.');
    fs.writeFileSync(P('CMakeLists.txt'), lists);
    await cdp.click(`(document.querySelector('input[name=set-cmake][value=user]').closest('label'))`);
    await until(() => design().build.cmake === 'user', 4000, 'kullanıcı CMake');
    await until(() => cdp.eval(`(document.querySelector('#set-cmake-snippet') || {}).textContent?.includes('embedded_studio_target')`), 3000, 'include örneği');
    await cdp.shot('24b-derleme-ayarlari');
    await cdp.click('#generate');
    await until(() => fs.readFileSync(P('cmake/embedded-studio.cmake'), 'utf8').includes('"E2E_TEST"'), 20000, 'embedded-studio.cmake güncellendi');
    assert.strictEqual(fs.readFileSync(P('CMakeLists.txt'), 'utf8'), lists, 'CMakeLists.txt aynen kalmalı');
    // Derle: seçili tip, Windows'ta cmd.exe; gerçek derleme + görev bitişi → boyut özeti
    await cdp.click('#tab-debug');
    await cdp.click(`([...document.querySelectorAll('#debug button')].find((b) => b.textContent === 'Derle'))`);
    await until(() => recorded.tasks.length && recorded.tasks[recorded.tasks.length - 1].def.kind === 'build', 3000, 'derleme görevi');
    const task = recorded.tasks[recorded.tasks.length - 1];
    assert.ok(task.exec.cmd.includes('-B build/release') && task.exec.cmd.includes('-DCMAKE_BUILD_TYPE=Release'), task.exec.cmd);
    if (process.platform === 'win32') assert.strictEqual(task.exec.opts.executable, 'cmd.exe');
    execSync(task.exec.cmd, { cwd: PROJECT, stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd.exe' : undefined });
    for (const x of ['elf', 'hex', 'bin', 'map']) assert.ok(fs.existsSync(P(`build/release/demo_proje.${x}`)), x);
    taskEndListeners.forEach((fn) => fn({ execution: { task }, exitCode: 0 }));
    await until(() => recorded.info.some((m) => m.startsWith('Derlendi (Release): Flash')), 8000, 'boyut özeti bildirimi');
    await cdp.click('#tab-settings');
    await until(() => cdp.eval(`!!document.querySelector('#set-size .bar > div')`), 3000, 'ayarlarda boyut çubukları');
    await cdp.eval(`document.querySelector('#set-size').scrollIntoView({ block: 'center' })`);
    await cdp.shot('24c-boyut-ozeti');
    // Geri al: Embedded Studio yönetir, Debug, tanım yok
    await cdp.click(`(document.querySelector('input[name=set-cmake][value=tool]').closest('label'))`);
    await setValue('#set-build-type', 'Debug');
    await setValue('#set-defines', '');
    await until(() => design().build.cmake === 'tool' && design().build.type === 'Debug' && !design().build.defines.length, 4000, 'varsayılana döndü');
    await cdp.click('#generate');
    await until(() => fs.readFileSync(P('CMakeLists.txt'), 'utf8').includes('# Embedded Studio tarafından üretildi.'), 20000, 'CMakeLists.txt yeniden yönetiliyor');
    assert.ok(fs.readFileSync(P('CMakeLists.txt'), 'utf8').includes('# benim satirim'), 'USER CODE bloğu korunmalı');
    await cdp.click('#tab-design');
  });
  await step('Çalışma modu: Profesyonel sekme sırası, kısayollar, çizimsiz kartlar; Acemi\'ye dönüş', async () => {
    assert.strictEqual(design().mode, 'beginner', 'sihirbaz varsayılanı Acemi');
    assert.ok(await cdp.eval(`!document.body.classList.contains('mode-pro') && document.querySelector('#mode-badge').textContent === 'Acemi'`));
    const order = () => cdp.eval(`[...document.querySelectorAll('#topbar .tabs button')].filter((b) => !b.hidden).map((b) => b.id.slice(4))`);
    assert.deepStrictEqual(await order(), ['design', 'clock', 'monitor', 'debug', 'settings']);
    await cdp.click('#tab-settings');
    await cdp.click(`(document.querySelector('input[name=set-mode][value=pro]').closest('label'))`);
    await until(() => design().mode === 'pro', 4000, 'pro kaydedildi');
    await until(() => cdp.eval(`document.body.classList.contains('mode-pro') && document.querySelector('#debug').classList.contains('active')`), 3000, 'pro: debug ana sekme');
    assert.deepStrictEqual(await order(), ['debug', 'monitor', 'clock', 'design', 'settings']);
    assert.strictEqual(await cdp.eval(`document.querySelector('#mode-badge').textContent`), 'Profesyonel');
    await cdp.shot('25-pro-mod');
    // Alt+3 → moddaki 3. sekme (Clock)
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, modifiers: 1 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: '3', code: 'Digit3', windowsVirtualKeyCode: 51, modifiers: 1 });
    await until(() => cdp.eval(`document.querySelector('#clock').classList.contains('active')`), 3000, 'Alt+3');
    // Pro modda bilgi kartında modül çizimi yok, asistan kapalı başlar
    await cdp.click('#tab-design');
    assert.ok(await cdp.eval(`document.querySelector('#design').classList.contains('dock-closed')`), 'asistan kapalı');
    await cdp.hover(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'BME280'))`);
    await until(() => cdp.eval(`!!document.querySelector('.popover .comp-card')`), 3000, 'kart');
    assert.ok(await cdp.eval(`!document.querySelector('.popover .card-art')`), 'pro modda çizim yok');
    await cdp.mouse('mouseMoved', 5, 5);
    // Pro: Kod Üret önce önizleme gösterir; elle değiştirilen üretilmiş dosya korunur (.new)
    const bspC = path.join(PROJECT, 'Core/Src/bsp.c');
    fs.appendFileSync(bspC, '\n/* elle yama */\n');
    await cdp.click('#tab-design');
    await cdp.click(`([...document.querySelectorAll('.lib-item')].find((e) => e.querySelector('.name').textContent === 'LED'))`);
    await until(() => design().instances.some((i) => i.componentId === 'led'), 3000, 'LED eklendi');
    await cdp.click('#generate');
    await until(() => cdp.eval(`!!document.querySelector('.gen-preview')`), 8000, 'önizleme penceresi');
    assert.ok(!fs.existsSync(bspC + '.new'), 'önizleme diske yazmamalı');
    await cdp.shot('26-kod-uret-onizleme');
    const before = recorded.openFolder.length;
    await cdp.click(`([...document.querySelectorAll('.gen-preview button.link')].find((b) => b.textContent === 'Core/Src/bsp.c.new'))`);
    await until(() => recorded.openFolder.slice(before).some((a) => a[0] === 'vscode.diff'), 3000, 'fark görünümü');
    await cdp.click('#gen-apply');
    await until(() => fs.existsSync(bspC + '.new'), 8000, '.new yazıldı');
    assert.ok(fs.readFileSync(bspC, 'utf8').includes('/* elle yama */'), 'yama korunmalı');
    fs.writeFileSync(bspC, fs.readFileSync(bspC + '.new', 'utf8'));
    fs.rmSync(bspC + '.new');
    // Acemi'ye dönüş
    await cdp.click('#tab-settings');
    await cdp.click(`(document.querySelector('input[name=set-mode][value=beginner]').closest('label'))`);
    await until(() => design().mode === 'beginner', 4000, 'acemi kaydedildi');
    await until(() => cdp.eval(`!document.body.classList.contains('mode-pro') && document.querySelector('#design').classList.contains('active')`), 3000, 'acemi: tasarım ana sekme');
  });
  await step('Başka işlemci (ES-106): Nucleo-G474RE seçilir, saat ağacı M/N/R, kod G4 dosyalarıyla üretilir ve derlenir; F411\'e dönülür', async () => {
    const P = (p) => path.join(PROJECT, p);
    const setMcu = async (id) => {
      await cdp.click('#tab-settings');
      await cdp.eval(`(() => { const e = document.querySelector('#set-mcu'); e.value = '${id}'; e.dispatchEvent(new Event('change')); })()`);
      await until(() => cdp.eval(`!document.querySelector('#set-apply').disabled`), 15000, 'önizleme');
      return cdp.eval(`document.querySelector('#set-preview').textContent`);
    };
    const preview = await setMcu('stm32g474ret6');
    assert.ok(preview.includes('STM32F4xx → STM32G4xx') && preview.includes('stm32g4xx_it.c'), 'aile değişikliği notu: ' + preview.slice(0, 300));
    assert.ok(preview.includes('gerçek kartta doğrulanmadı'), 'doğrulanmadı uyarısı');
    await cdp.shot('27-islemci-degisikligi');
    await cdp.click('#set-apply');
    await until(() => design().mcuId === 'stm32g474ret6', 4000, 'G474 uygulandı');
    // Saat ağacı: M/N/R modeli, varsayılan 170 MHz (boost)
    await cdp.click('#tab-clock');
    await until(() => cdp.eval(`document.querySelector('#clk-summary').textContent.startsWith('SYSCLK 170 MHz')`), 4000, '170 MHz');
    assert.ok(await cdp.eval(`[...document.querySelectorAll('#clock .ck-title')].some((e) => e.textContent === '/ R') && ![...document.querySelectorAll('#clock .ck-title')].some((e) => e.textContent === '/ Q')`), 'G4: /R var, /Q yok');
    assert.strictEqual(await cdp.eval(`document.querySelector('#clk-target').max`), '170');
    await cdp.shot('28-g474-saat-agaci');
    await cdp.click('#tab-design');
    await sleep(600);
    await cdp.shot('29-g474-sema');
    // Kod üret: G4 paketleri indirilir (testte önbellekten), G4 dosyaları, kullanıcı kesme kodu taşınır
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('Core/Src/stm32g4xx_it.c')) && fs.existsSync(P('Core/Inc/stm32g4xx_hal_conf.h')), 120000, 'G4 dosyaları');
    assert.ok(!fs.existsSync(P('Core/Src/stm32f4xx_it.c')), 'F4 kesme dosyası taşınmalı');
    const cmake = fs.readFileSync(P('cmake/embedded-studio.cmake'), 'utf8');
    assert.ok(cmake.includes('STM32G474xx') && cmake.includes('startup_stm32g474xx.s') && cmake.includes('stm32g4xx_hal*.c'), 'CMake G4');
    execSync('cmake --preset debug && cmake --build --preset debug', { cwd: PROJECT, stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd.exe' : undefined });
    assert.ok(fs.existsSync(P('build/debug/demo_proje.elf')), 'G474 derlendi');
    // F411'e geri dön
    await setMcu('stm32f411ceu6');
    await cdp.click('#set-apply');
    await until(() => design().mcuId === 'stm32f411ceu6', 4000, 'F411 geri geldi');
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('Core/Src/stm32f4xx_it.c')) && !fs.existsSync(P('Core/Src/stm32g4xx_it.c')), 60000, 'F4 dosyaları');
    await cdp.click('#tab-design');
  });
  await step('Örnek register sürücüleri (ES-107): bare-metal\'de seçilir, drivers/reg/ altına bir kez üretilir ve derlenir', async () => {
    const P = (p) => path.join(PROJECT, p);
    await cdp.click('#tab-settings');
    assert.ok(await cdp.eval(`!document.querySelector('#set-rd-gpio') && document.querySelector('#set-regdrivers').textContent.includes('bare-metal')`), 'HAL projesinde seçim yok, açıklama var');
    await cdp.click(`(document.querySelector('input[name=set-framework][value=register]').closest('label'))`);
    await until(() => cdp.eval(`!document.querySelector('#set-apply').disabled`), 8000, 'önizleme');
    await cdp.click('#set-apply');
    await until(() => design().framework === 'register', 4000, 'bare-metal');
    await until(() => cdp.eval(`!!document.querySelector('#set-rd-gpio')`), 3000, 'sürücü listesi');
    assert.ok(await cdp.eval(`document.querySelector('#set-rd-dac').disabled`), 'F411\'de DAC yok');
    await cdp.click('#set-rd-gpio');
    await cdp.click('#set-rd-uart');
    await until(() => JSON.stringify(design().regDrivers) === '["gpio","uart"]', 4000, 'seçim kaydedildi');
    await cdp.eval(`document.querySelector('#set-regdrivers').scrollIntoView({ block: 'center' })`);
    await cdp.shot('30-ornek-surucular');
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('drivers/reg/es_uart.c')) && fs.existsSync(P('drivers/reg/es_dma.c')) && fs.existsSync(P('drivers/reg/es_gpio.h')), 20000, 'sürücü dosyaları (UART → DMA da)');
    assert.ok(fs.readFileSync(P('drivers/reg/es_uart.c'), 'utf8').includes('Kaynak: RM0383'), 'RM kaynağı');
    // Bir kez üretilir: kullanıcının değişikliği korunur
    fs.appendFileSync(P('drivers/reg/es_gpio.c'), '\n/* benim eklemem */\n');
    await cdp.click('#set-rd-crc');
    await until(() => design().regDrivers.includes('crc'), 4000, 'crc');
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('drivers/reg/es_crc.c')), 20000, 'crc dosyası');
    assert.ok(fs.readFileSync(P('drivers/reg/es_gpio.c'), 'utf8').includes('/* benim eklemem */'), 'es_gpio.c kullanıcınındır');
    execSync('cmake --preset debug && cmake --build --preset debug', { cwd: PROJECT, stdio: 'pipe', shell: process.platform === 'win32' ? 'cmd.exe' : undefined });
    // HAL'e dön
    await cdp.click(`(document.querySelector('input[name=set-framework][value=hal]').closest('label'))`);
    await until(() => cdp.eval(`!document.querySelector('#set-apply').disabled`), 8000, 'önizleme');
    await cdp.click('#set-apply');
    await until(() => design().framework === 'hal', 4000, 'HAL');
    await cdp.click('#generate');
    await until(() => fs.existsSync(P('Core/Src/app.c')), 20000, 'HAL dosyaları');
    await cdp.click('#tab-design');
  });
  await step('İngilizce arayüz: ayar değişince yeniden yüklenir, ekranda Türkçe metin kalmaz', async () => {
    settings.language = 'en';
    configListeners.forEach((fn) => fn({ affectsConfiguration: (s) => s === 'embeddedStudio.language' }));
    await cdp.send('Page.navigate', { url: ORIGIN + '/' }); // gerçek webview html değişince kendiliğinden yenilenir
    await until(() => cdp.eval(`(document.querySelector('#tab-design') || {}).textContent === 'Design' && document.documentElement.lang === 'en'`).catch(() => false), 15000, 'İngilizce arayüz');
    // Kullanıcının kendi komponentlerinin metinleri (ad, açıklama…) çevrilmez
    const userDir = path.join(PROJECT, '.embedded-studio', 'components');
    const userText = fs.readdirSync(userDir).filter((f) => f.endsWith('.json')).map((f) => fs.readFileSync(path.join(userDir, f), 'utf8')).join(' ');
    const turkish = async (where) => {
      const words = await cdp.eval(`(document.body.innerText + ' ' + [...document.querySelectorAll('[title],[placeholder],[aria-label]')].map((e) => [e.title, e.placeholder, e.getAttribute('aria-label')].join(' ')).join(' ')).match(/[^\\s"'()\\[\\]·:,.;!?]*[çğıöşüÇĞİÖŞÜ][^\\s"'()\\[\\]·:,.;!?]*/g) || []`);
      return [...new Set(words)].filter((w) => !userText.includes(w)).map((w) => `${where}: ${w}`);
    };
    const found = [];
    for (const tab of ['design', 'clock', 'monitor', 'debug', 'settings']) {
      await cdp.click(`#tab-${tab}`);
      await sleep(500);
      found.push(...(await turkish(tab)));
    }
    await cdp.shot('21-ingilizce-debug');
    await cdp.click('#tab-design');
    await cdp.click('#lib-add');
    await cdp.click(`([...document.querySelectorAll('.ctx-item')].find((e) => e.textContent.includes('Create new component')))`);
    await until(() => cdp.eval(`!!document.querySelector('.creator') && document.querySelector('#cf-errors').textContent.length > 0`), 3000, 'oluşturucu');
    await sleep(500);
    found.push(...(await turkish('creator')));
    await cdp.shot('22-ingilizce-olusturucu');
    await cdp.click(`([...document.querySelectorAll('.modal-foot button')].find((b) => b.textContent === 'Close'))`);
    await cdp.shot('23-ingilizce-tasarim');
    assert.deepStrictEqual(found, [], 'İngilizce arayüzde Türkçe metin');
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
})().catch((e) => { console.error(e); try { browserProc && browserProc.kill(); } catch {} process.exit(1); });

