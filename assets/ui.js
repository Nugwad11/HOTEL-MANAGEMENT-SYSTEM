/* ============================================================
   Aurelia Grand — UI kit
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = (LHMS.ui = {});
  ui.state = {};

  /* Charts paint their series as attributes, so they cannot inherit the brand by
     CSS alone. Asking the brand engine at render time keeps a palette change from
     leaving a stale navy donut on a re-coloured desk. */
  var HOUSE_SERIES = ["#1d3550", "#b18f52", "#4b6d92", "#8a9a7b", "#c4a680", "#9a8ba8", "#6d8fa8", "#a8946f"];
  ui.palette = function () {
    return (LHMS.brand && LHMS.brand.chartColors) ? LHMS.brand.chartColors() : HOUSE_SERIES.slice();
  };
  ui.series = function (i) {
    var p = ui.palette();
    return p[i % p.length];
  };

  /* ---------------- icons ---------------- */
  var P = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
    calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 10h18"/>',
    bed: '<path d="M3 18v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6"/><path d="M3 18h18M3 21v-3M21 21v-3"/><path d="M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3"/>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    sparkles: '<path d="m12 3 1.9 4.6L18.5 9.5l-4.6 1.9L12 16l-1.9-4.6L5.5 9.5l4.6-1.9Z"/><path d="M18 15.5 19 18l2.5 1-2.5 1-1 2.5-1-2.5L14.5 19l2.5-1Z"/>',
    receipt: '<path d="M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2Z"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.4-3.4"/>',
    menu: '<path d="M3 6h18M3 12h18M3 18h18"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    minus: '<path d="M5 12h14"/>',
    right: '<path d="m9 18 6-6-6-6"/>',
    left: '<path d="m15 18-6-6 6-6"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
    check: '<path d="m20 6-11 11-5-5"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.5 2.5 4.5-5"/>',
    alert: '<path d="M10.3 3.9 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m11 12 9-9M17 3h4v4M14 6l4 4"/>',
    door: '<path d="M3 21h18"/><path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M14 12h.01"/>',
    broom: '<path d="m13 11 7-7"/><path d="M9.5 7.5 16 14l-4 4a4 4 0 0 1-5.7 0l-1.3-1.3a4 4 0 0 1 0-5.7Z"/><path d="m3 21 4-4"/>',
    wrench: '<path d="M14.7 6.3a4 4 0 0 0 5.1 5.1l-9.4 9.4a2.8 2.8 0 0 1-4-4Z"/><path d="M14.7 6.3 18 3"/>',
    star: '<path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4L2.6 9.8l6.5-.9Z"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    printer: '<path d="M6 9V3h12v6"/><rect x="3" y="9" width="18" height="8" rx="2"/><path d="M6 14h12v7H6z"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<path d="M22 16.9v3a2 2 0 0 1-2.2 2A19.8 19.8 0 0 1 3 5.2 2 2 0 0 1 5 3h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L9 10.8a16 16 0 0 0 4.2 4.2l1.2-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
    pin: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5M21 12H9"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/>',
    building: '<rect x="4" y="2" width="16" height="20" rx="2"/><path d="M9 22v-4h6v4M8 6h.01M12 6h.01M16 6h.01M8 10h.01M12 10h.01M16 10h.01M8 14h.01M12 14h.01M16 14h.01"/>',
    trendUp: '<path d="m3 17 6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    trendDown: '<path d="m3 7 6 6 4-4 8 8"/><path d="M15 17h6v-6"/>',
    coffee: '<path d="M18 8h1a3 3 0 0 1 0 6h-1"/><path d="M3 8h15v6a5 5 0 0 1-5 5H8a5 5 0 0 1-5-5Z"/><path d="M6 2v2M10 2v2M14 2v2"/>',
    utensils: '<path d="M4 3v7a3 3 0 0 0 6 0V3M7 10v11"/><path d="M17 3v18M17 9c2 0 3-1.5 3-3.5S19 2 17 2"/>',
    car: '<path d="m5 11 2-4h10l2 4"/><path d="M3 16v-3a2 2 0 0 1 .8-1.6L5 11h14l1.2.4A2 2 0 0 1 21 13v3"/><path d="M3 16h18v3H3z"/><circle cx="7" cy="19" r="1.5"/><circle cx="17" cy="19" r="1.5"/>',
    box: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="M3 8v8l9 5 9-5V8"/><path d="M12 13v8"/>',
    userPlus: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M19 8v6M22 11h-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    eyeOff: '<path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.5 0 10 7 10 7a18.2 18.2 0 0 1-3.1 4.1M6.6 6.6A18 18 0 0 0 2 12s3.5 7 10 7a10.7 10.7 0 0 0 4.4-.9"/><path d="M2 2l20 20"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    wifi: '<path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0M12 19h.01M2 9a15 15 0 0 1 20 0"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
    cart: '<circle cx="9" cy="20" r="1.5"/><circle cx="18" cy="20" r="1.5"/><path d="M2 3h3l2.6 12.4A2 2 0 0 0 9.6 17H19l2-9H6"/>',
    send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
    wifiOff: '<path d="M2 2l20 20"/>',
    leaf: '<path d="M11 20A7 7 0 0 1 4 13C4 7 11 2 20 2c0 9-5 16-11 16Z"/><path d="M4 21c2-6 6-9 12-11"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 8 5-5 5 5M12 3v12"/>',
    palette: '<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="9" r="1"/><circle cx="12.5" cy="7" r="1"/><circle cx="16" cy="10" r="1"/><path d="M12 21a3 3 0 0 1 0-6 2 2 0 0 0 0-4"/>',
    arrowUpRight: '<path d="M7 17 17 7M7 7h10v10"/>'
  };
  ui.icon = function (name, size) {
    var d = P[name] || P.home;
    return '<svg viewBox="0 0 24 24" width="' + (size || 16) + '" height="' + (size || 16) + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + d + "</svg>";
  };

  /* ---------------- escaping + formatting ---------------- */
  ui.esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  };
  ui.money = function (n, cur) { return U.money(n, cur); };
  ui.avatar = function (name, cls) {
    var n = typeof name === "string" ? name : (name && name.name) || "";
    var h = 0;
    for (var i = 0; i < n.length; i++) h = (h * 31 + n.charCodeAt(i)) % 7;
    return '<span class="avatar av-' + h + (cls ? " " + cls : "") + '" aria-hidden="true">' + ui.esc(U.initials(n)) + "</span>";
  };
  ui.chip = function (text, tone, dot) {
    return '<span class="chip ' + (tone || "") + '">' + (dot === false ? "" : '<i class="dot"></i>') + ui.esc(text) + "</span>";
  };
  ui.resStatus = function (status) {
    var map = {
      "Confirmed": "blue", "In-house": "green", "Checked out": "navy",
      "Cancelled": "red", "No-show": "amber", "Waitlist": "violet"
    };
    return ui.chip(status, map[status] || "");
  };
  ui.roomStatusChip = function (key) {
    var map = { available: "green", occupied: "blue", arriving: "gold", departing: "violet", dirty: "amber", inspected: "blue", ooo: "red", oos: "" };
    var labels = { available: "Available", occupied: "Occupied", arriving: "Arriving", departing: "Departing", dirty: "Dirty", inspected: "Inspected", ooo: "Out of order", oos: "Out of service" };
    return ui.chip(labels[key] || key, map[key] || "");
  };
  ui.tierChip = function (tier) {
    var tone = tier === "Platinum" ? "gold" : tier === "Gold" ? "amber" : tier === "Silver" ? "navy" : "";
    return ui.chip(tier, tone, false);
  };
  ui.stars = function (rating, size) {
    var out = '<span class="stars" aria-label="' + rating + ' out of 5">';
    for (var i = 1; i <= 5; i++) out += '<svg class="' + (i <= rating ? "" : "off") + '" viewBox="0 0 24 24" width="' + (size || 11) + '" height="' + (size || 11) + '"><path d="m12 3 2.9 5.9 6.5.9-4.7 4.6 1.1 6.4-5.8-3-5.8 3 1.1-6.4L2.6 9.8l6.5-.9Z"/></svg>';
    return out + "</span>";
  };
  ui.nightsLabel = function (n) { return n + (n === 1 ? " night" : " nights"); };
  ui.guestName = function (id) { var g = LHMS.get.guest(id); return g ? g.name : "Guest"; };
  ui.roomNo = function (id) { var r = LHMS.get.room(id); return r ? r.number : "—"; };
  ui.planName = function (id) { var p = LHMS.get.ratePlan(id); return p ? p.name : "—"; };
  ui.typeName = function (id) { var t = LHMS.get.roomType(id); return t ? t.name : "—"; };

  ui.empty = function (title, sub, icon) {
    return '<div class="empty">' + ui.icon(icon || "file", 26) + "<b>" + ui.esc(title) + "</b>" + (sub ? "<span>" + ui.esc(sub) + "</span>" : "") + "</div>";
  };

  ui.kpi = function (label, value, foot, opts) {
    opts = opts || {};
    return '<div class="kpi ' + (opts.accent || "") + '">' +
      '<div class="kpi-label">' + (opts.icon ? ui.icon(opts.icon, 12) : "") + ui.esc(label) + "</div>" +
      '<div class="kpi-value">' + value + "</div>" +
      (foot ? '<div class="kpi-foot">' + foot + "</div>" : "") +
      "</div>";
  };

  ui.delta = function (value, dir) {
    var cls = dir || (value >= 0 ? "up" : "down");
    var ic = value >= 0 ? "trendUp" : "trendDown";
    return '<span class="delta ' + cls + '">' + ui.icon(ic, 10) + Math.abs(value) + "%</span>";
  };

  /* ---------------- modal / drawer ---------------- */
  ui.modal = function (opts) {
    var root = document.getElementById("modal-root");
    // title and sub are always plain text from callers; escape them here so no
    // caller can accidentally inject HTML through these slots. body and footer
    // are trusted HTML assembled by page modules — callers are responsible for
    // escaping any user-derived values they embed there.
    root.innerHTML =
      '<div class="modal-backdrop" data-modal-backdrop>' +
        '<div class="modal ' + (opts.wide ? "wide" : opts.slim ? "slim" : "") + '" role="dialog" aria-modal="true" aria-label="' + ui.esc(opts.title || "Dialog") + '">' +
          '<div class="modal-head"><div><h2>' + ui.esc(opts.title || "") + "</h2>" + (opts.sub ? "<p>" + ui.esc(opts.sub) + "</p>" : "") + "</div>" +
          '<button class="modal-close" data-close-modal aria-label="Close">' + ui.icon("close", 14) + "</button></div>" +
          '<div class="modal-body">' + (opts.body || "") + "</div>" +
          (opts.footer ? '<div class="modal-foot">' + opts.footer + "</div>" : "") +
        "</div></div>";
    document.body.style.overflow = "hidden";
    ui._modalOpen = true;
    var focusEl = root.querySelector("input,select,textarea,button");
    if (focusEl) setTimeout(function () { try { focusEl.focus(); } catch (e) {} }, 40);
    if (typeof opts.onMount === "function") opts.onMount(root);
  };
  ui.closeModal = function () {
    var root = document.getElementById("modal-root");
    root.innerHTML = "";
    ui._modalOpen = false;
    if (!ui._drawerOpen) document.body.style.overflow = "";
  };
  ui.drawer = function (opts) {
    var root = document.getElementById("modal-root");
    // title and eyebrow are plain-text slots — escape them.
    // body and footer are trusted HTML from page modules.
    root.innerHTML =
      '<div class="drawer-backdrop" data-close-modal></div>' +
      '<aside class="drawer" role="dialog" aria-modal="true" aria-label="' + ui.esc(opts.title || "Details") + '">' +
        '<div class="drawer-head"><div><p class="eyebrow" style="margin-bottom:3px">' + ui.esc(opts.eyebrow || "Room") + "</p><h2 class='card-title' style='font-size:17px'>" + ui.esc(opts.title || "") + "</h2></div>" +
        '<button class="modal-close" data-close-modal aria-label="Close">' + ui.icon("close", 14) + "</button></div>" +
        '<div class="drawer-body">' + (opts.body || "") + "</div>" +
        (opts.footer ? '<div class="drawer-foot">' + opts.footer + "</div>" : "") +
      "</aside>";
    document.body.style.overflow = "hidden";
    ui._drawerOpen = true;
  };
  ui.closeDrawer = function () {
    document.getElementById("modal-root").innerHTML = "";
    ui._drawerOpen = false;
    if (!ui._modalOpen) document.body.style.overflow = "";
  };

  ui.confirm = function (opts) {
    ui.modal({
      title: opts.title || "Are you sure?",
      sub: opts.sub || "",
      slim: true,
      // opts.body here is always a plain-text description — escape it.
      body: '<p class="muted" style="font-size:12px;line-height:1.6">' + ui.esc(opts.body || "This action will be recorded in the activity log.") + "</p>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn ' + (opts.danger ? "danger" : "primary") + '" data-confirm="' + ui.esc(opts.id || "yes") + '">' + ui.esc(opts.label || "Confirm") + "</button>"
    });
  };

  ui.toast = function (message, type) {
    var root = document.getElementById("toast-root");
    var el = document.createElement("div");
    el.className = "toast" + (type === "error" ? " error" : "");
    el.innerHTML = ui.icon(type === "error" ? "alert" : "checkCircle", 15) + "<div>" + ui.esc(message) + "</div>";
    root.appendChild(el);
    setTimeout(function () {
      el.classList.add("out");
      setTimeout(function () { el.remove(); }, 220);
    }, 3800);
  };

  /* ---------------- charts ---------------- */
  ui.areaChart = function (series, opts) {
    opts = opts || {};
    var w = opts.width || 720, h = opts.height || 210;
    var pad = { l: 40, r: 12, t: 14, b: 26 };
    if (!series.length) return ui.empty("No data", "Nothing to chart for this period.");
    var vals = series.map(function (p) { return p.value; });
    var max = Math.max.apply(null, vals);
    var min = Math.min.apply(null, vals);
    var padTop = (max - min) * 0.25 || max * 0.1 || 1;
    var hi = Math.ceil((max + padTop) / 10) * 10;
    // opts.max lets a caller reserve headroom for an overlaid series, so the
    // second line never runs off the top of an axis built from the first.
    if (opts.max) hi = Math.max(hi, Math.ceil((opts.max + padTop) / 10) * 10);
    var lo = Math.max(0, Math.floor((min - padTop) / 10) * 10);
    if (opts.minZero) lo = 0;
    if (opts.suffix === "%") { hi = Math.min(100, Math.ceil((max + padTop) / 5) * 5); lo = Math.max(0, Math.floor((min - padTop) / 5) * 5); }
    var iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
    function x(i) { return pad.l + (series.length === 1 ? iw / 2 : (i / (series.length - 1)) * iw); }
    function y(v) { return pad.t + ih * (1 - (v - lo) / (hi - lo || 1)); }
    var line = series.map(function (p, i) { return (i ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1); }).join(" ");
    var area = line + " L" + x(series.length - 1).toFixed(1) + " " + (pad.t + ih) + " L" + x(0).toFixed(1) + " " + (pad.t + ih) + " Z";
    var grid = "", ticks = 4;
    for (var t = 0; t <= ticks; t++) {
      var val = lo + (hi - lo) * t / ticks;
      var yy = y(val);
      grid += '<line class="grid-line" x1="' + pad.l + '" x2="' + (w - pad.r) + '" y1="' + yy.toFixed(1) + '" y2="' + yy.toFixed(1) + '"/>';
      grid += '<text class="axis-label" x="' + (pad.l - 7) + '" y="' + (yy + 3).toFixed(1) + '" text-anchor="end">' + (opts.money ? U.compact(val) : Math.round(val) + (opts.suffix || "")) + "</text>";
    }
    var xLabels = "", step = Math.max(1, Math.ceil(series.length / (opts.xTicks || 6)));
    series.forEach(function (p, i) {
      if (i % step !== 0 && i !== series.length - 1) return;
      xLabels += '<text class="axis-label" x="' + x(i).toFixed(1) + '" y="' + (h - 7) + '" text-anchor="middle">' + ui.esc(p.label) + "</text>";
    });
    var dots = "";
    if (opts.dots !== false) {
      series.forEach(function (p, i) {
        if (i % Math.max(1, Math.ceil(series.length / 10)) !== 0 && i !== series.length - 1) return;
        dots += '<circle cx="' + x(i).toFixed(1) + '" cy="' + y(p.value).toFixed(1) + '" r="2.4" style="fill:var(--card);stroke:var(--gold)" stroke-width="1.6"/>';
      });
    }
    var alt = "";
    if (opts.alt) {
      var avals = opts.alt.map(function (p) { return p.value; });
      var amax = Math.max.apply(null, avals);
      var amin = Math.min.apply(null, avals);
      var ah = opts.altScale || hi;
      alt = opts.alt.map(function (p, i) {
        var yy = pad.t + ih * (1 - (p.value - 0) / (ah || 1));
        return (i ? "L" : "M") + x(i).toFixed(1) + " " + yy.toFixed(1);
      }).join(" ");
    }
    return '<svg class="chart" viewBox="0 0 ' + w + " " + h + '" preserveAspectRatio="none" role="img" aria-label="' + ui.esc(opts.label || "Chart") + '">' +
      '<defs><linearGradient id="areaGold" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" style="stop-color:var(--gold);stop-opacity:.5"/><stop offset="100%" style="stop-color:var(--gold);stop-opacity:0"/></linearGradient></defs>' +
      grid + '<path class="area" d="' + area + '"/>' +
      (alt ? '<path class="line-alt" d="' + alt + '"/>' : "") +
      '<path class="line-main" d="' + line + '" vector-effect="non-scaling-stroke"/>' + dots + xLabels + "</svg>";
  };

  ui.donut = function (items, centerLabel, centerValue) {
    var colors = ui.palette();
    var total = items.reduce(function (s, i) { return s + i.value; }, 0) || 1;
    var acc = 0;
    var stops = items.map(function (item, i) {
      var start = acc / total * 360;
      acc += item.value;
      var end = acc / total * 360;
      return colors[i % colors.length] + " " + start.toFixed(1) + "deg " + end.toFixed(1) + "deg";
    }).join(", ");
    return '<div class="donut" style="background:conic-gradient(' + stops + ')"><div class="donut-center"><b>' + centerValue + "</b><span>" + ui.esc(centerLabel) + "</span></div></div>";
  };

  ui.barList = function (items, opts) {
    opts = opts || {};
    var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    return '<div class="stack" style="gap:9px">' + items.map(function (i) {
      // Money bars are counted in one currency across the whole list; a document
      // billed in another says so here rather than borrowing the naira sign.
      return '<div><div class="row between" style="margin-bottom:4px"><span class="small strong">' + ui.esc(i.label) + '</span><span class="tiny muted num">' + (opts.money ? U.money(i.value, opts.currency) : i.value) + "</span></div>" +
        '<div class="progress" style="height:6px;background:var(--line-2)"><span style="width:' + Math.max(3, i.value / max * 100).toFixed(1) + "%;background:" + (i.color || "var(--gold)") + '"></span></div></div>';
    }).join("") + "</div>";
  };

  ui.csv = function (filename, rows) {
    var csv = rows.map(function (r) { return r.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  };

  ui.timeGreeting = function () {
    var h = new Date().getHours();
    return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
  };
  ui.todayLong = function () {
    return U.pretty(LHMS.bizDay(), "long");
  };

  /* close handlers */
  document.addEventListener("click", function (e) {
    if (e.target.closest("[data-close-modal]") || (e.target.matches("[data-modal-backdrop]"))) {
      ui.closeModal();
      ui.closeDrawer();
    }
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && (ui._modalOpen || ui._drawerOpen)) { ui.closeModal(); ui.closeDrawer(); }
  });
})();
