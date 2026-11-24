/**
 * ============================================================================
 * GOLDEN BREAK CAPITAL — PUSAT KENDALI TEMA SERTIFIKAT (theme/cert-config.js)
 * ============================================================================
 * Cukup edit file ini jika ingin mengganti:
 * - Logo/Piala (pakai file PNG di folder theme/ atau Piala Akrilik kode)
 * - Warna latar, bingkai, aksen emas, teks, dan font
 * - Pengaturan khusus per jenis sertifikat:
 *   1. CERT        -> Web Proof: Certificate of Achievement / Payout (3:4)
 *   2. LIFE        -> Web Proof: Certificate of Lifetime Rewards (3:4)
 *   3. PNL         -> Web Proof: Verified Trade Execution Proof (3:4)
 *   4. STUDIO      -> Command Intel: Achievement Certificate (16:9, 4:3, A4, 3:4, 1:1)
 *   5. STUDIO_CARD -> Command Intel: Trade Performance Card P/L (1080x1744)
 *   6. BACKTEST    -> Backtest Lab: Kartu Hasil Backtest (1200x675)
 *
 * TIDAK PERLU mengedit index.html lagi setelah engine tersambung.
 */

window.GBC_CERT_CONFIG = {
  // Naikkan angka ini ('1' -> '2' -> '3') tiap kali menimpa file PNG di folder theme/
  // agar browser/HP langsung memuat gambar baru (anti-cache).
  assetVersion: '2',

  // ==========================================================================
  // 1. PENGATURAN BAWAAN (Dipakai semua sertifikat jika tidak ditimpa di bawah)
  // ==========================================================================
  default: {
    // Pilihan mode piala:
    // 'auto'    = Otomatis pakai file PNG jika ada; jika tidak ada, gambar Piala Akrilik
    // 'image'   = Utamakan file PNG (tetap aman fallback ke Akrilik jika file gagal dimuat)
    // 'acrylic' = Paksa Piala Akrilik 3D (Canvas 2D)
    // 'medal'   = Medali bulat klasik
    // 'none'    = Sembunyikan emblem
    emblemMode: 'auto',

    // Lokasi gambar piala utama (taruh file PNG transparan di folder theme/)
    emblemImage: 'theme/achievement.png',

    // Skala ukuran piala (1.0 = normal, 1.1 = lebih besar 10%, 0.9 = lebih kecil 10%)
    emblemScale: 1.0,

    // Opsional: latar gambar khusus (kosongkan '' untuk latar matte obsidian bersih)
    bgImage: '',
    bgImageOpacity: 0.16,

    // Identitas brand di header sertifikat & ukiran piala
    brand: {
      monogram: 'GB',
      name: 'GOLDEN BREAK CAPITAL',
      registryLabel: 'OFFICIAL VERIFICATION REGISTRY',
      trophySubtext: 'CAPITAL',
      trophyTag: 'OFFICIAL AWARD'
    },

    // Teks plat logam kecil di dudukan bawah Piala Akrilik
    plateText: 'VERIFIED',

    // Palet warna: Clean · Quiet Luxury · Financial Editorial
    palette: {
      bgTop:        '#161A1E',
      bgMid:        '#101214',
      bgBottom:     '#0C0E10',
      surface:      '#1C2024',
      surfaceAlt:   '#14171B',
      border:       'rgba(197, 164, 109, 0.24)',
      borderSoft:   'rgba(242, 239, 232, 0.10)',
      goldLight:    '#EFE2BC',
      goldMid:      '#C5A46D',
      goldDark:     '#8C6B32',
      textMain:     '#F2EFE8',
      textMuted:    '#A5A7A8',
      textFaint:    '#74787D',
      positive:     '#34D399',
      negative:     '#EF6270',
      glowColor:    'rgba(197, 164, 109, 0.10)'
    },

    // Tipografi editorial
    fonts: {
      headline:  '"Playfair Display", "Cormorant Garamond", Georgia, serif',
      body:      '"DM Sans", "Inter", system-ui, sans-serif',
      display:   '"DM Sans", "Chakra Petch", "Inter", sans-serif',
      mono:      '"JetBrains Mono", ui-monospace, monospace',
      signature: '"Great Vibes", "Playfair Display", cursive'
    }
  },

  // ==========================================================================
  // 2. PENGATURAN KHUSUS PER JENIS SERTIFIKAT
  //    Cukup tulis properti yang ingin dibedakan dari "default".
  // ==========================================================================

  // A. Sertifikat Target Achievement / Funded / Payout (Web Proof 3:4)
  CERT: {
    emblemMode: 'auto',
    emblemImage: 'theme/achievement.png',
    plateText: 'ACHIEVEMENT'
  },

  // B. Sertifikat Lifetime Rewards (Akumulasi All-Time Payout)
  LIFE: {
    emblemMode: 'auto',
    // Jika file trophy-lifetime.png belum ada, otomatis jatuh ke theme/achievement.png -> Akrilik
    emblemImage: 'theme/trophy-lifetime.png',
    plateText: 'LIFETIME',
    palette: {
      goldLight: '#F6E8C3',
      goldMid:   '#C5A46D',
      goldDark:  '#8E6C30'
    }
  },

  // C. Bukti Eksekusi Trade (Web Proof 3:4)
  PNL: {
    emblemMode: 'auto',
    emblemImage: 'theme/trophy-pnl.png',
    plateText: 'AUDITED'
  },

  // D. Sertifikat Target di Tab Command Intel · Trade Studio (5 Format)
  STUDIO: {
    emblemMode: 'auto',
    emblemImage: 'theme/achievement.png',
    plateText: 'FUNDED'
  },

  // E. Kartu P/L Per Trade di Tab Command Intel · Trade Studio (1080x1744)
  STUDIO_CARD: {
    emblemMode: 'auto',
    emblemImage: 'theme/trophy-pnl.png',
    plateText: 'VERIFIED'
  },

  // F. Kartu Hasil Backtest di Tab Backtest Lab (1200x675)
  BACKTEST: {
    emblemMode: 'auto',
    emblemImage: 'theme/achievement.png',
    plateText: 'BACKTEST'
  }
};
