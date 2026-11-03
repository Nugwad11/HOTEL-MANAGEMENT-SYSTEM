/* ============================================================
   LHMS — Financial dashboard and operating-expense ledger
   Both screens read LHMS.financeCore, which counts the charges,
   payments, refunds, hall lines and expense rows that actually
   exist. Nothing here types a total into a chart, and a cost
   stays a claim until a second signature lets it into the result.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;

  var S = { range: 30, drill: null, expRange: 30, expStatus: "all", expCat: "all", expQ: "" };

  var PAY_METHODS = ["Transfer", "Card", "Cash", "Cheque", "City ledger"];
  var EXP_TONES = { "Approved": "green", "Pending": "amber", "Rejected": "red" };

  function canRecord() { return LHMS.can("record_expenses"); }
  function canApprove() { return LHMS.can("approve_expenses"); }
  // Every total this page prints is folded onto the books by financeCore, so the
  // money of account is the right sign for all of them.
  function money(n) { return U.money(Math.round(n || 0)); }

  // A cost can be incurred in any money, but only in one the books can value
  // today: an unvalued figure would have to be added to a total as itself. The
  // choices that cannot be valued are shown shut, so the reason is on the screen
  // rather than in a message after the form is submitted.
  function currencyOptions(current) {
    var base = LHMS.fx.base();
    return LHMS.fx.codes.map(function (code) {
      var blocked = code !== base && !LHMS.fx.state(code).usable;
      return '<option value="' + code + '"' + (code === current ? " selected" : "") +
        (blocked ? " disabled" : "") + ">" +
        ui.esc(code + " — " + (LHMS.fx.nameOf(code) || code) + (blocked ? " (no usable rate)" : "")) + "</option>";
    }).join("");
  }
  // The two figures a recorded cost reads as: what the supplier was paid and what
  // the books kept. The kept figure is the one frozen on the record when the money
  // moved, so a rate that has since gone stale cannot rewrite yesterday's ledger.
  // For a cost already paid in the money of account the two are one line.
  function moneyPair(e) {
    if (!e.currency || e.currency === LHMS.fx.base(e.propertyId)) return U.money(e.amount, e.currency);
    return U.money(e.amount, e.currency) + " · " + U.money(LHMS.fx.baseOf(e));
  }

  // A cost rising is not a result improving: the arrow follows the number, the
  // colour follows what it means for the property. And a period with nothing
  // before it has no growth to report, only an absence of history.
  function cmpDelta(nowVal, prevVal, asCost) {
    var d = LHMS.financeCore.delta(nowVal, prevVal);
    if (!prevVal) return '<span class="delta flat">no prior data</span>';
    if (!d) return ui.delta(0, "flat");
    return ui.delta(d, asCost ? (d > 0 ? "down" : "up") : (d > 0 ? "up" : "down"));
  }

  function rangeDef(days) {
    return LHMS.FINANCE_RANGES.filter(function (r) { return r.days === days; })[0] || LHMS.FINANCE_RANGES[2];
  }

  function periodSeg() {
    return '<div class="seg">' + LHMS.FINANCE_RANGES.map(function (r) {
      return '<button class="' + (S.range === r.days ? "on" : "") + '" data-act="fin-range" data-days="' + r.days + '">' + r.label + "</button>";
    }).join("") + "</div>";
  }

  function dayLabel(date, days) {
    if (days >= 60) return U.monthShort(date);
    if (days >= 8) return String(U.dayNum(date));
    return U.pretty(date, "dow");
  }

  /* ---------------- the trend: what was earned against what was banked ---------------- */
  function trendCard(f) {
    var days = f.range;
    if (f.series.length < 2) {
      return ui.sectionCard("Trading through the period",
        ui.empty("One day does not trend", "Choose 7 days or longer to see the shape of trading.", "chart"),
        "", "Revenue earned is the gold line · cash banked is the dashed line", "chart");
    }
    var rev = f.series.map(function (d) { return { label: dayLabel(d.date, days), value: Math.round(d.revenue) }; });
    var coll = f.series.map(function (d) { return { label: dayLabel(d.date, days), value: Math.round(d.collected) }; });
    var peak = 0;
    rev.concat(coll).forEach(function (p) { if (p.value > peak) peak = p.value; });
    var chart = ui.areaChart(rev, {
      width: 760, height: 240, money: true, minZero: true, max: peak,
      alt: coll, xTicks: days >= 60 ? 12 : 7, dots: days <= 40,
      label: "Revenue earned and cash collected per day"
    });
    return ui.sectionCard("Trading through the period", chart +
      '<div class="chart-legend"><span><i style="background:var(--gold)"></i>Revenue earned</span>' +
      '<span><i style="background:var(--navy-4)"></i>Cash collected</span>' +
      '<span class="tiny muted">The gap is credit given, not money lost — it lands in “Still owed to the hotel”.</span></div>',
      '<button class="btn sm" data-act="fin-export">' + ui.icon("download", 11) + " CSV</button>",
      U.pretty(f.period.from, "medium") + " to " + U.pretty(f.period.to, "medium") + " · daily", "chart");
  }

  /* ---------------- the result ---------------- */
  function resultCard(f) {
    var n = f.now, p = f.prev, def = rangeDef(S.range);
    function row(label, value, sub) {
      return '<div class="ft-row"><span>' + label + (sub ? '<div class="tiny muted" style="font-weight:400">' + sub + "</div>" : "") +
        "</span><span class=\"num\">" + value + "</span></div>";
    }
    function cmp(label, nowVal, prevVal, asCost) {
      return '<div class="detail-row"><dt>' + label + '<div class="tiny muted">' + def.cmp + ": " + money(prevVal) + "</div></dt>" +
        "<dd>" + money(nowVal) + " " + cmpDelta(nowVal, prevVal, asCost) + "</dd></div>";
    }
    return ui.sectionCard("Net operating result",
      '<div class="folio-total">' +
        row("Revenue earned", money(n.revenue), "Rooms, halls, restaurant, laundry and ancillary — before tax") +
        row("Operating expenses approved", "− " + money(n.expenses), n.pendingCount + " line" + (n.pendingCount === 1 ? "" : "s") + " still awaiting a signature") +
        '<div class="ft-row big"><span>Net operating result</span><b>' + money(n.net) + "</b></div>" +
      "</div>" +
      '<div class="panel mt12"><div class="panel-title">' + def.label + " against the window before it</div>" +
        cmp("Revenue earned", n.revenue, p.revenue) +
        cmp("Cash collected", n.collected, p.collected) +
        cmp("Expenses approved", n.expenses, p.expenses, true) +
        cmp("Net operating result", n.net, p.net) +
      "</div>",
      '<a class="btn sm" href="#/expenses">' + ui.icon("box", 11) + " Expense ledger</a>",
      "A cost rising is not a result improving — the colour follows the meaning", "trendUp");
  }

  /* ---------------- departments, with the transactions behind each figure ---------------- */
  function deptRows(n) {
    return Object.keys(n.byDept).map(function (k) {
      return { name: k, amount: n.byDept[k] };
    }).sort(function (a, b) { return b.amount - a.amount; });
  }

  function deptCard(f) {
    var n = f.now, rows = deptRows(n);
    if (!rows.length) return ui.sectionCard("Revenue by department", ui.empty("Nothing earned yet", "No charge or hall booking falls inside this window.", "grid"), "", "Click a department to see its transactions", "grid");
    var body = '<div class="table-wrap"><table class="data mini"><thead><tr><th>Department</th><th class="right">Earned</th><th class="right">Share</th><th></th></tr></thead><tbody>' +
      rows.map(function (d, i) {
        var pct = n.revenue ? Math.round(d.amount / n.revenue * 100) : 0;
        return '<tr class="clickable" data-act="fin-drill" data-dept="' + ui.esc(d.name) + '">' +
          '<td><div class="row" style="gap:7px"><span class="dotline" style="background:' + ui.series(i) + '"></span><b class="small">' + ui.esc(d.name) + "</b></div></td>" +
          '<td class="right num">' + money(d.amount) + '</td><td class="right num">' + pct + "%</td>" +
          '<td class="right">' + (S.drill === d.name ? ui.icon("down", 12) : ui.icon("right", 12)) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<div class="tiny muted mt8">Taxes and service charges billed in this window: ' + money(n.taxBilled) + " — billed to the guest, owed to the authorities, never revenue.</div>";
    return ui.sectionCard("Revenue by department", body, "",
      (S.drill ? "Drilled into “" + ui.esc(S.drill) + "” below · " : "") + "Click a row to open the transactions behind the figure", "grid");
  }

  function drillCard(f) {
    var txns = LHMS.financeTxns(S.drill, f.period.from, f.period.to);
    var total = txns.reduce(function (s, t) { return s + t.amount; }, 0);
    var table = '<div class="table-wrap" style="max-height:420px"><table class="data"><thead><tr><th>Date</th><th>Description</th><th>Guest / organiser</th><th>Posted by</th><th class="right">Amount</th></tr></thead><tbody>' +
      txns.slice(0, 60).map(function (t) {
        return '<tr class="clickable" data-act="fin-open" data-href="' + ui.esc(t.href) + '"><td><b>' + U.pretty(t.date, "medium") + '</b></td>' +
          "<td>" + ui.esc(t.description) + '</td><td class="tiny muted">' + ui.esc(t.who) + '</td><td class="tiny muted">' + ui.esc(t.postedBy) + '</td><td class="right num">' + money(t.amount) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
    return '<section class="card mt16" id="fin-drill"><div class="card-head"><div><div class="card-title">' + ui.icon("list", 15) +
      "Transactions behind “" + ui.esc(S.drill) + "”</div>" +
      '<div class="card-sub">' + U.pretty(f.period.from, "medium") + " to " + U.pretty(f.period.to, "medium") + " · " +
      txns.length + " line" + (txns.length === 1 ? "" : "s") + " · every row links to the record that posted it</div></div>" +
      '<button class="btn sm ghost" data-act="fin-drill-close">Close</button></div>' +
      (txns.length ? table + '<div class="detail-row total"><dt>Total earned</dt><dd>' + money(total) + "</dd></div>" +
        (txns.length > 60 ? '<div class="tiny muted mt8">Showing the first 60 of ' + txns.length + " lines. Export the CSV for the full list.</div>" : "")
        : ui.empty("No lines in this window", "The figure came from an earlier period or a different property.", "list")) +
      "</section>";
  }

  /* ---------------- cash, debts and money going back out ---------------- */
  function cashCard(f) {
    var n = f.now;
    var items = Object.keys(n.byMethod).map(function (k) { return { label: k, value: Math.round(n.byMethod[k]) }; })
      .sort(function (a, b) { return b.value - a.value; });
    var donut = items.length ? ui.donut(items, "Banked", U.compact(n.collected)) : "";
    var mix = items.map(function (m, i) {
      return '<div class="mix-row"><i style="background:' + ui.series(i) + '"></i><span class="mix-label">' +
        ui.esc(m.label) + '</span><span class="mix-val">' + money(m.value) + "</span></div>";
    }).join("");
    return ui.sectionCard("Cash in, by method",
      items.length
        ? '<div class="row" style="gap:18px;align-items:center">' + donut + '<div style="flex:1;min-width:0">' + mix +
          '<div class="detail-row mt8"><dt>Matched</dt><dd>' + money(n.reconciled) + "</dd></div>" +
          '<div class="detail-row"><dt>Unmatched</dt><dd>' + (n.unreconciled ? '<span class="chip amber">' + money(n.unreconciled) + "</span>" : money(0)) + "</dd></div>" +
          '<div class="tiny muted mt8">Matched means the receipt is confirmed in the bank statement, not merely typed in.</div>' +
          "</div></div>"
        : ui.empty("No money took in this window", "Every receipt sits outside the period.", "card"),
      '<a class="btn sm" href="#/receipts">' + ui.icon("card", 11) + " Receipts</a>",
      n.paymentCount + " receipt" + (n.paymentCount === 1 ? "" : "s") + " in the period", "card");
  }

  function owedCard(f) {
    var n = f.now;
    return ui.sectionCard("Still owed to the hotel",
      '<div class="stack" style="gap:0">' +
        '<div class="detail-row"><dt>Guest folios</dt><dd>' + money(n.guestOwed) + "</dd></div>" +
        '<div class="detail-row"><dt>Hall &amp; corporate documents</dt><dd>' + money(n.docOwed) + "</dd></div>" +
        '<div class="detail-row total"><dt>Owed as at today</dt><dd>' + money(n.outstanding) + "</dd></div>" +
      "</div>" +
      '<div class="tiny muted mt8">Documents with no room folio behind them — a hall booking or a company account — are the only debt counted outside a guest account.</div>' +
      '<div class="notice info mt12">' + ui.icon("alert") + "<div>This is a position, not a period flow — it is the same figure however the window is set, because a debt does not age away when the chart does. " +
      money(n.prepayments) + " has been taken ahead of the stay.</div></div>",
      '<a class="btn sm" href="#/invoices">' + ui.icon("file", 11) + " Billing queue</a>",
      "Counted once: a charge copied onto an invoice stays on the folio", "receipt");
  }

  function moneyOutCard(f) {
    var n = f.now;
    return ui.sectionCard("Money back out",
      '<div class="stack" style="gap:0">' +
        '<div class="detail-row"><dt>Refunds issued</dt><dd>' + money(n.refunded) + "</dd></div>" +
        '<div class="detail-row"><dt>Approved discounts</dt><dd>' + money(n.discounts) + "</dd></div>" +
        '<div class="detail-row"><dt>Other adjustments</dt><dd>' + money(n.adjustments) + "</dd></div>" +
        '<div class="detail-row total"><dt>Given back in the period</dt><dd>' + money(n.refunded + n.discounts + n.adjustments) + "</dd></div>" +
      "</div>" +
      '<div class="tiny muted mt8">' + n.refundCount + " refund" + (n.refundCount === 1 ? "" : "s") +
      " — a refund never deletes the original line, so the ledger still shows what was first charged.</div>",
      "", "Every reversal carries the name that authorised it", "refresh");
  }

  function rulesCard() {
    var rules = [
      ["Revenue earned", "A charge on the date it was incurred, across every department, plus hall bookings the desk bills without a room account."],
      ["Not revenue", "Taxes and service charges — billed to the guest and passed on. They are shown separately, never inside the trend."],
      ["Cash collected", "Receipts dated inside the window, whether they settled a folio or a document. Less refunds handed back."],
      ["Owed", "Counted exactly once. A charge copied onto an invoice stays on the folio, so invoices only add debt a folio does not already carry."],
      ["Expenses", "Only lines approved by a second signature. A recorded cost is a claim until then and moves no result."],
      ["Net operating result", "Revenue earned less approved operating expenses, for the same window."]
    ];
    return ui.sectionCard("How these numbers are built",
      '<div class="stack" style="gap:0">' + rules.map(function (r) {
        return '<div class="detail-row"><dt><b>' + r[0] + '</b></dt><dd style="font-weight:400;text-align:right;max-width:64%">' + r[1] + "</dd></div>";
      }).join("") + "</div>" +
      '<div class="notice mt12">' + ui.icon("shield") + "<div>The engine is shared: <code>LHMS.financeCore</code> is the only place these rules live, so the dashboard, the ledger and an export can never disagree.</div></div>",
      "", "The accounting rules behind every figure on this page", "shield");
  }

  /* ---------------- dashboard ---------------- */
  LHMS.pages.financials = function () {
    var f = LHMS.finance(S.range);
    var n = f.now, def = rangeDef(S.range);
    var catRows = Object.keys(n.expByCat).map(function (k) { return { label: k, value: Math.round(n.expByCat[k]) }; })
      .sort(function (a, b) { return b.value - a.value; });

    var kpis = '<div class="kpis">' +
      ui.kpi("Revenue earned", money(n.revenue), cmpDelta(n.revenue, f.prev.revenue) +
        '<span class="tiny muted">vs ' + def.cmp + "</span>", { icon: "trendUp", accent: "accent-navy" }) +
      ui.kpi("Cash collected", money(n.collected), money(n.reconciled) + " matched" +
        (n.unreconciled ? ' <span class="chip amber">' + money(n.unreconciled) + " unmatched</span>" : " — every receipt is in the account"),
        { icon: "card", accent: "accent-green" }) +
      ui.kpi("Owed as at today", money(n.outstanding), money(n.guestOwed) + " folios · " + money(n.docOwed) + " documents", { icon: "alert", accent: n.outstanding > 20000000 ? "accent-red" : "" }) +
      ui.kpi("Operating expenses", money(n.expenses), n.expenseCount
        ? n.expenseCount + " line" + (n.expenseCount === 1 ? "" : "s") + " recorded · " + n.pendingCount + " awaiting approval"
        : "No cost recorded inside " + def.label.toLowerCase(), { icon: "box" }) +
      ui.kpi("Net operating result", money(n.net), "Revenue earned less approved costs", { icon: "chart", accent: n.net >= 0 ? "accent-green" : "accent-red" }) +
      "</div>";

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Financial dashboard",
      sub: "Revenue earned, cash collected and what is still owed are three different numbers. This page keeps them apart and shows the rule behind each. Every figure here is counted in <b>" + ui.esc(LHMS.fx.base()) + "</b>, the money of the books.",
      actions: '<a class="btn" href="#/expenses">' + ui.icon("box", 14) + " Expense ledger</a>" +
        '<a class="btn" href="#/fin-reports">' + ui.icon("file", 14) + " Financial reports</a>"
    }) +
      '<div class="toolbar mb16"><div class="toolbar-left">' + periodSeg() + "</div>" +
      '<div class="row"><span class="tiny muted">' + U.pretty(f.period.from, "medium") + " → " + U.pretty(f.period.to, "medium") + "</span></div></div>" +
      kpis +
      (n.pendingCount ? '<div class="notice mb16">' + ui.icon("clock") + "<div><b>" + n.pendingCount + " cost" +
        (n.pendingCount === 1 ? " is" : "s are") + " awaiting a signature (" + money(n.expensesPending) +
        ").</b> They are recorded but not yet in the result. " +
        (canApprove() ? '<a href="#/expenses">Review and decide</a>.' : "Approving belongs to a role with that right — this one can only see the total.") + "</div></div>" : "") +
      '<div class="grid g-2-1">' + trendCard(f) + resultCard(f) + "</div>" +
      '<div class="grid g3 mt16">' + deptCard(f) + cashCard(f) + owedCard(f) + "</div>" +
      (S.drill ? drillCard(f) : "") +
      '<div class="grid g-2-1 mt16">' + rulesCard() +
        ui.sectionCard("Costs approved, by category",
          catRows.length ? ui.barList(catRows.map(function (c, i) { return { label: c.label, value: c.value, color: ui.series(i) }; }), { money: true })
            : ui.empty("No approved cost", "Nothing has cleared a second signature inside this window.", "box"),
          "", "Only approved lines reach the result · " + def.label.toLowerCase(), "box") +
      "</div>" +
      '<div class="grid g2 mt16">' + moneyOutCard(f) +
        ui.sectionCard("The last six costs recorded",
          LHMS.expensesOf().slice(0, 6).map(function (e) {
            return '<div class="list-row"><div class="lr-main"><div style="min-width:0"><div class="lr-title">' + ui.esc(e.description) +
              '</div><div class="lr-sub">' + ui.esc(e.category) + " · " + ui.esc(e.payee) + " · " + U.pretty(e.date, "medium") + "</div></div></div>" +
              '<div class="lr-meta"><b class="num">' + moneyPair(e) + "</b><div class=\"mt8\">" + ui.chip(e.status, EXP_TONES[e.status] || "") + "</div></div></div>";
          }).join("") || ui.empty("Nothing recorded", "The ledger for this property is empty.", "box"),
          '<a class="btn sm" href="#/expenses">Open the ledger</a>', "Newest first, whatever their approval state", "box") +
      "</div>";
  };

  /* ---------------- expense ledger ---------------- */
  var EXP_TABS = [["all", "Everything"], ["Pending", "Awaiting decision"], ["Approved", "Approved"], ["Rejected", "Rejected"]];

  function expVisible() {
    var from = S.expRange ? U.addDays(LHMS.day, -(S.expRange - 1)) : "";
    var q = S.expQ.toLowerCase().trim();
    return LHMS.expensesOf().filter(function (e) {
      if (from && e.date < from) return false;
      if (S.expStatus !== "all" && e.status !== S.expStatus) return false;
      if (S.expCat !== "all" && e.category !== S.expCat) return false;
      if (q && (e.description + " " + e.payee + " " + e.category + " " + e.recordedBy).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function expTabCount(key, all) {
    if (key === "all") return all.length;
    return all.filter(function (e) { return e.status === key; }).length;
  }

  function expRow(e) {
    var decide = e.status === "Pending" && canApprove()
      ? '<div class="row" style="gap:6px;justify-content:flex-end"><button class="btn sm ghost" data-act="exp-decide" data-id="' + e.id + '" data-decide="reject">Reject</button>' +
        '<button class="btn sm primary" data-act="exp-decide" data-id="' + e.id + '" data-decide="approve">Approve</button></div>'
      : e.status === "Pending"
        ? '<span class="tiny muted">Needs a second signature</span>'
        : '<div class="tiny muted">' + ui.esc(e.decidedBy || "—") + "</div>";
    return '<tr class="clickable" data-act="exp-open" data-id="' + e.id + '"><td><b>' + U.pretty(e.date, "medium") + "</b></td>" +
      '<td><div class="row" style="gap:7px"><span class="dotline" style="background:' +
      ui.series(Math.max(0, LHMS.EXPENSE_CATEGORIES.indexOf(e.category))) + '"></span>' +
      '<span class="small strong">' + ui.esc(e.category) + "</span></div></td>" +
      '<td><div class="lr-title">' + ui.esc(e.description) + '</div><div class="lr-sub">' + ui.esc(e.payee) + " · recorded by " + ui.esc(e.recordedBy) + "</div></td>" +
      '<td class="tiny muted">' + ui.esc(e.method) + '</td><td class="right num"><b>' + moneyPair(e) + "</b></td>" +
      '<td>' + ui.chip(e.status, EXP_TONES[e.status] || "") + "</td>" +
      '<td class="right">' + decide + "</td></tr>";
  }

  LHMS.pages.expenses = function () {
    var all = LHMS.expensesOf();
    var list = expVisible();
    var from = S.expRange ? U.addDays(LHMS.day, -(S.expRange - 1)) : "";
    var scoped = all.filter(function (e) { return !from || e.date >= from; });
    var totals = scoped.reduce(function (m, e) {
      // Summed in the money the books are kept in, because a dollar fuel bill
      // and a naira laundry bill added together count neither.
      var v = LHMS.fx.baseOf(e);
      if (e.status === "Approved") m.approved += v;
      else if (e.status === "Pending") m.pending += v;
      else m.rejected += v;
      return m;
    }, { approved: 0, pending: 0, rejected: 0 });

    var tabs = '<div class="tabs mb16">' + EXP_TABS.map(function (o) {
      return '<button class="tab' + (S.expStatus === o[0] ? " active" : "") + '" data-act="exp-tab" data-status="' + o[0] + '">' +
        o[1] + '<span class="count">' + expTabCount(o[0], scoped) + "</span></button>";
    }).join("") + "</div>";

    var toolbar = '<section class="card"><div class="toolbar">' +
      ui.searchField("Search cost, supplier or recorder", S.expQ, "exp-search") +
      '<select class="select" style="max-width:175px" data-change="exp-filter" name="cat"><option value="all">Every category</option>' +
      LHMS.EXPENSE_CATEGORIES.map(function (c) { return '<option value="' + c + '"' + (S.expCat === c ? " selected" : "") + ">" + c + "</option>"; }).join("") +
      '</select><select class="select" style="max-width:150px" data-change="exp-filter" name="range">' +
      [[30, "Last 30 days"], [90, "Last 90 days"], [365, "Last 12 months"], [0, "All time"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (S.expRange === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      '</select><span class="spacer"></span>' +
      '<button class="btn sm" data-act="exp-export">' + ui.icon("download", 11) + " Export CSV</button>" +
      (canRecord() ? '<button class="btn sm primary" data-act="exp-add">' + ui.icon("plus", 11) + " Record a cost</button>" : "") +
      "</div>" +
      (list.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Category</th><th>What the money bought</th><th>Method</th>' +
        '<th class="right">Amount</th><th>Status</th><th class="right">Decision</th></tr></thead><tbody>' +
        list.map(expRow).join("") + "</tbody></table></div>"
        : ui.empty("No cost matches", "Change the filter, or record a line against a supplier.", "box")) +
      "</section>";

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Operating expenses",
      sub: "A cost is a claim until a second signature lets it into the result. Recording and approving are rights that do not sit in the same hands. Totals below are counted in <b>" + ui.esc(LHMS.fx.base()) + "</b>; a line paid in another money shows both.",
      actions: '<a class="btn" href="#/activity">' + ui.icon("clock", 14) + " Audit trail</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Approved in the period", money(totals.approved), scoped.filter(function (e) { return e.status === "Approved"; }).length + " lines inside the operating result", { icon: "checkCircle", accent: "accent-navy" }) +
        ui.kpi("Awaiting a decision", money(totals.pending), '<span class="chip amber">' + scoped.filter(function (e) { return e.status === "Pending"; }).length + " pending</span>", { icon: "clock", accent: "accent-red" }) +
        ui.kpi("Refused", money(totals.rejected), "Kept on the ledger with the reason", { icon: "alert" }) +
        ui.kpi("Every cost recorded", money(totals.approved + totals.pending + totals.rejected), all.length + " lines on this property", { icon: "box" }) +
      "</div>" +
      (canRecord() || canApprove() ? "" : '<div class="notice mb16">' + ui.icon("lock") + "<div><b>Read-only for your role.</b> “Record operating expenses” and “Approve or reject recorded expenses” are both withheld from " +
        ui.esc(LHMS.session.role) + ", so the ledger can be read but not written.</div></div>") +
      (canRecord() && !canApprove() ? '<div class="notice info mb16">' + ui.icon("shield") +
        "<div>You can record a cost but not approve one — including your own. Approval belongs to a different role by design.</div></div>" : "") +
      "<div>" + tabs + toolbar + "</div>";
  };

  /* ---------------- actions: period, drill, export ---------------- */
  LHMS.uiActions["fin-range"] = function (el) {
    S.range = Number(el.getAttribute("data-days"));
    LHMS.rerender();
  };
  LHMS.uiActions["fin-drill"] = function (el) {
    var dept = el.getAttribute("data-dept");
    S.drill = S.drill === dept ? null : dept;
    LHMS.rerender();
    // The shell repaints from the top, so a drill-down that opened off-screen
    // would look like nothing happened.
    var card = document.getElementById("fin-drill");
    if (card) card.scrollIntoView({ block: "start" });
  };
  LHMS.uiActions["fin-drill-close"] = function () { S.drill = null; LHMS.rerender(); };
  LHMS.uiActions["fin-open"] = function (el) { LHMS.go(el.getAttribute("data-href").replace(/^#\//, "")); };

  LHMS.uiActions["fin-export"] = function () {
    var f = LHMS.finance(S.range);
    var rows = [["Date", "Revenue earned", "Cash collected", "Expenses approved", "Net for the day"]];
    f.series.forEach(function (d) {
      rows.push([d.date, Math.round(d.revenue), Math.round(d.collected), Math.round(d.expenses), Math.round(d.revenue - d.expenses)]);
    });
    rows.push([]);
    rows.push(["Period", U.pretty(f.period.from, "medium") + " to " + U.pretty(f.period.to, "medium")]);
    rows.push(["Owed as at today", f.now.outstanding, "Folios", f.now.guestOwed, "Documents", f.now.docOwed]);
    rows.push(["Tax and service billed (not revenue)", f.now.taxBilled]);
    rows.push(["Refunds issued", f.now.refunded, "Discounts", f.now.discounts]);
    LHMS.log("exported a financial statement", "finance", U.pretty(f.period.from, "short") + "→" + U.pretty(f.period.to, "short"));
    LHMS.save();
    ui.csv("aurelia-statement-" + LHMS.session.propertyId + "-" + f.period.from + "-to-" + f.period.to + ".csv", rows);
    ui.toast("Statement downloaded — " + f.series.length + " days.");
  };

  /* ---------------- actions: record a cost ---------------- */
  LHMS.uiActions["exp-add"] = function () {
    if (!canRecord()) { ui.toast("Your role cannot record expenses.", "error"); return; }
    ui.modal({
      title: "Record an operating cost",
      sub: "It enters the result only after a role that can approve has signed it off.",
      slim: true,
      body: '<form id="exp-form">' +
        '<div class="field"><label>What the money bought</label><input name="description" placeholder="Generator service and injector clean" /></div>' +
        '<div class="grid g2 mt12" style="gap:10px">' +
          '<div class="field"><label>Amount</label><input name="amount" type="number" min="1" step="1" placeholder="0" /></div>' +
          '<div class="field"><label>Paid in</label><select name="currency">' +
            currencyOptions(LHMS.fx.base()) + "</select></div>" +
        "</div>" +
        '<div class="grid g2 mt12" style="gap:10px">' +
          '<div class="field"><label>Date incurred</label><input name="date" type="date" value="' + LHMS.day + '" max="' + LHMS.day + '" /></div>' +
          '<div class="field"><label>Category</label><select name="category">' +
            '<option value="">Choose where this belongs</option>' +
            LHMS.EXPENSE_CATEGORIES.map(function (c) { return "<option>" + c + "</option>"; }).join("") +
          "</select></div>" +
        "</div>" +
        '<div class="grid g2 mt12" style="gap:10px">' +
          '<div class="field"><label>Supplier / payee</label><input name="payee" placeholder="Ozolua Motors" /></div>' +
          '<div class="field"><label>Paid by</label><select name="method">' +
            PAY_METHODS.map(function (m) { return "<option>" + m + "</option>"; }).join("") +
          "</select></div>" +
        "</div>" +
        '<div class="field mt12"><label>Invoice reference<span class="hint"> — optional, quoted on the audit trail</span></label>' +
          '<input name="attachment" placeholder="INV-48213" /></div>' +
        '<div class="notice info mt12">' + ui.icon("shield") + "<div>Recorded as " + ui.esc(LHMS.session.name) +
        " today. A second signature is required before this moves the net operating result.</div></div>" +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="exp-add-save">Record the cost</button>'
    });
  };

  LHMS.uiActions["exp-add-save"] = function () {
    var form = document.getElementById("exp-form");
    if (!form) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.addExpense(d);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.expense.category + " " + moneyPair(result.expense) + " recorded — awaiting approval.");
  };

  /* ---------------- actions: decide a cost ---------------- */
  var deciding = null;

  LHMS.uiActions["exp-decide"] = function (el) {
    var e = LHMS.db.expenses.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
    if (!e) return;
    var approve = el.getAttribute("data-decide") === "approve";
    if (!canApprove()) { ui.toast("Your role cannot approve expenses.", "error"); return; }
    if (e.status !== "Pending") { ui.toast("This line was already " + e.status.toLowerCase() + ".", "error"); return; }
    deciding = { expense: e, approve: approve };
    ui.modal({
      title: approve ? "Approve this cost" : "Reject this cost",
      sub: e.category + " · " + moneyPair(e) + " · " + e.payee,
      slim: true,
      body: '<div class="panel"><div class="panel-title">As recorded</div>' +
        '<div class="detail-row"><dt>What it bought</dt><dd style="font-weight:400">' + ui.esc(e.description) + "</dd></div>" +
        '<div class="detail-row"><dt>Incurred on</dt><dd>' + U.pretty(e.date, "medium") + "</dd></div>" +
        '<div class="detail-row"><dt>Paid by</dt><dd>' + ui.esc(e.method) + "</dd></div>" +
        '<div class="detail-row"><dt>Supplier invoice</dt><dd>' + ui.esc(e.attachment || "Not quoted") + "</dd></div>" +
        '<div class="detail-row"><dt>Recorded by</dt><dd>' + ui.esc(e.recordedBy) + "</dd></div></div>" +
        '<div class="field mt12"><label>Note' + (approve ? "" : " — required, the ledger keeps the reason") + "</label>" +
        '<textarea id="exp-note" placeholder="' + (approve ? "Checked against the supplier invoice." : "Why this is not an operating cost of the property.") + '"></textarea></div>' +
        (approve
          ? '<div class="notice success mt12">' + ui.icon("checkCircle") + "<div>Approving moves " + moneyPair(e) +
            " into the net operating result for " + U.pretty(e.date, "short") + ".</div></div>"
          : '<div class="notice danger mt12">' + ui.icon("alert") + "<div>The line stays on the ledger, marked refused with your name. It never reaches the result.</div></div>") +
        (e.recordedBy === LHMS.session.name ? '<div class="notice mt12">' + ui.icon("shield") +
          "<div>You recorded this line yourself. The decision is yours to make here; group policy may route it to another approver.</div></div>" : ""),
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn ' + (approve ? "primary" : "danger") +
        '" data-act="exp-decide-save">' + (approve ? "Approve the cost" : "Reject the cost") + "</button>"
    });
  };

  LHMS.uiActions["exp-decide-save"] = function () {
    if (!deciding) return;
    var noteEl = document.getElementById("exp-note");
    var note = noteEl ? String(noteEl.value || "").trim() : "";
    if (!deciding.approve && !note) { ui.toast("Give the reason — the ledger keeps it.", "error"); return; }
    var result = LHMS.actions.decideExpense(deciding.expense.id, deciding.approve, note);
    deciding = null;
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.expense.category + " " + moneyPair(result.expense) + " " + result.expense.status.toLowerCase() + ".");
  };

  /* ---------------- actions: filter, open, export ---------------- */
  LHMS.uiActions["exp-tab"] = function (el) { S.expStatus = el.getAttribute("data-status"); LHMS.rerender(); };
  LHMS.uiActions["live:exp-search"] = function (val) { S.expQ = val; LHMS.rerender(); };
  LHMS.uiActions["change:exp-filter"] = function (el) {
    if (el.name === "cat") S.expCat = el.value;
    if (el.name === "range") S.expRange = Number(el.value);
    LHMS.rerender();
  };

  LHMS.uiActions["exp-open"] = function (el) {
    var e = LHMS.db.expenses.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
    if (!e) return;
    ui.drawer({
      eyebrow: e.category,
      title: e.description,
      body: '<div class="folio-total"><div class="ft-row"><span>Recorded cost</span><span class="num"><b>' + moneyPair(e) + "</b></span></div>" +
        '<div class="ft-row"><span>Supplier</span><span class="num">' + ui.esc(e.payee) + "</span></div>" +
        '<div class="ft-row big"><span>' + ui.esc(e.status) + "</span><b>" + U.money(e.status === "Approved" ? e.amount : 0, e.currency) + "</b></div></div>" +
        '<div class="panel mt12"><div class="panel-title">The paper trail</div>' +
        '<div class="detail-row"><dt>Incurred on</dt><dd>' + U.pretty(e.date, "long") + "</dd></div>" +
        '<div class="detail-row"><dt>Paid by</dt><dd>' + ui.esc(e.method) + "</dd></div>" +
        '<div class="detail-row"><dt>Supplier invoice</dt><dd>' + ui.esc(e.attachment || "Not quoted") + "</dd></div>" +
        '<div class="detail-row"><dt>Recorded by</dt><dd>' + ui.esc(e.recordedBy) + " · " + U.pretty(String(e.recordedAt).slice(0, 10), "medium") + "</dd></div>" +
        (e.decidedBy ? '<div class="detail-row"><dt>' + ui.esc(e.status) + " by</dt><dd>" + ui.esc(e.decidedBy) +
          " · " + U.pretty(String(e.decidedAt).slice(0, 10), "medium") + "</dd></div>" : '<div class="detail-row"><dt>Decision</dt><dd>Awaiting a signature</dd></div>') +
        "</div>" +
        (e.decisionNote ? '<div class="notice mt12">' + ui.icon("message") + "<div><b>Note held with the decision.</b> " + ui.esc(e.decisionNote) + "</div></div>" : "") +
        '<div class="notice info mt12">' + ui.icon("shield") + "<div>Nothing on this line can be edited. A mistake is corrected by recording another line, so the ledger shows every version of what someone signed.</div></div>",
      footer: (e.status === "Pending" && canApprove()
        ? '<button class="btn danger" data-act="exp-decide" data-id="' + e.id + '" data-decide="reject">Reject</button>' +
          '<button class="btn primary" data-act="exp-decide" data-id="' + e.id + '" data-decide="approve">Approve</button>'
        : '<button class="btn" data-close-modal>Close</button>')
    });
  };

  LHMS.uiActions["exp-export"] = function () {
    var list = expVisible();
    var rows = [["Date", "Category", "Description", "Supplier", "Method", "Amount", "Paid in",
      "Counted in the books", "Status", "Recorded by", "Decided by", "Decision note", "Supplier invoice"]];
    list.forEach(function (e) {
      // The face amount and the figure the ledger added are both in the file: a
      // spreadsheet that only carried one of them could not be checked against
      // the totals the dashboard shows.
      rows.push([e.date, e.category, e.description, e.payee, e.method, e.amount, e.currency || LHMS.fx.base(),
        LHMS.fx.baseOf(e), e.status, e.recordedBy, e.decidedBy || "", e.decisionNote || "", e.attachment || ""]);
    });
    LHMS.log("exported the expense ledger", "expense", list.length + " lines");
    LHMS.save();
    ui.csv("aurelia-expenses-" + LHMS.session.propertyId + "-" + LHMS.day + ".csv", rows);
    ui.toast("Expense ledger downloaded — " + list.length + " lines.");
  };
})();
