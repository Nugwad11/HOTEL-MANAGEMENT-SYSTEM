/**
 * The guest portal's own doors (PRD 6.14) — the API port of LHMS.guestPortal.
 *
 * A guest is not a staff member with fewer ticks: the portal is entered through
 * `/api/auth/guest`, and the doors below ask who the token belongs to and which
 * stay that guest is living. Every figure still goes through the same folio,
 * price and currency doors the desks use — the portal is another pair of hands on
 * the same books, never a second set of rules.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const P = require("../lib/price");
const FX = require("../lib/fx");
const BOOKING = require("../lib/booking");
const biz = require("../lib/business-date");
const folio = require("../lib/folio");
const LOY = require("../lib/loyalty");
const { jsonIn, jsonOut, uid } = require("../lib/json");

const router = Router();

// Every door below belongs to the portal, so the token is checked before any of
// them runs — an express middleware registered after the routes would not run.
router.use(authenticate);

const NO_STAY   = "We could not find an active stay for this account.";
const NO_GUEST  = "Sign in with your guest account to use the portal.";
const NO_PROFILE = "We could not load your guest profile. Please see the front desk.";

/* ── the stay the portal speaks for ─────────────────────────── */

/**
 * The browser's `inHouseFor()`: a stay in house, or a confirmed arrival whose
 * day has begun — a guest checks in digitally from inside the portal, so the
 * booking has to be reachable on the arrival day, not the morning after.
 */
async function liveStays(guestId) {
  const day = await biz.businessDay();
  const { rows } = await pool.query(
    `SELECT r.*, rm.number AS room_number, rt.name AS room_type_name, rp.name AS rate_plan_name
     FROM reservations r
     LEFT JOIN rooms rm      ON rm.id = r.room_id
     LEFT JOIN room_types rt ON rt.id = r.room_type_id
     LEFT JOIN rate_plans rp ON rp.id = r.rate_plan_id
     WHERE r.guest_id = $1
       AND (r.status = 'In-house' OR (r.status = 'Confirmed' AND r.check_in <= $2 AND r.check_out > $2))
     ORDER BY r.check_in ASC`,
    [guestId, day]
  );
  return rows;
}

/** In house before a booking still ahead of it, then the property being asked about. */
function pickStay(stays, propertyId) {
  const sorted = stays.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status === "In-house" ? -1 : 1;
    const x = biz.dstr(a.check_in), y = biz.dstr(b.check_in);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return (propertyId && sorted.find((s) => s.property_id === propertyId)) || sorted[0] || null;
}

function profile(row) {
  return {
    id: row.id, name: row.name, email: row.email, phone: row.phone, tier: row.tier,
    since: row.since, language: row.language || "English",
    preferences: jsonIn(row.preferences, {}), consent: jsonIn(row.consent, {}),
    loyaltyPoints: Number(row.loyalty_pts) || 0,
  };
}

function stayCard(s) {
  return {
    id: s.id, reference: s.reference, propertyId: s.property_id, status: s.status,
    roomId: s.room_id, roomNumber: s.room_number || null,
    roomType: s.room_type_name || null, ratePlan: s.rate_plan_name || null,
    checkIn: biz.dstr(s.check_in), checkOut: biz.dstr(s.check_out),
    adults: Number(s.adults) || 1, children: Number(s.children) || 0,
    eta: s.eta || "", notes: s.notes || "", mobileKey: !!s.mobile_key,
  };
}

/**
 * Who is speaking, and which stay they are living. The stay is chosen by the
 * guest the token belongs to, so a portal can never be pointed at somebody
 * else's reservation — the browser's cross-stay refusal cannot be reached here
 * because the query it is written against cannot return another guest's stay.
 */
async function portal(req) {
  if (!req.user.guestId) return { error: NO_GUEST };
  const { rows } = await pool.query(`SELECT * FROM guests WHERE id = $1`, [req.user.guestId]);
  if (!rows[0]) return { error: NO_PROFILE };
  const guest = rows[0];
  const stay = pickStay(await liveStays(guest.id), req.user.propertyId);
  return { guest: profile(guest), stay: stay ? stayCard(stay) : null, stayRow: stay };
}

/** The doors that bill, issue a key or a room need a stay to act on. */
async function authorised(req) {
  const ctx = await portal(req);
  if (ctx.error) return ctx;
  if (!ctx.stay) return { error: NO_STAY };
  return ctx;
}

/** The desk's board reads a guest request as a notification, exactly as the browser's portal raises one. */
async function notify({ propertyId, type, title, detail, link }) {
  await pool.query(
    `INSERT INTO notifications (id,property_id,type,title,detail,link,read) VALUES ($1,$2,$3,$4,$5,$6,false)`,
    [uid("ntf"), propertyId, type, title, detail, link]
  );
}

/** The minutes a card is owned in, turned into the moment it is owed by. */
const dueIn = (mins) => new Date(Date.now() + (Number(mins) || 0) * 60000).toISOString();

/* ── the stay, the folio, the requests ──────────────────────── */

/** GET /api/guest/stay — everything the Stay tab shows for one round trip. */
router.get("/stay", async (req, res, next) => {
  try {
    const ctx = await portal(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const day = await biz.businessDay();

    let folioOut = null, pending = 0;
    if (ctx.stay) {
      folioOut = await folio.read(ctx.stay.id);
      pending = await LOY.pending(ctx.stay.id);
    }
    const { rows: upcoming } = await pool.query(
      `SELECT r.*, rt.name AS room_type_name, p.short AS property_short
       FROM reservations r
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
       LEFT JOIN properties p  ON p.id = r.property_id
       WHERE r.guest_id = $1 AND r.status = 'Confirmed' AND r.check_in > $2
       ORDER BY r.check_in ASC`,
      [ctx.guest.id, day]
    );
    // Each booking is printed in the money its own folio is kept in — a past stay
    // in Accra and one in Lagos are two different moneys.
    const books = [];
    for (const u of upcoming) books.push({ ...stayCard(u), folio: await folio.read(u.id) });

    const { rows: open } = await pool.query(
      `SELECT COUNT(*) AS n FROM tasks WHERE guest_id = $1 AND source = 'Guest app' AND status <> 'Done'`,
      [ctx.guest.id]
    );
    res.json({
      guest: ctx.guest, stay: ctx.stay, folio: folioOut, pointsPending: pending,
      upcoming: books, openRequests: Number(open[0].n),
    });
  } catch (err) { next(err); }
});

/** GET /api/guest/folio */
router.get("/folio", async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    res.json(await folio.read(ctx.stay.id));
  } catch (err) { next(err); }
});

/** GET /api/guest/requests — the concierge thread, this guest's own. */
router.get("/requests", async (req, res, next) => {
  try {
    if (!req.user.guestId) return res.status(422).json({ error: NO_GUEST });
    const { rows } = await pool.query(
      `SELECT * FROM tasks WHERE guest_id = $1 AND source = 'Guest app'
       ORDER BY created_at DESC LIMIT 100`,
      [req.user.guestId]
    );
    res.json(rows);
  } catch (err) { next(err); }
});

const RequestSchema = z.object({
  // A blank and an absent title are the same nothing, and both get the sentence
  // the page shows rather than zod's own "Required".
  title:    z.string().min(1, "Describe what you need.").default(""),
  detail:   z.string().default(""),
  priority: z.enum(["High", "Normal", "Low"]).default("Normal"),
  slaMins:  z.number().int().min(5).default(30),
});

/**
 * POST /api/guest/requests — the port of `guestPortal.request()`. The request
 * carries the room it came from and the minutes the team owns it in, and lands on
 * the same board the desk works from.
 */
router.post("/requests", validate(RequestSchema), async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const d = req.data;
    const id = uid("tsk");
    const { rows } = await pool.query(
      `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,priority,status,source,sla_mins,due_at)
       VALUES ($1,$2,'Guest request',$3,$4,$5,$6,$7,'Open','Guest app',$8,$9)
       RETURNING *`,
      [id, ctx.stayRow.property_id, d.title.trim(), d.detail.trim(), ctx.stayRow.room_id,
       ctx.guest.id, d.priority, d.slaMins, dueIn(d.slaMins)]
    );
    await notify({
      propertyId: ctx.stayRow.property_id, type: "Guest request", title: d.title.trim(),
      detail: (ctx.stayRow.room_number ? `Room ${ctx.stayRow.room_number} · ` : "") +
        `guest app · respond within ${d.slaMins} min`,
      link: "#/requests",
    });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
});

/* ── orders (PRD 6.5 / 6.6) ─────────────────────────────────── */

const LineSchema = z.object({ id: z.string(), qty: z.number().int().min(0) });
const OrderSchema = z.object({
  lines: z.union([z.array(LineSchema), z.record(z.number().int().min(0))]).default([]),
  when:  z.string().default(""),
  notes: z.string().default(""),
});

function toRows(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Object.keys(input).map((id) => ({ id, qty: input[id] }));
}

/**
 * POST /api/guest/orders — the portal onto the price engine and the folio's one
 * door. A page sends items and quantities only: an item that is not on the menu,
 * one nobody is selling, a mix of monies or a folio kept in another money all
 * refuse the whole order before a single line is written.
 */
router.post("/orders", validate(OrderSchema), async (req, res, next) => {
  const d = req.data;
  const rows = toRows(d.lines).filter((l) => Number(l.qty) > 0);
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    if (!rows.length) return res.status(422).json({ error: "Choose at least one item." });

    const stay = ctx.stayRow;
    const day = await biz.businessDay();
    const cat = await P.catalogue();

    const priced = [];
    for (const line of rows) {
      const svc = P.serviceOf(cat, "restaurant", line.id);
      if (!svc) return res.status(422).json({ error: "That item is no longer on the menu." });
      const hit = svc.active ? P.resolve(cat.prices, cat.lists, svc.id, { date: day }) : null;
      if (!hit) return res.status(422).json({ error: `${svc.name} is not being sold right now.` });
      const value = P.amount(hit.price, svc, { date: day, qty: Number(line.qty) });
      priced.push({ svc, qty: Number(line.qty), price: hit.price, list: hit.list, value });
    }

    const mix = FX.oneCurrency(await FX.baseCode(stay.property_id), priced.map((p) => ({ currency: p.price.currency })));
    if (mix.error) return res.status(422).json({ error: mix.error });
    const fit = await FX.folioCurrency(stay.id, mix.code);
    if (fit.error) return res.status(422).json({ error: fit.error });

    const first = priced[0].svc.outlet || null;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const charges = [];
      for (const p of priced) {
        const out = await folio.postCharge({
          client, reservationId: stay.id, propertyId: stay.property_id, date: day,
          postedBy: "Guest app", currency: p.price.currency,
          description: `${p.qty > 1 ? p.qty + " × " : ""}${p.svc.name}` +
            (p.svc.outlet ? ` · ${p.svc.outlet.name}` : ""),
          department: p.svc.outlet ? p.svc.outlet.dept : "Other",
          amount: p.value.lines, qty: p.qty, unitPrice: p.value.unit, extras: p.value.added,
          serviceId: p.svc.id, priceId: p.price.id, listId: p.list.id, listName: p.list.name,
        });
        if (out.error) { await client.query("ROLLBACK"); return res.status(422).json({ error: out.error }); }
        charges.push(out.charge);
      }
      // One request for the department, not one per line — the team that plates
      // the tray needs the whole order on a single card.
      const total = charges.reduce((s, c) => s + Number(c.amount), 0);
      const title = `${(first && first.name) || "Order"} — ` +
        priced.map((p) => `${p.qty} × ${p.svc.name}`).join(", ");
      const detail = (d.when ? `Serve by ${d.when}. ` : "") +
        (d.notes.trim() || "Ordered from the guest app.") +
        ` Posted to the folio: ${charges[0].currency} ${total.toLocaleString("en-NG")}.`;
      const slaMins = (first && first.sla) || 30;
      const { rows: task } = await client.query(
        `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,priority,status,source,sla_mins,due_at)
         VALUES ($1,$2,'Guest request',$3,$4,$5,$6,'Normal','Open','Guest app',$7,$8)
         RETURNING *`,
        [uid("tsk"), stay.property_id, title, detail, stay.room_id, ctx.guest.id, slaMins, dueIn(slaMins)]
      );
      await client.query(
        `INSERT INTO notifications (id,property_id,type,title,detail,link,read) VALUES ($1,$2,$3,$4,$5,'#/requests',false)`,
        [uid("ntf"), stay.property_id, "Guest request", title,
          `${stay.room_number ? "Room " + stay.room_number + " · " : ""}guest app · respond within ${slaMins} min`]
      );
      await client.query("COMMIT");
      res.status(201).json({
        charges, total, currency: charges[0].currency, task: task[0],
        outlet: first ? first.name : null, stay: ctx.stay, folio: await folio.read(stay.id),
      });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

/* ── a new booking (PRD 6.14) ───────────────────────────────── */

const BookingSchema = z.object({
  // Dates the portal may leave blank — an empty arrival is today and an empty
  // departure is one night on — but nothing in a shape nobody can book.
  propertyId: z.string().default(""),
  roomTypeId: z.string().default(""),
  ratePlanId: z.string().default(""),
  checkIn:    z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).default(""),
  checkOut:   z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal("")]).default(""),
  adults:     z.number().int().min(1).default(1),
  children:   z.number().int().min(0).default(0),
  eta:        z.string().default(""),
  notes:      z.string().default(""),
});

/** The quote as a page reads it: the nights, the money, and what each figure is. */
function quoteView(q) {
  if (!q) return null;
  return {
    roomType: q.type.name, ratePlan: q.plan.name, nights: q.nights, currency: q.currency,
    nightly: q.nightly.map((n) => ({
      date: n.date, rate: n.rate, base: n.base, uplift: n.uplift,
      added: n.added, currency: n.currency, list: n.list,
    })),
    roomTotal: q.roomTotal, extras: q.extras,
    taxLines: q.taxLines.map((l) => ({ label: l.label, amount: l.amount })),
    taxes: q.taxes, service: q.service, vat: q.vat, total: q.total, deposit: q.deposit,
  };
}

/**
 * POST /api/guest/bookings — the port of `guestPortal.book()`, straight onto the
 * desk's own booking door.
 *
 * The portal is a pair of hands that cannot name money: the guest it books for is
 * the profile the token belongs to, the channel is Direct, the source is Guest
 * app and nothing is prepaid, whatever the request claims to send. The refusals
 * are the page's own list, taken in its order, and every figure comes from the
 * same stay quote the counter reads — so a guest is never shown a price for
 * something the desk would refuse to book, or billed one the walk-in beside them
 * would not pay.
 */
router.post("/bookings", validate(BookingSchema), async (req, res, next) => {
  try {
    // A booking needs an identity, not a stay: a guest with nothing in house has
    // to be able to start one, so this door asks for the profile rather than the
    // live arrival the billing doors insist on.
    const ctx = await portal(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });

    const day = await biz.businessDay();
    const d = req.data;
    const draft = {
      propertyId: d.propertyId || req.user.propertyId || "",
      roomTypeId: d.roomTypeId,
      ratePlanId: d.ratePlanId,
      checkIn: d.checkIn || day,
      checkOut: d.checkOut || biz.addDays(d.checkIn || day, 1),
      adults: d.adults,
      children: d.children,
      eta: d.eta,
      notes: d.notes.trim(),
    };

    const [cat, fx] = await Promise.all([P.catalogue(), FX.sources(day)]);
    const type = cat.roomTypes.find((t) => t.id === draft.roomTypeId) || null;
    const { rows: hotel } = await pool.query(`SELECT id FROM properties WHERE id = $1`, [draft.propertyId]);
    const quote = type
      ? P.stayQuote(cat, draft.roomTypeId, draft.ratePlanId, draft.checkIn, draft.checkOut,
        draft.adults, { propertyId: draft.propertyId, fx })
      : null;

    const errs = [];
    if (!hotel.length) errs.push("Choose which hotel you are staying at.");
    if (!type) errs.push("Choose a room type.");
    if (!cat.ratePlans.some((p) => p.id === draft.ratePlanId)) errs.push("Choose a rate plan.");
    if (draft.checkIn < day) errs.push("Your arrival date is in the past.");
    if (biz.nights(draft.checkIn, draft.checkOut) < 1) errs.push("Departure has to be after arrival.");
    if (type && draft.adults + draft.children > Number(type.occupancy)) {
      errs.push(`${type.name} sleeps ${type.occupancy}. Reduce the party or choose a suite.`);
    }
    if (type && !quote) {
      errs.push(`${type.name} has no rate on sale for those dates. Try another room type or different dates.`);
    }
    if (errs.length) return res.status(422).json({ error: errs[0] });

    // One question, asked the same way the live quote panel asks it: nothing free
    // is a refusal to book, not a booking that waits for a room.
    const soldOut = `No ${type.name} is free from ${biz.pretty(draft.checkIn)}. Try different dates.`;
    const out = await BOOKING.open(Object.assign(draft, {
      guestId: ctx.guest.id, channel: "Direct", source: "Guest app",
      deposit: 0, actor: "Guest app", soldOutError: soldOut,
    }));
    if (out.error) return res.status(422).json({ error: out.error });

    const { rows: room } = await pool.query(`SELECT number FROM rooms WHERE id = $1`, [out.res.room_id]);
    res.status(201).json({
      booking: stayCard(Object.assign({}, out.res, {
        room_number: room[0] ? room[0].number : null,
        room_type_name: quote.type.name, rate_plan_name: quote.plan.name,
      })),
      quote: quoteView(quote),
      folio: out.folio,
    });
  } catch (err) { next(err); }
});

/* ── arrival and departure ──────────────────────────────────── */

const CheckInSchema = z.object({
  eta:       z.string().default(""),
  mobileKey: z.boolean().default(true),
});

/** POST /api/guest/check-in — express check-in, the desk's own writes. */
router.post("/check-in", validate(CheckInSchema), async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const stay = ctx.stayRow;
    if (stay.status !== "Confirmed") {
      return res.status(422).json({ error: "You are already checked in — your key is on the Stay tab." });
    }
    const d = req.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE reservations SET status='In-house', checked_in_at=now(), eta=$2, mobile_key=$3,
                key_issued_at = CASE WHEN $3 THEN now() ELSE NULL END
         WHERE id = $1`,
        [stay.id, d.eta, !!d.mobileKey]
      );
      if (stay.room_id) {
        await client.query(`UPDATE rooms SET hk_status='Occupied' WHERE id = $1`, [stay.room_id]);
      }
      await client.query(
        `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'checked in','reservation',$4)`,
        [uid("act"), stay.property_id, ctx.guest.name, stay.reference]
      );
      await client.query(
        `INSERT INTO notifications (id,property_id,type,title,detail,link,read) VALUES ($1,$2,$3,$4,$5,$6,false)`,
        [uid("ntf"), stay.property_id, "Guest checked in", `${ctx.guest.name} is now in Room ${stay.room_number || ""}`,
          `${stay.reference} · ${biz.dstr(stay.check_out)} departure`, "#/folio/" + stay.id]
      );
      await client.query("COMMIT");
      const { rows } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [stay.id]);
      res.json({ stay: stayCard({ ...rows[0], room_number: stay.room_number, room_type_name: stay.room_type_name, rate_plan_name: stay.rate_plan_name }), key: !!d.mobileKey });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

/**
 * POST /api/guest/check-out — nothing departs with money owing. The desk's door
 * can settle on the way out when the manager asks it to; the portal cannot, it
 * sends the guest to the settlement door first.
 */
router.post("/check-out", async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const stay = ctx.stayRow;
    if (stay.status !== "In-house") {
      return res.status(422).json({ error: "You are not currently checked in." });
    }
    const f = await folio.read(stay.id);
    if (f.balance > 0) {
      return res.status(422).json({
        error: `Your folio has an outstanding balance of ${f.currency} ${f.balance.toLocaleString("en-NG")}. Settle it to depart.`,
        balance: f.balance, currency: f.currency,
      });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`UPDATE reservations SET status='Checked out', checked_out_at=now() WHERE id = $1`, [stay.id]);
      if (stay.room_id) {
        await client.query(`UPDATE rooms SET hk_status='Dirty' WHERE id = $1`, [stay.room_id]);
        await client.query(
          `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,priority,status,source,sla_mins,due_at)
           VALUES ($1,$2,'Departure clean',$3,'Guest checked out. Full turnover before next arrival.',$4,$5,'High','Open','Front desk',60,$6)`,
          [uid("tsk"), stay.property_id, `Departure clean — Room ${stay.room_number || stay.room_id}`,
           stay.room_id, stay.guest_id, dueIn(60)]
        );
      }
      await client.query(
        `INSERT INTO activity_log (id,property_id,actor,action,entity,detail) VALUES ($1,$2,$3,'checked out','reservation',$4)`,
        [uid("act"), stay.property_id, ctx.guest.name, stay.reference]
      );
      // The award travels inside the departure that earned it, exactly as the
      // desk's check-out carries it.
      const earned = await LOY.award(client, { stay, baseTotal: f.baseTotal, actor: ctx.guest.name });
      await client.query("COMMIT");
      res.json({ stay: stayCard({ ...stay, status: "Checked out" }), points: earned.points, folio: f });
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

/* ── settlement ─────────────────────────────────────────────── */

const SettleSchema = z.object({
  confirm: z.boolean().default(false),
  method:  z.enum(["Card", "Bank transfer"]).default("Card"),
});

/**
 * POST /api/guest/payments — the guest settles what the folio owes, in the money
 * the folio is kept in. The amount is never taken from the request: a portal that
 * lets a guest decide what they owe is not a settlement door.
 */
router.post("/payments", validate(SettleSchema), async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const f = await folio.read(ctx.stay.id);
    if (f.balance <= 0) return res.status(422).json({ error: "There is nothing outstanding on your folio." });
    if (!req.data.confirm) {
      return res.status(422).json({ error: `Confirm the charge to settle ${f.currency} ${f.balance.toLocaleString("en-NG")}.` });
    }
    const out = await folio.takePayment({
      reservationId: ctx.stay.id, propertyId: ctx.stayRow.property_id,
      amount: f.balance, method: req.data.method, takenBy: "Guest app", currency: f.currency,
    });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json({ payment: out.payment, folio: await folio.read(ctx.stay.id) });
  } catch (err) { next(err); }
});

/* ── loyalty ────────────────────────────────────────────────── */

const RedeemSchema = z.object({
  // No floor on the schema: "Redeem at least 2,000 points" is the club's own
  // sentence and the portal reads it from the ledger, as the desk does.
  points: z.number().int(),
});

/** POST /api/guest/redeem */
router.post("/redeem", validate(RedeemSchema), async (req, res, next) => {
  try {
    const ctx = await authorised(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const out = await LOY.redeem({
      reservationId: ctx.stay.id, points: req.data.points, postedBy: "Guest app",
    });
    if (out.error) return res.status(422).json({ error: out.error });
    res.status(201).json({
      points: out.points, credit: out.credit, charge: out.charge,
      guest: { ...ctx.guest, loyaltyPoints: Number(out.guest.loyalty_pts) },
      folio: await folio.read(ctx.stay.id),
    });
  } catch (err) { next(err); }
});

/* ── personalization ────────────────────────────────────────── */

const PREF_FIELDS = ["pillow", "room", "dietary", "allergies", "beverage", "newspaper", "turndown"];

const PrefSchema = z.object(PREF_FIELDS.reduce((m, k) => {
  m[k] = z.string().optional();
  return m;
}, { marketing: z.boolean().optional() }));

/**
 * PATCH /api/guest/preferences — the profile card. Only the seven fields the
 * portal offers are taken, and only the marketing consent the guest ticks.
 *
 * The browser's card posts the whole form every time, so a blank there means "no".
 * A PATCH names what it changes, so a field the request left out is left alone —
 * a card that saved the pillow choice and quietly revoked the guest's marketing
 * consent on the way would be rewriting the profile the guest never touched.
 */
router.patch("/preferences", validate(PrefSchema), async (req, res, next) => {
  try {
    const ctx = await portal(req);
    if (ctx.error) return res.status(422).json({ error: ctx.error });
    const prefs = {};
    for (const key of PREF_FIELDS) {
      const v = req.data[key];
      if (v !== undefined && v !== null && String(v).trim()) prefs[key] = String(v).trim();
    }
    const consent = req.data.marketing === undefined ? {} : { marketing: !!req.data.marketing };
    // The card is read, the answers folded in and the result written back, so a
    // field the request did not name keeps the value the guest gave it.
    const { rows: here } = await pool.query(`SELECT preferences, consent FROM guests WHERE id = $1`, [ctx.guest.id]);
    if (!here[0]) return res.status(404).json({ error: "Guest profile not found." });
    const { rows } = await pool.query(
      `UPDATE guests SET preferences = $2, consent = $3 WHERE id = $1 RETURNING *`,
      [ctx.guest.id,
        jsonOut(Object.assign({}, jsonIn(here[0].preferences, {}), prefs)),
        jsonOut(Object.assign({}, jsonIn(here[0].consent, {}), consent))]
    );
    if (!rows[0]) return res.status(404).json({ error: "Guest profile not found." });
    res.json({ guest: profile(rows[0]) });
  } catch (err) { next(err); }
});

module.exports = router;
