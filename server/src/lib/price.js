/**
 * The price engine on the server.
 *
 * Every step mirrors LHMS.priceCore in assets/data.js, so a night audit posts
 * the rate the desk would have posted at the same moment. Two implementations
 * of the same maths is two sets of figures, and nobody reconciles them.
 */
const pool = require("../db/pool");
const { dstr, addDays, nights, hoursBetween, hoursUntil } = require("./business-date");
const { jsonIn, jsonOut, uid } = require("./json");
const FX = require("./fx");

const round50 = (n) => Math.round(n / 50) * 50;

/** Friday and Saturday carry the weekend uplift, the same two days the desk quotes on. */
function isWeekend(date) {
  const w = new Date(dstr(date) + "T12:00:00Z").getUTCDay();
  return w === 5 || w === 6;
}

/* ── the pure core ───────────────────────────────────────────── */

function listFor(lists, date, listId) {
  if (listId) return lists.find((l) => l.id === listId) || null;
  date = date || dstr(new Date());
  const eligible = lists.filter((l) => {
    // A day rate or a negotiated contract is only ever quoted when someone
    // names it — never as the list a room falls back on.
    if (!l.active || l.kind === "day-use" || l.kind === "contract") return false;
    if (l.from && date < l.from) return false;
    if (l.to && date > l.to) return false;
    return true;
  });
  if (!eligible.length) return null;
  return eligible.slice().sort((a, b) => b.priority - a.priority)[0];
}

function resolve(prices, lists, serviceId, opts) {
  opts = Object.assign({ date: dstr(new Date()) }, opts || {});
  const list = listFor(lists, opts.date, opts.listId);
  if (!list) return null;
  const row = prices.find((p) => {
    if (!p.active || p.serviceId !== serviceId || p.listId !== list.id) return false;
    if (opts.date && p.from && opts.date < p.from) return false;
    if (opts.date && p.to && opts.date > p.to) return false;
    return true;
  });
  return row ? { price: row, list } : null;
}

/** The headline amount plus whatever the date or the request adds to it. */
function amount(price, service, opts) {
  opts = Object.assign({ date: dstr(new Date()) }, opts || {});
  const s = price.surcharges || {};
  const n = opts.qty || 1;
  let unit = price.amount;
  if (opts.modifier) unit *= opts.modifier;
  if (opts.date && isWeekend(opts.date) && s.weekendPct) unit *= 1 + s.weekendPct / 100;
  const added = [];
  const extraAdults = service.category === "room" ? Math.max(0, (opts.adults || 0) - (service.occupancy || 0)) : 0;
  if (extraAdults && s.extraAdult) {
    const adultCost = s.extraAdult * extraAdults * n;
    unit += s.extraAdult * extraAdults;
    added.push({ label: "Extra person × " + extraAdults, amount: adultCost });
  }
  if (opts.extraBed && s.extraBed) { unit += s.extraBed; added.push({ label: "Extra bed", amount: s.extraBed * n }); }
  if (opts.earlyCheckIn && s.earlyCheckIn) { unit += s.earlyCheckIn; added.push({ label: "Early check-in", amount: s.earlyCheckIn }); }
  if (opts.lateCheckOut && s.lateCheckOut) { unit += s.lateCheckOut; added.push({ label: "Late check-out", amount: s.lateCheckOut }); }
  if (opts.express && s.expressPct) {
    unit *= 1 + s.expressPct / 100;
    added.push({ label: "Express service", amount: round50(price.amount * s.expressPct / 100) * n });
  }
  return { unit: round50(unit), lines: round50(unit) * n, added, };
}

/**
 * A hall is sold by the hour or as a half/full-day package. The package amounts
 * live on the same price row, so a seasonal list moves the package with the
 * hourly rate. Cloning the row with the package as its headline amount puts the
 * package through the ordinary maths above instead of a second calculation that
 * could drift — weekend uplift included.
 */
function hallAmount(price, service, opts) {
  opts = Object.assign({ date: dstr(new Date()) }, opts || {});
  const s = price.surcharges || {};
  const label = opts.package === "half" ? "halfDay" : opts.package === "full" ? "fullDay" : null;
  const base = label ? s[label] : null;
  if (!base) {
    const hourly = amount(price, service, { date: opts.date, qty: opts.hours || 1, modifier: opts.modifier });
    return {
      package: null, packageName: null, qty: opts.hours || 1,
      basePrice: round50(price.amount * (opts.modifier || 1)),
      unit: hourly.unit, lines: hourly.lines, added: hourly.added,
    };
  }
  const clone = Object.assign({}, price, { amount: round50(base * (opts.modifier || 1)) });
  const pkg = amount(clone, service, { date: opts.date, qty: 1, modifier: 1 });
  return {
    package: opts.package, packageName: opts.package === "half" ? "Half day" : "Full day", qty: 1,
    basePrice: clone.amount, unit: pkg.unit, lines: pkg.lines, added: pkg.added,
  };
}

/** Rules compound in order, so VAT lands on top of the service charge. */
function taxes(rules, subtotal, category) {
  const applicable = rules.filter((r) => {
    return Number(r.pct) > 0 && (r.appliesTo || []).indexOf(category) !== -1;
  }).sort((a, b) => a.order - b.order);
  let running = subtotal;
  const lines = [];
  applicable.forEach((r) => {
    const amt = round50(running * Number(r.pct) / 100);
    if (!amt) return;
    running += amt;
    lines.push({ rule: r, amount: amt, label: `${r.name} (${Number(r.pct)}%)` });
  });
  return { lines, total: running - subtotal, grand: running };
}

/* ── the catalogue, read from the authoring tables ───────────── */

/**
 * `db` is optional and defaults to the pool. A caller writing inside a
 * transaction — the seed, which quotes the bookings it files — has to hand its
 * own client: a catalogue read over the pool cannot see rows the transaction has
 * not committed yet, and would price a hall off an empty price list.
 */
async function catalogue(db) {
  const q = db || pool;
  const [listsR, pricesR, servicesR, rulesR, typesR, plansR] = await Promise.all([
    q.query(`SELECT * FROM price_lists ORDER BY priority DESC`),
    q.query(`SELECT * FROM prices`),
    q.query(`SELECT * FROM services`),
    q.query(`SELECT * FROM tax_rules ORDER BY sort_order`),
    q.query(`SELECT * FROM room_types`),
    q.query(`SELECT * FROM rate_plans ORDER BY code`),
  ]);
  return {
    lists: listsR.rows.map((l) => ({
      id: l.id, name: l.name, kind: l.kind, from: dstr(l.from_date), to: dstr(l.to_date),
      priority: Number(l.priority), currency: l.currency, active: !!l.active,
    })),
    prices: pricesR.rows.map((p) => ({
      id: p.id, serviceId: p.service_id, listId: p.list_id, currency: p.currency,
      amount: Number(p.amount), surcharges: jsonIn(p.surcharges, {}),
      from: dstr(p.from_date), to: dstr(p.to_date), active: !!p.active,
    })),
    services: servicesR.rows.map((s) => ({
      id: s.id, category: s.category, refId: s.ref_id, code: s.code, name: s.name,
      unit: s.unit, active: !!s.active, occupancy: s.occupancy === null ? null : Number(s.occupancy),
      capacity: s.capacity === null ? null : Number(s.capacity), outletId: s.outlet_id,
      outlet: jsonIn(s.outlet, null),
      addon: !!s.addon, turnaroundMins: s.turnaround_mins === null ? null : Number(s.turnaround_mins),
    })),
    rules: rulesR.rows.map((r) => ({
      id: r.id, name: r.name, kind: r.kind, pct: Number(r.pct), order: Number(r.sort_order),
      appliesTo: jsonIn(r.applies_to, []),
    })),
    roomTypes: typesR.rows.map((t) => ({
      id: t.id, code: t.code, name: t.name, size: Number(t.size), occupancy: Number(t.occupancy),
      bed: t.bed, view: t.view, amenities: jsonIn(t.amenities, []),
    })),
    ratePlans: plansR.rows.map((p) => ({
      id: p.id, code: p.code, name: p.name, modifier: Number(p.modifier),
      depositPct: Number(p.deposit_pct), cancelPolicy: p.cancel_policy, includes: p.includes,
    })),
  };
}

function serviceOf(cat, category, refId) {
  return cat.services.find((s) => s.category === category && s.refId === refId) || null;
}

/**
 * A room type priced for one night, with the tax lines the folio would carry.
 * Returns null when nothing is sellable that night, which is what keeps an
 * overstay whose rate has expired out of the audit's posting — and keeps a night
 * priced in a money the books cannot value out of it too. A quote in an
 * unvaluable currency is not a cheap quote, it is no quote: the rate is a guess,
 * and a guest cannot be billed on a guess.
 *
 * `opts.fx` is the rate bundle from FX.sources(day); without it a caller gets
 * the price as written, which is what a rate card on screen is.
 */
function quoteNight(cat, typeId, planId, date, adults, opts) {
  const o = opts || {};
  const svc = serviceOf(cat, "room", typeId);
  const type = cat.roomTypes.find((t) => t.id === typeId) || null;
  const plan = cat.ratePlans.find((p) => p.id === planId) || cat.ratePlans[0];
  if (!svc || !type || !svc.active) return null;
  const hit = resolve(cat.prices, cat.lists, svc.id, { date });
  if (!hit) return null;
  const blocked = o.fx ? FX.gateIn(FX.contextOf(o.fx, o.propertyId, date), hit.price.currency) : null;
  if (blocked) return null;
  const a = amount(hit.price, svc, { date, modifier: plan ? plan.modifier : 1, adults });
  const base = round50(hit.price.amount * (plan ? plan.modifier || 1 : 1));
  const tax = taxes(cat.rules, a.unit, "room");
  return {
    available: true, type, plan, svc, date,
    rate: a.unit, base, uplift: a.unit - base, added: a.added,
    currency: hit.price.currency, serviceId: svc.id, priceId: hit.price.id,
    listId: hit.list.id, list: hit.list.name,
    taxLines: tax.lines, taxes: tax.total, total: tax.grand,
  };
}

/**
 * A whole stay, priced night by night — the browser's `PRICE.stay`.
 *
 * The taxes land on the room total rather than on each night, because that is
 * the order the desk quotes in: two nights at ₦200,000 are billed the same as a
 * two-night booking, and a per-night tax rounded to the fifty would make them
 * differ. Every night is the same `quoteNight` the night audit bills, so a
 * booking cannot be quoted on one figure and woken up on another.
 *
 * Null when a night cannot be sold — the service switched off, a rate that has
 * come off the air, a money the books cannot value on that date. A stay with an
 * unpriceable night has no quote at all, rather than a short one.
 */
function stayQuote(cat, typeId, planId, ci, co, adults, opts) {
  const svc = serviceOf(cat, "room", typeId);
  const type = cat.roomTypes.find((t) => t.id === typeId) || null;
  const plan = cat.ratePlans.find((p) => p.id === planId) || cat.ratePlans[0] || null;
  if (!svc || !type || !plan) return null;
  const n = Math.max(1, nights(ci, co));
  const nightly = [];
  for (let i = 0; i < n; i++) {
    const q = quoteNight(cat, typeId, planId, addDays(ci, i), adults, opts);
    if (!q) return null;
    // Only what a night is billed at; the tax picture is taken once, over the stay.
    nightly.push({
      date: q.date, rate: q.rate, base: q.base, uplift: q.uplift, added: q.added,
      currency: q.currency, serviceId: q.serviceId, priceId: q.priceId,
      listId: q.listId, list: q.list,
    });
  }
  const roomTotal = nightly.reduce((s, x) => s + x.rate, 0);
  const extras = nightly.reduce((s, x) => s + x.uplift, 0);
  const tax = taxes(cat.rules, roomTotal, "room");
  const byKind = {};
  tax.lines.forEach((l) => { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
  return {
    available: true, type, plan, svc, nights: n, nightly, roomTotal, extras,
    taxLines: tax.lines, taxes: tax.total, service: byKind.service || 0, vat: byKind.vat || 0,
    total: tax.grand, currency: nightly[0].currency,
    deposit: round50(tax.grand * (Number(plan.depositPct) || 0) / 100),
  };
}

/**
 * A hall quoted for a window of time, with its add-ons. This is the same row of
 * maths a booking is taken on, so the figure on screen and the figure on the
 * invoice cannot disagree.
 *
 * `opts.fx` is the rate bundle from FX.sources(day): a hall is always quoted as
 * money, so the gate and the per-line conversion are read here and frozen onto
 * the line — a booking that never reaches a folio still earns in the right money.
 */
function hallQuote(cat, serviceId, opts) {
  const o = opts || {};
  const svc = cat.services.find((s) => s.id === serviceId) || null;
  if (!svc || svc.category !== "hall" || svc.addon || !svc.active) return null;
  const date = o.date || dstr(new Date());
  const hours = hoursBetween(o.start, o.end);
  if (!hours) return null;
  const hit = resolve(cat.prices, cat.lists, serviceId, { date, listId: o.listId });
  if (!hit) return null;
  const ctx = FX.contextOf(o.fx, o.propertyId, date);
  // As with a room night: a hall priced in a currency the books cannot value
  // today is not on sale today.
  if (FX.gateIn(ctx, hit.price.currency)) return null;
  const q = hallAmount(hit.price, svc, { date, package: o.package, hours });
  const lines = [{
    kind: q.package ? "package" : "hourly", serviceId: svc.id, name: svc.name,
    unit: q.package ? q.packageName : "hour" + (q.qty > 1 ? "s" : ""), qty: q.qty,
    unitPrice: q.unit, basePrice: q.basePrice, amount: q.lines, currency: hit.price.currency,
    priceId: hit.price.id, listId: hit.list.id, listName: hit.list.name, added: q.added,
  }];
  const extras = [];
  const skipped = [];
  (o.addons || []).forEach((a) => {
    const pick = serviceOf(cat, "hall", a.id);
    const qty = Math.max(1, Number(a.qty) || 0);
    if (!pick || !pick.addon || !pick.active || !qty) return;
    const e = resolve(cat.prices, cat.lists, pick.id, { date });
    if (!e) return;
    // One booking is one money. An add-on priced in a currency the hall line is
    // not in cannot join its total, and one the books cannot value today cannot
    // be sold at all — either way the desk is told what was left out rather than
    // quietly billed for less than it asked for.
    if (FX.gateIn(ctx, e.price.currency) || e.price.currency !== hit.price.currency) {
      skipped.push({ name: pick.name, currency: e.price.currency });
      return;
    }
    const ea = amount(e.price, pick, { date, qty });
    extras.push({
      kind: "addon", serviceId: pick.id, name: pick.name, unit: pick.unit, qty,
      unitPrice: ea.unit, basePrice: e.price.amount, amount: ea.lines, currency: e.price.currency,
      priceId: e.price.id, listId: e.list.id, listName: e.list.name, added: ea.added,
    });
  });
  const all = lines.concat(extras);
  for (const line of all) {
    const stamp = FX.stampIn(ctx, line.amount, line.currency);
    if (stamp.error) return null;
    Object.assign(line, { currency: stamp.currency, fxRate: stamp.fxRate, baseAmount: stamp.baseAmount });
  }
  const subtotal = all.reduce((s, l) => s + l.amount, 0);
  const tax = taxes(cat.rules, subtotal, "hall");
  const depositPct = (hit.price.surcharges || {}).depositPct || 0;
  const total = FX.stampIn(ctx, tax.grand, hit.price.currency);
  if (total.error) return null;
  return {
    available: true, service: svc, hall: svc, price: hit.price, list: hit.list,
    date, start: o.start, end: o.end, hours, package: q.package || null,
    packageName: q.packageName || "Hourly", lines: all, extras, subtotal,
    taxLines: tax.lines, tax: tax.total, total: tax.grand, currency: hit.price.currency,
    fxRate: total.fxRate, baseAmount: total.baseAmount,
    depositPct, deposit: round50(tax.grand * depositPct / 100), skipped,
  };
}

/**
 * The terms of a cancellation travel with the booking, taken from the price row
 * it was sold on: a fee is owed only inside the notice window. The window is
 * measured from the business date rather than a wall clock, so the same booking
 * on the same day is owed the same fee whoever asks, and when they ask.
 */
function cancellationFee(evt, day) {
  if (!evt || evt.status === "Cancelled") return 0;
  const pct = Number(evt.cancelPct) || 0;
  const notice = Number(evt.cancelHours) || 0;
  if (!pct || !notice) return 0;
  const ahead = hoursUntil(evt.date, evt.start, day);
  if (ahead === null || ahead > notice) return 0;
  return round50((Number(evt.total) || 0) * pct / 100);
}

/**
 * A laundry order: quantities in, priced lines out, and the collection time the
 * slowest item allows — the browser's `LHMS.price.laundryQuote`.
 *
 * An order is one money. The first priced item fixes it, and anything billed in
 * another is left out and *named* rather than summed into the total, because a
 * mixed order would put two currencies on one folio. A service the switch has
 * taken out of sale, or a price the books cannot value today, is not sold — the
 * same two refusals a hall quote makes, for the same reason: the guest cannot be
 * billed on a figure the ledger would have to guess at.
 */
function laundryQuote(cat, lines, opts) {
  const o = opts || {};
  const date = o.date || dstr(new Date());
  const ctx = FX.contextOf(o.fx, o.propertyId, date);
  const priced = [];
  const skipped = [];
  let mins = 0;
  (lines || []).forEach((l) => {
    const svc = serviceOf(cat, "laundry", l.id);
    const qty = Math.max(1, Number(l.qty) || 0);
    if (!svc || !svc.active || !qty) return;
    const hit = resolve(cat.prices, cat.lists, svc.id, { date });
    if (!hit || FX.gateIn(ctx, hit.price.currency)) return;
    const a = amount(hit.price, svc, { date, qty, express: !!o.express });
    priced.push({
      kind: "laundry", serviceId: svc.id, name: svc.name, unit: svc.unit, qty,
      unitPrice: a.unit, basePrice: hit.price.amount, amount: a.lines, added: a.added,
      currency: hit.price.currency, priceId: hit.price.id, listId: hit.list.id,
      listName: hit.list.name,
    });
    mins = Math.max(mins, svc.turnaroundMins || 0);
  });
  if (!priced.length) return null;

  const code = priced[0].currency || ctx.base;
  const same = [];
  priced.forEach((l) => {
    if (l.currency === code) same.push(l);
    else skipped.push({ serviceId: l.serviceId, name: l.name, currency: l.currency });
  });
  const subtotal = same.reduce((s, l) => s + l.amount, 0);
  const tax = taxes(cat.rules, subtotal, "laundry");
  return {
    lines: same, subtotal, taxLines: tax.lines, tax: tax.total, total: tax.grand,
    currency: code, express: !!o.express, skipped,
    etaMins: Math.round(mins * (o.express ? 0.5 : 1)) || 240,
  };
}

/* ── writing a price ─────────────────────────────────────────── */
/**
 * What a proposed patch would produce, before anything is written.
 *
 * `money` is the property's own FX reading. Pass it when a desk is asking for a
 * change; leave it out when an approved change is replaying, because the second
 * signature weighs the figures the requester read, not today's rates.
 */
function planPricePatch(row, patch, reason, money) {
  if (!row) return { error: "Price not found." };
  const next = {
    amount: patch.amount === undefined ? row.amount : round50(Number(patch.amount)),
    from: patch.from_date === undefined ? row.from : (patch.from_date || null),
    to: patch.to_date === undefined ? row.to : (patch.to_date || null),
    active: patch.active === undefined ? row.active : !!patch.active,
    listId: patch.listId === undefined ? row.listId : patch.listId,
    currency: patch.currency === undefined ? row.currency : String(patch.currency).toUpperCase(),
    surcharges: Object.assign({}, row.surcharges, patch.surcharges || {}),
  };
  if (patch.amount !== undefined && (!isFinite(Number(patch.amount)) || Number(patch.amount) <= 0)) {
    return { error: "A price must be a positive amount." };
  }
  if (next.currency && !/^[A-Z]{3}$/.test(next.currency)) {
    return { error: `Currency “${patch.currency}” is not a three-letter code.` };
  }
  if (next.from && next.to && next.to < next.from) return { error: "The end date must fall after the start date." };
  // A price is what the desk will sell, so it cannot stand in a money the books
  // cannot value today — the row is refused here rather than at the guest.
  if (money && next.currency) {
    const blocked = FX.gateIn(money, next.currency);
    if (blocked) return { error: blocked.error };
  }
  if (!reason) return { error: "A reason is required — it goes in the audit trail." };
  Object.keys(next.surcharges).forEach((k) => {
    const v = next.surcharges[k];
    if (v === null || v === "" || v === undefined) return;
    if (!isFinite(Number(v)) || Number(v) < 0) { next.surcharges[k] = 0; return; }
    next.surcharges[k] = Number(v);
  });
  // A move is judged as the gap it opens, so a rise and a cut of the same size
  // carry the same risk against the property's limit.
  const move = Math.abs(next.amount - row.amount);
  return { next, move, from: row.amount, to: next.amount };
}

/**
 * The one code path a price change takes — immediate or approved, both land
 * here, so an approval leaves the same history entry as a desk edit.
 */
async function applyPricePatch(row, patch, reason, actor, client) {
  const q = client || pool;
  const plan = planPricePatch(row, patch, reason);
  if (plan.error) return plan;
  const stamp = new Date().toISOString();
  const { rows } = await q.query(
    `UPDATE prices SET amount=$2, from_date=$3, to_date=$4, active=$5, list_id=$6,
        currency=$7, surcharges=$8, updated_by=$9, updated_at=$10
      WHERE id=$1 RETURNING *`,
    [row.id, plan.next.amount, plan.next.from, plan.next.to, plan.next.active, plan.next.listId,
      plan.next.currency, jsonOut(plan.next.surcharges), actor, stamp]
  );
  const updated = rows[0];
  await q.query(
    `INSERT INTO price_history (id,price_id,service_id,list_id,recorded_by,reason,from_data,to_data)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [uid("ph"), row.id, row.serviceId, plan.next.listId, actor, reason,
      jsonOut({ amount: row.amount, active: row.active, from: row.from, to: row.to }),
      jsonOut({ amount: Number(updated.amount), active: !!updated.active, from: dstr(updated.from_date), to: dstr(updated.to_date) })]
  );
  const { rows: svcRows } = await q.query(`SELECT name FROM services WHERE id = $1`, [row.serviceId]);
  const { rows: listRows } = await q.query(`SELECT name FROM price_lists WHERE id = $1`, [plan.next.listId]);
  return {
    price: mapPriceRow(updated),
    service: svcRows[0] ? svcRows[0].name : row.serviceId,
    list: listRows[0] ? listRows[0].name : plan.next.listId,
    amount: Number(updated.amount),
    active: !!updated.active,
    move: plan.move,
  };
}

function mapPriceRow(p) {
  if (!p) return null;
  return {
    id: p.id, serviceId: p.service_id, listId: p.list_id, currency: p.currency,
    amount: Number(p.amount), surcharges: jsonIn(p.surcharges, {}),
    from: dstr(p.from_date), to: dstr(p.to_date), active: !!p.active,
    updatedBy: p.updated_by, updatedAt: p.updated_at,
  };
}

async function priceRow(id) {
  const { rows } = await pool.query(`SELECT * FROM prices WHERE id = $1`, [id]);
  return mapPriceRow(rows[0]);
}

module.exports = {
  round50, isWeekend, addDays,
  listFor, resolve, amount, taxes,
  catalogue, serviceOf, quoteNight, stayQuote, hallAmount, hallQuote, laundryQuote, cancellationFee,
  planPricePatch, applyPricePatch, mapPriceRow, priceRow,
};
