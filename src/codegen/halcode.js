// @ts-check
/**
 * STM32 HAL kod üretiminin aileye göre değişen kısımları (bkz. families.js):
 *  systemClock : SystemClock_Config (RCC_OscInitTypeDef / RCC_ClkInitTypeDef alanları aileye göre)
 *  i2cInit     : v1 (ClockSpeed/DutyCycle) ya da v2 (Timing)
 *  adcInit / adcChannel : ADC başlatma ve tek kanal okuma için kanal yapılandırması
 * x: bsp.makeContext() bağlamı.
 */
const { i2cTiming } = require('./regcode');

function systemClock(x) {
  const c = x.clock.config;
  const f = x.clock.freq;
  const fam = x.fam.key;
  const lat = x.clock.latency;
  const useHse = c.pllSource === 'HSE' || c.sysclkSource === 'HSE';
  const pll = c.sysclkSource === 'PLL';
  const lines = [];
  const L = (s) => lines.push(s);

  // ---- güç / regülatör
  if (fam === 'f4' || fam === 'f7') {
    L('__HAL_RCC_PWR_CLK_ENABLE();');
    L('__HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);');
  } else if (fam === 'g0' || fam === 'l4') {
    L('__HAL_RCC_PWR_CLK_ENABLE();');
    L('HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1);');
  } else if (fam === 'g4') {
    L('__HAL_RCC_PWR_CLK_ENABLE();');
    L(`HAL_PWREx_ControlVoltageScaling(${x.clock.boost ? 'PWR_REGULATOR_VOLTAGE_SCALE1_BOOST' : 'PWR_REGULATOR_VOLTAGE_SCALE1'});`);
  } else if (fam === 'u5') {
    L('__HAL_RCC_PWR_CLK_ENABLE();');
    L('HAL_PWREx_ControlVoltageScaling(PWR_REGULATOR_VOLTAGE_SCALE1);');
    L('HAL_PWREx_EnableVddA();   /* ADC */');
    L('HAL_PWREx_EnableVddIO2(); /* port G */');
  } else if (fam === 'h7') {
    L('HAL_PWREx_ConfigSupply(PWR_LDO_SUPPLY); /* LDO beslemesi (Nucleo varsayılanı) */');
    L('__HAL_PWR_VOLTAGESCALING_CONFIG(PWR_REGULATOR_VOLTAGE_SCALE1);');
    L('while (!__HAL_PWR_GET_FLAG(PWR_FLAG_VOSRDY)) {');
    L('}');
  }
  L('');

  // ---- osilatör + PLL
  L(`osc.OscillatorType = ${useHse ? 'RCC_OSCILLATORTYPE_HSE' : 'RCC_OSCILLATORTYPE_HSI'};`);
  if (useHse) L('osc.HSEState = RCC_HSE_ON;');
  else {
    L(`osc.HSIState = ${fam === 'h7' ? 'RCC_HSI_DIV1' : 'RCC_HSI_ON'};`);
    L('osc.HSICalibrationValue = RCC_HSICALIBRATION_DEFAULT;');
  }
  if (!pll) L('osc.PLL.PLLState = RCC_PLL_NONE;');
  else {
    L('osc.PLL.PLLState = RCC_PLL_ON;');
    if (fam === 'f4' || fam === 'f7') {
      L(`osc.PLL.PLLSource = RCC_PLLSOURCE_${c.pllSource};`);
      L(`osc.PLL.PLLM = ${c.M};`);
      L(`osc.PLL.PLLN = ${c.N};`);
      L(`osc.PLL.PLLP = RCC_PLLP_DIV${c.P};`);
      L(`osc.PLL.PLLQ = ${c.Q};`);
      L('#if defined(RCC_PLLCFGR_PLLR)');
      L('osc.PLL.PLLR = 2;');
      L('#endif');
    } else if (fam === 'f0' || fam === 'f1' || fam === 'f3') {
      if (c.pllSource === 'HSE') {
        L('osc.PLL.PLLSource = RCC_PLLSOURCE_HSE;');
        if (fam === 'f1') L(`osc.HSEPredivValue = RCC_HSE_PREDIV_DIV${c.M};`);
        else L(`osc.PLL.PREDIV = RCC_PREDIV_DIV${c.M};`);
      } else if (fam === 'f1') L('osc.PLL.PLLSource = RCC_PLLSOURCE_HSI_DIV2;');
      else {
        L('osc.PLL.PLLSource = RCC_PLLSOURCE_HSI;');
        L('#if defined(RCC_CFGR_PLLSRC_HSI_PREDIV)');
        L(`osc.PLL.PREDIV = RCC_PREDIV_DIV${x.mcu.clock.hsiPrediv ? c.M : 2}; /* HSI/${x.mcu.clock.hsiPrediv ? c.M : 2} */`);
        L('#endif');
      }
      L(`osc.PLL.PLLMUL = RCC_PLL_MUL${c.N};`);
    } else if (fam === 'g0' || fam === 'g4' || fam === 'l4') {
      L(`osc.PLL.PLLSource = RCC_PLLSOURCE_${c.pllSource};`);
      L(`osc.PLL.PLLM = ${fam === 'l4' ? c.M : `RCC_PLLM_DIV${c.M}`};`);
      L(`osc.PLL.PLLN = ${c.N};`);
      L(`osc.PLL.PLLP = ${fam === 'l4' ? 'RCC_PLLP_DIV7' : 'RCC_PLLP_DIV2'};`);
      L('osc.PLL.PLLQ = RCC_PLLQ_DIV2;');
      L(`osc.PLL.PLLR = RCC_PLLR_DIV${c.R};`);
    } else if (fam === 'u5') {
      L(`osc.PLL.PLLSource = RCC_PLLSOURCE_${c.pllSource};`);
      L('osc.PLL.PLLMBOOST = RCC_PLLMBOOST_DIV1;');
      L(`osc.PLL.PLLM = ${c.M};`);
      L(`osc.PLL.PLLN = ${c.N};`);
      L('osc.PLL.PLLP = 2;');
      L('osc.PLL.PLLQ = 2;');
      L(`osc.PLL.PLLR = ${c.R};`);
      L(`osc.PLL.PLLRGE = ${f.pllIn > 8 ? 'RCC_PLLVCIRANGE_1' : 'RCC_PLLVCIRANGE_0'};`);
      L('osc.PLL.PLLFRACN = 0;');
    } else if (fam === 'h7') {
      L(`osc.PLL.PLLSource = RCC_PLLSOURCE_${c.pllSource};`);
      L(`osc.PLL.PLLM = ${c.M};`);
      L(`osc.PLL.PLLN = ${c.N};`);
      L(`osc.PLL.PLLP = ${c.P};`);
      L(`osc.PLL.PLLQ = ${c.Q}; /* SPI1-3 çekirdek saati ${f.pllq} MHz */`);
      L('osc.PLL.PLLR = 2;');
      L(`osc.PLL.PLLRGE = RCC_PLL1VCIRANGE_${f.pllIn < 2 ? 0 : f.pllIn < 4 ? 1 : f.pllIn < 8 ? 2 : 3};`);
      L('osc.PLL.PLLVCOSEL = RCC_PLL1VCOWIDE;');
      L('osc.PLL.PLLFRACN = 0;');
    }
  }
  L('if (HAL_RCC_OscConfig(&osc) != HAL_OK) Error_Handler();');
  if (x.clock.overdrive) L('if (HAL_PWREx_EnableOverDrive() != HAL_OK) Error_Handler(); /* SYSCLK > ' + (fam === 'f7' ? 180 : 168) + ' MHz */');
  L('');

  // ---- veri yolu bölücüleri
  const sws = pll ? 'RCC_SYSCLKSOURCE_PLLCLK' : `RCC_SYSCLKSOURCE_${c.sysclkSource}`;
  if (fam === 'h7') {
    L('clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1 | RCC_CLOCKTYPE_PCLK2 | RCC_CLOCKTYPE_D3PCLK1 | RCC_CLOCKTYPE_D1PCLK1;');
    L(`clk.SYSCLKSource = ${sws};`);
    L('clk.SYSCLKDivider = RCC_SYSCLK_DIV1;');
    L(`clk.AHBCLKDivider = RCC_HCLK_DIV${c.ahb};`);
    L(`clk.APB3CLKDivider = RCC_APB3_DIV${c.apb1};`);
    L(`clk.APB1CLKDivider = RCC_APB1_DIV${c.apb1};`);
    L(`clk.APB2CLKDivider = RCC_APB2_DIV${c.apb2};`);
    L(`clk.APB4CLKDivider = RCC_APB4_DIV${c.apb1};`);
  } else {
    const single = x.fam.apbCount === 1;
    L(`clk.ClockType = RCC_CLOCKTYPE_HCLK | RCC_CLOCKTYPE_SYSCLK | RCC_CLOCKTYPE_PCLK1${single ? '' : ' | RCC_CLOCKTYPE_PCLK2'}${fam === 'u5' ? ' | RCC_CLOCKTYPE_PCLK3' : ''};`);
    L(`clk.SYSCLKSource = ${sws};`);
    L(`clk.AHBCLKDivider = RCC_SYSCLK_DIV${c.ahb};`);
    L(`clk.APB1CLKDivider = RCC_HCLK_DIV${c.apb1};`);
    if (!single) L(`clk.APB2CLKDivider = RCC_HCLK_DIV${c.apb2};`);
    if (fam === 'u5') L(`clk.APB3CLKDivider = RCC_HCLK_DIV${c.apb1};`);
  }
  L(`if (HAL_RCC_ClockConfig(&clk, FLASH_LATENCY_${lat}) != HAL_OK) Error_Handler();`);
  if (fam === 'h7' && x.buses.adc.length) {
    L('');
    L('periph.PeriphClockSelection = RCC_PERIPHCLK_ADC;');
    L('periph.AdcClockSelection = RCC_ADCCLKSOURCE_CLKP; /* per_ck = HSI 64 MHz */');
    L('if (HAL_RCCEx_PeriphCLKConfig(&periph) != HAL_OK) Error_Handler();');
  }
  if (fam === 'f1' && x.buses.adc.length) {
    L('');
    L('periph.PeriphClockSelection = RCC_PERIPHCLK_ADC;');
    L(`periph.AdcClockSelection = RCC_ADCPCLK2_DIV${x.adcDiv}; /* ${(f.pclk2 / x.adcDiv).toFixed(2)} MHz (≤14) */`);
    L('if (HAL_RCCEx_PeriphCLKConfig(&periph) != HAL_OK) Error_Handler();');
  }
  const needsPeriph = (fam === 'h7' || fam === 'f1') && x.buses.adc.length;
  const summary = `SYSCLK ${f.sysclk} MHz, HCLK ${f.hclk} MHz, APB1 ${f.pclk1} MHz${x.fam.apbCount > 1 ? `, APB2 ${f.pclk2} MHz` : ''}, Flash ${lat} WS`;
  return `/* ${summary} */
static void SystemClock_Config(void)
{
  RCC_OscInitTypeDef osc = {0};
  RCC_ClkInitTypeDef clk = {0};
${needsPeriph ? '  RCC_PeriphCLKInitTypeDef periph = {0};\n' : ''}
${lines.map((l) => (l.startsWith('#') || !l ? l : '  ' + l)).join('\n')}
}`;
}

function i2cInit(x, name, p, h) {
  if (x.fam.ip.i2c === 'v1') {
    return `${h}.Init.ClockSpeed = ${p.speedHz};
${h}.Init.DutyCycle = I2C_DUTYCYCLE_2;
${h}.Init.OwnAddress1 = 0;
${h}.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
${h}.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
${h}.Init.OwnAddress2 = 0;
${h}.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
${h}.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;`;
  }
  return `${h}.Init.Timing = ${i2cTiming(x.pclkOf(name), p.speedHz)}U; /* ${p.speedHz / 1000} kHz, I2C saati ${x.pclkOf(name)} MHz */
${h}.Init.OwnAddress1 = 0;
${h}.Init.AddressingMode = I2C_ADDRESSINGMODE_7BIT;
${h}.Init.DualAddressMode = I2C_DUALADDRESS_DISABLE;
${h}.Init.OwnAddress2 = 0;
${h}.Init.OwnAddress2Masks = I2C_OA2_NOMASK;
${h}.Init.GeneralCallMode = I2C_GENERALCALL_DISABLE;
${h}.Init.NoStretchMode = I2C_NOSTRETCH_DISABLE;`;
}

const ADC_SAMPLE = {
  f0: 'ADC_SAMPLETIME_55CYCLES_5', f1: 'ADC_SAMPLETIME_71CYCLES_5', f3: 'ADC_SAMPLETIME_61CYCLES_5', f4: 'ADC_SAMPLETIME_84CYCLES', f7: 'ADC_SAMPLETIME_84CYCLES',
  g0: 'ADC_SAMPLINGTIME_COMMON_1', g4: 'ADC_SAMPLETIME_92CYCLES_5', l4: 'ADC_SAMPLETIME_92CYCLES_5', h7: 'ADC_SAMPLETIME_64CYCLES_5', u5: 'ADC_SAMPLETIME_68CYCLES'
};

/** HAL ADC başlatma gövdesi (Instance ataması ve HAL_ADC_Init dahil). */
function adcInit(x, name, h) {
  const fam = x.fam.key;
  const f = x.clock.freq;
  const scan = fam === 'f0' ? 'ADC_SCAN_DIRECTION_FORWARD' : fam === 'f4' || fam === 'f7' ? 'DISABLE' : 'ADC_SCAN_DISABLE';
  const common = (extra) => `${h}.Init.ScanConvMode = ${scan};
${h}.Init.ContinuousConvMode = DISABLE;
${h}.Init.DiscontinuousConvMode = DISABLE;
${h}.Init.ExternalTrigConv = ADC_SOFTWARE_START;${fam === 'h7' || fam === 'u5' ? '' : `\n${h}.Init.DataAlign = ADC_DATAALIGN_RIGHT;`}${extra}
if (HAL_ADC_Init(&${h}) != HAL_OK) Error_Handler();`;
  const v3fields = `
${h}.Init.Resolution = ADC_RESOLUTION_12B;
${h}.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
${h}.Init.LowPowerAutoWait = DISABLE;
${h}.Init.NbrOfConversion = 1;
${h}.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
${h}.Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;`;
  switch (fam) {
    case 'f4':
    case 'f7':
      return `${h}.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV${x.adcDiv}; /* ${(f.pclk2 / x.adcDiv).toFixed(2)} MHz */
${h}.Init.Resolution = ADC_RESOLUTION_12B;
${h}.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
${h}.Init.NbrOfConversion = 1;
${h}.Init.DMAContinuousRequests = DISABLE;
${h}.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
${common('')}`;
    case 'f1':
      return `${h}.Init.NbrOfConversion = 1;
${common('')}
HAL_ADCEx_Calibration_Start(&${h});`;
    case 'f0':
      return `${h}.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV4;
${h}.Init.Resolution = ADC_RESOLUTION_12B;
${h}.Init.EOCSelection = ADC_EOC_SINGLE_CONV;
${h}.Init.LowPowerAutoWait = DISABLE;
${h}.Init.LowPowerAutoPowerOff = DISABLE;
${h}.Init.ExternalTrigConvEdge = ADC_EXTERNALTRIGCONVEDGE_NONE;
${h}.Init.DMAContinuousRequests = DISABLE;
${h}.Init.Overrun = ADC_OVR_DATA_OVERWRITTEN;
${common('')}
HAL_ADCEx_Calibration_Start(&${h});`;
    case 'g0':
      return `${h}.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV2;
${h}.Init.LowPowerAutoPowerOff = DISABLE;
${h}.Init.DMAContinuousRequests = DISABLE;
${h}.Init.SamplingTimeCommon1 = ADC_SAMPLETIME_39CYCLES_5;
${h}.Init.SamplingTimeCommon2 = ADC_SAMPLETIME_39CYCLES_5;
${h}.Init.OversamplingMode = DISABLE;
${h}.Init.TriggerFrequencyMode = ADC_TRIGGER_FREQ_HIGH;${v3fields}
${common('')}
HAL_ADCEx_Calibration_Start(&${h});`;
    case 'f3':
    case 'g4':
    case 'l4': {
      const div = fam === 'g4' ? 4 : f.hclk <= ({ f3: 72, l4: 80 })[fam] ? 1 : 2;
      return `${h}.Init.ClockPrescaler = ADC_CLOCK_SYNC_PCLK_DIV${div}; /* senkron HCLK/${div} */
${h}.Init.DMAContinuousRequests = DISABLE;${fam !== 'f3' ? `\n${h}.Init.OversamplingMode = DISABLE;` : ''}${v3fields}
${common('')}
HAL_ADCEx_Calibration_Start(&${h}, ADC_SINGLE_ENDED);`;
    }
    case 'h7':
    case 'u5':
      return `${h}.Init.ClockPrescaler = ADC_CLOCK_ASYNC_DIV4;
${h}.Init.ConversionDataManagement = ADC_CONVERSIONDATA_DR;
${h}.Init.LeftBitShift = ADC_LEFTBITSHIFT_NONE;
${h}.Init.OversamplingMode = DISABLE;${v3fields}
${common('')}
HAL_ADCEx_Calibration_Start(&${h}, ADC_CALIB_OFFSET, ADC_SINGLE_ENDED);`;
    default:
      throw new Error(`halcode.adcInit: ${fam}`);
  }
}

/** bsp_adc_read içinde, kanal numarasını HAL kanal makrosuna çeviren switch + yapılandırma. */
function adcRead(x, h, channels) {
  const fam = x.fam.key;
  const rank = { f0: 'ADC_RANK_CHANNEL_NUMBER', f1: 'ADC_REGULAR_RANK_1', f4: '1', f7: '1' }[fam] || 'ADC_REGULAR_RANK_1';
  const diff = ['f3', 'g4', 'l4', 'h7', 'u5'].includes(fam) ? '\n  c.SingleDiff = ADC_SINGLE_ENDED;\n  c.OffsetNumber = ADC_OFFSET_NONE;' : '';
  const cases = channels.map((n) => `  case ${n}: c.Channel = ADC_CHANNEL_${n}; break;`).join('\n');
  return `  /* RTOS'ta birden çok task ADC okuyorsa bu fonksiyonu bir mutex ile koruyun. */
  extern ADC_HandleTypeDef ${h};
  ADC_ChannelConfTypeDef c = {0};
  uint16_t v = 0;
  switch (channel) {
${cases}
  default: return 0;
  }
  c.Rank = ${rank};
  c.SamplingTime = ${ADC_SAMPLE[fam]};${diff}
  if (HAL_ADC_ConfigChannel(&${h}, &c) != HAL_OK) return 0;
  HAL_ADC_Start(&${h});
  if (HAL_ADC_PollForConversion(&${h}, 10) == HAL_OK) v = (uint16_t)HAL_ADC_GetValue(&${h});
  HAL_ADC_Stop(&${h});${fam === 'f0' ? `
  c.Rank = ADC_RANK_NONE; /* F0: kanal seçimi birikir; sonraki okuma için kaldır */
  HAL_ADC_ConfigChannel(&${h}, &c);` : ''}
  return v;`;
}

module.exports = { systemClock, i2cInit, adcInit, adcRead };
