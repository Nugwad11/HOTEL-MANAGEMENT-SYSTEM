/* ============================================================
   LHMS — guest-facing portal (PRD 6.14)
   Mobile experience for the in-house guest: stay dashboard,
   digital key, concierge requests, folio and personalization.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  LHMS.pages = LHMS.pages || {};
  LHMS.uiActions = LHMS.uiActions || {};
  LHMS.forms = LHMS.forms || {};

  var TABS = [
    { key: "stay", label: "Stay", icon: "home" },
    { key: "requests", label: "Requests", icon: "message" },
    { key: "folio", label: "Folio", icon: "receipt" },
    { key: "me", label: "Profile", icon: "user" }
  ];

  var SERVICES = [
    { key: "housekeeping", label: "Housekeeping", icon: "broom", sla: 45,
      title: "Housekeeping", detail: "Refresh the room, towels or amenities" },
    { key: "dining", label: "Dining", icon: "utensils", sla: 40, outlet: "out_ina",
      title: "In-room dining", detail: "Order from the restaurant menu" },
    { key: "spa", label: "Spa", icon: "sparkles", sla: 90, outlet: "out_spa",
      title: "Spa appointment", detail: "Book a treatment with the wellness team" },
    { key: "frontdesk", label: "Front desk", icon: "bell", sla: 15,
      title: "Front desk", detail: "Speak to the concierge" }
  ];

  var PREF_FIELDS = [
    { key: "pillow", label: "Pillow" },
    { key: "room", label: "Room location" },
    { key: "dietary", label: "Dietary" },
    { key: "allergies", label: "Allergies" },
    { key: "beverage", label: "Welcome beverage" },
    { key: "newspaper", label: "Newspaper" },
    { key: "turndown", label: "Turndown" }
  ];

  var state = { keyActive: false, revealed: false };

  function ui() { return LHMS.ui; }
  function util() { return LHMS.util; }

  // A figure with no money named is the books' own; anything taken off a folio,
  // a quote or a price row carries its own currency through here.
  function money(n, cur) { return util().money(n, cur); }
  // The two concierge prices on the profile card are Lagos copy — they are not
  // in the price catalogue. Elsewhere the desk quotes them on request rather
  // than dressing a naira figure in the local sign.
  function conciergePrice(prefix, naira) {
    return LHMS.fx.base() === "NGN" ? prefix + money(naira) : "Price on request";
  }
  function esc(s) { return ui().esc(s); }

  /* ---------------- identity + authorization ---------------- */
  function context() {
    var guestId = LHMS.resolveGuestId ? LHMS.resolveGuestId() : (LHMS.session.guestId || null);
    var stay = LHMS.guestStay();
    var guest = guestId ? LHMS.get.guest(guestId) : null;
    return { guestId: guestId, stay: stay, guest: guest };
  }

  function authorize(ctx) {
    ctx = ctx || context();
    if (!ctx.stay) return { ok: false, error: "We could not find an active stay for this account." };
    if (!ctx.guestId) return { ok: false, error: "Sign in with your guest account to use the portal." };
    if (ctx.stay.guestId !== ctx.guestId) {
      return { ok: false, error: "This portal is linked to a different reservation. Please ask the front desk to check you in." };
    }
    if (!ctx.guest) return { ok: false, error: "We could not load your guest profile. Please see the front desk." };
    return { ok: true, ctx: ctx };
  }

  function deny() {
    return { ok: false, error: "Only the guest in house can use this action." };
  }

  function isGuest() { return LHMS.session.role === "Guest"; }

  /* ---------------- domain actions ---------------- */
  function request(data) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var ctx = auth.ctx;
    var title = String((data && data.title) || "").trim();
    if (!title) return { ok: false, error: "Describe what you need." };
    var task = LHMS.actions.createRequest({
      title: title,
      detail: String((data && data.detail) || "").trim(),
      guestId: ctx.guestId,
      roomId: ctx.stay.roomId,
      propertyId: LHMS.session.propertyId || ctx.stay.propertyId,
      priority: (data && data.priority) || "Normal",
      slaMins: (data && data.slaMins) || 30
    });
    return { ok: true, task: task };
  }

  function checkIn(opts) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var res = auth.ctx.stay;
    if (res.status !== "Confirmed") {
      return { ok: false, error: res.status === "In-house"
        ? "You are already checked in — your key is on the Stay tab."
        : "This reservation is " + res.status.toLowerCase() + ". Please contact the front desk." };
    }
    var U = util();
    if (res.checkIn > U.today()) return { ok: false, error: "Digital check-in opens on your arrival day, " + U.pretty(res.checkIn, "short") + "." };
    var o = opts || {};
    return LHMS.actions.checkIn(res.id, { mobileKey: o.mobileKey !== false, eta: o.eta || "" });
  }

  function checkOut() {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var res = auth.ctx.stay;
    if (res.status !== "In-house") return { ok: false, error: "You are not currently checked in." };
    var folio = LHMS.folio(res.id);
    if (folio.balance > 0) {
      return { ok: false, error: "Your folio has an outstanding balance of " + money(folio.balance, folio.currency) + ". Settle it to depart." };
    }
    return LHMS.actions.checkOut(res.id, {});
  }

  // This build never touches real card data: it posts a payment against the folio
  // and leaves the settlement trail for the night auditor.
  function settle(opts) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var res = auth.ctx.stay;
    var folio = LHMS.folio(res.id);
    if (folio.balance <= 0) return { ok: false, error: "There is nothing outstanding on your folio." };
    var o = opts || {};
    if (!o.confirm) return { ok: false, error: "Confirm the charge to settle " + money(folio.balance, folio.currency) + "." };
    return LHMS.actions.takePayment(res.id, { amount: folio.balance, method: o.method || "Card", takenBy: "Guest app" });
  }

  function savePreferences(patch) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var prefs = {};
    PREF_FIELDS.forEach(function (f) {
      var v = patch && patch[f.key];
      if (v !== undefined && v !== null && String(v).trim()) prefs[f.key] = String(v).trim();
    });
    var consent = { marketing: !!(patch && patch.marketing) };
    LHMS.actions.updateGuest(auth.ctx.guestId, { preferences: prefs, consent: consent });
    return { ok: true };
  }

  /* ---------------- booking (PRD 6.14) ---------------- */
  // A booking needs an identity, not a stay — a guest with nothing in house
  // must still be able to start one.
  function bookingActor() {
    if (!isGuest()) return deny();
    var ctx = context();
    if (!ctx.guestId) return { ok: false, error: "Sign in with your guest account to make a booking." };
    if (!ctx.guest) return { ok: false, error: "We could not load your guest profile. Please see the front desk." };
    return { ok: true, ctx: ctx };
  }

  function bookingsOf(guestId) {
    return LHMS.db.reservations.filter(function (r) {
      return r.guestId === guestId && (r.status === "Confirmed" || r.status === "In-house");
    }).sort(function (a, b) { return a.checkIn < b.checkIn ? -1 : a.checkIn > b.checkIn ? 1 : 0; });
  }

  function upcomingBookings(guestId) {
    var today = util().today();
    return bookingsOf(guestId).filter(function (r) { return r.status === "Confirmed" && r.checkIn > today; });
  }

  function normalise(d) {
    var U = util();
    var out = {
      propertyId: d.propertyId || LHMS.session.propertyId,
      roomTypeId: d.roomTypeId,
      ratePlanId: d.ratePlanId,
      checkIn: String(d.checkIn || "") || U.today(),
      checkOut: String(d.checkOut || ""),
      adults: Number(d.adults) || 1,
      children: Number(d.children) || 0,
      eta: String(d.eta || ""),
      notes: String(d.notes || "").trim()
    };
    if (!out.checkOut) out.checkOut = U.addDays(out.checkIn, 1);
    return out;
  }

  function priceFor(d) {
    return LHMS.calc.quote(d.roomTypeId, d.ratePlanId, d.checkIn, d.checkOut, d.adults, d.children);
  }

  function freeFor(d) {
    return LHMS.calc.availability(d.roomTypeId, d.checkIn, d.checkOut, d.propertyId);
  }

  // One validation path for the live quote panel and the submit, so a guest is
  // never shown a price for something we would refuse to book.
  function bookingErrors(d) {
    var U = util();
    var errs = [];
    if (!LHMS.db.properties.some(function (p) { return p.id === d.propertyId; })) errs.push("Choose which hotel you are staying at.");
    var type = LHMS.get.roomType(d.roomTypeId);
    if (!type) errs.push("Choose a room type.");
    if (!LHMS.db.ratePlans.some(function (p) { return p.id === d.ratePlanId; })) errs.push("Choose a rate plan.");
    if (d.checkIn < U.today()) errs.push("Your arrival date is in the past.");
    if (U.nights(d.checkIn, d.checkOut) < 1) errs.push("Departure has to be after arrival.");
    if (type && d.adults + d.children > type.occupancy) {
      errs.push(type.name + " sleeps " + type.occupancy + ". Reduce the party or choose a suite.");
    }
    if (type && !priceFor(d).available) {
      errs.push(type.name + " has no rate on sale for those dates. Try another room type or different dates.");
    }
    return errs;
  }

  function book(d) {
    var actor = bookingActor();
    if (!actor.ok) return actor;
    var draft = normalise(d);
    var errs = bookingErrors(draft);
    if (errs.length) return { ok: false, error: errs[0] };
    if (!freeFor(draft).free) {
      var t = LHMS.get.roomType(draft.roomTypeId);
      return { ok: false, error: "No " + (t ? t.name : "room") + " is free from " + util().pretty(draft.checkIn, "short") + ". Try different dates." };
    }
    var res = LHMS.actions.newBooking(Object.assign({}, draft, {
      guestId: actor.ctx.guestId, channel: "Direct", source: "Guest app", deposit: 0
    }));
    return { ok: true, res: res, quote: priceFor(draft) };
  }

  /* ---------------- orders (PRD 6.5 / 6.6) ---------------- */
  function orderLines(data) {
    return ((data && data.lines) || []).filter(function (l) { return Number(l.qty) > 0; })
      .map(function (l) { return { id: l.id, qty: Math.max(1, Number(l.qty)) }; });
  }

  function orderTotal(lines) {
    return lines.reduce(function (sum, l) {
      var hit = LHMS.get.menu(l.id);
      return sum + (hit ? hit.item.price * l.qty : 0);
    }, 0);
  }

  // Everything is priced and validated before anything is posted, so a partial
  // order never lands on the folio.
  function order(data) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    var ctx = auth.ctx;
    var lines = orderLines(data);
    if (!lines.length) return { ok: false, error: "Choose at least one item." };
    var orderResult = LHMS.actions.orderItems(ctx.stay.id, lines, { postedBy: "Guest app" });
    if (!orderResult.ok) return orderResult;
    var first = LHMS.get.menu(lines[0].id);
    var when = String((data && data.when) || "").trim();
    var notes = String((data && data.notes) || "").trim();
    var task = LHMS.actions.createRequest({
      title: first.outlet.name + " — " + lines.map(function (l) {
        return l.qty + " × " + LHMS.get.menu(l.id).item.name;
      }).join(", "),
      detail: (when ? "Serve by " + when + ". " : "") + (notes || "Ordered from the guest app.") +
        " Posted to the folio: " + money(orderResult.total, orderResult.currency) + ".",
      guestId: ctx.guestId, roomId: ctx.stay.roomId,
      propertyId: LHMS.session.propertyId || ctx.stay.propertyId,
      priority: "Normal", slaMins: first.outlet.sla
    });
    return {
      ok: true, charges: orderResult.charges, total: orderResult.total, currency: orderResult.currency,
      task: task, outlet: first.outlet
    };
  }

  /* ---------------- loyalty (PRD 6.9) ---------------- */
  function redeem(data) {
    if (!isGuest()) return deny();
    var auth = authorize();
    if (!auth.ok) return auth;
    return LHMS.actions.redeemPoints(auth.ctx.stay.id, {
      points: data && data.points, postedBy: "Guest app"
    });
  }

  function guestRequests(ctx) {
    return LHMS.db.tasks.filter(function (t) {
      return t.guestId === ctx.guestId && t.source === "Guest app";
    });
  }

  LHMS.guestPortal = {
    context: context,
    authorize: authorize,
    request: request,
    checkIn: checkIn,
    checkOut: checkOut,
    settle: settle,
    book: book,
    order: order, redeem: redeem, orderTotal: orderTotal, orderLines: orderLines,
    bookingErrors: bookingErrors,
    bookingsOf: bookingsOf,
    upcomingBookings: upcomingBookings,
    normalise: normalise,
    priceFor: priceFor,
    freeFor: freeFor,
    savePreferences: savePreferences,
    services: SERVICES,
    tab: function (key) {
      var found = TABS.some(function (t) { return t.key === key; });
      return found ? key : "stay";
    }
  };

  /* ---------------- phone chrome ---------------- */
  function statusBar() {
    var now = new Date();
    var hh = now.getHours(), mm = now.getMinutes();
    var time = (hh < 10 ? "0" : "") + hh + ":" + (mm < 10 ? "0" : "") + mm;
    return '<div class="phone-status"><span>' + time + '</span><span class="sig">' +
      '<i style="height:5px"></i><i style="height:7px"></i><i style="height:9px"></i><i style="height:11px"></i>' +
      "</span></div>";
  }

  function phoneTop(ctx) {
    var U = util();
    var room = ctx.stay && LHMS.get.room ? LHMS.get.room(ctx.stay.roomId) : null;
    var p = LHMS.get.property(ctx.stay ? ctx.stay.propertyId : LHMS.session.propertyId);
    return '<div class="phone-top">' +
      '<span class="brand-mark">' + ui().icon("building", 18) + "</span>" +
      "<div><div class='pt-name'>" + esc(p ? p.short : "Aurelia Grand") + "</div>" +
      '<div class="pt-kicker">' + (ctx.guest && ctx.guest.tier ? esc(ctx.guest.tier) + " guest" : "Guest portal") + "</div></div>" +
      '<div class="pt-room"><b>' + (room ? esc(room.number) : "—") + "</b><span>" + (ctx.stay ? esc(U.pretty(ctx.stay.checkOut, "short")) + " out" : "No stay") + "</span></div>" +
      "</div>";
  }

  function phoneNav(active) {
    return '<nav class="phone-nav">' + TABS.map(function (t) {
      return '<a class="' + (t.key === active ? "active" : "") + '" href="#/guest/' + t.key + '">' +
        ui().icon(t.icon, 19) + "<span>" + t.label + "</span></a>";
    }).join("") + "</nav>";
  }

  function keyCode(ctx) {
    var room = ctx.stay ? String(ctx.stay.roomId || "") : "";
    var salt = Math.floor(Date.now() / 60000);
    var h = 0;
    var seed = room + ":" + salt;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 1000000;
    return ("000000" + h).slice(-6);
  }

  function keyCard(ctx) {
    var U = ui();
    var issued = !!ctx.stay.mobileKey || ctx.stay.status === "In-house";
    if (!issued) {
      return '<div class="g-card dark"><div class="g-card-title" style="color:#fbf7ec">' + U.icon("key", 14) + "<span>Digital key</span></div>" +
        "<p style='color:#a9bacb'>Your key is issued the moment you check in. Use express check-in below or collect a card at the desk.</p>" +
        '<div class="g-key"><div class="key-ic">' + U.icon("door", 19) + "</div><div><b>Not yet issued</b><span>Check in to unlock your room from here</span></div>" +
        '<button class="btn sm" data-act="guest-checkin">Check in</button></div></div>';
    }
    return '<div class="g-card dark"><div class="g-card-title" style="color:#fbf7ec">' + U.icon("key", 14) +
      "<span>Digital key</span>" + (state.keyActive ? '<span class="chip green">Active</span>' : "") + "</div>" +
      '<div class="g-key"><div class="key-ic">' + U.icon("key", 19) + "</div>" +
      '<div><b id="g-key-code">' + (state.revealed ? keyCode(ctx) : "••••••") + "</b>" +
      "<span>" + (state.keyActive ? "Rotates every 60 seconds · hold to the door reader" : "Room " + esc((LHMS.get.room(ctx.stay.roomId) || {}).number || "") + " · activate to open") + "</span></div>" +
      '<button class="btn sm" data-act="guest-key">' + (state.keyActive ? "Deactivate" : "Activate") + "</button></div>" +
      '<p style="color:#8fa0b3;font-size:8.5px;margin-top:8px">This key opens nothing in this build — the door-lock integration is not connected (PRD 6.12).</p></div>';
  }

  /* ---------------- stay tab ---------------- */
  function stayTab(ctx) {
    var U = util();
    var ui2 = ui();
    var res = ctx.stay;
    var room = LHMS.get.room(res.roomId);
    var type = LHMS.get.roomType(res.roomTypeId);
    var plan = LHMS.get.ratePlan(res.ratePlanId);
    var folio = LHMS.folio(res.id);
    var open = guestRequests(ctx).filter(function (t) { return t.status !== "Done"; });

    var greeting = ((ctx.guest && ctx.guest.name) || LHMS.session.name || "Guest").split(" ")[0];
    var prefs = (ctx.guest && ctx.guest.preferences) || {};
    var anniversary = /anniversary/i.test(res.notes || "");

    return '<div class="g-eyebrow">' + esc(U.pretty(U.today(), "long")) + "</div>" +
      '<div class="g-hello">' + esc(ui2.timeGreeting()) + ", " + esc(greeting) + "</div>" +
      '<div class="g-sub">' + (room ? "Welcome to Room " + esc(room.number) : "Welcome to Aurelia") +
      " · " + esc(type ? type.name : "") + "</div>" +
      (anniversary ? '<div class="g-card gold mt12"><div class="g-card-title">' + ui2.icon("sparkles", 14) + "<span>Your anniversary</span></div><p>A card and macarons are on the house. Tell us if you would like a table at Isla or a private dinner by the pool.</p>" +
        '<div class="g-quick"><button data-act="guest-order" data-outlet="out_isla">Book a dinner</button><button data-act="guest-quick" data-service="frontdesk" data-title="Anniversary celebration">Speak to the concierge</button></div></div>' : "") +
      '<div class="mt12">' + keyCard(ctx) + "</div>" +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("calendar", 14) + "<span>Your stay</span></div>" +
        '<div class="g-row"><span class="lbl">Arrival</span><span class="val">' + esc(U.pretty(res.checkIn, "long")) + "</span></div>" +
        '<div class="g-row"><span class="lbl">Departure</span><span class="val">' + esc(U.pretty(res.checkOut, "long")) + "</span></div>" +
        '<div class="g-row"><span class="lbl">Rate</span><span class="val">' + esc(plan ? plan.name : "—") + "</span></div>" +
        '<div class="g-row"><span class="lbl">Booking</span><span class="val mono">' + esc(res.reference) + "</span></div>" +
        (res.status === "Confirmed" ? '<button class="btn primary block mt12" data-act="guest-checkin">' + ui2.icon("checkCircle", 14) + " Express check-in</button>" : "") +
      "</div>" +
      '<div class="g-eyebrow" style="margin-top:16px">Concierge</div>' +
      '<div class="g-actions">' + SERVICES.map(function (s) {
        return '<button class="g-action" data-act="' + (s.outlet ? "guest-order" : "guest-quick") + '" data-service="' + s.key + '">' + ui2.icon(s.icon, 17) + "<span>" + s.label + "</span></button>";
      }).join("") + "</div>" +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("receipt", 14) + "<span>Folio balance</span>" +
        '<a href="#/guest/folio" style="font-size:9px;font-weight:700;color:#8a7038">View</a></div>' +
        '<div class="g-value mt8">' + esc(money(folio.balance, folio.currency)) + "</div>" +
        "<p>" + (folio.balance > 0 ? "Settle at the desk or online before you depart." : "Nothing outstanding. Enjoy the stay.") + "</p></div>" +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("sparkles", 14) + "<span>Your preferences</span>" +
        '<a href="#/guest/me" style="font-size:9px;font-weight:700;color:#8a7038">Edit</a></div>' +
        '<div class="g-row"><span class="lbl">Pillow</span><span class="val">' + esc(prefs.pillow) + "</span></div>" +
        '<div class="g-row"><span class="lbl">Room</span><span class="val">' + esc(prefs.room) + "</span></div>" +
        '<div class="g-row"><span class="lbl">Allergies</span><span class="val" style="' + (prefs.allergies && prefs.allergies !== "None" ? "color:var(--red)" : "") + '">' + esc(prefs.allergies || "None") + "</span></div>" +
      "</div>" +
      (open.length ? '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("message", 14) + "<span>" + open.length + " open request" + (open.length > 1 ? "s" : "") + "</span>" +
        '<a href="#/guest/requests" style="font-size:9px;font-weight:700;color:#8a7038">Open</a></div>' +
        open.slice(0, 3).map(function (t) {
          return '<div class="g-row"><span class="lbl">' + esc(t.title) + '</span><span class="val">' + esc(LHMS.calc.sla(t).label) + "</span></div>";
        }).join("") + "</div>" : "") +
      upcomingCard(ctx);
  }

  /* ---------------- bookings ---------------- */
  function bookingLine(r) {
    var U = util();
    var type = LHMS.get.roomType(r.roomTypeId);
    var prop = LHMS.db.properties.find(function (p) { return p.id === r.propertyId; });
    // A past stay in Accra and one in Lagos are two different moneys, so each
    // line is printed in the money its own folio was billed in.
    var f = LHMS.folio(r.id);
    return '<div class="g-row"><span class="lbl">' + esc((prop ? prop.short : "Aurelia") + " · " + (type ? type.name : "Room")) +
      '</span><span class="val">' + esc(U.pretty(r.checkIn, "short") + " → " + U.pretty(r.checkOut, "short")) +
      '<div class="tiny muted">' + esc(r.reference) + " · " + esc(money(f.total, f.currency)) + "</div></span></div>";
  }

  function upcomingCard(ctx) {
    var ui2 = ui();
    var up = upcomingBookings(ctx.guestId);
    return '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("calendar", 14) +
      "<span>" + (up.length ? "Upcoming stays" : "Next stay") + "</span>" +
      '<button class="btn-link" type="button" data-act="guest-book">Book</button></div>' +
      (up.length ? up.map(bookingLine).join("") : "<p>No future booking yet — your saved preferences come with you, so nothing needs repeating.</p>") +
      "</div>";
  }

  /* the view for a guest with nothing in house */
  function staysTab(ctx) {
    var ui2 = ui();
    var U = util();
    var up = upcomingBookings(ctx.guestId);
    var greeting = ((ctx.guest && ctx.guest.name) || LHMS.session.name || "Guest").split(" ")[0];
    return '<div class="g-eyebrow">' + esc(U.pretty(U.today(), "long")) + "</div>" +
      '<div class="g-hello">' + esc(ui2.timeGreeting()) + ", " + esc(greeting) + "</div>" +
      '<div class="g-sub">No active stay — the portal opens the moment you check in.</div>' +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("alert", 14) + "<span>No active stay</span></div>" +
      "<p>This account is linked to an in-house reservation. Ask the front desk to check you in, or start your next stay here.</p>" +
      '<button class="btn primary block mt12" data-act="guest-book">' + ui2.icon("plus", 12) + " Book a stay</button></div>" +
      (up.length ? '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("calendar", 14) + "<span>Your upcoming stays</span></div>" +
        up.map(bookingLine).join("") + "</div>" : "");
  }

  /* ---------------- requests tab ---------------- */
  function requestsTab(ctx) {
    var ui2 = ui();
    var U = util();
    var tasks = guestRequests(ctx);
    var open = tasks.filter(function (t) { return t.status !== "Done"; });

    var thread = tasks.length ? tasks.slice(0, 8).map(function (t) {
      var isHotel = t.status === "Done";
      return '<div class="bubble ' + (isHotel ? "hotel" : "guest") + '"><b style="font-size:10px">' + esc(t.title) + "</b>" +
        "<div>" + esc(t.detail || "Received — the team is on it.") + "</div>" +
        "<time>" + esc(U.timeAgo(t.createdAt)) + (t.status === "Done" ? " · resolved" : " · " + esc(LHMS.calc.sla(t).label)) + "</time></div>";
    }).join("") : '<div class="bubble hotel">Good afternoon. Message the front desk, housekeeping, dining or the spa here and the right team picks it up instantly — no app download, no waiting on hold.</div>';

    return '<div class="g-eyebrow">Concierge</div><div class="g-hello">How can we help?</div>' +
      '<div class="g-sub">Requests reach the department that owns them, with your preferences attached.</div>' +
      '<div class="g-chat">' + thread + "</div>" +
      '<form class="g-input" data-form="guest-request"><input name="title" placeholder="Type a request…" autocomplete="off" aria-label="Your request" />' +
      '<button type="submit" aria-label="Send request">' + ui2.icon("send", 15) + "</button></form>" +
      '<div class="g-quick">' + SERVICES.map(function (s) {
        return '<button data-act="guest-quick" data-service="' + s.key + '">' + s.title + "</button>";
      }).join("") + "</div>" +
      '<div class="g-card mt16"><div class="g-card-title">' + ui2.icon("clock", 14) + "<span>Request history</span>" +
        '<span class="tiny muted">' + open.length + " open</span></div>" +
        (tasks.length ? tasks.map(function (t) {
          return '<div class="g-row"><span class="lbl">' + esc(t.title) + '</span><span class="val">' +
            (t.status === "Done" ? "Resolved" : esc(LHMS.calc.sla(t).label)) + "</span></div>";
        }).join("") : '<p class="mt8">Nothing yet. Your requests stay here for the length of your stay.</p>') +
      "</div>" +
      (function () {
        // The upgrade pitch quotes the real gap between tonight's two rates,
        // so it can never drift from the price catalogue. A gap is only a figure
        // when both rooms are sold in the same money; two different moneys are
        // worth asking about, not worth subtracting.
        var stay = ctx.stay;
        if (!stay) return "";
        var seaView = LHMS.price.nightRateOf("pv", { date: U.today() });
        var current = LHMS.price.nightRateOf(stay.roomTypeId, { date: U.today() });
        if (!seaView || !current) return "";
        var same = seaView.currency === current.currency;
        var gap = 0;
        if (same) gap = seaView.amount - current.amount;
        else {
          var b1 = LHMS.fx.toBase(seaView.amount, seaView.currency), b2 = LHMS.fx.toBase(current.amount, current.currency);
          if (!b1.ok || !b2.ok) return "";
          gap = b1.base - b2.base;
        }
        if (gap <= 0) return "";
        return '<div class="g-card gold mt12"><div class="g-card-title">' + ui2.icon("star", 14) + "<span>Upgrade your view</span></div>" +
          "<p>Premier Sea View with a private balcony at dusk — " +
          (same ? esc(money(gap, seaView.currency)) + " more per night for this stay"
                : esc(money(seaView.amount, seaView.currency)) + " a night, against your " + esc(money(current.amount, current.currency))) +
          ", subject to availability.</p>" +
          '<button class="btn sm block mt12" data-act="guest-upgrade">Request an upgrade</button></div>';
      })();
  }

  /* ---------------- folio tab ---------------- */
  function folioTab(ctx) {
    var ui2 = ui();
    var U = util();
    var res = ctx.stay;
    var type = LHMS.get.roomType(res.roomTypeId);
    var folio = LHMS.folio(res.id);

    var lines = folio.charges.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; }).map(function (c) {
      return '<div class="folio-line"><div class="fl-desc"><b>' + esc(c.description) + "</b><span>" + esc(c.department) + " · " + esc(U.pretty(c.date, "short")) + "</span></div>" +
        '<div class="fl-amt"' + (c.amount < 0 ? ' style="color:var(--green)"' : "") + ">" + esc(money(c.amount, c.currency)) + "</div></div>";
    }).join("") || '<p class="tiny muted">No charges posted yet.</p>';

    var pays = folio.payments.map(function (p) {
      return '<div class="folio-line"><div class="fl-desc"><b>' + esc(p.method) + " payment</b><span>" + esc(U.pretty(p.date, "short")) + " · " + esc(p.reference) + "</span></div>" +
        '<div class="fl-amt" style="color:var(--green)">-' + esc(money(p.amount, p.currency)) + "</div></div>";
    }).join("");

    return '<div class="g-eyebrow">Billing</div><div class="g-hello">Your folio</div>' +
      '<div class="g-hero mt12">' + (type ? '<img src="' + esc(type.image) + '" alt="' + esc(type.name) + '" />' : "") +
      '<div class="gh-copy"><b>' + esc(type ? type.name : "Your room") + "</b><span>" + esc(U.pretty(res.checkIn, "short")) + " → " + esc(U.pretty(res.checkOut, "short")) +
      " · " + U.nights(res.checkIn, res.checkOut) + " nights</span></div></div>" +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("list", 14) + "<span>Charges</span></div>" + lines + "</div>" +
      (pays ? '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("card", 14) + "<span>Payments</span></div>" + pays + "</div>" : "") +
      '<div class="folio-total mt12"><div class="ft-row"><span>Total charges</span><b style="font-size:13px">' + esc(money(folio.total, folio.currency)) + "</b></div>" +
        '<div class="ft-row"><span>Paid</span><b style="font-size:13px">' + esc(money(folio.paid, folio.currency)) + "</b></div>" +
        '<div class="ft-row big"><span>Balance</span><b>' + esc(money(folio.balance, folio.currency)) + "</b></div></div>" +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("logout", 14) + "<span>Departure</span></div>" +
        "<p>Checkout is at 12:00." + (folio.balance > 0
          ? " Settle the balance here and leave when you are ready — no stop at the desk."
          : " Nothing outstanding, so you can leave the key in the room and go.") + " Need more time? Ask us for a late departure.</p>" +
        '<div class="row mt12" style="gap:7px"><button class="btn sm block" data-act="guest-late-checkout">Request 14:00 checkout</button>' +
        (folio.balance > 0
          ? '<button class="btn sm block" data-act="guest-settle">Settle ' + esc(money(folio.balance, folio.currency)) + "</button>"
          : '<button class="btn sm primary block" data-act="guest-checkout">Express checkout</button>') + "</div></div>" +
      '<p class="tiny muted mt12">Charges are posted by every outlet to this single folio (PRD 6.10). Payment is recorded against the folio; card capture is not connected in this build.</p>';
  }

  /* ---------------- profile tab ---------------- */
  function prefOptions(key, current) {
    var seen = {};
    var list = LHMS.db.guests.slice(0, 40).map(function (g) { return (g.preferences || {})[key]; })
      .filter(Boolean).concat([current]).filter(function (v, i, a) { return a.indexOf(v) === i; });
    var extra = { pillow: ["No preference"], room: ["No preference"], dietary: ["No restrictions"], allergies: ["None"], beverage: ["Still water"], newspaper: ["None"], turndown: ["On request", "Evening turndown"] }[key] || [];
    extra.concat(list).forEach(function (v) { seen[v] = true; });
    return Object.keys(seen).map(function (v) {
      return '<option' + (v === current ? " selected" : "") + ">" + esc(v) + "</option>";
    }).join("");
  }

  function profileTab(ctx) {
    var ui2 = ui();
    var U = util();
    var g = ctx.guest;
    var stats = LHMS.calc.guestStats(g.id);
    var docs = LHMS.documents && LHMS.documents.visible ? LHMS.documents.visible("view").filter(function (d) { return d.guestId === g.id; }) : [];

    var L = LHMS.loyalty;
    var pending = ctx.stay ? L.pending(ctx.stay.id) : 0;

    return '<div class="g-eyebrow">Profile</div><div class="g-hello">' + esc(g.name) + "</div>" +
      '<div class="g-sub">' + esc(g.tier) + " member since " + esc(g.since) + " · " + esc(g.language || "English") + "</div>" +
      '<div class="g-card mt12"><div class="row between" style="gap:10px">' +
        '<div><div class="g-label">Aurelia Club</div><div class="g-value">' + (g.loyaltyPoints || 0).toLocaleString("en-NG") + " pts</div></div>" +
        ui2.avatar(g.name) + "</div>" +
        '<div class="g-row"><span class="lbl">Tier rate</span><span class="val">' + esc(g.tier) + " · " + L.multiplierFor(g.tier) + "× points</span></div>" +
        '<div class="g-row"><span class="lbl">Stays with us</span><span class="val">' + stats.stays + " · " + stats.nights + " nights</span></div>" +
        // Stays at more than one hotel are folded into this property's money to
        // give one number, so the number says which money it is.
        '<div class="g-row"><span class="lbl">Lifetime spend</span><span class="val">' + esc(money(stats.spend)) +
        ' <span class="tiny muted">in ' + esc(LHMS.fx.base()) + "</span></span></div>" +
        (pending ? '<div class="g-row"><span class="lbl">Waiting from this stay</span><span class="val">' + pending.toLocaleString("en-NG") + " pts</span></div>" : "") +
        '<button class="btn sm block mt12" data-act="guest-redeem">' + ui2.icon("star", 13) + " Redeem points on this stay</button>" +
      "</div>" +
      '<form class="g-card mt12" data-form="guest-preferences"><div class="g-card-title">' + ui2.icon("settings", 14) + "<span>Personalization</span></div>" +
        "<p>Everything here is visible to the front desk, housekeeping and the kitchens the moment you ask for something.</p>" +
        '<div class="form-grid mt12" style="gap:9px">' + PREF_FIELDS.map(function (f) {
          return '<div class="field"><label for="gp-' + f.key + '">' + f.label + '</label><select id="gp-' + f.key + '" name="' + f.key + '">' +
            prefOptions(f.key, (g.preferences || {})[f.key]) + "</select></div>";
        }).join("") + "</div>" +
        '<label class="check mt12"><input type="checkbox" name="marketing" value="yes"' + (g.consent && g.consent.marketing ? " checked" : "") + " /> Send me Aurelia offers and news</label>" +
        '<p class="tiny muted mt8">Consent is recorded against your profile in line with NDPR and GDPR (PRD 6.3).</p>' +
        '<button class="btn primary block mt12" type="submit">Save preferences</button></form>' +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("file", 14) + "<span>Your documents</span></div>" +
        (docs.length ? docs.map(function (d) {
          return '<div class="g-row"><span class="lbl">' + esc(d.name) + '</span><span class="val">' + esc(d.status) + "</span></div>";
        }).join("") : '<p class="mt8">Nothing waiting for you. Registration and folio copies appear here.</p>') +
        '<p class="tiny muted mt8">Metadata only — files are not stored or transmitted in this build.</p></div>' +
      '<div class="g-card mt12"><div class="g-card-title">' + ui2.icon("car", 14) + "<span>Getting around</span></div>" +
        '<div class="g-row"><span class="lbl">Airport transfer</span><span class="val">' + esc(conciergePrice("From ", 45000)) + "</span></div>" +
        '<div class="g-row"><span class="lbl">Chauffeur, hourly</span><span class="val">' + esc(conciergePrice("", 35000)) + "</span></div>" +
        '<button class="btn sm block mt12" data-act="guest-quick" data-service="frontdesk" data-title="Airport transfer">Book a transfer</button></div>' +
      '<button class="btn ghost block mt12" data-act="guest-signout">' + ui2.icon("logout", 14) + " Sign out of the guest portal</button>" +
      '<p class="tiny muted mt12" style="text-align:center">Aurelia Grand · ' + esc(U.today()) + "</p>";
  }

  /* ---------------- page ---------------- */
  LHMS.pages.guest = function (route) {
    var tab = LHMS.guestPortal.tab(typeof route === "string" ? route : (route && route.sub) || "");
    var ctx = context();
    var body;

    if (!ctx.guestId) {
      body = '<div class="g-card"><div class="g-card-title">' + ui().icon("alert", 14) + "<span>Not your account</span></div>" +
        "<p>The guest portal needs to know which guest it is speaking for. Sign in with your guest account, or ask the front desk to link this device to your reservation.</p>" +
        '<button class="btn sm block mt12" data-act="guest-exit">Back to staff sign-in</button></div>';
    } else if (!ctx.stay || ctx.stay.guestId !== ctx.guestId) {
      body = staysTab(ctx);
      tab = "stay";
    }
    else if (tab === "requests") body = requestsTab(ctx);
    else if (tab === "folio") body = folioTab(ctx);
    else if (tab === "me") body = profileTab(ctx);
    else body = stayTab(ctx);

    return '<div class="guest-stage">' + aside(ctx) +
      '<div class="phone">' + statusBar() + phoneTop(ctx) +
      '<div class="phone-body">' + body + "</div>" + phoneNav(tab) +
      '<button data-act="guest-exit" style="background:#fff;border:0;border-top:1px solid #f0ebe0;color:#a29c8f;font-size:9px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:8px 0 10px">Leave the guest portal and return to staff sign-in</button>' +
      "</div></div>";
  };

  function aside(ctx) {
    var ui2 = ui();
    return '<div class="guest-stage-aside">' +
      '<div class="brand" style="padding-left:0;border-bottom:0"><span class="brand-mark">' + ui2.icon("building", 23) + "</span><div><span class='brand-name'>Aurelia Grand</span>" +
      '<span class="brand-kicker">Guest experience</span></div></div>' +
      "<h2>Your room,<br/>in your pocket.</h2>" +
      "<p>Check in without the queue, open the door with your phone, and send a request straight to the team that can action it — with your preferences already attached.</p>" +
      '<div class="signin-stats"><div><b>24/7</b><span>Concierge</span></div><div><b>&lt;30m</b><span>Request SLA</span></div><div><b>0</b><span>Queues</span></div></div>' +
      (LHMS.session.signedIn ? '<button class="btn sm ghost" data-act="guest-exit" style="margin-top:22px;color:#c8d4e0;border:1px solid rgba(255,255,255,.22)">Return to the staff portal</button>' : "") +
      "</div>";
  }

  /* ---------------- modals + actions ---------------- */
  function serviceFor(key) {
    return SERVICES.find(function (s) { return s.key === key; }) || SERVICES[SERVICES.length - 1];
  }

  LHMS.uiActions["guest-quick"] = function (el) {
    var s = serviceFor(el.getAttribute("data-service"));
    var preset = el.getAttribute("data-title") || s.title;
    ui().modal({
      title: preset,
      slim: true,
      sub: "Goes to " + s.label + " · answered in about " + s.sla + " minutes",
      body: '<form data-form="guest-request"><input type="hidden" name="title" value="' + esc(preset) + '" />' +
        '<input type="hidden" name="slaMins" value="' + s.sla + '" />' +
        '<div class="field"><label for="gr-detail">Anything we should know?</label><textarea id="gr-detail" name="detail" placeholder="Two bath towels, no fragrance, please."></textarea></div>' +
        '<div class="row mt16" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button>' +
        '<button type="submit" class="btn primary">Send to ' + esc(s.label) + "</button></div></form>"
    });
  };

  LHMS.uiActions["guest-upgrade"] = function () {
    var ctx = context();
    var room = ctx.stay ? LHMS.get.room(ctx.stay.roomId) : null;
    ui().modal({
      title: "Request an upgrade",
      slim: true,
      sub: "The front desk reviews availability and confirms within the hour",
      body: '<form data-form="guest-request"><input type="hidden" name="title" value="Room upgrade request" /><input type="hidden" name="slaMins" value="60" />' +
        '<div class="field"><label for="up-detail">What would you like?</label><select id="up-detail" name="detail">' +
        LHMS.db.roomTypes.filter(function (t) { return !room || t.id !== ctx.stay.roomTypeId; }).map(function (t) {
          var nr = LHMS.price.nightRateOf(t.id);
          return "<option>" + esc(t.name) + " — " + esc(nr ? money(nr.amount, nr.currency) + " per night" : "price on request") + "</option>";
        }).join("") + "</select></div>" +
        '<div class="row mt16" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button>' +
        '<button type="submit" class="btn primary">Send request</button></div></form>'
    });
  };

  LHMS.forms["guest-request"] = function (form) {
    var data = new FormData(form);
    var result = LHMS.guestPortal.request({
      title: data.get("title"), detail: data.get("detail"), slaMins: Number(data.get("slaMins")) || 30
    });
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    ui().toast("Sent to the team — we will come back to you shortly.");
    LHMS.rerender();
  };

  LHMS.forms["guest-preferences"] = function (form) {
    var data = new FormData(form);
    var patch = {};
    PREF_FIELDS.forEach(function (f) { patch[f.key] = data.get(f.key); });
    patch.marketing = !!data.get("marketing");
    var result = LHMS.guestPortal.savePreferences(patch);
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().toast("Preferences saved — every department now sees them.");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-key"] = function () {
    state.keyActive = !state.keyActive;
    state.revealed = state.keyActive;
    ui().toast(state.keyActive ? "Digital key active for this session." : "Digital key deactivated.");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-checkin"] = function () {
    var ctx = context();
    var U = util();
    var ui2 = ui();
    var res = ctx.stay;
    if (!res) { ui2.toast("No reservation found for this account.", "error"); return; }
    if (res.status === "In-house") { ui2.toast("You are already checked in — your key is on the Stay tab."); return; }
    ui2.modal({
      title: "Express check-in",
      slim: true,
      sub: "Room " + (LHMS.get.room(res.roomId) || {}).number + " · " + U.pretty(res.checkIn, "long"),
      body: '<form data-form="guest-checkin"><div class="field"><label for="gc-eta">Arriving around</label><input id="gc-eta" name="eta" type="time" value="15:00" /></div>' +
        '<label class="check mt12"><input type="checkbox" name="idConfirmed" value="yes" /> I confirm my ID details match my profile</label>' +
        '<label class="check mt8"><input type="checkbox" name="mobileKey" value="yes" checked /> Issue my digital key</label>' +
        '<p class="tiny muted mt8">Registration card and folio are signed digitally on arrival (PRD 6.2).</p>' +
        '<div class="row mt16" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button>' +
        '<button type="submit" class="btn primary">Check me in</button></div></form>'
    });
  };

  LHMS.forms["guest-checkin"] = function (form) {
    var data = new FormData(form);
    if (!data.get("idConfirmed")) { ui().toast("Please confirm your ID details to check in.", "error"); return; }
    var result = LHMS.guestPortal.checkIn({ eta: data.get("eta"), mobileKey: !!data.get("mobileKey") });
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    state.keyActive = true;
    state.revealed = true;
    ui().toast("Checked in. Your digital key is ready on the Stay tab.");
    LHMS.go("guest/stay");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-checkout"] = function () {
    var ctx = context();
    var folio = LHMS.folio(ctx.stay.id);
    var U = util();
    ui().modal({
      title: "Express checkout",
      slim: true,
      sub: "Departure " + U.pretty(ctx.stay.checkOut, "long"),
      body: '<div class="folio-total"><div class="ft-row"><span>Total charges</span><b style="font-size:13px">' + esc(money(folio.total, folio.currency)) + "</b></div>" +
        '<div class="ft-row"><span>Paid</span><b style="font-size:13px">' + esc(money(folio.paid, folio.currency)) + "</b></div>" +
        '<div class="ft-row big"><span>Balance</span><b>' + esc(money(folio.balance, folio.currency)) + "</b></div></div>" +
        '<p class="tiny muted mt12">' + (folio.balance > 0
          ? "Nothing settles until this balance is clear — you can do it here in a tap."
          : "Nothing outstanding. Leave the key in the room and go — housekeeping takes it from here.") + "</p>" +
        '<div class="row mt16" style="justify-content:flex-end">' +
        (folio.balance > 0
          ? '<button type="button" class="btn" data-act="guest-settle">Settle ' + money(folio.balance, folio.currency) + "</button>"
          : '<button type="button" class="btn" data-close-modal>Stay</button>') +
        '<button type="button" class="btn primary" data-act="guest-checkout-confirm">Check out</button></div>'
    });
  };

  LHMS.uiActions["guest-settle"] = function () {
    var ctx = context();
    var ui2 = ui();
    if (!ctx.stay) { ui2.toast("No reservation found for this account.", "error"); return; }
    var folio = LHMS.folio(ctx.stay.id);
    if (folio.balance <= 0) { ui2.toast("Your folio is already clear."); LHMS.rerender(); return; }
    ui2.modal({
      title: "Settle your folio",
      slim: true,
      sub: money(folio.balance, folio.currency) + " · " + (LHMS.get.room(ctx.stay.roomId) || {}).number,
      body: '<form data-form="guest-settle">' +
        '<div class="folio-total"><div class="ft-row"><span>Total charges</span><b style="font-size:13px">' + esc(money(folio.total, folio.currency)) + "</b></div>" +
        '<div class="ft-row"><span>Paid</span><b style="font-size:13px">' + esc(money(folio.paid, folio.currency)) + "</b></div>" +
        '<div class="ft-row big"><span>To settle now</span><b>' + esc(money(folio.balance, folio.currency)) + "</b></div></div>" +
        '<div class="field mt16"><label for="gs-method">Pay with</label><select id="gs-method" name="method">' +
        '<option value="Card">Card on file</option>' +
        '<option value="Bank transfer">Bank transfer</option></select></div>' +
        '<label class="check mt12"><input type="checkbox" name="confirm" value="yes" /> I authorise Aurelia to charge ' + esc(money(folio.balance, folio.currency)) + " to this folio</label>" +
        '<p class="tiny muted mt8">No card data is collected or stored in this build.</p>' +
        '<div class="row mt16" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button>' +
        '<button type="submit" class="btn primary">Pay now</button></div></form>'
    });
  };

  LHMS.forms["guest-settle"] = function (form) {
    var data = new FormData(form);
    var result = LHMS.guestPortal.settle({ confirm: !!data.get("confirm"), method: data.get("method") });
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    ui().toast("Folio settled. You can check out whenever you are ready.");
    LHMS.rerender();
  };

  /* ---------------- booking modal ---------------- */
  function formValues(data) {
    var o = {};
    data.forEach(function (v, k) { o[k] = v; });
    return o;
  }

  function select(name, options, current, live) {
    return '<select name="' + name + '"' + (live ? ' data-change="guest-book"' : "") + ">" +
      options.map(function (o) {
        return '<option value="' + esc(o.v) + '"' + (String(o.v) === String(current) ? " selected" : "") + ">" + esc(o.l) + "</option>";
      }).join("") + "</select>";
  }

  function bookingFields(d) {
    var U = util();
    var today = U.today();
    return '<div class="field"><label for="gb-hotel">Hotel</label>' +
      select("propertyId", LHMS.db.properties.map(function (p) {
        return { v: p.id, l: p.name + " · " + p.city };
      }), d.propertyId, true) + "</div>" +
      '<div class="row mt12" style="gap:10px">' +
        '<div class="field" style="flex:1"><label for="gb-in">Arrival</label><input id="gb-in" type="date" name="checkIn" min="' + today + '" value="' + esc(d.checkIn) + '" data-change="guest-book" /></div>' +
        '<div class="field" style="flex:1"><label for="gb-out">Departure</label><input id="gb-out" type="date" name="checkOut" min="' + U.addDays(d.checkIn, 1) + '" value="' + esc(d.checkOut) + '" data-change="guest-book" /></div>' +
      "</div>" +
      '<div class="field mt12"><label for="gb-type">Room type</label>' +
      select("roomTypeId", LHMS.db.roomTypes.map(function (t) {
        var nr = LHMS.price.nightRateOf(t.id, { date: d.checkIn });
        return { v: t.id, l: t.name + " · sleeps " + t.occupancy + " · " + (nr ? money(nr.amount, nr.currency) + " / night" : "no rate on sale") };
      }), d.roomTypeId, true) + "</div>" +
      '<div class="field mt12"><label for="gb-plan">Rate plan</label>' +
      select("ratePlanId", LHMS.db.ratePlans.map(function (p) {
        return { v: p.id, l: p.name + " · " + p.includes };
      }), d.ratePlanId, true) + "</div>" +
      '<div class="row mt12" style="gap:10px">' +
        '<div class="field" style="flex:1"><label for="gb-adults">Adults</label>' +
        select("adults", [1, 2, 3, 4].map(function (n) { return { v: n, l: n }; }), d.adults, true) + "</div>" +
        '<div class="field" style="flex:1"><label for="gb-children">Children</label>' +
        select("children", [0, 1, 2, 3].map(function (n) { return { v: n, l: n }; }), d.children, true) + "</div>" +
        '<div class="field" style="flex:1"><label for="gb-eta">Arriving</label>' +
        select("eta", [{ v: "", l: "15:00" }, { v: "11:00", l: "11:00" }, { v: "13:00", l: "13:00" }, { v: "18:00", l: "18:00" }, { v: "22:00", l: "22:00" }], d.eta) + "</div>" +
      "</div>" +
      '<div class="field mt12"><label for="gb-notes">Anything we should prepare?</label>' +
      '<textarea id="gb-notes" name="notes" placeholder="High floor, champagne on ice…"></textarea></div>';
  }

  function quotePanel(d) {
    var U = util();
    var ui2 = ui();
    var errs = bookingErrors(d);
    if (errs.length) {
      return '<div class="g-card gold mt16" id="gb-quote"><div class="g-card-title">' + ui2.icon("alert", 14) +
        "<span>Check the details</span></div><p>" + esc(errs[0]) + "</p>" +
        '<p class="tiny muted mt8">Fix this and the price appears here.</p></div>';
    }
    var q = priceFor(d);
    var av = freeFor(d);
    var row = function (a, b) {
      return '<div class="g-row"><span class="lbl">' + a + '</span><span class="val">' + b + "</span></div>";
    };
    return '<div class="g-card gold mt16" id="gb-quote">' +
      '<div class="g-card-title">' + ui2.icon("card", 14) + "<span>Live quote</span>" +
      '<span class="chip ' + (av.free > 0 ? "green" : "red") + '">' + (av.free > 0 ? av.free + " free" : "Sold out") + "</span></div>" +
      row(ui2.nightsLabel(q.nights), esc(U.pretty(d.checkIn, "short") + " → " + U.pretty(d.checkOut, "short"))) +
      row(esc(q.type.name), esc(money(Math.round(q.roomTotal / q.nights), q.currency) + " avg")) +
      q.taxLines.map(function (t) { return row(esc(t.label), esc(money(t.amount, q.currency))); }).join("") +
      '<div class="g-value mt8">' + esc(money(q.total, q.currency)) + "</div>" +
      row("Deposit now", esc(money(q.deposit, q.currency))) +
      "<p>" + esc(q.plan.cancel) + "</p>" +
      (av.free > 0
        ? '<div class="row mt12" style="justify-content:flex-end"><button class="btn primary" type="submit">Confirm booking</button></div>'
        : '<p class="tiny muted mt12">Nothing available on these dates at this hotel — move the arrival a few days.</p>') +
      "</div>";
  }

  LHMS.uiActions["guest-book"] = function () {
    var actor = bookingActor();
    if (!actor.ok) { ui().toast(actor.error, "error"); return; }
    var U = util();
    var stay = actor.ctx.stay || {};
    var seed = normalise({
      propertyId: stay.propertyId || LHMS.session.propertyId,
      roomTypeId: stay.roomTypeId || "dk",
      ratePlanId: stay.ratePlanId || "flex",
      checkIn: U.addDays(U.today(), 14),
      checkOut: U.addDays(U.today(), 16),
      adults: stay.adults || 2,
      children: stay.children || 0
    });
    ui().modal({
      title: "Book a stay",
      slim: true,
      sub: "Your profile, preferences and loyalty rate travel with the reservation",
      body: '<form data-form="guest-book">' + bookingFields(seed) + quotePanel(seed) +
        '<div class="row mt12" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button></div></form>'
    });
  };

  LHMS.uiActions["change:guest-book"] = function (el) {
    var form = el.form;
    if (!form) return;
    var d = normalise(formValues(new FormData(form)));
    var panel = form.querySelector("#gb-quote");
    var outEl = form.querySelector('[name="checkOut"]');
    if (outEl) outEl.min = util().addDays(d.checkIn, 1);
    if (panel) panel.outerHTML = quotePanel(d);
  };

  LHMS.forms["guest-book"] = function (form) {
    var result = book(formValues(new FormData(form)));
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    ui().toast("Booked · " + result.res.reference + ". Check in from here on the day.");
    LHMS.go("guest/stay");
    LHMS.rerender();
  };

  /* ---------------- order modal ---------------- */
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // The guest picks a slot rather than a free-text time, so the department
  // queue always receives something it can work to.
  function serveSlots() {
    var out = ["As soon as possible"];
    var d = new Date(Date.now() + 30 * 60000);
    d.setMinutes(d.getMinutes() < 30 ? 0 : 30, 0, 0);
    for (var i = 0; i < 6; i++) {
      out.push(pad2(d.getHours()) + ":" + pad2(d.getMinutes()));
      d = new Date(d.getTime() + 30 * 60000);
    }
    return out;
  }

  function orderFields(outlet) {
    // The board quotes what the catalogue sells each item at, in the money that
    // row is priced in — the same figure that lands on the folio.
    return outlet.items.map(function (it) {
      var p = LHMS.price.itemPriceOf(it.id) || { amount: it.price };
      return '<div class="g-row"><span class="lbl">' + esc(it.name) +
        '<span class="tiny muted" style="display:block">' + esc(money(p.amount, p.currency)) + " each</span></span>" +
        '<input class="num" type="number" name="qty_' + it.id + '" value="0" min="0" max="20" ' +
        'data-change="guest-order" style="width:58px;text-align:center" aria-label="' + esc(it.name) + ' quantity" /></div>';
    }).join("");
  }

  function orderPanel(outlet, data) {
    var ui2 = ui();
    var lines = orderLines(data);
    var row = function (a, b) { return '<div class="g-row"><span class="lbl">' + a + '</span><span class="val">' + b + "</span></div>"; };
    if (!lines.length) {
      return '<div class="g-card gold mt16" id="go-total"><div class="g-card-title">' + ui2.icon("receipt", 14) +
        "<span>Your order</span></div><p>Nothing chosen yet — set a quantity and it posts to your folio.</p></div>";
    }
    var total = orderTotal(lines);
    // Adding to one number is only honest while the whole order is in one money;
    // the post check below says so when it is not.
    var orderCur = (LHMS.get.menu(lines[0].id) || { item: {} }).item.priceCurrency;
    return '<div class="g-card gold mt16" id="go-total">' +
      '<div class="g-card-title">' + ui2.icon("receipt", 14) + "<span>Your order</span>" +
      '<span class="chip green">' + esc(outlet.dept) + "</span></div>" +
      lines.map(function (l) {
        var hit = LHMS.get.menu(l.id);
        return row(esc(l.qty + " × " + hit.item.name), esc(money(hit.item.price * l.qty, hit.item.priceCurrency)));
      }).join("") +
      '<div class="g-value mt8">' + esc(money(total, orderCur)) + "</div>" +
      "<p>Added to your folio today. " + esc(outlet.name) + " confirms in about " + outlet.sla + " minutes.</p>" +
      '<div class="row mt12" style="justify-content:flex-end"><button class="btn primary" type="submit">Add to my folio</button></div></div>';
  }

  function orderDataFrom(form) {
    var lines = [];
    Array.prototype.forEach.call(form.querySelectorAll('[name^="qty_"]'), function (el) {
      var q = Number(el.value);
      if (q > 0) lines.push({ id: el.getAttribute("name").slice(4), qty: q });
    });
    return {
      lines: lines,
      when: (form.querySelector('[name="when"]') || {}).value || "",
      notes: (form.querySelector('[name="notes"]') || {}).value || ""
    };
  }

  LHMS.uiActions["guest-order"] = function (el) {
    var ctx = context();
    if (!ctx.stay) { ui().toast("Ordering needs an active stay. Ask the front desk to check you in.", "error"); return; }
    var outlet = LHMS.get.menuOf(el.getAttribute("data-outlet") || (serviceFor(el.getAttribute("data-service")).outlet));
    if (!outlet) { ui().toast("That outlet is not taking orders right now.", "error"); return; }
    var slots = serveSlots();
    ui().modal({
      title: outlet.name,
      sub: outlet.window + " · charged to your room",
      body: '<form data-form="guest-order"><input type="hidden" name="outlet" value="' + esc(outlet.id) + '" />' + orderFields(outlet) +
        '<div class="field mt16"><label for="go-when">' + (outlet.dept === "Spa & Wellness" ? "Appointment time" : "Serve by") + "</label>" +
        '<select id="go-when" name="when">' + slots.map(function (s) { return "<option>" + esc(s) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field mt12"><label for="go-notes">Anything we should know?</label>' +
        '<textarea id="go-notes" name="notes" placeholder="No shellfish, and leave at the door please."></textarea></div>' +
        orderPanel(outlet, { lines: [] }) +
        '<div class="row mt12" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button></div></form>'
    });
  };

  LHMS.uiActions["change:guest-order"] = function (el) {
    var form = el.form;
    var panel = form && form.querySelector("#go-total");
    var outlet = panel && LHMS.get.menuOf(form.querySelector('[name="outlet"]').value);
    if (outlet) panel.outerHTML = orderPanel(outlet, orderDataFrom(form));
  };

  LHMS.forms["guest-order"] = function (form) {
    var result = order(orderDataFrom(form));
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    ui().toast(result.outlet.name + " · " + money(result.total, result.currency) + " added to your folio.");
    LHMS.rerender();
  };

  /* ---------------- redeem modal ---------------- */
  // Points are only spendable against what is outstanding, so the ceiling is
  // the smaller of the balance and the folio.
  function redeemCeiling(ctx) {
    var L = LHMS.loyalty;
    var balance = LHMS.folio(ctx.stay.id).balance;
    return Math.min(ctx.guest.loyaltyPoints || 0, Math.floor(balance / L.config.valuePerPoint));
  }

  function redeemPanel(points, ctx) {
    var ui2 = ui();
    var L = LHMS.loyalty;
    var f = LHMS.folio(ctx.stay.id);
    var row = function (a, b) { return '<div class="g-row"><span class="lbl">' + a + '</span><span class="val">' + b + "</span></div>"; };
    var pts = Math.round(Number(points) || 0);
    var credit = L.creditFor(pts);
    var errs = [];
    if (pts < L.config.minRedeem) errs.push("Redeem at least " + L.config.minRedeem + " points.");
    if (pts > (ctx.guest.loyaltyPoints || 0)) errs.push("Only " + (ctx.guest.loyaltyPoints || 0) + " points are available.");
    if (credit > f.balance) errs.push("That is more than the " + money(f.balance, f.currency) + " outstanding.");
    if (errs.length) {
      return '<div class="g-card gold mt16" id="gr-panel"><div class="g-card-title">' + ui2.icon("alert", 14) +
        "<span>Check the details</span></div><p>" + esc(errs[0]) + "</p></div>";
    }
    return '<div class="g-card gold mt16" id="gr-panel">' +
      '<div class="g-card-title">' + ui2.icon("star", 14) + "<span>Your redemption</span></div>" +
      row(pts.toLocaleString("en-NG") + " points", esc(money(credit)) + " credit") +
      row("Folio after this", esc(money(f.balance - credit, f.currency))) +
      row("Points left", esc(((ctx.guest.loyaltyPoints || 0) - pts).toLocaleString("en-NG"))) +
      '<div class="row mt12" style="justify-content:flex-end"><button class="btn primary" type="submit">Apply to my folio</button></div></div>';
  }

  LHMS.uiActions["guest-redeem"] = function () {
    var auth = authorize();
    if (!auth.ok) { ui().toast(auth.error, "error"); return; }
    var ctx = auth.ctx;
    var L = LHMS.loyalty;
    var ceiling = redeemCeiling(ctx);
    if (ceiling < L.config.minRedeem) {
      ui().toast("You need at least " + L.config.minRedeem + " points and an outstanding balance to redeem.", "error");
      return;
    }
    // Half by default: the whole balance is one edit away, and a portal that
    // empties a loyalty account on the first tap is a bad default.
    var suggested = Math.min(ceiling, Math.max(L.config.minRedeem, Math.floor(ceiling / 2 / 1000) * 1000));
    ui().modal({
      title: "Redeem Aurelia Club points",
      slim: true,
      sub: ((ctx.guest.loyaltyPoints || 0).toLocaleString("en-NG")) + " available · " + money(L.config.valuePerPoint) + " of folio per point",
      body: '<form data-form="guest-redeem">' +
        '<div class="field"><label for="gr-points">Points to redeem</label>' +
        '<input id="gr-points" name="points" type="number" min="' + L.config.minRedeem + '" max="' + ceiling + '" step="500" value="' + suggested + '" data-change="guest-redeem" /></div>' +
        '<p class="tiny muted mt8">Up to ' + ceiling.toLocaleString("en-NG") + ' points can be used against this folio. Points still earn while you are in house.</p>' +
        redeemPanel(suggested, ctx) +
        '<div class="row mt12" style="justify-content:flex-end"><button type="button" class="btn" data-close-modal>Cancel</button></div></form>'
    });
  };

  LHMS.uiActions["change:guest-redeem"] = function (el) {
    var form = el.form;
    var panel = form && form.querySelector("#gr-panel");
    var auth = authorize();
    if (!panel || !auth.ok) return;
    panel.outerHTML = redeemPanel(form.querySelector('[name="points"]').value, auth.ctx);
  };

  LHMS.forms["guest-redeem"] = function (form) {
    var result = redeem({ points: form.querySelector('[name="points"]').value });
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    ui().toast(money(result.credit) + " applied to your folio · " + result.points.toLocaleString("en-NG") + " points used.");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-checkout-confirm"] = function () {
    var result = LHMS.guestPortal.checkOut();
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().closeModal();
    state.keyActive = false;
    ui().toast("Checked out." + (result.points ? " " + result.points.toLocaleString("en-NG") + " Aurelia Club points added." : "") + " Your folio copy is in documents.");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-late-checkout"] = function () {
    var result = LHMS.guestPortal.request({ title: "Late checkout — 14:00", detail: "Requested from the guest portal.", slaMins: 30 });
    if (!result.ok) { ui().toast(result.error, "error"); return; }
    ui().toast("Asked the front desk — they will confirm shortly.");
    LHMS.rerender();
  };

  LHMS.uiActions["guest-exit"] = function () {
    LHMS.signOut();
    location.hash = "";
    LHMS.rerender();
  };

  LHMS.uiActions["guest-signout"] = function () {
    LHMS.uiActions["guest-exit"]();
  };

  /* rotating key refresh */
  var timer = null;
  function startKeyTimer() {
    if (typeof setInterval !== "function") return;
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      var el = typeof document !== "undefined" && document.getElementById("g-key-code");
      if (el && state.keyActive && state.revealed) el.textContent = keyCode(context());
    }, 20000);
  }
  LHMS.guestPortal.onRender = function () {
    if (LHMS.session.role === "Guest" && state.keyActive) startKeyTimer();
  };
  if (typeof window !== "undefined" && window.addEventListener) {
    window.addEventListener("hashchange", LHMS.guestPortal.onRender);
  }
})();
