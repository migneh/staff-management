'use strict';
/**
 * تجميع مواد التقرير الأسبوعي: عدد العبارات ثابت، والنتائج مطابقة للمسار القديم
 * على بيانات مزروعة حقيقية.
 *
 * ثلاثة عقود:
 *  1) عدد العبارات (الدليل الحاسم): مرحلة بيانات `weeklyReportData` لا تتجاوز
 *     حداً ثابتاً ولا تنمو مع عدد الأعضاء؛ و`weeklyReport` كاملاً ينمو
 *     باستعلام واحد لكل عضو (فحص عدالة الحمل — خارج نطاق التجميع) لا بـ17.
 *  2) التكافؤ على نفس الصفوف: القائمة المجمّعة = مسح `monthlyRaw(id,7,0)`
 *     القديم عضواً بعضو؛ اللوحتان = `leaderboard(t, days)` المنفرد صفّاً بصف؛
 *     وكل تقرير في الرسائل = `individual(m, days)` بلا دفعة.
 *  3) السلوك: نفس المستلمين، ونفس ترتيب الإرسال، ونفس الحفظ.
 *
 * عدّاد العبارات من نمط tests/ackWindowFinish.test.js (تغليف db.prepare)،
 * والعميل الوهمي من نمط tests/schedulerResilience.test.js (بلا شبكة حقيقية).
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
const score = require('../src/services/score');
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
  // إحماء ذاكرة الإعدادات قبل أي عدّ: التحميل الأول يضيف جملة واحدة ثابتة
  // لا داعي لجحدها في كل قياس (وتحذفها setChannel أصلاً لو جاءت بعدها).
  settings.scoreWeights('support');
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

const M = {
  strong: '9000000000000000001',   // دعم نشط ومغمور — Score ~66 → خارج القائمة
  weak1: '9000000000000000002',    // بلا بيانات → Score 0 → في القائمة
  weak2: '9000000000000000003',    // بلا بيانات + إجازة منتهية خارج النافذة
  onLeave: '9000000000000000004',  // إجازة معتمدة تغطي اليوم → مستثنى من القائمة والخاملين
  idle: '9000000000000000005',     // نشاطه قبل 10 أيام → في القائمة وفي الخاملين
  probation: '9000000000000000006', // تحت التجربة → مستثنى من القائمة
  suspended: '9000000000000000007', // موقوف (مستثنى) — تصله رسالة خاصة
  removed: '9000000000000000008',   // محذوف (مستثنى) — لا تصله رسالة
  modStrong: '9000000000000000009', // إشراف نشط — Score 52 → خارج القائمة
  modWeak: '9000000000000000010',   // إشراف بلا بيانات → في القائمة
  resigned: '9000000000000000011',  // مستقيل — خارج all() أصلاً
};

/** ثري: بيانات لكل جداول المواد الخام — لا يُختبر مسار فارغ فقط. */
function seedBase() {
  seedMember(M.strong);
  // سعة كافية ليعبر الحد فعلاً: الرسائل وحدها تُحرق ~23 نقطة من 25.
  seedActivity(M.strong, { days: 7, weight: 75, perDay: 25 });
  seedTickets(M.strong, { count: 25 });
  // تقييم خارجي يتقدّم على تقييم التكتات في حقل المصدر:
  getDb().prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
    VALUES (?, '999000000000000002', 5, 'sm-r1', ?, ?, ?, ?)`).run(M.strong, CID, CID, CID, `${addDays(today(), -1)} 10:00:00`);

  seedMember(M.weak1);
  // إنذاران أحدهما ملغى + ملاحظتان: تُقارن حقول breakdown و notes في التكافؤ.
  const db = getDb();
  db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at) VALUES (?, 'verbal', 'سبب', ?, ?)`)
    .run(M.weak1, M.strong, `${addDays(today(), -1)} 10:00:00`);
  db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at) VALUES (?, 'first', 'سبب', ?, ?)`)
    .run(M.weak1, M.strong, `${addDays(today(), -2)} 10:00:00`);
  db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at, voided_at, voided_by) VALUES (?, 'second', 'سبب', ?, ?, ?, ?)`)
    .run(M.weak1, M.strong, `${addDays(today(), -3)} 10:00:00`, `${addDays(today(), -3)} 11:00:00`, M.strong);
  db.prepare(`INSERT INTO staff_notes (user_id, note_type, content, added_by, created_at) VALUES (?, 'positive', 'ملاحظة', ?, ?)`)
    .run(M.weak1, M.strong, `${addDays(today(), -1)} 10:00:00`);
  db.prepare(`INSERT INTO staff_notes (user_id, note_type, content, added_by, created_at) VALUES (?, 'negative', 'ملاحظة', ?, ?)`)
    .run(M.weak1, M.strong, `${addDays(today(), -1)} 10:00:00`);

  seedMember(M.weak2);
  // إجازة منتهية قبل النافذة بزمن: لا تُحتسب leaveDays ولا تُخرج أحداً من الفحص.
  seedLeave(M.weak2, { status: 'ended', start: addDays(today(), -40), end: addDays(today(), -35) });

  seedMember(M.onLeave);
  seedLeave(M.onLeave, { status: 'approved', start: addDays(today(), -2), end: addDays(today(), 2) });
  assert.ok(leaveService.activeForUser(M.onLeave).length, 'زراعتنا ليست فعّالة — الاختبار لا يثبت شيئاً');

  seedMember(M.idle, { lastActivityDays: 10 });
  seedMember(M.probation, { status: 'probation' });
  seedMember(M.suspended, { status: 'suspended' });
  seedMember(M.removed, { status: 'removed' });

  seedMember(M.modStrong, { team: 'moderation', rank: 'Moderator', responseSpeed: 25 });
  seedActivity(M.modStrong, { days: 7, weight: 10 });
  seedActions(M.modStrong, { count: 30 });

  seedMember(M.modWeak, { team: 'moderation', rank: 'Moderator' });
  seedMember(M.resigned, { status: 'resigned' });
}

/** يضيف n عضواً نشطاً لقياس النمو مع الحجم. */
function seedGrow(n) {
  for (let i = 0; i < n; i++) {
    const id = String(9100000000000000000n + BigInt(i));
    seedMember(id);
    seedActivity(id, { days: 3, weight: 10 });
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

// ===== المرجع القديم — من الكود الحيّ نفسه، لا من إعادة صياغة =====

/** نسخة المسار القديم حرفاً بحرف: monthlyRaw لكل عضو + activeForUser لكل عضو. */
function legacyBelowScan() {
  const out = [];
  for (const m of staffService.all()) {
    if (INACTIVE_STATUSES.includes(m.status)) continue;
    if (m.status === 'probation') continue;
    if (leaveService.activeForUser(m.user_id).length) continue;
    const sc = score.compute(m, score.monthlyRaw(m.user_id, 7, 0)).score;
    if (sc < 50) out.push({ user: m.user_id, rank: m.rank, score: sc });
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
  return copy;
}

// ════════════════════════════════════════════════════════════════════════
// 1) عدد العبارات — الدليل الحاسم
// ════════════════════════════════════════════════════════════════════════

describe('عدد العبارات: ثابت لا ينمو مع الأعضاء', () => {
  test('مرحلة البيانات: العدد عند ~12 عضواً يساوي العدد عند ~32، وكلتاهما تحت 40', async () => {
    seedBase();
    const base = await measure(() => scheduler.weeklyReportData());
    const atBase = staffService.all().length;
    assert.ok(base.result.below.length > 0, 'الزراع لا يضمّ أحداً — القياس لا يثبت شيئاً');

    seedGrow(20);
    const grown = await measure(() => scheduler.weeklyReportData());
    const atGrown = staffService.all().length;
    assert.ok(atGrown >= 30, `حجم العينة غير مقصود: ${atGrown}`);

    assert.equal(grown.statements, base.statements,
      `العبارات تنمو مع الأعضاء: ${base.statements} عند ${atBase} → ${grown.statements} عند ${atGrown}`);
    assert.ok(base.statements < 40,
      `مرحلة البيانات تجاوزت الحد الثابت: ${base.statements} عبارة عند ${atBase} عضواً`);
    // المرجع القديم كان خطياً: monthlyRaw 7 لكل عضو في القائمة + individual 8 لكل
    // مستلم + استعلامي إجازة — أي 17N. نقيسه هنا ليثبت أن الحدّ يفصل فعلاً.
    const legacy = await measure(() => {
      const all = staffService.all();
      for (const m of all) {
        if (INACTIVE_STATUSES.includes(m.status) || m.status === 'probation') continue;
        if (leaveService.activeForUser(m.user_id).length) continue;
        score.monthlyRaw(m.user_id, 7, 0);
      }
      for (const m of all) reports.individual(m, WINDOW);
      for (const m of all) if (!INACTIVE_STATUSES.includes(m.status) && m.status !== 'probation') leaveService.activeForUser(m.user_id);
      return null;
    });
    assert.ok(legacy.statements >= 14 * atGrown,
      `المسار القديم المنقاس أقل من المتوقّع (${legacy.statements} عند ${atGrown}) — الحدّ لا يفصل بين المسارين`);
    assert.ok(base.statements * 4 < legacy.statements,
      `لا فرق محسوس: مجمّع ${base.statements} مقابل قديم ${legacy.statements}`);
  });

  test('weeklyReport كامل: النمو لكل عضو جديد استعلام واحد (فحص العدالة) لا 17', async () => {
    seedBase();
    const { client: client1 } = fakeClient();
    const base = await measure(() => scheduler.weeklyReport(client1));
    const atBase = staffService.all().length;

    seedGrow(20);
    const { client: client2 } = fakeClient();
    const grown = await measure(() => scheduler.weeklyReport(client2));
    const atGrown = staffService.all().length;
    const added = atGrown - atBase;
    const slope = (grown.statements - base.statements) / added;

    assert.ok(slope <= 2,
      `weeklyReport كاملاً ما زال يدفع ${slope.toFixed(1)} عبارة لكل عضو جديد (المطلوب ≤ 2: فحص العدالة وحده)`
      + ` — ${base.statements} عند ${atBase} → ${grown.statements} عند ${atGrown}`);
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2) التكافؤ — نفس الصفوف، مرجع حيّ من الطرفين
// ════════════════════════════════════════════════════════════════════════

describe('التكافؤ: المجمّع = القديم على نفس الزرع', () => {
  test('rawBatch بـ7 أيام = monthlyRaw(id, 7, 0) حقل بحقل لكل عضو', () => {
    seedBase();
    const ids = staffService.all().map(m => String(m.user_id));
    const batch = reports.rawBatch(ids, 7);
    for (const id of ids) {
      const expect = score.monthlyRaw(id, 7, 0);
      const entry = batch.get(id);
      assert.ok(entry, `${id}: مفقود من الدفعة`);
      for (const key of Object.keys(expect)) {
        assert.deepEqual(entry.row[key], expect[key],
          `${id}.${key}: monthlyRaw=${JSON.stringify(expect[key])} batch=${JSON.stringify(entry.row[key])}`);
      }
    }
  });

  test('قائمة المراجعة المجمّعة = المسح القديم عضواً بعضو', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const legacy = legacyBelowScan();

    // الاختبار لا يمرّ على قائمة فارغة: بعض الأعضاء الضعيفين يجب أن يظهرّوا.
    const flagged = new Set(legacy.map(r => r.user));
    assert.ok(flagged.has(M.weak1), 'زراعتنا لا تُظهر ضعيفاً — الزرع عيب');
    assert.ok(flagged.has(M.weak2), 'زراعتنا لا تُظهر ضعيفاً — الزرع عيب');
    assert.ok(!flagged.has(M.strong), 'العضو القوي في القائمة — الزرع عيب');
    // والمرجع نفسه يثبت استثناءات السلوك: المجرّب والموقوف والمحذوف والمُجاز.
    assert.ok(!flagged.has(M.probation) && !flagged.has(M.suspended)
      && !flagged.has(M.removed) && !flagged.has(M.onLeave), 'استثناءات المسار القديم غير مُختبرة');

    assert.deepEqual(data.below, legacy, 'القائمة المجمّعة تختلف عن المسح القديم');
    assert.ok(data.below.some(r => r.user === M.weak1), 'القائمة المجمّعة فارغة — لا يثبت شيئاً');
    assert.ok(!data.below.some(r => r.user === M.strong), 'عضو قوي في القائمة المجمّعة');
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

  test('لوحتا الترتيب المجمّعتان = leaderboard المنفرد صفّاً بصف', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const pick = rs => rs.map(r => ({
      id: r.staff.user_id, score: r.score, primary: r.primary, qualified: r.qualified,
      raw: r.raw, warnings: r.warnings, factors: r.factors, assessedMax: r.assessedMax,
      grade: r.grade, absentDays: r.absentDays,
    }));
    for (const t of ['support', 'moderation']) {
      const legacy = reports.leaderboard(t, WINDOW);
      assert.ok(data.boards[t].length + data.boards[t].unranked.length > 0,
        `${t}: اللوحة فارغة — الاختبار لا يثبت شيئاً`);
      assert.deepEqual(pick(data.boards[t]), pick(legacy), `${t}: صفوف الترتيب تختلف`);
      assert.deepEqual(data.boards[t].unranked.map(r => r.staff.user_id),
        legacy.unranked.map(r => r.staff.user_id), `${t}: غير المصنّفين يختلفون`);
    }
    // اللوحة لا تُخفي أحداً: القوي مصنّف والضعيف غير مصنّف.
    assert.deepEqual(data.boards.support.map(r => r.staff.user_id), [M.strong]);
    assert.ok(data.boards.support.unranked.some(r => r.staff.user_id === M.weak1));
  });

  test('كل تقرير في الرسائل = individual بلا دفعة، والمستلمون كما كانوا', () => {
    seedBase();
    const data = scheduler.weeklyReportData();
    const expectedRecipients = staffService.all()
      .filter(m => m.status !== 'resigned' && m.status !== 'removed')
      .map(m => m.user_id);
    assert.ok(expectedRecipients.length >= 9, `المستلمون ${expectedRecipients.length} — الزرع عيب`);
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
// 3) السلوك الكامل: إرسال وحفظ كما كانت
// ════════════════════════════════════════════════════════════════════════

describe('weeklyReport كاملاً: نفس الإرسال ونفس الحفظ', () => {
  test('نفس ترتيب الإرسال ونفس المستلمين ونفس اللقطات المحفوظة', async () => {
    seedBase();
    const { client, events } = fakeClient();
    await scheduler.weeklyReport(client);

    // الحفظ: صفّان أسبوعيان بالترتيب، بمحتوى لوحتَي leaderboard المنفرد.
    const saves = getDb().prepare(`SELECT period, data FROM saved_reports WHERE report_type = 'weekly' ORDER BY id`).all();
    assert.deepEqual(saves.map(s => s.period), [`${today()}:support`, `${today()}:moderation`],
      'فترتا اللقطة المحفوظة تغيّرا');
    for (const [i, t] of ['support', 'moderation'].entries()) {
      const legacy = reports.leaderboard(t, WINDOW).map(r => ({ user: r.staff.user_id, score: r.score }));
      assert.deepEqual(JSON.parse(saves[i].data), legacy, `${t}: لقطة محفوظة مختلفة`);
    }

    // الترتيب: التقرير (قناة التقارير) ← العدالة ← القائمة ← الرسائل ← الخاملون.
    const expectedRecipients = staffService.all()
      .filter(m => m.status !== 'resigned' && m.status !== 'removed')
      .map(m => m.user_id);
    const seq = events.map(e => (e.kind === 'channel' ? e.id : 'DM'));
    assert.deepEqual(seq, [PERF, ALERTS, ALERTS, ...expectedRecipients.map(() => 'DM'), ALERTS],
      'ترتيب الإرسال تغيّر');
    assert.deepEqual(events.filter(e => e.kind === 'dm').map(e => e.id), expectedRecipients,
      'مستلمو الخاص أو ترتيبهم تغيّروا');

    // رسالة التقرير = عنوان + لوحتان، والخاص بطاقة واحدة لكل عضو.
    assert.equal(events[0].payload.embeds.length, 3, 'التقرير الأسبوعي = عنوان + لوحتان');
    for (const e of events.filter(ev => ev.kind === 'dm')) {
      assert.equal(e.payload.embeds.length, 1, `${e.id}: بطاقة واحدة فقط`);
    }
  });

  test('عضو بلا أي رسالة ضعيفة لا يوقف التقرير — المسار يكتمل', async () => {
    // حارس ضد انكسار صامت: بيانات فقيرة جداً (لا نشاط أصلاً) يجب أن تمرّ كما تمرّ ثرية.
    for (const id of ['9200000000000000001', '9200000000000000002']) seedMember(id);
    const { client, events } = fakeClient();
    await scheduler.weeklyReport(client);
    assert.equal(events.filter(e => e.kind === 'dm').length, 2, 'رسالتان فرديتان للعضوين');
    assert.ok(events.some(e => e.kind === 'channel' && e.id === PERF), 'رسالة التقرير لم تُرسل');
  });
});
