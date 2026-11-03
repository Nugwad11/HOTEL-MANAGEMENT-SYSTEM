/* ============================================================
   LHMS — document register
   Implements the document lifecycle per the PRD flowchart:
     Capture & classify → Secure document store → Role check
     → View/sign · Export · Send to guest → Retention review
   Metadata-only register — no file contents are stored in this build.
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var ui = LHMS.ui;
  var U = LHMS.util;
  var db = LHMS.db;
  var session = LHMS.session;

  var S = (LHMS.state = LHMS.state || {});
  if (!S.docTab) S.docTab = "active";
  if (!S.docQuery) S.docQuery = "";
  if (!S.docCategory) S.docCategory = "all";

  /* ---------------- date helpers ---------------- */
  function dateOnly(d) { return d.toISOString().slice(0, 10); }
  function addYears(date, years) {
    var d = new Date(date + "T12:00:00");
    d.setFullYear(d.getFullYear() + years);
    return dateOnly(d);
  }

  /* ============================================================
     DOCUMENT SOURCES (the top row of the flowchart)
     Each source maps to a default category and retention period.
     ============================================================ */
  var DOCUMENT_SOURCES = [
    { key: "frontdesk",   label: "Front desk",   icon: "users",    defaultCategory: "Registration",   retentionYears: 7 },
    { key: "events",      label: "Events",        icon: "calendar", defaultCategory: "Events",         retentionYears: 7 },
    { key: "billing",     label: "Billing",       icon: "receipt",  defaultCategory: "Billing",        retentionYears: 7 },
    { key: "spa",         label: "Spa & consent", icon: "sparkles", defaultCategory: "Spa & consent",  retentionYears: 2 }
  ];

  var DOCUMENT_CATEGORIES = ["Registration", "Billing", "Spa & consent", "Events", "Booking", "Housekeeping", "Maintenance"];

  /* ============================================================
     SEED DATA
     ============================================================ */
  function seedDocuments() {
    if (Array.isArray(db.documents)) return;
    var today = dateOnly(new Date());
    db.documents = [];
    db.properties.forEach(function (property) {
      var reservations = db.reservations.filter(function (r) { return r.propertyId === property.id; });
      var inHouseRes = reservations.find(function (r) { return r.status === "In-house" && r.guestId === "gst_1"; }) ||
        reservations.find(function (r) { return r.status === "In-house"; });
      var anyRes = inHouseRes || reservations[0] || null;
      var guest = anyRes ? LHMS.get.guest(anyRes.guestId) : db.guests[0];
      var guestId = guest ? guest.id : null;
      var reservationId = anyRes ? anyRes.id : null;

      var samples = [
        { name: "Digital registration card",    category: "Registration",  source: "Front desk",     sourceKey: "frontdesk", status: "Awaiting signature", retentionYears: 7, guestVisible: true  },
        { name: "Guest folio summary",           category: "Billing",       source: "Billing",        sourceKey: "billing",   status: "Ready",               retentionYears: 7, guestVisible: true  },
        { name: "Spa intake & consent",          category: "Spa & consent", source: "Spa / wellness", sourceKey: "spa",       status: "Awaiting signature", retentionYears: 2, guestVisible: true  },
        { name: "Banquet event order",           category: "Events",        source: "Events",         sourceKey: "events",    status: "Draft",              retentionYears: 7, guestVisible: false },
        { name: "Airport transfer invoice",      category: "Billing",       source: "Billing",        sourceKey: "billing",   status: "Ready",               retentionYears: 7, guestVisible: true  },
        { name: "Complimentary upgrade receipt", category: "Billing",       source: "Front desk",     sourceKey: "frontdesk", status: "Ready",               retentionYears: 7, guestVisible: true  }
      ];

      samples.forEach(function (sample, i) {
        db.documents.push({
          id: "doc_" + property.id + "_" + (i + 1),
          propertyId: property.id,
          guestId: guestId,
          reservationId: reservationId,
          name: sample.name,
          category: sample.category,
          source: sample.source,
          sourceKey: sample.sourceKey,
          status: sample.status,
          createdAt: today,
          createdBy: "System seed",
          retentionUntil: addYears(today, sample.retentionYears),
          retentionYears: sample.retentionYears,
          guestVisible: sample.guestVisible,
          signedAt: null,
          signedBy: "",
          sentAt: null,
          archivedAt: null,
          notes: ""
        });
      });
    });
    LHMS.save();
  }
  seedDocuments();

  /* ============================================================
     RBAC — role-permitted categories and actions
     Mirrors the "Role permits?" diamond in the flowchart.
     ============================================================ */
  var roleCategories = {
    "Front Desk": ["Registration", "Billing", "Spa & consent", "Events", "Booking"],
    Revenue:      ["Billing", "Booking"],
    // What the ledger is kept against: the money documents, and only those. The
    // desk still files them — this hand reads and exports what was filed.
    "Finance Manager": ["Billing"],
    Housekeeping: ["Housekeeping", "Maintenance"],
    Guest:        ["Registration", "Billing", "Spa & consent"]
  };

  function canAccess(doc, action) {
    if (!doc || doc.propertyId !== session.propertyId) return false;
    var role = session.role;
    if (action === "create") return role === "Manager" || role === "Front Desk" || role === "Revenue";
    if (action === "archive") return role === "Manager";
    if (action === "purge")   return role === "Manager";
    if (action === "sign") {
      if (role === "Manager" || role === "Front Desk") {
        return doc.category === "Registration" || doc.category === "Spa & consent";
      }
      return role === "Guest" && doc.guestVisible && doc.guestId === session.guestId &&
        (doc.category === "Registration" || doc.category === "Spa & consent");
    }
    if (action === "send") return (role === "Manager" || role === "Front Desk") && doc.guestVisible;
    if (action === "export") {
      if (role === "Manager") return true;
      return !!(roleCategories[role] && roleCategories[role].indexOf(doc.category) !== -1 && role !== "Guest");
    }
    if (action !== "view") return false;
    if (role === "Manager") return true;
    if (role === "Guest") {
      return !!(doc.guestVisible && doc.guestId === session.guestId &&
        roleCategories.Guest.indexOf(doc.category) !== -1);
    }
    return !!(roleCategories[role] && roleCategories[role].indexOf(doc.category) !== -1);
  }

  function findDoc(id) { return db.documents.find(function (d) { return d.id === id; }) || null; }
  function deny() { return { ok: false, error: "You do not have permission to perform this action." }; }

  /* ============================================================
     DOMAIN ACTIONS — written through the store layer so every
     change is logged and persisted in one place.
     ============================================================ */
  LHMS.documents = {
    canAccess: canAccess,

    // ---- READ ----
    visible: function (action) {
      return db.documents.filter(function (d) { return canAccess(d, action || "view"); });
    },
    get: findDoc,

    // ---- CAPTURE & CLASSIFY (flowchart step 2) ----
    create: function (data) {
      if (!canAccess({ propertyId: session.propertyId }, "create")) return deny();
      var name = String(data.name || "").trim();
      if (!name) return { ok: false, error: "Give the document a name." };
      var category = String(data.category || "");
      if (DOCUMENT_CATEGORIES.indexOf(category) === -1) return { ok: false, error: "Choose a category." };
      var today = dateOnly(new Date());
      var years = Math.max(1, Number(data.retentionYears) || 7);
      var doc = {
        id: U.uid("doc"),
        propertyId: session.propertyId,
        guestId: data.guestId || null,
        reservationId: data.reservationId || null,
        name: name,
        category: category,
        source: String(data.source || session.role),
        sourceKey: String(data.sourceKey || "frontdesk"),
        status: "Draft",
        createdAt: today,
        createdBy: LHMS.actorName ? LHMS.actorName() : session.name,
        retentionUntil: addYears(today, years),
        retentionYears: years,
        guestVisible: !!data.guestVisible,
        signedAt: null,
        signedBy: "",
        sentAt: null,
        archivedAt: null,
        notes: String(data.notes || "").trim()
      };
      db.documents.unshift(doc);
      LHMS.log("captured a document", "document", name + " · " + category, session.propertyId);
      LHMS.save();
      return { ok: true, document: doc };
    },

    // ---- SIGN (flowchart: View and sign) ----
    sign: function (id, signer) {
      var doc = findDoc(id);
      if (!canAccess(doc, "sign")) return deny();
      signer = String(signer || "").trim();
      if (!signer) return { ok: false, error: "Enter the signer's full name." };
      if (doc.signedAt) return { ok: false, error: "This document has already been signed." };
      doc.signedBy  = signer;
      doc.signedAt  = new Date().toISOString();
      doc.status    = "Signed";
      LHMS.log("signed a document", "document", doc.name + " · " + signer, doc.propertyId);
      LHMS.save();
      return { ok: true, document: doc };
    },

    // ---- SEND TO GUEST (flowchart: Send to guest) ----
    send: function (id) {
      var doc = findDoc(id);
      if (!canAccess(doc, "send")) return deny();
      doc.sentAt = new Date().toISOString();
      doc.status = doc.status === "Draft" ? "Delivery simulated" : doc.status;
      if (doc.status !== "Signed") doc.status = "Delivery simulated";
      LHMS.log("simulated document delivery", "document", doc.name + " · no message was sent", doc.propertyId);
      LHMS.save();
      return { ok: true, document: doc };
    },

    // ---- ARCHIVE (flowchart: Retention review → Archive) ----
    archive: function (id) {
      var doc = findDoc(id);
      if (!canAccess(doc, "archive")) return deny();
      if (doc.status === "Archived") return { ok: false, error: "This document is already archived." };
      doc.status     = "Archived";
      doc.archivedAt = new Date().toISOString();
      LHMS.log("archived a document", "document", doc.name, doc.propertyId);
      LHMS.save();
      return { ok: true, document: doc };
    },

    // ---- PURGE (flowchart: Retention review → Purge per policy) ----
    purge: function (id) {
      var doc = findDoc(id);
      if (!canAccess(doc, "purge")) return deny();
      if (doc.status !== "Archived") return { ok: false, error: "Only archived records can be purged." };
      db.documents = db.documents.filter(function (d) { return d.id !== id; });
      LHMS.log("purged a document record", "document", doc.name + " · metadata removed", doc.propertyId);
      LHMS.save();
      return { ok: true };
    }
  };

  /* ============================================================
     VIEW HELPERS
     ============================================================ */
  function retentionDue(doc) { return !!doc.retentionUntil && doc.retentionUntil <= dateOnly(new Date()); }
  function linkedGuest(doc) { return doc.guestId ? LHMS.get.guest(doc.guestId) : null; }
  function linkedReservation(doc) { return doc.reservationId ? LHMS.get.reservation(doc.reservationId) : null; }

  function statusChip(doc) {
    var map = {
      "Signed":              "green",
      "Ready":               "green",
      "Awaiting signature":  "violet",
      "Delivery simulated":  "blue",
      "Archived":            "navy",
      "Draft":               "amber"
    };
    return ui.chip(doc.status, map[doc.status] || "");
  }

  function sourceIcon(doc) {
    var src = DOCUMENT_SOURCES.find(function (s) { return s.key === doc.sourceKey; }) || DOCUMENT_SOURCES[0];
    return ui.icon(src.icon, 13);
  }

  function filteredDocs(tab) {
    var all = LHMS.documents.visible("view");
    if (tab === "active")    all = all.filter(function (d) { return d.status !== "Archived"; });
    if (tab === "archived")  all = all.filter(function (d) { return d.status === "Archived"; });
    if (tab === "retention") all = all.filter(function (d) { return retentionDue(d) || d.status === "Archived"; });

    if (S.docCategory !== "all") all = all.filter(function (d) { return d.category === S.docCategory; });
    if (S.docQuery) {
      var q = S.docQuery.toLowerCase();
      all = all.filter(function (d) {
        var g = linkedGuest(d);
        return (d.name + " " + d.category + " " + d.source + " " + (g ? g.name : "")).toLowerCase().indexOf(q) !== -1;
      });
    }
    return all;
  }

  function documentRows(docs) {
    if (!docs.length) {
      return '<tr><td colspan="7">' + ui.empty("No accessible records", "No document metadata is available for your role.", "lock") + "</td></tr>";
    }
    return docs.map(function (doc) {
      var guest = linkedGuest(doc);
      var res   = linkedReservation(doc);
      var actionBtns = '<button class="btn sm" data-act="document-open" data-doc="' + ui.esc(doc.id) + '">Open</button>';
      if (canAccess(doc, "sign") && !doc.signedAt) {
        actionBtns += ' <button class="btn sm primary" data-act="document-sign" data-doc="' + ui.esc(doc.id) + '">Sign</button>';
      }
      if (canAccess(doc, "send")) {
        actionBtns += ' <button class="btn sm" data-act="document-send" data-doc="' + ui.esc(doc.id) + '">' + ui.icon("send", 11) + ' Send</button>';
      }
      return '<tr>' +
        '<td><div class="row" style="gap:7px;align-items:flex-start">' + sourceIcon(doc) +
          '<div><b>' + ui.esc(doc.name) + '</b><div class="tiny muted">' + ui.esc(doc.source) + (doc.notes ? ' · ' + ui.esc(doc.notes.slice(0, 40)) : '') + '</div></div></div></td>' +
        '<td><span class="chip">' + ui.esc(doc.category) + '</span></td>' +
        '<td>' + (guest ? ui.esc(guest.name) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + (res ? '<span class="mono small">' + ui.esc(res.reference) + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + statusChip(doc) + (doc.guestVisible ? ' <span class="chip" title="Visible to guest">' + ui.icon("user", 10) + '</span>' : '') + '</td>' +
        '<td>' + (retentionDue(doc)
          ? '<span class="chip red">Review due</span>'
          : '<span class="tiny muted">' + ui.esc(doc.retentionUntil || '—') + '</span>') + '</td>' +
        '<td class="right">' + actionBtns + '</td>' +
      '</tr>';
    }).join("");
  }

  /* ============================================================
     PAGE
     ============================================================ */
  LHMS.pages.documents = function () {
    var allVisible  = LHMS.documents.visible("view");
    var active      = allVisible.filter(function (d) { return d.status !== "Archived"; });
    var archived    = allVisible.filter(function (d) { return d.status === "Archived"; });
    var awaiting    = active.filter(function (d) { return d.status === "Awaiting signature"; }).length;
    var reviewDue   = allVisible.filter(retentionDue).length;
    var canCreate   = canAccess({ propertyId: session.propertyId }, "create");
    var canExport   = LHMS.documents.visible("export").length > 0;
    var property    = LHMS.get.property();
    var tab         = S.docTab || "active";
    var docs        = filteredDocs(tab);

    var tabs = [
      { key: "active",    label: "Active",           n: active.length },
      { key: "archived",  label: "Archived",          n: archived.length },
      { key: "retention", label: "Retention review",  n: reviewDue }
    ].map(function (t) {
      return '<button class="tab' + (tab === t.key ? " active" : "") + '" data-act="doc-tab" data-tab="' + t.key + '">' +
        t.label + '<span class="count">' + t.n + "</span></button>";
    }).join("");

    /* --- flowchart banner (visible for staff) --- */
    var flowBanner = session.role !== "Guest" ? (
      '<div class="card mb16" style="padding:14px 18px;background:linear-gradient(135deg,#1d3550 0%,#2a4a6a 100%);color:#fbf7ec;border:0">' +
        '<div class="row between" style="align-items:flex-start;flex-wrap:wrap;gap:12px">' +
          '<div>' +
            '<div class="eyebrow" style="color:var(--gold);margin-bottom:4px">Document lifecycle</div>' +
            '<div class="row" style="gap:6px;align-items:center;flex-wrap:wrap;font-size:11px;color:#a9bacb">' +
              DOCUMENT_SOURCES.map(function (s) {
                return '<span class="chip" style="background:rgba(255,255,255,.1);color:#fbf7ec;border:0">' + ui.icon(s.icon, 11) + ' ' + s.label + '</span>';
              }).join('<span style="color:#8fa0b3">→</span>') +
              '<span style="color:#8fa0b3">→</span>' +
              '<span class="chip" style="background:rgba(255,255,255,.1);color:#fbf7ec;border:0">' + ui.icon("lock", 11) + ' Secure store</span>' +
              '<span style="color:#8fa0b3">→</span>' +
              '<span class="chip green" style="background:rgba(53,99,71,.7);border:0">' + ui.icon("shield", 11) + ' Role check</span>' +
              '<span style="color:#8fa0b3">→</span>' +
              '<span class="chip" style="background:var(--gold-fade-1);color:var(--gold-2);border:0">' + ui.icon("edit", 11) + ' Sign · Export · Send</span>' +
              '<span style="color:#8fa0b3">→</span>' +
              '<span class="chip" style="background:rgba(255,255,255,.1);color:#fbf7ec;border:0">' + ui.icon("clock", 11) + ' Retention review</span>' +
            '</div>' +
          '</div>' +
          (canCreate ? '<button class="btn primary" data-act="document-create">' + ui.icon("plus", 13) + ' Capture document</button>' : '') +
        '</div>' +
      '</div>'
    ) : "";

    /* --- retention tab view --- */
    var bodyContent;
    if (tab === "retention") {
      bodyContent = retentionReviewSection(docs);
    } else {
      bodyContent = (
        '<div class="table-wrap"><table class="data">' +
          '<thead><tr>' +
            '<th>Document</th><th>Category</th><th>Guest</th>' +
            '<th>Booking</th><th>Status</th><th>Retention review</th><th class="right">Actions</th>' +
          '</tr></thead>' +
          '<tbody>' + documentRows(docs) + '</tbody>' +
        '</table></div>'
      );
    }

    return ui.pageHead({
      eyebrow: "Hotel · records · " + property.short,
      title: "Document register",
      sub: "Guest, operational and finance records — role-filtered, audited, retention-tagged.",
      actions: (canExport ? '<button class="btn" data-act="document-export">' + ui.icon("download", 14) + ' Export CSV</button>' : "")
    }) +
      '<div class="notice danger" role="note" style="margin-bottom:14px">' + ui.icon("lock") +
        '<div><b>Metadata only.</b> No file contents are stored in this build. Do not add real identity, health, payment or guest document contents.</div>' +
      '</div>' +
      flowBanner +
      '<div class="kpis">' +
        ui.kpi("Accessible records", active.length, "Signed and awaiting", { icon: "file" }) +
        ui.kpi("Awaiting signature", awaiting, "Pending guest or staff sign-off", { icon: "edit", accent: awaiting ? "accent-red" : "" }) +
        ui.kpi("Retention review due", reviewDue, archived.length + " archived", { icon: "clock", accent: reviewDue ? "accent-red" : "" }) +
        ui.kpi("Guest-visible", active.filter(function (d) { return d.guestVisible; }).length, "Shared with guest app", { icon: "user" }) +
      "</div>" +
      '<section class="card">' +
        '<div class="toolbar">' +
          '<div class="tabs">' + tabs + '</div>' +
          ui.searchField("Search by name, category or source", S.docQuery, "doc-search") +
          '<select class="select" style="max-width:180px" data-change="doc-category">' +
            '<option value="all">All categories</option>' +
            DOCUMENT_CATEGORIES.map(function (c) {
              return '<option' + (S.docCategory === c ? " selected" : "") + ">" + ui.esc(c) + "</option>";
            }).join("") +
          '</select>' +
          '<span class="spacer"></span>' +
          '<span class="tiny muted">' + docs.length + ' records</span>' +
        '</div>' +
        bodyContent +
      '</section>' +
      '<p class="tiny muted" style="margin-top:10px">Retention dates are defaults. Configure them for your jurisdiction before production use.</p>';
  };

  /* ============================================================
     RETENTION REVIEW SECTION
     Implements the bottom box of the flowchart.
     ============================================================ */
  function retentionReviewSection(docs) {
    var due    = docs.filter(function (d) { return retentionDue(d) && d.status !== "Archived"; });
    var arch   = docs.filter(function (d) { return d.status === "Archived"; });
    var canPurge = session.role === "Manager";

    if (!due.length && !arch.length) {
      return ui.empty("No records due for review", "All documents are within their retention window.", "checkCircle");
    }

    function retentionRow(doc, showPurge) {
      var guest = linkedGuest(doc);
      var actions = '<button class="btn sm" data-act="document-open" data-doc="' + ui.esc(doc.id) + '">Open</button>';
      if (canAccess(doc, "archive") && doc.status !== "Archived") {
        actions += ' <button class="btn sm" data-act="document-archive" data-doc="' + ui.esc(doc.id) + '">Archive</button>';
      }
      if (showPurge && canPurge && doc.status === "Archived") {
        actions += ' <button class="btn sm danger" data-act="document-purge" data-doc="' + ui.esc(doc.id) + '">Purge</button>';
      }
      return '<tr>' +
        '<td><b>' + ui.esc(doc.name) + '</b><div class="tiny muted">' + ui.esc(doc.category) + '</div></td>' +
        '<td>' + (guest ? ui.esc(guest.name) : '—') + '</td>' +
        '<td>' + statusChip(doc) + '</td>' +
        '<td class="num">' + ui.esc(doc.retentionYears || '—') + ' yr</td>' +
        '<td>' + (doc.retentionUntil ? '<span class="chip red">' + ui.esc(doc.retentionUntil) + '</span>' : '—') + '</td>' +
        '<td class="right">' + actions + '</td>' +
      '</tr>';
    }

    var html = '';

    if (due.length) {
      html += '<div class="notice danger mb12">' + ui.icon("alert") +
        '<div><b>' + due.length + ' record' + (due.length > 1 ? 's' : '') + ' due for retention review.</b> ' +
        'Review each record against your policy and archive or renew the retention date. Manager role required to archive.</div></div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Document</th><th>Guest</th><th>Status</th><th class="right">Retention</th><th>Review date</th><th class="right">Actions</th>' +
        '</tr></thead><tbody>' +
        due.map(function (d) { return retentionRow(d, false); }).join("") +
        '</tbody></table></div>';
    }

    if (arch.length) {
      html += '<div class="card-title mt16">' + ui.icon("box", 14) + 'Archived records' +
        (canPurge ? '<span class="tiny muted" style="font-weight:400;margin-left:8px">Manager can purge to remove metadata permanently.</span>' : '') +
        '</div>' +
        '<div class="table-wrap"><table class="data"><thead><tr>' +
          '<th>Document</th><th>Guest</th><th>Status</th><th class="right">Retention</th><th>Archived on</th><th class="right">Actions</th>' +
        '</tr></thead><tbody>' +
        arch.map(function (d) {
          var guest = linkedGuest(d);
          var actions = '<button class="btn sm" data-act="document-open" data-doc="' + ui.esc(d.id) + '">Open</button>';
          if (canPurge) actions += ' <button class="btn sm danger" data-act="document-purge" data-doc="' + ui.esc(d.id) + '">Purge</button>';
          return '<tr>' +
            '<td><b>' + ui.esc(d.name) + '</b><div class="tiny muted">' + ui.esc(d.category) + '</div></td>' +
            '<td>' + (guest ? ui.esc(guest.name) : '—') + '</td>' +
            '<td>' + statusChip(d) + '</td>' +
            '<td class="num">' + ui.esc(d.retentionYears || '—') + ' yr</td>' +
            '<td class="tiny muted">' + (d.archivedAt ? ui.esc(d.archivedAt.slice(0, 10)) : '—') + '</td>' +
            '<td class="right">' + actions + '</td>' +
          '</tr>';
        }).join("") +
        '</tbody></table></div>';
    }

    return html;
  }

  /* ============================================================
     DOCUMENT DETAIL MODAL
     Shows the full flowchart path with actions at each stage.
     ============================================================ */
  function openDocument(id) {
    var doc = findDoc(id);
    if (!canAccess(doc, "view")) { ui.toast("You do not have permission to view this record.", "error"); return; }
    LHMS.log("viewed a document", "document", doc.name, doc.propertyId);
    LHMS.save();

    var guest = linkedGuest(doc);
    var res   = linkedReservation(doc);

    /* --- role check section --- */
    var roleOk  = canAccess(doc, "view");
    var roleSub = roleOk
      ? '<span class="chip green">' + ui.icon("checkCircle", 11) + ' ' + ui.esc(session.role) + ' — access granted</span>'
      : '<span class="chip red">' + ui.icon("alert", 11) + ' Access denied — logged</span>';

    /* --- available actions per flowchart branch --- */
    var signSection = "";
    if (canAccess(doc, "sign")) {
      if (doc.signedAt) {
        signSection = '<div class="detail-row"><dt>' + ui.icon("edit", 12) + ' Signed by</dt><dd><b>' + ui.esc(doc.signedBy) + '</b><div class="tiny muted">' + new Date(doc.signedAt).toLocaleString() + '</div></dd></div>';
      } else {
        signSection = '<div class="detail-row"><dt>' + ui.icon("edit", 12) + ' Signature</dt><dd>' +
          '<button class="btn sm primary" data-act="document-sign" data-doc="' + ui.esc(doc.id) + '">Record signature</button></dd></div>';
      }
    }

    var sendSection = canAccess(doc, "send")
      ? '<div class="detail-row"><dt>' + ui.icon("send", 12) + ' Send to guest</dt><dd>' +
          (doc.sentAt
            ? '<span class="chip blue">Delivery simulated ' + doc.sentAt.slice(0, 10) + '</span>'
            : '<button class="btn sm" data-act="document-send" data-doc="' + ui.esc(doc.id) + '">Simulate delivery</button>') +
        '</dd></div>'
      : "";

    var exportSection = canAccess(doc, "export")
      ? '<div class="detail-row"><dt>' + ui.icon("download", 12) + ' Export</dt><dd>' +
          '<button class="btn sm" data-act="document-export-one" data-doc="' + ui.esc(doc.id) + '">Export metadata CSV</button>' +
        '</dd></div>'
      : "";

    var archiveSection = (canAccess(doc, "archive") && doc.status !== "Archived")
      ? '<div class="detail-row" style="margin-top:8px"><dt>' + ui.icon("box", 12) + ' Retention</dt><dd>' +
          '<button class="btn sm" data-act="document-archive" data-doc="' + ui.esc(doc.id) + '">Archive record</button>' +
        '</dd></div>'
      : (doc.status === "Archived"
          ? '<div class="detail-row"><dt>' + ui.icon("box", 12) + ' Retention</dt><dd><span class="chip navy">Archived ' + (doc.archivedAt ? doc.archivedAt.slice(0, 10) : '') + '</span>' +
              (session.role === "Manager" ? ' <button class="btn sm danger" data-act="document-purge" data-doc="' + ui.esc(doc.id) + '">Purge</button>' : '') +
            '</dd></div>'
          : '');

    ui.modal({
      title: doc.name,
      sub: doc.category + " · " + doc.source,
      wide: true,
      body:
        '<div class="notice info" style="margin-bottom:12px">' + ui.icon("file") +
          '<div>Metadata only. No file attachment is stored in this build.</div>' +
        '</div>' +

        /* STEP 1 — Capture & classify */
        '<div class="panel mb12"><div class="panel-title" style="color:var(--gold)">' + ui.icon("tag", 12) + ' 1 — Captured &amp; classified</div>' +
          '<div class="detail-list" style="gap:4px">' +
            '<div class="detail-row"><dt>Source</dt><dd>' + ui.esc(doc.source) + '</dd></div>' +
            '<div class="detail-row"><dt>Category</dt><dd><span class="chip">' + ui.esc(doc.category) + '</span></dd></div>' +
            '<div class="detail-row"><dt>Guest link</dt><dd>' + (guest ? ui.esc(guest.name) : '—') + '</dd></div>' +
            '<div class="detail-row"><dt>Booking link</dt><dd>' + (res ? '<span class="mono">' + ui.esc(res.reference) + '</span>' : '—') + '</dd></div>' +
            '<div class="detail-row"><dt>Guest-visible</dt><dd>' + (doc.guestVisible ? '<span class="chip green">Yes — shows in guest app</span>' : '<span class="chip">No — staff only</span>') + '</dd></div>' +
          '</div>' +
        '</div>' +

        /* STEP 2 — Secure store */
        '<div class="panel mb12"><div class="panel-title" style="color:var(--navy-4)">' + ui.icon("lock", 12) + ' 2 — Secure document store</div>' +
          '<div class="detail-list" style="gap:4px">' +
            '<div class="detail-row"><dt>Created</dt><dd>' + ui.esc(doc.createdAt) + (doc.createdBy ? ' · ' + ui.esc(doc.createdBy) : '') + '</dd></div>' +
            '<div class="detail-row"><dt>Status</dt><dd>' + statusChip(doc) + '</dd></div>' +
            '<div class="detail-row"><dt>Retention review</dt><dd>' + (retentionDue(doc) ? '<span class="chip red">Due — ' + ui.esc(doc.retentionUntil) + '</span>' : ui.esc(doc.retentionUntil || 'Not set')) + '</dd></div>' +
            (doc.notes ? '<div class="detail-row"><dt>Notes</dt><dd class="small">' + ui.esc(doc.notes) + '</dd></div>' : '') +
          '</div>' +
        '</div>' +

        /* STEP 3 — Role check */
        '<div class="panel mb12"><div class="panel-title" style="color:#356347">' + ui.icon("shield", 12) + ' 3 — Role check</div>' +
          '<div class="detail-list" style="gap:4px">' +
            '<div class="detail-row"><dt>Access decision</dt><dd>' + roleSub + '</dd></div>' +
          '</div>' +
        '</div>' +

        /* STEP 4 — Actions */
        '<div class="panel mb12"><div class="panel-title" style="color:var(--gold)">' + ui.icon("checkCircle", 12) + ' 4 — Available actions</div>' +
          '<div class="detail-list" style="gap:6px">' +
            signSection +
            exportSection +
            sendSection +
            (!signSection && !exportSection && !sendSection ? '<div class="detail-row"><dt></dt><dd class="tiny muted">No actions available for your role on this document.</dd></div>' : '') +
          '</div>' +
        '</div>' +

        /* STEP 5 — Retention */
        (archiveSection ? '<div class="panel"><div class="panel-title">' + ui.icon("clock", 12) + ' 5 — Retention review</div><div class="detail-list" style="gap:4px">' + archiveSection + '</div></div>' : ''),

      footer: '<button class="btn" data-close-modal>Close</button>'
    });
  }

  /* ============================================================
     CAPTURE & CLASSIFY MODAL
     The top part of the flowchart — creates a new document record.
     ============================================================ */
  function openCreateModal() {
    var resList = LHMS.reservationsOf(session.propertyId)
      .filter(function (r) { return r.status === "In-house" || r.status === "Confirmed"; })
      .slice(0, 30);

    var sourceOptions = DOCUMENT_SOURCES.map(function (s) {
      return '<option value="' + s.key + '" data-default-cat="' + s.defaultCategory + '" data-retention-years="' + s.retentionYears + '">' + s.label + '</option>';
    }).join("");

    var categoryOptions = DOCUMENT_CATEGORIES.map(function (c) {
      return '<option>' + ui.esc(c) + '</option>';
    }).join("");

    var guestOptions = '<option value="">— No guest linked —</option>';
    var seenGuests = {};
    resList.forEach(function (r) {
      var g = LHMS.get.guest(r.guestId);
      if (g && !seenGuests[g.id]) {
        seenGuests[g.id] = true;
        guestOptions += '<option value="' + ui.esc(g.id) + '">' + ui.esc(g.name) + '</option>';
      }
    });

    var resOptions = '<option value="">— No booking linked —</option>';
    resList.forEach(function (r) {
      var g = LHMS.get.guest(r.guestId);
      resOptions += '<option value="' + ui.esc(r.id) + '">' + ui.esc(r.reference) + (g ? ' · ' + ui.esc(g.name) : '') + '</option>';
    });

    ui.modal({
      title: "Capture & classify document",
      sub: "Tag the type and link to a guest profile, folio or booking",
      wide: true,
      body:
        '<div class="notice info mb12">' + ui.icon("lock") +
          '<div>This creates a metadata record only. No file is uploaded or stored here.</div>' +
        '</div>' +
        '<form data-form="document-create" class="form-grid">' +
          '<div class="field span2"><label>Document name <span style="color:var(--red)">*</span></label>' +
            '<input name="name" required placeholder="e.g. Digital registration card · Adaeze Nwankwo" /></div>' +
          '<div class="field"><label>Source <span style="color:var(--red)">*</span></label>' +
            '<select name="sourceKey" id="doc-source-sel">' + sourceOptions + '</select></div>' +
          '<div class="field"><label>Category <span style="color:var(--red)">*</span></label>' +
            '<select name="category" id="doc-cat-sel">' + categoryOptions + '</select></div>' +
          '<div class="field"><label>Link to guest</label>' +
            '<select name="guestId">' + guestOptions + '</select></div>' +
          '<div class="field"><label>Link to booking</label>' +
            '<select name="reservationId">' + resOptions + '</select></div>' +
          '<div class="field"><label>Retention (years)</label>' +
            '<input name="retentionYears" type="number" min="1" max="30" value="7" /></div>' +
          '<div class="field"><label>Guest-visible</label>' +
            '<label class="check" style="margin-top:6px"><input type="checkbox" name="guestVisible" value="1" /> Show this record in the guest app</label></div>' +
          '<div class="field span2"><label>Notes</label>' +
            '<textarea name="notes" rows="2" placeholder="Access level, reference number, version…"></textarea></div>' +
        '</form>',
      footer:
        '<button class="btn" data-close-modal>Cancel</button>' +
        '<button class="btn primary" data-act="document-create-save">Capture document</button>'
    });
  }

  /* ============================================================
     ACTIONS
     ============================================================ */
  LHMS.uiActions["doc-tab"] = function (el) {
    S.docTab = el.getAttribute("data-tab") || "active";
    LHMS.rerender();
  };
  LHMS.uiActions["live:doc-search"] = function (val) {
    S.docQuery = val;
    LHMS.rerender();
    setTimeout(function () {
      var f = document.querySelector('[data-live="doc-search"]');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    }, 10);
  };
  LHMS.uiActions["change:doc-category"] = function (el) {
    S.docCategory = el.value;
    LHMS.rerender();
  };

  LHMS.uiActions["document-open"] = function (el) { openDocument(el.getAttribute("data-doc")); };

  LHMS.uiActions["document-create"] = function () { openCreateModal(); };

  LHMS.uiActions["document-create-save"] = function () {
    var form = document.querySelector('form[data-form="document-create"]');
    if (!form || !form.reportValidity()) return;
    var fd = new FormData(form);
    var srcEl = document.getElementById("doc-source-sel");
    var srcOption = srcEl && srcEl.options[srcEl.selectedIndex];
    var result = LHMS.documents.create({
      name:          fd.get("name"),
      sourceKey:     fd.get("sourceKey"),
      source:        srcOption ? srcOption.text : fd.get("sourceKey"),
      category:      fd.get("category"),
      guestId:       fd.get("guestId") || null,
      reservationId: fd.get("reservationId") || null,
      retentionYears: Number(fd.get("retentionYears")) || 7,
      guestVisible:  !!fd.get("guestVisible"),
      notes:         fd.get("notes") || ""
    });
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal();
    ui.toast("Document record captured and classified.");
    LHMS.rerender();
  };

  LHMS.uiActions["document-sign"] = function (el) {
    var doc = findDoc(el.getAttribute("data-doc"));
    if (!canAccess(doc, "sign")) { ui.toast("You cannot sign this record.", "error"); return; }
    ui.modal({
      title: "Sign — " + doc.name,
      sub: "Type the signer's full name. The signature and timestamp are recorded in the audit log.",
      slim: true,
      body:
        '<form data-form="document-sign">' +
          '<input type="hidden" name="docId" value="' + ui.esc(doc.id) + '"/>' +
          '<div class="field">' +
            '<label for="document-signer">Signer full name <span style="color:var(--red)">*</span></label>' +
            '<input id="document-signer" name="signer" required autocomplete="name" placeholder="e.g. Adaeze Nwankwo" />' +
          '</div>' +
          '<p class="tiny muted mt8">This is not a legally binding e-signature.</p>' +
          '<div class="row mt16" style="justify-content:flex-end">' +
            '<button type="button" class="btn" data-close-modal>Cancel</button>' +
            '<button type="submit" class="btn primary">Record signature</button>' +
          '</div>' +
        '</form>'
    });
  };
  LHMS.forms["document-sign"] = function (form) {
    var data = new FormData(form);
    var result = LHMS.documents.sign(data.get("docId"), data.get("signer"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal();
    ui.toast("Signature recorded.");
    LHMS.rerender();
  };

  LHMS.uiActions["document-send"] = function (el) {
    var result = LHMS.documents.send(el.getAttribute("data-doc"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal();
    ui.toast("Delivery simulated — no email or message was sent.");
    LHMS.rerender();
  };

  LHMS.uiActions["document-archive"] = function (el) {
    var id = el.getAttribute("data-doc");
    var doc = findDoc(id);
    if (!canAccess(doc, "archive")) { ui.toast("Only a manager can archive records.", "error"); return; }
    ui.confirm({
      title: "Archive this record?",
      body: doc.name + " will be moved to the archived register. The metadata is preserved and remains in the audit trail.",
      label: "Archive",
      id: "doc-archive-" + id,
      danger: false
    });
    // Handled by the delegated confirm listener below
  };
  LHMS.uiActions["document-archive-confirm"] = function (el) {
    var result = LHMS.documents.archive(el.getAttribute("data-doc"));
    if (!result.ok) { ui.toast(result.error, "error"); return; }
    ui.closeModal();
    ui.toast("Record archived. The action was logged.");
    LHMS.rerender();
  };

  LHMS.uiActions["document-purge"] = function (el) {
    var id  = el.getAttribute("data-doc");
    var doc = findDoc(id);
    if (!doc) { ui.toast("Record not found.", "error"); return; }
    ui.confirm({
      title: "Purge this record permanently?",
      body: doc.name + " — all metadata will be removed from this workspace. This cannot be undone.",
      label: "Purge record",
      id: "doc-purge-" + id,
      danger: true
    });
  };

  LHMS.uiActions["document-export"] = function () {
    var docs = LHMS.documents.visible("export");
    if (!docs.length) { ui.toast("No records available for export.", "error"); return; }
    var rows = [["Name", "Category", "Source", "Guest", "Reservation", "Status", "Created by", "Created", "Retention review", "Signed by", "Signed at", "Sent at", "Archived at"]];
    docs.forEach(function (doc) {
      var g = linkedGuest(doc), r = linkedReservation(doc);
      rows.push([
        doc.name, doc.category, doc.source,
        g ? g.name : "", r ? r.reference : "",
        doc.status, doc.createdBy || "", doc.createdAt, doc.retentionUntil || "",
        doc.signedBy || "", doc.signedAt ? doc.signedAt.slice(0, 10) : "",
        doc.sentAt ? doc.sentAt.slice(0, 10) : "",
        doc.archivedAt ? doc.archivedAt.slice(0, 10) : ""
      ]);
    });
    ui.csv("aurelia-document-register-" + LHMS.get.property().code + "-" + (dateOnly(new Date())) + ".csv", rows);
    LHMS.log("exported document register", "document", docs.length + " metadata records");
    LHMS.save();
    ui.toast("Document register exported.");
  };

  LHMS.uiActions["document-export-one"] = function (el) {
    var doc = findDoc(el.getAttribute("data-doc"));
    if (!canAccess(doc, "export")) { ui.toast("You cannot export this record.", "error"); return; }
    var g = linkedGuest(doc), r = linkedReservation(doc);
    ui.csv("aurelia-doc-metadata.csv", [
      ["Name", "Category", "Source", "Guest", "Reservation", "Status", "Created", "Retention review"],
      [doc.name, doc.category, doc.source, g ? g.name : "", r ? r.reference : "", doc.status, doc.createdAt, doc.retentionUntil]
    ]);
    LHMS.log("exported document metadata", "document", doc.name, doc.propertyId);
    LHMS.save();
  };

  /* Delegated confirm listener for archive and purge — browser only */
  if (typeof document !== "undefined") {
    document.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-confirm]");
      if (!btn) return;
      var id = btn.getAttribute("data-confirm");
      if (id && id.indexOf("doc-archive-") === 0) {
        var docId = id.replace("doc-archive-", "");
        var result = LHMS.documents.archive(docId);
        if (!result.ok) { ui.toast(result.error, "error"); }
        else ui.toast("Record archived.");
        ui.closeModal();
        LHMS.rerender();
        return;
      }
      if (id && id.indexOf("doc-purge-") === 0) {
        var purgeId = id.replace("doc-purge-", "");
        var purgeResult = LHMS.documents.purge(purgeId);
        if (!purgeResult.ok) { ui.toast(purgeResult.error, "error"); }
        else ui.toast("Record permanently purged.");
        ui.closeModal();
        LHMS.rerender();
        return;
      }
    });
  }
})();
