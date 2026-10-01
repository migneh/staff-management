'use strict';
const { getDb } = require('../database');
const { resolveStaff, TEAM_RANKS } = require('./permissions');
const { nowIso, today } = require('../utils');
const settings = require('./settings');
const logger = require('../logger').log('staff');

function get(userId) {
  return getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(userId) || null;
}

function all({ team, includeResigned = false } = {}) {
  let sql = 'SELECT * FROM staff_members WHERE 1=1';
  const params = [];
  if (!includeResigned) sql += " AND status != 'resigned'";
  if (team) { sql += ' AND team = ?'; params.push(team); }
  sql += ' ORDER BY team, rank_since';
  return getDb().prepare(sql).all(...params);
}

/**
 * تسجيل/مزامنة الإداري تلقائياً من رتب الديسكورد.
 * يُستدعى عند أول رسالة أو أي تفاعل.
 */
function ensure(member, { reinstate = false } = {}) {
  const info = resolveStaff(member);
  if (!info) return null;
  const db = getDb();
  const existing = get(member.id);
  // قبول الاستقالة يغيّر الحالة فوراً، وقد تكون إزالة الرتب مؤجلة. لا تُعد
  // رسالة أو تفاعل عابر العضو إلى active؛ إعادة التعيين الصريحة فقط تستعمل
  // reinstate: true (حالياً من manage-general).
  if (existing?.status === 'resigned' && !reinstate) return existing;
  if (!existing) {
    const initialStatus = info.team === 'general_management' ? 'active' : 'probation';
    db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(member.id, member.user?.username || member.displayName, info.team, info.rank, initialStatus, nowIso(), nowIso());
    if (initialStatus === 'probation') {
      try { require('./tasks').ensureOnboarding(member.id); } catch (e) { logger.error('فشل إنشاء مهام التأهيل:', e.message); }
    }
    return { ...get(member.id), isNew: true };
  }
const updates = {};
  const username = member.user?.username || existing.username;
  if (existing.username !== username) updates.username = username;
  if (existing.team !== info.team || existing.rank !== info.rank) {
    updates.team = info.team;
    updates.rank = info.rank;
    updates.rank_since = nowIso();
    // الإدارة العامة لا تدخل فترة تجريبية. تغيير الرتبة داخل الفريقين يعيدها فقط عند العضو الجديد.
    if (existing.status === 'resigned' && reinstate) updates.status = info.team === 'general_management' ? 'active' : 'probation';
  }
  if (existing.status === 'resigned' && reinstate) { updates.status = 'active'; updates.joined_at = nowIso(); updates.rank_since = nowIso(); }
  if (Object.keys(updates).length) {
    const sets = Object.keys(updates).map(k => `${k} = ?`).join(', ');
    db.prepare(`UPDATE staff_members SET ${sets}, updated_at = ? WHERE user_id = ?`).run(...Object.values(updates), nowIso(), member.id);
    return get(member.id);
  }
  return existing;
}

function setStatus(userId, status) {
  getDb().prepare('UPDATE staff_members SET status = ?, updated_at = ? WHERE user_id = ?').run(status, nowIso(), userId);
}

/** إيقاف مؤقت بتاريخ انتهاء — يمنع بقاء العضو موقوفاً للأبد */
function suspend(userId, until) {
  getDb().prepare("UPDATE staff_members SET status = 'suspended', suspended_until = ?, updated_at = ? WHERE user_id = ?")
    .run(until || null, nowIso(), userId);
}

/** إلغاء الإيقاف يدوياً (Boss) */
function unsuspend(userId) {
  getDb().prepare("UPDATE staff_members SET status = CASE WHEN status = 'suspended' THEN 'active' ELSE status END, suspended_until = NULL, updated_at = ? WHERE user_id = ?")
    .run(nowIso(), userId);
}

/** يرفع الإيقاف المنتهي تلقائياً — يعيد قائمة [{user_id, until, rank, team}] لإعلام الفريق */
function liftExpiredSuspensions(date = today()) {
  const rows = getDb().prepare("SELECT user_id, suspended_until, rank, team FROM staff_members WHERE status = 'suspended' AND suspended_until IS NOT NULL AND suspended_until <= ?").all(date);
  const lifted = [];
  for (const r of rows) {
    unsuspend(r.user_id);
    lifted.push({ user_id: r.user_id, until: r.suspended_until, rank: r.rank, team: r.team });
  }
  return lifted;
}

function suspensionEnd(userId) {
  return getDb().prepare('SELECT suspended_until FROM staff_members WHERE user_id = ?').get(userId)?.suspended_until || null;
}

function update(userId, fields) {
  const keys = Object.keys(fields);
  if (!keys.length) return;
  const sets = keys.map(k => `${k} = ?`).join(', ');
  getDb().prepare(`UPDATE staff_members SET ${sets}, updated_at = ? WHERE user_id = ?`).run(...keys.map(k => fields[k]), nowIso(), userId);
}

function touchActivity(userId) {
  getDb().prepare(`UPDATE staff_members SET last_activity = ?, absence_alert_level = 0,
    status = CASE WHEN status = 'inactive' THEN 'active' ELSE status END, updated_at = ? WHERE user_id = ?`)
    .run(nowIso(), nowIso(), userId);
}

const REMOVAL_TYPES = ['remove', 'left_guild'];

/**
 * كتابة سطر واحد في تاريخ الرتب — المصدر الموحّد لكل تغيير رتبة أو عضوية،
 * حتى تعكس المغادرة والإزالة في السجل نفسه الذي تعرضه /staff-record.
 */
function appendRankChange({ userId, team, fromRank, toRank = null, changeType, reason = null, actorId = null }) {
  getDb().prepare(`INSERT INTO staff_rank_history (user_id, team, from_rank, to_rank, change_type, reason, actor_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, team, fromRank, toRank, changeType, reason, actorId);
}

/** تاريخ تغييرات الرتبة — الأحدث أولاً. الأساس الذي تعتمد عليه /staff-record و/my-record. */
function rankHistory(userId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 200);
  return getDb().prepare(`SELECT * FROM staff_rank_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(userId, safeLimit);
}

/** تغيير رتبة العضو مع تحديث الحالة والتاريخ */
function setRank(userId, team, rank, { actorId = null, reason = null, changeType = null } = {}) {
  const before = get(userId);
  const fromRank = before?.rank || null;
  const type = changeType || (before && fromRank !== rank ? (rankIndexOf(team, rank) >= rankIndexOf(before.team, fromRank) ? 'promote' : 'demote') : 'reassign');

  // السجل والتحديث في معاملة واحدة: لا رتبة جديدة بلا سند موثّق، ولا سند بلا تغيّر.
  const db = getDb();
  const applied = db.transaction(() => {
    db.prepare(`UPDATE staff_members SET team = ?, rank = ?, rank_since = ?, status = 'active', updated_at = ? WHERE user_id = ?`)
      .run(team, rank, nowIso(), nowIso(), userId);
    appendRankChange({ userId, team, fromRank, toRank: rank, changeType: type, reason, actorId });
  });
  applied();

  try {
    require('./audit').record({
      action: 'rank_changed', actorId, targetId: userId,
      details: { from: fromRank, to: rank, team, changeType: type, reason },
    });
  } catch { /* لا يُسقط ترقية مسجّلة بسبب فشل التدقيق */ }

  return { fromRank, toRank: rank, changeType: type };
}

/** ترتيب الرتبة داخل الفريق — يحدد إن كان التغيير ترقية أم تنزيلاً */
function rankIndexOf(team, rank) {
  const list = TEAM_RANKS[team] || [];
  const idx = list.findIndex(r => r.name === rank);
  return idx === -1 ? -1 : list.length - idx;
}

/** تعديل رتب الديسكورد فعلياً عند الترقية أو التعيين */
async function applyRankRoles(member, team, newRank) {
  const ranks = TEAM_RANKS[team] || [];
  const roleMap = settings.roles()[team] || {};
  const newRoleId = roleMap[newRank];
  if (!newRoleId) return false;
  const toRemove = ranks.map(r => roleMap[r.name]).filter(id => id && id !== newRoleId && member.roles.cache.has(id));
  try {
    if (toRemove.length) await member.roles.remove(toRemove, 'تحديث رتبة عبر Staff Manager');
    await member.roles.add(newRoleId, 'تحديث رتبة عبر Staff Manager');
    return true;
  } catch (e) { logger.error('فشل تعديل الرتب:', e.message); return false; }
}

/** إزالة رتب فريق محدد */
async function removeTeamRoles(member, team) {
  const roleMap = settings.roles()[team] || {};
  const ids = Object.values(roleMap).filter(id => id && member.roles.cache.has(id));
  if (!ids.length) return true;
  try { await member.roles.remove(ids, 'إزالة من الفريق عبر Staff Manager'); return true; } catch (e) { logger.error('فشل إزالة رتب الفريق:', e.message); return false; }
}

function vacationRole(member) {
  if (!member?.guild?.roles?.cache) return null;
  const configured = settings.vacationRoleId();
  if (configured) {
    const role = member.guild.roles.cache.get(configured);
    if (role) return role;
  }
  const normalize = value => String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
  return member.guild.roles.cache.find(role => ['invacation', 'فيإجازة', 'في إجازة'].includes(normalize(role.name))) || null;
}

async function addVacationRole(member) {
  const role = vacationRole(member);
  if (!role) return { ok: false, missing: true };
  if (member.roles.cache.has(role.id)) return { ok: true, already: true, role };
  try {
    await member.roles.add(role, 'بدء إجازة معتمدة عبر Staff Manager');
    return { ok: true, role };
  } catch (error) {
    logger.error('فشل إضافة رتبة الإجازة:', error.message);
    return { ok: false, error, role };
  }
}

async function removeVacationRole(member) {
  const role = vacationRole(member);
  if (!role || !member.roles.cache.has(role.id)) return { ok: true, absent: true, role };
  try {
    await member.roles.remove(role, 'انتهاء الإجازة عبر Staff Manager');
    return { ok: true, role };
  } catch (error) {
    logger.error('فشل إزالة رتبة الإجازة:', error.message);
    return { ok: false, error, role };
  }
}

/** إزالة كل الرتب الإدارية (عند الاستقالة أو إلغاء تعيين الإدارة العامة) */
async function removeAllStaffRoles(member) {
  const ids = new Set();
  for (const team of Object.keys(TEAM_RANKS)) for (const id of Object.values(settings.roles()[team] || {})) {
    if (id && member.roles.cache.has(id)) ids.add(id);
  }
  if (!ids.size) return true;
  try { await member.roles.remove([...ids], 'إزالة الرتب الإدارية عبر Staff Manager'); return true; } catch { return false; }
}

/**
 * مزامنة الحالة مع رتب ديسكورد: إن لم يبقَ للعضو أي رتبة إدارية (نُزعت يدوياً
 * أو خرج من السيرفر) فلا يجوز أن يبقى "active" ويظهر في التقارير إلى الأبد.
 */
function syncDeparture(member) {
  const existing = get(member.id);
  if (!existing || ['resigned', 'removed'].includes(existing.status)) return null;
  const info = resolveStaff(member);
  if (info) return null;
  // احتفظ بحالة "بإجازة" الصريحة، ونزع البقية إلى "خرج من السيرفر"
  const next = existing.status === 'on_leave' ? 'on_leave' : 'removed';
  if (next === existing.status) return null;
  // نزع الرتب تغيير في العضوية لا في الرتبة، لكنه يُوثَّق في السجل نفسه كي لا
  // يظهر العضو بلا أثر لما جرى له.
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE staff_members SET status = ?, updated_at = ? WHERE user_id = ?')
      .run(next, nowIso(), member.id);
    appendRankChange({
      userId: member.id, team: existing.team, fromRank: existing.rank,
      changeType: 'remove', reason: 'نُزعت الرتب الإدارية (إزالة من الفريق)',
    });
  })();
  return { previous: existing.status, next, rank: existing.rank, team: existing.team };
}

/** عند مغادرة السيرفر فعلياً — خروج كامل */
function markLeft(userId) {
  const existing = get(userId);
  if (!existing || ['resigned', 'removed'].includes(existing.status)) return null;
  const db = getDb();
  db.transaction(() => {
    db.prepare('UPDATE staff_members SET status = ?, updated_at = ? WHERE user_id = ?')
      .run('removed', nowIso(), userId);
    appendRankChange({
      userId, team: existing.team, fromRank: existing.rank,
      changeType: 'left_guild', reason: 'غادر السيرفر',
    });
  })();
  return { previous: existing.status, next: 'removed', rank: existing.rank, team: existing.team };
}

module.exports = {
  get, all, ensure, setStatus, update, touchActivity, setRank, rankHistory, REMOVAL_TYPES,
  applyRankRoles, removeTeamRoles, removeAllStaffRoles,
  vacationRole, addVacationRole, removeVacationRole,
  suspend, unsuspend, liftExpiredSuspensions, suspensionEnd,
  syncDeparture, markLeft,
};
