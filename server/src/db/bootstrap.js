/**
 * First-run bootstrap for a real install.
 *
 * A production database starts empty: `db:migrate` creates the tables and
 * nothing else. This script creates the first property, its settings row, the
 * default permission matrix and one Manager account, so the API has a door to
 * sign in through. It is idempotent — running it again resets that account's
 * password rather than failing on the unique email.
 *
 *   ADMIN_EMAIL=you@hotel.com ADMIN_PASSWORD='…' node src/db/bootstrap.js
 *
 * Optional: ADMIN_NAME, PROPERTY_CODE, PROPERTY_NAME, PROPERTY_CITY.
 */
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const { rolePermissions } = require("./seed");

const BCRYPT_ROUNDS = 12;

function slugOf(code) {
  return String(code).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "hotel";
}

function defaultSettings(code) {
  return {
    currency: "NGN",
    finance: {
      invoicePrefix: String(code).toUpperCase().slice(0, 3),
      paymentDays: 7,
      approvalAmount: 500000,
      discountPct: 10,
      rateMaxAgeDays: 3,
    },
    depositPct: 25,
    checkInTime: "15:00",
    checkOutTime: "12:00",
    language: "English (UK)",
    overbooking: 0,
    cancellation: "Free cancellation up to 48 hours before arrival. One night charged thereafter.",
    integrations: {
      channelManager: false, paymentGateway: false, doorLocks: false,
      accounting: false, crm: false, whatsapp: false,
    },
  };
}

async function bootstrap(client, opts = {}) {
  const email = String(opts.email || "").trim().toLowerCase();
  const name = String(opts.name || "").trim() || "Administrator";
  const password = String(opts.password || "");
  const code = String(opts.propertyCode || "HOTEL").trim().toUpperCase();
  const propertyName = String(opts.propertyName || "Aurelia Hotel").trim();
  const city = String(opts.city || "Lagos").trim();

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error("A valid administrator email is required (ADMIN_EMAIL).");
  }
  if (password.length < 8) {
    throw new Error("ADMIN_PASSWORD must be at least 8 characters.");
  }

  const pid = slugOf(code);
  const short = propertyName.split(/\s+/).slice(0, 2).join(" ");

  await client.query("BEGIN");
  try {
    await client.query(
      `INSERT INTO properties (id, code, name, short, city) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO NOTHING`,
      [pid, code, propertyName, short, city]
    );
    await client.query(
      `INSERT INTO settings (property_id, data) VALUES ($1,$2)
       ON CONFLICT (property_id) DO NOTHING`,
      [pid, defaultSettings(code)]
    );
    await client.query(
      `INSERT INTO staff_permissions (id, data) VALUES (1,$1)
       ON CONFLICT (id) DO NOTHING`,
      [rolePermissions()]
    );

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const existing = await client.query(`SELECT id FROM users WHERE email = $1`, [email]);
    let userId;
    if (existing.rowCount) {
      userId = existing.rows[0].id;
      await client.query(
        `UPDATE users SET property_id=$2, password_hash=$3, name=$4, role='Manager', is_active=true
         WHERE id=$1`,
        [userId, pid, hash, name]
      );
    } else {
      const created = await client.query(
        `INSERT INTO users (property_id, email, password_hash, name, role, is_active)
         VALUES ($1,$2,$3,$4,'Manager',true) RETURNING id`,
        [pid, email, hash, name]
      );
      userId = created.rows[0].id;
    }

    await client.query("COMMIT");
    return { propertyId: pid, email, userId, created: !existing.rowCount };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    const out = await bootstrap(client, {
      email: process.env.ADMIN_EMAIL,
      name: process.env.ADMIN_NAME,
      password: process.env.ADMIN_PASSWORD,
      propertyCode: process.env.PROPERTY_CODE,
      propertyName: process.env.PROPERTY_NAME,
      city: process.env.PROPERTY_CITY,
    });
    console.log(`✅ ${out.created ? "Created" : "Updated"} the Manager account ${out.email}`);
    console.log(`   Property: ${out.propertyId} · user ${out.userId}`);
    console.log("   Sign in with ADMIN_EMAIL and ADMIN_PASSWORD, then change the password.");
  } catch (err) {
    console.error("❌ Bootstrap failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = { bootstrap, defaultSettings, slugOf };
