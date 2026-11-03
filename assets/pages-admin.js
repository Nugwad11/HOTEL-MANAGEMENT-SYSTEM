/* ============================================================
   Hotel administration — staff, setup, activity, notifications
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var S = (LHMS.state = LHMS.state || {});
  var db = LHMS.db;

  if (S.staffQuery == null) S.staffQuery = "";
  if (S.staffDept == null) S.staffDept = "all";
  if (S.staffRole == null) S.staffRole = "all";
  if (S.setupTab == null) S.setupTab = "hotel";
  if (S.actQuery == null) S.actQuery = "";
  if (S.actEntity == null) S.actEntity = "all";
  if (S.actActor == null) S.actActor = "all";
  if (S.ntfTab == null) S.ntfTab = "all";
  if (S.ntfType == null) S.ntfType = "all";

  // The money of account is the currency every base figure on these books means,
  // so only a property with nothing valued yet can move it.
  function isBaseCurrency(code) { return LHMS.fx.base(LHMS.get.property().id) === code; }
  function currencyOptions(current) {
    return LHMS.fx.codes.map(function (code) {
      return '<option value="' + code + '"' + (current === code ? " selected" : "") + ">" +
        ui.esc(code + " — " + (LHMS.fx.nameOf(code) || code) +
          (isBaseCurrency(code) ? " (kept in)" : "")) + "</option>";
    }).join("");
  }

  // The money of account is what every stored base figure means, so the choice
  // stops being free the moment the books hold money.
  function currencyLockHint(current) {
    var held = LHMS.moneyRecordsOnFile(LHMS.get.property().id);
    return held
      ? "The books are kept in " + current + " and " + held + " money records already count it, so this cannot move now. File a rate in Financial settings to sell in another money beside it."
      : "The money every total on these books is counted in. Other currencies are sold against it at the filed rates.";
  }

  function roleTone(role) {
    return role === "Manager" ? "gold" : role === "Front Desk" ? "blue" : role === "Housekeeping" ? "green" : role === "Revenue" ? "violet" : role === "Auditor" ? "navy" : role === "Finance Manager" ? "amber" : "";
  }
  function statusTone(status) { return status === "Active" ? "green" : "red"; }
  function staffFiltered() {
    var list = LHMS.staffOf().slice();
    if (S.staffDept !== "all") list = list.filter(function (s) { return s.department === S.staffDept; });
    if (S.staffRole !== "all") list = list.filter(function (s) { return s.role === S.staffRole; });
    if (S.staffQuery) {
      var q = S.staffQuery.toLowerCase();
      list = list.filter(function (s) { return (s.name + " " + s.email + " " + s.title + " " + s.department).toLowerCase().indexOf(q) !== -1; });
    }
    return list.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }

  function staffModal(staff) {
    var edit = !!staff;
    var s = staff || { name: "", email: "", role: "Front Desk", department: "Front Office", title: "", phone: "", shift: "08:00 – 17:00" };
    ui.modal({
      title: edit ? "Edit " + s.name : "Add a staff member",
      sub: edit ? "Role changes apply on the next sign-in; permissions are managed below." : "Create the account, assign a role and set the roster.",
      body: '<form data-form="staff"><input type="hidden" name="staffId" value="' + (edit ? s.id : "") + '" />' +
        '<div class="form-grid">' +
        '<div class="field span2"><label>Full name</label><input name="name" value="' + ui.esc(s.name) + '" required placeholder="Ada Okafor" /></div>' +
        '<div class="field span2"><label>Work email</label><input name="email" type="email" value="' + ui.esc(s.email) + '" required placeholder="name@aureliagrand.com" /></div>' +
        '<div class="field"><label>Role</label><select name="role">' + ["Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Manager", "Auditor"].map(function (r) { return '<option' + (s.role === r ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Department</label><select name="department">' + ["Front Office", "Housekeeping", "Engineering", "Revenue", "Executive", "Finance", "Food & Beverage", "Spa & Wellness", "Security"].map(function (d) { return '<option' + (s.department === d ? " selected" : "") + ">" + d + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Job title</label><input name="title" value="' + ui.esc(s.title) + '" placeholder="Front Desk Agent" /></div>' +
        '<div class="field"><label>Shift</label><input name="shift" value="' + ui.esc(s.shift) + '" /></div>' +
        '<div class="field span2"><label>Phone</label><input name="phone" value="' + ui.esc(s.phone) + '" /></div>' +
        "</div></form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-staff">' + (edit ? "Save changes" : "Create account") + "</button>"
    });
  }

  /* ============================================================
     STAFF & PERMISSIONS
     ============================================================ */
  LHMS.pages.staff = function () {
    var p = LHMS.get.property();
    var list = staffFiltered();
    var all = LHMS.staffOf(p.id);
    var departments = {};
    all.forEach(function (s) { departments[s.department] = (departments[s.department] || 0) + 1; });
    var active = all.filter(function (s) { return s.status === "Active"; }).length;
    var roleCounts = {};
    all.forEach(function (s) { roleCounts[s.role] = (roleCounts[s.role] || 0) + 1; });

    var rows = list.map(function (s) {
      return '<tr><td><div class="who">' + ui.avatar(s.name) + '<div style="min-width:0"><div class="who-name">' + ui.esc(s.name) + '</div><div class="who-sub">' + ui.esc(s.email) + "</div></div></div></td>" +
        '<td><b class="small">' + ui.esc(s.title) + '</b><div class="tiny muted">' + ui.esc(s.department) + "</div></td>" +
        "<td>" + ui.chip(s.role, roleTone(s.role), false) + "</td>" +
        '<td><span class="tiny">' + ui.esc(s.shift) + "</span></td>" +
        '<td><span class="tiny muted">' + U.pretty(s.started, "medium") + "</span></td>" +
        "<td>" + ui.chip(s.status || "Active", statusTone(s.status || "Active")) + "</td>" +
        '<td class="right"><button class="btn sm ghost" data-act="edit-staff" data-staff="' + s.id + '">Edit</button><button class="btn sm ghost" data-act="toggle-staff" data-staff="' + s.id + '">' + (s.status === "Inactive" ? "Activate" : "Deactivate") + "</button></td></tr>";
    }).join("");

    var roles = ["Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Auditor"];
    // The auditor column is shown so the least-privilege line is visible, but it is
    // locked: widening an auditor's reach would end the audit. The controller's
    // column is locked for the same reason from the other side — a hand that can
    // also record a cost or ask for a price would be signing its own work.
    var fixed = { Auditor: true, "Finance Manager": true };
    var permRows = LHMS.PERMISSIONS.map(function (perm) {
      return '<tr><td><b class="small">' + ui.esc(perm.label) + '</b><div class="tiny muted">' + ui.esc(perm.key.replace(/_/g, " ")) + "</div></td>" +
        '<td class="right"><input type="checkbox" checked disabled aria-label="Manager always allowed" style="width:16px;height:16px;accent-color:var(--gold)" /></td>' +
        roles.map(function (role) {
          var checked = !!(db.permissions[role] && db.permissions[role][perm.key]);
          if (fixed[role]) {
            return '<td class="right"><input type="checkbox"' + (checked ? " checked" : "") +
              ' disabled aria-label="' + ui.esc(role + " — " + perm.label + " (fixed)") +
              '" style="width:16px;height:16px;accent-color:var(--navy)" /></td>';
          }
          return '<td class="right"><input type="checkbox" data-perm data-role="' + role + '" data-perm-key="' + perm.key + '"' + (checked ? " checked" : "") + ' style="width:16px;height:16px;accent-color:var(--navy)" aria-label="' + ui.esc(role + " — " + perm.label) + '" /></td>';
        }).join("") + "</tr>";
    }).join("");

    var departmentRows = Object.keys(departments).sort(function (a, b) { return departments[b] - departments[a]; }).map(function (d) {
      return '<div class="detail-row"><dt>' + ui.esc(d) + "</dt><dd>" + departments[d] + " staff</dd></div>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Hotel administration · " + p.short,
      title: "Staff & permissions",
      sub: "Roster, roles and the permission matrix that governs what each team can see and do. Changes are audited.",
      actions: '<button class="btn" data-act="export-staff">' + ui.icon("download", 14) + ' Export</button><button class="btn primary" data-act="new-staff">' + ui.icon("userPlus", 14) + " Add staff</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Team members", all.length, "At " + p.short, { icon: "users", accent: "accent-navy" }) +
        ui.kpi("Active accounts", active, all.length - active + " inactive", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Departments", Object.keys(departments).length, "Front office to engineering", { icon: "building" }) +
        ui.kpi("Managers", roleCounts.Manager || 0, "Full access", { icon: "shield", accent: "accent-red" }) +
        ui.kpi("Open shifts", active, "Covered today", { icon: "clock" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        '<section class="card"><div class="toolbar">' +
          ui.searchField("Search by name, email, role or department", S.staffQuery, "staff-search") +
          '<select class="select" style="max-width:170px" data-change="staff-dept"><option value="all">All departments</option>' +
            Object.keys(departments).sort().map(function (d) { return '<option' + (S.staffDept === d ? " selected" : "") + ">" + ui.esc(d) + "</option>"; }).join("") + "</select>" +
          '<select class="select" style="max-width:140px" data-change="staff-role"><option value="all">All roles</option>' +
            ["Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Manager", "Auditor"].map(function (r) { return '<option' + (S.staffRole === r ? " selected" : "") + ">" + r + "</option>"; }).join("") + "</select>" +
          '<span class="spacer"></span><span class="tiny muted">' + list.length + " shown</span></div>" +
          (list.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Staff member</th><th>Role &amp; department</th><th>Access</th><th>Shift</th><th>Started</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : ui.empty("No staff match", "Try a different filter or search term.", "users")) +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("Departments", departmentRows, '<button class="btn sm" data-act="new-staff">' + ui.icon("plus", 11) + " Add</button>", "Headcount at this property", "building") +
        "</div>" +
      "</div>" +
      '<section class="card mt16"><div class="card-head"><div><div class="card-title">' + ui.icon("shield", 15) + 'Permission matrix</div><div class="card-sub">Manager access is fixed, so is the group auditor&rsquo;s read-only set, and so is the controller&rsquo;s &mdash; the hand that signs must not also record or ask. Toggle a role to grant or revoke a capability immediately.</div></div><span class="chip gold">RBAC</span></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr><th>Capability</th><th class="right">Manager</th>' + roles.map(function (r) { return '<th class="right">' + r + "</th>"; }).join("") + "</tr></thead><tbody>" + permRows + "</tbody></table></div>" +
        '<div class="notice info mt12">' + ui.icon("shield") + "<div>Permissions are checked on every route and action. Revoking a permission does not terminate an active session; it applies to the next action.</div></div>" +
      "</section>" +
      '<div class="grid g3 mt16">' +
        ui.sectionCard("Role access at a glance", '<div class="stack" style="gap:0">' + ["Manager", "Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Auditor"].map(function (role) {
          var count = role === "Manager" ? LHMS.PERMISSIONS.length : Object.keys(db.permissions[role] || {}).filter(function (k) { return db.permissions[role][k]; }).length;
          return '<div class="detail-row"><dt>' + ui.chip(role, roleTone(role), false) + "</dt><dd>" + count + " of " + LHMS.PERMISSIONS.length + " capabilities</dd></div>";
        }).join("") + "</div>", "", "Least privilege by default", "lock") +
        ui.sectionCard("Onboarding checklist", '<div class="stack" style="gap:8px">' +
          [["Account created", true], ["Role assigned", true], ["Property access set", true], ["Policy acknowledgement", true], ["Door-lock badge issued", false]].map(function (r) {
            return '<div class="row between"><span class="small">' + r[0] + '</span>' + (r[1] ? '<span class="chip green">Done</span>' : '<span class="chip amber">Pending</span>') + "</div>";
          }).join("") + "</div>", "", "For every new team member", "checkCircle") +
        ui.sectionCard("Security posture", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>Single sign-on</dt><dd><span class="chip green">Enabled</span></dd></div>' +
          '<div class="detail-row"><dt>Session timeout</dt><dd>30 minutes</dd></div>' +
          '<div class="detail-row"><dt>Password policy</dt><dd>12 characters · MFA</dd></div>' +
          '<div class="detail-row"><dt>Access reviews</dt><dd>Quarterly</dd></div></div>', "", "Aligned with NDPR and GDPR", "shield") +
      "</div>";
  };

  /* ============================================================
     HOTEL SETUP
     ============================================================ */
  var INTEGRATIONS = [
    { key: "channelManager", title: "Channel manager", icon: "globe", desc: "Two-way rate and availability sync with Booking.com, Expedia and GDS." },
    { key: "paymentGateway", title: "Payment gateway", icon: "card", desc: "Card, transfer and city-ledger settlement with 3-D Secure." },
    { key: "doorLocks", title: "Door locks & mobile key", icon: "key", desc: "Issue and revoke digital keys from the front desk or guest app." },
    { key: "accounting", title: "Accounting export", icon: "file", desc: "Nightly journal to Sage or QuickBooks with department mapping." },
    { key: "crm", title: "Guest CRM", icon: "users", desc: "Profile enrichment, recognition tiers and lifecycle campaigns." },
    { key: "whatsapp", title: "WhatsApp concierge", icon: "message", desc: "Pre-arrival messaging and two-way guest requests." }
  ];

  function brandPalette(b) {
    if (b.palette && b.palette.length >= 2) return b.palette;
    return (LHMS.brand && LHMS.brand.FALLBACK) || ["#16283f", "#b18f52", "#d9c08d", "#3a5677", "#f7f0df"];
  }

  function brandTab(b) {
    var palette = brandPalette(b);
    var swatchNames = ["Dominant", "Accent", "Tint", "Shade", "Soft"];
    var mark = b.logo
      ? '<span class="brand-mark has-logo"><img src="' + ui.esc(b.logo) + '" alt="" /></span>'
      : '<span class="brand-mark">' + ui.icon("building", 20) + "</span>";
    var cover = b.images[0];

    var swatches = palette.map(function (c, i) {
      return '<div class="swatch"><i style="background:' + ui.esc(c) + '"></i><b>' + ui.esc(String(c).toUpperCase()) +
        '</b><span class="tiny muted">' + (swatchNames[i] || "Colour") + "</span></div>";
    }).join("");

    var tiles = b.images.map(function (img, i) {
      return '<figure class="brand-tile' + (i === 0 ? " cover" : "") + '">' +
        '<img src="' + ui.esc(img.src) + '" alt="' + ui.esc(img.name || "Hotel image " + (i + 1)) + '" loading="lazy" />' +
        (i === 0 ? '<span class="brand-cover-tag">Cover</span>' : "") +
        '<figcaption><span>' + ui.esc(img.name || "Image " + (i + 1)) + "</span>" +
          (i > 0 ? '<button class="icon-btn" data-act="brand-cover" data-index="' + i + '" title="Use as cover" aria-label="Use as cover">' + ui.icon("star", 12) + "</button>" : "") +
          '<button class="icon-btn" data-act="brand-remove-image" data-index="' + i + '" title="Remove image" aria-label="Remove image">' + ui.icon("trash", 12) + "</button>" +
        "</figcaption></figure>";
    }).join("");
    if (b.images.length < LHMS.BRAND_LIMITS.maxImages) {
      tiles += '<label class="brand-add" for="brand-images-input">' + ui.icon("upload", 20) +
        "<span>Add photos<br/><span class=\"muted\" style=\"font-weight:500\">" + b.images.length + " of " + LHMS.BRAND_LIMITS.maxImages + "</span></span></label>";
    }

    var identity = ui.sectionCard("Identity",
      '<form data-form="brand"><div class="form-grid">' +
        '<div class="field"><label>Brand name</label><input name="brandName" value="' + ui.esc(b.brandName) + '" maxlength="60" required /></div>' +
        '<div class="field"><label>Tagline</label><input name="tagline" value="' + ui.esc(b.tagline) + '" maxlength="90" placeholder="Hotels &amp; Residences" /></div>' +
      "</div></form>",
      '<button class="btn primary" data-act="save-brand">Save identity</button>',
      "The name and line shown on the sign-in page and in the app chrome", "sparkles");

    var logo = ui.sectionCard("Logo",
      '<div class="brand-upload">' +
        '<div class="brand-logo-preview">' + (b.logo
          ? '<img src="' + ui.esc(b.logo) + '" alt="' + ui.esc(b.brandName) + ' logo" />'
          : '<span class="brand-logo-empty">' + ui.icon("image", 30) + "</span>") + "</div>" +
        '<div style="flex:1;min-width:0">' +
          "<b class=\"small\">" + (b.logo ? "Logo on file" : "No logo yet") + "</b>" +
          '<p class="tiny muted" style="line-height:1.6;margin-top:4px">A square PNG or SVG reads best. The logo lands on the sign-in page, the sidebar, the property switch and the browser tab.</p>' +
          '<div class="row mt8">' +
            '<label class="btn sm" for="brand-logo-input">' + ui.icon("upload", 12) + " Upload logo</label>" +
            (b.logo ? '<button class="btn sm ghost" data-act="brand-remove-logo">' + ui.icon("trash", 12) + " Remove</button>" : "") +
          "</div>" +
          '<input type="file" id="brand-logo-input" class="sr-only" accept="image/png,image/jpeg,image/webp,image/svg+xml" data-change="brand-logo" />' +
          '<div class="tiny muted mt8">' + (b.updatedAt
            ? "Updated " + U.pretty(b.updatedAt.slice(0, 10), "medium") + (b.updatedBy ? " by " + ui.esc(b.updatedBy) : "")
            : "No image or colour change yet.") + "</div>" +
        "</div>" +
      "</div>", "", "The mark guests and staff recognise", "image");

    var gallery = ui.sectionCard("Hotel images",
      (b.images.length ? "" : '<p class="tiny muted" style="margin-bottom:10px">No hotel photos yet. The sign-in page keeps its house photograph until you add one.</p>') +
      '<div class="brand-gallery">' + tiles + "</div>" +
      '<input type="file" id="brand-images-input" class="sr-only" accept="image/png,image/jpeg,image/webp" multiple data-change="brand-images" />',
      "", "The first photo is the cover · up to six", "grid");

    var colours = ui.sectionCard("Logo colours",
      '<div class="brand-swatches">' + swatches + "</div>" +
      '<label class="check mt14" style="font-size:11px"><input type="checkbox" data-change="brand-use-colors"' + (b.useColors ? " checked" : "") + " /> Apply these colours across the system</label>" +
      '<p class="tiny muted mt8" style="line-height:1.6">' + (b.palette
        ? (b.useColors
          ? "The sign-in page and every screen take their navy, gold and ink from the logo's own palette."
          : "The logo stays, but the desk keeps its house palette until this is switched back on.")
        : "Upload a logo and its palette is read once and offered here. The house palette is in use until then.") + "</p>" +
      '<div class="row mt10" style="flex-wrap:wrap">' +
        '<button class="btn sm" data-act="brand-reextract"' + (b.logo ? "" : " disabled") + ">" + ui.icon("refresh", 12) + " Re-read from logo</button>" +
        (b.palette ? '<button class="btn sm ghost" data-act="brand-clear-colours">Use house colours</button>' : "") +
      "</div>", "", b.palette ? "Read from the uploaded logo" : "The house palette until a logo arrives", "palette");

    var preview = ui.sectionCard("Landing preview",
      '<div class="brand-preview"' + (cover
        ? ' style="background-image:linear-gradient(160deg,rgba(13,26,42,.18),rgba(13,26,42,.62)),url(\'' + ui.esc(cover.src) + '\')"'
        : "") + ">" +
        '<div class="brand-preview-brand">' + mark + "<div><span class=\"brand-name\">" + ui.esc(b.brandName) +
          '</span><span class="brand-kicker">' + ui.esc(b.tagline || "Hotels & Residences") + "</span></div></div>" +
        '<div class="brand-preview-panel"><span class="eyebrow">Welcome back</span><h3>Sign in to your hotel</h3>' +
          '<div class="preview-line"></div><div class="preview-line short"></div>' +
          '<span class="btn primary sm" style="margin-top:5px">Sign in</span></div>' +
      "</div>" +
      '<p class="tiny muted mt8">The sign-in page cycles the gallery behind this lock-up. ' + (cover ? "The cover leads." : "Add photos to replace the house photograph.") + "</p>",
      "", "What a guest sees before signing in", "eye");

    var where = ui.sectionCard("Where it appears",
      '<div class="stack" style="gap:0">' +
        '<div class="detail-row"><dt>Sign-in page</dt><dd>' + (b.images.length ? b.images.length + " photo" + (b.images.length === 1 ? "" : "s") : "House photograph") + "</dd></div>" +
        '<div class="detail-row"><dt>Sidebar &amp; top bar</dt><dd>' + (b.logo ? "Logo + name" : "Building mark + name") + "</dd></div>" +
        '<div class="detail-row"><dt>Browser tab</dt><dd>' + (b.logo ? "Logo" : "House favicon") + "</dd></div>" +
        '<div class="detail-row"><dt>System colours</dt><dd>' + (b.useColors && b.palette ? "From the logo" : "House navy &amp; gold") + "</dd></div>" +
      "</div>", "", "One brand, every surface", "globe");

    return '<div class="grid g-2-1"><div class="stack">' + identity + logo + gallery + "</div>" +
      '<div class="stack">' + colours + preview + where + "</div></div>";
  }

  LHMS.pages.setup = function () {
    var p = LHMS.get.property();
    var s = LHMS.get.settings(p.id);
    var tabs = [
      ["hotel", "Hotel profile"],
      ["brand", "Brand & images"],
      ["policies", "Policies"],
      ["integrations", "Integrations"],
      ["system", "System &amp; data"]
    ].map(function (t) {
      return '<button class="tab' + (S.setupTab === t[0] ? " active" : "") + '" data-act="setup-tab" data-tab="' + t[0] + '">' + t[1] + "</button>";
    }).join("");

    var connected = Object.keys(s.integrations || {}).filter(function (k) { return s.integrations[k]; }).length;
    var roomRows = db.roomTypes.map(function (t) {
      var rooms = LHMS.roomsOf(p.id).filter(function (r) { return r.typeId === t.id; });
      var nr = LHMS.price.nightRateOf(t.id);
      return '<tr><td><b class="small">' + ui.esc(t.name) + '</b><div class="tiny muted">' + t.size + "m² · sleeps " + t.occupancy + '</div></td><td class="right num">' + rooms.length + '</td><td class="right num">' + (nr ? U.money(nr.amount, nr.currency) : "not priced") + '</td><td class="right num">' + rooms.filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; }).length + "</td></tr>";
    }).join("");

    var hotelTab = '<div class="grid g-2-1">' +
      ui.sectionCard("Property profile", '<form data-form="hotel-profile"><div class="form-grid">' +
        '<div class="field"><label>Display name</label><input name="name" value="' + ui.esc(p.name) + '" required /></div>' +
        '<div class="field"><label>Short name</label><input name="short" value="' + ui.esc(p.short) + '" required /></div>' +
        '<div class="field"><label>City</label><input name="city" value="' + ui.esc(p.city) + '" /></div>' +
        '<div class="field"><label>Country</label><input name="country" value="' + ui.esc(p.country) + '" /></div>' +
        '<div class="field span2"><label>Address</label><input name="address" value="' + ui.esc(p.address) + '" /></div>' +
        '<div class="field"><label>Phone</label><input name="phone" value="' + ui.esc(p.phone) + '" /></div>' +
        '<div class="field"><label>Reservations email</label><input name="email" type="email" value="' + ui.esc(p.email) + '" /></div>' +
        '<div class="field"><label>General manager</label><input name="gm" value="' + ui.esc(p.gm) + '" /></div>' +
        '<div class="field"><label>Star rating</label><select name="star">' + [5, 4, 3].map(function (n) { return '<option' + (p.star === n ? " selected" : "") + ">" + n + "</option>"; }).join("") + "</select></div>" +
        '<div class="field span2"><label>Tagline</label><input name="tagline" value="' + ui.esc(p.tagline) + '" /></div>' +
        "</div></form>", '<button class="btn primary" data-act="save-hotel">Save profile</button>', "Guest-facing identity and contact details", "building") +
      '<div class="stack">' +
        ui.sectionCard("At a glance", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>Opened</dt><dd>' + p.opened + "</dd></div>" +
          '<div class="detail-row"><dt>Floors</dt><dd>' + p.floors + "</dd></div>" +
          '<div class="detail-row"><dt>Keys</dt><dd>' + LHMS.roomsOf(p.id).length + "</dd></div>" +
          '<div class="detail-row"><dt>Star rating</dt><dd>' + p.star + "-star</dd></div>" +
          '<div class="detail-row"><dt>Occupancy target</dt><dd>' + Math.round(p.occupancyTarget * 100) + "%</dd></div></div>", "", "Physical footprint", "building") +
        ui.sectionCard("Room mix", '<div class="table-wrap"><table class="data mini"><thead><tr><th>Type</th><th class="right">Rooms</th><th class="right">Rate</th><th class="right">OOO</th></tr></thead><tbody>' + roomRows + "</tbody></table></div>", '<a class="btn sm" href="#/revenue">Rates</a><a class="btn sm ghost" href="#/prices">Price setup</a>', "Inventory by product · prices come from the central catalogue", "bed") +
        ui.sectionCard("Properties in the group", '<div class="stack" style="gap:0">' + db.properties.map(function (prop) {
          return '<div class="detail-row"><dt><b>' + ui.esc(prop.short) + '</b><div class="tiny muted">' + ui.esc(prop.city) + "</div></dt><dd>" + (prop.id === p.id ? '<span class="chip gold">Current</span>' : '<button class="btn sm ghost" data-act="switch-property" data-property="' + prop.id + '">Open</button>') + "</dd></div>";
        }).join("") + "</div>", "", "Multi-property by design", "globe") +
      "</div>" +
    "</div>";

    // The catalogue base, not tonight's rate, so the worked example does not
    // change when the page is opened on a Friday.
    var exampleRoom = LHMS.price.forRef("room", db.roomTypes[0].id);
    var exampleRateRow = LHMS.price.baseRow(exampleRoom.id);
    var exampleNight = exampleRateRow.amount;
    var exampleCur = exampleRateRow.currency;
    var exampleTax = LHMS.price.taxes(exampleNight, "room");
    var policiesTab = '<div class="grid g-2-1">' +
      ui.sectionCard("Commercial policies", '<form data-form="policy"><div class="form-grid">' +
        '<div class="field"><label>Deposit %</label><input name="depositPct" type="number" min="0" max="100" step="5" value="' + s.depositPct + '" /></div>' +
        '<div class="field"><label>Check-in time</label><input name="checkInTime" type="time" value="' + s.checkInTime + '" /></div>' +
        '<div class="field"><label>Check-out time</label><input name="checkOutTime" type="time" value="' + s.checkOutTime + '" /></div>' +
        '<div class="field"><label>Currency</label><select name="currency">' + currencyOptions(s.currency) + "</select>" +
        '<div class="tiny muted">' + ui.esc(currencyLockHint(s.currency)) + "</div></div>" +
        '<div class="field"><label>Language</label><select name="language"><option' + (s.language === "English (UK)" ? " selected" : "") + '>English (UK)</option><option' + (s.language === "English (US)" ? " selected" : "") + '>English (US)</option><option' + (s.language === "French" ? " selected" : "") + ">French</option></select></div>" +
        '<div class="field"><label>Overbooking allowance</label><input name="overbooking" type="number" min="0" max="10" value="' + (s.overbooking || 0) + '" /></div>' +
        '<div class="field span2"><label>Cancellation policy</label><textarea name="cancellation">' + ui.esc(s.cancellation) + "</textarea></div>" +
        "</div></form>", '<button class="btn primary" data-act="save-policy">Save policies</button>', "Deposit, arrival windows and the wording guests are shown", "settings") +
      '<div class="stack">' +
        ui.sectionCard("Tax and service example", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>Room charge</dt><dd>' + U.money(exampleNight, exampleCur) + "</dd></div>" +
          exampleTax.lines.map(function (l) {
            return '<div class="detail-row"><dt>' + ui.esc(l.label) + "</dt><dd>" + U.money(l.amount, exampleCur) + "</dd></div>";
          }).join("") +
          '<div class="detail-row total"><dt>Guest total</dt><dd>' + U.money(exampleTax.grand, exampleCur) + "</dd></div></div>" +
          '<p class="tiny muted mt8">Charges are posted to the folio and included in the night audit pack. Percentages are configured centrally.</p>' +
          '<a class="btn soft mt8" href="#/taxes">Taxes &amp; service charges</a>', "", "One night in a Deluxe King, billed in " + exampleCur, "receipt") +
        ui.sectionCard("Data protection", '<div class="stack" style="gap:9px">' +
          '<div class="detail-row"><dt>Regulation</dt><dd>NDPR · GDPR</dd></div>' +
          '<div class="detail-row"><dt>Subject access</dt><dd>30-day SLA</dd></div>' +
          '<div class="detail-row"><dt>Erasure</dt><dd>Logged, reviewed by DPO</dd></div>' +
          '<div class="detail-row"><dt>Retention</dt><dd>7 years financial</dd></div>' +
          '<a class="btn soft" href="#/activity">Open audit trail</a></div>', "", "Guest data is processed lawfully", "shield") +
      "</div>" +
    "</div>";

    var integrationCards = INTEGRATIONS.map(function (it) {
      var on = !!(s.integrations && s.integrations[it.key]);
      return '<div class="panel" style="background:#fff"><div class="row between" style="align-items:flex-start"><span class="avatar" style="background:' + (on ? "#e9f2ec" : "#f1efe8") + ";color:" + (on ? "#356347" : "#8b8578") + '">' + ui.icon(it.icon, 17) + "</span>" + ui.chip(on ? "Connected" : "Not connected", on ? "green" : "") + "</div>" +
        '<div class="mt12"><b class="small">' + ui.esc(it.title) + '</b><p class="tiny muted" style="line-height:1.6;margin-top:4px">' + ui.esc(it.desc) + "</p></div>" +
        '<button class="btn sm ' + (on ? "" : "soft") + ' mt12" data-act="toggle-integration" data-key="' + it.key + '">' + (on ? "Disconnect" : "Connect") + "</button></div>";
    }).join("");

    var integrationsTab = '<div class="grid g3">' + integrationCards + "</div>" +
      '<div class="grid g-2-1 mt16">' +
        ui.sectionCard("Channel distribution", '<div class="table-wrap"><table class="data"><thead><tr><th>Channel</th><th class="right">Share of demand</th><th>Status</th></tr></thead><tbody>' +
          Object.keys(s.channels || {}).map(function (c) {
            return '<tr><td><b>' + ui.esc(c) + '</b></td><td class="right num">' + s.channels[c] + "%</td><td>" + ui.chip(c === "Direct" ? "Owned" : "Connected", c === "Direct" ? "gold" : "green") + "</td></tr>";
          }).join("") + "</tbody></table></div>", "", "Where availability is published", "globe") +
        ui.sectionCard("Integration health", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>Connected services</dt><dd>' + connected + " of " + INTEGRATIONS.length + "</dd></div>" +
          '<div class="detail-row"><dt>Last successful sync</dt><dd>2 minutes ago</dd></div>' +
          '<div class="detail-row"><dt>Failed jobs (24h)</dt><dd>0</dd></div>' +
          '<div class="detail-row"><dt>API keys rotated</dt><dd>14 days ago</dd></div></div>' +
          '<div class="notice mt12">' + ui.icon("shield") + "<div>Integrations run with least-privilege tokens. Disconnecting a channel stops rate and inventory updates only.</div></div>", "", "Monitoring and security", "wifi") +
      "</div>";

    var counts = {
      guests: db.guests.length, reservations: db.reservations.length, charges: db.charges.length,
      payments: db.payments.length, tasks: db.tasks.length, activity: db.activity.length,
      reviews: db.reviews.length, rooms: db.rooms.length
    };
    var systemTab = '<div class="grid g-2-1">' +
      ui.sectionCard("Records on file", '<p class="muted small" style="line-height:1.75">Every screen reads and writes the same workspace, kept in this browser. Signing out does not remove it; clearing the browser&rsquo;s site data does.</p>' +
        '<div class="table-wrap"><table class="data mini"><thead><tr><th>Record</th><th class="right">On file</th></tr></thead><tbody>' +
          Object.keys(counts).map(function (k) { return "<tr><td>" + U.titleCase(k) + '</td><td class="right num">' + counts[k].toLocaleString("en-NG") + "</td></tr>"; }).join("") +
        "</tbody></table></div>", "", "What this workspace holds", "settings") +
      '<div class="stack">' +
        ui.sectionCard("Runtime", '<div class="stack" style="gap:0">' +
          '<div class="detail-row"><dt>Product</dt><dd>' + db.meta.system + "</dd></div>" +
          '<div class="detail-row"><dt>Group</dt><dd>' + db.meta.hotelGroup + "</dd></div>" +
          '<div class="detail-row"><dt>Business day</dt><dd>' + U.pretty(db.meta.day, "medium") + "</dd></div>" +
          '<div class="detail-row"><dt>Schema</dt><dd>v' + db.meta.version + "</dd></div>" +
          '<div class="detail-row"><dt>Storage</dt><dd>Browser localStorage</dd></div></div>', "", "About this installation", "building") +
        ui.sectionCard("Audit and retention", '<div class="stack" style="gap:9px">' +
          '<p class="tiny muted" style="line-height:1.7">Every write is recorded in the activity log. Financial records are retained for seven years; guest documents follow the retention defaults set in the register.</p>' +
          '<a class="btn soft" href="#/activity">' + ui.icon("shield", 12) + " Open the audit trail</a></div>", "", "Where to look", "shield") +
      "</div>" +
    "</div>";

    var body = S.setupTab === "brand" ? brandTab(LHMS.get.branding(p.id))
      : S.setupTab === "policies" ? policiesTab
        : S.setupTab === "integrations" ? integrationsTab
          : S.setupTab === "system" ? systemTab : hotelTab;

    return ui.pageHead({
      eyebrow: "Hotel administration · " + p.short,
      title: "Hotel setup",
      sub: "Property identity, brand and images, commercial policies, tax and integrations.",
      actions: '<span class="chip ' + (connected ? "green" : "") + '">' + connected + " integrations live</span>"
    }) +
      '<div class="card mb16"><div class="tabs">' + tabs + "</div></div>" +
      body;
  };

  /* ============================================================
     ACTIVITY LOG
     ============================================================ */
  function ago(iso) {
    var mins = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    return Math.floor(hrs / 24) + "d ago";
  }
  function dayLabel(dateKey) {
    if (dateKey === LHMS.day) return "Today";
    if (dateKey === U.addDays(LHMS.day, -1)) return "Yesterday";
    return U.pretty(dateKey, "long");
  }

  // The entities a financial reviewer is accountable for: what was billed, what
  // it was priced at, what was spent and what two signatures changed.
  var FINANCIAL_ENTITIES = {
    invoice: true, folio: true, pricing: true, "rate plan": true,
    expense: true, "financial settings": true, approval: true,
    finance: true, "night audit": true, tax: true
  };

  // The financial management submenu opens the same trail on those entities.
  LHMS.pages["fin-audit"] = function () {
    // A filter carried over from the group log — "guest", say — would show an
    // empty money trail, so the submenu asks for its own scope when it opens.
    if (S.actEntity !== "all" && !FINANCIAL_ENTITIES[S.actEntity]) S.actEntity = "all";
    return LHMS.pages.activity({ financialOnly: true });
  };

  LHMS.pages.activity = function (route) {
    route = route || {};
    var p = LHMS.get.property();
    // Scoped before anything is counted, so the KPIs, the entity bars and the
    // actor list on the money trail describe the money trail alone.
    var all = db.activity.filter(route.financialOnly ? function (a) { return FINANCIAL_ENTITIES[a.entity]; } : function () { return true; });
    var entities = {};
    var actors = {};
    all.forEach(function (a) {
      entities[a.entity] = (entities[a.entity] || 0) + 1;
      actors[a.actor] = (actors[a.actor] || 0) + 1;
    });
    var list = all.slice();
    if (S.actEntity !== "all") list = list.filter(function (a) { return a.entity === S.actEntity; });
    if (S.actActor !== "all") list = list.filter(function (a) { return a.actor === S.actActor; });
    if (S.actQuery) {
      var q = S.actQuery.toLowerCase();
      list = list.filter(function (a) { return (a.actor + " " + a.action + " " + a.entity + " " + a.detail).toLowerCase().indexOf(q) !== -1; });
    }
    list.sort(function (a, b) { return a.at < b.at ? 1 : -1; });

    var groups = {};
    list.forEach(function (a) {
      var key = U.date(new Date(a.at));
      if (!groups[key]) groups[key] = [];
      groups[key].push(a);
    });
    var groupKeys = Object.keys(groups).sort().reverse();

    var groupsHtml = groupKeys.map(function (key) {
      return '<div class="audit-day"><div class="audit-day-label">' + ui.esc(dayLabel(key)) + '<span>' + groups[key].length + " events</span></div>" +
        groups[key].map(function (a) {
          var prop = LHMS.get.property(a.propertyId);
          return '<div class="audit-row"><div class="audit-time">' + U.timeOf(a.at) + '</div><span class="avatar sm">' + U.initials(a.actor) + '</span>' +
            '<div class="audit-main"><div><b>' + ui.esc(a.actor) + "</b> " + ui.esc(a.action) + ' <span class="audit-entity">' + ui.esc(a.entity) + "</span></div>" +
            '<div class="audit-detail">' + ui.esc(a.detail) + "</div></div>" +
            '<div class="audit-meta">' + (prop ? '<span class="chip">' + ui.esc(prop.code.toUpperCase()) + "</span>" : "") + '<span class="tiny muted">' + ago(a.at) + "</span></div></div>";
        }).join("") + "</div>";
    }).join("");

    var todayCount = all.filter(function (a) { return U.date(new Date(a.at)) === LHMS.day; }).length;
    var topActor = Object.keys(actors).sort(function (a, b) { return actors[b] - actors[a]; })[0];
    var entityBars = Object.keys(entities).sort(function (a, b) { return entities[b] - entities[a]; }).slice(0, 7).map(function (e, i) {
      return { label: e, value: entities[e], color: ui.series(i) };
    });

    return ui.pageHead({
      eyebrow: route.financialOnly ? "Financial management · the money trail" : "Governance · group audit trail",
      title: route.financialOnly ? "Audit trail" : "Activity log",
      sub: route.financialOnly
        ? "Bills, prices, costs, the rules they follow and the signatures that moved them — the same append-only log the " +
          "group reads, opened on the records that carry money. Nothing here is edited after the fact."
        : "Every action taken in the workspace, with actor, entity and detail. Records support NDPR accountability and internal review.",
      actions: '<button class="btn" data-act="clear-act-filters">' + ui.icon("refresh", 14) + ' Reset filters</button><button class="btn primary" data-act="export-activity">' + ui.icon("download", 14) + " Export audit</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Records retained", all.length, "Rolling workspace log", { icon: "shield", accent: "accent-navy" }) +
        ui.kpi("Events today", todayCount, U.pretty(LHMS.day, "medium"), { icon: "clock" }) +
        ui.kpi("Actors", Object.keys(actors).length, "Staff and integrations", { icon: "users" }) +
        ui.kpi("Most active", topActor ? ui.esc(topActor) : "—", topActor ? actors[topActor] + " actions" : "", { icon: "chart" }) +
        ui.kpi("Retention", "7 years", "Financial records", { icon: "file", accent: "accent-green" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        '<section class="card"><div class="toolbar">' +
          ui.searchField("Search the audit trail", S.actQuery, "act-search") +
          '<select class="select" style="max-width:170px" data-change="act-entity"><option value="all">' +
            (route.financialOnly ? "Every money record" : "All entities") + "</option>" +
            Object.keys(entities).sort().map(function (e) { return '<option' + (S.actEntity === e ? " selected" : "") + ">" + ui.esc(e) + "</option>"; }).join("") + "</select>" +
          '<select class="select" style="max-width:170px" data-change="act-actor"><option value="all">All actors</option>' +
            Object.keys(actors).sort().map(function (a) { return '<option' + (S.actActor === a ? " selected" : "") + ">" + ui.esc(a) + "</option>"; }).join("") + "</select>" +
          '<span class="spacer"></span><span class="tiny muted">' + list.length + " events</span></div>" +
          (list.length ? '<div class="audit-list">' + groupsHtml + "</div>" : ui.empty("Nothing matches", "Change the filters or search term to see more of the audit trail.", "search")) +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("Activity by entity", ui.barList(entityBars, {}), "", "Where changes are happening", "chart") +
          ui.sectionCard("Controls", '<div class="stack" style="gap:9px"><div class="detail-row"><dt>Log integrity</dt><dd><span class="chip green">Append-only</span></dd></div>' +
            '<div class="detail-row"><dt>Personal data</dt><dd>Minimised in detail text</dd></div>' +
            '<div class="detail-row"><dt>Access</dt><dd>Manager · Auditor</dd></div>' +
            '<div class="detail-row"><dt>Export</dt><dd>CSV · watermarked</dd></div></div>' +
            '<div class="notice mt12">' + ui.icon("shield") + "<div>Audit entries record who did what and when. They cannot be edited from the workspace.</div></div>", "", "Accountability and traceability", "lock") +
          ui.sectionCard("Actors", Object.keys(actors).sort(function (a, b) { return actors[b] - actors[a]; }).slice(0, 6).map(function (a) {
            return '<div class="list-row"><div class="lr-main" style="flex:1"><span class="avatar sm">' + U.initials(a) + '</span><div><div class="lr-title">' + ui.esc(a) + "</div><div class=\"lr-sub\">" + actors[a] + " recorded actions</div></div></div>" + (a === LHMS.actorName() ? '<span class="chip gold">You</span>' : "") + "</div>";
          }).join(""), "", "People and systems writing to the log", "users") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     NOTIFICATIONS
     ============================================================ */
  var NTF_ICON = {
    "VIP arrival": ["star", "#f5f0e3", "#8a7038"],
    "SLA at risk": ["alert", "#fbedeb", "#a4493d"],
    "Maintenance": ["wrench", "#f0eee7", "#6c685e"],
    "Review": ["message", "#eef3f8", "#3e6182"],
    "Night audit": ["clock", "#edf3ee", "#416b4b"],
    "Channel manager": ["globe", "#f3eef6", "#6f5580"],
    "New reservation": ["calendar", "#eef3f8", "#3e6182"],
    "Room status changed": ["bed", "#f0eee7", "#6c685e"]
  };
  function notifIcon(type) {
    var x = NTF_ICON[type] || ["bell", "#f1efe8", "#7a756a"];
    return '<span class="avatar sm" style="background:' + x[1] + ";color:" + x[2] + '">' + ui.icon(x[0], 14) + "</span>";
  }

  function notifyPrefs() {
    var s = LHMS.get.settings();
    if (!s.notifyPrefs) s.notifyPrefs = { email: true, whatsapp: true, push: true, digest: "Daily 07:00" };
    return s.notifyPrefs;
  }

  LHMS.pages.notifications = function () {
    var p = LHMS.get.property();
    var all = db.notifications.slice();
    var prefs = notifyPrefs();
    var types = {};
    all.forEach(function (n) { types[n.type] = (types[n.type] || 0) + 1; });
    var unread = all.filter(function (n) { return !n.read; });
    var list = all.slice();
    if (S.ntfTab === "unread") list = list.filter(function (n) { return !n.read; });
    if (S.ntfTab === "read") list = list.filter(function (n) { return n.read; });
    if (S.ntfType !== "all") list = list.filter(function (n) { return n.type === S.ntfType; });
    list.sort(function (a, b) {
      if (!!a.read !== !!b.read) return a.read ? 1 : -1;
      return a.at < b.at ? 1 : -1;
    });

    var tabs = [["all", "All", all.length], ["unread", "Unread", unread.length], ["read", "Read", all.length - unread.length]].map(function (t) {
      return '<button class="tab' + (S.ntfTab === t[0] ? " active" : "") + '" data-act="ntf-tab" data-tab="' + t[0] + '">' + t[1] + '<span class="count">' + t[2] + "</span></button>";
    }).join("");

    var rows = list.map(function (n) {
      var prop = LHMS.get.property(n.propertyId);
      return '<div class="notif-item' + (n.read ? "" : " unread") + '" data-act="open-notif" data-id="' + n.id + '" data-link="' + ui.esc(n.link || "#/notifications") + '" role="button" tabindex="0">' +
        notifIcon(n.type) +
        '<div class="notif-body"><div class="row between" style="gap:10px;align-items:flex-start"><div><div class="notif-title">' + ui.esc(n.title) + '</div><div class="notif-detail">' + ui.esc(n.detail) + "</div></div>" +
        '<span class="tiny muted" style="white-space:nowrap">' + ago(n.at) + "</span></div>" +
        '<div class="row wrap" style="gap:6px;margin-top:8px">' + ui.chip(n.type, n.type === "SLA at risk" ? "red" : n.type === "VIP arrival" ? "gold" : "") + (prop ? '<span class="chip">' + ui.esc(prop.short) + "</span>" : "") +
        '<button class="btn sm ghost" data-act="mark-notif" data-id="' + n.id + '" data-read="' + (n.read ? "0" : "1") + '">' + (n.read ? "Mark unread" : "Mark read") + "</button></div></div></div>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Workspace · notifications",
      title: "Notifications",
      sub: "Operational alerts, guest occasions, service risks and system messages. " + unread.length + " unread across the group.",
      actions: '<button class="btn" data-act="mark-all-notif">' + ui.icon("checkCircle", 14) + ' Mark all read</button><a class="btn primary" href="#/manager">' + ui.icon("chart", 14) + " Manager dashboard</a>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Unread", unread.length, "Awaiting attention", { icon: "bell", accent: unread.length ? "accent-red" : "accent-green" }) +
        ui.kpi("All notifications", all.length, "Rolling alert history", { icon: "message" }) +
        ui.kpi("Guest occasions", all.filter(function (n) { return n.type === "VIP arrival"; }).length, "Recognition moments", { icon: "star" }) +
        ui.kpi("Service risks", all.filter(function (n) { return n.type === "SLA at risk" || n.type === "Maintenance"; }).length, "SLA and rooms", { icon: "alert" }) +
        ui.kpi("Delivery", prefs.email || prefs.whatsapp || prefs.push ? "Active" : "Paused", [prefs.email && "email", prefs.whatsapp && "WhatsApp", prefs.push && "push"].filter(Boolean).join(" · ") || "All channels off", { icon: "send" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        '<section class="card"><div class="row between wrap mb12"><div class="tabs">' + tabs + '</div><select class="select" style="max-width:180px" data-change="ntf-type"><option value="all">All types</option>' +
          Object.keys(types).sort().map(function (t) { return '<option' + (S.ntfType === t ? " selected" : "") + ">" + ui.esc(t) + "</option>"; }).join("") + "</select></div>" +
          (list.length ? '<div class="notif-list">' + rows + "</div>" : ui.empty("You are all caught up", "No notifications match this view.", "checkCircle")) +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("Delivery channels", '<div class="stack" style="gap:9px">' +
            [["email", "Email", "Operations and finance distribution"], ["whatsapp", "WhatsApp", "Guest requests and arrivals"], ["push", "In-app & push", "Duty manager devices"]].map(function (c) {
              return '<label class="check" style="justify-content:space-between"><span><b>' + c[1] + '</b><div class="tiny muted" style="font-weight:400">' + c[2] + '</div></span><input type="checkbox" data-ntf-pref="' + c[0] + '"' + (prefs[c[0]] ? " checked" : "") + ' style="width:16px;height:16px;accent-color:var(--gold)" /></label>';
            }).join("") + '<div class="detail-row"><dt>Daily digest</dt><dd>07:00 · GM &amp; HODs</dd></div></div>', "", "Choose how the team is reached", "send") +
          ui.sectionCard("Escalation policy", '<div class="stack" style="gap:0">' +
            '<div class="detail-row"><dt>Guest request</dt><dd>30 min · supervisor</dd></div>' +
            '<div class="detail-row"><dt>VIP arrival</dt><dd>2 h before · GM</dd></div>' +
            '<div class="detail-row"><dt>Out of order</dt><dd>Immediate · engineering</dd></div>' +
            '<div class="detail-row"><dt>Review ≤ 3★</dt><dd>24 h · duty manager</dd></div>' +
            '<div class="detail-row"><dt>Night audit</dt><dd>On close · finance</dd></div></div>', "", "Routing and response windows", "clock") +
          ui.sectionCard("Notification health", '<div class="stack" style="gap:0">' +
            '<div class="detail-row"><dt>Delivered (24h)</dt><dd>' + all.length + " alerts</dd></div>" +
            '<div class="detail-row"><dt>Read rate</dt><dd>' + Math.round((all.length - unread.length) / Math.max(1, all.length) * 100) + "%</dd></div>" +
            '<div class="detail-row"><dt>Failed deliveries</dt><dd><span class="chip green">0</span></dd></div>' +
            '<div class="detail-row"><dt>Quiet hours</dt><dd>23:00 – 06:00</dd></div></div>', "", "Messaging performance", "wifi") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     ACTIONS
     ============================================================ */
  function saveBrandIdentity(form) {
    if (!form || !form.reportValidity()) return;
    var d = Object.fromEntries(new FormData(form));
    var result = LHMS.actions.saveBranding(LHMS.get.property().id, {
      brandName: d.brandName, tagline: d.tagline
    });
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    LHMS.rerender();
    ui.toast(result.changed.length ? "Brand identity saved." : "Nothing changed.");
  }
  LHMS.forms = LHMS.forms || {};
  LHMS.forms.brand = saveBrandIdentity;

  // Files arrive as FileList objects, not arrays, and each has to be read
  // through the canvas before the store ever sees it. A file that fails to
  // read is named and skipped rather than taking the rest of the batch with it.
  function readBrandFiles(files, kind, cb) {
    var list = Array.prototype.slice.call(files || []);
    var out = [], i = 0;
    function next() {
      if (i >= list.length) { cb(out); return; }
      var file = list[i++];
      LHMS.brand.readFile(file, kind, function (err, result) {
        if (err) ui.toast(err, "error");
        else out.push(result);
        next();
      });
    }
    next();
  }

  Object.assign(LHMS.uiActions, {
    "switch-property": function (el) {
      LHMS.switchProperty(el.getAttribute("data-property"));
      LHMS.rerender();
    },

    "new-staff": function () { staffModal(null); },
    "edit-staff": function (el) {
      var s = db.staff.find(function (x) { return x.id === el.getAttribute("data-staff"); });
      if (s) staffModal(s);
    },
    "save-staff": function () {
      var form = document.querySelector('form[data-form="staff"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      if (d.staffId) {
        var s = db.staff.find(function (x) { return x.id === d.staffId; });
        if (!s) return;
        Object.keys(d).forEach(function (k) { if (k !== "staffId") s[k] = d[k]; });
        LHMS.log("updated a staff account", "staff", s.name + " · " + s.role);
        ui.toast(s.name + " updated.");
      } else {
        var staff = {
          id: U.uid("stf"), propertyId: LHMS.session.propertyId, name: d.name, email: d.email,
          role: d.role, department: d.department, title: d.title || d.role, phone: d.phone,
          shift: d.shift || "08:00 – 17:00", status: "Active", started: LHMS.day
        };
        db.staff.push(staff);
        LHMS.log("created a staff account", "staff", staff.name + " · " + staff.role);
        ui.toast("Account created for " + staff.name + ".");
      }
      LHMS.save(); ui.closeModal(); LHMS.rerender();
    },
    "toggle-staff": function (el) {
      var s = db.staff.find(function (x) { return x.id === el.getAttribute("data-staff"); });
      if (!s) return;
      if (s.name === LHMS.actorName()) { ui.toast("You cannot deactivate your own account.", "error"); return; }
      s.status = s.status === "Inactive" ? "Active" : "Inactive";
      LHMS.log(s.status === "Active" ? "re-activated a staff account" : "deactivated a staff account", "staff", s.name);
      LHMS.save(); LHMS.rerender();
      ui.toast(s.name + " is now " + s.status.toLowerCase() + ".");
    },
    "export-staff": function () {
      var rows = [["Name", "Email", "Role", "Department", "Title", "Shift", "Status", "Started"]];
      LHMS.staffOf().forEach(function (s) { rows.push([s.name, s.email, s.role, s.department, s.title, s.shift, s.status, s.started]); });
      ui.csv("aurelia-staff-" + LHMS.get.property().code + "-" + LHMS.day + ".csv", rows);
      ui.toast("Staff roster downloaded.");
    },
    "live:staff-search": function (val) {
      S.staffQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="staff-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:staff-dept": function (el) { S.staffDept = el.value; LHMS.rerender(); },
    "change:staff-role": function (el) { S.staffRole = el.value; LHMS.rerender(); },

    "setup-tab": function (el) { S.setupTab = el.getAttribute("data-tab"); LHMS.rerender(); },
    "save-hotel": function () {
      var form = document.querySelector('form[data-form="hotel-profile"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var p = LHMS.get.property();
      Object.keys(d).forEach(function (k) { p[k] = k === "star" ? Number(d[k]) : d[k]; });
      LHMS.log("updated the property profile", "settings", p.name);
      LHMS.save(); LHMS.rerender();
      ui.toast("Property profile saved.");
    },
    "save-brand": function () { saveBrandIdentity(document.querySelector('form[data-form="brand"]')); },
    "change:brand-logo": function (el) {
      var file = el.files && el.files[0];
      el.value = "";
      if (!file) return;
      LHMS.brand.readFile(file, "logo", function (err, out) {
        if (err) { ui.toast(err, "error"); return; }
        var cur = LHMS.get.branding();
        var result = LHMS.actions.saveBranding(LHMS.get.property().id, {
          logo: out.src, palette: out.palette, useColors: cur.useColors
        });
        if (!result.ok) { ui.toast(result.error, "error"); return; }
        LHMS.rerender();
        ui.toast(cur.useColors ? "Logo saved — its colours now dress the desk." : "Logo saved.");
      });
    },
    "brand-remove-logo": function () {
      var result = LHMS.actions.saveBranding(LHMS.get.property().id, { logo: "", palette: null });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast("Logo removed. The house palette is back.");
    },
    "change:brand-images": function (el) {
      var files = Array.prototype.slice.call(el.files || []);
      el.value = "";
      if (!files.length) return;
      var cur = LHMS.get.branding();
      var room = LHMS.BRAND_LIMITS.maxImages - cur.images.length;
      if (room <= 0) { ui.toast("The gallery already holds six images. Remove one first.", "error"); return; }
      if (files.length > room) {
        ui.toast("Only " + room + " more image" + (room === 1 ? "" : "s") + " will fit in the gallery.", "error");
        files = files.slice(0, room);
      }
      readBrandFiles(files, "image", function (out) {
        if (!out.length) return;
        var next = cur.images.concat(out.map(function (i) { return { src: i.src, name: i.name }; }));
        var result = LHMS.actions.saveBranding(LHMS.get.property().id, { images: next });
        if (!result.ok) { ui.toast(result.error, "error"); return; }
        LHMS.rerender();
        ui.toast(out.length + (out.length === 1 ? " image added." : " images added.") + " The landing page now shows " + (next.length === 1 ? "it" : "them") + ".");
      });
    },
    "brand-remove-image": function (el) {
      var index = Number(el.getAttribute("data-index"));
      var cur = LHMS.get.branding();
      if (!cur.images[index]) return;
      var next = cur.images.filter(function (_, i) { return i !== index; });
      var result = LHMS.actions.saveBranding(LHMS.get.property().id, { images: next });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast("Image removed.");
    },
    "brand-cover": function (el) {
      var index = Number(el.getAttribute("data-index"));
      var cur = LHMS.get.branding();
      if (!cur.images[index]) return;
      var next = cur.images.slice();
      var hit = next.splice(index, 1)[0];
      next.unshift(hit);
      var result = LHMS.actions.saveBranding(LHMS.get.property().id, { images: next });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast("That photo now leads the landing page.");
    },
    "brand-reextract": function () {
      var cur = LHMS.get.branding();
      if (!cur.logo) { ui.toast("Upload a logo first.", "error"); return; }
      if (!LHMS.brand || !LHMS.brand.paletteFromSrc) { ui.toast("This browser cannot read image colours.", "error"); return; }
      LHMS.brand.paletteFromSrc(cur.logo, function (err, palette) {
        if (err) { ui.toast(err, "error"); return; }
        var result = LHMS.actions.saveBranding(LHMS.get.property().id, { palette: palette, useColors: true });
        if (!result.ok) { ui.toast(result.error, "error"); return; }
        LHMS.rerender();
        ui.toast("Colours re-read from the logo.");
      });
    },
    "brand-clear-colours": function () {
      var result = LHMS.actions.saveBranding(LHMS.get.property().id, { palette: null, useColors: false });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast("The house palette is back. The logo stays.");
    },
    "change:brand-use-colors": function (el) {
      var result = LHMS.actions.saveBranding(LHMS.get.property().id, { useColors: !!el.checked });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast(el.checked ? "The system now follows the logo's colours." : "System colours returned to the house palette.");
    },
    "save-policy": function () {
      var form = document.querySelector('form[data-form="policy"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var result = LHMS.actions.saveSettings(LHMS.get.property().id, {
        depositPct: Number(d.depositPct), checkInTime: d.checkInTime, checkOutTime: d.checkOutTime,
        currency: d.currency, language: d.language, overbooking: Number(d.overbooking), cancellation: d.cancellation
      });
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast("Policies saved.");
    },
    "toggle-integration": function (el) {
      var key = el.getAttribute("data-key");
      var result = LHMS.actions.toggleIntegration(LHMS.get.property().id, key);
      if (!result.ok) { ui.toast(result.error, "error"); return; }
      LHMS.rerender();
      ui.toast((result.connected ? "Connected " : "Disconnected ") + key.replace(/([A-Z])/g, " $1").toLowerCase() + ".");
    },
    "live:act-search": function (val) {
      S.actQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="act-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:act-entity": function (el) { S.actEntity = el.value || "all"; LHMS.rerender(); },
    "change:act-actor": function (el) { S.actActor = el.value || "all"; LHMS.rerender(); },
    "clear-act-filters": function () {
      S.actQuery = ""; S.actEntity = "all"; S.actActor = "all"; LHMS.rerender();
    },
    "export-activity": function () {
      var rows = [["Timestamp", "Actor", "Action", "Entity", "Detail", "Property"]];
      db.activity.forEach(function (a) {
        var p = LHMS.get.property(a.propertyId);
        rows.push([a.at, a.actor, a.action, a.entity, a.detail, p ? p.name : "Group"]);
      });
      ui.csv("aurelia-audit-trail-" + LHMS.day + ".csv", rows);
      LHMS.log("exported the audit trail", "audit", db.activity.length + " records");
      LHMS.save();
      ui.toast("Audit trail downloaded.");
    },

    "ntf-tab": function (el) { S.ntfTab = el.getAttribute("data-tab"); LHMS.rerender(); },
    "change:ntf-type": function (el) { S.ntfType = el.value || "all"; LHMS.rerender(); },
    "open-notif": function (el) {
      var id = el.getAttribute("data-id");
      var link = el.getAttribute("data-link") || "#/notifications";
      LHMS.actions.markNotification(id, true);
      LHMS.go(link);
    },
    "mark-notif": function (el) {
      var read = el.getAttribute("data-read") === "1";
      LHMS.actions.markNotification(el.getAttribute("data-id"), read);
      LHMS.rerender();
      ui.toast(read ? "Marked as read." : "Marked as unread.");
    },
    "mark-all-notif": function () {
      LHMS.actions.markAllNotifications();
      LHMS.rerender();
      ui.toast("All notifications marked as read.");
    }
  });

  document.addEventListener("change", function (e) {
    var perm = e.target.closest("[data-perm]");
    if (perm) {
      LHMS.actions.setPermission(perm.getAttribute("data-role"), perm.getAttribute("data-perm-key"), perm.checked);
      ui.toast((perm.checked ? "Granted " : "Revoked ") + perm.getAttribute("data-perm-key").replace(/_/g, " ") + " for " + perm.getAttribute("data-role") + ".");
      return;
    }
    var pref = e.target.closest("[data-ntf-pref]");
    if (pref) {
      var s = LHMS.get.settings();
      var p = notifyPrefs();
      p[pref.getAttribute("data-ntf-pref")] = pref.checked;
      s.notifyPrefs = p;
      LHMS.save();
    }
  });
})();
