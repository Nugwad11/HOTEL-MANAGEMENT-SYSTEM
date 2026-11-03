/**
 * Deployment posture — the things that only matter once this leaves a laptop.
 *
 * A production process must refuse to boot on a default secret, a load balancer
 * needs a health door that answers for the database, and a fresh install needs
 * a way to create its first Manager without loading fictional data.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const request = require("supertest");
const { install } = require("./helpers/memdb");
const config = require("../src/config");
const { bootstrap } = require("../src/db/bootstrap");

const SRC = path.join(__dirname, "..", "src") + path.sep;

/** A booted app over a clean in-memory database, with nothing seeded. */
function boot() {
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC)) delete require.cache[k]; });
  const { pool } = install();
  const app = require("../src/index.js");
  return { app, pool };
}

test("a production boot refuses defaults and names what is missing", () => {
  const missing = config.productionIssues({ NODE_ENV: "production" });
  assert.ok(missing.includes("DATABASE_URL"));
  assert.ok(missing.includes("JWT_SECRET"));
  assert.ok(missing.includes("CORS_ORIGIN"));
  assert.throws(() => config.assertProduction({ NODE_ENV: "production" }), /Refusing to start in production/);

  const placeholder = config.productionIssues({
    NODE_ENV: "production", DATABASE_URL: "postgres://x", CORS_ORIGIN: "https://hms.test",
    JWT_SECRET: "replace_with_64_byte_hex_string",
  });
  assert.ok(placeholder.some((p) => p.startsWith("JWT_SECRET")));

  const short = config.productionIssues({
    NODE_ENV: "production", DATABASE_URL: "postgres://x", CORS_ORIGIN: "https://hms.test",
    JWT_SECRET: "too-short",
  });
  assert.ok(short.some((p) => p.startsWith("JWT_SECRET")));

  const wildcard = config.productionIssues({
    NODE_ENV: "production", DATABASE_URL: "postgres://x", CORS_ORIGIN: "*",
    JWT_SECRET: "a".repeat(64),
  });
  assert.ok(wildcard.some((p) => p.startsWith("CORS_ORIGIN")));

  assert.deepEqual(config.productionIssues({
    NODE_ENV: "production", DATABASE_URL: "postgres://x", CORS_ORIGIN: "https://hms.test,https://admin.test",
    JWT_SECRET: "a".repeat(64),
  }), []);
  assert.deepEqual(config.productionIssues({ NODE_ENV: "development" }), []);
});

test("the demonstration seed is refused on a production install unless it is asked for", () => {
  assert.equal(config.demoSeedAllowed({ NODE_ENV: "development" }), true);
  assert.equal(config.demoSeedAllowed({ NODE_ENV: "test" }), true);
  assert.equal(config.demoSeedAllowed({ NODE_ENV: "production" }), false);
  assert.equal(config.demoSeedAllowed({ NODE_ENV: "production", ALLOW_DEMO_SEED: "true" }), true);
});

test("the health door answers for the database, not just the process", async () => {
  const { app } = boot();
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
  assert.equal(res.body.status, "ok");
  assert.equal(res.body.db, "up");
  assert.equal(typeof res.body.uptime, "number");
});

test("the app serves the SPA and its assets, and publishes nothing else", async () => {
  const { app } = boot();

  const page = await request(app).get("/");
  assert.equal(page.status, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.text, /<title>Aurelia Grand/);
  assert.ok(page.text.includes('src="assets/app.js"'), "the shell still loads the app");

  const css = await request(app).get("/assets/styles.css");
  assert.equal(css.status, 200);
  assert.match(css.headers["content-type"], /text\/css/);

  // The repository root is not a static mount: these must stay closed.
  for (const url of ["/server/.env", "/server/src/index.js", "/DEPLOYMENT.md", "/package.json"]) {
    const res = await request(app).get(url);
    assert.equal(res.status, 404, url + " must not be published");
  }
});

test("the proposal is downloadable and the rest of its folder is not published", async () => {
  const { app } = boot();
  const res = await request(app)
    .get("/proposal/Aurelia-Grand-HMS-Proposal.pdf")
    .buffer(true)
    .parse((stream, done) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("end", () => done(null, Buffer.concat(chunks)));
    });

  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/pdf/);
  assert.match(res.headers["content-disposition"],
    /attachment; filename="Aurelia-Grand-HMS-Proposal.pdf"/);
  assert.equal(res.body.subarray(0, 5).toString(), "%PDF-", "the body is the document itself");
  assert.ok(res.body.length > 1_000_000, "the whole file was sent, not a stub");

  for (const url of ["/proposal/proposal.html", "/proposal/", "/proposal/Aurelia-Grand-HMS-Proposal.docx"]) {
    assert.equal((await request(app).get(url)).status, 404, url + " must not be published");
  }
});

test("the browser is sent a frame-denying policy and no framework banner", async () => {
  const { app } = boot();
  const res = await request(app).get("/");
  assert.equal(res.headers["x-powered-by"], undefined);
  const csp = res.headers["content-security-policy"] || "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /object-src 'none'/);
});

test("a fresh database gets one property, its permissions and a working Manager", async () => {
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC)) delete require.cache[k]; });
  const { pool } = install();
  const client = await pool.connect();
  const first = await bootstrap(client, {
    email: "ops@hotel.test", password: "long-enough-pass", name: "Ops Manager",
    propertyCode: "HTL", propertyName: "Hotel Test", city: "Lagos",
  });
  client.release();

  assert.equal(first.propertyId, "htl");
  assert.equal(first.created, true);
  assert.equal((await pool.query(`SELECT id FROM properties`)).rowCount, 1);
  assert.equal((await pool.query(`SELECT property_id FROM settings`)).rowCount, 1);
  assert.equal((await pool.query(`SELECT id FROM staff_permissions WHERE id = 1`)).rowCount, 1);

  const app = require("../src/index.js");
  const login = await request(app).post("/api/auth/login")
    .send({ email: "ops@hotel.test", password: "long-enough-pass" });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  assert.equal(login.body.user.role, "Manager");
  assert.equal(login.body.user.propertyId, "htl");

  // Re-running the bootstrap resets that account rather than failing on the email.
  const again = await pool.connect();
  const second = await bootstrap(again, {
    email: "ops@hotel.test", password: "another-long-pass", name: "Ops Manager",
    propertyCode: "HTL", propertyName: "Hotel Test",
  });
  again.release();
  assert.equal(second.created, false);

  const rotated = await request(app).post("/api/auth/login")
    .send({ email: "ops@hotel.test", password: "another-long-pass" });
  assert.equal(rotated.status, 200);
  const stale = await request(app).post("/api/auth/login")
    .send({ email: "ops@hotel.test", password: "long-enough-pass" });
  assert.equal(stale.status, 401);
});

test("the bootstrap refuses a weak password and a malformed email", async () => {
  const { pool } = install();
  const client = await pool.connect();
  await assert.rejects(
    bootstrap(client, { email: "ops@hotel.test", password: "short" }),
    /at least 8 characters/
  );
  await assert.rejects(
    bootstrap(client, { email: "not-an-email", password: "long-enough-pass" }),
    /valid administrator email/
  );
  client.release();
});
