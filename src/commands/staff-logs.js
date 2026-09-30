'use strict';
const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const audit = require('../services/audit');
const staffService = require('../services/staff');
const settings = require('../services/settings');
const { embed, COLORS, replyEphemeral, arDigits } = require('../utils');
const kit = require('../ui/kit');
const clock = require('../clock');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('staff-logs').setDescription('عرض سجلات الفريق مع التصفية والبحث')
        .addStringOption(o => o.setName('action').setDescription('تصفية حسب الإجراء (مثل: staff_warning_issued, task_assigned)'))
        .addStringOption(o => o.setName('user').setDescription('تصفية حسب المستخدم (معرف أو منشن)'))
        .addStringOption(o => o.setName('limit').setDescription('عدد السجلات (الافتراضي: 20, الأقصى: 100)'))
        .addStringOption(o => o.setName('days').setDescription('عدد الأيام السابقة (الافتراضي: 7)'))
        .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفاصيل JSON complète')),
      // سجل التدقيق يحتوي إنذارات وملاحظات سرية وأسباب استقالات — كان متاحاً بالخطأ لكل إداري (حتى Helper)؛
      // يجب أن يطابق صلاحية /audit-log (الإدارة العليا فقط).
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        if (!settings.featureToggle('auditExport')) return replyEphemeral(i, '❌ هذا أمر معطّل حالياً.', COLORS.danger);
        const actionFilter = i.options.getString('action');
        const userFilter = i.options.getString('user');
        const limitOpt = i.options.getString('limit');
        const daysOpt = i.options.getString('days');
        const detailed = i.options.getBoolean('detailed') || false;
        
        let limit = 20;
        if (limitOpt) {
          limit = Math.min(parseInt(limitOpt), 100);
          if (isNaN(limit)) limit = 20;
        }
        
        let since = null;
        if (daysOpt) {
          const days = parseInt(daysOpt);
          if (!isNaN(days) && days > 0) {
            const date = new Date();
            date.setDate(date.getDate() - days);
            since = date.toISOString().slice(0, 10);
          }
        }
        
        // Resolve user filter if provided
        let targetId = null;
        if (userFilter) {
          const userId = userFilter.replace(/[<@>]/g, '');
          if (/^\d+$/.test(userId)) {
            const member = staffService.get(userId);
            if (member) targetId = userId;
          } else {
            // Try to find by username
            const allStaff = staffService.all();
            const match = allStaff.find(m => 
              m.username.toLowerCase() === userFilter.toLowerCase() ||
              m.user_id.toLowerCase() === userFilter.toLowerCase()
            );
            if (match) targetId = match.user_id;
          }
        }
        
        const logs = audit.list({ actorId: targetId, targetId: targetId, limit, action: actionFilter, since });
        const totalCount = audit.count({ actorId: targetId, targetId: targetId, action: actionFilter, since });
        
        if (!logs.length) {
          return replyEphemeral(i, '❌ لا توجد سجلات تطابق معايير البحث.', COLORS.warning);
        }
        
        // Build embed with summary
        const e = kit.card({
          title: `📋 سجلات الفريق${userFilter ? ` - <@${userFilter}>` : ''}${actionFilter ? ` - ${actionFilter}` : ''}`,
          description: `عرض ${logs.length} من أصل ${totalCount} سجل${since ? ` من آخر ${daysOpt} يوم` : ''}`,
          color: COLORS.info,
          timestamp: new Date()
        });
        
        // Add summary stats
        const actionsMap = {};
        logs.forEach(log => {
          actionsMap[log.action] = (actionsMap[log.action] || 0) + 1;
        });
        
        const actionSummary = Object.entries(actionsMap)
          .sort(([,a], [,b]) => b - a)
          .slice(0, 5)
          .map(([action, count]) => {
            const actionName = action.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            return `${actionName}: ${arDigits(count)}`;
          })
          .join(' • ');
          
        e.addFields({
          name: '📊 ملخص الإجراءات',
          value: actionSummary || 'لا يوجد',
          inline: true
        });
        
        // Add recent logs
        const recentLogs = logs.slice(0, 10).map(log => {
          const timestamp = clock.discordTs(log.created_at, 'R');
          const actionName = log.action.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
          const actor = log.actor_id ? `<@${log.actor_id}>`: 'النظام';
          const target = log.target_id ? `<@${log.target_id}>`: '—';
          
          let details = '';
          if (detailed && log.details) {
            try {
              const parsed = JSON.parse(log.details);
              details = '\n```json\n' + JSON.stringify(parsed, null, 2) + '\n```';
            } catch {
              details = `\n${log.details}`;
            }
          }
          
          return `**#${log.id}** • ${actionName}\n${timestamp} • بواسطة: ${actor} → ${target}${details}`;
        }).join('\n\n');
        
        e.addFields({
          name: `📝 آخر ${logs.length < 10 ? logs.length : 10} سجلات`,
          value: recentLogs.slice(0, 1024),
          inline: false
        });
        
        // Add pagination controls if needed
        const components = [];
        if (totalCount > limit) {
          const pageCount = Math.ceil(totalCount / limit);
          const select = new StringSelectMenuBuilder()
            .setCustomId('staff-logs:page')
            .setPlaceholder(`اختر الصفحة (1/${pageCount})`)
            .addOptions([
              { label: 'الصفحة 1', value: '1', description: `الصفحة الأولى من ${pageCount}` },
              { label: `الصفحة ${pageCount}`, value: String(pageCount), description: `الصفحة الأخيرة من ${pageCount}` }
            ]);
          
          components.push(new ActionRowBuilder().addComponents(select));
        }
        
        return i.reply({ embeds: [e], components, ephemeral: true });
      },
    },
  ],
  
  components: {
    'staff-logs:page': async (i) => {
      // Pagination would be implemented here
      // For now, just acknowledge the interaction
      await i.deferUpdate();
    }
  }
};