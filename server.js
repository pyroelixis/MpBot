const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// ค่ามาตรฐาน (คุณปรับได้ทีหลัง)
const DEFAULT_TARGET = { thetaDeg: 270, phiDeg: 90 };
const DEFAULT_TOLERANCE = 10;

// endpoint หลัก
app.get('/api/challenge', (req, res) => {
  res.json({ target: DEFAULT_TARGET, tolerance: DEFAULT_TOLERANCE });
});

// endpoint เช็คสุขภาพ
app.get('/api/health', (_, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('MpBot backend running on ' + PORT));
