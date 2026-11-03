const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const FX = require("../lib/fx");
const BOOKING = require("../lib/booking");
const folio = require("../lib/folio");
const LOY = require("../lib/loyalty");
const P = require("../lib/price");
const W = require("../lib/waitlist");
const biz = require("../lib/business-date");
const { log } = require("../lib/log");
const { uid } = require("../lib/json");

const router = Router();
router.use(authenticate);

/* ── helpers ────────────────────────────────────────────────── */

/* ── list ───────────────────────────────────────────────────── */
router.get("/", can("manage_reservations"), async (req, res, next) => {
  try {
    const { propertyId, status, q, limit = 200, offset = 0 } = req.query;
    const pid = propertyId || req.user.propertyId;
    const params = [pid];
    const where = ["r.property_id = $1"];
    if (status && status !== "all") { params.push(status); where.push(`r.status = $${params.length}`); }
    if (q) {
      params.push(`%${q}%`);
      where.push(`(r.reference ILIKE $${params.length} OR g.name ILIKE $${params.length})`);
    }
    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT r.*, g.name AS guest_name, g.tier AS guest_tier,
              rm.number AS room_number, rt.name AS room_type_name
       FROM reservations r
       JOIN guests g    ON g.id = r.guest_id
       LEFT JOIN rooms rm   ON rm.id = r.room_id
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
       WHERE ${where.join(" AND ")}
       ORDER BY r.check_in DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
});

/* ── single ─────────────────────────────────────────────────── */
router.get("/:id", can("manage_reservations"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.*, g.name AS guest_name, g.tier AS guest_tier, g.preferences AS guest_prefs,
              rm.number AS room_number, rt.name AS room_type_name,
              rp.name AS rate_plan_name
       FROM reservations r
       JOIN guests g      ON g.id = r.guest_id
       LEFT JOIN rooms rm         ON rm.id = r.room_id
       LEFT JOIN room_types rt    ON rt.id = r.room_type_id
       LEFT JOIN rate_plans rp    ON rp.id = r.rate_plan_id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Reservation not found." });
    const f = await folio.read(req.params.id);
    // What the stay will earn if it leaves now — the figure the desk reads beside
    // the folio, and zero once the departure has credited it.
    res.json({ ...rows[0], folio: f, pointsPending: await LOY.pending(req.params.id) });
  } catch (err) { next(err); }
});

/* ── folio ──────────────────────────────────────────────────── */
router.get("/:id/folio", authenticate, async (req, res, next) => {
  try {
    res.json(await folio.read(req.params.id));
  } catch (err) { next(err); }
});

/* ── create ─────────────────────────────────────────────────── */
const CreateSchema = z.object({
  propertyId:  z.string(),
  guestId:     z.string().optional(),
  firstName:   z.string().optional(),
  lastName:    z.string().optional(),
  email:       z.string().email().optional().or(z.literal("")),
  phone:       z.string().optional(),
  roomTypeId:  z.string(),
  ratePlanId:  z.string(),
  checkIn:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  adults:      z.number().int().min(1).default(1),
  children:    z.number().int().min(0).default(0),
  channel:     z.string().default("Direct"),
  source:      z.string().default("Front desk"),
  notes:       z.string().optional(),
  eta:         z.string().optional(),
  deposit:     z.number().min(0).default(0),
  method:      z.string().optional(),
  /* A sold-out counter can take a waitlist request instead of turning the guest
     away; the stay is priced now and billed only when a room is released. */
  waitlist:    z.boolean().default(false),
});

/**
 * The desk's booking form. Every figure — the nights, the taxes they carry, the
 * money the folio is opened in and the deposit against it — is the booking door's
 * own, so a stay taken at the counter and the same stay taken from a guest's phone
 * cannot be billed two different ways.
 */
router.post("/", can("manage_reservations"), validate(CreateSchema), async (req, res, next) => {
  try {
    const out = await BOOKING.open(Object.assign(req.data, { actor: req.user.name }));
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json(out.res);
  } catch (err) { next(err); }
});

/* ── check-in ───────────────────────────────────────────────── */
router.post("/:id/check-in", can("check_in_out"), async (req, res, next) => {
  // The deposit is settled before the transaction opens: a stamp the books
  // cannot value has to refuse the whole check-in, and a refusal inside an open
  // transaction leaves the connection holding a half-written stay.
  const { rows: found } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [req.params.id]);
  const stay = found[0];
  if (!stay) return res.status(404).json({ error: "Reservation not found." });
  if (stay.status !== "Confirmed") {
    return res.status(422).json({ error: "Only confirmed reservations can be checked in." });
  }
  let money = null;
  if (req.body.deposit > 0) {
    // Check-in money lands on the folio the guest is joining, so it follows the
    // currency and rate already on that account rather than today's fixing.
    const day = await biz.businessDay();
    const cur = await FX.folioCode(req.params.id, stay.property_id);
    const stamp = await FX.folioStamp(req.params.id, req.body.deposit, cur,
      { propertyId: stay.property_id, date: day });
    if (stamp.error) return res.status(422).json({ error: stamp.error });
    money = { day, cur, stamp };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE reservations SET status='In-house', checked_in_at=now(), room_id=$2, mobile_key=$3, key_issued_at=CASE WHEN $3 THEN now() ELSE NULL END
       WHERE id=$1`,
      [req.params.id, req.body.roomId || stay.room_id, !!req.body.mobileKey]
    );
    if (req.body.roomId || stay.room_id) {
      await client.query(`UPDATE rooms SET hk_status='Occupied' WHERE id=$1`, [req.body.roomId || stay.room_id]);
    }
    if (money) {
      await client.query(
        `INSERT INTO payments (id,reservation_id,payment_date,method,amount,reference,taken_by,currency,fx_rate,base_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uid("pay"), req.params.id, money.day, req.body.method || "Card", req.body.deposit,
          "TX" + Math.floor(100000 + Math.random() * 899999), req.user.name,
          money.stamp.currency || money.cur, money.stamp.fxRate, money.stamp.baseAmount]
      );
    }
    await client.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'checked in','reservation',$4)`,
      ["act_" + Math.random().toString(36).slice(2, 8), stay.property_id, req.user.name, stay.reference]
    );
    await client.query("COMMIT");
    const { rows: updated } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [req.params.id]);
    res.json(updated[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

/* ── check-out ──────────────────────────────────────────────── */
router.post("/:id/check-out", can("check_in_out"), async (req, res, next) => {
  const { rows: found } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [req.params.id]);
  const stay = found[0];
  if (!stay) return res.status(404).json({ error: "Reservation not found." });
  if (stay.status !== "In-house") {
    return res.status(422).json({ error: "Guest is not currently checked in." });
  }

  const f = await folio.read(req.params.id);
  if (f.balance > 0 && !req.body.settle) {
    return res.status(422).json({
      error: `Balance of ${f.currency} ${f.balance.toLocaleString()} must be settled.`,
      balance: f.balance, currency: f.currency,
    });
  }
  let money = null;
  if (f.balance > 0) {
    // Settling writes money into the folio, so it takes the folio's own currency
    // and rate — a forced settle at the wrong money is refused here exactly as it
    // is at the till, and before anything has been written.
    const day = await biz.businessDay();
    const cur = await FX.folioCode(req.params.id, stay.property_id);
    const stamp = await FX.folioStamp(req.params.id, f.balance, cur,
      { propertyId: stay.property_id, date: day });
    if (stamp.error) return res.status(422).json({ error: stamp.error });
    money = { day, cur, stamp };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (money) {
      await client.query(
        `INSERT INTO payments (id,reservation_id,payment_date,method,amount,reference,taken_by,currency,fx_rate,base_amount)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uid("pay"), req.params.id, money.day, req.body.method || "Card", f.balance,
          "TX" + Math.floor(100000 + Math.random() * 899999), req.user.name,
          money.stamp.currency || money.cur, money.stamp.fxRate, money.stamp.baseAmount]
      );
    }
    await client.query(
      `UPDATE reservations SET status='Checked out', checked_out_at=now() WHERE id=$1`, [req.params.id]
    );
    if (stay.room_id) {
      await client.query(`UPDATE rooms SET hk_status='Dirty' WHERE id=$1`, [stay.room_id]);
      // Create departure clean task
      await client.query(
        `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,priority,status,source,sla_mins,due_at)
         VALUES ($1,$2,'Departure clean',$3,'Guest checked out. Full turnover before next arrival.',$4,$5,'High','Open','Front desk',60,now() + interval '60 minutes')`,
        ["tsk_" + Math.random().toString(36).slice(2, 8), stay.property_id, `Departure clean — Room ${stay.room_id}`, stay.room_id, stay.guest_id]
      );
    }
    await client.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'checked out','reservation',$4)`,
      ["act_" + Math.random().toString(36).slice(2, 8), stay.property_id, req.user.name, stay.reference]
    );
    // The stay earns its points inside the same transaction as the departure: a
    // check-out that rolls back must not leave a guest richer, and one that has
    // been signed off cannot be awarded a second time.
    const earned = await LOY.award(client, { stay, baseTotal: f.baseTotal, actor: req.user.name });
    await client.query("COMMIT");
    const { rows: updated } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [req.params.id]);
    res.json({ ...updated[0], points: earned.points });
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

/* ── cancel ─────────────────────────────────────────────────── */
/**
 * Cancelling frees the room, and the freed room goes straight to the waitlist:
 * the release pass runs inside the same book as the cancellation, so a stay
 * cannot be cancelled without the queue behind it being called. A waitlisted
 * stay has no room of its own to free — leaving the list simply closes it.
 */
router.post("/:id/cancel", can("manage_reservations"), async (req, res, next) => {
  const { rows: found } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [req.params.id]);
  const stay = found[0];
  if (!stay) return res.status(404).json({ error: "Reservation not found." });
  if (!["Confirmed", "In-house", "Waitlist"].includes(stay.status)) {
    return res.status(422).json({ error: "Reservation cannot be cancelled in its current status." });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE reservations SET status='Cancelled' WHERE id=$1 RETURNING *`, [stay.id]
    );
    // A guest still in the room leaves it dirty; a stay nobody has taken leaves
    // the house as it stood.
    await client.query(
      `UPDATE rooms SET hk_status='Dirty' WHERE id = (SELECT room_id FROM reservations WHERE id=$1)
         AND hk_status='Occupied'`,
      [stay.id]
    );
    if (req.body && req.body.fee) {
      // The fee is the first night the folio already holds; a stay that has not
      // billed a night yet is charged its own nightly rate.
      const { rows: night } = await client.query(
        `SELECT amount FROM charges WHERE reservation_id = $1 AND department = 'Rooms' AND NOT voided
          ORDER BY charge_date LIMIT 1`,
        [stay.id]
      );
      let amount = night[0] ? Number(night[0].amount) : 0;
      if (!amount) {
        const day = await biz.businessDay();
        const [cat, fx] = await Promise.all([P.catalogue(), FX.sources(day)]);
        const q = P.stayQuote(cat, stay.room_type_id, stay.rate_plan_id,
          biz.dstr(stay.check_in), biz.dstr(stay.check_out), stay.adults,
          { propertyId: stay.property_id, fx });
        const nights = biz.nights(biz.dstr(stay.check_in), biz.dstr(stay.check_out));
        amount = q && nights ? Math.round(q.roomTotal / nights) : 0;
      }
      if (amount > 0) {
        const out = await folio.postCharge({
          reservationId: stay.id, propertyId: stay.property_id, client,
          description: "Cancellation fee — one night", department: "Rooms",
          amount, postedBy: req.user.name,
        });
        if (out.error) {
          await client.query("ROLLBACK");
          return res.status(422).json({ error: out.error });
        }
      }
    }
    const { rows: guest } = await client.query(`SELECT name FROM guests WHERE id = $1`, [stay.guest_id]);
    await log({ propertyId: stay.property_id, actor: req.user.name, action: "cancelled a reservation",
      entity: "reservation", detail: `${stay.reference} · ${guest[0] ? guest[0].name : "Guest"}` }, client);
    const released = await W.release(stay.property_id, {
      client, actor: req.user.name, excludeReservationId: stay.id,
    });
    await client.query("COMMIT");
    res.json(Object.assign({}, rows[0], { released: released.offers, expired: released.expired }));
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

/* ── post charge ────────────────────────────────────────────── */
router.post("/:id/charges", can("post_charges"), async (req, res, next) => {
  try {
    const { description, department, amount, qty, date, postedBy } = req.body;
    if (!amount || amount <= 0) return res.status(422).json({ error: "Amount must be greater than zero." });
    const { rows: stay } = await pool.query(`SELECT property_id FROM reservations WHERE id = $1`, [req.params.id]);
    if (!stay[0]) return res.status(404).json({ error: "Reservation not found." });

    // The line goes through the folio's one door, so it is taken in the money the
    // account is kept in, stamped with what the books hold, and refused outright
    // if it aims at a day somebody already signed for.
    const out = await folio.postCharge({
      reservationId: req.params.id, propertyId: stay[0].property_id, date,
      description: description || "Miscellaneous charge", department: department || "Other",
      amount, qty: qty || 1, postedBy: postedBy || req.user.name, currency: req.body.currency,
      unitPrice: req.body.unitPrice, basePrice: req.body.basePrice, extras: req.body.extras,
      serviceId: req.body.serviceId, priceId: req.body.priceId,
      listId: req.body.listId, listName: req.body.listName, taxRuleId: req.body.taxRuleId,
    });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json(out.charge);
  } catch (err) { next(err); }
});

/* ── void charge ────────────────────────────────────────────── */
router.post("/:id/charges/:chargeId/void", can("post_charges"), async (req, res, next) => {
  try {
    const out = await folio.voidCharge({
      chargeId: req.params.chargeId, reservationId: req.params.id, actor: req.user.name,
    });
    if (out.error) return res.status(out.missing ? 404 : 422).json({ error: out.error });

    await log({
      propertyId: out.propertyId, actor: req.user.name, action: "voided a charge", entity: "folio",
      detail: `${out.currency || "NGN"} ${out.amount.toLocaleString()} · ${out.description}`,
    });
    res.json(out.charge);
  } catch (err) { next(err); }
});

/* ── take payment ───────────────────────────────────────────── */
router.post("/:id/payments", can("take_payments"), async (req, res, next) => {
  try {
    const { amount, method, takenBy } = req.body;
    if (!amount || amount <= 0) return res.status(422).json({ error: "Amount must be greater than zero." });
    const { rows: stay } = await pool.query(`SELECT property_id FROM reservations WHERE id = $1`, [req.params.id]);
    if (!stay[0]) return res.status(404).json({ error: "Reservation not found." });

    // A guest pays into the folio's own money at the rate the folio was opened
    // at, so dollars handed over on a dollar stay settle what was billed rather
    // than whatever the treasury filed this morning.
    const out = await folio.takePayment({
      reservationId: req.params.id, propertyId: stay[0].property_id, date: req.body.date,
      amount, method: method || "Card", takenBy: takenBy || req.user.name,
      currency: req.body.currency, reference: req.body.reference,
    });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json(out.payment);
  } catch (err) { next(err); }
});

/* ── redeem loyalty points ──────────────────────────────────── */
const RedeemSchema = z.object({
  // Deliberately no floor here: "redeem at least 2,000 points" is the club's own
  // sentence, and a desk should read it from the ledger rather than from a schema.
  points:   z.number().int(),
  postedBy: z.string().optional(),
  date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/**
 * A redemption is a line on the folio, so it goes through the same permission the
 * desk holds for any other line — and through the club's own refusals, which are
 * the rule and not a suggestion: enough points, as many as the guest holds, no
 * more credit than the folio owes, and only a folio kept in the books' money.
 */
router.post("/:id/redeem", can("post_charges"), validate(RedeemSchema), async (req, res, next) => {
  try {
    const out = await LOY.redeem({
      reservationId: req.params.id, points: req.data.points,
      postedBy: req.data.postedBy || req.user.name, date: req.data.date,
    });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json({ points: out.points, credit: out.credit, charge: out.charge, guest: out.guest });
  } catch (err) { next(err); }
});

module.exports = router;
