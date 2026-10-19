// @ts-check
/**
 * Derleme yapılandırması (ES-105): tasarımdaki `build` ayarlarından CMake dosyalarını üretir.
 *
 *  cmake/embedded-studio.cmake  her üretimde yazılır: kaynaklar, include yolları, tanımlar, bayraklar, linker,
 *                               .hex/.bin/.map + boyut. embedded_studio_target(<hedef>) ile bir hedefe uygulanır.
 *  cmake/arm-none-eabi.cmake    araç zinciri (GCC yolu ya da deneysel Clang/LLVM)
 *  CMakePresets.json            Debug / Release / MinSizeRel / RelWithDebInfo → build/<preset>/
 *  CMakeLists.txt               'tool': Embedded Studio yönetir (USER CODE bloklu, ince)
 *                               'user': kullanıcı yönetir; sadece yoksa bir başlangıç dosyası oluşturulur
 */
const { join } = require('./layout');
const { familyOf } = require('./families');

const BUILD_TYPES = ['Debug', 'Release', 'MinSizeRel', 'RelWithDebInfo'];
const OPT_LEVELS = ['-O0', '-Og', '-O1', '-O2', '-O3', '-Os', '-Oz'];
const WARNINGS = {
  off: [],
  normal: ['-Wall', '-Wextra'],
  strict: ['-Wall', '-Wextra', '-Wshadow', '-Wdouble-promotion', '-Wformat=2', '-Wundef', '-Wnull-dereference']
};

const DEFAULT_BUILD = {
  cmake: 'tool',
  type: 'Debug',
  opt: { Debug: '-Og', Release: '-O2', MinSizeRel: '-Os', RelWithDebInfo: '-O2' },
  fpu: 'hard',
  specs: { nano: true, nosys: true },
  warnings: 'normal',
  werror: false,
  defines: [],
  includes: [],
  cflags: '',
  ldflags: '',
  linkerScript: '',
  stackUsage: true,
  toolchain: { compiler: 'gcc', gccPath: '', llvmPath: '' }
};

const lines = (v) => (Array.isArray(v) ? v : String(v || '').split(/\r?\n/)).map((s) => String(s).trim()).filter(Boolean);
const pick = (v, allowed, def) => (allowed.includes(v) ? v : def);

/** Eksik/bozuk ayarları varsayılanlarla tamamlar (eski tasarımlarda `build` yoktur). */
function normalizeBuild(b) {
  const s = b && typeof b === 'object' ? b : {};
  const D = DEFAULT_BUILD;
  const opt = {};
  for (const t of BUILD_TYPES) opt[t] = pick(s.opt && s.opt[t], OPT_LEVELS, D.opt[t]);
  const tc = s.toolchain || {};
  return {
    cmake: s.cmake === 'user' ? 'user' : 'tool',
    type: pick(s.type, BUILD_TYPES, D.type),
    opt,
    fpu: pick(s.fpu, ['hard', 'softfp', 'soft'], D.fpu),
    specs: { nano: s.specs ? s.specs.nano !== false : true, nosys: s.specs ? s.specs.nosys !== false : true },
    warnings: pick(s.warnings, Object.keys(WARNINGS), D.warnings),
    werror: !!s.werror,
    defines: lines(s.defines),
    includes: lines(s.includes),
    cflags: String(s.cflags || '').trim(),
    ldflags: String(s.ldflags || '').trim(),
    linkerScript: String(s.linkerScript || '').trim(),
    stackUsage: s.stackUsage !== false,
    toolchain: {
      compiler: tc.compiler === 'clang' ? 'clang' : 'gcc',
      gccPath: String(tc.gccPath || '').trim(),
      llvmPath: String(tc.llvmPath || '').trim()
    }
  };
}

/** CMake preset adı ve derleme klasörü: build/debug, build/release … */
const presetName = (type) => type.toLowerCase();
const buildDir = (b) => `build/${presetName(normalizeBuild(b).type)}`;
/** Projeye göre .elf yolu (proje köküne göre). */
const elfRel = (design) => `${buildDir(design.build)}/${design.project.name}.elf`;
/** ES-303: bootloader açıksa karta bootloader + uygulama birlikte yazılır (<proje>_full.hex) */
const bootOn = (design) => !!(design.boot && design.boot.enabled);
const flashRel = (design) => (bootOn(design) ? `${buildDir(design.build)}/${design.project.name}_full.hex` : elfRel(design));

/** arm-none-eabi-<araç> komutu (seçilen GCC klasörüne göre). */
function gccTool(b, tool) {
  const dir = normalizeBuild(b).toolchain.gccPath;
  const exe = `arm-none-eabi-${tool}${process.platform === 'win32' ? '.exe' : ''}`;
  return dir ? require('path').join(dir, exe) : `arm-none-eabi-${tool}`;
}

/** CMake tırnaklı metni */
const q = (s) => `"${String(s).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
/** CMake tırnaklı metni (yol olmayan: tanım, bayrak) */
const qs = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const fwd = (s) => String(s).replace(/\\/g, '/');
/** Proje köküne göre yol → ${ES_ROOT}/yol (mutlak yollar olduğu gibi) */
const rootPath = (p) => (/^([A-Za-z]:)?[\\/]/.test(p) ? fwd(p) : `\${ES_ROOT}/${fwd(p).replace(/^\.\//, '')}`);
const splitFlags = (s) => String(s || '').split(/\s+/).filter(Boolean);

/** FPU'su olmayan çekirdekte (M0/M0+/M3) ayar ne olursa olsun yazılım float. */
const effectiveFpu = (b, mcu) => (familyOf(mcu).fpu ? normalizeBuild(b).fpu : 'soft');

function mcuFlags(b, mcu) {
  const fam = familyOf(mcu);
  const fpu = effectiveFpu(b, mcu);
  return [`-mcpu=${fam.core}`, '-mthumb', ...(fpu === 'soft' ? ['-mfloat-abi=soft'] : [`-mfpu=${fam.fpu}`, `-mfloat-abi=${fpu}`])];
}

/**
 * FreeRTOS portu (aileye göre). FPU kullanılmıyorsa ARM_CM4F portu derlenmez (FPU bağlamı kaydeder), ARM_CM3 kullanılır.
 * Cortex-M7 için FreeRTOS, r0p1 dışındaki çekirdeklerde ARM_CM4F portunu önerir.
 */
function rtosPort(b, mcu) {
  const port = familyOf(mcu).port;
  return port === 'ARM_CM4F' && effectiveFpu(b, mcu) === 'soft' ? 'ARM_CM3' : port;
}

/** Portun derlenecek dosyaları (CM0 ve CM33 portlarında assembler kısmı ayrı dosyada). */
const rtosPortSources = (port) => ['port.c', ...(/ARM_CM0|ARM_CM33/.test(port) ? ['portasm.c'] : [])];

/**
 * cmake/embedded-studio.cmake
 * @param {{ name: string, mcu: any, framework: 'hal'|'register', rtos: boolean, hseHz: number, P: any, build: any }} o
 */
function cmakeModule(o) {
  const b = normalizeBuild(o.build);
  const { P, mcu, framework } = o;
  const dev = mcu.device;
  const fam = familyOf(mcu);
  const port = rtosPort(b, mcu);
  const linker = b.linkerScript ? rootPath(b.linkerScript) : `\${ES_ROOT}/${join(P.linkerDir, `${mcu.name}_FLASH.ld`)}`;
  const defines = [dev.define, `HSE_VALUE=${o.hseHz}U`, ...(framework === 'hal' ? ['USE_HAL_DRIVER'] : []), ...b.defines];
  const warn = [...WARNINGS[b.warnings], ...(b.werror ? ['-Werror'] : [])];
  const specs = [b.specs.nano && '--specs=nano.specs', b.specs.nosys && '--specs=nosys.specs'].filter(Boolean);
  const list = (items, ind = '  ') => items.map((s) => `${ind}${s}`).join('\n');
  // ES-303: bootloader açıksa uygulama yuvada; vektör tablosu yuva + 1 KB
  const boot = o.boot && o.part ? o.boot : null;
  const part = boot ? o.part : null;
  const hx = (v) => '0x' + (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
  if (boot) defines.push(`ES_APP_VECTORS=${hx(part.vectors)}U`, `ES_FW_VERSION=${hx(require('./bootloader').versionWord(boot.version))}U`, 'USER_VECT_TAB_ADDRESS', `VECT_TAB_OFFSET=${hx(part.vectors - part.bootBase)}U`);
  return `# Embedded Studio tarafından üretildi: ${o.name} / ${mcu.name}. Bu dosya her "Kod Üret"te yeniden yazılır.
# Ayarları değiştirmek için: Embedded Studio > Proje Ayarları > Derleme (ya da kendi CMakeLists.txt'nizde bu
# değişkenleri embedded_studio_target() çağrısından sonra kendiniz ekleyin).
#
# Kendi CMakeLists.txt dosyanızda kullanım:
#   cmake_minimum_required(VERSION 3.20)
#   set(CMAKE_TOOLCHAIN_FILE \${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake CACHE FILEPATH "")
#   project(${o.name} C ASM)
#   include(cmake/embedded-studio.cmake)
#   add_executable(\${PROJECT_NAME} <kendi kaynaklarınız>)
#   embedded_studio_target(\${PROJECT_NAME})            # Embedded Studio kaynaklarını ve ayarlarını ekler
#   # ya da: embedded_studio_target(\${PROJECT_NAME} NO_SOURCES) ve kaynakları \${ES_SOURCES} ile kendiniz verin
#
# Tanımlanan değişkenler: ES_SOURCES (= ES_APP_SOURCES + ES_VENDOR_SOURCES), ES_INCLUDE_DIRS, ES_SYSTEM_INCLUDE_DIRS,
# ES_DEFINES, ES_MCU_FLAGS, ES_C_FLAGS, ES_WARNINGS, ES_LINKER_SCRIPT, ES_LINK_FLAGS.
include_guard(GLOBAL)
get_filename_component(ES_ROOT "\${CMAKE_CURRENT_LIST_DIR}/.." ABSOLUTE)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE ${b.type} CACHE STRING "Debug, Release, MinSizeRel, RelWithDebInfo" FORCE)
endif()
set(CMAKE_C_STANDARD 11)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

set(ES_MCU_FLAGS ${mcuFlags(b, mcu).join(' ')})

# Uygulama kaynakları (kendi src/*.c dosyalarınız otomatik toplanır)
file(GLOB ES_APP_SOURCES CONFIGURE_DEPENDS \${ES_ROOT}/${P.src}/*.c \${ES_ROOT}/${P.drivers}/*.c \${ES_ROOT}/${P.drivers}/reg/*.c)
# Üretici kaynakları: uyarıları kapalı derlenir
set(ES_VENDOR_SOURCES
  \${ES_ROOT}/${P.systemC}
  \${ES_ROOT}/${P.startupDir}/${dev.startup})
${framework === 'hal' ? `file(GLOB ES_HAL_SOURCES \${ES_ROOT}/${P.hal}/Src/${fam.prefix}_hal*.c)
list(FILTER ES_HAL_SOURCES EXCLUDE REGEX "template")
list(APPEND ES_VENDOR_SOURCES \${ES_HAL_SOURCES})
` : ''}${o.rtos ? `list(APPEND ES_VENDOR_SOURCES
  \${ES_ROOT}/${P.rtos}/tasks.c \${ES_ROOT}/${P.rtos}/queue.c \${ES_ROOT}/${P.rtos}/list.c \${ES_ROOT}/${P.rtos}/timers.c
  ${rtosPortSources(port).map((f) => `\${ES_ROOT}/${P.rtos}/portable/GCC/${port}/${f}`).join(' ')} \${ES_ROOT}/${P.rtos}/portable/MemMang/heap_4.c)
` : ''}set(ES_SOURCES \${ES_APP_SOURCES} \${ES_VENDOR_SOURCES})

set(ES_INCLUDE_DIRS
${list([`\${ES_ROOT}/${P.inc}`, `\${ES_ROOT}/${P.drivers}`, `\${ES_ROOT}/${P.drivers}/reg`, ...(boot ? ['\${ES_ROOT}/bootloader'] : []), ...b.includes.map(rootPath)].map((p) => (p.includes(' ') ? q(p) : p)))})
# Üretici başlıkları SYSTEM: uyarı seviyesi onları etkilemez
set(ES_SYSTEM_INCLUDE_DIRS
${list([`\${ES_ROOT}/${P.cmsisCore}`, `\${ES_ROOT}/${P.deviceInc}`, ...(framework === 'hal' ? [`\${ES_ROOT}/${P.hal}/Inc`] : []), ...(o.rtos ? [`\${ES_ROOT}/${P.rtos}/include`, `\${ES_ROOT}/${P.rtos}/portable/GCC/${port}`] : [])])})
set(ES_DEFINES
${list(defines.map(qs))})
set(ES_C_FLAGS -ffunction-sections -fdata-sections -g3${b.stackUsage ? ' -fstack-usage $<$<C_COMPILER_ID:GNU>:-fcallgraph-info=su>' : ''}${b.cflags ? ' ' + splitFlags(b.cflags).map(qs).join(' ') : ''})
set(ES_OPT_FLAGS
  $<$<CONFIG:Debug>:${b.opt.Debug}> $<$<CONFIG:Release>:${b.opt.Release}>
  $<$<CONFIG:MinSizeRel>:${b.opt.MinSizeRel}> $<$<CONFIG:RelWithDebInfo>:${b.opt.RelWithDebInfo}>)
set(ES_WARNINGS${warn.length ? ' ' + warn.join(' ') : ''})
set(ES_LINKER_SCRIPT ${q(linker)})
set(ES_LINK_FLAGS${specs.length ? ' ' + specs.join(' ') : ''} -Wl,--gc-sections -Wl,--print-memory-usage -Wl,--no-warn-rwx-segments${b.ldflags ? ' ' + splitFlags(b.ldflags).map(qs).join(' ') : ''})

# Hedefe uygular: kaynaklar (NO_SOURCES verilmezse), include, tanımlar, bayraklar, linker; derleme sonrası .hex, .bin, .map ve boyut.
function(embedded_studio_target target)
  cmake_parse_arguments(ES "NO_SOURCES" "" "" \${ARGN})
  if(NOT ES_NO_SOURCES)
    target_sources(\${target} PRIVATE \${ES_SOURCES})
  endif()
  target_include_directories(\${target} PRIVATE \${ES_INCLUDE_DIRS})
  target_include_directories(\${target} SYSTEM PRIVATE \${ES_SYSTEM_INCLUDE_DIRS})
  target_compile_definitions(\${target} PRIVATE \${ES_DEFINES})
  target_compile_options(\${target} PRIVATE \${ES_MCU_FLAGS} \${ES_C_FLAGS} \${ES_OPT_FLAGS} \${ES_WARNINGS})
  set_source_files_properties(\${ES_VENDOR_SOURCES} PROPERTIES COMPILE_OPTIONS "-w")${o.rtos && /ARM_CM0|ARM_CM33/.test(port) ? `
  # ${port} portu SysTick_Handler'ı kendisi tanımlar; tick sayacıyla paylaşmak için port.c'de yeniden adlandırılır
  set_source_files_properties(\${ES_ROOT}/${P.rtos}/portable/GCC/${port}/port.c PROPERTIES COMPILE_DEFINITIONS "SysTick_Handler=xPortSysTickHandler")` : ''}
  target_link_options(\${target} PRIVATE \${ES_MCU_FLAGS} -T\${ES_LINKER_SCRIPT} \${ES_LINK_FLAGS}
    -Wl,-Map=$<TARGET_FILE_DIR:\${target}>/\${target}.map)
  set_property(TARGET \${target} APPEND PROPERTY LINK_DEPENDS \${ES_LINKER_SCRIPT})
${boot ? `  # ES-303: derleme kimliği ve imaj başlığı (boyut, CRC-32, commit) — .hex / .bin bundan sonra üretilir
  target_compile_definitions(\${target} PRIVATE "ES_BUILD_ID=\\"\${ES_BUILD_ID}\\"")
  add_custom_command(TARGET \${target} POST_BUILD
    COMMAND \${CMAKE_COMMAND} -DMODE=header -DELF=$<TARGET_FILE:\${target}> -DOBJCOPY=\${CMAKE_OBJCOPY} -P \${ES_ROOT}/cmake/es-image.cmake
    COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:\${target}> $<TARGET_FILE_DIR:\${target}>/\${target}.hex
    COMMAND \${CMAKE_OBJCOPY} --gap-fill 0xFF -O binary $<TARGET_FILE:\${target}> $<TARGET_FILE_DIR:\${target}>/\${target}.bin
    COMMAND \${CMAKE_SIZE} $<TARGET_FILE:\${target}>
    VERBATIM)
` : `  add_custom_command(TARGET \${target} POST_BUILD
    COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:\${target}> $<TARGET_FILE_DIR:\${target}>/\${target}.hex
    COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:\${target}> $<TARGET_FILE_DIR:\${target}>/\${target}.bin
    COMMAND \${CMAKE_SIZE} $<TARGET_FILE:\${target}>
    VERBATIM)
`}endfunction()
${boot ? bootCmake(o, part, dev, fam) : ''}`;
}

/**
 * ES-303: bootloader hedefi (<proje>_boot) ve bootloader + uygulama birleşik HEX'i (<proje>_full.hex: üretim için).
 * Bootloader yalnızca CMSIS ve bootloader/reg sürücülerini kullanır (HAL'siz), her derleme tipinde -Os.
 */
function bootCmake(o, part, dev, fam) {
  const { P } = o;
  return `
# ES-303: derleme kimliği: git kısa özeti, yoksa derleme zamanı (yapılandırmada bir kez)
execute_process(COMMAND git rev-parse --short=12 HEAD WORKING_DIRECTORY \${ES_ROOT}
  OUTPUT_VARIABLE ES_BUILD_ID OUTPUT_STRIP_TRAILING_WHITESPACE ERROR_QUIET RESULT_VARIABLE es_git)
if(es_git OR NOT ES_BUILD_ID)
  string(TIMESTAMP ES_BUILD_ID "%Y%m%d-%H%M%S" UTC)
endif()
${o.boot.signing ? `# ES-305: imzalama anahtarı (yalnızca komut satırı / CI; eklenti kendi anahtar deposunu kullanır)
if(NOT ES_SIGN_KEY AND DEFINED ENV{ES_SIGN_KEY})
  set(ES_SIGN_KEY "$ENV{ES_SIGN_KEY}")
endif()
find_program(ES_NODE node)
` : ''}set(ES_BOOT_LINKER_SCRIPT \${ES_ROOT}/${join(P.linkerDir, `${o.mcu.name}_BOOT.ld`)})

# Bootloader: \${app}_boot (0x${part.bootBase.toString(16).toUpperCase()}, ${part.bootSize / 1024} KB) ve \${app}_full.hex (bootloader + uygulama)
function(embedded_studio_bootloader app)
  set(boot \${app}_boot)
  file(GLOB ES_BOOT_SOURCES CONFIGURE_DEPENDS \${ES_ROOT}/bootloader/*.c \${ES_ROOT}/bootloader/reg/*.c)
  set(ES_BOOT_VENDOR \${ES_ROOT}/${P.systemC} \${ES_ROOT}/${P.startupDir}/${dev.startup})
  add_executable(\${boot} \${ES_BOOT_SOURCES} \${ES_BOOT_VENDOR})
  target_include_directories(\${boot} PRIVATE \${ES_ROOT}/bootloader \${ES_ROOT}/bootloader/reg)
  target_include_directories(\${boot} SYSTEM PRIVATE \${ES_ROOT}/${P.cmsisCore} \${ES_ROOT}/${P.deviceInc})
  target_compile_definitions(\${boot} PRIVATE ${dev.define} HSE_VALUE=${o.hseHz}U)
  target_compile_options(\${boot} PRIVATE \${ES_MCU_FLAGS} -ffunction-sections -fdata-sections -g3 -Os \${ES_WARNINGS})
  target_link_options(\${boot} PRIVATE \${ES_MCU_FLAGS} -T\${ES_BOOT_LINKER_SCRIPT} --specs=nano.specs --specs=nosys.specs
    -Wl,--gc-sections -Wl,--print-memory-usage -Wl,--no-warn-rwx-segments -Wl,-Map=$<TARGET_FILE_DIR:\${boot}>/\${boot}.map)
  set_property(TARGET \${boot} APPEND PROPERTY LINK_DEPENDS \${ES_BOOT_LINKER_SCRIPT})
  add_custom_command(TARGET \${boot} POST_BUILD
    COMMAND \${CMAKE_OBJCOPY} -O ihex $<TARGET_FILE:\${boot}> $<TARGET_FILE_DIR:\${boot}>/\${boot}.hex
    COMMAND \${CMAKE_OBJCOPY} -O binary $<TARGET_FILE:\${boot}> $<TARGET_FILE_DIR:\${boot}>/\${boot}.bin
    COMMAND \${CMAKE_SIZE} $<TARGET_FILE:\${boot}>
    VERBATIM)
  add_custom_target(\${app}_full ALL
    COMMAND \${CMAKE_COMMAND} -DMODE=merge -DBOOT_HEX=$<TARGET_FILE_DIR:\${boot}>/\${boot}.hex -DAPP_HEX=$<TARGET_FILE_DIR:\${app}>/\${app}.hex
      -DOUT=$<TARGET_FILE_DIR:\${app}>/\${app}_full.hex -P \${ES_ROOT}/cmake/es-image.cmake
    DEPENDS \${app} \${boot}
    COMMENT "Bootloader + uygulama: \${app}_full.hex"
    VERBATIM)
${o.boot.signing ? `  # ES-305: imzalı paket (\${app}_signed.bin/.hex, \${app}_full_signed.hex, \${app}_update.json). Embedded Studio'nun
  # Derle'si bunu kendisi yapar; komut satırında / CI'da ES_SIGN_KEY (PEM dosyası, -D ya da ortam değişkeni) ve Node.js gerekir.
  if(ES_SIGN_KEY AND ES_NODE)
    add_custom_target(\${app}_signed ALL
      COMMAND \${ES_NODE} \${ES_ROOT}/cmake/es-sign.js --key \${ES_SIGN_KEY} --pub ${o.boot.pubKey || '-'} --slot 0x${part.slotBase.toString(16).toUpperCase()}
        --bin $<TARGET_FILE_DIR:\${app}>/\${app}.bin --boot-hex $<TARGET_FILE_DIR:\${boot}>/\${boot}.hex --out $<TARGET_FILE_DIR:\${app}> --name \${app}
      DEPENDS \${app}_full
      COMMENT "İmzalı paket: \${app}_signed.bin"
      VERBATIM)
  elseif(ES_SIGN_KEY)
    message(WARNING "ES_SIGN_KEY verildi ama Node.js bulunamadı: imzalı paket üretilmez")
  endif()
` : ''}endfunction()
`;
}

/** cmake/arm-none-eabi.cmake */
function toolchainFile(build) {
  const b = normalizeBuild(build);
  const tc = b.toolchain;
  return `# Embedded Studio: araç zinciri (Proje Ayarları > Derleme > Araç zinciri). Her "Kod Üret"te yeniden yazılır.
# Klasör boşsa araçlar PATH'te aranır. Makineye özel yol için projeyi değiştirmeden:
#   ES_GCC_DIR${tc.compiler === 'clang' ? ' / ES_LLVM_DIR' : ''} ortam değişkeni ya da cmake -DES_GCC_DIR=<arm-none-eabi bin klasörü>
set(CMAKE_SYSTEM_NAME Generic)
set(CMAKE_SYSTEM_PROCESSOR arm)

macro(es_tool_dir var default)
  if(NOT ${'$'}{var})
    if(DEFINED ENV{${'$'}{var}})
      set(${'$'}{var} "$ENV{${'$'}{var}}")
    else()
      set(${'$'}{var} "${'$'}{default}")
    endif()
  endif()
  file(TO_CMAKE_PATH "${'$'}{${'$'}{var}}" ${'$'}{var})
endmacro()
es_tool_dir(ES_GCC_DIR ${q(tc.gccPath)})
list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES ES_GCC_DIR${tc.compiler === 'clang' ? ' ES_LLVM_DIR' : ''})
set(ES_EXE "")
if(CMAKE_HOST_WIN32)
  set(ES_EXE ".exe")
endif()
if(ES_GCC_DIR)
  set(ES_GCC "${'$'}{ES_GCC_DIR}/arm-none-eabi-")
else()
  set(ES_GCC "arm-none-eabi-")
endif()

${tc.compiler === 'clang' ? `# Clang/LLVM (deneysel): C kodu clang ile derlenir; assembler, bağlayıcı ve C kütüphanesi (newlib) arm-none-eabi-gcc'den gelir.
es_tool_dir(ES_LLVM_DIR ${q(tc.llvmPath)})
if(ES_LLVM_DIR)
  set(CMAKE_C_COMPILER "${'$'}{ES_LLVM_DIR}/clang${'$'}{ES_EXE}")
else()
  set(CMAKE_C_COMPILER clang)
endif()
set(CMAKE_C_COMPILER_TARGET arm-none-eabi)
execute_process(COMMAND "${'$'}{ES_GCC}gcc${'$'}{ES_EXE}" -mcpu=cortex-m4 -mthumb -print-sysroot OUTPUT_VARIABLE ES_GCC_SYSROOT OUTPUT_STRIP_TRAILING_WHITESPACE)
file(TO_CMAKE_PATH "${'$'}{ES_GCC_SYSROOT}" ES_GCC_SYSROOT)
set(CMAKE_SYSROOT "${'$'}{ES_GCC_SYSROOT}")
set(CMAKE_C_LINK_EXECUTABLE "\\"${'$'}{ES_GCC}gcc${'$'}{ES_EXE}\\" <CMAKE_C_LINK_FLAGS> <LINK_FLAGS> <OBJECTS> -o <TARGET> <LINK_LIBRARIES>")` : `set(CMAKE_C_COMPILER "${'$'}{ES_GCC}gcc${'$'}{ES_EXE}")`}
set(CMAKE_ASM_COMPILER "${'$'}{ES_GCC}gcc${'$'}{ES_EXE}")
set(CMAKE_OBJCOPY "${'$'}{ES_GCC}objcopy${'$'}{ES_EXE}")
set(CMAKE_SIZE "${'$'}{ES_GCC}size${'$'}{ES_EXE}")
set(CMAKE_EXECUTABLE_SUFFIX ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_C ".elf")
set(CMAKE_EXECUTABLE_SUFFIX_ASM ".elf")
set(CMAKE_TRY_COMPILE_TARGET_TYPE STATIC_LIBRARY)
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
`;
}

/** CMakePresets.json: her derleme tipi ayrı klasörde (build/debug, build/release …). */
function cmakePresets() {
  const configure = [
    {
      name: 'base', hidden: true, generator: 'Ninja',
      binaryDir: '${sourceDir}/build/${presetName}',
      toolchainFile: '${sourceDir}/cmake/arm-none-eabi.cmake',
      cacheVariables: { CMAKE_EXPORT_COMPILE_COMMANDS: 'ON' }
    },
    ...BUILD_TYPES.map((t) => ({ name: presetName(t), displayName: t, inherits: 'base', cacheVariables: { CMAKE_BUILD_TYPE: t } }))
  ];
  return JSON.stringify({
    version: 3,
    cmakeMinimumRequired: { major: 3, minor: 21, patch: 0 },
    configurePresets: configure,
    buildPresets: BUILD_TYPES.map((t) => ({ name: presetName(t), displayName: t, configurePreset: presetName(t) }))
  }, null, 2) + '\n';
}

/** Embedded Studio'nun yönettiği CMakeLists.txt ('user' türü: USER CODE blokları korunur). */
function cmakeListsManaged(name, userBlock, boot = false) {
  return `# Embedded Studio tarafından üretildi. Kendi eklemelerinizi USER CODE bloklarına yazın.
# Derleme ayarları (bayraklar, -O, -D, include, linker, FPU, araç zinciri) cmake/embedded-studio.cmake içindedir;
# Embedded Studio > Proje Ayarları > Derleme'den değiştirin. Bu dosyayı tamamen kendiniz yönetmek için orada
# "CMake'i ben yönetiyorum" seçin.
cmake_minimum_required(VERSION 3.20)
set(CMAKE_TOOLCHAIN_FILE \${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake CACHE FILEPATH "")
project(${name} C ASM)
include(cmake/embedded-studio.cmake)

# Ek kaynaklar: list(APPEND APP_SOURCES yol/dosya.c)
set(APP_SOURCES "")
${userBlock('Sources', 'cmake')}

add_executable(\${PROJECT_NAME} \${APP_SOURCES})
embedded_studio_target(\${PROJECT_NAME})${boot ? `
# Bootloader (Proje Ayarları > Bootloader): \${PROJECT_NAME}_boot ve \${PROJECT_NAME}_full.hex
embedded_studio_bootloader(\${PROJECT_NAME})` : ''}

${userBlock('Targets', 'cmake')}
`;
}

/** "CMake'i ben yönetiyorum": CMakeLists.txt yoksa bir kez oluşturulan başlangıç dosyası. */
function cmakeListsStarter(name) {
  return `# Embedded Studio başlangıç dosyası. Bu CMakeLists.txt sizindir; Embedded Studio buna bir daha yazmaz.
# Embedded Studio'nun ürettiği kaynaklar ve derleme ayarları cmake/embedded-studio.cmake içindedir
# (her "Kod Üret"te yenilenir). Açıklama ve kullanım için o dosyanın başına bakın.
cmake_minimum_required(VERSION 3.20)
set(CMAKE_TOOLCHAIN_FILE \${CMAKE_CURRENT_SOURCE_DIR}/cmake/arm-none-eabi.cmake CACHE FILEPATH "")
project(${name} C ASM)
include(cmake/embedded-studio.cmake)

add_executable(\${PROJECT_NAME})
embedded_studio_target(\${PROJECT_NAME})
`;
}

/** CMakeLists.txt'ye eklenecek satırlar (arayüzde gösterilir). */
const includeSnippet = (name) => `include(cmake/embedded-studio.cmake)
add_executable(\${PROJECT_NAME})   # project(${name} C ASM) sonrası
embedded_studio_target(\${PROJECT_NAME})`;

/** Yalnızca CMake yapılandırması (compile_commands.json için; derlemez). */
const configureCommand = (type) => `cmake -S . -B build/${presetName(type)} -G Ninja -DCMAKE_TOOLCHAIN_FILE=cmake/arm-none-eabi.cmake -DCMAKE_BUILD_TYPE=${type}`;

/** Derleme komutu (VS Code görevi ve README için). */
function buildCommand(type) {
  return `${configureCommand(type)} && cmake --build build/${presetName(type)}`;
}

/** .clangd'nin ilk satırı: bu işaretle başlıyorsa dosya Embedded Studio'nundur ve güncellenebilir. */
const CLANGD_MARK = '# Embedded Studio: clangd';

/**
 * ES-108: clangd (STM32Cube ve clangd eklentileri) derleme veritabanını varsayılan olarak build/ altında arar; CMake ise
 * build/<tip>/ altına yazar. Bulamayınca komutu tahmin eder ve cihaz tanımı (-DSTM32F407xx) ile include yolları gelmez.
 */
function clangdConfig(type, halHeader) {
  return `${CLANGD_MARK} için derleme veritabanı (Proje Ayarları > Derleme > tip). Derleme tipi değişince güncellenir.
# Kendi ayarlarınızı yazmak için bu ilk satırı silin; Embedded Studio o zaman bu dosyaya dokunmaz.
CompileFlags:
  CompilationDatabase: build/${presetName(type)}
  # clang'ın tanımadığı gcc bayrakları
  Remove: [-fcallgraph-info=*, -fstack-usage]
${halHeader ? `---
# ST'nin *_hal_conf.h şablonu tek başına derlenmez (HAL türleri ${halHeader} içinde); açılınca hata göstermesin
If:
  PathMatch: .*_hal_conf\.h
CompileFlags:
  Add: [-include, ${halHeader}]
` : ''}`;
}

/** Microsoft C/C++ eklentisi için compile_commands.json yolu (.vscode/settings.json). */
const compileCommandsSetting = (type) => `\${workspaceFolder}/build/${presetName(type)}/compile_commands.json`;

module.exports = {
  BUILD_TYPES, OPT_LEVELS, WARNINGS, DEFAULT_BUILD,
  normalizeBuild, presetName, buildDir, elfRel, flashRel, bootOn, gccTool, rtosPort, mcuFlags, effectiveFpu,
  cmakeModule, toolchainFile, cmakePresets, cmakeListsManaged, cmakeListsStarter, includeSnippet, buildCommand,
  configureCommand, clangdConfig, compileCommandsSetting, CLANGD_MARK
};
