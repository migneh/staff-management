'use strict';
const cron = require('node-cron');
const { getDb } = require('./database');
const staffService = require('./services/staff');
const reports = require('./services/reports');
const load = require('./services/load');
const score = require('./services/score');
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
async function checkAbsence(client) {
  for (const m of staffService.all()) {
    if (EXEMPT.includes(m.status)) continue;
    // المجاز لا يُحتسب غيابه
    if (leaveService.activeForUser(m.user_id).length) continue;
    if (m.status === 'probation' && m.probation_exempt) continue;
    const h = hoursSince(m.last_activity || m.joined_at);
    if (h >= ABSENCE.staffAlertHours && m.absence_alert_level < 2) {
      await sendToChannel(client, 'staff-alerts', { embeds: [embed('🚨 غياب 96 ساعة', `<@${m.user_id}> (${m.rank}) بدون نشاط منذ **${Math.floor(h)}** ساعة.`, COLORS.danger)] });
      staffService.update(m.user_id, { absence_alert_level: 2, status: m.status === 'active' ? 'inactive' : m.status });
    } else if (h >= ABSENCE.dmHours && m.absence_alert_level < 1) {
      await dm(client, m.user_id, { embeds: [embed('⏰ تنبيه غياب', `لم نرصد أي نشاط منك منذ **72 ساعة**. إذا كان لديك ظرف، قدّم طلب إجازة عبر \`/request-leave\`.`, COLORS.warning)] });
      staffService.update(m.user_id, { absence_alert_level: 1, status: m.status === 'active' ? 'inactive' : m.status });
    }
  }
}

// ===== الإجازات: تفعيل الرتبة / إنهاء / تذكيرات / مزامنة / انتهاء المعلقة =====
async function guildMember(client, userId) {
  const g = client.guilds?.cache?.get(config.guildId) || [...(client.guilds?.cache?.values?.() || [])][0];
  try { return g?.members?.fetch ? await g.members.fetch(userId) : null; } catch { return null; }
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
      const fresh = db.prepare('SELECT reminders_sent FROM leave_requests WHERE id = ?').get(r.id);
      if (!leaveService.markReminder(r.id, fresh?.reminders_sent, 'escalate')) continue;
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
    if (r.start_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'start')) {
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
        if (!roleResult.ok && leaveService.markReminder(r.id, r.reminders_sent, 'role_retry')) {
          await sendToChannel(client, 'staff-logs', { embeds: [embed('⚠️ تعذر تفعيل رتبة in vacation', `الإجازة **#${r.id}** لـ <@${r.user_id}> — ${roleResult.missing ? 'الرتبة غير مربوطة في /setup' : roleResult.error?.message || 'صلاحيات'}`, COLORS.warning)] });
        }
      }
    }

    if (r.end_date === addDays(t, 1) && leaveService.markReminder(r.id, r.reminders_sent, 'end')) {
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

  // إعادة محاولة إزالة الرتبة إن فشلت سابقاً
  const cleanupUsers = db.prepare(`SELECT DISTINCT user_id FROM leave_requests WHERE status IN ('ended', 'cancelled') AND role_removed_at IS NULL`).all();
  for (const { user_id: userId } of cleanupUsers) {
    const member = await guildMember(client, userId);
    if (!member) continue;
    const roleResult = await leaveService.syncVacationRole(member, t);
    if (roleResult.ok && !leaveService.approvedForUser(userId, { onOrAfter: t }).length) {
      db.prepare("UPDATE leave_requests SET role_removed_at = COALESCE(role_removed_at, datetime('now')) WHERE user_id = ? AND status IN ('ended', 'cancelled') AND role_removed_at IS NULL").run(userId);
    }
  }

  // تنبيه بعد النهاية بـ 24 ساعة إن لم يعد
  const ended = db.prepare(`SELECT * FROM leave_requests WHERE status = 'ended' AND end_date = ?`).all(addDays(t, -1));
  for (const r of ended) {
    if (!leaveService.markReminder(r.id, r.reminders_sent, 'overdue')) continue;
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
      if (info) staffService.recordRankChange(r.user_id, { fromRank: info.rank, toRank: info.rank, team: info.team, changeType: 'remove', reason: `إزالة رتب الاستقالة #${r.id}` });
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
async function processTaskReminders(client) {
  const db = getDb();
  const cutoff = addDays(today(), 1);
  const rows = db.prepare(`SELECT * FROM staff_tasks
    WHERE status = 'pending' AND reminder_sent_at IS NULL AND due_date IS NOT NULL
      AND due_date <= ? AND task_type IN ('onboarding', 'offboarding')
    ORDER BY due_date, id`).all(cutoff);
  for (const task of rows) {
    const overdue = task.due_date < today();
    const sent = await dm(client, task.user_id, { embeds: [embed(overdue ? '⚠️ مهمة متأخرة' : '⏰ تذكير بمهمة',
      `لديك المهمة **#${task.id} — ${task.title}**${overdue ? ' متأخرة عن موعدها' : ` موعدها ${kit.tsDate(task.due_date)}`}.\n\nاستخدم **/my-tasks** لمراجعتها.`, COLORS.warning)] });
    if (sent) db.prepare("UPDATE staff_tasks SET reminder_sent_at = datetime('now'), updated_at = datetime('now') WHERE id = ?").run(task.id);
  }
  return rows.length;
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

async function weeklyReport(client) {
  const all = staffService.all();
  const week = today();

  // ===== نقاط الأسبوع =====
  // سياسة معلنة: لا خصم تراكمي. الأسبوع الضعيف يُراجع بشرياً (قائمة المراجعة أدناه)
  // بدل آخر -10 في الرصيد بلا سقف — وهي الحلقة التي أوصلت الفريق إلى أرقام سالبة.
  const below = [];
  for (const m of all) {
    if (EXEMPT.includes(m.status)) continue;
    if (m.status === 'probation') continue; // عضو جديد لا يُعاقب قبل أن يبدأ
    if (leaveService.activeForUser(m.user_id).length) continue;
    const sc = score.compute(m, score.monthlyRaw(m.user_id, 7, 0)).score; // 7 days, no offset
if (sc >= 80) {
       // Points system removed - week_above_80 award disabled
     }
     else if (sc < 50) below.push({ user: m.user_id, rank: m.rank, score: sc });
  }

  // ===== الترتيب =====
  const windowDays = reportCmds.LEADERBOARD_WINDOW_DAYS;
  const embeds = [embed(`📆 التقرير الأسبوعي — ${kit.tsDate(week)}`, `الترتيب على آخر **${windowDays}** يوماً (نافذة موحّدة لكل تقارير الترتيب).`, COLORS.primary)];
  for (const t of ['support', 'moderation']) {
    const lb = reports.leaderboard(t, windowDays);
    // Points system removed — the weekly snapshot keeps score only.
    reports.save('weekly', `${week}:${t}`, lb.map(r => ({ user: r.staff.user_id, score: r.score })));
    embeds.push(reportCmds.leaderboardEmbed(lb, `🏆 ترتيب ${t === 'support' ? 'فريق الدعم الفني' : 'فريق الإشراف'} (آخر ${windowDays} يوم)`, windowDays));
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

  // ===== قائمة مراجعة بشرية بدل الخصم =====
  if (below.length) {
    const lines = below.sort((a, b) => a.score - b.score).slice(0, 15)
      .map(r => `• <@${r.user}> — ${r.rank} • Score ${r.score}`);
    await sendToChannel(client, 'staff-alerts', {
      embeds: [embed('🔎 للمراجعة البشرية — أداء أسبوعي منخفض',
        `${lines.join('\n')}${below.length > 15 ? `\n_… و${below.length - 15} آخرين_` : ''}\n\n_لا يُخصم شيء تلقائياً. راجعوا الحالة واتخذوا قراراً موثقاً (إنذار/مهمة متابعة/تدريب)._`,
        COLORS.warning)],
    });
  }

  // ===== تقارير فردية بالخاص =====
  for (const m of all) {
    if (m.status === 'resigned' || m.status === 'removed') continue;
    await dm(client, m.user_id, { embeds: [reportCmds.performanceEmbed(reports.individual(m, windowDays))] });
  }

  const idle = all.filter(m => !EXEMPT.includes(m.status) && m.status !== 'probation'
    && !leaveService.activeForUser(m.user_id).length && hoursSince(m.last_activity || m.joined_at) >= ABSENCE.idleDays * 24);
  if (idle.length) await sendToChannel(client, 'staff-alerts', { embeds: [embed('💤 إداريون خاملون (7 أيام+)', idle.map(m => `<@${m.user_id}> — ${m.rank}`).join('\n'), COLORS.danger)] });
}

async function monthlyReport(client) {
  const period = today().slice(0, 7);
  const prevPeriod = addDays(today().slice(0, 7) + '-01', -1).slice(0, 7);
  const embeds = [];
  for (const t of ['support', 'moderation']) {
    const rows = reports.team(t);
    const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 0;
    const prev = reports.lastSaved('monthly', `${prevPeriod}:${t}`);
    const diff = prev ? avg - prev.avg : null;
    reports.save('monthly', `${period}:${t}`, { avg, members: rows.map(r => ({ user: r.staff.user_id, score: r.score })) });
    // استخدم نفس بوابة «أفضل إداري» المعلنة في reports.js، لا مجرد أعلى Score.
    // هذا يمنع منح +50 لعضو بلا عمل فعلي أو لعضو في إجازة/تجربة.
const best = reports.bestOfMonth(rows);
     // Points system removed - best_of_month award disabled
     embeds.push(embed(`🗓️ التقرير الشهري — ${t === 'support' ? 'الدعم الفني' : 'الإشراف'} (${period})`,
       `متوسط Score: **${avg}**${diff != null ? ` (${diff >= 0 ? '📈 +' : '📉 '}${diff} عن الشهر الماضي)` : ''}\n🏅 أفضل إداري: ${best ? `<@${best.staff.user_id}> (${best.score})` : '—'}\n` +
       `🎫/🛡️ الإجمالي: ${rows.reduce((s, r) => s + (t === 'support' ? r.raw.tickets : r.raw.actions), 0)}\n⚠️ إنذارات: ${rows.reduce((s, r) => s + r.warnings.reduce((x, w) => x + w.c, 0), 0)}`, COLORS.primary));
  }
  const db = getDb();
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

/**
 * حارس لكل مهمة: يمنع تشغيل نسختين متزامنتين (مهمة غياب طويلة قد تتجاوز 30
 * دقيقة فتتراكب)، ويحفظ آخر تشغيل في جدول job_runs ليظهر في /status.
 */
const running = new Set();
const tasks = [];
const scheduledTasks = [];
const lastRun = new Map();
let schedulerStarted = false;

/** قائمة المهام المعروضة في /status */
const JOBS = [];

function guarded(name, fn) {
  const wrapped = async () => {
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

/** آخر تشغيل ناجح/فاشل لكل مهمة — يُقرأ من /status */
function status() {
  const rows = getDb().prepare(`SELECT job, MAX(id) id FROM job_runs GROUP BY job`).all();
  const last = {};
  for (const { id } of rows) {
    const row = getDb().prepare('SELECT * FROM job_runs WHERE id = ?').get(id);
    last[row.job] = { finishedAt: row.finished_at, ok: !!row.ok, error: row.error };
  }
  return last;
}

function clearRunningTasks() {
  running.clear();
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
  ];
  JOBS.length = 0;
  JOBS.push(...jobs.map(([name, expr]) => ({ name, expr, tz })));
  for (const [name, expr, fn] of jobs) {
    const run = guarded(name, fn);
    const scheduled = cron.schedule(expr, run, { timezone: tz });
    scheduledTasks.push(scheduled);
  }
  // تشغيل أولي خفيف بعد الإقلاع - فقط المهام التي لا يجب أن تعمل يومياً
  setTimeout(() => {
    checkAbsence(client);
    liftSuspensions(client);
    processLeaves(client);
    processResignations(client);
    processTaskReminders(client);
    // لا نشغل التقارير اليومية/الأسبوعية/الشهرية هنا لتجنب تكرارها عند إعادة التشغيل
  }, 10_000);
  logger.info(`⏰ المجدول يعمل (${jobs.length} مهمة • المنطقة الزمنية ${tz}).`);
}

function stop() {
  for (const t of scheduledTasks) { try { t.stop(); } catch { /* ignore */ } }
  scheduledTasks.length = 0;
  schedulerStarted = false;
}

module.exports = { start, stop, status, checkAbsence, liftSuspensions, processLeaves, processResignations, processTaskReminders, dailyReport, weeklyReport, monthlyReport, JOBS, clearRunningTasks };
