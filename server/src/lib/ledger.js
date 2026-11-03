/**
 * Invoice reads and writes the billing routes and the approval queue share.
 *
 * A gated change and an immediate one run through the same function here, so
 * an approved refund leaves the same history entry as one the desk applied
 * without asking.
 */
const pool = require("../db/pool");
const { invoiceTotals, resolveFinanceSettings, invoiceNumber } = require("./finance");
const { dstr } = require("./business-date");
const { jsonIn, jsonOut, uid } = require("./json");
const FX = require("./fx");

function mapInvoice(row) {
  if (!row) return null;
  return {
    id: row.id, number: row.number, propertyId: row.property_id, kind: row.kind,
    entityId: row.entity_id, reservationId: row.reservation_id, guestId: row.guest_id,
    title: row.title, date: dstr(row.invoice_date), dueDate: dstr(row.due_date),
    currency: row.currency, fxRate: row.fx_rate === null ? null : Number(row.fx_rate),
    lines: jsonIn(row.lines, []), adjustments: jsonIn(row.adjustments, []),
    status: row.status, raisedBy: row.raised_by, raisedAt: row.raised_at,
    voidedBy: row.voided_by, voidedAt: row.voided_at, voidReason: row.void_reason,
    notes: row.notes,
  };
}

function mapPayment(row) {
  return {
    id: row.id, reservationId: row.reservation_id, invoiceId: row.invoice_id,
    date: dstr(row.payment_date), method: row.method, amount: Number(row.amount),
    currency: row.currency,
    fxRate: row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate),
    baseAmount: row.base_amount === null || row.base_amount === undefined ? null : Number(row.base_amount),
    reference: row.reference, receipt: row.receipt, reconciled: !!row.reconciled,
    takenBy: row.taken_by,
  };
}

function mapRefund(row) {
  return {
    id: row.id, invoiceId: row.invoice_id, reservationId: row.reservation_id,
    amount: Number(row.amount),
    currency: row.currency,
    fxRate: row.fx_rate === null || row.fx_rate === undefined ? null : Number(row.fx_rate),
    baseAmount: row.base_amount === null || row.base_amount === undefined ? null : Number(row.base_amount),
    date: dstr(row.refund_date), method: row.method,
    reason: row.reason, reference: row.reference, by: row.issued_by, at: row.created_at,
  };
}

async function paymentsFor(invoiceId, client) {
  const { rows } = await (client || pool).query(`SELECT * FROM payments WHERE invoice_id = $1`, [invoiceId]);
  return rows.map(mapPayment);
}

async function refundsFor(invoiceId, client) {
  const { rows } = await (client || pool).query(`SELECT * FROM refunds WHERE invoice_id = $1`, [invoiceId]);
  return rows.map(mapRefund);
}

/**
 * A document as the register shows it: the lines it carries, the money that has
 * landed against it and what it is worth, all folded by the same rule. Every door
 * that answers with an invoice reads it through here, so a list and a detail view
 * cannot quote two balances for one document.
 */
async function invoiceWithMoney(inv, client) {
  const [payments, refunds] = await Promise.all([
    paymentsFor(inv.id, client), refundsFor(inv.id, client),
  ]);
  const totals = invoiceTotals(inv, payments, refunds);
  return { ...inv, totals, payments, refunds };
}

/** An invoice is worth what its money records say, so totals are never stored. */
async function loadInvoice(id) {
  const { rows } = await pool.query(`SELECT * FROM invoices WHERE id = $1`, [id]);
  const inv = mapInvoice(rows[0]);
  if (!inv) return null;
  const [payments, refunds] = await Promise.all([paymentsFor(id), refundsFor(id)]);
  return { inv, payments, refunds, totals: invoiceTotals(inv, payments, refunds) };
}

async function writeStatus(inv, status, client) {
  await (client || pool).query(`UPDATE invoices SET status = $2 WHERE id = $1`, [inv.id, status]);
  inv.status = status;
  return status;
}

/**
 * The status a document has earned from the money against it. A caller inside a
 * transaction settles on its own connection, so a document it is still writing
 * reads the payments it has just attributed to it.
 */
async function settle(inv, client) {
  const [payments, refunds] = await Promise.all([paymentsFor(inv.id, client), refundsFor(inv.id, client)]);
  const t = invoiceTotals(inv, payments, refunds);
  await writeStatus(inv, t.status, client);
  return t;
}

/** Hand money back without deleting the payment it reverses — both sides stay auditable. */
async function applyRefund(inv, data, actor, today) {
  const amount = Math.round(Number(data.amount));
  const date = data.date || today;
  // The refund leaves at the rate the document was raised at, so handing back
  // dollars on a dollar invoice returns what the guest paid, not today's figure.
  const stamp = FX.docStamp(inv, amount);
  const r = {
    id: uid("rfd"), invoiceId: inv.id, reservationId: inv.reservationId, amount,
    currency: stamp.currency || inv.currency, fxRate: stamp.fxRate, baseAmount: stamp.baseAmount,
    date, method: data.method || "Bank transfer", reason: data.reason,
    reference: "RF" + Math.floor(100000 + Math.random() * 899999),
    by: actor, at: new Date().toISOString(),
  };
  await pool.query(
    `INSERT INTO refunds (id,invoice_id,reservation_id,amount,currency,fx_rate,base_amount,
       refund_date,method,reason,reference,issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [r.id, r.invoiceId, r.reservationId, r.amount, r.currency, r.fxRate, r.baseAmount,
      r.date, r.method, r.reason, r.reference, r.by]
  );
  const totals = await settle(inv);
  return { refund: r, totals };
}

/** A discount is a negative adjustment line, not a rewritten price. */
async function applyDiscount(inv, data, actor) {
  const amount = Math.round(Number(data.amount));
  const adj = {
    id: uid("adj"), label: data.label || "Approved adjustment", amount: -amount,
    reason: data.reason, by: actor, at: new Date().toISOString(),
  };
  // A negative line still needs its base figure, or the reduction would be
  // missing from every total the books keep.
  const f = FX.docStamp(inv, -amount);
  if (f.baseAmount !== null && f.baseAmount !== undefined) adj.baseAmount = -Math.abs(f.baseAmount);
  const adjustments = inv.adjustments.concat([adj]);
  await pool.query(`UPDATE invoices SET adjustments = $2 WHERE id = $1`, [inv.id, jsonOut(adjustments)]);
  inv.adjustments = adjustments;
  const totals = await settle(inv);
  return { adjustment: adj, totals };
}

/** One number for the whole group, taken before the prefix is applied. */
async function nextInvoiceNumber(propertyId, settings, client) {
  const { rows } = await (client || pool).query(
    `UPDATE invoice_series SET seq = seq + 1 WHERE id = 1 RETURNING seq`
  );
  const seq = rows[0] ? Number(rows[0].seq) : null;
  if (seq === null) throw new Error("The invoice numbering series is missing — run the migration.");
  return invoiceNumber(seq, settings.invoicePrefix);
}

async function chargeIdsOnInvoice(invoiceId) {
  const { rows } = await pool.query(`SELECT id FROM charges WHERE invoice_id = $1`, [invoiceId]);
  return rows.map((r) => r.id);
}

/** The per-property rules a document is numbered and gated by. */
async function financeSettings(propertyId, client) {
  const { rows } = await (client || pool).query(
    `SELECT data FROM settings WHERE property_id = $1`, [propertyId]
  );
  const blob = jsonIn(rows[0] && rows[0].data, {});
  return resolveFinanceSettings(blob.finance || {});
}

/**
 * A request the desk cannot sign alone. `change` holds exactly the payload the
 * immediate action would have run, so approving applies the same code path.
 */
async function queueApproval(rec, actor) {
  // A request that does not say what money its figures are in is a request that
  // will be read in the books' own — which is exactly the guess that turns a
  // dollar discount into naira in front of the person signing it.
  const base = (await FX.read({ propertyId: rec.propertyId })).base;
  const a = {
    id: uid("apr"), propertyId: rec.propertyId, kind: rec.kind, subject: rec.subject,
    subjectId: rec.subjectId || null, change: rec.change, amount: rec.amount,
    currency: rec.currency || base,
    from: rec.from, fromCurrency: rec.fromCurrency || null,
    to: rec.to, toCurrency: rec.toCurrency || null,
    reason: rec.reason, requestedBy: actor,
    requestedAt: new Date().toISOString(), status: "Pending",
  };
  await pool.query(
    `INSERT INTO approvals
     (id,property_id,kind,subject,subject_id,change,amount,currency,from_value,from_currency,
      to_value,to_currency,reason,requested_by,requested_at,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'Pending')`,
    [a.id, a.propertyId, a.kind, a.subject, a.subjectId, jsonOut(a.change), a.amount, a.currency,
      a.from, a.fromCurrency, a.to, a.toCurrency, a.reason, a.requestedBy, a.requestedAt]
  );
  return a;
}

function mapApproval(row) {
  return {
    id: row.id, propertyId: row.property_id, kind: row.kind, subject: row.subject,
    subjectId: row.subject_id, change: jsonIn(row.change, null), amount: Number(row.amount),
    currency: row.currency,
    from: row.from_value === null ? null : Number(row.from_value),
    fromCurrency: row.from_currency,
    to: row.to_value === null ? null : Number(row.to_value),
    toCurrency: row.to_currency,
    reason: row.reason, requestedBy: row.requested_by, requestedAt: row.requested_at,
    status: row.status, decidedBy: row.decided_by, decidedAt: row.decided_at,
    decisionNote: row.decision_note,
  };
}

/** Pending first, then newest decision — the queue opens on the work. */
function orderApprovals(rows) {
  return rows.map(mapApproval).sort((x, y) => {
    if (x.status === y.status) return x.requestedAt < y.requestedAt ? 1 : -1;
    return x.status === "Pending" ? -1 : 1;
  });
}

module.exports = {
  mapInvoice, mapPayment, mapRefund, mapApproval, orderApprovals,
  loadInvoice, paymentsFor, refundsFor, invoiceWithMoney, settle, applyRefund, applyDiscount,
  nextInvoiceNumber, chargeIdsOnInvoice, financeSettings, queueApproval,
};
