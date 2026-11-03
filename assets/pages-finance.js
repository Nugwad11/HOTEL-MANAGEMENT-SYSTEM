/* ============================================================
   LHMS — Financial Management: price & service setup
   The only screen where a number that a guest pays is decided.
   Every other module asks LHMS.price for an amount; nothing here
   is copied into a page, and nothing a page shows is worked out
   by the page.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;
  var db = LHMS.db;

  var S = { cat: "room", query: "", list: "all", status: "all", sort: "name", dir: 1, detail: null, importPlan: null };

  var CATS = [
    { key: "room", label: "Rooms", icon: "bed", unit: "per night", hint: "Nightly rates, day use and the festive window" },
    { key: "hall", label: "Halls & events", icon: "users", unit: "per hour", hint: "Hourly rates with half-day and full-day packages" },
    { key: "restaurant", label: "Restaurant & outlets", icon: "utensils", unit: "each", hint: "Menu, minibar and spa prices" },
    { key: "laundry", label: "Laundry", icon: "box", unit: "per piece", hint: "Standard prices and express surcharges" }
  ];

  // Field names come from the store so the form can never offer a surcharge the
  // engine would ignore. The labels and units are presentation. Money steps are
  // 50 because that is the increment the engine rounds to.
  var FIELD_LABELS = {
    weekendPct: ["Weekend uplift", "%", 0, 100, 1],
    extraAdult: ["Extra person", "₦", 0, 5000000, 50],
    extraBed: ["Extra bed", "₦", 0, 5000000, 50],
    earlyCheckIn: ["Early check-in", "₦", 0, 5000000, 50],
    lateCheckOut: ["Late check-out", "₦", 0, 5000000, 50],
    depositPct: ["Deposit", "%", 0, 100, 1],
    cancelPct: ["Cancellation fee", "%", 0, 100, 1],
    cancelHours: ["Cancellation notice", "hours", 0, 720, 1],
    expressPct: ["Express surcharge", "%", 0, 200, 1],
    halfDay: ["Half day package", "₦", 0, 50000000, 50],
    fullDay: ["Full day package", "₦", 0, 50000000, 50]
  };

  function catMeta(key) {
    return CATS.filter(function (c) { return c.key === key; })[0] || CATS[0];
  }

  function canEdit() { return LHMS.can("configure_prices"); }

  // One row per price record — a service can be on several lists at once, and
  // the list is what tells them apart.
  function allRows() {
    var out = [];
    LHMS.price.services(S.cat).forEach(function (svc) {
      LHMS.price.prices(svc.id).forEach(function (p) {
        out.push({ service: svc, price: p, list: LHMS.price.list(p.listId) });
      });
    });
    return out;
  }

  function visibleRows() {
    var q = S.query.trim().toLowerCase();
    var today = LHMS.day;
    var list = allRows().filter(function (r) {
      if (!r.list) return false;
      if (S.list !== "all" && r.price.listId !== S.list) return false;
      if (S.status === "active" && !(r.price.active && r.service.active)) return false;
      if (S.status === "off" || S.status === "expired") {
        var off = r.price.active && r.service.active;
        var past = windowOf(r).to && windowOf(r).to < today;
        if (S.status === "off" && (off && !past)) return false;
        if (S.status === "expired" && !past) return false;
      }
      if (q) {
        var hay = (r.service.name + " " + r.service.code + " " + r.list.name + " " + r.price.id).toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    var key = S.sort;
    list.sort(function (a, b) {
      var x = sortValue(a, key), y = sortValue(b, key);
      if (x === y) return a.service.name < b.service.name ? -1 : 1;
      return (x < y ? -1 : 1) * S.dir;
    });
    return list;
  }

  function sortValue(r, key) {
    if (key === "name") return r.service.name.toLowerCase();
    if (key === "amount") return r.price.amount;
    if (key === "list") return r.list.priority;
    if (key === "status") return (r.price.active && r.service.active) ? 1 : 0;
    if (key === "effective") return r.price.from || "0000-00-00";
    if (key === "updated") return r.price.updatedAt;
    return r.service.name.toLowerCase();
  }

  // A row with no dates of its own inherits the season of its list — the festive
  // uplift is bounded by the festive list, not repeated on every row.
  function windowOf(r) {
    var list = r.list || {};
    return { from: r.price.from || list.from || null, to: r.price.to || list.to || null };
  }

  function windowText(r) {
    var w = windowOf(r);
    if (!w.from && !w.to) return "Open-ended";
    if (w.from && w.to) return U.pretty(w.from, "short") + " → " + U.pretty(w.to, "short");
    if (w.from) return "From " + U.pretty(w.from, "short");
    return "Until " + U.pretty(w.to, "short");
  }

  function statusChip(r) {
    var w = windowOf(r);
    if (!r.service.active) return ui.chip("Service closed", "red");
    if (!r.price.active) return ui.chip("Off", "");
    if (w.to && w.to < LHMS.day) return ui.chip("Expired", "amber");
    if (w.from && w.from > LHMS.day) return ui.chip("Future", "blue");
    return ui.chip("On sale", "green");
  }

  var COLS = [
    ["name", "Service"], ["list", "Price list"], ["amount", "Amount"],
    ["effective", "Effective"], ["status", "Status"], ["updated", "Last change"]
  ];

  function headerRow() {
    return "<tr>" + COLS.map(function (c) {
      var arrow = S.sort === c[0] ? (S.dir === 1 ? " ▲" : " ▼") : "";
      return '<th><button class="th-sort" data-act="price-sort" data-col="' + c[0] + '">' + c[1] + arrow + "</button></th>";
    }).join("") + '<th class="right">Actions</th></tr>';
  }

  function priceRows(list) {
    return list.map(function (r) {
      var tonight = LHMS.price.amount(r.service.id, { listId: r.price.listId });
      return '<tr>' +
        '<td><b class="small">' + ui.esc(r.service.name) + '</b>' +
        '<div class="tiny muted">' + ui.esc(r.service.code) + " · " + ui.esc(r.service.unit) +
        (r.service.occupancy ? " · sleeps " + r.service.occupancy : "") +
        (r.service.capacity ? " · " + r.service.capacity + " guests" : "") +
        (r.service.turnaroundMins ? " · " + Math.round(r.service.turnaroundMins / 60) + "h turnaround" : "") +
        "</div></td>" +
        '<td><div class="row" style="gap:6px"><span class="dotline" style="background:' + listTone(r.list) + '"></span>' +
        '<div><div class="small">' + ui.esc(r.list.name) + '</div><div class="tiny muted">' + ui.esc(r.list.kind) + " · priority " + r.list.priority + "</div></div></div></td>" +
        '<td class="right num"><b>' + U.money(r.price.amount, r.price.currency) + '</b>' +
        '<div class="tiny muted">' + ui.esc(catMeta(r.service.category).unit) +
        (tonight && tonight.unit !== r.price.amount ? " · " + U.money(tonight.unit, r.price.currency) + " tonight" : "") + "</div>" +
        // A foreign row is only worth the figure the books can put under it, so
        // the card shows both — and says plainly when there is no second figure.
        (r.price.currency !== LHMS.fx.base() ? '<div class="tiny">' + ui.esc(LHMS.fx.pair(r.price.amount, r.price.currency)) + "</div>" : "") +
        "</td>" +
        '<td><div class="small">' + windowText(r) + '</div><div class="tiny muted">' + taxSummary(r.service.category) + "</div></td>" +
        "<td>" + statusChip(r) + "</td>" +
        '<td><div class="tiny">' + ui.esc(r.price.updatedBy) + '</div><div class="tiny muted">' + U.pretty(String(r.price.updatedAt).slice(0, 10), "short") + "</div></td>" +
        '<td class="right"><div class="row" style="gap:5px;justify-content:flex-end">' +
          '<button class="btn sm ghost" data-act="price-history" data-service="' + r.service.id + '">' + ui.icon("clock", 11) + " History</button>" +
          (canEdit() ? '<button class="btn sm" data-act="price-edit" data-price="' + r.price.id + '">' + ui.icon("edit", 11) + " Edit</button>" : "") +
        "</div></td></tr>";
    }).join("");
  }

  function listTone(list) {
    return list.kind === "seasonal" ? "#b18f52" : list.kind === "day-use" ? "#6a5a8e" : "#4b6d92";
  }

  function taxSummary(category) {
    var rules = LHMS.price.applicableTaxes(category);
    if (!rules.length) return "No tax applied";
    return rules.map(function (r) { return r.pct + "% " + r.name.toLowerCase(); }).join(" + ");
  }

  // The currency a row can be sold in is the currency the books can value, so
  // the choice is the catalogue's and the refusal is explained beside it.
  function currencyOptions(current) {
    var base = LHMS.fx.base();
    return LHMS.fx.codes.map(function (code) {
      var blocked = code !== base && !LHMS.fx.state(code).usable;
      return '<option value="' + code + '"' + (code === current ? " selected" : "") + ">" +
        ui.esc(code + " — " + (LHMS.fx.nameOf(code) || code) + (blocked ? " (no usable rate)" : "")) + "</option>";
    }).join("");
  }

  function rateHint() {
    var base = LHMS.fx.base();
    var blocked = LHMS.fx.codes.filter(function (c) { return c !== base && !LHMS.fx.state(c).usable; });
    return blocked.length
      ? "Not on sale: " + blocked.join(", ") + ". File a rate in Financial settings before selling in them."
      : "Every currency on this card has a rate the books can value.";
  }

  /* ---------------- price editor ---------------- */
  function surchargeInputs(category, price) {
    var bag = (price && price.surcharges) || {};
    return LHMS.price.surchargeFields(category).map(function (field) {
      var meta = FIELD_LABELS[field] || [field, "₦", 0, 5000000, 500];
      var v = bag[field];
      return '<div class="field"><label>' + meta[0] + " (" + meta[1] + ')</label>' +
        '<input name="' + field + '" type="number" min="' + meta[2] + '" max="' + meta[3] + '" step="' + meta[4] + '" ' +
        'value="' + (v === null || v === undefined ? "" : v) + '" /></div>';
    }).join("");
  }

  function editorBody(priceId) {
    var price = LHMS.price.priceRow(priceId);
    var svc = price && LHMS.price.service(price.serviceId);
    if (!price || !svc) return "";
    var d = S.detail;
    var hidden = d && d.hidden ? "hidden" : "";
    return '<form data-form="price-edit" id="price-form"><input type="hidden" name="priceId" value="' + price.id + '" />' +
      '<input type="hidden" name="category" value="' + svc.category + '" />' +
      '<div class="form-grid">' +
        '<div class="field span2"><label>Service</label><input value="' + ui.esc(svc.name) + '" disabled /></div>' +
        '<div class="field"><label>Price (' + price.currency + ')</label><input name="amount" type="number" min="50" step="50" value="' + price.amount + '" required /></div>' +
        '<div class="field"><label>Currency</label><select name="currency">' + currencyOptions(price.currency) + "</select>" +
        '<div class="tiny muted">' + ui.esc(rateHint()) + "</div></div>" +
        '<div class="field span2"><label>Price list</label><select name="listId">' + LHMS.price.lists().map(function (l) {
          return '<option value="' + l.id + '"' + (l.id === price.listId ? " selected" : "") + ">" + ui.esc(l.name) + " · " + ui.esc(l.kind) + "</option>";
        }).join("") + "</select></div>" +
        '<div class="field"><label>Effective from</label><input name="from" type="date" value="' + (price.from || "") + '" /></div>' +
        '<div class="field"><label>Effective to</label><input name="to" type="date" value="' + (price.to || "") + '" /></div>' +
        surchargeInputs(svc.category, price) +
        '<label class="check mt8"><input type="checkbox" name="active" value="yes"' + (price.active ? " checked" : "") + " " + hidden + " /> Available to sell on this list</label>" +
        '<div class="field span2"><label>Reason for the change</label>' +
        '<input name="reason" placeholder="Required — written to the audit trail" required /></div>' +
        '<label class="check span2 mt8"' + (d && d.confirmHidden ? "hidden" : "") + '><input type="checkbox" name="confirm" value="yes" required /> I confirm the new price and understand confirmed bookings keep theirs</label>' +
      "</div>" +
      '<div class="notice info mt12">' + ui.icon("alert") + "<div><b>" + ui.esc(svc.name) + "</b> is priced from this record by the central engine. " +
      "Bookings and orders already posted keep the amount they were taken at." +
      (LHMS.movesMoneyAlone() ? "" : " A move of more than " + U.money(LHMS.financeSettings().approvalAmount) +
        " (the books' own money) away from the current " + U.money(price.amount, price.currency) +
        " goes to a second signature before it lands.") +
      "</div></div>" +
      '<p class="tiny muted mt8">Last set by ' + ui.esc(price.updatedBy) + " · " + U.pretty(String(price.updatedAt).slice(0, 10), "short") + "</p>" +
      "</form>";
  }

  LHMS.uiActions["price-edit"] = function (el) {
    var priceId = el.getAttribute("data-price");
    var price = LHMS.price.priceRow(priceId);
    var svc = price && LHMS.price.service(price.serviceId);
    if (!svc) return;
    S.detail = { hidden: false, confirmHidden: false };
    ui.modal({
      title: "Edit " + svc.name,
      sub: catMeta(svc.category).label + " · " + svc.code + " · " + LHMS.price.list(price.listId).name,
      body: editorBody(priceId),
      footer: '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn" data-act="price-off" data-price="' + price.id + '">' + ui.icon("eye", 11) + " Switch off</button>" +
        '<button class="btn primary" data-act="price-save">Save price</button>'
    });
  };

  // Switching a price off still has to be explained, and still has to be
  // confirmed — the reason is the audit record.
  LHMS.uiActions["price-off"] = function (el) {
    var priceId = el.getAttribute("data-price");
    var price = LHMS.price.priceRow(priceId);
    var svc = price && LHMS.price.service(price.serviceId);
    if (!svc) return;
    S.detail = { hidden: true, confirmHidden: false };
    var form = document.getElementById("price-form");
    if (form) {
      var reason = form.querySelector('[name="reason"]');
      if (reason) { reason.value = ""; reason.focus(); }
      var amount = form.querySelector('[name="amount"]');
      if (amount) amount.readOnly = true;
      form.setAttribute("data-off", priceId);
      var note = form.parentNode.querySelector(".notice");
      if (note) note.innerHTML = ui.icon("eye") + "<div><b>" + ui.esc(svc.name) + " × " + ui.esc(LHMS.price.list(price.listId).name) +
        "</b> will stop being offered. Already-posted charges are untouched.</div>";
      var foot = document.querySelector(".modal-foot");
      if (foot) foot.innerHTML = '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn danger" data-act="price-off-save">Switch off this price</button>';
    }
    ui.toast("Enter a reason, then confirm.", "");
  };

  function offReason() {
    var form = document.getElementById("price-form");
    return form ? { priceId: form.getAttribute("data-off"), reason: (form.querySelector('[name="reason"]') || {}).value || "" } : null;
  }

  LHMS.uiActions["price-off-save"] = function () {
    var req = offReason();
    if (!req.reason) { ui.toast("A reason is required — it goes in the audit trail.", "error"); return; }
    var result = LHMS.actions.setPrice(req.priceId, { active: false }, req.reason);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast("Price switched off. Nothing new will be sold from it.");
  };

  LHMS.uiActions["price-save"] = function () {
    var form = document.getElementById("price-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.setPrice(d.priceId, {
      amount: d.amount, currency: d.currency, listId: d.listId,
      from: d.from || null, to: d.to || null, active: !!d.active,
      surcharges: surchargesFrom(d)
    }, d.reason);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    if (result.queued) { ui.toast(LHMS.outcome(result).text); return; }
    var svc = LHMS.price.service(result.price.serviceId);
    ui.toast(svc.name + " · " + U.money(result.price.amount, result.price.currency) + " saved and audited.");
  };

  // Only the surcharges this category actually recognises are collected, so a
  // stray field can never reach the engine.
  function surchargesFrom(d) {
    var out = {};
    LHMS.price.surchargeFields(d.category).forEach(function (field) {
      if (d[field] !== undefined) out[field] = d[field] === "" ? 0 : Number(d[field]);
    });
    return out;
  }

  /* ---------------- new service ---------------- */
  LHMS.uiActions["price-new"] = function () {
    var cat = catMeta(S.cat);
    ui.modal({
      title: "Add a " + cat.label.toLowerCase().replace(/ &.*/, "") + " service",
      sub: "Creates the service and its first price together, so it can be quoted immediately.",
      body: '<form data-form="new-service" id="service-form"><div class="form-grid">' +
        '<input type="hidden" name="category" value="' + cat.key + '" />' +
        '<div class="field span2"><label>Name</label><input name="name" placeholder="Terrace dinner for two" required /></div>' +
        '<div class="field"><label>Code</label><input name="code" placeholder="TD2" /></div>' +
        '<div class="field"><label>Unit</label><input name="unit" value="' + cat.unit.replace("per ", "") + '" /></div>' +
        '<div class="field"><label>Price (₦)</label><input name="amount" type="number" min="50" step="50" required /></div>' +
        '<div class="field"><label>Price list</label><select name="listId">' + LHMS.price.lists().map(function (l) {
          return '<option value="' + l.id + '">' + ui.esc(l.name) + "</option>";
        }).join("") + "</select></div>" +
        (cat.key === "hall" ? '<div class="field"><label>Capacity</label><input name="capacity" type="number" min="1" value="100" /></div>' : "") +
        (cat.key === "laundry" ? '<div class="field"><label>Turnaround (minutes)</label><input name="turnaroundMins" type="number" min="30" step="30" value="240" /></div>' : "") +
        (cat.key === "room" ? '<div class="field"><label>Sleeps</label><input name="occupancy" type="number" min="1" max="8" value="2" /></div>' : "") +
        surchargeInputs(cat.key, null) +
        '<div class="field span2"><label>Why is this being added?</label>' +
        '<input name="reason" placeholder="Required — written to the audit trail" required /></div>' +
        "</div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="service-create">Create service</button>'
    });
  };

  LHMS.uiActions["service-create"] = function () {
    var form = document.getElementById("service-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.createService(d);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    S.cat = result.service.category;
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.service.name + " added at " + U.money(result.price.amount, result.price.currency) + ".");
  };

  /* ---------------- history ---------------- */
  LHMS.uiActions["price-history"] = function (el) {
    var svc = LHMS.price.service(el.getAttribute("data-service"));
    if (!svc) return;
    var entries = LHMS.price.history(svc.id);
    var rows = entries.map(function (h) {
      var list = LHMS.price.list(h.listId);
      var moved = h.from && h.from.currency && h.to.currency !== h.from.currency;
      return '<div class="list-row"><div class="lr-main"><div class="lr-title">' +
        (h.from ? U.money(h.from.amount, h.from.currency) : "—") + " → <b>" + U.money(h.to.amount, h.to.currency) + "</b>" +
        (h.to.active === false ? " " + ui.chip("switched off", "red") : "") +
        (moved ? " " + ui.chip("re-denominated", "gold") : "") + "</div>" +
        '<div class="lr-sub">' + ui.esc(h.by) + " · " + U.pretty(String(h.at).slice(0, 10), "short") + " · " + ui.esc(list ? list.name : "—") + "</div>" +
        '<div class="tiny muted mt8">' + ui.esc(h.reason) + "</div></div></div>";
    }).join("");
    ui.modal({
      title: "Price history — " + svc.name,
      sub: entries.length + " recorded change" + (entries.length === 1 ? "" : "s") + " · newest first",
      body: entries.length ? '<div class="list">' + rows + "</div>" +
        '<p class="tiny muted mt8">Only a user with the “Configure prices” capability can make these changes, and none of them rewrite a posted charge.</p>'
        : ui.empty("No changes yet", "This price has not been amended since it was loaded.", "clock"),
      footer: '<button class="btn" data-close-modal>Close</button>'
    });
  };

  /* ---------------- filters, tabs, export ---------------- */
  LHMS.uiActions["price-cat"] = function (el) {
    S.cat = el.getAttribute("data-cat");
    S.detail = null;
    LHMS.rerender();
  };
  LHMS.uiActions["price-sort"] = function (el) {
    var col = el.getAttribute("data-col");
    if (S.sort === col) S.dir = -S.dir; else { S.sort = col; S.dir = 1; }
    LHMS.rerender();
  };
  LHMS.uiActions["live:price-search"] = function (val) {
    S.query = val; LHMS.rerender();
    setTimeout(function () {
      var f = document.querySelector('[data-live="price-search"]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, 10);
  };
  LHMS.uiActions["change:price-filter"] = function (el) {
    var form = el.form || el.parentNode;
    if (el.name === "list") S.list = el.value;
    if (el.name === "status") S.status = el.value;
    LHMS.rerender();
  };
  // The file is the template the reader expects back: it carries the price
  // record's own id, the surcharge columns for this category, and the window as
  // the row holds it rather than as the tab displays it.
  LHMS.uiActions["price-export"] = function () {
    var fields = LHMS.price.surchargeFields(S.cat);
    var rows = [["Price ID", "Service", "Code", "Category", "Price list", "Amount", "Currency",
      "Effective from", "Effective to", "Status"].concat(fields)
      .concat(["Updated by", "Updated at"])];
    visibleRows().forEach(function (r) {
      rows.push([r.price.id, r.service.name, r.service.code, r.service.category, r.list.name,
        r.price.amount, r.price.currency, r.price.from || "", r.price.to || "",
        r.price.active ? "on sale" : "off"]
        .concat(fields.map(function (f) { var v = r.price.surcharges[f]; return v === undefined || v === null ? "" : v; }))
        .concat([r.price.updatedBy, String(r.price.updatedAt).slice(0, 10)]));
    });
    ui.csv("aurelia-price-list-" + S.cat + "-" + LHMS.day + ".csv", rows);
    LHMS.log("exported the price list", "pricing", catMeta(S.cat).label + " · " + (rows.length - 1) + " records");
    LHMS.save();
    ui.toast("Price list downloaded.");
  };

  /* ---------------- bulk update ---------------- */

  // The two buttons a desk wants when a season is repriced: the file the reader
  // accepts, and a preview of what it would do before any of it happens.
  LHMS.uiActions["price-import"] = function () {
    S.importPlan = null;
    ui.modal({
      title: "Bulk-update prices",
      sub: "Export this tab, change the Amount, Status, effective window or surcharge columns in your spreadsheet, then paste the whole thing back.",
      body: '<form data-form="price-import" id="import-form"><div class="field">' +
        '<label>Paste the file — CSV, or a copy straight out of Excel</label>' +
        '<textarea name="csv" rows="5" spellcheck="false" ' +
        'placeholder="Price ID,Service,Code,Price list,Amount,…"></textarea></div>' +
        '<div class="field mt8"><label>Why are these prices changing?</label>' +
        '<input name="reason" placeholder="Required — written to the audit trail" /></div>' +
        '<div class="notice info mt12">' + ui.icon("shield") + "<div><b>Nothing has changed yet.</b> Review lists every row this file " +
        "would move and every row it cannot read. A move over " + U.money(LHMS.financeSettings().approvalAmount) +
        " of the books' own money" +
        " goes to a second signature instead of landing, exactly as it would from the edit form. A column the file leaves out is left alone." +
        "</div></div>" +
        '<div id="import-preview" class="mt8"></div></form>',
      footer: '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn" data-act="price-import-plan">' + ui.icon("eye", 11) + " Review</button>" +
        '<button class="btn primary" data-act="price-import-apply" disabled>' + ui.icon("check", 11) + " Apply</button>"
    });
  };

  function importFields() {
    var form = document.getElementById("import-form");
    if (!form) return null;
    var grab = function (name) { var el = form.querySelector('[name="' + name + '"]'); return el ? el.value : ""; };
    return { csv: grab("csv"), reason: String(grab("reason")).trim() };
  }

  function outcomeChip(r) {
    if (r.state === "change") return ui.chip("Will change", "green");
    if (r.state === "queue") return ui.chip("Held for signature", "amber");
    if (r.state === "unchanged") return ui.chip("No change", "");
    return ui.chip("Rejected", "red");
  }

  // One line per cell that moves, so a desk can see the number it is about to
  // pay attention to rather than a count alone.
  function diffText(r) {
    return r.diff.map(function (d) {
      var was = d[0] === "amount" ? U.money(d[1], (r.current || {}).currency) : d[1];
      var now = d[0] === "amount" ? U.money(d[2], (r.next || {}).currency) : d[2];
      return d[0] + ": " + was + " → " + now;
    }).join(" · ");
  }

  // The modal is roughly half the page wide, so the preview uses the compact
  // table variant and folds the list into the price cell — the outcome of every
  // row has to be readable without a sideways scroll.
  function previewTable(plan) {
    if (!plan.changes.length && !plan.rejected.length)
      return ui.empty("Nothing to apply", "Every row in this file already holds these values.", "eye");
    return '<div class="table-wrap" style="max-height:300px;overflow:auto"><table class="data mini"><thead><tr>' +
      "<th>Line</th><th>Price</th><th>What moves</th><th>Outcome</th></tr></thead><tbody>" +
      plan.rows.map(function (r) {
        return "<tr><td>" + r.line + "</td>" +
          '<td><div class="small">' + ui.esc(r.service) + "</div>" +
          '<div class="tiny muted">' + ui.esc(r.list) + " · " + ui.esc(r.priceId || "—") + "</div></td>" +
          '<td><div class="tiny">' + (r.error ? "<b>" + ui.esc(r.error) + "</b>" : ui.esc(diffText(r))) + "</div></td>" +
          "<td>" + outcomeChip(r) + "</td></tr>";
      }).join("") + "</tbody></table></div>" +
      '<p class="tiny muted mt8">' + plan.counts.change + " to change · " + plan.counts.queue +
      " held for a second signature · " + plan.counts.unchanged + " already at these values · " +
      plan.counts.reject + " cannot be read.</p>";
  }

  LHMS.uiActions["price-import-plan"] = function () {
    var f = importFields();
    if (!f) return;
    var plan = LHMS.price.planImport(f.csv, f.reason);
    if (!plan.ok) { ui.toast(plan.error, "error"); return; }
    S.importPlan = plan;
    var host = document.getElementById("import-preview");
    if (host) host.innerHTML = previewTable(plan);
    var foot = document.querySelector(".modal-foot");
    if (foot) {
      foot.innerHTML = '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn" data-act="price-import-plan">' + ui.icon("eye", 11) + " Review again</button>" +
        '<button class="btn primary" data-act="price-import-apply"' + (plan.changes.length ? "" : " disabled") + ">" +
        ui.icon("check", 11) + " Apply " + plan.changes.length + "</button>";
    }
    ui.toast(plan.changes.length ? "Review the list, then apply." : "This file moves nothing.",
      plan.counts.reject ? "error" : "");
  };

  LHMS.uiActions["price-import-apply"] = function () {
    var plan = S.importPlan;
    if (!plan) { ui.toast("Review the file first.", "error"); return; }
    S.importPlan = null;
    var result = LHMS.actions.applyPriceImport(plan);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.applied + " price" + (result.applied === 1 ? "" : "s") + " updated" +
      (result.queued ? " · " + result.queued + " held for a second signature" : "") +
      (result.rejected ? " · " + result.rejected + " row" + (result.rejected === 1 ? "" : "s") + " rejected" : "") + ".");
  };

  /* ---------------- page ---------------- */
  LHMS.pages.prices = function (route) {
    var serviceId = route && route.sub;
    var focus = serviceId ? LHMS.price.service(serviceId) : null;
    if (focus) S.cat = focus.category;
    var list = visibleRows();
    var cat = catMeta(S.cat);
    var counts = LHMS.price.services(cat.key);
    var priced = counts.filter(function (s) { return LHMS.price.prices(s.id).some(function (p) { return p.active; }); });

    var tabs = CATS.map(function (c) {
      return '<button class="tab' + (c.key === S.cat ? " active" : "") + '" data-act="price-cat" data-cat="' + c.key + '">' +
        ui.icon(c.icon, 12) + " " + c.label + "</button>";
    }).join("");

    var toolbar = '<section class="card"><div class="toolbar">' +
      ui.searchField("Search by service, code or list", S.query, "price-search") +
      '<select class="select" style="max-width:190px" name="list" data-change="price-filter"><option value="all">All price lists</option>' +
      LHMS.price.lists().map(function (l) {
        return '<option value="' + l.id + '"' + (S.list === l.id ? " selected" : "") + ">" + ui.esc(l.name) + "</option>";
      }).join("") + "</select>" +
      '<select class="select" style="max-width:170px" name="status" data-change="price-filter">' +
      [["all", "Any status"], ["active", "On sale"], ["off", "Switched off"], ["expired", "Expired window"]]
        .map(function (o) { return '<option value="' + o[0] + '"' + (S.status === o[0] ? " selected" : "") + ">" + o[1] + "</option>"; }).join("") +
      "</select><span class=\"spacer\"></span>" +
      '<button class="btn sm" data-act="price-export">' + ui.icon("download", 11) + " Export CSV</button>" +
      (canEdit() ? '<button class="btn sm" data-act="price-import">' + ui.icon("file", 11) + " Bulk update</button>" : "") +
      (canEdit() ? '<button class="btn sm primary" data-act="price-new">' + ui.icon("plus", 11) + " Add new service</button>" : "") +
      "</div>" +
      (list.length ? '<div class="table-wrap"><table class="data"><thead>' + headerRow() + "</thead><tbody>" + priceRows(list) + "</tbody></table></div>"
        : ui.empty("No price records match", "Widen the filters, or add a service for this category.", "tag")) +
      '<div class="notice info mt12">' + ui.icon("shield") + "<div>" + cat.hint +
      ". Prices are read by reservations, the guest portal and the folio through one engine, so a quote and a bill cannot disagree.</div></div>" +
      "</section>";

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Price & services setup",
      sub: "Rooms, halls, restaurant and laundry in one catalogue. Changing a price never rewrites a booking or an order that was already taken.",
      actions: '<a class="btn" href="#/taxes">' + ui.icon("receipt", 14) + ' Taxes &amp; charges</a><a class="btn" href="#/activity">Audit trail</a>'
    }) +
      '<div class="kpis">' +
        ui.kpi("Services on the board", counts.length, priced.length + " with an active price", { icon: "tag", accent: "accent-navy" }) +
        ui.kpi("Price records", LHMS.price.prices().length, LHMS.price.lists().length + " lists · " + cat.label.toLowerCase(), { icon: "list" }) +
        ui.kpi("Changes logged", LHMS.price.history().length, "Every one carries a reason", { icon: "clock", accent: "accent-green" }) +
        ui.kpi("Lowest room rate", cheapestRoom(), "Standard list, before tax", { icon: "bed" }) +
        ui.kpi("Tax on a room night", effectiveRoom(), "Service charge then VAT", { icon: "receipt" }) +
      "</div>" +
      (canEdit() ? "" : '<div class="notice mb16">' + ui.icon("lock") +
        "<div><b>Read-only for your role.</b> “Configure prices” is not granted to " + ui.esc(LHMS.session.role) +
        ", so nothing here can be saved. A manager grants it under Staff &amp; permissions.</div></div>") +
      '<div class="tabs mb16">' + tabs + "</div>" +
      (focus ? focusCard(focus) : "") +
      toolbar;
  };

  function cheapestRoom() {
    var best = null;
    LHMS.price.services("room").forEach(function (svc) {
      var row = LHMS.price.baseRow(svc.id);
      if (!row) return;
      // Ranked on what each rate costs on the books: a $40 room is not cheaper
      // than a ₦60,000 one because 40 is the smaller number.
      var c = LHMS.fx.toBase(row.amount, row.currency);
      if (!c.ok) return;
      if (best === null || c.base < best.cost) best = { cost: c.base, amount: row.amount, currency: row.currency };
    });
    return best ? U.money(best.amount, best.currency) : "—";
  }

  // Arriving from a booking or a rate card, the service you came for is shown
  // with its full history before the table.
  function focusCard(svc) {
    var row = LHMS.price.baseRow(svc.id);
    var entries = LHMS.price.history(svc.id);
    var last = entries[0];
    return '<section class="card mb16"><div class="card-head"><div><div class="card-title">' + ui.icon("tag", 15) +
      " " + ui.esc(svc.name) + '</div><div class="card-sub">' + ui.esc(svc.code) + " · " + catMeta(svc.category).label + "</div></div>" +
      (row ? ui.chip(U.money(row.amount, row.currency) + " on the " + (LHMS.price.list(row.listId) || {}).name, "gold") : "") + "</div>" +
      (last ? '<div class="detail-row"><dt>Last change</dt><dd>' +
        U.money(last.from ? last.from.amount : 0, (last.from || last.to).currency) + " → " +
        U.money(last.to.amount, last.to.currency) + " by " + ui.esc(last.by) + " · " + U.pretty(String(last.at).slice(0, 10), "short") + "</dd></div>" +
        '<div class="detail-row"><dt>Reason</dt><dd>' + ui.esc(last.reason) + "</dd></div>" : "") +
      '<div class="detail-row"><dt>Taxes applied</dt><dd>' + taxSummary(svc.category) + "</dd></div></section>";
  }

  /* ============================================================
     TAXES & SERVICE CHARGES
     ============================================================ */
  LHMS.pages.taxes = function () {
    var rules = LHMS.price.rules();
    var rows = rules.map(function (r) {
      return "<tr><td><b class=\"small\">" + ui.esc(r.name) + "</b>" +
        '<div class="tiny muted">Rule ' + r.order + " · applied on the running total</div></td>" +
        '<td class="right num"><b>' + r.pct + "%</b></td>" +
        '<td>' + (r.appliesTo || []).map(function (c) { return ui.chip(catMeta(c).label, "", false); }).join(" ") + "</td>" +
        "<td>" + (r.pct > 0 ? ui.chip("Active", "green") : ui.chip("Zero — not billed", "")) + "</td>" +
        '<td class="right">' + (canEdit()
          ? '<button class="btn sm" data-act="tax-edit" data-tax="' + r.id + '">' + ui.icon("edit", 11) + " Edit</button>"
          : '<button class="btn sm ghost" data-act="tax-edit" data-tax="' + r.id + '">View</button>') + "</td></tr>";
    }).join("");

    var examples = ["room", "hall", "restaurant", "laundry"].map(function (c) {
      var ex = exampleRow(c);
      var t = LHMS.price.taxes(ex.amount, c);
      return '<div class="panel" style="background:#fff"><div class="row between"><b class="small">' + catMeta(c).label + "</b>" +
        '<span class="tiny muted">' + U.money(ex.amount, ex.currency) + " before tax</span></div>" +
        '<div class="stack" style="gap:0;margin-top:10px">' +
        t.lines.map(function (l) {
          return '<div class="detail-row"><dt>' + ui.esc(l.label) + "</dt><dd>" + U.money(l.amount, ex.currency) + "</dd></div>";
        }).join("") +
        '<div class="detail-row total"><dt>Guest pays</dt><dd>' + U.money(t.grand, ex.currency) + "</dd></div>" +
        "</div>" + (t.lines.length ? "" : '<p class="tiny muted mt8">No rule covers this category, so nothing is added.</p>') + "</div>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Financial management",
      title: "Taxes & service charges",
      sub: "The rules every department bills under. They apply in order, each on the running total, which is why VAT lands on top of the service charge.",
      actions: '<a class="btn" href="#/prices">' + ui.icon("tag", 14) + ' Price setup</a><a class="btn" href="#/activity">Audit trail</a>'
    }) +
      '<div class="kpis">' +
        rules.slice(0, 3).map(function (r, i) {
          return ui.kpi(r.name, r.pct + "%", (r.appliesTo || []).length + ((r.appliesTo || []).length === 1 ? " category" : " categories"), { icon: "receipt", accent: i === 0 ? "accent-navy" : i === 1 ? "accent-green" : "" });
        }).join("") +
        ui.kpi("Effective on a room night", effectiveRoom(), "Service then VAT", { icon: "card" }) +
        ui.kpi("Rules", rules.length, "Ordered, compounding", { icon: "list" }) +
      "</div>" +
      '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("receipt", 15) +
        'Billing rules</div><div class="card-sub">Changing a rule affects new quotes only — every posted charge keeps the amount it was billed at.</div></div>' +
        (canEdit() ? "" : ui.chip("Read-only", "")) + "</div>" +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Rule</th><th class="right">Rate</th><th>Applies to</th><th>Status</th><th class="right"></th></tr></thead><tbody>' +
        rows + "</tbody></table></div>" +
        '<div class="notice mt12">' + ui.icon("alert") + "<div>A zero rate keeps the rule on the board without billing it, so the statutory wording still appears on the folio when the rate is restored.</div></div>" +
      "</section>" +
      '<div class="grid g3 mt16">' + examples + "</div>";
  };

  // The worked example is printed in the money the catalogue actually sells that
  // category in, so a hall priced in dollars is never shown wearing a naira sign.
  function exampleRow(category) {
    var svc = LHMS.price.services(category)[0];
    var row = svc && LHMS.price.baseRow(svc.id);
    if (!row) return { amount: 0, currency: LHMS.fx.base() };
    return { amount: row.amount * (category === "hall" ? 4 : 1), currency: row.currency || LHMS.fx.base() };
  }

  function effectiveRoom() {
    var base = exampleRow("room").amount;
    var t = LHMS.price.taxes(base, "room");
    return base ? Math.round(t.total / base * 1000) / 10 + "%" : "—";
  }

  LHMS.uiActions["tax-edit"] = function (el) {
    var rule = LHMS.price.rules().filter(function (r) { return r.id === el.getAttribute("data-tax"); })[0];
    if (!rule) return;
    var editable = canEdit();
    ui.modal({
      title: rule.name,
      sub: "Rule " + rule.order + " · applied on the running total, before the next rule",
      slim: true,
      body: '<form data-form="tax-edit" id="tax-form"><input type="hidden" name="ruleId" value="' + rule.id + '" />' +
        '<div class="field"><label>Rate (%)</label><input name="pct" type="number" min="0" max="50" step="0.5" value="' + rule.pct + '"' +
        (editable ? " required" : " disabled") + " /></div>" +
        '<div class="field mt12"><label>Applies to</label>' + CATS.map(function (c) {
          return '<label class="check"><input type="checkbox" name="cat_' + c.key + '" value="' + c.key + '"' +
            ((rule.appliesTo || []).indexOf(c.key) !== -1 ? " checked" : "") + (editable ? "" : " disabled") + " /> " + c.label + "</label>";
        }).join("") + "</div>" +
        (editable ? '<div class="field mt12"><label>Reason</label><input name="reason" placeholder="Required — written to the audit trail" required /></div>' : "") +
        '<div class="notice info mt12">' + ui.icon("alert") + "<div>Quotes taken after you save will use the new rate. Posted folio lines keep theirs.</div></div>" +
        "</form>",
      footer: '<button class="btn" data-close-modal>Close</button>' +
        (editable ? '<button class="btn primary" data-act="tax-save">Save rule</button>' : "")
    });
  };

  LHMS.uiActions["tax-save"] = function () {
    var form = document.getElementById("tax-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    var cats = CATS.filter(function (c) { return d["cat_" + c.key]; }).map(function (c) { return c.key; });
    if (!cats.length) { ui.toast("A rule has to apply to at least one category.", "error"); return; }
    var result = LHMS.actions.setTaxRule(d.ruleId, { pct: d.pct, appliesTo: cats }, d.reason);
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal(); LHMS.rerender();
    ui.toast(result.rule.name + " is now " + result.rule.pct + "% for " + cats.length + " categories.");
  };
})();
