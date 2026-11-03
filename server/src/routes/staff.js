const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, requireRole, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

const router = Router();
router.use(authenticate);

/** GET /api/staff?propertyId= */
router.get("/", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    const { rows } = await pool.query(
      `SELECT * FROM staff WHERE property_id = $1 ORDER BY name`, [pid]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/staff/permissions */
router.get("/permissions", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT data FROM staff_permissions WHERE id = 1`);
    res.json(rows[0]?.data || {});
  } catch (err) { next(err); }
});

const CreateSchema = z.object({
  propertyId:  z.string(),
  name:        z.string().min(1),
  email:       z.string().email(),
  title:       z.string().optional(),
  role:        z.enum(["Manager","Front Desk","Housekeeping","Revenue","Finance Manager"]),
  department:  z.string().optional(),
  shift:       z.string().optional(),
  phone:       z.string().optional(),
});

/** POST /api/staff — manager only */
router.post("/", requireRole("Manager"), validate(CreateSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const id = "stf_" + Math.random().toString(36).slice(2, 8);
    const { rows } = await pool.query(
      `INSERT INTO staff (id,property_id,name,email,title,role,department,shift,phone,status,started)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Active',CURRENT_DATE) RETURNING *`,
      [id, d.propertyId, d.name, d.email, d.title || d.role, d.role, d.department || "Front Office", d.shift || "08:00–17:00", d.phone || ""]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/** PATCH /api/staff/:id */
router.patch("/:id", requireRole("Manager"), async (req, res, next) => {
  try {
    const allowed = ["name","email","title","role","department","shift","phone","status"];
    const fields = Object.entries(req.body).filter(([k]) => allowed.includes(k));
    if (!fields.length) return res.status(422).json({ error: "Nothing to update." });
    const sets   = fields.map(([k], i) => `${k} = $${i + 2}`).join(", ");
    const vals   = fields.map(([, v]) => v);
    const { rows } = await pool.query(
      `UPDATE staff SET ${sets} WHERE id = $1 RETURNING *`, [req.params.id, ...vals]
    );
    if (!rows[0]) return res.status(404).json({ error: "Staff member not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** PATCH /api/staff/permissions — manager only */
router.patch("/permissions", requireRole("Manager"), async (req, res, next) => {
  try {
    const { role, perm, value } = req.body;
    const validRoles = ["Front Desk","Housekeeping","Revenue"];
    if (!validRoles.includes(role)) return res.status(422).json({ error: "Invalid role." });
    const { rows } = await pool.query(
      `UPDATE staff_permissions
       SET data = jsonb_set(data, ARRAY[$1::text, $2::text], $3::jsonb)
       WHERE id = 1 RETURNING data`,
      [role, perm, JSON.stringify(!!value)]
    );
    res.json(rows[0]?.data || {});
  } catch (err) { next(err); }
});

module.exports = router;
