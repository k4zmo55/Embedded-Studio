// @ts-check
/**
 * Bilgisayardaki araç zincirlerini bulur (arm-none-eabi-gcc, clang) ve derleme çıktısının boyut özetini çıkarır.
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const EXE = process.platform === 'win32' ? '.exe' : '';

function run(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

/** Bir klasörün altındaki klasörler (yoksa boş). */
const subdirs = (dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
};

/** arm-none-eabi-gcc bulunabilecek bin klasörleri: PATH + bilinen kurulum yerleri (Arm GNU Toolchain, STM32CubeIDE, xPack). */
function gccCandidates() {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (process.platform === 'win32') {
    for (const pf of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles].filter(Boolean)) {
      for (const d of subdirs(path.join(String(pf), 'Arm GNU Toolchain arm-none-eabi'))) dirs.push(path.join(d, 'bin'));
      for (const d of subdirs(path.join(String(pf), 'GNU Arm Embedded Toolchain'))) dirs.push(path.join(d, 'bin'));
    }
    for (const st of subdirs('C:\\ST')) {
      for (const p of subdirs(path.join(st, 'STM32CubeIDE', 'plugins'))) if (/gnu-tools-for-stm32/.test(p)) dirs.push(path.join(p, 'tools', 'bin'));
    }
  } else {
    for (const d of [...subdirs('/opt'), ...subdirs('/Applications/ArmGNUToolchain').map((x) => path.join(x, 'arm-none-eabi'))]) {
      if (/arm|gcc/i.test(d)) dirs.push(path.join(d, 'bin'));
    }
    dirs.push('/usr/bin', '/usr/local/bin');
  }
  return [...new Set(dirs.map((d) => path.normalize(d)))];
}

/**
 * Kurulu GCC (arm-none-eabi) ve Clang sürümleri.
 * @returns {Promise<{ kind: 'gcc'|'clang', dir: string, version: string, inPath: boolean }[]>}
 */
async function detectToolchains() {
  const pathDirs = new Set((process.env.PATH || '').split(path.delimiter).filter(Boolean).map((d) => path.normalize(d)));
  const found = [];
  const seen = new Set();
  const probe = async (kind, dir, exe) => {
    const file = path.join(dir, exe + EXE);
    if (!fs.existsSync(file)) return;
    const real = fs.realpathSync(file);
    if (seen.has(real)) return;
    seen.add(real);
    const out = await run(file, ['--version']);
    if (!out) return;
    const first = out.split('\n')[0].trim();
    const ver = (first.match(/(\d+\.\d+(?:\.\d+)?)(?!.*\d+\.\d+)/) || [])[1] || first;
    found.push({ kind, dir, version: kind === 'gcc' ? `${ver} — ${first}` : first, inPath: pathDirs.has(path.normalize(dir)) });
  };
  for (const d of gccCandidates()) await probe('gcc', d, 'arm-none-eabi-gcc');
  const llvm = [...pathDirs];
  if (process.platform === 'win32') llvm.push(path.join(process.env.ProgramFiles || 'C:\\Program Files', 'LLVM', 'bin'));
  else llvm.push('/usr/bin', '/usr/local/bin', '/opt/homebrew/opt/llvm/bin', '/usr/local/opt/llvm/bin');
  for (const d of [...new Set(llvm)]) await probe('clang', d, 'clang');
  return found;
}

/**
 * arm-none-eabi-size (Berkeley) çıktısından bellek kullanımı.
 * Flash = text + data (data'nın ilk değerleri flash'ta), RAM = data + bss.
 * @returns {Promise<{ text: number, data: number, bss: number, flash: number, ram: number } | null>}
 */
async function elfSize(sizeTool, elf) {
  const out = await run(sizeTool, [elf]);
  return out ? parseSize(out) : null;
}

function parseSize(out) {
  const row = String(out).split('\n')[1];
  const m = row && row.trim().split(/\s+/).slice(0, 3).map(Number);
  if (!m || m.length < 3 || m.some((n) => !Number.isFinite(n))) return null;
  const [text, data, bss] = m;
  return { text, data, bss, flash: text + data, ram: data + bss };
}

module.exports = { detectToolchains, elfSize, parseSize, gccCandidates };
