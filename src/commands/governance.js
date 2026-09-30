'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, GENERAL_MANAGEMENT_RANKS } = require('../constants');
const { getDb } = require('../database');
const settings = require('../services/settings');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, log } = require('../utils');

const rankChoices = GENERAL_MANAGEMENT_RANKS.map(r => ({ name: r.name, value: r.name }));

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('manage-general').setDescription('تعيين أو إزالة عضو من الإدارة العامة للسيرفر')
        .addStringOption(o => o.setName('action').setDescription('العملية').setRequired(true)
          .addChoices({ name: 'تعيين', value: 'assign' }, { name: 'إزالة', value: 'remove' }))
        .addUserOption(o => o.setName('user').setDescription('العضو').setRequired(true))
        .addStringOption(o => o.setName('rank').setDescription('رتبة الإدارة العامة').setRequired(true).addChoices(...rankChoices))
        .addStringOption(o => o.setName('reason').setDescription('السبب').setRequired(false).setMaxLength(500)),
      level: LEVELS.STAFF,
      serverManagerOnly: true,
      async execute(i) {
        const action = i.options.getString('action');
        const user = i.options.getUser('user');
        const rank = i.options.getString('rank');
        const reason = i.options.getString('reason') || null;
        const roleId = settings.roleId('general_management', rank);
        if (!roleId) return replyEphemeral(i, `❌ لم يتم ربط رتبة **${rank}**. افتح /setup ثم حدد رتب الإدارة العامة.`, COLORS.danger);
        if (user.bot) return replyEphemeral(i, '❌ لا يمكن تعيين بوت في الإدارة العامة.', COLORS.danger);

        const member = await i.guild.members.fetch(user.id).catch(() => null);
        if (!member) return replyEphemeral(i, '❌ العضو غير موجود في السيرفر.', COLORS.danger);
        const botMember = i.guild.members.me;
        const role = i.guild.roles.cache.get(roleId);
        if (!role) return replyEphemeral(i, '❌ رتبة الإدارة العامة لم تعد موجودة.', COLORS.danger);
        if (botMember && role.position >= botMember.roles.highest.position) return replyEphemeral(i, '❌ رتبة البوت يجب أن تكون أعلى من رتبة الإدارة العامة.', COLORS.danger);

        const db = getDb();
        const existed = staffService.get(user.id);
        if (action === 'assign') {
          if (rank === 'General Manager') {
            const current = db.prepare("SELECT user_id FROM staff_members WHERE team = 'general_management' AND rank = 'General Manager' AND status != 'resigned' AND user_id != ?").get(user.id);
            if (current) return replyEphemeral(i, `❌ يوجد General Manager حالي بالفعل: <@${current.user_id}>. أزله أولاً أو استخدم قرار نقل واضح.`, COLORS.danger);
          }
          const removed = await staffService.removeAllStaffRoles(member);
          if (!removed) return replyEphemeral(i, '❌ لم أستطع إزالة الرتب الإدارية القديمة. تحقق من صلاحيات البوت.', COLORS.danger);
          try { await member.roles.add(roleId, `تعيين ${rank} عبر Staff Manager`); } catch (e) { return replyEphemeral(i, `❌ فشل إضافة الرتبة: ${e.message}`, COLORS.danger); }
          const saved = staffService.ensure(member, { reinstate: true });
          if (saved) staffService.update(user.id, { status: 'active' });
          staffService.recordRankChange(user.id, {
            fromRank: existed?.rank || null,
            toRank: rank,
            team: 'general_management',
            changeType: existed?.status === 'resigned' ? 'reinstate' : existed ? 'reassign' : 'promote',
            reason,
            actorId: i.user.id,
          });
          audit.record({ action: 'general_management_assigned', actorId: i.user.id, targetId: user.id, details: { rank, reason }, channelId: i.channelId });
          await log(i.client, '🏛️ تعيين في الإدارة العامة', `<@${user.id}> أصبح **${rank}** بواسطة <@${i.user.id}>${reason ? `\nالسبب: ${reason}` : ''}`, COLORS.success);
          return i.reply({ embeds: [embed('✅ تم التعيين', `<@${user.id}> أصبح **${rank}** في **الإدارة العامة للسيرفر**.\n\nلا توجد ترقية تلقائية لهذه الرتبة؛ أي تغيير لاحق يحتاج قراراً من Server Manager أو General Manager الحالي.`, COLORS.success)], ephemeral: true });
        }

        const existing = staffService.get(user.id);
        if (!existing || existing.team !== 'general_management') return replyEphemeral(i, '❌ هذا العضو ليس مسجلاً في الإدارة العامة.', COLORS.danger);
        const removed = await staffService.removeAllStaffRoles(member);
        if (!removed) return replyEphemeral(i, '❌ لم أستطع إزالة الرتب الإدارية. تحقق من صلاحيات البوت.', COLORS.danger);
        staffService.setStatus(user.id, 'resigned');
        staffService.recordRankChange(user.id, { fromRank: existing.rank, toRank: existing.rank, team: 'general_management', changeType: 'remove', reason, actorId: i.user.id });
        audit.record({ action: 'general_management_removed', actorId: i.user.id, targetId: user.id, details: { previousRank: existing.rank, reason }, channelId: i.channelId });
        await log(i.client, '🏛️ إزالة من الإدارة العامة', `<@${user.id}> — ${existing.rank} — بواسطة <@${i.user.id}>${reason ? `\nالسبب: ${reason}` : ''}`, COLORS.warning);
        return i.reply({ embeds: [embed('✅ تمت الإزالة', `تمت إزالة <@${user.id}> من الإدارة العامة وإزالة الرتب الإدارية المرتبطة به.`, COLORS.success)], ephemeral: true });
      },
    },
  ],
  components: {},
};
