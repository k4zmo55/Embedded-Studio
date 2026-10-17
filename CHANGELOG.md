# Değişiklik günlüğü

## 0.6.4 (önizleme)

- **Güvenli bootloader şablonu (ES-303):** Proje Ayarları > **Bootloader** ile açılır; "Kod Üret" projeye bir bootloader ekler, uygulamayı yuvaya taşır.
  - **Bölümleme:** bootloader flash'ın başındaki sektör / sayfalarda (varsayılan F4 16 KB, F7 32 KB, H7 128 KB, sayfalı ailelerde 16 KB; seçilebilir). Uygulama yuvası 1 KB'lık imaj başlığıyla başlar, vektör tablosu hemen arkasında (VTOR hizası bütün ailelerde uygun). İki linker betiği (`<MCU>_BOOT.ld`, yuvaya göre `<MCU>_FLASH.ld`), `VECT_TAB_OFFSET` ve `USER_VECT_TAB_ADDRESS` tanımları; Cortex-M0'da (F030, VTOR yok) bootloader vektörleri RAM başına kopyalayıp yeniden eşler. RAM'in son 16 baytı bootloader ile uygulama arasında ortak (güncelleme isteği).
  - **İmaj başlığı:** sihirli sayı, başlık sürümü, boyut, CRC-32 (zlib), uygulama sürümü, vektör adresi, derleme kimliği (git kısa özeti, yoksa derleme zamanı), başlık CRC'si ve ayrı bir commit bloğu. Boyut, CRC ve commit derlemeden sonra `cmake/es-image.cmake` ile yazılır (yalnızca CMake; ek araç gerekmez), ELF'e de (`objcopy --update-section`): F5 ile yüklenen ELF de doğrulamadan geçer.
  - **Açılış:** başlık, başlık CRC'si, boyut, commit, imaj CRC-32 (F0/F3/F7/G0/G4/H7/L4/U5'te donanım CRC birimi, F1/F4'te yazılım) ve vektörler (yığın RAM'de, reset vektörü yuvada) denetlenir; geçerliyse kesmeler ve kullanılan birimler kapatılıp VTOR / MSP ayarlanarak uygulamaya atlanır.
  - **Güncelleme (UART):** paket başına CRC-32 ve ACK/NACK; INFO, START (gereken sektörleri siler), DATA (sıralı, yinelenen paket yazılmadan onaylanır, geri okuyarak doğrulanır), END (imajı doğrular, commit'i en son yazar), BOOT (temiz reset). Açılışta ayarlanabilir bir pencere (varsayılan 300 ms), uygulamadan `es_boot_request_update()` ya da geçerli imaj yoksa güncelleme modu. Güncelleme sırasında IWDG; yarıda kalan güncelleme commit almaz, bootloader uygulamayı çalıştırmaz ve yeni güncelleme bekler.
  - **Derleme:** `<proje>_boot.elf/.hex/.bin`, başlıklı `<proje>.bin/.hex` ve ikisini birleştiren `<proje>_full.hex`. Durum çubuğundaki **Yükle** ve Debug (Cortex-Debug `loadFiles`) bootloader açıkken `_full.hex` yazar. Bootloader 15 işlemcide 4,4–5,8 KB (`-Os`), sıkı uyarılar ve `-Werror` ile derlenir.
  - **Programlayıcı > UART (Embedded Studio bootloader):** porta bağlanırken 15 sn boyunca kart yoklanır (resetleyin ya da DTR → NRST); yuva, uygulama durumu, sürüm ve derleme kimliği gösterilir; "Dosya seç ve yaz" başlıklı uygulamayı gönderir (yanlış dosya, örneğin `_full.hex` ya da başka yuva için derlenmiş imaj, gönderilmeden reddedilir); "Sonra çalıştır" ve "Reset ve çalıştır" bootloader'ı yeniden başlatır. Kart yokken simülasyon portu. Böylece ES-305'teki "eklenti içinden güncelleme gönderme" de UART için geldi.
  - USB (CDC) üzerinden güncelleme bu sürümde yok; bootloader UART ile çalışır.
- Testler: birim 73; **bootloader çekirdeği bilgisayarda** (`test/boot-core.js`: gcc ile derlenir, flash dosyada ve silinmemiş bayta yazma reddedilir, eklentinin istemcisiyle konuşur — F4, H7 32 baytlık, L4 8 baytlık yazma birimi, F1; güncelleme, reset sonrası doğrulama, yarıda kalma, bozuk paket, bozuk imaj, yinelenen paket, yanlış yuva); derleme 71 varyant (16 bootloader'lı: başlık ve CRC eklentinin doğrulayıcısıyla, birleşik HEX); arayüz 45 (ayarlar, Kod Üret, derleme, simülasyona güncelleme gönderme, kapatınca eski linker). Gerçek kartla denenmedi (bu makinede kart yok).

## 0.6.3 (önizleme)

- **ST sistem bootloader'ı ile yükleme (ES-302):** ST-Link olmadan, yongadaki ROM bootloader üzerinden; Programlayıcı sekmesinde.
  - **UART (AN3155):** port, baud (9600–115200), 8E1; senkron (0x7F), GET, GET_ID, READ, WRITE, ERASE / EXTENDED ERASE, GO. Bağlanınca bootloader sürümü, PID ve desteklenen komutlar; bağlanan işlemci projedekinden farklıysa uyarı. Oku / kaydet, karşılaştır ve sektör silme SWD'deki gibi bootloader üzerinden de çalışır (option byte'lar bootloader'dan okunmaz).
  - **Bootloader'a giriş:** "BOOT0 elle" ya da USB-UART dönüştürücünün DTR → NRST, RTS → BOOT0 bağlantısıyla otomatik (yüklemeden sonra BOOT0 düşük, reset). "Reset ve çalıştır" bootloader'da GO komutudur.
  - **USB DFU (AN3156):** dfu-util ya da STM32_Programmer_CLI ile (VS Code'dan doğrudan USB erişimi yok): aygıt arama (DfuSe bellek haritası çözülür), yazma (ELF/HEX dfu-util için .bin'e çevrilir), okuma, tamamını silme; ilerleme çubuğu ve anlaşılır hatalar (aygıt yok, WinUSB sürücüsü, birden fazla aygıt). dfu-util araç algılamaya eklendi.
  - **Dosya yaz:** bütün bağlantılarda (SWD/JTAG'da OpenOCD `program`, bootloader ve simülasyonda blok blok): gerekli sektörleri sil, yaz (0xFF blokları atlanır), doğrula, sonra çalıştır.
  - **Kart talimatları ve AN2606 tablosu:** 15 işlemcinin her biri için bootloader UART'ları ve pinleri, USB DFU pinleri, CAN/I2C/SPI arayüzleri; kart başına BOOT0'a giriş adımları (Black Pill düğmeleri, Blue Pill köprüleri, Nucleo-64/144 CN7/CN11 pinleri, ST-LINK sanal COM portunun bootloader UART'ına bağlı olup olmadığı). CAN/I2C/SPI ile yükleme köprü gerektirdiği için ES-307'ye ayrıldı.
  - **Simülasyon:** "Simülasyon (bootloader)" portu protokolün cihaz tarafını taklit eder (silinmeden yazılamayan flash, NACK'ler, GO); yeniden bağlanınca flash içeriği korunur.
- Testler: birim 72 (AN3155 F4, F1 eski ERASE, H7 ikinci bank; NACK, zaman aşımı, çöp bayt; DTR/RTS sırası; dfu-util/CubeProgrammer komutları ve çıktıları; 15 işlemcide AN2606 kaydı), arayüz 44 (UART talimatları, bootloader'a bağlanma, dosya yazma + doğrulama + GO, yeniden bağlanıp karşılaştırma, DFU araç durumu). Gerçek kartla, USB-UART dönüştürücüyle ve dfu-util ile denenmedi (bu makinede yok).

## 0.6.2 (önizleme)

- **Programlayıcı sekmesi (ES-301):** STM32CubeProgrammer'ın temel işleri VS Code içinde. Bağlantı Debug sekmesiyle ortak (aynı prob, aynı OpenOCD); kart yokken simülasyon.
  - **Bağlantı:** SWD ya da JTAG (ST-Link'te `hla_jtag`). UART ve USB DFU listede, sistem bootloader'ı ile ES-302'de gelecek.
  - **Oku ve kaydet:** bütün flash, bütün RAM ya da adres + uzunluk; `.bin` ya da Intel HEX, ilerleme çubuğuyla.
  - **Dosyayla karşılaştır:** `.elf` (objcopy ile), `.hex` ya da `.bin` (başlangıç adresi seçilir); farklı bayt sayısı, farklı bölgeler, ilk farklar ve cihazın boş (silinmiş) olup olmadığı.
  - **Sektörler:** liste OpenOCD'den canlı okunur (`flash info`; okunamazsa işlemci verisinden). F2/F4/F7/H7 sektörleri ve F0/F1/F3/G0/G4/L4/U5 sayfaları, çift bankta bank numarası, yazma korumalı olanlar işaretli. Shift + tık ile aralık seçimi; seçili sektörleri ya da tamamını silme (onaylı, hedef önce durdurulur; bitişik sektörler tek komutta).
  - **Option bytes (salt okunur):** RDP seviyesi (0 / 0,5 / 1 / 2, açıklamalı ve renkli), BOR, sektör/sayfa bazında yazma koruması (WRP), PCROP (F4 SPRMOD), kullanıcı bitleri (watchdog, STOP/STANDBY/SHUTDOWN reseti, boot bitleri, çift bank) ve ham register değerleri; 15 işlemcinin hepsinde. Yazma kartla denendikten sonra: yeni madde ES-306.
  - **İşlem günlüğü:** zaman damgalı, sekmede ve "Embedded Studio: Programlayıcı" çıktı panelinde.
- Sekme sırası: Acemi — …, Debug, Programlayıcı, Bellek raporu, Ayarlar; Profesyonel — Debug, Programlayıcı, Terminal, … (Alt+1…8). Programlayıcı da Ayarlar > Görünen sekmeler'den gizlenebilir.
- **Düzeltme:** Kod Üret'ten sonra arka planda çalışan CMake yapılandırması (ES-108) hemen başlatılan derlemeyle aynı klasörde çakışabiliyordu; artık geçici klasörde çalışır, yalnızca `compile_commands.json` kopyalanır.
- Testler: birim 71 (15 işlemcide sektör haritası ve fabrika option byte'ları, `flash info` çözümü, silme aralıkları, RDP/WRP/PCROP/BOR çözümü, Intel HEX, karşılaştırma, simülasyonda silme), arayüz 43 (UART uyarısı, simülasyona bağlanma, flash okuma, karşılaştırma, silme, günlük). Önceki iki arayüz testindeki bozuk `null` denetimi de düzeltildi. Gerçek kartla henüz denenmedi (bu makinede kart yok).

## 0.6.1 (önizleme)

- **Düzeltme — derleme temizken editörde onlarca hata (ES-108):** `use of undeclared identifier 'RCC'`, `'board.h' file not found` gibi hatalar derleyiciden değil, editörün dil sunucusundan geliyordu. CMake derleme veritabanını `build/<tip>/compile_commands.json`'a yazıyor, clangd ise `build/` altında arıyordu; 0.4.x'ten yükseltilen projelerde orada eski yapıya ait bir veritabanı kalmıştı. Artık:
  - `.clangd` üretilir: `CompilationDatabase: build/<tip>`, clang'ın bilmediği `-fcallgraph-info` / `-fstack-usage` çıkarılır. Derleme tipi değişince güncellenir; ilk satırı silinirse (kendi `.clangd`'niz) dokunulmaz.
  - `.vscode/settings.json`'a `C_Cpp.default.compileCommands` eklenir (Microsoft C/C++ eklentisi). Farklı bir değer varsa ya da dosyada yorum varsa dokunulmaz.
  - Kod Üret'ten sonra derleme klasörü yoksa arka planda yalnızca CMake yapılandırması çalışır; ilk derlemeden önce de editör doğru.
  - Var olan projede düzelmesi için bir kez **Kod Üret** ya da **Derle** yeterli.
- **Matris testi (ES-109):** `test/intellisense.js`, `test/build.js`'in ürettiği bütün projelerde (15 işlemci; HAL ve bare-metal, acemi ve profesyonel, FreeRTOS açık/kapalı) clangd `--check` ile her kaynak ve başlığı denetler; önce (eski durum) ve sonra (yeni `.clangd`) hata sayılarını tablo olarak verir. Derleme testine HAL + profesyonel mod varyantı eklendi.
- **Ayarlar > Görünen sekmeler (ES-804):** kullanılmayan sekmeler üst çubuktan gizlenip geri getirilebilir. Seçim bütün projelerde geçerli, acemi ve profesyonel mod için ayrı (`embeddedStudio.hiddenTabs`). Ayarlar sekmesi gizlenemez, en az bir çalışma sekmesi açık kalır; Alt+1…9 gizli sekmeleri atlar; etkin sekme gizlenirse modun ana sekmesine (o da gizliyse ilk görünene) geçilir.
- Testler: birim 70, derleme 55 varyant, clangd matrisi 55/55 projede sıfır hata (düzeltmeden önce her projede 95–410), arayüz 42 (sekme gizleme, kısayol, kalıcılık).

## 0.6.0 (önizleme) — M2 "Test ve debug" tamamlandı

- **Seri port terminali (Terminal sekmesi):** harici programa (Tera Term, PuTTY, RealTerm) gerek yok. Durum çubuğundaki **Terminal** ve "Seri Port Terminalini Aç" komutu bu sekmeyi açar.
- **Portlar:** liste sekme açıkken kendiliğinden yenilenir (Windows'ta kayıt defterinden hızlı denetim, değişince aygıt adlarıyla yeniden okunur); ST-Link / J-Link / CMSIS-DAP sanal COM portu öne alınır, son kullanılan port ve ayarlar hatırlanır. Baud (liste ya da özel), veri biti, parite (yok/çift/tek/mark/space), stop biti (1/1,5/2), akış kontrolü (RTS/CTS, XON/XOFF); DTR/RTS ve break (Windows). Port meşgul, bulunamadı, ayar desteklenmiyor gibi hatalar anlaşılır cümleyle.
- **Görünüm:** ASCII, HEX ve karışık (yazdırılamayan baytlar kutucukta onaltılık); satır başına zaman damgası; gelen satır sonu (LF, CR, CR/LF); yerel yankı (gönderilenler farklı renkte); arama (eşleşme sayısı, sonraki/önceki); otomatik kaydırma (yukarı kaydırınca durur); 20 000 satır geçmiş.
- **Gönderme:** metin (`\r \n \t \xNN` kaçışları) ya da HEX bayt (`AA 55 0D`), satır sonu (yok, CR, LF, CRLF), ↑↓ ile geçmiş, aralıklı tekrarlı gönderme. **Makrolar:** ad + veri (metin ya da HEX) düğmeleri; `.embedded-studio/terminal.json`'da saklanır, takımla paylaşılabilir.
- **Log:** sürekli kayıt, metin (yerel saatle zaman damgalı, gönderilenler `> `) ya da ham bayt (`.bin`); eklenti tarafında yazılır, hızlı akışta arayüz yetişemese de eksiksizdir. Görünen oturum ayrıca metin olarak kaydedilebilir.
- **Birden fazla port:** her port ayrı sekmede; aynı port iki sekmede açılamaz.
- **Teknik karar:** yerel `serialport` modülü yerine yardımcı süreç (Windows: PowerShell'de derlenen .NET `System.IO.Ports` yardımcısı; Linux/macOS: `stty` + aygıt dosyası). VSIX platformdan bağımsız kalır. Linux/macOS'ta DTR/RTS ve break yok; bu platformlar henüz denenmedi.
- **Simülasyon portu:** kart yokken 115200 8N1'de telemetri satırları üreten, `help`, `ver`, `status`, `led on/off`, `dump` (ikili) komutlarına yanıt veren sanal aygıt; DTR düşüp kalkınca yeniden başlar, baud yanlışsa okunamaz veri gelir.
- Sekme sırası: Acemi — Tasarım, Clock, Monitör, Terminal, Debug, Bellek raporu, Ayarlar; Profesyonel — Debug, Terminal, Bellek raporu, Monitör, Clock, Tasarım, Ayarlar.
- Testler: birim 69 (port listesi, stty, hata açıklamaları, simülasyon aygıtı, log biçimleri, Windows yardımcısının derlenmesi ve hata yolu), arayüz 41 (bağlan, gönder/geçmiş, görünümler, arama, makro, HEX gönderme, tekrar, log, ikinci sekme). Gerçek bir seri portla henüz denenmedi (bu makinede COM portu yok).

## 0.5.10 (önizleme)

- **Bellek raporu (Build Analyzer) sekmesi:** derleme tipi seçilir (Debug / Release …), derleme bitince rapor kendiliğinden yenilenir.
- **Bölgeler:** linker script'teki bellek bölgeleri (`.map` → Memory Configuration; yoksa işlemcinin flash/RAM boyutu) için kullanım, yüzde ve boş alan; çubuk bölümlere ayrılır (`.text`, `.rodata`, `.bss` …). `.data` gibi ilk değerleri flash'ta duran bölümler hem RAM'de hem flash'ta (taralı) sayılır. Değerler linker'ın `--print-memory-usage` çıktısıyla aynı (Berkeley `size` `.init_array`'i RAM'e de ekler).
- **Semboller:** ELF sembol tablosu araç gerektirmeden okunur; fonksiyon / değişken / sabit veri ve bölge süzgeci, arama, boyuta göre sıralı. Ada tıklayınca kaynağa gidilir (fonksiyonlar `addr2line`, değişkenler `nm -l`). **Dosyalar:** her kaynak dosyanın ve kütüphanenin (ör. `libc_nano.a`, nesne sayısıyla) flash ve RAM katkısı. **Bölümler:** adres, yükleme adresi, bölge, tür.
- **Değişim:** her analizde ELF değiştiyse önceki derlemenin özeti `.embedded-studio/analyzer.json`'da tutulur (derleme tipi başına). Bölge farkları (+/− bayt) ve büyüyen, küçülen, yeni, silinen semboller; sembol tablosunda Δ sütunu.
- **Yığın:** `-fstack-usage` (.su) ve GCC'nin `-fcallgraph-info=su` (.ci) çağrı grafiği birleştirilerek her fonksiyon için en kötü yığın = kendi çerçevesi + en derin çağrı zinciri; zincir gösterilir. Weak tanımlar (HAL `__weak`) ve static fonksiyonlar doğru eşlenir. Özyineleme, dolaylı çağrı (fonksiyon işaretçisi), değişken boyutlu çerçeve (alloca/VLA) ve kütüphane çağrıları işaretlenir, değer "+" ile alt sınır olarak gösterilir. "Yalnızca giriş noktaları": görevler, kesme işleyicileri, main.
- **Derleme ayarı:** "Yığın kullanımı analizi" (varsayılan açık) `-fstack-usage` ve (yalnızca GCC'de) `-fcallgraph-info=su` ekler.
- Pro modda sekme sırası: Debug, Bellek raporu, Monitör, Clock, Tasarım, Ayarlar (Alt+1…6).
- Testler: birim 68 (map ve uzun ad satırları, bölge/LMA hesabı, dosya katkıları, fark, çağrı grafiği; derlenmiş projede linker değerleriyle karşılaştırma), derleme 54 varyant, arayüz 40 (kaynağa gitme, yığın tablosu, kod değişince fark).

## 0.5.9 (önizleme)

- **FreeRTOS sekmesi (Debug > Konsol):** çekirdek yapıları GDB'siz, doğrudan hedef belleğinden okunur. TCB, `Queue_t` ve `Timer_t` ofsetleri projenin `FreeRTOSConfig.h`'inden hesaplanır (ad uzunluğu, trace, mutex, run-time stats, TLS, `configRECORD_STACK_HIGH_ADDRESS`…; V10.x ve V11.x, MPU'suz); derlenmiş projede gdb'nin DWARF çıktısıyla doğrulandı. LTO'lu derlemelerdeki `ad.lto_priv.N` sembolleri de bulunur.
- **Görevler:** hazır / gecikmeli / askıda / silinen listeler gezilerek durum (Çalışıyor, Hazır, Bekliyor, Askıda, Silindi), öncelik ve öncelik kalıtımı (taban öncelik), tutulan mutex sayısı, beklediği kuyruk ya da mutex (alma / gönderme). Yığın: boyut (`pxEndOfStack` ya da heap_4 blok başlığı), şu anki kullanım ve 0xA5 dolgusundan tepe değeri, çubukla. CPU yüzdesi `ulRunTimeCounter`'ın iki okuma arasındaki farkından. "Canlı" ile saniyede bir, hedef durdurulmadan.
- **Kuyruklar, semaforlar, mutexler:** kuyruk kaydındakiler (`vQueueAddToRegistry`); tür (kuyruk, ikili/sayan semafor, mutex, özyinelemeli mutex), doluluk, öğe boyutu, bekleyen gönderici/alıcı görevler, mutex sahibi. **Zamanlayıcılar:** etkin listelerdeki zamanlayıcılar, periyot, otomatik/tek seferlik, sonraki tetikleme, geri çağrı fonksiyonunun adı. **Heap:** boş, en az boş, toplam.
- **Uyarılar:** yığın sonundaki dolgu bozulmuşsa "yığın taşmış", en kötü durumda %10'dan (en az 64 bayt) az boş kalmışsa "taşma riski"; heap tükenmişse ya da en az boş %10'un altına inmişse.
- **Görev call stack'i:** durdurulmuş görevin kayıtlı bağlamı port düzenine göre çözülür (CM0 V11/V10, CM3, CM4F/CM7 FPU çerçevesiyle, CM33 PSPLIM); çalışan görevde çekirdek register'ları, işleyicide PSP çerçevesi. PC ve LR'den sonra yığında bir BL/BLX'ten sonrasını gösteren adreslerle olası çağrı zinciri (ELF'teki kodla denetlenir), satırlar `dosya:satır` bağlantılı. Kesin call stack için VS Code debug oturumu (Cortex-Debug `rtos`) önerilir.
- **Konsol paneli büyütülebilir** (⤢).
- **Üretilen projeler:** `FreeRTOSConfig.h`'e `configRECORD_STACK_HIGH_ADDRESS 1` ve `configQUEUE_REGISTRY_SIZE 8`; bus mutex'leri ve telemetri kilidi adlarıyla kuyruk kaydına eklenir.
- Simülasyonda gerçek yerleşimle bir FreeRTOS çekirdeği (görevler, listeler, yığınlar ve kayıtlı bağlamlar, kuyruk kaydı, zamanlayıcılar, heap); CPU sayaçları ve çalışan görev zamanla değişir, bir görevin yığını ve heap uyarı verecek kadar dolu.
- Testler: birim 67 (yerleşim hesapları, üç çekirdek düzeninde bağlam ve çağrı zinciri, taşma ve heap uyarıları, derlenmiş ELF'te gdb ile ofset karşılaştırması), arayüz 39. Gerçek kartta henüz denenmedi.

## 0.5.8 (önizleme)

- **Debug konsolu:** Debug sekmesinin altında daraltılabilir panel; SWO / ITM, RTT, Semihosting, Profil ve Data trace sekmeleri. Akış olan sekmede yeşil işaret; çıktı temizlenebilir, `.log` olarak kaydedilebilir, satır başına geliş zamanı eklenebilir.
- **SWO / ITM `printf`:** çekirdek saati projenin HCLK'sinden (TRACECLKIN) gelir, SWO frekansı ve stimulus portları (`0`, `0,1,5-7`) seçilir. OpenOCD 0.12+ TPIU nesnesi (`tpiu names` → `configure -protocol uart -output :port`), yoksa 0.11'in `tpiu config` komutu; ham ITM akışı TCP'den okunur. ITM/DWT register'ları (TER, TCR, TPR, DWT_CTRL, M7'de kilit açma) panel yazar. Paket çözücü senkron, taşma, yerel/genel zaman damgası, uzantı, yazılım ve donanım (DWT) paketlerini ayırır; parça parça gelen akışı birleştirir. Birden çok portta satır başına `[port]` öneki ve port süzgeci. Taşma olursa uyarı.
- **Profil (PC örnekleme):** DWT PC örnekleme, SWO bant genişliğinin yarısını ve saniyede ~10 000 örneği geçmeyecek aralıkla açılır. Örnekler ELF'teki fonksiyonlara dağıtılır (yüzde, örnek sayısı, çubuk); WFI/WFE uykusu ayrı satır.
- **Data trace:** izleme listesinden en fazla 4 değişken (DWT karşılaştırıcısı); her erişimde değer, yazma/okuma ve isteğe bağlı erişen komutun PC'si hedef durdurulmadan gelir (ARMv7-M: M3/M4/M7).
- **SEGGER RTT:** kontrol bloğu ELF'teki `_SEGGER_RTT`'den ya da RAM'de "SEGGER RTT" kimliği aranarak bulunur (adres elle de verilebilir); up kanalları 100 ms'de bir okunur, down kanalına satır gönderilir (LF / CRLF / yok, ↑↓ ile geçmiş). Halka tampon sınırı ve dolu tampon doğru işlenir. Probdan bağımsızdır (OpenOCD bellek erişimi), simülasyonda da çalışır.
- **Semihosting:** `arm semihosting enable`; çıktı OpenOCD'nin stdout'undan günlük satırları ayıklanarak alınır. `rdimon.specs` ve `initialise_monitor_handles()` hatırlatması.
- **`es_trace` örnek sürücüsü (bare-metal):** `es_itm_putc/es_itm_write` (debugger portu açmadıysa sessizce atlar), SEGGER RTT ile aynı düzende `_SEGGER_RTT` bloğu (J-Link RTT Viewer ve OpenOCD de okur), `es_rtt_write/read/getc` (kesme güvenli, hedef asla beklemez) ve `printf`'i ITM ve/veya RTT'ye yönlendiren `_write` (`ES_TRACE_STDOUT`). Cortex-M0/M0+'ta ITM kısmı boş. 15 işlemcide `-Werror` ile derlendi.
- **Cortex-Debug:** üretilen ve "Debug Yapılandırması Oluştur"la yazılan `launch.json`'a `swoConfig` (doğru `cpuFrequency`) ve `rttConfig` blokları kapalı olarak eklenir; `enabled: true` yapmak yeterli.
- Simülasyonda SWO (port 0 `printf`, port 1 günlük, gerçek ITM paketleriyle PC örnekleri ve data trace), RTT (saniyede bir satır, gönderileni yankılar) ve semihosting çıktısı; hepsi ITM/DWT register'larında açılanlara uyar.
- Düzeltme: simülasyonda 0x80000000 üstü adreslere (ör. ITM/DWT, SCB) yazmalar yanlış anahtara kaydediliyordu.
- Testler: birim 66 (paket çözücü, ITM/DWT ayarı, PC profili, RTT halka sınırı ve dolu tampon, uçtan uca simülasyon, es_trace, launch.json), derleme 15 varyant, arayüz 38 (SWO iki port ve süzgeç, profil, data trace, RTT yankı, semihosting, kaydetme). Gerçek kartta henüz denenmedi.

## 0.5.7 (önizleme)

- **HardFault analizörü:** debug panelinde "Fault analizi". SHCSR, CFSR, HFSR, MMFAR ve BFAR okunur; set olan her bit anlamlı bir cümleye çevrilir (ör. "Geçersiz adrese veri erişimi", "Hizasız bellek erişimi", "Sıfıra bölme", "Thumb biti 0 olan adrese dallanıldı"). Yükseltilmiş (FORCED) fault'larda asıl tür (MemManage / BusFault / UsageFault) özette; hatalı adres (BFAR / MMFAR) geçerliyse gösterilir. Cortex-M0/M0+'ta bu register'lar olmadığı belirtilir.
- **Nerede oldu:** EXC_RETURN'e göre yığın (MSP / PSP) seçilir, istisna çerçevesinden R0–R3, R12, LR, PC, xPSR ve fault öncesi SP (FPU çerçevesi ve hizalama dolgusu dahil) çıkarılır. İşleyici yığına kayıt yazmışsa (ör. `push {r7, lr}`) çerçeve MSP'de birkaç word ileride aranır. PC ve LR `arm-none-eabi-addr2line` ile fonksiyon ve `dosya:satır`a çözülür; tıklayınca kaynak satır açılır. Çerçeve geçersizse (yığın bozuk) uyarılır.
- **MSP / PSP ayrımı:** fault'un RTOS görevinde mi, kesme işleyicisinde mi, RTOS başlamadan önce mi olduğu yazılır. FreeRTOS projelerinde `pxCurrentTCB`'den çalışan görevin adı, önceliği ve yığın başı okunur; SP yığın başına çok yakınsa "görevin yığını tükenmiş" uyarısı.
- **Olası nedenler ve kontrol listesi:** bitlere ve hatalı adrese göre (0'a yakın adres → NULL işaretçi; çevre birimi bölgesi → RCC saati) işaretlenebilir liste. "Raporu kopyala" düz metin rapor üretir (issue'ya ya da yapay zekâ asistanına yapıştırmak için; yerleşik yapay zekâ yorumu ES-703'te).
- İşlemci durduğunda bir fault işleyicisindeyse panelde uyarı şeridi ve "Analiz et" düğmesi çıkar. Hedef çalışıyorsa analiz önce durdurur.
- Simülasyonda altı fault senaryosu (NULL yazma, sıfıra bölme, hizasız erişim, bozuk fonksiyon işaretçisi, saati kapalı çevre birimi, yığın taşması); proje derlenmişse senaryolar ELF'teki gerçek fonksiyon adreslerini kullanır, kaynak satıra gitme de denenebilir.
- Testler: birim 65 (bit çözümü, EXC_RETURN, çerçeve arama, altı senaryo, FreeRTOS TCB okuma, derlenmiş ELF'te addr2line), arayüz 37 (fault yokken, PSP'de NULL yazma, MSP'de itilmiş çerçeve, kaynak satıra gitme, uyarı şeridi). Gerçek kartta henüz denenmedi.

## 0.5.6 (önizleme)

- **Bellek görüntüleyici:** adres (`0x20000000`, `20000000`) ya da değişken adıyla (`uwTick`, `rx_buf+0x10`) gitme, yazarken ELF sembollerinden öneri; gidilen değişkenin baytları vurgulanır, değişken içindeki her hücrenin üzerinde `ad+ofset` görünür. 8 / 16 / 32 bit görünüm (little-endian), önceki/sonraki sayfa, değişen baytlar vurgulu. Dar sütunda satır başına 8 bayt.
- **Bellekte düzenleme:** hücreye çift tıklayıp değer girilir (önek yoksa onaltılık); görünüm genişliğinde (8/16/32 bit) yazılır. Flash/kod bölgesi yazılamaz (programı yeniden yükleyin uyarısı); hizasız yazma ve sığmayan değer reddedilir. Gösterilen bölgenin türü (RAM, flash, çevre birimi, sistem) bilgi satırında.
- **Bölgeyi dosyaya kaydetme:** başlangıç (adres ya da sembol) ve uzunluk (en fazla 1 MB) seçilir; `.bin` ham bayt, `.hex` Intel HEX. Büyük bölgeler 1 KB'lık parçalarla okunur.
- **Live Watch:** izlenen global değişkenler hedef durdurulmadan seçilen aralıkta (250 ms / 500 ms / 1 sn) okunur. Değere çift tıklayarak yazılabilir (negatif sayı, `0x`, `0b`, `f32` biçiminde ondalık sayı). İzleme listesi biçim ve grafik seçimiyle `.embedded-studio/debug.json` dosyasında saklanır, bağlanınca geri gelir.
- **Live Watch grafiği:** satırdaki grafik düğmesiyle değişkenin son 30 sn'si çizilir (monitördeki çizgi grafik bileşeni); ölçekler farklı olabileceği için her değişkene ayrı grafik.
- Simülasyonda ELF yokken örnek değişkenler zamanla değişiyor (`uwTick`, `adc_raw`, `temperature`, `error_count`); hedef durunca değerler donuyor.
- Testler: birim 64 (parçalı/hizasız okuma, Intel HEX sağlama toplamı ve 64 KB sınırı, yazma denetimi, simülasyon zamanı), arayüz 36 (sembolle gitme, 8/16/32 bit, bellek ve izlemeden yazma, .hex/.bin kaydetme, grafik, durunca donma). Gerçek kartta henüz denenmedi.

## 0.5.5 (önizleme)

- **SVD tabanlı çevre birimi ağacı:** çevre birimleri SVD gruplarına göre (TIM, USART, GPIO…) açılır-kapanır ağaçta; arama ad ve grupta. Projede kullanılanlar üstte.
- **SVD ayrıştırıcı genişletildi:** bit alanı enum değerleri, erişim türü (salt okunur / salt yazılır / bir kez yazılır; alan > register > çevre birimi kalıtımı), reset değeri, register boyutu, register `derivedFrom`, `dim` dizileri ve cluster'lar. İndirilebilen 15 SVD'nin hepsi ayrıştırılarak denendi.
- **Değerler:** alanlarda enum adı ve açıklaması; değişen bit alanları da vurgulanıyor; salt yazılır register'lar okunmuyor.
- **Register ve bit alanı yazma:** değere çift tıklayınca yazılır (`0x`, `0b`, ondalık). Bit alanları onay kutusu, enum listesi ya da değerle, okuyup değiştirip yazarak güncellenir; salt okunurlar düzenlenemez; değer alana sığmazsa hata. OpenOCD'de `write_memory` (8/16/32 bit); simülasyonda modele işlenir.
- **Çekirdek register'ları:** R0–R15, xPSR (istisna/IRQ numarası) yanında MSP/PSP (etkin olan işaretli), PRIMASK, BASEPRI, FAULTMASK (M0/M0+'da yok), CONTROL çözümlü (ayrıcalık, SP seçimi, FPCA); FPU'lu işlemcilerde s0–s31 (float değeriyle) ve FPSCR.
- **Sabitlenenler (favori register'lar):** ☆ ile farklı çevre birimlerinden register'lar tek görünümde; `.embedded-studio/debug.json` dosyasında işlemciye göre saklanır.
- Büyük SVD'ler (U575'te 7 MB tanım) webview'a tek seferde gönderilmiyor: liste önce, register tanımları seçilince.
- Debug paneli prob seçimi "OpenOCD (bağlı prob)" oldu (ST-Link'e özel değil).
- Testler: birim 63 (sentetik SVD'de dizi/cluster/kalıtım/enum, alan ekleme, FPU ayrıştırma, simülasyonda yazma), arayüz 35 (ağaç, register ve alan yazma, favori, MSP/CONTROL/FPU). Gerçek kartta register yazma henüz denenmedi.

## 0.5.4 (önizleme)

- **launch.json üretimi:** "Debug Yapılandırması Oluştur" komutu GDB sunucusunu sorar (OpenOCD, ST-LINK GDB server, pyOCD, J-Link) ve üç Cortex-Debug yapılandırması yazar: *Debug* (`main`'de durur), *reset'te dur* (Reset_Handler'da), *attach* (resetlemeden bağlanır). Algılanan prob, birden fazla probda seri numarası, SVD, FreeRTOS farkındalığı (`rtos`) ve SWD hızı eklenir. Derleme görevi `preLaunchTask` olarak bağlanır. Mevcut launch.json/tasks.json yorumlarıyla okunur; kullanıcının yapılandırmaları korunur, bozuk dosyanın üzerine yazılmaz. Kod Üret'in ilk launch.json'u da aynı üç yapılandırma.
- **Donanım breakpoint sınırı:** etkin breakpoint sayısı çekirdeğin FPB sınırına (M0/M0+: 4, M3/M4: 6, M7/M33: 8) ulaşınca ya da aşınca uyarı.
- **Hedefi Resetle (Debug)** komutu (Cortex-Debug `reset-device`); çağrı yığını sağ tık menüsünde.
- **Disassembly listesi:** `objdump -d -S` ile kaynakla karışık liste `build/<tip>/<ad>.lst`. Oturumdaki disassembly görünümü, koşullu breakpoint, hit count, logpoint, step over/into/out ve Run to Cursor VS Code + Cortex-Debug'dan gelir.
- `embeddedStudio.debug.server` ayarı: F5'in kullandığı GDB sunucusu.
- **Debug paneli düzeltmeleri:** bağlanamayınca arkada açık kalan openocd kapatılıyor (probu kilitliyordu); sabit TCL portu 6666 yerine boş port; algılanan prob (J-Link, CMSIS-DAP) ve seri numarası kullanılıyor (önceden hep ST-Link); bağlantı koparsa (prob çekildi) panel haberdar oluyor; VS Code debug oturumu başlarken panel probu bırakıyor, oturum açıkken panel OpenOCD'ye bağlanmıyor; hata mesajları yüklemeyle aynı (ST-Link'e özel değil).
- Testler: birim 60, arayüz 35 (launch.json birleştirme, breakpoint uyarısı, reset isteği). Gerçek kartla uçtan uca debug henüz denenmedi.

## 0.5.3 (önizleme)

- **Tek tuşla flash:** Flash ve Run artık OpenOCD'yi (ya da STM32_Programmer_CLI'yi) doğrudan çalıştırır. Araç algılanan proba göre seçilir: ST-Link, J-Link ve CMSIS-DAP için OpenOCD (doğru arayüz dosyası, birden fazla probda seri numarası); USB DFU ve UART önyükleyicisi için STM32CubeProgrammer.
- **İlerleme ve sonuç:** iptal edilebilir bildirimde aşama (bağlanma, silme, yazma, doğrulama, reset); bitince boyut, süre ve hız. Kullanılan komut ve tam çıktı "Embedded Studio: Yükleme" çıktı panelinde.
- **Anlaşılır hatalar:** prob yok, hedef beslenmiyor, okuma koruması (RDP), yazma koruması (WRP), hedefe bağlanılamadı, farklı işlemci, dosya yok, zaman aşımı, doğrulama hatası.
- **Dosya Yükle:** gezginde `.elf` / `.hex` / `.bin` dosyasına sağ tık (ya da komut paleti). `.bin` için adres sorulur; doğrulama, tam silme, sonra çalıştırma, reset altında bağlanma seçilebilir.
- **Ayarlar:** `embeddedStudio.flash.tool` (auto / openocd / cubeprog), `flash.erase` (sector / full; H7'de iki banka), `flash.verify`, `flash.connectUnderReset`, `flash.speedKHz`.
- Debug yapılandırması da algılanan probun OpenOCD arayüzünü kullanır (J-Link, CMSIS-DAP).
- Testler: birim 56 (komut kurulumu, ilerleme/istatistik ayrıştırma, hata açıklamaları), arayüz 35. Gerçek kartla yükleme henüz denenmedi.

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
