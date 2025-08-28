// server.js — Express backend for MpBot (Render)
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors({ origin: '*', methods: ['GET','POST','OPTIONS'] }));
app.use(express.json());

// ===== 3D rotate challenge (used by controller.js) =====
const DEFAULT_TARGET = {
  thetaDeg: Number(process.env.TARGET_THETA ?? 270),
  phiDeg:   Number(process.env.TARGET_PHI   ?? 90),
};
const DEFAULT_TOLERANCE = Number(process.env.TOLERANCE ?? 10);

app.get('/api/challenge', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({ target: DEFAULT_TARGET, tolerance: DEFAULT_TOLERANCE });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ===== Legacy/stub endpoints used by background.js & popup =====
function alohaHandler(req, res) {
  res.json({ ok: true, name: 'bundle' });
}
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);

function checkHandler(req, res) {
  const { uid } = req.params;
  res.json({ ok: true, uid, status: 'valid' });
}
app.get('/api/check/:uid', checkHandler);
app.get('/check/:uid', checkHandler);

function transferHandler(req, res) {
  const { fromUid } = req.params;
  const toUid = req.query.tranferTo || req.query.transferTo || null; // รองรับสะกดเดิม
  res.json({ ok: true, fromUid, toUid });
}
app.get('/api/tranfer/:fromUid', transferHandler);
app.get('/tranfer/:fromUid', transferHandler);

function keyHandler(req, res) {
  const { uid, key } = (req.body || {});
  res.json({ ok: true, plan: 'pro', uid: uid || null, key: key || null, expiresAt: null });
}
app.post('/api/key', keyHandler);
app.post('/key', keyHandler);

function statHandler(req, res) {
  res.json({ ok: true });
}
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MpBot backend running on ${PORT}`);
});
