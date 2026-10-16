// @ts-check
/**
 * Bellek kullanım raporu / Build Analyzer (ES-210). vscode'a bağlı değildir (birim testli).
 *
 *  - readElf:       ELF32 section başlıkları (adres, LMA, boyut, tür) ve sembol tablosu — araç gerektirmez.
 *  - parseMap:      GNU ld .map: bellek bölgeleri (Memory Configuration) ve girdi section'larının dosyaları.
 *  - regionUsage:   bölge başına kullanım; .data gibi section'lar hem RAM'de (VMA) hem flash'ta (LMA) yer kaplar.
 *  - symbolList / fileList / diffSnapshots: sembol ve dosya katkıları, önceki derlemeye göre değişim.
 *  - parseStackUsage / parseCallgraph / stackReport: -fstack-usage (.su) ve -fcallgraph-info=su (.ci) ile
 *    fonksiyon başına en kötü yığın derinliği (özyineleme, dolaylı ve bilinmeyen çağrılar işaretlenir).
 */
const fs = require('fs');
const path = require('path');
const { t } = require('./i18n');

const SHF_WRITE = 1, SHF_ALLOC = 2, SHF_EXEC = 4;
const SHT_NOBITS = 8, SHT_SYMTAB = 2;

/**
 * @param {Buffer} buf
 * @returns {{ sections: { name: string, type: number, flags: number, addr: number, lma: number, size: number, index: number }[],
 *   symbols: { name: string, addr: number, size: number, type: 'func'|'object', bind: 'local'|'global'|'weak', section: number }[] }}
 */
function readElf(buf) {
  if (buf.length < 52 || buf.readUInt32BE(0) !== 0x7f454c46 || buf[4] !== 1 || buf[5] !== 1) throw new Error(t('ELF32 (little-endian) dosyası değil.'));
  const phoff = buf.readUInt32LE(0x1c), shoff = buf.readUInt32LE(0x20);
  const phentsize = buf.readUInt16LE(0x2a), phnum = buf.readUInt16LE(0x2c);
  const shentsize = buf.readUInt16LE(0x2e), shnum = buf.readUInt16LE(0x30), shstrndx = buf.readUInt16LE(0x32);
  const segs = [];
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize;
    if (buf.readUInt32LE(o) !== 1) continue; // PT_LOAD
    segs.push({ vaddr: buf.readUInt32LE(o + 8), paddr: buf.readUInt32LE(o + 12), memsz: buf.readUInt32LE(o + 20) });
  }
  const hdr = (i) => {
    const o = shoff + i * shentsize;
    return { nameOff: buf.readUInt32LE(o), type: buf.readUInt32LE(o + 4), flags: buf.readUInt32LE(o + 8), addr: buf.readUInt32LE(o + 12),
      offset: buf.readUInt32LE(o + 16), size: buf.readUInt32LE(o + 20), link: buf.readUInt32LE(o + 24), entsize: buf.readUInt32LE(o + 36) };
  };
  const H = [...Array(shnum)].map((_, i) => hdr(i));
  const str = (h, off) => { const s = h.offset + off; const e = buf.indexOf(0, s); return buf.toString('latin1', s, e < 0 ? s : e); };
  const shstr = H[shstrndx];
  const sections = H.map((h, index) => {
    const name = shstr ? str(shstr, h.nameOff) : '';
    // LMA: section'ı içeren yüklenebilir segmentin fiziksel adresi
    const seg = h.flags & SHF_ALLOC && h.size ? segs.find((g) => h.addr >= g.vaddr && h.addr + h.size <= g.vaddr + g.memsz) : null;
    return { name, type: h.type, flags: h.flags, addr: h.addr, lma: seg ? (h.addr - seg.vaddr + seg.paddr) >>> 0 : h.addr, size: h.size, index };
  });
  const symbols = [];
  const symtab = H.find((h) => h.type === SHT_SYMTAB);
  if (symtab) {
    const strtab = H[symtab.link];
    for (let o = symtab.offset + 16; o + 16 <= symtab.offset + symtab.size; o += 16) {
      const info = buf[o + 12], type = info & 0xf, bind = info >> 4, shndx = buf.readUInt16LE(o + 14), size = buf.readUInt32LE(o + 8);
      if ((type !== 1 && type !== 2) || !size || !shndx || shndx >= 0xff00) continue;
      const name = str(strtab, buf.readUInt32LE(o));
      if (!name || name.startsWith('$')) continue;
      symbols.push({ name, addr: (buf.readUInt32LE(o + 4) & (type === 2 ? ~1 : ~0)) >>> 0, size, type: type === 2 ? 'func' : 'object', bind: bind === 0 ? 'local' : bind === 2 ? 'weak' : 'global', section: shndx });
    }
  }
  return { sections, symbols };
}

/**
 * GNU ld .map dosyası.
 * @returns {{ regions: { name: string, origin: number, length: number, attrs: string }[], inputs: { section: string, addr: number, size: number, file: string }[] }}
 */
function parseMap(text) {
  const lines = String(text || '').split(/\r?\n/);
  const regions = [];
  let i = lines.findIndex((l) => /^Memory Configuration/.test(l));
  if (i >= 0) {
    for (i += 1; i < lines.length && !/^Linker script and memory map/.test(lines[i]); i++) {
      const m = /^(\S+)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s*(\S*)/i.exec(lines[i]);
      if (m && m[1] !== '*default*' && m[1] !== 'Name') regions.push({ name: m[1], origin: parseInt(m[2], 16), length: parseInt(m[3], 16), attrs: m[4] || '' });
    }
  }
  const inputs = [];
  const start = lines.findIndex((l) => /^Linker script and memory map/.test(l));
  if (start >= 0) {
    let pending = null; // uzun ad: adres/boyut bir sonraki satırda
    for (let k = start + 1; k < lines.length; k++) {
      const l = lines[k];
      if (/^\s\*fill\*/.test(l)) { pending = null; continue; }
      let m = /^ (\.\S+|COMMON)\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(.+)$/i.exec(l);
      if (m) { push(m[1], m[2], m[3], m[4]); pending = null; continue; }
      m = /^ (\.\S+|COMMON)\s*$/.exec(l);
      if (m) { pending = m[1]; continue; }
      if (pending) {
        m = /^\s+0x([0-9a-f]+)\s+0x([0-9a-f]+)\s+(.+)$/i.exec(l);
        if (m) push(pending, m[1], m[2], m[3]);
        pending = null;
      }
    }
  }
  function push(section, a, s, file) {
    const addr = parseInt(a, 16), size = parseInt(s, 16);
    if (size && addr && !/^0x/i.test(file.trim())) inputs.push({ section, addr, size, file: file.trim() });
  }
  return { regions, inputs };
}

/** Linker script yoksa: işlemcinin flash/RAM boyutundan varsayılan bölgeler */
const defaultRegions = (flashKB, ramKB) => [
  { name: 'FLASH', origin: 0x08000000, length: flashKB * 1024, attrs: 'rx' },
  { name: 'RAM', origin: 0x20000000, length: ramKB * 1024, attrs: 'xrw' }
];

const regionOf = (regions, addr) => regions.find((r) => addr >= r.origin && addr < r.origin + r.length);
/** Flash benzeri (yürütülebilir, yazılamaz) bölge */
const isFlashRegion = (r) => !!r && (/flash|rom/i.test(r.name) || (/x/.test(r.attrs) && !/w/.test(r.attrs)));

/**
 * Bölge başına kullanım. Section yükü olan (PROGBITS) ve LMA'sı farklı section'lar (ör. .data) LMA bölgesinde de yer kaplar.
 * @returns {{ name: string, origin: number, length: number, used: number, flash: boolean, parts: { name: string, size: number, load?: boolean }[] }[]}
 */
function regionUsage(sections, regions) {
  const out = regions.map((r) => ({ ...r, used: 0, flash: isFlashRegion(r), parts: [] }));
  const add = (addr, name, size, load) => {
    const r = out.find((x) => addr >= x.origin && addr < x.origin + x.length);
    if (!r) return;
    r.used += size;
    const p = r.parts.find((x) => x.name === name && !!x.load === !!load);
    if (p) p.size += size; else r.parts.push({ name, size, ...(load ? { load: true } : {}) });
  };
  for (const s of sections) {
    if (!(s.flags & SHF_ALLOC) || !s.size) continue;
    add(s.addr, s.name, s.size, false);
    if (s.type !== SHT_NOBITS && s.lma !== s.addr) add(s.lma, s.name, s.size, true);
  }
  for (const r of out) r.parts.sort((a, b) => b.size - a.size);
  return out;
}

/** Bölüm listesi (yalnızca belleğe yüklenenler) */
function sectionList(sections, regions) {
  return sections.filter((s) => s.flags & SHF_ALLOC && s.size).map((s) => {
    const r = regionOf(regions, s.addr);
    const load = s.type !== SHT_NOBITS && s.lma !== s.addr;
    return {
      name: s.name, addr: s.addr, lma: load ? s.lma : s.addr, size: s.size, region: r ? r.name : '',
      loadRegion: load ? (regionOf(regions, s.lma) || {}).name || '' : '',
      kind: s.type === SHT_NOBITS ? 'bss' : s.flags & SHF_EXEC ? 'code' : s.flags & SHF_WRITE && !isFlashRegion(r) ? 'data' : 'rodata'
    };
  });
}

/**
 * Semboller: tür (fonksiyon / veri / salt okunur veri), bölüm, bölge. Aynı adresteki takma adlar (weak + global) bir kez sayılır.
 */
function symbolList(elf, regions) {
  const seen = new Set();
  const out = [];
  for (const s of elf.symbols) {
    const key = `${s.addr}:${s.size}:${s.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const sec = elf.sections[s.section] || { name: '', flags: 0 };
    const r = regionOf(regions, s.addr);
    out.push({ name: s.name, addr: s.addr, size: s.size, section: sec.name, region: r ? r.name : '',
      kind: s.type === 'func' ? 'func' : sec.flags & SHF_WRITE ? 'data' : 'rodata', local: s.bind === 'local' });
  }
  return out.sort((a, b) => b.size - a.size);
}

/** Dosya yolu → kısa ad: CMakeFiles/x.dir/Core/Src/main.c.obj → Core/Src/main.c; …/libc_nano.a(lib_a-memcpy.o) → libc_nano.a */
function shortFile(file) {
  const f = String(file).replace(/\\/g, '/');
  const lib = /([^/]+\.a)\(([^)]+)\)$/.exec(f);
  if (lib) return { name: lib[1], member: lib[2], lib: true };
  const cm = /CMakeFiles\/[^/]+\.dir\/(.+?)(?:\.obj|\.o)$/.exec(f);
  if (cm) return { name: cm[1].replace(/__\//g, '../'), lib: false };
  return { name: f.split('/').slice(-2).join('/').replace(/\.(obj|o)$/, ''), lib: false };
}

/** Dosya / kütüphane başına flash ve RAM katkısı (map'teki girdi section'larından) */
function fileList(inputs, regions) {
  const by = new Map();
  for (const x of inputs) {
    const r = regionOf(regions, x.addr);
    if (!r) continue;
    const f = shortFile(x.file);
    const e = by.get(f.name) || { name: f.name, lib: f.lib, flash: 0, ram: 0, members: new Set() };
    if (isFlashRegion(r)) e.flash += x.size;
    else {
      e.ram += x.size;
      if (/^\.data/.test(x.section)) e.flash += x.size; // ilk değerler flash'ta
    }
    if (f.member) e.members.add(f.member);
    by.set(f.name, e);
  }
  return [...by.values()].map((e) => ({ ...e, members: e.members.size })).sort((a, b) => b.flash + b.ram - (a.flash + a.ram));
}

/** Kaydedilecek özet (önceki derlemeyle karşılaştırma için) */
function snapshot(key, regions, symbols) {
  const sym = {};
  for (const s of symbols) { const k = `${s.kind === 'func' ? 'f' : 'd'}:${s.name}`; sym[k] = (sym[k] || 0) + s.size; }
  return { key, at: Date.now(), regions: Object.fromEntries(regions.map((r) => [r.name, r.used])), symbols: sym };
}

/**
 * Önceki derlemeye göre değişim: bölge farkları, büyüyen/küçülen/yeni/silinen semboller (mutlak farka göre sıralı).
 */
function diffSnapshots(prev, cur) {
  if (!prev) return null;
  const regions = Object.keys({ ...prev.regions, ...cur.regions }).map((name) => ({ name, before: prev.regions[name] || 0, after: cur.regions[name] || 0 }))
    .map((r) => ({ ...r, delta: r.after - r.before }));
  const symbols = [];
  for (const k of new Set([...Object.keys(prev.symbols), ...Object.keys(cur.symbols)])) {
    const before = prev.symbols[k] || 0, after = cur.symbols[k] || 0;
    if (before === after) continue;
    symbols.push({ name: k.slice(2), kind: k[0] === 'f' ? 'func' : 'data', before, after, delta: after - before, status: !before ? 'new' : !after ? 'removed' : 'changed' });
  }
  symbols.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.name.localeCompare(b.name));
  return { since: prev.at, regions, symbols };
}

// ------------------------------------------------------------------ yığın kullanımı
/** .su satırları: "dosya:satır:sütun:fonksiyon<TAB>bayt<TAB>static|dynamic[,bounded]" */
function parseStackUsage(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(.*):(\d+):(\d+):([^\t]+)\t(\d+)\t(\S+)/.exec(line);
    if (m) out.push({ file: m[1], line: Number(m[2]), name: m[4], bytes: Number(m[5]), qual: m[6] });
  }
  return out;
}

/** -fcallgraph-info=su (.ci, VCG): düğümler (ad, konum, yığın) ve kenarlar */
function parseCallgraph(text) {
  const nodes = [], edges = [];
  const unq = (s) => s.replace(/\\n/g, '\n').replace(/\\"/g, '"');
  for (const m of String(text || '').matchAll(/node:\s*\{\s*title:\s*"((?:[^"\\]|\\.)*)"\s*label:\s*"((?:[^"\\]|\\.)*)"([^}]*)\}/g)) {
    const [name, loc, su] = unq(m[2]).split('\n');
    const lm = /^(.*):(\d+):(\d+)$/.exec(loc || '');
    const sm = /^(\d+) bytes \(([^)]+)\)/.exec(su || '');
    nodes.push({ id: unq(m[1]), name, file: lm ? lm[1] : '', line: lm ? Number(lm[2]) : 0, bytes: sm ? Number(sm[1]) : undefined, qual: sm ? sm[2] : '', external: /ellipse/.test(m[3]) });
  }
  for (const m of String(text || '').matchAll(/edge:\s*\{\s*sourcename:\s*"((?:[^"\\]|\\.)*)"\s*targetname:\s*"((?:[^"\\]|\\.)*)"/g)) edges.push({ from: unq(m[1]), to: unq(m[2]) });
  return { nodes, edges };
}

/**
 * Çağrı grafiklerini birleştirip her fonksiyon için en kötü yığın derinliği (kendi çerçevesi + en derin çağrı zinciri).
 * Dış düğümler (başka dosyada tanımlı) aynı adlı tanımla eşleşir; tanımı bulunmayanlar (kütüphane) "bilinmeyen" sayılır.
 * @param {{ nodes: any[], edges: any[] }[]} graphs
 * @returns {{ name: string, file: string, line: number, own: number, worst: number, path: string[], dynamic: boolean,
 *   recursive: boolean, indirect: boolean, unknown: string[], root: boolean }[]}
 */
function stackReport(graphs) {
  const defs = new Map(); // id → düğüm (tanımlı olanlar)
  for (const g of graphs) for (const n of g.nodes) if (!n.external && n.bytes !== undefined && !defs.has(n.id)) defs.set(n.id, n);
  // Weak tanımların başlığı static'ler gibi "dosya:ad"; başka dosyadan yapılan çağrı yalın adı kullanır: ada göre eşle
  const byName = new Map();
  for (const [id, n] of defs) if (!byName.has(n.name) || !id.includes(':')) byName.set(n.name, id);
  const resolve = (id) => (defs.has(id) ? id : byName.get(id) || id);
  const calls = new Map(); // id → hedef id kümesi
  for (const g of graphs) for (const e of g.edges) (calls.get(e.from) || calls.set(e.from, new Set()).get(e.from)).add(e.to === '__indirect_call' ? e.to : resolve(e.to));
  const called = new Set();
  for (const [from, set] of calls) for (const to of set) if (to !== from) called.add(to);
  const memo = new Map();
  const visiting = new Set();
  const solve = (id) => {
    if (memo.has(id)) return memo.get(id);
    const n = defs.get(id);
    if (visiting.has(id)) return { worst: 0, path: [], recursive: true, indirect: false, unknown: [], dynamic: false, cycle: true };
    visiting.add(id);
    let best = { worst: 0, path: [], recursive: false, indirect: false, unknown: [], dynamic: false };
    const flags = { recursive: false, indirect: false, unknown: new Set(), dynamic: /dynamic/.test(n.qual) && !/bounded/.test(n.qual) };
    for (const to of calls.get(id) || []) {
      if (to === '__indirect_call') { flags.indirect = true; continue; }
      if (to === id) { flags.recursive = true; continue; }
      if (!defs.has(to)) { flags.unknown.add(to); continue; }
      const r = solve(to);
      if (r.recursive) flags.recursive = true;
      if (r.indirect) flags.indirect = true;
      if (r.dynamic) flags.dynamic = true;
      r.unknown.forEach((u) => flags.unknown.add(u));
      if (r.worst > best.worst) best = r;
    }
    visiting.delete(id);
    const res = { worst: n.bytes + best.worst, path: [n.name, ...best.path], recursive: flags.recursive, indirect: flags.indirect, unknown: [...flags.unknown].sort(), dynamic: flags.dynamic };
    memo.set(id, res);
    return res;
  };
  const out = [];
  for (const [id, n] of defs) {
    const r = solve(id);
    out.push({ name: n.name, file: n.file, line: n.line, own: n.bytes, worst: r.worst, path: r.path, dynamic: r.dynamic, recursive: r.recursive, indirect: r.indirect, unknown: r.unknown, root: !called.has(id) });
  }
  return out.sort((a, b) => b.worst - a.worst || a.name.localeCompare(b.name));
}

/** Klasördeki .su ve .ci dosyaları (alt klasörlerle) */
function findStackFiles(dir) {
  const su = [], ci = [];
  const walk = (d, depth) => {
    let es;
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 12) walk(f, depth + 1); } else if (e.name.endsWith('.su')) su.push(f); else if (e.name.endsWith('.ci')) ci.push(f);
    }
  };
  walk(dir, 0);
  return { su, ci };
}

/**
 * Yığın raporu: .ci varsa çağrı grafiğiyle en kötü derinlik, yoksa yalnızca .su'daki kendi çerçeveleri.
 * @returns {{ functions: ReturnType<typeof stackReport>, graph: boolean, files: number } | null}
 */
function stackFromDir(dir) {
  const { su, ci } = findStackFiles(dir);
  if (ci.length) return { functions: stackReport(ci.map((f) => parseCallgraph(fs.readFileSync(f, 'utf8')))), graph: true, files: ci.length };
  if (!su.length) return null;
  const functions = su.flatMap((f) => parseStackUsage(fs.readFileSync(f, 'utf8'))).map((x) => ({
    name: x.name, file: x.file, line: x.line, own: x.bytes, worst: x.bytes, path: [x.name], dynamic: /dynamic/.test(x.qual) && !/bounded/.test(x.qual),
    recursive: false, indirect: false, unknown: [], root: false
  })).sort((a, b) => b.own - a.own);
  return { functions, graph: false, files: su.length };
}

module.exports = {
  readElf, parseMap, defaultRegions, regionOf, isFlashRegion, regionUsage, sectionList, symbolList, shortFile, fileList,
  snapshot, diffSnapshots, parseStackUsage, parseCallgraph, stackReport, findStackFiles, stackFromDir
};
