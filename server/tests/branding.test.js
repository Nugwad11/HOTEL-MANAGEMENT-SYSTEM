/**
 * The hotel's brand against the API — the port of the manager's Brand & images
 * tab. Two rules carry the module: the block is written whole and never touches
 * the commercial policies beside it, and the trail names what moved (an image
 * count, not a base64 string) so re-saving the tab cannot claim a change that
 * never happened.
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { boot } = require("./helpers/api");

const BRAND = "/api/properties/agm/branding";
const SETTINGS = "/api/properties/agm/settings";
const NAME = "Aurelia Grand Marina";

const SMALL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lU8HkAAAAABJRU5ErkJggg==";

const blobOf = async (query, pid) => {
  const { rows } = await query(`SELECT data FROM settings WHERE property_id = $1`, [pid]);
  return typeof rows[0].data === "string" ? JSON.parse(rows[0].data) : rows[0].data;
};
const linesFor = async (query, entity) =>
  (await query(`SELECT action, actor, detail FROM activity_log WHERE entity = $1 ORDER BY created_at DESC`, [entity])).rows;

test("the manager dresses the property and the policies ride through untouched", async () => {
  const { as, query } = await boot();
  const before = await blobOf(query, "agm");

  const r = await as("Manager").patch(BRAND).send({
    brandName: "Marina House",
    tagline: "On the lagoon",
    logo: SMALL,
    palette: ["#16283f", "#b18f52"],
    useColors: true,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, [
    "name Aurelia Grand → Marina House",
    'tagline "Hotels & Residences" → "On the lagoon"',
    "logo added",
    "logo palette applied",
  ]);
  assert.equal(r.body.branding.brandName, "Marina House");
  assert.equal(r.body.branding.logo, SMALL);
  assert.equal(r.body.branding.updatedBy, "Ifeoma Okafor");
  assert.ok(r.body.branding.updatedAt);

  const after = await blobOf(query, "agm");
  assert.equal(after.depositPct, before.depositPct, "the deposit is not part of the brand");
  assert.equal(after.finance.approvalAmount, before.finance.approvalAmount, "nor is the finance block");
  assert.equal(after.branding.brandName, "Marina House");

  const read = await as("Manager").get(SETTINGS);
  assert.equal(read.status, 200);
  assert.equal(read.body.branding.tagline, "On the lagoon");
  assert.equal(read.body.branding.useColors, true);

  const [line] = await linesFor(query, "hotel brand");
  assert.equal(line.action, "updated the hotel brand");
  assert.equal(line.actor, "Ifeoma Okafor");
  assert.equal(line.detail, `${NAME} · ${r.body.changed.join(" · ")}`);
});

test("the gallery is counted, capped and not restamped by a no-op", async () => {
  const { as, query } = await boot();

  let r = await as("Manager").patch(BRAND).send({
    images: [{ src: SMALL, name: "Lobby" }, { src: SMALL, name: "Pool" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.changed, ["images 0 → 2"]);
  assert.deepEqual(r.body.branding.images.map((i) => i.name), ["Lobby", "Pool"]);
  const stamped = r.body.branding.updatedAt;
  const lines = (await linesFor(query, "hotel brand")).length;

  const again = await as("Manager").patch(BRAND).send({
    images: [{ src: SMALL, name: "Lobby" }, { src: SMALL, name: "Pool" }],
  });
  assert.equal(again.status, 200);
  assert.deepEqual(again.body.changed, []);
  assert.equal(again.body.branding.updatedAt, stamped, "a no-op does not restamp the brand");
  const [line] = await linesFor(query, "hotel brand");
  assert.equal(line.detail, `${NAME} · nothing moved`);
  assert.equal((await linesFor(query, "hotel brand")).length, lines + 1);

  const seven = Array.from({ length: 7 }, () => ({ src: SMALL, name: "x" }));
  const over = await as("Manager").patch(BRAND).send({ images: seven });
  assert.equal(over.status, 422);
  assert.match(over.body.error, /Six images/);
});

test("only a manager may sign the brand, and the door refuses what the uploader cannot make", async () => {
  const { as, query } = await boot();
  const untouched = JSON.stringify(await blobOf(query, "agm"));
  const lines = (await linesFor(query, "hotel brand")).length;

  for (const role of ["Front Desk", "Housekeeping", "Revenue", "Finance Manager", "Auditor"]) {
    const refused = await as(role).patch(BRAND).send({ brandName: "Not mine" });
    assert.equal(refused.status, 403, role);
  }

  const cases = [
    [{}, /Nothing to update/],
    [{ motto: "hello" }, /unrecognized|Unrecognized/i],
    [{ brandName: "   " }, /name the sign-in page can show/],
    [{ brandName: "A".repeat(61) }, /under 60/],
    [{ tagline: "A".repeat(91) }, /under 90/],
    [{ logo: "https://example.com/logo.png" }, /PNG, JPEG, WebP or SVG/],
    [{ logo: "data:image/png;base64," + "A".repeat(700000) }, /too large/],
    [{ images: [{ src: "assets/img/hero.jpg", name: "Hero" }] }, /PNG, JPEG, WebP or SVG/],
    [{ images: [{ src: SMALL, name: "A".repeat(81) }] }, /80 characters/],
    [{ palette: ["#16283f", "navy"] }, /#rrggbb/],
    [{ palette: ["#16283f", "#b18f52", "#d9c08d", "#3a5677", "#f7f0df", "#ffffff", "#000000", "#123456", "#654321"] }, /one and eight/],
    [{ useColors: "yes" }, /boolean|Expected/i],
  ];
  for (const [patch, message] of cases) {
    const refused = await as("Manager").patch(BRAND).send(patch);
    assert.equal(refused.status, 422, JSON.stringify(patch).slice(0, 60));
    assert.match(refused.body.error, message);
  }

  // Five 800k images fit the per-image cap but not the browser's whole budget.
  const heavy = Array.from({ length: 5 }, () => ({
    src: "data:image/png;base64," + "A".repeat(800000), name: "x",
  }));
  const tooHeavy = await as("Manager").patch(BRAND).send({ images: heavy });
  assert.equal(tooHeavy.status, 422);
  assert.match(tooHeavy.body.error, /more image than this browser can keep/);

  assert.equal(JSON.stringify(await blobOf(query, "agm")), untouched, "no refused write reached the book");
  assert.equal((await linesFor(query, "hotel brand")).length, lines, "and none was signed");
});
