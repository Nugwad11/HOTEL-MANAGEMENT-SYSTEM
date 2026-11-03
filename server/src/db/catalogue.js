/**
 * The seed price catalogue.
 *
 * Same rows, same rounding and the same surcharge shape as buildServices() and
 * buildPrices() in assets/data.js, so a price list opened against the API shows
 * what the browser-seeded demo shows. After seeding, these rows are the only
 * source of a price — nothing else computes one.
 */
const round50 = (n) => Math.round(n / 50) * 50;

/** Calendar arithmetic on the YYYY-MM-DD the seed works in. */
function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const extras = (o) => Object.assign({
  weekendPct: 0, extraAdult: 0, extraBed: 0, earlyCheckIn: 0, lateCheckOut: 0,
  expressPct: 0, depositPct: 0, cancelPct: 0, cancelHours: 0, halfDay: null, fullDay: null,
}, o || {});

const ROOM_TYPES = [
  { id: "dk", code: "DLK", name: "Deluxe King", rate: 185000, occupancy: 2 },
  { id: "dt", code: "DLT", name: "Deluxe Twin", rate: 185000, occupancy: 2 },
  { id: "pv", code: "PSV", name: "Premier Sea View", rate: 245000, occupancy: 2 },
  { id: "es", code: "EXS", name: "Executive Suite", rate: 340000, occupancy: 3 },
  { id: "gv", code: "GDV", name: "Garden Villa", rate: 520000, occupancy: 4 },
  { id: "ps", code: "PRS", name: "Presidential Suite", rate: 1250000, occupancy: 4 },
];

const HALLS = [
  { id: "hall_grand", code: "HB1", name: "Grand Ballroom", capacity: 320, hourly: 850000, halfDay: 3400000, fullDay: 6200000 },
  { id: "hall_garden", code: "GT1", name: "Garden Terrace", capacity: 120, hourly: 420000, halfDay: 1700000, fullDay: 3100000 },
  { id: "hall_board", code: "BR1", name: "Boardroom", capacity: 18, hourly: 150000, halfDay: 600000, fullDay: 1100000 },
];

const EVENT_EXTRAS = [
  { id: "evt_decor", code: "EV01", name: "Stage and table decoration", unit: "setup", price: 450000 },
  { id: "evt_sound", code: "EV02", name: "Sound system and MC desk", unit: "setup", price: 250000 },
  { id: "evt_projector", code: "EV03", name: "Projector and projection screen", unit: "setup", price: 120000 },
  { id: "evt_catering", code: "EV04", name: "Plated catering", unit: "guest", price: 12500 },
  { id: "evt_flowers", code: "EV05", name: "Fresh flower installations", unit: "setup", price: 380000 },
];

const OUTLETS = [
  { id: "out_ina", name: "In-room dining", dept: "Food & Beverage", sla: 40, items: [
    { id: "ina_jollof", name: "Jollof rice & grilled chicken", price: 18500 },
    { id: "ina_suya", name: "Suya platter", price: 14000 },
    { id: "ina_breakfast", name: "Full Aurelia breakfast", price: 21000 },
    { id: "ina_burger", name: "Wagyu burger & truffle fries", price: 24500 },
    { id: "ina_dessert", name: "Chocolate & hibiscus dessert", price: 9500 },
  ] },
  { id: "out_isla", name: "Isla — poolside table", dept: "Food & Beverage", sla: 60, items: [
    { id: "isla_tasting", name: "Chef's tasting menu (per guest)", price: 68000 },
    { id: "isla_grill", name: "Grilled catch of the day", price: 34500 },
    { id: "isla_bottle", name: "Bottle of house champagne", price: 95000 },
  ] },
  { id: "out_spa", name: "Aurelia Spa", dept: "Spa & Wellness", sla: 120, items: [
    { id: "spa_signature", name: "Signature massage — 60 min", price: 85000 },
    { id: "spa_couple", name: "Couple's ritual — 90 min", price: 165000 },
    { id: "spa_facial", name: "Glow facial — 45 min", price: 62000 },
    { id: "spa_pool", name: "Private pool & sauna hour", price: 48000 },
  ] },
  { id: "out_mini", name: "Minibar restock", dept: "Food & Beverage", sla: 25, items: [
    { id: "mini_alcohol", name: "Alcoholic selection", price: 32000 },
    { id: "mini_soft", name: "Soft drinks & water", price: 12500 },
    { id: "mini_snacks", name: "Snacks & nuts", price: 15000 },
  ] },
];

const LAUNDRY = [
  { id: "ld_shirt", code: "LY01", name: "Shirt — wash and press", unit: "piece", price: 2500, expressPct: 50, mins: 240 },
  { id: "ld_trousers", code: "LY02", name: "Trousers — wash and press", unit: "piece", price: 3200, expressPct: 50, mins: 240 },
  { id: "ld_suit", code: "LY03", name: "Two-piece suit", unit: "piece", price: 7500, expressPct: 50, mins: 480 },
  { id: "ld_dress", code: "LY04", name: "Dress or evening gown", unit: "piece", price: 6000, expressPct: 50, mins: 480 },
  { id: "ld_bedding", code: "LY05", name: "Bedsheet set", unit: "piece", price: 4500, expressPct: 40, mins: 720 },
  { id: "ld_towel", code: "LY06", name: "Bath towel", unit: "piece", price: 1800, expressPct: 40, mins: 360 },
  { id: "ld_blanket", code: "LY07", name: "Blanket", unit: "piece", price: 6500, expressPct: 40, mins: 1440 },
  { id: "ld_dryclean", code: "LY08", name: "Dry cleaning", unit: "piece", price: 8500, expressPct: 60, mins: 1440 },
  { id: "ld_load", code: "LY09", name: "Household load", unit: "load", price: 12000, expressPct: 50, mins: 1440 },
];

/* A price list is a book of money, not just a date range: every row on it is
   counted in the currency the list names, so a dollar list cannot quietly seed
   naira. Contract lists are only ever quoted when someone names them. */
const PRICE_LISTS = [
  { id: "pl_std", name: "Standard 2026", kind: "standard", from: "2026-01-01", to: null, priority: 1, currency: "NGN" },
  { id: "pl_day", name: "Day use 09:00 – 18:00", kind: "day-use", from: "2026-01-01", to: null, priority: 5, currency: "NGN" },
  { id: "pl_fest", name: "Festive season", kind: "seasonal", from: "2026-12-20", to: "2027-01-05", priority: 20, currency: "NGN" },
  { id: "pl_corp", name: "Corporate contracts — USD", kind: "contract", from: "2026-01-01", to: null, priority: 8, currency: "USD" },
];

/* How many keys of each type each property sells. The same split as PROPERTIES
   in assets/data.js, and each row sums to that property's floors × rooms per
   floor. The order matters: the browser lays the whole inventory out villa
   first and presidential last, then numbers by floor, so a room id is a
   function of that sequence. */
const TYPE_SEQUENCE = ["gv", "dk", "dt", "pv", "es", "ps"];
const TYPE_COUNTS = {
  agm: { gv: 4, dk: 14, dt: 10, pv: 10, es: 8, ps: 2 },
  ari: { gv: 2, dk: 10, dt: 6, pv: 6, es: 5, ps: 1 },
  apa: { gv: 1, dk: 8, dt: 6, pv: 4, es: 4, ps: 1 },
};

// Two rooms in every hotel are down. Housekeeping cannot close them and the
// audit excludes them from sellable inventory, so they have to be seeded.
const MAINTENANCE = [
  { offset: -3, hk: "Out of order", reason: "Bathroom re-grouting" },
  { offset: -7, hk: "Out of service", reason: "Awaiting replacement of AC compressor" },
];

/**
 * Port of buildRooms() in assets/data.js. `properties` are the rows the seed
 * writes: { id, floors, per_floor }.
 */
function buildRooms(properties) {
  const rooms = [];
  properties.forEach((p) => {
    const counts = TYPE_COUNTS[p.id] || {};
    const sequence = [];
    TYPE_SEQUENCE.forEach((t) => {
      for (let i = 0; i < (counts[t] || 0); i++) sequence.push(t);
    });
    const mine = sequence.map((typeId, idx) => {
      const floor = Math.floor(idx / p.per_floor) + 1;
      const pos = (idx % p.per_floor) + 1;
      const number = String(floor) + String(pos).padStart(2, "0");
      return {
        id: p.id + "-" + number, propertyId: p.id, number, floor, typeId,
        hk: "Available", oooReason: null,
      };
    });
    if (mine.length > 12) {
      MAINTENANCE.forEach((m) => {
        const room = mine[mine.length + m.offset];
        room.hk = m.hk;
        room.oooReason = m.reason;
      });
    }
    rooms.push(...mine);
  });
  return rooms;
}

const TAX_RULES = [
  { id: "tax_service", name: "Service charge", kind: "service", pct: 10, order: 1, appliesTo: ["room", "hall", "restaurant", "laundry"] },
  { id: "tax_vat", name: "VAT", kind: "vat", pct: 7.5, order: 2, appliesTo: ["room", "hall", "restaurant", "laundry"] },
  { id: "tax_city", name: "City tourism levy", kind: "city", pct: 0, order: 3, appliesTo: ["room"] },
];

function buildServices() {
  const out = ROOM_TYPES.map((t) => ({
    id: "svc_" + t.id, category: "room", refId: t.id, code: t.code, name: t.name,
    unit: "night", active: true, occupancy: t.occupancy,
  }));
  HALLS.forEach((h) => out.push({
    id: "svc_" + h.id, category: "hall", refId: h.id, code: h.code, name: h.name,
    unit: "hour", active: true, capacity: h.capacity,
  }));
  OUTLETS.forEach((o) => o.items.forEach((it) => out.push({
    id: "svc_" + it.id, category: "restaurant", refId: it.id, code: it.id.toUpperCase(),
    name: it.name, unit: "piece", active: true, outletId: o.id,
    // An item belongs to an outlet, and the outlet is what decides whose ledger a
    // charge lands on and how fast that team answers. The menu carries both, so
    // the row keeps them rather than making a route guess at a department.
    outlet: { id: o.id, name: o.name, dept: o.dept, sla: o.sla },
  })));
  EVENT_EXTRAS.forEach((e) => out.push({
    id: "svc_" + e.id, category: "hall", refId: e.id, code: e.code, name: e.name,
    unit: e.unit, active: true, addon: true,
  }));
  LAUNDRY.forEach((l) => out.push({
    id: "svc_" + l.id, category: "laundry", refId: l.id, code: l.code, name: l.name,
    unit: l.unit, active: true, turnaroundMins: l.mins,
  }));
  return out;
}

function buildPrices(stamp) {
  const prices = [];
  // The list decides the currency, so a row cannot disagree with the book it
  // belongs to and a dollar list cannot quietly seed naira.
  const listOf = (listId) => PRICE_LISTS.filter((l) => l.id === listId)[0];
  const push = (serviceId, listId, amount, extra) => {
    const list = listOf(listId);
    return prices.push({
      id: "prc_" + serviceId.replace("svc_", "") + "_" + listId.replace("pl_", ""),
      serviceId, listId, currency: (list && list.currency) || "NGN", amount: round50(amount), surcharges: extras(extra),
      from: null, to: null, active: true, createdAt: stamp, updatedAt: stamp,
      updatedBy: "Rate card import",
    });
  };

  ROOM_TYPES.forEach((t) => {
    push("svc_" + t.id, "pl_std", t.rate, {
      weekendPct: 15, extraAdult: round50(t.rate * 0.12), extraBed: 18000,
      earlyCheckIn: round50(t.rate * 0.1), lateCheckOut: round50(t.rate * 0.15), depositPct: 25,
    });
    push("svc_" + t.id, "pl_day", t.rate * 0.6, { depositPct: 0 });
    push("svc_" + t.id, "pl_fest", t.rate * 1.25, { weekendPct: 10, depositPct: 50 });
  });
  HALLS.forEach((h) => {
    push("svc_" + h.id, "pl_std", h.hourly, {
      weekendPct: 20, depositPct: 50, halfDay: h.halfDay, fullDay: h.fullDay,
      cancelPct: 50, cancelHours: 72,
    });
    push("svc_" + h.id, "pl_fest", h.hourly * 1.15, {
      depositPct: 50, halfDay: round50(h.halfDay * 1.15), fullDay: round50(h.fullDay * 1.15),
      cancelPct: 50, cancelHours: 72,
    });
  });
  EVENT_EXTRAS.forEach((e) => push("svc_" + e.id, "pl_std", e.price));
  OUTLETS.forEach((o) => o.items.forEach((it) => push("svc_" + it.id, "pl_std", it.price)));
  LAUNDRY.forEach((l) => push("svc_" + l.id, "pl_std", l.price, { expressPct: l.expressPct }));
  // Two expatriate contract rows, sold in dollars against a named list. Their
  // worth on the books depends entirely on the dollar rate being on file.
  push("svc_dk", "pl_corp", 150, { depositPct: 25 });
  push("svc_ps", "pl_corp", 800, { depositPct: 50 });
  return prices;
}

/**
 * Port of the fxRates block in buildDatabase() (assets/data.js).
 *
 * Three states, deliberately, because the rule is about the states and not about
 * the numbers: a dollar rate the treasury set yesterday and the desk may sell on,
 * a sterling rate nine days past its trust limit that it may not, and a euro with
 * no rate on file at all. The naira needs no row — it is what the books keep.
 */
function buildFxRates(day) {
  return [
    {
      id: "fx_usd_prev", code: "USD", perBase: 1512, effective: addDays(day, -8),
      setBy: "Ifeoma Okafor", note: "Monday fixing carried over the weekend",
    },
    {
      id: "fx_usd", code: "USD", perBase: 1550, effective: addDays(day, -1),
      setBy: "Ifeoma Okafor", note: "Group treasury fixing for the corporate contracts",
    },
    {
      id: "fx_gbp", code: "GBP", perBase: 1965, effective: addDays(day, -9),
      setBy: "Ifeoma Okafor", note: "Not revisited since the sterling move — refresh before selling in GBP",
    },
  ];
}

module.exports = {
  ROOM_TYPES, HALLS, EVENT_EXTRAS, OUTLETS, LAUNDRY, PRICE_LISTS, TAX_RULES,
  TYPE_SEQUENCE, TYPE_COUNTS, buildRooms, buildFxRates,
  buildServices, buildPrices, round50, extras, addDays,
};
