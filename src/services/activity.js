'use strict';
const crypto = require('crypto');
const { getDb } = require('../database');
const settings = require('./settings');
const { ACTIVITY_WEIGHTS, SPAM } = require('../constants');
const { today } = require('../utils');

// ===== تصنيف القناة =====
function classifyChannel(channel) {
  if (!channel) return 'general';
  const ids = [channel.id, channel.parentId, channel.parent?.parentId].filter(Boolean);
  for (const type of ['ticket', 'staff', 'moderation']) {
    const list = settings.activityChannels()[type] || [];
    if (ids.some(id => list.includes(id))) return type;
  }
  // احتياط: قنوات التكتات عادة تبدأ بـ ticket-
  if (/^(ticket|تكت)/i.test(channel.name || '')) return 'ticket';
  return 'general';
}

// ===== فلتر السبام =====
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|<a?:\w+:\d+>|\s)+$/u;
const SYMBOLS_ONLY = /^[\p{P}\p{S}\s\d]+$/u;

/**
 * @returns {string|null} سبب الرفض أو null إن كانت الرسالة صالحة
 */
function spamReason(content) {
  const text = (content || '').trim();
  if (text.length < SPAM.minLength) return 'short';
  if (EMOJI_ONLY.test(text)) return 'emoji_only';
  if (SYMBOLS_ONLY.test(text)) return 'symbols_only';
  const compact = text.replace(/\s/g, '');
  if (compact.length && /^(.)\1+$/u.test(compact)) return 'repeated_char';
  const uniq = new Set(compact).size;
  if (compact.length >= 8 && uniq <= 2) return 'repeated_char';
  return null;
}

function hash(content) {
  return crypto.createHash('sha1').update(content.trim().toLowerCase()).digest('hex');
}

/**
 * تسجيل رسالة كنشاط. يعيد {counted:boolean, reason?:string, type:string}
 */
function record(userId, channel, content) {
  const type = classifyChannel(channel);
  const reason = spamReason(content);
  if (reason) return { counted: false, reason, type };

  const db = getDb();
  const h = hash(content);
  const dup = db.prepare(`SELECT 1 FROM activity_logs WHERE user_id = ? AND content_hash = ?
    AND created_at >= datetime('now', ?) LIMIT 1`).get(userId, h, `-${Math.floor(SPAM.duplicateWindowMs / 1000)} seconds`);
  if (dup) return { counted: false, reason: 'duplicate', type };

  const day = today();
  if (type === 'general') {
    const { c } = db.prepare(`SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND day = ? AND channel_type = 'general'`).get(userId, day);
    if (c >= SPAM.maxGeneralPerDay) return { counted: false, reason: 'daily_cap', type };
  }

  db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, channel?.id || '0', type, ACTIVITY_WEIGHTS[type], h, day);
  return { counted: true, type };
}

/** إحصائيات نشاط خلال فترة (بالأيام) */
function stats(userId, days = 30) {
  const db = getDb();
  const since = `-${days} days`;
  const rows = db.prepare(`SELECT channel_type, COUNT(*) c, SUM(weight) w FROM activity_logs
    WHERE user_id = ? AND created_at >= datetime('now', ?) GROUP BY channel_type`).all(userId, since);
  const { d } = db.prepare(`SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND created_at >= datetime('now', ?)`).get(userId, since);
  const byType = {};
  let messages = 0, weighted = 0;
  for (const r of rows) { byType[r.channel_type] = r.c; messages += r.c; weighted += r.w; }
  return { messages, weighted: Math.round(weighted * 100) / 100, activeDays: d, byType };
}

function activeDaysInMonth(userId, yyyymm) {
  const { d } = getDb().prepare(`SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND day LIKE ?`).get(userId, `${yyyymm}%`);
  return d;
}

module.exports = { classifyChannel, spamReason, record, stats, activeDaysInMonth };
