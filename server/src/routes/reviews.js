const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, requireRole, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

const router = Router();
router.use(authenticate);

/** GET /api/reviews?propertyId=&rating=&channel=&responded= */
router.get("/", can("view_reports"), async (req, res, next) => {
  try {
    const { propertyId, rating, channel, responded, q, limit = 200, offset = 0 } = req.query;
    const pid = propertyId || req.user.propertyId;
    const params = [pid];
    const where = ["r.property_id = $1"];

    if (rating && rating !== "all") { params.push(Number(rating)); where.push(`r.rating = $${params.length}`); }
    if (channel && channel !== "all") { params.push(channel); where.push(`r.channel = $${params.length}`); }
    if (responded === "true")  where.push(`r.responded = true`);
    if (responded === "false") where.push(`r.responded = false`);
    if (q) {
      params.push(`%${q}%`);
      where.push(`(r.title ILIKE $${params.length} OR r.body ILIKE $${params.length} OR r.guest_name ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT r.*, g.tier AS guest_tier
       FROM reviews r LEFT JOIN guests g ON g.id = r.guest_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.review_date DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/reviews/stats/:propertyId */
router.get("/stats/:propertyId", can("view_reports"), async (req, res, next) => {
  try {
    /* One read of the property's reviews, totalled in the same shape the
       manager's page totals them: every star counted, the answered share taken
       off the same list. The aggregate used to cross join the tally against the
       register and ask "rating" of both, which no database can answer. */
    const { rows } = await pool.query(
      `SELECT rating, responded FROM reviews WHERE property_id = $1`,
      [req.params.propertyId]
    );
    const total = rows.length;
    const responded = rows.filter((r) => r.responded).length;
    const sum = rows.reduce((s, r) => s + Number(r.rating || 0), 0);

    res.json({
      total,
      responded,
      rate: total ? Math.round(responded / total * 100) : 0,
      avg: total ? Math.round((sum / total) * 100) / 100 : 0,
      dist: [5, 4, 3, 2, 1].map((n) => ({ n, count: rows.filter((r) => Number(r.rating) === n).length })),
    });
  } catch (err) { next(err); }
});

/** GET /api/reviews/:id */
router.get("/:id", can("view_reports"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM reviews WHERE id=$1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Review not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

const RespondSchema = z.object({
  response: z.string().min(10, "Response must be at least 10 characters."),
});

/** POST /api/reviews/:id/respond */
router.post("/:id/respond", requireRole("Manager", "Revenue"), validate(RespondSchema), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `UPDATE reviews
       SET responded=true, response=$2, responded_by=$3, responded_at=now()
       WHERE id=$1 RETURNING *`,
      [req.params.id, req.data.response, req.user.name]
    );
    if (!rows[0]) return res.status(404).json({ error: "Review not found." });

    await pool.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'responded to a review','review',$4)`,
      ["act_"+Math.random().toString(36).slice(2,8), rows[0].property_id, req.user.name,
       (rows[0].title||"").slice(0,60)]
    );
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
