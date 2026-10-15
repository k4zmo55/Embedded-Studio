// @ts-check
/**
 * Üretilen dosyaları projeye yazar ve kullanıcının kodunu korur.
 *
 *  - USER CODE BEGIN/END bloklarının içi eski dosyadan yeni dosyaya taşınır.
 *  - Tasarımdan kalkan bir bölüme ait blok kaybolmaz: dosyanın sonuna "Orphaned" bloğu olarak eklenir (#if 0).
 *  - İçeriği değişmeyen dosyaya dokunulmaz (zaman damgası, git diff temiz kalır).
 *  - Artık üretilmeyen dosya (ör. çıkarılan sensörün sürücüsü): değiştirilmemişse silinir, kullanıcı
 *    değiştirmişse .embedded-studio/removed/ altına taşınır.
 *  - .embedded-studio/manifest.json: üretilen dosyaların hash'leri + tasarım özeti.
 *  - .embedded-studio/LAST_CHANGES.md: insanlar ve yapay zekâ ajanları için değişiklik raporu.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { layout } = require('./layout');

const STATE_DIR = '.embedded-studio';
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

const BLOCK_RE = /^([ \t]*)(\/\*|#|<!--)[ \t]*USER CODE BEGIN (.+?)[ \t]*(\*\/|-->)?[ \t]*\r?\n([\s\S]*?)^[ \t]*(?:\/\*|#|<!--)[ \t]*USER CODE END \3[ \t]*(?:\*\/|-->)?[ \t]*$/gm;

/** Dosyadaki kullanıcı bloklarını { ad: içerik } olarak döndürür. */
function extractBlocks(text) {
  const out = new Map();
  for (const m of text.matchAll(BLOCK_RE)) out.set(m[3], m[5]);
  return out;
}

/** Yeni şablondaki boş blokları eski içerikle doldurur. */
function mergeUserBlocks(fresh, old, filePath) {
  const oldBlocks = extractBlocks(old);
  const used = new Set();
  let content = fresh.replace(BLOCK_RE, (all, ind, open, name, close, inner) => {
    if (!oldBlocks.has(name)) return all;
    used.add(name);
    const begin = all.slice(0, all.indexOf('\n') + 1);
    const end = all.slice(all.lastIndexOf('\n', all.length - 1) + 1);
    // all = BEGIN satırı + inner + END satırı; inner yerine eski içerik
    const endLine = all.slice(begin.length + inner.length);
    return begin + oldBlocks.get(name) + endLine;
  });
  const orphans = [];
  for (const [name, inner] of oldBlocks) {
    if (used.has(name) || !inner.trim()) continue;
    orphans.push(name);
    const isC = /\.(c|h)$/.test(filePath);
    const isCmake = /CMakeLists\.txt$|\.cmake$/.test(filePath);
    const orphanName = name.startsWith('Orphaned ') ? name : `Orphaned ${name}`;
    const body = isC && !name.startsWith('Orphaned ') ? `#if 0 /* Tasarımdan kaldırılan "${name}" bölümüne aitti; gerekirse taşıyıp bu bloğu silin. */\n${inner}#endif\n` : inner;
    if (isC) content += `\n/* USER CODE BEGIN ${orphanName} */\n${body}/* USER CODE END ${orphanName} */\n`;
    else if (isCmake) content += `\n# USER CODE BEGIN ${orphanName}\n${inner.split('\n').map((l) => (l && !name.startsWith('Orphaned ') ? '# ' + l : l)).join('\n')}# USER CODE END ${orphanName}\n`;
    else content += `\n<!-- USER CODE BEGIN ${orphanName} -->\n${inner}<!-- USER CODE END ${orphanName} -->\n`;
  }
  return { content, orphans };
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** Tasarımın kod üretimini etkileyen kısmının özeti (monitör düzeni gibi şeyler hariç). */
function designFingerprint(design, generatorVersion) {
  const relevant = {
    v: generatorVersion,
    mcuId: design.mcuId,
    framework: design.framework,
    rtos: !!design.rtos,
    project: design.project && design.project.name,
    clock: design.clock || null,
    instances: design.instances.map((i) => ({ id: i.id, c: i.componentId, l: i.label, o: i.options || null })),
    locks: design.locks || {}
  };
  return sha1(JSON.stringify(relevant));
}

/** Önceki ve yeni tasarım özetinden insan okunur değişiklik listesi. */
function diffSnapshots(prev, next) {
  const lines = [];
  if (!prev) return ['İlk kod üretimi.'];
  const pi = new Map(prev.instances.map((i) => [i.id, i]));
  const ni = new Map(next.instances.map((i) => [i.id, i]));
  for (const [id, i] of ni) if (!pi.has(id)) lines.push(`Eklendi: **${i.label}** (${i.name})`);
  for (const [id, i] of pi) if (!ni.has(id)) lines.push(`Çıkarıldı: **${i.label}** (${i.name})`);
  const key = (c) => `${c.instId}.${c.compPin}`;
  const pc = new Map(prev.connections.map((c) => [key(c), c]));
  for (const c of next.connections) {
    const o = pc.get(key(c));
    const label = ni.get(c.instId)?.label ?? c.instId;
    if (o && (o.mcuPin !== c.mcuPin || o.signal !== c.signal)) lines.push(`Pin değişti: ${label}.${c.compPin} ${o.mcuPin} (${o.signal}) → ${c.mcuPin} (${c.signal})`);
  }
  if (prev.framework !== next.framework) lines.push(`Altyapı değişti: ${prev.framework} → ${next.framework}`);
  if (prev.rtos !== next.rtos) lines.push(next.rtos ? 'FreeRTOS eklendi.' : 'FreeRTOS kaldırıldı.');
  if (JSON.stringify(prev.clock) !== JSON.stringify(next.clock)) lines.push(`Saat ağacı değişti: SYSCLK ${prev.clock?.sysclk ?? '?'} → ${next.clock?.sysclk ?? '?'} MHz`);
  return lines.length ? lines : ['Tasarım ayarlarında küçük değişiklik (adres/kilit vb.).'];
}

/**
 * @param {string} root proje kök klasörü
 * @param {{ files: { path: string, content: string, kind: string }[] }} gen generator çıktısı
 * @param {{ fingerprint: string, snapshot: any, force?: boolean }} info
 */
function writeProject(root, gen, info) {
  const stateDir = path.join(root, STATE_DIR);
  const manifestPath = path.join(stateDir, 'manifest.json');
  const manifest = readJson(manifestPath) || { files: {} };
  const report = { upToDate: false, added: [], updated: [], unchanged: [], removed: [], preserved: [], orphans: [], changes: [] };

  const allPresent = gen.files.every((f) => fs.existsSync(path.join(root, f.path)));
  if (!info.force && manifest.fingerprint === info.fingerprint && allPresent) {
    report.upToDate = true;
    return report;
  }

  const newManifest = { fingerprint: info.fingerprint, generatedAt: new Date().toISOString(), snapshot: info.snapshot, files: {} };
  for (const f of gen.files) {
    const abs = path.join(root, f.path);
    const exists = fs.existsSync(abs);
    let content = f.content;
    if (f.kind === 'once') {
      if (!exists) {
        write(abs, content);
        report.added.push(f.path);
      }
      continue;
    }
    if (f.kind === 'user' && exists) {
      const r = mergeUserBlocks(content, fs.readFileSync(abs, 'utf8'), f.path);
      content = r.content;
      if (r.orphans.length) report.orphans.push({ file: f.path, blocks: r.orphans });
    }
    newManifest.files[f.path] = sha1(content);
    if (!exists) {
      write(abs, content);
      report.added.push(f.path);
    } else if (fs.readFileSync(abs, 'utf8') !== content) {
      write(abs, content);
      report.updated.push(f.path);
    } else {
      report.unchanged.push(f.path);
    }
  }

  // Artık üretilmeyen dosyalar (çıkarılan sensör sürücüleri, kapatılan RTOS ayarı...)
  for (const [rel, hash] of Object.entries(manifest.files || {})) {
    if (newManifest.files[rel]) continue;
    const abs = path.join(root, rel);
    if (!fs.existsSync(abs)) continue;
    if (sha1(fs.readFileSync(abs, 'utf8')) === hash) {
      fs.unlinkSync(abs);
      report.removed.push(rel);
    } else {
      const dest = path.join(stateDir, 'removed', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
      report.preserved.push(rel);
    }
  }

  report.changes = diffSnapshots(manifest.snapshot, info.snapshot);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(newManifest, null, 2) + '\n');
  fs.writeFileSync(path.join(stateDir, 'LAST_CHANGES.md'), changesMarkdown(report, newManifest.generatedAt));
  return report;
}

function write(abs, content) {
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function changesMarkdown(r, when) {
  const list = (arr) => (arr.length ? arr.map((p) => `- \`${p}\``).join('\n') : '- (yok)');
  return `# Son kod üretimi: ${when}

Bu dosya Embedded Studio tarafından her "Kod Üret" işleminde yazılır. Yapay zekâ ajanları bir göreve başlamadan
önce bunu okumalıdır: sadece aşağıda değişen dosyalar ve tasarım değişiklikleri ilgilidir; projeyi baştan yazmayın.

## Tasarım değişiklikleri
${r.changes.map((c) => `- ${c}`).join('\n')}

## Dosyalar
### Yeni
${list(r.added)}
### Güncellendi
${list(r.updated)}
### Kaldırıldı (değiştirilmemiş üretilmiş dosya)
${list(r.removed)}
### Kullanıcı değiştirmişti: .embedded-studio/removed/ altına taşındı
${list(r.preserved)}
${r.orphans.length ? `
## Dikkat: sahipsiz kullanıcı kodu
Tasarımdan kaldırılan bölümlere ait kullanıcı kodu silinmedi; ilgili dosyanın sonunda \`Orphaned\` bloğunda (\`#if 0\`) duruyor:
${r.orphans.map((o) => `- \`${o.file}\`: ${o.blocks.join(', ')}`).join('\n')}

Ajan için görev: bu kodu yeni tasarıma uygun yere taşıyın ya da kullanıcıya sorun.
` : ''}`;
}

/**
 * Son üretim başka bir klasör yapısındaysa (altyapı HAL ↔ bare-metal değişti ya da proje eski sürümle üretildi)
 * kullanıcıya ait dosyaları yeni yerlerine taşır; böylece writeProject USER CODE bloklarını yeni yerde birleştirir.
 * Taşınanlar: üretimin izlemediği (kullanıcının eklediği) dosyalar ve yeni üretimde 'user' türünde olanlar (app.c, main.c…).
 * Üretilmiş dosyalar taşınmaz; writeProject eskilerini kaldırır. Hedefte aynı adlı dosya varsa dokunulmaz.
 * @param {string} root @param {'hal'|'register'} framework @param {{ path: string, kind: string }[]} genFiles
 * @returns {{ from: string, to: string }[]}
 */
function relocateLayout(root, framework, genFiles) {
  const manifest = readJson(path.join(root, STATE_DIR, 'manifest.json'));
  if (!manifest) return [];
  const to = layout(framework);
  const tracked = Object.keys(manifest.files || {});
  const from = [layout('hal'), layout('register')].find((L) => L.src !== to.src && tracked.some((p) => p.startsWith(L.src + '/')));
  if (!from) return [];
  const userTargets = new Set(genFiles.filter((f) => f.kind === 'user').map((f) => f.path));
  const moved = [];
  for (const key of ['inc', 'src', 'drivers']) {
    const srcDir = path.join(root, from[key]);
    if (!fs.existsSync(srcDir)) continue;
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
    for (const abs of walk(srcDir)) {
      const rel = path.relative(srcDir, abs).split(path.sep).join('/');
      const oldRel = `${from[key]}/${rel}`;
      const newRel = `${to[key]}/${rel}`;
      if (tracked.includes(oldRel) && !userTargets.has(newRel)) continue; // üretilmiş dosya: writeProject kaldırır
      const dest = path.join(root, newRel);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(abs, dest);
      moved.push({ from: oldRel, to: newRel });
    }
  }
  return moved;
}

/** Boşalan klasörleri (ör. taşımadan sonra Core/Src) siler; içinde dosya kalan klasörlere dokunmaz. */
function removeEmptyDirs(root, rels) {
  for (const rel of rels) {
    let dir = path.join(root, rel);
    while (dir.startsWith(root) && dir !== root && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
      fs.rmdirSync(dir);
      dir = path.dirname(dir);
    }
  }
}

module.exports = { writeProject, mergeUserBlocks, extractBlocks, designFingerprint, diffSnapshots, relocateLayout, removeEmptyDirs, STATE_DIR };
