// @ts-check
/**
 * Embedded Studio telemetri protokolü (bkz. üretilen Core/Inc/telemetry.h):
 *   $I,<proje>,<mcu>,<rtos>
 *   $S,<kaynak>,<durum metni>
 *   $V,<kanal>,<değer>
 *   $T,<task>,<durum>,<öncelik>,<boş stack>,<cpu %>
 *
 * Kaynaklar (simülatör, seri port, RTT...) sadece satır üretir; ayrıştırma tek yerde.
 */
const { rtosPlan, cIdent } = require('../codegen/generator');

function parseLine(raw) {
  const line = raw.trim();
  if (!line.startsWith('$')) return line ? { type: 'text', text: line } : null;
  const f = line.slice(1).split(',');
  switch (f[0]) {
    case 'I': return { type: 'info', project: f[1], mcu: f[2], rtos: f[3] };
    case 'S': return { type: 'status', source: f[1], text: f.slice(2).join(',') };
    case 'V': return { type: 'value', channel: f[1], value: Number(f[2]) };
    case 'T': return { type: 'task', name: f[1], state: f[2], prio: Number(f[3]), stackFree: Number(f[4]), cpu: Number(f[5]) };
    default: return { type: 'text', text: line };
  }
}

const DEG = Math.PI / 180;

/** Fiziksel olarak tutarlı IMU hareketi: yuvarlanma/yunuslama salınımı + yavaş sapma (yaw). */
function imuSample(t) {
  const roll = 30 * Math.sin((2 * Math.PI * t) / 7);
  const pitch = 18 * Math.sin((2 * Math.PI * t) / 11 + 1);
  const droll = 30 * ((2 * Math.PI) / 7) * Math.cos((2 * Math.PI * t) / 7);
  const dpitch = 18 * ((2 * Math.PI) / 11) * Math.cos((2 * Math.PI * t) / 11 + 1);
  const gz = 25 * Math.sin((2 * Math.PI * t) / 19);
  const n = () => (Math.random() - 0.5) * 0.01;
  return {
    ax: -Math.sin(pitch * DEG) + n(),
    ay: Math.sin(roll * DEG) * Math.cos(pitch * DEG) + n(),
    az: Math.cos(roll * DEG) * Math.cos(pitch * DEG) + n(),
    gx: droll + n() * 50, gy: dpitch + n() * 50, gz: gz + n() * 50
  };
}

/** İstanbul'da küçük bir tur atan GPS alıcısı. */
function gpsSample(t) {
  const w = (2 * Math.PI * t) / 120;
  return {
    lat: 41.0082 + 0.0012 * Math.sin(w) + 0.0003 * Math.sin(3 * w),
    lon: 28.9784 + 0.0018 * Math.cos(w),
    alt: 40 + 3 * Math.sin(w * 2),
    sats: 8 + Math.round(2 * Math.sin(w * 5))
  };
}

/**
 * Donanım olmadan arayüzü geliştirmek/test etmek için, gerçek firmware'in
 * göndereceği satırların aynısını üreten simülatör.
 */
class Simulator {
  /** @param {(line: string) => void} onLine */
  constructor(design, lib, onLine) {
    this.design = design;
    this.lib = lib;
    this.onLine = onLine;
    this.timer = undefined;
    this.t0 = 0;
    this.lastTasks = 0;
    this.tick = 0;
  }

  start() {
    this.stop();
    this.t0 = Date.now();
    const mcu = this.lib.mcus[this.design.mcuId];
    this.onLine(`$I,simulasyon,${mcu.name},${this.design.rtos ? 'FreeRTOS' : 'bare-metal'}`);
    for (const inst of this.design.instances) {
      const comp = this.lib.components[inst.componentId];
      if (comp && comp.id !== 'usb_uart') this.onLine(`$S,${cIdent(inst.label)},OK (simülasyon)`);
    }
    this.timer = setInterval(() => this.step(), 50);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  step() {
    const now = Date.now();
    const t = (now - this.t0) / 1000;
    this.tick++;
    for (const inst of this.design.instances) {
      const comp = this.lib.components[inst.componentId];
      if (!comp || !comp.telemetry || !comp.telemetry.length) continue;
      // Örnekleme periyoduna yaklaşık uy (50 ms çözünürlük).
      const every = Math.max(1, Math.round((comp.sampleMs || 1000) / 50));
      if (this.tick % every !== 0) continue;
      const L = cIdent(inst.label);
      const kind = comp.telemetry[0].sim && comp.telemetry[0].sim.kind;
      if (kind === 'imu' || kind === 'gps') {
        const s = kind === 'imu' ? imuSample(t) : gpsSample(t);
        for (const ch of comp.telemetry) {
          const v = s[ch.id];
          if (v !== undefined) this.onLine(`$V,${L}.${ch.id},${kind === 'gps' && (ch.id === 'lat' || ch.id === 'lon') ? v.toFixed(7) : v.toFixed(3)}`);
        }
        continue;
      }
      for (const ch of comp.telemetry) {
        const s = ch.sim || { base: 0, amp: 1, periodS: 10, noise: 0 };
        const phase = (2 * Math.PI * t) / (s.periodS || 10);
        let v = s.square ? s.base + s.amp * Math.sign(Math.sin(phase)) : s.base + s.amp * Math.sin(phase);
        v += (Math.random() - 0.5) * 2 * (s.noise || 0);
        this.onLine(`$V,${L}.${ch.id},${v.toFixed(3)}`);
      }
    }
    if (this.design.rtos && now - this.lastTasks >= 1000) {
      this.lastTasks = now;
      const plan = rtosPlan(this.design, this.lib);
      let used = 0;
      for (const task of plan.tasks) {
        const cpu = Math.min(40, (100 / task.periodMs) * (0.8 + Math.random() * 0.4));
        used += cpu;
        const state = Math.random() < cpu / 100 ? 'READY' : 'BLOCKED';
        this.onLine(`$T,${task.name},${state},${task.priority},${Math.round(task.stackWords * (0.45 + Math.random() * 0.05))},${cpu.toFixed(3)}`);
      }
      const mon = 0.3 + Math.random() * 0.2;
      this.onLine(`$T,Monitor,RUN,1,${Math.round(plan.monitorStack * 0.55)},${mon.toFixed(3)}`);
      this.onLine(`$T,IDLE,READY,0,${100 + Math.round(Math.random() * 4)},${Math.max(0, 100 - used - mon).toFixed(3)}`);
      this.onLine(`$V,SYS.heap_free,${Math.round(plan.heapBytes * 0.18 + Math.random() * 8)}`);
    }
  }
}

module.exports = { parseLine, Simulator, imuSample, gpsSample };
