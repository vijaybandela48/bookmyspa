// gateway.js — Payment gateway abstraction, real Razorpay integration included.
//
// MOCK MODE (default, no setup): the full booking -> checkout -> confirm flow
// works with zero API keys — nothing real is charged.
//
// LIVE MODE: set these two environment variables and this file automatically
// switches to real Razorpay orders, hosted checkout, and signature
// verification — no npm install needed, everything uses Node's built-in fetch.
//
//   RAZORPAY_KEY_ID=rzp_live_xxxxxxxx      (or rzp_test_xxxxxxxx while testing)
//   RAZORPAY_KEY_SECRET=xxxxxxxxxxxxxxxxxx
//
// Card/UPI details are entered inside Razorpay's own hosted checkout popup —
// they never touch this server, which is what keeps you out of PCI-DSS scope.
// This server only ever sees a payment_id + a signature to verify.
//
// Swapping to Stripe instead: replace createOrder/verifyPayment/refund below
// with calls to Stripe's PaymentIntents API — the rest of the app (routes,
// DB, frontend) only depends on this file's exported shape, not on Razorpay
// specifically.

const crypto = require('node:crypto');

const isLive = !!(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);

function authHeader() {
  const token = Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64');
  return `Basic ${token}`;
}

async function createOrder({ amount, bookingId }) {
  if (!isLive) {
    await new Promise((r) => setTimeout(r, 200));
    return {
      mode: 'mock',
      orderId: 'mock_order_' + crypto.randomBytes(8).toString('hex'),
      keyId: null,
      amountPaise: Math.round(amount * 100),
      currency: 'INR',
    };
  }

  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      amount: Math.round(amount * 100),
      currency: 'INR',
      receipt: `booking_${bookingId}`,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Razorpay order creation failed: ${res.status} ${errText}`);
  }
  const order = await res.json();
  return {
    mode: 'razorpay',
    orderId: order.id,
    keyId: process.env.RAZORPAY_KEY_ID,
    amountPaise: order.amount,
    currency: order.currency,
  };
}

function verifyPayment({ mode, orderId, paymentId, signature }) {
  if (mode !== 'razorpay') {
    if (process.env.NODE_ENV === 'production') {
      return { success: false, transactionRef: '', message: 'Payment could not be verified.' };
    }
    const success = Math.random() > 0.03;
    return {
      success,
      transactionRef: paymentId || ('MOCK_TXN_' + crypto.randomBytes(8).toString('hex').toUpperCase()),
      message: success ? 'Payment approved' : 'Payment declined by bank (simulated)',
    };
  }

  if (!orderId || !paymentId || !signature) {
    return { success: false, transactionRef: paymentId || '', message: 'Missing payment verification fields.' };
  }

  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');

  const success = expected.length === signature.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  return {
    success,
    transactionRef: paymentId,
    message: success ? 'Payment verified' : 'Payment signature verification failed — this payment was not accepted.',
  };
}

async function refund({ transactionRef, amount }) {
  if (!isLive) {
    await new Promise((r) => setTimeout(r, 150));
    return { success: true, refundId: 'mock_refund_' + crypto.randomBytes(6).toString('hex') };
  }
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${transactionRef}/refund`, {
      method: 'POST',
      headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: Math.round(amount * 100) }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { success: false, error: `Razorpay refund failed: ${res.status} ${errText}` };
    }
    const refundData = await res.json();
    return { success: true, refundId: refundData.id };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

module.exports = { createOrder, verifyPayment, refund, isLive };
