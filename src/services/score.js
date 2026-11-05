'use strict';
/**
 * مقياس الأداء — صيغة مركّبة نقية من 0 إلى 100 (البرف Q1).
 *
 * العوامل الخمسة كلها من أعمدة tally المجمّعة في reports.getRaw ولا يسأل
 * هذا الملف قاعدة بيانات إطلاقاً: يمرَّر له الصف الخام والتقييمات الإدارية
 * فيتحدد الرقم. النقاء يسبق التركيب — النافذة والاستعلامات في reports،
 * وهنا ترجيح الأوزان فقط.
 *
 * الأوزان جدول واحد فوق (SCORE_DEFAULTS.weights) وتُتجاوز من سياسة
 * `score.weights` كما تُقرأ أي سياسة سابقة في البرف. كل وزن بين 0 و100،
 * والحصيلة تُطبَّع على مجموع الأوزان المعتمدة (المتوازنة بعد استبعاد
 * عوامل بلا شاهد) — فيبقى المدى 0–100 مهما تبدّل الجدول.
 */

const settings = require('./settings');

const SCORE_DEFAULTS = Object.freeze({
  /** أوزان العوامل الخمسة بالمعايرة الافتراضية — الوحدة نقطة من 100 لا نسبة. */
  weights: { activity: 30, productivity: 25, rating: 20, speed: 10, discipline: 15 },
  /** مرايا كل عامل: يبلغ العامل 1 عند بلوغ المرآة، وفوقها يُثبَّت. */
  benchmarks: {
    /** الرسائل الموزونة في اليوم النشط التي تُشبِع العامل كاملاً. */
    messagesPerActiveDay: 5,
    /** التكتات اليومية المتوقعة — سقف الدعم الفني غير سقف باقي الفرق. */
    ticketsPerDay: { support: 1, other: 0.5 },
    /** إجراءات الإشراف اليومية المتوقعة — سقف الإشراف غير سقف باقي الفرق. */
    actionsPerDay: { moderation: 2, other: 1 },
    /** مدة التكتة (دقيقة) التي يبلغ عندها عامل السرعة الصفر. */
    durationZeroMinutes: 60,
    /** خصم كل مخالفة من عامل الانضباط (نسبة من 1). */
    penalties: { warning: 0.25, negativeNote: 0.10 },
  },
});

/** يرشّح القيمة إلى [0, 1] أو null إن لم تعد رقمية. */
function clamp01(x) {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
}

/**
 * وزن مستقر من مصدرين: تجاوز السياسة يُحكَم بحدوده، والقيمة الغريبة
 * (نص عشوائي أو سالب أو فراغ) لا تزيح قيمتها من الافتراضي — كما تفعل
 * قواعد الإجازات مع القيم الغريبة. مجموع صفرٍ أو أقل يعيد الافتراضي كله:
 * أوزان وضعيفة لا تلغي المقياس.
 */
function resolveWeights(override = null) {
  const insert = override && typeof override === 'object' ? override : {};
  const merged = {};
  for (const [key, def] of Object.entries(SCORE_DEFAULTS.weights)) {
    const raw = insert[key];
    if (raw == null) { merged[key] = def; continue; } // المفتاح الخالي فراغ سياسة لا صفر مرايا
    const n = Number(raw);
    merged[key] = Number.isFinite(n) && n >= 0 ? Math.min(100, n) : def;
  }
  const sum = Object.values(merged).reduce((acc, w) => acc + w, 0);
  return sum > 0 ? merged : { ...SCORE_DEFAULTS.weights };
}

/** الأوزان الحيّة: افتراضي الجدول ← تجاوز سياسة `score.weights`. */
function scoreWeights() {
  return resolveWeights(settings.policy('score.weights', null));
}

/**
 * عامل النشاط: الرسائل الموزونة في اليوم النشط مقاسة بالمرآة اليومية.
 * صفر رسائل أو صفر أيام نشطة → صفر بلا استثناء.
 */
function activityScore(raw, weight, bench) {
  const activeDays = Math.max(0, Number(raw && raw.activeDays) || 0);
  const weighted = Math.max(0, Number(raw && raw.weightedMessages) || 0);
  if (activeDays === 0 || weighted === 0) return { value: 0, used: weight > 0 };
  return { value: clamp01(weighted / (bench.messagesPerActiveDay * activeDays)), used: weight > 0 };
}

/**
 * عامل الإنتاجية: التكتات لفريق الدعم وإجراءات الإشراف لفريق الإشراف.
 * الفريق العام يُقاس على سقف الدعم البديل (0.5 يومياً).
 */
function productivityScore(raw, team, weight, bench, days) {
  const perDay = team === 'moderation' ? bench.actionsPerDay.moderation
    : team === 'support' ? bench.ticketsPerDay.support : bench.ticketsPerDay.other;
  const count = team === 'moderation'
    ? Math.max(0, Number(raw && raw.actions) || 0)
    : Math.max(0, Number(raw && raw.tickets) || 0);
  return { value: clamp01(count / (perDay * days)), used: weight > 0 };
}

/**
 * عامل الجودة بمصدريه: تقييم العملاء (نجوم 1–5، ثلاثٌ متوسطة تعود صفراً)
 * أولى، وإلا تقييم المشرف (5–25) — وتدرج خطي إلى [0, 1]. بلا أي شاهد
 * يُستبعد العامل من التطبيع (لا يُعاقب على مجهول لا سبيل لمعرفته).
 */
function ratingScore(raw, staff, weight) {
  const avg = raw && raw.avgRating != null ? Number(raw.avgRating) : null;
  const hasCustomer = avg !== null && Number.isFinite(avg) && Number(raw.ratingCount) > 0;
  if (hasCustomer) return { value: clamp01((avg - 3) / 2), source: 'customer', used: weight > 0 };
  const supervisor = Number(staff && staff.supervisor_rating);
  if (Number.isFinite(supervisor) && supervisor > 0) {
    return { value: clamp01((supervisor - 5) / 20), source: 'supervisor', used: weight > 0 };
  }
  return { value: null, source: null, used: false };
}

/**
 * عامل السرعة بمصدريه: عمود سرعة الاستجابة (5–25) أولى — رأي المشرف
 * — وإلا وسط مدة التكتات بالدقائق: صفر دقيقة = 1، وعند نقطة الصفر
 * (60 دقيقة) صفر. وإن لم يوجد أي شاهد فاستُبعد من التطبيع.
 */
function speedScore(raw, staff, weight, bench) {
  const rs = Number(staff && staff.response_speed);
  if (Number.isFinite(rs) && rs > 0) {
    return { value: clamp01((rs - 5) / 20), source: 'response_speed', used: weight > 0 };
  }
  const minutes = raw && raw.avgDuration != null ? Number(raw.avgDuration) : null;
  if (minutes !== null && Number.isFinite(minutes) && minutes >= 0) {
    return { value: clamp01(1 - minutes / bench.durationZeroMinutes), source: 'duration', used: weight > 0 };
  }
  return { value: null, source: null, used: false };
}

/**
 * عامل الانضباط: كل إنذار أو ملاحظة سلبية يخصم من العامل مباشرة. غياب
 * المخالفة شاهدٌ على الانضباط الكامل — عكس عاملَي الجودة والسرعة
 * اللذين يُستبعدان عند غياب الشاهد.
 */
function disciplineScore(raw, weight, bench) {
  const warnings = Math.max(0, Number(raw && raw.warnings) || 0);
  const negativeNotes = Math.max(0, Number(raw && raw.negativeNotes) || 0);
  const deficit = warnings * bench.penalties.warning + negativeNotes * bench.penalties.negativeNote;
  return { value: clamp01(1 - deficit), used: weight > 0 };
}

/**
 * الحصيلة — دالة نقية بلا تبعية وقت تشغيل إلا قراءة سياسة الأوزان:
 *
 * @param {object} raw  صف reports.getRaw بقيمه: weightedMessages،
 *                      activeDays، tickets، actions، avgRating،
 *                      ratingCount، avgDuration، warnings، negativeNotes
 * @param {object} staff صف staff_members: team، supervisor_rating،
 *                      response_speed (اختيارية الدلالة)
 * @param {object} opts { weights: تجاوز اختياري للأوزان، windowDays: N بالأيام }
 * @returns {{score: number, parts: object, weights: object, evidence: object}}
 */
function computeScore(raw, staff = {}, opts = {}) {
  const weights = opts.weights ? resolveWeights(opts.weights) : scoreWeights();
  const bench = SCORE_DEFAULTS.benchmarks;
  const days = Math.max(1, Math.trunc(Number(opts.windowDays) || 30));
  const team = staff.team || 'support';

  const parts = {
    activity: activityScore(raw, weights.activity, bench),
    productivity: productivityScore(raw, team, weights.productivity, bench, days),
    rating: ratingScore(raw, staff, weights.rating),
    speed: speedScore(raw, staff, weights.speed, bench),
    discipline: disciplineScore(raw, weights.discipline, bench),
  };

  // التطبيع الأساسي: العامل بلا شاهد (الجودة/السرعة) يُقصى معه وزنه،
  // فيُطبَّع الباقي على مجموع أوزانه المعتمدة — فيبقى الرقم عادلاً.
  let weightedSum = 0;
  let weightSum = 0;
  for (const [name, part] of Object.entries(parts)) if (part.used && part.value !== null) {
    weightedSum += weights[name] * part.value;
    weightSum += weights[name];
  }
  const score = weightSum > 0 ? (weightedSum / weightSum) * 100 : 0;

  return {
    score: Math.round(score * 10) / 10,
    parts: Object.fromEntries(Object.entries(parts).map(([name, p]) => [name, p.value])),
    weights,
    evidence: {
      rating: parts.rating.source,
      speed: parts.speed.source,
      dropped: [ // العوامل المستبعدة من التطبيع لغياب شاهدها (تُعرض في التقييمات)
        ...['rating', 'speed'].filter(name => parts[name].value === null),
      ],
    },
  };
}

module.exports = { SCORE_DEFAULTS, resolveWeights, scoreWeights, computeScore };
