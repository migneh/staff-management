'use strict';
const cron = require('node-cron');
const { getDb } = require('./database');
const staffService = require('./services/staff');
const reports = require('./services/reports');
const load = require('./services/load');
const points = require('./services/points');
const promoService = require('./services/promotions');
const { POINTS_TRANSITION_DAYS } = promoService;
const { ABSENCE, LEAVE_GLOBAL, LEAVE_TYPES } = require('./constants');
const settings = require('./services/settings');
const leaveService = require('./services/leaves');
const audit = require('./services/audit');
const { embed, COLORS, sendToChannel, dm, hoursSince, today, addDays, daysBetween } = require('./utils');
const reportCmds = require('./commands/reports');
const backup = require('./services/backup');
const kit = require('./ui/kit');
const clock = require('./clock');
const { INACTIVE_STATUSES } = require('./constants');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const logger = require('./logger').log('scheduler');
/** نفس أزرار المراجعة المستخدمة في /review-leaves حتى لا تختلف الواجهة بين المسارين. */
function leaveReviewRow(id) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`leave:approve:${id}`).setLabel('موافقة').setEmoji('✅').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`leave:reject:${id}`).setLabel('رفض').setEmoji('❌').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`leave:suggest:${id}`).setLabel('تعديل مقترح').setEmoji('💡').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`leave:details:${id}`).setLabel('تفاصيل').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
  );
}
const config = require('./config');
const retention = require('./services/retention');

const EXEMPT = INACTIVE_STATUSES;

// ===== فاحص الغياب — يتجمد أثناء الإجازة =====

/**
 * هل انتهت حلقة الغياب لهذا العضو؟ العلامتان تُمسحان معاً.
 *
 * `staff.js` touchActivity يصفّر absence_alert_level وحده (وليس ملفنا)، فلا
 * يبقى إلا أن نمسح علامة الرسالة الخاصة بأنفسنا. لولا هذا صارت الرسالة التي
 * وُعد بها العضو في الجولة الأولى تُرسَل مرة واحدة في حياته: يعود من الغياب،
 * يغيب مرة أخرى، ولا تصله رسالة أبداً.
 */
function clearAbsenceMarkers(userId) {
  getDb().prepare('UPDATE staff_members SET absence_dm_sent_at = NULL WHERE user_id = ? AND absence_dm_sent_at IS NOT NULL').run(userId);
}

/**
 * العتبتان مستقلتان، لا شجرة if/else.
 *
 * السبب الذي كان يبتلع الرسالة: `if (staff96) … else if (dm72) …`. من تُرصد
 * أول مرة فوق 96 ساعة — وهو بالضبط حال كل إعادة تشغيل فيها غائب — يأخذ فرع
 * التنبيه الإداري، فيُرفع إلى المستوى 2، ولا يصله شيء. والرسالة 72 ساعة
 * ليست تنبيهاً بديلاً: هي ما يَعِد العضو بأن عليه تقديم طلب إجازة، وهي
 * وحدها التي تعطي الغائب سبباً للخروج من الغياب. فرِدٌ واحد يحمل عدّادَين
 * يجعل أطولَ العتبتين يبتلع أقصرَهما.
 *
 * لماذا عمودان لا قناع بتات (bitmask) في absence_alert_level:
 *  • لكل حدثٍ وقتُه الخاص؛ الطابع الزمني يحفظ «متى»، وهو ما تحتاجه أي إعادة
 *    محاولة لاحقاً. القناع يقول «حدث» ولا يقول «متى» ولا «كم مرّة».
 *  • أضفنا إلى عمودٍ حيٍّ يكتب فيه غيرنا قيمة صفر: services/staff.js
 *    (touchActivity) وservices/leaves.js يصفّرانه. ولو حمل العمود الواحد
 *    معنيين لاختلطا عند أي قارئ جديد، والقناع يخفي المعنى داخل رقمين.
 *  • والعمود الإضافي أوضح للقارئ من قناعٍ لا يعرف إلا صاحبه ترميزه.
 */
async function checkAbsence(client) {
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    // المجاز لا يُحتسب غيابه
    if (leaveService.activeForUser(m.user_id).length) continue;
    if (m.status === 'probation' && m.probation_exempt) continue;
    const h = hoursSince(m.last_activity || m.joined_at);
    // عاد إلى النشاط: انتهت حلقة الغياب، فلا عتبة ولا رسالة.
    if (h < ABSENCE.dmHours) {
      // الاستعلام مقصور على من تحمل العلامة فعلاً، فلا تكلفة على السليم.
      if (m.absence_dm_sent_at) clearAbsenceMarkers(m.user_id);
      continue;
    }
    const markInactive = { status: m.status === 'active' ? 'inactive' : m.status };
    // ترتيب لا يهم مضمونه: بعد هذه النقطة نريد الاثنين أن يمرّا معاً.
    if (!m.absence_dm_sent_at) {
      await dm(client, m.user_id, { embeds: [embed('⏰ تنبيه غياب', `لم نرصد أي نشاط منك منذ **${Math.floor(h)}** ساعة. إذا كان لديك ظرف، قدّم طلب إجازة عبر \`/request-leave\`.`, COLORS.warning)] });
      staffService.update(m.user_id, { absence_alert_level: 1, absence_dm_sent_at: clock.nowIso(), ...markInactive });
    }
    if (h >= ABSENCE.staffAlertHours && m.absence_alert_level < 2) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 غياب 96 ساعة', `<@${m.user_id}> (${m.rank}) بدون نشاط منذ **${Math.floor(h)}** ساعة.`, COLORS.danger)] });
      staffService.update(m.user_id, { absence_alert_level: 2, ...markInactive });
    }
  }
}

// ===== الإجازات: تفعيل الرتبة / إنهاء / تذكيرات / مزامنة / انتهاء المعلقة =====

/** رموز ديسكورد التي تعني «هذا المستخدم ليس عضواً في السيرفر» (وليست فشلاً عابراً). */
const MEMBER_GONE_CODES = new Set([10004 /* UnknownGuild */, 10007 /* UnknownMember */]);

/**
 * جلب عضو مع تمييز «غادر السيرفر» عن «تعذّر الجلب مؤقتاً».
 * التمييز مقصود: `catch { return null }` يخلط الخطأين، فلا نعرف الفرق بين
 * «غادر السيرفر» (قرار نهائي: لا رتبة في سيرفر بلا عضو) وبين «ديسكورد
 * تعذّر» أو «البوت بلا صلاحية» (يجب إعادة المحاولة غداً).
 */
async function fetchGuildMember(client, userId) {
  const g = client?.guilds?.cache?.get(config.guildId) || [...(client?.guilds?.cache?.values?.() || [])][0];
  if (!g?.members?.fetch) return { member: null, gone: false };
  try { return { member: await g.members.fetch(userId), gone: false }; }
  catch (e) { return { member: null, gone: MEMBER_GONE_CODES.has(Number(e?.code)) }; }
}

async function guildMember(client, userId) {
  return (await fetchGuildMember(client, userId)).member;
}

async function processLeaves(client) {
  const db = getDb();
  const t = today();
  const policy = settings.leavePolicy();

  // 0) إسقاط الطلبات المعلقة المنتهية (طلبه كان لماضٍ وانتهت مهلته)
  const expireDays = Number(policy.pendingExpireDays || LEAVE_GLOBAL.pendingExpireDays || 10);
  const pendingRows = db.prepare(`SELECT * FROM leave_requests WHERE status='pending'`).all();
  for (const r of pendingRows) {
    // إذا انتهت فترة الإجازة دون مراجعة، أو بقي معلقاً أكثر من expireDays
    const created = (r.created_at || '').slice(0, 10);
    const age = created ? daysBetween(created, t) : 0;
    if (r.end_date < t || age >= expireDays) {
      db.prepare(`UPDATE leave_requests SET status='cancelled', cancelled_at=datetime('now'), cancel_reason='انتهت دون مراجعة', end_reason='auto' WHERE id=?`).run(r.id);
      try {
        await updateLeaveMessage(client, r.id);
        await dm(client, r.user_id, { embeds: [embed('⌛ انتهى طلب إجازتك دون مراجعة', `طلبك **#${r.id}** (${r.start_date} → ${r.end_date}) انتهت مدته دون قرار.\nيمكنك تقديم طلب جديد إن احتجت.`, COLORS.gray)] });
      } catch {}
      audit.record({ action: 'leave_auto_expired', targetId: r.user_id, details: { requestId: r.id, reason: 'pending_expired' } });
    }
  }

  // 0.5) تصعيد الطلبات المعلّقة التي تجاوزت مدة المراجعة المتفق عليها.
  const escalateHours = Number(policy.pendingEscalateHours || LEAVE_GLOBAL.pendingEscalateHours || 24);
  if (escalateHours > 0) {
    for (const r of pendingRows) {
      const created = clock.parseStamp(r.created_at);
      if (!created || Number.isNaN(created.getTime())) continue;
      const hours = Math.floor((Date.now() - created.getTime()) / 3600000);
      if (hours < escalateHours) continue;
      // الطلب قد يكون سقط في الخطوة 0 من هذه الدورة نفسها: لا نصعّد ما لم يعد
      // معلّقاً، ولا نرسل أزرار مراجعة حيّة (approve/reject شغّالان) لطلب أُلغي.
      if (!db.prepare("SELECT 1 FROM leave_requests WHERE id = ? AND status = 'pending'").get(r.id)) continue;
      // المطالبة ذرّية: تذكير واحد فقط للإجابة، مهما تكرّر تشغيل المهمة.
      if (!leaveService.claimReminder(r.id, 'escalate')) continue;
      try {
        await sendToChannel(client, 'leave-requests', { embeds: [embed('⏰ طلب بانتظار القرار', `${LEAVE_TYPES[r.leave_type] ? LEAVE_TYPES[r.leave_type] + ' — ' : ''}<@${r.user_id}>\nالطلب **#${r.id}** معلّق منذ **${hours}** ساعة (${r.start_date} → ${r.end_date}).\nيرجى البت فيه، أو استخدم «تعديل مقترح» لتواريخ بديلة.`, COLORS.warning)], components: [leaveReviewRow(r.id)] });
      } catch (e) { logger.warn(`تعذّر إرسال تصعيد الطلب ${r.id}: ${e.message}`); }
      audit.record({ action: 'leave_escalated', targetId: r.user_id, details: { requestId: r.id, hours } });
    }
  }

  const rows = db.prepare(`SELECT * FROM leave_requests WHERE status = 'approved' ORDER BY start_date`).all();
  for (const r of rows) {
    const s = staffService.get(r.user_id);
    const member = await guildMember(client, r.user_id);

    // تذكير قبل البداية بيوم
    if (r.start_date === addDays(t, 1) && leaveService.claimReminder(r.id, 'start')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير بداية الإجازة', `إجازتك **#${r.id}** تبدأ غداً (${kit.tsDate(r.start_date)}).\n${policy.vacationRoleTiming === 'at_start' ? 'ستُفعّل رتبة **in vacation** تلقائياً.' : 'رتبة **in vacation** مفعّلة من الموافقة.'}`, COLORS.info)] });
    }

    // تفعيل الحالة والرتبة — التوقيت (at_start / at_approval) يُطبَّق في
    // leaves.syncVacationRole عند الموافقة، وهنا نضمن الرتبة عند بداية الإجازة فعلياً.
    if (r.start_date <= t && r.end_date >= t) {
      if (s && s.status !== 'on_leave' && s.status !== 'resigned') staffService.setStatus(r.user_id, 'on_leave');
      if (member && !r.role_applied_at) {
        // الرتبة مطلوبة عند بداية الإجازة فعلياً، بغض النظر عن توقيت المنح (at_start أو at_approval).
        const roleResult = await staffService.addVacationRole(member);
        if (roleResult.ok) db.prepare("UPDATE leave_requests SET role_applied_at = datetime('now') WHERE id = ?").run(r.id);
        if (!roleResult.ok && leaveService.claimReminder(r.id, 'role_retry')) {
          await sendToChannel(client, 'staff-logs', { embeds: [embed('⚠️ تعذر تفعيل رتبة in vacation', `الإجازة **#${r.id}** لـ <@${r.user_id}> — ${roleResult.missing ? 'الرتبة غير مربوطة في /setup' : roleResult.error?.message || 'صلاحيات'}`, COLORS.warning)] });
        }
      }
    }

    if (r.end_date === addDays(t, 1) && leaveService.claimReminder(r.id, 'end')) {
      await dm(client, r.user_id, { embeds: [embed('🏖️ تذكير نهاية الإجازة', `إجازتك تنتهي غداً (${kit.tsDate(r.end_date)}). نرجو العودة للنشاط بعدها.`, COLORS.info)] });
    }

    if (r.end_date < t) {
      const ended = db.prepare(`UPDATE leave_requests SET status = 'ended', end_reason = COALESCE(end_reason,'auto') WHERE id = ? AND status = 'approved'`).run(r.id);
      if (ended.changes) audit.record({ action: 'leave_ended', targetId: r.user_id, details: { requestId: r.id, reason: 'انتهاء المدة تلقائياً' } });
      const roleResult = member ? await leaveService.syncVacationRole(member, t) : null;
      if (roleResult?.ok && !leaveService.approvedForUser(r.user_id, { onOrAfter: t }).length) db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE id = ?").run(r.id);
      await updateLeaveMessage(client, r.id);
      const remaining = leaveService.activeForUser(r.user_id, t);
      if (s && s.status === 'on_leave' && !remaining.length) staffService.update(r.user_id, {
        status: 'active', absence_alert_level: 0, last_activity: clock.nowIso(),
      });
    }
  }

  // إعادة محاولة إزالة الرتبة إن فشلت سابقاً.
  //
  // العضو الذي غادر السيرفر وهو في إجازة لا رتبة له أصلاً: لا عضو ولا رتبة.
  // كان `if (!member) continue;` بلا حالة نهائية، فكل طلب لمن غادر أثناء إجازته
  // ظلّ يُجلب كل يوم إلى الأبد بلا فائدة. وكان `DISTINCT` فوق ذلك يبني
  // B-tree مؤقتة على كل الطلبات المنتهية والملغاة منذ بداية القاعدة — الآن
  // مسح واحد بلا ترتيب مع تجميع داخل الذاكرة.
  const pendingCleanup = db.prepare(`SELECT id, user_id FROM leave_requests
    WHERE status IN ('ended', 'cancelled') AND role_removed_at IS NULL
      AND instr(',' || COALESCE(reminders_sent, '') || ',', ',role_gone,') = 0`).all();
  const byUser = new Map();
  for (const row of pendingCleanup) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row.id);
  }
  for (const [userId, ids] of byUser) {
    const { member, gone } = await fetchGuildMember(client, userId);
    if (!member) {
      if (gone) {
        for (const requestId of ids) {
          if (!leaveService.claimReminder(requestId, 'role_gone')) continue;
          audit.record({ action: 'leave_role_cleanup_resolved', targetId: userId, details: { requestId, reason: 'member_not_in_guild' } });
        }
        logger.info(`العضو ${userId} غادر السيرفر — أُغلقت ${ids.length} عملية إزالة رتبة معلّقة بلا تنفيذ.`);
      }
      // تعذّر الجلب مؤقتاً: نُبقي الطلبات مفتوحة ونُعيد المحاولة في الدورة القادمة.
      continue;
    }
    const roleResult = await leaveService.syncVacationRole(member, t);
    if (roleResult.ok && !leaveService.approvedForUser(userId, { onOrAfter: t }).length) {
      db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE user_id = ? AND status IN ('ended', 'cancelled') AND role_removed_at IS NULL").run(userId);
    }
  }

  // تنبيه بعد النهاية بـ 24 ساعة إن لم يعد
  const ended = db.prepare(`SELECT * FROM leave_requests WHERE status = 'ended' AND end_date = ?`).all(addDays(t, -1));
  for (const r of ended) {
    if (!leaveService.claimReminder(r.id, 'overdue')) continue;
    const s = staffService.get(r.user_id);
    const activityAfter = db.prepare('SELECT 1 FROM activity_logs WHERE user_id = ? AND day > ? LIMIT 1').get(r.user_id, r.end_date);
    if (s && !activityAfter) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ لم يعد من الإجازة', `<@${r.user_id}> انتهت إجازته في ${r.end_date} ولم يُرصد نشاط بعدها.`, COLORS.warning)] });
      await dm(client, r.user_id, { embeds: [embed('⚠️ تذكير العودة', `انتهت إجازتك في ${r.end_date}. نرجو العودة للنشاط أو التواصل مع الإدارة.`, COLORS.warning)] });
    }
  }
}

async function updateLeaveMessage(client, id) {
  try {
    const r = getDb().prepare('SELECT * FROM leave_requests WHERE id=?').get(Number(id));
    if (!r?.message_id) return;
    const { getChannel } = require('./utils');
    const ch = await getChannel(client, 'leave-requests');
    if (!ch) return;
    const msg = await ch.messages.fetch(r.message_id);
    const { LEAVE_TYPES, LEAVE_RULES } = require('./constants');
    const rule = LEAVE_RULES[r.leave_type] || {};
    const color = { pending: COLORS.warning, approved: COLORS.success, rejected: COLORS.danger, ended: COLORS.gray, cancelled: COLORS.gray }[r.status] || COLORS.gray;
    const e = embed(`${rule.emoji || '🏖️'} إجازة #${r.id} — ${LEAVE_TYPES[r.leave_type] || r.leave_type}`, null, color)
      .addFields({ name: 'الحالة', value: ({ pending: '⏳ معلق', approved: '✅ معتمد', rejected: '❌ مرفوض', ended: '🏁 منتهي', cancelled: '🚫 ملغى' }[r.status] || r.status), inline: true });
    await msg.edit({ embeds: [e], components: [] });
  } catch {}
}

// ===== الاستقالات: تذكيرات + تصعيد + إزالة مؤجلة =====
async function processResignations(client) {
  const db = getDb();
  const t = today();
  const policy = settings.resignationPolicy();
  const rows = db.prepare(`SELECT * FROM resignations WHERE status IN ('pending', 'on_hold') ORDER BY last_day`).all();
  for (const r of rows) {
    const sent = new Set(String(r.reminders_sent || '').split(',').filter(Boolean));
    const notified = new Set(String(r.notified_reviewers || '').split(',').filter(Boolean));
    const mark = key => {
      if (sent.has(key)) return false;
      sent.add(key);
      db.prepare('UPDATE resignations SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), r.id);
      return true;
    };
    const days = daysBetween(t, r.last_day);
    if (days <= 3 && days > 1 && mark('three_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('📤 استقالة قريبة', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> يصل آخر يوم لها بعد **3 أيام** (${kit.tsDate(r.last_day)}). يرجى مراجعتها.`, COLORS.warning)] });
      await dm(client, r.user_id, { embeds: [embed('📤 تذكير بالاستقالة', `طلب استقالتك **#${r.id}** ما زال قيد المراجعة، وآخر يوم هو **${kit.tsDate(r.last_day)}**.`, COLORS.warning)] });
    }
    if (days === 1 && mark('one_day')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 استقالة غداً', `الاستقالة السرية **#${r.id}** لـ <@${r.user_id}> آخر يوم لها غداً (**${kit.tsDate(r.last_day)}**). يلزم قرار الإدارة.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('🚨 آخر يوم قريب', `آخر يوم في طلب استقالتك **#${r.id}** هو غداً. سيصلك قرار الإدارة عبر الخاص.`, COLORS.warning)] });
    }
    if (days <= 0 && mark('overdue')) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚠️ استقالة تجاوزت آخر يوم', `الطلب السري **#${r.id}** لـ <@${r.user_id}> تجاوز آخر يوم **${kit.tsDate(r.last_day)}** دون قرار.`, COLORS.danger)] });
      await dm(client, r.user_id, { embeds: [embed('⚠️ متابعة الاستقالة', `انتهى التاريخ المحدد لطلب استقالتك **#${r.id}** وما زال القرار قيد المراجعة. تواصل مع الإدارة.`, COLORS.warning)] });
    }
    // تصعيد: إذا بقي معلقاً أكثر من pendingEscalateDays
    const created = (r.created_at || '').slice(0, 10);
    const age = created ? daysBetween(created, t) : 0;
    if (age >= (policy.pendingEscalateDays || 3) && !notified.has('escalated') && ['pending', 'on_hold'].includes(r.status)) {
      notified.add('escalated');
      db.prepare('UPDATE resignations SET notified_reviewers=? WHERE id=?').run([...notified].join(','), r.id);
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('⏰ تصعيد استقالة معلقة', `الطلب **#${r.id}** لـ <@${r.user_id}> معلق منذ **${age}** أيام — يلزم قرار سريع.`, COLORS.danger)] });
    }
  }

  // إزالة الرتب المؤجلة (remove_roles_at)
  const deferred = db.prepare("SELECT * FROM resignations WHERE status='accepted' AND remove_roles_at IS NOT NULL AND remove_roles_at <= ? AND roles_removed_at IS NULL").all(t);
  for (const r of deferred) {
    const member = await guildMember(client, r.user_id);
    if (!member) continue;
    const staffRolesRemoved = await staffService.removeAllStaffRoles(member);
    const vacationRoleRemoved = await staffService.removeVacationRole(member);
    if (staffRolesRemoved && vacationRoleRemoved.ok) {
      db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
      const info = staffService.get(r.user_id);
      if (info) staffService.appendRankChange({ userId: r.user_id, fromRank: info.rank, toRank: info.rank, team: info.team, changeType: 'remove', reason: `إزالة رتب الاستقالة #${r.id}` });
      audit.record({ action: 'resignation_roles_removed_deferred', targetId: r.user_id, details: { requestId: r.id } });
    }
  }
  // إعادة محاولة إزالة فورية إن فشلت
  const accepted = db.prepare("SELECT * FROM resignations WHERE status = 'accepted' AND roles_removed_at IS NULL AND (remove_roles_at IS NULL OR remove_roles_at <= ?)").all(t);
  for (const r of accepted) {
    if (deferred.some(d => d.id === r.id)) continue;
    const member = await guildMember(client, r.user_id);
    if (!member) continue;
    const staffRolesRemoved = await staffService.removeAllStaffRoles(member);
    const vacationRoleRemoved = await staffService.removeVacationRole(member);
    if (staffRolesRemoved && vacationRoleRemoved.ok) db.prepare("UPDATE resignations SET roles_removed_at = datetime('now') WHERE id = ?").run(r.id);
  }
}

// ===== تذكيرات المهام والتأهيل/التسليم =====

/**
 * كم محاولة يُمنح لتذكير مهمة قبل الاستسلام.
 *
 * ثلاثة أيام: فشلٌ عابر (انقطاع شبكة، أو البوت متوقف يوماً) يشفي فيوم أو
 * يومين. أما العضو الذي أغلق الرسائل الخاصة فكل محاولة نداء ميت بلا أمل،
 * والنهاية الصحيحة أن تتوقف. والمهام من نوع onboarding/offboarding: تأهيل
 * وتسليم، أي مهمة لا ينساها النظام.
 */
const TASK_REMINDER_MAX_ATTEMPTS = 3;

/**
 * إعلان الاستسلام للإدارة.
 *
 * تذكير onboarding مُستسلَم بصمت يعني شخصاً لا يُذكَّر ولا أحد يعرف: سقط من
 * سجل المتابعة بلا أثر. لذلك يُكتب الاستسلام في ثلاثة مواضع: عمود المهمة
 * (للقارئ المباشر)، هنا في قناة الإدارة، وفي سجل العمليات.
 */
async function announceReminderGiveUps(client, tasks) {
  if (!tasks.length) return;
  const lines = tasks.slice(0, 15).map(t => `• <@${t.user_id}> — **#${t.id} ${t.title}** (${t.task_type})`).join('\n');
  await sendToChannel(client, 'staff-alerts', { embeds: [embed(`🚫 تعذّر تذكير مهام بعد ${TASK_REMINDER_MAX_ATTEMPTS} محاولات`,
    `${lines}\n\nالعضو إما مغلق الرسائل الخاصة أو غادر السيرفر، فالتذكير أُوقف عند حدّه ولم يعد يُعاد. **تابعوا يدوياً** أو ألغوا المهمة.\n_محاولات كل مهمة مسجّلة عليها، وفي \`/staff-logs\` سطر \`task_reminder_given_up\`._`,
    COLORS.warning)] });
}

/**
 * تذكير المهام المتأخرة أو المستحقة غداً — بمحاولات محدودة ونهاية مرئية.
 *
 * كان `WHERE reminder_sent_at IS NULL` و`if (sent) UPDATE …`: وdm() في utils
 * يبتلع كل خطأ ويعيد false، فعضو أغلق رسائله كان يعني نداءً ميتاً كل يوم الساعة
 * 08:00 إلى الأبد، بلا عدّاد وبلا سجل يعلم أن أحداً لم يُذكَّر.
 *
 * المحاولة الآن تُحتسب قبل الإرسال لا بعده (وإلا فلا يُحفظ عدّاد لرسالة فشلت
 * إرسالها أصلاً)، والاستسلام يقع عند الحدّ لا بعده، ويُعلَن.
 */
async function processTaskReminders(client) {
  const db = getDb();
  const cutoff = addDays(today(), 1);
  const rows = db.prepare(`SELECT * FROM staff_tasks
    WHERE status = 'pending' AND reminder_sent_at IS NULL AND reminder_given_up_at IS NULL
      AND due_date IS NOT NULL AND reminder_attempts < ?
      AND due_date <= ? AND task_type IN ('onboarding', 'offboarding')
    ORDER BY due_date, id`).all(TASK_REMINDER_MAX_ATTEMPTS, cutoff);
  const givenUps = [];
  for (const task of rows) {
    // العدّاد يُثبَّت أولاً: لو مات البوت بعد الإرسال، تبقى المحاولة محسوبة
    // بدل أن نعيد إرسالها ثلاثاً إلى الأبد.
    db.prepare("UPDATE staff_tasks SET reminder_attempts = reminder_attempts + 1, updated_at = datetime('now') WHERE id = ?").run(task.id);
    const overdue = task.due_date < today();
    const sent = await dm(client, task.user_id, { embeds: [embed(overdue ? '⚠️ مهمة متأخرة' : '⏰ تذكير بمهمة',
      `لديك المهمة **#${task.id} — ${task.title}**${overdue ? ' متأخرة عن موعدها' : ` موعدها ${kit.tsDate(task.due_date)}`}.\n\nاستخدم **/my-tasks** لمراجعتها.`, COLORS.warning)] });
    if (sent) {
      db.prepare("UPDATE staff_tasks SET reminder_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(task.id);
      continue;
    }
    if (task.reminder_attempts + 1 >= TASK_REMINDER_MAX_ATTEMPTS) {
      db.prepare("UPDATE staff_tasks SET reminder_given_up_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(task.id);
      givenUps.push({ ...task, reminder_attempts: task.reminder_attempts + 1 });
      audit.record({ action: 'task_reminder_given_up', targetId: task.user_id, details: { taskId: task.id, attempts: task.reminder_attempts + 1, taskType: task.task_type } });
    }
  }
  if (givenUps.length) {
    await announceReminderGiveUps(client, givenUps);
    logger.warn(`🚫 ${givenUps.length} مهمة توقّف تذكيرها بعد ${TASK_REMINDER_MAX_ATTEMPTS} محاولات: ${givenUps.map(t => `#${t.id}`).join('، ')}`);
  }
  return rows.length;
}

/**
 * المهام التي استُسلم تذكيرها — يقرأها المشغّل ليعرف من لم يُذكَّر.
 *
 * الاستسلام حدٌّ نهائي: من بلغ له لا تُعاد المحاولة (بلا سبب ولا أمل)، ومن
 * نجح له جملةً واضحة بلا استسلام في السجل نفسه. والشرط `reminder_sent_at IS
 * NULL` يمنع عرض مهمة نجحت متأخرةً كأنها مُستسلَمة.
 */
function reminderGiveUps() {
  return getDb().prepare(`SELECT id, user_id, title, task_type, due_date, reminder_attempts, reminder_given_up_at
    FROM staff_tasks WHERE reminder_given_up_at IS NOT NULL AND reminder_sent_at IS NULL
    ORDER BY reminder_given_up_at DESC, id`).all();
}

// ===== التقارير =====
/**
 * يرفع الإيقاف عن كل من انتهت مدته (suspended_until) ويُعلم الفريق.
 * بلا هذه المهمة يبقى الموقوف موقوفاً للأبد لأن حالة الإيقاف لا تنتهي ذاتياً.
 */
async function liftSuspensions(client) {
  const lifted = staffService.liftExpiredSuspensions(clock.today());
  if (!lifted.length) return;
  for (const m of lifted) {
    audit.record({ action: 'suspension_lifted', targetId: m.user_id, details: { until: m.until } });
    await dm(client, m.user_id, { embeds: [embed('✅ انتهى الإيقاف', `انتهت مدة إيقافك (${m.until}) وعادت حالتك إلى **active**.`, COLORS.success)] });
  }
  await sendToChannel(client, 'staff-updates', { embeds: [embed('🔓 انتهاء إيقاف', lifted.map(m => `<@${m.user_id}> — انتهى إيقافه (${m.until})`).join('\n'), COLORS.success)] });
  logger.info(`🔓 رُفع الإيقاف عن ${lifted.length} عضو.`);
}

async function dailyReport(client) {
  const d = reports.daily();
  reports.save('daily', today(), d);
  const e = embed(`📅 التقرير اليومي — ${kit.tsDate(today())}`, null, COLORS.info).addFields(
    { name: '👥 الإداريون', value: `${d.total}`, inline: true }, { name: '🟢 نشطون (24س)', value: `${d.active}`, inline: true }, { name: '🏖️ بإجازة', value: `${d.onLeave}`, inline: true },
    { name: '🎫 تكتات اليوم', value: `${d.tickets}`, inline: true }, { name: '🛡️ إجراءات اليوم', value: `${d.actions}`, inline: true }, { name: '🔴 غائبون (72س+)', value: d.absent.length ? d.absent.map(m => `<@${m.user_id}>`).join(' ') : 'لا يوجد', inline: false },
    { name: '⏳ طلبات معلّقة', value: `إجازات: ${d.pending.leaves} • استقالات: ${d.pending.resignations} • ترقيات: ${d.pending.promotions}` });
  await sendToChannel(client, 'performance-reports', { embeds: [e] });
}

/**
 * من إجازته مفعّلة اليوم — قراءة واحدة للجدول بدل استعلام لكل عضو.
 *
 * مطابقة لـ `leaveService.activeForUser(id)` حرفياً: نفس الجدول، ونفس الشرطين
 * (`status = 'approved'` وطرفا التاريخ يتقاطعان مع اليوم)، والاختلاف الوحيد
 * أن الاستعلام لا يُقيَّد بمستخدم واحد — فنحصل على مجموعة من هم في إجازة الآن،
 * وتُقرأ مرّتين هنا (قائمة المراجعة والخاملون) بدل 2N استعلاماً متفرّقة.
 *
 * @returns {Set<string>} معرّف كل من إجازته مفعّلة اليوم
 */
function activeLeaveUsers() {
  const t = today();
  const rows = getDb().prepare(`SELECT DISTINCT user_id FROM leave_requests
    WHERE status = 'approved' AND start_date <= ? AND end_date >= ?`).all(t, t);
  return new Set(rows.map(r => String(r.user_id)));
}

/**
 * مرحلة بيانات التقرير الأسبوعي — المواد الخام تُقرأ **مرّتين مطلقاً** لا 14N:
 *
 * قبل التجميع كان المسار ثلاث قطوعات مستقلة فوق البيانات نفسها:
 *  • قائمة المراجعة: قراءة خام منفصلة لكل عضو.
 *  • لوحتا الترتيب: `leaderboard()` بلا دفعة مشتركة — 9 × 2 (ولو كان مشتركاً
 *    فهو 9 ثابتة لا المشكلة الأصلية).
 *  • رسائل الخاص: `individual()` بلا `pre` يعيد قراءة البيانات الخام لكل عضو
 *    ويجري استعلام الإنذارات منفصلاً.
 * الآن دفعتان فقط من `reports.rawBatch`: واحدة لنافذة القائمة (7 أيام) وأخرى
 * لنافذة الترتيب والخاص، وثلاثة المستهلكين يقرأون منهما. كلا المستهلكين عند
 * الإزاحة صفر، فتطابق النافذة اليومية بيانات التقرير الخام حقلًا بحقل
 * (مثبت في tests/ackWindowFinish.test.js وtests/weeklyReportBatch.test.js).
 *
 * التصفية تبقى عند كل مستهلك كما كانت تماماً: القائمة تستبعد المستثنى
 * (INACTIVE_STATUSES) والتجربة ومن هو في إجازة؛ اللوحتان عبر `isRankable`
 * داخل `leaderboard`؛ والخاص لا يستبعد إلا المستقيل والمحذوف.
 *
 * @returns {{below: {user: string, rank: string, pointsEarned: number}[],
 *            boards: Record<string, object[]>,
 *            dms: {user: string, report: object}[],
 *            idle: object[],
 *            windowDays: number}}
 */
function weeklyReportData() {
  const all = staffService.all();
  const windowDays = reportCmds.LEADERBOARD_WINDOW_DAYS;
  const onLeave = activeLeaveUsers();

  // أعضاء مؤهلون لفحص النقاط الأسبوعية، مع استبعاد الإجازات والحالات المعفاة.
  const belowMembers = all.filter(m => !EXEMPT.includes(m.status)
    && m.status !== 'probation' && !onLeave.has(String(m.user_id)));
  const belowIds = belowMembers.map(m => String(m.user_id));

  // ===== قائمة المراجعة الأسبوعية — يستخدم النقاط كمؤشر أداء أسبوعي =====
  // سياسة معلنة: لا خصم ولا مكافأة تلقائية. الأسبوع الضعيف يُراجع بشرياً.
  // نجمع نقاط العصر الحالي لكل الأعضاء باستعلام واحد، ثم ندرج من لم يكسبوا.
  const below = [];
  const weekEnd = today();
  const weekStart = addDays(weekEnd, -6);
  const { start: weekWindowStart, endExclusive: weekWindowEnd } = clock.dayWindow(weekStart, weekEnd) || {};

  if (weekWindowStart && weekWindowEnd && belowIds.length) {
    const rows = getDb().prepare(`
      SELECT p.user_id, SUM(p.points) total
      FROM promotion_points p
      JOIN staff_members m ON m.user_id = p.user_id AND m.rank_epoch = p.rank_epoch
      WHERE p.user_id IN (${belowIds.map(() => '?').join(',')})
        AND p.created_at >= ? AND p.created_at < ?
      GROUP BY p.user_id
    `).all(...belowIds, weekWindowStart, weekWindowEnd);
    const earnedByUser = new Map(rows.map(r => [String(r.user_id), Number(r.total) || 0]));

    for (const m of belowMembers) {
      if ((earnedByUser.get(String(m.user_id)) || 0) === 0) {
        below.push({ user: m.user_id, rank: m.rank, pointsEarned: 0 });
      }
    }
  }

  // ===== الترتيب بالنقاط (العصر الحالي) — points.leaderboard لا يحتاج دفعة =====
  const boards = {};
  for (const t of ['support', 'moderation']) {
    boards[t] = points.leaderboard({ team: t, limit: 20 });
  }

  // ===== تقارير فردية بالخاص — دفعة واحدة عبر rawBatch ثم individual(pre) =====
  // يختصر N استدعاء monthlyRaw إلى استعلام واحد لكل جدول (ثابت لا ينمو مع الأعضاء).
  const recipientIds = all
    .filter(m => m.status !== 'resigned' && m.status !== 'removed')
    .map(m => String(m.user_id));
  const preBatch = reports.rawBatch(recipientIds, windowDays);
  const balanceRows = recipientIds.length ? getDb().prepare(`
    SELECT p.user_id, COALESCE(SUM(p.points), 0) total
    FROM staff_members m LEFT JOIN promotion_points p
      ON p.user_id = m.user_id AND p.rank_epoch = m.rank_epoch
    WHERE m.user_id IN (${recipientIds.map(() => '?').join(',')})
    GROUP BY m.user_id
  `).all(...recipientIds) : [];
  const balances = new Map(balanceRows.map(r => [String(r.user_id), Number(r.total) || 0]));

  const dms = [];
  for (const m of all) {
    if (m.status === 'resigned' || m.status === 'removed') continue;
    const pre = { ...preBatch.get(String(m.user_id)), points: balances.get(String(m.user_id)) || 0 };
    dms.push({ user: m.user_id, report: { ...reports.individual(m, windowDays, pre), skipPromotionEvaluation: true } });
  }

  // ===== الخاملون =====
  const idle = all.filter(m => !EXEMPT.includes(m.status) && m.status !== 'probation'
    && !onLeave.has(String(m.user_id)) && hoursSince(m.last_activity || m.joined_at) >= ABSENCE.idleDays * 24);

  return { below, boards, dms, idle, windowDays };
}

async function weeklyReport(client) {
  const week = today();
  const { below, boards, dms, idle, windowDays } = weeklyReportData();

  // ===== الترتيب بالنقاط (العصر الحالي) =====
  const embeds = [embed(`📆 التقرير الأسبوعي — ${kit.tsDate(week)}`, `الترتيب على نقاط الترقية (الحقبة الحالية) — **${windowDays}** يوماً للنافذة المرجعية.`, COLORS.primary)];
  for (const t of ['support', 'moderation']) {
    const lb = boards[t];
    // حفظ التقرير الأسبوعي بالنقاط
    reports.save('weekly', `${week}:${t}`, lb.map(r => ({ user: r.user_id, points: r.total, rank: r.rank, team: r.team, status: r.status })));
    embeds.push(reportCmds.leaderboardEmbed(lb, `🏆 ترتيب ${t === 'support' ? 'فريق الدعم الفني' : 'فريق الإشراف'} (الحقبة الحالية)`, windowDays));
  }
  await sendToChannel(client, 'performance-reports', { embeds });

  // ===== فحص عدالة الحمل: تنبيه الإدارة فقط، بلا خصم أو عقوبة تلقائية =====
  const fairnessWarnings = [];
  for (const t of ['support', 'moderation']) {
    const teamLoad = load.teamLoad(t, 7);
    const fairness = load.fairness(teamLoad);
    if (fairness.imbalance >= 2 || fairness.idle.length) {
      fairnessWarnings.push(`${t === 'support' ? 'الدعم الفني' : 'الإشراف'}: ${fairness.busiest ? `<@${fairness.busiest}> يحمل أعلى عبء` : 'لا يوجد'}${fairness.idle.length ? ` • بلا عمل: ${fairness.idle.map(id => `<@${id}>`).join(' ')}` : ''}`);
    }
  }
  if (fairnessWarnings.length) {
    await sendToChannel(client, 'staff-alerts', { embeds: [embed('⚖️ فحص عدالة الحمل الأسبوعي', `${fairnessWarnings.join('\n')}\n\nراجعوا **/team-load** قبل توزيع المناوبات أو المهام.`, COLORS.warning)] });
  }

  // ===== قائمة مراجعة بشرية بدل الخصم — تستخدم النقاط كمؤشر أسبوعي =====
  if (below.length) {
    const lines = below.slice(0, 15)
      .map(r => `• <@${r.user}> — ${r.rank} • pointsEarned: ${r.pointsEarned} نقاط مكتسبة هذا الأسبوع`);
    await sendToChannel(client, 'staff-alerts', {
      embeds: [embed('🔎 للمراجعة البشرية — أداء أسبوعي منخفض',
        `${lines.join('\n')}${below.length > 15 ? `\n_… و${below.length - 15} آخرين_` : ''}\n\n_لا يُخصم شيء تلقائياً. راجعوا الحالة واتخذوا قراراً موثقاً (إنذار/مهمة متابعة/تدريب)._`,
        COLORS.warning)],
    });
  }

  // ===== تقارير فردية بالخاص — تستخدم النقاط للمقارنة الأسبوعية =====
  for (const d of dms) {
    await dm(client, d.user, { embeds: [reportCmds.performanceEmbed(d.report)] });
  }

  if (idle.length) await sendToChannel(client, 'staff-alerts', { embeds: [embed('💤 إداريون خاملون (7 أيام+)', idle.map(m => `<@${m.user_id}> — ${m.rank}`).join('\n'), COLORS.danger)] });
}

async function monthlyReport(client) {
  const period = today().slice(0, 7);
  const prevPeriod = clock.previousMonth(period);
  const monthStart = `${period}-01`;
  const nextMonth = clock.nextMonth(period);
  const monthEnd = addDays(`${nextMonth}-01`, -1);
  const db = getDb();
  const onLeave = activeLeaveUsers();
  const embeds = [];

  for (const t of ['support', 'moderation']) {
    // استخدام points.leaderboard للنقاط الإجمالية في العصر الحالي
    const rows = points.leaderboard({ team: t, limit: 20 });
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.total, 0) / rows.length) : 0;
    const prev = reports.lastSaved('monthly', `${prevPeriod}:${t}`);
    const diff = prev ? avg - prev.avg : null;

    // حفظ التقرير الشهري بالنقاط
    reports.save('monthly', `${period}:${t}`, { avg, members: rows.map(r => ({ user: r.user_id, points: r.total, rank: r.rank, team: r.team, status: r.status })) });

    // الأفضل في الشهر: أعلى رصيد نقاط في الشهر الحالي مع حد أدنى 20 يوم نشاط
    // (هذه المنح يحدث في monthlyBest job، هنا نقرأ فقط)
    const best = rows.length ? rows[0] : null;

    embeds.push(embed(`🗓️ التقرير الشهري — ${t === 'support' ? 'الدعم الفني' : 'الإشراف'} (${period})`,
       `متوسط النقاط: **${avg}**${diff != null ? ` (${diff >= 0 ? '📈 +' : '📉 '}${diff} عن الشهر الماضي)` : ''}\n🏅 أفضل إداري: ${best ? `<@${best.user_id}> (${best.total} pts)` : '—'}\n` +
       `🏅 أفضل إداري (مكافأة): ${best ? `<@${best.user_id}> (+50 best_month)` : '—'}`, COLORS.primary));
  }
  const res = db.prepare(`SELECT reason, reason_category FROM resignations WHERE status = 'accepted' AND reviewed_at >= datetime('now', '-30 days')`).all();
  if (res.length) {
    const byCat = {};
    for (const r of res) { const k = r.reason_category || 'other'; (byCat[k] ||= []).push(r.reason); }
    const lines = Object.entries(byCat).map(([k, arr]) => {
      const info = require('./constants').RESIGNATION_REASONS[k] || { label: k, emoji: '📝' };
      return `${info.emoji} **${info.label}**: ${arr.length}`;
    });
    embeds.push(embed('📤 تحليل الاستقالات (30 يوم)', lines.join('\n') + '\n\n' + res.slice(0, 3).map((r, k) => `${k + 1}. ${String(r.reason).slice(0, 120)}`).join('\n'), COLORS.gray));
  }
  await sendToChannel(client, 'performance-reports', { embeds });
}

// ===== نقاط الصيانة: مهام يومية/أسبوعية/شهرية لنظام النقاط =====

/**
 * الحضور اليومي: يمنح +1 daily_active لكل إداري نشط اليوم.
 *
 * "نشط" = لديه سجل في activity_logs لليوم الحالي (أي قناة غير general).
 * لا يمنح لمن في إجازة أو حالة مستثناة.
 * المرجع اليومي (refType='day', refId=YYYY-MM-DD) يمنع التكرار عند إعادة التشغيل.
 */
async function dailyPresence(client) {
  const t = addDays(today(), -1);
  const db = getDb();
  const onLeave = activeLeaveUsers();

  // أعضاء لديهم نشاط اليوم في قنوات العمل (ليس general)
  const activeIds = db.prepare(`
    SELECT DISTINCT user_id FROM activity_logs
    WHERE day = ? AND channel_type != 'general'
  `).all(t).map(r => String(r.user_id));

  let granted = 0;
  for (const userId of activeIds) {
    const m = staffService.get(userId);
    if (!m) continue;
    if (EXEMPT.includes(m.status)) continue;
    if (onLeave.has(userId)) continue;

    const r = points.add({ userId, reasonKey: 'daily_active', refType: 'day', refId: t, addedBy: 'auto' });
    if (r.ok) granted++;
  }
  logger.info(`☀️ حضور يومي: مُنح لـ ${granted} إداري (${t}).`);
}

/**
 * نجم الأسبوع: يختار أفضل إداري دعم/إشراف (باستثناء الإجازة والتجربة) ويمنح +10 star_week.
 *
 * المعايير: أعلى رصيد نقاط في العصر الحالي خلال الأيام الـ 7 الماضية.
 * لا يُمنح لمن فاز بالأسبوع الماضي (عدم فوز متتالي).
 * يعمل يوم الجمعة (0 10 * * 5) قبل التقرير الأسبوعي.
 */
async function weeklyStar(client) {
  const db = getDb();
  const weekStart = addDays(today(), -6);
  const weekEnd = today();
  const onLeave = activeLeaveUsers();

  const candidates = [];
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    if (m.status === 'probation') continue;
    if (onLeave.has(String(m.user_id))) continue;

    // رصيد النقاط في الـ 7 أيام الماضية للعصر الحالي
    const { start, endExclusive } = clock.dayWindow(weekStart, weekEnd) || {};
    if (!start) continue;
    const sum = db.prepare(`
      SELECT COALESCE(SUM(points), 0) total FROM promotion_points
      WHERE user_id = ? AND rank_epoch = ? AND created_at >= ? AND created_at < ?
    `).get(m.user_id, m.rank_epoch ?? 0, start, endExclusive).total;

    if (Number(sum) > 0) {
      candidates.push({ userId: m.user_id, team: m.team, points: Number(sum), rank: m.rank });
    }
  }

  if (!candidates.length) {
    logger.info('⭐ نجم الأسبوع: لا يوجد مرشحون.');
    return;
  }

  // أفضل لكل فريق
  const byTeam = { support: [], moderation: [] };
  for (const c of candidates) {
    if (byTeam[c.team]) byTeam[c.team].push(c);
  }

  let granted = 0;
  for (const team of ['support', 'moderation']) {
    const teamCandidates = byTeam[team].sort((a, b) => b.points - a.points);
    if (!teamCandidates.length) continue;

    const winner = teamCandidates[0];

    // تحقق من عدم الفوز المتتالي: هل فاز بالأسبوع الماضي؟
    const lastWeekStart = addDays(weekStart, -7);
    const lastWeekEnd = addDays(weekStart, -1);
    const { start: ls, endExclusive: le } = clock.dayWindow(lastWeekStart, lastWeekEnd) || {};
    let consecutive = false;
    if (ls) {
      const lastWin = db.prepare(`
        SELECT 1 FROM promotion_points
        WHERE user_id = ? AND reason_key = 'star_week' AND created_at >= ? AND created_at < ?
        LIMIT 1
      `).get(winner.userId, ls, le);
      consecutive = !!lastWin;
    }

    if (consecutive && teamCandidates.length > 1) {
      // انتقل للمركز الثاني
      const runnerUp = teamCandidates[1];
      const r = points.add({ userId: runnerUp.userId, reasonKey: 'star_week', refType: 'week', refId: weekStart, addedBy: 'auto' });
      if (r.ok) {
        granted++;
        logger.info(`⭐ نجم الأسبوع (${team}): <@${runnerUp.userId}> (${runnerUp.points} نقطة) — الفائز السابق مُستثنى.`);
        await dm(client, runnerUp.userId, { embeds: [embed('⭐ نجم الأسبوع!', `تهانينا! فزت بلقب **نجم الأسبوع** في فريق ${team === 'support' ? 'الدعم الفني' : 'الإشراف'} وحصلت على **+10 نقاط**.`, COLORS.success)] });
      }
    } else {
      const r = points.add({ userId: winner.userId, reasonKey: 'star_week', refType: 'week', refId: weekStart, addedBy: 'auto' });
      if (r.ok) {
        granted++;
        logger.info(`⭐ نجم الأسبوع (${team}): <@${winner.userId}> (${winner.points} نقطة).`);
        await dm(client, winner.userId, { embeds: [embed('⭐ نجم الأسبوع!', `تهانينا! فزت بلقب **نجم الأسبوع** في فريق ${team === 'support' ? 'الدعم الفني' : 'الإشراف'} وحصلت على **+10 نقاط**.`, COLORS.success)] });
      }
    }
  }
  logger.info(`⭐ نجم الأسبوع: مُنح لـ ${granted} فائز.`);
}

/**
 * الأفضل في الشهر: يختار أفضل إداري (دعم/إشراف) ويمنح +50 best_month.
 *
 * الشروط:
 *  - الحد الأدنى 20 يوم نشاط في الشهر (activity_logs أياماً مميزة)
 *  - لا فوز متتaill (لم يفز بالشهر الماضي)
 *  - ليس في إجازة/تجربة/حالة مستثناة
 * يعمل أول كل شهر (0 11 1 * *) قبل التقرير الشهري.
 */
async function monthlyBest(client) {
  const currentMonth = today().slice(0, 7);
  const period = clock.previousMonth(currentMonth);
  const monthStart = `${period}-01`;
  const monthEnd = addDays(`${currentMonth}-01`, -1);
  const db = getDb();
  const onLeave = activeLeaveUsers();

  const candidates = [];
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    if (m.status === 'probation') continue;
    if (onLeave.has(String(m.user_id))) continue;

    // عدد أيام النشاط المميزة في الشهر (قنوات العمل فقط)
    const activeDays = db.prepare(`
      SELECT COUNT(DISTINCT day) d FROM activity_logs
      WHERE user_id = ? AND day >= ? AND day <= ? AND channel_type != 'general'
    `).get(m.user_id, monthStart, monthEnd).d;

    if (activeDays < 20) continue; // حد أدنى 20 يوم

    // رصيد النقاط في الشهر للعصر الحالي
    const { start, endExclusive } = clock.dayWindow(monthStart, monthEnd) || {};
    if (!start) continue;
    const sum = db.prepare(`
      SELECT COALESCE(SUM(points), 0) total FROM promotion_points
      WHERE user_id = ? AND rank_epoch = ? AND created_at >= ? AND created_at < ?
    `).get(m.user_id, m.rank_epoch ?? 0, start, endExclusive).total;

    if (Number(sum) > 0) {
      candidates.push({ userId: m.user_id, team: m.team, points: Number(sum), rank: m.rank, activeDays });
    }
  }

  if (!candidates.length) {
    logger.info('🏅 الأفضل في الشهر: لا يوجد مرشحون (الحد الأدنى 20 يوم نشاط).');
    return;
  }

  // أفضل لكل فريق
  const byTeam = { support: [], moderation: [] };
  for (const c of candidates) {
    if (byTeam[c.team]) byTeam[c.team].push(c);
  }

  let granted = 0;
  for (const team of ['support', 'moderation']) {
    const teamCandidates = byTeam[team].sort((a, b) => b.points - a.points);
    if (!teamCandidates.length) continue;

    const winner = teamCandidates[0];

    // تحقق من عدم الفوز المتتالي: هل فاز بالشهر الماضي؟
    const prevMonth = addDays(monthStart, -1).slice(0, 7);
    const prevMonthStart = `${prevMonth}-01`;
    const prevMonthEnd = addDays(monthStart, -1);
    const { start: ps, endExclusive: pe } = clock.dayWindow(prevMonthStart, prevMonthEnd) || {};
    let consecutive = false;
    if (ps) {
      const lastWin = db.prepare(`
        SELECT 1 FROM promotion_points
        WHERE user_id = ? AND reason_key = 'best_month' AND created_at >= ? AND created_at < ?
        LIMIT 1
      `).get(winner.userId, ps, pe);
      consecutive = !!lastWin;
    }

    if (consecutive && teamCandidates.length > 1) {
      const runnerUp = teamCandidates[1];
      const r = points.add({ userId: runnerUp.userId, reasonKey: 'best_month', refType: 'month', refId: monthStart, addedBy: 'auto' });
      if (r.ok) {
        granted++;
        logger.info(`🏅 الأفضل في الشهر (${team}): <@${runnerUp.userId}> (${runnerUp.points} نقطة، ${runnerUp.activeDays} يوم نشاط) — الفائز السابق مُستثنى.`);
        await dm(client, runnerUp.userId, { embeds: [embed('🏅 الأفضل في الشهر!', `تهانينا! فزت بلقب **الأفضل في الشهر** في فريق ${team === 'support' ? 'الدعم الفني' : 'الإشراف'} وحصلت على **+50 نقاط**.`, COLORS.success)] });
      }
    } else {
      const r = points.add({ userId: winner.userId, reasonKey: 'best_month', refType: 'month', refId: monthStart, addedBy: 'auto' });
      if (r.ok) {
        granted++;
        logger.info(`🏅 الأفضل في الشهر (${team}): <@${winner.userId}> (${winner.points} نقطة، ${winner.activeDays} يوم نشاط).`);
        await dm(client, winner.userId, { embeds: [embed('🏅 الأفضل في الشهر!', `تهانينا! فزت بلقب **الأفضل في الشهر** في فريق ${team === 'support' ? 'الدعم الفني' : 'الإشراف'} وحصلت على **+50 نقاط**.`, COLORS.success)] });
      }
    }
  }
  logger.info(`🏅 الأفضل في الشهر: مُنح لـ ${granted} فائز.`);
}

/**
 * عقوبة الغياب: يطبق -50 absence_10d لكل إداري غاب 10 أيام متتالية بلا إجازة.
 *
 * يتحقق من: لا نشاط في activity_logs لآخر 10 أيام، ولا إجازة نشطة، وليس مستثنى.
 * إمضاء الفترة (قرار المالك D9): refId = آخر يوم نشاط للعضو (أو تاريخ دخوله)
 * — صف واحد لكل فترة غياب مهما طالت، لا خصمًا يومياً؛ التكرار على نفس
 * الإمضاء يرفضه الفهرس الفريد على (user_id, reason_key, ref_type, ref_id).
 */
async function absencePenalty(client) {
  const t = today();
  const tenDaysAgo = addDays(t, -10);
  const db = getDb();
  const onLeave = activeLeaveUsers();

  let applied = 0;
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    if (m.status === 'probation' && m.probation_exempt) continue;
    if (onLeave.has(String(m.user_id))) continue;

    // هل لديه نشاط في آخر 10 أيام؟
    const recentActivity = db.prepare(`
      SELECT 1 FROM activity_logs
      WHERE user_id = ? AND day >= ? AND day <= ? LIMIT 1
    `).get(m.user_id, tenDaysAgo, t);

    if (recentActivity) continue; // لديه نشاط حديث

    // هل لديه إجازة نشطة في الفترة؟
    const hasLeave = db.prepare(`
      SELECT 1 FROM leave_requests
      WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ?
      LIMIT 1
    `).get(m.user_id, t, tenDaysAgo);
    if (hasLeave) continue;

    // ===== مرجع الفترة (قرار المالك D9): مرة واحدة لكل فترة غياب =====
    // آخر يوم نشاط حقيقي هو إمضاء بداية الفترة؛ العضو بلا أي نشاط قط
    // تُعتمد تاريخ دخوله إمضاءاً. كان المرجع «تاريخ اليوم» فما إن ينقلب
    // اليوم حتى يكون refId جديداً فتنطبق -50 مجدداً — خصم يومي متسلسل
    // تحت تعليق «مرة واحدة لكل فترة». الإمضاء الثابت يجعل الفترة صفّاً
    // واحداً مهما طالت: التكرار على نفس الإمضاء يصطدم بالفهرس الفريد.
    // والمصدر هو العمود الدائم staff_members.last_activity لا MAX(day) من
    // activity_logs: العمود يُدَّت مع كل رسالة إداري على التوازي مع سجل
    // النشاط (touchActivity قبل activity.record) وهو خارج نطاق تقليم
    // activity_logs (pruneActivity) — الجدول المقلَّم كان يذيب هويّة الفترة
    // بمرور أشهر فيغيّر إمضاء فترة قُضي فيها سلفاً فتُخصم مرة أخرى.
    const anchor = String(m.last_activity || '').slice(0, 10)
      || String(m.joined_at || '').slice(0, 10)
      || String(m.rank_since || '').slice(0, 10)
      || tenDaysAgo;

    // هل سبق تطبيق العقوبة لهذه الفترة؟ (refId = إمضاء الفترة لا تاريخ اليوم)
    const already = db.prepare(`
      SELECT 1 FROM promotion_points
      WHERE user_id = ? AND reason_key = 'absence_10d' AND ref_type = 'absence' AND ref_id = ?
      LIMIT 1
    `).get(m.user_id, anchor);
    if (already) continue;

    const r = points.add({ userId: m.user_id, reasonKey: 'absence_10d', refType: 'absence', refId: anchor, addedBy: 'auto' });
    if (r.ok) {
      applied++;
      logger.warn(`📉 عقوبة غياب: <@${m.user_id}> (${m.rank}) — 10 أيام بلا نشاط ولا إجازة.`);
      await dm(client, m.user_id, { embeds: [embed('📉 عقوبة غياب', `لم يُرصد أي نشاط منك منذ **10 أيام** ولم تقدم طلب إجازة. تم خصم **50 نقطة** من رصيدك.`, COLORS.danger)] });
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('📉 عقوبة غياب', `<@${m.user_id}> (${m.rank}) — 10 أيام بلا نشاط ولا إجازة. تم خصم 50 نقطة.`, COLORS.danger)] });
    }
  }
  if (applied) logger.info(`📉 عقوبة الغياب: طُبقت على ${applied} إداري.`);
}

/**
 * تنظيف تجميد النقاط المنتهي: يزيل صفوف point_freezes التي انتهت مدتها.
 *
 * يعمل يومياً لضمان أن isFrozen() لا تعيد نتائج قديمة.
 * ملاحظة: isFrozen() تتحقق من انتهاء الصلاحية وتعيد {frozen:false, expired:true}،
 * لكن التنظيف الدوري يبقي الجدول نظيفاً.
 */
async function freezeCleanup(client) {
  const db = getDb();
  const result = db.prepare(`DELETE FROM point_freezes WHERE until <= ?`).run(clock.nowIso());
  if (result.changes > 0) {
    logger.info(`🧹 تنظيف التجميد: أُزيل ${result.changes} تجميد منتهي.`);
  }
}

// ===== ترويض طلبات الترقية المعلّقة (موجة نقاط 2026-10-24) =====

// المهلتان كنّصّين عمداً: القيمة تُستوفى في SQL (datetime('now', '-N days'))
// فتبقى مصدر حقيقة واحداً، وحارس المخطط يقدر على حل الاستيفاء لأنه نص حرفي.
const PROMO_PENDING_MAX_DAYS = '30';
const PROMO_REMINDER_DAYS = '7';

/**
 * أعمار طلبات الترقية: أقدم من المهلة يُسقط آلياً، وأقدم من التذكير يُنقّر.
 *
 * الرفض الآلي بعد 30 يوماً ليس حكماً على الأداء — إنه تنظيف معلّقٍ بلا راعٍ:
 * سببه مكتوب، والعضو يُخبر بذلك وبحقّه في إعادة التقديم فوراً. والتذكير
 * (7+) لقناة الإدارة كلها: الطلب قد يعلق صمتاً أسابيع لأنه بلا من ينادي.
 * والمستقيل ومن خرج من السيرفر حالة مختلفة: عضويتهما منتهية — يُسقط
 * طلبُهما فوراً بذات الأثر الموثَّق، ولا يدخلهما التذكير؛ أما إجازة
 * وتعليق فقط فيبقى طلبُهما على المسار القياسي (عذران مؤقتان لا نهايةُ عضوية).
 */
async function processPromotionPending(client) {
  const db = getDb();
  // فلتر حالة العضو (وسيط ⑧): المستقيل ومن خرج من السيرفر عضويتهما منتهية،
  // فلا أحد سيقرر طلبهما مهما طال الانتظار — يُسقط طلبُهما فوراً بذات
  // السقوط الآلي (سبب مكتوب وتوقيع نظامي وإخبار صادق) بدل أن يعلّق حتى
  // المهلة ويعوّل قناةَ الإدارة تذكيراً بقرارات مستحيلة. أما الإجازة
  // والتعليق فعذران مؤقتان لا إنهاء عضوية — تبقى على المهلتين كما هما.
  const expired = db.prepare(`SELECT pr.id, pr.user_id, pr.from_rank, pr.to_rank, st.status AS member_status
    FROM promotion_requests pr LEFT JOIN staff_members st ON st.user_id = pr.user_id
    WHERE pr.status = 'pending'
      AND (pr.created_at <= datetime('now', '-${PROMO_PENDING_MAX_DAYS} days')
        OR st.status IN ('resigned', 'removed'))`).all();
  for (const r of expired) {
    const gone = r.member_status === 'resigned' || r.member_status === 'removed';
    const reason = gone
      ? `أُغلق آلياً لانتهاء صاحب الطلب بالفريق (حالة: ${r.member_status === 'resigned' ? 'مستقيل' : 'خرج من السيرفر'}) — رفض بلا محاكمة، وإن عاد فحقّه في إعادة التقديم قائم`
      : `انقضت مهلة القرار (${PROMO_PENDING_MAX_DAYS} يوماً بلا موافقة) — رفض آلي بلا محاكمة، يحق لك إعادة التقديم`;
    promoService.review(r.id, 'rejected', 'system', reason);
    audit.record({ action: 'promotion_request_expired', actorId: 'system', targetId: r.user_id, details: { requestId: r.id, fromRank: r.from_rank, toRank: r.to_rank, memberStatus: r.member_status || null } });
    await dm(client, r.user_id, { embeds: [embed(gone ? '📦 أُغلق طلب الترقية لانتهاء الصلة بالفريق' : '⏱️ أُغلق طلب الترقية آلياً',
      gone
        ? `طلبك **#${r.id}** (${r.from_rank} → ${r.to_rank}) أُغلق آلياً لانتهاء صلتك بالفريق.\nلو عدت للعمل لاحقاً يمكنك التقديم مجدداً بالأمر \`/request-promotion\`.`
        : `طلبك **#${r.id}** (${r.from_rank} → ${r.to_rank}) لم يُقرَّر خلال **${PROMO_PENDING_MAX_DAYS} يوماً** فأُغلق آلياً.\nيمكنك تقديم طلب جديد متى اكتملت شروطك بالأمر \`/request-promotion\`.`,
      COLORS.warning)] });
    logger.info(`⏱️ طلب ترقية #${r.id} أُسقط آلياً (${gone ? 'صاحبه منتهي الصلة' : 'انتهاء المهلة'}).`);
  }
  const waiting = db.prepare(`SELECT pr.id, pr.user_id, pr.to_rank FROM promotion_requests pr
    LEFT JOIN staff_members st ON st.user_id = pr.user_id
    WHERE pr.status = 'pending' AND pr.created_at <= datetime('now', '-${PROMO_REMINDER_DAYS} days')
      AND (st.status IS NULL OR st.status NOT IN ('resigned', 'removed'))`).all();
  if (waiting.length) {
    const lines = [`⏳ **${waiting.length}** طلب ترقية بانتظار القرار منذ ${PROMO_REMINDER_DAYS} يوماً فأكثر:`,
      ...waiting.slice(0, 10).map(r => `• #${r.id} <@${r.user_id}> → ${r.to_rank}`)];
    await sendToChannel(client, 'manager-review', { embeds: [embed('⏳ تذكير بطلبات ترقية معلّقة', lines.join('\n'), COLORS.warning)] });
    logger.info(`⏳ تذكير طلبات الترقية: ${waiting.length} طلب معلق.`);
  }
}

/**
 * حالة نافذة العتبات الانتقالية (D7) — نقية للاختبار.
 * @returns {{started: boolean, day: number|null}}
 */
function pointsEpochState(today = clock.today()) {
  const started = settings.policy('points_epoch_started_at', null);
  if (started == null) return { started: false, day: null };
  return { started: true, day: Math.max(0, clock.daysBetween(String(started), String(today))) };
}

/**
 * راية اكتمال النافذة الانتقالية: في يوم الستين بالضبط تُعلن في staff-alerts
 * أن العتبات عادت كاملة. الانعكاس التلقائي هادئ بلا مهمة مجدولة، والعضو الذي
 * كان يرى «عتبة انتقالية» في بطاقة ترقية قد يسأل لماذا ارتفعت فجأة.
 */
async function pointsEpochFlag(client) {
  const st = pointsEpochState();
  if (!st.started || st.day !== POINTS_TRANSITION_DAYS) return;
  await sendToChannel(client, 'staff-alerts', { embeds: [embed('🏁 اكتملت النافذة الانتقالية للنقاط',
    `اليوم **${clock.today()}** يكتمل **${POINTS_TRANSITION_DAYS} يوماً** على انطلاقة نظام النقاط.\nالعتبات هي الآن **كاملة** بقيمها النهائية (200/500/900/… حسب الرتبة) — ما كنت تعرضه من عتبات مخفّضة ارتدّ تلقائياً.`,
    COLORS.info)] });
  logger.info('🏁 النافذة الانتقالية للنقاط اكتملت — العتبات كاملة من التاريخ.');
}

/**
 * حارس لكل مهمة: يمنع تشغيل نسختين متزامنتين (مهمة غياب طويلة قد تتجاوز 30
 * دقيقة فتتراكب)، ويحفظ آخر تشغيل في جدول job_runs ليظهر في /status.
 */
const running = new Set();
const tasks = [];
const scheduledTasks = [];
const lastRun = new Map();
let schedulerStarted = false;
/** مقبض مؤقّت التشغيل الأولي — بلا تتبّع كان يُطلَق مرتين عند stop ثم start. */
let bootstrapTimer = null;

/** قائمة المهام المعروضة في /status */
const JOBS = [];

/**
 * المهام المجدولة المرتبطة بمفتاح تبديل من services/settings.
 * التبديل يُقرأ عند كل دورة لا عند الإقلاع: فـ `/config disable` يسري فوراً
 * بلا إعادة تشغيل، وهذا ما وعدت به واجهة /config («التغييرات تؤثر فوراً»).
 * هذه المهام كانت معروضة في /config كأنها تُوقَف بينما لم يقرأها شيء —
 * أي أن المشغّل كان يُقال له «معطل» والمهمة تستمر.
 */
const JOB_TOGGLES = {
  backup: 'autoBackups',
  'weekly-report': 'weeklyReports',
  'monthly-report': 'monthlyReports',
};

/**
 * هل تُعمل هذه المهمة في هذه الدورة؟ تقرأ المفتاح الآن (لا عند الإقلاع)
 * فتسري حالة /config فوراً. مهمّة بلا مفتاح تبقى مشغّلة دائماً.
 * @param {string} name اسم المهمة كما في قائمة jobs
 */
function jobEnabled(name) {
  const key = JOB_TOGGLES[name];
  return key ? settings.featureToggle(key) !== false : true;
}

function guarded(name, fn) {
  const wrapped = async () => {
    if (!jobEnabled(name)) {
      // لا نسجّل دورة في job_runs: سجلّ هنا كان سيُظهر المهمة في /status كأنها نجحت.
      logger.info(`⏭️ تخطّي "${name}" — الميزة "${JOB_TOGGLES[name]}" معطّلة عبر /config.`);
      return;
    }
    if (running.has(name)) {
      logger.warn(`المهمة "${name}" ما زالت تعمل — تم تخطي هذه الدورة.`);
      return;
    }
    running.add(name);
    const startedAt = new Date().toISOString();
    try {
      await fn();
      recordRun(name, startedAt, null);
    } catch (e) {
      logger.error(`فشل المهمة "${name}":`, e);
      recordRun(name, startedAt, e.message);
    } finally {
      running.delete(name);
      lastRun.set(name, Date.now());
    }
  };
  tasks.push({ name, run: wrapped });
  return wrapped;
}

function recordRun(name, startedAt, error) {
  try {
    getDb().prepare(`INSERT INTO job_runs (job, started_at, finished_at, ok, error) VALUES (?, ?, ?, ?, ?)`)
      .run(name, startedAt, new Date().toISOString(), error ? 0 : 1, error || null);
    // نحتفظ بآخر 50 تشغيلاً لكل مهمة
    getDb().prepare(`DELETE FROM job_runs WHERE job = ? AND id NOT IN (SELECT id FROM job_runs WHERE job = ? ORDER BY id DESC LIMIT 50)`).run(name, name);
  } catch (e) { logger.warn(`تعذّر تسجيل تشغيل المهمة ${name}: ${e.message}`); }
}

/** اسم المهمة الوهمية التي تحمل أعطال المخطط في status()/healthz. */
const SCHEMA_FAULT_JOB = 'db-schema';

/**
 * آخر تشغيل ناجح/فاشل لكل مهمة + أعطال المخطط الحيّة — **جملة واحدة**.
 *
 * كان `GROUP BY job` ثم `SELECT * FROM job_runs WHERE id = ?` لكل مهمة: أحد
 * عشر استعلاماً على مسار /healthz، يُعاد في كل scrape، ومقابل استعلام واحد.
 * `id IN (SELECT MAX(id) … GROUP BY job)` هي نفس النتيجة بجملة واحدة، وUNION
 * ALL يضيف أعطال المخطط دون أن يصير استعلاماً ثانياً.
 *
 * لماذا أعطال المخطط هنا: health.js يقرأ status() ويقلب الحالة إلى degraded
 * حين يجد ok=false. وأعطال المخطط حالةٌ لازمة يجب أن تُقال على مسار الصحة —
 * وإلا صار «البوت أقلع ناقصاً» أمراً لا يعرفه أحد. بلا أمر جديد ولا إعادة
 * تشغيل: نفس الجملة، نفس المسار.
 */
const STATUS_SQL = `SELECT job, finished_at, ok, error FROM job_runs
    WHERE id IN (SELECT MAX(id) FROM job_runs GROUP BY job)
  UNION ALL
  SELECT '${SCHEMA_FAULT_JOB}', detected_at, 0, step || ': ' || detail FROM schema_faults
  ORDER BY 1`;

function status() {
  const last = {};
  for (const row of getDb().prepare(STATUS_SQL).all()) {
    last[row.job] = { finishedAt: row.finished_at, ok: !!row.ok, error: row.error };
  }
  return last;
}

function clearRunningTasks() {
  running.clear();
}

/**
 * التشغيل الأولي بعد الإقلاع.
 *
 * يمرّ بحارس المهام نفسه (`guarded`) وبأسماء المهام نفسها التي تستخدمها cron،
 * فذلك يُصلح أربعة عيوب دفعة واحدة في الكود القديم الذي كان ينادي الدوال
 * الخام داخل `setTimeout`:
 *   1) القفل ضد التكرار: إقلاع قبل الثانية 59 يترك التشغيل الأولي وتكّة cron
 *      معاً في flight، فيفحص الغياب مرتين وتُرسل رسالة خاصة مرتين.
 *   2) `try/catch` لكل مهمة مع تسجيلها في `job_runs`: كان أي فشل يبتلعه
 *      المؤقّت صامتاً فلا يظهر في `/system-status` ولا يقلب `/healthz` إلى
 *      degraded — تشغيل أولي معطوب يبقى مجهولاً للمشغّل إلى الأبد.
 *   3) كل مهمة مستقلة: فشل واحدة لا يوقف الباقي (كل `wrapped` تبتلع خطأه).
 *   4) المؤقّت متتبَّع فيُمسح في `stop()` فلا يُطلَق مرتين عند stop/start.
 *
 * لا نشغل التقارير اليومية/الأسبوعية/الشهرية هنا لتفادي تكرارها عند إعادة التشغيل.
 * @returns {Promise<void>} ينتهي بعد اكتمال كل المهام (يستعمله الاختبار).
 */
function bootstrap(client) {
  const jobs = [
    ['absence', () => checkAbsence(client)],
    ['suspensions', () => liftSuspensions(client)],
    ['leaves', () => processLeaves(client)],
    ['resignations', () => processResignations(client)],
    ['task-reminders', () => processTaskReminders(client)],
    ['promotion-pending', () => processPromotionPending(client)],
  ];
  return Promise.all(jobs.map(([name, fn]) => guarded(name, fn)()));
}

function start(client) {
  if (schedulerStarted) {
    logger.warn('المجدول يعمل بالفعل — تم تجاهل طلب تشغيل مكرر.');
    return;
  }
  schedulerStarted = true;
  const tz = clock.TZ;
  const jobs = [
    ['absence', '*/30 * * * *', () => checkAbsence(client)],
    ['suspensions', '0 1 * * *', () => liftSuspensions(client)],
    ['leaves', '5 0 * * *', () => processLeaves(client)],
    ['resignations', '20 0 * * *', () => processResignations(client)],
    ['task-reminders', '0 8 * * *', () => processTaskReminders(client)],
    ['backup', '15 0 * * *', () => backup.createBackup({ reason: 'scheduled' })],
    ['daily-report', '0 9 * * *', () => dailyReport(client)],
    ['weekly-report', '0 10 * * 5', () => weeklyReport(client)],
    ['monthly-report', '0 11 1 * *', () => monthlyReport(client)],
    ['maintenance', '0 3 1 * *', () => retention.run({ dryRun: false })],
    // ===== نقاط الصيانة =====
    ['daily-presence', '5 0 * * *', () => dailyPresence(client)],
    ['weekly-star', '0 9 * * 5', () => weeklyStar(client)],
    ['monthly-best', '0 10 1 * *', () => monthlyBest(client)],
    ['absence-penalty', '0 1 * * *', () => absencePenalty(client)],
    ['freeze-cleanup', '0 2 * * *', () => freezeCleanup(client)],
    // ===== ترويض طلبات الترقية + راية اكتمال النافذة الانتقالية (موجة نقاط) =====
    ['promotion-pending', '40 9 * * *', () => processPromotionPending(client)],
    ['points-epoch-flag', '50 8 * * *', () => pointsEpochFlag(client)],
  ];
  JOBS.length = 0;
  // toggle معلن حتى يعرف /status أن المهمة مربوطة بمفتاح تبديل (أو غير مربوطة).
  JOBS.push(...jobs.map(([name, expr]) => ({ name, expr, tz, toggle: JOB_TOGGLES[name] || null })));
  for (const [name, expr, fn] of jobs) {
    const run = guarded(name, fn);
    const scheduled = cron.schedule(expr, run, { timezone: tz });
    scheduledTasks.push(scheduled);
  }
  // تشغيل أولي خفيف بعد الإقلاع — عبر الحارس لا عبر الدوال الخام (انظر bootstrap).
  bootstrapTimer = setTimeout(() => {
    bootstrapTimer = null;
    bootstrap(client).catch((e) => logger.error('فشل التشغيل الأولي للمجدول:', e));
  }, 10_000);
  const paused = jobs.filter(([name]) => JOB_TOGGLES[name]).filter(([name]) => !jobEnabled(name)).map(([name]) => name);
  if (paused.length) logger.warn(`⏸️ مهام متوقفة عبر /config عند الإقلاع: ${paused.join('، ')}.`);
  logger.info(`⏰ المجدول يعمل (${jobs.length} مهمة • المنطقة الزمنية ${tz}).`);
}

function stop() {
  for (const t of scheduledTasks) { try { t.stop(); } catch { /* ignore */ } }
  scheduledTasks.length = 0;
  // المؤقّت غير المتتبَّع كان يبقى معلّقاً: stop ثم start يعني تشغيلين أوليين.
  if (bootstrapTimer) { clearTimeout(bootstrapTimer); bootstrapTimer = null; }
  schedulerStarted = false;
}

module.exports = {
  start, stop, status, bootstrap, checkAbsence, liftSuspensions, processLeaves,
  processResignations, processTaskReminders, dailyReport, weeklyReport, weeklyReportData, monthlyReport,
  // نقاط الصيانة
  dailyPresence, weeklyStar, monthlyBest, absencePenalty, freezeCleanup,
  // ترويض طلبات الترقية + راية النافذة الانتقالية (موجة نقاط)
  processPromotionPending, pointsEpochFlag, pointsEpochState, PROMO_PENDING_MAX_DAYS, PROMO_REMINDER_DAYS,
  JOBS, JOB_TOGGLES, jobEnabled, clearRunningTasks,
  TASK_REMINDER_MAX_ATTEMPTS, reminderGiveUps, SCHEMA_FAULT_JOB,
};
