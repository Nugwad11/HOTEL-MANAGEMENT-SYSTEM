/* ============================================================
   Operations — guest requests, housekeeping, my rooms, lost & found
   ============================================================ */
(function () {
  var LHMS = window.LHMS;
  var U = LHMS.util;
  var ui = LHMS.ui;
  var S = (LHMS.state = LHMS.state || {});
  var view = (LHMS.views = LHMS.views || {});

  if (S.reqStatus == null) S.reqStatus = "Active";
  if (S.reqPriority == null) S.reqPriority = "all";
  if (S.reqDept == null) S.reqDept = "all";
  if (S.reqQuery == null) S.reqQuery = "";
  if (S.hkView == null) S.hkView = "board";
  if (S.myScope == null) S.myScope = null;
  if (S.lfStatus == null) S.lfStatus = "all";
  if (S.lfQuery == null) S.lfQuery = "";

  var DEPTS = ["Housekeeping", "Engineering", "Front Office", "Food & Beverage", "Spa & Wellness", "Transport", "Concierge"];

  function staffName(id) {
    var s = id ? LHMS.get.staff(id) : null;
    return s ? s.name : "Unassigned";
  }
  function deptOf(t) {
    var s = t.assignedTo ? LHMS.get.staff(t.assignedTo) : null;
    if (s && s.department) return s.department;
    if (/Maintenance/i.test(t.type)) return "Engineering";
    if (/Housekeeping|Departure clean|Inspection/i.test(t.type)) return "Housekeeping";
    return "Front Office";
  }
  function taskTone(t) {
    if (t.status === "Done") return "green";
    var sla = LHMS.calc.sla(t);
    if (sla.cls === "late") return "red";
    if (sla.cls === "soon") return "amber";
    return "navy";
  }

  view.taskCard = function (t, opts) {
    opts = opts || {};
    var guest = t.guestId ? LHMS.get.guest(t.guestId) : null;
    var room = t.roomId ? LHMS.get.room(t.roomId) : null;
    var sla = LHMS.calc.sla(t);
    var meta = [];
    if (room) meta.push("Room " + room.number);
    if (guest) meta.push(guest.name);
    meta.push(staffName(t.assignedTo));
    if (t.source && t.source !== "Front desk" && t.source !== "Housekeeping") meta.push("via " + t.source);
    return '<div class="task priority-' + String(t.priority || "Normal").toLowerCase() + '">' +
      '<span class="avatar sm" style="background:' + (t.status === "Done" ? "#e8f1ea" : "#f3efe4") + ';color:' + (t.status === "Done" ? "#356347" : "#8a7038") + '">' + ui.icon(t.type === "Maintenance" ? "wrench" : t.type === "Inspection" ? "checkCircle" : "message", 13) + "</span>" +
      '<div style="flex:1;min-width:0">' +
        '<div class="row between" style="align-items:flex-start;gap:8px"><div class="t-title" style="flex:1">' + ui.esc(t.title) + "</div>" +
        (t.status !== "Done" ? '<span class="sla ' + sla.cls + '">' + ui.esc(sla.label) + "</span>" : "") + "</div>" +
        '<div class="t-meta"><span>' + ui.esc(meta.join(" · ")) + "</span><span>" + ui.esc(t.priority) + " priority</span>" + (t.status === "In progress" ? "<span>In progress</span>" : "") + "</div>" +
        (opts.hideActions ? "" : '<div class="t-actions">' +
          (t.status === "Open" ? '<button class="btn sm primary" data-act="req-start" data-task="' + t.id + '">Start</button>' : "") +
          (t.status !== "Done" ? '<button class="btn sm" data-act="req-done" data-task="' + t.id + '">' + ui.icon("check", 11) + ' Complete</button><button class="btn sm" data-act="req-assign" data-task="' + t.id + '">Assign</button>' : "") +
          '<button class="btn sm ghost" data-act="req-view" data-task="' + t.id + '">Details</button>' +
        "</div>") +
      "</div></div>";
  };

  /* ============================================================
     GUEST REQUESTS
     ============================================================ */
  LHMS.pages.requests = function () {
    var p = LHMS.get.property();
    var all = LHMS.tasksOf(p.id).filter(function (t) { return t.source !== "Housekeeping" || /Guest request|Maintenance/.test(t.type); });
    var counts = {
      active: all.filter(function (t) { return t.status !== "Done"; }).length,
      open: all.filter(function (t) { return t.status === "Open"; }).length,
      progress: all.filter(function (t) { return t.status === "In progress"; }).length,
      late: all.filter(function (t) { return t.status !== "Done" && new Date(t.dueAt).getTime() < Date.now(); }).length,
      done: all.filter(function (t) { return t.status === "Done"; }).length
    };
    var list = all.slice();
    if (S.reqStatus === "Active") list = list.filter(function (t) { return t.status !== "Done"; });
    else if (S.reqStatus !== "all") list = list.filter(function (t) { return t.status === S.reqStatus; });
    if (S.reqPriority !== "all") list = list.filter(function (t) { return t.priority === S.reqPriority; });
    if (S.reqDept !== "all") list = list.filter(function (t) { return deptOf(t) === S.reqDept; });
    if (S.reqQuery) {
      var q = S.reqQuery.toLowerCase();
      list = list.filter(function (t) {
        var g = t.guestId ? LHMS.get.guest(t.guestId) : null;
        var r = t.roomId ? LHMS.get.room(t.roomId) : null;
        return (t.title + " " + (g ? g.name : "") + " " + (r ? r.number : "") + " " + t.detail).toLowerCase().indexOf(q) !== -1;
      });
    }
    list.sort(function (a, b) {
      if (a.status === "Done" && b.status !== "Done") return 1;
      if (b.status === "Done" && a.status !== "Done") return -1;
      return new Date(a.dueAt) - new Date(b.dueAt);
    });

    var tabs = [
      { k: "Active", label: "Active", n: counts.active },
      { k: "Open", label: "New", n: counts.open },
      { k: "In progress", label: "In progress", n: counts.progress },
      { k: "Done", label: "Resolved", n: counts.done },
      { k: "all", label: "All", n: all.length }
    ].map(function (t) {
      return '<button class="tab' + (S.reqStatus === t.k ? " active" : "") + '" data-act="req-tab" data-tab="' + t.k + '">' + t.label + '<span class="count">' + t.n + "</span></button>";
    }).join("");

    var byDept = {};
    all.filter(function (t) { return t.status !== "Done"; }).forEach(function (t) {
      var d = deptOf(t);
      byDept[d] = (byDept[d] || 0) + 1;
    });
    var deptRows = Object.keys(byDept).sort(function (a, b) { return byDept[b] - byDept[a]; }).map(function (d) {
      return '<div class="mix-row"><i style="background:' + ({ "Housekeeping": "#b18f52", "Engineering": "#4b6d92", "Front Office": "#6e997d", "Food & Beverage": "#c08a3e", "Spa & Wellness": "#9d7fae", "Transport": "#8a9a7b", "Concierge": "#9a8ba8" }[d] || "#9aa") + '"></i><span class="mix-label">' + ui.esc(d) + '</span><span class="mix-val">' + byDept[d] + "</span></div>";
    }).join("");

    var atRisk = all.filter(function (t) { return t.status !== "Done" && new Date(t.dueAt).getTime() - Date.now() < 20 * 60000; });

    return ui.pageHead({
      eyebrow: "Operations · guest experience",
      title: "Guest requests",
      sub: "Every request from the guest app, front desk and housekeeping, routed with an SLA clock. " + counts.active + " are open across " + p.short + ".",
      actions: '<button class="btn" data-act="export-requests">' + ui.icon("download", 14) + ' Export</button><button class="btn primary" data-act="open-new-request">' + ui.icon("plus", 14) + " New request</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Open requests", counts.active, '<span class="chip ' + (counts.late ? "red" : "green") + '">' + counts.late + "</span> past SLA", { icon: "message", accent: counts.late ? "accent-red" : "accent-navy" }) +
        ui.kpi("New", counts.open, "Awaiting an owner", { icon: "clock" }) +
        ui.kpi("In progress", counts.progress, "Assigned and moving", { icon: "broom", accent: "accent-green" }) +
        ui.kpi("Resolved", counts.done, "Closed with guest confirmation", { icon: "checkCircle" }) +
        ui.kpi("Avg. response", counts.active ? Math.max(4, Math.round((counts.done + 2) * 3.4)) + "<small>m</small>" : "—", "Rolling 24 hours", { icon: "trendUp" }) +
      "</div>" +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 308px;gap:16px">' +
        '<section class="card">' +
          '<div class="card-head"><div><div class="card-title">' + ui.icon("message", 15) + 'Request queue</div><div class="card-sub">Sorted by SLA deadline. Late requests are escalated to the duty manager.</div></div><div class="tabs">' + tabs + "</div></div>" +
          '<div class="toolbar">' + ui.searchField("Search requests, guests or rooms", S.reqQuery, "req-search") +
            '<select class="select" style="max-width:150px" data-change="req-priority"><option value="all">All priorities</option><option value="High"' + (S.reqPriority === "High" ? " selected" : "") + '>High</option><option value="Normal"' + (S.reqPriority === "Normal" ? " selected" : "") + '>Normal</option><option value="Low"' + (S.reqPriority === "Low" ? " selected" : "") + '>Low</option></select>' +
            '<select class="select" style="max-width:170px" data-change="req-dept"><option value="all">All departments</option>' + DEPTS.map(function (d) { return '<option' + (S.reqDept === d ? " selected" : "") + ">" + d + "</option>"; }).join("") + "</select>" +
            '<span class="spacer"></span><span class="tiny muted">' + list.length + " shown</span>" +
          "</div>" +
          (list.length ? '<div class="stack" style="gap:9px">' + list.map(function (t) { return view.taskCard(t); }).join("") + "</div>" : ui.empty("No requests match", "Adjust the filters or raise a new guest request.", "message")) +
        "</section>" +
        '<div class="stack">' +
          ui.sectionCard("SLA watch", '<div class="row between"><div><div class="kpi-value" style="margin-top:0">' + counts.late + '</div><div class="small muted">past SLA</div></div><div style="text-align:right"><div class="kpi-value" style="margin-top:0;font-size:22px">' + atRisk.length + '</div><div class="small muted">due within 20m</div></div></div>' +
            '<div class="progress mt12"><span style="width:' + Math.max(4, 100 - (counts.active ? counts.late / counts.active * 100 : 0)) + '%"></span></div>' +
            '<p class="tiny muted mt8">High-priority requests carry a 30-minute response window; standard requests 45 minutes.</p>' +
            (counts.late ? '<div class="notice danger mt12">' + ui.icon("alert") + "<div><b>" + counts.late + " request" + (counts.late > 1 ? "s" : "") + " breached SLA.</b> The duty manager and department head have been notified.</div></div>" : '<div class="notice success mt12">' + ui.icon("checkCircle") + "<div>All open requests are inside their response window.</div></div>"),
            "", "Live service level", "clock") +
          ui.sectionCard("By department", '<div class="stack" style="gap:2px">' + (deptRows || '<p class="muted small">No open requests.</p>') + "</div>", "", "Open workload", "broom") +
          ui.sectionCard("Request standards", '<div class="stack" style="gap:8px">' +
            '<div class="row between"><span class="small">Acknowledge guest</span><span class="chip green">5 min</span></div>' +
            '<div class="row between"><span class="small">Deliver high priority</span><span class="chip amber">30 min</span></div>' +
            '<div class="row between"><span class="small">Deliver standard</span><span class="chip">45 min</span></div>' +
            '<div class="row between"><span class="small">Close with confirmation</span><span class="chip blue">On delivery</span></div>' +
            '<p class="tiny muted">SLA clocks pause outside 07:00–23:00 for non-urgent requests.</p></div>', "", "Guest response promise", "shield") +
        "</div>" +
      "</div>";
  };

  /* modal + actions */
  function newRequestModal(prefill) {
    prefill = prefill || {};
    var guests = LHMS.calc.inHouse(LHMS.session.propertyId);
    ui.modal({
      title: "Raise a guest request",
      sub: "Routed immediately to the owning department with an SLA clock.",
      body: '<form data-form="new-request" class="form-grid">' +
        '<div class="field span2"><label>Request</label><input name="title" required placeholder="e.g. Extra pillows and a firm mattress topper" /></div>' +
        '<div class="field"><label>Guest</label><select name="guestId"><option value="">— No guest attached —</option>' + guests.map(function (r) {
          var g = LHMS.get.guest(r.guestId);
          return '<option value="' + r.guestId + '"' + (prefill.guestId === r.guestId ? " selected" : "") + ">" + ui.esc(g ? g.name : "Guest") + " · Room " + ui.roomNo(r.roomId) + "</option>";
        }).join("") + "</select></div>" +
        '<div class="field"><label>Room</label><select name="roomId"><option value="">— None —</option>' + LHMS.roomsOf().map(function (r) {
          return '<option value="' + r.id + '"' + (prefill.roomId === r.id ? " selected" : "") + ">" + r.number + " · " + ui.esc(ui.typeName(r.typeId)) + "</option>";
        }).join("") + "</select></div>" +
        '<div class="field"><label>Category</label><select name="dept">' + DEPTS.map(function (d) { return "<option>" + d + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Priority</label><select name="priority"><option>Normal</option><option>High</option><option>Low</option></select></div>' +
        '<div class="field span2"><label>Detail</label><textarea name="detail" placeholder="What does the guest need, and by when?"></textarea></div>' +
        '<div class="field"><label>Assign to</label><select name="assignedTo"><option value="">Unassigned queue</option>' + LHMS.staffOf().map(function (s) { return '<option value="' + s.id + '">' + ui.esc(s.name) + " · " + ui.esc(s.title) + "</option>"; }).join("") + "</select></div>" +
        '<div class="field"><label>Response window</label><select name="sla"><option value="30">30 minutes</option><option value="45" selected>45 minutes</option><option value="60">60 minutes</option><option value="120">2 hours</option></select></div>' +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-request">Create request</button>'
    });
  }

  function assignModal(taskId) {
    var t = LHMS.get.task(taskId);
    if (!t) return;
    var dept = deptOf(t);
    var staff = LHMS.staffOf().filter(function (s) { return s.department === dept || /Manager|Supervisor/.test(s.title); });
    ui.modal({
      title: "Assign request",
      sub: t.title,
      slim: true,
      body: '<form data-form="assign-task"><input type="hidden" name="taskId" value="' + t.id + '" />' +
        '<div class="field"><label>Owner</label><select name="assignedTo"><option value="">Unassigned queue</option>' + (staff.length ? staff : LHMS.staffOf()).map(function (s) {
          return '<option value="' + s.id + '"' + (t.assignedTo === s.id ? " selected" : "") + ">" + ui.esc(s.name) + " · " + ui.esc(s.title) + "</option>";
        }).join("") + "</select></div>" +
        '<div class="field mt12"><label>Priority</label><select name="priority"><option' + (t.priority === "High" ? " selected" : "") + ">High</option><option" + (t.priority === "Normal" ? " selected" : "") + ">Normal</option><option" + (t.priority === "Low" ? " selected" : "") + ">Low</option></select></div>" +
        '<div class="notice info mt12">' + ui.icon("clock") + "<div>Reassigning resets the SLA clock for the receiving team. The change is recorded in the audit trail.</div></div>" +
        "</form>",
      footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-assignment">Assign</button>'
    });
  }

  function taskDetailModal(taskId) {
    var t = LHMS.get.task(taskId);
    if (!t) return;
    var g = t.guestId ? LHMS.get.guest(t.guestId) : null;
    var room = t.roomId ? LHMS.get.room(t.roomId) : null;
    var sla = LHMS.calc.sla(t);
    ui.drawer({
      eyebrow: "Guest request · " + t.priority + " priority",
      title: ui.esc(t.title),
      body:
        '<div class="row between mb16">' + ui.chip(t.status, taskTone(t)) + '<span class="sla ' + sla.cls + '">' + ui.esc(sla.label) + "</span></div>" +
        '<div class="panel"><div class="panel-title">Request</div><p class="small" style="line-height:1.6">' + ui.esc(t.detail || "No additional detail was provided.") + "</p>" +
        '<div class="detail-row mt12"><dt>Raised</dt><dd>' + U.timeOf(t.createdAt) + " · " + U.pretty(String(t.createdAt).slice(0, 10), "short") + "</dd></div>" +
        '<div class="detail-row"><dt>Due</dt><dd>' + U.timeOf(t.dueAt) + " · " + U.pretty(String(t.dueAt).slice(0, 10), "short") + "</dd></div>" +
        '<div class="detail-row"><dt>Owner</dt><dd>' + ui.esc(staffName(t.assignedTo)) + "</dd></div>" +
        '<div class="detail-row"><dt>Department</dt><dd>' + ui.esc(deptOf(t)) + "</dd></div>" +
        '<div class="detail-row"><dt>Source</dt><dd>' + ui.esc(t.source || "Front desk") + "</dd></div>" +
        (t.resolvedAt ? '<div class="detail-row"><dt>Resolved</dt><dd>' + U.timeOf(t.resolvedAt) + "</dd></div>" : "") +
        "</div>" +
        (g ? '<div class="panel mt12"><div class="row">' + ui.avatar(g.name) + '<div><div class="strong">' + ui.esc(g.name) + '</div><div class="tiny muted">' + ui.esc(g.tier) + " · " + ui.esc(g.preferences.pillow) + '</div></div></div><div class="detail-row mt12"><dt>Room</dt><dd>' + (room ? room.number : "—") + '</dd></div><div class="detail-row"><dt>Allergy</dt><dd style="' + (g.preferences.allergies !== "None" ? "color:var(--red)" : "") + '">' + ui.esc(g.preferences.allergies) + '</dd></div><a class="btn sm block mt12" href="#/guests/' + g.id + '">Open guest</a></div>' : "") +
        '<div class="panel mt12"><div class="panel-title">Service timeline</div><div class="list">' +
          '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("message", 12) + '</span><div><div class="lr-title">Request raised</div><div class="lr-sub">' + U.timeOf(t.createdAt) + " · " + ui.esc(t.source || "Front desk") + "</div></div></div></div>" +
          (t.assignedTo ? '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("user", 12) + '</span><div><div class="lr-title">Assigned to ' + ui.esc(staffName(t.assignedTo)) + '</div><div class="lr-sub">' + ui.esc(deptOf(t)) + "</div></div></div></div>" : "") +
          (t.resolvedAt ? '<div class="list-row"><div class="lr-main"><span class="avatar sm">' + ui.icon("check", 12) + '</span><div><div class="lr-title">Resolved</div><div class="lr-sub">' + U.timeOf(t.resolvedAt) + " · guest confirmation recorded</div></div></div></div>" : "") +
        "</div></div>",
      footer: (t.status !== "Done" ? '<button class="btn primary" data-act="req-done" data-task="' + t.id + '">Complete request</button>' : "") +
        '<button class="btn" data-act="req-assign" data-task="' + t.id + '">Reassign</button>' +
        '<button class="btn" data-act="req-close-drawer">Close</button>'
    });
  }

  /* ============================================================
     HOUSEKEEPING SUPERVISOR
     ============================================================ */
  LHMS.pages.housekeeping = function () {
    var p = LHMS.get.property();
    var rooms = LHMS.roomsOf(p.id);
    var tasks = LHMS.tasksOf(p.id).filter(function (t) {
      return /Housekeeping|Departure clean|Inspection/.test(t.type) || t.source === "Housekeeping";
    });
    var open = tasks.filter(function (t) { return t.status !== "Done"; });
    var dirty = rooms.filter(function (r) { return r.hk === "Dirty"; });
    var clean = rooms.filter(function (r) { return r.hk === "Clean" && !LHMS.activeResForRoom(r.id); });
    var inspected = rooms.filter(function (r) { return r.hk === "Inspected"; });
    var ooo = rooms.filter(function (r) { return r.hk === "Out of order" || r.hk === "Out of service"; });
    var done = tasks.filter(function (t) { return t.status === "Done"; });

    function column(title, list, tone) {
      return '<div class="board-col"><div class="board-col-head"><span>' + title + '</span><span class="count">' + list.length + "</span></div>" +
        (list.length ? list.map(function (t) {
          var room = t.roomId ? LHMS.get.room(t.roomId) : null;
          var sla = LHMS.calc.sla(t);
          return '<div class="board-card" style="--kind:' + (tone || "#9aa") + '"><div class="row between" style="align-items:flex-start"><b>' + (room ? "Room " + room.number : "No room") + "</b>" + (t.status !== "Done" ? '<span class="sla ' + sla.cls + '">' + ui.esc(sla.label) + "</span>" : "") + "</div>" +
            '<span>' + ui.esc(t.title.replace(/^[^—]*—\s*/, "")) + "</span>" +
            '<div class="bc-foot"><span class="tiny muted">' + ui.esc(staffName(t.assignedTo)) + '</span><div class="row" style="gap:3px">' +
              (t.status === "Open" ? '<button class="btn sm" data-act="hk-start" data-task="' + t.id + '">Start</button>' : "") +
              (t.status !== "Done" ? '<button class="btn sm primary" data-act="req-done" data-task="' + t.id + '">Done</button>' : "") +
            "</div></div></div>";
        }).join("") : '<div class="empty" style="padding:18px 10px;font-size:10px"><b>Clear</b>No tasks in this stage.</div>') +
        "</div>";
    }

    var roomRows = dirty.concat(clean.slice(0, 8)).map(function (r) {
      var st = LHMS.roomState(r);
      var guest = st.guest;
      var task = open.filter(function (t) { return t.roomId === r.id; })[0];
      return '<div class="hk-room"><div class="hk-no">' + r.number + "</div><div class=\"hk-meta\"><b>" + ui.esc(ui.typeName(r.typeId)) + " · Floor " + r.floor + "</b><span>" + ui.esc(st.label) + (guest ? " · " + ui.esc(guest.name) : "") + (task ? " · " + ui.esc(staffName(task.assignedTo)) : " · unassigned") + "</span></div>" +
        '<div class="hk-actions">' +
          (r.hk === "Dirty" ? '<button class="btn sm primary" data-act="hk-clean" data-room="' + r.id + '">Mark clean</button>' : '<button class="btn sm" data-act="hk-inspect" data-room="' + r.id + '">Inspect</button>') +
          '<button class="btn sm ghost" data-act="open-room" data-room="' + r.id + '">Room</button>' +
        "</div></div>";
    }).join("");

    var workload = LHMS.cleanersOf(p.id).map(function (s) {
      var mine = open.filter(function (t) { return t.assignedTo === s.id; });
      var finished = done.filter(function (t) { return t.assignedTo === s.id; });
      return '<div class="list-row"><div class="lr-main">' + ui.avatar(s.name) + '<div><div class="lr-title">' + ui.esc(s.name) + '</div><div class="lr-sub">' + ui.esc(s.title) + " · " + ui.esc(s.shift) + '</div></div></div><div class="lr-meta"><b>' + mine.length + "</b> open<div class=\"tiny muted\">" + finished.length + " done</div></div></div>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Housekeeping · " + p.short,
      title: "Supervisor board",
      sub: dirty.length + " rooms need turnover, " + inspected.length + " are inspected and " + open.length + " tasks are open. The board reorders by SLA.",
      actions: '<button class="btn" data-act="export-housekeeping">' + ui.icon("download", 14) + ' Export</button><button class="btn" data-act="open-task" data-room="">' + ui.icon("plus", 14) + ' New task</button><button class="btn primary" data-act="assign-hk">' + ui.icon("users", 14) + " Assign rooms</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Dirty rooms", dirty.length, '<span class="chip amber">' + dirty.filter(function (r) { return !open.some(function (t) { return t.roomId === r.id; }); }).length + "</span> without a task", { icon: "broom", accent: dirty.length ? "accent-red" : "accent-green" }) +
        ui.kpi("Clean &amp; vacant", clean.length, "Ready for inspection", { icon: "checkCircle" }) +
        ui.kpi("Inspected", inspected.length, "Released to sell", { icon: "shield", accent: "accent-green" }) +
        ui.kpi("Open tasks", open.length, '<span class="chip ' + (LHMS.calc.taskCounts(p.id).late ? "red" : "green") + '">' + LHMS.calc.taskCounts(p.id).late + "</span> past SLA", { icon: "clock" }) +
        ui.kpi("Out of service", ooo.length, "Engineering holds", { icon: "wrench", accent: "accent-navy" }) +
      "</div>" +
      '<div class="grid" style="grid-template-columns:minmax(0,1fr) 300px;gap:16px">' +
        '<div class="stack">' +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("broom", 15) + 'Turnover board</div><div class="card-sub">Housekeeping tasks by stage. Completing a departure clean releases the room.</div></div><div class="row"><span class="chip gold">' + ui.esc(LHMS.get.settings(p.id).checkOutTime) + " checkout</span></div></div>" +
            '<div class="board">' +
              column("Departure cleans", open.filter(function (t) { return t.type === "Departure clean"; }), "#c47a73") +
              column("Stayover service", open.filter(function (t) { return t.type === "Housekeeping"; }), "#c9b07a") +
              column("Inspections", open.filter(function (t) { return t.type === "Inspection" || t.type === "Maintenance"; }), "#4b6d92") +
              column("Completed", done.slice(0, 6), "#6e997d") +
            "</div>" +
          "</section>" +
          '<section class="card"><div class="card-head"><div><div class="card-title">' + ui.icon("door", 15) + 'Rooms needing attention</div><div class="card-sub">Dirty rooms first, then clean rooms awaiting release.</div></div><a class="btn sm" href="#/room-map">Room map</a></div>' +
            (roomRows || ui.empty("Every room is ready", "No dirty or un-released rooms right now.", "checkCircle")) +
          "</section>" +
        "</div>" +
        '<div class="stack">' +
          ui.sectionCard("Team workload", '<div class="list">' + (workload || '<p class="muted small">No housekeeping staff on property.</p>') + "</div>", "", "Today's allocation", "users") +
          ui.sectionCard("Turnover standard", '<div class="stack" style="gap:9px">' +
            '<div class="row between"><span class="small">Departure clean</span><b>45 min</b></div>' +
            '<div class="row between"><span class="small">Stayover service</span><b>25 min</b></div>' +
            '<div class="row between"><span class="small">Suite inspection</span><b>15 min</b></div>' +
            '<div class="row between"><span class="small">Release deadline</span><b>' + ui.esc(LHMS.get.settings(p.id).checkInTime) + "</b></div>" +
            '<div class="notice info" style="margin-top:4px">' + ui.icon("info") + "<div>Inspected rooms are released to the front desk immediately. Out-of-order rooms require engineering sign-off.</div></div>" +
          "</div>", "", "Luxury housekeeping SOP", "check") +
          ui.sectionCard("Lost property", '<p class="muted small">Items found in rooms are sealed, photographed and logged within 30 minutes.</p><a class="btn sm block mt12" href="#/lost-found">Open lost &amp; found</a>', "", "", "box") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     MY ROOMS (room attendant)
     ============================================================ */
  LHMS.pages["my-rooms"] = function () {
    var p = LHMS.get.property();
    var role = LHMS.session.role;
    var me = LHMS.staffOf(p.id).filter(function (s) { return s.name === LHMS.session.name; })[0];
    if (S.myScope == null) S.myScope = role === "Housekeeping" ? "mine" : "all";
    if (!me && S.myScope === "mine") S.myScope = "all";

    var tasks = LHMS.tasksOf(p.id).filter(function (t) {
      return /Housekeeping|Departure clean|Inspection/.test(t.type) || t.source === "Housekeeping";
    });
    var scoped = S.myScope === "mine" && me ? tasks.filter(function (t) { return t.assignedTo === me.id; }) : tasks;
    var open = scoped.filter(function (t) { return t.status !== "Done"; });
    var done = scoped.filter(function (t) { return t.status === "Done"; });

    var roomIds = [];
    open.forEach(function (t) { if (t.roomId && roomIds.indexOf(t.roomId) === -1) roomIds.push(t.roomId); });
    if (S.myScope === "all") {
      LHMS.roomsOf(p.id).forEach(function (r) {
        if ((r.hk === "Dirty" || r.hk === "Clean") && roomIds.indexOf(r.id) === -1) roomIds.push(r.id);
      });
    }
    var rooms = roomIds.map(function (id) { return LHMS.get.room(id); }).filter(Boolean);
    rooms.sort(function (a, b) { return a.number < b.number ? -1 : 1; });

    var rows = rooms.map(function (r) {
      var st = LHMS.roomState(r);
      var task = open.filter(function (t) { return t.roomId === r.id; })[0];
      var g = st.guest;
      var sla = task ? LHMS.calc.sla(task) : null;
      return '<div class="hk-room"><div class="hk-no">' + r.number + "</div>" +
        '<div class="hk-meta"><b>' + ui.esc(ui.typeName(r.typeId)) + " · Floor " + r.floor + "</b><span>" + ui.esc(st.label) + (g ? " · " + ui.esc(g.name) : "") + (sla ? " · " + ui.esc(sla.label) : "") + "</span></div>" +
        '<div class="hk-actions">' +
          (task ? '<button class="btn sm primary" data-act="my-checklist" data-task="' + task.id + '">Open checklist</button>' : '<button class="btn sm" data-act="my-checklist" data-room="' + r.id + '">Room checklist</button>') +
          '<button class="btn sm ghost" data-act="open-room" data-room="' + r.id + '">Room</button>' +
        "</div></div>";
    }).join("");

    var credits = done.slice(0, 6);

    return ui.pageHead({
      eyebrow: "Housekeeping · " + (me ? me.title : "Room attendant"),
      title: "My rooms",
      sub: (S.myScope === "mine" ? "Rooms allocated to you today, " : "All housekeeping rooms for " + p.short + ", ") + "with the checklist required before a room can be released.",
      actions: '<div class="seg"><button class="' + (S.myScope === "mine" ? "on" : "") + '" data-act="my-scope" data-scope="mine">My rooms</button><button class="' + (S.myScope === "all" ? "on" : "") + '" data-act="my-scope" data-scope="all">All rooms</button></div><button class="btn" data-act="export-housekeeping">' + ui.icon("download", 14) + " Export</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("Rooms allocated", rooms.length, S.myScope === "mine" ? "To your section" : "Across the property", { icon: "door" }) +
        ui.kpi("Tasks remaining", open.length, "Before your shift ends", { icon: "clock", accent: "accent-navy" }) +
        ui.kpi("Completed", done.length, "Checked and released", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Shift", me ? me.shift : "08:00 – 17:00", me ? me.name : "Housekeeping team", { icon: "users" }) +
      "</div>" +
      '<div class="grid g-2-1">' +
        '<div class="stack">' +
          ui.sectionCard("Your room list", rows || ui.empty("No rooms allocated", "Ask the supervisor to assign rooms to your section.", "checkCircle"), "", "Room status, guest and SLA at a glance", "broom") +
          ui.sectionCard("Recently completed", credits.length ? '<div class="list">' + credits.map(function (t) {
            var room = t.roomId ? LHMS.get.room(t.roomId) : null;
            return '<div class="list-row"><div class="lr-main"><span class="avatar sm" style="background:var(--green-bg);color:var(--green)">' + ui.icon("check", 12) + '</span><div><div class="lr-title">' + (room ? "Room " + room.number + " · " : "") + ui.esc(t.title) + '</div><div class="lr-sub">' + (t.resolvedAt ? U.timeAgo(t.resolvedAt) : "just now") + " · " + ui.esc(t.type) + "</div></div></div><div class=\"lr-meta\">" + ui.chip("Done", "green") + "</div></div>";
          }).join("") + "</div>" : '<p class="muted small">Nothing completed yet today.</p>', "", "Your last six rooms", "checkCircle") +
        "</div>" +
        '<div class="stack">' +
          ui.sectionCard("Today's standard", '<div class="stack" style="gap:9px">' +
            '<div class="row between"><span class="small">Bed linen &amp; pillows</span><span class="chip">Guest pref.</span></div>' +
            '<div class="row between"><span class="small">Bathroom detail</span><span class="chip">Full reset</span></div>' +
            '<div class="row between"><span class="small">Minibar &amp; amenities</span><span class="chip">Restock</span></div>' +
            '<div class="row between"><span class="small">Turndown</span><span class="chip gold">On request</span></div>' +
            '<div class="divider-label">Safety</div>' +
            '<label class="check"><input type="checkbox" checked /> Report any damage or maintenance fault</label>' +
            '<label class="check"><input type="checkbox" checked /> Never move guest belongings</label>' +
            '<label class="check"><input type="checkbox" checked /> Seal lost property and notify the supervisor</label>' +
          "</div>", "", "Before releasing a room", "shield") +
          ui.sectionCard("Need help?", '<p class="muted small">Send a message to the supervisor or raise a maintenance task without leaving the board.</p><div class="row mt12"><button class="btn sm" data-act="open-task" data-room="">Raise task</button><a class="btn sm" href="#/requests">Requests</a></div>', "", "", "message") +
        "</div>" +
      "</div>";
  };

  /* ============================================================
     LOST & FOUND
     ============================================================ */
  LHMS.pages["lost-found"] = function () {
    var p = LHMS.get.property();
    var items = LHMS.db.lostFound.filter(function (l) { return l.propertyId === p.id; });
    var counts = {};
    items.forEach(function (l) { counts[l.status] = (counts[l.status] || 0) + 1; });
    var list = items.slice();
    if (S.lfStatus !== "all") list = list.filter(function (l) { return l.status === S.lfStatus; });
    if (S.lfQuery) {
      var q = S.lfQuery.toLowerCase();
      list = list.filter(function (l) {
        var g = l.guestId ? LHMS.get.guest(l.guestId) : null;
        return (l.item + " " + l.room + " " + (g ? g.name : "") + " " + l.note).toLowerCase().indexOf(q) !== -1;
      });
    }
    list.sort(function (a, b) { return a.date < b.date ? 1 : -1; });

    var statuses = ["all", "Stored", "Awaiting courier", "Returned", "Disposed"];
    var rows = list.map(function (l) {
      var g = l.guestId ? LHMS.get.guest(l.guestId) : null;
      var tone = l.status === "Returned" ? "green" : l.status === "Disposed" ? "navy" : l.status === "Awaiting courier" ? "blue" : "amber";
      return '<tr><td><b style="font-size:11.5px">' + ui.esc(l.item) + "</b><div class=\"tiny muted\">Logged " + U.pretty(l.date, "short") + "</div></td>" +
        '<td><span class="room-no">' + ui.esc(l.room) + "</span></td>" +
        "<td>" + (g ? '<div class="who">' + ui.avatar(g.name, "sm") + '<div><div class="who-name">' + ui.esc(g.name) + '</div><div class="who-sub">' + ui.esc(g.phone) + "</div></div></div>" : '<span class="muted">No guest linked</span>') + "</td>" +
        "<td>" + ui.esc(l.foundBy) + '<div class="tiny muted">' + U.timeAgo(l.date + "T12:00:00") + "</div></td>" +
        "<td>" + ui.chip(l.status, tone) + "</td>" +
        '<td class="right"><div class="row" style="justify-content:flex-end;gap:4px">' +
          (l.status === "Stored" ? '<button class="btn sm" data-act="lf-status" data-lf="' + l.id + '" data-status="Awaiting courier">Courier</button>' : "") +
          (l.status !== "Returned" && l.status !== "Disposed" ? '<button class="btn sm primary" data-act="lf-status" data-lf="' + l.id + '" data-status="Returned">Returned</button>' : "") +
          '<button class="btn sm ghost" data-act="lf-view" data-lf="' + l.id + '">View</button>' +
        "</div></td></tr>";
    }).join("");

    return ui.pageHead({
      eyebrow: "Housekeeping · " + p.short,
      title: "Lost & found",
      sub: "Every item is sealed, logged and linked to a guest profile so it can be returned without a search. " + items.length + " items on record.",
      actions: '<button class="btn" data-act="export-lost">' + ui.icon("download", 14) + ' Export</button><button class="btn primary" data-act="open-lost" data-room="">' + ui.icon("plus", 14) + " Log an item</button>"
    }) +
      '<div class="kpis">' +
        ui.kpi("In storage", counts["Stored"] || 0, "Sealed in the housekeeping safe", { icon: "box", accent: "accent-navy" }) +
        ui.kpi("Awaiting courier", counts["Awaiting courier"] || 0, "Guest has been contacted", { icon: "car" }) +
        ui.kpi("Returned", counts["Returned"] || 0, "Closed with the guest", { icon: "checkCircle", accent: "accent-green" }) +
        ui.kpi("Items on record", items.length, "Rolling 12 months", { icon: "file" }) +
      "</div>" +
      '<section class="card">' +
        '<div class="card-head"><div><div class="card-title">' + ui.icon("box", 15) + 'Property register</div><div class="card-sub">Items are photographed and held for 90 days. High-value items are insured and stored separately.</div></div><div class="row"><span class="chip amber">' + (counts["Stored"] || 0) + " stored</span><span class=\"chip blue\">" + (counts["Awaiting courier"] || 0) + " courier</span></div></div>" +
        '<div class="toolbar">' + ui.searchField("Search item, room or guest", S.lfQuery, "lf-search") +
          '<select class="select" style="max-width:170px" data-change="lf-status"><option value="all">All statuses</option>' + statuses.slice(1).map(function (s) { return '<option' + (S.lfStatus === s ? " selected" : "") + ">" + s + "</option>"; }).join("") + "</select>" +
          '<span class="spacer"></span><span class="tiny muted">' + list.length + " items</span>" +
        "</div>" +
        (list.length ? '<div class="table-wrap"><table class="data"><thead><tr><th>Item</th><th>Room</th><th>Guest</th><th>Found by</th><th>Status</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div>" : ui.empty("No items match", "Adjust the search or status filter.", "box")) +
      "</section>" +
      '<div class="grid g2 mt16">' +
        ui.sectionCard("Return process", '<div class="stack" style="gap:8px">' +
          '<div class="row between"><span class="small">1. Log within 30 minutes</span><span class="chip green">Done</span></div>' +
          '<div class="row between"><span class="small">2. Contact guest within 24 hours</span><span class="chip amber">Team</span></div>' +
          '<div class="row between"><span class="small">3. Courier or collection</span><span class="chip blue">Tracked</span></div>' +
          '<div class="row between"><span class="small">4. Confirm receipt and close</span><span class="chip">Record</span></div>' +
          '<p class="tiny muted">Items are held for 90 days, then donated or disposed with a supervisor signature.</p></div>', "", "Housekeeping standard", "check") +
        ui.sectionCard("High-value protocol", '<p class="muted small" style="line-height:1.7">Cash, jewellery, electronics and travel documents are counted by two staff members, photographed and stored in the duty manager safe. NDPR requires that guest identity is not disclosed when an item is listed externally.</p><div class="notice info mt12">' + ui.icon("shield") + "<div>Guest contact details are visible only to front office and housekeeping supervisors.</div></div>", "", "Secure handling", "shield") +
      "</div>";
  };

  /* ============================================================
     ACTIONS
     ============================================================ */
  Object.assign(LHMS.uiActions, {
    "req-tab": function (el) { S.reqStatus = el.getAttribute("data-tab"); LHMS.rerender(); },
    "live:req-search": function (val) {
      S.reqQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="req-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:req-priority": function (el) { S.reqPriority = el.value; LHMS.rerender(); },
    "change:req-dept": function (el) { S.reqDept = el.value; LHMS.rerender(); },

    "open-new-request": function (el) {
      newRequestModal({ roomId: el.getAttribute("data-room") || "", guestId: el.getAttribute("data-guest") || "" });
    },
    "submit-request": function () {
      var form = document.querySelector('form[data-form="new-request"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      var guestId = d.guestId || null;
      var roomId = d.roomId || null;
      if (!roomId && guestId) {
        var stay = LHMS.calc.inHouse().filter(function (x) { return x.guestId === guestId; })[0];
        if (stay) roomId = stay.roomId;
      }
      if (!guestId && roomId) {
        var active = LHMS.activeResForRoom(roomId);
        if (active) guestId = active.guestId;
      }
      LHMS.actions.createTask({
        title: d.title, type: "Guest request", priority: d.priority, detail: d.detail || d.dept + " request raised by front desk.",
        roomId: roomId, guestId: guestId, assignedTo: d.assignedTo || null,
        slaMins: Number(d.sla) || 45, source: "Front desk"
      });
      ui.closeModal(); LHMS.rerender();
      ui.toast("Request created and routed to " + (d.dept || "the duty team") + ".");
    },
    "req-start": function (el) {
      var t = LHMS.get.task(el.getAttribute("data-task"));
      if (!t) return;
      LHMS.actions.updateTask(t.id, { status: "In progress", assignedTo: t.assignedTo || (LHMS.staffOf().filter(function (s) { return s.department === deptOf(t); })[0] || {}).id || null });
      LHMS.rerender();
      ui.toast("Request started. SLA clock is running.");
    },
    "req-done": function (el) {
      var t = LHMS.get.task(el.getAttribute("data-task"));
      if (!t) return;
      ui.closeModal(); ui.closeDrawer();
      LHMS.actions.completeTask(t.id);
      LHMS.rerender();
      ui.toast("Request completed and the guest queue updated.");
    },
    "req-assign": function (el) { assignModal(el.getAttribute("data-task")); },
    "save-assignment": function () {
      var form = document.querySelector('form[data-form="assign-task"]');
      if (!form) return;
      var d = Object.fromEntries(new FormData(form));
      LHMS.actions.updateTask(d.taskId, { assignedTo: d.assignedTo || null, priority: d.priority, status: "In progress" });
      ui.closeModal(); LHMS.rerender();
      ui.toast("Request assigned to " + (d.assignedTo ? staffName(d.assignedTo) : "the unassigned queue") + ".");
    },
    "req-view": function (el) { taskDetailModal(el.getAttribute("data-task")); },
    "req-close-drawer": function () { ui.closeDrawer(); },

    "hk-start": function (el) {
      var t = LHMS.get.task(el.getAttribute("data-task"));
      if (!t) return;
      LHMS.actions.updateTask(t.id, { status: "In progress" });
      LHMS.rerender();
      ui.toast("Task started.");
    },
    "hk-clean": function (el) {
      var room = LHMS.get.room(el.getAttribute("data-room"));
      if (!room) return;
      closeRoomTasks(room.id);
      LHMS.actions.setRoomStatus(room.id, "Clean", "");
      LHMS.rerender();
      ui.toast("Room " + room.number + " marked clean and awaiting inspection.");
    },
    "hk-inspect": function (el) {
      var room = LHMS.get.room(el.getAttribute("data-room"));
      if (!room) return;
      LHMS.actions.setRoomStatus(room.id, "Inspected", "");
      LHMS.rerender();
      ui.toast("Room " + room.number + " inspected and released to sell.");
    },
    "assign-hk": function () {
      var rooms = LHMS.roomsOf().filter(function (r) { return r.hk === "Dirty"; });
      var staff = LHMS.cleanersOf();
      ui.modal({
        title: "Assign dirty rooms",
        sub: "Distribute today's turnover across the housekeeping team.",
        body: '<div class="stack">' + (rooms.length ? rooms.map(function (r, i) {
          var clean = staff[i % Math.max(1, staff.length)];
          return '<div class="row between" style="padding:9px 0;border-bottom:1px solid var(--line-2)"><div><b class="small">Room ' + r.number + '</b><div class="tiny muted">' + ui.esc(ui.typeName(r.typeId)) + " · Floor " + r.floor + '</div></div><select class="select" style="max-width:200px" data-hk-assign="' + r.id + '">' + staff.map(function (s) { return '<option value="' + s.id + '"' + (clean && clean.id === s.id ? " selected" : "") + ">" + ui.esc(s.name) + "</option>"; }).join("") + "</select></div>";
        }).join("") : '<p class="muted small">No dirty rooms to assign.</p>') + "</div>",
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="save-hk-assignments">Save allocation</button>'
      });
    },
    "save-hk-assignments": function () {
      var selects = document.querySelectorAll("[data-hk-assign]");
      var count = 0;
      Array.prototype.forEach.call(selects, function (sel) {
        var roomId = sel.getAttribute("data-hk-assign");
        var staffId = sel.value;
        var existing = LHMS.tasksOf().filter(function (t) { return t.roomId === roomId && t.status !== "Done" && /Housekeeping|Departure clean|Inspection/.test(t.type); })[0];
        if (existing) { LHMS.actions.updateTask(existing.id, { assignedTo: staffId }); }
        else {
          var room = LHMS.get.room(roomId);
          LHMS.actions.createTask({
            title: "Turnover — Room " + room.number, type: "Departure clean",
            detail: "Assigned from the supervisor board. Full turnover before arrival.",
            roomId: roomId, assignedTo: staffId, priority: "Normal", slaMins: 60, source: "Housekeeping"
          });
        }
        count++;
      });
      ui.closeModal(); LHMS.rerender();
      ui.toast(count + " rooms allocated. Room attendants have been notified.");
    },
    "my-scope": function (el) { S.myScope = el.getAttribute("data-scope"); LHMS.rerender(); },
    "my-checklist": function (el) {
      var taskId = el.getAttribute("data-task");
      var roomId = el.getAttribute("data-room");
      var task = taskId ? LHMS.get.task(taskId) : null;
      if (task && task.roomId) roomId = task.roomId;
      var room = LHMS.get.room(roomId);
      if (!room) return;
      var res = LHMS.activeResForRoom(room.id);
      var g = res ? LHMS.get.guest(res.guestId) : null;
      ui.modal({
        title: "Room " + room.number + " checklist",
        sub: ui.esc(ui.typeName(room.typeId)) + (g ? " · " + ui.esc(g.name) : " · Vacant"),
        body: '<form data-form="hk-checklist">' +
          '<input type="hidden" name="roomId" value="' + room.id + '" />' +
          '<input type="hidden" name="taskId" value="' + (task ? task.id : "") + '" />' +
          (g && g.preferences.allergies !== "None" ? '<div class="notice danger mb12">' + ui.icon("alert") + "<div><b>Allergy on file:</b> " + ui.esc(g.preferences.allergies) + ". Use the allocated linen and amenities only.</div></div>" : "") +
          (g ? '<div class="notice info mb12">' + ui.icon("user") + "<div><b>Guest preferences.</b> " + ui.esc(g.preferences.pillow) + " pillow · " + ui.esc(g.preferences.beverage) + " · " + ui.esc(g.preferences.turndown) + "</div></div>" : "") +
          '<div class="stack" style="gap:8px">' +
            '<label class="check"><input type="checkbox" name="bed" checked /> Bed linen changed and pillows dressed to preference</label>' +
            '<label class="check"><input type="checkbox" name="bath" checked /> Bathroom sanitised, towels and amenities replaced</label>' +
            '<label class="check"><input type="checkbox" name="minibar" checked /> Minibar checked, restocked and consumption posted</label>' +
            '<label class="check"><input type="checkbox" name="floor" checked /> Floors vacuumed, surfaces polished, bins emptied</label>' +
            '<label class="check"><input type="checkbox" name="tech" checked /> TV, lights, air conditioning and safe tested</label>' +
            '<label class="check"><input type="checkbox" name="lost" checked /> No guest property left behind; lost items logged</label>' +
            '<label class="check"><input type="checkbox" name="damage" /> Damage or maintenance fault found (raise a task)</label>' +
          "</div>" +
          '<div class="form-grid mt16"><div class="field"><label>Release as</label><select name="release"><option value="Clean">Clean — send for inspection</option><option value="Inspected">Inspected — release to sell</option></select></div>' +
          '<div class="field"><label>Completed by</label><input value="' + ui.esc(LHMS.session.name || "Room attendant") + '" readonly /></div></div>' +
          '<div class="field mt12"><label>Notes for the supervisor</label><input name="notes" placeholder="Optional — maintenance, guest property, linen shortage" /></div>' +
          "</form>",
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-checklist">Complete checklist</button>'
      });
    },
    "submit-checklist": function () {
      var form = document.querySelector('form[data-form="hk-checklist"]');
      if (!form) return;
      var d = Object.fromEntries(new FormData(form));
      var room = LHMS.get.room(d.roomId);
      if (!room) return;
      var checks = ["bed", "bath", "minibar", "floor", "tech", "lost"];
      var missing = checks.filter(function (k) { return !form.querySelector('[name="' + k + '"]').checked; });
      if (missing.length) { ui.toast("Complete every checklist item before releasing the room.", "error"); return; }
      closeRoomTasks(room.id);
      if (d.taskId) {
        var t = LHMS.get.task(d.taskId);
        if (t && t.status !== "Done") LHMS.actions.updateTask(t.id, { status: "Done" });
      }
      LHMS.actions.setRoomStatus(room.id, d.release || "Clean", "");
      if (form.querySelector('[name="damage"]').checked) {
        LHMS.actions.createTask({
          title: "Maintenance fault — Room " + room.number, type: "Maintenance",
          detail: (d.notes || "Reported during room checklist.") + " Raised by " + (LHMS.session.name || "housekeeping") + ".",
          roomId: room.id, priority: "High", slaMins: 60, source: "Housekeeping"
        });
      }
      ui.closeModal(); LHMS.rerender();
      ui.toast("Room " + room.number + " " + (d.release === "Inspected" ? "inspected and released." : "cleaned and sent for inspection.") + (d.notes ? " Note saved." : ""));
    },

    "live:lf-search": function (val) {
      S.lfQuery = val; LHMS.rerender();
      setTimeout(function () { var f = document.querySelector('[data-live="lf-search"]'); if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); } }, 10);
    },
    "change:lf-status": function (el) { S.lfStatus = el.value; LHMS.rerender(); },
    "open-lost": function (el) {
      var room = el.getAttribute("data-room") || "";
      ui.modal({
        title: "Log a lost item",
        sub: "Seal, photograph and record the item before it leaves the room.",
        body: '<form data-form="lost-item" class="form-grid">' +
          '<div class="field span2"><label>Item</label><input name="item" required placeholder="e.g. Gold hoop earring" /></div>' +
          '<div class="field"><label>Room or area found</label><input name="room" required value="' + ui.esc(room) + '" placeholder="305 / Lobby / Pool" /></div>' +
          '<div class="field"><label>Found by</label><input name="foundBy" value="' + ui.esc(LHMS.session.name || "Housekeeping") + '" /></div>' +
          '<div class="field span2"><label>Link to a guest (optional)</label><select name="guestId"><option value="">No guest linked</option>' + LHMS.db.guests.slice(0, 30).map(function (g) { return '<option value="' + g.id + '">' + ui.esc(g.name) + " · " + ui.esc(g.phone) + "</option>"; }).join("") + "</select></div>" +
          '<div class="field span2"><label>Notes</label><textarea name="note" placeholder="Condition, storage location, courier details…"></textarea></div>' +
          "</form>",
        footer: '<button class="btn" data-close-modal>Cancel</button><button class="btn primary" data-act="submit-lost">Log item</button>'
      });
    },
    "submit-lost": function () {
      var form = document.querySelector('form[data-form="lost-item"]');
      if (!form) return;
      if (!form.reportValidity()) return;
      var d = Object.fromEntries(new FormData(form));
      LHMS.actions.createLostItem(d);
      ui.closeModal(); LHMS.rerender();
      ui.toast("Item logged and sealed in the housekeeping safe.");
    },
    "lf-status": function (el) {
      LHMS.actions.setLostStatus(el.getAttribute("data-lf"), el.getAttribute("data-status"));
      LHMS.rerender();
      ui.toast("Lost & found status updated to " + el.getAttribute("data-status") + ".");
    },
    "lf-view": function (el) {
      var l = LHMS.db.lostFound.filter(function (x) { return x.id === el.getAttribute("data-lf"); })[0];
      if (!l) return;
      var g = l.guestId ? LHMS.get.guest(l.guestId) : null;
      ui.modal({
        title: ui.esc(l.item),
        sub: "Room " + ui.esc(l.room) + " · Logged " + U.pretty(l.date, "medium"),
        body: '<div class="panel"><div class="detail-row"><dt>Status</dt><dd>' + ui.chip(l.status, l.status === "Returned" ? "green" : "amber") + "</dd></div>" +
          '<div class="detail-row"><dt>Found by</dt><dd>' + ui.esc(l.foundBy) + "</dd></div>" +
          '<div class="detail-row"><dt>Guest</dt><dd>' + (g ? ui.esc(g.name) : "Not linked") + "</dd></div>" +
          '<div class="detail-row"><dt>Contact</dt><dd>' + (g ? ui.esc(g.phone) : "—") + "</dd></div>" +
          '<div class="detail-row"><dt>Storage</dt><dd>Housekeeping safe · Shelf B</dd></div></div>' +
          '<div class="panel mt12"><div class="panel-title">Notes</div><p class="small muted">' + ui.esc(l.note || "No notes recorded.") + "</p></div>" +
          '<div class="notice info mt12">' + ui.icon("shield") + "<div>Guest contact details must not be shared outside front office and housekeeping supervisors.</div></div>",
        footer: (l.status !== "Returned" ? '<button class="btn primary" data-act="lf-status" data-lf="' + l.id + '" data-status="Returned">Mark returned</button>' : "") +
          (l.status === "Stored" ? '<button class="btn" data-act="lf-status" data-lf="' + l.id + '" data-status="Awaiting courier">Arrange courier</button>' : "") +
          '<button class="btn" data-close-modal>Close</button>'
      });
    },

    "export-requests": function () {
      var rows = [["Task", "Type", "Priority", "Status", "Room", "Guest", "Owner", "Due"]];
      LHMS.tasksOf().forEach(function (t) {
        rows.push([t.title, t.type, t.priority, t.status, t.roomId ? ui.roomNo(t.roomId) : "", t.guestId ? ui.guestName(t.guestId) : "", staffName(t.assignedTo), t.dueAt]);
      });
      ui.csv("aurelia-requests-" + LHMS.day + ".csv", rows);
      ui.toast("Request export downloaded.");
    },
    "export-housekeeping": function () {
      var rows = [["Room", "Type", "Floor", "Status", "Guest"]];
      LHMS.roomsOf().forEach(function (r) {
        var st = LHMS.roomState(r);
        rows.push([r.number, ui.typeName(r.typeId), r.floor, st.label, st.guest ? st.guest.name : ""]);
      });
      ui.csv("aurelia-housekeeping-" + LHMS.day + ".csv", rows);
      ui.toast("Housekeeping export downloaded.");
    },
    "export-lost": function () {
      var rows = [["Item", "Room", "Found by", "Date", "Status", "Guest"]];
      LHMS.db.lostFound.forEach(function (l) { rows.push([l.item, l.room, l.foundBy, l.date, l.status, l.guestId ? ui.guestName(l.guestId) : ""]); });
      ui.csv("aurelia-lost-found-" + LHMS.day + ".csv", rows);
      ui.toast("Lost & found export downloaded.");
    }
  });

  function closeRoomTasks(roomId) {
    LHMS.tasksOf().filter(function (t) {
      return t.roomId === roomId && t.status !== "Done" && /Housekeeping|Departure clean|Inspection/.test(t.type);
    }).forEach(function (t) { LHMS.actions.updateTask(t.id, { status: "Done" }); });
  }
})();
