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
| `node test/build.js <önbellek> <çıktı>` | HAL/CMSIS/FreeRTOS'u indirir, 4 proje varyantını gerçekten derler | git, cmake, ninja, arm-none-eabi-gcc |
| `node test/ui-e2e.js <çalışma> <önbellek>` | Gerçek arayüzü headless tarayıcıda açar, 26 adımlık kullanıcı senaryosunu çalıştırır | Edge veya Chrome + yukarıdakiler |

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
  engine/clock.js       Saat ağacı modeli + otomatik çözücü
  codegen/              generator · bsp (HAL/register) · drivers · merge (USER CODE) · packs
  debug/                OpenOCD TCL istemcisi, simülasyon, register/SVD tanımları
  monitor/telemetry.js  Telemetri protokolü + simülatör
  ai/advisor.js         Asistan (şimdilik kural tabanlı)
media/                  Webview arayüzü (her sekme ayrı dosya)
data/components/        Hazır komponentler (JSON)
data/mcus/              Mikrodenetleyici tanımları (JSON)
test/                   smoke, build ve arayüz testleri
tools/                  .vsix paketleyici, README görsel üreticisi
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

**Aynı aileden bir STM32F4** (F401, F407, F446…) için `data/mcus/` altına yeni bir JSON yeterli; kod değişikliği gerekmez.
`stm32f411ceu6.json` örneğini kopyala ve şunları güncelle:

- `pins`: her pinin alternatif fonksiyonları (`signal` + `af` numarası). Kaynak: datasheet'teki
  *Alternate function mapping* tablosu ya da ST'nin açık pin verisi.
- `peripherals`: hangi çevre biriminin hangi bus'ta (APB1/APB2) olduğu.
- `clock`: HSE aralığı, en yüksek frekanslar, PLL sınırları, flash bekleme durumları.
- `device`: `define` (ör. `STM32F446xx`), `startup` dosya adı, flash/RAM boyutu.

**Başka bir STM32 ailesi** (G4, L4, F1, H7…) daha fazla iş ister: saat ağacı modeli (`engine/clock.js`), register
altyapısındaki I2C/UART kodu (`codegen/bsp.js`), paket indirme (`codegen/packs.js`) ve debug register tanımları
aileye göre değişir. Böyle bir işe başlamadan önce yaklaşımı konuşmak için lütfen bir issue aç.

## Kod kuralları

- Düz JavaScript (CommonJS), her dosyanın başında `// @ts-check`. Bağımlılık eklemekten kaçın; eklenti `node_modules` olmadan çalışıyor.
- 2 boşluk girinti, tek tırnak, noktalı virgül.
- Kullanıcıya görünen metinler ve yorumlar Türkçe. Değişken ve fonksiyon adları İngilizce.
- Etrafındaki kodun stilini takip et; yorumları "neden" için yaz, "ne" için değil.
- Üretilen C kodu `-Wall -Wextra` ile uyarısız derlenmeli.
- Webview'da (`media/`) DOM'u `ES.h(...)` / `ES.s(...)` yardımcılarıyla kur; kullanıcı verisini asla `innerHTML` ile ekleme.
- Arayüz değişikliklerinde açık ve koyu temada kontrol et. Renkler VS Code tema değişkenlerinden gelir.

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
