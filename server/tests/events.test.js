/**
 * Hall bookings over the API — the port of the quoting and the money path the
 * browser app runs, proven against the same SQL and the same price row.
 *
 * The desk never sends a total, so every figure asked for here is one the engine
 * said: the package moves with the weekend uplift because it lives on the hourly
 * row, the lines a booking posted are the lines it was quoted, a fee is owed only
 * inside the notice window the booking was sold on, and a called-off function
 * leaves its voids on the file rather than erasing them.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, dstr, DAY } = require("./helpers/api");

const W = addDays(DAY, 3);   // a Sunday: a weekday, and 69 hours from the noon the books stand at
const FRI = addDays(DAY, 1);
const FEST = "2026-12-25";   // a Friday, so only the festive list's own premium applies

const book = (ctx, over) => ctx.as("Manager").post("/api/events").send(Object.assign({
  hallId: "hall_grand", date: W, start: "10:00", end: "14:00",
  title: "Test booking", organizer: "Test organiser", guests: 40,
}, over || {}));
const booked = async (ctx, over) => {
  const out = await book(ctx, over);
  assert.equal(out.status, 201, JSON.stringify(out.body));
  return out.body;
};

const eventOf = async (ctx, id) => (await ctx.as("Manager").get(`/api/events/${id}`)).body;
const boardOf = async (ctx) => (await ctx.as("Manager").get("/api/events?propertyId=agm")).body;
const folioOf = async (ctx, id) => (await ctx.as("Front Desk").get(`/api/reservations/${id}/folio`)).body;
const rowsOf = async (ctx, sql, p) => (await ctx.query(sql, p || [])).rows;
const linesOf = async (ctx, id) => rowsOf(ctx, `SELECT * FROM event_lines WHERE event_id = $1 ORDER BY sort_order`, [id]);
const chargesOf = async (ctx, id) => rowsOf(ctx, `SELECT * FROM charges WHERE event_id = $1 ORDER BY id`, [id]);
const liveOf = async (ctx, id) => (await chargesOf(ctx, id)).filter((c) => !c.voided);

test("a hall is quoted hourly, as a package, on the weekend and on the festive list — off one price row", async () => {
  const ctx = await boot();

  const hourly = (await booked(ctx)).event;
  assert.equal(Number(hourly.hours), 4);
  const h = (await linesOf(ctx, hourly.id))[0];
  assert.equal(h.kind, "hourly");
  assert.equal(h.unit, "hours", "the line says what it sold");
  assert.equal(Number(h.unit_price), 850000);
  assert.equal(Number(h.amount), 3400000, "four hours at the listed hourly rate");
  assert.equal(Number(hourly.subtotal), 3400000);
  assert.equal(Number(hourly.service_charge), 340000);
  assert.equal(Number(hourly.vat), 280500, "and VAT lands on the service charge, not beside it");
  assert.equal(Number(hourly.tax), 620500);
  assert.equal(Number(hourly.total), 4020500);
  assert.equal(Number(hourly.total), Number(hourly.subtotal) + Number(hourly.tax));
  assert.equal(Number(hourly.deposit), 2010250);
  assert.equal(Number(hourly.deposit_pct), 50);
  assert.equal(hourly.currency, "NGN");

  const half = (await booked(ctx, { date: addDays(DAY, 4), package: "half" })).event;
  const hl = (await linesOf(ctx, half.id))[0];
  assert.equal(hl.kind, "package");
  assert.equal(hl.unit, "Half day");
  assert.equal(Number(hl.unit_price), 3400000, "the package replaces the hourly line rather than adding to it");
  assert.equal(Number(hl.base_price), 3400000);

  const full = (await booked(ctx, { date: FRI, package: "full" })).event;
  const fl = (await linesOf(ctx, full.id))[0];
  assert.equal(Number(fl.unit_price), 7440000, "the weekend uplift moves the package with the hourly rate");
  assert.equal(Number(fl.base_price), 6200000, "the list price is kept beside the charge so the uplift is visible");

  // The festive book carries its premium in the hourly rate and no weekend
  // uplift, so a Friday on that list is raised once, not twice.
  const festive = (await booked(ctx, { date: FEST, start: "10:00", end: "18:00" })).event;
  assert.equal(festive.price_id, "prc_hall_grand_fest");
  assert.equal(festive.list_id, "pl_fest");
  assert.equal(festive.list_name, "Festive season");
  const fv = (await linesOf(ctx, festive.id))[0];
  assert.equal(Number(fv.unit_price), 977500, "and the engine rounds the uplift to the naira step");
  assert.equal(Number(fv.amount), 7820000);
  assert.equal(fv.price_id, "prc_hall_grand_fest", "the booking remembers the row it was sold from");
});

test("add-ons are priced into the booking, itemised beside the hall, and one booking is one money", async () => {
  const ctx = await boot();

  const out = await booked(ctx, {
    start: "10:00", end: "12:00",
    addons: { evt_sound: 2, evt_catering: 50, hall_garden: 1 },
  });
  const evt = out.event;
  const lines = await linesOf(ctx, evt.id);
  assert.equal(lines.length, 3, "another hall cannot be added to itself as an extra");
  assert.equal(lines.filter((l) => l.name === "Garden Terrace").length, 0);
  assert.deepEqual(lines.map((l) => Number(l.amount)), [1700000, 500000, 625000]);
  assert.equal(lines[1].kind, "addon");
  assert.equal(Number(lines[1].unit_price) * Number(lines[1].qty), Number(lines[1].amount),
    "a line is a plain multiple of its quantity");
  assert.equal(lines[2].price_id, "prc_evt_catering_std", "and each line keeps its own price row");
  assert.deepEqual(out.skipped, [], "nothing was left out quietly");

  assert.equal(Number(evt.subtotal), 2825000);
  assert.equal(Number(evt.service_charge), 282500);
  assert.equal(Number(evt.vat), 233050);
  assert.equal(Number(evt.total), 3340550);
  assert.equal(Number(evt.deposit), 1670300, "the deposit is the percentage the price row carries");
});

test("a hall cannot be double-booked, but back-to-back slots are allowed", async () => {
  const ctx = await boot();

  const first = (await booked(ctx, { title: "Product launch" })).event;

  const overlap = await book(ctx, { start: "13:00", end: "15:00" });
  assert.equal(overlap.status, 422);
  assert.match(overlap.body.error, /Clash/);
  assert.equal(overlap.body.conflict.id, first.id, "the refusal names the booking in the way");

  const same = await book(ctx, { title: "Other function" });
  assert.match(same.body.error, /Clash/);

  const after = await booked(ctx, { start: "14:00", end: "18:00", title: "Evening reception" });
  assert.ok(after.event.id, "touching the end of the previous booking is fine");

  const otherHall = await booked(ctx, { hallId: "hall_garden" });
  assert.ok(otherHall.event.id, "a different hall at the same time is not a clash");

  const board = await boardOf(ctx);
  assert.equal(board.length, 3, "three bookings took, two were refused");
  assert.deepEqual(board.map((e) => e.title).sort(),
    ["Evening reception", "Product launch", "Test booking"], "and the board holds exactly those three");
});

test("a confirmed booking on a folio posts its lines and its taxes", async () => {
  const ctx = await boot();
  const before = (await folioOf(ctx, "res_1")).total;

  const out = await booked(ctx, { status: "Confirmed", reservationId: "res_1", addons: { evt_sound: 1 } });
  assert.equal(out.posted, true);
  const evt = out.event;

  const f = await folioOf(ctx, "res_1");
  assert.equal(f.total - before, Number(evt.total), "the folio moved by exactly what was quoted");

  const lines = await linesOf(ctx, evt.id);
  const live = await liveOf(ctx, evt.id);
  assert.equal(live.length, lines.length + evt.tax_lines.length);
  assert.equal(live.reduce((s, c) => s + Number(c.amount), 0), Number(evt.total));
  live.forEach((c) => {
    assert.equal(c.reservation_id, "res_1");
    assert.equal(dstr(c.charge_date), W, "a booking bills the night it held the hall");
    assert.equal(c.currency, "NGN");
    assert.ok(c.event_id, "and every line knows the booking it came from");
  });

  const hall = live.filter((c) => c.department === "Events & Banqueting");
  assert.equal(hall.length, lines.length);
  const lineFor = (c) => lines.find((l) => c.description.includes(l.name));
  hall.forEach((c) => assert.equal(c.price_id, lineFor(c).price_id,
    "the charge carries the price row it was sold from"));
  assert.equal(hall.find((c) => c.description.includes("Grand Ballroom")).description,
    "4 × Grand Ballroom — Test booking", "an hourly line is sold by the hour, so it says how many");
  assert.equal(hall.find((c) => c.description.includes("Grand Ballroom")).price_id, evt.price_id);
  assert.equal(hall.find((c) => c.description.includes("Grand Ballroom")).list_id, "pl_std");

  const tax = live.filter((c) => c.department === "Taxes & service");
  assert.equal(tax.length, evt.tax_lines.length);
  tax.forEach((c) => {
    assert.equal(c.posted_by, "System", "the taxes were worked out, not typed in");
    assert.ok(c.tax_rule_id);
    assert.equal(c.amount, Number(evt.tax_lines.find((t) => c.description.startsWith(t.label)).amount));
  });
});

test("a hold reserves the time but agrees no money until it is confirmed", async () => {
  const ctx = await boot();
  const before = (await folioOf(ctx, "res_1")).total;

  const held = (await booked(ctx, { reservationId: "res_1" })).event;
  assert.equal(held.status, "Hold", "a caller that names no money gets none");
  assert.equal((await liveOf(ctx, held.id)).length, 0, "a hold leaves the folio alone");
  assert.equal((await folioOf(ctx, "res_1")).total, before);

  const confirmed = await ctx.as("Front Desk").post(`/api/events/${held.id}/confirm`).send({});
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.event.status, "Confirmed");
  assert.equal((await folioOf(ctx, "res_1")).total - before, Number(held.total),
    "confirming posts the lines the hold was quoted on, not today's list");

  const twice = await ctx.as("Front Desk").post(`/api/events/${held.id}/confirm`).send({});
  assert.equal(twice.status, 422);
  assert.equal(twice.body.error, "Only a hold can be confirmed.");
  assert.equal((await folioOf(ctx, "res_1")).total - before, Number(held.total), "and it posts once");
});

test("a confirmed hold whose window has since been taken is refused, with nothing posted", async () => {
  const ctx = await boot();
  const held = (await booked(ctx, { reservationId: "res_1", title: "AGM awards" })).event;

  // While the hall sat on hold, another desk's booking for the same window landed
  // — the one thing the hold cannot see coming, since its own clash check passed
  // before either row existed. Stood in for by a written row, as the API would
  // have written it.
  await ctx.query(
    `INSERT INTO events (id,property_id,hall_id,hall_service_id,title,organizer,event_date,start_time,end_time,
       status,total,currency,deposit)
     VALUES ('evt_other','agm','hall_grand','svc_hall_grand','Press briefing','Other desk',$1,'10:00','14:00',
       'Confirmed',4020500,'NGN',2010250)`, [W]);

  const out = await ctx.as("Manager").post(`/api/events/${held.id}/confirm`).send({});
  assert.equal(out.status, 422);
  assert.match(out.body.error, /taken by Press briefing/);
  assert.equal((await eventOf(ctx, held.id)).status, "Hold");
  assert.equal((await liveOf(ctx, held.id)).length, 0);
  assert.equal((await rowsOf(ctx, `SELECT count(*) AS n FROM charges`))[0].n, 3, "nothing reached any folio");
});

test("re-pricing a hall does not rewrite a booking or the folio it posted", async () => {
  const ctx = await boot();
  const out = await booked(ctx, { status: "Confirmed", reservationId: "res_1", package: "full" });
  const evt = out.event;
  const sold = Number((await linesOf(ctx, evt.id))[0].unit_price);
  assert.equal(sold, 6200000, "a weekday full day sells at the list package");
  const charged = (await folioOf(ctx, "res_1")).total;

  const moved = await ctx.as("Manager").patch("/api/pricing/prices/prc_hall_grand_std")
    .send({ amount: 9999999, surcharges: { halfDay: 8888888, fullDay: 9999999 }, reason: "Pressures for next year" });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));

  assert.equal(Number((await linesOf(ctx, evt.id))[0].unit_price), sold, "the booking keeps the rate it was sold on");
  assert.equal((await liveOf(ctx, evt.id)).reduce((s, c) => s + Number(c.amount), 0), Number(evt.total));
  assert.equal((await folioOf(ctx, "res_1")).total, charged, "and the folio is untouched by the new list");

  const fresh = await booked(ctx, { date: addDays(DAY, 6), package: "full" });
  assert.equal(Number((await linesOf(ctx, fresh.event.id))[0].unit_price), 10000000,
    "a fresh booking is quoted on the new package, rounded to the naira step");
});

test("cancelling voids the posted lines, charges the agreed fee and keeps the history", async () => {
  const ctx = await boot();
  const folio0 = await folioOf(ctx, "res_1");

  const evt = (await booked(ctx, {
    hallId: "hall_board", guests: 12, start: "09:00", end: "11:00",
    status: "Confirmed", reservationId: "res_1",
  })).event;
  assert.equal(Number(evt.total), 354750);
  const posted = (await liveOf(ctx, evt.id)).length;
  assert.equal(posted, evt.lines.length + evt.tax_lines.length);

  const noReason = await ctx.as("Manager").post(`/api/events/${evt.id}/cancel`).send({ reason: "  " });
  assert.equal(noReason.status, 422);
  assert.match(noReason.body.error, /reason is required/);

  const done = await ctx.as("Manager").post(`/api/events/${evt.id}/cancel`)
    .send({ reason: "Organiser postponed the summit" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  // 09:00 on the third day from a Thursday noon is 69 hours away — inside the 72
  // hours the booking was sold on, so half the total is owed.
  assert.equal(Number(done.body.fee), 177400);
  assert.equal(done.body.voided, posted);

  const all = await chargesOf(ctx, evt.id);
  assert.equal(all.filter((c) => c.voided).length, posted, "the original lines are still on the database");
  assert.ok(all.filter((c) => c.voided).every((c) => c.voided_by), "and every one is voided by somebody, not deleted");
  const live = all.filter((c) => !c.voided);
  assert.equal(live.length, 1, "one cancellation line replaces them");
  assert.equal(Number(live[0].amount), 177400);
  assert.equal(live[0].department, "Events & Banqueting");
  assert.equal(live[0].price_id, evt.price_id, "the fee is traced to the same price row");
  assert.equal(dstr(live[0].charge_date), DAY, "and dated the day the call was made, not the night that was never held");

  const after = await eventOf(ctx, evt.id);
  assert.equal(after.status, "Cancelled");
  assert.equal(after.cancel_reason, "Organiser postponed the summit");
  assert.equal(Number(after.cancel_fee), 177400);
  assert.ok(after.cancelled_at);

  const f = await folioOf(ctx, "res_1");
  assert.equal(f.paid, folio0.paid, "voiding charges never moves a payment");
  assert.equal(f.total, folio0.total + 177400, "the lines came off and the fee went on");

  const twice = await ctx.as("Manager").post(`/api/events/${evt.id}/cancel`).send({ reason: "Again" });
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already cancelled/);
});

test("a cancellation outside the notice window costs nothing", async () => {
  const ctx = await boot();
  const evt = (await booked(ctx, { date: addDays(DAY, 30), status: "Confirmed" })).event;

  const done = await ctx.as("Manager").post(`/api/events/${evt.id}/cancel`).send({ reason: "Plans changed" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(Number(done.body.fee), 0, "30 days away is beyond the 72 hour notice");
  assert.equal(Number((await eventOf(ctx, evt.id)).cancel_fee), 0);
  assert.equal((await liveOf(ctx, evt.id)).length, 0, "and no line is added to the folio");
  assert.equal((await chargesOf(ctx, evt.id)).length, 0, "there was nothing on a folio to void either");
});

test("an unreasonable booking is refused before anything is written", async () => {
  const ctx = await boot();
  const later = addDays(DAY, 6);
  const bad = [
    { hallId: "svc_dk", error: /Choose a hall/ },
    { hallId: "svc_evt_sound", error: /Choose a hall/ },
    { title: "  ", error: /event a name/ },
    { organizer: "", error: /booking is for/ },
    { date: "not-a-date", error: /event date/ },
    { date: addDays(DAY, -1), error: /past/ },
    { date: later, start: "14:00", end: "10:00", error: /Check the times/ },
    { date: later, start: "10:00", end: "10:00", error: /at least an hour/ },
    { date: later, guests: 400, error: /licensed for 320 guests, not 400/ },
    { date: later, reservationId: "res_nope", error: /reservation no longer exists/ },
  ];
  for (const row of bad) {
    const out = await book(ctx, Object.assign({ date: later }, row));
    assert.equal(out.status, 422, JSON.stringify(out.body));
    assert.match(out.body.error, row.error, JSON.stringify(row));
  }
  assert.equal((await boardOf(ctx)).length, 0, "a refused booking leaves no trace");
  assert.equal((await rowsOf(ctx, `SELECT count(*) AS n FROM charges`))[0].n, 3, "nor leaves anything on a folio");
});

test("a caller cannot price its own booking", async () => {
  const ctx = await boot();
  const out = await booked(ctx, {
    status: "Confirmed", reservationId: "res_1",
    total: 1, subtotal: 1, tax: 0, deposit: 0, priceId: "prc_dk_std", listId: "pl_fest",
    lines: [{ name: "Invented line", amount: 99999999 }],
    taxLines: [{ label: "Invented tax", amount: 1 }],
  });
  const evt = out.event;
  assert.equal(Number(evt.total), 4020500, "the engine's total is the booking's total");
  assert.equal(Number(evt.subtotal), 3400000);
  assert.equal(Number(evt.deposit), 2010250);
  assert.equal(evt.price_id, "prc_hall_grand_std");
  assert.equal(evt.list_id, "pl_std");
  assert.deepEqual(evt.lines.map((l) => l.name), ["Grand Ballroom"]);
  assert.deepEqual(evt.tax_lines.map((t) => t.label), ["Service charge (10%)", "VAT (7.5%)"]);
  assert.equal((await liveOf(ctx, evt.id)).length, 3, "and exactly the lines the quote held were posted");
});

test("a deposit is only taken where the money can actually be reconciled", async () => {
  const ctx = await boot();
  const paid0 = (await folioOf(ctx, "res_1")).paid;
  const evt = (await booked(ctx, { status: "Confirmed", reservationId: "res_1" })).event;
  assert.equal(Number(evt.deposit_paid), 0);

  const held = (await booked(ctx, { hallId: "hall_garden", date: addDays(DAY, 8) })).event;
  const tooEarly = await ctx.as("Front Desk").post(`/api/events/${held.id}/deposit`).send({});
  assert.equal(tooEarly.status, 422);
  assert.match(tooEarly.body.error, /Only a confirmed booking/);

  const done = await ctx.as("Front Desk").post(`/api/events/${evt.id}/deposit`).send({ method: "Transfer" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(Number(done.body.payment.amount), Number(evt.deposit));
  assert.equal(done.body.payment.event_id, evt.id, "the money knows which booking it settles");
  assert.equal(Number(done.body.event.deposit_paid), Number(evt.deposit));
  assert.equal((await folioOf(ctx, "res_1")).paid - paid0, Number(evt.deposit));

  const twice = await ctx.as("Front Desk").post(`/api/events/${evt.id}/deposit`).send({});
  assert.equal(twice.status, 422);
  assert.match(twice.body.error, /already recorded/);

  const standalone = (await booked(ctx, { hallId: "hall_board", guests: 12, date: addDays(DAY, 9), status: "Confirmed" })).event;
  const noFolio = await ctx.as("Front Desk").post(`/api/events/${standalone.id}/deposit`).send({});
  assert.equal(noFolio.status, 422);
  assert.match(noFolio.body.error, /not on a guest folio/, "so its money is invoiced, not posted to a stay");
});

test("a hall the books cannot value today is not on sale, and a folio keeps one money", async () => {
  const ctx = await boot();

  // The boardroom is sold in sterling while no sterling fixing is on file. No desk
  // could have put it there — the currency gate refuses a price the books cannot
  // value — so the row is moved the way the browser test moves its database.
  await ctx.query(`UPDATE prices SET currency = 'GBP' WHERE id = 'prc_hall_board_std'`);

  const refused = await book(ctx, { hallId: "hall_board", guests: 12, status: "Confirmed" });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /no active price for Boardroom on that date/,
    "a price the books cannot count is no price, not a cheap one");
  assert.equal((await rowsOf(ctx, `SELECT count(*) AS n FROM events WHERE hall_id = 'hall_board'`))[0].n, 0);

  // With a sterling rate on file the boardroom sells again — in sterling. And a
  // naira hall cannot join the folio that rate just opened.
  await ctx.query(`DELETE FROM charges  WHERE reservation_id = 'res_3'`);
  await ctx.query(`DELETE FROM payments WHERE reservation_id = 'res_3'`);
  const rate = await ctx.as("Manager").post("/api/fx/rates").send({ code: "GBP", perBase: 1965, note: "Treasury fixing" });
  assert.equal(rate.status, 201, JSON.stringify(rate.body));
  const inPounds = await ctx.as("Front Desk").post("/api/reservations/res_3/charges")
    .send({ description: "Sterling cable", amount: 100, currency: "GBP" });
  assert.equal(inPounds.status, 201, JSON.stringify(inPounds.body));

  const boardroom = await booked(ctx, { hallId: "hall_board", guests: 12, reservationId: "res_3", status: "Confirmed" });
  assert.equal(boardroom.event.currency, "GBP");
  assert.equal(Number(boardroom.event.fx_rate), 1965, "sold in sterling, valued at the day's fixing");

  const garden = await book(ctx, { hallId: "hall_garden", date: addDays(DAY, 4), reservationId: "res_3", status: "Confirmed" });
  assert.equal(garden.status, 422);
  assert.match(garden.body.error, /billed in GBP, not NGN/, "one folio, one money");
  assert.equal((await rowsOf(ctx, `SELECT count(*) AS n FROM events WHERE hall_id = 'hall_garden'`))[0].n, 0);
});

test("a role without the events capability cannot book, confirm, cancel or take a deposit", async () => {
  const ctx = await boot();
  const evt = (await booked(ctx, { status: "Confirmed", reservationId: "res_1" })).event;

  const hk = ctx.as("Housekeeping");
  const doors = [
    hk.post("/api/events").send({ hallId: "hall_grand", date: W, start: "10:00", end: "14:00" }),
    hk.post(`/api/events/${evt.id}/confirm`).send({}),
    hk.post(`/api/events/${evt.id}/cancel`).send({ reason: "because" }),
    hk.post(`/api/events/${evt.id}/deposit`).send({}),
  ];
  for (const call of doors) {
    const out = await call;
    assert.equal(out.status, 403, JSON.stringify(out.body));
    assert.match(out.body.error, /book_events/);
  }
  assert.equal((await eventOf(ctx, evt.id)).status, "Confirmed", "the board is exactly as it was");

  const desk = await booked(ctx, { hallId: "hall_garden", date: addDays(DAY, 11) });
  assert.ok(desk.event.id, "the front desk can book a hall");
});
