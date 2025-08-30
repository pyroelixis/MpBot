// server.js — MpBot backend (targets + license) with first-time auto-bind
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const OBS_RECOMPUTE = process.env.OBS_RECOMPUTE === '1';

app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

/* ===== Health ===== */
app.get('/api/health', (_req, res) => res.json({ ok:true }));
app.get('/healthz', (_req, res) => res.send('ok'));

/* ===== Challenge / Observation ===== */
app.get('/api/challenge', (req, res) => {
  const key = (req.query.key || 'default') + '';
  const t = db.getTarget(key);
  res.set('Cache-Control', 'no-store');
  res.json({ key, target:{ thetaDeg:t.thetaDeg, phiDeg:t.phiDeg }, tolerance: t.tolerance });
});

app.post('/api/observe', (req, res) => {
  const { key, thetaDeg, phiDeg } = req.body || {};
  if (typeof key !== 'string' || typeof thetaDeg !== 'number' || typeof phiDeg !== 'number') {
    return res.status(400).json({ ok:false, error:'invalid payload' });
  }
  db.saveObservation(key, thetaDeg, phiDeg);
  const target = OBS_RECOMPUTE ? db.recomputeTarget(key) : null;
  res.json({ ok:true, target });
});

/* ===== Legacy stubs (compat) ===== */
app.get('/api/aloha/:uid', (_req,res)=>res.json({ ok:true, name:'bundle' }));
app.get('/aloha/:uid', (_req,res)=>res.json({ ok:true, name:'bundle' }));
app.post('/api/stat', (_req,res)=>res.json({ ok:true }));
app.post('/stat', (_req,res)=>res.json({ ok:true }));

/* ===== License (public) ===== */
// Upsert license (optional uid → bind ทันที)
app.post('/api/key', (req,res)=>{
  const { key, plan='pro', expiresAt=null, max_devices=1, active=1, uid=null } = req.body||{};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const row = db.upsertLicense({
    key:String(key),
    plan,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices:+max_devices,
    active:+active,
    uid: uid?String(uid):null
  });
  if (uid) db.setLicenseTargetUid(String(key), String(uid));
  return res.json({ ok:true, key: row.key, plan: row.plan, uid: row.uid||null, expiresAt: row.expires_at, active: !!row.active });
});

// Check license + “first-time auto-bind” when key is supplied
app.get('/api/check/:uid', (req,res)=>{
  const uid = (req.params.uid||'').trim();
  if (!uid) return res.status(400).json({ ok:false, error:'uid required' });
  const key = (req.query.key || req.headers['x-license-key'] || '').toString().trim();

  if (key) {
    try {
      const r = db.transferLicense(String(key), null, String(uid));
      // r may be null or 'bound-to-other' → ไม่ต้อง throw จะไปเช็คสถานะจริงต่อ
    } catch (_) { /* noop */ }
  }

  const st = db.checkLicense(String(uid));
  const resp = { ...st };
  if ('expires_at' in resp) { resp.expiresAt = resp.expires_at; delete resp.expires_at; }
  return res.json(resp);
});

// Transfer (compat path name: tranfer)
app.get('/api/tranfer/:fromUid', (req,res)=>{
  const fromUid = (req.params.fromUid||'').trim();
  const toUid   = (req.query.tranferTo || req.query.transferTo || '').toString().trim();
  const key     = (req.query.key||'').toString().trim();
  if (!key || !toUid) return res.status(400).json({ ok:false, error:'key & tranferTo required' });
  const row = db.transferLicense(String(key), fromUid||null, String(toUid));
  if (row === 'bound-to-other') return res.status(403).json({ ok:false, error:'license bound to another uid' });
  if (!row) return res.status(404).json({ ok:false, error:'license not found' });
  res.json({ ok:true, key:row.key, fromUid, toUid, plan:row.plan, expiresAt: row.expires_at });
});

/* ===== Admin guard ===== */
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || t === process.env.ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

/* ===== Admin: targets ===== */
app.get('/api/admin/challenges', requireAdmin, (_req,res)=>{
  res.json({ ok:true, rows: db.listChallenges() });
});
app.get('/api/admin/challenges/:key', requireAdmin, (req,res)=>{
  const row = db.getChallenge(req.params.key + '');
  if (!row) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, row });
});
app.get('/api/admin/observations/:key', requireAdmin, (req,res)=>{
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json({ ok:true, rows: db.listObservations(req.params.key + '', limit) });
});
app.post('/api/admin/set-target', requireAdmin, (req,res)=>{
  const { key, thetaDeg, phiDeg, tolerance } = req.body || {};
  if (typeof key !== 'string') return res.status(400).json({ ok:false, error:'key required' });
  res.json({ ok:true, target: db.setTarget(key, Number(thetaDeg ?? 0), Number(phiDeg ?? 90), Number(tolerance ?? 10)) });
});
app.delete('/api/admin/keys/:key', requireAdmin, (req,res)=>{
  res.json({ ok:true, deleted: db.deleteKey(req.params.key + '') });
});
app.post('/api/admin/compact/:key', requireAdmin, (req,res)=>{
  const keep = Math.min(Number(req.body?.keep ?? 200), 2000);
  res.json({ ok:true, kept: keep, target: db.compactKey(req.params.key + '', keep) });
});

/* ===== Admin: licenses ===== */
app.get('/api/admin/licenses', requireAdmin, (_req,res)=>{
  const rows = db.listLicenses().map(r=>({
    key: r.key,
    plan: r.plan,
    uid: r.uid ? 'YES' : '—',
    active: r.active ? 'YES' : 'NO',
    expires: r.expires_at,
    updated: r.updated_at
  }));
  res.json({ ok:true, rows });
});
app.get('/api/admin/licenses/:key/history', requireAdmin, (req,res)=>{
  res.json({ ok:true, rows: db.listLicenseHistory(req.params.key, Math.min(Number(req.query.limit||100),1000)) });
});
app.post('/api/admin/licenses', requireAdmin, (req,res)=>{
  const { key, plan='pro', expiresAt=null, max_devices=1, active=1 } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const row = db.upsertLicense({
    key:String(key),
    plan,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices:+max_devices,
    active:+active
  });
  res.json({ ok:true, row:{...row, expiresAt: row.expires_at } });
});
app.post('/api/admin/licenses/bind', requireAdmin, (req,res)=>{
  const { key, uid } = req.body || {};
  if (!key || !uid) return res.status(400).json({ ok:false, error:'key & uid required' });
  const r = db.setLicenseTargetUid(String(key), String(uid));
  if (r === 'bound-to-other') return res.status(409).json({ ok:false, error:'bound-to-other' });
  const row = db.getLicenseByKey(String(key));
  res.json({ ok:true, row: { ...row, expiresAt: row.expires_at } });
});
app.get('/api/admin/licenses/check/:uid', requireAdmin, (req,res)=>{
  const st = db.checkLicense(String(req.params.uid||''));
  const resp = { ...st };
  if ('expires_at' in resp){ resp.expiresAt = resp.expires_at; delete resp.expires_at; }
  res.json(resp);
});

/* ===== Admin UI (static) ===== */
app.use('/admin', express.static(path.join(__dirname, 'admin')));

/* ===== Start ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
