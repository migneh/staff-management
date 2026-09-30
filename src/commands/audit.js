'use strict';
const { SlashCommandBuilder, AttachmentBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const audit = require('../services/audit');
const settings = require('../services/settings');
const { embed, COLORS, replyEphemeral, truncate, discordTs } = require('../utils');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('audit-log').setDescription('عرض سجل العمليات الحساسة')
        .addUserOption(o => o.setName('user').setDescription('تصفية حسب العضو — اختياري').setRequired(false))
        .addIntegerOption(o => o.setName('limit').setDescription('عدد السجلات (1-25)').setMinValue(1).setMaxValue(25).setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        if (!settings.featureToggle('auditExport')) return replyEphemeral(i, '❌ هذا أمر معطّل حالياً.', COLORS.danger);
        const user = i.options.getUser('user');
        const rows = audit.list({ targetId: user?.id, limit: i.options.getInteger('limit') || 15 });
        if (!rows.length) return replyEphemeral(i, 'لا توجد سجلات مطابقة.', COLORS.gray);
        const lines = rows.map(r => {
          const details = audit.parseDetails(r.details);
          const summary = typeof details === 'string' ? details : details ? Object.entries(details).slice(0, 3).map(([k, v]) => `${k}: ${v}`).join(' • ') : '';
          return `**#${r.id} ${r.action}** • ${discordTs(r.created_at, 'R')}\nالمنفذ: ${r.actor_id ? `<@${r.actor_id}>` : 'النظام'}${r.target_id ? ` • الهدف: <@${r.target_id}>` : ''}${summary ? `\n╰ ${truncate(summary, 220)}` : ''}`;
        });
        return i.reply({ embeds: [embed('🧾 سجل العمليات الحساسة', lines.join('\n\n'), COLORS.info)], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('audit-export').setDescription('تصدير سجلات التدقيق للامتثال')
        .addUserOption(o => o.setName('user').setDescription('تصفية حسب العضو — optional').setRequired(false))
        .addStringOption(o => o.setName('action').setDescription('تصفية حسب نوع العملية — optional').setRequired(false))
        .addIntegerOption(o => o.setName('days').setDescription('عدد Days للأرجاع (الافتراضي: 30)').setMinValue(1).setMaxValue(365)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        if (!settings.featureToggle('auditExport')) return replyEphemeral(i, '❌ هذا أمر معطّل حالياً.', COLORS.danger);
        
        const user = i.options.getUser('user');
        const action = i.options.getString('action');
        const days = i.options.getInteger('days') || 30;
        
        const auditData = audit.list({ 
          targetId: user?.id,
          limit: 1000 // Get a large number for export
        });
        
        // Filter by action if specified
        let filteredData = auditData;
        if (action) {
          filteredData = auditData.filter(r => r.action === action);
        }
        
        // Filter by days if specified
        if (days > 0) {
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - days);
          filteredData = filteredData.filter(r => new Date(r.created_at) >= cutoffDate);
        }
        
        if (!filteredData.length) {
          return replyEphemeral(i, 'لا توجد سجلات تدقيق مطابقة للمعايير المحددة.', COLORS.warning);
        }
        
        // Create CSV content
        let csvContent = 'ID,الإجراء,المنفذ,الهدف,التفاصيل,تاريخ الإنشاء\n';
        filteredData.forEach(row => {
          const actorName = row.actor_id ? `<@${row.actor_id}>` : 'النظام';
          const targetName = row.target_id ? `<@${row.target_id}>` : '';
          const details = row.details ? JSON.parse(row.details) : '';
          const detailsStr = typeof details === 'string' ? details : 
                           details && typeof details === 'object' ? JSON.stringify(details) : details || '';
          csvContent += `"${row.id}","${row.action}","${actorName}","${targetName}","${detailsStr.replace(/"/g, '""')}","${row.created_at}"\n`;
        });
        
        // Send as file attachment
        const attachment = new AttachmentBuilder(Buffer.from(csvContent, 'utf-8'), {
          name: `audit-log-${new Date().toISOString().slice(0,10)}.csv`
        });
        
        return i.reply({
          content: `📤 تم تصدير ${filteredData.length} سجل تدقيق للامتثال`,
          files: [attachment],
          ephemeral: true
        });
      }
    }
  ],
  components: {},
};
