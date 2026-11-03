/**
 * Billing — invoices, invoice payments, refunds, discounts, splits and voids.
 *
 * Three rules the whole module is built on, ported from the SPA so the two
 * cannot disagree about a figure:
 *   • an invoice is worth what its money records say, never a typed total;
 *   • a sealed business day takes no money;
 *   • a change bigger than the property's limit needs a second signature.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const FX = require("../lib/fx");
const ledger = require("../lib/ledger");
const INV = require("../lib/invoices");
const { jsonOut, uid } = require("../lib/json");
const biz = require("../lib/business-date");
const { log } = require("../lib/log");

const router = Router();
router.use(authenticate);

// A document is worth its money records, so every door that answers with one
// folds them through the ledger's one read.
const { invoiceWithMoney } = ledger;

// The estate is a manager's view, and so is crossing a money limit without a
// second signature. A role that holds the signing right is that second hand —
// exempting it too would put both signatures in one book.
const isManager = (req) => req.user.role === "Manager";
const sameProperty = (req, propertyId) => isManager(req) || req.user.propertyId === propertyId;

/** A manager sees the estate; everyone else sees their own property. */
function scopeFilter(req, propertyId, params) {
  if (propertyId) { params.push(propertyId); return ` AND property_id = $${params.length}`; }
  if (isManager(req)) return "";
  params.push(req.user.propertyId);
  return ` AND property_id = $${params.length}`;
}

/**
 * The property a read was asked for, or a refusal. Naming another property in
 * the query is not a filter a desk can pull — in the SPA the session decides
 * which money is on screen, so the API has to check the same boundary.
 */
function readScope(req) {
  const pid = req.query.propertyId;
  if (pid && !sameProperty(req, pid)) {
    return { error: "Access to this property is not permitted." };
  }
  return { propertyId: pid };
}

/* ── reading ─────────────────────────────────────────────────── */

router.get("/invoices", async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const params = [];
    let sql = `SELECT * FROM invoices WHERE 1=1`;
    const where = scopeFilter(req, scope.propertyId, params);
    sql += where;
    if (req.query.status) { params.push(req.query.status); sql += ` AND status = $${params.length}`; }
    if (req.query.kind) { params.push(req.query.kind); sql += ` AND kind = $${params.length}`; }
    if (req.query.reservationId) {
      params.push(req.query.reservationId);
      sql += ` AND reservation_id = $${params.length}`;
    }
    sql += " ORDER BY invoice_date DESC, number DESC";
    const { rows } = await pool.query(sql, params);
    const withMoney = await Promise.all(rows.map((r) => invoiceWithMoney(ledger.mapInvoice(r))));
    res.json(withMoney);
  } catch (err) { next(err); }
});

router.get("/invoices/:id", async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    res.json(await invoiceWithMoney(doc.inv));
  } catch (err) { next(err); }
});

router.get("/payments", async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const params = [];
    // Cash the property has taken, whether it landed on a folio or against a
    // document — the receipts page has to show both or the till never balances.
    let sql = `SELECT p.* FROM payments p
               LEFT JOIN invoices i ON i.id = p.invoice_id
               LEFT JOIN reservations r ON r.id = p.reservation_id
               WHERE 1=1`;
    const pid = scope.propertyId || (isManager(req) ? null : req.user.propertyId);
    if (pid) {
      params.push(pid);
      const n = params.length;
      sql += ` AND (i.property_id = $${n} OR r.property_id = $${n})`;
    }
    sql += " ORDER BY p.payment_date DESC, p.id DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(ledger.mapPayment));
  } catch (err) { next(err); }
});

router.get("/refunds", async (req, res, next) => {
  try {
    const scope = readScope(req);
    if (scope.error) return res.status(403).json({ error: scope.error });
    const params = [];
    let sql = `SELECT rf.* FROM refunds rf JOIN invoices i ON i.id = rf.invoice_id WHERE 1=1`;
    const pid = scope.propertyId || (isManager(req) ? null : req.user.propertyId);
    if (pid) { params.push(pid); sql += ` AND i.property_id = $${params.length}`; }
    sql += " ORDER BY rf.refund_date DESC";
    const { rows } = await pool.query(sql, params);
    res.json(rows.map(ledger.mapRefund));
  } catch (err) { next(err); }
});

/* ── raising a document ──────────────────────────────────────── */

const LineSchema = z.object({
  description: z.string().min(1),
  amount: z.number().positive("Enter an amount greater than zero."),
  qty: z.number().int().positive().default(1),
  department: z.string().default("Other"),
  currency: z.string().length(3).optional(),
});

const RaiseSchema = z.object({
  reservationId: z.string().optional(),
  eventId: z.string().optional(),
  propertyId: z.string().optional(),
  dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  notes: z.string().max(500).optional(),
  lines: z.array(LineSchema).optional(),
}).refine((d) => !d.lines || d.lines.length, { message: "A manual document needs at least one line." });

/**
 * The counter's raise. Everything that decides what the document is worth lives
 * in lib/invoices, because the seed that opens a trading day and the events desk
 * billing a hall both go through that one door — a route with its own copy of the
 * rules is a register whose figures depend on who clicked.
 */
router.post("/invoices", can("manage_billing"), validate(RaiseSchema), async (req, res, next) => {
  try {
    const d = req.data;
    const out = await INV.raise({
      propertyId: d.propertyId || req.user.propertyId,
      reservationId: d.reservationId, eventId: d.eventId,
      lines: d.lines, dueDate: d.dueDate, notes: d.notes,
      actor: req.user.name, sees: (pid) => sameProperty(req, pid),
    });
    if (out.error) return res.status(out.status || 422).json({ error: out.error });
    res.status(201).json(out.invoice);
  } catch (err) { next(err); }
});

/* ── money moving against a document ─────────────────────────── */

const PaySchema = z.object({
  amount: z.number().positive("Enter an amount greater than zero."),
  method: z.string().min(1).default("Card"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reconciled: z.boolean().optional(),
});

router.post("/invoices/:id/payments", can("manage_billing"), validate(PaySchema), async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (doc.inv.status === "Void") return res.status(422).json({ error: "A void invoice cannot take payment." });

    const amount = Math.round(req.data.amount);
    if (amount > doc.totals.balance) {
      return res.status(422).json({ error: `Only ${doc.totals.balance} is outstanding on this invoice.` });
    }
    const day = await biz.businessDay();
    const date = req.data.date || day;
    const sealed = await biz.sealedRefusal(date);
    if (sealed) return res.status(409).json({ error: sealed });

    const p = {
      id: uid("pay"), reservationId: doc.inv.reservationId, invoiceId: doc.inv.id,
      date, method: req.data.method, amount,
      reference: "TX" + Math.floor(100000 + Math.random() * 899999),
      receipt: `${doc.inv.number}-${doc.payments.length + 1}`,
      takenBy: req.user.name, reconciled: !!req.data.reconciled,
    };
    // Cash against a dollar invoice is dollars, valued at the invoice's own rate.
    Object.assign(p, FX.docStamp(doc.inv, amount));
    await pool.query(
      `INSERT INTO payments
       (id,reservation_id,invoice_id,payment_date,method,amount,currency,fx_rate,base_amount,
        reference,receipt,reconciled,taken_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [p.id, p.reservationId, p.invoiceId, p.date, p.method, p.amount, p.currency, p.fxRate, p.baseAmount,
        p.reference, p.receipt, p.reconciled, p.takenBy]
    );
    const totals = await ledger.settle(doc.inv);
    await log({
      propertyId: doc.inv.propertyId, actor: req.user.name, action: "recorded an invoice payment",
      entity: "invoice", detail: `${doc.inv.number} · ${amount} ${doc.inv.currency} · ${p.method} · receipt ${p.reference}`,
    });
    res.status(201).json({ payment: p, totals, invoice: await invoiceWithMoney(doc.inv) });
  } catch (err) { next(err); }
});

const RefundSchema = z.object({
  amount: z.number().positive("Enter an amount greater than zero."),
  reason: z.string().min(1, "A refund needs a reason for the audit trail."),
  method: z.string().default("Bank transfer"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

router.post("/invoices/:id/refunds", can("manage_billing"), validate(RefundSchema), async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    const amount = Math.round(req.data.amount);
    if (amount > doc.totals.settled) {
      return res.status(422).json({ error: `Only ${doc.totals.settled} has actually been received against this invoice.` });
    }
    const settings = await ledger.financeSettings(doc.inv.propertyId);
    // The limit is a base-currency figure, so a dollar refund is judged on what
    // it hands back in the property's own money.
    const move = FX.docBase(doc.inv, amount);
    if (move > settings.approvalAmount && !isManager(req)) {
      const queued = await ledger.queueApproval({
        propertyId: doc.inv.propertyId, kind: "refund",
        // The limit is judged in the books' money; the figure handed back is the
        // invoice's own, so the heading names the money the guest holds.
        subject: `${doc.inv.number} · ${doc.inv.title} · ${doc.inv.currency}`, subjectId: doc.inv.id,
        change: { invoiceId: doc.inv.id, data: req.data },
        // The gap the signer weighs is the base figure the limit was tested on;
        // the money actually handed back is the invoice's own.
        amount: move, from: 0, to: amount, toCurrency: doc.inv.currency, reason: req.data.reason,
      }, req.user.name);
      await log({
        propertyId: doc.inv.propertyId, actor: req.user.name, action: "asked for approval of a refund",
        entity: "approval", detail: `${queued.subject} · ${amount} ${doc.inv.currency} · ${req.data.reason} · awaiting a second signature`,
      });
      return res.status(202).json({ ok: true, queued });
    }

    const day = await biz.businessDay();
    const sealed = await biz.sealedRefusal(req.data.date || day);
    if (sealed) return res.status(409).json({ error: sealed });

    const applied = await ledger.applyRefund(doc.inv, req.data, req.user.name, day);
    await log({
      propertyId: doc.inv.propertyId, actor: req.user.name, action: "issued a refund",
      entity: "invoice", detail: `${doc.inv.number} · ${amount} ${doc.inv.currency} · ${req.data.reason}`,
    });
    res.status(201).json({ ...applied, invoice: await invoiceWithMoney(doc.inv) });
  } catch (err) { next(err); }
});

const DiscountSchema = z.object({
  amount: z.number().positive("Enter an amount greater than zero."),
  reason: z.string().min(1, "An adjustment needs a reason for the audit trail."),
  label: z.string().optional(),
});

// Discounts are judged as a share of the invoice, not as a figure: ₦200,000 off
// a two-night folio is a different act from ₦200,000 off a conference bill.
router.post("/invoices/:id/discounts", can("manage_billing"), validate(DiscountSchema), async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (doc.inv.status === "Void") return res.status(422).json({ error: "A void invoice cannot be adjusted." });

    const amount = Math.round(req.data.amount);
    if (amount > doc.totals.total) {
      return res.status(422).json({ error: "An adjustment cannot exceed the invoiced total." });
    }
    const settings = await ledger.financeSettings(doc.inv.propertyId);
    if ((amount / doc.totals.total) * 100 > settings.discountPct && !isManager(req)) {
      const queued = await ledger.queueApproval({
        propertyId: doc.inv.propertyId, kind: "discount",
        subject: `${doc.inv.number} · ${doc.inv.title}`, subjectId: doc.inv.id,
        change: { invoiceId: doc.inv.id, data: req.data },
        // A discount is gated on its share of the document, so its figure stays
        // in the money the document is billed in.
        amount, currency: doc.inv.currency, from: 0, to: amount, reason: req.data.reason,
      }, req.user.name);
      await log({
        propertyId: doc.inv.propertyId, actor: req.user.name, action: "asked for approval of a discount",
        entity: "approval",
        detail: `${queued.subject} · ${amount} ${doc.inv.currency} · ${req.data.reason} · awaiting a second signature`,
      });
      return res.status(202).json({ ok: true, queued });
    }

    const applied = await ledger.applyDiscount(doc.inv, req.data, req.user.name);
    await log({
      propertyId: doc.inv.propertyId, actor: req.user.name, action: "adjusted an invoice",
      entity: "invoice", detail: `${doc.inv.number} · ${-amount} · ${req.data.reason}`,
    });
    res.status(201).json({ ...applied, invoice: await invoiceWithMoney(doc.inv) });
  } catch (err) { next(err); }
});

/* ── splitting and voiding ───────────────────────────────────── */

const SplitSchema = z.object({
  indexes: z.array(z.number().int().min(0)).default([]),
  chargeIds: z.array(z.string()).default([]),
  notes: z.string().max(500).optional(),
});

router.post("/invoices/:id/split", can("manage_billing"), validate(SplitSchema), async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (doc.inv.status === "Void") return res.status(422).json({ error: "A void invoice cannot be split." });
    if (doc.totals.settled) {
      return res.status(422).json({ error: `Refund the ${doc.totals.settled} received before splitting — money cannot follow a line yet.` });
    }

    const keys = {};
    req.data.indexes.forEach((i) => { keys[i] = true; });
    req.data.chargeIds.forEach((c) => { keys[c] = true; });
    const moved = [], kept = [];
    doc.inv.lines.forEach((l, i) => (keys[i] || keys[l.chargeId] ? moved : kept).push(l));
    if (!moved.length || !kept.length) return res.status(422).json({ error: "A split needs lines on both sides." });

    const settings = await ledger.financeSettings(doc.inv.propertyId);
    // Both halves of a split are the same money at the same rate: the line that
    // moves takes its base figure with it, or the two documents would not add up
    // back to the one they came from.
    const second = {
      ...doc.inv,
      id: uid("inv"), number: await ledger.nextInvoiceNumber(doc.inv.propertyId, settings),
      lines: moved, adjustments: [], status: "Unpaid",
      raisedBy: req.user.name, raisedAt: new Date().toISOString(),
      notes: req.data.notes || "Split from " + doc.inv.number,
    };
    await pool.query(
      `INSERT INTO invoices
       (id,number,property_id,kind,entity_id,reservation_id,guest_id,title,invoice_date,due_date,
        currency,fx_rate,lines,adjustments,status,raised_by,raised_at,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
      [second.id, second.number, second.propertyId, second.kind, second.entityId, second.reservationId,
        second.guestId, second.title, second.date, second.dueDate, second.currency, second.fxRate,
        jsonOut(second.lines), jsonOut(second.adjustments), second.status, second.raisedBy, second.raisedAt, second.notes]
    );
    await pool.query(`UPDATE invoices SET lines = $2 WHERE id = $1`, [doc.inv.id, jsonOut(kept)]);
    doc.inv.lines = kept;
    for (const l of moved) {
      if (l.chargeId) await pool.query(`UPDATE charges SET invoice_id = $2 WHERE id = $1`, [l.chargeId, second.id]);
    }
    await ledger.settle(doc.inv);
    const both = await Promise.all([invoiceWithMoney(doc.inv), invoiceWithMoney(second)]);
    await log({
      propertyId: doc.inv.propertyId, actor: req.user.name, action: "split an invoice",
      entity: "invoice", detail: `${doc.inv.number} → ${second.number} · ${moved.length} lines`,
    });
    res.status(201).json({ original: both[0], split: both[1] });
  } catch (err) { next(err); }
});

const VoidSchema = z.object({ reason: z.string().min(1, "A void needs a reason for the audit trail.") });

router.post("/invoices/:id/void", can("manage_billing"), validate(VoidSchema), async (req, res, next) => {
  try {
    const doc = await ledger.loadInvoice(req.params.id);
    if (!doc) return res.status(404).json({ error: "Invoice not found." });
    if (!sameProperty(req, doc.inv.propertyId)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (doc.inv.status === "Void") return res.status(422).json({ error: "This invoice is already void." });
    if (doc.totals.settled) {
      return res.status(422).json({ error: `Refund ${doc.totals.settled} first — money on file cannot be hidden by a void.` });
    }

    // The charges go back on the shelf so the desk can raise a corrected
    // document; the voided invoice and its history stay untouched.
    const carriedIds = await ledger.chargeIdsOnInvoice(doc.inv.id);
    for (const cid of carriedIds) {
      await pool.query(`UPDATE charges SET invoice_id = NULL WHERE id = $1`, [cid]);
    }
    await pool.query(
      `UPDATE invoices SET status='Void', voided_by=$2, voided_at=$3, void_reason=$4 WHERE id=$1`,
      [doc.inv.id, req.user.name, new Date().toISOString(), req.data.reason]
    );
    doc.inv.status = "Void";
    await log({
      propertyId: doc.inv.propertyId, actor: req.user.name, action: "voided an invoice",
      entity: "invoice", detail: `${doc.inv.number} · ${doc.totals.total} · ${req.data.reason}`,
    });
    res.json({ invoice: await invoiceWithMoney(doc.inv) });
  } catch (err) { next(err); }
});

/* ── reconciliation ──────────────────────────────────────────── */

const ReconcileSchema = z.object({ reconciled: z.boolean() });

router.patch("/payments/:id/reconcile", can("take_payments"), validate(ReconcileSchema), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM payments WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: "Payment not found." });
    await pool.query(`UPDATE payments SET reconciled = $2 WHERE id = $1`, [req.params.id, req.data.reconciled]);
    const p = ledger.mapPayment((await pool.query(`SELECT * FROM payments WHERE id = $1`, [req.params.id])).rows[0]);
    await log({
      propertyId: req.user.propertyId, actor: req.user.name,
      action: req.data.reconciled ? "reconciled a payment" : "unmatched a payment",
      entity: "folio", detail: `${p.amount} · ${p.receipt || p.reference} · ${p.method}`,
    });
    res.json(p);
  } catch (err) { next(err); }
});

module.exports = router;
