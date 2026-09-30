'use strict';
const { getDb } = require('../database');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS, PROBATION } = require('../constants');
const clock = require('../clock');

/** الحد الأدنى لنسبة التكتات المُقيَّمة قبل الاعتماد على المتوسط */
const MIN_RATED_SHARE = PROBATION.minRatedShare;
/**
 * التقييم البشري (تقييم المشرف/التفاعل/سرعة الاستجابة) صالح لهذه المدة فقط.
 * تقييم عمره سنة يقول شيئاً عن الماضي لا عن أهلية الترقية اليوم.
 */
const RATING_VALID_DAYS = 90;

function nextPromotion(staff) {
  const list = staff.team === 'support' ? SUPPORT_PROMOTIONS : MOD_PROMOTIONS;
  return list.find(p => p.from === staff.rank) || null;
}

function windowLabel(days) {
  if (days >= 365) return `${Math.round(days / 365)} سنة`;
  if (days >= 30) return `${Math.round(days / 30)} شهور`;
  return `${days} يوم`;
}

/**
 * يفحص كل شروط الترقية التالية ويعيد تقريراً مفصلاً.
 * النوافذ الزمنية موحّدة: التكتات/المخالفات/التقييم/التواجد على windowDays،
 * والإنذارات على warnWindowDays — بدل «منذ بداية الرتبة» بلا سقف الذي كان
 * يجعل الشرط الفعلي أضعف من المعلن للفريق.
 */
function evaluate(staff) {
  const rule = nextPromotion(staff);
  if (!rule) return { rule: null, eligible: false, checks: [], reason: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)' };

  const db = getDb();
  const today = clock.today();
  const windowDays = rule.windowDays || 90;
  const warnWindowDays = rule.warnWindowDays || windowDays;
  const since = clock.addDays(today, -windowDays);
  const warnSince = clock.addDays(today, -warnWindowDays);

  const months = clock.monthsSince(staff.rank_since);

  const warnCount = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND date(created_at) >= ? AND warning_type != 'verbal'`).get(staff.user_id, warnSince).c;

  const checks = [];
  const ok = (label, pass, actual, required) => checks.push({ label, pass, actual, required });

  ok('مدة الخدمة بالرتبة', months >= rule.months, `${months.toFixed(1)} شهر`, `${rule.months} شهر`);

  if (staff.team === 'support') {
    // الرسائل في قنوات العمل (المخلفات) خلال النافذة
    if (rule.minMessages != null) {
      const msgs = db.prepare(`SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND date(created_at) >= ?`).get(staff.user_id, since).c;
      ok(`الرسائل (${windowLabel(windowDays)})`, msgs >= rule.minMessages, `${msgs}`, `${rule.minMessages}+`);
    }
    // تقييم العملاء (من support_ratings التجارية)
    if (rule.rating) {
      const sr = db.prepare(`SELECT COUNT(*) c, AVG(stars) r FROM support_ratings WHERE staff_id = ? AND date(rated_at) >= ?`).get(staff.user_id, since);
      const rating = sr.r != null ? Math.round(sr.r * 100) / 100 : null;
      const insufficient = sr.c < PROBATION.minTicketsForRating;
      const pass = !insufficient && rating != null && rating >= rule.rating;
      ok(`تقييم العملاء (${windowLabel(windowDays)})`, pass,
        insufficient ? `${rating ?? '—'} (${sr.c} تقييم، يلزم ${PROBATION.minTicketsForRating}+)` : `${rating} ⭐ (${sr.c} تقييم)`,
        insufficient ? `${PROBATION.minTicketsForRating} تقييم على الأقل` : `${rule.rating}+`);
    }
    if (rule.requiresSupervisorRating) {
      const age = staff.human_ratings_at ? Math.abs(clock.daysBetween(staff.human_ratings_at.slice(0, 10), today)) : null;
      const stale = age != null && age > RATING_VALID_DAYS;
      const rated = staff.supervisor_rating != null && !stale;
      const actual = staff.supervisor_rating == null ? 'لم يُقيَّم بعد'
        : stale ? `${staff.supervisor_rating}/25 — تقييم قديم (${age} يوم)`
          : `${staff.supervisor_rating}/25${age != null ? ` (قبل ${age} يوم)` : ''}`;
      ok('تقييم المشرف', rated, actual, `تقييم خلال ${RATING_VALID_DAYS} يوماً`);
    }
  } else {
    const a = db.prepare(`SELECT COUNT(*) c FROM mod_actions WHERE moderator_id = ? AND date(created_at) >= ?`).get(staff.user_id, since);
    ok(`الإجراءات المعالجة (${windowLabel(windowDays)})`, a.c >= rule.actions, `${a.c}`, `${rule.actions}+`);
    if (rule.requireConflictResolution) ok('حل النزاعات', a.c >= 5, `${a.c} إجراء`, 'سجل إجراءات كافٍ');
  }

  if (rule.minActiveDays) {
    const activeDays = db.prepare(`SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND date(created_at) >= ?`).get(staff.user_id, since).d;
    ok(`التواجد (${windowLabel(windowDays)})`, activeDays >= rule.minActiveDays, `${activeDays} يوم`, `${rule.minActiveDays}+`);
  }

  ok(`الإنذارات الرسمية (${windowLabel(warnWindowDays)})`, warnCount <= rule.maxWarnings, `${warnCount}`, `أقصى ${rule.maxWarnings}`);

  ok('الحالة', staff.status === 'active' || staff.status === 'probation', staff.status, 'active');

  return { rule, eligible: checks.every(c => c.pass), checks, months, windowDays, warnWindowDays };
}

function pendingRequest(userId) {
  return getDb().prepare(`SELECT * FROM promotion_requests WHERE user_id = ? AND status = 'pending'`).get(userId) || null;
}

function createRequest(staff, evaluation, note) {
  const res = getDb().prepare(`INSERT INTO promotion_requests (user_id, from_rank, to_rank, note, snapshot) VALUES (?, ?, ?, ?, ?)`)
    .run(staff.user_id, evaluation.rule.from, evaluation.rule.to, note || null, JSON.stringify(evaluation.checks));
  return res.lastInsertRowid;
}

function listPending() {
  return getDb().prepare(`SELECT * FROM promotion_requests WHERE status = 'pending' ORDER BY created_at`).all();
}

function getRequest(id) {
  return getDb().prepare('SELECT * FROM promotion_requests WHERE id = ?').get(id) || null;
}

function review(id, status, reviewerId, reason) {
  getDb().prepare(`UPDATE promotion_requests SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`)
    .run(status, reviewerId, reason || null, id);
}

// ===== نصاب الموافقات =====
/** يسجّل موافقة واحدة على الطلب (المفتاح الأساسي يمنع تصويت نفس الشخص مرتين) */
function recordApproval(requestId, userId) {
  const db = getDb();
  try {
    db.prepare('INSERT INTO promotion_approvals (request_id, user_id) VALUES (?, ?)').run(Number(requestId), userId);
  } catch (e) {
    if (!String(e.message).includes('UNIQUE')) throw e;
    return { recorded: false, count: approvalsCount(requestId) };
  }
  return { recorded: true, count: approvalsCount(requestId) };
}

function approvalsCount(requestId) {
  return getDb().prepare('SELECT COUNT(*) c FROM promotion_approvals WHERE request_id = ?').get(Number(requestId)).c;
}

function approvalsList(requestId) {
  return getDb().prepare('SELECT user_id, approved_at FROM promotion_approvals WHERE request_id = ? ORDER BY approved_at').all(Number(requestId));
}

module.exports = {
  nextPromotion, evaluate, pendingRequest, createRequest, listPending, getRequest, review,
  recordApproval, approvalsCount, approvalsList, windowLabel, RATING_VALID_DAYS,
};
