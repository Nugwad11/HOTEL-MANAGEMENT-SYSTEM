/* ============================================================
   Aurelia Grand — application store
   Persistence, selectors, derived metrics and domain actions.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var DB_KEY = "aurelia.lhms.db.v1";
  var SESSION_KEY = "aurelia.lhms.session.v1";

  // The accounts the seeded workspace ships with. The browser holds no password
  // store of its own — sign-in binds a role to the workspace, and the REST API
  // is where real credentials are checked (bcrypt + JWT).
  var STAFF_ACCOUNTS = [
    { role: "Manager", name: "Ifeoma Okafor", email: "ifeoma.okafor@aureliagrand.com", label: "General Manager · all modules" },
    { role: "Front Desk", name: "Adamu Bello", email: "adamu.bello@aureliagrand.com", label: "Front Office Manager · front desk" },
    { role: "Housekeeping", name: "Grace Mensah", email: "grace.mensah@aureliagrand.com", label: "Housekeeping Supervisor · rooms" },
    { role: "Revenue", name: "Chiamaka Obi", email: "chiamaka.obi@aureliagrand.com", label: "Revenue Manager · pricing" },
    { role: "Finance Manager", name: "Emeka Balogun", email: "emeka.balogun@aureliagrand.com", label: "Financial Controller · the ledger and the second signature" },
    { role: "Auditor", name: "Folashade Adeyemi", email: "auditor@aureliagrand.com", label: "Group audit · read-only" },
    { role: "Guest", name: "Adaeze Nwankwo", email: "guest@aureliagrand.com", label: "Guest portal · mobile experience" }
  ];

  var PERMISSIONS = [
    { key: "manage_reservations", label: "Create and amend reservations" },
    { key: "check_in_out", label: "Check guests in and out" },
    { key: "view_guest_profiles", label: "View guest profiles and preferences" },
    { key: "edit_guest_profiles", label: "Edit preferences, notes and consent" },
    { key: "housekeeping_board", label: "Manage room status and housekeeping" },
    { key: "post_charges", label: "Post charges to guest folios" },
    { key: "take_payments", label: "Take payments and settle folios" },
    { key: "manage_billing", label: "Raise invoices, apply payments, discounts and refunds" },
    { key: "record_expenses", label: "Record operating expenses against a supplier" },
    { key: "approve_expenses", label: "Approve or reject recorded expenses" },
    { key: "manage_financial_settings", label: "Change invoice numbering, payment terms and approval limits" },
    { key: "approve_financial_changes", label: "Clear a price, discount or refund that crosses an approval limit" },
    { key: "view_reports", label: "Access revenue and performance reports" },
    { key: "manage_rates", label: "Change rates, inventory and restrictions" },
    { key: "configure_prices", label: "Configure service prices, taxes and service charges" },
    { key: "book_events", label: "Book and cancel halls and event add-ons" },
    { key: "run_laundry", label: "Take, price and return laundry orders" },
    { key: "manage_staff", label: "Manage staff access and permissions" },
    { key: "night_audit", label: "Run the night audit and close the day" }
  ];

  function defaultPermissions() {
    var all = {};
    PERMISSIONS.forEach(function (p) { all[p.key] = true; });
    var none = {};
    PERMISSIONS.forEach(function (p) { none[p.key] = false; });
    return {
      Manager: Object.assign({}, all),
      "Front Desk": Object.assign({}, none, {
        manage_reservations: true, check_in_out: true, view_guest_profiles: true, edit_guest_profiles: true,
        post_charges: true, take_payments: true, manage_billing: true, book_events: true
      }),
      Housekeeping: Object.assign({}, none, {
        view_guest_profiles: true, housekeeping_board: true, record_expenses: true, run_laundry: true
      }),
      Revenue: Object.assign({}, none, {
        manage_reservations: true, view_guest_profiles: true, view_reports: true,
        manage_rates: true, configure_prices: true
      }),
      // The second pair of hands the four-eyes gate has been asking for. The
      // ledger is theirs to keep and the wide moves are theirs to sign, but they
      // sell nothing, price nothing, record no cost of their own and never seal
      // the day — so every request they sign is another hand's asking, and the
      // cost they approve is one somebody else recorded.
      "Finance Manager": Object.assign({}, none, {
        manage_billing: true, approve_expenses: true, manage_financial_settings: true,
        approve_financial_changes: true, view_reports: true
      }),
      // Read-only by construction: the one permission an auditor holds is the
      // right to look. Every write in the module checks a different key.
      Auditor: Object.assign({}, none, { view_reports: true }),
      Guest: {}
    };
  }

  function loadDb() {
    try {
      var raw = localStorage.getItem(DB_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.meta || parsed.meta.version !== 9) return null;
      // The seed is generated relative to the real calendar day, so the stored
      // snapshot is only stale when that day changes. A business date the night
      // audit rolled forward is not staleness — refreshing here would throw away
      // a closed day and every charge posted against it.
      if ((parsed.meta.seededOn || parsed.meta.day) !== U.today()) return null;
      return parsed;
    } catch (e) { return null; }
  }

  var db = loadDb() || LHMS.buildSeed();
  if (!db.permissions) db.permissions = defaultPermissions();
  // A permission set saved before a role or a right existed cannot vote on it:
  // the stored answers win, and anything new arrives with its default.
  var permDefaults = defaultPermissions();
  Object.keys(permDefaults).forEach(function (role) {
    db.permissions[role] = Object.assign({}, permDefaults[role], db.permissions[role] || {});
  });
  if (!db.approvals) db.approvals = [];
  if (!db.closedDays) db.closedDays = [];
  if (!db.waitlistOffers) db.waitlistOffers = [];
  if (!db.meta.seededOn) db.meta.seededOn = db.meta.day;
  if (!db.session) db.session = { propertyId: "agm", role: "Front Desk" };
  LHMS.db = db;

  // The business date, not the wall clock. Every line of money and every
  // "today" selector reads through here, so closing a day and rolling the date
  // moves the whole house forward together instead of half the app lagging a
  // real calendar day behind.
  function bizDay() { return db.meta.day; }
  LHMS.bizDay = bizDay;
  Object.defineProperty(LHMS, "day", { get: bizDay, configurable: true });

  // A price read with no date named is a read for tonight, and tonight is the
  // business date — once the audit rolls the day, an undated read has to follow
  // it instead of falling back to the wall clock.
  function dated(opts) {
    var o = Object.assign({}, opts || {});
    if (!o.date) o.date = bizDay();
    return o;
  }

  LHMS.save = function () {
    try { localStorage.setItem(DB_KEY, JSON.stringify(db)); }
    catch (e) { console.warn("LHMS: could not persist local state", e); }
  };

  /* ---------------- session ---------------- */
  function loadSession() {
    var VALID_ROLES = ["Manager", "Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Auditor", "Guest"];
    try {
      var raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        // Integrity check: reject sessions whose role is not in the known set so
        // a tampered sessionStorage entry cannot grant unexpected access.
        if (parsed && VALID_ROLES.indexOf(parsed.role) !== -1) return parsed;
      }
    } catch (e) { /* ignore */ }
    return { signedIn: false, email: "", name: "", role: "Front Desk", propertyId: "agm" };
  }
  var session = (LHMS.session = loadSession());
  if (!session.propertyId) session.propertyId = "agm";
  if (!db.properties.some(function (p) { return p.id === session.propertyId; })) session.propertyId = "agm";
  db.session.propertyId = session.propertyId;
  if (!session.guestId) session.guestId = null;

  LHMS.persistSession = function () {
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (e) { /* ignore */ }
    db.session.propertyId = session.propertyId;
    LHMS.save();
  };

  LHMS.signIn = function (email, password) {
    email = String(email || "").trim().toLowerCase();
    if (!email || !password || String(password).length < 4) {
      return { ok: false, error: "Enter your work email and a password of at least 4 characters." };
    }
    // Only accounts in STAFF_ACCOUNTS are recognised. Unknown emails always get
    // the lowest-privilege staff role — never Manager — regardless of what the
    // email address contains.
    var acct = STAFF_ACCOUNTS.find(function (a) { return a.email.toLowerCase() === email; });
    if (!acct) {
      var role = /housekeep|clean/i.test(email) ? "Housekeeping"
        : /revenue|rate/i.test(email) ? "Revenue"
        : /audit/i.test(email) ? "Auditor"
        : "Front Desk"; // unknown emails can never self-elevate to Manager
      var staff = db.staff.find(function (s) { return s.role === role && s.propertyId === "agm"; });
      acct = { role: role, name: staff ? staff.name : "User", email: email };
    }
    session.signedIn = true;
    session.email = acct.email;
    session.name = acct.name;
    session.role = acct.role;
    session.propertyId = "agm";
    session.guestId = null;
    if (acct.role === "Guest") LHMS.bindGuestSession();
    else LHMS.persistSession();
    return { ok: true, role: acct.role };
  };

  LHMS.signOut = function () {
    session.signedIn = false;
    session.email = "";
    session.name = "";
    session.guestId = null;
    LHMS.persistSession();
  };

  LHMS.switchRole = function (role) {
    session.role = role;
    session.guestId = null;
    if (role === "Guest") session.propertyId = "agm";
    var staff = db.staff.find(function (s) { return s.role === role && s.propertyId === session.propertyId; });
    var acct = STAFF_ACCOUNTS.find(function (a) { return a.role === role; });
    session.name = acct ? acct.name : staff ? staff.name : session.name;
    if (role === "Guest") { LHMS.bindGuestSession(); return; }
    LHMS.persistSession();
  };

  LHMS.switchProperty = function (id) {
    var p = db.properties.find(function (x) { return x.id === id; });
    if (!p) return;
    session.propertyId = id;
    db.session.propertyId = id;
    LHMS.persistSession();
  };

  LHMS.STAFF_ACCOUNTS = STAFF_ACCOUNTS;
  LHMS.PERMISSIONS = PERMISSIONS;
  LHMS.defaultPermissions = defaultPermissions;

  LHMS.can = function (perm) {
    var role = session.role;
    if (role === "Manager") return true;
    var set = db.permissions && db.permissions[role];
    return !!(set && set[perm]);
  };

  /* ---------------- selectors ---------------- */
  function byId(list, id) { return list.find(function (x) { return x.id === id; }) || null; }

  LHMS.get = {
    property: function (id) { return byId(db.properties, id || session.propertyId); },
    room: function (id) { return byId(db.rooms, id); },
    roomType: function (id) { return byId(db.roomTypes, id); },
    ratePlan: function (id) { return byId(db.ratePlans, id); },
    guest: function (id) { return byId(db.guests, id); },
    staff: function (id) { return byId(db.staff, id); },
    reservation: function (id) { return byId(db.reservations, id); },
    task: function (id) { return byId(db.tasks, id); },
    review: function (id) { return byId(db.reviews, id); },
    outlet: function (id) { return byId(db.outlets, id); },
    // A selling view of an outlet: the same rows, each carrying the price the
    // engine says applies today. A menu never holds a price of its own, and an
    // item with no active price is not offered.
    menuOf: function (outletId) {
      var o = byId(db.outlets, outletId);
      if (!o) return null;
      var copy = Object.assign({}, o);
      copy.items = o.items.filter(function (i) { return LHMS.price.itemPrice(i.id) > 0; })
        .map(function (i) { return Object.assign({}, i, { price: LHMS.price.itemPrice(i.id) }); });
      return copy;
    },
    // Where an ordered item lives: the line needs both the item price and the
    // department that has to deliver it.
    menu: function (itemId) {
      var hit = null;
      db.outlets.some(function (o) {
        var item = o.items.find(function (i) { return i.id === itemId; });
        if (!item) return false;
        var offer = LHMS.price.itemPriceOf(itemId);
        // An item with no active price is not on sale anywhere, so it is not
        // offered here either — a caller cannot post a ₦0 line by accident.
        if (!offer || !offer.amount) return false;
        hit = { outlet: o, item: Object.assign({}, item, { price: offer.amount, priceCurrency: offer.currency }) };
        return true;
      });
      return hit;
    },
    settings: function (pid) { return db.settings[pid || session.propertyId]; },
    // A booking remembers the bare hall id; the catalogue row is found by it.
    hall: function (id) { return byId(db.services, id) || LHMS.price.forRef("hall", id); },
    event: function (id) { return byId(db.events, id); },
    invoice: function (id) { return byId(db.invoices, id); },
    laundryOrder: function (id) { return byId(db.laundry, id); }
  };

  /* ---------------- branding ---------------- */
  // A property's brand is what the sign-in page and the app chrome wear. The
  // fallback is the property's own name, so a hotel that has never opened the
  // module still reads as itself; the flagship keeps the group lock-up it has
  // always shown. Images are capped because they live in browser storage with
  // everything else, and an unbounded upload would evict the ledger.
  LHMS.BRAND_LIMITS = { maxImages: 6, maxLogoChars: 700000, maxImageChars: 900000, maxTotalChars: 3600000 };

  function brandFallback(pid) {
    var p = db.properties.find(function (x) { return x.id === (pid || session.propertyId); });
    var flagship = !!p && p.id === "agm";
    return {
      brandName: flagship ? "Aurelia Grand" : p ? p.name : "Aurelia Grand",
      tagline: flagship ? "Hotels & Residences" : p ? (p.tagline || "") : "",
      logo: "", images: [], palette: null, useColors: true,
      updatedAt: null, updatedBy: null
    };
  }
  LHMS.brandDefaults = function (pid) { return brandFallback(pid); };

  LHMS.get.branding = function (pid) {
    var out = brandFallback(pid);
    var s = db.settings[pid || session.propertyId];
    var b = s && s.branding;
    if (!b || typeof b !== "object") return out;
    if (typeof b.brandName === "string" && b.brandName.trim()) out.brandName = b.brandName;
    if (typeof b.tagline === "string") out.tagline = b.tagline;
    if (typeof b.logo === "string") out.logo = b.logo;
    if (Array.isArray(b.images)) {
      out.images = b.images.filter(function (i) { return i && typeof i.src === "string" && i.src; })
        .slice(0, LHMS.BRAND_LIMITS.maxImages)
        .map(function (i) { return { src: i.src, name: typeof i.name === "string" ? i.name : "" }; });
    }
    if (Array.isArray(b.palette) && b.palette.length) {
      out.palette = b.palette.filter(function (c) { return typeof c === "string"; }).slice(0, 8);
    }
    out.useColors = b.useColors !== false;
    out.updatedAt = b.updatedAt || null;
    out.updatedBy = b.updatedBy || null;
    return out;
  };

  LHMS.roomsOf = function (pid) { return db.rooms.filter(function (r) { return r.propertyId === (pid || session.propertyId); }); };
  LHMS.staffOf = function (pid) { return db.staff.filter(function (s) { return s.propertyId === (pid || session.propertyId); }); };
  LHMS.reservationsOf = function (pid) { return db.reservations.filter(function (r) { return r.propertyId === (pid || session.propertyId); }); };
  LHMS.tasksOf = function (pid) { return db.tasks.filter(function (t) { return t.propertyId === (pid || session.propertyId); }); };
  // The halls a property can sell, straight from the catalogue: a hall is a
  // service row, not a second list that can drift away from its price.
  LHMS.halls = function () {
    return db.services.filter(function (s) { return s.category === "hall" && !s.addon; });
  };
  // Decoration, sound and catering rows, offered as choices on a booking.
  LHMS.eventExtras = function () {
    return db.services.filter(function (s) { return s.category === "hall" && s.addon; });
  };
  LHMS.laundryServices = function () {
    return db.services.filter(function (s) { return s.category === "laundry"; });
  };
  LHMS.eventsOf = function (pid, date) {
    return db.events.filter(function (e) {
      if (e.propertyId !== (pid || session.propertyId)) return false;
      return !date || e.date === date;
    }).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.start < b.start ? -1 : 1); });
  };
  LHMS.laundryOf = function (pid) {
    return db.laundry.filter(function (o) { return o.propertyId === (pid || session.propertyId); })
      .slice().sort(function (a, b) { return a.createdAt < b.createdAt ? 1 : -1; });
  };
  // A hall can only be in one place at a time, so the check ignores the
  // property: it is deliberately the stricter reading of "no double-booking".
  LHMS.hallBookings = function (hallId, date, exceptId) {
    return db.events.filter(function (e) {
      return e.hallId === hallId && e.date === date && e.id !== exceptId &&
        e.status !== "Cancelled" && e.status !== "Released";
    });
  };
  LHMS.hallConflict = function (hallId, date, start, end, exceptId) {
    var clashes = LHMS.hallBookings(hallId, date, exceptId).filter(function (e) {
      return U.overlaps(start, end, e.start, e.end);
    });
    return clashes.length ? clashes[0] : null;
  };
  LHMS.cleanersOf = function (pid) {
    return LHMS.staffOf(pid).filter(function (s) {
      return s.department === "Housekeeping" || s.department === "Engineering";
    });
  };

  LHMS.folio = function (resId) {
    var ch = db.charges.filter(function (c) { return c.reservationId === resId && !c.voided; });
    var pay = db.payments.filter(function (p) { return p.reservationId === resId; });
    var total = ch.reduce(function (s, c) { return s + c.amount; }, 0);
    var paid = pay.reduce(function (s, p) { return s + p.amount; }, 0);
    // A folio is one currency by construction, so what the guest is billed and
    // what the books keep are two readings of the same lines, never a mix.
    var baseTotal = ch.reduce(function (s, c) { return s + LHMS.fx.baseOf(c); }, 0);
    var basePaid = pay.reduce(function (s, p) { return s + LHMS.fx.baseOf(p); }, 0);
    var first = ch.filter(function (c) { return c.currency; })[0] || pay.filter(function (p) { return p.currency; })[0] || {};
    return {
      charges: ch, payments: pay, total: total, paid: paid, balance: Math.round(total - paid),
      currency: first.currency || LHMS.fx.base(), fxRate: first.fxRate || null,
      baseTotal: baseTotal, basePaid: basePaid, baseBalance: Math.round(baseTotal - basePaid)
    };
  };

  // What an invoice is worth is counted from the money records, not from a
  // total someone typed: nothing is "Paid" before the payment is on file.
  LHMS.invoiceMoney = function (inv) {
    return BC.totals(inv,
      db.payments.filter(function (p) { return p.invoiceId === inv.id; }),
      db.refunds.filter(function (r) { return r.invoiceId === inv.id; }));
  };

  LHMS.invoicePayments = function (invId) {
    return db.payments.filter(function (p) { return p.invoiceId === invId; });
  };

  // Cash the property has taken, whether it landed on a folio or against a
  // document. The receipts page has to show both or the till never balances.
  LHMS.paymentsOf = function (pid) {
    pid = pid || session.propertyId;
    return db.payments.filter(function (p) {
      var res = p.reservationId ? LHMS.get.reservation(p.reservationId) : null;
      var inv = p.invoiceId ? LHMS.get.invoice(p.invoiceId) : null;
      return (res && res.propertyId === pid) || (inv && inv.propertyId === pid);
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1); });
  };

  LHMS.refundsOf = function (pid) {
    pid = pid || session.propertyId;
    return db.refunds.filter(function (r) {
      var inv = LHMS.get.invoice(r.invoiceId);
      return inv && inv.propertyId === pid;
    }).sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  };

  // The live document for a folio or a booking. A void one does not count: its
  // charges were handed back precisely so a corrected document could be raised.
  LHMS.invoiceFor = function (kind, entityId) {
    return db.invoices.filter(function (i) {
      return i.kind === kind && i.entityId === entityId && i.status !== "Void";
    })[0] || null;
  };

  // Anything owed that has not yet reached a document, from anywhere in the
  // property. This is the work list behind the "to raise" figure.
  LHMS.unbilledAcross = function (pid) {
    pid = pid || session.propertyId;
    var out = [];
    db.reservations.filter(function (r) { return r.propertyId === pid; }).forEach(function (r) {
      var open = LHMS.unbilledCharges(r.id);
      if (open.length) out.push({ kind: "folio", res: r, lines: open });
    });
    return out;
  };

  LHMS.invoicesOf = function (pid) {
    return db.invoices.filter(function (i) { return i.propertyId === (pid || session.propertyId); })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  };

  // Cost the property has recorded, newest first. Approval is a state on the
  // row, so the dashboard decides for itself what counts toward the result.
  LHMS.expensesOf = function (pid) {
    return (db.expenses || []).filter(function (e) { return e.propertyId === (pid || session.propertyId); })
      .sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : (a.id < b.id ? 1 : -1); });
  };

  LHMS.EXPENSE_CATEGORIES = [
    "Payroll", "Utilities", "Cost of sales", "Repairs & maintenance", "Housekeeping",
    "Laundry", "Marketing", "Statutory", "Technology", "Other operating"
  ];

  /* ---------------- financial statement ---------------- */
  // The dashboard reads one statement built from the live database, so a charge,
  // a payment or an approval recorded anywhere in the app moves the numbers on
  // the next render instead of needing a rebuild.
  LHMS.FINANCE_RANGES = [
    { key: "day", label: "Today", days: 1, cmp: "yesterday" },
    { key: "week", label: "7 days", days: 7, cmp: "the 7 days before" },
    { key: "month", label: "30 days", days: 30, cmp: "the 30 days before" },
    { key: "year", label: "12 months", days: 365, cmp: "the 12 months before" }
  ];

  LHMS.finance = function (days) {
    var FC = LHMS.financeCore;
    var pid = session.propertyId;
    var day = bizDay();
    var p = FC.period(day, days);
    var now = FC.statement(db, pid, p.from, p.to);
    var prev = FC.statement(db, pid, p.prevFrom, p.prevTo);
    return {
      period: p, now: now, prev: prev, range: days,
      series: FC.series(db, pid, p.from, p.to),
      delta: function (key) { return FC.delta(now[key], prev[key]); }
    };
  };

  // The rows behind a department figure. Drill-down has to reach the actual
  // transactions, not a second total someone typed into a chart.
  LHMS.financeTxns = function (department, from, to) {
    var pid = session.propertyId;
    var FC = LHMS.financeCore;
    var out = [];
    db.reservations.filter(function (r) { return r.propertyId === pid; }).forEach(function (r) {
      db.charges.forEach(function (c) {
        if (c.reservationId !== r.id || c.voided || c.department !== department) return;
        if (!FC.inRange(c.date, from, to)) return;
        out.push({
          date: c.date, description: c.description, amount: c.amount, postedBy: c.postedBy || "—",
          ref: r.reference, href: "#/folio/" + r.id, who: (LHMS.get.guest(r.guestId) || {}).name || "Guest"
        });
      });
    });
    if (department === "Events & Banqueting") {
      db.events.filter(function (e) {
        return e.propertyId === pid && !e.reservationId && e.status !== "Cancelled" &&
          e.status !== "Released" && FC.inRange(e.date, from, to);
      }).forEach(function (e) {
        (e.lines || []).forEach(function (l) {
          out.push({
            date: e.date, description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " — " + e.title,
            amount: l.amount, postedBy: "Events desk", ref: e.hallName,
            href: "#/events/" + e.id, who: e.organizer
          });
        });
      });
    }
    return out.sort(function (a, b) { return a.date < b.date ? 1 : a.date > b.date ? -1 : 0; });
  };

  /* ---------------- financial reports ---------------- */
  LHMS.REPORTS = LHMS.reportCore.catalogue();
  LHMS.canSeeReports = function () { return LHMS.can("view_reports"); };

  // The report runs against the live database over the same window the dashboard
  // uses, so the two can never be reconciled against different figures.
  LHMS.report = function (key, days) {
    if (!LHMS.canSeeReports()) return { denied: true, key: key };
    var p = LHMS.financeCore.period(bizDay(), days);
    return LHMS.reportCore.run(db, session.propertyId, key, p.from, p.to);
  };

  // A window the user typed is the same engine with different bounds. The dates
  // are checked here because a report with a backwards range totals to nothing
  // and looks like a quiet month.
  LHMS.reportBetween = function (key, from, to) {
    if (!LHMS.canSeeReports()) return { denied: true, key: key };
    var day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(String(from)) || !day.test(String(to))) return { error: "Pick both a first and a last day." };
    if (from > to) return { error: "The first day has to come before the last." };
    if (U.nights(from, to) > 730) return { error: "Keep a window to two years or less — longer reports cannot be read." };
    return LHMS.reportCore.run(db, session.propertyId, key, from, to);
  };

  /* ---------------- financial settings and approvals ---------------- */
  LHMS.actions = LHMS.actions || {};
  // §9 Financial Settings and §10 FinancialApprovals. Each of these four numbers
  // is read by an action, because a setting nothing enforces is decoration:
  //   invoicePrefix  — the number on every document raised at this property
  //   paymentDays    — how long a guest or a corporate has to pay it
  //   approvalAmount — a price move or a refund larger than this needs two hands
  //   discountPct    — a discount past this share of an invoice needs two hands
  //   rateMaxAgeDays — how long a foreign rate is trusted after it is filed
  var FINANCE_DEFAULTS = { invoicePrefix: "AGM", paymentDays: 7, approvalAmount: 500000, discountPct: 10, rateMaxAgeDays: 3 };

  LHMS.financeSettings = function (pid) {
    var saved = (db.settings[pid || session.propertyId] || {}).finance || {};
    var out = {};
    Object.keys(FINANCE_DEFAULTS).forEach(function (k) {
      var v = saved[k];
      out[k] = (v === null || v === undefined || v === "") ? FINANCE_DEFAULTS[k] : v;
    });
    return out;
  };

  // One place numbers a document, so a split invoice and a raised one cannot
  // drift into different series while the setting says one prefix.
  function nextInvoiceNumber(pid) {
    return BC.number(db.counters.invoice += 1, LHMS.financeSettings(pid).invoicePrefix);
  }

  LHMS.canApproveFinancial = function () { return LHMS.can("approve_financial_changes"); };

  // Crossing a money limit without a second signature is the General Manager's
  // own act, and nobody else's. A role that holds the signing right IS the second
  // pair of hands — if it could also walk its own ask straight through, both
  // signatures would sit in one book and the limit would weigh nothing.
  LHMS.movesMoneyAlone = function () { return session.role === "Manager"; };

  // The prefix is shown to the person typing it in exactly the shape it will be
  // saved in, so the confirmation and the document number cannot disagree.
  LHMS.sanitizePrefix = function (v) { return String(v === undefined || v === null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, ""); };

  // Pending first, then the newest decision, so the queue opens on the work.
  LHMS.approvals = function (status) {
    var list = db.approvals.filter(function (a) { return a.propertyId === session.propertyId; });
    if (status) list = list.filter(function (a) { return a.status === status; });
    return list.sort(function (a, b) {
      if (a.status === b.status) return a.requestedAt < b.requestedAt ? 1 : -1;
      return a.status === "Pending" ? -1 : 1;
    });
  };

  function queueApproval(rec) {
    var a = Object.assign({
      id: U.uid("apr"), propertyId: session.propertyId,
      requestedBy: actorName(), requestedAt: new Date().toISOString(),
      status: "Pending", decidedBy: null, decidedAt: null, decisionNote: null
    }, rec);
    // Every request says what money its figures are in. Left unstated, a dollar
    // discount would be read as naira by whoever signs it.
    if (!a.currency) a.currency = LHMS.fx.base(a.propertyId);
    db.approvals.unshift(a);
    log("asked for approval of a " + a.kind, "approval",
      a.subject + " · " + U.money(a.amount, a.currency) + " · " + a.reason + " · awaiting a second signature");
    LHMS.save();
    return a;
  }
  LHMS.queueApproval = queueApproval;

  // A gated action and an applied one are different sentences: the desk has to
  // hear whether money moved or a request went to a second signature, because a
  // toast that says "saved" over a queued change teaches the user to distrust it.
  LHMS.outcome = function (result, appliedText) {
    if (result && result.queued) {
      return {
        kind: "queued",
        text: "Held for a second signature — this " + result.queued.kind + " of " +
          U.money(result.queued.amount, result.queued.currency) + " is over the limit set in Financial Settings. Nothing has changed yet."
      };
    }
    return { kind: "applied", text: appliedText };
  };

  // What a signed-off request actually does. Nothing here is a copy of the desk
  // rules — it calls the same applier the immediate action would have called, so
  // an approved change lands with the same history entry as an ungated one.
  function applyApproval(a) {
    if (a.kind === "price") {
      var row = byId(db.prices, a.subjectId);
      if (!row) return { ok: false, error: "The price this request was made against is gone — it cannot be applied." };
      // A rate the desk moved while this waited is a different question from the
      // one the approver read, so it goes back to the front of the queue.
      if (row.amount !== a.from)
        return { ok: false, error: "That price has moved since this was asked. Raise it again against the current figure." };
      applyPricePatch(row, a.change.patch, a.change.reason || a.reason);
      return { ok: true };
    }
    if (a.kind === "fx") {
      // The same staleness test the price carries: a rate somebody filed while
      // this waited is a different question from the one the approver read.
      var cur = FXC.rateOn(db.fxRates, a.change.data.code, a.change.data.effective);
      if (a.from === null && cur) {
        return { ok: false, error: "A " + a.change.data.code + " rate was filed for that day while this waited. Raise it again against the figure on file." };
      }
      if (a.from !== null && (!cur || cur.perBase !== a.from)) {
        return { ok: false, error: "That rate has moved since this was asked. Raise it again against the current figure." };
      }
      var filed = applyFxRate(a.change.data);
      return filed.ok ? { ok: true } : filed;
    }
    var inv = byId(db.invoices, a.change.invoiceId);
    if (!inv) return { ok: false, error: "The invoice this request was made against is gone — it cannot be applied." };
    if (inv.status === "Void") return { ok: false, error: inv.number + " was voided while this waited." };
    var t = LHMS.invoiceMoney(inv);
    var amount = Math.round(Number(a.change.data.amount));
    if (a.kind === "refund") {
      if (amount > t.settled) return { ok: false, error: "Only " + U.money(t.settled, inv.currency) + " stands against " + inv.number + " now — less than this refund." };
      applyRefund(inv, a.change.data);
    } else {
      if (amount > t.total) return { ok: false, error: inv.number + " now totals " + U.money(t.total, inv.currency) + " — less than this discount." };
      applyDiscount(inv, a.change.data);
    }
    return { ok: true };
  }

  // The second signature. A request is only ever closed once, by someone other
  // than the person who raised it, and with a note that goes into the trail.
  LHMS.actions.decideApproval = function (id, approve, note) {
    var a = byId(db.approvals, id);
    if (!a) return { ok: false, error: "That request is not in the register." };
    if (a.status !== "Pending") return { ok: false, error: "This request was already " + a.status.toLowerCase() + "." };
    if (!LHMS.canApproveFinancial()) return { ok: false, error: "Your role cannot sign off a financial change." };
    if (a.requestedBy === actorName())
      return { ok: false, error: "You raised this request — a second pair of hands has to clear it." };
    if (!note) return { ok: false, error: "A decision needs a note for the audit trail." };
    if (approve) {
      var applied = applyApproval(a);
      if (!applied.ok) return applied;
    }
    a.status = approve ? "Approved" : "Rejected";
    a.decidedBy = actorName();
    a.decidedAt = new Date().toISOString();
    a.decisionNote = note;
    log((approve ? "approved a " : "rejected a ") + a.kind, "approval",
      a.subject + " · " + U.money(a.amount, a.currency) + " · " + note);
    LHMS.save();
    return { ok: true, approval: a };
  };

  // The rules themselves are the last thing to need a second signature: a
  // property can widen its own approval limit, so editing them is limited to
  // whoever already holds the right to change them.
  var FINANCE_LIMITS = {
    invoicePrefix: null, paymentDays: [0, 90], approvalAmount: [0, 100000000], discountPct: [0, 100],
    rateMaxAgeDays: [1, 30]
  };
  var FINANCE_LABELS = {
    invoicePrefix: "Invoice prefix", paymentDays: "Days to pay",
    approvalAmount: "Approval limit", discountPct: "Discount ceiling",
    rateMaxAgeDays: "Rate freshness"
  };
  LHMS.financeLabels = FINANCE_LABELS;

  LHMS.actions.setFinanceSettings = function (patch) {
    if (!LHMS.can("manage_financial_settings")) return { ok: false, error: "Your role cannot change the financial settings." };
    var before = LHMS.financeSettings();
    var out = Object.assign({}, before);
    var changed = [];
    if (patch.invoicePrefix !== undefined) {
      var prefix = LHMS.sanitizePrefix(patch.invoicePrefix);
      if (!prefix) return { ok: false, error: "An invoice prefix needs at least one letter or figure." };
      if (prefix.length > 6) return { ok: false, error: "Keep the invoice prefix to six characters or fewer." };
      if (prefix !== before.invoicePrefix) {
        out.invoicePrefix = prefix;
        changed.push("prefix " + before.invoicePrefix + " to " + prefix);
      }
    }
    var keys = Object.keys(FINANCE_LIMITS).filter(function (k) { return FINANCE_LIMITS[k]; });
    for (var i = 0; i < keys.length; i++) {
      var key = keys[i], bound = FINANCE_LIMITS[key], raw = patch[key];
      if (raw === undefined || raw === null || raw === "") continue;
      var v = Math.round(Number(raw));
      if (!isFinite(v) || v < bound[0] || v > bound[1])
        return { ok: false, error: FINANCE_LABELS[key] + " has to be between " + bound[0] + " and " + bound[1] + "." };
      if (v === before[key]) continue;
      out[key] = v;
      changed.push(FINANCE_LABELS[key].toLowerCase() + " " + before[key] + " to " + v);
    }
    if (!changed.length) return { ok: false, error: "Nothing in these settings has changed." };
    var settings = db.settings[session.propertyId];
    if (!settings.finance) settings.finance = {};
    Object.assign(settings.finance, out);
    log("changed the financial settings", "financial settings",
      changed.join(" · ") + " · applies to the next document or decision, not to one already raised");
    LHMS.save();
    return { ok: true, settings: out, changed: changed };
  };

  /* ---------------- exchange rates ---------------- */
  // A rate is keyed by currency and the day it takes effect, so a second figure
  // for the same day is a correction rather than two truths for one date. Older
  // rows stay on file: the trail has to show what a figure was converted at on
  // the day it moved, not only what it converts at now.
  function fxRateDraft(data) {
    data = data || {};
    var base = LHMS.fx.base();
    var code = String(data.code || "").trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) return { error: "A currency is a three-letter code, like USD." };
    if (code === base) return { error: base + " is what these books are kept in — it always stands at 1." };
    if (FXC.codes.indexOf(code) === -1) {
      return { error: "This property holds money in " + FXC.codes.join(", ") + ". " + code + " is not among them." };
    }
    var perBase = Number(data.perBase);
    if (!isFinite(perBase) || perBase <= 0) return { error: "Say what one " + code + " buys in " + base + ", as a number above zero." };
    if (perBase > 100000000) return { error: "That figure is too wide to be an exchange rate." };
    var effective = data.effective || bizDay();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) return { error: "Use the 2026-10-30 shape for the date a rate takes effect." };
    if (effective > bizDay()) {
      return { error: "A rate cannot take effect in the future — the books would be kept on a figure nobody has agreed." };
    }
    var sealed = closedDay(effective);
    if (sealed) return { error: sealed };
    var note = String(data.note || "").trim();
    if (!note) return { error: "Say where the rate came from — a fixing, a bank screen, a treasury memo. The trail reads it." };
    return { code: code, base: base, perBase: Math.round(perBase * 100) / 100, effective: effective, note: note };
  }

  function applyFxRate(data) {
    var draft = fxRateDraft(data);
    if (draft.error) return { ok: false, error: draft.error };
    var row = db.fxRates.filter(function (r) { return r.code === draft.code && r.effective === draft.effective; })[0];
    var prev = FXC.rateOn(db.fxRates, draft.code, bizDay());
    var rec = {
      id: row ? row.id : U.uid("fx"), code: draft.code, perBase: draft.perBase, effective: draft.effective,
      setBy: actorName(), setAt: new Date().toISOString(), note: draft.note
    };
    if (row) db.fxRates.splice(db.fxRates.indexOf(row), 1, rec); else db.fxRates.push(rec);
    log("set the " + draft.code + " rate", "currency",
      "1 " + draft.code + " = " + U.money(draft.perBase, draft.base) + " from " + U.pretty(draft.effective, "medium") +
      (prev && prev.perBase !== draft.perBase ? " · was " + U.money(prev.perBase, draft.base) : " · no earlier rate on file") +
      " · " + draft.note);
    LHMS.save();
    return { ok: true, rate: rec, previous: prev };
  }

  // A rate reprices every foreign figure the property holds, so the hand that
  // files one is the hand that is allowed to sign a price move. Anyone else's
  // figure waits in the register for a second signature, exactly as a wide price
  // change does, and lands through the same applier when it is cleared.
  LHMS.actions.setFxRate = function (data) {
    if (!LHMS.can("manage_financial_settings")) {
      return { ok: false, error: "Your role cannot change the rates these books are kept at." };
    }
    var draft = fxRateDraft(data);
    if (draft.error) return { ok: false, error: draft.error };
    var prev = FXC.rateOn(db.fxRates, draft.code, bizDay());
    if (!LHMS.movesMoneyAlone()) {
      return {
        ok: true, queued: queueApproval({
          kind: "fx", subject: draft.code + " rate · " + draft.base + " per unit", subjectId: draft.code,
          change: {
            data: { code: draft.code, perBase: draft.perBase, effective: draft.effective, note: draft.note }
          },
          amount: prev ? Math.abs(draft.perBase - prev.perBase) : draft.perBase,
          from: prev ? prev.perBase : null, to: draft.perBase, reason: draft.note,
          // The figures are rates, quoted in the money the books keep.
          currency: draft.base
        })
      };
    }
    return applyFxRate(data);
  };

  // Charges already carried onto a document are not billable twice.
  LHMS.unbilledCharges = function (resId) {
    return db.charges.filter(function (c) { return c.reservationId === resId && !c.voided && !c.invoiceId; });
  };

  LHMS.activeResForRoom = function (roomId, date) {
    date = date || bizDay();
    return db.reservations.find(function (r) {
      return r.roomId === roomId && r.status === "In-house" && r.checkIn <= date && r.checkOut > date;
    }) || null;
  };

  LHMS.arrivalForRoom = function (roomId, date) {
    date = date || bizDay();
    return db.reservations.find(function (r) {
      return r.roomId === roomId && r.status === "Confirmed" && r.checkIn === date;
    }) || null;
  };

  LHMS.occupies = function (res, date) {
    return res.checkIn <= date && res.checkOut > date && (res.status === "In-house" || res.status === "Checked out");
  };

  LHMS.roomState = function (room, date) {
    date = date || bizDay();
    if (room.hk === "Out of order") return { key: "ooo", label: "Out of order", detail: room.oooReason || "Maintenance" };
    if (room.hk === "Out of service") return { key: "oos", label: "Out of service", detail: room.oooReason || "Unavailable" };
    var active = LHMS.activeResForRoom(room.id, date);
    if (active) {
      var guest = LHMS.get.guest(active.guestId);
      var departing = active.checkOut === date;
      return {
        key: departing ? "departing" : "occupied",
        label: departing ? "Departing" : "Occupied",
        res: active, guest: guest,
        detail: departing ? "Due out today" : "In house until " + U.pretty(active.checkOut, "short")
      };
    }
    var arriving = LHMS.arrivalForRoom(room.id, date);
    if (arriving) {
      return { key: "arriving", label: "Arriving", res: arriving, guest: LHMS.get.guest(arriving.guestId), detail: "Arrival today" };
    }
    if (room.hk === "Dirty") return { key: "dirty", label: "Dirty", detail: "Awaiting housekeeping" };
    if (room.hk === "Inspected") return { key: "inspected", label: "Inspected", detail: "Inspected and released" };
    return { key: "available", label: "Available", detail: "Ready to sell" };
  };

  /* ---------------- pricing engine ---------------- */
  // One place decides what anything costs. Pages hand over a service and a date
  // and get an amount back; nothing multiplies rates on its own, and a posted
  // charge keeps its own copy of the price that produced it, so re-pricing a
  // room type can never rewrite a stay that is already confirmed.
  var PC = LHMS.priceCore;
  var BC = LHMS.billingCore;

  function svcOf(category, refId) {
    return db.services.find(function (s) { return s.category === category && s.refId === refId; }) || null;
  }

  // The fields a posted charge keeps as proof of how it was priced.
  var PRICE_SNAPSHOT = ["unitPrice", "basePrice", "extras", "currency", "serviceId", "priceId", "listId", "listName", "taxRuleId"];

  var PRICE = (LHMS.price = {
    round: PC.round,
    lists: function () { return db.priceLists; },
    list: function (id) { return byId(db.priceLists, id); },
    rules: function () {
      return db.taxRules.slice().sort(function (a, b) { return a.order - b.order; });
    },
    // Which rules a category is billed under, in the order they compound.
    applicableTaxes: function (category) {
      return PRICE.rules().filter(function (r) {
        return r.pct > 0 && (r.appliesTo || []).indexOf(category) !== -1;
      });
    },
    categories: function () { return SERVICE_CATEGORIES; },
    surchargeFields: function (category) { return SURCHARGE_FIELDS[category] || []; },
    services: function (category) {
      return db.services.filter(function (s) { return !category || s.category === category; });
    },
    service: function (id) { return byId(db.services, id); },
    forRef: svcOf,
    prices: function (serviceId) {
      return db.prices.filter(function (p) { return !serviceId || p.serviceId === serviceId; });
    },
    priceRow: function (priceId) { return byId(db.prices, priceId); },
    // The default list a product is sold from — standard beats seasonal when
    // no date or list is named.
    baseRow: function (serviceId) {
      var rows = db.prices.filter(function (p) { return p.serviceId === serviceId; });
      var standard = rows.filter(function (p) {
        var l = PRICE.list(p.listId);
        return l && l.kind === "standard";
      });
      return standard[0] || rows[0] || null;
    },
    applicable: function (serviceId, opts) {
      return PC.resolve(db.prices, db.priceLists, serviceId, dated(opts));
    },
    amount: function (serviceId, opts) {
      var o = dated(opts);
      var hit = PC.resolve(db.prices, db.priceLists, serviceId, o);
      if (!hit) return null;
      var svc = byId(db.services, serviceId);
      // Switching the service off takes it out of sale even while its price row
      // stays active, because the switch is the operational master control.
      if (!svc || !svc.active) return null;
      // A price in a currency the books cannot value today is not a price that
      // can be sold: the row stays on the card, the quote refuses.
      if (LHMS.fx.gate(hit.price.currency, { date: o.date })) return null;
      var a = PC.amount(hit.price, svc, o);
      return {
        unit: a.unit, lines: a.lines, added: a.added, price: hit.price, list: hit.list,
        service: svc, currency: hit.price.currency, date: o.date
      };
    },
    // The single figure a page shows when it advertises a product.
    nightRate: function (typeId, opts) {
      var svc = svcOf("room", typeId);
      if (!svc) return 0;
      var a = PRICE.amount(svc.id, opts);
      return a ? a.unit : 0;
    },
    // The same rate with the money it is quoted in. A page that prints a figure
    // needs both, or a dollar room is shown wearing the books' own sign.
    nightRateOf: function (typeId, opts) {
      var svc = svcOf("room", typeId);
      if (!svc) return null;
      var a = PRICE.amount(svc.id, opts);
      return a ? { amount: a.unit, currency: a.currency } : null;
    },
    itemPrice: function (itemId, opts) {
      var o = PRICE.itemPriceOf(itemId, opts);
      return o ? o.amount : 0;
    },
    itemPriceOf: function (itemId, opts) {
      var svc = svcOf("restaurant", itemId);
      if (!svc) return null;
      var a = PRICE.amount(svc.id, opts);
      return a ? { amount: a.unit, currency: a.currency } : null;
    },
    // Types with no active price on any night of the stay are not sellable, so
    // they must not appear in a booking form at all.
    pricedRoomTypes: function (ci, co, listId) {
      return db.roomTypes.filter(function (t) {
        var svc = svcOf("room", t.id);
        if (!svc || !svc.active) return false;
        var n = Math.max(1, U.nights(ci, co));
        for (var i = 0; i < n; i++) {
          if (!PRICE.applicable(svc.id, { date: U.addDays(ci, i), listId: listId })) return false;
        }
        return true;
      });
    },
    stay: function (typeId, planId, ci, co, adults) {
      var svc = svcOf("room", typeId);
      var type = byId(db.roomTypes, typeId);
      var plan = byId(db.ratePlans, planId) || db.ratePlans[0];
      if (!svc || !type) return null;
      var n = Math.max(1, U.nights(ci, co));
      var nightly = [];
      var roomTotal = 0;
      var extras = 0;
      for (var i = 0; i < n; i++) {
        var day = U.addDays(ci, i);
        var a = PRICE.amount(svc.id, { date: day, modifier: plan.modifier, adults: adults });
        if (!a) return null;
        var base = PC.round(a.price.amount * (plan.modifier || 1));
        // Everything the date or the party adds to the headline rate, kept itemised.
        var uplift = a.unit - base;
        extras += uplift;
        nightly.push({
          date: day, rate: a.unit, base: base, uplift: uplift, added: a.added, currency: a.currency,
          serviceId: svc.id, priceId: a.price.id, listId: a.list.id, list: a.list.name
        });
        roomTotal += a.unit;
      }
      var tax = PC.taxes(db.taxRules, roomTotal, "room");
      var byKind = {};
      tax.lines.forEach(function (l) { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
      return {
        available: true, type: type, plan: plan, svc: svc, nights: n, nightly: nightly,
        roomTotal: roomTotal, extras: extras, taxLines: tax.lines, taxes: tax.total,
        service: byKind.service || 0, vat: byKind.vat || 0, total: tax.grand,
        deposit: PC.round(tax.grand * (plan.depositPct || 0) / 100)
      };
    },
    taxes: function (subtotal, category) { return PC.taxes(db.taxRules, subtotal, category); },
    // The terms of a cancellation travel with the booking, taken from the price
    // row it was sold on: a fee is owed only inside the notice window.
    cancellationFee: function (evt) {
      if (!evt || evt.status === "Cancelled") return 0;
      var pct = Number(evt.cancelPct) || 0;
      var notice = Number(evt.cancelHours) || 0;
      if (!pct || !notice) return 0;
      var mins = U.timeMins(evt.start);
      if (mins === null) return 0;
      var startAt = new Date(U.parse(evt.date).getTime() - 43200000 + mins * 60000);
      if ((startAt - Date.now()) / 3600000 > notice) return 0;
      return PC.round((Number(evt.total) || 0) * pct / 100);
    },
    // A hall, quoted for a window of time. The same row of maths a booking
    // uses, so the figure on the screen and the figure on the invoice cannot
    // disagree. Add-ons are ordinary hall services, priced per setup or guest.
    hallQuote: function (serviceId, opts) {
      opts = opts || {};
      var svc = byId(db.services, serviceId);
      if (!svc || svc.category !== "hall" || svc.addon || !svc.active) return null;
      var date = opts.date || bizDay();
      var hours = U.hoursBetween(opts.start, opts.end);
      if (!hours) return null;
      var hit = PC.resolve(db.prices, db.priceLists, serviceId, { date: date, listId: opts.listId });
      if (!hit) return null;
      // As with a room night: a hall priced in a currency the books cannot value
      // today is not on sale today.
      if (LHMS.fx.gate(hit.price.currency, { date: date })) return null;
      var q = PC.hallAmount(hit.price, svc, { date: date, package: opts.package, hours: hours });
      var lines = [{
        kind: q.package ? "package" : "hourly", serviceId: svc.id, name: svc.name,
        unit: q.package ? q.packageName : "hour" + (q.qty > 1 ? "s" : ""), qty: q.qty,
        unitPrice: q.unit, basePrice: q.basePrice, amount: q.lines, currency: hit.price.currency,
        priceId: hit.price.id, listId: hit.list.id, listName: hit.list.name, added: q.added
      }];
      var extras = [];
      var leftOut = [];
      (opts.addons || []).forEach(function (a) {
        var pick = svcOf("hall", a.id);
        var qty = Math.max(1, Number(a.qty) || 0);
        if (!pick || !pick.addon || !pick.active || !qty) return;
        var e = PC.resolve(db.prices, db.priceLists, pick.id, { date: date });
        if (!e) return;
        // One booking is one money. An add-on priced in a currency the hall line
        // is not in cannot join its total, and one the books cannot value today
        // cannot be sold at all — either way the desk is told what was left out
        // rather than quietly billed for less than it asked for.
        if (LHMS.fx.gate(e.price.currency, { date: date }) || e.price.currency !== hit.price.currency) {
          leftOut.push({ name: pick.name, currency: e.price.currency });
          return;
        }
        var ea = PC.amount(e.price, pick, { date: date, qty: qty });
        extras.push({
          kind: "addon", serviceId: pick.id, name: pick.name, unit: pick.unit, qty: qty,
          unitPrice: ea.unit, basePrice: e.price.amount, amount: ea.lines, currency: e.price.currency,
          priceId: e.price.id, listId: e.list.id, listName: e.list.name, added: ea.added
        });
      });
      lines = lines.concat(extras);
      // Each line keeps the base figure it was worth on the quote date, frozen
      // here rather than re-converted later: a booking that never reaches a folio
      // still has to earn in the right money.
      for (var li = 0; li < lines.length; li++) {
        var ls = currencyStamp(lines[li].amount, lines[li].currency, { date: date });
        if (ls.error) return null;
        Object.assign(lines[li], ls.fields);
      }
      var subtotal = lines.reduce(function (s, l) { return s + l.amount; }, 0);
      var tax = PC.taxes(db.taxRules, subtotal, "hall");
      var depositPct = (hit.price.surcharges || {}).depositPct || 0;
      var total = currencyStamp(tax.grand, hit.price.currency, { date: date });
      if (total.error) return null;
      return Object.assign({
        available: true, service: svc, hall: svc, price: hit.price, list: hit.list,
        date: date, start: opts.start, end: opts.end, hours: hours, package: q.package || null,
        packageName: q.packageName || "Hourly", lines: lines, extras: extras, subtotal: subtotal,
        taxLines: tax.lines, tax: tax.total, total: tax.grand, currency: hit.price.currency,
        depositPct: depositPct, deposit: PC.round(tax.grand * depositPct / 100),
        skipped: leftOut
      }, total.fields);
    },
    // The three ways a hall can be sold for this window, priced side by side so
    // the desk can see whether four hours or a half day is the better deal.
    hallOptions: function (serviceId, opts) {
      var out = [];
      [null, "half", "full"].forEach(function (pkg) {
        var q = PRICE.hallQuote(serviceId, Object.assign({}, opts, { package: pkg }));
        // A list with no package amounts still quotes the hourly line, which
        // would repeat the same option three times.
        if (q && (!pkg || q.package === pkg)) out.push({ package: pkg, label: q.packageName, quote: q });
      });
      if (!out.length) return [];
      var cheapest = out.reduce(function (a, b) { return b.quote.total < a.quote.total ? b : a }, out[0]);
      out.forEach(function (o) { o.cheapest = o.package === cheapest.package; });
      return out;
    },
    // A laundry order: quantities in, priced lines out, plus the collection time
    // the slowest item allows.
    laundryQuote: function (lines, opts) {
      opts = opts || {};
      var priced = [];
      var mins = 0;
      (lines || []).forEach(function (l) {
        var svc = svcOf("laundry", l.id);
        var qty = Math.max(1, Number(l.qty) || 0);
        if (!svc || !qty) return;
        var a = PRICE.amount(svc.id, { qty: qty, express: !!opts.express });
        if (!a) return;
        priced.push({
          kind: "laundry", serviceId: svc.id, name: svc.name, unit: svc.unit, qty: qty,
          unitPrice: a.unit, basePrice: a.price.amount, amount: a.lines, added: a.added,
          currency: a.currency, priceId: a.price.id, listId: a.list.id, listName: a.list.name
        });
        mins = Math.max(mins, svc.turnaroundMins || 0);
      });
      if (!priced.length) return null;
      // One order is one money, so the first priced item fixes it and anything
      // billed in another is left out and named, not summed into the total.
      var code = priced[0].currency || LHMS.fx.base();
      var same = [], leftOut = [];
      priced.forEach(function (l) {
        if ((l.currency || LHMS.fx.base()) === code) same.push(l);
        else leftOut.push({ name: l.name, currency: l.currency || code });
      });
      priced = same;
      var subtotal = priced.reduce(function (s, l) { return s + l.amount; }, 0);
      var tax = PC.taxes(db.taxRules, subtotal, "laundry");
      return {
        lines: priced, subtotal: subtotal, taxLines: tax.lines, tax: tax.total, total: tax.grand,
        currency: code, express: !!opts.express, skipped: leftOut,
        etaMins: Math.round(mins * (opts.express ? 0.5 : 1)) || 240
      };
    },
    history: function (serviceId) {
      return db.priceHistory.filter(function (h) { return !serviceId || h.serviceId === serviceId; })
        .slice().sort(function (a, b) { return a.at < b.at ? 1 : -1; });
    },
    // How a charge was priced, read back from the snapshot on the line itself.
    snapshotOf: function (charge) {
      if (!charge.priceId) return null;
      var row = byId(db.prices, charge.priceId);
      return row ? { price: row, list: PRICE.list(row.listId), service: PRICE.service(row.serviceId) } : null;
    }
  });

  /* ---------------- currency ---------------- */
  // The rules of a rate live in the data layer, where the seed and the tests read
  // the same maths. This is the part that knows which property is asking, what it
  // keeps its books in, how long it stands behind a figure and which rates are
  // actually on file. One gate sits between a currency and the ledger: with no
  // usable rate the money does not move, and the refusal says what to do about it.
  var FXC = LHMS.fxCore;

  function fxRead(opts) {
    var o = opts || {};
    return {
      base: (db.settings[o.propertyId || session.propertyId] || {}).currency || "NGN",
      maxAgeDays: LHMS.financeSettings(o.propertyId).rateMaxAgeDays,
      date: o.date || bizDay()
    };
  }

  LHMS.fx = {
    currencies: FXC.currencies,
    codes: FXC.codes,
    nameOf: FXC.nameOf,
    symbolOf: FXC.symbolOf,
    base: function (pid) { return (db.settings[pid || session.propertyId] || {}).currency || "NGN"; },
    maxAge: function (pid) { return LHMS.financeSettings(pid).rateMaxAgeDays; },
    rates: function () {
      return db.fxRates.slice().sort(function (a, b) { return a.effective < b.effective ? 1 : -1; });
    },
    state: function (code, opts) { return FXC.state(db.fxRates, code, fxRead(opts)); },
    toBase: function (amount, code, opts) { return FXC.toBase(db.fxRates, amount, code, fxRead(opts)); },
    // What a record contributes to a total: the conversion it carried on the day,
    // or its own figure when it was already written in the base currency.
    baseOf: FXC.base,
    // Null when the currency can be traded, the state — with its sentence — when
    // it cannot. Every money action asks this before it writes.
    gate: function (code, opts) {
      var st = LHMS.fx.state(code, opts);
      return st.usable ? null : st;
    },
    // The currencies the catalogue sells in, and the subset of them the books
    // cannot currently value. This is what the night audit checks.
    inCatalogue: function () {
      var base = LHMS.fx.base(), codes = {};
      db.prices.forEach(function (p) { if (p.currency && p.currency !== base) codes[p.currency] = true; });
      return Object.keys(codes).sort();
    },
    unusable: function (opts) {
      return LHMS.fx.inCatalogue().map(function (c) { return LHMS.fx.state(c, opts); })
        .filter(function (st) { return !st.usable; });
    },
    // The two figures a page shows side by side: what the guest holds and what
    // the books keep.
    pair: function (amount, code, opts) {
      var st = LHMS.fx.state(code, opts);
      if (st.state === "base") return U.money(amount, st.base);
      if (!st.usable) return U.money(amount, st.code) + " · no usable " + st.code + " rate";
      return U.money(amount, st.code) + " · " + U.money(LHMS.fx.toBase(amount, st.code, opts).base, st.base);
    }
  };

  // Money that is not in the base currency carries its own conversion, frozen on
  // the day it moved: tomorrow's rate cannot rewrite yesterday's ledger. A base
  // figure needs no extra fields, so it stays exactly as it has always been.
  function currencyStamp(amount, code, opts) {
    var st = LHMS.fx.state(code, opts);
    if (!st.usable) return { error: st.error };
    var n = Math.round(Number(amount) || 0);
    if (st.state === "base") return { state: st, base: n, fields: {} };
    var conv = FXC.toBase(db.fxRates, n, st.code, fxRead(opts));
    return { state: st, base: conv.base, fields: { currency: st.code, fxRate: conv.rate, baseAmount: conv.base } };
  }

  // Money belonging to a document is worth what that document said. A payment
  // against a dollar invoice converts at the invoice's own rate, not at whatever
  // the treasury filed this morning.
  function pinnedStamp(amount, code, rate) {
    if (!rate || rate === 1) return {};
    return {
      currency: code, fxRate: rate,
      baseAmount: FXC.round(Math.round(Number(amount) || 0) * rate)
    };
  }

  // Two currencies on one total do not make a stronger figure, they make a
  // meaningless one. A document is billed in one currency or not at all.
  function oneCurrency(lines, opts) {
    var base = LHMS.fx.base((opts || {}).propertyId), codes = {};
    (lines || []).forEach(function (l) { codes[l.currency || base] = true; });
    var keys = Object.keys(codes);
    if (keys.length > 1) {
      return { error: "These lines mix " + keys.join(" and ") + " — one document is billed in one currency. " +
        "Re-price the odd line, or split the document." };
    }
    return { code: keys[0] || base };
  }

  // A folio takes its currency from the first line posted to it, because a
  // balance has to be a single number somebody can actually settle. Every later
  // line has to agree, or the folio is two bills wearing one heading.
  function folioCurrency(resId, code, propertyId) {
    var base = LHMS.fx.base(propertyId), other = null;
    function look(rows) {
      rows.forEach(function (r) {
        if (other || r.reservationId !== resId) return;
        var c = r.currency || base;
        if (c !== code) other = c;
      });
    }
    look(db.charges);
    if (!other) look(db.payments);
    if (other) {
      return { error: "This folio is billed in " + other + ", not " + code + " — a balance has to be one " +
        "currency. Price the line in " + other + " or settle the folio before opening another." };
    }
    return { code: code };
  }

  // The rate a folio is kept at. The first foreign line fixes it and everything
  // after it converts at the same figure: a stay agreed in dollars is not
  // re-valued by whatever the treasury files the next morning.
  function folioRate(resId) {
    var hit = null;
    function look(rows) {
      rows.forEach(function (r) {
        if (hit || r.reservationId !== resId || !r.fxRate) return;
        hit = r.fxRate;
      });
    }
    look(db.charges);
    if (!hit) look(db.payments);
    return hit;
  }

  // Money onto a folio: one currency, one rate, and the base figure the books
  // keep beside the number the guest holds.
  function folioStamp(resId, amount, code, opts) {
    var o = opts || {};
    var clash = folioCurrency(resId, code, o.propertyId);
    if (clash.error) return { error: clash.error };
    var n = Math.round(Number(amount) || 0);
    var pinned = folioRate(resId);
    if (pinned) {
      var fields = pinnedStamp(n, code, pinned);
      return { fields: fields, base: fields.baseAmount };
    }
    var st = currencyStamp(n, code, o);
    if (st.error) return { error: st.error };
    return { fields: st.fields, base: st.base };
  }

  // Money a guest hands in belongs to a folio, so it is taken in the folio's own
  // currency and converted at the rate that folio is kept at.
  function folioCode(resId) {
    var line = db.charges.filter(function (c) { return c.reservationId === resId && c.currency; })[0];
    return line ? line.currency : LHMS.fx.base();
  }
  function folioPayStamp(res, amount, code, date) {
    return folioStamp(res.id, amount, code || folioCode(res.id),
      { propertyId: res.propertyId, date: date || bizDay() }).fields || {};
  }

  /* ---------------- metrics ---------------- */
  LHMS.calc = {};

  LHMS.calc.sellable = function (pid) {
    return LHMS.roomsOf(pid).filter(function (r) { return r.hk !== "Out of order" && r.hk !== "Out of service"; }).length;
  };

  LHMS.calc.arrivals = function (pid, date) {
    date = date || bizDay();
    return db.reservations.filter(function (r) { return r.propertyId === pid && r.status === "Confirmed" && r.checkIn === date; });
  };
  LHMS.calc.departures = function (pid, date) {
    date = date || bizDay();
    return db.reservations.filter(function (r) { return r.propertyId === pid && r.status === "In-house" && r.checkOut === date; });
  };
  LHMS.calc.inHouse = function (pid, date) {
    date = date || bizDay();
    return db.reservations.filter(function (r) { return r.propertyId === pid && r.status === "In-house" && r.checkIn <= date && r.checkOut > date; });
  };

  LHMS.calc.metrics = function (pid, date) {
    pid = pid || session.propertyId;
    date = date || bizDay();
    var sellable = LHMS.calc.sellable(pid);
    var inHouse = LHMS.calc.inHouse(pid, date);
    var staying = inHouse.filter(function (r) { return r.checkOut > date; });
    var arrivals = LHMS.calc.arrivals(pid, date);
    var departures = LHMS.calc.departures(pid, date);
    var occ = sellable ? (staying.length / sellable) * 100 : 0;
    var roomRevenue = staying.reduce(function (s, r) {
      var n = Math.max(1, U.nights(r.checkIn, r.checkOut));
      // ADR is a yield figure, and a yield only means something when every stay
      // is counted in the money the property keeps.
      return s + (r.baseRoomTotal || r.roomTotal || 0) / n;
    }, 0);
    var adr = staying.length ? roomRevenue / staying.length : 0;
    var balanceDue = inHouse.reduce(function (s, r) { return s + Math.max(0, LHMS.folio(r.id).baseBalance); }, 0);
    var dirty = LHMS.roomsOf(pid).filter(function (r) { return r.hk === "Dirty"; }).length;
    var ooo = LHMS.roomsOf(pid).filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; }).length;
    var openTasks = LHMS.tasksOf(pid).filter(function (t) { return t.status !== "Done"; });
    return {
      date: date, sellable: sellable, occupied: staying.length, inHouse: inHouse.length,
      arrivals: arrivals.length, departures: departures.length, occupancy: Math.round(occ * 10) / 10,
      adr: Math.round(adr), revpar: Math.round(occ / 100 * adr), roomRevenue: Math.round(roomRevenue),
      balanceDue: Math.round(balanceDue), dirty: dirty, ooo: ooo, openTasks: openTasks.length,
      vipArrivals: arrivals.filter(function (r) { return r.vip || (LHMS.get.guest(r.guestId) || {}).tier === "Platinum"; }).length,
      availableTonight: Math.max(0, sellable - staying.length)
    };
  };

  LHMS.calc.guestStats = function (guestId) {
    var stays = db.reservations.filter(function (r) {
      return r.guestId === guestId && (r.status === "Checked out" || r.status === "In-house");
    });
    var nights = stays.reduce(function (s, r) { return s + Math.max(1, U.nights(r.checkIn, r.checkOut)); }, 0);
    // Lifetime spend crosses folios that may be billed in different currencies,
    // so it is counted in the money the books keep.
    var spend = stays.reduce(function (s, r) { return s + (LHMS.folio(r.id).baseTotal || 0); }, 0);
    var last = stays.slice().sort(function (a, b) { return a.checkIn < b.checkIn ? 1 : -1; })[0];
    return { stays: stays.length, nights: nights, spend: spend, last: last || null, staysList: stays };
  };

  LHMS.calc.quote = function (typeId, planId, ci, co, adults, children) {
    var q = LHMS.price.stay(typeId, planId, ci, co, adults || 1);
    if (q) {
      q.adults = adults || 1;
      q.children = children || 0;
      return q;
    }
    // Only reachable when every price row for the type is switched off; the
    // booking forms filter these types out, so nothing can be sold unpriced.
    var type = LHMS.get.roomType(typeId) || db.roomTypes[0];
    return {
      available: false, type: type, plan: LHMS.get.ratePlan(planId) || db.ratePlans[0],
      nights: Math.max(1, U.nights(ci, co)), nightly: [], roomTotal: 0, extras: 0,
      taxLines: [], taxes: 0, service: 0, vat: 0, total: 0, deposit: 0,
      adults: adults || 1, children: children || 0
    };
  };

  LHMS.calc.availability = function (typeId, ci, co, pid) {
    pid = pid || session.propertyId;
    var type = LHMS.get.roomType(typeId);
    if (type && type.stopSell) return { total: 0, free: 0, rooms: [] };
    var rooms = LHMS.roomsOf(pid).filter(function (r) {
      return r.typeId === typeId && r.hk !== "Out of order" && r.hk !== "Out of service";
    });
    var free = rooms.filter(function (room) {
      return !db.reservations.some(function (r) {
        return r.roomId === room.id && (r.status === "In-house" || r.status === "Confirmed") &&
          r.checkIn < co && r.checkOut > ci;
      });
    });
    return { total: rooms.length, free: free.length, rooms: free };
  };

  LHMS.calc.series = function (pid, days) {
    var arr = (db.history[pid] || []).slice(-days);
    // replace the final point with live numbers for coherence
    var m = LHMS.calc.metrics(pid);
    if (arr.length) {
      arr[arr.length - 1] = {
        date: m.date, occupancy: m.occupancy, adr: m.adr, revpar: m.revpar,
        revenue: m.roomRevenue, arrivals: m.arrivals, departures: m.departures, roomsSold: m.occupied
      };
    }
    return arr;
  };

  LHMS.calc.channelMix = function (pid) {
    var res = db.reservations.filter(function (r) {
      return r.propertyId === pid && r.status !== "Cancelled" && r.status !== "Waitlist";
    });
    var total = res.length || 1;
    var map = {};
    res.forEach(function (r) { map[r.channel] = (map[r.channel] || 0) + 1; });
    return Object.keys(map).map(function (k) { return { name: k, count: map[k], pct: Math.round(map[k] / total * 100) }; })
      .sort(function (a, b) { return b.count - a.count; });
  };

  LHMS.calc.departmentRevenue = function (pid) {
    var resIds = db.reservations.filter(function (r) { return r.propertyId === pid; }).map(function (r) { return r.id; });
    var map = {};
    db.charges.forEach(function (c) {
      if (resIds.indexOf(c.reservationId) === -1 || c.voided) return;
      map[c.department] = (map[c.department] || 0) + LHMS.fx.baseOf(c);
    });
    return Object.keys(map).map(function (k) { return { name: k, amount: map[k] }; }).sort(function (a, b) { return b.amount - a.amount; });
  };

  LHMS.calc.sla = function (task) {
    if (task.status === "Done") return { cls: "ok", label: "Resolved" };
    var ms = new Date(task.dueAt).getTime() - Date.now();
    var mins = Math.round(ms / 60000);
    if (mins < 0) return { cls: "late", label: Math.abs(mins) + "m overdue", mins: mins };
    if (mins <= 20) return { cls: "soon", label: mins + "m left", mins: mins };
    return { cls: "ok", label: mins + "m left", mins: mins };
  };

  LHMS.calc.unread = function (pid) {
    return db.notifications.filter(function (n) { return !n.read && (!pid || n.propertyId === pid); }).length;
  };

  LHMS.calc.taskCounts = function (pid) {
    var tasks = LHMS.tasksOf(pid);
    return {
      open: tasks.filter(function (t) { return t.status === "Open"; }).length,
      progress: tasks.filter(function (t) { return t.status === "In progress"; }).length,
      done: tasks.filter(function (t) { return t.status === "Done"; }).length,
      late: tasks.filter(function (t) { return t.status !== "Done" && new Date(t.dueAt).getTime() < Date.now(); }).length
    };
  };

  /* ---------------- waitlist (PRD 6.1) ---------------- */
  // A waitlisted stay is a booking with no key: the house holds the promise, not
  // a room. When a cancellation frees a room of its type the oldest row is
  // offered that room on a 24-hour hold. The offer is its own record, so an
  // offer the guest never takes up can expire without touching the stay or its
  // money. Accepting confirms the stay and bills the nights at that moment — a
  // waitlist that never becomes a booking leaves no charge behind.
  var WAITLIST_OFFER_HOURS = 24;

  function offerState(offer) {
    if (offer.status !== "Offered") return offer.status;
    return new Date(offer.expiresAt).getTime() > Date.now() ? "Offered" : "Expired";
  }

  LHMS.waitlist = {
    offerHours: WAITLIST_OFFER_HOURS,
    state: offerState,
    all: function (pid) {
      return db.waitlistOffers.filter(function (o) { return !pid || o.propertyId === pid; })
        .slice().sort(function (a, b) { return String(a.offeredAt) < String(b.offeredAt) ? 1 : -1; });
    },
    active: function (pid) {
      return LHMS.waitlist.all(pid).filter(function (o) { return offerState(o) === "Offered"; });
    },
    offerFor: function (reservationId) {
      return db.waitlistOffers.filter(function (o) {
        return o.reservationId === reservationId && offerState(o) === "Offered";
      })[0] || null;
    },
    queue: function (pid) {
      return db.reservations.filter(function (r) {
        return r.propertyId === (pid || session.propertyId) && r.status === "Waitlist";
      }).sort(function (a, b) {
        var byAge = String(a.createdAt || "") < String(b.createdAt || "") ? -1 : 1;
        return byAge || (a.checkIn < b.checkIn ? -1 : 1);
      });
    },
    position: function (res) {
      var queue = LHMS.waitlist.queue(res.propertyId);
      for (var i = 0; i < queue.length; i++) if (queue[i].id === res.id) return i + 1;
      return 0;
    },
    // The pass the cancellation door runs. It expires stale holds first, then
    // walks the queue oldest-first; each stay with a room free for its dates is
    // offered the first one the same availability rule the desk's counter uses.
    release: function (pid, opts) {
      opts = opts || {};
      pid = pid || session.propertyId;
      var now = new Date();
      var expired = 0;
      db.waitlistOffers.forEach(function (o) {
        if (o.propertyId !== pid || o.status !== "Offered") return;
        if (new Date(o.expiresAt).getTime() > now.getTime()) return;
        o.status = "Expired"; o.closedAt = now.toISOString(); expired += 1;
        var stay = LHMS.get.reservation(o.reservationId);
        if (stay) {
          log("expired a waitlist offer", "waitlist",
            stay.reference + " · Room " + ((LHMS.get.room(o.roomId) || {}).number || "—"));
        }
      });
      var made = [];
      LHMS.waitlist.queue(pid).forEach(function (res) {
        if (opts.excludeReservationId && opts.excludeReservationId === res.id) return;
        if (LHMS.waitlist.offerFor(res.id)) return;
        var av = LHMS.calc.availability(res.roomTypeId, res.checkIn, res.checkOut, pid);
        if (!av.free) return;
        var q = LHMS.calc.quote(res.roomTypeId, res.ratePlanId, res.checkIn, res.checkOut, res.adults, res.children);
        if (!q.available) return;
        var room = av.rooms[0];
        var g = LHMS.get.guest(res.guestId);
        var offer = {
          id: U.uid("wlo"), reservationId: res.id, propertyId: pid,
          roomId: room.id, roomTypeId: res.roomTypeId,
          offeredAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + WAITLIST_OFFER_HOURS * 3600000).toISOString(),
          notifiedAt: now.toISOString(), status: "Offered", closedAt: null
        };
        db.waitlistOffers.unshift(offer);
        made.push(offer);
        log("released a waitlist room", "waitlist",
          res.reference + " · " + (g ? g.name : "Guest") + " · Room " + room.number);
        notify("Waitlist release", (g ? g.name : "A guest") + " can be given Room " + room.number,
          res.reference + " · " + U.pretty(res.checkIn) + " → " + U.pretty(res.checkOut) +
          " · hold until " + U.timeOf(offer.expiresAt));
      });
      if (made.length || expired) LHMS.save();
      return { ok: true, offers: made, expired: expired };
    },
    accept: function (offerId) {
      var offer = db.waitlistOffers.filter(function (o) { return o.id === offerId; })[0];
      if (!offer) return { ok: false, error: "Waitlist offer not found." };
      if (offerState(offer) !== "Offered") {
        if (offer.status === "Offered") {
          offer.status = "Expired"; offer.closedAt = new Date().toISOString(); LHMS.save();
          return { ok: false, error: "That offer has expired." };
        }
        return { ok: false, error: "That offer is no longer open." };
      }
      var res = LHMS.get.reservation(offer.reservationId);
      if (!res) return { ok: false, error: "Reservation not found." };
      if (res.status !== "Waitlist") {
        offer.status = "Declined"; offer.closedAt = new Date().toISOString(); LHMS.save();
        return { ok: false, error: "That stay is no longer on the waitlist." };
      }
      // The room must still be free, not merely still named on the offer: a
      // second hand may have taken it since the release.
      var av = LHMS.calc.availability(res.roomTypeId, res.checkIn, res.checkOut, offer.propertyId);
      if (!av.rooms.some(function (r) { return r.id === offer.roomId; })) {
        offer.status = "Expired"; offer.closedAt = new Date().toISOString();
        log("lost a waitlist room", "waitlist",
          res.reference + " · Room " + ((LHMS.get.room(offer.roomId) || {}).number || "—"));
        LHMS.save();
        return { ok: false, error: "That room has gone. Release the waitlist again." };
      }
      var q = LHMS.calc.quote(res.roomTypeId, res.ratePlanId, res.checkIn, res.checkOut, res.adults, res.children);
      if (!q.available) return { ok: false, error: "That room type has no rate on sale for those dates." };
      var room = LHMS.get.room(offer.roomId);
      var g = LHMS.get.guest(res.guestId);
      res.roomId = offer.roomId;
      res.status = "Confirmed";
      res.waitlistConfirmedAt = new Date().toISOString();
      chargeRoom(res);
      offer.status = "Accepted"; offer.closedAt = new Date().toISOString();
      log("confirmed a waitlist booking", "waitlist",
        res.reference + " · " + (g ? g.name : "Guest") + " · Room " + (room ? room.number : "—"));
      notify("Waitlist confirmed", (g ? g.name : "A guest") + " took Room " + (room ? room.number : ""),
        res.reference + " · " + U.pretty(res.checkIn) + " → " + U.pretty(res.checkOut), "#/booking/" + res.id);
      LHMS.save();
      return { ok: true, res: res, offer: offer, quote: q };
    },
    decline: function (offerId) {
      var offer = db.waitlistOffers.filter(function (o) { return o.id === offerId; })[0];
      if (!offer) return { ok: false, error: "Waitlist offer not found." };
      if (offerState(offer) !== "Offered") return { ok: false, error: "That offer is no longer open." };
      var res = LHMS.get.reservation(offer.reservationId);
      if (!res) return { ok: false, error: "Reservation not found." };
      offer.status = "Declined"; offer.closedAt = new Date().toISOString();
      var g = LHMS.get.guest(res.guestId);
      log("declined a waitlist offer", "waitlist",
        res.reference + " · " + (g ? g.name : "Guest") + " · Room " + ((LHMS.get.room(offer.roomId) || {}).number || "—"));
      var next = LHMS.waitlist.release(offer.propertyId, { excludeReservationId: res.id });
      LHMS.save();
      return { ok: true, offer: offer, offers: next.offers };
    }
  };

  /* ---------------- mutations ---------------- */
  function actorName() {
    // Use the actual signed-in user's name so the audit log reflects who really
    // performed the action, not a hardcoded role representative.
    return session.name || "Staff";
  }
  LHMS.actorName = actorName;

  function log(action, entity, detail, pid) {
    db.activity.unshift({
      id: U.uid("act"), at: new Date().toISOString(), actor: actorName(),
      action: action, entity: entity, detail: detail, propertyId: pid || session.propertyId
    });
    if (db.activity.length > 250) db.activity.length = 250;
  }
  LHMS.log = log;

  function notify(type, title, detail, link) {
    db.notifications.unshift({
      id: U.uid("ntf"), type: type, title: title, detail: detail, at: new Date().toISOString(),
      read: false, link: link || "#/today", propertyId: session.propertyId
    });
  }

  function chargeRoom(res) {
    var q = LHMS.calc.quote(res.roomTypeId, res.ratePlanId, res.checkIn, res.checkOut, res.adults, res.children);
    if (!q.available) return 0;
    // The quote engine will not price a currency the books cannot value, so by
    // the time a line is written its own folio rate is already fixed.
    var cur = (q.nightly[0] || {}).currency || LHMS.fx.base(res.propertyId);
    function stampOn(amount, code, date) {
      var s = folioStamp(res.id, amount, code || cur, { propertyId: res.propertyId, date: date });
      return s.fields || {};
    }
    var baseRoom = 0;
    q.nightly.forEach(function (night, i) {
      var fields = stampOn(night.rate, night.currency, night.date);
      baseRoom += fields.baseAmount === undefined ? night.rate : fields.baseAmount;
      db.charges.push(Object.assign({
        id: U.uid("chg"), reservationId: res.id, date: night.date,
        description: "Room charge — " + q.type.name + " (" + (i + 1) + "/" + q.nights + ")",
        department: "Rooms", amount: night.rate, qty: 1, postedBy: actorName(),
        // The price as it stood when the line was posted. Later re-pricing can
        // never rewrite this folio because the line carries its own numbers.
        unitPrice: night.rate, basePrice: night.base, extras: night.added,
        serviceId: night.serviceId, priceId: night.priceId, listId: night.listId,
        listName: night.list, currency: night.currency
      }, fields));
    });
    q.taxLines.forEach(function (l) {
      db.charges.push(Object.assign({
        id: U.uid("chg"), reservationId: res.id, date: res.checkOut, description: l.label,
        department: "Taxes & service", amount: l.amount, qty: 1, postedBy: "System", taxRuleId: l.rule.id
      }, stampOn(l.amount, cur, res.checkOut)));
    });
    res.roomTotal = q.roomTotal;
    res.baseRoomTotal = Math.round(baseRoom);
    res.subtotal = q.roomTotal;
    res.service = q.service;
    res.vat = q.vat;
    res.total = q.total;
    return res.total;
  }

  // The governance actions above register themselves before this line runs, so
  // the table is extended rather than replaced.
  LHMS.actions = LHMS.actions || {};

  // Every number a price change has to clear. Both paths — a change applied
  // straight away and one applied after a second signature — come through here,
  // so an approval cannot wave through something the desk would have rejected.
  function pricePatchError(row, patch, reason) {
    if (!row) return "Price not found.";
    var amount = patch.amount === undefined ? row.amount : Number(patch.amount);
    if (!isFinite(amount) || amount <= 0) return "A price must be a positive amount.";
    var from = patch.from === undefined ? row.from : (patch.from || null);
    var to = patch.to === undefined ? row.to : (patch.to || null);
    if (from && to && to < from) return "The end date must fall after the start date.";
    if (!PRICE.list(patch.listId === undefined ? row.listId : patch.listId)) return "Choose a price list.";
    // A price is what the desk will sell, so it cannot stand in a currency the
    // books cannot value today: the row is refused before a guest ever is.
    var cur = patch.currency === undefined ? row.currency : String(patch.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return "Currency “" + patch.currency + "” is not a three-letter code.";
    var blocked = LHMS.fx.gate(cur);
    if (blocked) return blocked.error;
    if (!reason) return "A reason is required — it goes in the audit trail.";
    return null;
  }

  function applyPricePatch(row, patch, reason) {
    var amount = patch.amount === undefined ? row.amount : Number(patch.amount);
    var from = patch.from === undefined ? row.from : (patch.from || null);
    var to = patch.to === undefined ? row.to : (patch.to || null);
    var list = PRICE.list(patch.listId === undefined ? row.listId : patch.listId);
    var active = patch.active === undefined ? row.active : !!patch.active;
    var surcharges = Object.assign({}, row.surcharges, patch.surcharges || {});
    Object.keys(surcharges).forEach(function (k) {
      var v = surcharges[k];
      if (v === null || v === "" || v === undefined) return;
      if (!isFinite(Number(v)) || Number(v) < 0) { surcharges[k] = 0; return; }
      surcharges[k] = Number(v);
    });
    var stamp = new Date().toISOString();
    // The currency belongs to both halves of the entry: a row can be re-denominated
    // from dollars to naira, and the trail has to show which money each figure
    // was counted in.
    var before = { amount: row.amount, currency: row.currency, active: row.active, from: row.from, to: row.to };
    Object.assign(row, {
      amount: PC.round(amount), from: from, to: to, active: active, listId: list.id,
      surcharges: surcharges, currency: patch.currency ? String(patch.currency).toUpperCase() : row.currency,
      updatedAt: stamp, updatedBy: actorName()
    });
    db.priceHistory.unshift({
      id: U.uid("ph"), priceId: row.id, serviceId: row.serviceId, listId: row.listId,
      at: stamp, by: actorName(), reason: reason, from: before,
      to: { amount: row.amount, currency: row.currency, active: row.active, from: row.from, to: row.to }
    });
    var svc = PRICE.service(row.serviceId);
    log(active ? "changed a price" : "deactivated a price", "pricing",
      (svc ? svc.name : row.serviceId) + " · " + list.name + " → " + U.money(row.amount, row.currency));
    LHMS.save();
    return row;
  };

  // A price move wider than the property's limit is held as a request instead of
  // written to the row. The figure tested is the gap the change opens, so a rise
  // and a cut of the same size carry the same risk.
  LHMS.actions.setPrice = function (priceId, patch, reason) {
    var row = byId(db.prices, priceId);
    var bad = pricePatchError(row, patch, reason);
    if (bad) return { ok: false, error: bad };
    if (!LHMS.can("configure_prices")) return { ok: false, error: "Your role cannot change prices." };
    var next = patch.amount === undefined ? row.amount : PC.round(Number(patch.amount));
    // The limit is a figure in the currency the books are kept in, so a dollar
    // row is tested on what its move is worth in naira, not on the number of
    // dollars it moves. A $50 rise is not a ₦50 rise. (The money itself was
    // already gated above: pricePatchError refuses a currency the books cannot
    // value, so this fold always has a rate to work with.)
    var move = LHMS.fx.toBase(Math.abs(next - row.amount), patch.currency || row.currency).base;
    if (move > LHMS.financeSettings().approvalAmount && !LHMS.movesMoneyAlone()) {
      var svc = PRICE.service(row.serviceId);
      var list = PRICE.list(row.listId);
      return {
        ok: true, queued: queueApproval({
          kind: "price",
          subject: (svc ? svc.name : row.serviceId) + " · " + (list ? list.name : row.listId),
          subjectId: row.id,
          change: { patch: patch, reason: reason },
          amount: move, from: row.amount, to: next,
          // The gap is measured in the books' money; the two figures the desk
          // compares are the price row's own.
          fromCurrency: row.currency, toCurrency: patch.currency || row.currency,
          reason: reason
        })
      };
    }
    return { ok: true, price: applyPricePatch(row, patch, reason) };
  };

  /* ---------------- bulk price update ---------------- */

  // A desk prices a season in a spreadsheet, so the file this page downloads is
  // the file it reads back. Cells are walked one at a time rather than split on
  // a comma, because a service name can hold one; a paste out of Excel arrives
  // tab separated, so the delimiter is sniffed from the header line.
  function parseDelimited(text) {
    var s = String(text === undefined || text === null ? "" : text).replace(/^\uFEFF/, "");
    var head = (s.split(/[\r\n]+/)[0] || "");
    var sep = (head.split("\t").length - 1) > (head.split(",").length - 1) ? "\t" : ",";
    var rows = [], row = [], cell = "", quoted = false, i = 0;
    while (i < s.length) {
      var c = s.charAt(i);
      if (quoted) {
        if (c === '"') {
          if (s.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; }
          quoted = false; i++; continue;
        }
        cell += c; i++; continue;
      }
      if (c === '"' && cell === "") { quoted = true; i++; continue; }
      if (c === sep) { row.push(cell); cell = ""; i++; continue; }
      if (c === "\r" || c === "\n") {
        if (c === "\r" && s.charAt(i + 1) === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
      }
      cell += c; i++;
    }
    row.push(cell); rows.push(row);
    return rows
      .filter(function (r) { return r.some(function (v) { return String(v).trim() !== ""; }); })
      .map(function (r) { return r.map(function (v) { return String(v).trim(); }); });
  }

  // The columns a file may drive, in the exact words the export writes. Two
  // columns that matter are read-only evidence and are ignored here.
  var IMPORT_HEAD = {
    "price id": "priceId", "code": "code", "service": "service", "category": "category",
    "price list": "list", "amount": "amount", "currency": "currency",
    "effective from": "from", "effective to": "to", "status": "status",
    "updated by": "ignored", "updated at": "ignored"
  };
  var IMPORT_STATUS = {
    "on sale": true, "available": true, active: true, yes: true, true: true,
    "switched off": false, "service closed": false, off: false, no: false, false: false
  };

  // A column the table does not know keeps its own spelling, because that is how
  // the surcharge fields are named in the row it writes.
  function headKey(label) {
    var clean = String(label).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    return IMPORT_HEAD[clean] || String(label).trim();
  }
  function amountCell(v) {
    var digits = String(v).replace(/[^0-9.\-]/g, "");
    return /^-?\d*\.?\d+$/.test(digits) ? Number(digits) : NaN;
  }

  // What the row would look like after this cell is applied, and whether it
  // differs from the row as it stands. A column the file leaves out is not
  // planned at all; a column the file names and leaves blank is cleared, which
  // is why the export — not a hand-typed sheet — is the template.
  function planRow(row, cols, svc) {
    var patch = {}, next = {
      amount: row.amount, active: row.active, from: row.from || null, to: row.to || null,
      listId: row.listId, currency: row.currency, surcharges: Object.assign({}, row.surcharges)
    };
    if (cols.amount !== undefined) {
      var n = amountCell(cols.amount);
      if (!isFinite(n)) return { error: "Amount “" + cols.amount + "” is not a number." };
      patch.amount = n;
      next.amount = PC.round(n);
    }
    if (cols.list !== undefined && cols.list !== "") {
      var hit = db.priceLists.filter(function (l) {
        return l.id === cols.list || String(l.name).toLowerCase() === cols.list.toLowerCase();
      })[0];
      if (!hit) return { error: "No price list is called “" + cols.list + "”." };
      patch.listId = hit.id;
      next.listId = hit.id;
    }
    if (cols.currency !== undefined && cols.currency !== "") {
      var cur = String(cols.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(cur)) return { error: "Currency “" + cols.currency + "” is not a three-letter code." };
      patch.currency = cur;
      next.currency = cur;
    }
    if (cols.status !== undefined && cols.status !== "") {
      var known = Object.keys(IMPORT_STATUS);
      var match = known.filter(function (k) { return k === cols.status.toLowerCase(); })[0];
      if (match === undefined) return { error: "Status “" + cols.status + "” must be “on sale” or “off”." };
      patch.active = IMPORT_STATUS[match];
      next.active = IMPORT_STATUS[match];
    }
    var error = null;
    ["from", "to"].forEach(function (key) {
      if (error || cols[key] === undefined) return;
      var raw = cols[key] === "" ? null : cols[key];
      if (raw !== null && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        error = "Effective dates must be written YYYY-MM-DD, not “" + raw + "”.";
        return;
      }
      patch[key] = raw;
      next[key] = raw;
    });
    var fieldOf = {};
    LHMS.price.surchargeFields((svc || {}).category).forEach(function (f) { fieldOf[f.toLowerCase()] = f; });
    var surcharges = {};
    Object.keys(cols).forEach(function (key) {
      if (error || !fieldOf[key.toLowerCase()]) return;
      var field = fieldOf[key.toLowerCase()];
      if (cols[key] === "") { surcharges[field] = 0; next.surcharges[field] = 0; return; }
      var v = amountCell(cols[key]);
      if (!isFinite(v) || v < 0) { error = "“" + field + "” must be a number of zero or more."; return; }
      surcharges[field] = v;
      next.surcharges[field] = v;
    });
    if (error) return { error: error };
    if (Object.keys(surcharges).length) patch.surcharges = surcharges;

    var diff = [];
    if (next.amount !== row.amount) diff.push(["amount", row.amount, next.amount]);
    if (next.active !== row.active) diff.push(["status", row.active ? "on sale" : "off", next.active ? "on sale" : "off"]);
    if (next.listId !== row.listId) diff.push(["list", row.listId, next.listId]);
    if (next.currency !== row.currency) diff.push(["currency", row.currency, next.currency]);
    if (String(next.from || "") !== String(row.from || "")) diff.push(["from", row.from || "—", next.from || "—"]);
    if (String(next.to || "") !== String(row.to || "")) diff.push(["to", row.to || "—", next.to || "—"]);
    Object.keys(surcharges).forEach(function (key) {
      var was = Number(row.surcharges[key]) || 0;
      if (was !== surcharges[key]) diff.push([key, was, surcharges[key]]);
    });
    return { patch: patch, next: next, diff: diff };
  }

  // Read-only by construction: nothing here touches a row, so the desk sees the
  // whole file — including what it is about to be asked to sign for — before a
  // single number moves.
  LHMS.price.planImport = function (text, reason) {
    var rows = parseDelimited(text);
    if (rows.length < 2) return { ok: false, error: "The file needs a header line and at least one price." };
    if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
    var headers = rows.shift().map(headKey);
    var out = [], counts = { change: 0, queue: 0, unchanged: 0, reject: 0 };
    var seen = {};
    var limit = LHMS.financeSettings().approvalAmount;
    var movesAlone = LHMS.movesMoneyAlone();

    rows.forEach(function (cells, index) {
      var line = index + 2;
      var cols = {};
      // A cell holding an unquoted comma arrives as two values, and the second
      // would quietly overwrite the next column — so a short row is refused
      // rather than read. Money is not worth guessing at.
      var overrun = cells.length > headers.length;
      headers.forEach(function (key, i) {
        if (key === "ignored") return;
        if (cells[i] === undefined) return;
        cols[key] = cells[i];
      });
      var row = null;
      if (cols.priceId) row = byId(db.prices, cols.priceId);
      if (!row && cols.code) {
        var byCode = db.services.filter(function (s) { return String(s.code).toLowerCase() === cols.code.toLowerCase(); })[0];
        if (byCode) {
          var wanted = (cols.list || "").toLowerCase();
          row = db.prices.filter(function (p) {
            if (p.serviceId !== byCode.id) return false;
            if (!wanted) return true;
            var l = PRICE.list(p.listId);
            return p.listId.toLowerCase() === wanted || String(l && l.name).toLowerCase() === wanted;
          })[0];
        }
      }
      var entry = {
        line: line, priceId: cols.priceId || (row && row.id) || "",
        service: (row && (PRICE.service(row.serviceId) || {}).name) || cols.service || "—",
        list: row ? ((PRICE.list(row.listId) || {}).name || row.listId) : (cols.list || "—"),
        state: "reject", error: null, patch: null, move: 0, diff: []
      };
      if (overrun) {
        entry.error = "Line " + line + " holds " + cells.length + " values but the header names " +
          headers.length + " — quote any cell that contains a comma.";
      } else if (!row) {
        entry.error = "No price record matches " + (cols.priceId ? "id " + cols.priceId : "code " + (cols.code || "—")) +
          (cols.list ? " on " + cols.list : "") + ".";
      } else if (seen[row.id]) {
        entry.error = "This price appears twice in the file — line " + seen[row.id] + " already carries it.";
      } else {
        seen[row.id] = line;
        var svc = PRICE.service(row.serviceId);
        var planned = planRow(row, cols, svc);
        if (planned.error) {
          entry.error = planned.error;
        } else {
          entry.patch = planned.patch;
          entry.diff = planned.diff;
          entry.current = { amount: row.amount, currency: row.currency, active: row.active };
          entry.next = planned.next;
          var bad = pricePatchError(row, planned.patch, reason);
          if (bad) entry.error = bad;
        }
      }
      if (entry.error) {
        entry.state = "reject"; counts.reject++;
        out.push(entry);
        return;
      }
      if (!entry.diff.length) { entry.state = "unchanged"; counts.unchanged++; out.push(entry); return; }
      // The limit is a base-currency figure, so a dollar row is tested on what
      // the move is worth here rather than on the number of dollars. (The money
      // itself was already gated above: pricePatchError refuses a currency the
      // books cannot value, so this fold always has a rate to work with.)
      var gap = LHMS.fx.toBase(
        Math.abs(PC.round(entry.next.amount) - row.amount),
        entry.next.currency
      );
      entry.move = gap.base; entry.currency = gap.state.base;
      if (entry.move > limit && !movesAlone) { entry.state = "queue"; counts.queue++; }
      else { entry.state = "change"; counts.change++; }
      out.push(entry);
    });

    return {
      ok: true, reason: reason, rows: out, counts: counts, limit: limit,
      rejected: out.filter(function (r) { return r.state === "reject"; }),
      changes: out.filter(function (r) { return r.state === "change" || r.state === "queue"; })
    };
  };

  // Every row that lands goes through the same applier the single-row editor
  // uses, so a bulk file writes the same history entry and is held to the same
  // approval limit as a change typed into the form.
  LHMS.actions.applyPriceImport = function (plan) {
    if (!plan || !plan.ok) return { ok: false, error: (plan && plan.error) || "Nothing to import." };
    if (!LHMS.can("configure_prices")) return { ok: false, error: "Your role cannot change prices." };
    var applied = 0, approvals = [];
    plan.rows.forEach(function (r) {
      if (r.state !== "change" && r.state !== "queue") return;
      var row = byId(db.prices, r.priceId);
      if (!row) { r.state = "reject"; r.error = "That price record is gone."; return; }
      var svc = PRICE.service(row.serviceId);
      var list = PRICE.list(row.listId);
      if (r.state === "queue") {
        approvals.push(queueApproval({
          kind: "price",
          subject: (svc ? svc.name : row.serviceId) + " · " + (list ? list.name : row.listId),
          subjectId: row.id,
          change: { patch: r.patch, reason: plan.reason },
          amount: r.move, from: row.amount, to: r.next.amount, reason: plan.reason,
          fromCurrency: row.currency, toCurrency: r.next.currency
        }));
        return;
      }
      applyPricePatch(row, r.patch, plan.reason);
      applied++;
    });
    var held = approvals.length;
    log("imported prices from a file", "pricing",
      applied + " price" + (applied === 1 ? "" : "s") + " updated · " + held +
      (held === 1 ? " held for a second signature" : " held for second signatures") + " · " + plan.reason);
    LHMS.save();
    return {
      ok: true, applied: applied, queued: held, approvals: approvals,
      unchanged: plan.counts.unchanged, rejected: plan.counts.reject
    };
  };

  LHMS.actions.setTaxRule = function (ruleId, patch, reason) {
    var rule = byId(db.taxRules, ruleId);
    if (!rule) return { ok: false, error: "Tax rule not found." };
    if (!LHMS.can("configure_prices")) return { ok: false, error: "Your role cannot change taxes." };
    var pct = patch.pct === undefined ? rule.pct : Number(patch.pct);
    if (!isFinite(pct) || pct < 0 || pct > 50) return { ok: false, error: "Enter a rate between 0% and 50%." };
    if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
    var before = rule.pct;
    rule.pct = pct;
    if (patch.name) rule.name = String(patch.name);
    if (patch.appliesTo) rule.appliesTo = patch.appliesTo;
    rule.updatedAt = new Date().toISOString();
    rule.updatedBy = actorName();
    log("changed a tax rule", "pricing", rule.name + " " + before + "% \u2192 " + pct + "% · " + reason);
    LHMS.save();
    return { ok: true, rule: rule };
  };

  var SERVICE_CATEGORIES = ["room", "hall", "restaurant", "laundry"];

  // A new service starts with the surcharge bag its category understands; any
  // field the form leaves blank starts at zero rather than undefined.
  var SURCHARGE_FIELDS = {
    room: ["weekendPct", "extraAdult", "extraBed", "earlyCheckIn", "lateCheckOut", "depositPct"],
    hall: ["weekendPct", "halfDay", "fullDay", "depositPct", "cancelPct", "cancelHours"],
    restaurant: [],
    laundry: ["expressPct"]
  };

  function extrasOf(category, data) {
    var bag = {
      weekendPct: 0, extraAdult: 0, extraBed: 0, earlyCheckIn: 0, lateCheckOut: 0,
      expressPct: 0, depositPct: 0, cancelPct: 0, cancelHours: 0, halfDay: null, fullDay: null
    };
    (SURCHARGE_FIELDS[category] || []).forEach(function (k) {
      var v = Number(data[k]);
      if (v > 0) bag[k] = v;
    });
    return bag;
  }

  // A new chargeable service and its first price are created together, so there
  // is never a service on the board that cannot be quoted.
  LHMS.actions.createService = function (data) {
    if (!LHMS.can("configure_prices")) return { ok: false, error: "Your role cannot add services." };
    var name = String(data.name || "").trim();
    var category = String(data.category || "");
    if (!name) return { ok: false, error: "Give the service a name." };
    if (SERVICE_CATEGORIES.indexOf(category) === -1) return { ok: false, error: "Choose a service category." };
    var amount = Number(data.amount);
    if (!isFinite(amount) || amount <= 0) return { ok: false, error: "A price must be a positive amount." };
    var code = String(data.code || "").trim().toUpperCase();
    if (code && db.services.some(function (s) { return s.code === code; })) return { ok: false, error: "That code is already used by another service." };
    var list = LHMS.price.list(data.listId) || db.priceLists.find(function (l) { return l.kind === "standard"; });
    if (!list) return { ok: false, error: "Choose a price list." };
    var reason = String(data.reason || "").trim();
    if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
    var id = U.uid("svc");
    var service = {
      id: id, category: category, refId: id, code: code || id.toUpperCase(), name: name,
      unit: String(data.unit || "piece"), active: true
    };
    if (category === "room") service.occupancy = Math.max(1, Number(data.occupancy) || 2);
    if (category === "hall") service.capacity = Math.max(1, Number(data.capacity) || 1);
    if (category === "restaurant") service.outletId = data.outletId || null;
    if (category === "laundry") {
      service.unit = String(data.unit || "piece");
      service.turnaroundMins = Math.max(30, Number(data.turnaroundMins) || 240);
    }
    var stamp = new Date().toISOString();
    var price = {
      id: U.uid("prc"), serviceId: id, listId: list.id, currency: data.currency || "NGN",
      amount: PC.round(amount), surcharges: extrasOf(category, data),
      from: data.from || null, to: data.to || null, active: true,
      createdAt: stamp, updatedAt: stamp, updatedBy: actorName()
    };
    db.services.push(service);
    db.prices.push(price);
    db.priceHistory.unshift({
      id: U.uid("ph"), priceId: price.id, serviceId: id, listId: list.id, at: stamp,
      by: actorName(), reason: reason, from: null,
      to: { amount: price.amount, currency: price.currency, active: true }
    });
    log("added a priced service", "pricing", service.name + " · " + list.name + " \u2192 " + U.money(price.amount, price.currency));
    LHMS.save();
    return { ok: true, service: service, price: price };
  };

  // Switching a service off stops it being offered anywhere in the product,
  // but the price rows and every posted charge stay exactly as they were.
  LHMS.actions.setServiceActive = function (serviceId, active, reason) {
    var svc = byId(db.services, serviceId);
    if (!svc) return { ok: false, error: "Service not found." };
    if (!LHMS.can("configure_prices")) return { ok: false, error: "Your role cannot change services." };
    if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
    svc.active = !!active;
    svc.updatedAt = new Date().toISOString();
    svc.updatedBy = actorName();
    log(active ? "re-opened a service" : "closed a service", "pricing", svc.name + " · " + reason);
    LHMS.save();
    return { ok: true, service: svc };
  };

  LHMS.actions.createGuest = function (data, pid) {
    var name = ((data.firstName || "") + " " + (data.lastName || "")).trim();
    var guest = {
      id: U.uid("gst"), title: data.title || "Mr", firstName: data.firstName, lastName: data.lastName, name: name,
      email: data.email || "", phone: data.phone || "", country: data.country || "Nigeria", city: data.city || "",
      tier: data.tier || "Member", job: "", birthday: "", since: new Date().getFullYear(),
      idType: data.idType || "International passport", idNumber: data.idNumber || "",
      preferences: {
        pillow: "No preference", room: "No preference", dietary: "No restrictions",
        allergies: "None", beverage: "Still water", newspaper: "None", turndown: "On request"
      },
      consent: { marketing: !!data.marketing, dataSharing: false, profiling: true },
      tags: ["New profile"], notes: [], loyaltyPoints: 0, language: "English", featured: false
    };
    db.guests.unshift(guest);
    log("created a guest profile", "guest", name + " · " + (data.phone || "no phone"), pid);
    LHMS.save();
    return guest;
  };

  LHMS.actions.updateGuest = function (guestId, patch) {
    var g = LHMS.get.guest(guestId);
    if (!g) return null;
    Object.keys(patch).forEach(function (k) {
      if (k === "preferences" || k === "consent") {
        g[k] = Object.assign({}, g[k], patch[k]);
      } else g[k] = patch[k];
    });
    if (patch.firstName || patch.lastName) g.name = (g.firstName + " " + g.lastName).trim();
    log("updated a guest profile", "guest", g.name);
    LHMS.save();
    return g;
  };

  LHMS.actions.addGuestNote = function (guestId, text) {
    var g = LHMS.get.guest(guestId);
    if (!g || !text) return;
    g.notes.unshift({ id: U.uid("note"), text: text, by: actorName(), date: bizDay() });
    log("added a guest note", "guest", g.name + " · " + text.slice(0, 60));
    LHMS.save();
  };

  // A waitlisted stay is still a priced stay: the desk has to know what the room
  // will cost when one is released, and an unpriced room type could never be
  // released at all. It holds no room and takes no money until an offer is
  // accepted.
  LHMS.actions.newBooking = function (data) {
    var type = LHMS.get.roomType(data.roomTypeId);
    var plan = LHMS.get.ratePlan(data.ratePlanId);
    var q = LHMS.calc.quote(data.roomTypeId, data.ratePlanId, data.checkIn, data.checkOut, data.adults, data.children);
    var waiting = Boolean(data.waitlist);
    if (waiting && !q.available) return { ok: false, error: "That room type has no rate on sale for those dates." };
    if (waiting && Number(data.deposit) > 0) return { ok: false, error: "A waitlisted stay cannot take a deposit." };
    var guestId = data.guestId;
    if (!guestId) {
      var g = LHMS.actions.createGuest({
        title: data.title, firstName: data.firstName, lastName: data.lastName,
        email: data.email, phone: data.phone, country: data.country, idNumber: data.idNumber, idType: data.idType
      });
      guestId = g.id;
    }
    var preferredRoom = data.roomId || null;
    var prop = LHMS.get.property(data.propertyId || session.propertyId);
    if (!waiting && !preferredRoom) {
      var av = LHMS.calc.availability(data.roomTypeId, data.checkIn, data.checkOut, prop.id);
      preferredRoom = av.rooms.length ? av.rooms[0].id : null;
    }
    var seq = (db.counters.res += 1);
    var guest = LHMS.get.guest(guestId);
    var res = {
      id: U.uid("res"), reference: prop.code + "-" + seq, propertyId: prop.id, guestId: guestId,
      roomId: waiting ? null : preferredRoom, roomTypeId: data.roomTypeId, ratePlanId: data.ratePlanId,
      checkIn: data.checkIn, checkOut: data.checkOut, adults: Number(data.adults) || 1,
      children: Number(data.children) || 0, status: waiting ? "Waitlist" : "Confirmed",
      channel: data.channel || "Direct",
      notes: data.notes || "", createdAt: new Date().toISOString(), source: data.source || "Front desk",
      vip: guest && (guest.tier === "Platinum" || guest.tier === "Gold"), eta: data.eta || ""
    };
    db.reservations.unshift(res);
    if (waiting) {
      res.roomTotal = q.roomTotal;
      res.subtotal = q.roomTotal;
      res.service = q.service;
      res.vat = q.vat;
      res.total = q.total;
      res.stayCurrency = q.currency;
      log("joined the waitlist", "reservation", res.reference + " · " + guest.name + " · " + q.nights + " nights");
      notify("Added to the waitlist", res.reference + " for " + guest.name,
        U.pretty(res.checkIn) + " → " + U.pretty(res.checkOut) + " · " + type.name, "#/booking/" + res.id);
    } else {
      chargeRoom(res);
      var deposit = Number(data.deposit) || 0;
      if (deposit > 0) {
        db.payments.push(Object.assign({
          id: U.uid("pay"), reservationId: res.id, date: bizDay(),
          method: data.method || "Card", amount: deposit, reference: "TX" + Math.floor(100000 + Math.random() * 899999), takenBy: actorName()
        }, folioPayStamp(res, deposit)));
      }
      log("created a reservation", "reservation", res.reference + " · " + guest.name + " · " + q.nights + " nights");
      notify("New reservation", res.reference + " created for " + guest.name, U.pretty(res.checkIn) + " → " + U.pretty(res.checkOut) + " · " + type.name, "#/booking/" + res.id);
    }
    LHMS.save();
    return res;
  };

  // Cancelling frees the room, then runs the waitlist pass so a held promise is
  // offered the room in the same breath — the release is automatic, not a
  // second chore for the desk.
  LHMS.actions.cancelReservation = function (resId, opts) {
    opts = opts || {};
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    if (["Confirmed", "In-house", "Waitlist"].indexOf(res.status) === -1) {
      return { ok: false, error: "Reservation cannot be cancelled in its current status." };
    }
    var g = LHMS.get.guest(res.guestId);
    res.status = "Cancelled";
    var room = LHMS.get.room(res.roomId);
    if (room && room.hk === "Occupied") room.hk = "Dirty";
    if (opts.fee) {
      var firstNight = LHMS.folio(res.id).charges.filter(function (c) { return c.department === "Rooms"; })[0];
      LHMS.actions.postCharge(res.id, {
        description: "Cancellation fee — one night", department: "Rooms",
        amount: firstNight ? firstNight.amount : LHMS.price.nightRate(res.roomTypeId)
      });
    }
    log("cancelled a reservation", "reservation", res.reference + " · " + (g ? g.name : "Guest"));
    var released = LHMS.waitlist.release(res.propertyId, { excludeReservationId: res.id });
    LHMS.save();
    return { ok: true, res: res, offers: released.offers, expired: released.expired };
  };

  LHMS.actions.checkIn = function (resId, opts) {
    opts = opts || {};
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    if (res.status !== "Confirmed") return { ok: false, error: "Only confirmed reservations can be checked in." };
    if (opts.roomId) res.roomId = opts.roomId;
    if (opts.eta) res.eta = opts.eta;
    res.status = "In-house";
    res.checkedInAt = new Date().toISOString();
    var room = LHMS.get.room(res.roomId);
    if (room) room.hk = "Occupied";
    if (Number(opts.deposit) > 0) {
      db.payments.push(Object.assign({
        id: U.uid("pay"), reservationId: res.id, date: bizDay(), method: opts.method || "Card",
        amount: Number(opts.deposit), reference: "TX" + Math.floor(100000 + Math.random() * 899999), takenBy: actorName()
      }, folioPayStamp(res, Number(opts.deposit))));
    }
    if (opts.mobileKey) {
      res.mobileKey = true;
      res.keyIssuedAt = new Date().toISOString();
    }
    var g = LHMS.get.guest(res.guestId);
    log("checked in", "reservation", res.reference + " · " + (g ? g.name : "") + " · Room " + (room ? room.number : "—"));
    notify("Guest checked in", (g ? g.name : "Guest") + " is now in Room " + (room ? room.number : ""), res.reference + " · " + U.pretty(res.checkOut) + " departure", "#/folio/" + res.id);
    LHMS.save();
    return { ok: true, res: res, room: room };
  };

  /* ---------------- loyalty (PRD 6.9) ---------------- */
  // A stay earns points on what the guest actually settles, and points are only
  // ever worth something as a credit against a live folio.
  var LOYALTY = {
    earnPer: 1000, minRedeem: 2000, valuePerPoint: 5,
    multipliers: { Member: 1, Silver: 1.25, Gold: 1.5, Platinum: 2 }
  };

  LHMS.loyalty = {
    config: LOYALTY,
    multiplierFor: function (tier) { return LOYALTY.multipliers[tier] || 1; },
    pointsFor: function (amount, tier) {
      return Math.max(0, Math.round((Number(amount) || 0) / LOYALTY.earnPer * LHMS.loyalty.multiplierFor(tier)));
    },
    creditFor: function (points) { return Math.round((Number(points) || 0) * LOYALTY.valuePerPoint); },
    pending: function (resId) {
      var res = LHMS.get.reservation(resId);
      if (!res || res.pointsAwarded) return 0;
      var g = LHMS.get.guest(res.guestId);
      return LHMS.loyalty.pointsFor(LHMS.folio(resId).baseTotal, g ? g.tier : "Member");
    },
    award: function (resId) {
      var res = LHMS.get.reservation(resId);
      var g = res && LHMS.get.guest(res.guestId);
      if (!g || res.pointsAwarded) return 0;
      var pts = LHMS.loyalty.pointsFor(LHMS.folio(resId).baseTotal, g.tier);
      if (pts > 0) {
        g.loyaltyPoints = (g.loyaltyPoints || 0) + pts;
        res.pointsAwarded = pts;
        log("earned loyalty points", "guest", g.name + " · " + pts + " pts · " + res.reference);
      }
      return pts;
    }
  };

  LHMS.actions.redeemPoints = function (resId, data) {
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    var g = LHMS.get.guest(res.guestId);
    if (!g) return { ok: false, error: "No guest profile to redeem from." };
    var pts = Math.round(Number(data.points) || 0);
    if (pts < LOYALTY.minRedeem) return { ok: false, error: "Redeem at least " + LOYALTY.minRedeem + " points." };
    if (pts > (g.loyaltyPoints || 0)) {
      return { ok: false, error: "Only " + (g.loyaltyPoints || 0) + " points are available on this profile." };
    }
    var credit = LHMS.loyalty.creditFor(pts);
    var f = LHMS.folio(resId);
    if (credit > f.balance) {
      return { ok: false, error: "That is more than the " + U.money(f.balance, f.currency) + " outstanding on the folio." };
    }
    // Points are earned and spent in the property's own money. Letting them
    // settle a dollar folio would set the rate by hand, so the credit stays on
    // the side of the ledger it was earned on.
    var cur = folioCode(resId);
    if (cur !== LHMS.fx.base(res.propertyId)) {
      return { ok: false, error: "Aurelia Club credit is worth " + LHMS.fx.base(res.propertyId) +
        " and cannot settle a folio billed in " + cur + "." };
    }
    g.loyaltyPoints = (g.loyaltyPoints || 0) - pts;
    var c = {
      id: U.uid("chg"), reservationId: resId, date: bizDay(),
      description: "Aurelia Club — " + pts.toLocaleString("en-NG") + " points redeemed", department: "Loyalty",
      amount: -credit, qty: 1, points: pts, postedBy: data.postedBy || actorName(),
      currency: cur
    };
    db.charges.push(c);
    log("redeemed loyalty points", "folio", pts.toLocaleString("en-NG") + " pts · " + U.money(credit, cur) + " credit · " + res.reference);
    LHMS.save();
    return { ok: true, points: pts, credit: credit, charge: c, guest: g };
  };

  LHMS.actions.checkOut = function (resId, opts) {
    opts = opts || {};
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    var f = LHMS.folio(res.id);
    if (f.balance > 0 && !opts.settle) {
      return { ok: false, error: "Balance of " + U.money(f.balance, f.currency) + " must be settled before check-out.", balance: f.balance };
    }
    if (f.balance > 0 && opts.settle) {
      db.payments.push(Object.assign({
        id: U.uid("pay"), reservationId: res.id, date: bizDay(), method: opts.method || "Card",
        amount: f.balance, reference: "TX" + Math.floor(100000 + Math.random() * 899999), takenBy: actorName()
      }, folioPayStamp(res, f.balance)));
    }
    res.status = "Checked out";
    res.checkedOutAt = new Date().toISOString();
    var room = LHMS.get.room(res.roomId);
    if (room) {
      room.hk = "Dirty";
      db.tasks.unshift({
        id: U.uid("tsk"), propertyId: res.propertyId, type: "Departure clean",
        title: "Departure clean — Room " + room.number,
        detail: "Guest checked out. Full turnover before the next arrival." + (opts.early ? " Early departure — prioritise." : ""),
        roomId: room.id, guestId: res.guestId, assignedTo: null, priority: "High", status: "Open",
        createdAt: new Date().toISOString(), dueAt: new Date(Date.now() + 60 * 60000).toISOString(),
        slaMins: 60, resolvedAt: null, source: "Front desk"
      });
    }
    var g = LHMS.get.guest(res.guestId);
    var earned = LHMS.loyalty.award(res.id);
    log("checked out", "reservation", res.reference + " · " + (g ? g.name : "") + " · Room " + (room ? room.number : ""));
    LHMS.save();
    return { ok: true, res: res, room: room, points: earned };
  };

  LHMS.actions.postCharge = function (resId, data) {
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    var amount = Number(data.amount);
    if (!amount || amount <= 0) return { ok: false, error: "Enter a charge amount greater than zero." };
    var qty = Math.max(1, Number(data.qty) || 1);
    var postDate = data.date || bizDay();
    var sealed = closedDay(postDate);
    if (sealed) return { ok: false, error: sealed };
    var cur = data.currency || LHMS.fx.base(res.propertyId);
    var stamp = folioStamp(resId, amount, cur, { propertyId: res.propertyId, date: postDate });
    if (stamp.error) return { ok: false, error: stamp.error };
    var c = {
      id: U.uid("chg"), reservationId: resId, date: postDate,
      description: data.description || "Miscellaneous charge", department: data.department || "Other",
      amount: Math.round(amount), qty: qty, postedBy: data.postedBy || actorName()
    };
    // Whatever priced this line travels with it, so the folio can be re-printed
    // years later and still show the rate that was actually agreed.
    PRICE_SNAPSHOT.forEach(function (k) {
      if (data[k] !== undefined && data[k] !== null) c[k] = data[k];
    });
    Object.assign(c, stamp.fields);
    db.charges.push(c);
    log("posted a charge", "folio", U.money(c.amount, c.currency) + " · " + c.description);
    LHMS.save();
    return { ok: true, charge: c };
  };

  // An order, priced by the engine. A page sends items and quantities only —
  // it never assembles a money line, and every charge carries its own snapshot.
  LHMS.actions.orderItems = function (resId, lines, opts) {
    opts = opts || {};
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    var priced = [];
    for (var i = 0; i < lines.length; i++) {
      var qty = Math.max(1, Number(lines[i].qty) || 0);
      if (!qty) continue;
      var svc = LHMS.price.forRef(opts.category || "restaurant", lines[i].id);
      if (!svc) return { ok: false, error: "That item is no longer on the menu." };
      var a = LHMS.price.amount(svc.id, { qty: qty, express: !!opts.express });
      if (!a) return { ok: false, error: svc.name + " is not being sold right now." };
      priced.push({ svc: svc, qty: qty, quote: a });
    }
    if (!priced.length) return { ok: false, error: "Choose at least one item." };
    // Ask before posting: an order that mixes monies, or that the folio cannot
    // take, would otherwise leave lines half-way on the guest's account.
    var money = oneCurrency(priced.map(function (p) { return p.quote; }), { propertyId: res.propertyId });
    if (money.error) return { ok: false, error: money.error };
    var fit = folioCurrency(resId, money.code, res.propertyId);
    if (fit.error) return { ok: false, error: fit.error };
    var outletOf = {};
    var charges = priced.map(function (p) {
      var outlet = p.svc.outletId && (outletOf[p.svc.outletId] || (outletOf[p.svc.outletId] = LHMS.get.outlet(p.svc.outletId)));
      return LHMS.actions.postCharge(resId, {
        description: (p.qty > 1 ? p.qty + " × " : "") + p.svc.name + (outlet ? " · " + outlet.name : ""),
        department: outlet ? outlet.dept : "Other",
        amount: p.quote.lines, qty: p.qty, date: opts.date || bizDay(), postedBy: opts.postedBy || actorName(),
        unitPrice: p.quote.unit, extras: p.quote.added, currency: p.quote.currency,
        serviceId: p.svc.id, priceId: p.quote.price.id, listId: p.quote.list.id, listName: p.quote.list.name
      }).charge;
    });
    if (!charges.length) return { ok: false, error: "Choose at least one item." };
    var total = charges.reduce(function (s, c) { return s + c.amount; }, 0);
    // oneCurrency has already forced every line into the money of the folio, so
    // the total has one money and says so.
    return {
      ok: true, charges: charges, total: total, currency: charges[0].currency,
      items: priced, outlet: outletOf[priced[0].svc.outletId] || null
    };
  };

  /* ---------------- hall bookings ---------------- */
  var EVENT_STATUSES = ["Hold", "Confirmed", "Cancelled"];
  var LAUNDRY_STAGES = ["Received", "In progress", "Ready", "Collected"];
  LHMS.EVENT_STATUSES = EVENT_STATUSES;
  LHMS.LAUNDRY_STAGES = LAUNDRY_STAGES;

  function hallOf(id) {
    var svc = LHMS.get.hall(id);
    return svc && svc.category === "hall" && !svc.addon ? svc : null;
  }

  // A form may send choices as a map of id → quantity or as rows; both mean the
  // same thing and the engine works in rows.
  function toRows(input) {
    if (!input) return [];
    if (Array.isArray(input)) return input;
    return Object.keys(input).map(function (id) { return { id: id, qty: input[id] }; });
  }

  // The lines a booking agreed, posted to the folio as they were quoted.
  function postEventCharges(evt) {
    var ids = [];
    evt.lines.forEach(function (l) {
      ids.push(LHMS.actions.postCharge(evt.reservationId, {
        description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " — " + evt.title,
        department: "Events & Banqueting", amount: l.amount, qty: l.qty, date: evt.date,
        unitPrice: l.unitPrice, basePrice: l.basePrice, extras: l.added, currency: l.currency,
        serviceId: l.serviceId, priceId: l.priceId, listId: l.listId, listName: l.listName
      }).charge.id);
    });
    (evt.taxLines || []).forEach(function (t) {
      ids.push(LHMS.actions.postCharge(evt.reservationId, {
        description: t.label + " — " + evt.title, department: "Taxes & service",
        amount: t.amount, qty: 1, date: evt.date, taxRuleId: t.ruleId, postedBy: "System",
        currency: evt.currency
      }).charge.id);
    });
    return ids;
  }

  LHMS.actions.createEvent = function (data) {
    if (!LHMS.can("book_events")) return { ok: false, error: "Your role cannot book halls." };
    var svc = hallOf(data.hallId);
    if (!svc) return { ok: false, error: "Choose a hall." };
    var title = String(data.title || "").trim();
    if (!title) return { ok: false, error: "Give the event a name." };
    var organizer = String(data.organizer || "").trim();
    if (!organizer) return { ok: false, error: "Record who the booking is for." };
    var date = String(data.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: "Choose the event date." };
    if (date < bizDay()) return { ok: false, error: "An event cannot be booked in the past." };
    var hours = U.hoursBetween(data.start, data.end);
    if (!hours) return { ok: false, error: "Check the times — the hall must be held for at least an hour." };
    var guests = Math.max(1, Number(data.guests) || 0);
    if (svc.capacity && guests > svc.capacity) {
      return { ok: false, error: svc.name + " is licensed for " + svc.capacity + " guests, not " + guests + "." };
    }
    // Two bookings of the same hall at overlapping times are refused outright;
    // back-to-back slots, which only touch at an endpoint, are allowed.
    var clash = LHMS.hallConflict(svc.refId, date, data.start, data.end);
    if (clash) {
      return {
        ok: false,
        error: "Clash — " + clash.title + " already holds " + svc.name + " from " +
          clash.start + " to " + clash.end + " on " + U.pretty(date, "medium") + ".",
        conflict: clash
      };
    }
    var quote = LHMS.price.hallQuote(svc.id, {
      date: date, start: data.start, end: data.end, package: data.package || null, addons: toRows(data.addons)
    });
    if (!quote) return { ok: false, error: "There is no active price for " + svc.name + " on that date." };
    var res = data.reservationId ? LHMS.get.reservation(data.reservationId) : null;
    if (data.reservationId && !res) return { ok: false, error: "The linked reservation no longer exists." };
    // A booking that reaches a folio has to be in the money that folio is kept
    // in, or the balance stops being one number somebody can settle. Asking here
    // refuses the whole booking instead of half-posting lines and crashing.
    if (res) {
      var fit = folioCurrency(res.id, quote.currency, res.propertyId);
      if (fit.error) return { ok: false, error: fit.error };
    }
    var sur = quote.price.surcharges || {};
    var byKind = {};
    quote.taxLines.forEach(function (l) { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
    var evt = {
      id: U.uid("evt"), propertyId: res ? res.propertyId : session.propertyId,
      hallId: svc.refId, hallServiceId: svc.id, hallName: svc.name, capacity: svc.capacity,
      title: title, organizer: organizer, email: String(data.email || "").trim(),
      phone: String(data.phone || "").trim(), guests: guests, layout: String(data.layout || "").trim(),
      date: date, start: data.start, end: data.end, hours: hours,
      package: quote.package, packageName: quote.packageName,
      reservationId: res ? res.id : null, status: data.status === "Hold" ? "Hold" : "Confirmed",
      lines: quote.lines, subtotal: quote.subtotal,
      taxLines: quote.taxLines.map(function (l) { return { ruleId: l.rule.id, label: l.label, amount: l.amount }; }),
      service: byKind.service || 0, vat: byKind.vat || 0, tax: quote.tax, total: quote.total,
      currency: quote.currency, fxRate: quote.fxRate, baseAmount: quote.baseAmount,
      priceId: quote.price.id, listId: quote.list.id, listName: quote.list.name,
      depositPct: quote.depositPct, deposit: quote.deposit, depositPaid: 0,
      cancelPct: sur.cancelPct || 0, cancelHours: sur.cancelHours || 0, cancelFee: 0,
      charges: [], createdAt: bizDay(), createdBy: actorName(), notes: String(data.notes || "")
    };
    db.events.push(evt);
    // A hold reserves the time but agrees no money yet, so nothing reaches the
    // folio until the desk confirms it.
    if (evt.status === "Confirmed" && res) evt.charges = postEventCharges(evt);
    log(evt.status === "Hold" ? "put a hall on hold" : "booked " + evt.hallName, "events",
      evt.title + " · " + U.pretty(date, "medium") + " " + evt.start + "–" + evt.end + " · " + U.money(evt.total, evt.currency));
    notify("New hall booking", evt.title + " · " + evt.hallName,
      evt.date + " " + evt.start + "–" + evt.end + " for " + evt.guests + " guests", "#/events/" + evt.date);
    LHMS.save();
    return { ok: true, event: evt, quote: quote, posted: evt.charges.length > 0 };
  };

  // Confirming a hold prices it from the lines the hold was quoted on, not from
  // whatever the board says today — the guest was already given a number.
  LHMS.actions.confirmEvent = function (eventId) {
    if (!LHMS.can("book_events")) return { ok: false, error: "Your role cannot confirm hall bookings." };
    var evt = LHMS.get.event(eventId);
    if (!evt) return { ok: false, error: "Booking not found." };
    if (evt.status !== "Hold") return { ok: false, error: "Only a hold can be confirmed." };
    var clash = LHMS.hallConflict(evt.hallId, evt.date, evt.start, evt.end, evt.id);
    if (clash) return { ok: false, error: "That window has since been taken by " + clash.title + "." };
    var res = LHMS.get.reservation(evt.reservationId);
    // The folio may have taken other money while the hall sat on hold, so the
    // same single-currency test runs again at confirmation, before the status —
    // and therefore the money — moves.
    if (res) {
      var fit = folioCurrency(res.id, evt.currency || LHMS.fx.base(res.propertyId), res.propertyId);
      if (fit.error) return { ok: false, error: fit.error };
    }
    evt.status = "Confirmed";
    if (res) evt.charges = postEventCharges(evt);
    log("confirmed a hall booking", "events", evt.title + " · " + U.money(evt.total, evt.currency));
    LHMS.save();
    return { ok: true, event: evt, posted: evt.charges.length > 0 };
  };

  LHMS.actions.takeEventDeposit = function (eventId, method) {
    if (!LHMS.can("book_events")) return { ok: false, error: "Your role cannot take event payments." };
    var evt = LHMS.get.event(eventId);
    if (!evt) return { ok: false, error: "Booking not found." };
    if (evt.status !== "Confirmed") return { ok: false, error: "Only a confirmed booking takes a deposit." };
    if (evt.depositPaid >= evt.deposit) return { ok: false, error: "The deposit on this booking is already recorded." };
    if (!evt.reservationId) {
      return { ok: false, error: "This booking is not on a guest folio, so its deposit is invoiced by the events desk." };
    }
    var pay = LHMS.actions.takePayment(evt.reservationId, { amount: evt.deposit, method: method || "Transfer" });
    if (!pay.ok) return pay;
    evt.depositPaid = evt.deposit;
    evt.depositPaymentId = pay.payment.id;
    log("took an event deposit", "events", evt.title + " · " + U.money(evt.deposit, evt.currency) + " · " + pay.payment.method);
    LHMS.save();
    return { ok: true, event: evt, payment: pay.payment };
  };

  // Cancelling voids the lines it posted, charges the fee the booking was sold
  // on, and keeps the original event row — nothing financial is ever deleted.
  LHMS.actions.cancelEvent = function (eventId, reason) {
    if (!LHMS.can("book_events")) return { ok: false, error: "Your role cannot cancel hall bookings." };
    var evt = LHMS.get.event(eventId);
    if (!evt) return { ok: false, error: "Booking not found." };
    if (evt.status === "Cancelled") return { ok: false, error: "That booking is already cancelled." };
    reason = String(reason || "").trim();
    if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
    var fee = LHMS.price.cancellationFee(evt);
    evt.voidedCharges = (evt.charges || []).slice();
    evt.voidedCharges.forEach(function (id) { LHMS.actions.voidCharge(id); });
    evt.charges = [];
    if (fee > 0 && evt.reservationId) {
      evt.charges = [LHMS.actions.postCharge(evt.reservationId, {
        description: "Cancellation fee — " + evt.title, department: "Events & Banqueting",
        amount: fee, qty: 1, date: bizDay(), unitPrice: fee, basePrice: evt.total,
        currency: evt.currency, serviceId: evt.hallServiceId, priceId: evt.priceId,
        listId: evt.listId, listName: evt.listName
      }).charge.id];
    }
    evt.status = "Cancelled";
    evt.cancelFee = fee;
    evt.cancelReason = reason;
    evt.cancelledAt = new Date().toISOString();
    log("cancelled a hall booking", "events",
      evt.title + " · " + reason + " · fee " + U.money(fee, evt.currency) + (evt.voidedCharges.length ? " · " + evt.voidedCharges.length + " lines voided" : ""));
    LHMS.save();
    return { ok: true, event: evt, fee: fee };
  };

  /* ---------------- laundry ---------------- */
  LHMS.actions.createLaundryOrder = function (data) {
    if (!LHMS.can("run_laundry")) return { ok: false, error: "Your role cannot take laundry orders." };
    var rows = toRows(data.items);
    var res = LHMS.get.reservation(data.reservationId);
    if (!res) return { ok: false, error: "Choose the guest the washing belongs to." };
    if (res.status !== "In-house" && res.status !== "Confirmed") {
      return { ok: false, error: "Laundry is only taken for a guest staying with us." };
    }
    var quote = LHMS.price.laundryQuote(rows, { express: !!data.express });
    if (!quote) return { ok: false, error: "Choose at least one service that is being offered." };
    var ordered = LHMS.actions.orderItems(res.id, rows, {
      category: "laundry", express: !!data.express, postedBy: actorName()
    });
    if (!ordered.ok) return ordered;
    var ref = "LY-" + ((db.laundrySeq = (db.laundrySeq || 7200) + 1));
    var orderCur = ordered.charges[0].currency || LHMS.fx.base(res.propertyId);
    var tax = LHMS.price.taxes(ordered.total, "laundry");
    var taxCharges = tax.lines.map(function (l) {
      return LHMS.actions.postCharge(res.id, {
        description: l.label + " — laundry " + ref, department: "Taxes & service",
        amount: l.amount, qty: 1, taxRuleId: l.rule.id, postedBy: "System", currency: orderCur
      }).charge;
    });
    var taxIds = taxCharges.map(function (c) { return c.id; });
    var room = LHMS.get.room(res.roomId) || {};
    var order = {
      id: U.uid("lda"), ref: ref, propertyId: res.propertyId, reservationId: res.id,
      guestId: res.guestId, roomId: res.roomId, roomNumber: room.number || "",
      express: !!data.express, status: "Received",
      // The line carries the price row it came from, exactly as the folio does.
      lines: ordered.items.map(function (it, i) {
        var q = it.quote;
        return {
          kind: "laundry", serviceId: it.svc.id, name: it.svc.name, unit: it.svc.unit, qty: it.qty,
          unitPrice: q.unit, basePrice: q.price.amount, amount: q.lines, added: q.added,
          currency: q.currency, priceId: q.price.id, listId: q.list.id, listName: q.list.name,
          chargeId: ordered.charges[i].id
        };
      }),
      taxLines: tax.lines.map(function (l) { return { ruleId: l.rule.id, label: l.label, amount: l.amount }; }),
      charges: ordered.charges.map(function (c) { return c.id; }).concat(taxIds),
      subtotal: ordered.total, tax: tax.total, total: tax.grand,
      currency: orderCur,
      // What the order is worth on the books, taken at the rate the folio it
      // sits on is kept at.
      fxRate: ordered.charges[0].fxRate,
      baseAmount: ordered.charges.concat(taxCharges).reduce(function (s, c) { return s + LHMS.fx.baseOf(c); }, 0),
      createdAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + quote.etaMins * 60000).toISOString(),
      returnedAt: null, handledBy: actorName(), notes: String(data.notes || "")
    };
    db.laundry.unshift(order);
    log("took a laundry order", "laundry",
      order.ref + " · Room " + order.roomNumber + " · " + order.lines.length + " lines · " + U.money(order.total, orderCur) + (order.express ? " · express" : ""));
    notify("Laundry collected", order.ref + " · Room " + order.roomNumber,
      order.express ? "Express — due by " + U.timeOf(order.dueAt) : "Due by " + U.timeOf(order.dueAt), "#/laundry");
    LHMS.save();
    return { ok: true, order: order, quote: quote };
  };

  LHMS.actions.setLaundryStatus = function (orderId, status) {
    if (!LHMS.can("run_laundry")) return { ok: false, error: "Your role cannot update laundry." };
    var order = LHMS.get.laundryOrder(orderId);
    if (!order) return { ok: false, error: "Order not found." };
    var to = LAUNDRY_STAGES.indexOf(status);
    if (to === -1) return { ok: false, error: "Unknown stage." };
    // Work only moves forward; stepping a finished order back would misreport
    // what the team has already handed over.
    if (to < LAUNDRY_STAGES.indexOf(order.status)) {
      return { ok: false, error: "An order cannot go back from " + order.status + "." };
    }
    if (order.status === status) return { ok: true, order: order };
    order.status = status;
    if (status === "Collected") order.returnedAt = new Date().toISOString();
    if (status === "Ready") {
      notify("Laundry ready", order.ref + " · Room " + order.roomNumber, "Deliver or invite collection", "#/laundry");
    }
    log("moved a laundry order to " + status.toLowerCase(), "laundry", order.ref + " · Room " + order.roomNumber);
    LHMS.save();
    return { ok: true, order: order };
  };

  LHMS.actions.voidCharge = function (chargeId) {
    var c = db.charges.find(function (x) { return x.id === chargeId; });
    if (!c) return { ok: false };
    var sealed = closedDay(c.date);
    if (sealed) return { ok: false, error: sealed };
    c.voided = true;
    c.voidedBy = actorName();
    // Voiding a redemption takes the credit off the folio, so the points have
    // to go back to the guest or the credit is free money.
    if (c.department === "Loyalty" && c.points) {
      var res = LHMS.get.reservation(c.reservationId);
      var g = res && LHMS.get.guest(res.guestId);
      if (g) g.loyaltyPoints = (g.loyaltyPoints || 0) + c.points;
    }
    log("voided a charge", "folio", U.money(c.amount, c.currency) + " · " + c.description);
    LHMS.save();
    return { ok: true };
  };

  LHMS.actions.takePayment = function (resId, data) {
    var res = LHMS.get.reservation(resId);
    if (!res) return { ok: false, error: "Reservation not found." };
    var amount = Number(data.amount);
    if (!amount || amount <= 0) return { ok: false, error: "Enter a payment amount greater than zero." };
    var stamp = folioStamp(resId, amount, data.currency || folioCode(resId),
      { propertyId: res.propertyId, date: data.date || bizDay() });
    if (stamp.error) return { ok: false, error: stamp.error };
    var p = Object.assign({
      id: U.uid("pay"), reservationId: resId, date: data.date || bizDay(), method: data.method || "Card",
      amount: Math.round(amount), reference: data.reference || "TX" + Math.floor(100000 + Math.random() * 899999),
      takenBy: data.takenBy || actorName()
    }, stamp.fields);
    db.payments.push(p);
    log("took a payment", "folio", U.money(p.amount, p.currency) + " · " + p.method + " · " + res.reference);
    LHMS.save();
    return { ok: true, payment: p };
  };

  /* ---------------- invoices, receipts and refunds ---------------- */
  // A document is raised from what was owed at that moment. The lines are
  // copied, so re-pricing a service or voiding a charge later cannot rewrite an
  // invoice a guest is already holding.
  function invoiceLinesFromCharges(ch) {
    return ch.map(function (c) {
      return {
        chargeId: c.id, date: c.date, description: c.description, department: c.department,
        qty: c.qty || 1, unitPrice: c.unitPrice || c.amount, amount: c.amount,
        priceId: c.priceId || null, listId: c.listId || null, listName: c.listName || null,
        currency: c.currency || "NGN"
      };
    });
  }

  function invoiceLinesFromEvent(evt) {
    return evt.lines.map(function (l) {
      return {
        date: evt.date, description: (l.qty > 1 ? l.qty + " × " : "") + l.name + " — " + evt.title,
        department: "Events & Banqueting", qty: l.qty, unitPrice: l.unitPrice, amount: l.amount,
        priceId: l.priceId, listId: l.listId, listName: l.listName, currency: l.currency || "NGN"
      };
    }).concat((evt.taxLines || []).map(function (t) {
      return { date: evt.date, description: t.label, department: "Taxes & service", qty: 1, unitPrice: t.amount, amount: t.amount, currency: evt.currency };
    }));
  }

  LHMS.actions.raiseInvoice = function (data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot raise invoices." };
    data = data || {};
    var res = data.reservationId ? LHMS.get.reservation(data.reservationId) : null;
    var evt = data.eventId ? LHMS.get.event(data.eventId) : null;
    if (data.reservationId && !res) return { ok: false, error: "Reservation not found." };
    if (data.eventId && !evt) return { ok: false, error: "Booking not found." };
    if (!res && !evt) return { ok: false, error: "Name a folio or a booking to invoice." };
    var lines;
    if (res) {
      lines = invoiceLinesFromCharges(LHMS.unbilledCharges(res.id));
      if (!lines.length) return { ok: false, error: "Every charge on " + res.reference + " is already invoiced." };
    } else {
      if (evt.reservationId) return { ok: false, error: "That booking is billed on " + (LHMS.get.reservation(evt.reservationId) || {}).reference + " — invoice the folio instead." };
      lines = invoiceLinesFromEvent(evt);
      if (!lines.length) return { ok: false, error: "The booking has no priced lines to invoice." };
    }
    var propertyId = (res || evt).propertyId;
    var fin = LHMS.financeSettings(propertyId);
    var today = bizDay();
    var cur = oneCurrency(lines, { propertyId: propertyId });
    if (cur.error) return { ok: false, error: cur.error };
    var blocked = LHMS.fx.gate(cur.code, { propertyId: propertyId, date: today });
    if (blocked) return { ok: false, error: blocked.error };
    // A foreign document pins the rate it was raised at, and every line and
    // payment on it converts at that figure — not at tomorrow's fixing.
    var rate = cur.code === LHMS.fx.base(propertyId) ? null : LHMS.fx.state(cur.code, { propertyId: propertyId, date: today }).rate;
    if (rate) lines.forEach(function (l) { Object.assign(l, pinnedStamp(l.amount, cur.code, rate)); });
    var inv = {
      id: U.uid("inv"), number: nextInvoiceNumber(propertyId),
      propertyId: propertyId, kind: res ? "folio" : "event", entityId: res ? res.id : evt.id,
      reservationId: res ? res.id : null, guestId: res ? res.guestId : null,
      title: res ? (LHMS.get.guest(res.guestId) || {}).name + " · " + res.reference : evt.title,
      date: today, dueDate: data.dueDate || U.addDays(today, fin.paymentDays),
      currency: cur.code, fxRate: rate || undefined, lines: lines, adjustments: [], status: "Open",
      raisedBy: actorName(), raisedAt: new Date().toISOString(), notes: data.notes || ""
    };
    db.invoices.push(inv);
    lines.forEach(function (l) {
      if (!l.chargeId) return;
      var c = byId(db.charges, l.chargeId);
      if (c) c.invoiceId = inv.id;
    });
    var t = LHMS.invoiceMoney(inv);
    inv.status = t.status;
    log("raised an invoice", "invoice", inv.number + " · " + U.money(t.total, inv.currency) + " · " + inv.title);
    LHMS.save();
    return { ok: true, invoice: inv, totals: t };
  };

  // Payment, discount, refund and void each recompute from the records, so the
  // status on the document can never run ahead of the money.
  function settle(inv) {
    var t = LHMS.invoiceMoney(inv);
    inv.status = t.status;
    return t;
  }

  // Money that belongs to a document is worth what the document says it is
  // worth: it converts at the rate pinned on the document, never at a later
  // fixing. A base-currency document needs no fields at all.
  function docStamp(inv, amount) {
    return pinnedStamp(amount, inv.currency, inv.fxRate);
  }
  function docBase(inv, amount) {
    var f = docStamp(inv, amount);
    return f.baseAmount === undefined ? Math.round(Number(amount) || 0) : f.baseAmount;
  }

  LHMS.actions.payInvoice = function (invoiceId, data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot record invoice payments." };
    var inv = LHMS.get.invoice(invoiceId);
    if (!inv) return { ok: false, error: "Invoice not found." };
    if (inv.status === "Void") return { ok: false, error: "A void invoice cannot take payment." };
    var amount = Math.round(Number(data.amount));
    if (!amount || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
    var t = LHMS.invoiceMoney(inv);
    if (amount > t.balance) return { ok: false, error: "Only " + U.money(t.balance, inv.currency) + " is outstanding on this invoice." };
    var sealed = closedDay(data.date || bizDay());
    if (sealed) return { ok: false, error: sealed };
    var p = {
      id: U.uid("pay"), reservationId: inv.reservationId, invoiceId: inv.id,
      date: data.date || bizDay(), method: data.method || "Card", amount: amount,
      reference: "TX" + Math.floor(100000 + Math.random() * 899999),
      receipt: inv.number + "-" + (LHMS.invoicePayments(inv.id).length + 1),
      takenBy: actorName(), reconciled: !!data.reconciled
    };
    Object.assign(p, docStamp(inv, amount));
    db.payments.push(p);
    var after = settle(inv);
    log("recorded an invoice payment", "invoice", inv.number + " · " + U.money(amount, inv.currency) + " · " + p.method + " · receipt " + p.reference);
    LHMS.save();
    return { ok: true, payment: p, totals: after, invoice: inv };
  };

  function applyRefund(inv, data) {
    var amount = Math.round(Number(data.amount));
    var sealed = closedDay(data.date || bizDay());
    if (sealed) return { ok: false, error: sealed };
    var r = {
      id: U.uid("rfd"), invoiceId: inv.id, reservationId: inv.reservationId, amount: amount,
      date: data.date || bizDay(), method: data.method || "Bank transfer",
      reason: data.reason, reference: "RF" + Math.floor(100000 + Math.random() * 899999),
      by: actorName(), at: new Date().toISOString()
    };
    Object.assign(r, docStamp(inv, amount));
    db.refunds.push(r);
    // The original payment stays exactly as it was: the refund is its own
    // transaction, which is what lets both sides be audited later.
    var after = settle(inv);
    log("issued a refund", "invoice", inv.number + " · " + U.money(amount, inv.currency) + " · " + data.reason);
    LHMS.save();
    return { ok: true, refund: r, totals: after, invoice: inv };
  }

  // Handing back more money than the property lets one person authorise waits
  // for a second signature; the refund is not pushed to the ledger yet.
  LHMS.actions.refundInvoice = function (invoiceId, data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot issue refunds." };
    var inv = LHMS.get.invoice(invoiceId);
    if (!inv) return { ok: false, error: "Invoice not found." };
    if (!data.reason) return { ok: false, error: "A refund needs a reason for the audit trail." };
    var amount = Math.round(Number(data.amount));
    if (!amount || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
    var t = LHMS.invoiceMoney(inv);
    if (amount > t.settled) return { ok: false, error: "Only " + U.money(t.settled, inv.currency) + " has actually been received against this invoice." };
    // The limit is a base-currency figure, so a dollar refund is judged on what
    // it hands back in the property's own money.
    var move = docBase(inv, amount);
    if (move > LHMS.financeSettings(inv.propertyId).approvalAmount && !LHMS.movesMoneyAlone())
      return { ok: true, queued: queueApproval({
        kind: "refund", subject: inv.number + " · " + inv.title, subjectId: inv.id,
        change: { invoiceId: inv.id, data: data }, amount: move, from: 0, to: amount,
        // The limit is judged in the books' money; the figure handed back is the
        // invoice's own.
        toCurrency: inv.currency,
        reason: data.reason
      }) };
    return applyRefund(inv, data);
  };

  function applyDiscount(inv, data) {
    var amount = Math.round(Number(data.amount));
    var adj = {
      id: U.uid("adj"), label: data.label || "Approved adjustment", amount: -amount, reason: data.reason,
      by: actorName(), at: new Date().toISOString()
    };
    // A negative line still needs its base figure, or the reduction would be
    // missing from every total the books keep.
    var f = docStamp(inv, -amount);
    if (f.baseAmount !== undefined) adj.baseAmount = -Math.abs(f.baseAmount);
    inv.adjustments.push(adj);
    var after = settle(inv);
    log("adjusted an invoice", "invoice", inv.number + " · " + U.money(-amount, inv.currency) + " · " + data.reason);
    LHMS.save();
    return { ok: true, totals: after, invoice: inv };
  }

  // Discounts are judged as a share of the invoice, not as a figure: ₦200,000 off
  // a two-night folio is a different act from ₦200,000 off a conference bill.
  LHMS.actions.discountInvoice = function (invoiceId, data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot adjust invoices." };
    var inv = LHMS.get.invoice(invoiceId);
    if (!inv) return { ok: false, error: "Invoice not found." };
    if (inv.status === "Void") return { ok: false, error: "A void invoice cannot be adjusted." };
    if (!data.reason) return { ok: false, error: "An adjustment needs a reason for the audit trail." };
    var amount = Math.round(Number(data.amount));
    if (!amount || amount <= 0) return { ok: false, error: "Enter an amount greater than zero." };
    var t = LHMS.invoiceMoney(inv);
    if (amount > t.total) return { ok: false, error: "An adjustment cannot exceed the invoiced total." };
    if (amount / t.total * 100 > LHMS.financeSettings().discountPct && !LHMS.movesMoneyAlone())
      return { ok: true, queued: queueApproval({
        kind: "discount", subject: inv.number + " · " + inv.title, subjectId: inv.id,
        change: { invoiceId: inv.id, data: data }, amount: amount, from: 0, to: amount,
        // A discount is gated on its share of the document, so its figure stays
        // in the money the document is billed in.
        currency: inv.currency,
        reason: data.reason
      }) };
    return applyDiscount(inv, data);
  };

  LHMS.actions.splitInvoice = function (invoiceId, data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot split invoices." };
    var inv = LHMS.get.invoice(invoiceId);
    if (!inv) return { ok: false, error: "Invoice not found." };
    if (inv.status === "Void") return { ok: false, error: "A void invoice cannot be split." };
    var t = LHMS.invoiceMoney(inv);
    if (t.settled) return { ok: false, error: "Refund the " + U.money(t.settled, inv.currency) + " received before splitting — money cannot follow a line yet." };
    var keys = {};
    (data.indexes || []).forEach(function (i) { keys[i] = true; });
    (data.chargeIds || []).forEach(function (cid) { keys[cid] = true; });
    var moved = [], kept = [];
    inv.lines.forEach(function (l, i) {
      (keys[i] || keys[l.chargeId] ? moved : kept).push(l);
    });
    if (!moved.length || !kept.length) return { ok: false, error: "A split needs lines on both sides." };
    var second = Object.assign({}, inv, {
      id: U.uid("inv"), number: nextInvoiceNumber(inv.propertyId),
      lines: moved, adjustments: [], status: "Open",
      raisedBy: actorName(), raisedAt: new Date().toISOString(), notes: data.notes || "Split from " + inv.number
    });
    inv.lines = kept;
    db.invoices.push(second);
    moved.forEach(function (l) {
      if (l.chargeId) { var c = byId(db.charges, l.chargeId); if (c) c.invoiceId = second.id; }
    });
    settle(inv); settle(second);
    log("split an invoice", "invoice", inv.number + " → " + second.number + " · " + moved.length + " lines");
    LHMS.save();
    return { ok: true, original: inv, split: second };
  };

  LHMS.actions.voidInvoice = function (invoiceId, data) {
    if (!LHMS.can("manage_billing")) return { ok: false, error: "Your role cannot void invoices." };
    var inv = LHMS.get.invoice(invoiceId);
    if (!inv) return { ok: false, error: "Invoice not found." };
    if (inv.status === "Void") return { ok: false, error: "This invoice is already void." };
    if (!data.reason) return { ok: false, error: "A void needs a reason for the audit trail." };
    var t = LHMS.invoiceMoney(inv);
    if (t.settled) return { ok: false, error: "Refund " + U.money(t.settled, inv.currency) + " first — money on file cannot be hidden by a void." };
    inv.status = "Void";
    inv.voidedBy = actorName(); inv.voidReason = data.reason;
    inv.voidedAt = new Date().toISOString();
    // The charges go back on the shelf so the desk can raise a corrected
    // document; the voided invoice and its history stay untouched.
    db.charges.forEach(function (c) { if (c.invoiceId === inv.id) delete c.invoiceId; });
    log("voided an invoice", "invoice", inv.number + " · " + U.money(t.total, inv.currency) + " · " + data.reason);
    LHMS.save();
    return { ok: true, invoice: inv };
  };

  LHMS.actions.setPaymentReconciled = function (paymentId, reconciled) {
    if (!LHMS.can("take_payments")) return { ok: false, error: "Your role cannot reconcile payments." };
    var p = byId(db.payments, paymentId);
    if (!p) return { ok: false };
    p.reconciled = !!reconciled;
    p.reconciledBy = actorName();
    log(p.reconciled ? "reconciled a payment" : "unmatched a payment", "folio",
      U.money(p.amount, p.currency) + " · " + (p.receipt || p.reference) + " · " + p.method);
    LHMS.save();
    return { ok: true, payment: p };
  };

  /* ---------------- operating expenses ---------------- */
  // Recording and approval are two different hands: the person who raises a
  // cost cannot be the one who lets it into the result.
  LHMS.actions.addExpense = function (data) {
    if (!LHMS.can("record_expenses")) return { ok: false, error: "Your role cannot record expenses." };
    data = data || {};
    var amount = Math.round(Number(data.amount));
    if (!amount || amount <= 0) return { ok: false, error: "Enter a cost greater than zero." };
    if (!String(data.description || "").trim()) return { ok: false, error: "Describe what the money bought." };
    if (LHMS.EXPENSE_CATEGORIES.indexOf(data.category) === -1) return { ok: false, error: "Choose an expense category." };
    var day = bizDay();
    var date = data.date || day;
    if (date > day) return { ok: false, error: "A cost cannot be dated in the future." };
    var sealed = closedDay(date);
    if (sealed) return { ok: false, error: sealed };
    var cur = String(data.currency || LHMS.fx.base()).toUpperCase();
    var read = { propertyId: session.propertyId, date: date };
    var blocked = LHMS.fx.gate(cur, read);
    if (blocked) return { ok: false, error: blocked.error };
    var stamp = currencyStamp(amount, cur, read);
    if (stamp.error) return { ok: false, error: stamp.error };
    // The ceiling on a line is written in the property's own money, so a foreign
    // invoice from a supplier is measured by what it costs here.
    if (stamp.base > 500000000) return { ok: false, error: "A single line above " + U.money(500000000, LHMS.fx.base()) +
      " needs the group office, not this form." };
    var e = {
      id: U.uid("exp"), propertyId: session.propertyId, date: date, category: data.category,
      description: String(data.description).trim(), amount: amount, currency: cur,
      method: data.method || "Transfer", payee: String(data.payee || "").trim() || "Unspecified supplier",
      attachment: String(data.attachment || "").trim() || null,
      recordedBy: actorName(), recordedAt: new Date().toISOString(),
      status: "Pending", decidedBy: null, decidedAt: null, decisionNote: null
    };
    Object.assign(e, stamp.fields);
    db.expenses.push(e);
    log("recorded an expense", "expense", e.category + " · " + U.money(e.amount, e.currency) + " · " + e.payee + " · awaiting approval");
    LHMS.save();
    return { ok: true, expense: e };
  };

  // A decision is final. Correcting a cost means recording a new line, so the
  // ledger keeps every version of what someone approved.
  LHMS.actions.decideExpense = function (expenseId, approve, note) {
    if (!LHMS.can("approve_expenses")) return { ok: false, error: "Your role cannot approve expenses." };
    var e = byId(db.expenses, expenseId);
    if (!e) return { ok: false, error: "Expense not found." };
    if (e.status !== "Pending") return { ok: false, error: "This line was already " + e.status.toLowerCase() + " by " + e.decidedBy + "." };
    e.status = approve ? "Approved" : "Rejected";
    e.decidedBy = actorName();
    e.decidedAt = new Date().toISOString();
    e.decisionNote = note ? String(note).trim() : null;
    log(approve ? "approved an expense" : "rejected an expense", "expense",
      e.category + " · " + U.money(e.amount, e.currency) + " · " + e.payee + (note ? " · " + note : ""));
    LHMS.save();
    return { ok: true, expense: e };
  };

  LHMS.actions.setRoomStatus = function (roomId, status, reason) {
    var room = LHMS.get.room(roomId);
    if (!room) return { ok: false };
    var active = LHMS.activeResForRoom(roomId);
    room.hk = status;
    room.oooReason = status === "Out of order" || status === "Out of service" ? (reason || "Maintenance") : "";
    log("updated room status", "room", "Room " + room.number + " → " + status + (active ? " (guest in house)" : ""));
    notify("Room status changed", "Room " + room.number + " is now " + status, reason || "Updated by " + actorName(), "#/room-map");
    LHMS.save();
    return { ok: true, room: room };
  };

  LHMS.actions.createTask = function (data) {
    var t = {
      id: U.uid("tsk"), propertyId: data.propertyId || session.propertyId,
      type: data.type || "Guest request", title: data.title,
      detail: data.detail || "", roomId: data.roomId || null, guestId: data.guestId || null,
      assignedTo: data.assignedTo || null, priority: data.priority || "Normal",
      status: "Open", createdAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + (Number(data.slaMins) || 45) * 60000).toISOString(),
      slaMins: Number(data.slaMins) || 45, resolvedAt: null, source: data.source || session.role || "Front desk"
    };
    db.tasks.unshift(t);
    log("assigned a task", "task", t.title, t.propertyId);
    LHMS.save();
    return t;
  };

  LHMS.actions.updateTask = function (taskId, patch) {
    var t = LHMS.get.task(taskId);
    if (!t) return;
    Object.keys(patch).forEach(function (k) { t[k] = patch[k]; });
    if (patch.status === "Done") t.resolvedAt = new Date().toISOString();
    log(patch.status === "Done" ? "completed a task" : "updated a task", "task", t.title);
    LHMS.save();
    return t;
  };

  LHMS.actions.completeTask = function (taskId) {
    var t = LHMS.get.task(taskId);
    if (!t) return;
    t.status = "Done";
    t.resolvedAt = new Date().toISOString();
    if (t.type === "Housekeeping" || t.type === "Departure clean" || t.type === "Inspection") {
      var room = LHMS.get.room(t.roomId);
      if (room && room.hk !== "Out of order" && room.hk !== "Out of service") {
        room.hk = t.type === "Inspection" ? "Inspected" : "Clean";
      }
    }
    log("completed a task", "task", t.title);
    LHMS.save();
    return t;
  };

  LHMS.actions.createRequest = function (data) {
    var t = LHMS.actions.createTask(Object.assign({ type: "Guest request", slaMins: 30, source: "Guest app" }, data));
    if (t.source === "Guest app") {
      var room = LHMS.get.room(t.roomId);
      notify("Guest request", t.title, (room ? "Room " + room.number + " · " : "") + "guest app · respond within " + t.slaMins + " min", "#/requests");
      LHMS.save();
    }
    return t;
  };

  LHMS.actions.replyReview = function (reviewId, text) {
    var r = LHMS.get.review(reviewId);
    if (!r) return;
    r.responded = true;
    r.response = text;
    log("responded to a review", "review", r.title);
    LHMS.save();
    return r;
  };

  LHMS.actions.markNotification = function (id, read) {
    var n = db.notifications.find(function (x) { return x.id === id; });
    if (n) { n.read = read === undefined ? true : read; LHMS.save(); }
  };
  LHMS.actions.markAllNotifications = function () {
    db.notifications.forEach(function (n) { n.read = true; });
    log("cleared notifications", "notification", db.notifications.length + " notifications marked read");
    LHMS.save();
  };

  // How much live money a property's books already hold. The settings page shows
  // this count and saveSettings refuses on it — one rule, counted in one place.
  // A charge or a payment reaches a property through the stay it belongs to, or
  // through the document it settles when the money never belonged to a stay; a
  // cost names its own. Documents are not counted because their money is already
  // on the folio as the charges they bill.
  LHMS.moneyRecordsOnFile = function (pid) {
    var resProp = {}, invProp = {};
    db.reservations.forEach(function (r) { resProp[r.id] = r.propertyId; });
    db.invoices.forEach(function (i) { invProp[i.id] = i.propertyId; });
    return db.charges.concat(db.payments, db.invoices, db.expenses).filter(function (r) {
      var at = !pid || (r.propertyId || resProp[r.reservationId] || invProp[r.invoiceId] || null) === pid;
      return at && !r.voided && !r.reversed && (Number(r.amount) || 0) !== 0;
    }).length;
  };

  var POLICY_FIELDS = ["depositPct", "checkInTime", "checkOutTime", "currency", "language", "overbooking", "cancellation"];
  var LANGUAGES = ["English (UK)", "English (US)", "French"];
  // Two digits, a colon and two digits is a shape, not a clock: 25:00 would be
  // written onto the confirmation a guest reads.
  var isHHMM = function (v) {
    var m = /^(\d{2}):(\d{2})$/.exec(String(v));
    return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
  };

  /**
   * The commercial policies a stay is booked under. The money of account is what
   * every stored figure on these books means, so it stops being a free choice the
   * moment the ledger holds money, and the bounds the form's own inputs carry are
   * checked here too. The API's settings door is a port of this function.
   */
  LHMS.actions.saveSettings = function (pid, patch) {
    var s = db.settings[pid];
    if (!s) return { ok: false, error: "Property settings not found." };
    patch = patch || {};
    if (patch.depositPct !== undefined) {
      var dp = Number(patch.depositPct);
      if (dp % 1 !== 0) return { ok: false, error: "A deposit is a whole percentage." };
      if (dp < 0) return { ok: false, error: "A deposit cannot be negative." };
      if (dp > 100) return { ok: false, error: "A deposit cannot be more than the stay." };
    }
    if (patch.overbooking !== undefined) {
      var ob = Number(patch.overbooking);
      if (ob % 1 !== 0) return { ok: false, error: "An overbooking allowance is a whole room." };
      if (ob < 0) return { ok: false, error: "An allowance cannot be negative." };
      if (ob > 10) return { ok: false, error: "Ten rooms is the most an allowance may hold." };
    }
    if (patch.checkInTime !== undefined && !isHHMM(patch.checkInTime)) return { ok: false, error: "Arrival and departure times are written as HH:MM." };
    if (patch.checkOutTime !== undefined && !isHHMM(patch.checkOutTime)) return { ok: false, error: "Arrival and departure times are written as HH:MM." };
    if (patch.currency !== undefined && LHMS.fx.codes.indexOf(patch.currency) === -1) {
      return { ok: false, error: "This property holds money in " + LHMS.fx.codes.join(", ") + ". " + patch.currency + " is not among them." };
    }
    if (patch.language !== undefined && LANGUAGES.indexOf(patch.language) === -1) {
      return { ok: false, error: "The desk writes in English (UK), English (US) or French." };
    }
    if (patch.cancellation !== undefined && !String(patch.cancellation).trim()) return { ok: false, error: "Write the cancellation terms the guest is shown." };
    if (patch.cancellation !== undefined && String(patch.cancellation).length > 400) return { ok: false, error: "The cancellation terms have to fit on the confirmation." };

    var unknown = Object.keys(patch).filter(function (k) { return POLICY_FIELDS.indexOf(k) === -1; });
    if (unknown.length) return { ok: false, error: "The policies form does not carry " + unknown.join(", ") + "." };
    var wanted = POLICY_FIELDS.filter(function (k) { return patch[k] !== undefined; });
    if (!wanted.length) return { ok: false, error: "Nothing to update." };

    // The money of account is what every base figure on these books means. Move
    // it once money is on file and every stored baseAmount — and every total
    // built from it — silently starts counting a currency the property no longer
    // keeps, so the switch is only allowed while the ledger is empty.
    if (patch.currency && patch.currency !== s.currency) {
      var held = LHMS.moneyRecordsOnFile(pid);
      if (held) {
        return { ok: false, error: "This property keeps its books in " + s.currency + " and " + held +
          " money records are already valued in it. Switching to " + patch.currency + " would leave every " +
          "one of them counting " + s.currency + " without saying so. Settle the folios and raise no more " +
          "documents, or open the second currency as a rate on the " + s.currency + " books instead." };
      }
    }

    // Only a term whose value actually differs is named, so a page that posts its
    // whole form back cannot leave a trail claiming a change that never happened.
    var text = function (v) { return String(v === undefined || v === null ? "" : v); };
    var num = function (v) { return (v === undefined || v === null || isNaN(Number(v))) ? "" : String(Number(v)); };
    var changed = [];
    var move = function (key, label, fmt) {
      if (wanted.indexOf(key) === -1) return;
      if (fmt(s[key]) === fmt(patch[key])) return;
      changed.push(label + " " + (fmt(s[key]) || "unset") + " → " + fmt(patch[key]));
    };
    move("depositPct", "deposit", function (v) { return num(v) === "" ? "" : num(v) + "%"; });
    move("checkInTime", "check-in", text);
    move("checkOutTime", "check-out", text);
    move("currency", "money of account", text);
    move("language", "language", text);
    move("overbooking", "overbooking allowance", num);
    move("cancellation", "cancellation", function (v) { return text(v) === "" ? "" : '"' + text(v) + '"'; });

    wanted.forEach(function (k) { s[k] = patch[k]; });
    log("updated hotel settings", "settings",
      LHMS.get.property(pid).name + " · " + (changed.length ? changed.join(" · ") : "nothing moved"));
    LHMS.save();
    return { ok: true, settings: s, changed: changed };
  };

  var BRAND_KEYS = ["brandName", "tagline", "logo", "images", "palette", "useColors"];
  function isImageData(v) {
    return typeof v === "string" && /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v);
  }
  function isHexColour(v) { return typeof v === "string" && /^#[0-9a-f]{6}$/i.test(v); }

  /**
   * The hotel's brand — the name, line, logo, gallery and the palette read from
   * that logo. The bounds are the ones the uploader enforces, because a browser
   * has one storage budget for the ledger and the pictures, and the trail names
   * the parts that moved rather than the page they were saved from. The API's
   * branding door is a port of this function.
   */
  LHMS.actions.saveBranding = function (pid, patch) {
    var s = db.settings[pid];
    if (!s) return { ok: false, error: "Property settings not found." };
    patch = patch || {};

    var unknown = Object.keys(patch).filter(function (k) { return BRAND_KEYS.indexOf(k) === -1; });
    if (unknown.length) return { ok: false, error: "The brand form does not carry " + unknown.join(", ") + "." };
    var wanted = BRAND_KEYS.filter(function (k) { return patch[k] !== undefined; });
    if (!wanted.length) return { ok: false, error: "Nothing to update." };

    if (patch.brandName !== undefined) {
      if (typeof patch.brandName !== "string" || !patch.brandName.trim()) {
        return { ok: false, error: "Give the hotel a name the sign-in page can show." };
      }
      if (patch.brandName.trim().length > 60) return { ok: false, error: "Keep the name under 60 characters." };
    }
    if (patch.tagline !== undefined) {
      if (typeof patch.tagline !== "string") return { ok: false, error: "Write the tagline as a line of text." };
      if (patch.tagline.trim().length > 90) return { ok: false, error: "Keep the tagline under 90 characters." };
    }

    var limits = LHMS.BRAND_LIMITS;
    if (patch.logo !== undefined) {
      if (typeof patch.logo !== "string") return { ok: false, error: "A logo is an image file." };
      if (patch.logo && !isImageData(patch.logo)) return { ok: false, error: "A logo is a PNG, JPEG, WebP or SVG image." };
      if (patch.logo.length > limits.maxLogoChars) return { ok: false, error: "The logo is too large. Choose a smaller image." };
    }
    if (patch.images !== undefined) {
      if (!Array.isArray(patch.images)) return { ok: false, error: "The gallery is a list of images." };
      if (patch.images.length > limits.maxImages) return { ok: false, error: "Six images is the most the gallery holds." };
      for (var i = 0; i < patch.images.length; i++) {
        var img = patch.images[i];
        if (!img || typeof img !== "object" || typeof img.src !== "string" || !isImageData(img.src)) {
          return { ok: false, error: "Each gallery image is a PNG, JPEG, WebP or SVG file." };
        }
        if (img.src.length > limits.maxImageChars) return { ok: false, error: "One of those images is too large. Choose a smaller one." };
        if (img.name !== undefined && (typeof img.name !== "string" || img.name.length > 80)) {
          return { ok: false, error: "An image name has to fit in 80 characters." };
        }
      }
    }
    if (patch.palette !== undefined && patch.palette !== null) {
      if (!Array.isArray(patch.palette) || patch.palette.length < 1 || patch.palette.length > 8) {
        return { ok: false, error: "A palette carries between one and eight colours." };
      }
      if (patch.palette.some(function (c) { return !isHexColour(c); })) {
        return { ok: false, error: "A palette colour is written as #rrggbb." };
      }
    }
    if (patch.useColors !== undefined && typeof patch.useColors !== "boolean") {
      return { ok: false, error: "The colour switch is on or off." };
    }

    var before = LHMS.get.branding(pid);
    var next = {
      brandName: before.brandName, tagline: before.tagline, logo: before.logo,
      images: before.images.map(function (x) { return { src: x.src, name: x.name }; }),
      palette: before.palette ? before.palette.slice() : null,
      useColors: before.useColors
    };
    if (patch.brandName !== undefined) next.brandName = patch.brandName.trim();
    if (patch.tagline !== undefined) next.tagline = patch.tagline.trim();
    if (patch.logo !== undefined) next.logo = patch.logo;
    if (patch.images !== undefined) {
      next.images = patch.images.map(function (x) { return { src: x.src, name: typeof x.name === "string" ? x.name : "" }; });
    }
    if (patch.palette !== undefined) next.palette = patch.palette === null ? null : patch.palette.slice();
    if (patch.useColors !== undefined) next.useColors = patch.useColors;

    // The ledger and the pictures share one browser budget; a gallery that
    // quietly pushes the books out of storage is worse than a refused upload.
    var total = (next.logo || "").length + next.images.reduce(function (n, x) { return n + x.src.length; }, 0);
    if (total > limits.maxTotalChars) {
      return { ok: false, error: "That is more image than this browser can keep. Remove a picture or choose smaller files." };
    }

    // Only a part whose value actually differs is named, so re-saving the tab
    // cannot leave a trail claiming a change that never happened.
    var changed = [];
    if (next.brandName !== before.brandName) changed.push("name " + before.brandName + " → " + next.brandName);
    if ((next.tagline || "") !== (before.tagline || "")) {
      changed.push("tagline " + (before.tagline ? '"' + before.tagline + '"' : "unset") +
        " → " + (next.tagline ? '"' + next.tagline + '"' : "unset"));
    }
    if (next.logo !== before.logo) changed.push(next.logo ? (before.logo ? "logo replaced" : "logo added") : "logo removed");
    if (next.images.length !== before.images.length) changed.push("images " + before.images.length + " → " + next.images.length);
    if (JSON.stringify(next.palette) !== JSON.stringify(before.palette)) {
      changed.push(next.palette ? "logo palette applied" : "logo palette cleared");
    }
    if (next.useColors !== before.useColors) {
      changed.push(next.useColors ? "system colours follow the logo" : "system colours returned to default");
    }

    next.updatedAt = changed.length ? new Date().toISOString() : (before.updatedAt || null);
    next.updatedBy = changed.length ? actorName() : (before.updatedBy || null);
    s.branding = next;
    log("updated the hotel brand", "hotel brand",
      LHMS.get.property(pid).name + " · " + (changed.length ? changed.join(" · ") : "nothing moved"));
    LHMS.save();
    return { ok: true, branding: LHMS.get.branding(pid), changed: changed };
  };

  LHMS.actions.updateRate = function (typeId, rate, reason) {
    var svc = LHMS.price.forRef("room", typeId);
    if (!svc) return { ok: false, error: "Room type not found." };
    var row = LHMS.price.baseRow(svc.id);
    if (!row) return { ok: false, error: "No price on the standard list for this room type." };
    return LHMS.actions.setPrice(row.id, { amount: rate }, reason || "Rate & inventory adjustment");
  };

  /**
   * The commercial terms a stay is booked on. A plan is no decoration: its
   * modifier multiplies every room sold on it and its deposit is the share of the
   * stay taken before a guest arrives, so the bounds the form's own inputs carry
   * are checked here as well, the edit needs a reason, and the trail names every
   * figure that moved. The API's plan door is a port of this function.
   */
  LHMS.actions.updatePlan = function (planId, patch, reason) {
    if (!LHMS.can("manage_rates")) return { ok: false, error: "Your role cannot change rate plans." };
    patch = patch || {};
    if (patch.modifier !== undefined) {
      var m = Number(patch.modifier);
      if (!(m >= 0.5)) return { ok: false, error: "A modifier below 0.50 is not a rate plan." };
      if (m > 2) return { ok: false, error: "A plan cannot sell above twice the base rate." };
    }
    if (patch.depositPct !== undefined) {
      var dp = Number(patch.depositPct);
      if (dp % 1 !== 0) return { ok: false, error: "A deposit is a whole percentage." };
      if (dp < 0) return { ok: false, error: "A deposit cannot be negative." };
      if (dp > 100) return { ok: false, error: "A deposit cannot be more than the stay." };
    }
    if (patch.includes !== undefined && !String(patch.includes).trim()) return { ok: false, error: "Name what the plan includes." };
    if (patch.cancel !== undefined && !String(patch.cancel).trim()) return { ok: false, error: "Write the cancellation terms the guest is shown." };
    if (!String(reason === undefined ? "" : reason).trim()) return { ok: false, error: "A reason is required for the audit trail." };

    var keys = ["modifier", "depositPct", "includes", "cancel"];
    var wanted = keys.filter(function (k) { return patch[k] !== undefined; });
    if (!wanted.length) return { ok: false, error: "Nothing to update." };

    var p = LHMS.get.ratePlan(planId);
    if (!p) return { ok: false, error: "Rate plan not found." };

    // What the manager read on the screen is what the trail says: a modifier is
    // the percentage of the base rate the plan sells at. Only a term whose value
    // actually differs is named, so a form posted back whole cannot claim a change
    // that never happened.
    var pct = function (v) { return Math.round(Number(v) * 100) + "%"; };
    var text = function (v) { return String(v === undefined || v === null ? "" : v); };
    var moved = [];
    if (patch.modifier !== undefined && Number(p.modifier) !== Number(patch.modifier)) {
      moved.push("modifier " + pct(p.modifier) + " → " + pct(patch.modifier));
    }
    if (patch.depositPct !== undefined && Number(p.depositPct) !== Number(patch.depositPct)) {
      moved.push("deposit " + Number(p.depositPct) + "% → " + Number(patch.depositPct) + "%");
    }
    if (patch.includes !== undefined && text(p.includes) !== text(patch.includes)) {
      moved.push('inclusions "' + text(p.includes) + '" → "' + text(patch.includes) + '"');
    }
    if (patch.cancel !== undefined && text(p.cancel) !== text(patch.cancel)) {
      moved.push('cancellation "' + text(p.cancel) + '" → "' + text(patch.cancel) + '"');
    }

    wanted.forEach(function (k) { p[k] = patch[k]; });
    log("changed a rate plan", "rate plan",
      p.name + " · " + (moved.length ? moved.join(" · ") : "nothing moved") + " · " + reason);
    LHMS.save();
    return { ok: true, plan: p, moved: moved };
  };

  LHMS.actions.setPermission = function (role, perm, value) {
    // Manager holds every capability, the group auditor holds only the right to
    // look, and the controller's line is the separation the four-eyes gate rests
    // on — the hand that signs must not also record or ask. All three are fixed
    // by construction, so the matrix cannot be used to widen any of them.
    if (role === "Manager" || role === "Auditor" || role === "Finance Manager") {
      return { ok: false, error: role + " access is fixed and cannot be edited here." };
    }
    if (!db.permissions[role]) db.permissions[role] = {};
    db.permissions[role][perm] = !!value;
    log("updated staff permissions", "permission", role + " · " + perm + " \u2192 " + (value ? "allowed" : "blocked"));
    LHMS.save();
  };

  LHMS.actions.createLostItem = function (data) {
    db.lostFound.unshift({
      id: U.uid("lf"), propertyId: session.propertyId, item: data.item, room: data.room,
      status: "Stored", foundBy: actorName(), date: bizDay(), guestId: data.guestId || null, note: data.note || ""
    });
    log("logged a lost item", "lost & found", data.item + " · Room " + data.room);
    LHMS.save();
  };

  LHMS.actions.setLostStatus = function (id, status) {
    var l = db.lostFound.find(function (x) { return x.id === id; });
    if (!l) return;
    l.status = status;
    log("updated lost & found", "lost & found", l.item + " \u2192 " + status);
    LHMS.save();
  };

  // A connection is flipped, never set from the outside, and only for a service
  // the register actually knows: a key nobody authored would be remembered as
  // though it were one. The API's toggle door is a port of this function.
  var INTEGRATION_KEYS = ["channelManager", "paymentGateway", "doorLocks", "accounting", "crm", "whatsapp"];
  LHMS.actions.toggleIntegration = function (pid, key) {
    if (INTEGRATION_KEYS.indexOf(key) === -1) return { ok: false, error: "That service is not on the integration register." };
    var s = db.settings[pid];
    if (!s) return { ok: false, error: "Property settings not found." };
    s.integrations = Object.assign({}, s.integrations);
    s.integrations[key] = !s.integrations[key];
    var on = s.integrations[key];
    log(on ? "connected an integration" : "disconnected an integration", "integration", key);
    LHMS.save();
    return { ok: true, key: key, connected: on, integrations: s.integrations };
  };

  /* ---------------- night audit ---------------- */
  // The house runs on a business date, not on the clock. Closing the day posts
  // the room money folios are still owed, seals the totals against later
  // alteration, and rolls every selector in the app onto the next date.

  // A folio carries one room charge per night. A stay is billed night by night
  // when the guest checks in, so the audit's job is the nights nobody billed:
  // an overstay the desk never actioned, or a folio whose quote missed a night.
  // Nights already dated and live are left exactly as they stand, which is what
  // makes a second run safe instead of charging the guest twice.
  LHMS.unbilledNights = function () {
    var day = bizDay();
    var out = [];
    db.reservations.forEach(function (res) {
      if (res.status !== "In-house") return;
      var billed = {};
      db.charges.forEach(function (c) {
        if (!c.voided && c.reservationId === res.id && c.department === "Rooms") billed[c.date] = true;
      });
      for (var d = res.checkIn; d <= day; d = U.addDays(d, 1)) {
        if (billed[d]) continue;
        var q = LHMS.price.stay(res.roomTypeId, res.ratePlanId, d, U.addDays(d, 1), res.adults || 1);
        if (!q || !q.available) continue;
        out.push({ res: res, date: d, quote: q });
      }
    });
    return out;
  };

  // A night priced in a money the books cannot value has no quote at all: the
  // price read above refuses it, so it never reaches the list of nights owed and
  // a close built from that list would seal the day with the guest still owing in
  // a money nobody billed. These nights are found by asking for the price row
  // itself, before the currency gate is applied, and they stop the run.
  LHMS.unbillableNights = function () {
    var day = bizDay();
    var out = [];
    db.reservations.forEach(function (res) {
      if (res.status !== "In-house") return;
      var billed = {};
      db.charges.forEach(function (c) {
        if (!c.voided && c.reservationId === res.id && c.department === "Rooms") billed[c.date] = true;
      });
      var svc = svcOf("room", res.roomTypeId);
      if (!svc || !svc.active) return;
      for (var d = res.checkIn; d <= day; d = U.addDays(d, 1)) {
        if (billed[d]) continue;
        var hit = LHMS.price.applicable(svc.id, { date: d });
        if (!hit) continue;
        var blocked = LHMS.fx.gate(hit.price.currency, { date: d, propertyId: res.propertyId });
        if (blocked) out.push({ res: res, date: d, price: hit.price, blocked: blocked });
      }
    });
    return out;
  };

  // Everything the close screen reports and the run itself reads is computed
  // here, so the checklist a manager signs off cannot disagree with the figures
  // sealed into the pack.
  LHMS.auditPack = function () {
    var p = LHMS.get.property();
    var day = bizDay();
    var mine = {};
    LHMS.reservationsOf(p.id).forEach(function (r) { mine[r.id] = true; });
    var charges = db.charges.filter(function (c) { return !c.voided && c.date === day && mine[c.reservationId]; });
    var payments = db.payments.filter(function (x) { return x.date === day && mine[x.reservationId]; });
    var byDept = {};
    charges.forEach(function (c) { byDept[c.department] = (byDept[c.department] || 0) + LHMS.fx.baseOf(c); });
    var inHouse = LHMS.calc.inHouse(p.id);
    var pack = {
      property: p, day: day, metrics: LHMS.calc.metrics(p.id),
      charges: charges, payments: payments,
      // A pack is a set of books, so every total in it is counted in the money
      // the property keeps: a dollar payment and a naira payment only add up once
      // each is read as what it was worth on the day it moved.
      chargesTotal: charges.reduce(function (s, c) { return s + LHMS.fx.baseOf(c); }, 0),
      paymentsTotal: payments.reduce(function (s, x) { return s + LHMS.fx.baseOf(x); }, 0),
      rates: LHMS.fx.unusable({ date: day }),
      byDept: Object.keys(byDept).map(function (k) { return { name: k, amount: byDept[k] }; })
        .sort(function (a, b) { return b.amount - a.amount; }),
      arrivals: LHMS.calc.arrivals(p.id),
      departures: LHMS.calc.departures(p.id),
      inHouse: inHouse,
      noShows: LHMS.reservationsOf(p.id).filter(function (r) { return r.status === "No-show"; }),
      unresolved: inHouse.filter(function (r) { return LHMS.folio(r.id).balance > 0; }),
      dirty: LHMS.roomsOf(p.id).filter(function (r) { return r.hk === "Dirty"; }),
      ooo: LHMS.roomsOf(p.id).filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; })
    };
    pack.unbilled = LHMS.unbilledNights();
    pack.unbillable = LHMS.unbillableNights();
    pack.unbilledTotal = pack.unbilled.reduce(function (s, n) {
      var night = n.quote.nightly[0];
      // Only nights the books can value are in this list, so the sum they promise
      // is a sum of book figures — a dollar night and a naira night add up once
      // each has been read as what it was worth on the night it falls on.
      var b = LHMS.fx.toBase(night.rate + n.quote.taxes, night.currency,
        { propertyId: n.res.propertyId, date: n.date });
      return s + b.base;
    }, 0);
    return pack;
  };

  LHMS.auditChecks = function (pack) {
    pack = pack || LHMS.auditPack();
    return [
      { key: "arrivals", title: "Verify arrivals and no-shows", detail: pack.arrivals.length + " confirmed arrivals · " + pack.noShows.length + " no-shows recorded" },
      { key: "folios", title: "Review unresolved folios", detail: pack.unresolved.length + " in-house folios carry a balance" },
      {
        key: "roomtax", title: "Post room and tax",
        detail: pack.unbillable.length
          ? pack.unbillable.length + " open " + (pack.unbillable.length === 1 ? "night" : "nights") +
            " priced in " + pack.unbillable.map(function (n) { return n.price.currency; })
              .filter(function (c, i, all) { return all.indexOf(c) === i; }).join(" and ") +
            " cannot be valued — this run stops until the rate is filed"
          : pack.unbilled.length
            ? pack.unbilled.length + " unbilled " + (pack.unbilled.length === 1 ? "night" : "nights") + " worth " + U.money(pack.unbilledTotal) + " — this run posts them"
            : "Every in-house folio carries its room charge for " + U.pretty(pack.day, "short")
      },
      { key: "payments", title: "Reconcile payments", detail: U.money(pack.paymentsTotal) + " taken today across card, cash and transfer" },
      {
        key: "currency", title: "Confirm the rates the books valued in",
        detail: pack.rates.length
          ? pack.rates.map(function (r) { return r.code + " (" + r.state + ")"; }).join(", ") +
            " cannot be valued today — refresh them in Financial settings before selling or settling in them"
          : (LHMS.fx.inCatalogue().length
            ? "Every currency the catalogue sells in has a usable rate on " + U.pretty(pack.day, "short")
            : "Everything here is billed in " + LHMS.fx.base())
      },
      { key: "housekeeping", title: "Housekeeping handover", detail: pack.dirty.length + " dirty · " + pack.ooo.length + " out of order" },
      { key: "revenue", title: "Review revenue pack", detail: U.money(pack.chargesTotal) + " charges posted · ADR " + U.money(pack.metrics.adr) },
      { key: "audit", title: "Confirm audit trail and backup", detail: db.activity.length + " activity records · NDPR log retained" }
    ];
  };

  // A day is closed once an audit has been sealed on or after it: the roll moves
  // the business date forward, so anything dated behind the newest seal is history
  // and history is not editable.
  LHMS.closedOn = function (date) {
    var d = date || bizDay();
    return db.closedDays.filter(function (c) { return c.date === d; })[0] || null;
  };
  LHMS.dayIsClosed = function (date) {
    var d = date || bizDay();
    return db.closedDays.some(function (c) { return c.date >= d; });
  };

  // The answer a page gets when money is aimed at a day somebody already signed
  // for. A sealed day's totals are in the pack finance hold, so a correction has
  // to be new money on the open date, not a rewrite of the old one.
  function closedDay(date) {
    if (!LHMS.dayIsClosed(date)) return null;
    return "The business date " + U.pretty(date, "medium") + " is closed and sealed. Nothing posts into a closed day — put the correction on " +
      U.pretty(bizDay(), "medium") + " instead.";
  }

  LHMS.actions.runNightAudit = function (data) {
    if (!LHMS.can("night_audit")) return { ok: false, error: "Your role cannot close the business date." };
    var day = bizDay();
    var already = LHMS.closedOn(day);
    if (already) return { ok: false, error: U.pretty(day, "medium") + " was already closed by " + already.by + "." };
    var attest = (data && data.checks) || {};
    var outstanding = LHMS.auditChecks().filter(function (c) { return !attest[c.key]; });
    if (outstanding.length) {
      return {
        ok: false,
        error: "The day stays open until every control is confirmed — outstanding: " +
          outstanding.map(function (c) { return c.title; }).join(", ") + "."
      };
    }

    // Each open night is stamped before anything is written. A folio that cannot
    // take the money — a room account kept in another currency, a rate that has
    // gone off the air — stops the run instead of leaving the day half-billed.
    var blocked = LHMS.unbillableNights();
    if (blocked.length) {
      return { ok: false, error: "The night audit cannot post every open night — " + blocked[0].blocked.error };
    }
    var plan = LHMS.unbilledNights().map(function (n) {
      var night = n.quote.nightly[0];
      var cur = night.currency || LHMS.fx.base(n.res.propertyId);
      var opts = { propertyId: n.res.propertyId, date: n.date };
      var room = folioStamp(n.res.id, night.rate, cur, opts);
      var taxes = n.quote.taxLines.map(function (l) { return folioStamp(n.res.id, l.amount, cur, opts); });
      var bad = [room].concat(taxes).filter(function (s) { return s.error; })[0];
      return bad ? { error: bad.error } : { n: n, night: night, cur: cur, room: room, taxes: taxes };
    });
    var refused = plan.filter(function (p) { return p.error; })[0];
    if (refused) return { ok: false, error: "The night audit cannot post every open night — " + refused.error };

    var posted = [];
    plan.forEach(function (p) {
      var n = p.n, night = p.night;
      db.charges.push(Object.assign({
        id: U.uid("chg"), reservationId: n.res.id, date: n.date,
        description: "Room charge — " + n.quote.type.name + " (night audit)",
        department: "Rooms", amount: night.rate, qty: 1, postedBy: actorName(), nightAudit: true,
        unitPrice: night.rate, basePrice: night.base, extras: night.added,
        serviceId: night.serviceId, priceId: night.priceId, listId: night.listId,
        listName: night.list, currency: p.cur
      }, p.room.fields || {}));
      var base = p.room.base || night.rate;
      n.quote.taxLines.forEach(function (l, i) {
        db.charges.push(Object.assign({
          id: U.uid("chg"), reservationId: n.res.id, date: n.date, description: l.label,
          department: "Taxes & service", amount: l.amount, qty: 1,
          postedBy: "System", taxRuleId: l.rule.id, nightAudit: true
        }, p.taxes[i].fields || {}));
        base += p.taxes[i].base || l.amount;
      });
      posted.push({
        reservationId: n.res.id, reference: n.res.reference, date: n.date,
        amount: night.rate, tax: n.quote.taxes, currency: p.cur, baseAmount: base
      });
    });

    // Sealed after the posting, so the pack reports the money the audit itself
    // just found rather than the figures that were missing it.
    var pack = LHMS.auditPack();
    var m = pack.metrics;
    var closed = {
      date: day, rolledTo: U.addDays(day, 1), at: U.nowISO(), by: actorName(), checks: attest,
      posted: posted,
      // The seal counts in the money of account: a day whose rooms were sold in
      // two monies still has to hand on one set of books.
      postedTotal: posted.reduce(function (s, p) { return s + p.baseAmount; }, 0),
      stats: {
        occupancy: m.occupancy, adr: m.adr, revpar: m.revpar, roomRevenue: m.roomRevenue,
        charges: pack.chargesTotal, payments: pack.paymentsTotal, balance: m.balanceDue,
        open: pack.unresolved.length, arrivals: pack.arrivals.length, departures: pack.departures.length
      }
    };
    db.closedDays.push(closed);
    db.meta.day = closed.rolledTo;
    log("closed the day", "night audit", U.pretty(day, "medium") + " · room revenue " + U.money(m.roomRevenue) +
      " · " + posted.length + " unbilled nights posted for " + U.money(closed.postedTotal) + " · date rolled to " + U.pretty(closed.rolledTo, "short"));
    notify("Night audit", "Night audit closed for " + U.pretty(day, "medium"),
      U.money(m.roomRevenue) + " room revenue · " + posted.length + " nights posted · business date is now " + U.pretty(closed.rolledTo, "medium"),
      "#/end-of-day");
    LHMS.save();
    return { ok: true, closed: closed, posted: posted, rolledTo: closed.rolledTo };
  };

  /* ---------------- guest identity ---------------- */
  // The portal speaks for an in-house stay, and also for a confirmed arrival
  // once its check-in day has begun — digital check-in happens from inside it.
  function stayWindowHit(r, today) {
    if (r.status === "In-house") return true;
    return r.status === "Confirmed" && r.checkIn <= today && r.checkOut > today;
  }

  function inHouseFor(guestId, pid) {
    var today = bizDay();
    var list = db.reservations.filter(function (r) { return r.guestId === guestId && stayWindowHit(r, today); });
    list.sort(function (a, b) {
      if (a.status !== b.status) return a.status === "In-house" ? -1 : 1;
      return a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0;
    });
    return (pid && list.find(function (r) { return r.propertyId === pid; })) || list[0] || null;
  }

  function inHouseByName(name, pid) {
    var hit = null;
    db.guests.some(function (g) {
      if (g.name !== name) return false;
      var stay = inHouseFor(g.id, pid);
      if (stay) { hit = { guest: g, stay: stay }; return true; }
      return false;
    });
    return hit;
  }

  // gst_1 is the seeded guest the portal anchors on, used when the signed-in
  // name matches no profile of its own.
  function anchorStay(pid) {
    var today = bizDay();
    return db.reservations.find(function (r) {
      return r.guestId === "gst_1" && r.propertyId === pid && stayWindowHit(r, today);
    }) || null;
  }

  function profileByName(name) {
    return db.guests.find(function (g) { return g.name === name; }) || null;
  }

  // Which guest record is the signed-in portal user speaking for?
  // A live stay is the strongest evidence, but a guest who has nothing in house
  // is still themselves — booking and upcoming stays need an identity first.
  LHMS.resolveGuestId = function (preferredProperty) {
    if (session.role !== "Guest") return null;
    var pid = preferredProperty || session.propertyId;
    var cached = session.guestId && LHMS.get.guest(session.guestId) ? inHouseFor(session.guestId, pid) : null;
    if (cached && (!preferredProperty || cached.propertyId === preferredProperty)) return session.guestId;
    var hit = inHouseByName(session.name, pid) || inHouseByName(session.name, "agm");
    if (hit) session.guestId = hit.guest.id;
    else {
      var solo = profileByName(session.name);
      session.guestId = solo ? solo.id : null;
    }
    return session.guestId;
  };

  LHMS.bindGuestSession = function () {
    var pid = session.propertyId;
    var hit = inHouseByName(session.name, pid) || inHouseByName(session.name, "agm");
    if (hit) {
      session.guestId = hit.guest.id;
      session.propertyId = hit.stay.propertyId;
    } else {
      var solo = profileByName(session.name);
      if (solo) session.guestId = solo.id;
    }
    LHMS.persistSession();
    return LHMS.guestStay();
  };

  /* the stay the guest portal speaks for */
  LHMS.guestStay = function () {
    var gid = LHMS.resolveGuestId();
    if (gid) return inHouseFor(gid, session.propertyId);
    return anchorStay(session.propertyId) || anchorStay("agm");
  };

  LHMS.save();
})();
