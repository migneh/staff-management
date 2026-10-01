'use strict';
/**
 * أمان الإقلاع: بياناتٌ معطوبةٌ في القيم يجب ألّا تمنع البوت من الإقلاع.
 *
 * أخطر عطل في المشروع كان هنا: `migrate()` غير ملفوف بمعاملة، ولا وجود لجدول
 * إصدارات، و`CREATE UNIQUE INDEX idx_ticket_source_message` يرمي
 * SQLITE_CONSTRAINT إن كان في `ticket_metrics` صفّان بنفس `source_message_id`.
 * الاستثناء كان يخرج من getDb() فيطبع index.js `process.exit(1)`، و migrate()
 * يُعاد على كل إقلاع فلا يشفي نفسه شيء: البوت لا يقلع حتى يفتح إنسان القاعدة
 * يدوياً — وكل ALTER سابقها autocommit، فلا يبقى أي أثر يقول أين توقّف.
 *
 * ما يثبّته هذا الملف:
 *  1) قاعدة بمكرّر **تعدّي الإقلاع**: migrate() لا ترمي، ولا تُسقط ضمان عدم
 *     التكرار صامتاً، وتسجّل العطل في مرجعٍ يُقرأ منه.
 *  2) الترحيل الجزئي **قابل للكشف**: schema_version تقول ما طُبِّق وما لم يُطبَّق.
 *  3) كل خطوة **ذرّية**: فشل جملة في وسط خطوة لا يترك نصفها منطبَقاً.
 *  4) القاعدة المرحَّلة مرّة **لا تُمسّ** عند إعادة الترحيل.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe } = require('node:test');
const assert = require('node:assert');
const database = require('../src/database');
const { openMemoryDb, migrate, schemaFaults, pendingSchemaSteps, MIGRATION_STEPS } = database;

const DUP_A = '900000000000000001';
const DUP_B = '900000000000000002';

const insTicket = (db, ticketId, msg) => db.prepare(`INSERT INTO ticket_metrics
  (ticket_id, ticket_owner, claimer, closer, logged_by, source_message_id)
  VALUES (?, 'o', 'c', 'c', 'l', ?)`).run(ticketId, msg);

const hasIndex = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name=?").get(name);
const hasTrigger = (db, name) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name=?").get(name);

/** قاعدة فيها صفّان بنفس source_message_id — الصورة التي كانت تقتل الإقلاع. */
function dbWithDuplicates() {
  const db = openMemoryDb();
  db.exec('DROP INDEX IF EXISTS idx_ticket_source_message');
  insTicket(db, 't1', DUP_A);
  insTicket(db, 't2', DUP_A);
  return db;
}

/** بصمة كاملة: نص كل كائن في المخطط + عدد الصفوف في كل جدول. */
function fingerprint(db) {
  const objects = db.prepare("SELECT type, name, COALESCE(sql,'') sql FROM sqlite_master ORDER BY type, name").all()
    .map(o => `${o.type} ${o.name} ${o.sql.replace(/\s+/g, ' ')}`);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const counts = tables.map(({ name }) => `${name}=${db.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c}`);
  return objects.join('\n') + '\n--\n' + counts.join(',');
}

describe('C1 — بيانات معطوبة في القيم لا تمنع الإقلاع', () => {
  test('migrate() تعبر قاعدة فيها source_message_id مكرّر بدل أن ترمي', () => {
    const db = dbWithDuplicates();
    let thrown = null;
    try { migrate(db); } catch (e) { thrown = e; }
    assert.equal(thrown, null,
      `البوت ما زال لا يقلع على قاعدة بمكرّر واحد: ${thrown && thrown.message}\n` +
      'وهذا يعني process.exit(1) عند كل إقلاع حتى معالجة يدوية للقاعدة.');
  });

  test('الإقلاع الثاني لا يفشل أيضاً: العطل لا يتجدّد على كل تشغيل', () => {
    // هذا هو الثابت المطلوب: أي ترحيل يجب أن يكون آمناً على الإقلاع التالي.
    const db = dbWithDuplicates();
    for (let attempt = 1; attempt <= 3; attempt++) {
      assert.doesNotThrow(() => migrate(db), `التشغيل ${attempt} من الترحيل رما`);
    }
  });

  test('ضمان عدم التكرار يبقى قائماً: الإدراج الثالث لنفس الرسالة مرفوض', () => {
    // إسقاط الفهرس الفريد بصمت كان الحل «السهل» وكان خطأً: يحوّل السلامة إلى
    // تفاؤل فيُحسب التقييم مرتين من نفس الرسالة الخارجية. نقيس الضمان نفسه،
    // لا شكله: أي إدراج جديد بنفس المعرّف يجب أن يُرفض.
    const db = dbWithDuplicates();
    migrate(db);
    let thrown = null;
    try { insTicket(db, 't3', DUP_A); } catch (e) { thrown = e; }
    assert.ok(thrown, 'الإدراج الثالث بنفس source_message_id قُبل — صار احتساب الرسالة مرتين ممكناً');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ticket_metrics WHERE source_message_id = ?').get(DUP_A).c, 2,
      'عدد الصفوف بعد الإدراج المرفوض تغيّر');
    // والقيد الحقيقي (الفهرس) هو الشكل المفضّل متى أمكن بناؤه:
    assert.equal(hasIndex(db, 'idx_ticket_source_message'), false,
      'قاعدة فيها مكرّر يجب ألّا يُبنى عليها فهرس فريد — الاختبار يخطئ ولا يثبت شيئاً');
  });

  test('الصفوف المكرّرة نفسها لا تُحذف: لا إتلاف بيانات باسم الضمان', () => {
    const db = dbWithDuplicates();
    migrate(db);
    assert.equal(db.prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 2,
      'حُذفت صفوف تكتات باسم الإقلاع — هذا إتلاف بيانات لا ترحيل');
  });

  test('العطل مسجَّل في مرجع يُقرأ منه، لا في console فقط', () => {
    const db = dbWithDuplicates();
    migrate(db);
    const faults = schemaFaults(db);
    const fault = faults.find(f => f.step === 'ticket_source_unique');
    assert.ok(fault, `لم يُسجَّل العطل في schema_faults (الموجود: ${JSON.stringify(faults)})`);
    assert.match(fault.detail, new RegExp(DUP_A), 'التفصيل لا يذكر المعرّف المكرّر');
    assert.ok(fault.remediation && /DELETE FROM ticket_metrics/i.test(fault.remediation),
      `لا يوجد مسار علاجي محدّد للمشغّل: ${fault.remediation}`);
  });

  test('المعالجة يشفى نفسها: بعد تصحيح المكرر يعود القيد الحقيقي ويُلغى العطل', () => {
    const db = dbWithDuplicates();
    migrate(db);
    assert.ok(hasTrigger(db, 'trg_ticket_source_unique'), 'لم يُنشأ حارس يحل محل القيد الفريد');

    // المشغّل ينفّذ SQL الإصلاحي المذكور حرفياً (لا حذف صامت من البوت).
    const fix = db.prepare("SELECT remediation FROM schema_faults WHERE step='ticket_source_unique'").get().remediation;
    for (const sql of fix.split(';').map(s => s.trim()).filter(Boolean)) db.exec(sql);

    migrate(db);
    assert.ok(hasIndex(db, 'idx_ticket_source_message'), 'القيد الحقيقي لم يُعد بعد إصلاح البيانات');
    assert.equal(hasTrigger(db, 'trg_ticket_source_unique'), false, 'بقي الحارس البديل بعد عودة القيد الحقيقي');
    assert.deepEqual(schemaFaults(db), [], 'العطل لم يُمسح بعد عولج');
    // والقيد الحقيقي يُطبَّق على الإدراج الجديد:
    insTicket(db, 't9', DUP_B);
    assert.throws(() => insTicket(db, 't10', DUP_B), 'القيد الحقيقي لا يمنع التكرار بعد عودته');
  });
});

describe('C1 — جدول إصدارات المخطط: الترحيل الجزئي يُكتشف ولا يُخمَّن', () => {
  test('قاعدة جديدة تُسجّل كل خطوة', () => {
    const db = openMemoryDb();
    const done = db.prepare('SELECT name FROM schema_version').all().map(r => r.name);
    assert.ok(MIGRATION_STEPS.length >= 8, `قائمة الخطوات قصيرة: ${MIGRATION_STEPS.length}`);
    for (const step of MIGRATION_STEPS) assert.ok(done.includes(step), `الخطوة غير مسجّلة: ${step}`);
    assert.deepEqual(pendingSchemaSteps(db), []);
  });

  test('فشل في منتصف الترحيل: ما قبله مسجَّل، وما بعده معلوم أنه لم يُنفَّذ', () => {
    const db = openMemoryDb();
    // سن/step تُسمّي جدولاً باسم فهرس في خطوة indexes: CREATE INDEX يرمي
    // SQLITE_ERROR حتمياً في منتصف الخطوة — هذا خطأ برمجي لا في البيانات، وهو
    // بالضبط ما كانت migrate() تتركه بلا أثر.
    db.exec('DROP INDEX IF EXISTS idx_activity_dedup');
    db.exec('DROP INDEX IF EXISTS idx_staff_notes_user');
    db.exec('CREATE TABLE idx_staff_notes_user (poison INTEGER)');
    db.prepare('DELETE FROM schema_version').run();

    let thrown = null;
    try { migrate(db); } catch (e) { thrown = e; }
    assert.ok(thrown, 'خطوة indexes لم تفشل رغم التصادم — الاختبار لا يثبت شيئاً');

    const applied = new Set(db.prepare('SELECT name FROM schema_version').all().map(r => r.name));
    const before = MIGRATION_STEPS.slice(0, MIGRATION_STEPS.indexOf('indexes'));
    const after = MIGRATION_STEPS.slice(MIGRATION_STEPS.indexOf('indexes') + 1);
    for (const step of before) assert.ok(applied.has(step), `خطوة سابقة لم تُسجَّل رغم نجاحها: ${step}`);
    assert.equal(applied.has('indexes'), false, 'خطوة فاشلة سُجّلت كأنها طُبِّقت');
    for (const step of after) assert.equal(applied.has(step), false, `خطوة بعد الفاشلة سُجّلت: ${step}`);
    assert.deepEqual(pendingSchemaSteps(db), ['indexes', ...after],
      'القائمة المعلّقة لا تصف بدقة أين توقّف الترحيل');

    // والعطل نفسه مسجَّل فيمرّ عبر /healthz بدل أن يختفي.
    assert.ok(schemaFaults(db).some(f => f.step === 'indexes'), 'فشل الخطوة لم يُسجَّل');

    // بعد إزالة التصادم يستأنف التشغيل: لا خطوة تبقى معلّقة، والعطل يُمسح.
    db.exec('DROP TABLE idx_staff_notes_user');
    migrate(db);
    assert.deepEqual(pendingSchemaSteps(db), []);
    assert.deepEqual(schemaFaults(db), []);
    assert.ok(hasIndex(db, 'idx_staff_notes_user'), 'الفهرس لم يُبنَ بعد إزالة التصادم');
  });

  test('الخطوة ذرّية: جملة نجحت قبل الفشل لا تبقى منطبَقة', () => {
    const db = openMemoryDb();
    db.exec('DROP INDEX IF EXISTS idx_activity_dedup');   // أول جملة في خطوة indexes
    db.exec('DROP INDEX IF EXISTS idx_staff_notes_user');
    db.exec('CREATE TABLE idx_staff_notes_user (poison INTEGER)');
    try { migrate(db); } catch { /* متوقّع */ }
    assert.equal(hasIndex(db, 'idx_activity_dedup'), false,
      'فهرس نجح قبل الفشل بقي على القرص — الخطوة ليست ذرّية، وحالة نصف-مطبَّق بلا أثر');
  });
});

describe('العمودان الجديدان يمرّان بمسار addTableColumns لا ALTER خام', () => {
  test('قاعدة قديمة بلا absence_dm_sent_at ولا reminder_attempts تُرقّى عند الإقلاع', () => {
    const db = openMemoryDb();
    // القاعدة الحيّة قبل هذا الإصدار: الجداول موجودة لكن الأعمدة الجديدة لا.
    db.exec('DROP TABLE staff_members');
    db.exec('CREATE TABLE staff_members (user_id TEXT PRIMARY KEY, team TEXT NOT NULL, rank TEXT NOT NULL, status TEXT NOT NULL DEFAULT \'active\', absence_alert_level INTEGER NOT NULL DEFAULT 0)');
    db.exec('DROP TABLE staff_tasks');
    db.exec(`CREATE TABLE staff_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, title TEXT NOT NULL,
      task_type TEXT NOT NULL DEFAULT 'general', due_date TEXT, status TEXT NOT NULL DEFAULT 'pending', reminder_sent_at TEXT)`);
    const cols = (t) => new Set(db.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name));
    assert.equal(cols('staff_members').has('absence_dm_sent_at'), false, 'العمود موجود أصلاً — الاختبار لا يثبت شيئاً');
    assert.equal(cols('staff_tasks').has('reminder_attempts'), false, 'العمود موجود أصلاً — الاختبار لا يثبت شيئاً');

    migrate(db);

    assert.ok(cols('staff_members').has('absence_dm_sent_at'), 'قاعدة قديمة لم تُرقّى: علامة الرسالة الخاصة غائبة');
    assert.ok(cols('staff_tasks').has('reminder_attempts'), 'قاعدة قديمة لم تُرقّى: عدّاد المحاولات غائب');
    assert.ok(cols('staff_tasks').has('reminder_given_up_at'), 'عمود الاستسلام غائب عن القاعدة القديمة');
    // والقيم الافتراضية سليمة: لا NULL مكان 0.
    db.prepare("INSERT INTO staff_tasks (user_id, title, task_type) VALUES ('u','t','onboarding')").run();
    assert.equal(db.prepare('SELECT reminder_attempts FROM staff_tasks').get().reminder_attempts, 0);
    // والتشغيل الثاني لا يمسّ شيئاً.
    const before = fingerprint(db);
    migrate(db);
    assert.equal(fingerprint(db), before);
  });
});

describe('C1 — قاعدة مرحَّلة مرّة: إعادة الترحيل لا تُغيّر شيئاً', () => {
  test('migrate() مرّتين: المخطط والصفوف والدفتر كما هي', () => {
    const db = openMemoryDb();
    db.prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?,?,?,?,?)')
      .run('u1', 'u1', 'support', 'Support', 'active');
    db.prepare('INSERT INTO faq_entries (category_id, title, content, created_by) VALUES (?,?,?,?)')
      .run(3, 'عنوان', 'محتوى', 'boss');
    const before = fingerprint(db);
    const marks = db.prepare('SELECT name, applied_at FROM schema_version ORDER BY name').all();
    assert.ok(marks.length, 'لا علامات في schema_version — الاختبار لا يثبت شيئاً');

    migrate(db);
    migrate(db);

    assert.equal(fingerprint(db), before, 'إعادة الترحيل غيّرت شيئاً');
    assert.deepEqual(db.prepare('SELECT name, applied_at FROM schema_version ORDER BY name').all(), marks,
      'العلامات أُعيدت — أي أن الخطوات طُبِّقت مرّة ثانية');
    // خريطة الإصدار 2 تنقل 3 ← 2، فلو طُبِّقت مرّة ثانية لأصبح 2. بقاؤه 3 هو
    // الدليل المباشر على أن الخريطة لم تُعَد على بيانات طبّقتها من قبل.
    assert.deepEqual(db.prepare('SELECT category_id FROM faq_entries').all(), [{ category_id: 3 }],
      'خريطة FAQ طُبِّقت على بيانات طبّقتها من قبل');
  });
});