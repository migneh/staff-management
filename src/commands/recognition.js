'use strict';
/**
 * التقدير («جدار الإنجازات») — nominate → approve → announce.
 *
 * لا يوجد في هذا الملف أي نظام نقاط. نظام النقاط (services/points.js وجدول
 * promotion_points) أُزيل من المشروع، فالنقاط هنا صفر دائماً ولا يوجد سجل
 * أرصدة يُحدَّث. ما يتبقّى هو جدار إنجازات: ترشيح من زميل، ثم موافقة
 * إلزامية من الإدارة، وعندها فقط يُنشر الإنجاز في قناة staff-wins ويُرسل
 * إشعار للعضو. الرفض لا يمنح شيئاً ولا يعلن شيئاً.
 *
 * البنية مقصودة نسخة من appeals.js: نفس المستوى، ونفس أزرار الشريط الملتقط
 * بنفس اصطلاح customId النقطتين، ونفس دالة decide() في الذيل.
 */
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, RECOGNITION } = require('../constants');
const { getDb } = require('../database');
const clock = require('../clock');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { tsRelative } = require('../ui/kit');
const { embed, COLORS, replyEphemeral, sendToChannel, dm } = require('../utils');

const STATUS_LABEL = { pending: 'بانتظار القرار', approved: 'مُعتمد', rejected: 'مرفوض' };

/** سقف الترشيحات اليومي — يُحسب بمقارنة عمود day بتوقيت السيرفر (clock.today). */
function usedToday(nominatorId) {
  return getDb().prepare('SELECT COUNT(*) n FROM recognition_nominations WHERE nominator_id = ? AND day = ?')
    .get(nominatorId, clock.today()).n;
}

function nominationEmbed(row, color = COLORS.info) {
  const lines = [
    `<@${row.target_id}>`,
    '',
    `**السبب:** ${row.reason}`,
    '',
    `رشّحه: <@${row.nominator_id}> ${tsRelative(row.created_at)}`,
    `الحالة: **${STATUS_LABEL[row.status] || row.status}**`,
  ];
  if (row.reviewed_by) lines.push(`راجعها: <@${row.reviewed_by}> ${tsRelative(row.reviewed_at)}`);
  return embed('🏆 ترشيح تقدير', lines.join('\n'), color);
}

/** نص يُنشر في staff-wins — لا يُبنى إلا بعد الاعتماد. */
function announcementEmbed(row, reviewerId) {
  return embed('🏆 إنجاز يستحق الاحتفاء', [
    `<@${row.target_id}> — شكراً لك!`,
    '',
    `**على يد:** ${row.reason}`,
    '',
    `رشّحه <@${row.nominator_id}> واعتمده <@${reviewerId}>.`,
  ].join('\n'), COLORS.success);
}

function reviewRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`recognition:approve:${id}`).setLabel('اعتماد ونشر الإنجاز').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`recognition:reject:${id}`).setLabel('رفض الترشيح').setEmoji('❌').setStyle(ButtonStyle.Danger),
  );
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('shoutout').setDescription('رشّح زميلاً بإنجاز يستحق التقدير — يُنشر بعد اعتماد الإدارة')
        .addUserOption(o => o.setName('member').setDescription('الزميل المرشَّح').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الترشيح').setRequired(true).setMaxLength(RECOGNITION.reasonMaxLength)),
      level: LEVELS.STAFF,
      async execute(i) {
        const targetId = i.options.getUser('member').id;
        if (targetId === i.user.id) return replyEphemeral(i, '❌ لا يمكنك ترشيح نفسك.', COLORS.danger);
        const target = staffService.get(targetId);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري، فلا يمكن ترشيحه.', COLORS.danger);

        // السقف اليومي — README ينص على "ترشيحاً محدوداً يومياً" دون رقم؛ الرقم في constants.RECOGNITION.dailyCap.
        const used = usedToday(i.user.id);
        if (used >= RECOGNITION.dailyCap) {
          return replyEphemeral(i, `⏳ بلغت الحد الأقصى للترشيحات اليوم (${RECOGNITION.dailyCap}). يمكنك الترشيح غداً.`, COLORS.warning);
        }

        const reason = i.options.getString('reason').trim();
        if (!reason) return replyEphemeral(i, '❌ سبب الترشيح مطلوب.', COLORS.danger);

        // ترشيح = صف فقط. لا إعلان ولا إشعار ولا نقاط حتى تعتمد الإدارة.
        const result = getDb().prepare('INSERT INTO recognition_nominations (nominator_id, target_id, reason, day) VALUES (?, ?, ?, ?)')
          .run(i.user.id, targetId, reason, clock.today());
        const row = getDb().prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(result.lastInsertRowid);
        audit.record({
          action: 'recognition_nominated',
          actorId: i.user.id,
          targetId,
          details: { nominationId: row.id, reason, usedToday: used + 1, dailyCap: RECOGNITION.dailyCap },
          channelId: i.channelId,
        });
        await sendToChannel(i.client, 'manager-review', { embeds: [nominationEmbed(row)], components: [reviewRow(row.id)] });
        return replyEphemeral(i, `✅ سُجّل الترشيح #${row.id} لـ <@${targetId}> في قائمة الانتظار. لن يُنشر الإنجاز ولا يُرسل إشعار قبل اعتماد الإدارة.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-shoutouts').setDescription('مراجعة ترشيحات التقدير المعلقة')
        .addStringOption(o => o.setName('status').setDescription('الحالة').addChoices({ name: 'معلقة', value: 'pending' }, { name: 'كل الحالات', value: 'all' })),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const all = i.options.getString('status') === 'all';
        const rows = getDb().prepare(`SELECT * FROM recognition_nominations ${all ? '' : "WHERE status = 'pending'"} ORDER BY id DESC LIMIT 10`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد ترشيحات تقدير.', COLORS.success);
        // Discord يقبل 5 ActionRows كحد أقصى — نفس حد appeals.
        return i.reply({
          embeds: rows.map(r => nominationEmbed(r, r.status === 'approved' ? COLORS.success : r.status === 'rejected' ? COLORS.gray : COLORS.info)),
          components: rows.filter(r => r.status === 'pending').slice(0, 5).map(r => reviewRow(r.id)),
          ephemeral: true,
        });
      },
    },
  ],
  components: {
    'recognition:approve': async (i, [id]) => decide(i, id, 'approved'),
    'recognition:reject': async (i, [id]) => decide(i, id, 'rejected'),
  },
};

async function decide(i, id, status) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM recognition_nominations WHERE id = ? AND status = 'pending'").get(Number(id));
  if (!row) return replyEphemeral(i, '❌ الترشيح غير موجود أو تمت مراجعته.', COLORS.danger);
  // لا يعتمد الإداري ترشيحه هو.
  if (row.nominator_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك مراجعة ترشيح قدّمته بنفسك. يجب أن يعتمد إداري آخر.', COLORS.danger);

  // الاعتماد هو المسار الوحيد إلى النشر، فنُثبّت الحالة أولاً وبشرط status='pending'.
  // هذا يمنع النشر المزدوج عند النقر المتكرر على الزر.
  const result = db.prepare("UPDATE recognition_nominations SET status = ?, reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(status, i.user.id, row.id);
  if (!result.changes) return replyEphemeral(i, '❌ تمت مراجعة هذا الترشيح مسبقاً.', COLORS.danger);

  const updated = db.prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(row.id);
  // نؤجل قبل النشر في staff-wins وقبل إرسال الخاص. الحالة كُتبت قبل التأجيل،
  // فكان المراجع يرى «فشل التفاعل» على اعتماد نجح — ثم يضغط مرة أخرى فيصطدم
  // بالحارس «تمت مراجعة هذا الترشيح مسبقاً» ولا يعرف أن الاعتماد نجح.
  await i.deferUpdate();
  audit.record({
    action: `recognition_${status}`,
    actorId: i.user.id,
    targetId: updated.target_id,
    details: { nominationId: updated.id, nominatorId: updated.nominator_id, points: RECOGNITION.points },
    channelId: i.channelId,
  });

  // لا شيء يُنشر في الرفض: لا إعلان ولا إنجاز ولا رصيد.
  if (status === 'approved') {
    if (!staffService.get(updated.target_id)) {
      // بعد deferUpdate لا يصلح reply — editReply يُنهي الرد المؤجل. ترك
      // replyEphemeral هنا كان يترك رسالة الزر معلّقة على «جارٍ التنفيذ» للأبد.
      return i.editReply({ embeds: [embed(null, '⚠️ اعتُمد الترشيح لكن العضو لم يعد مسجلاً، فلم يُنشر الإنجاز.', COLORS.warning)], allowedMentions: { parse: [] } });
    }
    await sendToChannel(i.client, 'staff-wins', { embeds: [announcementEmbed(updated, i.user.id)] });
    await dm(i.client, updated.target_id, {
      embeds: [embed('🏆 تم الاعتماد على ترشيحك', `شكراً لك. رشّحك <@${updated.nominator_id}> واعتمدته الإدارة، ونُشر إنجازك في قناة الإنجازات.`, COLORS.success)],
    });
  } else {
    await dm(i.client, updated.nominator_id, {
      embeds: [embed('❌ رُفض الترشيح', `لم يُعتمد ترشيحك لـ <@${updated.target_id}>، ولم يُنشر أي إنجاز. يمكنك التواصل مع الإدارة للتوضيح.`, COLORS.warning)],
    });
  }

  await i.editReply({ embeds: [nominationEmbed(updated, status === 'approved' ? COLORS.success : COLORS.gray)], components: [] });
  return null;
}
