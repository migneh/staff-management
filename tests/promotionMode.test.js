'use strict';
// تكامل البوابتين: نمط النقاط لا يتغير، والدرجتان تتبادلان بسياسة حيّة تُبطل كاشها
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const settings = require('../src/services/settings');
const promo = require('../src/services/promotions');
const rules = require('../src/services/promotionRules');
const { pointsFor } = require('../src/services/points');

beforeEach(() => {
  openMemoryDb();
  // نافذة الانتقالية (D7) خارج هذا الاختبار: لا انطلاقة مدبوغة هنا
  settings.resetPolicy('points_epoch_started_at');
  // والنمط البدئي points مع كل قاعدة جديدة
  settings.resetPolicy('promotion.mode');
  settings.resetPolicy('promotion.bothLogic');
});

/**
 * عضو إشراف (Moderator) مادي كامل: ثلاثة أشهر فأكثر (120 يوماً)، نافذة 90
 * يوماً فيها نشاط وإجراءات كافيات، وكل مخالفاته صفراً. مُحددات الحصيلة:
 *  غني: rowsPerDay 17 وإجراءات 180 → درجة 95.5 (يفوق العتبة 70 حتماً).
 *  فقير: rowsPerDay 6 وإجراءات 40 → درجة 59.6 (يفوت العتبة حتماً).
 * كلا الرقمين حتمي لأن كل عوامله شاهدات (نشاط/إنتاجية/جودة/سرعة/انضباط).
 *
 * @param {string} id معرّف العضو
 * @param {object} opts { points, rich, negativeNotes }
 * @returns {object} صف staff_members بعد كل المادّة
 */
function seedModerator(id, { points = 550, rich = true, negativeNotes = 0 } = {}) {
  const db = getDb();
  const since = clock.addDays(clock.today(), -120);
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, response_speed, supervisor_rating)
    VALUES (?, ?, 'moderation', 'Moderator', 'active', ?, ?, 25, 25)`).run(id, id, since, since);

  const activeDays = 28;
  const rowsPerDay = rich ? 17 : 6;
  const actions = rich ? 180 : 40;
  const activity = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES (?, '1', 'staff', 0.25, ?)`);
  for (let d = 0; d < activeDays; d++) {
    const day = clock.addDays(clock.today(), -d);
    for (let k = 0; k < rowsPerDay; k++) activity.run(id, day);
  }
  // الإجمالي (180 أو 40) يفوق بوابة الإجراءات 30، والجادّ 5 يقضي بوابة النزاعات —
  // والباقي روتين لا يُعد نزاعاً (نفس مزيج core.test).
  const act = db.prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason) VALUES (?, 'x', ?, 'r')`);
  for (let k = 0; k < 5; k++) act.run(id, 'warn');
  for (let k = 5; k < actions; k++) act.run(id, 'delete');

  // زرع نقاط على العصر صفر بـ INSERT مباشر (نمط seedLedger في core.test) ليتجاوز
  // القيود اليومية — البوابة تقرأ مجموع العصر الحالي فقط.
  const perRow = pointsFor('faq_contrib');
  const rows = Math.floor(points / perRow);
  const stmt = db.prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch)
    VALUES (?, ?, 'faq_contrib', 'رصيد مُزرَع للاختبار', 'seed', ?, 0)`);
  for (let k = 0; k < rows; k++) stmt.run(id, perRow, `${id}_seed${k}`);
  db.prepare('UPDATE staff_members SET rank_epoch = 0 WHERE user_id = ?').run(id);

  const note = db.prepare(`INSERT INTO staff_notes (user_id, note_type, content, added_by) VALUES (?, 'negative', 'قرار خاطئ', 'mgr')`);
  for (let k = 0; k < negativeNotes; k++) note.run(id);

  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

const label90 = '3 شهور'; // windowLabel(90) — نافذة رتبة Moderator
const labels = ev => ev.checks.map(c => c.label);
const failing = ev => ev.checks.filter(c => !c.pass).map(c => c.label);

test('نمط points الافتراضي يبقي بُنية البوابتين كما كانت حرفياً (لقطات)', () => {
  const m = seedModerator('snap-points');
  const ev = promo.evaluate(m);
  assert.equal(ev.mode, 'points');
  assert.equal(ev.eligible, true, JSON.stringify(ev.checks));
  assert.deepEqual(
    labels(ev),
    ['مدة الخدمة بالرتبة', 'نقاط الترقية',
      `الإجراءات المعالجة (${label90})`, `حل النزاعات (${label90})`,
      `التواجد (${label90})`, `الإنذارات الرسمية (${label90})`,
      'سرعة الاستجابة (تقييم المشرف)', `القرارات الخاطئة (${label90})`, 'الحالة']);
  // عتبة 550 كاملة (لا انتقال) بقيمها وعروضها القديمة
  const gate = ev.checks.find(c => c.label === 'نقاط الترقية');
  assert.deepEqual(
    { pass: gate.pass, actual: gate.actual, required: gate.required },
    { pass: true, actual: '550', required: '550+' });
  assert.equal(ev.rule.from, 'Moderator');
  assert.equal(ev.rule.to, 'Senior Moderator');
});

test('نمط score يستبدل بوابة النقاط بالدرجة ضد عتبة الرتبة', () => {
  settings.setPolicy('promotion.mode', 'score');
  // نقاط يتيم (0): كانت ستسقط النقاط — في نمط الدرجة يَجوز بحسن حصيلته
  const m = seedModerator('score-only', { points: 0, rich: true });
  const ev = promo.evaluate(m);
  assert.equal(ev.mode, 'score');
  assert.ok(!labels(ev).includes('نقاط الترقية'), 'بوابة النقاط لا تُصدَر في نمط score');
  const gate = ev.checks.find(c => c.label === 'درجة الأداء');
  assert.deepEqual(
    { pass: gate.pass, actual: gate.actual, required: gate.required },
    { pass: true, actual: '95.5', required: '70+' });
  assert.equal(ev.eligible, true);
  // والدرجة الفقيرة تفوت العتبة الافتراضية 70 بصريح: 59.6 < 70
  const poor = seedModerator('score-poor', { points: 0, rich: false });
  const ev2 = promo.evaluate(poor);
  assert.deepEqual(
    { pass: ev2.checks.find(c => c.label === 'درجة الأداء').actual, eligible: ev2.eligible },
    { pass: '59.6', eligible: false });
  assert.deepEqual(failing(ev2), ['درجة الأداء']);
});

test('نمط both بمنطق all (الافتراضي): تطلُّب البوابتين معاً', () => {
  settings.setPolicy('promotion.mode', 'both');
  // نقاط ساقطة ودرجة سليمة → البوابة الناقصة وحدها تُبطل الأهلية
  const m = seedModerator('both-points-bad', { points: 0, rich: true });
  const ev = promo.evaluate(m);
  assert.ok(labels(ev).includes('نقاط الترقية'));
  assert.ok(labels(ev).includes('درجة الأداء'));
  assert.deepEqual(failing(ev), ['نقاط الترقية']);
  assert.equal(ev.eligible, false);
  // والعكس: نقاط تجتاز ودرجة تفوت — الدرجة وحدها تُبطل
  const m2 = seedModerator('both-score-bad', { points: 550, rich: false });
  const ev2 = promo.evaluate(m2);
  assert.deepEqual(failing(ev2), ['درجة الأداء']);
  assert.equal(ev2.eligible, false);
});

test('نمط both بمنطق any: تكفي إحدى البوابتين مع سلامة بقيّة الشروط', () => {
  settings.setPolicy('promotion.mode', 'both');
  settings.setPolicy('promotion.bothLogic', 'any');
  // نقاط ساقطة ودرجة سالمة → يعفى بدرجته
  const m = seedModerator('any-points-bad', { points: 0, rich: true });
  const ev = promo.evaluate(m);
  assert.deepEqual(failing(ev), ['نقاط الترقية']);
  assert.equal(ev.eligible, true);
  // والعكس: درجة تفوت ونقاط سالمة → يعفى بنقاطه
  const m2 = seedModerator('any-score-bad', { points: 550, rich: false });
  const ev2 = promo.evaluate(m2);
  assert.deepEqual(failing(ev2), ['درجة الأداء']);
  assert.equal(ev2.eligible, true);
  // وإسقاط البوابتين معاً: منطق any لا يعفي حين تفوتان معاً
  const m3 = seedModerator('any-both-bad', { points: 0, rich: false });
  const ev3 = promo.evaluate(m3);
  assert.deepEqual(failing(ev3), ['نقاط الترقية', 'درجة الأداء']);
  assert.equal(ev3.eligible, false);
});

test('الضبط الحيّ يحدّث البوابة لاحقةً بلا إعادة تشغيل (تجاوز ثم إرجاع)', () => {
  settings.setPolicy('promotion.mode', 'score');
  // الغني بدرجته 95.5 لا تبلغ العتبة 98 المرفوعة من واجهة الضبط
  const res = rules.setRule('moderation', 'Moderator', { scoreThreshold: 98 });
  assert.equal(res.ok, true);
  const m = seedModerator('live-override', { points: 0, rich: true });
  const ev = promo.evaluate(m);
  const gate = ev.checks.find(c => c.label === 'درجة الأداء');
  assert.deepEqual(
    { pass: gate.pass, required: gate.required },
    { pass: false, required: '98+' });
  assert.equal(ev.eligible, false);
  // الإرجاع يعيد الثوابت فيرى العتبة الافتراضية معادلةً
  rules.resetRule('moderation', 'Moderator');
  const ev2 = promo.evaluate(m);
  assert.deepEqual(
    { pass: ev2.checks.find(c => c.label === 'درجة الأداء').pass, required: ev2.checks.find(c => c.label === 'درجة الأداء').required },
    { pass: true, required: '70+' });
  assert.equal(ev2.eligible, true);
});
