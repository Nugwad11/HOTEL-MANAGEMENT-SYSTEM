/* ============================================================
   Aurelia Grand — shell, routing and application events
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var session = LHMS.session;
  LHMS.pages = LHMS.pages || {};
  LHMS.uiActions = LHMS.uiActions || {};
  LHMS.forms = LHMS.forms || {};

  /* ---------------- navigation ---------------- */
  var NAV = [
    {
      group: "Front Desk", items: [
        { key: "today", label: "Today", icon: "home", roles: ["Front Desk", "Manager"] },
        { key: "room-map", label: "Room map", icon: "grid", roles: ["Front Desk", "Manager"] },
        { key: "timeline", label: "Availability", icon: "calendar", roles: ["Front Desk", "Manager", "Revenue"] },
        { key: "reservations", label: "Reservations", icon: "list", roles: ["Front Desk", "Manager", "Revenue"] },
        { key: "check-out", label: "Departures", icon: "logout", roles: ["Front Desk", "Manager"] }
      ]
    },
    {
      group: "Guests", items: [
        { key: "guests", label: "Guest directory", icon: "users", roles: ["Front Desk", "Manager", "Housekeeping", "Revenue"] },
        { key: "requests", label: "Guest requests", icon: "message", roles: ["Front Desk", "Manager", "Housekeeping"], badge: "requests" }
      ]
    },
    {
      group: "Housekeeping", items: [
        { key: "housekeeping", label: "Supervisor board", icon: "broom", roles: ["Housekeeping", "Manager"] },
        { key: "my-rooms", label: "My rooms", icon: "door", roles: ["Housekeeping", "Manager"] },
        { key: "lost-found", label: "Lost & found", icon: "box", roles: ["Housekeeping", "Front Desk", "Manager"] }
      ]
    },
    {
      group: "Business", items: [
        { key: "manager", label: "Manager dashboard", icon: "chart", roles: ["Manager", "Revenue"] },
        { key: "reports", label: "Reports", icon: "file", roles: ["Manager", "Revenue"] },
        { key: "revenue", label: "Rate & inventory", icon: "trendUp", roles: ["Manager", "Revenue"] },
        { key: "reviews", label: "Reviews", icon: "star", roles: ["Manager", "Revenue"] }
      ]
    },
    {
      group: "Events & services", items: [
        { key: "events", label: "Halls & events", icon: "users", roles: ["Front Desk", "Manager", "Revenue"] },
        { key: "laundry", label: "Laundry board", icon: "box", roles: ["Housekeeping", "Front Desk", "Manager"], badge: "laundry" }
      ]
    },
    {
      group: "Financial management", items: [
        { key: "financials", label: "Financial dashboard", icon: "chart", roles: ["Manager", "Revenue", "Auditor", "Finance Manager"] },
        { key: "fin-reports", label: "Financial reports", icon: "file", roles: ["Manager", "Revenue", "Auditor", "Finance Manager"] },
        { key: "prices", label: "Price & services setup", icon: "tag", roles: ["Manager", "Revenue"] },
        { key: "taxes", label: "Taxes & service charges", icon: "receipt", roles: ["Manager", "Revenue"] },
        { key: "invoices", label: "Invoices & billing", icon: "file", roles: ["Front Desk", "Manager", "Revenue", "Finance Manager"] },
        { key: "receipts", label: "Payments & receipts", icon: "card", roles: ["Front Desk", "Manager", "Revenue"] },
        { key: "expenses", label: "Operating expenses", icon: "box", roles: ["Front Desk", "Housekeeping", "Manager", "Revenue", "Finance Manager"] },
        { key: "fin-audit", label: "Audit trail", icon: "clock", roles: ["Manager", "Front Desk", "Revenue", "Auditor", "Finance Manager"] },
        { key: "fin-settings", label: "Financial settings", icon: "settings", roles: ["Manager", "Front Desk", "Revenue", "Auditor", "Finance Manager"], badge: "approvals" }
      ]
    },
    {
      group: "Records", items: [
        { key: "documents", label: "Documents", icon: "file", roles: ["Front Desk", "Housekeeping", "Manager", "Revenue", "Finance Manager"] }
      ]
    },
    {
      group: "Hotel", items: [
        { key: "staff", label: "Staff & permissions", icon: "shield", roles: ["Manager"] },
        { key: "setup", label: "Hotel setup", icon: "settings", roles: ["Manager"] },
        { key: "activity", label: "Activity log", icon: "clock", roles: ["Manager", "Front Desk", "Auditor"] },
        { key: "notifications", label: "Notifications", icon: "bell", roles: ["Front Desk", "Manager", "Housekeeping", "Revenue"], badge: "notifications" }
      ]
    }
  ];

  var LANDING = { "Manager": "manager", "Front Desk": "today", "Housekeeping": "housekeeping", "Revenue": "reports", "Finance Manager": "financials", "Auditor": "fin-reports", "Guest": "guest/stay" };

  var ROUTES = {
    "today": { roles: ["Front Desk", "Manager"], title: "Today" },
    "room-map": { roles: ["Front Desk", "Manager"], title: "Room map" },
    "timeline": { roles: ["Front Desk", "Manager", "Revenue"], title: "Availability timeline" },
    "reservations": { roles: ["Front Desk", "Manager", "Revenue"], title: "Reservations" },
    "booking": { roles: ["Front Desk", "Manager", "Revenue"], title: "Reservation" },
    "check-in": { roles: ["Front Desk", "Manager"], title: "Check-in" },
    "folio": { roles: ["Front Desk", "Manager"], title: "Guest folio" },
    "check-out": { roles: ["Front Desk", "Manager"], title: "Departures" },
    "guests": { roles: ["Front Desk", "Manager", "Housekeeping", "Revenue"], title: "Guest directory" },
    "requests": { roles: ["Front Desk", "Manager", "Housekeeping"], title: "Guest requests" },
    "housekeeping": { roles: ["Housekeeping", "Manager"], title: "Housekeeping" },
    "my-rooms": { roles: ["Housekeeping", "Manager"], title: "My rooms" },
    "lost-found": { roles: ["Housekeeping", "Front Desk", "Manager"], title: "Lost & found" },
    "events": { roles: ["Front Desk", "Manager", "Revenue"], title: "Halls & events" },
    "laundry": { roles: ["Housekeeping", "Front Desk", "Manager"], title: "Laundry board" },
    "manager": { roles: ["Manager", "Revenue"], title: "Manager dashboard" },
    "reports": { roles: ["Manager", "Revenue"], title: "Reports" },
    "revenue": { roles: ["Manager", "Revenue"], title: "Rate & inventory" },
    "reviews": { roles: ["Manager", "Revenue"], title: "Guest reviews" },
    "end-of-day": { roles: ["Manager"], title: "End of day" },
    "financials": { roles: ["Manager", "Revenue", "Auditor", "Finance Manager"], title: "Financial dashboard" },
    "fin-reports": { roles: ["Manager", "Revenue", "Auditor", "Finance Manager"], title: "Financial reports" },
    "fin-audit": { roles: ["Manager", "Front Desk", "Revenue", "Auditor", "Finance Manager"], title: "Financial audit trail" },
    "fin-settings": { roles: ["Manager", "Front Desk", "Revenue", "Auditor", "Finance Manager"], title: "Financial settings & approvals" },
    "expenses": { roles: ["Front Desk", "Housekeeping", "Manager", "Revenue", "Finance Manager"], title: "Operating expenses" },
    "prices": { roles: ["Manager", "Revenue"], title: "Price & services setup" },
    "taxes": { roles: ["Manager", "Revenue"], title: "Taxes & service charges" },
    "invoices": { roles: ["Front Desk", "Manager", "Revenue", "Finance Manager"], title: "Invoices & billing" },
    "receipts": { roles: ["Front Desk", "Manager", "Revenue"], title: "Payments & receipts" },
    "staff": { roles: ["Manager"], title: "Staff & permissions" },
    "setup": { roles: ["Manager"], title: "Hotel setup" },
    "activity": { roles: ["Manager", "Front Desk", "Auditor"], title: "Activity log" },
    "documents": { roles: ["Front Desk", "Housekeeping", "Manager", "Revenue", "Finance Manager"], title: "Document register" },
    "notifications": { roles: ["Front Desk", "Manager", "Housekeeping", "Revenue"], title: "Notifications" },
    "guest": { roles: ["Guest"], title: "Guest portal" }
  };

  function parseRoute() {
    var raw = (location.hash || "").replace(/^#\/?/, "");
    if (!raw) raw = LANDING[session.role] || "today";
    var parts = raw.split("/").filter(Boolean);
    return { key: parts[0] || "today", sub: parts[1] || "", parts: parts };
  }

  LHMS.go = function (path) { location.hash = "#/" + String(path).replace(/^#?\/?/, ""); };
  LHMS.rerender = function () { render(); };

  function canSee(routeKey) {
    var r = ROUTES[routeKey];
    if (!r) return false;
    return r.roles.indexOf(session.role) !== -1;
  }

  function badgeCount(kind) {
    if (kind === "requests") return LHMS.tasksOf().filter(function (t) { return t.status !== "Done"; }).length;
    if (kind === "notifications") return LHMS.calc.unread();
    if (kind === "laundry") return LHMS.laundryOf().filter(function (o) { return o.status !== "Collected"; }).length;
    if (kind === "approvals") return LHMS.approvals("Pending").length;
    return 0;
  }

  /* ---------------- sign-in ---------------- */
  // The property's brand, or the group lock-up when a hotel has not dressed
  // itself yet. Reading it here rather than at each call site keeps the
  // sign-in page, the sidebar and the top bar on the same name.
  function brandingOf(pid) {
    return LHMS.get.branding ? LHMS.get.branding(pid)
      : { brandName: "Aurelia Grand", tagline: "Hotels & Residences", logo: "", images: [], palette: null, useColors: false };
  }

  function brandMark(size, b) {
    b = b || brandingOf();
    if (b.logo) return '<span class="brand-mark has-logo"><img src="' + ui.esc(b.logo) + '" alt="" /></span>';
    return '<span class="brand-mark">' + ui.icon("building", size) + "</span>";
  }

  function signInView() {
    var b = brandingOf();
    var slides = (b.images.length ? b.images : [{ src: "assets/img/hero.jpg", name: "Aurelia Grand Marina at dusk" }]).slice(0, 6);
    var slideHtml = slides.map(function (img, i) {
      return '<img class="signin-slide" src="' + ui.esc(img.src) + '" alt="' + ui.esc(img.name || "Hotel photograph") + '"' +
        (slides.length > 1 ? ' style="animation-delay:' + (-(i * 24 / slides.length)) + 's"' : "") + " />";
    }).join("");
    return '<div class="signin">' +
      '<section class="signin-visual brand-count-' + slides.length + '">' +
        slideHtml +
        '<div class="brand">' + brandMark(23, b) + '<div><span class="brand-name">' + ui.esc(b.brandName) + '</span><span class="brand-kicker">' + ui.esc(b.tagline || "Hotels & Residences") + '</span></div></div>' +
        '<div class="signin-copy">' +
          '<p class="eyebrow">Staff portal</p>' +
          '<h1>Every detail,<br/>remembered.</h1>' +
          '<p>One guest profile, shared across the front desk, housekeeping, kitchens and spa — so a preference is never asked for twice. Built for the standards of a five-star property.</p>' +
          '<div class="signin-stats">' +
            '<div><b>3</b><span>Properties</span></div>' +
            '<div><b>102</b><span>Keys</span></div>' +
            '<div><b>99.9%</b><span>Core uptime</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="signin-footnote"><span>Lagos · Abuja</span><span>LHMS v1.0</span></div>' +
      '</section>' +
      '<section class="signin-panel">' +
        '<div class="signin-card">' +
          '<p class="eyebrow">Welcome back</p>' +
          '<h2>Sign in to your hotel</h2>' +
          '<p class="signin-lede">Use your Aurelia staff account. Your property opens on the desk you are entitled to.</p>' +
          '<form class="signin-form" data-form="signin" novalidate>' +
            '<div class="field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="username" placeholder="you@aureliagrand.com" /></div>' +
            '<div class="field"><label for="password">Password</label><div class="pw-wrap"><input id="password" name="password" type="password" autocomplete="current-password" placeholder="Enter your password" /><button type="button" class="pw-toggle" data-act="toggle-password" aria-label="Show password">' + ui.icon("eye", 16) + '</button></div></div>' +
            '<div class="signin-actions"><label class="check" style="font-size:10.5px"><input type="checkbox" checked /> Keep me signed in</label><button type="button" class="forgot" data-act="forgot-password">Forgot password?</button></div>' +
            '<button class="btn primary lg block" type="submit">Sign in ' + ui.icon("right", 14) + '</button>' +
          '</form>' +
          '<div class="signin-alt">or open the guest portal</div>' +
          '<button class="signin-guest" data-act="guest-signin">' + ui.icon("key", 15) + ' Open the guest mobile experience</button>' +
          '<p class="signin-legal">By signing in you accept the Aurelia acceptable-use policy.<br/>Guest data is processed in line with NDPR and GDPR.</p>' +
        '</div>' +
      '</section>' +
    "</div>";
  }

  /* ---------------- shell ---------------- */
  function sidebarView(route) {
    var counts = { requests: badgeCount("requests"), notifications: badgeCount("notifications"), laundry: badgeCount("laundry"), approvals: badgeCount("approvals") };
    var nav = NAV.map(function (g) {
      var items = g.items.filter(function (i) { return i.roles.indexOf(session.role) !== -1; });
      if (!items.length) return "";
      return '<div class="nav-group"><div class="nav-heading">' + g.group + "</div>" + items.map(function (i) {
        var active = i.key === route.key || (route.key === "booking" && i.key === "reservations") ||
          (route.key === "folio" && i.key === "reservations") || (route.key === "check-in" && i.key === "today") ||
          (route.key === "end-of-day" && i.key === "manager") || (route.key === "my-rooms" && i.key === "housekeeping");
        var badge = i.badge && counts[i.badge] ? '<span class="nav-badge">' + counts[i.badge] + "</span>" : "";
        var href = i.key === "guests" ? "#/guests" : i.key === "housekeeping" ? "#/housekeeping" : i.key === "my-rooms" ? "#/my-rooms" : "#/" + i.key;
        return '<a class="nav-link' + (active ? " active" : "") + '" href="' + href + '" data-nav>' + ui.icon(i.icon, 16) + "<span>" + i.label + "</span>" + badge + "</a>";
      }).join("") + "</div>";
    }).join("");

    var p = LHMS.get.property();
    var b = brandingOf();
    var initials = U.initials(session.name || "User");
    return '<aside class="sidebar" aria-label="Main navigation">' +
      '<div class="sidebar-inner">' +
        '<a class="brand" href="#/' + (LANDING[session.role] || "today") + '">' + brandMark(23, b) + '<div><span class="brand-name">' + ui.esc(b.brandName) + '</span><span class="brand-kicker">' + ui.esc(b.tagline || p.short) + '</span></div></a>' +
        '<nav class="nav-scroll">' + nav + "</nav>" +
        '<div class="sidebar-foot">' +
          '<div class="sidebar-user">' + ui.avatar(session.name) + '<div style="min-width:0"><div class="sidebar-user-name">' + ui.esc(session.name || "Signed-in user") + '</div><div class="sidebar-user-role">' + ui.esc(session.role) + '</div></div><button class="icon-btn" style="width:30px;height:30px;margin-left:auto;background:transparent;border-color:rgba(255,255,255,.12);color:#aeb9c8" data-act="sign-out" title="Sign out" aria-label="Sign out">' + ui.icon("logout", 14) + '</button></div>' +
          '<div class="sidebar-note"><b>LHMS v1.0</b><br/>Workspace data is stored in this browser.</div>' +
        "</div>" +
      "</div></aside>";
  }

  function topbarView() {
    var unread = LHMS.calc.unread();
    var p = LHMS.get.property();
    var props = LHMS.db.properties.map(function (x) {
      return '<option value="' + x.id + '"' + (x.id === p.id ? " selected" : "") + ">" + ui.esc(x.name) + "</option>";
    }).join("");
    return '<header class="topbar">' +
      '<button class="hamburger" data-act="open-nav" aria-label="Open navigation">' + ui.icon("menu", 18) + "</button>" +
      '<div class="property-switch">' + brandMark(19) + '<div style="min-width:0"><select class="property-select" data-change="property" aria-label="Property">' + props + '</select><div class="property-caption">' + ui.esc(p.city) + " · " + p.star + "-star</div></div></div>" +
      '<div class="topbar-spacer"></div>' +
      '<button class="global-search" data-act="open-search" aria-label="Search guests, reservations and pages">' + ui.icon("search", 15) + '<span>Search guests, bookings…</span><kbd>⌘K</kbd></button>' +
      '<div class="top-actions">' +
        '<a class="icon-btn" href="#/notifications" aria-label="Notifications">' + ui.icon("bell", 17) + (unread ? '<span class="notif-dot"></span>' : "") + "</a>" +
        '<a href="#/staff" aria-label="Signed in as ' + ui.esc(session.name) + '">' + ui.avatar(session.name) + "</a>" +
      "</div></header>";
  }

  function shellView(route, content) {
    return '<div class="shell">' +
      '<div class="nav-scrim" data-act="close-nav"></div>' +
      sidebarView(route) +
      '<div class="workspace">' + topbarView() + '<main class="page" id="main">' + content + "</main></div>" +
      "</div>";
  }

  /* ---------------- page head ---------------- */
  ui.pageHead = function (o) {
    // title and eyebrow are plain-text — always escape. sub and actions are
    // trusted HTML slots assembled by page modules (callers pre-escape user data).
    return '<div class="page-head"><div><p class="eyebrow">' + ui.esc(o.eyebrow || "") + '</p><h1 class="page-title">' + ui.esc(o.title || "") + "</h1>" +
      (o.sub ? '<p class="page-sub">' + o.sub + "</p>" : "") + "</div>" +
      (o.actions ? '<div class="head-actions">' + o.actions + "</div>" : "") + "</div>";
  };

  ui.sectionCard = function (title, body, action, sub, icon) {
    return '<section class="card"><div class="card-head"><div><div class="card-title">' + (icon ? ui.icon(icon, 15) : "") + title + "</div>" + (sub ? '<div class="card-sub">' + sub + "</div>" : "") + "</div>" + (action || "") + "</div>" + body + "</section>";
  };

  ui.toolbar = function (left, right) {
    return '<div class="toolbar"><div class="toolbar-left">' + (left || "") + "</div><div class=\"row\">" + (right || "") + "</div></div>";
  };

  ui.searchField = function (placeholder, value, act) {
    return '<div class="search-input">' + ui.icon("search", 14) + '<input type="search" placeholder="' + ui.esc(placeholder) + '" value="' + ui.esc(value || "") + '" data-live="' + ui.esc(act) + '" aria-label="' + ui.esc(placeholder) + '" /></div>';
  };

  /* ---------------- render ---------------- */
  function render() {
    var app = document.getElementById("app");
    var brand = brandingOf();
    // The palette follows the property, including while signed out: the
    // sign-in page a manager sees is then the one their guests would see.
    if (LHMS.brand && LHMS.brand.apply) LHMS.brand.apply(brand);
    ui.closeModal();
    ui.closeDrawer();
    document.body.style.overflow = "";

    if (!session.signedIn) {
      app.innerHTML = signInView();
      document.title = "Sign in · " + brand.brandName;
      return;
    }
    if (session.role === "Guest") {
      var gtab = (parseRoute().key === "guest" ? parseRoute().sub : "") || "stay";
      app.innerHTML = LHMS.pages.guest ? LHMS.pages.guest(gtab) : ui.empty("Guest portal", "Loading");
      document.title = "Your stay · " + brand.brandName;
      if (LHMS.guestPortal && LHMS.guestPortal.onRender) LHMS.guestPortal.onRender();
      return;
    }

    var route = parseRoute();
    if (route.key === "guest") { LHMS.go(LANDING[session.role]); return; }
    if (!ROUTES[route.key] || !canSee(route.key)) {
      var fallback = LANDING[session.role] || "today";
      if (route.key !== fallback) { LHMS.go(fallback); return; }
      route = { key: fallback, sub: "", parts: [fallback] };
    }
    var page = LHMS.pages[route.key] || LHMS.pages[route.key.replace("-", "")];
    if (!page) {
      app.innerHTML = shellView(route, ui.pageHead({ eyebrow: "Coming soon", title: ROUTES[route.key].title }) + ui.empty("Module not available", "This module is not enabled for your property."));
      return;
    }
    var content;
    try {
      content = page(route);
    } catch (err) {
      console.error("LHMS page error", err);
      content = ui.pageHead({ eyebrow: "Error", title: "Something went wrong" }) +
        '<div class="notice danger">' + ui.icon("alert") + "<div><b>The " + ui.esc(route.key) + " screen could not render.</b><br/>" + ui.esc(err.message) + "</div></div>";
    }
    app.innerHTML = shellView(route, content);
    var titles = { today: "Today", "room-map": "Room map", timeline: "Availability", reservations: "Reservations", booking: "Reservation", "check-in": "Check-in", folio: "Guest folio", "check-out": "Departures", guests: "Guests", requests: "Guest requests", housekeeping: "Housekeeping", "my-rooms": "My rooms", "lost-found": "Lost & found", events: "Halls & events", laundry: "Laundry board", manager: "Manager dashboard", reports: "Reports", revenue: "Rates & inventory", reviews: "Reviews", documents: "Document register", "end-of-day": "End of day", prices: "Price setup", taxes: "Taxes & charges", invoices: "Invoices & billing", receipts: "Payments & receipts", financials: "Financial dashboard", "fin-reports": "Financial reports", expenses: "Operating expenses", staff: "Staff & permissions", setup: "Hotel setup", activity: "Activity log", notifications: "Notifications" };
    document.title = (titles[route.key] || ROUTES[route.key].title || "LHMS") + " · " + brand.brandName;
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    document.body.classList.remove("nav-open");
  }
  LHMS.render = render;

  /* ---------------- actions ---------------- */
  LHMS.uiActions["sign-out"] = function () {
    LHMS.signOut();
    location.hash = "";
    render();
  };
  LHMS.uiActions["open-nav"] = function () { document.body.classList.add("nav-open"); };
  LHMS.uiActions["close-nav"] = function () { document.body.classList.remove("nav-open"); };
  LHMS.uiActions["toggle-password"] = function (el) {
    var input = document.getElementById("password");
    if (!input) return;
    var show = input.type === "password";
    input.type = show ? "text" : "password";
    el.innerHTML = ui.icon(show ? "eyeOff" : "eye", 16);
  };
  LHMS.uiActions["forgot-password"] = function () {
    ui.modal({
      title: "Reset your password",
      sub: "Your property administrator can issue a new password.",
      slim: true,
      body: '<p class="muted" style="font-size:11px;line-height:1.7">Email delivery is not connected in this build, so a reset is handled in person by an administrator at your property. No reset link is sent from this screen.</p>',
      footer: '<button class="btn" data-close-modal>Close</button>'
    });
  };
  LHMS.uiActions["guest-signin"] = function () {
    session.signedIn = true;
    session.email = "guest@aureliagrand.com";
    session.name = "Adaeze Nwankwo";
    session.role = "Guest";
    session.propertyId = "agm";
    session.guestId = null;
    LHMS.bindGuestSession();
    LHMS.go("guest/stay");
    render();
  };

  LHMS.uiActions["open-search"] = function () {
    ui.modal({
      title: "Search",
      sub: "Jump to a guest, reservation, room or module.",
      body: '<div class="search-input" style="margin-bottom:12px">' + ui.icon("search", 15) + '<input id="cmd-search" type="search" placeholder="Type a name, booking reference, room…" data-cmd-input autocomplete="off" /></div><div id="cmd-results">' + cmdResults("") + "</div>"
    });
    setTimeout(function () { var i = document.getElementById("cmd-search"); if (i) i.focus(); }, 30);
  };

  function cmdResults(q) {
    q = q.toLowerCase().trim();
    var items = [];
    if (!q) {
      items = [
        { label: "Today's arrivals", sub: "Front desk · today", href: "#/today", icon: "home" },
        { label: "Room map", sub: "Live room status", href: "#/room-map", icon: "grid" },
        { label: "Reservations", sub: "Search all bookings", href: "#/reservations", icon: "list" },
        { label: "Guest requests", sub: "SLA task queue", href: "#/requests", icon: "message" },
        { label: "Manager dashboard", sub: "Performance overview", href: "#/manager", icon: "chart" },
        { label: "Financial dashboard", sub: "Revenue earned vs cash collected", href: "#/financials", icon: "receipt" },
        { label: "Financial reports", sub: "Ten period reports, exportable", href: "#/fin-reports", icon: "file" },
        { label: "Reports", sub: "Occupancy, ADR, RevPAR", href: "#/reports", icon: "file" }
      ];
    } else {
      LHMS.db.guests.forEach(function (g) {
        if ((g.name + " " + g.email).toLowerCase().indexOf(q) !== -1) items.push({ label: g.name, sub: g.tier + " · " + g.email, href: "#/guests/" + g.id, icon: "user" });
      });
      LHMS.reservationsOf().concat(LHMS.db.reservations.filter(function (r) { return r.propertyId !== session.propertyId; })).forEach(function (r) {
        var g = LHMS.get.guest(r.guestId);
        if ((r.reference + " " + (g ? g.name : "") + " " + ui.roomNo(r.roomId)).toLowerCase().indexOf(q) !== -1) {
          items.push({ label: r.reference + " · " + (g ? g.name : "Guest"), sub: U.pretty(r.checkIn, "short") + " → " + U.pretty(r.checkOut, "short") + " · " + r.status, href: "#/booking/" + r.id, icon: "calendar" });
        }
      });
      LHMS.eventsOf().forEach(function (e) {
        if ((e.title + " " + e.organizer + " " + e.hallName).toLowerCase().indexOf(q) !== -1) {
          items.push({ label: e.title, sub: e.hallName + " · " + U.pretty(e.date, "short") + " " + e.start + "–" + e.end + " · " + e.status, href: "#/events", icon: "users" });
        }
      });
      LHMS.laundryOf().forEach(function (o) {
        if ((o.ref + " " + o.roomNumber + " " + ui.guestName(o.guestId)).toLowerCase().indexOf(q) !== -1) {
          items.push({ label: o.ref + " · Room " + o.roomNumber, sub: "Laundry · " + o.status + " · " + U.money(o.total, o.currency), href: "#/laundry", icon: "box" });
        }
      });
      LHMS.invoicesOf().forEach(function (inv) {
        var t = LHMS.invoiceMoney(inv);
        if ((inv.number + " " + inv.title).toLowerCase().indexOf(q) !== -1) {
          items.push({ label: inv.number + " · " + inv.title, sub: t.status + " · " + U.money(t.total, inv.currency) + " billed · " + U.money(t.balance, inv.currency) + " outstanding", href: "#/invoices/" + inv.id, icon: "receipt" });
        }
      });
      if (canSee("expenses")) LHMS.expensesOf().forEach(function (e) {
        if ((e.description + " " + e.payee + " " + e.category).toLowerCase().indexOf(q) !== -1) {
          items.push({ label: e.description, sub: e.category + " · " + e.payee + " · " + U.money(e.amount, e.currency) + " · " + e.status, href: "#/expenses", icon: "box" });
        }
      });
      ["today", "room-map", "timeline", "reservations", "guests", "requests", "housekeeping", "events", "laundry", "manager", "reports", "revenue", "reviews", "prices", "taxes", "invoices", "receipts", "financials", "fin-reports", "expenses", "documents", "setup"].forEach(function (k) {
        var r = ROUTES[k];
        if (r && !canSee(k)) return;
        var label = r ? r.title : k;
        if (label.toLowerCase().indexOf(q) !== -1) items.push({ label: label, sub: "Module", href: "#/" + k, icon: "grid" });
      });
    }
    items = items.slice(0, 8);
    if (!items.length) return '<div class="empty" style="padding:24px">No matches for “' + ui.esc(q) + '”.</div>';
    return '<div class="list">' + items.map(function (i) {
      return '<a class="nav-link" style="color:var(--ink);border-radius:8px" href="' + i.href + '" data-cmd-go>' + ui.icon(i.icon, 15) + '<span style="flex:1">' + ui.esc(i.label) + '<span class="tiny muted" style="display:block;font-weight:400;margin-top:1px">' + ui.esc(i.sub) + "</span></span>" + ui.icon("right", 12) + "</a>";
    }).join("") + "</div>";
  }

  /* ---------------- forms ---------------- */
  LHMS.forms.signin = function (form) {
    var data = new FormData(form);
    var result = LHMS.signIn(data.get("email"), data.get("password"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    if (result.role === "Guest") { LHMS.go("guest/stay"); }
    else { location.hash = "#/" + (LANDING[result.role] || "today"); }
    render();
  };

  /* ---------------- delegated events ---------------- */
  document.addEventListener("click", function (e) {
    var actionEl = e.target.closest("[data-act]");
    if (actionEl) {
      var name = actionEl.getAttribute("data-act");
      var fn = LHMS.uiActions[name];
      if (fn) {
        e.preventDefault();
        try { fn(actionEl, e); } catch (err) { console.error(err); ui.toast("Action failed: " + err.message, "error"); }
        return;
      }
    }
    var nav = e.target.closest("[data-nav]");
    if (nav) document.body.classList.remove("nav-open");
    var cmd = e.target.closest("[data-cmd-go]");
    if (cmd) { ui.closeModal(); }
  });

  document.addEventListener("submit", function (e) {
    var form = e.target.closest("form[data-form]");
    if (!form) return;
    e.preventDefault();
    var name = form.getAttribute("data-form");
    var fn = LHMS.forms[name];
    if (fn) {
      try { fn(form, e); } catch (err) { console.error(err); ui.toast("Could not save: " + err.message, "error"); }
    }
  });

  document.addEventListener("change", function (e) {
    var el = e.target.closest("[data-change]");
    if (el) {
      var name = el.getAttribute("data-change");
      if (name === "property") {
        LHMS.switchProperty(el.value);
        render();
        return;
      }
      if (name === "role") {
        // Kept for the automation that drives captures across roles. The signed-in
        // desk no longer offers a perspective switch: a role comes from sign-in.
        LHMS.switchRole(el.value);
        if (session.role === "Guest") { LHMS.go("guest/stay"); }
        else { location.hash = "#/" + (LANDING[session.role] || "today"); }
        // go() is a no-op when the hash already matches, so always repaint
        render();
        return;
      }
      var fn = LHMS.uiActions["change:" + name];
      if (fn) { fn(el, e); return; }
    }
    var quoteEl = e.target.closest("[data-quote-field]");
    if (quoteEl && LHMS.onQuoteChange) { LHMS.onQuoteChange(); }
  });

  document.addEventListener("input", function (e) {
    var cmd = e.target.closest("[data-cmd-input]");
    if (cmd) { var box = document.getElementById("cmd-results"); if (box) box.innerHTML = cmdResults(cmd.value); return; }
    var live = e.target.closest("[data-live]");
    if (live) {
      var key = live.getAttribute("data-live");
      var fn = LHMS.uiActions["live:" + key];
      if (fn) {
        clearTimeout(live._t);
        live._t = setTimeout(function () { fn(live.value, live); }, 150);
      }
    }
  });

  document.addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      if (session.signedIn) LHMS.uiActions["open-search"]();
    }
    if (e.key === "Enter" && e.target.matches("[data-cmd-input]")) {
      var first = document.querySelector("[data-cmd-go]");
      if (first) { e.preventDefault(); first.click(); }
    }
  });

  window.addEventListener("hashchange", function () {
    render();
  });

  /* boot */
  if (session.signedIn && session.role === "Guest") {
    if (!/^#\/guest/.test(location.hash)) location.hash = "#/guest/stay";
  }
  render();
})();
