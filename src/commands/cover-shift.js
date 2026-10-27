'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const clock = require('../clock');
const { COLORS, replyEphemeral, arDigits } = require('../utils');
const kit = require('../ui/kit');

/**
 * /cover-shift — تسجيل تغطية شفت زميل (+3 shift_cover) — موجات نقاط 2026-10-24.
 *
 * المصدر ذاتي الاعتماد بطبيعته، لذا وُضعت حواجزه بحساب لا بثقة:
 *  • يفتح لـ SUPERVISOR فأعلى: المشرف هو من يرى التغطية بعينه، فليس كل إداري
 *    يعلن عن نفسه.
 *  • مرجع فريد (يوم + المغطى): تغطية شفت زميل واحد لا تُسجَّل مرتين في اليوم،
 *    وتغطيتاه لزميلَين مختلفين في نفس اليوم مرجعَان مختلفان فيُقبلان.
 *  • سقف يومي 6 نقطة (DAILY_CAPS_DEFAULTS.shift_cover) = تغطيتان بقيمة 3:
 *    العدّاد نقاط لا طلَبات، فتكوين السقف بالقيمة يجعل «تغطيتين» حرفياً.
 *  • بوابة المُغطِّي (قرار المالك): نفس شرط المغطى عليه — من على إجازة
 *    أو موقوف ليس في صفة عمله، فلا تغطية له ولا نقاط.
 *
 * النقاط للقائم بالتغطية (المتفاعل) لا للمغطى عليه؛ وقيمة السبب ومرجعه ثابتة
 * في الدفتر لا في هذه الواجهة — الواجهة صرفاً طاولة تسجيل.
 */

/** المغطى عليه عضو نشط بحدث فعلاً — تغطية شفت مقيد/موقوف لا معنى عملية لها. */
function coverable(member) {
  return member && ['active', 'probation'].includes(member.status);
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('cover-shift')
        .setDescription('تسجيل تغطيتك شفت زميل = +3 نقاط (سقف تغطيتين باليوم)')
        .addUserOption(o => o.setName('covered').setDescription('الإداري الذي غطِيته شفته').setRequired(true))
        .addStringOption(o => o.setName('note').setDescription('ملاحظة قصيرة عن التغطية').setRequired(false).setMaxLength(280)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const coveredUser = i.options.getUser('covered');
        if (!coveredUser) return replyEphemeral(i, '❌ حدد الإداري الذي غطِيته شفته.', COLORS.danger);
        const covererId = i.user.id;
        if (coveredUser.id === covererId) return replyEphemeral(i, '❌ لا تغطية لنفسك — التغطية تعني انشغال زميل.', COLORS.danger);
        const coverer = staffService.get(covererId);
        if (!coverer) return replyEphemeral(i, 'لست مسجلاً في سجل الإداريين — لا نقاط تُمنح لغير أهل الدفتر.', COLORS.warning);
        // بوابة المُغطِّي (قرار المالك ضمن إحاطة ⑨): نفس قاعدة المغطى عليه —
        // من على إجازة أو موقوف ليس في صفة عمل اليوم، فتغطيته لا تُحتسب.
        if (!coverable(coverer)) {
          return replyEphemeral(i, '❌ التغطية تُسجَّل لمن هو في صفة عمله اليوم — وضعك الحالي (إجازة أو إيقاف) لا يجعلك مؤهلاً لنقاط تغطية.', COLORS.danger);
        }
        const covered = staffService.get(coveredUser.id);
        if (!coverable(covered)) {
          return replyEphemeral(i, '❌ العضو المذكور غير مسجل بصفة نشطة — تغطية شفت مجندة أو موقوفة لا تُمنح نقاطاً.', COLORS.danger);
        }
        const note = (i.options.getString('note') || '').trim();
        const r = points.add({
          userId: covererId,
          reasonKey: 'shift_cover',
          reason: note ? `تغطية شفت زميل (ملاحظة: ${note})` : 'تغطية شفت زميل',
          refType: 'shift',
          refId: `${clock.today()}:${coveredUser.id}`,
          addedBy: covererId,
        });
        if (!r.ok) {
          let text = `❌ لم تُمنح النقاط: ${r.reason}.`;
          if (r.reason === 'سقف يومي') text = `ℹ️ بلغت سقف التغطية اليومي (${arDigits(r.cap)} نقطة — تغطيتان) — حاول غداً.`;
          else if (r.reason === 'مكرَّر') text = 'ℹ️ تغطية نفس الزميل في هذا اليوم مسجّلة مسبقاً.';
          else if (r.reason === 'مجمَّد') text = `❄️ نقاطك مجمّدة حتى ${kit.dateLine(r.until)} (السبب: ${r.freezeReason}) — لم تُمنح نقاط التغطية.`;
          return replyEphemeral(i, text, COLORS.warning);
        }
        audit.record({
          action: 'shift_cover_logged',
          actorId: covererId,
          targetId: coveredUser.id,
          details: { points: r.points, balance: r.balance, note: note || null },
          channelId: i.channelId,
        });
        return replyEphemeral(i, `✅ سُجّلت تغطيتك لشفت <@${coveredUser.id}> — **+${arDigits(r.points)}** نقطة (رصيدك: ${arDigits(r.balance)}).`, COLORS.success);
      },
    },
  ],
};
