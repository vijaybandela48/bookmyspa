// backup.js — built-in automatic backups. No Railway Pro plan, no npm packages.
//
//  • Before EVERY update/restart the database is snapshotted ("pre-update") before any
//    migration runs, so a bad release can always be rolled back.
//  • A consistent "daily" backup is taken every night (~3am IST), verified with SQLite's
//    integrity_check, and the newest copies are kept (see KEEP).
//  • OPTIONAL offsite copy: set BACKUP_S3_* variables and every backup is also uploaded to any
//    S3-compatible bucket (Cloudflare R2, Backblaze B2, AWS S3...). That is what protects you if the
//    Railway volume itself is ever lost.
//  • Restore: set RESTORE_BACKUP=<file name> (or RESTORE_OFFSITE_KEY=<object key>) and redeploy.
//
// Everything is stored next to the database in data/backups/ on the same volume.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'spa_platform.db');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const STATUS_FILE = path.join(BACKUP_DIR, 'status.json');
const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 330);

const KEEP = { daily: 30, manual: 20, 'pre-update': 10, 'before-restore': 5 };
const NAME_RE = /^bookmyspa-\d{4}-\d{2}-\d{2}-\d{6}-(daily|manual|pre-update|before-restore)\.db$/;

const ensureDir = () => fs.mkdirSync(BACKUP_DIR, { recursive: true });
const sqlQuote = (p) => p.replace(/'/g, "''");

function localStamp(ms = Date.now()) {
  const d = new Date(ms + TZ_OFFSET_MINUTES * 60000);
  const iso = d.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 19).replace(/:/g, ''), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

function readStatus() { try { return JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8')); } catch { return {}; } }
function writeStatus(patch) {
  try { ensureDir(); fs.writeFileSync(STATUS_FILE, JSON.stringify({ ...readStatus(), ...patch }, null, 1)); } catch { /* non-fatal */ }
}

// Opens a database file and checks that it is healthy and actually contains BookMySpa data.
function verifyDbFile(file) {
  let conn;
  try {
    conn = new DatabaseSync(file);
    const ic = conn.prepare('PRAGMA integrity_check').get();
    const ok = ic && Object.values(ic)[0] === 'ok';
    const hasUsers = conn.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='users'").get().c > 0;
    const users = hasUsers ? conn.prepare('SELECT COUNT(*) c FROM users').get().c : 0;
    return { ok: !!ok, users, error: ok ? null : 'integrity check failed' };
  } catch (e) {
    return { ok: false, users: 0, error: e.message };
  } finally { try { conn && conn.close(); } catch { /* ignore */ } }
}

function listBackups() {
  ensureDir();
  return fs.readdirSync(BACKUP_DIR).filter((n) => NAME_RE.test(n)).sort().reverse().map((name) => {
    const st = fs.statSync(path.join(BACKUP_DIR, name));
    return { name, kind: name.match(NAME_RE)[1], size: st.size, created: st.mtime.toISOString() };
  });
}

function rotate(kind) {
  const files = listBackups().filter((b) => b.kind === kind);
  for (const old of files.slice(KEEP[kind])) { try { fs.unlinkSync(path.join(BACKUP_DIR, old.name)); } catch { /* ignore */ } }
}

// Consistent copy of a LIVE database (VACUUM INTO is safe while the app is running).
function snapshot(db, kind) {
  ensureDir();
  const { date, time } = localStamp();
  const name = `bookmyspa-${date}-${time}-${kind}.db`;
  const final = path.join(BACKUP_DIR, name);
  if (fs.existsSync(final)) return { name, path: final, size: fs.statSync(final).size, kind };
  const tmp = final + '.tmp';
  try { fs.unlinkSync(tmp); } catch { /* none */ }
  db.exec(`VACUUM INTO '${sqlQuote(tmp)}'`);
  const v = verifyDbFile(tmp);
  if (!v.ok) { try { fs.unlinkSync(tmp); } catch {} throw new Error('Backup failed its integrity check: ' + v.error); }
  fs.renameSync(tmp, final);
  rotate(kind);
  return { name, path: final, size: fs.statSync(final).size, kind };
}

// Called by db.js right after the database opens, BEFORE any migration touches it.
function snapshotBeforeStart(db) {
  try {
    const hasUsers = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='users'").get().c > 0;
    if (!hasUsers || !db.prepare('SELECT COUNT(*) c FROM users').get().c) return; // brand-new/empty database: nothing to protect
    const recent = listBackups().find((b) => b.kind === 'pre-update');
    if (recent && Date.now() - Date.parse(recent.created) < 10 * 60000) return; // avoid churn on crash-restarts
    const s = snapshot(db, 'pre-update');
    writeStatus({ lastLocal: { name: s.name, at: new Date().toISOString(), size: s.size, kind: 'pre-update' } });
    console.log(`Pre-update database snapshot saved: ${s.name}`);
  } catch (e) { console.error('Pre-update snapshot skipped:', e.message); }
}

// ---------------- Offsite (S3-compatible) ----------------
function offsiteConfig() {
  const e = process.env;
  if (!(e.BACKUP_S3_ENDPOINT && e.BACKUP_S3_BUCKET && e.BACKUP_S3_ACCESS_KEY && e.BACKUP_S3_SECRET_KEY)) return null;
  let prefix = e.BACKUP_S3_PREFIX === undefined ? 'bookmyspa-backups/' : e.BACKUP_S3_PREFIX;
  prefix = prefix.replace(/^\/+/, '');
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  return { endpoint: e.BACKUP_S3_ENDPOINT.replace(/\/+$/, ''), bucket: e.BACKUP_S3_BUCKET, accessKey: e.BACKUP_S3_ACCESS_KEY, secretKey: e.BACKUP_S3_SECRET_KEY, region: e.BACKUP_S3_REGION || 'auto', prefix };
}
function offsiteSummary() {
  const c = offsiteConfig();
  if (!c) return { configured: false };
  let host = c.endpoint; try { host = new URL(c.endpoint).host; } catch { /* keep raw */ }
  return { configured: true, host, bucket: c.bucket, prefix: c.prefix };
}

const sha256hex = (b) => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
const strictEncode = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// AWS Signature Version 4 (verified against AWS's published test vectors in the test-suite).
function signRequest({ method, url, headers = {}, payloadHash, region, service = 's3', accessKey, secretKey, amzDate }) {
  const u = new URL(url);
  const date = amzDate.slice(0, 8);
  const hdrs = {};
  for (const [k, v] of Object.entries(headers)) hdrs[k.toLowerCase()] = v;
  hdrs.host = u.host; hdrs['x-amz-content-sha256'] = payloadHash; hdrs['x-amz-date'] = amzDate;
  const names = Object.keys(hdrs).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(hdrs[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = u.pathname.split('/').map((seg) => strictEncode(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams].map(([k, v]) => [strictEncode(k), strictEncode(v)]).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${date}/${region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac('AWS4' + secretKey, date), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const out = {};
  for (const n of names) if (n !== 'host') out[n] = hdrs[n]; // fetch sets Host itself
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return { headers: out, signature, canonicalRequest };
}

const objectUrl = (c, key) => `${c.endpoint}/${c.bucket}/${key.split('/').map(strictEncode).join('/')}`;
const nowAmz = () => new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
const EMPTY_SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function uploadOffsite(file, name) {
  const c = offsiteConfig(); if (!c) return null;
  const body = fs.readFileSync(file);
  const url = objectUrl(c, c.prefix + name);
  const { headers } = signRequest({ method: 'PUT', url, headers: { 'content-type': 'application/octet-stream' }, payloadHash: sha256hex(body), region: c.region, accessKey: c.accessKey, secretKey: c.secretKey, amzDate: nowAmz() });
  const res = await fetch(url, { method: 'PUT', headers, body, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Offsite upload failed: HTTP ${res.status} ${(await res.text().catch(() => '')).slice(0, 160)}`);
  return c.prefix + name;
}

async function downloadOffsite(key) {
  const c = offsiteConfig(); if (!c) throw new Error('Offsite storage is not configured (BACKUP_S3_* variables).');
  const url = objectUrl(c, key);
  const { headers } = signRequest({ method: 'GET', url, payloadHash: EMPTY_SHA, region: c.region, accessKey: c.accessKey, secretKey: c.secretKey, amzDate: nowAmz() });
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Offsite download failed: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Uploads any of the newest local backups that haven't reached the offsite bucket yet.
async function syncOffsite() {
  if (!offsiteConfig()) return;
  const st = readStatus();
  const uploaded = new Set(st.uploaded || []);
  let lastError = null, lastOffsite = st.lastOffsite || null;
  for (const b of listBackups().slice(0, 5).reverse()) {
    if (uploaded.has(b.name)) continue;
    try { await uploadOffsite(path.join(BACKUP_DIR, b.name), b.name); uploaded.add(b.name); lastOffsite = { name: b.name, at: new Date().toISOString() }; }
    catch (e) { lastError = { at: new Date().toISOString(), message: e.message }; console.error('Offsite backup failed:', e.message); break; }
  }
  writeStatus({ uploaded: [...uploaded].slice(-60), lastOffsite, lastOffsiteError: lastError });
  return { lastOffsite, lastError };
}

async function runBackup(db, kind) {
  const s = snapshot(db, kind);
  writeStatus({ lastLocal: { name: s.name, at: new Date().toISOString(), size: s.size, kind }, lastError: null });
  const off = await syncOffsite();
  return { ...s, offsite: off || null };
}

// ---------------- Schedule ----------------
function startScheduler(db) {
  const tick = async () => {
    try {
      const { date, minutes } = localStamp();
      const daily = listBackups().filter((b) => b.kind === 'daily');
      const hasToday = daily.some((b) => b.name.includes(`-${date}-`));
      const overdue = !daily.length || Date.now() - Date.parse(daily[0].created) > 26 * 3600 * 1000;
      if ((!hasToday && minutes >= 180) || overdue) { await runBackup(db, 'daily'); console.log('Daily backup completed.'); }
      else await syncOffsite();
    } catch (e) {
      console.error('Backup scheduler error:', e.message);
      writeStatus({ lastError: { at: new Date().toISOString(), message: e.message } });
    }
  };
  setTimeout(tick, 20000).unref();
  setInterval(tick, 60 * 60000).unref();
}

// ---------------- Restore (runs once at startup, before the database is opened) ----------------
async function restoreIfRequested() {
  const local = (process.env.RESTORE_BACKUP || '').trim();
  const remote = (process.env.RESTORE_OFFSITE_KEY || '').trim();
  const value = local || remote;
  if (!value) return;
  ensureDir();
  const marker = path.join(BACKUP_DIR, '.restore-applied');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === value) {
    console.warn('RESTORE variable is still set but was already applied — ignoring it. Remove it from Railway.');
    return;
  }
  let src, downloaded = false;
  if (local) {
    if (!NAME_RE.test(local)) throw new Error('RESTORE_BACKUP must be a file name from data/backups (see Admin → Backups).');
    src = path.join(BACKUP_DIR, local);
    if (!fs.existsSync(src)) throw new Error(`Backup file not found: ${local}`);
  } else {
    src = path.join(BACKUP_DIR, `restore-download-${Date.now()}.tmp`);
    fs.writeFileSync(src, await downloadOffsite(remote));
    downloaded = true;
  }
  const v = verifyDbFile(src);
  if (!v.ok || !v.users) { if (downloaded) fs.unlinkSync(src); throw new Error('That backup is not a valid, populated BookMySpa database — nothing was changed.'); }
  if (fs.existsSync(DB_PATH)) {
    const { date, time } = localStamp();
    fs.copyFileSync(DB_PATH, path.join(BACKUP_DIR, `bookmyspa-${date}-${time}-before-restore.db`)); // your undo button
  }
  const tmp = DB_PATH + '.restoring';
  fs.copyFileSync(src, tmp); fs.renameSync(tmp, DB_PATH);
  for (const ext of ['-wal', '-shm', '-journal']) { try { fs.unlinkSync(DB_PATH + ext); } catch { /* none */ } }
  if (downloaded) fs.unlinkSync(src);
  fs.writeFileSync(marker, value);
  writeStatus({ restoreError: null, lastRestore: { from: value, at: new Date().toISOString(), users: v.users } });
  console.warn(`\n*** DATABASE RESTORED from ${value} (${v.users} users). The previous database was saved as a "before-restore" backup. REMOVE the RESTORE_* variable from Railway now. ***\n`);
}

module.exports = {
  BACKUP_DIR, NAME_RE, KEEP, listBackups, snapshot, snapshotBeforeStart, runBackup, syncOffsite, startScheduler,
  restoreIfRequested, readStatus, writeStatus, offsiteConfig, offsiteSummary, signRequest, uploadOffsite, downloadOffsite, verifyDbFile, localStamp,
};
