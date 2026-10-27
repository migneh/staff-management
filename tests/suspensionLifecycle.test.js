'use strict';
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const staffService = require('../src/services/staff');

function seedSuspended(userId, until, updatedAt) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, suspended_until, updated_at)
    VALUES (?, ?, 'moderation', 'Moderator', 'suspended', ?, ?)`).run(userId, `u-${userId}`, until, updatedAt);
}

function freshMember(userId) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'moderation', 'Moderator', 'active')`).run(userId, `u-${userId}`);
}

beforeEach(() => {
  openMemoryDb();
});

describe('عقد الإيقاف — تاريخ لا نص خام (⑬)', () => {
  test('الكاتب لا يعود يكتب "60 days" — ثابت مصدر على punishments', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'punishments.js'), 'utf8');
    assert.ok(src.includes("require('../clock')"), 'punishments يجب أن يستورد الساعة');
    assert.ok(src.includes('clock.addDays(clock.today(), 60)'), 'الكاتب يجب أن يكتب تاريخ اليوم+60');
    assert.ok(!src.match(/suspend\([^)]*,\s*'60 days'/), "يُمنع إعادة النص الخام '60 days' في الكاتب");
  });

  test('عقد suspend: آخر يوم موقوف كامل هو 59 — الرفع في فجر اليوم الستين', () => {
    freshMember('6101');
    const today = clock.today();
    const until = clock.addDays(today, 60);
    staffService.suspend('6101', until);

    const row = getDb().prepare('SELECT suspended_until, status FROM staff_members WHERE user_id = ?').get('6101');
    assert.equal(row.status, 'suspended');
    assert.equal(row.suspended_until, until, 'الحقل يجب أن يحمل تاريخاً خالصاً');
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.suspended_until), 'يجب أن يكون تاريخاً خالصاً YYYY-MM-DD');
  });

  test('الرفع الآلي: قبل فجر يوم الانتهاء يرقد صامتاً بعدَه يرفع', () => {
    freshMember('6102');
    const today = clock.today();
    staffService.suspend('6102', clock.addDays(today, 60));

    // حتى آخر ليلة موقوفة (يوم 59): لا شيء يُرفع
    assert.deepEqual(staffService.liftExpiredSuspensions(clock.addDays(today, 59)), []);
    // فجر يوم 60: يُرتفع
    const lifted = staffService.liftExpiredSuspensions(clock.addDays(today, 60));
    assert.equal(lifted.length, 1);
    assert.equal(lifted[0].user_id, '6102');
    assert.equal(lifted[0].until, clock.addDays(today, 60));
    const after = getDb().prepare('SELECT suspended_until, status FROM staff_members WHERE user_id = ?').get('6102');
    assert.equal(after.status, 'active');
    assert.equal(after.suspended_until, null);
  });

  test('النص الخام القديم "60 days" كان يعلق للأبد — نموذج يثبت العلة (غارد لا يجدد العلة)', () => {
    freshMember('6103');
    // نزرع النفس ما كانت الشيفرة القديمة تكتبه: النص الخام
    getDb().prepare("UPDATE staff_members SET status = 'suspended', suspended_until = '60 days' WHERE user_id = ?").run('6103');
    // أي تاريخ مستقبلي: المقارنة المعجمية '60 days' <= anything-2026 صاغرة — لا رفع أبداً
    assert.deepEqual(staffService.liftExpiredSuspensions(clock.addDays(clock.today(), 500)), []);
  });
});

describe('ترحيل الإيقافات القديمة — migrateLegacySuspensions (⑬)', () => {
  test('يحسب تاريخ النهاية من يوم الرياض في updated_at + 60', () => {
    seedSuspended('6201', '60 days', '2026-08-27 09:00:00');
    const migrated = staffService.migrateLegacySuspensions();
    assert.equal(migrated, 1);
    const expected = clock.addDays(clock.stampLocalDay('2026-08-27 09:00:00'), 60);
    const row = getDb().prepare('SELECT suspended_until, status FROM staff_members WHERE user_id = ?').get('6201');
    assert.equal(row.suspended_until, expected, `يجب أن يصار ${expected} (فتحة القراءة وقيمتها ${row.suspended_until})`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(row.suspended_until));
    assert.equal(row.status, 'suspended');
  });

  test('الترحيل idempotent — التشغيل الثاني لا يحرك شيئاً', () => {
    seedSuspended('6202', '60 days', '2026-08-27 09:00:00');
    assert.equal(staffService.migrateLegacySuspensions(), 1);
    assert.equal(staffService.migrateLegacySuspensions(), 0);
  });

  test('الصفوف ذات التاريخ السليم لا تمسّ', () => {
    freshMember('6203');
    staffService.suspend('6203', clock.addDays(clock.today(), 30));
    assert.equal(staffService.migrateLegacySuspensions(), 0);
    const row = getDb().prepare('SELECT suspended_until FROM staff_members WHERE user_id = ?').get('6203');
    assert.equal(row.suspended_until, clock.addDays(clock.today(), 30));
  });

  test('صف فارغ التاريخ (NULL) لا يستحق ترحيلاً ولا يُعطّله', () => {
    seedSuspended('6204', null, '2026-08-27 09:00:00');
    assert.equal(staffService.migrateLegacySuspensions(), 0);
    const row = getDb().prepare('SELECT suspended_until FROM staff_members WHERE user_id = ?').get('6204');
    assert.equal(row.suspended_until, null);
  });
});
