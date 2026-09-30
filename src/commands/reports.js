'use strict';
const forms = require('../ui/forms');
const { homeRow } = require('../ui/navigation');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS, WARNING_TYPES } = require('../constants');
const reports = require('../services/reports');
const load = require('../services/load');
const staffService = require('../services/staff');
const taskService = require('../services/tasks');
const settings = require('../services/settings');
const audit = require('../services/audit');
const { getDb } = require('../database');
const { embed, COLORS, replyEphemeral, progressBar, divider, nowIso } = require('../utils');
const kit = require('../ui/kit');

/** النافذة الموحّدة للترتيب — أسبوعان أعدل من 7 أيام في الفرق الصغيرة */
const LEADERBOARD_WINDOW_DAYS = 14;

function teamEmbed(teamKey, rows) {
  const workMap = rows.map(r => {
    const count = r.work.closed ?? r.work.actions ?? 0;
    const detail = r.staff.team === 'support'
      ? `${count} تكت مغلق • متوسط ${r.work.avgDuration ?? '—'} د • ${r.work.avgRating ?? '—'} ⭐`
      : `${count} إجراء • ${r.work.activeDays} أيام عمل`;
    return { user: r.staff.user_id, rank: r.staff.rank, status: r.staff.status, work: count, detail };
  });
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.work.closed + r.work.actions, 0) / rows.length) : 0;
  const e = embed(`👥 تقرير ${TEAMS[teamKey]}`, `الأعضاء: **${rows.length}** • متوسط العمل: **${avg}**`, COLORS.info);
  const lines = workMap.sort((a, b) => b.work - a.work).map(r => `<@${r.user}> • ${r.rank} • **${r.work}** • ${STATUS[r.status]}${r.status !== 'on_leave' && r.status !== 'resigned' && r.status !== 'removed' && r.status !== 'suspended' && hoursSinceFromMember(r) > 72 ? ' ⚠️' : ''}`);
  for (let k = 0; k < lines.length; k += 15) e.addFields({ name: k === 0 ? 'الأعضاء' : '\u200b', value: lines.slice(k, k + 15).join('\n') });
  return e;
}

function hoursSinceFromMember(r) {
  return 0;
}

function reportsCsv(rows) {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `\ufeff${['id', 'report_type', 'period', 'created_at', 'data'].map(cell).join(',')}\n${rows.map(r => [r.id, r.report_type, r.period, r.created_at, r.data].map(cell).join(',')).join('\n')}\n`;
}

const modals = {
  performanceEmbed: undefined,
  leaderboardEmbed: undefined,
  teamEmbed,
};

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-performance').setDescription('عرض تقرير أدائك الشخصي'),
      level: LEVELS.STAFF,
      async execute(i) {
        const s = staffService.get(i.user.id);
        if (!s) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], components: [homeRow()], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('staff-report').setDescription('عرض تقرير أداء إداري معين')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const s = staffService.get(i.options.getUser('user').id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('team-report').setDescription('تقرير الفريق')
        .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team');
        const teams = team ? [team] : ['support', 'moderation'];
        return i.editReply({ embeds: teams.map(t => teamEmbed(t, reports.team(t))) });
},
     },
     {
       data: new SlashCommandBuilder().setName('leaderboard').setDescription('ترتيب الإداريين (للإدارة فقط)')
         .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' }, { name: 'عام', value: 'all' })),
       level: LEVELS.SUPERVISOR,
       async execute(i) {
         await i.deferReply({ ephemeral: true });
         const team = i.options.getString('team') || 'all';
         if (team === 'all') return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard('support', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الدعم الفني'), leaderboardEmbed(reports.leaderboard('moderation', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الإشراف')] });
         return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard(team, LEADERBOARD_WINDOW_DAYS), `🏆 ترتيب ${TEAMS[team]}`)] });
       },
     },
      {
        data: new SlashCommandBuilder().setName('score-weights')
          .setDescription('عرض أو تعديل أوزان حساب Score')
          .addStringOption(o => o.setName('action').setDescription('الإجراء').setRequired(true)
            .addChoices(
              { name: 'عرض الأوزان الحالية', value: 'view' },
              { name: 'تعيين أوزان فريق', value: 'set' }
            ))
          .addStringOption(o => o.setName('team').setDescription('الفريق (required for set action)')
            .addChoices(
              { name: 'Helper', value: 'helper' },
              { name: 'Support', value: 'support' },
              { name: 'الإشراف', value: 'moderation' }
            ))
        , level: LEVELS.BOSS,
        async execute(i) {
          const action = i.options.getString('action');
          if (action === 'view') {
            const supportWeights = settings.scoreWeights('support');
            const moderationWeights = settings.scoreWeights('moderation');
            const helperWeights = settings.scoreWeights('helper');
            const e = kit.card({
              title: '⚖️ أوزان حساب Score الحالية',
              fields: [
                { name: '🎫 فريق الدعم', value: Object.entries(supportWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
                { name: '🛡️ فريق الإشراف', value: Object.entries(moderationWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
                { name: '🎯 فريق المساعد', value: Object.entries(helperWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
              ],
              color: COLORS.info,
              footer: kit.footerLine('استخدم `/score-weights set <الفريق>` لتعديل الأوزان عبر النموذج')
            });
            return i.reply({ embeds: [e], ephemeral: true });
          }
          if (action === 'set') {
            const team = i.options.getString('team');
            const current = settings.scoreWeights(team);
            return forms.open(i, modals.weights({ team, current }));
          }
          return replyEphemeral(i, '❌ إجراء غير صالح', COLORS.danger);
        },
},
     {
       data: new SlashCommandBuilder().setName('team-load').setDescription('توزيع العمل المسجل ومؤشر العدالة للفريق')
         .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'الدعم الفني', value: 'support' }, { name: 'الإشراف', value: 'moderation' }))
         .addIntegerOption(o => o.setName('days').setDescription('النافذة بالأيام (1-90)').setMinValue(1).setMaxValue(90)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team') || i.staffInfo?.team;
        if (!['support', 'moderation'].includes(team)) return i.editReply({ embeds: [embed('⚖️ توزيع الحمل', 'اختر فريقاً صالحاً.', COLORS.danger)] });
        const days = i.options.getInteger('days') || 7;
        return i.editReply({ embeds: [loadEmbed(team, load.teamLoad(team, days), days)] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('report-export').setDescription('تصدير التقارير المحفوظة بصيغة CSV')
        .addStringOption(o => o.setName('type').setDescription('نوع التقرير').setRequired(true).addChoices({ name: 'يومي', value: 'daily' }, { name: 'أسبوعي', value: 'weekly' }, { name: 'شهري', value: 'monthly' }))
        .addStringOption(o => o.setName('period').setDescription('الفترة أو جزء منها — اختياري').setMaxLength(30)),
      level: LEVELS.GENERAL_MANAGER,
      serverManagerOnly: true,
      async execute(i) {
        const type = i.options.getString('type');
        const period = i.options.getString('period');
        const rows = getDb().prepare(`SELECT * FROM saved_reports WHERE report_type = ? ${period ? 'AND period LIKE ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(period ? [type, `%${period}%`] : [type]));
        if (!rows.length) return replyEphemeral(i, '❌ لا توجد تقارير محفوظة بهذا الفلتر.', COLORS.warning);
        const file = new AttachmentBuilder(Buffer.from(reportsCsv(rows), 'utf8'), { name: `staff-reports-${type}.csv` });
        return i.reply({ content: `📊 تم تصدير ${rows.length} تقريراً.`, files: [file], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('rate-staff').setDescription('تقييم يدوي لإداري (يدخل في حساب Score)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('factor').setDescription('العامل').setRequired(true).addChoices(
          { name: 'تقييم المشرف (Helper)', value: 'supervisor_rating' }, { name: 'التفاعل مع الفريق (Helper)', value: 'team_interaction' }, { name: 'سرعة الاستجابة (الإشراف)', value: 'response_speed' }))
        .addStringOption(o => o.setName('grade').setDescription('التقدير').setRequired(true).addChoices(
          { name: 'ممتاز (25)', value: '25' }, { name: 'جيد جداً (20)', value: '20' }, { name: 'جيد (15)', value: '15' }, { name: 'مقبول (10)', value: '10' }, { name: 'ضعيف (5)', value: '5' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const s = staffService.get(user.id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        // هذا التقييم يدخل مباشرة في حساب Score — لا يمكن للمشرف تقييم نفسه لرفع رصيده.
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك تقييم نفسك.', COLORS.danger);
        const factor = i.options.getString('factor');
        // دفاع إضافي: factor يُستخدم كاسم عمود في تحديث SQL ديناميكي — يُقيَّد بقائمة صريحة
        // حتى مع ضمان Discord لقيم addChoices، لمنع أي حقن لو تغيّر مصدر القيمة مستقبلاً.
        if (!['supervisor_rating', 'team_interaction', 'response_speed'].includes(factor)) {
          return replyEphemeral(i, '❌ عامل تقييم غير صحيح.', COLORS.danger);
        }
        staffService.update(user.id, { [factor]: Number(i.options.getString('grade')), human_ratings_at: nowIso() });
        return replyEphemeral(i, `✅ تم تحديث التقييم لـ <@${user.id}>.`, COLORS.success);
      },
},
   ],
   components: {
    'score:weightsmodal': async (i, [team]) => {
      const keys = { helper: ['chat', 'presence', 'teamInteraction', 'supervisorRating'], support: ['tickets', 'speed', 'chat', 'presence'], moderation: ['actions', 'speed', 'activity', 'commitment'] }[team];
      if (!keys) return replyEphemeral(i, '❌ الفئة غير صحيحة.', COLORS.danger);
      const values = Object.fromEntries(keys.map(key => [key, Number(i.fields.getTextInputValue(key))]));
      if (Object.values(values).some(v => !Number.isInteger(v) || v < 0 || v > 100) || Object.values(values).reduce((sum, v) => sum + v, 0) !== 100) {
        return replyEphemeral(i, '❌ يجب أن تكون كل الأوزان أرقاماً بين 0 و100 ومجموعها يساوي 100.', COLORS.danger);
      }
settings.setScoreWeights(team, values);
       audit.record({ action: 'score_weights_updated', actorId: i.user.id, details: { team, values }, channelId: i.channelId });
       return replyEphemeral(i, `✅ تم حفظ أوزان **${team}**. سيظهر أثرها في التقارير الجديدة فوراً.`, COLORS.success);
},
   },
   performanceEmbed, leaderboardEmbed, teamEmbed,
};
