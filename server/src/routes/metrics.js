/**
 * Metrics & reporting — all the KPI numbers the dashboard, manager
 * and reports pages need. Computed from the live DB, not cached.
 */
const { Router } = require("express");
const pool = require("../db/pool");
const audit = require("../lib/audit");
const { authenticate, can } = require("../middleware/auth");

const router = Router();
router.use(authenticate);

/** GET /api/metrics/:propertyId/today */
router.get("/:propertyId/today", async (req, res, next) => {
  try {
    const pid = req.params.propertyId;
    /* Every number on this strip is the close's own. Occupancy, ADR, the balance
       on the house and the arrival list all come out of audit.pack, so a manager
       reading the dashboard and a manager standing at the night audit are looking
       at one day, priced one way — two formulas here would mean two "today"s the
       moment the business date moves off the calendar. */
    const pack = await audit.pack(pid);

    const { rows: taskRow } = await pool.query(
      `SELECT COUNT(*) AS n FROM tasks WHERE property_id=$1 AND status != 'Done'`, [pid]
    );
    /* VIP is what the booking carries, with the top tier beside it: a Platinum
       guest is a VIP arrival even if nobody at the desk ticked the box. */
    const { rows: vipRow } = await pool.query(
      `SELECT COUNT(*) AS n FROM reservations r JOIN guests g ON g.id = r.guest_id
       WHERE r.property_id=$1 AND r.status='Confirmed' AND r.check_in=$2
         AND (r.vip OR g.tier='Platinum')`, [pid, pack.day]
    );

    res.json({
      ...pack.metrics,
      openTasks: Number(taskRow[0].n),
      vipArrivals: Number(vipRow[0].n),
      arrivalList: pack.arrivals,
      departureList: pack.departures,
      inHouseList: pack.inHouse,
    });
  } catch (err) { next(err); }
});

/** GET /api/metrics/:propertyId/channel-mix */
router.get("/:propertyId/channel-mix", can("view_reports"), async (req, res, next) => {
  try {
    const pid = req.params.propertyId;
    const { rows } = await pool.query(
      `SELECT channel, COUNT(*) AS count FROM reservations
       WHERE property_id=$1 AND status NOT IN ('Cancelled','Waitlist')
       GROUP BY channel ORDER BY count DESC`, [pid]
    );
    const total = rows.reduce((s, r) => s + parseInt(r.count), 0) || 1;
    res.json(rows.map(r => ({ name: r.channel, count: parseInt(r.count), pct: Math.round(parseInt(r.count) / total * 100) })));
  } catch (err) { next(err); }
});

/** GET /api/metrics/:propertyId/department-revenue */
router.get("/:propertyId/department-revenue", can("view_reports"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.department, SUM(c.amount) AS amount
       FROM charges c JOIN reservations r ON r.id=c.reservation_id
       WHERE r.property_id=$1 AND NOT c.voided
       GROUP BY c.department ORDER BY amount DESC`, [req.params.propertyId]
    );
    res.json(rows.map(r => ({ name: r.department, amount: parseFloat(r.amount) })));
  } catch (err) { next(err); }
});

module.exports = router;
