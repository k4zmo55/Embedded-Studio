# Embedded Studio

STM32 için görsel gömülü sistem tasarımı, VS Code içinde. Projende hangi sensörleri kullanacağını seç;
Embedded Studio onları KiCad tarzı bir şemada mikrodenetleyiciye bağlasın, pinleri ve çevre birimlerini atasın,
saat ağacını kursun, **STM32 HAL** ya da **bare-metal (register)** + isteğe bağlı **FreeRTOS** kodunu üretsin.
Sonra derle, karta yükle, sensör değerlerini ve RTOS task'larını canlı izle, register'ları debug et.

> **Önizleme sürümü.** Şu an STM32F411CEU6 (WeAct Black Pill) destekleniyor. Gerçek kartla debug/yükleme yolu
> henüz sınırlı test edildi; geri bildirimleriniz çok değerli.

## Başlarken

1. Boş bir klasör açın.
2. Durum çubuğundaki **Embedded Studio**'ya tıklayın (veya `Ctrl+Shift+P` → *Embedded Studio: Yeni Proje*).
3. Sihirbazda proje adını, mikrodenetleyiciyi, **STM32 HAL / bare-metal** ve **FreeRTOS** seçimini yapın.
4. Soldaki kütüphaneden komponent ekleyin ya da alttaki asistana ne yapmak istediğinizi yazın.
5. **Kod Üret** → `Ctrl+Shift+B` ile derleyin → Debug sekmesinden **Yükle**.

İçinde `embedded-studio.json` olan bir klasör açtığınızda tasarımcı kendiliğinden açılır.

## Özellikler

### Tasarım
- KiCad tarzı şema; bağlantılar sinyal türüne göre renklenir, paylaşılan bus'larda bağlantı noktaları gösterilir.
- **Sağ tık:** komponent ekle (aramalı), **Bağlantılar** (Kaydet/Kapat), **Yönü değiştir (aynala)**, **Datasheet** (PDF indirir), **Sil**.
- **Delete / Backspace** ile seçili komponenti silme; üzerine gelince resimli bilgi kartı.
- Otomatik pin ve çevre birimi ataması: alternatif fonksiyon uyumu, çakışma, I2C adres çakışması (ör. ikinci BME280 → 0x77).
  Bir pini elle seçtiğinizde geri kalan atama ona göre yeniden çözülür.
- **Komponent oluşturucu:** Kütüphane → Ekle → *Yeni komponent oluştur*. Form ve canlı önizleme ile kendi sensörünüzü tanımlayın;
  hazır bir komponente sağ tıklayıp *Kopyasını düzenle* ile başlayabilirsiniz. JSON dosyası olarak içe/dışa aktarma da var.
- Her değişiklik otomatik kaydedilir.

### Clock
CubeMX benzeri saat ağacı: HSI/HSE, PLL (M/N/P/Q), AHB/APB bölücüleri. Sınır aşımları kırmızı gösterilir;
**Otomatik çöz** hedef frekans için geçerli PLL ayarını bulur. Çevre birimi tablosu UART baud hatasını, SPI hızını,
timer ön bölücüsünü gösterir.

### Kod üretimi
- STM32 HAL veya doğrudan register (CMSIS) kodu; aynı sensör sürücüleri iki altyapıda da çalışır.
- FreeRTOS: her sensöre bir task (kısa periyot → yüksek öncelik), paylaşılan I2C/SPI bus'ları için mutex, task monitörü.
- CMake + `arm-none-eabi-gcc` projesi, bağlayıcı betiği, VS Code görevleri (derle/yükle) hazır gelir.
- **Kodunuz korunur:** `USER CODE BEGIN/END` bloklarının içi yeniden üretimde taşınır. Tasarım değişmediyse hiçbir dosyaya
  dokunulmaz. Çıkarılan sensöre ait kodunuz silinmez, dosya sonunda devre dışı (`#if 0`) bir blokta kalır.
- **Yapay zekâ ajanlarıyla uyumlu:** `AGENTS.md`, `CLAUDE.md`, `GEMINI.md` ve `.github/copilot-instructions.md`,
  ajanlara hangi dosyaların üretildiğini ve kodun nereye yazılacağını anlatır; `.embedded-studio/LAST_CHANGES.md`
  son tasarım değişikliğini listeler.

### Monitör
Özelleştirilebilir pano: **3B IMU** (uçak modeli + kırmızı/yeşil/mavi eksenler + sayısal değerler), GPS rota,
termometre, gösterge, lamba, çok kanallı grafik. Widget türünü/boyutunu değiştirin, sürükleyip sıralayın, yenilerini ekleyin.
FreeRTOS task tablosu: durum, öncelik, boş stack, CPU payı.

### Debug
Simülasyon veya **OpenOCD + ST-Link**: durdur, devam, adım, reset; core register'lar ve xPSR bayrakları;
çevre birimi register'ları ve bit alanları (yerleşik tanımlar ya da tam CMSIS-SVD); bellek görüntüleyici;
derlenmiş ELF'ten değişken izleme. Okuması bayrak temizleyen register'lar (ör. USART DR) sadece hedef durduğunda okunur.

## Gereksinimler

Tasarım ve kod üretimi için ek bir şey gerekmez. Derleme, yükleme ve paket indirme için PATH'te şunlar olmalı:

| Araç | Ne için |
|---|---|
| `git` | HAL / CMSIS / FreeRTOS kaynaklarını indirmek |
| `cmake`, `ninja` | Derleme |
| `arm-none-eabi-gcc` | ARM derleyicisi (Arm GNU Toolchain) |
| `openocd` + ST-Link sürücüsü | Karta yükleme ve gerçek kartla debug |

## Bilinen sınırlamalar

- Tek MCU: STM32F411CEU6. Diğer aileler yol haritasında.
- Monitör şimdilik simülasyon verisiyle çalışır; karttan seri port ile canlı veri sıradaki sürümde.
- Asistan şu an anahtar kelime tabanlıdır (LLM bağlantısı planlanıyor). Atamalar her zaman kural motoruyla doğrulanır.
- Komponent görselleri temsilidir; datasheet'ler üreticilerin sitelerinden indirilir.

## Geliştirme

Kaynak düz JavaScript'tir, derleme adımı yoktur: klasörü VS Code'da açıp **F5**.

```
node test/smoke.js                        # motor, saat ağacı, kod üretimi, birleştirme
node test/build.js <önbellek> <çıktı>     # üretilen projeleri arm-none-eabi-gcc ile derler
node test/ui-e2e.js <çalışma> <önbellek>  # headless tarayıcıda uçtan uca arayüz senaryosu
node tools/package-vsix.js                # .vsix paketi üretir
```

## Lisans

MIT
