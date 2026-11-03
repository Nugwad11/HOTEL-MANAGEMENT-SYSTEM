/* ============================================================
   LHMS — Halls, events and laundry
   Both boards read money from LHMS.price and write through
   LHMS.actions. Not one figure on these screens is worked out
   by the page, which is what lets a quote and a folio agree.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;

  var S = { date: "", hall: "all", laundryView: "open" };

  /* ---------------- helpers ---------------- */
  // The board shows the working day, not the clock: 06:00 to midnight.
  var OPEN_MIN = 360;
  var CLOSE_MIN = 1440;
  var SPAN = CLOSE_MIN - OPEN_MIN;

  var STATUS_TONE = { Confirmed: "green", Hold: "gold", Cancelled: "red" };

  function day() { return S.date || (LHMS.day || U.today()); }
  function canBook() { return LHMS.can("book_events"); }
  function canRun() { return LHMS.can("run_laundry"); }
  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }
  function held(e) { return e.status !== "Cancelled"; }

  function laneLeft(t) { return ((Math.max(OPEN_MIN, U.timeMins(t) || OPEN_MIN) - OPEN_MIN) / SPAN) * 100; }
  function laneWidth(a, b) {
    var s = Math.max(OPEN_MIN, U.timeMins(a) || OPEN_MIN);
    var e = Math.min(CLOSE_MIN, U.timeMins(b) || CLOSE_MIN);
    return Math.max(3, ((e - s) / SPAN) * 100);
  }

  function resOptions(pid) {
    return LHMS.reservationsOf(pid).filter(function (r) {
      return r.status === "In-house" || r.status === "Confirmed";
    });
  }

  function resLabel(r) {
    var g = LHMS.get.guest(r.guestId);
    return r.reference + " · " + (g ? g.name : "Guest") + " · " + ui.roomNo(r.roomId);
  }

  // A sold line keeps both the list figure and what it was actually charged at.
  // The second only earns its place when a modifier moved it. Both are in the
  // money the line was priced in, which a hall and its add-ons always share.
  function unitCell(l) {
    return '<td class="num">' + U.money(l.unitPrice, l.currency) +
      (l.basePrice && l.basePrice !== l.unitPrice ? '<div class="tiny muted">list ' + U.money(l.basePrice, l.currency) + "</div>" : "") +
      "</td>";
  }

  /* ============================================================
     EVENTS BOARD
     ============================================================ */
  LHMS.pages.events = function (route) {
    var p = LHMS.get.property();
    // A date in the address is how a notification or the palette points at one
    // day of the board without the page keeping its own copy of the calendar.
    if (route && /^\d{4}-\d{2}-\d{2}$/.test(route.sub || "")) S.date = route.sub;
    var date = day();
    var halls = LHMS.halls();
    if (S.hall !== "all") {
      halls = halls.filter(function (h) { return h.refId === S.hall; });
    }
    var dayEvents = LHMS.eventsOf(p.id, date);
    var live = dayEvents.filter(held);
    var hours = live.reduce(function (s, e) { return s + (Number(e.hours) || 0); }, 0);
    // Halls on one day can be sold in different monies, so the headline adds the
    // figure each booking is worth on the books, not the figure on its face.
    var booked = live.reduce(function (s, e) { return s + LHMS.fx.baseOf(e); }, 0);
    var baseCur = LHMS.fx.base(p.id);
    var holds = live.filter(function (e) { return e.status === "Hold"; }).length;

    var upcoming = LHMS.eventsOf(p.id).filter(function (e) {
      return held(e) && e.date > date;
    }).slice(0, 5);

    var filterOptions = '<option value="all"' + (S.hall === "all" ? " selected" : "") + ">All halls</option>" +
      LHMS.halls().map(function (h) {
        return '<option value="' + h.refId + '"' + (S.hall === h.refId ? " selected" : "") + ">" + ui.esc(h.name) + "</option>";
      }).join("");

    return ui.pageHead({
      eyebrow: "Events & banqueting · " + p.short,
      title: "Hall bookings",
      sub: U.pretty(date, "medium") + " — " + live.length + " of " + LHMS.halls().length +
        " halls are held, " + hours + " hours sold and " + U.compact(booked, baseCur) + " quoted. " +
        (holds ? holds + " booking" + (holds > 1 ? "s are" : " is") + " still a hold." : "Nothing is waiting for confirmation."),
      actions: '<button class="btn" data-act="export-events">' + ui.icon("download", 14) + " Export</button>" +
        (canBook() ? '<button class="btn primary" data-act="event-new">' + ui.icon("plus", 14) + " New booking</button>" : "")
    }) +
      '<div class="toolbar">' +
        '<div class="row" style="gap:6px">' +
          '<button class="btn sm" data-act="event-day" data-shift="-1" aria-label="Previous day">' + ui.icon("left", 13) + "</button>" +
          '<input type="date" class="input" value="' + date + '" min="' + U.today() + '" data-change="event-date" aria-label="Event date" />' +
          '<button class="btn sm" data-act="event-day" data-shift="1" aria-label="Next day">' + ui.icon("right", 13) + "</button>" +
          '<button class="btn sm soft" data-act="event-today">Today</button>' +
        "</div>" +
        '<select class="input" data-change="event-hall" aria-label="Hall filter" style="width:auto">' + filterOptions + "</select>" +
        '<span class="spacer"></span>' +
        '<span class="chip navy">' + LHMS.halls().length + " halls in the catalogue</span>" +
      "</div>" +
      '<div class="kpis">' +
        ui.kpi("Bookings", live.length, live.filter(function (e) { return e.reservationId; }).length + " billed to a guest folio", { icon: "calendar" }) +
        ui.kpi("Hours sold", hours, "Across " + halls.length + " hall" + (halls.length === 1 ? "" : "s"), { icon: "clock" }) +
        ui.kpi("Quoted value", U.compact(booked, baseCur), "Valued in " + baseCur + ", priced by the central engine", { icon: "tag", accent: booked ? "accent-gold" : "" }) +
        ui.kpi("Holds", holds, holds ? "No money until confirmed" : "All confirmed", { icon: "lock", accent: holds ? "accent-amber" : "accent-green" }) +
        ui.kpi("Cancelled", dayEvents.length - live.length, "Lines voided, never deleted", { icon: "alert", accent: dayEvents.length - live.length ? "accent-red" : "" }) +
      "</div>" +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 310px;gap:16px">' +
        '<div class="stack">' +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("users", 15) +
            "Day schedule</div><div class=\"card-sub\">Every hall from 06:00 to midnight. A hall only appears once, so a clash cannot be hidden by the layout.</div></div>" +
            '<span class="chip ' + (U.isWeekend(date) ? "gold" : "") + '">' + (U.isWeekend(date) ? "Weekend rates apply" : "Weekday rates") + "</span></div>" +
            scheduleHTML(halls, dayEvents) +
          "</section>" +
          bookingsTable(dayEvents) +
        "</div>" +
        '<div class="stack">' +
          ui.sectionCard("Coming up", upcoming.length ? '<div class="list">' + upcoming.map(function (e) {
            // A booking on another day moves the board to it first, so the
            // address, the schedule behind the modal and the modal all agree.
            return '<a class="nav-link" style="color:var(--ink);border-radius:8px" href="#/events/' + e.date + '" data-act="event-jump" data-event="' + e.id + '" data-date="' + e.date + '">' +
              ui.icon("calendar", 15) + '<span style="flex:1">' + ui.esc(e.title) +
              '<span class="tiny muted" style="display:block;font-weight:400;margin-top:1px">' +
              ui.esc(U.pretty(e.date, "short")) + " · " + e.start + "–" + e.end + " · " + ui.esc(e.hallName) + "</span></span>" +
              '<b class="tiny num">' + U.compact(e.total, e.currency) + "</b></a>";
          }).join("") + "</div>" : ui.empty("Nothing booked ahead", "The next seven days are clear.", "calendar"), "", "Beyond this date", "calendar") +
          hallRatesCard() +
          ui.sectionCard("How a booking is priced", '<div class="stack" style="gap:9px">' +
            '<div class="row between"><span class="small">Sale by the hour</span><span class="tiny muted">per hall, per hour</span></div>' +
            '<div class="row between"><span class="small">Half and full day</span><span class="tiny muted">capped package rates</span></div>' +
            '<div class="row between"><span class="small">Weekend uplift</span><span class="tiny muted">Friday and Saturday</span></div>' +
            '<div class="row between"><span class="small">Add-ons</span><span class="tiny muted">per setup or guest</span></div>' +
            '<div class="notice info" style="margin-top:4px">' + ui.icon("info") +
            "<div>Every rate is set on the <a href=\"#/prices\">price setup</a> board. A booking keeps the lines it was sold on; re-pricing later cannot rewrite it.</div></div>" +
          "</div>", "", "One engine, one number", "tag") +
          (canBook() ? "" : '<div class="notice">' + ui.icon("lock") +
            "<div><b>Read-only.</b> Booking halls needs the events permission; your role can see the board but cannot change it.</div></div>") +
        "</div>" +
      "</div>";
  };

  function scheduleHTML(halls, evts) {
    if (!halls.length) return ui.empty("No halls to sell", "Add a hall on the price setup board first.", "building");
    return halls.map(function (h) {
      var mine = evts.filter(function (e) { return e.hallId === h.refId; });
      // Priced for the day on screen, so the lane, the sidebar and a quote for
      // the same window cannot disagree about what an hour costs.
      var rate = LHMS.price.amount(h.id, { date: day() });
      return '<div class="hall-lane"><div class="hall-lane-name"><b>' + ui.esc(h.name) + "</b>" +
        '<span>' + (h.capacity ? h.capacity + " guests · " : "") +
        (rate ? U.money(rate.unit, rate.currency) + " / hour" : "no price set") + "</span></div>" +
        '<div class="hall-track">' +
          '<div class="hall-ticks">' + new Array(19).join('<i></i>') + "</div>" +
          mine.map(function (e) {
            return '<button class="hall-bar ' + (STATUS_TONE[e.status] || "") + '" style="left:' + laneLeft(e.start) +
              "%;width:" + laneWidth(e.start, e.end) + '%" data-act="event-open" data-event="' + e.id +
              '" title="' + ui.esc(e.title + " · " + e.start + "–" + e.end) + '">' + ui.esc(e.title) + "</button>";
          }).join("") +
        "</div>" +
        '<div class="hall-lane-foot">' + (mine.length ? '<span class="chip ' + (mine.some(held) ? "green" : "") + '">' +
          mine.filter(held).length + " held</span>" : '<span class="tiny muted">Free all day</span>') + "</div></div>";
    }).join("") +
      '<div class="row" style="gap:8px;margin-top:12px;flex-wrap:wrap"><span class="tiny muted">Colour shows the state:</span>' +
      ui.chip("Confirmed", "green") + ui.chip("Hold", "gold") + ui.chip("Cancelled", "red") + "</div>";
  }

  function bookingsTable(evts) {
    if (!evts.length) {
      return '<section class="card">' + ui.empty("No bookings on this date", "Nothing is held in any hall for the day you are looking at.", "calendar") + "</section>";
    }
    return '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("list", 15) +
      'Bookings on this date</div><div class="card-sub">Each row is a transaction: the lines it was sold on, the tax on them and the deposit taken.</div></div></div>' +
      '<div class="table-wrap"><table><thead><tr><th>Event</th><th>Hall</th><th>Window</th><th>Guests</th><th>Status</th><th>Total</th><th>Deposit</th><th></th></tr></thead><tbody>' +
      evts.map(function (e) {
        var due = Math.round((e.deposit || 0) - (e.depositPaid || 0));
        return "<tr><td><b>" + ui.esc(e.title) + '</b><div class="tiny muted">' + ui.esc(e.organizer) + "</div></td>" +
          "<td>" + ui.esc(e.hallName) + "</td>" +
          '<td class="num">' + e.start + "–" + e.end + '<div class="tiny muted">' + e.hours + " h · " + ui.esc(e.packageName || "Hourly") + "</div></td>" +
          '<td class="num">' + e.guests + "</td>" +
          "<td>" + ui.chip(e.status, STATUS_TONE[e.status] || "") + "</td>" +
          '<td class="num"><b>' + U.money(e.total, e.currency) + '</b><div class="tiny muted">' + ui.esc(e.listName || "") + "</div></td>" +
          '<td class="num">' + U.money(e.depositPaid || 0, e.currency) + '<div class="tiny muted">' +
          (e.reservationId ? (due > 0 ? U.money(due, e.currency) + " outstanding" : "settled") : "invoiced separately") + "</div></td>" +
          '<td><button class="btn sm soft" data-act="event-open" data-event="' + e.id + '">Open</button></td></tr>';
      }).join("") +
      "</tbody></table></div></section>";
  }

  function hallRatesCard() {
    var date = day();
    var line = function (label, value) {
      return '<div class="row between" style="font-size:11.5px"><span class="muted">' + label +
        "</span><b class=\"num\">" + value + "</b></div>";
    };
    return ui.sectionCard("Hall rates for " + U.pretty(date, "short"), '<div class="stack" style="gap:11px">' +
      LHMS.halls().map(function (h) {
        var hour = LHMS.price.amount(h.id, { qty: 1, date: date });
        var four = LHMS.price.hallQuote(h.id, { date: date, start: "10:00", end: "14:00" });
        var full = LHMS.price.hallQuote(h.id, { date: date, start: "08:00", end: "18:00", package: "full" });
        return '<div class="stack" style="gap:2px"><div class="small" style="font-weight:600">' + ui.esc(h.name) + "</div>" +
          line("Per hour", hour ? U.money(hour.unit, hour.currency) : "no price set") +
          line("Four hours", four ? U.money(four.total, four.currency) : "—") +
          line("Full day", full ? U.money(full.total, full.currency) : "—") + "</div>";
      }).join("") + "</div>", "", "Gross of tax, as quoted", "tag");
  }

  /* ---------------- booking modal ---------------- */
  // The day lives in the address, so a notification, the palette or a reload all
  // land on the same board instead of a second copy of the date.
  function showDate(date) {
    S.date = date;
    if (location.hash === "#/events/" + date) LHMS.rerender();
    else location.hash = "#/events/" + date;
  }

  LHMS.uiActions["event-day"] = function (el) {
    showDate(U.addDays(day(), Number(el.getAttribute("data-shift")) || 0));
  };
  LHMS.uiActions["event-today"] = function () { showDate(LHMS.day || U.today()); };
  LHMS.uiActions["change:event-date"] = function (el) {
    if (el.value) showDate(el.value);
  };
  LHMS.uiActions["change:event-hall"] = function (el) { S.hall = el.value; LHMS.rerender(); };

  // The "Coming up" list holds days the board is not showing, so the calendar
  // moves first and the schedule behind the modal is the one being discussed.
  LHMS.uiActions["event-jump"] = function (el) {
    var date = el.getAttribute("data-date");
    if (date && date !== day()) showDate(date);
    LHMS.uiActions["event-open"](el);
  };

  LHMS.uiActions["event-new"] = function () {
    if (!canBook()) { ui.toast("Your role cannot book halls.", "error"); return; }
    var p = LHMS.get.property();
    var date = day() < U.today() ? U.today() : day();
    var halls = LHMS.halls().map(function (h) {
      return '<option value="' + h.id + '">' + ui.esc(h.name) + (h.capacity ? " — " + h.capacity + " guests" : "") + "</option>";
    }).join("");
    var resList = resOptions(p.id).map(function (r) {
      return '<option value="' + r.id + '">' + ui.esc(resLabel(r)) + "</option>";
    }).join("");
    ui.modal({
      title: "Book a hall",
      sub: "The quote below is the engine pricing the same window a booking would post.",
      wide: true,
      body: '<div class="grid g2" style="align-items:start">' +
        '<form data-form="event-book" id="event-form" class="stack" style="gap:12px">' +
          '<div class="field"><label>Hall</label><select class="input" id="eb-hall" data-change="event-quote" required>' + halls + "</select></div>" +
          '<div class="field"><label>Event name</label><input class="input" id="eb-title" name="title" placeholder="Annual general meeting" required /></div>' +
          '<div class="field"><label>Organiser</label><input class="input" id="eb-organizer" name="organizer" placeholder="Company or guest name" required /></div>' +
          '<div class="form-grid">' +
            '<div class="field"><label>Date</label><input type="date" class="input" id="eb-date" value="' + date + '" min="' + U.today() + '" data-change="event-quote" required /></div>' +
            '<div class="field"><label>Guests</label><input type="number" class="input" id="eb-guests" name="guests" min="1" value="40" /></div>' +
            '<div class="field"><label>From</label><input type="time" class="input" id="eb-start" value="10:00" data-change="event-quote" required /></div>' +
            '<div class="field"><label>To</label><input type="time" class="input" id="eb-end" value="14:00" data-change="event-quote" required /></div>' +
          "</div>" +
          '<div class="field"><label>Package</label><select class="input" id="eb-package" data-change="event-quote">' +
            '<option value="">Hourly</option><option value="half">Half day</option><option value="full">Full day</option></select></div>' +
          '<div class="divider-label">Add-ons</div>' +
          '<div class="stack" style="gap:6px">' + LHMS.eventExtras().map(function (x) {
            var price = LHMS.price.amount(x.id);
            return '<label class="check"><input type="checkbox" value="' + x.refId + '" data-addon data-qty="eb_qty_' + x.refId +
              '" data-change="event-quote"' + (price ? "" : " disabled") + " /> " + ui.esc(x.name) +
              '<span class="spacer"></span><span class="tiny muted">' + (price ? U.money(price.unit, price.currency) + " / " + x.unit : "not priced") + "</span>" +
              '<input type="number" class="input" id="eb_qty_' + x.refId + '" min="1" value="1" style="width:64px" data-change="event-quote" /></label>';
          }).join("") + "</div>" +
          '<div class="form-grid">' +
            '<div class="field"><label>Contact email</label><input type="email" class="input" id="eb-email" name="email" placeholder="events@example.com" /></div>' +
            '<div class="field"><label>Phone</label><input class="input" id="eb-phone" name="phone" placeholder="+234 …" /></div>' +
            '<div class="field"><label>Layout</label><input class="input" id="eb-layout" name="layout" placeholder="Theatre / banquet / cabaret" /></div>' +
            '<div class="field"><label>Status</label><select class="input" id="eb-status" name="status"><option>Confirmed</option><option>Hold</option></select></div>' +
          "</div>" +
          '<div class="field"><label>Bill to a reservation</label><select class="input" id="eb-res" name="reservationId" data-change="event-quote">' +
            '<option value="">Not billed to a room — invoiced by the events desk</option>' + resList + "</select></div>" +
          '<div class="field"><label>Notes</label><textarea class="input" id="eb-notes" name="notes" rows="2" placeholder="Access, load-in times, special requests"></textarea></div>' +
        "</form>" +
        '<div class="card" style="background:#fbf9f4"><div class="card-eyebrow" style="color:#8a7038">Live quote</div>' +
          '<div id="eb-quote">' + eventQuoteHTML(quoteFromForm()) + "</div></div>" +
      "</div>",
      footer: '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" data-act="event-save" id="eb-save">Create booking</button>',
      onMount: function () { repaintEventQuote(); }
    });
  };

  function addonsFromForm() {
    var out = [];
    document.querySelectorAll("[data-addon]").forEach(function (cb) {
      if (!cb.checked) return;
      var qtyEl = document.getElementById(cb.getAttribute("data-qty"));
      out.push({ id: cb.value, qty: Math.max(1, Number(qtyEl && qtyEl.value) || 1) });
    });
    return out;
  }

  function quoteFromForm() {
    var svc = LHMS.get.hall(val("eb-hall"));
    var opts = {
      date: val("eb-date"), start: val("eb-start"), end: val("eb-end"),
      package: val("eb-package") || null, addons: addonsFromForm()
    };
    return {
      svc: svc,
      quote: svc ? LHMS.price.hallQuote(svc.id, opts) : null,
      options: svc ? LHMS.price.hallOptions(svc.id, opts) : [],
      clash: svc ? LHMS.hallConflict(svc.refId, opts.date, opts.start, opts.end) : null
    };
  }

  function eventQuoteHTML(state) {
    if (!state.svc) return '<p class="small muted">Choose a hall to see what the window costs.</p>';
    if (state.clash) {
      return '<div class="notice danger mb12">' + ui.icon("alert") +
        "<div><b>Clash.</b> " + ui.esc(state.clash.title) + " already holds " + ui.esc(state.svc.name) +
        " from " + state.clash.start + " to " + state.clash.end + ". Change the window or pick another hall.</div></div>";
    }
    if (!state.quote) {
      return '<p class="small">This hall has no active price for the dates or times entered, so it cannot be sold. ' +
        '<a class="btn-link" href="#/prices">Open price setup</a></p>';
    }
    var q = state.quote;
    var qm = function (n, cur) { return U.money(n, cur || q.currency); };
    var line = function (label, value) {
      return '<div class="row between" style="font-size:11.5px;color:#6c634f;padding:3px 0"><span>' + label +
        '</span><b class="num" style="font-weight:600;color:var(--ink)">' + value + "</b></div>";
    };
    var hours = U.hoursBetween(val("eb-start"), val("eb-end"));
    return '<p class="small muted" style="line-height:1.6">' + ui.esc(q.hall.name) + " · " +
      ui.esc(U.pretty(q.date, "medium")) + " · " + q.start + "–" + q.end +
      (hours ? " (" + hours + " h)" : "") + " · " + ui.esc(q.packageName) +
      " · billed in " + ui.esc(q.currency) + "</p>" +
      (q.skipped && q.skipped.length ? '<div class="notice mt12">' + ui.icon("alert") +
        "<div>Left out of this quote: " + ui.esc(q.skipped.map(function (s) {
          return s.name + " (" + s.currency + ")";
        }).join(", ")) + ". One booking is billed in one money, and this hall is sold in " +
        ui.esc(q.currency) + ". Re-price the add-on, or book it on its own document.</div></div>" : "") +
      '<div class="divider-label">Lines</div>' +
      q.lines.map(function (l) {
        return line(ui.esc(l.name) + " <span class=\"tiny muted\">×" + l.qty + " " + ui.esc(l.unit) + "</span>", qm(l.amount, l.currency)) +
          (l.added && l.added.length ? l.added.map(function (a) {
            return '<div class="row between" style="font-size:10px;color:#8a7038;padding:0 0 0 10px"><span>' +
              ui.esc(a.label) + "</span><span class=\"num\">" + qm(a.amount, l.currency) + "</span></div>";
          }).join("") : "");
      }).join("") +
      '<div class="divider-label">Taxes</div>' +
      q.taxLines.map(function (t) { return line(ui.esc(t.label), qm(t.amount)); }).join("") +
      '<div class="row between" style="border-top:1px solid #e6d9ba;margin-top:10px;padding-top:9px">' +
        '<span class="tiny strong" style="letter-spacing:.08em;text-transform:uppercase;color:#7b6c4c">Total</span>' +
        '<b class="serif" style="font-size:24px;font-weight:500">' + qm(q.total) + "</b></div>" +
      '<div class="row between mt8"><span class="tiny">Deposit due (' + q.depositPct + "%)</span><b class=\"small\">" + qm(q.deposit) + "</b></div>" +
      (q.fxRate ? '<div class="row between"><span class="tiny">In the books · 1 ' + ui.esc(q.currency) +
        " = " + U.money(q.fxRate, LHMS.fx.base()) + '</span><b class="num tiny">' +
        U.money(q.baseAmount, LHMS.fx.base()) + "</b></div>" : "") +
      (q.price.surcharges && q.price.surcharges.cancelPct ? '<p class="tiny" style="margin-top:8px;color:#7b6c4c">Cancelling inside ' +
        q.price.surcharges.cancelHours + " hours of the start costs " + q.price.surcharges.cancelPct + "% of the total.</p>" : "") +
      (state.options.length > 1 ? '<div class="divider-label">Same window, other packages</div>' +
        state.options.map(function (o) {
          return '<div class="row between" style="font-size:11px;padding:2px 0"><span>' + ui.esc(o.label) +
            (o.cheapest ? ' <span class="chip green">lowest</span>' : "") + '</span><b class="num">' +
            U.money(o.quote.total, o.quote.currency) + "</b></div>";
        }).join("") : "") +
      (!LHMS.get.reservation(val("eb-res")) ? '<div class="notice info mt12">' + ui.icon("file") +
        '<div>Not linked to a reservation, so nothing reaches a folio. It is billed from <a href="#/invoices">Invoices &amp; billing</a> once confirmed.</div></div>' : "");
  }

  function repaintEventQuote() {
    var panel = document.getElementById("eb-quote");
    if (!panel) return;
    var state = quoteFromForm();
    panel.innerHTML = eventQuoteHTML(state);
    var btn = document.getElementById("eb-save");
    if (btn) btn.disabled = !state.quote || !!state.clash;
    // The package select only offers what the engine actually has amounts for.
    var sel = document.getElementById("eb-package");
    if (sel && state.options.length) {
      var keep = sel.value;
      sel.innerHTML = state.options.map(function (o) {
        return '<option value="' + (o.package || "") + '"' + (o.package === (keep || null) ? " selected" : "") + ">" +
          ui.esc(o.label) + " · " + U.money(o.quote.total, o.quote.currency) + "</option>";
      }).join("");
    }
  }

  LHMS.uiActions["change:event-quote"] = function () { repaintEventQuote(); };

  LHMS.uiActions["event-save"] = function () {
    var form = document.getElementById("event-form");
    if (!form || !form.reportValidity()) return;
    submitEventBook(form);
  };

  LHMS.forms["event-book"] = function (form) { submitEventBook(form); };

  function submitEventBook(form) {
    var result = LHMS.actions.createEvent({
      hallId: val("eb-hall"), title: val("eb-title"), organizer: val("eb-organizer"),
      date: val("eb-date"), start: val("eb-start"), end: val("eb-end"),
      package: val("eb-package") || null, guests: val("eb-guests"),
      email: val("eb-email"), phone: val("eb-phone"), layout: val("eb-layout"),
      reservationId: val("eb-res") || null, status: val("eb-status"), notes: val("eb-notes"),
      addons: addonsFromForm()
    });
    if (!result.ok) { ui.toast(result.error, "error"); repaintEventQuote(); return; }
    showDate(result.event.date);
    ui.toast(result.event.status === "Hold"
      ? result.event.hallName + " is on hold — nothing charged until it is confirmed."
      : result.event.title + " booked at " + U.money(result.event.total, result.event.currency) +
        (result.posted ? " and posted to " + (LHMS.get.reservation(result.event.reservationId) || {}).reference + "." : "."));
  }

  /* ---------------- booking detail ---------------- */
  LHMS.uiActions["event-open"] = function (el) {
    var evt = LHMS.get.event(el.getAttribute("data-event"));
    if (!evt) return;
    var res = LHMS.get.reservation(evt.reservationId);
    var fee = LHMS.price.cancellationFee(evt);
    var due = Math.round((evt.deposit || 0) - (evt.depositPaid || 0));
    // Every figure in this modal is the money the booking was sold in; the only
    // exception is the line that says what it is worth on the books.
    var em = function (n) { return U.money(n, evt.currency); };
    var line = function (label, value) {
      return '<div class="row between" style="font-size:11.5px;padding:3px 0"><span class="muted">' + label +
        '</span><b class="num">' + value + "</b></div>";
    };
    ui.modal({
      title: evt.title,
      // The modal escapes its sub slot, so the status reads as a chip in the
      // body instead of markup here.
      sub: evt.hallName + " · " + U.pretty(evt.date, "medium") + " · " + evt.start + "–" + evt.end +
        " · " + (evt.packageName || "Hourly"),
      wide: true,
      body: '<div class="grid g2" style="align-items:start;gap:18px">' +
        '<div><div class="row between" style="margin-bottom:8px">' +
          '<div class="card-eyebrow" style="color:#8a7038">What was sold</div>' +
          ui.chip(evt.status, STATUS_TONE[evt.status] || "") + "</div>" +
          '<div class="table-wrap"><table><thead><tr><th>Line</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead><tbody>' +
          evt.lines.map(function (l) {
            return "<tr><td>" + ui.esc(l.name) +
              (l.added && l.added.length ? '<div class="tiny muted">' + ui.esc(l.added.map(function (a) {
                return a.label + " " + U.money(a.amount, l.currency);
              }).join(" · ")) + "</div>" : "") + "</td>" +
              '<td class="num">' + l.qty + "</td>" +
              unitCell(l) +
              '<td class="num"><b>' + U.money(l.amount, l.currency) + "</b></td></tr>";
          }).join("") +
          '<tr><td colspan="3" class="muted">Subtotal</td><td class="num">' + em(evt.subtotal) + "</td></tr>" +
          (evt.taxLines || []).map(function (t) {
            return '<tr><td colspan="3" class="muted">' + ui.esc(t.label) + '</td><td class="num">' + em(t.amount) + "</td></tr>";
          }).join("") +
          '<tr><td colspan="3"><b>Total</b></td><td class="num"><b>' + em(evt.total) + "</b></td></tr>" +
          "</tbody></table></div>" +
          '<p class="tiny muted" style="margin-top:9px">List ' + ui.esc(evt.listName || "—") +
          " · priced " + ui.esc(evt.createdAt || "") + " by " + ui.esc(evt.createdBy || "—") +
          ". These lines are the ones that reached the folio; a later price change cannot rewrite them.</p>" +
        "</div>" +
        '<div class="stack">' +
          '<div class="card" style="background:#fbf9f4"><div class="card-eyebrow" style="color:#8a7038">Money · ' +
            ui.esc(evt.currency || LHMS.fx.base(evt.propertyId)) + "</div>" +
            line("Total quoted", em(evt.total)) +
            line("Deposit (" + (evt.depositPct || 0) + "%)", em(evt.deposit || 0)) +
            line("Deposit received", em(evt.depositPaid || 0)) +
            line("Deposit outstanding", em(due)) +
            (evt.fxRate ? line("On the books · 1 " + ui.esc(evt.currency) + " = " + U.money(evt.fxRate, LHMS.fx.base(evt.propertyId)),
              U.money(evt.baseAmount, LHMS.fx.base(evt.propertyId))) : "") +
            '<div class="divider-label">If cancelled</div>' +
            line("Notice window", (evt.cancelHours || 0) + " hours") +
            line("Fee (" + (evt.cancelPct || 0) + "%)", em(fee)) +
            (evt.cancelPct && !fee ? '<p class="tiny muted" style="margin-top:6px">No fee is owed while the start is more than ' +
              (evt.cancelHours || 0) + " hours away.</p>" : "") +
          "</div>" +
          '<div class="stack" style="gap:7px">' +
            '<div class="row between"><span class="small muted">Organiser</span><b class="small">' + ui.esc(evt.organizer) + "</b></div>" +
            (evt.email ? '<div class="row between"><span class="small muted">Email</span><b class="small">' + ui.esc(evt.email) + "</b></div>" : "") +
            (evt.phone ? '<div class="row between"><span class="small muted">Phone</span><b class="small">' + ui.esc(evt.phone) + "</b></div>" : "") +
            '<div class="row between"><span class="small muted">Guests</span><b class="small num">' + evt.guests +
              (evt.capacity ? " of " + evt.capacity : "") + "</b></div>" +
            (evt.layout ? '<div class="row between"><span class="small muted">Layout</span><b class="small">' + ui.esc(evt.layout) + "</b></div>" : "") +
          "</div>" +
          (res ? (function () {
            var f = LHMS.folio(res.id);
            return '<div class="notice success">' + ui.icon("receipt") + "<div>Billed to <b>" + ui.esc(res.reference) +
              "</b> · folio balance " + U.money(f.balance, f.currency) +
              '. <a class="btn-link" href="#/folio/' + res.id + '">Open folio</a></div></div>';
            })()
            : (function () {
                var doc = LHMS.invoiceFor("event", evt.id);
                return '<div class="notice' + (doc ? " success" : "") + '">' + ui.icon("file") + (doc
                  ? "<div>No room account, so it is billed on its own document · " +
                    U.money(LHMS.invoiceMoney(doc).balance, doc.currency) +
                    " outstanding. <a class=\"btn-link\" href=\"#/invoices/" + doc.id + "\">Open " + ui.esc(doc.number) + "</a></div>"
                  : "<div>No folio, so nothing reaches a room account. <a class=\"btn-link\" href=\"#/invoices\">Invoices &amp; billing</a> raises the document for it.</div>");
              })()) +
          (evt.notes ? '<div class="notice info">' + ui.icon("message") + "<div>" + ui.esc(evt.notes) + "</div></div>" : "") +
          (evt.status === "Cancelled" ? '<div class="notice danger">' + ui.icon("alert") + "<div><b>Cancelled.</b> " +
            ui.esc(evt.cancelReason || "") + " Fee charged " + U.money(evt.cancelFee || 0, evt.currency) + "; " +
            (evt.voidedCharges || []).length + " lines voided.</div></div>" : "") +
        "</div></div>",
      footer: '<button class="btn" data-close-modal>Close</button>' +
        (canBook() && evt.status === "Hold" ? '<button class="btn" data-act="event-confirm" data-event="' + evt.id + '">Confirm booking</button>' : "") +
        (canBook() && evt.status === "Confirmed" && due > 0 && evt.reservationId ?
          '<button class="btn" data-act="event-deposit" data-event="' + evt.id + '">Record deposit</button>' : "") +
        (canBook() && evt.status !== "Cancelled" ?
          '<button class="btn danger" data-act="event-cancel" data-event="' + evt.id + '">Cancel booking</button>' : "")
    });
  };

  LHMS.uiActions["event-confirm"] = function (el) {
    var result = LHMS.actions.confirmEvent(el.getAttribute("data-event"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.event.title + " confirmed" + (result.posted ? " and posted to the folio." : " — no folio, so it stays an invoice in waiting."));
  };

  LHMS.uiActions["event-deposit"] = function (el) {
    var result = LHMS.actions.takeEventDeposit(el.getAttribute("data-event"), "Transfer");
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Deposit of " + U.money(result.payment.amount, result.payment.currency) + " recorded against " + result.event.title + ".");
  };

  LHMS.uiActions["event-cancel"] = function (el) {
    var evt = LHMS.get.event(el.getAttribute("data-event"));
    if (!evt) return;
    var fee = LHMS.price.cancellationFee(evt);
    ui.modal({
      title: "Cancel " + evt.title,
      sub: "The booking row is kept and its posted lines are voided — nothing financial is deleted.",
      slim: true,
      body: '<form data-form="event-cancel" id="cancel-form">' +
        '<div class="notice mb12">' + ui.icon("alert") + "<div>" + (fee > 0
          ? "<b>" + U.money(fee, evt.currency) + "</b> (" + (evt.cancelPct || 0) + "%) will be charged as a cancellation fee — the event is inside its " +
            (evt.cancelHours || 0) + "-hour notice window."
          : "No fee is owed: the event is outside the notice window agreed on the price list.") + "</div></div>" +
        '<div class="field"><label>Reason</label><textarea class="input" name="reason" rows="3" required placeholder="Required — written to the audit trail"></textarea></div>' +
        '<input type="hidden" name="eventId" value="' + evt.id + '" /></form>',
      footer: '<button class="btn" data-act="event-open" data-event="' + evt.id + '">Back</button>' +
        '<button class="btn danger" data-act="event-cancel-yes">Cancel booking</button>'
    });
  };

  LHMS.uiActions["event-cancel-yes"] = function () {
    var form = document.getElementById("cancel-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.cancelEvent(d.eventId, d.reason);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.event.title + " cancelled" + (result.fee ? " with a " + U.money(result.fee, result.event.currency) + " fee." : " at no cost."));
  };

  LHMS.uiActions["export-events"] = function () {
    var rows = [["Date", "Hall", "Event", "Organiser", "Start", "End", "Hours", "Package", "Status",
      "Subtotal", "Tax", "Total", "Deposit", "Deposit paid", "Currency", "Total on the books", "List"]];
    LHMS.eventsOf(LHMS.session.propertyId).forEach(function (e) {
      rows.push([e.date, e.hallName, e.title, e.organizer, e.start, e.end, e.hours, e.packageName || "Hourly", e.status,
        e.subtotal, e.tax, e.total, e.deposit, e.depositPaid || 0, e.currency || LHMS.fx.base(e.propertyId),
        LHMS.fx.baseOf(e), e.listName || ""]);
    });
    ui.csv("aurelia-hall-bookings.csv", rows);
    ui.toast("Hall bookings exported.");
  };

  /* ============================================================
     LAUNDRY BOARD
     ============================================================ */
  LHMS.pages.laundry = function () {
    var p = LHMS.get.property();
    var orders = LHMS.laundryOf(p.id);
    var open = orders.filter(function (o) { return o.status !== "Collected"; });
    var express = open.filter(function (o) { return o.express; });
    var late = open.filter(function (o) { return new Date(o.dueAt).getTime() < Date.now(); });
    var value = open.reduce(function (s, o) { return s + LHMS.fx.baseOf(o); }, 0);
    var baseCur = LHMS.fx.base(p.id);

    return ui.pageHead({
      eyebrow: "Housekeeping · " + p.short,
      title: "Laundry board",
      sub: open.length + " orders are with the laundry, " + express.length + " of them express and " +
        late.length + " past their collection time. Every order was priced by the engine before it was posted to a folio.",
      actions: '<button class="btn" data-act="export-laundry">' + ui.icon("download", 14) + " Export</button>" +
        (canRun() ? '<button class="btn primary" data-act="laundry-new">' + ui.icon("plus", 14) + " New order</button>" : "")
    }) +
      '<div class="toolbar">' +
        '<div class="tabs">' + [["open", "On the board"], ["all", "Everything"], ["express", "Express"]]
          .map(function (t) {
            return '<button class="tab' + (S.laundryView === t[0] ? " active" : "") + '" data-act="laundry-view" data-view="' + t[0] + '">' + t[1] + "</button>";
          }).join("") + "</div>" +
        '<span class="spacer"></span>' +
        '<span class="chip ' + (late.length ? "red" : "green") + '">' + late.length + " past due</span>" +
      "</div>" +
      '<div class="kpis">' +
        ui.kpi("On the board", open.length, orders.length + " taken in total", { icon: "box", accent: open.length ? "accent-navy" : "accent-green" }) +
        ui.kpi("Express", express.length, "Half the turnaround, surcharged", { icon: "clock", accent: express.length ? "accent-amber" : "" }) +
        ui.kpi("Past due", late.length, late.length ? "Chase the collection" : "Everything on time", { icon: "alert", accent: late.length ? "accent-red" : "accent-green" }) +
        ui.kpi("Open value", U.compact(value, baseCur), "Valued in " + baseCur + ", already on guest folios", { icon: "tag" }) +
        ui.kpi("Services", LHMS.laundryServices().filter(function (s) { return s.active; }).length, "On the price list", { icon: "list" }) +
      "</div>" +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;gap:16px">' +
        '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("refresh", 15) +
          'Work in progress</div><div class="card-sub">An order only moves forward. Ready orders notify the front desk for delivery.</div></div></div>' +
          boardHTML(filteredOrders(orders)) +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("Price list", '<div class="stack" style="gap:10px">' + LHMS.laundryServices().map(function (s) {
            var a = LHMS.price.amount(s.id, { qty: 1 });
            var meta = (s.turnaroundMins ? Math.round(s.turnaroundMins / 60) + " h turnaround" : "no turnaround set") +
              " · per " + ui.esc(s.unit) + (s.active ? "" : " · off the menu");
            // One narrow column: the name and its promise share a line group and
            // only the figure sits opposite, so nothing breaks mid-number.
            return '<div class="row between" style="gap:10px;align-items:baseline">' +
              '<div style="min-width:0"><div class="small" style="font-weight:600">' + ui.esc(s.name) + "</div>" +
              '<div class="tiny muted">' + meta + "</div></div>" +
              '<b class="num" style="white-space:nowrap">' + (a ? U.money(a.unit, a.currency) : "—") + "</b></div>";
          }).join("") + "</div>", LHMS.can("configure_prices") ? '<a class="btn sm" href="#/prices">Edit</a>' : "",
          "Express is charged on top", "tag") +
          ui.sectionCard("How an order is handled", '<div class="stack" style="gap:9px">' +
            '<div class="row between"><span class="small">Quantities priced</span><span class="tiny muted">by the engine</span></div>' +
            '<div class="row between"><span class="small">Posted to</span><span class="tiny muted">the guest folio</span></div>' +
            '<div class="row between"><span class="small">Taxes</span><span class="tiny muted">as separate lines</span></div>' +
            '<div class="row between"><span class="small">Collection time</span><span class="tiny muted">slowest item wins</span></div>' +
            '<div class="notice info" style="margin-top:4px">' + ui.icon("info") +
            "<div>An order keeps the price it was taken at. Re-pricing a garment later cannot rewrite washing already on a folio.</div></div>" +
          "</div>", "", "Priced once, at intake", "receipt") +
          (canRun() ? "" : '<div class="notice">' + ui.icon("lock") +
            "<div><b>Read-only.</b> Taking and moving laundry needs the laundry permission for your role.</div></div>") +
        "</div>" +
      "</div>";
  };

  function filteredOrders(orders) {
    if (S.laundryView === "all") return orders;
    if (S.laundryView === "express") return orders.filter(function (o) { return o.express && o.status !== "Collected"; });
    return orders.filter(function (o) { return o.status !== "Collected"; });
  }

  var STAGE_TONE = { Received: "#c9b07a", "In progress": "#4b6d92", Ready: "#6e997d", Collected: "#a8a294" };

  function boardHTML(orders) {
    var stages = LHMS.LAUNDRY_STAGES;
    return '<div class="board">' + stages.map(function (stage) {
      var list = orders.filter(function (o) { return o.status === stage; });
      return '<div class="board-col"><div class="board-col-head"><span>' + stage + '</span><span class="count">' +
        list.length + "</span></div>" +
        (list.length ? list.map(function (o) { return orderCardHTML(o, stage, stages); }).join("") :
          '<div class="empty" style="padding:18px 10px;font-size:10px"><b>Empty</b>No orders here.</div>') +
        "</div>";
    }).join("") + "</div>";
  }

  // Laundry runs in hours, not minutes: a shirt is not "599m" away, it is
  // tomorrow morning. The chip says overdue the moment the promise is broken.
  function dueChip(order, stage) {
    if (stage === "Collected") return '<span class="sla ok">Returned</span>';
    var mins = Math.round((new Date(order.dueAt).getTime() - Date.now()) / 60000);
    var abs = Math.abs(mins);
    var span = abs >= 120 ? Math.round(abs / 60) + "h" : abs + "m";
    var cls = mins < 0 ? "late" : abs <= 120 ? "soon" : "ok";
    return '<span class="sla ' + cls + '">' + (mins < 0 ? span + " overdue" : span + " left") + "</span>";
  }

  function orderCardHTML(o, stage, stages) {
    var next = stages[stages.indexOf(stage) + 1];
    var pieces = o.lines.reduce(function (s, l) { return s + l.qty; }, 0);
    return '<div class="board-card" style="--kind:' + STAGE_TONE[stage] + '">' +
      '<div class="row between" style="align-items:flex-start"><b>Room ' + ui.esc(o.roomNumber || "—") + "</b>" +
        dueChip(o, stage) + "</div>" +
      '<span>' + ui.esc(ui.guestName(o.guestId)) + " · " + pieces + " pieces · " + o.lines.length + " lines</span>" +
      (o.express ? '<span style="color:#8a7038;font-weight:700">Express · due ' + ui.esc(U.timeOf(o.dueAt)) + "</span>" : "") +
      '<div class="bc-foot" style="flex-wrap:wrap;gap:4px"><b class="num small">' + U.money(o.total, o.currency) + "</b>" +
      '<div class="row" style="gap:3px">' +
        '<button class="btn sm ghost" data-act="laundry-open" data-order="' + o.id + '">Details</button>' +
        (next && canRun() ? '<button class="btn sm primary" data-act="laundry-move" data-order="' + o.id + '" data-stage="' + next + '">' +
          (next === "Collected" ? "Return" : "To " + next) + "</button>" : "") +
      "</div></div></div>";
  }

  LHMS.uiActions["laundry-view"] = function (el) {
    S.laundryView = el.getAttribute("data-view");
    LHMS.rerender();
  };

  LHMS.uiActions["laundry-move"] = function (el) {
    var result = LHMS.actions.setLaundryStatus(el.getAttribute("data-order"), el.getAttribute("data-stage"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    LHMS.rerender();
    ui.toast(result.order.ref + " is " + result.order.status.toLowerCase() + ".");
  };

  /* ---------------- order modal ---------------- */
  LHMS.uiActions["laundry-new"] = function () {
    if (!canRun()) { ui.toast("Your role cannot take laundry orders.", "error"); return; }
    var p = LHMS.get.property();
    var list = resOptions(p.id);
    if (!list.length) {
      ui.toast("No guest is staying with us, so there is nothing to hang laundry on.", "error");
      return;
    }
    var inHouse = list.filter(function (r) { return r.status === "In-house"; });
    var sel = inHouse[0] || list[0];
    ui.modal({
      title: "Take a laundry order",
      sub: "Quantities price themselves; the total and the collection time come from the same engine a folio uses.",
      wide: true,
      body: '<div class="grid g2" style="align-items:start">' +
        '<form data-form="laundry-order" id="laundry-form" class="stack" style="gap:12px">' +
          '<div class="field"><label>Guest</label><select class="input" id="ld-res" name="reservationId">' +
            list.map(function (r) {
              return '<option value="' + r.id + '"' + (r.id === sel.id ? " selected" : "") + ">" +
                ui.esc(resLabel(r)) + " · " + r.status + "</option>";
            }).join("") + "</select></div>" +
          '<div class="divider-label">Pieces</div>' +
          '<div class="stack" style="gap:6px">' + LHMS.laundryServices().map(function (s) {
            var a = LHMS.price.amount(s.id, { qty: 1 });
            return '<div class="row between" style="gap:10px"><span class="small" style="flex:1">' + ui.esc(s.name) +
              '<span class="tiny muted" style="display:block">' + (a ? U.money(a.unit, a.currency) + " per " + ui.esc(s.unit) : "not priced") +
              (s.turnaroundMins ? " · " + Math.round(s.turnaroundMins / 60) + " h" : "") + "</span></span>" +
              '<input type="number" class="input" id="ld_qty_' + s.refId + '" min="0" value="0" style="width:78px" ' +
              (a ? "" : "disabled ") + 'data-change="laundry-quote" data-live="laundry-echo" aria-label="' + ui.esc(s.name) + ' quantity" /></div>';
          }).join("") + "</div>" +
          '<label class="check mt8"><input type="checkbox" id="ld-express" data-change="laundry-quote" /> ' +
            "Express service — halves the turnaround and is charged on top</label>" +
          '<div class="field"><label>Notes</label><textarea class="input" id="ld-notes" name="notes" rows="2" placeholder="Delicate, no bleach, hang in wardrobe"></textarea></div>' +
        "</form>" +
        '<div class="card" style="background:#fbf9f4"><div id="ld-quote">' + laundryQuoteHTML(laundryFromForm()) + "</div></div>" +
      "</div>",
      footer: '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" data-act="laundry-save" id="ld-save">Take order</button>',
      onMount: function () { repaintLaundryQuote(); }
    });
  };

  function laundryFromForm() {
    var items = [];
    document.querySelectorAll('[id^="ld_qty_"]').forEach(function (el) {
      var qty = Number(el.value) || 0;
      if (qty > 0) items.push({ id: el.id.replace("ld_qty_", ""), qty: qty });
    });
    var expressEl = document.getElementById("ld-express");
    return { items: items, quote: LHMS.price.laundryQuote(items, { express: !!(expressEl && expressEl.checked) }) };
  }

  function laundryQuoteHTML(state) {
    var line = function (label, value) {
      return '<div class="row between" style="font-size:11.5px;color:#6c634f;padding:3px 0"><span>' + label +
        '</span><b class="num" style="color:var(--ink)">' + value + "</b></div>";
    };
    if (!state.quote) {
      return '<p class="card-eyebrow" style="color:#8a7038">Live quote</p>' +
        '<p class="small muted">Enter at least one quantity. An item that is off the menu cannot be ordered.</p>';
    }
    var q = state.quote;
    var qm = function (n, cur) { return U.money(n, cur || q.currency); };
    // The guest's account is already kept in one money; an order in another would
    // be a second bill wearing the same heading, so the panel says so before the
    // desk commits rather than after.
    var resId = val("ld-res");
    var folioCur = resId ? LHMS.folio(resId).currency : null;
    return '<p class="card-eyebrow" style="color:#8a7038">Live quote</p>' +
      '<p class="tiny muted" style="margin-bottom:6px">Billed in ' + ui.esc(q.currency) +
      (folioCur && folioCur !== q.currency ? ' — but the folio for this guest is kept in ' + ui.esc(folioCur) +
        ", so this order cannot be posted to it.</p>" : "</p>") +
      (q.skipped && q.skipped.length ? '<div class="notice mb12">' + ui.icon("alert") +
        "<div>Left out of this order: " + ui.esc(q.skipped.map(function (s) {
          return s.name + " (" + s.currency + ")";
        }).join(", ")) + ". One order is billed in one money.</div></div>" : "") +
      q.lines.map(function (l) {
        return line(ui.esc(l.name) + " <span class=\"tiny muted\">×" + l.qty + "</span>", qm(l.amount, l.currency)) +
          (l.added && l.added.length ? l.added.map(function (a) {
            return '<div class="row between" style="font-size:10px;color:#8a7038;padding-left:10px"><span>' +
              ui.esc(a.label) + '</span><span class="num">' + qm(a.amount, l.currency) + "</span></div>";
          }).join("") : "");
      }).join("") +
      '<div class="divider-label">Taxes</div>' +
      q.taxLines.map(function (t) { return line(ui.esc(t.label), qm(t.amount)); }).join("") +
      '<div class="row between" style="border-top:1px solid #e6d9ba;margin-top:10px;padding-top:9px">' +
        '<span class="tiny strong" style="letter-spacing:.08em;text-transform:uppercase;color:#7b6c4c">Total</span>' +
        '<b class="serif" style="font-size:24px;font-weight:500">' + qm(q.total) + "</b></div>" +
      '<div class="notice info mt12">' + ui.icon("clock") + "<div>Ready in about " +
        (q.etaMins >= 120 ? Math.round(q.etaMins / 60) + " hours" : q.etaMins + " minutes") +
        " — the slowest item on the order sets the time" +
        (q.express ? ", <b>express</b>" : "") + ".</div></div>";
  }

  function repaintLaundryQuote() {
    var panel = document.getElementById("ld-quote");
    if (!panel) return;
    var state = laundryFromForm();
    panel.innerHTML = laundryQuoteHTML(state);
    var btn = document.getElementById("ld-save");
    if (btn) btn.disabled = !state.quote;
  }

  LHMS.uiActions["change:laundry-quote"] = function () { repaintLaundryQuote(); };
  // Typing a quantity only repaints when the field is committed, so the number
  // the price is taken from is always a complete quantity.
  LHMS.uiActions["live:laundry-echo"] = function () { repaintLaundryQuote(); };

  LHMS.uiActions["laundry-save"] = function () {
    var form = document.getElementById("laundry-form");
    if (!form) return;
    submitLaundryOrder(form);
  };

  LHMS.forms["laundry-order"] = function (form) { submitLaundryOrder(form); };

  function submitLaundryOrder(form) {
    var items = {};
    laundryFromForm().items.forEach(function (i) { items[i.id] = i.qty; });
    var result = LHMS.actions.createLaundryOrder({
      reservationId: val("ld-res"), items: items,
      express: !!(document.getElementById("ld-express") || {}).checked,
      notes: val("ld-notes")
    });
    if (!result.ok) { ui.toast(result.error, "error"); repaintLaundryQuote(); return; }
    ui.closeModal();
    LHMS.rerender();
    ui.toast(result.order.ref + " taken for room " + result.order.roomNumber + " — " +
      U.money(result.order.total, result.order.currency) +
      " posted to the folio, ready by " + U.timeOf(result.order.dueAt) + ".");
  }

  LHMS.uiActions["laundry-open"] = function (el) {
    var o = LHMS.get.laundryOrder(el.getAttribute("data-order"));
    if (!o) return;
    var res = LHMS.get.reservation(o.reservationId);
    var om = function (n) { return U.money(n, o.currency); };
    ui.modal({
      title: o.ref + " · Room " + (o.roomNumber || "—"),
      // The modal escapes its sub slot, so the status is repeated as a chip in
      // the body rather than as markup here.
      sub: ui.guestName(o.guestId) + " · " + o.status + (o.express ? " · express" : ""),
      body: '<div class="row" style="gap:8px;margin-bottom:10px">' +
        ui.chip(o.status, o.status === "Collected" ? "navy" : o.status === "Ready" ? "green" : "amber") +
        (o.express ? ui.chip("Express", "gold") : "") +
        '<span class="tiny muted" style="margin-left:auto">Priced when taken, not when printed</span></div>' +
        '<div class="table-wrap"><table><thead><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Amount</th></tr></thead><tbody>' +
        o.lines.map(function (l) {
          return "<tr><td>" + ui.esc(l.name) +
            (l.added && l.added.length ? '<div class="tiny muted">' + ui.esc(l.added.map(function (a) {
              return a.label + " " + U.money(a.amount, l.currency);
            }).join(" · ")) + "</div>" : "") + "</td>" +
            '<td class="num">' + l.qty + "</td>" +
            unitCell(l) +
            '<td class="num"><b>' + U.money(l.amount, l.currency) + "</b></td></tr>";
        }).join("") +
        '<tr><td colspan="3" class="muted">Subtotal</td><td class="num">' + om(o.subtotal) + "</td></tr>" +
        (o.taxLines || []).map(function (t) {
          return '<tr><td colspan="3" class="muted">' + ui.esc(t.label) + '</td><td class="num">' + om(t.amount) + "</td></tr>";
        }).join("") +
        '<tr><td colspan="3"><b>Total posted to the folio</b></td><td class="num"><b>' + om(o.total) + "</b></td></tr>" +
        (o.fxRate ? '<tr><td colspan="3" class="muted tiny">On the books · 1 ' + ui.esc(o.currency) + " = " +
          U.money(o.fxRate, LHMS.fx.base(o.propertyId)) + '</td><td class="num tiny">' +
          U.money(o.baseAmount, LHMS.fx.base(o.propertyId)) + "</td></tr>" : "") +
        "</tbody></table></div>" +
        '<div class="row between mt12"><span class="small muted">Taken</span><b class="small">' +
          ui.esc(U.timeOf(o.createdAt)) + " · " + ui.esc(o.handledBy || "") + "</b></div>" +
        '<div class="row between mt8"><span class="small muted">Collection</span><b class="small">' +
          ui.esc(U.timeOf(o.dueAt)) + " " + dueChip(o, o.status) + "</b></div>" +
        (o.returnedAt ? '<div class="row between mt8"><span class="small muted">Returned</span><b class="small">' +
          ui.esc(U.timeOf(o.returnedAt)) + "</b></div>" : "") +
        (o.notes ? '<div class="notice info mt12">' + ui.icon("message") + "<div>" + ui.esc(o.notes) + "</div></div>" : "") +
        (res ? (function () {
          var f = LHMS.folio(res.id);
          return '<div class="notice mt12">' + ui.icon("receipt") + "<div>On folio <b>" + ui.esc(res.reference) +
            "</b> · " + o.charges.length + " lines · balance " + U.money(f.balance, f.currency) +
            '. <a class="btn-link" href="#/folio/' + res.id + '">Open folio</a></div></div>';
        })() : "") +
        '<p class="tiny muted" style="margin-top:10px">Each line keeps the price row and list it was taken on, so a later ' +
        "re-price cannot rewrite this order.</p>",
      footer: '<button class="btn" data-close-modal>Close</button>' +
        (function () {
          if (!canRun() || o.status === "Collected") return "";
          // Same words as the card button, so the detail never promises a
          // different move than the board already offered.
          var next = LHMS.LAUNDRY_STAGES[LHMS.LAUNDRY_STAGES.indexOf(o.status) + 1];
          if (!next) return "";
          return '<button class="btn primary" data-act="laundry-move" data-order="' + o.id + '" data-stage="' + next + '">' +
            (next === "Collected" ? "Return" : "To " + next) + "</button>";
        })()
    });
  };

  LHMS.uiActions["export-laundry"] = function () {
    var rows = [["Ref", "Room", "Guest", "Status", "Express", "Taken", "Due", "Returned", "Lines",
      "Subtotal", "Tax", "Total", "Currency", "Total on the books", "Folio"]];
    LHMS.laundryOf(LHMS.session.propertyId).forEach(function (o) {
      rows.push([o.ref, o.roomNumber, ui.guestName(o.guestId), o.status, o.express ? "yes" : "",
        o.createdAt, o.dueAt, o.returnedAt || "", o.lines.length, o.subtotal, o.tax, o.total,
        o.currency || LHMS.fx.base(o.propertyId), LHMS.fx.baseOf(o),
        (LHMS.get.reservation(o.reservationId) || {}).reference || ""]);
    });
    ui.csv("aurelia-laundry-orders.csv", rows);
    ui.toast("Laundry orders exported.");
  };
})();
