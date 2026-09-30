'use strict';
const forms = require('../ui/forms');
const {
  SlashCommandBuilder, StringSelectMenuBuilder, UserSelectMenuBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, RoleSelectMenuBuilder, ChannelSelectMenuBuilder,
  ChannelType, PermissionFlagsBits,
} = require('discord.js');
const { LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS, SYSTEM_ROLES, TEAMS, LEAVE_TYPES, CHANNEL_META } = require('../constants');
const settings = require('../services/settings');
const staffSync = require('../services/staffSync');
const staffService = require('../services/staff');
const { arDigits } = require('../utils');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, progressBar, normalizeDigits } = require('../utils');

const ACTIVITY_META = {
  ticket: { label: 'قنوات التكتات', emoji: '🎫', weight: '50%' },
  staff: { label: 'قنوات الإدارة', emoji: '💬', weight: '25%' },
  moderation: { label: 'قنوات الإشراف', emoji: '🛡️', weight: '25%' },
};

// ===== الصفحة الرئيسية =====
function homePage() {
  const st = settings.status();
  const ranksByTeam = { support: SUPPORT_RANKS, moderation: MOD_RANKS, general_management: GENERAL_MANAGEMENT_RANKS };
  const missing = st.missingRoles[0];
  const ready = st.complete && st.vacationRoleConfigured;
  const next = missing
    ? { id: `setup:roles:${missing.team}:${ranksByTeam[missing.team].findIndex(r => r.name === missing.rank)}`, label: 'متابعة ربط الرتب', hint: `اربط رتبة **${missing.rank}** في ${TEAMS[missing.team]}. يمكنك استخدام المطابقة التلقائية داخل صفحة الرتب.` }
    : !st.vacationRoleConfigured
      ? { id: 'setup:roles:system:0', label: 'ربط رتبة الإجازة', hint: 'اربط رتبة **in vacation** ليتمكن البوت من تطبيق حالة الإجازة تلقائياً.' }
      : !st.complete
        ? { id: `setup:channels:${settings.CHANNEL_KEYS.indexOf(st.missingChannels[0])}`, label: 'متابعة ربط القنوات', hint: 'اختر القناة الناقصة التالية، أو أنشئ القنوات الناقصة من صفحة القنوات.' }
        : { id: 'setup:ticket-source', label: 'مصدر سجل التكتات', hint: st.ticketSourceConfigured ? 'الإعداد الأساسي مكتمل. استخدم القائمة لتعديل قسم محدد.' : 'اختياري: اربط مصدر سجل التكتات لتفعيل التسجيل التلقائي لفريق الدعم.' };
  const e = embed('⚙️ إعداد البوت', ready ? '✅ الإعداد الأساسي مكتمل. يمكنك مراجعة أي قسم من القائمة.' : 'لنجهّز البوت خطوة بخطوة. لا تحتاج إلى نسخ أي معرّف.', ready ? COLORS.success : COLORS.primary)
    .addFields(
      { name: 'الخطوة التالية', value: next.hint },
      { name: '١ · رتب الفريق', value: `${st.rolesDone}/${st.rolesTotal} مرتبطة\n${progressBar(st.rolesDone, st.rolesTotal, 8)}`, inline: true },
      { name: '٢ · رتبة الإجازة', value: st.vacationRoleConfigured ? '✅ مرتبطة' : '⚪ تحتاج إلى ربط', inline: true },
      { name: '٣ · القنوات الداخلية', value: `${st.channelsDone}/${st.channelsTotal} مرتبطة\n${progressBar(st.channelsDone, st.channelsTotal, 8)}`, inline: true },
      { name: 'إعدادات إضافية', value: `سجل التكتات: **${st.ticketSourceConfigured ? 'مرتبط' : 'غير مربوط'}** • Server Manager: **${st.governanceConfigured ? 'مرتبط' : 'مالك السيرفر فقط، أو General Manager'}**\nقنوات النشاط والسياسات متاحة من القائمة. لا يلزم تعديل السياسات الافتراضية للبدء.` },
    ).setFooter({ text: 'يُحفظ كل تغيير فوراً • يمكنك التوقف والعودة لإكمال الإعداد لاحقاً' });
  const menu = new StringSelectMenuBuilder().setCustomId('setup:section').setPlaceholder('اختر قسماً للمراجعة أو التعديل…').addOptions(
    { label: 'رتب الدعم الفني', value: 'support', emoji: '🎧' },
    { label: 'رتب الإشراف', value: 'moderation', emoji: '🛡️' },
    { label: 'رتب الإدارة العامة', value: 'general_management', emoji: '🏛️' },
    { label: 'رتبة الإجازة', value: 'system', emoji: '🏖️' },
    { label: 'القنوات الداخلية', value: 'channels', emoji: '📁', description: 'ربط يدوي أو مطابقة أو إنشاء القنوات الناقصة' },
    { label: 'قنوات النشاط', value: 'activity', emoji: '📡' },
    { label: 'مصدر سجل التكتات', value: 'tickets', emoji: '🤖' },
    { label: 'مصدر تقييمات الدعم', value: 'ratings', emoji: '⭐', description: 'قراءة نجوم العملاء تلقائياً من رسائل البوت' },
    { label: 'الإداريون', value: 'staff', emoji: '👥', description: 'تسجيل دفعة واحدة من رتب ديسكورد وحالة كل فريق' },
    { label: 'صلاحية Server Manager', value: 'governance', emoji: '👑' },
    { label: 'سياسات الإجازات والاستقالة', value: 'policies', emoji: '📋', description: 'الحدود والمواعيد ووقت تفعيل رتبة الإجازة' },
  );
  return { embeds: [e], components: [
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(next.id).setLabel(next.label).setStyle(ButtonStyle.Primary)),
    new ActionRowBuilder().addComponents(menu),
  ] };
}

// ===== صفحة الرتب: رتبة واحدة في كل خطوة مع قائمة اختيار الرتب =====
function rolesPage(team, idx) {
  const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : team === 'general_management' ? GENERAL_MANAGEMENT_RANKS : SYSTEM_ROLES;
  idx = Math.max(0, Math.min(idx, ranks.length - 1));
  const r = ranks[idx];
  const cur = settings.roleId(team, r.name);
  const e = embed(`${team === 'support' ? '🎧' : team === 'moderation' ? '🛡️' : team === 'general_management' ? '🏛️' : '🏖️'} رتب ${team === 'system' ? 'الحالات التلقائية' : TEAMS[team]} — ${idx + 1}/${ranks.length}`,
    `اختر رتبة الديسكورد المقابلة لـ:\n\n# ${r.name}\n**الفئة:** ${r.category}${r.perms ? `\n**الصلاحيات:** ${r.perms}` : ''}${r.handlesTickets === false ? '\n_لا يستلم تكتات_' : ''}\n\n**الحالي:** ${cur ? `<@&${cur}>` : '_غير محدد_'}`, COLORS.info)
    .setFooter({ text: `${progressBar(idx + 1, ranks.length, ranks.length)}  •  اختر من القائمة وسينتقل للرتبة التالية تلقائياً` });
  const select = new RoleSelectMenuBuilder().setCustomId(`setup:pickrole:${team}:${idx}`).setPlaceholder(`🔽 اختر رتبة ${r.name}`).setMinValues(1).setMaxValues(1);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup:roles:${team}:${idx - 1}`).setLabel('السابق').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`setup:roles:${team}:${idx + 1}`).setLabel('التالي').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(idx === ranks.length - 1),
    new ButtonBuilder().setCustomId(`setup:autoroles:${team}`).setLabel('مطابقة تلقائية بالاسم').setEmoji('🪄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(select), nav] };
}

// ===== صفحة القنوات =====
function channelsPage(idx) {
  const keys = settings.CHANNEL_KEYS;
  idx = Math.max(0, Math.min(idx, keys.length - 1));
  const k = keys[idx];
  const m = CHANNEL_META[k];
  const cur = settings.channelId(k);
  const e = embed(`📁 القنوات — ${idx + 1}/${keys.length}`,
    `اختر القناة المخصصة لـ:\n\n# ${m.emoji} ${m.label}\n\`#${k}\` — ${m.desc}\n\n**الحالي:** ${cur ? `<#${cur}>` : '_غير محدد_'}`, COLORS.info)
    .setFooter({ text: `${progressBar(idx + 1, keys.length, keys.length)}  •  اختر من القائمة وسينتقل للقناة التالية تلقائياً` });
  const select = new ChannelSelectMenuBuilder().setCustomId(`setup:pickchannel:${idx}`).setPlaceholder(`🔽 اختر قناة ${m.label}`).addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1);
  const nav = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup:channels:${idx - 1}`).setLabel('السابق').setEmoji('◀️').setStyle(ButtonStyle.Secondary).setDisabled(idx === 0),
    new ButtonBuilder().setCustomId(`setup:channels:${idx + 1}`).setLabel('التالي').setEmoji('▶️').setStyle(ButtonStyle.Secondary).setDisabled(idx === keys.length - 1),
    new ButtonBuilder().setCustomId('setup:autochannels').setLabel('مطابقة تلقائية بالاسم').setEmoji('🪄').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:autocreate').setLabel('إنشاء القنوات الناقصة').setEmoji('✨').setStyle(ButtonStyle.Secondary).setDisabled(!settings.status().missingChannels.length),
    new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(select), nav] };
}

// ===== صفحة قنوات النشاط =====
function activityPage() {
  const s = settings.activityChannels();
  const e = embed('📡 قنوات النشاط', 'حدد القنوات أو **الكاتيجوري** لكل نوع (يمكن اختيار حتى 10). كل ما عداها يُحسب عاماً بوزن 10%.\n\n' +
    Object.entries(ACTIVITY_META).map(([k, m]) => `${m.emoji} **${m.label}** (${m.weight}): ${s[k]?.length ? s[k].map(id => `<#${id}>`).join(' ') : '_غير محدد_'}`).join('\n'), COLORS.info);
  const rows = Object.entries(ACTIVITY_META).map(([k, m]) => new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId(`setup:pickactivity:${k}`).setPlaceholder(`${m.emoji} ${m.label} (${m.weight})`)
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildCategory).setMinValues(0).setMaxValues(10).setDefaultChannels(...(s[k] || []).slice(0, 10))));
  rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary)));
  return { embeds: [e], components: rows };
}

function ratingsPage() {
  const channelId = settings.channelId('support-rating-logs');
  const botId = settings.policy('ratingBotId');
  const e = embed('⭐ ربط تقييمات الدعم', [
    '**١. اختر قناة رسائل التقييم.** يجب أن يستطيع البوت رؤيتها وقراءة رسائلها.',
    '**٢. اختر بوت التقييم (مستحسن).** تركه فارغاً يسمح برسائل أي بوت في القناة المحددة.',
    '',
    `القناة: ${channelId ? `<#${channelId}>` : 'غير مربوطة — التتبع متوقف'}`,
    `البوت المسموح: ${botId ? `<@${botId}>` : 'أي بوت في القناة المختارة'}`,
    '',
    'الصيغة: «تم تقييم الاداري» ثم منشنه، «العضو الي قييم» ثم منشن العضو، «عدد النجوم» من ⭐ إلى ⭐⭐⭐⭐⭐.',
    'تُقرأ الرسائل الجديدة فقط؛ لا يُعاد استيراد تاريخ القناة. الرسالة المكررة لا تُحتسب مرتين. لا يتم الرد في قناة المصدر.',
    'لعرض النتائج: /my-ratings أو /support-ratings. إزالة اختيار القناة توقف التتبع دون حذف البيانات.',
  ].join('\n'), COLORS.info);
  const channel = new ChannelSelectMenuBuilder().setCustomId('setup:rating-channel').setPlaceholder('١ · اختر قناة التقييمات، أو امسح الاختيار للإيقاف')
    .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setMinValues(0).setMaxValues(1);
  if (channelId) channel.setDefaultChannels(channelId);
  const bot = new UserSelectMenuBuilder().setCustomId('setup:rating-bot').setPlaceholder('٢ · اختر بوت التقييم فقط (اختياري)').setMinValues(0).setMaxValues(1);
  if (botId) bot.setDefaultUsers(botId);
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(channel), new ActionRowBuilder().addComponents(bot),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('العودة إلى الإعداد').setStyle(ButtonStyle.Secondary))] };
}

// ===== إعداد مصدر سجل التكتات الخارجي =====
function ticketSourcePage() {
  const cur = settings.channelId('ticket-source-logs');
  const botId = settings.ticketLogBotId();
  const e = embed('🤖 مصدر سجل التكتات الخارجي',
    `اختر القناة التي يرسل فيها بوت التكتات رسالة الإغلاق (مثل: \`close-2127\`).\n\n**القناة الحالية:** ${cur ? `<#${cur}>` : '_غير محددة_'}\n**معرف البوت (اختياري):** ${botId ? `\`${botId}\`` : '_أي بوت داخل القناة_' }\n\nبعد تحديدها سيقرأ Staff Manager الرسالة تلقائياً ويحتسب التكت والنقاط. لا يحتاج البوتان إلى التكامل مع بعضهما، ولا يحتاج الدعم لاستخدام \`/log-ticket\`.`, COLORS.info);
  const select = new ActionRowBuilder().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('setup:pickticketsource').setPlaceholder('🔽 اختر قناة سجل بوت التكتات').addChannelTypes(ChannelType.GuildText).setMinValues(1).setMaxValues(1),
  );
  const nav = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [select, nav] };
}

// ===== سياسات الإجازات والاستقالة =====
const WEEKDAY_NAMES = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

function policiesPage() {
  const st = settings.status();
  const lp = st.leavePolicy;
  const rp = st.resignationPolicy;
  const rules = Object.entries(LEAVE_TYPES).map(([key, label]) => {
    const r = settings.leavePolicy(key);
    return `${r.emoji || '🏖️'} **${label}** — حتى ${r.maxDays} يوم • إشعار ${r.minNoticeHours}س • سقف ${r.maxDaysPer90}/90 يوم`;
  }).join('\n');
  const e = embed('📋 سياسات الإجازات والاستقالة', [
    `**الإجازات — عام:** ${lp.maxConcurrent} مجازين كحد أقصى • ${lp.maxDays} يوم حد الإجازة الواحدة • المعلقة تسقط بعد ${lp.pendingExpireDays} يوم`,
    `**الإجازات — متقدم:** ${lp.annualDays ? `رصيد سنوي ${lp.annualDays} يوم • ` : ''}حد تغطية الفريق ${lp.teamCover}${lp.enforceTeamCover ? ' (مفروض)' : ' (تحذير)'} • تصعيد المعلّق بعد ${lp.pendingEscalateHours}س • ${lp.workdayCounting ? `يُحتسب أيام العمل فقط، والراحة: ${(lp.weeklyOffDays || []).map(d => WEEKDAY_NAMES[d]).join('، ') || 'غير محددة'}` : 'يُحتسب كل يوم تقويمي'}`,
    `**الاستقالة:** إشعار ${rp.noticeDays} يوم • تصعيد بعد ${rp.pendingEscalateDays} يوم`,
    '',
    '**قواعد كل نوع إجازة:**',
    rules,
    '',
    '_عدّلها من الأزرار — القيم تُطبق فوراً على الطلبات الجديدة._',
  ].join('\n'), COLORS.info);
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:policies-edit-leave').setLabel('تعديل حدود الإجازات').setEmoji('🏖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:policies-edit-resign').setLabel('تعديل الاستقالة').setEmoji('📤').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('setup:vacation-timing').setLabel(`تبديل التفعيل: ${lp.vacationRoleTiming === 'at_approval' ? 'فور الموافقة' : 'عند البداية'}`).setEmoji('⏰').setStyle(ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('setup:policies-advanced').setLabel('قواعد متقدمة').setEmoji('🧮').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('setup:policies-reset').setLabel('استعادة الافتراضي').setEmoji('↩️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [row1, row2] };
}

// ===== قواعد الإجازات المتقدمة =====
// ===== صفحة الإداريين =====
function staffPage() {
  const st = staffSync.snapshot();
  const teams = TEAMS;
  const perTeam = staffService.all().reduce((acc, r) => { acc[r.team] = (acc[r.team] || 0) + 1; return acc; }, {});
  const e = embed('👥 الإداريون', [
    'التسجيل يحدث **تلقائياً من رتب ديسكورد** — لا ينتظر البوت رسالة من كل عضو.',
    '',
    `📚 المسجّلون: **${arDigits(st.total)}** • ✅ نشط: **${arDigits(st.active)}** • 🧪 تجريبي: **${arDigits(st.probation)}**`,
    `🏖️ إجازة/إيقاف: **${arDigits(st.away)}** • 🚪 خارج الفريق: **${arDigits(st.out)}**`,
    st.unknown ? `⚠️ **${arDigits(st.unknown)}** سجلاً برتبة لم تُربط بعد — اربطها من صفحات الرتب.` : '✅ كل الرتب المسجّلة مربوطة بإعدادات البوت.',
    '',
    `**التوزيع:** ${Object.entries(teams).map(([k, v]) => `${v}: **${arDigits(perTeam[k] || 0)}**`).join(' • ')}`,
    st.lastSync ? `_آخر مزامنة: ${st.lastSync} UTC_` : '_لم تُجرَ مزامنة يدوية بعد._',
  ].join('\n'), st.unknown ? COLORS.warning : COLORS.info);
  return { embeds: [e], components: [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('setup:staff-sync').setLabel('تسجيل كل الإداريين الآن').setEmoji('🔄').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    ),
    new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:section').setLabel('اختر قسماً').setStyle(ButtonStyle.Secondary).setDisabled(true)),
  ] };
}

// ===== نماذج السياسات =====
const modals = {
  advancedLeave: () => {
    const lp = settings.leavePolicy();
    return {
      id: 'setup:policies-advanced-modal',
      title: '🧮 قواعد الإجازات المتقدمة',
      fields: [
        forms.field({ id: 'annualDays', label: 'الرصيد السنوي لكل إداري', max: 3, value: String(lp.annualDays || 0),
          description: '0 = بلا سقف سنوي (يبقى سقف 90 يوماً لكل نوع). الحد الأقصى 365.' }),
        forms.field({ id: 'teamCover', label: 'أدنى تغطية لكل فريق', max: 2, value: String(lp.teamCover),
          description: 'أقل عدد حاضرين مقبول من الفريق خلال الإجازة. من 0 إلى 50.' }),
        forms.field({ id: 'escalateHours', label: 'تصعيد الطلب المعلّق بعد', max: 3, value: String(lp.pendingEscalateHours),
          description: 'بالساعات: ينبّه البوت قناة الطلبات عند تجاوزها بلا قرار. من 1 إلى 720.' }),
        forms.select({ id: 'weeklyOff', label: 'أيام الراحة الأسبوعية', required: false, multiple: true,
          options: WEEKDAY_NAMES.map((label, value) => ({ label, value: String(value) })),
          values: (lp.weeklyOffDays || []).map(String),
          description: 'الأيام التي لا تُحتسب من الإجازة. امسح الاختيار لاحتساب الأيام التقويمية.' }),
        forms.select({ id: 'enforceTeamCover', label: 'عند كسر التغطية', required: true,
          options: [
            { label: 'تحذير فقط للمراجع', value: 'no' },
            { label: 'منع الاعتماد حتى يتغير التاريخ', value: 'yes' },
          ],
          values: [lp.enforceTeamCover ? 'yes' : 'no'],
          description: 'يُطبَّق عند ضغط زر الموافقة على الطلب.' }),
      ],
      note: 'تُحفظ القيم فوراً، ويمكن استعادتها من «استعادة الافتراضي». أيام الراحة تؤثر على حساب المدة والسقوف.',
    };
  },
  leavePolicy: ({ policy: lp = {} } = {}) => ({
    id: 'setup:policies-leave-modal',
    title: '🏖️ تعديل سياسات الإجازات',
    fields: [
      forms.field({ id: 'maxConcurrent', label: 'الحد الأقصى للمجازين معاً', max: 3, value: String(lp.maxConcurrent ?? 0),
        description: 'أقصى عدد أعضاء في إجازة في الوقت نفسه. من 1 إلى 365.' }),
      forms.field({ id: 'maxDays', label: 'أطول إجازة', max: 3, value: String(lp.maxDays ?? 0),
        description: 'أقصى مدة لطلب واحد بالأيام. من 1 إلى 365.' }),
      forms.field({ id: 'maxDaysPer90', label: 'السقف المتحرك / 90 يوم', max: 3, value: String(lp.maxDaysPer90 ?? 0),
        description: 'مجموع الأيام المسموح بها لكل نوع خلال 90 يوماً. من 1 إلى 365.' }),
      forms.field({ id: 'pendingExpireDays', label: 'سقوط المعلّقة بعد', max: 3, value: String(lp.pendingExpireDays ?? 0),
        description: 'بالأيام: تُلغى الطلبات المعلّقة تلقائياً بعدها. من 1 إلى 365.' }),
    ],
    note: 'تُقبل الأرقام العربية (٣٠)، والقيم خارج الحدود تُرفض مع زر تصحيح دون فقدان ما كتبته.',
  }),
  resignPolicy: ({ policy: rp = {} } = {}) => ({
    id: 'setup:policies-resign-modal',
    title: '📤 تعديل سياسات الاستقالة',
    fields: [
      forms.field({ id: 'noticeDays', label: 'فترة الإشعار', max: 3, value: String(rp.noticeDays ?? 0),
        description: 'أقل مدة إشعار مقبولة بالأيام قبل آخر يوم. من 1 إلى 30.' }),
      forms.field({ id: 'escalateDays', label: 'تصعيد المعلّقة بعد', max: 3, value: String(rp.escalateDays ?? rp.pendingEscalateDays ?? 0),
        description: 'بالأيام: يُنبَّه المراجعون للطلب المعلّق بعدها. من 1 إلى 14.' }),
    ],
    note: 'الطلب الأقل من الإشعار لا يُرفض تلقائياً، بل يصل للـ Boss مع تحذير واضح.',
  }),
};

// ===== إعداد رتبة Server Manager =====
function governancePage() {
  const cur = settings.governanceRoleId();
  const e = embed('👑 صلاحية Server Manager',
    `اختر رتبة مالكي السيرفر/Server Manager المسموح لها بتعيين الإدارة العامة.\n\n**الحالي:** ${cur ? `<@&${cur}>` : '_غير محدد_'}\n\nمالك السيرفر يستطيع دائماً استخدام الأمر. **General Manager الحالي** يستطيع أيضاً تعيين أو إزالة أعضاء الإدارة العامة. Co General Manager لا يملك هذه الصلاحية.`, COLORS.info);
  const select = new ActionRowBuilder().addComponents(new RoleSelectMenuBuilder().setCustomId('setup:pickgovernance').setPlaceholder('🔽 اختر رتبة Server Manager').setMinValues(1).setMaxValues(1));
  const nav = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [select, nav] };
}

// ===== المطابقة التلقائية =====
const norm = (s) => s.toLowerCase().replace(/[\s_\-]+/g, '');
function autoMatchRoles(guild, team) {
  const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : team === 'general_management' ? GENERAL_MANAGEMENT_RANKS : SYSTEM_ROLES;
  const matched = [];
  for (const r of ranks) {
    const role = guild.roles.cache.find(x => norm(x.name) === norm(r.name)) || guild.roles.cache.find(x => norm(x.name).includes(norm(r.name)) && !ranks.some(o => o !== r && norm(x.name) === norm(o.name)));
    if (role) { settings.setRole(team, r.name, role.id); matched.push(`${r.name} → <@&${role.id}>`); }
  }
  return matched;
}
function autoMatchChannels(guild) {
  const matched = [];
  for (const k of settings.CHANNEL_KEYS) {
    const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && (norm(c.name) === norm(k) || norm(c.name).includes(norm(k))));
    if (ch) { settings.setChannel(k, ch.id); matched.push(`${CHANNEL_META[k].emoji} ${k} → <#${ch.id}>`); }
  }
  return matched;
}

async function autoCreate(guild, botMember) {
  const st = settings.status();
  if (!st.missingChannels.length) return { created: [], category: null };
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && /staff.?manager|إدارة الفريق/i.test(c.name));
  const staffRoleIds = [...Object.values(settings.roles().support), ...Object.values(settings.roles().moderation), ...Object.values(settings.roles().general_management)].filter(Boolean);
  const managementIds = [settings.roleId('support', 'Support Office'), settings.roleId('support', 'Boss'), settings.roleId('moderation', 'Head Of Moderators'), settings.roleId('general_management', 'Co General Manager'), settings.roleId('general_management', 'General Manager')].filter(Boolean);
  const overwrites = (allowedIds) => [
    { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: botMember.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ManageMessages] },
    ...allowedIds.map(id => ({ id, allow: [PermissionFlagsBits.ViewChannel] })),
  ];
  if (!category) category = await guild.channels.create({ name: '📋 Staff Manager', type: ChannelType.GuildCategory, permissionOverwrites: overwrites(staffRoleIds) });
  const PRIVATE = ['resignation-requests', 'manager-review', 'leave-requests', 'performance-reports', 'staff-alerts', 'staff-logs'];
  const created = [];
  for (const k of st.missingChannels) {
    const ch = await guild.channels.create({
      name: `${CHANNEL_META[k].emoji}┃${k}`, type: ChannelType.GuildText, parent: category.id, topic: CHANNEL_META[k].desc,
      permissionOverwrites: overwrites(PRIVATE.includes(k) ? (managementIds.length ? managementIds : staffRoleIds) : staffRoleIds),
    });
    settings.setChannel(k, ch.id);
    created.push(`<#${ch.id}>`);
  }
  return { created, category };
}

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('setup').setDescription('⚙️ إعداد البوت: الرتب والقنوات (بقوائم اختيار — بدون معرفات)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
      level: LEVELS.STAFF, bypassStaffCheck: true, adminOnly: true,
      async execute(i) { return i.reply({ ...homePage(), ephemeral: true }); },
    },
  ],

  components: {
    'setup:home': async (i) => i.update(homePage()),
    'setup:rating-channel': async (i) => {
      settings.setChannel('support-rating-logs', i.values[0] || null);
      return i.update(ratingsPage());
    },
    'setup:rating-bot': async (i) => {
      const id = i.values[0];
      if (id && !i.users.get(id)?.bot) return replyEphemeral(i, 'اختر حساب البوت الذي ينشر التقييمات، وليس عضواً بشرياً.', COLORS.warning);
      settings.setPolicy('ratingBotId', id || null);
      return i.update(ratingsPage());
    },
    'setup:section': async (i) => {
      const pages = {
        support: () => rolesPage('support', 0), moderation: () => rolesPage('moderation', 0),
        general_management: () => rolesPage('general_management', 0), system: () => rolesPage('system', 0),
        channels: () => channelsPage(0), activity: activityPage, tickets: ticketSourcePage,
        governance: governancePage, policies: policiesPage, ratings: ratingsPage, staff: staffPage,
      };
      const key = i.values[0];
      return i.update(Object.hasOwn(pages, key) ? pages[key]() : homePage());
    },
    'setup:staff-sync': async (i) => {
      await i.deferUpdate();
      const guild = i.guild || await i.client.guilds.fetch(i.guildId);
      const report = await staffSync.syncGuild(guild, { actorId: i.user.id });
      if (report.error) return i.editReply({ embeds: [embed('⚠️ تعذّرت المزامنة', report.error, COLORS.warning)], components: [] });
      const back = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('setup:staff').setLabel('حالة الإداريين').setEmoji('👥').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('setup:home').setLabel('الرئيسية').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
      );
      return i.editReply({ embeds: [staffSync.reportEmbed(report)], components: [back] });
    },
    'setup:staff': async (i) => i.update(staffPage()),
    'setup:roles': async (i, [team, idx]) => i.update(rolesPage(team, Number(idx))),
    'setup:channels': async (i, [idx]) => i.update(channelsPage(Number(idx))),
    'setup:activity': async (i) => i.update(activityPage()),
    'setup:ticket-source': async (i) => i.update(ticketSourcePage()),
    'setup:governance': async (i) => i.update(governancePage()),
    'setup:policies': async (i) => i.update(policiesPage()),
    'setup:vacation-timing': async (i) => {
      const cur = settings.leavePolicy().vacationRoleTiming || 'at_start';
      const next = cur === 'at_start' ? 'at_approval' : 'at_start';
      settings.setPolicy('vacationRoleTiming', next);
      return i.update(policiesPage());
    },
    'setup:policies-edit-leave': async (i) => {
      return forms.open(i, modals.leavePolicy({ policy: settings.leavePolicy() }));
    },
    'setup:policies-leave-modal': async (i) => {
      const vals = {
        maxConcurrent: Number(i.fields.getTextInputValue('maxConcurrent')),
        maxDays: Number(i.fields.getTextInputValue('maxDays')),
        maxDaysPer90: Number(i.fields.getTextInputValue('maxDaysPer90')),
        pendingExpireDays: Number(i.fields.getTextInputValue('pendingExpireDays')),
      };
      if (Object.values(vals).some(v => !Number.isInteger(v) || v < 1 || v > 365)) return replyEphemeral(i, '❌ القيم يجب أن تكون أرقاماً صحيحة بين 1 و 365.', COLORS.danger);
      for (const [k, v] of Object.entries(vals)) settings.setPolicy(k === 'maxConcurrent' ? 'leaveMaxConcurrent' : k === 'maxDays' ? 'leaveMaxDays' : k === 'maxDaysPer90' ? 'leaveMaxDaysPer90' : 'leavePendingExpireDays', v);
      await i.reply({ embeds: [embed('✅ تم الحفظ', 'تم تحديث سياسات الإجازات.', COLORS.success)], ephemeral: true });
      return i.message?.edit ? null : null;
    },
    'setup:policies-edit-resign': async (i) => {
      return forms.open(i, modals.resignPolicy({ policy: settings.resignationPolicy() }));
    },
    'setup:policies-resign-modal': async (i) => {
      const noticeDays = Number(i.fields.getTextInputValue('noticeDays'));
      const escalateDays = Number(i.fields.getTextInputValue('escalateDays'));
      if (!Number.isInteger(noticeDays) || noticeDays < 1 || noticeDays > 30) return replyEphemeral(i, '❌ فترة الإشعار يجب أن تكون بين 1 و30 يوماً.', COLORS.danger);
      if (!Number.isInteger(escalateDays) || escalateDays < 1 || escalateDays > 14) return replyEphemeral(i, '❌ تصعيد المعلّقة يجب أن يكون بين 1 و14 يوماً.', COLORS.danger);
      settings.setPolicy('resignationNoticeDays', noticeDays);
      settings.setPolicy('resignationEscalateDays', escalateDays);
      return replyEphemeral(i, '✅ تم تحديث سياسات الاستقالة.', COLORS.success);
    },
    'setup:policies-advanced': async (i) => forms.open(i, modals.advancedLeave()),
    'setup:policies-advanced-modal': async (i) => {
      const numbers = {
        leaveAnnualDays: Number(normalizeDigits(i.fields.getTextInputValue('annualDays')).trim()),
        leaveTeamCover: Number(normalizeDigits(i.fields.getTextInputValue('teamCover')).trim()),
        leavePendingEscalateHours: Number(normalizeDigits(i.fields.getTextInputValue('escalateHours')).trim()),
      };
      const bounds = { leaveAnnualDays: [0, 365], leaveTeamCover: [0, 50], leavePendingEscalateHours: [0, 720] };
      for (const [key, value] of Object.entries(numbers)) {
        const [min, max] = bounds[key];
        if (!Number.isInteger(value) || value < min || value > max) return replyEphemeral(i, `❌ «${key}» يجب أن يكون رقماً صحيحاً بين ${min} و${max}.`, COLORS.danger);
      }
      const weeklyOff = (i.fields.getStringSelectValues?.('weeklyOff') || []).map(Number).filter(d => d >= 0 && d <= 6);
      const enforce = (i.fields.getStringSelectValues('enforceTeamCover')[0] || 'no') === 'yes';
      for (const [key, value] of Object.entries(numbers)) settings.setPolicy(key, value);
      settings.setPolicy('leaveWeeklyOff', weeklyOff);
      settings.setPolicy('leaveWorkdayCounting', weeklyOff.length > 0);
      settings.setPolicy('leaveEnforceTeamCover', enforce);
      audit.record({ action: 'leave_policy_updated', actorId: i.user.id, details: { ...numbers, weeklyOff, enforce }, channelId: i.channelId });
      const summary = embed('✅ تم حفظ قواعد الإجازات المتقدمة', [
        `الرصيد السنوي: **${numbers.leaveAnnualDays || 'بلا سقف'}**`,
        `أدنى تغطية للفريق: **${numbers.leaveTeamCover}** (${enforce ? 'مفروضة عند الاعتماد' : 'تحذير فقط'})`,
        `تصعيد المعلّق بعد: **${numbers.leavePendingEscalateHours}** ساعة`,
        `الاحتساب: **${weeklyOff.length ? `أيام العمل فقط — الراحة: ${weeklyOff.map(d => WEEKDAY_NAMES[d]).join('، ')}` : 'كل يوم تقويمي'}**`,
      ].join('\n'), COLORS.success);
      await i.reply({ embeds: [summary], ephemeral: true });
      try { await i.message?.edit?.(policiesPage()); } catch { /* الرسالة قد تكون قديمة */ }
      return null;
    },
    'setup:policies-reset': async (i) => {
      for (const k of ['leaveMaxConcurrent', 'leaveMaxDays', 'leaveMaxDaysPer90', 'leavePendingExpireDays', 'resignationNoticeDays', 'resignationEscalateDays', 'vacationRoleTiming', 'leaveAnnualDays', 'leaveTeamCover', 'leavePendingEscalateHours', 'leaveWorkdayCounting', 'leaveWeeklyOff', 'leaveEnforceTeamCover']) settings.resetPolicy(k);
      return i.update(policiesPage());
    },

    'setup:pickrole': async (i, [team, idx]) => {
      const ranks = team === 'support' ? SUPPORT_RANKS : team === 'moderation' ? MOD_RANKS : team === 'general_management' ? GENERAL_MANAGEMENT_RANKS : SYSTEM_ROLES;
      const n = Number(idx);
      const roleId = i.values[0];
      const role = i.guild.roles.cache.get(roleId);
      if (role && i.guild.members.me && role.position >= i.guild.members.me.roles.highest.position) {
        await i.reply({ embeds: [embed(null, `⚠️ تم الحفظ، لكن رتبة **${role.name}** أعلى من رتبة البوت — لن يستطيع تعديلها عند الترقية/الاستقالة. ارفع رتبة البوت فوقها.`, COLORS.warning)], ephemeral: true });
        settings.setRole(team, ranks[n].name, roleId);
        return i.message.edit(n < ranks.length - 1 ? rolesPage(team, n + 1) : homePage());
      }
      settings.setRole(team, ranks[n].name, roleId);
      return i.update(n < ranks.length - 1 ? rolesPage(team, n + 1) : homePage());
    },
    'setup:pickchannel': async (i, [idx]) => {
      const n = Number(idx);
      settings.setChannel(settings.CHANNEL_KEYS[n], i.values[0]);
      return i.update(n < settings.CHANNEL_KEYS.length - 1 ? channelsPage(n + 1) : homePage());
    },
    'setup:pickactivity': async (i, [type]) => {
      settings.setActivity(type, i.values);
      return i.update(activityPage());
    },
    'setup:pickticketsource': async (i) => {
      settings.setChannel('ticket-source-logs', i.values[0]);
      return i.update(ticketSourcePage());
    },
    'setup:pickgovernance': async (i) => {
      settings.setGovernanceRole(i.values[0]);
      return i.update(governancePage());
    },
    'setup:autoroles': async (i, [team]) => {
      const matched = autoMatchRoles(i.guild, team);
      await i.update(rolesPage(team, 0));
      return i.followUp({ embeds: [embed('🪄 المطابقة التلقائية', matched.length ? `تم ربط **${matched.length}** رتبة:\n${matched.join('\n')}\n\nراجعها وعدّل ما تحتاج.` : 'لم أجد رتباً بأسماء مطابقة. اخترها يدوياً من القائمة.', matched.length ? COLORS.success : COLORS.warning)], ephemeral: true });
    },
    'setup:autochannels': async (i) => {
      const matched = autoMatchChannels(i.guild);
      await i.update(channelsPage(0));
      return i.followUp({ embeds: [embed('🪄 المطابقة التلقائية', matched.length ? `تم ربط **${matched.length}** قناة:\n${matched.join('\n')}` : 'لم أجد قنوات بأسماء مطابقة. اخترها يدوياً أو استخدم **الإنشاء التلقائي**.', matched.length ? COLORS.success : COLORS.warning)], ephemeral: true });
    },
    'setup:autocreate': async (i) => {
      if (!i.guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) return replyEphemeral(i, '❌ البوت يحتاج صلاحية **إدارة القنوات** لإنشائها تلقائياً.', COLORS.danger);
      await i.deferUpdate();
      try {
        const { created, category } = await autoCreate(i.guild, i.guild.members.me);
        await i.editReply(homePage());
        return i.followUp({ embeds: [embed('✨ تم إنشاء القنوات', `أُنشئت **${created.length}** قناة داخل الكاتيجوري **${category?.name}**:\n${created.join(' ')}\n\n🔒 القنوات الحساسة (الاستقالات، المراجعة، التقارير…) مرئية للإدارة العليا فقط${settings.status().anyRole ? '' : ' — **حدد الرتب أولاً** ثم عدّل صلاحيات القنوات'}.`, COLORS.success)], ephemeral: true });
      } catch (e) {
        return i.followUp({ embeds: [embed('❌ فشل الإنشاء', e.message, COLORS.danger)], ephemeral: true });
      }
    },
  },
  homePage,
};
