'use strict';
const forms = require('../ui/forms');
const { homeRow } = require('../ui/navigation');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, SUPPORT_PROMOTIONS, MOD_PROMOTIONS } = require('../constants');
const promo = require('../services/promotions');
const promotionRules = require('../services/promotionRules');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, dm, log, arDigits } = require('../utils');

function checksText(checks) {
  return checks.map(c => `${c.pass ? '✅' : '❌'} **${c.label}**: ${c.actual} (المطلوب: ${c.required})`).join('\n');
}

function statusEmbed(staff, ev) {
  if (!ev.rule) return embed('📈 حالة الترقية', `رتبتك الحالية: **${staff.rank}**\n${ev.reason}`, COLORS.gray);
  const passed = ev.checks.filter(c => c.pass).length;
  return embed(`📈 حالة الترقية: ${ev.rule.from} → ${ev.rule.to}`, `${checksText(ev.checks)}\n\n**${passed}/${ev.checks.length}** شرط مكتمل • ${ev.eligible ? '🟢 مؤهل لتقديم الطلب' : '🔴 غير مؤهل حالياً'}\n👥 الموافقة: ${ev.rule.approvers}`,
    ev.eligible ? COLORS.success : COLORS.warning);
}

function neededFor(r) {
  const s = staffService.get(r.user_id);
  const rule = s ? promotionRules.ruleFor(s.team, s.rank) : null;
  return rule && rule.to === r.to_rank ? (rule.approvals || 1) : 1;
}

function requestEmbed(r, color) {
  const checks = JSON.parse(r.snapshot || '[]');
  const STATUS = { pending: '⏳ معلّق', approved: '✅ مقبول', rejected: '❌ مرفوض' };
  const needed = neededFor(r);
  const votes = r.status === 'pending' && needed > 1 ? promo.approvalsList(r.id) : [];
  const quorum = needed > 1 && r.status === 'pending'
    ? `\n\n**الموافقات:** ${votes.length}/${needed}${votes.length ? ` — ${votes.map(a => `<@${a.user_id}>`).join(' ')}` : ''}`
    : '';
  return embed(`📈 طلب ترقية #${r.id}: ${r.from_rank} → ${r.to_rank}`, `👤 <@${r.user_id}>\n**الحالة:** ${STATUS[r.status]}${quorum}\n\n${checksText(checks)}${r.note ? `\n\n**ملاحظة المتقدم:** ${r.note}` : ''}${r.reviewed_by ? `\n\n**المراجع:** <@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` : ''}`, color || COLORS.info);
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`promo:approve:${id}`).setLabel('ترقية').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`promo:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger));

const modals = {
  request: ({ to = '' } = {}) => ({
    id: 'promo:modal',
    title: `📈 طلب ترقية إلى ${to}`.trim(),
    fields: [
      forms.field({ id: 'note', label: 'ملاحظة للإدارة', required: false, style: 'paragraph', max: 500,
        description: 'اختياري: أضف ما يدعم الطلب (إنجازات، التزام، شهادات).' }),
    ],
    note: 'سيطّلع المراجع على مؤشراتك ومدة الخدمة وتقييماتك قبل القرار، ويصلك الرد في الخاص.',
  }),
  reject: ({ id } = {}) => ({
    id: `promo:rejectmodal:${id}`,
    title: '❌ سبب رفض الترقية',
    fields: [
      forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
        options: [
          { label: 'المؤشرات لم تكتمل بعد', value: 'المؤشرات لم تكتمل بعد' },
          { label: 'مدة الخدمة قصيرة', value: 'مدة الخدمة في الرتبة الحالية قصيرة' },
          { label: 'يحتاج تحسين الأداء', value: 'يحتاج إلى تحسين الأداء قبل الترقية' },
          { label: 'سلوك أو التزام', value: 'ملاحظات سلوكية أو التزام' },
        ],
        description: 'اختر سبباً واحداً أو أكثر، أو اكتب سبباً مخصصاً في الحقل التالي.' }),
      forms.field({ id: 'reason', label: 'سبب مخصص', required: false, style: 'paragraph', max: 300,
        description: 'اكتب التفاصيل التي سيراها العضو في رسالة الرفض.' }),
    ],
    note: 'يظهر النص للعضو في الخاص ويُسجَّل مع فترة التبريد في سجل التدقيق.',
  }),
};

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('promotion-info').setDescription('عرض نظام الترقيات وشروطه'),
      level: LEVELS.STAFF,
      async execute(i) {
        const s = staffService.get(i.user.id);
        const e1 = embed('🎧 ترقيات فريق الدعم الفني', SUPPORT_PROMOTIONS.map(p => {
          const msg = p.minMessages ? `📝 ${p.minMessages}+ رسالة` : '';
          // العتبة من طبقة القواعد: تجاوز السياسة يعرض هنا حياً لا من الثوابت
          const pointsThreshold = promotionRules.ruleFor('support', p.from)?.pointsThreshold || '—';
          return `**${p.from} → ${p.to}**\n⏳ ${p.months} شهر ${msg ? '• ' + msg : ''} • 💯 نقاط ${arDigits(pointsThreshold)}+ • ⭐ ${p.rating}+ • ⚠️ أقصى ${p.maxWarnings} إنذار • 👥 ${p.approvers}`;
        }).join('\n\n') + '\n\n**Support Office → Boss**: يدوي بقرار Boss', COLORS.info);
        const e2 = embed('🛡️ ترقيات فريق الإشراف', MOD_PROMOTIONS.map(p => {
          const pointsThreshold = promotionRules.ruleFor('moderation', p.from)?.pointsThreshold || '—';
          return `**${p.from} → ${p.to}**\n⏳ ${p.months} شهر • 💯 نقاط ${arDigits(pointsThreshold)}+ • 🛡️ ${p.actions}+ مخالفة • ⚠️ أقصى ${p.maxWarnings} إنذار • 👥 ${p.approvers}`;
        }).join('\n\n'), COLORS.info);
        return i.reply({ embeds: [e1, e2], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('promotion-status').setDescription('عرض حالة ترقيتك وشروطها'),
      level: LEVELS.STAFF,
      async execute(i) {
        const s = staffService.get(i.user.id);
        if (!s) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        const ev = promo.evaluate(s);
        const pending = promo.pendingRequest(i.user.id);
        const e = statusEmbed(s, ev);
        if (pending) e.addFields({ name: '📨 طلب معلّق', value: `#${pending.id} — بانتظار المراجعة` });
        return i.reply({ embeds: [e], components: [homeRow()], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('request-promotion').setDescription('تقديم طلب ترقية'),
      level: LEVELS.STAFF, maxLevel: LEVELS.MANAGEMENT,
      async execute(i) {
        const s = staffService.get(i.user.id);
        if (!s) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        if (promo.pendingRequest(i.user.id)) return replyEphemeral(i, '❌ لديك طلب ترقية معلّق بالفعل.', COLORS.danger);
        const ev = promo.evaluate(s);
        if (!ev.rule) return replyEphemeral(i, ev.reason, COLORS.gray);
        if (!ev.eligible) return i.reply({ embeds: [statusEmbed(s, ev).setTitle('❌ غير مؤهل لتقديم طلب ترقية حالياً')], ephemeral: true });
        return forms.open(i, { ...modals.request({ to: ev.rule.to }), title: `📈 طلب ترقية إلى ${ev.rule.to}` });
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-promotion').setDescription('مراجعة طلبات الترقية المعلّقة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = promo.listPending();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد طلبات ترقية معلّقة.', COLORS.success);
        await i.reply({ embeds: [embed('⏳ طلبات الترقية المعلّقة', `العدد: **${rows.length}**`, COLORS.info)], ephemeral: true });
        for (const r of rows.slice(0, 10)) await i.followUp({ embeds: [requestEmbed(r)], components: [reviewRow(r.id)], ephemeral: true });
      },
    },
  ],

  components: {
    'promo:modal': async (i) => {
      const s = staffService.get(i.user.id);
      // حارس هوية المُقدِّم (البند ⑩): فرع تجاوز Server Manager في التفاعلات
      // يمنح i.staffLevel = GM دون صف إداري، وبوابة promo:modal في السجل
      // دنيا (STAFF) فقط فتُمرَِّر له. الجلسة تُحي بعد 15 دقيقة، فمن فتح
      // /request-promotion وله رتبة ثم أُزيلت رتبه وحاز Server Manager قبيل
      // الإرسال يمرّ هنا بلا مصفوفة — وevaluate(null) كان ينهار على
      // nextPromotion (staff.team). القاعدة: لا صف دفتر ⇒ لا طلب ترقية،
      // بردٍ يشرح لا صمتٍ ثم خطأ عام.
      if (!s) return replyEphemeral(i, '❌ لست مسجلاً في سجل الإداريين — لا ترقية تُقَدَّم من خارج الدفتر.', COLORS.danger);
      const ev = promo.evaluate(s);
      if (!ev.eligible) return replyEphemeral(i, '❌ لم تعد مؤهلاً.', COLORS.danger);
      const id = promo.createRequest(s, ev, (i.fields.getTextInputValue('note') || '').trim());
      const r = promo.getRequest(id);
      const msg = await sendToChannel(i.client, 'manager-review', { embeds: [requestEmbed(r)], components: [reviewRow(id)] });
      if (msg) require('../database').getDb().prepare('UPDATE promotion_requests SET message_id = ? WHERE id = ?').run(msg.id, id);
      return replyEphemeral(i, `✅ تم إرسال طلب الترقية **#${id}** للمراجعة.`, COLORS.success);
    },
    'promo:approve': async (i, [id]) => {
      const r = promo.getRequest(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      const s = staffService.get(r.user_id);
      // حارس هوية صاحب الطلب (البند ⑩): الصفوف لا تُحذف اليوم من مسارات
      // الكود (الخروج وسائل هويةٌ وثيقة لا حذف)، لكن البطاقة في قناة
      // المراجعة تنجو من كل شيء، وكان nextPromotion(null) ينهار على
      // staff.team. الطلب الذي غاب أهلهُ يُعامَل كتغيّر الرتبة: توقفٌ
      // صريح لا سقوط صامت، والسقوط المجدول (30 يوماً) سيطويه بأسببه.
      if (!s) return replyEphemeral(i, '❌ صاحب هذا الطلب ليس في سجل الإداريين — الترقية لا تُنفَّذ بلا صف أهلية.', COLORS.danger);
      const rule = promotionRules.ruleFor(s.team, s.rank);
      if (!rule || rule.to !== r.to_rank) return replyEphemeral(i, '❌ رتبة العضو تغيرت منذ الطلب.', COLORS.danger);
      if (i.staffLevel < rule.approvalLevel) return replyEphemeral(i, `❌ هذه الترقية تتطلب موافقة: ${rule.approvers}.`, COLORS.danger);
      if (r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك ترقية نفسك.', COLORS.danger);

      // ===== نصاب الموافقات: الترقيات المعلنة بـ «Admin + Head» تحتاج موافقتين فعلاً =====
      const needed = rule.approvals || 1;
      const { recorded } = promo.recordApproval(r.id, i.user.id);
      if (!recorded) {
        const count = promo.approvalsCount(r.id);
        return replyEphemeral(i, `ℹ️ سجّلت موافقتك مسبقاً على الطلب #${r.id} (${count}/${needed}).`, COLORS.info);
      }
      // نؤجل قبل أي استدعاء شبكي: في فرع النصاب تعديل بطاقة الطلب، وفي فرع
      // الاعتماد members.fetch ثم applyRankRoles. سلسلة قد تتجاوز ثلاث ثوانٍ
      // بعد أن كُتبت الترقية — فيرى المراجع فشلاً على ترقية نجحت.
      await i.deferUpdate();
      // سباق الترقيات (تقرير التدقيق): بين تسجيل موافقة المراجع وفصل هنا قد
      // ينهي موافقٌ آخر الطلب في خيط آخر، فعدّاد `count` قبل التأجيل قديم:
      // مع النصاب المزدوج كان المؤجِّل يعِد بـ«بانتظار موافقة إضافية» على طلب
      // اعتُمد فعلًا ويعيد أزرار مراجعة على بطاقة معتمدة، ومع النصاب الفردي
      // كان الموقّع الثاني (عدده أكبر من النصاب) يعيد الفصل كاملاً: مبروك في
      // الخاص مرتين، ترقية منشورة مرتين، وتدقيق مزدوج. القرار الآن عن عين
      // قراءة حية بعد التأجيل: من وجد الطلب معلقاً وعده كافياً سلوى إلى
      // review() المُحارة، ومن وجده مراجَعاً فاز الغيرُ ويرى الحالة الحقيقية
      // بلا أي أثر متصاعد (رتبة/خاص/قناة/سجل). موافقة الخاسر بضِعف النصاب
      // تبقى محفوظة في الدفاتر فلا يُعاد الفصل عنها.
      const fresh = promo.getRequest(r.id);
      const count = promo.approvalsCount(r.id);
      if (fresh.status !== 'pending') {
        return i.editReply({ content: '⏳ تمت مراجعة هذا الطلب للتو من إداري آخر — لم يُنفَّذ شيء من نقرتك.', embeds: [requestEmbed(fresh)], components: [] });
      }
      if (count < needed) {
        audit.record({ action: 'promotion_approval_recorded', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, count, needed }, channelId: i.channelId });
        // i.message.edit كان يترك حالة «جارٍ التنفيذ» بلا جواب بعد التأجيل؛
        // editReply هو النهاية الصحيحة لردّ مؤجَّل، ثم ملاحظة خاصة عبر followUp.
        await i.editReply({ embeds: [requestEmbed(fresh)], components: [reviewRow(r.id)] });
        return i.followUp({ embeds: [embed(null, `✅ سُجّلت موافقتك (${count}/${needed}).\nبانتظار ${needed - count} موافقة إضافية من: ${rule.approvers}.`, COLORS.success)], ephemeral: true, allowedMentions: { parse: [] } });
      }
      // الفصل: review المُحارة يحكم بحد ذاته من حاز status='pending' لحظتها.
      if (!promo.review(r.id, 'approved', i.user.id, null)) {
        const updated = promo.getRequest(r.id);
        return i.editReply({ content: '⏳ تمت مراجعة هذا الطلب للتو من إداري آخر — لم يُنفَّذ شيء من نقرتك.', embeds: [requestEmbed(updated)], components: [] });
      }
      audit.record({ action: 'promotion_approved', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, from: rule.from, to: rule.to, approvals: count, needed }, channelId: i.channelId });
      staffService.setRank(r.user_id, s.team, rule.to, { actorId: i.user.id, reason: `ترقية معتمدة (طلب #${r.id} بموافقة ${count}/${needed})`, changeType: 'promote', newEpoch: true });
      const member = await i.guild.members.fetch(r.user_id).catch(() => null);
      const rolesOk = member ? await staffService.applyRankRoles(member, s.team, rule.to) : false;

      await i.editReply({ embeds: [requestEmbed(promo.getRequest(r.id), COLORS.success)], components: [] });
      await dm(i.client, r.user_id, { embeds: [embed('🎉 مبروك الترقية!', `تمت ترقيتك إلى **${rule.to}**`, COLORS.success)] });
      await sendToChannel(i.client, 'staff-updates', { embeds: [embed('🎉 ترقية جديدة', `<@${r.user_id}> — **${rule.from} → ${rule.to}**\nبقرار <@${i.user.id}>`, COLORS.success)] });
      return log(i.client, '📈 ترقية', `<@${r.user_id}>: ${rule.from} → ${rule.to} بواسطة <@${i.user.id}>${rolesOk ? '' : '\n⚠️ لم يتم تعديل الرتب تلقائياً — عدّلها يدوياً'}`, COLORS.success);
    },
    'promo:reject': async (i, [id]) => {
      const r = promo.getRequest(Number(id));
      if (r && r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك رفض طلب ترقيتك الخاص.', COLORS.danger);
      return forms.open(i, modals.reject({ id }));
    },
    'promo:rejectmodal': async (i, [id]) => {
      const r = promo.getRequest(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      if (r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك رفض طلب ترقيتك الخاص.', COLORS.danger);
      const reason = forms.combine(i);
      if (!reason) return replyEphemeral(i, 'اختر سبباً جاهزاً أو اكتب سبباً مخصصاً قبل الإرسال.', COLORS.danger);
      // modal submit بلا رسالة مصدر ⇒ deferReply. بعده تعديل بطاقة الطلب ثم
      // إرسال الخاص للعضو، وكلاهما شبكة متسلسلة بعد كتابة الرفض.
      await i.deferReply();
      // سباق المراجعة نفسه: الفصل مُحارَ بـ status='pending' — من سبق فاز،
      // والخاسر لا يسجّل رفضاً مزدوجاً ولا يبعث للعضو برفض لم يصدر عنه،
      // ولا يعدّل بطاقة بمراجعته التي لم تُكتب أصلاً.
      if (!promo.review(r.id, 'rejected', i.user.id, reason)) {
        const updated = promo.getRequest(r.id);
        return i.editReply({ content: '⏳ تمت مراجعة هذا الطلب للتو من إداري آخر — لم يُسجَّل سبب رفضك.', embeds: [requestEmbed(updated)], allowedMentions: { parse: [] } });
      }
      audit.record({ action: 'promotion_rejected', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason }, channelId: i.channelId });
      if (i.message) await i.message.edit({ embeds: [requestEmbed(promo.getRequest(r.id), COLORS.danger)], components: [] }).catch(() => {});
      await i.editReply({ embeds: [embed(null, `تم رفض الطلب #${r.id}.`, COLORS.danger)], allowedMentions: { parse: [] } });
      await dm(i.client, r.user_id, { embeds: [embed('❌ تم رفض طلب الترقية', `**السبب:** ${reason}\nيمكنك التقديم مجدداً.`, COLORS.danger)] });
      return log(i.client, '📈 رفض ترقية', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.danger);
    },
  },
};
