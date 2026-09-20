// db.js — schema + connection using Node's built-in node:sqlite (no npm install needed)
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'spa_platform.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
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
  const spaCols = db.prepare("PRAGMA table_info(spas)").all().map((c) => c.name);
  if (!spaCols.includes('latitude')) {
    db.exec('ALTER TABLE spas ADD COLUMN latitude REAL');
  }
  if (!spaCols.includes('longitude')) {
    db.exec('ALTER TABLE spas ADD COLUMN longitude REAL');
  }
} catch (e) { /* ignore */ }

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
      'INSERT INTO users (name, email, phone, password_hash, password_salt, role) VALUES (?,?,?,?,?,?)'
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

  const adminId = mkUser('Platform Admin', 'admin@spabook.demo', 'admin123', 'admin', '9990000000');
  const owner1 = mkUser('Ravi Kumar', 'owner1@spabook.demo', 'owner123', 'owner', '9998887771');
  const owner2 = mkUser('Anjali Rao', 'owner2@spabook.demo', 'owner123', 'owner', '9998887772');
  const cust1 = mkUser('Priya Sharma', 'customer@spabook.demo', 'customer123', 'customer', '9998887773');

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

  console.log('Seed complete. Demo logins:');
  console.log('  admin@spabook.demo / admin123 (admin)');
  console.log('  owner1@spabook.demo / owner123 (spa owner - Hyderabad spas)');
  console.log('  owner2@spabook.demo / owner123 (spa owner - Bangalore spas)');
  console.log('  customer@spabook.demo / customer123 (customer)');
}

seed();

module.exports = { db, hashPassword, verifyPassword };
