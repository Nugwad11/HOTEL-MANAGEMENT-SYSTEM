/**
 * Opening a stay — the API port of LHMS.actions.newBooking.
 *
 * One door writes a reservation, whoever asks for it: the desk's booking form and
 * the guest's portal both land here, so the same two nights at the same hotel
 * carry the same room money, the same taxes and the same reference sequence from
 * either end. A second implementation of a booking is a second set of figures,
 * and a guest who is billed differently from the walk-in standing beside them has
 * no defence but a difference nobody reconciles.
 *
 * The stay is priced before the transaction opens. A quote that cannot be had —
 * a rate that has come off the air, a money the books cannot value, a room type
 * with nothing free — refuses the booking whole rather than filing a stay whose
 * folio is empty.
 */
const pool = require("../db/pool");
const P = require("./price");
const FX = require("./fx");
const biz = require("./business-date");
const folio = require("./folio");
const { jsonOut, uid } = require("./json");

const SOLD_OUT = "That room type is sold out for the selected dates.";

/** The next reference for a property — one sequence per hotel, as the desk counts it. */
async function nextRef(client, propertyId) {
  const { rows } = await client.query(
    `UPDATE counters SET res_seq = res_seq + 1 WHERE property_id = $1 RETURNING res_seq`,
    [propertyId]
  );
  const { rows: prop } = await client.query(`SELECT code FROM properties WHERE id = $1`, [propertyId]);
  return `${prop[0].code}-${rows[0].res_seq}`;
}

/**
 * The rooms of a type nobody is holding across the dates asked about, in the
 * order the desk allocates them. Anti-joined rather than NOT EXISTS: the
 * in-memory Postgres the tests run on cannot correlate a subquery back to an
 * aliased outer table, and the join reads the same to a live database.
 */
async function freeRooms(client, propertyId, roomTypeId, checkIn, checkOut) {
  const { rows } = await client.query(
    `SELECT ro.id, ro.number FROM rooms ro
     LEFT JOIN reservations rs
       ON rs.room_id = ro.id
      AND rs.status IN ('Confirmed','In-house')
      AND rs.check_in < $4 AND rs.check_out > $3
     WHERE ro.property_id = $1 AND ro.type_id = $2
       AND ro.hk_status NOT IN ('Out of order','Out of service')
       AND rs.id IS NULL
     ORDER BY ro.floor, ro.number`,
    [propertyId, roomTypeId, checkIn, checkOut]
  );
  return rows;
}

/**
 * The folio a new stay opens with: every night of the quote, then the tax on the
 * whole room total. Both go through the folio's one door, so a booking is billed
 * in the money the stay is kept in and at the rate that money holds.
 */
async function postNights(client, { res, quote, checkOut, actor }) {
  const charges = [];
  let baseRoom = 0;
  for (const [i, night] of quote.nightly.entries()) {
    const out = await folio.postCharge({
      client, reservationId: res.id, propertyId: res.property_id, date: night.date,
      description: `Room charge — ${quote.type.name} (${i + 1}/${quote.nights})`,
      department: "Rooms", amount: night.rate, qty: 1, postedBy: actor,
      // The price as it stood when the line was posted. Later re-pricing cannot
      // rewrite this folio, because the line carries its own numbers.
      unitPrice: night.rate, basePrice: night.base, extras: night.added,
      serviceId: night.serviceId, priceId: night.priceId, listId: night.listId,
      listName: night.list, currency: night.currency,
    });
    if (out.error) return { error: out.error };
    baseRoom += out.charge.base_amount === null || out.charge.base_amount === undefined
      ? Number(night.rate) : Number(out.charge.base_amount);
    charges.push(out.charge);
  }
  for (const line of quote.taxLines) {
    // The tax is dated the departure rather than spread over the nights: it is
    // billed on the stay's total, which only exists once the last night has run.
    const out = await folio.postCharge({
      client, reservationId: res.id, propertyId: res.property_id, date: checkOut,
      description: line.label, department: "Taxes & service", amount: line.amount,
      qty: 1, postedBy: "System", taxRuleId: line.rule.id, currency: quote.currency,
    });
    if (out.error) return { error: out.error };
    charges.push(out.charge);
  }
  return { charges, baseRoom };
}

/**
 * Open a stay. `o.actor` is whose name the money is posted under — the desk clerk
 * at the counter, "Guest app" from the portal — and `o.soldOutError` is the
 * sentence the asking page uses when its room type has nothing left, because the
 * counter says "sold out" and a guest is told to try different dates.
 */
async function open(o) {
  const d = {
    propertyId: o.propertyId,
    roomTypeId: o.roomTypeId,
    ratePlanId: o.ratePlanId,
    checkIn: o.checkIn,
    checkOut: o.checkOut,
    adults: Number(o.adults) || 1,
    children: Number(o.children) || 0,
  };
  if (biz.nights(d.checkIn, d.checkOut) < 1) return { error: "Check-out must be after check-in." };

  const day = await biz.businessDay();
  const [cat, fx, prop] = await Promise.all([
    P.catalogue(), FX.sources(day), pool.query(`SELECT code FROM properties WHERE id = $1`, [d.propertyId]),
  ]);
  const property = prop.rows[0];
  if (!property) return { error: "That hotel is not on the books." };
  const type = cat.roomTypes.find((t) => t.id === d.roomTypeId) || null;
  if (!type) return { error: "That room type is not on the books." };
  if (!cat.ratePlans.some((p) => p.id === d.ratePlanId)) return { error: "That rate plan is not on the books." };

  // Priced before anything opens, in the money the books can value on each of
  // those nights. A deposit then follows the stay's own account rather than the
  // property's, so a dollar booking takes a dollar deposit at the rate the
  // booking was opened at.
  const quote = P.stayQuote(cat, d.roomTypeId, d.ratePlanId, d.checkIn, d.checkOut, d.adults,
    { propertyId: d.propertyId, fx });
  if (quote) {
    const one = FX.oneCurrency(await FX.baseCode(d.propertyId),
      quote.nightly.map((n) => ({ currency: n.currency })));
    if (one.error) return { error: one.error };
  }

  /* A waitlist request is a priced promise, not a sale: it holds no room and
     takes no money, so it must name a rate it could be released at and cannot
     carry a deposit. The browser's booking door draws the same two lines. */
  const waiting = Boolean(o.waitlist);
  if (waiting) {
    if (!quote) return { error: "That room type has no rate on sale for those dates." };
    if (Number(o.deposit) > 0) return { error: "A waitlisted stay cannot take a deposit." };
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    let guestId = o.guestId;
    if (!guestId) {
      const name = `${o.firstName || ""} ${o.lastName || ""}`.trim() || "Guest";
      guestId = uid("gst");
      await client.query(
        `INSERT INTO guests (id,first_name,last_name,name,email,phone,since,preferences,consent,tags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [guestId, o.firstName || "", o.lastName || "", name, o.email || "", o.phone || "",
         new Date().getFullYear(),
         jsonOut({ pillow: "No preference", room: "No preference", dietary: "No restrictions",
           allergies: "None", beverage: "Still water", newspaper: "None" }),
         jsonOut({ marketing: false, dataSharing: false, profiling: true }),
         jsonOut(["New profile"])]
      );
    }

    let roomId = null;
    if (!waiting) {
      const free = await freeRooms(client, d.propertyId, d.roomTypeId, d.checkIn, d.checkOut);
      if (!free.length) {
        await client.query("ROLLBACK");
        return { error: o.soldOutError || SOLD_OUT };
      }
      roomId = free[0].id;
    }

    const { rows: guest } = await client.query(`SELECT * FROM guests WHERE id = $1`, [guestId]);
    if (!guest[0]) { await client.query("ROLLBACK"); return { error: "Guest not found." }; }
    const vip = ["Platinum", "Gold"].includes(guest[0].tier);
    const ref = await nextRef(client, d.propertyId);

    const { rows: made } = await client.query(
      `INSERT INTO reservations
         (id,reference,property_id,guest_id,room_id,room_type_id,rate_plan_id,
          check_in,check_out,adults,children,status,channel,source,notes,eta,vip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [uid("res"), ref, d.propertyId, guestId, roomId, d.roomTypeId, d.ratePlanId,
       d.checkIn, d.checkOut, d.adults, d.children, waiting ? "Waitlist" : "Confirmed",
       o.channel || "Direct", o.source || "Front desk", o.notes || "", o.eta || "", vip]
    );
    const res = made[0];

    let posted = null;
    if (quote) {
      if (!waiting) {
        posted = await postNights(client, { res, quote, checkOut: d.checkOut, actor: o.actor || "Front desk" });
        if (posted.error) { await client.query("ROLLBACK"); return { error: posted.error }; }
      }
      // The stay carries what its own lines say: the money it is billed in and
      // the rate the books hold for it, read back off the folio just opened. A
      // waitlisted stay carries the quote only — nothing was posted to read.
      const { rows: done } = await client.query(
        `UPDATE reservations SET room_total=$2, base_room_total=$3, subtotal=$4, service_chg=$5,
            vat_amount=$6, total=$7, currency=$8, fx_rate=$9
          WHERE id = $1 RETURNING *`,
        [res.id, quote.roomTotal, posted ? Math.round(posted.baseRoom) : null, quote.roomTotal,
          quote.service, quote.vat, quote.total, quote.currency, await FX.folioRate(res.id, client)]
      );
      Object.assign(res, done[0]);
    }

    // A deposit is money onto the folio the booking just opened, so it goes
    // through the same door a payment at the till does and takes that folio's own
    // money and rate rather than today's fixing.
    let payment = null;
    if (!waiting && Number(o.deposit) > 0) {
      const out = await folio.takePayment({
        client, reservationId: res.id, propertyId: d.propertyId, date: day,
        amount: Number(o.deposit), method: o.method || "Card", takenBy: o.actor || "Front desk",
      });
      if (out.error) { await client.query("ROLLBACK"); return { error: out.error }; }
      payment = out.payment;
    }

    const nights = quote ? quote.nights : biz.nights(d.checkIn, d.checkOut);
    await client.query(
      `INSERT INTO activity_log (id,property_id,actor,action,entity,detail)
       VALUES ($1,$2,$3,$4,'reservation',$5)`,
      [uid("act"), d.propertyId, o.actor || "Front desk",
        waiting ? "joined the waitlist" : "created a reservation",
        `${ref} · ${guest[0].name} · ${nights} night${nights === 1 ? "" : "s"}`]
    );
    await client.query(
      `INSERT INTO notifications (id,property_id,type,title,detail,link,read)
       VALUES ($1,$2,$3,$4,$5,$6,false)`,
      [uid("ntf"), d.propertyId,
        waiting ? "Added to the waitlist" : "New reservation",
        waiting ? `${ref} for ${guest[0].name}` : `${ref} created for ${guest[0].name}`,
        `${biz.pretty(d.checkIn)} → ${biz.pretty(d.checkOut)} · ${type.name}`, "#/booking/" + res.id]
    );

    await client.query("COMMIT");
    const { rows: final } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [res.id]);
    return {
      res: final[0], guest: guest[0], quote: quote || null, nights,
      charges: posted ? posted.charges : [], payment,
      folio: await folio.read(res.id),
    };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { open, freeRooms, nextRef, postNights, SOLD_OUT };
