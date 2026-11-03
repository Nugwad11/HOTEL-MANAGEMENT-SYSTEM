/**
 * The two shapes every row and the one identifier the ledger writes with.
 *
 * These are a leaf: JSONB and ids are needed by the money rules, the price
 * engine and the invoice ledger alike, so they live below all of them. Keeping
 * them here is also what lets the ledger and the FX gate read each other
 * without a require cycle.
 */

/**
 * JSONB is written as text and read as a value. A JS array handed to the driver
 * as a parameter is not reliably re-shaped into an array on the way back, so
 * the serialising side is explicit — the same text is valid for a live
 * Postgres, which casts it to jsonb on insert.
 */
const jsonOut = (v) => JSON.stringify(v === undefined ? null : v);
const jsonIn = (v, fallback) => {
  if (v === null || v === undefined) return fallback;
  if (typeof v === "string") {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
};

const uid = (p) => p + "_" + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);

module.exports = { jsonIn, jsonOut, uid };
