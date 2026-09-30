'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, WARNING_TYPES } = require('../constants');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, dm } = require('../utils');

function appealEmbed(row, color = COLORS.warning) {
  const warning = row.warning_type ? `${WARNING_TYPES[row.warning_type]?.label || row.warning_type} #${row.warning_id}` : `إنذار #${row.warning_id}`;
  return embed(`⚖️ استئناف ${warning}`, `<@${row.user_id}>\n\n**السبب:** ${row.reason}\n\nالحالة: **${row.status === 'pending' ? 'بانتظار القرار' : row.status === 'approved' ? 'أُزيل الإنذار' : 'رُفض'}**`, color);
}

function reviewRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`appeal:approve:${id}`).setLabel('قبول وإلغاء الإنذار').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`appeal:reject:${id}`).setLabel('رفض الاستئناف').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('appeal-warning').setDescription('استئناف إنذار صادر عليك')
        .addIntegerOption(o => o.setName('warning_id').setDescription('رقم الإنذار الظاهر في /my-record').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الاستئناف').setRequired(true).setMaxLength(600)),
      level: LEVELS.STAFF,
      async execute(i) {
        const warningId = i.options.getInteger('warning_id');
        const warning = getDb().prepare('SELECT * FROM warnings WHERE id = ? AND user_id = ? AND voided_at IS NULL').get(warningId, i.user.id);
        if (!warning) return replyEphemeral(i, '❌ الإنذار غير موجود في سجلك أو تمت معالجته مسبقاً.', COLORS.danger);
        const duplicate = getDb().prepare("SELECT id FROM warning_appeals WHERE warning_id = ? AND status = 'pending'").get(warningId);
        if (duplicate) return replyEphemeral(i, `ℹ️ يوجد استئناف مفتوح مسبقاً (#${duplicate.id}).`, COLORS.info);
        const reason = i.options.getString('reason').trim();
        const result = getDb().prepare('INSERT INTO warning_appeals (warning_id, user_id, reason) VALUES (?, ?, ?)').run(warningId, i.user.id, reason);
        const row = getDb().prepare('SELECT * FROM warning_appeals WHERE id = ?').get(result.lastInsertRowid);
        audit.record({ action: 'warning_appealed', actorId: i.user.id, targetId: i.user.id, details: { appealId: row.id, warningId, reason }, channelId: i.channelId });
        await sendToChannel(i.client, 'manager-review', { embeds: [appealEmbed({ ...row, warning_type: warning.warning_type })], components: [reviewRow(row.id)] });
        return replyEphemeral(i, `✅ تم تسجيل الاستئناف #${row.id}. سيصدر القرار من الإدارة دون تعديل الإنذار تلقائياً.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-warning-appeals').setDescription('مراجعة استئنافات الإنذارات')
        .addStringOption(o => o.setName('status').setDescription('الحالة').addChoices({ name: 'مفتوحة', value: 'pending' }, { name: 'كل الحالات', value: 'all' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const all = i.options.getString('status') === 'all';
        const rows = getDb().prepare(`SELECT a.*, w.warning_type FROM warning_appeals a JOIN warnings w ON w.id = a.warning_id ${all ? '' : "WHERE a.status = 'pending'"} ORDER BY a.id DESC LIMIT 10`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد استئنافات إنذارات.', COLORS.success);
        return i.reply({ embeds: rows.map(appealEmbed), components: rows.filter(r => r.status === 'pending').slice(0, 5).map(r => reviewRow(r.id)), ephemeral: true });
      },
    },
  ],
  components: {
    'appeal:approve': async (i, [id]) => decide(i, id, 'approved'),
    'appeal:reject': async (i, [id]) => decide(i, id, 'rejected'),
  },
};

async function decide(i, id, status) {
  const db = getDb();
  const row = db.prepare("SELECT a.*, w.warning_type, w.issued_by, w.reason warning_reason FROM warning_appeals a JOIN warnings w ON w.id = a.warning_id WHERE a.id = ? AND a.status = 'pending'").get(Number(id));
  if (!row) return replyEphemeral(i, '❌ الاستئناف غير موجود أو تمت مراجعته.', COLORS.danger);
  // منع مراجعة استئناف مقدَّم من نفس الشخص، ومنع مُصدر الإنذار الأصلي من الحكم على استئنافه.
  if (row.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك مراجعة استئنافك الخاص. يجب أن يراجعه إداري آخر.', COLORS.danger);
  if (row.issued_by && row.issued_by === i.user.id) return replyEphemeral(i, '❌ لا يمكنك مراجعة استئناف إنذار أصدرته أنت بنفسك.', COLORS.danger);
  let reversed = 0;
  if (status === 'approved') {
    reversed = 0; // لا توجد نقاط مرتبطة بالإنذارات في هذا النظام — التصريح بالإلغاء فقط
    const target = staffService.get(row.user_id);
    if (!target) return replyEphemeral(i, '❌ العضو غير مسجل حالياً.', COLORS.danger);
    db.prepare('UPDATE warnings SET voided_at = datetime(\'now\'), voided_by = ?, void_reason = ? WHERE id = ?').run(i.user.id, `قبول الاستئناف #${row.id}`, row.warning_id);
  }
  db.prepare('UPDATE warning_appeals SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime(\'now\') WHERE id = ?')
    .run(status, i.user.id, status === 'approved' ? 'تم قبول الاستئناف وإلغاء الإنذار' : 'تم رفض الاستئناف', row.id);
  const updated = db.prepare('SELECT a.*, w.warning_type FROM warning_appeals a JOIN warnings w ON w.id = a.warning_id WHERE a.id = ?').get(row.id);
  audit.record({ action: `warning_appeal_${status}`, actorId: i.user.id, targetId: row.user_id, details: { appealId: row.id, warningId: row.warning_id, reversed }, channelId: i.channelId });
  await i.update({ embeds: [appealEmbed(updated, status === 'approved' ? COLORS.success : COLORS.gray)], components: [] });
  await dm(i.client, row.user_id, { embeds: [embed(status === 'approved' ? '✅ قُبل استئنافك' : '❌ رُفض استئنافك', status === 'approved' ? `أُلغي الإنذار #${row.warning_id}.` : `رُفض استئنافك على الإنذار #${row.warning_id}. يمكنك التواصل مع الإدارة لمزيد من التوضيح.`, status === 'approved' ? COLORS.success : COLORS.warning)] });
  return null;
}
