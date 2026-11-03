/**
 * In-memory PostgreSQL for the API tests.
 *
 * The routes talk to src/db/pool.js. This helper builds the real migration
 * schema inside pg-mem, then replaces that module in the require cache, so a
 * test exercises the same SQL a live database would run — not a mock of it.
 */
const { newDb, DataType } = require("pg-mem");
const path = require("path");
const crypto = require("crypto");

// jwt.js refuses to load without a secret, and pool.js is replaced anyway.
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-please-ignore";
process.env.NODE_ENV = "test";

// The door that issues a guest token is rate limited like a staff login — ten
// attempts per quarter hour is the point of it. A test suite is allowed to be
// noisier than an attacker, so the harness lifts the ceiling rather than have a
// file prove a 401 it never sent.
process.env.AUTH_RATE_LIMIT_MAX = process.env.AUTH_RATE_LIMIT_MAX || "10000";

const POOL_MODULE = path.join(__dirname, "..", "..", "src", "db", "pool.js");
const { SCHEMA } = require("../../src/db/migrate");

function install() {
  const db = newDb({ autoCreateForeignKeyIndices: true });

  // The schema defaults UUID primary keys with gen_random_uuid(), which pg-mem
  // does not ship.
  db.public.registerFunction({
    name: "gen_random_uuid",
    returns: DataType.uuid,
    impure: true,
    implementation: () => crypto.randomUUID(),
  });

  // pg-mem's parser takes -- comments but chokes on /* block */ ones, and the
  // migration is sectioned with them. Dropping comments changes no SQL.
  db.public.none(SCHEMA.replace(/\/\*[\s\S]*?\*\//g, ""));

  // pg-mem's own pg adapter implements the Pool surface the routes use —
  // parameterised queries, JSONB values and connect()/BEGIN transactions —
  // so the shim is not something I have to keep honest myself.
  const pool = new (db.adapters.createPg().Pool)();
  require.cache[POOL_MODULE] = {
    id: POOL_MODULE, filename: POOL_MODULE, loaded: true, exports: pool, children: [], paths: [],
  };
  return { db, pool };
}

module.exports = { install };
