/**
 * The Aurelia Club — what a stay earns and what a point is worth.
 *
 * The arithmetic is the browser's (`LHMS.loyalty` in assets/store.js) and so are
 * the two rules that make it safe: points are earned on what the books keep, not
 * on whatever money the guest happened to be billed in, and a point is only ever
 * worth something as a credit against a live folio. A loyalty balance is not a
 * bank account, so nothing here pays one out — it only ever spends one. The
 * counter-rule, that taking a redemption back puts the points on the profile
 * again, lives in the folio's own void door.
 */
const pool = require("../db/pool");
const FX = require("./fx");
const folio = require("./folio");
const { log } = require("./log");
const { uid } = require("./json");

const LOYALTY = {
  earnPer: 1000, minRedeem: 2000, valuePerPoint: 5,
  multipliers: { Member: 1, Silver: 1.25, Gold: 1.5, Platinum: 2 },
};

const multiplierFor = (tier) => LOYALTY.multipliers[tier] || 1;
const pointsFor = (amount, tier) =>
  Math.max(0, Math.round((Number(amount) || 0) / LOYALTY.earnPer * multiplierFor(tier)));
const creditFor = (points) => Math.round((Number(points) || 0) * LOYALTY.valuePerPoint);
const pointsLine = (points) =>
  `Aurelia Club — ${Number(points).toLocaleString("en-NG")} points redeemed`;

async function guestOf(db, guestId) {
  if (!guestId) return null;
  const { rows } = await db.query(`SELECT id, name, tier, loyalty_pts FROM guests WHERE id = $1`, [guestId]);
  return rows[0] || null;
}

/**
 * What a stay would earn if it left now, and nothing once it has been awarded —
 * the same figure the desk reads beside the folio.
 */
async function pending(reservationId, client) {
  const db = client || pool;
  const { rows } = await db.query(`SELECT * FROM reservations WHERE id = $1`, [reservationId]);
  const stay = rows[0];
  if (!stay || stay.points_awarded) return 0;
  const g = await guestOf(db, stay.guest_id);
  const f = await folio.read(reservationId, db);
  return pointsFor(f.baseTotal, g ? g.tier : "Member");
}

/**
 * Credit the stay to the guest, once. Written on the caller's connection so the
 * award travels inside the check-out that earned it: a departure that rolls back
 * cannot leave points behind, and a departure that has been signed off cannot be
 * awarded twice.
 */
async function award(db, { stay, baseTotal, actor }) {
  if (!stay || stay.points_awarded) return { points: 0 };
  const g = await guestOf(db, stay.guest_id);
  if (!g) return { points: 0 };
  const points = pointsFor(baseTotal, g.tier);
  if (points <= 0) return { points: 0, guest: g };

  await db.query(`UPDATE guests SET loyalty_pts = COALESCE(loyalty_pts, 0) + $2 WHERE id = $1`, [g.id, points]);
  await db.query(`UPDATE reservations SET points_awarded = $2 WHERE id = $1`, [stay.id, points]);
  await db.query(
    `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,$4,$5,$6)`,
    [uid("act"), stay.property_id, actor || "System", "earned loyalty points", "guest",
      `${g.name} · ${points} pts · ${stay.reference}`]
  );
  return { points, guest: { ...g, loyalty_pts: Number(g.loyalty_pts) + points } };
}

/**
 * Spend points on a folio. The refusals come in the browser's order, because
 * which sentence a desk reads first is part of the rule: too few points, more
 * points than the guest holds, more credit than the folio owes, then a folio kept
 * in a money the club does not deal in.
 */
async function redeem(o) {
  const { rows } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [o.reservationId]);
  const stay = rows[0];
  if (!stay) return { error: "Reservation not found." };
  const g = await guestOf(pool, stay.guest_id);
  if (!g) return { error: "No guest profile to redeem from." };

  const points = Math.round(Number(o.points) || 0);
  if (points < LOYALTY.minRedeem) return { error: `Redeem at least ${LOYALTY.minRedeem} points.` };
  const held = Number(g.loyalty_pts) || 0;
  if (points > held) return { error: `Only ${held.toLocaleString("en-NG")} points are available on this profile.` };

  const credit = creditFor(points);
  const f = await folio.read(o.reservationId);
  if (credit > f.balance) {
    return { error: `That is more than the ${f.currency} ${f.balance.toLocaleString("en-NG")} outstanding on the folio.` };
  }
  const cur = await FX.folioCode(o.reservationId, stay.property_id);
  const base = await FX.baseCode(stay.property_id);
  if (cur !== base) {
    return { error: `Aurelia Club credit is worth ${base} and cannot settle a folio billed in ${cur}.` };
  }

  // The credit is a line on the folio like any other, so it goes through the
  // folio's own door and takes that door's stamp and its refusal of a sealed day.
  const posted = await folio.postCharge({
    reservationId: o.reservationId, propertyId: stay.property_id, date: o.date,
    description: pointsLine(points), department: "Loyalty", amount: -credit, qty: 1,
    points, postedBy: o.postedBy || "Front desk", currency: cur,
  });
  if (posted.error) return { error: posted.error };

  // Spent as an addition of a negative, so the balance moves in one statement and
  // cannot be read-and-overwritten by a redemption that raced it.
  await pool.query(`UPDATE guests SET loyalty_pts = COALESCE(loyalty_pts, 0) + $2 WHERE id = $1`,
    [g.id, -points]);
  await log({
    propertyId: stay.property_id, actor: o.postedBy || "Front desk",
    action: "redeemed loyalty points", entity: "folio",
    detail: `${points.toLocaleString("en-NG")} pts · ${cur} ${credit.toLocaleString("en-NG")} credit · ${stay.reference}`,
  });
  return { points, credit, charge: posted.charge, guest: { ...g, loyalty_pts: held - points }, stay };
}

module.exports = {
  LOYALTY, multiplierFor, pointsFor, creditFor, pointsLine,
  pending, award, redeem,
};
