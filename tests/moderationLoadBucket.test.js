'use strict';
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const load = require('../src/services/load');

// آخر منتصف ليل الرياض، محسوباً برمجياً حتى يصدح الاختبار بأي ساعة يشفّ
function lastRiyadhMidnight() {
  const n = new Date();
  const m = new Date(Math.floor(n.getTime() / 86400000) * 86400000);
  m.setUTCHours(21, 0, 0, 0); // 03:00 الرياض = منتصف ليل الرياض بإزاحة +03:00
  if (m.getTime() > n.getTime()) m.setUTCDate(m.getUTCDate() - 1);
  return m;
}

function stamp(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

beforeEach(() => {
  openMemoryDb();
});

describe('أيام النشاط بحدّ الرياض لا UTC (⑬)', () => {
  test('عمليتا فجر ويومان — رسائل فجر الرياض تدخل يوم الرياض الحاضر', () => {
    const mod = 'mod-1';
    const target = 'target-1';
    const midnight = lastRiyadhMidnight(); // منتصف ليل الرياض الحالي = UTC 21:00/01:00
    const ins = getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, created_at)
      VALUES (?, ?, 'warn', 'seed', ?)`);
    // عمليّتان داخل يوم الرياض الحالي (نصف/ساعة بعد منتصفه) وواحدة قبله بثلاثين دقيقة — فتقع في يوم الأمس
    ins.run(mod, target, stamp(new Date(midnight.getTime() + 30 * 60000)));
    ins.run(mod, target, stamp(new Date(midnight.getTime() + 60 * 60000)));
    ins.run(mod, target, stamp(new Date(midnight.getTime() - 30 * 60000)));
    const res = load.moderationLoad(mod, 7);
    assert.equal(res.actions, 3, 'العمليات الثلاث داخل النافذة السباعية');
    assert.equal(res.activeDays, 2, 'يومان رياضيان (اليوم والأمس) لا يوم واحد UTC');
  });

  test('حدود النافذة: 0 يرتد للافتراضي، والسالبة تُرفع إلى 1، والكبيرة تُشدّ إلى 90', () => {
    assert.equal(load.moderationLoad('mod-2', 0).days, 7);
    assert.equal(load.moderationLoad('mod-2', -5).days, 1);
    assert.equal(load.moderationLoad('mod-2', 500).days, 90);
    assert.equal(load.moderationLoad('mod-2').days, 7);
  });
});
