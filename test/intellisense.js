// ES-109: Üretilen projelerde editör (clangd) hatası kontrolü. Derleme temiz olsa da dil sunucusu derleme veritabanını
// bulamazsa "RCC tanımsız" gibi sahte hatalar çıkar (ES-108). Önce projeleri derleyin:
//   node test/build.js [önbellek] [çıktı] [filtre]
// Sonra: node test/intellisense.js [çıktı klasörü] [filtre: düzenli ifade]
// clangd: CLANGD ortam değişkeni, PATH ya da STM32Cube paketi (starm-clangd).
//
// Her proje iki kez denetlenir:
//   önce  : .clangd yok, build/ altında 0.4.x'ten kalma eski bir compile_commands.json var (kullanıcının durumu)
//   sonra : syncCodeIntel (Kod Üret / Derle'nin yaptığı) → .clangd build/<tip>'i gösterir; sıfır hata beklenir
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, execSync } = require('child_process');
const cm = require('../src/codegen/build');
const { layout } = require('../src/codegen/layout');
const { syncCodeIntel } = require('../src/codegen/merge');

const outRoot = process.argv[2] || path.join(os.tmpdir(), 'es-build');
const re = new RegExp(process.argv[3] || '');
const JOBS = Math.max(2, Math.min(8, os.cpus().length));

function findClangd() {
  if (process.env.CLANGD) return process.env.CLANGD;
  try {
    return execSync(process.platform === 'win32' ? 'where clangd' : 'command -v clangd', { stdio: 'pipe' }).toString().split(/\r?\n/)[0].trim();
  } catch { /* PATH'te yok */ }
  const st = path.join(os.homedir(), 'AppData/Local/stm32cube/bundles/st-arm-clangd');
  if (fs.existsSync(st)) {
    for (const v of fs.readdirSync(st).sort().reverse()) {
      const exe = path.join(st, v, 'bin', 'starm-clangd.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

/** clangd --check ile bir dosyadaki hata tanılamaları (E[..] [kod] Line N: ...) */
function check(clangd, root, file) {
  return new Promise((resolve) => {
    execFile(clangd, [`--check=${file}`, '--log=error'], { cwd: root, windowsHide: true, maxBuffer: 1 << 24, timeout: 120000 }, (e, so, se) => {
      const lines = `${so}\n${se}`.split(/\r?\n/).filter((l) => /^E\[[^\]]*\] \[/.test(l)).map((l) => l.replace(/^E\[[^\]]*\] /, ''));
      resolve({ file, errors: lines });
    });
  });
}

async function pool(items, fn) {
  const out = [];
  let i = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  }));
  return out;
}

function sources(root, P) {
  const files = [];
  const walk = (rel) => {
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) return;
    for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
      if (e.isDirectory()) walk(`${rel}/${e.name}`);
      else if (/\.[ch]$/.test(e.name)) files.push(`${rel}/${e.name}`);
    }
  };
  [P.src, P.inc, P.drivers].forEach(walk);
  return files;
}

(async () => {
  const clangd = findClangd();
  if (!clangd) {
    console.log('clangd bulunamadı (CLANGD ortam değişkeni ya da PATH); test atlandı.');
    process.exit(0);
  }
  if (!fs.existsSync(outRoot)) throw new Error(`${outRoot} yok: önce node test/build.js çalıştırın`);
  console.log(`clangd: ${clangd}\n`);
  const projects = fs.readdirSync(outRoot).filter((n) => re.test(n) && fs.existsSync(path.join(outRoot, n, 'cmake/embedded-studio.cmake')));
  let failed = 0;
  const rows = [];
  for (const name of projects) {
    const root = path.join(outRoot, name);
    const preset = fs.readdirSync(path.join(root, 'build')).find((d) => fs.existsSync(path.join(root, 'build', d, 'compile_commands.json')));
    if (!preset) {
      console.log(`ATLA ${name}: derlenmemiş (build/<tip>/compile_commands.json yok)`);
      continue;
    }
    const type = cm.BUILD_TYPES.find((t) => cm.presetName(t) === preset);
    const P = layout(fs.existsSync(path.join(root, 'Core')) ? 'hal' : 'register');
    const files = sources(root, P);
    // önce: kullanıcının durumu
    fs.rmSync(path.join(root, '.clangd'), { force: true });
    const stale = path.join(root, 'build', 'compile_commands.json');
    fs.writeFileSync(stale, JSON.stringify([{ directory: path.join(root, 'build'), file: path.join(root, 'Core/Src/eski.c'), command: 'arm-none-eabi-gcc -c eski.c' }]));
    const before = await pool(files, (f) => check(clangd, root, f));
    // sonra: Embedded Studio'nun yazdığı .clangd
    const conf = P.name === 'hal' && fs.readdirSync(path.join(root, P.inc)).find((f) => f.endsWith('_hal_conf.h'));
    syncCodeIntel(root, type, conf ? conf.replace('_conf', '_def') : undefined);
    const after = await pool(files, (f) => check(clangd, root, f));
    fs.rmSync(stale, { force: true });
    const nb = before.reduce((n, r) => n + r.errors.length, 0);
    const na = after.reduce((n, r) => n + r.errors.length, 0);
    rows.push([name, files.length, nb, na]);
    if (na) {
      failed++;
      console.log(`FAIL ${name}: ${na} hata`);
      for (const r of after.filter((x) => x.errors.length).slice(0, 5)) console.log(`     ${r.file}: ${r.errors.slice(0, 3).join(' | ')}`);
    } else console.log(`OK   ${name}  ${files.length} dosya, önce ${nb} hata → sonra 0`);
  }
  console.log('\n| Proje | Dosya | Önce (.clangd yok, eski build/) | Sonra |\n|---|---|---|---|');
  for (const r of rows) console.log(`| ${r[0]} | ${r[1]} | ${r[2]} | ${r[3]} |`);
  console.log(`\n${rows.length - failed}/${rows.length} projede editör hatası yok.`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
