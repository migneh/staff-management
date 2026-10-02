'use strict';
const settings = require('./settings');
const { LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS } = require('../constants');

const TEAM_RANKS = {
  support: SUPPORT_RANKS,
  moderation: MOD_RANKS,
  general_management: GENERAL_MANAGEMENT_RANKS,
};

/**
 * يحدد فريق ورتبة العضو من رتب الديسكورد (أعلى رتبة تفوز).
 * @returns {{team:string, rank:string, level:number, handlesTickets:boolean}|null}
 */
function resolveStaff(member) {
  if (!member?.roles?.cache) return null;
  let best = null;
  for (const [team, ranks] of Object.entries(TEAM_RANKS)) {
    for (let i = ranks.length - 1; i >= 0; i--) {
      const r = ranks[i];
      const roleId = settings.roleId(team, r.name);
      if (roleId && member.roles.cache.has(roleId)) {
        const cand = { team, rank: r.name, level: r.level, handlesTickets: !!r.handlesTickets, index: i };
        if (!best || cand.level > best.level) best = cand;
        break;
      }
    }
  }
  return best;
}

/**
 * Server Manager هو مالك السيرفر أو الرتبة التي يحددها /setup.
 * General Manager الحالي يملك نفس صلاحية تعيين الإدارة العامة.
 * لا نعتمد على اسم الرتبة حتى لا يتمكن أي عضو من انتحالها.
 */
function isServerManager(member) {
  if (!member) return false;
  if (member.id && member.guild?.ownerId && member.id === member.guild.ownerId) return true;
  const configuredRole = settings.governanceRoleId();
  if (configuredRole && member.roles?.cache?.has(configuredRole)) return true;
  const info = resolveStaff(member);
  return info?.team === 'general_management' && info.rank === 'General Manager';
}

function getLevel(member) {
  return resolveStaff(member)?.level ?? 0;
}

function hasLevel(member, level) {
  return getLevel(member) >= level || isServerManager(member);
}

function isBoss(member) { return getLevel(member) >= LEVELS.BOSS || isServerManager(member); }
function isManagement(member) { return getLevel(member) >= LEVELS.MANAGEMENT || isServerManager(member); }
function isSupervisor(member) { return getLevel(member) >= LEVELS.SUPERVISOR || isServerManager(member); }

function rankInfo(team, rankName) {
  return TEAM_RANKS[team]?.find(r => r.name === rankName) || null;
}

/**
 * بوابة تراتب الإجراءات: هل يُرفض تسجيل إجراء على الهدف؟
 *
 * القاعدة الأصلية كما هي: هدف أعلى من المنفّذ ⇒ رفض، هدف أدنى ⇒ سماح،
 * والمستويات تُقارن عبر سُلّم LEVELS أينما كان الطرفان. الاستثناء المعتمد
 * من صاحب المشروع: نفس الفريق + مستوى متساوٍ ⇒ يُنظر إلى الترتيب داخل
 * مصفوفة الفريق، فالرتبة الأعلى فعلاً (فهرس أكبر) تُجيز العمل على الأدنى —
 * فلا تُحجب أزواج التساوي داخل فريق واحد بعد الآن. الرتبة المتطابقة تبقى
 * مرفوضة، والمستوى الأدنى لا يصعد إلى الأعلى أبداً، والتساوي بين فريقين
 * مختلفين يبقى مرفوضاً. الرتبة غير المربوطة تُرفض كما كانت (إغلاق مقصود).
 *
 * هذه الدالة هي المصدر الوحيد للمقارنة؛ من يملك بوابة هدف يستدعيها هنا
 * ولا يعيد كتابة شرطها.
 *
 * @param {{team?:string, rank?:string, level?:number}} actor منفّذ الإجراء — من i.staffInfo مع مستوى i.staffLevel
 * @param {{team:string, rank:string}} target صف staff_members الخاص بالهدف
 * @returns {string|null} رسالة الرفض، أو null إذا كان الإجراء مسموحاً.
 */
function actionRankDenial(actor, target) {
  const targetRank = rankInfo(target.team, target.rank);
  if (!targetRank) return `❌ رتبة **${target.rank}** غير مربوطة بإعدادات البوت. شغّل **/sync-staff** أولاً.`;
  const denial = `❌ لا يمكنك تسجيل إجراء على **${target.rank}** — رتبتك أو ما فوقها. القاعدة: لا يُسجَّل إجراء على من هو في رتبتك أو أعلى.`;
  const actorLevel = actor?.level || 0;
  if (targetRank.level < actorLevel) return null;   // هدف أدنى ⇒ مسموح — كما كان.
  if (targetRank.level > actorLevel) return denial; // هدف أعلى ⇒ مرفوض مطلقاً — كما كان.
  // المستوى متساوٍ: بين فريقين يبقى الرفض، وداخل الفريق يحكم الترتيب.
  if (actor?.team && actor.team === target.team) {
    const ladder = TEAM_RANKS[target.team];
    const actorIndex = ladder.findIndex(r => r.name === actor.rank);
    const targetIndex = ladder.findIndex(r => r.name === target.rank);
    if (targetIndex >= 0 && actorIndex > targetIndex) return null; // أعلى فعلاً داخل الفريق
  }
  return denial;
}

function levelName(level) {
  return Object.keys(LEVELS).find(k => LEVELS[k] === level) || 'NONE';
}

const LEVEL_LABELS = {
  [LEVELS.STAFF]: 'كل الإداريين',
  [LEVELS.SENIOR]: 'الرتب المتقدمة فأعلى',
  [LEVELS.SUPERVISOR]: 'المشرفين فأعلى',
  [LEVELS.MANAGEMENT]: 'الإدارة العليا',
  [LEVELS.BOSS]: 'Boss فأعلى',
  [LEVELS.GENERAL_MANAGEMENT]: 'الإدارة العامة فأعلى',
  [LEVELS.GENERAL_MANAGER]: 'General Manager / Server Manager',
};

module.exports = {
  resolveStaff, getLevel, hasLevel, isBoss, isManagement, isSupervisor,
  isServerManager, rankInfo, actionRankDenial, levelName, LEVEL_LABELS, TEAM_RANKS,
};
