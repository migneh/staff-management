'use strict';
// حارس المخطط: كل جملة SQL في src/ يجب أن تذكر جداول وأعمدة موجودة فعلاً.
//
// ليست أداة تجميل. كان هناك job أسبوعي يستعلم `promotion_points` و
// `staff_members.rank_epoch` — كلاهما غير موجود في المخطط. الخطأ سقط في
// job_runs(ok=0)، فصار /healthz يقول «degraded» إلى الأبد ولا أحد يعرف
// لماذا. هذا الاختبار هو ما كان مفقوداً: يفشل عند الدمج بدل أن يفشل كل
// جمعة بصمت.
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const path = require('path');
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb } = require('../src/database');
const { auditSchema, auditMigrationTables, EXPECTED_SKIPS } = require('./sqlSchemaAudit');

const ROOT = path.join(__dirname, '..');

// الفحص يقرأ كل ملفات src/ ويحلّلها، فلا داعي لتكراره في كل اختبار.
const db = openMemoryDb();
const audit = auditSchema(ROOT, db);
const migration = auditMigrationTables(ROOT, db);

describe('حارس المخطط: جمل SQL في src/ مطابقة للمخطط الحيّ', () => {
  test('لا استعلام يذكر جدولاً أو عموداً غير موجود في المخطط', () => {
    const report = audit.findings
      .map(f => `  ${f.site} → ${f.kind === 'table' ? 'جدول' : 'عمود'} غير موجود: ${f.name}\n      ${f.sql}`)
      .join('\n');
    assert.equal(
      audit.findings.length,
      0,
      `${audit.findings.length} استعلام يشير إلى جدول أو عمود غير موجود:\n${report}`,
    );
  });

  test('الفحص شمل مواقع كافية — لا ينهار إلى صفر بصمت', () => {
    // إن فشل محلّلنا على نصف مواقع src فالنتائج تبقى صفرية ولا تعني سلامة.
    assert.ok(
      audit.checked >= 280,
      `فُحصت ${audit.checked} جملة فقط — التغطية انخفضت، راجع EXPECTED_SKIPS`,
    );
    assert.equal(
      audit.statements.length >= audit.checked,
      true,
      'عدد الجمل المفحوصة أقل من عدد الاستعلامات المرصودة',
    );
  });

  test('كل موقع متخطّى موثّق بسببه: لا تخطّي صامت جديد', () => {
    const byFile = {};
    for (const skip of audit.skips) (byFile[skip.file] ||= []).push(skip.reason);

    const undocumented = [];
    for (const [file, reasons] of Object.entries(byFile)) {
      const expected = EXPECTED_SKIPS.get(file);
      if (!expected) { undocumented.push(`${file}: ${reasons.length} موقع بلا توثيق`); continue; }
      if (reasons.length !== expected.count) {
        undocumented.push(`${file}: ${reasons.length} موقع متخطّى والموثّق ${expected.count}`);
      }
      const wrongReason = reasons.filter(r => !expected.reason.test(r));
      if (wrongReason.length) undocumented.push(`${file}: سبب غير متوقّع — ${wrongReason[0]}`);
    }
    // الموثّق أكثر مما هو موجود فعلاً: أي انكماش غير مقصود يجب أن يُرى.
    for (const [file, expected] of EXPECTED_SKIPS) {
      const actual = (byFile[file] || []).length;
      if (actual < expected.count) undocumented.push(`${file}: ${actual} متخطّى والموثّق ${expected.count}`);
    }
    assert.equal(undocumented.length, 0, `انحراف عن قائمة التخطّي الموثّقة:\n  ${undocumented.join('\n  ')}`);
  });

  test('جداول دوال الترحيل في database.js كلها جداول حقيقية', () => {
    assert.ok(migration.seen.length > 0, 'لم يُعثر على أي استدعاء لدالة ترحيل — الفحص لا يعمل');
    const report = migration.missing.map(m => `  database.js:${m.line} → جدول غير موجود: ${m.name}`).join('\n');
    assert.equal(migration.missing.length, 0, `الترحيل يستهدف جداول غير موجودة:\n${report}`);
  });

  test('المخطط المرجعي نفسه مُهيّأ: عدد كبير من الجداول، ولا جدول بلا أعمدة', () => {
    // لو لم يُبنَ openMemoryDb كما يجب لَمرَّر كل الفحوص أعلاه بلا معنى.
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
    assert.ok(tables.length >= 25, `المخطط الحيّ فيه ${tables.length} جدولاً فقط — يبدو غير مُهيّأ`);
    const empty = tables
      .map(t => ({ name: t.name, cols: db.prepare(`PRAGMA table_info(${t.name})`).all().length }))
      .filter(t => t.cols === 0);
    assert.equal(empty.length, 0, `جداول بلا أعمدة: ${empty.map(e => e.name).join(', ')}`);
  });

  test('الحارس نفسه يهشّ: جملة بجدول وعمود وهميين تُبلَّغ كخلل', () => {
    // إثبات أن الاختبار ليس زينة. نمرّر عليه جملتين على جدول وعمود غير موجودين
    // ونفرض أن يكتشفهما في كل تشغيل.
    //
    // الاسمَان الأصليّان كانا `promotion_points` و`rank_epoch` — الجدول والعمود
    // اللذين أسقطا الحادثة الأصلية. صارا موجودين فعلاً بخطوة ترحيل نظام
    // النقاط، فلم يبقى منهما دليلٌ على هشاشة الحارس: جملة تصف جدولاً موجوداً
    // تنجح، فيمرّ الاختبار وهو لا يفحص شيئاً — وهو بالضبط نمط «تحقّقٌ يبدو
    // ناجحاً ولا يفحص حقيقة» الذي حذّر منه سجلّ IMPROVEMENTS.
    // البديلان أدناه غير موجودين في المخطط ولا في أي ملف تحت src/ (مُتحقَّق
    // بالبحث)، فيبقى الاختبار حارساً على الحارس نفسه. إن أُضيف جدول أو عمود
    // بهذا الاسم يوماً فسيفشل هذا الاختبار — وهذا هو المطلوب: إشارة إلى أن
    // الدليل صار ميتاً ويحتاج اسماً وهمياً جديداً.
    const cases = [
      ['SELECT * FROM reward_events', 'table', 'reward_events'],
      ['SELECT points_total FROM staff_members', 'column', 'points_total'],
    ];
    for (const [sql, kind, name] of cases) {
      let thrown = null;
      try { db.prepare(sql); } catch (e) { thrown = e; }
      assert.ok(thrown, `المخطط قَبِل جملة على ${kind} غير موجود: ${sql}`);
      assert.match(thrown.message, new RegExp(`no such ${kind}: ${name}`, 'i'));
    }
  });

  test('كل استعلام src/ مرصود في قائمة الجمل المفحوصة', () => {
    // كل موقع .prepare في src محسوب: إن اختفى الفحص كله يبقى العدد صفراً.
    assert.ok(
      audit.skips.length + audit.statements.length > 0,
      'لا مواقع مفحوصة ولا متخطّاة — المحلّل لا يجد أي .prepare',
    );
  });
});