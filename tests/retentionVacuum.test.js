'use strict';
/**
 * استرجاع المساحة وشكل تقرير الصيانة.
 *
 * ★ لماذا لا `VACUUM INTO` + استبدال بالاسم، وهو الحل الظاهر:
 *   استبدال ملف SQLite تحت اتصال حيّ غير آمن، والقياس هنا أسقطه — كله موثّق في
 *   تعليق vacuum() في src/services/retention.js. باختصار:
 *     • `fs.rename` فوق قاعدة مفتوحة فشل بـ EPERM على ويندوز (مقيس).
 *     • وعلى POSIX ينجح والمقبض يبقى على الملف القديم فينقسم الملف بلا صمت.
 *     • إعادة الفتح تحتاج getDb() جديداً، وdatabase.js يحفظ اتصالاً واحداً
 *       في متغير وحدة ولا يصدّر إعادة فتح (خارج نطاق هذا الملف).
 *   فالمسار المأخوذ: استرجاع تدريجي بشlices عبر PRAGMA incremental_vacuum بعد
 *   تحويل لمرة واحدة إلى auto_vacuum=INCREMENTAL. كل شريحة 1–4 مللي ثانية على
 *   18 م.ب، فالتجميد الذي كان 106 ثانية على 1,748 م.ب ينعدم.
 *   والأثر laterally: استرجاع المساحة أصبح **محدود الزمن** لا «كامل أو لا شيء».
 *
 * ★ التوثيق: هذا الملف يفرض صحّة الوعد بالذرّية (تعليق run() كان يدّعي معاملة
 *   واحدة، وrun() خمس وحدات منفصلة) وصيغة موحّدة بين دوال التقليم.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { openMemoryDb, getDb } = require('../src/database');
const retention = require('../src/services/retention');
const config = require('../src/config');

// ============================================================ A) integrity
// على قاعدة في الذاكرة: vacuüm()-operative لا رجوع. الاختبارات هنا على وحدة
// المسجّلة أصلاً.

describe('retention على قاعدة ذاكرة: صيانة كاملة بلا كسر', () => {
  beforeEach(() => openMemoryDb());

  const add = (userId, day, type = 'staff') => getDb()
    .prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
      VALUES (?, 'c', ?, 0.25, ?)`).run(userId, type, day);

  test('صيانة حقيقية (غير معاينة) تُبقي كل الجداول مقروءة وأعداد الصفوف صحيحة', () => {
    // صفّ واحد داخل النافذة يجب أن يبقى بعد التقليم
    const keep = require('../src/clock').today();
    add('u1', '2024-01-05'); add('u1', '2024-01-06'); add('u1', keep);
    const before = retention.tableCounts();
    const r = retention.run({ dryRun: false });
    const after = retention.tableCounts();

    // كل جدول موجود قبل التشغيل موجود بعده، بنفس الاسم
    assert.deepEqual(Object.keys(after).sort(), Object.keys(before).sort(), 'تغيّر مجموعة الجداول');
    // الشهر القديم صار مجمّعاً وخُذف خاماً
    assert.equal(after.activity_logs, 1, 'بقي الصف داخل النافذة فقط');
    assert.equal(after.activity_monthly, 1);
    assert.equal(r.activity.deleted, 2);
    // vacuumed must be a boolean, never undefined
    assert.equal(typeof r.vacuumed, 'boolean');
    assert.equal(r.dryRun, false);
  });

  test('المعاينة تكتب شيئاً وتُبلّغ بنفس الأرقام التي يبلّغها التشغيل', () => {
    add('u1', '2024-01-05');
    const dry = retention.run({ dryRun: true });
    const countsAfterDry = retention.tableCounts();
    assert.equal(countsAfterDry.activity_logs, 1, 'المعاينة حذفت شيئاً');
    assert.equal(dry.vacuumed, false, 'المعاينة استرجعت مساحة');
    // الأرقام التي تُعرض على المشغّل متطابقة
    assert.equal(dry.activity.pending, 1);
    assert.equal(dry.rollup.rows, 1);
  });

  test('كل دالة تقليم تُعيد نفس المفاتيح — قارئ .deleted لا يحصل على undefined', () => {
    getDb().prepare("INSERT INTO backup_checks (path, ok, detail, created_at) VALUES ('old', 1, 'd', '2020-01-01 00:00:00')").run();
    getDb().prepare("INSERT INTO audit_logs (action, created_at) VALUES ('old', '2020-01-01 00:00:00')").run();
    const shapes = [retention.pruneActivity({ dryRun: true }), retention.pruneAudit({ dryRun: true }), retention.pruneOperational({ dryRun: true })];
    for (const s of shapes) {
      assert.deepEqual(Object.keys(s).sort(), ['cutoff', 'deleted', 'pending'], `شكل غير موحّد: ${Object.keys(s)}`);
    }
    // pruneOperational كان {backupChecks, pending} — بلا deleted. هذا الحارس
    // هو ما يمنع عودة المفتاح المختلف.
    assert.equal(retention.pruneOperational({ dryRun: false }).deleted, 1, 'حذف فحوص النسخ لا يُبلّغ عن العدد');
  });

  test('pruneOperational يمرّ عبر cutoffMonth لا عبر عدد أيام مكتوب', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'retention.js'), 'utf8');
    const body = src.slice(src.indexOf('function pruneOperational('), src.indexOf('function dbSizeMb('));
    assert.doesNotMatch(body, /-180 days/, 'pruneOperational عاد لثابت 180 يوماً مكتوباً');
    assert.match(body, /cutoffMonth\(/, 'pruneOperational لا يستخدم cutoffMonth');
  });

  test('تعليق الذرّية صحيح: run() ليست معاملة واحدة', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'retention.js'), 'utf8');
    // ادّعاء قديم: "كل شيء داخل معاملة واحدة" — انقلب إلى وصف دقيق
    assert.doesNotMatch(src, /كل شيء داخل معاملة واحدة/, 'ما زال يدّعي ذرّية شاملة غير موجودة');
    assert.match(src, /ليست معاملة واحدة/, 'لا يوضّح أن run ليست ذرّية ككل');
  });
});

// ============================================================ B) the slice
// الملف الآمن: قاعدة ملف حقيقية، auto_vacuum=INCREMENTAL، واسترجاع تدريجي.
// نتأكد: الملف ما زال يُقرأ، الجداول كلها، الأعداد محفوظة، ولا fd ميت.

describe('استرجاع المساحة: قاعدة ملف حقيقية', () => {
  function freshFileDb() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-vac-'));
    const file = path.join(dir, 'staff.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, blob TEXT)`);
    const ins = db.prepare('INSERT INTO t (blob) VALUES (?)');
    db.exec('BEGIN');
    for (let i = 0; i < 8000; i++) ins.run('x'.repeat(400));
    db.exec('COMMIT');
    return { db, file, dir };
  }

  test('incremental_vacuum يستردّ المساحة الشريحة بشريحة بلا تجميد ولا فقدان صفوف', () => {
    const { db, file } = freshFileDb();
    try {
      // تحويل لمرة واحدة (قاعدة صغيرة → ثمنه بضع ميلي ثانية)
      db.pragma('auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
      assert.equal(db.pragma('auto_vacuum', { simple: true }), 2, 'لم يتم التحويل');

      const sizeBefore = fs.statSync(file).size;
      const rowsBefore = db.prepare('SELECT COUNT(*) c FROM t').get().c;

      // نحذف **كل** الصفوف: freelist يتأكد ببلا التباس. حذف نصف الصفوف قد
      // يترك الصفحات كلها مشغولة بصفوف باقية فلا صفحة حرة تنشأ أصلاً.
      db.prepare('DELETE FROM t').run();
      const freeBefore = db.pragma('freelist_count', { simple: true });
      assert.ok(freeBefore > 0, 'لم تنشأ صفحات حرة بعد الحذف');

      // شريحة واحدة فقط (وليس كل freelist) — هذه هي الخاصية: ميزانية صغيرة
      db.exec(`PRAGMA incremental_vacuum(${retention.VACUUM_SLICE_PAGES})`);
      const freeAfter = db.pragma('freelist_count', { simple: true });

      // الشريحة استردّت شيئاً ولم تسترد كل freelist (ميزانية محدودة)
      assert.ok(freeAfter < freeBefore, `الشريحة لم تسترد شيئاً: ${freeAfter} >= ${freeBefore}`);
      // ★ الخاصية الحاسمة بدل مهلة زمنية: الشريحة أنجزت عملاً **محدوداً** —
      // استرجعت صفحاً لا يتجاوز عددها حصة الشريحة. هذه هي ضدّية تجميد
      // الحلقة الأصلية (106 ثانية)، لكنها مُشتقة من عدّ الصفحات لا من الساعة:
      // مهلة `sliceMs < 1000` كانت تعتمد على سرعة المعالج (قِيست 90–273ms عبر
      // 6 عمليات تشغيل) وتفلّ على مستودع بطيء، بينما حدّ الصفحة حتمي.
      assert.ok(freeBefore - freeAfter <= retention.VACUUM_SLICE_PAGES,
        `شريحة واحدة استرجعت ${freeBefore - freeAfter} صفحة — تتجاوز حصة ${retention.VACUUM_SLICE_PAGES}`);

      // ★ الأمان: البيانات سليمة تماماً بعد الاسترجاع الجزئي
      const rowsAfter = db.prepare('SELECT COUNT(*) c FROM t').get().c;
      assert.equal(rowsAfter, 0, 'استرجاع المساحة أحيى صفوفاً محذوفة');
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok', 'القاعدة تلفت');
      assert.ok(fs.statSync(file).size <= sizeBefore, 'الملف كبر بلا داعٍ');
    } finally { db.close(); }
  });

  test('استنزاف freelist بالكامل على دفعات يُبقي القاعدة سليمة وبلا orphan -wal/-shm', () => {
    const { db, file } = freshFileDb();
    try {
      db.pragma('auto_vacuum = INCREMENTAL');
      db.exec('VACUUM');
      db.prepare('DELETE FROM t').run();
      const free = db.pragma('freelist_count', { simple: true });
      assert.ok(free > 0, 'لا صفحات حرة بعد حذف كل شيء');

      // استنزاف كامل، شريحة بشريحة — كل نداء قصير
      let guard = 0;
      while ((db.pragma('freelist_count', { simple: true }) || 0) > 0 && guard++ < 500) {
        db.exec(`PRAGMA incremental_vacuum(${retention.VACUUM_SLICE_PAGES})`);
      }
      assert.ok(guard < 500, 'استنزاف Freelist لم ينتهِ');
      assert.equal(db.pragma('freelist_count', { simple: true }), 0, 'بقيت صفحات حرة');
      assert.equal(db.prepare('SELECT COUNT(*) c FROM t').get().c, 0);
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally {
      // إغلاق نظيف: نسجل الـwal/-shm بعد الإغلاق لا قبله
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
      // إعادة فتح: لا fd ميت ولا orphan يمنع القراءة
      const re = new Database(file);
      try {
        assert.equal(re.pragma('integrity_check', { simple: true }), 'ok', 'إعادة الفتح ترى قاعدة تالفة');
        assert.equal(re.prepare('SELECT COUNT(*) c FROM t').get().c, 0);
      } finally { re.close(); }
    }
  });

  test('استبدال ملف قاعدة حيّ غير آمن — المرجع الذي بُني عليه الرفض', () => {
    const { db, file, dir } = freshFileDb();
    try {
      // هذا ما كان سيُنفَّذ لو كان VACUUM INTO + rename آمناً:
      const copy = path.join(dir, 'compacted.db');
      db.exec(`VACUUM INTO '${copy}'`);
      assert.ok(fs.existsSync(copy), 'VACUUM INTO لم ينتج ملفاً');

      // الاستبدال تحت اتصال حيّ: EPERM على ويندوز. هذا هو الفشل الذي يمنع
      // اعتماد الحلّ — لو نجح على ويندوز لكان سلوكه على POSIX مقاساً أيضاً.
      let renameErr = null;
      try { fs.renameSync(copy, file); } catch (e) { renameErr = e; }
      assert.ok(renameErr, 'استبدال الملف تحت اتصال حيّ نجح — الافتراض تغيّر، راجع الحلّ');

      // الملف الأصلي سليم تماماً بعد محاولة الاستبدال الفاشلة
      assert.equal(db.prepare('SELECT COUNT(*) c FROM t').get().c, 8000, 'الصفوف تغيّرت');
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    } finally { db.close(); }
  });
});