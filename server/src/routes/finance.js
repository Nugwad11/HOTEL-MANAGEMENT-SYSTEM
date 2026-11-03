/**
 * Finance — the settings that decide how documents are numbered and when a
 * change needs a second signature, the operating-expense ledger, and the
 * statement the dashboard reads.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const F = require("../lib/finance");
const ledger = require("../lib/ledger");
const FX = require("../lib/fx");
const { jsonIn, jsonOut, uid } = require("../lib/json");
const biz = require("../lib/business-date");
const { statement, periodOf, pctDelta } = require("../lib/statement");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

const EXPENSE_CATEGORIES = [
  "Payroll", "Utilities", "Cost of sales", "Repairs & maintenance", "Housekeeping",
  "Laundry", "Marketing", "Statutory", "Technology", "Other operating",
];

const isManager = (req) => req.user.role === "Manager";
const targetProperty = (req) => {
  const pid = req.query.propertyId || req.body.propertyId || req.user.propertyId;
  if (!isManager(req) && pid !== req.user.propertyId) {
    return { error: "Access to this property is not permitted." };
  }
  return { propertyId: pid };
};

/* ── financial settings ──────────────────────────────────────── */

router.get("/settings", async (req, res, next) => {
  try {
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    res.json(await ledger.financeSettings(scope.propertyId));
  } catch (err) { next(err); }
});

const SettingsSchema = z.object({
  propertyId: z.string().optional(),
  invoicePrefix: z.string().optional(),
  paymentDays: z.number().optional(),
  approvalAmount: z.number().optional(),
  discountPct: z.number().optional(),
  rateMaxAgeDays: z.number().optional(),
});

// The rules themselves are the last thing to need a second signature: a
// property can widen its own approval limit, so editing them is limited to
// whoever already holds the right to change them.
router.patch("/settings", can("manage_financial_settings"), validate(SettingsSchema), async (req, res, next) => {
  try {
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });

    const before = await ledger.financeSettings(scope.propertyId);
    const plan = F.planFinanceSettings(req.data, before);
    if (plan.error) return res.status(422).json({ error: plan.error });

    const { rows } = await pool.query(`SELECT data FROM settings WHERE property_id = $1`, [scope.propertyId]);
    if (!rows[0]) return res.status(404).json({ error: "Property settings not found." });
    const blob = jsonIn(rows[0].data, {});
    blob.finance = plan.settings;
    await pool.query(`UPDATE settings SET data = $2 WHERE property_id = $1`,
      [scope.propertyId, jsonOut(blob)]);

    await log({
      propertyId: scope.propertyId, actor: req.user.name, action: "changed the financial settings",
      entity: "financial settings",
      detail: plan.changed.join(" · ") + " · applies to the next document or decision, not to one already raised",
    });
    res.json({ settings: plan.settings, changed: plan.changed });
  } catch (err) { next(err); }
});

/* ── operating expenses ──────────────────────────────────────── */

function mapExpense(row) {
  return {
    id: row.id, propertyId: row.property_id, date: biz.dstr(row.expense_date),
    category: row.category, description: row.description, amount: Number(row.amount),
    currency: row.currency,
    fxRate: row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate),
    baseAmount: row.base_amount === null || row.base_amount === undefined ? null : Number(row.base_amount),
    method: row.method, payee: row.payee, attachment: row.attachment,
    status: row.status, recordedBy: row.recorded_by, recordedAt: row.recorded_at,
    decidedBy: row.decided_by, decidedAt: row.decided_at, decisionNote: row.decision_note,
  };
}

router.get("/expenses", async (req, res, next) => {
  try {
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const params = [scope.propertyId];
    let sql = `SELECT * FROM expenses WHERE property_id = $1`;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status = $${params.length}`; }
    if (req.query.from) { params.push(req.query.from); sql += ` AND expense_date >= $${params.length}`; }
    if (req.query.to) { params.push(req.query.to); sql += ` AND expense_date <= $${params.length}`; }
    sql += " ORDER BY expense_date DESC, recorded_at DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(mapExpense));
  } catch (err) { next(err); }
});

const ExpenseSchema = z.object({
  propertyId: z.string().optional(),
  amount: z.number(),
  category: z.string(),
  description: z.string(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  method: z.string().optional(),
  payee: z.string().optional(),
  currency: z.string().optional(),
  attachment: z.string().optional(),
});

// Recording and approval are two different hands: the person who raises a cost
// cannot be the one who lets it into the result.
router.post("/expenses", can("record_expenses"), validate(ExpenseSchema), async (req, res, next) => {
  try {
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const d = req.data;

    const amount = Math.round(Number(d.amount));
    if (!amount || amount <= 0) return res.status(422).json({ error: "Enter a cost greater than zero." });
    const description = String(d.description || "").trim();
    if (!description) return res.status(422).json({ error: "Describe what the money bought." });
    if (!EXPENSE_CATEGORIES.includes(d.category)) return res.status(422).json({ error: "Choose an expense category." });

    const day = await biz.businessDay();
    const date = d.date || day;
    if (date > day) return res.status(422).json({ error: "A cost cannot be dated in the future." });
    const sealed = await biz.sealedRefusal(date);
    if (sealed) return res.status(409).json({ error: sealed });

    // A supplier invoice in a money the books cannot value is not a cost the
    // property can record — it is an open question about what it will become.
    const read = await FX.read({ propertyId: scope.propertyId, date });
    const cur = String(d.currency || read.base).toUpperCase();
    const blocked = FX.gateIn(read, cur);
    if (blocked) return res.status(422).json({ error: blocked.error });
    const stamp = FX.stampIn(read, amount, cur);
    if (stamp.error) return res.status(422).json({ error: stamp.error });
    // The ceiling on a line is written in the property's own money, so a foreign
    // invoice from a supplier is measured by what it costs here.
    if (stamp.baseAmount > 500000000) {
      return res.status(422).json({
        error: `A single line above ${read.base} 500,000,000 needs the group office, not this form.`,
      });
    }

    const e = {
      id: uid("exp"), propertyId: scope.propertyId, date, category: d.category, description,
      amount, currency: cur, fxRate: stamp.fxRate, baseAmount: stamp.baseAmount,
      method: d.method || "Transfer",
      payee: String(d.payee || "").trim() || "Unspecified supplier",
      attachment: String(d.attachment || "").trim() || null,
      recordedBy: req.user.name, status: "Pending",
    };
    await pool.query(
      `INSERT INTO expenses
       (id,property_id,expense_date,category,description,amount,currency,fx_rate,base_amount,
        method,payee,attachment,status,recorded_by,recorded_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
      [e.id, e.propertyId, e.date, e.category, e.description, e.amount, e.currency,
        e.fxRate, e.baseAmount, e.method, e.payee, e.attachment, e.status, e.recordedBy,
        new Date().toISOString()]
    );
    await log({
      propertyId: e.propertyId, actor: req.user.name, action: "recorded an expense",
      entity: "expense", detail: `${e.category} · ${e.amount} ${e.currency} · ${e.payee} · awaiting approval`,
    });
    res.status(201).json(await oneExpense(e.id));
  } catch (err) { next(err); }
});

async function oneExpense(id) {
  const { rows } = await pool.query(`SELECT * FROM expenses WHERE id = $1`, [id]);
  return rows[0] ? mapExpense(rows[0]) : null;
}

const DecideSchema = z.object({
  approve: z.boolean(),
  note: z.string().min(1, "A decision needs a note for the audit trail.").optional(),
});

// A decision is final. Correcting a cost means recording a new line, so the
// ledger keeps every version of what someone approved.
router.post("/expenses/:id/decide", can("approve_expenses"), validate(DecideSchema), async (req, res, next) => {
  try {
    const existing = await oneExpense(req.params.id);
    if (!existing) return res.status(404).json({ error: "Expense not found." });
    if (!isManager(req) && existing.propertyId !== req.user.propertyId) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (existing.status !== "Pending") {
      return res.status(422).json({ error: `This line was already ${existing.status.toLowerCase()} by ${existing.decidedBy}.` });
    }
    const status = req.data.approve ? "Approved" : "Rejected";
    await pool.query(
      `UPDATE expenses SET status=$2, decided_by=$3, decided_at=$4, decision_note=$5 WHERE id=$1`,
      [req.params.id, status, req.user.name, new Date().toISOString(),
        req.data.note ? String(req.data.note).trim() : null]
    );
    await log({
      propertyId: existing.propertyId, actor: req.user.name,
      action: req.data.approve ? "approved an expense" : "rejected an expense",
      entity: "expense",
      detail: `${existing.category} · ${existing.amount} · ${existing.payee}${req.data.note ? " · " + req.data.note : ""}`,
    });
    res.json(await oneExpense(req.params.id));
  } catch (err) { next(err); }
});

/* ── the statement ───────────────────────────────────────────── */

const RANGE_KEYS = { day: 1, week: 7, month: 30, year: 365 };

router.get("/statement", async (req, res, next) => {
  try {
    if (!isManager(req) && !(req.user.permissions || {}).view_reports) {
      return res.status(403).json({ error: "Permission 'view_reports' is required." });
    }
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });

    const days = req.query.days ? Number(req.query.days) : (RANGE_KEYS[req.query.range] || 30);
    if (!Number.isInteger(days) || days < 1 || days > 730) {
      return res.status(422).json({ error: "A statement window is between 1 and 730 days." });
    }
    const day = await biz.businessDay();
    const p = periodOf(day, days);
    const now = await statement(scope.propertyId, p.from, p.to);
    const prev = await statement(scope.propertyId, p.prevFrom, p.prevTo);
    const delta = {};
    ["revenue", "collected", "expenses", "net", "outstanding", "refunded"].forEach((k) => {
      delta[k] = pctDelta(now[k], prev[k]);
    });
    res.json({ period: p, now, prev, delta, expenseCategories: EXPENSE_CATEGORIES });
  } catch (err) { next(err); }
});

/** Drill-down: the actual transactions behind a department figure. */
router.get("/statement/department", async (req, res, next) => {
  try {
    if (!isManager(req) && !(req.user.permissions || {}).view_reports) {
      return res.status(403).json({ error: "Permission 'view_reports' is required." });
    }
    const scope = targetProperty(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const department = req.query.department;
    if (!department) return res.status(422).json({ error: "Name a department." });

    const day = await biz.businessDay();
    const p = periodOf(day, req.query.days ? Number(req.query.days) : 30);
    const { rows } = await pool.query(
      `SELECT c.*, r.reference, g.name AS guest_name
       FROM charges c
       JOIN reservations r ON r.id = c.reservation_id
       LEFT JOIN guests g ON g.id = r.guest_id
       WHERE r.property_id = $1 AND c.department = $2 AND c.charge_date >= $3 AND c.charge_date <= $4
         AND c.voided = false
       ORDER BY c.charge_date DESC`,
      [scope.propertyId, department, p.from, p.to]
    );
    res.json(rows.map((c) => ({
      date: biz.dstr(c.charge_date), description: c.description, amount: Number(c.amount),
      postedBy: c.posted_by || "—", reference: c.reference, guest: c.guest_name || "Guest",
      reservationId: c.reservation_id,
    })));
  } catch (err) { next(err); }
});

module.exports = router;
