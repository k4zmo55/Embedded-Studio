// Desteklenen işlemciler (ES-106). Pinler, alternatif fonksiyonlar ve çevre birimleri ST'nin açık pin veritabanından
// (STM32_open_pin_data), saat açma register'ları ve kesme adları CMSIS cihaz başlıklarından üretilir (gen-mcus.js).
// Burada sadece veritabanında olmayan bilgiler durur: kart, bellek, saat ağacı sınırları ve varsayılan saat ayarı.
//
// Saat modelleri (src/engine/clock.js):
//   f4  : HSI/HSE → /M → ×N → /P (SYSCLK), /Q (48 MHz)               F4, F7
//   mul : HSI/2 ya da HSE/PREDIV(M) → ×PLLMUL(N) (SYSCLK)              F0, F1, F3
//   mnr : HSI16/HSE → /M → ×N → /R (SYSCLK)                            G0, G4, L4, U5
//   h7  : HSI64/HSE → /DIVM1 → ×N1 → /P1 (SYSCLK), /Q1 (SPI1-3 çekirdek saati)
// flashLatency: [HCLK üst sınırı (MHz), bekleme durumu] — en yüksek gerilim aralığı için.

const range = (a, b, step = 1) => Array.from({ length: Math.floor((b - a) / step) + 1 }, (_, i) => a + i * step);
const AHB = [1, 2, 4, 8, 16, 64, 128, 256, 512];
const APB = [1, 2, 4, 8, 16];
const ds = (part) => `https://www.st.com/resource/en/datasheet/${part}.pdf`;
const rm = (doc) => `https://www.st.com/resource/en/reference_manual/${doc}.pdf`;
const svd = (name) => `https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data/STMicro/${name}.svd`;

// Kartlara göre özel pinler (notlar pin atayıcıda bu pinleri son tercihe bırakır)
const NUCLEO64 = { PA2: 'ST-LINK VCP TX (USART2)', PA3: 'ST-LINK VCP RX (USART2)', PA5: 'LD2 kart LED\'i', PC13: 'B1 kullanıcı butonu' };
const NUCLEO144 = { PD8: 'ST-LINK VCP TX (USART3)', PD9: 'ST-LINK VCP RX (USART3)', PB0: 'LD1 kart LED\'i', PB7: 'LD2 kart LED\'i', PB14: 'LD3 kart LED\'i', PC13: 'B1 kullanıcı butonu',
  PA1: 'Ethernet RMII', PA2: 'Ethernet RMII', PA7: 'Ethernet RMII', PC1: 'Ethernet RMII', PC4: 'Ethernet RMII', PC5: 'Ethernet RMII', PG11: 'Ethernet RMII', PG13: 'Ethernet RMII', PB13: 'Ethernet RMII',
  PA11: 'USB D-', PA12: 'USB D+' };

module.exports = [
  // Elle girilmiş ilk tanım (DS10314'ten): üzerine yazılmaz, üretim aracının doğruluğunu sınamak için karşılaştırılır
  { id: 'stm32f411ceu6', ref: 'STM32F411C(C-E)Ux', family: 'f4', define: 'STM32F411xE', verifyOnly: true, hse: 25, pinNotes: {}, clock: {} },
  {
    id: 'stm32f030c8t6', name: 'STM32F030C8T6', ref: 'STM32F030C8Tx', family: 'f0', board: 'LQFP48 (generic)',
    define: 'STM32F030x8', startup: 'startup_stm32f030x8.s', flashKB: 64, ramKB: 8, maxClockMHz: 48,
    datasheet: ds('stm32f030c8'), referenceManual: rm('rm0360-stm32f030x4x6x8xc-and-stm32f070x6xb-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F030'),
    hse: 8, pinNotes: {},
    clock: {
      model: 'mul', hsiMHz: 8, hsiPllDiv: 2, hseMHz: 8, hseRange: [4, 32],
      limits: { sysclk: 48, hclk: 48, apb1: 48, pllOut: [16, 48] }, pllM: [1, 16], pllN: [2, 16],
      ahb: AHB, apb: APB, flashLatency: [[24, 0], [48, 1]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 12, ahb: 1, apb1: 1 }
    }
  },
  {
    id: 'stm32f103c8t6', name: 'STM32F103C8T6', ref: 'STM32F103C(8-B)Tx', family: 'f1', board: 'Blue Pill',
    define: 'STM32F103xB', startup: 'startup_stm32f103xb.s', flashKB: 64, ramKB: 20, maxClockMHz: 72,
    datasheet: ds('stm32f103c8'), referenceManual: rm('rm0008-stm32f101xx-stm32f102xx-stm32f103xx-stm32f105xx-and-stm32f107xx-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F103xx'),
    hse: 8, pinNotes: { PC13: 'Kart LED\'i (aktif düşük)', PA11: 'USB D-', PA12: 'USB D+' },
    clock: {
      model: 'mul', hsiMHz: 8, hsiPllDiv: 2, hseMHz: 8, hseRange: [4, 16],
      limits: { sysclk: 72, hclk: 72, apb1: 36, apb2: 72, pllOut: [16, 72] }, pllM: [1, 2], pllN: [2, 16],
      ahb: AHB, apb: APB, flashLatency: [[24, 0], [48, 1], [72, 2]],
      default: { pllSource: 'HSE', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 9, ahb: 1, apb1: 2, apb2: 1 }
    }
  },
  {
    id: 'stm32f303ret6', name: 'STM32F303RET6', ref: 'STM32F303R(D-E)Tx', family: 'f3', board: 'Nucleo-F303RE',
    define: 'STM32F303xE', startup: 'startup_stm32f303xe.s', flashKB: 512, ramKB: 64, maxClockMHz: 72,
    datasheet: ds('stm32f303re'), referenceManual: rm('rm0316-stm32f303xbcde-stm32f303x68-stm32f328x8-stm32f358xc-stm32f398xe-advanced-armbased-mcus-stmicroelectronics'), svdUrl: svd('STM32F303'),
    hse: 8, pinNotes: NUCLEO64,
    clock: {
      // F303xE: HSI de PREDIV'den geçer (RCC_CFGR_PLLSRC_HSI_PREDIV), HSI/1 × 9 = 72 MHz
      model: 'mul', hsiMHz: 8, hsiPrediv: true, hseMHz: 8, hseRange: [4, 32],
      limits: { sysclk: 72, hclk: 72, apb1: 36, apb2: 72, pllOut: [16, 72] }, pllM: [1, 16], pllN: [2, 16],
      ahb: AHB, apb: APB, flashLatency: [[24, 0], [48, 1], [72, 2]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 9, ahb: 1, apb1: 2, apb2: 1 }
    }
  },
  {
    id: 'stm32f407vgt6', name: 'STM32F407VGT6', ref: 'STM32F407V(E-G)Tx', family: 'f4', board: 'STM32F4-Discovery',
    define: 'STM32F407xx', startup: 'startup_stm32f407xx.s', flashKB: 1024, ramKB: 128, maxClockMHz: 168,
    datasheet: ds('stm32f407vg'), referenceManual: rm('rm0090-stm32f405415-stm32f407417-stm32f427437-and-stm32f429439-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F407'),
    hse: 8, pinNotes: { PD12: 'LD4 yeşil LED', PD13: 'LD3 turuncu LED', PD14: 'LD5 kırmızı LED', PD15: 'LD6 mavi LED', PA0: 'B1 kullanıcı butonu',
      PA5: 'LIS3DSH ivmeölçer SPI1', PA6: 'LIS3DSH ivmeölçer SPI1', PA7: 'LIS3DSH ivmeölçer SPI1', PE3: 'LIS3DSH CS', PB6: 'CS43L22 ses I2C1', PB9: 'CS43L22 ses I2C1',
      PD4: 'CS43L22 reset', PA9: 'USB OTG VBUS', PA11: 'USB D-', PA12: 'USB D+' },
    clock: {
      model: 'f4', hsiMHz: 16, hseMHz: 8, hseRange: [4, 26],
      limits: { sysclk: 168, hclk: 168, apb1: 42, apb2: 84, vcoIn: [0.95, 2.1], vcoOut: [100, 432], pll48: 48 },
      pllM: [2, 63], pllN: [50, 432], pllP: [2, 4, 6, 8], pllQ: [2, 15], ahb: AHB, apb: APB,
      flashLatency: [[30, 0], [60, 1], [90, 2], [120, 3], [150, 4], [168, 5]],
      default: { pllSource: 'HSE', sysclkSource: 'PLL', hseMHz: 8, M: 4, N: 168, P: 2, Q: 7, ahb: 1, apb1: 4, apb2: 2 }
    }
  },
  {
    id: 'stm32f429zit6', name: 'STM32F429ZIT6', ref: 'STM32F429ZITx', family: 'f4', board: 'Nucleo-F429ZI',
    define: 'STM32F429xx', startup: 'startup_stm32f429xx.s', flashKB: 2048, ramKB: 192, maxClockMHz: 180,
    datasheet: ds('stm32f429zi'), referenceManual: rm('rm0090-stm32f405415-stm32f407417-stm32f427437-and-stm32f429439-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F429'),
    hse: 8, pinNotes: NUCLEO144,
    clock: {
      model: 'f4', hsiMHz: 16, hseMHz: 8, hseRange: [4, 26], overdriveAbove: 168,
      limits: { sysclk: 180, hclk: 180, apb1: 45, apb2: 90, vcoIn: [0.95, 2.1], vcoOut: [100, 432], pll48: 48 },
      pllM: [2, 63], pllN: [50, 432], pllP: [2, 4, 6, 8], pllQ: [2, 15], ahb: AHB, apb: APB,
      flashLatency: [[30, 0], [60, 1], [90, 2], [120, 3], [150, 4], [180, 5]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 8, N: 168, P: 2, Q: 7, ahb: 1, apb1: 4, apb2: 2 }
    }
  },
  {
    id: 'stm32f446ret6', name: 'STM32F446RET6', ref: 'STM32F446R(C-E)Tx', family: 'f4', board: 'Nucleo-F446RE',
    define: 'STM32F446xx', startup: 'startup_stm32f446xx.s', flashKB: 512, ramKB: 128, maxClockMHz: 180,
    datasheet: ds('stm32f446re'), referenceManual: rm('rm0390-stm32f446xx-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F446'),
    hse: 8, pinNotes: NUCLEO64,
    clock: {
      model: 'f4', hsiMHz: 16, hseMHz: 8, hseRange: [4, 26], overdriveAbove: 168,
      limits: { sysclk: 180, hclk: 180, apb1: 45, apb2: 90, vcoIn: [0.95, 2.1], vcoOut: [100, 432], pll48: 48 },
      pllM: [2, 63], pllN: [50, 432], pllP: [2, 4, 6, 8], pllQ: [2, 15], ahb: AHB, apb: APB,
      flashLatency: [[30, 0], [60, 1], [90, 2], [120, 3], [150, 4], [180, 5]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 8, N: 168, P: 2, Q: 7, ahb: 1, apb1: 4, apb2: 2 }
    }
  },
  {
    id: 'stm32f767zit6', name: 'STM32F767ZIT6', ref: 'STM32F767ZITx', family: 'f7', board: 'Nucleo-F767ZI',
    define: 'STM32F767xx', startup: 'startup_stm32f767xx.s', flashKB: 2048, ramKB: 512, maxClockMHz: 216,
    datasheet: ds('stm32f767zi'), referenceManual: rm('rm0410-stm32f76xxx-and-stm32f77xxx-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32F7x7'),
    hse: 8, pinNotes: NUCLEO144,
    clock: {
      model: 'f4', hsiMHz: 16, hseMHz: 8, hseRange: [4, 26], overdriveAbove: 180,
      limits: { sysclk: 216, hclk: 216, apb1: 54, apb2: 108, vcoIn: [0.95, 2.1], vcoOut: [100, 432], pll48: 48 },
      pllM: [2, 63], pllN: [50, 432], pllP: [2, 4, 6, 8], pllQ: [2, 15], ahb: AHB, apb: APB,
      flashLatency: [[30, 0], [60, 1], [90, 2], [120, 3], [150, 4], [180, 5], [210, 6], [216, 7]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 8, N: 180, P: 2, Q: 8, ahb: 1, apb1: 4, apb2: 2 }
    }
  },
  {
    id: 'stm32h743zit6', name: 'STM32H743ZIT6', ref: 'STM32H743ZITx', family: 'h7', board: 'Nucleo-H743ZI2',
    define: 'STM32H743xx', startup: 'startup_stm32h743xx.s', flashKB: 2048, ramKB: 128, maxClockMHz: 480,
    datasheet: ds('stm32h743zi'), referenceManual: rm('rm0433-stm32h742-stm32h743753-and-stm32h750-value-line-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32H743x'),
    hse: 8, pinNotes: { ...NUCLEO144, PB7: 'LD2 kart LED\'i (sarı: PE1)', PE1: 'LD2 sarı LED' },
    clock: {
      model: 'h7', hsiMHz: 64, hseMHz: 8, hseRange: [4, 48],
      limits: { sysclk: 400, hclk: 200, apb1: 100, apb2: 100, vcoIn: [2, 16], vcoOut: [192, 836], pllq: 200 },
      pllM: [1, 63], pllN: [4, 512], pllP: range(2, 128, 2), pllQ: range(1, 128), ahb: AHB, apb: APB,
      flashLatency: [[70, 0], [140, 1], [185, 2], [210, 3], [225, 3], [240, 4]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 4, N: 50, P: 2, Q: 4, ahb: 2, apb1: 2, apb2: 2 }
    }
  },
  {
    id: 'stm32h723zgt6', name: 'STM32H723ZGT6', ref: 'STM32H723ZGTx', family: 'h7', board: 'Nucleo-H723ZG',
    define: 'STM32H723xx', startup: 'startup_stm32h723xx.s', flashKB: 1024, ramKB: 128, maxClockMHz: 550,
    datasheet: ds('stm32h723zg'), referenceManual: rm('rm0468-stm32h723733-stm32h725735-and-stm32h730-value-line-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: 'https://raw.githubusercontent.com/modm-io/cmsis-svd-stm32/main/stm32h7/STM32H723.svd',
    hse: 8, pinNotes: { ...NUCLEO144, PE1: 'LD2 sarı LED' },
    clock: {
      model: 'h7', hsiMHz: 64, hseMHz: 8, hseRange: [4, 50],
      limits: { sysclk: 400, hclk: 200, apb1: 100, apb2: 100, vcoIn: [2, 16], vcoOut: [192, 836], pllq: 200 },
      pllM: [1, 63], pllN: [4, 512], pllP: range(2, 128, 2), pllQ: range(1, 128), ahb: AHB, apb: APB,
      flashLatency: [[70, 0], [140, 1], [210, 2], [275, 3]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 4, N: 50, P: 2, Q: 4, ahb: 2, apb1: 2, apb2: 2 }
    }
  },
  {
    id: 'stm32g071rbt6', name: 'STM32G071RBT6', ref: 'STM32G071R(6-8-B)Tx', family: 'g0', board: 'Nucleo-G071RB',
    define: 'STM32G071xx', startup: 'startup_stm32g071xx.s', flashKB: 128, ramKB: 36, maxClockMHz: 64,
    datasheet: ds('stm32g071rb'), referenceManual: rm('rm0444-stm32g0x1-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32G071'),
    hse: 8, pinNotes: { PA2: 'ST-LINK VCP TX (USART2)', PA3: 'ST-LINK VCP RX (USART2)', PA5: 'LD4 kart LED\'i', PC13: 'B1 kullanıcı butonu' },
    clock: {
      model: 'mnr', hsiMHz: 16, hseMHz: 8, hseRange: [4, 48],
      limits: { sysclk: 64, hclk: 64, apb1: 64, vcoIn: [2.66, 16], vcoOut: [64, 344] },
      pllM: [1, 8], pllN: [8, 86], pllR: range(2, 8), ahb: AHB, apb: APB,
      flashLatency: [[24, 0], [48, 1], [64, 2]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 8, R: 2, ahb: 1, apb1: 1 }
    }
  },
  {
    id: 'stm32g474ret6', name: 'STM32G474RET6', ref: 'STM32G474R(B-C-E)Tx', family: 'g4', board: 'Nucleo-G474RE',
    define: 'STM32G474xx', startup: 'startup_stm32g474xx.s', flashKB: 512, ramKB: 128, maxClockMHz: 170,
    datasheet: ds('stm32g474re'), referenceManual: rm('rm0440-stm32g4-series-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32G474xx'),
    hse: 24, pinNotes: NUCLEO64,
    clock: {
      model: 'mnr', hsiMHz: 16, hseMHz: 24, hseRange: [4, 48], boostAbove: 150,
      limits: { sysclk: 170, hclk: 170, apb1: 170, apb2: 170, vcoIn: [2.66, 16], vcoOut: [96, 344] },
      pllM: [1, 16], pllN: [8, 127], pllR: [2, 4, 6, 8], ahb: AHB, apb: APB,
      flashLatency: [[34, 0], [68, 1], [102, 2], [136, 3], [170, 4]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 24, M: 4, N: 85, R: 2, ahb: 1, apb1: 1, apb2: 1 }
    }
  },
  {
    id: 'stm32l432kcu6', name: 'STM32L432KCU6', ref: 'STM32L432K(B-C)Ux', family: 'l4', board: 'Nucleo-L432KC',
    define: 'STM32L432xx', startup: 'startup_stm32l432xx.s', flashKB: 256, ramKB: 64, maxClockMHz: 80,
    datasheet: ds('stm32l432kc'), referenceManual: rm('rm0394-stm32l41xxx42xxx43xxx44xxx45xxx46xxx-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32L4x2'),
    hse: 0, pinNotes: { PA2: 'ST-LINK VCP TX (USART2)', PA15: 'ST-LINK VCP RX (USART2)', PB3: 'LD3 kart LED\'i' },
    clock: {
      model: 'mnr', hsiMHz: 16, hseMHz: 8, hseRange: [4, 48],
      limits: { sysclk: 80, hclk: 80, apb1: 80, apb2: 80, vcoIn: [4, 16], vcoOut: [64, 344] },
      pllM: [1, 8], pllN: [8, 86], pllR: [2, 4, 6, 8], ahb: AHB, apb: APB,
      flashLatency: [[16, 0], [32, 1], [48, 2], [64, 3], [80, 4]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 10, R: 2, ahb: 1, apb1: 1, apb2: 1 }
    }
  },
  {
    id: 'stm32l476rgt6', name: 'STM32L476RGT6', ref: 'STM32L476R(C-E-G)Tx', family: 'l4', board: 'Nucleo-L476RG',
    define: 'STM32L476xx', startup: 'startup_stm32l476xx.s', flashKB: 1024, ramKB: 96, maxClockMHz: 80,
    datasheet: ds('stm32l476rg'), referenceManual: rm('rm0351-stm32l47xxx-stm32l48xxx-stm32l49xxx-and-stm32l4axxx-advanced-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32L4x6'),
    hse: 8, pinNotes: NUCLEO64,
    clock: {
      model: 'mnr', hsiMHz: 16, hseMHz: 8, hseRange: [4, 48],
      limits: { sysclk: 80, hclk: 80, apb1: 80, apb2: 80, vcoIn: [4, 16], vcoOut: [64, 344] },
      pllM: [1, 8], pllN: [8, 86], pllR: [2, 4, 6, 8], ahb: AHB, apb: APB,
      flashLatency: [[16, 0], [32, 1], [48, 2], [64, 3], [80, 4]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 8, M: 1, N: 10, R: 2, ahb: 1, apb1: 1, apb2: 1 }
    }
  },
  {
    id: 'stm32u575zit6q', name: 'STM32U575ZIT6Q', ref: 'STM32U575ZITxQ', family: 'u5', board: 'Nucleo-U575ZI-Q',
    define: 'STM32U575xx', startup: 'startup_stm32u575xx.s', flashKB: 2048, ramKB: 768, maxClockMHz: 160,
    datasheet: ds('stm32u575zi'), referenceManual: rm('rm0456-stm32u5-series-armbased-32bit-mcus-stmicroelectronics'), svdUrl: svd('STM32U575'),
    hse: 16, pinNotes: { PA9: 'ST-LINK VCP TX (USART1)', PA10: 'ST-LINK VCP RX (USART1)', PC7: 'LD1 kart LED\'i', PB7: 'LD2 kart LED\'i', PG2: 'LD3 kart LED\'i', PC13: 'B1 kullanıcı butonu', PA11: 'USB D-', PA12: 'USB D+' },
    clock: {
      model: 'mnr', hsiMHz: 16, hseMHz: 16, hseRange: [4, 50], epodAbove: 55,
      limits: { sysclk: 160, hclk: 160, apb1: 160, apb2: 160, vcoIn: [4, 16], vcoOut: [128, 544] },
      pllM: [1, 16], pllN: [4, 512], pllR: range(2, 16), ahb: AHB, apb: APB,
      flashLatency: [[32, 0], [64, 1], [96, 2], [128, 3], [160, 4]],
      default: { pllSource: 'HSI', sysclkSource: 'PLL', hseMHz: 16, M: 1, N: 20, R: 2, ahb: 1, apb1: 1, apb2: 1 }
    }
  }
];
