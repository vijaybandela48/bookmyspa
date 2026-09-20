// rateLimit.js — simple in-memory sliding-window rate limiter, zero dependencies.
//
// This is scoped to a single Node process, which matches this app's design
// (one process, local SQLite file). If you ever scale to multiple server
// instances behind a load balancer, replace this with a shared store (e.g.
// Redis) — an in-memory limiter per instance would let attackers just spread
// requests across instances to bypass it.

const buckets = new Map(); // key -> { count, windowStart }

function getClientKey(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.socket.remoteAddress;
  return ip || 'unknown';
}

// Returns true if the request is allowed, false if it should be rejected (429).
function checkRateLimit(req, { keyPrefix, maxRequests, windowMs }) {
  const key = keyPrefix + ':' + getClientKey(req);
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || now - bucket.windowStart > windowMs) {
    buckets.set(key, { count: 1, windowStart: now });
    return true;
  }

  bucket.count += 1;
  return bucket.count <= maxRequests;
}

// Periodic cleanup so the map doesn't grow unbounded over a long-running process.
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart > 60 * 60 * 1000) buckets.delete(key);
  }
}, 10 * 60 * 1000).unref();

module.exports = { checkRateLimit };
