/* ============================================================
   Aurelia Grand — brand engine
   Reads the colours a logo actually uses and dresses the desk in them.
   Everything here is pure except apply(), setFavicon(), paletteFromSrc()
   and readFile(), which touch the page only when one exists.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  if (!LHMS) return;
  var brand = (LHMS.brand = {});

  var FALLBACK = ["#16283f", "#b18f52", "#d9c08d", "#3a5677", "#f7f0df"];
  var HOUSE_ACCENT = "#b18f52";
  var ACCENTS = ["#b18f52", "#3a628c", "#2f6b4f", "#6a5a8e", "#a3413c"];
  brand.FALLBACK = FALLBACK.slice();

  /* ---------------- colour arithmetic ---------------- */
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  function toRgb(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return [0, 0, 0];
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function toHex(rgb) {
    var out = "#";
    for (var i = 0; i < 3; i++) {
      var v = clamp(Math.round(rgb[i]), 0, 255).toString(16);
      out += v.length === 1 ? "0" + v : v;
    }
    return out;
  }

  function mix(a, b, t) {
    var x = toRgb(a), y = toRgb(b), out = [];
    for (var i = 0; i < 3; i++) out[i] = x[i] + (y[i] - x[i]) * t;
    return toHex(out);
  }

  function channel(v) {
    v = clamp(v, 0, 255) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }

  function luminance(hex) {
    var c = toRgb(hex);
    return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  }

  function hsl(hex) {
    var c = toRgb(hex).map(function (v) { return v / 255; });
    var mx = Math.max(c[0], c[1], c[2]), mn = Math.min(c[0], c[1], c[2]);
    var l = (mx + mn) / 2, d = mx - mn;
    if (!d) return { h: 0, s: 0, l: l };
    var s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    var h = mx === c[0] ? (c[1] - c[2]) / d + (c[1] < c[2] ? 6 : 0)
      : mx === c[1] ? (c[2] - c[0]) / d + 2
        : (c[0] - c[1]) / d + 4;
    return { h: h * 60, s: s, l: l };
  }

  function hueGap(a, b) {
    var d = Math.abs(a - b) % 360;
    return Math.min(d, 360 - d);
  }

  function darkenTo(hex, target) {
    if (luminance(hex) <= target) return hex;
    var lo = 0, hi = 1;
    for (var i = 0; i < 20; i++) {
      var mid = (lo + hi) / 2;
      if (luminance(mix(hex, "#000000", mid)) > target) lo = mid; else hi = mid;
    }
    return mix(hex, "#000000", hi);
  }

  function clampLum(hex, lo, hi) {
    var l = luminance(hex);
    if (l < lo) {
      var a = 0, b = 1;
      for (var i = 0; i < 20; i++) {
        var m = (a + b) / 2;
        if (luminance(mix(hex, "#ffffff", m)) < lo) a = m; else b = m;
      }
      return mix(hex, "#ffffff", b);
    }
    if (l > hi) return darkenTo(hex, hi);
    return hex;
  }

  function contrast(a, b) {
    var x = luminance(a), y = luminance(b);
    var hi = Math.max(x, y), lo = Math.min(x, y);
    return (hi + 0.05) / (lo + 0.05);
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (c) {
      var k = String(c).toLowerCase();
      if (!seen[k]) { seen[k] = 1; out.push(c); }
    });
    return out;
  }

  brand.toRgb = toRgb;
  brand.toHex = toHex;
  brand.mix = mix;
  brand.luminance = luminance;
  brand.hsl = hsl;
  brand.hueGap = hueGap;
  brand.contrast = contrast;

  /* ---------------- palette from pixels ---------------- */
  // A logo is mostly edges, antialiasing and background. Bucketing by 16 levels
  // per channel finds the colours a person would name; alpha below 160 and
  // near-white are the paper, not the ink. The primary is then darkened until
  // text can sit on it, and the accent is the strongest colour far enough round
  // the wheel to be a second voice rather than a shade of the first.
  function paletteFromPixels(data) {
    if (!data || !data.length) return FALLBACK.slice();
    var buckets = {}, total = 0;
    for (var i = 0; i + 3 < data.length; i += 4) {
      if (data[i + 3] < 160) continue;
      var r = data[i], g = data[i + 1], b = data[i + 2];
      var mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mn > 246) continue;
      if (mn > 239 && mx - mn < 10) continue;
      var key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      var bucket = buckets[key] || (buckets[key] = { n: 0, r: 0, g: 0, b: 0 });
      bucket.n++; bucket.r += r; bucket.g += g; bucket.b += b; total++;
    }
    if (!total) return FALLBACK.slice();

    var rows = Object.keys(buckets).map(function (k) {
      var x = buckets[k];
      return { n: x.n, hex: toHex([x.r / x.n, x.g / x.n, x.b / x.n]) };
    }).sort(function (x, y) { return y.n - x.n; });

    var primaryRow = null;
    rows.some(function (row) {
      var h = hsl(row.hex);
      if (h.s >= 0.10 && luminance(row.hex) <= 0.72) { primaryRow = row; return true; }
      return false;
    });
    if (!primaryRow) {
      rows.some(function (row) {
        var h = hsl(row.hex);
        if (h.s >= 0.05 && luminance(row.hex) <= 0.84) { primaryRow = row; return true; }
        return false;
      });
    }
    if (!primaryRow) primaryRow = rows[0];

    var primary = darkenTo(primaryRow.hex, 0.11);
    var primaryHsl = hsl(primary);
    var monochrome = primaryHsl.s < 0.06;
    var accentRow = null, best = 0;
    rows.forEach(function (row) {
      if (row === primaryRow) return;
      var h = hsl(row.hex), l = luminance(row.hex);
      if (h.s < 0.20 || l < 0.13 || l > 0.70) return;
      var gap = hueGap(primaryHsl.h, h.h);
      if (gap < 24) return;
      var score = row.n * (1 + gap / 180);
      if (score > best) { best = score; accentRow = row; }
    });

    var accent;
    if (accentRow) {
      accent = clampLum(accentRow.hex, 0.10, 0.28);
    } else if (monochrome) {
      accent = clampLum(HOUSE_ACCENT, 0.10, 0.28);
    } else {
      var pick = ACCENTS[0], gapBest = -1;
      ACCENTS.forEach(function (c) {
        var gap = hueGap(primaryHsl.h, hsl(c).h);
        if (gap > gapBest) { gapBest = gap; pick = c; }
      });
      accent = clampLum(pick, 0.10, 0.28);
    }

    var swatches = dedupe([
      primary,
      accent,
      mix(primary, "#ffffff", 0.80),
      mix(primary, "#000000", 0.34),
      mix(accent, "#ffffff", 0.66)
    ]);
    while (swatches.length < 5) {
      swatches.push(mix(swatches[swatches.length - 1] || primary, "#ffffff", 0.18));
    }
    return swatches.slice(0, 5);
  }
  brand.paletteFromPixels = paletteFromPixels;

  /* ---------------- palette to CSS variables ---------------- */
  var CREAM = "#fbf8f1";
  function rgba(hex, a) {
    var c = toRgb(hex);
    return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
  }

  // The whole desk wears the logo, not only its buttons: the wash behind the
  // panels, the panels, the rules, the sidebar's depth and the shadow it casts
  // are all mixed from the same primary, so a green hotel cannot open on a navy
  // page with green buttons. Status colours stay fixed — they carry meaning.
  function themeFromPalette(palette) {
    var p = palette && palette[0] ? palette[0] : FALLBACK[0];
    var a = palette && palette[1] ? palette[1] : FALLBACK[1];
    var primary = darkenTo(p, 0.11);
    var accent = clampLum(a, 0.10, 0.28);
    var deep = mix(primary, "#000000", 0.22);
    var deeper = mix(primary, "#000000", 0.34);
    var wash1 = mix(primary, "#ffffff", 0.975);
    var wash2 = mix(primary, "#ffffff", 0.86);
    return {
      "--navy": primary,
      "--navy-2": mix(primary, "#000000", 0.16),
      "--navy-3": mix(primary, "#ffffff", 0.18),
      "--navy-4": mix(primary, "#ffffff", 0.32),
      "--navy-deep": deep,
      "--navy-deeper": deeper,
      "--gold": accent,
      "--gold-2": mix(accent, "#ffffff", 0.40),
      "--gold-3": mix(accent, "#ffffff", 0.70),
      "--gold-soft": mix(accent, CREAM, 0.88),
      "--ink": darkenTo(primary, 0.055),
      "--ink-2": mix(primary, "#ffffff", 0.18),
      "--cream": mix(primary, "#ffffff", 0.962),
      "--bg": mix(primary, "#ffffff", 0.925),
      "--card": mix(primary, "#ffffff", 0.985),
      "--line": mix(primary, "#ffffff", 0.885),
      "--line-2": mix(primary, "#ffffff", 0.94),
      "--wash-1": wash1,
      "--wash-2": wash2,
      "--wash-1-0": rgba(wash1, 0),
      "--wash-2-0": rgba(wash2, 0),
      "--mark-1": mix(primary, "#ffffff", 0.22),
      "--mark-2": mix(primary, "#000000", 0.05),
      "--on-dark-muted": mix(primary, "#ffffff", 0.68),
      "--glow-brand": rgba(mix(primary, "#ffffff", 0.28), 0.5),
      "--glow-accent": rgba(accent, 0.12),
      "--accent-veil": rgba(accent, 0.22),
      "--gold-line": rgba(accent, 0.28),
      "--gold-fade-1": rgba(accent, 0.18),
      "--gold-fade-2": rgba(accent, 0.05),
      "--gold-fade-3": rgba(accent, 0.20),
      "--veil-1": rgba(deeper, 0.72),
      "--veil-2": rgba(deeper, 0.28),
      "--veil-3": rgba(deeper, 0.86),
      "--scrim": rgba(deeper, 0.45),
      "--selection": rgba(accent, 0.35),
      "--avatar-bg": mix(primary, "#ffffff", 0.90),
      "--avatar-ink": mix(primary, "#ffffff", 0.35),
      "--shadow-sm": "0 2px 8px " + rgba(deeper, 0.045),
      "--shadow-btn": "0 4px 12px " + rgba(primary, 0.18),
      "--shadow": "0 10px 32px " + rgba(deeper, 0.07),
      "--shadow-lg": "0 24px 70px " + rgba(deeper, 0.20)
    };
  }
  brand.themeFromPalette = themeFromPalette;

  /* ---------------- the colours a chart draws with ---------------- */
  // Read at render time, after apply() has put the logo's palette on the root,
  // so a chart drawn for a green hotel starts green rather than staying navy.
  function cssVar(name, fallback) {
    if (typeof document === "undefined" || !document.documentElement) return fallback;
    try {
      var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v || fallback;
    } catch (e) { return fallback; }
  }
  brand.cssVar = cssVar;

  brand.chartColors = function () {
    var deep = cssVar("--navy-2", "#1d3550");
    var gold = cssVar("--gold", "#b18f52");
    var mid = cssVar("--navy-4", "#4b6d92");
    return [deep, gold, mid, "#8a9a7b", "#c4a680", "#9a8ba8", "#6d8fa8", "#a8946f", "#7d6b8f", "#b0a48c"];
  };

  var THEME_KEYS = Object.keys(themeFromPalette(FALLBACK));

  function setFavicon(logo) {
    if (typeof document === "undefined" || !document.head) return;
    var link = document.querySelector ? document.querySelector('link[rel="icon"]') : null;
    if (!link) {
      link = document.createElement("link");
      link.rel = "icon";
      document.head.appendChild(link);
    }
    if (logo) {
      var m = /^data:([^;,]+)/.exec(logo);
      link.type = m ? m[1] : "image/png";
      link.href = logo;
    } else {
      link.type = "image/svg+xml";
      link.href = "assets/favicon.svg";
    }
  }
  brand.setFavicon = setFavicon;

  function clear() {
    if (typeof document === "undefined" || !document.documentElement) return;
    var root = document.documentElement.style;
    THEME_KEYS.forEach(function (k) { root.removeProperty(k); });
  }
  brand.clear = clear;

  function apply(branding) {
    if (typeof document === "undefined" || !document.documentElement) return;
    var palette = branding && branding.useColors !== false && Array.isArray(branding.palette) ? branding.palette : null;
    if (!palette || palette.length < 2) { clear(); }
    else {
      var theme = themeFromPalette(palette);
      var root = document.documentElement.style;
      THEME_KEYS.forEach(function (k) { root.setProperty(k, theme[k]); });
    }
    setFavicon(branding && branding.logo);
  }
  brand.apply = apply;

  /* ---------------- reading a file the browser cannot send anywhere ---------------- */
  function paletteFromSrc(src, cb) {
    if (typeof Image === "undefined" || typeof document === "undefined") {
      cb("This browser cannot read image colours.");
      return;
    }
    var img = new Image();
    img.onerror = function () { cb("That image could not be opened."); };
    img.onload = function () {
      try {
        var nw = img.width || img.naturalWidth || 96;
        var nh = img.height || img.naturalHeight || 96;
        var scale = Math.min(1, 96 / Math.max(nw, nh));
        var canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(nw * scale));
        canvas.height = Math.max(1, Math.round(nh * scale));
        var ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no canvas");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        cb(null, paletteFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data));
      } catch (e) {
        cb("That image's colours could not be read.");
      }
    };
    img.src = src;
  }
  brand.paletteFromSrc = paletteFromSrc;

  function readFile(file, kind, cb) {
    if (!file) { cb("Choose an image file."); return; }
    if (typeof FileReader === "undefined" || typeof Image === "undefined" || typeof document === "undefined") {
      cb("This browser cannot read images.");
      return;
    }
    if (file.type && !/^image\//.test(file.type)) { cb("Choose an image file."); return; }

    var limits = LHMS.BRAND_LIMITS || { maxLogoChars: 700000, maxImageChars: 900000 };
    var cap = kind === "logo" ? limits.maxLogoChars : limits.maxImageChars;
    var svg = /image\/svg\+xml/i.test(file.type) || /\.svg$/i.test(file.name || "");
    var reader = new FileReader();
    reader.onerror = function () { cb("That file could not be read."); };
    reader.onload = function () {
      var raw = String(reader.result || "");
      var img = new Image();
      img.onerror = function () { cb("That file is not an image this browser can open."); };
      img.onload = function () {
        try {
          var nw = img.width || img.naturalWidth || 512;
          var nh = img.height || img.naturalHeight || 512;
          var max = kind === "logo" ? 512 : 1600;
          var scale = Math.min(1, max / Math.max(nw, nh));
          var canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(nw * scale));
          canvas.height = Math.max(1, Math.round(nh * scale));
          var ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no canvas");
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

          var palette;
          try { palette = paletteFromPixels(ctx.getImageData(0, 0, canvas.width, canvas.height).data); }
          catch (e) { palette = FALLBACK.slice(); }

          var src = raw;
          if (!svg) {
            // A logo keeps its transparency; a photograph is a photograph and
            // JPEG is what makes six of them fit beside the ledger.
            var type = kind === "logo" ? "image/png" : "image/jpeg";
            try { src = canvas.toDataURL(type, 0.82); } catch (e2) { src = raw; }

            var attempts = kind === "logo"
              ? [[512, "image/png", 1], [384, "image/png", 1], [256, "image/png", 1], [160, "image/png", 1]]
              : [[1600, "image/jpeg", 0.82], [1400, "image/jpeg", 0.76], [1200, "image/jpeg", 0.70], [1000, "image/jpeg", 0.64]];
            var k = 0;
            while (src.length > cap && k < attempts.length) {
              var at = attempts[k++];
              var s2 = Math.min(1, at[0] / Math.max(nw, nh));
              var w2 = Math.max(1, Math.round(nw * s2));
              var h2 = Math.max(1, Math.round(nh * s2));
              canvas.width = w2; canvas.height = h2;
              ctx = canvas.getContext("2d");
              if (!ctx) break;
              ctx.drawImage(img, 0, 0, w2, h2);
              try { src = canvas.toDataURL(at[1], at[2]); } catch (e3) { break; }
            }
          }

          if (src.length > cap) {
            cb("That image is too large even after compression. Choose a smaller one.");
            return;
          }
          var name = String(file.name || "image").replace(/\.[a-z0-9]+$/i, "").slice(0, 60);
          cb(null, {
            src: src, name: name, palette: palette,
            width: canvas.width, height: canvas.height
          });
        } catch (e) {
          cb("That image could not be prepared. Try a PNG or JPEG.");
        }
      };
      img.src = raw;
    };
    reader.readAsDataURL(file);
  }
  brand.readFile = readFile;
})();
