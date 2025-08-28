// server.full.js — Express backend for MpBot (Render)
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ===== 3D rotate challenge (used by controller.js) =====
const DEFAULT_TARGET = { thetaDeg: 270, phiDeg: 90 };
const DEFAULT_TOLERANCE = 10;

app.get('/api/challenge', (req, res) => {
  res.json({ target: DEFAULT_TARGET, tolerance: DEFAULT_TOLERANCE });
});

app.get('/api/health', (_, res) => res.json({ ok: true }));

// ===== Legacy/stub endpoints used by background.js & popup =====
// Provide both /api/* and root paths for compatibility

// UI style (getUIpopup)
function alohaHandler(req, res) {
  const { uid } = req.params;
  res.json({ ok: true, name: 'bundle' });
}
app.get('/api/aloha/:uid', alohaHandler);
app.get('/aloha/:uid', alohaHandler);

// Check license
function checkHandler(req, res) {
  const { uid } = req.params;
  res.json({ ok: true, uid, status: 'valid' });
}
app.get('/api/check/:uid', checkHandler);
app.get('/check/:uid', checkHandler);

// Transfer license (route name is '/tranfer' per background.js)
function transferHandler(req, res) {
  const { fromUid } = req.params;
  const toUid = req.query.tranferTo || req.query.transferTo || null;
  res.json({ ok: true, fromUid, toUid });
}
app.get('/api/tranfer/:fromUid', transferHandler);
app.get('/tranfer/:fromUid', transferHandler);

// Report key (no-op stub)
function keyHandler(req, res) {
  const { uid, key } = (req.body || {});
  res.json({ ok: true, plan: 'pro', uid: uid || null, key: key || null, expiresAt: null });
}
app.post('/api/key', keyHandler);
app.post('/key', keyHandler);

// Report stats (no-op stub)
function statHandler(req, res) {
  const { uid, status, event, meta } = (req.body || {});
  res.json({ ok: true });
}
app.post('/api/stat', statHandler);
app.post('/stat', statHandler);

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MpBot backend running on ' + PORT));
