/* ============================================================
   Aurelia Grand — seeded domain data
   Three luxury properties, one shared guest profile service.
   All data is generated locally and seeded deterministically.
   ============================================================ */
(function () {
  var LHMS = (window.LHMS = window.LHMS || {});
  LHMS.pages = LHMS.pages || {};
  LHMS.uiActions = LHMS.uiActions || {};
  LHMS.forms = LHMS.forms || {};

  /* ---------------- date + format utilities ---------------- */
  var U = (LHMS.util = {});

  U.pad = function (n) { return String(n).padStart(2, "0"); };
  U.date = function (d) { return d.getFullYear() + "-" + U.pad(d.getMonth() + 1) + "-" + U.pad(d.getDate()); };
  U.today = function () { return U.date(new Date()); };
  U.nowISO = function () { return new Date().toISOString(); };
  U.parse = function (s) {
    var p = String(s).split("-").map(Number);
    return new Date(p[0], (p[1] || 1) - 1, p[2] || 1, 12, 0, 0, 0);
  };
  U.addDays = function (s, n) {
    var d = s instanceof Date ? new Date(s) : U.parse(s);
    d.setDate(d.getDate() + n);
    return U.date(d);
  };
  U.nights = function (a, b) {
    return Math.max(0, Math.round((U.parse(b) - U.parse(a)) / 86400000));
  };
  U.same = function (a, b) { return a === b; };
  U.pretty = function (s, mode) {
    var d = U.parse(s);
    if (mode === "long") return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    if (mode === "medium") return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    if (mode === "short") return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    if (mode === "dow") return d.toLocaleDateString("en-GB", { weekday: "short" });
    if (mode === "month") return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  };
  U.dayNum = function (s) { return U.parse(s).getDate(); };
  U.monthShort = function (s) { return U.parse(s).toLocaleDateString("en-GB", { month: "short" }).toUpperCase(); };
  U.weekday = function (s) { return U.parse(s).getDay(); };
  U.isWeekend = function (s) { var w = U.weekday(s); return w === 5 || w === 6; };
  // Hall bookings are stored as "HH:MM" strings so the picker stays a plain
  // input; the maths below is the only place they are converted.
  U.timeMins = function (t) {
    var p = String(t || "").split(":");
    var h = Number(p[0]); var m = Number(p[1] || 0);
    if (!(h >= 0 && h < 24) || !(m >= 0 && m < 60)) return null;
    return h * 60 + m;
  };
  U.hoursBetween = function (a, b) {
    var x = U.timeMins(a); var y = U.timeMins(b);
    if (x === null || y === null || y <= x) return null;
    return Math.round(((y - x) / 60) * 100) / 100;
  };
  // Two ranges touch at an endpoint and that is fine — a break between events
  // is not an overlap. Only real interior overlap counts.
  U.overlaps = function (aS, aE, bS, bE) {
    var a1 = U.timeMins(aS), a2 = U.timeMins(aE), b1 = U.timeMins(bS), b2 = U.timeMins(bE);
    if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
    return a1 < b2 && b1 < a2;
  };
  // The currencies this property is allowed to hold money in. The base currency
  // is a property setting; everything else is only worth anything on the books
  // once a rate is on file for it.
  var FX_CURRENCIES = [
    { code: "NGN", name: "Nigerian Naira", symbol: "\u20a6" },
    { code: "USD", name: "US Dollar", symbol: "$" },
    { code: "GBP", name: "British Pound", symbol: "\u00a3" },
    { code: "EUR", name: "Euro", symbol: "\u20ac" },
    { code: "GHS", name: "Ghanaian Cedi", symbol: "GH\u20b5" },
    { code: "XAF", name: "CFA Franc BEAC", symbol: "FCFA " }
  ];
  var FX_SYMBOLS = {};
  FX_CURRENCIES.forEach(function (c) { FX_SYMBOLS[c.code] = c.symbol; });

  // An unknown code prints its own letters rather than borrowing the naira
  // sign: a figure shown as ₦ when it is not is worse than a clumsy one.
  // A figure with no code at all is the money of account — the books' own
  // currency, which is what every base-summed aggregate on these pages counts.
  function symOf(cur) {
    var code = String(cur || (LHMS.fx ? LHMS.fx.base() : "") || "NGN").toUpperCase();
    return FX_SYMBOLS[code] || (code + " ");
  }
  U.money = function (n, cur) {
    var v = Math.round(Number(n) || 0);
    // Folio credits are negative, and a sign belongs in front of the symbol.
    return (v < 0 ? "-" : "") + symOf(cur) + Math.abs(v).toLocaleString("en-NG");
  };
  // The abbreviated form is the one a headline KPI uses, so it has to be in the
  // money the headline is actually counting. Base-summed totals pass the books'
  // own currency; a per-row figure passes its own.
  U.compact = function (n, cur) {
    n = Number(n) || 0;
    var s = symOf(cur);
    if (n >= 1e9) return s + (n / 1e9).toFixed(1) + "b";
    if (n >= 1e6) return s + (n / 1e6).toFixed(1) + "m";
    if (n >= 1e3) return s + Math.round(n / 1e3) + "k";
    return s + n;
  };
  U.pct = function (v, dp) { return (Number(v) || 0).toFixed(dp == null ? 0 : dp) + "%"; };
  U.titleCase = function (s) { return String(s || "").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); };
  U.initials = function (name) {
    return String(name || "").split(/\s+/).filter(Boolean).slice(0, 2).map(function (p) { return p[0]; }).join("").toUpperCase();
  };
  U.slug = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""); };
  U.timeAgo = function (iso) {
    var diff = (Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return "just now";
    if (diff < 3600) return Math.floor(diff / 60) + "m ago";
    if (diff < 86400) return Math.floor(diff / 3600) + "h ago";
    return Math.floor(diff / 86400) + "d ago";
  };
  U.timeOf = function (iso) {
    return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  };
  U.uid = function (p) {
    return (p || "id") + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
  };

  /* ---------------- static catalogues ---------------- */
  var ROOM_TYPES = [
    { id: "dk", code: "DLK", name: "Deluxe King", rate: 185000, size: 38, occupancy: 2, bed: "King bed", view: "Courtyard", image: "assets/img/deluxe.jpg",
      desc: "Warm timber, Egyptian cotton and a deep soaking tub — the essential Aurelia stay.",
      amenities: ["Rain shower", "Nespresso", "Smart TV", "High-speed Wi-Fi", "In-room safe"] },
    { id: "dt", code: "DLT", name: "Deluxe Twin", rate: 185000, size: 40, occupancy: 2, bed: "Two queen beds", view: "Courtyard", image: "assets/img/deluxe.jpg",
      desc: "A generous twin room for colleagues or friends travelling together.",
      amenities: ["Rain shower", "Nespresso", "Smart TV", "High-speed Wi-Fi", "In-room safe"] },
    { id: "pv", code: "PSV", name: "Premier Sea View", rate: 245000, size: 46, occupancy: 2, bed: "King bed", view: "Atlantic Ocean", image: "assets/img/hero.jpg",
      desc: "Floor-to-ceiling glass framing the lagoon, with a private balcony at dusk.",
      amenities: ["Private balcony", "Butler on call", "Nespresso", "Evening turndown", "Pillow menu"] },
    { id: "es", code: "EXS", name: "Executive Suite", rate: 340000, size: 64, occupancy: 3, bed: "King + sofa bed", view: "Skyline", image: "assets/img/suite.jpg",
      desc: "A separate living room, dining table for four and access to the Executive Lounge.",
      amenities: ["Lounge access", "Separate living room", "Butler on call", "Complimentary pressing", "Nespresso"] },
    { id: "gv", code: "GDV", name: "Garden Villa", rate: 520000, size: 88, occupancy: 4, bed: "King bed", view: "Private garden", image: "assets/img/villa.jpg",
      desc: "A ground-level villa with plunge pool, outdoor shower and walled tropical garden.",
      amenities: ["Plunge pool", "Private garden", "Butler service", "Outdoor shower", "Dining pavilion"] },
    { id: "ps", code: "PRS", name: "Presidential Suite", rate: 1250000, size: 150, occupancy: 4, bed: "Super king", view: "Panoramic waterfront", image: "assets/img/lobby.jpg",
      desc: "The top floor, entirely yours. Formal dining for eight, study, and a dedicated butler team.",
      amenities: ["Private lift", "Dining for eight", "Dedicated butler", "Executive chef on call", "Chauffeur"] }
  ];

  var RATE_PLANS = [
    { id: "flex", code: "FLEX", name: "Flexible Rate", modifier: 1, depositPct: 25, cancel: "Free cancellation until 48 hours before arrival", includes: "Breakfast for two", colour: "#4b6d92" },
    { id: "adv", code: "ADV", name: "Advance Purchase", modifier: 0.85, depositPct: 100, cancel: "Non-refundable · full prepayment", includes: "Breakfast for two · 15% saving", colour: "#b18f52" },
    { id: "corp", code: "CORP", name: "Corporate Negotiated", modifier: 0.88, depositPct: 0, cancel: "Free cancellation until 24 hours before arrival", includes: "Breakfast · airport transfer", colour: "#6a5a8e" },
    { id: "club", code: "CLUB", name: "Aurelia Club Rate", modifier: 0.92, depositPct: 0, cancel: "Free cancellation until 24 hours before arrival", includes: "Breakfast · 14:00 checkout", colour: "#2f6b4f" },
    { id: "ota", code: "OTA", name: "Partner Channel Rate", modifier: 1.06, depositPct: 0, cancel: "Free cancellation until 72 hours before arrival", includes: "Breakfast for two", colour: "#8a6a3c" }
  ];

  var CHANNELS = ["Direct", "Booking.com", "Expedia", "Corporate", "Travel agent", "Walk-in", "GDS"];
  var DEPARTMENTS = ["Rooms", "Food & Beverage", "Spa & Wellness", "Transport", "Retail", "Laundry", "Events"];

  /* ---------------- outlets (PRD 6.5 / 6.6) ---------------- */
  // The prices guests can order against. An order posts one folio line per
  // item, so these are the only place a service price is decided.
  var OUTLETS = [
    {
      id: "out_ina", name: "In-room dining", dept: "Food & Beverage", icon: "utensils",
      sla: 40, window: "Open 24 hours", items: [
        { id: "ina_jollof", name: "Jollof rice & grilled chicken", price: 18500 },
        { id: "ina_suya", name: "Suya platter", price: 14000 },
        { id: "ina_breakfast", name: "Full Aurelia breakfast", price: 21000 },
        { id: "ina_burger", name: "Wagyu burger & truffle fries", price: 24500 },
        { id: "ina_dessert", name: "Chocolate & hibiscus dessert", price: 9500 }
      ]
    },
    {
      id: "out_isla", name: "Isla — poolside table", dept: "Food & Beverage", icon: "utensils",
      sla: 60, window: "12:00 – 22:30", items: [
        { id: "isla_tasting", name: "Chef's tasting menu (per guest)", price: 68000 },
        { id: "isla_grill", name: "Grilled catch of the day", price: 34500 },
        { id: "isla_bottle", name: "Bottle of house champagne", price: 95000 }
      ]
    },
    {
      id: "out_spa", name: "Aurelia Spa", dept: "Spa & Wellness", icon: "sparkles",
      sla: 120, window: "09:00 – 20:00", items: [
        { id: "spa_signature", name: "Signature massage — 60 min", price: 85000, minutes: 60 },
        { id: "spa_couple", name: "Couple's ritual — 90 min", price: 165000, minutes: 90 },
        { id: "spa_facial", name: "Glow facial — 45 min", price: 62000, minutes: 45 },
        { id: "spa_pool", name: "Private pool & sauna hour", price: 48000, minutes: 60 }
      ]
    },
    {
      id: "out_mini", name: "Minibar restock", dept: "Food & Beverage", icon: "bottle",
      sla: 25, window: "On request", items: [
        { id: "mini_alcohol", name: "Alcoholic selection", price: 32000 },
        { id: "mini_soft", name: "Soft drinks & water", price: 12500 },
        { id: "mini_snacks", name: "Snacks & nuts", price: 15000 }
      ]
    }
  ];

  /* ---------------- price catalogue (Financial Management) ---------------- */
  // Every number the system charges starts here. The room and menu rows keep
  // their authoring price in this file only: buildSeed strips it from the
  // seeded database, so a page physically cannot read a rate from the wrong
  // place and the price list becomes the single source of truth.

  var HALLS = [
    { id: "hall_grand", code: "HB1", name: "Grand Ballroom", capacity: 320, hourly: 850000, halfDay: 3400000, fullDay: 6200000 },
    { id: "hall_garden", code: "GT1", name: "Garden Terrace", capacity: 120, hourly: 420000, halfDay: 1700000, fullDay: 3100000 },
    { id: "hall_board", code: "BR1", name: "Boardroom", capacity: 18, hourly: 150000, halfDay: 600000, fullDay: 1100000 }
  ];

  var LAUNDRY = [
    { id: "ld_shirt", code: "LY01", name: "Shirt — wash and press", unit: "piece", price: 2500, expressPct: 50, mins: 240 },
    { id: "ld_trousers", code: "LY02", name: "Trousers — wash and press", unit: "piece", price: 3200, expressPct: 50, mins: 240 },
    { id: "ld_suit", code: "LY03", name: "Two-piece suit", unit: "piece", price: 7500, expressPct: 50, mins: 480 },
    { id: "ld_dress", code: "LY04", name: "Dress or evening gown", unit: "piece", price: 6000, expressPct: 50, mins: 480 },
    { id: "ld_bedding", code: "LY05", name: "Bedsheet set", unit: "piece", price: 4500, expressPct: 40, mins: 720 },
    { id: "ld_towel", code: "LY06", name: "Bath towel", unit: "piece", price: 1800, expressPct: 40, mins: 360 },
    { id: "ld_blanket", code: "LY07", name: "Blanket", unit: "piece", price: 6500, expressPct: 40, mins: 1440 },
    { id: "ld_dryclean", code: "LY08", name: "Dry cleaning", unit: "piece", price: 8500, expressPct: 60, mins: 1440 },
    { id: "ld_load", code: "LY09", name: "Household load", unit: "load", price: 12000, expressPct: 50, mins: 1440 }
  ];

  // Event add-ons are ordinary catalogue services in the hall category, so a
  // price change, a tax rule and a charge snapshot behave exactly as they do for
  // a hall itself rather than needing a second mechanism.
  var EVENT_EXTRAS = [
    { id: "evt_decor", code: "EV01", name: "Stage and table decoration", unit: "setup", price: 450000 },
    { id: "evt_sound", code: "EV02", name: "Sound system and MC desk", unit: "setup", price: 250000 },
    { id: "evt_projector", code: "EV03", name: "Projector and projection screen", unit: "setup", price: 120000 },
    { id: "evt_catering", code: "EV04", name: "Plated catering", unit: "guest", price: 12500 },
    { id: "evt_flowers", code: "EV05", name: "Fresh flower installations", unit: "setup", price: 380000 }
  ];

  var PRICE_LISTS = [
    { id: "pl_std", name: "Standard 2026", kind: "standard", from: "2026-01-01", to: null, priority: 1, currency: "NGN", active: true },
    { id: "pl_day", name: "Day use 09:00 – 18:00", kind: "day-use", from: "2026-01-01", to: null, priority: 5, currency: "NGN", active: true },
    { id: "pl_fest", name: "Festive season", kind: "seasonal", from: "2026-12-20", to: "2027-01-05", priority: 20, currency: "NGN", active: true },
    // A contract list is never the default: no stay resolves into dollars by
    // accident, the desk has to name the list it is selling from.
    { id: "pl_corp", name: "Corporate contracts — USD", kind: "contract", from: "2026-01-01", to: null, priority: 8, currency: "USD", active: true }
  ];

  // Applied in order, each on the running total, so VAT lands on top of the
  // service charge exactly as the printed folio does.
  var TAX_RULES = [
    { id: "tax_service", name: "Service charge", kind: "service", pct: 10, order: 1, appliesTo: ["room", "hall", "restaurant", "laundry"] },
    { id: "tax_vat", name: "VAT", kind: "vat", pct: 7.5, order: 2, appliesTo: ["room", "hall", "restaurant", "laundry"] },
    { id: "tax_city", name: "City tourism levy", kind: "city", pct: 0, order: 3, appliesTo: ["room"] }
  ];

  function round50(n) { return Math.round(n / 50) * 50; }

  function extras(o) {
    return Object.assign({
      weekendPct: 0, extraAdult: 0, extraBed: 0, earlyCheckIn: 0, lateCheckOut: 0,
      expressPct: 0, depositPct: 0, cancelPct: 0, cancelHours: 0, halfDay: null, fullDay: null
    }, o || {});
  }

  function buildServices() {
    var out = [];
    ROOM_TYPES.forEach(function (t) {
      out.push({ id: "svc_" + t.id, category: "room", refId: t.id, code: t.code, name: t.name, unit: "night", active: true, occupancy: t.occupancy });
    });
    HALLS.forEach(function (h) {
      out.push({ id: "svc_" + h.id, category: "hall", refId: h.id, code: h.code, name: h.name, unit: "hour", active: true, capacity: h.capacity });
    });
    OUTLETS.forEach(function (o) {
      o.items.forEach(function (it) {
        out.push({ id: "svc_" + it.id, category: "restaurant", refId: it.id, code: it.id.toUpperCase(), name: it.name, unit: "piece", active: true, outletId: o.id });
      });
    });
    // Add-ons are services too, marked so a hall picker can tell a room from a
    // decoration without keeping a second list anywhere.
    EVENT_EXTRAS.forEach(function (e) {
      out.push({ id: "svc_" + e.id, category: "hall", refId: e.id, code: e.code, name: e.name, unit: e.unit, active: true, addon: true });
    });
    LAUNDRY.forEach(function (l) {
      out.push({ id: "svc_" + l.id, category: "laundry", refId: l.id, code: l.code, name: l.name, unit: l.unit, active: true, turnaroundMins: l.mins });
    });
    return out;
  }

  // The seeded catalogue is derived from the authoring tables above so a price
  // is written down once; after this runs, the price rows are the only source.
  function buildPrices(stamp) {
    var prices = [];
    var byId = {};
    function push(serviceId, listId, amount, extra) {
      // The list decides the currency, so a row cannot disagree with the book it
      // belongs to and a dollar list cannot quietly seed naira.
      var list = PRICE_LISTS.filter(function (l) { return l.id === listId; })[0];
      var p = {
        id: "prc_" + serviceId.replace("svc_", "") + "_" + listId.replace("pl_", ""),
        serviceId: serviceId, listId: listId, currency: (list && list.currency) || "NGN", amount: round50(amount),
        surcharges: extras(extra),
        from: null, to: null, active: true, createdAt: stamp, updatedAt: stamp, updatedBy: "Rate card import"
      };
      prices.push(p);
      byId[p.id] = p;
      return p;
    }
    ROOM_TYPES.forEach(function (t) {
      push("svc_" + t.id, "pl_std", t.rate, {
        weekendPct: 15, extraAdult: round50(t.rate * 0.12), extraBed: 18000,
        earlyCheckIn: round50(t.rate * 0.1), lateCheckOut: round50(t.rate * 0.15), depositPct: 25
      });
      push("svc_" + t.id, "pl_day", t.rate * 0.6, { depositPct: 0 });
      push("svc_" + t.id, "pl_fest", t.rate * 1.25, { weekendPct: 10, depositPct: 50 });
    });
    HALLS.forEach(function (h) {
      push("svc_" + h.id, "pl_std", h.hourly, {
        weekendPct: 20, depositPct: 50, halfDay: h.halfDay, fullDay: h.fullDay,
        cancelPct: 50, cancelHours: 72
      });
      push("svc_" + h.id, "pl_fest", h.hourly * 1.15, {
        depositPct: 50, halfDay: round50(h.halfDay * 1.15), fullDay: round50(h.fullDay * 1.15),
        cancelPct: 50, cancelHours: 72
      });
    });
    EVENT_EXTRAS.forEach(function (e) { push("svc_" + e.id, "pl_std", e.price); });
    OUTLETS.forEach(function (o) {
      o.items.forEach(function (it) { push("svc_" + it.id, "pl_std", it.price); });
    });
    LAUNDRY.forEach(function (l) { push("svc_" + l.id, "pl_std", l.price, { expressPct: l.expressPct }); });
    // Two expatriate contract rows, sold in dollars against a named list. Their
    // worth on the books depends entirely on the dollar rate being on file.
    push("svc_dk", "pl_corp", 150, { depositPct: 25 });
    push("svc_ps", "pl_corp", 800, { depositPct: 50 });
    return prices;
  }

  function stripPrices(rows, keys) {
    return rows.map(function (r) {
      var copy = Object.assign({}, r);
      keys.forEach(function (k) { delete copy[k]; });
      return copy;
    });
  }

  function stripOutletPrices(outlets) {
    return outlets.map(function (o) {
      var copy = Object.assign({}, o);
      copy.items = stripPrices(o.items, ["price"]);
      return copy;
    });
  }

  // A seeded audit trail so price history is not an empty table on first look.
  // Each half carries the currency the figure was counted in, because a row can
  // be re-denominated and the trail must not silently read dollars as naira.
  function buildPriceHistory() {
    function row(priceId, serviceId, listId, was, now, by, at, reason, cur) {
      var currency = cur || "NGN";
      return {
        id: "ph_" + priceId, priceId: priceId, serviceId: serviceId, listId: listId,
        at: at, by: by, reason: reason,
        from: { amount: was, currency: currency }, to: { amount: now, currency: currency }
      };
    }
    return [
      row("prc_dk_std", "svc_dk", "pl_std", 175000, 185000, "Chiamaka Obi", "2026-01-06T08:12:00.000Z", "Annual rate card"),
      row("prc_ps_std", "svc_ps", "pl_std", 1150000, 1250000, "Ifeoma Okafor", "2026-02-17T10:40:00.000Z", "Refurbishment completed"),
      row("prc_ld_shirt_std", "svc_ld_shirt", "pl_std", 2200, 2500, "Grace Mensah", "2026-06-01T07:05:00.000Z", "Linen and detergent costs"),
      row("prc_dk_corp", "svc_dk", "pl_corp", 135, 150, "Chiamaka Obi", "2026-07-02T09:20:00.000Z", "Contract renewal with the exploration partner", "USD"),
      row("prc_dk_fest", "svc_dk", "pl_fest", 225000, 231250, "Chiamaka Obi", "2026-09-14T15:22:00.000Z", "Festive occupancy forecast")
    ];
  }

  /* ---------------- price maths ---------------- */
  // Pure functions over passed-in rows. The seed generator and the runtime
  // engine (assets/store.js) both call these, so a price is only ever worked
  // out one way. Nothing here touches the live database.

  function listFor(lists, date, listId) {
    if (listId) return lists.find(function (l) { return l.id === listId; }) || null;
    date = date || U.today();
    var eligible = lists.filter(function (l) {
      if (!l.active || l.kind === "day-use" || l.kind === "contract") return false;
      if (l.from && date < l.from) return false;
      if (l.to && date > l.to) return false;
      return true;
    });
    if (!eligible.length) return null;
    return eligible.slice().sort(function (a, b) { return b.priority - a.priority; })[0];
  }

  // A missing date always means "tonight", so a caller that only wants to show
  // a price cannot accidentally read a list that is out of season.
  function resolve(prices, lists, serviceId, opts) {
    opts = Object.assign({ date: U.today() }, opts || {});
    var list = listFor(lists, opts.date, opts.listId);
    if (!list) return null;
    var row = prices.find(function (p) {
      if (!p.active || p.serviceId !== serviceId || p.listId !== list.id) return false;
      if (opts.date && p.from && opts.date < p.from) return false;
      if (opts.date && p.to && opts.date > p.to) return false;
      return true;
    });
    return row ? { price: row, list: list } : null;
  }

  // The headline amount plus whatever the date or the request adds to it.
  function amount(price, service, opts) {
    opts = Object.assign({ date: U.today() }, opts || {});
    var s = price.surcharges || {};
    var n = opts.qty || 1;
    var unit = price.amount;
    if (opts.modifier) unit *= opts.modifier;
    if (opts.date && U.isWeekend(opts.date) && s.weekendPct) unit *= 1 + s.weekendPct / 100;
    var added = [];
    var extraAdults = service.category === "room" ? Math.max(0, (opts.adults || 0) - (service.occupancy || 0)) : 0;
    if (extraAdults && s.extraAdult) {
      var adultCost = s.extraAdult * extraAdults * n;
      unit += s.extraAdult * extraAdults;
      added.push({ label: "Extra person × " + extraAdults, amount: adultCost });
    }
    if (opts.extraBed && s.extraBed) { unit += s.extraBed; added.push({ label: "Extra bed", amount: s.extraBed * n }); }
    if (opts.earlyCheckIn && s.earlyCheckIn) { unit += s.earlyCheckIn; added.push({ label: "Early check-in", amount: s.earlyCheckIn }); }
    if (opts.lateCheckOut && s.lateCheckOut) { unit += s.lateCheckOut; added.push({ label: "Late check-out", amount: s.lateCheckOut }); }
    if (opts.express && s.expressPct) {
      unit *= 1 + s.expressPct / 100;
      added.push({ label: "Express service", amount: round50(price.amount * s.expressPct / 100) * n });
    }
    return { unit: round50(unit), lines: round50(unit) * n, added: added };
  }

  // A hall is sold by the hour or as a half/full-day package. The package
  // amounts live on the same price row, so a seasonal list moves the package
  // with the hourly rate. Cloning the row with the package as its headline
  // amount puts the package through the ordinary maths instead of a second
  // calculation that could drift — weekend uplift included.
  function hallAmount(price, service, opts) {
    opts = Object.assign({ date: U.today() }, opts || {});
    var s = price.surcharges || {};
    var label = opts.package === "half" ? "halfDay" : opts.package === "full" ? "fullDay" : null;
    var base = label ? s[label] : null;
    if (!base) {
      var hourly = amount(price, service, { date: opts.date, qty: opts.hours || 1, modifier: opts.modifier });
      return { package: null, packageName: null, qty: opts.hours || 1, basePrice: round50(price.amount * (opts.modifier || 1)), unit: hourly.unit, lines: hourly.lines, added: hourly.added };
    }
    var clone = Object.assign({}, price, { amount: round50(base * (opts.modifier || 1)) });
    var pkg = amount(clone, service, { date: opts.date, qty: 1, modifier: 1 });
    return {
      package: opts.package, packageName: opts.package === "half" ? "Half day" : "Full day", qty: 1,
      basePrice: clone.amount, unit: pkg.unit, lines: pkg.lines, added: pkg.added
    };
  }

  // Rules apply in order, each on the running total, so VAT lands on top of the
  // service charge exactly as the printed folio does.
  function taxes(rules, subtotal, category) {
    var applicable = rules.filter(function (r) {
      return r.pct > 0 && (r.appliesTo || []).indexOf(category) !== -1;
    }).sort(function (a, b) { return a.order - b.order; });
    var running = subtotal, lines = [];
    applicable.forEach(function (r) {
      var amt = round50(running * r.pct / 100);
      if (!amt) return;
      running += amt;
      lines.push({ rule: r, amount: amt, label: r.name + " (" + r.pct + "%)" });
    });
    return { lines: lines, total: running - subtotal, grand: running };
  }

  LHMS.priceCore = {
    round: round50, listFor: listFor, resolve: resolve, amount: amount, hallAmount: hallAmount, taxes: taxes
  };

  /* ---------------- currency core ---------------- */
  // A property sells in more than one currency and keeps its books in one. Two
  // rules make that honest, and both live here so the seed, the pages and the
  // tests cannot disagree about what a figure is worth:
  //
  //  • Money that moves the till carries the currency it was taken in AND the
  //    base-currency figure it was worth that day. A rate set tomorrow must never
  //    rewrite a charge posted yesterday.
  //  • A rate goes off the air. An eight-day-old figure is a guess about what a
  //    dollar buys today, and a guess is not a price — so a currency with no
  //    usable rate cannot be sold, billed or paid in until someone with the right
  //    puts a fresh one on file.
  function rateOn(rates, code, date) {
    var best = null;
    (rates || []).forEach(function (r) {
      if (r.code !== code) return;
      if (date && r.effective > date) return;
      if (!best || r.effective > best.effective) best = r;
    });
    return best;
  }

  // base / fresh / stale / missing, each with the sentence a refusal ends with.
  function fxState(rates, code, opts) {
    opts = opts || {};
    var base = opts.base || "NGN";
    var maxAge = opts.maxAgeDays === undefined || opts.maxAgeDays === null ? 3 : Number(opts.maxAgeDays);
    var date = opts.date || U.today();
    code = code ? String(code).toUpperCase() : base;
    if (code === base) return { code: code, base: base, state: "base", rate: 1, usable: true, ageDays: 0, effective: date, maxAgeDays: maxAge, error: null };
    var row = rateOn(rates, code, date);
    var rate = row ? Number(row.perBase) : null;
    var label = code;
    if (!row || !isFinite(rate) || rate <= 0) {
      return {
        code: code, base: base, state: "missing", rate: null, usable: false, ageDays: null, effective: null,
        maxAgeDays: maxAge, setBy: row ? row.setBy : null,
        error: "There is no " + label + " rate on file for this date, so a " + label + " figure cannot be worth anything on the " +
          base + " books. Set the rate in Financial settings first."
      };
    }
    var age = Math.max(0, U.nights(row.effective, date));
    if (age > maxAge) {
      return {
        code: code, base: base, state: "stale", rate: rate, usable: false, ageDays: age,
        effective: row.effective, maxAgeDays: maxAge, setBy: row.setBy,
        error: "The last " + label + " rate was set on " + U.pretty(row.effective, "medium") + " — " + age +
          " days old, and this property trusts a rate for " + maxAge + (maxAge === 1 ? " day." : " days.")
      };
    }
    return {
      code: code, base: base, state: "fresh", rate: rate, usable: true, ageDays: age,
      effective: row.effective, maxAgeDays: maxAge, setBy: row.setBy, error: null
    };
  }

  // The conversion every money record takes at the moment it is written.
  function fxToBase(rates, amount, code, opts) {
    var st = fxState(rates, code, opts);
    var n = Math.round(Number(amount) || 0);
    if (!st.usable) return { ok: false, error: st.error, state: st };
    return { ok: true, base: st.state === "base" ? n : round50(n * st.rate), rate: st.rate, currency: st.code, state: st };
  }

  // What a record contributes to a period total: the base figure it carried, or
  // its own amount when it was already written in the base currency.
  function baseOf(rec) {
    if (!rec) return 0;
    var v = rec.baseAmount === undefined || rec.baseAmount === null || rec.baseAmount === "" ? rec.amount : rec.baseAmount;
    return Number(v) || 0;
  }

  LHMS.fxCore = {
    currencies: FX_CURRENCIES, codes: FX_CURRENCIES.map(function (c) { return c.code; }),
    symbolOf: function (code) { return FX_SYMBOLS[String(code || "").toUpperCase()] || null; },
    nameOf: function (code) {
      var c = FX_CURRENCIES.filter(function (x) { return x.code === String(code || "").toUpperCase(); })[0];
      return c ? c.name : null;
    },
    rateOn: rateOn, state: fxState, toBase: fxToBase, base: baseOf, round: round50
  };

  /* ---------------- billing core ---------------- */
  // An invoice is a copy of what was owed at the moment it was raised, plus the
  // money that arrived against it afterwards. Keeping the arithmetic here means
  // the page, the store and the tests cannot disagree about what "paid" means.
  function invoiceNumber(seq, prefix) {
    var n = String(seq);
    while (n.length < 4) n = "0" + n;
    return (prefix || "INV") + "-INV-" + n;
  }

  // Payments and refunds are passed in rather than trusted from the record:
  // only money actually recorded can move an invoice off "Unpaid".
  function invoiceTotals(inv, payments, refunds) {
    var lines = (inv.lines || []).reduce(function (s, l) { return s + (Number(l.amount) || 0); }, 0);
    var adj = (inv.adjustments || []).reduce(function (s, a) { return s + (Number(a.amount) || 0); }, 0);
    var total = Math.round(lines + adj);
    var paid = (payments || []).reduce(function (s, p) { return s + (p.reversed ? 0 : Number(p.amount) || 0); }, 0);
    var refunded = (refunds || []).reduce(function (s, r) { return s + (r.reversed ? 0 : Number(r.amount) || 0); }, 0);
    var settled = paid - refunded;
    // The same document in the currency the books are kept in. A dollar invoice
    // and a naira one land in the same period, and only their base figures may
    // be added together — the figures above stay in the currency the guest holds.
    var baseLines = (inv.lines || []).reduce(function (s, l) { return s + baseOf(l); }, 0);
    var baseAdj = (inv.adjustments || []).reduce(function (s, a) { return s + baseOf(a); }, 0);
    var basePaid = (payments || []).reduce(function (s, p) { return s + (p.reversed ? 0 : baseOf(p)); }, 0);
    var baseRefunded = (refunds || []).reduce(function (s, r) { return s + (r.reversed ? 0 : baseOf(r)); }, 0);
    return {
      lines: lines, adjustments: adj, total: total, paid: paid, refunded: refunded, settled: settled,
      balance: Math.round(total - settled),
      base: {
        lines: baseLines, adjustments: baseAdj, total: Math.round(baseLines + baseAdj),
        paid: basePaid, refunded: baseRefunded, settled: basePaid - baseRefunded,
        balance: Math.round(baseLines + baseAdj - basePaid + baseRefunded)
      },
      status: inv.status === "Void" ? "Void"
        : total > 0 && settled >= total ? "Paid"
        : settled > 0 ? "Partially paid" : "Unpaid"
    };
  }

  LHMS.billingCore = { number: invoiceNumber, totals: invoiceTotals };

  /* ---------------- finance core ---------------- */
  // The dashboard, the store and the tests all read money through these rules,
  // so "revenue", "cash" and "owed" cannot drift apart page by page:
  //
  //  • Revenue is EARNED, not collected: a non-void charge counts on the day it
  //    was posted, at the amount recorded then. Re-pricing later moves quotes,
  //    never history.
  //  • A hall booking with no room account earns on its event date, from the
  //    lines it was sold at. Once a booking is Cancelled or Released it earns
  //    nothing but its retention fee.
  //  • Tax and service charge are billed, not earned, so they sit outside
  //    revenue and are reported as their own figure.
  //  • Cash is what the till took in the window, less what was handed back,
  //    whether it landed on a folio or against a document.
  //  • A debt is counted exactly once. A charge copied onto an invoice stays on
  //    the folio, so guest debt is measured at the folio — invoices only add
  //    their own balance when they belong to a booking with no folio.
  //  • Only APPROVED expenses reach the result. A recorded line is a claim
  //    until a second signature lets it in.
  var DEPT_BUCKETS = {
    "Rooms": "rooms", "Events & Banqueting": "events", "Food & Beverage": "restaurant", "Laundry": "laundry"
  };
  var TAX_DEPT = "Taxes & service";

  function inRange(date, from, to) { return !!date && date >= from && date <= to; }

  function periodOf(day, days) {
    var to = day;
    var from = U.addDays(day, -(days - 1));
    return {
      from: from, to: to, days: days,
      prevFrom: U.addDays(from, -days), prevTo: U.addDays(from, -1)
    };
  }

  function pctDelta(now, before) {
    if (!before) return now ? 100 : 0;
    return Math.round((now - before) / Math.abs(before) * 100);
  }

  function sum(list, pick) {
    return (list || []).reduce(function (s, x) { return s + (Number(pick(x)) || 0); }, 0);
  }

  // Everything the statement needs, scoped to one property, computed twice:
  // once for the window and once for the equal window before it.
  function statement(db, propertyId, from, to) {
    var reservations = (db.reservations || []).filter(function (r) { return r.propertyId === propertyId; });
    var resIds = {};
    reservations.forEach(function (r) { resIds[r.id] = r; });
    var invoices = (db.invoices || []).filter(function (i) { return i.propertyId === propertyId; });
    var invIds = {};
    invoices.forEach(function (i) { invIds[i.id] = i; });

    var charges = (db.charges || []).filter(function (c) {
      return !c.voided && resIds[c.reservationId] && inRange(c.date, from, to);
    });
    // Every figure a period total adds up is the base-currency one. A dollar
    // charge and a naira charge share a month, and only the second is addable.
    var byDept = {};
    var buckets = { rooms: 0, events: 0, restaurant: 0, laundry: 0, other: 0 };
    var taxBilled = 0;
    charges.forEach(function (c) {
      if (c.department === TAX_DEPT) { taxBilled += baseOf(c); return; }
      byDept[c.department] = (byDept[c.department] || 0) + baseOf(c);
      var key = DEPT_BUCKETS[c.department] || "other";
      buckets[key] += baseOf(c);
    });

    // A booking the desk bills directly never touches a folio, so its lines are
    // the only place its revenue exists.
    var booked = (db.events || []).filter(function (e) {
      return e.propertyId === propertyId && !e.reservationId &&
        e.status !== "Cancelled" && e.status !== "Released" && inRange(e.date, from, to);
    });
    var eventRevenue = sum(booked, function (e) { return sum(e.lines, baseOf); });
    byDept["Events & Banqueting"] = (byDept["Events & Banqueting"] || 0) + eventRevenue;
    buckets.events += eventRevenue;

    var revenue = sum(charges, function (c) { return c.department === TAX_DEPT ? 0 : baseOf(c); }) + eventRevenue;

    var payments = (db.payments || []).filter(function (p) {
      return inRange(p.date, from, to) &&
        ((p.reservationId && resIds[p.reservationId]) || (p.invoiceId && invIds[p.invoiceId]));
    });
    var byMethod = {};
    payments.forEach(function (p) {
      var k = p.method || "Unspecified";
      byMethod[k] = (byMethod[k] || 0) + baseOf(p);
    });
    var collected = sum(payments, baseOf);
    var reconciled = sum(payments.filter(function (p) { return p.reconciled; }), baseOf);

    var refunds = (db.refunds || []).filter(function (r) {
      return inRange(r.date, from, to) && invIds[r.invoiceId];
    });
    var refunded = sum(refunds, baseOf);

    var discounts = 0, adjustments = 0;
    invoices.forEach(function (inv) {
      (inv.adjustments || []).forEach(function (a) {
        if (!inRange(String(a.at || "").slice(0, 10), from, to)) return;
        var v = baseOf(a);
        if (v < 0) discounts += -v; else adjustments += v;
      });
    });

    // Guest debt first (folio, already net of every payment on the booking),
    // then the standalone documents that no folio carries. Both sides are
    // indexed in one pass so a 12-month statement stays a single scan.
    var billedByRes = {}, paidByRes = {};
    (db.charges || []).forEach(function (c) {
      if (c.voided) return;
      billedByRes[c.reservationId] = (billedByRes[c.reservationId] || 0) + baseOf(c);
    });
    (db.payments || []).forEach(function (p) {
      if (!p.reservationId) return;
      paidByRes[p.reservationId] = (paidByRes[p.reservationId] || 0) + baseOf(p);
    });
    var guestOwed = 0, prepayments = 0;
    reservations.forEach(function (r) {
      if (r.status === "Cancelled" || r.status === "No show") return;
      var owed = Math.round((billedByRes[r.id] || 0) - (paidByRes[r.id] || 0));
      if (owed > 0) guestOwed += owed; else prepayments += -owed;
    });
    var docOwed = 0, billed = 0, collectedOnDocs = 0;
    invoices.forEach(function (inv) {
      if (inv.status === "Void") return;
      var t = invoiceTotals(inv,
        (db.payments || []).filter(function (p) { return p.invoiceId === inv.id; }),
        (db.refunds || []).filter(function (r) { return r.invoiceId === inv.id; }));
      billed += t.base.total;
      collectedOnDocs += t.base.settled;
      if (inv.kind !== "folio" && t.base.balance > 0) docOwed += t.base.balance;
    });

    var expenses = (db.expenses || []).filter(function (e) {
      return e.propertyId === propertyId && inRange(e.date, from, to);
    });
    var approved = expenses.filter(function (e) { return e.status === "Approved"; });
    var pending = expenses.filter(function (e) { return e.status === "Pending"; });
    var rejected = expenses.filter(function (e) { return e.status === "Rejected"; });
    var expByCat = {};
    approved.forEach(function (e) { expByCat[e.category] = (expByCat[e.category] || 0) + baseOf(e); });

    return {
      from: from, to: to,
      revenue: revenue, byDept: byDept, buckets: buckets, taxBilled: taxBilled,
      eventBookings: booked.length,
      collected: collected, reconciled: reconciled, unreconciled: collected - reconciled,
      byMethod: byMethod,
      paymentCount: payments.length, refunded: refunded, refundCount: refunds.length,
      netCash: collected - refunded,
      discounts: discounts, adjustments: adjustments,
      guestOwed: guestOwed, docOwed: docOwed, outstanding: guestOwed + docOwed,
      prepayments: prepayments, billed: billed, collectedOnDocs: collectedOnDocs,
      expenses: sum(approved, baseOf),
      expensesPending: sum(pending, baseOf),
      expenseCount: expenses.length, pendingCount: pending.length, rejectedCount: rejected.length,
      expByCat: expByCat,
      net: revenue - sum(approved, baseOf)
    };
  }

  // One row per calendar day across the window, built in a single pass so a
  // year of trading costs the same as a week.
  function dailySeries(db, propertyId, from, to) {
    var resIds = {};
    (db.reservations || []).forEach(function (r) { if (r.propertyId === propertyId) resIds[r.id] = true; });
    var invIds = {};
    (db.invoices || []).forEach(function (i) { if (i.propertyId === propertyId) invIds[i.id] = true; });
    var byDay = {};
    function slot(d) {
      if (!byDay[d]) byDay[d] = { date: d, revenue: 0, collected: 0, expenses: 0 };
      return byDay[d];
    }
    (db.charges || []).forEach(function (c) {
      if (c.voided || c.department === TAX_DEPT || !resIds[c.reservationId] || !inRange(c.date, from, to)) return;
      slot(c.date).revenue += baseOf(c);
    });
    (db.events || []).forEach(function (e) {
      if (e.reservationId || e.propertyId !== propertyId || e.status === "Cancelled" || e.status === "Released") return;
      if (!inRange(e.date, from, to)) return;
      slot(e.date).revenue += sum(e.lines, baseOf);
    });
    (db.payments || []).forEach(function (p) {
      if (!inRange(p.date, from, to)) return;
      if (!(p.reservationId && resIds[p.reservationId]) && !(p.invoiceId && invIds[p.invoiceId])) return;
      slot(p.date).collected += baseOf(p);
    });
    (db.expenses || []).forEach(function (e) {
      if (e.propertyId !== propertyId || e.status !== "Approved" || !inRange(e.date, from, to)) return;
      slot(e.date).expenses += baseOf(e);
    });
    var out = [], day = from;
    while (day <= to) {
      out.push(byDay[day] || { date: day, revenue: 0, collected: 0, expenses: 0 });
      day = U.addDays(day, 1);
    }
    return out;
  }

  LHMS.financeCore = {
    statement: statement, period: periodOf, delta: pctDelta, inRange: inRange,
    buckets: DEPT_BUCKETS, taxDepartment: TAX_DEPT, series: dailySeries
  };

  /* ---------------- financial reports ---------------- */
  // A report is a different cut of the rows the statement already adds up, so the
  // totals line of any report has to land on a dashboard figure. Nothing here
  // keeps its own copy of a number, and nothing here formats one either: the page
  // and the CSV export both read the same raw cells.
  function reportScope(db, propertyId, from, to) {
    var reservations = (db.reservations || []).filter(function (r) { return r.propertyId === propertyId; });
    var resIds = {};
    reservations.forEach(function (r) { resIds[r.id] = r; });
    var invoices = (db.invoices || []).filter(function (i) { return i.propertyId === propertyId; });
    var invIds = {};
    invoices.forEach(function (i) { invIds[i.id] = i; });
    return {
      propertyId: propertyId,
      reservations: reservations, resIds: resIds, invoices: invoices, invIds: invIds,
      charges: (db.charges || []).filter(function (c) {
        return !c.voided && resIds[c.reservationId] && inRange(c.date, from, to);
      }),
      payments: (db.payments || []).filter(function (p) {
        return inRange(p.date, from, to) &&
          ((p.reservationId && resIds[p.reservationId]) || (p.invoiceId && invIds[p.invoiceId]));
      }),
      refunds: (db.refunds || []).filter(function (r) {
        return inRange(r.date, from, to) && invIds[r.invoiceId];
      }),
      expenses: (db.expenses || []).filter(function (e) {
        return e.propertyId === propertyId && inRange(e.date, from, to);
      }),
      events: (db.events || []).filter(function (e) {
        return e.propertyId === propertyId && !e.reservationId &&
          e.status !== "Cancelled" && e.status !== "Released" && inRange(e.date, from, to);
      })
    };
  }

  function col(label, type) { return { label: label, type: type || "text" }; }
  function pct(part, whole) { return whole ? Math.round(part / whole * 1000) / 10 : 0; }
  function newest(a, b) { return a[0] < b[0] ? 1 : a[0] > b[0] ? -1 : 0; }
  // The totals line of a report is read out loud, and "1 accounts" is not English.
  function tally(n, word) { return n + " " + word + (n === 1 ? "" : "s"); }

  function rptDeptRevenue(db, from, to, sc, st) {
    var lines = {};
    sc.charges.forEach(function (c) {
      if (c.department === TAX_DEPT) return;
      lines[c.department] = (lines[c.department] || 0) + 1;
    });
    sc.events.forEach(function (e) {
      lines["Events & Banqueting"] = (lines["Events & Banqueting"] || 0) + (e.lines || []).length;
    });
    var rows = Object.keys(st.byDept).map(function (d) {
      return [d, Math.round(st.byDept[d]), lines[d] || 0, pct(st.byDept[d], st.revenue)];
    }).filter(function (r) {
      // A department that raised nothing is not a row in a period report. One
      // that netted against revenue — a loyalty redemption — still is.
      return r[1] !== 0 || r[2] !== 0;
    }).sort(function (a, b) { return b[1] - a[1]; });
    return {
      title: "Revenue by department",
      sub: "What each department earned on the dates the charge was incurred.",
      columns: [col("Department"), col("Revenue earned", "money"), col("Charged lines", "count"), col("Share", "pct")],
      rows: rows,
      totals: ["All departments", st.revenue, sum(rows, function (r) { return r[2]; }), 100],
      note: "Taxes and service charges are billed to the guest and passed on to the authorities, so they never " +
        "appear here. Hall bookings the desk bills without a room account are counted in Events & Banqueting."
    };
  }

  function rptServiceRevenue(db, from, to, sc, st) {
    var catalogue = {};
    (db.services || []).forEach(function (s) { catalogue[s.id] = s; });
    var agg = {};
    function slot(key, name, department) {
      if (!agg[key]) agg[key] = { name: name, department: department, units: 0, lines: 0, amount: 0, list: "" };
      return agg[key];
    }
    sc.charges.forEach(function (c) {
      if (c.department === TAX_DEPT) return;
      var svc = c.serviceId ? catalogue[c.serviceId] : null;
      var a = slot("c:" + (c.serviceId || c.description), svc ? svc.name : c.description, c.department);
      a.units += Number(c.qty) || 1;
      a.lines += 1;
      a.amount += baseOf(c);
      if (c.listName) a.list = c.listName;
    });
    sc.events.forEach(function (e) {
      (e.lines || []).forEach(function (l) {
        var a = slot("e:" + l.name, l.name, "Events & Banqueting");
        a.units += Number(l.qty) || 1;
        a.lines += 1;
        a.amount += baseOf(l);
        a.list = a.list || "Event booking";
      });
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k];
      return [a.name, a.department, a.units, a.lines, Math.round(a.amount), a.list || "No price record"];
    }).sort(function (x, y) { return y[4] - x[4]; });
    return {
      title: "Revenue by service",
      sub: "The same revenue split by what was actually sold, with the price list each line was taken from.",
      columns: [col("Service"), col("Department"), col("Units sold", "count"), col("Lines", "count"),
        col("Revenue earned", "money"), col("Priced from")],
      rows: rows,
      totals: [tally(rows.length, "service"), "", sum(rows, function (r) { return r[2]; }),
        sum(rows, function (r) { return r[3]; }), st.revenue, ""],
      note: "A line reading “No price record” was posted by hand rather than quoted by the pricing engine — " +
        "it is real revenue, but nothing upstream can re-derive what it should have cost."
    };
  }

  function rptPaymentMethods(db, from, to, sc, st) {
    var agg = {};
    sc.payments.forEach(function (p) {
      var k = p.method || "Unspecified";
      if (!agg[k]) agg[k] = { count: 0, amount: 0, matched: 0 };
      agg[k].count += 1;
      agg[k].amount += baseOf(p);
      if (p.reconciled) agg[k].matched += baseOf(p);
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k];
      return [k, a.count, Math.round(a.amount), Math.round(a.matched), Math.round(a.amount - a.matched),
        pct(a.amount, st.collected)];
    }).sort(function (x, y) { return y[2] - x[2]; });
    return {
      title: "Revenue by payment method",
      sub: "Cash the property took in the window, split by how it arrived and whether the bank has confirmed it.",
      columns: [col("Method"), col("Receipts", "count"), col("Collected", "money"), col("Bank-matched", "money"),
        col("Unmatched", "money"), col("Share", "pct")],
      rows: rows,
      totals: ["All methods", st.paymentCount, st.collected, st.reconciled, st.unreconciled, 100],
      note: "This is money taken in, not revenue earned: a deposit received today for a stay next month lands here " +
        "and nowhere in revenue. Refunds paid back are a separate report."
    };
  }

  function rptDailyCash(db, from, to, sc, st) {
    var byDay = {};
    function slot(d) {
      if (!byDay[d]) byDay[d] = { date: d, receipts: 0, collected: 0, matched: 0, refunded: 0 };
      return byDay[d];
    }
    sc.payments.forEach(function (p) {
      var s = slot(p.date);
      s.receipts += 1;
      s.collected += baseOf(p);
      if (p.reconciled) s.matched += baseOf(p);
    });
    sc.refunds.forEach(function (r) { slot(r.date).refunded += baseOf(r); });
    var rows = [], day = from;
    while (day <= to) {
      var s = byDay[day] || { date: day, receipts: 0, collected: 0, matched: 0, refunded: 0 };
      rows.push([s.date, s.receipts, Math.round(s.collected), Math.round(s.matched),
        Math.round(s.collected - s.matched), Math.round(s.refunded), Math.round(s.collected - s.refunded)]);
      day = U.addDays(day, 1);
    }
    return {
      title: "Daily cash collection",
      sub: "One row for every day in the window, quiet days included, so a gap is visible instead of smoothed away.",
      columns: [col("Date", "date"), col("Receipts", "count"), col("Collected", "money"),
        col("Bank-matched", "money"), col("Unmatched", "money"), col("Refunded out", "money"),
        col("Net cash", "money")],
      rows: rows.sort(newest),
      totals: ["Every day in the window", st.paymentCount, st.collected, st.reconciled, st.unreconciled,
        st.refunded, st.netCash],
      note: "Net cash is receipts dated that day less refunds dated that day. It says nothing about what was " +
        "earned on the day — that is the revenue report."
    };
  }

  function rptOutstanding(db, from, to, sc, st) {
    var names = {};
    (db.guests || []).forEach(function (g) { names[g.id] = g.name; });
    var billedByRes = {}, paidByRes = {}, lastOn = {};
    (db.charges || []).forEach(function (c) {
      if (c.voided) return;
      billedByRes[c.reservationId] = (billedByRes[c.reservationId] || 0) + baseOf(c);
      if (!lastOn[c.reservationId] || c.date > lastOn[c.reservationId]) lastOn[c.reservationId] = c.date;
    });
    (db.payments || []).forEach(function (p) {
      if (!p.reservationId) return;
      paidByRes[p.reservationId] = (paidByRes[p.reservationId] || 0) + baseOf(p);
    });
    // The balances below are a live position, replayed to no date but today: a
    // folio line posted after the window closed is still owed. Age counts to the
    // same day, or a report of a past window would age every account to zero.
    var asAt = (db.meta && db.meta.day) || to;
    var rows = [];
    sc.reservations.forEach(function (r) {
      if (r.status === "Cancelled" || r.status === "No show") return;
      var billed = Math.round(billedByRes[r.id] || 0), paid = Math.round(paidByRes[r.id] || 0);
      if (billed - paid <= 0) return;
      rows.push([names[r.guestId] || "Guest", "Guest folio", r.reference,
        lastOn[r.id] || r.checkIn, billed, paid, billed - paid, U.nights(lastOn[r.id] || r.checkIn, asAt)]);
    });
    sc.invoices.forEach(function (inv) {
      if (inv.kind === "folio" || inv.status === "Void") return;
      var t = invoiceTotals(inv,
        (db.payments || []).filter(function (p) { return p.invoiceId === inv.id; }),
        (db.refunds || []).filter(function (r) { return r.invoiceId === inv.id; }));
      if (t.balance <= 0) return;
      rows.push([inv.title, "Document", inv.number, inv.date, t.total, t.settled, t.balance, U.nights(inv.date, asAt)]);
    });
    rows.sort(function (x, y) { return y[6] - x[6]; });
    return {
      title: "Outstanding balances",
      sub: "Every account the property is still owed money on, the largest debt first.",
      columns: [col("Account"), col("Carried on"), col("Reference"), col("Last posted", "date"),
        col("Billed", "money"), col("Settled", "money"), col("Balance", "money"), col("Age (days)", "count")],
      rows: rows,
      totals: [tally(rows.length, "account"), "", "", "", sum(rows, function (r) { return r[4]; }),
        sum(rows, function (r) { return r[5]; }), st.outstanding, ""],
      note: "This is a position taken on " + U.pretty(asAt, "medium") + ", not a flow through the window: an " +
        "account that owed money before the window opened is listed here, and one that settles after it is not " +
        "yet off the list. A charge copied onto an invoice stays on the folio, so it is counted once and never twice."
    };
  }

  function rptDiscountsRefunds(db, from, to, sc, st) {
    var numbers = {};
    sc.invoices.forEach(function (inv) { numbers[inv.id] = inv; });
    var rows = [];
    sc.refunds.forEach(function (r) {
      var inv = numbers[r.invoiceId] || {};
      rows.push([r.date, "Refund", inv.number || "—", baseOf(r), r.method, r.by, r.reason]);
    });
    sc.invoices.forEach(function (inv) {
      (inv.adjustments || []).forEach(function (a) {
        var day = String(a.at || "").slice(0, 10);
        if (!inRange(day, from, to)) return;
        rows.push([day, baseOf(a) < 0 ? "Discount" : "Adjustment", inv.number, Math.abs(baseOf(a)),
          a.label, a.by, a.reason]);
      });
    });
    rows.sort(newest);
    return {
      title: "Discounts and refunds",
      sub: "Every reduction of what a guest owes, with the person who authorised it and why.",
      columns: [col("Date", "date"), col("Type"), col("Document"), col("Amount", "money"),
        col("Label or method"), col("Authorised by"), col("Reason")],
      rows: rows,
      totals: ["Given back in the window", "", "", st.refunded + st.discounts + st.adjustments, "", "", ""],
      note: "Refunds " + U.money(st.refunded) + ", discounts " + U.money(st.discounts) + " and other adjustments " +
        U.money(st.adjustments) + ". A refund never deletes the payment it reverses, so both sides stay on the record."
    };
  }

  function rptExpenses(db, from, to, sc, st) {
    var agg = {};
    sc.expenses.forEach(function (e) {
      if (!agg[e.category]) agg[e.category] = { lines: 0, approved: 0, pending: 0, rejected: 0 };
      var a = agg[e.category];
      a.lines += 1;
      a[e.status === "Approved" ? "approved" : e.status === "Pending" ? "pending" : "rejected"] += baseOf(e);
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k];
      return [k, a.lines, Math.round(a.approved), Math.round(a.pending), Math.round(a.rejected),
        Math.round(a.approved + a.pending + a.rejected)];
    }).sort(function (x, y) { return y[2] - x[2]; });
    return {
      title: "Operating expenses",
      sub: "What the property spent, split by whether a second signature has cleared it into the result.",
      columns: [col("Category"), col("Lines", "count"), col("Approved", "money"),
        col("Awaiting decision", "money"), col("Refused", "money"), col("All recorded", "money")],
      rows: rows,
      totals: ["All categories", sc.expenses.length, st.expenses, st.expensesPending,
        sum(sc.expenses.filter(function (e) { return e.status === "Rejected"; }), baseOf),
        sum(sc.expenses, baseOf)],
      note: "Only the approved column reaches the net operating result. A recorded cost is a claim until someone " +
        "with the approval right signs it, and a refusal stays on the ledger with its reason."
    };
  }

  function rptTaxes(db, from, to, sc, st) {
    var rules = {};
    (db.taxRules || []).forEach(function (r) { rules[r.id] = r; });
    var agg = {};
    sc.charges.forEach(function (c) {
      if (c.department !== TAX_DEPT) return;
      var key = c.taxRuleId || c.description;
      if (!agg[key]) agg[key] = { lines: 0, amount: 0, label: c.description, rule: rules[c.taxRuleId] };
      agg[key].lines += 1;
      agg[key].amount += baseOf(c);
    });
    var rows = Object.keys(agg).map(function (k) {
      var a = agg[k];
      return [a.rule ? a.rule.name : a.label, a.rule ? a.rule.pct + "%" : "—", a.rule ? a.rule.order : "—",
        a.lines, Math.round(a.amount), pct(a.amount, st.taxBilled)];
    }).sort(function (x, y) { return y[4] - x[4]; });
    return {
      title: "Tax and service-charge summary",
      sub: "What was billed on behalf of the authorities and the house, by rule, in the window.",
      columns: [col("Rule"), col("Rate"), col("Applied at step", "count"), col("Billed lines", "count"),
        col("Amount billed", "money"), col("Share", "pct")],
      rows: rows,
      totals: ["All rules", "", "", sum(rows, function (r) { return r[3]; }), st.taxBilled, 100],
      note: "Revenue before these charges was " + U.money(st.revenue) + ", so the guest was billed " +
        U.money(st.revenue + st.taxBilled) + " in total. The rules apply in order, each on the running total, " +
        "which is why VAT lands on top of the service charge."
    };
  }

  function rptPriceHistory(db, from, to, sc, st) {
    var names = {};
    (db.services || []).forEach(function (s) { names[s.id] = s.name; });
    var lists = {};
    (db.priceLists || []).forEach(function (l) { lists[l.id] = l.name; });
    var rows = (db.priceHistory || []).filter(function (h) {
      return inRange(String(h.at || "").slice(0, 10), from, to);
    // Ordered by the moment, not the day: several changes can share one date.
    }).sort(function (a, b) { return a.at < b.at ? 1 : a.at > b.at ? -1 : 0; }).map(function (h) {
      var was = h.from ? h.from.amount : null;
      // Each half is read in the money it was counted in. The two halves of one
      // entry always share a currency — a re-denominated row makes its own entry
      // for the move — so the percentage never spans two monies.
      var cur = (h.to && h.to.currency) || "NGN";
      return [String(h.at).slice(0, 10), names[h.serviceId] || h.serviceId, lists[h.listId] || "—",
        was === null ? "New price" : U.money(was, (h.from && h.from.currency) || cur),
        U.money(h.to.amount, cur),
        was === null ? null : pct(h.to.amount - was, was), h.by, h.reason];
    }).sort(newest);
    return {
      title: "Price-change history",
      sub: "Every amendment made to the catalogue in the window, with the reason it was demanded. Each line is printed in the money that row sells in.",
      columns: [col("Changed on", "date"), col("Service"), col("Price list"), col("Previous", "money"),
        col("New", "money"), col("Change", "pct"), col("Changed by"), col("Reason")],
      rows: rows,
      totals: [tally(rows.length, "change"), "", "", "", "", "", "", ""],
      note: "None of these changes rewrote a posted charge. A booking, an order or a folio line keeps the amount " +
        "and the price record it was taken at, which is what makes the revenue reports above auditable."
    };
  }

  function rptProfitability(db, from, to, sc, st) {
    var months = {};
    dailySeries(db, sc.propertyId, from, to).forEach(function (d) {
      var key = String(d.date).slice(0, 7);
      if (!months[key]) months[key] = { key: key, revenue: 0, collected: 0, expenses: 0, days: 0 };
      var m = months[key];
      m.revenue += d.revenue;
      m.collected += d.collected;
      m.expenses += d.expenses;
      m.days += 1;
    });
    var rows = Object.keys(months).sort().map(function (k) {
      var m = months[k];
      var result = Math.round(m.revenue - m.expenses);
      // A month with no revenue has no margin to report — 0% would claim a
      // break-even trade rather than an absent one.
      return [U.pretty(m.key + "-01", "month"), Math.round(m.revenue), Math.round(m.collected),
        Math.round(m.expenses), result, m.revenue ? pct(result, m.revenue) : null];
    });
    return {
      title: "Profitability summary",
      sub: "Revenue earned against approved costs, month by month, with the cash that actually moved.",
      columns: [col("Month"), col("Revenue earned", "money"), col("Cash collected", "money"),
        col("Approved costs", "money"), col("Operating result", "money"), col("Margin", "pct")],
      rows: rows,
      totals: ["The whole window", st.revenue, st.collected, st.expenses, st.net, pct(st.net, st.revenue)],
      note: "Costs are recorded against the property, not against a department, so this is the property's margin. " +
        "A departmental margin would need costs split by department, which nothing here claims to know."
    };
  }

  var REPORTS = {
    "dept-revenue": { label: "Revenue by department", icon: "grid", group: "Revenue", build: rptDeptRevenue },
    "service-revenue": { label: "Revenue by service", icon: "list", group: "Revenue", build: rptServiceRevenue },
    "payment-method": { label: "Revenue by payment method", icon: "card", group: "Cash", build: rptPaymentMethods },
    "daily-cash": { label: "Daily cash collection", icon: "calendar", group: "Cash", build: rptDailyCash },
    "outstanding": { label: "Outstanding balances", icon: "file", group: "Debts", build: rptOutstanding },
    "discounts-refunds": { label: "Discounts and refunds", icon: "refresh", group: "Debts", build: rptDiscountsRefunds },
    "expenses": { label: "Operating expenses", icon: "box", group: "Costs", build: rptExpenses },
    "taxes": { label: "Tax and service charges", icon: "receipt", group: "Costs", build: rptTaxes },
    "price-history": { label: "Price-change history", icon: "clock", group: "Controls", build: rptPriceHistory },
    "profitability": { label: "Profitability summary", icon: "trendUp", group: "Controls", build: rptProfitability }
  };

  LHMS.reportCore = {
    keys: Object.keys(REPORTS),
    catalogue: function () {
      return Object.keys(REPORTS).map(function (k) {
        return { key: k, label: REPORTS[k].label, icon: REPORTS[k].icon, group: REPORTS[k].group };
      });
    },
    // One statement and one scoped pass per report, so a report can never be
    // reconciled against a figure computed a different way.
    run: function (db, propertyId, key, from, to) {
      var def = REPORTS[key];
      if (!def) return null;
      var sc = reportScope(db, propertyId, from, to);
      var st = statement(db, propertyId, from, to);
      var out = def.build(db, from, to, sc, st);
      out.key = key;
      out.label = def.label;
      out.icon = def.icon;
      out.from = from;
      out.to = to;
      return out;
    }
  };

  var PILLOWS = ["Memory foam", "Soft feather", "Firm orthopaedic", "Buckwheat", "Hypoallergenic"];  var BEVERAGES = ["Still water", "Sparkling water", "Chamomile tea", "Espresso", "Green tea", "Fresh lime juice"];
  var DIETARY = ["No restrictions", "Vegetarian", "Vegan", "Gluten-free", "Halal", "Low sodium", "Dairy-free"];
  var ALLERGIES = ["None", "Shellfish", "Peanuts", "Tree nuts", "Gluten", "Feathers", "Penicillin", "Lactose"];
  var ROOM_PREFS = ["High floor, away from lift", "Low floor near spa", "Quiet corner", "Away from lift", "Ocean-facing", "Near the pool", "Accessible bathroom"];
  var NEWSPAPERS = ["Financial Times", "The Guardian", "BusinessDay", "Le Monde", "The Wall Street Journal", "None"];
  var COUNTRIES = ["Nigeria", "United Kingdom", "United States", "Ghana", "Kenya", "South Africa", "France", "Germany", "Netherlands", "India", "Singapore", "Japan", "United Arab Emirates", "Italy", "Canada", "Brazil", "Lebanon", "Spain"];

  var FIRST = ["Adaeze", "James", "Fatima", "Tunde", "Sophie", "Michael", "Ngozi", "Ravi", "Elena", "Kwame", "Aisha", "Thomas", "Yuki", "Olumide", "Isabella", "David", "Grace", "Peter", "Amaka", "Chidi", "Sarah", "Omar", "Lucas", "Hannah", "Ibrahim", "Maya", "Daniel", "Priya", "Noah", "Zainab", "Sofia", "Emeka", "Claire", "Femi", "Leila", "Marcus", "Ifeoma", "Sean", "Halima", "Victor"];
  var LAST = ["Nwankwo", "Whitfield", "Al-Hassan", "Bakare", "Laurent", "Chen", "Eze", "Mehta", "Petrova", "Mensah", "Bello", "Berger", "Tanaka", "Adeyemi", "Rossi", "Okon", "Adeleke", "van Dijk", "Obi", "Balogun", "Mitchell", "Haddad", "Silva", "Keller", "Sule", "Kapoor", "Fischer", "Sharma", "Bergen", "Musa", "Marino", "Nnamdi", "Dubois", "Ogunleye", "Nasser", "Reed", "Uche", "Doherty", "Yusuf", "Mbeki"];

  /* ---------------- properties ---------------- */
  var PROPERTIES = [
    { id: "agm", code: "AGM", name: "Aurelia Grand Marina", short: "Grand Marina", city: "Victoria Island, Lagos", country: "Nigeria",
      address: "12 Ozumba Mbadiwe Avenue, Victoria Island", phone: "+234 1 460 8800", email: "reservations@aureliagrand.com",
      tagline: "Waterfront luxury on the Lagos Lagoon", gm: "Ifeoma Okafor", opened: 2019, floors: 4, perFloor: 12,
      typeCounts: { gv: 4, dk: 14, dt: 10, pv: 10, es: 8, ps: 2 }, rateIndex: 1, occupancyTarget: 0.82, star: 5 },
    { id: "ari", code: "ARI", name: "Aurelia Reserve Ikoyi", short: "Reserve Ikoyi", city: "Ikoyi, Lagos", country: "Nigeria",
      address: "4 Glover Road, Ikoyi", phone: "+234 1 271 4400", email: "reserve@aureliagrand.com",
      tagline: "A quiet residence in the heart of Ikoyi", gm: "Chidi Balogun", opened: 2021, floors: 3, perFloor: 10,
      typeCounts: { gv: 2, dk: 10, dt: 6, pv: 6, es: 5, ps: 1 }, rateIndex: 0.94, occupancyTarget: 0.76, star: 5 },
    { id: "apa", code: "APA", name: "Aurelia Palms Abuja", short: "Palms Abuja", city: "Maitama, Abuja", country: "Nigeria",
      address: "9 Gana Street, Maitama", phone: "+234 9 462 7700", email: "abuja@aureliagrand.com",
      tagline: "Diplomatic calm, minutes from the capital", gm: "Halima Sule", opened: 2023, floors: 3, perFloor: 8,
      typeCounts: { gv: 1, dk: 8, dt: 6, pv: 4, es: 4, ps: 1 }, rateIndex: 0.86, occupancyTarget: 0.72, star: 5 }
  ];

  /* ---------------- rich guest profiles ---------------- */
  var RICH = [
    { f: "Adaeze", l: "Nwankwo", t: "Mrs", country: "Nigeria", city: "Lagos", tier: "Platinum", job: "Group CEO, Meridian Energy", bd: "1981-04-18",
      pillow: "Memory foam", room: "High floor, away from lift", diet: "No restrictions", allergy: "Shellfish", drink: "Sparkling water", paper: "BusinessDay",
      tags: ["Repeat guest", "Allergy", "CEO"], note: "Prefers a quiet corner suite. Always travelling with an executive assistant; cc her on confirmations." },
    { f: "James", l: "Whitfield", t: "Mr", country: "United Kingdom", city: "London", tier: "Platinum", job: "Managing Partner, Aldgate Capital", bd: "1974-11-02",
      pillow: "Firm orthopaedic", room: "Quiet corner", diet: "Vegetarian", allergy: "None", drink: "Espresso", paper: "Financial Times",
      tags: ["Repeat guest", "Vegetarian", "Late checkout"], note: "Requests a 14:00 checkout and a table at Isla for dinner on arrival night." },
    { f: "Fatima", l: "Al-Hassan", t: "Dr", country: "Nigeria", city: "Abuja", tier: "Gold", job: "Permanent Secretary, Ministry of Trade", bd: "1979-07-23",
      pillow: "Hypoallergenic", room: "Low floor near spa", diet: "Halal", allergy: "Feathers", drink: "Green tea", paper: "The Guardian",
      tags: ["VIP", "Family", "Halal"], note: "Travels with two children and a nanny. Feather-free room; arrange adjoining rooms where possible." },
    { f: "Tunde", l: "Bakare", t: "Mr", country: "Nigeria", city: "Lagos", tier: "Gold", job: "COO, Lagos Free Zone", bd: "1976-02-09",
      pillow: "Soft feather", room: "Ocean-facing", diet: "No restrictions", allergy: "Peanuts", drink: "Espresso", paper: "BusinessDay",
      tags: ["Repeat guest", "Whisky"], note: "Keeps a bottle of single malt behind the bar. Prefers the marina-facing rooms." },
    { f: "Sophie", l: "Laurent", t: "Ms", country: "France", city: "Paris", tier: "Gold", job: "Creative Director, Maison Laurent", bd: "1988-09-14",
      pillow: "Soft feather", room: "High floor, away from lift", diet: "Gluten-free", allergy: "Gluten", drink: "Still water", paper: "Le Monde",
      tags: ["Anniversary", "Gluten-free"], note: "Celebrating an anniversary in November. Send a handwritten card and macarons on arrival." },
    { f: "Michael", l: "Chen", t: "Mr", country: "Singapore", city: "Singapore", tier: "Silver", job: "Senior Consultant, Bain & Company", bd: "1985-12-30",
      pillow: "Memory foam", room: "Quiet corner", diet: "No restrictions", allergy: "None", drink: "Green tea", paper: "The Wall Street Journal",
      tags: ["Frequent flyer"], note: "Works late; requests extra towels and a desk lamp. Never disturb before 09:00." },
    { f: "Ngozi", l: "Eze", t: "Dr", country: "Nigeria", city: "Enugu", tier: "Platinum", job: "Consultant Cardiologist", bd: "1980-06-05",
      pillow: "Firm orthopaedic", room: "Away from lift", diet: "Low sodium", allergy: "Penicillin", drink: "Chamomile tea", paper: "The Guardian",
      tags: ["Repeat guest", "Wellness"], note: "Books a 60-minute deep tissue massage on every stay. Medical note: penicillin allergy." },
    { f: "Ravi", l: "Mehta", t: "Mr", country: "India", city: "Mumbai", tier: "Gold", job: "Director, Sun Pharma International", bd: "1972-03-21",
      pillow: "Buckwheat", room: "High floor, away from lift", diet: "Vegan", allergy: "Lactose", drink: "Green tea", paper: "Financial Times",
      tags: ["Vegan", "Early breakfast"], note: "Requires a vegan breakfast before 07:00. Ayurvedic tea stocked in the room." },
    { f: "Elena", l: "Petrova", t: "Ms", country: "United Arab Emirates", city: "Dubai", tier: "Silver", job: "Art Advisor", bd: "1986-08-11",
      pillow: "Hypoallergenic", room: "Ocean-facing", diet: "No restrictions", allergy: "Lactose", drink: "Espresso", paper: "None",
      tags: ["Art collection"], note: "Travelling for the Art X fair; needs secure storage for two crated works." },
    { f: "Kwame", l: "Mensah", t: "Mr", country: "Ghana", city: "Accra", tier: "Gold", job: "Head of Corporate Banking, Stanbic", bd: "1978-01-27",
      pillow: "Firm orthopaedic", room: "High floor, away from lift", diet: "No restrictions", allergy: "Shellfish", drink: "Still water", paper: "Financial Times",
      tags: ["Golf", "Repeat guest"], note: "Books a golf transfer for Saturday mornings. Shellfish allergy — flag to all outlets." },
    { f: "Aisha", l: "Bello", t: "Mrs", country: "Nigeria", city: "Kano", tier: "Platinum", job: "Founder, Bello Textiles", bd: "1983-10-08",
      pillow: "Memory foam", room: "Near the pool", diet: "Halal", allergy: "None", drink: "Chamomile tea", paper: "BusinessDay",
      tags: ["Spa", "VIP"], note: "Regular in the spa — prefers therapist Amara. Always books the Garden Villa for privacy." },
    { f: "Thomas", l: "Berger", t: "Mr", country: "Germany", city: "Munich", tier: "Silver", job: "Principal Engineer, Siemens", bd: "1970-05-16",
      pillow: "Firm orthopaedic", room: "Quiet corner", diet: "No restrictions", allergy: "None", drink: "Espresso", paper: "None",
      tags: ["Early riser"], note: "Requests a firm mattress topper and a quiet room away from the service lift." },
    { f: "Yuki", l: "Tanaka", t: "Ms", country: "Japan", city: "Tokyo", tier: "Gold", job: "Design Director, Kengo Kuma & Associates", bd: "1989-02-14",
      pillow: "Buckwheat", room: "Ocean-facing", diet: "No restrictions", allergy: "None", drink: "Green tea", paper: "None",
      tags: ["Fragrance-free"], note: "Fragrance-free room — no diffusers, no scented linen spray. Matcha in the minibar." },
    { f: "Olumide", l: "Adeyemi", t: "Mr", country: "Nigeria", city: "Ibadan", tier: "Silver", job: "Managing Counsel, Aluko & Oyebode", bd: "1977-09-03",
      pillow: "Soft feather", room: "High floor, away from lift", diet: "No restrictions", allergy: "None", drink: "Fresh lime juice", paper: "The Guardian",
      tags: ["Late arrival"], note: "Usually arrives after 23:00. Keep the kitchen informed for a late supper." },
    { f: "Isabella", l: "Rossi", t: "Ms", country: "Italy", city: "Milan", tier: "Platinum", job: "Owner, Cantina Rossi", bd: "1982-07-19",
      pillow: "Soft feather", room: "Quiet corner", diet: "No restrictions", allergy: "Tree nuts", drink: "Sparkling water", paper: "None",
      tags: ["Wine", "Late dinner"], note: "Hosts private wine dinners in the cellar. Tree nut allergy. Books dinner at 21:00." },
    { f: "David", l: "Okon", t: "Mr", country: "Nigeria", city: "Port Harcourt", tier: "Silver", job: "Operations Director, Air Peace", bd: "1984-04-06",
      pillow: "Memory foam", room: "Away from lift", diet: "No restrictions", allergy: "None", drink: "Still water", paper: "BusinessDay",
      tags: ["Gym", "Early flight"], note: "Uses the gym at 05:30 and needs a protein breakfast to go. Usually on a 07:00 flight." },
    { f: "Grace", l: "Adeleke", t: "Ms", country: "Nigeria", city: "Lagos", tier: "Gold", job: "Editor-in-Chief, The Lede", bd: "1990-11-11",
      pillow: "Hypoallergenic", room: "Ocean-facing", diet: "Vegan", allergy: "None", drink: "Fresh lime juice", paper: "The Guardian",
      tags: ["Vegan", "Birthday"], note: "Birthday in November. Vegan menu available at all outlets; send a plant-based amenity." },
    { f: "Peter", l: "van Dijk", t: "Mr", country: "Netherlands", city: "Amsterdam", tier: "Gold", job: "VP Chartering, Maersk", bd: "1975-12-12",
      pillow: "Firm orthopaedic", room: "High floor, away from lift", diet: "No restrictions", allergy: "None", drink: "Sparkling water", paper: "Financial Times",
      tags: ["Repeat guest", "Late checkout"], note: "Negotiated corporate rate via Maersk travel desk. Late checkout until 16:00." }
  ];

  function tierFor(i) { return i % 11 === 0 ? "Gold" : i % 4 === 0 ? "Silver" : "Member"; }

  function buildGuests() {
    var guests = [];
    var usedNames = {};
    RICH.forEach(function (g, i) {
      var name = g.f + " " + g.l;
      usedNames[name] = true;
      guests.push({
        id: "gst_" + (i + 1),
        title: g.t, firstName: g.f, lastName: g.l, name: name,
        email: (g.f + "." + g.l).toLowerCase().replace(/[^a-z.]/g, "") + "@example.com",
        phone: "+234 80" + (30000000 + i * 137911).toString().slice(0, 8),
        country: g.country, city: g.city,
        tier: g.tier, job: g.job, birthday: g.bd,
        since: 2018 + (i % 6),
        idType: g.country === "Nigeria" ? "National ID" : "International passport",
        idNumber: g.country === "Nigeria" ? "NIN-" + (100000000 + i * 7919) : "P" + (4000000 + i * 3571),
        preferences: { pillow: g.pillow, room: g.room, dietary: g.diet, allergies: g.allergy, beverage: g.drink, newspaper: g.paper, turndown: i % 3 === 0 ? "Evening turndown" : "On request" },
        consent: { marketing: g.tier !== "Member", dataSharing: i % 5 !== 0, profiling: true },
        tags: g.tags, notes: [{ id: "note_seed_" + i, text: g.note, by: "Front Office", date: U.addDays(U.today(), -(20 + i)) }],
        loyaltyPoints: 40000 + i * 18750, language: g.country === "France" ? "French" : "English",
        featured: true
      });
    });
    for (var i = 0; i < 104; i++) {
      var fi = i % FIRST.length;
      var li = Math.floor(i / FIRST.length) % LAST.length;
      // The guest portal signs people in by name, so no filler profile may
      // shadow a name the seeded profiles already use.
      for (var hop = 0; hop < LAST.length && usedNames[FIRST[fi] + " " + LAST[li]]; hop++) {
        li = (li + 1) % LAST.length;
      }
      var f = FIRST[fi];
      var l = LAST[li];
      usedNames[f + " " + l] = true;
      var tier = tierFor(i);
      var country = COUNTRIES[i % COUNTRIES.length];
      guests.push({
        id: "gst_f" + (i + 1),
        title: i % 3 === 0 ? "Mrs" : "Mr", firstName: f, lastName: l, name: f + " " + l,
        email: (f + "." + l).toLowerCase().replace(/[^a-z.]/g, "") + (i + 1) + "@example.com",
        phone: "+234 81" + (20000000 + i * 913711).toString().slice(0, 8),
        country: country, city: country === "Nigeria" ? (i % 2 ? "Lagos" : "Abuja") : country,
        tier: tier, job: ["Consultant", "Entrepreneur", "Civil servant", "Architect", "Investor", "Journalist", "Engineer"][i % 7],
        birthday: "19" + (70 + (i % 25)) + "-" + U.pad((i % 12) + 1) + "-" + U.pad((i % 27) + 1),
        since: 2019 + (i % 5), idType: "International passport", idNumber: "P" + (5000000 + i * 613),
        preferences: {
          pillow: PILLOWS[i % PILLOWS.length], room: ROOM_PREFS[i % ROOM_PREFS.length],
          dietary: DIETARY[i % DIETARY.length], allergies: ALLERGIES[i % ALLERGIES.length],
          beverage: BEVERAGES[i % BEVERAGES.length], newspaper: NEWSPAPERS[i % NEWSPAPERS.length],
          turndown: i % 2 ? "Evening turndown" : "On request"
        },
        consent: { marketing: i % 3 !== 0, dataSharing: i % 4 === 0, profiling: true },
        tags: i % 9 === 0 ? ["Repeat guest"] : [], notes: [],
        loyaltyPoints: 1200 + i * 430, language: "English", featured: false
      });
    }
    return guests;
  }

  function buildRooms() {
    var rooms = [];
    PROPERTIES.forEach(function (p) {
      var sequence = [];
      ["gv", "dk", "dt", "pv", "es", "ps"].forEach(function (t) {
        for (var i = 0; i < (p.typeCounts[t] || 0); i++) sequence.push(t);
      });
      sequence.forEach(function (typeId, idx) {
        var floor = Math.floor(idx / p.perFloor) + 1;
        var pos = (idx % p.perFloor) + 1;
        var number = String(floor) + U.pad(pos);
        rooms.push({
          id: p.id + "-" + number, propertyId: p.id, number: number, floor: floor,
          typeId: typeId, hk: "Clean", oooReason: "", features: []
        });
      });
      // seed a couple of out-of-order rooms
      var propRooms = rooms.filter(function (r) { return r.propertyId === p.id; });
      if (propRooms.length > 12) {
        propRooms[propRooms.length - 3].hk = "Out of order";
        propRooms[propRooms.length - 3].oooReason = "Bathroom re-grouting";
        propRooms[propRooms.length - 7].hk = "Out of service";
        propRooms[propRooms.length - 7].oooReason = "Awaiting replacement of AC compressor";
      }
    });
    return rooms;
  }

  function buildStaff() {
    var base = [
      { name: "Ifeoma Okafor", role: "Manager", dept: "Executive", title: "General Manager", email: "ifeoma.okafor@aureliagrand.com", shift: "08:00 – 18:00" },
      { name: "Adamu Bello", role: "Front Desk", dept: "Front Office", title: "Front Office Manager", email: "adamu.bello@aureliagrand.com", shift: "06:00 – 15:00" },
      { name: "Zainab Yusuf", role: "Front Desk", dept: "Front Office", title: "Front Desk Agent", email: "zainab.yusuf@aureliagrand.com", shift: "14:00 – 23:00" },
      { name: "Grace Mensah", role: "Housekeeping", dept: "Housekeeping", title: "Housekeeping Supervisor", email: "grace.mensah@aureliagrand.com", shift: "07:00 – 16:00" },
      { name: "Blessing Uche", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "blessing.uche@aureliagrand.com", shift: "08:00 – 17:00" },
      { name: "Samuel Nnamdi", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "samuel.nnamdi@aureliagrand.com", shift: "08:00 – 17:00" },
      { name: "Tobi Ogunleye", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "tobi.ogunleye@aureliagrand.com", shift: "10:00 – 19:00" },
      { name: "Chiamaka Obi", role: "Revenue", dept: "Revenue", title: "Revenue Manager", email: "chiamaka.obi@aureliagrand.com", shift: "09:00 – 18:00" },
      { name: "Emeka Balogun", role: "Finance Manager", dept: "Finance", title: "Financial Controller", email: "emeka.balogun@aureliagrand.com", shift: "08:00 – 17:00" },
      { name: "Leila Haddad", role: "Manager", dept: "Food & Beverage", title: "F&B Director", email: "leila.haddad@aureliagrand.com", shift: "11:00 – 22:00" },
      { name: "Victor Uche", role: "Housekeeping", dept: "Engineering", title: "Maintenance Technician", email: "victor.uche@aureliagrand.com", shift: "08:00 – 17:00" },
      { name: "Amara Nwosu", role: "Manager", dept: "Spa & Wellness", title: "Spa Manager", email: "amara.nwosu@aureliagrand.com", shift: "09:00 – 18:00" }
    ];
    var staff = [];
    ["agm", "ari", "apa"].forEach(function (pid, pi) {
      base.forEach(function (s, i) {
        if (pi > 0 && i > 6) return;
        staff.push({
          id: "stf_" + pid + "_" + i, propertyId: pid, name: s.name, email: pi === 0 ? s.email : s.email.replace("@", "+" + pid + "@"),
          role: s.role, department: s.dept, title: s.title, phone: "+234 80" + (41000000 + pi * 100000 + i * 7919).toString().slice(0, 8),
          shift: s.shift, status: "Active", started: "202" + (i % 4) + "-0" + ((i % 9) + 1) + "-12"
        });
      });
    });
    return staff;
  }

  /* ---------------- seed generator ---------------- */
  LHMS.buildSeed = function () {
    var seed = 20261027;
    function rnd() {
      seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
    function pick(arr) { return arr[Math.floor(rnd() * arr.length)]; }
    function shuffle(arr) { var a = arr.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(rnd() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    function round50(n) { return Math.round(n / 50) * 50; }

    var today = U.today();
    var now = new Date().toISOString();
    var guests = buildGuests();
    var rooms = buildRooms();
    var staff = buildStaff();
    var services = buildServices();
    var prices = buildPrices(now);
    function serviceById(id) { return services.find(function (s) { return s.id === id; }); }
    // Seeded transactions are priced through the same maths the live engine
    // uses, so the seeded data cannot disagree with the price list.
    function priceOf(serviceId, opts) {
      var svc = serviceById(serviceId);
      var hit = LHMS.priceCore.resolve(prices, PRICE_LISTS, serviceId, opts);
      if (!svc || !hit) return null;
      // A hall is quoted as a package or as hours; everything else is the
      // ordinary per-unit maths.
      var a = svc.category === "hall" && !svc.addon
        ? LHMS.priceCore.hallAmount(hit.price, svc, opts)
        : LHMS.priceCore.amount(hit.price, svc, opts);
      return {
        // What the list said before any date or request changed it.
        unit: a.unit, lines: a.lines, added: a.added,
        basePrice: a.basePrice === undefined ? hit.price.amount : a.basePrice,
        package: a.package, packageName: a.packageName, qty: a.qty,
        price: hit.price, list: hit.list, service: svc
      };
    }
    function taxAmount(tax, kind) {
      var line = tax.lines.find(function (l) { return l.rule.kind === kind; });
      return line ? line.amount : 0;
    }
    var reservations = [];
    var charges = [];
    var payments = [];
    var events = [];
    var laundry = [];
    var tasks = [];
    var activity = [];
    var reviews = [];
    var lostFound = [];
    var guestPool = shuffle(guests.map(function (g) { return g.id; }));
    var gp = 0;
    function nextGuest() { var id = guestPool[gp % guestPool.length]; gp++; return id; }
    var refSeq = 4800;
    function nextRef(p) { refSeq += ri(1, 9); return p.code + "-" + refSeq; }

    function roomById(id) { return rooms.find(function (r) { return r.id === id; }); }
    function typeById(id) { return ROOM_TYPES.find(function (t) { return t.id === id; }); }
    function planById(id) { return RATE_PLANS.find(function (p) { return p.id === id; }); }
    function guestById(id) { return guests.find(function (g) { return g.id === id; }); }

    var methods = ["Card", "Card", "Card", "Transfer", "Cash", "City ledger"];

    function makeFolio(res, kind) {
      var plan = planById(res.ratePlanId);
      var type = typeById(res.roomTypeId);
      var len = U.nights(res.checkIn, res.checkOut) || 1;
      var extras = [];
      if (rnd() > 0.35) extras.push({ desc: "Breakfast — " + pick(["Isla Restaurant", "In-room dining", "Terrace"]), amount: round50(9500 * ri(1, len)), dept: "Food & Beverage", day: res.checkIn });
      if (rnd() > 0.62) extras.push({ desc: pick(["Minibar consumption", "Sky Bar — evening", "Poolside lunch", "Wine pairing dinner"]), amount: round50(ri(8, 48) * 1000), dept: "Food & Beverage", day: U.addDays(res.checkIn, ri(0, len - 1)) });
      if (rnd() > 0.7) extras.push({ desc: pick(["Spa — 60 min deep tissue", "Spa — couples ritual", "Spa — express facial"]), amount: round50(ri(45, 120) * 1000), dept: "Spa & Wellness", day: U.addDays(res.checkIn, ri(0, len - 1)) });
      if (rnd() > 0.8) extras.push({ desc: "Airport transfer — private sedan", amount: 45000, dept: "Transport", day: res.checkIn });
      if (rnd() > 0.86) extras.push({ desc: "Laundry and pressing", amount: round50(ri(6, 22) * 1000), dept: "Laundry", day: U.addDays(res.checkIn, 1) });

      var roomTotal = 0;
      for (var i = 0; i < len; i++) {
        var day = U.addDays(res.checkIn, i);
        var priced = priceOf("svc_" + type.id, { date: day, modifier: plan.modifier });
        var rate = priced ? priced.unit : 0;
        roomTotal += rate;
        charges.push({
          id: "chg_" + res.id + "_r" + i, reservationId: res.id, date: day,
          description: "Room charge — " + type.name + " (" + (i + 1) + "/" + len + ")",
          department: "Rooms", amount: rate, qty: 1, unitPrice: rate,
          serviceId: "svc_" + type.id, priceId: priced && priced.price.id,
          listId: priced && priced.list.id, listName: priced && priced.list.name, postedBy: "Night audit"
        });
      }
      res.roomTotal = roomTotal;

      extras.forEach(function (ex, i) {
        charges.push({
          id: "chg_" + res.id + "_e" + i, reservationId: res.id, date: ex.day,
          description: ex.desc, department: ex.dept, amount: ex.amount, qty: 1,
          postedBy: ex.dept === "Spa & Wellness" ? "Amara Nwosu" : ex.dept === "Transport" ? "Front desk" : "Isla Restaurant"
        });
      });

      var subtotal = roomTotal + extras.reduce(function (s, e) { return s + e.amount; }, 0);
      var tax = LHMS.priceCore.taxes(TAX_RULES, subtotal, "room");
      tax.lines.forEach(function (t, i) {
        charges.push({
          id: "chg_" + res.id + "_tax" + i, reservationId: res.id, date: res.checkOut,
          description: t.label, department: "Taxes & service", amount: t.amount, qty: 1,
          taxRuleId: t.rule.id, postedBy: "Night audit"
        });
      });
      res.total = subtotal + tax.total;
      res.subtotal = subtotal;
      res.service = taxAmount(tax, "service");
      res.vat = taxAmount(tax, "vat");

      if (kind === "settled") {
        payments.push({ id: "pay_" + res.id, reservationId: res.id, date: res.checkOut, method: pick(methods), amount: res.total, reference: "TX" + ri(100000, 999999), takenBy: "Adamu Bello" });
      } else if (kind === "inhouse") {
        var dep = round50(res.total * (rnd() > 0.55 ? 0.25 : 0.5));
        payments.push({ id: "pay_" + res.id, reservationId: res.id, date: res.checkIn, method: "Card", amount: dep, reference: "TX" + ri(100000, 999999), takenBy: "Zainab Yusuf" });
      } else if (kind === "future") {
        var pct = plan.depositPct / 100;
        if (pct > 0) payments.push({ id: "pay_" + res.id, reservationId: res.id, date: U.addDays(today, -ri(1, 20)), method: "Card", amount: round50(res.total * pct), reference: "TX" + ri(100000, 999999), takenBy: "Web booking" });
      }
    }

    var resSeq = 0;
    PROPERTIES.forEach(function (p) {
      var propRooms = rooms.filter(function (r) { return r.propertyId === p.id; });
      var availableForArrival = [];

      propRooms.forEach(function (room) {
        if (room.hk === "Out of order" || room.hk === "Out of service") return;
        if (rnd() < p.occupancyTarget) {
          var len = ri(1, 7);
          var stayed = ri(0, len - 1);
          var ci = U.addDays(today, -stayed);
          var co = U.addDays(ci, len);
          if (U.nights(today, co) < 1) co = U.addDays(today, 1);
          var guest = nextGuest();
          var res = {
            id: "res_" + (++resSeq) + "_" + p.id, reference: nextRef(p), propertyId: p.id,
            guestId: guest, roomId: room.id, roomTypeId: room.typeId, ratePlanId: pick(["flex", "adv", "corp", "club"]),
            checkIn: ci, checkOut: co, adults: ri(1, 2), children: rnd() > 0.8 ? 1 : 0,
            status: "In-house", channel: pick(CHANNELS), notes: "",
            createdAt: U.addDays(ci, -ri(1, 40)), source: "Seeded reservation", vip: false
          };
          var g = guestById(guest);
          res.vip = g && (g.tier === "Platinum" || g.tier === "Gold");
          if (rnd() > 0.82) res.notes = pick(["High floor requested", "Celebrating an anniversary", "Allergy on file — flag to F&B", "Needs an early breakfast", "Late arrival expected"]);
          reservations.push(res);
          makeFolio(res, "inhouse");
          if (rnd() > 0.55) room.hk = "Occupied";
        } else {
          availableForArrival.push(room);
        }
      });

      // today's departures — move a few in-house checkouts to today
      var inhouse = reservations.filter(function (r) { return r.propertyId === p.id && r.status === "In-house" && r.checkIn < today; });
      shuffle(inhouse).slice(0, p.id === "agm" ? 6 : 4).forEach(function (r) {
        if (r.checkOut > today) {
          var delta = U.nights(today, r.checkOut);
          // shift folio dates so totals still make sense
          r.checkOut = today;
          charges.forEach(function (c) { if (c.reservationId === r.id && c.date > today) c.date = today; });
        }
      });

      // today's arrivals
      var arrivals = p.id === "agm" ? 7 : p.id === "ari" ? 5 : 4;
      shuffle(availableForArrival).slice(0, arrivals).forEach(function (room) {
        var len = ri(1, 4);
        var guest = nextGuest();
        var res = {
          id: "res_" + (++resSeq) + "_" + p.id, reference: nextRef(p), propertyId: p.id,
          guestId: guest, roomId: room.id, roomTypeId: room.typeId, ratePlanId: pick(["flex", "adv", "corp", "club", "ota"]),
          checkIn: today, checkOut: U.addDays(today, len), adults: ri(1, 2), children: rnd() > 0.85 ? 1 : 0,
          status: "Confirmed", channel: pick(CHANNELS), notes: rnd() > 0.7 ? "Early arrival requested — 11:00" : "",
          createdAt: U.addDays(today, -ri(2, 45)), source: "Seeded reservation", vip: false
        };
        var gg = guestById(guest);
        res.vip = gg && (gg.tier === "Platinum" || gg.tier === "Gold");
        reservations.push(res);
        makeFolio(res, "future");
        room.hk = rnd() > 0.5 ? "Clean" : "Dirty";
      });

      // future reservations for the timeline
      var futureRooms = shuffle(propRooms.filter(function (r) {
        return !reservations.some(function (x) { return x.roomId === r.id && (x.status === "In-house" || (x.status === "Confirmed" && x.checkIn <= U.addDays(today, 14))); })
          && r.hk !== "Out of order" && r.hk !== "Out of service";
      }));
      futureRooms.slice(0, Math.round(propRooms.length * 0.34)).forEach(function (room, i) {
        var start = ri(1, 11);
        var len = ri(1, 5);
        var guest = nextGuest();
        var res = {
          id: "res_" + (++resSeq) + "_" + p.id, reference: nextRef(p), propertyId: p.id,
          guestId: guest, roomId: room.id, roomTypeId: room.typeId, ratePlanId: pick(["flex", "adv", "corp", "club"]),
          checkIn: U.addDays(today, start), checkOut: U.addDays(today, start + len),
          adults: ri(1, 2), children: 0, status: "Confirmed", channel: pick(CHANNELS),
          notes: "", createdAt: U.addDays(today, -ri(1, 30)), source: "Seeded reservation", vip: false
        };
        reservations.push(res);
        makeFolio(res, "future");
      });
    });

    // past stays for guest history and analytics
    var pastTarget = 90;
    for (var i = 0; i < pastTarget; i++) {
      var p = pick(PROPERTIES);
      var propRooms = rooms.filter(function (r) { return r.propertyId === p.id; });
      var room = pick(propRooms);
      var ci = U.addDays(today, -ri(2, 75));
      var len = ri(1, 5);
      var co = U.addDays(ci, len);
      if (co > today) co = today;
      if (U.nights(ci, co) < 1) ci = U.addDays(co, -1);
      var guest = nextGuest();
      var res2 = {
        id: "res_p" + i + "_" + p.id, reference: nextRef(p), propertyId: p.id,
        guestId: guest, roomId: room.id, roomTypeId: room.typeId, ratePlanId: pick(["flex", "adv", "corp", "club", "ota"]),
        checkIn: ci, checkOut: co, adults: ri(1, 2), children: 0, status: "Checked out",
        channel: pick(CHANNELS), notes: "", createdAt: U.addDays(ci, -ri(2, 30)), source: "Seeded reservation", vip: false
      };
      reservations.push(res2);
      makeFolio(res2, "settled");
    }

    // guarantee the flagship has a handful of cancelled + waitlist records for the board
    var flagshipRooms = rooms.filter(function (r) { return r.propertyId === "agm" && r.hk !== "Out of order" && r.hk !== "Out of service"; });
    ["Cancelled", "No-show", "Waitlist"].forEach(function (st, ix) {
      var rr = flagshipRooms[ix * 7 + 2];
      reservations.push({
        // A waitlisted stay holds no key until the desk offers it one.
        id: "res_x" + ix, reference: nextRef({ code: "AGM" }), propertyId: "agm", guestId: guests[ix + 20].id,
        roomId: st === "Waitlist" ? null : rr.id, roomTypeId: rr.typeId, ratePlanId: "flex", checkIn: U.addDays(today, ix === 2 ? 2 : -1),
        checkOut: U.addDays(today, ix === 2 ? 4 : 1), adults: 1, children: 0, status: st,
        channel: pick(CHANNELS), notes: st === "Waitlist" ? "Waiting on a Garden Villa cancellation" : "", createdAt: U.addDays(today, -6),
        source: "Seeded reservation", vip: false
      });
    });

    /* The desk's waitlist opens with one live release: the oldest waitlisted
       stay is offered the first room of its type the house can free for its
       dates, on a 24-hour hold. The offer is a record of its own — accepting it
       confirms the stay and bills the nights at that moment, so a waitlist that
       is never taken up leaves no money behind. */
    var waitlistOffers = [];
    (function seedWaitlistOffer() {
      var wait = reservations.filter(function (r) { return r.status === "Waitlist"; })
        .sort(function (a, b) { return String(a.createdAt) < String(b.createdAt) ? -1 : 1; })[0];
      if (!wait) return;
      var free = rooms.filter(function (room) {
        if (room.propertyId !== wait.propertyId || room.typeId !== wait.roomTypeId) return false;
        if (room.hk === "Out of order" || room.hk === "Out of service") return false;
        return !reservations.some(function (r) {
          return r.roomId === room.id && (r.status === "In-house" || r.status === "Confirmed") &&
            r.checkIn < wait.checkOut && r.checkOut > wait.checkIn;
        });
      })[0];
      if (!free) return;
      var offeredAt = new Date(Date.now() - 2 * 3600000).toISOString();
      waitlistOffers.push({
        id: "wlo_seed1", reservationId: wait.id, propertyId: wait.propertyId,
        roomId: free.id, roomTypeId: wait.roomTypeId,
        offeredAt: offeredAt, expiresAt: new Date(Date.now() + 22 * 3600000).toISOString(),
        notifiedAt: offeredAt, status: "Offered", closedAt: null
      });
    })();

    // ---------------- hall bookings ----------------
    // Quoted by the same maths the live events desk uses, and the booking keeps
    // the itemised lines it was sold on. Charges only reach a folio when the
    // event belongs to a reservation; a conference billed to its own account
    // stays an invoice in waiting rather than invented revenue.
    function addonLines(addons, date) {
      var out = [];
      Object.keys(addons || {}).forEach(function (extraId) {
        var qty = addons[extraId];
        var q = priceOf("svc_" + extraId, { date: date, qty: qty });
        if (!q) return;
        out.push({
          kind: "addon", serviceId: q.service.id, name: q.service.name, unit: q.service.unit,
          qty: qty, unitPrice: q.unit, basePrice: q.basePrice, amount: q.lines, currency: q.price.currency,
          priceId: q.price.id, listId: q.list.id, listName: q.list.name
        });
      });
      return out;
    }

    function eventHost(spec, date) {
      if (spec.link === "standalone") return null;
      var pool = reservations.filter(function (r) {
        return r.propertyId === spec.prop && (r.status === "In-house" || r.status === "Confirmed")
          && r.checkIn <= date && r.checkOut > date;
      });
      return pool.length ? pick(pool) : null;
    }

    var EVENT_SEED = [
      { hall: "hall_grand", prop: "agm", title: "Access Bank Leadership Summit", organizer: "Dami Akintula",
        orgEmail: "events@accessbankplc.com", phone: "+234 803 411 2200", guests: 260, in: 2,
        start: "08:00", end: "18:00", package: "full", layout: "Banquet rounds with stage and screen",
        addons: { evt_decor: 1, evt_sound: 1, evt_projector: 1, evt_catering: 260 }, link: "corporate" },
      { hall: "hall_garden", prop: "agm", title: "Laurent — Obi wedding reception", organizer: "Claire Laurent",
        orgEmail: "claire.laurent@gmail.com", phone: "+233 24 887 1120", guests: 110, in: 9,
        start: "16:00", end: "23:00", package: null, layout: "Cocktail layout with terrace lighting",
        addons: { evt_flowers: 2, evt_sound: 1 }, link: "standalone" },
      { hall: "hall_board", prop: "ari", title: "Brandt Group board meeting", organizer: "Oliver Brandt",
        orgEmail: "assistant@brandt-group.de", phone: "+49 30 8845 2210", guests: 14, in: 1,
        start: "09:30", end: "13:30", package: "half", layout: "Board table, still water and notepads",
        addons: { evt_projector: 1 }, link: "inhouse", status: "Hold" },
      // Two halls already delivered. Without them a financial period has no
      // event history at all, and the dashboard would report a department that
      // the property plainly trades in.
      { hall: "hall_grand", prop: "agm", title: "Nigeria LNG quarterly briefing", organizer: "Chinwe Okoro",
        orgEmail: "events@nlng.com", phone: "+234 802 220 7788", guests: 180, in: -12,
        start: "09:00", end: "17:00", package: "full", layout: "Banquet rounds with stage and screen",
        addons: { evt_decor: 1, evt_sound: 1, evt_catering: 180 }, link: "standalone" },
      // 120 is the terrace's licence, not a smaller wedding: this booking used to
      // carry 140 guests, a figure the events form itself refuses to take. The
      // seed has to satisfy the rules the app enforces, or the board shows a
      // booking nobody could make twice.
      { hall: "hall_garden", prop: "agm", title: "Adeyemi — Balogun wedding reception", organizer: "Yewande Balogun",
        orgEmail: "yewande.balogun@gmail.com", phone: "+234 805 118 4400", guests: 120, in: -26,
        start: "15:00", end: "23:00", package: null, layout: "Dining rounds with marquee lighting",
        addons: { evt_flowers: 3, evt_sound: 1, evt_catering: 120 }, link: "standalone" }
    ];

    EVENT_SEED.forEach(function (spec, ix) {
      var hall = HALLS.find(function (h) { return h.id === spec.hall; });
      var date = U.addDays(today, spec.in);
      var hours = U.hoursBetween(spec.start, spec.end);
      var q = priceOf("svc_" + spec.hall, { date: date, package: spec.package, hours: hours });
      if (!hall || !hours || !q) return;
      var lines = [{
        kind: q.package ? "package" : "hourly", serviceId: q.service.id, name: q.service.name,
        unit: q.package ? q.packageName : "hour", qty: q.qty, unitPrice: q.unit, basePrice: q.basePrice,
        amount: q.lines, currency: q.price.currency, priceId: q.price.id, listId: q.list.id, listName: q.list.name
      }].concat(addonLines(spec.addons, date));
      var subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);
      var tax = LHMS.priceCore.taxes(TAX_RULES, subtotal, "hall");
      var byKind = {};
      tax.lines.forEach(function (l) { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
      var sur = q.price.surcharges || {};
      var depositPct = sur.depositPct || 0;
      var host = eventHost(spec, date);
      var evt = {
        id: "evt_" + (ix + 1), propertyId: spec.prop, hallId: spec.hall, hallServiceId: q.service.id,
        hallName: hall.name, capacity: hall.capacity, title: spec.title, organizer: spec.organizer,
        email: spec.orgEmail, phone: spec.phone, guests: spec.guests, layout: spec.layout,
        date: date, start: spec.start, end: spec.end, hours: hours, package: spec.package,
        packageName: q.packageName || "Hourly",
        reservationId: host ? host.id : null, status: spec.status || "Confirmed",
        lines: lines, subtotal: subtotal,
        taxLines: tax.lines.map(function (l) { return { ruleId: l.rule.id, label: l.label, amount: l.amount }; }),
        service: byKind.service || 0, vat: byKind.vat || 0,
        tax: tax.total, total: tax.grand, depositPct: depositPct,
        deposit: LHMS.priceCore.round(tax.grand * depositPct / 100), depositPaid: 0,
        cancelPct: sur.cancelPct || 0, cancelHours: sur.cancelHours || 0, cancelFee: 0, charges: [],
        priceId: q.price.id, listId: q.list.id, listName: q.list.name, currency: q.price.currency,
        createdAt: U.addDays(today, -ri(3, 25)), createdBy: "Events desk", notes: ""
      };
      events.push(evt);
      // A hold reserves the time and agrees no money yet, so it posts nothing.
      if (!host || evt.status !== "Confirmed") return;
      evt.charges = lines.map(function (l, i) {
        charges.push({
          id: "chg_" + evt.id + "_" + i, reservationId: host.id, date: date,
          description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " — " + evt.title,
          department: "Events & Banqueting", amount: l.amount, qty: l.qty, unitPrice: l.unitPrice,
          basePrice: l.basePrice, currency: l.currency, serviceId: l.serviceId, priceId: l.priceId,
          listId: l.listId, listName: l.listName, postedBy: "Events desk"
        });
        return "chg_" + evt.id + "_" + i;
      });
      tax.lines.forEach(function (t, i) {
        var id = "chg_" + evt.id + "_tax" + i;
        charges.push({
          id: id, reservationId: host.id, date: date,
          description: t.label + " — " + evt.title, department: "Taxes & service",
          amount: t.amount, qty: 1, taxRuleId: t.rule.id, postedBy: "Night audit"
        });
        evt.charges.push(id);
      });
      if (evt.status === "Confirmed") {
        evt.depositPaid = evt.deposit;
        payments.push({
          id: "pay_" + evt.id, reservationId: host.id, date: U.addDays(today, -ri(1, 8)),
          method: "Transfer", amount: evt.deposit, reference: "EVT" + ri(100000, 999999), takenBy: "Events desk"
        });
      }
    });

    // ---------------- laundry orders ----------------
    // An order is priced line by line by the engine and keeps those lines, so
    // the express uplift charged at the counter is the one on the invoice later.
    var LAUNDRY_SEED = [
      { items: { ld_shirt: 4, ld_trousers: 2, ld_suit: 1 }, express: true, status: "In progress", hoursAgo: 3 },
      { items: { ld_bedding: 3, ld_towel: 6, ld_load: 1 }, express: false, status: "Ready", hoursAgo: 14 }
    ];

    LAUNDRY_SEED.forEach(function (spec, ix) {
      var host = reservations.filter(function (r) {
        return r.propertyId === "agm" && r.status === "In-house";
      })[ix * 3];
      if (!host) return;
      var room = roomById(host.roomId);
      var lines = [];
      Object.keys(spec.items).forEach(function (itemId) {
        var qty = spec.items[itemId];
        var q = priceOf("svc_" + itemId, { qty: qty, express: spec.express });
        if (!q) return;
        lines.push({
          serviceId: q.service.id, name: q.service.name, unit: q.service.unit, qty: qty,
          unitPrice: q.unit, basePrice: q.basePrice || q.price.amount, added: q.added, amount: q.lines,
          currency: q.price.currency, priceId: q.price.id, listId: q.list.id, listName: q.list.name
        });
      });
      if (!lines.length) return;
      var subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);
      var tax = LHMS.priceCore.taxes(TAX_RULES, subtotal, "laundry");
      // The slowest item sets the collection time; express work is cut in half.
      var mins = lines.reduce(function (m, l) {
        var svc = serviceById(l.serviceId);
        return Math.max(m, (svc && svc.turnaroundMins) || 240);
      }, 60) * (spec.express ? 0.5 : 1);
      var createdAt = new Date(Date.now() - spec.hoursAgo * 3600000).toISOString();
      var order = {
        id: "lda_" + (ix + 1), ref: "LY-" + (7200 + ix + 1), propertyId: "agm",
        reservationId: host.id, guestId: host.guestId, roomId: host.roomId,
        roomNumber: room ? room.number : "", express: spec.express, status: spec.status,
        lines: lines, subtotal: subtotal, tax: tax.total, total: tax.grand,
        currency: "NGN", createdAt: createdAt, dueAt: new Date(new Date(createdAt).getTime() + mins * 60000).toISOString(),
        returnedAt: null, handledBy: ix % 2 ? "Grace Mensah" : "Emeka Nwosu", notes: ""
      };
      order.charges = lines.map(function (l, i) {
        var id = "chg_" + order.id + "_" + i;
        charges.push({
          id: id, reservationId: host.id, date: U.date(new Date(order.createdAt)),
          description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " (laundry" + (spec.express ? ", express" : "") + ")",
          department: "Laundry", amount: l.amount, qty: l.qty, unitPrice: l.unitPrice, basePrice: l.basePrice,
          extras: l.added, currency: l.currency, serviceId: l.serviceId, priceId: l.priceId,
          listId: l.listId, listName: l.listName, postedBy: order.handledBy
        });
        l.chargeId = id;
        return id;
      });
      order.taxLines = tax.lines.map(function (l) { return { ruleId: l.rule.id, label: l.label, amount: l.amount }; });
      tax.lines.forEach(function (t, i) {
        var id = "chg_" + order.id + "_tax" + i;
        charges.push({
          id: id, reservationId: host.id, date: U.date(new Date(order.createdAt)),
          description: t.label + " — laundry " + order.ref, department: "Taxes & service",
          amount: t.amount, qty: 1, taxRuleId: t.rule.id, postedBy: "System"
        });
        order.charges.push(id);
      });
      laundry.push(order);
    });

    // ---------------- housekeeping + guest request tasks ----------------
    var cleanerByProp = {
      agm: ["stf_agm_4", "stf_agm_5", "stf_agm_6"],
      ari: ["stf_ari_4", "stf_ari_5"],
      apa: ["stf_apa_4", "stf_apa_5"]
    };
    var requestSeed = [
      { title: "Extra pillows and a firm mattress topper", type: "Guest request", dept: "Housekeeping", pri: "Normal", mins: 40 },
      { title: "Sparkling water and fresh lime in the minibar", type: "Guest request", dept: "Food & Beverage", pri: "Normal", mins: 25 },
      { title: "Late checkout request — 15:00", type: "Guest request", dept: "Front Office", pri: "High", mins: 30 },
      { title: "Air conditioning not cooling — Room", type: "Maintenance", dept: "Engineering", pri: "High", mins: 60 },
      { title: "Spa booking — 60 min deep tissue, 18:00", type: "Guest request", dept: "Spa & Wellness", pri: "Normal", mins: 90 },
      { title: "Airport transfer to Murtala Muhammed, 07:00", type: "Guest request", dept: "Transport", pri: "High", mins: 45 },
      { title: "Vegetarian dinner in-room for two", type: "Guest request", dept: "Food & Beverage", pri: "Normal", mins: 45 },
      { title: "Turn-down service with lavender linen", type: "Housekeeping", dept: "Housekeeping", pri: "Low", mins: 120 },
      { title: "Baby cot and bottle steriliser", type: "Guest request", dept: "Housekeeping", pri: "High", mins: 35 },
      { title: "Lost phone charger — original Apple 20W", type: "Guest request", dept: "Front Office", pri: "Low", mins: 60 },
      { title: "Anniversary amenity — macarons and card", type: "Guest request", dept: "Food & Beverage", pri: "High", mins: 50 },
      { title: "Inspect suite before VIP arrival", type: "Inspection", dept: "Housekeeping", pri: "High", mins: 30 }
    ];
    PROPERTIES.forEach(function (p, pi) {
      var pc = cleanerByProp[p.id];
      var propInhouse = reservations.filter(function (r) { return r.propertyId === p.id && r.status === "In-house"; });
      var dirty = rooms.filter(function (r) { return r.propertyId === p.id && (r.hk === "Dirty" || r.hk === "Clean" || r.hk === "Occupied"); });
      dirty.slice(0, pi === 0 ? 9 : 5).forEach(function (room, ix) {
        var occ = propInhouse.find(function (r) { return r.roomId === room.id; });
        var status = ix % 4 === 0 ? "Done" : ix % 3 === 0 ? "In progress" : "Open";
        tasks.push({
          id: "tsk_" + p.id + "_hk" + ix, propertyId: p.id, type: occ ? "Housekeeping" : "Departure clean",
          title: occ ? "Stayover service — Room " + room.number : "Departure clean — Room " + room.number,
          detail: occ ? "Refresh bed, bathroom, amenities and minibar." : "Full turnover before the next arrival. Check the pillow menu.",
          roomId: room.id, guestId: occ ? occ.guestId : null, assignedTo: pc[ix % pc.length],
          priority: ix % 5 === 0 ? "High" : ix % 3 === 0 ? "Low" : "Normal",
          status: status, createdAt: new Date(Date.now() - (ix + 1) * 23 * 60000).toISOString(),
          dueAt: new Date(Date.now() + (2 + ix) * 45 * 60000).toISOString(),
          slaMins: 90, resolvedAt: status === "Done" ? new Date(Date.now() - 40 * 60000).toISOString() : null, source: "Housekeeping"
        });
      });
      requestSeed.slice(0, pi === 0 ? 10 : 6).forEach(function (rq, ix) {
        var occ = propInhouse[(ix * 3 + 1) % Math.max(1, propInhouse.length)];
        var created = new Date(Date.now() - (ix * 37 + 12) * 60000);
        var status = ix === 4 ? "Done" : ix === 2 ? "In progress" : "Open";
        tasks.push({
          id: "tsk_" + p.id + "_rq" + ix, propertyId: p.id, type: rq.type,
          title: rq.title + (occ ? " — Room " + roomById(occ.roomId).number : ""),
          detail: rq.dept + " request raised by " + (occ ? guestById(occ.guestId).name : "front desk") + ". Confirm with the guest before closing.",
          roomId: occ ? occ.roomId : null, guestId: occ ? occ.guestId : null,
          assignedTo: status === "Open" ? null : pc[ix % pc.length],
          priority: rq.pri, status: status, createdAt: created.toISOString(),
          dueAt: new Date(created.getTime() + rq.mins * 60000).toISOString(), slaMins: rq.mins,
          resolvedAt: status === "Done" ? new Date(created.getTime() + 55 * 60000).toISOString() : null, source: rq.dept
        });
      });
    });

    // Anchor the guest portal on a Presidential stay for Adaeze Nwankwo
    var anchorRes = reservations.find(function (r) {
      return r.propertyId === "agm" && r.status === "In-house" && r.roomTypeId === "ps";
    });
    if (anchorRes) {
      anchorRes.guestId = "gst_1";
      anchorRes.vip = true;
      anchorRes.mobileKey = true;
      anchorRes.notes = "Anniversary stay — sparkling water, memory foam pillow, no shellfish.";
      // A guest cannot hold two live reservations at once — the guest portal
      // anchors on exactly one stay, so any duplicate is retired or re-handed.
      var liveToday = U.today();
      var anchorName = (guests.find(function (g) { return g.id === "gst_1"; }) || {}).name;
      reservations.forEach(function (r) {
        if (r === anchorRes || r.guestId !== "gst_1") return;
        var live = r.status === "In-house" ||
          (r.status === "Confirmed" && r.checkIn <= liveToday && r.checkOut > liveToday);
        if (!live || !(r.checkIn < anchorRes.checkOut && r.checkOut > anchorRes.checkIn)) return;
        if (r.status === "In-house") {
          r.status = "Checked out";
          r.checkedOutAt = new Date(U.parse(r.checkOut) - 8 * 3600000).toISOString();
        } else {
          var alt = guests.find(function (g) { return g.id !== "gst_1" && g.name !== anchorName; });
          if (alt) { r.guestId = alt.id; r.vip = false; }
        }
      });
    }

    // ---------------- reviews ----------------
    var reviewBodies = [
      { r: 5, t: "Flawless from arrival to departure", b: "The team remembered my pillow preference and had sparkling water waiting. Check-in took under a minute. This is what a five-star hotel should feel like." },
      { r: 5, t: "A genuinely restorative stay", b: "The spa treatment was exceptional and the villa was completely private. Breakfast on the terrace is not to be missed." },
      { r: 4, t: "Beautiful property, small delay", b: "The suite was stunning and the butler team was attentive. Our room was ready 40 minutes late, but the team recovered well with a drinks credit." },
      { r: 5, t: "The best business hotel in Lagos", b: "Fast Wi-Fi, a proper desk, and the 14:00 checkout I asked for. The airport transfer was punctual and discreet." },
      { r: 3, t: "Lovely hotel, service inconsistent", b: "Dinner at Isla was excellent, but my in-room dining order arrived cold and the minibar was not restocked on the second day." },
      { r: 5, t: "Celebrated our anniversary here", b: "A handwritten card and macarons in the room. The team arranged a private dinner by the pool at short notice. Truly memorable." },
      { r: 4, t: "Excellent spa and gym", b: "The therapist was superb and the gym is well equipped. Only note: the pool was busier than expected on Saturday afternoon." },
      { r: 5, t: "Seamless group stay", b: "We booked eight rooms for a board meeting. Every folio was correct and the events team handled the room set-up perfectly." },
      { r: 5, t: "Quiet, elegant, discreet", b: "Exactly what I needed after a long flight. The Garden Villa is worth every naira." },
      { r: 4, t: "Great stay, improve the coffee", b: "Wonderful staff and a beautiful room. The in-room coffee could be better for this price point." }
    ];
    var checkedOut = reservations.filter(function (r) { return r.status === "Checked out"; });
    shuffle(checkedOut).slice(0, 12).forEach(function (res, ix) {
      var rb = reviewBodies[ix % reviewBodies.length];
      var g = guestById(res.guestId);
      reviews.push({
        id: "rev_" + ix, guestId: res.guestId, propertyId: res.propertyId, reservationId: res.id,
        rating: rb.r, title: rb.t, body: rb.b, date: U.addDays(today, -ri(1, 24)),
        channel: ix % 3 === 0 ? "Google" : ix % 3 === 1 ? "Post-stay survey" : "TripAdvisor",
        responded: ix % 3 === 0, response: ix % 3 === 0 ? "Thank you for taking the time to write — we have shared this with the whole team. We look forward to welcoming you back." : "",
        stay: U.pretty(res.checkIn, "short") + " – " + U.pretty(res.checkOut, "short"), guestName: g ? g.name : "Guest"
      });
    });

    // ---------------- lost & found ----------------
    [
      { item: "Gold hoop earring", room: "305", status: "Stored", days: 2, found: "Blessing Uche" },
      { item: "Apple iPad (space grey)", room: "412", status: "Returned", days: 6, found: "Samuel Nnamdi" },
      { item: "Child's stuffed rabbit", room: "208", status: "Stored", days: 1, found: "Tobi Ogunleye" },
      { item: "Prescription glasses, tortoiseshell", room: "G02", status: "Awaiting courier", days: 3, found: "Blessing Uche" },
      { item: "Navy cashmere scarf", room: "307", status: "Stored", days: 11, found: "Housekeeping" },
      { item: "Passport wallet (no documents)", room: "Lobby", status: "Returned", days: 14, found: "Security" }
    ].forEach(function (l, i) {
      lostFound.push({
        id: "lf_" + i, propertyId: "agm", item: l.item, room: l.room, status: l.status,
        foundBy: l.found, date: U.addDays(today, -l.days), guestId: guests[i + 3].id,
        note: l.status === "Returned" ? "Courier tracking shared with guest." : "Logged and sealed in the housekeeping safe."
      });
    });

    // ---------------- invoices ----------------
    // Closed folios are billed as a document, and a hall booking that never
    // touched a room account still needs one. Lines are copied, not referenced,
    // so a later re-price or a voided charge cannot rewrite what was billed.
    var invoices = [];
    var refunds = [];
    var invSeq = 0;

    function seedInvoice(kind, entityId, propertyId, reservationId, guestId, date, lines, paid) {
      invSeq++;
      var res = reservationId && reservations.filter(function (r) { return r.id === reservationId; })[0];
      var evt = kind === "event" && events.filter(function (e) { return e.id === entityId; })[0];
      var guest = guestId && guests.filter(function (g) { return g.id === guestId; })[0];
      var inv = {
        id: "inv_" + invSeq, number: invoiceNumber(invSeq, (PROPERTIES.filter(function (p) { return p.id === propertyId; })[0] || {}).code || "INV"),
        propertyId: propertyId, kind: kind, entityId: entityId,
        reservationId: reservationId || null, guestId: guestId || null,
        title: res ? (guest ? guest.name : "Guest") + " · " + res.reference : (evt ? evt.title : "Booking"),
        date: date, dueDate: U.addDays(date, 7), currency: "NGN",
        lines: lines, adjustments: [], status: "Open",
        raisedBy: "Night audit", raisedAt: new Date(Date.now() - (invSeq + 1) * 86400000).toISOString()
      };
      (paid || []).forEach(function (p) { p.invoiceId = inv.id; });
      inv.status = invoiceTotals(inv, paid || [], []).status;
      invoices.push(inv);
      return inv;
    }

    reservations.filter(function (r) { return r.propertyId === "agm" && r.status === "Checked out"; })
      .slice(0, 2).forEach(function (res) {
        var ch = charges.filter(function (c) { return c.reservationId === res.id && !c.voided; });
        if (!ch.length) return;
        var inv = seedInvoice("folio", res.id, res.propertyId, res.id, res.guestId, res.checkOut,
          ch.map(function (c) {
            return {
              chargeId: c.id, date: c.date, description: c.description, department: c.department,
              qty: c.qty || 1, unitPrice: c.unitPrice || c.amount, amount: c.amount,
              priceId: c.priceId || null, listId: c.listId || null, listName: c.listName || null
            };
          }),
          payments.filter(function (p) { return p.reservationId === res.id; }));
        ch.forEach(function (c) { c.invoiceId = inv.id; });
      });

    events.filter(function (e) { return !e.reservationId && e.status === "Confirmed"; })
      .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; }).slice(0, 2)
      .forEach(function (evt) {
        seedInvoice("event", evt.id, evt.propertyId, null, null, evt.date,
          evt.lines.map(function (l) {
            return {
              date: evt.date, description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " — " + evt.title,
              department: "Events & Banqueting", qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
              priceId: l.priceId, listId: l.listId, listName: l.listName
            };
          }).concat(evt.taxLines.map(function (t) {
            return { date: evt.date, description: t.label, department: "Taxes & service", qty: 1, unitPrice: t.amount, amount: t.amount };
          })), []);
      });

    // ---------------- operating expenses ----------------
    // A net result is only honest if cost is on the books, so each property
    // carries four months of recurring operating cost. Recording and approval
    // are separate states: an unapproved line never reaches the result.
    var EXPENSE_PLAN = [
      { category: "Payroll", desc: "Salaries, wages and benefits", base: 3800000, method: "Transfer", payee: "Group payroll" },
      { category: "Utilities", desc: "Power, diesel and generator hours", base: 1150000, method: "Transfer", payee: "Surger / Gridco" },
      { category: "Cost of sales", desc: "Kitchen, bar and grocery purchases", base: 980000, method: "Transfer", payee: "Milestone Fresh" },
      { category: "Repairs & maintenance", desc: "Engineering spares and call-outs", base: 410000, method: "Card", payee: "Ozolua Motors" },
      { category: "Housekeeping", desc: "Amenities, consumables and linen hire", base: 320000, method: "Transfer", payee: "Dryline Textiles" },
      { category: "Laundry", desc: "Chemicals and outsource pressing", base: 265000, method: "Transfer", payee: "Crisp Press" },
      { category: "Marketing", desc: "Channel commissions and brand campaign", base: 540000, method: "Card", payee: "Blaai / Booking.com" },
      { category: "Statutory", desc: "Rent, levies and statutory charges", base: 700000, method: "Transfer", payee: "State board" },
      { category: "Technology", desc: "Property system, gateway and licences", base: 180000, method: "Card", payee: "PMS vendor" }
    ];
    var expenses = [];
    var expSeq = 0;
    PROPERTIES.forEach(function (p) {
      var size = (p.floors * p.perFloor) / 48;
      var scale = p.rateIndex * size;
      for (var m = 3; m >= 0; m--) {
        EXPENSE_PLAN.forEach(function (plan) {
          expSeq++;
          var date = U.addDays(today, -(m * 30 + ri(0, 26)));
          // Anything paid inside the last week has not reached the sign-off
          // sheet yet, so the dashboard shows a live queue of claims.
          var pending = date >= U.addDays(today, -8);
          expenses.push({
            id: "exp_" + expSeq, propertyId: p.id, date: date, category: plan.category,
            description: plan.desc, amount: round50(plan.base * scale * (0.9 + rnd() * 0.2)),
            currency: "NGN", method: plan.method, payee: plan.payee,
            attachment: rnd() > 0.35 ? plan.payee.split(" ")[0].toLowerCase() + "-" + date.replace(/-/g, "") + ".pdf" : null,
            recordedBy: p.gm, recordedAt: new Date(date + "T09:00:00.000Z").toISOString(),
            status: pending ? "Pending" : "Approved",
            decidedBy: pending ? null : "Group Finance",
            decidedAt: pending ? null : new Date(U.addDays(date, 3) + "T14:00:00.000Z").toISOString()
          });
        });
      }
    });
    // One-offs on the busiest property, including a rejected line so the
    // approval states are all reachable from the seeded data.
    [
      { desc: "Emergency plumbing call-out — Tower lift shaft", category: "Repairs & maintenance", amount: 95000, method: "Cash", payee: "AquaFix Ltd", status: "Approved", days: 4 },
      { desc: "Banquet glassware replacement after AGM gala", category: "Cost of sales", amount: 265000, method: "Card", payee: "Crystal House", status: "Pending", days: 3 },
      { desc: "Generator service and injector clean", category: "Utilities", amount: 480000, method: "Transfer", payee: "Ozolua Motors", status: "Pending", days: 2 },
      { desc: "Team dinner charged as operating cost", category: "Other operating", amount: 120000, method: "Card", payee: "Isla Restaurant", status: "Rejected", days: 6 }
    ].forEach(function (one) {
      expSeq++;
      var date = U.addDays(today, -one.days);
      expenses.push({
        id: "exp_" + expSeq, propertyId: "agm", date: date, category: one.category,
        description: one.desc, amount: one.amount, currency: "NGN", method: one.method,
        payee: one.payee, attachment: one.status === "Rejected" ? null : "quote-" + one.days + "d.pdf",
        recordedBy: "Ifeoma Okafor", recordedAt: new Date(date + "T11:20:00.000Z").toISOString(),
        status: one.status,
        decidedBy: one.status === "Pending" ? null : "Group Finance",
        decidedAt: one.status === "Pending" ? null : new Date(date + "T16:00:00.000Z").toISOString(),
        decisionNote: one.status === "Rejected" ? "Hospitality of staff is not an operating cost." : null
      });
    });

    // The bank statement catches up about two days later, so older receipts
    // arrive already matched and the recent ones have not been looked at yet.
    payments.forEach(function (p) {
      if (p.date <= U.addDays(today, -2)) {
        p.reconciled = true;
        p.reconciledBy = "Group Finance";
      }
    });

    // ---------------- history (90 days) ----------------
    var history = {};
    PROPERTIES.forEach(function (p, pi) {
      var arr = [];
      var roomCount = rooms.filter(function (r) { return r.propertyId === p.id; }).length;
      for (var d = 89; d >= 0; d--) {
        var day = U.addDays(today, -d);
        var wk = U.isWeekend(day);
        var occ = Math.min(0.98, Math.max(0.48, p.occupancyTarget + (wk ? 0.04 : 0) - 0.05 + (rnd() - 0.5) * 0.16 + (d < 7 ? 0.03 : 0)));
        var std = priceOf("svc_dk", { date: day });
        var adr = Math.round(((std ? std.unit : 0) * p.rateIndex * (0.92 + rnd() * 0.26)) / 500) * 500;
        arr.push({
          date: day, occupancy: Math.round(occ * 1000) / 10, adr: adr,
          revpar: Math.round(occ * adr), revenue: Math.round(occ * roomCount * adr),
          arrivals: Math.round(roomCount * 0.2 + rnd() * 6), departures: Math.round(roomCount * 0.18 + rnd() * 6),
          roomsSold: Math.round(occ * roomCount)
        });
      }
      history[p.id] = arr;
    });

    // ---------------- activity log ----------------
    var actors = ["Adamu Bello", "Zainab Yusuf", "Grace Mensah", "Chiamaka Obi", "Night audit", "Ifeoma Okafor"];
    var verbs = [
      ["checked in", "reservation"], ["posted a charge", "folio"], ["issued a mobile key", "room"],
      ["completed housekeeping", "room"], ["changed a rate", "rate plan"], ["took a payment", "folio"],
      ["assigned a task", "task"], ["updated a guest preference", "guest"], ["checked out", "reservation"]
    ];
    for (var a = 0; a < 22; a++) {
      var v = verbs[a % verbs.length];
      activity.push({
        id: "act_" + a, at: new Date(Date.now() - (a * 47 + 12) * 60000).toISOString(),
        actor: actors[a % actors.length], action: v[0], entity: v[1],
        detail: [
          "Room 305 · Adaeze Nwankwo", "₦48,500 · Isla Restaurant", "Room 412 · mobile key sent to guest app",
          "Room 208 inspected and released", "Deluxe King · weekend uplift applied", "₦412,500 · card ending 4417",
          "Turn-down · assigned to Blessing Uche", "Shellfish allergy added to profile", "AGM-4821 · balance settled"
        ][a % 9],
        propertyId: PROPERTIES[a % 2].id
      });
    }

    // ---------------- notifications ----------------
    var notifications = [
      { id: "ntf_1", type: "VIP arrival", title: "Adaeze Nwankwo arrives today at 14:30", detail: "Platinum · Executive Suite 410 · welcome amenity confirmed. GM to greet.", at: new Date(Date.now() - 18 * 60000).toISOString(), read: false, link: "#/guests/gst_1", propertyId: "agm" },
      { id: "ntf_2", type: "SLA at risk", title: "3 guest requests are approaching their response window", detail: "Oldest: airport transfer for Room 305 — 12 minutes remaining.", at: new Date(Date.now() - 42 * 60000).toISOString(), read: false, link: "#/requests", propertyId: "agm" },
      { id: "ntf_3", type: "Maintenance", title: "Room 213 out of service — AC compressor", detail: "Engineering estimate: 2 days. 4 future reservations need re-accommodation.", at: new Date(Date.now() - 96 * 60000).toISOString(), read: false, link: "#/room-map", propertyId: "agm" },
      { id: "ntf_4", type: "Review", title: "New 3★ review needs a response", detail: "\"Lovely hotel, service inconsistent\" — Isla dinner praised, in-room dining flagged.", at: new Date(Date.now() - 5 * 3600000).toISOString(), read: false, link: "#/reviews", propertyId: "agm" },
      { id: "ntf_5", type: "Night audit", title: "End-of-day pack is ready for review", detail: "Yesterday's revenue ₦18.4m · 2 unresolved folios · 1 no-show.", at: new Date(Date.now() - 9 * 3600000).toISOString(), read: true, link: "#/end-of-day", propertyId: "agm" },
      { id: "ntf_6", type: "Channel manager", title: "Rate parity alert — Deluxe King", detail: "Booking.com is selling 4% below the direct rate for 12–14 Nov.", at: new Date(Date.now() - 26 * 3600000).toISOString(), read: true, link: "#/revenue", propertyId: "agm" }
    ];

    // ---------------- settings ----------------
    // Tax and service-charge percentages used to live here and were ignored by
    // the quoting code. They are taxRules now; this is the rest of the desk.
    //
    // The finance block is the property's money rules (§9 Financial Settings).
    // Every key below is read by an action, because a setting nothing enforces
    // is decoration: invoicePrefix names a document, paymentDays dates it,
    // approvalAmount and discountPct decide which changes need a second
    // signature before they take effect.
    var FINANCE = { invoicePrefix: "", paymentDays: 7, approvalAmount: 500000, discountPct: 10, rateMaxAgeDays: 3 };
    var settings = {};
    PROPERTIES.forEach(function (p) {
      settings[p.id] = {
        checkInTime: "15:00", checkOutTime: "12:00",
        depositPct: 25, cancellation: "Free cancellation up to 48 hours before arrival. One night charged thereafter.",
        overbooking: 2, currency: "NGN", language: "English (UK)",
        finance: Object.assign({}, FINANCE, { invoicePrefix: p.code }),
        integrations: {
          channelManager: true, paymentGateway: true, doorLocks: true, accounting: false, crm: true, whatsapp: true
        },
        channels: { "Direct": 38, "Booking.com": 24, "Expedia": 14, "Corporate": 12, "Travel agent": 7, "GDS": 5 },
        // What the sign-in page and the app chrome wear: a name, a line, a
        // logo, a gallery, and the palette read from that logo. The flagship
        // opens on the group lock-up the seed already carried, so adding a
        // brand changes what a property looks like, never what it says by
        // default. Images are stored as data URLs because a browser that
        // uploads a file has nowhere else to keep it.
        branding: {
          brandName: p.id === "agm" ? "Aurelia Grand" : p.name,
          tagline: p.id === "agm" ? "Hotels & Residences" : p.tagline,
          logo: "", images: [], palette: null, useColors: true,
          updatedAt: null, updatedBy: null
        }
      };
    });

    // ---------------- exchange rates ----------------
    // Three states, deliberately, because the rule is about the states and not
    // about the numbers: a dollar rate the treasury set yesterday and the desk may
    // sell on, a sterling rate nine days past its trust limit that it may not, and
    // a euro with no rate on file at all. The naira needs no row — it is what the
    // books are kept in.
    var fxRates = [
      {
        id: "fx_usd_prev", code: "USD", perBase: 1512, effective: U.addDays(today, -8),
        setBy: "Ifeoma Okafor", setAt: new Date(Date.now() - 8 * 86400000).toISOString(),
        note: "Monday fixing carried over the weekend"
      },
      {
        id: "fx_usd", code: "USD", perBase: 1550, effective: U.addDays(today, -1),
        setBy: "Ifeoma Okafor", setAt: new Date(Date.now() - 86400000).toISOString(),
        note: "Group treasury fixing for the corporate contracts"
      },
      {
        id: "fx_gbp", code: "GBP", perBase: 1965, effective: U.addDays(today, -9),
        setBy: "Ifeoma Okafor", setAt: new Date(Date.now() - 9 * 86400000).toISOString(),
        note: "Not revisited since the sterling move — refresh before selling in GBP"
      }
    ];

    // ---------------- financial approvals ----------------
    // Two changes too large for one signature, waiting on a second one. They are
    // requests only: the price row and the invoice below do not carry them, and
    // nothing applies them until someone with the right decides.
    var suitePrice = prices.find(function (r) { return r.id === "prc_ps_std"; });
    var suiteWas = suitePrice ? suitePrice.amount : 1250000;
    var suiteNext = 1800000;
    var suiteReason = "Top floor reopened after the panoramic refurbishment";
    var openDoc = invoices.filter(function (i) {
      return i.propertyId === "agm" && i.kind !== "folio" && i.status !== "Void";
    })[0];
    var docTotal = openDoc ? invoiceTotals(openDoc, [], []).total : 0;
    var concession = Math.round(docTotal * 0.15);
    var concessionReason = "Sponsor asked for a partner concession on the closing invoice";
    var approvals = [];
    if (suitePrice) {
      // change holds exactly what the desk would have submitted, because a
      // signed-off request is applied by the same action that would have run it.
      approvals.push({
        id: "apr_seed_price", propertyId: "agm", kind: "price",
        subject: "Presidential Suite · Standard 2026", subjectId: suitePrice.id,
        change: { patch: { amount: suiteNext }, reason: suiteReason },
        amount: Math.abs(suiteNext - suiteWas),
        from: suiteWas, to: suiteNext, reason: suiteReason,
        requestedBy: "Chiamaka Obi", requestedAt: new Date(Date.now() - 26 * 3600000).toISOString(),
        status: "Pending", decidedBy: null, decidedAt: null, decisionNote: null
      });
    }
    if (openDoc && docTotal) {
      approvals.push({
        id: "apr_seed_discount", propertyId: "agm", kind: "discount",
        subject: openDoc.number + " · " + openDoc.title, subjectId: openDoc.id,
        change: {
          invoiceId: openDoc.id,
          data: { amount: concession, label: "Partner concession", reason: concessionReason }
        },
        amount: concession, from: 0, to: concession,
        reason: concessionReason,
        requestedBy: "Adamu Bello", requestedAt: new Date(Date.now() - 9 * 3600000).toISOString(),
        status: "Pending", decidedBy: null, decidedAt: null, decisionNote: null
      });
    }

    return {
      meta: { version: 9, day: today, seededOn: today, seededAt: now, hotelGroup: "Aurelia Hotels & Residences", system: "LHMS v1.0" },
      properties: PROPERTIES, roomTypes: stripPrices(ROOM_TYPES, ["rate"]), ratePlans: RATE_PLANS,
      rooms: rooms, guests: guests, outlets: stripOutletPrices(OUTLETS),
      services: services, priceLists: PRICE_LISTS, prices: prices, priceHistory: buildPriceHistory(), taxRules: TAX_RULES,
      staff: staff, reservations: reservations, charges: charges, payments: payments,
      waitlistOffers: waitlistOffers,
      invoices: invoices, refunds: refunds, expenses: expenses, approvals: approvals, closedDays: [],
      fxRates: fxRates,
      events: events, laundry: laundry, tasks: tasks,
      activity: activity, reviews: reviews, notifications: notifications, lostFound: lostFound,
      history: history, settings: settings, lostFoundSeq: 7, laundrySeq: 7200 + LAUNDRY_SEED.length,
      session: { propertyId: "agm", role: "Manager" },
      counters: { res: refSeq, invoice: invSeq }
    };
  };
})();
