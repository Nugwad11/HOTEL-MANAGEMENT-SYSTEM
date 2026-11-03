/**
 * Hall bookings.
 *
 * The desk quotes a hall the same way the browser app does — LHMS.price.hallQuote
 * in assets/store.js — and the booking keeps the figures it was sold on. Nothing
 * here accepts a total from the caller: a price the client typed is a price that
 * can disagree with the folio, the reports and the tax lines.
 */
const { Router } = require("express");
const { z } = require("zod");
const pool = require("../db/pool");
const { authenticate, can } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const FX = require("../lib/fx");
const biz = require("../lib/business-date");
const P = require("../lib/price");
const folio = require("../lib/folio");
const { log } = require("../lib/log");
const { jsonIn, jsonOut, uid } = require("../lib/json");

const router = Router();
router.use(authenticate);

const HALL_DEPT = "Events & Banqueting";
const TAX_DEPT = "Taxes & service";

/**
 * A booking is read as its rows plus the lines it was quoted on, in order. The
 * lines travel as rows rather than as one aggregated column because the money
 * path keys on them line by line — a void has to find each one it owns.
 */
async function attachLines(rows) {
  if (!rows.length) return [];
  const params = rows.map((r) => r.id);
  const { rows: lines } = await pool.query(
    `SELECT * FROM event_lines WHERE event_id IN (${params.map((_, i) => `$${i + 1}`).join(",")})
     ORDER BY sort_order, id`, params);
  const by = {};
  lines.forEach((l) => { (by[l.event_id] = by[l.event_id] || []).push(l); });
  return rows.map((r) => Object.assign({}, r, {
    lines: by[r.id] || [], tax_lines: jsonIn(r.tax_lines, []),
  }));
}

async function eventById(id) {
  const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [id]);
  return rows[0] ? (await attachLines(rows))[0] : null;
}

/** A hall can only be in one place at a time, so the check deliberately spans
    every property rather than stopping at the one the caller is standing in. */
async function hallConflict(hallId, date, start, end, exceptId) {
  const { rows } = await pool.query(
    `SELECT * FROM events WHERE hall_id = $1 AND event_date = $2 AND id <> $3
       AND status NOT IN ('Cancelled','Released')`,
    [hallId, date, exceptId || ""]
  );
  return rows.find((e) => biz.overlaps(start, end, e.start_time, e.end_time)) || null;
}

/** A form may send choices as a map of id → quantity or as rows; both mean the
    same thing and the engine works in rows. */
function toRows(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Object.keys(input).map((id) => ({ id, qty: input[id] }));
}

/** A booking belongs to the property it was taken for; a Manager sees the group. */
function seesProperty(req, pid) {
  return req.user.role === "Manager" || pid === req.user.propertyId;
}

/**
 * The folio lines a confirmed booking owns: the hall and its add-ons, then the
 * taxes the quote carried. Posted through the folio so a booking's money passes
 * the same sealed-day and single-currency tests as a line the desk typed in.
 */
async function postBookingLines(b, client) {
  const ids = [];
  for (const l of b.lines) {
    const out = await folio.postCharge({
      client, eventId: b.id, reservationId: b.reservationId, propertyId: b.propertyId,
      date: b.date, postedBy: b.actor, currency: l.currency,
      description: `${Number(l.qty) > 1 ? l.qty + " × " : ""}${l.name} — ${b.title}`,
      department: HALL_DEPT, amount: Number(l.amount), qty: Number(l.qty),
      unitPrice: Number(l.unit_price), basePrice: Number(l.base_price),
      extras: jsonIn(l.added, null), serviceId: l.service_id,
      priceId: l.price_id, listId: l.list_id, listName: l.list_name,
    });
    if (out.error) return { error: out.error };
    ids.push(out.charge.id);
  }
  for (const t of b.taxLines) {
    const out = await folio.postCharge({
      client, eventId: b.id, reservationId: b.reservationId, propertyId: b.propertyId,
      date: b.date, postedBy: "System", currency: b.currency,
      description: `${t.label} — ${b.title}`, department: TAX_DEPT,
      amount: Number(t.amount), qty: 1, taxRuleId: t.ruleId,
    });
    if (out.error) return { error: out.error };
    ids.push(out.charge.id);
  }
  return { ids };
}

/** Everything the money path needs about a booking, in the shape the stored rows
    are in — a confirmation posts what is on file, not what a screen remembers. */
async function bookingMoney(evt, actor, q) {
  const db = q || pool;
  const { rows: lines } = await db.query(
    `SELECT * FROM event_lines WHERE event_id = $1 ORDER BY sort_order`, [evt.id]
  );
  return {
    id: evt.id, reservationId: evt.reservation_id, propertyId: evt.property_id,
    title: evt.title, date: biz.dstr(evt.event_date), currency: evt.currency, actor,
    lines, taxLines: jsonIn(evt.tax_lines, []),
  };
}

/** GET /api/events?propertyId=&date= */
router.get("/", can("book_events"), async (req, res, next) => {
  try {
    const { propertyId, date, limit = 200 } = req.query;
    const pid = propertyId || req.user.propertyId;
    const params = [pid];
    let sql = `SELECT * FROM events WHERE property_id = $1`;
    if (date) { params.push(date); sql += ` AND event_date = $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY event_date, start_time LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json(await attachLines(rows));
  } catch (err) { next(err); }
});

/* The booking is described, never priced: the engine below decides what the hall
   costs on that date, in that money, with those add-ons. */
const CreateSchema = z.object({
  propertyId:    z.string().optional(),
  hallId:        z.string(),
  title:         z.string().default(""),
  organizer:     z.string().default(""),
  date:          z.string(),
  start:         z.string(),
  end:           z.string(),
  package:       z.enum(["half", "full"]).nullable().optional(),
  status:        z.enum(["Confirmed", "Hold"]).default("Hold"),
  reservationId: z.string().nullable().optional(),
  guests:        z.number().optional(),
  addons:        z.union([z.array(z.any()), z.record(z.number())]).optional(),
  email:         z.string().default(""),
  phone:         z.string().default(""),
  layout:        z.string().default(""),
  notes:         z.string().default(""),
});

/** POST /api/events */
router.post("/", can("book_events"), validate(CreateSchema), async (req, res, next) => {
  const d = req.data;
  const propertyId = d.propertyId || req.user.propertyId;
  if (!seesProperty(req, propertyId)) {
    return res.status(403).json({ error: "Access to this property is not permitted." });
  }
  try {
    const day = await biz.businessDay();
    const [cat, src] = await Promise.all([P.catalogue(), FX.sources(day)]);

    const svc = P.serviceOf(cat, "hall", d.hallId);
    if (!svc || svc.addon || !svc.active) return res.status(422).json({ error: "Choose a hall." });
    const title = String(d.title || "").trim();
    if (!title) return res.status(422).json({ error: "Give the event a name." });
    const organizer = String(d.organizer || "").trim();
    if (!organizer) return res.status(422).json({ error: "Record who the booking is for." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return res.status(422).json({ error: "Choose the event date." });
    if (d.date < day) return res.status(422).json({ error: "An event cannot be booked in the past." });
    const hours = biz.hoursBetween(d.start, d.end);
    if (!hours) {
      return res.status(422).json({ error: "Check the times — the hall must be held for at least an hour." });
    }
    const guests = Math.max(1, Number(d.guests) || 0);
    if (svc.capacity && guests > svc.capacity) {
      return res.status(422).json({ error: `${svc.name} is licensed for ${svc.capacity} guests, not ${guests}.` });
    }
    // Two bookings of the same hall at overlapping times are refused outright;
    // back-to-back slots, which only touch at an endpoint, are allowed.
    const clash = await hallConflict(svc.refId, d.date, d.start, d.end);
    if (clash) {
      return res.status(422).json({
        error: `Clash — ${clash.title} already holds ${svc.name} from ${clash.start_time} to ` +
          `${clash.end_time} on ${biz.pretty(d.date)}.`,
        conflict: clash,
      });
    }
    const quote = P.hallQuote(cat, svc.id, {
      propertyId, fx: src, date: d.date, start: d.start, end: d.end,
      package: d.package || null, addons: toRows(d.addons),
    });
    if (!quote) {
      return res.status(422).json({ error: `There is no active price for ${svc.name} on that date.` });
    }
    let stay = null;
    if (d.reservationId) {
      const { rows } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [d.reservationId]);
      stay = rows[0] || null;
      if (!stay) return res.status(422).json({ error: "The linked reservation no longer exists." });
      // A booking that reaches a folio has to be in the money that folio is kept
      // in, or the balance stops being one number somebody can settle. Asking
      // here refuses the whole booking instead of half-posting lines.
      const fit = await FX.folioCurrency(stay.id, quote.currency);
      if (fit.error) return res.status(422).json({ error: fit.error });
    }

    const sur = quote.price.surcharges || {};
    // A booking linked to a stay is filed on that stay's books, so the money it
    // posts and the folio it posts to are always kept by the same property.
    const home = stay ? stay.property_id : propertyId;
    if (!seesProperty(req, home)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    const byKind = {};
    quote.taxLines.forEach((l) => { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
    const status = d.status === "Hold" ? "Hold" : "Confirmed";
    const taxLines = quote.taxLines.map((l) => ({ ruleId: l.rule.id, label: l.label, amount: l.amount }));

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const id = uid("evt");
      const { rows: header } = await client.query(
        `INSERT INTO events (id,property_id,hall_id,hall_service_id,title,organizer,event_date,start_time,end_time,
           package,package_name,hours,status,reservation_id,contact_email,contact_phone,layout,guests_count,notes,
           subtotal,tax,service_charge,vat,tax_lines,total,currency,fx_rate,base_amount,
           deposit,deposit_pct,deposit_paid,cancel_pct,cancel_hours,cancel_fee,
           price_id,list_id,list_name,created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
                 $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38) RETURNING *`,
        [id, home, svc.refId, svc.id, title, organizer, d.date, d.start, d.end,
          quote.package, quote.packageName, quote.hours, status, stay ? stay.id : null,
          d.email, d.phone, d.layout, guests, d.notes,
          quote.subtotal, quote.tax, byKind.service || 0, byKind.vat || 0, jsonOut(taxLines),
          quote.total, quote.currency, quote.fxRate, quote.baseAmount,
          quote.deposit, quote.depositPct, 0, sur.cancelPct || 0, sur.cancelHours || 0, 0,
          quote.price.id, quote.list.id, quote.list.name, req.user.name]
      );
      const evt = header[0];
      for (const [i, line] of quote.lines.entries()) {
        await client.query(
          `INSERT INTO event_lines (id,event_id,kind,service_id,name,unit,qty,unit_price,base_price,amount,added,
             currency,fx_rate,base_amount,price_id,list_id,list_name,sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [uid("el"), id, line.kind, line.serviceId, line.name, line.unit, line.qty,
            line.unitPrice, line.basePrice, line.amount, jsonOut(line.added || []),
            line.currency, line.fxRate, line.baseAmount,
            line.priceId, line.listId, line.listName, i]
        );
      }
      // A hold reserves the time but agrees no money yet, so nothing reaches the
      // folio until the desk confirms it.
      let posted = [];
      if (status === "Confirmed" && stay) {
        const out = await postBookingLines(await bookingMoney(evt, req.user.name, client), client);
        if (out.error) { await client.query("ROLLBACK"); return res.status(422).json({ error: out.error }); }
        posted = out.ids;
      }
      await client.query("COMMIT");
      await log({
        propertyId: home, actor: req.user.name,
        action: status === "Hold" ? "put a hall on hold" : "booked " + svc.name, entity: "events",
        detail: `${title} · ${biz.pretty(d.date)} ${quote.start}–${quote.end} · ` +
          `${quote.currency} ${Number(quote.total).toLocaleString()}`,
      });
      const event = await eventById(id);
      res.status(201).json({
        event, posted: posted.length > 0, skipped: quote.skipped,
        quote: { subtotal: quote.subtotal, tax: quote.tax, total: quote.total, deposit: quote.deposit },
      });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

/** GET /api/events/:id */
router.get("/:id", can("book_events"), async (req, res, next) => {
  try {
    const evt = await eventById(req.params.id);
    if (!evt) return res.status(404).json({ error: "Booking not found." });
    if (!seesProperty(req, evt.property_id)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    res.json(evt);
  } catch (err) { next(err); }
});

/** POST /api/events/:id/confirm — a hold becomes money. */
router.post("/:id/confirm", can("book_events"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [req.params.id]);
    const held = rows[0];
    if (!held) return res.status(404).json({ error: "Booking not found." });
    if (!seesProperty(req, held.property_id)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (held.status !== "Hold") return res.status(422).json({ error: "Only a hold can be confirmed." });
    const clash = await hallConflict(held.hall_id, biz.dstr(held.event_date), held.start_time, held.end_time, held.id);
    if (clash) return res.status(422).json({ error: `That window has since been taken by ${clash.title}.` });

    let stay = null;
    if (held.reservation_id) {
      const { rows } = await pool.query(`SELECT * FROM reservations WHERE id = $1`, [held.reservation_id]);
      stay = rows[0] || null;
    }
    // The folio may have taken other money while the hall sat on hold, so the
    // same single-currency test runs again at confirmation, before the status —
    // and therefore the money — moves.
    if (stay) {
      const cur = held.currency || await FX.folioCode(stay.id, stay.property_id);
      const fit = await FX.folioCurrency(stay.id, cur);
      if (fit.error) return res.status(422).json({ error: fit.error });
    }

    const b = await bookingMoney(held, req.user.name);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        `UPDATE events SET status = 'Confirmed' WHERE id = $1 AND status = 'Hold' RETURNING *`, [held.id]
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return res.status(422).json({ error: "Only a hold can be confirmed." }); }
      let posted = [];
      if (stay) {
        const out = await postBookingLines(b, client);
        if (out.error) { await client.query("ROLLBACK"); return res.status(422).json({ error: out.error }); }
        posted = out.ids;
      }
      await client.query("COMMIT");
      await log({
        propertyId: held.property_id, actor: req.user.name, action: "confirmed a hall booking", entity: "events",
        detail: `${held.title} · ${held.currency} ${Number(held.total).toLocaleString()}`,
      });
      res.json({ event: rows[0], posted: posted.length > 0 });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

const CancelSchema = z.object({ reason: z.string().default("") });

/** POST /api/events/:id/cancel — the lines come back off the folio, the fee is
    the one the booking was sold on, and the booking itself stays on file. */
router.post("/:id/cancel", can("book_events"), validate(CancelSchema), async (req, res, next) => {
  const reason = String(req.data.reason || "").trim();
  try {
    const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [req.params.id]);
    const evt = rows[0];
    if (!evt) return res.status(404).json({ error: "Booking not found." });
    if (!seesProperty(req, evt.property_id)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (evt.status === "Cancelled") return res.status(422).json({ error: "That booking is already cancelled." });
    if (!reason) return res.status(422).json({ error: "A reason is required — it goes in the audit trail." });

    const day = await biz.businessDay();
    const fee = P.cancellationFee(
      { status: evt.status, cancelPct: evt.cancel_pct, cancelHours: evt.cancel_hours,
        date: biz.dstr(evt.event_date), start: evt.start_time, total: Number(evt.total) },
      day
    );
    const { rows: live } = await pool.query(
      `SELECT id FROM charges WHERE event_id = $1 AND NOT voided`, [evt.id]
    );
    const client = await pool.connect();
    let voided = 0;
    try {
      await client.query("BEGIN");
      // The original lines are voided rather than deleted, so the folio can
      // still be read backwards to what was booked and then taken back.
      for (const c of live) {
        const out = await folio.voidCharge({ client, chargeId: c.id, actor: req.user.name });
        if (out.error) { await client.query("ROLLBACK"); return res.status(422).json({ error: out.error }); }
        voided++;
      }
      let feeCharge = null;
      if (fee > 0 && evt.reservation_id) {
        const out = await folio.postCharge({
          client, eventId: evt.id, reservationId: evt.reservation_id, propertyId: evt.property_id,
          date: day, postedBy: req.user.name, currency: evt.currency,
          description: `Cancellation fee — ${evt.title}`, department: HALL_DEPT,
          amount: fee, qty: 1, unitPrice: fee, basePrice: Number(evt.total),
          serviceId: evt.hall_service_id, priceId: evt.price_id, listId: evt.list_id, listName: evt.list_name,
        });
        if (out.error) { await client.query("ROLLBACK"); return res.status(422).json({ error: out.error }); }
        feeCharge = out.charge;
      }
      const { rows } = await client.query(
        `UPDATE events SET status = 'Cancelled', cancel_fee = $2, cancel_reason = $3, cancelled_at = now()
         WHERE id = $1 AND status <> 'Cancelled' RETURNING *`,
        [evt.id, fee, reason]
      );
      if (!rows[0]) { await client.query("ROLLBACK"); return res.status(422).json({ error: "That booking is already cancelled." }); }
      await client.query("COMMIT");
      await log({
        propertyId: evt.property_id, actor: req.user.name, action: "cancelled a hall booking", entity: "events",
        detail: `${evt.title} · ${reason} · fee ${evt.currency} ${fee.toLocaleString()}` +
          (voided ? ` · ${voided} lines voided` : ""),
      });
      res.json({ event: rows[0], fee, voided, cancellationCharge: feeCharge });
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) { next(err); }
});

const DepositSchema = z.object({ method: z.string().optional() });

/** POST /api/events/:id/deposit */
router.post("/:id/deposit", can("book_events"), validate(DepositSchema), async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM events WHERE id = $1`, [req.params.id]);
    const evt = rows[0];
    if (!evt) return res.status(404).json({ error: "Booking not found." });
    if (!seesProperty(req, evt.property_id)) {
      return res.status(403).json({ error: "Access to this property is not permitted." });
    }
    if (evt.status !== "Confirmed") {
      return res.status(422).json({ error: "Only a confirmed booking takes a deposit." });
    }
    if (Number(evt.deposit_paid) >= Number(evt.deposit)) {
      return res.status(422).json({ error: "The deposit on this booking is already recorded." });
    }
    if (!evt.reservation_id) {
      return res.status(422).json({
        error: "This booking is not on a guest folio, so its deposit is invoiced by the events desk.",
      });
    }
    const deposit = Number(evt.deposit);
    const out = await folio.takePayment({
      reservationId: evt.reservation_id, propertyId: evt.property_id, eventId: evt.id,
      amount: deposit, currency: evt.currency, method: req.data.method || "Transfer", takenBy: req.user.name,
    });
    if (out.error) return res.status(422).json({ error: out.error });
    const { rows: paid } = await pool.query(
      `UPDATE events SET deposit_paid = $2 WHERE id = $1 RETURNING *`, [evt.id, deposit]
    );
    await log({
      propertyId: evt.property_id, actor: req.user.name, action: "took an event deposit", entity: "events",
      detail: `${evt.title} · ${evt.currency} ${deposit.toLocaleString()} · ${out.payment.method}`,
    });
    res.json({ event: paid[0], payment: out.payment });
  } catch (err) { next(err); }
});

module.exports = router;
