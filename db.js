// db.js — better-sqlite3 storage for challenges / observations / licenses
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'mpbot.db'));

// ===== Schema =====
db.exec(`
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS challenges (
  key TEXT PRIMARY KEY,
  thetaDeg REAL NOT NULL DEFAULT 0,
  phiDeg   REAL NOT NULL DEFAULT 90,
  tolerance INTEGER NOT NULL DEFAULT 10,
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  thetaDeg REAL NOT NULL,
  phiDeg   REAL NOT NULL,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE INDEX IF NOT EXISTS idx_obs_key_ts ON observations(key, ts DESC);

CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro',
  expires_at TEXT,              -- ISO string หรือ NULL = ไม่หมดอายุ
  max_devices INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  uid TEXT,                     -- อุปกรณ์ที่ผูกอยู่ปัจจุบัน (single device)
  updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000)
);

CREATE TABLE IF NOT EXISTS license_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  action TEXT NOT NULL,         -- 'bind' | 'check' | 'transfer' | 'upsert'
  uid TEXT,
  ts INTEGER NOT NULL DEFAULT (strftime('%s','now')*1000),
  meta TEXT
);
`);

// ===== Helpers =====
const now = () => Date.now();

// ===== Challenges & Observations =====
function ensureChallenge(key){
  const row = db.prepare('SELECT key FROM challenges WHERE key=?').get(key);
  if (!row) {
    db.prepare(`INSERT INTO challenges(key,thetaDeg,phiDeg,tolerance,updated_at)
                VALUES(?,?,?,10,?)`).run(key, 0, 90, now());
  }
}

function getTarget(key){
  ensureChallenge(key);
  return db.prepare('SELECT thetaDeg,phiDeg,tolerance FROM challenges WHERE key=?').get(key);
}

function setTarget(key, thetaDeg, phiDeg, tolerance=10){
  ensureChallenge(key);
  db.prepare(`UPDATE challenges SET thetaDeg=?, phiDeg=?, tolerance=?, updated_at=? WHERE key=?`)
    .run(thetaDeg, phiDeg, tolerance, now(), key);
  return getTarget(key);
}

function saveObservation(key, thetaDeg, phiDeg){
  ensureChallenge(key);
  db.prepare(`INSERT INTO observations(key,thetaDeg,phiDeg,ts) VALUES(?,?,?,?)`)
    .run(key, thetaDeg, phiDeg, now());
}

function listObservations(key, limit=200){
  return db.prepare(`SELECT thetaDeg,phiDeg,ts FROM observations WHERE key=? ORDER BY ts DESC LIMIT ?`)
    .all(key, limit);
}

function recomputeTarget(key, limit=200){
  // เฉลี่ยจากล่าสุด N ถ้าไม่มี ใช้ค่าปัจจุบัน
  const rows = db.prepare(`SELECT thetaDeg,phiDeg FROM observations WHERE key=? ORDER BY ts DESC LIMIT ?`)
    .all(key, limit);
  if (!rows.length) return getTarget(key);
  const avg = rows.reduce((a,r)=>({ theta:a.theta+r.thetaDeg, phi:a.phi+r.phiDeg }), {theta:0,phi:0});
  const theta = avg.theta / rows.length;
  const phi   = avg.phi   / rows.length;
  return setTarget(key, theta, phi, getTarget(key).tolerance);
}

function listChallenges(){
  return db.prepare(`SELECT key,thetaDeg,phiDeg,tolerance,updated_at FROM challenges ORDER BY updated_at DESC`).all();
}

function getChallenge(key){
  return db.prepare(`SELECT key,thetaDeg,phiDeg,tolerance,updated_at FROM challenges WHERE key=?`).get(key);
}

function deleteKey(key){
  const delObs = db.prepare(`DELETE FROM observations WHERE key=?`).run(key);
  const delCh  = db.prepare(`DELETE FROM challenges WHERE key=?`).run(key);
  return { obs: delObs.changes, challenges: delCh.changes };
}

function compactKey(key, keep=200){
  const ids = db.prepare(`SELECT id FROM observations WHERE key=? ORDER BY ts DESC LIMIT -1 OFFSET ?`)
    .all(key, keep).map(r => r.id);
  if (ids.length) {
    const placeholders = ids.map(()=>'?').join(',');
    db.prepare(`DELETE FROM observations WHERE id IN (${placeholders})`).run(...ids);
  }
  return recomputeTarget(key, keep);
}

// ===== Licenses =====
function upsertLicense({ key, plan='pro', expires_at=null, max_devices=1, active=1 }){
  const row = db.prepare(`SELECT key FROM licenses WHERE key=?`).get(key);
  if (row) {
    db.prepare(`UPDATE licenses SET plan=?, expires_at=?, max_devices=?, active=?, updated_at=? WHERE key=?`)
      .run(plan, expires_at, max_devices, active, now(), key);
  } else {
    db.prepare(`INSERT INTO licenses(key,plan,expires_at,max_devices,active,uid,updated_at)
                VALUES(?,?,?,?,?,NULL,?)`).run(key, plan, expires_at, max_devices, active, now());
  }
  db.prepare(`INSERT INTO license_history(key,action,uid,meta) VALUES(?, 'upsert', NULL, ?)`)
    .run(key, JSON.stringify({ plan, expires_at, max_devices, active }));
  return db.prepare(`SELECT * FROM licenses WHERE key=?`).get(key);
}

function getLicenseByKey(key){
  return db.prepare(`SELECT * FROM licenses WHERE key=?`).get(key);
}

function setLicenseTargetUid({ key, uid }){ // bind
  const lic = getLicenseByKey(key);
  if (!lic) throw new Error('license not found');
  db.prepare(`UPDATE licenses SET uid=?, updated_at=? WHERE key=?`).run(uid, now(), key);
  db.prepare(`INSERT INTO license_history(key,action,uid) VALUES(?, 'bind', ?)`).run(key, uid);
  return getLicenseByKey(key);
}

function transferLicense({ key, fromUid, toUid }){
  const lic = getLicenseByKey(key);
  if (!lic) throw new Error('license not found');
  if (!toUid) throw new Error('toUid required');
  if (lic.uid && fromUid && lic.uid !== fromUid) {
    throw new Error('current uid mismatch');
  }
  db.prepare(`UPDATE licenses SET uid=?, updated_at=? WHERE key=?`).run(toUid, now(), key);
  db.prepare(`INSERT INTO license_history(key,action,uid,meta) VALUES(?, 'transfer', ?, ?)`)
    .run(key, toUid, JSON.stringify({ fromUid }));
  return { key, fromUid, toUid };
}

function _isExpired(lic){
  if (!lic.expires_at) return false;
  const t = Date.parse(lic.expires_at);
  if (isNaN(t)) return false; // ป้อนรูปแบบไม่ถูก ก็ถือว่าไม่หมดอายุ
  return Date.now() > t;
}

/**
 * checkLicense({ uid, key? })
 * - ถ้าส่ง key มาด้วย และ license ยังไม่ถูกผูก → auto-bind ให้ uid นี้
 * - ตรวจ active / หมดอายุ / uid ตรง
 * - คืน { plan, expiresAt, boundUid }
 */
function checkLicense({ uid, key=null }){
  if (key) {
    const lic = getLicenseByKey(key);
    if (!lic) throw new Error('license key not found');
    if (!lic.active) throw new Error('license inactive');
    if (_isExpired(lic)) throw new Error('license expired');
    if (!lic.uid) {
      // ยังไม่ผูก ใส่ uid นี้ให้เลย (auto-bind ครั้งแรก)
      setLicenseTargetUid({ key, uid });
      return { plan: lic.plan, expiresAt: lic.expires_at, boundUid: uid };
    }
    // มี uid อยู่แล้ว ต้องตรงกัน
    if (lic.uid !== uid) throw new Error('license bound to another device');
    db.prepare(`INSERT INTO license_history(key,action,uid) VALUES(?, 'check', ?)`).run(key, uid);
    return { plan: lic.plan, expiresAt: lic.expires_at, boundUid: lic.uid };
  }

  // ไม่ส่ง key มา → ดูจาก licenses ไหนก็ตามที่ผูก uid นี้อยู่ (กรณีเก็บ uid ฝั่งเซิร์ฟ)
  const lic = db.prepare(`SELECT * FROM licenses WHERE uid=?`).get(uid);
  if (!lic) throw new Error('uid not bound');
  if (!lic.active) throw new Error('license inactive');
  if (_isExpired(lic)) throw new Error('license expired');
  db.prepare(`INSERT INTO license_history(key,action,uid) VALUES(?, 'check', ?)`).run(lic.key, uid);
  return { plan: lic.plan, expiresAt: lic.expires_at, boundUid: lic.uid };
}

function listLicenses(){
  return db.prepare(`SELECT key,plan,expires_at,max_devices,active,uid,updated_at FROM licenses ORDER BY updated_at DESC`).all();
}
function listLicenseHistory(key){
  return db.prepare(`SELECT action,uid,ts,meta FROM license_history WHERE key=? ORDER BY ts DESC`).all(key);
}

module.exports = {
  // challenge/observation
  getTarget, setTarget, saveObservation, listObservations, recomputeTarget,
  listChallenges, getChallenge, deleteKey, compactKey,
  // license
  upsertLicense, getLicenseByKey, setLicenseTargetUid, transferLicense,
  checkLicense, listLicenses, listLicenseHistory
};
