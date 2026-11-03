/**
 * Lost & found — the port of the housekeeping register
 * (assets/pages-operations.js, LHMS.actions.createLostItem / setLostStatus).
 *
 * The rules are the page's: an item is logged with the guest it came from, four
 * statuses move it along, and the register leaves the building as the same file
 * the Export button writes. What the API adds is the property wall — a desk at
 * the Grand Marina cannot read or move the Reserve's register — and the refuse
 * before the write, so a blank tag is not a row.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot, dstr } = require("./helpers/api");

const log = async (ctx, id) => (await ctx.query(`SELECT * FROM lost_found WHERE id = $1`, [id])).rows[0];
const trail = async (ctx, action) => (await ctx.query(
  `SELECT * FROM activity_log WHERE action = $1 ORDER BY created_at`, [action])).rows;

test("the register shows the property's own items and nothing from the neighbour", async () => {
  const ctx = await boot();
  await ctx.query(
    `INSERT INTO lost_found (id,property_id,description,location,found_by,status,found_date)
     VALUES ('lf_ari','ari','Silk scarf','Lobby','Night porter','Stored',$1)`, [ctx.day]);

  const mine = await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Gold hoop earring", room: "101" });
  assert.equal(mine.status, 201, JSON.stringify(mine.body));

  const own = await ctx.as("Front Desk").get("/api/lost-found");
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(own.body.map((l) => l.id), [mine.body.id], "the desk reads only its own register");

  // A manager may look at another hotel's register; the desk may not leave its own.
  const manager = await ctx.as("Manager").get("/api/lost-found?propertyId=ari");
  assert.equal(manager.status, 200, JSON.stringify(manager.body));
  assert.deepEqual(manager.body.map((l) => l.id), ["lf_ari"]);

  const outside = await ctx.as("Front Desk").get("/api/lost-found?propertyId=ari");
  assert.equal(outside.status, 403, JSON.stringify(outside.body));
});

test("logging an item keeps the finder, the room and the guest it came from", async () => {
  const ctx = await boot();
  const out = await ctx.as("Housekeeping").post("/api/lost-found").send({
    item: "Gold hoop earring", room: "101", guestId: "gst_1",
    note: "Sealed in the safe, shelf B" });

  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.property_id, "agm");
  assert.equal(out.body.status, "Stored");
  assert.equal(out.body.description, "Gold hoop earring");
  assert.equal(out.body.location, "101");
  assert.equal(out.body.room_id, "agm_101", "a numbered place links to its room");
  assert.equal(out.body.guest_id, "gst_1");
  assert.equal(out.body.guest_name, "Adaeze Nwankwo");
  assert.equal(dstr(out.body.found_date), ctx.day, "the item is filed on the business day");
  assert.equal(out.body.found_by, "Grace Mensah", "the hand at the desk is the fallback finder");

  const named = await ctx.as("Front Desk").post("/api/lost-found")
    .send({ item: "Umbrella", room: "Lobby", foundBy: "Security" });
  assert.equal(named.status, 201, JSON.stringify(named.body));
  assert.equal(named.body.found_by, "Security");
  assert.equal(named.body.room_id, null, "an area is not a room row");

  const lines = await trail(ctx, "logged a lost item");
  assert.equal(lines.length, 2);
  assert.equal(lines[0].actor, "Grace Mensah");
  assert.match(lines[0].detail, /Gold hoop earring · Room 101/);
});

test("a tag with no description is refused before a row is written", async () => {
  const ctx = await boot();
  for (const body of [{ item: "   ", room: "305" }, { room: "305" }, { item: "Scarf" }]) {
    const out = await ctx.as("Housekeeping").post("/api/lost-found").send(body);
    assert.equal(out.status, 422, `${JSON.stringify(body)} → ${out.status} ${JSON.stringify(out.body)}`);
    assert.match(out.body.error, /required/i);
  }
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM lost_found`)).rows[0].n, 0);

  const stranger = await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Scarf", room: "305", guestId: "gst_nobody" });
  assert.equal(stranger.status, 422, JSON.stringify(stranger.body));
  assert.equal(stranger.body.error, "Guest not found.");
});

test("a status move is one hand-over; the same status writes nothing the second time", async () => {
  const ctx = await boot();
  const made = await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Child's stuffed rabbit", room: "101", guestId: "gst_2" });

  const back = await ctx.as("Front Desk")
    .patch(`/api/lost-found/${made.body.id}`).send({ status: "Returned" });
  assert.equal(back.status, 200, JSON.stringify(back.body));
  assert.equal(back.body.status, "Returned");
  assert.ok(back.body.claimed_at, "a return carries the moment it went back");

  const again = await ctx.as("Front Desk")
    .patch(`/api/lost-found/${made.body.id}`).send({ status: "Returned" });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(dstr(again.body.claimed_at), dstr(back.body.claimed_at), "the first hand-over stands");

  const lines = await trail(ctx, "updated lost & found");
  assert.equal(lines.length, 1, "the trail reads the move once");
  assert.match(lines[0].detail, /Child's stuffed rabbit → Returned/);
  assert.equal((await log(ctx, made.body.id)).status, "Returned");
});

test("an unknown status and an unknown item are refused, and the register is closed to the auditor", async () => {
  const ctx = await boot();
  const made = await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Prescription glasses", room: "101" });

  const bad = await ctx.as("Housekeeping")
    .patch(`/api/lost-found/${made.body.id}`).send({ status: "Lost" });
  assert.equal(bad.status, 422, JSON.stringify(bad.body));

  const missing = await ctx.as("Housekeeping")
    .patch("/api/lost-found/lf_nothing").send({ status: "Returned" });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));

  const auditor = await ctx.as("Auditor").get("/api/lost-found");
  assert.equal(auditor.status, 403, JSON.stringify(auditor.body));
  const auditorWrite = await ctx.as("Auditor").post("/api/lost-found")
    .send({ item: "Scarf", room: "305" });
  assert.equal(auditorWrite.status, 403, JSON.stringify(auditorWrite.body));
  assert.equal((await ctx.query(`SELECT count(*) AS n FROM lost_found`)).rows[0].n, 1,
    "the refusals wrote nothing");
});

test("the register exports the page's own columns as the page's own file", async () => {
  const ctx = await boot();
  await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Gold hoop earring", room: "101", guestId: "gst_1" });
  await ctx.as("Housekeeping").post("/api/lost-found")
    .send({ item: "Umbrella", room: "Lobby", foundBy: "Security" });

  const out = await ctx.as("Front Desk").get("/api/lost-found/export");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.match(out.headers["content-type"], /text\/csv/);
  assert.match(out.headers["content-disposition"], /aurelia-lost-found-AGM-\d{4}-\d{2}-\d{2}\.csv/);

  const text = out.text;
  assert.ok(text.startsWith("\ufeff"), "the file opens with a BOM, as every register export does");
  const rows = text.replace(/^\ufeff/, "").split("\r\n").filter(Boolean);
  assert.equal(rows[0], '"Item","Room","Found by","Date","Status","Guest"');
  assert.equal(rows.length, 3, "a header and the two items on the register");
  assert.ok(rows.some((r) => r.includes('"Gold hoop earring"') && r.includes('"Adaeze Nwankwo"')));
  assert.ok(rows.some((r) => r.includes('"Umbrella"') && r.includes('"Security"')));

  const line = await trail(ctx, "exported lost & found");
  assert.equal(line.length, 1, "taking the register out of the building is logged");
  assert.match(line[0].detail, /2 items/);
});

test("an empty register is refused a file rather than handed over as bare headers", async () => {
  const ctx = await boot();
  const out = await ctx.as("Housekeeping").get("/api/lost-found/export");
  assert.equal(out.status, 422, JSON.stringify(out.body));
  assert.match(out.body.error, /No records available/);
});
