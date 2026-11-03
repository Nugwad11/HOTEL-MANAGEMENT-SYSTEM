/**
 * The approvals register — the four-eyes queue the desk actions raise into.
 *
 * A request holds the exact payload the original action would have run, so
 * approving applies that same code path here rather than a second version of
 * the rules written for the queue.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const ledger = require("../lib/ledger");
const P = require("../lib/price");
const FX = require("../lib/fx");
const biz = require("../lib/business-date");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

const isManager = (req) => req.user.role === "Manager";

router.get("/", async (req, res, next) => {
  try {
    const params = [];
    let sql = `SELECT * FROM approvals`;
    const where = [];
    if (!isManager(req)) { params.push(req.user.propertyId); where.push(`property_id = $${params.length}`); }
    else if (req.query.propertyId) { params.push(req.query.propertyId); where.push(`property_id = $${params.length}`); }
    if (req.query.status) { params.push(req.query.status); where.push(`status = $${params.length}`); }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    const { rows } = await pool.query(sql, params);
    res.json(ledger.orderApprovals(rows));
  } catch (err) { next(err); }
});

router.get("/:id", async (req, res, next) => {
  try {
    const a = await one(req.params.id);
    if (!a) return res.status(404).json({ error: "That request is not in the register." });
    if (!isManager(req) && a.propertyId !== req.user.propertyId) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    res.json(a);
  } catch (err) { next(err); }
});

async function one(id) {
  const { rows } = await pool.query(`SELECT * FROM approvals WHERE id = $1`, [id]);
  return rows[0] ? ledger.mapApproval(rows[0]) : null;
}

/**
 * What a signed-off request actually does. Every branch calls the same applier
 * the immediate action would have called, so an approved refund leaves the same
 * history entry as one the desk applied without asking.
 */
async function applyApproval(a, actor) {
  if (a.kind === "price") {
    const row = await P.priceRow(a.subjectId);
    if (!row) return { error: "The price this request was made against is gone — it cannot be applied." };
    // A rate the desk moved while this waited is a different question from the
    // one the approver read, so it goes back to the front of the queue.
    if (row.amount !== a.from) {
      return { error: "That price has moved since this was asked. Raise it again against the current figure." };
    }
    const applied = await P.applyPricePatch(row, a.change.patch, a.change.reason || a.reason, actor);
    return applied.error ? applied : { ok: true, price: applied.price, log: applied };
  }

  if (a.kind === "fx") {
    // The same staleness test the price carries: a rate somebody filed while
    // this waited is a different question from the one the approver read.
    const day = await biz.businessDay();
    const ctx = await FX.read({ propertyId: a.propertyId, date: day });
    const data = a.change.data;
    const plan = await FX.plan(data, { day, base: ctx.base });
    if (plan.error) return { error: plan.error };
    const current = FX.rateOn(ctx.rates, plan.code, plan.effective);
    if (a.from === null && current) {
      return {
        error: `A ${plan.code} rate was filed for that day while this waited. ` +
          `Raise it again against the figure on file.`,
      };
    }
    if (a.from !== null && (!current || current.perBase !== a.from)) {
      return { error: "That rate has moved since this was asked. Raise it again against the current figure." };
    }
    const filed = await FX.file(plan, actor);
    return { ok: true, rate: filed.rate, previous: filed.previous };
  }

  const doc = await ledger.loadInvoice(a.change.invoiceId);
  if (!doc) return { error: "The invoice this request was made against is gone — it cannot be applied." };
  if (doc.inv.status === "Void") return { error: `${doc.inv.number} was voided while this waited.` };

  const amount = Math.round(Number(a.change.data.amount));
  if (a.kind === "refund") {
    if (amount > doc.totals.settled) {
      return { error: `Only ${doc.totals.settled} stands against ${doc.inv.number} now — less than this refund.` };
    }
    const day = await biz.businessDay();
    const sealed = await biz.sealedRefusal(a.change.data.date || day);
    if (sealed) return { error: sealed };
    const applied = await ledger.applyRefund(doc.inv, a.change.data, actor, day);
    return { ok: true, invoice: doc.inv, ...applied };
  }
  if (amount > doc.totals.total) {
    return { error: `${doc.inv.number} now totals ${doc.totals.total} — less than this discount.` };
  }
  const applied = await ledger.applyDiscount(doc.inv, a.change.data, actor);
  return { ok: true, invoice: doc.inv, ...applied };
}

const NEEDS_NOTE = "A decision needs a note for the audit trail.";
const DecideSchema = z.object({
  approve: z.boolean(),
  note: z.string({ required_error: NEEDS_NOTE }).min(1, NEEDS_NOTE),
});

// A request is only ever closed once, and never by the person who raised it.
router.post("/:id/decide", can("approve_financial_changes"), validate(DecideSchema), async (req, res, next) => {
  try {
    const a = await one(req.params.id);
    if (!a) return res.status(404).json({ error: "That request is not in the register." });
    if (!isManager(req) && a.propertyId !== req.user.propertyId) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (a.status !== "Pending") {
      return res.status(422).json({ error: `This request was already ${a.status.toLowerCase()}.` });
    }
    if (a.requestedBy === req.user.name) {
      return res.status(422).json({ error: "You raised this request — a second pair of hands has to clear it." });
    }
    const note = String(req.data.note).trim();
    if (!note) return res.status(422).json({ error: "A decision needs a note for the audit trail." });

    let applied = { ok: true };
    if (req.data.approve) {
      applied = await applyApproval(a, req.user.name);
      if (applied.error) return res.status(422).json({ error: applied.error });
    }

    await pool.query(
      `UPDATE approvals SET status=$2, decided_by=$3, decided_at=$4, decision_note=$5 WHERE id=$1`,
      [a.id, req.data.approve ? "Approved" : "Rejected", req.user.name, new Date().toISOString(), note]
    );
    await log({
      propertyId: a.propertyId, actor: req.user.name,
      action: req.data.approve ? `approved a ${a.kind}` : `rejected a ${a.kind}`, entity: "approval",
      detail: `${a.subject} · ${a.amount} · ${note}`,
    });
    res.json({ approval: await one(a.id), applied });
  } catch (err) { next(err); }
});

module.exports = router;
