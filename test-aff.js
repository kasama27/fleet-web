// จดยอด Affiliate จาก status.acc ลงประวัติ (recordAff). รัน: node test-aff.js
const assert = require('assert');
// fleet.js require 'ws' ตอนโหลด — ปลอมไว้ให้เทสต์รันได้แม้ไม่มี node_modules (เหมือน test-kwadd.js)
const Module = require('module'), load = Module._load;
Module._load = (req, ...rest) => (req === 'ws' ? { WebSocketServer: class {} } : load(req, ...rest));
const { recordAff, affIsoDate } = require('./fleet');
Module._load = load;

assert.strictEqual(affIsoDate('18-09-2026'), '2026-09-18');
assert.strictEqual(affIsoDate('1-9-2026'), '2026-09-01');
assert.strictEqual(affIsoDate(''), '');
assert.strictEqual(affIsoDate('2026-09-18'), '');

const aff = (date, at, comm, range) => ({
  date, at, clicks: '209', orders: '1', sold: '1', sales: '308', comm, buyers: '1',
  month: { range, clicks: '3.7พัน', orders: '51', sold: '67', sales: '44พัน', comm: '2.4พัน', buyers: '43' },
});
const store = { accounts: {} };

// ยอดแรก: จดทั้งรายวันและรายเดือน (เดือนตามวันท้ายของช่วง)
assert.strictEqual(recordAff(store, 'devA', [
  { i: 1, name: 'shopA', aff: aff('18-09-2026', 1000, '27.7', '01-09-2026 - 18-09-2026') },
  { i: 2, name: 'shopB' },                      // ยังไม่เคยอ่านยอด → มี record ว่าง ๆ
  { i: 3, name: '' },                           // ช่องไม่มีชื่อ → ข้าม
]), true);
const a = store.accounts.shopA;
assert.deepStrictEqual(Object.keys(a.days), ['2026-09-18']);
assert.strictEqual(a.days['2026-09-18'].comm, '27.7');
assert.strictEqual(a.months['2026-09'].comm, '2.4พัน');
assert.strictEqual(a.months['2026-09'].range, '01-09-2026 - 18-09-2026');
assert.deepStrictEqual(Object.keys(store.accounts).sort(), ['shopA', 'shopB']);
assert.deepStrictEqual(store.accounts.shopB.days, {});

// heartbeat ซ้ำด้วยยอดเดิม (at เท่าเดิม) → ไม่เปลี่ยน ไม่ต้องเซฟ
assert.strictEqual(recordAff(store, 'devA', [
  { i: 1, name: 'shopA', aff: aff('18-09-2026', 1000, '27.7', '01-09-2026 - 18-09-2026') },
  { i: 2, name: 'shopB' },
]), false);

// วันใหม่ → เพิ่มวัน, เดือนเดิมถูกทับด้วยยอดสะสมล่าสุด, วันเก่ายังอยู่
recordAff(store, 'devA', [{ i: 1, name: 'shopA', aff: aff('19-09-2026', 2000, '50', '01-09-2026 - 19-09-2026') }]);
assert.deepStrictEqual(Object.keys(a.days).sort(), ['2026-09-18', '2026-09-19']);
assert.strictEqual(a.months['2026-09'].range, '01-09-2026 - 19-09-2026');

// error ที่ใหม่กว่ายอดล่าสุด → เก็บ; อ่านยอดได้ทีหลัง → error หายเอง
assert.strictEqual(recordAff(store, 'devA', [{ i: 1, name: 'shopA', aff: aff('19-09-2026', 2000, '50', '01-09-2026 - 19-09-2026'), affErr: { msg: 'A2: ไม่เจอ', at: 3000 } }]), true);
assert.strictEqual(a.err.msg, 'A2: ไม่เจอ');
recordAff(store, 'devA', [{ i: 1, name: 'shopA', aff: aff('20-09-2026', 4000, '60', '01-09-2026 - 20-09-2026'), affErr: { msg: 'A2: ไม่เจอ', at: 3000 } }]);
assert.strictEqual(a.err, null);

// บัญชีย้ายไปอยู่อีกเครื่อง/อีกช่อง → ตามไป ประวัติเดิมไม่หาย
assert.strictEqual(recordAff(store, 'devB', [{ i: 2, name: 'shopA' }]), true);
assert.strictEqual(a.dev, 'devB');
assert.strictEqual(a.slot, 2);
assert.strictEqual(Object.keys(a.days).length, 3);

console.log('test-aff: ok');
