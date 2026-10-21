// เซิร์ฟเวอร์แบบยืนเดี่ยว สำหรับรัน pondy-fleet-web บนเครื่องของเราเอง (เช่นคอม avesta)
// แทนที่จะเสียบเข้า /opt/off1 — โครงเหมือน test-kwq-restore.js แต่ session จริง ไม่ใช่ของปลอม
'use strict';
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const express = require('express');
const session = require('express-session');

// เมื่อรันจาก .exe ที่แพ็กด้วย pkg, __dirname ชี้เข้า snapshot อ่านอย่างเดียว — เก็บ config/data
// ที่แก้ไขได้ไว้ข้าง .exe แทน (เหมือนที่ทำใน pondy-console — ดู CLAUDE.md หัวข้อ Packaging)
const DATA_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT) || 8788;

function loadConfig() {
  // ตอน dev ตั้งผ่าน .env ได้ตามเดิม (ดู .env.example) — ค่านี้ชนะเสมอถ้ามีครบ
  if (process.env.FLEET_PASSWORD && process.env.FLEET_SECRET && process.env.SESSION_SECRET) {
    return {
      FLEET_PASSWORD: process.env.FLEET_PASSWORD,
      FLEET_SECRET: process.env.FLEET_SECRET,
      SESSION_SECRET: process.env.SESSION_SECRET,
    };
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    // รันครั้งแรกจากตัวติดตั้ง (ไม่มี .env มาให้) — สุ่มรหัสให้เองครั้งเดียว แล้วเก็บไว้ใช้ซ้ำทุกครั้งถัดไป
    const cfg = {
      FLEET_PASSWORD: crypto.randomBytes(6).toString('hex'),
      FLEET_SECRET: crypto.randomBytes(24).toString('hex'),
      SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
    return cfg;
  }
}

const cfg = loadConfig();
// ต้องตั้งก่อน require('./fleet') เพราะ fleet.js อ่านค่าพวกนี้จาก process.env ตอนโหลดโมดูลครั้งเดียว
process.env.FLEET_SECRET = cfg.FLEET_SECRET;
process.env.FLEET_PASSWORD = cfg.FLEET_PASSWORD;

// error ที่ไม่มีใครจับ = log แล้วออก ให้เซอร์วิส (NSSM/ตัวรันอื่น) สตาร์ตใหม่เอง ดีกว่าค้างในสถานะครึ่ง ๆ กลาง ๆ
process.on('uncaughtException', (e) => { console.error('[fleet] uncaughtException:', e && e.stack || e); setTimeout(() => process.exit(1), 200); });
process.on('unhandledRejection', (e) => { console.error('[fleet] unhandledRejection:', e && e.stack || e); });

const app = express();
const server = http.createServer(app);
// อยู่หลัง cloudflared (ต่อเข้ามาจาก loopback) — เชื่อ X-Forwarded-For เฉพาะจาก loopback เพื่อให้ req.ip เป็น IP จริง
// ของผู้ใช้ ไม่ใช่ 127.0.0.1 ทุกคน (ไม่งั้นคนหนึ่งใส่รหัสผิด 10 ครั้ง = ล็อกทุกคน)
app.set('trust proxy', 'loopback');

app.use(express.urlencoded({ extended: false, limit: '10kb' })); // ฟอร์ม login ที่ /fleet/login
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const sessionMw = session({
  secret: cfg.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  // secure:'auto' = ติด Secure เมื่อเข้าผ่าน https (อุโมงค์) แต่ยังล็อกอินผ่าน http บนวง LAN ได้
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax', secure: 'auto' }, // 30 วัน
});
app.use(sessionMw);

require('./fleet').setupFleet(app, server, sessionMw);

function lanIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const i of ifaces) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return '127.0.0.1';
}

// ผูก 0.0.0.0 (ไม่ใช่แค่ 127.0.0.1) เพื่อให้เครื่องอื่นในวง WiFi/LAN เดียวกันต่อเข้ามาได้ตรง ๆ
// ถ้าใช้ผ่านอุโมงค์อย่างเดียว ตั้ง BIND_HOST=127.0.0.1 เพื่อไม่เปิดพอร์ตให้วง LAN
const WEAK = new Set(['P@ssw0rd', 'pondy', 'pondy-fleet-2026']);
if (WEAK.has(cfg.FLEET_PASSWORD) || WEAK.has(cfg.FLEET_SECRET) || String(cfg.FLEET_SECRET).length < 16) {
  console.warn('⚠️  FLEET_PASSWORD/FLEET_SECRET เป็นค่าที่เดาง่ายหรือสั้นเกินไป — เปลี่ยนใน config.json แล้วตั้ง FLEET_SECRET ในแอปมือถือให้ตรง');
}
server.listen(PORT, process.env.BIND_HOST || '0.0.0.0', () => {
  const ip = lanIP();
  const url = `http://${ip}:${PORT}/fleet`;
  console.log('pondy-fleet-web พร้อมแล้ว');
  console.log(`  ในวง WiFi/LAN เดียวกัน: ${url}`);
  console.log(`  รหัสผ่านเข้าระบบ (login /fleet): ${cfg.FLEET_PASSWORD}`);
  console.log(`  FLEET_SECRET (ตั้งในแอปมือถือให้ตรงกัน): ${cfg.FLEET_SECRET}`);
  // เวลาเปิดเป็น .exe (ดับเบิลคลิก ไม่มี terminal ให้พิมพ์ URL) เปิดเบราว์เซอร์ให้เองเลย
  if (process.pkg && process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
  }
});
