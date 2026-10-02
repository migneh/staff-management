'use strict';
/**
 * إعدادات السيرفر (الرتب والقنوات) — تُخزن في قاعدة البيانات وتُضبط عبر /setup.
 * config.json يبقى مصدراً احتياطياً (اختياري).
 */
const { getDb } = require('../database');
const fileConfig = require('../config');
const logger = require('../logger').log('settings');
const {
  SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, LEAVE_GLOBAL, LEAVE_RULES, RESIGNATION_GLOBAL, VACATION_ROLE_TIMING,
  CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS, CHANNEL_META, SCORE_WEIGHTS,
} = require('../constants');

let cache = null;

/**
 * قراءة آمنة لقيم settings: صف تالف واحد يجب ألا يُسقط البوت كله.
 * القيمة غير الصالحة تُتجاهل وتُسجَّل، ويستمر كل ما عداها.
 */
function safeParse(key, value) {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch (e) {
    logger.error(`قيمة تالفة في الإعدادات — تم تجاهل "${key}": ${e.message}`);
    return { ok: false };
  }
}

function ensureTable() {
  getDb().exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')))`);
}

function load() {
  if (cache) return cache;
  ensureTable();
  const rows = getDb().prepare('SELECT key, value FROM settings').all();
  const kv = {};
  for (const row of rows) {
    const parsed = safeParse(row.key, row.value);
    if (parsed.ok) kv[row.key] = parsed.value;
  }
  const fileRoles = fileConfig.roles || {};
  cache = {
    policies: Object.fromEntries(Object.entries(kv).filter(([k]) => k.startsWith('policy.')).map(([k, v]) => [k.slice(7), v])),
    roles: {
      support: { ...(fileRoles.support || {}) },
      moderation: { ...(fileRoles.moderation || {}) },
      general_management: { ...(fileRoles.general_management || {}) },
      governance: { ...(fileRoles.governance || {}) },
      system: { ...(fileRoles.system || {}) },
    },
    channels: { ...(fileConfig.channels || {}) },
    activityChannels: { ticket: [], staff: [], moderation: [], ...(fileConfig.activityChannels || {}) },
    ticketLogBotId: fileConfig.ticketLogBotId || null,
  };
  for (const [k, v] of Object.entries(kv)) {
    const [group, ...rest] = k.split('.');
    const name = rest.join('.');
    if (group === 'role') {
      const [team, rank] = name.split('/');
      cache.roles[team] ||= {};
      cache.roles[team][rank] = v;
    } else if (group === 'channel') cache.channels[name] = v;
    else if (group === 'activity') cache.activityChannels[name] = v;
    else if (group === 'scoreWeights') { cache.scoreWeights ||= {}; cache.scoreWeights[name] = v; }
    else if (group === 'featureToggles') {
      // الصف كان يُكتب ثم يُسقَط عند القراءة: لا فرع في load يطابق 'featureToggles'
      // فلا تُحفظ أي حالة أصلاً، وكل مفتاح كان يُقرأ افتراضه دائماً.
      if (v && typeof v === 'object' && !Array.isArray(v)) cache.featureToggles = v;
    }
    else if (group === 'ticketLogBotId') cache.ticketLogBotId = v;
  }
  // تنظيف القيم الوهمية
  for (const t of Object.keys(cache.roles)) for (const k of Object.keys(cache.roles[t])) if (cache.roles[t][k] === 'ROLE_ID') delete cache.roles[t][k];
  for (const k of Object.keys(cache.channels)) if (['CHANNEL_ID', 'OPTIONAL_CHANNEL_ID'].includes(cache.channels[k])) delete cache.channels[k];
  for (const k of Object.keys(cache.activityChannels)) if (!Array.isArray(cache.activityChannels[k])) delete cache.activityChannels[k];
  for (const k of ['ticket', 'staff', 'moderation']) cache.activityChannels[k] = (cache.activityChannels[k] || []).filter(x => /^\d+$/.test(x));
  return cache;
}

function set(key, value) {
  ensureTable();
  getDb().prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(key, JSON.stringify(value));
  cache = null;
}

function setRole(team, rank, roleId) { set(`role.${team}/${rank}`, roleId); }
function setGovernanceRole(roleId) { setRole('governance', 'Server Manager', roleId); }
function setChannel(name, channelId) { set(`channel.${name}`, channelId); }
function setActivity(type, ids) { set(`activity.${type}`, ids); }
function setTicketLogBotId(botId) { set('ticketLogBotId', botId || null); }

// ===== ميزات قابلة للتبديل =====
/**
 * مفاتيح الميزات المتاحة، والتعليق يذكر القارئ الفعلي لكل مفتاح.
 * الهدف أن يصبح «مفتاح بلا قارئ» خطأً مرئياً عند المراجعة: مفتاح لا يقرأه
 * شيء هو مفتاح يَعِد المشغّل في /config بإيقاف مهمة تستمر (الخطأ الذي بُني هنا:
 * `autoTicketPoints` بقي بعد حذف نظام النقاط، وثلاثة مفاتيح للمجدول كانت
 * معروضة للإيقاف بينما المهام تتجاهلها تماماً).
 *
 * الافتراضي لكل مفتاح: true — لا يبدأ شيء معطّلاً بلا سبب.
 */
const FEATURE_TOGGLES_DEFAULTS = Object.freeze({
   weeklyReports: true,           // يُقرأ في: src/scheduler.js (المهمة weekly-report)
   monthlyReports: true,          // يُقرأ في: src/scheduler.js (المهمة monthly-report)
   activityTracking: true,        // يُقرأ في: src/services/activity.js (البوابة الوحيدة لكتابة activity_logs)
   punishmentSystem: true,        // يُقرأ في: src/commands/punishments.js (/warn, /note)
   detailedSystemStatus: true,    // يُقرأ في: src/commands/system.js (الوضع التفصيلي)
   promotionProgress: true,       // يُقرأ في: src/commands/promotion-progress.js
   myStatusCommand: true,         // يُقرأ في: src/commands/my-status.js
   auditExport: true,             // يُقرأ في: src/commands/staff-logs.js
   autoBackups: true,             // يُقرأ في: src/scheduler.js (المهمة backup)
});

/** المفاتيح المتاحة فعلياً — مصدر واحد تبني منه /config قائمته. */
const FEATURE_TOGGLES = Object.freeze({ ...FEATURE_TOGGLES_DEFAULTS });

/** هل هذا مفتاح ميزة معروف؟ يُستخدم لمنع تخزين مفاتيح ميتة. */
function isFeatureToggle(key) {
  return Object.hasOwn(FEATURE_TOGGLES_DEFAULTS, key);
}

function featureToggle(key) {
  if (!isFeatureToggle(key)) return undefined;
  const toggles = load().featureToggles || {};
  return toggles[key] !== undefined ? !!toggles[key] : FEATURE_TOGGLES_DEFAULTS[key];
}

/**
 * حفظ حالة ميزة. أي مفتاح غير معروف يُرفض بخطأ صريح بدل أن يُخزَّن صامتاً
 * ويظهر للمشغّل كأنه مُفعَّل، ونُنظّف المفاتيح الميتة الموروثة
 * (مثل autoTicketPoints الباقية من نظام النقاط المحذوف).
 */
function setFeatureToggle(key, value) {
  if (!isFeatureToggle(key)) throw new Error(`مفتاح ميزة غير معروف: ${String(key)}`);
  const stored = load().featureToggles || {};
  const toggles = {};
  for (const k of Object.keys(stored)) if (isFeatureToggle(k)) toggles[k] = stored[k];
  toggles[key] = !!value;
  set('featureToggles', toggles);
  return toggles[key];
}

function resetFeatureToggles() {
  ensureTable();
  getDb().prepare('DELETE FROM settings WHERE key = ?').run('featureToggles');
  cache = null;
}

// ===== أوزان Score (تُضبط من /score-weights وتُقصّ على ثوابت constants) =====
/** أوزان فريق مع Defaults من constants، مدمجةً مع أي تعديل محفوظ. */
function scoreWeights(team) {
  const base = SCORE_WEIGHTS[team] || {};
  const custom = load().scoreWeights?.[team];
  return custom && typeof custom === 'object' ? { ...base, ...custom } : { ...base };
}

/**
 * حفظ أوزان فريق. مجموع الأوزان يجب أن يساوي 100 وإلا فالترتيب غير قابل للمقارنة —
 * نرفض بدل أن نخزن مجموعة تجعل المقارنة بين فريقين بلا معنى.
 * @returns {{ok:boolean, error?:string, weights?:object}}
 */
function setScoreWeights(team, values) {
  const base = SCORE_WEIGHTS[team];
  if (!base) return { ok: false, error: `فريق غير معروف: ${team}` };

  const keys = Object.keys(base);
  const weights = {};
  for (const k of keys) {
    const v = Number(values?.[k]);
    if (!Number.isFinite(v) || v < 0) return { ok: false, error: `وزن غير صالح لـ ${k}` };
    weights[k] = v;
  }
  // أي مفتاح زائد لا يغيّر المقام — نرفضه صراحةً بدل تجاهله بصمت.
  const extra = Object.keys(values || {}).filter(k => !keys.includes(k));
  if (extra.length) return { ok: false, error: `مفاتيح غير معروفة: ${extra.join(', ')}` };

  const total = keys.reduce((sum, k) => sum + weights[k], 0);
  if (Math.round(total) !== 100) return { ok: false, error: `مجموع الأوزان ${total} — يجب أن يساوي 100` };

  set(`scoreWeights.${team}`, weights);
  return { ok: true, weights };
}

// ===== سياسات الطلبات (تُضبط من /setup وتُفضَّل على config.json) =====
/**
 * قراءة سياسة واحدة: مخزَّنة مُرمَّزة (JSON) تحت `policy.<key>`، و`load()` يعيدها محلَّلة.
 * غياب المفتاح يُعيد `fallback`؛ القيمة المخزَّنة (بما فيها 0 و[] وnull) تُقدَّم كما هي.
 */
function policy(key, fallback) {
  const value = load().policies[key];
  return value !== undefined ? value : fallback;
}

function setPolicy(key, value) {
  set(`policy.${key}`, value);
}

function resetPolicy(key) {
  ensureTable();
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(`policy.${key}`);
  cache = null;
}

/** قواعد الإجازات: الافتراضي ← config.json ← إعداد /setup */
function leavePolicy(type = null) {
  const base = { ...LEAVE_GLOBAL, ...(fileConfig.leave || {}) };
  const rules = Object.fromEntries(Object.entries(LEAVE_RULES).map(([key, rule]) => [key, { ...rule }]));
  for (const [type2, rule] of Object.entries(rules)) {
    const override = policy(`leaveType.${type2}`, {});
    if (override && typeof override === 'object') Object.assign(rule, override);
  }
  const overrides = {
    maxDays: policy('leaveMaxDays'), maxConcurrent: policy('leaveMaxConcurrent'),
    pendingExpireDays: policy('leavePendingExpireDays'), maxDaysPer90: policy('leaveMaxDaysPer90'),
    vacationRoleTiming: policy('vacationRoleTiming', base.vacationRoleTiming || 'at_start'),
    annualDays: policy('leaveAnnualDays'), teamCover: policy('leaveTeamCover'),
    enforceTeamCover: policy('leaveEnforceTeamCover'), pendingEscalateHours: policy('leavePendingEscalateHours'),
    workdayCounting: policy('leaveWorkdayCounting'), weeklyOff: policy('leaveWeeklyOff'),
  };
  for (const [k, v] of Object.entries(overrides)) if (v != null) base[k] = v;
  const result = type ? { ...base, ...(rules[type] || {}), rules } : { ...base, rules };
  result.maxDays = Number(result.maxDays) || LEAVE_GLOBAL.maxDays;
  result.maxConcurrent = Number(result.maxConcurrent) || LEAVE_GLOBAL.maxConcurrent;
  result.maxDaysPer90 = Number(result.maxDaysPer90) || LEAVE_GLOBAL.maxDaysPer90;
  result.pendingExpireDays = Number(result.pendingExpireDays) || LEAVE_GLOBAL.pendingExpireDays;
  result.minNoticeHours = Number(result.minNoticeHours || 0);
  result.annualDays = Math.max(0, Math.trunc(Number(result.annualDays) || 0));
  result.teamCover = Math.max(0, Math.trunc(Number(result.teamCover ?? LEAVE_GLOBAL.teamCover)));
  result.pendingEscalateHours = Math.max(0, Math.trunc(Number(result.pendingEscalateHours ?? LEAVE_GLOBAL.pendingEscalateHours)));
  result.enforceTeamCover = !!result.enforceTeamCover;
  result.workdayCounting = !!result.workdayCounting;
  result.weeklyOff = (Array.isArray(result.weeklyOff) ? result.weeklyOff : [])
    .map(Number).filter(day => Number.isInteger(day) && day >= 0 && day <= 6);
  result.weeklyOffDays = result.weeklyOff; // اسم موازٍ للوضوح في الواجهات
  return result;
}

/** قواعد الاستقالة */
function resignationPolicy() {
  const base = { ...RESIGNATION_GLOBAL, ...(fileConfig.resignation || {}) };
  const overrides = { noticeDays: policy('resignationNoticeDays'), pendingEscalateDays: policy('resignationEscalateDays') };
  for (const [k, v] of Object.entries(overrides)) if (v != null) base[k] = v;
  base.noticeDays = Number(base.noticeDays) || RESIGNATION_GLOBAL.noticeDays;
  base.pendingEscalateDays = Number(base.pendingEscalateDays) || RESIGNATION_GLOBAL.pendingEscalateDays;
  return base;
}

function roles() { return load().roles; }
function channels() { return load().channels; }
function activityChannels() { return load().activityChannels; }
function roleId(team, rank) { return load().roles[team]?.[rank] || null; }
function channelId(name) { return load().channels[name] || null; }
function ticketLogBotId() { return load().ticketLogBotId || null; }
function governanceRoleId() { return roleId('governance', 'Server Manager'); }
function vacationRoleId() { return roleId('system', 'in vacation'); }

/** حالة الإعداد: ما الذي ينقص */
function status() {
  const s = load();
  const missingRoles = [];
  for (const r of SUPPORT_RANKS) if (!s.roles.support[r.name]) missingRoles.push({ team: 'support', rank: r.name });
  for (const r of MOD_RANKS) if (!s.roles.moderation[r.name]) missingRoles.push({ team: 'moderation', rank: r.name });
  for (const r of GENERAL_MANAGEMENT_RANKS) if (!s.roles.general_management[r.name]) missingRoles.push({ team: 'general_management', rank: r.name });
  // قناة سجل التكتات الخارجية اختيارية، لأنها قناة يملكها/ينشئها بوت آخر.
  const missingChannels = CHANNEL_KEYS.filter(c => !s.channels[c]);
  const rolesDone = SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length - missingRoles.length;
  return {
    missingRoles, missingChannels,
    rolesDone, rolesTotal: SUPPORT_RANKS.length + MOD_RANKS.length + GENERAL_MANAGEMENT_RANKS.length,
    channelsDone: CHANNEL_KEYS.length - missingChannels.length, channelsTotal: CHANNEL_KEYS.length,
    activity: s.activityChannels,
    ticketSourceConfigured: !!s.channels['ticket-source-logs'],
    ticketLogBotId: s.ticketLogBotId,
    governanceConfigured: !!governanceRoleId(),
    vacationRoleConfigured: !!vacationRoleId(),
    leavePolicy: leavePolicy(),
    resignationPolicy: resignationPolicy(),
    complete: missingRoles.length === 0 && missingChannels.length === 0,
    anyRole: rolesDone > 0,
  };
}

module.exports = {
  load, set, setRole, setGovernanceRole, setChannel, setActivity, setTicketLogBotId,
  roles, channels, activityChannels, roleId, channelId, ticketLogBotId, governanceRoleId, vacationRoleId, status,
  policy, setPolicy, resetPolicy, leavePolicy, resignationPolicy, VACATION_ROLE_TIMING,
  CHANNEL_KEYS, OPTIONAL_CHANNEL_KEYS, CHANNEL_META,
  featureToggle, setFeatureToggle, resetFeatureToggles, FEATURE_TOGGLES, FEATURE_TOGGLES_DEFAULTS, isFeatureToggle,
  scoreWeights, setScoreWeights,
};
