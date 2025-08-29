// server.js — MpBot backend (Express) using db.js + Admin UI (Render-ready)
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();

// ===== Configs =====
const OBS_RECOMPUTE = process.env.OBS_RECOMPUTE === '1'; // 1 = เฉลี่ย target อัตโนมัติหลัง observe
const ADMIN_TOKEN   = process.env.ADMIN_TOKEN || null;

// ===== Middlewares =====
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

// ===== Health =====
app.get('/api/health', (_req, res) => res.json({ ok:true }));
// Render ใช้ path นี้ ตรวจทุก ๆ นาที — ควรตอบเป็น text
app.get('/healthz', (_req, res) => res.type('text').send('ok'));

// ===== PUBLIC API =====
// MAX/controller.js จะเรียก endpoint นี้เพื่อดึง target ต่อ key
app.get('/api/challenge', (req, res) => {
  const key = (req.query.key || 'default') + '';
  const t = db.getTarget(key); // { thetaDeg, phiDeg, tolerance }
  res.set('Cache-Control', 'no-store');
  res.json({
    key,
    target: { thetaDeg: t.thetaDeg, phiDeg: t.phiDeg },
    tolerance: t.tolerance
  });
});

// controller.js รายงานมุมที่ “ผ่านจริง” (ใช้บันทึก observation)
app.post('/api/observe', (req, res) => {
  const { key, thetaDeg, phiDeg } = req.body || {};
  if (typeof key !== 'string' || typeof thetaDeg !== 'number' || typeof phiDeg !== 'number') {
    return res.status(400).json({ ok:false, error:'invalid payload: key/thetaDeg/phiDeg required' });
  }
  db.saveObservation(key, thetaDeg, phiDeg);

  let target = null;
  if (OBS_RECOMPUTE) {
    target = db.recomputeTarget(key, 200); // เฉลี่ยจากล่าสุด 200 รายการ
  }
  res.json({ ok:true, target });
});

// ===== LICENSE (public routes ที่ตัว popup/background ใช้) =====
// อัพเซิร์ตคีย์ (สร้าง/อัปเดต)
app.post('/api/key', (req, res) => {
  const { key, plan = 'pro', expires_at = null, max_devices = 1, active = 1 } = req.body || {};
  if (!key) return res.status(400).json({ ok:false, error:'key required' });
  const row = db.upsertLicense({ key, plan, expires_at, max_devices, active });
  res.json({ ok:true, license: row });
});

// ตรวจคีย์ตาม uid (รองรับ auto-bind ครั้งแรกถ้าส่ง ?key=MY-LIC-KEY มา)
app.get('/api/check/:uid', (req, res) => {
  const uid = (req.params.uid || '').trim();
  const licKey = (req.query.key || '').trim() || null;
  if (!uid) return res.status(400).json({ ok:false, error:'uid required' });

  try {
    const result = db.checkLicense({ uid, key: licKey }); // จะ auto-bind ถ้าเหมาะสม
    res.json({ ok:true, ...result });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || 'check failed' });
  }
});

// โยกคีย์ (legacy ชื่อ /tranfer)
app.get('/api/tranfer/:fromUid', (req, res) => {
  const fromUid = (req.params.fromUid || '').trim();
  const toUid   = (req.query.tranferTo || req.query.transferTo || '').trim();
  const key     = (req.query.key || '').trim();
  try {
    const out = db.transferLicense({ key, fromUid, toUid });
    res.json({ ok:true, ...out });
  } catch (e) {
    res.status(400).json({ ok:false, error: e.message || 'transfer failed' });
  }
});

// ===== LEGACY STUB (คงไว้เพื่อเข้ากันได้กับโค้ดเดิมของ aubot) =====
function alohaHandler(_req, res){ res.json({ ok:true, name:'bundle' }); }
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);

function keyHandler(req,res){
  const { uid, key } = req.body || {};
  res.json({ ok:true, plan:'pro', uid:uid||null, key:key||null, expiresAt:null });
}
app.post('/api/key-legacy', keyHandler); // กันชนเผื่อมีโค้ดเก่าเรียก path นี้

function statHandler(_req,res){ res.json({ ok:true }); }
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

// ===== ADMIN GUARD =====
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!ADMIN_TOKEN || t === ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

// ===== ADMIN API: challenges/observations =====
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

// ===== ADMIN API: license =====
app.get('/api/admin/licenses', requireAdmin, (_req, res) => {
  res.json({ ok:true, rows: db.listLicenses() });
});
app.get('/api/admin/licenses/:key/history', requireAdmin, (req, res) => {
  res.json({ ok:true, rows: db.listLicenseHistory(req.params.key + '') });
});

// ===== Admin UI (static) =====
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
