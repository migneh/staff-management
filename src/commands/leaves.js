'use strict';
const { randomBytes } = require('node:crypto');
const forms = require('../ui/forms');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { LEVELS, LEAVE_TYPES, LEAVE_RULES, TEAMS, WEEKDAYS_AR } = require('../constants');
const settings = require('../services/settings');
const { getDb } = require('../database');
const leaveService = require('../services/leaves');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, sendToChannel, getChannel, isValidDate, today, addDays, dm, log, truncate, arDigits: AR } = require('../utils');
const kit = require('../ui/kit');

const STATUS_AR = { pending: '⏳ معلّق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي', cancelled: '🚫 ملغى' };
const STATUS_COLOR = { pending: COLORS.warning, approved: COLORS.success, rejected: COLORS.danger, ended: COLORS.gray, cancelled: COLORS.gray };


// ===== مسودة الطلب: مراجعة قبل الإرسال =====
const DRAFT_TTL = 15 * 60 * 1000;
const drafts = new Map();

function saveDraft(i, data) {
  for (const [key, d] of drafts) if (d.expires <= Date.now()) drafts.delete(key);
  if (drafts.size >= 300) drafts.delete(drafts.keys().next().value);
  const token = randomBytes(8).toString('hex');
  drafts.set(token, { token, userId: i.user.id, owner: i.user.id, guild: i.guildId, expires: Date.now() + DRAFT_TTL, ...data });
  return drafts.get(token);
}
function getDraft(i, token) {
  const d = drafts.get(String(token));
  if (!d || d.owner !== i.user.id || d.guild !== i.guildId || d.expires <= Date.now()) return null;
  return d;
}
function draftRow(token, { submit = true } = {}) {
  const row = new ActionRowBuilder();
  if (submit) row.addComponents(new ButtonBuilder().setCustomId(`leave:draft-submit:${token}`).setLabel('إرسال الطلب').setEmoji('📤').setStyle(ButtonStyle.Success));
  row.addComponents(
    new ButtonBuilder().setCustomId(`leave:draft-edit:${token}`).setLabel('تعديل التواريخ').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`leave:draft-cancel:${token}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
  );
  return row;
}
/** كل نماذج الإجازات: الاسم في Label، وقاعدة الإدخال في الشرح. */
const modals = {
  request: ({ type, prefill = {} } = {}) => ({
    id: `leave:modal:${type}`,
    title: `${(settings.leavePolicy(type).emoji || '🏖️')} طلب إجازة — ${LEAVE_TYPES[type]}`,
    fields: [
      forms.field({ id: 'reason', label: 'سبب الإجازة', style: 'paragraph', max: 500, value: prefill.reason,
        description: 'اكتب السبب بوضوح؛ يقرأه المراجع مع سجل الفريق قبل القرار.' }),
      forms.field({ id: 'start', label: 'تاريخ البداية', max: 20, value: prefill.start, placeholder: today(),
        description: `سنة-شهر-يوم مثل ${today()}، أو يوم/شهر/سنة، أو «اليوم» و«غدا».` }),
      forms.field({ id: 'end', label: 'تاريخ النهاية', max: 20, value: prefill.end,
        description: 'يوم النهاية محسوب ضمن الإجازة، وتُستثنى أيام الراحة الأسبوعية إن كانت محددة.' }),
      forms.field({ id: 'attachment', label: 'رابط مرفق', required: false, max: 400, value: prefill.attachment,
        description: 'اختياري: رابط يبدأ بـ https:// (تقرير طبي مثلاً).' }),
    ],
    note: 'لن يُرسل الطلب بعد هذه الخطوة: سترى بطاقة مراجعة بالرصيد وتغطية الفريق، ثم تؤكد الإرسال.',
  }),
  reject: ({ id } = {}) => ({
    id: `leave:rejectmodal:${id}`,
    title: `❌ سبب رفض الطلب #${id}`,
    fields: [
      forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
        options: [
          { label: 'تغطية الفريق غير كافية', value: 'تغطية الفريق غير كافية في هذه الفترة' },
          { label: 'تعارض مع إجازة أخرى', value: 'تعارض مع إجازة معتمدة لنفس الفريق' },
          { label: 'ضغط عمل في الفترة', value: 'ضغط عمل متوقع في الفترة المطلوبة' },
          { label: 'رصيد غير كافٍ', value: 'الرصيد المتاح لا يسمح بهذه المدة' },
          { label: 'يحتاج توضيحاً من العضو', value: 'يحتاج توضيحاً إضافياً من العضو' },
        ],
        description: 'اختر سبباً أو أكثر، أو اكتب سبباً مخصصاً في الحقل التالي.' }),
      forms.field({ id: 'reason', label: 'سبب مخصص', required: false, style: 'paragraph', max: 300,
        description: 'يُرسل للعضو في الخاص ويُسجَّل مع قرار الرفض.' }),
    ],
    note: 'الرفض يغلق الطلب نهائياً؛ إن كان التاريخ وحده هو المشكلة فاستخدم «تعديل مقترح» بدلاً منه.',
  }),
  suggest: ({ id, start: from = '', end: to = '' } = {}) => ({
    id: `leave:suggestmodal:${id}`,
    title: `💡 اقتراح تواريخ — طلب #${id}`,
    fields: [
      forms.field({ id: 'start', label: 'البداية المقترحة', max: 20, value: from,
        description: 'سنة-شهر-يوم، أو يوم/شهر/سنة، أو «اليوم» و«غدا».' }),
      forms.field({ id: 'end', label: 'النهاية المقترحة', max: 20, value: to,
        description: 'يجب أن تكون بعد البداية أو مساوية لها في يوم واحد.' }),
      forms.field({ id: 'note', label: 'ملاحظة للعضو', required: false, style: 'paragraph', max: 300,
        description: 'اختياري: اشرح سبب الاقتراح ليقبله العضو بسهولة.' }),
    ],
    note: 'يصل الاقتراح للعضو في الخاص وفي /my-leaves، والقبول يحدّث التواريخ ويُبقي الطلب معلقاً لقراري.',
  }),
  extend: ({ id, end: current = '' } = {}) => ({
    id: `leave:extendmodal:${id}`,
    title: `↗️ تمديد الإجازة #${id}`,
    fields: [
      forms.field({ id: 'new_end', label: 'تاريخ النهاية الجديد', max: 20, value: current,
        description: 'سنة-شهر-يوم بعد النهاية الحالية. تُحتسب السقوف والتغطية من جديد قبل التمديد.' }),
    ],
    note: 'التمديد يُسجَّل في سجل التدقيق ويُحدَّث معه إشعار العضو وبطاقة الطلب.',
  }),
};


// ===== الطلب بدون كتابة تواريخ: اختيار البداية والمدة والسبب بنقرات =====
const QUICK_REASONS = {
  normal: ['سفر أو مناسبة عائلية', 'ظرف عائلي', 'راحة واستعادة تركيز', 'مناسبة شخصية'],
  emergency: ['ظرف طارئ', 'حالة وفاة', 'طارئ عائلي'],
  sick: ['وعكة صحية', 'موعد طبي', 'نقاهة بعد مرض'],
  study: ['فترة اختبارات', 'التزام دراسي', 'دورة تدريبية'],
  special: ['ظروف عائلية', 'ظرف شخصي', 'مناسبة خاصة'],
};

/** أقرب يوم مسموح لنوع الإجازة حسب مدة الإشعار المطلوبة. */
function earliestStartFor(type) {
  const hours = Number(settings.leavePolicy(type).minNoticeHours) || 0;
  return addDays(today(), Math.ceil(hours / 24));
}

/** أيام البداية الجاهزة: اليوم ثم تسعة أيام باسم اليوم وتاريخه، مع تنبيه الأيام المتأخرة عن الإشعار. */
function quickStartOptions(earliest = null) {
  const base = today();
  const names = WEEKDAYS_AR;
  return Array.from({ length: 10 }, (_, offset) => {
    const date = addDays(base, offset);
    const label = offset === 0 ? `اليوم — ${date.slice(5)}` : offset === 1 ? `غداً — ${date.slice(5)}` : `${names[new Date(`${date}T00:00:00Z`).getUTCDay()]} ${date.slice(5)}`;
    const late = earliest && date < earliest;
    return { label, value: date, ...(offset === 0 ? { emoji: '📍' } : {}), ...(late ? { description: '⚠️ أقل من مهلة الإشعار المطلوبة لهذا النوع' } : {}) };
  });
}
const QUICK_DAY_COUNTS = [1, 2, 3, 5, 7, 10, 14];

/** تاريخ النهاية الذي يحقّق عدد أيام العمل المطلوب (يتخطى أيام الراحة الأسبوعية). */
function endForCountedDays(start, wanted) {
  const policy = settings.leavePolicy();
  let end = start;
  for (let guard = 0; guard < 90; guard++) {
    if (leaveService.countedDays(start, end, policy) >= wanted) return end;
    end = addDays(end, 1);
  }
  return addDays(start, wanted - 1);
}

/** بطاقة الاختيار السريع: كل شيء بنقرة، والكتابة اليدوية تبقى متاحة. */
function quickCard(d, { error = null } = {}) {
  const rule = LEAVE_RULES[d.leaveType] || {};
  const start = d.start || null;
  const earliest = earliestStartFor(d.leaveType);
  const days = d.days || null;
  const end = start && days ? endForCountedDays(start, days) : null;
  const counted = end ? leaveService.countedDays(start, end) : null;
  const late = start && start < earliest;
  const status = error ? `⚠️ ${error}`
    : late ? `⚠️ **${LEAVE_TYPES[d.leaveType]}** تحتاج إشعاراً ${settings.leavePolicy(d.leaveType).minNoticeHours} ساعة — أقرب يوم مسموح: ${kit.tsDate(earliest)}. اختر يوماً لاحقاً.`
      : (start && days && d.reason ? '✅ جاهز — اضغط **متابعة** لعرض بطاقة المراجعة الكاملة قبل الإرسال.' : '_اختر البداية والمدة والسبب، ثم اضغط متابعة._');
  const lines = [
    `**النوع:** ${rule.emoji || '🏖️'} ${LEAVE_TYPES[d.leaveType]} — حتى ${settings.leavePolicy(d.leaveType).maxDays} يوم`,
    '',
    status,
  ];
  const fields = [
    { name: '📍 البداية', value: start ? `${kit.tsDate(start)} • ${kit.relativeDays(kit.daysFromToday(start))}` : '_لم تُحدَّد بعد_', inline: true },
    { name: '🗓️ المدة', value: days ? `${AR(days)} ${kit.daysWord(days)}` : '_لم تُحدَّد بعد_', inline: true },
    { name: '📝 السبب', value: d.reason || '_لم يُحدَّد بعد_', inline: true },
    counted && counted !== days ? { name: '🧮 أيام العمل المحتسبة', value: `${AR(counted)} ${kit.daysWord(counted)}${end ? ` • حتى ${kit.tsDate(end)}` : ''}`, inline: true } : null,
  ];
  const rows = [
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`leave:qstart:${d.token}`).setPlaceholder('📍 يوم البداية')
      .addOptions([...quickStartOptions(earliest), { label: 'تواريخ مخصصة…', value: 'custom', emoji: '✏️', description: 'اكتبها بنفسك في نموذج قصير' }])),
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`leave:qdays:${d.token}`).setPlaceholder('🗓️ المدة')
      .addOptions([...QUICK_DAY_COUNTS.map(n => ({ label: `${n} ${kit.daysWord(n)}`, value: String(n), ...(n === 7 ? { description: 'أسبوع كامل' } : n === 14 ? { description: 'أسبوعان' } : {}) })),
        { label: 'مدة مخصصة…', value: 'custom', emoji: '✏️' }])),
    new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId(`leave:qreason:${d.token}`).setPlaceholder('📝 السبب')
      .addOptions([...(QUICK_REASONS[d.leaveType] || QUICK_REASONS.normal).map(text => ({ label: truncate(text, 90), value: text })),
        { label: 'سبب آخر…', value: 'custom', emoji: '✏️' }])),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`leave:qgo:${d.token}`).setLabel('متابعة').setEmoji('➡️').setStyle(ButtonStyle.Primary).setDisabled(!(start && days && d.reason)),
      new ButtonBuilder().setCustomId(`leave:draft-edit:${d.token}`).setLabel('كتابة يدوية').setEmoji('✏️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`leave:draft-cancel:${d.token}`).setLabel('إلغاء').setEmoji('✖️').setStyle(ButtonStyle.Danger),
    ),
  ];
  const e = kit.card({
    title: `${rule.emoji || '🏖️'} طلب إجازة — اختر بنقرة`,
    description: [...lines, '', '_لا يُرسل أي طلب من هذه الشاشة._'].join('\n'),
    fields,
    color: error || late ? COLORS.warning : COLORS.info,
    footer: kit.footerLine('🖱️ اختر بالنقر — الإرسال من بطاقة المراجعة فقط'),
  });
  return { embeds: [e], components: rows };
}

/** بطاقة المراجعة: كل الأرقام التي يحتاجها العضو قبل أن يضغط «إرسال». */
function draftEmbed(draft, pv) {
  const rule = LEAVE_RULES[draft.leaveType] || {};
  const lines = [
    `**النوع:** ${rule.emoji || '🏖️'} ${LEAVE_TYPES[draft.leaveType]} — حتى ${pv.policy.maxDays} يوم عمل`,
    `**الفترة:** ${kit.tsDate(draft.start)} → ${kit.tsDate(draft.end)}`,
    `**المحتسب:** **${pv.counted}** ${kit.daysWord(pv.counted)}${pv.span !== pv.counted ? ` • تقويمياً ${pv.span} يوم` : ''}`,
    pv.skipped.length ? `**أيام راحة لا تُحتسب:** ${leaveService.offDaysLabel(pv.skipped)} (${pv.skipped.length})` : null,
    pv.noticeHours != null ? `**الإشعار قبل البداية:** ${pv.noticeHours} ساعة` : null,
    '',
    'لم يُرسل شيء بعد. راجع الأرقام ثم اضغط **إرسال الطلب**، أو **تعديل التواريخ**.',
  ].filter(Boolean);
  const cov = pv.coverage;
  const fields = [];
  const push = (name, value, inline = true) => { if (value) fields.push({ name, value, inline }); };
  push('👥 التغطية العامة', `${kit.coverageBar(cov.peak, cov.max)} • ${AR(cov.peak)}/${AR(cov.max)}\n${cov.peak >= cov.max ? '⚠️ ممتلئة — احتمال الرفض مرتفع' : cov.peak >= cov.max - 1 ? '🟡 شبه ممتلئة' : '✅ توجد سعة'}`);
  if (pv.impact) push(`🧑‍🤝‍🧑 تغطية ${TEAMS[pv.impact.team] || pv.impact.team}`, `${pv.impact.current} → **${pv.impact.after}**\n${pv.impact.below ? `⚠️ أقل من الحد الأدنى (${pv.impact.required})` : `✅ الحد الأدنى ${pv.impact.required}`}`);
  const own = pv.allowance.types[draft.leaveType];
  if (own) push('🎯 رصيدك', `مستخدم 90 يوماً: **${AR(own.used90)}/${AR(own.cap90)}**\nالمتبقي: **${AR(own.remaining90)}**${own.pending90 ? ` (+${AR(own.pending90)} معلّق)` : ''}`);
  if (pv.allowance.annual.cap) push(`📅 الرصيد السنوي ${pv.allowance.annual.year}`, `مستخدم **${AR(pv.allowance.annual.used)}/${AR(pv.allowance.annual.cap)}** • المتبقي **${AR(pv.allowance.annual.remaining)}**`);
  if (pv.allowance.nextAllowedStart) push('⏳ أقرب بداية مسموحة', `${kit.tsDate(pv.allowance.nextAllowedStart)} • ${kit.relativeDays(kit.daysFromToday(pv.allowance.nextAllowedStart))}`);
  if (pv.warnings.length) push('⚠️ ملاحظات قبل الإرسال', pv.warnings.map(w => `• ${w}`).join('\n'), false);
  const e = kit.card({
    title: `${rule.emoji || '🏖️'} راجع طلب إجازتك`,
    description: lines.join('\n'),
    fields,
    color: pv.warnings.length ? COLORS.warning : COLORS.info,
    footer: kit.footerLine(`⌛ تنتهي المسودة خلال 15 دقيقة • #${draft.leaveType} • الإغلاق لا يرسل شيئاً`),
  });
  return e;
}
/** نشر الطلب وإبلاغ صاحبه — يُستخدم من المسودة فقط حتى لا يتكرر الإنشاء. */
async function publishRequest(i, row) {
  const cov = leaveService.coverageBetween(row.start_date, row.end_date);
  const impact = leaveService.teamImpact(row.user_id, row.start_date, row.end_date, { excludeId: row.id });
  const flags = [covText(cov)];
  if (impact?.below) flags.push(`🧑‍🤝‍🧑 تغطية ${TEAMS[impact.team] || impact.team} ستنخفض إلى ${impact.after} (الحد ${impact.required})`);
  const msg = await sendToChannel(i.client, 'leave-requests', { content: flags.join('\n'), embeds: [leaveEmbed(row)], components: [reviewRow(row.id)] });
  if (msg) getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run(msg.id, row.id);
  const summary = embed('✅ تم إرسال طلبك', [
    `**#${row.id}** — ${LEAVE_TYPES[row.leave_type]} • ${kit.tsDate(row.start_date)} → ${kit.tsDate(row.end_date)} • **${row.duration_days}** ${kit.daysWord(row.duration_days)}`,
    `الحالة: **${STATUS_AR[row.status]}** — سيصلك القرار في الخاص.`,
    covText(cov),
  ].join('\n'), COLORS.success);
  return replyEphemeral(i, summary, COLORS.success);
}

function leaveEmbed(r, color) {
  const rule = LEAVE_RULES[r.leave_type] || {};
  const dur = r.duration_days ?? (isValidDate(r.start_date) && isValidDate(r.end_date) ? leaveService.durationDays(r.start_date, r.end_date) : null);
  const e = embed(`${rule.emoji || '🏖️'} إجازة #${r.id} — ${LEAVE_TYPES[r.leave_type] || r.leave_type}`, null, color || STATUS_COLOR[r.status] || COLORS.info)
    .addFields(
      { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
      { name: 'الحالة', value: STATUS_AR[r.status] || r.status, inline: true },
      { name: 'المدة', value: dur ? `**${dur}** ${kit.daysWord(dur)}` : r.start_date ? `${r.start_date} → ${r.end_date}` : '—', inline: true },
      { name: 'من', value: r.start_date ? `${kit.tsDate(r.start_date)} • ${kit.relativeDays(kit.daysFromToday(r.start_date))}` : '—', inline: true },
      { name: 'إلى', value: r.end_date ? `${kit.tsDate(r.end_date)} • ${kit.relativeDays(kit.daysFromToday(r.end_date))}` : '—', inline: true },
      { name: 'السبب', value: r.reason || '—' },
    );
  if (r.notice_hours != null) e.addFields({ name: '⏰ الإشعار', value: `${r.notice_hours} ساعة`, inline: true });
  if (r.attachment_url) e.addFields({ name: '📎 مرفق', value: `[فتح](${r.attachment_url})`, inline: true });
  if (r.extended_count) e.addFields({ name: '↗️ تمديد', value: `${r.extended_count} مرة`, inline: true });
  if (r.reviewed_by) e.addFields({ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` });
  if (r.cancel_reason) e.addFields({ name: 'سبب الإلغاء', value: r.cancel_reason });
  if (r.end_reason) e.addFields({ name: 'سبب الإنهاء', value: { auto: 'انتهاء المدة', early: 'إنهاء مبكر', resignation: 'استقالة', admin: 'إدارياً' }[r.end_reason] || r.end_reason, inline: true });
  if (r.role_applied_at) e.addFields({ name: '🏖️ رتبة in vacation', value: r.role_removed_at ? `أُزيلت ${kit.tsRelative(r.role_removed_at)}` : 'مفعّلة', inline: true });
  e.setFooter({ text: `#${r.id} • ${LEAVE_TYPES[r.leave_type] || r.leave_type} • ${STATUS_AR[r.status] || r.status}` });
  return e;
}

function coverageField(start, end) {
  const cov = leaveService.coverageBetween(start, end);
  const bar = kit.coverageBar(cov.peak, cov.max);
  const day = cov.peakDay !== start ? ` (ذروة ${kit.tsDate(cov.peakDay)})` : '';
  return { name: `👥 التغطية خلال الفترة`, value: `${bar}${day}\n${cov.peak >= cov.max ? '⚠️ الفترة ممتلئة — قد يُرفض الطلب' : cov.peak >= cov.max - 1 ? '🟡 الفترة شبه ممتلئة' : '✅ توجد سعة'}` };
}

function calendarPayload(start, days, viewerId = null) {
  const policy = settings.leavePolicy();
  const lines = [];
  let fullDays = 0;
  let mine = 0;
  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const cov = leaveService.coverageFor(date);
    const off = leaveService.weeklyOffDays(policy).includes(new Date(`${date}T00:00:00Z`).getUTCDay());
    if (cov.count >= cov.max) fullDays += 1;
    const people = cov.rows.length
      ? cov.rows.map(r => {
        const label = `${r.user_id === viewerId ? '⭐ ' : ''}<@${r.user_id}> (${LEAVE_TYPES[r.leave_type] || r.leave_type})`;
        if (r.user_id === viewerId) mine += 1;
        return label;
      }).join('، ').slice(0, 400)
      : 'لا أحد';
    lines.push(`${off ? '🛌' : '📅'} **${kit.tsDate(date)}** ${kit.coverageBar(cov.count, cov.max)} • ${cov.count}/${cov.max}${off ? ' • راحة أسبوعية' : ''}\n${people}`);
  }
  const e = embed(`🗓️ تقويم الإجازات — ${kit.tsDate(start)} → ${kit.tsDate(addDays(start, days - 1))}`, lines.join('\n\n').slice(0, 3800), fullDays ? COLORS.warning : COLORS.info);
  e.addFields(
    { name: 'ملخص', value: `أيام ممتلئة: **${fullDays}**/${days} • الحد الأقصى ${policy.maxConcurrent}${viewerId && mine ? ` • أنت مجاز في **${mine}** يوم` : ''}`, inline: true },
    { name: 'السقف', value: `أطول إجازة ${policy.maxDays} يوم • الراحة بين الإجازات ${policy.minGapDays} يوم`, inline: true },
  );
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`leave:cal:${addDays(start, -days)}:${days}`).setLabel('السابق').setEmoji('◀️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`leave:cal:${today()}:${days}`).setLabel('اليوم').setEmoji('📍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`leave:cal:${addDays(start, days)}:${days}`).setLabel('التالي').setEmoji('▶️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`leave:cal:${start}:${days === 7 ? 14 : 7}`).setLabel(days === 7 ? 'أسبوعان' : 'أسبوع').setEmoji('🔁').setStyle(ButtonStyle.Secondary),
  );
  e.setFooter({ text: 'التغطية من الإجازات المعتمدة فقط • ⭐ = إجازتك • 🛌 = راحة أسبوعية' });
  return { embeds: [e], components: [row] };
}


const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('موافقة').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`leave:suggest:${id}`).setLabel('تعديل مقترح').setEmoji('💡').setStyle(ButtonStyle.Primary),
  new ButtonBuilder().setCustomId(`leave:details:${id}`).setLabel('تفاصيل').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
);

/**
 * بطاقة قرار المراجع: تحوي ما يحتاجه قبل الموافقة/الرفض — التغطية، أثر الفريق،
 * سجل صاحب الطلب، وأي اقتراح قائم، بدل أن يقرر بلا سياق.
 */
function reviewCard(r) {
  const e = leaveEmbed(r);
  const cov = leaveService.coverageBetween(r.start_date, r.end_date);
  e.addFields({ name: '👥 التغطية العامة', value: `${kit.coverageBar(cov.peak, cov.max)} • ${cov.peak}/${cov.max}`, inline: true });
  const impact = leaveService.teamImpact(r.user_id, r.start_date, r.end_date, { excludeId: r.id });
  if (impact) e.addFields({ name: `🧑‍🤝‍🧑 ${TEAMS[impact.team] || impact.team}`, value: `${impact.current} → **${impact.after}**${impact.below ? `\n⚠️ أقل من الحد (${impact.required})` : `\n✅ الحد ${impact.required}`}`, inline: true });
  const hist = leaveService.memberHistory(r.user_id);
  e.addFields({ name: '📊 سجل صاحب الطلب', value: `✅ ${hist.approved} • ❌ ${hist.rejected} • 🚫 ${hist.cancelled}\nمستخدم 90 يوماً: **${hist.used90}** يوم`, inline: true });
  e.addFields({ name: '⏭️ إجازة قائمة', value: hist.next ? `${kit.tsDate(hist.next.start_date)} → ${kit.tsDate(hist.next.end_date)}` : '_لا توجد إجازة أخرى معتمدة_', inline: true });
  const skipped = leaveService.skippedOffDays(r.start_date, r.end_date);
  if (skipped.length) e.addFields({ name: '🛌 راحة أسبوعية غير محتسبة', value: `${leaveService.offDaysLabel(skipped)} (${skipped.length} يوم)`, inline: true });
  if (r.suggested_start) e.addFields({ name: '💡 اقتراح قائم', value: `${kit.tsDate(r.suggested_start)} → ${kit.tsDate(r.suggested_end)} بواسطة <@${r.suggested_by}>${r.suggested_note ? `\n${r.suggested_note}` : ''}` });
  return e;
}

async function updateRequestMessage(client, row) {
  if (!row?.message_id) return false;
  try {
    const channel = await getChannel(client, 'leave-requests');
    const message = channel ? await channel.messages.fetch(row.message_id) : null;
    if (!message) return false;
    const color = STATUS_COLOR[row.status] || COLORS.gray;
    await message.edit({ content: null, embeds: [leaveEmbed(row, color)], components: row.status === 'pending' ? [reviewRow(row.id)] : [] });
    return true;
  } catch { return false; }
}

async function fetchMember(i, userId) {
  try { return i.guild?.members?.fetch ? await i.guild.members.fetch(userId) : null; } catch { return null; }
}

/** حالة الإجازة الشخصية: اليوم، القادم، الرصيد، وأقرب بداية مسموحة. */
function myLeavesPayload(userId, page = 1) {
  const { items, total, pages, page: current } = leaveService.list({ userId, perPage: 6, page });
  const allow = leaveService.allowance(userId);
  const active = leaveService.activeForUser(userId);
  const upcoming = leaveService.approvedForUser(userId).find(r => r.start_date > today());
  const pendingCount = leaveService.pendingForUser(userId).length;
  const e = embed('🏖️ إجازاتي', total ? null : 'لا توجد إجازات مسجلة بعد.', COLORS.info);
  const todayField = active.length
    ? active.map(r => `${LEAVE_RULES[r.leave_type]?.emoji || '🏖️'} ${LEAVE_TYPES[r.leave_type]} حتى ${kit.tsDate(r.end_date)} • ${kit.relativeDays(kit.daysFromToday(r.end_date))}`).join('\n')
    : pendingCount ? `لا — لديك **${pendingCount}** طلب معلّق` : 'لا — أنت متاح اليوم';
  e.addFields({ name: '📍 حالتك اليوم', value: todayField, inline: true });
  e.addFields({ name: '⏭️ إجازتك القادمة', value: upcoming ? `${LEAVE_RULES[upcoming.leave_type]?.emoji || '🏖️'} ${kit.tsDate(upcoming.start_date)} → ${kit.tsDate(upcoming.end_date)}\nتبدأ ${kit.relativeDays(kit.daysFromToday(upcoming.start_date))}` : '_لا توجد إجازة معتمدة قادمة_', inline: true });
  const cov = leaveService.coverageFor(today());
  e.addFields({ name: '👥 تغطية اليوم', value: `${kit.coverageBar(cov.count, cov.max)} • ${cov.count}/${cov.max}`, inline: true });

  const balanceLines = Object.entries(allow.types).map(([type, t]) => {
    const rule = LEAVE_RULES[type] || {};
    if (!t.used90 && !t.pending90) return `${rule.emoji || '🏖️'} ${LEAVE_TYPES[type]}: متبقٍ **${t.remaining90}**`;
    return `${rule.emoji || '🏖️'} ${LEAVE_TYPES[type]}: مستخدم ${t.used90}/${t.cap90} — متبقٍ **${t.remaining90}**${t.pending90 ? ` (+${t.pending90} معلّق)` : ''}`;
  });
  if (allow.annual.cap) balanceLines.push(`📅 رصيد ${allow.annual.year}: مستخدم **${allow.annual.used}/${allow.annual.cap}** — متبقٍ **${allow.annual.remaining}**`);
  if (allow.nextAllowedStart) balanceLines.push(`⏳ أقرب بداية مسموحة: ${kit.tsDate(allow.nextAllowedStart)} — ${kit.relativeDays(kit.daysFromToday(allow.nextAllowedStart))}`);
  e.addFields({ name: '🎯 الرصيد (آخر 90 يوماً)', value: balanceLines.join('\n').slice(0, 1000) });

  if (total) {
    for (const r of items) {
      const rule = LEAVE_RULES[r.leave_type] || {};
      const dur = r.duration_days ? `${r.duration_days} ${kit.daysWord(r.duration_days)}` : `${r.start_date} → ${r.end_date}`;
      const hint = r.status === 'approved' && r.start_date > today() ? `• تبدأ ${kit.relativeDays(kit.daysFromToday(r.start_date))}`
        : r.status === 'approved' && r.end_date >= today() ? '• جارية الآن'
          : r.status === 'pending' ? '• بانتظار القرار' : '';
      e.addFields({ name: `${rule.emoji || '🏖️'} #${r.id} — ${STATUS_AR[r.status]} • ${dur}`, value: `${LEAVE_TYPES[r.leave_type]} • ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)} ${hint}${r.suggested_start ? `\n💡 اقترحت الإدارة: ${r.suggested_start} → ${r.suggested_end} — افتح الطلب للموافقة` : ''}${r.review_reason ? `\n↳ ${r.review_reason}` : ''}` });
    }
    e.setFooter({ text: `صفحة ${current}/${pages} • ${total} طلب • الرصيد يُحسب على الإجازات المعتمدة والمنتهية` });
  } else {
    e.setFooter({ text: 'استخدم زر «طلب إجازة» — سترى الرصيد والتغطية قبل الإرسال' });
  }

  const components = [];
  const nav = pages > 1 ? [kit.navRow({ prefix: 'leave:myleaves', page: current, pages, args: [userId] })] : [];
  const actionable = items.filter(r => ['pending', 'approved'].includes(r.status) && r.end_date >= today());
  if (actionable.length) {
    const menu = new StringSelectMenuBuilder().setCustomId(`leave:pickaction:${current}`).setPlaceholder('⚡ إجراء سريع على أحد طلبات هذه الصفحة...')
      .addOptions(actionable.slice(0, 10).map(r => ({
        label: `#${r.id} — ${r.suggested_start ? 'مراجعة الاقتراح' : r.status === 'pending' ? 'سحب الطلب' : 'تمديد الإجازة'}`,
        value: `${r.id}:${r.suggested_start ? 'suggestion' : r.status}`,
        description: r.suggested_start ? 'الإدارة اقترحت تواريخ بديلة' : r.status === 'pending' ? 'سحب الطلب وإتاحة طلب جديد' : `حتى ${r.end_date}`,
        emoji: r.suggested_start ? '💡' : r.status === 'pending' ? '🚫' : '↗️',
      })));
    components.push(new ActionRowBuilder().addComponents(menu));
  }
  components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('leave:newrequest').setLabel('طلب إجازة').setEmoji('🏖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`leave:cal:${today()}:7`).setLabel('تقويم الأسبوع').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('leave:balance').setLabel('تفاصيل الرصيد').setEmoji('🎯').setStyle(ButtonStyle.Secondary),
  ));
  components.unshift(...nav);
  return { embeds: [e], components };
}

/** تفاصيل الرصيد الشخصي — تُفتح من /leave-balance أو من زر «تفاصيل الرصيد». */
function balancePayload(userId) {
  const allow = leaveService.allowance(userId);
  const history = leaveService.memberHistory(userId, { limit: 5 });
  const e = embed('🎯 رصيد الإجازات', `<@${userId}> • محسوب حتى ${kit.tsDate(allow.date)}\nآخر 90 يوماً: مستخدم **${allow.totalUsed90}**${allow.totalPending ? ` • معلّق **${allow.totalPending}**` : ''}`, COLORS.info);
  e.addFields({
    name: 'حسب النوع', value: Object.entries(allow.types).map(([type, t]) => {
      const rule = LEAVE_RULES[type] || {};
      return `${rule.emoji || '🏖️'} **${LEAVE_TYPES[type]}** — ${kit.progressBar(t.used90, t.cap90 || 1, 8)} ${t.used90}/${t.cap90}\nمتبقٍ **${t.remaining90}** يوم${t.pending90 ? ` • معلّق ${t.pending90}` : ''} • سقف الطلب ${rule.maxDays} يوم`;
    }).join('\n'),
  });
  if (allow.annual.cap) e.addFields({ name: `📅 الرصيد السنوي ${allow.annual.year}`, value: `${kit.progressBar(allow.annual.used, allow.annual.cap, 10)} ${allow.annual.used}/${allow.annual.cap}\nمتبقٍ **${allow.annual.remaining}** يوم${allow.annual.pending ? ` • معلّق ${allow.annual.pending}` : ''}` });
  else e.addFields({ name: '📅 الرصيد السنوي', value: 'غير مفعّل — تعتمد الإدارة على سقف 90 يوماً لكل نوع. يمكن للمسؤول تفعيله من /setup ← السياسات.' });
  const lines = [
    `✅ معتمدة: **${history.approved}** • ❌ مرفوضة: **${history.rejected}** • 🚫 ملغاة: **${history.cancelled}**`,
    history.next ? `⏭️ القادمة: ${kit.tsDate(history.next.start_date)} → ${kit.tsDate(history.next.end_date)}` : '⏭️ لا توجد إجازة قادمة',
    allow.nextAllowedStart ? `⏳ أقرب بداية مسموحة: ${kit.tsDate(allow.nextAllowedStart)} (بعد يوم راحة إلزامي)` : null,
  ].filter(Boolean);
  e.addFields({ name: 'ملخص سريع', value: lines.join('\n') });
  if (history.recent.length) e.addFields({ name: 'آخر الطلبات', value: history.recent.map(r => `\`#${r.id}\` ${STATUS_AR[r.status]} • ${LEAVE_TYPES[r.leave_type]} • ${r.start_date} → ${r.end_date}`).join('\n').slice(0, 1000) });
  e.setFooter({ text: `الحد الأقصى للمجازين في اليوم: ${allow.maxConcurrent} • أطول إجازة: ${allow.maxDays} يوم` });
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('leave:newrequest').setLabel('طلب إجازة').setEmoji('🏖️').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('leave:myleaves:1').setLabel('إجازاتي').setEmoji('📋').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`leave:cal:${today()}:7`).setLabel('التقويم').setEmoji('🗓️').setStyle(ButtonStyle.Secondary),
  )], allowedMentions: { parse: [] } };
}

/**
 * لوحة الإجازات للإدارة في رسالة واحدة: إحصاءات + جدول مختصر + تصفية + تنقّل،
 * وفتح أي طلب من القائمة بدل إرسال عدة بطاقات متفرقة.
 */
function dashboardPayload({ status = null, type = null, page = 1, viewerId = null } = {}) {
  const perPage = 8;
  const filters = [];
  const params = [];
  let query = 'SELECT * FROM leave_requests WHERE 1=1';
  if (status) { query += ' AND status = ?'; filters.push(STATUS_AR[status] || status); params.push(status); }
  if (type) { query += ' AND leave_type = ?'; filters.push(LEAVE_TYPES[type] || type); params.push(type); }
  query += " ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'approved' THEN 1 ELSE 2 END, start_date DESC, id DESC";
  const all = getDb().prepare(query).all(...params);
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const rows = all.slice((current - 1) * perPage, current * perPage);

  const pendingTotal = getDb().prepare("SELECT COUNT(*) c FROM leave_requests WHERE status = 'pending'").get().c;
  const upcoming = getDb().prepare('SELECT COUNT(*) c FROM leave_requests WHERE status = ? AND start_date > ?').get('approved', today()).c;
  const covToday = leaveService.coverageFor(today());
  const oldest = getDb().prepare("SELECT MIN(created_at) created FROM leave_requests WHERE status = 'pending'").get().created;
  const body = rows.length ? rows.map(r => {
    const rule = LEAVE_RULES[r.leave_type] || {};
    return `${rule.emoji || '🏖️'} ` + '`#' + `${r.id}` + '`' + ` ${STATUS_AR[r.status]} • <@${r.user_id}> • ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}`;
  }).join('\n') : '_لا توجد طلبات بهذه التصفية._';
  const e = embed(`🏖️ لوحة الإجازات${filters.length ? ` — ${filters.join(' • ')}` : ''}`, [
    `⏳ معلّقة: **${pendingTotal}**${oldest ? ` (أقدمها ${kit.tsRelative(oldest)})` : ''}`,
    `👥 مجازون اليوم: ${kit.coverageBar(covToday.count, covToday.max)} • ${covToday.count}/${covToday.max}`,
    `📅 معتمدة قادمة: **${upcoming}** • السقف اليومي ${covToday.max}`,
    '',
    body,
  ].join('\n'), pendingTotal ? COLORS.warning : COLORS.info);
  e.setFooter({ text: rows.length ? `${all.length} طلب • صفحة ${current}/${pages} • اختر طلباً لعرض بطاقته الكاملة` : 'لا نتائج' });

  const components = [new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId(`leave:dashstatus:${type || 'all'}:${current}`).setPlaceholder('تصفية بالحالة')
      .addOptions([{ label: 'الكل', value: 'all', default: !status }, ...Object.entries(STATUS_AR).map(([value, label]) => ({ label, value, default: status === value }))]),
    new StringSelectMenuBuilder().setCustomId(`leave:dashtype:${status || 'all'}:${current}`).setPlaceholder('تصفية بالنوع')
      .addOptions([{ label: 'الكل', value: 'all', default: !type }, ...Object.entries(LEAVE_TYPES).map(([value, label]) => ({ label, value, default: type === value }))]),
  )];
  if (pages > 1) components.push(kit.navRow({ prefix: `leave:dashpage:${status || 'all'}:${type || 'all'}`, page: current, pages }));
  if (viewerId) components.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('leave:newrequest').setLabel('طلب إجازة').setEmoji('🏖️').setStyle(ButtonStyle.Secondary)));
  if (rows.length) components.push(new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('leave:reviewopen').setPlaceholder('افتح طلباً لعرض التفاصيل والقرار')
    .addOptions(rows.slice(0, 25).map(r => ({
      label: `#${r.id} • ${STATUS_AR[r.status]}`.slice(0, 100),
      value: String(r.id),
      description: `${r.user_id} • ${r.start_date} → ${r.end_date}`.slice(0, 100),
      emoji: LEAVE_RULES[r.leave_type]?.emoji || '🏖️',
    })))));
  return { payload: { embeds: [e], components }, rows, total: all.length, pages, page: current };
}

function pendingEmbed(page = 1) {
  const { items, total, pages } = leaveService.list({ status: 'pending', perPage: 4, page });
  if (!total) return { embeds: [embed('✅ لا توجد طلبات معلقة', 'كل طلبات الإجازة تمت مراجعتها.', COLORS.success)], components: [] };
  const e = embed(`⏳ طلبات الإجازة المعلّقة — صفحة ${page}/${pages}`, `العدد: **${total}** — الأقدم أولاً. كل بطاقة تحتوي زر **موافقة/رفض/تفاصيل**.`, COLORS.warning);
  return { embeds: [e], total, pages, items };
}

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('request-leave').setDescription('طلب إجازة بنقرات: اختَر النوع واليوم والمدة ثم راجع البطاقة قبل الإرسال')
        .addStringOption(o => o.setName('type').setDescription('نوع الإجازة — اختياري، وإن تركته تظهر قائمة الأنواع')
          .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: `${LEAVE_RULES[v]?.emoji || '🏖️'} ${n} — حتى ${LEAVE_RULES[v]?.maxDays} يوم`, value: v })))),
      level: LEVELS.STAFF,
      async execute(i) {
        const pending = getDb().prepare(`SELECT id FROM leave_requests WHERE user_id = ? AND status = 'pending'`).get(i.user.id);
        if (pending) {
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`leave:mine:${pending.id}`).setLabel('عرض الطلب المعلّق').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`leave:confirmcancel:${pending.id}`).setLabel('سحب الطلب').setEmoji('🚫').setStyle(ButtonStyle.Danger),
          );
          return i.reply({ embeds: [embed('⏳ لديك طلب معلّق', `لا يمكن إرسال طلبين في وقت واحد. الطلب الحالي **#${pending.id}** بانتظار المراجعة.\nيمكنك سحبه ثم إرسال طلب جديد، أو انتظار القرار.`, COLORS.warning)], components: [row], ephemeral: true });
        }
        const type = i.options.getString('type');
        if (!type || !LEAVE_TYPES[type]) {
          const rows = new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('leave:picktype').setPlaceholder('اختر نوع الإجازة')
            .addOptions(Object.entries(LEAVE_TYPES).map(([value, label]) => {
              const rule = settings.leavePolicy(value);
              return { label, value, emoji: LEAVE_RULES[value]?.emoji || '🏖️', description: `حتى ${rule.maxDays} يوم • إشعار ${rule.minNoticeHours} ساعة` };
            })));
          return i.reply({ embeds: [embed('🏖️ طلب إجازة جديد', [
            '**بلا كتابة تواريخ:** اختر النوع، ثم حدّد يوم البداية والمدة والسبب من قوائم جاهزة.',
            'اختيار النوع وحده لا يرسل شيئاً — سترى بطاقة مراجعة كاملة قبل الإرسال.',
          ].join('\n'), COLORS.info)], components: [rows], ephemeral: true });
        }
        const draft = saveDraft(i, { leaveType: type, start: null, end: null, days: null, reason: null, attachment: null });
        return i.reply(quickCard(draft));
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-leaves').setDescription('عرض إجازاتي مع إجراءات سريعة')
        .addIntegerOption(o => o.setName('page').setDescription('الصفحة').setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const page = i.options.getInteger('page') || 1;
        return i.reply({ ...myLeavesPayload(i.user.id, page), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-balance').setDescription('🎯 رصيد إجازاتي: المستخدم والمتبقي لكل نوع وأقرب بداية مسموحة')
        .addUserOption(o => o.setName('user').setDescription('إداري آخر — للمراجعين فقط').setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const target = i.options.getUser('user');
        if (target && target.id !== i.user.id && (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT)) return replyEphemeral(i, '❌ عرض رصيد إداري آخر متاح للمراجعين فقط.', COLORS.danger);
        return i.reply({ ...balancePayload(target?.id || i.user.id), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-history').setDescription('سجل إجازات إداري (للإدارة)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('status').setDescription('تصفية بالحالة').setRequired(false)
          .addChoices(...Object.entries(STATUS_AR).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const status = i.options.getString('status');
        const { items, total } = leaveService.list({ userId: user.id, status, perPage: 10, page: 1 });
        if (!total) return replyEphemeral(i, `لا توجد إجازات لـ <@${user.id}>${status ? ` بحالة ${STATUS_AR[status]}` : ''}.`, COLORS.gray);
        const e = embed(`🏖️ سجل إجازات <@${user.id}>`, items.map(r => {
          const rule = LEAVE_RULES[r.leave_type] || {};
          return `${rule.emoji || '🏖️'} \`#${r.id}\` ${STATUS_AR[r.status]} • ${LEAVE_TYPES[r.leave_type]} • ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}${r.reviewed_by ? ` • <@${r.reviewed_by}>` : ''}`;
        }).join('\n'), COLORS.info)
          .setFooter({ text: `${total} طلب • استخدم /leave-dashboard للمزيد` });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-dashboard').setDescription('لوحة الإجازات — مراجعة وتصفية وتغطية')
        .addStringOption(o => o.setName('status').setDescription('الحالة').setRequired(false)
          .addChoices(...Object.entries(STATUS_AR).map(([v, n]) => ({ name: n, value: v })), { name: 'الكل', value: 'all' }))
        .addStringOption(o => o.setName('type').setDescription('النوع').setRequired(false)
          .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: n, value: v })))),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const status = i.options.getString('status');
        const type = i.options.getString('type');
        const st = status === 'all' ? null : status;
        let query = 'SELECT * FROM leave_requests WHERE 1=1';
        const params = [];
        if (st) { query += ' AND status = ?'; params.push(st); }
        if (type) { query += ' AND leave_type = ?'; params.push(type); }
        query += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, start_date DESC LIMIT 25';
        const rows = getDb().prepare(query).all(...params);
        if (!rows.length) return replyEphemeral(i, 'لا توجد نتائج بهذه التصفية.', COLORS.gray);

        return i.reply({ ...dashboardPayload({ status: st, type, page: 1, viewerId: i.user.id }).payload, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-leaves').setDescription('مراجعة طلبات الإجازة المعلّقة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const { total, pages } = leaveService.list({ status: 'pending', perPage: 4, page: 1 });
        if (!total) return replyEphemeral(i, '✅ لا توجد طلبات إجازة معلّقة.', COLORS.success);
        const header = pendingEmbed(1);
        await i.reply({ embeds: header.embeds, ephemeral: true });
        for (const r of header.items) {
          const e = reviewCard(r);
          // زر إلغاء سريع للمعلق
          const row = reviewRow(r.id);
          row.addComponents(new ButtonBuilder().setCustomId(`leave:cancelquick:${r.id}`).setLabel('إلغاء الطلب').setEmoji('🚫').setStyle(ButtonStyle.Secondary));
          await i.followUp({ embeds: [e], components: [row], ephemeral: true });
        }
        if (pages > 1) {
          await i.followUp({ components: [kit.navRow({ prefix: 'leave:pending', page: 1, pages })], ephemeral: true });
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('cancel-leave').setDescription('إلغاء طلب إجازة لم يبدأ بعد')
        .addIntegerOption(o => o.setName('id').setDescription('رقم الطلب').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإلغاء').setRequired(false).setMaxLength(300)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const reason = i.options.getString('reason') || 'ألغاه صاحب الطلب';
        const db = getDb();
        const r = db.prepare("SELECT * FROM leave_requests WHERE id = ? AND user_id = ? AND status IN ('pending', 'approved')").get(id, i.user.id);
        if (!r) return replyEphemeral(i, '❌ الطلب غير موجود أو لا يمكن إلغاؤه (قد يكون منتهياً/ملغياً).', COLORS.danger);
        if (r.status === 'approved' && r.start_date <= today()) return replyEphemeral(i, '❌ بدأت الإجازة بالفعل. اطلب من الإدارة استخدام `/end-leave`.', COLORS.danger);
        db.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = ?, end_reason = 'admin' WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, i.user.id);
        if (member) await leaveService.syncVacationRole(member);
        const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated);
        audit.record({ action: 'leave_cancelled', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم إلغاء طلب الإجازة **#${r.id}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('extend-leave').setDescription('تمديد إجازة قائمة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم الطلب').setRequired(true))
        .addStringOption(o => o.setName('new_end').setDescription('تاريخ النهاية الجديد YYYY-MM-DD').setRequired(true)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const newEnd = i.options.getString('new_end');
        const result = leaveService.extendRequest({ id, userId: i.user.id, newEnd, actorId: i.user.id });
        if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
        const updated = result.row;
        await updateRequestMessage(i.client, updated);
        // إن كانت معتمدة ونشطة، مزامنة الرتبة
        const member = await fetchMember(i, i.user.id);
        if (member && updated.status === 'approved') await leaveService.syncVacationRole(member);
        return replyEphemeral(i, `✅ تم تمديد الإجازة **#${id}** إلى **${newEnd}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('end-leave').setDescription('إنهاء إجازة نشطة مبكراً (للإدارة)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب الإنهاء').setRequired(true).setMaxLength(300)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const user = i.options.getUser('user');
        const reason = i.options.getString('reason');
        const r = leaveService.activeForUser(user.id)[0];
        if (!r) return replyEphemeral(i, '❌ لا توجد إجازة نشطة لهذا الإداري.', COLORS.danger);
        const db = getDb();
        db.prepare(`UPDATE leave_requests SET status = 'ended', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now'), end_reason = 'early' WHERE id = ?`).run(i.user.id, reason, r.id);
        const member = await fetchMember(i, user.id);
        if (member) {
          await leaveService.syncVacationRole(member);
          if (!leaveService.approvedForUser(user.id).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
        }
        const otherActive = leaveService.activeForUser(user.id).some(row => row.id !== r.id);
        if (!otherActive && staffService.get(user.id)?.status === 'on_leave') staffService.update(user.id, {
          status: 'active', absence_alert_level: 0, last_activity: new Date().toISOString().replace('T', ' ').slice(0, 19),
        });
        const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated);
        await dm(i.client, user.id, { embeds: [embed('🏁 انتهت إجازتك مبكراً', `تم إنهاء الإجازة **#${r.id}** إدارياً.\n**السبب:** ${reason}`, COLORS.info)] });
        audit.record({ action: 'leave_ended_early', actorId: i.user.id, targetId: user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        await log(i.client, '🏁 إنهاء إجازة مبكر', `<@${user.id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.info);
        return replyEphemeral(i, `✅ تم إنهاء إجازة <@${user.id}>.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-calendar').setDescription('تقويم الإجازات والتغطية للأيام القادمة')
        .addStringOption(o => o.setName('start').setDescription('بداية YYYY-MM-DD (افتراضي: اليوم)').setRequired(false))
        .addIntegerOption(o => o.setName('days').setDescription('عدد الأيام (1-14)').setMinValue(1).setMaxValue(14).setRequired(false)),
      level: LEVELS.STAFF,
      async execute(i) {
        const start = i.options.getString('start') || today();
        const days = i.options.getInteger('days') || 14;
        if (!isValidDate(start)) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة.', COLORS.danger);
        return i.reply({ ...calendarPayload(start, days, i.user.id), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('leave-coverage').setDescription('عرض التغطية: من المجاز اليوم/في فترة')
        .addStringOption(o => o.setName('date').setDescription('تاريخ YYYY-MM-DD (افتراضي: اليوم)').setRequired(false))
        .addStringOption(o => o.setName('end').setDescription('إلى تاريخ YYYY-MM-DD لعرض نطاق').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const date = i.options.getString('date') || today();
        const end = i.options.getString('end');
        if (!isValidDate(date) || (end && !isValidDate(end))) return replyEphemeral(i, '❌ صيغة التاريخ غير صحيحة.', COLORS.danger);
        if (end) {
          const cov = leaveService.coverageBetween(date, end);
          const teams = leaveService.teamCoverage(date, end);
          const rows = getDb().prepare(`SELECT user_id, leave_type, start_date, end_date FROM leave_requests WHERE status='approved' AND start_date <= ? AND end_date >= ?`).all(end, date);
          const e = embed(`👥 التغطية ${kit.tsDate(date)} → ${kit.tsDate(end)}`, [
            `**الذروة العامة:** ${kit.coverageBar(cov.peak, cov.max)} في ${kit.tsDate(cov.peakDay)}`,
            rows.length ? rows.map(r => `• <@${r.user_id}> — ${LEAVE_TYPES[r.leave_type]} ${kit.tsDate(r.start_date)}→${kit.tsDate(r.end_date)}`).join('\n') : '_لا يوجد مجازون في هذه الفترة._',
          ].join('\n'), cov.peak >= cov.max ? COLORS.danger : COLORS.info);
          e.addFields({ name: 'حسب الفريق', value: Object.values(teams.teams).map(t => `${TEAMS[t.team] || t.team}: أدنى تغطية **${t.min}** من ${t.size}${t.below ? ` ⚠️ أقل من ${teams.required} في ${kit.tsDate(t.worstDay)}` : ' ✅'}`).join('\n') || 'لا توجد بيانات فرق.' });
          if (teams.below.length) e.setFooter({ text: `⚠️ ${teams.below.map(t => TEAMS[t.team] || t.team).join('، ')} تحت الحد الأدنى (${teams.required})${teams.enforce ? ' — الاعتماد ممنوع' : ' — يُسمح بالاعتماد مع تحذير'}` });
          return i.reply({ embeds: [e], ephemeral: true });
        }
        const cov = leaveService.coverageFor(date);
        const teams = leaveService.teamCoverage(date, date);
        const e = embed(`👥 المجازون في ${kit.tsDate(date)}`, cov.rows.length ? cov.rows.map(r => `• <@${r.user_id}> — ${LEAVE_TYPES[r.leave_type]}\n  حتى ${kit.tsDate(r.end_date)} • ${kit.relativeDays(kit.daysFromToday(r.end_date))}`).join('\n') : '_لا يوجد مجازون._', cov.count >= cov.max ? COLORS.warning : COLORS.info)
          .addFields({ name: 'التغطية العامة', value: `${kit.coverageBar(cov.count, cov.max)} • ${cov.count}/${cov.max}`, inline: true });
        e.addFields({ name: 'تغطية الفرق', value: Object.values(teams.teams).map(t => `${TEAMS[t.team] || t.team}: **${t.min}** من ${t.size}${t.below ? ' ⚠️' : ' ✅'}`).join('\n') || '—', inline: true });
        return i.reply({ embeds: [e], ephemeral: true });
},
     },
     {
       data: new SlashCommandBuilder().setName('templates').setDescription('إدارة قوالب الإجازة')
         .addSubcommand(sub =>
           sub.setName('list')
             .setDescription('عرض قوالب الإجازة المتاحة')
             .addStringOption(o => o.setName('type').setDescription('نوع القالب').addChoices(
               { name: 'خاصة بي', value: 'private' },
               { name: 'عامة للجميع', value: 'public' },
               { name: 'الكل', value: 'all' }
             ))
         )
         .addSubcommand(sub =>
           sub.setName('create')
             .setDescription('إنشاء قالب إجازة جديد')
             .addStringOption(o => o.setName('id').setDescription('معرف القالب (مثال: weekly_family)').setRequired(true))
             .addStringOption(o => o.setName('name').setDescription('اسم القالب').setRequired(true))
             .addStringOption(o => o.setName('description').setDescription('وصف القالب'))
             .addStringOption(o => o.setName('type').setDescription('نوع الإجازة').setRequired(true)
               .addChoices(...Object.entries(LEAVE_TYPES).map(([v, n]) => ({ name: `${LEAVE_RULES[v]?.emoji || '🏖️'} ${n}`, value: v }))))
             .addIntegerOption(o => o.setName('duration').setDescription('المدة الافتراضية بالأيام'))
             .addStringOption(o => o.setName('reason').setDescription('السبب الافتراضي'))
             .addBooleanOption(o => o.setName('public').setDescription('قالب عام للجميع'))
         )
         .addSubcommand(sub =>
           sub.setName('use')
             .setDescription('استخدام قالب إجازة لإنشاء طلب جديد')
             .addStringOption(o => o.setName('id').setDescription('معرف القالب').setRequired(true))
             .addStringOption(o => o.setName('reason').setDescription('السبب (يOverride الافتراضي)'))
             .addIntegerOption(o => o.setName('duration').setDescription('المدة بالأيام (يOverride الافتراضي)'))
         ),
       // كان هذا الأمر بلا level وبلا execute فكان يتعطل في كل استدعاء بخطأ غير متوقع؛
       // منطق الأوامر الفرعية كان مسجلاً بالخطأ كمكوّنات (components) لا تُستدعى أبداً من هنا.
       level: LEVELS.STAFF,
       async execute(i) {
         const sub = i.options.getSubcommand();
         if (sub === 'list') return templatesList(i);
         if (sub === 'create') return templatesCreate(i);
         if (sub === 'use') return templatesUse(i);
         return replyEphemeral(i, '❌ أمر غير معروف.', COLORS.danger);
       },
     },
   ],

  components: {
    'leave:modal': async (i, [type]) => {
      const reason = i.fields.getTextInputValue('reason').trim();
      const start = i.fields.getTextInputValue('start').trim();
      const end = i.fields.getTextInputValue('end').trim();
      const attachment = (i.fields.getTextInputValue('attachment') || '').trim() || null;
      if (!LEAVE_TYPES[type]) return replyEphemeral(i, 'نوع الإجازة غير صحيح.', COLORS.danger);
      if (attachment && !/^https?:\/\/.+/i.test(attachment)) return replyEphemeral(i, '❌ رابط المرفق غير صحيح — يجب أن يبدأ بـ https://', COLORS.danger);
      if (!reason) return replyEphemeral(i, 'اكتب سبب الإجازة قبل المتابعة.', COLORS.danger);
      // نقطة التحقق الأولى: أي خطأ في الحدود أو التواريخ يظهر هنا مع زر «تصحيح البيانات».
      const preview = leaveService.previewRequest({ userId: i.user.id, leaveType: type, start, end });
      if (!preview.ok) {
        const err = preview.error;
        return replyEphemeral(i, `❌ ${err.message}${err.hint ? `\n💡 ${err.hint}` : ''}`, COLORS.danger);
      }
      const draft = saveDraft(i, { leaveType: type, reason, start, end, attachment });
      return i.reply({ embeds: [draftEmbed(draft, preview)], components: [draftRow(draft.token)], ephemeral: true });
    },
    'leave:draft-submit': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه المسودة. افتح **/request-leave** من جديد — لم يُرسل شيء.', COLORS.warning);
      const result = leaveService.createRequest({ userId: i.user.id, leaveType: d.leaveType, reason: d.reason, start: d.start, end: d.end, attachmentUrl: d.attachment });
      if (!result.ok) {
        // لا نُفقد المسودة: العضو يستطيع التعديل بدل إعادة الكتابة.
        return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}\nمسودتك محفوظة — استخدم «تعديل التواريخ».`, COLORS.danger);
      }
      drafts.delete(d.token);
      audit.record({ action: 'leave_requested', actorId: i.user.id, targetId: i.user.id, details: { requestId: result.row.id, type: d.leaveType, start: d.start, end: d.end, countedDays: result.row.duration_days }, channelId: i.channelId });
      return publishRequest(i, result.row);
    },
    'leave:draft-edit': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه المسودة. افتح **/request-leave** من جديد.', COLORS.warning);
      return forms.open(i, modals.request({ type: d.leaveType, prefill: { reason: d.reason, start: d.start, end: d.end, attachment: d.attachment } }));
    },
    'leave:draft-cancel': async (i, [token]) => {
      const d = getDraft(i, token);
      if (d) drafts.delete(token);
      return i.update({ embeds: [embed('تم الإلغاء', 'لم يُرسل أي طلب إجازة. يمكنك البدء من جديد عبر **/request-leave**.', COLORS.gray)], components: [] });
    },
    'leave:newrequest': async (i) => {
      const pending = leaveService.pendingForUser(i.user.id);
      if (pending.length) {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:mine:${pending[0].id}`).setLabel('عرض الطلب المعلّق').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`leave:confirmcancel:${pending[0].id}`).setLabel('سحب الطلب').setEmoji('🚫').setStyle(ButtonStyle.Danger),
        );
        return i.reply({ embeds: [embed('⏳ لديك طلب معلّق', `الطلب **#${pending[0].id}** بانتظار المراجعة — اسحبه أولاً لإرسال طلب جديد.`, COLORS.warning)], components: [row], ephemeral: true });
      }
      const menu = new StringSelectMenuBuilder().setCustomId('leave:picktype').setPlaceholder('اختر نوع الإجازة')
        .addOptions(Object.entries(LEAVE_TYPES).map(([value, label]) => {
          const rule = settings.leavePolicy(value);
          return { label, value, emoji: LEAVE_RULES[value]?.emoji || '🏖️', description: `حتى ${rule.maxDays} يوم • إشعار ${rule.minNoticeHours} ساعة` };
        }));
      return i.reply({ embeds: [embed('🏖️ طلب إجازة جديد', ['اختر نوع الإجازة لتظهر لك البطاقة الكاملة: المدة المحتسبة، الرصيد المتبقي، وتغطية فريقك قبل الإرسال.'].join('\n'), COLORS.info)], components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
    },
    'leave:picktype': async (i) => {
      const type = i.values[0];
      if (!LEAVE_TYPES[type]) return replyEphemeral(i, 'نوع الإجازة غير صحيح.', COLORS.danger);
      const draft = saveDraft(i, { leaveType: type, start: null, end: null, days: null, reason: null, attachment: null });
      return i.update(quickCard(draft));
    },
    'leave:qstart': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه الشاشة. افتح **/request-leave** من جديد.', COLORS.warning);
      const value = i.values[0];
      if (value === 'custom') return forms.open(i, modals.request({ type: d.leaveType, prefill: { reason: d.reason, start: d.start || today(), end: d.end || '' } }));
      d.start = value;
      return i.update(quickCard(d));
    },
    'leave:qdays': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه الشاشة. افتح **/request-leave** من جديد.', COLORS.warning);
      const value = i.values[0];
      if (value === 'custom') return forms.open(i, modals.request({ type: d.leaveType, prefill: { reason: d.reason, start: d.start || today(), end: d.end || '' } }));
      d.days = Number(value);
      return i.update(quickCard(d));
    },
    'leave:qreason': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه الشاشة. افتح **/request-leave** من جديد.', COLORS.warning);
      const value = i.values[0];
      if (value === 'custom') return forms.open(i, modals.request({ type: d.leaveType, prefill: { reason: '', start: d.start || today(), end: d.end || '' } }));
      d.reason = value;
      return i.update(quickCard(d));
    },
    'leave:qgo': async (i, [token]) => {
      const d = getDraft(i, token);
      if (!d) return replyEphemeral(i, 'انتهت صلاحية هذه الشاشة. افتح **/request-leave** من جديد.', COLORS.warning);
      if (!d.start || !d.days || !d.reason) return i.update(quickCard(d, { error: 'أكمل الاختيارات الثلاثة أولاً.' }));
      const earliest = earliestStartFor(d.leaveType);
      if (d.start < earliest) return i.update(quickCard(d, { error: `أقرب يوم مسموح لنوع **${LEAVE_TYPES[d.leaveType]}** هو ${earliest} (مهلة الإشعار).` }));
      const end = endForCountedDays(d.start, d.days);
      const preview = leaveService.previewRequest({ userId: i.user.id, leaveType: d.leaveType, start: d.start, end });
      if (!preview.ok) return i.update(quickCard(d, { error: `${preview.error.message}${preview.error.hint ? ` — ${preview.error.hint}` : ''}` }));
      d.start = d.start; d.end = end;
      const live = saveDraft(i, { leaveType: d.leaveType, reason: d.reason, start: d.start, end, attachment: d.attachment || null });
      drafts.delete(token);
      return i.update({ embeds: [draftEmbed(live, preview)], components: [draftRow(live.token)] });
    },
    'leave:mine': async (i, [id]) => {
      const r = leaveService.get(id);
      if (!r) return replyEphemeral(i, 'الطلب غير موجود.', COLORS.danger);
      if (r.user_id !== i.user.id && i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, 'لا تملك صلاحية عرض هذا الطلب.', COLORS.danger);
      const e = leaveEmbed(r);
      const allow = leaveService.allowance(r.user_id);
      e.addFields({ name: '🎯 رصيد 90 يوماً', value: `${kit.progressBar(allow.types[r.leave_type]?.used90 || 0, allow.types[r.leave_type]?.cap90 || 1)} مستخدم ${allow.types[r.leave_type]?.used90 || 0}/${allow.types[r.leave_type]?.cap90 || '—'}` });
      e.addFields(coverageField(r.start_date, r.end_date));
      const rows = [];
      if (r.status === 'pending' && r.user_id === i.user.id) rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`leave:confirmcancel:${r.id}`).setLabel('سحب الطلب').setEmoji('🚫').setStyle(ButtonStyle.Danger)));
      return i.reply({ embeds: [e], components: rows, ephemeral: true });
    },
    'leave:approve': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الموافقة.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      // منع الموافقة على طلب إجازة نفسك حتى لو كنت من الإدارة العليا — يجب أن يعتمده شخص آخر.
      if (r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك الموافقة على طلب إجازتك الخاص. يجب أن يعتمده إداري آخر.', COLORS.danger);
      const vr = leaveService.validate({ userId: r.user_id, leaveType: r.leave_type, start: r.start_date, end: r.end_date, excludeId: r.id, atApproval: true });
      if (!vr.ok) return replyEphemeral(i, `❌ لا يمكن الموافقة: ${vr.message}${vr.hint ? `\n💡 ${vr.hint}` : ''}`, COLORS.danger);
      db.prepare(`UPDATE leave_requests SET status = 'approved', reviewed_by = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, r.id);
      const member = await fetchMember(i, r.user_id);
      const timing = settings.leavePolicy().vacationRoleTiming || 'at_start';
      let roleResult = { ok: true, skipped: true };
      // فور الموافقة أو عند البداية حسب الإعداد
      if (timing === 'at_approval' || r.start_date <= today()) {
        roleResult = member ? await staffService.addVacationRole(member) : { ok: false, missing: true };
        if (roleResult.ok) db.prepare("UPDATE leave_requests SET role_applied_at = COALESCE(role_applied_at, datetime('now')), role_grant_at = ? WHERE id = ?").run(today(), r.id);
      }
      if (r.start_date <= today() && staffService.get(r.user_id)?.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      audit.record({ action: 'leave_approved', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, start: r.start_date, end: r.end_date, vacationRole: roleResult.ok }, channelId: i.channelId });
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.success)], components: [] });
      const roleMsg = timing === 'at_start' && r.start_date > today() ? 'ستُفعّل رتبة **in vacation** تلقائياً عند بداية الإجازة.' : roleResult.ok ? 'تم تفعيل رتبة **in vacation**.' : '⚠️ لم أستطع تفعيل رتبة **in vacation** — راجع /setup.';
      await dm(i.client, r.user_id, { embeds: [embed('✅ تمت الموافقة على إجازتك', `من ${kit.tsDate(r.start_date)} إلى ${kit.tsDate(r.end_date)}\n${roleMsg}`, COLORS.success)] });
      return log(i.client, '🏖️ موافقة على إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>${roleResult.ok ? '' : '\n⚠️ رتبة in vacation لم تُفعّل'}`, COLORS.success);
    },

    'leave:reject': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك صلاحية الرفض.', COLORS.danger);
      return forms.open(i, modals.reject({ id }));
    },

    'leave:rejectmodal': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const db = getDb();
      const r = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
      if (r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك مراجعة طلب إجازتك الخاص. يجب أن يراجعه إداري آخر.', COLORS.danger);
      const reason = forms.combine(i);
      if (!reason) return replyEphemeral(i, 'اختر سبباً جاهزاً أو اكتب سبباً مخصصاً قبل الإرسال.', COLORS.danger);
      db.prepare(`UPDATE leave_requests SET status = 'rejected', reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(i.user.id, reason, r.id);
      audit.record({ action: 'leave_rejected', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason }, channelId: i.channelId });
      const updated = db.prepare('SELECT * FROM leave_requests WHERE id = ?').get(r.id);
      await updateRequestMessage(i.client, updated, COLORS.danger);
      // نحاول تحديث رسالة الأزرار إن كانت هي نفسها
      try { await i.update({ content: null, embeds: [leaveEmbed(updated, COLORS.danger)], components: [] }); } catch { await replyEphemeral(i, `تم رفض الطلب #${r.id}.`, COLORS.danger); }
      await dm(i.client, r.user_id, { embeds: [embed('❌ تم رفض طلب إجازتك', `**السبب:** ${reason}`, COLORS.danger)] });
      return log(i.client, '🏖️ رفض إجازة', `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>\n${reason}`, COLORS.danger);
    },

    'leave:details': async (i, [id]) => {
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      const e = reviewCard(r);
      const gap = leaveService.minGapViolated(r.user_id, r.start_date, r.end_date, r.id);
      if (gap) e.addFields({ name: '⚠️ تداخل الراحة', value: `يحتاج ${gap.required} يوم راحة بين الإجازات — لديه ${gap.gap}.` });
      const components = r.status === 'pending' ? [reviewRow(r.id)] : [];
      return i.reply({ embeds: [e], components, ephemeral: true });
    },

    // ===== اقتراح تواريخ بديلة =====
    'leave:suggest': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذا الإجراء للمراجعين فقط.', COLORS.danger);
      const r = leaveService.get(id);
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      if (r.status !== 'pending') return replyEphemeral(i, '❌ الاقتراح يعمل على الطلبات المعلّقة فقط.', COLORS.danger);
      return forms.open(i, modals.suggest({ id: r.id, start: r.start_date, end: r.end_date }));
    },
    'leave:suggestmodal': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذا الإجراء للمراجعين فقط.', COLORS.danger);
      const start = i.fields.getTextInputValue('start').trim();
      const end = i.fields.getTextInputValue('end').trim();
      const note = (i.fields.getTextInputValue('note') || '').trim() || null;
      const result = leaveService.suggestRequest({ id: Number(id), actorId: i.user.id, start, end, note });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
      const r = result.row;
      const allow = leaveService.allowance(r.user_id, { excludeId: r.id });
      const impact = leaveService.teamImpact(r.user_id, r.suggested_start, r.suggested_end, { excludeId: r.id });
      const sent = await dm(i.client, r.user_id, {
        embeds: [embed('💡 اقترحت الإدارة تواريخ بديلة', [
          `طلبك **#${r.id}** (${LEAVE_TYPES[r.leave_type]}): ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}`,
          `المقترح: **${kit.tsDate(r.suggested_start)} → ${kit.tsDate(r.suggested_end)}**`,
          note ? `**ملاحظة المراجع:** ${note}` : null,
          '',
          `المدة المقترحة: **${leaveService.countedDays(r.suggested_start, r.suggested_end)}** يوم`,
          `رصيدك المتبقي: **${allow.types[r.leave_type]?.remaining90 ?? '—'}** يوم`,
          impact ? `تغطية ${TEAMS[impact.team] || impact.team} في التواريخ المقترحة: **${impact.after}** (الحد ${impact.required})` : null,
          '',
          'اضغط «قبول التواريخ المقترحة» لاعتماد الموافقة على الطلب بالتواريخ الجديدة، أو «إبقاء طلبي» ليبقى الطلب كما هو للمراجعة.',
        ].filter(Boolean).join('\n'), COLORS.info)],
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:acceptsuggest:${r.id}`).setLabel('قبول التواريخ المقترحة').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`leave:declinesuggest:${r.id}`).setLabel('إبقاء طلبي').setStyle(ButtonStyle.Secondary),
        )],
      });
      await updateRequestMessage(i.client, r);
      await sendToChannel(i.client, 'leave-requests', { embeds: [embed('💡 اقتراح تواريخ جديد', `<@${r.user_id}> — الطلب **#${r.id}**\nالمقترح: ${r.suggested_start} → ${r.suggested_end}\nبواسطة <@${i.user.id}>${note ? `\n${note}` : ''}`, COLORS.primary)] });
      if (!sent) return replyEphemeral(i, `⚠️ لم أستطع إرسال رسالة خاصة لـ <@${r.user_id}> (الخاص مغلق؟). الاقتراح محفوظ، وسيراه في /my-leaves.`, COLORS.warning);
      return replyEphemeral(i, `✅ أُرسل الاقتراح إلى <@${r.user_id}> وظهر في بطاقة الطلب.`, COLORS.success);
    },
    'leave:acceptsuggest': async (i, [id]) => {
      const result = leaveService.acceptSuggestion({ id: Number(id), userId: i.user.id });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
      const r = result.row;
      await updateRequestMessage(i.client, r);
      await sendToChannel(i.client, 'leave-requests', { embeds: [embed('✅ قبِل العضو التواريخ المقترحة', `<@${r.user_id}> — الطلب **#${r.id}** صار: ${r.start_date} → ${r.end_date}\nبانتظار قرار نهائي من المراجع.`, COLORS.success)], components: [reviewRow(r.id)] });
      return i.update({ embeds: [embed('✅ تم قبول التواريخ المقترحة', `سيُراجع طلبك **#${r.id}** بالتواريخ الجديدة: ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}`, COLORS.success)], components: [] });
    },
    'leave:declinesuggest': async (i, [id]) => {
      const result = leaveService.declineSuggestion({ id: Number(id), userId: i.user.id });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}`, COLORS.danger);
      const r = result.row;
      await updateRequestMessage(i.client, r);
      await sendToChannel(i.client, 'leave-requests', { embeds: [embed('↩️ رفض العضو التواريخ المقترحة', `<@${r.user_id}> — الطلب **#${r.id}** بقي بتواريخه الأصلية (${r.start_date} → ${r.end_date}) ويحتاج قراراً.`, COLORS.warning)], components: [reviewRow(r.id)] });
      return i.update({ embeds: [embed('↩️ أبقينا طلبك كما هو', `سيراجع المراجع الطلب **#${r.id}** بتواريخه الأصلية.`, COLORS.gray)], components: [] });
    },
    'leave:balance': async (i) => i.reply({ ...balancePayload(i.user.id), ephemeral: true }),
    'leave:dashstatus': async (i, [type, page]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذه اللوحة للمراجعين فقط.', COLORS.danger);
      const status = i.values[0] === 'all' ? null : i.values[0];
      const selected = type === 'all' ? null : type;
      return i.update(dashboardPayload({ status, type: selected, page: Number(page), viewerId: i.user.id }).payload);
    },
    'leave:dashtype': async (i, [status, page]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذه اللوحة للمراجعين فقط.', COLORS.danger);
      const selectedType = i.values[0] === 'all' ? null : i.values[0];
      const selectedStatus = status === 'all' ? null : status;
      return i.update(dashboardPayload({ status: selectedStatus, type: selectedType, page: Number(page), viewerId: i.user.id }).payload);
    },
    'leave:dashpage': async (i, [status, type, page]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذه اللوحة للمراجعين فقط.', COLORS.danger);
      return i.update(dashboardPayload({ status: status === 'all' ? null : status, type: type === 'all' ? null : type, page: Number(page), viewerId: i.user.id }).payload);
    },
    'leave:reviewopen': async (i) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ هذا الإجراء للمراجعين فقط.', COLORS.danger);
      const r = leaveService.get(i.values[0]);
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      const e = reviewCard(r);
      const suggestion = r.suggested_start ? `\n💡 اقتراح قائم: ${r.suggested_start} → ${r.suggested_end}` : '';
      if (suggestion) e.setDescription((e.data.description || '') + suggestion);
      return i.reply({ embeds: [e], components: r.status === 'pending' ? [reviewRow(r.id)] : [], ephemeral: true });
    },
    'leave:cal': async (i, [start, days]) => {
      const safeStart = isValidDate(start) ? start : today();
      const span = Math.min(Math.max(Number(days) || 7, 1), 30);
      return i.update(calendarPayload(safeStart, span, i.user.id));
    },

    'leave:cancelquick': async (i, [id]) => {
      if (!i.staffLevel || i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const r = getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id));
      if (!r || r.status !== 'pending') return replyEphemeral(i, '❌ الطلب غير معلق.', COLORS.danger);
      getDb().prepare(`UPDATE leave_requests SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now'), cancel_reason='ألغته الإدارة من لوحة المراجعة', end_reason='admin' WHERE id=?`).run(i.user.id, r.id);
      const updated = getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id);
      await updateRequestMessage(i.client, updated);
      audit.record({ action: 'leave_cancelled_by_admin', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id }, channelId: i.channelId });
      await i.update({ embeds: [leaveEmbed(updated, COLORS.gray)], components: [] });
      await dm(i.client, r.user_id, { embeds: [embed('🚫 أُلغي طلب إجازتك', `ألغت الإدارة الطلب **#${r.id}**.`, COLORS.warning)] });
    },

    'leave:myleaves': async (i, [page, userId]) => {
      // userId للتحقق أن الصفحة تخص صاحبها أو الإدارة
      const target = userId || i.user.id;
      if (target !== i.user.id && i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      return i.update(myLeavesPayload(target, Number(page)));
    },
    'leave:pickaction': async (i) => {
      const raw = i.values[0];
      const [id, status] = raw.split(':');
      if (status === 'suggestion') {
        const r = leaveService.get(Number(id));
        if (!r || r.user_id !== i.user.id || !r.suggested_start) return replyEphemeral(i, 'الاقتراح لم يعد متاحاً.', COLORS.warning);
        const allow = leaveService.allowance(r.user_id, { excludeId: r.id });
        const e = embed('💡 تواريخ مقترحة من الإدارة', [
          `طلبك **#${r.id}** (${LEAVE_TYPES[r.leave_type]}): ${kit.tsDate(r.start_date)} → ${kit.tsDate(r.end_date)}`,
          `المقترح: **${kit.tsDate(r.suggested_start)} → ${kit.tsDate(r.suggested_end)}**`,
          `المدة المقترحة: **${leaveService.countedDays(r.suggested_start, r.suggested_end)}** يوم • رصيدك المتبقي **${allow.types[r.leave_type]?.remaining90 ?? '—'}** يوم`,
          r.suggested_note ? `**ملاحظة المراجع:** ${r.suggested_note}\n` : null,
          '',
          'القبول يحدّث تواريخ الطلب فقط، ويبقى الطلب معلقاً لقرار المراجع النهائي.',
        ].filter(Boolean).join('\n'), COLORS.info);
        return i.reply({ embeds: [e], components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:acceptsuggest:${r.id}`).setLabel('قبول التواريخ المقترحة').setEmoji('✅').setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`leave:declinesuggest:${r.id}`).setLabel('إبقاء طلبي').setStyle(ButtonStyle.Secondary),
        )], ephemeral: true });
      }
      if (status === 'pending') {
        // إلغاء مباشر مع تأكيد
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`leave:confirmcancel:${id}`).setLabel('تأكيد الإلغاء').setStyle(ButtonStyle.Danger).setEmoji('🚫'),
          new ButtonBuilder().setCustomId('leave:cancelpick').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
        );
        return i.reply({ embeds: [embed('⚠️ تأكيد الإلغاء', `هل تريد إلغاء الطلب **#${id}**؟`, COLORS.warning)], components: [row], ephemeral: true });
      } else {
        const current = getDb().prepare('SELECT end_date FROM leave_requests WHERE id = ?').get(Number(id));
        return forms.open(i, modals.extend({ id, end: current?.end_date }));
      }
    },
    'leave:confirmcancel': async (i, [id]) => {
      const r = getDb().prepare("SELECT * FROM leave_requests WHERE id=? AND user_id=? AND status IN ('pending','approved')").get(Number(id), i.user.id);
      if (!r) return replyEphemeral(i, '❌ لا يمكن إلغاء هذا الطلب.', COLORS.danger);
      if (r.status === 'approved' && r.start_date <= today()) return replyEphemeral(i, '❌ بدأت الإجازة — اطلب من الإدارة إنهاءها.', COLORS.danger);
      getDb().prepare(`UPDATE leave_requests SET status='cancelled', cancelled_by=?, cancelled_at=datetime('now'), cancel_reason='ألغاه صاحب الطلب' WHERE id=?`).run(i.user.id, r.id);
      const member = await fetchMember(i, i.user.id);
      if (member) await leaveService.syncVacationRole(member);
      await updateRequestMessage(i.client, getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(r.id));
      await i.update({ embeds: [embed('✅ تم الإلغاء', `أُلغي الطلب **#${id}**.`, COLORS.success)], components: [] });
    },
    'leave:cancelpick': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),
    'leave:extendmodal': async (i, [id]) => {
      const newEnd = i.fields.getTextInputValue('new_end').trim();
      const result = leaveService.extendRequest({ id: Number(id), userId: i.user.id, newEnd, actorId: i.user.id });
      if (!result.ok) return replyEphemeral(i, `❌ ${result.message}${result.hint ? `\n💡 ${result.hint}` : ''}`, COLORS.danger);
      await updateRequestMessage(i.client, result.row);
      return replyEphemeral(i, `✅ تم تمديد الطلب **#${id}** إلى **${newEnd}**.`, COLORS.success);
    },
'leave:pending': async (i, [page]) => {
       const { items, total, pages } = leaveService.list({ status: 'pending', perPage: 4, page: Number(page) });
       if (!total) return i.update({ embeds: [embed('✅ لا توجد طلبات', 'انتهت المراجعة.', COLORS.success)], components: [] });
       // نعيد بناء PAGE
       await i.update({ embeds: [embed(`⏳ طلبات معلقة — página ${page}/${pages}`, `العدد: **${total}**`, COLORS.warning)], components: [kit.navRow({ prefix: 'leave:pending', page: Number(page), pages })] });
       for (const r of items) {
         await i.followUp({ embeds: [reviewCard(r)], components: [reviewRow(r.id)], ephemeral: true });
       }
     },
   },
};

// معرّف قالب آمن: أحرف/أرقام/شرطة سفلية فقط لمنع قيم غريبة تُخزَّن كمفتاح أساسي.
const TEMPLATE_ID_RE = /^[a-zA-Z0-9_-]{2,40}$/;

async function templatesList(i) {
  const type = i.options.getString('type') || 'all';
  let templates;

  if (type === 'private') {
    templates = leaveService.listLeaveTemplates({ userId: i.user.id });
  } else if (type === 'public') {
    templates = leaveService.listLeaveTemplates({ includePublic: true });
  } else {
    // الكل: قوالبي الخاصة + العامة (بلا تكرار)
    const userTemplates = leaveService.listLeaveTemplates({ userId: i.user.id });
    const publicTemplates = leaveService.listLeaveTemplates({ includePublic: true }).filter(t => t.user_id !== i.user.id);
    templates = [...userTemplates, ...publicTemplates];
  }

  if (!templates.length) {
    return replyEphemeral(i, 'لا توجد قوالب إجازة. استخدم `/templates create` لإنشاء أول قالب.', COLORS.gray);
  }

  const e = embed('📋 قوالب الإجازة', templates.map(t =>
    `${t.is_public ? '🌐' : '🔒'} **${t.name}** \`${t.id}\` (${LEAVE_TYPES[t.leave_type] || t.leave_type})`
    + `${t.default_duration ? ` • ${t.default_duration} يوم` : ''}`
    + `${t.default_reason ? ` • ${t.default_reason}` : ''}`
    + `${t.description ? `\n  ${t.description}` : ''}`
  ).join('\n'), COLORS.info);

  return i.reply({ embeds: [e], ephemeral: true });
}

async function templatesCreate(i) {
  const id = (i.options.getString('id') || '').trim();
  const name = i.options.getString('name');
  const description = i.options.getString('description');
  const type = i.options.getString('type');
  const duration = i.options.getInteger('duration');
  const reason = i.options.getString('reason');
  const wantsPublic = i.options.getBoolean('public') || false;

  if (!TEMPLATE_ID_RE.test(id)) return replyEphemeral(i, '❌ المعرف يجب أن يكون حروفاً/أرقاماً إنجليزية أو شرطة سفلية (2-40 حرفاً)، مثل weekly_family.', COLORS.danger);
  // قالب عام يظهر لكل الفريق — يتطلب صلاحية أعلى من موظف عادي لمنع ازدحام القوالب المشتركة بمحتوى غير مراجَع.
  if (wantsPublic && (i.staffLevel || 0) < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ إنشاء قالب عام للجميع يتطلب صلاحية الإدارة.', COLORS.danger);
  if (leaveService.getLeaveTemplate(id)) return replyEphemeral(i, `❌ المعرف \`${id}\` مستخدم مسبقاً. اختر معرفاً آخر.`, COLORS.danger);

  let template;
  try {
    template = leaveService.createLeaveTemplate({
      id,
      userId: i.user.id,
      name,
      description,
      leaveType: type,
      defaultDuration: duration,
      defaultReason: reason,
      isPublic: wantsPublic ? 1 : 0,
    });
  } catch {
    template = null;
  }

  if (!template) return replyEphemeral(i, '❌ فشل إنشاء القالب. قد يكون المعرف مكرراً.', COLORS.danger);

  audit.record({ action: 'leave_template_created', actorId: i.user.id, details: { templateId: id, name, leaveType: type, isPublic: wantsPublic }, channelId: i.channelId });

  return replyEphemeral(i, `✅ تم إنشاء القالب **${name}** (${LEAVE_TYPES[type] || type}) ${wantsPublic ? '🌐 عام' : '🔒 خاص'}.`, COLORS.success);
}

async function templatesUse(i) {
  const id = i.options.getString('id');
  const reasonOverride = i.options.getString('reason');
  const durationOverride = i.options.getInteger('duration');

  const template = leaveService.useLeaveTemplate(id, i.user.id, { reason: reasonOverride, duration_days: durationOverride });

  if (!template) return replyEphemeral(i, '❌ القالب غير موجود أو لا صلاحيات لك عليه.', COLORS.danger);

  // حفظ كمسودة وعرض بطاقة الاختيار السريع (نفس مسار /request-leave)
  const draft = saveDraft(i, {
    leaveType: template.leave_type,
    start: null,
    end: null,
    days: template.duration_days,
    reason: template.reason,
    attachment: null,
    templateId: template.id,
  });

  return i.reply({ embeds: [quickCard(draft)], ephemeral: true });
}

function covText(cov) {
  if (cov.peak >= cov.max) return `⚠️ **التغطية ممتلئة** ${kit.coverageBar(cov.peak, cov.max)} — قد يُرفض الطلب`;
  if (cov.peak >= cov.max - 1) return `🟡 **شبه ممتلئة** ${kit.coverageBar(cov.peak, cov.max)}`;
  return `✅ **التغطية متاحة** ${kit.coverageBar(cov.peak, cov.max)}`;
}
