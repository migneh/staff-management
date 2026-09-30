'use strict';
const { getDb } = require('../database');
const settings = require('./settings');
const staff = require('./staff');
const { messageParts } = require('./ticketLogs');
const { normalizeDigits, nowIso } = require('../utils');
const audit = require('./audit');

function normalize(text) {
  return normalizeDigits(text).replace(/[أإآ]/g, 'ا').replace(/[\u064B-\u065F\u0670ـ]/g, '')
    .replace(/^\s*(?:-\s*)?>\s?/gm, '').replace(/[*_`\u200B-\u200F\u202A-\u202E\u2066-\u2069]/g, '').trim();
}

/** لا نفترض ترتيب المنشنات: كل منشن مرتبط بعنوانه، مع رفض الرسائل الملتبسة. */
function parse(message) {
  if (!message?.author?.bot || !message.id) return null;
  if (!settings.channelId('support-rating-logs') || (message.channelId || message.channel?.id) !== settings.channelId('support-rating-logs')) return null;
  const botId = settings.policy('ratingBotId');
  if (botId && message.author.id !== botId) return null;
  const text = normalize(messageParts(message).join('\n'));
  const headers = [...text.matchAll(/تم\s+تقييم\s+الاداري|العضو\s+(?:الي|اللي|الذي)\s+(?:قييم|قيم)|عدد\s+النجوم/g)];
  if (headers.length !== 3) return null;
  const sections = new Map();
  for (let n = 0; n < headers.length; n++) {
    const h = headers[n];
    const kind = h[0].startsWith('تم') ? 'staff' : h[0].startsWith('العضو') ? 'reviewer' : 'stars';
    if (sections.has(kind)) return null;
    sections.set(kind, text.slice(h.index + h[0].length, headers[n + 1]?.index ?? text.length));
  }
  const mention = section => {
    const mentions = [...(section || '').matchAll(/<@!?(\d{15,22})>/g)];
    return mentions.length === 1 ? mentions[0][1] : null;
  };
  const staffId = mention(sections.get('staff'));
  const reviewerId = mention(sections.get('reviewer'));
  const starLines = (sections.get('stars') || '').replace(/\uFE0F/g, '').replace(/^[\s:：-]+/, '').trim().split('\n');
  const starText = starLines[0].trim();
  if (starLines.slice(1).some(line => line.includes('⭐'))) return null;
  // فقط نجوم متصلة؛ لا نحتسب نجمة زخرفية خارج حقل عدد النجوم.
  if (!/^⭐{1,5}$/.test(starText) || !staffId || !reviewerId || staffId === reviewerId) return null;
  const created = message.createdTimestamp == null ? new Date(nowIso().replace(' ', 'T') + 'Z') : new Date(message.createdTimestamp);
  if (!Number.isFinite(created.getTime()) || created.getTime() > Date.now() + 60000) return null;
  return {
    staffId, reviewerId, stars: [...starText].length,
    messageId: message.id, channelId: message.channelId || message.channel.id,
    guildId: message.guildId || message.guild?.id, botId: message.author.id,
    ratedAt: created.toISOString().replace('T', ' ').slice(0, 19),
  };
}

function record(input) {
  if (!input?.guildId || !input.messageId || !input.channelId || !input.botId || !input.reviewerId || !Number.isInteger(input.stars) || input.stars < 1 || input.stars > 5 || input.staffId === input.reviewerId) return { ignored: 'invalid' };
  const member = staff.get(input.staffId);
  if (!member || member.team !== 'support' || ['resigned', 'left'].includes(member.status)) return { ignored: 'not_support' };
  // الإدخال والتدقيق في معاملة واحدة، والقيد الفريد يحمي من إعادة تسليم Discord للرسالة.
  return getDb().transaction(() => {
    const result = getDb().prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, source_message_id, source_channel_id, source_guild_id, source_bot_id, rated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(source_message_id) DO NOTHING`)
      .run(input.staffId, input.reviewerId, input.stars, input.messageId, input.channelId, input.guildId, input.botId, input.ratedAt);
    if (!result.changes) return { duplicate: true };
    audit.record({ action: 'support_rating_imported', actorId: input.botId, targetId: input.staffId, channelId: input.channelId,
      details: { ratingId: Number(result.lastInsertRowid), stars: input.stars, reviewerId: input.reviewerId, sourceMessageId: input.messageId } });
    return { saved: true, id: Number(result.lastInsertRowid) };
  })();
}

async function importMessage(message, ownBotId) {
  if (message.author?.id === ownBotId) return null;
  const input = parse(message);
  if (!input) return null;
  if (getDb().prepare('SELECT 1 FROM support_ratings WHERE source_message_id = ?').get(input.messageId)) return { duplicate: true };
  // مزامنة دور الدعم الحالي حتى لو لم يكتب الإداري رسالة للبوت من قبل.
  const member = await message.guild?.members?.fetch(input.staffId).catch(() => null);
  if (!member) return { ignored: 'member_unavailable' };
  const info = require('./permissions').resolveStaff(member);
  if (info?.team !== 'support') return { ignored: 'not_support' };
  staff.ensure(member);
  return record(input);
}

function summary(userId, days = 30, offset = 0) {
  const span = Math.min(365, Math.max(1, Math.trunc(Number(days) || 30)));
  const end = Math.max(0, Math.trunc(Number(offset) || 0));
  const where = `staff_id = ? AND rated_at >= datetime('now', ?) AND rated_at <= datetime('now', ?)`;
  const params = [userId, `-${span + end} days`, `-${end} days`];
  const row = getDb().prepare(`SELECT COUNT(*) count, AVG(stars) average, COUNT(DISTINCT reviewer_id) reviewers FROM support_ratings WHERE ${where}`).get(...params);
  const distribution = getDb().prepare(`SELECT stars, COUNT(*) count FROM support_ratings WHERE ${where} GROUP BY stars ORDER BY stars DESC`).all(...params);
  const recent = getDb().prepare(`SELECT * FROM support_ratings WHERE ${where} ORDER BY rated_at DESC, id DESC LIMIT 5`).all(...params);
  return { ...row, average: row.average == null ? null : Math.round(row.average * 100) / 100, distribution, recent, days: span };
}
function sourceUrl(row) { return `https://discord.com/channels/${row.source_guild_id}/${row.source_channel_id}/${row.source_message_id}`; }
module.exports = { parse, record, importMessage, summary, sourceUrl };
