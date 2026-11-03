/**
 * Every read door, opened once on the seeded board.
 *
 * The routes are the surface the browser talks to when it is not running its own
 * engine, and a door that answers 500 is a page that shows nothing at all. Each
 * one is asked here against the real seed — not the small test fixture — so the
 * SQL runs over the rows a live install actually carries. A door answers either
 * with its rows or, when the board holds nothing of that kind, with a 404 that
 * says so; the one answer no read door is allowed is a server error.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const request = require("supertest");
const { install } = require("./helpers/memdb");
const SEED = require("../src/db/seed");

const SRC = path.join(__dirname, "..", "src") + path.sep;
let board = null;

/** One boot for the whole file: the seed costs seconds, the doors cost milliseconds. */
async function surface() {
  if (board) return board;
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC)) delete require.cache[k]; });
  const { pool } = install();
  const client = await pool.connect();
  await client.query("BEGIN");
  const out = await SEED.seed(client);
  await client.query("COMMIT");
  client.release();

  const app = require("../src/index.js");
  const login = await request(app).post("/api/auth/login")
    .send({ email: "ifeoma.okafor@aureliagrand.com", password: "aurelia2026" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  const get = (url) => request(app).get(url).set("Authorization", "Bearer " + login.body.token);
  const one = async (sql, params) => (await pool.query(sql, params || [])).rows[0];
  board = { pool, app, day: out.day, get, one, token: login.body.token };
  return board;
}

test("the surface reads — no GET door faults on the seeded board", async () => {
  const { day, get, one } = await surface();
  const biz = require("../src/lib/business-date");

  // Ids read off the board the seed wrote, so a detail door is asked for a row
  // that exists rather than for a number somebody remembered.
  const guest = await one(`SELECT id, name FROM guests ORDER BY id`);
  const stay = await one(`SELECT id, reference FROM reservations WHERE status='In-house' ORDER BY id`);
  const hall = await one(`SELECT id FROM events ORDER BY id`);
  const doc = await one(`SELECT id FROM documents ORDER BY id`);
  const svc = await one(`SELECT id FROM services WHERE category='room' ORDER BY id`);
  const expense = await one(`SELECT id FROM expenses ORDER BY id`);
  const invoice = await one(`SELECT id FROM invoices ORDER BY id`);
  const review = await one(`SELECT id FROM reviews ORDER BY id`);
  const laundry = await one(`SELECT id FROM laundry_orders ORDER BY id`);

  assert.ok(guest && stay && hall && svc && expense, "the seed left the board without rows a page reads");

  /* ── the doors the board is guaranteed to answer ─────────────── */
  const open = [
    ["/api/properties"],
    [`/api/properties/${"agm"}`],
    [`/api/properties/agm/settings`],
    ["/api/auth/me"],
    ["/api/guests"],
    [`/api/guests/${guest.id}`],
    [`/api/guests?tier=Platinum&q=${encodeURIComponent(guest.name.split(" ")[0])}`],
    ["/api/reservations?propertyId=agm"],
    [`/api/reservations/${stay.id}`],
    [`/api/reservations/${stay.id}/folio`],
    [`/api/rooms?propertyId=agm`],
    [`/api/rooms/types?propertyId=agm`],
    [`/api/rooms/types/dk/availability?checkIn=${day}&checkOut=${biz.addDays(day, 3)}`],
    [`/api/metrics/agm/today`],
    [`/api/metrics/agm/channel-mix`],
    [`/api/metrics/agm/department-revenue`],
    [`/api/metrics/ari/today`],
    [`/api/metrics/apa/today`],
    [`/api/events?propertyId=agm&date=${day}`],
    [`/api/events/${hall.id}`],
    [`/api/tasks?propertyId=agm`],
    [`/api/lost-found`],
    [`/api/lost-found?status=Stored`],
    [`/api/lost-found/export`],
    [`/api/waitlist?propertyId=agm`],
    [`/api/staff?propertyId=agm`],
    [`/api/staff/permissions`],
    [`/api/activity?propertyId=agm`],
    [`/api/activity/notifications?propertyId=agm`],
    [`/api/pricing/lists`],
    [`/api/pricing/taxes`],
    [`/api/pricing/plans`],
    [`/api/pricing/services`],
    [`/api/pricing/services?category=room`],
    [`/api/pricing/services/${svc.id}`],
    [`/api/pricing/prices?serviceId=${svc.id}`],
    [`/api/pricing/prices`],
    [`/api/pricing/history?serviceId=${svc.id}`],
    [`/api/billing/invoices?propertyId=agm`],
    [`/api/billing/payments?propertyId=agm`],
    [`/api/billing/refunds?propertyId=agm`],
    [`/api/finance/expenses?propertyId=agm`],
    [`/api/finance/settings?propertyId=agm`],
    [`/api/finance/statement?propertyId=agm`],
    [`/api/finance/statement/department?propertyId=agm&department=Rooms`],
    [`/api/fx/rates?propertyId=agm&date=${day}`],
    [`/api/fx/states?propertyId=agm`],
    [`/api/approvals?propertyId=agm`],
    [`/api/audit/pack?propertyId=agm`],
    [`/api/audit/checks?propertyId=agm`],
    [`/api/audit/business-date`],
    [`/api/audit/closed`],
    [`/api/laundry?propertyId=agm`],
    [`/api/reviews?propertyId=agm`],
    [`/api/reviews/stats/agm`],
    [`/api/documents?propertyId=agm`],
  ];
  if (doc) open.push([`/api/documents/${doc.id}`], [`/api/documents/${doc.id}/metadata`]);
  if (review) open.push([`/api/reviews/${review.id}`]);
  if (laundry) open.push([`/api/laundry/${laundry.id}`]);
  if (invoice) open.push([`/api/billing/invoices/${invoice.id}`]);

  const faults = [];
  for (const [url] of open) {
    const out = await get(url);
    if (out.status !== 200) faults.push(`${url} → ${out.status} ${JSON.stringify(out.body).slice(0, 160)}`);
  }
  assert.deepEqual(faults, [], `these read doors did not answer:\n${faults.join("\n")}`);

  if (!doc) {
    // The seed does not fill the document register yet, and an empty register is
    // refused a file rather than handed over as headers with nothing under them.
    // That is the door's own rule; what the sweep forbids is a server error.
    const out = await get(`/api/documents/export?propertyId=agm`);
    assert.equal(out.status, 422, JSON.stringify(out.body));
    assert.match(out.body.error, /No records available/);
  }

  /* The boards the seed leaves empty are still asked for a row that cannot
     exist, so the door's SQL runs and its own refusal answers: a 404 or a 422
     that says what is missing, never a fault. */
  const probe = "nothing-on-this-board";
  const absent = [`/api/guests/${probe}`, `/api/reservations/${probe}`, `/api/reservations/${probe}/folio`,
    `/api/events/${probe}`, `/api/pricing/services/${probe}`, `/api/laundry/${probe}`, `/api/reviews/${probe}`,
    `/api/billing/invoices/${probe}`, `/api/documents/${probe}`, `/api/approvals/${probe}`,
    `/api/finance/statement/department?propertyId=agm&department=Not%20an%20outlet`];
  const ills = [];
  for (const url of absent) {
    const out = await get(url);
    if (out.status >= 500) ills.push(`${url} → ${out.status} ${JSON.stringify(out.body).slice(0, 160)}`);
  }
  assert.deepEqual(ills, [], `these read doors faulted on a row they do not hold:\n${ills.join("\n")}`);

  /* The shapes the pages index into. A door that answers an object where the
     table expects a list renders as many blank rows, which reads as an empty
     hotel rather than a broken page. */
  const lists = ["/api/properties", "/api/guests", "/api/reservations?propertyId=agm", "/api/rooms?propertyId=agm",
    "/api/rooms/types?propertyId=agm", "/api/events?propertyId=agm", "/api/staff?propertyId=agm",
    "/api/activity?propertyId=agm", "/api/activity/notifications?propertyId=agm", "/api/pricing/lists",
    "/api/pricing/taxes", "/api/pricing/plans", "/api/pricing/services", "/api/pricing/prices",
    "/api/billing/invoices?propertyId=agm", "/api/billing/payments?propertyId=agm",
    "/api/finance/expenses?propertyId=agm", "/api/approvals?propertyId=agm", "/api/documents?propertyId=agm",
    "/api/lost-found"];
  for (const url of lists) {
    const out = await get(url);
    assert.ok(Array.isArray(out.body), `${url} answered ${JSON.stringify(out.body).slice(0, 80)}`);
  }

  // The today strip is the close's own numbers, on the live route over the live seed.
  const metrics = await (await get("/api/metrics/agm/today")).body;
  assert.equal(metrics.date, day);
  assert.ok(metrics.occupied > 0 && metrics.adr > 0 && metrics.revpar > 0 && metrics.balanceDue > 0,
    JSON.stringify([metrics.occupied, metrics.adr, metrics.revpar, metrics.balanceDue]));

  // The seeded folio carries its nights, its tax and the deposit taken for it.
  const folio = await (await get(`/api/reservations/${stay.id}/folio`)).body;
  assert.ok(folio.charges.some((c) => c.department === "Rooms"), "the stay is billed by the night");
  assert.ok(folio.charges.some((c) => c.department === "Taxes & service"), "and taxed once over the room total");
  assert.ok(folio.payments.length > 0, "the deposit the booking took is on it");

  const pricesOf = await (await get(`/api/pricing/services/${svc.id}`)).body;
  assert.ok(Array.isArray(pricesOf.prices) && pricesOf.prices.length > 0,
    `the service carries its price rows: ${JSON.stringify(pricesOf.prices)}`);
  assert.equal(pricesOf.prices.every((p) => p.service_id === svc.id), true,
    "and only its own price rows");

  const book = await (await get("/api/guests")).body;
  assert.ok(book.filter((g) => g.notes.length).length > 0, "the seeded notes reach the book");
  assert.equal(book.every((g) => Array.isArray(g.notes)), true, "every profile carries a list");

  assert.equal(Number((await one(`SELECT count(*) AS n FROM reservations`)).n), SEED.STAY_SEED.length,
    "the board holds exactly the stays the seed walked");
});

test("the guest's own doors open on a guest token", async () => {
  const { app, one, token: staff } = await surface();
  // The portal speaks for a stay, so the guest asked for is one the board holds
  // a key for — found by the contact the booking was made with, as a guest would.
  const contact = await one(`SELECT g.email, g.name FROM guests g
     JOIN reservations r ON r.guest_id = g.id
    WHERE r.status IN ('Confirmed','In-house') AND g.email IS NOT NULL AND g.email <> ''
    ORDER BY r.check_in LIMIT 1`);
  assert.ok(contact, "no seeded stay carries a contact to sign in with");
  const signIn = await request(app).post("/api/auth/guest").send({ email: contact.email });
  assert.equal(signIn.status, 200, JSON.stringify(signIn.body));
  const as = (url) => request(app).get(url).set("Authorization", "Bearer " + signIn.body.token);

  for (const url of ["/api/guest/stay", "/api/guest/folio", "/api/guest/requests"]) {
    const out = await as(url);
    assert.equal(out.status, 200, `${url} → ${out.status} ${JSON.stringify(out.body).slice(0, 200)}`);
  }
  const read = await (await as("/api/guest/stay")).body;
  assert.equal(read.guest.name, contact.name, "the portal speaks for the guest who signed in");
  assert.ok(read.stay, "and answers with the stay they are standing in");

  // And the guest half of the house is still closed to a staff token.
  const staffTry = await request(app).get("/api/guest/stay").set("Authorization", "Bearer " + staff);
  assert.equal(staffTry.status, 422, JSON.stringify(staffTry.body));
});

test("the sentiment door totals the register the manager's page totals", async () => {
  const { pool, get, day } = await surface();
  const biz = require("../src/lib/business-date");
  // The fixture owns this board for the tally: the seed now files a review per
  // departure, and these figures are about the door's arithmetic, not the
  // demo's mix.
  await pool.query(`DELETE FROM reviews`);
  // Dated a day apart so the newest-first register has one order, not three
  // rows that fall out of the database whichever way they please.
  const rows = [["rev_1", 5, true, "Isla Grill", 0], ["rev_2", 4, false, "Booking.com", -1], ["rev_3", 1, false, "Google", -2]];
  for (const [id, rating, responded, channel, off] of rows) {
    await pool.query(
      `INSERT INTO reviews (id, property_id, guest_id, guest_name, channel, rating, title, responded, review_date)
       VALUES ($1,'agm','gst_1','Adaeze Nwankwo',$2,$3,$4,$5,$6)`,
      [id, channel, rating, `${channel} review of the marina stay`, responded, biz.addDays(day, off)]);
  }
  // A second property's own review, so the figures below are proved scoped.
  await pool.query(
    `INSERT INTO reviews (id, property_id, rating, title, responded, review_date)
     VALUES ('rev_4','ari',3,'Reserve stay',$1,$2)`, [false, day]);

  const stats = await (await get("/api/reviews/stats/agm")).body;
  assert.deepEqual(stats, {
    total: 3, responded: 1, rate: 33, avg: 3.33,
    dist: [{ n: 5, count: 1 }, { n: 4, count: 1 }, { n: 3, count: 0 }, { n: 2, count: 0 }, { n: 1, count: 1 }],
  }, "one average over the property's own reviews, and the spread of stars beside it");

  const list = await (await get("/api/reviews?propertyId=agm")).body;
  assert.deepEqual(list.map((r) => [r.id, r.rating, r.responded]),
    [["rev_1", 5, true], ["rev_2", 4, false], ["rev_3", 1, false]],
    "the register the page lists is the same set the figures counted");
  assert.deepEqual(list.map((r) => r.guest_tier), ["Platinum", "Platinum", "Platinum"],
    "a review carries the tier of the guest who wrote it");

  const oneStar = await (await get("/api/reviews?propertyId=agm&rating=1")).body;
  assert.deepEqual(oneStar.map((r) => r.id), ["rev_3"], "and the page's star filter reads the same rows");
  const answered = await (await get("/api/reviews?propertyId=agm&responded=true")).body;
  assert.deepEqual(answered.map((r) => r.id), ["rev_1"]);

  const reserve = await (await get("/api/reviews/stats/ari")).body;
  assert.deepEqual([reserve.total, reserve.avg, reserve.responded], [1, 3, 0],
    "the Reserve counts its own review and nothing of the marina's");
});
