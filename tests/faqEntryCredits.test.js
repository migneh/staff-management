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

// عقود نقاط إثراء قاعدة المعرفة (موجة نقاط 2026-10-24):
// مقال جديد = +5 مرة واحدة بمرجع المدخل؛ التعديل اللاحق على المقال نفسه لا يُكافأ
// لئلا يصنع زر «حفظ» راتباً.

beforeEach(() => openMemoryDb());

const AUTHOR = '333333333333333333';

beforeEach(() => {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Support', 'active')`).run(AUTHOR, AUTHOR);
});

test('مقال جديد يمنح +5 بمرجع مدخله ويرد الحرية للرصيد', () => {
  const r = faq.awardEntryCredits({ id: 77 }, AUTHOR);
  assert.equal(r.ok, true, `يجب المنح: ${r.reason}`);
  assert.equal(r.points, 5, 'قيمة faq_contrib ثابتة 5');
  assert.equal(points.getBalance(AUTHOR), 5);
});

test('المدخل نفسه لا يُكافأ مرتين — أعيد الحفظ أو حُذف وأعيد بأي صياغة', () => {
  faq.awardEntryCredits({ id: 77 }, AUTHOR);
  const r = faq.awardEntryCredits({ id: 77 }, AUTHOR);
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /مكر/);
  assert.equal(points.getBalance(AUTHOR), 5, 'الرصيد ثابت');
});

test('مدخل مختلف مستحق مستقل — المقالات لا تتقاسم العتبة', () => {
  assert.equal(faq.awardEntryCredits({ id: 77 }, AUTHOR).ok, true);
  assert.equal(faq.awardEntryCredits({ id: 78 }, AUTHOR).ok, true);
  assert.equal(points.getBalance(AUTHOR), 10);
});

test('مدخل مشوّه (بلا معرّف) يرفض بهدوء بصري بلا استثناء', () => {
  assert.equal(faq.awardEntryCredits(null, AUTHOR).ok, false);
  assert.equal(faq.awardEntryCredits({}, AUTHOR).ok, false);
  assert.equal(points.getBalance(AUTHOR), 0);
});

test('المستفيد غير المسجل رفضه صريح — لا نقاط لغير أهل الدفتر', () => {
  const r = faq.awardEntryCredits({ id: 90 }, '444444444444444444');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'غير مسجل كإداري');
});
