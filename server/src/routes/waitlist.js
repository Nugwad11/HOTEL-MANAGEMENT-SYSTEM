/**
 * Waitlist — the port of the front desk's board and the booking page's offer card
 * (assets/pages-frontdesk.js waitlistPanel, LHMS.waitlist).
 *
 * The board reads the whole picture in one pass: every offer on record with its
 * live state, and the stays still waiting in the order the desk will call them.
 * Releasing, accepting and declining are the same passes a cancellation runs, so
 * a hold taken by the desk and a hold taken by a cancellation cannot disagree.
 */
const { Router } = require("express");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const W = require("../lib/waitlist");

const router = Router();
router.use(authenticate);

function seesProperty(req, pid) {
  return req.user.role === "Manager" || pid === req.user.propertyId;
}

/** The property a single offer's action is confined to — none for a manager, who
 *  may work any hotel's board, as every other route lets them. */
const scoped = (req) => (req.user.role === "Manager" ? null : req.user.propertyId);

/** GET /api/waitlist?propertyId= — the board: offers plus the queue behind them. */
router.get("/", can("manage_reservations"), async (req, res, next) => {
  try {
    const pid = req.query.propertyId || req.user.propertyId;
    if (!seesProperty(req, pid)) {
      return res.status(403).json({ error: "That waitlist belongs to another property." });
    }
    const [offers, queue] = await Promise.all([W.offers(pid), W.queue(pid)]);
    res.json({ offers, queue, holdHours: W.HOLD_HOURS });
  } catch (err) { next(err); }
});

/** POST /api/waitlist/release — the desk's own pass over the queue. */
router.post("/release", can("manage_reservations"), async (req, res, next) => {
  try {
    const pid = req.body.propertyId || req.user.propertyId;
    if (!seesProperty(req, pid)) {
      return res.status(403).json({ error: "That waitlist belongs to another property." });
    }
    const out = await W.release(pid, { actor: req.user.name });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

/** POST /api/waitlist/:id/accept — take the released room and bill the stay. */
router.post("/:id/accept", can("manage_reservations"), async (req, res, next) => {
  try {
    const out = await W.accept(req.params.id, {
      actor: req.user.name, propertyId: scoped(req),
    });
    if (out.error) return res.status(out.status || 422).json({ error: out.error });
    res.json(out);
  } catch (err) { next(err); }
});

/** POST /api/waitlist/:id/decline — pass the room to the next request. */
router.post("/:id/decline", can("manage_reservations"), async (req, res, next) => {
  try {
    const out = await W.decline(req.params.id, {
      actor: req.user.name, propertyId: scoped(req),
    });
    if (out.error) return res.status(out.status || 422).json({ error: out.error });
    res.json(out);
  } catch (err) { next(err); }
});

module.exports = router;
