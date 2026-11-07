'use strict';
/**
 * طبقة قواعد الترقية — عتبات الترقية ونمط بوابتها بين الثوابت والسياسات (برف 04-contracts).
 *
 * كل ما يقرأ أهلية الترقية يمرّ من هنا: `ruleFor` يركّب قاعدة الرتبة الأساسية
 * من ثوابت (SUPPORT_PROMOTIONS / MOD_PROMOTIONS / POINTS_THRESHOLDS) مع
 * تجاوزات سياسة `promotion.rule.<team>.<fromRank>` — فالأوضاع بيانات لا شيفرة،
 * وتعديله من /setup يعمل في البوت الحيّ بلا إعادة تشغيل (كاش الإعدادات
 * تُبطل عند كل كتابة، وقراءة الترقية القادمة ترى القيمة الجديدة).
 *
 * القاعدة هنا: التجاوز الذي يخرج عن حدوده تُرفض به كل قيم الدفعة — من دون
 * تخفيض صامت كما في absenceDays. يأتي الضبط من شاشة المشرف، فيه الخطأ
 * يُعرض ظاهراً بدل رقم منقوص في الدفتر لا أحد يعرف سببه.
 */

const settings = require('./settings');
const audit = require('./audit');
const { SUPPORT_PROMOTIONS, MOD_PROMOTIONS, POINTS_THRESHOLDS } = require('../constants');

/** قيم النمط المسموحة: الافتراضي points يُبقي السلوك الحالي سليماً. */
const MODES = Object.freeze(['points', 'score', 'both']);
const BOTH_LOGICS = Object.freeze(['all', 'any']);
const MODE_KEY = 'promotion.mode';
const BOTH_LOGIC_KEY = 'promotion.bothLogic';

/** عتبة الدرجة البديلة حين لا تحدد سياسة شيء — 70: أداء فوق المتوسط المركّب. */
const DEFAULT_SCORE_THRESHOLD = 70;

/** حدود كل حقل قابل للتجاوز (برف 04-contracts). المفاتيح خارجها تُرفض. */
const BOUNDS = Object.freeze({
  pointsThreshold: { min: 1, max: 10000, integer: true },
  scoreThreshold: { min: 1, max: 100, integer: true },
  months: { min: 0, max: 36, integer: true },
  actions: { min: 0, max: 1000, integer: true },
  minMessages: { min: 0, max: 5000, integer: true },
  // الحد الأعلى الحقيقي نافذة الرتبة بعد الدمج — يُفحص بعد الدمج:
  minActiveDays: { min: 0, max: 365, integer: true },
  maxWarnings: { min: 0, max: 10, integer: true },
  rating: { min: 1, max: 5, integer: false },
  windowDays: { min: 7, max: 365, integer: true },
  approvals: { min: 1, max: 3, integer: true },
});

const RULE_SOURCES = { support: SUPPORT_PROMOTIONS, moderation: MOD_PROMOTIONS };

/** قاعدة الرتبة الأساسية من الثوابت (نفس المنطق في promotions.nextPromotion). */
function baseRule(team, fromRank) {
  return (RULE_SOURCES[team] || []).find(r => r.from === fromRank) || null;
}

/**
 * قاعدة الرتبة المركّبة: الثوابت أولاً ثم التجاوز الرقمي الصالح فقط.
 * ميثاق الرتبة (من/إلى/الموافقات وغيرها) يبقى من الثوابت دائماً، والتجاوز
 * يعيّن الأرقام لا شكل المسار. بلا قاعدة أساسية يُعاد null — الترقية
 * اليدوية لا تدخل هذا النظام أصلاً.
 *
 * @returns {object|null} {months, rating, ..., pointsThreshold, scoreThreshold, team, fromRank}
 */
function ruleFor(team, fromRank) {
  const base = baseRule(team, fromRank);
  if (!base) return null;
  const override = settings.policy(`promotion.rule.${team}.${fromRank}`, null);
  const clean = {};
  if (override && typeof override === 'object') {
    for (const [key, value] of Object.entries(override)) {
      if (!(key in BOUNDS)) continue; // حقل غير مُسمّى يُهمل فلا يفسد القاعدة
      const n = Number(value);
      if (Number.isFinite(n) && n >= BOUNDS[key].min && n <= BOUNDS[key].max) clean[key] = n;
    }
  }
  const pointsThreshold = POINTS_THRESHOLDS[team]?.[fromRank] ?? null;
  return {
    ...base,
    ...clean,
    team,
    fromRank: base.from,
    // عتبتا التجاوز تسبقان حقلَي الجدولة: لا تُلغى بدمج لاحق كي لا يمر التجاوز
    pointsThreshold: clean.pointsThreshold ?? pointsThreshold,
    scoreThreshold: clean.scoreThreshold ?? DEFAULT_SCORE_THRESHOLD,
  };
}

/**
 * التحقق من قيمة حقل واحد: رقم ضمن حدود النطاق، وعدد صحيح حيث يُشترط.
 * يجمع الأخطاء ولا يكتمها — كل خطأ معرّف بالمفتاح يُعرض في واجهة الضبط.
 */
function validateField(key, value, errors) {
  const bound = BOUNDS[key];
  const label = `الحقل ${key}`;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push(`${label} يجب أن يكون رقماً`);
    return;
  }
  if (bound.integer && !Number.isInteger(value)) {
    errors.push(`${label} يجب أن يكون عدداً صحيحاً (وصل ${value})`);
    return;
  }
  if (value < bound.min || value > bound.max) {
    errors.push(`${label} خارج الحدود ${bound.min}–${bound.max} (وصل ${value})`);
  }
}

/** قواعد الرتبة تنتهي عند مساري الدعم والإشراف: الإدارة العامة ترقية يدوية. */
function hasAscensionPath(team, fromRank) {
  return baseRule(team, fromRank) != null;
}

/**
 * ضبط قاعدة رتبة من واجهة المشرف: يتحقق أولاً بكل حقول الدفعة ثم يكتب
 * المجموعة دفعة واحدة — لا كتابة جزئية تنصف القاعدة وتشوّهها.
 *
 * @returns {{ok: boolean, errors?: string[], rule?: object}}
 */
function setRule(team, fromRank, partial, actorId = null) {
  if (!hasAscensionPath(team, fromRank)) {
    return { ok: false, errors: [`لا مسار ترقية تلقائي للرتبة ${fromRank} في فريق ${team}`] };
  }
  if (!partial || typeof partial !== 'object' || Array.isArray(partial)) {
    return { ok: false, errors: ['التجاوز يجب أن يكون كائناً بحقول محدودة'] };
  }
  const errors = [];
  for (const [key, value] of Object.entries(partial)) {
    if (!(key in BOUNDS)) {
      errors.push(`حقل غير قابل للضبط: ${key}`);
      continue;
    }
    validateField(key, value, errors);
  }
  const merged = ruleFor(team, fromRank);
  if (partial.minActiveDays != null && merged) {
    const maxDays = partial.windowDays ?? merged.windowDays;
    const n = Number(partial.minActiveDays);
    if (Number.isFinite(n) && Number.isInteger(n) && n > maxDays) {
      errors.push(`minActiveDays لا يصح أن يتجاوز نافذة ${maxDays} يوماً`);
    }
  }
  if (errors.length) return { ok: false, errors };

  settings.setPolicy(`promotion.rule.${team}.${fromRank}`, partial);
  audit.record({
    action: 'promotion_rules_updated',
    actorId,
    targetId: fromRank,
    details: { team, fields: Object.keys(partial) },
  });
  return { ok: true, rule: ruleFor(team, fromRank) };
}

/** إلغاء تجاوز الرتبة بالكامل — تعود القاعدة إلى الثوابت. */
function resetRule(team, fromRank, actorId = null) {
  if (!hasAscensionPath(team, fromRank)) {
    return { ok: false, errors: [`لا مسار ترقية تلقائي للرتبة ${fromRank} في فريق ${team}`] };
  }
  const key = `promotion.rule.${team}.${fromRank}`;
  const existed = settings.policy(key, null) != null;
  settings.resetPolicy(key);
  if (existed) {
    audit.record({
      action: 'promotion_rules_reset',
      actorId,
      targetId: fromRank,
      details: { team },
    });
  }
  return { ok: true, rule: ruleFor(team, fromRank) };
}

/**
 * نمط البوابة: نقاط فقط (الافتراضي، السلوك الحالي)، درجة فقط، أو الاثنين.
 * القيمة خارج القائمة تعود للافتراضي — سياسة تالفة لا تعطّل الترقية كلها.
 */
function getMode() {
  const mode = settings.policy(MODE_KEY, 'points');
  return MODES.includes(mode) ? mode : 'points';
}

function setMode(mode, actorId = null) {
  if (!MODES.includes(mode)) {
    return { ok: false, errors: [`النمط أحد: ${MODES.join(' / ')} (وصل ${mode})`] };
  }
  const previous = settings.policy(MODE_KEY, 'points');
  if (previous === mode) return { ok: true, mode, unchanged: true };
  settings.setPolicy(MODE_KEY, mode);
  audit.record({
    action: 'promotion_mode_updated',
    actorId,
    details: { mode, previous },
  });
  return { ok: true, mode };
}

/** منطق الدمج في نمط both: شروط الاثنين معاً (all) أو يكفي أحدهما (any). */
function getBothLogic() {
  const logic = settings.policy(BOTH_LOGIC_KEY, 'all');
  return BOTH_LOGICS.includes(logic) ? logic : 'all';
}

function setBothLogic(logic, actorId = null) {
  if (!BOTH_LOGICS.includes(logic)) {
    return { ok: false, errors: [`المنطق أحد: ${BOTH_LOGICS.join(' / ')} (وصل ${logic})`] };
  }
  const previous = settings.policy(BOTH_LOGIC_KEY, 'all');
  if (previous === logic) return { ok: true, logic, unchanged: true };
  settings.setPolicy(BOTH_LOGIC_KEY, logic);
  audit.record({
    action: 'promotion_mode_updated', // نفس الباب: السياسة مرتبطة بالنمط
    actorId,
    details: { bothLogic: logic },
  });
  return { ok: true, logic };
}

module.exports = {
  MODES, BOTH_LOGICS, BOUNDS, DEFAULT_SCORE_THRESHOLD, RULE_SOURCES, hasAscensionPath,
  baseRule, ruleFor, setRule, resetRule, getMode, setMode, getBothLogic, setBothLogic,
};
