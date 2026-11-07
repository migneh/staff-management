'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const rules = require('../src/services/promotionRules');

beforeEach(() => openMemoryDb());

const audits = actions =>
  getDb().prepare(`SELECT action FROM audit_logs WHERE action IN (${actions.map(() => '?').join(',')})`).all(...actions).map(r => r.action);

test('النمط الافتراضي points وقيم خارج القائمة تعود إليه — سياسة تالفة لا تعطّل الترقية', () => {
  assert.equal(rules.getMode(), 'points');
  settings.setPolicy('promotion.mode', 'score');
  assert.equal(rules.getMode(), 'score');
  settings.setPolicy('promotion.mode', 'بالنقاط');
  assert.equal(rules.getMode(), 'points', 'قيمة غريبة تعود للـافتراضي');
  const res = rules.setMode('نمطخيالي');
  assert.equal(res.ok, false);
  assert.match(res.errors[0], /points \/ score \/ both/);
  // والنمط لم يُكتب ولا دفتر يُسجل خاطفاً
  assert.equal(rules.getMode(), 'points');
  assert.equal(audits(['promotion_mode_updated']).length, 0);
});

test('setMode يُوثَّق بدفترٍ واحد واحدًا — تكرار النمط نفسه لا يكرر التدقيق', () => {
  const first = rules.setMode('both', 'actor-1');
  assert.equal(first.ok, true);
  assert.equal(rules.getMode(), 'both');
  const second = rules.setMode('both', 'actor-1');
  assert.equal(second.unchanged, true);
  assert.equal(audits(['promotion_mode_updated']).length, 1);
});

test('منطق الدمج: all الافتراضي وany مصرح، وقيمة غريبة تعود للافتراضي', () => {
  assert.equal(rules.getBothLogic(), 'all');
  const res = rules.setBothLogic('any');
  assert.equal(res.ok, true);
  assert.equal(rules.getBothLogic(), 'any');
  settings.setPolicy('promotion.bothLogic', 'كلها');
  assert.equal(rules.getBothLogic(), 'all');
  assert.equal(rules.setBothLogic('cannot').ok, false);
});

test('ruleFor يدمج الثوابت مع العتبتين: دعم وإشراف وبلا مسار يُعاد null', () => {
  const support = rules.ruleFor('support', 'Support');
  assert.deepEqual(
    { from: support.from, to: support.to, months: support.months, rating: support.rating,
      maxWarnings: support.maxWarnings, windowDays: support.windowDays,
      minActiveDays: support.minActiveDays, minMessages: support.minMessages,
      approvals: support.approvals },
    { from: 'Support', to: 'Support Expert', months: 3, rating: 4.0, maxWarnings: 1,
      windowDays: 180, minActiveDays: 20, minMessages: 100, approvals: 2 });
  assert.equal(support.pointsThreshold, 500, 'عتبة النقاط من POINTS_THRESHOLDS');
  assert.equal(support.scoreThreshold, rules.DEFAULT_SCORE_THRESHOLD, 'عتبة الدرجة البديلة');
  const mod = rules.ruleFor('moderation', 'Trial Moderator');
  assert.equal(mod.pointsThreshold, 200);
  assert.equal(mod.months, 1);
  assert.equal(mod.actions, 15, 'حقل الإجراءات بقاعده من الثوابت');
  // D10 أزال Admin→HoM والعتبة 1500 فقط: مسار Senior→Admin بقي حياً بعتبته 1000
  const senior = rules.ruleFor('moderation', 'Senior Moderator');
  assert.equal(senior.to, 'Admin');
  assert.equal(senior.pointsThreshold, 1000, 'عتبة نقاطه من الثوابت');
  // والإدارة تعيين يدوي: لا مسار تلقائي منها أبداً
  assert.equal(rules.ruleFor('support', 'Admin'), null, 'عين يدوية — لا مسار تلقائي');
  assert.equal(rules.ruleFor('support', 'Admin'), null, 'عين يدوية — لا مسار تلقائي');
  assert.equal(rules.ruleFor('general_management', 'x'), null);
});

test('تجاوز السياسة يغيّر أرقامه لا ميثاق الرتبة، والعتبتان معه', () => {
  const res = rules.setRule('support', 'Support', { rating: 4.5, pointsThreshold: 400, windowDays: 90 });
  assert.equal(res.ok, true);
  const rule = rules.ruleFor('support', 'Support');
  assert.equal(rule.rating, 4.5, 'التجاوز أُخذ');
  assert.equal(rule.pointsThreshold, 400, 'عتبة النقاط قابلة للتجاوز أيضاً');
  assert.equal(rule.windowDays, 90);
  assert.equal(rule.from, 'Support', 'ميثاق الرتبة من الثوابت لا يتأثر');
  assert.equal(rule.to, 'Support Expert');
  assert.equal(rule.approvals, 2);
  assert.equal(rule.minActiveDays, 20);
  // والجديد مرئي فوراً: كتابة السياسة تبطل الكاش وقراءة تالية تراه
  assert.equal(rules.ruleFor('support', 'Support').rating, 4.5);
});

test('الرفض التام: قيمة خارج الحدود وغير صحيح وحقل غريب وفوق نطاقه', () => {
  const bad = rules.setRule('support', 'Support', { rating: 6 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /1–5/);
  // التقرير مكتمل: أغلاط متعددة معاً
  const multi = rules.setRule('support', 'Support', { months: 40, maxWarnings: 0.5, approvals: 9, typoField: 1 });
  assert.equal(multi.ok, false);
  assert.equal(multi.errors.length, 4);
  assert.ok(multi.errors.some(e => e.includes('typoField')));
  assert.match(multi.errors[0], /0–36/);
  // وفرَضُ التلقائي والقائمة الكائن والخارج عن المسار
  assert.equal(rules.setRule('general_management', 'x', { months: 2 }).ok, false);
  assert.equal(rules.setRule('support', 'Admin', { months: 2 }).ok, false);
  assert.equal(rules.setRule('support', 'Support', [3]).ok, false, 'مصفوفة ليست كائناً');
  assert.equal(rules.setRule('support', 'Support', null).ok, false);
  settings.setPolicy('promotion.rule.support.Support', { rating: 99 });
  const rule = rules.ruleFor('support', 'Support');
  assert.equal(rule.rating, 4.0, 'تجاوز مكتوب يدوياً خارج الحدود لا يدخل الدمج');
});

test('نافذة النشاط الأدنى لا تجاوز نافذة الرتبة — يُفحص بعد الدمج لا مع القيمة الخام', () => {
  // نافذة الرتبة 180 يوماً: 30 يوم نشاط صحيح، و200 يوماً خارجها
  const good = rules.setRule('support', 'Support', { minActiveDays: 30 });
  assert.equal(good.ok, true);
  const bad = rules.setRule('support', 'Support', { minActiveDays: 200 });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /نافذة 180/);
  // مع تجاوز windowDays معاً في الدفعة نفسها: الحد يُقدَّر من الدفعة الجديدة
  const widened = rules.setRule('support', 'Support', { windowDays: 300, minActiveDays: 200 });
  assert.equal(widened.ok, true);
  assert.equal(rules.ruleFor('support', 'Support').minActiveDays, 200);
});

test('resetRule يعيد الثوابت ويصوغ الدفتر مرةً واحدة والثانية لا تكتب', () => {
  rules.setRule('moderation', 'Trial Moderator', { months: 5 });
  assert.equal(rules.ruleFor('moderation', 'Trial Moderator').months, 5);
  const res = rules.resetRule('moderation', 'Trial Moderator', 'actor-9');
  assert.equal(res.ok, true);
  assert.equal(rules.ruleFor('moderation', 'Trial Moderator').months, 1, 'الافتراضي من الثوابت');
  assert.equal(audits(['promotion_rules_updated', 'promotion_rules_reset']).length, 2);
  // إعادة المسح حين لا يوجد تجاوز: لا خطأ ودفتر التدقيق لا يزداد
  const again = rules.resetRule('moderation', 'Trial Moderator');
  assert.equal(again.ok, true);
  assert.equal(audits(['promotion_rules_updated', 'promotion_rules_reset']).length, 2);
});
