// @ts-check
/**
 * ROADMAP.md → GitHub issue eşitleyici.
 *
 * Her "## Mx · ..." başlığı bir kilometre taşı (milestone), her "### ES-xxx · ..." başlığı bir issue olur.
 * Yalnızca eksik olanları oluşturur; var olan issue'lara dokunmaz (gövdedeki <!-- roadmap:ES-xxx --> işaretiyle eşleşir).
 *
 * Kullanım:
 *   node tools/roadmap/sync-issues.js --dry-run          (yalnızca ayrıştırıp listeler)
 *   GITHUB_TOKEN=... GITHUB_REPOSITORY=sahip/repo node tools/roadmap/sync-issues.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DRY = process.argv.includes('--dry-run');
const REPO = process.env.GITHUB_REPOSITORY || 'k4zmo55/Embedded-Studio';
const TOKEN = process.env.GITHUB_TOKEN;

const LABEL_COLORS = {
  'tip:özellik': 'a2eeef', 'tip:iyileştirme': '84b6eb', 'tip:hata': 'd73a4a', 'tip:dokümantasyon': '0075ca', 'tip:komponent': 'c5def5',
  'öncelik:yüksek': 'b60205', 'öncelik:orta': 'fbca04', 'öncelik:düşük': 'c2e0c6',
  'seviye:acemi': 'bfdadc', 'seviye:profesyonel': '5319e7', 'seviye:hepsi': 'ededed',
  'good first issue': '7057ff',
};
const colorFor = (name) => LABEL_COLORS[name] || (name.startsWith('alan:') ? '1d76db' : 'ededed');

function parse(text) {
  const milestones = [];
  const issues = [];
  let ms = null;
  let issue = null;
  const close = () => {
    if (issue) issue.body = issue.body.join('\n').trim();
    issue = null;
  };
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/^## (M\d+) · (.+)$/))) {
      close();
      ms = { key: m[1], title: `${m[1]} · ${m[2].trim()}`, description: '' };
      milestones.push(ms);
    } else if (line.startsWith('## ')) {
      close();
      ms = null;
    } else if (ms && !issue && line.startsWith('> ')) {
      ms.description += (ms.description ? ' ' : '') + line.slice(2).trim();
    } else if (ms && (m = line.match(/^### (ES-\d+) · (.+)$/))) {
      close();
      issue = { id: m[1], title: m[2].trim(), milestone: ms.title, labels: [], body: [] };
      issues.push(issue);
    } else if (issue && (m = line.match(/^`etiketler: (.+)`$/))) {
      issue.labels = m[1].split(',').map((s) => s.trim()).filter(Boolean);
    } else if (issue && line.trim() !== '---') {
      issue.body.push(line);
    }
  }
  close();
  const ids = new Set();
  for (const i of issues) {
    if (ids.has(i.id)) throw new Error(`Aynı kimlik iki kez kullanılmış: ${i.id}`);
    ids.add(i.id);
  }
  return { milestones, issues };
}

async function api(method, url, body) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${url}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'embedded-studio-roadmap',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

async function all(url) {
  const out = [];
  for (let page = 1; ; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const items = await api('GET', `${url}${sep}per_page=100&page=${page}`);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const { milestones, issues } = parse(fs.readFileSync(path.join(ROOT, 'ROADMAP.md'), 'utf8'));
  console.log(`${milestones.length} kilometre taşı, ${issues.length} madde bulundu.`);
  if (DRY) {
    for (const i of issues) console.log(`  ${i.id}  [${i.milestone.split(' ·')[0]}]  ${i.title}  (${i.labels.join(', ')})`);
    return;
  }
  if (!TOKEN) throw new Error('GITHUB_TOKEN tanımlı değil.');

  const existingLabels = new Set((await all('/labels')).map((l) => l.name));
  for (const name of new Set(issues.flatMap((i) => i.labels))) {
    if (existingLabels.has(name)) continue;
    await api('POST', '/labels', { name, color: colorFor(name) });
    console.log(`+ etiket: ${name}`);
  }

  const msNumber = new Map((await all('/milestones?state=all')).map((m) => [m.title, m.number]));
  for (const ms of milestones) {
    if (msNumber.has(ms.title)) continue;
    const created = await api('POST', '/milestones', { title: ms.title, description: ms.description });
    msNumber.set(ms.title, created.number);
    console.log(`+ kilometre taşı: ${ms.title}`);
  }

  const done = new Set();
  for (const it of await all('/issues?state=all')) {
    const m = (it.body || '').match(/<!-- roadmap:(ES-\d+) -->/);
    if (m) done.add(m[1]);
  }
  let created = 0;
  for (const i of issues) {
    if (done.has(i.id)) continue;
    const body = `${i.body}\n\n---\n_Kimlik: ${i.id} · [ROADMAP.md](https://github.com/${REPO}/blob/main/ROADMAP.md) dosyasından oluşturuldu._\n<!-- roadmap:${i.id} -->`;
    const res = await api('POST', '/issues', { title: i.title, body, labels: i.labels, milestone: msNumber.get(i.milestone) });
    console.log(`+ #${res.number} ${i.id} ${i.title}`);
    created++;
    await sleep(1500); // GitHub'ın içerik oluşturma hız sınırına takılmamak için
  }
  console.log(`Bitti: ${created} yeni issue, ${issues.length - created} zaten vardı.`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
