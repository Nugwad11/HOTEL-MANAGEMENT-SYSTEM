/**
 * The guest book over the API — the CRM doors the desk and the profile page read.
 *
 * A profile is never one row: the notes a stay leaves behind are the part the
 * counter looks at before it hands out a key, so the door that answers `[]` for a
 * guest nobody has written about, newest note first, and the door that refuses a
 * guest somebody else's profile are proven here rather than assumed.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./helpers/api");

const ADAEZE = "adaeze@meridian.ng";

async function note(ctx, { id, guestId, text, by, at }) {
  const out = await ctx.query(
    `INSERT INTO guest_notes (id, guest_id, text, recorded_by, recorded_at, created_at)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [id, guestId, text, by, at, at]);
  assert.equal(out.rows.length, 1, `the note ${id} did not land`);
}

test("the guest book answers with each profile's notes attached", async () => {
  const ctx = await boot();
  await note(ctx, { id: "nt_1", guestId: "gst_1", text: "Penicillin allergy — flag to F&B", by: "Adamu Bello", at: "2026-10-01" });
  await note(ctx, { id: "nt_2", guestId: "gst_1", text: "Always asks for the high floor", by: "Grace Mensah", at: "2026-10-20" });

  const out = await ctx.as("Manager").get("/api/guests");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.map((g) => g.name), ["Adaeze Nwankwo", "Kunle Adeyemi"],
    "the book is alphabetical, not in the order the rows fell out");

  const [adaeze, kunle] = out.body;
  assert.deepEqual(adaeze.notes.map((n) => [n.id, n.text, n.recorded_by]),
    [["nt_2", "Always asks for the high floor", "Grace Mensah"],
     ["nt_1", "Penicillin allergy — flag to F&B", "Adamu Bello"]],
    "newest note first — the same order the profile page prints");
  assert.equal(adaeze.tier, "Platinum", "the guest row itself is intact beside its notes");
  assert.deepEqual(kunle.notes, [], "a guest nobody has written about carries an empty list, not a null");
});

test("the book filters and pages the way the profile page asks", async () => {
  const ctx = await boot();
  await note(ctx, { id: "nt_1", guestId: "gst_2", text: "Prefers the quiet wing", by: "Adamu Bello", at: "2026-10-05" });

  const byName = await ctx.as("Manager").get("/api/guests?q=adaeze");
  assert.deepEqual(byName.body.map((g) => g.id), ["gst_1"]);
  const byEmail = await ctx.as("Manager").get("/api/guests?q=meridian.ng");
  assert.deepEqual(byEmail.body.map((g) => g.id), ["gst_1"], "the same search reads the email as the name");
  const byTier = await ctx.as("Manager").get("/api/guests?tier=Gold");
  assert.deepEqual(byTier.body.map((g) => g.id), ["gst_2"]);
  assert.deepEqual(byTier.body[0].notes.map((n) => n.id), ["nt_1"], "a filtered row still carries its notes");

  const page = await ctx.as("Manager").get("/api/guests?limit=1&offset=1");
  assert.deepEqual(page.body.map((g) => g.id), ["gst_2"], "the second page is the second name");
  const nothing = await ctx.as("Manager").get("/api/guests?q=nobody-here");
  assert.deepEqual(nothing.body, [], "a book with no match is empty, not an error");
});

test("a profile opens on its own, and only for the people entitled to it", async () => {
  const ctx = await boot();
  await note(ctx, { id: "nt_1", guestId: "gst_1", text: "Anniversary on the 20th", by: "Ifeoma Okafor", at: "2026-10-10" });

  const one = await ctx.as("Front Desk").get("/api/guests/gst_1");
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.equal(one.body.name, "Adaeze Nwankwo");
  assert.deepEqual(one.body.notes.map((n) => [n.id, n.text]), [["nt_1", "Anniversary on the 20th"]]);

  const bare = await ctx.as("Front Desk").get("/api/guests/gst_2");
  assert.equal(bare.status, 200);
  assert.deepEqual(bare.body.notes, [], "a profile with no notes still answers a list");

  assert.equal((await ctx.as("Manager").get("/api/guests/gst_999")).status, 404);
  // The tier the board keeps for its own team, and the one an Auditor is not in.
  assert.equal((await ctx.as("Housekeeping").get("/api/guests")).status, 200);
  const audit = await ctx.as("Auditor").get("/api/guests");
  assert.equal(audit.status, 403);
  assert.equal((await ctx.as("Auditor").get("/api/guests/gst_1")).status, 403);

  // A signed-in guest is refused the staff book outright — their own profile
  // included. The portal is the door that speaks for a guest, and it reads the
  // same guest row; the guest half of the house never reaches this one.
  const signed = await ctx.anon.post("/api/auth/guest").send({ email: ADAEZE });
  assert.equal(signed.status, 200, JSON.stringify(signed.body));
  const asGuest = ctx.bearer(signed.body.token);
  for (const url of ["/api/guests", "/api/guests/gst_1", "/api/guests/gst_2"]) {
    const out = await asGuest.get(url);
    assert.equal(out.status, 403, `${url} answered ${out.status}: ${JSON.stringify(out.body)}`);
    assert.match(out.body.error, /Only the guest in house/);
  }
});

test("a note the desk records is on the profile the next clerk opens", async () => {
  const ctx = await boot();
  const added = await ctx.as("Front Desk").post("/api/guests/gst_2/notes").send({ text: "Travels with a guide dog." });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.guest_id, "gst_2");
  assert.equal(added.body.text, "Travels with a guide dog.");
  assert.equal(added.body.recorded_by, "Adamu Bello", "the note carries whose desk it was written at");

  const list = await ctx.as("Manager").get("/api/guests?q=Kunle");
  assert.deepEqual(list.body[0].notes.map((n) => n.text), ["Travels with a guide dog."]);
  const empty = await ctx.as("Front Desk").post("/api/guests/gst_2/notes").send({ text: "   " });
  assert.equal(empty.status, 422);
});
