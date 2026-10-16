// @ts-check
/**
 * Tasarım + atama + saat ağacından derlenebilir bir STM32 projesi üretir.
 *
 * Dosya türleri:
 *  - 'generated'  : her üretimde baştan yazılır, kullanıcı düzenlememeli
 *  - 'user'       : USER CODE BEGIN/END bloklarının içi yeniden üretimde korunur
 *  - 'once'       : sadece yoksa oluşturulur (kullanıcıya ait: .vscode ayarları vb.)
 *
 * Çıktı: { files: [{ path, content, kind }], meta }
 */
const { DRIVERS } = require('./drivers');
const { parseSignal } = require('../engine/pinAssigner');
const bsp = require('./bsp');
const { layout, join } = require('./layout');
const cm = require('./build');
const { familyOf } = require('./families');
const { cIdent, indent } = bsp;

const GENERATOR_VERSION = 5; // 3: bare-metal sade klasör yapısı; 4: cmake/embedded-studio.cmake + CMakePresets.json; 5: çoklu aile (ES-106)

/** Hazır sürücüsü olmayan (kullanıcının yüklediği) komponentler: pinler ve bus hazır, okuma kodu kullanıcıda. */
const GENERIC_DRIVER = {
  files: {},
  include: null,
  globals: null,
  init: null,
  poll: (c) => `/* ${c.comp.name} için hazır sürücü yok. Bus: ${[c.i2c !== '0' && 'I2C ' + c.i2c + ' @ ' + c.addr, c.spi !== '0' && 'SPI ' + c.spi, c.uart !== '0' && 'UART ' + c.uart].filter(Boolean).join(', ') || 'GPIO'}.
 * Okuma kodunu aşağıdaki bloğa yazın; ör. Telemetry_Value("${c.L}.deger", x); */
${c.user}`
};

/** Kullanıcı kod bloğu (içeriği merge.js doldurur). */
const userBlock = (name, style = 'c') => {
  if (style === 'cmake') return `# USER CODE BEGIN ${name}\n# USER CODE END ${name}`;
  if (style === 'md') return `<!-- USER CODE BEGIN ${name} -->\n<!-- USER CODE END ${name} -->`;
  return `/* USER CODE BEGIN ${name} */\n/* USER CODE END ${name} */`;
};

/** Bus'ı paylaşan task'lar için korunması gereken çevre birimleri. */
const sharedBuses = (conns) => [...new Set(conns.filter((c) => (c.kind === 'i2c' || c.kind === 'spi') && c.peripheral).map((c) => c.peripheral))];

/** RTOS task planı. Rate-monotonic: kısa periyot = yüksek öncelik. */
function rtosPlan(design, lib) {
  const tasks = design.instances
    .map((inst) => ({ inst, comp: lib.components[inst.componentId] }))
    .filter(({ comp }) => comp && comp.sampleMs > 0 && (DRIVERS[comp.id] || GENERIC_DRIVER).poll)
    .map(({ inst, comp }) => ({
      inst,
      name: cIdent(inst.label).slice(0, 15),
      periodMs: comp.sampleMs,
      stackWords: comp.id === 'bme280' ? 384 : 256
    }));
  const periods = [...new Set(tasks.map((t) => t.periodMs))].sort((a, b) => b - a);
  for (const t of tasks) t.priority = 2 + periods.indexOf(t.periodMs);
  const monitorStack = 384;
  const stackBytes = tasks.reduce((s, t) => s + t.stackWords * 4, 0) + monitorStack * 4 + 130 * 4;
  const heapBytes = Math.ceil((stackBytes + (tasks.length + 2) * 120 + 2048) / 1024) * 1024;
  return { tasks, monitorStack, heapBytes, maxPriority: 2 + periods.length + 1 };
}

/**
 * @param {any} design  tasarım (design.project.name, design.framework, design.rtos)
 * @param {any} lib
 * @param {any} result  pinAssigner sonucu
 * @param {any} clock   computeClock sonucu
 * @param {{ halConfTemplate?: string }} [opts]
 */
function generate(design, lib, result, clock, opts = {}) {
  const framework = design.framework === 'register' ? 'register' : 'hal';
  const name = (design.project && design.project.name) || 'embedded_app';
  const mcu = lib.mcus[design.mcuId];
  const fam = familyOf(mcu);
  const P = layout(framework, fam.key);
  // Profesyonel + bare-metal: main.c / app.c kullanıcının; araç sadece sürücü, BSP, kesme, derleme dosyalarını yazar
  const owned = framework === 'register' && design.mode === 'pro';
  const build = cm.normalizeBuild(design.build);
  const x = bsp.makeContext(design, lib, result, clock);
  /** @type {{ path: string, content: string, kind: 'generated'|'user'|'once' }[]} */
  const files = [];
  const add = (path, content, kind = 'generated') => files.push({ path, content, kind });
  const stamp = `/* Embedded Studio tarafından üretildi: ${name} / ${mcu.name} / ${framework === 'hal' ? 'STM32 HAL' : 'bare-metal (register)'}.
 * ${'Bu dosya her üretimde yeniden yazılır; değişikliklerinizi app.c içindeki USER CODE bloklarına yazın.'} */\n`;
  const userStamp = `/* Embedded Studio tarafından üretildi: ${name} / ${mcu.name}.
 * Kodunuzu sadece USER CODE BEGIN/END blokları arasına yazın; yeniden üretimde korunur. */\n`;

  // ---- BSP katmanı ----
  add(`${P.inc}/board.h`, bsp.boardHeader(x, design, result, framework, stamp));
  add(`${P.inc}/bsp.h`, bsp.bspHeader(x, result, stamp));
  add(`${P.src}/bsp.c`, framework === 'hal' ? bsp.halBspSource(x, stamp) : bsp.regBspSource(x, stamp));
  add(`${P.src}/board.c`, framework === 'hal' ? bsp.halBoardSource(x, design, stamp) : bsp.regBoardSource(x, design, stamp));
  const starterStamp = `/* Embedded Studio başlangıç dosyası (${name} / ${mcu.name}). Bir kez oluşturuldu; artık tamamen sizindir,
 * Embedded Studio bu dosyaya bir daha yazmaz. */\n`;
  if (owned) {
    add(`${P.src}/bsp_irq.c`, bsp.irqSource(x, design, stamp));
    // USER CODE bloklu: Acemi moddan geçişte eski SysTick/UART işleyicileri (artık bsp_irq.c'de) çakışmasın, kullanıcı kodu korunsun
    add(`${P.src}/${fam.itFile}`, bsp.faultStarter(userStamp, (n) => userBlock(n)), 'user');
  } else {
    add(`${P.src}/${fam.itFile}`, bsp.itSource(x, design, framework, userStamp, (n) => userBlock(n)), 'user');
  }

  // ---- Komponent bağlamları ----
  const insts = design.instances
    .map((inst) => ({ inst, comp: lib.components[inst.componentId] }))
    .filter((v) => v.comp);
  const ctxs = insts.map(({ inst, comp }) => {
    const L = cIdent(inst.label);
    const conns = result.connections.filter((c) => c.instId === inst.id);
    const busOf = (kind) => {
      const c = conns.find((k) => k.kind === kind && k.peripheral && !k.cs);
      return c ? x.busId(c.peripheral) : '0';
    };
    const adc = conns.find((c) => c.kind === 'adc');
    const pwm = conns.find((c) => c.kind === 'pwm');
    return {
      inst, comp, conns, L,
      v: L.toLowerCase(),
      i2c: busOf('i2c'), spi: busOf('spi'), uart: busOf('uart'),
      addr: result.addresses[inst.id] ? `${L}_ADDR` : '0',
      addrHex: result.addresses[inst.id] || '-',
      pin: (compPin) => ({ port: `${L}_${cIdent(compPin)}_Port`, pin: `${L}_${cIdent(compPin)}_Pin` }),
      adc: adc ? Number(parseSignal(adc.signal).fn.replace('IN', '')) : 0,
      pwm: pwm ? { timer: x.busId(pwm.peripheral), ch: Number(parseSignal(pwm.signal).fn.replace('CH', '')) } : { timer: '0', ch: 1 },
      periodMs: comp.sampleMs || 1000,
      user: userBlock(L),
      driver: DRIVERS[comp.id] || GENERIC_DRIVER
    };
  });

  // ---- Telemetri ----
  add(`${P.inc}/telemetry.h`, `${stamp}#ifndef TELEMETRY_H
#define TELEMETRY_H

#include <stdint.h>

/* Embedded Studio telemetri protokolü (satır tabanlı, 115200 8N1):
 *   $I,<proje>,<mcu>,<rtos>         açılış bilgisi
 *   $S,<kaynak>,<durum metni>       komponent durumu (init sonucu)
 *   $V,<kanal>,<değer>              ölçüm değeri, ör. $V,BME280_1.temp,24.512
 *   $T,<task>,<durum>,<öncelik>,<boş stack (word)>,<cpu %>   RTOS task bilgisi
 */
void Telemetry_Init(void);
void Telemetry_Status(const char *source, const char *text);
void Telemetry_Value(const char *channel, float value);                       /* 3 ondalık */
void Telemetry_Fixed(const char *channel, int32_t value, uint8_t decimals);   /* tamsayı / 10^decimals */
void Telemetry_Task(const char *name, const char *state, unsigned prio, unsigned stack_free, float cpu);

#endif
`);
  add(`${P.src}/telemetry.c`, `${stamp}#include "telemetry.h"
#include "bsp.h"
#include <stdio.h>
#include <string.h>
${design.rtos ? '#include "FreeRTOS.h"\n#include "task.h"\n#include "semphr.h"\n\nstatic SemaphoreHandle_t tx_lock;\n' : ''}
static void send(const char *line)
{
  if (BSP_TELEMETRY_UART < 0) return;
${design.rtos ? `  int locked = xTaskGetSchedulerState() == taskSCHEDULER_RUNNING;
  if (locked) xSemaphoreTake(tx_lock, portMAX_DELAY);
  bsp_uart_write((uint8_t)BSP_TELEMETRY_UART, (const uint8_t *)line, (uint16_t)strlen(line));
  if (locked) xSemaphoreGive(tx_lock);` : '  bsp_uart_write((uint8_t)BSP_TELEMETRY_UART, (const uint8_t *)line, (uint16_t)strlen(line));'}
}

void Telemetry_Init(void)
{
${design.rtos ? '  tx_lock = xSemaphoreCreateMutex();\n' : ''}  send("$I,${name},${mcu.name},${design.rtos ? 'FreeRTOS' : 'bare-metal'}\\n");
}

void Telemetry_Status(const char *source, const char *text)
{
  char line[128];
  snprintf(line, sizeof line, "$S,%s,%s\\n", source, text);
  send(line);
}

static int fmt_fixed(char *buf, size_t n, int32_t v, uint8_t decimals)
{
  static const int32_t pow10[] = { 1, 10, 100, 1000, 10000, 100000, 1000000, 10000000 };
  int d = decimals > 7 ? 7 : decimals;
  int32_t p = pow10[d];
  const char *sign = v < 0 ? "-" : "";
  uint32_t a = v < 0 ? (uint32_t)(-(int64_t)v) : (uint32_t)v;
  if (d == 0) return snprintf(buf, n, "%s%lu", sign, (unsigned long)a);
  return snprintf(buf, n, "%s%lu.%0*lu", sign, (unsigned long)(a / (uint32_t)p), d, (unsigned long)(a % (uint32_t)p));
}

void Telemetry_Fixed(const char *channel, int32_t value, uint8_t decimals)
{
  char num[24], line[96];
  fmt_fixed(num, sizeof num, value, decimals);
  snprintf(line, sizeof line, "$V,%s,%s\\n", channel, num);
  send(line);
}

/* printf float desteği (-u _printf_float) gerektirmez */
void Telemetry_Value(const char *channel, float value)
{
  Telemetry_Fixed(channel, (int32_t)(value * 1000.0f + (value >= 0 ? 0.5f : -0.5f)), 3);
}

void Telemetry_Task(const char *name, const char *state, unsigned prio, unsigned stack_free, float cpu)
{
  char num[24], line[96];
  fmt_fixed(num, sizeof num, (int32_t)(cpu * 1000.0f + 0.5f), 3);
  snprintf(line, sizeof line, "$T,%s,%s,%u,%u,%s\\n", name, state, prio, stack_free, num);
  send(line);
}
`);

  // ---- Sürücü dosyaları ----
  const driverFiles = {};
  for (const c of ctxs) Object.assign(driverFiles, c.driver.files || {});
  // Sürücüler drivers.js'de 'Drivers/Components/x.c' olarak tanımlı; yerleşime göre taşınır
  const usageFor = {};
  for (const c of ctxs) for (const p of Object.keys(c.driver.files || {})) if (p.endsWith('.h') && !usageFor[p]) usageFor[p] = usageComment(c);
  for (const [p, content] of Object.entries(driverFiles)) add(p.replace(/^Drivers\/Components\//, `${P.drivers}/`), `${usageFor[p] || ''}/* Embedded Studio sürücüsü. Komponent tasarımdan çıkarılırsa bu dosya da kaldırılır. */\n${content}`);

  // ---- Uygulama ----
  const includes = [...new Set(ctxs.map((c) => c.driver.include).filter(Boolean))];
  const pollers = ctxs.filter((c) => c.driver.poll && c.comp.sampleMs > 0);
  const rxUsers = ctxs.filter((c) => c.driver.rx);
  const globals = ctxs.map((c) => (c.driver.globals ? c.driver.globals(c) : null)).filter(Boolean);
  const initCode = ctxs.map((c) => (c.driver.init ? c.driver.init(c) : null)).filter(Boolean);
  const pollFns = pollers.map((c) => `/* ${c.inst.label}: her ${c.periodMs} ms. Okunan değerler USER CODE bloğunda kullanılabilir. */
static void Poll_${c.L}(void)
{
${indent(c.driver.poll(c))}
}`);

  let start;
  if (design.rtos) {
    const plan = rtosPlan(design, lib);
    const busesUsed = [...new Set(plan.tasks.flatMap((t) => sharedBuses(ctxs.find((c) => c.inst.id === t.inst.id).conns)))];
    const taskFns = plan.tasks.map((t) => {
      const c = ctxs.find((v) => v.inst.id === t.inst.id);
      const buses = sharedBuses(c.conns);
      return `static void Task_${c.L}(void *arg)
{
  TickType_t wake = xTaskGetTickCount();
  (void)arg;
  for (;;) {
${buses.map((b) => `    xSemaphoreTake(lock_${b}, portMAX_DELAY);`).join('\n')}${buses.length ? '\n' : ''}    Poll_${c.L}();
${buses.map((b) => `    xSemaphoreGive(lock_${b});`).join('\n')}${buses.length ? '\n' : ''}    xTaskDelayUntil(&wake, pdMS_TO_TICKS(${t.periodMs}));
  }
}`;
    });
    start = `/* ---- FreeRTOS ---- */
${busesUsed.map((b) => `static SemaphoreHandle_t lock_${b}; /* HAL/BSP bus erişimi thread-safe değil */`).join('\n')}

${taskFns.join('\n\n')}

#define MONITOR_MAX_TASKS 16

static const char *state_name(eTaskState s)
{
  switch (s) {
  case eRunning: return "RUN";
  case eReady: return "READY";
  case eBlocked: return "BLOCKED";
  case eSuspended: return "SUSPENDED";
  default: return "DELETED";
  }
}

/* Her saniye tüm task'ların durumunu, stack boşluğunu ve CPU payını gönderir. */
static void Task_Monitor(void *arg)
{
  static TaskStatus_t st[MONITOR_MAX_TASKS];
  static uint32_t prev_run[MONITOR_MAX_TASKS];
  uint32_t prev_total = 0;
  (void)arg;
  for (;;) {
    uint32_t total;
    UBaseType_t n = uxTaskGetSystemState(st, MONITOR_MAX_TASKS, &total);
    uint32_t d_total = total - prev_total; /* işaretsiz fark: sayaç taşmasına dayanıklı */
    prev_total = total;
    for (UBaseType_t i = 0; i < n; i++) {
      uint32_t idx = st[i].xTaskNumber % MONITOR_MAX_TASKS;
      uint32_t d_run = st[i].ulRunTimeCounter - prev_run[idx];
      prev_run[idx] = st[i].ulRunTimeCounter;
      Telemetry_Task(st[i].pcTaskName, state_name(st[i].eCurrentState), (unsigned)st[i].uxCurrentPriority,
                     (unsigned)st[i].usStackHighWaterMark, d_total ? (float)d_run * 100.0f / (float)d_total : 0.0f);
    }
    Telemetry_Fixed("SYS.heap_free", (int32_t)xPortGetFreeHeapSize(), 0);
    vTaskDelay(pdMS_TO_TICKS(1000));
  }
}

/* configGENERATE_RUN_TIME_STATS için DWT döngü sayacı (Cortex-M0/M0+'da DWT yok: 1 ms çözünürlüklü tick) */
void vConfigureRunTimeCounter(void)
{
#if defined(DWT)
  CoreDebug->DEMCR |= CoreDebug_DEMCR_TRCENA_Msk;
  DWT->CYCCNT = 0;
  DWT->CTRL |= DWT_CTRL_CYCCNTENA_Msk;
#endif
}

uint32_t ulGetRunTimeCounter(void)
{
#if defined(DWT)
  return DWT->CYCCNT;
#else
  return bsp_millis();
#endif
}

void vApplicationStackOverflowHook(TaskHandle_t task, char *task_name)
{
  (void)task;
  (void)task_name;
  Error_Handler();
}

void vApplicationMallocFailedHook(void)
{
  Error_Handler();
}

void App_Start(void)
{
${busesUsed.map((b) => `  lock_${b} = xSemaphoreCreateMutex();`).join('\n')}
${plan.tasks.map((t) => {
    const c = ctxs.find((v) => v.inst.id === t.inst.id);
    return `  xTaskCreate(Task_${c.L}, "${t.name}", ${t.stackWords}, NULL, ${t.priority}, NULL); /* ${t.periodMs} ms */`;
  }).join('\n')}
  xTaskCreate(Task_Monitor, "Monitor", ${plan.monitorStack}, NULL, 1, NULL);
${indent(userBlock('Tasks'))}
  vTaskStartScheduler();
  Error_Handler(); /* buraya gelinirse heap yetersizdir */
}`;
    add(`${P.inc}/FreeRTOSConfig.h`, freertosConfig(plan, owned ? starterStamp : userStamp, !owned, { fpu: cm.effectiveFpu(design.build, mcu) !== 'soft', itFile: fam.itFile }), owned ? 'once' : 'user');
  } else {
    start = `/* ---- Süper döngü (RTOS yok) ---- */
void App_Start(void)
{
  uint32_t next[${Math.max(pollers.length, 1)}] = {0};
  for (;;) {
    uint32_t now = bsp_millis();
${pollers.map((c, i) => `    if ((int32_t)(now - next[${i}]) >= 0) {
      next[${i}] = now + ${c.periodMs};
      Poll_${c.L}();
    }`).join('\n')}
${indent(userBlock('Loop'), 4)}
  }
}`;
  }

  if (!owned) add(`${P.inc}/app.h`, `${userStamp}#ifndef APP_H
#define APP_H

void App_Init(void);
void App_Start(void);

${userBlock('Prototypes')}

#endif
`, 'user');

  if (!owned) add(`${P.src}/app.c`, `${userStamp}#include "app.h"
#include "bsp.h"
#include "telemetry.h"
${includes.map((i) => `#include "${i}"`).join('\n')}
${design.rtos ? '#include "FreeRTOS.h"\n#include "task.h"\n#include "semphr.h"\n' : ''}${userBlock('Includes')}

${globals.join('\n')}
${userBlock('Globals')}

${pollFns.join('\n\n')}
${rxUsers.length ? `
/* UART alma kesmesinden çağrılır (ISR bağlamı): sadece tampona yaz. */
void bsp_uart_rx_callback(uint8_t bus, uint8_t byte)
{
${rxUsers.map((c) => indent(c.driver.rx(c))).join('\n')}
}
` : ''}
void App_Init(void)
{
  Telemetry_Init();
${initCode.map((s) => indent(s)).join('\n')}
${indent(userBlock('Init'))}
}

${start}

${userBlock('Functions')}
`, 'user');

  if (owned) add(`${P.src}/main.c`, starterMain(design, starterStamp, ctxs), 'once');
  else add(`${P.src}/main.c`, `${userStamp}#include "board.h"
#include "app.h"
${userBlock('Includes')}

int main(void)
{
${indent(userBlock('PreInit'))}
  Board_Init();
  App_Init();
${indent(userBlock('PostInit'))}
  App_Start(); /* geri dönmez */
  while (1) {
  }
}
`, 'user');

  // ---- HAL yapılandırması ----
  if (framework === 'hal') add(`${P.inc}/${fam.halConf}`, halConf(opts.halConfTemplate, x, stamp, fam));

  // ---- Derleme sistemi ----
  // Ayarlar cmake/embedded-studio.cmake'te; CMakeLists.txt ya Embedded Studio'nun (USER CODE bloklu) ya da kullanıcının
  const userCmake = build.cmake === 'user';
  add('cmake/embedded-studio.cmake', cm.cmakeModule({ name, mcu, framework, rtos: !!design.rtos, hseHz: Math.round(clock.config.hseMHz * 1e6), P, build }));
  add('cmake/arm-none-eabi.cmake', cm.toolchainFile(build));
  if (userCmake) add('CMakeLists.txt', cm.cmakeListsStarter(name), 'once');
  else add('CMakeLists.txt', cm.cmakeListsManaged(name, userBlock), 'user');
  add('CMakePresets.json', cm.cmakePresets(), userCmake ? 'once' : 'generated');
  add(join(P.linkerDir, `${mcu.name}_FLASH.ld`), linkerScript(mcu));
  add('.vscode/tasks.json', tasksJson(name, mcu), 'once');
  add('.vscode/launch.json', launchJson(name, mcu), 'once');
  add('.vscode/settings.json', JSON.stringify({ 'files.autoSave': 'afterDelay', 'files.autoSaveDelay': 1000, 'cmake.configureOnOpen': false }, null, 2) + '\n', 'once');
  add('.gitignore', 'build/\n.embedded-studio/removed/\n', 'once');

  // ---- Yapay zekâ ajanları için rehber ----
  const guide = agentGuide(design, lib, result, mcu, framework, name, files.map((f) => f));
  add('AGENTS.md', guide, 'user');
  add('CLAUDE.md', `${mdStamp()}Bu projenin kuralları \`AGENTS.md\` dosyasındadır; önce onu okuyun.\n\n@AGENTS.md\n\n${userBlock('Notes', 'md')}\n`, 'user');
  add('GEMINI.md', `${mdStamp()}Bu projenin kuralları \`AGENTS.md\` dosyasındadır; önce onu okuyun.\n\n${userBlock('Notes', 'md')}\n`, 'user');
  add('.github/copilot-instructions.md', `${mdStamp()}Bu projenin kuralları kök dizindeki \`AGENTS.md\` dosyasındadır; önce onu okuyun.\n\n${userBlock('Notes', 'md')}\n`, 'user');
  add('README.md', readme(design, result, mcu, framework, name, clock), 'user');

  return { files, meta: { name, framework, version: GENERATOR_VERSION } };
}

/**
 * Sürücü başlığının başına eklenen kullanım örneği: bu projedeki gerçek bus/adres/pinlerle
 * (Embedded Studio'nun app.c'de ürettiği kodun aynısı). Satır yorumu (//) kullanılır ki koddaki blok yorumlar bozulmasın.
 */
function usageComment(c) {
  const code = (s) => (s || '').split('\n').filter((l) => l.trim() && !/USER CODE|Telemetry_/.test(l));
  const d = c.driver;
  const ctx = { ...c, user: '' };
  const lines = [
    `Kullanım örneği (bu projedeki ${c.L} için; kendi dosyanıza kopyalayabilirsiniz):`,
    '',
    `  #include "${d.include}"`,
    ...(d.globals ? ['', ...code(d.globals(ctx)).map((l) => '  ' + l)] : []),
    ...(d.init ? ['', '  /* Board_Init() sonrası, bir kez: */', ...code(d.init(ctx)).map((l) => '  ' + l)] : []),
    ...(d.poll ? ['', `  /* Periyodik${c.comp.sampleMs ? ` (her ${c.comp.sampleMs} ms)` : ''}: */`, ...code(d.poll(ctx)).map((l) => '  ' + l)] : []),
    ...(d.rx ? ['', '  /* UART alma kesmesinden (bsp_uart_rx_callback içinde): */', ...code(d.rx(ctx)).map((l) => '  ' + l)] : [])
  ];
  return lines.map((l) => `// ${l}`.trimEnd()).join('\n') + '\n';
}

/** Profesyonel bare-metal: bir kez oluşturulan main.c. Uygulama kodunu kullanıcı yazar. */
function starterMain(design, stamp, ctxs) {
  const drivers = [...new Set(ctxs.map((c) => c.driver.include).filter(Boolean))];
  return `${stamp}#include "board.h"
#include "bsp.h"
${design.rtos ? '#include "FreeRTOS.h"\n#include "task.h"\n' : ''}
/* Seçtiğiniz komponentlerin sürücüleri drivers/ altında; her başlığın başında bu projeye göre bir kullanım örneği var${drivers.length ? `:\n * ${drivers.join(', ')}` : '.'} */

int main(void)
{
  Board_Init(); /* saat, GPIO ve çevre birimleri (Embedded Studio üretir: board.c) */
${design.rtos ? `
  /* xTaskCreate(...) ile task'larınızı oluşturun. */
  vTaskStartScheduler();
` : ''}
  for (;;) {
  }
}
${design.rtos ? `
void vApplicationStackOverflowHook(TaskHandle_t task, char *task_name)
{
  (void)task;
  (void)task_name;
  Error_Handler();
}

void vApplicationMallocFailedHook(void)
{
  Error_Handler();
}
` : ''}`;
}

const mdStamp = () => '<!-- Embedded Studio tarafından üretildi. Kendi notlarınızı USER CODE bloğuna yazın. -->\n';

function halConf(template, x, stamp, fam) {
  const enabled = new Set(['HAL_MODULE_ENABLED', 'HAL_CORTEX_MODULE_ENABLED', 'HAL_RCC_MODULE_ENABLED', 'HAL_GPIO_MODULE_ENABLED',
    'HAL_PWR_MODULE_ENABLED', 'HAL_FLASH_MODULE_ENABLED', 'HAL_DMA_MODULE_ENABLED', 'HAL_EXTI_MODULE_ENABLED']);
  if (x.buses.i2c.length) enabled.add('HAL_I2C_MODULE_ENABLED');
  if (x.buses.spi.length) enabled.add('HAL_SPI_MODULE_ENABLED');
  if (x.buses.uart.length) enabled.add('HAL_UART_MODULE_ENABLED');
  if (x.buses.adc.length) enabled.add('HAL_ADC_MODULE_ENABLED');
  if (x.buses.pwm.length) enabled.add('HAL_TIM_MODULE_ENABLED');
  if (!template) {
    return `${stamp}#error "${fam.series} HAL paketi bulunamadı. Embedded Studio > Kod Üret, HAL paketini indirmeyi önerecektir."\n`;
  }
  const body = template.replace(/^[ \t]*(?:\/\*\s*)?#define\s+(HAL_\w*MODULE_ENABLED)\s*(?:\*\/)?[ \t]*$/gm, (_, mod) =>
    enabled.has(mod) ? `#define ${mod}` : `/* #define ${mod} */`);
  return `${stamp}/* ${fam.halConfTemplate} tabanlıdır; sadece kullanılan modüller açık. */\n${body}`;
}

/** stats=false: çalışma zamanı istatistikleri kapalı (profesyonel modda sayaç fonksiyonlarını kullanıcı yazmaz). */
/** opts.fpu: FPU kullanılıyor mu (CM33 portu configENABLE_FPU ister) */
function freertosConfig(plan, stamp, stats = true, opts = { fpu: true, itFile: 'stm32f4xx_it.c' }) {
  return `${stamp}#ifndef FREERTOS_CONFIG_H
#define FREERTOS_CONFIG_H

#if defined(__ICCARM__) || defined(__CC_ARM) || defined(__GNUC__)
#include <stdint.h>
extern uint32_t SystemCoreClock;
void vConfigureRunTimeCounter(void);
uint32_t ulGetRunTimeCounter(void);
#endif

#define configUSE_PREEMPTION                    1
#define configCPU_CLOCK_HZ                      (SystemCoreClock)
#define configTICK_RATE_HZ                      ((TickType_t)1000)
#define configMAX_PRIORITIES                    (${plan.maxPriority + 1})
#define configMINIMAL_STACK_SIZE                ((uint16_t)130)
#define configTOTAL_HEAP_SIZE                   ((size_t)${plan.heapBytes})
#define configMAX_TASK_NAME_LEN                 16
#define configUSE_16_BIT_TICKS                  0
#define configUSE_MUTEXES                       1
#define configUSE_IDLE_HOOK                     0
#define configUSE_TICK_HOOK                     0
#define configCHECK_FOR_STACK_OVERFLOW          2
#define configUSE_MALLOC_FAILED_HOOK            1
#define configSUPPORT_DYNAMIC_ALLOCATION        1
#define configSUPPORT_STATIC_ALLOCATION         0

${stats ? `/* Embedded Studio task monitörü için */
#define configUSE_TRACE_FACILITY                1
#define configGENERATE_RUN_TIME_STATS           1
#define portCONFIGURE_TIMER_FOR_RUN_TIME_STATS() vConfigureRunTimeCounter()
#define portGET_RUN_TIME_COUNTER_VALUE()        ulGetRunTimeCounter()` : `/* Task CPU istatistikleri için 1 yapın ve vConfigureRunTimeCounter / ulGetRunTimeCounter fonksiyonlarını yazın. */
#define configUSE_TRACE_FACILITY                1
#define configGENERATE_RUN_TIME_STATS           0`}

#define INCLUDE_vTaskDelay                      1
#define INCLUDE_xTaskDelayUntil                 1
#define INCLUDE_uxTaskGetStackHighWaterMark     1
#define INCLUDE_xTaskGetSchedulerState          1

/* Kesme öncelikleri: Cortex-M3/M4/M7/M33 STM32'lerde 4 bit (M0/M0+'da BASEPRI yok, bu değerler kullanılmaz) */
#define configPRIO_BITS                         4
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY 15
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY 5
#define configKERNEL_INTERRUPT_PRIORITY         (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY    (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))

#define configASSERT(x) if ((x) == 0) { taskDISABLE_INTERRUPTS(); for (;;); }

/* Cortex-M33 (ARM_CM33_NTZ) portu için */
#define configENABLE_FPU                        ${opts.fpu ? 1 : 0}
#define configENABLE_MPU                        0
#define configENABLE_TRUSTZONE                  0

/* Port kesmeleri. SysTick_Handler ${opts.itFile} içinde tick sayacıyla paylaşılıyor. */
#define vPortSVCHandler    SVC_Handler
#define xPortPendSVHandler PendSV_Handler

${userBlock('Config')}

#endif
`;
}

function linkerScript(mcu) {
  return `/* Embedded Studio: ${mcu.name} bağlayıcı betiği (${mcu.device.flashKB} KB flash, ${mcu.device.ramKB} KB RAM) */
ENTRY(Reset_Handler)

_estack = ORIGIN(RAM) + LENGTH(RAM);
_Min_Heap_Size = 0x200;
_Min_Stack_Size = 0x400;

MEMORY
{
  RAM   (xrw) : ORIGIN = 0x20000000, LENGTH = ${mcu.device.ramKB}K
  FLASH (rx)  : ORIGIN = 0x08000000, LENGTH = ${mcu.device.flashKB}K
}

SECTIONS
{
  .isr_vector :
  {
    . = ALIGN(4);
    KEEP(*(.isr_vector))
    . = ALIGN(4);
  } >FLASH

  .text :
  {
    . = ALIGN(4);
    *(.text)
    *(.text*)
    *(.glue_7)
    *(.glue_7t)
    *(.eh_frame)
    KEEP (*(.init))
    KEEP (*(.fini))
    . = ALIGN(4);
    _etext = .;
  } >FLASH

  .rodata :
  {
    . = ALIGN(4);
    *(.rodata)
    *(.rodata*)
    . = ALIGN(4);
  } >FLASH

  .ARM.extab : { *(.ARM.extab* .gnu.linkonce.armextab.*) } >FLASH
  .ARM :
  {
    __exidx_start = .;
    *(.ARM.exidx*)
    __exidx_end = .;
  } >FLASH

  .preinit_array :
  {
    PROVIDE_HIDDEN (__preinit_array_start = .);
    KEEP (*(.preinit_array*))
    PROVIDE_HIDDEN (__preinit_array_end = .);
  } >FLASH
  .init_array :
  {
    PROVIDE_HIDDEN (__init_array_start = .);
    KEEP (*(SORT(.init_array.*)))
    KEEP (*(.init_array*))
    PROVIDE_HIDDEN (__init_array_end = .);
  } >FLASH
  .fini_array :
  {
    PROVIDE_HIDDEN (__fini_array_start = .);
    KEEP (*(SORT(.fini_array.*)))
    KEEP (*(.fini_array*))
    PROVIDE_HIDDEN (__fini_array_end = .);
  } >FLASH

  _sidata = LOADADDR(.data);

  .data :
  {
    . = ALIGN(4);
    _sdata = .;
    *(.data)
    *(.data*)
    *(.RamFunc)
    *(.RamFunc*)
    . = ALIGN(4);
    _edata = .;
  } >RAM AT> FLASH

  . = ALIGN(4);
  .bss :
  {
    _sbss = .;
    __bss_start__ = _sbss;
    *(.bss)
    *(.bss*)
    *(COMMON)
    . = ALIGN(4);
    _ebss = .;
    __bss_end__ = _ebss;
  } >RAM

  ._user_heap_stack :
  {
    . = ALIGN(8);
    PROVIDE ( end = . );
    PROVIDE ( _end = . );
    . = . + _Min_Heap_Size;
    . = . + _Min_Stack_Size;
    . = ALIGN(8);
  } >RAM

  .ARM.attributes 0 : { *(.ARM.attributes) }
}
`;
}

/** Windows'ta && için cmd.exe (PowerShell 5 && desteklemez) */
const WIN_SHELL = { options: { shell: { executable: 'cmd.exe', args: ['/d', '/c'] } } };

function tasksJson(name, mcu) {
  const build = (type, isDefault) => ({
    label: `Embedded Studio: Derle${isDefault ? '' : ` (${type})`}`, type: 'shell', command: cm.buildCommand(type), windows: WIN_SHELL,
    group: isDefault ? { kind: 'build', isDefault: true } : 'build', problemMatcher: ['$gcc']
  });
  return JSON.stringify({
    version: '2.0.0',
    tasks: [
      build('Debug', true), build('Release'), build('MinSizeRel'),
      { label: 'Embedded Studio: Yükle (ST-Link)', type: 'shell', command: `openocd -f interface/stlink.cfg -f ${mcu.device.openocdTarget} -c "program build/debug/${name}.elf verify reset exit"`, dependsOn: 'Embedded Studio: Derle', problemMatcher: [] }
    ]
  }, null, 2) + '\n';
}

function launchJson(name, mcu) {
  return JSON.stringify({
    version: '0.2.0',
    configurations: [{
      name: 'Debug (Cortex-Debug + OpenOCD)',
      type: 'cortex-debug',
      request: 'launch',
      servertype: 'openocd',
      cwd: '${workspaceFolder}',
      executable: `build/debug/${name}.elf`,
      configFiles: ['interface/stlink.cfg', mcu.device.openocdTarget],
      runToEntryPoint: 'main',
      preLaunchTask: 'Embedded Studio: Derle'
    }]
  }, null, 2) + '\n';
}

function agentGuide(design, lib, result, mcu, framework, name, files) {
  const generated = files.filter((f) => f.kind === 'generated').map((f) => `- \`${f.path}\``).join('\n');
  const userFiles = files.filter((f) => f.kind === 'user' && f.path.endsWith('.c') || f.kind === 'user' && f.path.endsWith('.h')).map((f) => `- \`${f.path}\``).join('\n');
  const label = (id) => design.instances.find((i) => i.id === id)?.label ?? id;
  const pins = result.connections.map((c) => `| ${label(c.instId)} | ${c.compPin} | ${c.mcuPin} | ${c.signal} |`).join('\n');
  const b = cm.normalizeBuild(design.build);
  const cmakeRow = b.cmake === 'user'
    ? '| Derleme ayarı / ek kaynak | `CMakeLists.txt` kullanıcınındır (Embedded Studio yazmaz); üretilen ayarlar `cmake/embedded-studio.cmake` içinde, `embedded_studio_target()` ile uygulanır |'
    : '| Ek kaynak / hedef | `CMakeLists.txt` → `Sources`, `Targets` |\n| Derleme ayarı (bayrak, -O, -D, FPU, linker) | Embedded Studio > Proje Ayarları > Derleme → `cmake/embedded-studio.cmake` (elle düzenlemeyin) |';
  return `${mdStamp()}# ${name}: yapay zekâ ajanları için proje kuralları

Bu proje **Embedded Studio** (VS Code eklentisi) ile tasarlanır. Donanım tasarımı (komponentler, pinler,
saat ağacı, RTOS) \`embedded-studio.json\` dosyasında tutulur ve kodun bir kısmı ondan **otomatik üretilir**.
Claude, ChatGPT/Codex, Gemini, Copilot vb. ajanlar aşağıdaki kurallara uymalıdır; aksi halde değişiklikleriniz
bir sonraki "Kod Üret" işleminde kaybolur.

## Kurallar

1. **Üretilen dosyaları düzenlemeyin.** Bunlar her üretimde baştan yazılır:
${generated}
2. **Kullanıcı kodu sadece \`USER CODE BEGIN <ad>\` / \`USER CODE END <ad>\` blokları arasına yazılır.** Bu blokların
   içi yeniden üretimde korunur, dışı silinir. Blok işaretlerini silmeyin, adlarını değiştirmeyin. Blok içeren dosyalar:
${userFiles}
3. **Yeni sensör eklemek / çıkarmak / pin değiştirmek için kodu elle değiştirmeyin.** Kullanıcıdan bunu Embedded Studio
   tasarımcısında yapmasını ve "Kod Üret" demesini isteyin. Eklenti sürücüyü ekler/kaldırır, pinleri ve init kodunu günceller.
4. Yeni, tamamen size ait dosyalar (ör. \`${layout(framework, familyOf(mcu).key).src}/control.c\`) serbestçe eklenebilir; CMake \`${layout(framework, familyOf(mcu).key).src}/*.c\` dosyalarını otomatik toplar.
5. Donanıma erişim için \`bsp.h\` API'sini kullanın (\`bsp_i2c_read\`, \`bsp_gpio_write\`, ...). ${framework === 'hal' ? 'HAL fonksiyonları da kullanılabilir.' : 'Bu proje bare-metal (register) altyapısındadır; HAL yoktur, CMSIS register tanımlarını kullanın.'}
6. Telemetri için \`telemetry.h\`: \`Telemetry_Value("KANAL.ad", deger)\`. Embedded Studio monitörü bu kanalları otomatik çizer.
7. Son tasarım değişikliği ve hangi dosyaların etkilendiği: \`.embedded-studio/LAST_CHANGES.md\`. Bir göreve başlamadan önce okuyun.

## Nereye ne yazılır

${framework === 'register' && design.mode === 'pro' ? `Bu proje **profesyonel bare-metal** modunda: uygulama kodunu kullanıcı yazar. \`src/main.c\`, \`src/${familyOf(mcu).itFile}\`${design.rtos ? ', `inc/FreeRTOSConfig.h`' : ''} bir kez
başlangıç olarak oluşturuldu ve artık tamamen kullanıcınındır; Embedded Studio bunlara ve \`src/\` altındaki diğer kullanıcı dosyalarına yazmaz.

| Amaç | Dosya |
|---|---|
| Uygulama kodu | \`src/main.c\` ve kendi \`src/*.c\` dosyalarınız (CMake otomatik toplar) |
| Sensör sürücüsünü kullanmak | \`drivers/<sürücü>.h\` başındaki "Kullanım örneği" (bu projenin bus/adres/pinleriyle) |
| 1 ms periyodik iş | Kendi dosyanızda \`void bsp_systick_hook(void)\` tanımlayın (weak) |
| UART'tan gelen byte | Kendi dosyanızda \`void bsp_uart_rx_callback(uint8_t bus, uint8_t byte)\` tanımlayın (weak) |
| Hata işleyicileri | \`src/${familyOf(mcu).itFile}\` (SysTick ve UART kesmeleri üretilen \`src/bsp_irq.c\`'de) |
${cmakeRow}` : `| Amaç | Dosya / blok |
|---|---|
| Sensör verisini işlemek | \`app.c\` → \`Poll_<SENSÖR>()\` içindeki \`USER CODE BEGIN <SENSÖR>\` (okunan değişkenler kapsamda) |
| Global değişken / yardımcı fonksiyon | \`app.c\` → \`Globals\`, \`Functions\` |
| Başlangıç kodu | \`app.c\` → \`Init\`; \`main.c\` → \`PreInit\` / \`PostInit\` |
| ${design.rtos ? 'Kendi FreeRTOS task\'ları | `app.c` → `Tasks` (vTaskStartScheduler öncesi xTaskCreate)' : 'Ana döngü işi | `app.c` → `Loop`'} |
| Kesme işleyicileri | \`${familyOf(mcu).itFile}\` → \`Handlers\` |
${cmakeRow}`}

## Donanım özeti

- MCU: ${mcu.name} (${mcu.board}), altyapı: ${framework === 'hal' ? 'STM32 HAL' : 'bare-metal (CMSIS register)'}, ${design.rtos ? 'FreeRTOS' : 'RTOS yok (süper döngü)'}
- Derleme: \`cmake --preset ${cm.presetName(b.type)} && cmake --build --preset ${cm.presetName(b.type)}\` → \`${cm.buildDir(b)}/${name}.elf\`, \`.hex\`, \`.bin\`, \`.map\` (preset'ler: debug, release, minsizerel, relwithdebinfo)

| Komponent | Pin | MCU | Sinyal |
|---|---|---|---|
${pins}

${userBlock('Notes', 'md')}
`;
}

function readme(design, result, mcu, framework, name, clock) {
  const label = (id) => design.instances.find((i) => i.id === id)?.label ?? id;
  const rows = result.connections.map((c) => `| ${label(c.instId)} | ${c.compPin} | ${c.mcuPin} | ${c.signal} |`);
  const power = result.power.map((p) => `| ${label(p.instId)} | ${p.compPin} | ${p.net} | Besleme |`);
  const f = clock.freq;
  return `${mdStamp()}# ${name}

Embedded Studio ile üretildi. MCU: **${mcu.name}** (${mcu.board}) · ${framework === 'hal' ? 'STM32 HAL' : 'bare-metal (register)'} ·
${design.rtos ? 'FreeRTOS' : 'RTOS yok'} · SYSCLK ${f.sysclk} MHz (APB1 ${f.pclk1} / APB2 ${f.pclk2} MHz)

## Bağlantı tablosu

| Komponent | Pin | MCU | Sinyal |
|---|---|---|---|
${[...rows, ...power].join('\n')}

## Derleme ve yükleme

VS Code: \`Ctrl+Shift+B\` (Embedded Studio: Derle). Yüklemek için Embedded Studio > Debug > Yükle.
Derleme ayarları: Embedded Studio > Proje Ayarları > Derleme (\`cmake/embedded-studio.cmake\`).

\`\`\`
cmake --preset debug            # ya da release, minsizerel, relwithdebinfo
cmake --build --preset debug    # build/debug/${name}.elf, .hex, .bin, .map
openocd -f interface/stlink.cfg -f ${mcu.device.openocdTarget} -c "program build/debug/${name}.elf verify reset exit"
\`\`\`

${userBlock('Notes', 'md')}
`;
}

module.exports = { generate, rtosPlan, cIdent, GENERATOR_VERSION };
