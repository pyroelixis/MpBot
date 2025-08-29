const fs = require('fs');
const path = require('path');
const DB_FILE = path.join(__dirname, 'db.json');

const DEFAULT_TARGET = { thetaDeg: 270, phiDeg: 90, tolerance: 10 };

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
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
function now() { return Date.now(); }

let DB = load();

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
    thetaDeg: Number(thetaDeg), phiDeg: Number(phiDeg),
    tolerance: Number(tolerance), updated_at: now()
  };
  save(DB);
  return DB.challenges[key];
}
function saveObservation(key, thetaDeg, phiDeg) {
  if (!DB.observations[key]) DB.observations[key] = [];
  DB.observations[key].push({ thetaDeg: Number(thetaDeg), phiDeg: Number(phiDeg), ts: now() });
  const arr = DB.observations[key];
  if (arr.length > 5000) DB.observations[key] = arr.slice(-5000);
  save(DB);
}
function listObservations(key, limit = 200) {
  const arr = DB.observations[key] || [];
  return arr.slice(-limit).reverse();
}
function recomputeTarget(key, limit = 200) {
  const arr = (DB.observations[key] || []).slice(-limit);
  if (!arr.length) return getTarget(key);
  const avg = arr.reduce((a, r) => {
    a.theta += r.thetaDeg; a.phi += r.phiDeg; return a;
  }, { theta:0, phi:0 });
  const theta = avg.theta / arr.length;
  const phi   = avg.phi   / arr.length;
  return setTarget(key, theta, phi, getTarget(key).tolerance);
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
  DB.observations[key] = DB.observations[key].slice(-keep);
  save(DB);
  return recomputeTarget(key, keep);
}

/* ========== LICENSES / HISTORY ========== */
// licenses[key] = { key, plan, expires_at (ISO|null), max_devices, active(0/1), uid (bound or null), updated_at }
// license_history: push { ts, key, action('create'|'bind'|'transfer'|'activate'|'deactivate'|'renew'), from_uid, to_uid }

function touchLicense(key, patch = {}) {
  const exist = DB.licenses[key] || { key, plan:'pro', expires_at:null, max_devices:1, active:1, uid:null, updated_at: now() };
  const row = { ...exist, ...patch, key, updated_at: now() };
  DB.licenses[key] = row;
  save(DB);
  return row;
}
function history(key, action, from_uid=null, to_uid=null) {
  DB.license_history.push({ ts: now(), key, action, from_uid, to_uid });
  if (DB.license_history.length > 20000) DB.license_history = DB.license_history.slice(-20000);
  save(DB);
}

function upsertLicense({ key, plan='pro', expires_at=null, max_devices=1, active=1 }) {
  const created = !DB.licenses[key];
  const row = touchLicense(key, { plan, expires_at, max_devices:Number(max_devices||1), active:Number(active?1:0) });
  if (created) history(key, 'create', null, null);
  return row;
}
function getLicenseByKey(key) {
  return DB.licenses[key] || null;
}
function setLicenseTargetUid(key, uid) {
  const lic = DB.licenses[key];
  if (!lic) return null;
  const prev = lic.uid || null;
  const row = touchLicense(key, { uid: uid || null });
  history(key, prev ? 'transfer' : 'bind', prev, uid || null);
  return row;
}
function transferLicense(key, fromUid, toUid) {
  const lic = DB.licenses[key];
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
  const rows = DB.license_history.filter(h => h.key === key).slice(-limit);
  return rows.reverse();
}

module.exports = {
  getTarget, setTarget, saveObservation, listObservations, recomputeTarget,
  listChallenges, getChallenge, deleteKey, compactKey,
  upsertLicense, getLicenseByKey, setLicenseTargetUid, transferLicense,
  getLicenseByUid, checkLicense, listLicenses, listLicenseHistory
};
