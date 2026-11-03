/**
 * Bulk price files — the port of the bulk-update block in assets/store.js.
 *
 * A file is only ever another way to feed the single-row applier: every row is
 * planned with the same rules, held over the property's limit by the same gate,
 * and written by P.applyPricePatch, so nothing a spreadsheet can do is
 * something the edit form could not already do.
 */
const P = require("./price");

const SURCHARGE_FIELDS = {
  room: ["weekendPct", "extraAdult", "extraBed", "earlyCheckIn", "lateCheckOut", "depositPct"],
  hall: ["weekendPct", "halfDay", "fullDay", "depositPct", "cancelPct", "cancelHours"],
  restaurant: [],
  laundry: ["expressPct"],
};

const surchargeFields = (category) => SURCHARGE_FIELDS[category] || [];

/** The columns a file may drive, in the exact words the export writes. */
const IMPORT_HEAD = {
  "price id": "priceId", code: "code", service: "service", category: "category",
  "price list": "list", amount: "amount", currency: "currency",
  "effective from": "from", "effective to": "to", status: "status",
  "updated by": "ignored", "updated at": "ignored",
};
const IMPORT_STATUS = {
  "on sale": true, available: true, active: true, yes: true, true: true,
  "switched off": false, "service closed": false, off: false, no: false, false: false,
};

/**
 * Cells are walked one at a time rather than split on a comma, because a service
 * name can hold one; a paste out of Excel arrives tab separated, so the
 * delimiter is sniffed from the header line.
 */
function parseDelimited(text) {
  const s = String(text === undefined || text === null ? "" : text).replace(/^\uFEFF/, "");
  const head = (s.split(/[\r\n]+/)[0] || "");
  const sep = (head.split("\t").length - 1) > (head.split(",").length - 1) ? "\t" : ",";
  const rows = []; let row = []; let cell = ""; let quoted = false; let i = 0;
  while (i < s.length) {
    const c = s.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (s.charAt(i + 1) === '"') { cell += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      cell += c; i++; continue;
    }
    if (c === '"' && cell === "") { quoted = true; i++; continue; }
    if (c === sep) { row.push(cell); cell = ""; i++; continue; }
    if (c === "\r" || c === "\n") {
      if (c === "\r" && s.charAt(i + 1) === "\n") i++;
      row.push(cell); rows.push(row); row = []; cell = ""; i++; continue;
    }
    cell += c; i++;
  }
  row.push(cell); rows.push(row);
  return rows
    .filter((r) => r.some((v) => String(v).trim() !== ""))
    .map((r) => r.map((v) => String(v).trim()));
}

// A column the table does not know keeps its own spelling, because that is how
// the surcharge fields are named in the row it writes.
function headKey(label) {
  const clean = String(label).toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return IMPORT_HEAD[clean] || String(label).trim();
}

function amountCell(v) {
  const digits = String(v).replace(/[^0-9.\-]/g, "");
  return /^-?\d*\.?\d+$/.test(digits) ? Number(digits) : NaN;
}

/** The patch this file row asks for, in the shape the single-row route takes. */
function patchFromCells(cols, svc, lists) {
  const patch = {};
  if (cols.amount !== undefined) {
    const n = amountCell(cols.amount);
    if (!isFinite(n)) return { error: `Amount “${cols.amount}” is not a number.` };
    patch.amount = n;
  }
  if (cols.list !== undefined && cols.list !== "") {
    const hit = lists.find((l) => l.id === cols.list || String(l.name).toLowerCase() === cols.list.toLowerCase());
    if (!hit) return { error: `No price list is called “${cols.list}”.` };
    patch.listId = hit.id;
  }
  if (cols.currency !== undefined && cols.currency !== "") {
    const cur = String(cols.currency).toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) return { error: `Currency “${cols.currency}” is not a three-letter code.` };
    patch.currency = cur;
  }
  if (cols.status !== undefined && cols.status !== "") {
    const match = Object.keys(IMPORT_STATUS).find((k) => k === cols.status.toLowerCase());
    if (match === undefined) return { error: `Status “${cols.status}” must be “on sale” or “off”.` };
    patch.active = IMPORT_STATUS[match];
  }
  const dates = [["from", "from_date"], ["to", "to_date"]];
  for (const [key, column] of dates) {
    if (cols[key] === undefined) continue;
    const raw = cols[key];
    if (raw !== "" && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      return { error: `Effective dates must be written YYYY-MM-DD, not “${raw}”.` };
    }
    patch[column] = raw === "" ? null : raw;
  }
  // A column the file leaves out is not planned at all; a column the file names
  // and leaves blank is cleared, which is why the export — not a hand-typed
  // sheet — is the template.
  const fieldOf = {};
  surchargeFields((svc || {}).category).forEach((f) => { fieldOf[f.toLowerCase()] = f; });
  const surcharges = {};
  for (const key of Object.keys(cols)) {
    const field = fieldOf[key.toLowerCase()];
    if (!field) continue;
    if (cols[key] === "") { surcharges[field] = 0; continue; }
    const v = amountCell(cols[key]);
    if (!isFinite(v) || v < 0) return { error: `“${field}” must be a number of zero or more.` };
    surcharges[field] = v;
  }
  if (Object.keys(surcharges).length) patch.surcharges = surcharges;
  return { patch };
}

function diffOf(row, next, patch) {
  const diff = [];
  if (next.amount !== row.amount) diff.push(["amount", row.amount, next.amount]);
  if (next.active !== row.active) diff.push(["status", row.active ? "on sale" : "off", next.active ? "on sale" : "off"]);
  if (next.listId !== row.listId) diff.push(["list", row.listId, next.listId]);
  if (next.currency !== row.currency) diff.push(["currency", row.currency, next.currency]);
  if (String(next.from || "") !== String(row.from || "")) diff.push(["from", row.from || "—", next.from || "—"]);
  if (String(next.to || "") !== String(row.to || "")) diff.push(["to", row.to || "—", next.to || "—"]);
  Object.keys(patch.surcharges || {}).forEach((key) => {
    const was = Number(row.surcharges[key]) || 0;
    if (was !== next.surcharges[key]) diff.push([key, was, next.surcharges[key]]);
  });
  return diff;
}

/**
 * Read-only by construction: nothing here touches a row, so a caller sees the
 * whole file — including what it is about to be asked to sign for — before a
 * single number moves. `ctx.money` is the property's own money reading and it is
 * not optional: without it a dollar row would be judged as naira, and a money the
 * books cannot value would reach the row. `ctx.movesAlone` is the caller's own
 * clearance to cross the limit on a single word — the General Manager alone,
 * since a role that holds the signing right is the second hand rather than both.
 */
async function planImport(text, reason, ctx) {
  ctx = ctx || {};
  const cat = ctx.cat || (await P.catalogue());
  const rows = parseDelimited(text);
  if (rows.length < 2) return { ok: false, error: "The file needs a header line and at least one price." };
  if (!reason) return { ok: false, error: "A reason is required — it goes in the audit trail." };
  const headers = rows.shift().map(headKey);
  const limit = ctx.limit;
  const movesAlone = !!ctx.movesAlone;
  const out = [];
  const counts = { change: 0, queue: 0, unchanged: 0, reject: 0 };
  const seen = {};

  rows.forEach((cells, index) => {
    const line = index + 2;
    const cols = {};
    // A cell holding an unquoted comma arrives as two values, and the second
    // would quietly overwrite the next column — so a long row is refused rather
    // than read. Money is not worth guessing at.
    const overrun = cells.length > headers.length;
    headers.forEach((key, i) => {
      if (key === "ignored" || cells[i] === undefined) return;
      cols[key] = cells[i];
    });

    let row = cols.priceId ? cat.prices.find((p) => p.id === cols.priceId) : null;
    if (!row && cols.code) {
      const byCode = cat.services.find((s) => String(s.code).toLowerCase() === cols.code.toLowerCase());
      if (byCode) {
        const wanted = (cols.list || "").toLowerCase();
        row = cat.prices.find((p) => {
          if (p.serviceId !== byCode.id) return false;
          if (!wanted) return true;
          const l = cat.lists.find((x) => x.id === p.listId);
          return p.listId.toLowerCase() === wanted || String(l && l.name).toLowerCase() === wanted;
        });
      }
    }
    const svc = row ? cat.services.find((s) => s.id === row.serviceId) : null;
    const list = row ? cat.lists.find((l) => l.id === row.listId) : null;
    const entry = {
      line, priceId: cols.priceId || (row && row.id) || "",
      service: (row && svc && svc.name) || cols.service || "—",
      list: row ? ((list && list.name) || row.listId) : (cols.list || "—"),
      state: "reject", error: null, patch: null, move: 0, diff: [],
    };

    if (overrun) {
      entry.error = `Line ${line} holds ${cells.length} values but the header names ${headers.length}` +
        " — quote any cell that contains a comma.";
    } else if (!row) {
      entry.error = "No price record matches " +
        (cols.priceId ? `id ${cols.priceId}` : `code ${cols.code || "—"}`) +
        (cols.list ? ` on ${cols.list}` : "") + ".";
    } else if (seen[row.id]) {
      entry.error = `This price appears twice in the file — line ${seen[row.id]} already carries it.`;
    } else {
      seen[row.id] = line;
      const built = patchFromCells(cols, svc, cat.lists);
      if (built.error) {
        entry.error = built.error;
      } else {
        const planned = P.planPricePatch(row, built.patch, reason, ctx.money.fx);
        if (planned.error) {
          entry.error = planned.error;
        } else {
          entry.patch = built.patch;
          entry.diff = diffOf(row, planned.next, built.patch);
          entry.current = { amount: row.amount, currency: row.currency, active: row.active };
          entry.next = planned.next;
          entry.move = planned.move;
        }
      }
    }

    if (entry.error) { entry.state = "reject"; counts.reject++; out.push(entry); return; }
    if (!entry.diff.length) { entry.state = "unchanged"; counts.unchanged++; out.push(entry); return; }
    // The limit is a figure in the money the books are kept in, so a dollar row
    // is tested on what its move is worth here rather than on the number of
    // dollars it moves. (The money itself was gated with the rest of the patch:
    // planPricePatch refuses a currency the books cannot value.)
    const gap = ctx.money.fold(entry.move, entry.next.currency);
    entry.move = gap.base;
    entry.currency = gap.currency;
    entry.state = entry.move > limit && !movesAlone ? "queue" : "change";
    counts[entry.state]++;
    out.push(entry);
  });

  if (!out.length) return { ok: false, error: "The file named no price rows." };
  return {
    ok: true, reason: reason, rows: out, counts, limit,
    rejected: out.filter((r) => r.state === "reject"),
    changes: out.filter((r) => r.state === "change" || r.state === "queue"),
  };
}

module.exports = {
  SURCHARGE_FIELDS, surchargeFields, parseDelimited, headKey, amountCell,
  patchFromCells, planImport,
};
