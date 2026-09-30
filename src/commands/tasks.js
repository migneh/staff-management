'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const tasks = require('../services/tasks');
const { homeRow } = require('../ui/navigation');
const { tsDate, trim, navRow } = require('../ui/kit');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, isValidDate } = require('../utils');

function taskPayload(userId, includeCompleted = false, page = 1) {
  const result = tasks.listPage(userId, { includeCompleted, page });
  if (!result.total) return { embeds: [embed('📋 مهامي', '✅ لا توجد مهام معلّقة حالياً. عد إلى لوحتك لمراجعة الأداء والطلبات.', COLORS.success)], components: [homeRow()] };
  const status = { pending: '⏳', completed: '✅', cancelled: '🚫' };
  const priorityEmoji = { low: '🟢', normal: '🔵', high: '🟠', urgent: '🔴' };
  const e = embed('📋 مهامي', `**${result.total}** مهمة • مرتبة حسب الموعد الأقرب.\nبعد إنجاز المهمة فعلياً، اضغط زر الإنهاء الذي يحمل رقمها.`, COLORS.info);
  for (const task of result.items) e.addFields({
    name: `${status[task.status] || '•'} ${priorityEmoji[task.priority || 'normal']} #${task.id} — ${trim(task.title, 150)}`,
    value: `النوع: ${task.task_type} • الموعد: ${task.due_date ? tsDate(task.due_date) : 'بدون موعد محدد'}\n${trim(task.description || 'لا توجد تفاصيل إضافية.', 700)}`,
  });
  e.setFooter({ text: `صفحة ${result.page}/${result.pages} • إكمال التأهيل يتبعه اعتماد المدير قبل تفعيل الحالة النشطة` });
  const buttons = result.items.filter(t => t.status === 'pending').map(t => new ButtonBuilder()
    .setCustomId(`task:complete:${t.id}:${result.page}:${includeCompleted ? 1 : 0}`).setLabel(`إنهاء #${t.id}`).setEmoji('✅').setStyle(ButtonStyle.Secondary));
  const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
  if (result.pages > 1) components.push(navRow({ prefix: 'task:page', page: result.page, pages: result.pages, args: [includeCompleted ? '1' : '0'] }));
  components.push(homeRow());
  return { embeds: [e], components };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-tasks').setDescription('عرض مهامك ومهام التأهيل')
        .addStringOption(o => o.setName('type').setDescription('تصفية حسب النوع').addChoices(
          { name: 'جميع', value: 'all' },
          { name: 'عامة', value: 'general' },
          { name: 'مهمة', value: 'mission' },
          { name: 'متكررة', value: 'recurring' },
          { name: 'تأهيل', value: 'onboarding' },
          { name: 'متابعة', value: 'follow_up' }
        ))
        .addBooleanOption(o => o.setName('completed').setDescription('عرض المهام المكتملة أيضًا')),
      level: LEVELS.STAFF,
      async execute(i) {
        const typeFilter = i.options.getString('type') || 'all';
        const includeCompleted = i.options.getBoolean('completed') || false;
        
        let result;
        if (typeFilter === 'all') {
          result = tasks.listPage(i.user.id, { includeCompleted, page: 1 });
        } else {
          const allTasks = tasks.list(i.user.id, { includeCompleted, limit: 100, taskType: typeFilter });
          const total = allTasks.length;
          const pages = Math.max(1, Math.ceil(total / 5));
          result = { 
            items: allTasks.slice(0, 5), 
            page: 1, 
            pages, 
            total,
            filter: typeFilter
          };
        }
        
        if (!result.total) {
          return replyEphemeral(i, `✅ لا توجد مهام${includeCompleted ? '' : ' معلقة'} من النوع المحدد.`, COLORS.success);
        }
        
        const status = { pending: '⏳', completed: '✅', cancelled: '🚫' };
        const priorityEmoji = { low: '🟢', normal: '🔵', high: '🟠', urgent: '🔴' };
        
        const e = embed('📋 مهامي', `**${result.total}** مهمة • نوع: ${result.filter || 'جميع'}`, COLORS.info);
        
        for (const task of result.items) e.addFields({
          name: `${status[task.status] || '•'} ${priorityEmoji[task.priority || 'normal']} #${task.id} — ${trim(task.title, 150)}`,
          value: `النوع: ${task.task_type} • الموعد: ${task.due_date ? tsDate(task.due_date) : 'بدون موعد محدد'}\n${trim(task.description || 'لا توجد تفاصيل إضافية.', 700)}`,
        });
        
        e.setFooter({ text: `صفحة ${result.page}/${result.pages} • إكمال التأهيل يتبعه اعتماد المدير قبل تفعيل الحالة النشطة` });
        
        const buttons = result.items.filter(t => t.status === 'pending').map(t => new ButtonBuilder()
          .setCustomId(`task:complete:${t.id}:${result.page}:${includeCompleted ? 1 : 0}`).setLabel(`إنهاء #${t.id}`).setEmoji('✅').setStyle(ButtonStyle.Secondary));
        const components = buttons.length ? [new ActionRowBuilder().addComponents(buttons)] : [];
        if (result.pages > 1) components.push(navRow({ prefix: 'task:page', page: result.page, pages: result.pages, args: [includeCompleted ? '1' : '0'] }));
        components.push(homeRow());
        
        return i.reply({ embeds: [e], components, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('approve-onboarding').setDescription('اعتماد انتقال إداري من التجربة إلى نشط')
        .addUserOption(o => o.setName('user').setDescription('الإداري الجديد').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('ملاحظة المدير — اختيارية').setMaxLength(300)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const target = staffService.get(user.id);
        if (!target || target.status !== 'probation') return replyEphemeral(i, '❌ العضو غير موجود أو ليس في فترة تجريبية.', COLORS.danger);
        const pending = tasks.list(user.id, { limit: 20 }).filter(t => t.task_type === 'onboarding' && t.status === 'pending');
        if (pending.length || !target.onboarding_ready) return replyEphemeral(i, `❌ لم تكتمل مهام التأهيل بعد.${pending.length ? `\nالمتبقي: ${pending.map(t => `#${t.id}`).join('، ')}` : ''}`, COLORS.danger);
        const reason = i.options.getString('reason') || null;
        const approved = tasks.approveOnboarding(user.id, i.user.id);
        if (!approved) return replyEphemeral(i, '❌ تعذّر اعتماد التأهيل — أعد فتح /my-tasks وتحقق من اكتمال المهام.', COLORS.danger);
        audit.record({ action: 'onboarding_approved', actorId: i.user.id, targetId: user.id, details: { reason }, channelId: i.channelId });
        await require('../utils').dm(i.client, user.id, { embeds: [embed('🎉 تم اعتمادك كإداري نشط', `اعتمدت الإدارة انتقالك من فترة التجربة إلى **نشط**.${reason ? `\n**ملاحظة:** ${reason}` : ''}`, COLORS.success)] });
        return replyEphemeral(i, `✅ تم اعتماد <@${user.id}> كإداري نشط.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('assign-task').setDescription('تعيين مهمة لإداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('title').setDescription('عنوان المهمة').setRequired(true).setMaxLength(100))
        .addStringOption(o => o.setName('description').setDescription('تفاصيل المهمة').setRequired(false).setMaxLength(500))
        .addStringOption(o => o.setName('due').setDescription('آخر موعد YYYY-MM-DD — اختياري').setRequired(false).setMaxLength(10))
        .addStringOption(o => o.setName('type').setDescription('نوع المهمة').setRequired(false).addChoices(
          { name: 'عامة', value: 'general' }, { name: 'متابعة', value: 'follow_up' }, { name: 'تأهيل', value: 'onboarding' }, { name: 'مهمة', value: 'mission' }))
        .addStringOption(o => o.setName('priority').setDescription('أولوية المهمة').setRequired(false).addChoices(
          { name: 'منخفضة', value: 'low' }, { name: 'عادية', value: 'normal' }, { name: 'عالية', value: 'high' }, { name: 'عاجلة', value: 'urgent' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        const due = i.options.getString('due');
        if (due && !isValidDate(due)) return replyEphemeral(i, '❌ الموعد يجب أن يكون بصيغة YYYY-MM-DD.', COLORS.danger);
        const task = tasks.create({ userId: user.id, title: i.options.getString('title'), description: i.options.getString('description'), dueDate: due, taskType: i.options.getString('type') || 'general', assignedBy: i.user.id, priority: i.options.getString('priority') || 'normal' });
        audit.record({ action: 'task_assigned', actorId: i.user.id, targetId: user.id, details: { taskId: task.id, title: task.title }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم تعيين المهمة **#${task.id}** لـ <@${user.id}>.`, COLORS.success);
      },
    },
  ],
  components: {
    'task:page': async (i, [page, completed]) => i.update(taskPayload(i.user.id, completed === '1', page)),
    'task:complete': async (i, [id, page, completed]) => {
      const task = tasks.complete(Number(id), i.user.id);
      if (!task) return replyEphemeral(i, '❌ المهمة غير موجودة أو ليست لك أو أُنجزت مسبقاً.', COLORS.danger);
      audit.record({ action: 'task_completed', actorId: i.user.id, targetId: i.user.id, details: { taskId: task.id, title: task.title }, channelId: i.channelId });
      return i.update(taskPayload(i.user.id, completed === '1', page));
    },
  },
  taskPayload,
};
