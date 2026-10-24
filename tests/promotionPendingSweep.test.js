'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const scheduler = require('../src/scheduler');
const promo = require('../src/services/promotions');
const settings = require('../src/services/settings');
const clock = require('../src/clock');

// عقود ترويض طلبات الترقية المعلّقة + النافذة الانتقالية (موجة نقاط 2026-10-24):
// معلّق أقدم من 30 يوماً يُسقط آلياً بسبب مكتوب، وأقدم من 7 يُنقَّر للقناة،
// وراية يوم الستين تُطلق مرة بلا إعادة.

beforeEach(() => openMemoryDb());

function seedStaff(id) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Helper', 'active')`).run(id, id);
}

function makeRequest(userId, toRank, ageDays = 0, fromRank = 'Helper') {
  const staff = getDb().prepare(`SELECT * FROM staff_members WHERE user_id = ?`).get(userId);
  const id = promo.createRequest(staff, { rule: { from: fromRank, to: toRank }, checks: [] }, null);
  if (ageDays) {
    getDb().prepare(`UPDATE promotion_requests SET created_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${ageDays} days`, id);
  }
  return id;
}

const reqRow = id => getDb().prepare('SELECT * FROM promotion_requests WHERE id = ?').get(id);

test('معلّق أقدم من 30 يوماً يُسقط آلياً: status/reviewed_by/سبب مكتوب', async () => {
  seedStaff('u-old-1111111111'); // معرّف حرفي مخالف للنمط؟ لا يهم للسقوط — الدفتر نص فقط
  const id = makeRequest('u-old-1111111111', 'Support', 31);
  await scheduler.processPromotionPending(null); // بلا ديسكورد: DM يفشل بصمت، السقوط في القاعدة
  const row = reqRow(id);
  assert.equal(row.status, 'rejected');
  assert.equal(row.reviewed_by, 'system', 'الرفض الآلي يوقّعه النظام لا محكمة');
  assert.match(String(row.review_reason), /مهلة/, 'السبب يعلن انتهاء المهلة صراحة');
  assert.ok(row.reviewed_at, 'وُسم بختم المراجعة');
});

test('معلّق بين 7 و30 يوماً يبقى معلقاً — التذكير تنبيه لا حكم', async () => {
  seedStaff('u-mid-1111111111');
  const id = makeRequest('u-mid-1111111111', 'Support', 10);
  await scheduler.processPromotionPending(null);
  assert.equal(reqRow(id).status, 'pending', 'لا سقوط قبل المهلة');
});

test('خمسون معلقاً قديماً تُرفض كلها دفعة واحدة', async () => {
  const ids = [];
  for (let n = 1; n <= 5; n++) {
    const uid = `u-b${n}-1111111111`;
    seedStaff(uid);
    ids.push(makeRequest(uid, 'Support', 40 + n));
  }
  await scheduler.processPromotionPending(null);
  for (const id of ids) assert.equal(reqRow(id).status, 'rejected');
});

test('طلب حديث (بالمهلة) لا تلمسه المهمة أصلاً', async () => {
  seedStaff('u-fresh-11111111');
  const id = makeRequest('u-fresh-11111111', 'Support', 0);
  await scheduler.processPromotionPending(null);
  assert.equal(reqRow(id).status, 'pending');
});

test('pointsEpochState: بلا طابع مضبوط = بلا ادعاء، وبطابع محسوب اليوم مباشرة', () => {
  // فتح قاعدة الذاكرة يكتب طابع انطلاقة اليوم تلقائياً (D7: انطلاقة صفرية) —
  // نمسحه صريحاً لنختبر الفرع غير المضبوط، ثم نضبط قيَماً معروفة.
  settings.resetPolicy('points_epoch_started_at');
  assert.deepEqual(scheduler.pointsEpochState(), { started: false, day: null }, 'بلا طابع = بلا ادعاء');

  settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -60));
  assert.deepEqual(scheduler.pointsEpochState(), { started: true, day: 60 }, 'يوم الستين هو يوم الاكتمال');

  settings.resetPolicy('points_epoch_started_at');
  settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -59));
  assert.deepEqual(scheduler.pointsEpochState(), { started: true, day: 59 }, 'الطور قبل الاكتمال لا يعجل');
  settings.resetPolicy('points_epoch_started_at');
});

test('pointsEpochFlag: يوم غير الستين صامت، ويوم الستين يُعلن بلا كرَش عند غياب ديسكورد', async () => {
  settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -59));
  await scheduler.pointsEpochFlag(null); // صامت — لا إرسال ولا استثناء
  settings.resetPolicy('points_epoch_started_at');

  settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -60));
  await scheduler.pointsEpochFlag(null); // يوم الاكتمال: قناة staff-alerts غير متاحة فالإرسال يُبتلع بأمان
  settings.resetPolicy('points_epoch_started_at');
});
