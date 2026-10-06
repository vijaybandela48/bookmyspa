const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, hashPassword, verifyPassword, recomputeSpaRating, assignBookingRef } = require('./db');
const os = require('node:os');
const backupMod = require('./backup');
const { sign, requireAuth, sendJSON } = require('./auth');
const gateway = require('./payments/gateway');
const notifier = require('./notifications/notifier');
const { checkRateLimit, checkRateLimitByKey } = require('./rateLimit');

const UPLOADS_DIR = path.join(__dirname, '..', 'data', 'uploads', 'spas');
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024; // 20MB raw body cap (covers ~15MB file as base64)

// Fields that must reach the server byte-for-byte (secrets, signatures, file data).
const RAW_FIELDS = new Set(['password', 'dataUrl', 'signature', 'otpCode', 'code', 'orderId', 'paymentId']);

// Neutralizes HTML-significant characters in every user-supplied string before
// it's stored. The frontend renders stored text into HTML, so without this a
// spa name or contact message containing <script>/<img onerror> would execute
// in other users' browsers — including the admin panel (stored XSS).
function sanitizeInput(value, key) {
  if (typeof value === 'string') {
    if (RAW_FIELDS.has(key)) return value;
    return value.replace(/[<>`]/g, '').replace(/"/g, '\u201D').replace(/'/g, '\u2019').trim();
  }
  if (Array.isArray(value)) return value.map((v) => sanitizeInput(v, key));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeInput(value[k], k);
    return out;
  }
  return value;
}

const MAX_JSON_BYTES = 1024 * 1024; // 1MB — uploads use their own larger limit

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return;
      data += chunk;
      if (data.length > MAX_JSON_BYTES) { tooBig = true; reject(new Error('Request body too large.')); req.destroy(); }
    });
    req.on('end', () => {
      if (tooBig) return;
      if (!data) return resolve({});
      try {
        resolve(sanitizeInput(JSON.parse(data)));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Returns the raw request body as a string, unparsed — needed for webhook
// signature verification, where the exact bytes matter.
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Like parseBody, but enforces a byte-size cap and destroys the connection if exceeded
// (used for media uploads, since a raw JSON parse of a huge base64 body is wasteful otherwise).
function parseBodyWithLimit(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        tooBig = true;
        req.destroy();
        reject(Object.assign(new Error('File is too large. Please keep uploads under 15MB.'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (tooBig) return;
      const data = Buffer.concat(chunks).toString('utf8');
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
};

function saveDataUrlToFile(spaId, dataUrl) {
  const match = /^data:([^;]+);base64,(.+)$/.exec(dataUrl);
  if (!match) throw Object.assign(new Error('Invalid file data.'), { status: 400 });
  const mime = match[1];
  const ext = MIME_TO_EXT[mime];
  if (!ext) throw Object.assign(new Error('Unsupported file type. Use JPG, PNG, WEBP, GIF, MP4, WEBM or MOV.'), { status: 400 });
  const buffer = Buffer.from(match[2], 'base64');
  if (buffer.length > 15 * 1024 * 1024) throw Object.assign(new Error('File is too large. Please keep uploads under 15MB.'), { status: 413 });

  const dir = path.join(UPLOADS_DIR, String(spaId));
  fs.mkdirSync(dir, { recursive: true });
  const filename = crypto.randomBytes(10).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(dir, filename), buffer);

  return {
    url: `/uploads/spas/${spaId}/${filename}`,
    type: mime.startsWith('video/') ? 'video' : 'image',
  };
}

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email, phone: u.phone, phone_verified: !!u.phone_verified, role: u.role };
}

function publicSpa(s) {
  const cover = db.prepare("SELECT url FROM spa_media WHERE spa_id = ? AND is_cover = 1 AND type='image' LIMIT 1").get(s.id);
  return {
    id: s.id, name: s.name, description: s.description, city: s.city, address: s.address,
    phone: s.phone, opening_time: s.opening_time, closing_time: s.closing_time,
    status: s.status, rating: s.rating_count ? Math.round(s.rating_avg * 10) / 10 : null, review_count: s.rating_count || 0, cover_emoji: s.cover_emoji,
    cover_image_url: cover ? cover.url : null,
    latitude: s.latitude, longitude: s.longitude,
    allow_pay_at_venue: s.allow_pay_at_venue !== 0,
    weekly_off: s.weekly_off || '', cancel_window_hours: s.cancel_window_hours ?? 4,
    legal_name: s.legal_name || null, gstin: s.gstin || null, gst_rate: s.gst_rate ?? 18,
    ...featuredInfo(s.id),
    owner_id: s.owner_id,
  };
}

// Haversine formula — great-circle distance between two lat/lng points, in km
function distanceKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function withDiscount(sv) {
  const pct = sv.discount_percent || 0;
  const finalPrice = pct > 0 ? Math.round(sv.price * (1 - pct / 100)) : sv.price;
  return { ...sv, final_price: finalPrice };
}

// Cancel stale pending-payment bookings older than 10 minutes so slots free up
function cleanupStaleBookings() {
  const stale = db.prepare(`SELECT * FROM bookings WHERE status='pending_payment' AND created_at < datetime('now','-10 minutes')`).all();
  for (const b of stale) {
    const r = db.prepare("UPDATE bookings SET status='cancelled', cancel_reason='payment_timeout' WHERE id = ? AND status='pending_payment'").run(b.id);
    if (r.changes && b.gift_card_id && b.giftcard_amount > 0) restoreGift(b);
  }
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(m) {
  const h = Math.floor(m / 60).toString().padStart(2, '0');
  const mm = (m % 60).toString().padStart(2, '0');
  return `${h}:${mm}`;
}

// Spa hours and slots are in the business's local time (default IST, UTC+5:30),
// NOT the server's clock — Railway servers run on UTC, which previously made
// already-passed slots bookable for 5.5 hours every morning.
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 330);
function localNow() {
  const d = new Date(Date.now() + TZ_OFFSET_MINUTES * 60000);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}
const MAX_ADVANCE_DAYS = 60;
function validateBookingDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(Date.parse(date + 'T00:00:00Z'))) return 'Invalid date.';
  const today = localNow().date;
  if (date < today) return "You can't book a date in the past.";
  const max = new Date(Date.parse(today + 'T00:00:00Z') + MAX_ADVANCE_DAYS * 86400000).toISOString().slice(0, 10);
  if (date > max) return `Bookings can only be made up to ${MAX_ADVANCE_DAYS} days in advance.`;
  return null;
}

const isProduction = process.env.NODE_ENV === 'production';
// Mock payments are for development only. In production without real
// Razorpay keys, online payment is switched off entirely (pay-at-spa still
// works) — otherwise anyone could "pay" with the mock gateway for free.
function onlinePaymentsAvailable() { return gateway.isLive || !isProduction; }
// Same idea for OTP: without a real SMS provider in production, a "verification"
// code shown on screen verifies nothing, so OTP is disabled rather than faked.
function otpAvailable() { return notifier.isSmsConfigured || !isProduction; }

// Each website only accepts its own kind of account: customers on the main
// site, spa owners on the partner portal, admins on the admin console.
const PORTAL_ROLE = { customer: 'customer', partner: 'owner', admin: 'admin' };
function checkPortal(user, portal) {
  const expected = PORTAL_ROLE[portal] || 'customer';
  if (user.role === expected) return null;
  if (user.role === 'owner') return 'This is a spa partner account. Please log in on the BookMySpa Partner portal.';
  if (user.role === 'customer') return 'This is a customer account. Please log in on the main BookMySpa website.';
  return 'Invalid email or password.'; // never reveal that an admin account exists
}

// ---------------- FEATURED & RATINGS ----------------
function featuredInfo(spaId) {
  const today = localNow().date;
  const r = db.prepare(`SELECT MAX(ends_on) AS until FROM featured_placements WHERE spa_id = ? AND cancelled = 0 AND starts_on <= ? AND ends_on >= ?`).get(spaId, today, today);
  return { featured: !!(r && r.until), featured_until: (r && r.until) || null };
}
// "Top rated" uses a Bayesian average so one 5★ review can't outrank fifty 4.8★ reviews.
const PRIOR_MEAN = 4.0, PRIOR_WEIGHT = 3;
function ratingScore(sp) { return (PRIOR_MEAN * PRIOR_WEIGHT + (sp.rating || 0) * sp.review_count) / (PRIOR_WEIGHT + sp.review_count); }
function reviewEligible(b) {
  const today = localNow().date;
  const happened = b.status === 'completed' || (b.status === 'confirmed' && b.booking_date < today);
  const paidOk = b.payment_mode === 'pay_at_venue' || b.payment_status === 'paid';
  const minDate = new Date(Date.parse(today + 'T00:00:00Z') - 60 * 86400000).toISOString().slice(0, 10);
  return happened && paidOk && b.booking_date >= minDate;
}
function isValidDate(d) { return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')); }

// ---------------- COMMISSION ----------------
// Platform commission is a % of what the customer actually pays (after
// discounts/coupons). The rate is snapshotted onto each booking when it's made,
// so changing a spa's rate later never rewrites past bookings.
const DEFAULT_COMMISSION = Math.min(50, Math.max(0, Number(process.env.COMMISSION_PERCENT || 10)));
const round2 = (x) => Math.round(x * 100) / 100;
function commissionRateFor(spa) {
  return spa.commission_percent !== null && spa.commission_percent !== undefined ? spa.commission_percent : DEFAULT_COMMISSION;
}
function applyCommission(bookingId, spa, amount) {
  const rate = commissionRateFor(spa);
  db.prepare('UPDATE bookings SET commission_percent = ?, commission_amount = ? WHERE id = ?').run(rate, round2((amount * rate) / 100), bookingId);
}

// What's owed between the platform and one spa, over all not-yet-settled
// bookings whose appointment has happened (or the owner marked completed):
//  - ONLINE bookings: the platform holds the customer's money -> owes the spa (amount - commission)
//  - PAY-AT-SPA bookings: the spa holds the money -> owes the platform its commission.
//    This accrues once the appointment date passes, whether or not the owner
//    clicks "Mark as paid" (otherwise skipping that click would dodge commission).
//    Genuine no-shows are marked by the owner and carry no commission.
// Net > 0: platform pays the spa. Net < 0: spa pays the platform.
function settlementSummary(spaId) {
  const today = localNow().date;
  const rows = db.prepare(
    `SELECT id, amount, commission_amount, payment_mode, giftcard_amount FROM bookings
     WHERE spa_id = ? AND settlement_id IS NULL AND route_transfer = 0
       AND (status = 'completed' OR (status = 'confirmed' AND booking_date < ?))
       AND (payment_mode = 'pay_at_venue' OR payment_status = 'paid')`
  ).all(spaId, today);
  const s = { bookingIds: rows.map((r) => r.id), count: rows.length, onlineGross: 0, onlineCommission: 0, venueGross: 0, venueCommission: 0 };
  for (const r of rows) {
    // onlineGross = money BookMySpa holds (online payments, gift cards, prepaid packages); venueGross = money the spa took at the counter
    if (r.payment_mode === 'online') { s.onlineGross += r.amount; s.onlineCommission += r.commission_amount; }
    else { s.onlineGross += r.giftcard_amount || 0; s.venueGross += r.amount - (r.giftcard_amount || 0); s.venueCommission += r.commission_amount; }
  }
  for (const k of ['onlineGross', 'onlineCommission', 'venueGross', 'venueCommission']) s[k] = round2(s[k]);
  s.commissionTotal = round2(s.onlineCommission + s.venueCommission);
  s.netToSpa = round2(s.onlineGross - s.onlineCommission - s.venueCommission);
  return s;
}
function noShowStats(spaId) {
  const r = db.prepare(
    `SELECT SUM(CASE WHEN cancel_reason = 'no_show' THEN 1 ELSE 0 END) AS noShows, COUNT(*) AS total
     FROM bookings WHERE spa_id = ? AND payment_mode = 'pay_at_venue' AND status IN ('confirmed','completed','cancelled')
       AND booking_date >= date('now','-90 days')`
  ).get(spaId);
  const total = r.total || 0, noShows = r.noShows || 0;
  return { noShows, total, rate: total ? Math.round((noShows / total) * 100) : 0 };
}

// Extracts coordinates from a Google Maps link or a pasted "lat, lng".
function parseCoords(text) {
  let s = String(text || '');
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  const pats = [/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/, /[?&](?:q|query|ll|destination|center)=(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)/, /@(-?\d+\.\d+),(-?\d+\.\d+)/, /^\s*(-?\d{1,2}\.\d+)\s*,\s*(-?\d{1,3}\.\d+)\s*$/];
  for (const p of pats) {
    const m = s.match(p);
    if (m) {
      const lat = Number(m[1]), lng = Number(m[2]);
      if (lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) return { lat, lng };
    }
  }
  return null;
}
const MAP_HOSTS = /^(maps\.app\.goo\.gl|goo\.gl|g\.co|maps\.google\.[a-z.]+|(www\.)?google\.[a-z.]+)$/i;

// ---------------- THERAPISTS ----------------
function therapistsForService(serviceId) {
  return db.prepare(`SELECT t.* FROM therapists t JOIN therapist_services ts ON ts.therapist_id = t.id
                     WHERE ts.service_id = ? AND t.active = 1 ORDER BY t.name`).all(serviceId);
}
function eligibleTherapists(serviceId, opts = {}) {
  let list = therapistsForService(serviceId);
  if (opts.therapistId) list = list.filter((t) => t.id === Number(opts.therapistId));
  else if (opts.gender === 'female' || opts.gender === 'male') list = list.filter((t) => t.gender === opts.gender);
  return list;
}
function therapistBookings(spaId, date, excludeId = -1) {
  return db.prepare(`SELECT therapist_id, start_time, end_time FROM bookings WHERE spa_id = ? AND booking_date = ?
                     AND therapist_id IS NOT NULL AND status IN ('pending_payment','confirmed') AND id != ?`).all(spaId, date, excludeId);
}
// Picks a free matching therapist, spreading work evenly (fewest bookings that day first).
function pickTherapist(spaId, serviceId, date, st, et, opts = {}, excludeId = -1) {
  const s0 = timeToMinutes(st), e0 = timeToMinutes(et);
  const tb = therapistBookings(spaId, date, excludeId);
  const free = eligibleTherapists(serviceId, opts).filter((t) => !tb.some((b) => b.therapist_id === t.id && s0 < timeToMinutes(b.end_time) && e0 > timeToMinutes(b.start_time)));
  const load = (id) => tb.filter((b) => b.therapist_id === id).length;
  return free.sort((a, b) => load(a.id) - load(b.id))[0] || null;
}
function therapistOpts(src) {
  return { therapistId: src.therapistId ? Number(src.therapistId) : null, gender: ['female', 'male'].includes(src.gender) ? src.gender : null };
}

// ---------------- GIFT CARDS ----------------
function findGiftCard(code) {
  const c = db.prepare('SELECT * FROM gift_cards WHERE code = ? COLLATE NOCASE').get(String(code || '').trim().toUpperCase());
  if (!c || c.status !== 'active') return { error: 'That gift card code isn’t valid.' };
  if (c.expires_at && c.expires_at < localNow().date) return { error: 'This gift card has expired.' };
  if (c.balance <= 0) return { error: 'This gift card has no balance left.' };
  return { card: c };
}
function restoreGift(b) {
  db.prepare('UPDATE gift_cards SET balance = balance + ? WHERE id = ?').run(b.giftcard_amount, b.gift_card_id);
  db.prepare("INSERT INTO gift_card_uses (gift_card_id, booking_id, amount, kind) VALUES (?,?,?,'restore')").run(b.gift_card_id, b.id, b.giftcard_amount);
}
function newGiftCode() {
  const C = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (;;) {
    const part = () => Array.from({ length: 4 }, () => C[crypto.randomInt(C.length)]).join('');
    const code = `GIFT-${part()}-${part()}`;
    if (!db.prepare('SELECT 1 FROM gift_cards WHERE code = ?').get(code)) return code;
  }
}
function addDaysISO(iso, n) { return new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
// Marks a gift-card / package purchase paid and activates it. Idempotent (safe for webhook + browser).
function activatePurchase(purchaseId, paymentRef) {
  const p = db.prepare('SELECT * FROM purchases WHERE id = ?').get(purchaseId);
  if (!p || p.status === 'paid') return p;
  db.prepare("UPDATE purchases SET status = 'paid', payment_ref = ? WHERE id = ?").run(paymentRef || null, p.id);
  const today = localNow().date;
  if (p.kind === 'giftcard') {
    db.prepare("UPDATE gift_cards SET status = 'active', code = ?, expires_at = ? WHERE id = ? AND status = 'pending'").run(newGiftCode(), addDaysISO(today, 365), p.ref_id);
  } else {
    const cp = db.prepare('SELECT cp.*, pk.validity_days FROM customer_packages cp JOIN packages pk ON pk.id = cp.package_id WHERE cp.id = ?').get(p.ref_id);
    db.prepare("UPDATE customer_packages SET status = 'active', expires_at = ? WHERE id = ? AND status = 'pending'").run(addDaysISO(today, cp.validity_days), p.ref_id);
  }
  return db.prepare('SELECT * FROM purchases WHERE id = ?').get(p.id);
}

// ---------------- RAZORPAY ROUTE (automatic payouts to spas) ----------------
// For a plain online booking at a spa with a linked Razorpay account, the spa's share is sent straight
// to that account, held until the day after the appointment so cancellations can still be refunded.
function routeTransfersFor(booking, spa) {
  if (!gateway.isLive || process.env.RAZORPAY_ROUTE !== 'on' || !spa.razorpay_account_id) return [];
  if (booking.giftcard_amount > 0 || booking.customer_package_id) return []; // mixed funding stays on the ledger
  const share = Math.round((booking.amount - booking.commission_amount) * 100);
  if (share < 100) return [];
  return [{ account: spa.razorpay_account_id, amount: share, currency: 'INR', notes: { booking_ref: booking.booking_ref || String(booking.id) },
            linked_account_notes: ['booking_ref'], on_hold: true, on_hold_until: Math.floor(appointmentMs(booking) / 1000) + 24 * 3600 }];
}

// ---------------- GST INVOICES ----------------
function fullAddress(sp) { const a = sp.address || '', c = sp.city || ''; return a.toLowerCase().includes(c.toLowerCase()) ? a : [a, c].filter(Boolean).join(', '); }
const GSTIN_RE = /^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
function fyOf(iso) { const y = Number(iso.slice(2, 4)), m = Number(iso.slice(5, 7)); return m >= 4 ? `${y}-${y + 1}` : `${y - 1}-${y}`; }
function nextInvoiceNo(series, fy, width) {
  const seq = (db.prepare('SELECT MAX(seq) m FROM invoices WHERE series = ? AND fy = ?').get(series, fy).m || 0) + 1;
  return { seq, no: `${series}/${fy}/${String(seq).padStart(width, '0')}` };
}
function gstSplit(gross, rate, supplierGstin, recipientGstin) {
  const taxable = round2(gross / (1 + rate / 100)), tax = round2(gross - taxable);
  const inter = supplierGstin && recipientGstin && supplierGstin.slice(0, 2) !== recipientGstin.slice(0, 2);
  return inter ? { taxable, rate, igst: tax } : { taxable, rate, cgst: round2(tax / 2), sgst: round2(tax - round2(tax / 2)) };
}
function bookingInvoice(b) {
  const existing = db.prepare('SELECT * FROM invoices WHERE booking_id = ?').get(b.id);
  if (existing) return { ...JSON.parse(existing.data), invoice_no: existing.invoice_no, issued_at: existing.issued_at };
  const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(b.spa_id), sv = db.prepare('SELECT * FROM services WHERE id = ?').get(b.service_id);
  const cu = db.prepare('SELECT name, phone, email FROM users WHERE id = ?').get(b.customer_id);
  const th = b.therapist_id ? db.prepare('SELECT name FROM therapists WHERE id = ?').get(b.therapist_id) : null;
  const registered = !!(spa.gstin && GSTIN_RE.test(spa.gstin));
  const giftPart = b.giftcard_amount || 0, pkgPart = b.customer_package_id ? b.amount : 0;
  const counter = db.prepare("SELECT method FROM payments WHERE booking_id = ? AND status = 'success' AND transaction_ref LIKE 'COUNTER_%' ORDER BY id DESC").get(b.id);
  const data = {
    kind: 'customer', title: registered ? 'Tax invoice' : 'Receipt',
    supplier: { name: spa.legal_name || spa.name, trade_name: spa.name, address: fullAddress(spa), phone: spa.phone, gstin: registered ? spa.gstin : null },
    recipient: { name: cu.name, phone: cu.phone, email: cu.email },
    booking: { ref: b.booking_ref, date: b.booking_date, time: b.start_time, service: sv.name, therapist: th ? th.name : null },
    lines: [{ description: `${sv.name} (${sv.duration_minutes} min)${pkgPart ? ' — package session' : ''}`, amount: round2(b.amount + (b.coupon_discount || 0)) }],
    coupon: b.coupon_code ? { code: b.coupon_code, amount: b.coupon_discount } : null,
    total: b.amount,
    tax: registered ? gstSplit(b.amount, spa.gst_rate || 18, spa.gstin, null) : null,
    paid_by: [
      pkgPart ? { method: 'Prepaid package', amount: pkgPart } : null,
      giftPart ? { method: 'Gift card', amount: giftPart } : null,
      !pkgPart && b.payment_mode === 'online' && b.amount - giftPart > 0 ? { method: 'Online (BookMySpa)', amount: round2(b.amount - giftPart) } : null,
      b.payment_mode === 'pay_at_venue' && b.amount - giftPart > 0 ? { method: `Paid at spa${counter ? ' (' + counter.method + ')' : ''}`, amount: round2(b.amount - giftPart) } : null,
    ].filter(Boolean),
    note: registered ? 'Prices include GST.' : 'Supplier is not registered under GST — no tax charged.',
    facilitator: 'Booked through BookMySpa, an online booking platform acting on behalf of the spa.',
  };
  const fy = fyOf(localNow().date), n = nextInvoiceNo(`S${spa.id}`, fy, 4);
  db.prepare("INSERT INTO invoices (kind, spa_id, booking_id, invoice_no, series, fy, seq, data) VALUES ('customer',?,?,?,?,?,?,?)").run(spa.id, b.id, n.no, `S${spa.id}`, fy, n.seq, JSON.stringify(data));
  const saved = db.prepare('SELECT * FROM invoices WHERE booking_id = ?').get(b.id);
  return { ...data, invoice_no: saved.invoice_no, issued_at: saved.issued_at };
}
function settlementInvoice(st) {
  const existing = db.prepare('SELECT * FROM invoices WHERE settlement_id = ?').get(st.id);
  if (existing) return { ...JSON.parse(existing.data), invoice_no: existing.invoice_no, issued_at: existing.issued_at };
  const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(st.spa_id);
  const pg = process.env.PLATFORM_GSTIN && GSTIN_RE.test(process.env.PLATFORM_GSTIN) ? process.env.PLATFORM_GSTIN : null;
  const data = {
    kind: 'commission', title: pg ? 'Tax invoice — platform commission' : 'Commission statement',
    supplier: { name: process.env.PLATFORM_LEGAL_NAME || 'BookMySpa', address: process.env.PLATFORM_ADDRESS || '', gstin: pg },
    recipient: { name: spa.legal_name || spa.name, trade_name: spa.name, address: fullAddress(spa), gstin: spa.gstin && GSTIN_RE.test(spa.gstin) ? spa.gstin : null },
    settlement: { id: st.id, date: st.created_at, bookings: st.booking_count, online_gross: st.online_gross, venue_gross: st.venue_gross, reference: st.reference,
                  result: st.direction === 'payout_to_spa' ? `Paid to spa: ₹${st.amount}` : st.direction === 'collected_from_spa' ? `Collected from spa: ₹${st.amount}` : 'Nothing owed' },
    lines: [{ description: `Booking platform commission on ${st.booking_count} appointment(s)`, amount: st.commission_total }],
    total: st.commission_total,
    tax: pg ? gstSplit(st.commission_total, 18, pg, spa.gstin) : null,
    note: pg ? 'Commission amount includes GST.' : 'Platform GSTIN not configured — statement only.',
  };
  const fy = fyOf(localNow().date), n = nextInvoiceNo('BMS', fy, 5);
  db.prepare("INSERT INTO invoices (kind, spa_id, settlement_id, invoice_no, series, fy, seq, data) VALUES ('commission',?,?,?,?,?,?,?)").run(spa.id, st.id, n.no, 'BMS', fy, n.seq, JSON.stringify(data));
  const saved = db.prepare('SELECT * FROM invoices WHERE settlement_id = ?').get(st.id);
  return { ...data, invoice_no: saved.invoice_no, issued_at: saved.issued_at };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function closureReason(spa, date) {
  const off = String(spa.weekly_off || '').split(',').filter((x) => x !== '').map(Number);
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (off.includes(dow)) return `Closed every ${WEEKDAYS[dow]}`;
  const c = db.prepare('SELECT reason FROM spa_closures WHERE spa_id = ? AND date = ?').get(spa.id, date);
  if (c) return c.reason ? `Closed — ${c.reason}` : 'Closed on this day';
  return null;
}
// Appointment start as a real timestamp (business timezone), and the free-cancellation deadline.
function appointmentMs(b) { return Date.parse(`${b.booking_date}T${b.start_time}:00Z`) - TZ_OFFSET_MINUTES * 60000; }
function changeDeadlineMs(b, spa) { return appointmentMs(b) - (spa.cancel_window_hours ?? 4) * 3600000; }
function withinChangeWindow(b, spa) { return b.status === 'pending_payment' || Date.now() <= changeDeadlineMs(b, spa); }

function validateTherapist(b, spaId, skipServices = false) {
  if (!b.name || String(b.name).trim().length < 2) return 'Enter the therapist’s name.';
  if (!['female', 'male', 'other'].includes(b.gender)) return 'Choose a gender.';
  if (!skipServices) {
    if (!Array.isArray(b.service_ids) || !b.service_ids.length) return 'Choose at least one service this therapist performs.';
    for (const sid of b.service_ids) if (!db.prepare('SELECT 1 FROM services WHERE id = ? AND spa_id = ?').get(sid, spaId)) return 'Choose services from this spa.';
  }
  return null;
}
function setTherapistServices(tid, ids) {
  db.prepare('DELETE FROM therapist_services WHERE therapist_id = ?').run(tid);
  for (const sid of [...new Set(ids.map(Number))]) db.prepare('INSERT INTO therapist_services (therapist_id, service_id) VALUES (?,?)').run(tid, sid);
}
function validatePackage(b, spaId) {
  if (!b.name || String(b.name).trim().length < 3) return 'Give the package a name.';
  if (!db.prepare('SELECT 1 FROM services WHERE id = ? AND spa_id = ?').get(b.service_id, spaId)) return 'Choose a service from this spa.';
  const n = Number(b.sessions), price = Number(b.price), days = Number(b.validity_days ?? 180);
  if (!Number.isInteger(n) || n < 2 || n > 50) return 'Sessions must be between 2 and 50.';
  if (!(price > 0 && price <= 1000000)) return 'Enter a valid package price.';
  if (!Number.isInteger(days) || days < 30 || days > 730) return 'Validity must be between 30 and 730 days.';
  return null;
}

function getAvailableSlots(spa, service, date, opts = {}) {
  cleanupStaleBookings();
  if (closureReason(spa, date)) return [];
  const excludeId = opts.excludeBookingId || -1;
  const blocks = db.prepare('SELECT room_type_id, start_time, end_time, qty FROM slot_blocks WHERE spa_id = ? AND date = ?').all(spa.id, date)
    .filter((bl) => bl.room_type_id === null || (service.room_type_id && bl.room_type_id === service.room_type_id));
  const hasTherapists = therapistsForService(service.id).length > 0;
  const eligible = hasTherapists ? eligibleTherapists(service.id, opts) : [];
  const tBookings = hasTherapists ? therapistBookings(spa.id, date, excludeId) : [];
  const openMin = timeToMinutes(spa.opening_time);
  const closeMin = timeToMinutes(spa.closing_time);
  const duration = service.duration_minutes;

  // Capacity scope: if this service belongs to a room type, every service sharing that
  // room type competes for the same pool of rooms. Otherwise, the service only competes
  // with its own past bookings (equivalent to a single dedicated room).
  let capacity = 1;
  let relevantBookings;
  if (service.room_type_id) {
    const roomType = db.prepare('SELECT * FROM room_types WHERE id = ?').get(service.room_type_id);
    capacity = roomType ? roomType.capacity : 1;
    relevantBookings = db.prepare(
      `SELECT b.start_time, b.end_time FROM bookings b
       JOIN services sv ON sv.id = b.service_id
       WHERE b.spa_id = ? AND b.booking_date = ? AND sv.room_type_id = ? AND b.status IN ('pending_payment','confirmed') AND b.id != ?`
    ).all(spa.id, date, service.room_type_id, excludeId);
  } else {
    relevantBookings = db.prepare(
      `SELECT start_time, end_time FROM bookings
       WHERE spa_id = ? AND booking_date = ? AND service_id = ? AND status IN ('pending_payment','confirmed') AND id != ?`
    ).all(spa.id, date, service.id, excludeId);
  }

  const slots = [];
  const nowLocal = localNow();
  const isToday = date === nowLocal.date;
  const nowMinutes = nowLocal.minutes;

  for (let start = openMin; start + duration <= closeMin; start += duration) {
    const end = start + duration;
    if (isToday && start <= nowMinutes) continue; // skip past slots today

    const overlapCount = relevantBookings.filter((b) => {
      const bStart = timeToMinutes(b.start_time);
      const bEnd = timeToMinutes(b.end_time);
      return start < bEnd && end > bStart;
    }).length;
    let blocked = 0, wholeSpa = false;
    for (const bl of blocks) {
      if (start < timeToMinutes(bl.end_time) && end > timeToMinutes(bl.start_time)) {
        if (bl.room_type_id === null) wholeSpa = true; else blocked += bl.qty;
      }
    }

    const spotsLeft = wholeSpa ? 0 : Math.max(0, capacity - overlapCount - blocked);
    const freeTherapists = hasTherapists
      ? eligible.filter((t) => !tBookings.some((b) => b.therapist_id === t.id && start < timeToMinutes(b.end_time) && end > timeToMinutes(b.start_time))).length
      : null;
    slots.push({ start_time: minutesToTime(start), end_time: minutesToTime(end), available: spotsLeft > 0 && freeTherapists !== 0, spots_left: spotsLeft, capacity, therapists_free: freeTherapists });
  }
  return slots;
}

// ---- Coupons ----
function findCoupon(spaId, code, serviceId, date, startTime) {
  if (!code) return { error: 'Enter a coupon code.' };
  const coupon = db.prepare(
    "SELECT * FROM coupons WHERE spa_id = ? AND code = ? COLLATE NOCASE AND active = 1"
  ).get(spaId, code.trim());
  if (!coupon) return { error: 'Invalid or inactive coupon code.' };
  if (coupon.service_id && Number(coupon.service_id) !== Number(serviceId)) {
    return { error: 'This coupon does not apply to the selected service.' };
  }
  if (coupon.valid_from && date < coupon.valid_from) return { error: `This coupon becomes valid from ${coupon.valid_from}.` };
  if (coupon.valid_to && date > coupon.valid_to) return { error: `This coupon expired on ${coupon.valid_to}.` };
  if (coupon.start_time && startTime < coupon.start_time) return { error: `This coupon is only valid from ${formatT(coupon.start_time)} onward.` };
  if (coupon.end_time && startTime >= coupon.end_time) return { error: `This coupon is only valid before ${formatT(coupon.end_time)}.` };
  if (coupon.max_uses !== null && coupon.used_count >= coupon.max_uses) return { error: 'This coupon has reached its usage limit.' };
  return { coupon };
}

function formatT(t) { return t; }

function applyCoupon(amount, coupon) {
  if (!coupon) return { finalAmount: amount, discountAmount: 0 };
  let discountAmount = coupon.discount_type === 'percent' ? (amount * coupon.discount_value) / 100 : coupon.discount_value;
  discountAmount = Math.max(0, Math.min(discountAmount, amount));
  return { finalAmount: Math.round(amount - discountAmount), discountAmount: Math.round(discountAmount) };
}

// ---- OTP (phone verification) ----
function normalizePhone(phone) {
  return (phone || '').replace(/[^\d+]/g, '');
}

function generateAndStoreOtp(phone, purpose) {
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO otp_codes (phone, code, purpose, expires_at) VALUES (?,?,?,?)').run(phone, code, purpose, expiresAt);
  return code;
}

// Checks a submitted code against the most recent unconsumed OTP for this
// phone+purpose. Limits guesses per code (5) independently of the send-side
// rate limit, so even a leaked/guessed-at code can't be brute-forced.
function verifyOtp(phone, code, purpose) {
  const row = db.prepare(
    `SELECT * FROM otp_codes WHERE phone = ? AND purpose = ? AND consumed = 0 ORDER BY id DESC LIMIT 1`
  ).get(phone, purpose);
  if (!row) return { valid: false, error: 'No verification code was requested for this number. Request a new code.' };
  if (new Date(row.expires_at).getTime() < Date.now()) return { valid: false, error: 'This code has expired. Request a new one.' };
  if (row.attempts >= 5) return { valid: false, error: 'Too many incorrect attempts. Request a new code.' };

  if (row.code !== String(code).trim()) {
    db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?').run(row.id);
    return { valid: false, error: 'Incorrect code. Please try again.' };
  }

  db.prepare('UPDATE otp_codes SET consumed = 1 WHERE id = ?').run(row.id);
  return { valid: true };
}

async function handleApi(req, res, pathname, query) {
  const parts = pathname.split('/').filter(Boolean); // e.g. ['api','spas','3']

  try {
    // ---------------- PAYMENT WEBHOOK (reliability safety net) ----------------
    // Razorpay calls this directly (not the browser), so it confirms bookings
    // even if the customer closes the tab right after paying. Configure this
    // URL (https://yourdomain.com/api/webhooks/razorpay) and a webhook secret
    // in the Razorpay dashboard, then set RAZORPAY_WEBHOOK_SECRET here.
    // Safe to leave unconfigured — the checkout/verify flow above works fine
    // without it, this just adds extra reliability once you're live.
    if (parts[1] === 'webhooks' && parts[2] === 'razorpay' && req.method === 'POST') {
      const rawBody = await readRawBody(req);
      const signature = req.headers['x-razorpay-signature'];
      const secret = process.env.RAZORPAY_WEBHOOK_SECRET;

      if (!secret) return sendJSON(res, 200, { ignored: true }); // webhook not configured; no-op
      if (!signature) return sendJSON(res, 400, { error: 'Missing signature.' });

      const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
      const valid = signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
      if (!valid) return sendJSON(res, 400, { error: 'Invalid webhook signature.' });

      let event;
      try { event = JSON.parse(rawBody); } catch { return sendJSON(res, 400, { error: 'Invalid payload.' }); }

      if (event.event === 'payment.captured' || event.event === 'order.paid') {
        const receipt = event.payload?.order?.entity?.receipt || event.payload?.payment?.entity?.notes?.receipt;
        const paymentEntity = event.payload?.payment?.entity;
        const purchaseMatch = /^purchase_(\d+)$/.exec(receipt || '');
        if (purchaseMatch) activatePurchase(Number(purchaseMatch[1]), paymentEntity && paymentEntity.id);
        const bookingIdMatch = /^booking_(\d+)$/.exec(receipt || '');
        if (bookingIdMatch) {
          const bookingId = Number(bookingIdMatch[1]);
          const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
          if (booking && booking.status === 'pending_payment') {
            db.prepare("UPDATE bookings SET status='confirmed', payment_status='paid' WHERE id = ?").run(bookingId);
            if (paymentEntity) {
              db.prepare('INSERT INTO payments (booking_id, amount, method, status, transaction_ref) VALUES (?,?,?,?,?)')
                .run(bookingId, booking.amount, paymentEntity.method || 'razorpay', 'success', paymentEntity.id);
            }
            if (booking.coupon_code) {
              db.prepare("UPDATE coupons SET used_count = used_count + 1 WHERE spa_id = ? AND code = ? COLLATE NOCASE").run(booking.spa_id, booking.coupon_code);
            }
            // Best-effort confirmation via email if the customer's own /verify call never landed
            try {
              const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(booking.customer_id);
              const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(booking.spa_id);
              const service = db.prepare('SELECT * FROM services WHERE id = ?').get(booking.service_id);
              if (!booking.notify_channel) {
                await notifier.sendBookingConfirmations({ booking, customer, spa, service });
              }
            } catch (e) { /* non-fatal */ }
          }
        }
      }
      return sendJSON(res, 200, { received: true });
    }

    if (parts[1] === 'config' && req.method === 'GET') {
      return sendJSON(res, 200, { onlinePayments: onlinePaymentsAvailable(), paymentsMock: !gateway.isLive, otp: otpAvailable(), otpMock: !notifier.isSmsConfigured, partnerUrl: process.env.PARTNER_URL || '/partner/', routePayouts: gateway.isLive && process.env.RAZORPAY_ROUTE === 'on', googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || null, commissionPercent: DEFAULT_COMMISSION });
    }

    // ---------------- FORGOT PASSWORD (SMS code to the registered mobile) ----------------
    // Step 1 reuses /auth/otp/send with purpose 'login'. Step 2 below sets the new password.
    if (parts[1] === 'auth' && parts[2] === 'password' && parts[3] === 'reset' && req.method === 'POST') {
      if (!checkRateLimit(req, { keyPrefix: 'pw_reset', maxRequests: 10, windowMs: 15 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      if (!otpAvailable()) return sendJSON(res, 503, { error: 'Password reset by SMS is not available right now. Please contact support.' });
      const body = await parseBody(req);
      const phone = normalizePhone(body.phone);
      const newPassword = body.newPassword;
      if (!phone) return sendJSON(res, 400, { error: 'Enter your registered mobile number.' });
      if (typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 200) return sendJSON(res, 400, { error: 'New password must be at least 8 characters.' });
      const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      if (!u) return sendJSON(res, 404, { error: 'No account found with this phone number.' });
      if (u.role === 'admin') return sendJSON(res, 403, { error: 'Admin passwords can only be reset from the server (see README).' });
      if (u.active === 0) return sendJSON(res, 403, { error: 'This account has been deactivated. Please contact support.' });
      const portalErr = checkPortal(u, body.portal);
      if (portalErr) return sendJSON(res, 403, { error: portalErr });
      const otpResult = verifyOtp(phone, body.code, 'login');
      if (!otpResult.valid) return sendJSON(res, 400, { error: otpResult.error });
      const { hash, salt } = hashPassword(newPassword);
      db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = datetime('now'), phone_verified = 1 WHERE id = ?").run(hash, salt, u.id);
      const token = sign({ id: u.id, role: u.role, name: u.name });
      return sendJSON(res, 200, { message: 'Password updated. You are now logged in.', token, user: publicUser({ ...u, phone_verified: 1 }) });
    }

    // ---------------- ADMIN: AUTOMATIC BACKUPS ----------------
    if (parts[1] === 'admin' && parts[2] === 'backups' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      return sendJSON(res, 200, { backups: backupMod.listBackups(), status: backupMod.readStatus(), offsite: backupMod.offsiteSummary(), keep: backupMod.KEEP });
    }
    if (parts[1] === 'admin' && parts[2] === 'backups' && parts.length === 3 && req.method === 'POST') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      if (!checkRateLimitByKey('backup_now', { maxRequests: 10, windowMs: 60 * 60 * 1000 })) return sendJSON(res, 429, { error: 'Too many manual backups. Try again later.' });
      const b = await backupMod.runBackup(db, 'manual');
      const off = backupMod.offsiteSummary().configured;
      return sendJSON(res, 201, { message: off ? (b.offsite && b.offsite.lastError ? 'Backup saved on the server, but the offsite upload failed: ' + b.offsite.lastError.message : 'Backup saved and copied offsite.') : 'Backup saved on the server.', name: b.name, size: b.size });
    }
    if (parts[1] === 'admin' && parts[2] === 'backups' && parts.length === 4 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      let name; try { name = decodeURIComponent(parts[3]); } catch { return sendJSON(res, 400, { error: 'Invalid name.' }); }
      const file = path.join(backupMod.BACKUP_DIR, name);
      if (!backupMod.NAME_RE.test(name) || !fs.existsSync(file)) return sendJSON(res, 404, { error: 'Backup not found.' });
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${name}"`, 'Content-Length': fs.statSync(file).size });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ---------------- ADMIN: DATABASE BACKUP ----------------
    // Downloads a consistent snapshot of the entire database (all spas, accounts, bookings, reviews...).
    if (parts[1] === 'admin' && parts[2] === 'backup' && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const tmp = path.join(os.tmpdir(), `bookmyspa-backup-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.db`);
      db.exec(`VACUUM INTO '${tmp}'`);
      const stamp = localNow().date;
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="bookmyspa-backup-${stamp}.db"`,
        'Content-Length': fs.statSync(tmp).size,
      });
      const stream = fs.createReadStream(tmp);
      stream.pipe(res);
      stream.on('close', () => fs.unlink(tmp, () => {}));
      return;
    }

    // ---------------- AUTH ----------------
    // Sends a 6-digit code by SMS. Used before registration (to verify a new
    // phone) and before OTP login (to prove you own an existing account's phone).
    if (parts[1] === 'auth' && parts[2] === 'otp' && parts[3] === 'send' && req.method === 'POST') {
      const body = await parseBody(req);
      const phone = normalizePhone(body.phone);
      const purpose = ['registration', 'login'].includes(body.purpose) ? body.purpose : null;
      if (!phone || phone.length < 10) return sendJSON(res, 400, { error: 'Enter a valid phone number.' });
      if (!purpose) return sendJSON(res, 400, { error: 'Invalid request.' });
      if (!otpAvailable()) return sendJSON(res, 503, { error: 'Phone verification by SMS is not available right now.' });

      if (!checkRateLimitByKey('otp_send:' + phone, { maxRequests: 3, windowMs: 10 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many codes requested for this number. Please wait a few minutes.' });
      }
      if (!checkRateLimit(req, { keyPrefix: 'otp_send_ip', maxRequests: 10, windowMs: 10 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many requests. Please wait a few minutes.' });
      }

      if (purpose === 'registration') {
        const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
        if (existing) return sendJSON(res, 409, { error: 'This phone number is already registered. Try logging in instead.' });
      } else {
        const existing = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
        if (!existing) return sendJSON(res, 404, { error: 'No account found with this phone number.' });
      }

      const code = generateAndStoreOtp(phone, purpose);
      const result = await notifier.sendOtpSms(phone, code);
      if (result.status === 'failed') {
        console.error('OTP delivery failed:', result.detail);
        db.prepare('UPDATE otp_codes SET consumed = 1 WHERE phone = ? AND purpose = ? AND consumed = 0').run(phone, purpose);
        return sendJSON(res, 502, { error: "We couldn't send the SMS right now. Please try again in a minute." });
      }

      const response = { success: true, message: 'Verification code sent.' };
      if (!notifier.isSmsConfigured && !isProduction) response.devCode = code; // local development only
      return sendJSON(res, 200, response);
    }

    if (parts[1] === 'auth' && parts[2] === 'register' && req.method === 'POST') {
      if (!checkRateLimit(req, { keyPrefix: 'register', maxRequests: 8, windowMs: 60 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many signup attempts. Please try again later.' });
      }
      const body = await parseBody(req);
      const { name, password } = body;
      const email = String(body.email || '').trim().toLowerCase();
      const role = body.portal === 'partner' ? 'owner' : 'customer';
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Enter a valid email address.' });
      const phone = normalizePhone(body.phone);
      if (!name || !email || !password || !role || !phone) return sendJSON(res, 400, { error: 'name, email, phone, and password are required.' });
      if (typeof password !== 'string' || password.length < 8 || password.length > 200) return sendJSON(res, 400, { error: 'Password must be at least 8 characters.' });
      if (!['customer', 'owner'].includes(role)) return sendJSON(res, 400, { error: 'role must be customer or owner.' });

      const otpRequired = otpAvailable();
      if (otpRequired) {
        const otpResult = verifyOtp(phone, body.otpCode, 'registration');
        if (!otpResult.valid) return sendJSON(res, 400, { error: otpResult.error });
      }

      const existingEmail = db.prepare('SELECT id FROM users WHERE lower(email) = ?').get(email);
      if (existingEmail) return sendJSON(res, 409, { error: 'An account with this email already exists.' });
      const existingPhone = db.prepare('SELECT id FROM users WHERE phone = ?').get(phone);
      if (existingPhone) return sendJSON(res, 409, { error: 'An account with this phone number already exists.' });

      const { hash, salt } = hashPassword(password);
      const info = db.prepare(
        'INSERT INTO users (name, email, phone, phone_verified, password_hash, password_salt, role) VALUES (?,?,?,?,?,?,?)'
      ).run(name, email, phone, otpRequired ? 1 : 0, hash, salt, role);
      const user = { id: Number(info.lastInsertRowid), name, email, role };
      const token = sign({ id: user.id, role: user.role, name: user.name });
      return sendJSON(res, 201, { token, user: publicUser({ ...user, phone, phone_verified: otpRequired ? 1 : 0 }) });
    }

    if (parts[1] === 'auth' && parts[2] === 'login' && req.method === 'POST') {
      if (!checkRateLimit(req, { keyPrefix: 'login', maxRequests: 10, windowMs: 15 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many login attempts. Please wait a few minutes and try again.' });
      }
      const body = await parseBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const { password } = body;
      const u = db.prepare('SELECT * FROM users WHERE lower(email) = ?').get(email);
      if (!u || !verifyPassword(password, u.password_salt, u.password_hash)) {
        return sendJSON(res, 401, { error: 'Invalid email or password.' });
      }
      if (u.active === 0) return sendJSON(res, 403, { error: 'This account has been deactivated. Please contact support.' });
      const portalErr = checkPortal(u, body.portal);
      if (portalErr) return sendJSON(res, 403, { error: portalErr });
      const token = sign({ id: u.id, role: u.role, name: u.name });
      return sendJSON(res, 200, { token, user: publicUser(u) });
    }

    // OTP login: an alternative to password login. Prove ownership of the
    // phone on file for an existing account and skip the password entirely.
    if (parts[1] === 'auth' && parts[2] === 'otp' && parts[3] === 'login' && req.method === 'POST') {
      if (!checkRateLimit(req, { keyPrefix: 'otp_login_ip', maxRequests: 10, windowMs: 15 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
      }
      const body = await parseBody(req);
      const phone = normalizePhone(body.phone);
      if (!phone) return sendJSON(res, 400, { error: 'Enter a valid phone number.' });

      const otpResult = verifyOtp(phone, body.code, 'login');
      if (!otpResult.valid) return sendJSON(res, 400, { error: otpResult.error });

      const u = db.prepare('SELECT * FROM users WHERE phone = ?').get(phone);
      if (!u) return sendJSON(res, 404, { error: 'No account found with this phone number.' });
      if (u.role === 'admin') return sendJSON(res, 403, { error: 'Admins must log in with a password.' });
      if (u.active === 0) return sendJSON(res, 403, { error: 'This account has been deactivated. Please contact support.' });
      const otpPortalErr = checkPortal(u, body.portal);
      if (otpPortalErr) return sendJSON(res, 403, { error: otpPortalErr });

      const token = sign({ id: u.id, role: u.role, name: u.name });
      return sendJSON(res, 200, { token, user: publicUser(u) });
    }

    if (parts[1] === 'me' && req.method === 'GET') {
      const authUser = requireAuth(req, res);
      if (!authUser) return;
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(authUser.id);
      return sendJSON(res, 200, { user: publicUser(u) });
    }

    // ---------------- PUBLIC: SPAS ----------------
    if (parts[1] === 'spas' && parts.length === 2 && req.method === 'GET') {
      const city = query.get('city');
      const search = query.get('search');
      const sort = query.get('sort') || 'featured'; // featured | rating | nearby
      const lat = query.get('lat') ? Number(query.get('lat')) : null;
      const lng = query.get('lng') ? Number(query.get('lng')) : null;

      let sql = "SELECT * FROM spas WHERE status = 'approved' AND suspended = 0";
      const args = [];
      if (city) { sql += ' AND city LIKE ?'; args.push(`%${city}%`); }
      if (search) { sql += ' AND (name LIKE ? OR description LIKE ?)'; args.push(`%${search}%`, `%${search}%`); }
      const rows = db.prepare(sql).all(...args);

      let spas = rows.map((s) => {
        const spa = publicSpa(s);
        if (lat !== null && lng !== null && s.latitude !== null && s.longitude !== null) {
          spa.distance_km = Math.round(distanceKm(lat, lng, s.latitude, s.longitude) * 10) / 10;
        } else {
          spa.distance_km = null;
        }
        return spa;
      });

      const today = localNow().date;
      const featWeight = new Map(db.prepare(
        `SELECT spa_id, MAX(amount) AS w FROM featured_placements WHERE cancelled = 0 AND starts_on <= ? AND ends_on >= ? GROUP BY spa_id`
      ).all(today, today).map((r) => [r.spa_id, r.w]));
      const byScore = (a, b) => ratingScore(b) - ratingScore(a) || b.review_count - a.review_count;
      if (sort === 'nearby' && lat !== null && lng !== null) {
        // Pure distance from the customer's current location; spas without a location go last.
        spas.sort((a, b) => {
          if (a.distance_km === null && b.distance_km === null) return byScore(a, b);
          if (a.distance_km === null) return 1;
          if (b.distance_km === null) return -1;
          return a.distance_km - b.distance_km || byScore(a, b);
        });
      } else if (sort === 'rating') {
        spas.sort(byScore);
      } else {
        // Featured: spas with an active paid placement first (higher placement fee first), then by rating.
        spas.sort((a, b) => (featWeight.has(b.id) - featWeight.has(a.id)) || ((featWeight.get(b.id) || 0) - (featWeight.get(a.id) || 0)) || byScore(a, b));
      }
      if (query.get('featured') === '1') spas = spas.filter((s) => s.featured);

      return sendJSON(res, 200, { spas });
    }

    if (parts[1] === 'spas' && parts[2] === 'cities' && req.method === 'GET') {
      const rows = db.prepare("SELECT DISTINCT city FROM spas WHERE status='approved' AND suspended = 0 ORDER BY city").all();
      return sendJSON(res, 200, { cities: rows.map((r) => r.city) });
    }

    if (parts[1] === 'spas' && parts.length === 3 && req.method === 'GET') {
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(parts[2]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const services = db.prepare(
        `SELECT sv.*, rt.name as room_type_name, rt.capacity as room_type_capacity
         FROM services sv LEFT JOIN room_types rt ON rt.id = sv.room_type_id
         WHERE sv.spa_id = ? AND sv.active = 1`
      ).all(spa.id).map(withDiscount);
      const media = db.prepare('SELECT id, type, url, is_cover FROM spa_media WHERE spa_id = ? ORDER BY is_cover DESC, created_at ASC').all(spa.id);
      const therapists = db.prepare('SELECT id, name, gender, bio FROM therapists WHERE spa_id = ? AND active = 1 ORDER BY name').all(spa.id)
        .map((t) => ({ ...t, service_ids: db.prepare('SELECT service_id FROM therapist_services WHERE therapist_id = ?').all(t.id).map((r) => r.service_id) }));
      const packages = db.prepare(`SELECT p.*, sv.name AS service_name, sv.duration_minutes FROM packages p JOIN services sv ON sv.id = p.service_id
                                   WHERE p.spa_id = ? AND p.active = 1 AND sv.active = 1 ORDER BY p.price`).all(spa.id);
      return sendJSON(res, 200, { spa: publicSpa(spa), services, media, therapists, packages });
    }

    if (parts[1] === 'spas' && parts[3] === 'slots' && req.method === 'GET') {
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(parts[2]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const serviceId = query.get('serviceId');
      const date = query.get('date');
      if (!serviceId || !date) return sendJSON(res, 400, { error: 'serviceId and date query params are required.' });
      const dateErr = validateBookingDate(date);
      if (dateErr) return sendJSON(res, 400, { error: dateErr });
      const service = db.prepare('SELECT * FROM services WHERE id = ? AND spa_id = ? AND active = 1').get(serviceId, spa.id);
      if (!service) return sendJSON(res, 404, { error: 'Service not found for this spa.' });
      const slots = getAvailableSlots(spa, service, date, therapistOpts({ therapistId: query.get('therapistId'), gender: query.get('gender') }));
      return sendJSON(res, 200, { slots, closed: closureReason(spa, date) });
    }

    if (parts[1] === 'spas' && parts[3] === 'coupons' && parts[4] === 'validate' && req.method === 'GET') {
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(parts[2]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const code = query.get('code');
      const serviceId = query.get('serviceId');
      const date = query.get('date');
      const startTime = query.get('startTime');
      const service = db.prepare('SELECT * FROM services WHERE id = ? AND spa_id = ? AND active = 1').get(serviceId, spa.id);
      if (!service) return sendJSON(res, 404, { error: 'Service not found.' });

      const result = findCoupon(spa.id, code, serviceId, date, startTime);
      if (result.error) return sendJSON(res, 200, { valid: false, error: result.error });

      const baseAmount = withDiscount(service).final_price;
      const applied = applyCoupon(baseAmount, result.coupon);
      return sendJSON(res, 200, {
        valid: true,
        discount_type: result.coupon.discount_type,
        discount_value: result.coupon.discount_value,
        original_amount: baseAmount,
        discount_amount: applied.discountAmount,
        final_amount: applied.finalAmount,
      });
    }

    // ---------------- PUBLIC: CONTACT FORM ----------------
    if (parts[1] === 'contact' && req.method === 'POST') {
      if (!checkRateLimit(req, { keyPrefix: 'contact', maxRequests: 5, windowMs: 60 * 60 * 1000 })) {
        return sendJSON(res, 429, { error: 'Too many messages sent. Please try again later.' });
      }
      const body = await parseBody(req);
      const { name, email, subject, message } = body;
      if (!name || !email || !message) return sendJSON(res, 400, { error: 'Name, email, and message are required.' });
      if (message.length > 5000) return sendJSON(res, 400, { error: 'Message is too long.' });
      db.prepare('INSERT INTO contact_messages (name, email, subject, message) VALUES (?,?,?,?)')
        .run(name.slice(0, 200), email.slice(0, 200), (subject || '').slice(0, 200), message);
      return sendJSON(res, 201, { message: "Thanks — we'll get back to you soon." });
    }

    // ---------------- CUSTOMER: BOOKINGS ----------------
    if (parts[1] === 'bookings' && parts.length === 2 && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const body = await parseBody(req);
      const { spaId, serviceId, date, startTime, couponCode } = body;
      let paymentMode = body.paymentMode === 'pay_at_venue' ? 'pay_at_venue' : 'online';
      const topts = therapistOpts(body);

      const dateErr = validateBookingDate(date);
      if (dateErr) return sendJSON(res, 400, { error: dateErr });
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(spaId);
      const service = db.prepare('SELECT * FROM services WHERE id = ? AND spa_id = ? AND active = 1').get(serviceId, spaId);
      if (!spa || !service) return sendJSON(res, 404, { error: 'Spa or service not found.' });

      // A prepaid package session for this exact service
      let pkg = null;
      if (body.customerPackageId) {
        pkg = db.prepare("SELECT * FROM customer_packages WHERE id = ? AND customer_id = ? AND status = 'active'").get(body.customerPackageId, user.id);
        if (!pkg || pkg.spa_id !== spa.id || pkg.service_id !== service.id) return sendJSON(res, 400, { error: 'That package can’t be used for this service.' });
        if (pkg.sessions_used >= pkg.sessions_total) return sendJSON(res, 400, { error: 'There are no sessions left in this package.' });
        if (pkg.expires_at && pkg.expires_at < date) return sendJSON(res, 400, { error: `This package is valid until ${pkg.expires_at}.` });
        if (couponCode || body.giftCardCode) return sendJSON(res, 400, { error: 'Coupons and gift cards can’t be combined with a package session.' });
      }

      const slots = getAvailableSlots(spa, service, date, topts);
      const chosen = slots.find((x) => x.start_time === startTime);
      if (!chosen || !chosen.available) return sendJSON(res, 409, { error: 'That slot is no longer available. Please pick another.' });
      let therapist = null;
      if (therapistsForService(service.id).length) {
        therapist = pickTherapist(spa.id, service.id, date, chosen.start_time, chosen.end_time, topts);
        if (!therapist) return sendJSON(res, 409, { error: 'No therapist matching your choice is free then. Please pick another time.' });
      }

      let finalAmount, couponDiscount = 0, appliedCode = null;
      if (pkg) finalAmount = pkg.per_session_value;
      else {
        finalAmount = withDiscount(service).final_price;
        if (couponCode) {
          const result = findCoupon(spaId, couponCode, serviceId, date, chosen.start_time);
          if (result.error) return sendJSON(res, 400, { error: result.error });
          const applied = applyCoupon(finalAmount, result.coupon);
          couponDiscount = applied.discountAmount; finalAmount = applied.finalAmount; appliedCode = result.coupon.code;
        }
      }
      let gift = null, giftAmount = 0;
      if (!pkg && body.giftCardCode) {
        gift = findGiftCard(body.giftCardCode);
        if (gift.error) return sendJSON(res, 400, { error: gift.error });
        giftAmount = round2(Math.min(gift.card.balance, finalAmount));
      }
      const due = round2(finalAmount - giftAmount);
      const prepaid = !!pkg || due <= 0;
      if (prepaid) paymentMode = 'online';
      else if (paymentMode === 'online' && !onlinePaymentsAvailable()) return sendJSON(res, 400, { error: "Online payment isn't available yet — please choose Pay at the spa." });
      else if (paymentMode === 'pay_at_venue' && spa.allow_pay_at_venue === 0) return sendJSON(res, 400, { error: 'This spa requires online payment to confirm a booking.' });
      const status = prepaid || paymentMode === 'pay_at_venue' ? 'confirmed' : 'pending_payment';

      const info = db.prepare(
        `INSERT INTO bookings (customer_id, spa_id, service_id, booking_date, start_time, end_time, amount, coupon_code, coupon_discount, status, payment_status, payment_mode,
                               therapist_id, therapist_choice, giftcard_amount, gift_card_id, customer_package_id)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(user.id, spa.id, service.id, date, chosen.start_time, chosen.end_time, finalAmount, appliedCode, couponDiscount, status, prepaid ? 'paid' : 'unpaid', paymentMode,
            therapist ? therapist.id : null, therapist ? (topts.therapistId ? 'specific' : topts.gender || 'any') : null, giftAmount, gift ? gift.card.id : null, pkg ? pkg.id : null);
      const bookingId = Number(info.lastInsertRowid);
      applyCommission(bookingId, spa, finalAmount);
      assignBookingRef(bookingId);
      if (giftAmount > 0) {
        db.prepare('UPDATE gift_cards SET balance = balance - ? WHERE id = ?').run(giftAmount, gift.card.id);
        db.prepare("INSERT INTO gift_card_uses (gift_card_id, booking_id, amount, kind) VALUES (?,?,?,'redeem')").run(gift.card.id, bookingId, giftAmount);
      }
      if (pkg) db.prepare('UPDATE customer_packages SET sessions_used = sessions_used + 1 WHERE id = ?').run(pkg.id);
      if (appliedCode && status === 'confirmed') db.prepare('UPDATE coupons SET used_count = used_count + 1 WHERE spa_id = ? AND code = ? COLLATE NOCASE').run(spa.id, appliedCode);

      let booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
      let notification = null;
      if (status === 'confirmed') {
        try {
          notification = await notifier.sendBookingConfirmations({ booking, customer: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), spa, service });
          booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(bookingId);
        } catch (e) { notification = { status: 'failed', detail: e.message }; }
      }
      const message = pkg ? `Booking confirmed with your package — ${pkg.sessions_total - pkg.sessions_used - 1} session(s) left.`
        : prepaid ? 'Booking confirmed — fully paid with your gift card.'
        : paymentMode === 'pay_at_venue' ? `Booking confirmed. Pay ₹${due.toLocaleString('en-IN')} at the spa.${giftAmount ? ` (₹${giftAmount} paid by gift card)` : ''}`
        : 'Slot held. Complete payment within 10 minutes to confirm.';
      return sendJSON(res, 201, { booking, notification, message, due, therapist: therapist ? { id: therapist.id, name: therapist.name } : null });
    }

    if (parts[1] === 'bookings' && parts[2] === 'me' && req.method === 'GET') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      cleanupStaleBookings();
      const rows = db.prepare(
        `SELECT b.*, s.name as spa_name, s.city as spa_city, sv.name as service_name, r.rating AS my_rating, r.comment AS my_comment, (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name
         FROM bookings b
         JOIN spas s ON s.id = b.spa_id
         JOIN services sv ON sv.id = b.service_id
         LEFT JOIN reviews r ON r.booking_id = b.id
         WHERE b.customer_id = ?
         ORDER BY b.booking_date DESC, b.start_time DESC`
      ).all(user.id);
      const winStmt = db.prepare('SELECT cancel_window_hours FROM spas WHERE id = ?');
      for (const b of rows) {
        b.can_review = !b.my_rating && reviewEligible(b);
        const sp = winStmt.get(b.spa_id) || { cancel_window_hours: 4 };
        b.cancel_window_hours = sp.cancel_window_hours;
        b.change_deadline = new Date(changeDeadlineMs(b, sp)).toISOString();
        b.can_change = ['pending_payment', 'confirmed'].includes(b.status) && !b.settlement_id && b.booking_date >= localNow().date && withinChangeWindow(b, sp);
        b.can_reschedule = b.status === 'confirmed' && b.can_change && (b.rescheduled_count || 0) < 2;
      }
      return sendJSON(res, 200, { bookings: rows });
    }

    // Step 1: create a payment order for this booking (Razorpay order, or a mock order).
    if (parts[1] === 'bookings' && parts[3] === 'checkout' && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (booking.status !== 'pending_payment') return sendJSON(res, 409, { error: `This booking is already ${booking.status}.` });
      if (!onlinePaymentsAvailable()) return sendJSON(res, 400, { error: "Online payment isn't available yet." });

      try {
        const bspa = db.prepare('SELECT * FROM spas WHERE id = ?').get(booking.spa_id);
        const transfers = routeTransfersFor(booking, bspa);
        const order = await gateway.createOrder({ amount: round2(booking.amount - (booking.giftcard_amount || 0)), bookingId: booking.id, transfers,
          notes: transfers.length ? { booking_ref: booking.booking_ref || String(booking.id) } : undefined });
        db.prepare('UPDATE bookings SET route_transfer = ? WHERE id = ?').run(transfers.length ? 1 : 0, booking.id);
        const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        return sendJSON(res, 200, {
          ...order,
          bookingId: booking.id,
          prefill: { name: customer.name, email: customer.email, contact: customer.phone },
        });
      } catch (e) {
        return sendJSON(res, 502, { error: 'Could not start checkout: ' + e.message });
      }
    }

    // Step 2: verify what the checkout handed back, then confirm the booking + notify.
    if (parts[1] === 'bookings' && parts[3] === 'verify' && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (booking.status !== 'pending_payment') return sendJSON(res, 409, { error: `This booking is already ${booking.status}.` });

      const body = await parseBody(req);
      const notifyChannel = ['email', 'sms', 'whatsapp'].includes(body.notifyChannel) ? body.notifyChannel : 'email';

      const result = gateway.verifyPayment({
        mode: body.mode,
        orderId: body.orderId,
        paymentId: body.paymentId,
        signature: body.signature,
      });

      db.prepare('INSERT INTO payments (booking_id, amount, method, status, transaction_ref) VALUES (?,?,?,?,?)')
        .run(booking.id, round2(booking.amount - (booking.giftcard_amount || 0)), body.method || 'razorpay', result.success ? 'success' : 'failed', result.transactionRef);

      let notification = null;
      if (result.success) {
        db.prepare("UPDATE bookings SET status='confirmed', payment_status='paid' WHERE id = ?").run(booking.id);
        if (booking.coupon_code) {
          db.prepare("UPDATE coupons SET used_count = used_count + 1 WHERE spa_id = ? AND code = ? COLLATE NOCASE").run(booking.spa_id, booking.coupon_code);
        }
        const customer = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
        const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(booking.spa_id);
        const service = db.prepare('SELECT * FROM services WHERE id = ?').get(booking.service_id);
        try {
          notification = await notifier.sendBookingConfirmations({ booking, customer, spa, service });
        } catch (e) {
          notification = { status: 'failed', detail: e.message };
        }
      }

      const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
      return sendJSON(res, result.success ? 200 : 402, {
        success: result.success,
        message: result.message,
        transactionRef: result.transactionRef,
        booking: updated,
        notification,
      });
    }

    // ---------------- CUSTOMER: RESCHEDULE ----------------
    if (parts[1] === 'bookings' && (parts[3] === 'reschedule-slots' || parts[3] === 'reschedule') && ['GET', 'PUT'].includes(req.method)) {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(booking.spa_id);
      const service = db.prepare('SELECT * FROM services WHERE id = ?').get(booking.service_id);
      if (booking.status !== 'confirmed' || booking.settlement_id) return sendJSON(res, 409, { error: 'Only confirmed upcoming bookings can be rescheduled.' });
      if (!withinChangeWindow(booking, spa)) return sendJSON(res, 409, { error: `Rescheduling closed ${spa.cancel_window_hours} hours before your appointment. Please call the spa.` });
      if ((booking.rescheduled_count || 0) >= 2) return sendJSON(res, 409, { error: 'This booking has already been rescheduled twice. Please call the spa.' });
      const body = req.method === 'PUT' ? await parseBody(req) : {};
      const date = req.method === 'GET' ? query.get('date') : body.date;
      const dateErr = validateBookingDate(date);
      if (dateErr) return sendJSON(res, 400, { error: dateErr });
      const topts = booking.therapist_choice === 'specific' ? { therapistId: booking.therapist_id } : ['female', 'male'].includes(booking.therapist_choice) ? { gender: booking.therapist_choice } : {};
      const slots = getAvailableSlots(spa, service, date, { excludeBookingId: booking.id, ...topts });
      if (req.method === 'GET') return sendJSON(res, 200, { slots, closed: closureReason(spa, date) });
      const chosen = slots.find((x) => x.start_time === body.startTime);
      if (!chosen || !chosen.available) return sendJSON(res, 409, { error: 'That time is no longer available. Please pick another.' });
      if (date === booking.booking_date && chosen.start_time === booking.start_time) return sendJSON(res, 400, { error: 'That is already your booking time.' });
      let tId = booking.therapist_id;
      if (therapistsForService(service.id).length) {
        const t = pickTherapist(spa.id, service.id, date, chosen.start_time, chosen.end_time, topts, booking.id);
        if (!t) return sendJSON(res, 409, { error: 'No matching therapist is free then. Please pick another time.' });
        tId = t.id;
      }
      db.prepare('UPDATE bookings SET booking_date = ?, start_time = ?, end_time = ?, therapist_id = ?, rescheduled_count = rescheduled_count + 1, reminder_sent = 0 WHERE id = ?')
        .run(date, chosen.start_time, chosen.end_time, tId, booking.id);
      const updated = db.prepare('SELECT * FROM bookings WHERE id = ?').get(booking.id);
      try { await notifier.sendBookingConfirmations({ booking: updated, customer: db.prepare('SELECT * FROM users WHERE id = ?').get(user.id), spa, service }); } catch { /* non-fatal */ }
      return sendJSON(res, 200, { message: 'Booking rescheduled. A new confirmation is on its way.', booking: updated });
    }

    // ---------------- PROFILE (customers & partners) ----------------
    if (parts[1] === 'me' && parts.length === 2 && req.method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      const name = body.name !== undefined ? String(body.name).trim() : u.name;
      const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : u.email;
      if (name.length < 2 || name.length > 80) return sendJSON(res, 400, { error: 'Please enter your full name.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Enter a valid email address.' });
      if (db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, u.id)) return sendJSON(res, 409, { error: 'Another account already uses this email.' });
      db.prepare('UPDATE users SET name = ?, email = ? WHERE id = ?').run(name, email, u.id);
      const fresh = db.prepare('SELECT * FROM users WHERE id = ?').get(u.id);
      return sendJSON(res, 200, { message: 'Profile saved.', user: publicUser(fresh), token: sign({ id: fresh.id, role: fresh.role, name: fresh.name }) });
    }
    if (parts[1] === 'me' && parts[2] === 'password' && req.method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      if (!checkRateLimit(req, { keyPrefix: 'pw_change', maxRequests: 10, windowMs: 15 * 60 * 1000 })) return sendJSON(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
      const body = await parseBody(req);
      const u = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
      if (!verifyPassword(String(body.currentPassword || ''), u.password_salt, u.password_hash)) return sendJSON(res, 400, { error: 'Your current password is incorrect.' });
      if (typeof body.newPassword !== 'string' || body.newPassword.length < 8 || body.newPassword.length > 200) return sendJSON(res, 400, { error: 'New password must be at least 8 characters.' });
      const { hash, salt } = hashPassword(body.newPassword);
      db.prepare("UPDATE users SET password_hash = ?, password_salt = ?, password_changed_at = datetime('now') WHERE id = ?").run(hash, salt, u.id);
      return sendJSON(res, 200, { message: 'Password changed. Other devices have been signed out.', token: sign({ id: u.id, role: u.role, name: u.name }), user: publicUser(u) });
    }
    if (parts[1] === 'me' && parts[2] === 'phone' && req.method === 'PUT') {
      const user = requireAuth(req, res);
      if (!user) return;
      const body = await parseBody(req);
      const phone = normalizePhone(body.phone);
      if (!phone || phone.length < 10) return sendJSON(res, 400, { error: 'Enter a valid mobile number.' });
      if (db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, user.id)) return sendJSON(res, 409, { error: 'Another account already uses this number.' });
      const verified = otpAvailable();
      if (verified) { const r = verifyOtp(phone, body.otpCode, 'registration'); if (!r.valid) return sendJSON(res, 400, { error: r.error }); }
      db.prepare('UPDATE users SET phone = ?, phone_verified = ? WHERE id = ?').run(phone, verified ? 1 : 0, user.id);
      return sendJSON(res, 200, { message: 'Mobile number updated.', user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    }

    if (parts[1] === 'bookings' && parts[3] === 'cancel' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (!['pending_payment', 'confirmed'].includes(booking.status)) {
        return sendJSON(res, 409, { error: 'This booking cannot be cancelled.' });
      }
      if (booking.booking_date < localNow().date || booking.settlement_id) {
        return sendJSON(res, 409, { error: 'Past appointments can no longer be cancelled. Please contact support.' });
      }
      const bspa = db.prepare('SELECT * FROM spas WHERE id = ?').get(booking.spa_id);
      if (!withinChangeWindow(booking, bspa)) {
        return sendJSON(res, 409, { error: `Free cancellation ended ${bspa.cancel_window_hours} hours before your appointment. Please call the spa.` });
      }

      let refundMessage = '';
      let paymentStatus = booking.payment_status;
      const payment = booking.payment_status === 'paid'
        ? db.prepare("SELECT * FROM payments WHERE booking_id = ? AND status = 'success' AND transaction_ref NOT LIKE 'COUNTER_%' ORDER BY id DESC LIMIT 1").get(booking.id) : null;
      if (payment && payment.amount > 0) {
        const refundResult = await gateway.refund({ transactionRef: payment.transaction_ref, amount: payment.amount, reverseAll: !!booking.route_transfer });
        if (refundResult.success) { paymentStatus = 'refunded'; refundMessage = ` ₹${payment.amount} refund initiated.`; }
        else refundMessage = ' The online refund could not be processed automatically — our team will refund you manually.';
      } else if (booking.payment_status === 'paid') paymentStatus = 'refunded';
      if (booking.gift_card_id && booking.giftcard_amount > 0) { restoreGift(booking); refundMessage += ` ₹${booking.giftcard_amount} returned to your gift card.`; }
      if (booking.customer_package_id) {
        db.prepare('UPDATE customer_packages SET sessions_used = MAX(0, sessions_used - 1) WHERE id = ?').run(booking.customer_package_id);
        refundMessage += ' Your package session has been returned.';
      }
      db.prepare("UPDATE bookings SET status='cancelled', payment_status=? WHERE id = ?").run(paymentStatus, booking.id);
      return sendJSON(res, 200, { message: 'Booking cancelled.' + refundMessage });
    }

    // ---------------- OWNER ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spas = db.prepare('SELECT * FROM spas WHERE owner_id = ? ORDER BY created_at DESC').all(user.id);
      return sendJSON(res, 200, { spas: spas.map(publicSpa) });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts.length === 3 && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const body = await parseBody(req);
      const { name, description, city, address, phone, opening_time, closing_time, cover_emoji } = body;
      if (!name || !city) return sendJSON(res, 400, { error: 'name and city are required.' });
      if ((opening_time || '10:00') >= (closing_time || '20:00')) return sendJSON(res, 400, { error: 'Closing time must be after opening time.' });
      const latitude = body.latitude !== undefined && body.latitude !== '' ? Number(body.latitude) : null;
      const longitude = body.longitude !== undefined && body.longitude !== '' ? Number(body.longitude) : null;
      if ((latitude !== null && (isNaN(latitude) || latitude < -90 || latitude > 90)) ||
          (longitude !== null && (isNaN(longitude) || longitude < -180 || longitude > 180))) {
        return sendJSON(res, 400, { error: 'Invalid coordinates.' });
      }
      const info = db.prepare(
        `INSERT INTO spas (owner_id, name, description, city, address, phone, opening_time, closing_time, cover_emoji, latitude, longitude, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?, 'pending')`
      ).run(user.id, name, description || '', city, address || '', phone || '', opening_time || '10:00', closing_time || '20:00', cover_emoji || '💆', latitude, longitude);
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(info.lastInsertRowid);
      return sendJSON(res, 201, { spa: publicSpa(spa), message: 'Spa submitted. It will appear publicly once approved by admin.' });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      if (body.latitude !== undefined) {
        const lat = body.latitude === '' ? null : Number(body.latitude);
        if (lat !== null && (isNaN(lat) || lat < -90 || lat > 90)) return sendJSON(res, 400, { error: 'Invalid latitude.' });
        body.latitude = lat;
      }
      if (body.longitude !== undefined) {
        const lng = body.longitude === '' ? null : Number(body.longitude);
        if (lng !== null && (isNaN(lng) || lng < -180 || lng > 180)) return sendJSON(res, 400, { error: 'Invalid longitude.' });
        body.longitude = lng;
      }
      if (body.name !== undefined && !String(body.name).trim()) return sendJSON(res, 400, { error: 'Spa name can’t be empty.' });
      if (body.city !== undefined && !String(body.city).trim()) return sendJSON(res, 400, { error: 'City can’t be empty.' });
      if (body.weekly_off !== undefined) {
        const days = String(body.weekly_off).split(',').filter((x) => x !== '').map(Number);
        if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6) || new Set(days).size > 6) return sendJSON(res, 400, { error: 'Choose valid weekly off days (at least one open day).' });
        body.weekly_off = [...new Set(days)].sort().join(',');
      }
      if (body.cancel_window_hours !== undefined) {
        const h = Number(body.cancel_window_hours);
        if (!Number.isInteger(h) || h < 0 || h > 72) return sendJSON(res, 400, { error: 'Free-cancellation window must be between 0 and 72 hours.' });
        body.cancel_window_hours = h;
      }
      const newOpen = body.opening_time ?? spa.opening_time, newClose = body.closing_time ?? spa.closing_time;
      if (!/^\d{2}:\d{2}$/.test(newOpen) || !/^\d{2}:\d{2}$/.test(newClose) || newOpen >= newClose) return sendJSON(res, 400, { error: 'Closing time must be after opening time.' });
      if (body.gstin !== undefined) {
        body.gstin = String(body.gstin || '').trim().toUpperCase() || null;
        if (body.gstin && !GSTIN_RE.test(body.gstin)) return sendJSON(res, 400, { error: 'That GSTIN doesn’t look right — it has 15 characters, like 36ABCDE1234F1Z5.' });
      }
      if (body.gst_rate !== undefined && ![5, 12, 18].includes(Number(body.gst_rate))) return sendJSON(res, 400, { error: 'GST rate must be 5%, 12% or 18%.' });
      if (body.gst_rate !== undefined) body.gst_rate = Number(body.gst_rate);
      const fields = ['name', 'description', 'city', 'address', 'phone', 'opening_time', 'closing_time', 'cover_emoji', 'latitude', 'longitude', 'weekly_off', 'cancel_window_hours', 'legal_name', 'gstin', 'gst_rate'];
      const updates = [];
      const args = [];
      for (const f of fields) {
        if (body[f] !== undefined) { updates.push(`${f} = ?`); args.push(body[f]); }
      }
      if (updates.length) {
        args.push(spa.id);
        db.prepare(`UPDATE spas SET ${updates.join(', ')} WHERE id = ?`).run(...args);
      }
      const updated = db.prepare('SELECT * FROM spas WHERE id = ?').get(spa.id);
      return sendJSON(res, 200, { spa: publicSpa(updated) });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'services' && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const services = db.prepare(
        `SELECT sv.*, rt.name as room_type_name, rt.capacity as room_type_capacity
         FROM services sv LEFT JOIN room_types rt ON rt.id = sv.room_type_id
         WHERE sv.spa_id = ? ORDER BY sv.created_at DESC`
      ).all(spa.id).map(withDiscount);
      return sendJSON(res, 200, { services });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'services' && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const { name, description, duration_minutes, price } = body;
      let discount_percent = Number(body.discount_percent) || 0;
      if (discount_percent < 0 || discount_percent > 90) return sendJSON(res, 400, { error: 'Discount must be between 0 and 90%.' });
      if (!name || !duration_minutes || !price) return sendJSON(res, 400, { error: 'name, duration_minutes and price are required.' });
      if (!(Number(price) > 0 && Number(price) <= 1000000)) return sendJSON(res, 400, { error: 'Price must be a positive amount.' });
      if (!(Number.isInteger(Number(duration_minutes)) && duration_minutes >= 15 && duration_minutes <= 480)) return sendJSON(res, 400, { error: 'Duration must be between 15 and 480 minutes.' });
      let room_type_id = body.room_type_id ? Number(body.room_type_id) : null;
      if (room_type_id) {
        const rt = db.prepare('SELECT id FROM room_types WHERE id = ? AND spa_id = ?').get(room_type_id, spa.id);
        if (!rt) return sendJSON(res, 400, { error: 'Invalid room type.' });
      }
      const info = db.prepare(
        'INSERT INTO services (spa_id, name, description, duration_minutes, price, discount_percent, room_type_id) VALUES (?,?,?,?,?,?,?)'
      ).run(spa.id, name, description || '', duration_minutes, price, discount_percent, room_type_id);
      const service = withDiscount(db.prepare('SELECT * FROM services WHERE id = ?').get(info.lastInsertRowid));
      return sendJSON(res, 201, { service });
    }

    if (parts[1] === 'owner' && parts[2] === 'services' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const service = db.prepare(
        `SELECT sv.* FROM services sv JOIN spas s ON s.id = sv.spa_id WHERE sv.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!service) return sendJSON(res, 404, { error: 'Service not found.' });
      const body = await parseBody(req);
      if (body.discount_percent !== undefined) {
        const d = Number(body.discount_percent);
        if (isNaN(d) || d < 0 || d > 90) return sendJSON(res, 400, { error: 'Discount must be between 0 and 90%.' });
      }
      if (body.room_type_id !== undefined && body.room_type_id !== null && body.room_type_id !== '') {
        const rt = db.prepare('SELECT id FROM room_types WHERE id = ? AND spa_id = ?').get(Number(body.room_type_id), service.spa_id);
        if (!rt) return sendJSON(res, 400, { error: 'Invalid room type.' });
        body.room_type_id = Number(body.room_type_id);
      } else if (body.room_type_id === '') {
        body.room_type_id = null;
      }
      if (body.name !== undefined && !String(body.name).trim()) return sendJSON(res, 400, { error: 'Service name can’t be empty.' });
      if (body.price !== undefined && !(Number(body.price) > 0 && Number(body.price) <= 1000000)) return sendJSON(res, 400, { error: 'Price must be a positive amount.' });
      if (body.duration_minutes !== undefined && !(Number.isInteger(Number(body.duration_minutes)) && Number(body.duration_minutes) >= 15 && Number(body.duration_minutes) <= 480)) return sendJSON(res, 400, { error: 'Duration must be between 15 and 480 minutes.' });
      if (body.price !== undefined) body.price = Number(body.price);
      if (body.duration_minutes !== undefined) body.duration_minutes = Number(body.duration_minutes);
      const fields = ['name', 'description', 'duration_minutes', 'price', 'active', 'discount_percent', 'room_type_id'];
      const updates = [];
      const args = [];
      for (const f of fields) {
        if (body[f] !== undefined) { updates.push(`${f} = ?`); args.push(body[f]); }
      }
      if (updates.length) {
        args.push(service.id);
        db.prepare(`UPDATE services SET ${updates.join(', ')} WHERE id = ?`).run(...args);
      }
      const updated = withDiscount(db.prepare('SELECT * FROM services WHERE id = ?').get(service.id));
      return sendJSON(res, 200, { service: updated });
    }

    if (parts[1] === 'owner' && parts[2] === 'services' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const service = db.prepare(
        `SELECT sv.* FROM services sv JOIN spas s ON s.id = sv.spa_id WHERE sv.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!service) return sendJSON(res, 404, { error: 'Service not found.' });
      db.prepare('UPDATE services SET active = 0 WHERE id = ?').run(service.id);
      return sendJSON(res, 200, { message: 'Service removed.' });
    }

    // ---------------- OWNER: PHOTOS & VIDEOS ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'media' && parts.length === 5 && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const media = db.prepare('SELECT * FROM spa_media WHERE spa_id = ? ORDER BY is_cover DESC, created_at ASC').all(spa.id);
      return sendJSON(res, 200, { media });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'media' && parts.length === 5 && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });

      const existingCount = db.prepare('SELECT COUNT(*) c FROM spa_media WHERE spa_id = ?').get(spa.id).c;
      if (existingCount >= 12) return sendJSON(res, 400, { error: 'Maximum of 12 photos/videos per spa. Remove some before adding more.' });

      let body;
      try {
        body = await parseBodyWithLimit(req, MAX_UPLOAD_BYTES);
      } catch (e) {
        return sendJSON(res, e.status || 400, { error: e.message });
      }
      if (!body.dataUrl) return sendJSON(res, 400, { error: 'No file data received.' });

      let saved;
      try {
        saved = saveDataUrlToFile(spa.id, body.dataUrl);
      } catch (e) {
        return sendJSON(res, e.status || 400, { error: e.message });
      }

      const isFirstImage = saved.type === 'image' && existingCount === 0;
      const info = db.prepare('INSERT INTO spa_media (spa_id, type, url, is_cover) VALUES (?,?,?,?)')
        .run(spa.id, saved.type, saved.url, isFirstImage ? 1 : 0);
      const media = db.prepare('SELECT * FROM spa_media WHERE id = ?').get(info.lastInsertRowid);
      return sendJSON(res, 201, { media });
    }

    if (parts[1] === 'owner' && parts[2] === 'media' && parts[4] === 'cover' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const media = db.prepare(
        `SELECT m.* FROM spa_media m JOIN spas s ON s.id = m.spa_id WHERE m.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!media) return sendJSON(res, 404, { error: 'Photo not found.' });
      if (media.type !== 'image') return sendJSON(res, 400, { error: 'Only photos can be set as the cover image.' });
      db.prepare('UPDATE spa_media SET is_cover = 0 WHERE spa_id = ?').run(media.spa_id);
      db.prepare('UPDATE spa_media SET is_cover = 1 WHERE id = ?').run(media.id);
      return sendJSON(res, 200, { message: 'Cover photo updated.' });
    }

    if (parts[1] === 'owner' && parts[2] === 'media' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const media = db.prepare(
        `SELECT m.* FROM spa_media m JOIN spas s ON s.id = m.spa_id WHERE m.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!media) return sendJSON(res, 404, { error: 'Photo/video not found.' });
      db.prepare('DELETE FROM spa_media WHERE id = ?').run(media.id);
      try {
        const filePath = path.join(__dirname, '..', 'public', media.url);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      } catch (e) { /* non-fatal */ }
      // If we deleted the cover photo, promote the next available image automatically
      if (media.is_cover) {
        const next = db.prepare("SELECT id FROM spa_media WHERE spa_id = ? AND type='image' ORDER BY created_at ASC LIMIT 1").get(media.spa_id);
        if (next) db.prepare('UPDATE spa_media SET is_cover = 1 WHERE id = ?').run(next.id);
      }
      return sendJSON(res, 200, { message: 'Removed.' });
    }

    // ---------------- OWNER: ROOM TYPES (capacity management) ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'room-types' && parts.length === 5 && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const roomTypes = db.prepare(
        `SELECT rt.*, (SELECT COUNT(*) FROM services WHERE room_type_id = rt.id AND active = 1) as service_count
         FROM room_types rt WHERE rt.spa_id = ? ORDER BY rt.created_at ASC`
      ).all(spa.id);
      return sendJSON(res, 200, { roomTypes });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'room-types' && parts.length === 5 && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const capacity = Number(body.capacity);
      if (!body.name || !capacity || capacity < 1) return sendJSON(res, 400, { error: 'Room type name and a capacity of at least 1 are required.' });
      const info = db.prepare('INSERT INTO room_types (spa_id, name, capacity) VALUES (?,?,?)').run(spa.id, body.name.trim(), Math.floor(capacity));
      const roomType = db.prepare('SELECT * FROM room_types WHERE id = ?').get(info.lastInsertRowid);
      return sendJSON(res, 201, { roomType });
    }

    if (parts[1] === 'owner' && parts[2] === 'room-types' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const roomType = db.prepare(
        `SELECT rt.* FROM room_types rt JOIN spas s ON s.id = rt.spa_id WHERE rt.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!roomType) return sendJSON(res, 404, { error: 'Room type not found.' });
      const body = await parseBody(req);
      const updates = [];
      const args = [];
      if (body.name !== undefined) { updates.push('name = ?'); args.push(body.name.trim()); }
      if (body.capacity !== undefined) {
        const capacity = Number(body.capacity);
        if (!capacity || capacity < 1) return sendJSON(res, 400, { error: 'Capacity must be at least 1.' });
        updates.push('capacity = ?'); args.push(Math.floor(capacity));
      }
      if (updates.length) {
        args.push(roomType.id);
        db.prepare(`UPDATE room_types SET ${updates.join(', ')} WHERE id = ?`).run(...args);
      }
      const updated = db.prepare('SELECT * FROM room_types WHERE id = ?').get(roomType.id);
      return sendJSON(res, 200, { roomType: updated });
    }

    if (parts[1] === 'owner' && parts[2] === 'room-types' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const roomType = db.prepare(
        `SELECT rt.* FROM room_types rt JOIN spas s ON s.id = rt.spa_id WHERE rt.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!roomType) return sendJSON(res, 404, { error: 'Room type not found.' });
      // Unassign any services pointing to this room type rather than blocking deletion
      db.prepare('UPDATE services SET room_type_id = NULL WHERE room_type_id = ?').run(roomType.id);
      db.prepare('DELETE FROM room_types WHERE id = ?').run(roomType.id);
      return sendJSON(res, 200, { message: 'Room type removed. Any services using it now have no room limit.' });
    }

    // ---------------- OWNER: COUPONS ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'coupons' && parts.length === 5 && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const coupons = db.prepare(
        `SELECT c.*, sv.name as service_name FROM coupons c LEFT JOIN services sv ON sv.id = c.service_id
         WHERE c.spa_id = ? ORDER BY c.created_at DESC`
      ).all(spa.id);
      return sendJSON(res, 200, { coupons });
    }

    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'coupons' && parts.length === 5 && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const code = (body.code || '').trim().toUpperCase();
      const discountType = body.discount_type;
      const discountValue = Number(body.discount_value);

      if (!code || !/^[A-Z0-9_-]{3,20}$/.test(code)) return sendJSON(res, 400, { error: 'Coupon code must be 3-20 letters/numbers (no spaces).' });
      if (!['percent', 'flat'].includes(discountType)) return sendJSON(res, 400, { error: 'Discount type must be percent or flat.' });
      if (!discountValue || discountValue <= 0) return sendJSON(res, 400, { error: 'Enter a discount value greater than 0.' });
      if (discountType === 'percent' && discountValue > 90) return sendJSON(res, 400, { error: 'Percentage discounts must be 90% or less.' });
      if (body.valid_from && body.valid_to && body.valid_from > body.valid_to) return sendJSON(res, 400, { error: 'Valid-from date must be before valid-to date.' });
      if (body.start_time && body.end_time && body.start_time >= body.end_time) return sendJSON(res, 400, { error: 'Start time must be before end time.' });

      let serviceId = null;
      if (body.service_id) {
        const sv = db.prepare('SELECT id FROM services WHERE id = ? AND spa_id = ?').get(body.service_id, spa.id);
        if (!sv) return sendJSON(res, 400, { error: 'Invalid service.' });
        serviceId = sv.id;
      }

      const existing = db.prepare('SELECT id FROM coupons WHERE spa_id = ? AND code = ? COLLATE NOCASE').get(spa.id, code);
      if (existing) return sendJSON(res, 409, { error: 'A coupon with this code already exists for this spa.' });

      const info = db.prepare(
        `INSERT INTO coupons (spa_id, service_id, code, discount_type, discount_value, valid_from, valid_to, start_time, end_time, max_uses)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).run(
        spa.id, serviceId, code, discountType, discountValue,
        body.valid_from || null, body.valid_to || null,
        body.start_time || null, body.end_time || null,
        body.max_uses ? Number(body.max_uses) : null
      );
      const coupon = db.prepare('SELECT * FROM coupons WHERE id = ?').get(info.lastInsertRowid);
      return sendJSON(res, 201, { coupon });
    }

    if (parts[1] === 'owner' && parts[2] === 'coupons' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const coupon = db.prepare(
        `SELECT c.* FROM coupons c JOIN spas s ON s.id = c.spa_id WHERE c.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!coupon) return sendJSON(res, 404, { error: 'Coupon not found.' });
      const body = await parseBody(req);
      if (body.active !== undefined) {
        db.prepare('UPDATE coupons SET active = ? WHERE id = ?').run(body.active ? 1 : 0, coupon.id);
      }
      const updated = db.prepare('SELECT * FROM coupons WHERE id = ?').get(coupon.id);
      return sendJSON(res, 200, { coupon: updated });
    }

    if (parts[1] === 'owner' && parts[2] === 'coupons' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const coupon = db.prepare(
        `SELECT c.* FROM coupons c JOIN spas s ON s.id = c.spa_id WHERE c.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!coupon) return sendJSON(res, 404, { error: 'Coupon not found.' });
      db.prepare('DELETE FROM coupons WHERE id = ?').run(coupon.id);
      return sendJSON(res, 200, { message: 'Coupon deleted.' });
    }

    if (parts[1] === 'owner' && parts[2] === 'bookings' && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      cleanupStaleBookings();
      const rows = db.prepare(
        `SELECT b.*, s.name as spa_name, sv.name as service_name, u.name as customer_name, u.phone as customer_phone, (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name
         FROM bookings b
         JOIN spas s ON s.id = b.spa_id
         JOIN services sv ON sv.id = b.service_id
         JOIN users u ON u.id = b.customer_id
         WHERE s.owner_id = ?
         ORDER BY b.booking_date DESC, b.start_time DESC`
      ).all(user.id);
      return sendJSON(res, 200, { bookings: rows });
    }

    if (parts[1] === 'owner' && parts[2] === 'bookings' && parts[4] === 'status' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const booking = db.prepare(
        `SELECT b.* FROM bookings b JOIN spas s ON s.id = b.spa_id WHERE b.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      const body = await parseBody(req);
      if (!['completed', 'cancelled', 'no_show'].includes(body.status)) return sendJSON(res, 400, { error: 'Invalid status.' });
      if (booking.settlement_id) return sendJSON(res, 409, { error: 'This booking is already settled and can no longer be changed.' });
      if (body.status === 'no_show') {
        if (booking.payment_mode !== 'pay_at_venue' || booking.payment_status === 'paid') return sendJSON(res, 400, { error: 'Only unpaid pay-at-spa bookings can be marked as a no-show.' });
        if (booking.booking_date > localNow().date) return sendJSON(res, 400, { error: "You can't mark a no-show before the appointment date." });
        db.prepare("UPDATE bookings SET status = 'cancelled', cancel_reason = 'no_show' WHERE id = ?").run(booking.id);
      } else {
        db.prepare('UPDATE bookings SET status = ?, cancel_reason = ? WHERE id = ?').run(body.status, body.status === 'cancelled' ? 'owner' : null, booking.id);
      }
      return sendJSON(res, 200, { message: 'Booking updated.' });
    }

    if (parts[1] === 'owner' && parts[2] === 'bookings' && parts[4] === 'mark-paid' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const booking = db.prepare(
        `SELECT b.* FROM bookings b JOIN spas s ON s.id = b.spa_id WHERE b.id = ? AND s.owner_id = ?`
      ).get(parts[3], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (booking.payment_status === 'paid') return sendJSON(res, 409, { error: 'This booking is already marked as paid.' });
      if (!['confirmed', 'completed'].includes(booking.status)) {
        return sendJSON(res, 409, { error: 'Only confirmed or completed bookings can be marked as paid.' });
      }
      const body = await parseBody(req);
      const method = ['cash', 'card', 'upi'].includes(body.method) ? body.method : 'cash';

      db.prepare('INSERT INTO payments (booking_id, amount, method, status, transaction_ref) VALUES (?,?,?,?,?)')
        .run(booking.id, booking.amount, method, 'success', 'COUNTER_' + crypto.randomBytes(6).toString('hex').toUpperCase());
      db.prepare("UPDATE bookings SET payment_status = 'paid' WHERE id = ?").run(booking.id);

      return sendJSON(res, 200, { message: `Marked as paid (${method}).` });
    }

    // ---------------- REVIEWS ----------------
    // Public: approved spa's visible reviews + summary
    if (parts[1] === 'spas' && parts[3] === 'reviews' && req.method === 'GET') {
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(parts[2]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const reviews = db.prepare(
        `SELECT r.id, r.rating, r.comment, r.owner_reply, r.owner_replied_at, r.created_at, u.name AS customer_name, sv.name AS service_name, b.booking_date
         FROM reviews r JOIN users u ON u.id = r.customer_id JOIN bookings b ON b.id = r.booking_id JOIN services sv ON sv.id = b.service_id
         WHERE r.spa_id = ? AND r.hidden = 0 ORDER BY r.created_at DESC LIMIT 100`
      ).all(spa.id).map((r) => ({ ...r, customer_name: (r.customer_name || 'Customer').split(' ')[0] })); // first name only, for privacy
      const breakdown = { 5: 0, 4: 0, 3: 0, 2: 0, 1: 0 };
      for (const row of db.prepare('SELECT rating, COUNT(*) c FROM reviews WHERE spa_id = ? AND hidden = 0 GROUP BY rating').all(spa.id)) breakdown[row.rating] = row.c;
      return sendJSON(res, 200, { summary: { rating: spa.rating_count ? Math.round(spa.rating_avg * 10) / 10 : null, count: spa.rating_count || 0, breakdown }, reviews });
    }

    // Customer: review a visit they actually made
    if (parts[1] === 'bookings' && parts[3] === 'review' && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!booking) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (db.prepare('SELECT id FROM reviews WHERE booking_id = ?').get(booking.id)) return sendJSON(res, 409, { error: 'You have already reviewed this visit.' });
      if (!reviewEligible(booking)) return sendJSON(res, 400, { error: 'You can review a visit after your appointment (within 60 days).' });
      const body = await parseBody(req);
      const rating = Number(body.rating);
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return sendJSON(res, 400, { error: 'Please choose a rating from 1 to 5 stars.' });
      const comment = String(body.comment || '').slice(0, 1000);
      db.prepare('INSERT INTO reviews (booking_id, spa_id, customer_id, rating, comment) VALUES (?,?,?,?,?)').run(booking.id, booking.spa_id, user.id, rating, comment);
      recomputeSpaRating(booking.spa_id);
      return sendJSON(res, 201, { message: 'Thanks for your review!' });
    }

    if (parts[1] === 'owner' && parts[2] === 'reviews' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const reviews = db.prepare(
        `SELECT r.*, s.name AS spa_name, u.name AS customer_name, sv.name AS service_name, b.booking_date
         FROM reviews r JOIN spas s ON s.id = r.spa_id JOIN users u ON u.id = r.customer_id JOIN bookings b ON b.id = r.booking_id JOIN services sv ON sv.id = b.service_id
         WHERE s.owner_id = ? ORDER BY r.created_at DESC LIMIT 200`
      ).all(user.id).map((r) => ({ ...r, customer_name: (r.customer_name || 'Customer').split(' ')[0] }));
      return sendJSON(res, 200, { reviews });
    }

    if (parts[1] === 'owner' && parts[2] === 'reviews' && parts[4] === 'reply' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const review = db.prepare('SELECT r.* FROM reviews r JOIN spas s ON s.id = r.spa_id WHERE r.id = ? AND s.owner_id = ?').get(parts[3], user.id);
      if (!review) return sendJSON(res, 404, { error: 'Review not found.' });
      const body = await parseBody(req);
      const reply = String(body.reply || '').slice(0, 500);
      db.prepare("UPDATE reviews SET owner_reply = ?, owner_replied_at = datetime('now') WHERE id = ?").run(reply || null, review.id);
      return sendJSON(res, 200, { message: reply ? 'Reply posted.' : 'Reply removed.' });
    }

    if (parts[1] === 'admin' && parts[2] === 'reviews' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const reviews = db.prepare(
        `SELECT r.*, s.name AS spa_name, u.name AS customer_name, u.email AS customer_email
         FROM reviews r JOIN spas s ON s.id = r.spa_id JOIN users u ON u.id = r.customer_id ORDER BY r.created_at DESC LIMIT 300`
      ).all();
      return sendJSON(res, 200, { reviews });
    }

    if (parts[1] === 'admin' && parts[2] === 'reviews' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const review = db.prepare('SELECT * FROM reviews WHERE id = ?').get(parts[3]);
      if (!review) return sendJSON(res, 404, { error: 'Review not found.' });
      const body = await parseBody(req);
      db.prepare('UPDATE reviews SET hidden = ? WHERE id = ?').run(body.hidden ? 1 : 0, review.id);
      recomputeSpaRating(review.spa_id);
      return sendJSON(res, 200, { message: body.hidden ? 'Review hidden.' : 'Review visible again.' });
    }

    // ---------------- ADMIN: FEATURED PLACEMENTS ----------------
    if (parts[1] === 'admin' && parts[2] === 'featured' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const today = localNow().date;
      const placements = db.prepare(
        `SELECT f.*, s.name AS spa_name, s.city AS spa_city, u.name AS owner_name FROM featured_placements f JOIN spas s ON s.id = f.spa_id JOIN users u ON u.id = s.owner_id ORDER BY f.starts_on DESC, f.id DESC`
      ).all().map((f) => ({ ...f, state: f.cancelled ? 'cancelled' : f.ends_on < today ? 'expired' : f.starts_on > today ? 'upcoming' : 'active' }));
      const spas = db.prepare("SELECT id, name, city FROM spas WHERE status = 'approved' AND suspended = 0 ORDER BY name").all();
      return sendJSON(res, 200, { placements, spas, today });
    }

    if (parts[1] === 'admin' && parts[2] === 'featured' && parts.length === 3 && req.method === 'POST') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const body = await parseBody(req);
      const spa = db.prepare("SELECT * FROM spas WHERE id = ? AND status = 'approved' AND suspended = 0").get(body.spa_id);
      if (!spa) return sendJSON(res, 400, { error: 'Choose an approved (live) spa.' });
      if (!isValidDate(body.starts_on) || !isValidDate(body.ends_on)) return sendJSON(res, 400, { error: 'Enter valid start and end dates.' });
      if (body.ends_on < body.starts_on) return sendJSON(res, 400, { error: 'End date must be on or after the start date.' });
      const amount = Number(body.amount || 0);
      if (!(amount >= 0 && amount <= 10000000)) return sendJSON(res, 400, { error: 'Enter a valid amount.' });
      const info = db.prepare('INSERT INTO featured_placements (spa_id, starts_on, ends_on, amount, reference, note) VALUES (?,?,?,?,?,?)')
        .run(spa.id, body.starts_on, body.ends_on, amount, String(body.reference || '').slice(0, 120), String(body.note || '').slice(0, 300));
      return sendJSON(res, 201, { message: `${spa.name} will be featured ${body.starts_on} → ${body.ends_on}.`, id: Number(info.lastInsertRowid) });
    }

    if (parts[1] === 'admin' && parts[2] === 'featured' && parts[4] === 'cancel' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const f = db.prepare('SELECT * FROM featured_placements WHERE id = ?').get(parts[3]);
      if (!f) return sendJSON(res, 404, { error: 'Placement not found.' });
      db.prepare('UPDATE featured_placements SET cancelled = 1 WHERE id = ?').run(f.id);
      return sendJSON(res, 200, { message: 'Placement cancelled.' });
    }

    // ---------------- OWNER: CLOSED DATES ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'closures' && ['GET', 'POST'].includes(req.method)) {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      if (req.method === 'POST') {
        const body = await parseBody(req);
        if (!isValidDate(body.date) || body.date < localNow().date) return sendJSON(res, 400, { error: 'Choose today or a future date.' });
        db.prepare('INSERT OR IGNORE INTO spa_closures (spa_id, date, reason) VALUES (?,?,?)').run(spa.id, body.date, String(body.reason || '').slice(0, 120));
        const affected = db.prepare("SELECT COUNT(*) c FROM bookings WHERE spa_id = ? AND booking_date = ? AND status IN ('confirmed','pending_payment')").get(spa.id, body.date).c;
        return sendJSON(res, 201, { message: affected ? `Closed on that date. ${affected} existing booking(s) on that day are kept — please contact those customers.` : 'Closed on that date.', affected });
      }
      return sendJSON(res, 200, { closures: db.prepare('SELECT * FROM spa_closures WHERE spa_id = ? AND date >= ? ORDER BY date').all(spa.id, localNow().date) });
    }
    if (parts[1] === 'owner' && parts[2] === 'closures' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const c = db.prepare('SELECT c.* FROM spa_closures c JOIN spas s ON s.id = c.spa_id WHERE c.id = ? AND s.owner_id = ?').get(parts[3], user.id);
      if (!c) return sendJSON(res, 404, { error: 'Not found.' });
      db.prepare('DELETE FROM spa_closures WHERE id = ?').run(c.id);
      return sendJSON(res, 200, { message: 'Open again on that date.' });
    }

    // ---------------- OWNER: CALENDAR & WALK-INS ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'calendar' && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const date = query.get('date') || localNow().date;
      if (!isValidDate(date)) return sendJSON(res, 400, { error: 'Invalid date.' });
      const bookings = db.prepare(
        `SELECT b.id, b.booking_ref, b.start_time, b.end_time, b.status, b.payment_mode, b.payment_status, b.amount,
                sv.name AS service_name, sv.room_type_id, u.name AS customer_name, u.phone AS customer_phone, (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name
         FROM bookings b JOIN services sv ON sv.id = b.service_id JOIN users u ON u.id = b.customer_id
         WHERE b.spa_id = ? AND b.booking_date = ? AND b.status IN ('pending_payment','confirmed','completed') ORDER BY b.start_time`).all(spa.id, date);
      return sendJSON(res, 200, {
        spa: { id: spa.id, name: spa.name, opening_time: spa.opening_time, closing_time: spa.closing_time }, date, closed: closureReason(spa, date),
        roomTypes: db.prepare('SELECT id, name, capacity FROM room_types WHERE spa_id = ?').all(spa.id),
        bookings, blocks: db.prepare('SELECT * FROM slot_blocks WHERE spa_id = ? AND date = ? ORDER BY start_time').all(spa.id, date),
      });
    }
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'blocks' && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const { date, start_time: st, end_time: et } = body;
      if (!isValidDate(date) || date < localNow().date) return sendJSON(res, 400, { error: 'Choose today or a future date.' });
      if (!/^\d{2}:\d{2}$/.test(st || '') || !/^\d{2}:\d{2}$/.test(et || '') || st >= et) return sendJSON(res, 400, { error: 'End time must be after start time.' });
      if (st < spa.opening_time || et > spa.closing_time) return sendJSON(res, 400, { error: `Choose a time within opening hours (${spa.opening_time}–${spa.closing_time}).` });
      const s0 = timeToMinutes(st), e0 = timeToMinutes(et);
      const overlaps = (a, b) => timeToMinutes(a) < e0 && timeToMinutes(b) > s0;
      let roomTypeId = null, qty = 1;
      if (body.room_type_id) {
        const rt = db.prepare('SELECT * FROM room_types WHERE id = ? AND spa_id = ?').get(body.room_type_id, spa.id);
        if (!rt) return sendJSON(res, 400, { error: 'Choose a valid room type.' });
        roomTypeId = rt.id; qty = Number(body.qty || 1);
        if (!Number.isInteger(qty) || qty < 1 || qty > rt.capacity) return sendJSON(res, 400, { error: `Rooms must be between 1 and ${rt.capacity}.` });
        // Peak occupancy inside the requested window (bookings + existing blocks) must leave room for this block.
        const items = [
          ...db.prepare(`SELECT b.start_time, b.end_time, 1 AS q FROM bookings b JOIN services sv ON sv.id = b.service_id WHERE b.spa_id = ? AND b.booking_date = ? AND sv.room_type_id = ? AND b.status IN ('pending_payment','confirmed')`).all(spa.id, date, rt.id),
          ...db.prepare('SELECT start_time, end_time, qty AS q FROM slot_blocks WHERE spa_id = ? AND date = ? AND room_type_id = ?').all(spa.id, date, rt.id),
        ].filter((x) => overlaps(x.start_time, x.end_time));
        const points = [s0, ...items.map((x) => timeToMinutes(x.start_time))].filter((m) => m >= s0 && m < e0);
        const peak = Math.max(0, ...points.map((m) => items.filter((x) => timeToMinutes(x.start_time) <= m && timeToMinutes(x.end_time) > m).reduce((a, x) => a + x.q, 0)));
        if (peak + qty > rt.capacity) return sendJSON(res, 409, { error: `Only ${Math.max(0, rt.capacity - peak)} ${rt.name} free at the busiest point of that time.` });
      } else {
        const clash = db.prepare("SELECT COUNT(*) c FROM bookings WHERE spa_id = ? AND booking_date = ? AND status IN ('pending_payment','confirmed') AND start_time < ? AND end_time > ?").get(spa.id, date, et, st).c;
        if (clash) return sendJSON(res, 409, { error: `${clash} booking(s) already fall in that time. Block specific rooms instead, or reschedule those bookings first.` });
      }
      const info = db.prepare('INSERT INTO slot_blocks (spa_id, room_type_id, date, start_time, end_time, qty, reason) VALUES (?,?,?,?,?,?,?)')
        .run(spa.id, roomTypeId, date, st, et, qty, String(body.reason || 'Walk-in').slice(0, 80));
      return sendJSON(res, 201, { message: 'Time blocked — those slots are no longer bookable online.', id: Number(info.lastInsertRowid) });
    }
    if (parts[1] === 'owner' && parts[2] === 'blocks' && parts.length === 4 && req.method === 'DELETE') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const bl = db.prepare('SELECT bl.* FROM slot_blocks bl JOIN spas s ON s.id = bl.spa_id WHERE bl.id = ? AND s.owner_id = ?').get(parts[3], user.id);
      if (!bl) return sendJSON(res, 404, { error: 'Not found.' });
      db.prepare('DELETE FROM slot_blocks WHERE id = ?').run(bl.id);
      return sendJSON(res, 200, { message: 'Block removed — those slots are bookable again.' });
    }

    // ---------------- OWNER: THERAPISTS ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'therapists' && ['GET', 'POST'].includes(req.method)) {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      if (req.method === 'GET') {
        const list = db.prepare('SELECT * FROM therapists WHERE spa_id = ? ORDER BY active DESC, name').all(spa.id)
          .map((t) => ({ ...t, service_ids: db.prepare('SELECT service_id FROM therapist_services WHERE therapist_id = ?').all(t.id).map((r) => r.service_id),
                         upcoming: db.prepare("SELECT COUNT(*) c FROM bookings WHERE therapist_id = ? AND booking_date >= ? AND status IN ('confirmed','pending_payment')").get(t.id, localNow().date).c }));
        return sendJSON(res, 200, { therapists: list });
      }
      const body = await parseBody(req);
      const err = validateTherapist(body, spa.id); if (err) return sendJSON(res, 400, { error: err });
      const id = Number(db.prepare('INSERT INTO therapists (spa_id, name, gender, bio) VALUES (?,?,?,?)').run(spa.id, body.name.trim(), body.gender, String(body.bio || '').slice(0, 160)).lastInsertRowid);
      setTherapistServices(id, body.service_ids);
      return sendJSON(res, 201, { message: 'Therapist added.', id });
    }
    if (parts[1] === 'owner' && parts[2] === 'therapists' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const t = db.prepare('SELECT t.* FROM therapists t JOIN spas s ON s.id = t.spa_id WHERE t.id = ? AND s.owner_id = ?').get(parts[3], user.id);
      if (!t) return sendJSON(res, 404, { error: 'Therapist not found.' });
      const body = await parseBody(req);
      const merged = { name: body.name ?? t.name, gender: body.gender ?? t.gender, service_ids: body.service_ids ?? [] };
      const err = validateTherapist(merged, t.spa_id, body.service_ids === undefined); if (err) return sendJSON(res, 400, { error: err });
      db.prepare('UPDATE therapists SET name = ?, gender = ?, bio = ?, active = ? WHERE id = ?')
        .run(String(merged.name).trim(), merged.gender, body.bio !== undefined ? String(body.bio).slice(0, 160) : t.bio, body.active !== undefined ? (body.active ? 1 : 0) : t.active, t.id);
      if (body.service_ids !== undefined) setTherapistServices(t.id, body.service_ids);
      const upcoming = db.prepare("SELECT COUNT(*) c FROM bookings WHERE therapist_id = ? AND booking_date >= ? AND status IN ('confirmed','pending_payment')").get(t.id, localNow().date).c;
      return sendJSON(res, 200, { message: body.active === false && upcoming ? `Saved. ${upcoming} upcoming booking(s) are still assigned to ${t.name} — reassign or contact those customers.` : 'Saved.' });
    }

    // ---------------- OWNER: PACKAGES ----------------
    if (parts[1] === 'owner' && parts[2] === 'spas' && parts[4] === 'packages' && ['GET', 'POST'].includes(req.method)) {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ? AND owner_id = ?').get(parts[3], user.id);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      if (req.method === 'GET') {
        return sendJSON(res, 200, { packages: db.prepare(`SELECT p.*, sv.name AS service_name, sv.price AS service_price,
          (SELECT COUNT(*) FROM customer_packages cp WHERE cp.package_id = p.id AND cp.status = 'active') AS sold
          FROM packages p JOIN services sv ON sv.id = p.service_id WHERE p.spa_id = ? ORDER BY p.created_at DESC`).all(spa.id) });
      }
      const body = await parseBody(req);
      const err = validatePackage(body, spa.id); if (err) return sendJSON(res, 400, { error: err });
      db.prepare('INSERT INTO packages (spa_id, service_id, name, sessions, price, validity_days) VALUES (?,?,?,?,?,?)')
        .run(spa.id, Number(body.service_id), String(body.name).trim(), Number(body.sessions), Number(body.price), Number(body.validity_days || 180));
      return sendJSON(res, 201, { message: 'Package created — customers can buy it from your spa page.' });
    }
    if (parts[1] === 'owner' && parts[2] === 'packages' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const p = db.prepare('SELECT p.* FROM packages p JOIN spas s ON s.id = p.spa_id WHERE p.id = ? AND s.owner_id = ?').get(parts[3], user.id);
      if (!p) return sendJSON(res, 404, { error: 'Package not found.' });
      const body = await parseBody(req);
      const merged = { ...p, ...body };
      const err = validatePackage(merged, p.spa_id); if (err) return sendJSON(res, 400, { error: err });
      db.prepare('UPDATE packages SET name = ?, sessions = ?, price = ?, validity_days = ?, active = ? WHERE id = ?')
        .run(String(merged.name).trim(), Number(merged.sessions), Number(merged.price), Number(merged.validity_days), merged.active ? 1 : 0, p.id);
      return sendJSON(res, 200, { message: 'Package saved. Packages already bought keep their original terms.' });
    }

    // ---------------- CUSTOMER: GIFT CARDS, PACKAGES, WALLET ----------------
    if (parts[1] === 'giftcards' && parts.length === 2 && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      if (!onlinePaymentsAvailable()) return sendJSON(res, 400, { error: 'Gift cards can be bought once online payments are switched on.' });
      const body = await parseBody(req);
      const amount = Number(body.amount);
      if (!(Number.isInteger(amount) && amount >= 500 && amount <= 50000)) return sendJSON(res, 400, { error: 'Choose an amount between ₹500 and ₹50,000.' });
      const gid = Number(db.prepare('INSERT INTO gift_cards (amount, balance, purchaser_id, recipient_name, message) VALUES (?,?,?,?,?)')
        .run(amount, amount, user.id, String(body.recipient_name || '').slice(0, 60), String(body.message || '').slice(0, 200)).lastInsertRowid);
      const pid = Number(db.prepare("INSERT INTO purchases (customer_id, kind, ref_id, amount) VALUES (?, 'giftcard', ?, ?)").run(user.id, gid, amount).lastInsertRowid);
      return sendJSON(res, 201, { purchaseId: pid, amount });
    }
    if (parts[1] === 'packages' && parts[3] === 'buy' && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      if (!onlinePaymentsAvailable()) return sendJSON(res, 400, { error: 'Packages can be bought once online payments are switched on.' });
      const pk = db.prepare(`SELECT p.*, s.status AS spa_status, s.suspended FROM packages p JOIN spas s ON s.id = p.spa_id JOIN services sv ON sv.id = p.service_id
                             WHERE p.id = ? AND p.active = 1 AND sv.active = 1`).get(parts[2]);
      if (!pk || pk.spa_status !== 'approved' || pk.suspended) return sendJSON(res, 404, { error: 'This package isn’t available.' });
      const cpid = Number(db.prepare('INSERT INTO customer_packages (package_id, customer_id, spa_id, service_id, name, sessions_total, per_session_value, price_paid) VALUES (?,?,?,?,?,?,?,?)')
        .run(pk.id, user.id, pk.spa_id, pk.service_id, pk.name, pk.sessions, round2(pk.price / pk.sessions), pk.price).lastInsertRowid);
      const pid = Number(db.prepare("INSERT INTO purchases (customer_id, kind, ref_id, amount) VALUES (?, 'package', ?, ?)").run(user.id, cpid, pk.price).lastInsertRowid);
      return sendJSON(res, 201, { purchaseId: pid, amount: pk.price });
    }
    if (parts[1] === 'purchases' && ['checkout', 'verify'].includes(parts[3]) && req.method === 'POST') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const p = db.prepare('SELECT * FROM purchases WHERE id = ? AND customer_id = ?').get(parts[2], user.id);
      if (!p) return sendJSON(res, 404, { error: 'Purchase not found.' });
      if (p.status === 'paid') return sendJSON(res, 409, { error: 'This purchase is already paid.' });
      if (parts[3] === 'checkout') {
        try {
          const order = await gateway.createOrder({ amount: p.amount, receipt: `purchase_${p.id}` });
          const cu = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
          return sendJSON(res, 200, { ...order, purchaseId: p.id, prefill: { name: cu.name, email: cu.email, contact: cu.phone } });
        } catch (e) { return sendJSON(res, 502, { error: 'Could not start checkout: ' + e.message }); }
      }
      const body = await parseBody(req);
      const result = gateway.verifyPayment({ mode: body.mode, orderId: body.orderId, paymentId: body.paymentId, signature: body.signature });
      if (!result.success) { db.prepare("UPDATE purchases SET status = 'failed' WHERE id = ? AND status = 'pending'").run(p.id); return sendJSON(res, 402, { success: false, message: result.message }); }
      activatePurchase(p.id, result.transactionRef);
      if (p.kind === 'giftcard') {
        const gc = db.prepare('SELECT * FROM gift_cards WHERE id = ?').get(p.ref_id);
        return sendJSON(res, 200, { success: true, message: 'Gift card ready to share.', giftCard: { code: gc.code, amount: gc.amount, expires_at: gc.expires_at, recipient_name: gc.recipient_name } });
      }
      return sendJSON(res, 200, { success: true, message: 'Package bought — book your first session any time.', package: db.prepare('SELECT * FROM customer_packages WHERE id = ?').get(p.ref_id) });
    }
    if (parts[1] === 'wallet' && req.method === 'GET') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      const giftCards = db.prepare("SELECT id, code, amount, balance, recipient_name, message, expires_at, created_at FROM gift_cards WHERE purchaser_id = ? AND status = 'active' ORDER BY id DESC").all(user.id);
      const packages = db.prepare(`SELECT cp.*, s.name AS spa_name, sv.name AS service_name FROM customer_packages cp JOIN spas s ON s.id = cp.spa_id JOIN services sv ON sv.id = cp.service_id
                                   WHERE cp.customer_id = ? AND cp.status = 'active' ORDER BY cp.id DESC`).all(user.id);
      return sendJSON(res, 200, { giftCards, packages, onlinePayments: onlinePaymentsAvailable() });
    }
    if (parts[1] === 'giftcards' && parts[2] === 'check' && req.method === 'GET') {
      const user = requireAuth(req, res, ['customer']);
      if (!user) return;
      if (!checkRateLimit(req, { keyPrefix: 'gift_check', maxRequests: 30, windowMs: 15 * 60 * 1000 })) return sendJSON(res, 429, { error: 'Too many attempts. Please wait a few minutes.' });
      const r = findGiftCard(query.get('code'));
      return r.error ? sendJSON(res, 200, { valid: false, error: r.error }) : sendJSON(res, 200, { valid: true, balance: r.card.balance, expires_at: r.card.expires_at });
    }

    // ---------------- INVOICES ----------------
    if (parts[1] === 'bookings' && parts[3] === 'invoice' && req.method === 'GET') {
      const user = requireAuth(req, res);
      if (!user) return;
      const b = db.prepare('SELECT b.*, s.owner_id FROM bookings b JOIN spas s ON s.id = b.spa_id WHERE b.id = ?').get(parts[2]);
      if (!b || (user.role === 'customer' && b.customer_id !== user.id) || (user.role === 'owner' && b.owner_id !== user.id)) return sendJSON(res, 404, { error: 'Booking not found.' });
      if (b.payment_status !== 'paid') return sendJSON(res, 409, { error: 'The invoice is available once the booking is paid.' });
      return sendJSON(res, 200, { invoice: bookingInvoice(b) });
    }
    if (parts[1] === 'settlements' && parts[3] === 'invoice' && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner', 'admin']);
      if (!user) return;
      const st = db.prepare('SELECT st.*, s.owner_id FROM settlements st JOIN spas s ON s.id = st.spa_id WHERE st.id = ?').get(parts[2]);
      if (!st || (user.role === 'owner' && st.owner_id !== user.id)) return sendJSON(res, 404, { error: 'Settlement not found.' });
      return sendJSON(res, 200, { invoice: settlementInvoice(st) });
    }

    // ---------------- ADMIN: EDIT / DEACTIVATE ----------------
    if (parts[1] === 'admin' && parts[2] === 'users' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const target = db.prepare('SELECT * FROM users WHERE id = ?').get(parts[3]);
      if (!target) return sendJSON(res, 404, { error: 'User not found.' });
      const body = await parseBody(req);
      if (body.active !== undefined) {
        if (target.role === 'admin') return sendJSON(res, 400, { error: 'Admin accounts can’t be deactivated here.' });
        const active = body.active ? 1 : 0;
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(active, target.id);
        if (target.role === 'owner') db.prepare('UPDATE spas SET suspended = ? WHERE owner_id = ?').run(active ? 0 : 1, target.id);
      }
      const name = body.name !== undefined ? String(body.name).trim() : target.name;
      const email = body.email !== undefined ? String(body.email).trim().toLowerCase() : target.email;
      const phone = body.phone !== undefined ? (normalizePhone(body.phone) || null) : target.phone;
      if (name.length < 2) return sendJSON(res, 400, { error: 'Enter a name.' });
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return sendJSON(res, 400, { error: 'Enter a valid email.' });
      if (db.prepare('SELECT id FROM users WHERE lower(email) = ? AND id != ?').get(email, target.id)) return sendJSON(res, 409, { error: 'Another account already uses this email.' });
      if (phone && db.prepare('SELECT id FROM users WHERE phone = ? AND id != ?').get(phone, target.id)) return sendJSON(res, 409, { error: 'Another account already uses this number.' });
      db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, phone_verified = CASE WHEN ? = phone THEN phone_verified ELSE 0 END WHERE id = ?').run(name, email, phone, phone, target.id);
      const fresh = db.prepare('SELECT id, name, email, phone, phone_verified, role, created_at, active FROM users WHERE id = ?').get(target.id);
      return sendJSON(res, 200, { message: body.active === undefined ? 'Saved.' : body.active ? 'Account reactivated.' : 'Account deactivated — they can no longer log in' + (target.role === 'owner' ? ', and their spas are hidden.' : '.'), user: fresh });
    }
    if (parts[1] === 'admin' && parts[2] === 'spas' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(parts[3]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const next = { ...spa };
      for (const f of ['name', 'description', 'city', 'address', 'phone', 'opening_time', 'closing_time']) if (body[f] !== undefined) next[f] = String(body[f]).trim();
      if (!next.name || !next.city) return sendJSON(res, 400, { error: 'Name and city are required.' });
      if (!/^\d{2}:\d{2}$/.test(next.opening_time) || !/^\d{2}:\d{2}$/.test(next.closing_time) || next.opening_time >= next.closing_time) return sendJSON(res, 400, { error: 'Closing time must be after opening time.' });
      db.prepare('UPDATE spas SET name = ?, description = ?, city = ?, address = ?, phone = ?, opening_time = ?, closing_time = ? WHERE id = ?')
        .run(next.name, next.description, next.city, next.address, next.phone, next.opening_time, next.closing_time, spa.id);
      return sendJSON(res, 200, { message: 'Spa details saved.' });
    }

    // ---------------- OWNER: EARNINGS & SETTLEMENTS ----------------
    if (parts[1] === 'owner' && parts[2] === 'earnings' && req.method === 'GET') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const spas = db.prepare('SELECT * FROM spas WHERE owner_id = ?').all(user.id);
      const result = spas.map((s) => {
        const sum = settlementSummary(s.id); delete sum.bookingIds;
        return { spa_id: s.id, spa_name: s.name, commission_percent: commissionRateFor(s), allow_pay_at_venue: s.allow_pay_at_venue !== 0, ...sum };
      });
      const history = db.prepare(
        `SELECT st.*, s.name AS spa_name FROM settlements st JOIN spas s ON s.id = st.spa_id WHERE s.owner_id = ? ORDER BY st.created_at DESC LIMIT 50`
      ).all(user.id);
      return sendJSON(res, 200, { spas: result, history });
    }

    // Owners paste a Google Maps share link (incl. short maps.app.goo.gl links); we return the pin's coordinates.
    if (parts[1] === 'owner' && parts[2] === 'resolve-map-link' && req.method === 'POST') {
      const user = requireAuth(req, res, ['owner']);
      if (!user) return;
      const body = await parseBody(req);
      const input = String(body.url || '').trim();
      let coords = parseCoords(input);
      if (!coords) {
        let url;
        try { url = new URL(input); } catch { return sendJSON(res, 400, { error: 'Paste a Google Maps link or coordinates like 17.4156, 78.4347.' }); }
        for (let hop = 0; hop < 5 && !coords; hop++) {
          if (url.protocol !== 'https:' || !MAP_HOSTS.test(url.hostname)) break; // only ever fetch Google Maps hosts
          let r;
          try { r = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(5000) }); } catch { break; }
          const loc = r.headers.get('location');
          if (!loc) break;
          url = new URL(loc, url);
          coords = parseCoords(url.href);
        }
      }
      if (!coords) return sendJSON(res, 400, { error: "Couldn't find a location in that link. In Google Maps, drop a pin on your spa, tap Share, and paste the link here." });
      return sendJSON(res, 200, coords);
    }

    // ---------------- ADMIN: COMMISSION & SETTLEMENTS ----------------
    if (parts[1] === 'admin' && parts[2] === 'settlements' && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spas = db.prepare(`SELECT s.*, u.name AS owner_name, u.phone AS owner_phone FROM spas s JOIN users u ON u.id = s.owner_id WHERE s.status != 'rejected' ORDER BY s.name`).all();
      const rows = spas.map((s) => {
        const sum = settlementSummary(s.id); delete sum.bookingIds;
        return { spa_id: s.id, spa_name: s.name, owner_name: s.owner_name, owner_phone: s.owner_phone, commission_percent: commissionRateFor(s),
                 custom_rate: s.commission_percent !== null, allow_pay_at_venue: s.allow_pay_at_venue !== 0, noShow: noShowStats(s.id), payout_account: s.razorpay_account_id || null, ...sum };
      });
      const history = db.prepare(`SELECT st.*, s.name AS spa_name FROM settlements st JOIN spas s ON s.id = st.spa_id ORDER BY st.created_at DESC LIMIT 100`).all();
      return sendJSON(res, 200, { spas: rows, history, defaultCommission: DEFAULT_COMMISSION });
    }

    if (parts[1] === 'admin' && parts[2] === 'spas' && parts[4] === 'settle' && req.method === 'POST') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(parts[3]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      const sum = settlementSummary(spa.id);
      if (!sum.count) return sendJSON(res, 400, { error: 'Nothing to settle for this spa right now.' });
      const direction = sum.netToSpa > 0 ? 'payout_to_spa' : sum.netToSpa < 0 ? 'collected_from_spa' : 'zero';
      db.exec('BEGIN');
      try {
        const info = db.prepare(
          `INSERT INTO settlements (spa_id, direction, amount, booking_count, online_gross, venue_gross, commission_total, reference, note) VALUES (?,?,?,?,?,?,?,?,?)`
        ).run(spa.id, direction, Math.abs(sum.netToSpa), sum.count, sum.onlineGross, sum.venueGross, sum.commissionTotal, (body.reference || '').slice(0, 120), (body.note || '').slice(0, 300));
        const mark = db.prepare('UPDATE bookings SET settlement_id = ? WHERE id = ? AND settlement_id IS NULL');
        for (const id of sum.bookingIds) mark.run(info.lastInsertRowid, id);
        db.exec('COMMIT');
        return sendJSON(res, 201, { message: 'Settlement recorded.', settlementId: Number(info.lastInsertRowid), direction, amount: Math.abs(sum.netToSpa) });
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    }

    if (parts[1] === 'admin' && parts[2] === 'spas' && parts[4] === 'commercials' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(parts[3]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      if (body.commission_percent !== undefined) {
        const v = body.commission_percent === null || body.commission_percent === '' ? null : Number(body.commission_percent);
        if (v !== null && !(v >= 0 && v <= 50)) return sendJSON(res, 400, { error: 'Commission must be between 0% and 50%.' });
        db.prepare('UPDATE spas SET commission_percent = ? WHERE id = ?').run(v, spa.id);
      }
      if (body.razorpay_account_id !== undefined) {
        const acc = String(body.razorpay_account_id || '').trim();
        if (acc && !/^acc_[A-Za-z0-9]{14}$/.test(acc)) return sendJSON(res, 400, { error: 'Razorpay linked account IDs look like acc_XXXXXXXXXXXXXX (14 characters after acc_).' });
        db.prepare('UPDATE spas SET razorpay_account_id = ? WHERE id = ?').run(acc || null, spa.id);
      }
      if (body.allow_pay_at_venue !== undefined) {
        db.prepare('UPDATE spas SET allow_pay_at_venue = ? WHERE id = ?').run(body.allow_pay_at_venue ? 1 : 0, spa.id);
      }
      return sendJSON(res, 200, { message: 'Updated. New rates apply to new bookings only.' });
    }

    // ---------------- ADMIN ----------------
    if (parts[1] === 'admin' && parts[2] === 'spas' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spas = db.prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email FROM spas s JOIN users u ON u.id = s.owner_id ORDER BY s.created_at DESC`
      ).all();
      return sendJSON(res, 200, { spas });
    }

    if (parts[1] === 'admin' && parts[2] === 'spas' && parts[4] === 'status' && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spa = db.prepare('SELECT * FROM spas WHERE id = ?').get(parts[3]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });
      const body = await parseBody(req);
      if (!['approved', 'rejected', 'pending'].includes(body.status)) return sendJSON(res, 400, { error: 'Invalid status.' });
      db.prepare('UPDATE spas SET status = ? WHERE id = ?').run(body.status, spa.id);
      return sendJSON(res, 200, { message: `Spa marked as ${body.status}.` });
    }

    if (parts[1] === 'admin' && parts[2] === 'users' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const role = query.get('role');
      let users;
      if (role === 'customer') {
        users = db.prepare(
          `SELECT u.id, u.name, u.email, u.phone, u.phone_verified, u.role, u.created_at, u.active,
                  COUNT(b.id) AS booking_count,
                  COALESCE(SUM(CASE WHEN b.payment_status = 'paid' THEN b.amount ELSE 0 END), 0) AS total_spent,
                  MAX(b.booking_date) AS last_booking
           FROM users u LEFT JOIN bookings b ON b.customer_id = u.id
           WHERE u.role = 'customer' GROUP BY u.id ORDER BY u.created_at DESC`).all();
      } else if (role === 'owner') {
        users = db.prepare(
          `SELECT u.id, u.name, u.email, u.phone, u.phone_verified, u.role, u.created_at, u.active,
                  COUNT(s.id) AS spa_count,
                  SUM(CASE WHEN s.status = 'approved' THEN 1 ELSE 0 END) AS live_spas,
                  SUM(CASE WHEN s.status = 'pending' THEN 1 ELSE 0 END) AS pending_spas,
                  GROUP_CONCAT(s.name, ', ') AS spa_names
           FROM users u LEFT JOIN spas s ON s.owner_id = u.id
           WHERE u.role = 'owner' GROUP BY u.id ORDER BY u.created_at DESC`).all();
      } else {
        users = db.prepare('SELECT id, name, email, phone, phone_verified, role, created_at FROM users ORDER BY created_at DESC').all();
      }
      return sendJSON(res, 200, { users });
    }

    // Rich per-customer view: full profile plus their booking + spend history.
    if (parts[1] === 'admin' && parts[2] === 'users' && parts.length === 4 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const target = db.prepare('SELECT id, name, email, phone, phone_verified, role, created_at, active FROM users WHERE id = ?').get(parts[3]);
      if (!target) return sendJSON(res, 404, { error: 'User not found.' });

      if (target.role === 'customer') {
        const bookings = db.prepare(
          `SELECT b.*, s.name as spa_name, sv.name as service_name
           FROM bookings b JOIN spas s ON s.id = b.spa_id JOIN services sv ON sv.id = b.service_id
           WHERE b.customer_id = ? ORDER BY b.created_at DESC`
        ).all(target.id);
        const totalSpent = bookings.filter(b => b.payment_status === 'paid').reduce((sum, b) => sum + b.amount, 0);
        return sendJSON(res, 200, { user: target, bookings, totalSpent, totalBookings: bookings.length });
      }

      if (target.role === 'owner') {
        const spas = db.prepare('SELECT * FROM spas WHERE owner_id = ? ORDER BY created_at DESC').all(target.id);
        return sendJSON(res, 200, { user: target, spas });
      }

      return sendJSON(res, 200, { user: target });
    }

    // Rich per-spa view for the admin: full detail, room types, services, coupons, revenue.
    if (parts[1] === 'admin' && parts[2] === 'spas' && parts.length === 4 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const spa = db.prepare(
        `SELECT s.*, u.name as owner_name, u.email as owner_email, u.phone as owner_phone
         FROM spas s JOIN users u ON u.id = s.owner_id WHERE s.id = ?`
      ).get(parts[3]);
      if (!spa) return sendJSON(res, 404, { error: 'Spa not found.' });

      const roomTypes = db.prepare('SELECT * FROM room_types WHERE spa_id = ?').all(spa.id);
      const services = db.prepare('SELECT * FROM services WHERE spa_id = ?').all(spa.id);
      const coupons = db.prepare('SELECT * FROM coupons WHERE spa_id = ?').all(spa.id);
      const mediaCount = db.prepare('SELECT COUNT(*) c FROM spa_media WHERE spa_id = ?').get(spa.id).c;
      const totalBookings = db.prepare('SELECT COUNT(*) c FROM bookings WHERE spa_id = ?').get(spa.id).c;
      const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) r FROM bookings WHERE spa_id = ? AND payment_status='paid'").get(spa.id).r;

      return sendJSON(res, 200, { spa, roomTypes, services, coupons, mediaCount, totalBookings, revenue });
    }

    // All payments platform-wide, for reconciliation — both online (Razorpay/mock) and pay-at-venue.
    if (parts[1] === 'admin' && parts[2] === 'transactions' && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const rows = db.prepare(
        `SELECT p.*, b.booking_ref, b.spa_id, b.service_id, b.booking_date, b.start_time, b.payment_mode,
                s.name as spa_name, sv.name as service_name, u.name as customer_name, u.email as customer_email
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN spas s ON s.id = b.spa_id
         JOIN services sv ON sv.id = b.service_id
         JOIN users u ON u.id = b.customer_id
         ORDER BY p.created_at DESC LIMIT 500`
      ).all();
      const totalRevenue = db.prepare("SELECT COALESCE(SUM(amount),0) r FROM payments WHERE status='success'").get().r;
      return sendJSON(res, 200, { transactions: rows, totalRevenue });
    }

    if (parts[1] === 'admin' && parts[2] === 'bookings' && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const rows = db.prepare(
        `SELECT b.*, s.name as spa_name, sv.name as service_name, u.name as customer_name, u.phone as customer_phone
         FROM bookings b JOIN spas s ON s.id = b.spa_id JOIN services sv ON sv.id = b.service_id JOIN users u ON u.id = b.customer_id
         WHERE (? = '' OR b.booking_ref LIKE ? OR u.name LIKE ? OR u.phone LIKE ? OR u.email LIKE ? OR s.name LIKE ?)
         ORDER BY b.created_at DESC LIMIT 300`
      ).all(...(() => { const q = String(query.get('q') || '').trim(); const like = `%${q}%`; return [q, like, like, like, like, like]; })());
      return sendJSON(res, 200, { bookings: rows });
    }

    if (parts[1] === 'admin' && parts[2] === 'messages' && parts.length === 3 && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const messages = db.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC').all();
      return sendJSON(res, 200, { messages });
    }

    if (parts[1] === 'admin' && parts[2] === 'messages' && parts.length === 4 && req.method === 'PUT') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const msg = db.prepare('SELECT * FROM contact_messages WHERE id = ?').get(parts[3]);
      if (!msg) return sendJSON(res, 404, { error: 'Message not found.' });
      const body = await parseBody(req);
      if (!['new', 'read', 'resolved'].includes(body.status)) return sendJSON(res, 400, { error: 'Invalid status.' });
      db.prepare('UPDATE contact_messages SET status = ? WHERE id = ?').run(body.status, msg.id);
      return sendJSON(res, 200, { message: 'Updated.' });
    }

    if (parts[1] === 'admin' && parts[2] === 'stats' && req.method === 'GET') {
      const user = requireAuth(req, res, ['admin']);
      if (!user) return;
      const totalSpas = db.prepare("SELECT COUNT(*) c FROM spas").get().c;
      const pendingSpas = db.prepare("SELECT COUNT(*) c FROM spas WHERE status='pending'").get().c;
      const totalUsers = db.prepare("SELECT COUNT(*) c FROM users").get().c;
      const totalCustomers = db.prepare("SELECT COUNT(*) c FROM users WHERE role='customer'").get().c;
      const totalOwners = db.prepare("SELECT COUNT(*) c FROM users WHERE role='owner'").get().c;
      const totalBookings = db.prepare("SELECT COUNT(*) c FROM bookings").get().c;
      const confirmedBookings = db.prepare("SELECT COUNT(*) c FROM bookings WHERE status='confirmed'").get().c;
      const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) r FROM bookings WHERE payment_status='paid'").get().r;
      const newMessages = db.prepare("SELECT COUNT(*) c FROM contact_messages WHERE status='new'").get().c;
      const commissionEarned = round2(db.prepare(
        `SELECT COALESCE(SUM(commission_amount),0) c FROM bookings WHERE (status = 'completed' OR (status = 'confirmed' AND booking_date < ?)) AND (payment_mode = 'pay_at_venue' OR payment_status = 'paid')`
      ).get(localNow().date).c);
      return sendJSON(res, 200, { totalSpas, pendingSpas, totalUsers, totalCustomers, totalOwners, totalBookings, confirmedBookings, revenue, newMessages, commissionEarned, backup: (() => {
          const st = backupMod.readStatus(); const at = st.lastLocal && st.lastLocal.at;
          return { lastAt: at || null, ageHours: at ? Math.round(((Date.now() - Date.parse(at)) / 3600000) * 10) / 10 : null, offsite: backupMod.offsiteSummary().configured,
                   lastOffsiteAt: st.lastOffsite ? st.lastOffsite.at : null, lastOffsiteError: st.lastOffsiteError ? st.lastOffsiteError.message : null,
                   lastError: st.lastError ? st.lastError.message : null, restoreError: st.restoreError ? st.restoreError.message : null };
        })(),
        giftCardLiability: round2(db.prepare("SELECT COALESCE(SUM(balance),0) v FROM gift_cards WHERE status = 'active'").get().v),
        packageLiability: round2(db.prepare("SELECT COALESCE(SUM((sessions_total - sessions_used) * per_session_value),0) v FROM customer_packages WHERE status = 'active'").get().v),
        featuredRevenue: round2(db.prepare('SELECT COALESCE(SUM(amount),0) a FROM featured_placements WHERE cancelled = 0').get().a),
        activeFeatured: db.prepare('SELECT COUNT(DISTINCT spa_id) c FROM featured_placements WHERE cancelled = 0 AND starts_on <= ? AND ends_on >= ?').get(localNow().date, localNow().date).c });
    }

    // No route matched
    return sendJSON(res, 404, { error: 'API route not found.' });
  } catch (err) {
    console.error(err);
    return sendJSON(res, 500, { error: err.message || 'Internal server error.' });
  }
}

// ---------------- APPOINTMENT REMINDERS (~2 hours before) ----------------
async function runReminders() {
  const today = localNow().date, tomorrow = new Date(Date.parse(today + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const due = db.prepare(
    `SELECT * FROM bookings WHERE status = 'confirmed' AND reminder_sent = 0 AND booking_date IN (?, ?)`
  ).all(today, tomorrow).filter((b) => {
    const until = appointmentMs(b) - Date.now();
    const bookedLongAgo = Date.now() - Date.parse(String(b.created_at).replace(' ', 'T') + 'Z') > 60 * 60000;
    return until > 0 && until <= 2 * 3600000 && bookedLongAgo; // a customer who booked 30 minutes ago doesn't need a reminder
  });
  let sent = 0;
  for (const b of due) {
    db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?').run(b.id); // mark first: never double-send
    try {
      await notifier.sendReminder({ booking: b, customer: db.prepare('SELECT * FROM users WHERE id = ?').get(b.customer_id),
        spa: db.prepare('SELECT * FROM spas WHERE id = ?').get(b.spa_id), service: db.prepare('SELECT * FROM services WHERE id = ?').get(b.service_id) });
      sent++;
    } catch (e) { console.error('Reminder failed for booking', b.booking_ref, e.message); }
  }
  return sent;
}
function startReminderScheduler() {
  const tick = () => runReminders().catch((e) => console.error('Reminder scheduler error:', e.message));
  setTimeout(tick, 30000).unref();
  setInterval(tick, 10 * 60000).unref();
}

module.exports = { handleApi, runReminders, startReminderScheduler };
