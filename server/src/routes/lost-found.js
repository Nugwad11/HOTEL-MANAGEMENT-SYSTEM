/**
 * Lost & found — the port of the housekeeping page's register
 * (assets/pages-operations.js "lost-found", LHMS.actions.createLostItem /
 * setLostStatus, and the page's CSV export).
 *
 * The browser keeps four words on the register — stored, awaiting courier,
 * returned, disposed — and links an item to a guest profile so it can be
 * returned without a search. This door keeps the same four words, the same
 * trail lines, and the same file, and resolves the room the finder named to a
 * room row when it is one, so the item reads beside the stay it came from.
 */
const { Router } = require("express");
const crypto = require("crypto");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { log } = require("../lib/log");
const biz = require("../lib/business-date");

const router = Router();
router.use(authenticate);

const STATUSES = ["Stored", "Awaiting courier", "Returned", "Disposed"];

/**
 * The page's own hands: housekeeping keeps the register, the desk signs items
 * back to guests, a manager may do either. A permission key names the board
 * rather than a role, the same way the task doors do, because both boards own
 * this screen.
 */
function mayTouch(req) {
  if (req.user.role === "Manager") return true;
  const perms = req.user.permissions || {};
  return Boolean(perms.housekeeping_board || perms.manage_reservations);
}

const canTouch = (req, res, next) =>
  mayTouch(req)
    ? next()
    : res.status(403).json({ error: "Only housekeeping, the front desk or a manager may keep the register." });

function seesProperty(req, pid) {
  return req.user.role === "Manager" || pid === req.user.propertyId;
}

const required = (label, max) =>
  z.string().min(1, `${label} is required.`).max(max, `${label} is too long.`)
    .refine((v) => v.trim().length > 0, `${label} is required.`);

const CreateSchema = z.object({
  item: required("An item description", 200),
  room: required("A room or area", 120),
  foundBy: z.string().max(120).optional(),
  guestId: z.string().max(64).nullable().optional(),
  note: z.string().max(500).optional(),
});

const StatusSchema = z.object({ status: z.enum(STATUSES) });

const HEAD = ["Item", "Room", "Found by", "Date", "Status", "Guest"];

/* Every cell quoted, rows joined with CRLF, the file opened with a BOM —
   the register's exports all leave the building the same way. */
const csvCell = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
const csv = (rows) => "\ufeff" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

const stamp = (v) => (v instanceof Date ? v.toISOString() : (v == null ? "" : String(v)));

async function list(pid) {
  const { rows } = await pool.query(
    `SELECT l.*, g.name AS guest_name, g.phone AS guest_phone, r.number AS room_number
       FROM lost_found l
       LEFT JOIN guests g ON g.id = l.guest_id
       LEFT JOIN rooms  r ON r.id = l.room_id
      WHERE l.property_id = $1
     ORDER BY l.found_date DESC, l.created_at DESC`,
    [pid]
  );
  return rows;
}

async function readOne(id) {
  const { rows } = await pool.query(
    `SELECT l.*, g.name AS guest_name, g.phone AS guest_phone, r.number AS room_number
       FROM lost_found l
       LEFT JOIN guests g ON g.id = l.guest_id
       LEFT JOIN rooms  r ON r.id = l.room_id
      WHERE l.id = $1`,
    [id]
  );
  return rows[0] || null;
}

/** GET /api/lost-found?propertyId=&status=&q= */
router.get("/", canTouch, async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    if (!seesProperty(req, pid)) {
      return res.status(403).json({ error: "That register belongs to another property." });
    }
    const { status, q } = req.query;
    if (status && status !== "all" && !STATUSES.includes(status)) {
      return res.status(422).json({ error: `Invalid status. Must be one of: ${STATUSES.join(", ")}` });
    }
    let rows = await list(pid);
    if (status && status !== "all") rows = rows.filter((r) => r.status === status);
    if (q) {
      const needle = String(q).toLowerCase();
      rows = rows.filter((r) =>
        [r.description, r.location, r.guest_name, r.note].join(" ").toLowerCase().includes(needle));
    }
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/lost-found/export?propertyId= — the register as a file. */
router.get("/export", canTouch, async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    if (!seesProperty(req, pid)) {
      return res.status(403).json({ error: "That register belongs to another property." });
    }
    const rows = await list(pid);
    if (!rows.length) return res.status(422).json({ error: "No records available for export." });
    const { rows: prop } = await pool.query(`SELECT code FROM properties WHERE id = $1`, [pid]);
    const day = await biz.businessDay();
    const file = `aurelia-lost-found-${(prop[0] || {}).code || pid}-${day}.csv`;
    await log({ propertyId: pid, actor: req.user.name, action: "exported lost & found",
      entity: "lost & found", detail: `${rows.length} items` });
    res.set("Content-Disposition", `attachment; filename="${file}"`)
      .type("text/csv")
      .send(csv([HEAD, ...rows.map((l) =>
        [l.description, l.location || "", l.found_by || "", stamp(l.found_date),
          l.status, l.guest_name || ""])]));
  } catch (err) { next(err); }
});

/** POST /api/lost-found — log an item: { item, room, foundBy?, guestId?, note? } */
router.post("/", canTouch, validate(CreateSchema), async (req, res, next) => {
  try {
    const pid = req.user.propertyId;
    const d = req.data;
    // The name on the tag is who found it; the hand at the desk is only the
    // fallback the page pre-fills it with.
    const foundBy = d.foundBy && d.foundBy.trim() ? d.foundBy : req.user.name;

    let guestId = null;
    if (d.guestId) {
      const { rows } = await pool.query(`SELECT id FROM guests WHERE id = $1`, [d.guestId]);
      if (!rows[0]) return res.status(422).json({ error: "Guest not found." });
      guestId = rows[0].id;
    }
    // "305" is a room; "Lobby" and "G02" are places the register keeps without
    // a room row, so the link is made only when the word names one.
    const { rows: room } = await pool.query(
      `SELECT id FROM rooms WHERE property_id = $1 AND number = $2`, [pid, d.room.trim()]);

    const day = await biz.businessDay();
    const id = "lf_" + crypto.randomUUID().slice(0, 8);
    await pool.query(
      `INSERT INTO lost_found
         (id,property_id,description,location,found_by,guest_id,room_id,status,note,found_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'Stored',$8,$9)`,
      [id, pid, d.item, d.room, foundBy, guestId, room[0] ? room[0].id : null, d.note || "", day]
    );
    await log({ propertyId: pid, actor: req.user.name, action: "logged a lost item",
      entity: "lost & found", detail: `${d.item} · Room ${d.room}` });
    res.status(201).json(await readOne(id));
  } catch (err) { next(err); }
});

/** PATCH /api/lost-found/:id — move an item along the register. */
router.patch("/:id", canTouch, validate(StatusSchema), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM lost_found WHERE id = $1`, [req.params.id]);
    const item = rows[0];
    if (!item) return res.status(404).json({ error: "Lost item not found." });
    if (!seesProperty(req, item.property_id)) {
      return res.status(403).json({ error: "That item is not on this property's register." });
    }

    const status = req.data.status;
    // Re-stating the status is not a second move: the item is where it stood
    // and the trail must not read the same hand-over twice.
    if (item.status === status) return res.json(await readOne(item.id));

    const claimedAt = status === "Returned"
      ? (item.claimed_at ? stamp(item.claimed_at) : new Date().toISOString())
      : (item.claimed_at ? stamp(item.claimed_at) : null);

    await pool.query(`UPDATE lost_found SET status = $2, claimed_at = $3 WHERE id = $1`,
      [item.id, status, claimedAt]);
    await log({ propertyId: item.property_id, actor: req.user.name, action: "updated lost & found",
      entity: "lost & found", detail: `${item.description} → ${status}` });
    res.json(await readOne(item.id));
  } catch (err) { next(err); }
});

module.exports = router;
