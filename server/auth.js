// auth.js — stateless signed tokens (JWT-style) using only Node's built-in crypto.
const crypto = require('node:crypto');

const DEV_DEFAULT_SECRET = 'dev-secret-change-me-in-production';
const SECRET = process.env.TOKEN_SECRET || DEV_DEFAULT_SECRET;
const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Refuse to boot on the dev default secret in production — this secret signs
// every login session, so running real customer traffic on the well-known
// default would let anyone forge a valid session for any account, including admin.
if (process.env.NODE_ENV === 'production' && SECRET === DEV_DEFAULT_SECRET) {
  console.error(
    '\nFATAL: NODE_ENV=production but TOKEN_SECRET is not set (or is the default).\n' +
    'Set a long random TOKEN_SECRET environment variable before running in production.\n' +
    'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"\n'
  );
  process.exit(1);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function sign(payloadObj) {
  const payload = { ...payloadObj, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null; // expired
  return payload;
}

// Extracts + verifies the bearer token from a request, returns user payload or null
function getUserFromRequest(req) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  return verify(token);
}

// requireRole(['owner','admin']) -> returns user if authorized, or sends 401/403 and returns null
function requireAuth(req, res, roles = null) {
  const user = getUserFromRequest(req);
  if (!user) {
    sendJSON(res, 401, { error: 'Not authenticated. Please log in.' });
    return null;
  }
  if (roles && !roles.includes(user.role)) {
    sendJSON(res, 403, { error: 'You do not have permission to do that.' });
    return null;
  }
  return user;
}

function sendJSON(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

module.exports = { sign, verify, getUserFromRequest, requireAuth, sendJSON };
