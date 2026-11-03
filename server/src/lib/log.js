/**
 * The audit trail. Every financial write records what moved, in whose name —
 * a figure nobody can account for is not an auditable figure.
 *
 * A caller inside a transaction hands its connection, so the line it signs is
 * filed in the same book as the money it describes: a write that rolls back has
 * no trail left behind it, and one the seed has not yet committed still reads
 * back to whoever is standing in that transaction.
 */
const pool = require("../db/pool");

async function log({ propertyId, actor, action, entity, detail }, client) {
  const id = "act_" + Math.random().toString(36).slice(2, 8);
  await (client || pool).query(
    `INSERT INTO activity_log (id,property_id,actor,action,entity,detail)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, propertyId || null, actor || null, action, entity || null, detail || null]
  );
  return id;
}

module.exports = { log };
