'use strict';
const { getDb } = require('../database');
const { FAQ_CATEGORIES } = require('../constants');

/** حدود الحقول: تُفرض في النموذج وفي الخدمة معاً حتى لا تُخزَّن بيانات تكسر العرض. */
const LIMITS = { title: 100, content: 4000, name: 80, note: 500, description: 1000, searchResults: 25 };

const DEFAULT_TEMPLATE = {
  id: 0,
  name: 'اللوحة الافتراضية',
  title: '📚 قاعدة المعرفة — Staff FAQ',
  description: '> كل ما تحتاج معرفته كإداري في مكان واحد.\n> اختر تصنيفاً من القائمة، أو ابحث، أو اضغط **غير المقروءة** لترى ما ينتظرك.\n\u200b',
  categoryIds: FAQ_CATEGORIES.map(c => c.id),
  pinnedIds: [],
  excludedIds: [],
  note: '',
  color: 0x5865f2,
  version: 1,
};

function category(id) { return FAQ_CATEGORIES.find(c => c.id === Number(id)) || null; }

function parseIds(value) {
  if (Array.isArray(value)) return value.map(Number).filter(Number.isInteger);
  try { return JSON.parse(value || '[]').map(Number).filter(Number.isInteger); } catch { return []; }
}

/**
 * قائمة التصنيفات الصالحة. القائمة الفارغة تعني «كل التصنيفات» — وهذا مقصود:
 * حقل التصنيفات في القالب اختياري، وتركه فارغاً = عرض كل التصنيفات.
 * المعرّفات غير المعروفة تُسقط دائماً (تصنيف محذوف لا يعود للظهور).
 */
function normalizeCategoryIds(value) {
  const ids = [...new Set(parseIds(value))].filter(id => category(id));
  return ids.length ? ids : FAQ_CATEGORIES.map(c => c.id);
}
function normalizeEntryIds(value) {
  return [...new Set(parseIds(value))];
}
/** لون صالح لعرض ديسكورد، وأي قيمة تالفة ترجع للون الافتراضي بدل كسر الإمبد. */
function normalizeColor(value, fallback = DEFAULT_TEMPLATE.color) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 0xffffff ? n : fallback;
}

function mapTemplate(row) {
  if (!row) return null;
  return {
    ...row,
    categoryIds: normalizeCategoryIds(row.category_ids),
    pinnedIds: normalizeEntryIds(row.pinned_ids),
    excludedIds: normalizeEntryIds(row.excluded_ids),
    note: row.note || '',
    color: normalizeColor(row.color),
    category_ids: undefined, pinned_ids: undefined, excluded_ids: undefined,
  };
}

function template(id) {
  if (!Number(id)) return { ...DEFAULT_TEMPLATE, categoryIds: [...DEFAULT_TEMPLATE.categoryIds], pinnedIds: [...DEFAULT_TEMPLATE.pinnedIds], excludedIds: [...DEFAULT_TEMPLATE.excludedIds] };
  return mapTemplate(getDb().prepare('SELECT * FROM faq_templates WHERE id = ?').get(Number(id)));
}

function templates() {
  return getDb().prepare('SELECT * FROM faq_templates ORDER BY id').all().map(mapTemplate);
}

function templateCategories(id) {
  const t = template(id) || DEFAULT_TEMPLATE;
  return FAQ_CATEGORIES.filter(c => t.categoryIds.includes(c.id));
}

/**
 * التصنيفات التي فيها مدخلات ظاهرة فعلاً في هذا القالب (بعد الإخفاء).
 * هي التي تُعرض في قوائم الاختيار — لا معنى لعرض تصنيف فارغ.
 * @returns {Array<{id:number,name:string,desc:string,count:number}>}
 */
function activeCategories(id, entries = null) {
  const visible = entries || listForTemplate(id);
  const per = new Map();
  for (const e of visible) per.set(e.category_id, (per.get(e.category_id) || 0) + 1);
  return templateCategories(id).filter(c => per.has(c.id)).map(c => ({ ...c, count: per.get(c.id) }));
}

/**
 * التصنيفات التي فيها مدخلات على مستوى قاعدة المعرفة كلها (+ المختارة حالياً في
 * القالب حتى لا يسقط اختيارها عند التعديل). تُستخدم في نموذج إنشاء/تعديل القالب.
 */
function populatedCategories(selected = []) {
  const per = counts();
  const picked = new Set((selected || []).map(Number));
  return FAQ_CATEGORIES.filter(c => per[c.id] > 0 || picked.has(c.id))
    .map(c => ({ ...c, count: per[c.id] || 0 }));
}

/** هل هذا المدخل ظاهر في قالب معيّن؟ (يُستخدم لمنع فتح مدخل مخفي من لوحة قديمة) */
function isVisibleIn(templateId, entry) {
  if (!entry) return false;
  const t = template(Number(templateId) || 0) || DEFAULT_TEMPLATE;
  return t.categoryIds.includes(entry.category_id) && !t.excludedIds.includes(entry.id);
}

/**
 * القوالب التي تعرض هذا المدخل (أو كانت تعرضه قبل التعديل/الحذف) — 0 = اللوحة الافتراضية.
 * تحديث لوحات هذه القوالب يكفي، فلا نلمس باقي اللوحات ولا نستهلك حد الطلبات.
 */
function templatesShowing(entry, previousCategoryId = null) {
  const entryId = Number(entry?.id);
  const cats = [Number(entry?.category_id), Number(previousCategoryId)].filter(Number.isInteger);
  const ids = new Set([0]);
  for (const t of templates()) {
    if (cats.some(cid => t.categoryIds.includes(cid)) || t.pinnedIds.includes(entryId) || t.excludedIds.includes(entryId)) ids.add(t.id);
  }
  return [...ids];
}

function list(categoryId) {
  const db = getDb();
  return categoryId
    ? db.prepare('SELECT * FROM faq_entries WHERE category_id = ? ORDER BY id').all(categoryId)
    : db.prepare('SELECT * FROM faq_entries ORDER BY category_id, id').all();
}

/**
 * مدخلات هذا القالب فقط — تحترم pinned وexcluded الخاصة به.
 * التثبيت لا يضيف مدخلات، فقط يرفعها للأعلى. الإخفاء يزيلها من القائمة/البحث.
 */
function listForTemplate(templateId, categoryId) {
  const t = template(templateId) || DEFAULT_TEMPLATE;
  const allowed = new Set(t.categoryIds);
  const excluded = new Set(t.excludedIds);
  if (categoryId != null && !allowed.has(Number(categoryId))) return [];
  let entries = list(categoryId).filter(e => allowed.has(e.category_id) && !excluded.has(e.id));
  if (t.pinnedIds.length) {
    const order = new Map(t.pinnedIds.map((id, i) => [id, i]));
    entries = entries.slice().sort((a, b) => {
      const pa = order.has(a.id) ? order.get(a.id) : 1e9;
      const pb = order.has(b.id) ? order.get(b.id) : 1e9;
      return pa - pb || a.id - b.id;
    });
  }
  return entries;
}

/** هل المدخل مثبت في هذا القالب؟ */
function isPinned(templateId, entryId) {
  const t = template(templateId) || DEFAULT_TEMPLATE;
  return t.pinnedIds.includes(Number(entryId));
}

function get(id) { return getDb().prepare('SELECT * FROM faq_entries WHERE id = ?').get(id) || null; }

function search(q, { templateId = null, limit = LIMITS.searchResults } = {}) {
  const term = String(q ?? '').trim();
  // بحث فارغ = لا نتائج (بدل أن يتحوّل إلى «اعرض كل شيء»)
  if (!term) return [];
  // % و _ رموز خاصة في LIKE — نُهرّبها حتى يبحث المستخدم عن النص حرفياً.
  const like = `%${term.replace(/[\\%_]/g, m => `\\${m}`)}%`;
  const rows = getDb().prepare("SELECT * FROM faq_entries WHERE title LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' ORDER BY category_id, id")
    .all(like, like);
  if (templateId == null) return rows.slice(0, limit);
  const t = template(templateId) || DEFAULT_TEMPLATE;
  const allowed = new Set(t.categoryIds);
  const excluded = new Set(t.excludedIds);
  // التصفية بالقالب قبل القصّ: لو قصصنا أولاً لأكلت المدخلات المخفية أماكن النتائج.
  return rows.filter(e => allowed.has(e.category_id) && !excluded.has(e.id)).slice(0, limit);
}

/**
 * تحقق موحّد قبل الكتابة: تصنيف موجود فعلاً، ونصوص غير فارغة وضمن الحدود.
 * النموذج يفحص أيضاً — لكن الخدمة هي آخر خط، فلا تُخزَّن بيانات تكسر اللوحة.
 */
function assertEntryFields({ categoryId, title, content, userId }) {
  if (categoryId != null && !category(categoryId)) {
    throw new Error(`التصنيف غير موجود (${categoryId}). المتاح: ${FAQ_CATEGORIES.map(c => `${c.id}=${c.name}`).join('، ')}`);
  }
  if (title != null) {
    const t = String(title).trim();
    if (!t) throw new Error('عنوان المدخل مطلوب.');
    if (t.length > LIMITS.title) throw new Error(`عنوان المدخل أطول من ${LIMITS.title} حرفاً.`);
  }
  if (content != null) {
    const c = String(content).trim();
    if (!c) throw new Error('محتوى المدخل مطلوب.');
    if (c.length > LIMITS.content) throw new Error(`محتوى المدخل أطول من ${LIMITS.content} حرفاً.`);
  }
  if (!userId) throw new Error('لا يمكن تنفيذ العملية بدون مستخدم.');
}

function add({ categoryId, title, content, important, userId }) {
  assertEntryFields({ categoryId, title, content, userId });
  const db = getDb();
  const cleanTitle = String(title).trim();
  const cleanContent = String(content).trim();
  const res = db.prepare(`INSERT INTO faq_entries (category_id, title, content, is_important, created_by) VALUES (?, ?, ?, ?, ?)`)
    .run(Number(categoryId), cleanTitle, cleanContent, important ? 1 : 0, userId);
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, 1, 'create', ?, ?, ?, ?)`)
    .run(res.lastInsertRowid, cleanTitle, cleanContent, Number(categoryId), userId);
  return get(res.lastInsertRowid);
}

function edit(id, { categoryId, title, content, important, userId }) {
  const db = getDb();
  const cur = get(id);
  if (!cur) return null;
  assertEntryFields({ categoryId, title, content, userId });
  const v = cur.version + 1;
  const nextTitle = title == null ? cur.title : String(title).trim();
  const nextContent = content == null ? cur.content : String(content).trim();
  const nextCategory = categoryId == null ? cur.category_id : Number(categoryId);
  db.prepare(`UPDATE faq_entries SET category_id = ?, title = ?, content = ?, is_important = ?, updated_by = ?, version = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(nextCategory, nextTitle, nextContent, important == null ? cur.is_important : (important ? 1 : 0), userId, v, id);
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, ?, 'edit', ?, ?, ?, ?)`)
    .run(id, v, nextTitle, nextContent, nextCategory, userId);
  db.prepare('DELETE FROM policy_acknowledgements WHERE entry_id = ? AND version < ?').run(id, v);
  return get(id);
}

function remove(id, userId) {
  const db = getDb();
  const entryId = Number(id);
  const cur = get(entryId);
  if (!cur) return null;
  db.prepare(`INSERT INTO faq_history (entry_id, version, action, title, content, category_id, changed_by) VALUES (?, ?, 'delete', ?, ?, ?, ?)`)
    .run(entryId, cur.version, cur.title, cur.content, cur.category_id, userId);
  // أزل المراجع التالفة من القوالب
  for (const t of templates()) {
    if (t.pinnedIds.includes(entryId)) db.prepare('UPDATE faq_templates SET pinned_ids = ? WHERE id = ?').run(JSON.stringify(t.pinnedIds.filter(x => x !== entryId)), t.id);
    if (t.excludedIds.includes(entryId)) db.prepare('UPDATE faq_templates SET excluded_ids = ? WHERE id = ?').run(JSON.stringify(t.excludedIds.filter(x => x !== entryId)), t.id);
  }
  db.prepare('DELETE FROM faq_entries WHERE id = ?').run(entryId);
  db.prepare('DELETE FROM policy_acknowledgements WHERE entry_id = ?').run(entryId);
  return cur;
}

function history(id) { return getDb().prepare('SELECT * FROM faq_history WHERE entry_id = ? ORDER BY version DESC').all(id); }

// ===== قوالب FAQ المستقلة =====
/** تحقق من حقول القالب قبل الكتابة — الأخطاء تُترجم لرسالة عربية بدل خطأ SQL خام. */
function assertTemplateFields({ name, title, description, note, userId }) {
  if (name != null) {
    const n = String(name).trim();
    if (!n) throw new Error('اسم القالب مطلوب.');
    if (n.length > LIMITS.name) throw new Error(`اسم القالب أطول من ${LIMITS.name} حرفاً.`);
  }
  if (title != null) {
    const t = String(title).trim();
    if (!t) throw new Error('عنوان اللوحة مطلوب.');
    if (t.length > 256) throw new Error('عنوان اللوحة أطول من 256 حرفاً.');
  }
  if (description != null && String(description).length > LIMITS.description) throw new Error(`وصف اللوحة أطول من ${LIMITS.description} حرفاً.`);
  if (note != null && String(note).length > LIMITS.note) throw new Error(`ملاحظة اللوحة أطول من ${LIMITS.note} حرفاً.`);
  if (!userId) throw new Error('لا يمكن تنفيذ العملية بدون مستخدم.');
}

function addTemplate({ name, title, description, categoryIds, pinnedIds = [], excludedIds = [], note = '', color, userId }) {
  const db = getDb();
  assertTemplateFields({ name, title, description, note, userId });
  const ids = normalizeCategoryIds(categoryIds);
  const pinned = normalizeEntryIds(pinnedIds).filter(id => get(id));
  const excluded = normalizeEntryIds(excludedIds).filter(id => get(id));
  const safeColor = normalizeColor(color);
  const result = db.prepare(`INSERT INTO faq_templates (name, title, description, category_ids, pinned_ids, excluded_ids, note, color, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(String(name).trim(), String(title).trim(), description?.trim() || '', JSON.stringify(ids), JSON.stringify(pinned), JSON.stringify(excluded), note?.trim() || null, safeColor, userId);
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, 1, 'create', ?, ?, ?, ?, ?, ?)`).run(result.lastInsertRowid, String(name).trim(), String(title).trim(), description?.trim() || '', JSON.stringify(ids), safeColor, userId);
  return template(result.lastInsertRowid);
}

function editTemplate(id, { name, title, description, categoryIds, pinnedIds, excludedIds, note, color, userId }) {
  const db = getDb();
  const current = template(id);
  if (!current || current.id === 0) return null;
  assertTemplateFields({ name, title, description, note, userId });
  const nextCategoryIds = categoryIds == null ? current.categoryIds : normalizeCategoryIds(categoryIds);
  const next = {
    name: name?.trim() || current.name,
    title: title?.trim() || current.title,
    description: description == null ? current.description : description.trim(),
    categoryIds: nextCategoryIds,
    // التثبيت لا معنى له خارج تصنيفات القالب — أي مدخل خارجها يُسقط.
    pinnedIds: pinnedIds == null ? current.pinnedIds
      : normalizeEntryIds(pinnedIds).filter(eid => { const e = get(eid); return e && nextCategoryIds.includes(e.category_id); }),
    excludedIds: excludedIds == null ? current.excludedIds : normalizeEntryIds(excludedIds),
    note: note == null ? current.note : note.trim(),
    color: color == null ? current.color : normalizeColor(color, current.color),
  };
  const version = current.version + 1;
  db.prepare(`UPDATE faq_templates SET name = ?, title = ?, description = ?, category_ids = ?, pinned_ids = ?, excluded_ids = ?, note = ?, color = ?, updated_by = ?, version = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(next.name, next.title, next.description, JSON.stringify(next.categoryIds), JSON.stringify(next.pinnedIds), JSON.stringify(next.excludedIds), next.note || null, next.color, userId, version, id);
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, ?, 'edit', ?, ?, ?, ?, ?, ?)`).run(id, version, next.name, next.title, next.description, JSON.stringify(next.categoryIds), next.color, userId);
  return template(id);
}

function removeTemplate(id, userId) {
  const db = getDb();
  const current = template(id);
  if (!current || current.id === 0) return null;
  db.prepare(`INSERT INTO faq_template_history (template_id, version, action, name, title, description, category_ids, color, changed_by)
    VALUES (?, ?, 'delete', ?, ?, ?, ?, ?, ?)`).run(id, current.version, current.name, current.title, current.description, JSON.stringify(current.categoryIds), current.color, userId);
  db.prepare('UPDATE faq_panels SET template_id = 0 WHERE template_id = ?').run(id);
  db.prepare('DELETE FROM faq_templates WHERE id = ?').run(id);
  return current;
}

function templateHistory(id) { return getDb().prepare('SELECT * FROM faq_template_history WHERE template_id = ? ORDER BY version DESC, id DESC').all(id); }

// ===== نظام القراءة =====
function acknowledge(entryId, userId, version) {
  getDb().prepare(`INSERT INTO policy_acknowledgements (entry_id, user_id, version, acknowledged_at) VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(entry_id, user_id) DO UPDATE SET version = excluded.version, acknowledged_at = excluded.acknowledged_at`).run(entryId, userId, version);
}
function hasRead(entryId, userId) {
  const e = get(entryId);
  const a = getDb().prepare('SELECT version FROM policy_acknowledgements WHERE entry_id = ? AND user_id = ?').get(entryId, userId);
  return !!(a && e && a.version >= e.version);
}
function unreadFor(userId, { templateId = null } = {}) {
  const rows = getDb().prepare(`SELECT e.* FROM faq_entries e LEFT JOIN policy_acknowledgements a ON a.entry_id = e.id AND a.user_id = ?
    WHERE e.is_important = 1 AND (a.entry_id IS NULL OR a.version < e.version) ORDER BY e.category_id, e.id`).all(userId);
  if (templateId == null) return rows;
  const t = template(templateId) || DEFAULT_TEMPLATE;
  const allowed = new Set(t.categoryIds);
  const excluded = new Set(t.excludedIds);
  return rows.filter(e => allowed.has(e.category_id) && !excluded.has(e.id));
}
function readers(entryId) {
  return getDb().prepare('SELECT user_id, acknowledged_at FROM policy_acknowledgements WHERE entry_id = ?').all(entryId);
}

// ===== اللوحات المنشورة =====
function addPanel(messageId, channelId, userId, templateId = 0, { label = null } = {}) {
  // الاسم يُعرض داخل إمبد — نقصّه ونمنع الأسطر الجديدة حتى لا يكسر تنسيق القائمة.
  const cleanLabel = label == null || String(label).trim() === '' ? null : String(label).replace(/\s+/g, ' ').trim().slice(0, 60);
  getDb().prepare('INSERT OR REPLACE INTO faq_panels (message_id, channel_id, created_by, template_id, label) VALUES (?, ?, ?, ?, ?)')
    .run(String(messageId), String(channelId), userId, Number(templateId) || 0, cleanLabel);
}
function updatePanelSync(messageId, ok) {
  try { getDb().prepare('UPDATE faq_panels SET sync_status = ?, last_synced_at = datetime(\'now\') WHERE message_id = ?').run(ok ? 'ok' : 'error', messageId); } catch {}
}
function panels({ templateId = null } = {}) {
  if (templateId != null) return getDb().prepare('SELECT * FROM faq_panels WHERE template_id = ?').all(Number(templateId));
  return getDb().prepare('SELECT * FROM faq_panels').all();
}
function panelsByChannel(channelId) {
  return getDb().prepare('SELECT * FROM faq_panels WHERE channel_id = ?').all(channelId);
}
function removePanel(messageId) { getDb().prepare('DELETE FROM faq_panels WHERE message_id = ?').run(messageId); }

function counts(categoryIds) {
  const rows = categoryIds?.length
    ? getDb().prepare(`SELECT category_id, COUNT(*) c FROM faq_entries WHERE category_id IN (${categoryIds.map(() => '?').join(',')}) GROUP BY category_id`).all(...categoryIds)
    : getDb().prepare('SELECT category_id, COUNT(*) c FROM faq_entries GROUP BY category_id').all();
  return Object.fromEntries(rows.map(r => [r.category_id, r.c]));
}

module.exports = {
  DEFAULT_TEMPLATE, LIMITS, category, list, listForTemplate, isPinned, get, search, add, edit, remove, history,
  addTemplate, editTemplate, removeTemplate, template, templates, templateCategories, templateHistory,
  activeCategories, populatedCategories, isVisibleIn, templatesShowing, normalizeColor,
  acknowledge, hasRead, unreadFor, readers, addPanel, updatePanelSync, panels, panelsByChannel, removePanel, counts,
};
