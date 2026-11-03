/**
 * Night audit endpoints — the pack, the checklist, the close, and the sealed
 * days already on file.
 *
 * The run belongs to the whole group: one business date, so the nights it posts
 * cross every property even though the pack it seals is the one it was read on.
 */
const { Router } = require("express");
const { z } = require("zod");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const biz = require("../lib/business-date");
const audit = require("../lib/audit");

const router = Router();
router.use(authenticate);

const isManager = (req) => req.user.role === "Manager";

function scope(req) {
  const pid = req.query.propertyId || req.body.propertyId || req.user.propertyId;
  if (!isManager(req) && pid !== req.user.propertyId) {
    return { error: "Access to this property is not permitted." };
  }
  return { propertyId: pid };
}

/**
 * GET /api/audit/pack — everything the close screen shows. Reading it is the
 * closer's job, so it is guarded with the same right as the run.
 */
router.get("/pack", can("night_audit"), async (req, res, next) => {
  try {
    const s = scope(req);
    if (s.error) return res.status(403).json({ error: s.error });
    res.json(await audit.pack(s.propertyId));
  } catch (err) { next(err); }
});

/** GET /api/audit/checks — the controls, with the figures beside each. */
router.get("/checks", can("night_audit"), async (req, res, next) => {
  try {
    const s = scope(req);
    if (s.error) return res.status(403).json({ error: s.error });
    const p = await audit.pack(s.propertyId);
    res.json({ day: p.day, checks: audit.checks(p) });
  } catch (err) { next(err); }
});

/** GET /api/audit/business-date — the date money is being dated against. */
router.get("/business-date", async (req, res, next) => {
  try {
    const day = await biz.businessDay();
    res.json({ day, closed: !!(await biz.closedOn(day)) });
  } catch (err) { next(err); }
});

/** GET /api/audit/closed — the sealed days, newest first. */
router.get("/closed", can("view_reports"), async (req, res, next) => {
  try {
    res.json(await audit.closedDays(Number(req.query.limit) || 30));
  } catch (err) { next(err); }
});

const RunSchema = z.object({
  propertyId: z.string().optional(),
  checks: z.record(z.string()).default({}),
});

// A close is permanent: the pack it stores is the record finance read afterwards,
// so nothing writes into the day it sealed.
router.post("/run", can("night_audit"), validate(RunSchema), async (req, res, next) => {
  try {
    const s = scope(req);
    if (s.error) return res.status(403).json({ error: s.error });
    const out = await audit.run({ propertyId: s.propertyId, actor: req.user.name, attest: req.data.checks });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json(out);
  } catch (err) { next(err); }
});

module.exports = router;
