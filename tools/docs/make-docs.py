"""README görsellerini üretir (Pillow + Edge/Chrome gerekir).

Kullanım:
  1) Arayüz testini kayıt moduyla çalıştırın (gerçek arayüz kareleri ve ekran görüntüleri):
       ES_RECORD=<kareler> node test/ui-e2e.js <çalışma> <önbellek>
  2) python tools/docs/make-docs.py <çalışma>/shots <kareler>

Çıktı: docs/images/*.png ve *.gif
"""
import io
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'docs' / 'images'
BROWSER = os.environ.get('BROWSER', r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')

SHOTS = {
    '01-sihirbaz.png': 'sihirbaz.png',
    '06-aynalanmis.png': 'tasarim.png',
    '04-sag-tik.png': 'sag-tik.png',
    '05-baglantilar-penceresi.png': 'baglantilar.png',
    '03-bilgi-karti.png': 'bilgi-karti.png',
    '18-komponent-olusturucu.png': 'olusturucu.png',
    '11-clock.png': 'clock.png',
    '15-monitor-son.png': 'monitor.png',
    '16-debug.png': 'debug.png',
}


def save_png(img, path, width=1280):
    if img.width > width:
        img = img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)
    img = img.convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
    img.save(path, optimize=True)
    return path.stat().st_size


def screenshots(shots_dir):
    for src, dst in SHOTS.items():
        p = Path(shots_dir) / src
        if not p.exists():
            print('  eksik:', src)
            continue
        size = save_png(Image.open(p), OUT / dst)
        print(f'  {dst}: {size // 1024} KB')


def make_gif(frames, durations, path, width=900):
    """frames: PIL görüntüleri, durations: ms. Aynı kareleri birleştirir, ortak palet kullanır."""
    small = []
    for f in frames:
        if f.width != width:
            f = f.resize((width, round(f.height * width / f.width)), Image.LANCZOS)
        small.append(f.convert('RGB'))
    merged, times = [], []
    for f, d in zip(small, durations):
        if merged and not ImageChops.difference(merged[-1], f).getbbox():
            times[-1] += d
        else:
            merged.append(f)
            times.append(d)
    times[-1] = max(times[-1], 1800)  # son kareyi beklet
    # Ortak palet: titreşim olmasın
    sample = Image.new('RGB', (merged[0].width, merged[0].height * min(len(merged), 6)))
    for i, f in enumerate(merged[:: max(1, len(merged) // 6)][:6]):
        sample.paste(f, (0, i * f.height))
    pal = sample.quantize(colors=255, method=Image.Quantize.MEDIANCUT)
    out = [f.quantize(palette=pal, dither=Image.Dither.NONE) for f in merged]
    out[0].save(path, save_all=True, append_images=out[1:], duration=[max(40, int(t)) for t in times], loop=0, optimize=True, disposal=1)
    return len(out), path.stat().st_size


def scene_gifs(frames_dir):
    scenes = defaultdict(list)
    for p in sorted(Path(frames_dir).glob('*.jpg')):
        name, _, stamp = p.stem.split('_')
        scenes[name].append((int(stamp), p))
    for name, items in scenes.items():
        items.sort()
        frames = [Image.open(p) for _, p in items]
        durs = [min(400, max(60, items[i + 1][0] - items[i][0])) for i in range(len(items) - 1)] + [1500]
        n, size = make_gif(frames, durs, OUT / f'demo-{name}.gif')
        print(f'  demo-{name}.gif: {n} kare, {size // 1024} KB')


def render(url, w=960, h=560):
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / 'f.png'
        subprocess.run([BROWSER, '--headless=new', '--disable-gpu', '--hide-scrollbars', f'--window-size={w},{h}',
                        '--allow-file-access-from-files', f'--screenshot={out}', url],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=60)
        return Image.open(io.BytesIO(out.read_bytes())).convert('RGB')


def install_gif():
    page = (ROOT / 'tools' / 'docs' / 'install-guide.html').as_uri()
    plan = []  # (hash, süre ms)
    plan += [('adim=1&imlec=600,300', 500), ('adim=1&imlec=300,280', 120), ('adim=1&imlec=60,262', 900)]
    plan += [('adim=2&imlec=200,80', 500)]
    word = 'Embedded Studio'
    for i in range(1, len(word) + 1, 2):
        plan.append((f'adim=2&yaz={word[:i]}&imlec=200,80', 110))
    plan += [(f'adim=2&yaz={word}&imlec=200,80', 900)]
    plan += [('adim=3&yaz=Embedded%20Studio&imlec=150,150', 300), ('adim=3&yaz=Embedded%20Studio&imlec=140,208', 1100),
             ('adim=3&yaz=Embedded%20Studio&kurulu=1&imlec=140,208', 1500)]
    plan += [('adim=4&imlec=400,300', 300), ('adim=4&imlec=240,489', 1500)]
    plan += [('adim=5', 2600)]
    frames = [render(f'{page}#{h}') for h, _ in plan]
    n, size = make_gif(frames, [d for _, d in plan], OUT / 'kurulum.gif', width=960)
    print(f'  kurulum.gif: {n} kare, {size // 1024} KB')
    # Statik adım görselleri (GIF açılmayan yerler için)
    for k, h in {1: 'adim=1&imlec=60,262', 2: 'adim=2&yaz=Embedded Studio', 3: 'adim=3&yaz=Embedded%20Studio&imlec=140,208', 4: 'adim=4&imlec=240,489'}.items():
        save_png(render(f'{page}#{h}'), OUT / f'kurulum-{k}.png', width=960)


if __name__ == '__main__':
    OUT.mkdir(parents=True, exist_ok=True)
    shots, frames = sys.argv[1], sys.argv[2]
    print('Ekran görüntüleri:')
    screenshots(shots)
    print('Demo GIF\'leri:')
    scene_gifs(frames)
    print('Kurulum animasyonu:')
    install_gif()
