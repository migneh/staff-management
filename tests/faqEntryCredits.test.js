'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const faq = require('../src/commands/faq');
const points = require('../src/services/points');

// عقود نقاط إثراء قاعدة المعرفة — بعد إغلاق ثغرة الرَعي (تقرير التدقيق، الحرجة 1):
// مرجِع المنح بصمةُ المحتوى (sha256 للعنوان والمحتوى بعد تطبيع المسافات) بفهرس
// فريد لكل مستخدم (idx_points_unique_ref على user_id, reason_key, ref_type, ref_id):
// حذف مقال وإعادة إضافته بنفس النص لا يُكافأ، واختلاف التنسيق لا يجدد المكافأة،
// وإعادة الإضافة بمعرّف جديداً لا تعيد المكافأة. التدفق الحر عبر مقالات مختلفة
// يقيّده سقف يومي 10 نقاط (= مساهمتان بقيمة 5).

beforeEach(() => openMemoryDb());

const AUTHOR = '333333333333333333';

beforeEach(() => {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Support', 'active')`).run(AUTHOR, AUTHOR);
});

function entry(overrides = {}) {
  return { id: 77, title: 'كيف أفتح تذكرة دعم؟', content: 'افتح تذكرة في قناة الدعم واكتب مشكلتك فصلاً.', ...overrides };
}

test('مقال جديد يمنح +5 بمرجع بصمة محتواه ويرد الحرية للرصيد', () => {
  const r = faq.awardEntryCredits(entry({ id: 77 }), AUTHOR);
  assert.equal(r.ok, true, `يجب المنح: ${r.reason}`);
  assert.equal(r.points, 5, 'قيمة faq_contrib ثابتة 5');
  assert.equal(points.getBalance(AUTHOR), 5);
  const stored = getDb().prepare(`SELECT ref_id FROM promotion_points WHERE user_id = ? AND reason_key = 'faq_contrib'`).get(AUTHOR);
  assert.match(String(stored.ref_id), /^[0-9a-f]{64}$/, 'المرجع بصمة sha256 للمحتوى لا معرّف المدخل');
});

test('المحتوى نفسه لا يُكافأ مرتين — حُذف وأُعيد بنفس النص بمعرّف جديد', () => {
  faq.awardEntryCredits(entry(), AUTHOR);
  const r = faq.awardEntryCredits(entry({ id: 555 }), AUTHOR);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /مكر/);
  assert.equal(points.getBalance(AUTHOR), 5, 'الرصيد ثابت');
});

test('اختلاف التنسيق فقط (مسافات متعددة أو حواف) لا يجدد المكافأة', () => {
  faq.awardEntryCredits(entry(), AUTHOR);
  const r = faq.awardEntryCredits(entry({ id: 556, title: '  كيف أفتح تذكرة دعم؟ ', content: 'افتح     تذكرة في قناة الدعم واكتب مشكلتك فصلاً.\n' }), AUTHOR);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /مكر/);
  assert.equal(points.getBalance(AUTHOR), 5, 'الرصيد ثابت');
});

test('مقالان مختلفان مستقلان — لكل محتوى بصمته ومكافأته', () => {
  assert.equal(faq.awardEntryCredits(entry({ id: 77 }), AUTHOR).ok, true);
  assert.equal(faq.awardEntryCredits(entry({ id: 78, title: 'عنوان آخر', content: 'محتوى مختلف كلياً.' }), AUTHOR).ok, true);
  assert.equal(points.getBalance(AUTHOR), 10);
});

test('السقف اليومي: ثالث مساهمة مُكافأةً في اليوم نفسه يُرفض', () => {
  assert.equal(faq.awardEntryCredits(entry({ id: 77, title: 'ت1', content: 'م1' }), AUTHOR).ok, true);
  assert.equal(faq.awardEntryCredits(entry({ id: 78, title: 'ت2', content: 'م2' }), AUTHOR).ok, true);
  const third = faq.awardEntryCredits(entry({ id: 79, title: 'ت3', content: 'م3' }), AUTHOR);
  assert.equal(third.ok, false, 'لا أكثر من مساهمتين مُكافأتين في اليوم');
  assert.match(String(third.reason), /سقف/);
  assert.equal(third.cap, 10, 'السقف 10 نقاط = مساهمتان بقيمة 5');
  assert.equal(points.getBalance(AUTHOR), 10);
});

test('مدخل مشوّه (بلا معرّف) يرفض بهدوء بصري بلا استثناء', () => {
  assert.equal(faq.awardEntryCredits(null, AUTHOR).ok, false);
  assert.equal(faq.awardEntryCredits({}, AUTHOR).ok, false);
  assert.equal(points.getBalance(AUTHOR), 0);
});

test('المستفيد غير المسجل رفضه صريح — لا نقاط لغير أهل الدفتر', () => {
  const r = faq.awardEntryCredits(entry(), '444444444444444444');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'غير مسجل كإداري');
});
