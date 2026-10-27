'use strict';
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const clock = require('../src/clock');
const kit = require('../src/ui/kit');

describe('stampLocalDay — نزح الطابع إلى يوم الرياض (⑫)', () => {
  test('حدّ الفجر: UTC 20:59:59 يبقى بيومه، وUTC 21:00:00 يصير اليومَ التالي رياضياً', () => {
    assert.equal(clock.stampLocalDay('2026-10-24 20:59:59'), '2026-10-24');
    assert.equal(clock.stampLocalDay('2026-10-24 21:00:00'), '2026-10-25');
  });

  test('طابع نصف النهار يعود بيومه كما هو', () => {
    assert.equal(clock.stampLocalDay('2026-10-25 09:41:00'), '2026-10-25');
  });

  test('التاريخ المجرَّد يعود كما هو بلا نزح', () => {
    // أعمدة joined_at/rank_since تحمل تواريخ خالصة لا طوابع
    assert.equal(clock.stampLocalDay('2026-10-24'), '2026-10-24');
  });

  test('الفارغ والفاسد يعودان null لا قيمة صامتة', () => {
    assert.equal(clock.stampLocalDay(''), null);
    assert.equal(clock.stampLocalDay(null), null);
    assert.equal(clock.stampLocalDay(undefined), null);
    assert.equal(clock.stampLocalDay('2026-13-50'), null);
    assert.equal(clock.stampLocalDay('ليس طابعاً'), null);
  });

  test('رحلة ذهاب وعودة: dayStartStamp(d) ثم stampLocalDay تعيد d', () => {
    // dayStartStamp(d) = ليلة d السابقة 21:00 — وعودتها إلى الرياض تعيد d
    for (const day of ['2026-01-01', '2026-10-25', '2026-12-31', '2027-03-15']) {
      assert.equal(clock.stampLocalDay(clock.dayStartStamp(day)), day);
    }
  });

  test('عمر المعلّق في فجر الرياض لا يزيد يومًا', () => {
    // طلب وُلد فجرًا: تاريخ UTC ليلة الأمس، ويوم الرياض اليوم.
    // التقط القديم slice(0,10) يأخذ الأمس فيزيد العمر يومًا.
    const created = '2026-10-25 21:30:00'; // الرياض 2026-10-26 00:30
    assert.equal(clock.stampLocalDay(created), '2026-10-26');
    assert.equal(clock.daysBetween(clock.stampLocalDay(created), '2026-10-27'), 1);
    // وقيمة القديم كانت 2 — فرق الإثبات هو هذا السطر
    assert.equal(clock.daysBetween(created.slice(0, 10), '2026-10-27'), 2);
  });

  test('kit: الافتراضي «اليوم» من clock.today() لا UTC', () => {
    // العقد: daysFromToday(x) يساوي دائمًا فرق أيام الرياض حولها.
    // زلة القديم عرض لها فقط في نافذة 00:00-03:00 الرياضية.
    const target = clock.addDays(clock.today(), 7);
    assert.equal(kit.daysFromToday(target), 7);
    const past = clock.addDays(clock.today(), -3);
    assert.equal(kit.daysFromToday(past), -3);
  });
});
