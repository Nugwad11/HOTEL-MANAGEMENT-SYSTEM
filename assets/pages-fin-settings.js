/* ============================================================
   LHMS — Financial settings and the approvals register (§9 §10)
   The four numbers every money action in this workspace reads,
   shown next to the register of changes too large for one
   signature. The page holds no rules of its own: it reads
   LHMS.financeSettings and writes through
   LHMS.actions.setFinanceSettings / decideApproval, so what a
   reader sees here is what an action enforces elsewhere.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;

  // The note typed against a request is kept across the confirmation step, and
  // across the re-render a rejected figure causes, because a wrong number should
  // not cost the desk its sentence.
  var S = { side: "waiting", notes: {}, rate: {} };

  // Each rule is listed beside the action that obeys it, because a setting nobody
  // reads is decoration, and the reader needs to know which is which.
  var RULES = [
    {
      key: "invoicePrefix", label: "Invoice prefix", kind: "text", max: 6,
      enforces: "Begins the number on every document raised here, including a split.",
      reads: "raiseInvoice · splitInvoice"
    },
    {
      key: "paymentDays", label: "Days to pay", kind: "number", min: 0, max: 90, suffix: " days",
      enforces: "Dates a document due that many days after it is raised.",
      reads: "raiseInvoice · the arrears report"
    },
    {
      key: "approvalAmount", label: "Approval limit", kind: "money", min: 0, max: 100000000,
      enforces: "Holds a price move, or a refund, wider than this for a second signature.",
      reads: "setPrice · refundInvoice"
    },
    {
      key: "discountPct", label: "Discount ceiling", kind: "pct", min: 0, max: 100, suffix: "%",
      enforces: "Holds a cut past this share of a document's total for a second signature.",
      reads: "discountInvoice"
    },
    {
      key: "rateMaxAgeDays", label: "Rate freshness", kind: "number", min: 1, max: 30, suffix: " days",
      enforces: "How long a filed exchange rate is trusted. Past it the currency cannot be sold, billed or settled.",
      reads: "setPrice · postCharge · raiseInvoice · addExpense · the night audit"
    }
  ];

  var KINDS = {
    price: { icon: "tag", word: "price change", figure: "the rate card" },
    discount: { icon: "receipt", word: "discount", figure: "the document total" },
    refund: { icon: "card", word: "refund", figure: "money already received" },
    fx: { icon: "card", word: "exchange rate", figure: "the rate table" }
  };
  function kindOf(a) { return KINDS[a.kind] || { icon: "file", word: String(a.kind), figure: "the ledger" }; }

  function valueText(rule, v) {
    if (rule.kind === "money") return U.money(v);
    return String(v) + (rule.suffix || "");
  }

  // One line per request, in the words the money will actually move in: a rate
  // card row goes from one figure to another, a concession only ever comes off.
  function figureLine(a) {
    if (a.kind === "price") {
      // The two figures a signer compares are the price row's own money; the gap
      // that tripped the limit is counted on the books, so both are said.
      return '<b class="num">' + ui.esc(U.money(a.from, a.fromCurrency)) + "</b> → <b class=\"num\">" + ui.esc(U.money(a.to, a.toCurrency)) +
        '</b> · a move of ' + ui.esc(U.money(a.amount, a.currency)) + " on the books";
    }
    if (a.kind === "refund") {
      // What leaves the till is the invoice's own figure; what the limit was
      // tested against is what that figure is worth here.
      return '<b class="num">' + ui.esc(U.money(a.to, a.toCurrency)) + "</b> back out of money already received" +
        (a.currency && a.currency !== a.toCurrency
          ? " · " + ui.esc(U.money(a.amount, a.currency)) + " on the books" : "");
    }
    if (a.kind === "fx") {
      var base = LHMS.fx.base();
      // A rate is stated the way the books read it: what one unit costs here.
      return '<b class="num">' + ui.esc(U.money(a.to, base)) + "</b> per 1 " + ui.esc(a.subjectId) +
        (a.from ? ' · moved ' + ui.esc(U.money(a.amount, base)) + " from " + ui.esc(U.money(a.from, base))
                : " · the first " + ui.esc(a.subjectId) + " rate this property holds");
    }
    return '<b class="num">−' + ui.esc(U.money(a.amount, a.currency)) + "</b> off what is owed on this document";
  }

  /* ---------------- the rules ---------------- */
  function ruleRow(r, fin, editable) {
    var value = editable
      ? '<input class="input" style="width:150px;text-align:right" name="' + r.key + '" type="' + (r.kind === "text" ? "text" : "number") + '"' +
        (r.kind === "text"
          ? ' value="' + ui.esc(fin[r.key]) + '" maxlength="' + r.max + '"'
          : ' value="' + fin[r.key] + '" min="' + r.min + '" max="' + r.max + '" step="' + (r.kind === "pct" ? "0.5" : "1") + '"') +
        " />"
      : '<b class="num">' + ui.esc(valueText(r, fin[r.key])) + "</b>";
    // A number input cannot carry a thousands separator, so the currency sits
    // beside the field instead of inside it. These limits are always counted in
    // the money the books keep, whatever the desk sells in.
    var mark = editable && r.kind === "money"
      ? '<span class="tiny muted" style="margin-right:7px">' + ui.esc(LHMS.fx.symbolOf(LHMS.fx.base()) || LHMS.fx.base()) + "</span>" : "";
    return '<div class="list-row"><div class="lr-main" style="flex:1"><div>' +
      '<div class="lr-title">' + ui.esc(r.label) + "</div>" +
      '<div class="lr-sub tiny">' + ui.esc(r.enforces) + " · read by " + ui.esc(r.reads) + "</div>" +
      '</div></div><div class="row" style="flex:none;align-items:center">' + mark + value + "</div></div>";
  }

  function rulesCard(fin, editable) {
    var rows = RULES.map(function (r) { return ruleRow(r, fin, editable); }).join("");
    var body = editable
      ? '<form id="fin-set-form" data-form="fin-settings">' + rows +
        '<div class="notice info mt12">' + ui.icon("alert") + "<div>These figures govern the <b>next</b> document or decision. " +
        "Nothing already raised is renumbered, re-dated or re-tested against a new limit.</div></div>" +
        '<div class="row mt12" style="gap:10px;align-items:center">' +
        '<button class="btn primary" data-act="fin-set-edit">' + ui.icon("shield", 14) + " Save the new rules</button>" +
        '<span class="tiny muted">Saved under your name, in the audit trail.</span></div></form>'
      : "<div>" + rows + "</div>" +
        '<div class="notice mt12">' + ui.icon("lock") + "<div>Your role reads these rules and works inside them; rewriting them " +
        "belongs to the finance side of the house.</div></div>";
    return ui.sectionCard("The rules this property works to", body, "",
      "Four numbers, each read by an action somewhere else", "settings");
  }

  /* ---------------- the rates ---------------- */
  // A rate is not decoration: while a currency cannot be valued, the catalogue
  // row in it cannot be sold, the folio in it cannot be posted and the invoice in
  // it cannot be raised. This card is where the desk sees that, in those words.
  var STATE_CHIP = { fresh: "green", stale: "amber", missing: "red" };
  var STATE_WORD = { fresh: "usable", stale: "out of date", missing: "not on file" };

  function rateRow(st, soldIn, base, inBanner) {
    var age = st.ageDays === null || st.ageDays === undefined ? "—" :
      st.ageDays + " day" + (st.ageDays === 1 ? "" : "s");
    return '<div class="list-row"><div class="lr-main" style="flex:1">' +
      '<div class="lr-title">' + ui.esc(st.code) +
      ' <span class="tiny muted">' + ui.esc(LHMS.fx.nameOf(st.code) || "") + "</span>" +
      (soldIn ? ' <span class="chip gold">sold on the rate card</span>' : "") + "</div>" +
      '<div class="lr-sub tiny">' + (st.state === "missing"
        ? "No " + ui.esc(st.code) + " rate has ever been filed here."
        : "1 " + ui.esc(st.code) + " = <b class=\"num\">" + ui.esc(U.money(st.rate, base)) + "</b> · filed " +
          ui.esc(U.pretty(st.effective, "medium")) + " · " + age + " old · by " + ui.esc(st.setBy || "—")) + "</div>" +
      (st.note ? '<div class="lr-sub tiny muted">' + ui.esc(st.note) + "</div>" : "") +
      (st.error && !inBanner ? '<div class="lr-sub tiny">' + ui.esc(st.error) + "</div>" : "") +
      "</div>" +
      '<div style="flex:none"><span class="chip ' + (STATE_CHIP[st.state] || "") + '">' +
      ui.esc(STATE_WORD[st.state] || st.state) + "</span></div></div>";
  }

  function rateForm(base, day) {
    var d = S.rate || {};
    var rest = LHMS.fx.currencies.filter(function (c) { return c.code !== base; });
    var options = rest.map(function (c) {
      return '<option value="' + c.code + '"' + (d.code === c.code ? " selected" : "") + ">" +
        ui.esc(c.code + " — " + c.name) + "</option>";
    }).join("");
    return '<form id="fx-form" data-form="fx" class="row mt12" style="gap:10px;align-items:flex-end;flex-wrap:wrap">' +
      '<div class="field" style="flex:1 1 170px"><label>Currency</label><select class="input" name="code">' + options + "</select></div>" +
      '<div class="field" style="flex:1 1 150px"><label>' + ui.esc(base) + " per 1 unit</label>" +
      '<input class="input" style="text-align:right" name="perBase" type="number" min="0.01" step="0.01" required ' +
      'value="' + ui.esc(d.perBase || "") + '" placeholder="1550" /></div>' +
      '<div class="field" style="flex:1 1 150px"><label>Effective from</label>' +
      '<input class="input" name="effective" type="date" required max="' + ui.esc(day) + '" value="' +
      ui.esc(d.effective || day) + '" /></div>' +
      '<div class="field" style="flex:2 1 220px"><label>Where it came from</label>' +
      '<input class="input" name="note" required maxlength="120" value="' + ui.esc(d.note || "") +
      '" placeholder="Group treasury fixing, 09:30" /></div>' +
      '<div style="flex:none"><button class="btn primary" data-act="fx-file">' + ui.icon("card", 14) + " File the rate</button></div>" +
      "</form>";
  }

  function ratesCard(editable) {
    var base = LHMS.fx.base(), day = LHMS.db.meta.day, maxAge = LHMS.fx.maxAge();
    var sold = LHMS.fx.inCatalogue();
    var states = LHMS.fx.currencies.filter(function (c) { return c.code !== base; })
      .map(function (c) {
        var st = LHMS.fx.state(c.code);
        var row = LHMS.fx.rates().filter(function (r) { return r.code === c.code; })[0];
        st.note = row ? row.note : null;
        return st;
      });
    var blocked = states.filter(function (st) { return !st.usable && sold.indexOf(st.code) !== -1; });
    var body = "<div>" + states.map(function (st) {
      return rateRow(st, sold.indexOf(st.code) !== -1, base,
        blocked.indexOf(st) !== -1);
    }).join("") + "</div>";
    if (blocked.length) {
      body = '<div class="notice danger">' + ui.icon("alert") + "<div>" +
        blocked.map(function (st) { return ui.esc(st.code); }).join(" and ") +
        " is sold on the rate card but cannot be valued — " +
        ui.esc(blocked[0].error) + "</div></div>" + body;
    }
    body += editable
      ? rateForm(base, day) +
        '<p class="tiny muted mt8">A rate reprices what the property holds in that currency from this day forward. ' +
        "Nothing already billed is re-converted: every document keeps the rate it was raised at.</p>"
      : '<div class="notice mt12">' + ui.icon("lock") + "<div>Your role reads these rates and works inside them. Filing one " +
        "belongs to the finance side of the house, and a rate a desk cannot sign for waits in the register below.</div></div>";
    return ui.sectionCard("Exchange rates", body, "",
      "Filed in " + ui.esc(base) + " · trusted for " + maxAge + " day" + (maxAge === 1 ? "" : "s") + " · the business date is " +
      ui.esc(U.pretty(day, "medium")), "card");
  }

  /* ---------------- one request ---------------- */
  function requestRow(a, canClear) {
    var k = kindOf(a);
    var mine = a.requestedBy === LHMS.session.name;
    var pending = a.status === "Pending";
    var right;
    if (!pending) {
      right = '<span class="chip ' + (a.status === "Approved" ? "green" : "amber") + '">' + ui.esc(a.status) + "</span>";
    } else if (!canClear) {
      right = '<span class="chip amber">waits for ' + (mine ? "another hand" : "the finance side") + "</span>";
    } else {
      right = '<div class="row" style="gap:6px">' +
        '<button class="btn sm primary" data-act="apr-approve" data-apr="' + a.id + '">' + ui.icon("checkCircle", 12) + " Approve</button>" +
        '<button class="btn sm danger" data-act="apr-reject" data-apr="' + a.id + '">Send back</button></div>';
    }

    var note = pending && canClear
      ? '<div class="field mt8"><label>Your note for the trail</label>' +
        '<input class="input" id="apr-note-' + a.id + '" placeholder="Required — who signed, and why" value="' +
        ui.esc(S.notes[a.id] || "") + '" /></div>'
      : "";

    return '<div class="list-row"><div class="lr-main" style="flex:1"><span class="avatar sm">' + ui.icon(k.icon, 14) + "</span>" +
      "<div>" +
      '<div class="lr-title">' + ui.esc(a.subject) + "</div>" +
      '<div class="lr-sub">' + figureLine(a) + "</div>" +
      '<div class="lr-sub">' + ui.esc(a.reason) + "</div>" +
      '<div class="lr-sub tiny">Asked by ' + ui.esc(a.requestedBy) + " · " + U.pretty(String(a.requestedAt).slice(0, 10), "medium") +
      (pending ? "" : " · " + ui.esc(a.status) + " by " + ui.esc(a.decidedBy) + " · " + ui.esc(a.decisionNote || "no note written")) +
      "</div></div></div>" +
      '<div style="flex:none">' + right + "</div></div>" + note;
  }

  function queueCard() {
    var canClear = LHMS.canApproveFinancial();
    var pending = LHMS.approvals("Pending");
    var decided = LHMS.approvals().filter(function (a) { return a.status !== "Pending"; });
    var list = S.side === "waiting" ? pending : decided;

    var tabs = '<div class="row" style="gap:6px">' +
      '<button class="btn sm ' + (S.side === "waiting" ? "soft" : "ghost") + '" data-act="apr-side" data-side="waiting">Waiting' +
      (pending.length ? " (" + pending.length + ")" : "") + "</button>" +
      '<button class="btn sm ' + (S.side === "decided" ? "soft" : "ghost") + '" data-act="apr-side" data-side="decided">Decided' +
      (decided.length ? " (" + decided.length + ")" : "") + "</button></div>";

    var body = list.length
      ? '<div>' + list.map(function (a) { return requestRow(a, canClear); }).join("") + "</div>"
      : S.side === "waiting"
        ? ui.empty("Nothing waits", "Every change made here has fallen inside the limits the property sets, " +
          "or has already been signed off.", "shield")
        : ui.empty("No decisions yet", "A request stays in this register after it is cleared, so the trail keeps both " +
          "the question and the answer.", "clock");

    if (S.side === "waiting" && pending.length && !canClear) {
      body += '<p class="tiny muted mt12">You can read what waits and why. Clearing it belongs to a role holding the right ' +
        "to sign off a financial change, and never to the person who asked.</p>";
    }
    return ui.sectionCard("Approvals register", body, tabs,
      pending.length + " waiting · " + decided.length + " decided at this property", "shield");
  }

  /* ---------------- the reading side ---------------- */
  function whyCard(fin) {
    return ui.sectionCard("Why a change waits", '<div>' +
      '<div class="detail-row"><dt>A price move</dt><dd>over <b class="num">' + ui.esc(U.money(fin.approvalAmount)) +
      "</b> from the figure on the row</dd></div>" +
      '<div class="detail-row"><dt>A refund</dt><dd>over <b class="num">' + ui.esc(U.money(fin.approvalAmount)) +
      "</b> of money already held</dd></div>" +
      '<div class="detail-row"><dt>A discount</dt><dd>past <b class="num">' + fin.discountPct + "%</b> of the document total</dd></div>" +
      '<div class="detail-row"><dt>An exchange rate</dt><dd>filed by a hand that cannot also sign its own change</dd></div>' +
      '<div class="detail-row"><dt>Anything under those</dt><dd>is applied at once, and still stamped in the trail</dd></div>' +
      "</div>" +
      '<div class="notice mt12">' + ui.icon("shield") + "<div>A held change writes nothing: the rate card, the document and the " +
      "ledger stay as they were until a second signature falls. If the figure moves while it waits, the request is refused rather " +
      "than forced through.</div></div>",
      "", "The thresholds the desk works inside · a money limit is counted in " +
      ui.esc(LHMS.fx.base()) + ", whatever money the change itself is billed in", "lock");
  }

  var RIGHTS = [
    { perm: "configure_prices", label: "Change a price" },
    { perm: "manage_billing", label: "Invoice, adjust or refund" },
    { perm: "manage_financial_settings", label: "Rewrite these rules" },
    { perm: "approve_financial_changes", label: "Sign off a held change" },
    { perm: "view_reports", label: "Read the financial reports" }
  ];
  function rightsCard() {
    return ui.sectionCard("Your rights here", '<div>' + RIGHTS.map(function (r) {
      var held = LHMS.can(r.perm);
      return '<div class="list-row"><div class="lr-main" style="flex:1"><div>' +
        '<div class="lr-title">' + ui.esc(r.label) + '</div><div class="lr-sub tiny">' + ui.esc(r.perm) + "</div></div></div>" +
        '<span class="chip ' + (held ? "green" : "") + '">' + (held ? "allowed" : "not for this role") + "</span></div>";
    }).join("") + "</div>", "",
      "Signed in as " + ui.esc(LHMS.session.name) + " · " + ui.esc(LHMS.session.role), "shield");
  }

  /* ---------------- the page ---------------- */
  LHMS.pages["fin-settings"] = function () {
    var fin = LHMS.financeSettings();
    var pending = LHMS.approvals("Pending");
    var sent = LHMS.approvals().filter(function (a) { return a.status === "Rejected"; }).length;
    var signed = LHMS.approvals().filter(function (a) { return a.status === "Approved"; }).length;
    var editable = LHMS.can("manage_financial_settings");
    var tradable = LHMS.fx.currencies.filter(function (c) { return c.code !== LHMS.fx.base(); });
    var stale = tradable.filter(function (c) { return !LHMS.fx.state(c.code).usable; }).length;

    return ui.pageHead({
      eyebrow: "Financial management · the rules and the second signature",
      title: "Financial settings & approvals",
      sub: "Documents raised here are numbered <b>" + ui.esc(fin.invoicePrefix) + "-INV-0000</b> and fall due " + fin.paymentDays +
        " days later. A change wider than <b class=\"num\">" + ui.esc(U.money(fin.approvalAmount)) + "</b>, or a discount past <b>" +
        fin.discountPct + "%</b> of a total, waits here for a signature that is not the asker's own.",
      actions: '<a class="btn" href="#/fin-audit">' + ui.icon("clock", 14) + " Audit trail</a>" +
        '<a class="btn" href="#/fin-reports">' + ui.icon("file", 14) + " Reports</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Waiting now", pending.length, pending.length ? "Held for a second signature" : "Nothing crosses a limit", { icon: "shield" }) +
        ui.kpi("Signed off", signed, "Applied by a second hand", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Sent back", sent, "Kept in the register, applied nowhere", { icon: "alert", accent: sent ? "accent-red" : "" }) +
        ui.kpi("Approval limit", U.money(fin.approvalAmount), "Wider than this it waits · in " + LHMS.fx.base(), { icon: "card", accent: "accent-navy" }) +
        ui.kpi("Discount ceiling", fin.discountPct + "%", "Of a document total", { icon: "receipt" }) +
        ui.kpi("Rates to refresh", stale, stale ? "Those currencies cannot be sold or settled" : "Every currency here is valued", { icon: "card", accent: stale ? "accent-red" : "accent-green" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        "<div class=\"stack\">" + rulesCard(fin, editable) + ratesCard(editable) + queueCard() + "</div>" +
        '<div class="stack">' + whyCard(fin) + rightsCard() +
          ui.sectionCard("The trail behind this page", '<div>' +
            '<div class="detail-row"><dt>Requests</dt><dd>who asked, the figure, the reason</dd></div>' +
            '<div class="detail-row"><dt>Decisions</dt><dd>who signed, and the note they wrote</dd></div>' +
            '<div class="detail-row"><dt>Applied changes</dt><dd>write the history an ungated change would</dd></div></div>' +
            '<a class="btn mt12 block soft" href="#/activity">' + ui.icon("clock", 14) + " Read the full log</a>",
            "", "Nothing on this page is edited after the fact", "file") +
        "</div>" +
      "</div>";
  };

  /* ---------------- actions ---------------- */
  LHMS.uiActions["apr-side"] = function (el) {
    S.side = el.getAttribute("data-side");
    LHMS.rerender();
  };

  function findRequest(id) {
    return LHMS.approvals().filter(function (a) { return a.id === id; })[0];
  }

  function noteFor(id) {
    var el = document.getElementById("apr-note-" + id);
    return el ? String(el.value || "").trim() : "";
  }

  LHMS.uiActions["apr-approve"] = function (el) {
    var a = findRequest(el.getAttribute("data-apr"));
    if (!a) return;
    var note = noteFor(a.id);
    if (!note) {
      S.notes[a.id] = note;
      ui.toast("Write a note first — a signature without one cannot be audited.", "error");
      LHMS.rerender();
      return;
    }
    S.notes[a.id] = note;
    var k = kindOf(a);
    ui.confirm({
      title: "Sign off this change?",
      sub: k.word + " · " + a.subject,
      body: "Approving applies " + U.money(a.amount, a.currency) + " of movement to " + k.figure + " now, in your name, against the note: " + note,
      label: "Approve and apply",
      id: "apr-yes-" + a.id
    });
  };

  LHMS.uiActions["apr-reject"] = function (el) {
    var a = findRequest(el.getAttribute("data-apr"));
    if (!a) return;
    var note = noteFor(a.id);
    if (!note) { ui.toast("Say why it is going back — the desk reads that note.", "error"); return; }
    var res = LHMS.actions.decideApproval(a.id, false, note);
    if (!res.ok) { ui.toast(res.error, "error"); return; }
    delete S.notes[a.id];
    ui.toast("Sent back. Nothing was applied, and the reason is in the trail.");
    LHMS.rerender();
  };

  LHMS.uiActions["fin-set-edit"] = function () {
    var form = document.getElementById("fin-set-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    ui.confirm({
      title: "Rewrite the rules this property works to?",
      body: "From the next document: numbers begin " + LHMS.sanitizePrefix(d.invoicePrefix) + "-INV, terms run " +
        d.paymentDays + " days, a price move or refund over " + U.money(Number(d.approvalAmount)) +
        " waits for a second signature, so does a discount past " + d.discountPct +
        "% of a total, and a filed exchange rate is trusted for " + d.rateMaxAgeDays + " days.",
      label: "Save the new rules",
      id: "fin-set-save"
    });
  };

  function saveSettings() {
    var form = document.getElementById("fin-set-form");
    if (!form) return;
    var d = Object.fromEntries(new FormData(form));
    var res = LHMS.actions.setFinanceSettings({
      invoicePrefix: d.invoicePrefix, paymentDays: d.paymentDays,
      approvalAmount: d.approvalAmount, discountPct: d.discountPct, rateMaxAgeDays: d.rateMaxAgeDays
    });
    ui.closeModal();
    if (!res.ok) { ui.toast(res.error, "error"); return; }
    ui.toast("Rules saved — " + res.changed.join(" · ") + ".");
    LHMS.rerender();
  }

  // Filing a rate is a decision about what every foreign figure is worth, so it
  // is confirmed in words before it is written — and held for a second signature
  // when the hand filing it cannot also sign it off.
  LHMS.uiActions["fx-file"] = function () {
    var form = document.getElementById("fx-form");
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    S.rate = { code: d.code, perBase: d.perBase, effective: d.effective, note: d.note };
    var was = LHMS.fx.state(d.code);
    ui.confirm({
      title: "File this " + d.code + " rate?",
      body: "1 " + d.code + " = " + U.money(Number(d.perBase), LHMS.fx.base()) + " from " + U.pretty(d.effective, "medium") +
        (was.rate ? ". The figure on file now is " + U.money(was.rate, LHMS.fx.base()) +
          ", so every foreign price, bill and cost the property holds moves with it."
          : ". Nothing has been filed for " + d.code + " here before, so this is the first rate these books can value it at.") +
        " The trail reads: " + d.note + ".",
      label: "File the rate",
      id: "fx-save"
    });
  };

  function saveRate() {
    var form = document.getElementById("fx-form");
    if (!form) return;
    var d = Object.fromEntries(new FormData(form));
    var res = LHMS.actions.setFxRate({ code: d.code, perBase: d.perBase, effective: d.effective, note: d.note });
    ui.closeModal();
    if (!res.ok) { ui.toast(res.error, "error"); return; }
    if (res.queued) {
      ui.toast("Filed — it waits in the register for a signature that is not your own.");
    } else {
      ui.toast("1 " + res.rate.code + " = " + U.money(res.rate.perBase, LHMS.fx.base()) + " is now the rate these books value at.");
    }
    S.rate = {};
    LHMS.rerender();
  }

  // The confirmation carries the decision: the note survives the modal, and the
  // action runs only when the second click arrives.
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-confirm]");
    if (!btn) return;
    var id = btn.getAttribute("data-confirm");
    if (id === "fin-set-save") { saveSettings(); return; }
    if (id === "fx-save") { saveRate(); return; }
    if (id.indexOf("apr-yes-") !== 0) return;
    var approval = id.slice("apr-yes-".length);
    var res = LHMS.actions.decideApproval(approval, true, S.notes[approval] || "");
    ui.closeModal();
    if (!res.ok) { ui.toast(res.error, "error"); return; }
    delete S.notes[approval];
    ui.toast("Signed off — the " + kindOf(res.approval).word + " is applied to " + kindOf(res.approval).figure + ", in your name.");
    LHMS.rerender();
  });
})();
