'use strict';
/**
 * استعلامات النافذة الزمنية يجب أن تبقى قابلة للفهرسة.
 *
 * العيب الذي يمنع هذا الملف: تغليف عمود الطابع الزمني بـ date() يجعله غير صالح
 * أن يكون حدّاً لفهرس B-tree، فيقيّده SQLite بعمود التساوي الأسبق فقط ويمرّر
 * date() على كل صف أنشأه العضو — وكلا جدولي ticket_metrics وmod_actions لا
 * يُقلّمان أبداً. الفهرسة ليست تفصيل أداء هنا: الخطة القديمة كانت SCAN كامل
 * للجدول (لا حتىSEARCH بعمود المستخدم).
 *
 * لهذا الملف ثلاث طبقات:
 *  1) تأكيد الشكل (نص الاستعلام) — لا يُكسر بتغيّر زمن التنفيذ، ويلتقط عودة
 *     date() لو أعادها أحد.
 *  2) تأكيد التكافؤ الحدي — نفس الصفوف بنفس النتائج قبل وبعد التغيير.
 *  3) تأكيد الخطة على مقياس حقيقي — 73 ألف صف كما قاس التدقيق.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach, describe } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const reports = require('../src/services/reports');
const promotions = require('../src/services/promotions');

const UID_ = '111111111111111111';
const OTHER = '222222222222222222';

// ============================================================ clock helpers

describe('clock.dayStartStamp / clock.dayWindow', () => {
  test('dayStartStamp يبني طابع UTC بطول 19 محرفاً كما يخزّنه datetime(\'now\')', () => {
    assert.equal(clock.dayStartStamp('2026-09-02'), '2026-09-02 00:00:00');
    // نفس الطول الذي تنتجه nowIso() — بدونه تفشل المقارنة النصية على الفهرس
    assert.equal(clock.dayStartStamp('2026-09-02').length, clock.nowIso().length);
  });

  test('dayStartStamp يرفض ما ليس يوماً صالحاً بدل إنتاج نصّ كسور', () => {
    for (const bad of ['', null, undefined, '2026-9-2', '2026-13-01', '2026-02-30', 'yesterday']) {
      assert.equal(clock.dayStartStamp(bad), null, String(bad));
    }
  });

  test('dayWindow يجعل الحد الأعلى نصف مفتوح على منتصف ليل اليوم التالي', () => {
    assert.deepEqual(clock.dayWindow('2026-09-02', '2026-10-01'), {
      start: '2026-09-02 00:00:00',
      endExclusive: '2026-10-02 00:00:00',
    });
  });

  test('يوم واحد: الحد الأعلى = اليوم التالي', () => {
    assert.deepEqual(clock.dayWindow('2026-10-01', '2026-10-01'), {
      start: '2026-10-01 00:00:00',
      endExclusive: '2026-10-02 00:00:00',
    });
  });

  test('النافذة تعبر حدود الشهر والسنة والحُرم (تقفز 30 و31 و29 فبراير)', () => {
    assert.equal(clock.dayWindow('2026-01-30', '2026-02-02').endExclusive, '2026-02-03 00:00:00');
    assert.equal(clock.dayWindow('2024-02-28', '2024-03-01').endExclusive, '2024-03-02 00:00:00');
    assert.equal(clock.dayWindow('2025-12-30', '2026-01-02').endExclusive, '2026-01-03 00:00:00');
  });

  test('يرفض النافذة المقلوبة أو الفاسدة بدل إنتاج حدّ أعلى قبل الأوّلي', () => {
    assert.equal(clock.dayWindow('2026-10-01', '2026-09-02'), null);
    assert.equal(clock.dayWindow('2026-10-01', 'bad'), null);
    assert.equal(clock.dayWindow('bad', '2026-10-01'), null);
  });
});

// ============================================================ 1) query shape

/**
 * يلتقط كل استعلام يُنفَّذ على الجداول ذات الطابع الزمني في نافذة score/promotions.
 * نلتقط النصوص عبر prepare بدل قراءة المصدر، فيبقى الاختبار صالحاً لو نُقل
 * الاستعلام إلى ملف آخر.
 */
const captured = [];
function captureQueries(run) {
  const db = getDb();
  const original = db.prepare.bind(db);
  db.prepare = (sql) => { captured.push(String(sql)); return original(sql); };
  try { run(); } finally { db.prepare = original; }
  return captured;
}

function seedStaff(userId, team) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since)
    VALUES (?, ?, ?, ?, 'active', datetime('now', '-400 days'))`)
    .run(userId, `u${userId}`, team, team === 'support' ? 'Support' : 'Moderator');
}

/** يُشغّل reports.getRaw وpromotions.evaluate لعضوين ويعيد كل نص استعلام، مفصولاً */
function allWindowQueries() {
  const byCaller = { raw: [], promotions: [] };
  for (const [id, team] of [[UID_, 'support'], [OTHER, 'moderation']]) {
    seedStaff(id, team);
    const member = getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
    captured.length = 0;
    captureQueries(() => reports.getRaw(id, 30, 0));
    byCaller.raw.push(...captured);
    captured.length = 0;
    captureQueries(() => promotions.evaluate(member));
    byCaller.promotions.push(...captured);
  }
  byCaller.all = [...byCaller.raw, ...byCaller.promotions];
  return byCaller;
}

/** نافذة مغلقة: نافذتان زمنيتان،Both must be half-open on the raw column */
function isTwoSidedWindow(sql) {
  // نافذة مغلقة = نافذتان زمنيتان على الطابع الزمني = monthlyRaw.
  // استعلامات promotions_since حدودها الدنيا وحدها (`>= since`) فليست مغلقة،
  // والحكم عليها بـ `<` ظلم لها: حدّ أعلى مفتوح هو semantics الصحيح لها.
  return /FROM (ticket_metrics|support_ratings|mod_actions|warnings|staff_notes)\b/i.test(sql)
    && /(created_at|closed_at|rated_at)\s*<\s*\?/i.test(sql);
}

describe('shape: no date() on a range-bounded column', () => {
  beforeEach(() => { openMemoryDb(); });

  test('no query in reports/promotions wraps a column in date() inside WHERE', () => {
    const offenders = allWindowQueries().all
      .filter(sql => /WHERE[\s\S]*?\bdate\s*\(/i.test(sql))
      .map(sql => sql.replace(/\s+/g, ' ').slice(0, 160));
    assert.deepEqual(offenders, [], `date() on a range-bounded column:\n${offenders.join('\n')}`);
  });

  test('every window query on an indexed table bounds the raw column with >=', () => {
    const { raw, promotions: promo } = allWindowQueries();
    const windows = [...raw, ...promo].filter(sql =>
      /FROM (ticket_metrics|support_ratings|mod_actions|warnings|staff_notes)\b/i.test(sql));
    assert.ok(windows.length >= 14, `expected the 14 window queries, saw ${windows.length}`);
    for (const sql of windows) {
      const oneLine = sql.replace(/\s+/g, ' ');
      assert.match(oneLine, /(created_at|closed_at|rated_at)\s*>=/i,
        `no lower bound on the raw column: ${oneLine.slice(0, 160)}`);
      // الحد الأعلى نصف مفتوح: < وليس <= — BETWEEN كان شاملاً للطرفين
      if (isTwoSidedWindow(sql)) {
        assert.match(oneLine, /(created_at|closed_at|rated_at)\s*<\s*\?/i,
          `no exclusive upper bound: ${oneLine.slice(0, 160)}`);
        assert.doesNotMatch(oneLine, /(created_at|closed_at|rated_at)\s*<=/i,
          `inclusive upper bound drops a 23:59:59 row: ${oneLine.slice(0, 160)}`);
      }
    }
  });

  test('the closed windows in monthlyRaw are exactly the half-open ones', () => {
    const closed = allWindowQueries().raw.filter(isTwoSidedWindow)
      .map(sql => sql.replace(/\s+/g, ' ').slice(0, 70));
    assert.equal(closed.length, 12, `expected 12 closed windows (6 queries per staff: staff_notes positive and negative separately), saw ${closed.length}:\n${closed.join('\n')}`);
  });

  test('no BETWEEN on a timestamp column — only on the day column', () => {
    // BETWEEN on a date column (activity_logs.day) is intended: it holds a
    // bare YYYY-MM-DD, so there is no 23:59:59 boundary to drop.
    for (const sql of allWindowQueries().all) {
      const oneLine = sql.replace(/\s+/g, ' ');
      if (!/FROM (ticket_metrics|support_ratings|mod_actions|warnings|staff_notes)\b/i.test(oneLine)) continue;
      assert.doesNotMatch(oneLine, /\bBETWEEN\b/i,
        `BETWEEN on a timestamp column reintroduces the inclusive-upper-bound trap: ${oneLine.slice(0, 140)}`);
    }
  });

  test('activity_logs: reports reads the indexed day column, promotions bounds created_at', () => {
    // score.js يقارن بday (عمود مؤرَّخ بتوقيت TZ عبر today()) فالمقارنة نصية
    // مباشرة على (user_id, day). promotions.js كان يقارن بـ date(created_at)
    // — UTC — فالتبديل إلى day هنا يزيح حدّ النافذة حتى 3 ساعات عند الطرف،
    // وهو تغيير سلوك لا تحسين فهرسة. يبقى created_at لكن بنصف مفتوح.
    // ملاحظة: evaluate يستدعي monthlyRaw داخلياً، فاستعلام score يظهر داخل
    // سلة promotions أيضاً — نميّزه بنمط محدّده (day BETWEEN بثلاثة معاملات).
    const isMonthlyRawActivity = sql => /FROM activity_logs/i.test(sql) && /day BETWEEN \? AND \?/i.test(sql);
    const { raw, promotions: promo } = allWindowQueries();

    for (const sql of raw.filter(s => /FROM activity_logs/i.test(s))) {
      assert.match(sql.replace(/\s+/g, ' '), /WHERE user_id = \? AND day/i,
        `score.js must keep the indexed day column: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`);
    }

    const own = promo.filter(s => /FROM activity_logs/i.test(s) && !isMonthlyRawActivity(s));
    assert.ok(own.length >= 2, `saw ${own.length} promotions-owned activity_logs queries`);
    for (const sql of own) {
      const oneLine = sql.replace(/\s+/g, ' ');
      assert.match(oneLine, /WHERE user_id = \? AND created_at >= \?/i,
        `promotions must stay on UTC created_at: ${oneLine.slice(0, 140)}`);
      assert.doesNotMatch(oneLine, /AND day >=/i,
        `switching to day would shift the window by the TZ offset: ${oneLine.slice(0, 140)}`);
    }
  });

  test('the leave_requests overlap query in score compares raw date columns', () => {
    const leave = allWindowQueries().raw.find(s => /FROM leave_requests/i.test(s));
    assert.ok(leave, 'expected the leave_requests overlap query');
    const oneLine = leave.replace(/\s+/g, ' ');
    assert.match(oneLine, /start_date <= \? AND end_date >= \?/i, oneLine.slice(0, 160));
    assert.doesNotMatch(oneLine, /date\s*\(/i, oneLine.slice(0, 160));
  });
});

// ==================================================== 2) boundary equivalence

const START = '2026-09-02';
const END = '2026-10-01';
const WIN = clock.dayWindow(START, END);

/** الطوابع الحدية التي يجب أن تتّفق فيها الصيغتان */
const EDGES = [
  ['2026-09-01 23:59:59', 'يوم قبل البداية'],
  ['2026-09-02 00:00:00', 'بالضبط أول يوم — داخل'],
  ['2026-09-02 00:00:01', 'ثانية بعد بداية أول يوم'],
  ['2026-09-02 12:00:00', 'منتصف أول يوم'],
  ['2026-09-15 03:14:07', 'منتصف النافذة'],
  ['2026-10-01 00:00:00', 'أول لحظة في آخر يوم — داخل'],
  ['2026-10-01 12:00:00', 'منتصف آخر يوم'],
  ['2026-10-01 23:59:59', 'آخر ثانية مشمولة — هذا هو الفخّ'],
  ['2026-10-02 00:00:00', 'منتصف ليل اليوم التالي — خارج'],
  ['2026-10-02 00:00:01', 'خارج'],
  ['2026-10-15 10:00:00', 'خارج بوضوح'],
];

/** الاستعلام القديم (غير قابل للفهرسة) والاستعلام الجديد لكل جدول */
const PAIRS = [
  {
    name: 'ticket_metrics',
    old: `SELECT COUNT(*) c FROM ticket_metrics WHERE claimer = ? AND date(closed_at) BETWEEN ? AND ?`,
    now: `SELECT COUNT(*) c FROM ticket_metrics WHERE claimer = ? AND closed_at >= ? AND closed_at < ?`,
    insert: (ts) => getDb().prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, duration, logged_by, closed_at)
      VALUES (?, 'o', ?, ?, 20, 'bot', ?)`).run(`t${ts}`, UID_, UID_, ts),
  },
  {
    name: 'support_ratings',
    old: `SELECT COUNT(*) c FROM support_ratings WHERE staff_id = ? AND date(rated_at) BETWEEN ? AND ?`,
    now: `SELECT COUNT(*) c FROM support_ratings WHERE staff_id = ? AND rated_at >= ? AND rated_at < ?`,
    insert: (ts) => getDb().prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
      VALUES (?, 'rev', 4, ?, 'c', 'g', 'b', ?)`).run(UID_, `sr${ts}`, ts),
  },
  {
    name: 'mod_actions',
    old: `SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND date(created_at) BETWEEN ? AND ?`,
    now: `SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND created_at >= ? AND created_at < ?`,
    insert: (ts) => getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, created_at) VALUES (?, 't', 'ban', 'r', ?)`).run(UID_, ts),
  },
  {
    name: 'warnings',
    old: `SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND date(created_at) BETWEEN ? AND ?`,
    now: `SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND created_at >= ? AND created_at < ?`,
    insert: (ts) => getDb().prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at) VALUES (?, 'official', 'r', 'bot', ?)`).run(UID_, ts),
  },
  {
    name: 'staff_notes',
    old: `SELECT COUNT(*) c FROM staff_notes WHERE user_id = ? AND date(created_at) BETWEEN ? AND ?`,
    now: `SELECT COUNT(*) c FROM staff_notes WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    insert: (ts) => getDb().prepare(`INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by, created_at) VALUES (?, 'positive', 'c', 0, 'bot', ?)`).run(UID_, ts),
  },
];

describe('تكافؤ الحدود: الصيغة الجديدة = date() BETWEEN القديمة', () => {
  for (const pair of PAIRS) {
    test(`${pair.name}: الطوابع الحدية الإحدى عشرة تتّفق صفاً بصف`, () => {
      const table = [];
      for (const [ts, label] of EDGES) {
        openMemoryDb();
        pair.insert(ts);
        const before = getDb().prepare(pair.old).get(UID_, START, END).c;
        const after = getDb().prepare(pair.now).get(UID_, WIN.start, WIN.endExclusive).c;
        table.push({ ts, label, before, after, agree: before === after });
      }
      const mismatches = table.filter(r => !r.agree);
      assert.deepEqual(mismatches, [], `off-by-one in ${pair.name}:\n${JSON.stringify(mismatches, null, 2)}`);
      // الجدول نفسه مطلوب في التقرير: هذا هو إثبات التكافؤ
      for (const r of table) {
        const inWindow = r.ts >= `${START} 00:00:00` && r.ts < '2026-10-02 00:00:00' ? 1 : 0;
        assert.equal(r.after, inWindow, `${pair.name} @ ${r.ts} (${r.label})`);
      }
      // تأكيد تسمية الصفحات حتى لا يمرّ الاختبار بلا assertion
      assert.equal(table.find(r => r.ts === '2026-10-01 23:59:59').after, 1, '23:59:59 on the final day must be included');
      assert.equal(table.find(r => r.ts === '2026-10-02 00:00:00').after, 0, 'midnight after the window must be excluded');
      assert.equal(table.find(r => r.ts === '2026-09-02 00:00:00').after, 1, 'exact range start must be included');
    });
  }

  test('صف واحد في الطابع الزمني الخام لا يسقط — الأعمدة TEXT بطول 19 محرفاً', () => {
    for (const [ts] of EDGES) {
      openMemoryDb();
      PAIRS[0].insert(ts);
      const n = getDb().prepare(PAIRS[0].now).get(UID_, WIN.start, WIN.endExclusive).c;
      const old = getDb().prepare(PAIRS[0].old).get(UID_, START, END).c;
      assert.equal(n, old, `raw-text comparison disagrees with date() at ${ts}`);
      assert.equal(n, ts.startsWith(START) || (ts > `${START} 00:00:00` && ts < '2026-10-02 00:00:00') ? 1 : 0, ts);
    }
  });

  test('صف من مستخدم آخر لا يتسرّب إلى نافذة العضو', () => {
    openMemoryDb();
    getDb().prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, duration, logged_by, closed_at)
      VALUES ('x', 'o', ?, ?, 20, 'bot', '2026-09-15 12:00:00')`).run(OTHER, OTHER);
    PAIRS[0].insert('2026-09-15 12:00:00');
    assert.equal(getDb().prepare(PAIRS[0].now).get(UID_, WIN.start, WIN.endExclusive).c, 1);
  });

  test('كسر الحدّ بـ <= بدل < يُسقط صف 23:59:59 — الاختبار يكشفه', () => {
    // هذا هو إثبات أن اختبار التكافؤ ليس زينة: استبدل الحدّ الأعلى بـ <=
    // وحدّاً أعلى «inclusive» مزيّفاً، وشاهد العدد ينهار.
    openMemoryDb();
    PAIRS[0].insert('2026-10-01 23:59:59');
    const correct = getDb().prepare(PAIRS[0].now).get(UID_, WIN.start, WIN.endExclusive).c;
    // كسر مقصود: نستخدم نهاية اليوم الأخير نفسها كحدّ أعلى شامل — وهو بالضبط
    // ما ينتجه "<= end" لو تُرك BETWEEN دون انتباه إلى نصف midnight المفتوح
    const broken = getDb().prepare(`SELECT COUNT(*) c FROM ticket_metrics
      WHERE claimer = ? AND closed_at >= ? AND closed_at <= ?`)
      .get(UID_, WIN.start, `${END} 00:00:00`).c;
    assert.equal(correct, 1, 'الصيغة الصحيحة تشمل 23:59:59');
    assert.equal(broken, 0, 'الصيغة المكسورة بـ <= تسقط صف 23:59:59');
    assert.notEqual(correct, broken);
  });
});

// ================================================= 3) end-to-end via services

describe('monthlyRaw عبر النافذة الحقيقية', () => {
  beforeEach(() => { openMemoryDb(); });

  test('يعدّ ما في النافذة فقط: أول لحظة مشمولة، وما بعدها مستبعد', () => {
    const db = getDb();
    const u = '333333333333333333';
    const startDay = clock.addDays(clock.today(), -29);
    const endDay = clock.today();
    const win = clock.dayWindow(startDay, endDay);
    const ticket = (id, ts, reopened) => db.prepare(`INSERT INTO ticket_metrics
      (ticket_id, ticket_owner, claimer, closer, rating, duration, reopened, logged_by, closed_at)
      VALUES (?, 'o', ?, ?, 5, 30, ?, 'bot', ?)`).run(id, u, u, reopened, ts);

    ticket('atStart', win.start, 0);                                   // داخل بالضبط
    ticket('lastSecond', `${endDay} 23:59:59`, 1);                      // داخل — الفخّ
    ticket('mid', `${clock.addDays(startDay, 10)} 09:00:00`, 0);       // داخل
    ticket('before', `${clock.addDays(startDay, -1)} 09:00:00`, 0);    // خارج
    ticket('after', win.endExclusive, 0);                               // خارج

    const raw = reports.getRaw(u, 30, 0);
    assert.equal(raw.tickets, 3, 'ثلاثة داخل النافذة، لا الأربعة الأخرى');
    assert.equal(raw.reopened, 1);
  });

  test('ratingSource يبقى خارجياً أولاً: تقييم قديم خارج النافذة لا يزاحم تقييماً داخلها', () => {
    const db = getDb();
    const u = '444444444444444444';
    const today = clock.today();
    db.prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
      VALUES (?, 'rev', 1, 'old', 'c', 'g', 'b', ?)`).run(u, '2020-01-01 00:00:00');
    db.prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
      VALUES (?, 'rev', 5, 'new', 'c', 'g', 'b', ?)`).run(u, `${today} 00:00:00`);
    const raw = reports.getRaw(u, 30, 0);
    assert.equal(raw.ratingSource, 'external');
    assert.equal(raw.ratingCount, 1);
    assert.equal(raw.avgRating, 5, 'التقييم القديم خارج النافذة لا يُحسب');
  });
});

// ==================================================== 4) query plan on a scale

describe('خطة التنفيذ على مقياس حقيقي لعضو واحد', () => {
  // المقياس الذي قاسه التدقيق كان 73 ألف صف لعضو واحد. نستخدم 20 ألفاً + 5 آلاف
  // لغيره: ما زال كافياً كي يقارن SQLite بين مسح كامل وSEARCH مقيَّد، وقد
  // تحوّل إلى SCAN كامل فعلياً عند هذا الحجم على warnings وsupport_ratings،
  // ووقت الاختبار يبقى معقولاً.
  const BIG = 20000;
  const OTHERS = 5000;

  function scale([sql, bind]) {
    const db = getDb();
    const stmt = db.prepare(sql);
    // عدّاد متزايد واحد لا فهرس الحلقة: فهرس الحلقة يتكرّر بين الحلقتين
    // ويخالف القيد الفريد على support_ratings.source_message_id.
    let seq = 0;
    const next = () => seq++;
    db.exec('BEGIN');
    for (let i = 0; i < BIG; i++) stmt.run(...bind(UID_, '2026-01-01 00:00:00', next()));
    for (let i = 0; i < OTHERS; i++) stmt.run(...bind(`other${i % 500}`, '2026-01-01 00:00:00', next()));
    stmt.run(...bind(UID_, '2026-09-15 12:00:00', next())); // الصف الوحيد داخل النافذة
    db.exec('COMMIT');
    db.exec('ANALYZE'); // بلا إحصاءات يختار المخطّط بلا ترجيح حقيقي
    return seq;
  }

  // لكل جدول جملة إدخال مستقلة محضَّرة مرة واحدة: عدد المعاملات يختلف،
  // وsupport_ratings له قيد فريد على source_message_id.
  const SOURCES = {
    ticket_metrics: [`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, duration, logged_by, closed_at)
      VALUES (?, 'o', ?, ?, 20, 'bot', ?)`, (u, ts, i) => [`t-${i}`, u, u, ts]],
    support_ratings: [`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
      VALUES (?, 'rev', 4, ?, 'c', 'g', 'b', ?)`, (u, ts, i) => [u, `sr-${i}`, ts]],
    mod_actions: [`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, created_at)
      VALUES (?, 't', 'ban', 'r', ?)`, (u, ts) => [u, ts]],
    warnings: [`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at)
      VALUES (?, 'official', 'r', 'bot', ?)`, (u, ts) => [u, ts]],
    staff_notes: [`INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by, created_at)
      VALUES (?, 'positive', 'c', 0, 'bot', ?)`, (u, ts) => [u, ts]],
  };

  for (const pair of PAIRS) {
    test(`${pair.name}: قبل = بلا قيد على عمود النطاق، بعد = SEARCH عليه`, () => {
      openMemoryDb();
      scale(SOURCES[pair.name]);

      const planOf = sql => getDb().prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all(UID_, sql === pair.old ? START : WIN.start, sql === pair.old ? END : WIN.endExclusive)
        .map(r => String(r.detail)).join(' | ');

      const before = planOf(pair.old);
      const after = planOf(pair.now);
      // الصف الوحيد داخل النافذة موجود فعلاً، فالفرق في الخطة ليس فراغاً
      assert.equal(getDb().prepare(pair.now).get(UID_, WIN.start, WIN.endExclusive).c, 1,
        'the single in-window row must be findable');
      assert.equal(getDb().prepare(pair.old).get(UID_, START, END).c, 1,
        'and the old shape must find the same row');

      // الثابت الحقيقي: قبل الإصلاح لا يمكن لعمود النطاق أن يظهر في الخطة
      // إطلاقاً — إمّا قصرها على عمود المستخدم، وإمّا سقطت إلى مسح كامل.
      assert.doesNotMatch(before, /(closed_at|rated_at|created_at)\s*>/,
        `pre-fix plan must not constrain the range column: ${before}`);
      // بعد: القيد على عمود النطاق يظهر، ولا مسح كامل أبداً
      assert.match(after, /SEARCH/, `expected a SEARCH: ${after}`);
      assert.match(after, /(closed_at|rated_at|created_at)\s*>/,
        `the range column must appear in the plan: ${after}`);
      assert.doesNotMatch(after, /^SCAN|\| *SCAN/m, `post-fix plan must not be a full scan: ${after}`);
    });
  }
});

// ==================================================== 5) JSON.parse once

describe('stability يفكّ ترميز كل تقرير مرة واحدة', () => {
  beforeEach(() => { openMemoryDb(); });

  function seedReport(period, team, members) {
    getDb().prepare(`INSERT INTO saved_reports (report_type, period, data) VALUES ('monthly', ?, ?)`)
      .run(period, JSON.stringify({ members }));
  }

  test('تقرير لكل فريق لنفس الشهر: الشهر يُحسب مرة واحدة ونسخة فريق العضو مفضّلة', () => {
    seedReport('2026-03:support', 'support', [{ user: UID_, points: 91 }]);
    seedReport('2026-03:moderation', 'moderation', [{ user: UID_, points: 40 }]);
    const st = promotions.stability(UID_, 3, 75, 'support');
    assert.deepEqual(st.periods, ['2026-03'], 'تقريرا الفريقين لشهر واحد = شهر واحد');
    assert.deepEqual(st.points, [91], 'نسخة فريق العضو مفضّلة على نسخة الفريق الآخر');
    assert.equal(st.missing, 2, 'شهران ناقصان من الثلاثة المطلوبة');
    // الشهر الموجود درجةً 91 فوق الحدّ 75، لكن نقص شهرين يمنع اجتياز البوابة
    assert.equal(st.passed, false, 'missing blocks the gate even when the present month passes');
    assert.deepEqual(promotions.stability(UID_, 1, 75, 'support').points, [91]);
    assert.equal(promotions.stability(UID_, 1, 75, 'support').passed, true);
  });

  test('عضو في نسخة فريقه فقط: لا تُفقد قيمته، والشهر يُحتسب مرة واحدة', () => {
    seedReport('2026-02:moderation', 'moderation', [{ user: UID_, points: 88 }]);
    const st = promotions.stability(UID_, 2, 75, 'support');
    assert.deepEqual(st.periods, ['2026-02']);
    assert.deepEqual(st.points, [88]);
  });

  test('يفضّل نسخة الفريق حتى لو وردت بعد نسخة الفريق الآخر في الترتيب', () => {
    // team غير support: صف moderation أولاً ثم support لنفس الشهر
    seedReport('2026-01:moderation', 'moderation', [{ user: UID_, points: 30 }]);
    seedReport('2026-01:support', 'support', [{ user: UID_, points: 95 }]);
    const st = promotions.stability(UID_, 1, 75, 'support');
    assert.deepEqual(st.points, [95], 'الترتيب لا يقرّر التفضيل — هوية الفريق تقرّره');
    assert.equal(st.passed, true);
  });

  test('لا يعيد قراءة التقرير المفضَّل: عدد عمليات JSON.parse = عدد الصفوف', () => {
    // 36 شهراً × تقريرين = 72 صفاً، كما في 3 سنوات.
    for (let m = 1; m <= 36; m++) {
      const period = `20${String(20 + Math.floor(m / 12)).slice(2)}-${String((m % 12) + 1).padStart(2, '0')}`;
      seedReport(`${period}:support`, 'support', [{ user: UID_, points: 80 }]);
      seedReport(`${period}:moderation`, 'moderation', [{ user: UID_, points: 50 }]);
    }
    let parses = 0;
    const originalParse = JSON.parse;
    JSON.parse = function patched(...args) { parses++; return originalParse.apply(JSON, args); };
    try {
      promotions.stability(UID_, 3, 75, 'support');
    } finally {
      JSON.parse = originalParse;
    }
    const rowCount = getDb().prepare(`SELECT COUNT(*) c FROM saved_reports WHERE report_type='monthly'`).get().c;
    assert.equal(rowCount, 72);
    // النسخة السابقة كانت تمرّ مرتين: 72 Team + 72 any = 144
    assert.ok(parses <= rowCount, `${parses} parses for ${rowCount} rows — must be at most one per row`);
  });

  test('تقرير تالف أو بلا العضو لا يُسقط التقييم', () => {
    seedReport('2026-04:support', 'support', [{ user: UID_, points: 90 }]);
    getDb().prepare(`INSERT INTO saved_reports (report_type, period, data) VALUES ('monthly', '2026-05:support', 'not json')`).run();
    getDb().prepare(`INSERT INTO saved_reports (report_type, period, data) VALUES ('monthly', '2026-06:support', '{"members":[]}')`).run();
    const st = promotions.stability(UID_, 1, 75, 'support');
    assert.deepEqual(st.points, [90]);
    assert.equal(st.passed, true);
  });
});
