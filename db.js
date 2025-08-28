// ===== เพิ่ม/ผนวกใน db.js =====

const Database = require('better-sqlite3');
const db = new Database('mpbot.db');

// สร้างตาราง (มีอยู่แล้วจะไม่สร้างซ้ำ)
db.exec(`
CREATE TABLE IF NOT EXISTS licenses (
  key        TEXT PRIMARY KEY,          -- ตัวคีย์ไลเซนส์ (เช่น ABCD-... หรือ gen เอง)
  plan       TEXT NOT NULL DEFAULT 'pro',
  uid        TEXT,                      -- ผูกกับ UID ผู้ใช้ (null = ยังไม่ผูก)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,                  -- วันหมดอายุ (null = ไม่หมดอายุ)
  max_devices INTEGER DEFAULT 1,        -- จำกัดจำนวน UID ที่ผูกพร้อมกัน (1 = เครื่องเดียว)
  active     INTEGER NOT NULL DEFAULT 1 -- 1=ใช้งานได้, 0=ปิด/ระงับ
);

CREATE TABLE IF NOT EXISTS license_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,
  action TEXT NOT NULL,                 -- 'activate' | 'transfer' | 'deactivate' | 'renew' | 'set'
  from_uid TEXT,
  to_uid TEXT,
  ts DATETIME DEFAULT CURRENT_TIMESTAMP
);
`);

function getLicenseByKey(key){
  return db.prepare(`SELECT * FROM licenses WHERE key=?`).get(key);
}
function getLicenseByUid(uid){
  return db.prepare(`SELECT * FROM licenses WHERE uid=? AND active=1`).get(uid);
}
function upsertLicense({key, plan='pro', expires_at=null, max_devices=1, active=1}){
  db.prepare(`
    INSERT INTO licenses (key, plan, expires_at, max_devices, active)
    VALUES (@key, @plan, @expires_at, @max_devices, @active)
    ON CONFLICT(key) DO UPDATE SET
      plan=excluded.plan,
      expires_at=excluded.expires_at,
      max_devices=excluded.max_devices,
      active=excluded.active
  `).run({ key, plan, expires_at, max_devices, active });
  return getLicenseByKey(key);
}
function setLicenseTargetUid(key, uid){
  db.prepare(`UPDATE licenses SET uid=? WHERE key=?`).run(uid, key);
  db.prepare(`INSERT INTO license_history (key, action, to_uid) VALUES (?, 'activate', ?)`).run(key, uid);
  return getLicenseByKey(key);
}
function transferLicense(key, fromUid, toUid){
  const row = getLicenseByKey(key);
  if (!row) return null;
  if (row.uid && row.uid !== fromUid) return 'bound-to-other';
  db.prepare(`UPDATE licenses SET uid=? WHERE key=?`).run(toUid, key);
  db.prepare(`INSERT INTO license_history (key, action, from_uid, to_uid) VALUES (?, 'transfer', ?, ?)`)
    .run(key, fromUid || null, toUid || null);
  return getLicenseByKey(key);
}
function deactivateLicense(key){
  db.prepare(`UPDATE licenses SET active=0`).run(key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'deactivate')`).run(key);
  return getLicenseByKey(key);
}
function activateLicense(key){
  db.prepare(`UPDATE licenses SET active=1`).run(key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'activate')`).run(key);
  return getLicenseByKey(key);
}
function renewLicense(key, expires_at){
  db.prepare(`UPDATE licenses SET expires_at=? WHERE key=?`).run(expires_at, key);
  db.prepare(`INSERT INTO license_history (key, action) VALUES (?, 'renew')`).run(key);
  return getLicenseByKey(key);
}
function listLicenses(){
  return db.prepare(`SELECT * FROM licenses ORDER BY created_at DESC`).all();
}
function listLicenseHistory(key, limit=100){
  return db.prepare(`SELECT * FROM license_history WHERE key=? ORDER BY id DESC LIMIT ?`).all(key, limit);
}

function checkLicense(uid){
  // คืนสถานะของ UID นี้
  const row = getLicenseByUid(uid);
  if (!row) return { ok:false, status:'not_found' };

  if (!row.active) return { ok:false, status:'inactive' };

  if (row.expires_at){
    const exp = new Date(row.expires_at).getTime();
    if (Date.now() > exp) return { ok:false, status:'expired', plan: row.plan, expires_at: row.expires_at };
  }
  return { ok:true, status:'valid', plan: row.plan, key: row.key, expires_at: row.expires_at || null };
}

module.exports = {
  // ... ฟังก์ชันเก่าของคุณที่มีอยู่แล้ว ...
  // เพิ่มชุด License
  getLicenseByKey, getLicenseByUid, upsertLicense, setLicenseTargetUid,
  transferLicense, deactivateLicense, activateLicense, renewLicense,
  listLicenses, listLicenseHistory, checkLicense
};
