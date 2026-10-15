// @ts-check
/**
 * Proje klasör yapısı. Tüm üretilen/kopyalanan dosya yolları buradan gelir.
 *
 *  HAL (STM32CubeMX / CubeIDE ile aynı)      Bare-metal (sade)
 *  Core/Inc, Core/Src                         inc/, src/
 *  Drivers/Components                         drivers/            (seçilen komponent sürücüleri)
 *  Drivers/CMSIS/Include                      cmsis/core/         (core_cm4.h …)
 *  Drivers/CMSIS/Device/ST/<aile>/Include     cmsis/device/       (stm32f4xx.h, stm32f411xe.h …)
 *  …/Source/Templates/gcc/startup_*.s         startup/            (startup_*.s, system_*.c)
 *  <MCU>_FLASH.ld                             linker/<MCU>_FLASH.ld
 *  Drivers/<aile>_HAL_Driver                  —
 *  Middlewares/FreeRTOS                       rtos/FreeRTOS
 */

/** @param {'hal'|'register'} framework */
function layout(framework) {
  const family = 'STM32F4xx'; // ES-106 ile MCU tanımından gelecek
  const system = 'system_stm32f4xx.c';
  if (framework === 'hal') {
    const dev = `Drivers/CMSIS/Device/ST/${family}`;
    return {
      name: 'hal', inc: 'Core/Inc', src: 'Core/Src', drivers: 'Drivers/Components',
      cmsisCore: 'Drivers/CMSIS/Include', deviceInc: `${dev}/Include`,
      systemC: `${dev}/Source/Templates/${system}`, startupDir: `${dev}/Source/Templates/gcc`, linkerDir: '',
      hal: `Drivers/${family}_HAL_Driver`, rtos: 'Middlewares/FreeRTOS'
    };
  }
  return {
    name: 'register', inc: 'inc', src: 'src', drivers: 'drivers',
    cmsisCore: 'cmsis/core', deviceInc: 'cmsis/device',
    systemC: `startup/${system}`, startupDir: 'startup', linkerDir: 'linker',
    hal: '', rtos: 'rtos/FreeRTOS'
  };
}

/** Boş parçaları atlayarak / ile birleştirir. */
const join = (...parts) => parts.filter(Boolean).join('/');

module.exports = { layout, join };
