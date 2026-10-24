'use strict';
const { getDb } = require('../database');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS, PROBATION, POINTS_THRESHOLDS } = require('../constants');
const clock = require('../clock');
const points = require('./points');
const reports = require('./reports');
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

/**
 * حدّ بوابة «حل النزاعات» (requiresConflictResolution في ثوابت الترقيات):
 * عدّ الإجراءات الجادّة — warn/timeout/kick/ban في MOD_ACTION_TYPES — داخل
 * نافذة الترقية، لا الكل. الروتين (حذف/فويس/اسم) لا يُثبت معالجة نزاع، فلا
 * تكفي مئات الحذف وحدها؛ تسقط البوابة وحدها حين ينقص الجادّ عن هذا الحدّ،
 * وعدد الإجراءات الكلي يبقى لبوابة «الإجراءات المعالجة» كما كان بلا تغيير.
 */
const CONFLICT_MIN_SERIOUS_ACTIONS = 3;

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

/**
 * نقاط العضو داخل تقرير شهري محفوظ — بصيغتها الصريحة (قرار المالك D8).
 *
 * الصيغة الفاعلة تحمل `points`. الصيغة القديمة تحمل `score` — وهي غير
 * صالحة للنقاط الجديدة ولا تُترجَم صامتاً (لا استنتاج مضمر من رصيد قديم)،
 * بل تُعلَم explicitاً كي يميّز التقرير «لا تقرير» عن «تقرير قديم الصيغة».
 * @returns {{value:number, legacy:false}|{value:null, legacy:true}|null}
 */
function memberPoints(parsed, userId) {
  const members = parsed && Array.isArray(parsed.members) ? parsed.members : [];
  const row = members.find(m => m && String(m.user) === String(userId));
  if (!row) return null;
  const value = Number(row.points);
  if (Number.isFinite(value)) return { value, legacy: false };
  return row.score != null ? { value: null, legacy: true } : null;
}

/**
 * «الأداء المستقر» (stableMonths/stableMinPoints في ثوابت الترقيات).
 * لا يُحسب Score اليوم ويُنسى غداً: القراءة من التقارير الشهرية المحفوظة
 * (saved_reports) لأنها مُؤرَّخة ولا ترجع بأثر رجعي بعد اعتمادها.
 * التقرير الشهري يُخزَّن لكل فريق على حدة بصيغة `${period}:${team}`، وقد توجد
 * نسخ محفوظة بلا لاحقة فريق (تقارير أقدم) — نقبل الصيغتين ونجمع الشهر مرة واحدة.
 * @param {string} userId العضو
 * @param {number} months عدد الأشهر المطلوبة (الأحدث أولاً)
 * @param {number} minPoints أدنى درجة مقبولة في كل شهر
 * @param {string} [team] يفضّل نسخة تقرير هذا الفريق إن وُجدت للفريقين
 * @returns {{passed:boolean, periods:string[], points:number[], actual:string, required:string, missing:number}}
 */
function stability(userId, months, minPoints, team) {
  const wanted = Math.max(1, Math.trunc(Number(months) || 0));
  const floor = Number(minPoints) || 0;
  const db = getDb();
  // نمرّ على الصفوف مرة واحدة ونفكّ ترميز كل تقرير مرة واحدة. النسخة السابقة كانت تمرّ مرتين وتفكّ ترميز كل صف مرتين على الأقل — نحو 144 عملية JSON.parse لعضو واحد عند 3 سنوات.
  // النتيجة هي نفسها: تقريرا الفريقين لنفس الشهر شهر واحد لا شهران، ونسخة فريق العضو مفضّلة.
  const rows = db.prepare(`SELECT period, data FROM saved_reports WHERE report_type = 'monthly' ORDER BY period DESC`).all();
  const chosen = new Map();
  const legacyPeriods = new Set();
  for (const row of rows) {
    const period = String(row.period).split(':')[0];
    const preferred = !!(team && String(row.period).endsWith(`:${team}`));
    const held = chosen.get(period);
    // نسخة الفريق المفضّلة لا تُستبدل، والبديل يُكتب فقط إن لم يوجد شيء بعد.
    if (held && (held.preferred || !preferred)) continue;
    const member = memberPoints(safeJson(row.data), userId);
    if (!member) continue; // التقرير لا يخص هذا العضو — جرّب نسخة الفريق الأخرى
    if (member.legacy) { // صيغة score القديمة: تُعلَم ولا تُحتسب (قرار المالك D8)
      if (!held || !held.preferred) legacyPeriods.add(period);
      if (!held && preferred) chosen.set(period, { legacy: true, preferred });
      continue;
    }
    chosen.set(period, { value: member.value, preferred });
  }
  // الشهور ذو صيغة قديمة على نسخته المفضّلة تبقى ناقصة عمداً — الشفافية بدل
  // الترجمة الصامتة؛ حاصلها missing لا اجتياز.
  for (const [period, held] of chosen) if (held.legacy) chosen.delete(period);
  const periods = [...chosen.keys()].sort().reverse().slice(0, wanted);
  const points = periods.map(p => chosen.get(p).value);
  const missing = wanted - periods.length;
  const passed = missing === 0 && points.every(s => s >= floor);
  const legacyNote = legacyPeriods.size
    ? ` — تقارير قديمة بالصيغة score غير صالحة للنقاط: ${legacyPeriods.size}`
    : '';
  return {
    passed, periods, points, missing,
    actual: points.length
      ? `${points.join(' / ')} (${periods.join(' / ')})${legacyNote}`
      : (legacyPeriods.size ? 'تقارير قديمة بالصيغة score غير صالحة للنقاط' : 'لا توجد تقارير شهرية محفوظة'),
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
  if (!rule) return {
    rule: null, eligible: false, checks: [], points: points.getBalance(staff.user_id), rank: staff.rank,
    reason: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)',
  };

  const db = getDb();
  const today = clock.today();
  const windowDays = rule.windowDays || 90;
  const warnWindowDays = rule.warnWindowDays || windowDays;
  const since = clock.addDays(today, -windowDays);
  const warnSince = clock.addDays(today, -warnWindowDays);

  const months = clock.monthsSince(staff.rank_since);

  // أنصاف مفتوحة على الأعمدة الخام (clock.dayStartStamp) لا date(col) >= ?:
  // date() ليست حدّاً قابلاً للفهرسة فكانت SQLite تفحص كل تاريخ العضو بلا تقليم.
  const sinceStamp = clock.dayStartStamp(since) || since;
  const warnSinceStamp = clock.dayStartStamp(warnSince) || warnSince;

  const warnCount = db.prepare(`SELECT COUNT(*) c FROM warnings WHERE user_id = ? AND voided_at IS NULL AND created_at >= ? AND warning_type != 'verbal'`).get(staff.user_id, warnSinceStamp).c;

  const checks = [];
  const ok = (label, pass, actual, required) => checks.push({ label, pass, actual, required });

  ok('مدة الخدمة بالرتبة', months >= rule.months, `${months.toFixed(1)} شهر`, `${rule.months} شهر`);

  // ===== بوابة النقاط (نظام النقاط فقط — قرار المالك) =====
  // Score أُخرج من أهلية الترقية: بقي أداة تقارير وتقييم لا بوابة. السبب أن
  // درجة واحدة مركّبة تخفي «هل تقدّم فعلاً؟» خلف متوسط، بينما النقاط دفترٌ
  // كل سطر فيه سببٌ معلوم — والترقية تُسأل «كم جمعتَ منذ صرت بهذه الرتبة؟».
  //
  // الرصيد محسوب على العصر الحالي (rank_epoch): الترقية تصفّره (setRank(newEpoch))،
  // فالسؤال هنا هو «كم جمعتَ منذ آخر ترقية» لا «كم جمعتَ في تاريخك كله» — وإلا
  // لترقّى العضو على نقاط رتبة سابقة، وصار الرصيد عدّاداً لا يعود لصفر أبداً.
  const currentPoints = points.getBalance(staff.user_id);
  const pointsThreshold = POINTS_THRESHOLDS[staff.team]?.[staff.rank];
  if (pointsThreshold != null) {
    ok('نقاط الترقية', currentPoints >= pointsThreshold,
      `${currentPoints}`, `${pointsThreshold}+`);
  } else {
    // لا عتبة معرَّفة = لا ترقية تلقائية. تمرير البوابة لغياب عتبتها يمنح
    // ترقيةً بلا شرط نقاط — وهو عكس قرار «النقاط فقط». فتسقط بصريح لا صامت:
    // الإداري يرى «ترقية يدوية» فيقرر، بدل أن يُرقّى على بوابة مفقودة.
    ok('نقاط الترقية', false,
      `${currentPoints}`, 'لا عتبة معرَّفة — ترقية يدوية');
  }

  // الحصول على البيانات الخام للنافذة (بديل عن score.monthlyRaw)
  const raw = reports.getRaw(staff.user_id, windowDays) || {};

  if (staff.team === 'support') {
    // الرسائل في قنوات العمل (المخلفات) خلال النافذة
    if (rule.minMessages != null) {
      // عمود created_at الخام لا day: day = today() بتوقيت TZ بينما created_at
      // UTC، فالتبديل بينهما يزيح حدّ النافذة حتى 3 ساعات عند الطرف. score.js
      // يقارن بيوم عن قصد ليجد عموداً مفهرساً، وهنا المطلوب فقط أن يصبح
      // الحدّ قابلاً للفهرسة.
      const msgs = db.prepare(`SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND created_at >= ?`).get(staff.user_id, sinceStamp).c;
      ok(`الرسائل (${windowLabel(windowDays)})`, msgs >= rule.minMessages, `${msgs}`, `${rule.minMessages}+`);
    }
    // تقييم العملاء (من support_ratings التجارية)
    if (rule.rating) {
      const sr = db.prepare(`SELECT COUNT(*) c, AVG(stars) r FROM support_ratings WHERE staff_id = ? AND rated_at >= ?`).get(staff.user_id, sinceStamp);
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
    // عدّادان في استعلام واحد: الكل لبوابة «الإجراءات المعالجة» (لم يتغير
    // معناها)، والجادّ (warn/timeout/kick/ban) لبوابة «حل النزاعات» — فالحذف
    // والفويس وتغيير الاسم روتينٌ لا يُثبت معالجة نزاع.
    const a = db.prepare(`SELECT COUNT(*) c, COUNT(CASE WHEN action_type IN ('warn','timeout','kick','ban') THEN 1 END) serious
      FROM mod_actions WHERE moderator_id = ? AND created_at >= ?`).get(staff.user_id, sinceStamp);
    ok(`الإجراءات المعالجة (${windowLabel(windowDays)})`, a.c >= rule.actions, `${a.c}`, `${rule.actions}+`);
    if (rule.requiresConflictResolution) {
      ok(`حل النزاعات (${windowLabel(windowDays)})`, a.serious >= CONFLICT_MIN_SERIOUS_ACTIONS,
        `${a.serious} إجراء جاد`, `${CONFLICT_MIN_SERIOUS_ACTIONS}+`);
    }
  }

  if (rule.minActiveDays) {
    // عدّ الأيام المتمايزة من عمود day، لكن النافذة على created_at (UTC) —
    // انظر ملاحظة الاستعلام السابق عن فرق التوقيت.
    const activeDays = db.prepare(`SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND created_at >= ?`).get(staff.user_id, sinceStamp).d;
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
    const wrong = db.prepare(`SELECT COUNT(*) c FROM staff_notes WHERE user_id = ? AND note_type = 'negative' AND created_at >= ?`).get(staff.user_id, sinceStamp).c;
    ok(`القرارات الخاطئة (${windowLabel(windowDays)})`, wrong <= rule.maxWrongDecisions, `${wrong}`, `أقصى ${rule.maxWrongDecisions}`);
  }

  // الأداء المستقر: من التقارير الشهرية المحفوظة، لا من Score اليوم.
  if (rule.stableMonths) {
    const st = stability(staff.user_id, rule.stableMonths, rule.stableMinPoints, staff.team);
    const label = `الأداء المستقر (${rule.stableMonths} ${rule.stableMonths > 1 ? 'أشهر' : 'شهر'})`;
    ok(label, st.passed,
      st.missing > 0 && st.points.length ? `${st.actual} — ينقص ${st.missing} ${st.missing > 1 ? 'أشهر' : 'شهر'}` : st.actual,
      st.required);
  }

  ok('الحالة', staff.status === 'active' || staff.status === 'probation', staff.status, 'active');

  return {
    rule, eligible: checks.every(c => c.pass), checks, months, windowDays, warnWindowDays,
    points: currentPoints, rank: staff.rank, raw,
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
