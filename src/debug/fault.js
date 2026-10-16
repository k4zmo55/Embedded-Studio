// @ts-check
/**
 * HardFault analizörü (ES-207): SCB fault register'larını (CFSR, HFSR, MMFAR, BFAR, SHCSR) anlamlı cümlelere çevirir,
 * EXC_RETURN'e göre yığın çerçevesini (MSP/PSP) bulur, PC/LR'yi kaynak satıra çözer, olası nedenleri listeler.
 */
const fs = require('fs');
const { execFile } = require('child_process');
const { t } = require('../i18n');

const SCB = { SHCSR: 0xe000ed24, CFSR: 0xe000ed28, HFSR: 0xe000ed2c, DFSR: 0xe000ed30, MMFAR: 0xe000ed34, BFAR: 0xe000ed38, AFSR: 0xe000ed3c };
const EXC_NAMES = { 2: 'NMI', 3: 'HardFault', 4: 'MemManage', 5: 'BusFault', 6: 'UsageFault', 7: 'SecureFault' };

/**
 * CFSR / HFSR bitleri: [register, bit, ad, açıklama, olası nedenler]
 * Metinler t() ile çalışma anında çevrilir.
 */
const BITS = () => [
  ['CFSR', 0, 'IACCVIOL', t('Çalıştırılması yasak bir bölgeden komut alındı (MPU / XN ihlali).'), [t('Bozuk fonksiyon işaretçisi ya da dönüş adresi RAM / çevre birimi bölgesini gösteriyor.'), t('MPU bölgelerini kontrol edin.')]],
  ['CFSR', 1, 'DACCVIOL', t('MPU\'nun izin vermediği bir adrese veri erişimi.'), [t('MPU bölge ayarlarını ve erişilen adresi (MMFAR) kontrol edin.'), t('NULL ya da bozuk işaretçi.')]],
  ['CFSR', 3, 'MUNSTKERR', t('İstisnadan dönerken yığın geri alınamadı (MPU ihlali).'), [t('Kesme işleyicisinde yığın bozulmuş olabilir.')]],
  ['CFSR', 4, 'MSTKERR', t('İstisnaya girerken yığına yazılamadı (MPU ihlali; yığın taşması?).'), [t('Yığın taşması: yığın boyutunu büyütün.')]],
  ['CFSR', 5, 'MLSPERR', t('FPU durumunun tembel saklanması sırasında MPU ihlali.'), []],
  ['CFSR', 8, 'IBUSERR', t('Komut alınırken bus hatası: geçersiz bir adrese dallanıldı.'), [t('Bozuk fonksiyon işaretçisi ya da silinmiş/boş flash bölgesine dallanma.'), t('Yığın bozulması nedeniyle dönüş adresi bozulmuş olabilir.')]],
  ['CFSR', 9, 'PRECISERR', t('Geçersiz adrese veri erişimi (kesin bus hatası; adres BFAR\'da, PC hatalı komutu gösterir).'), [t('Saati (RCC) açılmamış bir çevre biriminin register\'ına erişim.'), t('Dizi sınırı aşımı ya da bozuk işaretçi.')]],
  ['CFSR', 10, 'IMPRECISERR', t('Kesin olmayan bus hatası: tamponlu bir yazma başarısız oldu; PC hatalı satırdan birkaç komut sonrasını gösterebilir.'), [t('PC\'den önceki yazmalara bakın.'), t('Hata ayıklarken ACTLR.DISDEFWBUF (bit 1) açılırsa hata kesinleşir.'), t('Saati açılmamış çevre birimine yazma.')]],
  ['CFSR', 11, 'UNSTKERR', t('İstisnadan dönerken yığın geri alınamadı (bus hatası).'), [t('Yığın işaretçisi bozulmuş olabilir.')]],
  ['CFSR', 12, 'STKERR', t('İstisnaya girerken yığına yazılamadı (yığın taşması?).'), [t('Yığın taşması: yığın boyutunu büyütün.')]],
  ['CFSR', 13, 'LSPERR', t('FPU durumunun tembel saklanması sırasında bus hatası.'), []],
  ['CFSR', 16, 'UNDEFINSTR', t('Tanımsız komut çalıştırılmaya çalışıldı.'), [t('Bozuk fonksiyon işaretçisi ya da bozulmuş dönüş adresi (yığın taşması / tampon taşması).'), t('Kod başka bir çekirdek için derlenmiş olabilir (ör. FPU komutları).')]],
  ['CFSR', 17, 'INVSTATE', t('Geçersiz durum: Thumb biti 0 olan bir adrese dallanıldı.'), [t('Fonksiyon işaretçisi başlatılmamış ya da bozuk (adres tek sayı olmalı).'), t('Vektör tablosundaki işleyici adresi bozuk.')]],
  ['CFSR', 18, 'INVPC', t('Geçersiz EXC_RETURN değeriyle istisnadan dönülmeye çalışıldı.'), [t('Kesme işleyicisinde LR ya da yığın bozulmuş.')]],
  ['CFSR', 19, 'NOCP', t('Yardımcı işlemci (FPU) kapalıyken FPU komutu çalıştırıldı.'), [t('FPU açılmamış: SystemInit\'te SCB->CPACR |= (0xF << 20) olmalı.'), t('Derleme -mfloat-abi=hard ama başlangıç kodu FPU\'yu açmıyor.')]],
  ['CFSR', 20, 'STKOF', t('Yığın sınırı (MSPLIM / PSPLIM) aşıldı.'), [t('Yığın taşması: yığın boyutunu büyütün.')]],
  ['CFSR', 24, 'UNALIGNED', t('Hizasız bellek erişimi.'), [t('Paketlenmiş (packed) yapı ya da bayt dizisinden işaretçi dönüşümü.'), t('LDRD/STRD/LDM hizasız adresle kullanılamaz.')]],
  ['CFSR', 25, 'DIVBYZERO', t('Sıfıra bölme (SCB->CCR DIV_0_TRP açık).'), [t('Bölenin sıfır olmadığını kontrol edin.')]],
  ['HFSR', 1, 'VECTTBL', t('Vektör tablosu okunurken bus hatası.'), [t('VTOR yanlış ya da vektör tablosu bozuk.'), t('Bootloader\'dan sonra VTOR uygulama adresine ayarlanmamış.')]],
  ['HFSR', 30, 'FORCED', t('Yapılandırılabilir bir fault (MemManage / BusFault / UsageFault) HardFault\'a yükseltildi.'), [t('SHCSR\'de MemManage/BusFault/UsageFault işleyicileri açılırsa ayrı ayrı yakalanır.')]],
  ['HFSR', 31, 'DEBUGEVT', t('Debug olayı (ör. debugger yokken BKPT komutu).'), [t('Kodda kalmış __BKPT() ya da semihosting çağrısı (printf) olabilir.')]]
];

/** EXC_RETURN (LR'de 0xFFFFFFxx) */
const isExcReturn = (lr) => (lr >>> 0) >= 0xffffff00;
/** EXC_RETURN çözümü: hangi yığın, thread/handler modu, FPU çerçevesi */
function excReturn(lr) {
  const v = lr >>> 0;
  if (!isExcReturn(v)) return null;
  return { psp: !!(v & 4), thread: !!(v & 8), fpuFrame: !(v & 0x10) };
}

/** Kod adresi gibi mi (flash / sistem belleği / ITCM / harici flash) */
const looksLikeCode = (a) => {
  const v = a >>> 0;
  return ((v >= 0x100 && v < 0x20000000) || (v >= 0x60000000 && v < 0xa0000000)) && v !== 0xffffffff;
};

/** Yığından 8 word'lük temel istisna çerçevesi: r0–r3, r12, lr, pc, xPSR */
function parseFrame(words, sp, fpuFrame = false) {
  const [r0, r1, r2, r3, r12, lr, pc, xpsr] = words.map((x) => x >>> 0);
  // Fault öncesi SP: çerçeve (0x20 ya da FPU'lu 0x68) + hizalama dolgusu (xPSR bit 9)
  const preSp = (sp + (fpuFrame ? 0x68 : 0x20) + (xpsr & 0x200 ? 4 : 0)) >>> 0;
  return { r0, r1, r2, r3, r12, lr, pc, xpsr, sp: sp >>> 0, preSp };
}
/** Çerçeve makul mü: PC kod bölgesinde, çift; strict ise xPSR'de Thumb biti de */
const frameValid = (f, strict = true) => looksLikeCode(f.pc) && !(f.pc & 1) && (!strict || !!(f.xpsr & 0x01000000));

/**
 * Fault register'larını çözümler.
 * @param {{ CFSR?: number, HFSR?: number, MMFAR?: number, BFAR?: number, SHCSR?: number }} r
 * @param {{ v6m?: boolean }} cpu
 */
function decodeFault(r, cpu = {}) {
  const findings = [];
  const causes = [];
  const add = (list) => { for (const c of list) if (!causes.includes(c)) causes.push(c); };
  if (!cpu.v6m) {
    for (const [reg, bit, name, text, why] of BITS()) {
      if (((r[reg] ?? 0) >>> bit) & 1) { findings.push({ reg, bit, name, text }); add(why); }
    }
  }
  const cfsr = (r.CFSR ?? 0) >>> 0;
  const out = { findings, causes, address: null, kind: '', summary: '', enabled: null };
  // Hata adresi: geçerliyse
  if (!cpu.v6m && cfsr & (1 << 15)) out.address = { reg: 'BFAR', value: (r.BFAR ?? 0) >>> 0 };
  else if (!cpu.v6m && cfsr & (1 << 7)) out.address = { reg: 'MMFAR', value: (r.MMFAR ?? 0) >>> 0 };
  if (out.address) {
    const a = out.address.value;
    // Adrese dayalı neden en belirgin olanıdır: listenin başına
    if (a < 0x400) causes.unshift(t('Adres 0\'a çok yakın: NULL işaretçi (ya da NULL yapı işaretçisinin alanı) kullanılmış.'));
    else if (a >= 0x40000000 && a < 0x60000000) causes.unshift(t('Adres çevre birimi bölgesinde: o çevre biriminin saati (RCC ...ENR) açık mı, bu işlemcide var mı?'));
  }
  const kind = cfsr & 0xff ? 'MemManage' : cfsr & 0xff00 ? 'BusFault' : cfsr & 0xffff0000 ? 'UsageFault' : '';
  out.kind = kind;
  if (r.SHCSR !== undefined && !cpu.v6m) {
    const s = r.SHCSR >>> 0;
    out.enabled = { MemManage: !!(s & (1 << 16)), BusFault: !!(s & (1 << 17)), UsageFault: !!(s & (1 << 18)) };
  }
  const first = findings.find((f) => !['FORCED', 'DEBUGEVT'].includes(f.name)) || findings[0];
  if (cpu.v6m) {
    out.summary = t('Cortex-M0/M0+\'ta fault durum register\'ları yok; neden yığın çerçevesinden (PC) bulunmalı.');
    add([t('Hizasız erişim (M0\'da her hizasız erişim HardFault\'tur).'), t('NULL ya da bozuk işaretçi.'), t('Saati açılmamış çevre birimine erişim.'), t('Yığın taşması.')]);
  } else if (!findings.length) out.summary = t('Fault kaydı yok (CFSR ve HFSR sıfır): işlemci bir fault yaşamamış ya da kayıtlar temizlenmiş.');
  else {
    const forced = findings.some((f) => f.name === 'FORCED');
    out.summary = (kind ? (forced ? t('HardFault (yükseltilmiş {0})', kind) : kind) : 'HardFault') + ': ' + (first ? first.text : '');
  }
  return out;
}

/** Fault'un nerede olduğu: IPSR'den işleyici adı; EXC_RETURN'den yığın ve görev bilgisi */
function context(core, rtos) {
  const ipsr = (core.xPSR ?? 0) & 0x1ff;
  const er = excReturn(core.lr ?? 0);
  const where = er ? (er.psp ? (rtos ? t('Fault bir RTOS görevinde oluştu (PSP).') : t('Fault thread modunda, PSP yığınında oluştu.'))
    : er.thread ? t('Fault thread modunda, MSP yığınında oluştu (RTOS başlamadan önce ya da RTOS yok).') : t('Fault bir kesme işleyicisinin içinde oluştu (MSP).'))
    : t('LR bir EXC_RETURN değeri değil: işleyici LR\'yi değiştirmiş; yığın çerçevesi MSP\'de aranıyor.');
  return { ipsr, handler: EXC_NAMES[ipsr] || (ipsr ? (ipsr >= 16 ? `IRQ ${ipsr - 16}` : `#${ipsr}`) : 'Thread'), inFault: ipsr >= 3 && ipsr <= 7, excReturn: er, where };
}

/**
 * Hedefi analiz eder (hedef durdurulmuş olmalı).
 * @param {any} target readMemory / coreRegisters
 * @param {{ v6m?: boolean, fpu?: boolean }} cpu
 * @param {{ rtos?: boolean, tcb?: number }} [opts]  tcb: pxCurrentTCB değişkeninin adresi (FreeRTOS)
 */
async function analyze(target, cpu, opts = {}) {
  const core = await target.coreRegisters(cpu);
  const regs = {};
  if (!cpu.v6m) {
    const w = await target.readMemory(SCB.SHCSR, 6); // SHCSR, CFSR, HFSR, DFSR, MMFAR, BFAR
    Object.assign(regs, { SHCSR: w[0], CFSR: w[1], HFSR: w[2], MMFAR: w[4], BFAR: w[5] });
  }
  const decoded = decodeFault(regs, cpu);
  const ctx = context(core, opts.rtos);
  const er = ctx.excReturn;
  let frame = null, shift = 0;
  const sp = er && er.psp ? core.psp : core.msp ?? core.sp;
  if (sp !== undefined && sp >= 0x20000000) {
    // MSP'de işleyici kendi kaydını (push {r7, lr}) yapmış olabilir: çerçeveyi birkaç word ileride ara
    const tries = er && er.psp ? [0] : [0, 4, 8, 12, 16, 20, 24, 28, 32];
    const words = await target.readMemory(sp & ~3, 8 + 8).catch(() => null);
    if (words) {
      // Önce xPSR Thumb biti de tutan çerçeve; INVSTATE'te yığındaki Thumb biti 0'dır, ikinci turda aranır
      for (const strict of [true, false]) {
        for (const off of tries) {
          const f = parseFrame(words.slice(off / 4, off / 4 + 8), sp + off, er ? er.fpuFrame : false);
          if (frameValid(f, strict)) { frame = f; shift = off; break; }
        }
        if (frame) break;
      }
      if (!frame) frame = { ...parseFrame(words.slice(0, 8), sp, er ? er.fpuFrame : false), invalid: true };
    }
  }
  // FreeRTOS: çalışan görevin adı ve yığın başlangıcı (yığın taşması tespiti)
  let task = null;
  if (er && er.psp && opts.tcb) {
    try {
      const [tcb] = await target.readMemory(opts.tcb & ~3, 1);
      if (tcb >= 0x20000000) {
        const w = await target.readMemory(tcb, 17);
        // TCB_t (MPU yok): pxTopOfStack, xStateListItem (5 word), xEventListItem (5), uxPriority, pxStack, pcTaskName[16]
        const pxStack = w[12] >>> 0;
        const bytes = w.slice(13, 17).flatMap((v) => [0, 1, 2, 3].map((i) => (v >>> (8 * i)) & 0xff));
        const end = bytes.indexOf(0);
        const name = String.fromCharCode(...bytes.slice(0, end < 0 ? 16 : end));
        if (/^[\x20-\x7e]+$/.test(name)) task = { name, tcb, stack: pxStack, priority: w[11] >>> 0 };
      }
    } catch { /* görev bilgisi okunamadı */ }
  }
  if (task && frame && frame.sp - task.stack < 64) decoded.causes.unshift(t('Görevin yığını tükenmiş görünüyor (SP yığın başlangıcına {0} bayt uzaklıkta): bu görevin yığın boyutunu büyütün.', frame.sp - task.stack));
  if (decoded.findings.some((f) => /STKERR|MSTKERR|STKOF/.test(f.name)) && opts.rtos) decoded.causes.push(t('FreeRTOS\'ta configCHECK_FOR_STACK_OVERFLOW = 2 ile yığın taşmasını erkenden yakalayın.'));
  return { regs, decoded, context: ctx, frame, shift, task, core: { pc: core.pc, lr: core.lr, sp: core.sp, msp: core.msp, psp: core.psp, xPSR: core.xPSR } };
}

/**
 * Adresleri kaynak satıra çözer (arm-none-eabi-addr2line). Satır içi (inline) çağrılarda en dıştaki fonksiyon.
 * @returns {Promise<({ addr: number, func: string, file: string, line: number } | null)[]>}
 */
function addr2line(elf, addrs, tool = 'arm-none-eabi-addr2line') {
  return new Promise((resolve) => {
    if (!elf || !fs.existsSync(elf) || !addrs.length) return resolve(addrs.map(() => null));
    execFile(tool, ['-e', elf, '-f', '-C', ...addrs.map((a) => '0x' + (a >>> 0).toString(16))], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(addrs.map(() => null));
      const lines = stdout.split(/\r?\n/);
      resolve(addrs.map((addr, i) => {
        const func = lines[i * 2] || '??';
        const m = /^(.*):(\d+)(?: \(discriminator \d+\))?$/.exec(lines[i * 2 + 1] || '');
        return m && m[1] !== '??' && Number(m[2]) > 0 ? { addr, func, file: m[1], line: Number(m[2]) } : func !== '??' ? { addr, func, file: '', line: 0 } : null;
      }));
    });
  });
}

/** ELF'teki fonksiyonun adresi (nm; Thumb biti temizlenmiş) */
function funcAddr(elf, names, nm = 'arm-none-eabi-nm') {
  return new Promise((resolve) => {
    if (!elf || !fs.existsSync(elf)) return resolve({});
    execFile(nm, ['--defined-only', elf], { windowsHide: true, maxBuffer: 1 << 24 }, (err, stdout) => {
      const out = {};
      if (!err) for (const line of stdout.split(/\r?\n/)) {
        const m = /^([0-9a-f]{8}) [tT] (\S+)$/.exec(line.trim());
        if (m && names.includes(m[2])) out[m[2]] = parseInt(m[1], 16) & ~1;
      }
      resolve(out);
    });
  });
}

/** Simülasyon senaryoları: SCB register'ları ve yığın çerçevesi (PC/LR verilirse ELF'teki gerçek adresler) */
const SIM_FAULTS = () => ({ // etiketler webview'da
  nullwrite: { CFSR: (1 << 9) | (1 << 15), HFSR: 1 << 30, BFAR: 0x00000004, psp: true },
  divzero: { CFSR: 1 << 25, HFSR: 1 << 30, psp: true },
  unaligned: { CFSR: 1 << 24, HFSR: 1 << 30, psp: false },
  badfunc: { CFSR: 1 << 17, HFSR: 1 << 30, psp: true },
  clock: { CFSR: (1 << 9) | (1 << 15), HFSR: 1 << 30, BFAR: 0x40004400, psp: false },
  stack: { CFSR: 1 << 12, HFSR: 1 << 30, psp: true }
});

module.exports = { SCB, EXC_NAMES, decodeFault, excReturn, isExcReturn, parseFrame, frameValid, context, analyze, addr2line, funcAddr, SIM_FAULTS };
