'use strict';
/**
 * نظام Score — درجة 0-100 لكل إداري داخل فريقه.
 *
 * القاعدة الأساسية (README + الاختبارات): العامل الذي لا يمكن قياسه
 * (لا تقييم، لا سجلات) يُستثنى من المقام، والباقي يُوحَّد إلى 100.
 * لا وزن افتراضي ولا صفر يُمنح لمجرد غياب القياس — وإلا صارت الدرجات غير قابلة للمقارنة.
 */
const { getDb } = require('../database');
const clock = require('../clock');
const settings = require('./settings');
const { rankInfo } = require('./permissions');

// ===== معايرة الأشرطة (للنافذة المرجعية 30 يوماً) =====
const NOMINAL_WINDOW = 30;
/** شريط التواجد: يومان أقل من النافذة — الغياب الطفيف لا يُعاقَب كغياب كامل */
const ACTIVE_DAY_TARGET = NOMINAL_WINDOW - 4; // 26
/** 150 رسالة = 80% من الشريط، و200 فأكثر = كامل */
const CHAT_TARGET = 187.5;
const TICKET_TARGET = 50;
const ACTION_TARGET = 60;
/** سرعة الحل: 5 دقائق = كامل، 60 دقيقة = صفر (من سجل التكتات) */
const DURATION_FULL = 5, DURATION_ZERO = 60;
/** تقييم النجوم: نجمة = صفر، 4.5 فأعلى = كامل */
const RATING_ZERO = 1, RATING_FULL = 4.5;
/** التقييمات البشرية (مشرف/تفاعل/سرعة) على سلم 5-25 كما في قاعدة البيانات */
const HUMAN_RATING_MAX = 25;

const clamp01 = v => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const num = v => (v == null || v === '' ? null : Number(v));
const durationRatio = minutes => clamp01((DURATION_ZERO - minutes) / (DURATION_ZERO - DURATION_FULL));
const ratingRatio = stars => clamp01((stars - RATING_ZERO) / (RATING_FULL - RATING_ZERO));
const humanRatio = value => clamp01(value / HUMAN_RATING_MAX);
/** أيام التواجد بعد خصم الإجازة المعتمدة — لا يُعاقَب العضو على غيابه بإجازة */
const presenceRatio = (raw, target) => clamp01(raw.activeDays / Math.max(1, target - (raw.leaveDays || 0)));

/**
 * المواد الخام لنافذة واحدة (بالأيام) مع إزاحة للخلف — الجدولة تستخدم 0 و7.
 * @param {string} userId
 * @param {number} days حجم النافذة
 * @param {number} offset إزاحة النافذة للخلف (7 = الأسبوع السابق)
 */
function monthlyRaw(userId, days = NOMINAL_WINDOW, offset = 0) {
  const db = getDb();
  const windowDays = Math.max(1, Number(days) || NOMINAL_WINDOW);
  const shift = Math.max(0, Number(offset) || 0);
  const end = clock.addDays(clock.today(), -shift);
  const start = clock.addDays(end, -(windowDays - 1));

  // النشاط: من عمود day المفهرس لا من created_at
  const act = db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(weight), 0) w, COUNT(DISTINCT day) d
    FROM activity_logs WHERE user_id = ? AND day BETWEEN ? AND ?`).get(userId, start, end);

  const tick = db.prepare(`SELECT COUNT(*) c, AVG(duration) dur, COALESCE(SUM(reopened), 0) re,
      COUNT(rating) rated, AVG(rating) rating
    FROM ticket_metrics WHERE claimer = ? AND date(closed_at) BETWEEN ? AND ?`).get(userId, start, end);

  // مصدر التقييم: النظام الخارجي أولاً. لا يُجمع أبداً مع تقييمات التكتات —
  // فالتقييم الواحد لعميل واحد ليس مصدرين، وجمعهما يضاعف أثره ويشوّه المتوسط.
  const ext = db.prepare(`SELECT COUNT(*) c, AVG(stars) a
    FROM support_ratings WHERE staff_id = ? AND date(rated_at) BETWEEN ? AND ?`).get(userId, start, end);

  const actions = db.prepare(`SELECT COUNT(*) c FROM mod_actions
    WHERE moderator_id = ? AND date(created_at) BETWEEN ? AND ?`).get(userId, start, end).c;

  const warnings = db.prepare(`SELECT COUNT(*) c FROM warnings
    WHERE user_id = ? AND voided_at IS NULL AND date(created_at) BETWEEN ? AND ?`).get(userId, start, end).c;

  const notes = db.prepare(`SELECT note_type, COUNT(*) c FROM staff_notes
    WHERE user_id = ? AND date(created_at) BETWEEN ? AND ? GROUP BY note_type`).all(userId, start, end);

  // الإجازات المعتمدة أو المنتهية المتقاطعة مع النافذة (طرفا المدة محسوبان)
  const leaveRows = db.prepare(`SELECT start_date, end_date FROM leave_requests
    WHERE user_id = ? AND status IN ('approved', 'ended') AND date(start_date) <= ? AND date(end_date) >= ?`)
    .all(userId, end, start);
  let leaveDays = 0;
  for (const row of leaveRows) {
    const from = row.start_date > start ? row.start_date : start;
    const to = row.end_date < end ? row.end_date : end;
    const span = clock.daysBetween(from, to);
    if (span != null && span >= 0) leaveDays += span + 1;
  }

  let avgRating = null, ratingCount = 0, ratingSource = null;
  if (ext.c > 0) {
    avgRating = Math.round(ext.a * 100) / 100;
    ratingCount = ext.c;
    ratingSource = 'external';
  } else if (tick.rated > 0) {
    avgRating = Math.round(tick.rating * 100) / 100;
    ratingCount = tick.rated;
    ratingSource = 'tickets';
  }

  return {
    messages: act.c,
    weightedMessages: Math.round(act.w * 100) / 100,
    activeDays: act.d,
    tickets: tick.c,
    avgRating,
    ratingCount,
    ratingSource,
    avgDuration: tick.dur == null ? null : Math.round(tick.dur * 100) / 100,
    reopened: tick.re,
    actions,
    warnings,
    positiveNotes: (notes.find(n => n.note_type === 'positive') || { c: 0 }).c,
    negativeNotes: (notes.find(n => n.note_type === 'negative') || { c: 0 }).c,
    leaveDays,
  };
}

/** يبني عاملاً: النقاط = الوزن × النسبة، والعامل غير المُقاس يدخل بلا نقاط */
function factor(key, name, weight, ratio, detail) {
  const assessed = ratio != null;
  return {
    key,
    name,
    max: weight,
    pts: assessed ? Math.round(weight * ratio) : 0,
    assessed,
    detail,
  };
}

/** عامل من تقييم بشري على سلم 5-25: غائب = مستثنى من المقام */
function humanFactor(key, name, weight, value, label) {
  const v = num(value);
  const assessed = v != null && v > 0;
  return factor(key, name, weight, assessed ? humanRatio(v) : null,
    assessed ? `${label} ${v}/${HUMAN_RATING_MAX}` : 'بلا تقييم');
}

/**
 * حساب درجة عضو واحد.
 * @param {object} staff صف staff_members
 * @param {object} [raw] ناتج monthlyRaw — إن غُيب حُسب تلقائياً (أمر /me)
 */
function compute(staff, raw) {
  // الإدارة العامة فريق مستقل: لا درجة ولا ترقية — يُعاد شكل فارغ موحّد.
  if (!staff || staff.team === 'general_management') return { score: 0, factors: [], raw: null, assessedMax: 0 };

  // Helper لا يستقبل تكتات، فأوزانه أوزان Helper لا أوزان Support.
  const set = staff.team === 'moderation' ? 'moderation'
    : rankInfo('support', staff.rank)?.handlesTickets === false ? 'helper' : 'support';
  const weights = settings.scoreWeights(set);
  const r = raw || monthlyRaw(staff.user_id);

  const chat = factor('chat', 'الرسائل', weights.chat, clamp01(r.messages / CHAT_TARGET),
    `${r.messages} رسالة (الهدف ${CHAT_TARGET})`);
  const presence = factor('presence', 'التواصل', weights.presence, presenceRatio(r, ACTIVE_DAY_TARGET),
    `${r.activeDays} يوم نشط من ${ACTIVE_DAY_TARGET}${r.leaveDays ? ` (إجازة ${r.leaveDays} يوم)` : ''}`);

  let factors;
  if (set === 'helper') {
    factors = [
      chat,
      presence,
      humanFactor('teamInteraction', 'التفاعل مع الفريق', weights.teamInteraction, staff.team_interaction, 'تقييم'),
      humanFactor('supervisorRating', 'تقييم المشرف', weights.supervisorRating, staff.supervisor_rating, 'تقييم'),
    ];
  } else if (set === 'support') {
    // السرعة والتقييم في وعاء واحد: كلٌّ منهما يُقاس بميزته إن وُجدت
    const parts = [];
    const duration = num(r.avgDuration);
    if (duration != null) parts.push({ ratio: durationRatio(duration), text: `${Math.round(duration)} دقيقة للحل` });
    const rating = num(r.avgRating);
    if (rating != null) parts.push({ ratio: ratingRatio(rating), text: `${r.avgRating}⭐ (${r.ratingCount})` });
    factors = [
      factor('tickets', 'التكتات', weights.tickets, clamp01(r.tickets / TICKET_TARGET),
        `${r.tickets} تكتة (الهدف ${TICKET_TARGET})`),
      factor('speed', 'سرعة الاستجابة والتقييم', weights.speed,
        parts.length ? parts.reduce((s, p) => s + p.ratio, 0) / parts.length : null,
        parts.length ? parts.map(p => p.text).join(' • ') : 'بلا سجلات'),
      chat,
      presence,
    ];
  } else {
    // الإشراف: سرعة الاستجابة من تقييم المشرف المسجَّل، وإلا من سجل التكتات
    const responseSpeed = num(staff.response_speed);
    const duration = num(r.avgDuration);
    const speed = responseSpeed != null && responseSpeed > 0
      ? { ratio: humanRatio(responseSpeed), text: `تقييم ${responseSpeed}/${HUMAN_RATING_MAX}` }
      : duration != null
        ? { ratio: durationRatio(duration), text: `${Math.round(duration)} دقيقة للحل` }
        : null;
    const present = Math.max(0, r.activeDays - (r.leaveDays || 0));
    factors = [
      factor('actions', 'المخالفات', weights.actions, clamp01(r.actions / ACTION_TARGET),
        `${r.actions} إجراء (الهدف ${ACTION_TARGET})`),
      factor('speed', 'سرعة الاستجابة', weights.speed, speed ? speed.ratio : null,
        speed ? speed.text : 'بلا تقييم'),
      factor('activity', 'النشاط', weights.activity, presenceRatio(r, ACTIVE_DAY_TARGET),
        `${r.activeDays} يوم نشط من ${ACTIVE_DAY_TARGET}`),
      factor('commitment', 'الالتزام', weights.commitment, clamp01(present / ACTIVE_DAY_TARGET),
        `${present} يوم حضور فعلي`),
    ];
  }

  // العوامل غير المُقاسة خارج المقام، والبقية تُوحَّد إلى 100
  const counted = factors.filter(f => f.assessed);
  const earned = counted.reduce((s, f) => s + f.pts, 0);
  const assessedMax = counted.reduce((s, f) => s + f.max, 0);
  return {
    score: assessedMax > 0 ? Math.round((earned / assessedMax) * 100) : 0,
    factors,
    raw: r,
    assessedMax,
  };
}

/** حدود التقدير اللفظي — مطابقة لبوابات Score في شروط الترقيات */
const GRADES = [
  { min: 90, label: 'ممتاز' },
  { min: 75, label: 'جيد جداً' },
  { min: 60, label: 'جيد' },
  { min: 40, label: 'مقبول' },
];

function grade(score) {
  const s = Number(score);
  if (!Number.isFinite(s)) return '—';
  return (GRADES.find(g => s >= g.min) || { label: 'ضعيف' }).label;
}

/** الطبقة 1..5 المقابلة للتقدير — صفر لدرجة غير قابلة للتقييم */
function tier(score) {
  const s = Number(score);
  if (!Number.isFinite(s) || s < 0) return 0;
  return s >= 90 ? 5 : s >= 75 ? 4 : s >= 60 ? 3 : s >= 40 ? 2 : 1;
}

module.exports = { compute, monthlyRaw, grade, tier };
