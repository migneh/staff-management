'use strict';
const { randomBytes } = require('node:crypto');
const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, UserSelectMenuBuilder,
  TextDisplayBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { FAQ_CATEGORIES } = require('../constants');
const { normalizeDigits, today, addDays, isValidDate } = require('../utils');

const TTL = 15 * 60 * 1000;
const LIMIT = 500;
const sessions = new Map();
const DATE_FIELDS = new Set(['start', 'end', 'new_end', 'last_day', 'remove_at']);
const NUMERIC_FIELDS = new Set(['rating', 'duration', 'category', 'categories', 'ids', 'maxConcurrent', 'maxDays', 'maxDaysPer90', 'pendingExpireDays', 'noticeDays', 'escalateDays', 'annualDays', 'teamCover', 'escalateHours', 'tickets', 'speed', 'chat', 'presence', 'teamInteraction', 'supervisorRating', 'actions', 'activity', 'commitment']);
const HINTS = {
  reason: 'اكتب السبب بوضوح. يصل هذا النص للجهة التي تراجع الطلب.',
  note: 'يمكن تركه فارغاً. أضف فقط ما يساعد الإدارة على فهم الطلب.',
  notes: 'اختياري: تفاصيل إضافية أو اقتراح لحل بديل.',
  title: 'عنوان مختصر يوضح الموضوع قبل فتح التفاصيل.',
  content: 'اكتب التعليمات كاملة. يمكنك استخدام تنسيق Discord.',
  name: 'اسم داخلي لتتعرف على القالب؛ لا يلزم أن يطابق عنوان اللوحة.',
  description: 'وصف مختصر يظهر للقراء تحت العنوان. يمكن تركه فارغاً.',
  color: 'لون اللوحة بصيغة Hex مثل #5865F2. الملاحظة تُعدل من إعدادات القالب.',
  attachment: 'اختياري: رابط يبدأ بـ https://. لا تضع معلومات حساسة في رابط عام.',
  evidence: 'رابط الرسالة أو الدليل الذي يدعم الإجراء، إن وُجد.',
  exit_interview: 'ملاحظات واضحة ومحايدة لمراجعة الإدارة.',
  ticket_id: 'رقم التكت كما يظهر في سجل البوت؛ لا تستخدم رقم الرسالة.',
  duration: 'اختياري: دقائق مثل 45، أو ساعات:دقائق مثل 01:30. يقبل ٤٥ أيضاً.',
  ids: 'أرقام مفصولة بفاصلة، مثل 3, 7, 12. تُقبل الأرقام العربية والفاصلة العربية.',
  q: 'ابحث بكلمة من العنوان أو المحتوى، مثل «إجازة».',
  query: 'اكتب المهمة بالعربية أو اسم الأمر بالإنجليزية.',
};
const DATE_LABELS = { start: 'تاريخ البداية', end: 'تاريخ النهاية', new_end: 'تاريخ النهاية الجديد', last_day: 'آخر يوم عمل', remove_at: 'تاريخ إزالة الرتب' };

function normalizeDate(value) {
  let text = normalizeDigits(value).trim().replace(/[\u200E\u200F\u061C]/g, '').replace(/[ًٌٍَُِّْ]/g, '');
  if (text === 'اليوم') return today();
  if (['غدا', 'غداً'].includes(text)) return addDays(today(), 1);
  let m = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return text;
}
/* ===== بناة الـ Label الصريحة (لمن يبني نموذجه ديناميكياً) ===== */
function selectLabel({ id, label, description, options = [], values = [], required = true, multiple = false, max = null, placeholder } = {}) {
  const clean = options.slice(0, 25).map(o => ({
    label: String(o.label).slice(0, 100), value: String(o.value),
    ...(o.description ? { description: String(o.description).slice(0, 100) } : {}),
  }));
  const minV = required !== false ? 1 : 0;
  const wantMax = multiple ? (max || clean.length) : 1;
  // max_values فوق عدد الخيارات الفعلية يرفضه Discord عند العرض
  // (options[BASE_TYPE_MIN_LENGTH]) — حدث فعلاً في faq-template-create حين
  // كان max ثابتاً 11 والخيارات المأهولة أقل. يُقصّ على الواقع دائماً.
  const capMax = clean.length ? Math.min(Math.max(minV, wantMax), clean.length) : Math.max(minV, wantMax);
  const menu = new StringSelectMenuBuilder().setCustomId(id).setRequired(required !== false)
    .setMinValues(minV).setMaxValues(capMax)
    .setPlaceholder(String(placeholder || (multiple ? 'اختر ما ينطبق، ويمكن اختيار أكثر من واحد' : 'اختر من القائمة')).slice(0, 150))
    .addOptions(clean.map(o => ({ ...o, default: values.map(String).includes(o.value) })));
  return new LabelBuilder().setLabel(String(label).slice(0, 45)).setStringSelectMenuComponent(menu)
    .setDescription(String(description || (required !== false ? 'مطلوب — اختر قيمة من القائمة.' : 'اختياري — اتركه فارغاً إن لم ينطبق.')).slice(0, 100));
}
function userLabel({ id, label, description, required = true, value } = {}) {
  const menu = new UserSelectMenuBuilder().setCustomId(id).setRequired(required !== false)
    .setMinValues(required !== false ? 1 : 0).setMaxValues(1).setPlaceholder('ابحث عن العضو بالاسم');
  if (value) menu.setDefaultUsers(value);
  return new LabelBuilder().setLabel(String(label).slice(0, 45)).setUserSelectMenuComponent(menu)
    .setDescription(String(description || (required !== false ? 'مطلوب — ابحث عن العضو بالاسم ثم اختره.' : 'اختياري — ابحث عن العضو بالاسم ثم اختره.')).slice(0, 100));
}
function textLabel({ id, label, description, hint, placeholder, required = true, style = 'short', min, max, value } = {}) {
  const input = new TextInputBuilder().setCustomId(id)
    .setStyle(style === 'paragraph' ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setRequired(required !== false);
  if (min) input.setMinLength(min);
  if (max) input.setMaxLength(max);
  const ph = placeholder || (!value ? hint : null);
  if (ph) input.setPlaceholder(String(ph).slice(0, 100));
  if (value) input.setValue(String(value).slice(0, 4000));
  return new LabelBuilder().setLabel(String(label).slice(0, 45)).setTextInputComponent(input)
    .setDescription(String(description || hint || (required !== false
      ? 'مطلوب — أكمل هذا الحقل قبل الإرسال.'
      : 'اختياري — يمكن ترك هذا الحقل فارغاً.')).slice(0, 100));
}

/* ===== مواصفات النماذج: وصف مُصرّح يُفحص آلياً ويُبنى بنفس الشكل في كل أمر ===== */
/** حقل نصي: الاسم قصير في Label، والصيغة المطلوبة في الشرح. */
const field = ({ id, label, description, hint, placeholder, required = true, style = 'short', min, max, value } = {}) =>
  ({ id, label, description: description || hint, placeholder, required, style, min, max, value });
/** قائمة اختيار (مفردة أو متعددة). */
const select = ({ id, label, description, options = [], required = true, multiple = false, max, values = [], placeholder } = {}) =>
  ({ id, label, description, options, required, multiple, max, values, placeholder, kind: 'select' });
/** اختيار عضو بالاسم بدل كتابة المعرّف. */
const user = ({ id, label, description, required = true, value } = {}) =>
  ({ id, label, description, required, value, kind: 'user' });

const SPECS = new Map();
/** يسجّل مواصفة باسم ثابت ليغطيها فحص الجودة. */
function define(key, spec) {
  const full = { key, ...spec };
  SPECS.set(key, full);
  return full;
}
function specs() { return [...SPECS.values()]; }
function optionProblems(id, options = []) {
  const out = [];
  if (!options.length) out.push(`«${id}»: قائمة بلا خيارات`);
  if (options.length > 25) out.push(`«${id}»: ${options.length} خياراً (الحد 25)`);
  for (const o of options) {
    if (!o.label || String(o.label).length > 100) out.push(`«${id}»: خيار بلا عنوان صالح`);
    if (o.description && String(o.description).length > 100) out.push(`«${id}»: وصف خيار أطول من 100 حرف`);
  }
  return out;
}
/** يفحص مواصفة واحدة ويعيد قائمة الملاحظات (فارغة = سليمة). */
function auditSpec(spec) {
  const problems = [];
  const key = spec.key || spec.id || 'بلا معرف';
  if (!spec.id) problems.push('بلا custom_id');
  if (!spec.title) problems.push('بلا عنوان');
  else if (String(spec.title).length > 45) problems.push(`العنوان ${String(spec.title).length} حرفاً (الحد 45)`);
  const fields = spec.fields || [];
  if (!fields.length) problems.push('بلا حقول');
  if (fields.length > 5) problems.push(`${fields.length} حقول (الحد 5)`);
  const ids = new Set();
  for (const f of fields) {
    if (!f.id) { problems.push('حقل بلا معرف'); continue; }
    if (ids.has(f.id)) problems.push(`الحقل «${f.id}» مكرر`);
    ids.add(f.id);
    if (!f.label) problems.push(`«${f.id}»: بلا Label`);
    else if (String(f.label).length > 45) problems.push(`«${f.id}»: Label أطول من 45 حرفاً`);
    const description = f.description || f.hint;
    if (!description) problems.push(`«${f.id}»: بلا شرح`);
    else if (String(description).length > 100) problems.push(`«${f.id}»: الشرح ${String(description).length} حرفاً (الحد 100)`);
    if (f.placeholder && String(f.placeholder).length > 100) problems.push(`«${f.id}»: placeholder أطول من 100 حرف`);
    if (typeof f.value === 'string' && f.value.length > 4000) problems.push(`«${f.id}»: القيمة الافتراضية أطول من الحد`);
    if (f.options) problems.push(...optionProblems(f.id, f.options));
    if (f.style && !['short', 'paragraph'].includes(f.style)) problems.push(`«${f.id}»: نمط غير معروف`);
  }
  if (spec.note && String(spec.note).length > 4000) problems.push('نص التلميح أطول من الحد');
  return problems.map(p => `${key}: ${p}`);
}
function audit(list = specs()) { return list.flatMap(auditSpec); }

/** يبني نموذجاً من مواصفة مع قيم معبّأة مسبقاً (تعديل مسودة أو إعادة فتح). */
function build(spec, { title, values = {} } = {}) {
  const modal = new ModalBuilder().setCustomId(spec.id).setTitle(String(title || spec.title).slice(0, 45));
  const rows = (spec.fields || []).map(f => {
    const raw = Object.hasOwn(values, f.id) ? values[f.id] : f.value;
    if (f.kind === 'select') {
      const picked = Array.isArray(raw) ? raw.map(String) : (raw ? String(raw).split(',') : (f.values || []));
      return selectLabel({ ...f, values: picked });
    }
    if (f.kind === 'user') return userLabel({ ...f, value: Array.isArray(raw) ? raw : (raw ? [String(raw)] : undefined) });
    return textLabel({ ...f, value: raw });
  });
  for (const row of rows.slice(0, 5)) modal.addLabelComponents(row);
  if (spec.note && rows.length < 5) modal.addTextDisplayComponents(new TextDisplayBuilder().setContent(spec.note));
  return modal;
}
/** يقرأ قيمة حقل (نص أو اختيار) كما وصلت من النموذج دون انفجار إن غاب الحقل. */
function value(i, id) {
  try { const v = i.fields?.getTextInputValue?.(id); return typeof v === 'string' ? v.trim() : ''; } catch { return ''; }
}
/** يجمع سبباً جاهزاً من قائمة مع ملاحظة حرة في نص واحد. */
function combine(i, { select = 'preset', text = 'reason', separator = ' — ' } = {}) {
  const presets = value(i, select).split(/\s*[,،]\s*/).filter(Boolean);
  const free = value(i, text);
  return [...presets, free].filter(Boolean).join(separator);
}
/** يفتح مواصفة مسجّلة أو كائناً مباشراً. */
async function open(i, spec, opts) {
  const resolved = typeof spec === 'string' ? SPECS.get(spec) : spec;
  if (!resolved) return require('../utils').replyEphemeral(i, 'تعذّر فتح النموذج. أعد المحاولة من الأمر.');
  return show(i, build(resolved, opts));
}

/** نموذج مبني حديثاً بالفعل (كل مكوناته Label أو نص تلميح)؟ */
function isModern(source) {
  const raw = source.toJSON();
  return (raw.components || []).length > 0 && (raw.components || []).every(c => c.type === ComponentType.Label || c.type === ComponentType.TextDisplay);
}
/** توافق: يحوّل نموذجاً قديماً (ActionRow + TextInput) إلى Label بوصف كامل. */
function modernize(source) {
  const raw = source.toJSON();
  const modal = new ModalBuilder().setCustomId(raw.custom_id).setTitle(String(raw.title || '').slice(0, 45));
  for (const row of raw.components) {
    if (row.type !== ComponentType.ActionRow) { modal.addLabelComponents(new LabelBuilder(row)); continue; }
    const old = row.components[0];
    const id = old.custom_id;
    if (raw.custom_id.startsWith('faq:') && ['category', 'categories'].includes(id)) {
      const options = FAQ_CATEGORIES.map(c => ({ label: c.name, value: String(c.id), description: c.desc }));
      if (id === 'categories') options.unshift({ label: 'كل التصنيفات', value: 'all' });
      modal.addLabelComponents(selectLabel({ id, label: id === 'category' ? 'التصنيف' : 'التصنيفات الظاهرة في القالب', options,
        values: String(old.value || '').split(','), multiple: id === 'categories', max: FAQ_CATEGORIES.length,
        description: id === 'categories' ? 'اختيار «كل التصنيفات» يتقدم على أي اختيار آخر.' : 'اختر بالاسم؛ لا حاجة لحفظ رقم التصنيف.' }));
      continue;
    }
    if (raw.custom_id.startsWith('faq:') && id === 'important') {
      modal.addLabelComponents(selectLabel({ id, label: 'هل يتطلب تأكيد القراءة؟',
        options: [{ label: 'نعم — تعليمات مهمة', value: 'نعم' }, { label: 'لا — مرجع اختياري', value: 'لا' }],
        values: [old.value || 'لا'], description: '«نعم» تُلزم الأعضاء بتأكيد القراءة.' }));
      continue;
    }
    const label = DATE_LABELS[id] || String(old.label || '').replace(/\s*[—-]?\s*\(?(?:اختياري|إجباري)\)?/g, '').trim();
    let hint = HINTS[id];
    const extra = {};
    if (DATE_FIELDS.has(id)) {
      hint = `سنة-شهر-يوم مثل ${today()}، أو يوم/شهر/سنة، أو «اليوم» و«غدا».${id === 'remove_at' ? ' فارغ = فور القبول.' : ''}`;
      extra.max = 20;
      extra.placeholder = today();
    } else if (raw.custom_id.startsWith('setup:policies')) { extra.max = 3; hint = 'عدد صحيح بين 1 و365. تُقبل الأرقام العربية مثل ٣٠.'; }
    modal.addLabelComponents(textLabel({
      id, label: label || old.label, description: hint, required: old.required !== false,
      style: old.style === TextInputStyle.Paragraph ? 'paragraph' : 'short',
      min: old.min_length, max: old.max_length || extra.max, placeholder: old.placeholder || extra.placeholder, value: old.value,
    }));
  }
  if (raw.components.length < 5) modal.addTextDisplayComponents(new TextDisplayBuilder().setContent('راجع البيانات قبل الإرسال. إغلاق النافذة لا يرسل شيئاً. إذا احتاجت البيانات إلى تصحيح، يمكنك إعادة فتحها لمدة ١٥ دقيقة.'));
  return modal;
}

function prune() {
  for (const [key, s] of sessions) if (s.expires <= Date.now() && !s.busy) sessions.delete(key);
}
async function show(i, source) {
  prune();
  if (sessions.size >= LIMIT) {
    const oldest = [...sessions].find(([, s]) => !s.busy);
    if (oldest) sessions.delete(oldest[0]);
    else return require('../utils').replyEphemeral(i, 'النماذج مشغولة الآن. حاول مجدداً بعد قليل.');
  }
  const token = randomBytes(8).toString('hex');
  // النماذج المبنية من مواصفات (Label) تمر كما هي؛ القديمة تُحوَّل تلقائياً.
  const modal = isModern(source) ? source : modernize(source);
  const originalId = modal.data.custom_id;
  const session = { token, originalId, owner: i.user.id, guild: i.guildId, expires: Date.now() + TTL, data: modal.toJSON(), busy: false, retryable: false };
  modal.setCustomId(`${originalId}:form:${token}`);
  sessions.set(token, session);
  try { return await i.showModal(modal); } catch (e) { sessions.delete(token); throw e; }
}
function tokenOf(i) { return i.customId?.match(/:form:([a-f0-9]{16})$/)?.[1] || i.customId?.match(/^form:retry:([a-f0-9]{16})$/)?.[1]; }
function lookup(i) {
  const token = tokenOf(i);
  const s = token && sessions.get(token);
  if (!s || s.owner !== i.user.id || s.guild !== i.guildId || s.expires <= Date.now()) return null;
  if (!i.customId.startsWith('form:retry:') && i.customId !== `${s.originalId}:form:${s.token}`) return null;
  return s;
}
/**
 * يقرأ قيم النموذج مرة واحدة، فتبقى قراءة الجلسة كلّها من مصدر واحد.
 * القاعدة: كل رفض هنا = الإدخال ناقص أو غير صالح ⇒ تبقى الجلسة ويُعرض زرّ التصحيح.
 * كل نجاح هنا = اكتمل الإدخال ⇒ لا يعيد أي معالج بعده فتح النموذج.
 */
function capture(i, session) {
  i.formSession = session;
  session.retryable = false;
  // كل محاولة إرسال تبدأ من الصفر: حالة التصحيح من محاولة سابقة لا تُورَث.
  session.invalid = false;
  // كل رفض يمرّ من هذا ⇒ صِفة «غير صالح» تُضبط في موضع واحد لا في المتصل.
  const reject = message => { session.invalid = true; return message; };
  const values = {};
  for (const label of session.data.components) {
    const c = label.component;
    if (!c) continue;
    let f;
    try { f = i.fields.getField(c.custom_id); } catch { f = { custom_id: c.custom_id, type: c.type, value: '', values: [] }; }
    if (f.type !== c.type) { if (c.type === ComponentType.TextInput && f.value === '') f.value = ''; else if (c.type !== ComponentType.TextInput && f.type !== c.type) return reject(`نوع حقل «${label.label}» غير صحيح. افتح النموذج من جديد.`); }
    let v = f.type === ComponentType.TextInput ? f.value : (f.values || []);
    if (Array.isArray(v)) {
      if (v.length > (c.max_values || 1) || v.length < (c.min_values || 0) || (c.type === ComponentType.StringSelect && v.some(value => !c.options.some(o => o.value === value)))) return reject(`اختر قيمة صالحة في «${label.label}».`);
      if (c.type === ComponentType.StringSelect) c.options.forEach(o => { o.default = v.includes(o.value); });
      else if (c.type === ComponentType.UserSelect) c.default_values = v.map(id => ({ id, type: 'user' }));
      values[c.custom_id] = v.includes('all') ? 'all' : v.join(',');
    } else {
      c.value = v;
      if (typeof v !== 'string' || v.length > (c.max_length || 4000) || (v.length && v.length < (c.min_length || 0))) return reject(`راجع طول النص في «${label.label}».`);
      if (DATE_FIELDS.has(c.custom_id)) {
        v = normalizeDate(v);
        // تاريخ مُطبّع لكنه غير موجود تقويمياً (32/13) لا يجوز أن يعبر إلى المعالج:
        // يُرفض في موضعه ليصير زرّ «تصحيح» نتيجةً طبيعية للرفض لا استثناءً لكل معالج على حدة.
        if (v && !isValidDate(v)) return reject(`راجع تاريخ «${label.label || DATE_LABELS[c.custom_id] || c.custom_id}» — الصيغة المقبولة سنة-شهر-يوم مثل ${today()}.`);
      } else if (NUMERIC_FIELDS.has(c.custom_id)) v = normalizeDigits(v).replace(/،/g, ',');
      values[c.custom_id] = v;
    }
  }
  // محوّل توافق: معالجات الأعمال تقرأ النص أو القيمة المختارة بالطريقة نفسها.
  const original = i.fields;
  i.fields = Object.create(original);
  i.fields.getTextInputValue = id => Object.hasOwn(values, id) ? values[id] : original.getTextInputValue(id);
  for (const label of session.data.components) {
    const c = label.component;
    if (c && c.required !== false && !String(values[c.custom_id] || '').trim()) return reject(`أكمل حقل «${label.label}». لم تُحفظ البيانات بعد.`);
  }
  return null;
}
function retryRow(i) {
  const s = i.formSession;
  if (!s || !sessions.has(s.token)) return null;
  // وجود الزرّ نفسه هو الإشارة: «تصحيح» معروض ⇒ الإرسال لم يكتمل.
  s.retryable = true;
  return new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`form:retry:${s.token}`).setLabel('تصحيح البيانات').setEmoji('✏️').setStyle(ButtonStyle.Primary));
}
async function reopen(i, s) {
  if (!s.retryable || s.busy) return require('../utils').replyEphemeral(i, 'هذا النموذج أُرسل أو ما زال قيد المعالجة. افتح الأمر من جديد عند الحاجة.');
  const modal = new ModalBuilder(s.data).setCustomId(`${s.originalId}:form:${s.token}`);
  return i.showModal(modal);
}
function finish(i, s, failed = false) {
  s.busy = false;
  // تبقى الجلسة مرّتين لا ثالثة: عند رفض التحقق (failed)، أو عند عرض زرّ التصحيح
  // فعلاً (retryable). كل ما عداه نموذج اكتمل ⇒ تُحذف جلسته فلا يُعاد فتحه.
  if (!failed && !s.retryable) sessions.delete(s.token);
  delete i.formSession;
}
module.exports = {
  show, modernize, isModern, build, open, define, specs, audit, auditSpec,
  field, select, user, textLabel, selectLabel, userLabel, value, combine,
  normalizeDate, tokenOf, lookup, capture, retryRow, reopen, finish, TTL,
};
