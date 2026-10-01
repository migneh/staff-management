'use strict';
const { getDb } = require('../database');
const { nowIso } = require('../utils');

// `level` كان معاملاً في التوقيع لا يُخزَّن إطلاقاً، و`list` كان يفلتر على عمود
// `level` غير الموجود في audit_logs — أي أن أي استدعاء كان سينهار بـ
// "no such column". لا مستدعٍ واحد في src/ كان يمرّره. أُزيل بدل إضافة عمود
// لا يكتبه أحد.
function record({ action, actorId = null, targetId = null, details = null, channelId = null }) {
  const payload = details == null ? null : typeof details === 'string' ? details : JSON.stringify(details);
  const result = getDb().prepare(`INSERT INTO audit_logs (action, actor_id, target_id, details, channel_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(action, actorId, targetId, payload, channelId, nowIso());
  return result.lastInsertRowid;
}

function list({ actorId, targetId, limit = 15, action = null, since = null } = {}) {
  let sql = 'SELECT * FROM audit_logs WHERE 1=1';
  const params = [];
  if (actorId) { sql += ' AND actor_id = ?'; params.push(actorId); }
  if (targetId) { sql += ' AND target_id = ?'; params.push(targetId); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (since) { sql += ' AND created_at >= ?'; params.push(since); }
  sql += ' ORDER BY id DESC LIMIT ?';
  params.push(Math.min(Math.max(Number(limit) || 15, 1), 100));
  return getDb().prepare(sql).all(...params);
}

function count({ actorId, targetId, action = null, since = null } = {}) {
  let sql = 'SELECT COUNT(*) c FROM audit_logs WHERE 1=1';
  const params = [];
  if (actorId) { sql += ' AND actor_id = ?'; params.push(actorId); }
  if (targetId) { sql += ' AND target_id = ?'; params.push(targetId); }
  if (action) { sql += ' AND action = ?'; params.push(action); }
  if (since) { sql += ' AND created_at >= ?'; params.push(since); }
  return getDb().prepare(sql).get(...params).c;
}

function distinctActions({ limit = 50 } = {}) {
  return getDb().prepare(`SELECT action, COUNT(*) c FROM audit_logs GROUP BY action ORDER BY c DESC LIMIT ?`).all(limit);
}

function parseDetails(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return value; }
}

module.exports = { record, list, count, distinctActions, parseDetails };
