/**
 * Waitlist releases — the port of LHMS.waitlist (PRD 6.1).
 *
 * A waitlisted stay holds no key: the house holds the promise, not a room. When
 * a cancellation frees a room of its type, the oldest request for those dates is
 * offered that room on a 24-hour hold. The offer is its own record, so a hold the
 * guest never takes up can expire without moving the stay or its money.
 *
 * Accepting confirms the stay and bills the nights right then, through the same
 * quote and folio doors a counter booking uses. A request that never converts
 * leaves no charge behind, and a room is only ever offered if the same
 * availability rule the desk's counter applies says it is free.
 */
const pool = require("../db/pool");
const P = require("./price");
const FX = require("./fx");
const biz = require("./business-date");
const BOOKING = require("./booking");
const folio = require("./folio");
const { log } = require("./log");
const { uid } = require("./json");

const HOLD_HOURS = 24;

function stateOf(offer) {
  if (offer.status !== "Offered") return offer.status;
  return new Date(offer.expires_at).getTime() > Date.now() ? "Offered" : "Expired";
}

const timeOf = (v) => new Date(v).toISOString().slice(11, 16);

/** The register for a property, newest offer first, each row carrying its live state. */
async function offers(propertyId, db) {
  const q = db || pool;
  const { rows } = await q.query(
    `SELECT o.*, r.reference, r.check_in, r.check_out, r.room_type_id,
            g.name AS guest_name, rm.number AS room_number, rt.name AS room_type_name
       FROM waitlist_offers o
       JOIN reservations r ON r.id = o.reservation_id
       JOIN guests g       ON g.id = r.guest_id
       JOIN room_types rt  ON rt.id = o.room_type_id
       LEFT JOIN rooms rm  ON rm.id = o.room_id
      WHERE o.property_id = $1
      ORDER BY o.offered_at DESC`,
    [propertyId]
  );
  return rows.map((o) => Object.assign({}, o, { state: stateOf(o) }));
}

/** The stays still waiting, in the order the desk will call them. */
async function queue(propertyId, db) {
  const q = db || pool;
  const { rows } = await q.query(
    `SELECT r.*, g.name AS guest_name, g.email AS guest_email, rt.name AS room_type_name
       FROM reservations r
       JOIN guests g      ON g.id = r.guest_id
       JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = $1 AND r.status = 'Waitlist'
      ORDER BY r.created_at ASC, r.check_in ASC`,
    [propertyId]
  );
  return rows;
}

/**
 * The pass a cancellation runs. Stale holds close first, then the queue is
 * walked oldest-first: each stay with a room free for its dates is offered the
 * first one the counter's own availability rule returns. A stay that already
 * holds an offer is skipped, so a second pass never doubles a hold.
 */
async function release(propertyId, opts) {
  const o = opts || {};
  const client = o.client || await pool.connect();
  const own = !o.client;
  try {
    if (own) await client.query("BEGIN");
    const now = new Date();
    const { rows: stale } = await client.query(
      `SELECT * FROM waitlist_offers
        WHERE property_id = $1 AND status = 'Offered' AND expires_at <= $2`,
      [propertyId, now]
    );
    for (const s of stale) {
      await client.query(
        `UPDATE waitlist_offers SET status = 'Expired', closed_at = $2 WHERE id = $1`,
        [s.id, now]
      );
      const { rows: stay } = await client.query(
        `SELECT reference FROM reservations WHERE id = $1`, [s.reservation_id]
      );
      const { rows: room } = await client.query(`SELECT number FROM rooms WHERE id = $1`, [s.room_id]);
      await log({
        propertyId, actor: o.actor || "Front desk", action: "expired a waitlist offer", entity: "waitlist",
        detail: `${stay[0] ? stay[0].reference : s.reservation_id} · Room ${room[0] ? room[0].number : "—"}`,
      }, client);
    }

    const waiting = await queue(propertyId, client);
    let cat = null;
    let fx = null;
    if (waiting.length) {
      const day = await biz.businessDay();
      [cat, fx] = await Promise.all([P.catalogue(), FX.sources(day)]);
    }

    const made = [];
    for (const r of waiting) {
      if (o.excludeReservationId && o.excludeReservationId === r.id) continue;
      const { rows: open } = await client.query(
        `SELECT id FROM waitlist_offers WHERE reservation_id = $1 AND status = 'Offered' AND expires_at > $2`,
        [r.id, now]
      );
      if (open.length) continue;

      const ci = biz.dstr(r.check_in);
      const co = biz.dstr(r.check_out);
      const free = await BOOKING.freeRooms(client, propertyId, r.room_type_id, ci, co);
      if (!free.length) continue;
      const quote = P.stayQuote(cat, r.room_type_id, r.rate_plan_id, ci, co, r.adults,
        { propertyId, fx });
      if (!quote) continue; // an unpriced type can never be released

      const id = uid("wlo");
      const expires = new Date(now.getTime() + HOLD_HOURS * 3600000);
      const { rows: madeRows } = await client.query(
        `INSERT INTO waitlist_offers
           (id,reservation_id,property_id,room_id,room_type_id,offered_at,expires_at,notified_at,status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$6,'Offered')
         RETURNING *`,
        [id, r.id, propertyId, free[0].id, r.room_type_id, now, expires]
      );
      await log({
        propertyId, actor: o.actor || "Front desk", action: "released a waitlist room", entity: "waitlist",
        detail: `${r.reference} · ${r.guest_name} · Room ${free[0].number}`,
      }, client);
      await client.query(
        `INSERT INTO notifications (id,property_id,type,title,detail,link,read)
         VALUES ($1,$2,'Waitlist release',$3,$4,$5,false)`,
        [uid("ntf"), propertyId, `${r.guest_name} can be given Room ${free[0].number}`,
          `${r.reference} · ${biz.pretty(ci)} → ${biz.pretty(co)} · hold until ${timeOf(expires)}`,
          "#/booking/" + r.id]
      );
      made.push(Object.assign({}, madeRows[0], {
        reference: r.reference, guest_name: r.guest_name, room_number: free[0].number,
        check_in: ci, check_out: co, state: "Offered",
      }));
    }

    if (own) await client.query("COMMIT");
    return { offers: made, expired: stale.length };
  } catch (err) {
    if (own) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (own) client.release();
  }
}

/**
 * Take a release up. Every guard the browser's offer card applies is applied
 * again here — the hold must still be open, the stay must still be waiting, and
 * the room must still be free when the acceptance lands — because the desk may
 * have sold it in between.
 */
async function accept(offerId, opts) {
  const o = opts || {};
  const client = o.client || await pool.connect();
  const own = !o.client;
  try {
    if (own) await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.*, r.status AS res_status, r.rate_plan_id, r.check_in, r.check_out,
              r.adults, r.room_type_id AS res_room_type, r.reference,
              g.name AS guest_name, rm.number AS room_number
         FROM waitlist_offers o
         JOIN reservations r ON r.id = o.reservation_id
         JOIN guests g       ON g.id = r.guest_id
         LEFT JOIN rooms rm  ON rm.id = o.room_id
        WHERE o.id = $1`,
      [offerId]
    );
    const offer = rows[0];
    if (!offer) { if (own) await client.query("ROLLBACK"); return { error: "Waitlist offer not found.", status: 404 }; }
    if (o.propertyId && offer.property_id !== o.propertyId) {
      if (own) await client.query("ROLLBACK");
      return { error: "That offer belongs to another property.", status: 403 };
    }
    if (stateOf(offer) !== "Offered") {
      if (offer.status === "Offered") {
        await client.query(`UPDATE waitlist_offers SET status='Expired', closed_at=$2 WHERE id=$1`, [offer.id, new Date()]);
        if (own) await client.query("COMMIT");
        return { error: "That offer has expired.", status: 422 };
      }
      if (own) await client.query("ROLLBACK");
      return { error: "That offer is no longer open.", status: 422 };
    }
    if (offer.res_status !== "Waitlist") {
      await client.query(`UPDATE waitlist_offers SET status='Declined', closed_at=$2 WHERE id=$1`, [offer.id, new Date()]);
      if (own) await client.query("COMMIT");
      return { error: "That stay is no longer on the waitlist.", status: 422 };
    }

    const ci = biz.dstr(offer.check_in);
    const co = biz.dstr(offer.check_out);
    const free = await BOOKING.freeRooms(client, offer.property_id, offer.res_room_type, ci, co);
    if (!free.some((r) => r.id === offer.room_id)) {
      await client.query(`UPDATE waitlist_offers SET status='Expired', closed_at=$2 WHERE id=$1`, [offer.id, new Date()]);
      await log({
        propertyId: offer.property_id, actor: o.actor || "Front desk", action: "lost a waitlist room",
        entity: "waitlist", detail: `${offer.reference} · Room ${offer.room_number || "—"}`,
      }, client);
      if (own) await client.query("COMMIT");
      return { error: "That room has gone. Release the waitlist again.", status: 422 };
    }

    const day = await biz.businessDay();
    const [cat, fx] = await Promise.all([P.catalogue(), FX.sources(day)]);
    const quote = P.stayQuote(cat, offer.res_room_type, offer.rate_plan_id, ci, co, offer.adults,
      { propertyId: offer.property_id, fx });
    if (!quote) {
      if (own) await client.query("ROLLBACK");
      return { error: "That room type has no rate on sale for those dates.", status: 422 };
    }

    const now = new Date();
    const { rows: moved } = await client.query(
      `UPDATE reservations
          SET room_id = $2, status = 'Confirmed', waitlist_confirmed_at = $3
        WHERE id = $1 RETURNING *`,
      [offer.reservation_id, offer.room_id, now]
    );
    const res = moved[0];

    const posted = await BOOKING.postNights(client, { res, quote, checkOut: co, actor: o.actor || "Front desk" });
    if (posted.error) { if (own) await client.query("ROLLBACK"); return { error: posted.error, status: 422 }; }

    const { rows: billed } = await client.query(
      `UPDATE reservations SET room_total=$2, base_room_total=$3, subtotal=$4, service_chg=$5,
          vat_amount=$6, total=$7, currency=$8, fx_rate=$9
        WHERE id = $1 RETURNING *`,
      [res.id, quote.roomTotal, Math.round(posted.baseRoom), quote.roomTotal, quote.service,
        quote.vat, quote.total, quote.currency, await FX.folioRate(res.id, client)]
    );

    const { rows: closed } = await client.query(
      `UPDATE waitlist_offers SET status = 'Accepted', closed_at = $2 WHERE id = $1 RETURNING *`,
      [offer.id, now]
    );
    await log({
      propertyId: offer.property_id, actor: o.actor || "Front desk", action: "confirmed a waitlist booking",
      entity: "waitlist",
      detail: `${offer.reference} · ${offer.guest_name} · Room ${offer.room_number || "—"}`,
    }, client);
    await client.query(
      `INSERT INTO notifications (id,property_id,type,title,detail,link,read)
       VALUES ($1,$2,'Waitlist confirmed',$3,$4,$5,false)`,
      [uid("ntf"), offer.property_id, `${offer.guest_name} took Room ${offer.room_number || "—"}`,
        `${offer.reference} · ${biz.pretty(ci)} → ${biz.pretty(co)}`, "#/booking/" + res.id]
    );

    if (own) await client.query("COMMIT");
    return {
      res: billed[0], offer: Object.assign({}, closed[0], { state: "Accepted" }),
      quote, folio: await folio.read(res.id),
    };
  } catch (err) {
    if (own) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (own) client.release();
  }
}

/** Pass the room on down the queue. The release pass runs inside the same book. */
async function decline(offerId, opts) {
  const o = opts || {};
  const client = o.client || await pool.connect();
  const own = !o.client;
  try {
    if (own) await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT o.*, r.reference, g.name AS guest_name, rm.number AS room_number
         FROM waitlist_offers o
         JOIN reservations r ON r.id = o.reservation_id
         JOIN guests g       ON g.id = r.guest_id
         LEFT JOIN rooms rm  ON rm.id = o.room_id
        WHERE o.id = $1`,
      [offerId]
    );
    const offer = rows[0];
    if (!offer) { if (own) await client.query("ROLLBACK"); return { error: "Waitlist offer not found.", status: 404 }; }
    if (o.propertyId && offer.property_id !== o.propertyId) {
      if (own) await client.query("ROLLBACK");
      return { error: "That offer belongs to another property.", status: 403 };
    }
    if (stateOf(offer) !== "Offered") {
      if (own) await client.query("ROLLBACK");
      return { error: "That offer is no longer open.", status: 422 };
    }

    const now = new Date();
    const { rows: closed } = await client.query(
      `UPDATE waitlist_offers SET status = 'Declined', closed_at = $2 WHERE id = $1 RETURNING *`,
      [offer.id, now]
    );
    await log({
      propertyId: offer.property_id, actor: o.actor || "Front desk", action: "declined a waitlist offer",
      entity: "waitlist",
      detail: `${offer.reference} · ${offer.guest_name} · Room ${offer.room_number || "—"}`,
    }, client);
    const next = await release(offer.property_id, {
      client, actor: o.actor, excludeReservationId: offer.reservation_id,
    });
    if (own) await client.query("COMMIT");
    return {
      offer: Object.assign({}, closed[0], { state: "Declined" }),
      offers: next.offers,
    };
  } catch (err) {
    if (own) await client.query("ROLLBACK");
    throw err;
  } finally {
    if (own) client.release();
  }
}

module.exports = { HOLD_HOURS, stateOf, offers, queue, release, accept, decline };
