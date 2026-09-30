'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const score = require('./score');
const { hoursSince } = require('../utils');
const clock = require('../clock');
const { LEVELS, INACTIVE_STATUSES } = require('../constants');
const { rankInfo } = require('./permissions');
const logger = require('../logger').log('reports');

/** تقرير فردي كامل */
function individual(staff, days = 30) {
  const db = getDb();
  const raw = score.monthlyRaw(staff.user_id, days);
  const sc = score.compute(staff, raw);
  const warns = db.prepare(`SELECT warning_type, COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND created_at >= datetime('now', ?) GROUP BY warning_type`).all(staff.user_id, `-${days} days`);
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
  return members.map(m => individual(m, days));
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

function leaderboard(teamKey, days = 30, { includeProbation = false } = {}) {
  const members = staffService.all(teamKey ? { team: teamKey } : {});
  const scored = members
    .filter(m => ['support', 'moderation'].includes(m.team))
    .filter(m => !(m.team === 'support' && rankInfo('support', m.rank)?.level >= LEVELS.BOSS))
    .filter(m => !INACTIVE_STATUSES.includes(m.status))
    .filter(m => includeProbation || m.status !== 'probation')
    .map(m => {
      const r = individual(m, days);
      const primary = m.team === 'support' ? r.raw.tickets : r.raw.actions;
      const qualified = r.raw.activeDays >= LEADERBOARD_MIN_ACTIVE_DAYS || primary > 0;
      return { ...r, primary, qualified };
    });

  const ranked = scored.filter(r => r.qualified).sort((a, b) => b.score - a.score || b.primary - a.primary);
  const unranked = scored.filter(r => !r.qualified).sort((a, b) => b.raw.activeDays - a.raw.activeDays);
  ranked.unranked = unranked; // يُقرأ في العرض دون كسر التوافق مع المستهلكين الحاليين
  return ranked;
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

module.exports = { individual, team, personalTrend, leaderboard, bestOfMonth, daily, save, lastSaved, LEADERBOARD_MIN_ACTIVE_DAYS, BEST_OF_MONTH_MIN_SCORE, BEST_OF_MONTH_MIN_WORK };
