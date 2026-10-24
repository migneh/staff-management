'use strict';
const { randomBytes } = require('node:crypto');
const forms = require('../ui/forms');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, UserSelectMenuBuilder } = require('discord.js');
const { LEVELS, WARNING_TYPES, NOTE_TYPES, STATUS } = require('../constants');
const settings = require('../services/settings');
const { getDb } = require('../database');
const points = require('../services/points');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { COLORS, replyEphemeral, sendToChannel, dm, log } = require('../utils');
const kit = require('../ui/kit');

const ID_RE = /^\d{15,22}$/;
const DRAFT_TTL = 15 * 60 * 1000;
const drafts = new Map();

function rememberDraft(draft) { drafts.set(draft.token, draft); }
function getDraft(i, token) {
  const d = drafts.get(token);
  if (!d || d.owner !== i.user.id || d.guild !== i.guildId || d.expires <= Date.now()) return null;
  return d;
}

/** بطاقة التحذير: خطوات واضحة وتأكيد قبل الكتابة */
function warningCard(draft, { pending = false, rowId = null } = {}) {
   const def = WARNING_TYPES[draft.type];
   return kit.card({
     title: pending ? `⚠️ تأكيد تسجيل: ${def.label}` : `✅ سُجّل إنذار: ${def.label}`,
     description: pending
       ? '_لن يُكتب أي شيء في السجل حتى تضغط «تأكيد التسجيل»._'
       : `بواسطة <@${draft.actorId}> — السجل **#${rowId}**.`,
     fields: [
       { name: '👤 العضو', value: `<@${draft.target}>`, inline: true },
       { name: '📋 السبب', value: draft.reason, inline: false },
       pending ? { name: 'ℹ️ ملاحظة', value: 'لا تُمنح نقاط لهذا الإجراء في النظام الحالي.', inline: false } : null,
     ],
     color: pending ? COLORS.info : COLORS.warning,
     footer: kit.footerLine(pending ? '⚠️ مراجعة قبل التسجيل' : `السجل #${rowId}`),
   });
 }

function warningButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`punish:warningok:${token}`).setLabel('تأكيد التسجيل').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`punish:warnedit:${token}`).setLabel('تعديل').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`punish:warningcancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
}

/** بطاقة الملاحظة: خطوات واضحة وتأكيد قبل الكتابة */
function noteCard(draft, { pending = false, rowId = null } = {}) {
   const def = NOTE_TYPES[draft.type];
   return kit.card({
     title: pending ? `📝 تأكيد تسجيل: ${def.label}` : `✅ سُجّلت ملاحظة: ${def.label}`,
     description: pending
       ? '_لن يُكتب أي شيء في السجل حتى تضغط «تأكيد التسجيل»._'
       : `بواسطة <@${draft.actorId}> — السجل **#${rowId}**.`,
     fields: [
       { name: '👤 العضو', value: `<@${draft.target}>`, inline: true },
       { name: '📝 المحتوى', value: draft.content, inline: false },
       draft.is_secret ? { name: '🔒 سرية', value: 'نعم', inline: true } : null,
       pending ? { name: 'ℹ️ ملاحظة', value: 'لا تُمنح نقاط لهذا الإجراء في النظام الحالي.', inline: false } : null,
     ],
     color: pending ? COLORS.info : (draft.type === 'positive' ? COLORS.success : COLORS.warning),
     footer: kit.footerLine(pending ? '📝 مراجعة قبل التسجيل' : `السجل #${rowId}`),
   });
 }

function noteButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`punish:notekok:${token}`).setLabel('تأكيد التسجيل').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`punish:noteedit:${token}`).setLabel('تعديل').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`punish:notecancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
}

const modals = {
   warning: ({ type = 'first' } = {}) => ({
     id: `punish:warning:${type}`,
     title: `⚠️ تسجيل إنذار: ${WARNING_TYPES[type].label}`,
     fields: [
       forms.user({ id: 'target', label: 'العضو الذي يخصه الإنذار', description: 'ابحث بالاسم واختر العضو الصحيح قبل الإرسال.' }),
       forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
         options: [
           { label: 'إساءة للأعضاء', value: 'إساءة للأعضاء' },
           { label: 'تجاهل الأنظمة', value: 'تجاهل أنظمة السيرفر' },
           { label: 'نقاش غير صحي', value: 'إثارة نقاش غير صحي' },
           { label: 'مخالفة القوانين', value: 'مخالفة قوانين السيرفر' },
           { label: 'سلوك غير لائق', value: 'سلوك غير لائق' },
         ],
         description: 'اختر ما ينطبق، أو اكتب السبب بنفسك في الحقل التالي.' }),
       forms.field({ id: 'reason', label: 'تفاصيل السبب', required: false, style: 'paragraph', max: 500,
         description: 'تُلحق بالأسباب المختارة وتظهر في سجل الإجراءات وإشعار الإدارة.' }),
     ],
     note: 'يظهر النص للعضو في الخاص ويُسجَّل في سجل التدقيق.',
   }),
note: ({ type = 'positive' } = {}) => ({
     id: `punish:note:${type}`,
     title: `📝 تسجيل ملاحظة: ${NOTE_TYPES[type].label}`,
     fields: [
       forms.user({ id: 'target', label: 'العضو الذي يخصه الملاحظة', description: 'ابحث بالاسم واختر العضو الصحيح قبل الإرسال.' }),
       forms.field({ id: 'content', label: 'نص الملاحظة', required: true, style: 'paragraph', max: 500,
         description: 'اكتب الملاحظة التي سيشاهدها العضو (إلا إذا كانت سرية).' }),
       forms.select({ id: 'secret', label: 'نوع الملاحظة', required: true,
         options: [
           { label: 'عادية - يراه العضو', value: 'false' },
           { label: 'سرية - للإدارة فقط', value: 'true' },
         ],
         description: 'اختر ما إذا كانت الملاحظة سرية (مرئية للإدارة فقط) أو عادية (مرئية للجميع).' }),
     ],
     note: 'الملاحظات الإيجابية تُظهر تقدير الإدارة، والسلبية تُشير إلى الحاجة لتحسين الأداء.',
   }),
};

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('warn').setDescription('إصدار إنذار على إداري')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('نوع الإنذار').setRequired(true)
          .addChoices(
            { name: '🟡 إنذار شفهي', value: 'verbal' },
            { name: '🟠 إنذار أول', value: 'first' },
            { name: '🔴 إنذار ثاني', value: 'second' },
            { name: '🔴 إنذار أخير (مع إيقاف)', value: 'final' }
          )),
      level: LEVELS.SUPERVISOR,
      team: 'moderation',
      async execute(i) {
        if (!settings.featureToggle('punishmentSystem')) return replyEphemeral(i, '❌ نظام العقوبات معطّل حالياً.', COLORS.danger);
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إنذار نفسك.', COLORS.danger);
        
        const def = WARNING_TYPES[type];
        if (i.staffLevel < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
        
        return forms.open(i, modals.warning({ type }), { title: `⚠️ تسجيل إنذار: ${def.label}`, values: { target: user.id } });
      },
    },
    {
      data: new SlashCommandBuilder().setName('note').setDescription('إضافة ملاحظة على إداري (إيجابية/سلبية)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('type').setDescription('نوع الملاحظة').setRequired(true)
          .addChoices(
            { name: '🟢 ملاحظة إيجابية', value: 'positive' },
            { name: '🟡 ملاحظة سلبية', value: 'negative' }
          )),
      level: LEVELS.SUPERVISOR,
      team: 'moderation',
      async execute(i) {
        if (!settings.featureToggle('punishmentSystem')) return replyEphemeral(i, '❌ نظام العقوبات معطّل حالياً.', COLORS.danger);
        const user = i.options.getUser('user');
        const type = i.options.getString('type');
        const target = staffService.get(user.id);
        if (!target) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إضافة ملاحظة على نفسك.', COLORS.danger);
        
        const def = NOTE_TYPES[type];
        if (i.staffLevel < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
        
        return forms.open(i, modals.note({ type }), { title: `📝 تسجيل ملاحظة: ${def.label}`, values: { target: user.id } });
      },
    },
    {
      data: new SlashCommandBuilder().setName('unfreeze').setDescription('رفع تجميد النقاط عن إداري (استئناف بعد فحص)')
        .addUserOption(o => o.setName('user').setDescription('الإداري المجمَّد').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الرفع — يُسجَّل وثيقةً').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      team: 'moderation',
      async execute(i) {
        if (!settings.featureToggle('punishmentSystem')) return replyEphemeral(i, '❌ نظام العقوبات معطّل حالياً.', COLORS.danger);
        const user = i.options.getUser('user');
        const reason = (i.options.getString('reason') || '').trim();
        if (reason.length < 5) return replyEphemeral(i, 'اكتب سبباً واضحاً للرفع (خمسة محارف على الأقل).', COLORS.danger);
        if (!staffService.get(user?.id)) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);

        // الاستئناف يرفع فقط ما فعلته العقوبة: يزيل صف التجميد فيعود التراكم،
        // والتجميد لا يُحرِّر رصيداً قائماً ولا يكتب خصماً.
        const removed = points.unfreeze(user.id);
        audit.record({ action: 'points_unfreeze', actorId: i.user.id, targetId: user.id,
          details: { reason, wasFrozen: removed } });
        if (!removed) return replyEphemeral(i, `لا تجميد فعّال على <@${user.id}> — لا شيء يُرفع.`, COLORS.warning);
        return replyEphemeral(i, `✅ رُفع التجميد عن <@${user.id}> — التراكم اشتغل من جديد.\n**السبب:** ${reason}`, COLORS.success);
      },
    },
  ],

  components: {
    // معالجة إرسال نموذج /warn: يقرأ العضو والسبب من النموذج ثم يعرض بطاقة تأكيد — لا يُكتب شيء في السجل بعد.
    'punish:warning': async (i, [type]) => {
      const def = WARNING_TYPES[type];
      if (!def) return replyEphemeral(i, '❌ نوع الإنذار غير صحيح.', COLORS.danger);
      const target = forms.value(i, 'target');
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. اختر العضو من قائمة النموذج.', COLORS.danger);
      if (target === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إنذار نفسك.', COLORS.danger);
      if (!staffService.get(target)) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
      if ((i.staffLevel || 0) < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
      const presets = forms.value(i, 'preset');
      const presetReason = forms.value(i, 'reason');
      const reason = forms.combine(i, { select: 'preset', text: 'reason' });
      if (!reason) return replyEphemeral(i, 'اختر سبباً جاهزاً أو اكتب تفاصيل السبب قبل المتابعة.', COLORS.danger);
      const token = randomBytes(8).toString('hex');
      const draft = { token, type, target, reason, presets, presetReason, owner: i.user.id, actorId: i.user.id, guild: i.guildId, expires: Date.now() + DRAFT_TTL };
      rememberDraft(draft);
      return i.reply({ embeds: [warningCard(draft, { pending: true })], components: [warningButtons(token)], ephemeral: true });
    },

    // معالجة إرسال نموذج /note: نفس فكرة التأكيد قبل الكتابة.
    'punish:note': async (i, [type]) => {
      const def = NOTE_TYPES[type];
      if (!def) return replyEphemeral(i, '❌ نوع الملاحظة غير صحيح.', COLORS.danger);
      const target = forms.value(i, 'target');
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. اختر العضو من قائمة النموذج.', COLORS.danger);
      if (target === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إضافة ملاحظة على نفسك.', COLORS.danger);
      if (!staffService.get(target)) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
      if ((i.staffLevel || 0) < def.minLevel) return replyEphemeral(i, `❌ ${def.label} يتطلب صلاحية أعلى.`, COLORS.danger);
      const content = forms.value(i, 'content');
      const isSecret = forms.value(i, 'secret') === 'true';
      if (!content) return replyEphemeral(i, 'اكتب محتوى الملاحظة قبل المتابعة.', COLORS.danger);
      const token = randomBytes(8).toString('hex');
      const draft = { token, type, target, content, is_secret: isSecret, owner: i.user.id, actorId: i.user.id, guild: i.guildId, expires: Date.now() + DRAFT_TTL };
      rememberDraft(draft);
      return i.reply({ embeds: [noteCard(draft, { pending: true })], components: [noteButtons(token)], ephemeral: true });
    },

    'punish:warningok': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. أعد تنفيذ **/warn** من جديد.', COLORS.warning);
      drafts.delete(token);

      // القيم جاءت من نموذج /warn وقت الإنشاء — هذا التفاعل زر تأكيد وليس نموذجاً، فلا يملك i.fields.
      const { target, reason } = draft;
      if (!ID_RE.test(target || '')) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. أعد تنفيذ /warn.', COLORS.danger);
      if (!reason) return replyEphemeral(i, '❌ تعذّر استرجاع السبب. أعد تنفيذ /warn.', COLORS.danger);
      if (target === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إنذار نفسك.', COLORS.danger);
      if (!staffService.get(target)) return replyEphemeral(i, '❌ هذا العضو لم يعد مسجلاً كإداري.', COLORS.danger);

      // نؤجل قبل النشر في قناة السجلات (شبكة) وقبل إيقاف العضو وكتابة الإشعار.
      // الإنذار قد كُتب وأُرسل قبل أن يخرج التأجيل، فكان المستخدم يرى «فشل
      // التفاعل» على إنذار سُجّل فعلاً — ويضغط مرة أخرى فيُصدر إنذاراً مكرراً.
      await i.deferUpdate();

      const def = WARNING_TYPES[draft.type];
      const db = getDb();
      const res = db.prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)')
        .run(draft.target, draft.type, reason, i.user.id);
      
      audit.record({ action: 'staff_warning_issued', actorId: i.user.id, targetId: draft.target, details: { type: draft.type, reason, rowId: res.lastInsertRowid }, channelId: i.channelId });
      
      // قرار المالك D1 (2026-10-24): البطاقة كانت تعدّ بالتبريد وتعلنه
      // في الرسالة بلا سطر يفرضه — الآن كل إنذار ذو freezeDays يُجمِّد
      // التراكم فعلاً، والأخير (60 يوماً) يبقى مع الإيقاف لا بدله.
      let extra = '';
      if (def.freezeDays) {
        const fr = points.freeze(draft.target, def.freezeDays, `${def.label} — ${reason}`);
        extra = `\n🧊 تجميد النقاط حتى ${fr.until} (${def.freezeDays} يوماً)`;
      }
      if (def.suspend) {
        staffService.suspend(draft.target, '60 days');
        extra += `\n⛔ تم الإيقاف\n↩️ يُرفع الإيقاف تلقائياً بعد 60 يوماً (أو يدوياً بـ \`/unsuspend\`)`;
      }
      
      const e = warningCard(draft, { rowId: res.lastInsertRowid });
      await sendToChannel(i.client, 'staff-logs', { embeds: [e] });
      // بعد deferUpdate لا يصلح update — editReply يُنهي الرد المؤجل. التأكيد
      // الخاص للإداري يبقى followUp (replyEphemeral يوجّهه إليه تلقائياً لأن
      // التفاعل صار replied)، فلا يختفي بتعديل الرسالة ولا يصطدم بإقرار مزدوج.
      await i.editReply({ embeds: [e], components: [] });
      
      if (def.suspend) {
        await dm(i.client, draft.target, { embeds: [kit.card({
          title: `⛔ تم الإيقاف`,
          description: `تم إصدار **${def.label}** عليك وإيقافك عن العمل.\n**السبب:** ${reason}\n${extra}\n\nبواسطة: <@${i.user.id}>`,
          color: COLORS.danger,
          footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
        })] }).catch(() => {});
      } else {
        await dm(i.client, draft.target, { embeds: [kit.card({
          title: `${def.emoji} ${def.label}`,
          description: `**السبب:** ${reason}${extra}\n\nبواسطة: <@${i.user.id}>`,
          color: COLORS.warning,
          footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
        })] }).catch(() => {});
      }
      
      await replyEphemeral(i, `${def.emoji} تم إصدار **${def.label}** على <@${draft.target}>.${extra}`, COLORS.warning);
      return log(i.client, `${def.emoji} ${def.label}`, `على <@${draft.target}> بواسطة <@${i.user.id}>\n${reason}${extra}`, COLORS.danger);
    },

    'punish:warnedit': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. ابدأ من جديد.', COLORS.warning);
      drafts.delete(token);
      return forms.open(i, modals.warning({ type: draft.type }), {
        values: { target: draft.target, reason: draft.presetReason || '', preset: draft.presets },
      });
    },

    'punish:warningcancel': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (draft && draft.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغي الإنذار', 'لم يُسجَّل أي إنذار.', { footer: kit.footerLine('⚠️ إنذار ملغى') })], components: [] });
    },

    'punish:notekok': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. أعد تنفيذ **/note** من جديد.', COLORS.warning);
      drafts.delete(token);

      // القيم جاءت من نموذج /note وقت الإنشاء — هذا التفاعل زر تأكيد وليس نموذجاً، فلا يملك i.fields.
      const { target, content } = draft;
      const isSecret = !!draft.is_secret;
      if (!ID_RE.test(target || '')) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. أعد تنفيذ /note.', COLORS.danger);
      if (!content) return replyEphemeral(i, '❌ تعذّر استرجاع نص الملاحظة. أعد تنفيذ /note.', COLORS.danger);
      if (target === i.user.id) return replyEphemeral(i, '❌ لا يمكنك إضافة ملاحظة على نفسك.', COLORS.danger);
      if (!staffService.get(target)) return replyEphemeral(i, '❌ هذا العضو لم يعد مسجلاً كإداري.', COLORS.danger);

      // نفس المسار: نشر البطاقة في قناة السجلات عملية شبكية تسبق أي رد،
      // والملاحظة قد كُتبت قبلها فعلاً.
      await i.deferUpdate();

      const def = NOTE_TYPES[draft.type];
      const db = getDb();
      const res = db.prepare('INSERT INTO staff_notes (user_id, note_type, content, is_secret, added_by) VALUES (?, ?, ?, ?, ?)')
        .run(draft.target, draft.type, content, isSecret ? 1 : 0, i.user.id);
      
      audit.record({ action: 'staff_note_added', actorId: i.user.id, targetId: draft.target, details: { type: draft.type, secret: !!isSecret, rowId: res.lastInsertRowid }, channelId: i.channelId });
      
      const e = noteCard(draft, { rowId: res.lastInsertRowid });
      await sendToChannel(i.client, 'staff-logs', { embeds: [e] });
      await i.editReply({ embeds: [e], components: [] });
      
      await replyEphemeral(i, `${def.emoji} تمت إضافة ${def.label} على <@${draft.target}>${isSecret ? ' 🔒' : ''}.`, COLORS.success);
      // إشعار العضو مرة واحدة فقط، والملاحظة السرية لا تُرسل نصها إليه إطلاقاً.
      if (!isSecret) await dm(i.client, draft.target, { embeds: [kit.card({
        title: `${def.emoji} ${def.label} جديدة`,
        description: `${content}\n\nبواسطة: <@${i.user.id}>`,
        color: draft.type === 'positive' ? COLORS.success : COLORS.warning,
        footer: kit.footerLine(`بواسطة <@${i.user.id}>`),
      })] }).catch(() => {});
      
      return log(i.client, `${def.emoji} ${def.label}${isSecret ? ' 🔒' : ''}`, `على <@${draft.target}> بواسطة <@${i.user.id}>\n${content}`, COLORS.gray);
    },

    'punish:noteedit': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. ابدأ من جديد.', COLORS.warning);
      drafts.delete(token);
      return forms.open(i, modals.note({ type: draft.type }), {
        values: { target: draft.target, content: draft.content || '', secret: draft.is_secret ? 'true' : 'false' },
      });
    },

    'punish:notecancel': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (draft && draft.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغيت الملاحظة', 'لم تُسجَّل أي ملاحظة.', { footer: kit.footerLine('📝 ملاحظة ملغاة') })], components: [] });
    },
  },
};