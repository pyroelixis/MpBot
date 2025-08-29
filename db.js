const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'db.json');

const DEFAULT_TARGET = { thetaDeg: 270, phiDeg: 90, tolerance: 10 };

/* ========== low-level ========== */
function now() { return Date.now(); }

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const j = JSON.parse(raw);
    return Object.assign({ challenges:{}, observations:{}, licenses:{}, license_history:[] }, j);
  } catch {
    return { challenges:{}, observations:{}, licenses:{}, license_history:[] };
  }
}
function save(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
}
let DB = load();

/* ========== helpers ========== */
function clamp360(d) {
  d = Number(d);
  if (!isFinite(d)) return 0;
  d = d % 360;
  if (d < 0) d += 360;
  return d;
}
function circularMean(degArray) {
  if (!degArray.length) return 0;
  const toRad = d => (d*Math.PI/180);
  let sx = 0, sy = 0;
  for (const d of degArray) { sx += Math.cos(toRad(d)); sy += Math.sin(toRad(d)); }
  const mean = Math.atan2(sy, sx) * 180 / Math.PI;
  return clamp360(mean);
}

/* ========== CHALLENGES / OBSERVATIONS ========== */
function getTarget(key) {
  const row = DB.challenges[key];
  if (!row) return { ...DEFAULT_TARGET };
  return {
    thetaDeg: typeof row.thetaDeg === 'number' ? row.thetaDeg : DEFAULT_TARGET.thetaDeg,
    phiDeg:   typeof row.phiDeg   === 'number' ? row.phiDeg   : DEFAULT_TARGET.phiDeg,
    tolerance:typeof row.tolerance=== 'number' ? row.tolerance: DEFAULT_TARGET.tolerance
  };
}
function setTarget(key, thetaDeg, phiDeg, tolerance = 10) {
  DB.challenges[key] = {
    thetaDeg: clamp360(Number(thetaDeg)),
    phiDeg: Number(phiDeg),
    tolerance: Number(tolerance),
    updated_at: now()
  };
  save(DB);
  return DB.challenges[key];
}
function saveObservation(key, thetaDeg, phiDeg) {
  if (!DB.observations[key]) DB.observations[key] = [];
  DB.observations[key].push({ thetaDeg: clamp360(Number(thetaDeg)), phiDeg: Number(phiDeg), ts: now() });
  const arr = DB.observations[key];
  if (arr.length > 5000) DB.observations[key] = arr.slice(-5000);
  save(DB);
}
function listObservations(key, limit = 200) {
  const arr = DB.observations[key] || [];
  return arr.slice(-limit).reverse(); // latest first
}
function recomputeTarget(key, limit = 200) {
  const arr = DB.observations[key] || [];
  const slice = arr.slice(-limit);
  if (!slice.length) return getTarget(key);

  const thetaList = slice.map(r => clamp360(r.thetaDeg));
  const phiAvg = slice.reduce((a, r) => a + (Number(r.phiDeg) || 0), 0) / slice.length;
  const thetaAvg = circularMean(thetaList);

  return setTarget(key, thetaAvg, phiAvg, getTarget(key).tolerance);
}
function listChallenges() {
  return Object.entries(DB.challenges).map(([key, v]) => ({
    key, thetaDeg:v.thetaDeg, phiDeg:v.phiDeg, tolerance:v.tolerance, updated_at:v.updated_at || null
  }));
}
function getChallenge(key) {
  const v = DB.challenges[key];
  if (!v) return null;
  return { key, thetaDeg:v.thetaDeg, phiDeg:v.phiDeg, tolerance:v.tolerance, updated_at:v.updated_at || null };
}
function deleteKey(key) {
  let removed = false;
  if (DB.challenges[key]) { delete DB.challenges[key]; removed = true; }
  if (DB.observations[key]) { delete DB.observations[key]; removed = true; }
  save(DB);
  return removed;
}
function compactKey(key, keep = 200) {
  if (!DB.observations[key]) return getTarget(key);
  const k = Math.max(1, Math.min(Number(keep)||200, 5000));
  DB.observations[key] = DB.observations[key].slice(-k);
  save(DB);
  return recomputeTarget(key, k);
}

/* ========== LICENSES / HISTORY ========== */
function history(key, action, from_uid=null, to_uid=null) {
  DB.license_history.push({ ts: now(), key:String(key), action:String(action), from_uid: from_uid||null, to_uid: to_uid||null });
  if (DB.license_history.length > 5000) DB.license_history = DB.license_history.slice(-5000);
  save(DB);
}
function touchLicense(key, patch) {
  const k = String(key);
  const cur = DB.licenses[k] || {
    key: k, plan:'pro', expires_at: null, max_devices:1, active:1, uid:null, updated_at: now()
  };
  const row = { ...cur, ...patch, updated_at: now() };
  DB.licenses[k] = row;
  save(DB);
  return row;
}
function upsertLicense({ key, plan='pro', expires_at=null, max_devices=1, active=1 }) {
  const exists = !!DB.licenses[String(key)];
  const row = touchLicense(key, {
    plan: String(plan||'pro'),
    expires_at: expires_at ? new Date(expires_at).toISOString() : null,
    max_devices: Number(max_devices||1),
    active: Number(active?1:0)
  });
  if (!exists) history(key, 'create', null, null);
  return row;
}
function getLicenseByKey(key) {
  return DB.licenses[String(key)] || null;
}
function setLicenseTargetUid(key, uid) {
  const lic = DB.licenses[String(key)];
  if (!lic) return null;
  const prev = lic.uid || null;
  const row = touchLicense(key, { uid: uid || null });
  history(key, prev ? 'transfer' : 'bind', prev, uid || null);
  return row;
}
function transferLicense(key, fromUid, toUid) {
  const lic = DB.licenses[String(key)];
  if (!lic) return null;
  if (fromUid && lic.uid && lic.uid !== fromUid) return 'bound-to-other';
  const prev = lic.uid || null;
  const row = touchLicense(key, { uid: toUid || null });
  history(key, 'transfer', prev, toUid || null);
  return row;
}
function getLicenseByUid(uid) {
  if (!uid) return null;
  const items = Object.values(DB.licenses);
  return items.find(r => r.uid === uid && Number(r.active) === 1) || null;
}
function checkLicense(uid) {
  const lic = getLicenseByUid(uid);
  if (!lic) return { ok:false, error:'not bound', plan:null, expires_at:null };
  if (Number(lic.active) !== 1) return { ok:false, error:'inactive', plan:lic.plan, expires_at:lic.expires_at };
  if (lic.expires_at) {
    const expMs = Date.parse(lic.expires_at);
    if (isFinite(expMs) && Date.now() > expMs) {
      return { ok:false, error:'expired', plan: lic.plan, expires_at: lic.expires_at };
    }
  }
  return { ok:true, plan: lic.plan, expires_at: lic.expires_at || null };
}
function listLicenses() {
  return Object.values(DB.licenses).map(r => ({ ...r }));
}
function listLicenseHistory(key, limit = 100) {
  const rows = DB.license_history.filter(h => h.key === String(key)).slice(-Math.min(Number(limit)||100, 1000));
  return rows.reverse();
}

/* ========== exports ========== */
module.exports = {
  // challenge/observation
  getTarget, setTarget, saveObservation, listObservations, recomputeTarget,
  listChallenges, getChallenge, deleteKey, compactKey,
  // license
  upsertLicense, getLicenseByKey, setLicenseTargetUid, transferLicense,
  getLicenseByUid, checkLicense, listLicenses, listLicenseHistory
};
