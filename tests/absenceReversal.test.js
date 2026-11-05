'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, migrate, repairAbsencePenalties, getDb } = require('../src/database');

beforeEach(() => openMemoryDb());

/** صف عقوبة غياب قديم بمنظر ما تخلفه الشيفرة المعطوبة: إمضاء ويوم خصم. */
function seedPenalty({ userId = 'user-a', refId, createdAt, points = -50, epoch = 0 } = {}) {
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch, created_at)
    VALUES (?, ?, 'absence_10d', 'عقوبة غياب (صف قديم)', 'absence', ?, 'auto', ?, ?)`)
    .run(userId, points, refId, epoch, createdAt);
}

const reversals = () =>
  getDb().prepare(`SELECT user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch, created_at
    FROM promotion_points WHERE reason_key = 'absence_reversal' ORDER BY id`).all();

test('صف عقوبة قبل اكتمال الملاحظة يقابله صف تعويض +50 بنفس الإمضاء والعصر', () => {
  // إمضاء تاريخ الدخول 2026-03-01، والخصم بعد 4 أيام ملاحظة فقط: الزيف مثبت.
  seedPenalty({ refId: '2026-03-01', createdAt: '2026-03-05 00:30:00', epoch: 3 });
  const n = repairAbsencePenalties(getDb());
  assert.equal(n, 1);
  const rows = reversals();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].user_id, 'user-a');
  assert.equal(rows[0].points, 50, 'معكوسة النقاط: +50 تعويض -50');
  assert.equal(rows[0].ref_type, 'absence');
  assert.equal(rows[0].ref_id, '2026-03-01', 'الإمضاء نفسه لا يوم التراجع');
  assert.equal(rows[0].rank_epoch, 3, 'عصر الرتبة الأصلي يُحفظ');
  assert.equal(rows[0].added_by, 'system');
  assert.match(rows[0].reason, /تراجع/);
  // العقوبة الأصلية باقية: الدفتر ملحق لا يُمحى.
  const original = getDb().prepare(`SELECT COUNT(*) c FROM promotion_points WHERE reason_key = 'absence_10d'`).get().c;
  assert.equal(original, 1);
});

test('صف عقوبة ملاحظتها مكتملة (10+) لا يُرقم، وحالات الحدود تفترق', () => {
  // يوم 10 بالضبط: حكمه مبرَّر بنظام زمانه، لا تراجع.
  seedPenalty({ userId: 'user-legal', refId: '2026-02-23', createdAt: '2026-03-05 00:30:00' });
  seedPenalty({ userId: 'user-legal-30', refId: '2026-02-01', createdAt: '2026-03-05 00:30:00' });
  // يوم 9: انتظار العتبة لم يتم زال في التراجع.
  seedPenalty({ userId: 'user-buggy-9', refId: '2026-02-24', createdAt: '2026-03-05 00:30:00' });
  seedPenalty({ userId: 'user-buggy-0', refId: '2026-03-05', createdAt: '2026-03-05 01:00:00' });
  const rows = repairAbsencePenalties(getDb()) ? reversals() : [];
  const compensated = new Set(rows.map(r => r.user_id));
  assert.deepEqual([...compensated].sort(), ['user-buggy-0', 'user-buggy-9']);
  // لا صف تعويض للأعضاء الذين اكتملت ملاحظتهم (10 أيام وأكثر).
  assert.equal(rows.filter(r => r.user_id.startsWith('user-legal')).length, 0);
});

test('فريدة كل عضو: إعادة التنفيذ لا تكتب صفوف تعويض مضاعفة', () => {
  seedPenalty({ userId: 'user-dup', refId: '2026-03-01', createdAt: '2026-03-03 12:00:00' });
  assert.equal(repairAbsencePenalties(getDb()), 1);
  // إعادة مباشرة: تجاهل الفريد يحفظ الصف الأول وحده.
  assert.equal(repairAbsencePenalties(getDb()), 0);
  assert.equal(reversals().length, 1);
});

test('خطوة الترحيل تجري على قاعدة حيّة: صفوف موجودة ثم الإقلاع الأول (Idempotency بين الإقلاعات)', () => {
  // محاكاة الإقلاع الأول لقاعدة حيّة: العضوات فيها صفوفها القديمة، وخطوة
  // التراجع لم تطبق بعد. نمحو طابع الخطوة ونشغل migrate ليعمل كأنه إقلاع ترقية.
  seedPenalty({ refId: '2026-03-01', createdAt: '2026-03-04 21:30:00' });
  seedPenalty({ refId: '2026-02-01', createdAt: '2026-03-05 12:00:00', userId: 'user-old' });
  getDb().prepare(`DELETE FROM schema_version WHERE name = 'absence_reversal_v1'`).run();

  migrate(getDb());
  assert.equal(reversals().length, 1, 'صف مجرم واحد تلقى تعويضاً في مرور الترحيل');
  // وإقلاع ثانٍ: الخطوة مطبَّقة، ولا تغيير.
  migrate(getDb());
  assert.equal(reversals().length, 1);
});

test('قاعدة بلا صفوف غياب تعبر الترحيل بصمت، وخطوة مسجَّلة في الدفتر', () => {
  migrate(getDb());
  assert.equal(reversals().length, 0);
  const step = getDb().prepare(`SELECT name FROM schema_version WHERE name = 'absence_reversal_v1'`).get();
  assert.ok(step, 'الخطوة ملزمة بالدفتر كأختها في MIGRATION_STEPS');
});
