// @ts-check
/**
 * FreeRTOS farkındalıklı debug (ES-209). Çekirdek yapıları hedef belleğinden okunur; GDB gerekmez.
 *
 *  - Yerleşim: FreeRTOSConfig.h'teki #define'lardan TCB / Queue_t / Timer_t ofsetleri (V10.x ve V11.x, tek çekirdek, MPU'suz).
 *  - RtosReader: görev listeleri (hazır, gecikmeli, askıda, silinen), durum, öncelik, yığın kullanımı ve tepe değeri,
 *    CPU yüzdesi (ulRunTimeCounter), kuyruk kaydındaki kuyruk/semafor/mutexler, etkin zamanlayıcılar, heap_4 durumu, uyarılar.
 *  - taskContext / backtrace: görevin kayıtlı bağlamından PC/LR/SP ve yığın taramasıyla olası çağrı zinciri.
 *  - simKernel: simülasyonda gerçek yerleşimle çekirdek yapıları kurar (okuyucu aynı kodla okur).
 */
const fs = require('fs');
const { t } = require('../i18n');
const { readRegion } = require('./memory');

const LIST = 20; // List_t: uxNumberOfItems, pxIndex, xListEnd (MiniListItem: değer, sonraki, önceki)
const FILL = 0xa5a5a5a5; // tskSTACK_FILL_BYTE
const align4 = (n) => (n + 3) & ~3;

/** FreeRTOSConfig.h → { AD: sayı } (tür dönüşümleri ve parantezler atılır; sayısal olmayanlar alınmaz) */
function parseConfig(text) {
  const out = {};
  const src = String(text || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const m of src.matchAll(/^[ \t]*#[ \t]*define[ \t]+(\w+)[ \t]+(.+?)[ \t]*$/gm)) {
    const v = m[2].replace(/\(\s*(?:unsigned\s+)?[A-Za-z_]\w*\s*\)/g, '').replace(/[()\s]/g, '').replace(/[uUlL]+$/, '');
    if (/^(0x[0-9a-f]+|\d+)$/i.test(v)) out[m[1]] = Number(v);
  }
  return out;
}

/** Embedded Studio'nun ürettiği FreeRTOSConfig.h ile aynı varsayılanlar (dosya bulunamazsa ve simülasyonda) */
const DEFAULT_CONFIG = {
  configMAX_TASK_NAME_LEN: 16, configUSE_TRACE_FACILITY: 1, configUSE_MUTEXES: 1, configGENERATE_RUN_TIME_STATS: 1,
  configRECORD_STACK_HIGH_ADDRESS: 1, configCHECK_FOR_STACK_OVERFLOW: 2, configQUEUE_REGISTRY_SIZE: 8, configSUPPORT_DYNAMIC_ALLOCATION: 1
};

const cfgOf = (cfg) => (k, d = 0) => (cfg && k in cfg ? cfg[k] : d);

/** TCB_t ofsetleri (tasks.c, tskTaskControlBlock) */
function tcbLayout(cfg) {
  const c = cfgOf(cfg);
  if (c('portUSING_MPU_WRAPPERS') || c('configENABLE_MPU')) throw new Error(t('MPU\'lu FreeRTOS portu desteklenmiyor.'));
  const L = { top: 0, state: 4, event: 24, prio: 44, stack: 48, name: 52, nameLen: c('configMAX_TASK_NAME_LEN', 16) };
  let off = 52 + align4(L.nameLen);
  if (c('configUSE_TASK_PREEMPTION_DISABLE')) off += 4;
  if (c('configRECORD_STACK_HIGH_ADDRESS')) { L.end = off; off += 4; }
  if (c('configUSE_TRACE_FACILITY')) { L.tcbNum = off; off += 8; }
  if (c('configUSE_MUTEXES')) { L.basePrio = off; L.mutexes = off + 4; off += 8; }
  if (c('configUSE_APPLICATION_TASK_TAG')) off += 4;
  off += 4 * c('configNUM_THREAD_LOCAL_STORAGE_POINTERS');
  if (c('configGENERATE_RUN_TIME_STATS')) { L.runTime = off; off += 4; }
  L.size = off;
  return L;
}

/** Queue_t ofsetleri (queue.c, QueueDefinition) */
function queueLayout(cfg) {
  const c = cfgOf(cfg);
  const Q = { head: 0, writeTo: 4, holder: 8, recursive: 12, waitSend: 16, waitRecv: 36, waiting: 56, length: 60, itemSize: 64 };
  let off = 70;
  if (c('configSUPPORT_STATIC_ALLOCATION') && c('configSUPPORT_DYNAMIC_ALLOCATION', 1)) off += 1;
  off = align4(off);
  if (c('configUSE_QUEUE_SETS')) off += 4;
  if (c('configUSE_TRACE_FACILITY')) { Q.type = off + 4; off += 8; }
  Q.size = align4(off);
  return Q;
}

/** Timer_t ofsetleri (timers.c, tmrTimerControl) */
function timerLayout(cfg) {
  const c = cfgOf(cfg);
  return { name: 0, item: 4, period: 24, id: 28, callback: 32, status: c('configUSE_TRACE_FACILITY') ? 40 : 36, size: 44 };
}

/** Kuyruk türü (ucQueueType) */
const QUEUE_TYPES = ['queue', 'mutex', 'counting', 'binary', 'recursive', 'set'];

/**
 * Görev bağlamı: pxTopOfStack'ten yukarı doğru port'un kaydettiği register'lar (V11, MPU'suz), ardından donanım çerçevesi.
 *  CM0 (V11): EXC_RETURN, r4–r11 · CM0 (V10) ve CM3: r4–r11 · CM4F/CM7: r4–r11, EXC_RETURN · CM33: PSPLIM, EXC_RETURN, r4–r11
 */
const R4_11 = ['r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11'];
const CONTEXTS = {
  cm0: [['exc', ...R4_11], R4_11],
  cm3: [R4_11],
  cm4f: [[...R4_11, 'exc']],
  cm33: [['psplim', 'exc', ...R4_11], [...R4_11, 'exc']]
};
const ctxKind = (core) => (/cortex-m0/.test(core) ? 'cm0' : /cortex-m3$/.test(core) ? 'cm3' : /cortex-m33/.test(core) ? 'cm33' : 'cm4f');
const FRAME = ['r0', 'r1', 'r2', 'r3', 'r12', 'lr', 'pc', 'xpsr'];
const isExcReturn = (v) => (v >>> 0) >= 0xffffff00;

/** Bellek okuma yardımcıları (word dizisi, bayt dizisi) */
const le32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
async function cstr(target, addr, max = 32) {
  if (!addr) return '';
  try {
    const b = Buffer.from(await readRegion(target, addr, max));
    const z = b.indexOf(0);
    return b.subarray(0, z < 0 ? max : z).toString('latin1').replace(/[^\x20-\x7e]/g, '?');
  } catch {
    return '';
  }
}

/**
 * Bir bağlantılı listenin sahipleri (pvOwner). Bozuk listede döngüye girmemek için en fazla 64 öğe.
 * @returns {Promise<{ item: number, owner: number, value: number }[]>}
 */
async function listOwners(target, list) {
  const [n, , , next0] = await target.readMemory(list, 4);
  const end = list + 8, out = [];
  let it = next0;
  for (let k = 0; k < Math.min(n, 64) && it && it !== end; k++) {
    const [value, next, , owner] = await target.readMemory(it, 4);
    out.push({ item: it, owner, value });
    it = next;
  }
  return out;
}

/** heap_4/heap_5 blok başlığından ayrılan boyut (pvPortMalloc ile ayrılmış yığın için). Bilinmiyorsa 0 */
async function heapBlockSize(target, ptr) {
  try {
    const [next, size] = await target.readMemory(ptr - 8, 2);
    const bytes = (size & 0x7fffffff) - 8;
    return next === 0 && size & 0x80000000 && bytes >= 32 && bytes <= 0x100000 ? bytes : 0;
  } catch {
    return 0;
  }
}

/** Yığın tepe değeri: pxStack'ten yukarı dolgu (0xA5) kalan word sayısı × 4. dolgu yoksa null */
async function stackFree(target, pxStack, limitBytes) {
  const max = Math.min(limitBytes || 16384, 65536);
  let free = 0;
  for (let off = 0; off < max; off += 128) {
    const words = await target.readMemory(pxStack + off, Math.min(32, (max - off) / 4));
    for (const w of words) {
      if (w !== FILL) return free;
      free += 4;
    }
  }
  return free;
}

/**
 * Sembol tablosu: ad → { addr, size }. LTO'da static adlar "ad.lto_priv.0" olur: noktadan öncesi alınır.
 * @param {{ name: string, addr: number, size: number }[]} list
 */
function symbolMap(list) {
  const m = new Map();
  for (const s of list || []) {
    const k = s.name.split('.')[0];
    if (!m.has(k)) m.set(k, s);
  }
  return m;
}

class RtosReader {
  /**
   * @param {any} target @param {{ syms: Map<string, { addr: number, size: number }>, cfg?: any, funcs?: any[], core?: string }} o
   */
  constructor(target, o) {
    this.target = target;
    this.syms = o.syms;
    this.cfg = { ...(o.cfg || DEFAULT_CONFIG) };
    this.T = tcbLayout(this.cfg);
    this.Q = queueLayout(this.cfg);
    this.TM = timerLayout(this.cfg);
    this.core = o.core || 'cortex-m4';
    /** Önceki çalışma süresi sayaçları (CPU yüzdesi bunların farkından) */
    this.prevRun = null;
  }

  sym(name) { return this.syms.get(name); }
  async word(name) { const s = this.sym(name); return s ? (await this.target.readMemory(s.addr, 1))[0] : undefined; }

  /** Tüm çekirdek durumu */
  async snapshot() {
    if (!this.sym('pxCurrentTCB') || !this.sym('pxReadyTasksLists')) throw new Error(t('ELF\'te FreeRTOS sembolleri yok (pxCurrentTCB, pxReadyTasksLists). Proje FreeRTOS kullanıyor ve derlenmiş mi?'));
    const tg = this.target, T = this.T;
    const current = await this.word('pxCurrentTCB');
    const tick = await this.word('xTickCount');
    const running = await this.word('xSchedulerRunning');
    const count = await this.word('uxCurrentNumberOfTasks');
    // Liste → durum
    /** @type {Map<number, { tcb: number, state: string }>} */
    const found = new Map();
    const visit = async (addr, state) => {
      for (const { owner } of await listOwners(tg, addr)) if (owner && !found.has(owner)) found.set(owner, { tcb: owner, state });
    };
    const ready = this.sym('pxReadyTasksLists');
    const prios = Math.max(1, Math.round(ready.size / LIST));
    for (let p = prios - 1; p >= 0; p--) await visit(ready.addr + p * LIST, 'ready');
    for (const n of ['xPendingReadyList']) if (this.sym(n)) await visit(this.sym(n).addr, 'ready');
    for (const n of ['xDelayedTaskList1', 'xDelayedTaskList2']) if (this.sym(n)) await visit(this.sym(n).addr, 'blocked');
    if (this.sym('xSuspendedTaskList')) await visit(this.sym('xSuspendedTaskList').addr, 'suspended');
    if (this.sym('xTasksWaitingTermination')) await visit(this.sym('xTasksWaitingTermination').addr, 'deleted');
    if (current && !found.has(current)) found.set(current, { tcb: current, state: 'running' });

    const queues = await this.readQueues();
    const waitOn = new Map(); // olay listesi adresi → { kuyruk, yön }
    for (const q of queues) { waitOn.set(q.handle + this.Q.waitSend, { q, dir: 'send' }); waitOn.set(q.handle + this.Q.waitRecv, { q, dir: 'recv' }); }

    const tasks = [];
    for (const f of found.values()) {
      const b = Buffer.from(await readRegion(tg, f.tcb, T.size));
      const name = b.subarray(T.name, T.name + T.nameLen);
      const z = name.indexOf(0);
      const task = {
        tcb: f.tcb, name: name.subarray(0, z < 0 ? T.nameLen : z).toString('latin1').replace(/[^\x20-\x7e]/g, '?'),
        state: f.tcb === current ? 'running' : f.state, priority: le32(b, T.prio), top: le32(b, T.top), pxStack: le32(b, T.stack),
        basePriority: T.basePrio !== undefined ? le32(b, T.basePrio) : undefined, mutexesHeld: T.mutexes !== undefined ? le32(b, T.mutexes) : undefined,
        number: T.tcbNum !== undefined ? le32(b, T.tcbNum) : undefined, runTime: T.runTime !== undefined ? le32(b, T.runTime) : undefined,
        stackSize: 0, stackEnd: T.end !== undefined ? le32(b, T.end) : 0, freeMin: null, used: null, overflow: false, waiting: null
      };
      // Askıdaki görev bir olay listesinde bekliyorsa süresiz bekliyordur (portMAX_DELAY)
      const evContainer = le32(b, T.event + 16);
      if (task.state === 'suspended' && evContainer) task.state = 'blocked';
      const w = waitOn.get(evContainer);
      if (w) task.waiting = { name: w.q.name, dir: w.dir, type: w.q.type };
      else if (evContainer && task.state === 'blocked') task.waiting = { name: '', dir: 'event' };
      // Yığın: boyut (pxEndOfStack ya da heap bloğu), şu anki kullanım, tepe değeri
      if (task.stackEnd > task.pxStack) task.stackSize = task.stackEnd + 4 - task.pxStack;
      else task.stackSize = await heapBlockSize(tg, task.pxStack);
      if (task.stackSize) task.used = task.pxStack + task.stackSize - task.top;
      task.freeMin = await stackFree(tg, task.pxStack, task.stackSize || 4096).catch(() => null);
      if (task.freeMin === 0 || task.top < task.pxStack) task.overflow = true;
      tasks.push(task);
    }
    tasks.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
    // CPU yüzdesi: iki okuma arasındaki sayaç farkı; ilk okumada toplamdan
    if (tasks.every((x) => x.runTime !== undefined)) {
      const now = new Map(tasks.map((x) => [x.tcb, x.runTime]));
      const prev = this.prevRun;
      const delta = (x) => (prev && prev.has(x.tcb) ? (x.runTime - prev.get(x.tcb)) >>> 0 : x.runTime);
      const sum = tasks.reduce((s, x) => s + delta(x), 0);
      for (const x of tasks) x.cpu = sum ? (100 * delta(x)) / sum : 0;
      this.prevRun = now;
    }
    for (const q of queues) {
      if (q.holder) q.holderName = (tasks.find((x) => x.tcb === q.holder) || {}).name || `0x${q.holder.toString(16)}`;
      q.sendersNames = q.senders.map((a) => (tasks.find((x) => x.tcb === a) || {}).name || '?');
      q.receiversNames = q.receivers.map((a) => (tasks.find((x) => x.tcb === a) || {}).name || '?');
    }
    const heap = await this.readHeap();
    const timers = await this.readTimers();
    const r = { current, tick, running: !!running, count, prios, tasks, queues, timers, heap };
    r.warnings = warnings(r);
    return r;
  }

  /** Kuyruk kaydı (configQUEUE_REGISTRY_SIZE > 0; vQueueAddToRegistry ile adlandırılanlar) */
  async readQueues() {
    const reg = this.sym('xQueueRegistry');
    if (!reg || !reg.size) return [];
    const tg = this.target, Q = this.Q;
    const words = await tg.readMemory(reg.addr, Math.min(64, reg.size / 4));
    const out = [];
    for (let i = 0; i + 1 < words.length; i += 2) {
      const [namePtr, handle] = [words[i], words[i + 1]];
      if (!handle) continue;
      const b = Buffer.from(await readRegion(tg, handle, Q.size));
      const head = le32(b, Q.head), itemSize = le32(b, Q.itemSize), length = le32(b, Q.length);
      let type = Q.type !== undefined ? QUEUE_TYPES[b[Q.type]] || 'queue' : undefined;
      // ucQueueType yoksa: mutex'te pcHead NULL; öğe boyutu 0 ise semafor
      if (!type) type = head === 0 ? 'mutex' : itemSize === 0 ? (length === 1 ? 'binary' : 'counting') : 'queue';
      const mutex = type === 'mutex' || type === 'recursive';
      out.push({
        handle, name: await cstr(tg, namePtr), type, length, itemSize, waiting: le32(b, Q.waiting),
        holder: mutex ? le32(b, Q.holder) : 0, recursive: type === 'recursive' ? le32(b, Q.recursive) : 0,
        senders: (await listOwners(tg, handle + Q.waitSend)).map((x) => x.owner),
        receivers: (await listOwners(tg, handle + Q.waitRecv)).map((x) => x.owner)
      });
    }
    return out;
  }

  /** Etkin zamanlayıcılar (configUSE_TIMERS; durmuş zamanlayıcılar hiçbir listede değildir) */
  async readTimers() {
    const tg = this.target, M = this.TM, out = [];
    for (const n of ['xActiveTimerList1', 'xActiveTimerList2']) {
      const s = this.sym(n);
      if (!s) continue;
      for (const { owner, value } of await listOwners(tg, s.addr)) {
        const b = Buffer.from(await readRegion(tg, owner, M.size));
        const status = b[M.status];
        out.push({ handle: owner, name: await cstr(tg, le32(b, M.name)), expiry: value, period: le32(b, M.period), id: le32(b, M.id), callback: le32(b, M.callback), autoReload: !!(status & 4), active: !!(status & 1) });
      }
    }
    return out;
  }

  /** heap_4/heap_5: boş, en az boş, toplam; heap_1/2'de sadece boş (bulunabilirse) */
  async readHeap() {
    const free = await this.word('xFreeBytesRemaining');
    if (free === undefined) return null;
    const minEver = await this.word('xMinimumEverFreeBytesRemaining');
    const total = this.sym('ucHeap') ? this.sym('ucHeap').size : this.cfg.configTOTAL_HEAP_SIZE || 0;
    return { free, minEver, total };
  }
}

/** Yığın taşması ve heap tükenmesi uyarıları: { level: 'error'|'warn', text } */
function warnings(r) {
  const out = [];
  for (const x of r.tasks) {
    if (x.state === 'deleted') continue;
    if (x.overflow) out.push({ level: 'error', task: x.name, text: t('"{0}" görevinin yığını taşmış: yığın sonundaki 0xA5 dolgusu bozulmuş. Görevin yığın boyutunu artırın.', x.name) });
    else if (x.freeMin !== null && x.stackSize && x.freeMin < Math.max(64, x.stackSize * 0.1)) out.push({ level: 'warn', task: x.name, text: t('"{0}" görevinin yığınında en kötü durumda {1} bayt boş kaldı ({2} baytın %{3}\'ü). Taşma riski.', x.name, x.freeMin, x.stackSize, Math.round((100 * x.freeMin) / x.stackSize)) });
  }
  const h = r.heap;
  if (h && h.total) {
    if (h.free === 0 || h.minEver === 0) out.push({ level: 'error', text: t('FreeRTOS heap\'i tükendi: pvPortMalloc başarısız olmuş olabilir (configTOTAL_HEAP_SIZE = {0} bayt).', h.total) });
    else if (h.minEver < h.total * 0.1) out.push({ level: 'warn', text: t('FreeRTOS heap\'inde en kötü durumda {0} bayt boş kaldı (toplam {1}). configTOTAL_HEAP_SIZE\'ı artırmayı düşünün.', h.minEver, h.total) });
  }
  return out;
}

// ------------------------------------------------------------------ bağlam ve çağrı zinciri
/**
 * Görevin register'ları. Çalışan görev (durdurulmuşken): çekirdek register'ları; işleyicideyse PSP'deki çerçeve.
 * Diğerleri: pxTopOfStack'teki kayıtlı bağlam (port düzenleri denenir, xPSR'de Thumb biti olan seçilir).
 * @returns {Promise<{ regs: any, layout: string, fpu: boolean } | null>}
 */
async function taskContext(target, task, core, live) {
  if (live) {
    const ipsr = (live.xPSR >>> 0) & 0x1ff;
    if (!ipsr) return { regs: { ...live, sp: live.sp }, layout: 'core', fpu: false };
    const f = await target.readMemory(live.psp, 8);
    const regs = Object.fromEntries(FRAME.map((n, i) => [n, f[i]]));
    return { regs: { ...regs, sp: live.psp + 32 }, layout: 'psp', fpu: false };
  }
  for (const names of CONTEXTS[ctxKind(core)]) {
    const soft = await target.readMemory(task.top, names.length);
    const regs = Object.fromEntries(names.map((n, i) => [n, soft[i]]));
    if ('exc' in regs && !isExcReturn(regs.exc)) continue;
    const fpu = 'exc' in regs && !(regs.exc & 0x10);
    let at = task.top + names.length * 4 + (fpu ? 64 : 0);
    const f = await target.readMemory(at, 8);
    if (!(f[7] & (1 << 24))) continue; // xPSR.T
    FRAME.forEach((n, i) => (regs[n] = f[i]));
    at += 32 + (fpu ? 72 : 0) + (f[7] & (1 << 9) ? 4 : 0);
    regs.sp = at;
    return { regs, layout: names.join(','), fpu };
  }
  return null;
}

/** ELF'teki yüklenebilir bölümlerden kod okuma (BL denetimi için). ELF yoksa null */
function elfCode(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch { return null; }
  if (buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1) return null;
  const phoff = buf.readUInt32LE(0x1c), phentsize = buf.readUInt16LE(0x2a), phnum = buf.readUInt16LE(0x2c);
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    segs.push({ off: buf.readUInt32LE(o + 4), vaddr: buf.readUInt32LE(o + 8), paddr: buf.readUInt32LE(o + 12), size: buf.readUInt32LE(o + 16) });
  }
  /** @param {number} a @returns {number | undefined} yarım word */
  return (a) => {
    for (const s of segs) for (const base of [s.vaddr, s.paddr]) if (a >= base && a + 2 <= base + s.size) return buf.readUInt16LE(s.off + a - base);
    return undefined;
  };
}

/** Dönüş adresinden önce bir çağrı komutu var mı (BL, BLX imm, BLX reg). Kod okunamıyorsa kabul edilir */
function precededByCall(code, ret) {
  if (!code) return true;
  const h2 = code(ret - 2), h1 = code(ret - 4);
  if (h2 === undefined) return false;
  if ((h2 & 0xff87) === 0x4780) return true; // BLX Rm
  return h1 !== undefined && (h1 & 0xf800) === 0xf000 && (h2 & 0xd000) === 0xd000 || h1 !== undefined && (h1 & 0xf800) === 0xf000 && (h2 & 0xd001) === 0xc000;
}

/**
 * Olası çağrı zinciri: PC, LR ve yığında bir çağrı komutundan sonrasını gösteren (Thumb, fonksiyon içi) word'ler.
 * Derleyicinin çerçeve bilgisi (DWARF CFI) kullanılmaz: sezgiseldir, eski çağrılardan kalan değerler de görünebilir.
 * @param {any} lookup PcProfile benzeri: lookup(pc) → fonksiyon adı | null
 */
async function backtrace(target, regs, stackTop, lookup, code, maxFrames = 16) {
  const frames = [{ pc: regs.pc >>> 0, func: lookup(regs.pc & ~1), kind: 'pc' }];
  const lr = regs.lr >>> 0;
  if (!isExcReturn(lr) && lr & 1 && lookup(lr & ~1)) frames.push({ pc: (lr & ~1) >>> 0, func: lookup(lr & ~1), kind: 'lr', sp: undefined });
  const from = regs.sp >>> 0, to = Math.min(stackTop || from + 2048, from + 4096);
  for (let a = from; a < to && frames.length < maxFrames; a += 128) {
    const words = await target.readMemory(a, Math.min(32, (to - a) / 4)).catch(() => []);
    for (let i = 0; i < words.length && frames.length < maxFrames; i++) {
      const w = words[i] >>> 0;
      if (!(w & 1) || w < 0x08000000 || w >= 0x20000000) continue;
      const ret = (w & ~1) >>> 0, func = lookup(ret);
      if (!func || !precededByCall(code, ret)) continue;
      const last = frames[frames.length - 1];
      if (last.pc === ret) continue;
      frames.push({ pc: ret, func, kind: 'stack', sp: a + i * 4 });
    }
  }
  return frames;
}

// ------------------------------------------------------------------ simülasyon çekirdeği
/** Simülasyondaki çekirdek bellek bölgesi (RTT ve fault benzetiminin kullandığı adreslerden uzakta) */
const SIM_BASE = 0x20004000;

/**
 * Simülasyon: gerçek yerleşimle TCB'ler, listeler, yığınlar (kayıtlı bağlam ve çağrı zinciriyle), kuyruk kaydı,
 * zamanlayıcılar ve heap. Değişen alanlar (tick, çalışan görev, CPU sayaçları, kuyruk doluluğu) model.dynamic ile.
 * @param {any} sim SimTarget @param {{ names?: string[], core?: string, funcs: { name: string, addr: number, size: number }[] }} o
 * @returns {{ name: string, addr: number, size: number }[]} sembol tablosu
 */
function simKernel(sim, o) {
  const cfg = DEFAULT_CONFIG, T = tcbLayout(cfg), Q = queueLayout(cfg), TM = timerLayout(cfg);
  const E = sim.model.expected, D = sim.model.dynamic;
  const set = (a, v) => E.set(a >>> 0, v >>> 0);
  const bytes = (a, s) => [...Buffer.from(s + '\0', 'latin1')].forEach((b, k) => sim.setByte(a + k, b));
  const fn = (name, off = 0) => { const f = o.funcs.find((x) => x.name === name) || o.funcs[1]; return (f.addr + off) | 1; };
  let p = SIM_BASE;
  const alloc = (n) => { const a = p; p = align4(p + n); return a; };
  const syms = [];
  const sym = (name, size) => { const a = alloc(size); syms.push({ name, addr: a, size }); return a; };
  const PRIOS = 4;
  const ready = sym('pxReadyTasksLists', PRIOS * LIST);
  const d1 = sym('xDelayedTaskList1', LIST), d2 = sym('xDelayedTaskList2', LIST);
  const pend = sym('xPendingReadyList', LIST), susp = sym('xSuspendedTaskList', LIST), term = sym('xTasksWaitingTermination', LIST);
  const cur = sym('pxCurrentTCB', 4), tick = sym('xTickCount', 4), run = sym('xSchedulerRunning', 4), num = sym('uxCurrentNumberOfTasks', 4);
  const reg = sym('xQueueRegistry', 8 * 8);
  const t1 = sym('xActiveTimerList1', LIST); sym('xActiveTimerList2', LIST);
  const free = sym('xFreeBytesRemaining', 4), minEver = sym('xMinimumEverFreeBytesRemaining', 4);
  const HEAP = 0x3400;
  syms.push({ name: 'ucHeap', addr: 0x20010000, size: HEAP });
  const lists = new Map(); // liste → öğeler
  const initList = (l) => { set(l, 0); set(l + 4, l + 8); set(l + 8, 0xffffffff); set(l + 12, l + 8); set(l + 16, l + 8); lists.set(l, []); };
  [...Array(PRIOS)].forEach((_, i) => initList(ready + i * LIST));
  [d1, d2, pend, susp, term, t1, t1 + LIST].forEach(initList);
  /** Listeye öğe ekle (sırayla bağla) */
  const link = (l, item, owner, value) => {
    const items = lists.get(l);
    items.push(item);
    set(item, value); set(item + 12, owner); set(item + 16, l);
    const all = [l + 8, ...items];
    all.forEach((a, i) => { const nx = all[(i + 1) % all.length], pv = all[(i - 1 + all.length) % all.length]; set(a + 4, nx); set(a + 8, pv); });
    set(l, items.length);
  };
  // Görevler: [ad, öncelik, yığın word, durum, kullanılan yığın oranı, CPU payı, PC fonksiyonu]
  const user = (o.names && o.names.length ? o.names : ['SensorTask', 'CommsTask']).slice(0, 4);
  const specs = [
    ['IDLE', 0, 130, 'ready', 0.35, 52, 'HAL_Delay'], ['Monitor', 1, 256, 'blocked', 0.55, 9, 'telemetry_send'],
    ...user.map((n, i) => [n.slice(0, 15), 2, 200, i === user.length - 1 ? 'blocked' : i % 2 ? 'suspended' : 'ready', i === user.length - 1 ? 0.96 : 0.6, 12 - i, i ? 'sensor_read' : 'bsp_i2c_read'])
  ];
  const tcbs = [];
  for (const [name, prio, words, state, usedRatio, , pcFn] of specs) {
    const size = words * 4;
    const hdr = alloc(8 + size);
    const stack = hdr + 8;
    set(hdr, 0); set(hdr + 4, (size + 8) | 0x80000000); // heap_4 blok başlığı
    for (let a = stack; a < stack + size; a += 4) set(a, FILL);
    const tcbHdr = alloc(8 + T.size);
    const tcb = tcbHdr + 8;
    set(tcbHdr, 0); set(tcbHdr + 4, (T.size + 8) | 0x80000000);
    for (let a = tcb; a < tcb + T.size; a += 4) set(a, 0);
    // Kayıtlı bağlam: yazılım register'ları + donanım çerçevesi; üstünde çağrı zinciri (App_Loop → main)
    const kind = ctxKind(o.core || 'cortex-m4');
    const names = CONTEXTS[kind][0];
    const used = Math.min(size - 8, Math.max(names.length * 4 + 64, Math.round(size * usedRatio))) & ~7; // AAPCS: 8 bayt hizalı
    const top = stack + size - used;
    const soft = names.map((n) => (n === 'exc' ? 0xfffffffd : n === 'psplim' ? stack : 0x10000000 + R4_11.indexOf(n)));
    soft.forEach((v, i) => set(top + i * 4, v));
    const fr = top + names.length * 4;
    [0, 1, 2, 3, 12, fn('HAL_Delay', 0x12), fn(pcFn, 0x10) & ~1, 0x01000000].forEach((v, i) => set(fr + i * 4, v));
    set(fr + 40, fn('App_Loop', 0x2c)); set(fr + 56, fn('main', 0x4a));
    set(tcb + T.top, top); set(tcb + T.prio, prio); set(tcb + T.stack, stack);
    bytes(tcb + T.name, name);
    if (T.end !== undefined) set(tcb + T.end, stack + size - 4);
    if (T.tcbNum !== undefined) set(tcb + T.tcbNum, tcbs.length + 1);
    if (T.basePrio !== undefined) set(tcb + T.basePrio, prio);
    // Taşma senaryosu: en kötü durumda yığının sonuna çok yaklaşılmış
    if (usedRatio > 0.9) for (let a = stack + 24; a < top; a += 4) set(a, 0x20000000 + (a & 0xfff));
    tcbs.push({ tcb, prio, state, name });
  }
  for (const x of tcbs) {
    const l = x.state === 'ready' ? ready + x.prio * LIST : x.state === 'suspended' ? susp : d1;
    link(l, x.tcb + T.state, x.tcb, x.state === 'blocked' ? 1000 : 0);
  }
  set(num, tcbs.length); set(run, 1);
  // CPU payları: IDLE ve diğerleri; sayaç birimi µs
  const share = specs.map((s) => s[5]);
  const totalShare = share.reduce((s, x) => s + x, 0);
  tcbs.forEach((x, i) => D.set(x.tcb + T.runTime, (ms) => Math.floor((ms * 1000 * share[i]) / totalShare)));
  const busy = tcbs.find((x) => x.state === 'ready' && x.prio > 0);
  D.set(cur, (ms) => (busy && Math.floor(ms / 37) % 7 === 3 ? busy : tcbs[0]).tcb);
  D.set(tick, (ms) => ms);
  // Kuyruk kaydı: veri kuyruğu, I2C mutex'i (sahibi bir görev, başka görev bekliyor), ikili semafor
  const queue = (name, type, length, itemSize) => {
    const q = alloc(Q.size);
    for (let a = q; a < q + Q.size; a += 4) set(a, 0);
    initList(q + Q.waitSend); initList(q + Q.waitRecv);
    const mutex = type === 1 || type === 4;
    set(q + Q.head, mutex ? 0 : q + 0x100); set(q + Q.length, length); set(q + Q.itemSize, itemSize);
    if (Q.type !== undefined) sim.setByte(q + Q.type, type);
    const nm = alloc(name.length + 1);
    bytes(nm, name);
    const k = queues.length;
    set(reg + k * 8, nm); set(reg + k * 8 + 4, q);
    queues.push(q);
    return q;
  };
  const queues = [];
  const sq = queue('SensorQ', 0, 8, 16);
  D.set(sq + Q.waiting, (ms) => Math.floor(ms / 300) % 9);
  const mx = queue('lock_I2C1', 1, 1, 0);
  const waiter = tcbs[tcbs.length - 1];
  const holder = busy || tcbs[1];
  set(mx + Q.holder, holder.tcb);
  if (T.mutexes !== undefined) set(holder.tcb + T.mutexes, 1);
  link(mx + Q.waitRecv, waiter.tcb + T.event, waiter.tcb, 2);
  const sem = queue('DataReady', 3, 1, 0);
  D.set(sem + Q.waiting, (ms) => (ms % 1000 < 100 ? 1 : 0));
  // Zamanlayıcılar
  const timer = (name, period, auto, cb) => {
    const tm = alloc(TM.size);
    const nm = alloc(name.length + 1);
    bytes(nm, name);
    set(tm + TM.name, nm); set(tm + TM.period, period); set(tm + TM.callback, fn(cb) & ~1 | 1);
    sim.setByte(tm + TM.status, 1 | (auto ? 4 : 0));
    link(t1, tm + TM.item, tm, period);
    D.set(tm + TM.item, (ms) => (Math.floor(ms / period) + 1) * period); // sonraki tetikleme
  };
  timer('Blink', 500, true, 'prvBlinkTimer');
  timer('Watchdog', 2000, false, 'prvWatchdogTimer');
  D.set(free, (ms) => 0x3400 - 0x2e00 - (Math.floor(ms / 700) % 3) * 64);
  set(minEver, 0x3400 - 0x2f80);
  return syms;
}

module.exports = {
  parseConfig, DEFAULT_CONFIG, tcbLayout, queueLayout, timerLayout, QUEUE_TYPES, CONTEXTS, ctxKind, listOwners, heapBlockSize, stackFree,
  symbolMap, RtosReader, warnings, taskContext, elfCode, precededByCall, backtrace, simKernel, SIM_BASE, FILL
};
