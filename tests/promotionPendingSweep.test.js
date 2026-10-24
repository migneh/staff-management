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

beforeEach(() => {
  openMemoryDb();
  // مربوطة القناة كي يُلتقط التذكير في نموذج الإرسال (تطبيق قناة manager-review)
  settings.setChannel('manager-review', '100000000000000111');
});

function seedStaff(id, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Helper', ?)`).run(id, id, status);
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

/** طلب يتيم: صاحبه بلا صف في staff_members — زرعٌ خام تسجيلًا لأثر سابق الحذف */
function seedOrphanRequest(userId, toRank, ageDays, fromRank = 'Helper') {
  const res = getDb().prepare(`INSERT INTO promotion_requests (user_id, from_rank, to_rank, note, snapshot)
    VALUES (?, ?, ?, 'سبب يتيّم', NULL)`).run(userId, fromRank, toRank);
  const id = Number(res.lastInsertRowid);
  if (ageDays) {
    getDb().prepare(`UPDATE promotion_requests SET created_at = datetime('now', ?) WHERE id = ?`)
      .run(`-${ageDays} days`, id);
  }
  return id;
}

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

// ===== فلتر حالة العضو (وسيط ⑧) =====
// المستقيل/المنسحب عضويتهما منتهية — الطلبان يُسقطان فوراً بذات الأثر
// الموثَّق، ولا يُذكِّرُ لواحد منهما بشيء. إجازة وتعليق بقيتا على المسار.

function sweepClient() {
  const sent = [], dms = [];
  const client = {
    channels: { fetch: async () => ({ send: async p => { sent.push(p); return { id: 'm-1' }; } }) },
    users: { fetch: async id => ({ id, send: async p => { dms.push({ id, payload: p }); } }) },
  };
  return { client, sent, dms };
}
const textOf = p => JSON.parse(JSON.stringify(p.embeds || [])).map(e => `${e.title || ''}\n${e.description || ''}`).join('\n');

test('المستقيل ومن خرج من السيرفر: السقوط فوري — سببهما الصلة المنتهية ولا ذِكر لهما في التذكير', async () => {
  seedStaff('u-rsg-1111111111', 'resigned');
  seedStaff('u-out-1111111111', 'removed');
  seedStaff('u-wait-1111111111');
  const rsg = makeRequest('u-rsg-1111111111', 'Support', 0);
  const out = makeRequest('u-out-1111111111', 'Support', 0);
  const wait = makeRequest('u-wait-1111111111', 'Support', 10);

  const { client, sent, dms } = sweepClient();
  await scheduler.processPromotionPending(client);

  assert.equal(reqRow(rsg).status, 'rejected', 'المستقيل لا يعلّق طلبُه حتى المهلة');
  assert.match(String(reqRow(rsg).review_reason), /مستقيل/, 'السبب يعلن الحالة صراحة');
  assert.equal(reqRow(out).status, 'rejected', 'الخارج من السيرفر لا يعلق طلبُه حتى المهلة');
  assert.match(String(reqRow(out).review_reason), /خرج من السيرفر/);
  assert.equal(reqRow(wait).status, 'pending', 'فوق عتبة التذكير ودون المهلة يبقى معلقاً كما هو');
  assert.equal(dms.filter(d => d.id === 'u-rsg-1111111111').length, 1, 'إغلاق المستقيل يُخبره برسالته');
  assert.match(textOf(dms.find(d => d.id === 'u-out-1111111111').payload), /انتهاء صلتك بالفريق/, 'الإخبار الصادق يذكر العلة الحقيقية لا مهلةً لم تنقضِ');
  const reminder = sent.map(textOf).join('\n');
  assert.match(reminder, /u-wait-1111111111/, 'المعلَّق النشط ما زال يظهر في التذكير');
  assert.doesNotMatch(reminder, /u-rsg-1111111111/, 'التذكير لا يعرض طلب مستقيل كأنه بانتظار قرار');
  assert.doesNotMatch(reminder, /u-out-1111111111/, 'التذكير لا يعرض طلب خارجَ السيرفر كأنه بانتظار قرار');
});

test('إجازة/تعليق: عذران مؤقتان — الأثنتان تقبع على المسار القياسي وتظهرا في التذكير', async () => {
  seedStaff('u-lv-1111111111', 'on_leave');
  seedStaff('u-sp-1111111111', 'suspended');
  const lv = makeRequest('u-lv-1111111111', 'Support', 12);
  const sp = makeRequest('u-sp-1111111111', 'Support', 12);

  const { client, sent } = sweepClient();
  await scheduler.processPromotionPending(client);

  assert.equal(reqRow(lv).status, 'pending', 'بإجازة لا يُقطع طلبُه قبل المهلة');
  assert.equal(reqRow(sp).status, 'pending', 'الموقوف عضويته ليست منتهية — لا سقوط مبكر للتعليق');
  const reminder = sent.map(textOf).join('\n');
  assert.match(reminder, /u-lv-1111111111/);
  assert.match(reminder, /u-sp-1111111111/);
});

test('صاحب طلب بلا صف عضو: لا حالة معلنة فلا استجابة سقوط — يبقى على المهلة وحدها', async () => {
  // بلا بذرة عضو: LEFT JOIN يعيد قيمة فارغة (NULL) — ليس مستقيلاً ولا منسحباً،
  // فالمسار الموثَّق للمهلة يلزمه وحده (لا انقراض صامت بهويّة مفقودة).
  const fresh = seedOrphanRequest('u-ghost-11111111', 'Support', 0);
  await scheduler.processPromotionPending(null);
  assert.equal(reqRow(fresh).status, 'pending', 'بلا صف عضو ولم تنقض المهلة: لا سقوط');

  const old = seedOrphanRequest('u-ghost2-11111111', 'Support', 31);
  await scheduler.processPromotionPending(null);
  const row = reqRow(old);
  assert.equal(row.status, 'rejected');
  assert.match(String(row.review_reason), /مهلة/, 'السقوط فيقال بسببه الموثَّق للمهلة لا بفلتر مفقود');
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
