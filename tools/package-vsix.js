// .vsix paketi üretir (vsce'nin ürettiği yapıyla aynı: [Content_Types].xml + extension.vsixmanifest + extension/…).
// Bağımlılık yok; Node 22+ (zlib.crc32) yeterli. Çalıştırma: node tools/package-vsix.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const INCLUDE_DIRS = ['src', 'media', 'data', 'i18n'];
const INCLUDE_FILES = { 'package.json': 'package.json', 'package.nls.json': 'package.nls.json', 'package.nls.tr.json': 'package.nls.tr.json', 'README.md': 'README.md', 'CHANGELOG.md': 'CHANGELOG.md', LICENSE: 'LICENSE.txt' };

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Marketplace sayfası göreli yolları çözemez: README/CHANGELOG'daki görselleri GitHub raw, bağlantıları GitHub blob adresine çevir (vsce gibi).
const repo = ((pkg.repository && pkg.repository.url) || '').replace(/\.git$/, '').replace('https://github.com/', '');
function absolutize(md) {
  if (!repo) return md;
  const raw = `https://raw.githubusercontent.com/${repo}/main/`;
  const blob = `https://github.com/${repo}/blob/main/`;
  const fix = (url, image) => (/^(https?:|#|mailto:|data:)/.test(url) ? url : (image ? raw : blob) + url.replace(/^\.\//, ''));
  return md
    .replace(/(!?)\[([^\]]*)\]\(([^)\s]+)\)/g, (_, bang, text, url) => `${bang}[${text}](${fix(url, !!bang)})`)
    .replace(/<img([^>]*?)src="([^"]+)"/g, (_, pre, url) => `<img${pre}src="${fix(url, true)}"`)
    .replace(/<a([^>]*?)href="([^"]+)"/g, (_, pre, url) => `<a${pre}href="${fix(url, false)}"`);
}

// ---- dosya listesi ----
const entries = [];
for (const [src, dst] of Object.entries(INCLUDE_FILES)) {
  let data = fs.readFileSync(path.join(ROOT, src));
  if (src.endsWith('.md')) data = Buffer.from(absolutize(data.toString('utf8')));
  entries.push({ name: `extension/${dst}`, data });
}
for (const d of INCLUDE_DIRS) {
  for (const f of walk(path.join(ROOT, d))) entries.push({ name: `extension/${path.relative(ROOT, f).split(path.sep).join('/')}`, data: fs.readFileSync(f) });
}

// ---- manifest ----
const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public${pkg.preview ? ' Preview' : ''}</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Color" Value="${esc(pkg.galleryBanner.color)}" />
      <Property Id="Microsoft.VisualStudio.Services.Branding.Theme" Value="${esc(pkg.galleryBanner.theme)}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
    <Icon>extension/${esc(pkg.icon)}</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Changelog" Path="extension/CHANGELOG.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/${esc(pkg.icon)}" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const MIME = { '.json': 'application/json', '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.md': 'text/markdown', '.txt': 'text/plain', '.ps1': 'text/plain', '.vsixmanifest': 'text/xml' };
const exts = new Set(['.vsixmanifest', ...entries.map((e) => path.extname(e.name).toLowerCase())]);
for (const x of exts) if (!MIME[x]) throw new Error(`Bilinmeyen dosya türü: ${x}`);
const contentTypes = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${[...exts].map((x) => `<Default Extension="${x}" ContentType="${MIME[x]}" />`).join('')}</Types>
`;

const files = [
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
  { name: '[Content_Types].xml', data: Buffer.from(contentTypes) },
  ...entries
];

// ---- ZIP yazıcı (deflate) ----
function zip(list) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const locals = [], centrals = [];
  let offset = 0;
  for (const f of list) {
    const name = Buffer.from(f.name, 'utf8');
    const comp = zlib.deflateRawSync(f.data, { level: 9 });
    const crc = zlib.crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 dosya adı
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, comp);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(dosTime, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(f.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += 30 + name.length + comp.length;
  }
  const cdSize = centrals.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(list.length, 8);
  end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(cdSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const out = path.join(ROOT, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(out, zip(files));
console.log(`${path.basename(out)}: ${files.length} dosya, ${(fs.statSync(out).size / 1024).toFixed(1)} KB`);
