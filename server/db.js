// db.js — schema + connection using Node's built-in node:sqlite (no npm install needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'spa_platform.db');

const db = new DatabaseSync(DB_PATH);
require('./backup').snapshotBeforeStart(db); // safety copy of the existing data BEFORE any update touches it
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('customer','owner','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  description TEXT,
  city TEXT NOT NULL,
  address TEXT,
  phone TEXT,
  latitude REAL,
  longitude REAL,
  opening_time TEXT NOT NULL DEFAULT '10:00',
  closing_time TEXT NOT NULL DEFAULT '20:00',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  rating REAL DEFAULT 4.5,
  cover_emoji TEXT DEFAULT '🧖',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS room_types (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  room_type_id INTEGER REFERENCES room_types(id),
  name TEXT NOT NULL,
  description TEXT,
  duration_minutes INTEGER NOT NULL DEFAULT 60,
  price REAL NOT NULL,
  discount_percent REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS spa_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  type TEXT NOT NULL CHECK(type IN ('image','video')),
  url TEXT NOT NULL,
  is_cover INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS coupons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  service_id INTEGER REFERENCES services(id),
  code TEXT NOT NULL,
  discount_type TEXT NOT NULL CHECK(discount_type IN ('percent','flat')),
  discount_value REAL NOT NULL,
  valid_from TEXT,
  valid_to TEXT,
  start_time TEXT,
  end_time TEXT,
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(spa_id, code)
);

CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES users(id),
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  service_id INTEGER NOT NULL REFERENCES services(id),
  booking_date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  amount REAL NOT NULL,
  coupon_code TEXT,
  coupon_discount REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending_payment' CHECK(status IN ('pending_payment','confirmed','cancelled','completed')),
  payment_status TEXT NOT NULL DEFAULT 'unpaid' CHECK(payment_status IN ('unpaid','paid','refunded')),
  payment_mode TEXT NOT NULL DEFAULT 'online' CHECK(payment_mode IN ('online','pay_at_venue')),
  notify_channel TEXT,
  notify_status TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  channel TEXT NOT NULL CHECK(channel IN ('email','sms','whatsapp')),
  recipient TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('sent','failed','mocked')),
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  code TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK(purpose IN ('registration','login')),
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS contact_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  subject TEXT,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','read','resolved')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL REFERENCES bookings(id),
  amount REAL NOT NULL,
  method TEXT NOT NULL,
  status TEXT NOT NULL,
  transaction_ref TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration guard: if this DB was created before newer columns existed, add them.
try {
  const serviceCols = db.prepare("PRAGMA table_info(services)").all().map((c) => c.name);
  if (!serviceCols.includes('discount_percent')) {
    db.exec('ALTER TABLE services ADD COLUMN discount_percent REAL NOT NULL DEFAULT 0');
  }
  if (!serviceCols.includes('room_type_id')) {
    db.exec('ALTER TABLE services ADD COLUMN room_type_id INTEGER REFERENCES room_types(id)');
  }
  const bookingCols = db.prepare("PRAGMA table_info(bookings)").all().map((c) => c.name);
  if (!bookingCols.includes('coupon_code')) {
    db.exec('ALTER TABLE bookings ADD COLUMN coupon_code TEXT');
  }
  if (!bookingCols.includes('coupon_discount')) {
    db.exec('ALTER TABLE bookings ADD COLUMN coupon_discount REAL NOT NULL DEFAULT 0');
  }
  if (!bookingCols.includes('notify_channel')) {
    db.exec('ALTER TABLE bookings ADD COLUMN notify_channel TEXT');
  }
  if (!bookingCols.includes('notify_status')) {
    db.exec('ALTER TABLE bookings ADD COLUMN notify_status TEXT');
  }
  if (!bookingCols.includes('payment_mode')) {
    db.exec("ALTER TABLE bookings ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'online'");
  }
  const spaCols = db.prepare("PRAGMA table_info(spas)").all().map((c) => c.name);
  if (!spaCols.includes('latitude')) {
    db.exec('ALTER TABLE spas ADD COLUMN latitude REAL');
  }
  if (!spaCols.includes('longitude')) {
    db.exec('ALTER TABLE spas ADD COLUMN longitude REAL');
  }
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('phone_verified')) {
    db.exec('ALTER TABLE users ADD COLUMN phone_verified INTEGER NOT NULL DEFAULT 0');
  }
  // Commission & settlement (see "Commission" in README)
  const spaCols2 = db.prepare("PRAGMA table_info(spas)").all().map((c) => c.name);
  if (!spaCols2.includes('commission_percent')) db.exec('ALTER TABLE spas ADD COLUMN commission_percent REAL'); // NULL = platform default
  if (!spaCols2.includes('allow_pay_at_venue')) db.exec('ALTER TABLE spas ADD COLUMN allow_pay_at_venue INTEGER NOT NULL DEFAULT 1');
  const bookingCols2 = db.prepare("PRAGMA table_info(bookings)").all().map((c) => c.name);
  if (!bookingCols2.includes('commission_percent')) db.exec('ALTER TABLE bookings ADD COLUMN commission_percent REAL NOT NULL DEFAULT 0');
  if (!bookingCols2.includes('commission_amount')) db.exec('ALTER TABLE bookings ADD COLUMN commission_amount REAL NOT NULL DEFAULT 0');
  if (!bookingCols2.includes('settlement_id')) db.exec('ALTER TABLE bookings ADD COLUMN settlement_id INTEGER');
  if (!bookingCols2.includes('cancel_reason')) db.exec('ALTER TABLE bookings ADD COLUMN cancel_reason TEXT');
} catch (e) { console.error('Migration error:', e.message); }

db.exec(`
CREATE TABLE IF NOT EXISTS settlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  direction TEXT NOT NULL CHECK(direction IN ('payout_to_spa','collected_from_spa','zero')),
  amount REAL NOT NULL,
  booking_count INTEGER NOT NULL,
  online_gross REAL NOT NULL DEFAULT 0,
  venue_gross REAL NOT NULL DEFAULT 0,
  commission_total REAL NOT NULL DEFAULT 0,
  reference TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Verified reviews: one per completed booking, only by the customer who visited.
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id),
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  customer_id INTEGER NOT NULL REFERENCES users(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  comment TEXT,
  owner_reply TEXT,
  owner_replied_at TEXT,
  hidden INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_spa ON reviews(spa_id);

-- Paid "Featured" placements, controlled by admin, for a date range.
CREATE TABLE IF NOT EXISTS featured_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spa_id INTEGER NOT NULL REFERENCES spas(id),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  reference TEXT,
  note TEXT,
  cancelled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

try {
  const cols = db.prepare("PRAGMA table_info(spas)").all().map((c) => c.name);
  if (!cols.includes('rating_avg')) db.exec('ALTER TABLE spas ADD COLUMN rating_avg REAL');
  if (!cols.includes('rating_count')) db.exec('ALTER TABLE spas ADD COLUMN rating_count INTEGER NOT NULL DEFAULT 0');
} catch (e) { console.error('Migration error:', e.message); }

// Spa ratings come ONLY from visible, verified reviews (the old demo star values are ignored).
function recomputeSpaRating(spaId) {
  const r = db.prepare('SELECT AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE spa_id = ? AND hidden = 0').get(spaId);
  db.prepare('UPDATE spas SET rating_avg = ?, rating_count = ? WHERE id = ?').run(r.n ? r.avg : null, r.n || 0, spaId);
}

// OTP login requires looking a user up by phone, so phone numbers need to be
// unique. This is best-effort: if an existing deployment already has
// duplicate phone numbers on file, this silently fails rather than crashing
// the app — OTP login just won't work reliably until those are cleaned up.
try {
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique ON users(phone) WHERE phone IS NOT NULL');
} catch (e) {
  console.warn('Could not enforce unique phone numbers (likely duplicate phones already on file). OTP login may be unreliable until resolved.');
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

function verifyPassword(password, salt, hash) {
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(check), Buffer.from(hash));
}

// ---- Seed data (only runs once, if DB is empty) ----
function seed() {
  const userCount = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (userCount > 0) return;

  const mkUser = (name, email, password, role, phone) => {
    const { hash, salt } = hashPassword(password);
    const info = db.prepare(
      'INSERT INTO users (name, email, phone, phone_verified, password_hash, password_salt, role) VALUES (?,?,?,1,?,?,?)'
    ).run(name, email, phone, hash, salt, role);
    return Number(info.lastInsertRowid);
  };

  // In production, never auto-create the demo accounts below — their
  // passwords are published in this repo's README, so shipping them to a
  // real deployment would hand out a working admin login to anyone who reads
  // it. Instead, bootstrap exactly one real admin from environment variables.
  if (process.env.NODE_ENV === 'production') {
    if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
      mkUser('Admin', process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD, 'admin', process.env.ADMIN_PHONE || null);
      console.log(`Production admin account created: ${process.env.ADMIN_EMAIL}`);
    } else {
      console.warn(
        '\nWARNING: NODE_ENV=production but no ADMIN_EMAIL/ADMIN_PASSWORD set.\n' +
        'No admin account was created — set these environment variables and restart,\n' +
        'or register normally and promote a user to admin directly in the database.\n'
      );
    }
    return; // no demo spas, services, or bookings in production
  }

  seedDemoData(mkUser);
}

function seedDemoData(mkUser) {
  console.log('Seeding database with demo data...');

  const adminId = mkUser('Platform Admin', 'admin@bookmyspa.demo', 'admin123', 'admin', '9990000000');
  const owner1 = mkUser('Ravi Kumar', 'owner1@bookmyspa.demo', 'owner123', 'owner', '9998887771');
  const owner2 = mkUser('Anjali Rao', 'owner2@bookmyspa.demo', 'owner123', 'owner', '9998887772');
  const cust1 = mkUser('Priya Sharma', 'customer@bookmyspa.demo', 'customer123', 'customer', '9998887773');

  const mkSpa = (ownerId, name, desc, city, address, emoji, status = 'approved', lat = null, lng = null) => {
    const info = db.prepare(
      `INSERT INTO spas (owner_id, name, description, city, address, phone, opening_time, closing_time, status, rating, cover_emoji, latitude, longitude)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(ownerId, name, desc, city, address, '9876543210', '10:00', '21:00', status, 4.2 + Math.random() * 0.7, emoji, lat, lng);
    return Number(info.lastInsertRowid);
  };

  const spa1 = mkSpa(owner1, 'Serene Bliss Spa', 'A calm retreat in the heart of the city offering therapeutic massages and skin treatments.', 'Hyderabad', 'Banjara Hills, Hyderabad', '🌿', 'approved', 17.4156, 78.4347);
  const spa2 = mkSpa(owner1, 'Urban Unwind', 'Modern wellness studio focused on deep tissue and sports recovery therapy.', 'Hyderabad', 'Jubilee Hills, Hyderabad', '💆', 'approved', 17.4326, 78.4071);
  const spa3 = mkSpa(owner2, 'Lotus Wellness Lounge', 'Traditional Ayurvedic spa with organic oils and heritage techniques.', 'Bangalore', 'Indiranagar, Bangalore', '🪷', 'approved', 12.9716, 77.6412);
  const spa4 = mkSpa(owner2, 'Zenith Day Spa', 'Full-service day spa: facials, massages, and couple therapy rooms.', 'Bangalore', 'Koramangala, Bangalore', '✨', 'pending', 12.9352, 77.6146);

  const mkService = (spaId, name, desc, duration, price) => {
    db.prepare('INSERT INTO services (spa_id, name, description, duration_minutes, price) VALUES (?,?,?,?,?)')
      .run(spaId, name, desc, duration, price);
  };

  const mkServiceD = (spaId, name, desc, duration, price, discount, roomTypeId = null) => {
    const info = db.prepare('INSERT INTO services (spa_id, name, description, duration_minutes, price, discount_percent, room_type_id) VALUES (?,?,?,?,?,?,?)')
      .run(spaId, name, desc, duration, price, discount, roomTypeId);
    return Number(info.lastInsertRowid);
  };

  const mkRoomType = (spaId, name, capacity) => {
    const info = db.prepare('INSERT INTO room_types (spa_id, name, capacity) VALUES (?,?,?)').run(spaId, name, capacity);
    return Number(info.lastInsertRowid);
  };

  // Serene Bliss Spa: 2 Jacuzzi rooms + 3 general therapy rooms (mirrors a typical real spa's layout)
  const jacuzziRoom = mkRoomType(spa1, 'Jacuzzi Room', 2);
  const therapyRoom = mkRoomType(spa1, 'Therapy Room', 3);

  mkServiceD(spa1, 'Swedish Full Body Massage', 'Relaxing full-body massage to relieve tension.', 60, 1899, 15, therapyRoom);
  const deepTissueId = db.prepare(
    'INSERT INTO services (spa_id, room_type_id, name, description, duration_minutes, price) VALUES (?,?,?,?,?,?)'
  ).run(spa1, therapyRoom, 'Deep Tissue Massage', 'Targeted pressure for chronic muscle tension.', 90, 2599).lastInsertRowid;
  db.prepare('INSERT INTO services (spa_id, room_type_id, name, description, duration_minutes, price) VALUES (?,?,?,?,?,?)')
    .run(spa1, null, 'Signature Facial', 'Brightening facial with organic ingredients.', 45, 1499);
  db.prepare('INSERT INTO services (spa_id, room_type_id, name, description, duration_minutes, price) VALUES (?,?,?,?,?,?)')
    .run(spa1, jacuzziRoom, 'Private Jacuzzi Soak', 'A relaxing 45-minute private jacuzzi session for two.', 45, 2999);

  // A demo coupon: 20% off, valid on weekends only via date range, capped at 50 uses
  db.prepare(
    `INSERT INTO coupons (spa_id, code, discount_type, discount_value, max_uses) VALUES (?,?,?,?,?)`
  ).run(spa1, 'WELCOME20', 'percent', 20, 50);
  db.prepare(
    `INSERT INTO coupons (spa_id, code, discount_type, discount_value, start_time, end_time) VALUES (?,?,?,?,?,?)`
  ).run(spa1, 'MORNING300', 'flat', 300, '10:00', '13:00');

  mkServiceD(spa2, 'Sports Recovery Massage', 'Post-workout recovery massage for athletes.', 60, 2199, 10);
  mkService(spa2, 'Hot Stone Therapy', 'Heated basalt stones to melt away stress.', 75, 2799);

  mkService(spa3, 'Abhyanga Ayurvedic Massage', 'Traditional warm-oil Ayurvedic massage.', 60, 1799);
  mkService(spa3, 'Shirodhara', 'Continuous warm oil poured over the forehead.', 45, 2299);

  mkService(spa4, 'Couples Massage', 'Side-by-side relaxation for two.', 60, 3999);

  // Demo reviews attached to real past, completed demo bookings (development data only).
  const pastDate = (d) => new Date(Date.now() + 330 * 60000 - d * 86400000).toISOString().slice(0, 10);
  const demoReviews = [
    [spa1, 1, 1614, 5, 'Very relaxing Swedish massage. The therapist was professional and the room was spotless.', 12],
    [spa1, 3, 1499, 4, 'Good facial and my skin felt fresh, but I waited about 10 minutes past my slot.', 20],
    [spa2, 5, 1979, 5, 'Best sports massage around Jubilee Hills. It really sorted out my shoulder.', 8],
    [spa3, 7, 1799, 4, 'Authentic Abhyanga with lovely warm oils. Parking nearby is tricky.', 15],
  ];
  for (const [spaId, serviceId, amount, rating, comment, daysAgo] of demoReviews) {
    const b = db.prepare(`INSERT INTO bookings (customer_id, spa_id, service_id, booking_date, start_time, end_time, amount, status, payment_status, payment_mode, commission_percent, commission_amount)
      VALUES (?,?,?,?,'11:00','12:00',?,'completed','paid','pay_at_venue',10,?)`).run(cust1, spaId, serviceId, pastDate(daysAgo), amount, Math.round(amount * 10) / 100);
    db.prepare('INSERT INTO reviews (booking_id, spa_id, customer_id, rating, comment) VALUES (?,?,?,?,?)').run(Number(b.lastInsertRowid), spaId, cust1, rating, comment);
  }
  [spa1, spa2, spa3, spa4].forEach(recomputeSpaRating);
  // Demo featured placement so the homepage shows how Featured looks
  db.prepare('INSERT INTO featured_placements (spa_id, starts_on, ends_on, amount, reference, note) VALUES (?,?,?,?,?,?)')
    .run(spa3, pastDate(3), pastDate(-27), 2999, 'DEMO', 'Demo 30-day placement');

  // Demo therapists and a package (development data only)
  const svc = (n) => db.prepare('SELECT id FROM services WHERE spa_id = ? AND name = ?').get(spa1, n).id;
  const mkTherapist = (name, gender, bio, services) => {
    const t = Number(db.prepare('INSERT INTO therapists (spa_id, name, gender, bio) VALUES (?,?,?,?)').run(spa1, name, gender, bio).lastInsertRowid);
    for (const s of services) db.prepare('INSERT INTO therapist_services (therapist_id, service_id) VALUES (?,?)').run(t, svc(s));
  };
  mkTherapist('Meera', 'female', '8 years · Swedish and deep tissue', ['Swedish Full Body Massage', 'Deep Tissue Massage', 'Signature Facial']);
  mkTherapist('Anita', 'female', 'Facial and relaxation specialist', ['Swedish Full Body Massage', 'Signature Facial']);
  mkTherapist('Rahul', 'male', 'Sports and deep tissue therapist', ['Swedish Full Body Massage', 'Deep Tissue Massage']);
  db.prepare('INSERT INTO packages (spa_id, service_id, name, sessions, price, validity_days) VALUES (?,?,?,?,?,?)')
    .run(spa1, svc('Swedish Full Body Massage'), '5 Swedish massages', 5, 7499, 180);

  console.log('Seed complete. Demo logins:');
  console.log('  admin@bookmyspa.demo / admin123 (admin)');
  console.log('  owner1@bookmyspa.demo / owner123 (spa owner - Hyderabad spas)');
  console.log('  owner2@bookmyspa.demo / owner123 (spa owner - Bangalore spas)');
  console.log('  customer@bookmyspa.demo / customer123 (customer)');
}

// ---- Additive migrations (never drop or rewrite existing data) ----
try {
  const bcols = db.prepare("PRAGMA table_info(bookings)").all().map((c) => c.name);
  if (!bcols.includes('booking_ref')) db.exec('ALTER TABLE bookings ADD COLUMN booking_ref TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_bookings_ref ON bookings(booking_ref) WHERE booking_ref IS NOT NULL');
  const ucols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!ucols.includes('password_changed_at')) db.exec('ALTER TABLE users ADD COLUMN password_changed_at TEXT');
} catch (e) { console.error('Migration error:', e.message); }

// Human-friendly booking/order ID, e.g. BMS-260926-K7QX (date in IST + 4 unambiguous characters).
const REF_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function generateBookingRef(createdAt) {
  const t = createdAt ? Date.parse(String(createdAt).replace(' ', 'T') + 'Z') : Date.now();
  const d = new Date((isNaN(t) ? Date.now() : t) + 330 * 60000).toISOString().slice(2, 10).replace(/-/g, '');
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let k = 0; k < 4; k++) code += REF_CHARS[crypto.randomInt(REF_CHARS.length)];
    const ref = `BMS-${d}-${code}`;
    if (!db.prepare('SELECT 1 FROM bookings WHERE booking_ref = ?').get(ref)) return ref;
  }
  return `BMS-${d}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
}
function assignBookingRef(bookingId) {
  const b = db.prepare('SELECT booking_ref, created_at FROM bookings WHERE id = ?').get(bookingId);
  if (!b || b.booking_ref) return b && b.booking_ref;
  const ref = generateBookingRef(b.created_at);
  db.prepare('UPDATE bookings SET booking_ref = ? WHERE id = ?').run(ref, bookingId);
  return ref;
}
function backfillBookingRefs() {
  const rows = db.prepare('SELECT id FROM bookings WHERE booking_ref IS NULL').all();
  for (const r of rows) assignBookingRef(r.id);
  if (rows.length) console.log(`Assigned booking IDs to ${rows.length} existing booking(s).`);
}

// ---- Phase-1 operations features (additive only) ----
try {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  if (!has('users', 'active')) db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
  if (!has('spas', 'weekly_off')) db.exec("ALTER TABLE spas ADD COLUMN weekly_off TEXT NOT NULL DEFAULT ''");
  if (!has('spas', 'cancel_window_hours')) db.exec('ALTER TABLE spas ADD COLUMN cancel_window_hours INTEGER NOT NULL DEFAULT 4');
  if (!has('spas', 'suspended')) db.exec('ALTER TABLE spas ADD COLUMN suspended INTEGER NOT NULL DEFAULT 0');
  if (!has('bookings', 'rescheduled_count')) db.exec('ALTER TABLE bookings ADD COLUMN rescheduled_count INTEGER NOT NULL DEFAULT 0');
  if (!has('bookings', 'reminder_sent')) db.exec('ALTER TABLE bookings ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0');
  db.exec(`
    CREATE TABLE IF NOT EXISTS spa_closures (
      id INTEGER PRIMARY KEY AUTOINCREMENT, spa_id INTEGER NOT NULL REFERENCES spas(id),
      date TEXT NOT NULL, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(spa_id, date));
    CREATE TABLE IF NOT EXISTS slot_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, spa_id INTEGER NOT NULL REFERENCES spas(id),
      room_type_id INTEGER REFERENCES room_types(id), date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL,
      qty INTEGER NOT NULL DEFAULT 1, reason TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE INDEX IF NOT EXISTS idx_blocks_spa_date ON slot_blocks(spa_id, date);
  `);
} catch (e) { console.error('Migration error:', e.message); }

// ---- Phase-2: therapists, GST invoices, gift cards & packages, Razorpay Route (additive only) ----
try {
  const has = (t, c) => db.prepare(`PRAGMA table_info(${t})`).all().some((x) => x.name === c);
  db.exec(`
    CREATE TABLE IF NOT EXISTS therapists (
      id INTEGER PRIMARY KEY AUTOINCREMENT, spa_id INTEGER NOT NULL REFERENCES spas(id), name TEXT NOT NULL,
      gender TEXT NOT NULL CHECK(gender IN ('female','male','other')), bio TEXT, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS therapist_services (
      therapist_id INTEGER NOT NULL REFERENCES therapists(id), service_id INTEGER NOT NULL REFERENCES services(id),
      PRIMARY KEY (therapist_id, service_id));
    CREATE TABLE IF NOT EXISTS invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL CHECK(kind IN ('customer','commission')),
      spa_id INTEGER, booking_id INTEGER, settlement_id INTEGER, invoice_no TEXT NOT NULL UNIQUE,
      series TEXT NOT NULL, fy TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
      issued_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_booking ON invoices(booking_id) WHERE booking_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inv_settlement ON invoices(settlement_id) WHERE settlement_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS gift_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, amount REAL NOT NULL, balance REAL NOT NULL,
      purchaser_id INTEGER NOT NULL REFERENCES users(id), recipient_name TEXT, message TEXT,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','void')), expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS gift_card_uses (
      id INTEGER PRIMARY KEY AUTOINCREMENT, gift_card_id INTEGER NOT NULL REFERENCES gift_cards(id), booking_id INTEGER,
      amount REAL NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('redeem','restore')), created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, spa_id INTEGER NOT NULL REFERENCES spas(id), service_id INTEGER NOT NULL REFERENCES services(id),
      name TEXT NOT NULL, sessions INTEGER NOT NULL, price REAL NOT NULL, validity_days INTEGER NOT NULL DEFAULT 180,
      active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS customer_packages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, package_id INTEGER NOT NULL REFERENCES packages(id), customer_id INTEGER NOT NULL REFERENCES users(id),
      spa_id INTEGER NOT NULL, service_id INTEGER NOT NULL, name TEXT NOT NULL, sessions_total INTEGER NOT NULL,
      sessions_used INTEGER NOT NULL DEFAULT 0, per_session_value REAL NOT NULL, price_paid REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','void')), expires_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT, customer_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('giftcard','package')), ref_id INTEGER NOT NULL, amount REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','failed')), payment_ref TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')));
  `);
  for (const [t, c, def] of [
    ['bookings', 'therapist_id', 'INTEGER'], ['bookings', 'therapist_choice', 'TEXT'],
    ['bookings', 'giftcard_amount', 'REAL NOT NULL DEFAULT 0'], ['bookings', 'gift_card_id', 'INTEGER'],
    ['bookings', 'customer_package_id', 'INTEGER'], ['bookings', 'route_transfer', 'INTEGER NOT NULL DEFAULT 0'],
    ['spas', 'legal_name', 'TEXT'], ['spas', 'gstin', 'TEXT'], ['spas', 'gst_rate', 'REAL NOT NULL DEFAULT 18'],
    ['spas', 'razorpay_account_id', 'TEXT'],
  ]) if (!has(t, c)) db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} ${def}`);
} catch (e) { console.error('Migration error:', e.message); }

seed();
backfillBookingRefs();

// ---- Admin password recovery ----
// Set ADMIN_PASSWORD_RESET=<new password> (with ADMIN_EMAIL) in Railway and redeploy to
// reset the admin password. Remove the variable afterwards.
if (process.env.ADMIN_PASSWORD_RESET && process.env.ADMIN_EMAIL) {
  const admin = db.prepare("SELECT id FROM users WHERE lower(email) = lower(?) AND role = 'admin'").get(process.env.ADMIN_EMAIL);
  if (!admin) console.warn('ADMIN_PASSWORD_RESET is set but no admin account matches ADMIN_EMAIL.');
  else if (String(process.env.ADMIN_PASSWORD_RESET).length < 8) console.warn('ADMIN_PASSWORD_RESET must be at least 8 characters — not applied.');
  else {
    const { hash, salt } = hashPassword(process.env.ADMIN_PASSWORD_RESET);
    db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = datetime('now') WHERE id = ?").run(hash, salt, admin.id);
    console.warn('\n*** Admin password was reset from ADMIN_PASSWORD_RESET. REMOVE that variable from Railway now. ***\n');
  }
}

module.exports = { db, hashPassword, verifyPassword, recomputeSpaRating, assignBookingRef };
