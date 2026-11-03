/**
 * The financial statement, built to the same rules the SPA reads (financeCore
 * in assets/data.js) so a dashboard on either side shows one set of figures:
 *
 *   • Revenue is EARNED, not collected: a non-void charge counts on the day it
 *     was posted, at the amount recorded then.
 *   • Tax and service charge are billed, not earned — reported as their own
 *     figure, never inside revenue.
 *   • Cash is what the till took in the window less what was handed back.
 *   • A debt is counted exactly once: a charge copied onto an invoice stays on
 *     the folio, so guest debt is measured at the folio and an invoice only adds
 *     its own balance when it belongs to a booking with no folio.
 *   • Only APPROVED expenses reach the result.
 */
const pool = require("../db/pool");
const { invoiceTotals, baseOf, rowBase } = require("./finance");
const { dstr, addDays } = require("./business-date");
const { jsonIn } = require("./json");

const TAX_DEPT = "Taxes & service";
const DEPT_BUCKETS = {
  "Rooms": "rooms", "Events & Banqueting": "events",
  "Food & Beverage": "restaurant", "Laundry": "laundry",
};

function periodOf(day, days) {
  const from = addDays(day, -(days - 1));
  return { from, to: day, days, prevFrom: addDays(from, -days), prevTo: addDays(from, -1) };
}

const inRange = (d, from, to) => d >= from && d <= to;
const sum = (list, pick) => list.reduce((s, x) => s + pick(x), 0);

async function statement(propertyId, from, to) {
  const [resR, chgR, payR, refR, invR, evtR, expR] = await Promise.all([
    pool.query(`SELECT id, status FROM reservations WHERE property_id = $1`, [propertyId]),
    pool.query(
      `SELECT c.* FROM charges c JOIN reservations r ON r.id = c.reservation_id
       WHERE r.property_id = $1 AND c.reservation_id IS NOT NULL`, [propertyId]),
    pool.query(
      `SELECT p.*, i.property_id AS inv_property, r.property_id AS res_property
       FROM payments p
       LEFT JOIN invoices i ON i.id = p.invoice_id
       LEFT JOIN reservations r ON r.id = p.reservation_id
       WHERE i.property_id = $1 OR r.property_id = $1`, [propertyId]),
    pool.query(
      `SELECT rf.*, i.property_id AS inv_property FROM refunds rf
       JOIN invoices i ON i.id = rf.invoice_id WHERE i.property_id = $1`, [propertyId]),
    pool.query(`SELECT * FROM invoices WHERE property_id = $1`, [propertyId]),
    pool.query(
      `SELECT e.* FROM events e WHERE e.property_id = $1 AND e.reservation_id IS NULL
        AND e.status NOT IN ('Cancelled','Released')`, [propertyId]),
    pool.query(`SELECT * FROM expenses WHERE property_id = $1`, [propertyId]),
  ]);

  const resIds = {};
  resR.rows.forEach((r) => { resIds[r.id] = r; });
  const invoices = invR.rows.map((row) => ({
    id: row.id, kind: row.kind, status: row.status,
    lines: jsonIn(row.lines, []), adjustments: jsonIn(row.adjustments, []),
  }));
  const invIds = {};
  invoices.forEach((i) => { invIds[i.id] = true; });

  // Departments and tax are read off every non-void charge in the window.
  // Every figure a period total adds is the base-currency one: a dollar charge
  // and a naira charge share a month, and only the second is addable.
  const windowCharges = [];
  for (const row of chgR.rows) {
    if (row.voided || !resIds[row.reservation_id]) continue;
    if (!inRange(dstr(row.charge_date), from, to)) continue;
    windowCharges.push({ department: row.department, amount: rowBase(row) });
  }

  const byDept = {};
  const buckets = { rooms: 0, events: 0, restaurant: 0, laundry: 0, other: 0 };
  let taxBilled = 0;
  windowCharges.forEach((c) => {
    if (c.department === TAX_DEPT) { taxBilled += c.amount; return; }
    byDept[c.department] = (byDept[c.department] || 0) + c.amount;
    buckets[DEPT_BUCKETS[c.department] || "other"] += c.amount;
  });

  // A booking the desk bills directly never touches a folio, so its lines are
  // the only place its revenue exists.
  const booked = [];
  for (const e of evtR.rows) {
    if (!inRange(dstr(e.event_date), from, to)) continue;
    const { rows: lines } = await pool.query(`SELECT amount, base_amount FROM event_lines WHERE event_id = $1`, [e.id]);
    booked.push({ id: e.id, revenue: sum(lines, rowBase) });
  }
  const eventRevenue = sum(booked, (b) => b.revenue);
  byDept["Events & Banqueting"] = (byDept["Events & Banqueting"] || 0) + eventRevenue;
  buckets.events += eventRevenue;

  const revenue = sum(windowCharges.filter((c) => c.department !== TAX_DEPT), (c) => c.amount) + eventRevenue;

  const payments = payR.rows
    .filter((p) => inRange(dstr(p.payment_date), from, to))
    .map((p) => ({ amount: rowBase(p), method: p.method || "Unspecified", reconciled: !!p.reconciled }));
  const collected = sum(payments, (p) => p.amount);
  const reconciled = sum(payments.filter((p) => p.reconciled), (p) => p.amount);
  const byMethod = {};
  payments.forEach((p) => { byMethod[p.method] = (byMethod[p.method] || 0) + p.amount; });

  const refunds = refR.rows
    .filter((r) => inRange(dstr(r.refund_date), from, to))
    .map((r) => rowBase(r));
  const refunded = sum(refunds, (x) => x);

  let discounts = 0, adjustments = 0;
  invoices.forEach((inv) => {
    inv.adjustments.forEach((a) => {
      if (!inRange(String(a.at || "").slice(0, 10), from, to)) return;
      const v = baseOf(a);
      if (v < 0) discounts += -v; else adjustments += v;
    });
  });

  // Guest debt is a live position, measured at the folio.
  const billedByRes = {}, paidByRes = {};
  for (const row of chgR.rows) {
    if (row.voided) continue;
    billedByRes[row.reservation_id] = (billedByRes[row.reservation_id] || 0) + rowBase(row);
  }
  for (const p of payR.rows) {
    if (!p.reservation_id) continue;
    paidByRes[p.reservation_id] = (paidByRes[p.reservation_id] || 0) + rowBase(p);
  }
  let guestOwed = 0, prepayments = 0;
  resR.rows.forEach((r) => {
    if (r.status === "Cancelled" || r.status === "No-show") return;
    const owed = Math.round((billedByRes[r.id] || 0) - (paidByRes[r.id] || 0));
    if (owed > 0) guestOwed += owed; else prepayments += -owed;
  });

  const payByInvoice = {}, refByInvoice = {};
  payR.rows.forEach((p) => {
    if (!p.invoice_id) return;
    (payByInvoice[p.invoice_id] = payByInvoice[p.invoice_id] || [])
      .push({ amount: Number(p.amount), baseAmount: p.base_amount });
  });
  refR.rows.forEach((r) => {
    (refByInvoice[r.invoice_id] = refByInvoice[r.invoice_id] || [])
      .push({ amount: Number(r.amount), baseAmount: r.base_amount });
  });

  let docOwed = 0, billed = 0, collectedOnDocs = 0;
  for (const row of invR.rows) {
    const inv = invoices.find((i) => i.id === row.id);
    const t = invoiceTotals(inv, payByInvoice[inv.id] || [], refByInvoice[inv.id] || []);
    if (inv.status === "Void") continue;
    billed += t.base.total;
    collectedOnDocs += t.base.settled;
    if (inv.kind !== "folio" && t.base.balance > 0) docOwed += t.base.balance;
  }

  const expenses = expR.rows
    .filter((e) => inRange(dstr(e.expense_date), from, to))
    .map((e) => ({ status: e.status, category: e.category, amount: rowBase(e) }));
  const approved = expenses.filter((e) => e.status === "Approved");
  const pending = expenses.filter((e) => e.status === "Pending");
  const expByCat = {};
  approved.forEach((e) => { expByCat[e.category] = (expByCat[e.category] || 0) + e.amount; });

  return {
    from, to,
    revenue: Math.round(revenue), byDept, buckets, taxBilled: Math.round(taxBilled),
    eventBookings: booked.length,
    collected: Math.round(collected), reconciled: Math.round(reconciled),
    unreconciled: Math.round(collected - reconciled), byMethod,
    paymentCount: payments.length, refunded: Math.round(refunded), refundCount: refunds.length,
    netCash: Math.round(collected - refunded),
    discounts: Math.round(discounts), adjustments: Math.round(adjustments),
    guestOwed: Math.round(guestOwed), docOwed: Math.round(docOwed),
    outstanding: Math.round(guestOwed + docOwed),
    prepayments: Math.round(prepayments), billed: Math.round(billed),
    collectedOnDocs: Math.round(collectedOnDocs),
    expenses: Math.round(sum(approved, (e) => e.amount)),
    expensesPending: Math.round(sum(pending, (e) => e.amount)),
    expenseCount: expenses.length, pendingCount: pending.length,
    rejectedCount: expenses.filter((e) => e.status === "Rejected").length,
    expByCat,
    net: Math.round(revenue - sum(approved, (e) => e.amount)),
  };
}

/** Percentage movement, stated the way the dashboard states it. */
function pctDelta(now, before) {
  if (!before) return now ? 100 : 0;
  return Math.round(((now - before) / Math.abs(before)) * 100);
}

module.exports = { statement, periodOf, pctDelta, TAX_DEPT };
