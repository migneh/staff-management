'use strict';
/**
 * مكتبة واجهة موحّدة (UI Kit) لكل ردود البوت.
 * الهدف: شكل واحد متناسق، مواعيد يفهمها المستخدم بتوقيت جهازه، تنقّل بالأزرار
 * بدل كتابة الأرقام، وحالات فارغة ونصائح واضحة بدل رسائل الخطأ الجافّة.
 */
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, ComponentType,
} = require('discord.js');

const { arDigits: AR_DIGITS, COLORS, embed, truncate } = require('../utils');

/** `<t:1700000000:D>` — تاريخ محلي في جهاز القارئ */
function tsDate(value, style = 'D') {
  const epoch = toEpoch(value);
  return epoch ? `<t:${epoch}:${style}>` : '—';
}
/** `<t:...:R>` — «بعد يومين» / «منذ 3 ساعات» */
function tsRelative(value) {
  const epoch = toEpoch(value);
  return epoch ? `<t:${epoch}:R>` : '—';
}
/** سطر تاريخ كامل: التاريخ + النسبة الحالية */
function dateLine(value, { style = 'D' } = {}) {
  const epoch = toEpoch(value);
  if (!epoch) return '—';
  return `<t:${epoch}:${style}> • <t:${epoch}:R>`;
}

function toEpoch(value) {
  if (!value) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return Math.floor(Date.parse(`${str}T00:00:00Z`) / 1000);
  const iso = str.replace(' ', 'T') + (str.length <= 19 ? 'Z' : '');
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}

function startOfDay(dateStr = new Date().toISOString().slice(0, 10)) {
  return /^\d{4}-\d{2}-\d{2}$/.test(dateStr) ? dateStr : String(dateStr).slice(0, 10);
}

/** عدد الأيام من اليوم إلى تاريخ (سالفة = قيمة سالبة) */
function daysFromToday(dateStr, todayStr = new Date().toISOString().slice(0, 10)) {
  const a = Date.parse(`${startOfDay(todayStr)}T00:00:00Z`);
  const b = Date.parse(`${startOfDay(dateStr)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/** صياغة عربية مختصرة للمسافة الزمنية */
function relativeDays(days) {
  if (days == null) return '—';
  if (days === 0) return '**اليوم**';
  if (days === 1) return '**غداً**';
  if (days === -1) return '**أمس**';
  if (days > 1 && days <= 30) return `خلال **${AR_DIGITS(days)}** أيام`;
  if (days > 30) return `خلال **${AR_DIGITS(Math.round(days / 30))}** شهر`;
  if (days < -1 && days >= -30) return `منذ **${AR_DIGITS(-days)}** أيام`;
  return `منذ **${AR_DIGITS(Math.round(-days / 30))}** شهر`;
}

function plural(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n % 100 >= 3 && n % 100 <= 10) return few.replace('{n}', n);
  return many.replace('{n}', n);
}
const daysWord = (n) => plural(n, 'يوم', 'يومين', '{n} أيام', '{n} يوم');
const itemsWord = (n) => plural(n, 'عنصر', 'عنصرين', '{n} عناصر', '{n} عنصراً');

const CHIP = {
  pending: '⏳', approved: '✅', accepted: '✅', rejected: '❌', ended: '🏁', cancelled: '🚫',
  expired: '⌛', on_hold: '⏸️', withdrawn: '↩️', active: '🟢', inactive: '🟠', on_leave: '🏖️',
  probation: '🧪', suspended: '⛔', resigned: '⚫', role_on: '🏖️', role_off: '⚪',
};

function chip(status, label) {
  return `${CHIP[status] || '▫️'} ${label || status}`;
}

/** حالة الحقل بشكل ✅/❌ مع قيمة فعلية ومطلوبة */
function checkLine(pass, label, actual, required) {
  return `${pass ? '✅' : '❌'} ${label}: \`${actual}\`${required == null ? '' : ` ← المطلوب \`${required}\``}`;
}

function progressBar(value, max, size = 10, { full = '▰', empty = '▱' } = {}) {
  const ratio = max > 0 ? Math.min(Math.max(value, 0) / max, 1) : 0;
  const filled = Math.round(ratio * size);
  return full.repeat(filled) + empty.repeat(size - filled);
}

/** شريط تغطية: عدد المجازين مقابل الحد المسموح */
function coverageBar(count, max) {
  const size = Math.max(max, 1);
  const used = Math.min(count, size);
  const bar = '🟩'.repeat(used) + (count > max ? '🟥'.repeat(Math.min(count - max, size)) : '⬛'.repeat(Math.max(size - used, 0)));
  return `${bar} ${count}/${max}`;
}

// ===== الترنيج =====
function paginate(list, page, perPage = 10) {
  const total = list.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const start = (current - 1) * perPage;
  return { items: list.slice(start, start + perPage), page: current, pages, total, from: total ? start + 1 : 0, to: Math.min(start + perPage, total) };
}

/**
 * صف تنقّل موحّد: ◀️ | رقم الصفحة (زر معطّل) | ▶️  + أزرار إضافية
 * customId: `${prefix}:${page}:${args.join(':')}`
 */
function navRow({ prefix, page, pages, args = [], label = 'صفحة', extra = [] }) {
  const row = new ActionRowBuilder();
  row.addComponents(
    new ButtonBuilder().setCustomId(`${prefix}:${Math.max(1, page - 1)}:${args.join(':')}`).setEmoji('◀️').setLabel('السابق')
      .setStyle(ButtonStyle.Secondary).setDisabled(page <= 1),
    new ButtonBuilder().setCustomId(`${prefix}:noop:${args.join(':')}`).setLabel(`${label} ${page}/${pages}`).setStyle(ButtonStyle.Secondary).setDisabled(true),
    new ButtonBuilder().setCustomId(`${prefix}:${Math.min(pages, page + 1)}:${args.join(':')}`).setEmoji('▶️').setLabel('التالي')
      .setStyle(ButtonStyle.Secondary).setDisabled(page >= pages),
  );
  for (const b of extra) row.addComponents(b);
  return row;
}

/** يبني customId من الأجزاء مع تجاهل الفارغ */
const cid = (...parts) => parts.filter(p => p !== undefined && p !== null && p !== '').join(':');

const button = (customId, label, emoji, style = ButtonStyle.Secondary, { disabled = false } = {}) =>
  new ButtonBuilder().setCustomId(customId).setLabel(String(label).slice(0, 80)).setStyle(style).setDisabled(disabled)
    .setEmoji(emoji ? String(emoji).replace(/^:/g, '') : undefined);

/** قائمة اختيار نصية (مفردة أو متعددة) */
function selectMenu({ customId, placeholder, options, minValues = 1, maxValues = 1, disabled = false }) {
  const menu = new StringSelectMenuBuilder().setCustomId(customId).setPlaceholder(String(placeholder).slice(0, 150))
    .setMinValues(Math.min(minValues, options.length)).setMaxValues(Math.min(Math.max(maxValues, minValues), options.length));
  menu.addOptions(options.slice(0, 25).map(o => ({
    label: String(o.label).slice(0, 100),
    value: String(o.value),
    description: o.description ? String(o.description).slice(0, 100) : undefined,
    emoji: o.emoji ? String(o.emoji).replace(/^:/g, '') : undefined,
    default: o.default || undefined,
  })));
  if (disabled) menu.setDisabled(true);
  return new ActionRowBuilder().addComponents(menu);
}

/** قوائم متعددة مقسّمة على أسطر (كل 25 خياراً سطراً) */
function groupedSelect({ customId, placeholder, options, minValues = 1, maxValues = 25 }) {
  const rows = [];
  const chunks = [];
  for (let i = 0; i < options.length; i += 25) chunks.push(options.slice(i, i + 25));
  if (!chunks.length) chunks.push([]);
  chunks.forEach((chunk, index) => {
    const suffix = chunks.length > 1 ? `${customId}:${index}` : customId;
    rows.push(selectMenu({
      customId: suffix, placeholder: chunks.length > 1 ? `${placeholder} — ${index + 1}` : placeholder,
      options: chunk, minValues, maxValues, disabled: !chunk.length,
    }));
  });
  return rows;
}

// ===== البطاقات الموحّدة: شكل واحد لكل رسائل البوت =====
const BRAND = 'نظام إدارة الفريق';
const LIMITS = { title: 256, description: 4096, fields: 25, name: 256, value: 1024, footer: 2048 };

/** قصّ آمن على حدود ديسكورد (نفس قاعدة utils.embed للحقول) */
const clip = (text, max) => truncate(String(text ?? ''), max);

/** وقت نسبي جاهز للتذييل: «آخر تحديث: منذ 3 دقائق» */
function stamp(value = null) {
  const epoch = value ? toEpoch(value) : Math.floor(Date.now() / 1000);
  return epoch ? `<t:${epoch}:R>` : 'الآن';
}

/** سطر تذييل موحّد: نص اختياري + هوية البوت + وقت نسبي */
function footerLine(text = null, { brand = true, time = true, value = null } = {}) {
  return [text, brand ? BRAND : null, time ? stamp(value) : null].filter(Boolean).join(' • ');
}

/**
 * بطاقة موحّدة لكل رسائل البوت (نجاح/تحذير/خطأ/معلومة).
 * - تقصّ العنوان والوصف على حدود ديسكورد بدل أن يفشل الرد بالكامل.
 * - تُسقط الحقول الفارغة وترتّب الأزواج inline في شبكة ثلاثية (kit.pairs).
 * - تُضيف تذييلاً موحّداً يحمل هوية البوت ووقتاً نسبياً إن لم يُمرَّر تذييل.
 */
function card({
  title, description = null, fields = [], color = COLORS.primary,
  footer = undefined, author = null, thumbnail = null, image = null, time = true,
} = {}) {
  const e = embed(title, description, color);
  const clean = (Array.isArray(fields) ? fields : [fields])
    .filter(f => f && f.name && f.value != null && String(f.value).trim() !== '')
    .slice(0, LIMITS.fields)
    .map(f => ({ name: clip(f.name, LIMITS.name), value: clip(f.value, LIMITS.value), inline: f.inline !== false }));
  if (clean.length) e.addFields(...pairs(clean));
  if (author) e.setAuthor(author);
  if (thumbnail) e.setThumbnail(thumbnail);
  if (image) e.setImage(image);
  e.setFooter({ text: clip(footer === undefined ? footerLine(null, { time }) : footer, LIMITS.footer) });
  return e;
}

const NOTE = {
  success: { emoji: '✅', color: COLORS.success },
  error: { emoji: '❌', color: COLORS.danger },
  warning: { emoji: '⚠️', color: COLORS.warning },
  info: { emoji: 'ℹ️', color: COLORS.info },
  neutral: { emoji: '▫️', color: COLORS.gray },
};

/** بطاقة حالة جاهزة: notice('success', 'تم الحفظ', '…') */
function notice(kind, title, description = null, { color = null, fields = [], footer, emoji = null } = {}) {
  const note = NOTE[kind] || NOTE.info;
  return card({
    title: `${emoji || note.emoji} ${title}`, description, fields,
    color: color || note.color, footer,
  });
}

const emptyEmbed = (title, hint, color = 0x99aab5) => ({ title, hint, color });

/** تقسيم النص إلى كتل لا تتجاوز حداً معيّناً */
function chunkLines(lines, maxChars = 1024) {
  const out = [];
  let current = '';
  for (const line of lines) {
    if (!line) continue;
    if (current && current.length + line.length + 1 > maxChars) { out.push(current); current = line; }
    else current = current ? `${current}\n${line}` : line;
  }
  if (current) out.push(current);
  return out;
}

function trim(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s;
}

function bullet(items, { prefix = '•', max = 10 } = {}) {
  const list = (items || []).filter(Boolean);
  if (!list.length) return '_لا يوجد_';
  const shown = list.slice(0, max);
  const rest = list.length - shown.length;
  return shown.map(i => `${prefix} ${i}`).join('\n') + (rest > 0 ? `\n_… و${rest} آخرين_` : '');
}

/** حقول inline أزواج-أزواج (يُ padded لتفادي كسر التنسيق) */
function pairs(items) {
  const fields = items.filter(Boolean);
  while (fields.length % 3 !== 0) fields.push({ name: '\u200b', value: '\u200b', inline: true });
  return fields;
}

function confirmRow({ confirmId, confirmLabel = 'تأكيد', confirmEmoji = '✅', style = ButtonStyle.Danger, cancelId = 'ui:cancel', cancelLabel = 'إلغاء' }) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(confirmId).setLabel(confirmLabel).setEmoji(confirmEmoji).setStyle(style),
    new ButtonBuilder().setCustomId(cancelId).setLabel(cancelLabel).setEmoji('↩️').setStyle(ButtonStyle.Secondary),
  );
}

module.exports = {
  ComponentType,
  tsDate, tsRelative, dateLine, toEpoch, daysFromToday, relativeDays, startOfDay, plural, daysWord, itemsWord,
  CHIP, chip, checkLine, progressBar, coverageBar,
  paginate, navRow, cid, button, selectMenu, groupedSelect, emptyEmbed, chunkLines, trim, bullet, pairs, confirmRow,
  BRAND, LIMITS, clip, stamp, footerLine, card, notice,
};
