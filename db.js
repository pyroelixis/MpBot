// db.js — data access layer for MpBot (challenges + licenses)
const Database = require('better-sqlite3');
const db = new Database('mpbot.db');
db.pragma('journal_mode = WAL');

// ---------- TABLES ----------

// challenges (เดิม)
db.exec(`
CREATE TABLE IF NOT EXISTS challenges (
  key TEXT PRIMARY KEY,
  theta REAL NOT NULL,
  phi   REAL NOT NULL,
  tolerance REAL NOT NULL DEFAULT 10,
  n INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  theta REAL NOT NULL,
  phi REAL NOT NULL,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_obs_key_ts ON observations(key, ts DESC);
`);

// licenses (ใหม่)
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro',
  uid TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  expires_at INTEGER,
  max_devices INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS license_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  action TEXT NOT NULL,
  from_uid TEXT,
  to_uid TEXT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);
`);

// ---------- UTILS ----------
const toRad = d => d * Math.PI / 180;
const toDeg = r => r * 180 / Math.PI;
const clamp360 = x => { x %= 360; if (x < 0) x += 360; return x; };

function degMean(values) {
  let sx = 0, sy = 0;
  for (const v of values) { sx += Math.cos(toRad(v)); sy += Math.sin(toRad(v)); }
  let ang = toDeg(Math.atan2(sy, sx));
  if (ang < 0) ang += 360;
  return ang;
}

const DEFAULT_THETA = Number(process.env.TARGET_THETA ?? 0);
const DEFAULT_PHI   = Number(process.env.TARGET_PHI   ?? 90);
const DEFAULT_TOL   = Number(process.env.TOLERANCE    ?? 10);

// ---------- DAO: CHALLENGE ----------
function getTarget(key) {
  const row = db.prepare('SELECT theta, phi, tolerance FROM challenges WHERE key=?').get(key);
  return {
    thetaDeg: clamp360(row?.theta ?? DEFAULT_THETA),
    phiDeg:   row?.phi   ?? DEFAULT_PHI,
    tolerance: row?.tolerance ?? DEFAULT_TOL
  };
}

function saveObservation(key, thetaDeg, phiDeg) {
  db.prepare('INSERT INTO observations(key, theta, phi, ts) VALUES(?,?,?,?)')
    .run(key, clamp360(thetaDeg), phiDeg, Date.now());
}

function recomputeTarget(key, limit = 200) {
  const rows = db.prepare(
    'SELECT theta, phi FROM observations WHERE key=? ORDER BY ts DESC LIMIT ?'
  ).all(key, limit);
  if (!rows.length) return null;

  const meanTheta = degMean(rows.map(r => r.theta));
  const meanPhi = rows.map(r => r.phi).reduce((a,b)=>a+b,0) / rows.length;
  const tol = DEFAULT_TOL;

  db.prepare(`
    INSERT INTO challenges(key, theta, phi, tolerance, n, updated_at)
    VALUES(@key,@theta,@phi,@tol,@n,@ts)
    ON CONFLICT(key) DO UPDATE SET
      theta=excluded.theta, phi=excluded.phi,
      tolerance=excluded.tolerance,
      n=challenges.n+1, updated_at=excluded.updated_at
  `).run({ key, theta: meanTheta, phi: meanPhi, tol, n: rows.length, ts: Date.now() });

  return { thetaDeg: clamp360(meanTheta), phiDeg: meanPhi, tolerance: tol };
}

function listChallenges(limit = 500) {
  return db.prepare(
    'SELECT key, theta AS thetaDeg, phi AS phiDeg, tolerance, n, updated_at FROM challenges ORDER BY updated_at DESC LIMIT ?'
  ).all(limit);
}

function getChallenge(key) {
  return db.prepare(
    'SELECT key, theta AS thetaDeg, phi AS phiDeg, tolerance, n, updated_at FROM challenges WHERE key=?'
  ).get(key);
}

function listObservations(key, limit = 200) {
  return db.prepare(
    'SELECT id, theta AS thetaDeg, phi AS phiDeg, ts FROM observations WHERE key=? ORDER BY ts DESC LIMIT ?'
  ).all(key, limit);
}

function setTarget(key, thetaDeg, phiDeg, tolerance) {
  db.prepare(`
    INSERT INTO challenges(key, theta, phi, tolerance, n, updated_at)
    VALUES(?,?,?,?,0,?)
    ON CONFLICT(key) DO UPDATE SET
      theta=excluded.theta, phi=excluded.phi,
      tolerance=excluded.tolerance, updated_at=excluded.updated_at
  `).run(key, clamp360(thetaDeg), phiDeg, tolerance, Date.now());
  return { thetaDeg: clamp360(thetaDeg), phiDeg, tolerance };
}

function deleteKey(key) {
  const n1 = db.prepare('DELETE FROM observations WHERE key=?').run(key).changes;
  const n2 = db.prepare('DELETE FROM challenges WHERE key=?').run(key).changes;
  return { observations: n1, challenge: n2 };
}

function compactKey(key, keep = 200) {
  const ids = db.prepare(
    'SELECT id FROM observations WHERE key=? ORDER BY ts DESC LIMIT -1 OFFSET ?'
  ).all(key, keep);
  if (ids.length) {
    const list = ids.map(r => r.id).join(',');
    db.exec(`DELETE FROM observations WHERE id IN (${list})`);
  }
  return recomputeTarget(key);
}

// ---------- DAO: LICENSE ----------
function getLicenseByKey(key){ return db.prepare(`SELECT * FROM licenses WHERE key=?`).get(key); }
function getLicenseByUid(uid){ return db.prepare(`SELECT * FROM licenses WHERE uid=? AND active=1`).get(uid); }
function upsertLicense({key, plan='pro', expires_at=null, max_devices=1, active=1}){
  db.prepare(`
    INSERT INTO licenses (key, plan, expires_at, max_devices, active)
    VALUES (@key, @plan, @expires_at, @max_devices, @active)
    ON CONFLICT(key) DO UPDATE SET
      plan=excluded.plan,
      expires_at=excluded.expires_at,
      max_devices=excluded.max_devices,
      active=excluded.active
  `).run({ key, plan, expires_at, max_devices, active });
  return getLicenseByKey(key);
}
function setLicenseTargetUid(key, uid){
  db.prepare(`UPDATE licenses SET uid=? WHERE key=?`).run(uid, key);
  db.prepare(`INSERT INTO license_history (key, action, to_uid) VALUES (?, 'activate', ?)`).run(key, uid);
  return getLicenseByKey(key);
}
function transferLicense(key, fromUid, toUid){
  const row = getLicenseByKey(key);
  if (!row) return null;
  if (row.uid && row.uid !== fromUid) return 'bound-to-other';
  db.prepare(`UPDATE licenses SET uid=? WHERE key=?`).run(toUid, key);
  db.prepare(`INSERT INTO license_history (key, action, from_uid, to_uid) VALUES (?, 'transfer', ?, ?)`)
    .run(key, fromUid || null, toUid || null);
  return getLicenseByKey(key);
}
function deactivateLicense(key){
  db.prepare(`UPDATE licenses SET active=0 WHERE key=?`).run(key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'deactivate')`).run(key);
  return getLicenseByKey(key);
}
function activateLicense(key){
  db.prepare(`UPDATE licenses SET active=1 WHERE key=?`).run(key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'activate')`).run(key);
  return getLicenseByKey(key);
}
function renewLicense(key, expires_at){
  db.prepare(`UPDATE licenses SET expires_at=? WHERE key=?`).run(expires_at, key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'renew')`).run(key);
  return getLicenseByKey(key);
}
function listLicenses(){ return db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC`).all(); }
function listLicenseHistory(key, limit=100){
  return db.prepare(`SELECT * FROM license_history WHERE key=? ORDER BY id DESC LIMIT ?`).all(key, limit);
}
function checkLicense(uid){
  const row = getLicenseByUid(uid);
  if (!row) return { ok:false, status:'not_found' };
  if (!row.active) return { ok:false, status:'inactive' };
  if (row.expires_at && Date.now() > row.expires_at){
    return { ok:false, status:'expired', plan: row.plan, expires_at: row.expires_at };
  }
  return { ok:true, status:'valid', plan: row.plan, key: row.key, expires_at: row.expires_at || null };
}

// ---------- EXPORT ----------
module.exports = {
  // challenges
  getTarget, saveObservation, recomputeTarget,
  listChallenges, getChallenge, listObservations,
  setTarget, deleteKey, compactKey,
  // licenses
  getLicenseByKey, getLicenseByUid, upsertLicense, setLicenseTargetUid,
  transferLicense, deactivateLicense, activateLicense, renewLicense,
  listLicenses, listLicenseHistory, checkLicense
};
