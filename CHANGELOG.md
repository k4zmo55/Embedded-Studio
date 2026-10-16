# Değişiklik günlüğü

## 0.5.2 (önizleme)

- **Prob ve kart algılama:** ST-Link (V1/V2/V2-1/V3), J-Link, CMSIS-DAP/DAPLink, STM32 USB DFU önyükleyicisi ve USB-UART köprüleri (CH340, CP210x, FTDI, PL2303) seri numarası ve sanal seri portuyla listelenir. Yerel modül yok: Windows'ta CIM + `Win32_DeviceChangeEvent` (tak/çıkar olayı), Linux'ta `/sys`, macOS'ta `ioreg`.
- **Hedef bilgisi:** OpenOCD ile tek oturumda prob firmware'i, hedef voltajı, çekirdek ve `DBGMCU_IDCODE` → cihaz ve revizyon (40 STM32 cihaz kimliği), flash boyutu, 96 bit UID, RDP seviyesi (0 / 0.5 / 1 / 2). Register adresleri 10 ailenin her biri için ayrı; aday adresler `catch` ile okunup cihaz kimliğine göre seçilir. Birden fazla aynı tür prob varsa seri numarasıyla seçilir.
- **Projeyle uyumsuzluk uyarısı:** bağlı cihaz projedeki işlemciden farklıysa durum çubuğu uyarı renginde ve bildirim çıkar.
- **Tak/çıkar:** debug probu takılınca (debug oturumu ya da çalışan görev yoksa) kart kendiliğinden sorgulanır; çıkarılınca durum çubuğu "Prob yok" olur. `embeddedStudio.probe.autoDetect` ayarı (varsayılan açık).
- **Araç algılama:** STM32_Programmer_CLI (PATH ve varsayılan kurulum klasörü), OpenOCD, pyOCD, st-flash sürümleriyle; yoksa indirme bağlantısı ve kurulum komutu.
- **Prob ve kart raporu:** prob öğesine tıklayınca problar, hedef ve araçlar Markdown önizlemede.
- Testler: birim 54 (USB sınıflandırma, Windows aygıt kimlikleri, F411/H743/F103/G071 kimlik çözme, RDP, rapor), arayüz 35.

## 0.5.1 (önizleme)

- **Durum çubuğunda Build / Flash / Debug / Run / Terminal butonları** ve prob bilgisi. Sadece Embedded Studio projesi açıkken görünür; tasarımcı paneli kapalıyken de çalışır.
  - **Build** (F7): derleme sırasında dönen gösterge, bitince gcc hata/uyarı sayısı (başarısızsa kırmızı) ve boyut özeti.
  - **Flash** (Shift+F7): derle, yükle, doğrula; hedef durdurulmuş kalır. **Run** (Ctrl+F5): derle, yükle, çalıştır.
  - **Debug** (F5): derle ve Cortex-Debug ile başlat, `main`'de dur; launch.json gerekmez, SVD dosyası varsa eklenir. Cortex-Debug yoksa kurulum önerilir.
  - **Terminal**: Monitör sekmesini açar (seri port terminali ES-211'de).
  - **Prob**: tıklayınca OpenOCD ile bir kez bağlanır; ST-Link sürümü, hedef voltajı ve çekirdek gösterilir, projedeki işlemciyle uyuşmazsa uyarı. Sürekli algılama ES-202'de.
- Komut paleti girdileri (Derle, Yükle, Debug, Çalıştır, Monitörü Aç, Prob ve Kart Bilgisi) ve kısayollar; kısayollar sadece projede ve debug dışında.
- Yükleme onayı ayarı: `embeddedStudio.flash.confirm` (varsayılan kapalı).
- Derleme/yükleme kodu tek yerde (`src/actions.js`); tasarımcıdaki Derle/Yükle düğmeleri de bunu kullanır.
- Testler: birim 51, arayüz 35 adım (durum çubuğu eylemleri, görev bitişi, Debug yapılandırması, kart yokken prob uyarısı).

## 0.5.0 (önizleme)

M1 (temel profesyonel kullanım) tamamlandı: çalışma modları, proje yapıları, kullanıcının yönettiği CMake, 15 STM32 ve örnek register sürücüleri.

- **Örnek register sürücüleri** (Ayarlar > Örnek register sürücüleri, bare-metal): RCC/saat, GPIO, EXTI, UART (yoklama, kesme + halka tampon, DMA), SPI, I2C, TIM (PWM, input capture, encoder), ADC (tek kanal, DMA ile tarama), DAC, DMA, IWDG, WWDG, CRC, FLASH. `drivers/reg/es_*.c/h` olarak bir kez üretilir, sonra kullanıcınındır.
  - Sadece CMSIS cihaz başlığına bağlı; HAL ya da BSP gerektirmez.
  - İşlemciye göre üretilir: F1 GPIO (CRL/CRH) ve AFIO, SYSCFG / EXTI tipi EXTICR, eski ve TIMINGR'li I2C (zamanlama çalışma anında), FIFO'lu USART, H7/U5 SPI, dört ADC tipi, beş DMA tipi (kanal, kanal + CSELR, kanal + DMAMUX, stream, stream + DMAMUX, GPDMA) ve bu işlemcinin UART/ADC/SPI istek eşlemeleri, flash sayfa/sektör tablosu, çift banka (F429, H743, G474, L476, U575).
  - Her dosyada açıklama, kullanım örneği ve reference manual kaynağı. Bölüm numaraları `tools/mcu/rm-sections.py` ile RM PDF'lerinin içindekilerinden çıkarılır (ST otomatik indirmeyi engellediği için PDF'ler elle indirilir).
  - Bağımlılıklar kendiliğinden eklenir (UART/ADC → DMA, EXTI → GPIO); işlemcide olmayan birim (ör. F411'de DAC) seçilemez.
- H7: linker betiğinde AXI SRAM (`RAM_D1`) ve `.dma_buffer` bölümü (DMA1/DMA2 DTCM'e erişemez); `ES_DMA_BUFFER` ile kullanılır.
- AGENTS.md bare-metal projelerde örnek sürücülerin yerini anlatır.
- Testler: derleme 54 varyant (her işlemcide 14 sürücünün tamamı + tüm API'leri çağıran dosya derlenir ve bağlanır), birim 49, arayüz 34 adım.

## 0.4.6 (önizleme)

- **15 STM32, 10 aile:** STM32F030C8, F103C8 (Blue Pill), F303RE, F407VG (Discovery), F411CE (Black Pill), F429ZI, F446RE, F767ZI, G071RB, G474RE, H723ZG, H743ZI, L432KC, L476RG, U575ZI-Q. Proje oluştururken ya da Ayarlar'dan seçilir.
- **İşlemci tanımları üretilir:** pinler ve alternatif fonksiyonlar ST'nin açık pin veritabanından (STM32_open_pin_data, BSD-3-Clause), saat açma bitleri ve kesme adları CMSIS cihaz başlıklarından `tools/mcu/gen-mcus.js` ile. Araç, elle doğrulanmış F411 tanımıyla karşılaştırarak kendini sınar (55/55 uyuşuyor).
- **Kod üretimi aileye göre** (`codegen/families.js`): çekirdek ve FPU bayrakları (`-mcpu=cortex-m0 … m33`, `fpv4-sp-d16` / `fpv5-d16` / `fpv5-sp-d16`), FreeRTOS portu (CM0, CM3, CM4F, CM33_NTZ), `stm32<aile>xx_it.c`, HAL conf, startup ve system dosyaları, HAL ya da CMSIS paketleri.
  - Bare-metal: aileye özgü saat kurulumu (RCC/PWR/FLASH), F1 GPIO (CRL/CRH, JTAG kapalı/SWD açık), TIMINGR tipi I2C (255 byte üstü dahil), FIFO'lu USART, H7/U5 SPI (TSIZE/CSTART), dört farklı ADC tipi, break'li timer'larda MOE.
  - HAL: aileye göre `SystemClock_Config` (PREDIV × PLLMUL, M/N/R, H7 PLL1 ve alan bölücüleri, U5 PLLMBOOST), I2C `Timing`, ADC başlatma ve kalibrasyon.
  - Yüksek frekans modları kendiliğinden: F429/F446/F767 over-drive, G474 boost, U575 EPOD. G0'da paylaşılan UART kesmesi (USART3_4) tek işleyicide.
- **Saat sekmesi aileye göre çizilir:** F4/F7 M/N/P/Q, F0/F1/F3 PREDIV × PLLMUL (F303xE'de HSI de PREDIV'den geçer), G0/G4/L4/U5 M/N/R, H7 DIVM1/N1/P1/Q1 (SPI1-3 çekirdek saati); F0/G0'da tek APB. Otomatik çözücü tüm modellerde çalışır. Çevre birimi tablosu çekirdek saatlerini doğru gösterir (F0/F3 I2C → HSI, H7 SPI1-3 → PLL1Q).
- **İşlemci ailesi değişince** kesme dosyası yeni adına taşınır ve içindeki USER CODE korunur; Ayarlar önizlemesi aile değişikliğini ve kartta doğrulanmamış tanımları belirtir.
- Derleme ayarlarında FPU seçimi işlemciye göre (M0/M0+/M3'te kapalı).
- Debug: F411 dışındaki işlemcilerde register görünümü için SVD dosyası bağlanınca otomatik indirilir; simülasyon F4'e özgü değerleri sadece F4'te gösterir.
- Derleme testi 53 varyant: 15 işlemcinin her biri HAL ve bare-metal, FreeRTOS'lu, sıkı uyarı + `-Werror` ile, en yüksek saatte. CI aile gruplarına bölünüp paralel çalışır.
- Bilinen sınırlar: F411 dışındaki işlemciler **gerçek kartta denenmedi**. H7 şimdilik VOS1 (400 MHz) ve LDO beslemesiyle. Nucleo kartlarında ST-LINK sanal seri portu (USART2/USART3) otomatik seçilmez.

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
