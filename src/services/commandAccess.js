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
  if (command.adminOnly) return context.admin ? null : 'الإعداد متاح لمن يملك صلاحية **Administrator** فقط.';
  if (command.serverManagerOnly && !context.serverManager) return 'هذا الأمر متاح لـ **Server Manager** أو **General Manager** الحالي فقط.';
  const level = context.level || (context.serverManager ? LEVELS.GENERAL_MANAGER : 0);
  if (level < (command.level || 0)) return `هذا الأمر متاح لـ **${LEVEL_LABELS[command.level] || 'إدارة أعلى'}**.`;
  if (command.maxLevel && level > command.maxLevel) return 'هذا الأمر غير متاح لرتبتك.';
  if (command.team && context.team !== command.team) return `هذا الأمر خاص بـ **${TEAMS[command.team]}**.`;
  if (context.suspended && !SUSPENDED_ALLOWED.has(command.data.name)) return 'حسابك الإداري موقوف حالياً. يمكنك مراجعة سجلك من /my-record.';
  return null;
}

module.exports = { accessContext, commandAccessError };
