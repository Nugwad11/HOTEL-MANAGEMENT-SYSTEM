/**
 * Night audit — the pack a manager reads, the controls they confirm, and the
 * close that seals them.
 *
 * The run is group-wide: one business date drives every property, so the nights
 * it posts belong to the whole estate. The pack it seals is the property the
 * close was started from, stored rather than recomputed — the figures finance
 * hold for a closed day are the figures the close signed.
 */
const pool = require("../db/pool");
const { businessDay, closedOn, setBusinessDay, dstr, addDays } = require("./business-date");
const { uid, jsonOut, jsonIn } = require("./json");
const { log } = require("./log");
const P = require("./price");
const FX = require("./fx");

const nights = (from, to) => {
  const a = new Date(dstr(from) + "T12:00:00Z"), b = new Date(dstr(to) + "T12:00:00Z");
  return Math.max(1, Math.round((b - a) / 86400000));
};

/** The figure the books keep: the conversion the row carried, or its own amount. */
const book = (row) =>
  row.base_amount === null || row.base_amount === undefined ? Number(row.amount) : Number(row.base_amount);

async function stays() {
  const { rows } = await pool.query(
    `SELECT r.*, g.name AS guest_name FROM reservations r
     JOIN guests g ON g.id = r.guest_id ORDER BY r.check_in`
  );
  return rows.map((r) => ({
    id: r.id, reference: r.reference, propertyId: r.property_id, guestId: r.guest_id,
    guestName: r.guest_name, roomId: r.room_id, roomTypeId: r.room_type_id,
    ratePlanId: r.rate_plan_id, checkIn: dstr(r.check_in), checkOut: dstr(r.check_out),
    adults: Number(r.adults || 1), status: r.status, vip: !!r.vip,
    roomTotal: r.room_total === null ? 0 : Number(r.room_total),
    baseRoomTotal: r.base_room_total === null ? 0 : Number(r.base_room_total),
    currency: r.currency || "NGN",
  }));
}

/**
 * Every folio balance in one pass: what the charges say less what the till took.
 * Both readings travel together — the face balance is what the guest is asked
 * for, the book balance is what the property counts, and a foreign folio has one
 * currency across all its lines so the two never mix.
 */
async function balances() {
  const [chg, pay] = await Promise.all([
    pool.query(
      `SELECT c.reservation_id, COALESCE(SUM(c.amount),0) AS face,
              COALESCE(SUM(COALESCE(c.base_amount, c.amount)),0) AS book
       FROM charges c WHERE NOT c.voided GROUP BY c.reservation_id`),
    pool.query(
      `SELECT reservation_id, COALESCE(SUM(amount),0) AS face,
              COALESCE(SUM(COALESCE(base_amount, amount)),0) AS book
       FROM payments GROUP BY reservation_id`),
  ]);
  const out = {};
  const cell = (r) => (out[r.reservation_id] = out[r.reservation_id] || { face: 0, book: 0 });
  chg.rows.forEach((r) => { const c = cell(r); c.face += Number(r.face); c.book += Number(r.book); });
  pay.rows.forEach((r) => { const c = cell(r); c.face -= Number(r.face); c.book -= Number(r.book); });
  return out;
}

/* The nights an in-house folio still owes, walked once per pack. A folio carries
   one room charge per night, billed as the guest checks in, so the audit's job is
   the nights nobody billed. Nights already dated and live are left alone, which
   is what makes a second run safe instead of charging twice. */
function openNights(cat, day, reservations, billed) {
  const out = [];
  reservations.forEach((r) => {
    if (r.status !== "In-house") return;
    const seen = billed[r.id] || {};
    for (let d = r.checkIn; d <= day; d = addDays(d, 1)) {
      if (seen[d]) continue;
      out.push({ res: r, date: d });
    }
  });
  return out;
}

/**
 * The nights owed, priced. A quote is null when nothing is sellable that night
 * — and a night priced in a money the books cannot value is not sellable, so it
 * is missing from this list rather than in it.
 */
function unbilledNights(cat, day, fx, reservations, billed) {
  return openNights(cat, day, reservations, billed)
    .map((n) => {
      const q = P.quoteNight(cat, n.res.roomTypeId, n.res.ratePlanId, n.date, n.res.adults,
        { fx, propertyId: n.res.propertyId });
      return q ? { res: n.res, date: n.date, quote: q } : null;
    })
    .filter(Boolean);
}

/**
 * A night priced in a money the books cannot value has no quote at all, so it
 * never reaches the list of nights owed — and a close built from that list would
 * seal the day with the guest still owing in a money nobody billed. These nights
 * are found by asking for the price row itself, before the gate, and they stop
 * the run.
 */
function unbillableNights(cat, day, fx, reservations, billed) {
  const out = [];
  reservations.forEach((r) => {
    if (r.status !== "In-house") return;
    const svc = P.serviceOf(cat, "room", r.roomTypeId);
    if (!svc || !svc.active) return;
    const seen = billed[r.id] || {};
    for (let d = r.checkIn; d <= day; d = addDays(d, 1)) {
      if (seen[d]) continue;
      const hit = P.resolve(cat.prices, cat.lists, svc.id, { date: d });
      if (!hit) continue;
      const blocked = FX.gateIn(FX.contextOf(fx, r.propertyId, d), hit.price.currency);
      if (blocked) out.push({ res: r, date: d, price: hit.price, blocked });
    }
  });
  return out;
}

async function roomChargeDates() {
  const { rows } = await pool.query(
    `SELECT reservation_id, charge_date FROM charges WHERE NOT voided AND department = 'Rooms'`
  );
  const out = {};
  rows.forEach((c) => {
    (out[c.reservation_id] = out[c.reservation_id] || {})[dstr(c.charge_date)] = true;
  });
  return out;
}

/** Everything the close screen reports and the run itself reads, from one place. */
async function pack(propertyId) {
  const day = await businessDay();
  const [cat, fx, all, billed] = await Promise.all([
    P.catalogue(), FX.sources(day), stays(), roomChargeDates(),
  ]);
  const unbilled = unbilledNights(cat, day, fx, all, billed);
  const unbillable = unbillableNights(cat, day, fx, all, billed);
  const [balance, roomRows, activity] = await Promise.all([
    balances(), rooms(propertyId), activityCount(propertyId),
  ]);

  const mine = all.filter((r) => r.propertyId === propertyId);
  const staying = mine.filter((r) => r.status === "In-house" && r.checkIn <= day && r.checkOut > day);
  const arrivals = mine.filter((r) => r.status === "Confirmed" && r.checkIn === day);
  const departures = mine.filter((r) => r.status === "In-house" && r.checkOut === day);
  const noShows = mine.filter((r) => r.status === "No-show");
  const sellable = roomRows.filter((r) => r.hk !== "Out of order" && r.hk !== "Out of service").length;

  const today = await dayMoney(propertyId, day);
  // ADR is a yield figure, and a yield only means something when every stay is
  // counted in the money the property keeps.
  const roomRevenue = staying.reduce((s, r) => s + ((r.baseRoomTotal || r.roomTotal) || 0) / nights(r.checkIn, r.checkOut), 0);
  const occ = sellable ? (staying.length / sellable) * 100 : 0;
  const adr = staying.length ? roomRevenue / staying.length : 0;
  const metrics = {
    date: day, sellable, occupied: staying.length, inHouse: staying.length,
    arrivals: arrivals.length, departures: departures.length,
    occupancy: Math.round(occ * 10) / 10, adr: Math.round(adr), revpar: Math.round(occ / 100 * adr),
    roomRevenue: Math.round(roomRevenue),
    balanceDue: Math.round(staying.reduce((s, r) => s + Math.max(0, (balance[r.id] || {}).book || 0), 0)),
    dirty: roomRows.filter((r) => r.hk === "Dirty").length,
    ooo: roomRows.filter((r) => r.hk === "Out of order" || r.hk === "Out of service").length,
    availableTonight: Math.max(0, sellable - staying.length),
  };

  const fxCtx = FX.contextOf(fx, propertyId, day);
  const catalogue = await FX.inCatalogue(fxCtx.base);
  return {
    day, propertyId, metrics,
    charges: today.charges, payments: today.payments,
    chargesTotal: today.chargesTotal, paymentsTotal: today.paymentsTotal,
    byDept: today.byDept,
    // The monies the catalogue is written in and the ones the books cannot
    // currently value — the close names them rather than billing around them.
    baseCurrency: fxCtx.base, catalogue,
    rates: FX.statesIn(fxCtx, catalogue),
    arrivals, departures, noShows,
    inHouse: staying,
    unresolved: staying.filter((r) => ((balance[r.id] || {}).face || 0) > 0),
    dirty: roomRows.filter((r) => r.hk === "Dirty"),
    ooo: roomRows.filter((r) => r.hk === "Out of order" || r.hk === "Out of service"),
    activityCount: activity,
    unbilled, unbillable,
    unbilledTotal: unbilled.reduce((s, n) => {
      // Only nights the books can value are in this list, so the sum they promise
      // is a sum of book figures.
      const conv = FX.toBase(fx.rates, n.quote.rate + n.quote.taxes, n.quote.currency,
        FX.contextOf(fx, n.res.propertyId, n.date));
      return s + (conv.ok ? conv.base : 0);
    }, 0),
  };
}

async function rooms(propertyId) {
  const { rows } = await pool.query(
    `SELECT id, number, hk_status FROM rooms WHERE property_id = $1 ORDER BY number`, [propertyId]
  );
  return rows.map((r) => ({ id: r.id, number: r.number, hk: r.hk_status }));
}

async function activityCount(propertyId) {
  const { rows } = await pool.query(`SELECT COUNT(*) AS n FROM activity_log WHERE property_id = $1`, [propertyId]);
  return Number(rows[0].n);
}

async function dayMoney(propertyId, day) {
  const { rows } = await pool.query(
    `SELECT c.description, c.department, c.amount, c.currency, c.base_amount, r.reference
     FROM charges c JOIN reservations r ON r.id = c.reservation_id
     WHERE r.property_id = $1 AND NOT c.voided AND c.charge_date = $2`, [propertyId, day]
  );
  const pay = await pool.query(
    `SELECT p.method, p.amount, p.currency, p.base_amount, p.reference, r.reference AS reservation_reference
     FROM payments p JOIN reservations r ON r.id = p.reservation_id
     WHERE r.property_id = $1 AND p.payment_date = $2`, [propertyId, day]
  );
  // A pack is a set of books, so every total in it is counted in the money the
  // property keeps: a dollar payment and a naira payment only add up once each is
  // read as what it was worth on the day it moved.
  const byDept = {};
  rows.forEach((c) => { byDept[c.department] = (byDept[c.department] || 0) + book(c); });
  return {
    charges: rows.map((c) => ({
      description: c.description, department: c.department, amount: Number(c.amount),
      currency: c.currency || null, baseAmount: book(c), reference: c.reference,
    })),
    payments: pay.rows.map((p) => ({
      method: p.method, amount: Number(p.amount), currency: p.currency || null,
      baseAmount: book(p), reference: p.reference, reservation: p.reservation_reference,
    })),
    chargesTotal: rows.reduce((s, c) => s + book(c), 0),
    paymentsTotal: pay.rows.reduce((s, p) => s + book(p), 0),
    byDept: Object.keys(byDept).map((k) => ({ name: k, amount: byDept[k] })).sort((a, b) => b.amount - a.amount),
  };
}

/** The controls the manager signs off. The run reads this same list. */
function checks(p) {
  return [
    {
      key: "arrivals", title: "Verify arrivals and no-shows",
      detail: `${p.arrivals.length} confirmed arrivals · ${p.noShows.length} no-shows recorded`,
    },
    {
      key: "folios", title: "Review unresolved folios",
      detail: `${p.unresolved.length} in-house folios carry a balance`,
    },
    {
      key: "roomtax", title: "Post room and tax",
      detail: p.unbillable.length
        ? `${p.unbillable.length} open ${p.unbillable.length === 1 ? "night" : "nights"} priced in ` +
          `${uniq(p.unbillable.map((n) => n.price.currency)).join(" and ")} cannot be valued — ` +
          `this run stops until the rate is filed`
        : p.unbilled.length
          ? `${p.unbilled.length} unbilled ${p.unbilled.length === 1 ? "night" : "nights"} worth ` +
            `${p.unbilledTotal} — this run posts them`
          : `Every in-house folio carries its room charge for ${p.day}`,
    },
    {
      key: "payments", title: "Reconcile payments",
      detail: `${p.paymentsTotal} taken today across card, cash and transfer`,
    },
    {
      key: "currency", title: "Confirm the rates the books valued in",
      detail: p.rates.length
        ? `${p.rates.map((r) => `${r.code} (${r.state})`).join(", ")} cannot be valued today — ` +
          `refresh them in Financial settings before selling or settling in them`
        : p.catalogue.length
          ? `Every currency the catalogue sells in has a usable rate on ${p.day}`
          : `Everything here is billed in ${p.baseCurrency}`,
    },
    {
      key: "housekeeping", title: "Housekeeping handover",
      detail: `${p.dirty.length} dirty · ${p.ooo.length} out of order`,
    },
    {
      key: "revenue", title: "Review revenue pack",
      detail: `${p.chargesTotal} charges posted · ADR ${p.metrics.adr}`,
    },
    {
      key: "audit", title: "Confirm audit trail and backup",
      detail: `${p.activityCount} activity records · NDPR log retained`,
    },
  ];
}

const uniq = (list) => list.filter((c, i, all) => all.indexOf(c) === i);

/**
 * Each open night is stamped before anything is written. A folio that cannot
 * take the money — a room account kept in another currency, a rate that has gone
 * off the air — stops the run instead of leaving the day half-billed.
 */
async function planNights(unbilled, fx) {
  const plan = [];
  for (const n of unbilled) {
    const q = n.quote;
    const cur = q.currency || "NGN";
    const opts = { propertyId: n.res.propertyId, date: n.date, ctx: FX.contextOf(fx, n.res.propertyId, n.date) };
    const room = await FX.folioStamp(n.res.id, q.rate, cur, opts);
    if (room.error) return { error: room.error };
    const taxes = [];
    for (const line of q.taxLines) {
      const t = await FX.folioStamp(n.res.id, line.amount, cur, opts);
      if (t.error) return { error: t.error };
      taxes.push(t);
    }
    plan.push({ n, q, cur, room, taxes });
  }
  return { plan };
}

async function postNight(p, fx, actor) {
  const posted = [];
  for (const { n, q, cur, room, taxes } of p) {
    await pool.query(
      `INSERT INTO charges (id,reservation_id,charge_date,description,department,amount,qty,posted_by,
         unit_price,base_price,extras,service_id,price_id,list_id,list_name,currency,fx_rate,base_amount,night_audit)
       VALUES ($1,$2,$3,$4,'Rooms',$5,1,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,true)`,
      [uid("chg"), n.res.id, n.date, `Room charge — ${q.type.name} (night audit)`, q.rate, actor,
        q.rate, q.base, jsonOut(q.added), q.serviceId, q.priceId, q.listId, q.list,
        room.currency || cur, room.fxRate, room.baseAmount]
    );
    let base = room.baseAmount === null || room.baseAmount === undefined ? q.rate : room.baseAmount;
    for (const [i, line] of q.taxLines.entries()) {
      const t = taxes[i];
      await pool.query(
        `INSERT INTO charges (id,reservation_id,charge_date,description,department,amount,qty,posted_by,
           tax_rule_id,currency,fx_rate,base_amount,night_audit)
         VALUES ($1,$2,$3,$4,'Taxes & service',$5,1,'System',$6,$7,$8,$9,true)`,
        [uid("chg"), n.res.id, n.date, line.label, line.amount, line.rule.id,
          t.currency || cur, t.fxRate, t.baseAmount]
      );
      base += t.baseAmount === null || t.baseAmount === undefined ? line.amount : t.baseAmount;
    }
    posted.push({
      reservationId: n.res.id, reference: n.res.reference, date: n.date,
      amount: q.rate, tax: q.taxes, currency: cur, baseAmount: base,
    });
  }
  return posted;
}

/**
 * Close the day: post what the audit found, seal the pack, roll the date.
 * Refuses when the day is already signed for, a control is unconfirmed, or a
 * night cannot be valued.
 */
async function run({ propertyId, actor, attest }) {
  const day = await businessDay();
  const already = await closedOn(day);
  if (already) return { error: `${day} was already closed by ${already.by}.` };

  const before = await pack(propertyId);
  const list = checks(before);
  const outstanding = list.filter((c) => !(attest || {})[c.key]);
  if (outstanding.length) {
    return {
      error: "The day stays open until every control is confirmed — outstanding: " +
        outstanding.map((c) => c.title).join(", ") + ".",
    };
  }

  if (before.unbillable.length) {
    return { error: "The night audit cannot post every open night — " + before.unbillable[0].blocked.error };
  }
  const fx = await FX.sources(day);
  const planned = await planNights(before.unbilled, fx);
  if (planned.error) {
    return { error: "The night audit cannot post every open night — " + planned.error };
  }
  const posted = await postNight(planned.plan, fx, actor);

  // Sealed after the posting, so the pack reports the money the audit itself
  // just found rather than the figures that were missing it.
  const sealed = await pack(propertyId);
  const checksBlob = {};
  list.forEach((c) => { checksBlob[c.key] = String(attest[c.key]).slice(0, 500); });

  const closed = {
    date: day,
    rolledTo: addDays(day, 1),
    at: new Date().toISOString(),
    by: actor,
    checks: checksBlob,
    posted,
    // The seal counts in the money of account: a day whose rooms were sold in
    // two monies still has to hand on one set of books.
    postedTotal: posted.reduce((s, x) => s + x.baseAmount, 0),
    stats: {
      occupancy: sealed.metrics.occupancy, adr: sealed.metrics.adr, revpar: sealed.metrics.revpar,
      roomRevenue: sealed.metrics.roomRevenue, charges: sealed.chargesTotal,
      payments: sealed.paymentsTotal, balance: sealed.metrics.balanceDue,
      open: sealed.unresolved.length, arrivals: sealed.arrivals.length, departures: sealed.departures.length,
    },
  };
  await pool.query(
    `INSERT INTO closed_days (date,rolled_to,closed_at,closed_by,checks,posted,posted_total,stats)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [closed.date, closed.rolledTo, closed.at, closed.by, jsonOut(closed.checks), jsonOut(closed.posted),
      closed.postedTotal, jsonOut(closed.stats)]
  );
  await setBusinessDay(closed.rolledTo);
  await log({
    propertyId, actor, action: "closed the day", entity: "night audit",
    detail: `${day} · room revenue ${closed.stats.roomRevenue} · ${posted.length} unbilled ` +
      `night${posted.length === 1 ? "" : "s"} posted for ${closed.postedTotal} · date rolled to ${closed.rolledTo}`,
  });
  return { closed, posted, rolledTo: closed.rolledTo };
}

async function closedDays(limit) {
  const n = Math.min(365, Math.max(1, Number(limit) || 30));
  const { rows } = await pool.query(`SELECT * FROM closed_days ORDER BY date DESC LIMIT ${n}`);
  return rows.map((r) => ({
    date: dstr(r.date), rolledTo: dstr(r.rolled_to), at: r.closed_at, by: r.closed_by,
    checks: jsonIn(r.checks, {}), posted: jsonIn(r.posted, []),
    postedTotal: Number(r.posted_total), stats: jsonIn(r.stats, {}),
  }));
}

module.exports = { pack, checks, run, closedDays, unbilledNights, unbillableNights, nights };
