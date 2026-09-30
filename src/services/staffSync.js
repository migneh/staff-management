'use strict';
/**
 * تسجيل الإداريين دفعة واحدة من رتب الديسكورد.
 * بدل انتظار أول رسالة من كل عضو، يقرأ البوت أعضاء السيرفر ويسجّل من يحمل
 * رتبة إدارية فعلاً، ويحدّث رتب من تغيّرت رتبته، ويسجّل من نُزعت رتبه.
 */
const staffService = require('./staff');
const { resolveStaff } = require('./permissions');
const audit = require('./audit');
const settings = require('./settings');
const { TEAMS } = require('../constants');
const { COLORS, arDigits, nowIso } = require('../utils');
const kit = require('../ui/kit');

const MAX_LIST = 15;
const CONCURRENCY = 1; // قراءة الرتب محلية (cache) فلا حاجة لتوازٍ أعلى.

function listLines(items, render) {
  if (!items.length) return null;
  const shown = items.slice(0, MAX_LIST).map(render);
  if (items.length > MAX_LIST) shown.push(`… و${arDigits(items.length - MAX_LIST)} آخرين`);
  return shown.join('\n');
}

/** يبني تقريراً مقروءاً يستعمله الأمر وصفحة /setup وسجل البوت. */
function reportEmbed(report, { title = '🔄 مزامنة الإداريين من رتب الديسكورد' } = {}) {
  const counts = [
    `🆕 سُجّل الآن: **${arDigits(report.registered.length)}**`,
    `♻️ تغيّرت رتبته: **${arDigits(report.updated.length)}**`,
    `🚪 نُزعت رتبه: **${arDigits(report.departures.length)}**`,
    `✅ بلا تغيير: **${arDigits(report.unchanged)}**`,
  ].join(' • ');
  const fields = [];
  const registered = listLines(report.registered, r => `<@${r.id}> — **${r.rank}** (${TEAMS[r.team] || r.team})${r.status === 'probation' ? ' • تجريبي' : ''}`);
  const updated = listLines(report.updated, r => `<@${r.id}> — ${r.from} ← **${r.to}**`);
  const departures = listLines(report.departures, r => `<@${r.id}> — ${r.rank} → **${r.next}**`);
  if (registered) fields.push({ name: '🆕 سُجّلوا الآن', value: registered, inline: false });
  if (updated) fields.push({ name: '♻️ تحديثات الرتب', value: updated, inline: false });
  if (departures) fields.push({ name: '🚪 نُزعت رتبهم', value: departures, inline: false });
  if (!registered && !updated && !departures) fields.push({ name: '✅ لا جديد', value: 'كل الإداريين مسجّلون برتبهم الصحيحة — لا حاجة لأي إجراء.', inline: false });
  const e = kit.card({
    title,
    description: [
      counts,
      `👥 فُحص **${arDigits(report.scanned)}** عضواً • 🤖 تُجوهل **${arDigits(report.bots)}** بوت • 📚 المسجلون حالياً: **${arDigits(report.total)}**`,
    ].join('\n'),
    fields: [
      { name: '📥 إجمالي المسجّلين', value: `**${arDigits(report.total)}**`, inline: true },
      { name: '🔎 الأعضاء المفحوصون', value: `**${arDigits(report.scanned)}**`, inline: true },
      { name: '🤖 البوتات المُتجاهَلة', value: `**${arDigits(report.bots)}**`, inline: true },
      ...fields,
    ],
    color: report.registered.length || report.updated.length ? COLORS.success : COLORS.info,
    footer: kit.footerLine('🔄 المصدر: رتب الديسكورد'),
  });

  return e;
}

/**
 * يزامن كل الأعضاء الذين يحملون رتباً إدارية.
 * @returns {Promise<object>} تقرير بالمُسجّل والمحدَّث والخارجين.
 */
async function syncGuild(guild, { actorId = null, limitMembers = null } = {}) {
  const report = { scanned: 0, bots: 0, registered: [], updated: [], unchanged: 0, departures: [], total: 0 };
  const known = new Map(staffService.all({ includeResigned: true }).map(r => [r.user_id, r]));

  let members;
  try {
    members = await guild.members.fetch();
  } catch (e) {
    report.error = `تعذّر قراءة الأعضاء: ${e.message}`;
    report.total = known.size;
    return report;
  }

  const queue = [...members.values()];
  const run = async (member) => {
    if (member.user?.bot) { report.bots++; return; }
    if (limitMembers && report.scanned >= limitMembers) return;
    report.scanned++;
    const info = resolveStaff(member);
    const previous = known.get(member.id) || null;
    if (!info) {
      if (!previous) return;
      const departure = staffService.syncDeparture(member);
      if (!departure) return;
      report.departures.push({ id: member.id, ...departure });
      audit.record({ action: 'staff_roles_removed', actorId, targetId: member.id, details: departure, source: 'sync' });
      return;
    }
    const saved = staffService.ensure(member);
    if (!saved) return;
    if (saved.isNew) {
      report.registered.push({ id: member.id, rank: saved.rank, team: saved.team, status: saved.status });
      return;
    }
    const changed = !previous
      || previous.rank !== saved.rank || previous.team !== saved.team
      || previous.status !== saved.status || previous.username !== saved.username;
    if (changed) report.updated.push({ id: member.id, from: `${previous?.rank || '—'} (${previous?.status || '—'})`, to: `${saved.rank} (${saved.status})` });
    else report.unchanged++;
  };

  for (let idx = 0; idx < queue.length; idx += CONCURRENCY) {
    await Promise.all(queue.slice(idx, idx + CONCURRENCY).map(run));
  }

  report.total = staffService.all().length;
  settings.setPolicy('staffLastSyncAt', nowIso());
  settings.setPolicy('staffLastSyncBy', actorId || 'auto');
  report.teams = Object.keys(TEAMS).map(team => ({ team, count: staffService.all({ team }).length })).filter(t => t.count);
  audit.record({
    action: 'staff_synced',
    actorId,
    details: { registered: report.registered.length, updated: report.updated.length, departures: report.departures.length, scanned: report.scanned },
  });
  return report;
}

/** ملخص سريع لحالة التسجيل (يُستعمل في /setup). */
function snapshot() {
  const all = staffService.all({ includeResigned: true });
  const active = all.filter(r => r.status === 'active').length;
  const probation = all.filter(r => r.status === 'probation').length;
  const away = all.filter(r => ['on_leave', 'suspended'].includes(r.status)).length;
  const out = all.filter(r => ['resigned', 'removed'].includes(r.status)).length;
  const unknown = all.filter(r => !settings.roleId(r.team, r.rank)).length;
  return { total: all.length, active, probation, away, out, unknown, lastSync: settings.policy('staffLastSyncAt') || null };
}

module.exports = { syncGuild, reportEmbed, snapshot };
