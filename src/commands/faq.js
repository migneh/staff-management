'use strict';
const forms = require('../ui/forms');
const {
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, ChannelType,
} = require('discord.js');
const { LEVELS, FAQ_CATEGORIES } = require('../constants');
const faq = require('../services/faq');
const audit = require('../services/audit');
const { embed, COLORS, replyEphemeral, truncate, sendToChannel } = require('../utils');
const { isServerManager } = require('../services/permissions');
const kit = require('../ui/kit');

const categoryChoices = FAQ_CATEGORIES.map(c => ({ name: `${c.id}. ${c.name}`, value: c.id }));
const allCategoryIds = () => FAQ_CATEGORIES.map(c => c.id);
/** نطاق التصنيفات للرسائل — يُشتق من القائمة فلا يتقادم عند إضافة/حذف تصنيف. */
const categoryRange = () => `1-${FAQ_CATEGORIES.length}`;

function templateOrDefault(id) { return faq.template(Number(id) || 0) || faq.DEFAULT_TEMPLATE; }

/** هل يملك هذا المتفاعل صلاحية إدارة قاعدة المعرفة؟ (لعرض زر السجل لمن يستخدمه فعلاً) */
function canManage(i) {
  const level = i.staffLevel || (isServerManager(i.member) ? LEVELS.GENERAL_MANAGER : 0);
  return level >= LEVELS.MANAGEMENT;
}

// ===== بناء لوحة مستقلة لكل قالب =====
function buildPanel(templateId = 0) {
  const t = templateOrDefault(templateId);
  const entries = faq.listForTemplate(t.id);
  // التصنيفات التي فيها مدخلات ظاهرة فقط — لا نعرض تصنيفاً فارغاً في اللوحة أو في القائمة.
  const categories = faq.activeCategories(t.id, entries);
  const emptyCategories = faq.templateCategories(t.id).length - categories.length;
  const important = entries.filter(x => x.is_important).length;
  const suffix = t.id ? `:${t.id}` : '';
  const noteLine = t.note ? `\n> ℹ️ ${t.note}` : '';
  const catLines = categories.map(c => `\`${String(c.id).padStart(2, '0')}\` ${c.name} · **${c.count}**`);
  const e = embed(t.title, `${t.description || 'اختر تصنيفاً من القائمة لعرض المدخلات.'}${noteLine}`, t.color)
    .addFields(
      { name: '📂 التصنيفات', value: catLines.slice(0, 6).join('\n') || '_لا توجد مدخلات بعد_', inline: true },
      { name: '\u200b', value: catLines.slice(6).join('\n') || (emptyCategories ? `_… و${emptyCategories} تصنيف بلا مدخلات_` : '\u200b'), inline: true },
      { name: '\u200b', value: `📦 **${entries.length}** مدخل${t.pinnedIds.length ? ` · 📌 **${t.pinnedIds.length}** مثبت` : ''}${t.excludedIds.length ? ` · 🙈 **${t.excludedIds.length}** مخفي` : ''} • ❗ **${important}** يتطلب تأكيد قراءة` },
    );
  if (t.id) e.setFooter({ text: `قالب #${t.id} — ${t.name} • تتحدث لوحات هذا القالب فقط عند تعديله` });
  else e.setFooter({ text: 'اللوحة الافتراضية • تتحدث عند تعديل أي مدخل' });

  const hasEntries = categories.length > 0;
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:cat${suffix}`)
    .setPlaceholder(hasEntries ? '📂 اختر التصنيف...' : 'لا توجد مدخلات في هذا القالب')
    .setDisabled(!hasEntries)
    .addOptions(hasEntries
      ? categories.map(c => ({ label: c.name, value: String(c.id), description: truncate(`${c.desc} · ${c.count} مدخل`, 90), emoji: '📄' }))
      : [{ label: 'لا يوجد', value: '0', description: 'القالب فارغ' }]);
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`faq:all${suffix}`).setLabel('عرض الكل').setEmoji('📋').setStyle(ButtonStyle.Primary).setDisabled(!hasEntries),
    new ButtonBuilder().setCustomId(`faq:search${suffix}`).setLabel('بحث').setEmoji('🔍').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`faq:unread${suffix}`).setLabel('غير المقروءة').setEmoji('📌').setStyle(ButtonStyle.Danger),
  );
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu), buttons] };
}

/**
 * تحديث اللوحات المنشورة.
 * @param {number|number[]|null} templateId قالب/قوالب محددة، أو null = كل اللوحات.
 */
async function refreshPanels(client, templateId = null) {
  let ok = 0;
  const ids = templateId == null ? null : [...new Set((Array.isArray(templateId) ? templateId : [templateId]).map(id => Number(id) || 0))];
  const list = ids ? faq.panels().filter(p => ids.includes(Number(p.template_id) || 0)) : faq.panels();
  for (const p of list) {
    try {
      const ch = await client.channels.fetch(p.channel_id);
      const msg = await ch.messages.fetch(p.message_id);
      await msg.edit(buildPanel(p.template_id || 0));
      faq.updatePanelSync(p.message_id, true);
      ok++;
    } catch {
      // لا نحذف تلقائياً — نعلّمها كخطأ ليُصلحها المسؤول من /faq-panels
      try { faq.updatePanelSync(p.message_id, false); } catch {}
    }
  }
  return ok;
}

function entryEmbed(entry, userId, { canManage: manage = false } = {}) {
  const cat = faq.category(entry.category_id);
  const e = embed(`${entry.is_important ? '📌 ' : ''}${entry.title}`, entry.content, entry.is_important ? COLORS.warning : COLORS.info)
    .setFooter({ text: `#${entry.id} • ${cat?.name || '—'} • الإصدار ${entry.version}` });
  const row = new ActionRowBuilder();
  if (entry.is_important) {
    const read = userId ? faq.hasRead(entry.id, userId) : false;
    row.addComponents(new ButtonBuilder().setCustomId(`faq:ack:${entry.id}`).setLabel(read ? 'تمت القراءة ✓' : 'تأكيد القراءة')
      .setEmoji('✅').setStyle(read ? ButtonStyle.Success : ButtonStyle.Secondary).setDisabled(read));
  }
  // زر السجل للإدارة فقط — لا نعرض زراً يرفضه البوت عند الضغط عليه.
  if (manage) row.addComponents(new ButtonBuilder().setCustomId(`faq:hist:${entry.id}`).setLabel('السجل').setEmoji('🕘').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: row.components.length ? [row] : [] };
}

function listEmbed(entries, title, { templateId = 0 } = {}) {
  if (!entries.length) return embed(title, '_لا توجد مدخلات تطابق هذا العرض._\n\n💡 جرّب تصنيفاً آخر أو استخدم **بحث**.', COLORS.gray);
  const byCat = {};
  for (const en of entries) (byCat[en.category_id] ||= []).push(en);
  const t = templateOrDefault(templateId);
  const e = embed(title, null, COLORS.info);
  for (const [cid, list] of Object.entries(byCat)) {
    const lines = list.map(x => {
      const pin = t.pinnedIds.includes(x.id) ? '📌 ' : '';
      const imp = x.is_important ? '❗ ' : '';
      return `\`#${x.id}\` ${pin}${imp}${x.title}`;
    });
    // قسّم الحقل إن تجاوز الحد
    const chunks = kit.chunkLines(lines, 1024);
    chunks.forEach((chunk, idx) => {
      e.addFields({ name: idx === 0 ? `📂 ${faq.category(cid)?.name || cid}` : `↳ ${faq.category(cid)?.name || cid} (تابع)`, value: chunk });
    });
  }
  if (entries.length >= 25) e.setFooter({ text: 'يُعرض أول 25 نتيجة — استخدم البحث لتضييق النتائج.' });
  return e;
}

function entrySelectRow(entries, templateId = 0, placeholder = 'اختر مدخلاً لعرضه...') {
  if (!entries.length) return [];
  const suffix = Number(templateId) ? `:${Number(templateId)}` : '';
  const t = templateOrDefault(templateId);
  const options = entries.slice(0, 25).map(x => ({
    label: truncate(`${t.pinnedIds.includes(x.id) ? '📌 ' : ''}#${x.id} ${x.title}`, 100),
    value: String(x.id),
    description: truncate(x.content.replace(/\s+/g, ' '), 90),
    emoji: x.is_important ? '❗' : '📄',
  }));
  const menu = new StringSelectMenuBuilder().setCustomId(`faq:view${suffix}`).setPlaceholder(placeholder).addOptions(options);
  return [new ActionRowBuilder().addComponents(menu)];
}

function templateListEmbed(page = 1) {
  const rows = faq.templates();
  if (!rows.length) return embed('🧩 قوالب FAQ', 'لا توجد قوالب مخصصة بعد.\n\nاستخدم **/faq-template-create** لإنشاء أول قالب — كل قالب يمكن نشره في **روم مختلف** وتعديله **وحده** دون لمس القوالب الأخرى.', COLORS.gray);
  const { items, pages, total } = kit.paginate(rows, page, 5);
  const e = embed('🧩 قوالب FAQ — كل قالب مستقل برومه', items.map(t => {
    const cats = t.categoryIds.length === FAQ_CATEGORIES.length ? 'كل التصنيفات' : `${t.categoryIds.length} تصنيفات`;
    const panels = faq.panels({ templateId: t.id }).length;
    const extra = [
      t.pinnedIds.length ? `📌 ${t.pinnedIds.length} مثبت` : null,
      t.excludedIds.length ? `🙈 ${t.excludedIds.length} مخفي` : null,
      t.note ? `ℹ️ ملاحظة` : null,
    ].filter(Boolean).join(' • ');
    return `**#${t.id} — ${t.name}**\n╰ ${t.title} • ${cats} • **${panels}** لوحة • الإصدار ${t.version}${extra ? `\n╰ ${extra}` : ''}`;
  }).join('\n\n'), COLORS.info)
    .setFooter({ text: `صفحة ${page}/${pages} • ${total} قالب • كل قالب يحدّث لوحاته فقط` });
  return e;
}

function panelsEmbed(templateId = null, page = 1) {
  const all = templateId != null ? faq.panels({ templateId: Number(templateId) }) : faq.panels();
  if (!all.length) return embed('📌 لوحات FAQ المنشورة', templateId != null ? `لا توجد لوحات للقالب **#${templateId}**.` : 'لا توجد لوحات منشورة بعد. استخدم **/faq-template-send** أو **/faq-panel**.', COLORS.gray);
  const { items, pages, total } = kit.paginate(all, page, 8);
  const e = embed(templateId != null ? `📌 لوحات القالب #${templateId}` : '📌 كل لوحات FAQ', items.map(p => {
    const t = templateOrDefault(p.template_id);
    // الاسم نص حر من مسؤول — ننظّفه قبل عرضه داخل الإمبد.
    const label = p.label ? ` — ${truncate(String(p.label).replace(/\s+/g, ' ').trim(), 40)}` : '';
    const sync = p.sync_status === 'error' ? '⚠️ خطأ مزامنة' : '✅';
    return `${sync} <#${p.channel_id}> • \`${String(p.message_id).slice(-6)}\` • **${t.name}**${label} • <t:${Math.floor(Date.parse(p.created_at.replace(' ', 'T') + 'Z') / 1000)}:R>`;
  }).join('\n'), COLORS.info)
    .setFooter({ text: `صفحة ${page}/${pages} • ${total} لوحة` });
  return e;
}

/**
 * قراءة اختيار التصنيفات: «all»/«الكل» أو القائمة الفارغة = كل التصنيفات.
 * «كل التصنيفات» يتقدم على أي اختيار آخر مهما كان ترتيبه في القائمة.
 * @returns {number[]|null} null = اختيار غير صالح.
 */
function parseCategories(raw) {
  const tokens = String(raw || '').split(/[،,\s]+/).map(s => s.trim()).filter(Boolean);
  if (!tokens.length || tokens.some(tok => /^(all|الكل)$/i.test(tok))) return allCategoryIds();
  const ids = [...new Set(tokens.map(Number))];
  return ids.length && ids.every(id => faq.category(id)) ? ids : null;
}

function parseColor(raw, fallback = faq.DEFAULT_TEMPLATE.color) {
  const value = String(raw || '').trim().replace(/^#/, '').replace(/^0x/i, '');
  if (!value) return fallback;
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return Number.parseInt(value, 16);
}

function parseEntryIds(raw) {
  const value = String(raw || '').trim();
  if (!value) return [];
  const ids = [...new Set(value.split(/[،,\s]+/).filter(Boolean).map(Number))].filter(Number.isInteger);
  return ids;
}

/* ===== نماذج قاعدة المعرفة ===== */
/** كل التصنيفات — لإضافة/تعديل مدخل: يجب أن يبقى اختيار تصنيف فارغ ممكناً. */
const categoryOptions = FAQ_CATEGORIES.map(c => ({ label: c.name, value: String(c.id), description: c.desc }));
/**
 * التصنيفات التي فيها مدخلات فعلاً (+ المختارة حالياً في القالب) — لقائمة القالب فقط،
 * فلا يُطلب من المسؤول اختيار تصنيف لا يعرض شيئاً.
 */
function populatedCategoryOptions(selected = []) {
  return faq.populatedCategories(selected).map(c => ({
    label: c.name,
    value: String(c.id),
    description: truncate(c.count ? `${c.desc} · ${c.count} مدخل` : `${c.desc} · فارغ حالياً (مختار في هذا القالب)`, 100),
  }));
}
/** خيارات المدخلات لقوائم التثبيت/الإخفاء: الاسم بدل الرقم، مع احتياط نصي إن زادت عن 25. */
const entryOptions = (entries, picked = []) => entries.slice(0, 25).map(e => ({
  label: `#${e.id} — ${truncate(e.title, 60)}`,
  value: String(e.id),
  ...(picked.includes(e.id) ? { description: 'مثبّت حالياً' } : {}),
}));

const modals = {
  template: ({ id, prefill = {} } = {}) => ({
    id: id ? `faq:template-editmodal:${id}` : 'faq:template-addmodal',
    title: id ? `✏️ تعديل قالب #${id}` : '🆕 إنشاء قالب FAQ',
    fields: [
      forms.field({ id: 'name', label: 'اسم القالب', max: 80, value: prefill.name,
        description: 'اسم داخلي للتمييز بين القوالب؛ لا يظهر للأعضاء.' }),
      forms.field({ id: 'title', label: 'عنوان اللوحة', max: 256, value: prefill.title,
        description: 'العنوان الذي يظهر للأعضاء أعلى اللوحة.' }),
      forms.field({ id: 'description', label: 'وصف اللوحة', required: false, style: 'paragraph', max: 1000, value: prefill.description,
        description: 'اختياري: سطر يشرح محتوى اللوحة تحت العنوان.' }),
      forms.select({ id: 'categories', label: 'التصنيفات الظاهرة', required: false,
        options: [
          { label: 'كل التصنيفات', value: 'all', description: 'أو اترك القائمة فارغة تماماً — النتيجة نفسها.' },
          ...populatedCategoryOptions(prefill.categoryIds),
        ],
        multiple: true, max: FAQ_CATEGORIES.length + 1, values: (prefill.categoryIds || []).map(String),
        description: 'اختياري — اتركه فارغاً لعرض كل التصنيفات. يُعرض ما فيه مدخلات فقط.' }),
      forms.field({ id: 'color', label: 'لون اللوحة', max: 20,
        value: prefill.color != null ? `#${Number(prefill.color).toString(16).padStart(6, '0')}` : '#5865F2',
        description: 'صيغة Hex مثل #5865F2.', placeholder: '#5865F2' }),
    ],
    note: 'القالب يحدد ما يراه الأعضاء في الروم؛ يمكن تثبيت مدخلات أو إخفاؤها لاحقاً من أزرار القالب.',
  }),
  entry: ({ id, prefill = {} } = {}) => ({
    id: id ? `faq:editmodal:${id}` : 'faq:addmodal',
    title: id ? `✏️ تعديل المدخل #${id}` : '🆕 إضافة مدخل',
    fields: [
      forms.field({ id: 'title', label: 'عنوان المدخل', max: 100, value: prefill.title,
        description: 'عنوان قصير يظهر في قائمة المدخلات والبحث.' }),
      forms.field({ id: 'content', label: 'المحتوى', style: 'paragraph', max: 4000, value: prefill.content,
        description: 'التعليمات كاملة. يدعم تنسيق ديسكورد (غامق، قوائم، روابط).' }),
      forms.select({ id: 'category', label: 'التصنيف', options: categoryOptions,
        values: prefill.category_id ? [String(prefill.category_id)] : [],
        description: 'اختر التصنيف بالاسم؛ يُحدد مكان ظهور المدخل في اللوحة.' }),
      forms.select({ id: 'important', label: 'يحتاج تأكيد قراءة؟', required: true,
        options: [
          { label: 'نعم — تعليمات مهمة', value: 'نعم', description: 'يجب أن يضغط العضو «تم القراءة».' },
          { label: 'لا — مرجع اختياري', value: 'لا' },
        ],
        values: [prefill.is_important ? 'نعم' : 'لا'],
        description: 'المدخلات المهمة تظهر للأعضاء حتى يؤكدوا قراءتها.' }),
    ],
    note: 'أي تعديل يرفع إصدار المدخل ويطلب من الأعضاء تأكيد القراءة من جديد إن كان مهماً.',
  }),
  search: ({ templateId } = {}) => ({
    id: `faq:searchmodal${Number(templateId) ? `:${Number(templateId)}` : ''}`,
    title: '🔍 بحث في قاعدة المعرفة',
    fields: [
      forms.field({ id: 'q', label: 'كلمة البحث', min: 2, max: 60,
        description: 'ابحث في العنوان والمحتوى، مثل «إجازة» أو «تكت».' }),
    ],
    note: 'البحث يحترم قالب هذا الروم: لا يعرض المدخلات المخفية فيه.',
  }),
  pin: ({ id, entries = [], current = [] } = {}) => ({
    id: `faq:cfgpinmodal:${id}`,
    title: `📌 تثبيت مدخلات — قالب #${id}`,
    fields: entries.length && entries.length <= 25
      ? [forms.select({ id: 'ids', label: 'المدخلات التي تُعرض أولاً', options: entryOptions(entries, current), multiple: true, required: false,
          values: current.map(String), description: 'التثبيت يرفع المدخلات للأعلى ولا يمنع بقية المدخلات من الظهور.' })]
      : [forms.field({ id: 'ids', label: entries.length ? 'أرقام المدخلات' : 'لا توجد مدخلات بعد', max: 200, required: entries.length > 0,
          description: entries.length ? 'المدخلات كثيرة: اكتب الأرقام مفصولة بفواصل مثل 3, 7, 12.' : 'أضف مدخلاً للقالب أولاً، ثم ثبّته من هنا.' })],
    note: entries.length <= 25 ? 'اختر حتى 25 مدخلاً، ويمكن تعديل الاختيار لاحقاً.' : undefined,
  }),
  hide: ({ id, entries = [], current = [] } = {}) => ({
    id: `faq:cfghidemodal:${id}`,
    title: `🙈 إخفاء مدخلات — قالب #${id}`,
    fields: entries.length && entries.length <= 25
      ? [forms.select({ id: 'ids', label: 'المدخلات المخفية في هذا القالب', options: entryOptions(entries), multiple: true, required: false,
          values: current.map(String), description: 'الإخفاء يخص هذا القالب فقط ولا يحذف المدخل.' })]
      : [forms.field({ id: 'ids', label: entries.length ? 'أرقام المدخلات المخفية' : 'لا توجد مدخلات بعد', max: 200, required: entries.length > 0,
          description: entries.length ? 'اكتب الأرقام مفصولة بفواصل مثل 3, 7, 12.' : 'لا يوجد ما يمكن إخفاؤه في هذا القالب حالياً.' })],
    note: 'استخدم «مسح التثبيت والإخفاء» لترتيب القالب من جديد.',
  }),
  note: ({ id, current } = {}) => ({
    id: `faq:cfgenotemodal:${id}`,
    title: `ℹ️ ملاحظة اللوحة — قالب #${id}`,
    fields: [
      forms.field({ id: 'note', label: 'نص أعلى اللوحة', required: false, style: 'paragraph', max: 500, value: current,
        description: 'يظهر في هذا الروم فقط. اتركه فارغاً لمسح الملاحظة.' }),
    ],
    note: 'الملاحظة تُحدَّث في اللوحة فوراً دون تغيير المدخلات.',
  }),
};

function readTemplateFields(i) {
  const categoryIds = parseCategories(forms.value(i, 'categories'));
  if (!categoryIds) return { error: `❌ التصنيفات غير صحيحة. استخدم all أو أرقاماً من ${categoryRange()} مفصولة بفواصل.` };
  const color = parseColor(forms.value(i, 'color').split(/\s+/)[0] || '');
  if (color == null) return { error: '❌ اللون غير صحيح. استخدم صيغة Hex مثل #5865F2 في بداية الحقل.' };
  return {
    name: forms.value(i, 'name'),
    title: forms.value(i, 'title'),
    description: forms.value(i, 'description'),
    categoryIds, color,
  };
}

/** خطأ اسم مكرر في SQLite → رسالة مفهومة بدل نص الخطأ الخام. */
const isDuplicateTemplateName = (e) => /UNIQUE constraint failed: faq_templates\.name/i.test(e?.message || '');

async function notifyUpdate(client, action, entry, userId, { previousCategoryId = null } = {}) {
  const cat = faq.category(entry.category_id);
  const labels = { create: '🆕 مدخل جديد', edit: '✏️ تعديل مدخل', delete: '🗑️ حذف مدخل' };
  const e = embed(`${labels[action]} في قاعدة المعرفة`, `**${entry.title}**\n📂 ${cat?.name}\n👤 بواسطة <@${userId}>\n🆔 \`#${entry.id}\` • الإصدار ${entry.version}`,
    action === 'delete' ? COLORS.danger : COLORS.success);
  await sendToChannel(client, 'staff-updates', { embeds: [e] });
  // نُحدّث لوحات القوالب التي تعرض هذا المدخل فقط — لا كل لوحات السيرفر في كل تعديل.
  await refreshPanels(client, faq.templatesShowing(entry, previousCategoryId));
}

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('faq').setDescription('عرض قاعدة المعرفة (القوانين والتعليمات)')
        .addIntegerOption(o => o.setName('category').setDescription('التصنيف').addChoices(...categoryChoices)),
      level: LEVELS.STAFF,
      async execute(i) {
        const cid = i.options.getInteger('category');
        if (!cid) return i.reply({ ...buildPanel(0), ephemeral: true });
        // قد يصل رقم غير موجود (لوحة قديمة أو طلب مُعدّل) — نتحقق بدل الانهيار.
        const cat = faq.category(cid);
        if (!cat) return replyEphemeral(i, `❌ التصنيف غير موجود. المتاح: ${FAQ_CATEGORIES.map(c => `**${c.id}** ${c.name}`).join('، ')}.`, COLORS.danger);
        const entries = faq.list(cat.id);
        return i.reply({ embeds: [listEmbed(entries, `📂 ${cat.name}`)], components: entrySelectRow(entries, 0), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-list').setDescription('عرض كل مدخلات قاعدة المعرفة'),
      level: LEVELS.STAFF,
      async execute(i) {
        const entries = faq.list();
        return i.reply({ embeds: [listEmbed(entries, '📋 كل المدخلات')], components: entrySelectRow(entries, 0), ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-add').setDescription('إضافة مدخل جديد إلى قاعدة المعرفة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return forms.open(i, modals.entry()); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-edit').setDescription('تعديل مدخل في قاعدة المعرفة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم المدخل').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const entry = faq.get(i.options.getInteger('id'));
        if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
        return forms.open(i, modals.entry({ id: entry.id, prefill: entry }));
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-delete').setDescription('حذف مدخل من قاعدة المعرفة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم المدخل').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const entry = faq.get(i.options.getInteger('id'));
        if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:delconfirm:${entry.id}`).setLabel('تأكيد الحذف').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('faq:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
        return i.reply({ embeds: [embed('⚠️ تأكيد الحذف', `هل تريد حذف **${entry.title}** (#${entry.id})؟\nسيبقى محفوظاً في سجل التاريخ وسيُزال من القوالب المثبتة/المخفية.`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-panel').setDescription('نشر اللوحة الافتراضية في هذه القناة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        try {
          const msg = await i.channel.send(buildPanel(0));
          faq.addPanel(msg.id, i.channelId, i.user.id, 0);
          return replyEphemeral(i, '✅ تم نشر اللوحة الافتراضية. استخدم قوالب FAQ إذا أردت لوحات مستقلة — كل قالب يُنشر في رومه ويُعدّل وحده.', COLORS.success);
        } catch (e) { return replyEphemeral(i, `❌ لم أستطع النشر في هذه القناة: ${e.message}`, COLORS.danger); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-create').setDescription('إنشاء قالب FAQ مستقل (لكل روم قالب)'),
      level: LEVELS.MANAGEMENT,
      async execute(i) { return forms.open(i, modals.template()); },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-list').setDescription('عرض قوالب FAQ المستقلة'),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const e = templateListEmbed(1);
        const rows = faq.templates();
        if (!rows.length) return i.reply({ embeds: [e], ephemeral: true });
        const { pages } = kit.paginate(rows, 1, 5);
        const nav = pages > 1 ? [kit.navRow({ prefix: 'faq:tmpllist', page: 1, pages })] : [];
        return i.reply({ embeds: [e], components: nav, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-edit').setDescription('تعديل قالب FAQ — يحدّث لوحات هذا القالب فقط')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود أو لا يمكن تعديل الافتراضي.', COLORS.danger);
        return forms.open(i, modals.template({ id: t.id, prefill: t }));
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-send').setDescription('نشر قالب FAQ في أي قناة — كل قالب برومه')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true))
        .addChannelOption(o => o.setName('channel').setDescription('القناة التي ستُنشر فيها اللوحة').setRequired(true).addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
        .addStringOption(o => o.setName('label').setDescription('اسم يميّز هذه اللوحة (اختياري)').setRequired(false).setMaxLength(60)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const id = i.options.getInteger('id');
        const t = faq.template(id);
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const channel = i.options.getChannel('channel');
        const label = i.options.getString('label') || null;
        try {
          const msg = await channel.send(buildPanel(t.id));
          faq.addPanel(msg.id, channel.id, i.user.id, t.id, { label });
          audit.record({ action: 'faq_template_published', actorId: i.user.id, details: { templateId: t.id, channelId: channel.id, messageId: msg.id, label }, channelId: i.channelId });
          return replyEphemeral(i, `✅ تم نشر القالب **#${t.id} — ${t.name}** في <#${channel.id}>${label ? ` باسم «${label}»` : ''}.\nتعديل هذا القالب سيحدّث لوحاته فقط — باقي القوالب لا تتأثر.`, COLORS.success);
        } catch (e) { return replyEphemeral(i, `❌ لم أستطع النشر في القناة: ${e.message}`, COLORS.danger); }
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-delete').setDescription('حذف قالب FAQ وإرجاع لوحاته للافتراضي')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود أو لا يمكن حذف الافتراضي.', COLORS.danger);
        const panels = faq.panels({ templateId: t.id });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:templatedelconfirm:${t.id}`).setLabel('تأكيد حذف القالب').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
          new ButtonBuilder().setCustomId('faq:cancel').setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
        return i.reply({ embeds: [embed('⚠️ حذف قالب FAQ', `هل تريد حذف **${t.name}** (#${t.id})؟\n${panels.length ? `لديه **${panels.length}** لوحة منشورة — ستصبح افتراضية ولن تُحذف رسائلها.` : 'لا توجد لوحات منشورة له.'}`, COLORS.warning)], components: [row], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-panels').setDescription('عرض كل لوحات FAQ المنشورة وحالتها')
        .addIntegerOption(o => o.setName('template').setDescription('تصفية بقالب محدد').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const tid = i.options.getInteger('template');
        if (tid != null && !faq.template(tid)) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const e = panelsEmbed(tid, 1);
        const all = tid != null ? faq.panels({ templateId: tid }) : faq.panels();
        const { pages } = kit.paginate(all, 1, 8);
        const nav = pages > 1 ? [kit.navRow({ prefix: `faq:panels:${tid ?? 'all'}`, page: 1, pages })] : [];
        return i.reply({ embeds: [e], components: nav, ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-template-config').setDescription('إعداد متقدم للقالب: تثبيت/إخفاء مدخلات وملاحظة اللوحة')
        .addIntegerOption(o => o.setName('id').setDescription('رقم القالب').setRequired(true)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        const t = faq.template(i.options.getInteger('id'));
        if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        const e = embed(`⚙️ إعداد القالب #${t.id} — ${t.name}`, [
          `**العنوان:** ${t.title}`,
          `**التصنيفات:** ${faq.templateCategories(t.id).map(c => c.name).join('، ') || '_كل التصنيفات_'}`,
          `**📌 مثبت:** ${t.pinnedIds.length ? t.pinnedIds.map(id => `\`#${id}\``).join(', ') : '_لا يوجد_'}`,
          `**🙈 مخفي:** ${t.excludedIds.length ? t.excludedIds.map(id => `\`#${id}\``).join(', ') : '_لا يوجد_'}`,
          `**ℹ️ ملاحظة اللوحة:** ${t.note || '_لا يوجد_'}`,
          `**اللون:** \`#${Number(t.color).toString(16).padStart(6, '0')}\``,
          '',
          'استخدم الأزرار أدناه للتعديل — كل تغيير يحدّث **لوحات هذا القالب فقط**.',
        ].join('\n'), COLORS.info);
        const row1 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:cfgpin:${t.id}`).setLabel('تثبيت مدخلات').setEmoji('📌').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`faq:cfghide:${t.id}`).setLabel('إخفاء مدخلات').setEmoji('🙈').setStyle(ButtonStyle.Secondary),
          new ButtonBuilder().setCustomId(`faq:cfgnote:${t.id}`).setLabel('ملاحظة اللوحة').setEmoji('ℹ️').setStyle(ButtonStyle.Secondary),
        );
        const row2 = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`faq:cfgclear:${t.id}`).setLabel('مسح التثبيت/الإخفاء').setEmoji('🧹').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`faq:cfgrefresh:${t.id}`).setLabel('تحديث لوحاته').setEmoji('🔄').setStyle(ButtonStyle.Primary),
        );
        return i.reply({ embeds: [e], components: [row1, row2], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('faq-refresh').setDescription('تحديث لوحات FAQ')
        .addIntegerOption(o => o.setName('template').setDescription('قالب محدد فقط (اختياري)').setRequired(false)),
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const tid = i.options.getInteger('template');
        const n = await refreshPanels(i.client, tid);
        const label = tid ? ` للقالب #${tid}` : '';
        return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة${label}.`, COLORS.success);
      },
    },
  ],

  components: {
    'faq:cat': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const cid = Number(i.values?.[0]);
      // لوحة قديمة قد تحمل تصنيفاً حُذف أو الخيار الفارغ «0» — نتحقق بدل الانهيار.
      const cat = faq.category(cid);
      if (!cat) return replyEphemeral(i, '❌ هذا التصنيف لم يعد متاحاً في هذه اللوحة. اطلب من الإدارة `/faq-refresh` لتحديثها.', COLORS.danger);
      const entries = faq.listForTemplate(t.id, cat.id);
      return i.reply({ embeds: [listEmbed(entries, `📂 ${cat.name} • ${t.name}`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:view': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entry = faq.get(Number(i.values?.[0]));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      // نحترم نطاق اللوحة: مدخل مخفي أو خارج تصنيفات القالب لا يُفتح من لوحتها.
      if (!faq.isVisibleIn(t.id, entry)) return replyEphemeral(i, '❌ هذا المدخل غير متاح في هذه اللوحة.', COLORS.danger);
      return i.reply({ ...entryEmbed(entry, i.user.id, { canManage: canManage(i) }), ephemeral: true });
    },
    'faq:all': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entries = faq.listForTemplate(t.id);
      return i.reply({ embeds: [listEmbed(entries, `📋 ${t.name} — كل المدخلات`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:unread': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const entries = faq.unreadFor(i.user.id, { templateId: t.id });
      const e = entries.length ? listEmbed(entries, `📌 ${t.name} — مدخلات مهمة لم تقرأها بعد`, { templateId: t.id }).setColor(COLORS.warning) : embed('✅ ممتاز', 'قرأت كل المدخلات المهمة في هذا القالب.', COLORS.success);
      return i.reply({ embeds: [e], components: entrySelectRow(entries, t.id, 'اختر مدخلاً لقراءته وتأكيده...'), ephemeral: true });
    },
    'faq:search': async (i, [templateId]) => forms.open(i, modals.search({ templateId })),
    'faq:searchmodal': async (i, [templateId]) => {
      const t = templateOrDefault(templateId);
      const q = forms.value(i, 'q');
      if (q.trim().length < 2) return replyEphemeral(i, '❌ كلمة البحث قصيرة جداً — اكتب حرفين على الأقل.', COLORS.danger);
      const entries = faq.search(q, { templateId: t.id });
      return i.reply({ embeds: [listEmbed(entries, `🔍 ${t.name} — نتائج البحث عن: ${q}`, { templateId: t.id })], components: entrySelectRow(entries, t.id), ephemeral: true });
    },
    'faq:ack': async (i, [id]) => {
      const entry = faq.get(Number(id));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      faq.acknowledge(entry.id, i.user.id, entry.version);
      // زر غير مفعّل بعد التأكيد
      const updated = entryEmbed(entry, i.user.id, { canManage: canManage(i) });
      try { return await i.update(updated); } catch { return i.reply({ ...updated, ephemeral: true }); }
    },
    'faq:hist': async (i, [id]) => {
      const entry = faq.get(Number(id));
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      const hist = faq.history(entry.id).slice(0, 8);
      if (!hist.length) return replyEphemeral(i, 'لا يوجد سجل لهذا المدخل.', COLORS.gray);
      const e = embed(`🕘 سجل المدخل #${entry.id}`, hist.map(h => `\`v${h.version}\` **${h.action}** — <@${h.changed_by}> • <t:${Math.floor(Date.parse(h.changed_at.replace(' ', 'T') + 'Z') / 1000)}:R>`).join('\n'), COLORS.gray);
      return i.reply({ embeds: [e], ephemeral: true });
    },
    'faq:addmodal': async (i) => {
      const categoryId = Number(forms.value(i, 'category'));
      const cat = faq.category(categoryId);
      if (!cat) return replyEphemeral(i, `❌ التصنيف غير صحيح — اختر رقماً من ${categoryRange()}.`, COLORS.danger);
      const important = /^(نعم|y|yes|1)$/i.test(forms.value(i, 'important'));
      try {
        const entry = faq.add({ categoryId: cat.id, title: forms.value(i, 'title'), content: forms.value(i, 'content'), important, userId: i.user.id });
        audit.record({ action: 'faq_entry_created', actorId: i.user.id, targetId: String(entry.id), details: { title: entry.title, categoryId: entry.category_id, important }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تمت إضافة المدخل **#${entry.id}** — ${cat.name}${important ? ' (📌 يتطلب تأكيد قراءة)' : ''}.`, COLORS.success);
        return notifyUpdate(i.client, 'create', entry, i.user.id);
      } catch (e) { return replyEphemeral(i, `❌ تعذّرت الإضافة: ${e.message}`, COLORS.danger); }
    },
    'faq:editmodal': async (i, [id]) => {
      const categoryId = Number(forms.value(i, 'category'));
      const cat = faq.category(categoryId);
      if (!cat) return replyEphemeral(i, `❌ التصنيف غير صحيح — اختر رقماً من ${categoryRange()}.`, COLORS.danger);
      const important = /^(نعم|y|yes|1)$/i.test(forms.value(i, 'important'));
      const before = faq.get(Number(id));
      if (!before) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      try {
        const entry = faq.edit(before.id, { categoryId: cat.id, title: forms.value(i, 'title'), content: forms.value(i, 'content'), important, userId: i.user.id });
        if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
        audit.record({ action: 'faq_entry_edited', actorId: i.user.id, targetId: String(entry.id), details: { title: entry.title, categoryId: entry.category_id, fromCategoryId: before.category_id, version: entry.version }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تم تعديل المدخل **#${entry.id}** (الإصدار ${entry.version}).`, COLORS.success);
        // لو تغيّر التصنيف: لوحات القالب القديم تحتاج تحديثاً أيضاً.
        return notifyUpdate(i.client, 'edit', entry, i.user.id, { previousCategoryId: before.category_id });
      } catch (e) { return replyEphemeral(i, `❌ تعذّر التعديل: ${e.message}`, COLORS.danger); }
    },
    'faq:template-addmodal': async (i) => {
      const fields = readTemplateFields(i);
      if (fields.error) return replyEphemeral(i, fields.error, COLORS.danger);
      try {
        const t = faq.addTemplate({ ...fields, userId: i.user.id });
        audit.record({ action: 'faq_template_created', actorId: i.user.id, targetId: String(t.id), details: { name: t.name, categoryIds: t.categoryIds }, channelId: i.channelId });
        return replyEphemeral(i, `✅ تم إنشاء القالب **#${t.id} — ${t.name}**.\nاستخدم \`/faq-template-send id:${t.id} channel:#الروم\` لنشره — كل قالب يُنشر في رومه ويُعدّل وحده.`, COLORS.success);
      } catch (e) {
        return replyEphemeral(i, isDuplicateTemplateName(e)
          ? '❌ يوجد قالب آخر بالاسم نفسه — اختر اسماً مختلفاً.'
          : `❌ تعذر إنشاء القالب: ${e.message}`, COLORS.danger);
      }
    },
    'faq:template-editmodal': async (i, [id]) => {
      const fields = readTemplateFields(i);
      if (fields.error) return replyEphemeral(i, fields.error, COLORS.danger);
      try {
        const t = faq.editTemplate(Number(id), { ...fields, userId: i.user.id });
        if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        audit.record({ action: 'faq_template_edited', actorId: i.user.id, targetId: String(t.id), details: { version: t.version, name: t.name, categoryIds: t.categoryIds }, channelId: i.channelId });
        await replyEphemeral(i, `✅ تم تعديل القالب **#${t.id}** إلى الإصدار ${t.version}. سيتم تحديث لوحاته المنشورة فقط.`, COLORS.success);
        return refreshPanels(i.client, t.id);
      } catch (e) {
        return replyEphemeral(i, isDuplicateTemplateName(e)
          ? '❌ يوجد قالب آخر بالاسم نفسه — اختر اسماً مختلفاً.'
          : `❌ تعذر تعديل القالب: ${e.message}`, COLORS.danger);
      }
    },
    'faq:templatedelconfirm': async (i, [id]) => {
      const t = faq.removeTemplate(Number(id), i.user.id);
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      audit.record({ action: 'faq_template_deleted', actorId: i.user.id, targetId: String(t.id), details: { name: t.name }, channelId: i.channelId });
      await i.update({ embeds: [embed('🗑️ تم حذف القالب', `تم حذف **${t.name}** (#${t.id}). اللوحات المرتبطة به أصبحت افتراضية.`, COLORS.danger)], components: [] });
      return refreshPanels(i.client);
    },
    'faq:delconfirm': async (i, [id]) => {
      const entry = faq.remove(Number(id), i.user.id);
      if (!entry) return replyEphemeral(i, '❌ المدخل غير موجود.', COLORS.danger);
      audit.record({ action: 'faq_entry_deleted', actorId: i.user.id, targetId: String(entry.id), details: { title: entry.title, categoryId: entry.category_id, version: entry.version }, channelId: i.channelId });
      await i.update({ embeds: [embed('🗑️ تم الحذف', `تم حذف **${entry.title}** (#${entry.id}).`, COLORS.danger)], components: [] });
      return notifyUpdate(i.client, 'delete', entry, i.user.id);
    },
    'faq:cancel': async (i) => i.update({ embeds: [embed(null, 'تم الإلغاء.', COLORS.gray)], components: [] }),

    // ===== متقدّم: تثبيت/إخفاء/ملاحظة =====
    'faq:cfgpin': async (i, [id]) => {
      const t = faq.template(Number(id));
      if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      const entries = faq.listForTemplate(t.id);
      if (!entries.length) return replyEphemeral(i, 'ℹ️ لا توجد مدخلات في هذا القالب بعد — أضف مدخلاً ثم ثبّته.', COLORS.gray);
      return forms.open(i, modals.pin({ id: t.id, entries, current: t.pinnedIds }));
    },
    'faq:cfgpinmodal': async (i, [id]) => {
      const ids = parseEntryIds(forms.value(i, 'ids'));
      const invalid = ids.filter(eid => !faq.get(eid));
      if (invalid.length) return replyEphemeral(i, `❌ هذه المدخلات غير موجودة: ${invalid.join(', ')}`, COLORS.danger);
      try {
        const t = faq.editTemplate(Number(id), { pinnedIds: ids, userId: i.user.id });
        if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        // ما كان خارج تصنيفات القالب تسقطه الخدمة — نُبلغ بالعدد الفعلي لا المطلوب.
        const skipped = ids.length - t.pinnedIds.length;
        await replyEphemeral(i, `✅ تم تثبيت **${t.pinnedIds.length}** مدخل في القالب **#${t.id}**.${skipped > 0 ? `\n⚠️ ${skipped} مدخل خارج تصنيفات هذا القالب فلم يُثبَّت.` : ''}`, COLORS.success);
        return refreshPanels(i.client, t.id);
      } catch (e) { return replyEphemeral(i, `❌ تعذّر الحفظ: ${e.message}`, COLORS.danger); }
    },
    'faq:cfghide': async (i, [id]) => {
      const t = faq.template(Number(id));
      if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      const entries = faq.listForTemplate(t.id);
      if (!entries.length) return replyEphemeral(i, 'ℹ️ لا يوجد ما يمكن إخفاؤه في هذا القالب حالياً.', COLORS.gray);
      return forms.open(i, modals.hide({ id: t.id, entries, current: t.excludedIds }));
    },
    'faq:cfghidemodal': async (i, [id]) => {
      const ids = parseEntryIds(forms.value(i, 'ids'));
      const invalid = ids.filter(eid => !faq.get(eid));
      if (invalid.length) return replyEphemeral(i, `❌ هذه المدخلات غير موجودة: ${invalid.join(', ')}`, COLORS.danger);
      try {
        const t = faq.editTemplate(Number(id), { excludedIds: ids, userId: i.user.id });
        if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        await replyEphemeral(i, `✅ تم إخفاء **${t.excludedIds.length}** مدخل في هذا القالب فقط.`, COLORS.success);
        return refreshPanels(i.client, t.id);
      } catch (e) { return replyEphemeral(i, `❌ تعذّر الحفظ: ${e.message}`, COLORS.danger); }
    },
    'faq:cfgnote': async (i, [id]) => {
      const t = faq.template(Number(id));
      if (!t || t.id === 0) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      return forms.open(i, modals.note({ id: t.id, current: t.note }));
    },
    'faq:cfgenotemodal': async (i, [id]) => {
      const note = forms.value(i, 'note');
      try {
        const t = faq.editTemplate(Number(id), { note, userId: i.user.id });
        if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
        await replyEphemeral(i, note ? '✅ تم حفظ ملاحظة اللوحة.' : '✅ تم مسح ملاحظة اللوحة.', COLORS.success);
        return refreshPanels(i.client, t.id);
      } catch (e) { return replyEphemeral(i, `❌ تعذّر الحفظ: ${e.message}`, COLORS.danger); }
    },
    'faq:cfgclear': async (i, [id]) => {
      let t = null;
      try { t = faq.editTemplate(Number(id), { pinnedIds: [], excludedIds: [], userId: i.user.id }); } catch (e) { return replyEphemeral(i, `❌ تعذّر المسح: ${e.message}`, COLORS.danger); }
      if (!t) return replyEphemeral(i, '❌ القالب غير موجود.', COLORS.danger);
      await i.update({ embeds: [embed('🧹 تم المسح', `تم مسح التثبيت والإخفاء للقالب **#${t.id}**.`, COLORS.success)], components: [] });
      return refreshPanels(i.client, t.id);
    },
    'faq:cfgrefresh': async (i, [id]) => {
      await i.deferReply({ ephemeral: true });
      const n = await refreshPanels(i.client, Number(id));
      return replyEphemeral(i, `🔄 تم تحديث **${n}** لوحة للقالب #${id}.`, COLORS.success);
    },

    // ===== ترقيم صفحات =====
    'faq:tmpllist': async (i, [page]) => {
      const rows = faq.templates();
      const { items, pages } = kit.paginate(rows, Number(page), 5);
      if (!items.length) return replyEphemeral(i, 'لا توجد قوالب.', COLORS.gray);
      const nav = pages > 1 ? [kit.navRow({ prefix: 'faq:tmpllist', page: Number(page), pages })] : [];
      return i.update({ embeds: [templateListEmbed(Number(page))], components: nav });
    },
    'faq:panels': async (i, [tid, page]) => {
      const target = tid === 'all' ? null : Number(tid);
      const all = target != null ? faq.panels({ templateId: target }) : faq.panels();
      const { pages: p } = kit.paginate(all, Number(page), 8);
      return i.update({ embeds: [panelsEmbed(target, Number(page))], components: p > 1 ? [kit.navRow({ prefix: `faq:panels:${tid}`, page: Number(page), pages: p })] : [] });
    },
  },

  refreshPanels, buildPanel, templateListEmbed, panelsEmbed, parseCategories, entryEmbed,
};
