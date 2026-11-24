/**
 * ============================================================================
 * GOLDEN BREAK CAPITAL — CERTIFICATE & TROPHY ENGINE (theme/cert-engine.js)
 * ============================================================================
 * Mesin terpusat untuk semua sertifikat di Golden Break Terminal:
 * - Resolusi tema per jenis sertifikat (CERT / LIFE / PNL / STUDIO)
 * - Loader aset PNG (theme/achievement.png, dll) dengan cache-busting & fallback
 * - Renderer Piala Akrilik 3D (Canvas 2D — Smoked Crystal & Brushed Gold)
 * - Renderer Latar & Bingkai Editorial agar tidak duplikat di index.html
 * - Sinkronisasi tampilan HTML Web Proof & file ekspor PNG 3:4
 */

(function (global) {
  'use strict';

  const FALLBACK_DEFAULT = {
    emblemMode: 'auto',
    emblemImage: 'theme/achievement.png',
    emblemScale: 1.0,
    bgImage: '',
    bgImageOpacity: 0.16,
    brand: {
      monogram: 'GB',
      name: 'GOLDEN BREAK CAPITAL',
      registryLabel: 'OFFICIAL VERIFICATION REGISTRY',
      trophySubtext: 'CAPITAL',
      trophyTag: 'OFFICIAL AWARD'
    },
    plateText: 'VERIFIED',
    palette: {
      bgTop:      '#161A1E',
      bgMid:      '#101214',
      bgBottom:   '#0C0E10',
      surface:    '#1C2024',
      surfaceAlt: '#14171B',
      border:     'rgba(197, 164, 109, 0.24)',
      borderSoft: 'rgba(242, 239, 232, 0.10)',
      goldLight:  '#EFE2BC',
      goldMid:    '#C5A46D',
      goldDark:   '#8C6B32',
      textMain:   '#F2EFE8',
      textMuted:  '#A5A7A8',
      textFaint:  '#74787D',
      positive:   '#34D399',
      negative:   '#EF6270',
      glowColor:  'rgba(197, 164, 109, 0.10)'
    },
    fonts: {
      headline:  '"Playfair Display", "Cormorant Garamond", Georgia, serif',
      body:      '"DM Sans", "Inter", system-ui, sans-serif',
      display:   '"DM Sans", "Chakra Petch", "Inter", sans-serif',
      mono:      '"JetBrains Mono", ui-monospace, monospace',
      signature: '"Great Vibes", "Playfair Display", cursive'
    }
  };

  const _imgCache = new Map();

  function isPlainObj(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function deepMerge(base, ext) {
    const out = Object.assign({}, base);
    if (!isPlainObj(ext)) return out;
    Object.keys(ext).forEach(function (k) {
      if (isPlainObj(base[k]) && isPlainObj(ext[k])) {
        out[k] = deepMerge(base[k], ext[k]);
      } else if (ext[k] !== undefined) {
        out[k] = ext[k];
      }
    });
    return out;
  }

  function getAssetVersion() {
    const cfg = global.GBC_CERT_CONFIG;
    return (cfg && cfg.assetVersion) ? String(cfg.assetVersion) : '1';
  }

  function getUrlOverride(key) {
    try {
      return new URLSearchParams(global.location.search).get(key) || '';
    } catch (e) {
      return '';
    }
  }

  /**
   * Ambil konfigurasi tema final untuk tipe sertifikat tertentu ('CERT' | 'LIFE' | 'PNL' | 'STUDIO').
   */
  function getTheme(type) {
    const cfg = global.GBC_CERT_CONFIG || {};
    const base = deepMerge(FALLBACK_DEFAULT, cfg.default || {});
    const spec = (type && cfg[type]) ? cfg[type] : {};
    const merged = deepMerge(base, spec);

    // Override opsional lewat URL (?emblem=acrylic | ?emblem=image | ?emblem=medal) untuk tes cepat
    const urlEmblem = getUrlOverride('emblem');
    if (urlEmblem && ['auto', 'image', 'acrylic', 'medal', 'none'].indexOf(urlEmblem) !== -1) {
      merged.emblemMode = urlEmblem;
    }
    return merged;
  }

  /**
   * Muat gambar dengan timeout & cache agar render Canvas tidak pernah macet.
   */
  function loadImage(src, timeoutMs) {
    if (!src) return Promise.resolve(null);
    const ms = timeoutMs || 2800;
    const isData = /^data:/i.test(src);
    const url = isData
      ? src
      : src + (src.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(getAssetVersion());

    if (_imgCache.has(url)) return _imgCache.get(url);

    const p = new Promise(function (resolve) {
      let settled = false;
      const done = function (val) {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      const timer = setTimeout(function () { done(null); }, ms);
      const img = new Image();
      if (!isData) img.crossOrigin = 'anonymous';
      img.onload = function () {
        clearTimeout(timer);
        done(img.naturalWidth > 0 ? img : null);
      };
      img.onerror = function () {
        clearTimeout(timer);
        done(null);
      };
      img.src = url;
    });

    _imgCache.set(url, p);
    return p;
  }

  async function resolveEmblemImage(type, customSrc) {
    const cfg = global.GBC_CERT_CONFIG || {};
    const theme = getTheme(type);
    const defImg = (cfg.default && cfg.default.emblemImage) || FALLBACK_DEFAULT.emblemImage;
    const candidates = [customSrc, theme.emblemImage, defImg].filter(Boolean);
    const seen = new Set();

    for (let i = 0; i < candidates.length; i++) {
      const src = candidates[i];
      if (seen.has(src)) continue;
      seen.add(src);
      const img = await loadImage(src);
      if (img) return img;
    }
    return null;
  }

  function traceRoundRect(x, rx, ry, rw, rh, rad) {
    const r = Math.min(rad, rw / 2, rh / 2);
    x.beginPath();
    x.moveTo(rx + r, ry);
    x.arcTo(rx + rw, ry, rx + rw, ry + rh, r);
    x.arcTo(rx + rw, ry + rh, rx, ry + rh, r);
    x.arcTo(rx, ry + rh, rx, ry, r);
    x.arcTo(rx, ry, rx + rw, ry, r);
    x.closePath();
  }

  function makeGoldGradient(x, x0, y0, x1, y1, P) {
    const g = x.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, P.goldLight);
    g.addColorStop(0.5, P.goldMid);
    g.addColorStop(1, P.goldDark);
    return g;
  }

  /**
   * RENDERER 1: Piala Akrilik 3D (Smoked Crystal + Matte Obsidian + Brushed Gold)
   */
  function drawAcrylicTrophy(x, opts) {
    const o = opts || {};
    const theme = getTheme(o.type);
    const P = theme.palette;
    const F = theme.fonts;
    const B = theme.brand;

    const cx = o.cx || 0;
    const cy = o.cy || 0;
    const w = (o.w || 156) * (o.scale || theme.emblemScale || 1);
    const h = (o.h || 198) * (o.scale || theme.emblemScale || 1);
    const monogram = o.monogram || B.monogram || 'GB';
    const subtext  = o.subtext  || B.trophySubtext || 'CAPITAL';
    const tagText  = o.tagText  || B.trophyTag || 'OFFICIAL AWARD';
    const plateTxt = o.plateText || theme.plateText || 'VERIFIED';

    const scale = Math.min(w / 150, h / 190);

    const tracePlaque = function (ox, oy) {
      x.beginPath();
      x.moveTo(-24 + ox, -84 + oy);
      x.lineTo( 24 + ox, -84 + oy);
      x.lineTo( 48 + ox, -58 + oy);
      x.lineTo( 38 + ox,  56 + oy);
      x.lineTo(-38 + ox,  56 + oy);
      x.lineTo(-48 + ox, -58 + oy);
      x.closePath();
    };

    x.save();
    x.translate(cx, cy);
    x.scale(scale, scale);

    // 1. Bayangan lembut di dasar pedestal
    const sh = x.createRadialGradient(0, 84, 6, 0, 84, 58);
    sh.addColorStop(0, 'rgba(0,0,0,0.62)');
    sh.addColorStop(0.65, 'rgba(0,0,0,0.22)');
    sh.addColorStop(1, 'rgba(0,0,0,0)');
    x.fillStyle = sh;
    x.beginPath();
    x.ellipse(0, 84, 58, 11, 0, 0, Math.PI * 2);
    x.fill();

    // 2. Ketebalan sisi belakang & bevel akrilik 15mm
    const dx = 6;
    const dy = -4;
    tracePlaque(dx, dy);
    x.fillStyle = 'rgba(242,239,232,0.06)';
    x.fill();
    x.strokeStyle = 'rgba(242,239,232,0.22)';
    x.lineWidth = 1.1;
    x.stroke();

    // Sisi atas bevel
    x.beginPath();
    x.moveTo(-24, -84); x.lineTo(-24 + dx, -84 + dy);
    x.lineTo( 24 + dx, -84 + dy); x.lineTo( 24, -84);
    x.closePath();
    x.fillStyle = 'rgba(242,239,232,0.28)';
    x.fill();

    // Sisi chamfer kanan atas
    x.beginPath();
    x.moveTo(24, -84); x.lineTo(24 + dx, -84 + dy);
    x.lineTo(48 + dx, -58 + dy); x.lineTo(48, -58);
    x.closePath();
    x.fillStyle = 'rgba(239,226,188,0.34)';
    x.fill();

    // Sisi kanan akrilik
    x.beginPath();
    x.moveTo(48, -58); x.lineTo(48 + dx, -58 + dy);
    x.lineTo(38 + dx, 56 + dy); x.lineTo(38, 56);
    x.closePath();
    const sideG = x.createLinearGradient(44, -58, 44, 56);
    sideG.addColorStop(0, 'rgba(242,239,232,0.26)');
    sideG.addColorStop(0.55, 'rgba(197,164,109,0.22)');
    sideG.addColorStop(1, 'rgba(197,164,109,0.44)');
    x.fillStyle = sideG;
    x.fill();

    // 3. Badan utama akrilik (smoked crystal)
    x.save();
    tracePlaque(0, 0);
    const bodyG = x.createLinearGradient(-48, -84, 46, 58);
    bodyG.addColorStop(0,    'rgba(40,46,54,0.84)');
    bodyG.addColorStop(0.48, 'rgba(22,26,30,0.90)');
    bodyG.addColorStop(1,    'rgba(13,15,18,0.96)');
    x.fillStyle = bodyG;
    x.fill();
    x.clip();

    // Bias pantulan emas halus dari dudukan bawah ke kaca
    const upGlow = x.createLinearGradient(0, 58, 0, 8);
    upGlow.addColorStop(0, 'rgba(197,164,109,0.28)');
    upGlow.addColorStop(0.5, 'rgba(197,164,109,0.07)');
    upGlow.addColorStop(1, 'rgba(197,164,109,0)');
    x.fillStyle = upGlow;
    x.fillRect(-52, 6, 104, 54);

    // Kilau diagonal lembut 1
    x.beginPath();
    x.moveTo(-64, -22); x.lineTo(14, -96);
    x.lineTo(38, -96);  x.lineTo(-52, 8);
    x.closePath();
    const sheen1 = x.createLinearGradient(-50, -60, 20, -10);
    sheen1.addColorStop(0, 'rgba(242,239,232,0.16)');
    sheen1.addColorStop(1, 'rgba(242,239,232,0.01)');
    x.fillStyle = sheen1;
    x.fill();

    // Kilau diagonal tipis 2
    x.beginPath();
    x.moveTo(-54, 24); x.lineTo(48, -74);
    x.lineTo(54, -68); x.lineTo(-48, 30);
    x.closePath();
    x.fillStyle = 'rgba(242,239,232,0.06)';
    x.fill();

    // Bingkai laser-etched bagian dalam
    x.save();
    x.scale(0.84, 0.87);
    tracePlaque(0, -1);
    x.strokeStyle = 'rgba(197,164,109,0.34)';
    x.lineWidth = 1.2;
    x.stroke();
    x.restore();

    // 4. Grafir Emas di dalam kaca akrilik
    // Berlian kecil puncak
    x.fillStyle = P.goldLight;
    x.beginPath();
    x.moveTo(0, -64); x.lineTo(4.5, -58.5);
    x.lineTo(0, -53); x.lineTo(-4.5, -58.5);
    x.closePath();
    x.fill();

    // Garis atas
    x.strokeStyle = 'rgba(197,164,109,0.45)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(-20, -45); x.lineTo(20, -45);
    x.stroke();

    // Monogram GB
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.65)';
    x.shadowBlur = 6;
    x.shadowOffsetY = 2;
    x.font = '700 40px ' + F.headline;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = makeGoldGradient(x, -22, -26, 22, 16, P);
    x.fillText(monogram, 0, -12);
    x.restore();

    // Subtext (CAPITAL)
    x.font = '700 8.5px ' + F.mono;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = P.textMain;
    x.fillText(String(subtext).split('').join(' '), 0, 15);

    // Garis bawah
    x.strokeStyle = 'rgba(197,164,109,0.45)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(-16, 27); x.lineTo(16, 27);
    x.stroke();

    // Label kecil bawah kaca
    x.font = '600 7.2px ' + F.mono;
    x.fillStyle = P.goldMid;
    x.fillText(String(tagText).toUpperCase(), 0, 40);

    x.restore(); // selesai clip front face

    // 5. Specular rim tajam mengelilingi tepi kaca
    tracePlaque(0, 0);
    const rimG = x.createLinearGradient(-48, -84, 48, 56);
    rimG.addColorStop(0,    'rgba(242,239,232,0.75)');
    rimG.addColorStop(0.35, 'rgba(197,164,109,0.52)');
    rimG.addColorStop(0.75, 'rgba(242,239,232,0.20)');
    rimG.addColorStop(1,    'rgba(197,164,109,0.62)');
    x.strokeStyle = rimG;
    x.lineWidth = 1.6;
    x.stroke();

    // 6. Dudukan Pedestal: Collar Emas + Base Obsidian Matte
    x.beginPath();
    x.moveTo(-42, 56); x.lineTo(42, 56);
    x.lineTo(45, 64);  x.lineTo(-45, 64);
    x.closePath();
    x.fillStyle = makeGoldGradient(x, -45, 56, 45, 64, P);
    x.fill();

    // Highlight tepi atas collar emas
    x.strokeStyle = 'rgba(255,250,235,0.60)';
    x.lineWidth = 1;
    x.beginPath();
    x.moveTo(-42, 56.5); x.lineTo(42, 56.5);
    x.stroke();

    // Blok pedestal obsidian
    x.beginPath();
    x.moveTo(-46, 64); x.lineTo(46, 64);
    x.lineTo(52, 83);  x.lineTo(-52, 83);
    x.closePath();
    const baseG = x.createLinearGradient(0, 64, 0, 83);
    baseG.addColorStop(0, P.surface);
    baseG.addColorStop(1, P.bgBottom);
    x.fillStyle = baseG;
    x.fill();
    x.strokeStyle = 'rgba(197,164,109,0.36)';
    x.lineWidth = 1.2;
    x.stroke();

    // Plat logam tipis dengan ukiran tipe penghargaan
    x.fillStyle = 'rgba(197,164,109,0.14)';
    x.fillRect(-33, 69, 66, 10);
    x.strokeStyle = 'rgba(197,164,109,0.55)';
    x.lineWidth = 0.8;
    x.strokeRect(-33, 69, 66, 10);

    x.font = '700 7.2px ' + F.mono;
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.fillStyle = P.goldLight;
    x.fillText(String(plateTxt).toUpperCase(), 0, 74.3);

    x.restore();
  }

  /**
   * RENDERER 2: Medali Klasik (opsi alternatif bila emblemMode: 'medal')
   */
  function drawMedal(x, opts) {
    const o = opts || {};
    const theme = getTheme(o.type);
    const P = theme.palette;
    const F = theme.fonts;
    const cx = o.cx || 0;
    const cy = o.cy || 0;
    const r = Math.min(o.w || 130, o.h || 130) * 0.44 * (o.scale || theme.emblemScale || 1);
    const monogram = o.monogram || theme.brand.monogram || 'GB';
    const plateTxt = o.plateText || theme.plateText || 'VERIFIED';

    x.save();
    x.beginPath(); x.arc(cx, cy, r + 7, 0, Math.PI * 2);
    x.fillStyle = 'rgba(197,164,109,0.12)'; x.fill();

    x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2);
    x.fillStyle = P.bgMid; x.fill();
    x.strokeStyle = makeGoldGradient(x, cx - r, cy - r, cx + r, cy + r, P);
    x.lineWidth = 3.2; x.stroke();

    x.beginPath(); x.arc(cx, cy, r - 9, 0, Math.PI * 2);
    x.setLineDash([4, 4]);
    x.strokeStyle = 'rgba(197,164,109,0.62)';
    x.lineWidth = 1.2; x.stroke();
    x.setLineDash([]);

    x.textAlign = 'center';
    x.textBaseline = 'middle';
    x.font = '700 ' + Math.round(r * 0.56) + 'px ' + F.headline;
    x.fillStyle = P.goldLight;
    x.fillText(monogram, cx, cy - 2);

    x.font = '700 ' + Math.round(r * 0.16) + 'px ' + F.mono;
    x.fillStyle = P.goldMid;
    x.fillText(String(plateTxt).toUpperCase(), cx, cy + r * 0.52);
    x.restore();
  }

  /**
   * API UTAMA 1: Gambar emblem/piala di Canvas 2D
   */
  async function drawEmblem(ctx, opts) {
    const o = opts || {};
    const theme = getTheme(o.type);
    const mode = o.mode || theme.emblemMode || 'auto';
    if (mode === 'none') return { source: 'none' };

    const cx = o.cx || 0;
    const cy = o.cy || 0;
    const scale = o.scale || theme.emblemScale || 1;
    const w = (o.w || 156) * scale;
    const h = (o.h || 198) * scale;

    if (mode === 'auto' || mode === 'image') {
      const img = await resolveEmblemImage(o.type, o.customSrc);
      if (img) {
        const ratio = Math.min(w / img.naturalWidth, h / img.naturalHeight);
        const dw = img.naturalWidth * ratio;
        const dh = img.naturalHeight * ratio;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.48)';
        ctx.shadowBlur = 18;
        ctx.shadowOffsetY = 8;
        ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
        ctx.restore();
        return { source: 'image', src: img.src };
      }
    }

    if (mode === 'medal') {
      drawMedal(ctx, o);
      return { source: 'medal' };
    }

    drawAcrylicTrophy(ctx, o);
    return { source: 'acrylic' };
  }

  /**
   * API UTAMA 2: Gambar latar belakang & bingkai editorial sertifikat
   */
  async function drawCanvasFrame(ctx, W, H, opts) {
    const o = opts || {};
    const theme = getTheme(o.type);
    const P = theme.palette;
    const isValid = o.valid !== false;

    // Latar matte obsidian-graphite
    const bg = ctx.createLinearGradient(0, 0, W, H);
    bg.addColorStop(0, P.bgTop);
    bg.addColorStop(0.52, P.bgMid);
    bg.addColorStop(1, P.bgBottom);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    // Opsional: background image custom dari cert-config.js
    if (theme.bgImage) {
      const bgImg = await loadImage(theme.bgImage);
      if (bgImg) {
        const r = Math.max(W / bgImg.naturalWidth, H / bgImg.naturalHeight);
        const dw = bgImg.naturalWidth * r;
        const dh = bgImg.naturalHeight * r;
        ctx.save();
        ctx.globalAlpha = Number(theme.bgImageOpacity) || 0.16;
        ctx.drawImage(bgImg, (W - dw) / 2, (H - dh) / 2, dw, dh);
        ctx.restore();
      }
    }

    // Cahaya ambient emas sangat halus (tanpa neon)
    const glow = ctx.createRadialGradient(W * 0.25, 115, 20, W * 0.25, 115, 620);
    glow.addColorStop(0, P.glowColor);
    glow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, W, Math.min(H, 760));

    // Bingkai luar & dalam
    traceRoundRect(ctx, 34, 34, W - 68, H - 68, 26);
    ctx.strokeStyle = isValid ? makeGoldGradient(ctx, 0, 0, W, H, P) : 'rgba(239,98,112,0.72)';
    ctx.lineWidth = 2.6;
    ctx.stroke();

    traceRoundRect(ctx, 52, 52, W - 104, H - 104, 18);
    ctx.strokeStyle = P.border;
    ctx.lineWidth = 1.2;
    ctx.stroke();

    return theme;
  }

  /**
   * API UTAMA 3: Render piala yang SAMA persis sebagai DataURL untuk elemen <img> HTML
   */
  async function renderEmblemDataURL(opts) {
    const o = opts || {};
    const w = o.pixelW || 320;
    const h = o.pixelH || 400;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const c = cv.getContext('2d');
    await drawEmblem(c, Object.assign({}, o, {
      cx: w / 2,
      cy: h / 2,
      w: w * 0.9,
      h: h * 0.9
    }));
    return cv.toDataURL('image/png');
  }

  /**
   * API UTAMA 4: Terapkan variabel warna tema ke container HTML Web Proof
   */
  function applyHtmlThemeVars(el, type) {
    if (!el || !el.style) return;
    const theme = getTheme(type);
    const P = theme.palette;
    const F = theme.fonts;
    el.style.setProperty('--cert-bg-top', P.bgTop);
    el.style.setProperty('--cert-bg-mid', P.bgMid);
    el.style.setProperty('--cert-bg-bot', P.bgBottom);
    el.style.setProperty('--cert-surface', P.surface);
    el.style.setProperty('--cert-border', P.border);
    el.style.setProperty('--cert-gold-light', P.goldLight);
    el.style.setProperty('--cert-gold', P.goldMid);
    el.style.setProperty('--cert-gold-dark', P.goldDark);
    el.style.setProperty('--cert-text', P.textMain);
    el.style.setProperty('--cert-muted', P.textMuted);
    el.style.setProperty('--cert-faint', P.textFaint);
    el.style.setProperty('--cert-pos', P.positive);
    el.style.setProperty('--cert-neg', P.negative);
    el.style.setProperty('--cert-fh', F.headline);
    el.style.setProperty('--cert-fb', F.body);
    el.style.setProperty('--cert-fm', F.mono);
  }

  function clearCache() {
    _imgCache.clear();
  }

  global.GBC_CERT_ENGINE = {
    getTheme: getTheme,
    loadImage: loadImage,
    makeGoldGradient: makeGoldGradient,
    drawCanvasFrame: drawCanvasFrame,
    drawEmblem: drawEmblem,
    drawAcrylicTrophy: drawAcrylicTrophy,
    drawMedal: drawMedal,
    renderEmblemDataURL: renderEmblemDataURL,
    applyHtmlThemeVars: applyHtmlThemeVars,
    clearCache: clearCache
  };

  // Alias kompatibilitas bila ada kode lama yang memanggil GBC_CERT_EMBLEM
  global.GBC_CERT_EMBLEM = {
    draw: drawEmblem,
    toDataURL: renderEmblemDataURL,
    clearCache: clearCache
  };
})(window);
