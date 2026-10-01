'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, PermissionsBitField } = require('discord.js');
const { LEVELS } = require('../constants');
const missions = require('../services/tasks');
const staffService = require('../services/staff');
const { getDb } = require('../database');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('missions').setDescription('عرض وإدارة المهام والمهام الجماعية')
        .addSubcommand(sub =>
          sub.setName('list')
            .setDescription('عرض مهامك')
            .addStringOption(o => o.setName('type').setDescription('نوع المهمة').addChoices(
              { name: 'عامة', value: 'general' },
              { name: 'مهمة', value: 'mission' },
              { name: 'متكررة', value: 'recurring' },
              { name: 'تأهيل', value: 'onboarding' },
              { name: 'جميع الأنواع', value: 'all' }
            ))
            .addBooleanOption(o => o.setName('completed').setDescription('عرض المهام المكتملة أيضًا'))
        )
        .addSubcommand(sub =>
          sub.setName('create')
            .setDescription('إنشاء مهمة جديدة')
            .addUserOption(o => o.setName('user').setDescription('المستخدم (للإدارة فقط)'))
            .addStringOption(o => o.setName('title').setDescription('عنوان المهمة'))
            .addStringOption(o => o.setName('description').setDescription('وصف المهمة'))
            .addStringOption(o => o.setName('due').setDescription('تاريخ الاستحقاق YYYY-MM-DD'))
            .addStringOption(o => o.setName('priority').setDescription('أولوية المهمة').addChoices(
              { name: 'منخفضة', value: 'low' },
              { name: 'عادية', value: 'normal' },
              { name: 'عالية', value: 'high' },
              { name: 'عاجلة', value: 'urgent' }
            ))
            .addStringOption(o => o.setName('type').setDescription('نوع المهمة').addChoices(
              { name: 'عامة', value: 'general' },
              { name: 'مهمة', value: 'mission' }
            ))
        )
        .addSubcommand(sub =>
          sub.setName('team')
            .setDescription('إنشاء مهمة جماعية لفريق')
            .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices(
              { name: 'الدعم', value: 'support' },
              { name: 'الإشراف', value: 'moderation' },
              { name: 'الإدارة العامة', value: 'general_management' }
            ))
            .addStringOption(o => o.setName('title').setDescription('عنوان المهمة'))
            .addStringOption(o => o.setName('description').setDescription('وصف المهمة'))
            .addStringOption(o => o.setName('due').setDescription('تاريخ الاستحقاق YYYY-MM-DD'))
        )
        .addSubcommand(sub =>
          sub.setName('templates')
            .setDescription('عرض واستخدام قوالب المهام')
        )
        .addSubcommand(sub =>
          sub.setName('progress')
            .setDescription('عرض تقدم المهام الجماعية')
            .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices(
              { name: 'الدعم', value: 'support' },
              { name: 'الإشراف', value: 'moderation' }
            ))
        )
        .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفصيلي أكثر')),
      level: LEVELS.STAFF,
      async execute(i) {
        const subcommand = i.options.getSubcommand();
        const detailed = i.options.getBoolean('detailed') || false;
        
        switch (subcommand) {
          case 'list':
            return await listMissions(i, detailed);
          case 'create':
            return await createMission(i);
          case 'team':
            return await createTeamMission(i);
          case 'templates':
            return await listTemplates(i);
          case 'progress':
            return await teamProgress(i);
          default:
            return replyEphemeral(i, '❌ أمر غير معروف.', COLORS.danger);
        }
      }
    },
  ],
  
  components: {
    'mission:complete': async (i, [id]) => {
      const task = missions.complete(Number(id), i.user.id);
      if (!task) return replyEphemeral(i, '❌ المهمة غير موجودة أو ليست لك أو أُنجزت مسبقاً.', COLORS.danger);
      await i.update({ content: `✅ تم إتمام المهمة **#${id}** - ${task.title}`, components: [] });
    },
    'mission:cancel': async (i, [id]) => {
      const cancelled = missions.cancel(Number(id), i.user.id);
      if (!cancelled) return replyEphemeral(i, '❌ المهمة غير موجودة أو ليست لك أو ليست معلقة.', COLORS.danger);
      await i.update({ content: `❌ تم إلغاء المهمة **#${id}**`, components: [] });
    }
  }
};

/**
 * عرض قائمة المهام
 */
async function listMissions(i, detailed) {
  const userId = i.user.id;
  const typeFilter = i.options.getString('type') || 'all';
  const includeCompleted = i.options.getBoolean('completed') || false;

  // fail-closed: لو تعذّر حساب المستوى نعتبر المستخدم غير مدير
  const isManager = i.staffLevel >= LEVELS.MANAGEMENT;
  
  let tasks;
  let filterDesc = '';
  
  if (typeFilter === 'all') {
    tasks = missions.list(userId, { includeCompleted });
    filterDesc = 'جميع الأنواع';
  } else {
    // مهم: هذا الأمر يعرض "مهامك" — يجب حصر النتائج بصاحب الطلب فقط
    tasks = missions.listByType(typeFilter, { includeCompleted, userId });
    const typeNames = {
      'general': 'عامة',
      'mission': 'مهمة',
      'recurring': 'متكررة',
      'onboarding': 'تأهيل'
    };
    filterDesc = typeNames[typeFilter] || typeFilter;
  }
  
  if (!tasks.length) {
    return replyEphemeral(i, `❌ لا توجد مهام${includeCompleted ? '' : ' معلقة'} من نوع ${filterDesc}.`, COLORS.info);
  }
  
  const e = embed(`📋 مهامك - ${filterDesc}`, `${tasks.length} مهمة${includeCompleted ? '' : ' معلقة'}`, COLORS.info);
  
  // إحصائيات سريعة
  const pendingCount = tasks.filter(t => t.status === 'pending').length;
  const completedCount = tasks.filter(t => t.status === 'completed').length;
  const overdueCount = tasks.filter(t => t.status === 'pending' && t.due_date && new Date(t.due_date) < new Date()).length;
  
  e.addFields({
    name: '📊 ملخص',
    value: `⏳ معلق: ${arDigits(pendingCount)} • ✅ مكتمل: ${arDigits(completedCount)} • ⚠️ متأخر: ${arDigits(overdueCount)}`,
    inline: true
  });
  
  // عرض المهام
  const taskList = tasks.slice(0, 10).map(task => {
    const statusEmoji = {
      'pending': '⏳',
      'completed': '✅',
      'cancelled': '🚫'
    }[task.status] || '•';
    
    const priorityEmoji = {
      'low': '🟢',
      'normal': '🔵',
      'high': '🟠',
      'urgent': '🔴'
    }[task.priority || 'normal'] || '🔵';
    
    const dueDate = task.due_date ? tsRelative(task.due_date) : 'بدون موعد';
    // صف تالف يجب ألا يُسقط العرض كاملاً — نتجاهله ونكمل
    let tags = [];
    try { tags = task.tags ? JSON.parse(task.tags) : []; } catch (e) { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    const tagsText = tags.length ? ` ${tags.map(t => `#${t}`).join(' ')}` : '';
    
    let line = `${statusEmoji} **#${task.id}** ${priorityEmoji} ${task.title}${tagsText}\n${dueDate}`;
    
    if (detailed && task.description) {
      line += `\n${task.description.slice(0, 100)}${task.description.length > 100 ? '...' : ''}`;
    }
    
    // إضافة أزرار الإتمام — الإلغاء معروض للإدارة فقط (mission:cancel محمي بمستوى MANAGEMENT)
    if (task.status === 'pending' && (task.user_id === i.user.id || isManager)) {
      line += isManager
        ? '\n💡 استخدم أزرار أدناه للإتمام أو الإلغاء'
        : '\n💡 استخدم الزر أدناه للإنهاء';
    }
    
    return line;
  }).join('\n\n');
  
  e.setDescription(`${e.data.description}\n\n${taskList}`);
  
  // إضافة أزرار إذا كان هناك مهام يمكن إتمامها
  const pendingTasks = tasks.filter(t => t.status === 'pending' && (t.user_id === i.user.id || isManager));
  if (pendingTasks.length > 0) {
    // ⚠️ Discord يسمح بـ 5 مكوّنات كحد أقصى لكل ActionRow — لا ندمج الصفوف
    const completeButtons = pendingTasks.slice(0, 5).map(task =>
      new ButtonBuilder()
        .setCustomId(`mission:complete:${task.id}`)
        .setLabel(`إنهاء #${task.id}`)
        .setEmoji('✅')
        .setStyle(ButtonStyle.Success)
    );
    const rows = [new ActionRowBuilder().addComponents(completeButtons)];

    // mission:cancel مسجّل في COMPONENT_ACCESS بمستوى MANAGEMENT — لا نعرضه لغير الإدارة
    if (isManager) {
      const cancelButtons = pendingTasks.slice(0, 5).map(task =>
        new ButtonBuilder()
          .setCustomId(`mission:cancel:${task.id}`)
          .setLabel(`إلغاء #${task.id}`)
          .setEmoji('❌')
          .setStyle(ButtonStyle.Danger)
      );
      if (cancelButtons.length) rows.push(new ActionRowBuilder().addComponents(cancelButtons));
    }

    return i.reply({ embeds: [e], components: rows, ephemeral: true });
  }
  
  return i.reply({ embeds: [e], ephemeral: true });
}

/**
 * إنشاء مهمة جديدة
 */
async function createMission(i) {
  const targetUser = i.options.getUser('user');
  const userId = targetUser ? targetUser.id : i.user.id;
  
  // التحقق من الصلاحية لإنشاء مهمة لغيرك
  // ملاحظة: صفوف staff_members لا تملك حقل "level" رقمياً (كانت المقارنة دائماً false
  // فتمنع حتى المدراء من إنشاء مهام لغيرهم) — المستوى الصحيح للمستخدم الحالي هو i.staffLevel.
  if (targetUser && targetUser.id !== i.user.id) {
    if (!(i.staffLevel >= LEVELS.MANAGEMENT)) {
      return replyEphemeral(i, '❌ ليس لديك صلاحية لإنشاء مهمة لغيرك.', COLORS.danger);
    }
  }
  
  const title = i.options.getString('title');
  const description = i.options.getString('description') || '';
  const due = i.options.getString('due');
  const priority = i.options.getString('priority') || 'normal';
  const type = i.options.getString('type') || 'general';
  
  if (!title) return replyEphemeral(i, '❌ يجب إدخال عنوان المهمة.', COLORS.danger);
  
  let dueDate = null;
  if (due) {
    // التحقق من صحة التاريخ
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      return replyEphemeral(i, '❌ تنسيق التاريخ غير صحيح. استخدم YYYY-MM-DD.', COLORS.danger);
    }
    dueDate = due;
  }
  
  const task = missions.create({
    userId: userId,
    title: title,
    description: description,
    taskType: type,
    dueDate: dueDate,
    assignedBy: i.user.id,
    priority: priority
  });
  
  if (!task) return replyEphemeral(i, '❌ فشل في إنشاء المهمة.', COLORS.danger);
  
  const actionText = targetUser && targetUser.id !== i.user.id ? 'لغيرك' : 'لك';
  return replyEphemeral(i, `✅ تم إنشاء المهمة **#${task.id}** ${actionText}: ${task.title}`, COLORS.success);
}

/**
 * إنشاء مهمة جماعية
 */
async function createTeamMission(i) {
  const team = i.options.getString('team');
  const title = i.options.getString('title');
  const description = i.options.getString('description') || '';
  const due = i.options.getString('due');
  
  if (!title) return replyEphemeral(i, '❌ يجب إدخال عنوان المهمة.', COLORS.danger);
  
  // التحقق من الصلاحية (staff_members لا يملك حقل level رقمياً — نستخدم i.staffLevel المحسوب مسبقاً)
  if (!(i.staffLevel >= LEVELS.MANAGEMENT)) {
    return replyEphemeral(i, '❌ ليس لديك صلاحية لإنشاء مهمة جماعية.', COLORS.danger);
  }
  
  let dueDate = null;
  if (due) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) {
      return replyEphemeral(i, '❌ تنسيق التاريخ غير صحيح. استخدم YYYY-MM-DD.', COLORS.danger);
    }
    dueDate = due;
  }
  
  let task;
  try {
    task = missions.createTeamMission(
      team,
      title,
      description,
      dueDate,
      i.user.id
    );
  } catch (e) {
    console.error(`خطأ في إنشاء المهمة الجماعية (${team}) بواسطة ${i.user.id}:`, e);
    return replyEphemeral(i, '❌ حدث خطأ أثناء إنشاء المهمة الجماعية. راجع السجل.', COLORS.danger);
  }
  
  if (!task) return replyEphemeral(i, '❌ فشل في إنشاء المهمة الجماعية.', COLORS.danger);
  
  return replyEphemeral(i, `✅ تم إنشاء المهمة الجماعية **#${task.id}** للفريق ${team}: ${title}`, COLORS.success);
}

/**
 * عرض قوالب المهام
 */
async function listTemplates(i) {
  const db = getDb();

  const templates = db.prepare('SELECT * FROM mission_templates WHERE is_active = 1 ORDER BY category, name').all();

  if (!templates.length) {
    return replyEphemeral(i, '📋 لا توجد قوالب مهام نشطة حالياً.', COLORS.info);
  }

  const categoryEmojis = {
    onboarding: '🎓',
    security: '🔒',
    performance: '📈',
    compliance: '📋',
    development: '💻',
    general: '📝'
  };

  const lines = templates.map(t => {
    const emoji = categoryEmojis[t.category] || '📝';
    const tasks = JSON.parse(t.tasks);
    return `${emoji} **${t.name}** \`${t.id}\` (${t.category})\n   ${t.description}\n   ${tasks.length} مهام${t.repeat_interval ? ` • تكرار: ${t.repeat_interval}` : ''}`;
  });

  const e = embed('📋 قوالب المهام المتاحة', lines.join('\n\n'), COLORS.info);
  return i.reply({ embeds: [e], ephemeral: true });
}

/**
 * عرض تقدم المهام الجماعية
 */
async function teamProgress(i) {
  const team = i.options.getString('team');
  const db = getDb();
  
  const total = db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE team_id = ?').get(team).c;
  const completed = db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE team_id = ? AND status = \'completed\'').get(team).c;
  const pending = db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE team_id = ? AND status = \'pending\'').get(team).c;
  
  const progress = total > 0 ? Math.round((completed / total) * 100) : 0;
  
  const e = embed(`📊 تقدم المهام الجماعية - ${team === 'support' ? 'الدعم الفني' : 'الإشراف'}`,
    `${progressBar(completed, total, 10)} ${progress}%`, COLORS.info);
  
  e.addFields({
    name: 'الإحصاءات',
    value: `✅ مكتمل: ${arDigits(completed)}\n⏳ معلق: ${arDigits(pending)}\n📊 الإجمالي: ${arDigits(total)}`,
    inline: true
  });
  
  return i.reply({ embeds: [e], ephemeral: true });
}