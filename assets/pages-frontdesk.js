/* ============================================================
   Front desk — today, rooms, reservations, check-in, folio
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var S = (LHMS.state = LHMS.state || {});
  var view = (LHMS.views = LHMS.views || {});
  var db = LHMS.db;

  if (S.todayTab == null) S.todayTab = "arrivals";
  if (S.floor == null) S.floor = "all";
  if (S.resQuery == null) S.resQuery = "";
  if (S.resStatus == null) S.resStatus = "all";

  /* ---------------- shared cells ---------------- */
  // A folio is billed in one money — the first priced line fixes it — so its
  // figures read with that money's sign, not the property's.
  function fm(f, n) { return U.money(n, f.currency); }
  // What the balance is on the books, shown only when the guest's money and the
  // property's are not the same. The figure is the one frozen on the lines at the
  // folio's pinned rate, so a rate moved later cannot restate a stay.
  function booksRow(f) {
    if (f.currency === LHMS.fx.base()) return "";
    return '<div class="ft-row"><span class="tiny">Balance on the books · 1 ' + ui.esc(f.currency) +
      " = " + U.money(f.fxRate) + '</span><span class="num tiny">' + U.money(f.baseBalance) + "</span></div>";
  }
  function guestSub(g) {
    if (!g) return "Guest profile missing";
    return g.tier + " · " + g.country + (g.tags && g.tags.length ? " · " + g.tags[0] : "");
  }
  view.who = function (guestId, sub) {
    var g = LHMS.get.guest(guestId);
    return '<div class="who">' + ui.avatar(g ? g.name : "Guest") + '<div style="min-width:0"><div class="who-name">' +
      ui.esc(g ? g.name : "Guest") + (g && (g.tier === "Platinum" || g.tier === "Gold") ? ' <span class="vip">' + (g.tier === "Platinum" ? "PLATINUM" : "GOLD") + "</span>" : "") +
      '</div><div class="who-sub">' + ui.esc(sub || guestSub(g)) + "</div></div></div>";
  };
  view.balance = function (resId) {
    var f = LHMS.folio(resId);
    if (f.balance <= 0) return '<span class="chip green">Settled</span>';
    return '<span class="' + (f.balance > 200000 ? "chip amber" : "chip") + '">' + U.money(f.balance, f.currency) + "</span>";
  };
  view.stayLine = function (res) {
    return U.pretty(res.checkIn, "short") + " → " + U.pretty(res.checkOut, "short") + " · " + U.nights(res.checkIn, res.checkOut) + "n";
  };

  /* ============================================================
     TODAY
     ============================================================ */
  LHMS.pages.today = function () {
    var p = LHMS.get.property();
    var m = LHMS.calc.metrics(p.id);
    var arrivals = LHMS.calc.arrivals(p.id);
    var departures = LHMS.calc.departures(p.id);
    var inHouse = LHMS.calc.inHouse(p.id);
    var tab = S.todayTab;

    var tabs = [
      { k: "arrivals", label: "Arrivals", n: arrivals.length },
      { k: "departures", label: "Departures", n: departures.length },
      { k: "inhouse", label: "In house", n: inHouse.length }
    ].map(function (t) {
      return '<button class="tab' + (t.k === tab ? " active" : "") + '" data-act="today-tab" data-tab="' + t.k + '">' + t.label + '<span class="count">' + t.n + "</span></button>";
    }).join("");

    var body = "";
    if (tab === "arrivals") {
      body = arrivals.length ? '<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Guest</th><th>Room</th><th>Nights</th><th>Arrival</th><th>Folio</th><th></th></tr></thead><tbody>' +
        arrivals.map(function (r) {
          var g = LHMS.get.guest(r.guestId);
          var room = LHMS.get.room(r.roomId);
          return '<tr><td>' + view.who(r.guestId, r.vip ? "VIP · " + (g ? g.tier : "") : guestSub(g)) + "</td>" +
            '<td><span class="room-no">' + (room ? room.number : "—") + '</span><div class="tiny muted">' + ui.typeName(r.roomTypeId) + "</div></td>" +
            '<td class="num">' + U.nights(r.checkIn, r.checkOut) + "</td>" +
            '<td>' + (r.eta ? ui.esc(r.eta) : "15:00") + '<div class="tiny muted">' + (r.notes ? ui.esc(r.notes.slice(0, 34)) : "No notes") + "</div></td>" +
            "<td>" + view.balance(r.id) + "</td>" +
            '<td class="right"><button class="btn sm primary" data-act="checkin-link" data-res="' + r.id + '">Check in ' + ui.icon("right", 11) + "</button></td></tr>";
        }).join("") + "</tbody></table></div>" : ui.empty("No arrivals expected", "All of today's arrivals have been checked in.", "checkCircle");
    } else if (tab === "departures") {
      body = departures.length ? '<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Guest</th><th>Room</th><th>Stay</th><th>Balance</th><th></th></tr></thead><tbody>' +
        departures.map(function (r) {
          var room = LHMS.get.room(r.roomId);
          return '<tr><td>' + view.who(r.guestId) + "</td>" +
            '<td><span class="room-no">' + (room ? room.number : "—") + '</span><div class="tiny muted">' + ui.typeName(r.roomTypeId) + "</div></td>" +
            "<td>" + view.stayLine(r) + "</td><td>" + view.balance(r.id) + "</td>" +
            '<td class="right"><button class="btn sm" data-act="checkout-open" data-res="' + r.id + '">Check out</button></td></tr>';
        }).join("") + "</tbody></table></div>" : ui.empty("No departures today", "A quiet turnover day for the front desk.", "key");
    } else {
      body = '<div class="table-wrap" style="border:0"><table class="data"><thead><tr><th>Guest</th><th>Room</th><th>Departure</th><th>Rate plan</th><th>Balance</th><th></th></tr></thead><tbody>' +
        inHouse.map(function (r) {
          var room = LHMS.get.room(r.roomId);
          return '<tr><td>' + view.who(r.guestId) + "</td><td><span class=\"room-no\">" + (room ? room.number : "—") + '</span><div class="tiny muted">' + (room ? "Floor " + room.floor : "") + "</div></td>" +
            "<td>" + U.pretty(r.checkOut, "short") + '<div class="tiny muted">' + U.nights(LHMS.day, r.checkOut) + " nights left</div></td>" +
            "<td>" + ui.esc(ui.planName(r.ratePlanId)) + "</td>" +
            '<td>' + view.balance(r.id) + "</td>" +
            '<td class="right"><a class="btn sm" href="#/folio/' + r.id + '">Folio</a></td></tr>';
        }).join("") + "</tbody></table></div>";
    }

    var vipIn = inHouse.concat(arrivals).filter(function (r) {
      var g = LHMS.get.guest(r.guestId);
      return r.vip || (g && g.tier === "Platinum");
    }).slice(0, 4);

    var attention = [
      { label: "Departing folios with a balance", value: departures.filter(function (r) { return LHMS.folio(r.id).balance > 0; }).length, href: "#/check-out", icon: "receipt" },
      { label: "Rooms out of order or service", value: m.ooo, href: "#/room-map", icon: "wrench" },
      { label: "Guest requests at risk of SLA", value: LHMS.tasksOf().filter(function (t) { return t.status !== "Done" && new Date(t.dueAt) - Date.now() < 20 * 60000; }).length, href: "#/requests", icon: "clock" },
      { label: "Dirty rooms awaiting turnover", value: m.dirty, href: "#/housekeeping", icon: "broom" }
    ];

    return ui.pageHead({
      eyebrow: ui.todayLong() + " · " + p.short,
      title: ui.timeGreeting() + ", " + (LHMS.session.name || "team").split(" ")[0] + ".",
      sub: "A live view of the house: " + arrivals.length + " arrivals, " + departures.length + " departures and " + m.inHouse + " guests in residence.",
      actions: '<a class="btn" href="#/room-map">' + ui.icon("grid", 14) + ' Room map</a><a class="btn primary" href="#/booking/new">' + ui.icon("plus", 14) + " New booking</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Arrivals", arrivals.length, '<span class="chip gold">' + m.vipArrivals + " VIP</span> expected today", { icon: "key", accent: "accent-navy" }) +
        ui.kpi("Departures", departures.length, '<span class="chip">' + departures.filter(function (r) { return LHMS.folio(r.id).balance === 0; }).length + " settled</span> before arrival", { icon: "logout" }) +
        ui.kpi("In residence", m.inHouse, '<span class="chip green">' + m.availableTonight + "</span> rooms still available tonight", { icon: "users", accent: "accent-green" }) +
        ui.kpi("Occupancy", m.occupancy + "<small>%</small>", '<span class="chip blue">' + m.occupied + "/" + m.sellable + "</span> keys sold · ADR " + U.compact(m.adr), { icon: "chart" }) +
        ui.kpi("Balance on house", U.compact(m.balanceDue), '<span class="chip">' + departures.length + "</span> folios to settle today", { icon: "card" }) +
      "</div>" +

      '<div class="grid g-2-1">' +
        '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("calendar", 15) + 'Front desk queue</div><div class="card-sub">Priority order: VIP arrivals, departing balances, then in-house requests.</div></div><div class="tabs">' + tabs + "</div></div>" + body + "</section>" +

        '<div class="stack">' +
          '<section class="banner"><div style="position:relative;z-index:1;flex:1"><p class="card-eyebrow" style="color:var(--gold-2)">Concierge note</p><h3>' + (vipIn.length ? vipIn[0] ? "VIP on the house today" : "A calm house" : "A calm house") + '</h3><p>' + (vipIn.length ? ui.esc((LHMS.get.guest(vipIn[0].guestId) || {}).name || "VIP") + " · " + (LHMS.get.room(vipIn[0].roomId) || {}).number + " — " + ui.esc(ui.typeName(vipIn[0].roomTypeId)) + ". Welcome amenity is confirmed; GM to greet on arrival." : "No Platinum arrivals on the books. Use the quiet window to walk the suites.") + '</p><div class="row mt12" style="position:relative;z-index:1"><a class="btn sm" href="#/guests">Guest directory</a><a class="btn sm" href="#/requests">Open requests</a></div></div></section>' +

          ui.sectionCard("Needs attention", '<div class="list">' + attention.map(function (a) {
            return '<a class="list-row" href="' + a.href + '" style="text-decoration:none"><div class="lr-main"><span class="avatar sm">' + ui.icon(a.icon, 13) + '</span><div><div class="lr-title">' + a.label + '</div><div class="lr-sub">' + (a.value ? "Action required" : "Up to date") + "</div></div></div>" +
              '<div class="lr-meta"><span class="chip ' + (a.value > 0 ? "amber" : "green") + '">' + a.value + "</span></div></a>";
          }).join("") + "</div>", "", "Live exceptions across the property", "alert") +

          ui.sectionCard("Today's VIPs", vipIn.length ? '<div class="list">' + vipIn.map(function (r) {
            var g = LHMS.get.guest(r.guestId);
            return '<a class="list-row" href="#/guests/' + r.guestId + '"><div class="lr-main">' + ui.avatar(g.name) + '<div><div class="lr-title">' + ui.esc(g.name) + '</div><div class="lr-sub">' + ui.esc(g.tier) + " · " + ui.esc(ui.typeName(r.roomTypeId)) + "</div></div></div><div class=\"lr-meta\">" + (LHMS.get.room(r.roomId) || {}).number + "<div class=\"tiny muted\">" + (r.status === "Confirmed" ? "arriving" : "in house") + "</div></div></a>";
          }).join("") + "</div>" : '<p class="muted small">No VIP movements today.</p>', "", "Platinum and Gold profiles", "star") +
        "</div>" +
      "</div>" +

      '<div class="grid g3 mt16">' +
        ui.sectionCard("Availability snapshot", '<div class="stack">' +
          ["dk", "pv", "es", "gv", "ps"].map(function (tid) {
            var type = LHMS.get.roomType(tid);
            var av = LHMS.calc.availability(tid, LHMS.day, U.addDays(LHMS.day, 1));
            var sold = av.total - av.free;
            return '<div><div class="row between" style="margin-bottom:4px"><span class="small strong">' + type.name + '</span><span class="tiny muted">' + av.free + " of " + av.total + " free</span></div>" +
              '<div class="progress"><span style="width:' + (av.total ? sold / av.total * 100 : 0) + '%"></span></div></div>';
          }).join("") + '</div><a class="btn-link" style="display:inline-block;margin-top:12px" href="#/timeline">Open availability timeline →</a>', "", "Tonight, across room types", "bed") +
        ui.sectionCard("Housekeeping", '<div class="row between" style="align-items:flex-start"><div><div class="kpi-value" style="margin-top:0">' + m.dirty + '</div><div class="small muted">rooms to turn</div></div><div style="text-align:right"><div class="kpi-value" style="margin-top:0;font-size:22px">' + m.ooo + '</div><div class="small muted">out of order</div></div></div>' +
          '<div class="progress mt12"><span style="width:' + (m.sellable ? (m.sellable - m.dirty) / m.sellable * 100 : 0) + '%"></span></div>' +
          '<p class="muted tiny mt8">' + (m.sellable - m.dirty) + " of " + m.sellable + " sellable rooms are ready for sale.</p><a class=\"btn-link\" style=\"display:inline-block;margin-top:10px\" href=\"#/housekeeping\">Supervisor board →</a>", "", "Live room status", "broom") +
        ui.sectionCard("Today's rate position", '<div class="row between"><div><div class="kpi-label">ADR</div><div class="kpi-value" style="font-size:23px">' + U.money(m.adr) + '</div></div><div style="text-align:right"><div class="kpi-label">RevPAR</div><div class="kpi-value" style="font-size:23px">' + U.money(m.revpar) + "</div></div></div>" +
          '<div class="notice info mt12">' + ui.icon("trendUp") + "<div>Weekend demand is 12% above the 30-day average. Consider releasing the Advance Purchase rate on the remaining suites.</div></div>" +
          '<a class="btn-link" style="display:inline-block;margin-top:10px" href="#/revenue">Manage rates →</a>', "", "Performance today", "chart") +
      "</div>";
  };

  /* ============================================================
     ROOM MAP
     ============================================================ */
  LHMS.pages["room-map"] = function () {
    var p = LHMS.get.property();
    var rooms = LHMS.roomsOf(p.id);
    var floors = [];
    rooms.forEach(function (r) { if (floors.indexOf(r.floor) === -1) floors.push(r.floor); });
    floors.sort();
    var shown = S.floor === "all" ? rooms : rooms.filter(function (r) { return String(r.floor) === String(S.floor); });
    var counts = {};
    rooms.forEach(function (r) {
      var st = LHMS.roomState(r);
      counts[st.key] = (counts[st.key] || 0) + 1;
    });

    var floorTabs = '<button class="floor-tab' + (S.floor === "all" ? " on" : "") + '" data-act="set-floor" data-floor="all">All floors <span style="opacity:.55">' + rooms.length + "</span></button>" +
      floors.map(function (f) {
        return '<button class="floor-tab' + (String(S.floor) === String(f) ? " on" : "") + '" data-act="set-floor" data-floor="' + f + '">Floor ' + f + " <span style=\"opacity:.55\">" + rooms.filter(function (r) { return r.floor === f; }).length + "</span></button>";
      }).join("");

    var legend = [["occupied", "Occupied"], ["arriving", "Arriving"], ["departing", "Departing"], ["dirty", "Dirty"], ["available", "Available"], ["inspected", "Inspected"], ["ooo", "Out of order"], ["oos", "Out of service"]]
      .map(function (l) {
        var col = { occupied: "#4b6d92", arriving: "#b18f52", departing: "#9d7fae", dirty: "#c08a3e", available: "#6e997d", inspected: "#5984ad", ooo: "#b8544d", oos: "#9a9a9a" }[l[0]];
        return '<span><i style="background:' + col + '"></i>' + l[1] + "</span>";
      }).join("");

    var tiles = shown.map(function (room) {
      var st = LHMS.roomState(room);
      var g = st.guest;
      return '<button class="room-tile ' + st.key + '" data-act="open-room" data-room="' + room.id + '">' +
        (room.floor === 1 && room.typeId === "gv" ? '<span class="flag" title="Private garden"></span>' : "") +
        '<span class="rn">' + room.number + "</span>" +
        '<span class="rt">' + ui.esc(ui.typeName(room.typeId)) + "</span>" +
        '<span class="rg">' + (g ? ui.esc(g.lastName) + (st.res ? " · " + U.nights(LHMS.day, st.res.checkOut) + "n" : "") : st.label) + "</span>" +
        '<span class="rs"><i></i>' + st.label + "</span></button>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Front desk · " + p.short,
      title: "Room map",
      sub: "A physical view of the house. Click any room to see the guest, move status or raise a task.",
      actions: '<a class="btn" href="#/housekeeping">' + ui.icon("broom", 14) + ' Housekeeping board</a><button class="btn primary" data-act="open-task" data-room="">' + ui.icon("plus", 14) + " New task</button>"
    }) +
      '<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(132px,1fr))">' +
        ui.kpi("Occupied", counts.occupied || 0, '<span class="tiny">' + (counts.departing || 0) + " departing today</span>", { accent: "accent-navy", icon: "bed" }) +
        ui.kpi("Arriving", counts.arriving || 0, "Expected today", { icon: "key" }) +
        ui.kpi("Ready to sell", (counts.available || 0) + (counts.inspected || 0), "Clean or inspected", { accent: "accent-green", icon: "checkCircle" }) +
        ui.kpi("Dirty", counts.dirty || 0, "Awaiting turnover", { icon: "broom" }) +
        ui.kpi("Out of order", (counts.ooo || 0) + (counts.oos || 0), "Removed from inventory", { accent: "accent-red", icon: "wrench" }) +
      "</div>" +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;gap:16px">' +
        '<section class="card">' +
          '<div class="card-head"><div><div class="card-title">' + ui.icon("grid", 15) + "Live rooms</div><div class=\"card-sub\">" + shown.length + " rooms shown · " + p.name + '</div></div><div class="legend">' + legend + "</div></div>" +
          '<div class="floor-tabs">' + floorTabs + "</div>" +
          '<div class="room-grid">' + tiles + "</div>" +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("Turnover pressure", '<div class="stack">' +
            '<div class="row between"><span class="small">Check-outs today</span><b>' + LHMS.calc.departures(p.id).length + "</b></div>" +
            '<div class="row between"><span class="small">Arrivals today</span><b>' + LHMS.calc.arrivals(p.id).length + "</b></div>" +
            '<div class="row between"><span class="small">Dirty rooms</span><b>' + (counts.dirty || 0) + "</b></div>" +
            '<div class="row between"><span class="small">Cleaners on shift</span><b>' + LHMS.staffOf(p.id).filter(function (s) { return /Room Attendant|Supervisor/.test(s.title); }).length + "</b></div>" +
            '<div class="progress"><span style="width:' + (rooms.length ? ((counts.available || 0) + (counts.inspected || 0)) / rooms.length * 100 : 0) + '%"></span></div>' +
            '<p class="tiny muted">Turnover target is 15:00. Rooms are released to sell as soon as housekeeping marks them clean.</p>' +
            "</div>", "", "", "clock") +
          ui.sectionCard("Room legend", '<p class="small muted" style="line-height:1.7">Status combines occupancy and housekeeping. A room cannot be sold while <b>dirty</b>, <b>out of order</b> or <b>out of service</b>.</p><div class="notice mt12">' + ui.icon("alert") + "<div>Changing a room to out of order removes it from inventory and creates a maintenance task.</div></div>", "", "", "info") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     TIMELINE
     ============================================================ */
  LHMS.pages.timeline = function () {
    var p = LHMS.get.property();
    var days = 14;
    var dates = [];
    for (var i = 0; i < days; i++) dates.push(U.addDays(LHMS.day, i));
    var rooms = LHMS.roomsOf(p.id).filter(function (r) { return S.floor === "all" || String(r.floor) === String(S.floor); });

    var header = '<div class="tl-row tl-head"><div class="tl-cell" style="min-height:52px"><b style="font-size:10px">ROOM</b></div>' +
      dates.map(function (d) {
        return '<div class="tl-cell' + (d === LHMS.day ? " today" : "") + '"><span>' + U.pretty(d, "dow") + "</span><b>" + U.dayNum(d) + " " + U.monthShort(d) + "</b></div>";
      }).join("") + "</div>";

    var rows = rooms.map(function (room) {
      var res = db.reservations.filter(function (r) {
        return r.roomId === room.id && (r.status === "In-house" || r.status === "Confirmed") &&
          r.checkIn < U.addDays(LHMS.day, days) && r.checkOut > LHMS.day;
      });
      var bars = res.map(function (r) {
        var start = Math.max(0, U.nights(LHMS.day, r.checkIn));
        var end = Math.min(days, U.nights(LHMS.day, r.checkOut));
        if (end <= start) return "";
        var g = LHMS.get.guest(r.guestId);
        var tone = r.status === "In-house" ? "" : "gold";
        if (r.vip) tone = r.status === "In-house" ? "green" : "gold";
        return '<button class="tl-bar ' + tone + '" style="left:calc(' + (start / days * 100) + '% + 3px);width:calc(' + ((end - start) / days * 100) + '% - 6px)" data-act="open-res" data-res="' + r.id + '" title="' + ui.esc((g ? g.name : "") + " · " + r.reference + " · " + U.pretty(r.checkIn, "short") + "–" + U.pretty(r.checkOut, "short")) + '">' +
          ui.esc((g ? g.lastName : "Guest") + " · " + U.nights(r.checkIn, r.checkOut) + "n") + "</button>";
      }).join("");
      var st = LHMS.roomState(room);
      return '<div class="tl-row"><div class="tl-room"><b>' + room.number + "</b><span>" + ui.esc(ui.typeName(room.typeId).replace("Deluxe ", "Dlx ").replace("Premier ", "")) + (st.key === "ooo" || st.key === "oos" ? " · OOO" : "") + "</span></div>" +
        '<div class="tl-cells">' + dates.map(function (d) { return '<div class="c' + (d === LHMS.day ? " today" : "") + '"></div>'; }).join("") + bars + "</div></div>";
    }).join("");

    var floors = [];
    LHMS.roomsOf(p.id).forEach(function (r) { if (floors.indexOf(r.floor) === -1) floors.push(r.floor); });

    return ui.pageHead({
      eyebrow: "Front desk · availability",
      title: "Next 14 nights",
      sub: "Every stay laid out against the room it occupies. Use it to spot gaps, walk-in opportunities and rooms held out of order.",
      actions: '<button class="btn" data-act="export-timeline">' + ui.icon("download", 14) + ' Export CSV</button><a class="btn primary" href="#/booking/new">' + ui.icon("plus", 14) + " New booking</a>"
    }) +
      '<div class="card pad0"><div class="toolbar" style="padding:14px 16px 0;margin-bottom:12px"><div class="toolbar-left"><div class="floor-tabs" style="margin:0">' +
        '<button class="floor-tab' + (S.floor === "all" ? " on" : "") + '" data-act="set-floor" data-floor="all">All floors</button>' +
        floors.map(function (f) { return '<button class="floor-tab' + (String(S.floor) === String(f) ? " on" : "") + '" data-act="set-floor" data-floor="' + f + '">Floor ' + f + "</button>"; }).join("") +
        '</div></div><div class="row"><span class="chip gold">Confirmed</span><span class="chip green">In house</span><span class="chip red">Out of order</span></div></div>' +
        '<div class="timeline-wrap" style="border:0;border-radius:0"><div class="timeline">' + header + rows + "</div></div>" +
      "</div>" +
      '<div class="grid g3 mt16">' +
        ui.sectionCard("Sell tonight", '<p class="muted small">' + LHMS.calc.metrics(p.id).availableTonight + " rooms remain available for tonight at the " + p.short + ".</p><div class=\"row mt12\"><a class=\"btn sm primary\" href=\"#/booking/new\">Book a room</a><a class=\"btn sm\" href=\"#/room-map\">Room map</a></div>", "", "", "bed") +
        ui.sectionCard("Held out of inventory", '<p class="muted small">' + LHMS.roomsOf(p.id).filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; }).length + " rooms are removed from sale. Releasing them requires engineering sign-off.</p><a class=\"btn-link\" style=\"display:inline-block;margin-top:10px\" href=\"#/room-map\">Review rooms →</a>", "", "", "wrench") +
        ui.sectionCard("Pickup pace", '<div class="row between"><span class="small muted">Next 7 nights</span><b>' + Math.round(dates.slice(0, 7).reduce(function (s, d) { return s + LHMS.calc.arrivals(p.id, d).length; }, 0)) + " arrivals</b></div><div class=\"row between\" style=\"margin-top:6px\"><span class=\"small muted\">Following 7 nights</span><b>" + Math.round(dates.slice(7).reduce(function (s, d) { return s + LHMS.calc.arrivals(p.id, d).length; }, 0)) + " arrivals</b></div><p class=\"tiny muted mt8\">Rooms are held for 24h on a provisional basis.</p>", "", "", "trendUp") +
      "</div>";
  };

  /* ============================================================
     RESERVATIONS
     ============================================================ */
  // The board only appears when the house owes someone a room: an open offer
  // with its hold clock, and the queue behind it in the order the desk will
  // call it. Releasing is automatic on cancellation; the button is the manual
  // pass for a day that has moved on without one.
  function waitlistPanel(p) {
    var offers = LHMS.waitlist.active(p.id);
    var queue = LHMS.waitlist.queue(p.id);
    if (!offers.length && !queue.length) return "";
    var offerRows = offers.map(function (o) {
      var r = LHMS.get.reservation(o.reservationId);
      var g = r ? LHMS.get.guest(r.guestId) : null;
      var room = LHMS.get.room(o.roomId);
      return '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("clock", 12) + '</span><div>' +
        '<div class="lr-title">' + ui.esc(g ? g.name : "Guest") + " · Room " + (room ? room.number : "—") + '</div>' +
        '<div class="lr-sub">' + (r ? r.reference + " · " + U.pretty(r.checkIn, "short") + " → " + U.pretty(r.checkOut, "short") : "") + " · hold until " + U.timeOf(o.expiresAt) + '</div>' +
        '</div></div><div class="row" style="gap:6px">' +
        '<button class="btn sm primary" data-act="waitlist-accept" data-offer="' + o.id + '">Accept</button>' +
        '<button class="btn sm" data-act="waitlist-decline" data-offer="' + o.id + '">Decline</button>' +
        "</div></div>";
    }).join("");
    var queueRows = queue.map(function (r, i) {
      var g = LHMS.get.guest(r.guestId);
      return '<div class="list-row clickable" data-act="open-res" data-res="' + r.id + '"><div class="lr-main">' +
        '<span class="avatar sm">' + (i + 1) + '</span><div>' +
        '<div class="lr-title">' + ui.esc(g ? g.name : "Guest") + " · " + ui.esc(ui.typeName(r.roomTypeId)) + '</div>' +
        '<div class="lr-sub">' + r.reference + " · " + U.pretty(r.checkIn, "short") + " → " + U.pretty(r.checkOut, "short") + " · " + U.nights(r.checkIn, r.checkOut) + " nights</div>" +
        '</div></div><span class="chip' + (LHMS.waitlist.offerFor(r.id) ? " gold" : "") + '">' + (LHMS.waitlist.offerFor(r.id) ? "Offered" : "Waiting") + "</span></div>";
    }).join("");
    return '<section class="card">' +
      '<div class="card-head"><div><div class="card-title">' + ui.icon("clock", 15) + ' Waitlist</div>' +
        '<div class="card-sub">' + queue.length + " stay" + (queue.length === 1 ? "" : "s") + " waiting · a released room is held for " + LHMS.waitlist.offerHours + " hours.</div></div>" +
        '<button class="btn sm" data-act="waitlist-release">' + ui.icon("refresh", 14) + " Check the waitlist</button></div>" +
      (offers.length ? '<div class="list">' + offerRows + "</div>"
        : '<p class="muted small">No room is held open. The next cancellation releases the oldest matching stay automatically.</p>') +
      (queue.length ? '<div class="divider-label mt16">Queue</div><div class="list">' + queueRows + "</div>" : "") +
      "</section>";
  }

  LHMS.pages.reservations = function () {
    var p = LHMS.get.property();
    var list = LHMS.reservationsOf(p.id).slice().sort(function (a, b) { return a.checkIn < b.checkIn ? 1 : -1; });
    if (S.resStatus !== "all") list = list.filter(function (r) { return r.status === S.resStatus; });
    if (S.resQuery) {
      var q = S.resQuery.toLowerCase();
      list = list.filter(function (r) {
        var g = LHMS.get.guest(r.guestId);
        return (r.reference + " " + (g ? g.name : "") + " " + (g ? g.email : "")).toLowerCase().indexOf(q) !== -1;
      });
    }
    var statuses = ["all", "Confirmed", "In-house", "Checked out", "Cancelled", "Waitlist", "No-show"];
    var counts = {};
    LHMS.reservationsOf(p.id).forEach(function (r) { counts[r.status] = (counts[r.status] || 0) + 1; });

    var rows = list.length ? list.map(function (r) {
      var g = LHMS.get.guest(r.guestId);
      var room = LHMS.get.room(r.roomId);
      return '<tr class="clickable" data-act="open-res" data-res="' + r.id + '">' +
        '<td><span class="ref">' + r.reference + "</span>" + (r.source === "Guest app" ? '<span class="chip gold">Self-served</span>' : "") + '<div class="tiny muted">' + U.pretty(r.createdAt ? String(r.createdAt).slice(0, 10) : r.checkIn, "short") + "</div></td>" +
        "<td>" + view.who(r.guestId) + "</td>" +
        '<td><span class="room-no">' + (room ? room.number : "—") + '</span><div class="tiny muted">' + ui.esc(ui.typeName(r.roomTypeId)) + "</div></td>" +
        "<td>" + U.pretty(r.checkIn, "short") + '<div class="tiny muted">' + U.pretty(r.checkOut, "short") + " · " + U.nights(r.checkIn, r.checkOut) + "n</div></td>" +
        '<td class="tiny">' + ui.esc(ui.planName(r.ratePlanId)) + '<div class="muted">' + ui.esc(r.channel) + "</div></td>" +
        "<td>" + ui.resStatus(r.status) + "</td>" +
        "<td class=\"right\">" + (r.status === "Waitlist" ? '<span class="muted">—</span>' : view.balance(r.id)) + "</td>" +
        '<td class="right">' + ui.icon("right", 13) + "</td></tr>";
    }).join("") : "";

    return ui.pageHead({
      eyebrow: "Front desk · reservations",
      title: "Reservations",
      sub: "Every booking across direct, OTA, corporate and group channels. " + counts["In-house"] + " guests are in residence.",
      actions: '<button class="btn" data-act="export-reservations">' + ui.icon("download", 14) + ' Export</button><a class="btn primary" href="#/booking/new">' + ui.icon("plus", 14) + " New booking</a>"
    }) +
      '<div class="kpis" style="grid-template-columns:repeat(auto-fit,minmax(150px,1fr))">' +
        ui.kpi("Arrivals today", LHMS.calc.arrivals(p.id).length, "Confirmed", { icon: "key" }) +
        ui.kpi("In house", counts["In-house"] || 0, "Occupied rooms", { icon: "bed", accent: "accent-navy" }) +
        ui.kpi("Departures today", LHMS.calc.departures(p.id).length, "Due before 12:00", { icon: "logout" }) +
        ui.kpi("Cancelled", (counts["Cancelled"] || 0) + (counts["No-show"] || 0), "Last 90 days", { icon: "close" }) +
        ui.kpi("On the books", LHMS.reservationsOf(p.id).filter(function (r) { return r.status === "Confirmed"; }).length, "Future confirmations", { icon: "calendar", accent: "accent-green" }) +
      "</div>" +
      waitlistPanel(p) +
      '<section class="card follow">' +
        '<div class="toolbar">' + ui.searchField("Search by guest, reference or email", S.resQuery, "res-search") +
          '<select class="select" style="max-width:170px" data-change="res-status">' + statuses.map(function (s) { return '<option value="' + s + '"' + (S.resStatus === s ? " selected" : "") + ">" + (s === "all" ? "All statuses" : s) + "</option>"; }).join("") + "</select>" +
          '<span class="spacer"></span><span class="tiny muted">' + list.length + " reservations</span>" +
        "</div>" +
        (list.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Reference</th><th>Guest</th><th>Room</th><th>Stay</th><th>Rate plan</th><th>Status</th><th class="right">Balance</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : ui.empty("No reservations match", "Adjust the search or status filter.", "search")) +
      "</section>";
  };

  /* ============================================================
     BOOKING DETAIL
     ============================================================ */
  LHMS.pages.booking = function (route) {
    if (route.sub === "new") return newBookingPage();
    var res = LHMS.get.reservation(route.sub);
    if (!res) return ui.pageHead({ eyebrow: "Reservations", title: "Booking not found" }) + ui.empty("We could not find that reservation", "It may have been removed. Return to the reservations list.", "calendar");
    var g = LHMS.get.guest(res.guestId);
    var room = LHMS.get.room(res.roomId);
    var type = LHMS.get.roomType(res.roomTypeId);
    var plan = LHMS.get.ratePlan(res.ratePlanId);
    var f = LHMS.folio(res.id);
    var roomLines = f.charges.filter(function (c) { return c.department === "Rooms"; });
    var taxLines = f.charges.filter(function (c) { return c.department === "Taxes & service"; });
    // The stay is billed in one money, fixed by its first priced night; the
    // breakdown reads in that money rather than the property's.
    var stayCur = f.currency;
    var waitOffer = LHMS.waitlist.offerFor(res.id);
    var offerRoom = waitOffer ? LHMS.get.room(waitOffer.roomId) : null;
    // A waitlisted stay has no folio, so its rate card is read live from the
    // same quote engine — the figure it will be billed at when released.
    var waitQuote = res.status === "Waitlist"
      ? LHMS.calc.quote(res.roomTypeId, res.ratePlanId, res.checkIn, res.checkOut, res.adults, res.children)
      : null;

    var actions = "";
    if (res.status === "Confirmed") actions += '<button class="btn primary" data-act="checkin-link" data-res="' + res.id + '">' + ui.icon("key", 14) + ' Check in</button>';
    if (res.status === "In-house") actions += '<button class="btn primary" data-act="checkout-open" data-res="' + res.id + '">' + ui.icon("logout", 14) + " Check out</button>";
    if (res.status !== "Waitlist") actions += '<a class="btn" href="#/folio/' + res.id + '">' + ui.icon("receipt", 14) + ' Folio</a>';
    if (res.status === "Confirmed" || res.status === "In-house") actions += '<button class="btn danger" data-act="cancel-res" data-res="' + res.id + '">Cancel</button>';
    if (res.status === "Waitlist") actions += '<button class="btn danger" data-act="cancel-res" data-res="' + res.id + '">Leave the waitlist</button>';

    return ui.pageHead({
      eyebrow: "Reservation · " + res.reference,
      title: g ? g.name : "Guest reservation",
      sub: ui.typeName(res.roomTypeId) + " · " + U.pretty(res.checkIn, "medium") + " to " + U.pretty(res.checkOut, "medium") + " · " + U.nights(res.checkIn, res.checkOut) + " nights",
      actions: actions
    }) +
      '<div class="grid g-2-1">' +
        '<div class="stack">' +
          (waitOffer ? ui.sectionCard("Room released", '<p class="small" style="line-height:1.6">Room <b>' + (offerRoom ? offerRoom.number : "—") + "</b> is held for this stay until <b>" +
            U.pretty(String(waitOffer.expiresAt).slice(0, 10), "short") + " " + U.timeOf(waitOffer.expiresAt) + "</b>. Accepting confirms the booking and bills the nights then; declining passes the room to the next waiting stay.</p>" +
            '<div class="row mt12" style="gap:8px"><button class="btn primary sm" data-act="waitlist-accept" data-offer="' + waitOffer.id + '">Accept the room</button>' +
            '<button class="btn sm" data-act="waitlist-decline" data-offer="' + waitOffer.id + '">Decline</button></div>', "", "", "clock") : "") +
          ui.sectionCard("Stay", '<div class="grid g3" style="gap:10px">' +
            '<div class="preference"><span>Arrival</span><b>' + U.pretty(res.checkIn, "medium") + '</b></div>' +
            '<div class="preference"><span>Departure</span><b>' + U.pretty(res.checkOut, "medium") + '</b></div>' +
            '<div class="preference"><span>Nights</span><b>' + U.nights(res.checkIn, res.checkOut) + '</b></div>' +
            '<div class="preference"><span>Room</span><b>' + (room ? room.number + " · Floor " + room.floor : "Unassigned") + '</b></div>' +
            '<div class="preference"><span>Rate plan</span><b>' + ui.esc(plan ? plan.name : "—") + '</b></div>' +
            '<div class="preference"><span>Channel</span><b>' + ui.esc(res.channel) + '</b></div>' +
            '<div class="preference"><span>Occupancy</span><b>' + res.adults + " adult" + (res.adults > 1 ? "s" : "") + (res.children ? " · " + res.children + " child" : "") + '</b></div>' +
            '<div class="preference"><span>Status</span><b>' + ui.resStatus(res.status).replace(/<[^>]+>/g, "") + '</b></div>' +
            '<div class="preference"><span>Booked</span><b>' + U.pretty(String(res.createdAt).slice(0, 10), "short") + '</b></div>' +
          "</div>" +
          (res.notes ? '<div class="notice mt16">' + ui.icon("message") + "<div><b>Guest note.</b> " + ui.esc(res.notes) + "</div></div>" : ""), "", "", "bed") +

          ui.sectionCard("Rate breakdown", res.status === "Waitlist"
            ? (waitQuote && waitQuote.available
              ? '<div class="notice info">' + ui.icon("clock") + "<div>Nothing is billed until a room is released and the offer accepted. The figure below is the live quote for these dates.</div></div>" +
                '<div class="folio-total mt12">' +
                  '<div class="ft-row"><span>Room total · ' + U.nights(res.checkIn, res.checkOut) + ' nights</span><span class="num">' + U.money(waitQuote.roomTotal, waitQuote.currency) + "</span></div>" +
                  '<div class="ft-row"><span>Taxes &amp; service</span><span class="num">' + U.money(waitQuote.total - waitQuote.roomTotal, waitQuote.currency) + "</span></div>" +
                  '<div class="ft-row big"><span>Total if released</span><b>' + U.money(waitQuote.total, waitQuote.currency) + "</b></div>" +
                "</div>"
              : '<p class="muted small">This room type has no rate on sale for these dates, so the stay cannot be released until the rate is restored.</p>')
            : '<div class="table-wrap"><table class="data mini"><thead><tr><th>Night</th><th>Date</th><th>Price list</th><th class="right">Rate</th></tr></thead><tbody>' +
              roomLines.map(function (c, i) {
                return '<tr><td>Night ' + (i + 1) + '</td><td>' + U.pretty(c.date, "medium") + '</td><td class="tiny muted">' + ui.esc(c.listName || "Standard") +
                  '</td><td class="right num">' + U.money(c.amount, c.currency) + "</td></tr>";
              }).join("") +
              '<tr><td colspan="3" class="strong">Room total</td><td class="right strong num">' + U.money(res.roomTotal, stayCur) + "</td></tr>" +
              taxLines.map(function (c) {
                return '<tr><td colspan="3">' + ui.esc(c.description) + '</td><td class="right num">' + U.money(c.amount, c.currency) + "</td></tr>";
              }).join("") +
              '<tr><td colspan="3" class="strong">Total incl. taxes</td><td class="right strong num">' + U.money(res.total, stayCur) + "</td></tr>" +
              "</tbody></table></div>",
            "", res.status === "Waitlist" ? "The quote is re-read when the offer is accepted, so the folio is billed at the rate standing that day." : "Priced when the reservation was made — re-pricing the room type does not rewrite this stay.", "receipt") +

          ui.sectionCard("Guest & stay notes", (g && g.notes && g.notes.length ? '<div class="list">' + g.notes.slice(0, 3).map(function (n) {
            return '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("message", 12) + '</span><div><div class="lr-title">' + ui.esc(n.text) + '</div><div class="lr-sub">' + ui.esc(n.by) + " · " + U.pretty(n.date, "short") + "</div></div></div></div>";
          }).join("") + "</div>" : '<p class="muted small">No notes on file.</p>') +
            '<form data-form="booking-note" class="mt12" style="display:flex;gap:8px"><input type="hidden" name="resId" value="' + res.id + '" /><input class="input" name="note" placeholder="Add a note for this stay…" required /><button class="btn primary sm" type="submit">Add</button></form>', "", "", "message") +
        "</div>" +

        '<div class="stack">' +
          (g ? '<section class="card"><div class="row between"><div class="who"><span class="avatar lg">' + U.initials(g.name) + '</span><div><div class="who-name" style="font-size:14px">' + ui.esc(g.name) + '</div><div class="who-sub">' + ui.esc(g.job || g.country) + '</div><div class="mt8">' + ui.tierChip(g.tier) + "</div></div></div>" + ui.icon("star", 16) + "</div>" +
            '<div class="detail-row mt12"><dt>Email</dt><dd>' + ui.esc(g.email) + "</dd></div>" +
            '<div class="detail-row"><dt>Phone</dt><dd>' + ui.esc(g.phone) + "</dd></div>" +
            '<div class="detail-row"><dt>Country</dt><dd>' + ui.esc(g.country) + "</dd></div>" +
            '<div class="detail-row"><dt>Preferences</dt><dd>' + ui.esc(g.preferences.pillow) + "</dd></div>" +
            '<div class="detail-row"><dt>Allergies</dt><dd class="' + (g.preferences.allergies !== "None" ? "err" : "") + '">' + ui.esc(g.preferences.allergies) + "</dd></div>" +
            '<div class="row mt12"><a class="btn sm block" href="#/guests/' + g.id + '">Open guest record</a></div></section>'
            : "") +
          ui.sectionCard("Folio", '<div class="folio-total"><div class="ft-row"><span>Charges</span><span class="num">' + fm(f, f.total) + '</span></div><div class="ft-row"><span>Paid</span><span class="num">' + fm(f, f.paid) + '</span></div><div class="ft-row big"><span>Balance</span><b>' + fm(f, f.balance) + "</b></div>" +
            booksRow(f) + "</div>" +
            '<div class="row mt12" style="gap:6px"><a class="btn sm block" href="#/folio/' + res.id + '">Open folio</a></div>', "", "", "receipt") +
          ui.sectionCard("Actions", '<div class="stack" style="gap:7px">' +
            (res.status === "Confirmed" ? '<button class="btn primary block" data-act="checkin-link" data-res="' + res.id + '">Check in</button>' : "") +
            (res.status === "In-house" ? '<button class="btn primary block" data-act="checkout-open" data-res="' + res.id + '">Check out</button>' : "") +
            '<button class="btn block" data-act="email-res" data-res="' + res.id + '">Email confirmation</button>' +
            '<button class="btn block" data-act="open-task" data-room="' + res.roomId + '" data-guest="' + res.guestId + '">Raise a task</button>' +
            "</div>", "", "", "settings") +
        "</div>" +
      "</div>";
  };

  /* ---------------- new booking ---------------- */
  function newBookingPage() {
    var p = LHMS.get.property();
    var guests = db.guests.slice().sort(function (a, b) { return a.name.localeCompare(b.name); });
    var ci = U.addDays(LHMS.day, 0);
    var co = U.addDays(LHMS.day, 2);
    var defType = "dk";
    var q = LHMS.calc.quote(defType, "flex", ci, co, 2, 0);
    var av = LHMS.calc.availability(defType, ci, co);

    return ui.pageHead({
      eyebrow: "Front desk · new reservation",
      title: "Create a booking",
      sub: "Direct booking with live availability, rate parity and tax built in.",
      actions: '<a class="btn" href="#/reservations">Cancel</a>'
    }) +
      '<form data-form="new-booking" class="grid" style="grid-template-columns:minmax(0,1fr) 340px;gap:16px;align-items:start" id="booking-form">' +
        '<input type="hidden" name="waitlist" id="quote-waitlist" value="0" />' +
        '<div class="stack">' +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("user", 15) + 'Guest</div><div class="card-sub">Attach the booking to an existing profile to carry preferences across.</div></div></div>' +
            '<div class="form-grid">' +
              '<div class="field span2"><label>Existing guest</label><select name="guestId" class="select" id="guestSelect"><option value="">— New guest profile —</option>' + guests.map(function (g) { return '<option value="' + g.id + '">' + ui.esc(g.name) + " · " + g.tier + " · " + ui.esc(g.country) + "</option>"; }).join("") + "</select></div>" +
            "</div>" +
            '<div id="new-guest-fields" style="display:none">' +
              '<div class="divider-label">New guest details</div>' +
              '<div class="form-grid">' +
                '<div class="field"><label>Title</label><select name="title"><option>Mr</option><option>Mrs</option><option>Ms</option><option>Dr</option></select></div>' +
                '<div class="field"><label>Country</label><select name="country"><option>Nigeria</option><option>United Kingdom</option><option>United States</option><option>Ghana</option><option>South Africa</option><option>France</option><option>Germany</option><option>India</option><option>United Arab Emirates</option></select></div>' +
                '<div class="field"><label>First name</label><input name="firstName" placeholder="Ada" /></div>' +
                '<div class="field"><label>Last name</label><input name="lastName" placeholder="Okafor" /></div>' +
                '<div class="field"><label>Email</label><input name="email" type="email" placeholder="guest@example.com" /></div>' +
                '<div class="field"><label>Phone</label><input name="phone" placeholder="+234 …" /></div>' +
                '<div class="field"><label>ID type</label><select name="idType"><option>International passport</option><option>National ID</option><option>Driver licence</option></select></div>' +
                '<div class="field"><label>ID number</label><input name="idNumber" placeholder="A0123456" /></div>' +
              "</div>" +
              '<label class="check mt12"><input type="checkbox" name="marketing" /> Guest consents to marketing communications (NDPR / GDPR)</label>' +
            "</div>" +
          "</section>" +

          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("calendar", 15) + 'Stay</div><div class="card-sub">Rates are pulled live from the selected rate plan.</div></div></div>' +
            '<div class="form-grid three">' +
              '<div class="field"><label>Check-in</label><input type="date" name="checkIn" id="quote-in" value="' + ci + '" min="' + LHMS.day + '" data-quote-field /></div>' +
              '<div class="field"><label>Check-out</label><input type="date" name="checkOut" id="quote-out" value="' + co + '" min="' + U.addDays(ci, 1) + '" data-quote-field /></div>' +
              '<div class="field"><label>Channel</label><select name="channel"><option>Direct</option><option>Booking.com</option><option>Expedia</option><option>Corporate</option><option>Travel agent</option><option>Walk-in</option><option>GDS</option></select></div>' +
              '<div class="field span2"><label>Room type</label><select name="roomTypeId" id="quote-type" data-quote-field>' + LHMS.price.pricedRoomTypes(ci, co).map(function (t) {
                var nr = LHMS.price.nightRateOf(t.id, { date: ci });
                return '<option value="' + t.id + '"' + (t.id === defType ? " selected" : "") + ">" + t.name +
                  " · " + (nr ? U.money(nr.amount, nr.currency) : "not priced") + " / night</option>";
              }).join("") + "</select></div>" +
              '<div class="field"><label>Rate plan</label><select name="ratePlanId" id="quote-plan" data-quote-field>' + db.ratePlans.map(function (pl) { return '<option value="' + pl.id + '">' + pl.name + "</option>"; }).join("") + "</select></div>" +
              '<div class="field"><label>Adults</label><select name="adults"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></div>' +
              '<div class="field"><label>Children</label><select name="children"><option selected>0</option><option>1</option><option>2</option><option>3</option></select></div>' +
              '<div class="field"><label>Arrival time</label><select name="eta"><option value="">15:00 (standard)</option><option value="11:00">11:00 — early</option><option value="13:00">13:00</option><option value="18:00">18:00</option><option value="22:00">22:00 — late</option></select></div>' +
              '<div class="field span2"><label>Special requests</label><textarea name="notes" placeholder="High floor, anniversary amenity, dietary notes…"></textarea></div>' +
            "</div>" +
          "</section>" +

          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("card", 15) + 'Deposit</div><div class="card-sub">Optional at booking — the plan default is suggested.</div></div></div>' +
            '<div class="form-grid">' +
              '<div class="field"><label>Amount to take now</label><input name="deposit" id="quote-deposit" type="number" min="0" step="any" value="' + q.deposit + '" /></div>' +
              '<div class="field"><label>Payment method</label><select name="method"><option>Card</option><option>Transfer</option><option>Cash</option><option>City ledger</option></select></div>' +
            "</div>" +
          "</section>" +
        "</div>" +

        '<aside class="stack" style="position:sticky;top:96px">' +
          '<section class="card gold" id="quote-panel">' + quotePanelHTML(q, av) + "</section>" +
          '<section class="card"><div class="card-title" style="font-size:12px">' + ui.icon("shield", 14) + 'Booking controls</div><div class="stack" style="gap:8px;margin-top:10px">' +
            '<label class="check"><input type="checkbox" checked /> Rate parity checked against OTAs</label>' +
            '<label class="check"><input type="checkbox" checked /> Send confirmation email</label>' +
            '<label class="check"><input type="checkbox" name="mobileKey" /> Enable mobile key at check-in</label>' +
            '<div class="notice" style="margin-top:4px">' + ui.icon("alert") + "<div>Overbooking threshold for <b>" + p.short + "</b> is " + LHMS.get.settings(p.id).overbooking + " rooms. This booking is within the threshold.</div></div>" +
          "</div></section>" +
          '<button class="btn primary lg block" type="submit" id="create-booking-btn">' + ui.icon("check", 15) + ' Create reservation</button>' +
          '<p class="tiny muted" id="create-booking-hint" style="text-align:center">A folio and confirmation are generated automatically.</p>' +
        "</aside>" +
      "</form>";
  }

  function quotePanelHTML(q, av) {
    var line = function (label, value) {
      return '<div class="ft-row" style="justify-content:space-between;display:flex;font-size:11px;color:#6c634f;padding:3px 0"><span>' +
        label + '</span><span class="num">' + value + "</span></div>";
    };
    if (!q.available) {
      return '<p class="card-eyebrow" style="color:#8a7038">Live quote · ' + ui.esc(q.type.name) + "</p>" +
        '<p class="small">This room type has no active price for the selected dates, so it cannot be sold.</p>' +
        '<a class="btn soft sm mt8" href="#/prices">Open price setup</a>';
    }
    // Every figure below comes from the central pricing engine, including the
    // tax rows, so the quote and the folio can never disagree. The money is the
    // price list's own: a contract list priced in dollars quotes in dollars.
    var listName = q.nightly.length ? q.nightly[0].list : "";
    var qm = function (n) { return U.money(n, q.currency); };
    return '<p class="card-eyebrow" style="color:#8a7038">Live quote · ' + ui.esc(q.type.name) + "</p>" +
      line(ui.esc(listName) + " · " + ui.nightsLabel(q.nights), qm(q.roomTotal)) +
      (q.extras ? line("Weekend &amp; occupancy additions", qm(q.extras)) : "") +
      q.taxLines.map(function (t) { return line(ui.esc(t.label), qm(t.amount)); }).join("") +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #e6d9ba;margin-top:8px;padding-top:10px"><span class="tiny strong" style="letter-spacing:.08em;text-transform:uppercase;color:#7b6c4c">Total</span><b class="serif" style="font-size:26px;font-weight:500;letter-spacing:-.02em">' + qm(q.total) + "</b></div>" +
      '<div class="divider-label" style="margin:12px 0">Deposit & availability</div>' +
      '<div class="row between"><span class="tiny">Deposit due (' + q.plan.depositPct + "%)</span><b class=\"small\">" + qm(q.deposit) + "</b></div>" +
      '<div class="row between mt8"><span class="tiny">Rooms free</span><span class="chip ' + (av.free > 0 ? "green" : "red") + '">' + av.free + " of " + av.total + "</span></div>" +
      (av.free === 0 ? '<div class="notice mt12">' + ui.icon("clock") + "<div>Sold out for these dates. The stay can join the waitlist and take no deposit — the oldest request of this room type is offered the next room released.</div></div>" : "") +
      '<p class="tiny" style="margin-top:10px;color:#7b6c4c;line-height:1.5">' + ui.esc(q.plan.cancel) + " · " + ui.esc(q.plan.includes) + "</p>";
  }

  LHMS.onQuoteChange = function () {
    var form = document.getElementById("booking-form");
    if (!form) return;
    var typeId = (document.getElementById("quote-type") || {}).value;
    var planId = (document.getElementById("quote-plan") || {}).value;
    var ci = (document.getElementById("quote-in") || {}).value;
    var co = (document.getElementById("quote-out") || {}).value;
    if (!typeId || !planId || !ci || !co) return;
    if (U.nights(ci, co) < 1) { co = U.addDays(ci, 1); var out = document.getElementById("quote-out"); if (out) out.value = co; }
    var q = LHMS.calc.quote(typeId, planId, ci, co);
    var av = LHMS.calc.availability(typeId, ci, co);
    var panel = document.getElementById("quote-panel");
    if (panel) panel.innerHTML = quotePanelHTML(q, av);
    // Sold out is not a dead end: the form turns into a waitlist request, so
    // the deposit box closes and the button changes what it promises.
    var soldOut = av.free === 0;
    var flag = document.getElementById("quote-waitlist");
    if (flag) flag.value = soldOut ? "1" : "0";
    var dep = document.getElementById("quote-deposit");
    if (dep) {
      dep.disabled = soldOut;
      if (soldOut) dep.value = 0;
      else if (!dep.dataset.touched) dep.value = q.deposit;
    }
    var btn = document.getElementById("create-booking-btn");
    if (btn) {
      btn.disabled = !q.available;
      btn.innerHTML = ui.icon("check", 15) + (soldOut ? " Join the waitlist" : " Create reservation");
    }
    var hint = document.getElementById("create-booking-hint");
    if (hint) hint.textContent = soldOut
      ? "No room is free. The stay joins the waitlist and takes no deposit; a released room is held for " + LHMS.waitlist.offerHours + " hours."
      : "A folio and confirmation are generated automatically.";
  };

  /* ============================================================
     CHECK-IN
     ============================================================ */
  LHMS.pages["check-in"] = function (route) {
    var res = LHMS.get.reservation(route.sub);
    if (!res) return ui.pageHead({ eyebrow: "Front desk", title: "Check-in" }) + ui.empty("Reservation not found", "Open the reservation list and choose a guest to check in.", "key");
    var g = LHMS.get.guest(res.guestId);
    var type = LHMS.get.roomType(res.roomTypeId);
    var ci = S.checkin && S.checkin.resId === res.id ? S.checkin : (S.checkin = { resId: res.id, step: 1, roomId: res.roomId, idVerified: false, registered: false, mobileKey: true });
    var steps = [
      { n: 1, label: "Verify & register" },
      { n: 2, label: "Assign room" },
      { n: 3, label: "Deposit & key" }
    ];
    var stepBar = '<div class="wizard-steps">' + steps.map(function (s) {
      var cls = ci.step === s.n ? "on" : ci.step > s.n ? "done" : "";
      return '<div class="wizard-step ' + cls + '"><i>' + (ci.step > s.n ? "✓" : s.n) + "</i>" + s.label + "</div>";
    }).join("") + "</div>";

    var body = "";
    if (ci.step === 1) {
      body = ui.sectionCard("Guest verification", '<div class="notice info">' + ui.icon("shield") + "<div>Capture the identity document and confirm the registration card. Retention follows the property's NDPR policy (7 years for registration records).</div></div>" +
        '<div class="grid g2 mt16" style="gap:12px">' +
          '<div class="panel"><div class="panel-title">Guest</div><div class="row">' + ui.avatar(g ? g.name : "Guest", "lg") + '<div><div class="strong">' + ui.esc(g ? g.name : "Guest") + "</div><div class=\"tiny muted\">" + ui.esc(g ? g.tier + " · " + g.country : "") + "</div><div class=\"mt8\">" + (g ? ui.tierChip(g.tier) : "") + "</div></div></div></div>" +
          '<div class="panel"><div class="panel-title">Stay</div><div class="detail-row"><dt>Reference</dt><dd class="mono">' + res.reference + '</dd></div><div class="detail-row"><dt>Room type</dt><dd>' + ui.esc(type.name) + '</dd></div><div class="detail-row"><dt>Nights</dt><dd>' + U.nights(res.checkIn, res.checkOut) + '</dd></div><div class="detail-row"><dt>Departure</dt><dd>' + U.pretty(res.checkOut, "short") + "</dd></div></div>" +
        "</div>" +
        '<div class="form-grid mt16">' +
          '<div class="field"><label>ID type</label><select><option' + (g && g.idType === "International passport" ? " selected" : "") + ">International passport</option><option" + (g && g.idType === "National ID" ? " selected" : "") + ">National ID</option><option>Driver licence</option></select></div>" +
          '<div class="field"><label>ID number</label><input value="' + ui.esc(g ? g.idNumber : "") + '" /></div>' +
          '<div class="field"><label>Issuing country</label><input value="' + ui.esc(g ? g.country : "") + '" /></div>' +
          '<div class="field"><label>Contact number</label><input value="' + ui.esc(g ? g.phone : "") + '" /></div>' +
        '</div>' +
        '<div class="stack mt16" style="gap:8px">' +
          '<label class="check"><input type="checkbox" ' + (ci.idVerified ? "checked" : "") + ' data-checkin-flag="idVerified" /> Identity document checked and number matches the reservation</label>' +
          '<label class="check"><input type="checkbox" ' + (ci.registered ? "checked" : "") + ' data-checkin-flag="registered" /> Digital registration card signed by the guest</label>' +
        "</div>" +
        (g && g.preferences.allergies !== "None" ? '<div class="notice danger mt12">' + ui.icon("alert") + "<div><b>Allergy on file:</b> " + ui.esc(g.preferences.allergies) + ". F&amp;B and housekeeping have been notified for this stay.</div></div>" : "") +
        '<div class="row mt20" style="justify-content:flex-end"><button class="btn primary" data-act="checkin-next">Continue to room ' + ui.icon("right", 14) + "</button></div>", "", "", "shield");
    } else if (ci.step === 2) {
      var av = LHMS.calc.availability(res.roomTypeId, res.checkIn, res.checkOut);
      var pref = g ? g.preferences.room : "";
      var options = av.rooms.slice().sort(function (a, b) {
        function score(r) {
          var sp = 0;
          if (/high/i.test(pref) && r.floor >= 3) sp += 2;
          if (/low/i.test(pref) && r.floor <= 1) sp += 2;
          if (/quiet|away/i.test(pref) && r.number.slice(-1) === "1") sp += 1;
          return sp;
        }
        return score(b) - score(a);
      });
      body = ui.sectionCard("Assign a room", '<div class="row between"><div class="card-sub">' + ui.esc(type.name) + " · " + av.free + " available for " + U.nights(res.checkIn, res.checkOut) + " nights</div>" + (pref && pref !== "No preference" ? '<span class="chip gold">Prefers: ' + ui.esc(pref) + "</span>" : "") + "</div>" +
        '<div class="grid g2 mt12" style="gap:9px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">' +
        (options.length ? options.map(function (room) {
          var st = LHMS.roomState(room);
          var selectable = st.key === "available" || st.key === "inspected" || st.key === "arriving" || st.key === "dirty";
          return '<button type="button" class="room-option ' + (ci.roomId === room.id ? "on" : "") + '" data-act="checkin-room" data-room="' + room.id + '"' + (selectable ? "" : " disabled") + ">" +
            '<span class="avatar sm">' + room.number + '</span><span style="flex:1"><b>Room ' + room.number + '</b><span>Floor ' + room.floor + " · " + ui.esc(type.view) + "</span></span>" +
            '<span class="ro-price">' + (st.key === "dirty" ? '<span class="chip amber">Dirty</span>' : st.key === "inspected" ? '<span class="chip blue">Inspected</span>' : "Ready") + "</span></button>";
        }).join("") : '<div class="notice">' + ui.icon("alert") + "<div>No rooms of this type are free for the full stay. Change the room type or shorten the stay.</div></div>") +
        "</div>" +
        (ci.roomId ? '<div class="notice success mt16">' + ui.icon("checkCircle") + "<div><b>Room " + (LHMS.get.room(ci.roomId) || {}).number + " selected.</b> Housekeeping will be notified of the arrival.</div></div>" : "") +
        '<div class="row mt20" style="justify-content:space-between"><button class="btn" data-act="checkin-back">' + ui.icon("left", 14) + ' Back</button><button class="btn primary" data-act="checkin-next"' + (ci.roomId ? "" : " disabled") + ">Continue " + ui.icon("right", 14) + "</button></div>", "", "", "door");
    } else {
      var plan = LHMS.get.ratePlan(res.ratePlanId) || db.ratePlans[0];
      var f = LHMS.folio(res.id);
      // The deposit is owed against the price this reservation was confirmed
      // at, never against whatever the room type happens to cost today.
      var depositDue = Math.max(0, LHMS.price.round((res.total || 0) * (plan.depositPct || 0) / 100) - f.paid);
      body = '<div class="grid g2">' +
        ui.sectionCard("Deposit & payment", '<div class="form-grid">' +
          '<div class="field"><label>Deposit to take now</label><input type="number" id="ci-deposit" value="' + depositDue + '" min="0" step="any" /></div>' +
          '<div class="field"><label>Method</label><select id="ci-method"><option>Card</option><option>Transfer</option><option>Cash</option><option>City ledger</option></select></div>' +
          "</div>" +
          '<div class="notice mt12">' + ui.icon("card") + "<div>The rate plan requires a " + plan.depositPct + "% deposit. Outstanding balance will be posted to the folio for settlement at departure.</div></div>" +
          '<label class="check mt16"><input type="checkbox" id="ci-mobile-key" checked /> Issue a mobile key to the guest app</label>' +
          '<label class="check mt8"><input type="checkbox" id="ci-welcome" checked /> Send welcome amenity and preference summary to the butler team</label>', "", "", "card") +
        ui.sectionCard("Stay summary", '<div class="detail-row"><dt>Guest</dt><dd>' + ui.esc(g ? g.name : "Guest") + "</dd></div>" +
          '<div class="detail-row"><dt>Room</dt><dd>' + (LHMS.get.room(ci.roomId) || {}).number + " · " + ui.esc(type.name) + "</dd></div>" +
          '<div class="detail-row"><dt>Check-in</dt><dd>' + U.pretty(res.checkIn, "medium") + "</dd></div>" +
          '<div class="detail-row"><dt>Check-out</dt><dd>' + U.pretty(res.checkOut, "medium") + "</dd></div>" +
          '<div class="detail-row"><dt>Nights</dt><dd>' + U.nights(res.checkIn, res.checkOut) + "</dd></div>" +
          '<div class="detail-row"><dt>Folio balance</dt><dd>' + fm(f, f.balance) + "</dd></div>" +
          (g && g.preferences.pillow !== "No preference" ? '<div class="detail-row"><dt>Pillow</dt><dd>' + ui.esc(g.preferences.pillow) + "</dd></div>" : "") +
          (g && g.preferences.allergies !== "None" ? '<div class="detail-row"><dt>Allergy</dt><dd style="color:var(--red)">' + ui.esc(g.preferences.allergies) + "</dd></div>" : "") +
          '<div class="row mt20" style="justify-content:space-between"><button class="btn" data-act="checkin-back">' + ui.icon("left", 14) + ' Back</button><button class="btn primary" data-act="checkin-finish" data-res="' + res.id + '">' + ui.icon("key", 14) + " Complete check-in</button></div>", "", "", "bed") +
        "</div>";
    }

    return ui.pageHead({
      eyebrow: "Front desk · check-in",
      title: "Welcome, " + ((g ? g.firstName : "guest")) + ".",
      sub: res.reference + " · " + ui.esc(type.name) + " · " + U.nights(res.checkIn, res.checkOut) + " nights · " + res.channel,
      actions: '<a class="btn" href="#/reservations">All reservations</a>'
    }) + stepBar + body;
  };

  /* ============================================================
     FOLIO
     ============================================================ */
  // The folio is what is owed; an invoice is a copy of part of it handed to the
  // guest. Both belong on this screen, because a clerk needs to see which
  // charges have already left the folio and which have not.
  function invoiceCard(res) {
    var docs = LHMS.invoicesOf(res.propertyId).filter(function (i) { return i.reservationId === res.id; });
    var open = LHMS.unbilledCharges(res.id);
    return (docs.length ? '<div class="list">' + docs.map(function (i) {
      var t = LHMS.invoiceMoney(i);
      return '<div class="list-row"><div class="lr-main"><div style="min-width:0">' +
        '<div class="lr-title"><a class="small strong" href="#/invoices/' + i.id + '">' + ui.esc(i.number) + "</a></div>" +
        '<div class="lr-sub">' + U.pretty(i.date, "short") + " · " + ui.esc(t.status) + "</div></div></div>" +
        '<div class="lr-meta num">' + U.money(t.total, i.currency) + "</div></div>";
    }).join("") + "</div>"
      : '<p class="muted small" style="line-height:1.6">No document raised yet — every charge is still sitting on the folio.</p>') +
      (open.length ? '<p class="tiny muted mt8">' + open.length + " charge line" + (open.length === 1 ? "" : "s") +
        " not yet on a document.</p>" +
        (LHMS.can("manage_billing") ? '<button class="btn sm block mt8" data-act="inv-raise" data-kind="folio" data-id="' +
          res.id + '">Raise invoice for open charges</button>' : "")
        : '<p class="tiny muted mt8">Everything on this folio has been invoiced.</p>') +
      '<p class="tiny muted mt12" style="line-height:1.6">Split to a company account at check-out with the ledger button.</p>';
  }

  LHMS.pages.folio = function (route) {
    var res = LHMS.get.reservation(route.sub);
    if (!res) {
      var first = LHMS.calc.inHouse(LHMS.session.propertyId)[0];
      if (first) res = first;
    }
    if (!res) return ui.pageHead({ eyebrow: "Billing", title: "Guest folio" }) + ui.empty("No folio selected", "Choose a guest from today's in-house list.", "receipt");
    var g = LHMS.get.guest(res.guestId);
    var room = LHMS.get.room(res.roomId);
    var f = LHMS.folio(res.id);
    var charges = f.charges.slice().sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var paid = f.payments.reduce(function (s, p) { return s + p.amount; }, 0);

    var chargeRows = charges.map(function (c) {
      return '<tr><td class="tiny">' + U.pretty(c.date, "short") + "</td><td>" + ui.esc(c.description) + '<div class="tiny muted">' + ui.esc(c.department) + " · " + ui.esc(c.postedBy || "") + "</div></td>" +
        '<td class="right num"' + (c.amount < 0 ? ' style="color:var(--green)"' : "") + ">" + U.money(c.amount, c.currency || f.currency) + "</td>" +
        '<td class="right">' + (res.status !== "Checked out" ? '<button class="btn sm ghost" style="color:var(--muted)" data-act="void-charge" data-charge="' + c.id + '" title="Void charge">' + ui.icon("close", 11) + "</button>" : "") + "</td></tr>";
    }).join("");

    if (res.status !== "Checked out") {
      chargeRows += '<tr><td></td><td><button class="btn-link" data-act="open-post-charge" data-res="' + res.id + '">+ Post a charge</button></td><td></td><td></td></tr>';
    }

    return ui.pageHead({
      eyebrow: "Billing · " + res.reference,
      title: "Folio for " + (g ? g.name : "Guest"),
      sub: (room ? "Room " + room.number + " · " : "") + U.pretty(res.checkIn, "medium") + " – " + U.pretty(res.checkOut, "medium") + " · " + ui.resStatus(res.status).replace(/<[^>]+>/g, ""),
      actions: '<button class="btn" data-act="print-folio">' + ui.icon("printer", 14) + ' Print</button><button class="btn" data-act="email-folio" data-res="' + res.id + '">' + ui.icon("mail", 14) + ' Email folio</button>' +
        (res.status === "In-house" ? '<button class="btn primary" data-act="checkout-open" data-res="' + res.id + '">' + ui.icon("logout", 14) + " Check out</button>" : "") +
        (res.status === "Confirmed" ? '<button class="btn primary" data-act="checkin-link" data-res="' + res.id + '">' + ui.icon("key", 14) + " Check in</button>" : "")
    }) +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start">' +
        '<div class="stack">' +
          '<section class="card pad0"><div class="card-head" style="padding:18px 19px 0"><div><div class="card-title">' + ui.icon("receipt", 15) + 'Charges &amp; payments</div><div class="card-sub">All amounts in ' + ui.esc(LHMS.fx.nameOf(f.currency) || f.currency) + ', inclusive of service charge and VAT.</div></div><span class="chip ' + (f.balance > 0 ? "amber" : "green") + '">' + (f.balance > 0 ? "Balance due" : "Settled") + "</span></div>" +
            '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr><th>Date</th><th>Description</th><th class="right">Amount</th><th></th></tr></thead><tbody>' + chargeRows + "</tbody></table></div>" +
            '<div class="row between" style="padding:12px 19px;border-top:1px solid var(--line-2);background:#fcfbf7"><span class="small muted">' + charges.length + " charge lines</span><b class=\"serif\" style=\"font-size:20px\">" + fm(f, f.total) + "</b></div>" +
          "</section>" +
          ui.sectionCard("Payments received", f.payments.length ? '<div class="table-wrap"><table class="data mini"><thead><tr><th>Date</th><th>Method</th><th>Reference</th><th>Taken by</th><th class="right">Amount</th></tr></thead><tbody>' +
            f.payments.map(function (p) { return "<tr><td>" + U.pretty(p.date, "short") + "</td><td>" + ui.esc(p.method) + '</td><td class="mono">' + ui.esc(p.reference) + "</td><td>" + ui.esc(p.takenBy) + '</td><td class="right num">' + U.money(p.amount, p.currency || f.currency) + "</td></tr>"; }).join("") +
            "</tbody></table></div>" : '<p class="muted small">No payments recorded. A deposit can be taken at any time.</p>', '<button class="btn sm primary" data-act="open-payment" data-res="' + res.id + '">Take payment</button>', "", "card") +
        "</div>" +

        '<div class="stack">' +
          '<section class="card gold"><p class="card-eyebrow" style="color:#8a7038">Folio summary</p>' +
            '<div class="ft-row" style="display:flex;justify-content:space-between;font-size:11px;color:#6c634f;padding:4px 0"><span>Room &amp; extras</span><span class="num">' + fm(f, f.charges.filter(function (c) { return c.department !== "Taxes & service"; }).reduce(function (s, c) { return s + c.amount; }, 0)) + "</span></div>" +
            '<div class="ft-row" style="display:flex;justify-content:space-between;font-size:11px;color:#6c634f;padding:4px 0"><span>Service &amp; VAT</span><span class="num">' + fm(f, f.charges.filter(function (c) { return c.department === "Taxes & service"; }).reduce(function (s, c) { return s + c.amount; }, 0)) + "</span></div>" +
            '<div class="ft-row" style="display:flex;justify-content:space-between;font-size:11px;color:#6c634f;padding:4px 0"><span>Total charges</span><span class="num">' + fm(f, f.total) + "</span></div>" +
            '<div class="ft-row" style="display:flex;justify-content:space-between;font-size:11px;color:#2f6b4f;padding:4px 0"><span>Payments</span><span class="num">− ' + fm(f, paid) + "</span></div>" +
            '<div class="ft-row big" style="display:flex;justify-content:space-between;align-items:baseline;border-top:1px solid #e6d9ba;margin-top:6px;padding-top:9px"><span style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;font-weight:700;color:#7b6c4c">Balance</span><b class="serif" style="font-size:24px;font-weight:500">' + fm(f, f.balance) + "</b></div>" +
            booksRow(f) +
          "</section>" +
          ui.sectionCard("Guest", g ? '<div class="row">' + ui.avatar(g.name, "lg") + '<div><div class="strong">' + ui.esc(g.name) + "</div><div class=\"tiny muted\">" + ui.esc(g.email) + "</div><div class=\"mt8\">" + ui.tierChip(g.tier) + "</div></div></div>" +
            '<div class="detail-row mt12"><dt>Phone</dt><dd>' + ui.esc(g.phone) + "</dd></div><div class=\"detail-row\"><dt>Stay</dt><dd>" + U.nights(res.checkIn, res.checkOut) + " nights</dd></div><div class=\"detail-row\"><dt>Room</dt><dd>" + (room ? room.number : "—") + "</dd></div>" +
            '<a class="btn sm block mt12" href="#/guests/' + g.id + '">Guest record</a>' : "", "", "", "user") +
          ui.sectionCard("Invoices & billing", invoiceCard(res), '<button class="btn sm ghost" data-act="city-ledger" data-res="' + res.id + '">To city ledger</button>', "", "building") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     CHECK-OUT QUEUE
     ============================================================ */
  LHMS.pages["check-out"] = function () {
    var p = LHMS.get.property();
    // Ranked and totalled on what each balance is worth on the books: a dollar
    // folio and a naira folio leave in the same queue, and their face figures
    // count different money.
    var deps = LHMS.calc.departures(p.id).sort(function (a, b) { return LHMS.folio(b.id).baseBalance - LHMS.folio(a.id).baseBalance; });
    var upcoming = [];
    for (var i = 1; i <= 3; i++) {
      var d = U.addDays(LHMS.day, i);
      LHMS.reservationsOf(p.id).filter(function (r) { return r.status === "In-house" && r.checkOut === d; }).forEach(function (r) { upcoming.push(r); });
    }
    var totalBal = deps.reduce(function (s, r) { return s + Math.max(0, LHMS.folio(r.id).baseBalance); }, 0);
    var baseCur = LHMS.fx.base(p.id);

    var rows = deps.length ? deps.map(function (r) {
      var g = LHMS.get.guest(r.guestId);
      var room = LHMS.get.room(r.roomId);
      var f = LHMS.folio(r.id);
      return '<tr><td>' + view.who(r.guestId) + "</td>" +
        '<td><span class="room-no">' + (room ? room.number : "—") + '</span><div class="tiny muted">' + ui.esc(ui.typeName(r.roomTypeId)) + "</div></td>" +
        "<td>" + U.pretty(r.checkOut, "medium") + '<div class="tiny muted">' + U.nights(r.checkIn, r.checkOut) + " nights</div></td>" +
        '<td class="right num">' + fm(f, f.total) + '</td><td class="right num">' + fm(f, f.paid) + "</td>" +
        '<td class="right">' + (f.balance > 0 ? '<span class="chip amber">' + fm(f, f.balance) + "</span>" : '<span class="chip green">Settled</span>') + "</td>" +
        '<td class="right"><div class="row" style="justify-content:flex-end;gap:5px"><a class="btn sm" href="#/folio/' + r.id + '">Folio</a><button class="btn sm primary" data-act="checkout-open" data-res="' + r.id + '">Check out</button></div></td></tr>';
    }).join("") : "";

    return ui.pageHead({
      eyebrow: "Front desk · departures",
      title: "Check-out queue",
      sub: "Settle balances, release rooms to housekeeping and deliver the folio. " + deps.length + " guests are due out today.",
      actions: '<a class="btn" href="#/today">' + ui.icon("home", 14) + ' Today</a><a class="btn primary" href="#/folio/' + (deps[0] ? deps[0].id : "") + '">' + ui.icon("receipt", 14) + " Open first folio</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Due out", deps.length, "Before 12:00 standard", { icon: "logout" }) +
        ui.kpi("Balance to settle", U.compact(totalBal, baseCur), "Counted in " + baseCur + ", across departing folios", { icon: "card", accent: "accent-navy" }) +
        ui.kpi("Settled", deps.filter(function (r) { return LHMS.folio(r.id).balance === 0; }).length, "Ready to release", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Rooms to turn", deps.length, "Housekeeping notified", { icon: "broom" }) +
      "</div>" +
      '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("key", 15) + "Today's departures</div><div class=\"card-sub\">Check-out requires a zero balance. Rooms are released to housekeeping automatically.</div></div></div>" +
        (deps.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Guest</th><th>Room</th><th>Departure</th><th class="right">Charges</th><th class="right">Paid</th><th class="right">Balance</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : ui.empty("All departures settled", "No guests are due out today.", "checkCircle")) +
      "</section>" +
      '<div class="grid g2 mt16">' +
        ui.sectionCard("Upcoming departures", upcoming.length ? '<div class="list">' + upcoming.slice(0, 6).map(function (r) {
          var g = LHMS.get.guest(r.guestId);
          return '<div class="list-row"><div class="lr-main">' + ui.avatar(g ? g.name : "Guest") + '<div><div class="lr-title">' + ui.esc(g ? g.name : "Guest") + '</div><div class="lr-sub">Room ' + ui.roomNo(r.roomId) + " · " + U.pretty(r.checkOut, "short") + '</div></div></div><div class="lr-meta">' + view.balance(r.id) + "</div></div>";
        }).join("") + "</div>" : '<p class="muted small">No upcoming departures.</p>', "", "Next 72 hours", "calendar") +
        ui.sectionCard("Departure checklist", '<div class="stack" style="gap:9px">' +
          '<label class="check"><input type="checkbox" checked /> Minibar checked and posted</label>' +
          '<label class="check"><input type="checkbox" checked /> Late charges reviewed by night audit</label>' +
          '<label class="check"><input type="checkbox" /> Folio emailed to guest</label>' +
          '<label class="check"><input type="checkbox" /> Transport to airport confirmed</label>' +
          '<div class="notice info mt8">' + ui.icon("info") + "<div>Check-out releases the room as <b>dirty</b> and creates a departure-clean task with a 60-minute SLA.</div></div>" +
        "</div>", "", "Front desk standard", "check") +
      "</div>";
  };

  /* ============================================================
     FRONT DESK ACTIONS
     ============================================================ */
  Object.assign(LHMS.uiActions, {
    "today-tab": function (el) { S.todayTab = el.getAttribute("data-tab"); LHMS.rerender(); },
    "set-floor": function (el) { S.floor = el.getAttribute("data-floor"); LHMS.rerender(); },
    "open-res": function (el) { LHMS.go("booking/" + el.getAttribute("data-res")); },
    "waitlist-release": function () {
      var r = LHMS.waitlist.release();
      ui.toast(r.offers.length
        ? r.offers.length + " waitlisted stay" + (r.offers.length === 1 ? "" : "s") + " offered a room."
        : (r.expired ? "Expired " + r.expired + " hold" + (r.expired === 1 ? "" : "s") + ". No match was free." : "Nothing to release — no waitlisted stay has a room free for its dates."));
      LHMS.rerender();
    },
    "waitlist-accept": function (el) {
      var r = LHMS.waitlist.accept(el.getAttribute("data-offer"));
      if (!r.ok) { ui.toast(r.error, "error"); LHMS.rerender(); return; }
      ui.toast("Room " + ((LHMS.get.room(r.res.roomId) || {}).number || "") + " confirmed for " + ui.guestName(r.res.guestId) + ".");
      LHMS.go("booking/" + r.res.id);
    },
    "waitlist-decline": function (el) {
      var r = LHMS.waitlist.decline(el.getAttribute("data-offer"));
      if (!r.ok) { ui.toast(r.error, "error"); return; }
      ui.toast("Offer declined" + (r.offers.length ? " — the room passed to the next waiting stay." : "."));
      LHMS.rerender();
    },
    "checkin-link": function (el) { S.checkin = null; LHMS.go("check-in/" + el.getAttribute("data-res")); },
    "live:res-search": function (val) { S.resQuery = val; LHMS.rerender(); setTimeout(function () { var f = document.querySelector('[data-live="res-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10); },

    "open-room": function (el) {
      var room = LHMS.get.room(el.getAttribute("data-room"));
      if (!room) return;
      var st = LHMS.roomState(room);
      var g = st.guest;
      var res = st.res || null;
      var f = res ? LHMS.folio(res.id) : null;
      var recentTask = LHMS.tasksOf(room.propertyId).filter(function (t) { return t.roomId === room.id && t.status !== "Done"; })[0];
      ui.drawer({
        eyebrow: "Room " + room.number + " · Floor " + room.floor,
        title: ui.esc(ui.typeName(room.typeId)),
        body:
          '<div class="row between mb16">' + ui.roomStatusChip(st.key) + '<span class="tiny muted">' + ui.esc(st.detail) + "</span></div>" +
          (g ? '<div class="panel"><div class="row">' + ui.avatar(g.name) + '<div><div class="strong">' + ui.esc(g.name) + '</div><div class="tiny muted">' + ui.esc(g.tier) + " · " + ui.esc(g.country) + '</div></div></div>' +
            (res ? '<div class="detail-row mt12"><dt>Stay</dt><dd>' + U.pretty(res.checkIn, "short") + " → " + U.pretty(res.checkOut, "short") + "</dd></div>" +
              '<div class="detail-row"><dt>Nights</dt><dd>' + U.nights(res.checkIn, res.checkOut) + "</dd></div>" +
              '<div class="detail-row"><dt>Balance</dt><dd>' + fm(f, f.balance) + "</dd></div>" +
              '<div class="detail-row"><dt>Rate plan</dt><dd>' + ui.esc(ui.planName(res.ratePlanId)) + "</dd></div>" : "") +
            "</div>" : '<div class="panel"><p class="muted small">No guest currently assigned. This room can be sold or held for maintenance.</p></div>') +
          (g && g.preferences ? '<div class="panel mt12"><div class="panel-title">Preferences</div><div class="preference"><span>Pillow</span><b>' + ui.esc(g.preferences.pillow) + '</b></div><div class="preference mt8"><span>Allergies</span><b>' + ui.esc(g.preferences.allergies) + "</b></div></div>" : "") +
          (recentTask ? '<div class="panel mt12"><div class="panel-title">Open task</div><div class="small">' + ui.esc(recentTask.title) + '</div><div class="tiny muted mt8">Due ' + U.timeOf(recentTask.dueAt) + " · " + ui.esc(recentTask.status) + "</div></div>" : "") +
          '<div class="divider-label">Change room status</div>' +
          '<div class="form-grid">' +
            '<div class="field span2"><label>Housekeeping status</label><select id="room-status-select"><option' + (room.hk === "Clean" ? " selected" : "") + ">Clean</option><option" + (room.hk === "Dirty" ? " selected" : "") + ">Dirty</option><option" + (room.hk === "Inspected" ? " selected" : "") + ">Inspected</option><option" + (room.hk === "Out of order" ? " selected" : "") + ">Out of order</option><option" + (room.hk === "Out of service" ? " selected" : "") + ">Out of service</option></select></div>" +
            '<div class="field span2"><label>Reason (if out of order)</label><input id="room-status-reason" value="' + ui.esc(room.oooReason || "") + '" placeholder="e.g. Bathroom re-grouting" /></div>' +
          "</div>" +
          '<button class="btn primary block mt12" data-act="apply-room-status" data-room="' + room.id + '">Update status</button>' +
          '<p class="tiny muted mt12">Room type: ' + ui.esc(ui.typeName(room.typeId)) + " · " + LHMS.get.roomType(room.typeId).size + " m² · " + ui.esc(LHMS.get.roomType(room.typeId).bed) + "</p>",
        footer:
          (st.key === "arriving" && st.res ? '<a class="btn primary" href="#/check-in/' + st.res.id + '">Check in</a>' : "") +
          (st.key === "departing" && st.res ? '<button class="btn primary" data-act="checkout-open" data-res="' + st.res.id + '">Check out</button>' : "") +
          (g ? '<a class="btn" href="#/guests/' + g.id + '">Guest</a>' : "") +
          '<button class="btn" data-act="open-task" data-room="' + room.id + '" data-guest="' + (g ? g.id : "") + '">Raise task</button>'
      });
    },

    "apply-room-status": function (el) {
      var status = (document.getElementById("room-status-select") || {}).value;
      var reason = (document.getElementById("room-status-reason") || {}).value;
      LHMS.actions.setRoomStatus(el.getAttribute("data-room"), status, reason);
      ui.closeDrawer(); LHMS.rerender();
      ui.toast("Room status updated to " + status + ".");
    },

    "open-task": function (el) {
      var roomId = el.getAttribute("data-room") || "";
      var guestId = el.getAttribute("data-guest") || "";
      ui.modal({
        title: "Raise a task",
        sub: "Routed instantly to the right department with an SLA clock.",
        body: '<form data-form="create-task" class="form-grid">' +
          '<input type="hidden" name="roomId" value="' + roomId + '" /><input type="hidden" name="guestId" value="' + guestId + '" />' +
          '<div class="field span2"><label>Title</label><input name="title" required placeholder="e.g. Repair the shower valve in Room 305" /></div>' +
          '<div class="field"><label>Type</label><select name="type"><option>Guest request</option><option>Housekeeping</option><option>Maintenance</option><option>Inspection</option></select></div>' +
          '<div class="field"><label>Priority</label><select name="priority"><option>Normal</option><option>High</option><option>Low</option></select></div>' +
          '<div class="field"><label>Room</label><select name="roomId2">' + LHMS.roomsOf().map(function (r) { return '<option value="' + r.id + '"' + (r.id === roomId ? " selected" : "") + ">" + r.number + " · " + ui.esc(ui.typeName(r.typeId)) + "</option>"; }).join("") + "</select><span class=\"hint\">Overrides the room above.</span></div>" +
          '<div class="field"><label>Assign to</label><select name="assignedTo"><option value="">Unassigned queue</option>' + LHMS.staffOf().filter(function (s) { return /Housekeeping|Engineering|Front Office/.test(s.department); }).map(function (s) { return '<option value="' + s.id + '">' + ui.esc(s.name) + " · " + ui.esc(s.title) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field span2"><label>Detail</label><textarea name="detail" placeholder="What needs to happen, and by when?"></textarea></div>' +
          "</form>",
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-task">Create task</button>'
      });
    },
    "submit-task": function () {
      var form = document.querySelector('form[data-form="create-task"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      LHMS.actions.createTask({
        title: d.title, type: d.type, priority: d.priority,
        roomId: d.roomId2 || d.roomId || null, guestId: d.guestId || null,
        assignedTo: d.assignedTo || null, detail: d.detail, slaMins: d.priority === "High" ? 30 : 60
      });
      ui.closeModal(); LHMS.rerender();
      ui.toast("Task created and routed to the assigned team.");
    },

    "checkout-open": function (el) { view.checkoutModal(el.getAttribute("data-res")); },
    "confirm-checkout": function (el) {
      var resId = el.getAttribute("data-res");
      var method = (document.getElementById("co-method") || {}).value || "Card";
      var r = LHMS.actions.checkOut(resId, { settle: true, method: method });
      if (!r.ok) { ui.toast(r.error, "error"); return; }
      ui.closeModal(); LHMS.rerender();
      ui.toast((LHMS.get.guest(r.res.guestId) || {}).name + " checked out. Room " + (r.room ? r.room.number : "") + " released to housekeeping.");
    },

    "open-post-charge": function (el) { view.chargeModal(el.getAttribute("data-res")); },
    "open-payment": function (el) { view.paymentModal(el.getAttribute("data-res")); },
    // The footer button sits outside the modal's form, so it cannot submit it:
    // these hand the form to the same function a real submit event would.
    "submit-charge": function () {
      var form = document.querySelector('form[data-form="post-charge"]');
      if (form && form.reportValidity()) LHMS.forms["post-charge"](form);
    },
    "submit-payment": function () {
      var form = document.querySelector('form[data-form="take-payment"]');
      if (form && form.reportValidity()) LHMS.forms["take-payment"](form);
    },
    "void-charge": function (el) {
      ui.confirm({
        title: "Void this charge?", label: "Void charge", danger: true,
        body: "The charge will be removed from the folio and the action recorded in the audit trail.",
        id: "yes"
      });
      S.pendingVoid = el.getAttribute("data-charge");
    },

    "print-folio": function () { ui.toast("Opening print dialog…"); setTimeout(function () { window.print(); }, 250); },
    "email-folio": function (el) {
      var res = LHMS.get.reservation(el.getAttribute("data-res"));
      var g = res ? LHMS.get.guest(res.guestId) : null;
      LHMS.log("emailed a folio", "folio", res ? res.reference + " · " + (g ? g.email : "") : "");
      LHMS.save();
      ui.toast("Email delivery is not connected in this build — the folio is ready to print.");
    },
    "email-res": function (el) {
      var res = LHMS.get.reservation(el.getAttribute("data-res"));
      var g = res ? LHMS.get.guest(res.guestId) : null;
      LHMS.log("emailed a confirmation", "reservation", res ? res.reference : "");
      LHMS.save();
      ui.toast("Email delivery is not connected in this build — the confirmation is ready to print.");
    },
    "city-ledger": function (el) {
      var res = LHMS.get.reservation(el.getAttribute("data-res"));
      var f = LHMS.folio(res.id);
      if (f.balance <= 0) { ui.toast("This folio has no outstanding balance.", "error"); return; }
      LHMS.actions.takePayment(res.id, { amount: f.balance, method: "City ledger", reference: "CL-" + res.reference });
      LHMS.rerender();
      ui.toast("Balance moved to city ledger. Invoice will be issued within 24 hours.");
    },

    "cancel-res": function (el) {
      var res = LHMS.get.reservation(el.getAttribute("data-res"));
      if (!res) return;
      var waiting = res.status === "Waitlist";
      ui.modal({
        title: waiting ? "Leave the waitlist?" : "Cancel this reservation?",
        sub: res.reference + " · " + ui.guestName(res.guestId),
        slim: true,
        body: waiting
          ? '<p class="muted small" style="line-height:1.6">The request leaves the queue. Nothing is billed for a stay that never held a room.</p>'
          : '<p class="muted small" style="line-height:1.6">The room will be released immediately, and the oldest waitlisted stay of its type is offered it automatically. Cancellation terms: <b>' + ui.esc((LHMS.get.ratePlan(res.ratePlanId) || {}).cancel || "") + "</b>.</p><label class=\"check mt12\"><input type=\"checkbox\" id=\"cancel-fee\" /> Apply a one-night cancellation fee</label>",
        footer: '<button class="btn" data-close-modal>' + (waiting ? "Keep waiting" : "Keep reservation") + '</button><button class="btn danger" data-act="confirm-cancel" data-res="' + res.id + '">' + (waiting ? "Leave the waitlist" : "Cancel booking") + "</button>"
      });
    },
    "confirm-cancel": function (el) {
      var r = LHMS.actions.cancelReservation(el.getAttribute("data-res"), {
        fee: Boolean((document.getElementById("cancel-fee") || {}).checked)
      });
      if (!r.ok) { ui.toast(r.error, "error"); return; }
      ui.closeModal(); LHMS.rerender();
      ui.toast(r.offers && r.offers.length
        ? "Reservation cancelled — the room was offered to the oldest waitlisted stay."
        : "Reservation cancelled and room released.");
    },

    "checkin-next": function () {
      var ci = S.checkin;
      if (!ci) return;
      if (ci.step === 1) {
        if (!ci.idVerified || !ci.registered) { ui.toast("Confirm the identity check and signed registration card to continue.", "error"); return; }
        ci.step = 2;
      } else if (ci.step === 2) {
        if (!ci.roomId) { ui.toast("Select a room before continuing.", "error"); return; }
        ci.step = 3;
      }
      LHMS.rerender();
    },
    "checkin-back": function () { if (S.checkin && S.checkin.step > 1) { S.checkin.step -= 1; LHMS.rerender(); } },
    "checkin-room": function (el) { if (S.checkin) { S.checkin.roomId = el.getAttribute("data-room"); LHMS.rerender(); } },
    "checkin-finish": function (el) {
      var ci = S.checkin;
      var deposit = Number((document.getElementById("ci-deposit") || {}).value || 0);
      var method = (document.getElementById("ci-method") || {}).value || "Card";
      var mobileKey = (document.getElementById("ci-mobile-key") || {}).checked;
      var r = LHMS.actions.checkIn(el.getAttribute("data-res"), { roomId: ci.roomId, deposit: deposit, method: method, mobileKey: mobileKey });
      if (!r.ok) { ui.toast(r.error, "error"); return; }
      S.checkin = null;
      LHMS.go("folio/" + r.res.id);
      ui.toast((LHMS.get.guest(r.res.guestId) || {}).name + " checked in to Room " + (r.room ? r.room.number : "") + ".");
    },

    "export-reservations": function () {
      var rows = [["Reference", "Guest", "Room", "Check-in", "Check-out", "Nights", "Status", "Channel", "Total", "Balance"]];
      LHMS.reservationsOf().forEach(function (r) {
        var f = LHMS.folio(r.id);
        rows.push([r.reference, ui.guestName(r.guestId), ui.roomNo(r.roomId), r.checkIn, r.checkOut, U.nights(r.checkIn, r.checkOut), r.status, r.channel, f.total, f.balance]);
      });
      ui.csv("aurelia-reservations-" + LHMS.day + ".csv", rows);
      ui.toast("Reservation export downloaded.");
    },
    "export-timeline": function () {
      var rows = [["Room", "Type", "Status"]];
      LHMS.roomsOf().forEach(function (r) { rows.push([r.number, ui.typeName(r.typeId), LHMS.roomState(r).label]); });
      ui.csv("aurelia-room-status-" + LHMS.day + ".csv", rows);
      ui.toast("Room status export downloaded.");
    }
  });

  /* checkbox flags in check-in */
  document.addEventListener("change", function (e) {
    var flag = e.target.closest("[data-checkin-flag]");
    if (flag && S.checkin) { S.checkin[flag.getAttribute("data-checkin-flag")] = flag.checked; }
    if (e.target.id === "quote-deposit") e.target.dataset.touched = "1";
  });

  /* ---------------- modals ---------------- */
  view.checkoutModal = function (resId) {
    var res = LHMS.get.reservation(resId);
    if (!res) return;
    var g = LHMS.get.guest(res.guestId);
    var f = LHMS.folio(res.id);
    var room = LHMS.get.room(res.roomId);
    ui.modal({
      title: "Check out " + (g ? g.firstName : "guest"),
      sub: res.reference + " · Room " + (room ? room.number : "—") + " · " + U.nights(res.checkIn, res.checkOut) + " nights",
      body: '<div class="panel"><div class="detail-row"><dt>Total charges</dt><dd>' + fm(f, f.total) + "</dd></div>" +
        '<div class="detail-row"><dt>Paid</dt><dd>' + fm(f, f.paid) + "</dd></div>" +
        '<div class="detail-row total"><dt>Balance due</dt><dd>' + fm(f, f.balance) + "</dd></div>" +
        (res.pointsAwarded ? '<div class="detail-row"><dt>Loyalty</dt><dd>' + res.pointsAwarded.toLocaleString("en-NG") + " pts already credited</dd></div>"
          : '<div class="detail-row"><dt>Loyalty</dt><dd>Earns ' + LHMS.loyalty.pending(res.id).toLocaleString("en-NG") + " pts</dd></div>") +
        "</div>" +
        (f.balance > 0 ? '<div class="form-grid mt16"><div class="field"><label>Amount to settle</label><input type="number" id="co-amount" value="' + f.balance + '" readonly /></div><div class="field"><label>Payment method</label><select id="co-method"><option>Card</option><option>Transfer</option><option>Cash</option><option>City ledger</option></select></div></div>' : '<div class="notice success mt16">' + ui.icon("checkCircle") + "<div>This folio is fully settled. Completing check-out will release the room to housekeeping.</div></div>") +
        '<label class="check mt16"><input type="checkbox" id="co-early" /> Early departure — prioritise the turnover</label>' +
        '<p class="tiny muted mt12">A departure-clean task will be created automatically and the room will show as dirty on the board.</p>',
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="confirm-checkout" data-res="' + res.id + '">' + (f.balance > 0 ? "Settle &amp; check out" : "Complete check-out") + "</button>"
    });
  };

  // Money inputs use step="any": a stepped field rejects the exact value the
  // engine produced (a ₦45,000 charge, a ₦429,350 deposit), and native
  // validation then swallows the submit with no toast — a dead primary button.
  view.chargeModal = function (resId) {
    ui.modal({
      title: "Post a charge",
      sub: "The charge is added to the guest folio and included in the VAT calculation.",
      body: '<form data-form="post-charge" class="form-grid"><input type="hidden" name="resId" value="' + resId + '" />' +
        '<div class="field span2"><label>Description</label><input name="description" required placeholder="e.g. Private dining — Terrace" /></div>' +
        '<div class="field"><label>Department</label><select name="department"><option>Food & Beverage</option><option>Spa & Wellness</option><option>Transport</option><option>Retail</option><option>Laundry</option><option>Events</option><option>Rooms</option></select></div>' +
        '<div class="field"><label>Amount (₦)</label><input name="amount" type="number" min="1" step="any" required placeholder="25000" /></div>' +
        '<div class="field span2"><label>Date</label><input name="date" type="date" value="' + LHMS.day + '" max="' + LHMS.day + '" /></div>' +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-charge">Post charge</button>'
    });
  };

  view.paymentModal = function (resId) {
    var f = LHMS.folio(resId);
    ui.modal({
      title: "Take a payment",
      sub: "Card, transfer, cash or city ledger. Receipts are issued automatically.",
      body: '<form data-form="take-payment" class="form-grid"><input type="hidden" name="resId" value="' + resId + '" />' +
        '<div class="field"><label>Amount (₦)</label><input name="amount" type="number" min="1" step="any" value="' + Math.max(0, f.balance) + '" required /></div>' +
        '<div class="field"><label>Method</label><select name="method"><option>Card</option><option>Transfer</option><option>Cash</option><option>City ledger</option></select></div>' +
        '<div class="field span2"><label>Reference</label><input name="reference" placeholder="Optional — gateway or transfer reference" /></div>' +
        "</form>" +
        '<div class="notice mt12">' + ui.icon("shield") + "<div>Payments are tokenised. Card data never touches the LHMS servers.</div></div>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-payment">Record payment</button>'
    });
  };

  /* ---------------- forms ---------------- */
  LHMS.forms["new-booking"] = function (form) {
    var d = Object.fromEntries(new FormData(form));
    if (!d.guestId && (!d.firstName || !d.lastName)) { ui.toast("Choose an existing guest or enter a first and last name.", "error"); return; }
    if (U.nights(d.checkIn, d.checkOut) < 1) { ui.toast("Check-out must be after check-in.", "error"); return; }
    var av = LHMS.calc.availability(d.roomTypeId, d.checkIn, d.checkOut);
    var q = LHMS.calc.quote(d.roomTypeId, d.ratePlanId, d.checkIn, d.checkOut, d.adults, d.children);
    if (!q.available) { ui.toast("That room type has no rate on sale for those dates.", "error"); return; }
    var waiting = d.waitlist === "1" || !av.free;
    d.guestId = d.guestId || null;
    if (waiting) { d.waitlist = true; d.deposit = 0; }
    var res = LHMS.actions.newBooking(d);
    if (res && res.ok === false) { ui.toast(res.error, "error"); return; }
    ui.toast(waiting
      ? "Waitlist request " + res.reference + " added for " + ui.guestName(res.guestId) + "."
      : "Reservation " + res.reference + " created for " + ui.guestName(res.guestId) + ".");
    LHMS.go("booking/" + res.id);
  };

  LHMS.forms["post-charge"] = function (form) {
    var d = Object.fromEntries(new FormData(form));
    var r = LHMS.actions.postCharge(d.resId, d);
    if (!r.ok) { ui.toast(r.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Charge posted to the folio.");
  };

  LHMS.forms["take-payment"] = function (form) {
    var d = Object.fromEntries(new FormData(form));
    var r = LHMS.actions.takePayment(d.resId, d);
    if (!r.ok) { ui.toast(r.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Payment of " + U.money(r.payment.amount, r.payment.currency) + " recorded.");
  };

  LHMS.forms["booking-note"] = function (form) {
    var d = Object.fromEntries(new FormData(form));
    var res = LHMS.get.reservation(d.resId);
    if (!res || !d.note) return;
    res.notes = (res.notes ? res.notes + " · " : "") + d.note;
    LHMS.log("added a stay note", "reservation", res.reference + " · " + d.note.slice(0, 50));
    LHMS.save(); LHMS.rerender();
    ui.toast("Note added to the reservation.");
  };

  document.addEventListener("submit", function (e) {
    var form = e.target.closest('form[data-form="new-booking"]');
    if (form) {
      var gs = document.getElementById("guestSelect");
      if (gs && gs.value) {
        var fields = document.getElementById("new-guest-fields");
        if (fields) fields.style.display = "none";
      }
    }
  });

  /* guest-mode toggle */
  document.addEventListener("change", function (e) {
    if (e.target.id === "guestSelect") {
      var fields = document.getElementById("new-guest-fields");
      if (fields) fields.style.display = e.target.value ? "none" : "block";
      ["firstName", "lastName"].forEach(function (n) {
        var el = document.querySelector('#new-guest-fields [name="' + n + '"]');
        if (el) el.required = !e.target.value;
      });
    }
  });

  /* confirm handler for void charge (shared modal) */
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-confirm]");
    if (!btn) return;
    if (btn.getAttribute("data-confirm") === "yes" && S.pendingVoid) {
      var chargeId = S.pendingVoid;
      S.pendingVoid = null;
      var r = LHMS.actions.voidCharge(chargeId);
      // A sealed date refuses the void, so the modal stays open and the folio
      // is untouched — reporting success here would describe a write that lost.
      if (!r.ok) { ui.toast(r.error, "error"); return; }
      ui.closeModal(); LHMS.rerender();
      ui.toast("Charge voided and removed from the folio.");
    }
  });
})();
