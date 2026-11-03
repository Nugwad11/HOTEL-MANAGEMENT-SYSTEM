/**
 * Exchange rates and the currency gate — the port of LHMS.fxCore (assets/data.js)
 * and LHMS.fx (assets/store.js).
 *
 * Two rules drive everything here:
 *  • A rate is read AS OF the date being asked about. A charge posted on the 3rd
 *    is worth what a dollar bought on the 3rd, so a fixing filed on the 5th
 *    cannot revalue it, and a night the audit is billing today is valued at
 *    today's figure.
 *  • A rate goes off the air. An eight-day-old figure is a guess about what a
 *    dollar buys now, and a guess is not a price — so a currency with no usable
 *    rate cannot be sold, billed or paid in until someone with the right puts a
 *    fresh one on file.
 */
const pool = require("../db/pool");
const biz = require("./business-date");
const { jsonIn } = require("./json");
const { resolveFinanceSettings } = require("./finance");

/* The currencies this group is allowed to hold money in. The base currency is a
   property setting; everything else is only worth anything on the books once a
   rate is on file for it. */
const CURRENCIES = [
  { code: "NGN", name: "Nigerian Naira", symbol: "₦" },
  { code: "USD", name: "US Dollar", symbol: "$" },
  { code: "GBP", name: "British Pound", symbol: "£" },
  { code: "EUR", name: "Euro", symbol: "€" },
  { code: "GHS", name: "Ghanaian Cedi", symbol: "GH₵" },
  { code: "XAF", name: "CFA Franc BEAC", symbol: "FCFA " },
];
const CODES = CURRENCIES.map((c) => c.code);
const SYMBOLS = CURRENCIES.reduce((m, c) => (m[c.code] = c.symbol, m), {});

const round50 = (n) => Math.round(n / 50) * 50;
const symbolOf = (code) => SYMBOLS[String(code || "").toUpperCase()] || null;
function nameOf(code) {
  const hit = CURRENCIES.find((c) => c.code === String(code || "").toUpperCase());
  return hit ? hit.name : null;
}

const ageInDays = (from, to) =>
  Math.max(0, Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 86400000));

/** The newest fixing for that money which is not later than the date asked about. */
function rateOn(rates, code, date) {
  let best = null;
  (rates || []).forEach((r) => {
    if (r.code !== code) return;
    if (date && r.effective > date) return;
    if (!best || r.effective > best.effective) best = r;
  });
  return best;
}

/** base / fresh / stale / missing, each with the sentence a refusal ends with. */
function state(rates, code, opts) {
  opts = opts || {};
  const base = opts.base || "NGN";
  const maxAge = opts.maxAgeDays === undefined || opts.maxAgeDays === null ? 3 : Number(opts.maxAgeDays);
  const date = opts.date || biz.dstr(new Date());
  const ask = code ? String(code).toUpperCase() : base;
  if (ask === base) {
    return { code: ask, base, state: "base", rate: 1, usable: true, ageDays: 0, effective: date, maxAgeDays: maxAge, error: null };
  }
  const row = rateOn(rates, ask, date);
  const rate = row ? Number(row.perBase) : null;
  if (!row || !isFinite(rate) || rate <= 0) {
    return {
      code: ask, base, state: "missing", rate: null, usable: false, ageDays: null, effective: null,
      maxAgeDays: maxAge, setBy: row ? row.setBy : null,
      error: `There is no ${ask} rate on file for this date, so a ${ask} figure cannot be worth anything on the ` +
        `${base} books. Set the rate in Financial settings first.`,
    };
  }
  const age = ageInDays(row.effective, date);
  if (age > maxAge) {
    return {
      code: ask, base, state: "stale", rate, usable: false, ageDays: age,
      effective: row.effective, maxAgeDays: maxAge, setBy: row.setBy,
      error: `The last ${ask} rate was set on ${biz.pretty(row.effective)} — ${age} days old, and this property ` +
        `trusts a rate for ${maxAge}${maxAge === 1 ? " day." : " days."}`,
    };
  }
  return {
    code: ask, base, state: "fresh", rate, usable: true, ageDays: age,
    effective: row.effective, maxAgeDays: maxAge, setBy: row.setBy, error: null,
  };
}

/** The conversion every money record takes at the moment it is written. */
function toBase(rates, amount, code, opts) {
  const st = state(rates, code, opts);
  const n = Math.round(Number(amount) || 0);
  if (!st.usable) return { ok: false, error: st.error, state: st };
  return { ok: true, base: st.state === "base" ? n : round50(n * st.rate), rate: st.rate, currency: st.code, state: st };
}

/* ── the database side ───────────────────────────────────────── */

function mapRate(r) {
  return {
    id: r.id, code: r.code, perBase: Number(r.per_base), effective: biz.dstr(r.effective),
    setBy: r.set_by, setAt: r.set_at, note: r.note,
  };
}

async function rateRows(db) {
  const q = db || pool;
  const { rows } = await q.query(`SELECT * FROM fx_rates ORDER BY effective DESC`);
  return rows.map(mapRate);
}

/**
 * One read for a whole pass. A night audit walks every property and every open
 * night, so the rates and the per-property money rules are taken once and the
 * pure core is asked per date — the same figures, without a query per night.
 *
 * `db` lets a caller inside a transaction read the rates it has written but not
 * committed yet — the only way the seed can value the bookings it files.
 */
async function sources(date, db) {
  const q = db || pool;
  const day = date || (await biz.businessDay());
  const [rates, settings] = await Promise.all([
    rateRows(q),
    q.query(`SELECT property_id, data FROM settings`),
  ]);
  const props = {};
  settings.rows.forEach((s) => {
    const blob = jsonIn(s.data, {});
    props[s.property_id] = {
      base: blob.currency || "NGN",
      maxAgeDays: resolveFinanceSettings(blob.finance || {}).rateMaxAgeDays,
    };
  });
  return { date: day, rates, props };
}

/** The reading one money record is valued at: its property's rules, that date. */
function contextOf(src, propertyId, date) {
  const p = (src.props && src.props[propertyId]) || {};
  return {
    base: p.base || "NGN",
    maxAgeDays: p.maxAgeDays === undefined ? 3 : p.maxAgeDays,
    date: date || src.date,
    rates: src.rates,
  };
}

async function read(opts) {
  const o = opts || {};
  const src = await sources(o.date, o.client);
  return contextOf(src, o.propertyId, o.date || src.date);
}

/** The state of a money on the property's books, as of the date asked about. */
async function stateOf(code, opts) {
  const ctx = await context(opts);
  return state(ctx.rates, code, ctx);
}

/* A caller that walks several records hands the context it already read; one
   that acts on a single figure lets this take it. */
async function context(opts) {
  const o = opts || {};
  if (o.ctx) return o.ctx;
  return read(o);
}

/** Null when the currency can be traded, the state — with its sentence — when it cannot. */
async function gate(code, opts) {
  const st = await stateOf(code, opts);
  return st.usable ? null : st;
}

function gateIn(ctx, code) {
  const st = state(ctx.rates, code, ctx);
  return st.usable ? null : st;
}

/**
 * Money onto the books: the figure the guest holds, the rate it moved at and the
 * figure the property keeps. A base-currency record needs no extra fields, so it
 * stays exactly as it has always been.
 */
function stampIn(ctx, amount, code) {
  const st = state(ctx.rates, code, ctx);
  if (!st.usable) return { error: st.error };
  const n = Math.round(Number(amount) || 0);
  if (st.state === "base") return { ctx: st, currency: st.code, fxRate: null, baseAmount: n };
  const conv = toBase(ctx.rates, n, st.code, ctx);
  return { ctx: st, currency: st.code, fxRate: conv.rate, baseAmount: conv.base };
}

async function stamp(amount, code, opts) {
  return stampIn(await context(opts), amount, code);
}

/**
 * Money belonging to a document is worth what that document said. A payment
 * against a dollar invoice converts at the invoice's own rate, not at whatever
 * the treasury filed this morning.
 */
function pinned(amount, code, rate) {
  if (!rate || rate === 1) return { currency: null, fxRate: null, baseAmount: Math.round(Number(amount) || 0) };
  return {
    currency: code, fxRate: Number(rate),
    baseAmount: round50(Math.round(Number(amount) || 0) * Number(rate)),
  };
}

/** Money against a document converts at the rate pinned on that document. */
function docStamp(inv, amount) {
  return pinned(amount, inv.currency, inv.fxRate);
}

/** What a document figure is worth on the books — the number the approval limit judges. */
function docBase(inv, amount) {
  const f = docStamp(inv, amount);
  return f.baseAmount === null || f.baseAmount === undefined ? Math.round(Number(amount) || 0) : f.baseAmount;
}

/**
 * Two currencies on one total do not make a stronger figure, they make a
 * meaningless one. A document is billed in one currency or not at all.
 */
function oneCurrency(base, lines) {
  const codes = {};
  (lines || []).forEach((l) => { codes[l.currency || base] = true; });
  const keys = Object.keys(codes);
  if (keys.length > 1) {
    return {
      error: `These lines mix ${keys.join(" and ")} — one document is billed in one currency. ` +
        `Re-price the odd line, or split the document.`,
    };
  }
  return { code: keys[0] || base };
}

/* ── folios: one currency, one rate ──────────────────────────── */

/**
 * Two currencies on one total do not make a stronger figure, they make a
 * meaningless one. A folio is billed in one currency or not at all.
 *
 * `db` is the transaction a caller is writing inside. A folio being opened line
 * by line has to be read from inside its own transaction, or a live database
 * answers "empty folio" to every line after the first, and an account would be
 * opened in two moneys because the first one was not visible yet.
 */
async function folioCurrency(resId, code, db) {
  const q = db || pool;
  const charges = await q.query(
    `SELECT currency FROM charges WHERE reservation_id = $1 AND NOT voided AND currency IS NOT NULL AND currency <> $2 LIMIT 1`,
    [resId, code]
  );
  const other = charges.rows[0] ? charges.rows[0].currency : null;
  if (other) return { error: clash(other, code) };
  const pay = await q.query(
    `SELECT currency FROM payments WHERE reservation_id = $1 AND currency IS NOT NULL AND currency <> $2 LIMIT 1`,
    [resId, code]
  );
  if (pay.rows[0]) return { error: clash(pay.rows[0].currency, code) };
  return { code };
}

function clash(other, code) {
  return `This folio is billed in ${other}, not ${code} — a balance has to be one currency. ` +
    `Price the line in ${other} or settle the folio before opening another.`;
}

/** The rate a folio is kept at: the first foreign line fixes it for every line after it. */
async function folioRate(resId, db) {
  const q = db || pool;
  const { rows } = await q.query(
    `SELECT fx_rate FROM charges WHERE reservation_id = $1 AND fx_rate IS NOT NULL ORDER BY charge_date, id LIMIT 1`,
    [resId]
  );
  if (rows[0]) return Number(rows[0].fx_rate);
  const pay = await q.query(
    `SELECT fx_rate FROM payments WHERE reservation_id = $1 AND fx_rate IS NOT NULL ORDER BY payment_date, id LIMIT 1`,
    [resId]
  );
  return pay.rows[0] ? Number(pay.rows[0].fx_rate) : null;
}

/** Money onto a folio: one currency, one rate, and the base figure the books keep. */
async function folioStamp(resId, amount, code, opts) {
  const o = opts || {};
  const same = await folioCurrency(resId, code, o.client);
  if (same.error) return { error: same.error };
  const pinnedRate = await folioRate(resId, o.client);
  if (pinnedRate) return { ...pinned(amount, code, pinnedRate), pinned: true };
  const { currency, fxRate, baseAmount, error } = await stamp(amount, code, o);
  if (error) return { error };
  return { currency, fxRate, baseAmount };
}

/** The money a property keeps its books in, whatever a given document is billed in. */
async function baseCode(propertyId, db) {
  const q = db || pool;
  const base = await q.query(`SELECT data FROM settings WHERE property_id = $1`, [propertyId]);
  return jsonIn(base.rows[0] ? base.rows[0].data : null, {}).currency || "NGN";
}

/** A guest hands money in the folio's own currency unless the desk names another. */
async function folioCode(resId, propertyId, db) {
  const q = db || pool;
  const { rows } = await q.query(
    `SELECT currency FROM charges WHERE reservation_id = $1 AND currency IS NOT NULL LIMIT 1`, [resId]
  );
  if (rows[0] && rows[0].currency) return rows[0].currency;
  return baseCode(propertyId, q);
}

/* ── what the catalogue sells in ─────────────────────────────── */

/**
 * The currencies any price row is counted in, other than the one the books are
 * kept in. Every row is asked, not just the live ones: a retired foreign price
 * still sits in the books, and the close names what the money on the shelf is
 * written in.
 */
async function inCatalogue(base) {
  const { rows } = await pool.query(`SELECT DISTINCT currency FROM prices`);
  return rows.map((r) => r.currency).filter((c) => c && c !== base).sort();
}

/** The states a set of currencies is in right now, refusals only. */
function statesIn(ctx, codes) {
  return (codes || []).map((c) => state(ctx.rates, c, ctx)).filter((st) => !st.usable);
}

/** The money the books currently cannot value — the night audit checks this. */
async function unusable(opts) {
  const ctx = await context(opts);
  return statesIn(ctx, await inCatalogue(ctx.base));
}

/* ── filing a rate ───────────────────────────────────────────── */

/**
 * What a proposed fixing means before anything is written. A rate is keyed by
 * currency and the day it takes effect, so a second figure for the same day is a
 * correction of that day rather than two truths for one date.
 */
async function plan(data, opts) {
  const o = opts || {};
  const day = o.day || (await biz.businessDay());
  const base = o.base || "NGN";
  const d = data || {};
  const code = String(d.code || "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(code)) return { error: "A currency is a three-letter code, like USD." };
  if (code === base) return { error: `${base} is what these books are kept in — it always stands at 1.` };
  if (CODES.indexOf(code) === -1) {
    return { error: `This property holds money in ${CODES.join(", ")}. ${code} is not among them.` };
  }
  const perBase = Number(d.perBase);
  if (!isFinite(perBase) || perBase <= 0) {
    return { error: `Say what one ${code} buys in ${base}, as a number above zero.` };
  }
  if (perBase > 100000000) return { error: "That figure is too wide to be an exchange rate." };
  const effective = d.effective || day;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effective)) {
    return { error: "Use the 2026-10-30 shape for the date a rate takes effect." };
  }
  if (effective > day) {
    return { error: "A rate cannot take effect in the future — the books would be kept on a figure nobody has agreed." };
  }
  const sealed = await biz.sealedRefusal(effective);
  if (sealed) return { error: sealed };
  const note = String(d.note || "").trim();
  if (!note) return { error: "Say where the rate came from — a fixing, a bank screen, a treasury memo. The trail reads it." };
  return { code, base, perBase: Math.round(perBase * 100) / 100, effective, note, day };
}

/**
 * The one code path a filed rate takes — immediate or approved, both land here,
 * so a cleared request leaves the same trail entry as one the desk signed itself.
 */
async function file(plan, actor, client) {
  const q = client || pool;
  const { rows: existing } = await q.query(
    `SELECT * FROM fx_rates WHERE code = $1 AND effective = $2`, [plan.code, plan.effective]
  );
  const id = existing[0] ? existing[0].id : "fx_" + Math.random().toString(36).slice(2, 8);
  const stamp = new Date().toISOString();
  const { rows: current } = await q.query(`SELECT * FROM fx_rates ORDER BY effective DESC`);
  const rates = current.map(mapRate);
  const previous = rateOn(rates.filter((r) => r.id !== id), plan.code, plan.day);
  await q.query(
    `INSERT INTO fx_rates (id,code,per_base,effective,set_by,set_at,note)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET per_base = EXCLUDED.per_base, set_by = EXCLUDED.set_by,
        set_at = EXCLUDED.set_at, note = EXCLUDED.note`,
    [id, plan.code, plan.perBase, plan.effective, actor, stamp, plan.note]
  );
  const { rows } = await q.query(`SELECT * FROM fx_rates WHERE id = $1`, [id]);
  return {
    rate: mapRate(rows[0]),
    previous: previous ? previous.perBase : null,
    replaced: !!existing[0],
  };
}

module.exports = {
  CURRENCIES, CODES, round50, symbolOf, nameOf,
  rateOn, state, toBase,
  sources, contextOf, read, context, stateOf, gate, gateIn,
  stampIn, stamp, pinned, docStamp, docBase, oneCurrency,
  folioCurrency, folioRate, folioStamp, folioCode, baseCode,
  inCatalogue, statesIn, unusable,
  plan, file, mapRate, rateRows,
};
