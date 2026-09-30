'use strict';
const { homeRow } = require('../ui/navigation');
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, NOTE_TYPES, WARNING_TYPES, TEAMS, STATUS } = require('../constants');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, dm, log, discordTs, sendToChannel, arDigits } = require('../utils');
const staffSync = require('../services/staffSync');
const { snapshot } = staffSync;

function recordEmbed(userId, { includeSecret }) {
  const db = getDb();
  const notes = db.prepare(`SELECT * FROM staff_notes WHERE user_id = ? ${includeSecret ? '' : 'AND is_secret = 0'} ORDER BY id DESC LIMIT 10`).all(userId);
  const warns = db.prepare('SELECT * FROM warnings WHERE user_id = ? ORDER BY id DESC LIMIT 10').all(userId);
  const s = staffService.get(userId);
  const e = embed(`📁 سجل الإداري ${userId}`, null, COLORS.info)
    .setDescription(`👤 <@${userId}>${s ? ` • ${s.rank} • ${TEAMS[s.team] || s.team}` : ''}`);
  // ===== تاريخ الرتب: من رقّى مَن ومتى =====
  const RANK_CHANGE = {
    promote: '⬆️ ترقية', demote: '⬇️ تنزيل', reassign: '↔️ إعادة تعيين', reinstate: '↩️ إعادة تفعيل',
    remove: '🚪 إزالة', left_guild: '👋 مغادرة السيرفر',
  };
  const rankRows = staffService.rankHistory(userId, 5);
  if (rankRows.length) {
    e.addFields({
      name: '📜 تاريخ الرتب',
      value: rankRows.map(r => {
        const to = r.change_type === 'remove' || r.change_type === 'left_guild' ? r.from_rank : r.to_rank;
        const from = r.from_rank && r.from_rank !== to ? `${r.from_rank} → ` : '';
        const who = r.actor_id ? ` • <@${r.actor_id}>` : '';
        return `${RANK_CHANGE[r.change_type] || r.change_type}: ${from}**${to || '—'}** • ${discordTs(r.created_at, 'd')}${who}`;
      }).join('\n').slice(0, 1024),
    });
  }
  e.addFields({
    name: `⚠️ الإنذارات (${warns.length})`,
    value: warns.length ? warns.map(w => `${WARNING_TYPES[w.warning_type]?.emoji} **#${w.id} ${WARNING_TYPES[w.warning_type]?.label}**${w.voided_at ? ' ⚖️ ملغى بالاستئناف' : ''} — ${w.reason} • ${discordTs(w.created_at, 'd')} • <@${w.issued_by}>`).join('\n').slice(0, 1024) : 'لا يوجد',
  }, {
    name: `📝 الملاحظات (${notes.length})`,
    value: notes.length ? notes.map(n => `${NOTE_TYPES[n.note_type]?.emoji}${n.is_secret ? '🔒' : ''} ${n.content} • ${discordTs(n.created_at, 'd')}`).join('\n').slice(0, 1024) : 'لا يوجد',
  });
  return e;
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('add-note').setDescription('إضافة ملاحظة على إداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('النوع').setRequired(true).addChoices({ name: '🟢 إيجابية (+5)', value: 'positive' }, { name: '🟡 سلبية (-10)', value: 'negative' }))
        .addStringOption(o => o.setName('content').setDescription('نص الملاحظة').setRequired(true).setMaxLength(500))
        .addBooleanOption(o => o.setName('secret').setDescription('ملاحظة سرية (للإدارة فقط)')),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const content = i.options.getString('content');
        const secret = i.options.getBoolean('secret') ? 1 : 0;
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        // ملاحظة إيجابية تمنح +5 في الحساب — لا يمكن للإداري تسجيلها على نفسه.
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إضافة ملاحظة على نفسك.', COLORS.danger);
        const res = getDb().prepare('INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by) VALUES (?, ?, ?, ?, ?)').run(user.id, type, content, secret, i.user.id);
        audit.record({ action: 'staff_note_added', actorId: i.user.id, targetId: user.id, details: { type, secret: !!secret, rowId: res.lastInsertRowid }, channelId: i.channelId });
        const def = NOTE_TYPES[type];
        await replyEphemeral(i, `${def.emoji} تمت إضافة ${def.label} على <@${user.id}>${secret ? ' 🔒' : ''}.`, COLORS.success);
        if (!secret) await dm(i.client, user.id, { embeds: [embed(`${def.emoji} ${def.label} جديدة`, `${content}`, type === 'positive' ? COLORS.success : COLORS.warning)] });
        return log(i.client, `${def.emoji} ${def.label}${secret ? ' 🔒' : ''}`, `على <@${user.id}> بواسطة <@${i.user.id}>\n${content}`, COLORS.gray);
      },
    },
    {
      data: new SlashCommandBuilder().setName('staff-record').setDescription('عرض سجل إداري (إنذارات وملاحظات)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        return i.reply({ embeds: [recordEmbed(user.id, { includeSecret: i.staffLevel >= LEVELS.MANAGEMENT })], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-record').setDescription('عرض سجلك الشخصي'),
      level: LEVELS.STAFF,
      async execute(i) { return i.reply({ embeds: [recordEmbed(i.user.id, { includeSecret: false })], components: [homeRow()], ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('unsuspend').setDescription('رفع الإيقاف عن إداري قبل انتهاء مدته (Boss أو أعلى)')
        .addUserOption(o => o.setName('user').setDescription('الإداري الموقوف').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب رفع الإيقاف').setRequired(true).setMaxLength(300)),
      level: LEVELS.BOSS,
      async execute(i) {
        const user = i.options.getUser('user');
        const reason = i.options.getString('reason');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (target.status !== 'suspended') {
          return replyEphemeral(i, `❌ <@${user.id}> ليس موقوفاً حالياً (الحالة: **${STATUS[target.status] || target.status}**).`, COLORS.danger);
        }
        staffService.unsuspend(user.id);
        audit.record({ action: 'staff_unsuspended', actorId: i.user.id, targetId: user.id, details: { reason, wasUntil: target.suspended_until || null }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تم رفع الإيقاف عن <@${user.id}> وعاد إلى الحالة النشطة.\n_تبقى فترة تبريد الترقية كما هي حتى انتهائها._`, COLORS.success);
        await dm(i.client, user.id, { embeds: [embed('✅ رُفع الإيقاف', `تمت إعادة تفعيل حسابك الإداري.\n**السبب:** ${reason}\n\nنعتذر عن أي إزعاج، ومرحباً بعودتك.`, COLORS.success)] });
        return log(i.client, '↩️ رفع إيقاف', `<@${user.id}> بواسطة <@${i.user.id}>\n${reason}`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('sync-staff').setDescription('تسجيل كل الإداريين من رتبهم في ديسكورد مرة واحدة (بدل انتظار رسالة من كل عضو)')
        .addBooleanOption(o => o.setName('report').setDescription('إرسال التقرير إلى قناة سجلات البوت'))
        .addBooleanOption(o => o.setName('quiet').setDescription('عرض الملخص فقط دون قوائم الأسماء')),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const guild = i.guild || await i.client.guilds.fetch(i.guildId);
        const report = await staffSync.syncGuild(guild, { actorId: i.user.id });
        if (report.error) return i.editReply({ embeds: [embed('⚠️ تعذّرت المزامنة', report.error, COLORS.warning)] });
        const quiet = i.options.getBoolean('quiet') === true;
        const e = staffSync.reportEmbed(report, { title: '🔄 مزامنة الإداريين' });
        if (quiet) e.spliceFields(0, e.data.fields?.length || 0);
        if (i.options.getBoolean('report')) {
          await sendToChannel(i.client, 'staff-logs', { embeds: [staffSync.reportEmbed(report, { title: '🔄 مزامنة الإداريين — تقرير كامل' })] });
        }
        const stats = snapshot();
        e.addFields({ name: '📚 الحالة بعد المزامنة', value: [
          `المسجّلون: **${arDigits(stats.total)}** • نشط: **${arDigits(stats.active)}** • تجريبي: **${arDigits(stats.probation)}**`,
          `إجازة/إيقاف: **${arDigits(stats.away)}** • خارج الفريق: **${arDigits(stats.out)}**`,
          stats.unknown ? `⚠️ **${arDigits(stats.unknown)}** سجلاً برتبة غير مربوطة في /setup` : '✅ كل الرتب المسجّلة مربوطة بإعدادات البوت',
        ].join('\n') });
        return i.editReply({ embeds: [e] });
      },
    },
  ],
  components: {},
};
