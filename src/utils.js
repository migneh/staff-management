'use strict';
const { EmbedBuilder } = require('discord.js');
const clock = require('./clock');
const settings = () => require('./services/settings');

const COLORS = { primary: 0x5865f2, success: 0x57f287, warning: 0xfee75c, danger: 0xed4245, info: 0x3498db, gray: 0x99aab5 };

// حماية عامة: محتوى ديناميكي طويل أو كائن غير نصي كان يُسقط الرد بالكامل.
const MAX_TITLE = 256;
const MAX_DESCRIPTION = 4096;
function clampText(value, max) {
  const text = String(value);
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
function embedText(value) {
  return value == null || typeof value === 'object' ? null : String(value);
}

function embed(title, description, color = COLORS.primary) {
  const e = new EmbedBuilder().setColor(color).setTimestamp();
  const heading = embedText(title);
  const body = embedText(description);
  if (heading) e.setTitle(clampText(heading, MAX_TITLE));
  if (body) e.setDescription(clampText(body, MAX_DESCRIPTION));
  return e;
}

/** إمبد يحمل هوية المستخدم (صورة + اسم) — للتقارير والسجلات */
function userEmbed(user, title, description, color = COLORS.primary) {
  const e = embed(title, description, color);
  if (user) e.setAuthor({ name: user.displayName || user.username || user.tag, iconURL: typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL() : undefined }).setThumbnail(typeof user.displayAvatarURL === 'function' ? user.displayAvatarURL({ size: 128 }) : null);
  return e;
}

const ok = (i, text) => replyEphemeral(i, `✅ ${text}`, COLORS.success);
const fail = (i, text) => replyEphemeral(i, `❌ ${text}`, COLORS.danger);
const divider = '━━━━━━━━━━━━━━━━━━━━';

// كل حسابات الوقت في مكان واحد — راجع src/clock.js لمعرفة قاعدة التوقيت.
const { nowIso, today, addDays, isValidDate, daysBetween, monthsSince, hoursSince, discordTs } = clock;

function truncate(s, n) { return s && s.length > n ? s.slice(0, n - 1) + '…' : s || ''; }

// ===== الأرقام: تُعرض عربية-هندية في الواجهة، وتُقرأ بأي شكل من المستخدم =====
const AR_DIGITS_MAP = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
/**
 * يعرض الرقم بأرقام عربية-هندية (٠١٢...) كما يكتبها الفريق في ديسكورد.
 * الأرقام الغربية تبقى مقبولة في المدخلات — راجع normalizeDigits.
 */
function arDigits(value) {
  return String(value).replace(/\d/g, d => AR_DIGITS_MAP[Number(d)]);
}

/** يحوّل أي أرقام عربية-هندية (٠-٩) أو فارسية (۰-۹) إلى غربية قبل التحقق أو الحساب */
function normalizeDigits(value) {
  return String(value == null ? '' : value)
    .replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 0x30))
    .replace(/[۰-۹]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 0x30));
}

/** يحوّل نصاً عربياً إلى رقم صحيح أو null — يقبل «٤٢» و«42» و« 42 » */
function toInt(value) {
  const n = normalizeDigits(value).replace(/[^\d-]/g, '');
  return /^-?\d+$/.test(n) ? Number(n) : null;
}

async function getChannel(client, key) {
  const id = settings().channelId(key);
  if (!id) return null;
  try { return await client.channels.fetch(id); } catch { return null; }
}

async function sendToChannel(client, key, payload) {
  const ch = await getChannel(client, key);
  if (!ch) {
    // القناة غير مربوطة أو حُذفت — نسجّل مرة واحدة بدل الفشل الصامت.
    require('./logger').log('utils').warn(`قناة غير متاحة: ${key} — الإرسال متوقف. راجع /setup`);
    return null;
  }
  try { return await ch.send(payload); } catch (e) {
    require('./logger').log('utils').error(`فشل الإرسال إلى #${key}: ${e.message}`);
    return null;
  }
}

async function log(client, title, description, color = COLORS.gray) {
  return sendToChannel(client, 'staff-logs', { embeds: [embed(title, description, color)] });
}

async function dm(client, userId, payload) {
  try {
    const user = await client.users.fetch(userId);
    await user.send(payload);
    return true;
  } catch { return false; }
}

async function replyEphemeral(interaction, content, color = COLORS.info) {
  // يقبل نصاً أو إمبداً جاهزاً (بعض المسارات تمرّر EmbedBuilder مباشرة).
  const ready = content && typeof content === 'object' && typeof content.toJSON === 'function';
  const payload = { embeds: [ready ? content : embed(null, content, color)], ephemeral: true, allowedMentions: { parse: [] } };
  // زرّ «تصحيح» مرتبط برفض الالتقاط (invalid) لا بلون الردّ وحده، لأنّ المعالجات
  // تردّ بلون الخطر في حالات صحيحة أيضاً — بطاقة المراجعة مثلاً.
  if (color === COLORS.danger && interaction.formSession && interaction.formSession.invalid) {
    const retry = require('./ui/forms').retryRow(interaction);
    if (retry) payload.components = [retry];
  }
  if (interaction.deferred || interaction.replied) return interaction.followUp(payload);
  return interaction.reply(payload);
}

function progressBar(value, max, size = 10) {
  const filled = Math.round(Math.min(Math.max(value, 0) / (max || 1), 1) * size);
  return '▰'.repeat(filled) + '▱'.repeat(size - filled);
}

// ===== ألوان وأشكال Score =====
// العتبات نفسها المستخدمة في grade (90/75/60/40) ومتسقة مع reports.js —
// مصدر واحد يمنع أن تلوّن بطاقةُ الوضعَ جيداً بينما تقول البطاقة المجاورة ضعيف.
const SCORE_BANDS = [
  { min: 90, color: COLORS.success, emoji: '🏆' },
  { min: 75, color: COLORS.info, emoji: '⭐' },
  { min: 60, color: COLORS.info, emoji: '📈' },
  { min: 40, color: COLORS.warning, emoji: '⚠️' },
];

/** لون Score — يُعيد محايداً لأي درجة غير قابلة للقياس بدل إفساد البطاقة. */
function scoreColor(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return COLORS.gray;
  return (SCORE_BANDS.find(b => n >= b.min) || { color: COLORS.danger }).color;
}

/** رمز Score — شكل مختلف لكل نطاق، فلا يعتمد الفهم على اللون وحده. */
function scoreEmoji(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return '—';
  return (SCORE_BANDS.find(b => n >= b.min) || { emoji: '⛔' }).emoji;
}

module.exports = {
  COLORS, embed, userEmbed, ok, fail, divider,
  nowIso, today, addDays, isValidDate, daysBetween, monthsSince, hoursSince, discordTs,
  arDigits, normalizeDigits, toInt, truncate,
  getChannel, sendToChannel, log, dm, replyEphemeral, progressBar,
  scoreColor, scoreEmoji,
};
