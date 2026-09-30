'use strict';
const { getDb } = require('../database');
const logger = require('../logger').log('ticket-logs');
const settings = require('./settings');
const staffService = require('./staff');

const ID_RE = /^\d{15,22}$/;

function decodeHtml(value) {
  return String(value || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#x2F;/gi, '/').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

function messageParts(message) {
  const parts = [];
  if (message?.content) parts.push(decodeHtml(message.content));
  for (const e of message?.embeds || []) {
    if (e.title) parts.push(decodeHtml(e.title));
    if (e.description) parts.push(decodeHtml(e.description));
    for (const f of e.fields || []) {
      const name = decodeHtml(f.name || '');
      const value = decodeHtml(f.value || '');
      if (name && value) parts.push(`${name}: ${value}`);
      else if (name || value) parts.push(name || value);
    }
    if (e.footer?.text) parts.push(decodeHtml(e.footer.text));
  }
  return parts.filter(Boolean);
}

function userIdFrom(value) {
  const text = decodeHtml(value);
  const mention = text.match(/<@!?(\d{15,22})>/);
  if (mention) return mention[1];
  const direct = text.match(/\b(\d{15,22})\b/);
  return direct ? direct[1] : null;
}

function valueAfterLabel(parts, labels) {
  const pattern = labels.join('|');
  const re = new RegExp(`(?:${pattern})\\s*[:：-]\\s*([^\\n]+)`, 'i');
  for (const part of parts) {
    const match = part.match(re);
    if (match) return match[1].trim();
  }
  const all = parts.join('\n').match(re);
  return all ? all[1].trim() : null;
}

function ticketIdFrom(parts) {
  const preferred = parts.slice(0, 3).join('\n');
  const find = (text) => {
    const match = text.match(/(?:سجل\s+التكت(?:\s+رقم)?|رقم\s+(?:التكت|التذكرة|التذكره))\s*[:：-]?\s*#?([A-Za-z][\w-]*-\d+|\d{2,})/i);
    return match?.[1] || null;
  };
  return find(preferred) || find(parts.join('\n')) || parts.join('\n').match(/#([A-Za-z][\w-]*-\d+)/i)?.[1] || null;
}

/**
 * يحوّل «مدة الحل» إلى دقائق. البوت الخارجي يرسلها بعدة أشكال:
 *   «01:23» (ساعة:دقيقة) • «00:07:30» (س:د:ث) • «45 دقيقة» • «2 ساعات» • «1 يوم» • «45» (دقائق).
 */
function parseDuration(value) {
  if (value == null || value === '') return null;
  const text = decodeHtml(String(value)).replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660));
  // HH:MM أو HH:MM:SS
  const clock = text.match(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/);
  if (clock) {
    const h = Number(clock[1]), m = Number(clock[2]), sec = Number(clock[3] || 0);
    const total = h * 60 + m + Math.round(sec / 60);
    return total > 0 ? total : 0;
  }
  // وحدات صريحة: يوم/ساعة/دقيقة
  const unit = text.match(/(\d+(?:\.\d+)?)\s*(يوم|أيام|ايام|يومين|ساعة|ساعات|ساعتين|ساعه|دقيقة|دقائق|دقيقتين|دقيقه)/);
  if (unit) {
    const n = Number(unit[1]);
    const u = unit[2];
    const minutes = /يوم|أيام|ايام/.test(u) ? n * 1440 : /ساع/.test(u) ? n * 60 : n;
    return Math.round(minutes);
  }
  const bare = text.match(/(\d+(?:\.\d+)?)/);
  return bare ? Math.round(Number(bare[1])) : null;
}

function linkFrom(parts) {
  const text = parts.join('\n');
  const match = text.match(/\[[^\]]+\]\((https?:\/\/[^)]+)\)/i);
  return match ? match[1] : text.match(/https?:\/\/\S+/i)?.[0] || null;
}

/** تحليل رسالة سجل البوت الخارجي بدون أي API أو ربط معه. */
function parseExternalTicketMessage(message) {
  if (!message?.author?.bot) return null;
  const sourceChannel = settings.channelId('ticket-source-logs');
  if (!sourceChannel || message.channel?.id !== sourceChannel) return null;
  const configuredBot = settings.ticketLogBotId();
  if (configuredBot && message.author.id !== configuredBot) return null;

  const parts = messageParts(message);
  const ownerValue = valueAfterLabel(parts, ['صاحب\\s+التكت', 'صاحب\\s+التذكرة', 'صاحب\\s+التذكره']);
  const claimerValue = valueAfterLabel(parts, ['مستلم\\s+التكت', 'مستلم\\s+التذكرة', 'مستلم\\s+التذكره', 'مستلم']);
  const closerValue = valueAfterLabel(parts, ['الذي\\s+قفل\\s+التكت', 'الي\\s+قفل\\s+التكت', 'اللي\\s+قفل\\s+التكت', 'قفل\\s+التكت']);
  const ticketId = ticketIdFrom(parts);
  const owner = userIdFrom(ownerValue);
  const claimer = userIdFrom(claimerValue);
  const closer = userIdFrom(closerValue) || claimer;
  const ratingValue = valueAfterLabel(parts, ['تقييم', 'التقييم', 'تقييم\\s+العميل']);
  const durationValue = valueAfterLabel(parts, ['مدة\\s+الحل', 'المدة', 'مدة']);
  const ratingMatch = ratingValue?.match(/[1-5]/);
  const rating = ratingMatch ? Number(ratingMatch[0]) : null;
  const duration = parseDuration(durationValue);
  if (!ticketId || !ID_RE.test(owner || '') || !ID_RE.test(claimer || '') || !ID_RE.test(closer || '')) return null;

  return {
    ticketId: ticketId.trim(), owner, claimer, closer, rating, duration,
    durationSource: duration == null ? null : 'reported',
    source: 'external_log', sourceMessageId: message.id,
    sourceChannelId: message.channel.id, sourceUrl: message.url || null,
    ticketUrl: linkFrom(parts), loggedBy: message.author.id,
  };
}

/**
 * إن لم يذكر البوت المدة، نحسبها من فرق الوقت بين أول رسالة تشير إلى التكت
 * (رسالة الاستلام) ورسالة الإغلاق. لا API خارجي، فقط تاريخ القناة نفسها.
 * النتيجة بالدقائق وتُوسم durationSource='computed'.
 */
async function enrichDuration(message, parsed) {
  if (!parsed || parsed.duration != null) return parsed;
  const key = parsed.ticketUrl || parsed.ticketId;
  if (!key || !message.channel?.messages?.fetch) return parsed;
  try {
    const before = await message.channel.messages.fetch({ limit: 50, before: message.id });
    const match = [...before.values()]
      .filter(m => m.id !== message.id)
      .find(m => {
        const text = [m.content, ...(m.embeds || []).flatMap(e => [e.title, e.description, e.url, ...(e.fields || []).map(f => `${f.name} ${f.value}`)])].join(' ');
        return text.includes(parsed.ticketId) || (parsed.ticketUrl && text.includes(parsed.ticketUrl));
      });
    if (!match?.createdTimestamp) return parsed;
    const minutes = Math.max(0, Math.round((message.createdTimestamp - match.createdTimestamp) / 60000));
    parsed.duration = minutes;
    parsed.durationSource = 'computed';
    parsed.claimedAt = new Date(match.createdTimestamp).toISOString().replace('T', ' ').slice(0, 19);
  } catch (e) {
    logger.warn(`تعذّر حساب مدة التكت ${parsed.ticketId}: ${e.message}`);
  }
  return parsed;
}
 
/** تسجيل تكت يدوي أو مستخرج من سجل خارجي. */
function recordTicket(input) {
  const ticket = {
    ...input,
    rating: input.rating == null ? null : Number(input.rating),
    duration: input.duration == null ? null : Number(input.duration),
    source: input.source || 'manual',
  };
  const db = getDb();
  if (ticket.sourceMessageId) {
    const duplicate = db.prepare('SELECT * FROM ticket_metrics WHERE source_message_id = ?').get(ticket.sourceMessageId);
    if (duplicate) return { duplicate: true, row: duplicate, earned: 0, reopened: !!duplicate.reopened };
  }
  const existing = db.prepare('SELECT * FROM ticket_metrics WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(ticket.ticketId);
  // الإدخال اليدوي خطة احتياطية وليست طريقة لتكرار النقاط. التكت المعاد فتحه
  // يُقبل فقط من سجل خارجي جديد، حيث يملك source_message_id مرجعاً مستقلاً.
  if (existing && ticket.source === 'manual') {
    return { duplicate: true, manualDuplicate: true, row: existing, earned: 0, reopened: !!existing.reopened };
  }
  const reopened = existing ? 1 : 0;
const result = db.prepare(`INSERT INTO ticket_metrics
     (ticket_id, ticket_owner, claimer, closer, rating, duration, duration_source, claimed_at, logged_by, reopened, source, source_message_id, source_channel_id, source_url, ticket_url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
   .run(ticket.ticketId, ticket.owner, ticket.claimer, ticket.closer || ticket.claimer, ticket.rating, ticket.duration,
     ticket.durationSource || (ticket.duration == null ? null : 'reported'), ticket.claimedAt || null, ticket.loggedBy,
     reopened, ticket.source, ticket.sourceMessageId || null, ticket.sourceChannelId || null, ticket.sourceUrl || null, ticket.ticketUrl || null);
   return { duplicate: false, row: { id: Number(result.lastInsertRowid), ...ticket, reopened }, reopened: !!reopened, existing };
}

module.exports = {
  parseDuration, enrichDuration, ID_RE, messageParts, valueAfterLabel, ticketIdFrom, userIdFrom, parseExternalTicketMessage, recordTicket };
