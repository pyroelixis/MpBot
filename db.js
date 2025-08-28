// db.js — data access layer for MpBot
const Database = require('better-sqlite3');

const db = new Database('mpbot.db');
db.pragma('journal_mode = WAL');

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

// ---------- DAO functions ----------
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

module.exports = {
  getTarget,
  saveObservation,
  recomputeTarget,
  listChallenges,
  getChallenge,
  listObservations,
  setTarget,
  deleteKey,
  compactKey,
};
