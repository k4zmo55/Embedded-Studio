"""Reference manual PDF'lerinin içindekiler (bookmark) ağacından bölüm numaralarını çıkarır.

Örnek register sürücülerinin (src/codegen/regdrivers*.js) başındaki "Kaynak:" satırı bu numaraları kullanır:
    RM0090 §8 "General-purpose I/Os (GPIO)"
Numaralar data/rm-sections.json'a yazılır. ST'nin sitesi otomatik indirmeyi engellediği için PDF'leri tarayıcıyla indirin
(her MCU tanımındaki referenceManual bağlantısı), bir klasöre koyun ve:

    python tools/mcu/rm-sections.py <pdf klasörü>

Gerekenler: Python 3.9+, pypdf (pip install pypdf)
"""
import json
import os
import re
import sys

from pypdf import PdfReader

# Sürücü anahtarı → başlıkta aranacak kısaltma (parantez içi) ya da düzenli ifade
KEYS = {
    'rcc': r'\(RCC\)', 'gpio': r'\(GPIO\)', 'exti': r'\(EXTI\)|interrupts and events', 'syscfg': r'\(SYSCFG\)',
    'afio': r'\(AFIO\)|Alternate function I/O', 'uart': r'\((USART|UART)\)', 'spi': r'\(SPI\)', 'i2c': r'\(I2C\)',
    'tim': r'General-purpose timers', 'adc': r'\(ADC\)', 'dac': r'\(DAC\)', 'dma': r'\((DMA|BDMA)\)|Direct memory access controller',
    'dmamux': r'\(DMAMUX\)', 'gpdma': r'\(GPDMA\)', 'iwdg': r'\(IWDG\)', 'wwdg': r'\(WWDG\)', 'crc': r'\(CRC\)',
    'flash': r'\(FLASH\)|Embedded [Ff]lash memory'
}
TITLE = re.compile(r'^\s*(\d+)\s+(.+)$')


def top_level(outline):
    """Sadece en üst düzey bölümler (Chapter): iç listeler alt bölümlerdir."""
    for item in outline:
        if isinstance(item, list):
            continue
        yield item.title


def sections(pdf):
    reader = PdfReader(pdf)
    found = {}
    for title in top_level(reader.outline):
        m = TITLE.match(title)
        if not m:
            continue
        num, name = m.group(1), m.group(2)
        for key, pattern in KEYS.items():
            if key not in found and re.search(pattern, name, re.I):
                found[key] = num
    return found


def rm_id(path):
    m = re.search(r'(rm\d{4})', os.path.basename(path), re.I)
    if m:
        return m.group(1).upper()
    text = PdfReader(path).pages[0].extract_text() or ''
    m = re.search(r'\b(RM\d{4})\b', text)
    return m.group(1) if m else None


def main():
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)
    folder = sys.argv[1]
    out_path = os.path.join(os.path.dirname(__file__), '..', '..', 'data', 'rm-sections.json')
    data = {}
    if os.path.exists(out_path):
        with open(out_path, encoding='utf-8') as f:
            data = json.load(f)
    for name in sorted(os.listdir(folder)):
        if not name.lower().endswith('.pdf'):
            continue
        path = os.path.join(folder, name)
        rid = rm_id(path)
        if not rid:
            print(f'{name}: RM numarası bulunamadı, atlandı')
            continue
        found = sections(path)
        data[rid] = found
        print(f'{rid}: {len(found)} bölüm ({", ".join(f"{k} §{v}" for k, v in found.items())})')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write('\n')
    print(f'yazıldı: {os.path.normpath(out_path)}')


if __name__ == '__main__':
    main()
