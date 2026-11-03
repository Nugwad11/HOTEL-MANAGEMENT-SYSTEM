/* ============================================================
   LHMS — Financial reports (§8)
   Ten different cuts of the rows LHMS.financeCore already adds
   up. The page holds no figures of its own: it asks the engine
   for a report, renders the columns it is given, and writes the
   same raw cells to CSV, Excel and the print sheet — so an
   exported report can never disagree with the screen it came from.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;

  var S = { key: "dept-revenue", days: 30, custom: false, from: "", to: "", sort: -1, dir: -1 };

  function groups() {
    var out = [];
    LHMS.REPORTS.forEach(function (r) {
      var g = out.filter(function (x) { return x.name === r.group; })[0];
      if (!g) { g = { name: r.group, items: [] }; out.push(g); }
      g.items.push(r);
    });
    return out;
  }

  function current() {
    return S.custom ? LHMS.reportBetween(S.key, S.from, S.to) : LHMS.report(S.key, S.days);
  }

  function windowLabel(rep) {
    return U.pretty(rep.from, "medium") + " to " + U.pretty(rep.to, "medium") +
      " · " + (U.nights(rep.from, rep.to) + 1) + " day" + (U.nights(rep.from, rep.to) ? "s" : "");
  }

  function isNumeric(type) { return type === "money" || type === "count" || type === "pct"; }

  function pctText(v) {
    return (v < 0 ? "−" : "") + Math.abs(v).toFixed(1) + "%";
  }

  // A totals line writes words into the columns it adds up — "33 services" under
  // a heading, "Every day in the window" under a date. Formatting one of those as
  // a figure turns a date column into "Invalid Date", so only a real number or a
  // real ISO day gets the column's treatment.
  function isFigure(c, v) {
    if (c.type === "date") return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    return typeof v === "number" && isFinite(v);
  }

  function cellText(c, v) {
    if (v === null || v === undefined || v === "") return "—";
    if (isNumeric(c.type) || c.type === "date") {
      if (!isFigure(c, v)) return String(v);
      if (c.type === "money") return U.money(Math.round(v));
      if (c.type === "pct") return pctText(v);
      if (c.type === "date") return U.pretty(v, "medium");
      return String(v);
    }
    return String(v);
  }

  function cellHtml(c, v) {
    if (v === null || v === undefined || v === "") return '<span class="tiny muted">no figure</span>';
    if ((isNumeric(c.type) || c.type === "date") && !isFigure(c, v)) return ui.esc(String(v));
    var text = ui.esc(cellText(c, v));
    if (c.type === "money") return '<b class="num">' + text + "</b>";
    if (c.type === "pct") return '<span class="num" style="color:' + (v < 0 ? "var(--red)" : "#6d6553") + '">' + text + "</span>";
    if (isNumeric(c.type)) return '<span class="num">' + text + "</span>";
    return text;
  }

  /* ---------------- the picker ---------------- */
  function pickerCard() {
    return ui.sectionCard("Reports", '<div class="stack" style="gap:2px">' + groups().map(function (g) {
      return '<div class="divider-label">' + ui.esc(g.name) + "</div>" +
        '<div class="stack" style="gap:4px">' + g.items.map(function (r) {
          var on = S.key === r.key;
          return '<button class="btn sm block ' + (on ? "soft" : "ghost") + '" ' +
            'style="justify-content:flex-start;' + (on ? "" : "text-align:left") + '" ' +
            'data-act="rep-open" data-key="' + r.key + '">' + ui.icon(r.icon, 12) + ui.esc(r.label) + "</button>";
        }).join("") + "</div>";
    }).join("") + "</div>" +
      '<div class="tiny muted mt12">Every one of these is the same money, cut a different way. The totals line at ' +
      "the foot of each report lands on a figure the financial dashboard already shows.</div>",
      "", "Choose what to report on", "file");
  }

  /* ---------------- filters ---------------- */
  function filterBar() {
    return '<section class="card no-print"><div class="toolbar">' +
      '<div class="seg">' + LHMS.FINANCE_RANGES.map(function (r) {
        return '<button class="' + (!S.custom && S.days === r.days ? "on" : "") + '" data-act="rep-range" data-days="' + r.days + '">' + r.label + "</button>";
      }).join("") + "</div>" +
      '<div class="field" style="margin:0"><label class="field-label">From</label>' +
        '<input type="date" value="' + S.from + '" max="' + LHMS.day + '" data-change="rep-window" name="from" /></div>' +
      '<div class="field" style="margin:0"><label class="field-label">To</label>' +
        '<input type="date" value="' + S.to + '" max="' + LHMS.day + '" data-change="rep-window" name="to" /></div>' +
      '<span class="spacer"></span>' +
      (S.custom ? '<span class="chip blue">typed window</span>' : "") +
      '<button class="btn sm" data-act="rep-csv">' + ui.icon("download", 11) + " CSV</button>" +
      '<button class="btn sm" data-act="rep-excel">' + ui.icon("download", 11) + " Excel</button>" +
      '<button class="btn sm" data-act="rep-pdf">' + ui.icon("printer", 11) + " PDF</button>" +
      "</div>" +
      '<div class="tiny muted" style="padding:0 14px 12px">CSV and Excel carry the unrounded figures, so a ' +
      "spreadsheet can be checked against this screen. PDF is the browser’s print sheet — set it to “Save as PDF”.</div>" +
      "</section>";
  }

  /* ---------------- the table ---------------- */
  function sortedRows(rep) {
    if (S.sort < 0 || !rep.columns[S.sort]) return rep.rows;
    var i = S.sort;
    return rep.rows.slice().sort(function (a, b) {
      var x = a[i], y = b[i];
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      if (isNumeric(rep.columns[i].type)) return (x - y) * S.dir;
      return (String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0) * S.dir;
    });
  }

  // A figure and a reference never break across lines; only the words do.
  function tdAttrs(c) {
    if (isNumeric(c.type)) return ' class="right num nowrap"';
    if (c.type === "date") return ' class="nowrap"';
    return "";
  }

  function headerRow(rep) {
    return "<tr>" + rep.columns.map(function (c, i) {
      var arrow = S.sort === i ? (S.dir === 1 ? " ▲" : " ▼") : "";
      return '<th' + (isNumeric(c.type) ? ' class="right"' : "") + '><button class="th-sort" data-act="rep-sort" data-col="' + i + '">' +
        ui.esc(c.label) + arrow + "</button></th>";
    }).join("") + "</tr>";
  }

  function bodyRows(rep, rows) {
    return rows.map(function (r) {
      return "<tr>" + rep.columns.map(function (c, i) {
        return "<td" + tdAttrs(c) + ">" + cellHtml(c, r[i]) + "</td>";
      }).join("") + "</tr>";
    }).join("");
  }

  function totalRow(rep) {
    // A blank in the totals line is deliberate — nothing to add up in a label
    // column — so it stays empty instead of reading as missing data.
    return '<tr class="report-total">' + rep.totals.map(function (t, i) {
      var c = rep.columns[i];
      if (t === "" || t === null || t === undefined) return "<td></td>";
      return "<td" + tdAttrs(c) + ">" + cellHtml(c, t) + "</td>";
    }).join("") + "</tr>";
  }

  // A short report reads better as bars than as a column of figures to add up by
  // hand; a long one is a table, and pretending otherwise just makes people scroll.
  function chartFor(rep, rows) {
    var moneyCol = -1;
    rep.columns.forEach(function (c, i) { if (moneyCol < 0 && c.type === "money" && i > 0) moneyCol = i; });
    if (moneyCol < 0 || rows.length < 2 || rows.length > 14) return "";
    var values = rows.map(function (r) { return Math.round(Number(r[moneyCol]) || 0); });
    // A bar cannot point below its own baseline here, and a debit drawn as a
    // short credit is a lie — the table above already tells the truth.
    if (values.some(function (v) { return v < 0; })) return "";
    var items = rows.map(function (r, i) {
      return { label: String(r[0]), value: values[i], color: ui.series(i) };
    });
    return '<div class="mt16"><div class="tiny muted" style="margin-bottom:6px">Bars show ' +
      ui.esc(rep.columns[moneyCol].label.toLowerCase()) + "</div>" + ui.barList(items, { money: true }) + "</div>";
  }

  function reportCard(rep) {
    var rows = sortedRows(rep);
    // Six columns or more only fit a card at readable size in the compact
    // table; minmax(0,…) stops a wide report pushing the page sideways.
    var dense = rep.columns.length >= 6 ? " mini" : "";
    var table = '<div class="table-wrap" style="max-height:520px"><table class="data' + dense + '"><thead>' + headerRow(rep) +
      "</thead><tbody>" + bodyRows(rep, rows) + totalRow(rep) + "</tbody></table></div>";
    return '<section class="card" id="report-sheet">' +
      '<div class="card-head"><div><div class="card-title">' + ui.icon(rep.icon, 15) + ui.esc(rep.title) + "</div>" +
      '<div class="card-sub">' + ui.esc(rep.sub) + "</div></div>" +
      '<div class="row" style="gap:8px"><span class="chip">' + ui.esc(LHMS.get.property().short) + "</span>" +
      '<span class="tiny muted">' + windowLabel(rep) + "</span></div></div>" +
      (rep.rows.length ? table + chartFor(rep, rows)
        : ui.empty("Nothing to report in this window", "The rules ran and found no row to list — a quieter period is a real answer, not an error.", "file")) +
      '<div class="notice info mt12">' + ui.icon("shield") + "<div>" + ui.esc(rep.note) + "</div></div>" +
      (rep.rows.length > 40 ? '<div class="tiny muted mt8">All ' + rep.rows.length + " rows are on the screen and in the export; scroll the table.</div>" : "") +
      "</section>";
  }

  /* ---------------- exports ---------------- */
  function plain(v) { return v === null || v === undefined ? "" : v; }

  function fileBase(rep) {
    return "aurelia-" + rep.key + "-" + LHMS.session.propertyId + "-" + rep.from + "-to-" + rep.to;
  }

  function exportRows(rep) {
    var head = [
      [rep.title],
      ["Property", LHMS.get.property().name],
      ["Window", rep.from + " to " + rep.to],
      // The columns are written as bare numbers, so the file has to say which
      // money each one of them is worth in.
      ["Money of account", LHMS.fx.base()],
      ["Run by", LHMS.session.name + " · " + LHMS.session.role],
      ["Run on", LHMS.day],
      [],
      rep.columns.map(function (c) { return c.label; })
    ];
    return head.concat(rep.rows.map(function (r) { return r.map(plain); }))
      .concat([[], rep.totals.map(plain), [], ["Note", rep.note]]);
  }

  function downloadText(filename, mime, text) {
    var blob = new Blob(["\ufeff" + text], { type: mime + ";charset=utf-8;" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
  }

  // Numbers are written as numbers, not as "₦1,250,000", so the spreadsheet can
  // be summed rather than re-typed.
  function excelCell(v) {
    var num = typeof v === "number";
    return "<td" + (num ? ' align="right"' : "") + ">" + ui.esc(plain(v)) + "</td>";
  }

  function excelSheet(rep) {
    var rows = exportRows(rep);
    return "<html><head><meta charset='utf-8' /></head><body><table>" +
      rows.map(function (r) { return "<tr>" + r.map(excelCell).join("") + "</tr>"; }).join("") +
      "</table></body></html>";
  }

  function audit(rep, kind) {
    LHMS.log("exported a report", "report", rep.label + " · " + kind + " · " + rep.from + "→" + rep.to + " · " + rep.rows.length + " rows");
    LHMS.save();
  }

  LHMS.uiActions["rep-csv"] = function () {
    var rep = current();
    if (!rep || rep.denied || rep.error) { ui.toast(rep && rep.error ? rep.error : "This report cannot be run.", "error"); return; }
    ui.csv(fileBase(rep) + ".csv", exportRows(rep));
    audit(rep, "CSV");
    ui.toast(rep.label + " downloaded — " + rep.rows.length + " rows.");
  };

  LHMS.uiActions["rep-excel"] = function () {
    var rep = current();
    if (!rep || rep.denied || rep.error) { ui.toast(rep && rep.error ? rep.error : "This report cannot be run.", "error"); return; }
    downloadText(fileBase(rep) + ".xls", "application/vnd.ms-excel", excelSheet(rep));
    audit(rep, "Excel");
    ui.toast(rep.label + " downloaded as a spreadsheet — " + rep.rows.length + " rows.");
  };

  // The print sheet is the report with the chrome taken off, so a PDF saved from
  // it holds the same figures as the screen and the CSV.
  LHMS.uiActions["rep-pdf"] = function () {
    var rep = current();
    if (!rep || rep.denied || rep.error) { ui.toast(rep && rep.error ? rep.error : "This report cannot be run.", "error"); return; }
    audit(rep, "PDF");
    window.print();
  };

  /* ---------------- page ---------------- */
  LHMS.pages["fin-reports"] = function () {
    var rep = current();
    if (!rep) {
      return ui.pageHead({ eyebrow: "Financial management", title: "Financial reports" }) +
        ui.empty("Report not found", "That report is not in the catalogue.", "file");
    }
    if (rep.denied) {
      return ui.pageHead({ eyebrow: "Financial management", title: "Financial reports" }) +
        '<div class="notice danger">' + ui.icon("lock") + "<div><b>Your role cannot read financial reports.</b> " +
        "“View financial reports” is held by the manager and the revenue office; " + ui.esc(LHMS.session.role) + " is not one of them.</div></div>";
    }
    if (rep.error) {
      return ui.pageHead({ eyebrow: "Financial management", title: "Financial reports" }) +
        '<div class="notice danger">' + ui.icon("alert") + "<div><b>" + ui.esc(rep.error) + "</b> The report has not been run.</div></div>";
    }

    var printHead = '<div class="print-only"><div class="card-eyebrow">' + ui.esc(LHMS.get.property().name) + " · financial report</div>" +
      "<h2>" + ui.esc(rep.title) + "</h2><p>" + ui.esc(windowLabel(rep)) + " · run by " + ui.esc(LHMS.session.name) +
      " on " + U.pretty(LHMS.day, "medium") + "</p></div>";

    return ui.pageHead({
      eyebrow: "Financial management · " + LHMS.get.property().short,
      title: "Financial reports",
      sub: "Ten standard cuts of the period, each filtered by a date range and exportable. Nothing here is calculated twice. Every money column is counted in <b>" + ui.esc(LHMS.fx.base()) + "</b>, the money of the books.",
      actions: '<a class="btn" href="#/financials">' + ui.icon("chart", 14) + " Dashboard</a>" +
        '<a class="btn" href="#/expenses">' + ui.icon("box", 14) + " Expense ledger</a>"
    }) +
      printHead + filterBar() +
      '<div class="grid mt16" style="grid-template-columns:236px minmax(0,1fr)">' +
        '<div class="no-print">' + pickerCard() + "</div>" + reportCard(rep) + "</div>" +
      '<div class="grid g2 mt16 no-print">' +
        ui.sectionCard("What each report answers", '<div class="stack" style="gap:0">' + LHMS.REPORTS.map(function (r) {
          return '<div class="detail-row"><dt>' + ui.esc(r.label) + "</dt><dd style=\"font-weight:400;text-align:right;max-width:58%\">" +
            ui.esc(subOf(r.key)) + "</dd></div>";
        }).join("") + "</div>", "", "Pick the question, not the spreadsheet", "list") +
        ui.sectionCard("Reading a financial report", '<div class="stack" style="gap:0">' + [
          ["Revenue earned", "A charge on the day it was incurred, plus hall bookings with no room account behind them — before tax."],
          ["Cash collected", "Receipts dated inside the window, less refunds dated inside it. It is not the same as revenue, and neither is wrong."],
          ["Owed", "A live position, not a flow through the window, counted once. A charge copied onto an invoice stays on the folio."],
          ["Costs", "Only lines with a second signature. A recorded cost is shown but moves no result."],
          ["Every total", "Taken from the statement the dashboard is built from — the same engine, the same rows."]
        ].map(function (r) {
          return '<div class="detail-row"><dt><b>' + r[0] + "</b></dt><dd style=\"font-weight:400;text-align:right;max-width:62%\">" + r[1] + "</dd></div>";
        }).join("") + "</div>", "", "The rules, so two readers get one answer", "shield") +
      "</div>";
  };

  var SUBS = {
    "dept-revenue": "Which department earned the money.",
    "service-revenue": "Which product sold, and from which price list.",
    "payment-method": "How the money arrived and whether the bank confirms it.",
    "daily-cash": "What came in on each day, quiet days included.",
    "outstanding": "Who still owes, how much, and for how long.",
    "discounts-refunds": "What was given back, and who authorised it.",
    expenses: "What was spent, and what is still awaiting a signature.",
    taxes: "What was billed on behalf of the authorities and the house.",
    "price-history": "Every amendment to the catalogue, with its reason.",
    profitability: "Revenue against approved cost, month by month."
  };
  function subOf(key) { return SUBS[key] || ""; }

  /* ---------------- actions ---------------- */
  LHMS.uiActions["rep-open"] = function (el) {
    S.key = el.getAttribute("data-key");
    S.sort = -1;
    LHMS.rerender();
  };
  LHMS.uiActions["rep-range"] = function (el) {
    S.days = Number(el.getAttribute("data-days"));
    S.custom = false;
    S.from = "";
    S.to = "";
    S.sort = -1;
    LHMS.rerender();
  };
  LHMS.uiActions["change:rep-window"] = function (el) {
    S[el.name] = el.value;
    if (S.from && S.to) {
      S.custom = true;
      S.sort = -1;
    } else {
      S.custom = false;
    }
    LHMS.rerender();
    // The date input repaints with the rest of the page, so keep the caret where
    // the reader left it instead of dropping focus mid-typing.
    var again = document.querySelector('[data-change="rep-window"][name="' + el.name + '"]');
    if (again) again.focus();
  };
  LHMS.uiActions["rep-sort"] = function (el) {
    var col = Number(el.getAttribute("data-col"));
    // The first click on a money column asks for the biggest figure, not the
    // smallest — that is the order a reader wants a report in.
    if (S.sort === col) S.dir = -S.dir;
    else { S.sort = col; S.dir = -1; }
    LHMS.rerender();
  };
})();
