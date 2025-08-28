const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());           // อนุญาตให้ extension เรียกข้ามโดเมน
app.use(express.json());   // รองรับ JSON body

// ===== ค่าเริ่มต้นของโจทย์หมุน 3D =====
const DEFAULT_TARGET = { thetaDeg: 270, phiDeg: 90 };
const DEFAULT_TOLERANCE = 10;

// ===== Endpoint สำหรับ controller.js (โจทย์หมุน 3D) =====
app.get('/api/challenge', (req, res) => {
  res.json({ target: DEFAULT_TARGET, tolerance: DEFAULT_TOLERANCE });
});

// ===== Health check =====
app.get('/api/health', (_, res) => res.json({ ok: true }));

// ====== LICENSING / UI STYLE "STUB" (แทนของเดิมบนเซิร์ฟเวอร์เก่า) ======
// ให้ background.js ของคุณเรียกได้โดยไม่ล้ม และคง flow เดิม
// 1) UI style เดิม (ใช้กับ getUIpopup(uid))
app.get('/api/aloha/:uid', (req, res) => {
  const { uid } = req.params;
  // คืนชื่อ style คงที่ (ปรับได้ตามที่ background.js ของคุณใช้)
  res.json({ ok: true, name: 'bundle' });
});

// 2) ลงทะเบียน/ตรวจ key (สตับ) — ตอบ ok:true เสมอ
app.post('/api/key', (req, res) => {
  // ตัวอย่างรับ: { uid, key } ใน req.body — คุณจะตรวจจริง/บันทึก DB ทีหลังก็ได้
  res.json({ ok: true, plan: 'pro', expiresAt: null });
});

// 3) เก็บสถิติ/เทเลเมตริก (สตับ) — ตอบ ok:true เสมอ
app.post('/api/stat', (req, res) => {
  // ตัวอย่างรับ: { uid, event, meta } — จะ log หรือเก็บ DB ภายหลังก็ได้
  res.json({ ok: true });
});

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MpBot backend running on ' + PORT));
