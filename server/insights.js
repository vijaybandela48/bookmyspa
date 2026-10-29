// insights.js — BookMySpa Premium for spa owners: subscription logic + analytics.
// Everything here is computed from bookings the owner already has access to.

const { db } = require('./db');

const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 330);
const round2 = (x) => Math.round(x * 100) / 100;
const todayLocal = () => new Date(Date.now() + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
const addMonths = (iso, m) => { const d = new Date(iso + 'T00:00:00Z'); const day = d.getUTCDate(); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + m); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); return d.toISOString().slice(0, 10); };

// ---------------- Settings (admin-controlled) ----------------
db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS premium_subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id),
  plan TEXT NOT NULL CHECK(plan IN ('monthly','yearly','trial','grant')),
  amount REAL NOT NULL DEFAULT 0,
  months INTEGER NOT NULL DEFAULT 0,
  days INTEGER NOT NULL DEFAULT 0,
  starts_on TEXT, ends_on TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','void')),
  payment_ref TEXT, note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_premium_owner ON premium_subscriptions(owner_id, status);
`);
const DEFAULTS = { premium_enabled: '1', premium_price_monthly: '999', premium_price_yearly: '9999', premium_trial_days: '14' };
function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key LIKE 'premium_%'").all()) out[r.key] = r.value;
  return {
    enabled: out.premium_enabled === '1',
    priceMonthly: Number(out.premium_price_monthly),
    priceYearly: Number(out.premium_price_yearly),
    trialDays: Number(out.premium_trial_days),
  };
}
function saveSettings(s) {
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  if (s.enabled !== undefined) set.run('premium_enabled', s.enabled ? '1' : '0');
  if (s.priceMonthly !== undefined) set.run('premium_price_monthly', String(s.priceMonthly));
  if (s.priceYearly !== undefined) set.run('premium_price_yearly', String(s.priceYearly));
  if (s.trialDays !== undefined) set.run('premium_trial_days', String(s.trialDays));
}

// ---------------- Subscription status ----------------
function premiumStatus(ownerId) {
  const today = todayLocal();
  const active = db.prepare(
    "SELECT * FROM premium_subscriptions WHERE owner_id = ? AND status = 'active' AND starts_on <= ? AND ends_on >= ? ORDER BY ends_on DESC LIMIT 1"
  ).get(ownerId, today, today);
  const latestEnd = db.prepare("SELECT MAX(ends_on) e FROM premium_subscriptions WHERE owner_id = ? AND status = 'active'").get(ownerId).e;
  const usedTrial = !!db.prepare("SELECT 1 FROM premium_subscriptions WHERE owner_id = ? AND plan = 'trial' AND status = 'active'").get(ownerId);
  return {
    active: !!active,
    plan: active ? active.plan : null,
    until: active ? latestEnd : null,
    daysLeft: active ? daysBetween(today, latestEnd) + 1 : 0,
    trialAvailable: !usedTrial,
  };
}
// Activates a (paid, granted or trial) subscription; new time is added after any existing active time.
function activate(subId, paymentRef) {
  const s = db.prepare('SELECT * FROM premium_subscriptions WHERE id = ?').get(subId);
  if (!s || s.status !== 'pending') return s;
  const today = todayLocal();
  const currentEnd = db.prepare("SELECT MAX(ends_on) e FROM premium_subscriptions WHERE owner_id = ? AND status = 'active'").get(s.owner_id).e;
  const start = currentEnd && currentEnd >= today ? addDays(currentEnd, 1) : today;
  const end = s.days ? addDays(start, s.days - 1) : addDays(addMonths(start, s.months), -1);
  db.prepare("UPDATE premium_subscriptions SET status = 'active', starts_on = ?, ends_on = ?, payment_ref = COALESCE(?, payment_ref) WHERE id = ?").run(start, end, paymentRef || null, s.id);
  return db.prepare('SELECT * FROM premium_subscriptions WHERE id = ?').get(s.id);
}
function createSub(ownerId, plan, { amount = 0, months = 0, days = 0, note = null } = {}) {
  return Number(db.prepare('INSERT INTO premium_subscriptions (owner_id, plan, amount, months, days, note) VALUES (?,?,?,?,?,?)')
    .run(ownerId, plan, amount, months, days, note).lastInsertRowid);
}

// ---------------- Analytics ----------------
// A "visit" is a booking whose appointment actually happened (or was marked completed) and was paid or due at the spa.
const VISIT = `b.booking_date <= '@today' AND (b.status = 'completed' OR (b.status = 'confirmed' AND b.booking_date < '@today')) AND (b.payment_mode = 'pay_at_venue' OR b.payment_status = 'paid')`;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const hourLabel = (h) => `${h % 12 === 0 ? 12 : h % 12} ${h >= 12 ? 'PM' : 'AM'}`;

function spaScope(ownerId, spaId) {
  const spas = db.prepare('SELECT id, name, opening_time, closing_time FROM spas WHERE owner_id = ? ORDER BY name').all(ownerId);
  const chosen = spaId && spaId !== 'all' ? spas.filter((s) => s.id === Number(spaId)) : spas;
  return { spas, ids: chosen.map((s) => s.id), chosen };
}
const inList = (ids) => (ids.length ? ids.join(',') : '-1'); // ids are integers from the DB

function buckets(start, end, days) {
  const unit = days <= 31 ? 'day' : days <= 190 ? 'week' : 'month';
  const out = [];
  if (unit === 'month') {
    let d = start.slice(0, 7) + '-01';
    while (d <= end) { const next = addMonths(d, 1); out.push({ from: d, to: addDays(next, -1), label: new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }) }); d = next; }
  } else {
    const step = unit === 'day' ? 1 : 7;
    for (let d = start; d <= end; d = addDays(d, step)) {
      const dt = new Date(d + 'T00:00:00Z');
      out.push({ from: d, to: addDays(d, step - 1), label: dt.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' }) });
    }
  }
  return { unit, list: out };
}
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
const delta = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

function customerTable(ids) {
  const today = todayLocal();
  const rows = db.prepare(
    `SELECT b.customer_id, b.booking_date, b.amount, b.service_id, sv.name AS service_name, u.name, u.phone, CASE WHEN u.email LIKE '%@guest.bookmyspa.invalid' THEN u.contact_email ELSE u.email END AS email
     FROM bookings b JOIN users u ON u.id = b.customer_id JOIN services sv ON sv.id = b.service_id
     WHERE b.spa_id IN (${inList(ids)}) AND ${VISIT.replace(/@today/g, today)} ORDER BY b.booking_date`
  ).all();
  const upcoming = new Map(db.prepare(
    `SELECT customer_id, COUNT(*) c, MIN(booking_date) d FROM bookings WHERE spa_id IN (${inList(ids)}) AND status = 'confirmed' AND booking_date >= ? GROUP BY customer_id`
  ).all(today).map((r) => [r.customer_id, r]));
  const map = new Map();
  for (const r of rows) {
    let c = map.get(r.customer_id);
    if (!c) { c = { id: r.customer_id, name: r.name, phone: r.phone, email: r.email, visits: 0, spend: 0, dates: [], services: {} }; map.set(r.customer_id, c); }
    c.visits++; c.spend += r.amount; c.dates.push(r.booking_date);
    c.services[r.service_name] = (c.services[r.service_name] || 0) + 1;
  }
  const list = [...map.values()].map((c) => {
    const first = c.dates[0], last = c.dates[c.dates.length - 1];
    const avgGap = c.visits > 1 ? Math.round(daysBetween(first, last) / (c.visits - 1)) : null;
    const since = daysBetween(last, today);
    const up = upcoming.get(c.id);
    const fav = Object.entries(c.services).sort((a, b) => b[1] - a[1])[0][0];
    return { id: c.id, name: c.name, phone: c.phone, email: c.email, visits: c.visits, spend: round2(c.spend), first_visit: first, last_visit: last,
             avg_gap_days: avgGap, days_since: since, favourite: fav, upcoming: up ? up.c : 0, next_visit: up ? up.d : null };
  });
  // VIP = your top 10% of customers by lifetime spend (at least 3 visits)
  const ranked = [...list].sort((a, b) => b.spend - a.spend);
  const vipIds = new Set(ranked.slice(0, Math.max(1, Math.ceil(list.length * 0.1))).filter((c) => c.visits >= 3).map((c) => c.id));
  for (const c of list) {
    const lapsing = !c.upcoming && c.days_since > 90;
    const atRisk = !c.upcoming && c.visits >= 2 && c.days_since > Math.max(45, Math.round((c.avg_gap_days || 30) * 1.5));
    c.segment = lapsing ? 'lapsed' : atRisk ? 'at_risk' : vipIds.has(c.id) ? 'vip' : c.visits === 1 ? 'new' : 'regular';
  }
  return list.sort((a, b) => b.spend - a.spend);
}

function insights(ownerId, spaId, days) {
  days = [30, 90, 180, 365].includes(Number(days)) ? Number(days) : 90;
  const today = todayLocal();
  const end = addDays(today, -1), start = addDays(today, -days);
  const pEnd = addDays(start, -1), pStart = addDays(start, -days);
  const scope = spaScope(ownerId, spaId);
  const IDS = inList(scope.ids);
  const visitsIn = (a, b) => db.prepare(
    `SELECT b.*, sv.name AS service_name, sv.room_type_id, (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name
     FROM bookings b JOIN services sv ON sv.id = b.service_id
     WHERE b.spa_id IN (${IDS}) AND b.booking_date BETWEEN ? AND ? AND ${VISIT.replace(/@today/g, today)}`
  ).all(a, b);
  const cur = visitsIn(start, end), prev = visitsIn(pStart, pEnd);
  const firstVisit = new Map(db.prepare(
    `SELECT b.customer_id, MIN(b.booking_date) d FROM bookings b WHERE b.spa_id IN (${IDS}) AND ${VISIT.replace(/@today/g, today)} GROUP BY b.customer_id`
  ).all().map((r) => [r.customer_id, r.d]));
  const summarize = (rows, from) => {
    const custs = new Set(rows.map((r) => r.customer_id));
    const returning = [...custs].filter((c) => firstVisit.get(c) < from);
    const retRevenue = rows.filter((r) => firstVisit.get(r.customer_id) < from).reduce((a, r) => a + r.amount, 0);
    const revenue = rows.reduce((a, r) => a + r.amount, 0);
    return { revenue: round2(revenue), visits: rows.length, customers: custs.size, newCustomers: custs.size - returning.length,
             returningCustomers: returning.length, returningRevenueShare: pct(retRevenue, revenue), avgTicket: rows.length ? round2(revenue / rows.length) : 0 };
  };
  const k = summarize(cur, start), kp = summarize(prev, pStart);
  const allInWindow = (a, b) => db.prepare(`SELECT status, cancel_reason FROM bookings WHERE spa_id IN (${IDS}) AND booking_date BETWEEN ? AND ? AND (cancel_reason IS NULL OR cancel_reason != 'payment_timeout') AND status != 'pending_payment'`).all(a, b);
  const rates = (rows) => ({ cancelRate: pct(rows.filter((r) => r.status === 'cancelled' && r.cancel_reason !== 'no_show').length, rows.length),
                             noShowRate: pct(rows.filter((r) => r.cancel_reason === 'no_show').length, rows.length) });
  const rc = rates(allInWindow(start, end)), rp = rates(allInWindow(pStart, pEnd));
  const rating = (a, b) => db.prepare(`SELECT AVG(rating) r, COUNT(*) n FROM reviews WHERE spa_id IN (${IDS}) AND hidden = 0 AND date(created_at) BETWEEN ? AND ?`).get(a, b);
  const rt = rating(start, end), rtp = rating(pStart, pEnd);

  const kpis = {
    revenue: { value: k.revenue, delta: delta(k.revenue, kp.revenue) },
    visits: { value: k.visits, delta: delta(k.visits, kp.visits) },
    customers: { value: k.customers, delta: delta(k.customers, kp.customers), new: k.newCustomers, returning: k.returningCustomers },
    returningRevenueShare: { value: k.returningRevenueShare, delta: k.returningRevenueShare !== null && kp.returningRevenueShare !== null ? round2(k.returningRevenueShare - kp.returningRevenueShare) : null },
    avgTicket: { value: k.avgTicket, delta: delta(k.avgTicket, kp.avgTicket) },
    rating: { value: rt.n ? Math.round(rt.r * 10) / 10 : null, count: rt.n, delta: rt.n && rtp.n ? Math.round((rt.r - rtp.r) * 10) / 10 : null },
    cancelRate: { value: rc.cancelRate, delta: rc.cancelRate !== null && rp.cancelRate !== null ? round2(rc.cancelRate - rp.cancelRate) : null },
    noShowRate: { value: rc.noShowRate, delta: rc.noShowRate !== null && rp.noShowRate !== null ? round2(rc.noShowRate - rp.noShowRate) : null },
  };

  // Over time
  const bk = buckets(start, end, days);
  const series = bk.list.map((b) => {
    const rows = cur.filter((r) => r.booking_date >= b.from && r.booking_date <= b.to);
    const custs = new Set(rows.map((r) => r.customer_id));
    let nw = 0; for (const c of custs) if (firstVisit.get(c) >= b.from) nw++;
    return { label: b.label, from: b.from, to: b.to, revenue: round2(rows.reduce((a, r) => a + r.amount, 0)), visits: rows.length, newCustomers: nw, returningCustomers: custs.size - nw };
  });

  // Busy times (weekday x hour)
  let open = 24 * 60, close = 0;
  for (const s of scope.chosen) { open = Math.min(open, toMin(s.opening_time)); close = Math.max(close, toMin(s.closing_time)); }
  if (open >= close) { open = 9 * 60; close = 21 * 60; }
  const hours = []; for (let h = Math.floor(open / 60); h < Math.ceil(close / 60); h++) hours.push(h);
  const grid = WD.map(() => hours.map(() => 0));
  for (const r of cur) { const d = new Date(r.booking_date + 'T00:00:00Z').getUTCDay(); const hi = hours.indexOf(Math.floor(toMin(r.start_time) / 60)); if (hi >= 0) grid[d][hi]++; }
  const order = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun
  const heatmap = { days: order.map((d) => WD[d]), hours: hours.map(hourLabel), hourValues: hours, values: order.map((d) => grid[d]) };

  // Mixes
  const group = (key, rows) => { const m = new Map(); for (const r of rows) { const g = r[key] || 'Unassigned'; const o = m.get(g) || { name: g, visits: 0, revenue: 0 }; o.visits++; o.revenue += r.amount; m.set(g, o); } return [...m.values()].map((o) => ({ ...o, revenue: round2(o.revenue) })).sort((a, b) => b.revenue - a.revenue); };
  const services = group('service_name', cur);
  const therapists = group('therapist_name', cur.filter((r) => r.therapist_id));
  const payMix = [
    { name: 'Paid online', value: round2(cur.filter((r) => r.payment_mode === 'online' && !r.customer_package_id).reduce((a, r) => a + r.amount - (r.giftcard_amount || 0), 0)
                                        + cur.filter((r) => r.payment_mode === 'pay_at_venue' && r.deposit_status === 'paid').reduce((a, r) => a + r.deposit_amount, 0)) },
    { name: 'Paid at spa', value: round2(cur.filter((r) => r.payment_mode === 'pay_at_venue').reduce((a, r) => a + r.amount - (r.giftcard_amount || 0) - (r.deposit_status === 'paid' ? r.deposit_amount : 0), 0)) },
    { name: 'Gift cards', value: round2(cur.reduce((a, r) => a + (r.giftcard_amount || 0), 0)) },
    { name: 'Packages', value: round2(cur.filter((r) => r.customer_package_id).reduce((a, r) => a + r.amount, 0)) },
  ];
  // How far ahead customers book
  const leadBins = [['Same day', 0, 0], ['1 day', 1, 1], ['2–3 days', 2, 3], ['4–7 days', 4, 7], ['8+ days', 8, 9999]];
  const lead = leadBins.map(([name, a, b]) => ({ name, visits: cur.filter((r) => { const created = new Date(Date.parse(String(r.created_at).replace(' ', 'T') + 'Z') + TZ_OFFSET_MINUTES * 60000).toISOString().slice(0, 10); const d = daysBetween(created, r.booking_date); return d >= a && d <= b; }).length }));
  // Ratings by month (last 6 months, independent of range)
  const ratings = [];
  for (let i = 5; i >= 0; i--) {
    const m0 = addMonths(today.slice(0, 7) + '-01', -i), m1 = addDays(addMonths(m0, 1), -1);
    const r = rating(m0, m1);
    ratings.push({ label: new Date(m0 + 'T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' }), value: r.n ? Math.round(r.r * 10) / 10 : null, count: r.n });
  }

  // Customers (lifetime)
  const customers = customerTable(scope.ids);
  const seg = (s) => customers.filter((c) => c.segment === s);
  const segments = ['vip', 'regular', 'new', 'at_risk', 'lapsed'].map((s) => ({ key: s, count: seg(s).length, spend: round2(seg(s).reduce((a, c) => a + c.spend, 0)) }));

  // Plain-language highlights
  const notes = [];
  if (services[0]) notes.push({ tone: 'good', text: `${services[0].name} brought in the most revenue (₹${Math.round(services[0].revenue).toLocaleString('en-IN')} from ${services[0].visits} visit${services[0].visits !== 1 ? 's' : ''}).` });
  if (k.returningRevenueShare !== null) notes.push({ tone: 'info', text: `Returning customers made ${k.returningRevenueShare}% of your revenue${k.returningRevenueShare >= 50 ? ' — loyalty is strong.' : ' — a loyalty offer could lift repeat visits.'}` });
  const cells = []; heatmap.values.forEach((row, di) => row.forEach((v, hi) => cells.push({ v, d: heatmap.days[di], h: heatmap.hours[hi] })));
  if (cur.length >= 5) {
    const busiest = cells.reduce((a, b) => (b.v > a.v ? b : a));
    const FULLD = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
    notes.push({ tone: 'info', text: `Busiest time: ${FULLD[busiest.d]}s around ${busiest.h}. Make sure you’re fully staffed then.` });
    const dayTotals = heatmap.values.map((row, i) => ({ d: heatmap.days[i], v: row.reduce((a, b) => a + b, 0) }));
    const slow = dayTotals.reduce((a, b) => (b.v < a.v ? b : a));
    const FULL = { Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' };
    notes.push({ tone: 'tip', text: `${FULL[slow.d]} is your quietest day. A time-limited coupon for ${FULL[slow.d]}s can fill those empty slots.` });
  }
  const atRisk = seg('at_risk').length + seg('lapsed').length;
  if (atRisk) notes.push({ tone: 'warn', text: `${atRisk} customer${atRisk !== 1 ? 's haven’t' : ' hasn’t'} been back in a while. Use “Win back” below to message them.` });
  if (kpis.noShowRate.value >= 10) notes.push({ tone: 'warn', text: `No-shows are ${kpis.noShowRate.value}% of bookings. Asking for online payment or a reminder call could cut them.` });

  return { range: { days, start, end, unit: bk.unit, prevStart: pStart, prevEnd: pEnd }, spas: scope.spas.map((s) => ({ id: s.id, name: s.name })), spaId: spaId || 'all',
           kpis, series, heatmap, services, therapists, payMix, lead, ratings, segments, customers, notes };
}

function customerHistory(ownerId, customerId) {
  const ids = spaScope(ownerId, 'all').ids;
  return db.prepare(
    `SELECT b.id, b.booking_ref, b.booking_date, b.start_time, b.amount, b.status, b.cancel_reason, b.payment_mode, b.payment_status, s.name AS spa_name, sv.name AS service_name,
            (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name, (SELECT rating FROM reviews WHERE booking_id = b.id) AS rating
     FROM bookings b JOIN spas s ON s.id = b.spa_id JOIN services sv ON sv.id = b.service_id
     WHERE b.customer_id = ? AND b.spa_id IN (${inList(ids)}) AND b.status != 'pending_payment' ORDER BY b.booking_date DESC, b.start_time DESC`
  ).all(customerId);
}

function csv(rows, cols) {
  const cell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [cols.map((c) => c[0]).join(','), ...rows.map((r) => cols.map((c) => cell(typeof c[1] === 'function' ? c[1](r) : r[c[1]])).join(','))].join('\r\n');
}
function exportCsv(ownerId, spaId, type) {
  const scope = spaScope(ownerId, spaId);
  if (type === 'customers') {
    const SEG = { vip: 'VIP', regular: 'Regular', new: 'New', at_risk: 'At risk', lapsed: 'Lapsed' };
    return csv(customerTable(scope.ids), [['Name', 'name'], ['Phone', 'phone'], ['Email', 'email'], ['Segment', (r) => SEG[r.segment]], ['Visits', 'visits'], ['Total spend (₹)', 'spend'],
      ['First visit', 'first_visit'], ['Last visit', 'last_visit'], ['Avg days between visits', 'avg_gap_days'], ['Favourite service', 'favourite'], ['Upcoming bookings', 'upcoming']]);
  }
  const rows = db.prepare(
    `SELECT b.*, s.name AS spa_name, sv.name AS service_name, u.name AS customer_name, u.phone AS customer_phone, (SELECT name FROM therapists WHERE id = b.therapist_id) AS therapist_name
     FROM bookings b JOIN spas s ON s.id = b.spa_id JOIN services sv ON sv.id = b.service_id JOIN users u ON u.id = b.customer_id
     WHERE b.spa_id IN (${inList(scope.ids)}) AND b.status != 'pending_payment' ORDER BY b.booking_date DESC, b.start_time DESC`).all();
  return csv(rows, [['Booking ID', 'booking_ref'], ['Date', 'booking_date'], ['Time', 'start_time'], ['Spa', 'spa_name'], ['Service', 'service_name'], ['Therapist', 'therapist_name'],
    ['Customer', 'customer_name'], ['Phone', 'customer_phone'], ['Amount (₹)', 'amount'], ['Coupon', 'coupon_code'], ['Gift card (₹)', 'giftcard_amount'],
    ['Payment', (r) => (r.customer_package_id ? 'Package' : r.payment_mode === 'online' ? 'Online' : 'At spa')], ['Payment status', 'payment_status'],
    ['Status', (r) => (r.cancel_reason === 'no_show' ? 'no-show' : r.status)], ['Commission (₹)', 'commission_amount']]);
}

module.exports = { getSettings, saveSettings, premiumStatus, activate, createSub, insights, customerHistory, exportCsv, todayLocal };
