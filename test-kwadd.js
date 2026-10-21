// กฎต่อคำเข้าคิว (+ คิว / กู้คิว) — ซ้ำ, คิวเต็ม, placeholder. รัน: node test-kwadd.js
const assert = require('assert');
// fleet.js require 'ws' ตอนโหลด แต่ repo นี้ไม่มี node_modules (อยู่บนเซิร์ฟ) — ปลอมให้พอโหลดผ่าน
const Module = require('module'), load = Module._load;
Module._load = (req, ...rest) => (req === 'ws' ? { WebSocketServer: class {} } : load(req, ...rest));
const { kwqAppend, KWQ_MAX, KWQ_PLACEHOLDER } = require('./fleet');
Module._load = load;
const modeOf = (q, i) => q.modes[i] || 'PRODUCT';
const Q = (list, modes) => ({ list: [...list], modes: [...(modes || list.map(() => 'PRODUCT'))] });

// คำใหม่เข้าคิวได้
let q = Q(['ก']);
assert.deepStrictEqual(kwqAppend(q, [['ข', 'PRODUCT']], modeOf), { added: 1, left: [] });
assert.deepStrictEqual(q.list, ['ก', 'ข']);

// ซ้ำ = คำ + โหมดเดียวกัน; ต่างโหมดไม่ใช่ซ้ำ
q = Q(['ก']);
assert.strictEqual(kwqAppend(q, [['ก', 'PRODUCT']], modeOf).added, 0);
assert.strictEqual(kwqAppend(q, [['ก', 'SHOP']], modeOf).added, 1);

// placeholder ช่องแรกไม่ใช่คำจริง — พิมพ์คำเดียวกันมาต้องเข้าคิวได้
q = Q([KWQ_PLACEHOLDER]);
assert.strictEqual(kwqAppend(q, [[KWQ_PLACEHOLDER, 'PRODUCT']], modeOf).added, 1);
// แต่ถ้าคำนั้นอยู่ช่องอื่น (คนใส่เองไปแล้ว) = ซ้ำจริง
assert.strictEqual(kwqAppend(q, [[KWQ_PLACEHOLDER, 'PRODUCT']], modeOf).added, 0);

// คิวเต็ม → คืนคำที่เหลือ ไม่ทิ้งเงียบ (บักเดิม: break แล้วหายไปเลย)
q = Q(Array.from({ length: KWQ_MAX - 1 }, (_, i) => 'w' + i));
const r = kwqAppend(q, [['a', 'PRODUCT'], ['b', 'PRODUCT'], ['c', 'SHOP']], modeOf);
assert.strictEqual(r.added, 1);
assert.deepStrictEqual(r.left, [['b', 'PRODUCT'], ['c', 'SHOP']]);
assert.strictEqual(q.list.length, KWQ_MAX);

// คิวเต็มพอดี = ไม่ได้เพิ่มเลย และทุกคำต้องถูกคืน (เว็บถึงจะบอกว่า "เต็ม" ไม่ใช่ "ซ้ำ")
const r2 = kwqAppend(q, [['z', 'PRODUCT']], modeOf);
assert.deepStrictEqual(r2, { added: 0, left: [['z', 'PRODUCT']] });

// list กับ modes ต้องยาวเท่ากันเสมอ ไม่งั้นโหมดรายคำเลื่อน
assert.strictEqual(q.list.length, q.modes.length);
console.log('kwqAppend: ผ่านหมด');
