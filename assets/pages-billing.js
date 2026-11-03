/* ============================================================
   LHMS — Financial Management: invoices, billing and receipts
   A document is a copy of what was owed at the moment it was
   raised. Money is a separate record. Nothing on this screen
   adds up a total in the page: the figures come from
   LHMS.invoiceMoney, which counts the payment and refund rows
   that actually exist.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;

  var S = { q: "", status: "all", sort: "date", dir: -1, method: "all", recon: "all", period: "30", rq: "" };

  var METHODS = ["Card", "Transfer", "Cash", "City ledger"];

  function canBill() { return LHMS.can("manage_billing"); }
  function canReconcile() { return LHMS.can("take_payments"); }

  var TONES = { "Paid": "green", "Partially paid": "amber", "Unpaid": "red", "Void": "" };

  // The chip is built from recomputed totals, never from the status string a
  // page wished it had.
  function statusChip(t) { return ui.chip(t.status, TONES[t.status] || ""); }

  function invTitle(inv) { return inv.number + " · " + inv.title; }

  function partyOf(inv) {
    if (inv.kind === "event") {
      var evt = LHMS.get.event(inv.entityId);
      return evt ? { name: evt.organizer, email: evt.email, phone: evt.phone, ref: evt.title } : null;
    }
    var res = LHMS.get.reservation(inv.reservationId);
    var g = res && LHMS.get.guest(res.guestId);
    return g ? { name: g.name, email: g.email, phone: g.phone, ref: res.reference } : null;
  }

  // Folios still holding charges, and hall bookings that will never reach a
  // room account — the two queues a billing clerk works through.
  function billableFolios() {
    return LHMS.unbilledAcross(LHMS.session.propertyId).filter(function (row) {
      return row.res.status !== "Cancelled" && row.res.status !== "No-show";
    });
  }

  function billableEvents() {
    return LHMS.eventsOf(LHMS.session.propertyId).filter(function (e) {
      return !e.reservationId && e.status !== "Cancelled" && e.status !== "Released" &&
        !LHMS.invoiceFor("event", e.id);
    });
  }

  /* ---------------- invoice list ---------------- */
  var STATUS_TABS = [
    ["all", "All documents"], ["open", "Awaiting money"], ["Unpaid", "Unpaid"],
    ["Partially paid", "Partially paid"], ["Paid", "Paid"], ["Void", "Void"]
  ];

  function visibleInvoices() {
    var q = S.q.trim().toLowerCase();
    var list = LHMS.invoicesOf().filter(function (inv) {
      var t = LHMS.invoiceMoney(inv);
      if (S.status === "open" && (t.status === "Paid" || t.status === "Void")) return false;
      if (S.status !== "all" && S.status !== "open" && t.status !== S.status) return false;
      if (q) {
        var hay = (inv.number + " " + inv.title + " " + inv.kind + " " + inv.raisedBy).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    list.sort(function (a, b) {
      var x = sortValue(a), y = sortValue(b);
      if (x === y) return a.number < b.number ? -1 : 1;
      return (x < y ? -1 : 1) * S.dir;
    });
    return list;
  }

  function sortValue(inv) {
    var t = LHMS.invoiceMoney(inv);
    if (S.sort === "number") return inv.number;
    if (S.sort === "date") return inv.date;
    // Ranked on what the books kept, so a dollar document and a naira one line up
    // on the same scale rather than on the size of their face figures.
    if (S.sort === "total") return t.base.total;
    if (S.sort === "balance") return t.base.balance;
    if (S.sort === "status") return t.status;
    return inv.date;
  }

  var COLS = [
    ["number", "Document"], ["date", "Issued"], ["total", "Billed"],
    ["balance", "Outstanding"], ["status", "Status"]
  ];

  function headerRow() {
    return "<tr>" + COLS.map(function (c) {
      var arrow = S.sort === c[0] ? (S.dir === 1 ? " ▲" : " ▼") : "";
      return '<th' + (c[0] === "total" || c[0] === "balance" ? ' class="right"' : "") + '>' +
        '<button class="th-sort" data-act="inv-sort" data-col="' + c[0] + '">' + c[1] + arrow + "</button></th>";
    }).join("") + '<th>Raised by</th><th class="right"></th></tr>';
  }

  function dueNote(inv, t) {
    if (t.balance <= 0) return '<div class="tiny muted">due ' + U.pretty(inv.dueDate, "short") + "</div>";
    if (inv.dueDate < LHMS.day) return '<div class="tiny" style="color:var(--red)">overdue since ' + U.pretty(inv.dueDate, "short") + "</div>";
    return '<div class="tiny muted">due ' + U.pretty(inv.dueDate, "short") + "</div>";
  }

  function invoiceRows(list) {
    return list.map(function (inv) {
      var t = LHMS.invoiceMoney(inv);
      return "<tr>" +
        '<td><a class="small strong" href="#/invoices/' + inv.id + '">' + ui.esc(inv.number) + "</a>" +
        '<div class="tiny muted">' + ui.esc(inv.title) + "</div></td>" +
        '<td><div class="small">' + U.pretty(inv.date, "short") + "</div>" + dueNote(inv, t) + "</td>" +
        '<td class="right num"><b>' + U.money(t.total, inv.currency) + "</b>" +
        '<div class="tiny muted">' + lineCount(inv.lines.length) + (t.adjustments ? " · " + U.money(t.adjustments, inv.currency) + " adjusted" : "") + "</div></td>" +
        '<td class="right num"><b>' + U.money(t.balance, inv.currency) + "</b>" +
        '<div class="tiny muted">' + U.money(t.settled, inv.currency) + " settled" +
        (inv.currency && inv.currency !== LHMS.fx.base(inv.propertyId)
          ? '<div class="tiny">' + U.money(t.base.balance) + " on the books</div>" : "") + "</div></td>" +
        "<td>" + statusChip(t) + "</td>" +
        '<td><div class="tiny">' + ui.esc(inv.raisedBy) + "</div>" +
        '<div class="tiny muted">' + ui.esc(inv.kind === "folio" ? "Guest folio" : "Hall booking") + "</div></td>" +
        '<td class="right"><div class="row" style="gap:5px;justify-content:flex-end">' +
        '<a class="btn sm ghost" href="#/invoices/' + inv.id + '">Open</a>' +
        (canBill() && (t.status === "Unpaid" || t.status === "Partially paid")
          ? '<button class="btn sm" data-act="inv-pay" data-invoice="' + inv.id + '">' + ui.icon("card", 11) + " Payment</button>" : "") +
        "</div></td></tr>";
    }).join("");
  }

  /* ---------------- the document itself ---------------- */
  function lineCount(n) { return n + " line" + (n === 1 ? "" : "s"); }

  function lineRows(lines) {
    return lines.map(function (l) {
      return "<tr><td class=\"tiny\">" + U.pretty(l.date, "short") + "</td>" +
        "<td>" + ui.esc(l.description) +
        '<div class="tiny muted">' + ui.esc(l.department) +
        (l.listName ? " · sold from " + ui.esc(l.listName) : "") + "</div></td>" +
        '<td class="right num tiny">' + (l.qty || 1) + "</td>" +
        '<td class="right num">' + U.money(l.unitPrice, l.currency) + "</td>" +
        '<td class="right num"><b>' + U.money(l.amount, l.currency) + "</b></td></tr>";
    }).join("");
  }

  function departmentSplit(inv) {
    var by = {};
    inv.lines.forEach(function (l) { by[l.department] = (by[l.department] || 0) + l.amount; });
    return Object.keys(by).sort(function (a, b) { return by[b] - by[a]; }).map(function (k) {
      return { label: k, value: by[k] };
    });
  }

  function totalsBlock(inv, t) {
    // The document speaks the money the guest was billed in; the books keep their
    // own, at the rate the document pinned when it was raised. Both are shown:
    // one settles the guest's account, the other is what the period totals count.
    var cur = inv.currency;
    var foreign = cur && cur !== LHMS.fx.base(inv.propertyId);
    var m = function (n) { return U.money(n, cur); };
    return '<div class="folio-total"><p class="card-eyebrow" style="color:#8a7038;margin-bottom:8px">Settlement</p>' +
      '<div class="ft-row"><span>Billed lines</span><span class="num">' + m(t.lines) + "</span></div>" +
      (t.adjustments ? '<div class="ft-row"><span>Approved adjustments</span><span class="num">' + m(t.adjustments) + "</span></div>" : "") +
      '<div class="ft-row"><span>Total payable</span><span class="num"><b>' + m(t.total) + "</b></span></div>" +
      '<div class="ft-row"><span>Payments on file</span><span class="num">− ' + m(t.paid) + "</span></div>" +
      (t.refunded ? '<div class="ft-row"><span>Refunded back</span><span class="num">+ ' + m(t.refunded) + "</span></div>" : "") +
      '<div class="ft-row big"><span>Outstanding</span><b>' + m(t.balance) + "</b></div>" +
      (foreign ? '<div class="ft-row"><span class="tiny">In the books · 1 ' + ui.esc(cur) + " = " +
        U.money(inv.fxRate, LHMS.fx.base(inv.propertyId)) + '</span><span class="num tiny">' +
        U.money(t.base.balance, LHMS.fx.base(inv.propertyId)) + "</span></div>" : "") +
      "</div>";
  }

  function documentCard(inv) {
    var t = LHMS.invoiceMoney(inv);
    var party = partyOf(inv);
    var pays = LHMS.invoicePayments(inv.id);
    var refs = LHMS.refundsOf().filter(function (r) { return r.invoiceId === inv.id; });
    var paidOn = inv.date === LHMS.day ? "today" : U.pretty(inv.date, "medium");

    var actions = "";
    if (canBill()) {
      if (t.status !== "Paid" && t.status !== "Void") {
        actions += '<button class="btn sm primary" data-act="inv-pay" data-invoice="' + inv.id + '">' + ui.icon("card", 12) + " Record payment</button>";
      }
      if (t.status !== "Void") {
        actions += '<button class="btn sm" data-act="inv-adjust" data-invoice="' + inv.id + '">' + ui.icon("edit", 12) + " Adjustment</button>";
        if (inv.lines.length > 1 && !t.settled) {
          actions += '<button class="btn sm" data-act="inv-split" data-invoice="' + inv.id + '">' + ui.icon("arrowUpRight", 12) + " Split</button>";
        }
      }
      if (t.settled && t.status !== "Void") {
        actions += '<button class="btn sm" data-act="inv-refund" data-invoice="' + inv.id + '">' + ui.icon("refresh", 12) + " Refund</button>";
      }
      if (t.status !== "Void" && !t.settled) {
        actions += '<button class="btn sm danger" data-act="inv-void" data-invoice="' + inv.id + '">' + ui.icon("close", 12) + " Void</button>";
      }
    }

    return '<section class="card pad0 mb16">' +
      '<div class="card-head" style="padding:18px 19px 14px"><div>' +
        '<div class="card-title">' + ui.icon("receipt", 15) + " " + ui.esc(inv.number) +
        (inv.status === "Void" ? " " + ui.chip("Void", "") : "") + "</div>" +
        '<div class="card-sub">' + ui.esc(inv.title) + " · " + lineCount(inv.lines.length) + " · " +
          (inv.kind === "folio" ? "raised from a guest folio" : "raised by the events desk") +
          " · issued " + paidOn + "</div></div>" +
        '<div class="row wrap" style="gap:6px;justify-content:flex-end">' +
          '<a class="btn sm ghost" href="#/invoices">' + ui.icon("list", 12) + " All documents</a>" +
          '<button class="btn sm ghost" data-act="inv-print">' + ui.icon("printer", 12) + " Print</button>" + actions +
        "</div></div>" +
      '<div class="grid g2" style="padding:0 19px 18px;gap:16px">' +
        "<div>" +
          (party ? '<div class="detail-row"><dt>Bill to</dt><dd>' + ui.esc(party.name) + "</dd></div>" +
            '<div class="detail-row"><dt>Contact</dt><dd>' + ui.esc(party.email || "—") + "</dd></div>" +
            '<div class="detail-row"><dt>Reference</dt><dd class="mono">' + ui.esc(party.ref) + "</dd></div>" : "") +
          '<div class="detail-row"><dt>Due</dt><dd>' + U.pretty(inv.dueDate, "medium") +
          (t.balance > 0 && inv.dueDate < LHMS.day ? ' <span class="chip red">Overdue</span>' : "") + "</dd></div>" +
          '<div class="detail-row"><dt>Raised by</dt><dd>' + ui.esc(inv.raisedBy) + "</dd></div>" +
          '<div class="detail-row"><dt>Currency</dt><dd>' + ui.esc(inv.currency) + "</dd></div>" +
          (inv.notes ? '<div class="detail-row"><dt>Note</dt><dd>' + ui.esc(inv.notes) + "</dd></div>" : "") +
          (inv.status === "Void" ? '<div class="detail-row"><dt>Voided</dt><dd>' + ui.esc(inv.voidedBy) +
            " · " + ui.esc(inv.voidReason) + "</dd></div>" : "") +
          '<div class="mt8">' + ui.barList(departmentSplit(inv), { money: true, currency: inv.currency }) + "</div>" +
        "</div>" +
        totalsBlock(inv, t) +
      "</div>" +
      '<div class="table-wrap" style="border:0;border-radius:0"><table class="data"><thead><tr>' +
        "<th>Date</th><th>Description</th><th class=\"right\">Qty</th><th class=\"right\">Unit</th><th class=\"right\">Amount</th>" +
        "</tr></thead><tbody>" + lineRows(inv.lines) +
        (inv.adjustments || []).map(function (a) {
          return '<tr><td class="tiny">' + U.pretty(String(a.at).slice(0, 10), "short") + "</td>" +
            "<td>" + ui.esc(a.label) + '<div class="tiny muted">' + ui.esc(a.reason) + " · approved by " + ui.esc(a.by) + "</div></td>" +
            '<td class="right num tiny">—</td><td class="right tiny muted">—</td>' +
            '<td class="right num" style="color:var(--green)"><b>' + U.money(a.amount, inv.currency) + "</b></td></tr>";
        }).join("") +
        "</tbody></table></div>" +
      '<div class="row between" style="padding:12px 19px;border-top:1px solid var(--line-2);background:#fcfbf7">' +
        '<span class="small muted">Every line keeps the rate, the price list and the currency it was sold at.</span>' +
        "<b class=\"serif\" style=\"font-size:20px\">" + U.money(t.total, inv.currency) + "</b></div>" +
      "</section>" +
      ui.sectionCard("Receipts against this document", pays.length ? '<div class="table-wrap"><table class="data mini">' +
        "<thead><tr><th>Date</th><th>Receipt</th><th>Method</th><th>Taken by</th><th>Collection</th><th class=\"right\">Amount</th></tr></thead><tbody>" +
        pays.map(function (p) {
          return "<tr><td>" + U.pretty(p.date, "short") + '</td><td class="mono">' + ui.esc(p.receipt || p.reference) +
            "</td><td>" + ui.esc(p.method) + "</td><td>" + ui.esc(p.takenBy) + "</td>" +
            "<td>" + (p.reconciled ? ui.chip("Reconciled", "green") : ui.chip("Uncollected", "amber")) + "</td>" +
            '<td class="right num">' + U.money(p.amount, p.currency || inv.currency) + "</td></tr>";
        }).join("") + "</tbody></table></div>"
        : '<p class="muted small">No money recorded yet. The document stays outstanding until a payment is entered here.</p>',
        "", "", "card") +
      (refs.length ? ui.sectionCard("Refunds", '<div class="table-wrap"><table class="data mini">' +
        "<thead><tr><th>Date</th><th>Reference</th><th>Method</th><th>Reason</th><th>By</th><th class=\"right\">Amount</th></tr></thead><tbody>" +
        refs.map(function (r) {
          return "<tr><td>" + U.pretty(r.date, "short") + '</td><td class="mono">' + ui.esc(r.reference) +
            "</td><td>" + ui.esc(r.method) + "</td><td>" + ui.esc(r.reason) + "</td><td>" + ui.esc(r.by) +
            '</td><td class="right num">' + U.money(r.amount, r.currency || inv.currency) + "</td></tr>";
        }).join("") + "</tbody></table></div>", "", "", "refresh") : "") +
      '<div class="notice info mt12">' + ui.icon("shield") +
      "<div>Payment, adjustment, refund and void each recount from the records below this document, so a total cannot be typed into a status.</div></div>";
  }

  /* ---------------- work list ---------------- */
  function workListCard() {
    var folios = billableFolios();
    var events = billableEvents();
    var rows = folios.map(function (row) {
      var res = row.res;
      var g = LHMS.get.guest(res.guestId);
      var room = LHMS.get.room(res.roomId);
      var sum = row.lines.reduce(function (s, c) { return s + c.amount; }, 0);
      var depts = {};
      row.lines.forEach(function (c) { depts[c.department] = (depts[c.department] || 0) + c.amount; });
      return '<div class="list-row"><div class="lr-main">' + ui.avatar(g ? g.name : "Guest") +
        '<div style="min-width:0"><div class="lr-title">' + ui.esc(g ? g.name : "Guest") +
        ' · Room ' + ui.esc(room ? room.number : "—") + "</div>" +
        '<div class="lr-sub">' + ui.esc(res.reference) + " · " + row.lines.length + " unbilled charge" +
        (row.lines.length === 1 ? "" : "s") + " · " + Object.keys(depts).join(", ") + "</div></div></div>" +
        '<div class="lr-meta"><div class="small strong num">' + U.money(sum, (row.lines[0] || {}).currency) + "</div>" +
        (canBill() ? '<button class="btn-link" style="margin-top:4px" data-act="inv-raise" data-kind="folio" data-id="' +
          res.id + '">Raise invoice</button>' : '<span class="tiny muted">no billing rights</span>') +
        "</div></div>";
    }).join("");

    var evtRows = events.map(function (e) {
      return '<div class="list-row"><div class="lr-main">' + ui.avatar(e.organizer) +
        '<div style="min-width:0"><div class="lr-title">' + ui.esc(e.title) + "</div>" +
        '<div class="lr-sub">' + ui.esc(e.hallName) + " · " + U.pretty(e.date, "short") + " " +
        ui.esc(e.start) + "–" + ui.esc(e.end) + " · " + ui.esc(e.organizer) + "</div></div></div>" +
        '<div class="lr-meta"><div class="small strong num">' + U.money(e.total, e.currency) + "</div>" +
        (canBill() ? '<button class="btn-link" style="margin-top:4px" data-act="inv-raise" data-kind="event" data-id="' +
          e.id + '">Raise invoice</button>' : '<span class="tiny muted">no billing rights</span>') +
        "</div></div>";
    }).join("");

    if (!rows && !evtRows) {
      return ui.sectionCard("Waiting to be invoiced", ui.empty("Every charge is on a document",
        "Nothing is left unbilled on this property. New folio charges appear here the moment they are posted.", "check"), "", "", "check");
    }
    return ui.sectionCard("Waiting to be invoiced",
      (rows ? '<p class="tiny muted" style="margin-bottom:6px">Folio charges not yet on a document</p><div class="list">' + rows + "</div>" : "") +
      (evtRows ? '<p class="tiny muted" style="' + (rows ? "margin-top:14px;" : "") + 'margin-bottom:6px">Hall bookings with no room account — these never reach a folio</p>' +
        '<div class="list">' + evtRows + "</div>" : "") +
      '<div class="notice mt12">' + ui.icon("alert") +
      "<div>Raising a document copies the lines and takes them off the folio, so the same charge cannot be invoiced twice. Voids hand them back.</div></div>",
      "", "", "file");
  }

  /* ---------------- page: invoices & billing ---------------- */
  LHMS.pages.invoices = function (route) {
    var open = route && route.sub ? LHMS.get.invoice(route.sub) : null;
    var list = visibleInvoices();
    var all = LHMS.invoicesOf();
    // Across documents the only figures that may be added or ranked are the ones
    // the books kept: a dollar invoice and a naira invoice share one period, and
    // their face amounts count different money.
    var totals = all.reduce(function (m, inv) {
      var t = LHMS.invoiceMoney(inv);
      var b = t.base;
      m.billed += b.total; m.settled += b.settled; m.outstanding += Math.max(0, b.balance);
      if (t.status !== "Void" && t.balance > 0) m.awaiting++;
      m.adjust += Math.abs(b.adjustments); m.refunded += b.refunded;
      return m;
    }, { billed: 0, settled: 0, outstanding: 0, awaiting: 0, adjust: 0, refunded: 0 });
    var baseCur = LHMS.fx.base(LHMS.session.propertyId);
    var unbilled = LHMS.unbilledAcross(LHMS.session.propertyId);
    var unbilledValue = unbilled.reduce(function (s, row) {
      return s + row.lines.reduce(function (a, c) { return a + LHMS.fx.baseOf(c); }, 0);
    }, 0);

    var tabs = '<div class="tabs mb16">' + STATUS_TABS.map(function (o) {
      var n = o[0] === "all" ? all.length : all.filter(function (inv) {
        var t = LHMS.invoiceMoney(inv);
        return o[0] === "open" ? (t.status !== "Paid" && t.status !== "Void") : t.status === o[0];
      }).length;
      return '<button class="tab' + (S.status === o[0] ? " active" : "") + '" data-act="inv-tab" data-status="' +
        o[0] + '">' + o[1] + '<span class="count">' + n + "</span></button>";
    }).join("") + "</div>";

    var toolbar = '<section class="card"><div class="toolbar">' +
      ui.searchField("Search number, guest or raiser", S.q, "inv-search") +
      '<select class="select" style="max-width:170px" name="sort" data-change="inv-filter"><option value="date">Newest first</option>' +
      [["total", "Largest billed"], ["balance", "Largest outstanding"], ["number", "Document number"], ["status", "Status"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (S.sort === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      "</select><span class=\"spacer\"></span>" +
      '<button class="btn sm" data-act="inv-export">' + ui.icon("download", 11) + " Export CSV</button>" +
      '<a class="btn sm" href="#/receipts">' + ui.icon("card", 11) + " Payments &amp; receipts</a>" +
      "</div>" +
      (list.length ? '<div class="table-wrap"><table class="data"><thead>' + headerRow() + "</thead><tbody>" +
        invoiceRows(list) + "</tbody></table></div>"
        : ui.empty("No documents match", "Change the filter, or raise an invoice from the list below.", "receipt")) +
      "</section>";

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Invoices & billing",
      sub: "One document can carry room, restaurant, laundry and hall charges. It becomes paid only when a payment is on file — never because a total was typed in.",
      actions: '<a class="btn" href="#/prices">' + ui.icon("tag", 14) + " Price setup</a>" +
        '<a class="btn" href="#/activity">' + ui.icon("clock", 14) + " Audit trail</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Billed on documents", U.money(totals.billed, baseCur), all.length + " issued · counted in " + baseCur + ", the money of the books", { icon: "receipt", accent: "accent-navy" }) +
        ui.kpi("Collected against them", U.money(totals.settled, baseCur), Math.round(totals.billed ? totals.settled / totals.billed * 100 : 0) + "% of everything billed", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Still outstanding", U.money(totals.outstanding, baseCur), totals.awaiting + " document" + (totals.awaiting === 1 ? "" : "s") + " awaiting money", { icon: "alert", accent: "accent-red" }) +
        ui.kpi("Not yet invoiced", U.money(unbilledValue, baseCur), unbilled.length + " folio" + (unbilled.length === 1 ? "" : "s") + " with open charges", { icon: "file" }) +
        ui.kpi("Adjustments & refunds", U.money(totals.adjust + totals.refunded, baseCur), "Both keep the original line", { icon: "refresh" }) +
      "</div>" +
      (canBill() ? "" : '<div class="notice mb16">' + ui.icon("lock") +
        "<div><b>Read-only for your role.</b> “Manage billing” is not granted to " + ui.esc(LHMS.session.role) +
        ", so documents can be opened and printed but nothing can be raised, settled or corrected.</div></div>") +
      (open ? documentCard(open) : "") +
      workListCard() +
      '<div class="mt16">' + tabs + toolbar + "</div>";
  };

  /* ---------------- actions: raise, navigate ---------------- */
  LHMS.uiActions["inv-raise"] = function (el) {
    var kind = el.getAttribute("data-kind");
    var result = LHMS.actions.raiseInvoice(kind === "folio"
      ? { reservationId: el.getAttribute("data-id") }
      : { eventId: el.getAttribute("data-id") });
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.toast("Invoice " + result.invoice.number + " raised for " + U.money(result.totals.total, result.invoice.currency) + ".");
    LHMS.go("invoices/" + result.invoice.id);
  };

  LHMS.uiActions["inv-tab"] = function (el) { S.status = el.getAttribute("data-status"); LHMS.rerender(); };
  LHMS.uiActions["inv-sort"] = function (el) {
    var col = el.getAttribute("data-col");
    if (S.sort === col) S.dir = -S.dir; else { S.sort = col; S.dir = col === "date" || col === "number" ? -1 : 1; }
    LHMS.rerender();
  };
  LHMS.uiActions["change:inv-filter"] = function (el) {
    if (el.name === "sort") { S.sort = el.value; S.dir = el.value === "date" || el.value === "number" ? -1 : 1; }
    LHMS.rerender();
  };
  LHMS.uiActions["live:inv-search"] = function (val) {
    S.q = val; LHMS.rerender();
    setTimeout(function () {
      var f = document.querySelector('[data-live="inv-search"]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, 10);
  };
  LHMS.uiActions["inv-print"] = function () {
    ui.toast("Opening print dialog…");
    setTimeout(function () { window.print(); }, 250);
  };

  LHMS.uiActions["inv-export"] = function () {
    var rows = [["Invoice", "Type", "Bill to", "Issued", "Due", "Lines", "Billed", "Adjustments", "Received",
      "Refunded", "Total", "Outstanding", "Currency", "Total on the books", "Outstanding on the books",
      "Status", "Raised by"]];
    visibleInvoices().forEach(function (inv) {
      var t = LHMS.invoiceMoney(inv);
      var party = partyOf(inv);
      rows.push([inv.number, inv.kind === "folio" ? "Guest folio" : "Hall booking", party ? party.name : inv.title,
        inv.date, inv.dueDate, inv.lines.length, t.lines, t.adjustments, t.paid, t.refunded, t.total, t.balance,
        inv.currency || LHMS.fx.base(inv.propertyId), t.base.total, t.base.balance, t.status, inv.raisedBy]);
    });
    ui.csv("aurelia-invoices-" + LHMS.session.propertyId + "-" + LHMS.day + ".csv", rows);
    LHMS.log("exported invoices", "invoice", (rows.length - 1) + " documents");
    LHMS.save();
    ui.toast("Invoice register downloaded.");
  };

  /* ---------------- record a payment ---------------- */
  LHMS.uiActions["inv-pay"] = function (el) {
    var inv = LHMS.get.invoice(el.getAttribute("data-invoice"));
    if (!inv) return;
    var t = LHMS.invoiceMoney(inv);
    if (!t.balance) { ui.toast("This document is already settled.", ""); return; }
    remember(inv);
    ui.modal({
      title: "Record a payment",
      sub: invTitle(inv) + " · " + U.money(t.balance, inv.currency) + " outstanding",
      slim: true,
      body: '<form id="inv-pay-form">' +
        '<div class="field"><label>Amount</label><input name="amount" type="number" min="50" step="50" value="' + t.balance + '" /></div>' +
        '<div class="field mt12"><label>Method</label><select name="method">' + METHODS.map(function (m) {
          return "<option>" + m + "</option>";
        }).join("") + "</select></div>" +
        '<div class="field mt12"><label>Bank / terminal reference</label><input name="reference" placeholder="Optional — printed on the guest receipt" /></div>' +
        (canReconcile() ? '<label class="check mt12"><input type="checkbox" name="reconciled" value="yes" /> The money is already in the account (reconciled on entry)</label>' : "") +
        '<div class="notice info mt12">' + ui.icon("alert") + "<div>The receipt number is issued by the system as " +
        ui.esc(inv.number) + "-n so it can be traced back to this document.</div></div>" +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="inv-pay-save">Take payment</button>'
    });
  };

  LHMS.uiActions["inv-pay-save"] = function () {
    var form = document.getElementById("inv-pay-form");
    if (!form) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.payInvoice(currentInvoice, {
      amount: d.amount, method: d.method, reference: d.reference || undefined, reconciled: !!d.reconciled
    });
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Receipt " + result.payment.receipt + " · " + result.totals.status + " · balance " + U.money(result.totals.balance, result.invoice.currency) + ".");
  };

  /* ---------------- adjustment / refund / void / split ---------------- */
  LHMS.uiActions["inv-adjust"] = function (el) {
    var inv = LHMS.get.invoice(el.getAttribute("data-invoice"));
    if (!inv) return;
    var t = LHMS.invoiceMoney(inv);
    remember(inv);
    ui.modal({
      title: "Approved adjustment",
      sub: invTitle(inv) + " · billed " + U.money(t.total, inv.currency),
      slim: true,
      body: '<form id="inv-adj-form">' +
        '<div class="field"><label>Reduce the total by</label><input name="amount" type="number" min="50" step="50" value="' + Math.min(5000, t.total) + '" /></div>' +
        '<div class="field mt12"><label>Show on the document as</label><input name="label" value="Loyalty gesture" /></div>' +
        '<div class="field mt12"><label>Reason</label><input name="reason" placeholder="Required — written to the audit trail" /></div>' +
        '<div class="notice mt12">' + ui.icon("shield") + "<div>Your name, " + ui.esc(LHMS.session.name) +
        ", is printed on the document as the person who approved this." +
        (LHMS.movesMoneyAlone() ? "" : " Past " + LHMS.financeSettings().discountPct +
          "% of this total the change waits for a second signature instead.") +
        "</div></div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="inv-adjust-save">Apply adjustment</button>'
    });
  };

  LHMS.uiActions["inv-adjust-save"] = function () {
    var d = Object.fromEntries(new FormData(document.getElementById("inv-adj-form")));
    var result = LHMS.actions.discountInvoice(currentInvoice, d);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    if (result.queued) { ui.toast(LHMS.outcome(result).text); return; }
    ui.toast("Adjustment applied — the document now totals " + U.money(result.totals.total, result.invoice.currency) + ".");
  };

  LHMS.uiActions["inv-refund"] = function (el) {
    var inv = LHMS.get.invoice(el.getAttribute("data-invoice"));
    if (!inv) return;
    var t = LHMS.invoiceMoney(inv);
    remember(inv);
    ui.modal({
      title: "Refund money already received",
      sub: invTitle(inv) + " · " + U.money(t.settled, inv.currency) + " net in hand",
      slim: true,
      body: '<form id="inv-rfd-form">' +
        '<div class="field"><label>Amount to return</label><input name="amount" type="number" min="50" max="' + t.settled +
        '" step="50" value="' + t.settled + '" /></div>' +
        '<div class="field mt12"><label>Return by</label><select name="method"><option>Transfer</option><option>Cash</option><option>Card</option></select></div>' +
        '<div class="field mt12"><label>Reason</label><input name="reason" placeholder="Required — written to the audit trail" /></div>' +
        '<div class="notice mt12">' + ui.icon("alert") + "<div>The original receipt is left untouched — the refund is recorded as its own transaction, " +
        "which is what lets both sides be audited later." +
        (LHMS.movesMoneyAlone() ? "" : " Above " + U.money(LHMS.financeSettings().approvalAmount) +
          " it waits for a second signature before any money moves.") +
        "</div></div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn danger" data-act="inv-refund-save">Issue refund</button>'
    });
  };

  LHMS.uiActions["inv-refund-save"] = function () {
    var d = Object.fromEntries(new FormData(document.getElementById("inv-rfd-form")));
    var result = LHMS.actions.refundInvoice(currentInvoice, d);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    if (result.queued) { ui.toast(LHMS.outcome(result).text); return; }
    ui.toast("Refund " + result.refund.reference + " issued · outstanding balance " + U.money(result.totals.balance, result.invoice.currency) + ".");
  };

  LHMS.uiActions["inv-void"] = function (el) {
    var inv = LHMS.get.invoice(el.getAttribute("data-invoice"));
    if (!inv) return;
    remember(inv);
    ui.modal({
      title: "Void this document",
      sub: invTitle(inv) + " · the lines return to the folio to be re-raised",
      slim: true,
      body: '<form id="inv-void-form"><div class="field"><label>Why is it wrong?</label>' +
        '<input name="reason" placeholder="Required — written to the audit trail" /></div>' +
        '<div class="notice mt16">' + ui.icon("trash") + "<div>A voided document is never deleted. It stays on the register with your name on it, " +
        "and the charges it carried become billable again.</div></div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn danger" data-act="inv-void-save">Void invoice</button>'
    });
  };

  LHMS.uiActions["inv-void-save"] = function () {
    var d = Object.fromEntries(new FormData(document.getElementById("inv-void-form")));
    var result = LHMS.actions.voidInvoice(currentInvoice, d);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Invoice " + result.invoice.number + " is void and its charges are back on the folio.");
  };

  LHMS.uiActions["inv-split"] = function (el) {
    var inv = LHMS.get.invoice(el.getAttribute("data-invoice"));
    if (!inv) return;
    remember(inv);
    var t = LHMS.invoiceMoney(inv);
    ui.modal({
      title: "Split the bill",
      sub: invTitle(inv) + " · " + U.money(t.total, inv.currency) + " · tick the lines that go to the second document",
      body: '<form id="inv-split-form"><div class="stack" style="gap:0">' +
        inv.lines.map(function (l, i) {
          return '<label class="check" style="padding:9px 0;border-bottom:1px solid var(--line-2)">' +
            '<input type="checkbox" name="line_' + i + '" value="yes" />' +
            '<span style="min-width:0"><span class="small strong" style="display:block">' + ui.esc(l.description) + "</span>" +
            '<span class="tiny muted">' + ui.esc(l.department) + " · " + U.money(l.amount, l.currency || inv.currency) + "</span></span></label>";
        }).join("") + "</div>" +
        '<div class="field mt12"><label>Note on the new document</label><input name="notes" placeholder="Company pays the room, guest pays incidentals" /></div>' +
        '<div class="notice info mt12">' + ui.icon("alert") +
        "<div>Whole lines move, so both documents still add up to the original. Nothing can be split while money is against it — refund first.</div></div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="inv-split-save">Create second invoice</button>'
    });
  };

  LHMS.uiActions["inv-split-save"] = function () {
    var form = document.getElementById("inv-split-form");
    var d = Object.fromEntries(new FormData(form));
    var indexes = [];
    form.querySelectorAll("[name^=\"line_\"]:checked").forEach(function (cb) {
      indexes.push(Number(cb.getAttribute("name").slice(5)));
    });
    var result = LHMS.actions.splitInvoice(currentInvoice, { indexes: indexes, notes: d.notes || undefined });
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal();
    ui.toast(result.split.number + " now carries " + lineCount(result.split.lines.length) + ".");
    LHMS.go("invoices/" + result.split.id);
  };

  // The document a modal is acting on, remembered so the save handler does not
  // have to trust a value carried through form markup.
  var currentInvoice = null;
  function remember(inv) { currentInvoice = inv.id; }

  /* ============================================================
     PAYMENTS & RECEIPTS
     ============================================================ */
  function inPeriod(date) {
    if (S.period === "all") return true;
    return date >= U.addDays(LHMS.day, -Number(S.period));
  }

  function visiblePayments() {
    var q = S.rq.trim().toLowerCase();
    return LHMS.paymentsOf().filter(function (p) {
      if (!inPeriod(p.date)) return false;
      if (S.method !== "all" && p.method !== S.method) return false;
      if (S.recon === "out" && p.reconciled) return false;
      if (S.recon === "in" && !p.reconciled) return false;
      if (q) {
        var inv = p.invoiceId && LHMS.get.invoice(p.invoiceId);
        var hay = ((p.receipt || "") + " " + p.reference + " " + p.method + " " + p.takenBy + " " +
          (inv ? inv.number + " " + inv.title : "")).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  // A receipt is only worth what it can be traced to: the document when there is
  // one, otherwise the folio the deposit landed on.
  function sourceCell(p) {
    if (p.invoiceId) {
      var inv = LHMS.get.invoice(p.invoiceId);
      if (inv) return '<a class="small strong" href="#/invoices/' + inv.id + '">' + ui.esc(inv.number) + "</a>" +
        '<div class="tiny muted">' + ui.esc(inv.title) + "</div>";
    }
    if (p.reservationId) {
      var res = LHMS.get.reservation(p.reservationId);
      if (res) return '<a class="small" href="#/folio/' + res.id + '">Folio</a>' +
        '<div class="tiny muted mono">' + ui.esc(res.reference) + "</div>";
    }
    return '<span class="tiny muted">Advance deposit</span>';
  }

  LHMS.pages.receipts = function () {
    var all = LHMS.paymentsOf();
    var list = visiblePayments();
    var refunded = LHMS.refundsOf();
    // A window can hold receipts taken in different monies, so every figure that
    // adds up or splits by method uses what the books kept. The rows themselves
    // stay in the money the guest paid in.
    var collected = list.reduce(function (s, p) { return s + LHMS.fx.baseOf(p); }, 0);
    var unreconciled = list.filter(function (p) { return !p.reconciled; });
    var refundTotal = refunded.reduce(function (s, r) { return s + LHMS.fx.baseOf(r); }, 0);
    var baseCur = LHMS.fx.base(LHMS.session.propertyId);

    var byMethod = {};
    list.forEach(function (p) { byMethod[p.method] = (byMethod[p.method] || 0) + LHMS.fx.baseOf(p); });
    var methodBars = Object.keys(byMethod).sort(function (a, b) { return byMethod[b] - byMethod[a]; })
      .map(function (k) { return { label: k, value: byMethod[k] }; });

    // The filter offers the methods this property has actually been paid with,
    // so it can never promise a channel the till has never used.
    var usedMethods = METHODS.slice();
    all.forEach(function (p) { if (usedMethods.indexOf(p.method) === -1) usedMethods.push(p.method); });

    var rows = list.map(function (p) {
      return "<tr>" +
        '<td class="tiny">' + U.pretty(p.date, "short") + "</td>" +
        '<td><div class="mono">' + ui.esc(p.receipt || "—") + "</div>" +
        '<div class="tiny muted mono">' + ui.esc(p.reference) + "</div></td>" +
        "<td>" + sourceCell(p) + "</td>" +
        '<td><div class="small">' + ui.esc(p.method) + "</div></td>" +
        '<td class="tiny">' + ui.esc(p.takenBy) + "</td>" +
        "<td>" + (p.reconciled ? ui.chip("Reconciled", "green") : ui.chip("Not in the account", "amber")) + "</td>" +
        '<td class="right num"><b>' + U.money(p.amount, p.currency) + "</b></td>" +
        '<td class="right">' + (canReconcile()
          ? '<button class="btn sm ghost" data-act="pay-reconcile" data-pay="' + p.id + '" data-to="' +
            (p.reconciled ? "0" : "1") + '">' + (p.reconciled ? "Unmatch" : "Mark reconciled") + "</button>"
          : '<span class="tiny muted">read-only</span>') + "</td></tr>";
    }).join("");

    var refundRows = refunded.length ? refunded.map(function (r) {
      var inv = LHMS.get.invoice(r.invoiceId);
      return "<tr>" +
        '<td class="tiny">' + U.pretty(r.date, "short") + "</td>" +
        '<td class="mono">' + ui.esc(r.reference) + "</td>" +
        "<td>" + (inv ? '<a class="small" href="#/invoices/' + inv.id + '">' + ui.esc(inv.number) + "</a>" : "—") + "</td>" +
        "<td>" + ui.esc(r.method) + "</td>" +
        '<td><div class="small">' + ui.esc(r.reason) + '</div><div class="tiny muted">' + ui.esc(r.by) + "</div></td>" +
        '<td class="right num"><b style="color:var(--red)">' + U.money(r.amount, r.currency) + "</b></td></tr>";
    }).join("") : "";

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Payments & receipts",
      sub: "Cash collected and revenue earned are different numbers. This page is the collection side: every receipt, the document it belongs to, and whether it has reached the account.",
      actions: '<a class="btn" href="#/invoices">' + ui.icon("receipt", 14) + " Invoices</a>" +
        '<a class="btn" href="#/reports">' + ui.icon("chart", 14) + " Reports</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Collected in the period", U.money(collected, baseCur), list.length + " receipt" + (list.length === 1 ? "" : "s") + " · counted in " + baseCur, { icon: "card", accent: "accent-navy" }) +
        ui.kpi("Not yet in the account", U.money(unreconciled.reduce(function (s, p) { return s + LHMS.fx.baseOf(p); }, 0), baseCur),
          unreconciled.length + " payment" + (unreconciled.length === 1 ? "" : "s") + " to match", { icon: "clock", accent: "accent-red" }) +
        ui.kpi("Refunded", U.money(refundTotal, baseCur), refunded.length + " return" + (refunded.length === 1 ? "" : "s") + " to guests", { icon: "refresh" }) +
        ui.kpi("Receipts against documents", all.filter(function (p) { return p.invoiceId; }).length,
          all.filter(function (p) { return !p.invoiceId; }).length + " landed on folios", { icon: "file" }) +
      "</div>" +
      '<section class="card"><div class="toolbar">' +
        ui.searchField("Search receipt or reference", S.rq, "rct-search") +
        '<select class="select" style="max-width:150px" name="method" data-change="rct-filter"><option value="all">Any method</option>' +
        usedMethods.map(function (m) {
          return '<option value="' + m + '"' + (S.method === m ? " selected" : "") + ">" + m + "</option>";
        }).join("") + "</select>" +
        '<select class="select" style="max-width:190px" name="recon" data-change="rct-filter">' +
        [["all", "Reconciled or not"], ["out", "Not in the account"], ["in", "Reconciled"]]
          .map(function (o) { return '<option value="' + o[0] + '"' + (S.recon === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
        "</select>" +
        '<select class="select" style="max-width:150px" name="period" data-change="rct-filter">' +
        [["7", "Last 7 days"], ["30", "Last 30 days"], ["90", "Last quarter"], ["all", "All time"]]
          .map(function (o) { return '<option value="' + o[0] + '"' + (S.period === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
        "</select><span class=\"spacer\"></span>" +
        '<button class="btn sm" data-act="rct-export">' + ui.icon("download", 11) + " Export CSV</button>" +
        "</div>" +
        (rows ? '<div class="table-wrap"><table class="data"><thead><tr><th>Date</th><th>Receipt</th><th>Document</th>' +
          "<th>Method</th><th>Taken by</th><th>Collection</th><th class=\"right\">Amount</th><th class=\"right\"></th></tr></thead><tbody>" +
          rows + "</tbody></table></div>"
          : ui.empty("No receipts in this window", "Widen the period, or take a payment from an open invoice.", "card")) +
      "</section>" +
      '<div class="grid g2 mt16" style="align-items:start">' +
        ui.sectionCard("How the money arrived", methodBars.length ? ui.barList(methodBars, { money: true })
          : '<p class="muted small">Nothing collected in this window.</p>', "", "", "card") +
        (refundRows ? ui.sectionCard("Refunds issued", '<div class="table-wrap"><table class="data mini"><thead><tr>' +
          "<th>Date</th><th>Reference</th><th>Document</th><th>Method</th><th>Reason</th><th class=\"right\">Amount</th></tr></thead><tbody>" +
          refundRows + "</tbody></table></div>" +
          '<p class="tiny muted mt8">A refund never rewrites the receipt it refers to, so both sides stay auditable.</p>', "", "", "refresh")
          : ui.sectionCard("Refunds issued", ui.empty("No refunds issued", "A refund is raised from the invoice it belongs to, and needs a reason.", "refresh"), "", "", "refresh")) +
      "</div>" +
      '<div class="notice info mt16">' + ui.icon("shield") + "<div>Marking a payment reconciled records who confirmed it. " +
      "Only a role holding “Take payments” can do that, and it does not change what was billed.</div></div>";
  };

  LHMS.uiActions["change:rct-filter"] = function (el) {
    if (el.name === "method") S.method = el.value;
    if (el.name === "recon") S.recon = el.value;
    if (el.name === "period") S.period = el.value;
    LHMS.rerender();
  };
  LHMS.uiActions["live:rct-search"] = function (val) {
    S.rq = val; LHMS.rerender();
    setTimeout(function () {
      var f = document.querySelector('[data-live="rct-search"]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, 10);
  };

  LHMS.uiActions["pay-reconcile"] = function (el) {
    var to = el.getAttribute("data-to") === "1";
    var result = LHMS.actions.setPaymentReconciled(el.getAttribute("data-pay"), to);
    if (!result.ok) { ui.toast(result.error || "That payment is no longer on file.", "error"); return; }
    LHMS.rerender();
    ui.toast(to ? "Payment matched to the collection record." : "Payment returned to the unmatched list.");
  };

  LHMS.uiActions["rct-export"] = function () {
    var rows = [["Date", "Receipt", "Reference", "Document", "Bill to", "Method", "Amount", "Taken by", "Reconciled", "Reconciled by"]];
    visiblePayments().forEach(function (p) {
      var inv = p.invoiceId ? LHMS.get.invoice(p.invoiceId) : null;
      rows.push([p.date, p.receipt || "", p.reference, inv ? inv.number : p.reservationId || "",
        inv ? inv.title : "", p.method, p.amount, p.takenBy, p.reconciled ? "yes" : "no", p.reconciledBy || ""]);
    });
    ui.csv("aurelia-receipts-" + LHMS.session.propertyId + "-" + LHMS.day + ".csv", rows);
    LHMS.log("exported receipts", "folio", (rows.length - 1) + " payments");
    LHMS.save();
    ui.toast("Receipt list downloaded.");
  };
})();
