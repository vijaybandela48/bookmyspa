// Advance deposits ("Reserve with ₹199, pay the rest at the spa") and the optional booking fee.
//
// How the money works:
//  - A deposit booking is a pay-at-spa booking with part of the price paid online up front.
//    BookMySpa holds the deposit; the spa collects the balance at the counter.
//  - The deposit is never less than the platform's commission on the booking, so commission
//    is always collected even when the customer pays the rest in cash.
//  - At settlement the deposit counts as money BookMySpa holds for the spa (like an online payment),
//    and commission is charged on the full price as usual.
//  - No-show: the deposit is kept as a no-show charge. The spa gets it minus commission on that amount.
//  - Cancelled inside the free-cancellation window (or by the spa): everything paid online is refunded.
//  - Booking fee (optional, ₹0 by default): a flat platform fee added to every booking paid online
//    (in full or with a deposit). It's BookMySpa's own revenue and never part of the spa's settlement.
const { db } = require('./db');

const DEFAULTS = { deposit_policy: 'optional', deposit_type: 'fixed', deposit_value: '199', booking_fee: '0' };
const POLICIES = ['off', 'optional', 'required'];
const round2 = (x) => Math.round(x * 100) / 100;

function getSettings() {
  const out = { ...DEFAULTS };
  for (const r of db.prepare("SELECT key, value FROM settings WHERE key IN ('deposit_policy','deposit_type','deposit_value','booking_fee')").all()) out[r.key] = r.value;
  return { deposit_policy: POLICIES.includes(out.deposit_policy) ? out.deposit_policy : 'optional', deposit_type: out.deposit_type === 'percent' ? 'percent' : 'fixed',
           deposit_value: Number(out.deposit_value) || 0, booking_fee: Number(out.booking_fee) || 0 };
}

function saveSettings(body) {
  const cur = getSettings(), next = { ...cur };
  if (body.deposit_policy !== undefined) {
    if (!POLICIES.includes(body.deposit_policy)) return { error: 'Choose Off, Optional or Required.' };
    next.deposit_policy = body.deposit_policy;
  }
  if (body.deposit_type !== undefined) next.deposit_type = body.deposit_type === 'percent' ? 'percent' : 'fixed';
  if (body.deposit_value !== undefined) next.deposit_value = Number(body.deposit_value);
  if (body.booking_fee !== undefined) next.booking_fee = Number(body.booking_fee);
  if (next.deposit_type === 'percent' && !(next.deposit_value >= 1 && next.deposit_value <= 90)) return { error: 'A percentage deposit must be between 1% and 90%.' };
  if (next.deposit_type === 'fixed' && !(next.deposit_value >= 1 && next.deposit_value <= 10000)) return { error: 'A fixed deposit must be between ₹1 and ₹10,000.' };
  if (!(next.booking_fee >= 0 && next.booking_fee <= 500)) return { error: 'The booking fee must be between ₹0 and ₹500.' };
  next.deposit_value = Math.round(next.deposit_value); next.booking_fee = Math.round(next.booking_fee);
  const set = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const k of Object.keys(DEFAULTS)) set.run(k, String(next[k]));
  return { settings: getSettings() };
}

// Which ways to pay a spa offers. An admin can set any mix per spa (spas.payment_options,
// e.g. "online,deposit"); a spa without its own choice follows the platform default policy.
const OPTION_KEYS = ['online', 'deposit', 'venue'];
function parseOptions(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(',');
  return [...new Set(list.map((x) => String(x).trim()).filter((x) => OPTION_KEYS.includes(x)))];
}
function effectiveOptions(spa, s = getSettings()) {
  if (spa.payment_options) { const list = parseOptions(spa.payment_options); if (list.length) return { list, custom: true }; }
  const policy = policyFor(spa, s), venueAllowed = spa.allow_pay_at_venue !== 0;
  const list = ['online'];
  if (venueAllowed && policy !== 'off') list.push('deposit');
  if (venueAllowed && policy !== 'required') list.push('venue');
  return { list, custom: false };
}
function feeFor(spa, s = getSettings()) { return spa.booking_fee !== null && spa.booking_fee !== undefined ? spa.booking_fee : s.booking_fee; }

function policyFor(spa, s = getSettings()) { return POLICIES.includes(spa.deposit_policy) ? spa.deposit_policy : s.deposit_policy; }

// The advance for a booking: the spa's own amount (if admin set one) or the platform default,
// raised if needed so it always covers the commission, in whole rupees.
function depositFor(spa, due, commission, giftAmount, s = getSettings()) {
  const base = spa.deposit_amount > 0 ? spa.deposit_amount : s.deposit_type === 'percent' ? (due * s.deposit_value) / 100 : s.deposit_value;
  return Math.max(1, Math.ceil(base), Math.ceil(commission - (giftAmount || 0)));
}

// Every way the customer can pay for this booking. One source of truth for the checkout screen
// and for the booking endpoint, so what the customer sees is exactly what they're charged.
function paymentOptions({ spa, amount, giftAmount = 0, commission = 0, prepaid = false, onlineOk = true }) {
  const s = getSettings();
  if (prepaid) return { fee: 0, options: [{ mode: 'prepaid', payNow: 0, payAtSpa: 0 }] };
  const due = round2(amount - giftAmount), fee = feeFor(spa, s), policy = policyFor(spa, s);
  const { list, custom } = effectiveOptions(spa, s);
  const options = [];
  if (onlineOk && list.includes('online')) options.push({ mode: 'online', payNow: round2(due + fee), payAtSpa: 0, fee });
  let deposit = null;
  if (onlineOk && list.includes('deposit')) {
    const d = depositFor(spa, due, commission, giftAmount, s);
    if (d < due) { deposit = d; options.push({ mode: 'deposit', deposit: d, payNow: round2(d + fee), payAtSpa: round2(due - d), fee }); }
    // A service cheaper than the advance is simply paid in full online, even if the spa doesn't offer that separately.
    else if (!list.includes('online')) options.push({ mode: 'online', payNow: round2(due + fee), payAtSpa: 0, fee });
  }
  // The platform default never blocks bookings while online payments are off; an admin's explicit
  // per-spa choice is respected as set.
  if (list.includes('venue') || (!onlineOk && !custom && spa.allow_pay_at_venue !== 0)) options.push({ mode: 'pay_at_venue', payNow: 0, payAtSpa: due, fee: 0 });
  return { fee, policy, deposit, options, custom };
}

// What the customer pays online for a booking (full price or the advance, plus any booking fee).
function onlineCharge(b) {
  const core = b.deposit_amount > 0 ? b.deposit_amount : b.amount - (b.giftcard_amount || 0);
  return round2(core + (b.booking_fee || 0));
}
// What's left to collect at the counter.
function balanceDue(b) {
  return round2(b.amount - (b.giftcard_amount || 0) - (b.deposit_status === 'paid' ? b.deposit_amount : 0));
}

module.exports = { getSettings, saveSettings, policyFor, depositFor, paymentOptions, onlineCharge, balanceDue, POLICIES, OPTION_KEYS, parseOptions, effectiveOptions, feeFor };
