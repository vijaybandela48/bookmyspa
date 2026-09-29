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

function composeMessage({ customerName, spaName, serviceName, date, startTime, amount, spaAddress, payAtVenue }) {
  return `Hi ${customerName}, your booking is confirmed!\n\n` +
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
  });

  let result;
  let recipient;

  if (channel === 'email') {
    recipient = customer.email;
    result = await sendEmail(recipient, `Booking confirmed — ${spa.name}`, message);
  } else if (channel === 'sms') {
    recipient = customer.phone;
    result = await sendTwilioMessage(recipient, message, { from: process.env.TWILIO_SMS_FROM });
  } else if (channel === 'whatsapp') {
    recipient = customer.phone;
    result = await sendTwilioMessage(recipient, message, { from: process.env.TWILIO_WHATSAPP_FROM, channelPrefix: 'whatsapp:' });
  } else {
    result = { status: 'failed', detail: 'Unknown channel' };
    recipient = '';
  }

  db.prepare(
    'INSERT INTO notifications (booking_id, channel, recipient, message, status, detail) VALUES (?,?,?,?,?,?)'
  ).run(booking.id, channel, recipient || '', message, result.status, result.detail);

  db.prepare('UPDATE bookings SET notify_channel = ?, notify_status = ? WHERE id = ?')
    .run(channel, result.status, booking.id);

  return result;
}

const isSmsConfigured = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_SMS_FROM);

// Sends a one-time verification code via SMS, for registration/login.
// In mock mode (no Twilio credentials), the code is only ever logged to the
// server console — the API layer decides separately whether it's safe to
// also hand the code back in the response (only when not live, so testing
// works without real SMS, and never in a way that could leak a real code).
async function sendOtpSms(phone, code) {
  const body = `${code} is your BookMySpa verification code. It expires in 5 minutes. Don't share this code with anyone.`;
  const result = await sendTwilioMessage(phone, body, { from: process.env.TWILIO_SMS_FROM });
  if (result.status === 'mocked') {
    console.log(`[MOCK OTP] ${phone} -> ${code}`);
  }
  return result;
}

module.exports = { sendBookingConfirmation, sendOtpSms, isSmsConfigured };
