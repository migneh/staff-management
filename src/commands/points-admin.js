'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { COLORS, replyEphemeral, arDigits } = require('../utils');

/**
 * /points-admin — المنح اليدوي الموثّق (2026-10-24).
 *
 * قرار المالك D4 أزال الحقن والتجاوُزات الميتة من نقطة الدفتر، ووعد التعليق
 * في points.js بأن المسار يعود «عبر واجهة إدارة موثقة بحدود رقمية لكل سبب».
 *
 * هنا الوفاء بالوعد: القيمة تأتي من POINTS_DEFAULTS، لا حقن رقم إضافي.
 * السبب يلتقط فقط من قائمة محصورة. المرجع إلزامي، ووجوده يُفعّل الحماية
 * من التكرار (فهرس UNIQUE على reason_key/ref_type/ref_id): الحالة نفسها
 * لا تُمنح مرتين ما اختلفت صياغتها.
 *
 * سبب واحد حالياً: bug_found (+5) — الثغرة بلا مسار آلي (لا مصدر خارجي
 * متسلسل يمنحها مرجعاً نظيفاً)، فالإدارة تمنحها بمرجع المُشاهدة الدقيقة.
 */
const MANUAL_REASONS = [
  { value: 'bug_found', label: 'اكتشاف ثغرة (+5)', cause: 'اكتشاف ثغرة' },
];

/**
 * نصّ دفتر المنحة من القاعدة ذاتها (البند ⑪): (السبب) (مرجع فريد) (+الملاحظة).
 * كل سبب ينضم لاحقاً يكتب دفتره بهويته هو (cause)، ولا تتسلل صياغة السبب
 * الأول إلى دفاتر قادمة. وإن غاب عن القائمة فالمفتاح هو هويته — لا لقب
 * سببٍ غرب.
 */
function ledgerReason(reasonKey, ref, note, table = MANUAL_REASONS) {
  const rule = table.find(r => r.value === reasonKey);
  const cause = rule?.cause || reasonKey;
  return note ? `${cause} (مرجع ${ref}) — ${note}` : `${cause} (مرجع ${ref})`;
}

const ID_RE = /^\d{15,22}$/;

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('points-admin')
        .setDescription('منح نقاط إداري بقيمة ثابتة مع مرجع يمنع التكرار (موجة نقاط D4)')
        .addUserOption(o => o.setName('member').setDescription('الإداري المستحق').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب المنح').setRequired(true)
          .addChoices(...MANUAL_REASONS.map(r => ({ name: r.label, value: r.value }))))
        .addStringOption(o => o.setName('ref').setDescription('مرجع فريد للحالة، مثل bug-2026-014').setRequired(true).setMaxLength(60))
        .addStringOption(o => o.setName('note').setDescription('وصف مختصر يُسجَّل في التدقيق').setRequired(false).setMaxLength(280)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const targetUser = i.options.getUser('member');
        if (!targetUser || !ID_RE.test(targetUser.id)) {
          return replyEphemeral(i, '❌ حدد الإداري المستحق بمعرّف صحيح.', COLORS.danger);
        }
        const reasonKey = i.options.getString('reason');
        const ref = (i.options.getString('ref') || '').trim();
        if (!ref) return replyEphemeral(i, '❌ المرجع مطلوب — هو ما يمنع منح نفس الحالة مرتين.', COLORS.danger);

        const member = staffService.get(targetUser.id);
        if (!member) return replyEphemeral(i, '❌ هذا المستخدم ليس في سجل الإداريين.', COLORS.danger);
        // منع المنح الذاتي (قرار المالك): مُنحِي بنفسه المستفيد يفقد
        // حياد المنح، فتُرفض المحاولة دائماً حتى على أعلى مستوى إداري.
        if (targetUser.id === i.user.id) {
          return replyEphemeral(i, '❌ لا منح ذاتي — منح النقاط اليدوية يحتاج مُنحِياً غير المستفيد. إن رأيت جهدك يستحق المكافأة فاطلب من إدارة أعلى منحها لك.', COLORS.danger);
        }

        const rule = MANUAL_REASONS.find(r => r.value === reasonKey);
        const note = (i.options.getString('note') || '').trim();
        const r = points.add({
          userId: targetUser.id,
          reasonKey,
          reason: ledgerReason(reasonKey, ref, note),
          refType: 'bug',
          refId: ref,
          addedBy: i.user.id,
        });
        if (!r.ok) {
          let text = `❌ لم تُمنح النقاط: ${r.reason}.`;
          if (r.reason === 'مكرَّر') text = `ℹ️ المرجع \`${ref}\` ممنوح من قبل — نفس الحالة لا تُكرّر المنح.`;
          else if (r.reason === 'مجمَّد') text = `❄️ نقاط العضو مجمّدة حتى ${r.until} (السبب: ${r.freezeReason}) — لم يُمنح شيء.`;
          return replyEphemeral(i, text, COLORS.warning);
        }
        audit.record({
          action: 'points_manual_grant',
          actorId: i.user.id,
          targetId: targetUser.id,
          details: { reasonKey, ref, points: r.points, balance: r.balance, note: note || null },
          channelId: i.channelId,
        });
        return replyEphemeral(i, `✅ مُنح <@${targetUser.id}> **+${arDigits(r.points)}** (${rule.label}) بمرجع \`${ref}\` — رصيده: ${arDigits(r.balance)}.`, COLORS.success);
      },
    },
  ],
  ledgerReason,
};
