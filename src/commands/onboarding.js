'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const tasks = require('../services/tasks');
const staffService = require('../services/staff');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('onboarding').setDescription('إدارة ومراقبة نظام التأهيل للموظفين الجدد')
        .addSubcommand(sub =>
          sub.setName('assign')
            .setDescription('تعيين مرشد لموظف جديد')
            .addUserOption(o => o.setName('user').setDescription('الموظف الجديد').setRequired(true))
            .addUserOption(o => o.setName('mentor').setDescription('المرشد').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('remove')
            .setDescription('إزالة المرشد من الموظف')
            .addUserOption(o => o.setName('user').setDescription('الموظف').setRequired(true))
        )
        .addSubcommand(sub =>
          sub.setName('dashboard')
            .setDescription('لوحة تحكم التأهيل')
            .addUserOption(o => o.setName('user').setDescription('الموظف (للإدارة فقط)'))
        )
        .addSubcommand(sub =>
          sub.setName('my-progress')
            .setDescription('عرض تقدم تأهيلك الشخصي')
        ),
      level: LEVELS.STAFF,
      async execute(i) {
        const subcommand = i.options.getSubcommand();
        
        switch (subcommand) {
          case 'assign':
            return await assignMentor(i);
          case 'remove':
            return await removeMentor(i);
          case 'dashboard':
            return await onboardingDashboard(i);
          case 'my-progress':
            return await myOnboardingProgress(i);
          default:
            return replyEphemeral(i, '❌ أمر غير معروف.', COLORS.danger);
        }
      }
    },
  ],
  
  components: {
    'onboarding:complete': async (i, [id]) => {
      const task = tasks.complete(Number(id), i.user.id);
      if (!task) return replyEphemeral(i, '❌ المهمة غير موجودة أو ليست لك أو أُنجزت مسبقاً.', COLORS.danger);
      await i.update({ content: `✅ تم إتمام مهمة التأهيل **#${id}** - ${task.title}`, components: [] });
    }
  }
};

/**
 * تعيين مرشد لموظف جديد
 */
async function assignMentor(i) {
  const newUser = i.options.getUser('user');
  const mentorUser = i.options.getUser('mentor');
  
  // التحقق من الصلاحية - فقط الإدارة يمكنهم تعيين المرشدين
  // ملاحظة: صفوف staff_members لا تملك حقل "level" رقمياً، فكانت هذه المقارنة تفشل دائماً
  // وتمنع حتى Boss/General Manager من تعيين مرشدين. المستوى الصحيح هو i.staffLevel.
  if (i.staffLevel < LEVELS.MANAGEMENT) {
    return replyEphemeral(i, '❌ ليس لديك صلاحية لتعيين مرشدين.', COLORS.danger);
  }
  
  const newMember = staffService.get(newUser.id);
  const mentorMember = staffService.get(mentorUser.id);
  
  if (!newMember) return replyEphemeral(i, '❌ الموظف غير موجود.', COLORS.danger);
  if (!mentorMember) return replyEphemeral(i, '❌ المرشد غير موجود.', COLORS.danger);
  
  if (newMember.status !== 'probation') return replyEphemeral(i, '❌ يمكن تعيين مرشدين فقط للموظفين في فترة التجربة.', COLORS.danger);
  if (mentorMember.status !== 'active') return replyEphemeral(i, '❌ يجب أن يكون المرشد موظفاً نشطاً.', COLORS.danger);
  if (newMember.team !== mentorMember.team) return replyEphemeral(i, '❌ يجب أن يكون المرشد من نفس الفريق.', COLORS.danger);
  
  const result = tasks.assignMentor(newUser.id, mentorUser.id);
  
  if (!result.ok) {
    return replyEphemeral(i, `❌ فشل في تعيين المرشد: ${result.error}`, COLORS.danger);
  }
  
  const e = embed('✅ تم تعيين المرشد بنجاح', 
    `تم تعيين <@${mentorUser.id}> كمرشد لـ <@${newUser.id}>\n\n` +
    `📋 سيتلقى الموظف مهام تأهيل محسنة تتضمن اجتماعاً مع المرشد لتقييم الجاهزية.`,
    COLORS.success);
  
  // إشعار المرشد والموظف
  try {
    await require('../utils').dm(i.client, mentorUser.id, {
      embeds: [embed('🎯 تم اختيارك كمرشد', 
        `تم اختيارك كمرشد للموظف الجديد <@${newUser.id}>.\n\n` +
        `مسؤولياتك:\n` +
        `• توجيه الموظف خلال فترة التأهيل\n` +
        `• الإجابة على أسئلته حول العمل والسياسات\n` +
        `• تقييم جاهزيته للتحويل إلى موظف نشط\n` +
        `• الاجتماع معه بعد إكمال مهام التأهيل الأساسية`,
        COLORS.info)]
    });
  } catch (e) {
    // فشل الإرسال الخاص ليس حاسماً
  }
  
  try {
    await require('../utils').dm(i.client, newUser.id, {
      embeds: [embed('🎓 تم تعيين مرشد لك', 
        `تم تعيين <@${mentorUser.id}> كمرشد لك خلال فترة التأهيل.\n\n` +
        `يمكنك الاستفادة من مرشدك ل:\n` +
        `• فهم البيئة العملية بشكل أفضل\n` +
        `• الحصول على توجيهات حول المهام والمسؤوليات\n` +
        `• الاستعداد للاجتماع لتقييم الجاهزية`,
        COLORS.success)]
    });
  } catch (e) {
    // فشل الإرسال الخاص ليس حاسماً
  }
  
  return replyEphemeral(i, `✅ تم تعيين <@${mentorUser.id}> كمرشد لـ <@${newUser.id}>.`, COLORS.success);
}

/**
 * إزالة مرشد من موظف
 */
async function removeMentor(i) {
  const user = i.options.getUser('user');
  
  // التحقق من الصلاحية - فقط الإدارة يمكنهم إزالة المرشدين
  if (i.staffLevel < LEVELS.MANAGEMENT) {
    return replyEphemeral(i, '❌ ليس لديك صلاحية لإزالة المرشدين.', COLORS.danger);
  }
  
  const member = staffService.get(user.id);
  if (!member) return replyEphemeral(i, '❌ الموظف غير موجود.', COLORS.danger);
  
  if (!member.mentor_id) return replyEphemeral(i, '❌ هذا الموظف ليس لديه مرشد مُعين.', COLORS.info);
  
  const result = tasks.removeMentor(user.id);
  
  if (!result.ok) {
    return replyEphemeral(i, `❌ فشل في إزالة المرشد: ${result.error}`, COLORS.danger);
  }
  
  const e = embed('✅ تم إزالة المرشد بنجاح', 
    `تم إزالة المرشد من <@${user.id}>\n\n` +
    `سيستمر الموظف في receiving مهام التأهيل العادية دون اجتماع تقييم مع المرشد.`,
    COLORS.success);
  
  return replyEphemeral(i, `✅ تم إزالة المرشد من <@${user.id}>.`, COLORS.success);
}

/**
 * لوحة تحكم التأهيل
 */
async function onboardingDashboard(i) {
  const targetUser = i.options.getUser('user');
  const userId = targetUser ? targetUser.id : i.user.id;
  
  // التحقق من الصلاحية لعرض لوحة تحكم الآخرين
  if (targetUser && targetUser.id !== i.user.id) {
    if (!(i.staffLevel >= LEVELS.MANAGEMENT)) {
      return replyEphemeral(i, '❌ ليس لديك صلاحية لعرض لوحة تحكم التأهيل لغيرك.', COLORS.danger);
    }
  }
  
  const member = staffService.get(userId);
  if (!member) return replyEphemeral(i, '❌ الموظف غير موجود.', COLORS.danger);
  
  // الحصول على مهام التأهيل
  const onboardingTasks = tasks.list(userId, { taskType: 'onboarding' });
  const completedTasks = onboardingTasks.filter(t => t.status === 'completed');
  const pendingTasks = onboardingTasks.filter(t => t.status === 'pending');
  
  const e = embed(`📊 لوحة تحكم التأهيل - <@${userId}>`, 
    `${member.username} • ${member.rank} • ${member.team}\nالحالة: ${member.status === 'probation' ? 'فترة تجربة' : 'نشط'}`,
    member.status === 'probation' ? COLORS.warning : COLORS.success);
  
  // معلومات المرشد
  if (member.mentor_id) {
    const mentor = staffService.get(member.mentor_id);
    if (mentor) {
      e.addFields({
        name: '👨‍🏫 المرشد المخصص',
        value: `<@${member.mentor_id}> • ${mentor.rank} • ${mentor.team}`,
        inline: true
      });
    }
  } else {
    e.addFields({
      name: '👨‍🏫 المرشد المخصص',
      value: 'غير معين',
      inline: true
    });
  }
  
  // تقدم التأهيل
  const totalTasks = onboardingTasks.length;
  const completedCount = completedTasks.length;
  const progressPercent = totalTasks > 0 ? Math.round((completedCount / totalTasks) * 100) : 0;
  
  e.addFields({
    name: '📈 تقدم التأهيل',
    value: `${progressBar(completedCount, totalTasks, 10)} **${completedCount}/${totalTasks}** مهمة مكتملة\n${progressPercent}%`,
    inline: true
  });
  
  // المهام المعلقة
  if (pendingTasks.length > 0) {
    const taskList = pendingTasks.map(t => 
      `⏳ **#${t.id}** ${t.title.slice(0, 30)}${t.title.length > 30 ? '...' : ''}`
    ).join('\n');
    
    e.addFields({
      name: `📋 مهام التأهيل المعلقة (${pendingTasks.length})`,
      value: taskList.slice(0, 1024),
      inline: false
    });
  } else {
    e.addFields({
      name: '📋 مهام التأهيل',
      value: '✅ جميع مهام التأهيل مكتملة!',
      inline: false
    });
  }
  
  // حالة الجاهزية للتحويل
  if (member.status === 'probation') {
    const readyStatus = member.onboarding_ready ? '✅ جاهز للمراجعة الإدارية' : '⏳ يتطلب إكمال المهام أولاً';
    e.addFields({
      name: '🎯 حالة الجاهزية للتحويل',
      value: readyStatus,
      inline: false
    });
  }
  
  // أزرار إتمام المهام إذا كان المستخدم هو الموظف نفسه أو مشرف
  const isSelf = userId === i.user.id;
  const isManager = i.staffLevel >= LEVELS.MANAGEMENT;
  
  if ((isSelf || isManager) && pendingTasks.length > 0) {
    const buttons = pendingTasks.slice(0, 5).map(task => 
      new ButtonBuilder()
        .setCustomId(`onboarding:complete:${task.id}`)
        .setLabel(`إتمام #${task.id}`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
    );
    
    const actionRow = new ActionRowBuilder().addComponents(buttons);
    return i.reply({ embeds: [e], components: [actionRow], ephemeral: true });
  }
  
  return i.reply({ embeds: [e], ephemeral: true });
}

/**
 * عرض تقدم تأهيل الموظف الشخصي
 */
async function myOnboardingProgress(i) {
  return await onboardingDashboard(i); // نفس الوظيفة لكن للمستخدم نفسه
}