/* ============================================================
   Business — manager dashboard, reports, revenue, reviews, EOD
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var S = (LHMS.state = LHMS.state || {});
  var db = LHMS.db;

  if (S.mgrRange == null) S.mgrRange = 30;
  if (S.mgrMetric == null) S.mgrMetric = "occupancy";
  if (S.repRange == null) S.repRange = 30;
  if (S.repTab == null) S.repTab = "performance";
  if (S.revwRating == null) S.revwRating = "all";
  if (S.revwChannel == null) S.revwChannel = "all";
  if (S.revwStatus == null) S.revwStatus = "all";
  if (S.revwQuery == null) S.revwQuery = "";

  var METRICS = {
    occupancy: { label: "Occupancy", suffix: "%", minZero: true },
    adr: { label: "Average daily rate", money: true, minZero: true },
    revpar: { label: "RevPAR", money: true, minZero: true },
    revenue: { label: "Room revenue", money: true, minZero: true }
  };

  function avg(list, key) {
    if (!list || !list.length) return 0;
    return list.reduce(function (s, x) { return s + (Number(x[key]) || 0); }, 0) / list.length;
  }
  function round(n, step) { step = step || 1; return Math.round((Number(n) || 0) / step) * step; }
  function first(name) { return String(name || "there").split(" ")[0]; }
  function propertyShort(id) { var p = LHMS.get.property(id); return p ? p.short : "Property"; }
  function channelColor(i) { return ui.series(i); }

  function pace(pid) {
    var hist = (db.history[pid] || []).slice();
    var m = LHMS.calc.metrics(pid);
    var prior = hist.slice(-15, -8);
    var out = {};
    [
      ["occupancy", m.occupancy], ["adr", m.adr], ["revpar", m.revpar], ["revenue", m.roomRevenue]
    ].forEach(function (pair) {
      var base = avg(prior, pair[0]);
      out[pair[0]] = base ? Math.round((pair[1] - base) / base * 100) : 0;
    });
    return out;
  }

  function movementRow(res, kind) {
    var g = LHMS.get.guest(res.guestId);
    var room = LHMS.get.room(res.roomId);
    var label = kind === "arrival" ? "Arriving " + U.pretty(res.checkIn, "short") : "Due out " + U.pretty(res.checkOut, "short");
    return '<a class="list-row" href="#/booking/' + res.id + '" style="color:inherit;text-decoration:none">' +
      ui.avatar(g ? g.name : "Guest") +
      '<div class="lr-main" style="flex:1"><div style="min-width:0"><div class="lr-title">' + ui.esc(g ? g.name : "Guest") + (res.vip ? ' <span class="vip">VIP</span>' : "") + '</div><div class="lr-sub">' + ui.esc(label) + " · " + U.nights(res.checkIn, res.checkOut) + " nights</div></div></div>" +
      '<div class="lr-meta"><b class="room-no">' + (room ? room.number : "—") + "</b><div class=\"tiny muted\">" + ui.esc(ui.typeName(res.roomTypeId)) + "</div></div></div>";
  }

  function taskRow(t) {
    var sla = LHMS.calc.sla(t);
    var room = t.roomId ? LHMS.get.room(t.roomId) : null;
    return '<div class="list-row"><div class="lr-main" style="flex:1;min-width:0"><span class="avatar sm" style="background:#f5f0e3;color:#8a7038">' + ui.icon(t.type === "Maintenance" ? "wrench" : "message", 13) + "</span>" +
      '<div style="min-width:0"><div class="lr-title" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + ui.esc(t.title) + '</div><div class="lr-sub">' + (room ? "Room " + room.number + " · " : "") + ui.esc(t.priority) + " priority</div></div></div>" +
      '<span class="sla ' + sla.cls + '">' + ui.esc(sla.label) + "</span></div>";
  }

  function reviewStats(pid) {
    var list = db.reviews.filter(function (r) { return r.propertyId === pid; });
    var sum = list.reduce(function (s, r) { return s + r.rating; }, 0);
    var responded = list.filter(function (r) { return r.responded; }).length;
    var dist = [5, 4, 3, 2, 1].map(function (n) { return { n: n, count: list.filter(function (r) { return r.rating === n; }).length }; });
    return { list: list, avg: list.length ? (sum / list.length) : 0, responded: responded, dist: dist, rate: list.length ? Math.round(responded / list.length * 100) : 0 };
  }

  /* ============================================================
     MANAGER DASHBOARD
     ============================================================ */
  LHMS.pages.manager = function () {
    var p = LHMS.get.property();
    var m = LHMS.calc.metrics(p.id);
    var pc = pace(p.id);
    var series = LHMS.calc.series(p.id, S.mgrRange);
    var metric = METRICS[S.mgrMetric] || METRICS.occupancy;
    var chart = ui.areaChart(series.map(function (x) {
      return { label: U.pretty(x.date, "short"), value: x[S.mgrMetric] };
    }), { label: metric.label, money: metric.money, suffix: metric.suffix, minZero: metric.minZero, xTicks: S.mgrRange > 30 ? 8 : 6 });

    var mix = LHMS.calc.channelMix(p.id);
    var mixTotal = mix.reduce(function (s, x) { return s + x.count; }, 0) || 1;
    var donut = ui.donut(mix.slice(0, 5).map(function (x) { return { value: x.count }; }), "Occupancy", m.occupancy + "%");
    var mixRows = mix.slice(0, 5).map(function (x, i) {
      return '<div class="mix-row"><i style="background:' + channelColor(i) + '"></i><span class="mix-label">' + ui.esc(x.name) + '</span><span class="mix-val">' + x.pct + "%</span></div>";
    }).join("");

    var arrivals = LHMS.calc.arrivals(p.id).slice(0, 4);
    var departures = LHMS.calc.departures(p.id).slice(0, 4);
    var openTasks = LHMS.tasksOf(p.id).filter(function (t) { return t.status !== "Done"; }).sort(function (a, b) { return new Date(a.dueAt) - new Date(b.dueAt); }).slice(0, 4);
    var vips = LHMS.calc.arrivals(p.id).concat(LHMS.calc.inHouse(p.id)).filter(function (r) {
      var g = LHMS.get.guest(r.guestId);
      return r.vip || (g && g.tier === "Platinum") || /anniversary|birthday/i.test(r.notes || "");
    }).slice(0, 4);
    var sentiment = reviewStats(p.id);
    var deptRevenue = LHMS.calc.departmentRevenue(p.id).slice(0, 6);
    var staff = LHMS.staffOf(p.id).slice(0, 6);

    var baseCur = LHMS.fx.base(p.id);
    return ui.pageHead({
      eyebrow: "General manager · " + p.short + " · " + ui.todayLong(),
      title: "Good morning, " + first(LHMS.session.name),
      sub: "A single view of the house: revenue pace, today's movements, guest sentiment and the team on duty.",
      actions: '<button class="btn" data-act="export-manager">' + ui.icon("download", 14) + ' Snapshot</button><a class="btn primary" href="#/end-of-day">' + ui.icon("clock", 14) + " Run end of day</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Occupancy", m.occupancy + "<small>%</small>", ui.delta(pc.occupancy) + " vs prior 7 days", { icon: "chart", accent: "accent-navy" }) +
        ui.kpi("ADR", U.money(m.adr), ui.delta(pc.adr) + " vs prior 7 days", { icon: "trendUp" }) +
        ui.kpi("RevPAR", U.money(m.revpar), ui.delta(pc.revpar) + " vs prior 7 days", { icon: "trendUp", accent: "accent-green" }) +
        ui.kpi("Room revenue today", U.money(m.roomRevenue), ui.delta(pc.revenue) + " vs prior 7 days", { icon: "card" }) +
        ui.kpi("Balance in house", U.money(m.balanceDue), "Across " + m.inHouse + " folios · counted in " + LHMS.fx.base(p.id), { icon: "receipt", accent: m.balanceDue > 1000000 ? "accent-red" : "" }) +
        ui.kpi("Open requests", m.openTasks, '<span class="chip ' + (LHMS.calc.taskCounts(p.id).late ? "red" : "green") + '">' + LHMS.calc.taskCounts(p.id).late + "</span> past SLA", { icon: "message" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        ui.sectionCard("Revenue intelligence",
          '<div class="toolbar" style="margin-bottom:10px"><div class="seg">' +
            ["occupancy", "adr", "revpar", "revenue"].map(function (k) {
              return '<button class="' + (S.mgrMetric === k ? "on" : "") + '" data-act="mgr-metric" data-metric="' + k + '">' + METRICS[k].label.replace("Average daily rate", "ADR") + "</button>";
            }).join("") +
          '</div><span class="spacer"></span><div class="seg">' +
            [7, 30, 90].map(function (n) { return '<button class="' + (S.mgrRange === n ? "on" : "") + '" data-act="mgr-range" data-range="' + n + '">' + n + "d</button>"; }).join("") +
          "</div></div>" + chart +
          '<div class="chart-legend"><span><i style="background:var(--gold)"></i>' + metric.label + '</span><span class="tiny muted">Live final point includes today\'s operations</span></div>',
          "", "Last " + S.mgrRange + " days · " + p.short, "chart") +
        '<div class="stack">' +
          ui.sectionCard("Pace at a glance", '<div class="stack" style="gap:0">' +
            [["Occupancy", m.occupancy + "%", pc.occupancy], ["ADR", U.money(m.adr), pc.adr], ["RevPAR", U.money(m.revpar), pc.revpar], ["Room revenue", U.money(m.roomRevenue), pc.revenue]].map(function (r) {
              return '<div class="detail-row"><dt>' + r[0] + '</dt><dd><span style="margin-right:6px">' + r[1] + "</span>" + ui.delta(r[2]) + "</dd></div>";
            }).join("") +
            '<div class="detail-row"><dt>Available tonight</dt><dd>' + m.availableTonight + " of " + m.sellable + " sellable</dd></div>" +
            '<div class="detail-row"><dt>Out of order</dt><dd>' + m.ooo + " rooms · " + m.dirty + " dirty</dd></div></div>", "", "Compared with the prior 7 days", "trendUp") +
          ui.sectionCard("Channel mix", '<div class="row" style="gap:18px;align-items:center">' + donut + '<div style="flex:1;min-width:0">' + mixRows + '<div class="tiny muted mt8">' + mixTotal + " bookings across active channels</div></div></div>", "", "Share of reservations on the books", "globe") +
        "</div>" +
      "</div>" +
      '<div class="grid g3 mt16">' +
        ui.sectionCard("Today's movements", '<div class="divider-label" style="margin-top:0">Arrivals · ' + LHMS.calc.arrivals(p.id).length + "</div>" + (arrivals.length ? arrivals.map(function (r) { return movementRow(r, "arrival"); }).join("") : ui.empty("No arrivals", "The house is steady today.", "calendar")) + '<div class="divider-label">Departures · ' + LHMS.calc.departures(p.id).length + "</div>" + (departures.length ? departures.map(function (r) { return movementRow(r, "departure"); }).join("") : ui.empty("No departures", "No checkouts scheduled today.", "logout")), '<a class="btn sm" href="#/today">Open front desk</a>', "Live from the arrivals and departures lists", "calendar") +
        ui.sectionCard("Service recovery queue", openTasks.length ? openTasks.map(taskRow).join("") : ui.empty("All clear", "Every request is resolved.", "checkCircle"), '<a class="btn sm" href="#/requests">All requests</a>', "Open guest requests sorted by SLA", "message") +
        ui.sectionCard("VIPs &amp; occasions", vips.length ? vips.map(function (r) {
          var g = LHMS.get.guest(r.guestId);
          var room = LHMS.get.room(r.roomId);
          return '<div class="list-row"><div class="lr-main" style="flex:1"><span class="avatar sm">' + U.initials(g ? g.name : "G") + '</span><div style="min-width:0"><div class="lr-title">' + ui.esc(g ? g.name : "Guest") + '</div><div class="lr-sub">' + ui.esc(r.notes || "Platinum recognition · welcome amenity") + "</div></div></div>" +
            '<div class="lr-meta"><b class="room-no">' + (room ? room.number : "—") + "</b><div class=\"tiny muted\">" + ui.tierChip(g ? g.tier : "Member") + "</div></div></div>";
        }).join("") : ui.empty("No VIP arrivals", "No special occasions flagged today.", "star"), '<a class="btn sm" href="#/guests">Guest profiles</a>', "Recognition and occasions to action", "star") +
      "</div>" +
      '<div class="grid g-2-1 mt16">' +
        ui.sectionCard("Property performance", '<div class="table-wrap"><table class="data mini"><thead><tr><th>Property</th><th class="right">Occ.</th><th class="right">ADR</th><th class="right">RevPAR</th><th class="right">Room revenue</th><th class="right">Balance</th><th></th></tr></thead><tbody>' +
          db.properties.map(function (prop) {
            var pm = LHMS.calc.metrics(prop.id);
            // Each hotel keeps its own books, so a Ghanaian ADR is printed in
            // cedis and a Nigerian one in naira — never one sign for three
            // moneys in the same column.
            var own = LHMS.fx.base(prop.id);
            return '<tr class="clickable" data-act="jump-property" data-property="' + prop.id + '"><td><div class="row" style="gap:7px"><span class="dotline" style="background:' + (prop.id === p.id ? "var(--gold)" : "var(--line)") + '"></span><div><b class="small">' + ui.esc(prop.short) + '</b><div class="tiny muted">' + ui.esc(prop.city) + "</div></div></div></td>" +
              '<td class="right num">' + pm.occupancy + "%</td><td class=\"right num\">" + U.money(pm.adr, own) + '</td><td class="right num">' + U.money(pm.revpar, own) + '</td><td class="right num">' + U.money(pm.roomRevenue, own) + '</td><td class="right num">' + U.money(pm.balanceDue, own) + '</td><td class="right">' + ui.icon("right", 12) + "</td></tr>";
          }).join("") +
          "</tbody></table></div>", "", "All three hotels · live", "building") +
        ui.sectionCard("Department revenue", ui.barList(deptRevenue.map(function (d, i) { return { label: d.name, value: d.amount, color: channelColor(i) }; }), { money: true }), "", "Charges posted at this hotel · counted in " + baseCur, "utensils") +
      "</div>" +
      '<div class="grid g2 mt16">' +
        ui.sectionCard("Guest sentiment", '<div class="row" style="gap:18px;align-items:flex-start"><div><div style="font-family:var(--serif);font-size:38px;line-height:1">' + sentiment.avg.toFixed(1) + '</div><div class="mt8">' + ui.stars(Math.round(sentiment.avg), 13) + '</div><div class="tiny muted mt8">' + sentiment.list.length + ' reviews · ' + sentiment.rate + "% responded</div></div><div style=\"flex:1;min-width:0\">" +
          sentiment.dist.map(function (d) {
            return '<div class="row" style="gap:8px;margin-bottom:5px"><span class="tiny muted" style="width:10px">' + d.n + '</span><div class="progress" style="flex:1"><span style="width:' + (d.count / Math.max(1, sentiment.list.length) * 100) + '%"></span></div><span class="tiny muted num" style="width:16px;text-align:right">' + d.count + "</span></div>";
          }).join("") + '</div></div><div class="divider-label">Latest</div>' +
          sentiment.list.slice(0, 2).map(function (r) {
            return '<div class="list-row"><div class="lr-main"><div><div class="lr-title">' + ui.esc(r.title) + '</div><div class="lr-sub">' + ui.stars(r.rating, 9) + " · " + ui.esc(r.channel) + " · " + U.pretty(r.date, "short") + "</div></div></div>" + (r.responded ? ui.chip("Replied", "green") : ui.chip("Needs reply", "amber")) + "</div>";
          }).join(""), '<a class="btn sm" href="#/reviews">Reply to reviews</a>', "Reputation across public channels", "star") +
        ui.sectionCard("Team on duty", '<div class="stack" style="gap:0">' + staff.map(function (s) {
          return '<div class="list-row"><div class="lr-main" style="flex:1"><span class="avatar sm">' + U.initials(s.name) + '</span><div><div class="lr-title">' + ui.esc(s.name) + '</div><div class="lr-sub">' + ui.esc(s.title) + " · " + ui.esc(s.department) + "</div></div></div>" +
            '<div class="lr-meta"><span class="chip navy">' + ui.esc(s.shift) + "</span></div></div>";
        }).join("") + "</div>", '<a class="btn sm" href="#/staff">Staff &amp; permissions</a>', "Front office, housekeeping, revenue and leadership", "users") +
      "</div>";
  };

  /* ============================================================
     REPORTS
     ============================================================ */
  function dailyRows(pid, days) {
    return LHMS.calc.series(pid, days).map(function (x) {
      return {
        date: x.date, occupancy: x.occupancy, adr: x.adr, revpar: x.revpar,
        revenue: x.revenue, arrivals: x.arrivals, departures: x.departures, roomsSold: x.roomsSold
      };
    });
  }

  function ratePlanRevenue(pid) {
    var resMap = {};
    LHMS.reservationsOf(pid).forEach(function (r) { resMap[r.id] = r; });
    var map = {};
    db.charges.forEach(function (c) {
      if (c.voided || !resMap[c.reservationId]) return;
      var r = resMap[c.reservationId];
      // A plan's revenue mixes folios billed in different moneys, so it is
      // counted on the books, not by adding face figures together.
      map[r.ratePlanId] = (map[r.ratePlanId] || 0) + LHMS.fx.baseOf(c);
    });
    return Object.keys(map).map(function (id) {
      var plan = LHMS.get.ratePlan(id);
      return { id: id, name: plan ? plan.name : id, amount: map[id] };
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  function channelRevenue(pid) {
    var resMap = {};
    LHMS.reservationsOf(pid).forEach(function (r) { resMap[r.id] = r; });
    var map = {};
    db.charges.forEach(function (c) {
      if (c.voided || !resMap[c.reservationId]) return;
      var r = resMap[c.reservationId];
      map[r.channel] = (map[r.channel] || 0) + LHMS.fx.baseOf(c);
    });
    var total = Object.keys(map).reduce(function (s, k) { return s + map[k]; }, 0) || 1;
    return Object.keys(map).map(function (k) { return { name: k, amount: map[k], pct: Math.round(map[k] / total * 100) }; }).sort(function (a, b) { return b.amount - a.amount; });
  }

  function topGuests(pid) {
    var map = {};
    LHMS.reservationsOf(pid).forEach(function (r) {
      if (r.status !== "Checked out" && r.status !== "In-house") return;
      var f = LHMS.folio(r.id);
      // A guest billed in dollars and a guest billed in naira are ranked on what
      // their folios are worth here, not on two figures that cannot be added.
      map[r.guestId] = (map[r.guestId] || 0) + f.baseTotal;
    });
    return Object.keys(map).map(function (id) {
      var g = LHMS.get.guest(id);
      return { id: id, name: g ? g.name : "Guest", tier: g ? g.tier : "Member", spend: map[id] };
    }).sort(function (a, b) { return b.spend - a.spend; }).slice(0, 8);
  }

  function statusCounts(pid) {
    var counts = { available: 0, occupied: 0, arriving: 0, departing: 0, dirty: 0, inspected: 0, ooo: 0, oos: 0 };
    LHMS.roomsOf(pid).forEach(function (r) { counts[LHMS.roomState(r).key] += 1; });
    return counts;
  }

  LHMS.pages.reports = function () {
    var p = LHMS.get.property();
    var baseCur = LHMS.fx.base(p.id);
    var rows = dailyRows(p.id, S.repRange);
    var totals = {
      revenue: rows.reduce(function (s, r) { return s + r.revenue; }, 0),
      rooms: rows.reduce(function (s, r) { return s + r.roomsSold; }, 0),
      arrivals: rows.reduce(function (s, r) { return s + r.arrivals; }, 0),
      departures: rows.reduce(function (s, r) { return s + r.departures; }, 0)
    };
    var avgOcc = avg(rows, "occupancy");
    var avgAdr = avg(rows, "adr");
    var avgRevpar = avg(rows, "revpar");
    var mix = LHMS.calc.channelMix(p.id);
    var direct = mix.filter(function (x) { return x.name === "Direct"; })[0];
    var sentiment = reviewStats(p.id);
    var planRev = ratePlanRevenue(p.id);
    var chRev = channelRevenue(p.id);
    var deptRev = LHMS.calc.departmentRevenue(p.id);
    var guests = topGuests(p.id);
    var roomCounts = statusCounts(p.id);
    var taskCounts = LHMS.calc.taskCounts(p.id);
    var reviewChannels = {};
    sentiment.list.forEach(function (r) {
      if (!reviewChannels[r.channel]) reviewChannels[r.channel] = { count: 0, sum: 0, replied: 0 };
      reviewChannels[r.channel].count += 1;
      reviewChannels[r.channel].sum += r.rating;
      if (r.responded) reviewChannels[r.channel].replied += 1;
    });

    var tabs = [
      ["performance", "Performance"],
      ["commercial", "Commercial"],
      ["guest", "Guest"],
      ["operations", "Operations"]
    ].map(function (t) {
      return '<button class="tab' + (S.repTab === t[0] ? " active" : "") + '" data-act="rep-tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
    }).join("");

    var dailyTable = '<div class="table-wrap" style="max-height:420px"><table class="data"><thead><tr><th>Date</th><th class="right">Rooms sold</th><th class="right">Occupancy</th><th class="right">ADR</th><th class="right">RevPAR</th><th class="right">Room revenue</th><th class="right">Arrivals</th><th class="right">Departures</th></tr></thead><tbody>' +
      rows.slice().reverse().map(function (r) {
        return '<tr><td><b>' + U.pretty(r.date, "medium") + '</b><div class="tiny muted">' + U.pretty(r.date, "dow") + "</div></td>" +
          '<td class="right num">' + r.roomsSold + '</td><td class="right num">' + r.occupancy.toFixed(1) + '%</td><td class="right num">' + U.money(r.adr) + '</td><td class="right num">' + U.money(r.revpar) + '</td><td class="right num">' + U.money(r.revenue) + '</td><td class="right num">' + r.arrivals + '</td><td class="right num">' + r.departures + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    var performance = '<div class="grid g-2-1">' +
      ui.sectionCard("Daily trading statement", dailyTable, '<button class="btn sm" data-act="export-daily">' + ui.icon("download", 12) + " CSV</button>", S.repRange + " nights to " + U.pretty(rows[rows.length - 1].date, "medium"), "file") +
      ui.sectionCard("Group comparison", '<div class="stack" style="gap:0">' + db.properties.map(function (prop) {
        var pm = LHMS.calc.metrics(prop.id);
        return '<div class="detail-row"><dt><b>' + ui.esc(prop.short) + '</b><div class="tiny muted">' + ui.esc(prop.city) + "</div></dt><dd>" + pm.occupancy + "% · " + U.money(pm.revpar, LHMS.fx.base(prop.id)) + " RevPAR</dd></div>";
      }).join("") + "</div>" +
        '<div class="panel mt12"><div class="panel-title">Scheduled reporting</div><div class="detail-row"><dt>Daily flash</dt><dd>07:00 · GM &amp; Finance</dd></div><div class="detail-row"><dt>Weekly commercial</dt><dd>Monday · Revenue</dd></div><div class="detail-row"><dt>Monthly owner pack</dt><dd>1st · Group office</dd></div></div>', '<button class="btn sm" data-act="print-report">' + ui.icon("printer", 12) + " Print</button>", "Occupancy, ADR and RevPAR across hotels", "building") +
      "</div>";

    var commercial = '<div class="grid g3">' +
      ui.sectionCard("Revenue by channel", '<div class="table-wrap"><table class="data mini"><thead><tr><th>Channel</th><th class="right">Revenue</th><th class="right">Share</th></tr></thead><tbody>' +
        chRev.map(function (c) { return '<tr><td><b>' + ui.esc(c.name) + '</b></td><td class="right num">' + U.money(c.amount) + '</td><td class="right num">' + c.pct + "%</td></tr>"; }).join("") + "</tbody></table></div>", "", "Charges posted to guest folios · counted in " + baseCur, "globe") +
      ui.sectionCard("Revenue by rate plan", ui.barList(planRev.map(function (x, i) { return { label: x.name, value: x.amount, color: channelColor(i) }; }), { money: true }), "", "Which commercial products are working · counted in " + baseCur, "card") +
      ui.sectionCard("Department revenue", ui.barList(deptRev.map(function (d, i) { return { label: d.name, value: d.amount, color: channelColor(i) }; }), { money: true }), "", "Rooms, F&amp;B, spa and ancillary · counted in " + baseCur, "utensils") +
      "</div>" +
      '<div class="grid g2 mt16">' +
      ui.sectionCard("Channel economics", '<div class="table-wrap"><table class="data"><thead><tr><th>Channel</th><th class="right">Bookings</th><th class="right">Share</th><th>Contribution</th></tr></thead><tbody>' +
        mix.map(function (c, i) {
          return '<tr><td><b>' + ui.esc(c.name) + '</b><div class="tiny muted">' + (c.name === "Direct" ? "No commission" : c.name === "Booking.com" || c.name === "Expedia" ? "OTA commission" : "Negotiated") + '</div></td><td class="right num">' + c.count + '</td><td class="right num">' + c.pct + '%</td><td><div class="progress"><span style="width:' + c.pct + "%;background:" + channelColor(i) + '"></span></div></td></tr>';
        }).join("") + "</tbody></table></div>", "", "Mix across active reservations", "trendUp") +
      ui.sectionCard("Commercial actions", '<div class="stack" style="gap:9px"><div class="notice info">' + ui.icon("alert") + "<div><b>Rate parity alert.</b> Booking.com is selling Deluxe King 4% below the direct rate for 12–14 Nov.</div></div>" +
        '<div class="detail-row"><dt>Direct booking share</dt><dd>' + (direct ? direct.pct : 0) + "%</dd></div>" +
        '<div class="detail-row"><dt>Best performing plan</dt><dd>' + ui.esc(planRev[0] ? planRev[0].name : "—") + "</dd></div>" +
        '<div class="detail-row"><dt>Ancillary revenue</dt><dd>' + U.money(deptRev.filter(function (d) { return d.name !== "Rooms" && d.name !== "Taxes & service"; }).reduce(function (s, d) { return s + d.amount; }, 0)) + "</dd></div>" +
        '<a class="btn soft" href="#/revenue">' + ui.icon("trendUp", 12) + " Review rates &amp; inventory</a></div>", "", "What to do next", "sparkles") +
      "</div>";

    var guestTab = '<div class="grid g-2-1">' +
      ui.sectionCard("Top guests by value", '<div class="table-wrap"><table class="data"><thead><tr><th>Guest</th><th>Tier</th><th class="right">Lifetime value</th><th></th></tr></thead><tbody>' +
        guests.map(function (g) {
          return '<tr class="clickable" data-act="open-guest" data-guest="' + g.id + '"><td><div class="who">' + ui.avatar(g.name) + '<div><div class="who-name">' + ui.esc(g.name) + '</div><div class="who-sub">' + ui.esc(g.tier) + " member</div></div></div></td><td>" + ui.tierChip(g.tier) + '</td><td class="right num">' + U.money(g.spend) + '</td><td class="right">' + ui.icon("right", 12) + "</td></tr>";
        }).join("") + "</tbody></table></div>", '<a class="btn sm" href="#/guests">Guest directory</a>', "Highest folio value at this property · counted in " + baseCur, "users") +
      ui.sectionCard("Review channels", '<div class="stack" style="gap:10px">' + Object.keys(reviewChannels).map(function (ch) {
        var c = reviewChannels[ch];
        return '<div><div class="row between"><span class="small strong">' + ui.esc(ch) + '</span><span class="tiny muted">' + (c.sum / c.count).toFixed(1) + "★ · " + c.count + " reviews</span></div><div class=\"progress\" style=\"margin-top:5px\"><span style=\"width:" + (c.replied / Math.max(1, c.count) * 100) + '%"></span></div><div class="tiny muted" style="margin-top:3px">' + c.replied + " of " + c.count + " responded</div></div>";
      }).join("") + "</div>", "", "Where guests are talking", "star") +
      "</div>" +
      '<div class="grid g2 mt16">' +
      ui.sectionCard("Consent coverage", '<div class="stack">' +
        [["Marketing", function (g) { return g.consent && g.consent.marketing; }], ["Data sharing", function (g) { return g.consent && g.consent.dataSharing; }], ["Profiling", function (g) { return g.consent && g.consent.profiling; }]].map(function (row) {
          var count = db.guests.filter(row[1]).length;
          return '<div><div class="row between" style="margin-bottom:4px"><span class="small strong">' + row[0] + '</span><span class="tiny muted">' + count + " / " + db.guests.length + '</span></div><div class="progress"><span style="width:' + (count / db.guests.length * 100) + '%"></span></div></div>';
        }).join("") + "</div>", "", "NDPR / GDPR preference coverage", "shield") +
      ui.sectionCard("Guest mix", '<div class="kpis" style="margin:0;grid-template-columns:1fr 1fr">' +
        ui.kpi("Profiles", db.guests.length, "Across the group", { icon: "users" }) +
        ui.kpi("Platinum", db.guests.filter(function (g) { return g.tier === "Platinum"; }).length, "Highest recognition", { icon: "star" }) +
        ui.kpi("In residence", LHMS.calc.inHouse(p.id).length, "At " + p.short, { icon: "bed" }) +
        ui.kpi("Reviews", sentiment.list.length, sentiment.avg.toFixed(1) + "★ average", { icon: "message" }) +
        "</div>", "", "Profile and sentiment at a glance", "users") +
      "</div>";

    var operations = '<div class="grid g3">' +
      ui.sectionCard("Room status", '<div class="stack" style="gap:9px">' +
        [["available", "Available"], ["occupied", "Occupied"], ["arriving", "Arriving"], ["departing", "Departing"], ["dirty", "Dirty"], ["ooo", "Out of order"]].map(function (r) {
          return '<div class="row between"><span class="small">' + (r[0] === "ooo" ? ui.chip(r[1], "red") : ui.roomStatusChip(r[0])) + '</span><b class="num">' + (roomCounts[r[0]] || 0) + "</b></div>";
        }).join("") + "</div>", "", LHMS.roomsOf(p.id).length + " keys at " + p.short, "grid") +
      ui.sectionCard("Service levels", '<div class="kpis" style="margin:0;grid-template-columns:1fr 1fr">' +
        ui.kpi("Open", taskCounts.open, "Awaiting an owner", { icon: "message" }) +
        ui.kpi("In progress", taskCounts.progress, "Assigned", { icon: "broom" }) +
        ui.kpi("Late", taskCounts.late, "Past SLA", { icon: "alert", accent: taskCounts.late ? "accent-red" : "" }) +
        ui.kpi("Resolved", taskCounts.done, "Closed today", { icon: "checkCircle", accent: "accent-green" }) +
        "</div>", "", "Guest requests and housekeeping tasks", "clock") +
      ui.sectionCard("Lost &amp; found", '<div class="stack" style="gap:0">' +
        db.lostFound.filter(function (l) { return l.propertyId === p.id; }).slice(0, 5).map(function (l) {
          return '<div class="detail-row"><dt><b>' + ui.esc(l.item) + '</b><div class="tiny muted">Room ' + ui.esc(l.room) + " · " + U.pretty(l.date, "short") + "</div></dt><dd>" + ui.chip(l.status, l.status === "Returned" ? "green" : "amber") + "</dd></div>";
        }).join("") + "</div>", '<a class="btn sm" href="#/lost-found">Register</a>', "Items in the housekeeping safe", "box") +
      "</div>" +
      '<div class="grid g2 mt16">' +
      ui.sectionCard("Housekeeping productivity", '<div class="table-wrap"><table class="data mini"><thead><tr><th>Room type</th><th class="right">Rooms</th><th class="right">Clean</th><th class="right">Dirty</th><th class="right">OOO</th></tr></thead><tbody>' +
        db.roomTypes.map(function (t) {
          var rooms = LHMS.roomsOf(p.id).filter(function (r) { return r.typeId === t.id; });
          return '<tr><td><b>' + ui.esc(t.name) + '</b></td><td class="right num">' + rooms.length + '</td><td class="right num">' + rooms.filter(function (r) { return r.hk === "Clean" || r.hk === "Inspected"; }).length + '</td><td class="right num">' + rooms.filter(function (r) { return r.hk === "Dirty"; }).length + '</td><td class="right num">' + rooms.filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; }).length + "</td></tr>";
        }).join("") + "</tbody></table></div>", "", "Inventory condition by product", "broom") +
      ui.sectionCard("Operational risks", '<div class="stack" style="gap:9px">' + [
        ["Unresolved folios", LHMS.calc.inHouse(p.id).filter(function (r) { return LHMS.folio(r.id).balance > 0; }).length + " in-house balances"],
        ["Rooms out of order", roomCounts.ooo + " unavailable tonight"],
        ["Dirty rooms", roomCounts.dirty + " awaiting housekeeping"],
        ["Late requests", taskCounts.late + " past the response window"],
        ["No-shows", LHMS.reservationsOf(p.id).filter(function (r) { return r.status === "No-show"; }).length + " recorded today"]
      ].map(function (r) {
        return '<div class="detail-row"><dt>' + r[0] + "</dt><dd>" + r[1] + "</dd></div>";
      }).join("") + "</div>", '<a class="btn sm" href="#/end-of-day">Night audit pack</a>', "Summarised for the duty manager", "alert") +
      "</div>";

    var body = S.repTab === "commercial" ? commercial : S.repTab === "guest" ? guestTab : S.repTab === "operations" ? operations : performance;

    return ui.pageHead({
      eyebrow: "Business intelligence · " + p.short,
      title: "Reports",
      sub: "Occupancy, rate, revenue, channel and operational performance for the last " + S.repRange +
        " days. Every money figure is counted in <b>" + ui.esc(baseCur) + "</b>, the money this hotel keeps its books in.",
      actions: '<button class="btn" data-act="print-report">' + ui.icon("printer", 14) + ' Print</button><button class="btn primary" data-act="export-report">' + ui.icon("download", 14) + " Export pack</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Room revenue", U.money(totals.revenue), "Last " + S.repRange + " days", { icon: "card", accent: "accent-navy" }) +
        ui.kpi("Average occupancy", avgOcc.toFixed(1) + "<small>%</small>", totals.rooms + " room nights sold", { icon: "chart" }) +
        ui.kpi("Average ADR", U.money(avgAdr), "Blended across segments", { icon: "trendUp" }) +
        ui.kpi("Average RevPAR", U.money(avgRevpar), "Revenue per available room", { icon: "trendUp", accent: "accent-green" }) +
        ui.kpi("Direct share", (direct ? direct.pct : 0) + "<small>%</small>", "Lowest cost of acquisition", { icon: "globe" }) +
        ui.kpi("Guest rating", sentiment.avg.toFixed(1) + "<small>/5</small>", sentiment.list.length + " reviews", { icon: "star" }) +
      "</div>" +
      '<div class="card mb16"><div class="row between wrap"><div class="tabs">' + tabs + '</div><div class="seg">' +
        [7, 30, 90].map(function (n) { return '<button class="' + (S.repRange === n ? "on" : "") + '" data-act="rep-range" data-range="' + n + '">' + n + " days</button>"; }).join("") +
      "</div></div></div>" +
      '<div class="grid g2">' +
        ui.sectionCard("Occupancy trend", ui.areaChart(rows.map(function (r) { return { label: U.pretty(r.date, "short"), value: r.occupancy }; }), { suffix: "%", minZero: true, xTicks: 7, label: "Occupancy trend" }), "", "Percent of sellable rooms", "chart") +
        ui.sectionCard("Revenue and ADR", ui.areaChart(rows.map(function (r) { return { label: U.pretty(r.date, "short"), value: r.revenue }; }), { money: true, minZero: true, xTicks: 7, alt: rows.map(function (r) { return { value: r.adr }; }), altScale: Math.max.apply(null, rows.map(function (r) { return r.adr; })), label: "Revenue trend" }) + '<div class="chart-legend"><span><i style="background:#b18f52"></i>Room revenue</span><span><i style="background:#4b6d92"></i>ADR</span></div>', "", "Room revenue with ADR overlay", "trendUp") +
      "</div>" +
      '<div class="mt16">' + body + "</div>";
  };

  /* ============================================================
     RATE & INVENTORY
     ============================================================ */
  LHMS.pages.revenue = function () {
    var p = LHMS.get.property();
    var m = LHMS.calc.metrics(p.id);
    var types = db.roomTypes;
    var plans = db.ratePlans;
    var sellable = m.sellable;
    var today = LHMS.day;
    var baseType = types[0];
    var basePriceSvc = LHMS.price.forRef("room", baseType.id);
    var baseRateRow = basePriceSvc && LHMS.price.baseRow(basePriceSvc.id);
    var baseRate = baseRateRow ? baseRateRow.amount : 0;
    // Every figure on this page is a rate on the standard list, so one money
    // names them all — a cedi forecast never borrows the naira sign.
    var rateCur = baseRateRow ? baseRateRow.currency : LHMS.fx.base(p.id);
    var weekendPct = (baseRateRow && baseRateRow.surcharges.weekendPct) || 0;
    var activeRes = LHMS.reservationsOf(p.id).filter(function (r) { return r.status === "Confirmed" || r.status === "In-house"; });
    var forecast = [];
    for (var i = 0; i < 14; i++) {
      var day = U.addDays(today, i);
      var soldMap = {};
      activeRes.forEach(function (r) { if (r.checkIn <= day && r.checkOut > day) soldMap[r.roomId] = true; });
      var sold = Object.keys(soldMap).length;
      var available = Math.max(0, sellable - sold);
      var occ = sellable ? sold / sellable * 100 : 0;
      var factor = U.isWeekend(day) ? 1 + weekendPct / 100 : 1;
      if (occ >= 88) factor *= 1.12;
      else if (occ < 50) factor *= 0.96;
      var rec = round(baseRate * p.rateIndex * factor, 50);
      forecast.push({ day: day, sold: sold, available: available, occ: occ, rate: rec });
    }
    var peak = forecast.slice().sort(function (a, b) { return b.occ - a.occ; })[0];
    var soft = forecast.slice().sort(function (a, b) { return a.occ - b.occ; })[0];

    var rateCards = types.map(function (t) {
      var rooms = LHMS.roomsOf(p.id).filter(function (r) { return r.typeId === t.id; });
      var ooo = rooms.filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; }).length;
      var av = LHMS.calc.availability(t.id, today, U.addDays(today, 1));
      var priceSvc = LHMS.price.forRef("room", t.id);
      var priceRow = priceSvc && LHMS.price.baseRow(priceSvc.id);
      var base = priceRow ? priceRow.amount : 0;
      var weekend = round(base * (1 + ((priceRow && priceRow.surcharges.weekendPct) || 0) / 100), 50);
      return '<div class="panel" style="background:#fff">' +
        '<div class="row between" style="align-items:flex-start"><div><div class="row" style="gap:7px"><b class="small">' + ui.esc(t.name) + '</b>' + (t.stopSell ? ui.chip("Stop sell", "red") : "") + '</div><div class="tiny muted" style="margin-top:2px">' + ui.esc(t.code) + " · " + t.size + "m² · sleeps " + t.occupancy + "</div></div>" + ui.icon("bed", 16) + "</div>" +
        '<div class="row between mt12"><div><div class="g-label">Base rate</div><div style="font-family:var(--serif);font-size:20px;margin-top:2px">' + U.money(base, (priceRow || {}).currency) + '</div></div><div style="text-align:right"><div class="g-label">Weekend</div><div class="small strong" style="margin-top:5px">' + U.money(weekend, (priceRow || {}).currency) + "</div></div></div>" +
        '<div class="detail-row mt8"><dt>Rooms</dt><dd>' + rooms.length + " · " + ooo + " OOO</dd></div>" +
        '<div class="detail-row"><dt>Available tonight</dt><dd>' + (t.stopSell ? "Closed" : av.free) + " of " + av.total + "</dd></div>" +
        '<div class="row mt8" style="gap:5px"><button class="btn sm" data-act="edit-rate" data-type="' + t.id + '">' + ui.icon("edit", 11) + ' Edit rate</button><button class="btn sm ghost" data-act="rev-stop-sell" data-type="' + t.id + '">' + (t.stopSell ? "Re-open" : "Stop sell") + "</button></div></div>";
    }).join("");

    var planRows = plans.map(function (pl) {
      var effective = round(baseRate * pl.modifier, 50);
      return '<tr><td><div class="row" style="gap:7px"><span class="dotline" style="background:' + pl.colour + '"></span><div><b class="small">' + ui.esc(pl.name) + '</b><div class="tiny muted">' + ui.esc(pl.code) + " · " + ui.esc(pl.includes) + "</div></div></div></td>" +
        '<td class="right num">' + Math.round(pl.modifier * 100) + "%</td>" +
        '<td class="right num">' + U.money(effective, rateCur) + "</td>" +
        '<td class="right num">' + pl.depositPct + "%</td>" +
        '<td><span class="tiny muted">' + ui.esc(pl.cancel) + "</span></td>" +
        '<td class="right"><button class="btn sm ghost" data-act="edit-plan" data-plan="' + pl.id + '">Edit</button></td></tr>';
    }).join("");

    var forecastRows = forecast.map(function (f) {
      var chip = f.occ >= 88 ? ui.chip("Peak", "red") : f.occ >= 70 ? ui.chip("Strong", "amber") : f.occ >= 50 ? ui.chip("Healthy", "green") : ui.chip("Soft", "navy");
      return '<tr><td><b>' + U.pretty(f.day, "medium") + '</b><div class="tiny muted">' + U.pretty(f.day, "dow") + (U.isWeekend(f.day) ? " · weekend" : "") + "</div></td>" +
        '<td class="right num">' + f.sold + '</td><td class="right num">' + f.available + "</td>" +
        '<td><div class="row" style="gap:7px"><div class="progress" style="width:70px"><span style="width:' + Math.min(100, f.occ) + '%"></span></div><span class="tiny num">' + f.occ.toFixed(0) + "%</span></div></td>" +
        '<td class="right num"><b>' + U.money(f.rate, rateCur) + "</b></td><td>" + chip + "</td></tr>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Commercial · " + p.short,
      title: "Rate & inventory",
      sub: "Base rates, rate plans, stop-sell controls and a 14-night availability forecast. Changes are stamped into the activity log.",
      actions: '<button class="btn" data-act="push-rates">' + ui.icon("send", 14) + ' Push to channels</button><a class="btn primary" href="#/timeline">' + ui.icon("calendar", 14) + " Availability</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Sellable rooms", sellable, m.ooo + " out of order", { icon: "bed", accent: "accent-navy" }) +
        ui.kpi("Base Deluxe King", U.money(baseRate, rateCur), "Central price catalogue, in " . rateCur, { icon: "card" }) +
        ui.kpi("Rate plans", plans.length, "Direct, corporate and partner", { icon: "list" }) +
        ui.kpi("Peak night", peak.occ.toFixed(0) + "<small>%</small>", U.pretty(peak.day, "short") + " · " + U.money(peak.rate, rateCur), { icon: "trendUp", accent: "accent-red" }) +
        ui.kpi("Softest night", soft.occ.toFixed(0) + "<small>%</small>", U.pretty(soft.day, "short") + " · " + U.money(soft.rate, rateCur), { icon: "trendDown", accent: "accent-green" }) +
      "</div>" +
      '<div class="notice info mb16">' + ui.icon("alert") + "<div><b>Rate parity alert.</b> A partner channel is selling Deluxe King 4% below the direct rate for 12–14 Nov. Review the partner rate before the next push.</div></div>" +
      '<div class="grid g3">' + rateCards + "</div>" +
      '<div class="grid g-2-1 mt16">' +
        ui.sectionCard("14-night availability &amp; recommended rate", '<div class="table-wrap" style="max-height:430px"><table class="data"><thead><tr><th>Night</th><th class="right">Sold</th><th class="right">Available</th><th>Occupancy</th><th class="right">Recommended</th><th>Demand</th></tr></thead><tbody>' + forecastRows + "</tbody></table></div>", "", "Recommended rate blends base rate, weekend uplift and demand", "calendar") +
        '<div class="stack">' +
          ui.sectionCard("Rate strategy", '<div class="stack" style="gap:0">' +
            '<div class="detail-row"><dt>Peak night</dt><dd>' + U.pretty(peak.day, "short") + " · " + peak.occ.toFixed(0) + "%</dd></div>" +
            '<div class="detail-row"><dt>Softest night</dt><dd>' + U.pretty(soft.day, "short") + " · " + soft.occ.toFixed(0) + "%</dd></div>" +
            '<div class="detail-row"><dt>Overbooking allowance</dt><dd>' + (LHMS.get.settings(p.id).overbooking || 0) + " rooms</dd></div>" +
            '<div class="detail-row"><dt>Currency</dt><dd>NGN · Naira</dd></div></div>' +
            '<div class="notice mt12">' + ui.icon("sparkles") + "<div>Raise weekend rates by 15% where occupancy is above 80%. Hold corporate rates flat until the pace recovers.</div></div>", "", "Rules of thumb for this property", "trendUp") +
          ui.sectionCard("Inventory controls", '<div class="stack" style="gap:8px">' + types.map(function (t) {
            return '<div class="row between"><span class="small">' + ui.esc(t.name) + (t.stopSell ? ' <span class="chip red">Closed</span>' : "") + '</span><button class="btn sm ghost" data-act="rev-stop-sell" data-type="' + t.id + '">' + (t.stopSell ? "Re-open" : "Stop sell") + "</button></div>";
          }).join("") + '<p class="tiny muted">Stop-sell closes a room type for new availability checks and bookings. Existing reservations are not affected.</p></div>', "", "Close or open a room type for sale", "lock") +
        "</div>" +
      "</div>" +
      '<div class="grid g-2-1 mt16">' +
        ui.sectionCard("Rate plans", '<div class="table-wrap"><table class="data"><thead><tr><th>Plan</th><th class="right">Modifier</th><th class="right">Deluxe King</th><th class="right">Deposit</th><th>Cancellation</th><th></th></tr></thead><tbody>' + planRows + "</tbody></table></div>", "", "Commercial products attached to every reservation", "list") +
        ui.sectionCard("Channel distribution", '<div class="stack" style="gap:0">' + LHMS.calc.channelMix(p.id).map(function (c, i) {
          return '<div class="detail-row"><dt><span class="dotline" style="background:' + channelColor(i) + ';margin-right:6px"></span>' + ui.esc(c.name) + "</dt><dd>" + c.pct + "% · " + c.count + " bookings</dd></div>";
        }).join("") + "</div>", '<button class="btn sm" data-act="push-rates">Push rates</button>', "Where the demand is coming from", "globe") +
      "</div>";
  };

  /* ============================================================
     REVIEWS
     ============================================================ */
  var REPLY_TEMPLATES = {
    welcome: "Thank you for taking the time to share your experience. We are delighted you enjoyed your stay and we have shared your kind words with the team. We look forward to welcoming you back to Aurelia Grand.",
    recovery: "Thank you for your feedback, and I am sorry we fell short on this occasion. I would welcome the opportunity to discuss this personally and to make your next stay right. Please contact our guest relations team at guestrelations@aureliagrand.com.",
    detail: "Thank you for the thoughtful review. Your notes on service and facilities have been passed to the department heads, and we are already acting on them. We hope to welcome you back soon."
  };

  function replyModal(review) {
    var g = LHMS.get.guest(review.guestId);
    ui.modal({
      title: "Respond to " + (g ? g.name.split(" ")[0] : "guest"),
      sub: ui.esc(review.title) + " · " + ui.esc(review.channel) + " · " + ui.stars(review.rating, 10),
      body: '<form data-form="review-reply"><input type="hidden" name="reviewId" value="' + review.id + '" />' +
        '<div class="field"><label>Management response</label><textarea id="review-reply-text" name="reply" required style="min-height:128px" placeholder="Thank the guest, acknowledge the detail and invite them back…">' + ui.esc(review.response || "") + "</textarea></div>" +
        '<div class="row wrap mt12" style="gap:6px"><span class="tiny muted">Templates</span>' +
        [["welcome", "Welcome back"], ["recovery", "Service recovery"], ["detail", "Thank the detail"]].map(function (t) {
          return '<button type="button" class="btn sm ghost" data-act="review-template" data-template="' + t[0] + '">' + t[1] + "</button>";
        }).join("") + "</div>" +
        '<div class="notice info mt12">' + ui.icon("shield") + "<div>Responses are public. Never include guest contact details, folio amounts or internal notes.</div></div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-review">Publish response</button>'
    });
  }

  LHMS.pages.reviews = function () {
    var p = LHMS.get.property();
    var stats = reviewStats(p.id);
    var list = stats.list.slice();
    if (S.revwRating !== "all") list = list.filter(function (r) { return r.rating === Number(S.revwRating); });
    if (S.revwChannel !== "all") list = list.filter(function (r) { return r.channel === S.revwChannel; });
    if (S.revwStatus === "unanswered") list = list.filter(function (r) { return !r.responded; });
    if (S.revwStatus === "answered") list = list.filter(function (r) { return r.responded; });
    if (S.revwQuery) {
      var q = S.revwQuery.toLowerCase();
      list = list.filter(function (r) {
        return (r.title + " " + r.body + " " + (r.guestName || "") + " " + r.channel).toLowerCase().indexOf(q) !== -1;
      });
    }
    list.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var channels = {};
    stats.list.forEach(function (r) {
      if (!channels[r.channel]) channels[r.channel] = { count: 0, sum: 0, replied: 0 };
      channels[r.channel].count += 1;
      channels[r.channel].sum += r.rating;
      if (r.responded) channels[r.channel].replied += 1;
    });

    var THEMES = [
      ["Service & team", /service|team|staff|butler|attentive|front desk/i],
      ["Dining", /dinner|breakfast|restaurant|dining|coffee|food|islah/i],
      ["Spa & wellness", /spa|massage|gym|pool|therapy/i],
      ["Room & comfort", /room|suite|villa|bed|pillow|shower/i],
      ["Arrival & departure", /arrival|check-in|checkout|check-out|transfer/i]
    ];
    var themes = THEMES.map(function (t) {
      return { label: t[0], value: stats.list.filter(function (r) { return t[1].test(r.body); }).length };
    }).sort(function (a, b) { return b.value - a.value; });

    var ratingButtons = ["all", 5, 4, 3, 2, 1].map(function (r) {
      var count = r === "all" ? stats.list.length : stats.list.filter(function (x) { return x.rating === r; }).length;
      return '<button class="tab' + (String(S.revwRating) === String(r) ? " active" : "") + '" data-act="revw-rating" data-rating="' + r + '">' + (r === "all" ? "All" : r + "★") + '<span class="count">' + count + "</span></button>";
    }).join("");

    var reviewCards = list.map(function (r) {
      var g = LHMS.get.guest(r.guestId);
      return '<article class="card" style="padding:16px 17px">' +
        '<div class="row between" style="align-items:flex-start;gap:12px"><div class="row" style="gap:9px"><span class="avatar">' + U.initials(r.guestName || (g ? g.name : "Guest")) + '</span><div><div class="row" style="gap:7px"><b class="small">' + ui.esc(r.guestName || (g ? g.name : "Guest")) + "</b>" + (g ? ui.tierChip(g.tier) : "") + '</div><div class="tiny muted" style="margin-top:2px">' + ui.esc(r.channel) + " · " + U.pretty(r.date, "medium") + " · " + ui.esc(r.stay || "") + "</div></div></div>" +
        '<div style="text-align:right"><div>' + ui.stars(r.rating, 12) + '</div><div class="tiny muted" style="margin-top:3px">' + (r.responded ? '<span class="chip green">Responded</span>' : '<span class="chip amber">Needs reply</span>') + "</div></div></div>" +
        '<h3 style="font-family:var(--serif);font-size:16px;font-weight:500;margin:13px 0 6px;letter-spacing:-.01em">' + ui.esc(r.title) + "</h3>" +
        '<p class="small muted" style="line-height:1.7">' + ui.esc(r.body) + "</p>" +
        (r.responded ? '<div class="panel mt12" style="background:#f5f8f4;border-color:#dfe9df"><div class="panel-title" style="color:#4f6f55">Management response</div><p class="small" style="line-height:1.65">' + ui.esc(r.response) + "</p></div>" : "") +
        '<div class="row between mt12"><span class="tiny muted">' + (r.reservationId ? "Linked to reservation" : "No reservation linked") + '</span><button class="btn sm ' + (r.responded ? "" : "primary") + '" data-act="review-reply" data-review="' + r.id + '">' + ui.icon("message", 11) + (r.responded ? " Edit response" : " Respond") + "</button></div></article>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Reputation · " + p.short,
      title: "Guest reviews",
      sub: "Public feedback from Google, TripAdvisor and the post-stay survey. Response rate is " + stats.rate + "% across " + stats.list.length + " reviews.",
      actions: '<button class="btn" data-act="export-reviews">' + ui.icon("download", 14) + ' Export</button><a class="btn primary" href="#/reports">' + ui.icon("chart", 14) + " Sentiment report</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Average rating", stats.avg.toFixed(1) + "<small>/5</small>", ui.stars(Math.round(stats.avg), 11), { icon: "star", accent: "accent-navy" }) +
        ui.kpi("Total reviews", stats.list.length, "Rolling 90 days", { icon: "message" }) +
        ui.kpi("Response rate", stats.rate + "<small>%</small>", stats.responded + " answered", { icon: "checkCircle", accent: stats.rate >= 70 ? "accent-green" : "accent-red" }) +
        ui.kpi("Five-star", stats.list.filter(function (r) { return r.rating === 5; }).length, "Promoters", { icon: "sparkles" }) +
        ui.kpi("Needs response", stats.list.filter(function (r) { return !r.responded; }).length, "Reply within 48 hours", { icon: "clock", accent: stats.list.filter(function (r) { return !r.responded; }).length ? "accent-red" : "" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        '<div class="stack">' +
          '<section class="card"><div class="toolbar" style="margin-bottom:10px">' +
            ui.searchField("Search reviews, guests or channels", S.revwQuery, "revw-search") +
            '<select class="select" style="max-width:150px" data-change="revw-channel"><option value="all">All channels</option>' +
              Object.keys(channels).map(function (c) { return '<option' + (S.revwChannel === c ? " selected" : "") + ">" + ui.esc(c) + "</option>"; }).join("") + "</select>" +
            '<select class="select" style="max-width:160px" data-change="revw-status"><option value="all">All responses</option><option value="unanswered"' + (S.revwStatus === "unanswered" ? " selected" : "") + '>Needs reply</option><option value="answered"' + (S.revwStatus === "answered" ? " selected" : "") + ">Responded</option></select>" +
            '<span class="spacer"></span><span class="tiny muted">' + list.length + " reviews</span></div>" +
            '<div class="tabs mb12">' + ratingButtons + "</div>" +
            (list.length ? '<div class="stack" style="gap:11px">' + reviewCards + "</div>" : ui.empty("No reviews match", "Try a different rating, channel or search.", "star")) +
          "</section>" +
        "</div>" +
        '<div class="stack">' +
          ui.sectionCard("Rating distribution", '<div class="stack" style="gap:7px">' + stats.dist.map(function (d) {
            return '<div class="row" style="gap:8px"><span class="tiny muted" style="width:18px">' + d.n + '★</span><div class="progress" style="flex:1"><span style="width:' + (d.count / Math.max(1, stats.list.length) * 100) + '%"></span></div><span class="tiny muted num" style="width:20px;text-align:right">' + d.count + "</span></div>";
          }).join("") + "</div>", "", stats.avg.toFixed(2) + " average across all channels", "star") +
          ui.sectionCard("What guests mention", ui.barList(themes, {}), "", "Themes detected in review text", "message") +
          ui.sectionCard("Channel performance", '<div class="stack" style="gap:0">' + Object.keys(channels).map(function (c) {
            var x = channels[c];
            return '<div class="detail-row"><dt><b>' + ui.esc(c) + '</b><div class="tiny muted">' + x.replied + " of " + x.count + " responded</div></dt><dd>" + (x.sum / x.count).toFixed(1) + "★</dd></div>";
          }).join("") + "</div>", "", "Rating and response by source", "globe") +
          ui.sectionCard("Response standards", '<p class="muted small" style="line-height:1.7">Acknowledge every review within 48 hours. Sign off with a name and role, never copy the same reply twice, and move service recovery to a private channel.</p><div class="notice mt12">' + ui.icon("shield") + "<div>Responses are public and retained in the audit trail.</div></div>", "", "Reputation playbook", "shield") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     END OF DAY / NIGHT AUDIT
     The figures, the controls and the close itself all live in the
     store (LHMS.auditPack / LHMS.auditChecks / actions.runNightAudit),
     so what a manager signs off is the same data the pack seals.
     ============================================================ */

  LHMS.pages["end-of-day"] = function () {
    var p = LHMS.get.property();
    // A sign-off belongs to the date it was given. Closing rolls the date, and a
    // checklist that carried over would let tomorrow close itself un-checked.
    if (S.eodDay !== LHMS.day) { S.eodDay = LHMS.day; S.eodChecks = {}; }
    var pack = LHMS.auditPack();
    var audit = LHMS.closedOn(LHMS.day);
    var items = LHMS.auditChecks(pack);
    if (audit) items.forEach(function (i) { S.eodChecks[i.key] = true; });
    var done = items.filter(function (i) { return S.eodChecks[i.key]; }).length;
    var pctDone = Math.round(done / items.length * 100);
    var m = pack.metrics;
    var canClose = LHMS.can("night_audit");

    var checklist = items.map(function (item) {
      return '<label class="check" style="align-items:center;padding:11px 0;border-bottom:1px solid var(--line-2)">' +
        '<input type="checkbox" data-eod-check data-key="' + item.key + '"' + (S.eodChecks[item.key] ? " checked" : "") + (audit ? " disabled" : "") + " />" +
        '<div style="flex:1"><b>' + ui.esc(item.title) + '</b><div class="tiny muted" style="margin-top:2px">' + ui.esc(item.detail) + "</div></div>" +
        (S.eodChecks[item.key] ? '<span class="chip green">Done</span>' : '<span class="chip">Pending</span>') + "</label>";
    }).join("");

    var deptBars = ui.barList(pack.byDept.map(function (d, i) {
      return { label: d.name, value: d.amount, color: channelColor(i) };
    }), { money: true });

    // The nights the close is about to bill appear before anyone signs for the
    // day, not after the money has moved. The run is group-wide — one business
    // date serves every property — so a foreign room says which house it is in.
    // A night whose money the books cannot value is on this list too, wearing the
    // refusal rather than a figure: it stops the run, so it is not "nothing owed".
    var postingProps = {};
    pack.unbilled.concat(pack.unbillable).forEach(function (n) { postingProps[n.res.propertyId] = true; });
    function nightRow(n, chip) {
      var g = LHMS.get.guest(n.res.guestId);
      var prop = LHMS.get.property(n.res.propertyId);
      return '<div class="list-row"><div class="lr-main" style="flex:1"><div class="lr-title">' + ui.esc(g ? g.name : "Guest") +
        '</div><div class="lr-sub">Room ' + ui.roomNo(n.res.roomId) +
        (prop && prop.id !== p.id ? " · " + ui.esc(prop.short) : "") + " · night of " + U.pretty(n.date, "short") +
        '</div></div><span class="chip ' + chip.cls + '">' + chip.text + "</span></div>";
    }
    var billing = pack.unbilled.map(function (n) {
      return nightRow(n, { cls: "amber", text: U.money(n.quote.nightly[0].rate + n.quote.taxes, n.quote.nightly[0].currency) });
    });
    var blocked = pack.unbillable.map(function (n) {
      return nightRow(n, { cls: "red", text: n.price.currency + " · no rate" });
    });
    var rows = '<div class="stack" style="gap:0">' + blocked.concat(billing).join("") + "</div>";
    var held = blocked.length
      ? '<div class="notice error mb12">' + ui.icon("alert") + "<div><b>" + pack.unbillable.length + " open " +
        (pack.unbillable.length === 1 ? "night is" : "nights are") + " priced in a money the books cannot value.</b> " +
        ui.esc(pack.unbillable[0].blocked.error) + " The close refuses rather than seal a day with those nights unbilled." +
        (billing.length ? " The other " + billing.length + " would have posted." : "") + "</div></div>"
      : "";
    var owed = pack.unbilled.length
      ? '<div class="notice mt12">' + ui.icon("receipt") + "<div><b>" + U.money(pack.unbilledTotal) + " of room money is unbilled.</b> Closing the day posts these nights at the rate the price engine holds, then seals them. The total is counted in " + LHMS.fx.base(p.id) + ", the money this property keeps its books in.</div></div>"
      : "";
    var posting = blocked.length || pack.unbilled.length ? held + rows + owed
      : ui.empty("Every folio carries its night", "Nothing in-house is missing a room charge for " + U.pretty(LHMS.day, "short") + ".", "checkCircle");

    var seals = db.closedDays.slice(-6).reverse().map(function (c) {
      return '<div class="list-row"><div class="lr-main" style="flex:1"><div class="lr-title">' + U.pretty(c.date, "medium") +
        '</div><div class="lr-sub">Sealed by ' + ui.esc(c.by) + " at " + U.timeOf(c.at) + " · " + c.posted.length +
        (c.posted.length === 1 ? " night posted" : " nights posted") + " · balance " + U.money(c.stats.balance) +
        '</div></div><span class="chip green">Closed</span></div>';
    }).join("");

    return ui.pageHead({
      eyebrow: "Night audit · " + p.short + " · " + ui.todayLong(),
      title: "End of day",
      sub: audit ? "The day is sealed. The house is running on " + U.pretty(LHMS.day, "medium") + "."
        : "Complete the nightly checks, post the room money the folios are owed, and roll the business date forward.",
      actions: '<button class="btn" data-act="eod-print">' + ui.icon("printer", 14) + ' Print</button><button class="btn" data-act="eod-download">' + ui.icon("download", 14) + ' Audit pack</button><button class="btn primary" data-act="eod-close-open"' + (audit || !canClose ? " disabled" : "") + ">" + ui.icon("lock", 14) + (audit ? " Day closed" : " Close the day") + "</button>"
    }) +
      (audit ? '<div class="notice success mb16">' + ui.icon("checkCircle") + "<div><b>" + U.pretty(audit.date, "medium") + " closed at " + U.timeOf(audit.at) + " by " + ui.esc(audit.by) + ".</b> " + U.money(audit.stats.charges) + " of charges and " + U.money(audit.stats.payments) + " of payments are sealed, " + audit.posted.length + " unbilled nights were posted in the run, and the business date rolled to " + U.pretty(audit.rolledTo, "medium") + ".</div></div>" : "") +
      '<div class="kpis">' +
        ui.kpi("Room revenue today", U.money(m.roomRevenue), m.occupied + " rooms occupied", { icon: "bed", accent: "accent-navy" }) +
        ui.kpi("Charges posted", U.money(pack.chargesTotal), pack.charges.length + " transactions · counted in " + LHMS.fx.base(p.id), { icon: "receipt" }) +
        ui.kpi("Payments taken", U.money(pack.paymentsTotal), pack.payments.length + " settlements", { icon: "card", accent: "accent-green" }) +
        ui.kpi("Balance in house", U.money(m.balanceDue), pack.unresolved.length + " folios open", { icon: "alert", accent: pack.unresolved.length ? "accent-red" : "" }) +
        ui.kpi("Unbilled nights", pack.unbilled.length + pack.unbillable.length,
          pack.unbillable.length ? pack.unbillable.length + " cannot be valued"
            : pack.unbilled.length ? U.money(pack.unbilledTotal) + " to post" : "Every folio billed",
          { icon: "bed", accent: pack.unbillable.length ? "accent-red" : pack.unbilled.length ? "accent-amber" : "" }) +
        ui.kpi("Arrivals pending", pack.arrivals.length, "Confirmed for today", { icon: "calendar" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        ui.sectionCard("Night audit checklist", '<div class="row between mb12"><span class="small strong">' + done + " of " + items.length + ' controls confirmed</span><span class="tiny muted">' + pctDone + '%</span></div><div class="progress mb12" style="height:7px"><span style="width:' + pctDone + '%"></span></div>' + checklist +
          (audit ? '<div class="notice success mt12">' + ui.icon("shield") + "<div>Sealed by " + ui.esc(audit.by) + " at " + U.timeOf(audit.at) + ". Nothing can be posted into this date any more.</div></div>"
            : '<div class="notice mt12">' + ui.icon("clock") + "<div><b>Every control has to be confirmed before the day closes.</b> Closing posts the unbilled nights, seals " + U.pretty(LHMS.day, "medium") + " and moves the house onto " + U.pretty(U.addDays(LHMS.day, 1), "medium") + ".</div></div>" +
              (canClose ? "" : '<div class="notice error mt12">' + ui.icon("shield") + "<div>Your role can review the pack but cannot close the business date.</div></div>")), "", "Confirm each control before closing", "checkCircle") +
        '<div class="stack">' +
          ui.sectionCard("Room money this run posts", posting, '<a class="btn sm" href="#/check-out">Departures</a>', pack.unbillable.length ? "Held: " + pack.unbillable.length + " night" + (pack.unbillable.length === 1 ? "" : "s") + " the books cannot price in the money they are sold in"
            : pack.unbilled.length ? (Object.keys(postingProps).length > 1 ? "Overstays across " + Object.keys(postingProps).length + " properties — one date rolls the group" : "Overstays and folios whose stay ran past the billed nights")
              : "Nothing outstanding against the house", "receipt") +
          ui.sectionCard("Revenue today", deptBars, "", "Charges by department", "chart") +
          ui.sectionCard("Unresolved folios", pack.unresolved.length ? '<div class="stack" style="gap:0">' + pack.unresolved.slice(0, 5).map(function (r) {
            var g = LHMS.get.guest(r.guestId);
            var room = LHMS.get.room(r.roomId);
            return '<div class="list-row"><div class="lr-main" style="flex:1"><span class="avatar sm">' + U.initials(g ? g.name : "G") + '</span><div><div class="lr-title">' + ui.esc(g ? g.name : "Guest") + '</div><div class="lr-sub">Room ' + (room ? room.number : "—") + " · " + ui.esc(r.reference) + "</div></div></div>" + fxBalance(r.id) + "</div>";
          }).join("") + "</div>" : ui.empty("All folios settled", "Nothing outstanding in house.", "checkCircle"), "", "Balances to settle before close", "receipt") +
          ui.sectionCard("System health", '<div class="stack" style="gap:0">' +
            '<div class="detail-row"><dt>Payment gateway</dt><dd><span class="chip green">Operational</span></dd></div>' +
            '<div class="detail-row"><dt>Door locks</dt><dd><span class="chip green">Operational</span></dd></div>' +
            '<div class="detail-row"><dt>Channel manager</dt><dd><span class="chip green">Synced</span></dd></div>' +
            '<div class="detail-row"><dt>Audit records</dt><dd>' + db.activity.length + " entries</dd></div>" +
            '<div class="detail-row"><dt>Business date</dt><dd>' + U.pretty(LHMS.day, "short") + " · " + db.closedDays.length + (db.closedDays.length === 1 ? " day sealed" : " days sealed") + "</dd></div></div>", "", "Integrations and compliance", "shield") +
        "</div>" +
      "</div>" +
      '<div class="grid g2 mt16">' +
        ui.sectionCard("Departures with a balance", '<div class="table-wrap"><table class="data mini"><thead><tr><th>Guest</th><th>Room</th><th>Reference</th><th class="right">Balance</th><th></th></tr></thead><tbody>' +
          (pack.departures.filter(function (r) { return LHMS.folio(r.id).balance > 0; }).length ? pack.departures.filter(function (r) { return LHMS.folio(r.id).balance > 0; }).map(function (r) {
            var g = LHMS.get.guest(r.guestId);
            var bal = LHMS.folio(r.id);
            return '<tr><td><b>' + ui.esc(g ? g.name : "Guest") + '</b></td><td class="room-no">' + ui.roomNo(r.roomId) + '</td><td class="ref">' + ui.esc(r.reference) + '</td><td class="right num">' + U.money(bal.balance, bal.currency) + '</td><td class="right"><button class="btn sm ghost" data-act="open-res" data-res="' + r.id + '">Open</button></td></tr>';
          }).join("") : '<tr><td colspan="5"><div class="empty" style="border:0;background:transparent">No departure carries a balance.</div></td></tr>') + "</tbody></table></div>", "", "Settle before the guest leaves", "logout") +
        ui.sectionCard("Exceptions", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>No-shows today</dt><dd>' + pack.noShows.length + "</dd></div>" +
          '<div class="detail-row"><dt>Out of order</dt><dd>' + pack.ooo.length + " rooms</dd></div>" +
          '<div class="detail-row"><dt>Dirty at close</dt><dd>' + pack.dirty.length + " rooms</dd></div>" +
          '<div class="detail-row"><dt>Open service requests</dt><dd>' + LHMS.calc.taskCounts(p.id).open + "</dd></div>" +
          '<div class="detail-row"><dt>Late requests</dt><dd>' + LHMS.calc.taskCounts(p.id).late + "</dd></div>" +
          '<div class="detail-row"><dt>Reviews awaiting reply</dt><dd>' + reviewStats(p.id).list.filter(function (r) { return !r.responded; }).length + "</dd></div></div>", "", "Items for the morning handover", "alert") +
      "</div>" +
      (db.closedDays.length ? ui.sectionCard("Sealed business dates", '<div class="stack" style="gap:0">' + seals + "</div>", "", "A sealed date cannot take new money, and its pack is the figure finance holds", "lock") : "");
  };

  function fxBalance(resId) {
    var f = LHMS.folio(resId);
    return f.balance > 0 ? '<span class="chip amber">' + U.money(f.balance, f.currency) + "</span>" : '<span class="chip green">Settled</span>';
  }

  function closeDay() {
    var r = LHMS.actions.runNightAudit({ checks: S.eodChecks });
    if (!r.ok) { ui.toast(r.error, "error"); return; }
    ui.closeModal();
    LHMS.rerender();
    ui.toast(U.pretty(r.closed.date, "short") + " sealed · " + r.posted.length +
      (r.posted.length === 1 ? " night posted" : " nights posted") + " · the house now runs on " + U.pretty(r.rolledTo, "short"));
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  Object.assign(LHMS.uiActions, {
    "mgr-range": function (el) { S.mgrRange = Number(el.getAttribute("data-range")); LHMS.rerender(); },
    "mgr-metric": function (el) { S.mgrMetric = el.getAttribute("data-metric"); LHMS.rerender(); },
    "jump-property": function (el) { LHMS.switchProperty(el.getAttribute("data-property")); LHMS.rerender(); },
    "export-manager": function () {
      var rows = [["Property", "Occupancy %", "ADR", "RevPAR", "Room revenue", "Balance in house", "Arrivals", "Departures", "Open requests"]];
      db.properties.forEach(function (prop) {
        var pm = LHMS.calc.metrics(prop.id);
        rows.push([prop.name, pm.occupancy, pm.adr, pm.revpar, pm.roomRevenue, pm.balanceDue, pm.arrivals, pm.departures, pm.openTasks]);
      });
      ui.csv("aurelia-manager-snapshot-" + LHMS.day + ".csv", rows);
      LHMS.log("exported a manager snapshot", "report", "All properties");
      LHMS.save();
      ui.toast("Manager snapshot downloaded.");
    },

    "rep-tab": function (el) { S.repTab = el.getAttribute("data-tab"); LHMS.rerender(); },
    "rep-range": function (el) { S.repRange = Number(el.getAttribute("data-range")); LHMS.rerender(); },
    "export-daily": function () {
      var rows = [["Date", "Rooms sold", "Occupancy %", "ADR", "RevPAR", "Room revenue", "Arrivals", "Departures"]];
      dailyRows(LHMS.get.property().id, S.repRange).forEach(function (r) { rows.push([r.date, r.roomsSold, r.occupancy, r.adr, r.revpar, r.revenue, r.arrivals, r.departures]); });
      ui.csv("aurelia-daily-statement-" + LHMS.get.property().code + "-" + LHMS.day + ".csv", rows);
      ui.toast("Daily trading statement downloaded.");
    },
    "export-report": function () {
      var rows = [["Report", "Metric", "Value"]];
      var p = LHMS.get.property();
      var r = dailyRows(p.id, S.repRange);
      rows.push(["Property", "Property", p.name]);
      rows.push(["Period", "Days", S.repRange]);
      rows.push(["Revenue", "Room revenue", r.reduce(function (s, x) { return s + x.revenue; }, 0)]);
      rows.push(["Revenue", "Rooms sold", r.reduce(function (s, x) { return s + x.roomsSold; }, 0)]);
      rows.push(["Revenue", "Average occupancy", avg(r, "occupancy").toFixed(1)]);
      rows.push(["Revenue", "Average ADR", avg(r, "adr")]);
      rows.push(["Revenue", "Average RevPAR", avg(r, "revpar")]);
      LHMS.calc.channelMix(p.id).forEach(function (c) { rows.push(["Channel", c.name, c.pct + "% / " + c.count + " bookings"]); });
      ratePlanRevenue(p.id).forEach(function (pl) { rows.push(["Rate plan", pl.name, pl.amount]); });
      reviewStats(p.id).dist.forEach(function (d) { rows.push(["Reviews", d.n + " star", d.count]); });
      ui.csv("aurelia-report-pack-" + p.code + "-" + LHMS.day + ".csv", rows);
      LHMS.log("exported a report pack", "report", p.short + " · " + S.repRange + " days");
      LHMS.save();
      ui.toast("Report pack downloaded.");
    },
    "print-report": function () { ui.toast("Opening print dialog…"); setTimeout(function () { window.print(); }, 250); },

    "edit-rate": function (el) {
      var type = LHMS.get.roomType(el.getAttribute("data-type"));
      var svc = type && LHMS.price.forRef("room", type.id);
      var row = svc && LHMS.price.baseRow(svc.id);
      if (!type || !row) { ui.toast("This room type has no price record yet.", "error"); return; }
      var wk = (row.surcharges.weekendPct || 0);
      ui.modal({
        title: "Edit " + type.name + " rate",
        sub: "Writes to the central price catalogue. Confirmed bookings keep the price they were sold at.",
        slim: true,
        body: '<form data-form="rate"><input type="hidden" name="typeId" value="' + type.id + '" />' +
          '<div class="field"><label>Base rate (' + ui.esc(row.currency) + " per night)</label><input name=\"rate\" type=\"number\" min=\"1\" step=\"any\" value=\"" + row.amount + '" required /></div>' +
          '<div class="field mt12"><label>Effective weekend rate</label><input value="' + U.money(LHMS.price.round(row.amount * (1 + wk / 100)), row.currency) + '" disabled /></div>' +
          '<div class="field mt12"><label>Reason for the change</label><input name="reason" placeholder="Required — it is stamped into the audit trail" required /></div>' +
          '<div class="notice info mt12">' + ui.icon("globe") + "<div>All rate plans recalculate from this base. Push to channels after saving.</div></div>" +
          '<p class="tiny muted mt8">Last set by ' + ui.esc(row.updatedBy) + " · " + U.pretty(row.updatedAt.slice(0, 10), "short") +
          ' · <a href="#/prices/' + svc.id + '">full price history</a></p></form>',
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-rate">Save rate</button>'
      });
    },
    "save-rate": function () {
      var form = document.querySelector('form[data-form="rate"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var result = LHMS.actions.updateRate(d.typeId, d.rate, d.reason);
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      ui.closeModal(); LHMS.rerender();
      if (result.queued) { ui.toast(LHMS.outcome(result).text); return; }
      ui.toast("Base rate updated. Push to channels to publish.");
    },
    "edit-plan": function (el) {
      var plan = LHMS.get.ratePlan(el.getAttribute("data-plan"));
      if (!plan) return;
      ui.modal({
        title: "Edit " + plan.name,
        sub: "Commercial terms applied to reservations using this plan.",
        body: '<form data-form="plan"><input type="hidden" name="planId" value="' + plan.id + '" />' +
          '<div class="form-grid">' +
          '<div class="field"><label>Modifier (1.00 = base)</label><input name="modifier" type="number" min="0.5" max="2" step="0.01" value="' + plan.modifier + '" required /></div>' +
          '<div class="field"><label>Deposit %</label><input name="depositPct" type="number" min="0" max="100" step="5" value="' + plan.depositPct + '" required /></div>' +
          '<div class="field span2"><label>Inclusions</label><input name="includes" value="' + ui.esc(plan.includes) + '" /></div>' +
          '<div class="field span2"><label>Cancellation policy</label><textarea name="cancel">' + ui.esc(plan.cancel) + "</textarea></div>" +
          '<div class="field span2"><label>Reason for the change</label><input name="reason" placeholder="Required — it is stamped into the audit trail" required /></div>' +
          "</div></form>",
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-plan">Save plan</button>'
      });
    },
    "save-plan": function () {
      var form = document.querySelector('form[data-form="plan"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var result = LHMS.actions.updatePlan(d.planId,
        { modifier: Number(d.modifier), depositPct: Number(d.depositPct), includes: d.includes, cancel: d.cancel },
        d.reason);
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      ui.closeModal(); LHMS.rerender();
      ui.toast("Rate plan updated.");
    },
    "rev-stop-sell": function (el) {
      var type = LHMS.get.roomType(el.getAttribute("data-type"));
      if (!type) return;
      type.stopSell = !type.stopSell;
      LHMS.log(type.stopSell ? "closed a room type to sale" : "re-opened a room type", "inventory", type.name + " · " + (type.stopSell ? "stop sell" : "sellable"));
      LHMS.save(); LHMS.rerender();
      ui.toast(type.name + (type.stopSell ? " is now closed to new bookings." : " is open for sale again."));
    },
    "push-rates": function () {
      var p = LHMS.get.property();
      var s = LHMS.get.settings(p.id);
      s.lastRatePush = new Date().toISOString();
      LHMS.log("pushed rates to channels", "rate plan", "All plans · " + p.short);
      LHMS.save();
      ui.toast("Rates and inventory pushed to all connected channels.");
    },

    "live:revw-search": function (val) {
      S.revwQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="revw-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:revw-channel": function (el) { S.revwChannel = el.value; LHMS.rerender(); },
    "change:revw-status": function (el) { S.revwStatus = el.value; LHMS.rerender(); },
    "revw-rating": function (el) { S.revwRating = el.getAttribute("data-rating"); LHMS.rerender(); },
    "review-reply": function (el) {
      var r = LHMS.get.review(el.getAttribute("data-review"));
      if (r) replyModal(r);
    },
    "review-template": function (el) {
      var text = document.getElementById("review-reply-text");
      if (text) {
        text.value = REPLY_TEMPLATES[el.getAttribute("data-template")] || "";
        text.focus();
      }
    },
    "save-review": function () {
      var form = document.querySelector('form[data-form="review-reply"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      LHMS.actions.replyReview(d.reviewId, d.reply);
      ui.closeModal(); LHMS.rerender();
      ui.toast("Response published to the review channel.");
    },
    "export-reviews": function () {
      var rows = [["Guest", "Rating", "Title", "Channel", "Date", "Responded", "Response"]];
      db.reviews.filter(function (r) { return r.propertyId === LHMS.get.property().id; }).forEach(function (r) {
        rows.push([r.guestName, r.rating, r.title, r.channel, r.date, r.responded ? "Yes" : "No", r.response || ""]);
      });
      ui.csv("aurelia-reviews-" + LHMS.get.property().code + "-" + LHMS.day + ".csv", rows);
      LHMS.log("exported reviews", "review", LHMS.get.property().short);
      LHMS.save();
      ui.toast("Review export downloaded.");
    },

    "eod-close-open": function () {
      if (LHMS.closedOn(LHMS.day)) return;
      var pack = LHMS.auditPack();
      var pending = LHMS.auditChecks(pack).filter(function (i) { return !S.eodChecks[i.key]; });
      ui.confirm({
        title: "Close " + U.pretty(LHMS.day, "medium") + "?",
        label: "Run night audit",
        id: "eod-close",
        body: pending.length ?
          pending.length + " of " + LHMS.auditChecks(pack).length + " controls still need confirming: " +
            pending.map(function (i) { return i.title; }).join(", ") + ". The audit refuses the close until every one is signed off." :
          pack.unbillable.length ?
            pack.unbillable.length + " open " + (pack.unbillable.length === 1 ? "night is" : "nights are") + " priced in " +
            pack.unbillable.map(function (n) { return n.price.currency; }).join(", ") +
            ", which the books cannot value today. The audit refuses this close rather than seal the day with those nights unbilled. " +
            ui.esc(pack.unbillable[0].blocked.error) :
          "This posts " + pack.unbilled.length + " unbilled " + (pack.unbilled.length === 1 ? "night" : "nights") + " worth " +
            U.money(pack.unbilledTotal) + ", seals " + U.money(pack.chargesTotal) + " of charges and " + U.money(pack.paymentsTotal) +
            " of payments for " + U.pretty(LHMS.day, "medium") + ", and moves the business date to " +
            U.pretty(U.addDays(LHMS.day, 1), "medium") + ". A closed date takes no further money."
      });
    },
    "eod-download": function () {
      var pack = LHMS.auditPack();
      var p = pack.property;
      var rows = [["Aurelia Grand — night audit pack"], ["Property", p.name], ["Business date", pack.day],
        ["Money of account", LHMS.fx.base(p.id)], ["Generated", new Date().toISOString()], ["Generated by", LHMS.actorName()], []];
      rows.push(["Metric", "Value"]);
      rows.push(["Occupancy %", pack.metrics.occupancy]);
      rows.push(["ADR", pack.metrics.adr]);
      rows.push(["RevPAR", pack.metrics.revpar]);
      rows.push(["Room revenue", pack.metrics.roomRevenue]);
      rows.push(["Charges posted", pack.chargesTotal]);
      rows.push(["Payments taken", pack.paymentsTotal]);
      rows.push(["Balance in house", pack.metrics.balanceDue]);
      rows.push(["Arrivals", pack.arrivals.length]);
      rows.push(["Departures", pack.departures.length]);
      rows.push(["No-shows", pack.noShows.length]);
      rows.push([]);
      rows.push(["Department", "Charges"]);
      pack.byDept.forEach(function (d) { rows.push([d.name, d.amount]); });
      rows.push([]);
      rows.push(["Night the audit bills", "Reservation", "Date", "Room charge", "Tax", "Currency"]);
      pack.unbilled.forEach(function (n) {
        rows.push([n.quote.type.name, n.res.reference, n.date, n.quote.nightly[0].rate, n.quote.taxes,
          n.quote.nightly[0].currency || LHMS.fx.base(p.id)]);
      });
      if (!pack.unbilled.length) rows.push(["Nothing unbilled", "", "", 0, 0, ""]);
      pack.unbillable.forEach(function (n) {
        rows.push([LHMS.get.roomType(n.res.roomTypeId).name, n.res.reference, n.date,
          "cannot be valued", "", n.price.currency]);
      });
      rows.push([]);
      rows.push(["Unresolved folio", "Guest", "Balance", "Currency", "Balance on the books"]);
      pack.unresolved.forEach(function (r) {
        var g = LHMS.get.guest(r.guestId);
        var f = LHMS.folio(r.id);
        rows.push([r.reference, g ? g.name : "Guest", f.balance, f.currency, f.baseBalance]);
      });
      rows.push([]);
      rows.push(["Sealed date", "Closed by", "Charges", "Payments", "Balance in house"]);
      db.closedDays.forEach(function (c) {
        rows.push([c.date, c.by, c.stats.charges, c.stats.payments, c.stats.balance]);
      });
      ui.csv("aurelia-night-audit-" + p.code + "-" + pack.day + ".csv", rows);
      LHMS.log("downloaded the night audit pack", "night audit", p.short + " · " + pack.day);
      LHMS.save();
      ui.toast("Night audit pack downloaded.");
    },
    "eod-print": function () { ui.toast("Opening print dialog…"); setTimeout(function () { window.print(); }, 250); }
  });

  document.addEventListener("change", function (e) {
    var box = e.target.closest("[data-eod-check]");
    if (!box) return;
    S.eodChecks[box.getAttribute("data-key")] = box.checked;
    LHMS.rerender();
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-confirm]");
    if (!btn || btn.getAttribute("data-confirm") !== "eod-close") return;
    closeDay();
  });
})();
