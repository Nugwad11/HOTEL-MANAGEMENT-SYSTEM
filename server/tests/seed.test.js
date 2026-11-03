/**
 * The seed, driven through in-memory Postgres.
 *
 * The API's demo data is the only thing a live install ever sees, so the seed
 * is proven here rather than by eye: the catalogue rows the price engine reads,
 * the permission map the middleware checks, the two clock singletons and the
 * expense queue the financial dashboard counts — all of it, twice, because a
 * seed that cannot be re-run safely is a seed that will be avoided.
 */
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");
const { install } = require("./helpers/memdb");

const SEED = require("../src/db/seed");
const CAT = require("../src/db/catalogue");

const SRC = path.join(__dirname, "..", "src") + path.sep;

async function boot() {
  // Every src module caches the pool it was loaded against, so the graph is
  // dropped before each boot exactly as the API harness does it.
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC)) delete require.cache[k]; });

  const { pool } = install();
  const client = await pool.connect();
  await client.query("BEGIN");
  const out = await SEED.seed(client);
  await client.query("COMMIT");
  client.release();
  return { pool, out, day: out.day };
}

const q = (pool, sql, params) => pool.query(sql, params || []);

test("the catalogue lands with the same arithmetic as the browser seed", async () => {
  const { pool } = await boot();

  const services = await q(pool, `SELECT count(*) AS n FROM services`);
  const prices = await q(pool, `SELECT count(*) AS n FROM prices`);
  assert.equal(Number(services.rows[0].n), CAT.buildServices().length);
  assert.equal(Number(prices.rows[0].n), CAT.buildPrices("x").length);

  const dk = await q(pool, `SELECT * FROM prices WHERE id = 'prc_dk_std'`);
  assert.equal(Number(dk.rows[0].amount), 185000);
  assert.equal(dk.rows[0].surcharges.weekendPct, 15);
  assert.equal(dk.rows[0].surcharges.extraAdult, 22200); // round50(185000 × 0.12)

  const fest = await q(pool, `SELECT * FROM prices WHERE id = 'prc_dk_fest'`);
  assert.equal(Number(fest.rows[0].amount), 231250); // 185000 × 1.25, rounded to the nearest 50

  const hall = await q(pool, `SELECT * FROM prices WHERE id = 'prc_hall_grand_std'`);
  assert.equal(Number(hall.rows[0].amount), 850000);
  assert.equal(hall.rows[0].surcharges.fullDay, 6200000);

  const lists = await q(pool, `SELECT id, priority, currency FROM price_lists ORDER BY priority`);
  assert.deepEqual(lists.rows.map((r) => r.id), ["pl_std", "pl_day", "pl_corp", "pl_fest"]);
  // The contract book is the one that carries money the naira books cannot count
  // without a rate, so its currency has to land with it.
  assert.deepEqual(lists.rows.map((r) => [r.id, r.currency]),
    [["pl_std", "NGN"], ["pl_day", "NGN"], ["pl_corp", "USD"], ["pl_fest", "NGN"]]);

  const corp = await q(pool, `SELECT * FROM prices WHERE id IN ('prc_dk_corp','prc_ps_corp') ORDER BY id`);
  assert.deepEqual(corp.rows.map((r) => [r.id, r.currency, Number(r.amount)]),
    [["prc_dk_corp", "USD", 150], ["prc_ps_corp", "USD", 800]]);

  const taxes = await q(pool, `SELECT name, pct, sort_order FROM tax_rules ORDER BY sort_order`);
  assert.deepEqual(taxes.rows.map((r) => [r.name, Number(r.pct)]),
    [["Service charge", 10], ["VAT", 7.5], ["City tourism levy", 0]]);
});

test("the seeded rates are dated against the business day, not the clock", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");
  const { rows } = await q(pool, `SELECT code, per_base, effective, set_by FROM fx_rates ORDER BY effective`);
  assert.deepEqual(rows.map((r) => [r.code, Number(r.per_base), biz.dstr(r.effective)]), [
    ["GBP", 1965, CAT.addDays(day, -9)],
    ["USD", 1512, CAT.addDays(day, -8)],
    ["USD", 1550, CAT.addDays(day, -1)],
  ]);
  assert.ok(rows.every((r) => r.set_by === "Ifeoma Okafor"));

  // One inside the property's trust limit, one long past it: the states the
  // currency rules are about, reachable from the seed alone.
  const FX = require("../src/lib/fx");
  const ctx = await FX.read({ propertyId: "agm" });
  assert.deepEqual([FX.state(ctx.rates, "USD", ctx).state, FX.state(ctx.rates, "GBP", ctx).state,
    FX.state(ctx.rates, "EUR", ctx).state], ["fresh", "stale", "missing"]);
});

test("the price engine reads a seeded night with no browser in the loop", async () => {
  await boot();
  const P = require("../src/lib/price");
  const cat = await P.catalogue();
  const quote = P.quoteNight(cat, "ps", "flex", "2026-10-29", 2);
  assert.equal(quote.available, true);
  assert.equal(quote.rate, 1250000);
  // 10% service on the rate, then 7.5% VAT on the sum, each to the nearest 50.
  assert.equal(quote.taxes, 228150);
  assert.equal(quote.total, 1478150);
  assert.deepEqual(quote.taxLines.map((l) => [l.label, l.amount]),
    [["Service charge (10%)", 125000], ["VAT (7.5%)", 103150]]);

  // A Friday carries the weekend uplift the price list was seeded with.
  const weekend = P.quoteNight(cat, "dk", "flex", "2026-10-30", 2);
  assert.equal(weekend.rate, 212750); // 185000 × 1.15
  assert.equal(weekend.uplift, 27750);
});

test("every role's permission map matches the frontend, key for key", async () => {
  const { pool } = await boot();
  const { rows } = await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`);
  const map = rows[0].data;
  assert.deepEqual(Object.keys(map).sort(),
    ["Auditor", "Finance Manager", "Front Desk", "Guest", "Housekeeping", "Manager", "Revenue"]);

  for (const role of Object.keys(map)) {
    if (role === "Guest") continue;  // a guest holds no keys at all, by design
    assert.deepEqual(Object.keys(map[role]).sort(), [...SEED.PERMISSION_KEYS].sort(), role);
  }
  assert.equal(SEED.PERMISSION_KEYS.length, 19);

  assert.equal(map.Manager.night_audit, true);
  assert.equal(map["Front Desk"].manage_billing, true);
  assert.equal(map["Front Desk"].night_audit, false);
  assert.equal(map["Front Desk"].approve_financial_changes, false);
  assert.equal(map.Housekeeping.record_expenses, true);
  assert.equal(map.Housekeeping.take_payments, false);
  assert.equal(map.Revenue.configure_prices, true);
  assert.equal(map.Revenue.approve_financial_changes, false);
  // Read-only by construction: the auditor holds exactly one key.
  assert.deepEqual(Object.keys(map.Auditor).filter((k) => map.Auditor[k]), ["view_reports"]);
  assert.deepEqual(map.Guest, {});

  // The controller holds the ledger and the signature, and nothing that lets them
  // raise a move of money for their own hand to clear.
  assert.deepEqual(Object.keys(map["Finance Manager"]).filter((k) => map["Finance Manager"][k]).sort(),
    ["approve_expenses", "approve_financial_changes", "manage_billing", "manage_financial_settings", "view_reports"]);
  for (const ask of ["configure_prices", "manage_rates", "record_expenses", "post_charges",
    "take_payments", "check_in_out", "book_events", "run_laundry", "manage_staff", "night_audit"]) {
    assert.equal(map["Finance Manager"][ask], false, `the second hand does not hold ${ask}`);
  }
});

test("a stored map keeps what a manager set and gains the missing keys", async () => {
  const { pool } = await boot();

  // An install seeded before the finance permissions existed: fourteen keys,
  // and a deliberate revocation of checkout authority.
  const legacy = {};
  SEED.PERMISSION_KEYS.slice(0, 14).forEach((k) => { legacy[k] = k === "manage_reservations"; });
  await q(pool, `UPDATE staff_permissions SET data = $1 WHERE id = 1`, [{ "Front Desk": legacy }]);

  const client = await pool.connect();
  await client.query("BEGIN");
  await SEED.seed(client);
  await client.query("COMMIT");
  client.release();

  const { rows } = await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`);
  const fd = rows[0].data["Front Desk"];
  assert.equal(Object.keys(fd).length, 19, "the five finance keys arrive");
  assert.equal(fd.manage_reservations, true, "a key the manager set stays as set");
  assert.equal(fd.take_payments, false, "including when it was switched off");
  assert.equal(fd.approve_financial_changes, false, "and the new ones arrive off");
  assert.equal(rows[0].data.Manager.night_audit, true, "a role nobody had configured gets its defaults");
});

test("the money defaults land in every property's settings", async () => {
  const { pool } = await boot();
  const { rows } = await q(pool, `SELECT property_id, data FROM settings ORDER BY property_id`);
  assert.deepEqual(rows.map((r) => r.property_id), ["agm", "apa", "ari"]);
  const codes = {};
  for (const p of (await q(pool, `SELECT id, code FROM properties`)).rows) codes[p.id] = p.code;
  for (const r of rows) {
    // One set of money rules for the group; the prefix is the hotel's own, because
    // a document is filed under the code of the house that raised it.
    assert.deepEqual(r.data.finance,
      Object.assign({}, SEED.FINANCE_DEFAULTS, { invoicePrefix: codes[r.property_id] }));
    assert.equal(r.data.finance.approvalAmount, 500000);
  }
});

test("every property opens with the brand the browser signs its pages with", async () => {
  const { pool } = await boot();
  const { rows } = await q(pool, `SELECT property_id, data FROM settings ORDER BY property_id`);
  const props = Object.fromEntries(
    (await q(pool, `SELECT id, name, tagline FROM properties`)).rows.map((p) => [p.id, p])
  );

  for (const r of rows) {
    const b = r.data.branding;
    assert.ok(b, `${r.property_id} carries a branding block`);
    // The flagship speaks for the group; every other house speaks for itself —
    // exactly the rule assets/store.js applies when no brand has been saved.
    assert.equal(b.brandName, r.property_id === "agm" ? "Aurelia Grand" : props[r.property_id].name);
    assert.equal(b.tagline, r.property_id === "agm" ? "Hotels & Residences" : props[r.property_id].tagline);
    assert.equal(b.logo, "", "no hotel is given artwork it did not upload");
    assert.deepEqual(b.images, [], "and its gallery opens empty");
    assert.equal(b.palette, null, "with the house colours, not a palette from nowhere");
    assert.equal(b.useColors, true, "ready to follow a logo once one arrives");
    assert.equal(b.updatedAt, null);
    assert.equal(b.updatedBy, null);
  }
});

test("the clock is seeded once and never rewound by a reseed", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");
  assert.equal(await biz.businessDay(), day);
  const { rows: series } = await q(pool, `SELECT seq FROM invoice_series WHERE id = 1`);
  const { rows: raised } = await q(pool, `SELECT count(*) AS n FROM invoices`);
  assert.ok(Number(raised[0].n) > 0, "the register opens on the documents the trading day earned");
  assert.equal(Number(series[0].seq), Number(raised[0].n), "every document took one number, no more");

  // The night audit rolls the day forward; a reseed must not undo it.
  const rolled = biz.addDays(day, 1);
  await biz.setBusinessDay(rolled);

  const client = await pool.connect();
  await client.query("BEGIN");
  await SEED.seed(client);
  await client.query("COMMIT");
  client.release();

  assert.equal(await biz.businessDay(), rolled);
  const { rows } = await q(pool, `SELECT count(*) AS n FROM business_date`);
  assert.equal(Number(rows[0].n), 1);
  const { rows: again } = await q(pool, `SELECT seq FROM invoice_series WHERE id = 1`);
  assert.equal(Number(again[0].seq), Number(series[0].seq), "a reseed bills nothing twice");
});

test("the board opens on the hall bookings the browser seeds", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");
  const { rows } = await q(pool, `SELECT * FROM events ORDER BY id`);
  assert.deepEqual(rows.map((r) => [
    r.id, r.hall_id, r.property_id, r.status, biz.dstr(r.event_date), Number(r.guests_count),
  ]), [
    ["evt_1", "hall_grand", "agm", "Confirmed", biz.addDays(day, 2), 260],
    ["evt_2", "hall_garden", "agm", "Confirmed", biz.addDays(day, 9), 110],
    ["evt_3", "hall_board", "ari", "Hold", biz.addDays(day, 1), 14],
    ["evt_4", "hall_grand", "agm", "Confirmed", biz.addDays(day, -12), 180],
    ["evt_5", "hall_garden", "agm", "Confirmed", biz.addDays(day, -26), 120],
  ], "the same five bookings, in the same states, dated against the business day");

  // Two of them are history on purpose: a financial period with no event
  // revenue would report a department the property plainly trades in.
  assert.equal(rows.filter((r) => biz.dstr(r.event_date) < day).length, 2);

  // Every booking fits the licence the booking form enforces — a figure that
  // only a hand-typed row could break.
  for (const r of rows) {
    const svc = (await q(pool, `SELECT capacity FROM services WHERE id = $1`, [r.hall_service_id])).rows[0];
    assert.ok(Number(r.guests_count) <= Number(svc.capacity),
      `${r.title} puts ${r.guests_count} guests in a hall licensed for ${svc.capacity}`);
  }
});

test("a seeded booking is priced by the engine, line for line", async () => {
  const { pool, day } = await boot();
  const P = require("../src/lib/price");
  const FX = require("../src/lib/fx");
  const biz = require("../src/lib/business-date");
  const cat = await P.catalogue(pool);
  const src = await FX.sources(day, pool);

  const { rows } = await q(pool, `SELECT * FROM events ORDER BY id`);
  const spec = {
    evt_1: ["hall_grand", "agm", "2", "08:00", "18:00", { evt_decor: 1, evt_sound: 1, evt_projector: 1, evt_catering: 260 }],
    evt_2: ["hall_garden", "agm", "9", "16:00", "23:00", { evt_flowers: 2, evt_sound: 1 }],
    evt_3: ["hall_board", "ari", "1", "09:30", "13:30", { evt_projector: 1 }],
    evt_4: ["hall_grand", "agm", "-12", "09:00", "17:00", { evt_decor: 1, evt_sound: 1, evt_catering: 180 }],
    evt_5: ["hall_garden", "agm", "-26", "15:00", "23:00", { evt_flowers: 3, evt_sound: 1, evt_catering: 120 }],
  };

  for (const r of rows) {
    const [hallId, prop, offset, start, end, addons] = spec[r.id];
    const svc = P.serviceOf(cat, "hall", hallId);
    const quote = P.hallQuote(cat, svc.id, {
      propertyId: prop, fx: src, date: biz.addDays(day, Number(offset)), start, end,
      package: r.package || null,
      addons: Object.keys(addons).map((id) => ({ id, qty: addons[id] })),
    });
    assert.ok(quote, `${r.id} should still quote`);
    assert.deepEqual([Number(r.subtotal), Number(r.tax), Number(r.total)],
      [quote.subtotal, quote.tax, quote.total], `${r.id} keeps the engine's money`);
    assert.equal(r.price_id, quote.price.id, "and the price row it was sold on");
    assert.equal(r.list_id, quote.list.id);
    assert.equal(r.currency, quote.currency);
    assert.equal(Number(r.deposit), quote.deposit, "the deposit the terms ask for");
    assert.equal(Number(r.deposit_pct), quote.depositPct);

    const { rows: lines } = await q(pool, `SELECT * FROM event_lines WHERE event_id = $1 ORDER BY sort_order`, [r.id]);
    assert.deepEqual(lines.map((l) => [l.kind, l.name, Number(l.qty), Number(l.amount)]),
      quote.lines.map((l) => [l.kind, l.name, l.qty, l.amount]), `${r.id} itemises what was quoted`);
    assert.equal(lines.reduce((s, l) => s + Number(l.amount), 0), quote.subtotal,
      "and the lines add up to the header, not beside it");
  }
});

test("a hold on the seeded board reserves the time and sells nothing", async () => {
  const { pool } = await boot();
  const { rows } = await q(pool, `SELECT count(*) AS n FROM charges WHERE event_id IN (SELECT id FROM events)`);
  assert.equal(Number(rows[0].n), 0,
    "no booking is on a folio, and a hold would post nothing even if it were");

  const held = (await q(pool, `SELECT * FROM events WHERE id = 'evt_3'`)).rows[0];
  assert.equal(held.status, "Hold");
  assert.equal(Number(held.deposit_paid), 0, "nothing has been taken on any of them yet");

  // The board the desk works from is one it can act on: the hold is still a
  // hold, so confirming it is the door the route offers.
  const clash = (await q(pool, `SELECT count(*) AS n FROM events
                                WHERE hall_id = 'hall_grand' AND event_date = CURRENT_DATE`)).rows[0];
  assert.equal(Number(clash.n), 0, "the two grand ballroom bookings sit on different days");
});

test("the events desk reads the seeded board through the API", async () => {
  const { pool } = await boot();
  const request = require("supertest");
  const { sign } = require("../src/lib/jwt");
  const app = require("../src/index");
  const perms = (await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`)).rows[0].data;
  const u = (await q(pool, `SELECT * FROM users WHERE role = 'Front Desk'`)).rows[0];
  const token = "Bearer " + sign({
    id: u.id, email: u.email, name: u.name, role: "Front Desk",
    propertyId: u.property_id, permissions: perms["Front Desk"],
  });

  const board = await request(app).get("/api/events").set("Authorization", token);
  assert.equal(board.status, 200);
  assert.equal(board.body.length, 4, "the flagship's four bookings; the boardroom sits at the Reserve");
  assert.deepEqual(board.body.map((e) => e.hall_id), ["hall_garden", "hall_grand", "hall_grand", "hall_garden"],
    "the board is in date order, oldest first");
  const first = board.body[0];
  assert.equal(first.title, "Adeyemi — Balogun wedding reception");
  assert.equal(first.lines.length, 4, "the hall and its add-ons travel with the booking");
  assert.equal(Number(first.total), Number(first.subtotal) + Number(first.tax));

  // And a booking opens the way the desk opens one: the header and the lines it
  // was sold on, reconciling to the same figure the seed wrote.
  const one = await request(app).get("/api/events/evt_1").set("Authorization", token);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(Number(one.body.total), Number(one.body.subtotal) + Number(one.body.tax));
  assert.deepEqual(one.body.tax_lines.map((t) => t.label), ["Service charge (10%)", "VAT (7.5%)"],
    "the tax lines the quote carried travel with the booking");
  assert.equal(Number(one.body.service_charge) + Number(one.body.vat), Number(one.body.tax));

  // The boardroom hold belongs to the Reserve, so the flagship's desk is not
  // shown a booking it cannot act on — while a Manager, who reads the group, is.
  const elsewhere = await request(app).get("/api/events/evt_3").set("Authorization", token);
  assert.equal(elsewhere.status, 403, JSON.stringify(elsewhere.body));
  const gm = (await q(pool, `SELECT * FROM users WHERE role = 'Manager'`)).rows[0];
  const manager = "Bearer " + sign({
    id: gm.id, email: gm.email, name: gm.name, role: "Manager",
    propertyId: gm.property_id, permissions: perms.Manager,
  });
  const seen = await request(app).get("/api/events/evt_3").set("Authorization", manager);
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.status, "Hold", "and it is still a hold for the confirm door to sell");
});

test("the register opens on the documents the trading day earned", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");
  const ledger = require("../src/lib/ledger");
  const serial = (n) => Number(n.split("-").pop());

  const { rows } = await q(pool, `SELECT * FROM invoices`);
  const docs = rows.slice().sort((a, b) => serial(a.number) - serial(b.number));

  /* The board follows the browser's seed: every settled stay is billed, and the
     two earliest-dated confirmed halls that stand on no folio — here, the two
     delivered ones — carry documents of their own. */
  const { rows: stays } = await q(pool, `SELECT id FROM reservations WHERE status = 'Checked out'`);
  assert.equal(stays.length, SEED.STAY_SEED.filter((s) => s.status === "Checked out").length);
  const delivered = (await q(pool, `SELECT id, event_date, total FROM events WHERE status = 'Confirmed'`)).rows
    .sort((a, b) => (biz.dstr(a.event_date) < biz.dstr(b.event_date) ? -1
      : biz.dstr(a.event_date) > biz.dstr(b.event_date) ? 1 : 0))
    .slice(0, 2);
  assert.equal(docs.length, stays.length + delivered.length,
    "one document per settled folio and one per delivered hall, and nothing else");

  // One group-wide series, each hotel's own prefix: a document is numbered the
  // way the counter that handed it over would have numbered it.
  assert.deepEqual(docs.map((d) => serial(d.number)), docs.map((_, i) => i + 1),
    "serials run from one without a gap");
  assert.equal(new Set(docs.map((d) => d.number)).size, docs.length, "and no serial is drawn twice");
  const codes = Object.fromEntries(
    (await q(pool, `SELECT id, code FROM properties`)).rows.map((p) => [p.id, p.code])
  );
  for (const d of docs) {
    assert.equal(d.number, `${codes[d.property_id]}-INV-${String(serial(d.number)).padStart(4, "0")}`,
      `${d.id} is numbered in its own hotel's series`);
    assert.equal(biz.dstr(d.invoice_date), day, "and raised against the business day");
  }

  // A folio document is worth exactly the folio: every charge is copied once,
  // and the departure settlement is presented against the paper it answered.
  for (const stay of stays) {
    const mine = docs.filter((d) => d.kind === "folio" && d.reservation_id === stay.id);
    assert.equal(mine.length, 1, `${stay.id} is billed on one document`);
    const inv = await ledger.invoiceWithMoney(ledger.mapInvoice(mine[0]), pool);
    const { rows: charges } = await q(pool, `SELECT id, amount, invoice_id FROM charges
                                             WHERE reservation_id = $1`, [stay.id]);
    assert.ok(charges.length > 0, `${stay.id} left lines behind`);
    assert.equal(inv.totals.total,
      charges.reduce((s, c) => s + Number(c.amount), 0),
      `${stay.id}'s document is worth its folio, not a figure typed beside it`);
    assert.deepEqual(inv.lines.map((l) => l.chargeId).sort(), charges.map((c) => c.id).sort(),
      "each line points back at the charge it copied");
    assert.ok(charges.every((c) => c.invoice_id === mine[0].id), "and every charge is billed once");
    assert.equal(inv.totals.balance, 0, `${stay.id} left with its folio settled`);
    assert.equal(mine[0].status, "Paid", "so the document reads as answered");
    assert.ok(inv.payments.length > 0, "and the money that closed the folio is on it");
  }

  // A hall document is worth the quote the booking was sold on, billed in
  // arrears: the event has happened, the desk raises the paper after it.
  for (const evt of delivered) {
    const doc = docs.find((d) => d.kind === "event" && d.entity_id === evt.id);
    assert.ok(doc, `${evt.id} is billed`);
    const inv = await ledger.invoiceWithMoney(ledger.mapInvoice(doc), pool);
    assert.equal(inv.totals.total, Number(evt.total), `${evt.id}'s document carries the quoted total`);
    assert.ok(biz.dstr(evt.event_date) < day, `${evt.id} has been delivered`);
    assert.equal(doc.property_id, "agm");
    assert.equal(doc.status, "Unpaid", "and no money has been taken against it yet");
  }
  // Nothing else was billed: a confirmed hall ahead of the day has not happened,
  // and a hold has not been sold.
  const billedHalls = docs.filter((d) => d.kind === "event").map((d) => d.entity_id).sort();
  assert.deepEqual(billedHalls, delivered.map((e) => e.id).sort(),
    "only the halls that were delivered carry documents");
});

test("the document register and the review board open on rows, not empty shelves", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");
  const inYears = (n) => {
    const dt = new Date(day + "T12:00:00");
    dt.setFullYear(dt.getFullYear() + n);
    return dt.toISOString().slice(0, 10);
  };

  // The register carries the six samples per hotel the browser's page seeds
  // itself the first time it opens (assets/pages-documents.js).
  const { rows: docs } = await q(pool, `SELECT * FROM documents ORDER BY id`);
  assert.equal(docs.length, 18, "six documents in each of the three hotels");
  for (const pid of ["agm", "ari", "apa"]) {
    const own = docs.filter((d) => d.property_id === pid);
    assert.deepEqual(own.map((d) => d.category),
      ["Registration", "Billing", "Spa & consent", "Events", "Billing", "Billing"],
      `${pid} files the browser's six categories`);
    assert.deepEqual(own.map((d) => d.status),
      ["Awaiting signature", "Ready", "Awaiting signature", "Draft", "Ready", "Ready"],
      "in the states a desk can act on");
    assert.equal(own.filter((d) => d.guest_visible).length, 5,
      "only the banquet order is internal");
    assert.ok(own.every((d) => d.reservation_id && d.guest_id),
      `${pid}'s documents are filed against the guest in the building`);
    for (const d of own) {
      const years = d.retention_years === 2 ? 2 : 7;
      assert.equal(biz.dstr(d.retention_until), inYears(years),
        `${d.name} is kept for ${years} years from today`);
    }
  }

  // The review board is filed against the stays that have left, one each.
  const { rows: reviews } = await q(pool, `SELECT * FROM reviews ORDER BY id`);
  const { rows: left } = await q(pool, `SELECT count(*) AS n FROM reservations WHERE status = 'Checked out'`);
  assert.equal(reviews.length, Number(left[0].n), "one review per departure");
  assert.deepEqual(reviews.map((r) => r.rating), [5, 5, 4, 5, 3],
    "the browser's spread, including the three-star the tray flags");
  assert.deepEqual(reviews.map((r) => r.channel), ["Google", "Post-stay survey", "TripAdvisor", "Google", "Post-stay survey"]);
  assert.equal(reviews.filter((r) => r.responded).length, 2, "a third of the board has been answered");
  assert.ok(reviews.filter((r) => r.responded).every((r) => r.response && r.responded_by && r.responded_at));
  for (const r of reviews) {
    assert.ok(r.reservation_id && r.guest_name, `${r.id} names the stay and the guest`);
    assert.ok(biz.dstr(r.review_date) < day, "and is dated before the business day");
    assert.ok(r.stay_summary.indexOf("–") > 0, "with the nights it reviews");
  }
});

test("the lost property register opens on the items the house is holding", async () => {
  const { pool, day } = await boot();
  const biz = require("../src/lib/business-date");

  // The browser seeds six items at the flagship (assets/data.js, "lost & found"),
  // each linked to the guest it came from so it can be returned without a search.
  const { rows } = await q(pool, `SELECT * FROM lost_found ORDER BY id`);
  assert.equal(rows.length, 6, "six items on the register");
  assert.ok(rows.every((l) => l.property_id === "agm"), "the house is holding them at the flagship");

  const tally = rows.reduce((m, l) => (m[l.status] = (m[l.status] || 0) + 1, m), {});
  assert.deepEqual(tally, { Stored: 3, Returned: 2, "Awaiting courier": 1 },
    "the register's own four words, and the browser's spread of them");

  assert.deepEqual(rows.map((l) => l.guest_id), ["gst_4", "gst_5", "gst_6", "gst_7", "gst_8", "gst_9"],
    "each item is linked to a guest profile, in the browser's order");

  const byId = Object.fromEntries(rows.map((l) => [l.id, l]));
  assert.equal(byId.lf_0.room_id, "agm-305", "a numbered place links to its room");
  assert.equal(byId.lf_1.room_id, "agm-412");
  assert.equal(byId.lf_3.room_id, null, '"G02" is a place, not a room row');
  assert.equal(byId.lf_5.room_id, null, "so is the lobby");
  assert.equal(byId.lf_0.location, "305", "the place is kept as the finder wrote it");

  assert.deepEqual(rows.map((l) => biz.dstr(l.found_date)),
    [2, 6, 1, 3, 11, 14].map((d) => biz.addDays(day, -d)), "each item carries the day it was found");
  assert.ok(byId.lf_1.claimed_at && byId.lf_5.claimed_at, "the returned pair carry the day they went back");
  assert.ok(!byId.lf_0.claimed_at && !byId.lf_2.claimed_at, "an item in the safe has not been handed over");
  assert.ok(rows.every((l) => l.note), "every card carries its storage or courier line");

  const { rows: trail } = await q(pool, `SELECT * FROM activity_log WHERE action = 'logged a lost item'`);
  assert.equal(trail.length, 0, "seeding a register is not the desk logging an item");
});

test("the roster carries the board's work, and the tray reads the day", async () => {
  const { pool } = await boot();
  const request = require("supertest");
  const { sign } = require("../src/lib/jwt");
  const app = require("../src/index");

  // The browser's roster: a full flagship and the first seven in each house.
  const { rows: staff } = await q(pool, `SELECT * FROM staff ORDER BY id`);
  const population = Object.fromEntries(
    ["agm", "ari", "apa"].map((p) => [p, staff.filter((s) => s.property_id === p).length])
  );
  assert.deepEqual(population, { agm: 12, ari: 7, apa: 7 });
  const staffById = Object.fromEntries(staff.map((s) => [s.id, s]));
  assert.equal(staffById.stf_agm_0.name, "Ifeoma Okafor");
  assert.equal(staffById.stf_ari_4.role, "Housekeeping",
    "the hands the task board is assigned to are on the roster");

  const { rows: tasks } = await q(pool, `SELECT * FROM tasks ORDER BY id`);
  const byProp = (pid) => tasks.filter((t) => t.property_id === pid);
  assert.deepEqual(["agm", "ari", "apa"].map((p) => byProp(p).length), [19, 11, 11],
    "nine rooms and ten requests at the flagship; five and six at each of the others");
  for (const pid of ["agm", "ari", "apa"]) {
    assert.deepEqual([...new Set(byProp(pid).map((t) => t.status))].sort(),
      ["Done", "In progress", "Open"], `${pid}'s board shows work in every state`);
  }
  const roomProp = Object.fromEntries(
    (await q(pool, `SELECT id, property_id FROM rooms`)).rows.map((r) => [r.id, r.property_id])
  );
  assert.ok(tasks.every((t) => t.room_id && roomProp[t.room_id] === t.property_id),
    "every card stands in a room of its own hotel");
  assert.ok(tasks.filter((t) => t.assigned_to)
    .every((t) => staffById[t.assigned_to].property_id === t.property_id),
  "and is handed to somebody on that hotel's roster");
  assert.ok(tasks.every((t) => new Date(t.due_at) > new Date(t.created_at)), "the SLA clock runs forward");
  assert.ok(tasks.filter((t) => t.status === "Done").every((t) => t.resolved_at),
    "a closed card says when it closed");
  const guests = tasks.filter((t) => /rq\d+$/.test(t.id));
  assert.ok(guests.every((t) => t.guest_id && /Room \d+$/.test(t.title)),
    "a guest's request names the guest and the room they are in");

  // And the desk reads the board through the API, joined to the room and hand.
  const perms = (await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`)).rows[0].data;
  const u = (await q(pool, `SELECT * FROM users WHERE role = 'Front Desk'`)).rows[0];
  const token = "Bearer " + sign({
    id: u.id, email: u.email, name: u.name, role: "Front Desk",
    propertyId: u.property_id, permissions: perms["Front Desk"],
  });
  const board = await request(app).get("/api/tasks?propertyId=agm").set("Authorization", token);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.length, 19);
  assert.ok(board.body.every((t) => t.room_number), "every card reads its room");
  assert.ok(board.body.filter((t) => t.assigned_to).every((t) => t.assignee_name),
    "and the person it is handed to");
  const open = await request(app).get("/api/tasks?propertyId=agm&status=Open").set("Authorization", token);
  assert.equal(open.body.length, board.body.filter((t) => t.status === "Open").length);
  assert.ok(open.body.every((t) => t.status === "Open"));

  // The tray is the day's own, not six invented sentences.
  const { rows: notes } = await q(pool, `SELECT * FROM notifications ORDER BY id`);
  assert.equal(notes.length, 6, "the tray opens on six lines");
  assert.equal(notes.filter((n) => !n.read).length, 4, "four of them still asking");
  assert.match(notes[3].title, /^New 3★ review needs a response$/, "the lowest score on file is flagged");
  assert.equal(notes[3].property_id, (await q(pool, `SELECT property_id FROM reviews WHERE rating <= 3`)).rows[0].property_id,
    "on the hotel that was reviewed");
  assert.match(notes[2].title, /^Room \d+ out of service/, "the maintenance line names a grounded room");
  const openRequests = Number((await q(pool, `SELECT count(*) AS n FROM tasks
    WHERE type = 'Guest request' AND status = 'Open' AND property_id = 'agm'`)).rows[0].n);
  assert.equal(notes[1].title, `${openRequests} guest requests approaching their response window`,
    "the SLA line counts the requests actually waiting");
  assert.match(notes[0].title, /arrives today at 16:00$/, "the arrival is today's, at the time on the booking");
  assert.ok(notes.every((n) => n.property_id && n.link), "every line stands on a hotel and opens a screen");
});

test("the laundry rail is the board's own orders, priced by the engine", async () => {
  const { pool, day } = await boot();
  const request = require("supertest");
  const { sign } = require("../src/lib/jwt");
  const app = require("../src/index");
  const P = require("../src/lib/price");
  const FX = require("../src/lib/fx");
  const biz = require("../src/lib/business-date");

  const { rows: orders } = await q(pool, `SELECT * FROM laundry_orders ORDER BY ref`);
  assert.equal(orders.length, 2, "the rail opens on the browser's two orders");
  assert.deepEqual(orders.map((o) => o.ref), ["LD-0001", "LD-0002"]);
  assert.ok(orders.every((o) => o.property_id === "agm"));

  // Both were taken from guests standing in the building, on the flagship.
  const { rows: stays } = await q(pool, `SELECT id, status, property_id FROM reservations`);
  const stayById = Object.fromEntries(stays.map((s) => [s.id, s]));
  assert.ok(orders.every((o) => stayById[o.reservation_id].status === "In-house"
    && stayById[o.reservation_id].property_id === "agm"),
  "the washing belongs to a guest who is still in house");
  assert.deepEqual(orders.map((o) => [o.status, o.express]), [["In progress", true], ["Ready", false]],
    "one load mid-wash, one waiting to go back");

  // The clock is the rail's, not the seed's: three hours into an express load,
  // fourteen into an ordinary one, and the promise moves with the card.
  const hoursAgo = (o) => Math.round((Date.now() - new Date(o.created_at).getTime()) / 3600000);
  assert.deepEqual(orders.map(hoursAgo), [3, 14]);
  const promised = (o) => Math.round((new Date(o.due_at) - new Date(o.created_at)) / 60000);
  assert.deepEqual(orders.map(promised), [240, 1440],
    "express halves the slowest garment's turnaround; the load keeps its day");

  // Every line is the engine's: the same quote the board's own button raises.
  const src = await FX.sources(day, pool);
  const cat = await P.catalogue(pool);
  const serviceById = Object.fromEntries(cat.services.map((s) => [s.id, s]));
  for (const o of orders) {
    const { rows: items } = await q(pool,
      `SELECT * FROM laundry_items WHERE order_id = $1 ORDER BY sort_order`, [o.id]);
    assert.equal(items.length, 3, `${o.ref} carries the three services it was rung in with`);
    const quote = P.laundryQuote(cat, items.map((i) => ({
      id: serviceById[i.service_id].refId, qty: Number(i.qty),
    })), { propertyId: "agm", fx: src, express: !!o.express, date: day });
    assert.ok(quote, `${o.ref} is quotable on the seeded lists`);
    assert.equal(Number(o.subtotal), quote.subtotal, `${o.ref}'s washing is the engine's subtotal`);
    assert.equal(Number(o.tax), quote.tax, "and the taxes it earned");
    assert.equal(Number(o.total), quote.total, "to the naira the board shows");
    assert.equal(o.currency, quote.currency);
    assert.deepEqual(o.tax_lines.map((t) => [t.label, Number(t.amount)]),
      quote.taxLines.map((t) => [t.label, t.amount]), "the tax rows keep their own labels and figures");

    // Each garment and each tax points at the folio line it was billed on, and
    // that line is the order's own figure — one posting, two readings.
    const { rows: folio } = await q(pool,
      `SELECT * FROM charges WHERE reservation_id = $1`, [o.reservation_id]);
    const chargeById = Object.fromEntries(folio.map((c) => [c.id, c]));
    const expressUplift = items.some((i) => (i.added || []).some((a) => a.label === "Express service"));
    assert.equal(expressUplift, !!o.express, "the uplift rides on the line only where it was asked for");
    for (const it of items) {
      const c = chargeById[it.charge_id];
      assert.ok(c, `${o.ref}'s ${it.name} points at its folio line`);
      assert.equal(Number(c.amount), Number(it.amount));
      assert.equal(c.description, Number(it.qty) > 1 ? `${it.qty} × ${it.name}` : it.name);
      assert.equal(c.posted_by, "Grace Mensah", "the hand that took the order");
      assert.equal(biz.dstr(c.charge_date), day, "on the open business day");
      assert.equal(c.invoice_id, null, "and still on the folio: the guest is in house");
    }
    for (const t of o.tax_lines) {
      const c = chargeById[t.chargeId];
      assert.equal(c.department, "Taxes & service");
      assert.equal(c.posted_by, "System", "the tax is the engine's, not the desk's");
      assert.equal(c.description, `${t.label} — laundry ${o.ref}`);
      assert.equal(Number(c.amount), Number(t.amount));
    }
    assert.equal(Number(o.base_amount),
      items.reduce((s, i) => s + Number(i.base_amount), 0)
        + o.tax_lines.reduce((s, t) => s + Number(chargeById[t.chargeId].base_amount), 0),
    "the books keep the value of every line it carries");
  }

  // And the rail reads back through the API the way the board shows it.
  const perms = (await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`)).rows[0].data;
  const u = (await q(pool, `SELECT * FROM users WHERE role = 'Housekeeping'`)).rows[0];
  const token = "Bearer " + sign({
    id: u.id, email: u.email, name: u.name, role: "Housekeeping",
    propertyId: u.property_id, permissions: perms.Housekeeping,
  });
  const board = await request(app).get("/api/laundry?propertyId=agm").set("Authorization", token);
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.length, 2);
  assert.ok(board.body.every((o) => o.items.length && o.guest_name && o.room_number),
    "every card reads its lines, its guest and its room");
  const ready = await request(app).get("/api/laundry?propertyId=agm&status=Ready")
    .set("Authorization", token);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.length, 1);
  assert.equal(ready.body[0].ref, "LD-0002");
  assert.equal(ready.body[0].items.length, 3);
  assert.equal(ready.body[0].tax_lines.length, 2);
});

test("the expense queue is seeded in all three states", async () => {
  const { pool, day } = await boot();
  const { rows } = await q(pool, `SELECT status, count(*) AS n FROM expenses GROUP BY status`);
  const by = rows.reduce((m, r) => (m[r.status] = Number(r.n), m), {});
  assert.equal(by.Pending, 15);   // five per property, anything inside the last week
  assert.equal(by.Rejected, 3);   // one per property, so the state is reachable
  assert.equal(by.Approved, 36);

  const payroll = await q(pool, `SELECT * FROM expenses WHERE property_id = 'agm' AND category = 'Payroll'`);
  assert.equal(Number(payroll.rows[0].amount), 3800000);
  const biz = require("../src/lib/business-date");
  assert.ok(biz.dstr(payroll.rows[0].expense_date) <= day, "no cost is dated in the future");

  const ari = await q(pool, `SELECT amount FROM expenses WHERE property_id = 'ari' AND category = 'Payroll' LIMIT 1`);
  assert.equal(Number(ari.rows[0].amount), 2232500); // 3800000 × 0.94 × (30/48)
});

test("the seed is safe to run twice", async () => {
  const { pool } = await boot();
  const counts = () => q(pool, `SELECT
    (SELECT count(*) FROM prices) AS prices,
    (SELECT count(*) FROM services) AS services,
    (SELECT count(*) FROM expenses) AS expenses,
    (SELECT count(*) FROM settings) AS settings,
    (SELECT count(*) FROM users) AS users,
    (SELECT count(*) FROM events) AS events,
    (SELECT count(*) FROM event_lines) AS lines,
    (SELECT count(*) FROM guests) AS guests,
    (SELECT count(*) FROM guest_notes) AS notes,
    (SELECT count(*) FROM reservations) AS stays,
    (SELECT count(*) FROM charges) AS charges,
    (SELECT count(*) FROM payments) AS payments,
    (SELECT count(*) FROM activity_log) AS activity`);
  const before = await counts();

  const client = await pool.connect();
  await client.query("BEGIN");
  await SEED.seed(client);
  await client.query("COMMIT");
  client.release();

  const after = await counts();
  assert.deepEqual(after.rows[0], before.rows[0]);
  assert.equal(Number(after.rows[0].events), 5, "the board is the same board, not a second copy of it");
  assert.equal(Number(after.rows[0].stays), SEED.STAY_SEED.length,
    "and the stays are the same stays: a reseed cannot bill a guest a second folio");
  assert.equal(Number(after.rows[0].charges), Number(before.rows[0].charges),
    "the nights are written with random ids, so the guard has to sit above them");

  // The figures, not just the row counts: a second pass must not move a single
  // folio balance or re-issue a reference that is already on the board.
  const { rows: refs } = await q(pool, `SELECT count(DISTINCT reference) AS n FROM reservations`);
  assert.equal(Number(refs[0].n), SEED.STAY_SEED.length, "every stay still answers to its own reference");
});

test("the inventory matches the split the browser seeds", async () => {
  const { pool } = await boot();
  const { rows } = await q(pool, `SELECT property_id, count(*) AS n FROM rooms GROUP BY property_id`);
  assert.deepEqual(rows.map((r) => [r.property_id, Number(r.n)]).sort(),
    [["agm", 48], ["apa", 24], ["ari", 30]]);

  // The villa-first sequence means floor 1 of the Grand Marina is gardens and
  // deluxe kings; the two presidential suites sit at the top.
  const first = await q(pool, `SELECT number, type_id, floor FROM rooms WHERE id = 'agm-101'`);
  assert.deepEqual([first.rows[0].number, first.rows[0].type_id, first.rows[0].floor], ["101", "gv", 1]);
  const top = await q(pool, `SELECT id, type_id FROM rooms WHERE property_id = 'agm' ORDER BY number DESC LIMIT 2`);
  assert.deepEqual(top.rows.map((r) => r.type_id), ["ps", "ps"]);

  const mix = await q(pool, `SELECT type_id, count(*) AS n FROM rooms WHERE property_id = 'agm' GROUP BY type_id`);
  const by = mix.rows.reduce((m, r) => (m[r.type_id] = Number(r.n), m), {});
  assert.deepEqual(by, CAT.TYPE_COUNTS.agm);
  assert.equal(Object.values(by).reduce((a, b) => a + b, 0), 48, "the counts fill the hotel");

  const down = await q(pool, `SELECT number, hk_status, ooo_reason FROM rooms
                              WHERE property_id = 'agm' AND hk_status LIKE 'Out of%' ORDER BY number`);
  assert.equal(down.rows.length, 2);
  assert.equal(down.rows[0].hk_status, "Out of service");
  assert.match(down.rows[0].ooo_reason, /AC compressor/);
  assert.equal(down.rows[1].hk_status, "Out of order");
  assert.match(down.rows[1].ooo_reason, /re-grouting/);
});

test("the seeded board opens as a trading day, not an empty shelf", async () => {
  const { pool, day } = await boot();
  const audit = require("../src/lib/audit");
  const pack = await audit.pack("agm");

  // 48 keys, two down, thirty-one of them shut on a guest tonight: the
  // flagship trades at the 67.4% the browser's board opens on, not at the four
  // keys the named stays alone could hold.
  assert.equal(pack.metrics.sellable, 46);
  assert.equal(pack.metrics.occupied, 31);
  assert.equal(pack.metrics.inHouse, 31);
  assert.equal(pack.metrics.availableTonight, 15);
  assert.equal(pack.metrics.occupancy, 67.4);
  assert.equal(pack.metrics.arrivals, 1, "one guest is due this afternoon");
  assert.equal(pack.metrics.departures, 1, "one folio has to be settled before the guest goes");
  assert.equal(pack.noShows.length, 1, "and one never turned up");
  // The three figures the dashboard is judged on, none of them a zero any more.
  assert.ok(pack.metrics.occupancy > 0, "occupancy reads off a board that trades");
  assert.ok(pack.metrics.adr > 0, "ADR has stays behind it");
  assert.ok(pack.metrics.revpar > 0, "and RevPAR is the two multiplied");
  assert.ok(pack.metrics.balanceDue > 0, "the house is carrying money");
  assert.equal(pack.metrics.dirty, 1, "only the room left this morning is for the floor");
  assert.equal(pack.metrics.ooo, 2);

  // The two boards agree room by room: every guest standing in a room tonight has
  // that room marked occupied, and no history booking from three weeks ago can
  // dirty a room somebody is living in.
  const { rows: held } = await q(pool, `SELECT rm.number, rm.hk_status FROM reservations r
    JOIN rooms rm ON rm.id = r.room_id
    WHERE r.property_id='agm' AND r.status='In-house' AND r.check_in <= $1 AND r.check_out > $1`, [day]);
  assert.equal(held.length, 31, "thirty-one keys are held tonight");
  assert.ok(held.every((h) => h.hk_status === "Occupied"),
    held.filter((h) => h.hk_status !== "Occupied").map((h) => `${h.number}:${h.hk_status}`).join(" "));

  // The close is not a clean sheet either. The departure the desk has not
  // actioned yet is still holding its key, so it owes the night that is passing —
  // the one job the run has that the booking door did not already do.
  assert.equal(pack.unbilled.length, 1);
  assert.deepEqual([pack.unbilled[0].res.reference, pack.unbilled[0].date], ["AGM-4", day]);
  assert.ok(pack.unbilledTotal > 0, "and the close can put a figure on it");
  assert.equal(pack.unbillable.length, 0);
  assert.equal(pack.unresolved.length, 31, "every folio in house still carries a balance");

  const checks = await audit.checks(pack);
  assert.equal(checks.length, 8);
  assert.ok(checks.every((c) => c.key && c.title && c.detail));
  assert.match(checks.find((c) => c.key === "roomtax").detail, /1 unbilled night worth .* this run posts them/);
  assert.match(checks.find((c) => c.key === "folios").detail, /31 in-house folios carry a balance/);
  assert.match(checks.find((c) => c.key === "arrivals").detail, /1 confirmed arrivals · 1 no-shows/);
  assert.match(checks.find((c) => c.key === "housekeeping").detail, /1 dirty · 2 out of order/);
  assert.ok(Number(checks.find((c) => c.key === "revenue").detail.replace(/[^\d]/g, "")) > 0,
    "the day's money is the day's own: " + checks.find((c) => c.key === "revenue").detail);
  // The catalogue sells in dollars and the treasury's fixing is one day old, so
  // the close has nothing to warn about on a freshly seeded day.
  assert.deepEqual(pack.catalogue, ["USD"]);
  assert.deepEqual(pack.rates, []);
  assert.match(checks.find((c) => c.key === "currency").detail, /Every currency the catalogue sells in/);

  // The Reserve and the capital are not leftovers beside the flagship: each
  // opens on the browser's own board — 16 of 28 keys and 15 of 22 — in the same
  // room mix. The mix is the point, not only the count: a hotel full of the
  // wrong rooms is a hotel nobody walked through.
  const boards = {
    ari: { occupied: 16, sellable: 28, occupancy: 57.1, mix: { gv: 1, dk: 6, dt: 4, pv: 3, es: 2 } },
    apa: { occupied: 15, sellable: 22, occupancy: 68.2, mix: { gv: 1, dk: 7, dt: 2, pv: 2, es: 2, ps: 1 } },
  };
  for (const [pid, want] of Object.entries(boards)) {
    const p = await audit.pack(pid);
    assert.deepEqual([p.metrics.occupied, p.metrics.sellable, p.metrics.occupancy],
      [want.occupied, want.sellable, want.occupancy], `${pid} trades at the browser's board`);
    const { rows } = await q(pool, `SELECT room_type_id, count(*) AS n FROM reservations
      WHERE property_id = $1 AND status = 'In-house' AND check_in <= $2 AND check_out > $2
      GROUP BY room_type_id`, [pid, day]);
    assert.deepEqual(rows.reduce((m, r) => (m[r.room_type_id] = Number(r.n), m), {}), want.mix,
      `${pid}'s keys are filled in the browser's room mix`);
  }

  // The group reads as three hotels trading, not one: every property has a guest
  // in it tonight and money on the day.
  for (const pid of ["agm", "ari", "apa"]) {
    const p = await audit.pack(pid);
    assert.ok(p.metrics.occupied > 0, `${pid} has a guest in house`);
    assert.ok(p.charges.length > 0, `${pid} posted money today`);
    assert.ok(p.payments.length > 0, `${pid} took money today`);
  }
});

test("every stay on the seeded board carries the money its own quote said", async () => {
  const { pool, day } = await boot();
  const P = require("../src/lib/price");
  const FX = require("../src/lib/fx");
  const biz = require("../src/lib/business-date");
  const cat = await P.catalogue();
  const fx = await FX.sources(day);

  const { rows: board } = await q(pool, `SELECT count(*) AS n FROM reservations`);
  assert.equal(Number(board[0].n), SEED.STAY_SEED.length, "one row per stay the seed walked");
  // Every hold that still owns a key is proved against the shelf it was taken
  // from: the seed allocates with the desk's own query, so a stay can never stand
  // in a room somebody else is standing in.
  const { rows: keyless } = await q(pool, `SELECT id, room_id, check_in, check_out FROM reservations
    WHERE status IN ('Confirmed','In-house') ORDER BY room_id, check_in`);
  // pg-mem cannot carry `room_id IS NOT NULL` through this filter, so the guard
  // lives here: a hold without a key is a walk-in quote nobody has allocated.
  const holds = keyless.filter((h) => h.room_id);
  const held = {};
  for (const h of holds) {
    const last = held[h.room_id];
    assert.ok(!last || biz.dstr(last.check_out) <= biz.dstr(h.check_in),
      last && `${h.room_id} is held by ${last.id} until ${biz.dstr(last.check_out)} and by ${h.id} from ${biz.dstr(h.check_in)}`);
    held[h.room_id] = h;
  }
  assert.equal(holds.length, SEED.STAY_SEED.filter((s) => s.status === "Confirmed" || s.status === "In-house").length,
    "every stay the seed called a hold is standing in a key");

  for (const spec of SEED.STAY_SEED) {
    const ci = biz.addDays(day, spec.in);
    const co = biz.addDays(ci, spec.n);
    const { rows: found } = await q(pool, `SELECT * FROM reservations
      WHERE guest_id=$1 AND property_id=$2 AND room_type_id=$3 AND check_in=$4`,
    [spec.gst, spec.prop, spec.type, ci]);
    assert.equal(found.length, 1, `${spec.gst} at ${spec.prop} on ${ci} is one stay, not two`);
    const res = found[0];
    const tag = res.reference;
    assert.equal(biz.dstr(res.check_out), co, `${tag} runs the nights the seed asked for`);
    assert.equal(res.status, spec.status);
    assert.equal(Number(res.adults), spec.adults || 1);
    assert.equal(Number(res.children), spec.children || 0);
    assert.equal(res.channel, spec.channel || "Direct");

    const quote = P.stayQuote(cat, spec.type, spec.plan, ci, co, spec.adults || 1,
      { propertyId: spec.prop, fx });
    assert.ok(quote, `${tag} is quotable on the seeded price lists`);

    const sold = !["Cancelled", "No-show", "Waitlist"].includes(spec.status);
    if (!sold) {
      const { rows: none } = await q(pool, `SELECT
        (SELECT count(*) FROM charges WHERE reservation_id=$1) AS c,
        (SELECT count(*) FROM payments WHERE reservation_id=$1) AS p`, [res.id]);
      assert.deepEqual([Number(none[0].c), Number(none[0].p)], [0, 0],
        `${tag} was a ${spec.status.toLowerCase()}: nothing was consumed, so nothing is billed`);
      if (spec.status === "Waitlist") {
        /* A waitlisted stay holds no key and owes nothing, but it is priced: the
           card the desk reads quotes the stay it will become. */
        assert.equal(res.room_id, null, `${tag} is waiting, so it stands in no room`);
        assert.equal(Number(res.room_total), quote.roomTotal, `${tag}'s quote is its nights added`);
        assert.equal(Number(res.total), quote.total, `${tag} quotes what an offer would bill`);
      } else {
        assert.equal(res.total, null, `${tag} carries no money figures`);
      }
      continue;
    }

    /* The nights, line for line, in the order the booking door wrote them. */
    const { rows: rooms } = await q(pool, `SELECT charge_date, amount, posted_by FROM charges
      WHERE reservation_id=$1 AND department='Rooms' AND NOT voided ORDER BY charge_date`, [res.id]);
    assert.deepEqual(rooms.map((c) => [biz.dstr(c.charge_date), Number(c.amount)]),
      quote.nightly.map((n) => [n.date, n.rate]),
      `${tag} is billed one line per night, at the rate the night sells at`);
    assert.ok(rooms.every((c) => c.posted_by === "Front desk"), `${tag} was billed by the door that opened it`);

    /* The stay's own taxes. A laundry order's tax lines are billed against the
       washing and are proved on the rail's own test, so they are not the room's
       twice-taxed night. */
    const { rows: tax } = await q(pool, `SELECT description, amount, charge_date FROM charges
      WHERE reservation_id=$1 AND department='Taxes & service'
        AND description NOT LIKE '% — laundry %' ORDER BY amount`, [res.id]);
    assert.deepEqual(tax.map((t) => [t.description, Number(t.amount)]),
      quote.taxLines.map((l) => [l.label, l.amount]).sort((a, b) => a[1] - b[1]),
      `${tag} is taxed once, over the room total`);
    assert.ok(tax.every((t) => biz.dstr(t.charge_date) === co), `${tag}'s tax is dated the departure`);

    /* What the guest consumed, read back off the same catalogue the tray was
       ordered from. */
    let extrasTotal = 0;
    for (const x of spec.extras || []) {
      const date = biz.addDays(ci, x.on);
      const svc = P.serviceOf(cat, "restaurant", x.svc);
      assert.ok(svc && svc.active, `${tag} is billed for ${x.svc}, which is not on the menu`);
      const hit = P.resolve(cat.prices, cat.lists, svc.id, { date });
      assert.ok(hit, `${tag} is billed for ${x.svc} on ${date}, when no list sells it`);
      const value = P.amount(hit.price, svc, { date, qty: x.qty });
      extrasTotal += value.lines;
      const { rows: line } = await q(pool, `SELECT amount, department, currency FROM charges
        WHERE reservation_id=$1 AND charge_date=$2 AND service_id=$3`, [res.id, date, svc.id]);
      assert.equal(line.length, 1, `${tag} carries one ${svc.name} line on ${date}`);
      assert.equal(Number(line[0].amount), value.lines, `${tag}'s ${svc.name} is billed at the menu`);
      assert.equal(line[0].department, svc.outlet.dept, `${tag}'s ${svc.name} earns for ${svc.outlet.dept}`);
      assert.equal(line[0].currency, hit.price.currency);
    }

    /* The stay says what its own lines say. */
    assert.equal(Number(res.room_total), quote.roomTotal, `${tag}'s room total is its nights added`);
    assert.equal(Number(res.service_chg), quote.service, `${tag} carries the service charge it was taxed`);
    assert.equal(Number(res.vat_amount), quote.vat, `${tag} carries the VAT it was taxed`);
    assert.equal(Number(res.total), quote.total, `${tag} is sold for the quote, not the quote plus a rounding`);
    assert.equal(res.currency, quote.currency, `${tag} is kept in one money`);
    assert.equal(Number(res.deposit), quote.deposit,
      `${tag}'s deposit is the share the plan asked for, not every payment the folio has seen`);

    const { rows: paid } = await q(pool, `SELECT amount, payment_date FROM payments
      WHERE reservation_id=$1 ORDER BY payment_date`, [res.id]);
    const took = paid.reduce((s, p) => s + Number(p.amount), 0);
    /* A stay that has left pays its whole folio on the way out; a stay still on
       the board has paid only the share its plan asks for. Anything else on the
       shelf is money the desk took early. */
    const settled = spec.status === "Checked out";
    const owed = settled ? quote.total + extrasTotal : quote.deposit;
    assert.equal(took, Math.round(owed),
      `${tag} (${spec.status}) has paid ${settled ? "its settled folio" : "only its deposit"}`);
    if (quote.deposit > 0 && settled) {
      assert.equal(paid.length, 2, `${tag} paid a deposit and then the rest at the desk`);
    }
    if (quote.deposit > 0) {
      const at = spec.status === "Confirmed" ? day : ci;
      assert.ok(paid.some((p) => Number(p.amount) === quote.deposit && biz.dstr(p.payment_date) === at),
        `${tag} paid its deposit on ${at}, the day the plan asks for it`);
    }
    if (settled) {
      const { rows: billed } = await q(pool,
        `SELECT COALESCE(sum(amount),0) AS v FROM charges WHERE reservation_id=$1 AND NOT voided`, [res.id]);
      assert.equal(Number(billed[0].v) - took, 0, `${tag} left with nothing owing`);
    }
  }
});

test("the waitlist opens on one live release, on a key the counter agrees is free", async () => {
  const { pool, day } = await boot();
  const BOOKING = require("../src/lib/booking");
  const biz = require("../src/lib/business-date");

  const { rows: waiting } = await q(pool,
    `SELECT r.*, g.name AS guest_name FROM reservations r JOIN guests g ON g.id = r.guest_id
      WHERE r.status = 'Waitlist' ORDER BY r.created_at`);
  assert.equal(waiting.length, 1, "the board carries one request the desk could not seat");
  const wait = waiting[0];
  assert.equal(wait.room_id, null, "a waitlisted stay holds no key");
  assert.ok(Number(wait.total) > 0, "and is priced at the quote it was taken on");
  assert.ok(biz.dstr(wait.created_at) < day, "the request is days old, not minutes");

  const { rows: offers } = await q(pool, `SELECT * FROM waitlist_offers`);
  assert.equal(offers.length, 1, "one release stands on the desk's board");
  const offer = offers[0];
  assert.equal(offer.id, "wlo_seed1");
  assert.equal(offer.reservation_id, wait.id);
  assert.equal(offer.property_id, wait.property_id);
  assert.equal(offer.room_type_id, wait.room_type_id);
  assert.equal(offer.status, "Offered");
  assert.ok(new Date(offer.expires_at) > new Date(), "the hold is still live");
  const hours = (new Date(offer.expires_at) - new Date(offer.offered_at)) / 3600000;
  assert.ok(Math.abs(hours - 24) < 0.01, `the hold runs 24 hours, not ${hours}`);
  assert.ok(offer.notified_at, "the guest was told when the room was released");

  // The room named on the offer is free by the counter's own availability rule,
  // not merely by the seed's word.
  const free = await BOOKING.freeRooms(pool, wait.property_id, wait.room_type_id,
    biz.dstr(wait.check_in), biz.dstr(wait.check_out));
  assert.ok(free.some((r) => r.id === offer.room_id), "the offered key is on the free shelf");

  // Nothing was billed to the request, and the release is not announced as news
  // the install never wrote.
  const { rows: money } = await q(pool,
    `SELECT (SELECT count(*) FROM charges WHERE reservation_id=$1) AS c,
            (SELECT count(*) FROM payments WHERE reservation_id=$1) AS p`, [wait.id]);
  assert.deepEqual([Number(money[0].c), Number(money[0].p)], [0, 0]);
  assert.equal((await q(pool, `SELECT count(*) AS n FROM notifications WHERE type = 'Waitlist release'`))
    .rows[0].n, 0, "a hold that has stood since the seed is not news");
});

test("a seeded departure credits the club through the counter's own award", async () => {
  const { pool } = await boot();
  const LOY = require("../src/lib/loyalty");
  const folio = require("../src/lib/folio");

  const { rows: left } = await q(pool, `SELECT r.*, g.tier FROM reservations r
    JOIN guests g ON g.id = r.guest_id WHERE r.status = 'Checked out' ORDER BY r.id`);
  assert.equal(left.length, SEED.STAY_SEED.filter((s) => s.status === "Checked out").length);
  assert.ok(left.length > 0, "the board carries departures to credit");

  // Each departure carries what its own folio earned at the guest's tier — the
  // same figure the check-out door writes, because it is the same function.
  for (const r of left) {
    const f = await folio.read(r.id, pool);
    assert.equal(Number(r.points_awarded), LOY.pointsFor(f.baseTotal, r.tier),
      `${r.reference} earned what its folio is worth at ${r.tier}`);
    assert.ok(Number(r.points_awarded) > 0, `${r.reference} is worth a nonzero credit`);
    assert.equal(f.balance, 0, `${r.reference} was settled before it left`);
  }

  // The profile balances moved with them: the authored figure plus every
  // departure on the board (gst_8 left twice, once in each house).
  const { rows: guests } = await q(pool, `SELECT id, loyalty_pts FROM guests`);
  const byId = Object.fromEntries(guests.map((g) => [g.id, Number(g.loyalty_pts)]));
  const earned = {};
  for (const r of left) earned[r.guest_id] = (earned[r.guest_id] || 0) + Number(r.points_awarded);
  for (const [gid, pts] of Object.entries(earned)) {
    const author = SEED.GUEST_SEED.find((g) => g.id === gid);
    assert.equal(byId[gid], author.pts + pts, `${gid} holds the book's balance plus what they earned`);
  }

  // One trail line per departure, signed by the hand that settled the folio.
  const { rows: trail } = await q(pool, `SELECT * FROM activity_log WHERE action = 'earned loyalty points'`);
  assert.equal(trail.length, left.length, "one line per departure, and none for a stay still in house");
  for (const r of left) {
    const line = trail.find((t) => t.detail.includes(r.reference));
    assert.ok(line, `${r.reference}'s award is in the trail`);
    assert.equal(line.actor, "Adamu Bello");
    assert.match(line.detail, new RegExp(`${r.points_awarded} pts · ${r.reference}$`));
  }

  // A stay that is still standing has earned nothing yet: its points are what
  // the desk will credit when it signs the departure off.
  const { rows: stays } = await q(pool, `SELECT * FROM reservations`);
  const open = stays.filter((s) => s.status !== "Checked out");
  assert.ok(open.length > 0);
  assert.ok(open.every((s) => s.points_awarded === null || s.points_awarded === undefined),
    "no stay that has not left carries an award");
  const inHouse = stays.find((s) => s.status === "In-house");
  assert.ok((await LOY.pending(inHouse.id)) > 0, "an in-house folio still has points to earn");
});

test("the dashboard's today strip is the close's own numbers", async () => {
  const { pool, day } = await boot();
  const request = require("supertest");
  const audit = require("../src/lib/audit");
  const biz = require("../src/lib/business-date");
  const { sign } = require("../src/lib/jwt");
  const app = require("../src/index");

  const perms = (await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`)).rows[0].data;
  const gm = (await q(pool, `SELECT * FROM users WHERE role = 'Manager'`)).rows[0];
  const bearer = "Bearer " + sign({
    id: gm.id, email: gm.email, name: gm.name, role: "Manager",
    propertyId: gm.property_id, guestId: null, permissions: perms.Manager,
  });
  const get = (url) => request(app).get(url).set("Authorization", bearer);

  const strip = await get("/api/metrics/agm/today");
  assert.equal(strip.status, 200, JSON.stringify(strip.body));
  const pack = await audit.pack("agm");
  for (const key of Object.keys(pack.metrics)) {
    assert.equal(strip.body[key], pack.metrics[key], `${key} is the close's figure, not a second reading`);
  }
  assert.equal(strip.body.date, day, "the strip is dated the business day");
  assert.equal(strip.body.occupied, 31);
  assert.equal(strip.body.arrivals, 1);
  assert.equal(strip.body.vipArrivals, 1, "the one arrival is a VIP, tier or no tick");
  const { rows: queue } = await q(pool, `SELECT count(*) AS n FROM tasks
    WHERE property_id = 'agm' AND status != 'Done'`);
  assert.equal(strip.body.openTasks, Number(queue[0].n), "the strip counts the board's own open work");
  assert.ok(Number(queue[0].n) > 0, "and the seed leaves the floor something to action");
  assert.equal(strip.body.inHouseList.length, 31);
  assert.deepEqual(strip.body.departureList.map((r) => r.reference), ["AGM-4"]);

  /* The date moves and only one of the two doors follows it — which is the whole
     reason the strip reads the close rather than the clock on the wall. Four
     stays are still in house two days on: the anniversary suite and the three
     fills that booked through the third night. */
  const rolled = biz.addDays(day, 2);
  await biz.setBusinessDay(rolled);
  const later = await get("/api/metrics/agm/today");
  assert.equal(later.body.date, rolled, "the strip moves with the business date, not the calendar");
  assert.equal(later.body.occupied, (await audit.pack("agm")).metrics.occupied);
  assert.equal(later.body.occupied, 4, "only the long stays are still in house two days on");
});

test("a desk working from the seed alone can book and bill a stay", async () => {
  const { pool, day } = await boot();
  const request = require("supertest");
  const biz = require("../src/lib/business-date");
  const P = require("../src/lib/price");
  const { sign } = require("../src/lib/jwt");
  const app = require("../src/index");

  // The tokens carry the permissions the seed wrote, not a fixture's.
  const perms = (await q(pool, `SELECT data FROM staff_permissions WHERE id = 1`)).rows[0].data;
  const tokenFor = async (role) => {
    const u = (await q(pool, `SELECT id, email, name, property_id, guest_id FROM users WHERE role = $1`, [role])).rows[0];
    return "Bearer " + sign({
      id: u.id, email: u.email, name: u.name, role,
      propertyId: u.property_id, guestId: u.guest_id, permissions: perms[role] || {},
    });
  };
  const tokens = { Manager: await tokenFor("Manager"), "Front Desk": await tokenFor("Front Desk") };
  const get = (role, url) => request(app).get(url).set("Authorization", tokens[role]);
  const post = (role, url) => request(app).post(url).set("Authorization", tokens[role]);

  // Where the day stood before the desk picked up the phone.
  const first = await get("Manager", "/api/audit/pack?propertyId=agm");
  assert.equal(first.status, 200);

  const booked = await post("Front Desk", "/api/reservations").send({
    propertyId: "agm", guestId: "gst_1", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: day, checkOut: biz.addDays(day, 2), adults: 2,
  });
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.match(booked.body.room_id, /^agm-\d+$/, "a real key, not a null assignment");
  const key = (await q(pool, `SELECT type_id FROM rooms WHERE id = $1`, [booked.body.room_id])).rows[0];
  assert.equal(key.type_id, "dk");

  // The desk's own booking bills the stay it opens: two nights at the seeded
  // ₦185,000, each one carrying the 15% weekend uplift the standard list puts on
  // a Friday or Saturday, then the two taxes on the room total. Those figures are
  // the counter's quote, and the folio of a booked stay is never empty.
  const opened = await get("Front Desk", `/api/reservations/${booked.body.id}/folio`);
  assert.equal(opened.status, 200);
  const nightly = [day, biz.addDays(day, 1)].map((d) => [d, P.isWeekend(d) ? 212750 : 185000]);
  assert.deepEqual(
    opened.body.charges.filter((c) => c.department === "Rooms")
      .sort((a, b) => (a.charge_date < b.charge_date ? -1 : 1))
      .map((c) => [String(c.charge_date).slice(0, 10), Number(c.amount), c.posted_by]),
    nightly.map((n) => [n[0], n[1], "Adamu Bello"]),
    "one line per night, dated the stay's own nights, at the rate the night sells at");
  const roomTotal = nightly.reduce((s, n) => s + n[1], 0);
  const svc = P.round50(roomTotal * 0.1);
  const vat = P.round50((roomTotal + svc) * 0.075);
  assert.deepEqual(
    opened.body.charges.filter((c) => c.department === "Taxes & service")
      .map((c) => [c.description, Number(c.amount)]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    [["Service charge (10%)", svc], ["VAT (7.5%)", vat]], "taxes once, on the room total");
  assert.equal(opened.body.total, roomTotal + svc + vat);
  assert.equal(opened.body.balance, roomTotal + svc + vat, "nothing has been paid on it yet");

  // The board the desk reads is the seeded one, not an empty shelf: fourteen
  // deluxe kings, eight of them let across these dates and one less now that a
  // key is held for this booking, and the held key off the list.
  const span = `checkIn=${day}&checkOut=${biz.addDays(day, 2)}`;
  const after = await get("Front Desk", `/api/rooms/types/dk/availability?${span}`);
  assert.equal(after.status, 200);
  assert.equal(after.body.free, 5);
  assert.ok(!after.body.rooms.includes(booked.body.room_id), "the key just handed out is not offered twice");
  // Eight executive suites, two of them down for maintenance and four of the
  // remaining six let — the anniversary guest and three fills — leaves two.
  assert.equal((await get("Front Desk", `/api/rooms/types/es/availability?${span}`)).body.free, 2,
    "two suites are out of order and four are let");
  // Ten premier views, none down, eight of them held across these very dates by
  // the club-rate guest in house, the family due this afternoon and six fills.
  assert.equal((await get("Front Desk", `/api/rooms/types/pv/availability?${span}`)).body.free, 2,
    "a hold on the shelf takes the type down, whatever its status says");

  const night = await post("Front Desk", `/api/reservations/${booked.body.id}/charges`).send({
    description: "Room charge · Deluxe King", department: "Rooms", amount: 185000, date: day,
  });
  assert.equal(night.status, 201, JSON.stringify(night.body));

  const { rows: preSeries } = await q(pool, `SELECT seq FROM invoice_series WHERE id = 1`);
  const raised = await post("Front Desk", "/api/billing/invoices").send({ reservationId: booked.body.id });
  assert.equal(raised.status, 201, JSON.stringify(raised.body));
  const next = Number(preSeries[0].seq) + 1;
  assert.equal(raised.body.number, `AGM-INV-${String(next).padStart(4, "0")}`,
    "the desk draws the next number in the series the seed started");
  assert.equal(raised.body.totals.lines, roomTotal + svc + vat + 185000,
    "the nights the booking billed, plus the ₦185,000 the desk posted on top");

  // The audit reads the same seeded inventory, and the desk's new booking moves
  // exactly the figures a booking is supposed to move: one more arrival, one more
  // charge on the day, and nothing else. The thirty-one stays already in house
  // own the occupancy, the ADR and the night the close still owes.
  const pack = await get("Manager", "/api/audit/pack?propertyId=agm");
  assert.equal(pack.status, 200);
  assert.equal(pack.body.metrics.arrivals, 2, "the seeded arrival and the one the desk just took");
  assert.equal(pack.body.metrics.sellable, 46);
  assert.equal(pack.body.metrics.occupied, 31, "a booking is not a stay in house");
  assert.equal(pack.body.metrics.adr, first.body.metrics.adr, "and it does not move the yield");
  assert.deepEqual(pack.body.unbilled.map((n) => [n.res.reference, n.date]),
    first.body.unbilled.map((n) => [n.res.reference, n.date]),
    "the new booking billed its own nights at the door, so the close owes no more than it did");
  assert.ok(pack.body.unbilledTotal > 0, "the un-actioned departure still owes tonight");

  // And the desk still cannot close the day with the seeded permission map.
  const closed = await post("Front Desk", "/api/audit/run").send({ checks: {} });
  assert.equal(closed.status, 403);
});
