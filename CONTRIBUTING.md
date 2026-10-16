# Embedded Studio'ya katkı

Katkı yapmak istediğin için teşekkürler! Embedded Studio, gömülü yazılım geliştirmeyi daha görsel ve daha az hatalı
hale getirmeyi amaçlıyor. Her katkı, ister tek satırlık bir düzeltme ister yeni bir sensör olsun, buna yardım ediyor.

## İçindekiler

- [Nasıl yardım edebilirim?](#nasıl-yardım-edebilirim)
- [Geliştirme ortamı](#geliştirme-ortamı)
- [Proje yapısı](#proje-yapısı)
- [Yeni komponent eklemek](#yeni-komponent-eklemek-en-kolay-katkı)
- [Komponente sürücü yazmak](#komponente-sürücü-yazmak)
- [Yeni mikrodenetleyici eklemek](#yeni-mikrodenetleyici-eklemek)
- [Kod kuralları](#kod-kuralları)
- [Arayüz metinleri ve çeviri](#arayüz-metinleri-ve-çeviri)
- [Pull request süreci](#pull-request-süreci)

## Nasıl yardım edebilirim?

| Katkı | Zorluk | Nereden başlanır |
|---|---|---|
| Hata bildirmek | Kolay | [Hata bildirimi aç](../../issues/new?template=bug_report.yml) |
| Fikir önermek | Kolay | [Özellik isteği aç](../../issues/new?template=feature_request.yml) |
| **Yeni komponent (sensör, modül) eklemek** | Kolay | [Yeni komponent eklemek](#yeni-komponent-eklemek-en-kolay-katkı) |
| Gerçek kartta test etmek | Kolay | Bir kartla dene, sonucu issue olarak yaz (özellikle ST-Link ile debug/yükleme) |
| Dokümantasyon, çeviri (İngilizce) | Kolay–Orta | `README.md`, `CONTRIBUTING.md` |
| Komponent sürücüsü yazmak | Orta | [Komponente sürücü yazmak](#komponente-sürücü-yazmak) |
| Monitör widget'ı, arayüz iyileştirmesi | Orta | `media/` |
| Yeni MCU / MCU ailesi | Orta–Zor | [Yeni mikrodenetleyici eklemek](#yeni-mikrodenetleyici-eklemek) |
| Seri port kaynağı, LLM asistanı | Zor | Yol haritasındaki issue'lara bak |

`good first issue` etiketli issue'lar ilk katkı için seçildi.

## Geliştirme ortamı

Eklenti düz JavaScript; **derleme adımı yok**.

```bash
git clone https://github.com/k4zmo55/Embedded-Studio.git
cd Embedded-Studio
code .
```

VS Code'da **F5** tuşuna bas. Eklentinin yüklü olduğu yeni bir pencere açılır. Kodda değişiklik yaptıktan sonra o pencerede
`Ctrl+Shift+P` → **Developer: Reload Window** ile yeniden yükle.

### Testler

| Komut | Ne yapar | Gerekenler |
|---|---|---|
| `node test/smoke.js` | Pin atama, saat ağacı, kod üretimi, kullanıcı kodu birleştirme, komponent doğrulama | Node 22+ |
| `node test/build.js <önbellek> <çıktı> [filtre]` | HAL/CMSIS/FreeRTOS'u indirir, 15 işlemci için HAL ve bare-metal projeleri ve örnek sürücüleri (54 varyant) gerçekten derler. Filtre düzenli ifadedir, ör. `stm32g0` | git, cmake, ninja, arm-none-eabi-gcc |
| `node test/ui-e2e.js <çalışma> <önbellek>` | Gerçek arayüzü headless tarayıcıda açar, 35 adımlık kullanıcı senaryosunu çalıştırır. `ES_THEME=light`, `ES_SIZE=1100x700` ve `ES_SLOW=6` (işlemciyi yavaşlatır) ile açık tema, dar pencere ve zamanlama hataları da denenebilir | Edge veya Chrome + yukarıdakiler |

PR açmadan önce en azından `node test/smoke.js` çalıştır. Kod üretimini değiştirdiysen `test/build.js` de geçmeli.
GitHub Actions her push'ta bu testleri otomatik çalıştırır.

> Node kurulu değilse VS Code'un kendi Node'u ile de çalışır:
> `ELECTRON_RUN_AS_NODE=1 "<VS Code klasörü>/Code.exe" test/smoke.js`

## Proje yapısı

```
src/
  extension.js          VS Code tarafı: panel, proje, kayıt, kod üretimi, debug, görevler
  library.js            Komponent kütüphanesi + doğrulama (validateComponent)
  engine/pinAssigner.js Pin/çevre birimi atama (kısıt çözücü)
  engine/clock.js       Saat ağacı modeli (f4 / mul / mnr / h7) + otomatik çözücü
  codegen/              generator · layout · bsp · drivers · merge (USER CODE) · packs · build (CMake)
  codegen/families.js   STM32 aileleri: çekirdek, FPU, FreeRTOS portu, çevre birimi IP sürümleri
  codegen/regcode.js    Bare-metal kod (RCC, GPIO, I2C, SPI, USART, ADC) aileye göre
  codegen/halcode.js    HAL kodunun aileye göre değişen kısımları (SystemClock_Config, I2C, ADC)
  i18n.js               Arayüz dili (t() + i18n/en.json)
  debug/                OpenOCD TCL istemcisi, simülasyon, register/SVD tanımları
  monitor/telemetry.js  Telemetri protokolü + simülatör
  ai/advisor.js         Asistan (şimdilik kural tabanlı)
media/                  Webview arayüzü (her sekme ayrı dosya)
data/components/        Hazır komponentler (JSON)
data/mcus/              Mikrodenetleyici tanımları (JSON; F411 dışındakiler tools/mcu ile üretilir)
test/                   smoke, build ve arayüz testleri
tools/                  .vsix paketleyici, README görsel üreticisi, mcu/ (işlemci tanımı üretici)
```

Temel ilke: **yapay zekâ (asistan) önerir, kural motoru doğrular.** Pin ve saat ataması her zaman `pinAssigner` ve `clock`
üzerinden geçer; elektriksel olarak geçersiz bir sonuç kullanıcıya ulaşmamalı.

## Yeni komponent eklemek (en kolay katkı)

1. Eklentide **Kütüphane → Ekle → Yeni komponent oluştur** ile komponenti tanımla.
   Benzer bir komponent varsa ona sağ tıklayıp **Kopyasını düzenle** ile başlamak daha hızlı.
2. Önizlemede doğrulama ✓ olana kadar düzenle, sonra **Dışa aktar…** ile JSON olarak kaydet.
3. Dosyayı `data/components/<id>.json` olarak repoya ekle ve PR aç.

Kontrol listesi:

- [ ] Pin adları modülün üzerindeki yazıyla aynı.
- [ ] **Roller doğru.** UART'ta rol MCU tarafını anlatır: modülün `RX` pini → `uart.TX`, modülün `TX` pini → `uart.RX`.
- [ ] I2C adresi ve alternatif adresler datasheet'ten kontrol edildi.
- [ ] Besleme aralığı datasheet'teki çalışma aralığı. 3.3 V'ta çalışmıyorsa `min` 3.3'ten büyük olmalı; eklenti 5 V hattına bağlar.
- [ ] `datasheet` bağlantısı doğrudan PDF'e gidiyor ve üretici ya da güvenilir bir distribütöre ait.
- [ ] Görsel kullandıysan lisansı uygun (kendi çektiğin fotoğraf ya da serbest lisanslı).
- [ ] `node test/smoke.js` geçiyor. Bu test tüm hazır komponentleri doğrular.

Hazır sürücüsü olmayan komponentler de çalışır: pinler, bus ve init kodu üretilir, okuma kodu `app.c` içindeki
USER CODE bloğuna yazılır. Sürücüyü sonradan ekleyebilir ya da başkası ekleyebilir.

## Komponente sürücü yazmak

Sürücüler `src/codegen/drivers.js` içinde. Her giriş şunları tanımlar:

| Alan | Açıklama |
|---|---|
| `files` | Projeye kopyalanan `.c/.h` dosyaları (`Drivers/Components/`). Komponent tasarımdan çıkarılınca silinir. |
| `include` | `app.c`'ye eklenecek başlık |
| `globals(c)` | Örnek başına global değişkenler |
| `init(c)` | `App_Init()` içine eklenen kod |
| `poll(c)` | Periyodik okuma + `Telemetry_Value(...)`. Sonunda `${c.user}` (kullanıcı kod bloğu) olmalı. |
| `uartRx`, `rx(c)` | UART alma kesmesi gerekiyorsa |

Kurallar:

- Sürücü **sadece `bsp.h` API'sini** kullanmalı (`bsp_i2c_read`, `bsp_spi_transfer`, `bsp_gpio_write`…).
  Böylece aynı sürücü hem HAL hem bare-metal altyapısında çalışır.
- Kayan nokta yerine mümkünse tamsayı aritmetiği tercih et (örnek: `nmea.c`).
- Telemetri kanal adları komponent JSON'undaki `telemetry[].id` ile aynı olmalı.
- `node test/build.js` ile **dört varyantın da** (HAL/register × RTOS/RTOS'suz) `-Wall -Wextra` altında uyarısız
  derlendiğini doğrula. Mümkünse gerçek bir modülle dene ve PR'da belirt.

## Yeni mikrodenetleyici eklemek

İşlemci tanımları (`data/mcus/*.json`) elle yazılmaz, üretilir. Pinler ve alternatif fonksiyonlar ST'nin açık pin
veritabanından, saat açma bitleri ve kesme adları CMSIS cihaz başlıklarından gelir.

**Desteklenen bir ailedeki** (F0, F1, F3, F4, F7, G0, G4, H7, L4, U5) yeni bir işlemci için:

1. `tools/mcu/targets.js` dosyasına bir giriş ekle: `ref` (açık pin verisindeki XML adı, ör. `STM32F401C(B-C)Ux`),
   CMSIS `define`, `startup` dosyası, flash/RAM, kart adı ve saat ağacı (`clock`: model, sınırlar, PLL aralıkları,
   flash bekleme tablosu, varsayılan ayar). Aynı aileden bir girişi kopyalamak en kolayı.
2. Verileri indir ve üret:

   ```
   git clone --depth 1 https://github.com/STMicroelectronics/STM32_open_pin_data
   git clone --depth 1 https://github.com/STMicroelectronics/cmsis-device-f4   # gerekli aileler
   node tools/mcu/gen-mcus.js STM32_open_pin_data .
   ```

   Araç, elle doğrulanmış `stm32f411ceu6.json` ile karşılaştırarak kendini de sınar.
3. `node test/smoke.js` ve `node test/build.js <önbellek> <çıktı> <işlemci>` geçmeli (HAL + bare-metal, FreeRTOS, `-Werror`).
   Mümkünse gerçek bir kartta dene ve PR'da belirt.

**Reference manual bölüm numaraları:** örnek register sürücülerinin "Kaynak:" satırı `data/rm-sections.json`'daki numaraları
kullanır. ST'nin sitesi otomatik indirmeyi engellediği için RM PDF'lerini tarayıcıyla indirip
`python tools/mcu/rm-sections.py <pdf klasörü>` çalıştır (pypdf gerekir); numaralar PDF'in içindekiler ağacından alınır.

**Yeni bir aile** (ör. C0, WB, H5) daha fazla iş ister: `codegen/families.js` (çekirdek, FPU, FreeRTOS portu, çevre birimi
IP sürümleri), `engine/clock.js` (saat modeli), `codegen/regcode.js` ve `codegen/halcode.js` (aileye özgü saat ve
çevre birimi kodu). Böyle bir işe başlamadan önce yaklaşımı konuşmak için lütfen bir issue aç.

## Kod kuralları

- Düz JavaScript (CommonJS), her dosyanın başında `// @ts-check`. Bağımlılık eklemekten kaçın; eklenti `node_modules` olmadan çalışıyor.
- 2 boşluk girinti, tek tırnak, noktalı virgül.
- Kullanıcıya görünen metinler ve yorumlar Türkçe. Değişken ve fonksiyon adları İngilizce.
- Etrafındaki kodun stilini takip et; yorumları "neden" için yaz, "ne" için değil.
- Üretilen C kodu `-Wall -Wextra` ile uyarısız derlenmeli.
- Webview'da (`media/`) DOM'u `ES.h(...)` / `ES.s(...)` yardımcılarıyla kur; kullanıcı verisini asla `innerHTML` ile ekleme.
- Arayüz değişikliklerinde açık ve koyu temada kontrol et. Renkler VS Code tema değişkenlerinden gelir.

## Arayüz metinleri ve çeviri

Arayüz Türkçe ve İngilizce. Dil, VS Code görüntüleme dilinden seçilir; `embeddedStudio.language` ayarı (`auto`, `tr`, `en`) bunu ezer.

- Kullanıcıya görünen her metni Türkçe yazıp `t()` ile sarın: webview'da `const { t } = ES;`, eklentide `const { t } = require('./i18n');`.
- Değişkenleri metnin içine gömmeyin, yer tutucu kullanın: `t('{0} tasarımdan çıkarıldı.', label)`. İngilizcede kelime sırası farklı olabilir.
- İngilizce karşılığı [`i18n/en.json`](i18n/en.json) dosyasına ekleyin. Anahtar, Türkçe metnin kendisidir.
- Aynı Türkçe metin farklı yerlerde farklı çevrilecekse bağlam ekleyin: `t('Durdur@@debug')`. Türkçede `@@` sonrası görünmez.
- Hazır komponentlerin `name`, `description` ve `category` alanları da bu sözlükten çevrilir. Kullanıcının kendi komponentleri çevrilmez.
- `node test/smoke.js` eksik, fazla ve yer tutucusu uyuşmayan çevirileri yakalar. Arayüz testi de İngilizce ekranda Türkçe metin kalmadığını denetler.

## Pull request süreci

1. Repoyu fork'la, `main`'den bir dal aç: `ozellik/seri-port-monitor`, `duzeltme/i2c-adres-cakismasi`, `komponent/bmp180`.
2. Değişikliği yap, testleri çalıştır.
3. Commit mesajı: kısa bir başlık ve gerekirse nedenini anlatan bir gövde.
   Örnek: `komponent: BMP180 eklendi` veya `monitör: GPS widget'ında ızgara düzeltildi`.
4. PR aç ve şablondaki kontrol listesini doldur. Arayüz değişikliklerinde ekran görüntüsü ekle.
5. İnceleme sırasında gelen yorumları aynı dala yeni commit'lerle karşıla.

Büyük değişikliklerde (yeni MCU ailesi, mimari değişiklik) önce issue açıp konuşmak hem senin hem bizim zamanımızı korur.

## Davranış

Saygılı, yapıcı ve sabırlı olalım. Herkes bir yerden başladı; soru sormak her zaman serbest.
