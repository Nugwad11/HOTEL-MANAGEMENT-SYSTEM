/**
 * The business date and the sealed days around it.
 *
 * One value drives the whole group: closing a day rolls it for every property,
 * which is why the audit run is group-wide and why the check lives here rather
 * than on a property row.
 */
const pool = require("../db/pool");

function pretty(date) {
  if (!date) return "—";
  const d = new Date(String(date).slice(0, 10) + "T12:00:00Z");
  if (isNaN(d)) return String(date);
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The date money is being dated against, in YYYY-MM-DD. */
function dstr(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Nights between an arrival and a departure — the length of a stay. A stay
    that doubles back on itself is zero nights, never a negative one. */
function nights(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((new Date(dstr(b) + "T12:00:00Z") - new Date(dstr(a) + "T12:00:00Z")) / 86400000));
}

/* Hall bookings are stored as "HH:MM" strings so the picker stays a plain
   input; the maths below is the only place they are converted. */
function timeMins(t) {
  const p = String(t || "").split(":");
  const h = Number(p[0]);
  const m = Number(p[1] || 0);
  if (!(h >= 0 && h < 24) || !(m >= 0 && m < 60)) return null;
  return h * 60 + m;
}

function hoursBetween(a, b) {
  const x = timeMins(a);
  const y = timeMins(b);
  if (x === null || y === null || y <= x) return null;
  return Math.round(((y - x) / 60) * 100) / 100;
}

/** Two ranges that only touch at an endpoint do not overlap — a break between
    functions is not a clash. Only real interior overlap counts. */
function overlaps(aS, aE, bS, bE) {
  const a1 = timeMins(aS), a2 = timeMins(aE), b1 = timeMins(bS), b2 = timeMins(bE);
  if (a1 === null || a2 === null || b1 === null || b2 === null) return false;
  return a1 < b2 && b1 < a2;
}

/** How many hours the event's start is from the business day standing at noon. */
function hoursUntil(date, time, day) {
  const mins = timeMins(time);
  if (mins === null) return null;
  const days = (new Date(dstr(date) + "T12:00:00Z") - new Date(dstr(day) + "T12:00:00Z")) / 86400000;
  return days * 24 + (mins - 720) / 60;
}

/** The day money is dated against. A caller inside a transaction reads its own,
    which is how the seed dates the documents it raises while it is still writing
    the stays they bill. */
async function businessDay(client) {
  const { rows } = await (client || pool).query(`SELECT day FROM business_date WHERE id = 1`);
  return dstr(rows[0] && rows[0].day) || dstr(new Date());
}

/**
 * A day is closed if that day or any later one was sealed — a date is never
 * reopened, so everything at or before the roll point is history.
 */
async function dayIsClosed(date) {
  const { rows } = await pool.query(`SELECT 1 FROM closed_days WHERE date >= $1 LIMIT 1`, [dstr(date)]);
  return rows.length > 0;
}

async function closedOn(date) {
  const { rows } = await pool.query(`SELECT * FROM closed_days WHERE date = $1`, [dstr(date)]);
  const r = rows[0];
  if (!r) return null;
  return { date: dstr(r.date), rolledTo: dstr(r.rolled_to), at: r.closed_at, by: r.closed_by };
}

/**
 * Move the group date. The row is created on the first roll rather than assumed
 * from the seed, because a deployment that predates the audit still has to be
 * able to close a day.
 */
async function setBusinessDay(day) {
  const { rowCount } = await pool.query(`UPDATE business_date SET day = $2 WHERE id = 1`, [null, dstr(day)]);
  if (!rowCount) {
    await pool.query(`INSERT INTO business_date (id, day, seeded_on) VALUES (1, $1, $1)`, [dstr(day)]);
  }
  return dstr(day);
}

/**
 * The refusal a caller gets when money is aimed at a day somebody already
 * signed for. A sealed day's totals are in the pack on file, so a correction
 * has to be new money on the open date, not a rewrite of the old one.
 */
async function sealedRefusal(date) {
  if (!(await dayIsClosed(date))) return null;
  const today = await businessDay();
  return `The business date ${pretty(date)} is closed and sealed. Nothing posts into a closed day — ` +
    `put the correction on ${pretty(today)} instead.`;
}

module.exports = {
  businessDay, dayIsClosed, closedOn, sealedRefusal, setBusinessDay,
  addDays, dstr, pretty, nights, timeMins, hoursBetween, overlaps, hoursUntil,
};
