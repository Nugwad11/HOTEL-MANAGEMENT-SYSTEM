/**
 * A booted API over the in-memory database.
 *
 * Tests get a signed token per role and a seeded stay, so a route is proven
 * against the same SQL and the same permission catalog the frontend enforces.
 */
const { install } = require("./memdb");
const { sign } = require("../../src/lib/jwt");
const path = require("path");
const request = require("supertest");

const DAY = "2026-10-29";

const PERMISSION_KEYS = [
  "manage_reservations", "check_in_out", "view_guest_profiles", "edit_guest_profiles",
  "housekeeping_board", "post_charges", "take_payments", "manage_billing",
  "record_expenses", "approve_expenses", "manage_financial_settings",
  "approve_financial_changes", "view_reports", "manage_rates", "configure_prices",
  "book_events", "run_laundry", "manage_staff", "night_audit",
];

// Mirrors defaultPermissions() in assets/store.js. Kept here rather than
// imported because the server cannot load browser globals.
function defaultPermissions() {
  const none = () => PERMISSION_KEYS.reduce((m, k) => (m[k] = false, m), {});
  return {
    Manager: PERMISSION_KEYS.reduce((m, k) => (m[k] = true, m), {}),
    "Front Desk": Object.assign(none(), {
      manage_reservations: true, check_in_out: true, view_guest_profiles: true,
      edit_guest_profiles: true, post_charges: true, take_payments: true,
      manage_billing: true, book_events: true,
    }),
    Housekeeping: Object.assign(none(), {
      view_guest_profiles: true, housekeeping_board: true, record_expenses: true, run_laundry: true,
    }),
    Revenue: Object.assign(none(), {
      manage_reservations: true, view_guest_profiles: true, view_reports: true,
      manage_rates: true, configure_prices: true,
    }),
    // The second pair of hands: the ledger to keep and the wide moves to sign,
    // with nothing that lets them ask for their own signature.
    "Finance Manager": Object.assign(none(), {
      manage_billing: true, approve_expenses: true, manage_financial_settings: true,
      approve_financial_changes: true, view_reports: true,
    }),
    Auditor: Object.assign(none(), { view_reports: true }),
    Guest: {},
  };
}

const FINANCE_DEFAULTS = {
  invoicePrefix: "AGM", paymentDays: 7, approvalAmount: 500000, discountPct: 10, rateMaxAgeDays: 3,
};

const USERS = {
  Manager: { id: "00000000-0000-4000-8000-000000000101", email: "ifeoma@aurelia.test", name: "Ifeoma Okafor" },
  "Front Desk": { id: "00000000-0000-4000-8000-000000000102", email: "adamu@aurelia.test", name: "Adamu Bello" },
  Housekeeping: { id: "00000000-0000-4000-8000-000000000103", email: "grace@aurelia.test", name: "Grace Mensah" },
  Revenue: { id: "00000000-0000-4000-8000-000000000104", email: "chiamaka@aurelia.test", name: "Chiamaka Obi" },
  Auditor: { id: "00000000-0000-4000-8000-000000000105", email: "tunde@aurelia.test", name: "Tunde Bakare" },
  "Finance Manager": { id: "00000000-0000-4000-8000-000000000106", email: "emeka@aurelia.test", name: "Emeka Balogun" },
};

async function seed(pool, opts = {}) {
  const day = opts.day || DAY;
  const perms = opts.permissions || defaultPermissions();
  const run = (sql, params) => pool.query(sql, params || []);

  await run(`INSERT INTO properties (id,code,name,short,city) VALUES
    ('agm','AGM','Aurelia Grand Marina','Grand Marina','Victoria Island, Lagos'),
    ('ari','ARI','Aurelia Reserve Ikoyi','Reserve Ikoyi','Ikoyi, Lagos')`, []);

  // The policies and connections `assets/data.js` files for the flagship, so the
  // settings door answers on the same book the page shows a manager.
  await run(`INSERT INTO settings (property_id,data) VALUES ('agm',$1),('ari',$2)`, [
    {
      currency: "NGN", finance: FINANCE_DEFAULTS,
      depositPct: 25, checkInTime: "15:00", checkOutTime: "12:00",
      language: "English (UK)", overbooking: 2,
      cancellation: "Free cancellation up to 48 hours before arrival. One night charged thereafter.",
      integrations: { channelManager: true, paymentGateway: true, doorLocks: true, accounting: false, crm: true, whatsapp: true },
    },
    { currency: "NGN", finance: { invoicePrefix: "ARI" } },
  ]);

  await run(`INSERT INTO staff_permissions (id,data) VALUES (1,$1)`, [perms]);

  for (const [role, u] of Object.entries(USERS)) {
    await run(`INSERT INTO users (id,property_id,email,name,role,password_hash)
               VALUES ($1,'agm',$2,$3,$4,'x')`, [u.id, u.email, u.name, role]);
  }

  await run(`INSERT INTO room_types (id,code,name,size,occupancy)
             VALUES ('dk','DLK','Deluxe King',38,2),('ps','PRS','Presidential Suite',150,4)`, []);
  // The five plans `src/db/seed.js` writes and the browser's `db.ratePlans`
  // carries, figures and terms and all — a plan the API can price a stay on is a
  // plan the counter can book it on.
  await run(`INSERT INTO rate_plans (id,code,name,modifier,deposit_pct,cancel_policy,includes)
             VALUES ('flex','FLEX','Flexible Rate',1,25,'Free cancellation until 48 hours before arrival','Breakfast for two'),
                     ('adv','ADV','Advance Purchase',0.85,100,'Non-refundable · full prepayment','Breakfast for two · 15% saving'),
                     ('corp','CORP','Corporate Negotiated',0.88,0,'Free cancellation until 24 hours before arrival','Breakfast · airport transfer'),
                     ('club','CLUB','Aurelia Club Rate',0.92,0,'Free cancellation until 24 hours before arrival','Breakfast · 14:00 checkout'),
                     ('ota','OTA','Partner Channel Rate',1.06,0,'Free cancellation until 72 hours before arrival','Breakfast for two')`, []);
  await run(`INSERT INTO rooms (id,property_id,number,type_id,floor)
             VALUES ('agm_101','agm','101','dk',1),('agm_1200','agm','1200','ps',12)`, []);

  // The priced catalogue the night audit quotes from — the same shape the SPA
  // seeds, so a rate the API posts is a rate the desk would have posted.
  await run(`INSERT INTO price_lists (id,name,kind,from_date,to_date,priority,currency,active)
             VALUES ('pl_std','Standard 2026','standard','2026-01-01',NULL,1,'NGN',true),
                     ('pl_fest','Festive season','seasonal','2026-12-20','2027-01-05',20,'NGN',true),
                     ('pl_corp','Corporate contracts — USD','contract','2026-01-01',NULL,8,'USD',true)`, []);
  // The same four buckets the browser's TAX_RULES carry: a service charge and VAT
  // that run across rooms, halls, eating and washing alike, compounded in order.
  await run(`INSERT INTO tax_rules (id,name,kind,pct,sort_order,applies_to)
             VALUES ('tax_service','Service charge','service',10,1,'["room","hall","restaurant","laundry"]'),
                     ('tax_vat','VAT','vat',7.5,2,'["room","hall","restaurant","laundry"]')`);
  await run(`INSERT INTO services (id,category,ref_id,code,name,unit,active,occupancy,capacity,addon)
             VALUES ('svc_dk','room','dk','DLK','Deluxe King','night',true,2,NULL,false),
                     ('svc_ps','room','ps','PRS','Presidential Suite','night',true,4,NULL,false),
                     ('svc_hall_grand','hall','hall_grand','HB1','Grand Ballroom','hour',true,NULL,320,false),
                     ('svc_hall_garden','hall','hall_garden','GT1','Garden Terrace','hour',true,NULL,120,false),
                     ('svc_hall_board','hall','hall_board','BR1','Boardroom','hour',true,NULL,18,false),
                     ('svc_evt_decor','hall','evt_decor','EV01','Stage and table decoration','setup',true,NULL,NULL,true),
                     ('svc_evt_sound','hall','evt_sound','EV02','Sound system and MC desk','setup',true,NULL,NULL,true),
                     ('svc_evt_projector','hall','evt_projector','EV03','Projector and projection screen','setup',true,NULL,NULL,true),
                     ('svc_evt_catering','hall','evt_catering','EV04','Plated catering','guest',true,NULL,NULL,true),
                     ('svc_evt_flowers','hall','evt_flowers','EV05','Fresh flower installations','setup',true,NULL,NULL,true)`);
  // The halls are priced exactly as src/db/catalogue.js and the browser seed do
  // it — hourly rate, package amounts and cancellation terms on one row — so a
  // booking quoted against this fixture is quoted on the same figures as the SPA.
  await run(`INSERT INTO prices (id,service_id,list_id,currency,amount,surcharges,active)
             VALUES ('prc_dk_std','svc_dk','pl_std','NGN',200000,$1,true),
                     ('prc_ps_std','svc_ps','pl_std','NGN',1250000,$2,true),
                     ('prc_dk_fest','svc_dk','pl_fest','NGN',250000,$1,true),
                     ('prc_hall_grand_std','svc_hall_grand','pl_std','NGN',850000,$3,true),
                     ('prc_hall_garden_std','svc_hall_garden','pl_std','NGN',420000,$4,true),
                     ('prc_hall_board_std','svc_hall_board','pl_std','NGN',150000,$5,true),
                     ('prc_hall_grand_fest','svc_hall_grand','pl_fest','NGN',977500,$6,true),
                     ('prc_evt_decor_std','svc_evt_decor','pl_std','NGN',450000,$7,true),
                     ('prc_evt_sound_std','svc_evt_sound','pl_std','NGN',250000,$7,true),
                     ('prc_evt_projector_std','svc_evt_projector','pl_std','NGN',120000,$7,true),
                     ('prc_evt_catering_std','svc_evt_catering','pl_std','NGN',12500,$7,true),
                     ('prc_evt_flowers_std','svc_evt_flowers','pl_std','NGN',380000,$7,true),
                     ('prc_dk_corp','svc_dk','pl_corp','USD',150,$8,true),
                     ('prc_ps_corp','svc_ps','pl_corp','USD',800,$9,true)`, [
    { weekendPct: 15, extraAdult: 24000, extraBed: 18000, earlyCheckIn: 20000, lateCheckOut: 30000, depositPct: 25 },
    { weekendPct: 15, extraAdult: 150000, extraBed: 40000, depositPct: 25 },
    { weekendPct: 20, depositPct: 50, halfDay: 3400000, fullDay: 6200000, cancelPct: 50, cancelHours: 72 },
    { weekendPct: 20, depositPct: 50, halfDay: 1700000, fullDay: 3100000, cancelPct: 50, cancelHours: 72 },
    { weekendPct: 20, depositPct: 50, halfDay: 600000, fullDay: 1100000, cancelPct: 50, cancelHours: 72 },
    // The festive book carries no weekend uplift — its own premium is in the
    // hourly rate — so a Saturday festive quote must not move twice.
    { depositPct: 50, halfDay: 3910000, fullDay: 7130000, cancelPct: 50, cancelHours: 72 },
    {},
    // The two expatriate contract rows the browser seeds: figures in dollars, so
    // their worth on the books depends entirely on a dollar rate being on file.
    { depositPct: 25 },
    { depositPct: 50 },
  ]);

  // The laundry list, priced exactly as the browser's LAUNDRY table does — rate
  // per piece, the express uplift as a percentage of that rate, and the hours the
  // slowest garment takes, which is what sets a collection time.
  await run(`INSERT INTO services (id,category,ref_id,code,name,unit,active,turnaround_mins)
             VALUES ('svc_ld_shirt','laundry','ld_shirt','LY01','Shirt — wash and press','piece',true,240),
                     ('svc_ld_trousers','laundry','ld_trousers','LY02','Trousers — wash and press','piece',true,240),
                     ('svc_ld_suit','laundry','ld_suit','LY03','Two-piece suit','piece',true,480),
                     ('svc_ld_dress','laundry','ld_dress','LY04','Dress or evening gown','piece',true,480),
                     ('svc_ld_bedding','laundry','ld_bedding','LY05','Bedsheet set','piece',true,720),
                     ('svc_ld_towel','laundry','ld_towel','LY06','Bath towel','piece',true,360),
                     ('svc_ld_blanket','laundry','ld_blanket','LY07','Blanket','piece',true,1440),
                     ('svc_ld_dryclean','laundry','ld_dryclean','LY08','Dry cleaning','piece',true,1440),
                     ('svc_ld_load','laundry','ld_load','LY09','Household load','load',true,1440)`);
  await run(`INSERT INTO prices (id,service_id,list_id,currency,amount,surcharges,active)
             VALUES ('prc_ld_shirt_std','svc_ld_shirt','pl_std','NGN',2500,$1,true),
                     ('prc_ld_trousers_std','svc_ld_trousers','pl_std','NGN',3200,$1,true),
                     ('prc_ld_suit_std','svc_ld_suit','pl_std','NGN',7500,$1,true),
                     ('prc_ld_dress_std','svc_ld_dress','pl_std','NGN',6000,$1,true),
                     ('prc_ld_bedding_std','svc_ld_bedding','pl_std','NGN',4500,$2,true),
                     ('prc_ld_towel_std','svc_ld_towel','pl_std','NGN',1800,$2,true),
                     ('prc_ld_blanket_std','svc_ld_blanket','pl_std','NGN',6500,$2,true),
                     ('prc_ld_dryclean_std','svc_ld_dryclean','pl_std','NGN',8500,$3,true),
                     ('prc_ld_load_std','svc_ld_load','pl_std','NGN',12000,$1,true)`, [
    { expressPct: 50 },
    { expressPct: 40 },
    { expressPct: 60 },
  ]);

  // The menu the guest portal orders from, priced and described exactly as
  // src/db/catalogue.js and the browser's OUTLETS do — same items, same outlet,
  // same department and same service minutes. An order that posts a different
  // figure here than the desk would post is the whole point of the parity rule.
  await run(`INSERT INTO services (id,category,ref_id,code,name,unit,active,outlet_id,outlet)
             VALUES ('svc_ina_jollof','restaurant','ina_jollof','INA_JOLLOF','Jollof rice & grilled chicken','piece',true,'out_ina',$1),
                     ('svc_ina_suya','restaurant','ina_suya','INA_SUYA','Suya platter','piece',true,'out_ina',$1),
                     ('svc_ina_dessert','restaurant','ina_dessert','INA_DESSERT','Chocolate & hibiscus dessert','piece',true,'out_ina',$1),
                     ('svc_spa_signature','restaurant','spa_signature','SPA_SIGNATURE','Signature massage — 60 min','piece',true,'out_spa',$2),
                     ('svc_mini_soft','restaurant','mini_soft','MINI_SOFT','Soft drinks & water','piece',true,'out_mini',$3)`, [
    { id: "out_ina", name: "In-room dining", dept: "Food & Beverage", sla: 40 },
    { id: "out_spa", name: "Aurelia Spa", dept: "Spa & Wellness", sla: 120 },
    { id: "out_mini", name: "Minibar restock", dept: "Food & Beverage", sla: 25 },
  ]);
  await run(`INSERT INTO prices (id,service_id,list_id,currency,amount,surcharges,active)
             VALUES ('prc_ina_jollof_std','svc_ina_jollof','pl_std','NGN',18500,$1,true),
                     ('prc_ina_suya_std','svc_ina_suya','pl_std','NGN',14000,$1,true),
                     ('prc_ina_dessert_std','svc_ina_dessert','pl_std','NGN',9500,$1,true),
                     ('prc_spa_signature_std','svc_spa_signature','pl_std','NGN',85000,$1,true),
                     ('prc_mini_soft_std','svc_mini_soft','pl_std','NGN',12500,$1,true)`, [{}]);

  await run(`INSERT INTO guests (id,name,email,phone,tier)
             VALUES ('gst_1','Adaeze Nwankwo','adaeze@meridian.ng','+234 802 555 0101','Platinum'),
                     ('gst_2','Kunle Adeyemi','kunle@pole.ng','+234 805 111 2222','Gold')`, []);

  // One in-house stay (the audit bills it), one checked-out stay, one booking.
  await run(`INSERT INTO reservations
    (id,reference,property_id,guest_id,room_id,room_type_id,rate_plan_id,check_in,check_out,status,room_total,subtotal,total,deposit)
    VALUES
    ('res_1','AGM-0001','agm','gst_1','agm_101','dk','flex',$1,$2,'In-house',400000,400000,474000,100000),
    ('res_2','AGM-0002','agm','gst_2','agm_1200','ps','flex',$2,$3,'Checked out',1250000,1250000,1481250,312500),
    ('res_3','AGM-0003','agm','gst_2','agm_101','dk','flex',$4,$5,'Confirmed',400000,400000,474000,0)`,
    [addDays(day, -2), addDays(day, 2), addDays(day, 4), addDays(day, 10), addDays(day, 12)]);

  // res_1 has had the night of day-2 billed; the audit owes it day-1 and day.
  await run(`INSERT INTO charges (id,reservation_id,charge_date,description,department,amount,unit_price,qty)
    VALUES ('chg_1','res_1',$1,'Room charge · Deluxe King','Rooms',200000,200000,1),
           ('chg_2','res_1',$1,'Breakfast','F&B',18000,18000,1),
           ('chg_3','res_2',$2,'Room charge · Presidential Suite','Rooms',1250000,1250000,1)`,
    [addDays(day, -2), addDays(day, -1)]);

  await run(`INSERT INTO payments (id,reservation_id,payment_date,method,amount,reconciled)
    VALUES ('pay_1','res_1',$1,'Card',100000,true),
           ('pay_2','res_2',$1,'Bank transfer',312500,true)`, [addDays(day, -1)]);

  await run(`INSERT INTO business_date (id,day,seeded_on) VALUES (1,$1,$1)`, [day]);
  await run(`INSERT INTO counters (property_id,res_seq) VALUES ('agm',3),('ari',0)`, []);
  await run(`INSERT INTO invoice_series (id,seq) VALUES (1,0)`, []);

  return { day, perms };
}

function addDays(iso, n) {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** pg returns a DATE column as a Date; pg-mem may hand back the string. */
function dstr(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** A request surface carrying one identity: as("Revenue").post("/x").send(...) */
function caller(app, token) {
  const auth = (t) => (token ? t.set("Authorization", "Bearer " + token) : t);
  return {
    get: (u) => auth(request(app).get(u)),
    post: (u) => auth(request(app).post(u)),
    patch: (u) => auth(request(app).patch(u)),
    del: (u) => auth(request(app).delete(u)),
  };
}

/**
 * Boot the API against a fresh in-memory database.
 * Returns the supertest app plus the helpers a test needs to act as a role.
 */
async function boot(opts = {}) {
  // Routes hold a reference to pool from whenever they were first loaded, so
  // every module under src/ is dropped from the cache before the app is built
  // again. Without this, a second boot in the same file would answer from the
  // first test's database — and install() would be undone by its own purge.
  const SRC = path.join(__dirname, "..", "..", "src") + path.sep;
  Object.keys(require.cache).forEach((k) => { if (k.startsWith(SRC)) delete require.cache[k]; });

  const { db, pool } = install();
  await seed(pool, opts);

  const app = require("../../src/index.js");

  const perms = opts.permissions || defaultPermissions();
  const tokenFor = (role, propertyId) => {
    const u = USERS[role];
    return sign({
      id: u.id, email: u.email, name: u.name, role,
      propertyId: propertyId || "agm", guestId: null, permissions: perms[role] || {},
    });
  };
  const tokens = Object.fromEntries(Object.keys(USERS).map((r) => [r, tokenFor(r)]));

  return {
    db, pool, app,
    as: (role) => caller(app, tokens[role]),
    anon: caller(app, null),
    bearer: (token) => caller(app, token),
    tokens, tokenFor,
    day: opts.day || DAY,
    query: (sql, p) => pool.query(sql, p || []),
  };
}

module.exports = { boot, seed, addDays, dstr, caller, defaultPermissions, FINANCE_DEFAULTS, PERMISSION_KEYS, USERS, DAY };
