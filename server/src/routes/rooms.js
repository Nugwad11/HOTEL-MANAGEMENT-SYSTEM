const { Router } = require("express");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");

const router = Router();
router.use(authenticate);

/** GET /api/rooms?propertyId= */
router.get("/", async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    const { rows } = await pool.query(
      `SELECT r.*, rt.name AS type_name, rt.code AS type_code, rt.occupancy, rt.size
       FROM rooms r JOIN room_types rt ON rt.id = r.type_id
       WHERE r.property_id = $1 ORDER BY r.floor, r.number`,
      [pid]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/rooms/types */
router.get("/types", async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM room_types ORDER BY name`);
    res.json(rows);
  } catch (err) { next(err); }
});

/** GET /api/rooms/types/:id/availability */
router.get("/types/:typeId/availability", async (req, res, next) => {
  try {
    const { checkIn, checkOut, propertyId } = req.query;
    const pid = propertyId || req.user.propertyId;
    if (!checkIn || !checkOut) return res.status(422).json({ error: "checkIn and checkOut are required." });
    const { rows } = await pool.query(
      `SELECT ro.id FROM rooms ro
       LEFT JOIN reservations rs
         ON rs.room_id = ro.id
        AND rs.status IN ('Confirmed','In-house')
        AND rs.check_in < $4 AND rs.check_out > $3
       WHERE ro.property_id = $1 AND ro.type_id = $2
         AND ro.hk_status NOT IN ('Out of order','Out of service')
         AND rs.id IS NULL
       ORDER BY ro.floor, ro.number`,
      [pid, req.params.typeId, checkIn, checkOut]
    );
    res.json({ typeId: req.params.typeId, free: rows.length, rooms: rows.map(r => r.id) });
  } catch (err) { next(err); }
});

/** PATCH /api/rooms/:id/status — housekeeping */
router.patch("/:id/status", can("housekeeping_board"), async (req, res, next) => {
  try {
    const validStatuses = ["Available","Dirty","Inspected","Out of order","Out of service"];
    const { hkStatus, oooReason } = req.body;
    if (!validStatuses.includes(hkStatus)) {
      return res.status(422).json({ error: `Invalid status. Must be one of: ${validStatuses.join(", ")}` });
    }
    const { rows } = await pool.query(
      `UPDATE rooms SET hk_status=$2, ooo_reason=$3 WHERE id=$1 RETURNING *`,
      [req.params.id, hkStatus, oooReason || null]
    );
    if (!rows[0]) return res.status(404).json({ error: "Room not found." });
    res.json(rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
