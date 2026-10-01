'use strict';
const { PermissionFlagsBits } = require('discord.js');
const { LEVELS, TEAMS } = require('../constants');
const { LEVEL_LABELS, isServerManager } = require('./permissions');
const staff = require('./staff');

const SUSPENDED_ALLOWED = new Set(['my-record', 'my-performance', 'faq', 'faq-list', 'resign', 'help', 'me', 'my-tasks']);

/** نفس قواعد الوصول للأوامر المكتوبة واختصارات الواجهة. */
function accessContext(i) {
  return {
    level: i.staffLevel || 0,
    team: i.staffInfo?.team,
    admin: !!i.member?.permissions?.has(PermissionFlagsBits.Administrator),
    serverManager: isServerManager(i.member),
    suspended: staff.get(i.user.id)?.status === 'suspended',
  };
}

function commandAccessError(command, context) {
  if (!command) return 'هذا الإجراء لم يعد متاحاً. افتح /help لاختيار إجراء آخر.';
  if (command.adminOnly && !context.admin) return 'الإعداد متاح لمن يملك صلاحية **Administrator** فقط.';
  if (command.adminOnly) return null;
  if (command.serverManagerOnly && !context.serverManager) return 'هذا الأمر متاح لـ **Server Manager** أو **General Manager** الحالي فقط.';
  const level = context.level || (context.serverManager ? LEVELS.GENERAL_MANAGER : 0);
  if (level < (command.level || 0)) return `هذا الأمر متاح لـ **${LEVEL_LABELS[command.level] || 'إدارة أعلى'}**.`;
  // `maxLevel: 0` تعني «لا أحد دون GM». الفحص القديم `command.maxLevel &&` كان
  // يبتلع الصفر لأنه falsy — فيحصل ذلك الأمر بلا حدّ أعلى إطلاقاً.
  if (command.maxLevel != null && level > command.maxLevel) return 'هذا الأمر غير متاح لرتبتك.';
  if (command.team && context.team !== command.team) return `هذا الأمر خاص بـ **${TEAMS[command.team]}**.`;
  if (context.suspended && !SUSPENDED_ALLOWED.has(command.data.name)) return 'حسابك الإداري موقوف حالياً. يمكنك مراجعة سجلك من /my-record.';
  return null;
}

/**
 * قائمة البادئات المسموح بها لموقوف — مصدر واحد بدل regex في componentDispatch.
 * كل بادئة تكتب هنا يجب أن تُختبر: mutating جديد بلا اسم هنا = تسريب صلاحية.
 */
const SUSPENDED_ALLOWED_COMPONENT_PREFIXES = [
  'ticket:', 'modaction:', 'leave:modal', 'leave:extendmodal', 'promo:modal',
];

/**
 * نفس سياسة `commandAccessError` للمكوّنات، بلا نسخة ثانية من الفحوص.
 *
 * كان `componentDispatch` ينسخ adminOnly/level/team بنفسه، فنسي `maxLevel` —
 * وهو الخطأ نفسه الموثّق أعلاه: أمر له حدّ أعلى كان مقيَّداً على مسار الشرطة
 * Slash وغير مقيَّد على مسار المكوّن. النسخ هنا لا يتجاوز الفحص، بل يسقطه.
 *
 * `id` هو الاسم الذي يفحص به الإيقاف. للمكوّنات القائمة تُستبدل قائمة الأسماء
 * (SUSPENDED_ALLOWED) ببادئات (SUSPENDED_ALLOWED_COMPONENT_PREFIXES) لأن
 * customId يحمل معاملات بعد النقطتين ولا يمكن مطابقته باسم أمر. لذلك نمرّر
 * `suspended: false` إلى الدالة المشتركة ونطبّق البادئات هنا — وهو ما يجعل
 * هذا هو المصدر الوحيد للسياسة على المسارين.
 */
function componentAccessError(entry, context, id = '') {
  const name = String(id || '');
  const shape = entry ? { ...entry, data: { name } } : null;
  const denial = commandAccessError(shape, { ...context, suspended: false });
  if (denial) return denial;
  if (context.suspended && !SUSPENDED_ALLOWED_COMPONENT_PREFIXES.some(p => name.startsWith(p))) {
    return 'حسابك الإداري موقوف. يمكنك مراجعة /my-record.';
  }
  return null;
}

module.exports = { accessContext, commandAccessError, componentAccessError, SUSPENDED_ALLOWED, SUSPENDED_ALLOWED_COMPONENT_PREFIXES };
