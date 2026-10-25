// BookMySpa automated test suite.  Run with:  npm test
// Copies the app into a temporary folder with a fresh demo database, starts it, and exercises
// the API end to end. Your real data/ folder is never touched.
const { spawn } = require('node:child_process');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bms-test-'));
for (const d of ['server', 'public']) fs.cpSync(path.join(ROOT, d), path.join(TMP, d), { recursive: true });
fs.mkdirSync(path.join(TMP, 'data/uploads/spas'), { recursive: true });
const PORT = 3900 + Math.floor(Math.random() * 90);
const B = `http://localhost:${PORT}/api`;
const DBFILE = path.join(TMP, 'data/spa_platform.db');

let pass = 0, fail = 0, section = '';
const ok = (name, cond, info = '') => { cond ? pass++ : fail++; if (!cond) console.log(`  FAIL [${section}] ${name}  -> ${typeof info === 'string' ? info : JSON.stringify(info)}`); };
const group = (n) => { section = n; process.stdout.write(`• ${n}\n`); };
const j = async (m, p, b, t) => { const r = await fetch(B + p, { method: m, headers: { 'Content-Type': 'application/json', ...(t ? { Authorization: 'Bearer ' + t } : {}) }, body: b ? JSON.stringify(b) : undefined }); let d = {}; try { d = await r.json(); } catch {} return { status: r.status, d }; };
const login = async (email, password, portal) => (await j('POST', '/auth/login', { email, password, portal })).d.token;
const IST = 330 * 60000;
const ist = (days) => new Date(Date.now() + IST + days * 86400000).toISOString().slice(0, 10);
const dbq = (sql, ...a) => { const d = new DatabaseSync(DBFILE); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const dbx = (sql, ...a) => { const d = new DatabaseSync(DBFILE); try { return d.prepare(sql).run(...a); } finally { d.close(); } };
const round = (x) => Math.round(x * 100) / 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

(async () => {
  const srv = spawn(process.execPath, ['server/server.js'], { cwd: TMP, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SEED_DEMO_HISTORY: 'off' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
  for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/config')).ok) break; } catch {} await sleep(250); }

  try {
    const cust = await login('customer@bookmyspa.demo', 'customer123', 'customer');
    const own = await login('owner1@bookmyspa.demo', 'owner123', 'partner');
    const own2 = await login('owner2@bookmyspa.demo', 'owner123', 'partner');
    const adm = await login('admin@bookmyspa.demo', 'admin123', 'admin');

    group('Core: portals, sign-up, security');
    ok('owner blocked on customer site', (await j('POST', '/auth/login', { email: 'owner1@bookmyspa.demo', password: 'owner123', portal: 'customer' })).status === 403);
    let o = await j('POST', '/auth/otp/send', { phone: '9876500001', purpose: 'registration' });
    let r = await j('POST', '/auth/register', { name: 'Sneaky', email: 'sneaky@t.com', phone: '9876500001', password: 'password123', role: 'admin', otpCode: o.d.devCode });
    ok('customer site can only create customers', r.status === 201 && r.d.user.role === 'customer', r);
    const cust2 = r.d.token;
    await j('POST', '/contact', { name: '<img src=x onerror=alert(1)>', email: 'x@x.com', message: "a' onmouseover='b" });
    const m0 = (await j('GET', '/admin/messages', null, adm)).d.messages[0];
    ok('XSS neutralized', !/[<>"']/.test(m0.name + m0.message), m0);
    ok('pending spa not bookable', (await j('GET', '/spas/4')).status === 404);
    ok('past date rejected', (await j('GET', `/spas/1/slots?serviceId=1&date=${ist(-1)}`)).status === 400);

    group('Core: booking, IDs, notifications, reviews, featured, commission');
    r = await j('POST', '/bookings', { spaId: 1, serviceId: 3, date: ist(5), startTime: '10:00', paymentMode: 'pay_at_venue' }, cust);
    const b1 = r.d.booking;
    ok('booking ID format', /^BMS-\d{6}-[A-HJ-NP-Z2-9]{4}$/.test(b1.booking_ref || ''), b1);
    ok('confirmation on SMS + WhatsApp', dbq('SELECT notify_channel FROM bookings WHERE id=?', b1.id)[0].notify_channel === 'sms,whatsapp');
    ok('featured tab only featured', (await j('GET', '/spas?sort=featured&featured=1')).d.spas.every((s) => s.featured));
    ok('ratings are real', (await j('GET', '/spas')).d.spas.find((s) => s.id === 1).review_count === 2);
    ok('commission snapshotted', dbq('SELECT commission_percent FROM bookings WHERE id=?', b1.id)[0].commission_percent === 10);

    group('Owner: edit spa & service details');
    r = await j('PUT', '/owner/spas/1', { name: 'Serene Bliss Spa & Wellness', description: 'Updated', opening_time: '09:00', closing_time: '21:00', phone: '9000011111' }, own);
    ok('owner edits spa details', r.status === 200 && r.d.spa.name === 'Serene Bliss Spa & Wellness' && r.d.spa.opening_time === '09:00', r);
    ok('closing before opening rejected', (await j('PUT', '/owner/spas/1', { opening_time: '20:00', closing_time: '10:00' }, own)).status === 400);
    ok('empty name rejected', (await j('PUT', '/owner/spas/1', { name: '  ' }, own)).status === 400);
    ok('other owner cannot edit', (await j('PUT', '/owner/spas/1', { name: 'Hijack' }, own2)).status === 404);
    r = await j('PUT', '/owner/services/3', { name: 'Signature Glow Facial', price: 1699, duration_minutes: 60, description: 'New' }, own);
    ok('owner edits service name/price/duration', r.status === 200 && r.d.service.price === 1699 && r.d.service.duration_minutes === 60, r);
    ok('bad price rejected', (await j('PUT', '/owner/services/3', { price: -5 }, own)).status === 400);
    ok('bad duration rejected', (await j('PUT', '/owner/services/3', { duration_minutes: 7 }, own)).status === 400);
    ok('existing booking keeps its price', dbq('SELECT amount FROM bookings WHERE id=?', b1.id)[0].amount === b1.amount);

    group('Owner: weekly off & holidays');
    const d7 = ist(7);
    r = await j('PUT', '/owner/spas/1', { weekly_off: String(dow(d7)) }, own);
    ok('weekly off saved', r.status === 200 && r.d.spa.weekly_off === String(dow(d7)), r);
    r = await j('GET', `/spas/1/slots?serviceId=1&date=${d7}`);
    ok('weekly off day shows closed with no slots', r.d.slots.length === 0 && /Closed every/.test(r.d.closed || ''), r.d);
    ok('booking on weekly off rejected', (await j('POST', '/bookings', { spaId: 1, serviceId: 1, date: d7, startTime: '10:00', paymentMode: 'pay_at_venue' }, cust)).status === 409);
    ok('cannot be closed 7 days a week', (await j('PUT', '/owner/spas/1', { weekly_off: '0,1,2,3,4,5,6' }, own)).status === 400);
    await j('PUT', '/owner/spas/1', { weekly_off: '' }, own);
    const d9 = ist(9);
    r = await j('POST', '/owner/spas/1/closures', { date: d9, reason: 'Diwali' }, own);
    ok('holiday added', r.status === 201, r);
    r = await j('GET', `/spas/1/slots?serviceId=1&date=${d9}`);
    ok('holiday shows reason and no slots', r.d.slots.length === 0 && /Diwali/.test(r.d.closed || ''), r.d);
    const cl = (await j('GET', '/owner/spas/1/closures', null, own)).d.closures.find((c) => c.date === d9);
    ok('past-date holiday rejected', (await j('POST', '/owner/spas/1/closures', { date: ist(-3) }, own)).status === 400);
    await j('DELETE', `/owner/closures/${cl.id}`, null, own);
    ok('removing holiday reopens day', (await j('GET', `/spas/1/slots?serviceId=1&date=${d9}`)).d.slots.length > 0);

    group('Owner: calendar & walk-in blocks');
    const d4 = ist(4);
    let slots = (await j('GET', `/spas/1/slots?serviceId=1&date=${d4}`)).d.slots;
    const s10 = slots.find((s) => s.start_time === '10:00');
    ok('therapy room starts with 3 free at 10:00', s10 && s10.spots_left === 3, s10);
    r = await j('POST', '/owner/spas/1/blocks', { date: d4, start_time: '10:00', end_time: '12:00', room_type_id: 2, qty: 2, reason: 'Walk-in group' }, own);
    ok('owner blocks 2 therapy rooms for walk-ins', r.status === 201, r);
    const blk = r.d.id;
    slots = (await j('GET', `/spas/1/slots?serviceId=1&date=${d4}`)).d.slots;
    ok('online availability drops to 1 room', slots.find((s) => s.start_time === '10:00').spots_left === 1);
    ok('jacuzzi (other room type) unaffected', (await j('GET', `/spas/1/slots?serviceId=4&date=${d4}`)).d.slots.filter((s) => s.start_time >= '10:00' && s.start_time < '12:00').every((s) => s.spots_left === 2));
    ok('cannot block more rooms than are free', (await j('POST', '/owner/spas/1/blocks', { date: d4, start_time: '10:30', end_time: '11:00', room_type_id: 2, qty: 2 }, own)).status === 409);
    await j('POST', '/bookings', { spaId: 1, serviceId: 1, date: d4, startTime: '14:00', paymentMode: 'pay_at_venue' }, cust);
    ok('whole-spa block refused over existing bookings', (await j('POST', '/owner/spas/1/blocks', { date: d4, start_time: '13:00', end_time: '16:00' }, own)).status === 409);
    r = await j('POST', '/owner/spas/1/blocks', { date: d4, start_time: '18:00', end_time: '20:00', reason: 'Staff training' }, own);
    ok('whole-spa block accepted on a free period', r.status === 201, r);
    ok('whole-spa block hides those slots for every service', !(await j('GET', `/spas/1/slots?serviceId=4&date=${d4}`)).d.slots.some((s) => s.start_time >= '18:00' && s.start_time < '20:00' && s.available));
    ok('block outside opening hours rejected', (await j('POST', '/owner/spas/1/blocks', { date: d4, start_time: '06:00', end_time: '08:00' }, own)).status === 400);
    r = await j('GET', `/owner/spas/1/calendar?date=${d4}`, null, own);
    ok('calendar returns bookings, blocks and rooms', r.d.bookings.length >= 1 && r.d.blocks.length === 2 && r.d.roomTypes.length === 2, r.d);
    await j('DELETE', `/owner/blocks/${blk}`, null, own);
    ok('removing block restores availability', (await j('GET', `/spas/1/slots?serviceId=1&date=${d4}`)).d.slots.find((s) => s.start_time === '10:00').spots_left === 3);

    group('Customer: cancellation window & reschedule');
    const d2 = ist(2);
    r = await j('POST', '/bookings', { spaId: 2, serviceId: 5, date: d2, startTime: '11:00', paymentMode: 'pay_at_venue' }, cust);
    const rb = r.d.booking;
    let mine = (await j('GET', '/bookings/me', null, cust)).d.bookings.find((x) => x.id === rb.id);
    ok('booking shows it can be changed, with deadline', mine.can_change && mine.can_reschedule && !!mine.change_deadline, mine);
    r = await j('GET', `/bookings/${rb.id}/reschedule-slots?date=${d2}`, null, cust);
    ok('reschedule slots include own current time (excluded from clash)', r.d.slots.find((s) => s.start_time === '11:00').available, r.d);
    r = await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(2), startTime: '15:00' }, cust);
    ok('customer reschedules', r.status === 200 && r.d.booking.start_time === '15:00' && r.d.booking.rescheduled_count === 1, r);
    ok('booking ID unchanged after reschedule', r.d.booking.booking_ref === rb.booking_ref);
    ok('new confirmation sent', dbq('SELECT COUNT(*) c FROM notifications WHERE booking_id=?', rb.id)[0].c >= 4);
    ok('reschedule to taken/invalid time refused', (await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '03:00' }, cust)).status === 409);
    await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(2), startTime: '16:00' }, cust);
    ok('max two reschedules', (await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(2), startTime: '17:00' }, cust)).status === 409);
    ok('other customer cannot reschedule', (await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '18:00' }, cust2)).status === 404);
    await j('PUT', '/owner/spas/2', { cancel_window_hours: 72 }, own);
    mine = (await j('GET', '/bookings/me', null, cust)).d.bookings.find((x) => x.id === rb.id);
    ok('inside 72h window: cannot change', mine.can_change === false && mine.cancel_window_hours === 72, mine);
    ok('inside window: cancel refused with reason', /72 hours/.test((await j('PUT', `/bookings/${rb.id}/cancel`, {}, cust)).d.error || ''));
    await j('PUT', '/owner/spas/2', { cancel_window_hours: 0 }, own);
    ok('window 0: cancel allowed', (await j('PUT', `/bookings/${rb.id}/cancel`, {}, cust)).status === 200);
    ok('window > 72h rejected', (await j('PUT', '/owner/spas/2', { cancel_window_hours: 100 }, own)).status === 400);

    group('Profile');
    r = await j('PUT', '/me', { name: 'Priya S', email: 'PRIYA.NEW@Example.com' }, cust);
    ok('customer edits name/email (email normalised)', r.status === 200 && r.d.user.email === 'priya.new@example.com', r);
    ok('duplicate email refused', (await j('PUT', '/me', { email: 'owner1@bookmyspa.demo' }, cust)).status === 409);
    ok('wrong current password refused', (await j('PUT', '/me/password', { currentPassword: 'nope', newPassword: 'newpass1234' }, cust)).status === 400);
    await sleep(1100);
    r = await j('PUT', '/me/password', { currentPassword: 'customer123', newPassword: 'newpass1234' }, cust);
    ok('password changed, fresh session issued', r.status === 200 && !!r.d.token, r);
    const custNew = r.d.token;
    ok('old session signed out', (await j('GET', '/bookings/me', null, cust)).status === 401);
    ok('new password logs in', !!(await login('priya.new@example.com', 'newpass1234', 'customer')));
    o = await j('POST', '/auth/otp/send', { phone: '9876511122', purpose: 'registration' });
    r = await j('PUT', '/me/phone', { phone: '9876511122', otpCode: o.d.devCode }, custNew);
    ok('mobile number changed with OTP', r.status === 200 && r.d.user.phone === '9876511122' && r.d.user.phone_verified, r);
    ok('owner can edit own profile too', (await j('PUT', '/me', { name: 'Ravi K' }, own)).status === 200);

    group('Admin: edit & deactivate');
    ok('admin edits a user', (await j('PUT', '/admin/users/4', { name: 'Priya Sharma' }, adm)).d.user.name === 'Priya Sharma');
    r = await j('PUT', '/admin/users/4', { active: false }, adm);
    ok('admin deactivates customer', r.status === 200 && r.d.user.active === 0, r);
    ok('deactivated customer cannot log in', (await j('POST', '/auth/login', { email: 'priya.new@example.com', password: 'newpass1234', portal: 'customer' })).status === 403);
    ok('deactivated customer’s session stops working', (await j('GET', '/bookings/me', null, custNew)).status === 401);
    await j('PUT', '/admin/users/4', { active: true }, adm);
    ok('reactivated customer logs in again', !!(await login('priya.new@example.com', 'newpass1234', 'customer')));
    await j('PUT', '/admin/users/3', { active: false }, adm); // owner2 runs Lotus (Bangalore)
    ok('deactivated owner’s spas hidden from customers', !(await j('GET', '/spas')).d.spas.some((s) => s.name.includes('Lotus')) && (await j('GET', '/spas/3')).status === 404);
    await j('PUT', '/admin/users/3', { active: true }, adm);
    ok('reactivated owner’s spas return', (await j('GET', '/spas')).d.spas.some((s) => s.name.includes('Lotus')));
    ok('admin accounts cannot be deactivated', (await j('PUT', '/admin/users/1', { active: false }, adm)).status === 400);
    r = await j('PUT', '/admin/spas/2', { name: 'Urban Unwind Studio', closing_time: '22:00' }, adm);
    ok('admin edits spa details', r.status === 200 && (await j('GET', '/spas/2')).d.spa.name === 'Urban Unwind Studio', r);
    ok('customers cannot use admin edits', (await j('PUT', '/admin/spas/2', { name: 'x' }, cust2)).status === 403);

    group('Reminders');
    const soon = new Date(Date.now() + IST + 70 * 60000);
    const sDate = soon.toISOString().slice(0, 10), sTime = soon.toISOString().slice(11, 14) + '00';
    const eTime = new Date(soon.getTime() + 3600000).toISOString().slice(11, 16);
    const ins = dbx(`INSERT INTO bookings (customer_id,spa_id,service_id,booking_date,start_time,end_time,amount,status,payment_status,payment_mode,booking_ref,created_at)
                     VALUES (4,1,2,?,?,?,2599,'confirmed','unpaid','pay_at_venue','BMS-TEST-REM1',datetime('now','-3 hours'))`, sDate, sTime, eTime);
    const freshly = dbx(`INSERT INTO bookings (customer_id,spa_id,service_id,booking_date,start_time,end_time,amount,status,payment_status,payment_mode,booking_ref)
                     VALUES (4,1,2,?,?,?,2599,'confirmed','unpaid','pay_at_venue','BMS-TEST-REM2')`, sDate, sTime, eTime);
    process.chdir(TMP);
    const api = require(path.join(TMP, 'server/api.js'));
    const sent = await api.runReminders();
    ok('reminder sent for appointment ~1h away', dbq('SELECT reminder_sent FROM bookings WHERE id=?', Number(ins.lastInsertRowid))[0].reminder_sent === 1 && sent >= 1, sent);
    ok('no reminder for a booking made minutes ago', dbq('SELECT reminder_sent FROM bookings WHERE id=?', Number(freshly.lastInsertRowid))[0].reminder_sent === 0);
    ok('reminder goes out on SMS and WhatsApp', dbq("SELECT COUNT(*) c FROM notifications WHERE booking_id=? AND message LIKE '[REMINDER]%'", Number(ins.lastInsertRowid))[0].c === 2);
    ok('reminder never sent twice', (await api.runReminders()) === 0);

    // =================== PHASE 2 ===================
    const cu = await login('priya.new@example.com', 'newpass1234', 'customer');
    const retry = async (fn) => { let r; for (let i = 0; i < 6; i++) { r = await fn(i); if (r.d && (r.d.success || r.status === 200)) return r; } return r; }; // mock gateway declines ~3%
    const bookAt = (body) => j('POST', '/bookings', { spaId: 1, paymentMode: 'pay_at_venue', ...body }, cu);

    group('Therapists');
    let spa1 = (await j('GET', '/spas/1')).d;
    ok('spa page lists therapists with their services', spa1.therapists.length === 3 && spa1.therapists.every((t) => t.service_ids.length), spa1.therapists);
    const dT = ist(11);
    r = await j('GET', `/spas/1/slots?serviceId=1&date=${dT}&gender=male`);
    ok('slot search by gender (male → Rahul only)', r.d.slots.find((x) => x.start_time === '11:00').therapists_free === 1, r.d.slots[2]);
    r = await bookAt({ serviceId: 1, date: dT, startTime: '11:00', gender: 'male' });
    ok('male preference assigns the male therapist', r.status === 201 && r.d.therapist && r.d.therapist.name === 'Rahul', r);
    r = await j('GET', `/spas/1/slots?serviceId=1&date=${dT}&gender=male`);
    ok('no male therapist left at 11:00 even though rooms remain', r.d.slots.find((x) => x.start_time === '11:00').available === false && r.d.slots.find((x) => x.start_time === '11:00').spots_left === 2);
    ok('booking a busy-therapist time is refused', (await bookAt({ serviceId: 1, date: dT, startTime: '11:00', gender: 'male' })).status === 409);
    const meera = spa1.therapists.find((t) => t.name === 'Meera').id;
    r = await bookAt({ serviceId: 1, date: dT, startTime: '13:00', therapistId: meera });
    ok('customer picks a specific therapist', r.d.therapist && r.d.therapist.name === 'Meera', r);
    ok('same therapist can’t be double-booked', (await bookAt({ serviceId: 2, date: dT, startTime: '12:00', therapistId: meera })).status === 409 && (await j('GET', `/spas/1/slots?serviceId=2&date=${dT}&therapistId=${meera}`)).d.slots.find((x) => x.start_time === '12:00').therapists_free === 0);
    r = await bookAt({ serviceId: 1, date: dT, startTime: '13:00' });
    ok('"any therapist" auto-assigns someone free', r.status === 201 && ['Anita', 'Rahul'].includes(r.d.therapist.name), r);
    ok('services without therapists are unaffected', (await j('GET', `/spas/1/slots?serviceId=4&date=${dT}`)).d.slots.every((x) => x.therapists_free === null));
    r = await j('POST', '/owner/spas/1/therapists', { name: 'Arjun', gender: 'male', bio: 'Thai massage', service_ids: [1] }, own);
    ok('owner adds a therapist', r.status === 201, r);
    ok('new male therapist opens the 11:00 male slot again', (await j('GET', `/spas/1/slots?serviceId=1&date=${dT}&gender=male`)).d.slots.find((x) => x.start_time === '11:00').available);
    ok('therapist must perform at least one service', (await j('POST', '/owner/spas/1/therapists', { name: 'X Y', gender: 'female', service_ids: [] }, own)).status === 400);
    ok('therapist services must belong to the spa', (await j('POST', '/owner/spas/1/therapists', { name: 'X Y', gender: 'female', service_ids: [5] }, own)).status === 400);
    const rahul = spa1.therapists.find((t) => t.name === 'Rahul').id;
    r = await j('PUT', `/owner/therapists/${rahul}`, { active: false }, own);
    ok('owner deactivates a therapist (warned about upcoming bookings)', r.status === 200 && /upcoming/.test(r.d.message), r);
    ok('inactive therapist no longer offered', !(await j('GET', '/spas/1')).d.therapists.some((t) => t.name === 'Rahul'));
    await j('PUT', `/owner/therapists/${rahul}`, { active: true }, own);
    ok('other owners can’t edit this spa’s therapists', (await j('PUT', `/owner/therapists/${rahul}`, { name: 'Hack' }, own2)).status === 404);

    group('Packages');
    spa1 = (await j('GET', '/spas/1')).d;
    const pk = spa1.packages[0];
    ok('spa page lists packages', pk && pk.sessions === 5 && pk.price === 7499, spa1.packages);
    r = await j('POST', `/packages/${pk.id}/buy`, {}, cu);
    const pp = r.d.purchaseId;
    let o2 = await j('POST', `/purchases/${pp}/checkout`, {}, cu);
    ok('package checkout creates an order for the package price', o2.d.amountPaise === 749900, o2.d);
    r = await retry(() => j('POST', `/purchases/${pp}/verify`, { mode: 'mock', orderId: o2.d.orderId, paymentId: 'pay_pkg', signature: 'm' }, cu));
    ok('package activated after payment', r.d.success && r.d.package.status === 'active' && r.d.package.per_session_value === 1499.8, r.d);
    const cpk = r.d.package.id;
    let w = (await j('GET', '/wallet', null, cu)).d;
    ok('wallet shows the package with 5 sessions', w.packages[0].sessions_total === 5 && w.packages[0].sessions_used === 0);
    const dP = ist(12);
    r = await bookAt({ serviceId: 1, date: dP, startTime: '10:00', customerPackageId: cpk, paymentMode: 'online' });
    ok('booking with a package session is confirmed and prepaid', r.status === 201 && r.d.booking.status === 'confirmed' && r.d.booking.payment_status === 'paid' && r.d.booking.amount === 1499.8, r.d);
    const pkb = r.d.booking.id;
    ok('session counted', (await j('GET', '/wallet', null, cu)).d.packages[0].sessions_used === 1);
    ok('package can’t be used for another service', (await bookAt({ serviceId: 2, date: dP, startTime: '15:00', customerPackageId: cpk })).status === 400);
    ok('package + coupon refused', (await bookAt({ serviceId: 1, date: dP, startTime: '15:00', customerPackageId: cpk, couponCode: 'WELCOME20' })).status === 400);
    r = await j('PUT', `/bookings/${pkb}/cancel`, {}, cu);
    ok('cancelling returns the session', /session has been returned/.test(r.d.message) && (await j('GET', '/wallet', null, cu)).d.packages[0].sessions_used === 0, r.d);
    ok('owner sees packages sold', (await j('GET', '/owner/spas/1/packages', null, own)).d.packages[0].sold === 1);
    ok('package validation (sessions 2–50)', (await j('POST', '/owner/spas/1/packages', { name: 'Big', service_id: 1, sessions: 100, price: 1000 }, own)).status === 400);

    group('Gift cards');
    r = await j('POST', '/giftcards', { amount: 1000, recipient_name: 'Asha', message: 'Happy birthday!' }, cu);
    const gp = r.d.purchaseId;
    o2 = await j('POST', `/purchases/${gp}/checkout`, {}, cu);
    r = await retry(() => j('POST', `/purchases/${gp}/verify`, { mode: 'mock', orderId: o2.d.orderId, paymentId: 'pay_gc', signature: 'm' }, cu));
    const code = r.d.giftCard && r.d.giftCard.code;
    ok('gift card issued with a code after payment', /^GIFT-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(code || ''), r.d);
    ok('gift card amount limits', (await j('POST', '/giftcards', { amount: 100 }, cu)).status === 400);
    ok('balance check works', (await j('GET', `/giftcards/check?code=${code}`, null, cu)).d.balance === 1000);
    ok('bad code rejected', (await j('GET', '/giftcards/check?code=GIFT-AAAA-BBBB', null, cu)).d.valid === false);
    const dG = ist(13);
    r = await bookAt({ serviceId: 2, date: dG, startTime: '10:30', giftCardCode: code.toLowerCase() });
    ok('gift card part-pays a booking; rest due at the spa', r.status === 201 && r.d.booking.giftcard_amount === 1000 && r.d.due === 1599 && r.d.booking.status === 'confirmed', r.d);
    const gb = r.d.booking.id;
    ok('balance spent', (await j('GET', `/giftcards/check?code=${code}`, null, cu)).d.valid === false);
    r = await j('PUT', `/bookings/${gb}/cancel`, {}, cu);
    ok('cancelling returns the money to the gift card', /returned to your gift card/.test(r.d.message) && (await j('GET', `/giftcards/check?code=${code}`, null, cu)).d.balance === 1000, r.d);
    r = await j('POST', '/giftcards', { amount: 3000 }, cu); const gp2 = r.d.purchaseId;
    o2 = await j('POST', `/purchases/${gp2}/checkout`, {}, cu);
    const code2 = (await retry(() => j('POST', `/purchases/${gp2}/verify`, { mode: 'mock', orderId: o2.d.orderId, paymentId: 'pay_gc2', signature: 'm' }, cu))).d.giftCard.code;
    r = await bookAt({ serviceId: 2, date: dG, startTime: '13:30', giftCardCode: code2, paymentMode: 'online' });
    ok('gift card covering the full price confirms instantly (no payment step)', r.d.booking.status === 'confirmed' && r.d.booking.payment_status === 'paid' && r.d.due === 0, r.d);
    r = await bookAt({ serviceId: 1, date: dG, startTime: '16:00', giftCardCode: code, paymentMode: 'online' });
    const ob = r.d.booking;
    o2 = await j('POST', `/bookings/${ob.id}/checkout`, {}, cu);
    ok('online checkout charges only what the gift card didn’t cover', o2.d.amountPaise === Math.round((ob.amount - 1000) * 100), o2.d);
    dbx("UPDATE bookings SET created_at = datetime('now','-15 minutes') WHERE id = ?", ob.id);
    await j('GET', `/spas/1/slots?serviceId=1&date=${dG}`);
    ok('abandoned online payment releases the slot and gives the gift money back', dbq('SELECT status FROM bookings WHERE id=?', ob.id)[0].status === 'cancelled' && (await j('GET', `/giftcards/check?code=${code}`, null, cu)).d.balance === 1000);
    w = (await j('GET', '/wallet', null, cu)).d;
    ok('wallet lists both gift cards', w.giftCards.length === 2);
    ok('admin sees gift-card and package liabilities', (await j('GET', '/admin/stats', null, adm)).d.giftCardLiability >= 1000);

    group('GST invoices');
    ok('invalid GSTIN rejected', (await j('PUT', '/owner/spas/1', { gstin: 'ABC123' }, own)).status === 400);
    r = await j('PUT', '/owner/spas/1', { gstin: '36abcde1234f1z5', legal_name: 'Serene Wellness Pvt Ltd', gst_rate: 18 }, own);
    ok('owner saves GST details (GSTIN upper-cased)', r.status === 200 && r.d.spa.gstin === '36ABCDE1234F1Z5', r.d);
    const unpaid = (await bookAt({ serviceId: 3, date: ist(14), startTime: '10:00' })).d.booking;
    ok('no invoice before payment', (await j('GET', `/bookings/${unpaid.id}/invoice`, null, cu)).status === 409);
    await j('PUT', `/owner/bookings/${unpaid.id}/mark-paid`, { method: 'upi' }, own);
    r = await j('GET', `/bookings/${unpaid.id}/invoice`, null, cu);
    const inv = r.d.invoice;
    ok('tax invoice issued once paid', inv && inv.title === 'Tax invoice' && inv.supplier.gstin === '36ABCDE1234F1Z5', r.d);
    ok('GST split adds up (taxable + CGST + SGST = total)', Math.abs(inv.tax.taxable + inv.tax.cgst + inv.tax.sgst - inv.total) < 0.011 && inv.tax.cgst === inv.tax.sgst || Math.abs(inv.tax.cgst - inv.tax.sgst) <= 0.01, inv.tax);
    ok('invoice number follows the GST serial format', /^S1\/\d{2}-\d{2}\/0001$/.test(inv.invoice_no), inv.invoice_no);
    ok('same invoice returned every time (never renumbered)', (await j('GET', `/bookings/${unpaid.id}/invoice`, null, cu)).d.invoice.invoice_no === inv.invoice_no);
    ok('owner and admin can open it; other customers can’t', (await j('GET', `/bookings/${unpaid.id}/invoice`, null, own)).status === 200 && (await j('GET', `/bookings/${unpaid.id}/invoice`, null, adm)).status === 200 && (await j('GET', `/bookings/${unpaid.id}/invoice`, null, cust2)).status === 404);
    ok('invoice shows how it was paid', inv.paid_by[0].method.includes('Paid at spa (upi)'));
    const gift2 = dbq('SELECT id FROM bookings WHERE gift_card_id IS NOT NULL AND status = ? LIMIT 1', 'confirmed')[0].id;
    r = await j('GET', `/bookings/${gift2}/invoice`, null, cu);
    ok('next invoice gets the next number', /\/0002$/.test(r.d.invoice.invoice_no) && r.d.invoice.paid_by[0].method === 'Gift card', r.d.invoice);
    dbx("UPDATE bookings SET status='completed' WHERE id = ?", unpaid.id);
    r = await j('POST', '/admin/spas/1/settle', { reference: 'UTR-P2' }, adm);
    r = await j('GET', `/settlements/${r.d.settlementId}/invoice`, null, own);
    ok('commission statement for each settlement', r.status === 200 && /Commission/.test(r.d.invoice.title) && /^BMS\/\d{2}-\d{2}\/00001$/.test(r.d.invoice.invoice_no), r.d);
    ok('other owners can’t see it', (await j('GET', `/settlements/1/invoice`, null, own2)).status === 404);

    group('Premium & Insights');
    let own3 = await login('owner2@bookmyspa.demo', 'owner123', 'partner');
    r = await j('GET', '/owner/insights', null, own);
    ok('Insights locked without Premium (402)', r.status === 402 && r.d.premium === false, r);
    ok('CSV export locked too', (await j('GET', '/owner/insights/export?type=customers', null, own)).status === 402);
    r = await j('GET', '/owner/premium', null, own);
    ok('owner sees admin prices and a free trial offer', r.d.settings.priceMonthly === 999 && r.d.status.trialAvailable && !r.d.status.active, r.d);
    ok('admin price validation', (await j('PUT', '/admin/premium', { priceMonthly: -5 }, adm)).status === 400);
    ok('admin sets prices and trial length', (await j('PUT', '/admin/premium', { priceMonthly: 1499, priceYearly: 14999, trialDays: 7 }, adm)).d.settings.priceMonthly === 1499);
    r = await j('POST', '/owner/premium/subscribe', { plan: 'trial' }, own);
    ok('free trial starts instantly for 7 days', r.status === 201 && r.d.status.active && r.d.status.daysLeft === 7, r.d);
    ok('trial only once', (await j('POST', '/owner/premium/subscribe', { plan: 'trial' }, own)).status === 409);
    r = await j('POST', '/owner/premium/subscribe', { plan: 'monthly' }, own);
    ok('monthly plan priced from admin setting', r.d.amount === 1499, r.d);
    let po = await j('POST', `/owner/premium/${r.d.subscriptionId}/checkout`, {}, own);
    ok('checkout amount matches', po.d.amountPaise === 149900, po.d);
    let pv; for (let i = 0; i < 6; i++) { pv = await j('POST', `/owner/premium/${r.d.subscriptionId}/verify`, { mode: 'mock', orderId: po.d.orderId, paymentId: 'pp' + i, signature: 'm' }, own); if (pv.d.success) break; }
    ok('paid month is added after the trial (no lost days)', pv.d.success && pv.d.status.daysLeft >= 7 + 28 && pv.d.status.daysLeft <= 7 + 31, pv.d);
    ok('another owner can’t pay for this subscription', (await j('POST', `/owner/premium/${r.d.subscriptionId}/verify`, { mode: 'mock', orderId: 'x', paymentId: 'y', signature: 'm' }, own3)).status === 404);
    // known history: two customers at Serene Bliss
    const vd = (d) => ist(-d);
    const addVisit = (cid, d, amt, extra = '') => dbx(`INSERT INTO bookings (customer_id,spa_id,service_id,booking_date,start_time,end_time,amount,status,payment_status,payment_mode,created_at${extra ? ',cancel_reason' : ''})
      VALUES (?,1,1,?,'18:00','19:00',?,${extra ? "'cancelled'" : "'completed'"},'paid','pay_at_venue',datetime('now','-${d + 2} days')${extra ? ",'" + extra + "'" : ''})`, cid, vd(d), amt);
    const c1 = dbq("SELECT id FROM users WHERE email='priya.new@example.com'")[0].id;
    const c2 = Number(dbx("INSERT INTO users (name,email,phone,phone_verified,password_hash,password_salt,role) VALUES ('Rohan Test','rohan@t.com','9000099999',1,'x','x','customer')").lastInsertRowid);
    [200, 160, 120].forEach((d) => addVisit(c2, d, 1000));   // Rohan: regular, then stopped → lapsed
    addVisit(c1, 20, 2000); addVisit(c1, 10, 2000);           // Priya: recent visits in the window
    addVisit(c1, 5, 2000, 'no_show');
    r = await j('GET', '/owner/insights?spa=1&days=30', null, own);
    ok('insights unlocked with Premium', r.status === 200 && r.d.range.days === 30, r.status);
    const pri = r.d.customers.find((c) => c.id === c1), roh = r.d.customers.find((c) => c.id === c2);
    ok('customer table: Rohan has 3 visits, ₹3,000, lapsed', roh && roh.visits === 3 && roh.spend === 3000 && roh.segment === 'lapsed' && roh.avg_gap_days === 40, roh);
    ok('customer table: favourite service and last visit', pri && pri.favourite && pri.last_visit === vd(10), pri);
    ok('window revenue includes the 30-day visits only', r.d.kpis.revenue.value >= 4000 && !r.d.customers.some((c) => c.id === c2 && r.d.series.some((s) => s.from <= vd(120) && s.to >= vd(120))), r.d.kpis.revenue);
    ok('no-shows counted in the rate', r.d.kpis.noShowRate.value > 0, r.d.kpis.noShowRate);
    ok('series has a bucket per day for 30 days', r.d.series.length === 30 && r.d.range.unit === 'day');
    ok('heatmap covers opening hours, Mon–Sun', r.d.heatmap.days[0] === 'Mon' && r.d.heatmap.hours.length >= 10);
    ok('win-back hint mentions lapsed customers', r.d.notes.some((n) => /haven’t been back|hasn’t been back/.test(n.text)), r.d.notes);
    ok('12-month view uses monthly buckets', (await j('GET', '/owner/insights?spa=1&days=365', null, own)).d.range.unit === 'month');
    ok('owners can’t read another owner’s spa', (await j('GET', '/owner/insights?spa=1&days=30', null, own3)).status === 402 && (await j('POST', '/admin/premium/grant', { owner_id: 3, months: 1 }, adm)).status === 201
      && (await j('GET', '/owner/insights?spa=1', null, own3)).status === 404);
    ok('… or that owner’s customer history', (await j('GET', `/owner/insights/customers/${c2}`, null, own3)).status === 404);
    r = await j('GET', `/owner/insights/customers/${c2}`, null, own);
    ok('customer history for own customer', r.d.bookings.length === 3);
    dbx("UPDATE users SET name = '=HYPERLINK(\"http://evil\")' WHERE id = ?", c2);
    const csvRes = await fetch(B + '/owner/insights/export?type=customers&spa=1', { headers: { Authorization: 'Bearer ' + own } });
    const csvText = await csvRes.text();
    ok('CSV export is a spreadsheet file', csvRes.headers.get('content-type').startsWith('text/csv') && /^\uFEFF?Name,Phone,Email,Segment/.test(csvText));
    ok('CSV export defuses spreadsheet formulas', !/\n=HYPERLINK/.test(csvText) && /"'=HYPERLINK/.test(csvText), csvText.split('\n').find((l) => /HYPERLINK/.test(l)));
    ok('bookings CSV includes booking IDs', /^\uFEFF?Booking ID,Date/.test(await (await fetch(B + '/owner/insights/export?type=bookings', { headers: { Authorization: 'Bearer ' + own } })).text()));
    r = await j('GET', '/admin/premium', null, adm);
    ok('admin sees subscribers and Premium revenue', r.d.activeCount === 2 && r.d.revenue === 1499, { a: r.d.activeCount, rev: r.d.revenue });
    ok('admin stats include Premium', (await j('GET', '/admin/stats', null, adm)).d.premiumActive === 2);
    const grantId = r.d.subscriptions.find((x) => x.owner_id === 3).id;
    await j('PUT', `/admin/premium/${grantId}/cancel`, {}, adm);
    ok('cancelling removes access immediately', (await j('GET', '/owner/insights', null, own3)).status === 402);
    ok('customers can’t use Premium endpoints', (await j('GET', '/owner/premium', null, cu)).status === 403);

    group('Advance deposit & booking fee');
    {
      const sett1 = async () => (await j('GET', '/admin/settlements', null, adm)).d.spas.find((x) => x.spa_id === 1);
      const sv2 = (await j('GET', '/spas/1')).d.services.find((x) => x.id === 2);
      const price = sv2.final_price, rate = 10, expDep = Math.max(199, Math.ceil(price * rate / 100));
      const qb = (date, startTime) => ({ spaId: 1, serviceId: 2, date, startTime });
      let q = await j('POST', '/bookings/quote', qb(ist(21), '10:30'), cu);
      const modes = (q.d.options || []).map((o) => o.mode).join(',');
      ok('default checkout offers full online, advance and pay at spa', modes === 'online,deposit,pay_at_venue', q.d);
      const dop = q.d.options.find((o) => o.mode === 'deposit');
      ok('advance is ₹199 or the commission if higher, rest at the spa', dop.deposit === expDep && dop.payAtSpa === price - expDep && dop.payNow === expDep, dop);
      ok('quote needs a customer login', (await j('POST', '/bookings/quote', qb(ist(21), '10:30'))).status === 401);
      ok('booking fee limit enforced', (await j('PUT', '/admin/payment-settings', { booking_fee: 9999 }, adm)).status === 400);
      ok('percentage advance limit enforced', (await j('PUT', '/admin/payment-settings', { deposit_type: 'percent', deposit_value: 95 }, adm)).status === 400);
      r = await j('PUT', '/admin/payment-settings', { booking_fee: 20 }, adm);
      ok('admin sets a ₹20 booking fee', r.status === 200 && r.d.settings.booking_fee === 20, r.d);
      q = await j('POST', '/bookings/quote', qb(ist(21), '10:30'), cu);
      ok('fee added to online payments only', q.d.options.find((o) => o.mode === 'online').payNow === price + 20 && q.d.options.find((o) => o.mode === 'deposit').payNow === expDep + 20 && q.d.options.find((o) => o.mode === 'pay_at_venue').payNow === 0, q.d.options);
      ok('stale price on screen is refused', (await j('POST', '/bookings', { ...qb(ist(21), '10:30'), paymentMode: 'deposit', expectedPayNow: 1 }, cu)).status === 409);

      // Reserve with advance → pay → visit → balance at counter → settlement
      const before = await sett1();
      r = await j('POST', '/bookings', { ...qb(ist(21), '10:30'), paymentMode: 'deposit', expectedPayNow: expDep + 20 }, cu);
      const db1 = r.d.booking;
      ok('advance booking holds the slot until paid', r.status === 201 && db1.status === 'pending_payment' && db1.payment_mode === 'pay_at_venue' && db1.deposit_amount === expDep && db1.deposit_status === 'pending' && db1.booking_fee === 20, r.d);
      let co = await j('POST', `/bookings/${db1.id}/checkout`, {}, cu);
      ok('checkout charges advance + fee only', co.status === 200 && co.d.amountPaise === (expDep + 20) * 100, co.d);
      r = await retry(async () => { const c = await j('POST', `/bookings/${db1.id}/checkout`, {}, cu); return j('POST', `/bookings/${db1.id}/verify`, { mode: 'mock', orderId: c.d.orderId, paymentId: 'pay_dep1', signature: 'm' }, cu); });
      let row = dbq('SELECT * FROM bookings WHERE id=?', db1.id)[0];
      ok('paying the advance confirms; balance still due at the spa', row.status === 'confirmed' && row.deposit_status === 'paid' && row.payment_status === 'unpaid', row);
      ok('payment recorded for advance + fee', dbq("SELECT amount FROM payments WHERE booking_id=? AND status='success'", db1.id)[0].amount === expDep + 20);
      const mine = (await j('GET', '/bookings/me', null, cu)).d.bookings.find((x) => x.id === db1.id);
      ok('customer sees the advance in My bookings', mine.deposit_status === 'paid' && mine.deposit_amount === expDep);
      dbx("UPDATE bookings SET status='completed' WHERE id=?", db1.id);
      const after = await sett1();
      ok('settlement: advance is money we hold, rest collected by the spa', round(after.onlineGross - before.onlineGross) === expDep && round(after.venueGross - before.venueGross) === price - expDep, { before, after });
      ok('settlement: commission on the full price', round(after.commissionTotal - before.commissionTotal) === round(price * rate / 100));
      ok('settlement: booking fee is not part of the spa’s money', round(after.netToSpa - before.netToSpa) === round(expDep - price * rate / 100));
      r = await j('PUT', `/owner/bookings/${db1.id}/mark-paid`, { method: 'upi' }, own);
      ok('counter payment records just the balance', r.status === 200 && dbq("SELECT amount FROM payments WHERE booking_id=? AND transaction_ref LIKE 'COUNTER_%'", db1.id)[0].amount === price - expDep, r.d);
      const inv = (await j('GET', `/bookings/${db1.id}/invoice`, null, cu)).d.invoice || (await j('GET', `/bookings/${db1.id}/invoice`, null, cu)).d;
      ok('invoice shows advance, counter payment and the fee separately', JSON.stringify(inv).includes('Advance paid online') && inv.platform_fee === 20, inv);

      // No-show keeps the advance for the spa (minus commission)
      r = await j('POST', '/bookings', { ...qb(ist(22), '10:30'), paymentMode: 'deposit' }, cu);
      const db2 = r.d.booking;
      await retry(async () => { const c = await j('POST', `/bookings/${db2.id}/checkout`, {}, cu); return j('POST', `/bookings/${db2.id}/verify`, { mode: 'mock', orderId: c.d.orderId, paymentId: 'pay_dep2', signature: 'm' }, cu); });
      ok('no-show not allowed before the day', (await j('PUT', `/owner/bookings/${db2.id}/status`, { status: 'no_show' }, own)).status === 400);
      dbx('UPDATE bookings SET booking_date=? WHERE id=?', ist(0), db2.id);
      const b4 = await sett1();
      r = await j('PUT', `/owner/bookings/${db2.id}/status`, { status: 'no_show' }, own);
      row = dbq('SELECT * FROM bookings WHERE id=?', db2.id)[0];
      ok('no-show keeps the advance', r.status === 200 && row.deposit_status === 'forfeited' && row.cancel_reason === 'no_show' && row.commission_amount === round(expDep * rate / 100), { r: r.d, row });
      const a4 = await sett1();
      ok('kept advance is paid to the spa minus commission', round(a4.onlineGross - b4.onlineGross) === expDep && round(a4.netToSpa - b4.netToSpa) === round(expDep - expDep * rate / 100), { b4, a4 });

      // Cancelling inside the free window refunds advance + fee
      r = await j('POST', '/bookings', { ...qb(ist(23), '10:30'), paymentMode: 'deposit' }, cu);
      const db3 = r.d.booking;
      await retry(async () => { const c = await j('POST', `/bookings/${db3.id}/checkout`, {}, cu); return j('POST', `/bookings/${db3.id}/verify`, { mode: 'mock', orderId: c.d.orderId, paymentId: 'pay_dep3', signature: 'm' }, cu); });
      r = await j('PUT', `/bookings/${db3.id}/cancel`, {}, cu);
      row = dbq('SELECT * FROM bookings WHERE id=?', db3.id)[0];
      ok('customer cancel refunds advance + fee', r.status === 200 && new RegExp(`₹${expDep + 20} refund`).test(r.d.message) && row.deposit_status === 'refunded' && row.refund_status === 'refunded', { r: r.d, row });

      // Spa cancels a fully-paid online booking → customer refunded
      r = await j('POST', '/bookings', { ...qb(ist(24), '10:30'), paymentMode: 'online' }, cu);
      const ob = r.d.booking;
      await retry(async () => { const c = await j('POST', `/bookings/${ob.id}/checkout`, {}, cu); return j('POST', `/bookings/${ob.id}/verify`, { mode: 'mock', orderId: c.d.orderId, paymentId: 'pay_on1', signature: 'm' }, cu); });
      r = await j('PUT', `/owner/bookings/${ob.id}/status`, { status: 'cancelled' }, own);
      row = dbq('SELECT * FROM bookings WHERE id=?', ob.id)[0];
      ok('spa cancelling a paid booking refunds the customer', r.status === 200 && row.payment_status === 'refunded' && row.refund_status === 'refunded' && row.cancel_reason === 'owner', { r: r.d, row });
      ok('cannot cancel twice', (await j('PUT', `/owner/bookings/${ob.id}/status`, { status: 'cancelled' }, own)).status === 409);

      // Paid after the 10-minute hold expired → automatic refund
      r = await j('POST', '/bookings', { ...qb(ist(25), '10:30'), paymentMode: 'deposit' }, cu);
      const lb = r.d.booking; co = await j('POST', `/bookings/${lb.id}/checkout`, {}, cu);
      dbx("UPDATE bookings SET status='cancelled', cancel_reason='payment_timeout', deposit_status='expired' WHERE id=?", lb.id);
      r = await j('POST', `/bookings/${lb.id}/verify`, { mode: 'mock', orderId: co.d.orderId, paymentId: 'pay_late', signature: 'm' }, cu);
      row = dbq('SELECT * FROM bookings WHERE id=?', lb.id)[0];
      ok('late payment is refunded, not lost', r.status === 409 && /refund/.test(r.d.error) && row.refund_status === 'refunded', { r: r.d, row });

      // Required advance and per-spa override
      await j('PUT', '/admin/payment-settings', { deposit_policy: 'required' }, adm);
      q = await j('POST', '/bookings/quote', qb(ist(26), '10:30'), cu);
      ok('required: no zero-advance bookings', !q.d.options.some((o) => o.mode === 'pay_at_venue') && q.d.options.some((o) => o.mode === 'deposit'), q.d.options);
      r = await j('POST', '/bookings', { ...qb(ist(26), '10:30'), paymentMode: 'pay_at_venue' }, cu);
      ok('required: pay-at-spa booking refused with a clear reason', r.status === 400 && /advance/.test(r.d.error), r.d);
      await j('PUT', '/admin/spas/1/commercials', { deposit_policy: 'off' }, adm);
      q = await j('POST', '/bookings/quote', qb(ist(26), '10:30'), cu);
      ok('per-spa override switches the advance off', q.d.options.map((o) => o.mode).join(',') === 'online,pay_at_venue', q.d.options);
      await j('PUT', '/admin/spas/1/commercials', { deposit_policy: 'default', deposit_amount: 500 }, adm);
      q = await j('POST', '/bookings/quote', qb(ist(26), '10:30'), cu);
      ok('per-spa advance amount', q.d.options.find((o) => o.mode === 'deposit').deposit === Math.max(500, Math.ceil(price * rate / 100)), q.d.options);
      ok('bad per-spa policy rejected', (await j('PUT', '/admin/spas/1/commercials', { deposit_policy: 'sometimes' }, adm)).status === 400);
      const stt = (await j('GET', '/admin/stats', null, adm)).d;
      ok('admin stats show booking fees', stt.bookingFees === 40 && stt.failedRefunds === 0, { fees: stt.bookingFees, f: stt.failedRefunds });
      await j('PUT', '/admin/spas/1/commercials', { deposit_policy: 'default', deposit_amount: null }, adm);
      await j('PUT', '/admin/payment-settings', { deposit_policy: 'optional', booking_fee: 0 }, adm);
    }

    group('Booking times: automatic, fixed, customer clock');
    {
      const dS = ist(27), sv = (await j('GET', '/spas/1')).d.services.find((x) => x.id === 2), dur = sv.duration_minutes;
      const starts = async () => (await j('GET', `/spas/1/slots?serviceId=2&date=${dS}`)).d.slots;
      const sp = (await j('GET', '/spas/1')).d.spa;
      const toM = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
      ok('spas start on automatic slots', sp.slot_mode === 'auto');
      ok('fixed mode needs at least one time', (await j('PUT', '/owner/spas/1', { slot_mode: 'fixed', slot_times: '' }, own)).status === 400);
      ok('nonsense time rejected', (await j('PUT', '/owner/spas/1', { slot_mode: 'fixed', slot_times: '10:00, 25:00' }, own)).status === 400);
      r = await j('PUT', '/owner/spas/1', { slot_mode: 'fixed', slot_times: '07:00' }, own);
      ok('time outside opening hours rejected', r.status === 400 && /outside your opening hours/.test(r.d.error), r.d);
      r = await j('PUT', '/owner/spas/1', { slot_mode: 'fixed', slot_times: '13:30, 10:00 9:15, 10:00' }, own);
      ok('owner saves fixed times (sorted, de-duplicated)', r.status === 200 && r.d.spa.slot_mode === 'fixed' && r.d.spa.slot_times === '09:15,10:00,13:30', r.d);
      ok('customers see exactly those times', (await starts()).map((x) => x.start_time).join(',') === '09:15,10:00,13:30');
      ok('booking a time not on the list is refused', (await j('POST', '/bookings', { spaId: 1, serviceId: 2, date: dS, startTime: '11:00', paymentMode: 'pay_at_venue' }, cu)).status === 409);
      r = await j('POST', '/bookings', { spaId: 1, serviceId: 2, date: dS, startTime: '13:30', paymentMode: 'pay_at_venue' }, cu);
      ok('booking a listed time works', r.status === 201, r.d);
      ok('bad clock step rejected', (await j('PUT', '/owner/spas/1', { slot_mode: 'flexible', slot_step: 7 }, own)).status === 400);
      r = await j('PUT', '/owner/spas/1', { slot_mode: 'flexible', slot_step: 15 }, own);
      ok('owner switches to customer-picks-a-time', r.status === 200 && r.d.spa.slot_mode === 'flexible' && r.d.spa.slot_step === 15, r.d);
      const fl = await starts();
      const open = toM(r.d.spa.opening_time), close = toM(r.d.spa.closing_time);
      ok('clock offers every 15 minutes within hours', fl.length === Math.floor((close - dur - open) / 15) + 1 && fl.every((x) => (toM(x.start_time) - open) % 15 === 0), fl.length);
      const at = (t) => fl.find((x) => x.start_time === t);
      const endM = 13 * 60 + 30 + dur, endT = `${String(Math.floor(endM / 60)).padStart(2, '0')}:${String(endM % 60).padStart(2, '0')}`;
      const before = `${String(Math.floor((endM - 15) / 60)).padStart(2, '0')}:${String((endM - 15) % 60).padStart(2, '0')}`;
      ok('overlapping times share the room correctly', at(before).spots_left === at(before).capacity - 1 && at(endT).spots_left === at(endT).capacity, { b: at(before), e: at(endT) });
      r = await j('POST', '/bookings', { spaId: 1, serviceId: 2, date: dS, startTime: '16:45', paymentMode: 'pay_at_venue' }, cu);
      ok('customer books an off-grid clock time (16:45)', r.status === 201 && r.d.booking.start_time === '16:45', r.d);
      ok('time off the 15-minute mark refused', (await j('POST', '/bookings', { spaId: 1, serviceId: 2, date: dS, startTime: '16:50', paymentMode: 'pay_at_venue' }, cu)).status === 409);
      ok('other owners can’t change it', (await j('PUT', '/owner/spas/1', { slot_mode: 'auto' }, own2)).status === 404);
      await j('PUT', '/owner/spas/1', { slot_mode: 'auto' }, own);
      ok('back to automatic slots', (await starts()).every((x) => (toM(x.start_time) - open) % dur === 0));
    }

    group('Per-spa ways to pay (admin)');
    {
      const qb = { spaId: 1, serviceId: 2, date: ist(28), startTime: '10:30' };
      const modes = async () => ((await j('POST', '/bookings/quote', qb, cu)).d.options || []).map((o) => o.mode).join(',');
      ok('default spa offers all three', (await modes()) === 'online,deposit,pay_at_venue');
      ok('must pick at least one option', (await j('PUT', '/admin/spas/1/commercials', { payment_options: 'nonsense' }, adm)).status === 400);
      ok('booking fee over ₹500 rejected', (await j('PUT', '/admin/spas/1/commercials', { booking_fee: 600 }, adm)).status === 400);
      r = await j('PUT', '/admin/spas/1/commercials', { payment_options: 'deposit', booking_fee: 30 }, adm);
      let q = (await j('POST', '/bookings/quote', qb, cu)).d;
      ok('advance only, with this spa’s own ₹30 fee', r.status === 200 && q.options.map((o) => o.mode).join(',') === 'deposit' && q.options[0].fee === 30 && q.options[0].payNow === q.options[0].deposit + 30, q);
      ok('pay-at-spa refused for an advance-only spa', (await j('POST', '/bookings', { ...qb, paymentMode: 'pay_at_venue' }, cu)).status === 400);
      await j('PUT', '/admin/spas/1/commercials', { payment_options: 'venue' }, adm);
      ok('pay at spa only', (await modes()) === 'pay_at_venue');
      r = await j('POST', '/bookings', { ...qb, paymentMode: 'online' }, cu);
      ok('full online refused with a clear reason', r.status === 400 && /doesn’t take full payment online/.test(r.d.error), r.d);
      await j('PUT', '/admin/spas/1/commercials', { payment_options: 'online,venue' }, adm);
      ok('full online + pay at spa', (await modes()) === 'online,pay_at_venue');
      const row = (await j('GET', '/admin/settlements', null, adm)).d.spas.find((x) => x.spa_id === 1);
      ok('admin sees the spa’s own choice and fee', row.payment_custom === true && row.payment_options.join(',') === 'online,venue' && row.booking_fee === 30, row);
      ok('other spas unaffected', ((await j('POST', '/bookings/quote', { spaId: 2, serviceId: 5, date: ist(28), startTime: '11:00' }, cu)).d.options || []).length === 3);
      await j('PUT', '/admin/spas/1/commercials', { payment_options: null, booking_fee: null }, adm);
      ok('back to the platform default', (await modes()) === 'online,deposit,pay_at_venue' && (await j('POST', '/bookings/quote', qb, cu)).d.fee === 0);
    }

    group('Special requests');
    {
      const dR2 = ist(29), base = { spaId: 1, serviceId: 2, date: dR2, paymentMode: 'pay_at_venue' };
      ok('requests over 500 characters refused', (await j('POST', '/bookings', { ...base, startTime: '10:30', specialRequest: 'x'.repeat(501) }, cu)).status === 400);
      r = await j('POST', '/bookings', { ...base, startTime: '10:30', specialRequest: '  Please focus on shoulders <script>alert(1)</script>\n\n\n\nNo nut oils  ' }, cu);
      const sb = r.d.booking;
      ok('request saved with the booking, HTML stripped, blank lines tidied', r.status === 201 && sb.special_request === 'Please focus on shoulders scriptalert(1)/script\n\nNo nut oils', sb && sb.special_request);
      ok('spa owner sees it in Bookings', (await j('GET', '/owner/bookings', null, own)).d.bookings.find((x) => x.id === sb.id).special_request.startsWith('Please focus'));
      ok('spa owner sees it on the calendar', (await j('GET', `/owner/spas/1/calendar?date=${dR2}`, null, own)).d.bookings.find((x) => x.id === sb.id).special_request.includes('No nut oils'));
      ok('customer sees it in My bookings', (await j('GET', '/bookings/me', null, cu)).d.bookings.find((x) => x.id === sb.id).special_request.includes('shoulders'));
      ok('other owners can’t see it', !(await j('GET', '/owner/bookings', null, own2)).d.bookings.some((x) => x.id === sb.id));
      r = await j('POST', '/bookings', { ...base, startTime: '12:00' }, cu);
      ok('the box is optional', r.status === 201 && r.d.booking.special_request === null, r.d);
    }

    group('Backups');
    r = await j('POST', '/admin/backups', {}, adm);
    ok('manual backup works', r.status === 201 && /manual\.db$/.test(r.d.name), r);
    // =================== RAZORPAY ROUTE (fake Razorpay server) ===================
    group('Automatic payouts (Razorpay Route)');
    srv.kill(); await sleep(400);
    const http = require('node:http'), crypto = require('node:crypto');
    const seen = []; let n = 0;
    const fake = http.createServer((q, rs) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => {
      const body = b ? JSON.parse(b) : {}; seen.push({ url: q.url, body, auth: q.headers.authorization });
      rs.writeHead(200, { 'Content-Type': 'application/json' });
      rs.end(JSON.stringify(q.url === '/v1/orders' ? { id: 'order_T' + (++n), amount: body.amount, currency: 'INR' } : { id: 'rfnd_T' + (++n), status: 'processed' }));
    }); });
    await new Promise((res) => fake.listen(0, res));
    const SECRET = 'route_test_secret';
    const srv2 = spawn(process.execPath, ['server/server.js'], { cwd: TMP, stdio: 'ignore', env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development', SEED_DEMO_HISTORY: 'off',
      RAZORPAY_KEY_ID: 'rzp_test_FAKE', RAZORPAY_KEY_SECRET: SECRET, RAZORPAY_ROUTE: 'on', RAZORPAY_API_BASE: `http://127.0.0.1:${fake.address().port}` } });
    for (let i = 0; i < 40; i++) { try { if ((await fetch(B + '/config')).ok) break; } catch {} await sleep(250); }
    try {
      const adm2 = await login('admin@bookmyspa.demo', 'admin123', 'admin'), cu2 = await login('priya.new@example.com', 'newpass1234', 'customer');
      ok('config reports payouts on', (await j('GET', '/config')).d.routePayouts === true);
      ok('invalid linked-account ID rejected', (await j('PUT', '/admin/spas/2/commercials', { razorpay_account_id: 'acc_short' }, adm2)).status === 400);
      ok('admin links the spa’s Razorpay account', (await j('PUT', '/admin/spas/2/commercials', { razorpay_account_id: 'acc_ABCDEFGHIJKLMN' }, adm2)).status === 200);
      const dR = ist(15);
      r = await j('POST', '/bookings', { spaId: 2, serviceId: 5, date: dR, startTime: '11:00', paymentMode: 'online' }, cu2);
      const rbk = r.d.booking;
      const ord = await j('POST', `/bookings/${rbk.id}/checkout`, {}, cu2);
      const req = seen.find((x) => x.url === '/v1/orders');
      const tr = req && req.body.transfers && req.body.transfers[0];
      ok('order sent to Razorpay with a transfer to the spa', tr && tr.account === 'acc_ABCDEFGHIJKLMN' && tr.currency === 'INR', req && req.body);
      ok('spa share = price − commission (in paise)', tr && tr.amount === Math.round((rbk.amount - rbk.commission_amount) * 100) && req.body.amount === Math.round(rbk.amount * 100), { tr, rbk });
      const apptSec = (Date.parse(`${dR}T11:00:00Z`) - 330 * 60000) / 1000;
      ok('transfer held until the day after the appointment', tr && tr.on_hold === true && tr.on_hold_until === apptSec + 86400, tr);
      ok('booking ref passed to the spa’s Razorpay statement', tr && tr.notes.booking_ref === rbk.booking_ref && tr.linked_account_notes[0] === 'booking_ref' && req.body.notes.booking_ref === rbk.booking_ref);
      const sig = crypto.createHmac('sha256', SECRET).update(`${ord.d.orderId}|pay_ROUTE1`).digest('hex');
      ok('forged payment signature refused', (await j('POST', `/bookings/${rbk.id}/verify`, { mode: 'razorpay', orderId: ord.d.orderId, paymentId: 'pay_ROUTE1', signature: 'f'.repeat(64) }, cu2)).status === 402);
      r = await j('POST', `/bookings/${rbk.id}/verify`, { mode: 'razorpay', orderId: ord.d.orderId, paymentId: 'pay_ROUTE1', signature: sig }, cu2);
      ok('genuine signature confirms the booking', r.status === 200 && r.d.booking.status === 'confirmed' && r.d.booking.route_transfer === 1, r.d);
      dbx("UPDATE bookings SET status='completed' WHERE id = ?", rbk.id);
      const st = (await j('GET', '/admin/settlements', null, adm2)).d.spas.find((x) => x.spa_id === 2);
      ok('auto-paid booking is left out of the manual settlement ledger', st.payout_account === 'acc_ABCDEFGHIJKLMN' && !dbq('SELECT 1 FROM bookings WHERE id=? AND settlement_id IS NOT NULL', rbk.id).length && st.onlineGross === 0, st);
      dbx("UPDATE bookings SET status='confirmed' WHERE id = ?", rbk.id);
      r = await j('PUT', `/bookings/${rbk.id}/cancel`, {}, cu2);
      const rf = seen.find((x) => x.url === '/v1/payments/pay_ROUTE1/refund');
      ok('cancelling refunds the customer and reverses the spa transfer', r.status === 200 && rf && rf.body.reverse_all === 1 && rf.body.amount === Math.round(rbk.amount * 100), { msg: r.d, rf });
      ok('spas without a linked account get no transfer', await (async () => {
        const b2 = (await j('POST', '/bookings', { spaId: 1, serviceId: 2, date: dR, startTime: '10:30', paymentMode: 'online' }, cu2)).d.booking;
        await j('POST', `/bookings/${b2.id}/checkout`, {}, cu2);
        return !seen.filter((x) => x.url === '/v1/orders').pop().body.transfers;
      })());
    } finally { srv2.kill(); fake.close(); }
  } catch (e) {
    fail++; console.log('  CRASH in [' + section + ']:', e.stack);
  } finally {
    srv.kill();
    console.log(`\n${pass} passed, ${fail} failed`);
    if (fail) console.log('\nServer log tail:\n' + log.split('\n').slice(-15).join('\n'));
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
    process.exit(fail ? 1 : 0);
  }
})();
