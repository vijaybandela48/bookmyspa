// datadir.js — the one place that decides where BookMySpa keeps its data
// (database, uploaded photos, backups).
//
// 1. DATA_DIR env var, if you set one explicitly.
// 2. RAILWAY_VOLUME_MOUNT_PATH — Railway sets this automatically when a volume is attached,
//    so the app always uses the volume even if the code folder moves.
// 3. Otherwise ./data next to the code (local development).
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'spa_platform.db');
const isProduction = process.env.NODE_ENV === 'production';
const onRailway = !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_SERVICE_ID);

// Safety guard: in production, refuse to silently start on a brand-new empty database.
// An empty database in production almost always means the storage volume is missing or mounted
// somewhere else — starting anyway would show customers an empty site and lose new sign-ups on the
// next deploy. Set ALLOW_NEW_DATABASE=yes once, for a genuine first launch or after a deliberate reset.
function checkDatabaseLocation() {
  const exists = fs.existsSync(DB_PATH);
  console.log(`Data folder: ${DATA_DIR}${process.env.RAILWAY_VOLUME_MOUNT_PATH ? ' (Railway volume)' : onRailway ? ' (NO Railway volume detected)' : ''}`);
  if (exists || !isProduction || process.env.ALLOW_NEW_DATABASE === 'yes') return;
  console.error(`
*** STOPPED: no database found at ${DB_PATH}. ***
In production this usually means the storage volume is not attached, or is mounted at a different path.
${onRailway && !process.env.RAILWAY_VOLUME_MOUNT_PATH ? 'Railway reports NO volume attached to this service. Attach your existing volume (Service → Settings → Volumes).\n' : ''}Your data has NOT been touched. Fix the volume and redeploy.
If this really is a brand-new site, set ALLOW_NEW_DATABASE=yes for the first deploy, then remove it.
`);
  process.exit(1);
}

module.exports = { DATA_DIR, DB_PATH, checkDatabaseLocation };
