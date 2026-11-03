/**
 * Raising a document — the API port of LHMS.actions.raiseInvoice.
 *
 * One door writes an invoice, whoever asks for it: the counter's billing page,
 * the events desk billing a hall that never touched a folio, and the seed that
 * opens a trading day. A second implementation would be a second set of rules for
 * the register, and a document the install raised would then owe its figures to
 * different maths than one the desk raised an hour later.
 *
 * Like the folio and the booking, every read is made on the caller's connection
 * when it has one: the seed bills inside the transaction that created the stays,
 * and a pooled read would number a document off charges it cannot see yet.
 */
const pool = require("../db/pool");
const F = require("./finance");
const FX = require("./fx");
const biz = require("./business-date");
const ledger = require("./ledger");
const { jsonIn, jsonOut, uid } = require("./json");
const { log } = require("./log");

const HALL_DEPT = "Events & Banqueting";
const TAX_DEPT = "Taxes & service";

const num = (v) => (v === null || v === undefined || v === "" ? 0 : Number(v));

/** A charge row as the finance core reads one. */
function mapCharge(row) {
  return {
    id: row.id, reservationId: row.reservation_id, date: biz.dstr(row.charge_date),
    description: row.description, department: row.department, amount: Number(row.amount),
    qty: row.qty, postedBy: row.posted_by, voided: !!row.voided, invoiceId: row.invoice_id,
    unitPrice: row.unit_price === null ? null : Number(row.unit_price),
    basePrice: row.base_price === null ? null : Number(row.base_price),
    priceId: row.price_id, listId: row.list_id, listName: row.list_name,
    currency: row.currency, taxRuleId: row.tax_rule_id, nightAudit: !!row.night_audit,
  };
}

/** What the counter typed, in the shape a document holds. */
function manualLines(lines) {
  return (lines || []).map((l) => ({
    date: null, description: l.description, department: l.department || "Other",
    qty: l.qty, unitPrice: l.amount, amount: l.amount,
    currency: l.currency ? String(l.currency).toUpperCase() : null,
  }));
}

/**
 * The lines a hall booking is billed on: what it was quoted with, then the taxes
 * the quote carried. Copied, not referenced — a hall re-priced next month cannot
 * rewrite a document the client is already holding. The description is written the
 * way the confirm door wrote the same line onto a folio, so a booking that is on a
 * folio and a booking that is not read the same down the register.
 */
function eventLines(evt, taxLines) {
  return (evt.lines || []).map((l) => ({
    date: biz.dstr(evt.event_date),
    description: `${Number(l.qty) > 1 ? l.qty + " × " : ""}${l.name} — ${evt.title}`,
    department: HALL_DEPT, qty: Number(l.qty) || 1,
    unitPrice: num(l.unit_price), amount: num(l.amount),
    priceId: l.price_id, listId: l.list_id, listName: l.list_name,
    currency: l.currency || "NGN",
  })).concat(taxLines.map((t) => ({
    date: biz.dstr(evt.event_date), description: t.label, department: TAX_DEPT,
    qty: 1, unitPrice: num(t.amount), amount: num(t.amount), currency: evt.currency || "NGN",
  })));
}

/**
 * Raise a document.
 *
 * `o.actor` is whose name sits under it, and `o.sees` is the caller's own boundary
 * — the desk's "this property, or the estate" rule — asked of the property the
 * document ends up on, which for a folio or a booking is the one on the record, not
 * the one the caller named. `o.day` is the business day the document is dated; a
 * caller that has already read it hands it over instead of reading it twice.
 */
async function raise(o) {
  const db = o.client || pool;
  if (o.reservationId && o.eventId) {
    return { status: 422, error: "Name a folio or a booking, not both." };
  }
  if ((o.reservationId || o.eventId) && o.lines) {
    return { status: 422, error: "Name a folio or give the lines, not both." };
  }

  const day = o.day || await biz.businessDay(db);
  let propertyId = o.propertyId || null;
  let kind = "manual", entityId = null, reservationId = null, guestId = null;
  let title = o.notes || "Manual document";
  let lines = manualLines(o.lines);

  if (o.reservationId) {
    const { rows } = await db.query(`SELECT * FROM reservations WHERE id = $1`, [o.reservationId]);
    const stay = rows[0];
    if (!stay) return { status: 404, error: "Reservation not found." };
    propertyId = stay.property_id;
    kind = "folio";
    entityId = reservationId = stay.id;
    guestId = stay.guest_id;
    const who = guestId
      ? (await db.query(`SELECT name FROM guests WHERE id = $1`, [guestId])).rows[0] : null;
    title = `${who ? who.name : "Unnamed guest"} · ${stay.reference}`;
    const ch = await db.query(`SELECT * FROM charges WHERE reservation_id = $1`, [stay.id]);
    const unbilled = F.unbilledCharges(ch.rows.map(mapCharge));
    if (!unbilled.length) {
      return { status: 422, error: `Every charge on ${stay.reference} is already invoiced.` };
    }
    lines = F.linesFromCharges(unbilled);
  } else if (o.eventId) {
    const { rows } = await db.query(`SELECT * FROM events WHERE id = $1`, [o.eventId]);
    const evt = rows[0];
    if (!evt) return { status: 404, error: "Booking not found." };
    if (evt.reservation_id) {
      const { rows: on } = await db.query(`SELECT reference FROM reservations WHERE id = $1`, [evt.reservation_id]);
      return {
        status: 422,
        error: `That booking is billed on ${on[0] ? on[0].reference : evt.reservation_id} — invoice the folio instead.`,
      };
    }
    propertyId = evt.property_id;
    kind = "event";
    entityId = evt.id;
    title = evt.title;
    const { rows: el } = await db.query(
      `SELECT * FROM event_lines WHERE event_id = $1 ORDER BY sort_order, id`, [evt.id]
    );
    lines = eventLines({ ...evt, lines: el }, jsonIn(evt.tax_lines, []));
    if (!lines.length) return { status: 422, error: "The booking has no priced lines to invoice." };
  }

  if (o.sees && !o.sees(propertyId)) {
    return { status: 403, error: "Access to this property is not permitted." };
  }
  if (!lines.length) return { status: 422, error: "There is nothing to invoice." };

  const settings = await ledger.financeSettings(propertyId, db);
  const read = await FX.read({ propertyId, date: day, client: db });

  // One document, one money, and that money has to be one the books can value.
  const cur = FX.oneCurrency(read.base, lines);
  if (cur.error) return { status: 422, error: cur.error };
  const blocked = FX.gateIn(read, cur.code);
  if (blocked) return { status: 422, error: blocked.error };

  // A foreign document pins the rate it was raised at, and every line and
  // payment on it converts at that figure — not at tomorrow's fixing.
  const rate = cur.code === read.base ? null : FX.state(read.rates, cur.code, read).rate;
  if (rate) lines.forEach((l) => Object.assign(l, FX.pinned(l.amount, cur.code, rate)));

  const inv = {
    id: uid("inv"),
    number: await ledger.nextInvoiceNumber(propertyId, settings, db),
    propertyId, kind, entityId, reservationId, guestId,
    title,
    date: day,
    dueDate: o.dueDate || biz.addDays(day, settings.paymentDays),
    currency: cur.code, fxRate: rate,
    lines, adjustments: [], status: "Unpaid",
    raisedBy: o.actor || "System", notes: o.notes || "",
  };

  await db.query(
    `INSERT INTO invoices
     (id,number,property_id,kind,entity_id,reservation_id,guest_id,title,invoice_date,due_date,
      currency,fx_rate,lines,adjustments,status,raised_by,raised_at,notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [inv.id, inv.number, inv.propertyId, inv.kind, inv.entityId, inv.reservationId, inv.guestId,
      inv.title, inv.date, inv.dueDate, inv.currency, inv.fxRate, jsonOut(inv.lines),
      jsonOut(inv.adjustments), inv.status, inv.raisedBy, new Date().toISOString(), inv.notes]
  );

  // A copied charge keeps its invoice id so the same night cannot be billed twice.
  for (const l of lines) {
    if (!l.chargeId) continue;
    await db.query(`UPDATE charges SET invoice_id = $2 WHERE id = $1`, [l.chargeId, inv.id]);
  }

  const full = await ledger.invoiceWithMoney(inv, db);
  await log({
    propertyId: inv.propertyId, actor: inv.raisedBy, action: "raised an invoice",
    entity: "invoice", detail: `${inv.number} · ${full.totals.total} ${inv.currency} · ${inv.title}`,
  }, db);
  return { invoice: full };
}

module.exports = { raise, mapCharge, manualLines, eventLines };
