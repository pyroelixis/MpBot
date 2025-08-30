// db.js — SQLite storage for targets/observations + licenses
const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'data.db'));
db.pragma('journal_mode = WAL');

const nowMs = () => Date.now();

/* ========= Schema ========= */
db.exec(`
CREATE TABLE IF NOT EXISTS challenges (
  key TEXT PRIMARY KEY,
  thetaDeg REAL NOT NULL DEFAULT 0,
  phiDeg   REAL NOT NULL DEFAULT 90,
  tolerance REAL NOT NULL DEFAULT 10,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  thetaDeg REAL NOT NULL,
  phiDeg   REAL NOT NULL,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS licenses (
  key TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'pro',
  expires_at TEXT NULL,
  max_devices INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  uid TEXT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS license_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  uid TEXT NULL,
  action TEXT NOT NULL,
  info TEXT NULL,
  ts INTEGER NOT NULL
);
`);

const insDefaultChallenge = db.prepare(`
INSERT OR IGNORE INTO challenges (key, thetaDeg, phiDeg, tolerance, updated_at)
VALUES (@key, 0, 90, 10, @ts)
`);
insDefaultChallenge.run({ key: 'default', ts: nowMs() });

/* ========= Targets ========= */
const selTarget = db.prepare(`SELECT key, thetaDeg, phiDeg, tolerance, updated_at FROM challenges WHERE key=?`);
const upsertTarget = db.prepare(`
INSERT INTO challenges (key, thetaDeg, phiDeg, tolerance, updated_at)
VALUES (@key,@thetaDeg,@phiDeg,@tolerance,@ts)
ON CONFLICT(key) DO UPDATE SET
  thetaDeg=excluded.thetaDeg,
  phiDeg=excluded.phiDeg,
  tolerance=excluded.tolerance,
  updated_at=excluded.updated_at
`);
const insObs = db.prepare(`INSERT INTO observations (key, thetaDeg, phiDeg, ts) VALUES (?,?,?,?)`);
const listObsStmt = db.prepare(`SELECT thetaDeg, phiDeg, ts FROM observations WHERE key=? ORDER BY id DESC LIMIT ?`);
const delOldObs = db.prepare(`
DELETE FROM observations WHERE id IN (
  SELECT id FROM observations WHERE key=? ORDER BY id DESC LIMIT -1 OFFSET ?
)`);
const delObsByKey = db.prepare(`DELETE FROM observations WHERE key=?`);
const delChallenge = db.prepare(`DELETE FROM challenges WHERE key=?`);
const listChallengesStmt = db.prepare(`SELECT key, thetaDeg, phiDeg, tolerance, updated_at FROM challenges ORDER BY key ASC`);

function getTarget(key) {
  let row = selTarget.get(String(key));
  if (!row) {
    upsertTarget.run({ key: String(key), thetaDeg: 0, phiDeg: 90, tolerance: 10, ts: nowMs() });
    row = selTarget.get(String(key));
  }
  return row;
}
function setTarget(key, thetaDeg, phiDeg, tolerance=10) {
  upsertTarget.run({ key:String(key), thetaDeg:+thetaDeg, phiDeg:+phiDeg, tolerance:+tolerance, ts: nowMs() });
  return selTarget.get(String(key));
}
function saveObservation(key, thetaDeg, phiDeg) {
  insObs.run(String(key), +thetaDeg, +phiDeg, nowMs());
}
function listObservations(key, limit=200) {
  return listObsStmt.all(String(key), Math.max(1, +limit));
}
function recomputeTarget(key, limit=200) {
  const rows = listObservations(key, limit);
  if (!rows.length) return getTarget(key);
  const avg = rows.reduce((a,r)=>({ th:a.th+r.thetaDeg, ph:a.ph+r.phiDeg }), {th:0,ph:0});
  const theta = avg.th / rows.length;
  const phi   = avg.ph / rows.length;
  return setTarget(key, theta, phi, getTarget(key).tolerance);
}
function compactKey(key, keep=200) {
  delOldObs.run(String(key), Math.max(0, +keep));
  return recomputeTarget(key, keep);
}
function deleteKey(key) {
  const k = String(key);
  const ch = selTarget.get(k);
  delObsByKey.run(k);
  delChallenge.run(k);
  return !!ch;
}
function listChallenges() {
  return listChallengesStmt.all().map(r => ({
    key: r.key, thetaDeg: r.thetaDeg, phiDeg: r.phiDeg, tolerance: r.tolerance, updated_at: r.updated_at
  }));
}

/* ========= Licenses ========= */
const selLicense = db.prepare(`SELECT key, plan, expires_at, max_devices, active, uid, updated_at FROM licenses WHERE key=?`);
const upsertLicenseStmt = db.prepare(`
INSERT INTO licenses (key, plan, expires_at, max_devices, active, uid, updated_at)
VALUES (@key, @plan, @expires_at, @max_devices, @active, COALESCE(@uid, NULL), @ts)
ON CONFLICT(key) DO UPDATE SET
  plan=excluded.plan,
  expires_at=excluded.expires_at,
  max_devices=excluded.max_devices,
  active=excluded.active,
  updated_at=excluded.updated_at
`);
const updUid = db.prepare(`UPDATE licenses SET uid=?, updated_at=? WHERE key=?`);
const listLicensesStmt = db.prepare(`SELECT key, plan, expires_at, max_devices, active, uid, updated_at FROM licenses ORDER BY updated_at DESC`);
const insLicHist = db.prepare(`INSERT INTO license_history (key, uid, action, info, ts) VALUES (?,?,?,?,?)`);
const listLicHistStmt = db.prepare(`SELECT ts, action, uid, info FROM license_history WHERE key=? ORDER BY id DESC LIMIT ?`);
const selByUid = db.prepare(`SELECT key, plan, expires_at, active, uid FROM licenses WHERE uid=? LIMIT 1`);

function upsertLicense({key, plan='pro', expires_at=null, max_devices=1, active=1, uid=null}) {
  const ts = nowMs();
  upsertLicenseStmt.run({
    key:String(key), plan, expires_at, max_devices:+max_devices, active:+active, uid: uid ? String(uid) : null, ts
  });
  insLicHist.run(String(key), uid?String(uid):null, 'upsert', null, ts);
  return selLicense.get(String(key));
}
function getLicenseByKey(key){ return selLicense.get(String(key)); }
function setLicenseTargetUid(key, uid) {
  const row = selLicense.get(String(key));
  if (!row) return null;
  if (row.uid && row.uid !== String(uid)) return 'bound-to-other';
  updUid.run(String(uid), nowMs(), String(key));
  insLicHist.run(String(key), String(uid), row.uid ? 'rebind' : 'bind', null, nowMs());
  return selLicense.get(String(key));
}
function transferLicense(key, fromUid, toUid) {
  const row = selLicense.get(String(key));
  if (!row) return null;
  if (row.uid && fromUid && row.uid !== String(fromUid)) return 'bound-to-other';
  if (row.uid && !fromUid && row.uid !== String(toUid)) return 'bound-to-other';
  updUid.run(String(toUid), nowMs(), String(key));
  insLicHist.run(String(key), String(toUid), 'transfer', fromUid?`from:${fromUid}`:null, nowMs());
  return selLicense.get(String(key));
}
function listLicenses(){
  return listLicensesStmt.all();
}
function listLicenseHistory(key, limit=100){
  return listLicHistStmt.all(String(key), Math.max(1,+limit));
}
function checkLicense(uid){
  const row = selByUid.get(String(uid));
  if (!row) return { ok:false, status:'unbound' };
  if (!row.active) return { ok:false, status:'inactive', key:row.key };
  if (row.expires_at) {
    const until = Date.parse(row.expires_at);
    if (!isNaN(until) && until < Date.now()) {
      return { ok:false, status:'expired', key:row.key, expires_at: row.expires_at };
    }
  }
  return { ok:true, plan:row.plan, key:row.key, expires_at: row.expires_at };
}

module.exports = {
  // targets
  getTarget, setTarget, saveObservation, listObservations, recomputeTarget, compactKey, deleteKey, listChallenges,
  // licenses
  upsertLicense, getLicenseByKey, setLicenseTargetUid, transferLicense, listLicenses, listLicenseHistory, checkLicense
};
