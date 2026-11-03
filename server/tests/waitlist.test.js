/**
 * Waitlist — the port of the desk's release engine (assets/store.js LHMS.waitlist,
 * PRD 6.1).
 *
 * The browser's rules are the ones proved here: a waitlisted stay holds no key
 * and owes nothing, a cancellation offers a freed room to the oldest request for
 * those dates on a 24-hour hold, and accepting the hold is the moment the stay is
 * confirmed and billed. The API's own wall — one hotel's board per desk — and its
 * refusals (a hold that has lapsed, a room sold in between, a second acceptance)
 * are proved beside them because the desk and a cancellation run the same pass.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, addDays, dstr } = require("./helpers/api");

const trail = async (ctx, action) => (await ctx.query(
  `SELECT * FROM activity_log WHERE action = $1 ORDER BY created_at`, [action])).rows;

const counts = async (ctx, resId) => (await ctx.query(
  `SELECT (SELECT count(*) FROM charges WHERE reservation_id=$1) AS c,
          (SELECT count(*) FROM payments WHERE reservation_id=$1) AS p`, [resId])).rows[0];

/** A request for the king, in the fortnight the fixture leaves it free. */
async function joinQueue(ctx, role, ci, co, extra) {
  return ctx.as(role || "Front Desk").post("/api/reservations").send(Object.assign({
    propertyId: "agm", guestId: "gst_2", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: ci, checkOut: co, adults: 1, waitlist: true,
    channel: "Walk-in", notes: "Waiting on a cancellation",
  }, extra || {}));
}

/** The stay the fixture holds the only king for, released and ready to take. */
async function offerFor(ctx, ci, co) {
  const made = await joinQueue(ctx, "Front Desk", ci, co);
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const out = await ctx.as("Front Desk").post("/api/waitlist/release").send({});
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const offer = out.body.offers.find((o) => o.reservation_id === made.body.id);
  assert.ok(offer, "the release pass offered the waiting stay the free king");
  return { res: made.body, offer, released: out.body };
}

test("the board reads the hotel's own offers and queue, and the wall holds", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const { res, offer } = await offerFor(ctx, ci, co);

  const board = await ctx.as("Manager").get("/api/waitlist");
  assert.equal(board.status, 200, JSON.stringify(board.body));
  assert.equal(board.body.holdHours, 24);
  assert.deepEqual(board.body.offers.map((o) => o.id), [offer.id]);
  assert.equal(board.body.offers[0].state, "Offered");
  assert.equal(board.body.offers[0].room_number, "101");
  assert.equal(board.body.offers[0].guest_name, "Kunle Adeyemi");
  assert.equal(board.body.offers[0].room_type_name, "Deluxe King");
  assert.deepEqual(board.body.queue.map((r) => r.id), [res.id]);
  assert.equal(board.body.queue[0].room_type_name, "Deluxe King");

  // Another hotel's board belongs to that hotel; a role without the desk's
  // permission reads none of it.
  const outside = await ctx.as("Front Desk").get("/api/waitlist?propertyId=ari");
  assert.equal(outside.status, 403, JSON.stringify(outside.body));
  assert.equal((await ctx.as("Manager").get("/api/waitlist?propertyId=ari")).status, 200);
  assert.equal((await ctx.as("Auditor").get("/api/waitlist")).status, 403);
  assert.equal((await ctx.as("Auditor").post("/api/waitlist/release").send({})).status, 403);
});

test("a request joins the queue priced but unbilled, and takes no deposit", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const made = await joinQueue(ctx, "Front Desk", ci, co);
  assert.equal(made.status, 201, JSON.stringify(made.body));

  const res = made.body;
  assert.equal(res.status, "Waitlist");
  assert.equal(res.room_id, null, "a waitlisted stay holds no key");
  assert.ok(Number(res.total) > 0, "the card quotes the stay it will become");
  assert.equal(Number(res.room_total), Number(res.subtotal));
  const nothing = await counts(ctx, res.id);
  assert.deepEqual([Number(nothing.c), Number(nothing.p)], [0, 0],
    "nothing was consumed, so nothing is billed and no deposit is taken");

  const lines = await trail(ctx, "joined the waitlist");
  assert.equal(lines.length, 1);
  assert.match(lines[0].detail, /AGM-\d+ · Kunle Adeyemi · 2 nights/);
  const { rows: said } = await ctx.query(
    `SELECT type, title FROM notifications WHERE type = 'Added to the waitlist'`);
  assert.equal(said.length, 1);

  const withMoney = await joinQueue(ctx, "Front Desk", ci, co, { deposit: 50000 });
  assert.equal(withMoney.status, 422, JSON.stringify(withMoney.body));
  assert.match(withMoney.body.error, /cannot take a deposit/);
});

test("a cancellation offers the freed room, and the pass never doubles a hold", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const wait = await joinQueue(ctx, "Front Desk", ci, co);

  // The only king the fixture has is taken by a confirmed stay for the same
  // nights, so the request can be promised nothing yet.
  const hold = await ctx.as("Front Desk").post("/api/reservations").send({
    propertyId: "agm", guestId: "gst_1", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: ci, checkOut: co, adults: 1,
  });
  assert.equal(hold.status, 201, JSON.stringify(hold.body));
  const early = await ctx.as("Front Desk").post("/api/waitlist/release").send({});
  assert.equal(early.body.offers.length, 0, "with every king taken there is nothing to release");
  assert.equal((await ctx.as("Front Desk").get("/api/waitlist")).body.queue.length, 1);

  const cancelled = await ctx.as("Front Desk").post(`/api/reservations/${hold.body.id}/cancel`)
    .send({ fee: true });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.status, "Cancelled");
  assert.equal(cancelled.body.released.length, 1, "the queue behind the cancellation was called");
  const offer = cancelled.body.released[0];
  assert.equal(offer.reservation_id, wait.body.id);
  assert.equal(offer.room_number, "101");
  assert.equal(offer.state, "Offered");

  const hours = (new Date(offer.expires_at) - new Date(offer.offered_at)) / 3600000;
  assert.ok(Math.abs(hours - 24) < 0.01, `the hold runs 24 hours, not ${hours}`);

  // The fee the desk asked for is the night the folio would have billed.
  const { rows: fee } = await ctx.query(
    `SELECT description, amount FROM charges
      WHERE reservation_id = $1 AND description = 'Cancellation fee — one night'`, [hold.body.id]);
  assert.equal(fee.length, 1);
  assert.equal(Number(fee[0].amount), 200000);

  const lines = await trail(ctx, "released a waitlist room");
  assert.equal(lines.length, 1);
  assert.match(lines[0].detail, /AGM-\d+ · Kunle Adeyemi · Room 101/);
  const { rows: said } = await ctx.query(
    `SELECT title, detail FROM notifications WHERE type = 'Waitlist release'`);
  assert.equal(said.length, 1);
  assert.match(said[0].title, /Kunle Adeyemi can be given Room 101/);

  // A second pass sees a live hold on the stay and leaves it alone.
  const again = await ctx.as("Front Desk").post("/api/waitlist/release").send({});
  assert.equal(again.body.offers.length, 0);
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM waitlist_offers`)).rows[0].n, 1);
});

test("accepting the hold confirms the stay and bills every night at the quote", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const { res, offer } = await offerFor(ctx, ci, co);

  const taken = await ctx.as("Front Desk").post(`/api/waitlist/${offer.id}/accept`).send({});
  assert.equal(taken.status, 200, JSON.stringify(taken.body));
  assert.equal(taken.body.res.status, "Confirmed");
  assert.equal(taken.body.res.room_id, "agm_101");
  assert.equal(taken.body.offer.state, "Accepted");
  assert.ok(taken.body.res.waitlist_confirmed_at, "the stay carries the moment it converted");

  const quote = taken.body.quote;
  assert.equal(Number(taken.body.res.room_total), quote.roomTotal);
  assert.equal(Number(taken.body.res.total), quote.total);
  assert.equal(taken.body.folio.balance, quote.total, "the folio owes the nights just billed");
  const { rows: rooms } = await ctx.query(
    `SELECT charge_date, amount FROM charges WHERE reservation_id=$1 AND department='Rooms'
      ORDER BY charge_date`, [res.id]);
  assert.deepEqual(rooms.map((c) => [dstr(c.charge_date), Number(c.amount)]),
    quote.nightly.map((n) => [n.date, n.rate]), "one line per night, at the rate the night sells at");

  assert.equal((await ctx.as("Front Desk").get("/api/waitlist")).body.queue.length, 0);
  assert.equal((await trail(ctx, "confirmed a waitlist booking")).length, 1);

  const second = await ctx.as("Front Desk").post(`/api/waitlist/${offer.id}/accept`).send({});
  assert.equal(second.status, 422, JSON.stringify(second.body));
  assert.match(second.body.error, /no longer open/);
  const { rows: lines } = await ctx.query(
    `SELECT count(*) AS n FROM charges WHERE reservation_id = $1`, [res.id]);
  assert.equal(Number(lines[0].n), quote.nightly.length + quote.taxLines.length,
    "the refusal billed nothing twice");
});

test("declining passes the room down to the next request for those nights", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const { res: first, offer } = await offerFor(ctx, ci, co);

  // A second request arrives while the first is holding the offer; it is behind
  // the hold in the queue and is promised nothing yet.
  const second = await joinQueue(ctx, "Front Desk", ci, co, { guestId: "gst_1" });
  assert.equal(second.status, 201, JSON.stringify(second.body));

  const passed = await ctx.as("Front Desk").post(`/api/waitlist/${offer.id}/decline`).send({});
  assert.equal(passed.status, 200, JSON.stringify(passed.body));
  assert.equal(passed.body.offer.state, "Declined");
  assert.equal(passed.body.offers.length, 1);
  assert.equal(passed.body.offers[0].reservation_id, second.body.id, "the room moved down the queue");
  assert.equal(passed.body.offers[0].room_number, "101");

  const { rows: stayed } = await ctx.query(`SELECT status FROM reservations WHERE id = $1`, [first.id]);
  assert.equal(stayed[0].status, "Waitlist", "declining does not drop the guest off the list");
  assert.equal(Number((await counts(ctx, first.id)).c), 0);
  assert.equal((await trail(ctx, "declined a waitlist offer")).length, 1);
});

test("a lapsed hold is closed, not taken; the stay keeps its place", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const { res, offer } = await offerFor(ctx, ci, co);

  await ctx.query(`UPDATE waitlist_offers SET expires_at = $2 WHERE id = $1`,
    [offer.id, new Date(Date.now() - 60000)]);

  const late = await ctx.as("Front Desk").post(`/api/waitlist/${offer.id}/accept`).send({});
  assert.equal(late.status, 422, JSON.stringify(late.body));
  assert.match(late.body.error, /expired/);
  const { rows: closed } = await ctx.query(`SELECT status FROM waitlist_offers WHERE id = $1`, [offer.id]);
  assert.equal(closed[0].status, "Expired");
  const { rows: stayed } = await ctx.query(`SELECT status, room_id FROM reservations WHERE id = $1`, [res.id]);
  assert.equal(stayed[0].status, "Waitlist");
  assert.equal(stayed[0].room_id, null);
  assert.equal(Number((await counts(ctx, res.id)).c), 0, "a hold nobody took leaves no charge behind");
});

test("accepting a room sold in between is refused, and the hold closes as lost", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const { offer } = await offerFor(ctx, ci, co);

  // The desk sells the king to somebody standing at the counter before the
  // waitlisted guest rings back.
  const sold = await ctx.as("Front Desk").post("/api/reservations").send({
    propertyId: "agm", guestId: "gst_1", roomTypeId: "dk", ratePlanId: "flex",
    checkIn: ci, checkOut: co, adults: 1,
  });
  assert.equal(sold.status, 201, JSON.stringify(sold.body));

  const late = await ctx.as("Front Desk").post(`/api/waitlist/${offer.id}/accept`).send({});
  assert.equal(late.status, 422, JSON.stringify(late.body));
  assert.match(late.body.error, /That room has gone/);
  const { rows: closed } = await ctx.query(`SELECT status FROM waitlist_offers WHERE id = $1`, [offer.id]);
  assert.equal(closed[0].status, "Expired");
  assert.equal((await trail(ctx, "lost a waitlist room")).length, 1);
});

test("leaving the waitlist frees nothing and bills nothing, and cannot be done twice", async () => {
  const ctx = await boot();
  const ci = addDays(ctx.day, 6), co = addDays(ctx.day, 8);
  const made = await joinQueue(ctx, "Front Desk", ci, co);

  const left = await ctx.as("Front Desk").post(`/api/reservations/${made.body.id}/cancel`).send({});
  assert.equal(left.status, 200, JSON.stringify(left.body));
  assert.equal(left.body.status, "Cancelled");
  assert.deepEqual(left.body.released, [], "a request that never held a room frees none");
  assert.equal(Number((await counts(ctx, made.body.id)).c), 0, "leaving the list costs nothing");

  const again = await ctx.as("Front Desk").post(`/api/reservations/${made.body.id}/cancel`).send({});
  assert.equal(again.status, 422, JSON.stringify(again.body));
  const { rows: any } = await ctx.query(`SELECT count(*) AS n FROM waitlist_offers`);
  assert.equal(Number(any[0].n), 0);
});
