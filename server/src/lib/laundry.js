/**
 * Taking a laundry order — the API port of `LHMS.actions.createLaundryOrder`.
 *
 * One door takes the washing, whoever asks for it: the Housekeeping board, the
 * desk that rang it in on a guest's behalf, and the seed that opens a trading
 * day with work already on the rail. The desk sends services and quantities and
 * nothing else — the money is the engine's, every line is posted to the stay's
 * folio through the same door a charge typed at the desk uses, and the order
 * keeps the figures it was sold on. An order that accepted a total from the
 * caller would be a bill the folio, the board and the reports had no way to
 * agree with one another.
 *
 * Every read is made on the caller's connection when it has one: the seed takes
 * its orders inside the transaction that opened the stays they bill, and a
 * pooled read would quote them off a board it cannot see yet.
 */
const pool = require("../db/pool");
const FX = require("./fx");
const biz = require("./business-date");
const P = require("./price");
const folio = require("./folio");
const { rowBase } = require("./finance");
const { log } = require("./log");
const { jsonIn, jsonOut, uid } = require("./json");

const TAX_DEPT = "Taxes & service";
const STAGES = ["Received", "In progress", "Ready", "Collected"];

const HEAD = `SELECT lo.*, g.name AS guest_name, rm.number AS room_number
   FROM laundry_orders lo
   LEFT JOIN guests g ON g.id = lo.guest_id
   LEFT JOIN rooms  rm ON rm.id = lo.room_id`;

/**
 * The board's read: each order with the guest, the room and the lines it was
 * posted on, in the order they were quoted. The lines travel as rows rather than
 * as one aggregated column because the money path keys on them line by line — a
 * void has to find each one it owns.
 */
async function withLines(rows, client) {
  if (!rows.length) return [];
  const db = client || pool;
  const params = rows.map((r) => r.id);
  const { rows: items } = await db.query(
    `SELECT * FROM laundry_items WHERE order_id IN (${params.map((_, i) => `$${i + 1}`).join(",")})
     ORDER BY sort_order, id`, params);
  const by = {};
  items.forEach((i) => {
    (by[i.order_id] = by[i.order_id] || []).push(Object.assign({}, i, { added: jsonIn(i.added, []) }));
  });
  return rows.map((r) => Object.assign({}, r, {
    tax_lines: jsonIn(r.tax_lines, []), items: by[r.id] || [],
  }));
}

async function orderBy(id, client) {
  const db = client || pool;
  const { rows } = await db.query(`${HEAD} WHERE lo.id = $1`, [id]);
  return rows[0] ? (await withLines(rows, db))[0] : null;
}

/** A form may send choices as a map of id → quantity or as rows; both mean the
    same thing, and the engine works in rows. */
function toRows(input) {
  if (!input) return [];
  if (Array.isArray(input)) return input;
  return Object.keys(input).map((id) => ({ id, qty: input[id] }));
}

/** The face total of a set of folio lines. */
function sumBy(charges) {
  return charges.reduce((s, c) => s + Number(c.amount), 0);
}

/** What the same lines are worth on the books, at the rate each was stamped at. */
function baseBy(charges) {
  return charges.reduce((s, c) => s + rowBase(c), 0);
}

/**
 * Take an order.
 *
 * `o.client` is the connection it is written on (the seed's transaction, or the
 * route's); `o.actor` is whose name sits under it; `o.day` is the business day
 * the lines are dated and the quote is priced at; `o.sees` is the caller's own
 * boundary, asked of the property that keeps the stay rather than the one the
 * caller named. Refusals come back as `{ status, error }` — nothing written, no
 * trail line left behind.
 */
async function create(o) {
  const db = o.client || pool;
  const rows = toRows(o.items);

  const { rows: stays } = await db.query(`SELECT * FROM reservations WHERE id = $1`, [o.reservationId]);
  const stay = stays[0] || null;
  if (!stay) return { status: 422, error: "Choose the guest the washing belongs to." };
  if (stay.status !== "In-house" && stay.status !== "Confirmed") {
    return { status: 422, error: "Laundry is only taken for a guest staying with us." };
  }
  if (o.sees && !o.sees(stay.property_id)) {
    return { status: 403, error: "Access to this property is not permitted." };
  }

  const day = o.day || await biz.businessDay(db);
  const [cat, src] = await Promise.all([P.catalogue(db), FX.sources(day, db)]);
  // Every row has to be a service the laundry is listed under at all; one that
  // is not is a mistake in the order form, not an item to price.
  for (const line of rows) {
    if (!P.serviceOf(cat, "laundry", line.id)) {
      return { status: 422, error: "That item is not one of our laundry services." };
    }
  }
  const quote = P.laundryQuote(cat, rows, {
    propertyId: stay.property_id, fx: src, express: !!o.express, date: day,
  });
  if (!quote) return { status: 422, error: "Choose at least one service that is being offered." };
  // One order is one money. The quote groups the lines that share it and names
  // the ones it had to leave out; an order refuses a mixed list rather than
  // quietly dropping a garment the desk rang in.
  if (quote.skipped.length) {
    const mix = FX.oneCurrency(await FX.baseCode(stay.property_id, db), quote.lines.concat(quote.skipped));
    if (mix.error) return { status: 422, error: mix.error };
  }
  // A row the quote could not value — taken out of sale, or priced on a list
  // that has expired — is refused with the rest. Pricing only the rows that
  // survived would bill the guest for less than the desk rang in.
  if (quote.lines.length + quote.skipped.length !== rows.length) {
    const kept = {};
    quote.lines.concat(quote.skipped).forEach((l) => { kept[l.serviceId] = true; });
    const lost = rows.map((r) => P.serviceOf(cat, "laundry", r.id)).find((svc) => !kept[svc.id]);
    return { status: 422, error: `${(lost && lost.name) || "That item"} is not being offered right now.` };
  }
  // The folio the washing lands on is kept in one currency, so the order has to
  // agree with it before a single line is written.
  const fit = await FX.folioCurrency(stay.id, quote.currency, db);
  if (fit.error) return { status: 422, error: fit.error };

  const id = uid("lda");
  // A reference like LD-0042, numbered per property off the orders on file.
  const { rows: cnt } = await db.query(
    `SELECT COUNT(*)+1 AS n FROM laundry_orders WHERE property_id = $1`, [stay.property_id]);
  const ref = "LD-" + String(Number(cnt[0].n)).padStart(4, "0");

  const items = [];
  for (const line of quote.lines) {
    const out = await folio.postCharge({
      client: db, reservationId: stay.id, propertyId: stay.property_id, date: day,
      postedBy: o.actor, currency: line.currency,
      description: `${Number(line.qty) > 1 ? line.qty + " × " : ""}${line.name}`,
      department: "Other", amount: line.amount, qty: line.qty,
      unitPrice: line.unitPrice, basePrice: line.basePrice, extras: line.added,
      serviceId: line.serviceId, priceId: line.priceId, listId: line.listId,
      listName: line.listName,
    });
    if (out.error) return { status: 422, error: out.error };
    items.push({ line, charge: out.charge });
  }
  const taxes = [];
  for (const t of quote.taxLines) {
    const out = await folio.postCharge({
      client: db, reservationId: stay.id, propertyId: stay.property_id, date: day,
      postedBy: "System", currency: items[0].charge.currency,
      description: `${t.label} — laundry ${ref}`, department: TAX_DEPT,
      amount: t.amount, qty: 1, taxRuleId: t.ruleId,
    });
    if (out.error) return { status: 422, error: out.error };
    taxes.push({ ruleId: t.ruleId, label: t.label, amount: t.amount, charge: out.charge });
  }

  // The order carries what the folio was charged, line for line: the figures on
  // the board and the figures on the account are the same rows, not two readings
  // of them.
  const all = items.map((i) => i.charge).concat(taxes.map((t) => t.charge));
  const taxRows = taxes.map((t) => ({
    ruleId: t.ruleId, label: t.label, amount: t.amount, chargeId: t.charge.id,
  }));
  const { rows: room } = await db.query(`SELECT number FROM rooms WHERE id = $1`, [stay.room_id]);
  const dueAt = new Date(Date.now() + quote.etaMins * 60000).toISOString();
  await db.query(
    `INSERT INTO laundry_orders
       (id,property_id,ref,reservation_id,guest_id,room_id,room_number,status,express,notes,
        subtotal,tax,tax_lines,total,currency,fx_rate,base_amount,due_at,created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Received',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
    [id, stay.property_id, ref, stay.id, stay.guest_id, stay.room_id,
      (room[0] && room[0].number) || "", !!o.express, o.notes || "",
      sumBy(items.map((i) => i.charge)), sumBy(taxes.map((t) => t.charge)), jsonOut(taxRows),
      sumBy(all), items[0].charge.currency, items[0].charge.fx_rate,
      baseBy(all), dueAt, o.actor || "System"]
  );
  for (const [i, { line, charge }] of items.entries()) {
    await db.query(
      `INSERT INTO laundry_items
         (id,order_id,kind,service_id,name,unit,qty,unit_price,base_price,amount,added,
          currency,fx_rate,base_amount,price_id,list_id,list_name,sort_order,charge_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
      [uid("ldi"), id, "laundry", line.serviceId, line.name, line.unit, line.qty,
        line.unitPrice, line.basePrice, line.amount, jsonOut(line.added || []),
        charge.currency, charge.fx_rate, charge.base_amount,
        line.priceId, line.listId, line.listName, i, charge.id]
    );
  }
  await log({
    propertyId: stay.property_id, actor: o.actor || "System", action: "took a laundry order",
    entity: "laundry",
    detail: `${ref} · Room ${room[0] ? room[0].number : ""} · ${items.length} lines · ` +
      `${items[0].charge.currency} ${Math.round(sumBy(all)).toLocaleString("en-NG")}` +
      (o.express ? " · express" : ""),
  }, db);

  return { order: await orderBy(id, db) };
}

module.exports = { create, HEAD, STAGES, TAX_DEPT, toRows, withLines, orderBy };
