'use strict';
const forms = require('../ui/forms');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { LEVELS, RESIGNATION_REASONS, RESIGNATION_GLOBAL } = require('../constants');
const settings = require('../services/settings');
const { getDb } = require('../database');
const staffService = require('../services/staff');
const audit = require('../services/audit');
const tasks = require('../services/tasks');
const { embed, COLORS, replyEphemeral, sendToChannel, getChannel, isValidDate, daysBetween, today, dm, log } = require('../utils');
const kit = require('../ui/kit');

const STATUS_AR = { pending: '⏳ معلّق', accepted: '✅ مقبول', rejected: '❌ مرفوض', on_hold: '⏸️ معلّق لمقابلة', withdrawn: '↩️ مسحوب' };
const STATUS_COLOR = { pending: COLORS.warning, accepted: COLORS.success, rejected: COLORS.danger, on_hold: COLORS.info, withdrawn: COLORS.gray };

function resignEmbed(r, color) {
  const cat = RESIGNATION_REASONS[r.reason_category] || null;
  const e = embed(`${cat?.emoji || '📤'} استقالة #${r.id} — ${cat?.label || '—'}`, null, color || STATUS_COLOR[r.status] || COLORS.warning)
    .addFields(
      { name: 'الإداري', value: `<@${r.user_id}>`, inline: true },
      { name: 'الرتبة وقت الطلب', value: `${r.rank || '—'}`, inline: true },
      { name: 'الحالة', value: STATUS_AR[r.status] || r.status, inline: true },
      { name: 'آخر يوم', value: r.last_day ? `${kit.tsDate(r.last_day)} • ${kit.relativeDays(kit.daysFromToday(r.last_day))}` : '—', inline: true },
      { name: 'فترة الإشعار', value: r.notice_days != null ? `**${r.notice_days}** ${kit.daysWord(r.notice_days)}` : `${daysBetween((r.created_at || '').slice(0, 10), r.last_day)} يوم`, inline: true },
      { name: 'السبب المفصّل', value: r.reason || '—' },
    );
  if (r.notes) e.addFields({ name: 'ملاحظات إضافية', value: r.notes });
  if (r.reviewed_by) e.addFields({ name: 'المراجع', value: `<@${r.reviewed_by}>${r.review_reason ? ` — ${r.review_reason}` : ''}` });
  if (r.exit_interview) e.addFields({ name: '📝 مقابلة الخروج', value: r.exit_interview });
  if (r.withdraw_reason) e.addFields({ name: '↩️ سبب السحب', value: r.withdraw_reason });
  if (r.remove_roles_at) e.addFields({ name: '⏰ إزالة الرتب', value: kit.tsDate(r.remove_roles_at), inline: true });
  if (r.roles_removed_at) e.addFields({ name: '✅ تمت الإزالة', value: kit.tsRelative(r.roles_removed_at), inline: true });
  // تلميح الاحتفاظ
  if (r.status === 'pending' && cat?.retention) e.addFields({ name: '💡 تنبيه', value: 'هذا السبب قابل للمعالجة — فكّر في عرض حل قبل القبول.' });
  e.setFooter({ text: `🔒 سري — #${r.id} • ${STATUS_AR[r.status] || r.status}` });
  return e;
}

function handoverEmbed() {
  return embed('📋 قائمة التسليم — قبل آخر يوم', RESIGNATION_GLOBAL.handoverTasks.map((t, i) => `${i + 1}. ${t}`).join('\n'), COLORS.info)
    .setFooter({ text: 'أكملها وتواصل مع الإدارة للتأكيد.' });
}

const reviewRow = (id) => new ActionRowBuilder().addComponents(
  new ButtonBuilder().setCustomId(`resign:accept:${id}`).setLabel('قبول (Boss)').setEmoji('✅').setStyle(ButtonStyle.Success),
  new ButtonBuilder().setCustomId(`resign:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`resign:hold:${id}`).setLabel('تعليق').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
  new ButtonBuilder().setCustomId(`resign:interview:${id}`).setLabel('مقابلة خروج').setEmoji('📝').setStyle(ButtonStyle.Secondary),
);

/** يمنع اتخاذ أي إجراء مراجعة على طلب استقالة نفسك — يعيد رسالة الرفض أو null إن كان مسموحاً. */
function selfReviewBlock(i, resignation) {
  if (resignation && resignation.user_id === i.user.id) return '❌ لا يمكنك مراجعة طلب استقالتك الخاص. يجب أن يراجعه إداري آخر.';
  return null;
}

async function fetchMember(i, userId) {
  try { return i.guild?.members?.fetch ? await i.guild.members.fetch(userId) : null; } catch { return null; }
}

async function updateRequestMessage(client, row, color) {
  if (!row?.message_id) return false;
  try {
    const channel = await getChannel(client, 'resignation-requests');
    const message = channel ? await channel.messages.fetch(row.message_id) : null;
    if (!message) return false;
    const showRow = ['pending', 'on_hold'].includes(row.status);
    await message.edit({ content: null, embeds: [resignEmbed(row, color)], components: showRow ? [reviewRow(row.id)] : [] });
    return true;
  } catch { return false; }
}

async function decide(i, id, status) {
  const db = getDb();
  const r = db.prepare('SELECT * FROM resignations WHERE id = ?').get(Number(id));
  if (!r || !['pending', 'on_hold'].includes(r.status)) return replyEphemeral(i, '❌ الطلب غير موجود أو تمت مراجعته.', COLORS.danger);
  // منع اتخاذ قرار على استقالة نفسك — حتى Boss لا يمكنه قبول/رفض استقالته الخاصة.
  if (r.user_id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك اتخاذ قرار بشأن طلب استقالتك الخاص. يجب أن يراجعه إداري آخر.', COLORS.danger);
  const reason = i.fields ? (forms.combine(i) || null) : null;
  const exitInterview = i.fields && i.fields.fields?.has?.('exit_interview') ? (i.fields.getTextInputValue('exit_interview') || '').trim() || null : null;

  // تحديث الحالة + مقابلة الخروج إن وجدت
  if (exitInterview) db.prepare(`UPDATE resignations SET exit_interview = ? WHERE id = ?`).run(exitInterview, r.id);
  db.prepare(`UPDATE resignations SET status = ?, reviewed_by = ?, review_reason = ?, reviewed_at = datetime('now') WHERE id = ?`).run(status, i.user.id, reason, r.id);
  audit.record({ action: `resignation_${status}`, actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, reason, exitInterview }, channelId: i.channelId });

  let color = COLORS.gray;
  let dmEmbed;
  if (status === 'accepted') {
    color = COLORS.success;
    const before = staffService.get(r.user_id);
    staffService.setStatus(r.user_id, 'resigned');
    if (before) staffService.recordRankChange(r.user_id, { fromRank: before.rank, toRank: before.rank, team: before.team, changeType: 'remove', reason: `قبول استقالة${reason ? ` — ${reason}` : ''}`, actorId: i.user.id });
    const removeAt = r.remove_roles_at;
    const shouldRemoveNow = !removeAt || removeAt <= today();
    db.prepare(`UPDATE leave_requests SET status = 'cancelled', cancelled_by = ?, cancelled_at = datetime('now'), cancel_reason = 'إلغاء تلقائي بسبب قبول الاستقالة', end_reason='resignation' WHERE user_id = ? AND status IN ('pending', 'approved')`).run(i.user.id, r.user_id);
    let staffRoleResult = true;
    let roleResult = null;
    if (shouldRemoveNow) {
      const member = await fetchMember(i, r.user_id);
      if (member) {
        staffRoleResult = await staffService.removeAllStaffRoles(member);
        roleResult = await staffService.removeVacationRole(member);
        if (staffRoleResult && roleResult.ok) db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
      }
    }
    const existingHandover = tasks.listByType('offboarding', { includeCompleted: true, limit: 200 })
      .filter(t => t.user_id === r.user_id && t.title.includes(`استقالة #${r.id}`));
    if (!existingHandover.length) {
      for (const item of RESIGNATION_GLOBAL.handoverTasks) tasks.create({
        userId: r.user_id,
        title: `استقالة #${r.id}: ${item}`,
        description: `مهمة تسليم مرتبطة بآخر يوم ${r.last_day}. أكملها وارفع أي تفاصيل للإدارة.`,
        taskType: 'offboarding',
        dueDate: r.last_day,
        assignedBy: i.user.id,
      });
    }
    const when = shouldRemoveNow ? 'تمت إزالة الرتب الإدارية' : `ستُزال رتبك في ${kit.tsDate(removeAt)}`;
    dmEmbed = embed('👋 تم قبول استقالتك', `شكراً لك على كل ما قدمته للفريق. ${when}${roleResult?.ok === false ? '، لكن تعذرت إزالة رتبة الإجازة تلقائياً' : shouldRemoveNow ? ' ورتبة in vacation' : ''}.\n${reason ? `**رسالة الإدارة:** ${reason}` : ''}\n${exitInterview ? `\n**ملاحظة المقابلة:** ${exitInterview}` : ''}\nنتمنى لك التوفيق 🌹`, COLORS.success);
    if (!shouldRemoveNow) dmEmbed.addFields({ name: '📋 التسليم', value: RESIGNATION_GLOBAL.handoverTasks.join('\n') });
    audit.record({ action: 'resignation_roles_removed', actorId: i.user.id, targetId: r.user_id, details: { requestId: r.id, staffRolesRemoved: staffRoleResult, vacationRoleRemoved: roleResult?.ok !== false, deferred: !shouldRemoveNow }, channelId: i.channelId });
  } else if (status === 'rejected') {
    color = COLORS.danger;
    dmEmbed = embed('❌ تم رفض طلب استقالتك', `**السبب:** ${reason || 'لم يذكر المراجع سبباً.'}${exitInterview ? `\n**ملاحظة:** ${exitInterview}` : ''}\n\nتواصل مع الإدارة إن رغبت بمناقشة الأمر.`, COLORS.danger);
  } else {
    dmEmbed = embed('⏸️ تم تعليق طلب استقالتك', `الإدارة تطلب مقابلة معك قبل اتخاذ القرار.\n${reason ? `**ملاحظة:** ${reason}` : ''}${exitInterview ? `\n**مقابلة الخروج:** ${exitInterview}` : ''}`, COLORS.warning);
  }

  const updated = db.prepare('SELECT * FROM resignations WHERE id = ?').get(r.id);
  await updateRequestMessage(i.client, updated, color);
  if (i.isModalSubmit()) await replyEphemeral(i, `تم تحديث الطلب #${r.id} → ${STATUS_AR[status]}`, color);
  else if (!i.replied && !i.deferred) await i.update({ content: null, embeds: [resignEmbed(updated, color)], components: status === 'on_hold' ? [reviewRow(r.id)] : [] });
  await dm(i.client, r.user_id, { embeds: [dmEmbed] });
  if (status === 'accepted' && updated.remove_roles_at && updated.remove_roles_at > today()) {
    dmEmbed.addFields && null;
  }
  return log(i.client, `📤 استقالة: ${STATUS_AR[status]}`, `<@${r.user_id}> — #${r.id} بواسطة <@${i.user.id}>`, color);
}

const modals = {
  /** نماذج قرار الاستقالة: القبول والرفض والتعليق. */
  decide: ({ id, action } = {}) => ({
    id: `resign:${action}modal:${id}`,
    title: action === 'accept' ? '✅ قبول الاستقالة — رسالة وداع'
      : action === 'reject' ? '❌ سبب رفض الاستقالة' : '⏸️ تعليق — ملاحظة للإداري',
    fields: action === 'accept' ? [
      forms.field({ id: 'reason', label: 'رسالة وداع للعضو', required: false, style: 'paragraph', max: 500,
        description: 'اختياري: نص إيجابي يُرسل للعضو مع إشعار القبول.' }),
      forms.field({ id: 'exit_interview', label: 'ملاحظة مقابلة الخروج', required: false, style: 'paragraph', max: 500,
        description: 'اختياري: خلاصة المقابلة تُحفظ مع الطلب وتظهر في السجل.' }),
    ] : action === 'reject' ? [
      forms.select({ id: 'preset', label: 'أسباب جاهزة', required: false, multiple: true,
        options: [
          { label: 'فترة إشعار غير مكتملة', value: 'فترة الإشعار غير مكتملة' },
          { label: 'تسليم المهام ناقص', value: 'مهام التسليم لم تكتمل' },
          { label: 'يحتاج مناقشة أولاً', value: 'يحتاج مناقشة قبل القبول' },
          { label: 'قرار نهائي من الطرفين', value: 'قرار نهائي متفق عليه' },
        ],
        description: 'اختر سبباً أو أكثر، أو اكتب سبباً مخصصاً في الحقل التالي.' }),
      forms.field({ id: 'reason', label: 'سبب مخصص', required: false, style: 'paragraph', max: 400,
        description: 'يظهر هذا النص للعضو في رسالة الرفض.' }),
    ] : [
      forms.field({ id: 'reason', label: 'ملاحظة التعليق', required: false, style: 'paragraph', max: 400,
        description: 'اختياري: سبب طلب المقابلة أو ما تنتظره من العضو.' }),
      forms.field({ id: 'exit_interview', label: 'مقابلة الخروج', required: false, style: 'paragraph', max: 400,
        description: 'اختياري: ملاحظات أولية تُحفظ قبل المقابلة.' }),
    ],
    note: 'يُبلَّغ العضو فوراً في الخاص، ويُسجَّل القرار معك في سجل التدقيق.',
  }),
  /** نموذج تقديم الاستقالة نفسه. */
  request: ({ cat, noticeDays = 0, label = '', emoji = '' } = {}) => ({
    id: `resign:modal:${cat}`,
    title: `${emoji} استقالة — ${label}`.trim(),
    fields: [
      forms.field({ id: 'reason', label: 'التفاصيل — ما السبب تحديداً؟', style: 'paragraph', max: 800,
        description: 'اشرح سبب الاستقالة بصراحة؛ يفيدنا ذلك في تحسين بيئة الفريق.' }),
      forms.field({ id: 'last_day', label: 'آخر يوم عمل', max: 20,
        description: `سنة-شهر-يوم. المطلوب إشعار ${noticeDays} أيام على الأقل، ويقبل «اليوم» و«غدا».`,
        placeholder: today() }),
      forms.field({ id: 'notes', label: 'ملاحظات أو اقتراح بديل', required: false, style: 'paragraph', max: 400,
        description: 'اختياري: ما الذي قد يجعلك تتراجع؟ الفريق يقدر أي حل وسط.' }),
      forms.field({ id: 'remove_at', label: 'تاريخ إزالة الرتب', required: false, max: 20,
        description: 'اختياري: سنة-شهر-يوم. اتركه فارغاً لإزالة الرتب فور القبول.', placeholder: 'فارغ = فور القبول' }),
    ],
    note: 'يمكنك سحب الطلب قبل القبول، وتُفتح مهام التسليم تلقائياً عند القبول.',
  }),
  /** ملاحظات مقابلة الخروج لاحقاً. */
  interview: ({ id } = {}) => ({
    id: `resign:interviewmodal:${id}`,
    title: `📝 مقابلة خروج #${id}`,
    fields: [
      forms.field({ id: 'exit_interview', label: 'ملاحظات المقابلة', style: 'paragraph', max: 600,
        description: 'ما قاله العضو في المقابلة، وما يمكن أن يستفيد منه الفريق.' }),
    ],
    note: 'تُحدَّث الملاحظات في بطاقة الطلب دون تغيير حالته.',
  }),
};

function withdrawEmbed(rows, page = 1) {
  if (!rows.length) return { embeds: [embed('↩️ سحب الاستقالة', 'لا توجد طلبات معلقة يمكنك سحبها.', COLORS.gray)], components: [] };
  const { items, pages, total } = kit.paginate(rows, page, 5);
  const e = embed('↩️ استقالاتك المعلقة — اختر للسحب', items.map(r => {
    const cat = RESIGNATION_REASONS[r.reason_category]?.label || '—';
    return `\`#${r.id}\` ${STATUS_AR[r.status]} • ${cat} • ${kit.tsDate(r.last_day)} • ${kit.relativeDays(kit.daysFromToday(r.last_day))}`;
  }).join('\n'), COLORS.warning)
    .setFooter({ text: `صفحة ${page}/${pages} • ${total} طلب • اضغط القائمة للسحب دون كتابة ID` });
  const menu = new StringSelectMenuBuilder().setCustomId(`resign:pickwithdraw:${page}`).setPlaceholder('اختر طلباً لسحبه...')
    .addOptions(items.map(r => ({
      label: `#${r.id} — ${RESIGNATION_REASONS[r.reason_category]?.label || r.reason.slice(0, 30)}`,
      value: String(r.id),
      description: `آخر يوم ${r.last_day}`,
      emoji: '↩️',
    })));
  const nav = pages > 1 ? [kit.navRow({ prefix: 'resign:withdrawlist', page, pages })] : [];
  return { embeds: [e], components: [...nav, new ActionRowBuilder().addComponents(menu)] };
}

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('resign').setDescription('تقديم طلب استقالة — سري مع تصنيف السبب'),
      level: LEVELS.STAFF,
      async execute(i) {
        const staff = staffService.get(i.user.id);
        if (!staff || staff.status === 'resigned') return replyEphemeral(i, '❌ لا يمكن تقديم استقالة لستاف غير مسجل أو مستقيل.', COLORS.danger);
        const pending = getDb().prepare(`SELECT id FROM resignations WHERE user_id = ? AND status IN ('pending','on_hold')`).get(i.user.id);
        if (pending) return replyEphemeral(i, `❌ لديك طلب استقالة قيد المراجعة (#${pending.id}).\nاستخدم **/my-resignations** للسحب أو المتابعة.`, COLORS.danger);
        const policy = settings.resignationPolicy();
        // قائمة اختيار السبب أولاً
        const menu = new StringSelectMenuBuilder().setCustomId('resign:pickreason').setPlaceholder('📝 اختر سبب الاستقالة...')
          .addOptions(Object.entries(RESIGNATION_REASONS).map(([key, v]) => ({ label: v.label, value: key, emoji: v.emoji, description: v.retention ? 'قابل للمعالجة — قد نعرض حلاً' : undefined })));
        const e = embed('📤 طلب استقالة — اختر السبب أولاً', [
          `**فترة الإشعار المطلوبة:** **${policy.noticeDays}** أيام`,
          `بعد اختيار السبب سيُفتح نموذج التفاصيل وآخر يوم.`,
          '',
          '🔒 طلبك سري — يظهر للإدارة فقط في قناة الاستقالات.',
        ].join('\n'), COLORS.warning);
        return i.reply({ embeds: [e], components: [new ActionRowBuilder().addComponents(menu)], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('my-resignations').setDescription('عرض استقالاتي مع إمكانية السحب المباشر'),
      level: LEVELS.STAFF,
      async execute(i) {
        const rows = getDb().prepare(`SELECT * FROM resignations WHERE user_id = ? ORDER BY id DESC`).all(i.user.id);
        if (!rows.length) return replyEphemeral(i, 'لا توجد استقالات مسجلة.\n\nاستخدم **/resign** لتقديم طلب جديد.', COLORS.gray);
        const e = embed('📤 استقالاتي', rows.slice(0, 8).map(r => `\`#${r.id}\` ${STATUS_AR[r.status]} • ${kit.tsDate(r.last_day)} • ${r.reason.slice(0, 60)}${r.reason.length > 60 ? '…' : ''}`).join('\n'), COLORS.info);
        // قائمة سحب للمعلقة
        const pending = rows.filter(r => ['pending', 'on_hold'].includes(r.status));
        const comps = [];
        if (pending.length) {
          const menu = new StringSelectMenuBuilder().setCustomId('resign:pickwithdraw:1').setPlaceholder('↩️ اختر طلباً لسحبه...')
            .addOptions(pending.slice(0, 10).map(r => ({ label: `#${r.id} — ${r.last_day}`, value: String(r.id), description: r.reason.slice(0, 80), emoji: '↩️' })));
          comps.push(new ActionRowBuilder().addComponents(menu));
        }
        return i.reply({ embeds: [e], components: comps, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('withdraw-resignation').setDescription('سحب طلب الاستقالة قبل اعتماده')
        .addIntegerOption(o => o.setName('id').setDescription('رقم طلب الاستقالة').setRequired(true))
        .addStringOption(o => o.setName('reason').setDescription('سبب السحب — اختياري').setMaxLength(300)),
      level: LEVELS.STAFF,
      async execute(i) {
        const id = i.options.getInteger('id');
        const reason = i.options.getString('reason') || 'سحب الطلب من صاحبه';
        const db = getDb();
        const r = db.prepare("SELECT * FROM resignations WHERE id = ? AND user_id = ? AND status IN ('pending', 'on_hold')").get(id, i.user.id);
        if (!r) return replyEphemeral(i, '❌ الطلب غير موجود أو تم اتخاذ قرار بشأنه.', COLORS.danger);
        db.prepare(`UPDATE resignations SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = datetime('now'), withdraw_reason = ? WHERE id = ?`).run(i.user.id, reason, r.id);
        const updated = db.prepare('SELECT * FROM resignations WHERE id = ?').get(r.id);
        await updateRequestMessage(i.client, updated, COLORS.gray);
        audit.record({ action: 'resignation_withdrawn', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, reason }, channelId: i.channelId });
        await log(i.client, '↩️ سحب استقالة', `<@${i.user.id}> — #${r.id}`, COLORS.gray);
        return replyEphemeral(i, `✅ تم سحب طلب الاستقالة **#${r.id}**.`, COLORS.success);
      },
    },
    {
      data: new SlashCommandBuilder().setName('resignations-dashboard').setDescription('لوحة الاستقالات — تصفية وبحث (للإدارة)')
        .addStringOption(o => o.setName('status').setDescription('الحالة').setRequired(false)
          .addChoices(...Object.entries(STATUS_AR).map(([v, n]) => ({ name: n, value: v })), { name: 'الكل', value: 'all' }))
        .addStringOption(o => o.setName('reason').setDescription('تصنيف السبب').setRequired(false)
          .addChoices(...Object.entries(RESIGNATION_REASONS).map(([v, r]) => ({ name: `${r.emoji} ${r.label}`, value: v })))),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const status = i.options.getString('status');
        const reason = i.options.getString('reason');
        const st = status === 'all' ? null : status;
        let query = 'SELECT * FROM resignations WHERE 1=1';
        const params = [];
        if (st) { query += ' AND status = ?'; params.push(st); }
        if (reason) { query += ' AND reason_category = ?'; params.push(reason); }
        query += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'on_hold\' THEN 1 ELSE 2 END, last_day, created_at LIMIT 20';
        const rows = getDb().prepare(query).all(...params);
        if (!rows.length) return replyEphemeral(i, 'لا توجد نتائج بهذه التصفية.', COLORS.gray);
        const header = embed('📤 لوحة الاستقالات', [
          st || reason ? `**التصفية:** ${st ? STATUS_AR[st] : 'الكل'}${reason ? ` • ${RESIGNATION_REASONS[reason]?.label}` : ''}` : '_أحدث 20 طلب_',
          rows.filter(r => ['pending', 'on_hold'].includes(r.status)).length ? `⏳ **${rows.filter(r => ['pending', 'on_hold'].includes(r.status)).length}** معلق • 🔒 سرية` : 'لا توجد معلقة',
        ].join('\n'), COLORS.info);
        await i.reply({ embeds: [header], ephemeral: true });
        for (const r of rows.slice(0, 5)) {
          await i.followUp({ embeds: [resignEmbed(r)], components: ['pending', 'on_hold'].includes(r.status) ? [reviewRow(r.id)] : [], ephemeral: true });
        }
        if (rows.length > 5) await i.followUp({ content: `_… و **${rows.length - 5}** طلب إضافي._`, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('review-resignations').setDescription('عرض الاستقالات المعلّقة — للإدارة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = getDb().prepare(`SELECT * FROM resignations WHERE status IN ('pending', 'on_hold') ORDER BY last_day, created_at`).all();
        if (!rows.length) return replyEphemeral(i, '✅ لا توجد استقالات معلّقة.', COLORS.success);
        await i.reply({ embeds: [embed('📤 الاستقالات المعلّقة', `العدد: **${rows.length}**\n🔒 البيانات سرية ولا تظهر إلا للإدارة.\n\n${rows.filter(r => (RESIGNATION_REASONS[r.reason_category]?.retention)).length ? '💡 بعض الطلبات قابلة للاحتفاظ — راجع الأزرار.' : ''}`, COLORS.warning)], ephemeral: true });
        for (const r of rows.slice(0, 6)) await i.followUp({ embeds: [resignEmbed(r)], components: [reviewRow(r.id)], ephemeral: true });
        if (rows.length > 6) await i.followUp({ content: `_… و **${rows.length - 6}** طلب إضافي — استخدم **/resignations-dashboard**._`, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('resignation-stats').setDescription('إحصائيات الاستقالات حسب السبب (30 يوم)'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const rows = getDb().prepare(`SELECT reason_category, COUNT(*) c FROM resignations WHERE status='accepted' AND reviewed_at >= datetime('now','-30 days') GROUP BY reason_category ORDER BY c DESC`).all();
        if (!rows.length) return replyEphemeral(i, 'لا توجد استقالات مقبولة خلال 30 يوم.', COLORS.gray);
        const e = embed('📊 أسباب الاستقالة — 30 يوم', rows.map(r => {
          const cat = RESIGNATION_REASONS[r.reason_category] || { label: r.reason_category || 'غير مصنف', emoji: '📝' };
          return `${cat.emoji} **${cat.label}** — **${r.c}** ${kit.itemsWord(r.c)}`;
        }).join('\n'), COLORS.info)
          .addFields({ name: '💡 نصيحة', value: rows[0]?.c >= 2 ? `السبب الأكثر تكراراً هو **${RESIGNATION_REASONS[rows[0].reason_category]?.label}** — فكّر بمعالجة جذره.` : 'لا يوجد نمط واضح.' });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],

  components: {
    'resign:pickreason': async (i) => {
      const cat = i.values[0];
      const info = RESIGNATION_REASONS[cat];
      if (!info) return replyEphemeral(i, '❌ تصنيف غير صحيح.', COLORS.danger);
      return forms.open(i, modals.request({ cat, noticeDays: settings.resignationPolicy().noticeDays, label: info.label, emoji: info.emoji }));
    },
    'resign:modal': async (i, [cat]) => {
      const reasonCat = RESIGNATION_REASONS[cat] ? cat : 'other';
      const reason = i.fields.getTextInputValue('reason').trim();
      const lastDay = i.fields.getTextInputValue('last_day').trim();
      const notes = (i.fields.getTextInputValue('notes') || '').trim() || null;
      const removeAtRaw = (i.fields.getTextInputValue('remove_at') || '').trim() || null;
      if (!isValidDate(lastDay)) return replyEphemeral(i, '❌ صيغة آخر يوم غير صحيحة. استخدم YYYY-MM-DD.', COLORS.danger);
      if (removeAtRaw && !isValidDate(removeAtRaw)) return replyEphemeral(i, '❌ صيغة تاريخ إزالة الرتب غير صحيحة.', COLORS.danger);
      if (lastDay < today()) return replyEphemeral(i, '❌ آخر يوم لا يمكن أن يكون في الماضي.', COLORS.danger);
      if (removeAtRaw && removeAtRaw < lastDay) return replyEphemeral(i, '❌ تاريخ إزالة الرتب لا يمكن أن يكون قبل آخر يوم.', COLORS.danger);
      const policy = settings.resignationPolicy();
      const notice = daysBetween(today(), lastDay);
      if (notice < policy.noticeDays) {
        // لا نمنع — فقط تحذير سيظهر للإدارة
      }
      const s = staffService.get(i.user.id);
      const duplicate = getDb().prepare(`SELECT id FROM resignations WHERE user_id = ? AND status IN ('pending','on_hold')`).get(i.user.id);
      if (duplicate) return replyEphemeral(i, `❌ لديك طلب استقالة قيد المراجعة (#${duplicate.id}).`, COLORS.danger);
      const db = getDb();
      const res = db.prepare(`INSERT INTO resignations (user_id, reason, last_day, notes, reason_category, notice_days, remove_roles_at, team, rank) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(i.user.id, reason, lastDay, notes, reasonCat, notice, removeAtRaw, s?.team, s?.rank);
      const r = db.prepare('SELECT * FROM resignations WHERE id = ?').get(res.lastInsertRowid);
      const warn = notice < policy.noticeDays ? `⚠️ **فترة الإشعار أقل من ${policy.noticeDays} أيام** — تحتاج قرار Boss.` : undefined;
      const catInfo = RESIGNATION_REASONS[reasonCat];
      const content = [warn, catInfo?.retention ? `💡 **قابل للاحتفاظ:** ${catInfo.label} — فكّروا بعرض حل قبل القبول.` : null].filter(Boolean).join('\n') || undefined;
      const msg = await sendToChannel(i.client, 'resignation-requests', { content, embeds: [resignEmbed(r)], components: [reviewRow(r.id)] });
      if (msg) db.prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run(msg.id, r.id);
      audit.record({ action: 'resignation_requested', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id, lastDay, reasonCat }, channelId: i.channelId });
      const confirm = embed('✅ تم إرسال طلب استقالتك بسرية', [
        `**#${r.id}** — ${catInfo?.emoji || ''} ${catInfo?.label || ''} • آخر يوم ${kit.tsDate(lastDay)}`,
        removeAtRaw ? `ستُزال الرتب في ${kit.tsDate(removeAtRaw)}` : 'ستُزال الرتب فور القبول',
        '',
        'ستصلك رسالة عند اتخاذ القرار. يمكنك السحب عبر **/my-resignations** قبل القبول.',
      ].join('\n'), COLORS.success);
      confirm.addFields({ name: '📋 تذكير بالتسليم', value: RESIGNATION_GLOBAL.handoverTasks.slice(0, 3).join('\n') });
      return i.reply({ embeds: [confirm, handoverEmbed()], ephemeral: true });
    },
    'resign:pickwithdraw': async (i, [_page]) => {
      const id = Number(i.values[0]);
      const r = getDb().prepare("SELECT * FROM resignations WHERE id=? AND user_id=? AND status IN ('pending','on_hold')").get(id, i.user.id);
      if (!r) return replyEphemeral(i, '❌ لا يمكن سحب هذا الطلب.', COLORS.danger);
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`resign:confirmwithdraw:${id}`).setLabel('تأكيد السحب').setStyle(ButtonStyle.Danger).setEmoji('↩️'),
        new ButtonBuilder().setCustomId('resign:cancelwithdraw').setLabel('إلغاء').setStyle(ButtonStyle.Secondary),
      );
      return i.reply({ embeds: [embed('⚠️ تأكيد السحب', `هل تريد سحب الطلب **#${id}**؟\nآخر يوم: ${kit.tsDate(r.last_day)}`, COLORS.warning)], components: [row], ephemeral: true });
    },
    'resign:confirmwithdraw': async (i, [id]) => {
      const db = getDb();
      const r = db.prepare("SELECT * FROM resignations WHERE id=? AND user_id=? AND status IN ('pending','on_hold')").get(Number(id), i.user.id);
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      db.prepare(`UPDATE resignations SET status='withdrawn', withdrawn_by=?, withdrawn_at=datetime('now'), withdraw_reason='سحب من القائمة' WHERE id=?`).run(i.user.id, r.id);
      await updateRequestMessage(i.client, db.prepare('SELECT * FROM resignations WHERE id=?').get(r.id), COLORS.gray);
      audit.record({ action: 'resignation_withdrawn', actorId: i.user.id, targetId: i.user.id, details: { requestId: r.id }, channelId: i.channelId });
      return i.update({ embeds: [embed('✅ تم السحب', `سُحب الطلب **#${id}**.`, COLORS.success)], components: [] });
    },
    'resign:cancelwithdraw': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),
    'resign:withdrawlist': async (i, [page]) => {
      const rows = getDb().prepare(`SELECT * FROM resignations WHERE user_id=? AND status IN ('pending','on_hold') ORDER BY id DESC`).all(i.user.id);
      return i.update(withdrawEmbed(rows, Number(page)));
    },
    'resign:accept': async (i, [id]) => {
      if (i.staffLevel < LEVELS.BOSS) return replyEphemeral(i, '❌ قبول الاستقالة من صلاحية Boss فقط.', COLORS.danger);
      const block = selfReviewBlock(i, getDb().prepare('SELECT user_id FROM resignations WHERE id=?').get(Number(id)));
      if (block) return replyEphemeral(i, block, COLORS.danger);
      return forms.open(i, modals.decide({ id, action: 'accept' }));
    },
    'resign:acceptmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.BOSS) return replyEphemeral(i, '❌ Boss فقط.', COLORS.danger); return decide(i, id, 'accepted'); },
    'resign:reject': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const block = selfReviewBlock(i, getDb().prepare('SELECT user_id FROM resignations WHERE id=?').get(Number(id)));
      if (block) return replyEphemeral(i, block, COLORS.danger);
      return forms.open(i, modals.decide({ id, action: 'reject' }));
    },
    'resign:rejectmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger); return decide(i, id, 'rejected'); },
    'resign:hold': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const block = selfReviewBlock(i, getDb().prepare('SELECT user_id FROM resignations WHERE id=?').get(Number(id)));
      if (block) return replyEphemeral(i, block, COLORS.danger);
      return forms.open(i, modals.decide({ id, action: 'hold' }));
    },
    'resign:holdmodal': async (i, [id]) => { if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger); return decide(i, id, 'on_hold'); },
    'resign:interview': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const r = getDb().prepare('SELECT * FROM resignations WHERE id=?').get(Number(id));
      if (!r) return replyEphemeral(i, '❌ الطلب غير موجود.', COLORS.danger);
      const block = selfReviewBlock(i, r);
      if (block) return replyEphemeral(i, block, COLORS.danger);
      return forms.open(i, modals.interview({ id }), { values: { exit_interview: r.exit_interview } });
    },
    'resign:interviewmodal': async (i, [id]) => {
      if (i.staffLevel < LEVELS.MANAGEMENT) return replyEphemeral(i, '❌ لا تملك الصلاحية.', COLORS.danger);
      const target = getDb().prepare('SELECT user_id FROM resignations WHERE id=?').get(Number(id));
      const block = selfReviewBlock(i, target);
      if (block) return replyEphemeral(i, block, COLORS.danger);
      const text = i.fields.getTextInputValue('exit_interview').trim();
      getDb().prepare('UPDATE resignations SET exit_interview=? WHERE id=?').run(text, Number(id));
      const updated = getDb().prepare('SELECT * FROM resignations WHERE id=?').get(Number(id));
      await updateRequestMessage(i.client, updated);
      audit.record({ action: 'resignation_interview', actorId: i.user.id, targetId: updated.user_id, details: { requestId: updated.id }, channelId: i.channelId });
      await dm(i.client, updated.user_id, { embeds: [embed('📝 مقابلة خروج', text, COLORS.info)] });
      return replyEphemeral(i, `✅ تم حفظ مقابلة الخروج للطلب #${id}.`, COLORS.success);
    },
  },
};
