/* ============================================================
   assets/api.js is the REST surface's table of contents, and a table of
   contents is only worth keeping if something checks it. Two drifts are
   fatal in opposite ways: a door with no route behind it is a caller that
   gets 404 from a screen that looked like it was asking for a folio, and a
   ported route with no door is a money rule the API enforces that nobody on
   the client side can even name. The last rule below is the one this file
   existed to break: the client may describe the API, but it may not rewrite
   the app — sign-in is read synchronously by the login form, so a client
   that swaps in an async version fails silently instead of loudly.

   Nothing here boots a database. The routes are read as they are declared,
   because that is the same text the server wires into Express.
   ============================================================ */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = path.join(__dirname, "../src");
const CLIENT = path.join(__dirname, "../../assets/api.js");

/* "/api/auth" + "/login" → "/api/auth/login"; a mounted router's "/" is the
   mount itself. */
function joined(prefix, sub) {
  if (sub === "/" || sub === "") return prefix;
  return prefix + sub;
}

/* The published-file block serves the shell, the assets and the proposal PDF.
   Those are documents, not JSON doors, so they are not part of the surface the
   client's table mirrors. Remove the block before scanning for API routes. */
function withoutStaticBlock(src) {
  const start = src.indexOf("if (config.staticEnabled()) {");
  if (start === -1) return src;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(0, start) + src.slice(i + 1);
  }
  return src;
}

/* Every route the server declares: the mount list in src/index.js, then each
   router's own paths. A method + path pair, in the server's own words. */
function declaredRoutes() {
  const wiring = withoutStaticBlock(fs.readFileSync(path.join(SRC, "index.js"), "utf8"));
  const out = [];
  let m;
  const mountRe = /app\.use\("([^"]+)",\s*require\("(\.[^"]+)"\)\)/g;
  while ((m = mountRe.exec(wiring))) {
    const file = path.join(SRC, m[2].replace(/^\.\//, "") + ".js");
    const body = fs.readFileSync(file, "utf8");
    const routeRe = /router\.(get|post|patch|put|delete)\("([^"]*)"/g;
    let r;
    while ((r = routeRe.exec(body))) {
      out.push({ method: r[1].toUpperCase(), path: joined(m[1], r[2]), file: path.basename(file) });
    }
  }
  const bareRe = /app\.(get|post|patch|put|delete)\("([^"]*)"/g;
  while ((m = bareRe.exec(wiring))) {
    out.push({ method: m[1].toUpperCase(), path: m[2], file: "index.js" });
  }
  return out;
}

/* The client's door table, read out of the file rather than trusted from a
   summary of it. */
function clientDoors() {
  const src = fs.readFileSync(CLIENT, "utf8");
  const start = src.indexOf("var DOORS = {");
  assert.notEqual(start, -1, "the client keeps its surface in one DOORS table");
  const table = src.slice(start, src.indexOf("};", start));
  const doors = [];
  const re = /^\s*([A-Za-z]\w*):\s*\["(GET|POST|PATCH|PUT|DELETE)",\s*"([^"]+)"\]/gm;
  let m;
  while ((m = re.exec(table))) {
    doors.push({ name: m[1], method: m[2], path: m[3] });
  }
  return doors;
}

/* One :param is another {param} is "*": the two files name the same slot
   differently, and neither name is the contract. */
function key(method, routePath) {
  const shape = routePath.split("/").map((s) =>
    (s.charAt(0) === ":" || (s.charAt(0) === "{" && s.charAt(s.length - 1) === "}")) ? "*" : s
  ).join("/");
  return method + " " + shape;
}

test("the client's doors all open onto a route the server actually mounts", () => {
  const declared = new Set(declaredRoutes().map((r) => key(r.method, r.path)));
  const phantoms = clientDoors()
    .filter((d) => !declared.has(key(d.method, d.path)))
    .map((d) => d.name + " → " + d.method + " " + d.path);
  assert.deepEqual(phantoms, [], "a door that answers 404 is worse than no door at all");
});

test("every route the server mounts has a door the client can name", () => {
  const covered = new Set(clientDoors().map((d) => key(d.method, d.path)));
  const gaps = declaredRoutes()
    .filter((r) => !covered.has(key(r.method, r.path)))
    .map((r) => key(r.method, r.path) + " (" + r.file + ")");
  assert.deepEqual(gaps, [], "a ported rule the client cannot reach is a port left half done");
});

test("no two doors claim the same route", () => {
  const seen = {};
  const doubles = [];
  clientDoors().forEach((d) => {
    const k = key(d.method, d.path);
    if (seen[k]) doubles.push(seen[k] + " and " + d.name + " both answer " + k);
    else seen[k] = d.name;
  });
  assert.deepEqual(doubles, [], "one door per door");
});

test("the table covers the surface rather than a corner of it", () => {
  const declared = declaredRoutes();
  const doors = clientDoors();
  // A parser that quietly matched nothing would pass the two checks above with
  // an empty set, so the size of each side is stated on its own.
  assert.ok(declared.length > 100, "the server mounts " + declared.length + " routes");
  assert.equal(doors.length, declared.length, "one named door for every declared route");
  assert.ok(declared.some((r) => r.path === "/api/audit/run" && r.method === "POST"),
    "the night audit door is in the list the client is checked against");

  // The two drifts this file carried, named so neither comes back quietly: an
  // event status change the server never had, and a room release it has had
  // since the task door was ported.
  const named = doors.reduce((a, d) => { a[d.name] = d; return a; }, {});
  assert.equal(named.confirmEvent.path + " " + named.confirmEvent.method,
    "/api/events/{eventId}/confirm POST", "an event is confirmed, not set to a status");
  assert.equal(named.completeTask.path, "/api/tasks/{taskId}/complete",
    "the door that releases a room is on the list");
  assert.ok(!declared.some((r) => r.path === "/api/events/:id/status"),
    "PATCH /api/events/:id/status is not a route, so no door may name it");
});

/* The prose is allowed to name a function precisely to say the file does not
   touch it; the check below is about code, so the comments come off first. */
function codeOnly(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

test("the client describes the API and never rewrites the app", () => {
  const src = codeOnly(fs.readFileSync(CLIENT, "utf8"));
  const writes = [];
  const re = /LHMS\.([A-Za-z]\w*)\s*=[^=]/g;
  let m;
  while ((m = re.exec(src))) writes.push("LHMS." + m[1]);
  assert.deepEqual(writes, ["LHMS.api"],
    "exposing LHMS.api is the only assignment the client is allowed to make");
  ["signIn", "signOut", "session", "persistSession", "bindGuestSession"].forEach((fn) => {
    assert.doesNotMatch(src, new RegExp("LHMS\\." + fn + "\\b"),
      "patching " + fn + " replaces a synchronous call the login form reads as an object");
  });
});
