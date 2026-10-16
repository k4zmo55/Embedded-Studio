// @ts-check
/**
 * Programlama/debug araçlarının algılanması (ES-202): STM32_Programmer_CLI, OpenOCD, pyOCD, st-flash.
 * PATH ve bilinen kurulum klasörleri taranır; yoksa nasıl kurulacağı bilgisi döner.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { t } = require('../i18n');

const EXE = process.platform === 'win32' ? '.exe' : '';

/** hint metinleri dil değişince yeniden çevrilsin diye fonksiyon */
const tools = () => [
  {
    id: 'cubeprog', name: 'STM32CubeProgrammer (STM32_Programmer_CLI)', bin: 'STM32_Programmer_CLI', args: ['--version'], version: /version:?\s*v?([\d.]+)/i,
    dirs: () => process.platform === 'win32'
      ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin')]
      : process.platform === 'darwin'
        ? ['/Applications/STMicroelectronics/STM32Cube/STM32CubeProgrammer/STM32CubeProgrammer.app/Contents/MacOs/bin']
        : [path.join(os.homedir(), 'STMicroelectronics', 'STM32Cube', 'STM32CubeProgrammer', 'bin')],
    install: 'https://www.st.com/en/development-tools/stm32cubeprog.html',
    hint: t('ST hesabıyla indirilir; seri bootloader, DFU, option byte ve RDP işlemleri için.')
  },
  {
    id: 'openocd', name: 'OpenOCD', bin: 'openocd', args: ['--version'], version: /Open On-Chip Debugger\s+v?([\w.+-]+)/i,
    dirs: () => [],
    install: 'https://xpack-dev-tools.github.io/openocd-xpack/',
    hint: process.platform === 'win32' ? 'winget install xpack-dev-tools.openocd-xpack' : process.platform === 'darwin' ? 'brew install open-ocd' : 'sudo apt install openocd',
    required: true
  },
  {
    id: 'pyocd', name: 'pyOCD', bin: 'pyocd', args: ['--version'], version: /([\d.]+)/,
    dirs: () => [], install: 'https://pyocd.io', hint: 'pip install pyocd'
  },
  {
    id: 'stflash', name: 'st-flash (stlink-tools)', bin: 'st-flash', args: ['--version'], version: /v?([\d.]+)/,
    dirs: () => [], install: 'https://github.com/stlink-org/stlink/releases',
    hint: process.platform === 'darwin' ? 'brew install stlink' : process.platform === 'win32' ? t('GitHub sürümlerinden') : 'sudo apt install stlink-tools'
  }
];

function versionOf(file, args) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000 }, (err, stdout, stderr) => {
      const out = `${stdout || ''}${stderr || ''}`;
      resolve(err && !out ? null : out);
    });
  });
}

/**
 * @returns {Promise<{ id: string, name: string, found: boolean, path?: string, version?: string, install: string, hint: string, required?: boolean }[]>}
 */
async function detectTools() {
  const results = [];
  for (const tl of tools()) {
    const candidates = [tl.bin, ...tl.dirs().map((d) => path.join(d, tl.bin + EXE)).filter((f) => fs.existsSync(f))];
    let found = null;
    for (const c of candidates) {
      const out = await versionOf(c, tl.args);
      if (out) { found = { path: c, version: (out.match(tl.version) || [])[1] }; break; }
    }
    results.push({ id: tl.id, name: tl.name, found: !!found, ...(found || {}), install: tl.install, hint: tl.hint, required: tl.required });
  }
  return results;
}

module.exports = { detectTools, tools };
