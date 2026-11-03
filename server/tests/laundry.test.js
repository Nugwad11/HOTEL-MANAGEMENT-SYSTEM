/**
 * Laundry over the API — the port of `LHMS.actions.createLaundryOrder` and of
 * `LHMS.actions.setLaundryStatus`.
 *
 * The figures are the browser's, to the naira, because both layers ask the same
 * engine: a shirt is ₦2,500, express work is half the turnaround for fifty per
 * cent more, the service charge compounds before VAT, and every line of the order
 * is a line of the guest's folio. What the ledger kept is asked straight from the
 * tables, so a page cannot be the proof.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, dstr, DAY } = require("./helpers/api");

const HOUSE = "Grace Mensah";       // the Housekeeping identity the fixture signs in
const n = (v) => (v === null || v === undefined ? null : Number(v));

const take = (ctx, body, role = "Housekeeping") =>
  ctx.as(role).post("/api/laundry").send(body);
const folioOf = async (ctx, id) => (await ctx.as("Front Desk").get(`/api/reservations/${id}/folio`)).body;
const rowsOf = async (ctx, sql, p) => (await ctx.query(sql, p || [])).rows;
const boardOf = (ctx) => rowsOf(ctx, `SELECT * FROM laundry_orders`);

/** The four money figures of an order, as numbers. */
const figures = (o) => ({
  subtotal: n(o.subtotal), tax: n(o.tax), total: n(o.total), currency: o.currency,
});

/** The minutes between now and the promised collection. */
const etaMins = (o) => Math.round((new Date(o.due_at).getTime() - Date.now()) / 60000);

test("an express order is priced by the engine and posted line for line", async () => {
  const ctx = await boot();
  const before = await folioOf(ctx, "res_1");
  assert.equal(before.total, 218000);
  assert.equal(before.balance, 118000);

  const out = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 4, ld_suit: 1 }, express: true });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = out.body;

  assert.equal(o.ref, "LD-0001");
  assert.equal(o.status, "Received");
  assert.equal(o.reservation_id, "res_1");
  assert.equal(o.guest_id, "gst_1");
  assert.equal(o.property_id, "agm");
  assert.equal(o.room_number, "101", "the board shows the room the washing came from");
  assert.equal(o.express, true);
  assert.deepEqual(figures(o), { subtotal: 26250, tax: 4800, total: 31050, currency: "NGN" });

  // ₦2,500 and ₦7,500 with a fifty per cent express uplift, each line rounded to
  // the fifty it is billed at.
  const items = o.items;
  assert.deepEqual(items.map((l) => l.name), ["Shirt — wash and press", "Two-piece suit"]);
  assert.deepEqual(items.map((l) => n(l.unit_price)), [3750, 11250]);
  assert.deepEqual(items.map((l) => n(l.amount)), [15000, 11250]);
  assert.deepEqual(items.map((l) => n(l.base_price)), [2500, 7500], "the listed price stays on the line");
  assert.deepEqual(items.map((l) => n(l.qty)), [4, 1]);
  items.forEach((l) => assert.equal(n(l.unit_price) * n(l.qty), n(l.amount)));
  assert.deepEqual(items[0].added, [{ label: "Express service", amount: 5000 }],
    "the uplift is shown on the line, not buried in the rate");
  assert.deepEqual(items.map((l) => l.price_id), ["prc_ld_shirt_std", "prc_ld_suit_std"]);
  assert.deepEqual(items.map((l) => l.list_name), ["Standard 2026", "Standard 2026"]);

  // Compounded in order, so VAT lands on the service charge as it does on paper.
  assert.deepEqual(o.tax_lines.map((t) => [t.label, n(t.amount)]),
    [["Service charge (10%)", 2650], ["VAT (7.5%)", 2150]]);
  assert.equal(n(o.subtotal) + n(o.tax), n(o.total));

  // The slowest garment — the suit, at eight hours — halves under express.
  assert.ok(Math.abs(etaMins(o) - 240) <= 1, `promised in ${etaMins(o)} minutes, expected 240`);

  // Every line of the order is a line of the folio, and the folio moved by
  // exactly what was quoted.
  const charged = await rowsOf(ctx,
    `SELECT * FROM charges WHERE reservation_id = 'res_1' AND id NOT IN ('chg_1','chg_2')`);
  assert.equal(charged.length, 4, "two garments and two taxes");
  assert.equal(charged.reduce((s, c) => s + n(c.amount), 0), 31050);
  assert.deepEqual(charged.map((c) => c.department).sort(),
    ["Other", "Other", "Taxes & service", "Taxes & service"]);
  const after = await folioOf(ctx, "res_1");
  assert.equal(after.total, 249050);
  assert.equal(after.balance, 149050);

  const byId = {};
  charged.forEach((c) => { byId[c.id] = c; });
  items.forEach((l) => {
    assert.ok(l.charge_id, "the garment points at the line it was billed on");
    const c = byId[l.charge_id];
    assert.equal(n(c.amount), n(l.amount));
    assert.equal(c.posted_by, HOUSE);
    assert.equal(c.description, n(l.qty) > 1 ? `${l.qty} × ${l.name}` : l.name);
    assert.equal(dstr(c.charge_date), DAY, "on the open business day");
  });
  o.tax_lines.forEach((t) => {
    const c = byId[t.chargeId];
    assert.equal(c.department, "Taxes & service");
    assert.equal(c.posted_by, "System", "the tax is the engine's, not the desk's");
    assert.equal(c.description, `${t.label} — laundry ${o.ref}`);
  });

  const trail = await rowsOf(ctx, `SELECT * FROM activity_log WHERE entity = 'laundry'`);
  assert.equal(trail.length, 1);
  assert.equal(trail[0].actor, HOUSE);
  assert.equal(trail[0].action, "took a laundry order");
  assert.match(trail[0].detail, /LD-0001 · Room 101 · 2 lines · NGN 31,050 · express/);

  // And the board reads the order back the same way it was answered.
  const read = await ctx.as("Housekeeping").get(`/api/laundry/${o.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.body.guest_name, "Adaeze Nwankwo");
  assert.deepEqual(read.body.items.map((l) => n(l.amount)), [15000, 11250]);
  const board = await ctx.as("Housekeeping").get("/api/laundry?status=Received");
  assert.equal(board.body.length, 1);
  assert.equal(board.body[0].ref, "LD-0001");
});

test("the slowest garment sets the collection time of an ordinary order", async () => {
  const ctx = await boot();
  // A towel takes six hours and a household load twenty-four: the order promises
  // the twenty-four, because nothing can be returned before the last item is back.
  const out = await take(ctx, {
    reservationId: "res_1", items: [{ id: "ld_towel", qty: 6 }, { id: "ld_load", qty: 1 }],
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = out.body;

  assert.deepEqual(figures(o), { subtotal: 22800, tax: 4200, total: 27000, currency: "NGN" });
  assert.deepEqual(o.items.map((l) => [l.name, n(l.amount)]), [["Bath towel", 10800], ["Household load", 12000]]);
  assert.deepEqual(o.tax_lines.map((t) => n(t.amount)), [2300, 1900]);
  assert.equal(o.express, false);
  o.items.forEach((l) => assert.deepEqual(l.added, [], "nothing is added to an order nobody asked to rush"));
  assert.ok(Math.abs(etaMins(o) - 1440) <= 1, `promised in ${etaMins(o)} minutes, expected 1440`);
  assert.equal((await folioOf(ctx, "res_1")).balance, 118000 + 27000);
});

test("a caller cannot type a price, a currency or a collection time", async () => {
  const ctx = await boot();
  const out = await take(ctx, {
    reservationId: "res_1",
    items: [{ id: "ld_shirt", qty: 1, unitPrice: 1, amount: 1, name: "Shirt", serviceId: "svc_other" }],
    total: 999999, currency: "USD", etaMins: 5, tax: 0, propertyId: "ari",
  });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = out.body;

  // ₦2,500, a ₦250 service charge and ₦200 of VAT — the engine's figures, and the
  // order filed on the property that keeps the stay, not the one it was aimed at.
  assert.deepEqual(figures(o), { subtotal: 2500, tax: 450, total: 2950, currency: "NGN" });
  assert.equal(o.property_id, "agm");
  assert.equal(o.items[0].service_id, "svc_ld_shirt");
  assert.equal(o.items[0].name, "Shirt — wash and press", "the catalogue names the garment");
  assert.equal(n(o.items[0].unit_price), 2500);
  assert.ok(Math.abs(etaMins(o) - 240) <= 1, `the shirt's own turnaround, not the caller's ${etaMins(o)}`);
  assert.equal((await folioOf(ctx, "res_1")).balance, 118000 + 2950);
});

test("a refused order leaves no line on the board and no charge on the folio", async () => {
  const ctx = await boot();
  const before = await folioOf(ctx, "res_1");

  const gone = await take(ctx, { reservationId: "res_2", items: { ld_shirt: 1 } });
  assert.equal(gone.status, 422);
  assert.match(gone.body.error, /Laundry is only taken for a guest staying with us/);

  const nobody = await take(ctx, { reservationId: "res_nope", items: { ld_shirt: 1 } });
  assert.equal(nobody.status, 422);
  assert.match(nobody.body.error, /Choose the guest the washing belongs to/);

  const empty = await take(ctx, { reservationId: "res_1", items: {} });
  assert.equal(empty.status, 422);
  assert.match(empty.body.error, /Choose at least one service that is being offered/);

  const unknown = await take(ctx, { reservationId: "res_1", items: { not_a_service: 2 } });
  assert.equal(unknown.status, 422);
  assert.match(unknown.body.error, /not one of our laundry services/);

  await ctx.query(`UPDATE services SET active = false WHERE id = 'svc_ld_towel'`);
  const dark = await take(ctx, { reservationId: "res_1", items: { ld_towel: 6 } });
  assert.equal(dark.status, 422);
  assert.match(dark.body.error, /Choose at least one service that is being offered/);

  // One live line is not a licence to bill for the dead one: the desk is told
  // which garment it rang in that the laundry is not running.
  const partly = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 2, ld_towel: 3 } });
  assert.equal(partly.status, 422);
  assert.match(partly.body.error, /Bath towel is not being offered right now/);

  assert.equal((await boardOf(ctx)).length, 0, "a refused order leaves nothing on the board");
  const charges = await rowsOf(ctx, `SELECT * FROM charges WHERE reservation_id = 'res_1'`);
  assert.equal(charges.length, 2, "and nothing on the guest's account");
  const after = await folioOf(ctx, "res_1");
  assert.equal(after.total, before.total, "the folio never moved");
  assert.equal((await rowsOf(ctx, `SELECT * FROM activity_log WHERE entity = 'laundry'`)).length, 0);
});

test("one order is one money, whichever end of it disagrees", async () => {
  const ctx = await boot();
  const filed = await ctx.as("Manager").post("/api/fx/rates")
    .send({ code: "USD", perBase: 1550, note: "Treasury fixing" });
  assert.equal(filed.status, 201, JSON.stringify(filed.body));
  await ctx.query(`UPDATE prices SET currency = 'USD' WHERE id = 'prc_ld_towel_std'`);

  // A towel priced in dollars cannot ride in a naira order: the whole order is
  // refused rather than billed short.
  const mixed = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 2, ld_towel: 3 } });
  assert.equal(mixed.status, 422, JSON.stringify(mixed.body));
  assert.match(mixed.body.error, /^These lines mix NGN and USD/);
  assert.match(mixed.body.error, /one document is billed in one currency/);

  // Nor can it ride on a folio that is already kept in naira.
  const foreign = await take(ctx, { reservationId: "res_1", items: { ld_towel: 3 } });
  assert.equal(foreign.status, 422, JSON.stringify(foreign.body));
  assert.match(foreign.body.error, /This folio is billed in NGN, not USD/);
  assert.equal((await boardOf(ctx)).length, 0);

  // An empty folio takes the dollars, and every line keeps the rate it opened at.
  const settled = await take(ctx, { reservationId: "res_3", items: { ld_towel: 2 } });
  assert.equal(settled.status, 201, JSON.stringify(settled.body));
  const o = settled.body;
  assert.deepEqual(figures(o), { subtotal: 3600, tax: 650, total: 4250, currency: "USD" });
  assert.equal(n(o.fx_rate), 1550);
  assert.equal(n(o.base_amount), 4250 * 1550, "what the naira books keep for the washing");
  o.items.forEach((l) => {
    assert.equal(l.currency, "USD");
    assert.equal(n(l.fx_rate), 1550);
    assert.equal(n(l.base_amount), n(l.amount) * 1550);
  });
  const charged = await rowsOf(ctx, `SELECT * FROM charges WHERE reservation_id = 'res_3'`);
  assert.equal(charged.length, 3);
  assert.ok(charged.every((c) => c.currency === "USD" && n(c.fx_rate) === 1550));
  assert.equal(charged.reduce((s, c) => s + n(c.amount), 0), 4250);
  assert.equal((await folioOf(ctx, "res_3")).baseTotal, 4250 * 1550);
});

test("a sealed day cannot be written into, and nothing half-posts", async () => {
  const ctx = await boot();
  await ctx.query(`INSERT INTO closed_days (date,rolled_to,closed_at,closed_by,stats)
                   VALUES ($1,$2,now(),'Ifeoma Okafor','{}')`, [DAY, addDays(DAY, 1)]);

  const out = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 2 } });
  assert.equal(out.status, 422, JSON.stringify(out.body));
  assert.match(out.body.error, /closed and sealed/);
  assert.equal((await boardOf(ctx)).length, 0, "the board is clean");
  assert.equal((await rowsOf(ctx, `SELECT * FROM charges WHERE reservation_id = 'res_1'`)).length, 2,
    "and the transaction rolled the garments back with the order");
});

test("the board belongs to the laundry capability", async () => {
  const ctx = await boot();
  const front = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } }, "Front Desk");
  assert.equal(front.status, 403);
  assert.match(front.body.error, /Permission 'run_laundry' is required/);

  const audit = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } }, "Auditor");
  assert.equal(audit.status, 403);
  const signer = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } }, "Finance Manager");
  assert.equal(signer.status, 403);

  const house = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } });
  assert.equal(house.status, 201, JSON.stringify(house.body));
  const manager = await take(ctx, { reservationId: "res_1", items: { ld_towel: 2 } }, "Manager");
  assert.equal(manager.status, 201, JSON.stringify(manager.body));
  assert.equal(manager.body.ref, "LD-0002", "the sequence runs per property");

  // ₦2,950 for the shirt and ₦4,250 for the towels, all on one account.
  assert.equal((await folioOf(ctx, "res_1")).balance, 118000 + 2950 + 4250);
  assert.equal((await boardOf(ctx)).length, 2);
});

/* ── the stage machine (the port of LHMS.actions.setLaundryStatus) ── */

const move = (ctx, id, status, role = "Housekeeping") =>
  ctx.as(role).patch(`/api/laundry/${id}/status`).send({ status });
const trail = async (ctx) => (await rowsOf(ctx, `SELECT * FROM activity_log WHERE entity = 'laundry'`));

test("a card walks the board forward and each step is recorded", async () => {
  const ctx = await boot();
  const taken = await take(ctx, { reservationId: "res_1", items: { ld_shirt: 2 } });
  const o = taken.body;
  assert.equal(o.status, "Received");
  assert.equal(o.collected_at, null);
  const balance = (await folioOf(ctx, "res_1")).balance;

  const working = await move(ctx, o.id, "In progress");
  assert.equal(working.status, 200, JSON.stringify(working.body));
  assert.equal(working.body.status, "In progress");
  assert.equal(working.body.guest_name, "Adaeze Nwankwo", "the board reads the card back with its room and guest");
  assert.equal(working.body.room_number, "101");
  assert.equal(working.body.collected_at, null);

  const ready = await move(ctx, o.id, "Ready");
  assert.equal(ready.body.status, "Ready");
  assert.equal(ready.body.collected_at, null, "nothing is returned until it is handed over");

  const back = await move(ctx, o.id, "Collected");
  assert.equal(back.body.status, "Collected");
  assert.ok(back.body.collected_at, "the handover is timed");

  // A stage is not a bill: the washing was charged when the order was taken and
  // nothing about delivering it moves the account.
  assert.equal((await folioOf(ctx, "res_1")).balance, balance);

  const notes = await rowsOf(ctx, `SELECT * FROM notifications WHERE type = 'Laundry ready'`);
  assert.equal(notes.length, 1, "the team is told once, when the work is ready");
  assert.equal(notes[0].property_id, "agm");
  assert.match(notes[0].detail, /LD-0001 · Room 101/);
  assert.equal(notes[0].link, "#/laundry");

  const steps = await trail(ctx);
  assert.deepEqual(steps.map((s) => s.action).sort(), [
    "moved a laundry order to collected", "moved a laundry order to in progress",
    "moved a laundry order to ready", "took a laundry order",
  ].sort(), "every move the card made is on the trail");
  assert.ok(steps.every((s) => s.actor === HOUSE));
  assert.match(steps.find((s) => s.action.endsWith("to collected")).detail,
    /LD-0001 · Room 101 · was Ready/, "and the trail says what it moved from");
});

test("work does not run backwards, and a stage stated twice moves nothing", async () => {
  const ctx = await boot();
  const o = (await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } })).body;
  await move(ctx, o.id, "In progress");
  await move(ctx, o.id, "Ready");

  const back = await move(ctx, o.id, "In progress");
  assert.equal(back.status, 422, JSON.stringify(back.body));
  assert.equal(back.body.error, "An order cannot go back from Ready.");
  assert.equal((await move(ctx, o.id, "Received")).status, 422, "nor all the way to the start");
  assert.equal((await ctx.as("Housekeeping").get(`/api/laundry/${o.id}`)).body.status, "Ready",
    "a refusal leaves the card exactly where it stood");

  // Re-stating the stage a card already sits on is a refresh, not a move: no
  // second notification and no second trail line for a change that did not happen.
  const again = await move(ctx, o.id, "Ready");
  assert.equal(again.status, 200);
  assert.equal(again.body.status, "Ready");
  assert.equal((await rowsOf(ctx, `SELECT * FROM notifications`)).length, 1);
  assert.equal((await trail(ctx)).length, 3, "the taking and the two real moves");

  const nonsense = await move(ctx, o.id, "Shrunk");
  assert.equal(nonsense.status, 422);
  assert.match(nonsense.body.error, /Status must be one of: Received, In progress, Ready, Collected/);
  assert.equal((await move(ctx, "lda_nope", "Ready")).status, 404);
});

test("a card belongs to the property that took the washing", async () => {
  const ctx = await boot();
  const o = (await take(ctx, { reservationId: "res_1", items: { ld_shirt: 1 } })).body;

  // A card filed at the Reserve is not the flagship's laundry's to move — while
  // a group role, which reads every property, may.
  await ctx.query(`UPDATE laundry_orders SET property_id = 'ari' WHERE id = $1`, [o.id]);
  const elsewhere = await move(ctx, o.id, "In progress");
  assert.equal(elsewhere.status, 403, JSON.stringify(elsewhere.body));
  assert.match(elsewhere.body.error, /Access to this property is not permitted/);
  assert.equal((await ctx.as("Housekeeping").get(`/api/laundry/${o.id}`)).body.status, "Received",
    "the refusal wrote nothing");

  const seen = await move(ctx, o.id, "In progress", "Manager");
  assert.equal(seen.status, 200, JSON.stringify(seen.body));
  assert.equal(seen.body.status, "In progress");
});
