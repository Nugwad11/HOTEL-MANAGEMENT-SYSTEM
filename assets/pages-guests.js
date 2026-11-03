/* ============================================================
   Guests — directory and the single guest profile
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var S = (LHMS.state = LHMS.state || {});

  if (S.guestQuery == null) S.guestQuery = "";
  if (S.guestTier == null) S.guestTier = "all";
  if (S.guestSort == null) S.guestSort = "name";
  if (S.guestTab == null) S.guestTab = "stays";

  function tierTone(tier) {
    return tier === "Platinum" ? "gold" : tier === "Gold" ? "amber" : tier === "Silver" ? "navy" : "";
  }

  function initialsAvatar(g, size) {
    return '<span class="avatar ' + (size || "") + '">' + U.initials(g ? g.name : "Guest") + "</span>";
  }

  function lastStayOf(guestId) {
    var stays = LHMS.db.reservations.filter(function (r) { return r.guestId === guestId && r.status === "Checked out"; });
    stays.sort(function (a, b) { return a.checkOut < b.checkOut ? 1 : -1; });
    return stays[0] || null;
  }

  function staysOf(guestId) {
    return LHMS.db.reservations.filter(function (r) { return r.guestId === guestId; })
      .sort(function (a, b) { return a.checkIn < b.checkIn ? 1 : -1; });
  }

  /* ============================================================
     DIRECTORY
     ============================================================ */
  LHMS.pages.guests = function (route) {
    if (route && route.sub) return guestProfile(route.sub);

    var all = LHMS.db.guests.slice();
    var counts = {
      platinum: all.filter(function (g) { return g.tier === "Platinum"; }).length,
      gold: all.filter(function (g) { return g.tier === "Gold"; }).length,
      marketing: all.filter(function (g) { return g.consent && g.consent.marketing; }).length,
      inHouse: LHMS.calc.inHouse().length
    };
    var list = all.slice();
    if (S.guestTier !== "all") list = list.filter(function (g) { return g.tier === S.guestTier; });
    if (S.guestQuery) {
      var q = S.guestQuery.toLowerCase();
      list = list.filter(function (g) {
        return (g.name + " " + g.email + " " + g.phone + " " + g.country + " " + (g.job || "")).toLowerCase().indexOf(q) !== -1;
      });
    }
    var statsCache = {};
    list.forEach(function (g) { statsCache[g.id] = LHMS.calc.guestStats(g.id); });
    if (S.guestSort === "spend") list.sort(function (a, b) { return statsCache[b.id].spend - statsCache[a.id].spend; });
    else if (S.guestSort === "recent") {
      list.sort(function (a, b) {
        var la = statsCache[a.id].last, lb = statsCache[b.id].last;
        return (lb ? lb.checkIn : "") < (la ? la.checkIn : "") ? -1 : 1;
      });
    } else list.sort(function (a, b) { return a.name.localeCompare(b.name); });

    var rows = list.map(function (g) {
      var st = statsCache[g.id];
      var last = st.last;
      return '<tr class="clickable" data-act="open-guest" data-guest="' + g.id + '">' +
        '<td><div class="who">' + initialsAvatar(g) + '<div style="min-width:0"><div class="who-name">' + ui.esc(g.name) + (g.tier === "Platinum" ? ' <span class="vip">VIP</span>' : "") + '</div><div class="who-sub">' + ui.esc(g.job || g.country) + "</div></div></div></td>" +
        '<td><div class="small">' + ui.esc(g.email) + '</div><div class="tiny muted">' + ui.esc(g.phone) + "</div></td>" +
        "<td>" + ui.tierChip(g.tier) + '<div class="tiny muted" style="margin-top:3px">' + ui.esc(g.country) + "</div></td>" +
        '<td class="num">' + st.stays + '<div class="tiny muted">' + st.nights + " nights</div></td>" +
        "<td>" + (last ? U.pretty(last.checkOut, "short") + '<div class="tiny muted">Room ' + ui.roomNo(last.roomId) + "</div>" : '<span class="muted">No completed stay</span>') + "</td>" +
        '<td class="num">' + U.compact(st.spend) + "</td>" +
        "<td>" + (g.consent && g.consent.marketing ? '<span class="chip green">Opted in</span>' : '<span class="chip">No marketing</span>') + "</td>" +
        '<td class="right">' + ui.icon("right", 13) + "</td></tr>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Guest experience · one profile across every property",
      title: "Guest directory",
      sub: "Preferences, allergies, consent and stay history travel with the guest between Lagos and Abuja. " + all.length + " profiles on file.",
      actions: '<button class="btn" data-act="export-guests">' + ui.icon("download", 14) + ' Export</button><button class="btn primary" data-act="new-guest">' + ui.icon("userPlus", 14) + " New guest</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Guest profiles", all.length, "Across all properties", { icon: "users", accent: "accent-navy" }) +
        ui.kpi("Platinum", counts.platinum, "Highest recognition tier", { icon: "star", accent: "accent-green" }) +
        ui.kpi("Gold", counts.gold, "Priority arrivals", { icon: "star" }) +
        ui.kpi("In residence", counts.inHouse, "Currently in house", { icon: "bed" }) +
        ui.kpi("Marketing consent", Math.round(counts.marketing / Math.max(1, all.length) * 100) + "<small>%</small>", counts.marketing + " opted in · NDPR", { icon: "shield" }) +
      "</div>" +
      '<section class="card follow">' +
        '<div class="toolbar">' +
          ui.searchField("Search by name, email, phone or company", S.guestQuery, "guest-search") +
          '<select class="select" style="max-width:150px" data-change="guest-tier"><option value="all">All tiers</option>' +
            ["Platinum", "Gold", "Silver", "Member"].map(function (t) { return '<option' + (S.guestTier === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select>" +
          '<select class="select" style="max-width:160px" data-change="guest-sort"><option value="name"' + (S.guestSort === "name" ? " selected" : "") + '>Name A–Z</option><option value="recent"' + (S.guestSort === "recent" ? " selected" : "") + '>Most recent stay</option><option value="spend"' + (S.guestSort === "spend" ? " selected" : "") + ">Lifetime value</option></select>" +
          '<span class="spacer"></span><span class="tiny muted">' + list.length + " profiles</span>" +
        "</div>" +
        (list.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Guest</th><th>Contact</th><th>Tier</th><th>Stays</th><th>Last stay</th><th class="right">Lifetime</th><th>Consent</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : ui.empty("No guests match", "Try a different search or tier.", "users")) +
      "</section>" +
      '<div class="grid g3 mt16">' +
        ui.sectionCard("Recognition tiers", '<div class="stack" style="gap:8px">' +
          '<div class="row between"><span>' + ui.tierChip("Platinum") + '</span><span class="tiny muted">4+ stays · suite upgrades</span></div>' +
          '<div class="row between"><span>' + ui.tierChip("Gold") + '</span><span class="tiny muted">2+ stays · late checkout</span></div>' +
          '<div class="row between"><span>' + ui.tierChip("Silver") + '</span><span class="tiny muted">First repeat stay</span></div>' +
          '<div class="row between"><span>' + ui.tierChip("Member") + '</span><span class="tiny muted">New profile</span></div>' +
          '<p class="tiny muted">Tier is recalculated on every checkout across the group.</p></div>', "", "Shared across all three hotels", "star") +
        ui.sectionCard("Preference coverage", '<div class="stack">' +
          ["pillow", "room", "dietary", "allergies"].map(function (k) {
            var filled = all.filter(function (g) { return g.preferences && g.preferences[k] && !/^(No preference|No restrictions|None)$/.test(g.preferences[k]); }).length;
            return '<div><div class="row between" style="margin-bottom:4px"><span class="small strong">' + U.titleCase(k) + '</span><span class="tiny muted">' + filled + " / " + all.length + '</span></div><div class="progress"><span style="width:' + (filled / Math.max(1, all.length) * 100) + '%"></span></div></div>';
          }).join("") +
          "</div>", "", "Profiles with a recorded preference", "sparkles") +
        ui.sectionCard("Data protection", '<p class="muted small" style="line-height:1.7">Marketing consent, data-sharing and profiling are held per guest. Erasure requests are logged in the audit trail and actioned within 30 days.</p><div class="notice info mt12">' + ui.icon("shield") + "<div>Guest data is processed under NDPR and GDPR. Access is limited by role.</div></div>", "", "NDPR &amp; GDPR", "shield") +
      "</div>";
  };

  /* ============================================================
     GUEST PROFILE
     ============================================================ */
  function guestProfile(guestId) {
    var g = LHMS.get.guest(guestId);
    if (!g) return ui.pageHead({ eyebrow: "Guest", title: "Profile not found" }) + ui.empty("No guest with that record", "Return to the directory and choose a profile.", "users");
    var st = LHMS.calc.guestStats(g.id);
    var stays = staysOf(g.id);
    var active = stays.filter(function (r) { return r.status === "In-house"; })[0];
    var upcoming = stays.filter(function (r) { return r.status === "Confirmed" && r.checkIn >= LHMS.day; });
    var last = lastStayOf(g.id);
    var room = active ? LHMS.get.room(active.roomId) : null;
    var notes = g.notes || [];

    var stayRows = stays.slice(0, 12).map(function (r) {
      var f = LHMS.folio(r.id);
      return '<tr class="clickable" data-act="open-res" data-res="' + r.id + '">' +
        '<td class="mono">' + r.reference + "</td>" +
        '<td><span class="room-no">' + ui.roomNo(r.roomId) + '</span><div class="tiny muted">' + ui.esc(ui.typeName(r.roomTypeId)) + "</div></td>" +
        "<td>" + U.pretty(r.checkIn, "short") + " → " + U.pretty(r.checkOut, "short") + '<div class="tiny muted">' + U.nights(r.checkIn, r.checkOut) + " nights</div></td>" +
        "<td>" + ui.resStatus(r.status) + "</td>" +
        '<td class="right num">' + U.money(f.total, f.currency) + "</td>" +
        '<td class="right">' + ui.icon("right", 12) + "</td></tr>";
    }).join("");

    var tabs = [
      { k: "stays", label: "Stay history", n: stays.length },
      { k: "notes", label: "Notes", n: notes.length },
      { k: "preferences", label: "Preferences", n: null }
    ].map(function (t) {
      return '<button class="tab' + (S.guestTab === t.k ? " active" : "") + '" data-act="guest-tab" data-tab="' + t.k + '">' + t.label + (t.n != null ? '<span class="count">' + t.n + "</span>" : "") + "</button>";
    }).join("");

    var tabBody = "";
    if (S.guestTab === "stays") {
      tabBody = stays.length ? '<div class="table-wrap"><table class="data mini"><thead><tr><th>Reference</th><th>Room</th><th>Dates</th><th>Status</th><th class="right">Folio</th><th></th></tr></thead><tbody>' + stayRows + "</tbody></table></div>" : ui.empty("No stays yet", "This guest has not completed a stay with Aurelia.", "calendar");
    } else if (S.guestTab === "notes") {
      tabBody = '<div class="stack" style="gap:10px">' +
        '<form data-form="guest-note" class="row" style="gap:8px"><input type="hidden" name="guestId" value="' + g.id + '" /><input class="input" name="note" placeholder="Add a preference, incident or service note…" required /><button class="btn primary sm" type="submit">Add note</button></form>' +
        (notes.length ? '<div class="list">' + notes.map(function (n) {
          return '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("message", 12) + '</span><div><div class="lr-title">' + ui.esc(n.text) + '</div><div class="lr-sub">' + ui.esc(n.by) + " · " + U.pretty(n.date, "medium") + "</div></div></div></div>";
        }).join("") + "</div>" : '<p class="muted small">No notes on file. Notes are visible to front office, housekeeping and F&amp;B supervisors.</p>') +
      "</div>";
    } else {
      var pref = g.preferences || {};
      tabBody = '<div class="grid g2" style="gap:10px">' +
        [["Pillow", pref.pillow], ["Room", pref.room], ["Dietary", pref.dietary], ["Allergies", pref.allergies], ["Beverage", pref.beverage], ["Newspaper", pref.newspaper], ["Turndown", pref.turndown], ["Language", g.language]].map(function (p) {
          return '<div class="preference"><span>' + ui.esc(p[0]) + '</span><b style="' + (p[0] === "Allergies" && p[1] !== "None" ? "color:var(--red)" : "") + '">' + ui.esc(p[1] || "—") + "</b></div>";
        }).join("") +
      "</div>" +
      '<div class="notice info mt16">' + ui.icon("sparkles") + "<div><b>Preference sharing.</b> These details are available to housekeeping, F&amp;B and the spa at every Aurelia property. Allergy flags appear on all service tickets.</div></div>";
    }

    var consentRow = function (key, label, note) {
      return '<label class="check" style="justify-content:space-between;width:100%;padding:8px 0;border-bottom:1px solid var(--line-2)"><span><b>' + label + '</b><br/><span class="tiny muted">' + note + "</span></span><input type=\"checkbox\" data-guest-consent=\"" + key + "\" data-guest=\"" + g.id + "\"" + (g.consent && g.consent[key] ? " checked" : "") + " /></label>";
    };

    return ui.pageHead({
      eyebrow: "Guest profile · " + g.tier + " · since " + g.since,
      title: g.name,
      sub: ui.esc(g.job || "Guest") + " · " + ui.esc(g.country) + " · " + ui.esc(g.email),
      actions: '<button class="btn" data-act="guest-export" data-guest="' + g.id + '">' + ui.icon("download", 14) + ' Download data</button><button class="btn" data-act="edit-guest" data-guest="' + g.id + '">' + ui.icon("edit", 14) + ' Edit profile</button>' +
        (active ? '<a class="btn" href="#/folio/' + active.id + '">' + ui.icon("receipt", 14) + ' Open folio</a>' : "") +
        '<a class="btn primary" href="#/booking/new">' + ui.icon("plus", 14) + " New booking</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Completed stays", st.stays, '<span class="chip gold">' + ui.esc(g.tier) + "</span> tier", { icon: "bed", accent: "accent-navy" }) +
        ui.kpi("Nights stayed", st.nights, "Across the group", { icon: "calendar" }) +
        ui.kpi("Lifetime value", U.compact(st.spend, LHMS.fx.base()), "Folio value incl. taxes, folded into " + LHMS.fx.base(), { icon: "card", accent: "accent-green" }) +
        ui.kpi("Loyalty points", (g.loyaltyPoints || 0).toLocaleString("en-NG"), "Redeemable against future stays", { icon: "star" }) +
        ui.kpi("Last visit", last ? U.pretty(last.checkOut, "short") : "—", last ? "Room " + ui.roomNo(last.roomId) : "No completed stay", { icon: "clock" }) +
      "</div>" +
      (active ? '<div class="banner mb16"><div style="position:relative;z-index:1;flex:1"><p class="card-eyebrow" style="color:var(--gold-2)">In residence</p><h3>Room ' + (room ? room.number : "—") + " · " + ui.esc(ui.typeName(active.roomTypeId)) + '</h3><p>' + U.pretty(active.checkIn, "medium") + " to " + U.pretty(active.checkOut, "medium") + " · " + U.nights(active.checkIn, active.checkOut) + ' nights · folio balance ' + U.money(LHMS.folio(active.id).balance, LHMS.folio(active.id).currency) + ".</p><div class=\"row mt12\" style=\"position:relative;z-index:1\"><a class=\"btn sm\" href=\"#/folio/" + active.id + '">Open folio</a><a class="btn sm" href="#/check-out">Departures</a></div></div></div>' : "") +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 330px;gap:16px;align-items:start">' +
        '<div class="stack">' +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("sparkles", 15) + 'Profile intelligence</div><div class="card-sub">Everything the team needs to personalise the next stay.</div></div><div class="tabs">' + tabs + "</div></div>" + tabBody + "</section>" +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("star", 15) + 'Service notes</div><div class="card-sub">Shared with the butler desk and department heads.</div></div><button class="btn sm" data-act="guest-note-modal" data-guest="' + g.id + '">Add note</button></div>' +
            (notes.length ? '<div class="list">' + notes.slice(0, 4).map(function (n) {
              return '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("message", 12) + '</span><div><div class="lr-title">' + ui.esc(n.text) + '</div><div class="lr-sub">' + ui.esc(n.by) + " · " + U.pretty(n.date, "short") + "</div></div></div></div>";
            }).join("") + "</div>" : '<p class="muted small">No notes on file.</p>') +
          "</section>" +
        "</div>" +
        '<div class="stack">' +
          '<section class="card"><div class="row" style="align-items:flex-start">' + initialsAvatar(g, "lg") + '<div style="min-width:0"><div class="who-name" style="font-size:15px">' + ui.esc(g.name) + '</div><div class="who-sub">' + ui.esc(g.job || g.country) + '</div><div class="mt8">' + ui.tierChip(g.tier) + '</div></div></div>" +' +
            '<div class="detail-row mt16"><dt>Email</dt><dd style="word-break:break-all">' + ui.esc(g.email) + "</dd></div>" +
            '<div class="detail-row"><dt>Phone</dt><dd>' + ui.esc(g.phone) + "</dd></div>" +
            '<div class="detail-row"><dt>Country</dt><dd>' + ui.esc(g.country) + "</dd></div>" +
            '<div class="detail-row"><dt>City</dt><dd>' + ui.esc(g.city || "—") + "</dd></div>" +
            '<div class="detail-row"><dt>ID</dt><dd>' + ui.esc(g.idType || "—") + "</dd></div>" +
            '<div class="detail-row"><dt>ID number</dt><dd class="mono">' + ui.esc(g.idNumber || "—") + "</dd></div>" +
          "</section>" +
          '<section class="card"><div class="card-title">' + ui.icon("shield", 14) + 'Consent &amp; privacy</div><div class="mt12">' +
            consentRow("marketing", "Marketing", "Email and offers from Aurelia") +
            consentRow("dataSharing", "Group sharing", "Preferences across Aurelia properties") +
            consentRow("profiling", "Profiling", "Personalised recommendations") +
          "</div>" +
          '<p class="tiny muted mt12">Consent changes are timestamped and recorded in the activity log.</p>' +
          '<button class="btn sm block mt12" data-act="erase-guest" data-guest="' + g.id + '">Log an erasure request</button>' +
          "</section>" +
          '<section class="card"><div class="card-title">' + ui.icon("calendar", 14) + 'Upcoming</div>' +
            (upcoming.length ? '<div class="list mt12">' + upcoming.slice(0, 3).map(function (r) {
              return '<a class="list-row" href="#/booking/' + r.id + '" style="text-decoration:none"><div class="lr-main"><span class="avatar sm">' + ui.icon("calendar", 12) + '</span><div><div class="lr-title">' + U.pretty(r.checkIn, "medium") + '</div><div class="lr-sub">' + ui.esc(ui.typeName(r.roomTypeId)) + " · " + U.nights(r.checkIn, r.checkOut) + ' nights</div></div></div><div class="lr-meta">' + ui.icon("right", 12) + "</div></a>";
            }).join("") + "</div>" : '<p class="muted small mt12">No future reservations.</p>') +
            '<a class="btn sm block mt12" href="#/booking/new">Create a booking</a>' +
          "</section>" +
        "</div>" +
      "</div>";
  }

  /* ============================================================
     MODALS + FORMS
     ============================================================ */
  function editGuestModal(guestId) {
    var g = LHMS.get.guest(guestId);
    if (!g) return;
    var pref = g.preferences || {};
    ui.modal({
      title: "Edit guest profile",
      sub: "Changes apply across every Aurelia property and are written to the audit trail.",
      wide: true,
      body: '<form data-form="edit-guest" class="form-grid">' +
        '<input type="hidden" name="guestId" value="' + g.id + '" />' +
        '<div class="field"><label>Title</label><select name="title">' + ["Mr", "Mrs", "Ms", "Dr"].map(function (t) { return "<option" + (g.title === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Tier</label><select name="tier">' + ["Member", "Silver", "Gold", "Platinum"].map(function (t) { return "<option" + (g.tier === t ? " selected" : "") + ">" + t + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>First name</label><input name="firstName" value="' + ui.esc(g.firstName) + '" required /></div>' +
        '<div class="field"><label>Last name</label><input name="lastName" value="' + ui.esc(g.lastName) + '" required /></div>' +
        '<div class="field"><label>Email</label><input name="email" type="email" value="' + ui.esc(g.email) + '" /></div>' +
        '<div class="field"><label>Phone</label><input name="phone" value="' + ui.esc(g.phone) + '" /></div>' +
        '<div class="field"><label>Country</label><input name="country" value="' + ui.esc(g.country) + '" /></div>' +
        '<div class="field"><label>City</label><input name="city" value="' + ui.esc(g.city || "") + '" /></div>' +
        '<div class="field span2"><label>Company / role</label><input name="job" value="' + ui.esc(g.job || "") + '" /></div>' +
        '<div class="divider-label span2">Preferences</div>' +
        '<div class="field"><label>Pillow</label><select name="pillow">' + ["No preference", "Memory foam", "Soft feather", "Firm orthopaedic", "Buckwheat", "Hypoallergenic"].map(function (x) { return "<option" + (pref.pillow === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Room preference</label><select name="room">' + ["No preference", "High floor, away from lift", "Low floor near spa", "Quiet corner", "Away from lift", "Ocean-facing", "Near the pool", "Accessible bathroom"].map(function (x) { return "<option" + (pref.room === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Dietary</label><select name="dietary">' + ["No restrictions", "Vegetarian", "Vegan", "Gluten-free", "Halal", "Low sodium", "Dairy-free"].map(function (x) { return "<option" + (pref.dietary === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Allergies</label><select name="allergies">' + ["None", "Shellfish", "Peanuts", "Tree nuts", "Gluten", "Feathers", "Penicillin", "Lactose"].map(function (x) { return "<option" + (pref.allergies === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Beverage</label><select name="beverage">' + ["Still water", "Sparkling water", "Chamomile tea", "Espresso", "Green tea", "Fresh lime juice"].map(function (x) { return "<option" + (pref.beverage === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Turndown</label><select name="turndown">' + ["On request", "Evening turndown", "No turndown"].map(function (x) { return "<option" + (pref.turndown === x ? " selected" : "") + ">" + x + "</option>"; }).join("") + "</select></div>" +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-guest">Save profile</button>'
    });
  }

  function newGuestModal() {
    ui.modal({
      title: "Create a guest profile",
      sub: "A single record, shared across the group. Preferences can be added later.",
      body: '<form data-form="new-guest" class="form-grid">' +
        '<div class="field"><label>Title</label><select name="title"><option>Mr</option><option>Mrs</option><option>Ms</option><option>Dr</option></select></div>' +
        '<div class="field"><label>Tier</label><select name="tier"><option>Member</option><option>Silver</option><option>Gold</option><option>Platinum</option></select></div>' +
        '<div class="field"><label>First name</label><input name="firstName" required placeholder="Ada" /></div>' +
        '<div class="field"><label>Last name</label><input name="lastName" required placeholder="Okafor" /></div>' +
        '<div class="field span2"><label>Email</label><input name="email" type="email" required placeholder="guest@example.com" /></div>' +
        '<div class="field"><label>Phone</label><input name="phone" placeholder="+234 …" /></div>' +
        '<div class="field"><label>Country</label><select name="country"><option>Nigeria</option><option>United Kingdom</option><option>United States</option><option>Ghana</option><option>South Africa</option><option>France</option><option>Germany</option><option>India</option><option>United Arab Emirates</option><option>Singapore</option></select></div>' +
        '<div class="field"><label>ID type</label><select name="idType"><option>International passport</option><option>National ID</option><option>Driver licence</option></select></div>' +
        '<div class="field"><label>ID number</label><input name="idNumber" placeholder="A0123456" /></div>' +
        '<label class="check span2"><input type="checkbox" name="marketing" /> Guest consents to marketing communications (NDPR / GDPR)</label>' +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="create-guest">Create profile</button>'
    });
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  Object.assign(LHMS.uiActions, {
    "open-guest": function (el) { LHMS.go("guests/" + el.getAttribute("data-guest")); },
    "live:guest-search": function (val) {
      S.guestQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="guest-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:guest-tier": function (el) { S.guestTier = el.value; LHMS.rerender(); },
    "change:guest-sort": function (el) { S.guestSort = el.value; LHMS.rerender(); },
    "guest-tab": function (el) { S.guestTab = el.getAttribute("data-tab"); LHMS.rerender(); },
    "new-guest": function () { newGuestModal(); },
    "create-guest": function () {
      var form = document.querySelector('form[data-form="new-guest"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var g = LHMS.actions.createGuest(Object.assign({}, d, { marketing: !!d.marketing }));
      ui.closeModal();
      LHMS.go("guests/" + g.id);
      ui.toast("Guest profile created for " + g.name + ".");
    },
    "edit-guest": function (el) { editGuestModal(el.getAttribute("data-guest")); },
    "save-guest": function () {
      var form = document.querySelector('form[data-form="edit-guest"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var id = d.guestId;
      LHMS.actions.updateGuest(id, {
        title: d.title, tier: d.tier, firstName: d.firstName, lastName: d.lastName,
        email: d.email, phone: d.phone, country: d.country, city: d.city, job: d.job,
        preferences: { pillow: d.pillow, room: d.room, dietary: d.dietary, allergies: d.allergies, beverage: d.beverage, turndown: d.turndown }
      });
      ui.closeModal(); LHMS.rerender();
      ui.toast("Guest profile updated and synced across the group.");
    },
    "guest-note-modal": function (el) {
      var g = LHMS.get.guest(el.getAttribute("data-guest"));
      if (!g) return;
      ui.modal({
        title: "Add a service note",
        sub: g.name + " · visible to front office and department heads",
        slim: true,
        body: '<form data-form="guest-note"><input type="hidden" name="guestId" value="' + g.id + '" /><div class="field"><label>Note</label><textarea name="note" required placeholder="e.g. Prefers a quiet room away from the lift; celebrate birthday in April."></textarea></div></form>',
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-guest-note">Add note</button>'
      });
    },
    "save-guest-note": function () {
      var form = document.querySelector('form[data-form="guest-note"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      LHMS.actions.addGuestNote(d.guestId, d.note);
      ui.closeModal(); LHMS.rerender();
      ui.toast("Note added to the guest profile.");
    },
    "guest-export": function (el) {
      var g = LHMS.get.guest(el.getAttribute("data-guest"));
      if (!g) return;
      var rows = [["Field", "Value"]];
      ["name", "email", "phone", "country", "city", "tier", "job", "since", "loyaltyPoints"].forEach(function (k) { rows.push([k, g[k]]); });
      Object.keys(g.preferences || {}).forEach(function (k) { rows.push(["preference." + k, g.preferences[k]]); });
      Object.keys(g.consent || {}).forEach(function (k) { rows.push(["consent." + k, g.consent[k] ? "yes" : "no"]); });
      rows.push(["stays", LHMS.calc.guestStats(g.id).stays], ["lifetime spend", LHMS.calc.guestStats(g.id).spend]);
      ui.csv("aurelia-guest-" + U.slug(g.name) + "-" + LHMS.day + ".csv", rows);
      LHMS.log("exported guest data", "guest", g.name + " · NDPR subject access");
      LHMS.save();
      ui.toast("Guest data export downloaded (NDPR subject access).");
    },
    "erase-guest": function (el) {
      var g = LHMS.get.guest(el.getAttribute("data-guest"));
      if (!g) return;
      ui.confirm({
        title: "Log an erasure request?",
        label: "Log request",
        body: "The profile will be flagged for the data protection officer. Financial and registration records are retained where required by law. No data is deleted by this request.",
        id: "erase"
      });
      S.pendingErase = g.id;
    },
    "export-guests": function () {
      var rows = [["Name", "Email", "Phone", "Tier", "Country", "Stays", "Nights", "Lifetime spend", "Marketing consent"]];
      LHMS.db.guests.forEach(function (g) {
        var st = LHMS.calc.guestStats(g.id);
        rows.push([g.name, g.email, g.phone, g.tier, g.country, st.stays, st.nights, st.spend, g.consent && g.consent.marketing ? "Yes" : "No"]);
      });
      ui.csv("aurelia-guests-" + LHMS.day + ".csv", rows);
      LHMS.log("exported the guest directory", "guest", LHMS.db.guests.length + " profiles");
      LHMS.save();
      ui.toast("Guest directory export downloaded.");
    }
  });

  /* consent and confirm handlers */
  document.addEventListener("change", function (e) {
    var box = e.target.closest("[data-guest-consent]");
    if (!box) return;
    var g = LHMS.get.guest(box.getAttribute("data-guest"));
    if (!g) return;
    var key = box.getAttribute("data-guest-consent");
    LHMS.actions.updateGuest(g.id, { consent: { } });
    g.consent[key] = box.checked;
    LHMS.log("updated guest consent", "guest", g.name + " · " + key + " → " + (box.checked ? "granted" : "withdrawn"));
    LHMS.save();
    ui.toast("Consent updated: " + key + " " + (box.checked ? "granted" : "withdrawn") + ".");
  });

  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-confirm]");
    if (!btn || btn.getAttribute("data-confirm") !== "erase") return;
    var g = LHMS.get.guest(S.pendingErase);
    if (g) {
      LHMS.log("logged an erasure request", "guest", g.name + " · NDPR / GDPR · 30-day SLA");
      LHMS.save();
      ui.toast("Erasure request logged for the data protection officer.");
    }
    S.pendingErase = null;
    ui.closeModal(); LHMS.rerender();
  });

  /* forms */
  LHMS.forms["guest-note"] = function (form) {
    var d = Object.fromEntries(new FormData(form));
    if (!d.note) return;
    LHMS.actions.addGuestNote(d.guestId, d.note);
    LHMS.rerender();
    ui.toast("Note added to the guest profile.");
  };
})();
