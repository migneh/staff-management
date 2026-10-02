'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const score = require('./score');
const { hoursSince } = require('../utils');
const clock = require('../clock');
const { LEVELS, INACTIVE_STATUSES } = require('../constants');
const { rankInfo } = require('./permissions');
const logger = require('../logger').log('reports');

/**
 * المواد الخام لكل الأعضاء في نافذة واحدة — سبع عبارات GROUP BY بدل 7N.
 *
 * monthlyRaw في score.js يستدعي سبع استعلامات **لكل عضو** (services/score.js غير
 * ours ⇒ نُعيد التجميع هنا لا فيه). على 120 إدارياً صار ذلك ~960 استعلاماً
 * لـ /leaderboard وحده. الدلالات مطابقة واحد-لواحد: نفس حدود النافذة
 * (clock.dayWindow — نصف مفتوحة على أعمدة الطابع)، ونفس شروط voided_at،
 * ونفس التقريب Math.round(x*100)/100، ونفس ترجيح مصدر التقييم
 * (الخارجي أولاً ثم التكتات، ولا يُجمعان أبداً).
 *
 * @param {string[]} userIds
 * @param {number} days
 * @returns {Map<string, object>} raw لكل عضو، وبنفس شكل monthlyRaw
 */
function rawBatch(userIds, days = 30) {
  const out = new Map();
  if (!userIds || userIds.length === 0) return out;
  const db = getDb();

  // حدود النافذة نفسها التي يحسبها monthlyRaw — التطابق هنا شرط الصحة لا تفصيل.
  const windowDays = Math.max(1, Number(days) || 30);
  const end = clock.today();
  const start = clock.addDays(end, -(windowDays - 1));
  const win = clock.dayWindow(start, end) || { start, endExclusive: end };

  const ids = userIds.map(String);
  // قائمة ?: تُكتب العبارة مكرّرةً عمداً (قائمة نائبة داخل قالب لا تُحلّ محلّ
  // متغير)، وإلا تعذّر على حارس المخطط (tests/sqlSchemaAudit.js) تركيب الجملة
  // والتحقق من أعمدتها. نفس النمط في services/faq.js.

  // صفوف فارغة لكل عضو: من لا صفّ له في أي جدول لا ينقص عن الخريطة، فـ GROUP BY
  // لا يعتمد على وجود الصف أصلاً.
  const base = () => ({
    messages: 0, weightedMessages: 0, activeDays: 0, tickets: 0, avgRating: null,
    ratingCount: 0, ratingSource: null, avgDuration: null, reopened: 0, actions: 0,
    warnings: 0, positiveNotes: 0, negativeNotes: 0, leaveDays: 0,
  });

  // 1) النشاط — من عمود day المفهرس لا من created_at (نفس monthlyRaw)
  const act = new Map(db.prepare(`SELECT user_id, COUNT(*) c, COALESCE(SUM(weight), 0) w, COUNT(DISTINCT day) d
    FROM activity_logs WHERE user_id IN (${ids.map(() => '?').join(',')}) AND day BETWEEN ? AND ? GROUP BY user_id`)
    .all(...ids, start, end).map(r => [String(r.user_id), r]));

  // 2) التكتات
  const tick = new Map(db.prepare(`SELECT claimer, COUNT(*) c, AVG(duration) dur, COALESCE(SUM(reopened), 0) re,
      COUNT(rating) rated, AVG(rating) rating
    FROM ticket_metrics WHERE claimer IN (${ids.map(() => '?').join(',')}) AND closed_at >= ? AND closed_at < ? GROUP BY claimer`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.claimer), r]));

  // 3) التقييم الخارجي — مصدر أوّل، ولا يُجمع أبداً مع تقييمات التكتات
  const ext = new Map(db.prepare(`SELECT staff_id, COUNT(*) c, AVG(stars) a
    FROM support_ratings WHERE staff_id IN (${ids.map(() => '?').join(',')}) AND rated_at >= ? AND rated_at < ? GROUP BY staff_id`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.staff_id), r]));

  // 4) إجراءات الإشراف
  const actions = new Map(db.prepare(`SELECT moderator_id, COUNT(*) c FROM mod_actions
    WHERE moderator_id IN (${ids.map(() => '?').join(',')}) AND created_at >= ? AND created_at < ? GROUP BY moderator_id`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.moderator_id), r.c]));

  // 5) الإنذارات غير الملغاة — total للمجموع، breakdown لأنواعها لنافذة individual.
  //    النافذتان مختلفتان فعلاً (half-open على الطابع مقابل datetime('now','-N
  //    days'))، فتبقي عبارتان — لا نقارب بينهما، فالتقرير كان يقرؤهما من مكانين.
  const warnTotal = new Map(db.prepare(`SELECT user_id, COUNT(*) c FROM warnings
    WHERE user_id IN (${ids.map(() => '?').join(',')}) AND voided_at IS NULL AND created_at >= ? AND created_at < ? GROUP BY user_id`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.user_id), r.c]));
  const warnBreakRows = db.prepare(`SELECT user_id, warning_type, COUNT(*) c FROM warnings
    WHERE user_id IN (${ids.map(() => '?').join(',')}) AND voided_at IS NULL AND created_at >= datetime('now', ?) GROUP BY user_id, warning_type`)
    .all(...ids, `-${windowDays} days`);
  // Map<userId, rows[]> — لا Map<userId, row>: التجميع على عمودين يجعل المفتاح
  // متكرراً، والكتابة المباشرة تُبقي آخر نوع فقط فتفقد بقية الأنواع.
  // والحقل user_id يُسقط: عقد individual يعيد { warning_type, c } فقط.
  const warnBreak = new Map();
  for (const r of warnBreakRows) {
    const key = String(r.user_id);
    const list = warnBreak.get(key);
    if (list) list.push({ warning_type: r.warning_type, c: r.c });
    else warnBreak.set(key, [{ warning_type: r.warning_type, c: r.c }]);
  }

  // 6) الملاحظات — عبارتان لا واحدة بـ IN على النوع: التجميع على note_type مع
  //    شرط note_type = 'positive' يحتاج فهرساً على (user_id, created_at)،
  //    والشرط على النوع يمنع الفهرس من أن يكون حدّاً — فنقيسه مباشرة كما كان.
  const notePos = new Map(db.prepare(`SELECT user_id, COUNT(*) c FROM staff_notes
    WHERE user_id IN (${ids.map(() => '?').join(',')}) AND note_type = 'positive' AND created_at >= ? AND created_at < ? GROUP BY user_id`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.user_id), r.c]));
  const noteNeg = new Map(db.prepare(`SELECT user_id, COUNT(*) c FROM staff_notes
    WHERE user_id IN (${ids.map(() => '?').join(',')}) AND note_type = 'negative' AND created_at >= ? AND created_at < ? GROUP BY user_id`)
    .all(...ids, win.start, win.endExclusive).map(r => [String(r.user_id), r.c]));

  // 7) الإجازات المتقاطعة مع النافذة (طرفا المدة محسوبان) — تُجمَّع بـ user_id
  //    ويُحسب التقاطع في JS بنفس منطق monthlyRaw.
  const leaveRows = db.prepare(`SELECT user_id, start_date, end_date FROM leave_requests
    WHERE user_id IN (${ids.map(() => '?').join(',')}) AND status IN ('approved', 'ended') AND start_date <= ? AND end_date >= ?`)
    .all(...ids, end, start);
  const leaveDays = new Map();
  for (const r of leaveRows) {
    const from = r.start_date > start ? r.start_date : start;
    const to = r.end_date < end ? r.end_date : end;
    const span = clock.daysBetween(from, to);
    if (span != null && span >= 0) {
      const key = String(r.user_id);
      leaveDays.set(key, (leaveDays.get(key) || 0) + span + 1);
    }
  }

  for (const id of ids) {
    const row = base();
    const a = act.get(id);
    if (a) { row.messages = a.c; row.weightedMessages = Math.round(a.w * 100) / 100; row.activeDays = a.d; }
    const t = tick.get(id);
    if (t) {
      row.tickets = t.c;
      row.reopened = t.re;
      row.avgDuration = t.dur == null ? null : Math.round(t.dur * 100) / 100;
    }
    const x = ext.get(id);
    if (x && x.c > 0) {
      row.avgRating = Math.round(x.a * 100) / 100;
      row.ratingCount = x.c;
      row.ratingSource = 'external';
    } else if (t && t.rated > 0) {
      row.avgRating = Math.round(t.rating * 100) / 100;
      row.ratingCount = t.rated;
      row.ratingSource = 'tickets';
    }
    row.actions = actions.get(id) || 0;
    row.warnings = warnTotal.get(id) || 0;
    row.positiveNotes = notePos.get(id) || 0;
    row.negativeNotes = noteNeg.get(id) || 0;
    row.leaveDays = leaveDays.get(id) || 0;
    out.set(id, { row, warns: warnBreak.get(id) || [] });
  }

  return out;
}
/** تقرير فردي كامل */
function individual(staff, days = 30, pre = null) {
  const raw = pre ? pre.row : score.monthlyRaw(staff.user_id, days);
  const sc = score.compute(staff, raw);
  const warns = pre
    ? pre.warns
    : getDb().prepare(`SELECT warning_type, COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND created_at >= datetime('now', ?) GROUP BY warning_type`).all(staff.user_id, `-${days} days`);
  const absentDays = Math.max(0, days - raw.activeDays - raw.leaveDays);
  return {
    staff, raw, score: sc.score, factors: sc.factors, assessedMax: sc.assessedMax, grade: score.grade(sc.score),
    warnings: warns, absentDays,
    lastActivityHours: hoursSince(staff.last_activity),
  };
}

/** ملخص فريق */
function team(teamKey, days = 30) {
  const members = staffService.all({ team: teamKey });
  const pre = rawBatch(members.map(m => String(m.user_id)), days);
  return members.map(m => individual(m, days, pre.get(String(m.user_id))));
}

/** ملخص قصير للوحة /me: اتجاه الأسبوع وسلسلة الأسابيع النشطة. */
function personalTrend(staff) {
  const currentRaw = score.monthlyRaw(staff.user_id, 7);
  const previousRaw = score.monthlyRaw(staff.user_id, 7, 7);
  const currentScore = score.compute(staff, currentRaw).score;
  const previousScore = score.compute(staff, previousRaw).score;
  const db = getDb();
  let streak = 0;
  for (let week = 0; week < 12; week++) {
    const end = clock.addDays(clock.today(), -(week * 7));
    const start = clock.addDays(end, -6);
    const active = db.prepare(`SELECT 1 FROM activity_logs WHERE user_id = ? AND day BETWEEN ? AND ? LIMIT 1`).get(staff.user_id, start, end);
    if (!active) break;
    streak += 1;
  }
  return {
    currentScore,
    previousScore,
    scoreDelta: currentScore - previousScore,
    currentActiveDays: currentRaw.activeDays,
    previousActiveDays: previousRaw.activeDays,
    streakWeeks: streak,
  };
}

/**
 * الترتيب — يستبعد Boss والمجازين والموقوفين والمستقيلين والخارجين.
 * من لم يسجّل حداً أدنى من المشاركة يُعرض في قائمة «غير مصنّفين» بدل منافسة
 * من يعمل فعلاً بميداليات (كان أي عضو بلا نشاط يحصل على 🥇 بدرجة 24).
 */
const LEADERBOARD_MIN_ACTIVE_DAYS = 3;

/** كل الصفات المستبعدة من الترتيب — معيار واحد مشترك مع bestOfMonth */
const isRankable = (m, includeProbation) =>
  ['support', 'moderation'].includes(m.team)
  && !(m.team === 'support' && rankInfo('support', m.rank)?.level >= LEVELS.BOSS)
  && !INACTIVE_STATUSES.includes(m.status)
  && (includeProbation || m.status !== 'probation');

function leaderboard(teamKey, days = 30, { includeProbation = false, pre = null } = {}) {
  const members = staffService.all(teamKey ? { team: teamKey } : {});
  const eligible = members.filter(m => isRankable(m, includeProbation));
  // raw واحد لكل عضو بدل monthlyRaw لكل عضو: previously 7N statements.
  const batch = pre || rawBatch(eligible.map(m => String(m.user_id)), days);
  const scored = eligible.map(m => {
    const r = individual(m, days, batch.get(String(m.user_id)));
    const primary = m.team === 'support' ? r.raw.tickets : r.raw.actions;
    const qualified = r.raw.activeDays >= LEADERBOARD_MIN_ACTIVE_DAYS || primary > 0;
    return { ...r, primary, qualified };
  });

  const ranked = scored.filter(r => r.qualified).sort((a, b) => b.score - a.score || b.primary - a.primary);
  const unranked = scored.filter(r => !r.qualified).sort((a, b) => b.raw.activeDays - a.raw.activeDays);
  ranked.unranked = unranked; // يُقرأ في العرض دون كسر التوافق مع المستهلكين الحاليين
  return ranked;
}

/**
 * ترتيب فريقين أو أكثر من **عبارة GROUP BY واحدة لكل جدول** لا 7N لكل فريق.
 *
 * team='all' في /leaderboard كان يبني الفريقين بالتتابع، فيجمع 7N لـ N لكل
 * فريق — أي 14Nk. leaderboardsAll يقبل قائمة الفرق ويعيد { key: rows } بنفس
 * عقد leaderboard، ويقرؤ المواد الخام مرة واحدة للكل.
 *
 * @param {string[]} teamKeys
 * @param {number} days
 * @param {{includeProbation?: boolean}} [opts]
 * @returns {Record<string, object[]>}
 */
function leaderboardsAll(teamKeys, days = 30, { includeProbation = false } = {}) {
  const keys = (teamKeys && teamKeys.length ? teamKeys : ['support', 'moderation']).map(String);
  const members = keys.flatMap(key => staffService.all({ team: key }));
  // نُرتّب قبل القراءة: الأعضاء غير المؤهَّلين للترتيب لا يحتاجون مواد خام،
  // فقراءة واحدة لأقل عدد ممكن من الصفوف.
  const eligible = members.filter(m => isRankable(m, includeProbation));
  const batch = rawBatch(eligible.map(m => String(m.user_id)), days);
  const out = {};
  for (const key of keys) {
    out[key] = leaderboard(key, days, { includeProbation, pre: batch });
  }
  return out;
}

/** أفضل إداري للشهر: يشترط حداً أدنى — لا جائزة لمن لم يعمل */
const BEST_OF_MONTH_MIN_SCORE = 70;
const BEST_OF_MONTH_MIN_WORK = 10;

function bestOfMonth(rows) {
  const withWork = rows.map(r => ({
    ...r,
    // تقارير الفريق لا تحتاج إلى أن يضيف المستدعي primary يدوياً؛ اشتقاقه هنا
    // يمنع منح الجائزة لعضو بلا أي عنصر عمل فعلي.
    primary: r.primary ?? (r.staff.team === 'support' ? r.raw.tickets : r.raw.actions),
  }));
  const eligible = withWork.filter(r => r.staff.rank !== 'Boss'
    && !INACTIVE_STATUSES.includes(r.staff.status)
    && r.staff.status !== 'probation'
    && r.score >= BEST_OF_MONTH_MIN_SCORE
    && r.primary >= BEST_OF_MONTH_MIN_WORK);
  if (rows.length && !eligible.length) {
    logger.warn(`لم يُمنح لقب أفضل إداري: لا أحد حقق الحد الأدنى (Score ${BEST_OF_MONTH_MIN_SCORE}+ و ${BEST_OF_MONTH_MIN_WORK} عنصر عمل)`);
  }
  return eligible.sort((a, b) => b.score - a.score || b.primary - a.primary)[0] || null;
}

/** التقرير اليومي */
function daily() {
  const db = getDb();
  const all = staffService.all();
  const active = all.filter(m => hoursSince(m.last_activity) <= 24).length;
  const absent = all.filter(m => !INACTIVE_STATUSES.includes(m.status) && hoursSince(m.last_activity) > 72);
  const onLeave = all.filter(m => m.status === 'on_leave').length;
  const tickets = db.prepare(`SELECT COUNT(*) c FROM ticket_metrics WHERE closed_at >= datetime('now', '-1 day')`).get().c;
  const actions = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE created_at >= datetime('now', '-1 day')`).get().c;
  const pending = {
    leaves: db.prepare(`SELECT COUNT(*) c FROM leave_requests WHERE status = 'pending'`).get().c,
    resignations: db.prepare(`SELECT COUNT(*) c FROM resignations WHERE status IN ('pending', 'on_hold')`).get().c,
    promotions: db.prepare(`SELECT COUNT(*) c FROM promotion_requests WHERE status = 'pending'`).get().c,
  };
  return { total: all.length, active, absent, onLeave, tickets, actions, pending };
}

function save(type, period, data) {
  getDb().prepare('INSERT INTO saved_reports (report_type, period, data) VALUES (?, ?, ?)').run(type, period, JSON.stringify(data));
}
function lastSaved(type, period) {
  const r = getDb().prepare('SELECT * FROM saved_reports WHERE report_type = ? AND period = ? ORDER BY id DESC LIMIT 1').get(type, period);
  return r ? JSON.parse(r.data) : null;
}

module.exports = {
  individual, team, personalTrend, leaderboard, leaderboardsAll, bestOfMonth, daily, save, lastSaved,
  rawBatch, LEADERBOARD_MIN_ACTIVE_DAYS, BEST_OF_MONTH_MIN_SCORE, BEST_OF_MONTH_MIN_WORK,
};
