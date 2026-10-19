# Yol Haritası

Embedded Studio öğrenciler ve gömülü sistemlere yeni başlayanlar için bir tasarım aracı olarak başladı. Bundan sonraki hedef, aynı eklentinin **profesyonel ekiplerin** (savunma sanayii, havacılık, endüstriyel kontrol) günlük işini de görmesi:

- **Ana öncelik test ve debug:** kart algılama, tek tuşla flash, CubeIDE düzeyinde debug, seri terminal ve bootloader.
- **Profesyonel mod:** proje yapısı, CMake ve derleme ayarları tamamen kullanıcıda; araç yalnızca dosya ekler, kullanıcının koduna dokunmaz.
- **Acemi modu:** bugünkü görsel tasarım arayüzü (şema, otomatik pin/saat ataması) hatalarından arındırılarak öğrenciler için yardımcı araç olarak kalır.

Bu dosya yapılacaklar listesinin tek kaynağıdır. Her `###` başlığı GitHub'da bir issue olur ([Issues](https://github.com/k4zmo55/Embedded-Studio/issues)). `main` dalına bu dosyada değişiklik gönderildiğinde *Yol haritası → Issue* iş akışı eksik issue'ları, etiketleri ve kilometre taşlarını kendiliğinden oluşturur. Var olan issue'lara dokunmaz; tartışma ve ilerleme issue üzerinden yürür.

Yeni madde eklemek için doğru kilometre taşının altına aynı biçimde bir başlık ekleyin. Kimlik (`ES-xxx`) benzersiz olmalı ve sonradan değiştirilmemelidir.

---

## M1 · Proje temeli: çalışma modları ve proje yapısı
> Acemi/profesyonel ayrımı, HAL ve bare-metal için doğru klasör yapısı, kullanıcıya ait derleme sistemi ve yaygın STM32 cihaz paketleri.

### ES-101 · Acemi ve Profesyonel çalışma modu
`etiketler: tip:özellik, alan:arayüz, öncelik:yüksek, seviye:profesyonel`

Proje oluşturulurken kullanıcıya iki yol sunulmalı:

- **Acemi:** bugünkü görsel arayüz (komponent kütüphanesi, şema, otomatik pin/saat ataması, örnek kod üretimi).
- **Profesyonel:** sade, bilgi yoğun bir arayüz. Ana ekranlar Build / Flash / Debug / Terminal / Bellek / Register. Şema çizimi isteğe bağlı bir araç olarak kalır.

**Yapılacaklar**
- [ ] Proje sihirbazına mod seçimi ekle; seçim `embedded-studio.json` içinde saklansın.
- [ ] Mod sonradan *Proje Ayarları*ndan değiştirilebilsin.
- [ ] Profesyonel mod için görsel dil: VS Code temasıyla uyumlu, yoğun tablolar, kısayollar, karikatürsü çizim yok.
- [ ] Hangi panelin hangi modda görüneceğini belirleyen tek bir yapılandırma.

### ES-102 · MCU ve altyapı seçimi yalnızca proje oluşturulurken
`etiketler: tip:iyileştirme, alan:arayüz, öncelik:yüksek, seviye:hepsi`

Şu an MCU ve altyapı (HAL / bare-metal, RTOS) seçimi her sekmede tekrar görünüyor. Bu seçim projenin kimliğidir; bir kere yapılmalı.

- [ ] Seçimi sekmelerden kaldır; yalnızca proje sihirbazında sor.
- [ ] Sonradan değiştirmek için ayrı bir *Proje Ayarları* sekmesi oluştur. Değişiklikte etkilenen dosyaları göster ve onay iste.
- [ ] Üst çubukta yalnızca salt okunur bir özet (ör. `STM32F411CE · bare-metal · FreeRTOS`) kalsın.

### ES-103 · HAL ve bare-metal için ayrı proje klasör yapısı
`etiketler: tip:özellik, alan:kod-üretimi, öncelik:yüksek, seviye:profesyonel`

HAL projesi ile bare-metal projenin dosya ihtiyacı farklı. Bare-metal için yalnızca cihaz başlığı (`stm32f4xx.h`, `stm32f411xe.h`), `core_cm4.h` gibi CMSIS dosyaları, startup, linker script ve `system_*.c` yeterli.

- [ ] HAL şablonu: `Core/Inc`, `Core/Src`, `Drivers/STM32xx_HAL_Driver`, `Drivers/CMSIS` (CubeMX ile uyumlu).
- [ ] Bare-metal şablonu: `inc/`, `src/`, `startup/`, `linker/`, `cmsis/`, `drivers/` (yalnızca seçilen sürücüler).
- [ ] İki şablonun da CMake ile derlendiğini CI'da doğrula (`test/build.js`).
- [ ] Şablonların açıklaması README'ye eklensin.

### ES-104 · Bare-metal: kod üretimi yalnızca dosya ekler, main.c'ye dokunmaz
`etiketler: tip:özellik, alan:kod-üretimi, öncelik:yüksek, seviye:profesyonel`

Profesyonel kullanıcı kendi `main.c` / `app.c` dosyasını yazar. *Kod üret* yalnızca seçilen komponentlerin ve çevre birimlerinin sürücü dosyalarını (`drivers/bme280.c/.h` gibi) projeye eklemeli.

- [ ] Bare-metal + profesyonel modda `main.c`, `app.c` ve kullanıcı dosyaları hiç yazılmasın.
- [ ] Eklenecek/güncellenecek dosyaların listesi önce gösterilsin (önizleme ve fark).
- [ ] Var olan bir dosya kullanıcı tarafından değiştirilmişse üzerine yazılmasın; `.new` olarak bırakılsın veya birleştirme sunulsun.
- [ ] Sürücülerin nasıl çağrılacağını gösteren kısa bir örnek, kod olarak değil, sürücü başlığındaki yorumda yer alsın.

### ES-105 · Kullanıcının yönettiği CMake yapılandırması
`etiketler: tip:özellik, alan:derleme, öncelik:yüksek, seviye:profesyonel`

Kullanıcı kendi `CMakeLists.txt` dosyasını elle yönetebilmeli; araç bu dosyayı ezmemeli. İsteyen için aynı ayarlar bir arayüzden de düzenlenebilmeli.

- [ ] *CMake'i ben yönetiyorum* seçeneği: araç `CMakeLists.txt` dosyasına hiç yazmaz, yalnızca `cmake/embedded-studio.cmake` gibi ayrı bir dosya üretir ve bunun nasıl `include` edileceğini söyler.
- [ ] Derleme ayarları arayüzü: derleyici bayrakları, optimizasyon (`-O0/-Og/-O2/-Os`), `-D` tanımları, include yolları, linker script, `--specs` (nano/nosys), FPU/ABI, uyarı seviyesi.
- [ ] Debug / Release / MinSizeRel derleme tipleri ve `CMakePresets.json` üretimi.
- [ ] Araç zinciri seçimi: arm-none-eabi-gcc sürümü veya yolu, gerekirse Clang/LLVM.
- [ ] Derleme çıktısı: `.elf`, `.hex`, `.bin`, `.map` ve boyut özeti.

### ES-106 · En çok kullanılan 15 STM32 için cihaz paketleri
`etiketler: tip:özellik, alan:mcu, öncelik:yüksek, seviye:hepsi`

Şu an yalnızca STM32F411CEU6 tanımlı. Aşağıdaki işlemcilerin hem HAL hem bare-metal için gereken dosyaları (CMSIS cihaz başlığı, startup, linker script, `system_*.c`, SVD) ve pin/clock tanımları eklenmeli.

| İşlemci | Çekirdek | Neden |
|---|---|---|
| STM32F030C8 | M0 | Düşük maliyetli basit kontrolcüler |
| STM32F103C8 | M3 | Blue Pill, eğitimde en yaygın kart |
| STM32F303RE | M4F | Analog ön uç, motor kontrol |
| STM32F407VG | M4F | Discovery kartı, İHA uçuş kontrolcüleri |
| STM32F411CE | M4F | Black Pill (**mevcut**) |
| STM32F429ZI | M4F | LCD-TFT, harici SDRAM |
| STM32F446RE | M4F | Nucleo-64, genel amaçlı |
| STM32F767ZI | M7 | Çift hassasiyetli FPU, Ethernet |
| STM32H743ZI | M7 | Yüksek performans: sinyal işleme, radar ve görüntü |
| STM32H723ZG | M7 | 550 MHz, maliyet odaklı H7 |
| STM32G071RB | M0+ | Endüstriyel giriş seviyesi, USB-PD |
| STM32G474RE | M4F | Yüksek çözünürlüklü zamanlayıcı, güç elektroniği |
| STM32L432KC | M4F | Düşük güç, küçük kılıf |
| STM32L476RG | M4F | Düşük güç, pille çalışan cihazlar |
| STM32U575ZI | M33 | TrustZone, güvenli uygulamalar |

- [ ] Her işlemci için `data/mcus/<id>.json` (pinler, alternatif fonksiyonlar, clock ağacı, bellek haritası).
- [ ] Paket indirme/önbellekleme (`src/codegen/packs.js`) tüm aileleri desteklesin.
- [ ] Her işlemci için CI'da en az bir HAL ve bir bare-metal derlemesi.
- [ ] İşlemci başına bir issue açılarak ilerlenebilir (`good first issue` adayı).

### ES-107 · Register seviyesinde örnek çevre birimi sürücüleri
`etiketler: tip:özellik, alan:kod-üretimi, öncelik:orta, seviye:profesyonel`

Bare-metal kullanıcı için yalnızca cihaz başlığına (`stm32xxxx.h`) bağımlı, okunabilir ve kopyalanıp değiştirilebilir örnek sürücüler.

- [ ] RCC / clock kurulumu, GPIO, EXTI
- [ ] UART (polling, kesme, DMA), SPI, I2C
- [ ] TIM (PWM, input capture, encoder), ADC (tek ve DMA ile tarama), DAC
- [ ] DMA, IWDG/WWDG, CRC birimi, FLASH yazma/silme
- [ ] Her sürücü için kısa açıklama ve ilgili reference manual bölüm numarası
- [ ] Aile farkları (F1 ve F4 GPIO yapısı gibi) için açık `#if` blokları veya aileye göre ayrı dosyalar

### ES-108 · Derleme temiz olduğu halde editörde onlarca hata (RCC tanımsız)
`etiketler: tip:hata, alan:derleme, öncelik:yüksek, seviye:hepsi`

2026-10-17: STM32F407 + register + FreeRTOS projesinde (0.4.x'ten yükseltilmiş) Sorunlar panelinde 55 hata: `use of undeclared identifier 'RCC'`, `'board.h' file not found` gibi. `cmake --build build/debug` hatasız geçiyor; hatalar derleyiciden değil, editörün dil sunucusundan (clangd / C/C++ IntelliSense) geliyor.

**Kök neden:** üretilen proje editöre derleme veritabanının yerini söylemiyor. CMake `compile_commands.json`'u `build/<tip>/` altına yazıyor; clangd ise varsayılan olarak `build/compile_commands.json`'a bakıyor. Yükseltilen projede orada 0.4.x'ten kalma eski veritabanı (eski `Core/` yapısı, `src/*.c` yok) duruyor; clangd `src/` dosyaları için komutu tahmin ediyor, `-DSTM32F407xx` ve include yolları gelmiyor. Yeni projede ise veritabanı hiç bulunamıyor. Ayrıca `-fcallgraph-info=su` clang tarafından tanınmıyor.

- [ ] `.clangd`: `CompilationDatabase: build/<tip>`, clang'ın bilmediği gcc bayrakları (`-fcallgraph-info`, `-fstack-usage`) çıkarılır; derleme tipi değişince güncellenir, kullanıcının kendi `.clangd` dosyasına dokunulmaz
- [ ] `.vscode/settings.json`: `C_Cpp.default.compileCommands` (Microsoft C/C++ eklentisi için); kullanıcının farklı değerine dokunulmaz
- [ ] Kod Üret'ten sonra derleme klasörü yoksa arka planda yalnızca CMake yapılandırması (derlemeden önce de IntelliSense doğru)
- [ ] Birim testleri; clangd `--check` ile üretilen projede sıfır hata

### ES-109 · Farklı işlemci ve altyapılarla yeni proje matris testi
`etiketler: tip:iyileştirme, alan:kalite, öncelik:yüksek, seviye:hepsi`

ES-108'deki hatanın yalnızca yükseltilen projede mi yoksa sıfırdan oluşturulan projede de mi çıktığı ve farklı işlemci/başlatma şekillerinde tekrarlanıp tekrarlanmadığı kontrol edilmeli.

- [ ] Sıfırdan yeni proje: en az F0/F1/F4/G0/G4/L4/H7 ailelerinden işlemciler
- [ ] Her biri için HAL, bare-metal (register) acemi ve profesyonel mod, FreeRTOS açık/kapalı
- [ ] Her varyantta: CMake derlemesi hatasız, clangd `--check` ile bütün kaynak ve başlıklarda sıfır hata
- [ ] Matris otomatik test olarak (`test/intellisense.js`), sonuç tablosu bu issue'ya

---

## M2 · Test ve debug (ana öncelik)
> Kartı tanıma, tek tuşla flash, STM32CubeIDE düzeyinde debug, seri terminal ve derleme analizi.

### ES-201 · Alt durum çubuğunda Build / Flash / Debug / Run butonları
`etiketler: tip:özellik, alan:debug, öncelik:yüksek, seviye:hepsi`

VS Code'un en altındaki mavi durum çubuğuna tek tıkla çalışan butonlar:

- [ ] **Build** (derleme, hata/uyarı sayısı)
- [ ] **Flash** (derle ve yükle)
- [ ] **Debug** (derle, yükle, `main`'de dur)
- [ ] **Run** (derle, yükle ve debugger olmadan çalıştır)
- [ ] **Terminal** (seri terminali aç)
- [ ] Bağlı prob ve kart bilgisi (ör. `ST-Link V2-1 · STM32F411CE`); tıklayınca ayrıntı açılsın
- [ ] Butonlar için komut paleti girdileri ve klavye kısayolları (F5, Ctrl+F5 gibi)

### ES-202 · Prob ve kart algılama
`etiketler: tip:özellik, alan:debug, öncelik:yüksek, seviye:hepsi`

STM32CubeProgrammer'daki gibi kart takıldığında kendiliğinden tanınmalı.

- [ ] Bağlı probları listele: ST-Link (V2/V3), J-Link, CMSIS-DAP, USB DFU, UART bootloader.
- [ ] Prob bilgisi: tür, seri numarası, firmware sürümü, hedef voltajı.
- [ ] Hedef bilgisi: `DBGMCU_IDCODE` ile cihaz ve revizyon, flash boyutu, 96 bit benzersiz kimlik (UID), okuma koruması (RDP) seviyesi.
- [ ] Projedeki MCU ile bağlı MCU farklıysa uyarı.
- [ ] Araç algılama: STM32_Programmer_CLI, OpenOCD, pyOCD, st-flash. Yoksa nasıl kurulacağını göster.
- [ ] Kart çıkarılıp takılınca durum çubuğu güncellensin.

### ES-203 · Tek tuşla flash
`etiketler: tip:özellik, alan:flash, öncelik:yüksek, seviye:hepsi`

Elle komut yazmadan (`STM32_Programmer_CLI -c port=SWD -w ...` gibi) yükleme.

- [ ] `.elf` / `.hex` / `.bin` yükleme (`.bin` için adres sorulsun)
- [ ] Seçenekler: tam silme / sektör silme, doğrulama (verify), yükleme sonrası reset
- [ ] İlerleme çubuğu, süre ve hız bilgisi; anlaşılır hata mesajları (prob yok, hedef bağlı değil, RDP aktif...)
- [ ] Bağlantı modları: normal, *under reset*, düşük hız (SWD frekansı ayarı)
- [ ] Kullanılan komut çıktı panelinde gösterilsin (öğretici ve hata ayıklamaya yardımcı)

### ES-204 · VS Code debug entegrasyonu ve mevcut debug panelinin kontrolü
`etiketler: tip:özellik, alan:debug, öncelik:yüksek, seviye:hepsi`

VS Code'un kendi debug arayüzü (breakpoint, adım adım çalıştırma, call stack, değişkenler, watch, disassembly) STM32CubeIDE ve Eclipse ile aynı rahatlıkta çalışmalı.

- [ ] `launch.json` üretimi veya doğrudan debug adapter (OpenOCD / ST-LINK GDB server / pyOCD + GDB)
- [ ] Koşullu breakpoint, hit count, logpoint; donanım breakpoint sınırı uyarısı
- [ ] Step over / into / out, run to cursor, reset and halt
- [ ] Disassembly görünümü ve kaynakla karışık gösterim
- [ ] Mevcut debug panelindeki eksik ve hataların listelenip düzeltilmesi (`src/debug/session.js`, `media/debug.js`)
- [ ] Gerçek kartla (ST-Link + Nucleo / Black Pill) uçtan uca test

### ES-205 · SVD tabanlı çevre birimi register görünümü
`etiketler: tip:özellik, alan:debug, öncelik:yüksek, seviye:profesyonel`

- [ ] Her işlemci için SVD dosyasından çevre birimi ağacı (RCC, GPIOA, USART2...)
- [ ] Bit alanları adlarıyla ve açıklamalarıyla; değişen değerler vurgulansın
- [ ] Register ve bit alanı düzenleme (yazma)
- [ ] Çekirdek registerları: R0–R15, xPSR, MSP/PSP, CONTROL, FPU registerları
- [ ] Sık bakılanları sabitleme (favori registerlar)

### ES-206 · Bellek görüntüleyici ve canlı izleme (Live Watch)
`etiketler: tip:özellik, alan:debug, öncelik:orta, seviye:profesyonel`

- [ ] Hex/ASCII bellek görüntüleyici; adres veya sembolle gitme; 8/16/32 bit görünüm
- [ ] Bellekte değer düzenleme, bölgeyi dosyaya kaydetme
- [ ] Live watch: işlemci durdurulmadan global değişkenlerin periyodik okunması
- [ ] Live watch değerlerinin zaman grafiği (monitördeki grafik bileşeni yeniden kullanılabilir)

### ES-207 · HardFault analizörü
`etiketler: tip:özellik, alan:debug, öncelik:yüksek, seviye:hepsi`

STM32CubeIDE'deki *Fault Analyzer* eşdeğeri.

- [ ] Fault anında CFSR, HFSR, MMFAR, BFAR, SHCSR okunup anlamlı cümlelere çevrilsin (ör. "Hizalanmamış erişim", "Geçersiz adrese yazma")
- [ ] Yığından PC, LR ve xPSR çıkarılıp kaynak satıra gidilsin
- [ ] MSP/PSP ayrımı (RTOS görevinde mi oldu?)
- [ ] Olası nedenler ve kontrol listesi; isteğe bağlı olarak yapay zekâ yorumu (ES-703)

### ES-208 · SWO/ITM, RTT ve semihosting konsolu
`etiketler: tip:özellik, alan:debug, öncelik:orta, seviye:profesyonel`

- [x] SWV/ITM üzerinden `printf` (port seçimi, SWO frekansı)
- [x] SEGGER RTT kanalı okuma/yazma
- [x] Semihosting çıktısı
- [x] SWV veri izleme (data trace) ve istatistiksel profil (PC örnekleme), mümkün olan çekirdeklerde

### ES-209 · FreeRTOS farkındalıklı debug
`etiketler: tip:özellik, alan:debug, öncelik:orta, seviye:profesyonel`

- [x] Görev listesi: durum, öncelik, stack kullanımı ve tepe değeri, CPU yüzdesi
- [x] Kuyruklar, semaforlar, mutexler, zamanlayıcılar
- [x] Durdurulmuş bir görevin call stack'ine geçiş
- [x] Stack taşması ve heap tükenmesi uyarıları

### ES-210 · Bellek kullanım raporu (Build Analyzer)
`etiketler: tip:özellik, alan:derleme, öncelik:orta, seviye:hepsi`

- [x] `.map` / `.elf` analizi: bölge bazında Flash ve RAM kullanımı (yüzde ve bayt)
- [x] Bölüm (section) ve sembol listesi, boyuta göre sıralama, kaynağa gitme
- [x] Önceki derlemeye göre değişim (hangi fonksiyon büyüdü)
- [x] Stack kullanımı tahmini (`-fstack-usage` çıktısı)

### ES-211 · Seri port terminali (Tera Term benzeri)
`etiketler: tip:özellik, alan:terminal, öncelik:yüksek, seviye:hepsi`

Harici programa (Tera Term, PuTTY, RealTerm) gerek kalmamalı.

- [x] Port listesi ve kendiliğinden yenileme; baud, veri biti, parite, stop biti, akış kontrolü
- [x] ASCII, HEX ve karışık görünüm; zaman damgası; satır sonu seçimi (CR, LF, CRLF)
- [x] Gönderme kutusu, geçmiş, tekrarlı gönderme, kayıtlı komut/makro butonları
- [x] Log dosyasına kaydetme (metin veya ham), oturumu temizleme, arama
- [x] Birden fazla port aynı anda (ayrı sekmeler)
- [x] Teknik not: Node `serialport` yerel modül gerektirir; platform başına hazır derlenmiş paket mi kullanılacak, yoksa bir yardımcı süreç mi, kararı verilmeli
  - **Karar (0.6.0):** yardımcı süreç. Windows'ta PowerShell içinde derlenen küçük bir C# yardımcısı (.NET `System.IO.Ports`, her Windows'ta hazır; stdin/stdout satır protokolü), Linux/macOS'ta `stty` ile ayarlanan aygıt dosyası doğrudan Node'dan. Yerel modül her VS Code/Electron sürümünde yeniden derlenmiş ikili ister ve VSIX'i platforma bağlar; bu yolla eklenti tek paket kalır. Bedeli: Windows'ta port açılışı ~0,6 sn; Linux/macOS'ta DTR/RTS ve break yok.

---

## M3 · Bootloader ve güvenli güncelleme
> STM32CubeProgrammer'ın programlama özellikleri ve CRC/imza doğrulamalı güvenli bootloader.

### ES-301 · Flash programlayıcı arayüzü
`etiketler: tip:özellik, alan:flash, öncelik:yüksek, seviye:profesyonel`

- [ ] Bağlan / bağlantıyı kes; bağlantı türü (SWD, JTAG, UART, USB DFU)
- [ ] Flash ve RAM okuma, dosyaya kaydetme, dosyayla karşılaştırma
- [ ] Sektör/sayfa listesi; seçili sektörleri silme, tam silme
- [ ] Option bytes görüntüleme ve düzenleme: RDP seviyesi, WRP/PCROP, BOR, boot ayarları (yanlışlıkla RDP 2'ye geçişe karşı çift onay)
- [ ] İşlem günlüğü

### ES-306 · Option byte yazma: RDP, WRP/PCROP, BOR, boot
`etiketler: tip:özellik, alan:flash, öncelik:yüksek, seviye:profesyonel`

ES-301'de option byte'lar yalnızca okunup gösteriliyor (F0/F1/F3/F4/F7/G0/G4/L4/U5/H7). Yazma, kart üzerinde denenmeden yayınlanmamalı: yanlış RDP ya da WRP kartı kilitleyebilir.

- [ ] Aileye göre yazma sırası (OPTKEYR kilidi açma, OPTCR/OPTR yazma, OPTSTRT, BSY bekleme, OBL_LAUNCH ya da reset); F0/F1/F3'te option byte alanını silip yeniden yazma
- [ ] Programlayıcı sekmesinde düzenleme: RDP seviyesi, sektör/sayfa bazında WRP, BOR seviyesi, kullanıcı bitleri, boot adresleri; değişiklik önizlemesi
- [ ] RDP 1 → 0 geçişinin flash'ı tamamen sileceği uyarısı; RDP 2'ye geçişte çift onay (işlemci adını yazdırma)
- [ ] Her ailede en az bir kartla deneme (Nucleo/Discovery); denenmeyen aileler salt okunur kalır

### ES-302 · ST sistem bootloader'ı üzerinden yükleme (UART / USB DFU)
`etiketler: tip:özellik, alan:flash, öncelik:orta, seviye:hepsi`

ST-Link olmadan, yongadaki sistem bootloader'ı ile yükleme.

- [ ] UART protokolü (AN3155): bağlanma, get ID, okuma, yazma, silme, go
- [ ] USB DFU (AN3156)
- [ ] BOOT0 / reset ile bootloader'a girme talimatları, karta göre
- [ ] Desteklenen işlemcilerde CAN / I2C / SPI bootloader (AN2606 tablosu)

### ES-307 · CAN / I2C / SPI sistem bootloader'ı (köprü üzerinden)
`etiketler: tip:özellik, alan:flash, öncelik:düşük, seviye:profesyonel`

ES-302'de UART ve USB DFU var; AN2606'daki CAN, I2C ve SPI arayüzleri Programlayıcı'da yalnızca pin tablosu olarak gösteriliyor. Bunlar bilgisayardan doğrudan sürülemez, bir köprü gerekir.

- [ ] Köprü seçenekleri: ikinci bir STM32 (Embedded Studio'nun ürettiği köprü firmware'i, USB CDC ↔ I2C/SPI/CAN) ya da piyasadaki USB-I2C/SPI/CAN dönüştürücüler
- [ ] AN4221 (I2C), AN4286 (SPI), AN3154 (CAN) protokolleri; UART istemcisiyle aynı komut katmanı
- [ ] Sahada (kart kutudayken) güncelleme senaryosu için belge

### ES-303 · Güvenli bootloader şablonu: imaj başlığı ve CRC32
`etiketler: tip:özellik, alan:bootloader, öncelik:yüksek, seviye:profesyonel`

Projeye eklenebilir, kendi bootloader'ını yazmak isteyene temel olacak bir şablon.

- [ ] Flash bölümleme: bootloader + uygulama bölgesi; linker script'lerin buna göre üretilmesi
- [ ] İmaj başlığı: sihirli sayı, sürüm, boyut, CRC32, derleme kimliği
- [ ] Açılışta CRC32 doğrulaması (yazılım ve donanım CRC birimi)
- [ ] Uygulamaya atlama (vektör tablosu, MSP, VTOR)
- [ ] UART veya USB üzerinden güncelleme komutları; her paket için CRC ve onay (ACK/NACK)
- [ ] Watchdog ve güncelleme yarıda kesilirse güvenli geri dönüş

### ES-304 · İmza doğrulama, A/B slot ve geri dönüş koruması
`etiketler: tip:özellik, alan:bootloader, öncelik:orta, seviye:profesyonel`

- [x] İmza doğrulama (ECDSA P-256 veya Ed25519); açık anahtar bootloader'a gömülü — Ed25519 (0.6.5)
- [x] A/B slot: yeni imaj doğrulanmadan eskisi silinmesin — hazırlık yuvası + doğrulanınca kopyalama, kesintide açılışta tamamlama
- [x] Sürüm sayacı ile rollback koruması — ana yuvadaki sürüm ve gömülü en düşük sürüm
- [x] RDP/WRP ile bootloader bölgesinin korunması önerisi
- [x] İsteğe bağlı: MCUboot ile uyumluluk değerlendirmesi — overwrite-only + downgrade prevention'a denk; biçim/protokol farklı (CHANGELOG 0.6.5)
- [ ] Swap kipi: eski imajı saklayıp yeni imaj onaylanmazsa (deneme açılışı) geri dönme

### ES-305 · İmaj paketleme ve imzalama aracı
`etiketler: tip:özellik, alan:bootloader, öncelik:orta, seviye:profesyonel`

- [ ] Derleme sonrası `.bin` dosyasına başlık ve CRC32 ekleme
- [ ] Anahtar üretme ve imzalama (özel anahtar yalnızca kullanıcının makinesinde) — kısmen: ES-304'te anahtar üretme / içe-dışa aktarma ve Programlayıcı'da gönderirken imzalama var; derleme sonrası imzalı `.bin` / `_full.hex` üretimi yok
- [ ] Eklenti içinden bootloader'a güncelleme gönderme (ES-303 protokolü)

---

## M4 · Monitör ve arayüz tasarımcısı
> Qt Designer benzeri düzenlenebilir monitör ve tasarımın Python Qt uygulaması olarak dışa aktarılması.

### ES-401 · Sürükle-bırak monitör tasarımcısı
`etiketler: tip:özellik, alan:monitör, öncelik:orta, seviye:hepsi`

Monitör ekranı Qt Designer'daki gibi serbestçe tasarlanabilmeli.

- [ ] Bileşenler: buton, etiket, metin kutusu, sayı kutusu, kaydırıcı, onay kutusu, açılır liste, LED, gösterge (gauge), çizgi grafik, tablo, 3B tutum göstergesi
- [ ] Sürükle-bırak yerleşim, hizalama kılavuzları, ızgara ve serbest yerleşim
- [ ] Özellik paneli: ad, metin, aralık, birim, renk, bağlı kanal veya komut
- [ ] Bileşen ile kart arasındaki bağ: telemetri kanalı → gösterge; buton/metin kutusu → karta komut
- [ ] Tasarımın projeye `monitor.json` olarak kaydedilmesi

### ES-402 · Monitör tasarımını PySide6 / PyQt olarak dışa aktarma
`etiketler: tip:özellik, alan:monitör, öncelik:orta, seviye:profesyonel`

- [ ] Qt Designer ile açılabilen `.ui` dosyası
- [ ] Çalıştırılabilir Python uygulaması: pyserial ile bağlantı, protokol ayrıştırma, grafikler (pyqtgraph)
- [ ] `requirements.txt` ve çalıştırma talimatı
- [ ] PySide6 ve PyQt5/6 seçeneği

### ES-403 · Kart–PC haberleşme protokolü
`etiketler: tip:özellik, alan:monitör, öncelik:orta, seviye:profesyonel`

Bugünkü `$V,kanal,değer` metin protokolü başlangıç için yeterli; profesyonel kullanım için daha sağlam bir seçenek gerekli.

- [ ] İkili (binary) çerçeve: başlangıç baytı, uzunluk, tür, yük, CRC16/CRC32 (COBS veya SLIP ile)
- [ ] Komut / yanıt ve telemetri mesajları; mesaj tanımlarından C ve Python kodu üretimi
- [ ] Metin protokolüyle geriye uyumluluk
- [ ] Protokol belgesi

---

## M5 · MCU bilgisi, dokümantasyon ve clock
> İşlemci bilgi kartı, datasheet/RM erişimi, kodda register ipuçları ve clock arayüzünün düzeltilmesi.

### ES-501 · İşlemci bilgi kartı
`etiketler: tip:özellik, alan:arayüz, öncelik:orta, seviye:hepsi`

Komponentlerde olduğu gibi işlemcinin üzerine gelince açılan kart.

- [ ] Çekirdek, azami frekans, Flash/RAM, kılıf, çalışma gerilimi, sıcaklık aralığı
- [ ] Çevre birimi sayıları (UART, SPI, I2C, CAN, ADC kanalı, zamanlayıcı...)
- [ ] Pin üzerine gelince pinin tüm alternatif fonksiyonları ve 5 V toleransı

### ES-502 · Datasheet, reference manual ve kodda register ipuçları
`etiketler: tip:özellik, alan:dokümantasyon, öncelik:orta, seviye:profesyonel`

- [ ] Her işlemci için datasheet, reference manual, programming manual, errata ve kart kullanım kılavuzu bağlantıları
- [ ] C kodunda `RCC->AHB1ENR` gibi ifadelerin üzerine gelince register açıklaması ve bit alanları (SVD'den)
- [ ] `GPIO_MODER_MODER5_0` gibi makrolar için değer ve anlam
- [ ] İlgili reference manual bölümüne bağlantı

### ES-503 · Clock arayüzünün doğrulanması ve hata düzeltme
`etiketler: tip:hata, alan:clock, öncelik:yüksek, seviye:hepsi`

Clock arayüzü bazı durumlarda doğru çalışmıyor gibi görünüyor; baştan sona kontrol edilmeli.

- [ ] PLL giriş/VCO/çıkış sınırları her aile için doğru mu?
- [ ] USB/SDIO için 48 MHz şartı, APB bölücüleri ve zamanlayıcı clock çarpanı (×2 kuralı)
- [ ] Flash bekleme durumu (latency) ve voltaj ölçeği önerisi
- [ ] HSE/HSI/LSE seçimleri ve harici kristal değeri
- [ ] Sonuçların CubeMX ile karşılaştırılması (her işlemci için birkaç senaryo, otomatik test)
- [ ] Arayüzde hatalı değerlerin net gösterimi ve düzeltme önerisi

---

## M6 · Komponent kütüphanesi
> Açık kaynak katkısıyla büyüyecek sensör ve modül desteği. Sektörde yaygın parçalar öncelikli.

### ES-601 · Geliştirici notu: yeni komponent / sensör kütüphanesi nasıl eklenir
`etiketler: tip:dokümantasyon, alan:kütüphane, öncelik:yüksek, seviye:hepsi, good first issue`

Katkıcıların yeni sensör ekleyebilmesi için ayrıntılı bir `docs/DEVELOPER.md`.

- [ ] Komponent tanım dosyasının (`data/components/*.json`) tüm alanları: pinler, arayüz, telemetri kanalları, çizim
- [ ] Sürücü şablonu: HAL ve bare-metal sürümü, isimlendirme, hata döndürme kuralları
- [ ] Mantık gerektiren komponentler için JS eklenti biçimine ihtiyaç var mı? (register yapılandırması hesaplama gibi) Karar ve örnek.
- [ ] Baştan sona örnek: yeni bir I2C sensörün eklenmesi, test edilmesi, PR açılması
- [ ] Komponent oluşturucu ile hazırlanan komponentin repoya katkı olarak gönderilmesi

### ES-602 · Ataletsel sensörler (IMU)
`etiketler: tip:komponent, alan:kütüphane, öncelik:yüksek, seviye:hepsi`

- [ ] ICM-42688-P (6 eksen, düşük gürültü)
- [ ] BMI088 (titreşime dayanıklı, İHA)
- [ ] LSM6DSO (6 eksen)
- [ ] ADIS16470 (endüstriyel IMU, SPI)
- [ ] MPU-9250 / ICM-20948 (9 eksen)
- [x] MPU-6050 (mevcut)

### ES-603 · Basınç, sıcaklık ve nem sensörleri
`etiketler: tip:komponent, alan:kütüphane, öncelik:orta, seviye:hepsi`

- [ ] BMP390 ve MS5611 (barometrik irtifa)
- [ ] LPS22HB
- [ ] TMP117 (±0,1 °C hassas sıcaklık)
- [ ] SHT45
- [ ] MAX31865 (PT100/PT1000) ve MAX31856 (termokupl)
- [x] BME280 (mevcut)

### ES-604 · Navigasyon: GNSS ve manyetometre
`etiketler: tip:komponent, alan:kütüphane, öncelik:orta, seviye:hepsi`

- [ ] u-blox NEO-M9N ve ZED-F9P (UBX protokolü, RTK)
- [ ] RM3100 ve LIS3MDL (manyetometre)
- [ ] QMC5883L / HMC5883L
- [x] NEO-6M (mevcut, NMEA)

### ES-605 · Güç ölçümü, ADC ve DAC
`etiketler: tip:komponent, alan:kütüphane, öncelik:orta, seviye:hepsi`

- [ ] INA226, INA228, INA3221 (akım/gerilim/güç)
- [ ] ADS1115 (16 bit), ADS131M04 (24 bit eşzamanlı), AD7606 (8 kanal eşzamanlı)
- [ ] MCP4725 ve DAC8552

### ES-606 · Haberleşme modülleri
`etiketler: tip:komponent, alan:kütüphane, öncelik:yüksek, seviye:hepsi`

- [ ] Dahili CAN/FDCAN + SN65HVD230 / TJA1051 alıcı-verici; MCP2515 (SPI-CAN)
- [ ] RS-485: MAX485 / THVD1450, Modbus RTU örneği
- [ ] Ethernet: W5500 (SPI), LAN8742 (RMII, dahili MAC'li işlemcilerde)
- [ ] RF: SX1276/SX1262 (LoRa), nRF24L01+
- [ ] RS-422 ve MIL-STD-1553 için arayüz değerlendirmesi (savunma uygulamaları)

### ES-607 · Kalıcı bellekler
`etiketler: tip:komponent, alan:kütüphane, öncelik:orta, seviye:hepsi`

- [ ] W25Q128 / W25Q256 (SPI ve QSPI)
- [ ] FM25V10 / MB85RS (FRAM)
- [ ] AT24Cxx (EEPROM)
- [ ] microSD (SPI ve SDIO) + FatFs
- [x] W25Q32 (mevcut)

### ES-608 · Motor sürücüler ve aktüatörler
`etiketler: tip:komponent, alan:kütüphane, öncelik:düşük, seviye:hepsi`

- [ ] DRV8825 / TMC2209 (step motor)
- [ ] DRV8871 / BTS7960 (DC motor)
- [ ] ESC (PWM / DShot)
- [ ] Artımlı enkoder (zamanlayıcı encoder modu)
- [x] SG90 servo (mevcut)

### ES-609 · Ekranlar, RTC ve güvenlik elemanı
`etiketler: tip:komponent, alan:kütüphane, öncelik:düşük, seviye:hepsi`

- [ ] ST7735 / ILI9341 (SPI TFT)
- [ ] DS3231 / RV-3028 (RTC)
- [ ] ATECC608 (kriptografik güvenlik elemanı; ES-304 ile bağlantılı)
- [ ] VL53L1X (ToF mesafe)
- [x] SSD1306 (mevcut)

---

## M7 · Yapay zekâ asistanı
> Kodlama ve hata ayıklamada bağlamı bilen asistan; bulut veya tamamen çevrimdışı.

### ES-701 · DeepSeek sağlayıcısı ve sağlayıcı katmanı
`etiketler: tip:özellik, alan:yapay-zeka, öncelik:orta, seviye:hepsi`

Not: DeepSeek API'si ücretsiz değil; kullandıkça ödenen, düşük ücretli bir hizmet. Her kullanıcı kendi API anahtarını girmeli (eklentiye anahtar gömülmez). API OpenAI ile uyumlu olduğundan aynı katman başka sağlayıcıları da destekleyebilir.

- [ ] Sağlayıcı katmanı: DeepSeek (`deepseek-chat`, `deepseek-reasoner`), OpenAI uyumlu herhangi bir uç nokta
- [ ] API anahtarı VS Code SecretStorage'da saklansın; ayarlarda veya dosyada düz metin olarak durmasın
- [ ] Hangi verinin gönderileceğinin açıkça gösterilmesi ve onay; varsayılan olarak kapalı
- [ ] Mevcut asistanın (`src/ai/advisor.js`) bu katmana taşınması

### ES-702 · Çevrimdışı yerel model desteği (Ollama)
`etiketler: tip:özellik, alan:yapay-zeka, öncelik:yüksek, seviye:profesyonel`

Savunma sanayii ve kapalı ağlarda kod dışarıya gönderilemez. Asistan internet olmadan da çalışabilmeli.

- [ ] Ollama / llama.cpp / LM Studio gibi yerel OpenAI uyumlu sunucularla çalışma
- [ ] Önerilen yerel modeller ve donanım gereksinimi
- [ ] *Kurumsal mod*: dış sağlayıcıları tamamen kapatan ayar

### ES-703 · Bağlam farkındalığı olan yardım
`etiketler: tip:özellik, alan:yapay-zeka, öncelik:orta, seviye:hepsi`

- [ ] Derleme hatalarını açıklama ve düzeltme önerisi
- [ ] HardFault kaydını (ES-207) ve register dökümünü yorumlama
- [ ] Projenin MCU, pin ve clock bilgisini bağlam olarak kullanma
- [ ] Reference manual'den ilgili bölümü bulma (ES-502)

---

## M8 · Acemi arayüzü: hata ve eksikler
> Bugünkü görsel tasarım arayüzünün öğrenciler için sorunsuz hale getirilmesi.

### ES-801 · Acemi arayüzünün hata taraması
`etiketler: tip:hata, alan:arayüz, öncelik:orta, seviye:acemi`

Bulunan her hata bu issue'ya yorum olarak eklenip gerekirse ayrı issue açılmalı.

- [ ] Sihirbaz, tasarım, bağlantılar, komponent oluşturucu, clock, monitör ve debug ekranlarının elle gözden geçirilmesi
- [ ] Farklı tema (açık/koyu/yüksek kontrast) ve pencere boyutlarında görünüm
- [ ] Geri al / yinele, kaydetme ve yeniden açma tutarlılığı
- [ ] Hata mesajlarının anlaşılır ve Türkçe/İngilizce tutarlı olması

### ES-802 · Komponent oluşturucu: düzenleme ve kopya kaydetme akışı
`etiketler: tip:hata, alan:arayüz, öncelik:orta, seviye:acemi`

Arayüz testinin kayıt modunda (`ES_RECORD`) *sağ tık → düzenle → kopyasını düzenle* adımı kopya dosyası oluşmadan zaman aşımına uğruyor. Normal test geçiyor; sorunun testte mi yoksa zamanlamaya bağlı gerçek bir hatada mı olduğu araştırılmalı.

- [ ] Sorunu yeniden üret (`test/ui-e2e.js`, kayıt modu)
- [ ] Kopya dosyasının yazıldığı yolu ve olay sırasını kontrol et
- [ ] Gerekirse düzelt ve testi kararlı hale getir

### ES-803 · İngilizce arayüz desteği
`etiketler: tip:özellik, alan:arayüz, öncelik:düşük, seviye:hepsi`

Uluslararası katkı ve kullanım için arayüz metinlerinin çevrilebilir olması.

- [ ] Metinlerin tek bir sözlük dosyasında toplanması
- [ ] VS Code dil ayarına göre Türkçe / İngilizce

### ES-804 · Ayarlar: arayüz sekmelerini gizleme ve geri getirme
`etiketler: tip:özellik, alan:arayüz, öncelik:orta, seviye:hepsi`

Kullanıcı kullanmadığı sekmeleri (ör. Monitör, Bellek raporu) üst çubuktan gizleyebilmeli, istediğinde geri getirebilmeli.

- [ ] Ayarlar sekmesinde "Görünen sekmeler" bölümü: her sekme için aç/kapat, varsayılana dön
- [ ] Ayarlar sekmesi gizlenemez (geri getirmenin yolu kaybolmasın); en az bir çalışma sekmesi açık kalır
- [ ] Seçim kullanıcı başına hatırlanır (bütün projelerde geçerli), çalışma moduna (acemi / profesyonel) göre ayrı
- [ ] Gizli sekmenin kısayolu (Alt+1…9) atlanır; gizli sekme etkinken gizlenirse ana sekmeye geçilir
- [ ] Birim ve arayüz testi

---

## M9 · Profesyonel kalite ve güvence
> Savunma ve endüstri projelerinin beklediği kod kalitesi, test ve izlenebilirlik.

### ES-901 · Statik analiz ve MISRA C kontrolü
`etiketler: tip:özellik, alan:kalite, öncelik:orta, seviye:profesyonel`

- [ ] cppcheck (MISRA eklentisi) ve clang-tidy entegrasyonu; sonuçlar VS Code *Problems* panelinde
- [ ] Üretilen sürücülerin MISRA C:2012 kurallarına uygunluk raporu
- [ ] Kural sapmalarının belgelenmesi (deviation kayıtları)

### ES-902 · Birim test ve donanımlı (HIL) test altyapısı
`etiketler: tip:özellik, alan:kalite, öncelik:orta, seviye:profesyonel`

- [ ] Unity / CMock ile PC üzerinde sürücü testleri; şablon ve çalıştırma butonu
- [ ] Kart üzerinde test: test firmware'ini yükle, sonuçları seri/RTT üzerinden topla
- [ ] Kod kapsamı (gcov) raporu
- [ ] CI'da test çalıştırma örneği

### ES-903 · Çevrimdışı (air-gapped) kurulum
`etiketler: tip:özellik, alan:derleme, öncelik:orta, seviye:profesyonel`

- [ ] HAL, CMSIS ve FreeRTOS paketlerinin internetsiz kurulabilen bir arşivle dağıtılması
- [ ] Paketlerin yerel klasörden veya kurum içi sunucudan alınması
- [ ] İndirilen paketlerin özet (SHA-256) doğrulaması

### ES-904 · Sürüm bilgisi ve tekrarlanabilir derleme
`etiketler: tip:özellik, alan:derleme, öncelik:düşük, seviye:profesyonel`

- [ ] Firmware'e sürüm, git commit ve derleme tarihi gömülmesi
- [ ] Aynı kaynaktan aynı ikili dosya (tekrarlanabilir derleme ayarları)
- [ ] Yazılım malzeme listesi (SBOM): kullanılan HAL/CMSIS/FreeRTOS sürümleri

---

## M10 · Pinout ve Configuration (CubeMX tarzı)
> STM32CubeMX / CubeIDE'deki "Pinout & Configuration" deneyimi: pin seçiminde alternatifler, pin etiketleri, işlemci paketinin pin pin çizildiği görünüm, çevre birimi ağacı ve ayar panelleri. Parça parça yapılır; her madde kendi başına kullanılabilir olmalı.

> Kaynaklar (davranış CubeMX ile aynı olmalı): [STM32CubeMX kullanım kılavuzu UM1718](https://www.st.com/resource/en/user_manual/um1718-stm32cubemx.pdf) (bölüm 4.5.3 Pinout view, 4.5.4 Pinout menü ve kısayollar, 4.5.5 gelişmiş işlemler, 4.5.7 sinyal sabitleme ve etiketleme, 4.5.12 GPIO yapılandırma penceresi; numaralar sürüme göre kayabilir) · [STM32CubeMX2 Pinout kılavuzu](https://dev.st.com/stm32cube-docs/stm32cubemx2/1.1.0/en/docs/markup/CubeMX2_UserManual/CubeMX2_UserManual_Pinout.html) · [ST wiki: Blink LED (pin seçimi ve etiket ekran görüntüleriyle)](https://wiki.st.com/stm32mcu/wiki/STM32StepByStep%3AStep2_Blink_LED) · [Waveshare CubeMX eğitimi](https://www.waveshare.com/wiki/STM32CubeMX_Tutorial_Series:_Overview) · pin verisi: [STM32_open_pin_data](https://github.com/STMicroelectronics/STM32_open_pin_data) (BSD-3-Clause).

### ES-1001 · Bağlantılar penceresinde alternatif pin seçiminin düzeltilmesi
`etiketler: tip:hata, alan:pinout, öncelik:yüksek, seviye:hepsi`

2026-10-16 tarihli inceleme (STM32F411, BME280 + SPI komponenti + LED). **Çalışan:** her sinyal için o sinyali verebilen bütün pinler listeleniyor (I2C SCL: PA8, PB6, PB8, PB10; SPI SCK: PA5, PB3, PB10, PB13; CS ve GPIO: boştaki her pin). Pin seçilince kilitleniyor ve atama ona göre yeniden çözülüyor (SCL = PB8 → I2C1, SDA = PB9). **Sorunlar:**

1. Listede pinin hangi çevre birimini verdiği yazmıyor: PB10'u seçen kullanıcı I2C1 yerine I2C2'ye geçtiğini görmüyor (CubeMX'te seçenekler `PB10 · I2C2_SCL` biçiminde).
2. Liste aynı bus grubunun çevre birimine göre süzülmüyor: SCL I2C1'deyken SDA listesinde I2C2'nin pini PB3 de var; seçilirse kilit **sessizce yok sayılıyor** ve sadece notlarda uyarı çıkıyor.
3. Çevre birimi örneği (I2C1 / I2C2 / I2C3) doğrudan seçilemiyor; yalnızca pin seçerek dolaylı değişiyor.
4. Başka bir komponentin kullandığı pin listede seçilebiliyor; seçilirse kilit yok sayılıp otomatik atanıyor. CubeMX'teki gibi çakışma açıkça gösterilmeli (kullanıcı ya diğer sinyali taşımalı ya da vazgeçmeli).
5. Desteklenen sinyaller I2C, SPI, U(S)ART, ADC1 ve TIM PWM kanallarıyla sınırlı (CAN, USB, DAC, I2S, SDIO... yok).

- [ ] Seçeneklerde sinyal ve çevre birimi adı (`PB10 · I2C2_SCL`), gruplu liste (I2C1 / I2C2 / I2C3)
- [ ] Bus grubu için çevre birimi örneği seçimi; seçilen örneğe uymayan pinler devre dışı ve nedeni yazıyor
- [ ] Dolu pinler işaretli; seçilince çakışma iletişim kutusu (diğer sinyali taşı / vazgeç), sessiz yok sayma yok
- [ ] Kilitli pinler için "kilidi kaldır" ve tüm kilitleri listeleme (CubeMX'teki pinned pins listesi)
- [ ] Birim testleri: grup süzme, çakışma, örnek seçimi; arayüz testi

### ES-1002 · İşlemci verisi: paket, fiziksel pin konumları ve bütün sinyaller
`etiketler: tip:iyileştirme, alan:mcu, öncelik:yüksek, seviye:hepsi`

Pinout görünümü için işlemci tanımlarında paket ve bütün fiziksel pinler gerekiyor. Bugün `tools/mcu/gen-mcus.js` STM32_open_pin_data'daki `Position` bilgisini okuyup atıyor, sadece kartta çıkan GPIO pinlerini (ör. F411CEU6 için 34 pin) ve desteklenen sinyalleri saklıyor; pinin sağda mı solda mı olduğu yapay olarak bölünüyor.

- [ ] Paket adı ve tipi (LQFP48/64/100/144, UFQFPN, WLCSP, BGA) ile pin sayısı
- [ ] Her fiziksel pin: numara/konum (BGA'da satır-sütun), ad, tür (I/O, besleme, NRST, BOOT0, OSC), 5 V toleransı
- [ ] Pinin bütün sinyalleri ve AF numaraları (CAN, USB, DAC, I2S, SDIO, SWD, OSC, EXTI, EVENTOUT dahil); pin atayıcının kullandığı alt küme ayrı alan olarak korunur
- [ ] Kart verisi (hangi pin hangi konnektörde, kartta bağlı LED/buton) ayrı tutulur
- [ ] 15 işlemcinin yeniden üretilmesi; mevcut testlerin geçmesi

### ES-1003 · Pin etiketleri (User Label)
`etiketler: tip:özellik, alan:pinout, öncelik:yüksek, seviye:hepsi`

CubeMX'teki "Enter User Label" karşılığı: kullanıcı bir pine ad verir (ör. PA12 → `Pin_Led`), ad tasarımda her yerde görünür.

- [ ] Tasarım dosyasında pin → etiket eşlemesi; geçerli C tanımlayıcısı ve benzersizlik denetimi
- [ ] Design şemasında MCU pininde ve bağlantı tablolarında etiket (pin adı ipucunda kalır)
- [ ] Şemada MCU pinine sağ tık → "Etiket gir / kaldır"
- [ ] Kod üretimi: CubeMX ile aynı biçimde `Pin_Led_Pin` / `Pin_Led_GPIO_Port` tanımları (main.h); bare-metal'de ayrı başlık
- [ ] İşlemci değişince etiketlerin taşınması ya da uyarı; birim ve arayüz testleri

### ES-1004 · Pinout görünümü: işlemci paketinin çizimi
`etiketler: tip:özellik, alan:pinout, öncelik:yüksek, seviye:hepsi`

Ortada işlemci (kare), kenarlarında her fiziksel pin küçük bir kutu olarak, adı ve (varsa) atanmış sinyali ya da etiketiyle. ES-1002'deki veriye dayanır.

- [ ] LQFP / QFN için dört kenarda pin numarası sırasıyla yerleşim; BGA için ızgara
- [ ] Renkler CubeMX'teki gibi: atanmış ve çalışır (yeşil), mod eksik ya da çakışmalı (turuncu/kırmızı), besleme ve özel pinler (sarı/haki), boş (gri); sabitlenmiş pinde raptiye işareti
- [ ] Pinin yanında atanmış sinyal ya da kullanıcı etiketi
- [ ] Üzerine gelince kart: pin no, ad, tür, bütün alternatif fonksiyonlar, şu anki kullanım
- [ ] Yakınlaştır / sığdır / döndür; pin, sinyal ya da etiket arama (bulunan pinler yanıp söner)
- [ ] Açık / koyu tema, dar pencere; arayüz testi ve ekran görüntüleri

### ES-1005 · Pinout görünümü: pine tıklayarak sinyal atama ve sağ tık menüsü
`etiketler: tip:özellik, alan:pinout, öncelik:yüksek, seviye:hepsi`

- [ ] Sol tık: pinin fonksiyon listesi (Reset_State, GPIO_Input, GPIO_Output, GPIO_Analog, GPIO_EXTIn ve çevre birimi sinyalleri, çevre birimine göre gruplu); seçilen atanır
- [ ] Sağ tık: "Etiket gir", "Sinyali sabitle / sabitlemeyi kaldır", "Sıfırla (Reset_State)", "Bu pine bağlanabilecek çevre birimleri"
- [ ] Ctrl + tık: atanmış sinyalin alternatif pinleri vurgulanır, sürükleyerek ya da tıklayarak taşınır
- [ ] Çakışma: dolu pine atamada uyarı ve seçenekler
- [ ] Komponentlerin kullandığı pinler komponent adıyla görünür; buradan yapılan değişiklik Design'daki kilitlere yansır
- [ ] Geri al / yinele; birim ve arayüz testleri

### ES-1006 · Pinout & Configuration sekmesi: çevre birimi ağacı ve mod seçimi
`etiketler: tip:özellik, alan:pinout, öncelik:orta, seviye:profesyonel`

CubeMX'in sol panelindeki kategoriler: System Core (GPIO, NVIC, RCC, SYS), Analog, Timers, Connectivity, Middleware (FreeRTOS); A→Z listesi ve arama.

- [ ] Kategorili ve alfabetik çevre birimi ağacı; durum simgeleri (etkin, uyarı, pin çakışması yüzünden kullanılamaz)
- [ ] Çevre birimi seçilince "Mode" paneli (ör. I2C: Disable / I2C; USART: Asynchronous; SPI: Full-Duplex Master; TIM: kanal başına PWM Generation)
- [ ] Mod etkinleşince sinyaller pinlere otomatik yerleşir ve Pinout görünümünde görünür; kapatınca pinler boşalır
- [ ] RCC (HSE/LSE kaynağı) ve SYS (debug: Serial Wire, timebase) Clock sekmesiyle tutarlı
- [ ] Komponentle eklenen çevre birimleri burada "komponent tarafından kullanılıyor" olarak görünür

### ES-1007 · Configuration paneli: parametre, GPIO, NVIC ve DMA ayarları
`etiketler: tip:özellik, alan:pinout, öncelik:orta, seviye:profesyonel`

- [ ] Parameter Settings: çevre birimine göre (I2C hızı, UART baud / veri biti / parite, SPI modu ve bölücü, TIM PSC / ARR / darbe, ADC çözünürlük)
- [ ] GPIO Settings tablosu: pin, sinyal, çıkış seviyesi, mod, pull-up/down, hız, kullanıcı etiketi
- [ ] NVIC Settings (kesme açma ve öncelik), DMA Settings (akış/kanal, yön, öncelik)
- [ ] Kod üretimi bu ayarları kullanır (HAL ve bare-metal); değişiklik önizlemesi
- [ ] Birim testleri ve üretilen projenin derlenmesi

### ES-1008 · Design sekmesinde "yalnızca işlemci" (Pinout) görünümü
`etiketler: tip:özellik, alan:pinout, öncelik:orta, seviye:hepsi`

Design sekmesinde şema ile Pinout görünümü arasında geçiş: kullanıcı komponent şemasını değil, yalnızca işlemciyi ve pinlerini görmek isteyebilir.

- [ ] Design araç çubuğunda "Şema / Pinout" geçişi; seçim projede hatırlanır (Profesyonel modda varsayılan Pinout)
- [ ] İki görünüm aynı tasarım verisini kullanır: komponent pinleri Pinout'ta komponent adı ya da etiketle, Pinout'ta atanan çıplak GPIO'lar şemada MCU pin etiketi olarak görünür
- [ ] Etiket değişikliği (ör. PA12 → Pin_Led) iki görünümde de anında görünür
- [ ] Arayüz testi: geçiş, senkronizasyon, geri al / yinele

### ES-1009 · Pin listesi tablosu ve dışa aktarma
`etiketler: tip:özellik, alan:pinout, öncelik:düşük, seviye:profesyonel`

- [ ] Bütün pinlerin tablosu: no, ad, tür, sinyal, etiket, GPIO modu, sabitli mi; sıralama ve süzme
- [ ] Tablodan düzenleme (grafik görünüme alternatif, CubeMX2'deki gibi)
- [ ] CSV dışa aktarma (CubeMX "Export pinout" karşılığı) ve donanım ekibi için yazdırılabilir pin listesi
