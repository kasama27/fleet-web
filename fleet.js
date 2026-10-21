// Fleet control v2 — adds: วนเก็บ+เจน+ลง Shopee (looppost) + จำนวนบัญชี (accounts),
// pause/resume + loop commands wired to the dashboard, and a "posted" (ลง) counter.
// Drop-in replacement for the v1 fleet.js. Wired from server.js:
//   require('./fleet').setupFleet(app, server, sessionMiddleware)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

// เมื่อรันจาก .exe ที่แพ็กด้วย pkg, __dirname ชี้เข้า snapshot อ่านอย่างเดียว (เขียนไฟล์ไม่ได้)
// ต้องเก็บ data/ ที่แก้ไขได้ไว้ข้าง .exe แทน — public/ ยังอ่านจาก __dirname ได้ตามปกติ (อ่านอย่างเดียวพอ)
const DATA_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
if (process.pkg) fs.mkdirSync(path.join(DATA_DIR, 'data'), { recursive: true });
const META_FILE = path.join(DATA_DIR, 'data', 'devices.json');
const TPL_FILE = path.join(DATA_DIR, 'data', 'setting-templates.json');

// ค่าที่ยอมให้ตั้งจากเว็บ (ตรงกับ whitelist ฝั่งแอปใน FleetAgent.applySettings) — คีย์อื่นโดนทิ้ง
// ก่อนส่งเข้ามือถือเสมอ โดยเฉพาะ API keys / token ที่ห้ามวิ่งผ่านช่องนี้เด็ดขาด
// ชื่อผู้ใช้ Shopee ประจำ "ช่อง" ที่ 1..3 ของเครื่อง (แอป ver>=9 ขึ้นไปถึงจะรับ/ส่งคีย์นี้).
// ที่ต้องตั้งจากเว็บได้ เพราะตัวนับโพสผูกกับ *ช่อง* ไม่ได้ผูกกับ *ชื่อ*: ถ้าเครื่องสลับบัญชีแล้ว
// verify ไม่ชัด (เครื่องเชื่อว่าสลับสำเร็จทั้งที่ Shopee ไม่ขยับ) ยอดวันนี้จะไปเกาะผิดช่อง แล้ว
// วิธีย้ายยอดกลับคือสลับชื่อระหว่างสองช่อง — เดิมทำได้เฉพาะคนที่ถือเครื่องอยู่ตรงนั้น
const ACCOUNT_NAME_KEYS = ['accountName1', 'accountName2', 'accountName3'];
// สวิตช์เปิด/ปิดการโพสต์รายช่อง (แอป ver>=12) — คู่กับ ACCOUNT_NAME_KEYS: ปิดช่องที่บัญชีโดนตรวจ
// โดยไม่ต้องลบชื่อทิ้ง (ลบชื่อ = เสียการสลับ+ยืนยันด้วยชื่อ แล้วยอดจะไปเกาะผิดช่องอีก)
const ACCOUNT_ENABLED_KEYS = ['accountEnabled1', 'accountEnabled2', 'accountEnabled3'];
const SAFE_SETTING_KEYS = [
  'dailyLimit', 'hourlyLimit', 'postAccountCount', 'postBufferTarget', 'videoTimeoutMinutes',
  'deleteClipAfterPost', 'videoTemplate', 'imageTemplate', 'defaultVoiceScript',
  'voiceOverBannedWords', 'voiceOverReplacements',
  // 'WEB' (WebView ในแอป) หรือ 'APP' (แอป Google Flow) — เครื่องเป็นคนตรวจค่า: ถ้าส่ง APP ไปเครื่อง
  // ที่ไม่ได้ลง whisk เครื่องจะปฏิเสธและตอบ warn กลับ (ไม่ปล่อยให้ค้างบน backend ที่รันไม่ได้)
  'flowBackend',
  // โมเดลรูปภาพของ Flow: 'NANO_BANANA_2' (ฟรี 0 เครดิต) หรือ 'NANO_BANANA_PRO' — เครื่องตรวจค่าเอง
  // อีกชั้น ค่าที่ไม่รู้จักจะถูกตอบกลับเป็น skipped (ไม่เงียบ ๆ ตกไปใช้ตัวฟรีแบบดูเหมือนสำเร็จ)
  'imageModel',
  // เก็บสินค้าเข้าคลังทีเดียวกี่หน้า (1..10 — เครื่อง clamp เองอีกชั้น) ความลึกที่เหมาะสมต่างกันไป
  // ตามคีย์เวิร์ดของแต่ละเครื่อง (คีย์ที่ของน้อยต้องตื้น ไม่งั้นเสียเวลาไล่หน้าที่ไม่มีของ)
  'collectMaxPages',
  // เจอ Flow หน้าขาว → ปัดการ์ดทิ้งใน recents แล้วเปิดใหม่ (true/false) ต้องตั้งจากเว็บได้ เพราะท่านี้
  // พึ่ง UI recents ของ launcher — ROM/launcher อัปเดตทีอาจพังเฉพาะบางเครื่อง ซึ่งเป็นเครื่องที่เดินไปกดไม่ได้พอดี
  'flowRecentsSwipeEnabled',
  ...ACCOUNT_NAME_KEYS,
  ...ACCOUNT_ENABLED_KEYS,
];
const pickSafeSettings = (s) => {
  const out = {};
  if (s && typeof s === 'object') for (const k of SAFE_SETTING_KEYS) if (k in s) out[k] = s[k];
  return out;
};

// ค่าที่ "ผูกกับตัวเครื่อง" ไม่ใช่ครีเอทีฟ — เทมเพลตใช้ร่วมกันหลายเครื่องที่ล็อกอินไม่เท่ากัน
// การหมุนเทมเพลตทุก 15 นาทีจึงห้ามดันค่าพวกนี้ทับ (เคสจริง: เทมเพลตทุกอันติด
// postAccountCount:2 มาตั้งแต่ตอนเซฟ → กบตั้ง 3 แล้วโดนรีเซ็ตกลับเป็น 2 ทุกควอเตอร์)
// flowBackend ก็ผูกกับตัวเครื่องล้วน ๆ — บางเครื่องไม่ได้ลงแอป Google Flow เลย ถ้าเทมเพลตที่เซฟ
// จากเครื่องที่ลงไว้ไปหมุนทับทั้งฝูงทุก 15 นาที เครื่องที่ไม่มี whisk จะโดนสลับซ้ำ ๆ ทุกควอเตอร์
// (เครื่องปฏิเสธก็จริง แต่มันจะเด้ง warn ทุกครั้ง และเครื่องที่ "มี" whisk จะโดนดึงกลับ WEB ทันที
// หลังคนตั้งเป็น APP) — เคสเดียวกับ postAccountCount เป๊ะ ๆ
// imageModel อยู่ในนี้ด้วยเพราะเป็น "ค่าที่มีค่าใช้จ่าย": Nano Banana 2 ฟรี แต่ Pro ยังไม่ยืนยันราคา
// เทมเพลตที่เผลอเซฟไว้ตอนเปิด Pro จะดัน Pro ทับทั้งฝูงทุก 15 นาทีโดยไม่มีใครสั่ง = จ่ายเงินโดยไม่รู้ตัว
// ตั้งจากช่อง ⚙ ต่อเครื่องได้ปกติ (applysettings) แค่ห้ามให้การหมุนเทมเพลตแตะ
// ชื่อบัญชีคือค่าเฉพาะเครื่องที่สุดในบรรดาค่าทั้งหมด — แต่ละเครื่องล็อกอินคนละบัญชีกันหมด
const PER_DEVICE_KEYS = ['postAccountCount', 'flowBackend', 'imageModel',
  ...ACCOUNT_NAME_KEYS, ...ACCOUNT_ENABLED_KEYS];
const rotatable = (s) => {
  const out = pickSafeSettings(s);
  for (const k of PER_DEVICE_KEYS) delete out[k];
  return out;
};

// เทมเพลตตั้งค่า: { name: { settings: {...}, updatedAt } } — เก็บกลางบนเซิร์ฟเวอร์ ใช้ได้ทุกเครื่อง
function loadTemplates() {
  try { return JSON.parse(fs.readFileSync(TPL_FILE, 'utf8')) || {}; } catch { return {}; }
}
// เขียน tmp แล้ว rename ทับ (atomic) + log error แทนการกลืน — เขียนครึ่งทางแล้วไฟดับ loader จะคืน {} แล้วข้อมูลหาย
function atomicWrite(file, text) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    return true;
  } catch (e) { console.error('[fleet] เขียนไฟล์ไม่สำเร็จ', file, e && e.message); return false; }
}
const saveTemplates = (t) => atomicWrite(TPL_FILE, JSON.stringify(t, null, 2));

// วนเทมเพลตทุกชั่วโมง: { deviceId: { on, names:[...], idx, cur } } — ต้นชั่วโมงดันเทมเพลตตัวถัดไป
// เข้าเครื่องผ่าน applysettings เดิม (แอปไม่ต้องรู้จักฟีเจอร์นี้เลย)
const ROT_FILE = path.join(DATA_DIR, 'data', 'template-rotation.json');
function loadRot() {
  try { return JSON.parse(fs.readFileSync(ROT_FILE, 'utf8')) || {}; } catch { return {}; }
}
const saveRot = (r) => atomicWrite(ROT_FILE, JSON.stringify(r, null, 2));

// selector overrides — ค่ามาจาก "ไฟล์บนเซิร์ฟ" ที่คนดูแลโค้ด (Claude) เช็ค+แก้+deploy เท่านั้น.
// คนหน้าเว็บ "พิมพ์เองไม่ได้" — มีแค่ปุ่มกดส่งค่านี้เข้าเครื่อง (กันใส่ค่ามั่วแล้วพังทั้งฝูง).
// แก้ marker ที่ Flow เปลี่ยน = แก้ data/selector-presets.json แล้ว deploy.
const SEL_PRESETS_FILE = path.join(__dirname, 'data', 'selector-presets.json');
function loadSelPresets() {
  try { return JSON.parse(fs.readFileSync(SEL_PRESETS_FILE, 'utf8')) || {}; } catch { return {}; }
}
// ---------------- คลังคีย์เวิร์ด (คำที่กด "บันทึก" ไว้ใช้ซ้ำ) ----------------
// เก็บไว้กลางบนเซิร์ฟเวอร์ ไม่ใช่ localStorage/autofill ของเบราว์เซอร์ — ทีมเปิดแดชบอร์ดกันคนละ
// เครื่อง/คนละเบราว์เซอร์ ใครบันทึกหรือลบคำ ทุกคนต้องเห็นตรงกันทันที (เหมือนเทมเพลตตั้งค่า)
// รูปแบบ: [{ w:'ครีมบำรุง', mode:'PRODUCT'|'SHOP', dev:'<deviceId>', at:ms }] เรียงคำที่บันทึกล่าสุดขึ้นก่อน
// เก็บโหมดติดคำไปด้วย เพราะ "ร้าน:X" กับ "สินค้า:X" เป็นคนละงาน (เหมือนคิวคีย์เวิร์ดที่มี modes รายคำ)
// `dev` = เครื่องที่กด "☆ บันทึก" (2026-08-21): เดิมคลังเป็นกองกลางกองเดียว ทุกการ์ดโชว์คำของทุก
// เครื่องปนกันหมด จนหาคำของเครื่องตัวเองไม่เจอ. ตอนนี้แต่ละการ์ดเห็นคำของตัวเองเป็นค่าตั้งต้น
// (กดสลับดู "ทุกเครื่อง" ได้) — คำเก่าที่บันทึกไว้ก่อนมี field นี้ dev='' = ของกลาง โชว์ทุกการ์ดเหมือนเดิม
const KWLIB_FILE = path.join(DATA_DIR, 'data', 'keywords.json');
const KWLIB_MAX = 200;
const KWLIB_PER_DEV = 50;         // คำต่อเครื่อง — กันเครื่องที่บันทึกรัวเบียดคำของเครื่องอื่นหล่นออกจากคลัง
function loadKwLib() {
  try {
    const raw = JSON.parse(fs.readFileSync(KWLIB_FILE, 'utf8'));
    const arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.list) ? raw.list : []);
    const out = [], seen = new Set();
    for (const it of arr) {
      const w = String((it && typeof it === 'object' ? it.w : it) || '').trim().slice(0, 60);
      const mode = (it && it.mode === 'SHOP') ? 'SHOP' : 'PRODUCT';
      const dev = String((it && it.dev) || '').slice(0, 64);
      const k = dev + '|' + mode + '|' + w;
      if (!w || seen.has(k)) continue;
      seen.add(k);
      out.push({ w, mode, dev, at: (it && +it.at) || 0 });
    }
    return trimKwLib(out);
  } catch { return []; }
}
// ตัดคลังให้อยู่ในโควตา: นับแยกรายเครื่อง (ลิสต์เรียงใหม่→เก่าอยู่แล้ว คำเก่าสุดของเครื่องนั้นหล่นก่อน)
function trimKwLib(l) {
  const n = new Map(), out = [];
  for (const it of l) {
    const k = it.dev || '';
    const c = (n.get(k) || 0) + 1;
    n.set(k, c);
    if (c <= KWLIB_PER_DEV) out.push(it);
  }
  return out.slice(0, KWLIB_MAX);
}
const saveKwLib = (l) => atomicWrite(KWLIB_FILE, JSON.stringify(l, null, 2));

const ENROLL_SECRET = process.env.FLEET_SECRET || 'pondy-fleet-2026';
// เครื่องส่วนตัวที่ไม่ให้ใครสั่งจากแดชบอร์ดถ้าไม่รู้รหัส (ปอนขอ 2026-08-20). เช็คที่ฝั่งเซิร์ฟเวอร์
// ไม่ใช่แค่ซ่อนปุ่มบนเว็บ — ซ่อนปุ่มอย่างเดียวเปิด devtools ก็ยิงได้ ไม่นับเป็นการล็อก
const LOCKED_DEVICE = process.env.PONDY_LOCK_DEVICE || '98f270a08b653e05';
const LOCK_PIN = process.env.PONDY_LOCK_PIN || '2580';
const FLEET_PASSWORD = process.env.FLEET_PASSWORD || 'pondy';

// fail-loud ถ้า prod ไม่ได้ตั้ง secret (กันใช้รหัส default ที่รู้กันทั้งโลก)
if (process.env.NODE_ENV === 'production' && (!process.env.FLEET_PASSWORD || !process.env.FLEET_SECRET)) {
  console.error('⚠️  [fleet] FLEET_PASSWORD/FLEET_SECRET ไม่ได้ตั้งใน production — กำลังใช้ค่า default ที่ไม่ปลอดภัย');
}

// เทียบรหัสแบบ constant-time กัน timing attack (รองรับความยาวต่างกันโดยไม่รั่วเวลา)
function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) { crypto.timingSafeEqual(ba, ba); return false; }
  return crypto.timingSafeEqual(ba, bb);
}

// meta = { deviceId: { name, collected, generated, posted, daily:{date,count} } }.
// Migrates the old {deviceId:"name"} string format and fills missing fields.
function loadMeta() {
  try {
    const raw = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const out = {};
    for (const [id, v] of Object.entries(raw)) {
      out[id] = (typeof v === 'string')
        ? { name: v, collected: 0, generated: 0, posted: 0, daily: { date: '', count: 0 }, postedDay: '', postedDayBase: 0, kw: '', searchMode: '' }
        : {
            name: v.name || '', collected: v.collected || 0, generated: v.generated || 0,
            posted: v.posted || 0, daily: v.daily || { date: '', count: 0 },
            // ตัวสะสม "ลง" (posted) จากยอดราย acc วันนี้: postedDay=วันที่กำลังสะสม, postedDayBase=ยอดวันนี้ที่บวกเข้าไปแล้ว
            postedDay: v.postedDay || '', postedDayBase: v.postedDayBase || 0, lastDone: v.lastDone || 0,
            // คีย์เวิร์ด+โหมดที่พิมพ์ไว้บนเว็บ (จำต่อเครื่อง เปิดจากเบราว์เซอร์/มือถือไหนก็เห็นเหมือนกัน)
            // lastAction/lastRounds = คำสั่งล่าสุดที่สั่งจากเว็บ — ใช้ตอน "เพิ่มคำเข้าคิว" ระหว่างรัน
            kw: v.kw || '', searchMode: v.searchMode || '', lastAction: v.lastAction || '', lastRounds: v.lastRounds || 0,
            // คิวคีย์เวิร์ดที่เพิ่งถูกยกเลิก (กดหยุด/พัก) — ไว้ให้กด "เอาคิวเดิมกลับมา" บนเว็บ
            lastKwq: (v.lastKwq && Array.isArray(v.lastKwq.list) && v.lastKwq.list.length) ? v.lastKwq : null,
            // คำที่หมดสต็อกไปแล้ว ("PRODUCT|ครีม") — ไม่เอากลับเข้าคิวอีกตอนกดกู้คิว
            kwDone: Array.isArray(v.kwDone) ? v.kwDone : [],
            // คิวที่ "กำลังวิ่ง" ตอนบันทึกล่าสุด — เซิร์ฟกู้เองตอนเครื่องทักกลับมา ไม่ต้องมีคนกด
            liveKwq: (v.liveKwq && Array.isArray(v.liveKwq.list) && v.liveKwq.list.length) ? v.liveKwq : null,
            // stopCount ตอนบันทึกล่าสุด — เทียบตอนกลับมาว่ามีคนกดหยุดที่เครื่องช่วงเซิร์ฟดับไหม
            stopCount: (typeof v.stopCount === 'number') ? v.stopCount : null,
          };
    }
    return out;
  } catch { return {}; }
}
// เขียนไฟล์ชั่วคราวแล้ว rename ทับ: rename เป็น atomic บนไฟล์ระบบเดียวกัน ไฟดับกลางทางแล้วจะได้
// ไฟล์เก่าครบ ๆ ไม่ใช่ JSON ครึ่งใบที่ loadMeta อ่านไม่ออกแล้วคืน {} = สถิติทุกเครื่องหายเกลี้ยง
const saveMeta = (m) => { atomicWrite(META_FILE, JSON.stringify(m, null, 2)); };
// Bangkok (UTC+7) calendar date YYYY-MM-DD — daily clip counts reset on this.
const bkkDate = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);

// ---------------- ยอด Affiliate รายบัญชี (เก็บประวัติ) ----------------
// เครื่องแนบยอดที่อ่านจากหน้า "โปรแกรม Affiliate" มาใน status.acc[].aff ทุก heartbeat อยู่แล้ว
// (date = วันของยอด, month = ยอดสะสมเดือนนี้) แต่เดิมเซิร์ฟถือไว้แค่ใน memory → รีสตาร์ตแล้วหาย และไม่มี
// ประวัติรายวันเลย. ที่นี่จดลงไฟล์แยกตาม "ชื่อบัญชี" (ไม่ใช่ช่อง/เครื่อง — บัญชีย้ายเครื่องได้ ยอดต้องตามชื่อ)
// รูปแบบ: { accounts: { name: { dev, slot, lastAt, err:{msg,at}|null,
//   days: { 'YYYY-MM-DD': {clicks,orders,sold,sales,comm,buyers,at} },
//   months: { 'YYYY-MM': {range,clicks,orders,sold,sales,comm,buyers,at} } } } }
// ค่าเก็บเป็นสตริงตามที่ Shopee โชว์ ("3.7พัน") — แปลงเป็นตัวเลขตอนแสดงผล จะได้ไม่เสียข้อมูลดิบ
const AFF_FILE = path.join(DATA_DIR, 'data', 'affstats.json');
const AFF_FIELDS = ['clicks', 'orders', 'sold', 'sales', 'comm', 'buyers'];
const AFF_DAYS_MAX = 120;         // ต่อบัญชี — พอดูย้อนหลัง ~4 เดือน ไฟล์ไม่บวมไม่รู้จบ
function loadAff() {
  try {
    const raw = JSON.parse(fs.readFileSync(AFF_FILE, 'utf8'));
    return (raw && typeof raw.accounts === 'object' && raw.accounts) ? raw : { accounts: {} };
  } catch { return { accounts: {} }; }
}
const saveAff = (a) => {
  try {
    const tmp = AFF_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(a, null, 2));
    fs.renameSync(tmp, AFF_FILE);
  } catch (e) {}
};
// "18-09-2026" → "2026-09-18" (รูปแบบที่แอปส่งมา) — อย่างอื่นคืน ''
const affIsoDate = (s) => {
  const m = /^(\d{1,2})-(\d{1,2})-(\d{4})$/.exec(String(s || '').trim());
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : '';
};
const pickAff = (o, at) => {
  const out = { at: at || 0 };
  for (const k of AFF_FIELDS) out[k] = String((o && o[k]) ?? '');
  return out;
};
// จดยอดจาก status.acc ของเครื่องหนึ่งลง store — คืน true ถ้ามีอะไรเปลี่ยน (ให้คนเรียกเซฟ/กระจาย)
function recordAff(store, deviceId, acc) {
  if (!Array.isArray(acc)) return false;
  let changed = false;
  for (const a of acc) {
    const name = String((a && a.name) || '').trim();
    if (!name) continue;
    const rec = store.accounts[name] || (store.accounts[name] = { dev: deviceId, slot: a.i || 0, lastAt: 0, err: null, days: {}, months: {} });
    if (rec.dev !== deviceId || rec.slot !== (a.i || 0)) { rec.dev = deviceId; rec.slot = a.i || 0; changed = true; }
    const aff = a.aff;
    if (aff && aff.at && aff.at !== rec.lastAt) {
      const day = affIsoDate(aff.date);
      if (day) {
        rec.days[day] = pickAff(aff, aff.at);
        const keys = Object.keys(rec.days).sort();
        for (const k of keys.slice(0, Math.max(0, keys.length - AFF_DAYS_MAX))) delete rec.days[k];
      }
      const mo = aff.month;
      // เดือนของยอดสะสม = วันท้ายของช่วง ("01-09-2026 - 19-09-2026") ถ้าไม่มีช่วง ใช้วันของยอดรายวัน
      const end = mo && affIsoDate(String(mo.range || '').split(' - ').pop());
      const mkey = (end || day).slice(0, 7);
      if (mo && mkey) rec.months[mkey] = { range: String(mo.range || ''), ...pickAff(mo, aff.at) };
      rec.lastAt = aff.at;
      changed = true;
    }
    // affErr = ครั้งล่าสุดที่อ่านไม่สำเร็จ. เก็บเฉพาะที่ใหม่กว่ายอดที่อ่านได้ (อ่านได้ทีหลัง = error เก่าหมดความหมาย)
    const err = (a.affErr && a.affErr.at > rec.lastAt) ? { msg: String(a.affErr.msg || ''), at: a.affErr.at } : null;
    if (JSON.stringify(err) !== JSON.stringify(rec.err)) { rec.err = err; changed = true; }
  }
  return changed;
}

// ---------------- คิวหลายคีย์เวิร์ด (ทำฝั่งเซิร์ฟล้วน ๆ — แอปยังรับ keyword เดียวเหมือนเดิม) --------
// เว็บส่ง keywords:[...] มาได้หลายคำ. เซิร์ฟยิงเข้าเครื่องทีละคำ แล้วเฝ้า status:
//  - looppost: คำไหนหมดสต็อก แอปจะ "สลับไป browse ทั่วไป" = ยังรันอยู่แต่ status.keyword ว่าง
//    → เราสั่ง cancel แล้วยิงคำถัดไปแทน (ต้อง cancel ก่อน เพราะ PipelineForegroundService
//      "ignore duplicate START while a run is already active" — ยิงซ้อนไปเฉย ๆ แอปจะทิ้งคำสั่ง)
//  - loop / เก็บ / รัน / เจน: พอคำนั้นหมด รอบจะจบเอง (running=false) → ยิงคำถัดไปได้เลย
// คำสุดท้ายหมด = ปล่อยตามพฤติกรรมเดิมของแอป (looppost browse ต่อ / โหมดอื่นจบ) แล้วลบคิวทิ้ง
const KWQ_ACTIONS = ['collect', 'run', 'loop', 'looppost', 'generate'];
const KWQ_MAX = 20;               // กันวางลิสต์ยาวเป็นพัน
// ช่องแรกปลอมที่ kwadd ใส่ไว้แทน "browse ทั่วไป" — ไม่ใช่คำจริง ห้ามเก็บ/ห้ามกู้
const KWQ_PLACEHOLDER = 'ทั่วไป';
// ต่อคำเข้าคิว: ข้ามคำซ้ำ (คำ+โหมดเดียวกัน), คิวเต็มแล้วคืนคำที่เหลือกลับไปให้เว็บ ไม่ทิ้งเงียบ
function kwqAppend(q, pairs, modeOf) {
  let added = 0; const left = [];
  for (const [w, md] of pairs) {
    // ช่องแรกที่เป็น placeholder ไม่ใช่คำจริง — คนพิมพ์คำว่า "ทั่วไป" มาต้องเข้าคิวได้
    if (q.list.some((v, i) => v === w && modeOf(q, i) === md
      && !(i === 0 && v === KWQ_PLACEHOLDER))) continue;
    if (q.list.length >= KWQ_MAX) { left.push([w, md]); continue; }
    q.list.push(w); q.modes.push(md); added++;
  }
  return { added, left };
}
const KWQ_BLANK_HITS = 3;         // ต้องเห็น status "คีย์ว่างทั้งที่ยังรัน" 3 ครั้งติดถึงเชื่อ (กัน a11y/สถานะแวบ)
const KWQ_ARM_MS = 120_000;       // และต้องผ่านไป 2 นาทีหลังส่งคำสั่ง — ช่วงเพิ่งสตาร์ทยังไม่มี job คีย์ก็ว่าง
const KWQ_STOP_RETRY_MS = 120_000; // สั่งหยุดแล้วยังไม่หยุด (เจนวิดีโอค้างอยู่) → สั่งซ้ำ
// เห็น running=false ต้องติดกัน 3 ครั้ง (heartbeat 20s = ~40-60s) ถึงเชื่อว่า "รอบจบเอง"
// 2026-08-21: เชื่อครั้งเดียวทำให้ "Denso รถ" โดนข้ามทั้งที่ยังมีของ — แอปแค่รีสตาร์ต/WS หลุดแวบเดียว
const KWQ_IDLE_HITS = 3;
// และหลังเครื่องเพิ่ง register ใหม่ (แอปรีสตาร์ต / WS หลุดแล้วต่อกลับ) ห้ามเชื่อ running=false เลย
// จนกว่าจะเห็นมันรันอีกครั้ง หรือครบเวลานี้ — watchdog ในแอปใช้เวลาถึง 90s กว่าจะปลุกลูปกลับมา
// (FleetAgent.WATCHDOG_MS) ระหว่างนั้นเครื่องรายงาน running=false ทุก 20s ตามปกติ
const KWQ_REG_GRACE_MS = 180_000;
// แอป ver>=10 ส่ง `stopCount` = จำนวนครั้งที่ "คนกดหยุดที่เครื่องเอง" (ปุ่มลอย ⛔ / ⛔ หยุดทำงาน /
// ปุ่มยกเลิกใน notification) — cancel ที่เซิร์ฟสั่งเองไม่นับ. เห็นตัวเลขนี้เพิ่ม = คนสั่งหยุด ไม่ใช่
// รอบจบ → เก็บคิวแล้วเลิกยุ่งกับเครื่อง. ก่อนมีฟิลด์นี้เซิร์ฟมีแต่ running=false ให้เดา ซึ่งหน้าตา
// เหมือนรอบจบเป๊ะ เลยยิงคำถัดไปทุกครั้งที่คนกดหยุด (21 ส.ค. 2026: คิว 4 คำโดนไล่จนหมดคำละ "เก็บ 1")
// เช็คด้วย typeof ไม่ใช่ ver — ฟิลด์มา = ใช้ได้, ไม่มา = แอปเก่า พฤติกรรมเดิมทุกอย่าง (ดู manualStopOnStatus)

// "ครีม, ลิปสติก\nน้ำหอม" → ['ครีม','ลิปสติก','น้ำหอม'] (ตัดซ้ำ/ช่องว่าง, จำกัดจำนวน+ความยาว)
function parseKeywords(m) {
  const raw = Array.isArray(m.keywords) ? m.keywords : String(m.keyword || '').split(/[,;\n]/);
  const out = [], seen = new Set();
  for (const k of raw) {
    const s = String(k == null ? '' : k).trim().slice(0, 60);
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out.slice(0, KWQ_MAX);
}

function setupFleet(app, server, sessionMw) {
  const meta = loadMeta();
  let kwLib = loadKwLib();          // คลังคีย์เวิร์ดที่ใช้ร่วมกันทั้งทีม (data/keywords.json)
  const devices = new Map();        // deviceId -> { ws, model, status, lastSeen, lastState, lastProduct, lastPostedKey, a11y }
  const panels = new Set();
  // คำสั่งที่สั่งตอนเครื่องออฟไลน์: deviceId -> { payload, at } ส่งตอน register ถ้ายังไม่เกิน TTL (อยู่ในหน่วยความจำ)
  const pendingCmds = new Map();
  const PENDING_TTL_MS = 10 * 60 * 1000;
  // ---- ประวัติเหตุการณ์ (data/events.jsonl) + คลิปรายชั่วโมง (data/hourly.json) ----
  // เดิมมีแค่ตัวนับสะสมกับยอดวันนี้ — ย้อนดูไม่ได้ว่าเครื่องหลุด/ค้างตอนไหน หรือช่วงไหนของวันผลิตได้เท่าไร
  // events: append-only JSONL เก็บ 500 รายการล่าสุดในหน่วยความจำ; hourly: { 'YYYY-MM-DDTHH'(เวลาไทย): { deviceId:{g,p} } } เก็บ 14 วัน
  const EV_FILE = path.join(DATA_DIR, 'data', 'events.jsonl');
  const HOUR_FILE = path.join(DATA_DIR, 'data', 'hourly.json');
  const EV_KEEP = 500, EV_MAX_BYTES = 1_000_000, HOUR_KEEP = 14 * 24;
  let events = (() => {
    try {
      return fs.readFileSync(EV_FILE, 'utf8').split('\n').filter(Boolean).slice(-EV_KEEP)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    } catch { return []; }
  })();
  let evWrites = 0;
  const logEvent = (id, kind, msg) => {
    const ev = { t: Date.now(), id: String(id || ''), kind, msg: String(msg || '').slice(0, 120) };
    events.push(ev);
    if (events.length > EV_KEEP + 100) events = events.slice(-EV_KEEP);
    try {
      fs.appendFileSync(EV_FILE, JSON.stringify(ev) + '\n');
      // ไฟล์โตเกินกำหนด → เขียนใหม่เหลือแต่รายการล่าสุด (เช็คทุก 100 รายการ ไม่ stat ทุกครั้ง)
      if (++evWrites % 100 === 0 && fs.statSync(EV_FILE).size > EV_MAX_BYTES) {
        atomicWrite(EV_FILE, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
      }
    } catch (e) { console.error('[fleet] เขียน events ไม่สำเร็จ:', e && e.message); }
    for (const p of panels) if (p.readyState === 1) { try { p.send(JSON.stringify({ type: 'event', ev })); } catch {} }
  };
  const hourly = (() => { try { return JSON.parse(fs.readFileSync(HOUR_FILE, 'utf8')) || {}; } catch { return {}; } })();
  const bkkHour = () => new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 13);
  let hourDirty = false, hourTimer = null;
  const hourlySummary = () => Object.keys(hourly).sort().slice(-24).map((k) => {
    let g = 0, p = 0;
    for (const v of Object.values(hourly[k])) { g += v.g || 0; p += v.p || 0; }
    return { k, g, p };
  });
  const bumpHour = (id, f, n = 1) => {
    const k = bkkHour();
    const slot = (hourly[k] || (hourly[k] = Object.create(null)));
    const x = (slot[id] || (slot[id] = { g: 0, p: 0 }));
    x[f] += n;
    hourDirty = true;
    if (hourTimer) return;
    hourTimer = setTimeout(() => {   // รวมการเขียน — ไม่เขียนไฟล์ทุกคลิป
      hourTimer = null;
      if (!hourDirty) return;
      hourDirty = false;
      for (const old of Object.keys(hourly).sort().slice(0, -HOUR_KEEP)) delete hourly[old];
      atomicWrite(HOUR_FILE, JSON.stringify(hourly));
      const msg = JSON.stringify({ type: 'hourly', hourly: hourlySummary() });
      for (const p of panels) if (p.readyState === 1) { try { p.send(msg); } catch {} }
    }, 5000);
  };
  const PENDING_ACTIONS = new Set(['cancel', 'pause', 'resume', 'loop', 'looppost', 'collect', 'run', 'generate', 'postonly', 'post', 'switchaccount']);

  // maxPayload: ค่าเริ่มต้นของ ws คือ 100 MiB. agent ส่งภาพ shot (base64) มาด้วยเลยให้ 4 MiB; แดชบอร์ดส่งแต่คำสั่งสั้น ๆ
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const panelWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

  // deviceId มาจากเครือข่าย — กัน '__proto__' / ชื่อยาวผิดปกติ ก่อนเอาไปเป็นคีย์ของ meta
  const validId = (id) => typeof id === 'string' && /^[\w.:-]{1,64}$/.test(id) && !['__proto__', 'constructor', 'prototype'].includes(id);
  // ครอบ handler ของ ws: ข้อความเสียข้อความเดียวต้องไม่ทำให้ทั้งโปรเซส (และทุกเครื่อง) ล่ม
  const safe = (fn) => (...a) => { try { return fn(...a); } catch (e) { console.error('[fleet] handler error:', e && e.stack || e); } };

  const metaOf = (id) => (meta[id] || (meta[id] = { name: '', collected: 0, generated: 0, posted: 0, daily: { date: '', count: 0 }, postedDay: '', postedDayBase: 0, kw: '', searchMode: '', lastKwq: null, liveKwq: null, stopCount: null }));
  const todayCount = (id) => { const dl = metaOf(id).daily; return dl.date === bkkDate() ? dl.count : 0; };

  // สะสม "ลง" (posted ทั้งหมด) จากยอดราย acc ของวันนี้ที่มือถือ v2 ส่งมา (acc[].today รวมกัน = โพสวันนี้).
  // บวกเฉพาะส่วนที่เพิ่มขึ้น (delta) วันใหม่รีเซ็ต base. ทนต่อ restart เพราะ posted/postedDay/postedDayBase อยู่ใน devices.json.
  const accruePosted = (id, acc) => {
    if (!Array.isArray(acc) || !acc.length) return;
    const x = metaOf(id), today = bkkDate();
    if (x.postedDay !== today) { x.postedDay = today; x.postedDayBase = 0; }
    const sum = acc.reduce((s, a) => s + (parseInt(a && a.today, 10) || 0), 0);
    if (sum > x.postedDayBase) { bumpHour(id, 'p', sum - x.postedDayBase); x.posted += sum - x.postedDayBase; x.postedDayBase = sum; saveMeta(meta); }
  };

  const deviceList = () => [...devices.entries()].map(([id, d]) => ({
    deviceId: id,
    name: metaOf(id).name,
    model: d.model || '',
    online: !!(d.ws && d.ws.readyState === 1),
    a11y: !!d.a11y,
    ver: d.ver || 1,
    status: d.status || { state: 'IDLE' },
    collected: metaOf(id).collected,
    generated: metaOf(id).generated,
    posted: metaOf(id).posted,
    today: todayCount(id),
    acc: d.acc || [],            // v2: per-account post stats [{i,name,today,hour,active}] (live from phone)
    daily: d.daily || 0, hourly: d.hourly || 0,
    lastSeen: d.lastSeen || 0,
    pending: (pendingCmds.get(id) && Date.now() - pendingCmds.get(id).at <= PENDING_TTL_MS)
      ? { action: pendingCmds.get(id).payload.action, at: pendingCmds.get(id).at } : null,
    selfail: d.selfail || null,
    selfails: d.selfails || [],   // ประวัติ (หน้าตั้งค่าเครื่อง) — อยู่ในหน่วยความจำ รีสตาร์ตเซิร์ฟแล้วหาย
    lastDone: metaOf(id).lastDone || 0,
    // ค่าที่พิมพ์ค้างไว้บนเว็บ — panel เอาไปเติมช่องคีย์เวิร์ด/โหมดตอนเปิดหน้า (จำข้ามเบราว์เซอร์)
    kw: metaOf(id).kw || '',
    searchMode: metaOf(id).searchMode || 'PRODUCT',
    rot: rot[id] ? { on: !!rot[id].on, names: rot[id].names || [], cur: rot[id].cur || '' } : { on: false, names: [], cur: '' },
    kwq: kwq.has(id)
      ? {
          list: kwq.get(id).list, idx: kwq.get(id).idx, stopping: kwq.get(id).phase === 'STOPPING',
          modes: kwq.get(id).modes || [],     // โหมด สินค้า/ร้าน รายคำ (คิวเดียวปนกันได้)
          action: kwq.get(id).action || '',   // โหมดงานของทั้งคิว (สร้าง / สร้าง+โพส / เก็บ ...)
        }
      : null,
    // คำสั่งงานล่าสุดที่กดจากเว็บ — ป้าย "เอาคิวเดิมกลับมา" เอาไปบอกว่ากู้แล้วคิวจะทำโหมดไหน
    lastAction: metaOf(id).lastAction || '',
    // คิวที่โดนล้างตอนกดหยุด/พัก — panel เอาไปโชว์ปุ่ม "เอาคิวเดิมกลับมา"
    lastKwq: metaOf(id).lastKwq || null,
  }));

  // เลข build (GIT_COUNT) ของ APK ที่ /fleet/apk เสิร์ฟอยู่ — เขียนโดย scripts/publish-apk.sh
  // แดชบอร์ดต้องรู้ค่านี้เพื่อบอกว่า "เครื่องนี้เก่ากว่าของที่มีให้อัปเดต" ได้จริง
  // ก่อนหน้านี้เว็บเทียบเครื่องกันเอง (max ของที่เครื่องรายงาน) ซึ่งไม่มีทางรู้ว่ามี APK ใหม่กว่าทุกเครื่อง
  // อ่านสด ๆ ทุกครั้งที่ broadcast เพื่อให้เผยแพร่ APK ใหม่แล้วเห็นผลทันทีโดยไม่ต้อง restart
  const apkBuild = () => {
    try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'apk.json'), 'utf8')).build || 0; }
    catch { return 0; }
  };
  const broadcast = () => {
    const msg = JSON.stringify({ type: 'devices', devices: deviceList(), apkBuild: apkBuild() });
    for (const p of panels) if (p.readyState === 1) p.send(msg);
  };

  // ยอด Affiliate: ส่งแยกจาก 'devices' เพราะเปลี่ยนแค่วันละไม่กี่ครั้ง ไม่ต้องวิ่งไปกับทุก heartbeat
  const aff = loadAff();
  // devs = ชื่อ/ยอดโพสต์ของทุกเครื่องที่เคยเห็น — หน้าเว็บใช้แสดงชื่อเครื่องที่ไม่ได้ต่ออยู่ และคิด "ค่าคอมต่อคลิป"
  const affMsg = () => JSON.stringify({
    type: 'aff', accounts: aff.accounts,
    devs: Object.fromEntries(Object.entries(meta).map(([id, v]) => [id, { name: v.name || '', posted: v.posted || 0 }])),
  });
  const broadcastAff = () => { const msg = affMsg(); for (const p of panels) if (p.readyState === 1) p.send(msg); };

  // ---- คิวหลายคีย์เวิร์ดต่อเครื่อง (in-memory: เซิร์ฟรีสตาร์ท = คิวหาย เครื่องรันคำปัจจุบันต่อไปเฉย ๆ)
  // { list, modes, idx, base, action, phase:'RUN'|'STOPPING', started, blank, sentAt, stopAt }
  // modes[i] = 'PRODUCT'|'SHOP' ของ list[i] — คิวเดียวปนสินค้า/ร้านได้ เพราะแอปรับ searchMode
  // มาพร้อมทุกคำสั่ง START อยู่แล้ว (ยิงคำถัดไป = ส่งโหมดของคำนั้นไปด้วย)
  const kwq = new Map();
  const kwqMode = (q, i) => (q.modes && q.modes[i]) || q.base.searchMode || 'PRODUCT';


  // กดหยุด/พัก = เซิร์ฟล้างคิวทิ้ง (จำเป็น ไม่งั้นเห็น running=false แล้วยิงคำถัดไปให้เอง เครื่องไม่ยอมหยุด)
  // แต่คำที่ "+ คิว" ไว้ถูกล้างออกจากช่องพิมพ์ไปแล้ว (kwadd ตั้งใจล้าง) → กดหยุดทีคำหายหมดกู้ไม่ได้.
  // เลยเก็บคำที่ยังไม่ได้ทำ (ตั้งแต่ idx ไป รวมคำที่ค้างอยู่ตอนโดนหยุด) ไว้ใน devices.json — ลง
  // ไฟล์ ไม่ใช่แค่ memory เพราะต้องรอดเซิร์ฟรีสตาร์ทด้วย. โหมด สินค้า/ร้าน รายคำติดไปครบ
  // คำที่ "หมดสต็อกไปแล้ว" ต่อเครื่อง (คีย์ = คำ + โหมด) — กันไม่ให้คำที่ทำจบแล้วย้อนกลับเข้าคิว
  // ตอนกดกู้คิว. เก็บใน devices.json เหมือนกัน (คำเดิมจะกลับมามีของก็ต่อเมื่อ Shopee มีสินค้าใหม่
  // ซึ่งคนสั่งพิมพ์เองใหม่ได้อยู่แล้ว — ระบบไม่เดาให้)
  const KWDONE_MAX = 200;
  const kwDoneKey = (w, mode) => `${mode === 'SHOP' ? 'SHOP' : 'PRODUCT'}|${w}`;
  const markKwDone = (id, w, mode) => {
    if (!w || w === KWQ_PLACEHOLDER) return;
    const x = metaOf(id);
    if (!Array.isArray(x.kwDone)) x.kwDone = [];
    const k = kwDoneKey(w, mode);
    if (x.kwDone.includes(k)) return;
    x.kwDone.push(k);
    if (x.kwDone.length > KWDONE_MAX) x.kwDone = x.kwDone.slice(-KWDONE_MAX);
    saveMeta(meta);
    console.log('[fleet] kwq หมดสต็อก', id, `"${w}" [${mode}] — ตัดออกจากคิวถาวร`);
  };
  const isKwDone = (id, w, mode) => {
    const x = metaOf(id);
    return Array.isArray(x.kwDone) && x.kwDone.includes(kwDoneKey(w, mode));
  };

  const stashKwq = (id) => {
    const q = kwq.get(id);
    if (!q) return;
    const list = [], modes = [];
    for (let i = q.idx; i < q.list.length; i++) {
      const w = q.list[i], md = kwqMode(q, i);
      // ข้าม placeholder และคำที่หมดสต็อกไปแล้ว (คำที่ idx ตอนกำลัง STOPPING = คำที่เพิ่งหมดพอดี)
      if (w === KWQ_PLACEHOLDER || isKwDone(id, w, md)) continue;
      list.push(w); modes.push(md);
    }
    const x = metaOf(id);
    if (!list.length) return;                  // ไม่มีอะไรให้กู้ → เก็บของเดิมไว้อย่างนั้น
    x.lastKwq = { list, modes, action: q.action, at: Date.now() };
    saveMeta(meta);
    console.log('[fleet] kwq stash', id, `เก็บไว้ ${list.length} คำ (โดนสั่งหยุด/พัก)`);
  };

  // ---- คิวที่กำลังวิ่ง: เขียนลงไฟล์ทุกครั้งที่ขยับ ----
  // stashKwq ข้างบนเก็บให้ "ปุ่มเอาคิวเดิมกลับมา" — คนกดหยุดเอง ก็ต้องมีคนกดกู้เอง ไม่ปลุกให้
  // ตัวนี้คนละเรื่อง: เก็บให้เซิร์ฟกู้เองหลังรีสตาร์ต/ดับกะทันหัน. ต้องแยกช่องกับ lastKwq เพราะ
  // ถ้าใช้ช่องเดียวกัน ปุ่มกู้จะโผล่ค้างตลอดเวลาที่มีคิววิ่ง ทั้งที่ไม่มีอะไรให้กู้
  const persistLiveKwq = (id) => {
    const q = kwq.get(id), x = metaOf(id);
    if (!q) { if (x.liveKwq) { x.liveKwq = null; saveMeta(meta); } return; }
    const list = [], modes = [];
    for (let i = q.idx; i < q.list.length; i++) {
      const w = q.list[i], md = kwqMode(q, i);
      if (w === KWQ_PLACEHOLDER || isKwDone(id, w, md)) continue;
      list.push(w); modes.push(md);
    }
    // base ติดไปด้วย — ของเดิมสร้าง base ใหม่ตอนกู้ แล้ว rounds/account/count กลับไปเป็นค่าตายตัว
    x.liveKwq = list.length ? { list, modes, action: q.action, base: q.base, at: Date.now() } : null;
    saveMeta(meta);
  };
  const dropLiveKwq = (id) => { const x = metaOf(id); if (x.liveKwq) { x.liveKwq = null; saveMeta(meta); } };

  // เซิร์ฟถูกสั่งปิด/รีสตาร์ท (deploy) = คิวใน memory หายเกลี้ยง — แต่ liveKwq บนดิสก์เป็นของสด
  // อยู่แล้ว (เขียนทุกครั้งที่คิวขยับ) เลยไม่ต้องรีบเก็บอะไรตอนจะตาย. เคยเก็บลง lastKwq ตรงนี้
  // ซึ่งตอนนี้กลับเป็นผลเสีย: กู้อัตโนมัติสำเร็จแล้วปุ่มกู้ยังโผล่ค้างพร้อมคำชุดเดียวกัน
  // และท่าที่ SIGTERM ดักไม่ได้ (kill -9 / ไฟดับ) ก็รอดด้วย liveKwq เหมือนกัน
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => { console.log('[fleet] ปิดเซิร์ฟ —', sig, `คิววิ่งอยู่ ${kwq.size} เครื่อง (อยู่ในไฟล์แล้ว)`); process.exit(0); });
  }

  // ---- "เปลี่ยนโหมดโดยไม่เสียคิว" สำหรับเครื่องที่ไม่มีคิวคีย์เวิร์ด (รันคำเดียว)
  // แอปทิ้ง START ที่ส่งซ้อนงานที่รันอยู่ → เปลี่ยนโหมดต้อง cancel ก่อนแล้วค่อยยิงคำเดิมซ้ำ
  // เคสที่มีคิวใช้ q.redo + kwqSend แทน (ผ่านสเตทแมชชีนเดิม ซึ่งรีเซ็ตตัวนับให้ครบ)
  const restartWait = new Map();       // id -> { action, keyword, rounds, searchMode, ..., at, stopAt }
  const RESTART_GIVEUP_MS = 10 * 60_000;
  const restartCmd = (id, st, action) => ({
    action,
    keyword: String((st && st.keyword) || '').trim(),
    rounds: metaOf(id).lastRounds || 1,
    searchMode: metaOf(id).searchMode || 'PRODUCT',
    account: 1, count: 5,
  });
  const rwOnStatus = (id, d, m) => {
    const r = restartWait.get(id);
    if (!r) return;
    const running = (typeof m.running === 'boolean') ? m.running : (m.state && m.state !== 'IDLE');
    if (running) {
      // ยังไม่ยอมหยุด (เจนวิดีโอค้าง) → ย้ำ cancel เป็นระยะ แต่ไม่รอตลอดชาติ
      if (Date.now() - r.at > RESTART_GIVEUP_MS) {
        restartWait.delete(id);
        console.log('[fleet] mode restart', id, 'ยกเลิก — เครื่องไม่ยอมหยุดใน 10 นาที');
      } else if (Date.now() - r.stopAt > KWQ_STOP_RETRY_MS && d.ws && d.ws.readyState === 1) {
        r.stopAt = Date.now();
        d.ws.send(JSON.stringify({ action: 'cancel' }));
      }
      return;
    }
    restartWait.delete(id);
    if (!(d.ws && d.ws.readyState === 1)) return;
    const { at, stopAt, ...cmd } = r;
    d.ws.send(JSON.stringify(cmd));
    console.log('[fleet] mode restart ->', id, `${cmd.action} "${cmd.keyword}"`);
  };

  // ---- "คนกดหยุดที่เครื่อง" (แอป ver>=10 ส่ง stopCount มาให้) ------------------------------------
  // ทั้ง kwqOnStatus และ rwOnStatus รอจังหวะ running=false เพื่อ "ยิงต่อ" — ซึ่งถูกเมื่อรอบจบเอง แต่
  // ผิดเต็ม ๆ เมื่อคนเดินไปกดหยุดที่เครื่อง เพราะหน้าตาสถานะเหมือนกันเป๊ะ. ตัวนับนี้แยกสองเคสนั้นออก
  // จากกันได้จริง ๆ ครั้งแรก: เห็นเลขเพิ่ม = คนสั่งหยุด → เก็บคิวไว้ให้กด "↺ เอาคิวเดิมกลับมา" แล้ว
  // ปล่อยเครื่องไว้เฉย ๆ (เครื่องที่ ver<10 ไม่ส่งฟิลด์นี้ → พฤติกรรมเดิมทุกอย่าง ไม่พังเพิ่ม)
  const stopSeen = new Map();       // deviceId -> ค่า stopCount ที่รับรู้แล้ว
  const manualStopOnStatus = (id, d, m) => {
    if (typeof m.stopCount !== 'number') return;     // แอปเก่า — ไม่มีข้อมูลให้ใช้
    // ลงไฟล์ด้วย: ตัวกู้อัตโนมัติเอาไปเทียบว่ามีคนกดหยุดตอนเซิร์ฟดับไหม (stopSeen อยู่ในแรม หายไปกับเซิร์ฟ)
    const mx = metaOf(id);
    if (mx.stopCount !== m.stopCount) { mx.stopCount = m.stopCount; saveMeta(meta); }
    const seen = stopSeen.get(id);
    stopSeen.set(id, m.stopCount);
    // ครั้งแรกที่เห็นเครื่องนี้ = แค่ตั้งฐาน (ไม่ย้อนไปสนใจการกดหยุดที่เกิดก่อนเซิร์ฟรู้จักมัน)
    // เลขลดลง = แอปรีสตาร์ต ตัวนับกลับไป 0 → ตั้งฐานใหม่ ไม่ใช่การกดหยุด
    if (seen === undefined || m.stopCount <= seen) return;
    const q = kwq.get(id);
    if (q) { stashKwq(id); kwq.delete(id); dropLiveKwq(id); }
    restartWait.delete(id);          // คำสั่ง "เปลี่ยนโหมด" ที่ค้างอยู่ก็ต้องทิ้ง — ไม่งั้นมันยิงงานใหม่แทน
    console.log('[fleet] คนกดหยุดที่เครื่อง', id, q ? `— เก็บคิวไว้ ${q.list.length - q.idx} คำ เลิกยิงคำถัดไป` : '— ไม่มีคิวค้าง');
    if (q) broadcast();
  };

  const kwqSend = (id, d, q) => {
    q.phase = 'RUN'; q.started = false; q.blank = 0; q.sentAt = Date.now(); q.stopAt = 0;
    q.idle = 0; q.regAt = 0;
    if (!(d.ws && d.ws.readyState === 1)) return;
    const mode = kwqMode(q, q.idx);
    d.ws.send(JSON.stringify({ ...q.base, action: q.action, keyword: q.list[q.idx], searchMode: mode }));
    console.log('[fleet] kwq ->', id, `คำที่ ${q.idx + 1}/${q.list.length} = "${q.list[q.idx]}" [${mode}]`);
    persistLiveKwq(id);
  };

  // ไปคำถัดไป; หมดคิวแล้ว = ลบทิ้ง (ปล่อยเครื่องทำต่อตามพฤติกรรมเดิม)
  // แปลงคิวที่เก็บไว้ (ปุ่มกู้ / คิวที่วิ่งอยู่ก่อนเซิร์ฟรีสตาร์ต) ให้กลับเป็นคิวจริงในแรม
  // เครื่องกำลังรัน = ต่อท้ายเฉย ๆ ไม่แตะคำที่ทำค้างอยู่ / เครื่องว่าง = คนเรียกเป็นคนตัดสินใจยิง START
  const installKwq = (id, d, src, action) => {
    const x = metaOf(id);
    const st = d.status || {};
    const running = (typeof st.running === 'boolean') ? st.running : !!(st.state && st.state !== 'IDLE');
    let q = kwq.get(id);
    const createdQ = !q;
    if (!q) {
      const cur = running ? String(st.keyword || '').trim() : '';
      q = {
        list: running ? [cur || KWQ_PLACEHOLDER] : [],
        modes: running ? [x.searchMode || 'PRODUCT'] : [],
        idx: 0, action,
        // base ที่เก็บไว้มาก่อนเสมอ — เดาใหม่เฉพาะตอนไม่มี (ของเก่าที่ stash ไว้ก่อนแพตช์นี้)
        base: src.base || {
          keyword: cur, rounds: x.lastRounds || 1,
          searchMode: src.modes[0] || x.searchMode || 'PRODUCT', account: 1, count: 5,
        },
        phase: 'RUN', started: running, blank: 0, sentAt: Date.now(), stopAt: 0,
      };
      kwq.set(id, q);
    } else {
      q.action = action;
    }
    let skipped = 0;
    const pairs = [];
    for (let i = 0; i < src.list.length; i++) {
      const w = src.list[i], md = src.modes[i] === 'SHOP' ? 'SHOP' : 'PRODUCT';
      if (isKwDone(id, w, md)) { skipped++; continue; }   // คำนี้หมดสต็อกไปแล้ว ไม่เอากลับ
      pairs.push([w, md]);
    }
    const { added, left } = kwqAppend(q, pairs, kwqMode);
    return { q, running, createdQ, added, left, skipped };
  };

  const kwqNext = (id, d) => {
    const q = kwq.get(id);
    if (!q) return;
    if (q.idx + 1 >= q.list.length) {
      console.log('[fleet] kwq done', id, `(ครบ ${q.list.length} คำ)`);
      kwq.delete(id); dropLiveKwq(id);
    } else {
      q.idx++;
      kwqSend(id, d, q);
    }
    broadcast();
  };

  // ---- กู้คิวเองหลังเซิร์ฟรีสตาร์ต ----
  // ทำตอน status ตัวแรก ไม่ใช่ตอน register: ตอน register เซิร์ฟตั้ง status ตั้งต้นเป็น IDLE ไว้ก่อน
  // ถ้าตัดสินใจตรงนั้นจะอ่านว่า "เครื่องว่าง" แล้วยิง START ซ้ำใส่เครื่องที่กำลังทำงานอยู่
  const AUTO_KWQ_MAX_AGE_MS = 12 * 3600_000;
  const autoTried = new Set();
  const autoRestoreKwq = (id, d, m) => {
    if (autoTried.has(id)) return;
    autoTried.add(id);
    const x = metaOf(id), lk = x.liveKwq;
    if (!lk || !Array.isArray(lk.list) || !lk.list.length) return;
    if (kwq.has(id)) return;
    // ไม่กู้ให้ = ย้ายไปช่องปุ่ม ไม่ทิ้ง. อย่างแย่ที่สุดคือเท่าพฤติกรรมเดิม (ต้องมีคนกด)
    const park = (why) => {
      if (!x.lastKwq || !Array.isArray(x.lastKwq.list) || !x.lastKwq.list.length) {
        x.lastKwq = { list: lk.list, modes: lk.modes, action: lk.action, at: lk.at || Date.now() };
      }
      x.liveKwq = null; saveMeta(meta);
      console.log('[fleet] kwq auto ข้าม', id, `(${why}) — เก็บ ${lk.list.length} คำไว้ให้กดปุ่มกู้`);
      broadcast();
    };
    const st0 = m || {};
    const running0 = (typeof st0.running === 'boolean') ? st0.running : !!(st0.state && st0.state !== 'IDLE');
    // เครื่องที่ล็อก PIN: ด่าน PIN อยู่บนข้อความจากหน้าเว็บเท่านั้น ทางนี้มาจากตัวโทรศัพท์ซึ่งไม่เคยผ่านด่านนั้น
    // แต่ห้ามกู้เลยก็ไม่ได้ — เครื่องที่ผลิตหนักที่สุดคือเครื่องที่ล็อกไว้ ปิดตายเท่ากับฟีเจอร์นี้ไม่ช่วยตัวที่สำคัญสุด
    // ทางสายกลาง: กู้ได้เฉพาะตอนเครื่อง "กำลังทำงานอยู่" = ต่อท้ายคิวเฉย ๆ ไม่มีการสั่งเริ่มงานใหม่
    // (คิวชุดนี้ผ่านด่าน PIN มาแล้วตอนถูกตั้ง — นี่คือกู้ของเดิม ไม่ใช่คำสั่งใหม่) เครื่องนิ่ง = ให้คนใส่ PIN กดเอง
    if (id === LOCKED_DEVICE && !running0) { park('เครื่องล็อกรหัส + นิ่งอยู่'); return; }
    if (Date.now() - (lk.at || 0) > AUTO_KWQ_MAX_AGE_MS) { park('คิวเก่าเกิน 12 ชม.'); return; }
    // มีคนกดหยุดที่เครื่องช่วงเซิร์ฟดับ: manualStopOnStatus มองไม่เห็นการกดนั้น (เห็นเครื่องครั้งแรก
    // = ตั้งฐานเฉย ๆ) ถ้าไม่ดักตรงนี้ คนกดหยุดแล้วเซิร์ฟจะปลุกกลับมาวิ่งเอง = ปุ่มหยุดไม่ศักดิ์สิทธิ์
    const sc = m.stopCount, saved = x.stopCount;
    if (typeof sc === 'number' && typeof saved === 'number' && sc > saved) { park('มีคนกดหยุดที่เครื่องตอนเซิร์ฟดับ'); return; }
    const st = m || {};
    const running = (typeof st.running === 'boolean') ? st.running : !!(st.state && st.state !== 'IDLE');
    // แอปเก่าไม่ส่ง stopCount = ไม่มีทางรู้ว่ามีคนกดหยุดไหม → กู้เฉพาะตอนเครื่องยังวิ่งอยู่
    if (typeof sc !== 'number' && !running) { park('แอปเก่า+เครื่องนิ่ง แยกไม่ออกว่าโดนสั่งหยุด'); return; }
    const action = [x.lastAction, lk.action].find((a) => KWQ_ACTIONS.includes(a)) || 'looppost';
    const r = installKwq(id, d, lk, action);
    if (!r.added) {
      if (r.createdQ) kwq.delete(id);
      park(r.skipped ? `คำหมดสต็อกไปแล้ว ${r.skipped} คำ` : 'ไม่มีคำใหม่ให้ใส่');
      return;
    }
    x.lastAction = action; saveMeta(meta);
    if (!r.running) kwqSend(id, d, r.q);   // เครื่องนิ่งและไม่มีใครกดหยุด (เช่นตายกลางจังหวะสลับคำ) → เดินต่อ
    else persistLiveKwq(id);
    console.log('[fleet] kwq auto-restore ->', id,
      `+${r.added} คำ [${action}] (${r.running ? 'ต่อท้ายงานที่วิ่งอยู่' : 'เครื่องนิ่ง — ยิงคำแรกให้'}, คิวรวม ${r.q.list.length})`);
    broadcast();
  };

  const kwqOnStatus = (id, d, m) => {
    const q = kwq.get(id);
    if (!q) return;
    const running = (typeof m.running === 'boolean') ? m.running : (m.state && m.state !== 'IDLE');
    if (q.phase === 'STOPPING') {
      if (!running) {
        // หยุดเพราะ "เปลี่ยนโหมด" ไม่ใช่ "คำนี้หมดสต็อก" → ยิงคำเดิมซ้ำด้วยโหมดใหม่ ไม่ใช่ข้ามไปคำถัดไป
        if (q.redo) {
          q.redo = false;
          kwqSend(id, d, q);
          console.log('[fleet] kwq redo', id, `เริ่ม "${q.list[q.idx]}" ใหม่ด้วยโหมด ${q.action}`);
          broadcast(); return;
        }
        kwqNext(id, d); return;
      }
      // ยังไม่ยอมหยุด (เจนวิดีโอค้าง) → ย้ำคำสั่งหยุดเป็นระยะ
      if (Date.now() - q.stopAt > KWQ_STOP_RETRY_MS && d.ws && d.ws.readyState === 1) {
        q.stopAt = Date.now();
        d.ws.send(JSON.stringify({ action: 'cancel' }));
      }
      return;
    }
    if (running) {
      q.started = true;
      q.idle = 0;
      q.regAt = 0;      // เห็นมันรันแล้ว = พ้นช่วงเพิ่งต่อใหม่ ไม่ต้องผ่อนผันอีก
      // คีย์ว่างทั้งที่ยังรัน = แอปเจอ "คำนี้หมดสต็อก" แล้วสลับไป browse ทั่วไป
      const blank = !String(m.keyword || '').trim();
      if (blank && Date.now() - q.sentAt > KWQ_ARM_MS) {
        if (++q.blank < KWQ_BLANK_HITS) return;
        // คำนี้หมดสต็อกจริง → จดไว้ ไม่ให้ย้อนกลับเข้าคิวตอนกด "เอาคิวเดิมกลับมา"
        markKwDone(id, q.list[q.idx], kwqMode(q, q.idx));
        if (q.idx + 1 >= q.list.length) {   // คำสุดท้ายแล้ว → ปล่อย browse ต่อตามเดิม
          console.log('[fleet] kwq done', id, '(คำสุดท้ายหมดสต็อก — ปล่อย browse ต่อ)');
          kwq.delete(id); dropLiveKwq(id); broadcast(); return;
        }
        console.log('[fleet] kwq', id, `"${q.list[q.idx]}" หมดสต็อก — สั่งหยุดเพื่อสลับคำถัดไป`);
        q.phase = 'STOPPING'; q.stopAt = Date.now();
        if (d.ws && d.ws.readyState === 1) d.ws.send(JSON.stringify({ action: 'cancel' }));
        broadcast();
      } else {
        q.blank = 0;
      }
    } else if (q.started) {
      // รอบจบเอง (โหมด loop/เก็บ/รัน/เจน หมดคำก็หยุด) → คำถัดไป
      //
      // แต่ "ไม่ได้รัน" ครั้งเดียวเชื่อไม่ได้เด็ดขาด — มันหมายถึง 2 อย่างที่หน้าตาเหมือนกันเป๊ะ:
      //   (ก) รอบจบจริง  (ข) แอปเพิ่งรีสตาร์ต/WS หลุดแล้วต่อกลับ ลูปยังไม่ถูก watchdog ปลุก
      // เจอกับตัว 2026-08-21: ce872 กำลังทำ "Denso รถ" อยู่ดี ๆ เครื่อง register ใหม่ 1 ครั้ง
      // เซิร์ฟเห็น running=false ครั้งเดียวก็ข้ามไป "555 รถ" แล้วปิดคิว — คำนั้นยังมีสินค้าเหลือเพียบ
      // และไม่ได้ถูกจดว่าหมดสต็อกด้วยซ้ำ (ไม่มี log "หมดสต็อก") คนหน้าเว็บเลยงงว่าคำหายไปไหน.
      // ฝั่ง "คีย์ว่าง" มี arm 2 นาที + ต้องเห็น 3 ครั้งติดอยู่แล้ว ทางนี้ไม่มีอะไรกันเลย — เติมให้ครบ.
      // เสียแค่หน่วงไปคำถัดไปช้าขึ้น ~1 นาที ซึ่งถูกกว่าการเผาคำทิ้งทั้งคำเยอะ
      if (q.regAt && Date.now() - q.regAt < KWQ_REG_GRACE_MS) return;
      if ((q.idle = (q.idle || 0) + 1) < KWQ_IDLE_HITS) return;
      kwqNext(id, d);
    }
  };

  // ---- phones ----
  agentWss.on('connection', (ws) => {
    let deviceId = null;
    ws.on('message', safe((buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;   // JSON "null"/ตัวเลข parse ผ่านแต่ m.type จะ throw
      if (m.type === 'register') {
        if (!timingSafeEq(m.secret, ENROLL_SECRET) || !validId(m.deviceId)) { ws.close(); return; }
        deviceId = m.deviceId;
        const cur = devices.get(deviceId) || {};
        devices.set(deviceId, {
          ws, model: m.model, status: { state: 'IDLE' }, lastSeen: Date.now(),
          lastState: cur.lastState || 'IDLE', lastProduct: cur.lastProduct || '',
          lastPostedKey: cur.lastPostedKey || '', a11y: m.a11y === true,
          ver: parseInt(m.ver, 10) || 1,   // app feature version (old APKs send none → 1)
          acc: Array.isArray(m.acc) ? m.acc : (cur.acc || []),   // v2: per-account post stats
          daily: m.daily || cur.daily || 0, hourly: m.hourly || cur.hourly || 0,
        });
        metaOf(deviceId);
        if (Array.isArray(m.acc)) accruePosted(deviceId, m.acc);   // สะสม "ลง" จากยอดราย acc ตั้งแต่ตอน register
        // เพิ่งต่อใหม่ = แอปอาจเพิ่งรีสตาร์ต ลูปยังไม่กลับมา (watchdog ในแอปใช้เวลาถึง 90s)
        // → ตีตราเวลาไว้ ให้ kwqOnStatus ไม่เอา running=false ช่วงนี้ไปนับเป็น "รอบจบ" แล้วข้ามคำ
        const rq = kwq.get(deviceId);
        if (rq) { rq.regAt = Date.now(); rq.idle = 0; }
        // แอปรีสตาร์ต = ตัวนับ "คนกดหยุด" กลับไป 0 → ตั้งฐานใหม่ตรงนี้เลย ไม่ต้องรอ status ตัวแรก
        // (ถ้ารอ แล้วคนกดหยุดก่อน status แรกพอดี เลขที่ส่งมาจะยังต่ำกว่าฐานเก่า = พลาดการกดนั้นไป)
        if (typeof m.stopCount === 'number') stopSeen.set(deviceId, m.stopCount);
        console.log('[fleet] register', deviceId, m.model);
        logEvent(deviceId, 'online', m.ver ? 'แอป v' + m.ver : '');
        const pend = pendingCmds.get(deviceId);
        if (pend) {
          pendingCmds.delete(deviceId);
          const age = Date.now() - pend.at;
          if (age <= PENDING_TTL_MS) {
            const dv = devices.get(deviceId);
            let { action, rounds } = pend.payload;
            if ((dv.ver || 1) < 2 && (action === 'loop' || action === 'looppost')) { action = 'run'; rounds = 50; }
            try { ws.send(JSON.stringify({ ...pend.payload, action, rounds })); } catch {}
            console.log('[fleet] ส่งคำสั่งค้าง', action, '->', deviceId, `(รอ ${Math.round(age / 1000)}s)`);
            logEvent(deviceId, 'pending', `ส่งคำสั่งค้าง "${action}" (รอ ${Math.round(age / 1000)} วิ)`);
          } else {
            console.log('[fleet] ทิ้งคำสั่งค้างหมดอายุ', pend.payload.action, '->', deviceId);
            logEvent(deviceId, 'pending', `ทิ้งคำสั่งค้าง "${pend.payload.action}" (หมดอายุ)`);
          }
        }
        broadcast();
      } else if (m.type === 'status' && deviceId) {
        const d = devices.get(deviceId);
        if (!d) return;
        // ข้อความเข้ามาทางสายไหน สายนั้นคือสายจริง — กู้ธงคืนเองถ้ามันหล่นไป กันเคสอื่นที่ทำ d.ws หาย
        // (broadcast อยู่ท้ายกิ่งนี้แล้ว ไม่ต้องยิงซ้ำ) เครื่องจึงกลับมาเขียวเองในไม่กี่วิ ไม่ต้องรอ reconnect
        if (d.ws !== ws) d.ws = ws;
        // counters: a new product = one collected; entering DONE = one clip; a new posted target = one posted.
        if (m.product && m.product !== d.lastProduct) { d.lastProduct = m.product; metaOf(deviceId).collected++; saveMeta(meta); }
        if (m.state === 'DONE' && d.lastState !== 'DONE') {
          const x = metaOf(deviceId); x.generated++;
          const t = bkkDate(); if (x.daily.date !== t) { x.daily.date = t; x.daily.count = 0; }
          x.daily.count++;
          x.lastDone = Date.now();   // เวลาเจนคลิปเสร็จล่าสุด — โชว์ในตารางอันดับ
          bumpHour(deviceId, 'g');
          saveMeta(meta);
        }
        // posted: FleetAgent sends `posted` = job.postedTarget (non-empty once a clip is posted to Shopee).
        if (m.posted) {
          const key = (m.product || '') + '|' + m.posted;
          if (key !== d.lastPostedKey) { d.lastPostedKey = key; metaOf(deviceId).posted++; saveMeta(meta); }
        }
        if (typeof m.a11y === 'boolean') d.a11y = m.a11y;
        if (m.ver) d.ver = parseInt(m.ver, 10) || d.ver;
        if (Array.isArray(m.acc)) { d.acc = m.acc; accruePosted(deviceId, m.acc); }   // v2: live per-account post counts → สะสมเป็น "ลง"
        if (Array.isArray(m.acc) && recordAff(aff, deviceId, m.acc)) { saveAff(aff); broadcastAff(); }
        if (m.daily) d.daily = m.daily;
        if (m.hourly) d.hourly = m.hourly;
        d.lastState = m.state;
        // เครื่องบอกโหมดงานวนที่รันอยู่มาเอง (แอปใหม่) → จำไว้ใช้ตอน "เพิ่มคำเข้าคิว" ไม่ต้องเดา
        if (KWQ_ACTIONS.includes(m.runMode) && metaOf(deviceId).lastAction !== m.runMode) {
          metaOf(deviceId).lastAction = m.runMode; saveMeta(meta);
        }
        d.status = m; d.lastSeen = Date.now();
        // ต้องมาก่อนสองบรรทัดล่าง: ถ้าคนเพิ่งกดหยุดที่เครื่อง ห้ามให้ตัวไหนเอา running=false ไปยิงต่อ
        autoRestoreKwq(deviceId, d, m);   // ต้องมาก่อน: manualStopOnStatus เขียนทับ stopCount ที่ใช้เทียบ
        manualStopOnStatus(deviceId, d, m);
        rwOnStatus(deviceId, d, m);    // เปลี่ยนโหมดแบบไม่มีคิว: หยุดแล้ว → ยิงคำเดิมซ้ำด้วยโหมดใหม่
        kwqOnStatus(deviceId, d, m);   // หลายคีย์เวิร์ด: คำนี้หมดสต็อกหรือรอบจบ → ยิงคำถัดไป
        broadcast();
      } else if ((m.type === 'settings' || m.type === 'settingsack') && deviceId) {
        // v3: ส่งค่าปัจจุบัน / ผล apply กลับไปให้ dashboard ทุกจอ (การ์ดเครื่องนั้นเปิด modal อยู่)
        const d = devices.get(deviceId);
        if (d) d.lastSeen = Date.now();
        const relay = JSON.stringify({
          type: m.type, deviceId,
          settings: m.settings || {}, running: m.running === true,
          applied: m.applied || [], skipped: m.skipped || [],
          warn: typeof m.warn === 'string' ? m.warn : '',   // เครื่องเตือนว่าค่าที่ตั้งใช้ไม่ได้จริง
        });
        for (const p of panels) if (p.readyState === 1) p.send(relay);
      } else if (m.type === 'selectorsack' && deviceId) {
        // v4: echo back applied selector overrides to every dashboard
        const relay = JSON.stringify({ type: 'selectorsack', deviceId, selectorOverrides: m.selectorOverrides || '{}' });
        for (const p of panels) if (p.readyState === 1) p.send(relay);
      } else if (m.type === 'updatestat' && deviceId) {
        // ความคืบหน้าการอัปเดต — ส่งต่อให้ทุกแดชบอร์ด ช่วงนี้เครื่องกำลังจะรีสตาร์ตตัวเอง
        // ข้อความสุดท้ายที่ส่งทันมักเป็น "กำลังติดตั้ง…" แล้ว socket จะขาดไปพร้อมโปรเซสเก่า
        const relay = JSON.stringify({ type: 'updatestat', deviceId, msg: m.msg || '' });
        for (const p of panels) if (p.readyState === 1) p.send(relay);
      } else if (m.type === 'shot' && deviceId) {
        // ภาพหน้าจอเครื่อง (base64 jpeg ~25KB) — ส่งต่อให้แดชบอร์ดที่เปิดอยู่ ไม่เก็บลงดิสก์:
        // มันคือภาพ "ตอนนี้" ของเครื่อง เก็บไว้ก็ไม่ได้ตอบอะไร และเป็นภาพจอที่อาจติดข้อมูลบัญชี
        const relay = JSON.stringify({ type: 'shot', deviceId, at: m.at || Date.now(), img: m.img || '', err: m.err || '' });
        for (const p of panels) if (p.readyState === 1) p.send(relay);
      } else if (m.type === 'selectorfail' && deviceId) {
        // auto-diag: a selector missed on this device — remember it (shown on the card) + broadcast
        const d = devices.get(deviceId);
        if (d) {
          d.selfail = { key: m.key, markers: Array.isArray(m.markers) ? m.markers.slice(0, 15) : [], ts: Date.now() };
          // เก็บเป็นล็อกด้วย: การ์ดซ่อน error ทันทีที่เครื่องเจนผ่าน แต่ยังต้องย้อนดูได้ว่าอะไรเคยพลาด
          d.selfails = [d.selfail, ...(d.selfails || [])].slice(0, 20);
        }
        broadcast();
      } else if (m.type === 'kwnext' && deviceId) {
        // แอป ver>=13 แจ้งเองว่า "คีย์ที่ทำอยู่หมดสต็อกแล้ว" — สลับคำถัดไปทันที ไม่ต้องรอ ~3 นาที
        // เดาจาก status.keyword ว่าง (KWQ_ARM_MS + KWQ_BLANK_HITS). guard เหมือน blank-path เป๊ะ:
        // ไม่มีคิว = ไม่ทำอะไร (แอปยัง browse ต่อเอง), กำลังสลับอยู่แล้วก็ข้าม, และคำที่แจ้งมา
        // ต้องตรงกับคำที่คิวทำอยู่ (กัน status เลื่อน/ข้อความซ้ำมาข้ามคำที่ยังมีของ)
        const d = devices.get(deviceId), q = kwq.get(deviceId);
        // หมดสต็อก = เอาคำนั้นออกจากคลัง "ของเครื่องนี้" ด้วย (2026-10-14) ไม่ต้องไล่ลบเอง. ทำก่อน guard
        // ของคิวเพราะคำที่รันเดี่ยว ๆ (ไม่มีคิว) ก็หมดได้ และเคยค้างอยู่ในคลังตลอด. ลบเฉพาะคำ+โหมด+เครื่อง
        // ที่ตรงเป๊ะ (คำเดียวกันของเครื่องอื่นไม่โดน) ถ้ายังอยากใช้ก็กด ☆ บันทึก ใหม่ได้
        {
          const w = String(m.kw || '').trim().slice(0, 60);
          if (w && w !== KWQ_PLACEHOLDER) {
            const md = ((q ? kwqMode(q, q.idx) : metaOf(deviceId).searchMode) === 'SHOP') ? 'SHOP' : 'PRODUCT';
            const before = kwLib.length;
            kwLib = kwLib.filter((it) => !(it.w === w && it.mode === md && (it.dev || '') === deviceId));
            if (kwLib.length !== before) {
              saveKwLib(kwLib); broadcastKwLib();
              console.log('[fleet] kwnext → ลบออกจากคลัง', deviceId, `"${w}" [${md}] (เหลือ ${kwLib.length})`);
            }
          }
        }
        if (d && q && q.phase !== 'STOPPING') {
          const cur = q.list[q.idx];
          if (!m.kw || String(m.kw).trim() === cur) {
            markKwDone(deviceId, cur, kwqMode(q, q.idx));
            if (q.idx + 1 >= q.list.length) {
              console.log('[fleet] kwnext', deviceId, `"${cur}" หมดสต็อก (แอปแจ้งเอง) — คำสุดท้าย ปล่อย browse ต่อ`);
              kwq.delete(deviceId);
            } else {
              console.log('[fleet] kwnext', deviceId, `"${cur}" หมดสต็อก (แอปแจ้งเอง) — สั่งหยุดเพื่อสลับคำถัดไป`);
              q.phase = 'STOPPING'; q.stopAt = Date.now();
              if (d.ws && d.ws.readyState === 1) d.ws.send(JSON.stringify({ action: 'cancel' }));
            }
            broadcast();
          }
        }
      }
    }));
    // ปิดเฉพาะสายของตัวเอง. WHY: เน็ตสะดุด = สายเก่าค้างครึ่งใบ (half-open) เครื่องไม่รู้ตัวจึงต่อสายใหม่
    // และ register ทับ (d.ws = สายใหม่) แล้ว close ของสายเก่าค่อยตามมาทีหลังตอน TCP หมดอายุ — โค้ดเดิม
    // ไม่ได้ดูว่าเป็นสายไหน เลย d.ws = null ทับสายใหม่ที่ยังดีอยู่ ผลคือการ์ดเทาทั้งที่เครื่องยังส่ง status
    // เข้ามาทุกไม่กี่วิ (lastSeen สดตลอด) และสั่งงานเครื่องนั้นไม่ได้เลยเพราะทุกคำสั่งยิงผ่าน d.ws
    // รวมถึงปุ่มอัปเดต APK ที่ถูก disable ตาม online. เจอจริง 26 ส.ค. 2026: เด็กนาย OFFLINE แต่ lastSeen 10 วิ
    ws.on('close', () => { const d = deviceId && devices.get(deviceId); if (d && d.ws === ws) { d.ws = null; logEvent(deviceId, 'offline', ''); broadcast(); } });
    ws.on('error', (e) => console.error('[fleet] agent ws error:', e && e.message));
  });

  // Server->agent heartbeat. WHY: a phone can't tell a half-open socket from a live one — OkHttp's WS
  // ping keeps succeeding because Caddy (the TLS front) answers ping frames even after this Node process
  // died/restarted (SEGV) and dropped the socket, so the phone thinks it's online while the dashboard
  // (online = d.ws.readyState===1 on the CURRENT process) shows it offline and it ignores every command.
  // Only the live process sends this srvping, so the agent receiving it proves the socket is really ours;
  // when it stops arriving the agent's receive-watchdog reconnects (FleetAgent SRV_PING_STALE_MS). Busy
  // phones were the ones dropping — this makes them self-heal like the idle ones instead of needing a
  // manual app restart / wifi toggle.
  const SRV_PING_MS = 25_000;
  setInterval(() => {
    const msg = JSON.stringify({ action: 'srvping', t: Date.now() });
    for (const d of devices.values()) {
      if (d.ws && d.ws.readyState === 1) { try { d.ws.send(msg); } catch {} }
    }
  }, SRV_PING_MS);

  // ---- browser dashboards ----
  const templates = loadTemplates();
  const sendTemplates = (ws) => ws.send(JSON.stringify({ type: 'templates', templates }));
  const broadcastTemplates = () => { for (const p of panels) if (p.readyState === 1) sendTemplates(p); };
  // selector presets loaded fresh from disk each connect so a Claude-deployed edit shows up on reload.
  const sendSelPresets = (ws) => ws.send(JSON.stringify({ type: 'selectorpresets', presets: loadSelPresets() }));
  // คลังคีย์เวิร์ด — ส่งให้ทุกแผงที่เปิดอยู่ทันทีที่มีคนบันทึก/ลบ (ไม่ต้องรีเฟรชหน้า)
  const sendKwLib = (ws) => ws.send(JSON.stringify({ type: 'keywords', list: kwLib }));
  const broadcastKwLib = () => { for (const p of panels) if (p.readyState === 1) sendKwLib(p); };

  // ---- hourly template rotation ----
  const rot = loadRot();
  // เลื่อนไปเทมเพลตถัดไปของเครื่องนี้แล้วดันเข้าเครื่อง (ใช้ทั้ง tick รายชั่วโมง + ปุ่ม "หมุนเดี๋ยวนี้")
  const advanceRotation = (id) => {
    const r = rot[id];
    if (!r || !r.on) return false;
    const names = (r.names || []).filter((n) => templates[n]);   // เทมเพลตที่โดนลบไปแล้ว = ข้าม
    if (!names.length) return false;
    const d = devices.get(id);
    if (!d || !(d.ws && d.ws.readyState === 1) || (d.ver || 1) < 3) {
      console.log('[fleet] rotate skip', id, '(offline/old app)');
      return false;
    }
    r.idx = ((r.idx ?? -1) + 1) % names.length;
    r.cur = names[r.idx];
    d.ws.send(JSON.stringify({ action: 'applysettings', settings: rotatable(templates[r.cur].settings) }));
    console.log('[fleet] rotate ->', id, r.cur);
    return true;
  };
  // หมุนทุก 8 นาที — คลิปนึง ~2.3 นาที (เร็วขึ้นจาก ~5 นาทีตอนเขียนโค้ดนี้) ≈ 3 คลิป/เทมเพลตเท่าเดิม
  // เช็คทุก 30 วิว่าข้ามคาบหรือยัง ไม่ใช่ตั้งเวลานับถอยหลัง — เซิร์ฟสะดุดแล้วกลับมาก็รู้ว่าตกคาบไป
  const quarter = () => Math.floor(Date.now() / 480_000);
  let rotQ = quarter();
  setInterval(() => {
    const q = quarter();
    if (q === rotQ) return;
    rotQ = q;
    let changed = false;
    for (const id of Object.keys(rot)) changed = advanceRotation(id) || changed;
    if (changed) { saveRot(rot); broadcast(); }
  }, 30_000);

  // ตรวจเครื่องค้างทุก 60 วิ: กำลังรันโหมดสร้างคลิปแต่ไม่มีคลิปเสร็จเกิน 25 นาที (เกณฑ์เดียวกับหน้าเว็บ)
  // จดครั้งเดียวต่อรอบที่ค้าง + จดตอนฟื้น ไม่ใช่ทุกนาที
  setInterval(() => {
    const now = Date.now();
    for (const [id, d] of devices) {
      const s = d.status || {}, ld = (meta[id] && meta[id].lastDone) || 0;
      const running = !!(d.ws && d.ws.readyState === 1) && ((typeof s.running === 'boolean') ? s.running : !!(s.state && s.state !== 'IDLE'));
      const stalled = running && ld > 0 && now - ld > 25 * 60000 && (!s.runMode || s.runMode === 'loop' || s.runMode === 'looppost');
      if (stalled && !d._stall) { d._stall = true; logEvent(id, 'stalled', `ไม่มีคลิปเสร็จมา ${Math.round((now - ld) / 60000)} นาที`); }
      else if (!stalled && d._stall) { d._stall = false; logEvent(id, 'recovered', 'กลับมาทำงานปกติ'); }
    }
  }, 60_000).unref();

  panelWss.on('connection', (ws) => {
    panels.add(ws);
    ws.send(JSON.stringify({ type: 'devices', devices: deviceList(), apkBuild: apkBuild() }));
    ws.send(JSON.stringify({ type: 'events', events: events.slice(-100), hourly: hourlySummary() }));
    sendTemplates(ws);
    sendSelPresets(ws);
    sendKwLib(ws);
    ws.send(affMsg());
    let pinFails = 0;   // ใส่ pin ผิดต่อ socket — เกินกำหนดตัดสาย กันเดา pin
    const pinOk = (p) => {
      if (timingSafeEq(p, LOCK_PIN)) return true;
      if (++pinFails >= 8) ws.close();
      return false;
    };
    ws.on('message', safe((buf) => {
      let m; try { m = JSON.parse(buf.toString()); } catch { return; }
      if (!m || typeof m !== 'object') return;   // JSON "null" parse ผ่านแต่ m.deviceId จะ throw
      if (m.deviceId && m.deviceId !== 'all' && !validId(m.deviceId)) return;
      // หน้าเว็บไม่มี pin ในโค้ดแล้ว — ถามเซิร์ฟเวอร์ว่า pin ถูกไหมเพื่อตัดสินว่าจะเบลอการ์ดเครื่องล็อกหรือเปล่า
      if (m.type === 'pincheck') { ws.send(JSON.stringify({ type: 'pinresult', ok: pinOk(m.pin) })); return; }
      // ล็อกเครื่องเดียว: ทุกคำสั่งที่ปลายทางเป็นเครื่องนี้ (หรือ 'all' ซึ่งรวมเครื่องนี้ด้วย) ต้องมี
      // pin ถูก. ด่านนี้อยู่ก่อน type ทุกตัวโดยตั้งใจ — cmd/shot/update/applysettings/kwadd/rename/
      // resetcount ฯลฯ วิ่งผ่านจุดนี้หมด ถ้าไปเช็คทีละ type จะลืมตัวที่เพิ่มทีหลังแน่นอน
      if ((m.deviceId === LOCKED_DEVICE || m.deviceId === 'all') && !pinOk(m.pin)) {
        ws.send(JSON.stringify({ type: 'locked', deviceId: m.deviceId }));
        return;
      }
      if (m.type === 'update') {
        // สั่งเครื่องอัปเดตแอปตัวเอง. แยกจาก type 'cmd' เหมือน 'shot' เพราะ cmd ทุกตัวล้างคิวคีย์เวิร์ด —
        // อัปเดตแล้วคิวหายจะเจ็บกว่าเดิม เพราะ watchdog ต้องใช้คำเดิมกู้ลูปกลับหลังแอปรีสตาร์ต
        const d = devices.get(m.deviceId);
        if (d && d.ws && d.ws.readyState === 1) d.ws.send(JSON.stringify({ action: 'update' }));
        else ws.send(JSON.stringify({ type: 'updatestat', deviceId: m.deviceId, msg: 'เครื่องออฟไลน์' }));
        return;
      }
      if (m.type === 'shot') {
        // ขอภาพหน้าจอจากเครื่อง — read-only ล้วน
        // แยกจาก type 'cmd' โดยตั้งใจ: cmd ทุกตัวจะ stashKwq()+kwq.delete() (ดูด้านล่าง)
        // = กดดูจอทีคิวคีย์เวิร์ดหายที ทั้งที่แค่อยากดูว่าเครื่องค้างหน้าไหน
        const d = devices.get(m.deviceId);
        if (d && d.ws && d.ws.readyState === 1) d.ws.send(JSON.stringify({ action: 'screenshot' }));
        else ws.send(JSON.stringify({ type: 'shot', deviceId: m.deviceId, at: Date.now(), img: '', err: 'เครื่องออฟไลน์' }));
        return;
      }
      if (m.type === 'affstats') {
        // ให้เครื่องเข้าไปอ่านยอด Affiliate ของบัญชีที่ active อยู่ตอนนี้. แยกจาก 'cmd' เหมือน 'shot' —
        // cmd ทุกตัวล้างคิวคีย์เวิร์ด ซึ่งการกดดูยอดไม่ควรไปแตะ. เครื่องปฏิเสธเองอีกชั้นถ้ากำลังรันงาน
        // (อ่านยอดต้องใช้หน้าจอ Shopee ชนกับลูปโพสต์) แต่เช็คที่นี่ก่อนจะได้ตอบเว็บได้ทันที
        const d = devices.get(m.deviceId);
        const reply = (ok, reason) => ws.send(JSON.stringify({ type: 'affstatsack', deviceId: m.deviceId, ok, reason }));
        if (!d || !(d.ws && d.ws.readyState === 1)) return reply(false, 'offline');
        if (d.status && d.status.running) return reply(false, 'running');
        if (!d.a11y) return reply(false, 'a11y');
        d.ws.send(JSON.stringify({ action: 'affstats' }));
        console.log('[fleet] affstats ->', m.deviceId);
        return reply(true, '');
      }
      if (m.type === 'cmd') {
        const kws = parseKeywords(m);            // [] = ไม่ใส่คีย์เวิร์ด (browse ทั่วไป) เหมือนเดิม
        const base = {
          keyword: kws[0] || '',
          rounds: Math.max(1, Math.min(50, parseInt(m.rounds, 10) || 1)),
          searchMode: m.searchMode || 'PRODUCT',
          account: Math.max(1, Math.min(3, parseInt(m.account, 10) || 1)),    // v2: switchaccount → which account
          count: Math.max(1, Math.min(99, parseInt(m.count, 10) || 5)),       // v2: post → how many clips
        };
        // NOTE: ไม่ส่ง `accounts` (จำนวนหมุน) อีกแล้ว — แอปวนตาม postAccountCount ที่ตั้งไว้ในเครื่องเอง
        // (ลบช่อง "บัญชี" บน dashboard ออก) ถ้าส่ง accounts มาจะไปทับค่าในเครื่อง
        const entries = m.deviceId === 'all'
          ? [...devices.entries()]
          : (devices.has(m.deviceId) ? [[m.deviceId, devices.get(m.deviceId)]] : []);
        let sent = 0;
        for (const [devId, d] of entries) {
          // คำสั่งใหม่ทุกครั้ง (รวม "หยุด") = ล้างคิวคีย์เวิร์ดเดิมทิ้งเสมอ — ไม่งั้นคนกดหยุดแล้ว
          // เซิร์ฟจะเห็น running=false แล้วยิงคำถัดไปให้เอง (เครื่องไม่ยอมหยุดสักที).
          // หยุด/พัก = ไม่ได้ตั้งใจทิ้งคำ → เก็บคิวไว้ก่อนลบ ให้กด "เอาคิวเดิมกลับมา" ได้
          // (สั่งงานใหม่ = ตั้งใจเปลี่ยนคำแล้ว ไม่เก็บ)
          // (หยุด/พัก/สลับบัญชี/รีบูต ฯลฯ = ไม่ได้ตั้งใจทิ้งคำ — สั่งงานใหม่เท่านั้นที่ถือว่าเปลี่ยนคำแล้ว)
          if (!KWQ_ACTIONS.includes(m.action)) stashKwq(devId);
          kwq.delete(devId);
          // สั่งงานเองแล้ว = ไม่ต้องเริ่มคำเดิมซ้ำให้อีก (ไม่งั้นคำสั่งค้างจะมายิงทับทีหลัง)
          restartWait.delete(devId);
          if (!(d.ws && d.ws.readyState === 1)) {
            // ออฟไลน์ตอนสั่ง → เก็บคำสั่งล่าสุดไว้ส่งให้ตอนเครื่องกลับมา (ภายใน PENDING_TTL_MS เท่านั้น
            // ไม่งั้น "สร้างคลิป" ที่สั่งเมื่อเช้าจะไปยิงตอนเย็น). เครื่องละ 1 คำสั่ง คำสั่งใหม่ทับของเก่า.
            // สลับเว็บแอคเคานต์ไม่เข้าคิว (แอปปิดตัวเอง ต้องมีคนอยู่กับเครื่อง)
            if (PENDING_ACTIONS.has(m.action)) {
              pendingCmds.set(devId, { payload: { ...base, action: m.action }, at: Date.now() });
              broadcast();
            }
            continue;
          }
          pendingCmds.delete(devId);   // ออนไลน์แล้วสั่งตรง = คำสั่งค้างเก่าหมดความหมาย
          // v1 apps (ver<2) don't understand loop/looppost. Fall back to the old `run`
          // (COLLECT_AND_GENERATE) so the buttons still do something; v1 can't auto-post, so
          // looppost just makes clips there. v2 UI has no rounds field → run a full batch (50).
          let action = m.action, rounds = base.rounds;
          if ((d.ver || 1) < 2 && (action === 'loop' || action === 'looppost')) {
            action = 'run';
            rounds = 50;
          }
          d.ws.send(JSON.stringify({ ...base, action, rounds }));
          sent++;
          // จำคำสั่งล่าสุดไว้ เผื่อ "เพิ่มคำเข้าคิว" ระหว่างที่รันอยู่ (ต้องรู้ว่ากำลังทำ action ไหน)
          if (KWQ_ACTIONS.includes(action)) { metaOf(devId).lastAction = action; metaOf(devId).lastRounds = rounds; }
          // ใส่มาหลายคำ + เป็นคำสั่งที่ "ค้นด้วยคีย์เวิร์ด" → ตั้งคิวไว้ เดี๋ยว kwqOnStatus ยิงคำถัดไปเอง
          if (kws.length > 1 && KWQ_ACTIONS.includes(action)) {
            kwq.set(devId, {
              list: kws, modes: kws.map(() => base.searchMode), idx: 0, action, base: { ...base, rounds },
              phase: 'RUN', started: false, blank: 0, sentAt: Date.now(), stopAt: 0,
            });
          }
        }
        // จำคีย์เวิร์ด/โหมดที่เพิ่งสั่ง ไว้เติมช่องให้ทุกเบราว์เซอร์ที่เปิดทีหลัง
        if (m.action !== 'cancel' && m.action !== 'pause' && m.action !== 'resume') {
          let dirty = false;
          for (const [devId] of entries) {
            const x = metaOf(devId);
            const txt = kws.join(', ');
            if (x.kw !== txt || x.searchMode !== base.searchMode) { x.kw = txt; x.searchMode = base.searchMode; dirty = true; }
          }
          if (dirty) { saveMeta(meta); broadcast(); }
        }
        console.log('[fleet] cmd', m.action, 'kw=' + kws.join(' | '), 'x' + base.rounds, '->', m.deviceId, `(${sent})`);
        logEvent(m.deviceId, 'cmd', `${m.action}${kws[0] ? ' "' + kws[0] + '"' : ''} → ส่งถึง ${sent}/${entries.length} เครื่อง`);
      } else if (m.type === 'kwtext') {
        // เว็บพิมพ์คีย์เวิร์ดค้างไว้ (ยังไม่กดสั่ง) → เก็บลง devices.json ทันที เปิดเครื่องอื่นก็เห็น
        const ids = m.deviceId === 'all' ? [...devices.keys()] : [m.deviceId];
        const txt = parseKeywords(m).join(', ');
        const mode = m.searchMode === 'SHOP' ? 'SHOP' : 'PRODUCT';
        let dirty = false;
        for (const id of ids) {
          if (!id) continue;
          const x = metaOf(id);
          if (x.kw !== txt || x.searchMode !== mode) { x.kw = txt; x.searchMode = mode; dirty = true; }
        }
        if (dirty) { saveMeta(meta); broadcast(); }
      } else if (m.type === 'kwadd') {
        // "เพิ่มคำเข้าคิว" ระหว่างเครื่องกำลังรัน — ต่อท้ายคิวเฉย ๆ ไม่แตะงานที่วิ่งอยู่
        // (สั่ง cmd ใหม่ทับไม่ได้: เซิร์ฟจะล้างคิวเดิม + แอปทิ้ง START ซ้อนอยู่แล้ว)
        // เจาะจงเครื่องเดียว ไม่รับ 'all' — เครื่องแต่ละตัวรันคนละคำ ต่อคิวรวมทีเดียวมั่วแน่
        const id = m.deviceId, d = devices.get(id);
        const ack = (ok, reason, q, extra) => ws.send(JSON.stringify({
          type: 'kwaddack', deviceId: id, ok, reason: reason || '',
          list: q ? q.list : [], modes: q ? q.modes : [], idx: q ? q.idx : 0,
          ...(extra || {}),
        }));
        const words = parseKeywords(m);
        // โหมดของคำที่เพิ่ง "+ คิว" = ค่า dropdown ณ ตอนกด (ผูกติดคำนั้นไปตลอด ไม่ใช่ทั้งคิว)
        const addMode = m.searchMode === 'SHOP' ? 'SHOP' : 'PRODUCT';
        if (!d || !(d.ws && d.ws.readyState === 1)) { ack(false, 'offline'); return; }
        if (!words.length) { ack(false, 'empty'); return; }
        let q = kwq.get(id);
        if (!q) {
          // ยังไม่มีคิว (สั่งด้วยคำเดียว) → สร้างคิวใหม่ โดยให้ช่องแรกเป็น "คำที่กำลังทำอยู่"
          // เพื่อให้ kwqOnStatus รอจนคำนั้นหมดสต็อกก่อนค่อยสลับไปคำที่เพิ่งเพิ่ม
          const st = d.status || {};
          const running = (typeof st.running === 'boolean') ? st.running : (st.state && st.state !== 'IDLE');
          if (!running) { ack(false, 'notrunning'); return; }
          // รู้ action ที่กำลังรันได้ 3 ทาง เรียงตามความน่าเชื่อ:
          //  1) status.runMode — เครื่องบอกมาเอง (แอปใหม่) แม่นเสมอ แม้เซิร์ฟเพิ่งรีสตาร์ท
          //  2) lastAction — คำสั่งล่าสุดที่สั่งจากเว็บ (จำใน devices.json)
          //  3) m.assume — คนหน้าเว็บยืนยันเองตอนระบบเดาไม่ได้ (แอปเก่า + งานที่เริ่มก่อนเปิดฟีเจอร์)
          const action = [st.runMode, metaOf(id).lastAction, m.assume]
            .find((a) => KWQ_ACTIONS.includes(a)) || '';
          if (!action) { ack(false, 'noaction'); return; }
          metaOf(id).lastAction = action; saveMeta(meta);
          const cur = String(st.keyword || '').trim();
          q = {
            // คำแรกเป็น placeholder ถ้าเครื่อง browse ทั่วไปอยู่ (คีย์ว่าง = คำเดิมหมดสต็อกไปแล้ว)
            // โหมดของคำที่รันอยู่ = โหมดตอนสั่งครั้งล่าสุด (ไม่ใช่ dropdown ตอนนี้ ซึ่งคนอาจเพิ่งสลับ)
            list: [cur || KWQ_PLACEHOLDER], modes: [metaOf(id).searchMode || 'PRODUCT'], idx: 0, action,
            base: {
              keyword: cur, rounds: metaOf(id).lastRounds || 1,
              searchMode: metaOf(id).searchMode || 'PRODUCT', account: 1, count: 5,
            },
            phase: 'RUN', started: true, blank: 0, sentAt: Date.now(), stopAt: 0,
          };
          kwq.set(id, q);
        }
        if (!q.modes) q.modes = q.list.map(() => q.base.searchMode || 'PRODUCT');   // คิวเก่าก่อนมีโหมดรายคำ
        // ซ้ำ = คำเดียวกัน "และโหมดเดียวกัน" (ร้าน:X กับ สินค้า:X คนละงาน ใส่คู่กันได้)
        const { added, left } = kwqAppend(q, words.map((w) => [w, addMode]), kwqMode);
        // คำย้ายเข้าคิวแล้ว → ล้างช่องที่พิมพ์ค้างไว้ (คิวจริงไปโชว์ที่ป้ายบนการ์ดแทน เพราะช่อง
        // ข้อความเดียวเก็บ "คำ+โหมด" ปนกันไม่ได้ — ถ้ายัดกลับไปจะกดสั่งใหม่แล้วโหมดเพี้ยน)
        const x = metaOf(id);
        const rest = left.map(([w]) => w).join(', ');          // เหลือคำไหนก็ให้ค้างในช่องพิมพ์ต่อ (ทุกเบราว์เซอร์)
        if (added && x.kw !== rest) { x.kw = rest; saveMeta(meta); }
        console.log('[fleet] kwadd ->', id, `+${added} คำ [${addMode}] (คิวรวม ${q.list.length}, อยู่คำที่ ${q.idx + 1}` +
          (left.length ? `, เต็ม เหลือ ${left.length} คำ` : '') + ')');
        ack(added > 0, added ? '' : (left.length ? 'full' : 'dup'), q, { added, left });
        broadcast();
      } else if (m.type === 'kwqrestore') {
        // "เอาคิวเดิมกลับมา" — คิวที่ stashKwq เก็บไว้ตอนกดหยุด/พัก (meta.lastKwq)
        //  - เครื่องว่าง → ตั้งคิวใหม่แล้วยิงคำแรกทันที (= กดสั่งงานให้เลย)
        //  - เครื่องกำลังรันคำอื่นอยู่ → ต่อท้ายคิวเหมือน "+ คิว" ไม่แตะงานที่วิ่งอยู่
        const id = m.deviceId, d = devices.get(id), x = metaOf(id);
        const ack = (ok, reason, q) => ws.send(JSON.stringify({
          type: 'kwqrestoreack', deviceId: id, ok, reason: reason || '',
          list: q ? q.list : [], modes: q ? q.modes : [], idx: q ? q.idx : 0,
          action: q ? q.action : '',     // โหมดที่คิวจะใช้ — เว็บเอาไปบอกคนกดว่า "กู้แล้วจะสร้าง+โพส"
        }));
        const lk = x.lastKwq;
        if (!d || !(d.ws && d.ws.readyState === 1)) { ack(false, 'offline'); return; }
        if (!lk || !Array.isArray(lk.list) || !lk.list.length) { ack(false, 'nokwq'); return; }
        // โหมดที่คิวจะใช้ทำคำถัดไป = "คำสั่งล่าสุดที่กดจากเว็บ" (lastAction) มาก่อน lk.action เสมอ.
        // 2026-08-21: ท่าที่คนใช้จริงคือ หยุด → กด "สร้าง+โพส" → กด "เอาคิวเดิมกลับมา" แต่ของเดิม
        // เอา lk.action (โหมดตอนที่คิวโดนเก็บ — ซึ่งอาจเป็น "สร้าง" เฉย ๆ จากเมื่อวาน) มาใช้ แถมทับ
        // lastAction ที่เพิ่งตั้งเป็น looppost ทิ้ง → พอจบคำแรก เซิร์ฟยิง START action:'loop' ให้
        // เครื่องปั่นคลิปต่อไปเรื่อย ๆ แต่ไม่โพสอีกเลย ทั้งที่คนกดสร้าง+โพสไปแล้ว (เครื่อง 389f เป็นแบบนี้).
        // ยึด lastAction = คิวทำต่อด้วยโหมดเดียวกับงานที่เครื่องกำลังรันอยู่ ซึ่งตรงกับที่คนเพิ่งกด
        const action = [x.lastAction, lk.action].find((a) => KWQ_ACTIONS.includes(a)) || 'looppost';
        // แกนเดียวกับที่ตัวกู้อัตโนมัติใช้ — ตรรกะอยู่ที่เดียว จะได้ไม่แยกกันเพี้ยนทีหลัง
        const { q, running, createdQ, added, left, skipped } = installKwq(id, d, lk, action);
        // ไม่ได้คำใหม่เข้าคิวเลยเพราะหมดสต็อกไปหมดแล้ว → ทิ้งของที่เก็บไว้ ไม่ต้องโชว์ปุ่มค้าง
        // และถ้าคิวนี้เพิ่งสร้างขึ้นมาเพื่อกู้ ก็เก็บกวาดทิ้ง (ไม่ทิ้งคิวเปล่า/คิวคำเดียวไว้หลอน)
        if (!added && skipped) {
          if (createdQ) kwq.delete(id);
          x.lastKwq = null; saveMeta(meta);
          console.log('[fleet] kwq restore', id, `ไม่เหลือคำให้กู้ (หมดสต็อกไปแล้ว ${skipped} คำ)`);
          ack(false, 'alldone'); broadcast(); return;
        }
        if (!q.list.length) { if (createdQ) kwq.delete(id); ack(false, 'nokwq'); return; }
        // กู้แล้วทิ้งของที่เก็บไว้ — คำอยู่ในคิวจริงแล้ว กดซ้ำไม่ควรได้คำซ้ำอีกชุด
        // ยกเว้นคำที่ยัดไม่ลงเพราะคิวเต็ม — เก็บไว้กู้รอบหน้า (เมื่อก่อนโดนล้างทิ้งไปทั้งก้อน)
        x.lastKwq = left.length
          ? { list: left.map(([w]) => w), modes: left.map(([, md]) => md), action, at: Date.now() }
          : null;
        x.lastAction = action; saveMeta(meta);
        if (!running) kwqSend(id, d, q);      // เครื่องว่าง → เริ่มคำแรกเลย (ยิง START ให้)
        else persistLiveKwq(id);              // ต่อท้ายคิวที่รันอยู่ = ไม่มี kwqSend มาเขียนไฟล์ให้
        console.log('[fleet] kwq restore ->', id,
          `+${added} คำ [${action}] (${running ? 'ต่อท้ายคิวที่รันอยู่' : 'เริ่มใหม่ทันที'}, คิวรวม ${q.list.length})`);
        ack(true, added ? '' : 'dup', q);
        broadcast();
      } else if (m.type === 'kwqdel') {
        // ลบคำออกจากคิวที่กำลังวิ่ง — ทีละคำ (i) หรือคำที่ยังไม่ได้ทำทั้งหมด (all)
        // ลบได้เฉพาะคำที่ "ยังไม่ได้เริ่ม" (i > idx) เท่านั้น: จะลบคำที่รันอยู่ต้องกดหยุดเอา ไม่งั้น
        // เซิร์ฟต้องยิง cancel ตามให้ = กลายเป็นปุ่มหยุดที่ซ่อนอยู่ในกากบาทเล็ก ๆ ซึ่งคนกดไม่ได้ตั้งใจ
        const id = m.deviceId, q = kwq.get(id);
        const ack = (ok, reason, n) => ws.send(JSON.stringify({
          type: 'kwqdelack', deviceId: id, ok, reason: reason || '', n: n || 0,
        }));
        if (!q) { ack(false, 'nokwq'); return; }
        if (m.all) {
          const cut = q.list.length - (q.idx + 1);
          if (cut <= 0) { ack(false, 'nothing'); return; }
          q.list = q.list.slice(0, q.idx + 1);
          q.modes = (q.modes || []).slice(0, q.idx + 1);
          console.log('[fleet] kwq del', id, `ล้างคำที่ยังไม่ได้ทำ ${cut} คำ (คำที่รันอยู่ไม่แตะ)`);
          ack(true, '', cut); broadcast(); return;
        }
        const i = parseInt(m.i, 10);
        if (!(Number.isInteger(i) && i > q.idx && i < q.list.length)) { ack(false, 'running'); return; }
        // กันแข่งกับคิวที่เพิ่งเลื่อน: เว็บวาดตอน idx เก่า พอกด × คิวอาจขยับไปแล้ว = ลบผิดคำ
        // ให้เว็บส่งคำที่มันเห็นมาด้วย ไม่ตรงเมื่อไหร่ = ไม่ลบ ให้ดูใหม่แล้วกดอีกที
        if (m.w && q.list[i] !== m.w) { ack(false, 'moved'); return; }
        const w = q.list[i];
        q.list.splice(i, 1);
        if (q.modes) q.modes.splice(i, 1);
        console.log('[fleet] kwq del', id, `"${w}" (เหลือ ${q.list.length} คำ)`);
        ack(true, '', 1); broadcast();
      } else if (m.type === 'kwqmode') {
        // สลับโหมดงาน (สร้าง ↔ สร้าง+โพส) โดยคิวคีย์เวิร์ดไม่หาย
        // กดปุ่มงานใหม่บนการ์ด = เซิร์ฟล้างคิวทิ้งเสมอ (ตั้งใจ ดู type 'cmd') → คนที่แค่อยากสลับโหมด
        // ต้องยอมเสียคิวทั้งก้อน แล้วพิมพ์คำใหม่ทีละคำ. ทางนี้เปลี่ยนแค่ action แล้วเริ่ม "คำเดิม" ใหม่
        const id = m.deviceId, d = devices.get(id), x = metaOf(id);
        const action = KWQ_ACTIONS.includes(m.action) ? m.action : '';
        const ack = (ok, reason) => ws.send(JSON.stringify({
          type: 'kwqmodeack', deviceId: id, ok, reason: reason || '', action,
        }));
        if (!action) { ack(false, 'badmode'); return; }
        if (!d || !(d.ws && d.ws.readyState === 1)) { ack(false, 'offline'); return; }
        const q = kwq.get(id);
        if (action === (q ? q.action : x.lastAction)) { ack(false, 'same'); return; }
        x.lastAction = action; saveMeta(meta);
        if (q) q.action = action;
        restartWait.delete(id);            // สั่งซ้ำระหว่างที่ยังรอหยุดอยู่ = เอาอันใหม่
        const st = d.status || {};
        const running = (typeof st.running === 'boolean') ? st.running : !!(st.state && st.state !== 'IDLE');
        if (!running) {
          // เครื่องว่างอยู่ → เริ่มด้วยโหมดใหม่ได้เลย ไม่ต้องหยุดอะไรก่อน
          if (q) kwqSend(id, d, q);
          else d.ws.send(JSON.stringify(restartCmd(id, st, action)));
          console.log('[fleet] kwq mode ->', id, `${action} (เครื่องว่าง — เริ่มให้เลย)`);
          ack(true, 'started'); broadcast(); return;
        }
        // กำลังรันอยู่ → ต้อง cancel ก่อน (แอปทิ้ง START ที่ซ้อนงานเดิม) แล้วค่อยยิงคำเดิมซ้ำ
        if (q) { q.phase = 'STOPPING'; q.redo = true; q.stopAt = Date.now(); }
        else restartWait.set(id, { ...restartCmd(id, st, action), at: Date.now(), stopAt: Date.now() });
        d.ws.send(JSON.stringify({ action: 'cancel' }));
        console.log('[fleet] kwq mode ->', id, `${action} — สั่งหยุดเพื่อเริ่มคำเดิมใหม่`);
        ack(true, ''); broadcast();
      } else if (m.type === 'kwqforget') {
        // ทิ้งคิวที่เก็บไว้ตอนกดหยุด/พัก (ปุ่ม ↺) — ไม่อยากกู้แล้ว ป้ายจะได้ไม่ค้างอยู่บนการ์ด
        const x = metaOf(m.deviceId);
        if (!x.lastKwq) return;
        console.log('[fleet] kwq forget', m.deviceId, `(ทิ้ง ${x.lastKwq.list.length} คำ)`);
        x.lastKwq = null; saveMeta(meta); broadcast();
      } else if (m.type === 'getsettings' || m.type === 'applysettings') {
        // v3 remote settings — เจาะจงเครื่องเดียวเสมอ (ไม่มี broadcast 'all' โดยตั้งใจ กันตั้งค่า
        // พลาดใส่ทุกเครื่อง) และส่งเฉพาะเครื่อง ver>=3 ที่รองรับ; เครื่องเก่าตอบ error กลับ panel นี้
        const d = devices.get(m.deviceId);
        const fail = (error) => ws.send(JSON.stringify({ type: 'settingserr', deviceId: m.deviceId, error }));
        if (!d || !(d.ws && d.ws.readyState === 1)) { fail('offline'); return; }
        if ((d.ver || 1) < 3) { fail('oldapp'); return; }
        if (m.type === 'getsettings') {
          d.ws.send(JSON.stringify({ action: 'getsettings' }));
        } else {
          const safe = pickSafeSettings(m.settings);
          if (!Object.keys(safe).length) { fail('empty'); return; }
          d.ws.send(JSON.stringify({ action: 'applysettings', settings: safe }));
          console.log('[fleet] applysettings ->', m.deviceId, Object.keys(safe).join(','));
        }
      } else if (m.type === 'pushselectors') {
        // ปุ่ม "ส่ง selector ล่าสุดเข้าเครื่อง" — ค่าเอาจาก selector-presets.json บนเซิร์ฟเท่านั้น
        // (คนหน้าเว็บพิมพ์เองไม่ได้). เจาะจงเครื่องเดียว, เฉพาะ ver>=4. เครื่องมี fallback hardcode.
        const d = devices.get(m.deviceId);
        const fail = (error) => ws.send(JSON.stringify({ type: 'selectorserr', deviceId: m.deviceId, error }));
        if (!d || !(d.ws && d.ws.readyState === 1)) { fail('offline'); return; }
        if ((d.ver || 1) < 4) { fail('nover'); return; }
        const ov = loadSelPresets();   // source of truth = ไฟล์บนเซิร์ฟ, ไม่รับค่าจาก panel
        d.ws.send(JSON.stringify({ action: 'applyselectors', overrides: ov }));
        console.log('[fleet] pushselectors ->', m.deviceId, Object.keys(ov).join(','));
      } else if (m.type === 'setrotation') {
        // ตั้งค่า "วนเทมเพลตทุกชั่วโมง" ต่อเครื่อง — เครื่องที่ไม่เปิด (default) ไม่โดนแตะเลย
        const names = (Array.isArray(m.names) ? m.names : []).map(String).filter((n) => templates[n]).slice(0, 24);
        rot[m.deviceId] = { on: m.on === true && names.length > 0, names, idx: -1, cur: '' };
        saveRot(rot); broadcast();
      } else if (m.type === 'rotatenow') {
        // ปุ่มทดสอบ/บังคับหมุนทันที — ใช้ตัวเดียวกับ tick รายชั่วโมง
        if (advanceRotation(m.deviceId)) { saveRot(rot); broadcast(); }
      } else if (m.type === 'savetemplate') {
        const name = String(m.name || '').trim().slice(0, 40);
        if (!name) return;
        // ชื่อบัญชีห้ามติดไปกับเทมเพลตเด็ดขาด (เทมเพลตใช้ร่วมกันทั้งฝูง): เอาไปกดใส่อีกเครื่อง
        // เครื่องนั้นจะพยายามสลับไปบัญชีที่ตัวเองไม่ได้ล็อกอิน และช่องที่ว่างจะทำให้บัญชีนั้นหลุด
        // ออกจากรอบหมุนทันที. PER_DEVICE_KEYS กันเฉพาะตอน "หมุนอัตโนมัติ" — อันนี้กันตอนกดใช้เอง
        const tplSettings = pickSafeSettings(m.settings);
        for (const k of ACCOUNT_NAME_KEYS) delete tplSettings[k];
        templates[name] = { settings: tplSettings, updatedAt: Date.now() };
        saveTemplates(templates); broadcastTemplates();
      } else if (m.type === 'deletetemplate') {
        delete templates[String(m.name || '')]; saveTemplates(templates); broadcastTemplates();
      } else if (m.type === 'kwsave') {
        // "บันทึกคำ" — เก็บคำที่พิมพ์ไว้เข้าคลังกลาง ให้ทุกเบราว์เซอร์/ทุกคนหยิบไปใช้ซ้ำได้
        // ไม่ผูกกับเครื่องไหน (deviceId ที่ส่งมาใช้แค่ตอบ ack กลับไปโชว์ที่ปุ่มของการ์ดนั้น)
        const words = parseKeywords(m);
        const mode = m.searchMode === 'SHOP' ? 'SHOP' : 'PRODUCT';
        let added = 0;
        const dev = String(m.deviceId || '').slice(0, 64);
        for (const w of words) {
          // ซ้ำ = คำ+โหมด+เครื่องเดียวกัน (คำเดียวกันบันทึกไว้คนละเครื่องได้ ต่างคนต่างคลัง)
          if (kwLib.some((it) => it.w === w && it.mode === mode && (it.dev || '') === dev)) continue;
          kwLib.unshift({ w, mode, dev, at: Date.now() });
          added++;
        }
        kwLib = trimKwLib(kwLib);                                             // เก่าสุด "ของเครื่องนั้น" หล่นก่อน
        ws.send(JSON.stringify({
          type: 'kwsaveack', deviceId: m.deviceId || '', ok: added > 0, added,
          reason: !words.length ? 'empty' : (added ? '' : 'dup'),
        }));
        if (added) {
          saveKwLib(kwLib); broadcastKwLib();
          console.log('[fleet] kwsave', dev || '(ของกลาง)', `+${added} คำ [${mode}] (คลังรวม ${kwLib.length})`);
        }
      } else if (m.type === 'kwskip') {
        // "ข้ามคำนี้" — × ตรงคำที่กำลังรัน (2026-10-14). เส้นทางเดียวกับ "คำหมดสต็อก" เป๊ะ (kwqOnStatus/kwnext):
        // จดว่าทำแล้ว (ไม่ย้อนกลับเข้าคิวตอน "เอาคิวเดิมกลับมา") → สั่งหยุด → พอเครื่องหยุด kwqNext ยิงคำถัดไปให้เอง.
        // ไม่มีคำถัดไปให้ข้ามไป = ไม่ทำ (ให้กด "หยุด") และต้องตรงกับคำที่เว็บเห็น กันกดค้างหลังคิวขยับไปแล้ว
        const id = m.deviceId, d = devices.get(id), q = kwq.get(id);
        const ack = (ok, reason) => ws.send(JSON.stringify({ type: 'kwskipack', deviceId: id, ok, reason: reason || '' }));
        if (!d || !(d.ws && d.ws.readyState === 1)) { ack(false, 'offline'); return; }
        if (!q || q.phase === 'STOPPING') { ack(false, 'noqueue'); return; }
        const cur = q.list[q.idx];
        if (String(m.w || '').trim() !== cur) { ack(false, 'moved'); return; }
        if (q.idx + 1 >= q.list.length) { ack(false, 'last'); return; }
        markKwDone(id, cur, kwqMode(q, q.idx));
        console.log('[fleet] kwskip', id, `"${cur}" ผู้ใช้สั่งข้าม — สั่งหยุดเพื่อสลับคำถัดไป`);
        q.phase = 'STOPPING'; q.stopAt = Date.now();
        d.ws.send(JSON.stringify({ action: 'cancel' }));
        ack(true); broadcast();
      } else if (m.type === 'kwdel') {
        // "ลบคำ" — ลบออกจากคลัง = หายทุกเบราว์เซอร์ (ไม่แตะคิวที่เครื่องกำลังรันอยู่)
        // ลบเฉพาะคำของเครื่องที่ระบุมา (dev) — คำเดียวกันของเครื่องอื่นไม่โดนไปด้วย
        const w = String(m.w || '').trim().slice(0, 60);
        const mode = m.mode === 'SHOP' ? 'SHOP' : 'PRODUCT';
        const dev = String(m.dev || '').slice(0, 64);
        const before = kwLib.length;
        kwLib = kwLib.filter((it) => !(it.w === w && it.mode === mode && (it.dev || '') === dev));
        if (kwLib.length !== before) {
          saveKwLib(kwLib); broadcastKwLib();
          console.log('[fleet] kwdel', dev || '(ของกลาง)', `"${w}" [${mode}] (เหลือ ${kwLib.length})`);
        }
      } else if (m.type === 'rename') {
        metaOf(m.deviceId).name = (m.name || '').slice(0, 40); saveMeta(meta); broadcast();
      } else if (m.type === 'resetcount') {
        const x = metaOf(m.deviceId); x.collected = 0; x.generated = 0; x.posted = 0; saveMeta(meta); broadcast();
      }
    }));
    ws.on('close', () => panels.delete(ws));
    ws.on('error', (e) => console.error('[fleet] panel ws error:', e && e.message));
  });

  // ---- upgrade routing + auth ----
  server.on('upgrade', (req, socket, head) => {
    const url = (req.url || '').split('?')[0];
    if (url === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit('connection', ws, req));
    } else if (url === '/fleet/ws') {
      sessionMw(req, {}, () => {
        if (req.session && req.session.fleet) {
          panelWss.handleUpgrade(req, socket, head, (ws) => panelWss.emit('connection', ws, req));
        } else { socket.destroy(); }
      });
    }
  });

  // ---- separate login + pages ----
  const requireFleet = (req, res, next) =>
    (req.session && req.session.fleet) ? next() : res.redirect('/fleet/login');

  // brute-force throttle ต่อ IP (in-memory, ไม่ต้องพึ่ง dependency)
  const loginHits = new Map();                 // ip -> { count, first }
  const WINDOW_MS = 15 * 60 * 1000, MAX_TRIES = 10;
  const isLocked = (ip) => {
    const now = Date.now(), h = loginHits.get(ip);
    if (!h || now - h.first > WINDOW_MS) { loginHits.set(ip, { count: 0, first: now }); return false; }
    return h.count >= MAX_TRIES;
  };
  const bumpFail = (ip) => { const h = loginHits.get(ip); if (h) h.count++; };
  // loginHits ไม่เคยถูกล้าง — IP แปลกหน้าทุกตัวค้างใน Map ตลอดไป
  setInterval(() => { const now = Date.now(); for (const [k, h] of loginHits) if (now - h.first > WINDOW_MS) loginHits.delete(k); }, 10 * 60 * 1000).unref();

  // ตรวจสุขภาพ: ไม่ต้องล็อกอิน (ให้สคริปต์ watchdog/uptime monitor เรียกได้) — คืนเฉพาะตัวเลข ไม่มีข้อมูลเครื่อง
  const bootAt = Date.now();
  app.get('/healthz', (req, res) => {
    let online = 0, total = 0;
    for (const d of devices.values()) { total++; if (d.ws && d.ws.readyState === 1) online++; }
    res.json({ ok: true, uptimeSec: Math.round((Date.now() - bootAt) / 1000), online, total });
  });

  app.get('/fleet/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'fleet-login.html')));
  app.post('/fleet/login', (req, res) => {
    const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
    if (isLocked(ip)) return res.redirect('/fleet/login?e=2');   // ลองผิดเกินกำหนด → ล็อกชั่วคราว
    if (req.body && timingSafeEq(req.body.password, FLEET_PASSWORD)) {
      loginHits.delete(ip);
      // regenerate กัน session fixation
      return req.session.regenerate(() => { req.session.fleet = true; res.redirect('/fleet'); });
    }
    bumpFail(ip);
    res.redirect('/fleet/login?e=1');
  });
  app.get('/fleet/logout', (req, res) => { if (req.session) req.session.fleet = false; res.redirect('/fleet/login'); });
  // APK สำหรับให้เครื่องอัปเดตตัวเอง (OTA). ไม่ผ่าน requireFleet เพราะเครื่องไม่มี session ล็อกอิน —
  // ใช้ ENROLL_SECRET เป็นกุญแจแทน ซึ่งเครื่องมีอยู่แล้วสำหรับลงทะเบียน และคนที่รู้ค่านี้ก็ลงทะเบียน
  // เครื่องปลอมได้อยู่แล้ว จึงไม่ได้เปิดช่องทางใหม่. เก็บไฟล์ใน data/ ไม่ใช่ public/ เพื่อไม่ให้หลุด
  // เป็น static ที่ใครก็โหลดได้โดยไม่ต้องมีกุญแจ
  app.get('/fleet/apk', (req, res) => {
    if (!timingSafeEq(req.query.k, ENROLL_SECRET)) return res.sendStatus(403);
    const f = path.join(__dirname, 'data', 'pondy-app.apk');
    if (!fs.existsSync(f)) return res.status(404).send('no apk uploaded');
    res.sendFile(f);
  });
  app.get('/fleet', requireFleet, (req, res) => res.sendFile(path.join(__dirname, 'public', 'fleet.html')));
  app.get('/fleet/api/devices', requireFleet, (req, res) => res.json(deviceList()));
  app.get('/fleet/api/aff', requireFleet, (req, res) => res.json(aff));

  console.log('[fleet] v2 ready: /agent (phones), /fleet (dashboard)');
}

module.exports = { setupFleet, kwqAppend, KWQ_MAX, KWQ_PLACEHOLDER, recordAff, affIsoDate };
