/**
 * Seed the database with the demonstration dataset that matches what the
 * frontend builds against in localStorage. Run after migrate.js:
 *   node src/db/seed.js
 *
 * This is fictional data and is refused on a production install unless
 * ALLOW_DEMO_SEED=true is set. A production install runs migrate only and
 * creates its own property, staff and rate rows through the API.
 *
 * seed(client) takes the connection so the tests can drive the exact same
 * statements through in-memory Postgres — the seed is the API's only source of
 * demo data, and an untested one drifts.
 */
require("dotenv").config({ path: require("path").join(__dirname, "../../.env") });
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const CAT = require("./catalogue");
const config = require("../config");

/* The rules every property starts on — the same defaults the SPA resolves to
   when a setting was never touched. Only the prefix is per-hotel, because in the
   browser a document is numbered with the property's own code and every hotel's
   register has to read as its own. */
const FINANCE_DEFAULTS = {
  invoicePrefix: "AGM", paymentDays: 7, approvalAmount: 500000, discountPct: 10, rateMaxAgeDays: 3,
};

const PERMISSION_KEYS = [
  "manage_reservations", "check_in_out", "view_guest_profiles", "edit_guest_profiles",
  "housekeeping_board", "post_charges", "take_payments", "manage_billing",
  "record_expenses", "approve_expenses", "manage_financial_settings",
  "approve_financial_changes", "view_reports", "manage_rates", "configure_prices",
  "book_events", "run_laundry", "manage_staff", "night_audit",
];

/** Mirrors defaultPermissions() in assets/store.js, key for key. */
function rolePermissions() {
  const all = PERMISSION_KEYS.reduce((m, k) => (m[k] = true, m), {});
  const none = PERMISSION_KEYS.reduce((m, k) => (m[k] = false, m), {});
  return {
    Manager: Object.assign({}, all),
    "Front Desk": Object.assign({}, none, {
      manage_reservations: true, check_in_out: true, view_guest_profiles: true,
      edit_guest_profiles: true, post_charges: true, take_payments: true,
      manage_billing: true, book_events: true,
    }),
    Housekeeping: Object.assign({}, none, {
      view_guest_profiles: true, housekeeping_board: true, record_expenses: true, run_laundry: true,
    }),
    Revenue: Object.assign({}, none, {
      manage_reservations: true, view_guest_profiles: true, view_reports: true,
      manage_rates: true, configure_prices: true,
    }),
    // The second pair of hands the four-eyes gate has been asking for: the ledger
    // to keep and the wide moves to sign, with nothing that lets them ask for
    // their own signature — no prices, no rates, no cost recorded, no day sealed.
    "Finance Manager": Object.assign({}, none, {
      manage_billing: true, approve_expenses: true, manage_financial_settings: true,
      approve_financial_changes: true, view_reports: true,
    }),
    // Read-only by construction: the one permission an auditor holds is the
    // right to look. Every write in the module checks a different key.
    Auditor: Object.assign({}, none, { view_reports: true }),
    Guest: {},
  };
}

const PROPERTIES = [
  { id: "agm", code: "AGM", name: "Aurelia Grand Marina",   short: "Grand Marina",  city: "Victoria Island, Lagos", country: "Nigeria", address: "12 Ozumba Mbadiwe Avenue, Victoria Island", phone: "+234 1 460 8800", email: "reservations@aureliagrand.com", tagline: "Waterfront luxury on the Lagos Lagoon", gm: "Ifeoma Okafor", opened: 2019, floors: 4, per_floor: 12, rate_index: 1,    occ_target: 0.82, star: 5 },
  { id: "ari", code: "ARI", name: "Aurelia Reserve Ikoyi",  short: "Reserve Ikoyi", city: "Ikoyi, Lagos",            country: "Nigeria", address: "4 Glover Road, Ikoyi",                        phone: "+234 1 271 4400", email: "reserve@aureliagrand.com",       tagline: "A quiet residence in the heart of Ikoyi",  gm: "Chidi Balogun",  opened: 2021, floors: 3, per_floor: 10, rate_index: 0.94, occ_target: 0.76, star: 5 },
  { id: "apa", code: "APA", name: "Aurelia Palms Abuja",    short: "Palms Abuja",   city: "Maitama, Abuja",          country: "Nigeria", address: "9 Gana Street, Maitama",                      phone: "+234 9 462 7700", email: "abuja@aureliagrand.com",         tagline: "Diplomatic calm, minutes from the capital", gm: "Halima Sule",    opened: 2023, floors: 3, per_floor: 8,  rate_index: 0.86, occ_target: 0.72, star: 5 },
];

const ROOM_TYPES = [
  { id: "dk", code: "DLK", name: "Deluxe King",       size: 38,  occupancy: 2, bed: "King bed",        view: "Courtyard",            amenities: ["Rain shower","Nespresso","Smart TV","High-speed Wi-Fi","In-room safe"] },
  { id: "dt", code: "DLT", name: "Deluxe Twin",       size: 40,  occupancy: 2, bed: "Two queen beds",  view: "Courtyard",            amenities: ["Rain shower","Nespresso","Smart TV","High-speed Wi-Fi","In-room safe"] },
  { id: "pv", code: "PSV", name: "Premier Sea View",  size: 46,  occupancy: 2, bed: "King bed",         view: "Atlantic Ocean",       amenities: ["Private balcony","Butler on call","Nespresso","Evening turndown","Pillow menu"] },
  { id: "es", code: "EXS", name: "Executive Suite",   size: 64,  occupancy: 3, bed: "King + sofa bed",  view: "Skyline",              amenities: ["Lounge access","Separate living room","Butler on call","Complimentary pressing","Nespresso"] },
  { id: "gv", code: "GDV", name: "Garden Villa",      size: 88,  occupancy: 4, bed: "King bed",         view: "Private garden",       amenities: ["Plunge pool","Private garden","Butler service","Outdoor shower","Dining pavilion"] },
  { id: "ps", code: "PRS", name: "Presidential Suite",size: 150, occupancy: 4, bed: "Super king",       view: "Panoramic waterfront", amenities: ["Private lift","Dining for eight","Dedicated butler","Executive chef on call","Chauffeur"] },
];

const RATE_PLANS = [
  { id: "flex", code: "FLEX", name: "Flexible Rate",       modifier: 1,    deposit_pct: 25,  cancel_policy: "Free cancellation until 48 hours before arrival", includes: "Breakfast for two" },
  { id: "adv",  code: "ADV",  name: "Advance Purchase",    modifier: 0.85, deposit_pct: 100, cancel_policy: "Non-refundable · full prepayment",                includes: "Breakfast for two · 15% saving" },
  { id: "corp", code: "CORP", name: "Corporate Negotiated", modifier: 0.88, deposit_pct: 0,  cancel_policy: "Free cancellation until 24 hours before arrival", includes: "Breakfast · airport transfer" },
  { id: "club", code: "CLUB", name: "Aurelia Club Rate",   modifier: 0.92, deposit_pct: 0,   cancel_policy: "Free cancellation until 24 hours before arrival", includes: "Breakfast · 14:00 checkout" },
  { id: "ota",  code: "OTA",  name: "Partner Channel Rate", modifier: 1.06, deposit_pct: 0,  cancel_policy: "Free cancellation until 72 hours before arrival", includes: "Breakfast for two" },
];

const USERS = [
  { email: "ifeoma.okafor@aureliagrand.com", name: "Ifeoma Okafor",  role: "Manager",      property_id: "agm" },
  { email: "adamu.bello@aureliagrand.com",   name: "Adamu Bello",    role: "Front Desk",   property_id: "agm" },
  { email: "grace.mensah@aureliagrand.com",  name: "Grace Mensah",   role: "Housekeeping", property_id: "agm" },
  { email: "chiamaka.obi@aureliagrand.com",  name: "Chiamaka Obi",   role: "Revenue",      property_id: "agm" },
  // The second pair of hands the four-eyes gate has been waiting for: the same
  // address the browser signs in with, so one credential opens both layers.
  { email: "emeka.balogun@aureliagrand.com", name: "Emeka Balogun",  role: "Finance Manager", property_id: "agm" },
  { email: "seun.adele@aureliagrand.com",    name: "Seun Adeleke",   role: "Auditor",      property_id: "agm" },
  { email: "guest@aureliagrand.com",         name: "Adaeze Nwankwo", role: "Guest",        property_id: "agm" },
];

/* Same plan and the same per-property scaling as the browser seed, but
   deterministic: no random month-end drift, so the financial dashboard reads
   identically after every reseed. */
const EXPENSE_PLAN = [
  { category: "Payroll", desc: "Salaries, wages and benefits", base: 3800000, method: "Transfer", payee: "Group payroll" },
  { category: "Utilities", desc: "Power, diesel and generator hours", base: 1150000, method: "Transfer", payee: "Surger / Gridco" },
  { category: "Cost of sales", desc: "Kitchen, bar and grocery purchases", base: 980000, method: "Transfer", payee: "Milestone Fresh" },
  { category: "Repairs & maintenance", desc: "Engineering spares and call-outs", base: 410000, method: "Card", payee: "Ozolua Motors" },
  { category: "Housekeeping", desc: "Amenities, consumables and linen hire", base: 320000, method: "Transfer", payee: "Dryline Textiles" },
  { category: "Laundry", desc: "Chemicals and outsource pressing", base: 265000, method: "Transfer", payee: "Crisp Press" },
  { category: "Marketing", desc: "Channel commissions and brand campaign", base: 540000, method: "Card", payee: "Blaai / Booking.com" },
  { category: "Statutory", desc: "Rent, levies and statutory charges", base: 700000, method: "Transfer", payee: "State board" },
  { category: "Technology", desc: "Property system, gateway and licences", base: 180000, method: "Card", payee: "PMS vendor" },
];

/* The board the events desk opens on — the same five bookings the browser seeds
   (assets/data.js, EVENT_SEED), quoted here by the engine rather than by hand.
   The two dated behind the business day are history on purpose: without them a
   financial period reports no event revenue at all, and the property plainly
   trades in halls.
   Two of the browser's five sit inside a guest's folio. The API seed has no
   reservations to host them, so every row here is billed to its own account —
   money that belongs to the events desk rather than a balance the seed invented.
   Every figure on the row comes out of P.hallQuote, so a seeded booking is
   priced the way a live one is: nothing below is a number this file decides. */
const EVENT_SEED = [
  { hall: "hall_grand", prop: "agm", title: "Access Bank Leadership Summit", organizer: "Dami Akintula",
    email: "events@accessbankplc.com", phone: "+234 803 411 2200", guests: 260, in: 2,
    start: "08:00", end: "18:00", package: "full", layout: "Banquet rounds with stage and screen",
    addons: { evt_decor: 1, evt_sound: 1, evt_projector: 1, evt_catering: 260 }, status: "Confirmed" },
  { hall: "hall_garden", prop: "agm", title: "Laurent — Obi wedding reception", organizer: "Claire Laurent",
    email: "claire.laurent@gmail.com", phone: "+233 24 887 1120", guests: 110, in: 9,
    start: "16:00", end: "23:00", layout: "Cocktail layout with terrace lighting",
    addons: { evt_flowers: 2, evt_sound: 1 }, status: "Confirmed" },
  // A hold reserves the time and agrees no money yet, so the board shows a
  // booking that has not been sold — the state the confirm door exists for.
  { hall: "hall_board", prop: "ari", title: "Brandt Group board meeting", organizer: "Oliver Brandt",
    email: "assistant@brandt-group.de", phone: "+49 30 8845 2210", guests: 14, in: 1,
    start: "09:30", end: "13:30", package: "half", layout: "Board table, still water and notepads",
    addons: { evt_projector: 1 }, status: "Hold" },
  { hall: "hall_grand", prop: "agm", title: "Nigeria LNG quarterly briefing", organizer: "Chinwe Okoro",
    email: "events@nlng.com", phone: "+234 802 220 7788", guests: 180, in: -12,
    start: "09:00", end: "17:00", package: "full", layout: "Banquet rounds with stage and screen",
    addons: { evt_decor: 1, evt_sound: 1, evt_catering: 180 }, status: "Confirmed" },
  // The browser seeds this reception at 140 guests in a terrace licensed for
  // 120 — a booking its own form would refuse to take. The demo data keeps to
  // the licence the rule enforces.
  { hall: "hall_garden", prop: "agm", title: "Adeyemi — Balogun wedding reception", organizer: "Yewande Balogun",
    email: "yewande.balogun@gmail.com", phone: "+234 805 118 4400", guests: 120, in: -26,
    start: "15:00", end: "23:00", layout: "Dining rounds with marquee lighting",
    addons: { evt_flowers: 3, evt_sound: 1, evt_catering: 120 }, status: "Confirmed" },
];

/* The guest book the stays are filed under — the rich profiles the browser
   seeds (assets/data.js, RICH) in the same order and with the same details, so
   profile gst_5 is the same person in either layer. gst_1 is the demo guest the
   guest login is bound to and is written below with its folio already on file.
   Nothing financial is here: a guest carries a tier and a point balance, and the
   money a stay earns is quoted by the engine at seed time. */
const GUEST_SEED = [
  { id: "gst_2", t: "Mr", f: "James", l: "Whitfield", country: "United Kingdom", city: "London",
    tier: "Platinum", job: "Managing Partner, Aldgate Capital", bd: "1974-11-02", since: 2019, pts: 96250,
    email: "james.whitfield@aldgatecapital.co.uk", phone: "+44 20 7946 0128",
    prefs: { pillow: "Firm orthopaedic", room: "Quiet corner", dietary: "Vegetarian", allergies: "None",
      beverage: "Espresso", newspaper: "Financial Times", turndown: "Evening turndown" },
    tags: ["Repeat guest", "Vegetarian", "Late checkout"],
    note: "Requests a 14:00 checkout and a table at Isla for dinner on arrival night." },
  { id: "gst_3", t: "Dr", f: "Fatima", l: "Al-Hassan", country: "Nigeria", city: "Abuja",
    tier: "Gold", job: "Permanent Secretary, Ministry of Trade", bd: "1979-07-23", since: 2020, pts: 41500,
    email: "fatima.alhassan@trade.gov.ng", phone: "+234 803 442 1180",
    prefs: { pillow: "Hypoallergenic", room: "Low floor near spa", dietary: "Halal", allergies: "Feathers",
      beverage: "Green tea", newspaper: "The Guardian", turndown: "On request" },
    tags: ["VIP", "Family", "Halal"],
    note: "Travels with two children and a nanny. Feather-free room; arrange adjoining rooms where possible." },
  { id: "gst_4", t: "Mr", f: "Tunde", l: "Bakare", country: "Nigeria", city: "Lagos",
    tier: "Gold", job: "COO, Lagos Free Zone", bd: "1976-02-09", since: 2019, pts: 58750,
    email: "tunde.bakare@lagosfreezone.ng", phone: "+234 805 220 7741",
    prefs: { pillow: "Soft feather", room: "Ocean-facing", dietary: "No restrictions", allergies: "Peanuts",
      beverage: "Espresso", newspaper: "BusinessDay", turndown: "On request" },
    tags: ["Repeat guest", "Whisky"],
    note: "Keeps a bottle of single malt behind the bar. Prefers the marina-facing rooms." },
  { id: "gst_5", t: "Ms", f: "Sophie", l: "Laurent", country: "France", city: "Paris",
    tier: "Gold", job: "Creative Director, Maison Laurent", bd: "1988-09-14", since: 2022, pts: 22500,
    email: "sophie.laurent@maisonlaurent.fr", phone: "+33 1 4478 2200",
    prefs: { pillow: "Soft feather", room: "High floor, away from lift", dietary: "Gluten-free", allergies: "Gluten",
      beverage: "Still water", newspaper: "Le Monde", turndown: "Evening turndown" },
    tags: ["Anniversary", "Gluten-free"],
    note: "Celebrating an anniversary in November. Send a handwritten card and macarons on arrival." },
  { id: "gst_6", t: "Mr", f: "Michael", l: "Chen", country: "Singapore", city: "Singapore",
    tier: "Silver", job: "Senior Consultant, Bain & Company", bd: "1985-12-30", since: 2023, pts: 14000,
    email: "michael.chen@bainconsulting.sg", phone: "+65 6824 3310",
    prefs: { pillow: "Memory foam", room: "Quiet corner", dietary: "No restrictions", allergies: "None",
      beverage: "Green tea", newspaper: "The Wall Street Journal", turndown: "On request" },
    tags: ["Frequent flyer"],
    note: "Works late; requests extra towels and a desk lamp. Never disturb before 09:00." },
  { id: "gst_7", t: "Dr", f: "Ngozi", l: "Eze", country: "Nigeria", city: "Enugu",
    tier: "Platinum", job: "Consultant Cardiologist", bd: "1980-06-05", since: 2018, pts: 73750,
    email: "ngozi.eze@enuguchildrenshospital.ng", phone: "+234 806 119 4402",
    prefs: { pillow: "Firm orthopaedic", room: "Away from lift", dietary: "Low sodium", allergies: "Penicillin",
      beverage: "Chamomile tea", newspaper: "The Guardian", turndown: "Evening turndown" },
    tags: ["Repeat guest", "Wellness"],
    note: "Books a 60-minute deep tissue massage on every stay. Medical note: penicillin allergy." },
  { id: "gst_8", t: "Mr", f: "Ravi", l: "Mehta", country: "India", city: "Mumbai",
    tier: "Gold", job: "Director, Sun Pharma International", bd: "1972-03-21", since: 2020, pts: 36250,
    email: "ravi.mehta@sunpharma.co.in", phone: "+91 22 6743 1180",
    prefs: { pillow: "Buckwheat", room: "High floor, away from lift", dietary: "Vegan", allergies: "Lactose",
      beverage: "Green tea", newspaper: "Financial Times", turndown: "On request" },
    tags: ["Vegan", "Early breakfast"],
    note: "Requires a vegan breakfast before 07:00. Ayurvedic tea stocked in the room." },
  { id: "gst_9", t: "Ms", f: "Elena", l: "Petrova", country: "United Arab Emirates", city: "Dubai",
    tier: "Silver", job: "Art Advisor", bd: "1986-08-11", since: 2023, pts: 9500,
    email: "elena.petrova@dubaiartadvisory.ae", phone: "+971 4 352 7788",
    prefs: { pillow: "Hypoallergenic", room: "Ocean-facing", dietary: "No restrictions", allergies: "Lactose",
      beverage: "Espresso", newspaper: "None", turndown: "Evening turndown" },
    tags: ["Art collection"],
    note: "Travelling for the Art X fair; needs secure storage for two crated works." },
  { id: "gst_10", t: "Mr", f: "Kwame", l: "Mensah", country: "Ghana", city: "Accra",
    tier: "Gold", job: "Head of Corporate Banking, Stanbic", bd: "1978-01-27", since: 2021, pts: 47750,
    email: "kwame.mensah@stanbicbank.com.gh", phone: "+233 302 667 100",
    prefs: { pillow: "Firm orthopaedic", room: "High floor, away from lift", dietary: "No restrictions",
      allergies: "Shellfish", beverage: "Still water", newspaper: "Financial Times", turndown: "On request" },
    tags: ["Golf", "Repeat guest"],
    note: "Books a golf transfer for Saturday mornings. Shellfish allergy — flag to all outlets." },
  { id: "gst_11", t: "Mrs", f: "Aisha", l: "Bello", country: "Nigeria", city: "Kano",
    tier: "Platinum", job: "Founder, Bello Textiles", bd: "1983-10-08", since: 2019, pts: 85000,
    email: "aisha.bello@bellotextiles.ng", phone: "+234 802 776 3300",
    prefs: { pillow: "Memory foam", room: "Near the pool", dietary: "Halal", allergies: "None",
      beverage: "Chamomile tea", newspaper: "BusinessDay", turndown: "Evening turndown" },
    tags: ["Spa", "VIP"],
    note: "Regular in the spa — prefers therapist Amara. Always books the Garden Villa for privacy." },
  { id: "gst_12", t: "Mr", f: "Thomas", l: "Berger", country: "Germany", city: "Munich",
    tier: "Silver", job: "Principal Engineer, Siemens", bd: "1970-05-16", since: 2022, pts: 16250,
    email: "thomas.berger@siemens.de", phone: "+49 89 634 2280",
    prefs: { pillow: "Firm orthopaedic", room: "Quiet corner", dietary: "No restrictions", allergies: "None",
      beverage: "Espresso", newspaper: "None", turndown: "On request" },
    tags: ["Early riser"],
    note: "Requests a firm mattress topper and a quiet room away from the service lift." },
  { id: "gst_13", t: "Ms", f: "Yuki", l: "Tanaka", country: "Japan", city: "Tokyo",
    tier: "Gold", job: "Design Director, Kengo Kuma & Associates", bd: "1989-02-14", since: 2022, pts: 27750,
    email: "yuki.tanaka@kengokuma.co.jp", phone: "+81 3 5412 6680",
    prefs: { pillow: "Buckwheat", room: "Ocean-facing", dietary: "No restrictions", allergies: "None",
      beverage: "Green tea", newspaper: "None", turndown: "On request" },
    tags: ["Fragrance-free"],
    note: "Fragrance-free room — no diffusers, no scented linen spray. Matcha in the minibar." },
  { id: "gst_14", t: "Mr", f: "Olumide", l: "Adeyemi", country: "Nigeria", city: "Ibadan",
    tier: "Silver", job: "Managing Counsel, Aluko & Oyebode", bd: "1977-09-03", since: 2021, pts: 18250,
    email: "olumide.adeyemi@alukooyebode.ng", phone: "+234 803 771 2244",
    prefs: { pillow: "Soft feather", room: "High floor, away from lift", dietary: "No restrictions",
      allergies: "None", beverage: "Fresh lime juice", newspaper: "The Guardian", turndown: "On request" },
    tags: ["Late arrival"],
    note: "Usually arrives after 23:00. Keep the kitchen informed for a late supper." },
  { id: "gst_15", t: "Ms", f: "Isabella", l: "Rossi", country: "Italy", city: "Milan",
    tier: "Platinum", job: "Owner, Cantina Rossi", bd: "1982-07-19", since: 2021, pts: 64250,
    email: "isabella.rossi@cantarossi.it", phone: "+39 02 8901 4477",
    prefs: { pillow: "Soft feather", room: "Quiet corner", dietary: "No restrictions", allergies: "Tree nuts",
      beverage: "Sparkling water", newspaper: "None", turndown: "Evening turndown" },
    tags: ["Wine", "Late dinner"],
    note: "Hosts private wine dinners in the cellar. Tree nut allergy. Books dinner at 21:00." },
  { id: "gst_16", t: "Mr", f: "David", l: "Okon", country: "Nigeria", city: "Port Harcourt",
    tier: "Silver", job: "Operations Director, Air Peace", bd: "1984-04-06", since: 2023, pts: 11750,
    email: "david.okon@airpeace.com", phone: "+234 809 334 5522",
    prefs: { pillow: "Memory foam", room: "Away from lift", dietary: "No restrictions", allergies: "None",
      beverage: "Still water", newspaper: "BusinessDay", turndown: "On request" },
    tags: ["Gym", "Early flight"],
    note: "Uses the gym at 05:30 and needs a protein breakfast to go. Usually on a 07:00 flight." },
  { id: "gst_17", t: "Ms", f: "Grace", l: "Adeleke", country: "Nigeria", city: "Lagos",
    tier: "Gold", job: "Editor-in-Chief, The Lede", bd: "1990-11-11", since: 2020, pts: 33750,
    email: "grace.adeleke@thelede.ng", phone: "+234 812 445 0099",
    prefs: { pillow: "Hypoallergenic", room: "Ocean-facing", dietary: "Vegan", allergies: "None",
      beverage: "Fresh lime juice", newspaper: "The Guardian", turndown: "Evening turndown" },
    tags: ["Vegan", "Birthday"],
    note: "Birthday in November. Vegan menu available at all outlets; send a plant-based amenity." },
  { id: "gst_18", t: "Mr", f: "Peter", l: "van Dijk", country: "Netherlands", city: "Amsterdam",
    tier: "Gold", job: "VP Chartering, Maersk", bd: "1975-12-12", since: 2019, pts: 52250,
    email: "peter.vandijk@maersk.com", phone: "+31 10 244 7788",
    prefs: { pillow: "Firm orthopaedic", room: "High floor, away from lift", dietary: "No restrictions",
      allergies: "None", beverage: "Sparkling water", newspaper: "Financial Times", turndown: "On request" },
    tags: ["Repeat guest", "Late checkout"],
    note: "Negotiated corporate rate via the travel desk. Late checkout until 16:00." },
];

/* The rest of the key rack. The browser's guest book carries a hundred filler
   profiles behind its eighteen named guests (assets/data.js, buildGuests) and
   stands one of them in the rooms its walk gives a guest, so its three hotels
   open at 67.4%, 57.1% and 68.2%. The API's board had only the named few, and
   four keys shut on a guest is a hotel no dashboard would recognise. These are
   the profiles the fill stays below are filed under — one guest each, because
   the browser never puts one person in two rooms, and only the first line of
   each profile is ever read at the desk. */
const FILL_GUESTS = (function fillers() {
  const firsts = ["Amaka", "Chidi", "Sarah", "Omar", "Lucas", "Hannah", "Ibrahim", "Maya",
    "Daniel", "Priya", "Noah", "Zainab", "Sofia", "Emeka", "Claire", "Femi", "Leila", "Marcus",
    "Ifeoma", "Sean", "Halima", "Victor", "Elena", "Tunde", "Ngozi", "Ravi", "Aisha"];
  const lasts = ["Obi", "Balogun", "Mitchell", "Haddad", "Silva", "Keller", "Sule", "Kapoor",
    "Fischer", "Sharma", "Bergen", "Musa", "Marino", "Nnamdi", "Dubois", "Ogunleye", "Nasser",
    "Reed", "Uche", "Doherty", "Yusuf", "Mbeki"];
  const countries = ["Nigeria", "Nigeria", "Ghana", "Kenya", "South Africa", "United Kingdom",
    "France", "Germany", "India", "Lebanon"];
  const pillows = ["Memory foam", "Soft feather", "Firm orthopaedic", "Buckwheat", "Hypoallergenic"];
  const rooms = ["High floor, away from lift", "Low floor near spa", "Quiet corner",
    "Away from lift", "Ocean-facing", "Near the pool"];
  const dietary = ["No restrictions", "Vegetarian", "Vegan", "Gluten-free", "Halal", "Low sodium"];
  const allergies = ["None", "None", "Shellfish", "Peanuts", "Tree nuts", "Gluten", "Lactose"];
  const beverages = ["Still water", "Sparkling water", "Chamomile tea", "Espresso", "Green tea"];
  const papers = ["Financial Times", "The Guardian", "BusinessDay", "Le Monde", "None"];
  const pad = (n) => String(n).padStart(2, "0");
  const out = [];
  // One per fill stay: 27 at the flagship, 15 at the Reserve, 14 at the capital.
  for (let i = 0; i < 56; i++) {
    // Firsts and lasts advance at different lengths, so no pair — and no name a
    // rich profile already uses — comes up twice.
    const f = firsts[i % firsts.length];
    const l = lasts[i % lasts.length];
    const country = countries[i % countries.length];
    out.push({
      id: "gst_f" + (i + 1), t: i % 3 === 0 ? "Mrs" : "Mr", f, l,
      email: `${(f + "." + l).toLowerCase()}${i + 1}@example.com`,
      phone: "+234 81" + String(20000000 + i * 913711).slice(0, 8),
      country, city: country === "Nigeria" ? (i % 2 ? "Lagos" : "Abuja") : country,
      // The browser's tierFor: a gold every eleventh, a silver every fourth.
      tier: i % 11 === 0 ? "Gold" : i % 4 === 0 ? "Silver" : "Member",
      job: ["Consultant", "Entrepreneur", "Civil servant", "Architect", "Investor", "Journalist", "Engineer"][i % 7],
      bd: `19${70 + (i % 25)}-${pad((i % 12) + 1)}-${pad((i % 27) + 1)}`,
      since: 2019 + (i % 5),
      prefs: {
        pillow: pillows[i % pillows.length], room: rooms[i % rooms.length],
        dietary: dietary[i % dietary.length], allergies: allergies[i % allergies.length],
        beverage: beverages[i % beverages.length], newspaper: papers[i % papers.length],
        turndown: i % 2 ? "Evening turndown" : "On request",
      },
      consent: { marketing: i % 3 !== 0, dataSharing: i % 4 === 0, profiling: true },
      tags: i % 9 === 0 ? ["Repeat guest"] : [],
      pts: 1200 + i * 430,
    });
  }
  return out;
})();

/* The roster the desk works from — the browser's buildStaff (assets/data.js):
   twelve people at the flagship and the first seven at each of the others, with
   the same ids the browser files its tasks under. A task assigned to nobody, or
   to a person the roster has never heard of, is a board the desk cannot act on. */
const STAFF_BASE = [
  { name: "Ifeoma Okafor", role: "Manager", dept: "Executive", title: "General Manager", email: "ifeoma.okafor@aureliagrand.com", shift: "08:00 – 18:00" },
  { name: "Adamu Bello", role: "Front Desk", dept: "Front Office", title: "Front Office Manager", email: "adamu.bello@aureliagrand.com", shift: "06:00 – 15:00" },
  { name: "Zainab Yusuf", role: "Front Desk", dept: "Front Office", title: "Front Desk Agent", email: "zainab.yusuf@aureliagrand.com", shift: "14:00 – 23:00" },
  { name: "Grace Mensah", role: "Housekeeping", dept: "Housekeeping", title: "Housekeeping Supervisor", email: "grace.mensah@aureliagrand.com", shift: "07:00 – 16:00" },
  { name: "Blessing Uche", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "blessing.uche@aureliagrand.com", shift: "08:00 – 17:00" },
  { name: "Samuel Nnamdi", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "samuel.nnamdi@aureliagrand.com", shift: "08:00 – 17:00" },
  { name: "Tobi Ogunleye", role: "Housekeeping", dept: "Housekeeping", title: "Room Attendant", email: "tobi.ogunleye@aureliagrand.com", shift: "10:00 – 19:00" },
  { name: "Chiamaka Obi", role: "Revenue", dept: "Revenue", title: "Revenue Manager", email: "chiamaka.obi@aureliagrand.com", shift: "09:00 – 18:00" },
  { name: "Emeka Balogun", role: "Finance Manager", dept: "Finance", title: "Financial Controller", email: "emeka.balogun@aureliagrand.com", shift: "08:00 – 17:00" },
  { name: "Leila Haddad", role: "Manager", dept: "Food & Beverage", title: "F&B Director", email: "leila.haddad@aureliagrand.com", shift: "11:00 – 22:00" },
  { name: "Victor Uche", role: "Housekeeping", dept: "Engineering", title: "Maintenance Technician", email: "victor.uche@aureliagrand.com", shift: "08:00 – 17:00" },
  { name: "Amara Nwosu", role: "Manager", dept: "Spa & Wellness", title: "Spa Manager", email: "amara.nwosu@aureliagrand.com", shift: "09:00 – 18:00" },
];

/* The floor hands each hotel: the browser's cleanerByProp. */
const CLEANERS = {
  agm: ["stf_agm_4", "stf_agm_5", "stf_agm_6"],
  ari: ["stf_ari_4", "stf_ari_5"],
  apa: ["stf_apa_4", "stf_apa_5"],
};

/* What guests asked the desk for today, in the browser's order: the request
   board exists so the SLA clock is visible, and a board with only housekeeping
   turns on it would not show a guest waiting. */
const REQUEST_SEED = [
  { title: "Extra pillows and a firm mattress topper", type: "Guest request", dept: "Housekeeping", pri: "Normal", mins: 40 },
  { title: "Sparkling water and fresh lime in the minibar", type: "Guest request", dept: "Food & Beverage", pri: "Normal", mins: 25 },
  { title: "Late checkout request — 15:00", type: "Guest request", dept: "Front Office", pri: "High", mins: 30 },
  { title: "Air conditioning not cooling", type: "Maintenance", dept: "Engineering", pri: "High", mins: 60 },
  { title: "Spa booking — 60 min deep tissue, 18:00", type: "Guest request", dept: "Spa & Wellness", pri: "Normal", mins: 90 },
  { title: "Airport transfer to Murtala Muhammed, 07:00", type: "Guest request", dept: "Transport", pri: "High", mins: 45 },
  { title: "Vegetarian dinner in-room for two", type: "Guest request", dept: "Food & Beverage", pri: "Normal", mins: 45 },
  { title: "Turn-down service with lavender linen", type: "Housekeeping", dept: "Housekeeping", pri: "Low", mins: 120 },
  { title: "Baby cot and bottle steriliser", type: "Guest request", dept: "Housekeeping", pri: "High", mins: 35 },
  { title: "Lost phone charger — original Apple 20W", type: "Guest request", dept: "Front Office", pri: "Low", mins: 60 },
  { title: "Anniversary amenity — macarons and card", type: "Guest request", dept: "Food & Beverage", pri: "High", mins: 50 },
  { title: "Inspect suite before VIP arrival", type: "Inspection", dept: "Housekeeping", pri: "High", mins: 30 },
];

/* The trading day the API opens on.
   The browser builds its board from a random walk over the occupancy target
   (assets/data.js), so replaying it here would mean the two layers agreeing on
   the order every random read happens in — and the first edit to either engine
   would silently price a different hotel. Instead the board is written by hand
   and every figure on it is the engine's: `in` is the offset from the business
   day, `n` the nights, and the money comes out of P.stayQuote exactly as the
   desk's own booking door reads it.
   The states are the point. A seeded board has to reach every corner of the
   module: a long stay and a one-nighter in house, a departure due today, an
   arrival today, a no-show, bookings still ahead, history already settled and
   one cancellation that sold nothing. */
/* The rest of the house. The browser's walk fills its three hotels to about
   two thirds — 31 of 46 sellable keys at the flagship, 16 of 28 at the Reserve
   and 15 of 22 at the capital — and the API opened on four, so every dashboard
   but the flagship read a demolition rather than a demo. These are the keys
   behind those figures, in the browser's own room mix and in its own pattern of
   stay lengths. Three rules hold the rest of the board still:
   `in` is always before the business day, so the day's departure board keeps
   exactly the folios the named stays file; `in + n` is always after it, so
   every fill is billed through tonight and the close owes no night of theirs;
   and plans are the ones a desk sells on account — the advance-purchase stay is
   paid in full at booking and would owe the close nothing. */
const FILL_STAYS = [
  // ── the flagship: 31 of 46 ──
  // the corporate wing — the business the marina runs on
  ["agm", "dk", -2, 4], ["agm", "dk", -1, 4], ["agm", "dk", -3, 5], ["agm", "dk", -2, 3],
  ["agm", "dk", -1, 3], ["agm", "dk", -4, 5], ["agm", "dk", -1, 2], ["agm", "dk", -3, 4],
  // premier views, booked by the long weekend
  ["agm", "pv", -2, 4], ["agm", "pv", -1, 3], ["agm", "pv", -3, 4], ["agm", "pv", -2, 3],
  ["agm", "pv", -1, 2], ["agm", "pv", -3, 5],
  // garden twins, mostly travelling in pairs
  ["agm", "dt", -2, 4], ["agm", "dt", -1, 3], ["agm", "dt", -3, 5], ["agm", "dt", -2, 3],
  ["agm", "dt", -1, 2], ["agm", "dt", -3, 4], ["agm", "dt", -2, 5],
  // the suites — two more beside the anniversary guest
  ["agm", "es", -2, 4], ["agm", "es", -1, 3], ["agm", "es", -3, 4],
  // and the villas, one of them on the corporate rate
  ["agm", "gv", -2, 3], ["agm", "gv", -1, 4],
  // the second presidential key, out before the cellar dinner arrives
  ["agm", "ps", -1, 2],
  // ── the Reserve: 16 of 28 — a villa, six kings, four twins, three views, two suites ──
  ["ari", "gv", -2, 4],
  ["ari", "dk", -1, 2], ["ari", "dk", -3, 5], ["ari", "dk", -2, 3],
  ["ari", "dk", -4, 5], ["ari", "dk", -1, 4],
  ["ari", "dt", -2, 4], ["ari", "dt", -1, 3], ["ari", "dt", -3, 4], ["ari", "dt", -2, 5],
  ["ari", "pv", -1, 2], ["ari", "pv", -3, 4], ["ari", "pv", -2, 3],
  ["ari", "es", -1, 3], ["ari", "es", -2, 4],
  // ── the capital: 15 of 22 — one of each the house has, plus seven kings ──
  ["apa", "gv", -1, 4],
  ["apa", "dk", -2, 4], ["apa", "dk", -1, 2], ["apa", "dk", -3, 5], ["apa", "dk", -2, 3],
  ["apa", "dk", -4, 5], ["apa", "dk", -1, 3], ["apa", "dk", -3, 4],
  ["apa", "dt", -2, 4], ["apa", "dt", -1, 3],
  ["apa", "pv", -1, 2],
  ["apa", "es", -2, 3], ["apa", "es", -1, 2],
  ["apa", "ps", -2, 3],
].map(([prop, type, inDays, nights], i) => ({
  gst: "gst_f" + (i + 1), prop, type, in: inDays, n: nights,
  plan: ["flex", "corp", "club"][i % 3], status: "In-house",
  adults: i % 3 === 0 ? 2 : 1,
  channel: ["Direct", "Corporate", "Booking.com", "Expedia"][i % 4],
}));

const STAY_SEED = [
  // In house at the flagship: a week-old suite, a club-rate room that prepaid
  // nothing, a fully prepaid villa and a corporate departure due today.
  { gst: "gst_1", prop: "agm", type: "es", plan: "flex", in: -3, n: 6, status: "In-house",
    adults: 2, channel: "Direct", eta: "14:30", notes: "Anniversary amenity confirmed with Isla.",
    extras: [{ svc: "ina_breakfast", qty: 2, on: 1 }, { svc: "spa_signature", qty: 1, on: 2 },
      { svc: "mini_soft", qty: 1, on: 3 }] },
  { gst: "gst_2", prop: "agm", type: "pv", plan: "club", in: -1, n: 3, status: "In-house",
    adults: 1, channel: "Direct", notes: "Vegetarian tray on arrival; no fish sauce in the room.",
    extras: [{ svc: "ina_dessert", qty: 2, on: 0 }] },
  { gst: "gst_7", prop: "agm", type: "gv", plan: "adv", in: -2, n: 4, status: "In-house",
    adults: 2, channel: "Direct", notes: "Penicillin allergy on file — flagged to all outlets.",
    extras: [{ svc: "spa_pool", qty: 1, on: 1 }, { svc: "isla_grill", qty: 2, on: 2 }] },
  { gst: "gst_4", prop: "agm", type: "dk", plan: "corp", in: -2, n: 2, status: "In-house",
    adults: 2, channel: "Corporate", notes: "Settles against the free-zone account.",
    extras: [{ svc: "ina_suya", qty: 1, on: 0 }] },
  // Today's front office: one guest arriving this afternoon.
  { gst: "gst_3", prop: "agm", type: "pv", plan: "flex", in: 0, n: 2, status: "Confirmed",
    adults: 2, children: 2, channel: "Direct", eta: "16:00",
    notes: "Adjoining room requested for the nanny." },
  /* The Reserve and the capital keep a named guest in house too — booked before
     the fills so the document register anchors each hotel on somebody the desk
     knows rather than on whichever filler took the first key. */
  { gst: "gst_9", prop: "ari", type: "dk", plan: "flex", in: -1, n: 2, status: "In-house",
    adults: 1, channel: "Direct", extras: [{ svc: "spa_facial", qty: 1, on: 0 }] },
  { gst: "gst_12", prop: "apa", type: "pv", plan: "ota", in: -2, n: 3, status: "In-house",
    adults: 2, channel: "Expedia", notes: "Channel rate — breakfast included at the lounge." },
  /* The fills are booked before the guests who left this morning, so each
     departure is handed a key none of them stands in: the booking door only
     counts a Confirmed or In-house stay as a hold, and a departed room is free
     to resell — but nobody can sleep in it the night before the guest leaves.
     Ordered this way, the room the morning departure vacated is still the one
     room on the floor's list. */
  ...FILL_STAYS,
  /* And the two who left this morning, settled at the desk on the way out. They
     are on the board for the state they leave rather than the money they paid: a
     room nobody has turned over is the only thing that puts work on the
     housekeeping board, and a departure settled today is what puts money in
     today's till. */
  { gst: "gst_13", prop: "agm", type: "dk", plan: "flex", in: -1, n: 1, status: "Checked out",
    adults: 1, channel: "Direct", pays: "Cash", notes: "On the morning flight; the key was left at the desk." },
  { gst: "gst_8", prop: "apa", type: "es", plan: "club", in: -1, n: 1, status: "Checked out",
    adults: 2, channel: "Direct", pays: "Transfer", notes: "One more night at the old rate, then back to Abuja." },
  // Ahead of the day, on the arrivals board nobody has checked in yet.
  { gst: "gst_5", prop: "agm", type: "ps", plan: "flex", in: 3, n: 2, status: "Confirmed",
    adults: 2, channel: "Direct", notes: "Anniversary — card and macarons on the bed at turn-down." },
  { gst: "gst_18", prop: "agm", type: "dk", plan: "corp", in: 5, n: 3, status: "Confirmed",
    adults: 1, channel: "Corporate", notes: "Late checkout to 16:00 agreed with the travel desk." },
  // History the period reports need: a prepaid stay that ran into extras, and a
  // cancellation that sold nothing and left no line behind.
  { gst: "gst_8", prop: "agm", type: "dk", plan: "adv", in: -9, n: 3, status: "Checked out",
    adults: 2, channel: "Direct",
    extras: [{ svc: "ina_breakfast", qty: 3, on: 1 }, { svc: "spa_pool", qty: 1, on: 2 }] },
  { gst: "gst_10", prop: "agm", type: "pv", plan: "flex", in: 2, n: 2, status: "Cancelled",
    adults: 2, channel: "GDS", notes: "Cancelled inside the free window — no fee owed." },
  // The Reserve and the capital keep history too, or a group report reads as one hotel.
  { gst: "gst_16", prop: "apa", type: "dk", plan: "club", in: -8, n: 2, status: "Checked out",
    adults: 1, channel: "Direct", extras: [{ svc: "ina_burger", qty: 1, on: 0 }] },
  { gst: "gst_11", prop: "apa", type: "gv", plan: "club", in: 4, n: 2, status: "Confirmed",
    adults: 2, children: 1, channel: "Direct", notes: "The villa again — she never takes a room." },
  { gst: "gst_15", prop: "ari", type: "ps", plan: "flex", in: 6, n: 2, status: "Confirmed",
    adults: 2, channel: "Direct", notes: "Cellar dinner for eight to be quoted separately." },
  { gst: "gst_14", prop: "agm", type: "dt", plan: "flex", in: -1, n: 2, status: "In-house",
    adults: 1, channel: "Direct", eta: "23:15", notes: "Arrives on the late flight; supper kept warm.",
    extras: [{ svc: "ina_jollof", qty: 1, on: 1 }] },
  { gst: "gst_17", prop: "agm", type: "pv", plan: "flex", in: -16, n: 2, status: "Checked out",
    adults: 2, channel: "Direct",
    extras: [{ svc: "isla_tasting", qty: 2, on: 1 }] },
  /* Last, because a no-show is the one state that never blocks a key: the room it
     was held in goes back on the shelf, so a twin booked before it would be
     handed the same door. Seeded after the in-house twin, it takes a room nobody
     is standing in. */
  { gst: "gst_6", prop: "agm", type: "dt", plan: "flex", in: 0, n: 1, status: "No-show",
    adults: 1, channel: "Booking.com", notes: "Flight cancelled; the room was held all night." },
  /* And one request the desk could not seat: a king for two nights at the
     flagship that the house had no key left to promise. The promise went on the
     waitlist instead of into a room — it holds no key, takes no deposit and
     owes nothing until an offer is taken up. Appended last because, like the
     no-show, it blocks no room for the stays above it. */
  { gst: "gst_5", prop: "agm", type: "dk", plan: "flex", in: 2, n: 2, status: "Waitlist",
    adults: 1, channel: "Walk-in", notes: "Waiting on a Garden Villa cancellation", ago: -6 },
];

/* ── helpers ─────────────────────────────────────────────────── */
function today() {
  return new Date().toISOString().slice(0, 10);
}
function addDays(d, n) {
  const dt = new Date(d + "T12:00:00");
  dt.setDate(dt.getDate() + n);
  return dt.toISOString().slice(0, 10);
}
function addYears(d, n) {
  const dt = new Date(d + "T12:00:00");
  dt.setFullYear(dt.getFullYear() + n);
  return dt.toISOString().slice(0, 10);
}

async function seed(client) {
  /* ── properties ── */
  for (const p of PROPERTIES) {
    await client.query(
      `INSERT INTO properties (id,code,name,short,city,country,address,phone,email,tagline,gm,opened,floors,per_floor,rate_index,occ_target,star)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT DO NOTHING`,
      [p.id, p.code, p.name, p.short, p.city, p.country, p.address, p.phone, p.email, p.tagline, p.gm, p.opened, p.floors, p.per_floor, p.rate_index, p.occ_target, p.star]
    );
    await client.query(
      `INSERT INTO settings (property_id, data) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [p.id, JSON.stringify({ depositPct: 25, checkInTime: "15:00", checkOutTime: "12:00", currency: "NGN", language: "English (UK)", overbooking: 0, cancellation: "Free cancellation until 48 hours before arrival.", integrations: {}, finance: Object.assign({}, FINANCE_DEFAULTS, { invoicePrefix: p.code }), branding: { brandName: p.id === "agm" ? "Aurelia Grand" : p.name, tagline: p.id === "agm" ? "Hotels & Residences" : p.tagline, logo: "", images: [], palette: null, useColors: true, updatedAt: null, updatedBy: null } })]
    );
    await client.query(`INSERT INTO counters (property_id) VALUES ($1) ON CONFLICT DO NOTHING`, [p.id]);
  }

  /* ── room types ── */
  for (const t of ROOM_TYPES) {
    await client.query(
      `INSERT INTO room_types (id,code,name,size,occupancy,bed,view,amenities) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [t.id, t.code, t.name, t.size, t.occupancy, t.bed, t.view, JSON.stringify(t.amenities)]
    );
  }

  /* ── inventory ──
     Without these rows the API has a price for a room it cannot sell: no
     reservation can be assigned, the housekeeping board is empty, and the night
     audit reports zero sellable rooms. */
  for (const r of CAT.buildRooms(PROPERTIES)) {
    await client.query(
      `INSERT INTO rooms (id,property_id,number,type_id,floor,hk_status,ooo_reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [r.id, r.propertyId, r.number, r.typeId, r.floor, r.hk, r.oooReason]
    );
  }

  /* ── rate plans ── */
  for (const p of RATE_PLANS) {
    await client.query(
      `INSERT INTO rate_plans (id,code,name,modifier,deposit_pct,cancel_policy,includes) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [p.id, p.code, p.name, p.modifier, p.deposit_pct, p.cancel_policy, p.includes]
    );
  }

  /* ── price catalogue ──
     Lists, tax rules, services and prices all come from src/db/catalogue.js,
     a line-for-line port of the browser seed. Seeding anything else would give
     the API a price list that disagrees with the SPA. */
  for (const l of CAT.PRICE_LISTS) {
    await client.query(
      `INSERT INTO price_lists (id,name,kind,from_date,to_date,priority,currency,active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true) ON CONFLICT DO NOTHING`,
      [l.id, l.name, l.kind, l.from, l.to, l.priority, l.currency || "NGN"]
    );
  }
  for (const t of CAT.TAX_RULES) {
    await client.query(
      `INSERT INTO tax_rules (id,name,kind,pct,sort_order,applies_to)
       VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [t.id, t.name, t.kind, t.pct, t.order, JSON.stringify(t.appliesTo)]
    );
  }
  for (const s of CAT.buildServices()) {
    await client.query(
      `INSERT INTO services (id,category,ref_id,code,name,unit,active,occupancy,capacity,outlet_id,outlet,addon,turnaround_mins)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT DO NOTHING`,
      [s.id, s.category, s.refId, s.code, s.name, s.unit, s.active,
        s.occupancy || null, s.capacity || null, s.outletId || null,
        s.outlet ? JSON.stringify(s.outlet) : null,
        !!s.addon, s.turnaroundMins || null]
    );
  }
  const stamp = new Date().toISOString();
  for (const p of CAT.buildPrices(stamp)) {
    await client.query(
      `INSERT INTO prices (id,service_id,list_id,currency,amount,surcharges,from_date,to_date,active,created_at,updated_at,updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT DO NOTHING`,
      [p.id, p.serviceId, p.listId, p.currency, p.amount, JSON.stringify(p.surcharges),
        p.from, p.to, p.active, p.createdAt, p.updatedAt, p.updatedBy]
    );
  }

  /* ── staff permissions (singleton) ──
     A reseed only fills in keys the stored map has never seen. Whatever a
     general manager ticked in the app survives; the four finance permissions
     simply arrive switched off. */
  const stored = await client.query(`SELECT data FROM staff_permissions WHERE id = 1`);
  const defaults = rolePermissions();
  if (!stored.rowCount) {
    await client.query(`INSERT INTO staff_permissions (id, data) VALUES (1, $1)`, [JSON.stringify(defaults)]);
  } else {
    const map = stored.rows[0].data;
    let changed = false;
    for (const role of Object.keys(defaults)) {
      const cur = map[role] || {};
      map[role] = Object.assign({}, defaults[role], cur);
      changed = changed || Object.keys(defaults[role]).some((k) => !(k in cur));
    }
    if (changed) await client.query(`UPDATE staff_permissions SET data = $1 WHERE id = 1`, [JSON.stringify(map)]);
  }

  /* ── the clock ──
     Both singletons are written DO NOTHING so re-running the seed against a
     live property cannot rewind a business day the audit already rolled. */
  const day = today();
  await client.query(
    `INSERT INTO business_date (id, day, seeded_on) VALUES (1, $1, $1) ON CONFLICT DO NOTHING`,
    [day]
  );
  await client.query(`INSERT INTO invoice_series (id, seq) VALUES (1, 0) ON CONFLICT DO NOTHING`);

  /* ── exchange rates ──
     Dated against the business day rather than the calendar, so a reseed on a
     rolled day still leaves one rate inside the property's trust limit and one
     outside it — the states the currency rules are actually about. */
  for (const r of CAT.buildFxRates(day)) {
    await client.query(
      `INSERT INTO fx_rates (id,code,per_base,effective,set_by,set_at,note)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [r.id, r.code, r.perBase, r.effective, r.setBy, r.effective + "T09:00:00.000Z", r.note]
    );
  }

  /* ── demo users ── */
  const hash = await bcrypt.hash("aurelia2026", 12);
  for (const u of USERS) {
    await client.query(
      `INSERT INTO users (email, password_hash, name, role, property_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO NOTHING`,
      [u.email, hash, u.name, u.role, u.property_id]
    );
  }

  /* ── demo guest, linked to the guest login ── */
  await client.query(
    `INSERT INTO guests (id,title,first_name,last_name,name,email,phone,country,city,tier,job,loyalty_pts,preferences,consent,tags)
     VALUES ('gst_1','Mrs','Adaeze','Nwankwo','Adaeze Nwankwo','adaeze.nwankwo@meridian.ng','+234 802 555 0101','Nigeria','Lagos','Platinum','Group CEO, Meridian Energy',1250,
       '{"pillow":"Memory foam","room":"High floor, away from lift","dietary":"No restrictions","allergies":"Shellfish","beverage":"Sparkling water","newspaper":"BusinessDay","turndown":"Evening turndown"}',
       '{"marketing":true,"dataSharing":false,"profiling":true}',
       '["Repeat guest","Allergy","CEO"]')
     ON CONFLICT DO NOTHING`
  );
  await client.query(`UPDATE users SET guest_id = 'gst_1' WHERE email = 'guest@aureliagrand.com'`);
  await client.query(
    `INSERT INTO guest_notes (id,guest_id,text,recorded_by,recorded_at)
     VALUES ('note_gst_1','gst_1',$1,'Front Office',$2) ON CONFLICT DO NOTHING`,
    ["Prefers a quiet corner suite. Always travelling with an executive assistant; cc her on confirmations.",
      addDays(day, -21)]
  );

  /* ── the guest book ──
     The profiles the board below is filed under. A stay cannot exist without a
     guest row, so an empty book is why the API had no reservations: every
     profile a desk opens at the counter lands here first, and the portal's
     search has something to find. */
  for (const g of GUEST_SEED) {
    const n = Number(g.id.slice(4));
    await client.query(
      `INSERT INTO guests (id,title,first_name,last_name,name,email,phone,country,city,tier,job,birthday,since,
         id_type,id_number,preferences,consent,tags,loyalty_pts,language,featured)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,true)
       ON CONFLICT DO NOTHING`,
      [g.id, g.t, g.f, g.l, g.f + " " + g.l, g.email, g.phone, g.country, g.city, g.tier, g.job, g.bd, g.since,
        g.country === "Nigeria" ? "National ID" : "International passport",
        g.country === "Nigeria" ? "NIN-" + (100000000 + n * 7919) : "P" + (4000000 + n * 3571),
        JSON.stringify(g.prefs),
        JSON.stringify({ marketing: g.tier !== "Member", dataSharing: n % 5 !== 0, profiling: true }),
        JSON.stringify(g.tags), g.pts, g.country === "France" ? "French" : "English"]
    );
    await client.query(
      `INSERT INTO guest_notes (id,guest_id,text,recorded_by,recorded_at)
       VALUES ($1,$2,$3,'Front Office',$4) ON CONFLICT DO NOTHING`,
      ["note_" + g.id, g.id, g.note, addDays(day, -(20 + n))]
    );
  }

  /* The fillers behind the keys the board holds tonight. No note, no history:
     the desk knows them from the rack, exactly as the browser's filler profiles
     are only ever a name on a room. */
  for (const [i, g] of FILL_GUESTS.entries()) {
    await client.query(
      `INSERT INTO guests (id,title,first_name,last_name,name,email,phone,country,city,tier,job,
         birthday,since,id_type,id_number,preferences,consent,tags,loyalty_pts,language,featured)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'International passport',$14,$15,$16,$17,$18,'English',false)
       ON CONFLICT DO NOTHING`,
      [g.id, g.t, g.f, g.l, g.f + " " + g.l, g.email, g.phone, g.country, g.city, g.tier, g.job,
        g.bd, g.since, "P" + (5000000 + i * 613), JSON.stringify(g.prefs),
        JSON.stringify(g.consent), JSON.stringify(g.tags), g.pts]
    );
  }

  /* ── operating expenses ──
     Anything paid inside the last week has not reached the sign-off sheet yet,
     so the dashboard shows a live queue of claims. One line is Rejected so all
     three states are reachable from the seed alone. */
  let expSeq = 0;
  for (const p of PROPERTIES) {
    const scale = p.rate_index * ((p.floors * p.per_floor) / 48);
    for (let m = 1; m >= 0; m--) {
      for (let c = 0; c < EXPENSE_PLAN.length; c++) {
        const plan = EXPENSE_PLAN[c];
        expSeq++;
        const date = addDays(day, -(m * 30 + c * 2));
        const rejected = m === 0 && c === EXPENSE_PLAN.length - 1;
        const status = rejected ? "Rejected" : date >= addDays(day, -8) ? "Pending" : "Approved";
        await client.query(
          `INSERT INTO expenses
           (id,property_id,expense_date,category,description,amount,currency,method,payee,status,recorded_by,recorded_at,decided_by,decided_at,decision_note)
           VALUES ($1,$2,$3,$4,$5,$6,'NGN',$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT DO NOTHING`,
          ["exp_" + expSeq, p.id, date, plan.category, plan.desc,
            CAT.round50(plan.base * scale), plan.method, plan.payee, status, p.gm,
            date + "T09:00:00.000Z",
            status === "Pending" ? null : "Group Finance",
            status === "Pending" ? null : addDays(date, 3) + "T14:00:00.000Z",
            rejected ? "Duplicate of the approved line — the supplier re-invoiced." : null]
        );
      }
    }
  }

  /* ── hall bookings ──
     Quoted through the engine the live desk uses, over the catalogue this
     transaction has just written. Both libraries are required here rather than
     at the top of the file because they bind to a database connection the first
     time they load: the tests install an in-memory Postgres after loading this
     module, and a top-level require would have captured whatever pool happened
     to be cached before then. A seed that priced off a stale connection would
     quietly disagree with every route that reads it back. */
  const P = require("../lib/price");
  const FX = require("../lib/fx");
  const { jsonOut } = require("../lib/json");

  const cat = await P.catalogue(client);
  const src = await FX.sources(day, client);
  let evtSeq = 0;
  for (const spec of EVENT_SEED) {
    evtSeq++;
    const svc = P.serviceOf(cat, "hall", spec.hall);
    if (!svc) throw new Error(`The seed books ${spec.hall}, which is not in the catalogue.`);
    const date = addDays(day, spec.in);
    const quote = P.hallQuote(cat, svc.id, {
      propertyId: spec.prop, fx: src, date, start: spec.start, end: spec.end,
      package: spec.package || null,
      addons: Object.keys(spec.addons).map((id) => ({ id, qty: spec.addons[id] })),
    });
    // A booking the engine refuses to quote is a mistake in this file, and an
    // install that carries on would open with a board missing a booking nobody
    // was told about. Say so and stop.
    if (!quote) throw new Error(`The seed cannot quote ${spec.title} in ${svc.name} on ${date}.`);
    if (quote.skipped.length) {
      throw new Error(`The seed's ${spec.title} could not price ${quote.skipped.map((s) => s.name).join(", ")}.`);
    }

    const id = "evt_" + evtSeq;
    const byKind = {};
    quote.taxLines.forEach((l) => { byKind[l.rule.kind] = (byKind[l.rule.kind] || 0) + l.amount; });
    const sur = quote.price.surcharges || {};
    await client.query(
      `INSERT INTO events (id,property_id,hall_id,hall_service_id,title,organizer,event_date,start_time,end_time,
         package,package_name,hours,status,reservation_id,contact_email,contact_phone,layout,guests_count,notes,
         subtotal,tax,service_charge,vat,tax_lines,total,currency,fx_rate,base_amount,
         deposit,deposit_pct,deposit_paid,cancel_pct,cancel_hours,cancel_fee,
         price_id,list_id,list_name,created_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,
               $27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39) ON CONFLICT DO NOTHING`,
      [id, spec.prop, svc.refId, svc.id, spec.title, spec.organizer, date, spec.start, spec.end,
        quote.package, quote.packageName, quote.hours, spec.status, null,
        spec.email, spec.phone, spec.layout, spec.guests, "",
        quote.subtotal, quote.tax, byKind.service || 0, byKind.vat || 0,
        jsonOut(quote.taxLines.map((l) => ({ ruleId: l.rule.id, label: l.label, amount: l.amount }))),
        quote.total, quote.currency, quote.fxRate, quote.baseAmount,
        quote.deposit, quote.depositPct, 0, sur.cancelPct || 0, sur.cancelHours || 0, 0,
        quote.price.id, quote.list.id, quote.list.name, "Events desk",
        addDays(date, -10) + "T09:00:00.000Z"]
    );
    // The lines the booking was sold on, in the order the desk read them: a
    // cancellation and an invoice are both rebuilt from these rows, so a hall
    // re-priced next month must not rewrite the money already agreed.
    for (const [i, line] of quote.lines.entries()) {
      await client.query(
        `INSERT INTO event_lines (id,event_id,kind,service_id,name,unit,qty,unit_price,base_price,amount,added,
           currency,fx_rate,base_amount,price_id,list_id,list_name,sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT DO NOTHING`,
        [`${id}_l${i}`, id, line.kind, line.serviceId, line.name, line.unit, line.qty,
          line.unitPrice, line.basePrice, line.amount, jsonOut(line.added || []),
          line.currency, line.fxRate, line.baseAmount, line.priceId, line.listId, line.listName, i]
      );
    }
  }

  /* ── the trading day ──
     The board every dashboard, folio and audit pack reads. Written through the
     doors the desk itself uses — BOOKING.freeRooms for the key, BOOKING.postNights
     for the nights, folio.takePayment for the money — so a seeded stay is not a
     picture of a booking but a booking, and the figures on it move if and only
     if the price list moves. Anything the engine refuses to quote stops the
     install rather than opening with a board missing a stay nobody was told
     about, exactly as the hall bookings above do. */
  const BOOKING = require("../lib/booking");
  const folio = require("../lib/folio");
  const LOY = require("../lib/loyalty");
  const biz = require("../lib/business-date");

  let staySeq = 0;
  for (const spec of STAY_SEED) {
    staySeq++;
    const id = "res_" + staySeq;
    /* Asked for before a key is chosen or a reference drawn: the nights below
       write randomised charge ids, so a stay that is already on the board has to
       be left exactly as it stands rather than billed a second time. */
    if ((await client.query(`SELECT id FROM reservations WHERE id = $1`, [id])).rowCount) continue;

    const ci = addDays(day, spec.in);
    const co = addDays(ci, spec.n);
    const adults = spec.adults || 1;
    const quote = P.stayQuote(cat, spec.type, spec.plan, ci, co, adults,
      { propertyId: spec.prop, fx: src });
    if (!quote) throw new Error(`The seed cannot quote ${spec.gst}'s ${spec.type} stay at ${spec.prop} from ${ci}.`);

    const { rows: guestRows } = await client.query(`SELECT name, tier FROM guests WHERE id = $1`, [spec.gst]);
    if (!guestRows[0]) throw new Error(`The seed books a stay for ${spec.gst}, who is not in the guest book.`);
    /* A waitlisted stay holds no key: the house promised a room, not a door. It
       is only given one when an offer is taken up, and the release pass that
       finds it applies the counter's own availability rule. */
    const waiting = spec.status === "Waitlist";
    let roomId = null;
    if (!waiting) {
      const free = await BOOKING.freeRooms(client, spec.prop, spec.type, ci, co);
      if (!free.length) throw new Error(`The seed has no ${spec.type} room free at ${spec.prop} from ${ci}.`);
      roomId = free[0].id;
    }
    const ref = await BOOKING.nextRef(client, spec.prop);
    /* A cancellation sold nothing, a no-show sold a night nobody slept, and a
       waitlist request has not been sold a night at all: none of them leaves a
       line on the books, which is exactly how the statement treats them — guest
       debt skips all three statuses. Every other state on the board stays as the
       doors would have left it. */
    const sold = !["Cancelled", "No-show", "Waitlist"].includes(spec.status);
    if (!sold && (spec.extras || []).length) {
      throw new Error(`The seed bills ${spec.gst}'s ${spec.status.toLowerCase()} stay — nothing was consumed.`);
    }

    const { rows: made } = await client.query(
      `INSERT INTO reservations (id,reference,property_id,guest_id,room_id,room_type_id,rate_plan_id,
         check_in,check_out,adults,children,status,channel,source,notes,eta,vip,deposit,
         checked_in_at,checked_out_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [id, ref, spec.prop, spec.gst, roomId, spec.type, spec.plan, ci, co, adults, spec.children || 0,
        spec.status, spec.channel || "Direct", "Seeded reservation", spec.notes || "", spec.eta || "",
        ["Platinum", "Gold"].indexOf(guestRows[0].tier) !== -1, 0,
        sold && spec.status !== "Confirmed" ? ci + "T15:00:00.000Z" : null,
        spec.status === "Checked out" ? co + "T11:00:00.000Z" : null]
    );
    const res = made[0];
    /* The waitlist request was taken days ago, not this morning: the queue is
       called oldest-first, and its age is what puts it at the front. */
    if (spec.ago) {
      await client.query(`UPDATE reservations SET created_at = $2 WHERE id = $1`,
        [id, new Date(Date.now() + spec.ago * 86400000)]);
    }

    let baseRoom = 0;
    let extrasTotal = 0;
    if (sold) {
      const posted = await BOOKING.postNights(client, { res, quote, checkOut: co, actor: "Front desk" });
      if (posted.error) throw new Error(`The seed could not bill ${ref}: ${posted.error}`);
      baseRoom = posted.baseRoom;

      /* What the guest consumed, priced off the same catalogue a tray ordered
         from the guest app is priced off — the item id and the quantity are the
         only things this file decides about a line. Nothing is billed forward of
         the business day: an unconsumed dinner is not a debt. */
      for (const x of spec.extras || []) {
        const date = addDays(ci, x.on);
        if (x.on < 0 || x.on >= spec.n) {
          throw new Error(`The seed bills ${x.svc} outside ${ref}'s own nights.`);
        }
        if (date > day) throw new Error(`The seed bills ${x.svc} on ${date}, after the business day ${day}.`);
        const svc = P.serviceOf(cat, "restaurant", x.svc);
        const hit = svc && svc.active ? P.resolve(cat.prices, cat.lists, svc.id, { date }) : null;
        if (!svc || !hit) throw new Error(`The seed bills ${ref} for ${x.svc}, which is not on the menu on ${date}.`);
        const value = P.amount(hit.price, svc, { date, qty: x.qty });
        const out = await folio.postCharge({
          client, reservationId: id, propertyId: spec.prop, date, currency: hit.price.currency,
          description: (x.qty > 1 ? x.qty + " × " : "") + svc.name + (svc.outlet ? ` · ${svc.outlet.name}` : ""),
          department: svc.outlet ? svc.outlet.dept : "Other",
          postedBy: svc.outlet ? svc.outlet.name : "Front desk",
          amount: value.lines, qty: x.qty, unitPrice: value.unit,
          extras: value.added, serviceId: svc.id, priceId: hit.price.id,
          listId: hit.list.id, listName: hit.list.name,
        });
        if (out.error) throw new Error(`The seed could not bill ${ref}: ${out.error}`);
        extrasTotal += Number(out.charge.amount);
      }
    }

    /* The deposit the plan asks for, then — for a stay that has left — the rest
       of the folio. Both through the till's own door, so a seeded payment carries
       the same money stamp as one taken at the counter. `deposit` on the stay is
       the money the plan asked for before arrival, not everything the account has
       seen: a departure settlement belongs to the payments, not the booking. */
    let took = 0;
    let depositTaken = 0;
    if (sold && quote.deposit > 0) {
      const at = spec.status === "Confirmed" ? day : ci;
      const out = await folio.takePayment({
        client, reservationId: id, propertyId: spec.prop, date: at, amount: quote.deposit,
        method: "Card", takenBy: spec.status === "Confirmed" ? "Web booking" : "Adamu Bello",
      });
      if (out.error) throw new Error(`The seed could not take ${ref}'s deposit: ${out.error}`);
      took = depositTaken = Number(out.payment.amount);
    }
    if (spec.status === "Checked out" && quote.total + extrasTotal > took) {
      const out = await folio.takePayment({
        client, reservationId: id, propertyId: spec.prop, date: co,
        amount: quote.total + extrasTotal - took, method: spec.pays || "Card", takenBy: "Adamu Bello",
      });
      if (out.error) throw new Error(`The seed could not settle ${ref}: ${out.error}`);
      took += Number(out.payment.amount);
    }

    /* The stay carries what its own lines say, in the order the booking door
       writes them: the money it is billed in and the rate the books hold for it,
       read back off the folio. A waitlist request carries the quote it was taken
       at without any line behind it — that is what the desk reads on the card. */
    if (sold || waiting) {
      await client.query(
        `UPDATE reservations SET room_total=$2, base_room_total=$3, subtotal=$4, service_chg=$5,
            vat_amount=$6, total=$7, currency=$8, fx_rate=$9, deposit=$10 WHERE id=$1`,
        [id, quote.roomTotal, Math.round(baseRoom), quote.roomTotal, quote.service, quote.vat,
          quote.total, quote.currency, await FX.folioRate(id, client), depositTaken]
      );
    }

    /* A departure earns the club its points at the counter, and a seeded
       departure is one the desk worked. It goes through the same award door the
       check-out route calls — the guest's balance, the stay's `points_awarded`
       and the trail line are the departure's own — with `baseTotal` read off the
       folio, which is where that door takes it from. A stay still in house keeps
       its points pending, exactly as the browser's club reads them. */
    if (spec.status === "Checked out") {
      const f = await folio.read(id, client);
      await LOY.award(client, { stay: res, baseTotal: f.baseTotal, actor: "Adamu Bello" });
    }

    /* The trail the close signs: the same three sentences the three doors write,
       so the activity log on a seeded day is a day's work rather than a blank. */
    const trail = [[waiting ? "joined the waitlist" : "created a reservation",
      `${ref} · ${guestRows[0].name} · ${quote.nights} night${quote.nights === 1 ? "" : "s"}`]];
    if (spec.status === "In-house" || spec.status === "Checked out") {
      trail.push(["checked in", ref]);
    }
    if (spec.status === "Checked out") trail.push(["checked out", ref]);
    for (const [i, [action, detail]] of trail.entries()) {
      await client.query(
        `INSERT INTO activity_log (id,property_id,actor,action,entity,detail)
         VALUES ($1,$2,$3,$4,'reservation',$5) ON CONFLICT DO NOTHING`,
        [`${id}_a${i + 1}`, spec.prop,
          action === "created a reservation" || action === "joined the waitlist" ? "Front desk" : "Adamu Bello",
          action, detail]
      );
    }
  }

  /* ── the desk's waitlist opens on one live release ──
     The oldest request is offered the first key of its type the house can free
     for its dates, on a 24-hour hold — the same availability rule the counter
     and the release pass apply. The offer is written quietly, as the browser's
     seed writes it: a hold that has been standing for two hours is not news the
     install announces, and the desk reads it on the board either way. */
  if (!(await client.query(`SELECT id FROM waitlist_offers WHERE id = 'wlo_seed1'`)).rowCount) {
    const { rows: waitingRows } = await client.query(
      `SELECT * FROM reservations WHERE property_id = 'agm' AND status = 'Waitlist'
        ORDER BY created_at, check_in LIMIT 1`
    );
    const wait = waitingRows[0];
    if (wait) {
      const ci = biz.dstr(wait.check_in), co = biz.dstr(wait.check_out);
      const free = await BOOKING.freeRooms(client, wait.property_id, wait.room_type_id, ci, co);
      if (!free.length) {
        throw new Error(`The seed has no ${wait.room_type_id} room free at ${wait.property_id} to release onto the waitlist.`);
      }
      const offeredAt = new Date(Date.now() - 2 * 3600000);
      await client.query(
        `INSERT INTO waitlist_offers
           (id,reservation_id,property_id,room_id,room_type_id,offered_at,expires_at,notified_at,status)
         VALUES ('wlo_seed1',$1,$2,$3,$4,$5,$6,$5,'Offered')`,
        [wait.id, wait.property_id, free[0].id, wait.room_type_id,
          offeredAt, new Date(offeredAt.getTime() + 24 * 3600000)]
      );
    }
  }

  /* ── the documents the money earned ──
     A guest who left with a settled folio left a bill behind them, and a hall
     that was delivered without ever touching a room account needs one of its own,
     so the register opens on the trading day's documents rather than an empty
     list. Both go through lib/invoices.raise — the counter's own door — so a
     seeded document carries the lines, the money stamp and the serial the desk
     would have given it; a second copy of these rules here would be a register
     whose figures depended on which code path wrote them.

     The board follows the browser's (assets/data.js): every settled stay is
     billed, and the two earliest-dated confirmed halls that stand on no folio —
     which on this board are the two already delivered. A reseed finds its own
     documents by the record they bill and leaves them alone. */
  const INV = require("../lib/invoices");
  const ledger = require("../lib/ledger");
  const billed = new Set(
    (await client.query(`SELECT entity_id FROM invoices`)).rows.map((r) => r.entity_id)
  );
  async function file(what, o) {
    if (billed.has(o.reservationId || o.eventId)) return null;
    const out = await INV.raise(Object.assign({ client, day, actor: "Night audit" }, o));
    // A folio the desk has already billed is not this file's to bill again.
    if (out.error) {
      if (/is already invoiced\.$/.test(out.error)) return null;
      throw new Error(`The seed could not raise ${what}: ${out.error}`);
    }
    return out.invoice;
  }

  let docSeq = 0;
  const settledStays = STAY_SEED.map((spec, i) => ({ spec, id: "res_" + (i + 1) }))
    .filter((s) => s.spec.status === "Checked out");
  for (const s of settledStays) {
    const inv = await file(`${s.id}'s folio`, { reservationId: s.id });
    if (!inv) continue;
    docSeq++;
    /* The desk takes the settlement against the paper it hands over, exactly
       as the browser's board presents it: the payments that closed the folio
       are attributed to the document that bills it and the document reads
       Paid. Debt itself is still measured at the folio, so this moves no
       money — it only says which paper the money answered. */
    await client.query(`UPDATE payments SET invoice_id = $2 WHERE reservation_id = $1`, [s.id, inv.id]);
    await ledger.settle(inv, client);
  }

  const delivered = EVENT_SEED.map((spec, i) => Object.assign({ id: "evt_" + (i + 1) }, spec))
    .filter((e) => e.status === "Confirmed")
    .sort((a, b) => {
      const x = addDays(day, a.in), y = addDays(day, b.in);
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .slice(0, 2);
  for (const e of delivered) {
    if (await file(e.title, { eventId: e.id })) docSeq++;
  }

  /* ── the laundry rail ──
     The browser's rail (assets/data.js: LAUNDRY_SEED) carries two orders taken
     from guests in house at the flagship: an express load mid-wash and an
     ordinary one waiting to be delivered. Both go through lib/laundry.create —
     the board's own door — so every garment on the rail is the charge on the
     folio, line for line and tax for tax, and the express uplift is the one the
     guest is billed. The stage and the clock are then written as the rail stood
     when the page opened: a board whose every card was just taken has never
     shown the board's own turnaround. */
  const LAU = require("../lib/laundry");
  const { rows: inHouseAgm } = await client.query(
    `SELECT id FROM reservations WHERE property_id = 'agm' AND status = 'In-house' ORDER BY id`);
  const LAUNDRY_SEED = [
    { items: [{ id: "ld_shirt", qty: 4 }, { id: "ld_trousers", qty: 2 }, { id: "ld_suit", qty: 1 }],
      express: true, status: "In progress", hoursAgo: 3 },
    { items: [{ id: "ld_bedding", qty: 3 }, { id: "ld_towel", qty: 6 }, { id: "ld_load", qty: 1 }],
      express: false, status: "Ready", hoursAgo: 14 },
  ];
  let laundrySeq = 0;
  // Once the rail has a card on it, those orders are the hotel's own: a reseed
  // must not take the same guest's washing a second time and post it again.
  const railOnFile = Number(
    (await client.query(`SELECT count(*) AS n FROM laundry_orders`)).rows[0].n
  ) > 0;
  for (const [ix, spec] of LAUNDRY_SEED.entries()) {
    const host = inHouseAgm[ix * 3];
    if (railOnFile || !host) continue;
    const out = await LAU.create({
      client, day, actor: "Grace Mensah", reservationId: host.id,
      items: spec.items, express: spec.express,
    });
    if (out.error) throw new Error(`The seed could not take laundry order ${ix + 1}: ${out.error}`);
    // The door promised the collection from the moment it took the order; moving
    // the card back in time moves the promise with it, or the rail would show a
    // turnaround nobody was given.
    const promised = new Date(out.order.due_at).getTime() - new Date(out.order.created_at).getTime();
    const created = new Date(Date.now() - spec.hoursAgo * 3600000);
    await client.query(
      `UPDATE laundry_orders SET status = $2, created_at = $3, due_at = $4 WHERE id = $1`,
      [out.order.id, spec.status, created.toISOString(),
        new Date(created.getTime() + promised).toISOString()]
    );
    laundrySeq++;
  }

  /* ── the register and the review board ──
     The browser's register seeds itself the first time its page opens
     (assets/pages-documents.js: seedDocuments), and its reviews are filed
     against the stays that have left. Both are mirrored here so a live install
     opens on the screen the demo shows without a page visit to fill it; the
     six samples per hotel, their categories, states and retention are the
     browser's own list. */
  const DOC_SAMPLES = [
    { name: "Digital registration card",    category: "Registration",  source: "Front desk",     sourceKey: "frontdesk", status: "Awaiting signature", years: 7, visible: true },
    { name: "Guest folio summary",          category: "Billing",       source: "Billing",        sourceKey: "billing",   status: "Ready",              years: 7, visible: true },
    { name: "Spa intake & consent",         category: "Spa & consent", source: "Spa / wellness", sourceKey: "spa",       status: "Awaiting signature", years: 2, visible: true },
    { name: "Banquet event order",          category: "Events",        source: "Events",         sourceKey: "events",    status: "Draft",              years: 7, visible: false },
    { name: "Airport transfer invoice",     category: "Billing",       source: "Billing",        sourceKey: "billing",   status: "Ready",              years: 7, visible: true },
    { name: "Complimentary upgrade receipt", category: "Billing",      source: "Front desk",     sourceKey: "frontdesk", status: "Ready",              years: 7, visible: true },
  ];
  const { rows: propRows } = await client.query(`SELECT id FROM properties ORDER BY id`);
  const { rows: stayRows } = await client.query(
    `SELECT id, property_id, guest_id, status FROM reservations ORDER BY property_id, id`);
  for (const p of propRows) {
    const own = stayRows.filter((r) => r.property_id === p.id);
    // A document is filed against the guest in the building, as the browser
    // files its samples: the first stay in house, or the first on the book.
    const anchor = own.find((r) => r.status === "In-house") || own[0] || null;
    for (const [i, s] of DOC_SAMPLES.entries()) {
      await client.query(
        `INSERT INTO documents (id,property_id,guest_id,reservation_id,name,category,source,source_key,
           status,notes,guest_visible,retention_years,retention_until,created_by,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'',$10,$11,$12,'System seed',$13) ON CONFLICT DO NOTHING`,
        [`doc_${p.id}_${i + 1}`, p.id, anchor ? anchor.guest_id : null, anchor ? anchor.id : null,
          s.name, s.category, s.source, s.sourceKey, s.status, s.visible, s.years, addYears(day, s.years), day]
      );
    }
  }

  const REVIEW_BODIES = [
    { r: 5, t: "Flawless from arrival to departure", b: "The team remembered my pillow preference and had sparkling water waiting. Check-in took under a minute. This is what a five-star hotel should feel like." },
    { r: 5, t: "A genuinely restorative stay", b: "The spa treatment was exceptional and the villa was completely private. Breakfast on the terrace is not to be missed." },
    { r: 4, t: "Beautiful property, small delay", b: "The suite was stunning and the butler team was attentive. Our room was ready 40 minutes late, but the team recovered well with a drinks credit." },
    { r: 5, t: "The best business hotel in Lagos", b: "Fast Wi-Fi, a proper desk, and the 14:00 checkout I asked for. The airport transfer was punctual and discreet." },
    { r: 3, t: "Lovely hotel, service inconsistent", b: "Dinner at Isla was excellent, but my in-room dining order arrived cold and the minibar was not restocked on the second day." },
    { r: 5, t: "Celebrated our anniversary here", b: "A handwritten card and macarons in the room. The team arranged a private dinner by the pool at short notice. Truly memorable." },
    { r: 4, t: "Excellent spa and gym", b: "The therapist was superb and the gym is well equipped. Only note: the pool was busier than expected on Saturday afternoon." },
    { r: 5, t: "Seamless group stay", b: "We booked eight rooms for a board meeting. Every folio was correct and the events team handled the room set-up perfectly." },
    { r: 5, t: "Quiet, elegant, discreet", b: "Exactly what I needed after a long flight. The Garden Villa is worth every naira." },
    { r: 4, t: "Great stay, improve the coffee", b: "Wonderful staff and a beautiful room. The in-room coffee could be better for this price point." },
  ];
  const CHANNELS = ["Google", "Post-stay survey", "TripAdvisor"];
  const REPLY = "Thank you for taking the time to write — we have shared this with the whole team. We look forward to welcoming you back.";
  const gmOf = Object.fromEntries(PROPERTIES.map((p) => [p.id, p.gm]));
  const { rows: leavers } = await client.query(
    `SELECT r.id, r.property_id, r.guest_id, r.check_in, r.check_out, g.name AS guest_name
       FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
      WHERE r.status = 'Checked out' ORDER BY r.id`);
  for (const [ix, r] of leavers.entries()) {
    const rb = REVIEW_BODIES[ix % REVIEW_BODIES.length];
    const responded = ix % 3 === 0;
    await client.query(
      `INSERT INTO reviews (id,property_id,guest_id,guest_name,reservation_id,channel,rating,title,body,
         stay_summary,responded,response,responded_by,responded_at,review_date)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
      [`rev_${ix}`, r.property_id, r.guest_id, r.guest_name || "Guest", r.id,
        CHANNELS[ix % CHANNELS.length], rb.r, rb.t, rb.b,
        `${biz.pretty(biz.dstr(r.check_in))} – ${biz.pretty(biz.dstr(r.check_out))}`,
        responded, responded ? REPLY : "", responded ? gmOf[r.property_id] || "Manager" : null,
        responded ? addDays(day, -1) + "T10:00:00.000Z" : null,
        addDays(day, -(ix + 1) * 3)]
    );
  }

  /* Lost property the house is holding, mirrored from the browser's seed
     (assets/data.js, "lost & found"): six items at the flagship, each linked to
     a guest profile so it can be returned without a search. The returned pair
     carry the day they went back, which is the courier line the card shows; the
     rest wait in the safe. "G02" and "Lobby" are places the register keeps
     without a room row, so only the numbered ones link to a room. */
  const LOST_SEED = [
    { item: "Gold hoop earring", room: "305", status: "Stored", days: 2, found: "Blessing Uche" },
    { item: "Apple iPad (space grey)", room: "412", status: "Returned", days: 6, found: "Samuel Nnamdi" },
    { item: "Child's stuffed rabbit", room: "208", status: "Stored", days: 1, found: "Tobi Ogunleye" },
    { item: "Prescription glasses, tortoiseshell", room: "G02", status: "Awaiting courier", days: 3, found: "Blessing Uche" },
    { item: "Navy cashmere scarf", room: "307", status: "Stored", days: 11, found: "Housekeeping" },
    { item: "Passport wallet (no documents)", room: "Lobby", status: "Returned", days: 14, found: "Security" },
  ];
  for (const [i, l] of LOST_SEED.entries()) {
    const { rows: room } = await client.query(
      `SELECT id FROM rooms WHERE property_id = 'agm' AND number = $1`, [l.room]);
    await client.query(
      `INSERT INTO lost_found
         (id,property_id,description,location,found_by,guest_id,room_id,status,note,found_date,claimed_at)
       VALUES ($1,'agm',$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING`,
      [`lf_${i}`, l.item, l.room, l.found, "gst_" + (i + 4), room[0] ? room[0].id : null, l.status,
        l.status === "Returned"
          ? "Courier tracking shared with guest."
          : "Logged and sealed in the housekeeping safe.",
        addDays(day, -l.days),
        l.status === "Returned" ? addDays(day, -(l.days - 1)) + "T10:00:00.000Z" : null]
    );
  }

  /* The keys the board leaves behind, read once from the whole board rather than
     stay by stay: a room is shut on a guest if someone is standing in it tonight,
     and it is for the floor to turn over if a guest left it this morning. Written
     stay by stay, a history booking from last month would stamp a room the front
     office is currently living in as dirty.
     Both moves only ever touch a room still standing Available, which is what
     keeps a reseed from walking over housekeeping's own board: the floor's dirty,
     cleaned and out-of-order states are theirs, not the seed's to rewind. */
  await client.query(
    `UPDATE rooms SET hk_status = 'Occupied'
     WHERE hk_status = 'Available' AND id IN
       (SELECT room_id FROM reservations WHERE status = 'In-house' AND check_in <= $1 AND check_out > $1)`,
    [day]
  );
  await client.query(
    `UPDATE rooms SET hk_status = 'Dirty'
     WHERE hk_status = 'Available' AND id IN
       (SELECT room_id FROM reservations WHERE status = 'Checked out' AND check_out = $1)`,
    [day]
  );

  /* ── the roster, the task board and the tray ──
     Read after the room pass above, because a task is filed against the room as
     the floor now stands: a stayover service belongs to the room a guest is in,
     a departure clean to one they have left. The three states are the browser's
     rotation, so the board has work waiting, work in hand and work signed off —
     a board whose cards all read Open has never shown the SLA clock at work. */
  const roster = [];
  for (const [pi, p] of PROPERTIES.entries()) {
    for (const [i, s] of STAFF_BASE.entries()) {
      if (pi > 0 && i > 6) continue;
      roster.push({
        id: `stf_${p.id}_${i}`, propertyId: p.id, name: s.name,
        email: pi === 0 ? s.email : s.email.replace("@", `+${p.id}@`),
        role: s.role, department: s.dept, title: s.title,
        phone: "+234 80" + String(41000000 + pi * 100000 + i * 7919).slice(0, 8),
        shift: s.shift, started: `202${i % 4}-0${(i % 9) + 1}-12`,
      });
    }
  }
  for (const s of roster) {
    await client.query(
      `INSERT INTO staff (id,property_id,name,email,title,role,department,shift,phone,status,started)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Active',$10) ON CONFLICT DO NOTHING`,
      [s.id, s.propertyId, s.name, s.email, s.title, s.role, s.department, s.shift, s.phone, s.started]
    );
  }

  const now = Date.now();
  const MIN = 60000;
  const { rows: roomRows } = await client.query(
    `SELECT id, property_id, number, hk_status, ooo_reason FROM rooms ORDER BY property_id, number`);
  const { rows: inHouse } = await client.query(
    `SELECT r.id, r.property_id, r.guest_id, r.room_id, g.name AS guest_name, rm.number AS room_number
       FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN rooms rm ON rm.id = r.room_id
      WHERE r.status = 'In-house' ORDER BY r.id`);
  const stayIn = {};
  for (const r of inHouse) if (r.room_id) stayIn[r.room_id] = r;

  let taskCount = 0;
  for (const [pi, p] of PROPERTIES.entries()) {
    const cleaners = CLEANERS[p.id];
    const rooms = roomRows
      .filter((r) => r.property_id === p.id
        && r.hk_status !== "Out of order" && r.hk_status !== "Out of service")
      .sort((a, b) => Number(a.number) - Number(b.number));
    for (const [ix, room] of rooms.slice(0, pi === 0 ? 9 : 5).entries()) {
      const occ = stayIn[room.id];
      const status = ix % 4 === 0 ? "Done" : ix % 3 === 0 ? "In progress" : "Open";
      const created = new Date(now - (ix + 1) * 23 * MIN);
      await client.query(
        `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,assigned_to,priority,
           status,source,sla_mins,due_at,resolved_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Housekeeping',90,$11,$12,$13) ON CONFLICT DO NOTHING`,
        [`tsk_${p.id}_hk${ix}`, p.id, occ ? "Housekeeping" : "Departure clean",
          occ ? `Stayover service — Room ${room.number}` : `Departure clean — Room ${room.number}`,
          occ ? "Refresh bed, bathroom, amenities and minibar."
              : "Full turnover before the next arrival. Check the pillow menu.",
          room.id, occ ? occ.guest_id : null, cleaners[ix % cleaners.length],
          ix % 5 === 0 ? "High" : ix % 3 === 0 ? "Low" : "Normal", status,
          new Date(now + (2 + ix) * 45 * MIN).toISOString(),
          status === "Done" ? new Date(now - 40 * MIN).toISOString() : null,
          created.toISOString()]
      );
      taskCount++;
    }
    const house = inHouse.filter((r) => r.property_id === p.id);
    if (!house.length) continue;
    for (const [ix, rq] of REQUEST_SEED.slice(0, pi === 0 ? 10 : 6).entries()) {
      const occ = house[(ix * 3 + 1) % house.length];
      const created = new Date(now - (ix * 37 + 12) * MIN);
      const status = ix === 4 ? "Done" : ix === 2 ? "In progress" : "Open";
      await client.query(
        `INSERT INTO tasks (id,property_id,type,title,detail,room_id,guest_id,assigned_to,priority,
           status,source,sla_mins,due_at,resolved_at,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT DO NOTHING`,
        [`tsk_${p.id}_rq${ix}`, p.id, rq.type,
          rq.title + (occ.room_number ? ` — Room ${occ.room_number}` : ""),
          `${rq.dept} request raised by ${occ.guest_name}. Confirm with the guest before closing.`,
          occ.room_id, occ.guest_id, status === "Open" ? null : cleaners[ix % cleaners.length],
          rq.pri, status, rq.dept, rq.mins,
          new Date(created.getTime() + rq.mins * MIN).toISOString(),
          status === "Done" ? new Date(created.getTime() + 55 * MIN).toISOString() : null,
          created.toISOString()]
      );
      taskCount++;
    }
  }

  /* The tray is the day's own: the arrival it announces is the one on the
     board, the SLA line counts the requests actually waiting, the maintenance
     line names a room the floor has grounded, and the review line the lowest
     score on file. A tray of sentences that disagree with the screens they
     link to is worse than an empty one. */
  const { rows: waiting } = await client.query(
    `SELECT title FROM tasks WHERE type = 'Guest request' AND status = 'Open' AND property_id = 'agm'
      ORDER BY due_at ASC`);
  const { rows: arrivals } = await client.query(
    `SELECT r.eta, r.guest_id, g.name AS guest_name, g.tier, rt.name AS type_name
       FROM reservations r LEFT JOIN guests g ON g.id = r.guest_id
       LEFT JOIN room_types rt ON rt.id = r.room_type_id
      WHERE r.property_id = 'agm' AND r.status = 'Confirmed' AND r.check_in = $1
      ORDER BY r.eta`, [day]);
  const grounded = roomRows.find((r) => r.property_id === "agm" && r.hk_status === "Out of order");
  const { rows: lowest } = await client.query(
    `SELECT * FROM reviews WHERE rating <= 3 ORDER BY review_date DESC`);
  const star = lowest[0] || null;

  const notes = [];
  if (arrivals[0]) {
    notes.push(["VIP arrival", `${arrivals[0].guest_name} arrives today at ${arrivals[0].eta}`,
      `${arrivals[0].tier} · ${arrivals[0].type_name} · welcome amenity confirmed`, "#/guests/" + arrivals[0].guest_id, 18, "agm"]);
  }
  if (waiting.length) {
    notes.push(["SLA at risk", `${waiting.length} guest request${waiting.length === 1 ? "" : "s"} approaching their response window`,
      `Oldest: ${waiting[0].title}`, "#/requests", 42, "agm"]);
  }
  if (grounded) {
    notes.push(["Maintenance", `Room ${grounded.number} out of service — ${grounded.ooo_reason || "maintenance"}`,
      "Engineering has the room grounded until the fault is cleared.", "#/room-map", 96, "agm"]);
  }
  if (star) {
    notes.push(["Review", `New ${star.rating}★ review needs a response`, `"${star.title}"`,
      "#/reviews", 300, star.property_id]);
  }
  notes.push(["Night audit", "End-of-day pack is ready for review",
    "The day's revenue, arrivals and cash-up are on the close.", "#/end-of-day", 540, "agm", true]);
  notes.push(["Channel manager", "Rate parity alert — Deluxe King",
    "Booking.com is selling 4% below the direct rate for the next weekend.", "#/revenue", 1560, "agm", true]);
  for (const [i, n] of notes.entries()) {
    const [type, title, detail, link, minsAgo, pid, read] = n;
    await client.query(
      `INSERT INTO notifications (id,property_id,type,title,detail,link,read,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING`,
      [`ntf_${i + 1}`, pid, type, title, detail, link, Boolean(read),
        new Date(now - minsAgo * MIN).toISOString()]
    );
  }

  return {
    day, expenses: expSeq, events: evtSeq, stays: staySeq, invoices: docSeq,
    documents: DOC_SAMPLES.length * propRows.length, reviews: leavers.length,
    staff: roster.length, tasks: taskCount, notifications: notes.length,
    laundry: laundrySeq,
  };
}

async function main() {
  if (!config.demoSeedAllowed()) {
    console.error("❌ Refusing to load the demonstration dataset into a production install.");
    console.error("   Run `npm run db:migrate` only, or set ALLOW_DEMO_SEED=true for a demo deployment.");
    process.exitCode = 1;
    return;
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const out = await seed(client);
    await client.query("COMMIT");
    console.log(`✅ Seed complete — business day ${out.day}, ${out.expenses} expense lines, ` +
      `${out.events} hall bookings, ${out.stays} stays on the board, ${out.invoices} invoices raised, ` +
      `${out.documents} documents on file, ${out.reviews} reviews, ${out.staff} staff, ` +
      `${out.tasks} tasks, ${out.notifications} notifications, ${out.laundry} laundry orders.`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("❌ Seed failed:", err.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) main();

module.exports = {
  seed, main, rolePermissions, PERMISSION_KEYS, FINANCE_DEFAULTS,
  // The board the seed writes, in the open: a test that wants to prove a stay
  // carries the money its quote said has to read the same list the seed walked.
  GUEST_SEED, STAY_SEED,
};
