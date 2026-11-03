/**
 * Database migration — creates all tables from scratch.
 * Run with:  node src/db/migrate.js
 * Reset with: node src/db/migrate.js --reset
 *
 * The schema is exported so the in-memory test database builds exactly the
 * tables production builds, instead of a second copy that can drift.
 */
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const { Pool } = require("pg");

const DROP = `
  DROP TABLE IF EXISTS
    closed_days, approvals, expenses, refunds, invoices, business_date,
    activity_log, notifications, laundry_items, laundry_orders,
    event_lines, events, documents, task_assignments, tasks,
    waitlist_offers, charges, payments, reservations, lost_found,
    price_history, prices, price_lists, tax_rules, services, fx_rates,
    staff_permissions, staff, rooms, settings,
    guests, rate_plans, room_types, properties, users
  CASCADE;
`;

const SCHEMA = `

/* ── tenancy / auth ─────────────────────────────────────────── */

CREATE TABLE properties (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  short       TEXT NOT NULL,
  city        TEXT NOT NULL,
  country     TEXT NOT NULL DEFAULT 'Nigeria',
  address     TEXT,
  phone       TEXT,
  email       TEXT,
  tagline     TEXT,
  gm          TEXT,
  opened      INT,
  floors      INT,
  per_floor   INT,
  rate_index  NUMERIC(4,2) DEFAULT 1,
  occ_target  NUMERIC(4,2) DEFAULT 0.82,
  star        INT DEFAULT 5,
  created_at  TIMESTAMPTZ DEFAULT now()
);

/* settings stored as a single JSONB blob per property — matches the
   db.settings[pid] shape in store.js */
CREATE TABLE settings (
  property_id  TEXT PRIMARY KEY REFERENCES properties(id) ON DELETE CASCADE,
  data         JSONB NOT NULL DEFAULT '{}'
);

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id  TEXT REFERENCES properties(id) ON DELETE SET NULL,
  email        TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name         TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('Manager','Front Desk','Housekeeping','Revenue','Finance Manager','Auditor','Guest')),
  guest_id     TEXT,          -- populated when role = Guest
  is_active    BOOLEAN DEFAULT true,
  last_login   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX users_email_idx ON users(email);

/* ── catalogue ──────────────────────────────────────────────── */

CREATE TABLE room_types (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INT,
  occupancy  INT DEFAULT 2,
  bed        TEXT,
  view       TEXT,
  image      TEXT,
  description TEXT,
  amenities  JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rate_plans (
  id           TEXT PRIMARY KEY,
  code         TEXT NOT NULL,
  name         TEXT NOT NULL,
  modifier     NUMERIC(5,3) DEFAULT 1,
  deposit_pct  INT DEFAULT 25,
  cancel_policy TEXT,
  includes     TEXT,
  colour       TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE rooms (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  number       TEXT NOT NULL,
  type_id      TEXT NOT NULL REFERENCES room_types(id),
  floor        INT,
  hk_status    TEXT NOT NULL DEFAULT 'Available'
                 CHECK (hk_status IN ('Available','Occupied','Dirty','Inspected','Out of order','Out of service')),
  ooo_reason   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX rooms_property_idx ON rooms(property_id);

/* ── pricing (mirrors price_lists / prices / tax_rules / services) */

CREATE TABLE price_lists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('standard','day-use','seasonal','promotional','contract')),
  from_date   DATE,
  to_date     DATE,
  priority    INT DEFAULT 1,
  currency    TEXT DEFAULT 'NGN',
  active      BOOLEAN DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE tax_rules (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  pct         NUMERIC(5,2) NOT NULL,
  sort_order  INT DEFAULT 1,
  applies_to  JSONB DEFAULT '[]',
  updated_at  TIMESTAMPTZ,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE services (
  id              TEXT PRIMARY KEY,
  category        TEXT NOT NULL CHECK (category IN ('room','hall','restaurant','laundry')),
  ref_id          TEXT,
  code            TEXT,
  name            TEXT NOT NULL,
  unit            TEXT DEFAULT 'piece',
  active          BOOLEAN DEFAULT true,
  occupancy       INT,   -- room types
  capacity        INT,   -- halls
  outlet_id       TEXT,  -- restaurant items
  outlet          JSONB, -- the item's outlet as the menu carries it: {id, name, dept, sla}
  addon           BOOLEAN DEFAULT false,  -- hall add-ons
  turnaround_mins INT,   -- laundry
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE prices (
  id           TEXT PRIMARY KEY,
  service_id   TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  list_id      TEXT NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  currency     TEXT DEFAULT 'NGN',
  amount       NUMERIC(12,2) NOT NULL,
  surcharges   JSONB DEFAULT '{}',
  from_date    DATE,
  to_date      DATE,
  active       BOOLEAN DEFAULT true,
  created_at   TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ,
  updated_by   TEXT
);
CREATE INDEX prices_service_idx ON prices(service_id);

CREATE TABLE price_history (
  id          TEXT PRIMARY KEY,
  price_id    TEXT REFERENCES prices(id) ON DELETE SET NULL,
  service_id  TEXT,
  list_id     TEXT,
  recorded_at TIMESTAMPTZ DEFAULT now(),
  recorded_by TEXT,
  reason      TEXT,
  from_data   JSONB,
  to_data     JSONB
);

/* What one unit of a foreign money buys in the money the books are kept in.
   Keyed by code and the day it takes effect, so a second figure for the same
   day is a correction rather than two truths for one date — and an older row
   stays on file because it is what a charge posted that day converted at.
   The base currency has no row: it always stands at 1. */
CREATE TABLE fx_rates (
  id          TEXT PRIMARY KEY,
  code        TEXT NOT NULL,
  per_base    NUMERIC(12,2) NOT NULL CHECK (per_base > 0),
  effective   DATE NOT NULL,
  set_by      TEXT,
  set_at      TIMESTAMPTZ,
  note        TEXT,
  UNIQUE (code, effective)
);
CREATE INDEX fx_rates_code_idx ON fx_rates(code);

/* ── guests ─────────────────────────────────────────────────── */

CREATE TABLE guests (
  id            TEXT PRIMARY KEY,
  title         TEXT DEFAULT 'Mr',
  first_name    TEXT,
  last_name     TEXT,
  name          TEXT NOT NULL,
  email         TEXT,
  phone         TEXT,
  country       TEXT DEFAULT 'Nigeria',
  city          TEXT,
  tier          TEXT DEFAULT 'Member'
                  CHECK (tier IN ('Member','Silver','Gold','Platinum')),
  job           TEXT,
  birthday      DATE,
  since         INT,
  id_type       TEXT,
  id_number     TEXT,
  preferences   JSONB DEFAULT '{}',
  consent       JSONB DEFAULT '{}',
  tags          JSONB DEFAULT '[]',
  loyalty_pts   INT DEFAULT 0,
  language      TEXT DEFAULT 'English',
  featured      BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE guest_notes (
  id          TEXT PRIMARY KEY,
  guest_id    TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  recorded_by TEXT,
  recorded_at DATE DEFAULT CURRENT_DATE,
  created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX guest_notes_guest_idx ON guest_notes(guest_id);

/* ── staff ──────────────────────────────────────────────────── */

CREATE TABLE staff (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  email        TEXT,
  title        TEXT,
  role         TEXT NOT NULL CHECK (role IN ('Manager','Front Desk','Housekeeping','Revenue','Finance Manager')),
  department   TEXT,
  shift        TEXT,
  phone        TEXT,
  status       TEXT DEFAULT 'Active' CHECK (status IN ('Active','Inactive')),
  started      DATE,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX staff_property_idx ON staff(property_id);

/* permissions stored as a JSONB map { role: { perm_key: bool } }
   shared across all properties in the workspace */
CREATE TABLE staff_permissions (
  id    INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),  -- singleton row
  data  JSONB NOT NULL DEFAULT '{}'
);

/* ── reservations & folios ──────────────────────────────────── */

CREATE TABLE reservations (
  id            TEXT PRIMARY KEY,
  reference     TEXT NOT NULL UNIQUE,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  guest_id      TEXT NOT NULL REFERENCES guests(id),
  room_id       TEXT REFERENCES rooms(id),
  room_type_id  TEXT NOT NULL REFERENCES room_types(id),
  rate_plan_id  TEXT NOT NULL REFERENCES rate_plans(id),
  check_in      DATE NOT NULL,
  check_out     DATE NOT NULL,
  adults        INT DEFAULT 1,
  children      INT DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'Confirmed'
                  CHECK (status IN ('Confirmed','In-house','Checked out','Cancelled','No-show','Waitlist')),
  channel       TEXT DEFAULT 'Direct',
  source        TEXT,
  notes         TEXT,
  eta           TEXT,
  vip           BOOLEAN DEFAULT false,
  mobile_key    BOOLEAN DEFAULT false,
  key_issued_at TIMESTAMPTZ,
  room_total    NUMERIC(12,2),
  /* A stay sold in a foreign money is a yield figure in the money the books
     keep, so the room total is stored twice: what the guest holds and what the
     property earns. */
  currency      TEXT DEFAULT 'NGN',
  fx_rate       NUMERIC(12,2),
  base_room_total NUMERIC(12,2),
  subtotal      NUMERIC(12,2),
  service_chg   NUMERIC(12,2),
  vat_amount    NUMERIC(12,2),
  total         NUMERIC(12,2),
  deposit       NUMERIC(12,2) DEFAULT 0,
  points_awarded INT,
  checked_in_at  TIMESTAMPTZ,
  checked_out_at TIMESTAMPTZ,
  /* A waitlisted stay holds no key until a release is taken up; the moment it
     was confirmed off the waitlist is the stay's own record of that pass. */
  waitlist_confirmed_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX res_property_idx ON reservations(property_id);
CREATE INDEX res_guest_idx    ON reservations(guest_id);
CREATE INDEX res_checkin_idx  ON reservations(check_in);
CREATE INDEX res_status_idx   ON reservations(status);

CREATE TABLE charges (
  id              TEXT PRIMARY KEY,
  reservation_id  TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  charge_date     DATE NOT NULL,
  description     TEXT NOT NULL,
  department      TEXT,
  amount          NUMERIC(12,2) NOT NULL,
  qty             INT DEFAULT 1,
  posted_by       TEXT,
  voided          BOOLEAN DEFAULT false,
  voided_at       TIMESTAMPTZ,
  voided_by       TEXT,
  -- price snapshot fields
  unit_price      NUMERIC(12,2),
  base_price      NUMERIC(12,2),
  extras          JSONB,
  currency        TEXT DEFAULT 'NGN',
  /* Foreign money is frozen on the row the day it moves: tomorrow's fixing
     cannot revalue what was billed yesterday, and the books keep the second
     figure rather than recomputing it from a rate that has since moved. */
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  service_id      TEXT,
  price_id        TEXT,
  list_id         TEXT,
  list_name       TEXT,
  tax_rule_id     TEXT,
  points          INT,
  /* Set when a hall booking posted the line, so cancelling the booking can find
     every line it owns and take them back off the folio. */
  event_id        TEXT,
  -- a charge can be carried onto a document without losing its folio identity
  invoice_id      TEXT,
  -- set when the night audit posted the line, so it is never re-billed
  night_audit     BOOLEAN DEFAULT false,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX charges_res_idx ON charges(reservation_id);
CREATE INDEX charges_date_idx ON charges(charge_date);

CREATE TABLE payments (
  id              TEXT PRIMARY KEY,
  /* Nullable: a deposit against a manual document — a hall booking, a minibar
     bill raised on its own — settles money that never belonged to a stay. */
  reservation_id  TEXT REFERENCES reservations(id) ON DELETE CASCADE,
  invoice_id      TEXT,
  payment_date    DATE NOT NULL,
  method          TEXT DEFAULT 'Card',
  amount          NUMERIC(12,2) NOT NULL,
  /* Cash handed in a foreign money is counted at the rate the document it
     settles was kept at — not at whatever the treasury files afterwards. */
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  reference       TEXT,
  receipt         TEXT,
  reconciled      BOOLEAN DEFAULT false,
  taken_by        TEXT,
  /* Set when a hall booking took the money, so the deposit is traceable to the
     booking it belongs to and not only to the folio it settled. */
  event_id        TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX payments_res_idx ON payments(reservation_id);
CREATE INDEX payments_invoice_idx ON payments(invoice_id);
CREATE INDEX payments_date_idx ON payments(payment_date);

/* ── tasks / requests ───────────────────────────────────────── */

CREATE TABLE tasks (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  type          TEXT,
  title         TEXT NOT NULL,
  detail        TEXT,
  room_id       TEXT REFERENCES rooms(id),
  guest_id      TEXT REFERENCES guests(id),
  assigned_to   TEXT REFERENCES staff(id),
  priority      TEXT DEFAULT 'Normal' CHECK (priority IN ('High','Normal','Low')),
  status        TEXT DEFAULT 'Open' CHECK (status IN ('Open','In progress','Done')),
  source        TEXT,
  sla_mins      INT DEFAULT 30,
  due_at        TIMESTAMPTZ,
  resolved_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX tasks_property_idx ON tasks(property_id);
CREATE INDEX tasks_status_idx   ON tasks(status);

/* ── events & laundry ───────────────────────────────────────── */

CREATE TABLE events (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  hall_id         TEXT NOT NULL,
  title           TEXT NOT NULL,
  organizer       TEXT NOT NULL,
  event_date      DATE NOT NULL,
  start_time      TEXT NOT NULL,
  end_time        TEXT NOT NULL,
  package         TEXT,
  status          TEXT DEFAULT 'Hold' CHECK (status IN ('Hold','Confirmed','Cancelled')),
  reservation_id  TEXT REFERENCES reservations(id),
  contact_email   TEXT,
  contact_phone   TEXT,
  layout          TEXT,
  guests_count    INT DEFAULT 0,
  notes           TEXT,
  total           NUMERIC(12,2),
  /* The booking is quoted in one money and the books keep another, so the
     header carries both readings of its total. */
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  deposit         NUMERIC(12,2),
  deposit_pct     INT,
  deposit_paid    NUMERIC(12,2) DEFAULT 0,
  cancel_pct      INT,
  cancel_hours    INT,
  cancel_fee      NUMERIC(12,2) DEFAULT 0,
  cancel_reason   TEXT,
  cancelled_at    TIMESTAMPTZ,
  /* What the booking was sold on, kept beside the booking rather than read back
     off today's list: a re-priced hall must not rewrite the money already
     agreed, and a cancellation fee is judged against the terms the guest took. */
  hall_service_id TEXT,
  hours           NUMERIC(6,2),
  package_name    TEXT,
  subtotal        NUMERIC(12,2),
  tax             NUMERIC(12,2),
  service_charge  NUMERIC(12,2),
  vat             NUMERIC(12,2),
  tax_lines       JSONB,
  price_id        TEXT,
  list_id         TEXT,
  list_name       TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE event_lines (
  id          TEXT PRIMARY KEY,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  kind        TEXT,
  service_id  TEXT,
  name        TEXT NOT NULL,
  unit        TEXT,
  qty         INT DEFAULT 1,
  unit_price  NUMERIC(12,2),
  base_price  NUMERIC(12,2),
  amount      NUMERIC(12,2),
  added       JSONB,
  currency    TEXT DEFAULT 'NGN',
  fx_rate     NUMERIC(12,2),
  base_amount NUMERIC(14,2),
  price_id    TEXT,
  list_id     TEXT,
  list_name   TEXT,
  sort_order  INT DEFAULT 0
);

CREATE TABLE laundry_orders (
  id            TEXT PRIMARY KEY,
  property_id   TEXT NOT NULL REFERENCES properties(id),
  ref           TEXT NOT NULL,
  reservation_id TEXT REFERENCES reservations(id),
  guest_id      TEXT REFERENCES guests(id),
  room_id       TEXT REFERENCES rooms(id),
  room_number   TEXT,
  status        TEXT DEFAULT 'Received'
                  CHECK (status IN ('Received','In progress','Ready','Collected')),
  express       BOOLEAN DEFAULT false,
  notes         TEXT,
  /* What the order is worth, quoted by the engine rather than typed by a caller:
     the lines, the taxes they earned, and the money the books keep them in. */
  subtotal      NUMERIC(12,2),
  tax           NUMERIC(12,2),
  tax_lines     JSONB,
  total         NUMERIC(12,2),
  currency      TEXT DEFAULT 'NGN',
  fx_rate       NUMERIC(12,2),
  base_amount   NUMERIC(14,2),
  due_at        TIMESTAMPTZ,
  collected_at  TIMESTAMPTZ,
  created_by    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE laundry_items (
  id              TEXT PRIMARY KEY,
  order_id        TEXT NOT NULL REFERENCES laundry_orders(id) ON DELETE CASCADE,
  kind            TEXT,
  service_id      TEXT,
  name            TEXT NOT NULL,
  unit            TEXT,
  qty             INT DEFAULT 1,
  unit_price      NUMERIC(12,2),
  base_price      NUMERIC(12,2),
  amount          NUMERIC(12,2),
  added           JSONB,
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  price_id        TEXT,
  list_id         TEXT,
  list_name       TEXT,
  /* The order the desk rang the garments in, so the board reads back the same
     sequence the folio was posted in. */
  sort_order      INT DEFAULT 0,
  /* The folio line this garment was billed on. An order is not a note in the
     margin of a stay: it is money on the guest's account, and the link has to be
     readable from either end. */
  charge_id       TEXT
);

/* ── documents ──────────────────────────────────────────────── */

CREATE TABLE documents (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  guest_id        TEXT REFERENCES guests(id),
  reservation_id  TEXT REFERENCES reservations(id),
  name            TEXT NOT NULL,
  category        TEXT NOT NULL,
  source          TEXT,
  source_key      TEXT,
  status          TEXT DEFAULT 'Draft',
  notes           TEXT,
  guest_visible   BOOLEAN DEFAULT false,
  retention_years INT DEFAULT 7,
  retention_until DATE,
  created_by      TEXT,
  signed_by       TEXT,
  signed_at       TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  archived_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX docs_property_idx ON documents(property_id);

/* ── lost & found ───────────────────────────────────────────── */

/* The four words are the register's own (assets/pages-operations.js): an item
   is stored, waits on a courier, goes back to its guest, or is written off.
   "location" carries the room number or area as the finder wrote it — "G02" and
   "Lobby" are places on this register — while "room_id" links the item to a
   room when the word happens to be one, so a guest's stay can be read beside
   it. "note" is the storage and courier line the browser keeps on the card. */
CREATE TABLE lost_found (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id),
  description  TEXT NOT NULL,
  location     TEXT,
  found_by     TEXT,
  guest_id     TEXT REFERENCES guests(id),
  room_id      TEXT REFERENCES rooms(id),
  status       TEXT DEFAULT 'Stored' CHECK (status IN ('Stored','Awaiting courier','Returned','Disposed')),
  note         TEXT,
  found_date   DATE,
  claimed_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX lost_found_property_idx ON lost_found(property_id);

/* ── notifications & activity ───────────────────────────────── */

CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id),
  type         TEXT,
  title        TEXT NOT NULL,
  detail       TEXT,
  link         TEXT,
  read         BOOLEAN DEFAULT false,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX notif_property_idx ON notifications(property_id);

CREATE TABLE activity_log (
  id           TEXT PRIMARY KEY,
  property_id  TEXT REFERENCES properties(id),
  actor        TEXT,
  action       TEXT NOT NULL,
  entity       TEXT,
  detail       TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX activity_property_idx ON activity_log(property_id);
CREATE INDEX activity_created_idx  ON activity_log(created_at DESC);

/* ── reviews ────────────────────────────────────────────────── */

CREATE TABLE reviews (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  guest_id        TEXT REFERENCES guests(id),
  guest_name      TEXT,
  reservation_id  TEXT REFERENCES reservations(id),
  channel         TEXT,
  rating          INT CHECK (rating BETWEEN 1 AND 5),
  title           TEXT,
  body            TEXT,
  stay_summary    TEXT,
  responded       BOOLEAN DEFAULT false,
  response        TEXT,
  responded_by    TEXT,
  responded_at    TIMESTAMPTZ,
  review_date     DATE,
  created_at      TIMESTAMPTZ DEFAULT now()
);

/* ── financial documents ────────────────────────────────────── */

/* lines and adjustments are kept as JSONB because an invoice prints the
   charge as it was raised — a later price change must not rewrite it. */
CREATE TABLE invoices (
  id              TEXT PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  kind            TEXT NOT NULL CHECK (kind IN ('folio','event','laundry','manual')),
  entity_id       TEXT,
  reservation_id  TEXT REFERENCES reservations(id),
  guest_id        TEXT REFERENCES guests(id),
  title           TEXT NOT NULL,
  invoice_date    DATE NOT NULL,
  due_date        DATE,
  /* A document is billed in one currency, and the rate it was raised at is
     pinned on it: every line, payment and refund on that document converts at
     this figure, whatever the treasury files afterwards. */
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  lines           JSONB NOT NULL DEFAULT '[]',
  adjustments     JSONB NOT NULL DEFAULT '[]',
  status          TEXT NOT NULL DEFAULT 'Unpaid'
                    CHECK (status IN ('Unpaid','Partially paid','Paid','Void')),
  raised_by       TEXT,
  raised_at       TIMESTAMPTZ DEFAULT now(),
  voided_by       TEXT,
  voided_at       TIMESTAMPTZ,
  void_reason     TEXT,
  notes           TEXT
);
CREATE INDEX invoices_property_idx ON invoices(property_id);
CREATE INDEX invoices_res_idx      ON invoices(reservation_id);
CREATE INDEX invoices_status_idx   ON invoices(status);

CREATE TABLE refunds (
  id              TEXT PRIMARY KEY,
  invoice_id      TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  reservation_id  TEXT,
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  refund_date     DATE NOT NULL,
  method          TEXT DEFAULT 'Bank transfer',
  reason          TEXT NOT NULL,
  reference       TEXT,
  issued_by       TEXT,
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX refunds_invoice_idx ON refunds(invoice_id);

CREATE TABLE expenses (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  expense_date    DATE NOT NULL,
  category        TEXT NOT NULL,
  description     TEXT NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT DEFAULT 'NGN',
  fx_rate         NUMERIC(12,2),
  base_amount     NUMERIC(14,2),
  method          TEXT,
  payee           TEXT,
  attachment      TEXT,
  status          TEXT NOT NULL DEFAULT 'Pending'
                    CHECK (status IN ('Pending','Approved','Rejected')),
  recorded_by     TEXT,
  recorded_at     TIMESTAMPTZ DEFAULT now(),
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT
);
CREATE INDEX expenses_property_idx ON expenses(property_id);
CREATE INDEX expenses_date_idx     ON expenses(expense_date);
CREATE INDEX expenses_status_idx   ON expenses(status);

/* The four-eyes register. The change column holds exactly the payload the
   requesting action would have run, so approving applies the same code path.
   Every figure here is paired with the money it is in: a queue that holds a
   bare number gets a dollar discount read as naira by whoever signs it. */
CREATE TABLE approvals (
  id              TEXT PRIMARY KEY,
  property_id     TEXT NOT NULL REFERENCES properties(id),
  kind            TEXT NOT NULL CHECK (kind IN ('price','discount','refund','expense','fx')),
  subject         TEXT NOT NULL,
  subject_id      TEXT,
  change          JSONB NOT NULL,
  amount          NUMERIC(12,2) NOT NULL,
  currency        TEXT NOT NULL,
  from_value      NUMERIC(12,2),
  from_currency   TEXT,
  to_value        NUMERIC(12,2),
  to_currency     TEXT,
  reason          TEXT NOT NULL,
  requested_by    TEXT,
  requested_at    TIMESTAMPTZ DEFAULT now(),
  status          TEXT NOT NULL DEFAULT 'Pending'
                    CHECK (status IN ('Pending','Approved','Rejected')),
  decided_by      TEXT,
  decided_at      TIMESTAMPTZ,
  decision_note   TEXT
);
CREATE INDEX approvals_status_idx ON approvals(status);

/* ── night audit ────────────────────────────────────────────── */

/* The business date is one value for the group: closing a day rolls it for
   every property, which is why the run posts across the whole estate. */
CREATE TABLE business_date (
  id        INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  day       DATE NOT NULL,
  seeded_on DATE NOT NULL
);

/* One row per closed date. The pack is stored, not recomputed: the figures
   finance hold for a sealed day are the figures the close sealed. posted_total
   is counted in the money the books keep, so a night billed in dollars seals at
   the naira it was worth on the day it was billed, not at the dollar itself. */
CREATE TABLE closed_days (
  date         DATE PRIMARY KEY,
  rolled_to    DATE NOT NULL,
  closed_at    TIMESTAMPTZ NOT NULL,
  closed_by    TEXT NOT NULL,
  checks       JSONB NOT NULL DEFAULT '{}',
  posted       JSONB NOT NULL DEFAULT '[]',
  posted_total NUMERIC(14,2) NOT NULL DEFAULT 0,
  stats        JSONB NOT NULL
);

/* One numbering series for the whole group. Every property falls back to the
   same default prefix, so per-property counters would issue the same number
   twice and collide on invoices.number. */
CREATE TABLE invoice_series (
  id  INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seq INT NOT NULL DEFAULT 0
);

/* ── waitlist releases (PRD 6.1) ────────────────────────────── */
/* An offer is its own record, not a flag on the stay: the same reservation can
   be offered, the hold can lapse, and the room can pass down the queue without
   the stay itself moving. Accepting is what turns the promise into a booking. */
CREATE TABLE waitlist_offers (
  id             TEXT PRIMARY KEY,
  reservation_id TEXT NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  property_id    TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  room_id        TEXT NOT NULL REFERENCES rooms(id),
  room_type_id   TEXT NOT NULL REFERENCES room_types(id),
  offered_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  notified_at    TIMESTAMPTZ,
  status         TEXT NOT NULL DEFAULT 'Offered'
                   CHECK (status IN ('Offered','Accepted','Declined','Expired')),
  closed_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX waitlist_property_idx ON waitlist_offers(property_id);
CREATE INDEX waitlist_res_idx      ON waitlist_offers(reservation_id);

/* ── counters (reservation reference sequences) ─────────────── */

CREATE TABLE counters (
  property_id TEXT PRIMARY KEY REFERENCES properties(id),
  res_seq     INT DEFAULT 0
);
`;

async function run() {
  const reset = process.argv.includes("--reset");
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    console.log("🔌 Connected to PostgreSQL");
    await client.query("BEGIN");
    if (reset) {
      console.log("⚠️  Dropping all tables…");
      await client.query(DROP);
    }
    console.log("📐 Running schema migrations…");
    await client.query(SCHEMA);
    await client.query("COMMIT");
    console.log("✅ Migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Migration failed:", err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) run();

module.exports = { SCHEMA, DROP };
