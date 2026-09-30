'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const { INACTIVE_STATUSES } = require('../constants');

function windowClause(days) {
  const value = Math.max(1, Math.min(90, Math.trunc(Number(days) || 7)));
  return { value, since: `-${value} days` };
}

/** العمل المسجل خلال نافذة زمنية — لا نخمن التكتات المفتوحة غير الموجودة في قاعدة البيانات. */
function ticketLoad(userId, days = 7) {
  const { value, since } = windowClause(days);
  const row = getDb().prepare(`SELECT COUNT(*) closed, AVG(duration) avg_duration, AVG(rating) avg_rating,
      COALESCE(SUM(reopened), 0) reopened, SUM(source = 'manual') manual
    FROM ticket_metrics WHERE claimer = ? AND closed_at >= datetime('now', ?)`).get(userId, since);
  return {
    days: value,
    closed: row.closed || 0,
    avgDuration: row.avg_duration == null ? null : Math.round(row.avg_duration),
    avgRating: row.avg_rating == null ? null : Math.round(row.avg_rating * 100) / 100,
    reopened: row.reopened || 0,
    manual: row.manual || 0,
  };
}

function moderationLoad(userId, days = 7) {
  const { value, since } = windowClause(days);
  const row = getDb().prepare(`SELECT COUNT(*) actions, COUNT(DISTINCT date(created_at)) active_days
    FROM mod_actions WHERE moderator_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  return { days: value, actions: row.actions || 0, activeDays: row.active_days || 0 };
}

function memberLoad(staff, days = 7) {
  const work = staff.team === 'support' ? ticketLoad(staff.user_id, days) : moderationLoad(staff.user_id, days);
  return { staff, work };
}

function teamLoad(team, days = 7) {
  return staffService.all({ team })
    .filter(s => !INACTIVE_STATUSES.includes(s.status) && s.status !== 'probation')
    .map(s => memberLoad(s, days))
    .sort((a, b) => {
      const aCount = a.work.closed ?? a.work.actions ?? 0;
      const bCount = b.work.closed ?? b.work.actions ?? 0;
      return bCount - aCount || String(a.staff.username || a.staff.user_id).localeCompare(String(b.staff.username || b.staff.user_id));
    });
}

function fairness(rows) {
  const counts = rows.map(r => r.work.closed ?? r.work.actions ?? 0);
  if (!counts.length) return { total: 0, average: 0, busiest: null, idle: [], imbalance: 0 };
  const average = counts.reduce((sum, n) => sum + n, 0) / counts.length;
  const busiestIndex = counts.indexOf(Math.max(...counts));
  const idle = rows.filter(r => (r.work.closed ?? r.work.actions ?? 0) === 0).map(r => r.staff.user_id);
  return {
    total: counts.reduce((sum, n) => sum + n, 0),
    average: Math.round(average * 10) / 10,
    busiest: rows[busiestIndex]?.staff.user_id || null,
    idle,
    imbalance: average ? Math.round((Math.max(...counts) / average) * 100) / 100 : 0,
  };
}

module.exports = { windowClause, ticketLoad, moderationLoad, memberLoad, teamLoad, fairness };