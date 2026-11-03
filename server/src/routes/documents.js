/**
 * The document register.
 *
 * The role and category map is the one the browser app enforces
 * (LHMS.documents.canAccess in assets/pages-documents.js), and so is the trail:
 * a register that can be written without leaving a trace is a register nobody
 * can defend in an audit. A refusal is written down as well — the screen promises
 * "Access denied — logged", and a denial nobody can find is one nobody follows up.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { log } = require("../lib/log");
const { uid } = require("../lib/json");
const { dstr } = require("../lib/business-date");

const router = Router();
router.use(authenticate);

/* The seven categories a record may be filed under. Anything else would sit in
   the register visible to a Manager alone, which is how a mis-filed document
   quietly disappears from the review it was filed for. */
const CATEGORIES = ["Registration", "Billing", "Spa & consent", "Events", "Booking", "Housekeeping", "Maintenance"];

const ROLE_CATEGORIES = {
  "Front Desk":  ["Registration","Billing","Spa & consent","Events","Booking"],
  Revenue:       ["Billing","Booking"],
  // What the ledger is kept against: the money documents, and only those. The
  // desk still files them — this hand reads and exports what was filed.
  "Finance Manager": ["Billing"],
  Housekeeping:  ["Housekeeping","Maintenance"],
  Guest:         ["Registration","Billing","Spa & consent"],
};

function canAccess(doc, action, user) {
  const role = user.role;
  if (doc.property_id !== user.propertyId && role !== "Manager") return false;
  if (action === "archive") return role === "Manager";
  if (action === "purge")   return role === "Manager";
  if (action === "create")  return ["Manager","Front Desk","Revenue"].includes(role);
  if (action === "sign") {
    if (role === "Manager" || role === "Front Desk") return ["Registration","Spa & consent"].includes(doc.category);
    return role === "Guest" && doc.guest_visible && doc.guest_id === user.guestId && ["Registration","Spa & consent"].includes(doc.category);
  }
  if (action === "send")   return ["Manager","Front Desk"].includes(role) && doc.guest_visible;
  if (action === "export") return role === "Manager" || (!!(ROLE_CATEGORIES[role]?.includes(doc.category)) && role !== "Guest");
  if (action !== "view")   return false;
  if (role === "Manager")  return true;
  if (role === "Guest")    return !!(doc.guest_visible && doc.guest_id === user.guestId && ROLE_CATEGORIES.Guest.includes(doc.category));
  return !!(ROLE_CATEGORIES[role]?.includes(doc.category));
}

/** The record as the register holds it, or nothing at all. */
async function find(id) {
  const { rows } = await pool.query(`SELECT * FROM documents WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function trail(req, doc, action, detail) {
  await log({
    propertyId: doc.property_id, actor: req.user.name, action, entity: "document",
    detail: [doc.name, detail].filter(Boolean).join(" · "),
  });
}

/** The record a route was pointed at, or the refusal it is owed: a missing id is
    answered as missing, and a role that may not touch it is refused and written
    down — a denial nobody can find is one nobody follows up. */
const DENIED = {
  view:    "Access denied.",
  sign:    "You cannot sign this document.",
  send:    "You cannot send this document.",
  export:  "You cannot export this record.",
  archive: "Only a manager can archive documents.",
  purge:   "Only a manager can purge documents.",
};

async function open(req, id, action) {
  const doc = await find(id);
  if (!doc) return { status: 404, body: { error: "Record not found." } };
  if (!canAccess(doc, action, req.user)) {
    await trail(req, doc, `refused to ${action} a document`, `${req.user.role} · access denied`);
    return { status: 403, body: { error: DENIED[action] } };
  }
  return { doc };
}

/* Every cell quoted, rows joined with CRLF, the file opened with a BOM: written
   the way the browser's register writes it, so the same records leave the same
   file whichever door they were exported from. */
function csvCell(v) { return '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"'; }
function csv(rows) { return "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n"; }

/** The instant as the browser's file carries it. A driver that hands back a Date
    and one that hands back text should not make two different files. */
function stamp(v) { return v instanceof Date ? v.toISOString() : (v || ""); }

const REGISTER_HEAD = ["Name", "Category", "Source", "Guest", "Reservation", "Status",
  "Created by", "Created", "Retention review", "Signed by", "Signed at", "Sent at", "Archived at"];

function registerRow(d) {
  return [d.name, d.category, d.source, d.guest_name || "", d.reservation_ref || "", d.status,
    d.created_by || "", stamp(d.created_at), dstr(d.retention_until) || "", d.signed_by || "",
    d.signed_at ? dstr(d.signed_at) : "", d.sent_at ? dstr(d.sent_at) : "",
    d.archived_at ? dstr(d.archived_at) : ""];
}

/* The single-record file is the register's columns without the desk-only ones —
   who filed it and whether anybody signed it stay inside the building. */
const METADATA_HEAD = REGISTER_HEAD.slice(0, 6).concat(REGISTER_HEAD.slice(7, 9));

function metadataRow(d) {
  const r = registerRow(d);
  return r.slice(0, 6).concat(r.slice(7, 9));
}

/** The records a caller may put in a file, with the guest and reservation names
    the register shows beside them. */
async function exportable(req, pid) {
  const { rows } = await pool.query(
    `SELECT d.*, g.name AS guest_name, r.reference AS reservation_ref
     FROM documents d
     LEFT JOIN guests g        ON g.id = d.guest_id
     LEFT JOIN reservations r  ON r.id = d.reservation_id
     WHERE d.property_id = $1 ORDER BY d.created_at DESC`,
    [pid]
  );
  return rows.filter((d) => canAccess(d, "export", req.user));
}

/** GET /api/documents/export?propertyId= — the register as a file.
    Declared before /:id so the word "export" is never read as a record id.
    An empty file is refused rather than handed over: headers with nothing under
    them read like a register that was emptied, and it was not. */
router.get("/export", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    const docs = await exportable(req, pid);
    if (!docs.length) return res.status(422).json({ error: "No records available for export." });
    const { rows: prop } = await pool.query(`SELECT code FROM properties WHERE id = $1`, [pid]);
    const file = `aurelia-document-register-${(prop[0] || {}).code || pid}-${dstr(new Date())}.csv`;
    await log({ propertyId: pid, actor: req.user.name, action: "exported document register",
      entity: "document", detail: `${docs.length} metadata records` });
    res.set("Content-Disposition", `attachment; filename="${file}"`)
      .type("text/csv")
      .send(csv([REGISTER_HEAD, ...docs.map(registerRow)]));
  } catch (err) { next(err); }
});

/** GET /api/documents?propertyId=&status= */
router.get("/", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    const { rows } = await pool.query(
      `SELECT d.*, g.name AS guest_name, r.reference AS reservation_ref
       FROM documents d
       LEFT JOIN guests g        ON g.id = d.guest_id
       LEFT JOIN reservations r  ON r.id = d.reservation_id
       WHERE d.property_id = $1 ORDER BY d.created_at DESC`,
      [pid]
    );
    const visible = rows.filter(d => canAccess(d, "view", req.user));
    res.json(visible);
  } catch (err) { next(err); }
});

/** GET /api/documents/:id — the one read the register records, because opening a
    guest's record is the step an audit asks about. */
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT d.*, g.name AS guest_name FROM documents d LEFT JOIN guests g ON g.id = d.guest_id WHERE d.id=$1`,
      [req.params.id]
    );
    const doc = rows[0];
    if (!doc) return res.status(404).json({ error: "Record not found." });
    if (!canAccess(doc, "view", req.user)) {
      await trail(req, doc, "refused to view a document", `${req.user.role} · access denied`);
      return res.status(403).json({ error: DENIED.view });
    }
    await trail(req, doc, "viewed a document", req.user.role);
    res.json(doc);
  } catch (err) { next(err); }
});

/** GET /api/documents/:id/metadata — one record on its own, the columns the
    register carries without the desk-only ones. */
router.get("/:id/metadata", async (req, res, next) => {
  try {
    const g = await open(req, req.params.id, "export");
    if (g.status) return res.status(g.status).json(g.body);
    const { rows } = await pool.query(
      `SELECT d.*, g.name AS guest_name, r.reference AS reservation_ref
       FROM documents d
       LEFT JOIN guests g        ON g.id = d.guest_id
       LEFT JOIN reservations r  ON r.id = d.reservation_id
       WHERE d.id = $1`,
      [req.params.id]
    );
    const doc = rows[0];
    await log({ propertyId: doc.property_id, actor: req.user.name,
      action: "exported document metadata", entity: "document", detail: doc.name });
    res.set("Content-Disposition", 'attachment; filename="aurelia-doc-metadata.csv"')
      .type("text/csv")
      .send(csv([METADATA_HEAD, metadataRow(doc)]));
  } catch (err) { next(err); }
});

const CreateSchema = z.object({
  name:          z.string().min(1, "Document name is required."),
  category:      z.string().min(1, "Category is required."),
  source:        z.string().optional(),
  sourceKey:     z.string().optional(),
  guestId:       z.string().optional().nullable(),
  reservationId: z.string().optional().nullable(),
  retentionYears:z.number().int().min(1).max(30).default(7),
  guestVisible:  z.boolean().default(false),
  notes:         z.string().optional(),
  propertyId:    z.string().optional(),
});

/** POST /api/documents */
router.post("/", validate(CreateSchema), async (req, res, next) => {
  try {
    const d   = req.data;
    const pid = d.propertyId || req.user.propertyId;
    const fakeDoc = { property_id: pid };
    if (!canAccess(fakeDoc, "create", req.user)) {
      return res.status(403).json({ error: "Your role cannot create documents." });
    }
    // A name is what the trail and the register both read, and a category is what
    // decides who may ever see the record — so neither is left to chance.
    const name = String(d.name || "").trim();
    if (!name) return res.status(422).json({ error: "Give the document a name." });
    if (CATEGORIES.indexOf(d.category) === -1) return res.status(422).json({ error: "Choose a category." });

    const id  = uid("doc");
    const ret = new Date(); ret.setFullYear(ret.getFullYear() + d.retentionYears);
    const { rows } = await pool.query(
      `INSERT INTO documents (id,property_id,guest_id,reservation_id,name,category,source,source_key,status,notes,guest_visible,retention_years,retention_until,created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Draft',$9,$10,$11,$12,$13) RETURNING *`,
      [id, pid, d.guestId||null, d.reservationId||null, name, d.category, d.source||req.user.role, d.sourceKey||"frontdesk", d.notes||"", d.guestVisible, d.retentionYears, ret.toISOString().slice(0,10), req.user.name]
    );
    await trail(req, rows[0], "captured a document", `${d.category} · ${d.retentionYears} year retention`);
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/** POST /api/documents/:id/sign */
router.post("/:id/sign", async (req, res, next) => {
  try {
    const g = await open(req, req.params.id, "sign");
    if (g.status) return res.status(g.status).json(g.body);
    const doc = g.doc;
    // Who signed, before whether it was already signed: a signature with nobody
    // behind it is not a signature the trail can carry.
    const signer = String(req.body.signer || "").trim();
    if (!signer) return res.status(422).json({ error: "Enter the signer's full name." });
    if (doc.signed_at) return res.status(422).json({ error: "This document has already been signed." });
    const { rows: updated } = await pool.query(
      `UPDATE documents SET status='Signed', signed_by=$2, signed_at=now() WHERE id=$1 RETURNING *`,
      [req.params.id, signer]
    );
    await trail(req, updated[0], "signed a document", signer);
    res.json(updated[0]);
  } catch (err) { next(err); }
});

/** POST /api/documents/:id/send */
router.post("/:id/send", async (req, res, next) => {
  try {
    const g = await open(req, req.params.id, "send");
    if (g.status) return res.status(g.status).json(g.body);
    const { rows: updated } = await pool.query(
      `UPDATE documents SET sent_at=now(), status=CASE WHEN status='Signed' THEN 'Signed' ELSE 'Delivery simulated' END WHERE id=$1 RETURNING *`,
      [req.params.id]
    );
    // Said out loud because nothing left the building: the demo has no mailgate.
    await trail(req, updated[0], "simulated document delivery", "no message was sent");
    res.json(updated[0]);
  } catch (err) { next(err); }
});

/** POST /api/documents/:id/archive */
router.post("/:id/archive", async (req, res, next) => {
  try {
    const g = await open(req, req.params.id, "archive");
    if (g.status) return res.status(g.status).json(g.body);
    const doc = g.doc;
    if (doc.status === "Archived") return res.status(422).json({ error: "This document is already archived." });
    const { rows: updated } = await pool.query(
      `UPDATE documents SET status='Archived', archived_at=now() WHERE id=$1 RETURNING *`, [req.params.id]
    );
    await trail(req, updated[0], "archived a document", `retention until ${dstr(updated[0].retention_until)}`);
    res.json(updated[0]);
  } catch (err) { next(err); }
});

/** DELETE /api/documents/:id — purge (manager only) */
router.delete("/:id", async (req, res, next) => {
  try {
    const g = await open(req, req.params.id, "purge");
    if (g.status) return res.status(g.status).json(g.body);
    const doc = g.doc;
    if (doc.status !== "Archived") return res.status(422).json({ error: "Only archived records can be purged." });
    await pool.query(`DELETE FROM documents WHERE id=$1`, [req.params.id]);
    // The row goes; the fact that it went does not. Logged from the copy read
    // above, because after the delete there is nothing left to name.
    await trail(req, doc, "purged a document record", `${doc.category} · metadata removed`);
    res.status(204).end();
  } catch (err) { next(err); }
});

module.exports = router;
