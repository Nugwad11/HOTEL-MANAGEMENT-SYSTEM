/**
 * The folio — the money that belongs to a stay.
 *
 * A line and a payment each have one way in, whoever asks for them: the desk
 * form, a hall booking's charges, a cancellation fee and the settlement at
 * check-out all land here. Every other door would be a second set of rules, and
 * two rules for one figure is how a folio stops tying to the books.
 */
const pool = require("../db/pool");
const FX = require("./fx");
const biz = require("./business-date");
const { rowBase } = require("./finance");
const { jsonOut, uid } = require("./json");

/**
 * The folio as the books and the guest each see it. One read for every door that
 * asks — the desk form, a departure, a report — because two folds of the same
 * lines is how a balance stops agreeing with itself.
 *
 * A folio is one currency by construction, so what the guest is billed and what
 * the books keep are two readings of the same lines, never a mix.
 */
async function read(resId, client) {
  const db = client || pool;
  const ch = await db.query(`SELECT * FROM charges  WHERE reservation_id = $1 AND NOT voided`, [resId]);
  const py = await db.query(`SELECT * FROM payments WHERE reservation_id = $1`, [resId]);
  const money = (rows) => ({
    face: rows.reduce((s, r) => s + Number(r.amount), 0),
    base: rows.reduce((s, r) => s + rowBase(r), 0),
  });
  const charged = money(ch.rows), took = money(py.rows);
  const first = ch.rows.find((c) => c.currency) || py.rows.find((p) => p.currency) || {};
  return {
    charges: ch.rows, payments: py.rows,
    total: charged.face, paid: took.face, balance: Math.round(charged.face - took.face),
    currency: first.currency || "NGN", fxRate: first.fx_rate ? Number(first.fx_rate) : null,
    baseTotal: charged.base, basePaid: took.base, baseBalance: Math.round(charged.base - took.base),
  };
}

/**
 * A charge, quoted in the money the folio is kept in and stamped with what the
 * books hold. Refuses a sealed day: a line for a date somebody already signed
 * for belongs on the open date, not inside totals that have been frozen.
 */
async function postCharge(o) {
  const db = o.client || pool;
  const date = o.date || (await biz.businessDay());
  const sealed = await biz.sealedRefusal(date);
  if (sealed) return { error: sealed };

  // The folio is valued from the same connection the line is written on: a stay
  // being opened night by night inside one transaction has to see the nights it
  // has already billed, or a live database would let the second line open the
  // account in a different money from the first.
  const cur = o.currency || await FX.folioCode(o.reservationId, o.propertyId, db);
  const stamp = await FX.folioStamp(o.reservationId, o.amount, cur,
    { propertyId: o.propertyId, date, client: db });
  if (stamp.error) return { error: stamp.error };

  const { rows } = await db.query(
    `INSERT INTO charges (id,reservation_id,charge_date,description,department,amount,qty,posted_by,
       unit_price,base_price,extras,service_id,price_id,list_id,list_name,tax_rule_id,points,
       currency,fx_rate,base_amount,event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
    [uid("chg"), o.reservationId, date, o.description, o.department || "Other",
      Math.round(o.amount), o.qty || 1, o.postedBy || "System",
      o.unitPrice === undefined ? null : Math.round(o.unitPrice),
      o.basePrice === undefined ? null : Math.round(o.basePrice),
      o.extras ? jsonOut(o.extras) : null,
      o.serviceId || null, o.priceId || null, o.listId || null, o.listName || null,
      o.taxRuleId || null, o.points === undefined ? null : o.points,
      stamp.currency || cur, stamp.fxRate, stamp.baseAmount, o.eventId || null]
  );
  return { charge: rows[0] };
}

/**
 * Money handed in settles the folio it is aimed at, in that folio's own money at
 * the rate that folio was opened at — the till never re-values an account.
 */
async function takePayment(o) {
  const db = o.client || pool;
  const date = o.date || (await biz.businessDay());
  const cur = o.currency || await FX.folioCode(o.reservationId, o.propertyId, db);
  const stamp = await FX.folioStamp(o.reservationId, o.amount, cur,
    { propertyId: o.propertyId, date, client: db });
  if (stamp.error) return { error: stamp.error };

  const { rows } = await db.query(
    `INSERT INTO payments (id,reservation_id,payment_date,method,amount,reference,taken_by,
       currency,fx_rate,base_amount,event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [uid("pay"), o.reservationId, date, o.method || "Card", Math.round(o.amount),
      o.reference || "TX" + Math.floor(100000 + Math.random() * 899999),
      o.takenBy || "System", stamp.currency || cur, stamp.fxRate, stamp.baseAmount, o.eventId || null]
  );
  return { payment: rows[0] };
}

/**
 * Taking a line back off a folio. A void is a reversal, not an erasure: the row
 * keeps its money stamp so a report can still read what was removed and by whom.
 *
 * A redemption is the one line whose reversal reaches outside the folio. The
 * credit came off the guest's point balance, so taking the credit back has to put
 * the points on the profile again or the void is free money.
 */
async function voidCharge(o) {
  const db = o.client || pool;
  const params = [o.chargeId];
  let sql = `SELECT c.*, r.property_id, r.guest_id FROM charges c
     JOIN reservations r ON r.id = c.reservation_id WHERE c.id = $1`;
  if (o.reservationId) { params.push(o.reservationId); sql += ` AND c.reservation_id = $2`; }
  const { rows } = await db.query(sql, params);
  const c = rows[0];
  if (!c) {
    return { missing: true, error: o.reservationId ? "That charge is not on this folio." : "Charge not found." };
  }
  if (c.voided) return { error: "This charge is already void." };
  const sealed = await biz.sealedRefusal(biz.dstr(c.charge_date));
  if (sealed) return { error: sealed };

  const { rows: done } = await db.query(
    `UPDATE charges SET voided = true, voided_by = $2, voided_at = $3
     WHERE id = $1 AND NOT voided RETURNING *`,
    [o.chargeId, o.actor || "System", new Date().toISOString()]
  );
  if (!done[0]) return { error: "This charge is already void." };
  const points = Number(c.points) || 0;
  if (c.department === "Loyalty" && points && c.guest_id) {
    await db.query(`UPDATE guests SET loyalty_pts = COALESCE(loyalty_pts, 0) + $2 WHERE id = $1`, [c.guest_id, points]);
  }
  return { charge: done[0], propertyId: c.property_id, description: c.description,
    amount: Number(c.amount), currency: c.currency, points };
}

module.exports = { read, postCharge, takePayment, voidCharge };
