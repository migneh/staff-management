'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const points = require('../src/services/points');
const settings = require('../src/services/settings');
const clock = require('../src/clock');
const cmd = require('../src/commands/my-points');

beforeEach(() => openMemoryDb());

function seedStaff(id, rankEpoch = 0) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, rank_epoch)
    VALUES (?, ?, 'support', 'Support', 'active', '2020-01-01 00:00:00', ?)`).run(id, id, rankEpoch);
}

test('/my-points — بطاقة السجل: الرصيد، التجميد، ووسم العصور القديمة (D3)', () => {
  seedStaff('u1', 1);
  // صف عصره الحالي: مكافأة شهرية موسومة باسبها المقروء
  const got = points.add({ userId: 'u1', reasonKey: 'best_month', refType: 'month', refId: '2026-02-01',
    addedBy: 'auto', reason: 'الأفضل في الشهر' });
  assert.equal(got.ok, true, String(got.reason));
  // صف عصر حديث بلا نص مقروء: العرض يستخدم السبب كما ورد (مفتاح) بلا ترجمة مصنوعة
  points.add({ userId: 'u1', reasonKey: 'absence_10d', refType: 'absence', refId: '2026-01-10', addedBy: 'auto' });
  // صف عصر سابق: يظهر موسوماً لا مخفيًا — الدفتر صادق مع الأعصور
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, rank_epoch, created_at)
    VALUES ('u1', 999, 'legacy', 'صف قديم', 0, '2025-12-01 00:00:00')`).run();

  const member = getDb().prepare(`SELECT * FROM staff_members WHERE user_id = 'u1'`).get();
  const freeze = points.isFrozen('u1');
  assert.equal(freeze.frozen, false);
  const card = cmd.renderLedger({
    member,
    rows: points.history('u1', 15),
    balance: points.getBalance('u1'),
    freeze,
  });
  const json = card.toJSON();
  const moves = json.fields.find(f => f.name.includes('الحركات'));
  assert.ok(moves, 'حقل الحركات موجود');
  assert.match(moves.value, /عصر سابق/, 'صف العصر القديم موسوم صريحاً');
  assert.match(moves.value, /الأفضل في الشهر/, 'السبب المقروء كما وُرد للدرفر');
  assert.match(moves.value, /absence_10d/, 'المفتاح غير الموسوم يظهر كما هو لا ترجمة مصنوعة');
  const balance = json.fields.find(f => f.name.includes('الرصيد'));
  assert.ok(balance && String(balance.value).trim() !== '', 'حقل الرصيد موجود وغير فارغ (الرقم منسّق arDigits لا يُتبنى نصاً هنا)');
  const toggleField = json.fields.find(f => f.name.includes('التجميد'));
  assert.match(toggleField.value, /لا تجميد/);
});

test('/my-points — التجميد الفاعل يعرض حتى متى وسببه (D3)', () => {
  seedStaff('u2', 0);
  getDb().prepare(`INSERT INTO point_freezes (user_id, until, reason)
    VALUES ('u2', '2030-01-01 00:00:00', 'ثلاثة تقييمات سلبية')`).run();
  const member = getDb().prepare(`SELECT * FROM staff_members WHERE user_id = 'u2'`).get();
  const card = cmd.renderLedger({
    member,
    rows: [],
    balance: 0,
    freeze: points.isFrozen('u2'),
  });
  const json = card.toJSON();
  const toggleField = json.fields.find(f => f.name.includes('التجميد'));
  assert.match(toggleField.value, /2030-01-01/);
  assert.match(toggleField.value, /ثلاثة تقييمات سلبية/);
  assert.match(json.description, /العصر الحالي/, 'وصف البطاقة يعلن العصر كي يفهم الرصيد بمرجعه');
});

test('/my-points — بلا حركات: لا يبهت السجل بل يقول دليلها (D3)', () => {
  seedStaff('u3', 0);
  const member = getDb().prepare(`SELECT * FROM staff_members WHERE user_id = 'u3'`).get();
  const card = cmd.renderLedger({ member, rows: [], balance: 0, freeze: points.isFrozen('u3') });
  const moves = card.toJSON().fields.find(f => f.name.includes('الحركات'));
  assert.match(moves.value, /لا حركات بعد/);
});

test('/my-points — التنفيذ: رد خفي للمسجَّل، وفحص الحدث فعّال (D3)', async () => {
  const execute = cmd.commands[0].execute;
  assert.ok(cmd.commands[0].data.toJSON().name === 'my-points');
  seedStaff('u5', 0);
  const replies = [];
  await execute({ user: { id: 'u5' }, reply: async p => { replies.push(p); } });
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ephemeral, true, 'السجل رد خفي للعضو لا إلى قناة');
  assert.ok(replies[0].embeds.length === 1);

  // إيقاف الميزة = رفض صريح لا تجاوز صامت
  settings.setFeatureToggle('myPointsCommand', false);
  const blocked = [];
  await execute({ user: { id: 'u5' }, reply: async p => { blocked.push(p); } });
  assert.equal(blocked.length, 1);
  assert.match(String(blocked[0].embeds?.[0]?.toJSON?.().description ?? ''), /معط/, 'رسالة الإيقاف صريحة');
  settings.resetFeatureToggles();

  // غير المسجل: رفض موثق
  const stranger = [];
  await execute({ user: { id: 'ghost' }, reply: async p => { stranger.push(p); } });
  assert.equal(stranger.length, 1);
  assert.match(String(stranger[0].embeds?.[0]?.toJSON?.().description ?? ''), /مسجل/, 'غير المسجل يُرفض بسجل واضح');
});

test('/my-points — بند «إلى العتبة»: عتبة انتقالية وتقدير وتيرة بأرقام عربية (موجة نقاط)', async () => {
  seedStaff('u7', 1); // رتبة Support وتيم support → العتبة الكاملة 500
  // النافذة الانتقالية (D7) منذ 10 أيام: floor(500/3)=166 !== ramped 83 → العتبة 166
  settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -10));
  const ins = getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, rank_epoch, created_at)
    VALUES (?, ?, ?, ?, 1, datetime('now', ?))`);
  ins.run('u7', 60, 'star_week', 'نجم الأسبوع', '-2 days');
  ins.run('u7', 40, 'faq_contrib', 'مقال معرفة', '-3 days');

  const replies = [];
  await cmd.commands[0].execute({ user: { id: 'u7' }, reply: async p => { replies.push(p); } });
  const card = replies[0].embeds[0].toJSON();
  const progress = card.fields.find(f => f.name.includes('عتبة'));
  assert.ok(progress, 'حقل «إلى عتبة الترقية» يظهر لرتبة ذات عتبة');
  assert.match(progress.value, /انتقالية/, 'الحالة الانتقالية معلنة صريحاً لا مخفية');
  assert.match(progress.value, /١٦٦/, 'عتبة اليوم 166 بأرقام عربية');
  assert.match(progress.value, /نقصك/, 'الفجوة قول لا تخمين');
  assert.match(progress.value, /وتيرتك/, 'الوتيرة من آخر 4 أسابيع ظاهرة');
  assert.match(progress.value, /٣ أسبوع/, 'وتيرة 25/أسبوع وفجوة 66 → تقدير 3 أسابيع');
  // السقوف المعلنة في ذيل البطاقة — العدالة تحتاج أساساً معروفاً لا مفاجآت
  assert.match(card.footer.text, /تكتات 20\/يوم/, 'سقف التكتات اليومي معلن');
  assert.match(card.footer.text, /شات 5\/يوم/, 'سقف الشات معلن');
  assert.match(card.footer.text, /تغطية 2\/يوم/, 'سقف التغطية معلن');
});

test('/my-points — أثناء التجميد: الوتيرة تُعلن متوقفة لا تُختلق', () => {
  const card = cmd.renderLedger({
    member: { user_id: 'u8', rank: 'Support', rank_epoch: 1 },
    rows: [],
    balance: 10,
    freeze: { frozen: true, until: '2030-01-01 00:00:00', reason: 'ثلاثة تقييمات سلبية' },
    progress: { base: 500, threshold: 166, transitional: true, daysLeft: 50, remaining: 156, past: 0, perWeek: 0, weeks: null, frozen: true },
  });
  const value = card.toJSON().fields.find(f => f.name.includes('عتبة')).value;
  assert.match(value, /متوقفة أثناء التجميد/, 'لا تقدير أسابيع وهمي لمجمَّد');
  assert.doesNotMatch(value, /تقدير/, 'لا وعد بأسابيع والتجميد قائم');
});
