# Değişiklik günlüğü

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
