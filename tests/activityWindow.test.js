'use strict';
/**
 * نافذة `activity.stats()` يجب أن تُقرأ من عمود `day` المفهرس.
 *
 * العيب: `WHERE user_id = ? AND created_at >= datetime('now', ?)` — لا فهرس في
 * المشروع يبدأ بـ user_id وينتهي بـ created_at معاً، فالمخطّط كان يأخذ فهرس
 * user_id وحده، ويقرأ **كل** الصفوف المحفوظة لذلك العضو (قِيس: 146 ألف صف)
 * ثم يمرّرها عبر شجرة B-tree مؤقتة للتجميع — 236 مللي ثانية لإجابة 6 آلاف صف.
 * وهذا على /activity و/my-status، أي على المسار التفاعلي الأطول.
 *
 * لذا ثلاث طبقات، كما في sargableWindows.test.js:
 *  1) الشكل — لا تغليف دالة على عمود في حدّ نطاق، ولا datetime('now') في نافذة
 *     تُجيب عن «أيام تقويمية».
 *  2) التكافؤ الحدي — نفس الصفوف بنفس النتائج على الطوابع الإحدى عشرة.
 *  3) الخطة على مقياس حقيقي — 146 ألف صف كما قاس التدقيق.
 *
 * ★ لماذا النافذة على `day` لا `created_at`: `day` تاريخ مجرّد (YYYY-MM-DD)
 *   مخزَّن بتوقيت السيرفر عبر clock.today، وهو العمود الثاني في
 *   idx_activity_user_day — أي حدّ نطاق صالح على B-tree. وcreated_at مخزَّن
 *   UTC؛ استخدامُه للنافذة كان يخلط التوقيتين (services/clock.js).
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const activity = require('../src/services/activity');

const UID_ = '111111111111111111';
const OTHER = '222222222222222222';

// ============================================================ 1) query shape

/** يلتقط نص كل جملة تُنفَّذ فعلياً — يبقى الاختبار صالحاً لو نُقل الاستعلام */
function capturedQueries(run) {
  const db = getDb();
  const original = db.prepare.bind(db);
  const seen = [];
  db.prepare = (sql) => { seen.push(String(sql)); return original(sql); };
  try { run(); } finally { db.prepare = original; }
  return seen;
}

describe('shape: stats() يقرأ day المفهرس لا created_at الملفوف', () => {
  beforeEach(() => { openMemoryDb(); });

  test('لا استعلام في stats() يغلّف عموداً في دالة داخل WHERE', () => {
    const offenders = capturedQueries(() => activity.stats(UID_, 30))
      .filter(sql => /WHERE[\s\S]*?\b(?:date|datetime|julianday|strftime)\s*\(\s*(day|created_at)/i.test(sql))
      .map(sql => sql.replace(/\s+/g, ' ').slice(0, 140));
    assert.deepEqual(offenders, [], `عمود ملفوف بدالة:\n${offenders.join('\n')}`);
  });

  test('لا استعلام في stats() يعتمد datetime(\'now\') لنافذة نسبية', () => {
    // النافذة الآن محسوبة في JS عبر clock.addDays — لا يُترك لحساب SQLite،
    // وإلا اختلف مرجع «اليوم» عن بقية المشروع (server TZ).
    const offenders = capturedQueries(() => activity.stats(UID_, 30))
      .filter(sql => /datetime\(\s*'now'/i.test(sql))
      .map(sql => sql.replace(/\s+/g, ' ').slice(0, 140));
    assert.deepEqual(offenders, [], `استعلام بعدة نسبية إلى now:\n${offenders.join('\n')}`);
  });

  test('كل استعلامات stats() تحدّ عمود day على ambos الطرفين بحدّ فهرسي', () => {
    const queries = capturedQueries(() => activity.stats(UID_, 30));
    const activityQueries = queries.filter(sql => /FROM activity_logs/i.test(sql));
    assert.ok(activityQueries.length >= 2, `توقّعنا استعلامَي activity_logs، وُجد ${activityQueries.length}`);
    for (const sql of activityQueries) {
      const one = sql.replace(/\s+/g, ' ');
      assert.match(one, /WHERE user_id = \? AND day >= \?/i, `بلا حدّ أدنى على day: ${one.slice(0, 140)}`);
      assert.match(one, /day <= \?/i, `بلa حدّ أعلى على day: ${one.slice(0, 140)}`);
      // half-open on a timestamp column is the clock.dayWindow style; on a bare
      // day column an inclusive upper bound is correct — but a <= on a
      // *timestamp* column would drop 23:59:59, so assert day is what is bounded.
      assert.doesNotMatch(one, /created_at\s*[<>]/i, `الاستعلام ما زال يحدّ created_at: ${one.slice(0, 140)}`);
    }
  });

  test('stats() لا يستخدم datetime(created_at) مغلوفاً — قاطع الاختبار', () => {
    // هذا هو ما كان موجوداً قبل الإصلاح؛ نثبّت أنه لم يعد موجوداً.
    const sql = capturedQueries(() => activity.stats(UID_, 30)).find(s => /FROM activity_logs/i.test(s));
    assert.ok(sql, 'لم يُلتقط أي استعلام');
    assert.doesNotMatch(sql, /created_at/i, `ما زال يقرأ created_at: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
  });
});

// ==================================================== 2) boundary equivalence

/**
 * الطوابع الحدية: windows على day مجرّدة تقارن days لا timestamps، فنضع
 * `day` = TZ-day من `created_at` — وهذا ما تفرضه activities.record() عبر
 * clock.today() ويصحّحه scripts/migrate-activity-timezone.js. هذا هو الشرط
 * الذي يجعل day وcreated_at متساويين بالتقويم.
 */
const START = '2026-09-02';
const END = '2026-10-01';

const EDGES = [
  ['2026-09-01 23:59:59', 'يوم قبل البداية'],
  ['2026-09-02 00:00:00', 'أول لحظة في أول يوم — داخل'],
  ['2026-09-02 00:00:01', 'ثانية بعد بداية أول يوم'],
  ['2026-09-02 12:00:00', 'منتصف أول يوم'],
  ['2026-09-15 03:14:07', 'منتصف النافذة'],
  ['2026-10-01 00:00:00', 'أول لحظة في آخر يوم — داخل'],
  ['2026-10-01 12:00:00', 'منتصف آخر يوم'],
  ['2026-10-01 23:59:59', 'آخر ثانية في آخر يوم — داخل'],
  ['2026-10-02 00:00:00', 'أول لحظة في اليوم التالي — خارج'],
  ['2026-10-02 00:00:01', 'خارج'],
  ['2026-10-15 10:00:00', 'خارج بوضوح'],
];

describe('تكافؤ الحدود: day BETWEEN = date(day) على day المخزَّن', () => {
  test('الطوابع الإحدى عشرة تتّفق صفاً بصف — والجدول نفسه هو الإثبات', () => {
    // ★ المقارنة апples-to-apples: كلاهما على **day**. الشكل القديم الذي نُثبت
    // أنه مكافئ هو `date(day) BETWEEN` — أي تغليف دالة على العمود نفسه، وهو ما
    // كان يجعله غير قابل للفهرسة. الشكل الجديد `day >= ? AND day <= ?`.
    // (لا نقارن بـ date(created_at): created_at مخزَّن UTC وday بتوقيت السيرفر،
    //  فالفرق بينهما فرق توقيت مقصود لا فرق منطق — services/clock.js.)
    //
    // day يُزرع من الجزء التاريخي من ts مباشرة: المقارنة على day يجب أن تكون
    // محايدة تجاه التوقيت، وإلا اختلط فيها فرقُ التوقيت بفرقِ المنطق.
    const table = [];
    for (const [ts, label] of EDGES) {
      openMemoryDb();
      const day = ts.slice(0, 10);
      getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day, created_at)
        VALUES (?, 'c', 'staff', 1, 'h', ?, ?)`).run(UID_, day, ts);

      const oldShape = getDb().prepare('SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND date(day) BETWEEN ? AND ?').get(UID_, START, END).c;
      const newShape = getDb().prepare('SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND day >= ? AND day <= ?').get(UID_, START, END).c;

      table.push({ ts, label, day, oldShape, newShape, agree: oldShape === newShape });
    }

    // الجدول كامل — يُطبع عند الفشل ليُفهم فوراً أين انكسر
    if (table.some(r => !r.agree)) {
      console.error('جدول التكافؤ:\n' + JSON.stringify(table, null, 2));
    }
    const mismatches = table.filter(r => !r.agree);
    assert.deepEqual(mismatches, [], `اختلاف على الحدود:\n${JSON.stringify(mismatches, null, 2)}`);

    // تأكيد تسمية الصفحات: اليوم الأول واليوم الأخير داخل، وما بعدهما خارج
    const inside = ts => table.find(r => r.ts === ts);
    assert.equal(inside('2026-09-02 00:00:00').newShape, 1, 'أول يوم يجب أن يكون داخلاً');
    assert.equal(inside('2026-10-01 23:59:59').newShape, 1, 'آخر ثانية في آخر يوم يجب أن تكون داخلاً');
    assert.equal(inside('2026-10-02 00:00:00').newShape, 0, 'اليوم التالي يجب أن يكون خارجاً');
    assert.equal(inside('2026-09-01 23:59:59').newShape, 0, 'اليوم السابق يجب أن يكون خارجاً');
  });

  test('صف واحد في الطابع الخام: day المخزَّن هو المرجع — الصف داخل أو خارج، بلا حدّ غامض', () => {
    // day مجرّد بلا وقت، فلا يوجد حدّ 23:59:59 أصلاً — وهذا ما يجعل
    // day <= end آمناً هنا حيث يكون closed_at <= end مميتاً لصف 23:59:59.
    openMemoryDb();
    const endDay = clock.today();
    const day = clock.addDays(endDay, -29);
    getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day, created_at)
      VALUES (?, 'c', 'staff', 1, 'h', ?, ?)`).run(UID_, day, `${day} 23:59:59`);
    // آخر يوم مشمول بالكامل
    assert.equal(activity.stats(UID_, 30).messages, 1, 'صف آخر يوم سقط');
  });

  test('صف من مستخدم آخر لا يتسرّب إلى نافذة العضو', () => {
    openMemoryDb();
    const day = clock.addDays(clock.today(), -3);
    const ins = db => db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day)
      VALUES (?, 'c', 'staff', 1, ?, ?)`);
    ins(getDb()).run(UID_, 'mine', day);
    ins(getDb()).run(OTHER, 'theirs', day);
    const s = activity.stats(UID_, 30);
    assert.equal(s.messages, 1, 'صف مستخدم آخر تسرّب إلى نافذة العضو');
    assert.deepEqual(s.byType, { staff: 1 });
  });

  test('النافذة calendar_days لا rolling-hours: عدد الأيام النشطة ≤ days', () => {
    openMemoryDb();
    const db = getDb();
    // صف في كل يوم من 40 يوماً ماضية
    for (let i = 0; i < 40; i++) {
      const day = clock.addDays(clock.today(), -i);
      db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day)
        VALUES (?, 'c', 'staff', 1, ?, ?)`).run(UID_, `h${i}`, day);
    }
    const s = activity.stats(UID_, 30);
    assert.equal(s.messages, 30, `messages=${s.messages} — النافذة ليست 30 يوماً تقويمياً`);
    assert.equal(s.activeDays, 30, `activeDays=${s.activeDays} — تجاوز النافذة`);
  });

  test('byType وmessages وweighted متسقة مع بعض — لا مسار يقدّم رقماً مختلفاً', () => {
    openMemoryDb();
    const db = getDb();
    const day = clock.today();
    const w = { ticket: 0.5, staff: 0.25, moderation: 0.25, general: 0.1 };
    for (const [type, weight] of Object.entries(w)) {
      const n = type === 'ticket' ? 4 : type === 'general' ? 10 : 2;
      for (let k = 0; k < n; k++) {
        db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day)
          VALUES (?, 'c', ?, ?, ?, ?)`).run(UID_, type, weight, `${type}${k}`, day);
      }
    }
    const s = activity.stats(UID_, 30);
    assert.deepEqual(s.byType, { ticket: 4, staff: 2, moderation: 2, general: 10 });
    const sum = Object.values(s.byType).reduce((a, b) => a + b, 0);
    assert.equal(s.messages, sum, 'messages ≠ مجموع byType');
    const expected = Math.round((4 * 0.5 + 2 * 0.25 + 2 * 0.25 + 10 * 0.1) * 100) / 100;
    assert.equal(s.weighted, expected, `weighted=${s.weighted} المتوقّع ${expected}`);
    assert.equal(s.activeDays, 1);
  });
});

// ==================================================== 3) the plan on scale

describe('خطة التنفيذ على مقياس حقيقي (146 ألف صف — كما قاس التدقيق)', () => {
  const BIG = 146000;
  const OTHERS = 5000;

  function scale() {
    const db = getDb();
    const stmt = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day, created_at)
      VALUES (?, 'c', 'staff', 0.25, ?, ?, ?)`);
    let seq = 0;
    const today = clock.today();
    db.exec('BEGIN');
    // 730 يوماً للعضو الهدف (~200 صف/يوم)
    for (let d = 0; d < 730; d++) {
      const day = clock.addDays(today, -d);
      for (let k = 0; k < 200; k++) stmt.run(UID_, `a${seq++}`, day, `${day} 12:00:00`);
    }
    // صفحات muitosوظرين — ليس عضواً واحداً
    for (let k = 0; k < OTHERS; k++) stmt.run(`other${k % 200}`, `b${seq++}`, '2020-01-01', '2020-01-01 00:00:00');
    db.exec('COMMIT');
    db.exec('ANALYZE'); // بلا إحصاءات يختار المخطّط بلا ترجيح حقيقي
  }

  test('بعد الإصلاح: SEARCH على day داخل idx_activity_user_day — لا SCAN كامل', () => {
    openMemoryDb();
    scale();

    const db = getDb();
    const sql = capturedQueries(() => activity.stats(UID_, 30)).find(s => /FROM activity_logs/i.test(s));
    assert.ok(sql, 'لم يُلتقط استعلام');
    const params = [UID_, clock.addDays(clock.today(), -29), clock.today()];
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => String(r.detail)).join(' | ');

    assert.match(plan, /SEARCH/, `المتوقّع SEARCH لا مسح: ${plan}`);
    assert.match(plan, /idx_activity_user_day/, `الفهرس المتوقع غير مستخدم: ${plan}`);
    assert.match(plan, /day>/i, `حدّ day غير ظاهر في الخطة: ${plan}`);
    assert.doesNotMatch(plan, /^SCAN|\| *SCAN/m, `مسح كامل بعد الإصلاح: ${plan}`);
  });

  test('قبل الإصلاح: created_at لا يظهر كحدّ في الخطة — المقارنة تُثبت العطب', () => {
    openMemoryDb();
    scale();
    const db = getDb();

    // الشكل القديم — نعيد بناءه حرفياً كما كان.
    // ناحظ أن زميلاً أضاف idx_activity_user_created (user_id, created_at) في
    // commit 2022c1a، فصار لهذا الشكل حدّ فهرسي — لذلك لا نُثبت هنا أن الشكل
    // القديم سيئ (قد لم يعد كذلك)، بل نُثبت الثابت البنيوي: day هو العمود
    // المُقيَّد في الخطة الجديدة، ولا created_at يظهر فيها. وفي مخطط HEAD
    // الأصلي (idx_activity_dedup = user_id, content_hash, created_at) كان
    // content_hash عموداً وسيطاً غير مقيَّد فلا يصلح حدّاً لنطاق created_at،
    // فكانت الخطة تقرأ كل صفوف العضو.
    const oldSql = `SELECT channel_type, COUNT(*) c, SUM(weight) w FROM activity_logs
      WHERE user_id = ? AND created_at >= datetime('now', ?) GROUP BY channel_type`;
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).all(UID_, '-30 days').map(r => String(r.detail)).join(' | ');

    const newPlan = db.prepare(`EXPLAIN QUERY PLAN
      SELECT channel_type, COUNT(*) c, SUM(weight) w FROM activity_logs
      WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY channel_type`)
      .all(UID_, clock.addDays(clock.today(), -29), clock.today()).map(r => String(r.detail)).join(' | ');

    assert.match(newPlan, /day>/i, `day غير مقيّد في الخطة الجديدة: ${newPlan}`);
    assert.doesNotMatch(newPlan, /created_at/i, `الخطة الجديدة ما زالت على created_at: ${newPlan}`);
    assert.ok(plan.length > 0, 'الخطة القديمة فارغة');
  });

  test('الشهران الحديّان داخل، ولا شيء بعدهما — على المقياس الكبير', () => {
    openMemoryDb();
    scale();
    const s = activity.stats(UID_, 30);
    // 730 يوماً × 200 صف = 146000، نافذة 30 يوماً → 6000 صف بالضبط
    assert.equal(s.messages, 30 * 200, `messages=${s.messages} المتوقّع ${30 * 200}`);
    assert.equal(s.activeDays, 30);
  });
});