// เทสต์กู้คิวคีย์เวิร์ดเองหลังเซิร์ฟรีสตาร์ต — ยกเซิร์ฟจริงขึ้นมาแล้วต่อ WS ปลอมเป็นโทรศัพท์
// รันในโฟลเดอร์ที่มี fleet.js + data/ + node_modules ของตัวเอง (ไม่แตะ /opt/off1)
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const WebSocket = require('ws');

const PORT = 18099;
const SECRET = 'pondy-fleet-2026';
const LOCKED = '98f270a08b653e05';
const DATA = path.join(__dirname, 'data');
const META = path.join(DATA, 'devices.json');

let fail = 0;
const ok = (name, cond, extra) => {
  console.log((cond ? '  ok   ' : '  FAIL ') + name + (cond || !extra ? '' : '  <- ' + extra));
  if (!cond) fail++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const seedMeta = (obj) => fs.writeFileSync(META, JSON.stringify(obj, null, 2));
const readMeta = () => JSON.parse(fs.readFileSync(META, 'utf8'));

// เซิร์ฟหนึ่งรอบชีวิต = หนึ่ง process ในความหมายของ module cache
function startServer() {
  for (const k of Object.keys(require.cache)) if (k.includes('fleet.js')) delete require.cache[k];
  const app = express();
  const server = http.createServer(app);
  const sessionMw = (req, res, next) => { req.session = { fleet: true }; next(); };
  require('./fleet').setupFleet(app, server, sessionMw);
  return new Promise((r) => server.listen(PORT, () => r(server)));
}

// โทรศัพท์ปลอม: เก็บทุกคำสั่งที่เซิร์ฟยิงมา
function phone(deviceId, ver = 12) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/agent`);
  const got = [];
  ws.on('message', (b) => { try { got.push(JSON.parse(b.toString())); } catch {} });
  return new Promise((r) => ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'register', secret: SECRET, deviceId, model: 'TEST', ver, a11y: true }));
    r({
      ws, got,
      status: (s) => ws.send(JSON.stringify({ type: 'status', ...s })),
      close: () => ws.close(),
    });
  }));
}

const starts = (p) => p.got.filter((x) => x.action && x.keyword !== undefined);

(async () => {
  const LIVE = (list, at = Date.now()) => ({
    list, modes: list.map(() => 'PRODUCT'), action: 'looppost',
    base: { keyword: '', rounds: 7, searchMode: 'PRODUCT', account: 2, count: 9 }, at,
  });

  // ── 1. เครื่องยังวิ่งอยู่ → กู้คิวแบบต่อท้าย ห้ามยิง START ทับงานที่ทำอยู่
  console.log('\n1. เครื่องกำลังรัน — ต่อท้ายคิว ไม่แตะงานที่วิ่งอยู่');
  seedMeta({ dev1: { name: 'dev1', liveKwq: LIVE(['ก', 'ข']), stopCount: 4, lastAction: 'looppost' } });
  let srv = await startServer();
  let p = await phone('dev1');
  await sleep(150);
  p.status({ state: 'FLOW_UPLOADING', running: true, keyword: 'กำลังทำคำนี้', stopCount: 4 });
  await sleep(300);
  ok('ไม่ยิง START ใส่เครื่องที่ทำงานอยู่', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('liveKwq ยังอยู่ในไฟล์', !!readMeta().dev1.liveKwq);
  ok('base เดิมไม่หาย (rounds=7)', (readMeta().dev1.liveKwq.base || {}).rounds === 7);
  p.close(); srv.close(); await sleep(150);

  // ── 2. เครื่องนิ่ง ไม่มีใครกดหยุด → เดินต่อให้เลย (เคสตายกลางจังหวะสลับคำ)
  console.log('\n2. เครื่องนิ่ง + ไม่มีใครกดหยุด — ยิงคำแรกให้');
  seedMeta({ dev2: { name: 'dev2', liveKwq: LIVE(['ค', 'ง']), stopCount: 2, lastAction: 'looppost' } });
  srv = await startServer();
  p = await phone('dev2');
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 2 });
  await sleep(300);
  const s2 = starts(p);
  ok('ยิง START ให้ 1 ครั้ง', s2.length === 1, `ยิงไป ${s2.length} ครั้ง`);
  ok('ใช้คำแรกในคิว', s2[0] && s2[0].keyword === 'ค', s2[0] && s2[0].keyword);
  ok('base เดิมถูกใช้จริง (rounds=7, account=2)', s2[0] && s2[0].rounds === 7 && s2[0].account === 2,
    s2[0] && `rounds=${s2[0].rounds} account=${s2[0].account}`);
  p.close(); srv.close(); await sleep(150);

  // ── 3. มีคนกดหยุดที่เครื่องตอนเซิร์ฟดับ → ห้ามปลุกกลับมาวิ่ง
  console.log('\n3. คนกดหยุดตอนเซิร์ฟดับ — ห้ามกู้ ต้องเก็บไว้ให้กดปุ่ม');
  seedMeta({ dev3: { name: 'dev3', liveKwq: LIVE(['จ', 'ฉ']), stopCount: 5, lastAction: 'looppost' } });
  srv = await startServer();
  p = await phone('dev3');
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 6 });   // 5 -> 6 = กดหยุดไป 1 ครั้ง
  await sleep(300);
  ok('ไม่ยิง START', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('ย้ายเข้า lastKwq ให้ปุ่มกู้', (readMeta().dev3.lastKwq || {}).list.join() === 'จ,ฉ');
  ok('ล้าง liveKwq แล้ว', readMeta().dev3.liveKwq === null);
  p.close(); srv.close(); await sleep(150);

  // ── 4a. เครื่องล็อก PIN + กำลังรัน → ต่อท้ายคิวได้ (กู้ของเดิม ไม่ใช่คำสั่งใหม่)
  console.log('\n4a. เครื่องล็อก PIN + กำลังรัน — ต่อท้ายคิวได้');
  seedMeta({ [LOCKED]: { name: 'ส่วนตัว', liveKwq: LIVE(['ฮ']), stopCount: 0, lastAction: 'looppost' } });
  srv = await startServer();
  p = await phone(LOCKED);
  await sleep(150);
  p.status({ state: 'FLOW_UPLOADING', running: true, keyword: 'ทำอยู่', stopCount: 0 });
  await sleep(300);
  ok('ไม่ยิง START (ต่อท้ายเฉย ๆ)', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('คิวยังอยู่ใน liveKwq', !!readMeta()[LOCKED].liveKwq);
  p.close(); srv.close(); await sleep(150);

  // ── 4b. เครื่องล็อก PIN + นิ่ง → ห้ามสั่งเริ่มงานให้เอง
  console.log('\n4b. เครื่องล็อก PIN + นิ่ง — ห้ามสั่งเริ่มงาน');
  seedMeta({ [LOCKED]: { name: 'ส่วนตัว', liveKwq: LIVE(['ช']), stopCount: 0, lastAction: 'looppost' } });
  srv = await startServer();
  p = await phone(LOCKED);
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 0 });
  await sleep(300);
  ok('ไม่ยิง START ใส่เครื่องล็อก', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('เก็บไว้ให้ปุ่ม (ซึ่งถาม PIN)', (readMeta()[LOCKED].lastKwq || {}).list.join() === 'ช');
  p.close(); srv.close(); await sleep(150);

  // ── 5. คิวเก่าเกิน 12 ชม. → ไม่ปลุกคิวผี
  console.log('\n5. คิวเก่าเกิน 12 ชม. — ไม่กู้อัตโนมัติ');
  seedMeta({ dev5: { name: 'dev5', liveKwq: LIVE(['ซ'], Date.now() - 13 * 3600_000), stopCount: 0 } });
  srv = await startServer();
  p = await phone('dev5');
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 0 });
  await sleep(300);
  ok('ไม่ยิง START', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('เก็บไว้ให้ปุ่ม', (readMeta().dev5.lastKwq || {}).list.join() === 'ซ');
  p.close(); srv.close(); await sleep(150);

  // ── 6. แอปเก่าไม่ส่ง stopCount + เครื่องนิ่ง → แยกไม่ออก อย่าเดา
  console.log('\n6. แอปเก่า (ไม่มี stopCount) + เครื่องนิ่ง — ไม่เดา');
  seedMeta({ dev6: { name: 'dev6', liveKwq: LIVE(['ฌ']) } });
  srv = await startServer();
  p = await phone('dev6', 2);
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '' });
  await sleep(300);
  ok('ไม่ยิง START', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('เก็บไว้ให้ปุ่ม', (readMeta().dev6.lastKwq || {}).list.join() === 'ฌ');
  p.close(); srv.close(); await sleep(150);

  // ── 7. กู้แล้วกู้ซ้ำไม่ได้ (status ตัวที่สองต้องไม่ยิงอีก)
  console.log('\n7. status ตัวถัดไปต้องไม่กู้ซ้ำ');
  seedMeta({ dev7: { name: 'dev7', liveKwq: LIVE(['ญ', 'ฎ']), stopCount: 0, lastAction: 'looppost' } });
  srv = await startServer();
  p = await phone('dev7');
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 0 });
  await sleep(250);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 0 });
  p.status({ state: 'COLLECTING', running: true, keyword: 'ญ', stopCount: 0 });
  await sleep(300);
  ok('ยิง START แค่ครั้งเดียว', starts(p).length === 1, `ยิงไป ${starts(p).length} ครั้ง`);
  p.close(); srv.close(); await sleep(150);

  // ── 8. ไม่มี liveKwq = ไม่ต้องทำอะไร (เครื่องปกติที่ไม่เคยตั้งคิว)
  console.log('\n8. เครื่องที่ไม่มีคิว — เงียบ');
  seedMeta({ dev8: { name: 'dev8' } });
  srv = await startServer();
  p = await phone('dev8');
  await sleep(150);
  p.status({ state: 'IDLE', running: false, keyword: '', stopCount: 0 });
  await sleep(300);
  ok('ไม่ยิงอะไรเลย', starts(p).length === 0, `ยิงไป ${starts(p).length} ครั้ง`);
  ok('ไม่สร้าง lastKwq หลอน', !readMeta().dev8.lastKwq);
  p.close(); srv.close(); await sleep(150);

  console.log(fail ? `\n${fail} เคสไม่ผ่าน` : '\nผ่านหมด');
  process.exit(fail ? 1 : 0);
})();
