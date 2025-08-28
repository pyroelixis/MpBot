// server.js — MpBot backend (Express) using db.js + Admin UI
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();

// ===== Configs =====
const OBS_RECOMPUTE = process.env.OBS_RECOMPUTE === '1'; // set 1 เพื่อเฉลี่ย target อัตโนมัติหลัง observe

// ===== Middlewares =====
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

// ===== PUBLIC API =====

// controller.js จะเรียก endpoint นี้เพื่อดึง target ต่อ key
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
// หมายเหตุ: จะเฉลี่ย target อัตโนมัติหรือไม่ ขึ้นกับ ENV OBS_RECOMPUTE
app.post('/api/observe', (req, res) => {
  const { key, thetaDeg, phiDeg } = req.body || {};
  if (typeof key !== 'string' || typeof thetaDeg !== 'number' || typeof phiDeg !== 'number') {
    return res.status(400).json({ ok:false, error:'invalid payload: key/thetaDeg/phiDeg required' });
  }
  db.saveObservation(key, thetaDeg, phiDeg);

  let target = null;
  if (OBS_RECOMPUTE) {
    target = db.recomputeTarget(key); // เฉลี่ยจาก observations ตาม logic ใน db.js เดิม
  }

  res.json({ ok:true, target });
});

// ping ใช้เช็คว่าเซิร์ฟเวอร์ทำงาน
app.get('/api/health', (_, res) => res.json({ ok:true }));

// ===== LEGACY STUB (คงไว้เพื่อเข้ากันได้กับโค้ดเดิมของ aubot) =====
function alohaHandler(_req, res){ res.json({ ok:true, name:'bundle' }); }
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);

function checkHandler(req,res){ res.json({ ok:true, uid:req.params.uid, status:'valid' }); }
app.get('/api/check/:uid', checkHandler);
app.get('/check/:uid', checkHandler);

// ระวังสะกดตามเดิม: /tranfer
function transferHandler(req,res){
  res.json({
    ok:true,
    fromUid:req.params.fromUid,
    toUid:req.query.tranferTo || req.query.transferTo || null
  });
}
app.get('/api/tranfer/:fromUid', transferHandler);
app.get('/tranfer/:fromUid', transferHandler);

function keyHandler(req,res){
  const { uid, key } = req.body || {};
  res.json({ ok:true, plan:'pro', uid:uid||null, key:key||null, expiresAt:null });
}
app.post('/api/key', keyHandler);
app.post('/key', keyHandler);

function statHandler(_req,res){ res.json({ ok:true }); }
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

// ===== ADMIN API =====
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || t === process.env.ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

// รายการ target ทั้งหมด (รวม tolerance ปัจจุบัน)
app.get('/api/admin/challenges', requireAdmin, (_req, res) => {
  res.json({ ok:true, rows: db.listChallenges() });
});

// ดูเป้าของ key เดียว
app.get('/api/admin/challenges/:key', requireAdmin, (req, res) => {
  const row = db.getChallenge(req.params.key + '');
  if (!row) return res.status(404).json({ ok:false, error:'not found' });
  res.json({ ok:true, row });
});

// ดึง observations ล่าสุดของ key
app.get('/api/admin/observations/:key', requireAdmin, (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 200), 1000);
  res.json({ ok:true, rows: db.listObservations(req.params.key + '', limit) });
});

// ตั้งค่า target manual ต่อ key
app.post('/api/admin/set-target', requireAdmin, (req, res) => {
  const { key, thetaDeg, phiDeg, tolerance } = req.body || {};
  if (typeof key !== 'string') {
    return res.status(400).json({ ok:false, error:'key required' });
  }
  const tgt = db.setTarget(
    key,
    Number(thetaDeg ?? 0),
    Number(phiDeg   ?? 90),
    Number(tolerance ?? 10)
  );
  res.json({ ok:true, target: tgt });
});

// ลบ key ทั้งชุด (target + observations)
app.delete('/api/admin/keys/:key', requireAdmin, (req, res) => {
  res.json({ ok:true, deleted: db.deleteKey(req.params.key + '') });
});

// ตัด observations เก่า เหลือแค่ล่าสุด n รายการ แล้วคำนวณ target ใหม่
app.post('/api/admin/compact/:key', requireAdmin, (req, res) => {
  const keep = Math.min(Number(req.body?.keep ?? 200), 2000);
  const tgt = db.compactKey(req.params.key + '', keep);
  res.json({ ok:true, kept: keep, target: tgt });
});

// ===== Admin UI (static) =====
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// ===== START =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
