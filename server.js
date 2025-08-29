const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const OBS_RECOMPUTE = process.env.OBS_RECOMPUTE === '1';

app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

/* ===== PUBLIC: Challenge ===== */
app.get('/api/challenge', (req, res) => {
  const key = (req.query.key || 'default') + '';
  const t = db.getTarget(key);
  res.set('Cache-Control', 'no-store');
  res.json({ key, target: { thetaDeg: t.thetaDeg, phiDeg: t.phiDeg }, tolerance: t.tolerance });
});
app.post('/api/observe', (req, res) => {
  const { key, thetaDeg, phiDeg } = req.body || {};
  if (typeof key !== 'string' || typeof thetaDeg !== 'number' || typeof phiDeg !== 'number') {
    return res.status(400).json({ ok:false, error:'invalid payload: key/thetaDeg/phiDeg required' });
  }
  db.saveObservation(key, thetaDeg, phiDeg);
  let target = null;
  if (OBS_RECOMPUTE) target = db.recomputeTarget(key);
  res.json({ ok:true, target });
});
app.get('/api/health', (_, res) => res.json({ ok:true }));

/* ===== Legacy stub (Compatibility) ===== */
function alohaHandler(_req, res){ res.json({ ok:true, name:'bundle' }); }
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);
function statHandler(_req,res){ res.json({ ok:true }); }
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

/* ===== LICENSE API ===== */
// Upsert license (+optionally bind to uid)
app.post('/api/key', (req, res) => {
  const { uid, key, plan='pro', expiresAt=null, max_devices=1, active=1 } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const row = db.upsertLicense({
    key, plan, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices, active
  });
  if (uid) db.setLicenseTargetUid(key, String(uid));
  const lic = db.getLicenseByKey(key);
  return res.json({ ok:true, key:lic.key, plan:lic.plan, uid:lic.uid||null, expiresAt: lic.expires_at, active: !!lic.active });
});

// Check license by UID
// Auto-bind: if ?key=LICENSE_KEY and license not bound -> bind to this UID
app.get('/api/check/:uid', (req, res) => {
  const uid = (req.params.uid || '').trim();
  if (!uid) return res.status(400).json({ ok:false, error:'uid required' });
  const key = (req.query.key || '').trim();
  if (key) {
    try { db.transferLicense(key, null, uid); } catch (_) { /* ignore */ }
  }
  const st = db.checkLicense(uid);
  const resp = { ...st };
  if ('expires_at' in resp) { resp.expiresAt = resp.expires_at; delete resp.expires_at; }
  return res.json(resp);
});

// Transfer explicit
app.get('/api/tranfer/:fromUid', (req, res) => {
  const fromUid = (req.params.fromUid || '').trim();
  const toUid   = (req.query.tranferTo || req.query.transferTo || '').trim();
  const key     = (req.query.key || '').trim();
  if (!key || !toUid) return res.status(400).json({ ok:false, error:'key & tranferTo required' });
  const row = db.transferLicense(key, fromUid || null, toUid);
  if (row === 'bound-to-other') return res.status(403).json({ ok:false, error:'license bound to another uid' });
  if (!row) return res.status(404).json({ ok:false, error:'license not found' });
  return res.json({ ok:true, key: row.key, fromUid, toUid, plan: row.plan, expiresAt: row.expires_at });
});

/* ===== ADMIN GUARD ===== */
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || t === process.env.ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

/* ===== ADMIN: challenges ===== */
app.get('/api/admin/challenges', requireAdmin, (_req, res) => {
  res.json({ ok:true, rows: db.listChallenges() });
});
app.get('/api/admin/challenges/:key', requireAdmin, (req, res) => {
  const row = db.getChallenge(req.params.key + '');
  if (!row) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, row });
});
app.get('/api/admin/observations/:key', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json({ ok:true, rows: db.listObservations(req.params.key + '', limit) });
});
app.post('/api/admin/set-target', requireAdmin, (req, res) => {
  const { key, thetaDeg, phiDeg, tolerance } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ ok:false, error:'key required' });
  const tgt = db.setTarget(key, Number(thetaDeg ?? 0), Number(phiDeg ?? 90), Number(tolerance ?? 10));
  res.json({ ok:true, target: tgt });
});
app.delete('/api/admin/keys/:key', requireAdmin, (req, res) => {
  res.json({ ok:true, deleted: db.deleteKey(req.params.key + '') });
});
app.post('/api/admin/compact/:key', requireAdmin, (req, res) => {
  const keep = Math.min(Number(req.body?.keep ?? 200), 2000);
  const tgt = db.compactKey(req.params.key + '', keep);
  res.json({ ok:true, kept: keep, target: tgt });
});

/* ===== ADMIN: licenses ===== */
app.get('/api/admin/licenses', requireAdmin, (_req,res)=>{
  res.json({ ok:true, rows: db.listLicenses() });
});
app.get('/api/admin/licenses/:key/history', requireAdmin, (req,res)=>{
  const limit = Math.min(Number(req.query.limit||100), 1000);
  res.json({ ok:true, rows: db.listLicenseHistory(req.params.key, limit) });
});
app.post('/api/admin/licenses', requireAdmin, (req,res)=>{
  const { key, plan='pro', expiresAt=null, max_devices=1, active=1 } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const row = db.upsertLicense({
    key, plan, expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices, active
  });
  res.json({ ok:true, row: { ...row, expiresAt: row.expires_at } });
});

/* ===== Admin UI (static) ===== */
app.use('/admin', express.static(path.join(__dirname, 'admin')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
