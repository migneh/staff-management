'use strict';
// اختبار عطل إيقاع الإقلاع الحقيقي (Nov 2026): إقلاع الإنتاج مات في كل مرة
// بـ UNIQUE constraint failed على promotion_points لأن خطوة points_ledger
// تعيد بناء الفهرس ثلاثي الأعمدة فوق بيانات فيها مرجع مشترك بين عضوين،
// بعد أن ألقيه خطوة points_unique_ref_per_user عمداً لصالح المفتاح المقيَّد
// بالعضو. هذا الملف يثبّت الترتيب: الإقلاع الثاني لا يعيد بناء الفهرس القديم.
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, migrate, getDb } = require('../src/database');

const PER_USER = 'idx_points_unique_user_ref';
const LEGACY = 'idx_points_unique_ref';

const indexName = (db, name) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?"
).get(name);

/** جائزة نجم الأسبوع كما تكتبها src/scheduler.js: الجائز والوصيفان بنفس المرجع. */
function awardWeekToTwoMembers(db) {
  for (const user of ['winner', 'runner-up']) {
    db.prepare(`INSERT INTO promotion_points
      (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch, created_at)
      VALUES (?, 10, 'star_week', 'نجم الأسبوع', 'week', '2026-11-02', 'auto', 0, datetime('now'))`)
      .run(user);
  }
}

test('الإقلاع الثاني يقبل قاعدة فيها مرجع جائزة مشترك بين عضوين', () => {
  const db = openMemoryDb();

  // بعد أول ترحيل: الفهرس المقيد بالعضو هو الحاكم، والقديم أُلقي عمداً.
  assert.ok(indexName(db, PER_USER), 'الفهرس المقيد بالعضو غير موجود بعد الترحيل الأول');
  assert.equal(indexName(db, LEGACY), undefined, 'الفهرس القديم كان يجب أن يُلقي بعد الترحيل الأول');

  // البيانات المشتركة مشروعة تحت المفتاح الجديد — إدراجها يجب أن ينجح.
  awardWeekToTwoMembers(db);

  // الإقلاع التالي: كل الخطوات تعيد تشغيلها من رأسها.
  let thrown = null;
  try {
    migrate(db);
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, null, `الإقلاع الثاني مات كما في الإنتاج: ${thrown && thrown.message}`);

  // لا شيء ضاع ولا تغيّر صورة المخطط.
  assert.equal(db.prepare("SELECT COUNT(*) n FROM promotion_points WHERE reason_key = 'star_week'").get().n,
    2, 'صفوف الجائزة المشتركة ضاعت أثناء إعادة الترحيل');
  assert.ok(indexName(db, PER_USER), 'الفهرس المقيد بالعضو لم يبقَ بعد إعادة الترحيل');
  assert.equal(indexName(db, LEGACY), undefined, 'الفهرس القديم أعيد بناؤه فوق بيانات مشتركة');

  // المفتاح الجديد ما زال يفرض تفرد المرجع داخل العضو.
  let duplicate = null;
  try {
    db.prepare(`INSERT INTO promotion_points
      (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch, created_at)
      VALUES ('winner', 10, 'star_week', 'نجم الأسبوع', 'week', '2026-11-02', 'auto', 0, datetime('now'))`)
      .run();
  } catch (e) {
    duplicate = e;
  }
  assert.ok(duplicate, 'تكرار مرجع لنفس العضو مرّ بلا منع بعد إعادة الترحيل');
  assert.match(String(duplicate.message), /UNIQUE/, 'الرفض لم يكن بسبب قيد التفرد');
});

test('قاعدة جديدة تفتح وتغلق بلا أي مساس بالفهارس', () => {
  openMemoryDb();
  const db = getDb();
  assert.ok(indexName(db, PER_USER));
  assert.equal(indexName(db, LEGACY), undefined);
});
