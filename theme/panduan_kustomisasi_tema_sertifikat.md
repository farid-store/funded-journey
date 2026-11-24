# Golden Break Terminal — Panduan Kustomisasi Tema & Sertifikat

Dokumentasi ini adalah panduan cepat untuk mengganti tampilan **8 jenis sertifikat/kartu PNG** dan **UI/UX Dashboard Utama** tanpa perlu membongkar `index.html`. Seluruh pengaturan tema terpusat di dalam folder `/theme/`.

---

## 1. Struktur Folder `/theme/`

```text
project-web-kamu/
├── index.html                  # File utama terminal (sudah tersambung ke /theme/)
├── README.md                   # Panduan ini
└── theme/
    ├── cert-config.js          # PUSAT KENDALI: piala, warna, font, & latar 8 sertifikat
    ├── cert-engine.js          # Mesin Piala Akrilik 3D, frame, & loader PNG (jarang diubah)
    ├── dashboard-ui.css        # PUSAT KENDALI UI/UX dashboard utama (warna, font, layout)
    ├── achievement.png         # (Opsional) PNG piala utama untuk semua sertifikat
    ├── trophy-lifetime.png     # (Opsional) PNG piala khusus Lifetime Rewards (LIFE)
    ├── trophy-pnl.png          # (Opsional) PNG piala khusus Trade Proof & Kartu P/L
    └── theme1.png, theme2.jpg  # (Opsional) Background acak khusus Monthly PnL Recap
```

---

## 2. Daftar 8 Slot Sertifikat & Kartu PNG

Semua modul berikut membaca konfigurasi dari `theme/cert-config.js`. Jika suatu properti tidak diisi di slot khusus, modul otomatis mewarisi pengaturan dari blok `default`.

| Slot di `cert-config.js` | Nama Sertifikat / Kartu PNG | Lokasi di Website |
| :--- | :--- | :--- |
| **`CERT`** | Certificate of Target Achievement & Payout (`3:4`) | Web Proof Portal (HTML + PNG) |
| **`LIFE`** | Certificate of Lifetime Rewards (`3:4`) | Web Proof Portal (HTML + PNG) |
| **`PNL`** | Verified Trade Performance Proof (`3:4`) | Web Proof Portal (HTML + PNG) |
| **`STUDIO`** | Achievement Certificate (`16:9`, `4:3`, `A4`, `3:4`, `1:1`) | Tab Command Intel · Trade Studio |
| **`STUDIO_CARD`** | Trade Performance Card P/L (`1080×1744`) | Tab Command Intel · Trade Studio |
| **`BACKTEST`** | Backtest Performance Report (`1200×675`) | Tab Backtest Lab |
| **`RECAP`** | Monthly PnL Recap Calendar (`Story`, `Square`, `Wide`) | Tab Kalender / Share |
| **`ROI`** | Trading Cost & ROI Portfolio Card (6 Format) | Tab Command Intel · ROI Tracker |

---

## 3. Cara Mengganti Piala / Emblem Sertifikat

Buka **`theme/cert-config.js`**, lalu atur properti `emblemMode`, `emblemImage`, `emblemScale`, dan `plateText`.

### Pilihan `emblemMode`
* **`'auto'`** *(Disarankan)* — Otomatis mencari file PNG sesuai urutan prioritas. Jika file tidak ada, otomatis menggambar **Piala Akrilik 3D** lewat kode (anti-error).
* **`'image'`** — Memprioritaskan gambar PNG (tetap aman fallback ke Piala Akrilik jika file gagal dimuat).
* **`'acrylic'`** — Memaksa menggunakan **Piala Akrilik 3D** (Canvas 2D) meskipun file PNG ada di folder `/theme/`.
* **`'medal'`** — Menggunakan medali bulat klasik.
* **`'none'`** — Menyembunyikan piala/emblem.

### Urutan Prioritas Gambar pada Mode `'auto'`
1. Gambar khusus di slot sertifikat tersebut (misalnya `LIFE.emblemImage`: `theme/trophy-lifetime.png`).
2. Jika file tidak ditemukan → jatuh ke `default.emblemImage` (`theme/achievement.png`).
3. Jika file tidak ditemukan juga → otomatis menggambar **Piala Akrilik 3D**.

### Spesifikasi File PNG Piala yang Ideal
* **Format:** PNG dengan latar transparan (*transparent background*).
* **Rasio & Resolusi:** Mendekati `3:4` (ideal `600 × 800 px`).
* **Margin:** Potong area kosong di sekeliling piala setipis mungkin agar ukuran piala tampil proporsional.
* **Penyesuaian Ukuran:** Jika piala terasa kurang besar/kecil, ubah `emblemScale` (contoh: `1.15` = +15%, `0.85` = -15%).

---

## 4. Cara Mengganti Warna, Font, Brand, & Latar Sertifikat

Edit **`theme/cert-config.js`**:

* **Ubah semua sertifikat sekaligus:** Edit bagian `default.palette`, `default.fonts`, `default.brand`, atau `default.bgImage`.
* **Ubah 1 sertifikat tertentu saja:** Tambahkan atau edit properti di dalam blok slot yang diinginkan (`CERT`, `LIFE`, `PNL`, `STUDIO`, `STUDIO_CARD`, `BACKTEST`, `RECAP`, atau `ROI`).

### Contoh Kustomisasi Khusus Slot `LIFE`
```js
LIFE: {
  emblemMode: 'auto',
  emblemImage: 'theme/trophy-lifetime.png',
  emblemScale: 1.05,
  bgImage: 'theme/bg-lifetime.jpg',   // Kosongkan '' untuk latar matte polos
  bgImageOpacity: 0.18,               // Transparansi gambar latar (0.05 - 0.35)
  plateText: 'LIFETIME',              // Teks ukiran di dudukan Piala Akrilik
  palette: {
    bgTop: '#1A1712',
    bgMid: '#100E0B',
    bgBottom: '#090806',
    goldLight: '#F8E7B9',
    goldMid: '#D4AF37',
    goldDark: '#8E6C30'
  }
}
```

---

## 5. Cara Mengganti Background Acak Monthly PnL Recap

Fitur **Monthly PnL Recap** otomatis memindai folder `/theme/` untuk gambar dengan pola nama berurutan:
* `theme/theme1.png` *(atau `.jpg`, `.jpeg`, `.webp`)*
* `theme/theme2.jpg`
* `theme/theme3.webp`
* ...sampai maksimal `theme100.*`

> **Catatan:** Jangan melompati lebih dari 5 nomor sekaligus karena scanner berhenti otomatis setelah 5 nomor beruntun tidak ditemukan. File `achievement.png`, `trophy-*.png`, dan file `.js`/`.css` tidak akan ikut terpindai.

---

## 6. Cara Mengganti Tema UI/UX Dashboard Utama

Buka **`theme/dashboard-ui.css`**, lalu ubah variabel di blok paling atas `html[data-theme="graphite"]`:

```css
html[data-theme="graphite"] {
  --bg0: #101214;       /* Latar utama halaman */
  --surface: #16191D;   /* Kartu utama & sidebar */
  --surface2: #1C2024;  /* Kolom input, header tabel, & chip */
  --surface3: #24292F;  /* Hover tombol / permukaan terangkat */
  --text: #F2EFE8;      /* Warna teks utama */
  --muted: #A5A7A8;     /* Warna teks sekunder */
  --gold: #C5A46D;      /* Aksen utama, tombol primary, & tab aktif */
  --green: #38C98F;     /* Indikator profit / status aktif */
  --red: #E56472;       /* Indikator loss / bahaya */
  --fh: "Playfair Display", Georgia, serif;
  --fb: "DM Sans", "Inter", system-ui, sans-serif;
  --fm: "JetBrains Mono", ui-monospace, monospace;
}
```

Jika ingin menambah font Google baru, tambahkan tautan Google Fonts-nya di `<head>` pada `index.html`, lalu masukkan nama font tersebut ke `--fh`, `--fb`, atau `--fm`.

---

## 7. Checklist Cepat Saat Ingin Update

| Kebutuhan Update | Langkah yang Dilakukan |
| :--- | :--- |
| **Ganti piala di semua sertifikat (PNG baru)** | Timpa `theme/achievement.png` → naikkan `assetVersion` di `theme/cert-config.js` → deploy. |
| **Pakai piala berbeda untuk 1 sertifikat** | Upload PNG baru ke `/theme/` → arahkan `emblemImage` di slot target pada `cert-config.js` → naikkan `assetVersion`. |
| **Kembali ke Piala Akrilik kode** | Ubah `emblemMode: 'acrylic'` di `default` (atau di slot tertentu) pada `theme/cert-config.js`. |
| **Sembunyikan piala di 1 sertifikat** | Ubah `emblemMode: 'none'` pada slot sertifikat tersebut di `theme/cert-config.js`. |
| **Ganti warna/font 1 sertifikat** | Edit `palette` atau `fonts` pada slot sertifikat tersebut di `theme/cert-config.js`. |
| **Ganti warna/font dashboard utama** | Edit variabel CSS di bagian atas `theme/dashboard-ui.css`. |
| **Tambah latar acak Monthly Recap** | Upload file `theme1.png`, `theme2.png`, dst. ke folder `/theme/`. |

---

## 8. Trik Tes Cepat & Anti-Cache Browser/HP

### A. Tes Mode Piala via URL (Tanpa Edit Kode)
Tambahkan parameter `&emblem=...` di ujung tautan Web Proof untuk membandingkan tampilan secara instan:
* `&emblem=acrylic` → paksa Piala Akrilik 3D
* `&emblem=image` → paksa gambar PNG dari `/theme/`
* `&emblem=medal` → paksa medali bulat klasik
* `&emblem=none` → tanpa emblem

### B. Memaksa Browser & HP Memuat Update Terbaru (Anti-Cache)
1. **Tiap menimpa file PNG di `/theme/`:** Naikkan `assetVersion` di `theme/cert-config.js` (misalnya `'3'` → `'4'`).
2. **Tiap mengedit `cert-config.js`, `cert-engine.js`, atau `dashboard-ui.css`:** Jika tampilan di HP belum berubah setelah deploy, naikkan angka versi `?v=...` pada tag pemanggil di `<head>` `index.html`:
   ```html
   <link rel="stylesheet" href="theme/dashboard-ui.css?v=2">
   <script src="theme/cert-config.js?v=2"></script>
   <script src="theme/cert-engine.js?v=2"></script>
   ```