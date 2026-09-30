'use strict';
const forms = require('../ui/forms');
const { randomBytes } = require('node:crypto');
const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, MOD_ACTION_TYPES } = require('../constants');
const { getDb } = require('../database');
const ticketLogs = require('../services/ticketLogs');
const audit = require('../services/audit');
const { COLORS, replyEphemeral, sendToChannel, dm, log } = require('../utils');
const kit = require('../ui/kit');


// ===== بطاقة الإجراء: خطوات واضحة وتأكيد قبل الكتابة =====
const DRAFT_TTL = 15 * 60 * 1000;
const drafts = new Map();
const pendingCustom = new Map();

function rememberDraft(draft) { drafts.set(draft.token, draft); }
function getDraft(i, token) {
  const d = drafts.get(token);
  if (!d || d.owner !== i.user.id || d.guild !== i.guildId || d.expires <= Date.now()) return null;
  return d;
}
function actionTypePicker() {
  const menu = new StringSelectMenuBuilder().setCustomId('modaction:picktype').setPlaceholder('اختر نوع الإجراء…')
    .addOptions(Object.entries(MOD_ACTION_TYPES).map(([value, label]) => ({ label, value })));
  return {
    embeds: [kit.card({
      title: '🛡️ تسجيل إجراء إشرافي',
      description: [
        'اختر نوع الإجراء من القائمة، ثم ستظهر لك خطوة واحدة لاختيار العضو والسبب والمدة — بلا كتابة أي معرّف.',
        '',
        '**ما بعد الاختيار:** بطاقة تأكيد تعرض كل شيء قبل الحفظ، ويمكنك التعديل أو الإلغاء.',
      ].join('\n'),
      color: COLORS.info,
      footer: kit.footerLine('🛡️ الخطوة ١ من ٢ — اختيار النوع'),
    })],
    components: [new ActionRowBuilder().addComponents(menu)],
    ephemeral: true,
  };
}
function actionCard(draft, { pending = false, rowId = null } = {}) {
   return kit.card({
     title: pending ? `🛡️ تأكيد تسجيل: ${MOD_ACTION_TYPES[draft.type]}` : `✅ سُجّل إجراء: ${MOD_ACTION_TYPES[draft.type]}`,
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
function actionButtons(token) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`modaction:confirm:${token}`).setLabel('تأكيد التسجيل').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`modaction:edit:${token}`).setLabel('تعديل').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`modaction:cancel:${token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
  );
}

const ID_RE = /^\d{15,22}$/;

/** أسباب جاهزة لكل نوع إجراء — تُختار بنقرة وتُدمج مع النص الحر. */
const ACTION_REASONS = {
  warn: [
    { label: 'إساءة للأعضاء', value: 'إساءة للأعضاء' },
    { label: 'تجاهل الأنظمة', value: 'تجاهل أنظمة السيرفر' },
    { label: 'نقاش غير صحي', value: 'إثارة نقاش غير صحي' },
  ],
  timeout: [
    { label: 'سبام أو تكرار', value: 'سبام أو تكرار الرسائل' },
    { label: 'ألفاظ غير لائقة', value: 'ألفاظ غير لائقة' },
    { label: 'إزعاج في الصوتية', value: 'إزعاج في القناة الصوتية' },
  ],
  kick: [
    { label: 'تكرار المخالفة', value: 'تكرار المخالفة بعد التحذير' },
    { label: 'خروج عن القوانين', value: 'خروج واضح عن قوانين السيرفر' },
  ],
  ban: [
    { label: 'مخالفة جسيمة', value: 'مخالفة جسيمة للقوانين' },
    { label: 'إساءة متكررة', value: 'إساءة متكررة بعد العقوبات' },
    { label: 'حساب احتيالي', value: 'حساب احتيالي أو إعلانات' },
  ],
  delete: [
    { label: 'محتوى مخالف', value: 'رسائل تحتوي محتوى مخالفاً' },
    { label: 'إعلانات', value: 'إعلانات أو روابط خارجية' },
  ],
  voice: [
    { label: 'إزعاج صوتي', value: 'إزعاج صوتي متكرر' },
    { label: 'ميوت عن قصد', value: 'تعطيل الصوت عن قصد' },
  ],
  nickname: [
    { label: 'اسم غير لائق', value: 'اسم غير لائق' },
    { label: 'انتحال شخصية', value: 'انتحال شخصية أو رتبة' },
  ],
  other: [
    { label: 'مخالفة القوانين', value: 'مخالفة قوانين السيرفر' },
    { label: 'إجراء وقائي', value: 'إجراء وقائي للمحافظة على النظام' },
  ],
};

const DURATION_OPTIONS = [
  { label: 'بلا مدة (تنبيه فقط)', value: 'none', emoji: '➖' },
  { label: '10 دقائق', value: '10 دقائق' },
  { label: 'ساعة واحدة', value: 'ساعة واحدة' },
  { label: '6 ساعات', value: '6 ساعات' },
  { label: '24 ساعة', value: '24 ساعة' },
  { label: '3 أيام', value: '3 أيام' },
  { label: '7 أيام', value: '7 أيام' },
  { label: '28 يوماً', value: '28 يوماً' },
  { label: 'مدة أخرى…', value: 'custom', emoji: '✏️' },
];

/** نماذج التسجيل اليدوي: الأسماء في Labels والقواعد في الشرح. */
const modals = {
  ticket: ({ supervisor = false } = {}) => ({
    id: 'ticket:log:auto',
    title: '🎫 تسجيل تكت يدوي',
    fields: [
      forms.field({ id: 'ticket_id', label: 'رقم التكت', max: 40, description: 'رقم التكت من سجل البوت الخارجي، لا رقم الرسالة.', placeholder: 'مثال: ticket-1042' }),
      forms.user({ id: 'owner', label: 'صاحب التكت', description: 'ابحث عن العميل بالاسم بدل نسخ المعرّف.' }),
      ...(supervisor ? [forms.user({ id: 'claimer', label: 'الإداري الذي استلم التكت', required: false, description: 'اتركه فارغاً إن كنت أنت المستلم. التسجيل باسم غيرك يُوثَّق.' })] : []),
      forms.select({ id: 'rating', label: 'تقييم العميل', options: [
        { label: 'لم يتم التقييم', value: 'none' },
        ...[5, 4, 3, 2, 1].map(n => ({ label: `${'⭐'.repeat(n)} — ${n}/5`, value: String(n) })),
      ], values: ['none'], description: 'سجّل التقييم الفعلي فقط، ولا تضف تقييماً غير موجود.' }),
      forms.field({ id: 'duration', label: 'مدة الحل', required: false, max: 12, description: 'اختياري: دقائق مثل 45 أو ساعة:دقيقة مثل 01:30.', placeholder: '45 أو 01:30' }),
    ],
    note: 'النقاط تُحسب حسب نوع التكت والتقييم، والأرقام المكررة لا تُحتسب مرتين.',
  }),
  action: ({ type } = {}) => ({
    id: `modaction:log:${type || 'other'}`,
    title: `🛡️ تسجيل: ${MOD_ACTION_TYPES[type] || 'إجراء إشرافي'}`,
    fields: [
      forms.user({ id: 'target', label: 'العضو الذي يخصه الإجراء', description: 'ابحث بالاسم واختر العضو الصحيح قبل الإرسال.' }),
      forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
        options: ACTION_REASONS[type] || ACTION_REASONS.other,
        description: 'اختر ما ينطبق، أو اكتب السبب بنفسك في الحقل التالي.' }),
      forms.field({ id: 'reason', label: 'تفاصيل السبب', required: false, style: 'paragraph', max: 500,
        description: 'تُلحق بالأسباب المختارة وتظهر في سجل الإجراءات وإشعار الإدارة.' }),
      forms.select({ id: 'duration', label: 'المدة', options: DURATION_OPTIONS,
        description: 'للإجراءات المؤقتة (تايم أوت/ميوت). اختر «مدة أخرى» لتكتبها بنفسك.' }),
      forms.field({ id: 'evidence', label: 'رابط الدليل', required: false, max: 300,
        description: 'اختياري: رابط يبدأ بـ https:// يوثّق الإجراء.' }),
    ],
  }),
  customDuration: () => ({
    id: 'modaction:duration',
    title: '⏱️ مدة مخصصة',
    fields: [
      forms.field({ id: 'duration', label: 'المدة المخصصة', max: 40,
        description: 'اكتب المدة كما تريد، مثل: 45 دقيقة، ساعتان، 10 أيام.', placeholder: 'مثال: 45 دقيقة' }),
    ],
  }),
};

function ticketEmbed(result, loggedBy, sourceLabel = 'يدوي') {
  const row = result.row;
  return kit.card({
    title: `🎫 تكت مسجل ${result.reopened ? '♻️' : ''}`,
    description: result.reopened ? '_أُعيد فتح هذا التكت._' : '_تكت مكتمل._',
    color: result.reopened ? COLORS.warning : COLORS.success,
    fields: [
      { name: '🔢 رقم التكت', value: `\`${row.ticketId}\``, inline: true },
      { name: '🙋 صاحب التكت', value: `<@${row.owner}>`, inline: true },
      { name: '🎯 المستلم', value: `<@${row.claimer}>`, inline: true },
      { name: '🔒 أغلقه', value: `<@${row.closer || row.claimer}>`, inline: true },
      { name: '⭐ التقييم', value: row.rating ? '⭐'.repeat(row.rating) : '—', inline: true },
      { name: '⏱️ المدة', value: row.duration != null ? `${row.duration} دقيقة` : '—', inline: true },
      { name: '🧭 المصدر', value: sourceLabel, inline: true },
      row.ticketUrl ? { name: '🔗 سجل التكت الخارجي', value: row.ticketUrl, inline: false } : null,
    ],
    footer: kit.footerLine(`🎫 المصدر: ${sourceLabel} • السجل #${row.id}${result.reopened ? ' • تكت معاد فتحه' : ''}`),
  });
}

async function saveTicket(i, input, sourceLabel = 'يدوي') {
  const result = ticketLogs.recordTicket(input);
  if (result.duplicate) return replyEphemeral(i, result.manualDuplicate
    ? 'ℹ️ هذا الرقم مسجل مسبقاً، ولن تُضاف نقاط مكررة. إذا أُعيد فتح التكت فليُسجّل من سجل البوت الخارجي.'
    : 'ℹ️ هذا السجل الخارجي تم احتسابه مسبقاً، ولن تُضاف نقاط مكررة.', COLORS.info);
  audit.record({ action: 'ticket_logged', actorId: i.user.id, targetId: input.claimer, details: {
    ticketId: input.ticketId,
    source: input.source || 'manual',
    rowId: result.row.id,
    manualOverride: input.source === 'manual' && input.claimer !== i.user.id,
  }, channelId: i.channelId });
  const e = ticketEmbed(result, i.user.id, sourceLabel);
  await sendToChannel(i.client, 'ticket-logs', { embeds: [e] });
  return i.reply({ embeds: [e], ephemeral: true });
}

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('log-ticket').setDescription('تسجيل تكت مغلق يدوياً (بديل عند تعطل سجل البوت الخارجي)')
        .addUserOption(o => o.setName('closer').setDescription('من أغلق التكت، إن كان غير المستلم — اختياري')),
      level: LEVELS.STAFF, team: 'support',
      async execute(i) {
        const closer = i.options?.getUser('closer');
        const spec = modals.ticket({ supervisor: i.staffLevel >= LEVELS.SUPERVISOR });
        return forms.open(i, { ...spec, id: `ticket:log:${closer?.id || 'auto'}` });
      },
    },
    {
      data: new SlashCommandBuilder().setName('log-action').setDescription('تسجيل إجراء إشرافي بالخطوات: النوع ← العضو ← السبب والمدة ← تأكيد')
        .addStringOption(o => o.setName('type').setDescription('نوع الإجراء — اختياري، وإن تركته تظهر قائمة بالأنواع')
          .addChoices(...Object.entries(MOD_ACTION_TYPES).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.STAFF, team: 'moderation',
      async execute(i) {
        const type = i.options.getString('type');
        if (MOD_ACTION_TYPES[type]) return forms.open(i, modals.action({ type }));
        return i.reply(actionTypePicker());
      },
    },
  ],

  components: {
    'ticket:log': async (i, [closerOverride] = []) => {
      const ticketId = i.fields.getTextInputValue('ticket_id').trim();
      const owner = i.fields.getTextInputValue('owner').trim();
      const optional = id => { try { return (i.fields.getTextInputValue(id) || '').trim(); } catch { return ''; } };
      const claimer = optional('claimer') || i.user.id;
      const closer = optional('closer') || (ID_RE.test(closerOverride || '') ? closerOverride : claimer);
      const ratingRaw = (i.fields.getTextInputValue('rating') || '').trim();
      const durRaw = (i.fields.getTextInputValue('duration') || '').trim();
      if (!ID_RE.test(owner) || !ID_RE.test(claimer) || !ID_RE.test(closer)) return replyEphemeral(i, '❌ معرفات الأعضاء غير صحيحة.', COLORS.danger);
      const rating = ratingRaw && ratingRaw !== 'none' ? Number(ratingRaw) : null;
      if (rating != null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) return replyEphemeral(i, '❌ التقييم يجب أن يكون بين 1 و 5.', COLORS.danger);
      if (claimer !== i.user.id && i.staffLevel < LEVELS.SUPERVISOR) {
        return replyEphemeral(i, '❌ لا يمكنك تسجيل تكت باسم إداري آخر. هذه الصلاحية متاحة للمشرفين فأعلى.', COLORS.danger);
      }
      const duration = durRaw ? ticketLogs.parseDuration(durRaw) : null;
      if (durRaw && (duration == null || !Number.isFinite(duration) || duration < 0 || /^-/.test(durRaw))) return replyEphemeral(i, '❌ المدة غير صحيحة. اكتب دقائق مثل `45` أو ساعة:دقيقة مثل `01:23`.', COLORS.danger);
      return saveTicket(i, { ticketId, owner, claimer, closer, rating, duration, durationSource: duration == null ? null : 'reported', loggedBy: i.user.id, source: 'manual' });
    },

    'modaction:picktype': async (i) => {
      const type = i.values[0];
      if (!MOD_ACTION_TYPES[type]) return replyEphemeral(i, '❌ نوع الإجراء غير صحيح.', COLORS.danger);
      return forms.open(i, modals.action({ type }));
    },

    'modaction:log': async (i, [type]) => {
      if (!MOD_ACTION_TYPES[type]) return replyEphemeral(i, '❌ نوع الإجراء غير صحيح.', COLORS.danger);
      const target = forms.value(i, 'target');
      const presets = forms.value(i, 'preset').split(/\s*[,،]\s*/).filter(Boolean);
      const reason = forms.combine(i, { select: 'preset', text: 'reason' });
      const duration = forms.value(i, 'duration');
      const evidence = forms.value(i, 'evidence');
      if (!ID_RE.test(target)) return replyEphemeral(i, '❌ لم يُحدَّد العضو بشكل صحيح. اختر العضو من قائمة النموذج.', COLORS.danger);
      if (!reason) return replyEphemeral(i, 'اختر سبباً جاهزاً أو اكتب تفاصيل السبب قبل المتابعة.', COLORS.danger);
      if (evidence && !/^https?:\/\//i.test(evidence)) return replyEphemeral(i, 'رابط الدليل يجب أن يبدأ بـ https:// أو http://.', COLORS.danger);
      const draft = { token: randomBytes(6).toString('hex'), owner: i.user.id, actorId: i.user.id, guild: i.guildId, type, target, reason, presets, presetReason: forms.value(i, 'reason'), duration: duration && duration !== 'none' ? duration : null, evidence: evidence || null, expires: Date.now() + DRAFT_TTL };
      if (draft.duration === 'custom') {
        pendingCustom.set(i.user.id, draft);
        return forms.open(i, modals.customDuration());
      }
      rememberDraft(draft);
      return i.reply({ embeds: [actionCard(draft, { pending: true })], components: [actionButtons(draft.token)], ephemeral: true });
    },

    'modaction:duration': async (i) => {
      // المدة المخصصة تُكتب في نموذج قصير ثم نكمل إلى بطاقة التأكيد.
      const draft = pendingCustom.get(i.user.id);
      if (!draft || draft.guild !== i.guildId || draft.expires <= Date.now()) return replyEphemeral(i, '⌛ انتهت الجلسة. افتح **/log-action** من جديد.', COLORS.warning);
      pendingCustom.delete(i.user.id);
      const text = forms.value(i, 'duration');
      if (!text) return replyEphemeral(i, 'اكتب المدة المطلوبة، مثل: 45 دقيقة.', COLORS.danger);
      draft.duration = text;
      rememberDraft(draft);
      return i.reply({ embeds: [actionCard(draft, { pending: true })], components: [actionButtons(draft.token)], ephemeral: true });
    },

    'modaction:confirm': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. أعد تنفيذ **/log-action** من جديد.', COLORS.warning);
      drafts.delete(token);
      const res = getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason, duration, evidence) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(draft.actorId, draft.target, draft.type, draft.reason, draft.duration, draft.evidence);
      
      audit.record({ action: 'moderation_action_logged', actorId: draft.actorId, targetId: draft.target, details: { type: draft.type, reason: draft.reason, evidence: draft.evidence, duration: draft.duration, rowId: res.lastInsertRowid }, channelId: i.channelId });
      const e = actionCard(draft, { rowId: res.lastInsertRowid });
      await sendToChannel(i.client, 'mod-logs', { embeds: [e] });
      await i.update({ embeds: [e], components: [] });
      await dm(i.client, draft.target, { embeds: [kit.card({
        title: `🛡️ ${MOD_ACTION_TYPES[draft.type] || 'إجراء إشرافي'}`,
        description: 'تم تسجيل إجراء عليك في السيرفر. إن كنت ترى أن الإجراء غير صحيح، تواصل مع الإدارة عبر التكت.',
        fields: [
          draft.duration ? { name: '⏱️ المدة', value: draft.duration, inline: true } : null,
          { name: '📋 السبب', value: draft.reason, inline: false },
        ],
        color: COLORS.warning,
        footer: kit.footerLine(`🛡️ بواسطة <@${draft.actorId}>`),
      })] }).catch(() => {});
      return log(i.client, '🛡️ إجراء إشرافي', `<@${draft.target}> — ${MOD_ACTION_TYPES[draft.type]} بواسطة <@${draft.actorId}>`, COLORS.warning);
    },

'modaction:cancel': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (draft && draft.actorId === i.user.id) drafts.delete(token);
      return i.update({ embeds: [kit.notice('neutral', 'أُلغي الإجراء', 'لم يُسجَّل أي إجراء.', { footer: kit.footerLine('🛡️ إجراء ملغى') })], components: [] });
    },

    'modaction:edit': async (i, [token]) => {
      const draft = getDraft(i, token);
      if (!draft) return replyEphemeral(i, '⌛ انتهت صلاحية هذه البطاقة. ابدأ من جديد.', COLORS.warning);
      drafts.delete(token);
      return forms.open(i, modals.action({ type: draft.type }), {
        values: { target: draft.target, reason: draft.presetReason || '', preset: draft.presets, evidence: draft.evidence || '', duration: DURATION_OPTIONS.some(o => o.value === draft.duration) ? draft.duration : 'custom' },
      });
    },
  },
};
