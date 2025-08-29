// server.js — MpBot backend (Express) using db.js + Admin UI
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();

// ===== Configs =====
const OBS_RECOMPUTE = process.env.OBS_RECOMPUTE === '1';

app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

/* ===== PUBLIC: Challenge ===== */
app.get('/api/challenge', (req, res) => {
  const key = (req.query.key || 'default') + '';
  const t = db.getTarget(key);
  res.set('Cache-Control', 'no-store');
  res.json({
    key,
    target: { thetaDeg: t.thetaDeg, phiDeg: t.phiDeg },
    tolerance: t.tolerance
  });
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

/* ===== LICENSE API (public + auto-bind) ===== */

/**
 * Upsert license (admin can also call this via Admin UI "Upsert").
 * Optional uid → will immediately bind this license to the uid.
 */
app.post('/api/key', (req, res) => {
  const { uid, key, plan='pro', expiresAt=null, max_devices=1, active=1 } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });

  const row = db.upsertLicense({
    key,
    plan,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices,
    active
  });

  if (uid) db.setLicenseTargetUid(key, String(uid)); // bind ทันทีถ้าส่ง uid มา

  const lic = db.getLicenseByKey(key);
  return res.json({
    ok: true,
    key: lic.key,
    plan: lic.plan,
    uid: lic.uid || null,
    expiresAt: lic.expires_at,
    active: !!lic.active
  });
});

/**
 * Check license for a UID.
 * - Auto-bind first time when a license key is supplied via ?key=... or header X-License-Key
 *   (only if that license is not yet bound to a different UID).
 */
app.get('/api/check/:uid', (req, res) => {
  const uid = (req.params.uid || '').trim();
  if (!uid) return res.status(400).json({ ok:false, error:'uid required' });

  const keyFromQuery  = (req.query.key || '').trim();
  const keyFromHeader = (req.headers['x-license-key'] || '').toString().trim();
  const key = keyFromQuery || keyFromHeader;

  // ถ้ามี key แนบมาด้วย → พยายาม bind ให้เป็นของ uid นี้ทันที (ครั้งแรก)
  if (key) {
    try {
      // fromUid=null หมายถึงอนุญาตให้ย้ายจาก "ยังไม่ถูกผูก" มาเป็น uid นี้
      // ถ้าเคยผูกกับ uid อื่นไว้แล้ว db.transferLicense ควรป้องกันและโยน error/ส่งสถานะ
      db.transferLicense(key, null, uid);
    } catch (e) {
      // ไม่เป็นไร แค่ bind ไม่สำเร็จ อาจเป็นเพราะถูกผูกไว้กับเครื่องอื่นแล้ว
    }
  }

  // ตรวจสถานะล่าสุดของ uid
  const st = db.checkLicense(uid); // { ok, plan, expires_at, key?, active?, ... }
  const resp = { ...st };
  if ('expires_at' in resp) {
    resp.expiresAt = resp.expires_at;
    delete resp.expires_at;
  }
  return res.json(resp);
});

/**
 * Transfer license key → new UID (explicit).
 * NOTE: path ชื่อ /tranfer (สะกดตามเดิมเพื่อความเข้ากันได้)
 */
app.get('/api/tranfer/:fromUid', (req, res) => {
  const fromUid = (req.params.fromUid || '').trim();
  const toUid   = (req.query.tranferTo || req.query.transferTo || '').trim();
  const key     = (req.query.key || '').trim();
  if (!key || !toUid) return res.status(400).json({ ok:false, error:'key & tranferTo required' });

  const row = db.transferLicense(key, fromUid || null, toUid);
  if (row === 'bound-to-other') return res.status(403).json({ ok:false, error:'license bound to another uid' });
  if (!row) return res.status(404).json({ ok:false, error:'license not found' });

  return res.json({
    ok: true,
    key: row.key,
    fromUid,
    toUid,
    plan: row.plan,
    expiresAt: row.expires_at
  });
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
    key,
    plan,
    expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
    max_devices,
    active
  });
  res.json({ ok:true, row: { ...row, expiresAt: row.expires_at } });
});
/** bind license ↔ uid (admin explicit) */
app.post('/api/admin/licenses/bind', requireAdmin, (req,res)=>{
  const { key, uid } = req.body || {};
  if (!key || !uid) return res.status(400).json({ ok:false, error:'key & uid required' });
  db.setLicenseTargetUid(String(key), String(uid));
  const row = db.getLicenseByKey(String(key));
  res.json({ ok:true, row: { ...row, expiresAt: row.expires_at } });
});
/** quick check a uid (admin) */
app.get('/api/admin/licenses/check/:uid', requireAdmin, (req,res)=>{
  const st = db.checkLicense(String(req.params.uid||''));
  const resp = { ...st };
  if ('expires_at' in resp){ resp.expiresAt = resp.expires_at; delete resp.expires_at; }
  res.json(resp);
});

/* ===== Admin UI (static) ===== */
app.use('/admin', express.static(path.join(__dirname, 'admin')));

/* ===== START ===== */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
