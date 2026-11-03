const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const LAU = require("../lib/laundry");
const { log } = require("../lib/log");
const { uid } = require("../lib/json");

const router = Router();
router.use(authenticate);

/** GET /api/laundry?propertyId=&status= */
router.get("/", can("run_laundry"), async (req, res, next) => {
  try {
    const { propertyId, status } = req.query;
    const params = [propertyId || req.user.propertyId];
    let sql = `${LAU.HEAD} WHERE lo.property_id = $1`;
    if (status) { params.push(status); sql += ` AND lo.status = $${params.length}`; }
    sql += ` ORDER BY lo.created_at DESC`;
    res.json(await LAU.withLines((await pool.query(sql, params)).rows));
  } catch (err) { next(err); }
});

/** GET /api/laundry/:id */
router.get("/:id", can("run_laundry"), async (req, res, next) => {
  try {
    const order = await LAU.orderBy(req.params.id);
    if (!order) return res.status(404).json({ error: "Laundry order not found." });
    res.json(order);
  } catch (err) { next(err); }
});

const LineSchema = z.object({
  id:  z.string(),
  qty: z.number().int().min(1),
});

const CreateSchema = z.object({
  reservationId: z.string(),
  items:         z.union([z.array(LineSchema), z.record(z.number().int().min(1))]).optional(),
  express:       z.boolean().default(false),
  notes:         z.string().default(""),
});

/** The washing is billed to the stay, so it is kept on that stay's books. */
function seesProperty(req, pid) {
  return req.user.role === "Manager" || pid === req.user.propertyId;
}

/**
 * POST /api/laundry — the board's own button. The pricing and posting live in
 * `lib/laundry.create`, which the seed calls too; the route owns the
 * transaction, so the lines, the order and the trail commit together or not at
 * all.
 */
router.post("/", can("run_laundry"), validate(CreateSchema), async (req, res, next) => {
  const d = req.data;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await LAU.create({
      client, actor: req.user.name, sees: (pid) => seesProperty(req, pid),
      reservationId: d.reservationId, items: LAU.toRows(d.items),
      express: d.express, notes: d.notes,
    });
    if (out.error) {
      await client.query("ROLLBACK");
      return res.status(out.status || 422).json({ error: out.error });
    }
    await client.query("COMMIT");
    res.status(201).json(out.order);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally { client.release(); }
});

async function notify({ propertyId, type, title, detail, link }) {
  await pool.query(
    `INSERT INTO notifications (id,property_id,type,title,detail,link,read) VALUES ($1,$2,$3,$4,$5,$6,false)`,
    [uid("ntf"), propertyId, type, title, detail, link]
  );
}

/**
 * PATCH /api/laundry/:id/status — the board's stage machine, ported from
 * `LHMS.actions.setLaundryStatus`.
 *
 * Work only moves forward. Stepping a finished order back would misreport what
 * the team has already handed over, and the folio has no idea the order exists,
 * so a stage is the only record of where the washing actually is. Re-stating the
 * stage a card is already on moves nothing and writes no trail line; the trail
 * says what changed, not what somebody re-read.
 */
router.patch("/:id/status", can("run_laundry"), async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!LAU.STAGES.includes(status)) {
      return res.status(422).json({ error: `Status must be one of: ${LAU.STAGES.join(", ")}` });
    }
    const { rows } = await pool.query(`${LAU.HEAD} WHERE lo.id = $1`, [req.params.id]);
    const order = rows[0];
    if (!order) return res.status(404).json({ error: "Laundry order not found." });
    if (!seesProperty(req, order.property_id)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (LAU.STAGES.indexOf(status) < LAU.STAGES.indexOf(order.status)) {
      return res.status(422).json({ error: `An order cannot go back from ${order.status}.` });
    }
    if (order.status === status) return res.json(await LAU.orderBy(order.id));

    const { rows: moved } = await pool.query(
      `UPDATE laundry_orders SET status = $2${status === "Collected" ? ", collected_at = now()" : ""}
       WHERE id = $1 AND status = $3 RETURNING *`,
      [order.id, status, order.status]
    );
    // Someone else moved the same card while this request was in flight: the
    // stage on file is not the one this move was calculated from, so nothing is
    // announced or recorded for it.
    if (!moved[0]) {
      return res.status(422).json({ error: `That order has moved since this request — it is now ${(await LAU.orderBy(order.id)).status}.` });
    }
    if (status === "Ready") {
      await notify({
        propertyId: order.property_id, type: "Laundry ready", title: "Laundry ready",
        detail: `${order.ref} · Room ${order.room_number || ""} · deliver or invite collection`,
        link: "#/laundry",
      });
    }
    await log({
      propertyId: order.property_id, actor: req.user.name,
      action: `moved a laundry order to ${status.toLowerCase()}`, entity: "laundry",
      detail: `${order.ref} · Room ${order.room_number || ""} · was ${order.status}`,
    });
    res.json(await LAU.orderBy(order.id));
  } catch (err) { next(err); }
});

module.exports = router;
