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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();

(async () => {
  const srv = spawn(process.execPath, ['server/server.js'], { cwd: TMP, env: { ...process.env, PORT: String(PORT), NODE_ENV: 'development' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
    r = await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '15:00' }, cust);
    ok('customer reschedules', r.status === 200 && r.d.booking.start_time === '15:00' && r.d.booking.rescheduled_count === 1, r);
    ok('booking ID unchanged after reschedule', r.d.booking.booking_ref === rb.booking_ref);
    ok('new confirmation sent', dbq('SELECT COUNT(*) c FROM notifications WHERE booking_id=?', rb.id)[0].c >= 4);
    ok('reschedule to taken/invalid time refused', (await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '03:00' }, cust)).status === 409);
    await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '16:00' }, cust);
    ok('max two reschedules', (await j('PUT', `/bookings/${rb.id}/reschedule`, { date: ist(3), startTime: '17:00' }, cust)).status === 409);
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

    group('Backups');
    r = await j('POST', '/admin/backups', {}, adm);
    ok('manual backup works', r.status === 201 && /manual\.db$/.test(r.d.name), r);
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
