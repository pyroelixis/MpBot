// server.js — MpBot backend (Express) using db.js + Admin UI
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','DELETE','OPTIONS'] }));
app.use(express.json());

// -------- PUBLIC API --------
app.get('/api/challenge', (req, res) => {
  const key = (req.query.key || 'default') + '';
  const t = db.getTarget(key);
  res.set('Cache-Control', 'no-store');
  res.json({ key, target: { thetaDeg: t.thetaDeg, phiDeg: t.phiDeg }, tolerance: t.tolerance });
});

app.post('/api/observe', (req, res) => {
  const { key, thetaDeg, phiDeg } = req.body || {};
  if (typeof key !== 'string' || typeof thetaDeg !== 'number' || typeof phiDeg !== 'number') {
    return res.status(400).json({ ok:false, error:'invalid payload' });
  }
  db.saveObservation(key, thetaDeg, phiDeg);
  const target = db.recomputeTarget(key);
  res.json({ ok:true, target });
});

app.get('/api/health', (_, res) => res.json({ ok:true }));

// -------- LEGACY STUB --------
function alohaHandler(req, res){ res.json({ ok:true, name:'bundle' }); }
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);

function checkHandler(req,res){ res.json({ ok:true, uid:req.params.uid, status:'valid' }); }
app.get('/api/check/:uid', checkHandler);
app.get('/check/:uid', checkHandler);

function transferHandler(req,res){
  res.json({ ok:true, fromUid:req.params.fromUid, toUid:req.query.tranferTo || req.query.transferTo || null });
}
app.get('/api/tranfer/:fromUid', transferHandler);
app.get('/tranfer/:fromUid', transferHandler);

function keyHandler(req,res){
  const { uid, key } = req.body || {};
  res.json({ ok:true, plan:'pro', uid:uid||null, key:key||null, expiresAt:null });
}
app.post('/api/key', keyHandler);
app.post('/key', keyHandler);

function statHandler(req,res){ res.json({ ok:true }); }
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

// -------- ADMIN API --------
function requireAdmin(req, res, next){
  const t = req.headers['x-admin-token'] || req.query.token;
  if (!process.env.ADMIN_TOKEN || t === process.env.ADMIN_TOKEN) return next();
  return res.status(401).json({ ok:false, error:'unauthorized' });
}

app.get('/api/admin/challenges', requireAdmin, (req, res) => {
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

// -------- Admin UI (static) --------
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// -------- START --------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MpBot backend running on ${PORT}`));
