'use strict';
/**
 * تجميع مواد التقرير الأسبوعي بالنظام الجديد: النقاط (Points) بدلاً من Score.
 *
 * التغييرات الرئيسية:
 * - لوحات الترتيب (boards) تأتي الآن من points.leaderboard() وليس reports.leaderboard()
 * - التقرير الأسبوعي المحفوظ يحفظ النقاط وليس Score
 * - قائمة المراجعة البشرية (below) تعرض من لم يكسب نقاطاً خلال 7 أيام
 * - التقارير الفردية بالخاص تستخدم reports.individual() بعقد نقاط الترقية
 *
 * Importers: tests/weeklyReportBatch.test.js → scheduler.weeklyReportData(), weeklyReport()
 * Affected API: reports.leaderboard() REMOVED, points.leaderboard() USED
 * User instruction: "remove the score entirely from the bot and replace it with points"
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const staffService = require('../src/services/staff');
const leaveService = require('../src/services/leaves');
const reports = require('../src/services/reports');
const points = require('../src/services/points');
const scheduler = require('../src/scheduler');
const reportCmds = require('../src/commands/reports');
const { INACTIVE_STATUSES, ABSENCE } = require('../src/constants');
const { today, addDays, hoursSince } = require('../src/utils');

const CID = '3000000000000000000';
const PERF = 'perf-chan';
const ALERTS = 'alerts-chan';
const WINDOW = reportCmds.LEADERBOARD_WINDOW_DAYS;

beforeEach(() => {
  openMemoryDb();
  settings.set('test', true);
  settings.setChannel('performance-reports', PERF);
  settings.setChannel('staff-alerts', ALERTS);
  settings.resetFeatureToggles();
});

/** يعدّ كل استدعاء db.prepare — أي جملة مُصرَّفة، مهما تكرّر الجدول. */
async function measure(fn) {
  const db = getDb();
  const orig = db.prepare.bind(db);
  let n = 0;
  db.prepare = sql => { n++; return orig(sql); };
  try {
    const result = await fn();
    return { statements: n, result };
  } finally {
    db.prepare = orig;
  }
}

// ===== الزرع =====

function seedMember(id, { team = 'support', rank = 'Support', status = 'active',
  lastActivityDays = 0, responseSpeed = null } = {}) {
  const db = getDb();
  const last = `${addDays(today(), -lastActivityDays)} 12:00:00`;
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity, response_speed)
    VALUES (?, ?, ?, ?, ?, '2025-01-01 00:00:00', '2025-01-01 00:00:00', ?, ?)`)
    .run(id, `u${id}`, team, rank, status, last, responseSpeed);
  return staffService.get(id);
}

function seedActivity(id, { days = 4, weight = 75, back = 0, perDay = 1 } = {}) {
  const act = getDb().prepare('INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at) VALUES (?, ?, ?, ?, ?, ?)');
  for (let d = 0; d < days; d++) {
    const day = addDays(today(), -(back + d));
    for (let k = 0; k < perDay; k++) act.run(id, CID, 'chat', weight, day, `${day} 09:00:00`);
  }
}

function seedTickets(claimer, { count = 25, back = 0 } = {}) {
  const t = getDb().prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, rating, duration, logged_by, reopened, closed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`);
  for (let i = 0; i < count; i++) {
    const day = addDays(today(), -(back + (i % 5)));
    t.run(`${claimer}:${i}`, claimer, claimer, claimer, 4.5, 5, claimer, `${day} 10:00:00`);
  }
}

function seedActions(moderatorId, { count = 30, back = 0 } = {}) {
  const a = getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, created_at) VALUES (?, ?, 'mute', 'سبب', ?)`);
  for (let i = 0; i < count; i++) {
    const day = addDays(today(), -(back + (i % 5)));
    a.run(moderatorId, '999000000000000001', `${day} 10:00:00`);
  }
}

function seedLeave(userId, { status = 'approved', start, end } = {}) {
  const s = start || addDays(today(), -2);
  const e = end || addDays(today(), 2);
  getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, status)
    VALUES (?, 'normal', 'سبب', ?, ?, ?, ?)`).run(userId, s, e, leaveService.spanDays(s, e), status);
}

function seedPoints(userId, amount, reasonKey = 'faq_contrib', { backDays = 0 } = {}) {
  const db = getDb();
  const perRow = 10;
  const rows = Math.floor(amount / perRow);
  const createdAt = `${addDays(today(), -backDays)} 12:00:00`;
  const stmt = db.prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch, created_at)
    VALUES (?, ?, ?, 'رصيد مُزرَع للاختبار', 'seed', ?, 0, ?)`);
  for (let k = 0; k < rows; k++) stmt.run(userId, perRow, reasonKey, `${userId}_seed${k}`, createdAt);
}

const M = {
  strongSupport: '9000000000000000001',
  weakSupport: '9000000000000000002',
  onLeave: '9000000000000000003',
  idle: '9000000000000000004',
  probation: '9000000000000000005',
  suspended: '9000000000000000006',
  removed: '9000000000000000007',
  modStrong: '9000000000000000008',
  modWeak: '9000000000000000009',
  resigned: '9000000000000000010',
};

/** ثري: بيانات لكل جداول المواد الخام — لا يُختبر مسار فارغ فقط. */
function seedBase() {
  seedMember(M.strongSupport);
  seedActivity(M.strongSupport, { days: 7, weight: 75, perDay: 25 });
  seedTickets(M.strongSupport, { count: 25 });
  seedPoints(M.strongSupport, 500);

  seedMember(M.weakSupport);
  seedPoints(M.weakSupport, 50, 'faq_contrib', { backDays: 30 });

  seedMember(M.onLeave);
  seedLeave(M.onLeave, { status: 'approved', start: addDays(today(), -2), end: addDays(today(), 2) });
  seedPoints(M.onLeave, 200);
  assert.ok(leaveService.activeForUser(M.onLeave).length, 'زراعتنا ليست فعّالة — الاختبار لا يثبت شيئاً');

  seedMember(M.idle, { lastActivityDays: 10 });
  seedPoints(M.idle, 100);

  seedMember(M.probation, { status: 'probation' });
  seedPoints(M.probation, 100);

  seedMember(M.suspended, { status: 'suspended' });
  seedPoints(M.suspended, 100);

  seedMember(M.removed, { status: 'removed' });
  seedPoints(M.removed, 100);

  seedMember(M.modStrong, { team: 'moderation', rank: 'Moderator', responseSpeed: 25 });
  seedActivity(M.modStrong, { days: 7, weight: 10 });
  seedActions(M.modStrong, { count: 30 });
  seedPoints(M.modStrong, 400);

  seedMember(M.modWeak, { team: 'moderation', rank: 'Moderator' });
  seedPoints(M.modWeak, 30);

  seedMember(M.resigned, { status: 'resigned' });
  seedPoints(M.resigned, 100);
}

/** يضيف n عضواً نشطاً لقياس النمو مع الحجم. */
function seedGrow(n) {
  for (let i = 0; i < n; i++) {
    const id = String(9100000000000000000n + BigInt(i));
    seedMember(id);
    seedActivity(id, { days: 3, weight: 10 });
    seedPoints(id, 20);
  }
}

/** عميل وهمي يسجّل ترتيب كل إرسال بلا شبكة. */
function fakeClient() {
  const events = [];
  const client = {
    channels: {
      fetch: async id => ({ id, send: async payload => { events.push({ kind: 'channel', id, payload }); return { id: 'm1' }; } }),
    },
    users: {
      fetch: async id => ({ id, send: async payload => { events.push({ kind: 'dm', id, payload }); return { id: 'm2' }; } }),
    },
  };
  return { client, events };
}

// ===== مرجع مستقل لفحص النقاط الأسبوعية =====

/** المسح المرجعي يحسب نقاط العصر الحالي لكل عضو مؤهل على حدة. */
function legacyBelowScan() {
  const out = [];
  const db = getDb();
  const weekEnd = today();
  const weekStart = addDays(weekEnd, -6);
  const { start, endExclusive } = require('../src/clock').dayWindow(weekStart, weekEnd) || {};
  if (!start || !endExclusive) return out;

  for (const m of staffService.all()) {
    if (INACTIVE_STATUSES.includes(m.status) || m.status === 'probation') continue;
    if (leaveService.activeForUser(m.user_id).length) continue;
    const earned = db.prepare(`SELECT COALESCE(SUM(points), 0) total FROM promotion_points
      WHERE user_id = ? AND rank_epoch = ? AND created_at >= ? AND created_at < ?`)
      .get(m.user_id, m.rank_epoch ?? 0, start, endExclusive).total;
    if (Number(earned) === 0) out.push({ user: m.user_id, rank: m.rank, pointsEarned: 0 });
  }
  return out;
}

function legacyIdle() {
  return staffService.all().filter(m => !INACTIVE_STATUSES.includes(m.status) && m.status !== 'probation'
    && !leaveService.activeForUser(m.user_id).length
    && hoursSince(m.last_activity || m.joined_at) >= ABSENCE.idleDays * 24);
}

/** استبعاد lastActivityHours: ساعة قد تنقلب بين نداءين متجاورين — ليس نتيجة التجميع. */
function withoutClock(report) {
  const copy = { ...report };
  delete copy.lastActivityHours;
  delete copy.skipPromotionEvaluation;
  return copy;
}

// ════════════════════════════════════════════════════════════════════════
// 1) عدد العبارات — الدليل الحاسم (لم يتغير: الدفعة ثابتة)
// ════════════════════════════════════════════════════════════════════════

describe('عدد العبارات: ثابت لا ينمو مع الأعضاء', () => {
  test('مرحلة البيانات: العدد عند ~12 عضواً يساوي العدد عند ~32، وكلتاهما تحت 40', async () => {
    seedBase();
    const base = await measure(() => scheduler.weeklyReportData());
    const atBase = staffService.all().length;
    assert.ok(base.result.below.length > 0, 'الزرع لا يضمّ أحداً — القياس لا يثبت شيئاً');

    seedGrow(20);
    const grown = await measure(() => scheduler.weeklyReportData());
    const atGrown = staffService.all().length;
    // seedBase يزرع 10 أعضاء + seedGrow(20) = 30، لكن قد يُفلتر عضو
    assert.ok(atGrown >= 29, `حجم العينة غير مقصود: ${atGrown}`);

    assert.equal(grown.statements, base.statements,
      `العبارات تنمو مع الأعضاء: ${base.statements} عند ${atBase} → ${grown.statements} عند ${atGrown}`);
    assert.ok(base.statements < 40,
      `مرحلة البيانات تجاوزت الحد الثابت: ${base.statements} عبارة عند ${atBase} عضواً`);
    const legacy = await measure(() => {
      const all = staffService.all();
      for (const m of all) {
        if (INACTIVE_STATUSES.includes(m.status) || m.status === 'probation') continue;
        if (leaveService.activeForUser(m.user_id).length) continue;
        getDb().prepare(`SELECT COALESCE(SUM(points), 0) total FROM promotion_points
          WHERE user_id = ? AND rank_epoch = ? AND created_at >= datetime('now', '-7 days')`)
          .get(m.user_id, m.rank_epoch ?? 0);
      }
      for (const m of all) reports.individual(m, WINDOW);
      for (const m of all) if (!INACTIVE_STATUSES.includes(m.status) && m.status !== 'probation') leaveService.activeForUser(m.user_id);
      return null;
    });
    assert.ok(legacy.statements >= 8 * atGrown,
      `المسح غير المجمّع أقل من المتوقع (${legacy.statements} عند ${atGrown}) — القياس لا يفصل بين المسارين`);
    assert.ok(base.statements * 4 < legacy.statements,
      `لا فرق محسوس: مجمّع ${base.statements} مقابل قديم ${legacy.statements}`);
  });

  test('weeklyReport كامل: نمو الاستعلامات محدود ويعيد استخدام النقاط المجمّعة', async () => {
    seedBase();
    const promotions = require('../src/services/promotions');
    const originalEvaluate = promotions.evaluate;
    const originalBalance = points.getBalance;
    let evaluations = 0;
    let balances = 0;
    promotions.evaluate = (...args) => { evaluations++; return originalEvaluate(...args); };
    points.getBalance = (...args) => { balances++; return originalBalance(...args); };
    const { client: client1 } = fakeClient();
    let base;
    let grown;
    let atBase;
    let atGrown;
    try {
      base = await measure(() => scheduler.weeklyReport(client1));
      atBase = staffService.all().length;

      seedGrow(20);
      const { client: client2 } = fakeClient();
      grown = await measure(() => scheduler.weeklyReport(client2));
      atGrown = staffService.all().length;
    } finally {
      promotions.evaluate = originalEvaluate;
      points.getBalance = originalBalance;
    }
    assert.equal(evaluations, 0, 'weekly DMs must not evaluate promotions per member');
    assert.equal(balances, 0, 'weekly DMs must use the batched current-point balances');
    const added = atGrown - atBase;
    const slope = (grown.statements - base.statements) / added;

    // reports.individual() يُستدعى لكل عضو → ~8 استعلامات لكل عضو جديد
    // فحص العدالة وحده يستدعي 1-2 استعلام لكل عضو، لكن individual هو الغالب
    assert.ok(slope <= 10,
      `weeklyReport كاملاً يدفع ${slope.toFixed(1)} عبارة لكل عضو جديد (المتوقع ~8 للتقارير الفردية + العدالة)`
      + ` — ${base.statements} عند ${atBase} → ${grown.statements} عند ${atGrown}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2) التكافؤ — نفس الصفوف، مرجع حيّ من الطرفين (مُحدّث للنقاط)
// ════════════════════════════════════════════════════════════════════════

describe('التكافؤ: النقاط (points.leaderboard) والنقاط الأسبوعية', () => {
  test('لوحتا الترتيب المجمّعتان = points.leaderboard المنفرد صفّاً بصف', () => {
    seedBase();
    const data = scheduler.weeklyReportData();

    for (const t of ['support', 'moderation']) {
      const legacy = points.leaderboard({ team: t, limit: 20 });
      assert.ok(data.boards[t].length > 0, `${t}: اللوحة فارغة — الاختبار لا يثبت شيئاً`);

      for (let i = 0; i < legacy.length; i++) {
        assert.equal(data.boards[t][i].user_id, legacy[i].user_id, `${t}[${i}]: user_id يختلف`);
        assert.equal(data.boards[t][i].total, legacy[i].total, `${t}[${i}]: total points يختلف`);
        assert.equal(data.boards[t][i].rank, legacy[i].rank, `${t}[${i}]: rank يختلف`);
        assert.equal(data.boards[t][i].team, legacy[i].team, `${t}[${i}]: team يختلف`);
      }
    }
    assert.equal(data.boards.support[0].user_id, M.strongSupport);
    assert.equal(data.boards.moderation[0].user_id, M.modStrong);
  });

  test('قائمة المراجعة الأسبوعية (below) = المسح المرجعي لنقاط الأيام السبعة', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const legacy = legacyBelowScan();

    const flagged = new Set(legacy.map(r => r.user));
    assert.ok(flagged.has(M.weakSupport), 'زراعتنا لا تُظهر ضعيفاً — الزرع عيب');
    assert.ok(!flagged.has(M.strongSupport), 'العضو القوي في القائمة — الزرع عيب');
    assert.ok(!flagged.has(M.probation) && !flagged.has(M.suspended)
      && !flagged.has(M.removed) && !flagged.has(M.onLeave), 'استثناءات المسار القديم غير مُختبرة');

    assert.deepEqual(data.below, legacy, 'القائمة المجمّعة تختلف عن المسح القديم');
    assert.ok(data.below.some(r => r.user === M.weakSupport), 'القائمة المجمّعة فارغة — لا يثبت شيئاً');
    assert.ok(!data.below.some(r => r.user === M.strongSupport), 'عضو قوي في القائمة المجمّعة');
    assert.ok(!data.below.some(r => r.user === M.onLeave), 'مُجاز في القائمة المجمّعة');
  });

  test('قائمة الخاملين المجمّعة = المسح القديم (واحد لقراءة الإجازات لا N)', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const legacy = legacyIdle();
    assert.deepEqual(legacy.map(m => m.user_id), [M.idle], 'زراعتنا لا تُظهر خاملاً وحيداً — الزرع عيب');
    assert.deepEqual(data.idle.map(m => m.user_id), legacy.map(m => m.user_id),
      'قائمة الخاملين المجمّعة تختلف عن المسح القديم');
  });

  test('كل تقرير في الرسائل = individual بلا دفعة، والمستلمون كما كانوا', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const expectedRecipients = staffService.all()
      .filter(m => m.status !== 'resigned' && m.status !== 'removed')
      .map(m => m.user_id);
    // seedBase يزرع 10 أعضاء، ناقص resigned و removed = 8
    assert.ok(expectedRecipients.length >= 8, `المستلمون ${expectedRecipients.length} — الزرع عيب`);
    assert.ok(expectedRecipients.includes(M.suspended), 'الموقوف يجب أن يواصل تلقّي التقارير');
    assert.ok(!expectedRecipients.includes(M.removed), 'المحذوف لا يصله تقرير فردي');
    assert.ok(!expectedRecipients.includes(M.resigned), 'المستقيل خارج قائمة الأعضاء أصلاً');

    assert.deepEqual(data.dms.map(d => d.user), expectedRecipients, 'مستلمو الخاص تغيّروا');

    for (const d of data.dms) {
      const legacy = reports.individual(staffService.get(d.user), WINDOW);
      assert.deepEqual(withoutClock(d.report), withoutClock(legacy), `${d.user}: التقرير الفردي يختلف`);
      assert.equal(typeof d.report.lastActivityHours, 'number', `${d.user}: ساعات آخر نشاط مفقودة`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3) السلوك الكامل: إرسال وحفظ كما كانت (مُحدّث للنقاط)
// ════════════════════════════════════════════════════════════════════════

describe('weeklyReport كاملاً: نفس الإرسال ونفس الحفظ (بالنقاط)', () => {
  test('نفس ترتيب الإرسال ونفس المستلمين ونفس اللقطات المحفوظة', async () => {
    seedBase();
    const { client, events } = fakeClient();
    await scheduler.weeklyReport(client);

    const saves = getDb().prepare(`SELECT period, data FROM saved_reports WHERE report_type = 'weekly' ORDER BY id`).all();
    assert.deepEqual(saves.map(s => s.period), [`${today()}:support`, `${today()}:moderation`],
      'فترتا اللقطة المحفوظة تغيّرا');
    for (const [i, t] of ['support', 'moderation'].entries()) {
      const legacy = points.leaderboard({ team: t, limit: 20 }).map(r => ({ user: r.user_id, points: r.total, rank: r.rank, team: r.team, status: r.status }));
      assert.deepEqual(JSON.parse(saves[i].data), legacy, `${t}: لقطة محفوظة مختلفة`);
    }

    const expectedRecipients = staffService.all()
      .filter(m => m.status !== 'resigned' && m.status !== 'removed')
      .map(m => m.user_id);
    const seq = events.map(e => (e.kind === 'channel' ? e.id : 'DM'));
    assert.deepEqual(seq, [PERF, ALERTS, ALERTS, ...expectedRecipients.map(() => 'DM'), ALERTS],
      'ترتيب الإرسال تغيّر');

    assert.deepEqual(events.filter(e => e.kind === 'dm').map(e => e.id), expectedRecipients,
      'مستلمو الخاص أو ترتيبهم تغيّروا');

    assert.equal(events[0].payload.embeds.length, 3, 'التقرير الأسبوعي = عنوان + لوحتان');
    for (const e of events.filter(ev => ev.kind === 'dm')) {
      assert.equal(e.payload.embeds.length, 1, `${e.id}: بطاقة واحدة فقط`);
    }
  });

  test('عضو بلا أي رسالة ضعيفة لا يوقف التقرير — المسار يكتمل', async () => {
    for (const id of ['9200000000000000001', '9200000000000000002']) seedMember(id);
    const { client, events } = fakeClient();
    await scheduler.weeklyReport(client);
    assert.equal(events.filter(e => e.kind === 'dm').length, 2, 'رسالتان فرديتان للعضوين');
    assert.ok(events.some(e => e.kind === 'channel' && e.id === PERF), 'رسالة التقرير لم تُرسل');
  });
});