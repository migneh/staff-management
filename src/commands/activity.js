'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS } = require('../constants');
const activity = require('../services/activity');
const staffService = require('../services/staff');
const { embed, COLORS, replyEphemeral, arDigits } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('activity').setDescription('إحصائيات نشاطك الشخصي')
        .addIntegerOption(o => o.setName('days').setDescription('عدد الأيام للتقرير (الافتراضي: 30)').setMinValue(1).setMaxValue(365)),
      level: LEVELS.STAFF,
      async execute(i) {
        const days = i.options.getInteger('days') || 30;
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        
        const stats = activity.stats(userId, days);
        const e = kit.card({
          title: `📊 تقرير النشاط الشخصي — آخر ${days} يوم`,
          description: `للمستخدم <@${userId}> — ${member.rank} (${TEAMS[member.team]})`,
          fields: [
            { name: '💬 إجمالي الرسائل', value: `${arDigits(stats.messages)}` },
            { name: '🎯 الرسائل المرجحة', value: `${arDigits(stats.weighted)}` },
            { name: '📅 أيام النشاط', value: `${arDigits(stats.activeDays)}` },
            { name: '📊 توزيع النشاط حسب القنوات', value: Object.entries(stats.byType).map(([type, count]) => {
              const typeNames = { ticket: '🎫 تكتات', staff: '💬 إدارة', moderation: '🛡️ إشراف', general: '🌐 عام' };
              return `${typeNames[type] || type}: ${arDigits(count)}`;
            }).join(' • ') },
          ],
          color: COLORS.info,
          footer: kit.footerLine(`الوزنات المطبقة: تكتات 50% • إدارة 25% • إشراف 25% • عام 10%`),
        });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
  
  components: {},
};