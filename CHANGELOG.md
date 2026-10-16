# Değişiklik günlüğü

## 0.4.5 (önizleme)

- **Derleme ayarları arayüzü** (Ayarlar > Derleme): derleme tipi ve her tip için optimizasyon (`-O0/-Og/-O1/-O2/-O3/-Os/-Oz`), `-D` tanımları, ek include klasörleri, ek derleyici ve bağlayıcı bayrakları, linker script, `--specs` (nano / nosys), FPU / float ABI (hard, softfp, yazılım), uyarı seviyesi (kapalı / `-Wall -Wextra` / sıkı) ve `-Werror`.
- **Derleme ayarları `cmake/embedded-studio.cmake` dosyasında.** `CMakeLists.txt` incelir; ayarlar `embedded_studio_target(<hedef>)` ile uygulanır. Üretici kaynakları (HAL, FreeRTOS, startup) uyarısız, başlıkları `SYSTEM` olarak derlenir.
- **"CMake'i ben yönetiyorum":** Embedded Studio `CMakeLists.txt` dosyasına hiç yazmaz, sadece `cmake/embedded-studio.cmake` dosyasını günceller; Ayarlar ekranı nasıl `include` edileceğini gösterir. Dosya yoksa bir kez başlangıç dosyası oluşturulur. Kendi `CMakeLists.txt` dosyanız embedded-studio.cmake'i içermiyorsa uyarılırsınız.
- **`CMakePresets.json`:** `debug`, `release`, `minsizerel`, `relwithdebinfo`; her biri ayrı klasörde (`build/<preset>/`). VS Code görevleri: Derle (Debug), Derle (Release), Derle (MinSizeRel).
- **Araç zinciri seçimi:** arm-none-eabi-gcc klasörü (boşsa PATH; `ES_GCC_DIR` ortam değişkeniyle makineye özel). "Kurulu sürümleri bul" PATH'i, Arm GNU Toolchain ve STM32CubeIDE kurulumlarını tarar ve sürümleri listeler. Clang/LLVM deneysel olarak seçilebilir (C kodu clang, bağlama ve newlib GCC'den).
- **Derleme çıktısı ve boyut özeti:** `.elf`, `.hex`, `.bin`, `.map`; Derle bitince flash ve RAM kullanımı bildirimde ve Ayarlar'da çubuklarla gösterilir, map dosyası tek tıkla açılır.
- Yazılım float seçilip FreeRTOS açıksa FreeRTOS'un `ARM_CM3` portu kullanılır (ARM_CM4F FPU gerektirir).
- Derle/Yükle görevleri Windows'ta `cmd.exe` ile çalışır (PowerShell 5'te `&&` hatası olmaz).
- 0.4.x projelerinin `.vscode/tasks.json` ve `launch.json` dosyalarındaki eski `build/` yolları, elle değiştirilmemişse `build/debug/` olarak güncellenir.
- Düzeltme: üretilen `telemetry.c` optimizasyonlu derlemede `-Wformat-truncation` uyarısı veriyordu.
- Düzeltme: üretilmiş bir dosya kullanıcıya devredildiğinde (ör. CMakeLists.txt) "artık üretilmiyor" sanılıp kaldırılmıyor.
- Derleme testi 11 varyant: yukarıdakilere ek olarak Release/MinSizeRel + sıkı uyarı + `-Werror`, yazılım float + RTOS, özel bayraklar ve kullanıcının kendi `CMakeLists.txt` dosyası.

## 0.4.4 (önizleme)

- **Profesyonel bare-metal: araç kodunuza dokunmaz.** `app.c` / `app.h` üretilmez; `main.c` bir kez başlangıç dosyası olarak oluşturulur ve sonra tamamen sizindir. "Kod Üret" sadece sürücüleri (`drivers/`), BSP'yi, saat/çevre birimi init'ini, kesmeleri ve derleme dosyalarını yazar.
  - Tasarıma bağlı kesmeler (SysTick, UART, RTOS'a göre SVC/PendSV) üretilen `src/bsp_irq.c`'de; kendi 1 ms işiniz için weak `bsp_systick_hook()`.
  - Acemi moddan geçişte mevcut `app.c` silinmez, eski kesme kodu çakışmaz.
- **Profesyonel modda "Kod Üret" önce önizleme gösterir:** eklenecek, güncellenecek, kaldırılacak dosyalar; dosyaya tıklayınca VS Code fark görünümü açılır. "Uygula" ile yazılır.
- **Elle değiştirdiğiniz üretilmiş dosyanın üzerine yazılmaz** (Profesyonel mod): yeni hali yanına `.new` uzantısıyla yazılır.
- **Sürücü başlıklarında kullanım örneği:** her `*.h` dosyasının başında bu projenin gerçek bus/adres/pinleriyle başlatma ve okuma kodu.
- Derleme testi profesyonel bare-metal varyantlarını da derliyor (6 varyant).

## 0.4.3 (önizleme)

- **Bare-metal projeler sade klasör yapısında:** `inc/`, `src/`, `startup/` (startup ve `system_stm32f4xx.c`), `linker/`, `cmsis/core`, `cmsis/device`, `drivers/` (sadece seçilen sürücüler), RTOS açıksa `rtos/FreeRTOS`. HAL projeleri STM32CubeMX yapısında kalır (`Core/`, `Drivers/`).
- Altyapı değişince ya da eski sürümle üretilmiş bir bare-metal proje yeniden üretilince kendi dosyalarınız ve USER CODE bloklarınız yeni klasörlere taşınır; eski üretilmiş dosyalar kaldırılır.
- Ayarlar sekmesinin etki notları yeni klasör yapısını anlatır.
- README'de iki yapının karşılaştırması.

## 0.4.2 (önizleme)

- **Çalışma modu: Acemi / Profesyonel.** Proje oluştururken seçilir, sonradan Ayarlar sekmesinden değiştirilir (dosyalara dokunmaz). `embedded-studio.json` içinde `mode` olarak saklanır.
  - **Acemi:** bugünkü görsel arayüz; Tasarım sekmesiyle açılır.
  - **Profesyonel:** Debug sekmesiyle açılır, sekme sırası Debug · Monitör · Clock · Tasarım · Ayarlar. Yoğun ve sade görünüm, bilgi kartlarında modül çizimi yok, asistan paneli kapalı başlar.
  - Hangi sekmenin hangi modda ve sırada görüneceği tek bir yapılandırmada (`media/core.js` → `MODES`).
- **Alt+1…5** ile sekmeler arasında geçiş.
- Bildirimler araç çubuklarının altında gösterilir ve tıklamayı engellemez (önceden Derle/Yükle butonlarının üstüne binebiliyordu).

## 0.4.1 (önizleme)

- **Proje Ayarları sekmesi:** MCU, kod altyapısı (HAL / bare-metal) ve RTOS artık üst çubukta değil; proje oluşturulurken seçilir, sonradan **Ayarlar** sekmesinden değiştirilir. Değişiklik uygulanmadan önce hangi üretilen dosyaların ekleneceği, kaldırılacağı ve değişeceği, indirilecek paketler ve sıfırlanacak pin kilitleri gösterilir.
- Üst çubukta projenin özeti (ör. `STM32F411CEU6 · HAL · FreeRTOS`) kalır; tıklayınca Ayarlar açılır.

## 0.4.0 (önizleme)

- **İngilizce arayüz:** VS Code dili İngilizceyse arayüz İngilizce açılır; `embeddedStudio.language` ayarıyla (`auto`, `tr`, `en`) değiştirilebilir, değişiklik anında uygulanır. Komut adları, bildirimler, doğrulama mesajları, asistan notları ve register açıklamaları dahil. Asistan İngilizce isteklerdeki anahtar kelimeleri de tanır.
- **Geri al / yinele:** Tasarım ve Clock değişiklikleri Ctrl+Z / Ctrl+Y (veya şemanın sağ üstündeki butonlar) ile geri alınır.
- Dar pencerede üst çubuk taşmaz, sekmeler hep görünür; kayıt durumu değişince sayfa zıplamaz.
- Debug: dar pencerede Bellek paneli artık gizlenmiyor (register panelinin altına geçer).
- Bildirimler: aynı mesaj tekrar etmez, en fazla 4 tane gösterilir, tıklayınca kapanır, hatalar daha uzun kalır.
- Monitör: uzun task adları tabloyu taşırmaz.
- Şema, yerleşim değişince (bağlantılar yeniden çözülünce, aynalama…) kendini yeniden sığdırır; kullanıcı yakınlaştırıp kaydırdıysa görünüme dokunmaz.
- Komponent oluşturucu: doğrulama bitmeden kaydedilemez; Kaydet'e çift tıklamak gereksiz "zaten var" uyarısı açmaz.

## 0.3.0 (önizleme)

- **Komponent oluşturucu:** JSON yazmadan yeni komponent tanımlayın (Kütüphane → Ekle → Yeni komponent oluştur).
  Arayüze göre ayarlar, rol seçmeli pin tablosu, ölçümler, monitör widget'ları, renk/çip veya kendi görseliniz;
  canlı şema sembolü, bilgi kartı ve doğrulama önizlemesi. Kaydet, kaydet ve tasarıma ekle, JSON olarak dışa aktar.
- Kütüphanede sağ tık: tasarıma ekle, düzenle, hazır komponentin kopyasını düzenle, kaldır.
- Daha kapsamlı doğrulama: tekrar eden pin adı, arayüzün gerektirdiği pinler, tanımsız ölçüme bağlı widget.
- Kaydedilmemiş değişiklik varken pencere yanlışlıkla kapanmaz; bildirimler artık düğmelerin üstüne binmez.

## 0.2.0 (önizleme)

İlk Marketplace sürümü.

- Yeni proje sihirbazı: STM32 HAL veya bare-metal (register), isteğe bağlı FreeRTOS; HAL/CMSIS/FreeRTOS kaynaklarını indirir.
- KiCad tarzı şema: sağ tık menüsü (ekle, bağlantılar, aynala, datasheet, sil), Del/Backspace ile silme, resimli bilgi kartı.
- Otomatik pin ve çevre birimi ataması, elle pin kilitleme, I2C adres çakışması çözümü.
- Clock sekmesi: saat ağacı, sınır denetimi, hedef frekansa otomatik çözüm.
- Artımlı kod üretimi: USER CODE blokları korunur, kullanılmayan sürücüler kaldırılır, yapay zekâ ajanları için AGENTS.md / CLAUDE.md / GEMINI.md.
- Monitör: 3B IMU, GPS, gösterge, termometre, grafik widget'ları; düzenlenebilir pano; RTOS task tablosu.
- Debug: simülasyon veya OpenOCD + ST-Link; register, bit alanları, bellek, değişken izleme.
- Desteklenen MCU: STM32F411CEU6 (Black Pill). 10 hazır komponent; JSON ile yeni komponent eklenebilir.
