'use strict';
const { getDb } = require('../database');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS, PROBATION } = require('../constants');
const clock = require('../clock');
const score = require('./score');
const settings = require('./settings');

/** الحد الأدنى لنسبة التكتات المُقيَّمة قبل الاعتماد على المتوسط */
const MIN_RATED_SHARE = PROBATION.minRatedShare;
/**
 * التقييم البشري (تقييم المشرف/التفاعل/سرعة الاستجابة) صالح لهذه المدة فقط.
 * تقييم عمره سنة يقول شيئاً عن الماضي لا عن أهلية الترقية اليوم.
 */
const RATING_VALID_DAYS = 90;

/**
 * حدود بوابة «سرعة الاستجابة» (fastResponseRequired في ثوابت الترقيات).
 * المصدر يختلف بين الفريقين، فالفارق مقصود:
 *  - الدعم: متوسط زمن إغلاق التكتة بالدقائق (ticket_metrics.duration).
 *  - الإشراف: درجة المشرف من 25 (staff_members.response_speed)، ومتوسط
 *    زمن إغلاق التكتة هو البديل — نفس ترتيب الأولوية في score.js.
 *  حدّ 60 دقيقة هو نفسه نقطة الصفر في معايرة سرعة score.js (DURATION_ZERO).
 * قابلة للضبط بلا تعديل كود عبر policy('promotion.fastResponse.<team>', {...}).
 */
const FAST_RESPONSE = {
  support: { maxAvgDurationMinutes: 60 },
  moderation: { minResponseSpeed: 15 },
};

function fastResponseLimits(team) {
  const base = FAST_RESPONSE[team] || {};
  const override = settings.policy(`promotion.fastResponse.${team}`, null);
  return override && typeof override === 'object' ? { ...base, ...override } : { ...base };
}

function nextPromotion(staff) {
  const list = staff.team === 'support' ? SUPPORT_PROMOTIONS : MOD_PROMOTIONS;
  return list.find(p => p.from === staff.rank) || null;
}

function windowLabel(days) {
  if (days >= 365) return `${Math.round(days / 365)} سنة`;
  if (days >= 30) return `${Math.round(days / 30)} شهور`;
  return `${days} يوم`;
}

/** قراءة JSON لملف تقرير محفوظ — تقرير تالف يجب ألا يُسقط تقييم ترقية */
function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

/** درجة العضو داخل تقرير شهري محفوظ، أو null إن لم يرد فيه */
function memberScore(data, userId) {
  const parsed = safeJson(data);
  const members = parsed && Array.isArray(parsed.members) ? parsed.members : [];
  const row = members.find(m => m && String(m.user) === String(userId));
  const value = row ? Number(row.score) : NaN;
  return Number.isFinite(value) ? value : null;
}

/**
 * «الأداء المستقر» (stableMonths/stableMinScore في ثوابت الترقيات).
 * لا يُحسب Score اليوم ويُنسى غداً: القراءة من التقارير الشهرية المحفوظة
 * (saved_reports) لأنها مُؤرَّخة ولا ترجع بأثر رجعي بعد اعتمادها.
 * التقرير الشهري يُخزَّن لكل فريق على حدة بصيغة `${period}:${team}`، وقد توجد
 * نسخ محفوظة بلا لاحقة فريق (تقارير أقدم) — نقبل الصيغتين ونجمع الشهر مرة واحدة.
 * @param {string} userId العضو
 * @param {number} months عدد الأشهر المطلوبة (الأحدث أولاً)
 * @param {number} minScore أدنى درجة مقبولة في كل شهر
 * @param {string} [team] يفضّل نسخة تقرير هذا الفريق إن وُجدت للفريقين
 * @returns {{passed:boolean, periods:string[], scores:number[], actual:string, required:string, missing:number}}
 */
function stability(userId, months, minScore, team) {
  const wanted = Math.max(1, Math.trunc(Number(months) || 0));
  const floor = Number(minScore) || 0;
  const db = getDb();
  const rows = db.prepare(`SELECT period, data FROM saved_reports WHERE report_type = 'monthly' ORDER BY period DESC`).all();
  // نمرّ على الصفوف مرتين: نسخة فريق العضو أولاً ثم البقية، ونأخذ أول تقرير
  // يرد فيه العضو لكل شهر — تقريرا الفريقين لنفس الشهر شهر واحد لا شهران.
  const byPeriod = new Map();
  for (const pass of ['team', 'any']) {
    for (const row of rows) {
      const period = String(row.period).split(':')[0];
      if (byPeriod.has(period)) continue;
      if (pass === 'team' && team && !String(row.period).endsWith(`:${team}`)) continue;
      const value = memberScore(row.data, userId);
      if (value == null) continue; // التقرير لا يخص هذا العضو — جرّب نسخة الفريق الأخرى
      byPeriod.set(period, value);
    }
  }
  const periods = [...byPeriod.keys()].sort().reverse().slice(0, wanted);
  const scores = periods.map(p => byPeriod.get(p));
  const missing = wanted - periods.length;
  const passed = missing === 0 && scores.every(s => s >= floor);
  return {
    passed, periods, scores, missing,
    actual: scores.length
      ? `${scores.join(' / ')} (${periods.join(' / ')})`
      : 'لا توجد تقارير شهرية محفوظة',
    required: `${wanted} ${wanted > 1 ? 'أشهر متتالية' : 'شهر متتالٍ'} بحد ${floor}+`,
  };
}

/**
 * يفحص كل شروط الترقية التالية ويعيد تقريراً مفصلاً.
 * النوافذ الزمنية موحّدة: التكتات/المخالفات/التقييم/التواجد على windowDays،
 * والإنذارات على warnWindowDays — بدل «منذ بداية الرتبة» بلا سقف الذي كان
 * يجعل الشرط الفعلي أضعف من المعلن للفريق.
 */
function evaluate(staff) {
  const rule = nextPromotion(staff);
  if (!rule) return { rule: null, eligible: false, checks: [], score: null, grade: null, reason: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)' };

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

  // ===== بوابة Score =====
  // القراءة من نفس نافذة الشروط الأخرى (windowDays) لا من 30 يوماً ثابتة،
  // وإلا صار الأداء يُقاس على نافذة لا علاقة لها بالترقية المعلنة.
  const raw = score.monthlyRaw(staff.user_id, windowDays) || {};
  const sc = score.compute(staff, raw) || {};
  const currentScore = Number.isFinite(Number(sc.score)) ? Number(sc.score) : 0;
  if (rule.score != null) {
    ok(`تقييم الأداء Score (${windowLabel(windowDays)})`, currentScore >= rule.score,
      `${currentScore}/100 — ${score.grade(currentScore)}`, `${rule.score}+`);
  }

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

  // سرعة الاستجابة: تُقاس بنفس الأولوية التي يقيس بها score.js عامل السرعة —
  // درجة المشرف أولاً، ثم متوسط زمن إغلاق التكت كبديل — حتى لا يجتاز العضو
  // Score ثم يُسقطه شرط السرعة لأنه يقيس شيئاً آخر. غياب القياس لا يُحسب نجاحاً.
  if (rule.fastResponseRequired) {
    const limits = fastResponseLimits(staff.team);
    const max = Number(limits.maxAvgDurationMinutes);
    const avg = raw.avgDuration == null ? null : Number(raw.avgDuration);
    const durationMeasured = raw.tickets > 0 && avg != null && Number.isFinite(avg);
    if (staff.team === 'moderation' && staff.response_speed != null) {
      const min = Number(limits.minResponseSpeed);
      const value = Number(staff.response_speed);
      const assessed = Number.isFinite(value);
      ok('سرعة الاستجابة (تقييم المشرف)', assessed && value >= min,
        assessed ? `${value}/25` : 'لم تُقيَّم بعد', `${min}/25 فأعلى`);
    } else {
      ok(`سرعة الاستجابة (${windowLabel(windowDays)})`, durationMeasured && avg <= max,
        durationMeasured ? `${Math.round(avg)} دقيقة متوسط ${raw.tickets} تكتة` : 'لا توجد تكتات مغلقة مُقاسة',
        `أقل من ${max} دقيقة`);
    }
  }

  // القرارات الخاطئة: لا يوجد جدول مستقل لها، فالسجل الوحيد لقرار وُصف بالخطأ
  // داخل النافذة هو الملاحظة السلبية من المشرف (staff_notes).
  if (rule.maxWrongDecisions != null) {
    const wrong = db.prepare(`SELECT COUNT(*) c FROM staff_notes WHERE user_id = ? AND note_type = 'negative' AND date(created_at) >= ?`).get(staff.user_id, since).c;
    ok(`القرارات الخاطئة (${windowLabel(windowDays)})`, wrong <= rule.maxWrongDecisions, `${wrong}`, `أقصى ${rule.maxWrongDecisions}`);
  }

  // الأداء المستقر: من التقارير الشهرية المحفوظة، لا من Score اليوم.
  if (rule.stableMonths) {
    const st = stability(staff.user_id, rule.stableMonths, rule.stableMinScore, staff.team);
    const label = `الأداء المستقر (${rule.stableMonths} ${rule.stableMonths > 1 ? 'أشهر' : 'شهر'})`;
    ok(label, st.passed,
      st.missing > 0 && st.scores.length ? `${st.actual} — ينقص ${st.missing} ${st.missing > 1 ? 'أشهر' : 'شهر'}` : st.actual,
      st.required);
  }

  ok('الحالة', staff.status === 'active' || staff.status === 'probation', staff.status, 'active');

  return {
    rule, eligible: checks.every(c => c.pass), checks, months, windowDays, warnWindowDays,
    score: currentScore, grade: score.grade(currentScore), factors: sc.factors || [], raw,
  };
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
  nextPromotion, evaluate, stability, pendingRequest, createRequest, listPending, getRequest, review,
  recordApproval, approvalsCount, approvalsList, windowLabel, RATING_VALID_DAYS, FAST_RESPONSE,
};
