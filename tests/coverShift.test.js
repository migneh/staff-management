'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const { commands } = require('../src/commands');
const points = require('../src/services/points');

// عقود /cover-shift (موجة نقاط 2026-10-24): مرجع فريد (اليوم + المغطى)،
// سقف يومي 2، المغطى عليه بصفة نشطة، وكل رفض بسببه الصريح لا صمتاً.

beforeEach(() => openMemoryDb());

const COV = '555555555555555555'; // القائم بالتغطية (المتفاعل)
const cmd = commands.get('cover-shift');
assert.ok(cmd, 'الأمر مسجّل في السجل');

function seedStaff(id, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'moderation', 'Moderator', ?)`).run(id, id, status);
}

function interaction(targetId, note = null) {
  const bag = {
    user: { id: COV },
    channelId: 'ch1',
    options: {
      getUser: () => (targetId ? { id: targetId } : null),
      getString: key => (key === 'note' ? note : null),
    },
    reply: async p => { bag.last = p; },
  };
  return bag;
}

const textOf = bag => bag.last.embeds[0].toJSON().description;

test('المغطى عليه غير نشط في الدفتر = رفض صريح لا نقاط', async () => {
  seedStaff(COV);
  seedStaff('666666666666666666', 'suspended');
  const bag = interaction('666666666666666666');
  await cmd.execute(bag);
  assert.match(textOf(bag), /بصفة نشطة/);
  assert.equal(points.getBalance(COV), 0);
});

// بوابة المُغطِّي (قرار المالك ضمن إحاطة ⑨): قاعدة المغطى عليه نفسها
// تنطبق على القائم بالتغطية — لا +3 لمن ليس في صفة عمله اليوم.

function noCoverRow() {
  const row = getDb().prepare(`SELECT 1 x FROM promotion_points WHERE user_id = ? AND reason_key = 'shift_cover'`).get(COV);
  return !row;
}

test('مُغطِّي على إجازة يُرفض قبل النقاط وبلا أثر في الدفتر', async () => {
  seedStaff(COV, 'on_leave');
  seedStaff('666111222333444555');
  const bag = interaction('666111222333444555');
  await cmd.execute(bag);
  assert.match(textOf(bag), /صفة عمله اليوم/, 'الرفض يشرح القاعدة لا يلتف عليها');
  assert.ok(noCoverRow(), 'لا صف تغطية في الدفتر — الإجازة لا تُجمع فوقها نقاط معلقة');
});

test('مُغطِّي موقوف يُرفض أيضاً بالبوابة الواحدة', async () => {
  seedStaff(COV, 'suspended');
  seedStaff('666111222333444555');
  const bag = interaction('666111222333444555');
  await cmd.execute(bag);
  assert.match(textOf(bag), /صفة عمله اليوم/);
  assert.ok(noCoverRow());
});

test('تغطية النفس رفض فوري — التغطية تعني انشغال زميل', async () => {
  seedStaff(COV);
  const bag = interaction(COV);
  await cmd.execute(bag);
  assert.match(textOf(bag), /لا تغطية لنفسك/);
});

test('القائم بالتسجيل غير مسجل في الدفتر يُمنع قبل أي حساب', async () => {
  seedStaff('666666666666666666');
  const bag = interaction('666666666666666666');
  await cmd.execute(bag);
  assert.match(textOf(bag), /لست مسجلاً/);
  assert.equal(points.getBalance('666666666666666666'), 0);
});

test('تغطية سليمة تمنح +3، وتكرار نفس المغطى في نفس اليوم يرفض', async () => {
  seedStaff(COV);
  seedStaff('666111222333444555');
  const bag = interaction('666111222333444555');
  await cmd.execute(bag);
  assert.match(textOf(bag), /سُجّلت تغطيتك/);
  assert.equal(points.getBalance(COV), 3);
  const again = interaction('666111222333444555');
  await cmd.execute(again);
  assert.match(textOf(again), /مسجّلة مسبقاً/);
  assert.equal(points.getBalance(COV), 3, 'الرصيد ثابت بعد محاولة التكرار');
});

test('سقف التغطية اليومي — الثالثة بمغطى آخر ترفض فصيحاً', async () => {
  seedStaff(COV);
  seedStaff('666111222333444555');
  seedStaff('666111222333444666');
  seedStaff('666111222333444777');
  const t1 = interaction('666111222333444555');
  await cmd.execute(t1);
  assert.equal(points.getBalance(COV), 3);
  const t2 = interaction('666111222333444666');
  await cmd.execute(t2);
  assert.equal(points.getBalance(COV), 6);
  const t3 = interaction('666111222333444777');
  await cmd.execute(t3);
  assert.match(textOf(t3), /سقف التغطية/);
  assert.equal(points.getBalance(COV), 6, 'الرصيد ثابت بعد رفض السقف');
});

test('المجمَّد تُرفض نقاطه بسببه صريحاً', async () => {
  seedStaff(COV);
  seedStaff('666111222333444555');
  points.freeze(COV, 3, 'ثلاث تقييمات سلبية');
  const bag = interaction('666111222333444555');
  await cmd.execute(bag);
  assert.match(textOf(bag), /مجمّدة/);
  assert.match(textOf(bag), /ثلاث تقييمات سلبية/, 'سبب التجميد يعرض لا يُخفى');
  assert.equal(points.getBalance(COV), 0);
});
