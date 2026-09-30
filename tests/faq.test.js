'use strict';
// فحص نظام FAQ: ترحيل التصنيفات، القوالب، نطاق اللوحة، والبحث، وأمان المعالجات.
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { ComponentType } = require('discord.js');
const { openMemoryDb, getDb, migrateFaqCategories, FAQ_CATEGORY_REMAP } = require('../src/database');
const faq = require('../src/services/faq');
const faqCmd = require('../src/commands/faq');
const forms = require('../src/ui/forms');
const { commands, resolveComponent } = require('../src/commands');
const { dispatch } = require('../src/services/componentDispatch');
const { FAQ_CATEGORIES, LEVELS } = require('../src/constants');

const IDS = { user: '1005171993940852796', other: '1490787800168005713', channel: '223456789012345678', guild: '323456789012345678' };

/** متفاعل وهمي يكفي لتشغيل معالجات FAQ (نفس نمط باقي الاختبارات). */
function interaction({ customId = '', level = LEVELS.MANAGEMENT, team = 'support', texts = {}, selects = {}, values = [], admin = false } = {}) {
  const i = {
    customId, user: { id: IDS.user }, guildId: IDS.guild, channelId: IDS.channel, client: {}, staffLevel: level, staffInfo: { team },
    member: { permissions: { has: () => admin } }, values,
    fields: {
      getField(id) {
        if (Object.hasOwn(texts, id)) return { custom_id: id, type: ComponentType.TextInput, value: texts[id] };
        const picked = selects[id] != null ? [].concat(selects[id]) : null;
        if (!picked) return { custom_id: id, type: ComponentType.TextInput, value: '' };
        return { custom_id: id, type: ComponentType.StringSelect, values: picked };
      },
      getTextInputValue: id => texts[id] ?? '',
      getStringSelectValues: id => [].concat(selects[id] ?? []),
    },
    async reply(p) { this.payload = p; }, async update(p) { this.payload = p; }, async showModal(m) { this.modal = m; },
    async deferReply() { this.deferred = true; },
  };
  return i;
}

const entry = (categoryId, title, extra = {}) =>
  faq.add({ categoryId, title, content: extra.content || `محتوى ${title}`, important: extra.important || false, userId: 'a' });

beforeEach(() => openMemoryDb());

describe('ترحيل تصنيفات FAQ', () => {
  test('التصنيف الحالي متصل 1..N ولا يتضمن «قوانين فريق الإشراف»', () => {
    assert.deepEqual(FAQ_CATEGORIES.map(c => c.id), FAQ_CATEGORIES.map((_, idx) => idx + 1));
    assert.equal(FAQ_CATEGORIES.some(c => c.name.includes('فريق الإشراف')), false);
    assert.equal(FAQ_CATEGORIES.length, 10);
  });

  test('المدخلات القديمة تُعاد ترقيمها والتصنيف المحذوف يندمج في «قوانين الإدارة»', () => {
    const db = openMemoryDb();
    // محاكاة قاعدة بيانات من الإصدار السابق (11 تصنيفاً) قبل الترحيل
    db.prepare(`DELETE FROM settings WHERE key = 'schema_faq_categories'`).run();
    const ins = db.prepare('INSERT INTO faq_entries (category_id, title, content, created_by) VALUES (?, ?, ?, ?)');
    ins.run(2, 'قوانين المشرفين', 'محتوى', 'a');  // → 1 (قوانين الإدارة)
    ins.run(5, 'العقوبات', 'محتوى', 'a');          // → 4
    ins.run(11, 'أسئلة شائعة', 'محتوى', 'a');      // → 10
    db.prepare(`INSERT INTO faq_templates (name, title, description, category_ids, created_by) VALUES ('قديم', 'ع', 'و', '[2,3,11]', 'a')`).run();

    migrateFaqCategories(db);

    assert.deepEqual(db.prepare('SELECT category_id FROM faq_entries ORDER BY id').all().map(r => r.category_id), [1, 4, 10]);
    assert.deepEqual(JSON.parse(db.prepare('SELECT category_ids FROM faq_templates').get().category_ids), [1, 2, 10]);
    // لا يبقى أي مرجع لتصنيف محذوف
    assert.equal(db.prepare('SELECT COUNT(*) n FROM faq_entries WHERE category_id NOT IN (1,2,3,4,5,6,7,8,9,10)').get().n, 0);
    // القراءة عبر الخدمة تعكس الترحيل
    assert.equal(faq.category(2).name, 'آلية استلام التكتات');
  });

  test('الترحيل يعمل مرة واحدة فقط ولا يعيد الترقيم مرتين', () => {
    const db = openMemoryDb();
    db.prepare(`DELETE FROM settings WHERE key = 'schema_faq_categories'`).run();
    db.prepare('INSERT INTO faq_entries (category_id, title, content, created_by) VALUES (11, ? , ?, ?)').run('سؤال', 'محتوى', 'a');
    migrateFaqCategories(db);
    assert.equal(db.prepare('SELECT category_id FROM faq_entries').get().category_id, 10);
    migrateFaqCategories(db);
    migrateFaqCategories(db);
    assert.equal(db.prepare('SELECT category_id FROM faq_entries').get().category_id, 10, 'إعادة التشغيل يجب ألا تغيّر شيئاً');
    assert.equal(FAQ_CATEGORY_REMAP[2], 1);
  });
});

describe('تصنيفات اللوحة: ما فيه مدخلات فقط', () => {
  test('activeCategories تُعيد التصنيفات غير الفارغة فقط مع أعدادها', () => {
    entry(1, 'قانون أول');
    entry(1, 'قانون ثانٍ');
    entry(3, 'تصعيد');
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1, 2, 3, 4], userId: 'a' });
    const active = faq.activeCategories(t.id);
    assert.deepEqual(active.map(c => c.id), [1, 3]);
    assert.deepEqual(active.map(c => c.count), [2, 1]);
    assert.deepEqual(faq.templateCategories(t.id).map(c => c.id), [1, 2, 3, 4], 'التصنيفات المختارة تبقى كما هي');
  });

  test('المدخلات المخفية لا تُحتسب ضمن التصنيفات الظاهرة', () => {
    const e1 = entry(1, 'ظاهر');
    const hidden = entry(1, 'مخفي');
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], excludedIds: [hidden.id], userId: 'a' });
    assert.deepEqual(faq.activeCategories(t.id).map(c => c.id), [1]);
    faq.editTemplate(t.id, { excludedIds: [e1.id, hidden.id], userId: 'a' });
    assert.deepEqual(faq.activeCategories(t.id), [], 'بعد إخفاء كل المدخلات لا يبقى تصنيف للعرض');
  });

  test('قائمة اللوحة لا تعرض تصنيفاً فارغاً', () => {
    entry(1, 'قانون');
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1, 2, 3], userId: 'a' });
    const panel = faqCmd.buildPanel(t.id);
    const menu = panel.components[0].components[0].toJSON();
    assert.deepEqual(menu.options.map(o => o.value), ['1'], 'فقط التصنيف الذي فيه مدخلات');
    assert.match(menu.options[0].description, /1 مدخل/);
  });

  test('لوحة فارغة: القائمة معطّلة والأزرار لا تنهار', () => {
    const t = faq.addTemplate({ name: 'فارغ', title: 'لوحة', description: '', categoryIds: [1], userId: 'a' });
    const panel = faqCmd.buildPanel(t.id);
    const menu = panel.components[0].components[0].toJSON();
    assert.equal(menu.disabled, true);
    assert.equal(panel.embeds[0].data.fields[0].value, '_لا توجد مدخلات بعد_');
  });

  test('populatedCategories للقالب: ما فيه مدخلات + المختار حالياً', () => {
    entry(1, 'قانون');
    entry(4, 'أسلوب');
    assert.deepEqual(faq.populatedCategories().map(c => c.id), [1, 4]);
    assert.deepEqual(faq.populatedCategories([7]).map(c => c.id), [1, 4, 7]);
  });
});

describe('حقل التصنيفات في القالب اختياري', () => {
  test('المواصفة تبني قائمة غير مطلوبة بحد أدنى صفر', () => {
    const spec = faqCmd.modals.template();
    const field = spec.fields.find(f => f.id === 'categories');
    assert.equal(field.required, false);
    const modal = forms.build(spec).toJSON();
    const categories = modal.components.find(c => c.component?.custom_id === 'categories');
    assert.equal(categories.component.required, false);
    assert.equal(categories.component.min_values, 0);
    assert(categories.component.options.some(o => o.value === 'all'), 'خيار «كل التصنيفات» متاح');
  });

  test('القائمة تعرض التصنيفات التي فيها مدخلات فقط', () => {
    entry(2, 'تكت');
    const spec = faqCmd.modals.template();
    const field = spec.fields.find(f => f.id === 'categories');
    const values = field.options.map(o => o.value);
    assert.deepEqual(values, ['all', '2']);
  });

  test('تركه فارغاً = كل التصنيفات (عبر المعالج الحقيقي)', async () => {
    entry(1, 'قانون');
    const i = interaction({
      customId: 'faq:template-addmodal',
      texts: { name: 'قالب بلا تصنيفات', title: 'اللوحة', description: '', categories: '', color: '#5865F2' },
    });
    await resolveComponent('faq:template-addmodal').handler(i, []);
    const t = faq.templates()[0];
    assert.deepEqual(t.categoryIds, FAQ_CATEGORIES.map(c => c.id));
    assert.match(i.payload.embeds[0].data.description, /تم إنشاء القالب/);
  });

  test('«كل التصنيفات» يتقدم على أي اختيار آخر مهما كان ترتيبه', () => {
    assert.deepEqual(faqCmd.parseCategories('all'), FAQ_CATEGORIES.map(c => c.id));
    assert.deepEqual(faqCmd.parseCategories('3,all'), FAQ_CATEGORIES.map(c => c.id));
    assert.deepEqual(faqCmd.parseCategories('الكل'), FAQ_CATEGORIES.map(c => c.id));
    assert.deepEqual(faqCmd.parseCategories(''), FAQ_CATEGORIES.map(c => c.id));
    assert.deepEqual(faqCmd.parseCategories('1,3'), [1, 3]);
    assert.deepEqual(faqCmd.parseCategories('١،٣'), null, 'الأرقام العربية تُطبَّع في طبقة النماذج قبل القراءة');
    assert.equal(faqCmd.parseCategories('99'), null);
    assert.equal(faqCmd.parseCategories('abc'), null);
  });
});

describe('نطاق اللوحة وأمان المعالجات', () => {
  test('مدخل مخفي في قالب لا يُفتح من لوحته', async () => {
    const shown = entry(1, 'ظاهر');
    const hidden = entry(1, 'سري');
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], excludedIds: [hidden.id], userId: 'a' });
    assert.equal(faq.isVisibleIn(t.id, shown), true);
    assert.equal(faq.isVisibleIn(t.id, hidden), false);
    assert.equal(faq.isVisibleIn(0, hidden), true, 'اللوحة الافتراضية تعرض كل شيء');

    const i = interaction({ customId: `faq:view:${t.id}`, values: [String(hidden.id)] });
    await dispatch(i);
    assert.match(i.payload.embeds[0].data.description, /غير متاح في هذه اللوحة/);
  });

  test('تصنيف محذوف في لوحة قديمة يرفض بوضوح بدل الانهيار', async () => {
    entry(1, 'قانون');
    for (const stale of ['0', '99', 'abc', undefined]) {
      const i = interaction({ customId: 'faq:cat', values: stale === undefined ? [] : [stale] });
      await dispatch(i);
      assert.match(i.payload.embeds[0].data.description, /لم يعد متاحاً/, `القيمة ${stale}`);
    }
  });

  test('أمر /faq يرفض تصنيفاً غير موجود بدل الانهيار', async () => {
    const i = interaction({ level: LEVELS.STAFF });
    i.options = { getInteger: () => 99 };
    await commands.get('faq').execute(i);
    assert.match(i.payload.embeds[0].data.description, /التصنيف غير موجود/);
  });

  test('البحث يعامل % و _ كنصوص حرفية ولا يتجاوز نتائج القالب', () => {
    for (let n = 1; n <= 40; n++) entry(1, `سؤال ${n}`, { content: 'محتوى' });
    const all = faq.list(1);
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], excludedIds: all.slice(0, 10).map(e => e.id), userId: 'a' });

    assert.equal(faq.search('%').length, 0, 'علامة % ليست بحثاً عن كل شيء');
    assert.equal(faq.search('').length, 0, 'بحث فارغ = لا نتائج');
    assert.equal(faq.search('   ').length, 0);

    const results = faq.search('سؤال', { templateId: t.id });
    assert.equal(results.length, 25, 'القصّ بعد التصفية بالقالب');
    assert.equal(results.some(e => all.slice(0, 10).some(x => x.id === e.id)), false, 'لا تظهر المدخلات المخفية');
  });

  test('البحث يجد نصاً يحتوي % حرفياً', () => {
    entry(1, 'خصم 50% اليوم');
    entry(1, 'بلا نسبة');
    assert.equal(faq.search('50%').length, 1);
    assert.equal(faq.search('%').length, 1, '% تبحث عن الرمز نفسه لا عن كل المدخلات');
    assert.equal(faq.search('_').length, 0);
  });

  test('templatesShowing: تحديث لوحات القوالب المعنية فقط', () => {
    const e1 = entry(1, 'قانون');
    entry(3, 'تصعيد');
    const first = faq.addTemplate({ name: 'أول', title: 'أ', description: '', categoryIds: [1], userId: 'a' });
    const second = faq.addTemplate({ name: 'ثانٍ', title: 'ب', description: '', categoryIds: [3], userId: 'a' });
    assert.deepEqual(faq.templatesShowing(e1).sort(), [0, first.id].sort());
    assert.deepEqual(faq.templatesShowing(e1, 3).sort(), [0, first.id, second.id].sort(), 'التصنيف السابق يُحدَّث أيضاً');
  });

  test('زر السجل يظهر للإدارة فقط', () => {
    const e = entry(1, 'قانون', { important: true });
    const forStaff = faqCmd.entryEmbed(e, IDS.user).components[0].components.map(c => c.data.custom_id);
    const forManager = faqCmd.entryEmbed(e, IDS.user, { canManage: true }).components[0].components.map(c => c.data.custom_id);
    assert.equal(forStaff.includes(`faq:hist:${e.id}`), false);
    assert.equal(forManager.includes(`faq:hist:${e.id}`), true);
  });
});

describe('تحقق الخدمة قبل الكتابة', () => {
  test('ترفض تصنيفاً غير موجود ونصوصاً فارغة أو طويلة', () => {
    assert.throws(() => faq.add({ categoryId: 99, title: 'ع', content: 'م', userId: 'a' }), /التصنيف غير موجود/);
    assert.throws(() => faq.add({ categoryId: 1, title: '   ', content: 'م', userId: 'a' }), /عنوان المدخل مطلوب/);
    assert.throws(() => faq.add({ categoryId: 1, title: 'ع', content: '', userId: 'a' }), /محتوى المدخل مطلوب/);
    assert.throws(() => faq.add({ categoryId: 1, title: 'ط'.repeat(101), content: 'م', userId: 'a' }), /أطول من/);
    assert.throws(() => faq.add({ categoryId: 1, title: 'ع', content: 'م' }), /بدون مستخدم/);
    assert.equal(getDb().prepare('SELECT COUNT(*) n FROM faq_entries').get().n, 0, 'لا يُكتب شيء عند الرفض');
  });

  test('قالب بلا اسم أو بلون تالف يُرفض أو يُصحَّح', () => {
    assert.throws(() => faq.addTemplate({ name: '', title: 'لوحة', description: '', categoryIds: [1], userId: 'a' }), /اسم القالب مطلوب/);
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], color: 'not-a-color', userId: 'a' });
    assert.equal(t.color, faq.DEFAULT_TEMPLATE.color);
    assert.throws(() => faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], userId: null }), /بدون مستخدم/);
  });

  test('اسم اللوحة يُنظَّف قبل الحفظ', () => {
    entry(1, 'قانون');
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], userId: 'a' });
    faq.addPanel('m1', 'c1', 'a', t.id, { label: 'روم\nالدعم   العام' });
    assert.equal(faq.panels()[0].label, 'روم الدعم العام');
  });
});

describe('دورة حياة المدخل مع القوالب', () => {
  test('حذف مدخل يزيله من التثبيت والإخفاء ويبقي سجله', () => {
    const e = entry(1, 'قانون', { important: true });
    const t = faq.addTemplate({ name: 'قالب', title: 'لوحة', description: '', categoryIds: [1], pinnedIds: [e.id], excludedIds: [e.id], userId: 'a' });
    faq.acknowledge(e.id, IDS.other, e.version);
    assert.equal(faq.hasRead(e.id, IDS.other), true);

    faq.remove(e.id, 'a');
    const after = faq.template(t.id);
    assert.deepEqual(after.pinnedIds, []);
    assert.deepEqual(after.excludedIds, []);
    assert.equal(faq.get(e.id), null);
    assert.deepEqual(faq.history(e.id).map(h => h.action).sort(), ['create', 'delete'], 'السجل يبقى بعد الحذف');
    assert.equal(faq.hasRead(e.id, IDS.other), false);
  });

  test('تعديل مدخل مهم يطلب تأكيد القراءة من جديد', () => {
    const e = entry(1, 'قانون', { important: true });
    faq.acknowledge(e.id, IDS.user, e.version);
    assert.equal(faq.unreadFor(IDS.user).length, 0);
    const edited = faq.edit(e.id, { content: 'محتوى محدّث', userId: 'a' });
    assert.equal(edited.version, 2);
    assert.equal(faq.unreadFor(IDS.user).length, 1);
  });
});
