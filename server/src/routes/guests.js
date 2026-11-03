const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, requireRole, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");

const router = Router();
router.use(authenticate);

/* The notes travel on their own select rather than aggregated onto the guest:
   pg-mem — the database the API's tests run against — cannot carry a GROUP BY or
   a subquery back to an aliased table, and two plain selects cost the same on a
   live server. Newest first, with the empty array the page expects for a guest
   nobody has written about yet. */
async function attachNotes(guests) {
  if (!guests.length) return guests;
  const params = guests.map((g) => g.id);
  const { rows: notes } = await pool.query(
    `SELECT * FROM guest_notes
     WHERE guest_id IN (${params.map((_, i) => `$${i + 1}`).join(",")})
     ORDER BY created_at DESC, id`,
    params
  );
  const by = {};
  for (const g of guests) by[g.id] = [];
  for (const n of notes) by[n.guest_id].push(n);
  return guests.map((g) => Object.assign({}, g, { notes: by[g.id] }));
}

/** GET /api/guests?q=&tier=&propertyId= */
router.get("/", can("view_guest_profiles"), async (req, res, next) => {
  try {
    const { q, tier, limit = 100, offset = 0 } = req.query;
    let sql = `SELECT g.* FROM guests g`;
    const params = [];
    const where = [];
    if (q) { params.push(`%${q}%`); where.push(`(g.name ILIKE $${params.length} OR g.email ILIKE $${params.length})`); }
    if (tier) { params.push(tier); where.push(`g.tier = $${params.length}`); }
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += ` ORDER BY g.name LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    const { rows } = await pool.query(sql, params);
    res.json(await attachNotes(rows));
  } catch (err) { next(err); }
});

/** GET /api/guests/:id */
router.get("/:id", can("view_guest_profiles"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT g.* FROM guests g WHERE g.id = $1`, [req.params.id]);
    // Guests can only fetch their own profile
    if (req.user.role === "Guest" && req.user.guestId !== req.params.id) {
      return res.status(403).json({ error: "You can only view your own profile." });
    }
    if (!rows[0]) return res.status(404).json({ error: "Guest not found." });
    const [guest] = await attachNotes(rows);
    res.json(guest);
  } catch (err) { next(err); }
});

const CreateSchema = z.object({
  title:      z.string().optional(),
  firstName:  z.string().min(1, "First name is required."),
  lastName:   z.string().min(1, "Last name is required."),
  email:      z.string().email("Enter a valid email.").optional().or(z.literal("")),
  phone:      z.string().optional(),
  country:    z.string().optional(),
  city:       z.string().optional(),
  tier:       z.enum(["Member","Silver","Gold","Platinum"]).default("Member"),
  idType:     z.string().optional(),
  idNumber:   z.string().optional(),
  marketing:  z.boolean().default(false),
});

/** POST /api/guests */
router.post("/", can("edit_guest_profiles"), validate(CreateSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const name = `${d.firstName} ${d.lastName}`.trim();
    const id = "gst_" + Math.random().toString(36).slice(2, 8);
    const { rows } = await pool.query(
      `INSERT INTO guests (id,title,first_name,last_name,name,email,phone,country,city,tier,id_type,id_number,since,preferences,consent,tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [id, d.title || "Mr", d.firstName, d.lastName, name, d.email || "", d.phone || "",
       d.country || "Nigeria", d.city || "", d.tier, d.idType || "International passport",
       d.idNumber || "", new Date().getFullYear(),
       JSON.stringify({ pillow:"No preference", room:"No preference", dietary:"No restrictions", allergies:"None", beverage:"Still water", newspaper:"None", turndown:"On request" }),
       JSON.stringify({ marketing: d.marketing, dataSharing: false, profiling: true }),
       JSON.stringify(["New profile"])]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

const UpdateSchema = z.object({
  title:       z.string().optional(),
  firstName:   z.string().optional(),
  lastName:    z.string().optional(),
  email:       z.string().email().optional().or(z.literal("")),
  phone:       z.string().optional(),
  country:     z.string().optional(),
  city:        z.string().optional(),
  tier:        z.enum(["Member","Silver","Gold","Platinum"]).optional(),
  preferences: z.record(z.string()).optional(),
  consent:     z.object({ marketing: z.boolean(), dataSharing: z.boolean().optional(), profiling: z.boolean().optional() }).optional(),
  tags:        z.array(z.string()).optional(),
  language:    z.string().optional(),
}).partial();

/** PATCH /api/guests/:id */
router.patch("/:id", can("edit_guest_profiles"), validate(UpdateSchema), async (req, res, next) => {
  try {
    if (req.user.role === "Guest" && req.user.guestId !== req.params.id) {
      return res.status(403).json({ error: "You can only edit your own profile." });
    }
    const d = req.data;
    // Build the name if first/last changed
    if (d.firstName || d.lastName) {
      const { rows: cur } = await pool.query(`SELECT first_name, last_name FROM guests WHERE id = $1`, [req.params.id]);
      if (cur[0]) {
        const fn = d.firstName || cur[0].first_name;
        const ln = d.lastName  || cur[0].last_name;
        d.name = `${fn} ${ln}`.trim();
      }
    }
    const sets = []; const params = [req.params.id];
    const scalar = { title:"title", firstName:"first_name", lastName:"last_name", name:"name", email:"email", phone:"phone", country:"country", city:"city", tier:"tier", language:"language", tags:"tags" };
    for (const [k, col] of Object.entries(scalar)) {
      if (d[k] !== undefined) { params.push(k === "tags" ? JSON.stringify(d[k]) : d[k]); sets.push(`${col} = $${params.length}`); }
    }
    if (d.preferences) {
      params.push(JSON.stringify(d.preferences));
      sets.push(`preferences = preferences || $${params.length}::jsonb`);
    }
    if (d.consent) {
      params.push(JSON.stringify(d.consent));
      sets.push(`consent = consent || $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(422).json({ error: "Nothing to update." });
    const { rows } = await pool.query(
      `UPDATE guests SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params
    );
    if (!rows[0]) return res.status(404).json({ error: "Guest not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

/** POST /api/guests/:id/notes */
router.post("/:id/notes", can("edit_guest_profiles"), async (req, res, next) => {
  try {
    const text = String(req.body.text || "").trim();
    if (!text) return res.status(422).json({ error: "Note text is required." });
    const id = "note_" + Math.random().toString(36).slice(2, 8);
    const { rows } = await pool.query(
      `INSERT INTO guest_notes (id, guest_id, text, recorded_by, recorded_at) VALUES ($1,$2,$3,$4,CURRENT_DATE) RETURNING *`,
      [id, req.params.id, text, req.user.name]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
