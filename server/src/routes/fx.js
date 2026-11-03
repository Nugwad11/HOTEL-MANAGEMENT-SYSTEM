/**
 * Exchange rates — the treasury screen the books are valued against.
 *
 * Two rules the whole module is built on, ported from the SPA:
 *   • a rate is read AS OF the date being asked about, so a filing cannot
 *     revalue a charge that was posted before it;
 *   • a rate goes off the air. A currency with no usable figure cannot be
 *     billed, paid or recorded in until someone files one.
 *
 * Filing a rate reprices every foreign figure the property holds, so the hand
 * that files one is the hand allowed to sign a wide price move. Anyone else's
 * figure waits in the register and lands through the same applier when cleared.
 */
const { Router } = require("express");
const { z } = require("zod");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const FX = require("../lib/fx");
const ledger = require("../lib/ledger");
const biz = require("../lib/business-date");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

// A rate decides what every foreign figure is worth on these books, so it is
// filed by the General Manager alone. The signing right is the second hand on
// someone else's ask, not a licence to clear one's own.
const isManager = (req) => req.user.role === "Manager";

function readScope(req) {
  const pid = req.query.propertyId || req.body.propertyId || req.user.propertyId;
  if (!isManager(req) && pid !== req.user.propertyId) {
    return { error: "Access to this property is not permitted." };
  }
  return { propertyId: pid };
}

/* ── reading the screen ──────────────────────────────────────── */

/**
 * The rates on file and what each of the property's monies is worth today.
 * The currencies listed are the ones the catalogue actually sells in: a rate for
 * a money nobody prices is a figure with nothing to convert.
 */
router.get("/rates", async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const date = req.query.date || undefined;
    const ctx = await FX.read({ propertyId: scope.propertyId, date });
    const catalogue = await FX.inCatalogue(ctx.base);
    res.json({
      base: ctx.base, maxAgeDays: ctx.maxAgeDays, date: ctx.date,
      rates: ctx.rates,
      currencies: FX.CURRENCIES.filter((c) => c.code === ctx.base || catalogue.indexOf(c.code) !== -1),
      states: catalogue.map((code) => FX.state(ctx.rates, code, ctx)),
    });
  } catch (err) { next(err); }
});

/** The monies the books cannot value right now — the close names these first. */
router.get("/states", async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const unusable = await FX.unusable({ propertyId: scope.propertyId, date: req.query.date });
    res.json(unusable.map((st) => ({ code: st.code, state: st.state, error: st.error })));
  } catch (err) { next(err); }
});

/* ── filing a rate ───────────────────────────────────────────── */

const RateSchema = z.object({
  propertyId: z.string().optional(),
  code: z.string(),
  perBase: z.number(),
  effective: z.string().optional(),
  note: z.string().optional(),
});

router.post("/rates", can("manage_financial_settings"), validate(RateSchema), async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });

    const day = await biz.businessDay();
    const ctx = await FX.read({ propertyId: scope.propertyId, date: day });
    const plan = await FX.plan(req.data, { day, base: ctx.base });
    if (plan.error) return res.status(422).json({ error: plan.error });

    // The move is judged against the rate the books are living on today, which is
    // the as-of reading before this filing replaces it — a same-day correction
    // counts as the gap it closes, not as a first figure.
    const previous = FX.rateOn(ctx.rates, plan.code, day);
    const move = previous ? Math.abs(plan.perBase - previous.perBase) : plan.perBase;
    if (!isManager(req)) {
      const queued = await ledger.queueApproval({
        propertyId: scope.propertyId, kind: "fx",
        subject: `${plan.code} rate · ${plan.base} per unit`, subjectId: plan.code,
        change: { data: { code: plan.code, perBase: plan.perBase, effective: plan.effective, note: plan.note } },
        // The figures are rates, quoted in the money the books keep.
        amount: move, currency: plan.base, from: previous ? previous.perBase : null, to: plan.perBase,
        reason: plan.note,
      }, req.user.name);
      await log({
        propertyId: scope.propertyId, actor: req.user.name,
        action: "asked for approval of a rate", entity: "approval",
        detail: `${queued.subject} · ${plan.perBase} ${plan.base} · ${plan.note} · awaiting a second signature`,
      });
      return res.status(202).json({ ok: true, queued });
    }

    const filed = await FX.file(plan, req.user.name);
    await log({
      propertyId: scope.propertyId, actor: req.user.name,
      action: `set the ${plan.code} rate`, entity: "currency",
      detail: `1 ${plan.code} = ${plan.perBase} ${plan.base} from ${plan.effective}` +
        (filed.previous !== null && filed.previous !== undefined
          ? ` · was ${filed.previous} ${plan.base}` : " · no earlier rate on file") +
        ` · ${plan.note}`,
    });
    res.status(201).json({
      rate: filed.rate, previous: filed.previous, replaced: filed.replaced,
      maxAgeDays: ctx.maxAgeDays,
    });
  } catch (err) { next(err); }
});

module.exports = router;
