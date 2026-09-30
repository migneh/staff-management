'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const ratings = require('../services/supportRatings');
const staff = require('../services/staff');
const settings = require('../services/settings');
const { COLORS, replyEphemeral, progressBar } = require('../utils');
const kit = require('../ui/kit');
const { tsRelative } = kit;
const { homeRow } = require('../ui/navigation');

function payload(userId, days = 30) {
  const s = ratings.summary(userId, days);
  const e = kit.card({
    title: '⭐ تقييمات الدعم الفني',
    description: `<@${userId}> • آخر **${s.days}** يوماً`,
    color: COLORS.primary,
    footer: kit.footerLine('⭐ تقييمات قناة الدعم فقط • لا تضيف تكتات أو نقاطاً'),
    fields: !s.count ? [
      { name: 'لا توجد تقييمات مسجّلة في هذه الفترة', value: settings.channelId('support-rating-logs')
        ? 'سيظهر التقييم هنا عند وصول رسالة جديدة مطابقة من بوت التقييم. جرّب فترة أطول من الأزرار.'
        : 'لم يتم ربط المصدر بعد. على المسؤول فتح /setup ← مصدر تقييمات الدعم.', inline: false },
    ] : [
      { name: '📊 المتوسط', value: `**${s.average}/5**`, inline: true },
      { name: '🧮 عدد التقييمات', value: String(s.count), inline: true },
      { name: '🙋 الأعضاء الذين قيّموا', value: String(s.reviewers), inline: true },
      { name: '🌟 توزيع النجوم', value: [5, 4, 3, 2, 1].map(stars => {
        const count = s.distribution.find(r => r.stars === stars)?.count || 0;
        return `**${stars} ⭐** ${progressBar(count, s.count, 8)} ${count}`;
      }).join('\n'), inline: false },
      { name: '🕒 أحدث ٥ تقييمات', value: s.recent.map(r => `${'⭐'.repeat(r.stars)} • <@${r.reviewer_id}> • ${tsRelative(r.rated_at)}\n[فتح رسالة التقييم](${ratings.sourceUrl(r)})`).join('\n\n'), inline: false },
    ],
  });
  const periods = new ActionRowBuilder().addComponents(...[7, 30, 90].map(n => new ButtonBuilder()
    .setCustomId(`ratings:period:${userId}:${n}`).setLabel(`${n} أيام`).setStyle(n === s.days ? ButtonStyle.Primary : ButtonStyle.Secondary).setDisabled(n === s.days)));
  return { embeds: [e], components: [periods, homeRow()], allowedMentions: { parse: [] } };
}
function canView(i, userId) { return userId === i.user.id || i.staffLevel >= LEVELS.SUPERVISOR; }
module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-ratings').setDescription('⭐ تقييمات العملاء لك: المتوسط والنجوم ورسائل المصدر'),
      level: LEVELS.STAFF, team: 'support',
      async execute(i) { return i.reply({ ...payload(i.user.id), ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('support-ratings').setDescription('⭐ مراجعة تقييمات إداري من فريق الدعم')
        .addUserOption(o => o.setName('user').setDescription('إداري الدعم').setRequired(true))
        .addIntegerOption(o => o.setName('days').setDescription('الفترة بالأيام — الافتراضي 30').setMinValue(1).setMaxValue(365)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const id = i.options.getUser('user').id;
        if (staff.get(id)?.team !== 'support') return replyEphemeral(i, 'اختر عضواً مسجلاً في فريق الدعم الفني.', COLORS.warning);
        return i.reply({ ...payload(id, i.options.getInteger('days') || 30), ephemeral: true });
      },
    },
  ],
  components: {
    'ratings:period': async (i, [id, days]) => {
      if (!canView(i, id)) return replyEphemeral(i, 'لا يمكنك عرض تقييمات الآخرين. استخدم /my-ratings لعرض تقييماتك.', COLORS.danger);
      if (!['7', '30', '90'].includes(days)) return replyEphemeral(i, 'اختر الفترة من الأزرار المتاحة.', COLORS.warning);
      return i.update(payload(id, Number(days)));
    },
  },
  payload,
};
