// notifier.js — sends booking confirmations via Email, SMS, or WhatsApp.
//
// This ships in MOCK mode by default: no API keys required, nothing actually
// goes out, but the full flow (compose message -> "send" -> log -> record in DB)
// works end to end so you can see exactly what a customer would receive.
//
// To go live, set the relevant environment variables below. No npm install is
// needed for any of these — they're all called via Node's built-in fetch()
// against the provider's plain HTTP API.
//
// ---- Email via Resend (https://resend.com) ----
//   RESEND_API_KEY=re_xxx
//   RESEND_FROM="BookMySpa <bookings@yourdomain.com>"
//
// ---- SMS / WhatsApp via Twilio (https://twilio.com) ----
//   TWILIO_ACCOUNT_SID=ACxxx
//   TWILIO_AUTH_TOKEN=xxx
//   TWILIO_SMS_FROM=+1xxxxxxxxxx          (a Twilio phone number, for SMS)
//   TWILIO_WHATSAPP_FROM=+14155238886      (a WhatsApp-enabled Twilio number)
//
// If a channel's credentials aren't set, that channel automatically falls
// back to mock mode — so you can go live with just email first, for example,
// and add SMS/WhatsApp later without touching any code.

const { db } = require('../db');

function composeMessage({ customerName, spaName, serviceName, date, startTime, amount, spaAddress, payAtVenue, bookingRef }) {
  return `Hi ${customerName}, your booking is confirmed!\n` +
    (bookingRef ? `Booking ID: ${bookingRef}\n\n` : `\n`) +
    `${serviceName} at ${spaName}\n` +
    `${date} at ${startTime}\n` +
    (payAtVenue ? `Amount due at the spa: Rs. ${amount}\n` : `Amount paid: Rs. ${amount}\n`) +
    (spaAddress ? `Location: ${spaAddress}\n` : '') +
    `\nSee you there! — BookMySpa`;
}

async function sendEmail(to, subject, body) {
  if (!process.env.RESEND_API_KEY) {
    return { status: 'mocked', detail: `[MOCK EMAIL] To: ${to} | Subject: ${subject} | ${body.slice(0, 60)}...` };
  }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'BookMySpa <onboarding@resend.dev>',
        to: [to],
        subject,
        text: body,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { status: 'failed', detail: `Resend API error: ${res.status} ${errText}` };
    }
    return { status: 'sent', detail: 'Sent via Resend' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

async function sendTwilioMessage(to, body, { from, channelPrefix = '' }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token || !from) {
    return { status: 'mocked', detail: `[MOCK ${channelPrefix ? 'WHATSAPP' : 'SMS'}] To: ${to} | ${body.slice(0, 60)}...` };
  }
  try {
    const params = new URLSearchParams({
      To: channelPrefix + to,
      From: channelPrefix + from,
      Body: body,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params,
    });
    if (!res.ok) {
      const errText = await res.text();
      return { status: 'failed', detail: `Twilio API error: ${res.status} ${errText}` };
    }
    return { status: 'sent', detail: 'Sent via Twilio' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

// Main entry point: sends a booking confirmation and records the attempt.
async function sendBookingConfirmation({ channel, booking, customer, spa, service }) {
  const message = composeMessage({
    customerName: customer.name,
    spaName: spa.name,
    serviceName: service.name,
    date: booking.booking_date,
    startTime: booking.start_time,
    amount: booking.amount,
    spaAddress: spa.address,
    payAtVenue: booking.payment_mode === 'pay_at_venue',
    bookingRef: booking.booking_ref,
  });

  let result;
  let recipient;

  if (channel === 'email') {
    recipient = customer.email;
    result = await sendEmail(recipient, `Booking confirmed — ${spa.name}`, message);
  } else if (channel === 'sms') {
    recipient = customer.phone;
    result = msg91SmsConfigured
      ? await msg91SendFlow(recipient, process.env.MSG91_BOOKING_TEMPLATE_ID, {
          name: customer.name.split(' ')[0], service: service.name, spa: spa.name,
          date: prettyDate(booking.booking_date), time: prettyTime(booking.start_time), amount: String(booking.amount),
          payment: booking.payment_mode === 'pay_at_venue' ? 'payable at the spa' : 'paid',
          ref: booking.booking_ref || '',
        })
      : await sendTwilioMessage(recipient, message, { from: process.env.TWILIO_SMS_FROM });
  } else if (channel === 'whatsapp') {
    recipient = customer.phone;
    result = msg91WhatsappConfigured
      ? await msg91SendWhatsapp(recipient, [
          customer.name.split(' ')[0], service.name, spa.name, prettyDate(booking.booking_date), prettyTime(booking.start_time),
          booking.payment_mode === 'pay_at_venue' ? `Rs. ${booking.amount} payable at the spa` : `Rs. ${booking.amount} paid`,
          spa.latitude != null ? `https://www.google.com/maps/dir/?api=1&destination=${spa.latitude},${spa.longitude}` : (spa.address || spa.city),
        ])
      : await sendTwilioMessage(recipient, message, { from: process.env.TWILIO_WHATSAPP_FROM, channelPrefix: 'whatsapp:' });
  } else {
    result = { status: 'failed', detail: 'Unknown channel' };
    recipient = '';
  }

  db.prepare(
    'INSERT INTO notifications (booking_id, channel, recipient, message, status, detail) VALUES (?,?,?,?,?,?)'
  ).run(booking.id, channel, recipient || '', message, result.status, result.detail);

  return result;
}

function prettyDate(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  return isNaN(d) ? iso : d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}
function prettyTime(t) {
  const [h, m] = String(t).split(':').map(Number);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`;
}

// ---- MSG91 WhatsApp ----
//   MSG91_WHATSAPP_NUMBER     your WhatsApp number integrated in MSG91, with country code (e.g. 9198xxxxxxxx)
//   MSG91_WHATSAPP_TEMPLATE   name of your Meta-approved booking template (7 body variables, in order:
//                             name, service, spa, date, time, payment, directions link)
//   MSG91_WHATSAPP_LANG       template language code (default "en")
//   MSG91_WHATSAPP_NAMESPACE  template namespace, if MSG91 shows one for your template (optional)
const msg91WhatsappConfigured = !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_WHATSAPP_NUMBER && process.env.MSG91_WHATSAPP_TEMPLATE);
async function msg91SendWhatsapp(phone, values) {
  const components = {};
  values.forEach((v, i) => { components[`body_${i + 1}`] = { type: 'text', value: String(v) }; });
  try {
    const res = await fetch('https://api.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/', {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        integrated_number: process.env.MSG91_WHATSAPP_NUMBER,
        content_type: 'template',
        payload: {
          messaging_product: 'whatsapp', type: 'template',
          template: {
            name: process.env.MSG91_WHATSAPP_TEMPLATE,
            language: { code: process.env.MSG91_WHATSAPP_LANG || 'en', policy: 'deterministic' },
            namespace: process.env.MSG91_WHATSAPP_NAMESPACE || null,
            to_and_components: [{ to: [toMsg91Mobile(phone)], components }],
          },
        },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'fail' || data.type === 'error' || data.hasError) return { status: 'failed', detail: 'MSG91 WhatsApp error: ' + (data.message || data.errors || res.status) };
    return { status: 'sent', detail: 'Sent via MSG91 WhatsApp' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

// Sends the booking confirmation on EVERY channel: SMS + WhatsApp always, email too if configured.
async function sendBookingConfirmations(ctx) {
  const channels = ['sms', 'whatsapp'];
  if (process.env.RESEND_API_KEY && ctx.customer.email) channels.push('email');
  const results = {};
  for (const ch of channels) {
    try { results[ch] = await sendBookingConfirmation({ channel: ch, ...ctx }); }
    catch (e) { results[ch] = { status: 'failed', detail: e.message }; }
  }
  const st = Object.values(results).map((r) => r.status);
  const overall = st.includes('sent') ? 'sent' : st.includes('mocked') ? 'mocked' : 'failed';
  db.prepare('UPDATE bookings SET notify_channel = ?, notify_status = ? WHERE id = ?').run(channels.join(','), overall, ctx.booking.id);
  return { status: overall, channels: results };
}

// ---- MSG91 (recommended for India) ----
//   MSG91_AUTH_KEY              your MSG91 auth key
//   MSG91_OTP_TEMPLATE_ID       DLT-approved OTP template (uses MSG91's ##OTP## variable)
//   MSG91_BOOKING_TEMPLATE_ID   DLT-approved Flow template for booking confirmations, with
//                               variables ##name## ##service## ##spa## ##date## ##time## ##amount##
// We generate, rate-limit and verify OTPs ourselves and pass our code to MSG91
// (their `otp` parameter), so behaviour is identical whichever provider is used.
const msg91OtpConfigured = !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_OTP_TEMPLATE_ID);
const msg91SmsConfigured = !!(process.env.MSG91_AUTH_KEY && process.env.MSG91_BOOKING_TEMPLATE_ID);

// MSG91 wants the country code with no "+": 9876543210 -> 919876543210
function toMsg91Mobile(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10) return '91' + d;
  if (d.length === 11 && d.startsWith('0')) return '91' + d.slice(1);
  return d;
}

async function msg91SendOtp(phone, code) {
  try {
    const params = new URLSearchParams({ template_id: process.env.MSG91_OTP_TEMPLATE_ID, mobile: toMsg91Mobile(phone), otp: code, otp_expiry: '5' });
    const res = await fetch('https://control.msg91.com/api/v5/otp?' + params, {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') return { status: 'failed', detail: 'MSG91 OTP error: ' + (data.message || res.status) };
    return { status: 'sent', detail: 'Sent via MSG91' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

async function msg91SendFlow(phone, templateId, vars) {
  try {
    const res = await fetch('https://control.msg91.com/api/v5/flow/', {
      method: 'POST',
      headers: { authkey: process.env.MSG91_AUTH_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: templateId, short_url: '0', recipients: [{ mobiles: toMsg91Mobile(phone), ...vars }] }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.type === 'error') return { status: 'failed', detail: 'MSG91 SMS error: ' + (data.message || res.status) };
    return { status: 'sent', detail: 'Sent via MSG91' };
  } catch (e) {
    return { status: 'failed', detail: e.message };
  }
}

const isSmsConfigured = msg91OtpConfigured || !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM);

// Sends a one-time verification code via SMS, for registration/login.
// In mock mode (no Twilio credentials), the code is only ever logged to the
// server console — the API layer decides separately whether it's safe to
// also hand the code back in the response (only when not live, so testing
// works without real SMS, and never in a way that could leak a real code).
async function sendOtpSms(phone, code) {
  const body = `${code} is your BookMySpa verification code. It expires in 5 minutes. Don't share this code with anyone.`;
  const result = msg91OtpConfigured
    ? await msg91SendOtp(phone, code)
    : await sendTwilioMessage(phone, body, { from: process.env.TWILIO_SMS_FROM });
  if (result.status === 'mocked') {
    console.log(`[MOCK OTP] ${phone} -> ${code}`);
  }
  return result;
}

module.exports = { sendBookingConfirmation, sendBookingConfirmations, sendOtpSms, isSmsConfigured, toMsg91Mobile, msg91WhatsappConfigured };
