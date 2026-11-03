/**
 * The money rules, ported from the browser core in assets/data.js and
 * assets/store.js so the API and the SPA cannot compute an invoice two ways.
 * Nothing here touches the database.
 */

const FINANCE_DEFAULTS = {
  invoicePrefix: "AGM", paymentDays: 7, approvalAmount: 500000, discountPct: 10, rateMaxAgeDays: 3,
};

// The bounds a property may set for itself. A prefix is the one rule with no
// numeric range, so it is checked by shape instead.
const FINANCE_LIMITS = {
  invoicePrefix: null, paymentDays: [0, 90], approvalAmount: [0, 100000000], discountPct: [0, 100],
  rateMaxAgeDays: [1, 30],
};
const FINANCE_LABELS = {
  invoicePrefix: "Invoice prefix", paymentDays: "Days to pay",
  approvalAmount: "Approval limit", discountPct: "Discount ceiling",
  rateMaxAgeDays: "Rate freshness",
};

/** Saved settings win only where a value was actually left behind. */
function resolveFinanceSettings(saved) {
  const out = {};
  for (const key of Object.keys(FINANCE_DEFAULTS)) {
    const v = (saved || {})[key];
    out[key] = v === null || v === undefined || v === "" ? FINANCE_DEFAULTS[key] : v;
  }
  return out;
}

function sanitizePrefix(v) {
  return String(v === undefined || v === null ? "" : v).toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Validate a proposed change against the current settings and return the new
 * whole plus the sentences describing each move. The description is what goes
 * into the audit trail, so the log cannot claim a change that was dropped.
 */
function planFinanceSettings(patch, before) {
  const out = { ...before };
  const changed = [];

  if (patch.invoicePrefix !== undefined) {
    const prefix = sanitizePrefix(patch.invoicePrefix);
    if (!prefix) return { error: "An invoice prefix needs at least one letter or figure." };
    if (prefix.length > 6) return { error: "Keep the invoice prefix to six characters or fewer." };
    if (prefix !== before.invoicePrefix) {
      out.invoicePrefix = prefix;
      changed.push("prefix " + before.invoicePrefix + " to " + prefix);
    }
  }

  for (const key of Object.keys(FINANCE_LIMITS).filter((k) => FINANCE_LIMITS[k])) {
    const bound = FINANCE_LIMITS[key];
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    const v = Math.round(Number(raw));
    if (!isFinite(v) || v < bound[0] || v > bound[1]) {
      return { error: `${FINANCE_LABELS[key]} has to be between ${bound[0]} and ${bound[1]}.` };
    }
    if (v === before[key]) continue;
    out[key] = v;
    changed.push(`${FINANCE_LABELS[key].toLowerCase()} ${before[key]} to ${v}`);
  }

  if (!changed.length) return { error: "Nothing in these settings has changed." };
  return { settings: out, changed };
}

function invoiceNumber(seq, prefix) {
  let n = String(seq);
  while (n.length < 4) n = "0" + n;
  return `${prefix || "INV"}-INV-${n}`;
}

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/**
 * What a money record contributes to a total: the base figure it carried when it
 * moved, or its own amount when it was already written in the money the books
 * are kept in. Every aggregate that adds foreign money reads through this.
 */
function baseOf(rec) {
  if (!rec) return 0;
  const v = rec.baseAmount === undefined || rec.baseAmount === null || rec.baseAmount === ""
    ? rec.amount : rec.baseAmount;
  return Number(v) || 0;
}

/**
 * The same rule read off a row as it comes back from Postgres, where the column
 * is named `base_amount`. Anything that aggregates money straight from a query
 * goes through this, so a foreign row never sneaks its face figure into a total.
 */
function rowBase(row) {
  if (!row) return 0;
  return baseOf({ amount: row.amount, baseAmount: row.base_amount });
}

/**
 * What an invoice is worth is counted from the money records, not from a total
 * someone typed — so a document is never "Paid" before the payment exists.
 * `reversed` rows are excluded because the money they represent came back.
 * The face figures are the currency the guest holds; the `base` block is what
 * the property keeps, and only base figures may ever be added across documents.
 */
function invoiceTotals(inv, payments, refunds) {
  const lines = (inv.lines || []).reduce((s, l) => s + num(l.amount), 0);
  const adjustments = (inv.adjustments || []).reduce((s, a) => s + num(a.amount), 0);
  const total = Math.round(lines + adjustments);
  const paid = (payments || []).reduce((s, p) => s + (p.reversed ? 0 : num(p.amount)), 0);
  const refunded = (refunds || []).reduce((s, r) => s + (r.reversed ? 0 : num(r.amount)), 0);
  const settled = paid - refunded;
  const baseLines = (inv.lines || []).reduce((s, l) => s + baseOf(l), 0);
  const baseAdj = (inv.adjustments || []).reduce((s, a) => s + baseOf(a), 0);
  const basePaid = (payments || []).reduce((s, p) => s + (p.reversed ? 0 : baseOf(p)), 0);
  const baseRefunded = (refunds || []).reduce((s, r) => s + (r.reversed ? 0 : baseOf(r)), 0);
  return {
    lines, adjustments, total, paid, refunded, settled,
    balance: Math.round(total - settled),
    base: {
      lines: baseLines, adjustments: baseAdj, total: Math.round(baseLines + baseAdj),
      paid: basePaid, refunded: baseRefunded, settled: basePaid - baseRefunded,
      balance: Math.round(baseLines + baseAdj - basePaid + baseRefunded),
    },
    status: inv.status === "Void" ? "Void"
      : total > 0 && settled >= total ? "Paid"
      : settled > 0 ? "Partially paid" : "Unpaid",
  };
}

/**
 * Charges copied onto a document are not billable twice, and a void document
 * hands its lines back to the folio.
 */
function unbilledCharges(charges) {
  return charges.filter((c) => !c.voided && !c.invoiceId);
}

/** Snapshot a set of folio charges into invoice lines. */
function linesFromCharges(charges) {
  return charges.map((c) => ({
    chargeId: c.id, date: c.date, description: c.description, department: c.department,
    qty: num(c.qty) || 1, unitPrice: c.unitPrice === null || c.unitPrice === undefined ? c.amount : c.unitPrice,
    amount: num(c.amount), priceId: c.priceId || null, listId: c.listId || null,
    listName: c.listName || null, currency: c.currency || "NGN",
  }));
}

module.exports = {
  FINANCE_DEFAULTS, FINANCE_LIMITS, FINANCE_LABELS,
  resolveFinanceSettings, sanitizePrefix, planFinanceSettings,
  invoiceNumber, invoiceTotals, unbilledCharges, linesFromCharges, baseOf, rowBase,
};
