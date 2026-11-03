const { Router } = require("express");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");

const router = Router();
router.use(authenticate);

/** GET /api/activity?propertyId=&q=&entity=&actor=&limit= */
router.get("/", can("view_reports"), async (req, res, next) => {
  try {
    const { propertyId, q, entity, actor, limit = 250, offset = 0 } = req.query;
    const pid = propertyId || req.user.propertyId;
    const params = [pid];
    const where = ["property_id = $1"];
    if (entity && entity !== "all") { params.push(entity); where.push(`entity = $${params.length}`); }
    if (actor  && actor  !== "all") { params.push(actor);  where.push(`actor = $${params.length}`); }
    if (q) { params.push(`%${q}%`); where.push(`(action ILIKE $${params.length} OR detail ILIKE $${params.length} OR actor ILIKE $${params.length})`); }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM activity_log WHERE ${where.join(" AND ")}
       ORDER BY created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** POST /api/activity — internal: write an audit entry */
router.post("/", authenticate, async (req, res, next) => {
  try {
    const { action, entity, detail, propertyId } = req.body;
    const id = "act_" + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, propertyId || req.user.propertyId, req.user.name, action, entity || "", detail || ""]
    );
    res.status(201).json({ ok: true });
  } catch (err) { next(err); }
});

/** GET /api/notifications?propertyId= */
router.get("/notifications", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    const { rows } = await pool.query(
      `SELECT * FROM notifications WHERE property_id=$1 ORDER BY created_at DESC LIMIT 100`, [pid]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** PATCH /api/notifications/:id */
router.patch("/notifications/:id", async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE notifications SET read=$2 WHERE id=$1 RETURNING *`, [req.params.id, !!req.body.read]
    );
    if (!rows[0]) return res.status(404).json({ error: "Notification not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** POST /api/notifications/mark-all-read */
router.post("/notifications/mark-all-read", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    await pool.query(`UPDATE notifications SET read=true WHERE property_id=$1`, [pid]);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
