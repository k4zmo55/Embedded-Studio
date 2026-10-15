# Değişiklik günlüğü

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
