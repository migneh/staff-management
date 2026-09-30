'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ComponentType, ModalBuilder, ActionRowBuilder, TextInputBuilder, TextInputStyle } = require('discord.js');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const forms = require('../src/ui/forms');
const wizard = require('../src/commands/wizard');
const { commands, resolveComponent } = require('../src/commands');
const { dispatch } = require('../src/services/componentDispatch');
const { LEVELS, FAQ_CATEGORIES } = require('../src/constants');
const IDS = { user: '1005171993940852796', target: '1490787800168005713', channel: '223456789012345678', guild: '323456789012345678' };
let next = 1n;

function interaction({ customId = '', level = LEVELS.BOSS, team = 'support', texts = {}, users = {}, channels = {}, selects = {}, values = [], admin = false } = {}) {
  return {
    customId, user: { id: IDS.user }, guildId: IDS.guild, channelId: IDS.channel, client: {}, staffLevel: level, staffInfo: { team },
    member: { permissions: { has: () => admin } }, values,
    fields: {
      getField(id) {
        if (Object.hasOwn(texts, id)) return { custom_id: id, type: ComponentType.TextInput, value: texts[id] };
        const values = selects[id] != null ? [].concat(selects[id]) : users[id] ? [users[id].id] : channels[id] ? [channels[id].id] : null;
        if (!values) return { custom_id: id, type: ComponentType.TextInput, value: '' };
        return { custom_id: id, type: users[id] ? ComponentType.UserSelect : channels[id] ? ComponentType.ChannelSelect : ComponentType.StringSelect, values };
      },
      getTextInputValue: id => texts[id] ?? '',
      getStringSelectValues: id => [].concat(selects[id] ?? []),
      getSelectedUsers: id => users[id] ? new Collection([[users[id].id, users[id]]]) : null,
      getSelectedChannels: id => channels[id] ? new Collection([[channels[id].id, channels[id]]]) : null,
    },
    async reply(p) { this.payload = p; }, async update(p) { this.payload = p; }, async showModal(m) { this.modal = m; },
  };
}
function labels(modal) { return modal.toJSON().components; }
beforeEach(() => { openMemoryDb(); settings.setChannel('support-rating-logs', IDS.channel); });
const legacy = (id, title, fields) => {
  const m = new ModalBuilder().setCustomId(id).setTitle(title);
  for (const f of fields) m.addComponents(new ActionRowBuilder().addComponents(f));
  return m;
};
const input = (id, label, { value = '', required = true, max = 100, long = false } = {}) => new TextInputBuilder()
  .setCustomId(id).setLabel(label).setStyle(long ? TextInputStyle.Paragraph : TextInputStyle.Short).setMaxLength(max).setRequired(required).setValue(value);

test('كل نموذج مُحوَّل إلى Label يحمل وصفاً مفيداً ولا يتجاوز حدود Discord', () => {
  const samples = [
    legacy('leave:modal:normal', 'طلب إجازة', [input('reason', 'السبب (إجباري)', { long: true, max: 500 }), input('start', 'البداية YYYY-MM-DD', { max: 10 }), input('end', 'النهاية YYYY-MM-DD', { max: 10 }), input('attachment', 'رابط مرفق (اختياري)', { required: false })]),
    legacy('resign:acceptmodal:3', 'قبول', [input('reason', 'رسالة وداع (اختياري)', { required: false, long: true }), input('exit_interview', 'ملاحظة مقابلة الخروج — اختياري', { required: false, long: true })]),
    legacy('faq:editmodal:2', 'تعديل المدخل', [input('title', 'العنوان'), input('content', 'المحتوى', { long: true, max: 4000 }), input('category', 'رقم التصنيف (1-11)', { max: 2, value: '4' }), input('important', 'مهم؟ (نعم/لا)', { required: false, value: 'نعم' })]),
    legacy('faq:template-addmodal', 'قالب', [input('name', 'اسم القالب (داخلي)'), input('title', 'عنوان اللوحة'), input('description', 'وصف اللوحة', { required: false, long: true }), input('categories', 'التصنيفات: all أو أرقام', { required: false, value: '1,3' }), input('color', 'لون #RRGGBB وملاحظة (اختياري)', { required: false, value: '#5865F2' })]),
    legacy('score:weightsmodal:support', 'أوزان Score', [input('tickets', 'التكتات (من 100)', { max: 3, value: '30' }), input('speed', 'السرعة (من 100)', { max: 3, value: '25' })]),
    legacy('setup:policies-leave-modal', 'سياسات الإجازات', [input('maxConcurrent', 'الحد الأقصى للمجازين معاً', { max: 2, value: '3' }), input('maxDays', 'أطول إجازة (أيام)', { max: 3, value: '30' })]),
    legacy('ticket:log:auto', 'تسجيل تكت', [input('ticket_id', 'رقم التكت', { max: 40, value: 'ticket-9' }), input('duration', 'المدة — اختياري', { required: false, max: 30 })]),
  ];
  for (const source of samples) {
    const modal = forms.modernize(source).toJSON();
    assert(modal.components.length <= 5, `${source.data.custom_id} تجاوز 5 مكوّنات`);
    for (const label of modal.components) {
      if (label.type === ComponentType.TextDisplay) { assert(label.content?.trim(), 'نص إرشادي فارغ'); continue; }
      assert.equal(label.type, ComponentType.Label, `${source.data.custom_id}: مكوّن بلا Label`);
      assert(label.label?.trim(), `${source.data.custom_id}: تسمية فارغة`);
      assert(label.description?.trim(), `${source.data.custom_id}: وصف فارغ لحقل ${label.label}`);
      assert(label.description.length <= 100, `${source.data.custom_id}: وصف أطول من 100 حرف`);
      assert(label.component.custom_id, `${source.data.custom_id}: معرّف الحقل مفقود`);
      if (label.component.type === ComponentType.TextInput) assert.equal(label.component.label, undefined, 'التسمية مكررة داخل الحقل');
    }
  }
  const entry = forms.modernize(samples[2]).toJSON().components;
  assert.equal(entry[2].component.type, ComponentType.StringSelect, 'التصنيف يجب أن يصبح قائمة');
  assert.equal(entry[2].component.options.length, FAQ_CATEGORIES.length, 'عدد التصنيفات في القائمة = عدد التصنيفات الفعلية');
  assert.equal(entry[2].component.options.filter(o => o.value === '2').length, 1);
  assert(entry[3].component.options.some(o => o.value === 'نعم'));
  const template = forms.modernize(samples[3]).toJSON().components;
  assert.equal(template[3].component.max_values, FAQ_CATEGORIES.length, 'اختيار «كل التصنيفات» لا يزيد الحد عن عدد التصنيفات');
  assert.equal(template[3].component.options.length, FAQ_CATEGORIES.length + 1);
  assert(template[3].component.options.some(o => o.value === 'all' && o.default === false));
  assert.equal(template[4].component.max_length, 100);
});


/** يفتح نموذج التواريخ المخصصة من بطاقة الاختيار السريع في /request-leave. */
async function openLeaveModal(open) {
  const card = open.payload.components[0].components[0].toJSON();
  const token = card.custom_id.split(':')[2];
  const custom = interaction({ level: LEVELS.STAFF, customId: `leave:qstart:${token}`, values: ['custom'] });
  await resolveComponent(`leave:qstart:${token}`).handler(custom, [token]);
  return custom.modal;
}

test('نماذج الأوامر الحقيقية تصل كلها بصيغة Label مع قوائم الأعضاء والنجوم', async () => {
  for (const name of ['log-ticket', 'log-action']) {
    const i = interaction({ level: LEVELS.SUPERVISOR, team: 'moderation', selects: { type: 'warn' }, users: { closer: { id: IDS.target } } });
    i.options = { getUser: () => ({ id: IDS.target }), getString: () => 'warn' };
    await commands.get(name).execute(i);
    const modal = i.modal.toJSON();
    assert(modal.components.filter(c => c.type !== ComponentType.TextDisplay).every(c => c.type === ComponentType.Label), `${name}: نموذج قديم`);
    assert(modal.components.some(c => c.component.type === ComponentType.UserSelect), `${name}: بلا اختيار عضو`);
    assert(modal.custom_id.startsWith(name === 'log-ticket' ? 'ticket:log:' : 'modaction:log:'));
  }
  const leave = interaction({ level: LEVELS.STAFF });
  leave.options = { getString: () => 'normal' };
  await commands.get('request-leave').execute(leave);
  const modal = (await openLeaveModal(leave)).toJSON();
  assert.equal(modal.components[0].label, 'سبب الإجازة');
  assert.notEqual(modal.components[0].component.required, false);
  assert.match(modal.components[0].description, /السبب/);
  assert.match(modal.components[1].description, /سنة-شهر-يوم/);
  assert.match(modal.components[2].description, /النهاية|الراحة/);
  assert.equal(modal.components.filter(c => c.type !== ComponentType.TextDisplay).at(-1).component.required, false);
  assert(modal.components.some(c => c.type === ComponentType.TextDisplay), 'بلا تلميح يشرح الخطوة التالية');
  assert(modal.components.filter(c => c.type === ComponentType.Label).every(c => c.description), 'حقل بلا شرح');
});

test('معالج الخيارات يبني نموذجاً من مخطط الأمر ثم يعرض مراجعة قبل التنفيذ', async () => {
  const i = interaction({ level: LEVELS.MANAGEMENT });
  await wizard.start(i, 'assign-task');
  const modal = i.modal.toJSON();
  assert.deepEqual(modal.components.map(c => c.component.custom_id), ['user', 'title', 'description', 'due', 'type']);
  assert.equal(modal.components[0].component.type, ComponentType.UserSelect);
  assert.equal(modal.components[4].component.type, ComponentType.StringSelect);
  assert.equal(modal.components[4].component.options.length, 3);
  assert.match(modal.components[3].description, /سنة-شهر-يوم/);

  const token = modal.custom_id.match(/^wizard:submit:([a-f0-9]{16}):0:form:[a-f0-9]{16}$/)?.[1];
  assert(token, `معرّف غير متوقع: ${modal.custom_id}`);
  getDb().prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)').run(IDS.target, 'target', 'support', 'Support', 'active');
  const submit = interaction({ customId: `wizard:submit:${token}:0`, level: LEVELS.MANAGEMENT, texts: { title: 'متابعة العميل ٧', description: 'تواصل بعد يومين', due: '٣٠/٠٩/٢٠٢٦' }, users: { user: { id: IDS.target } }, selects: { type: 'follow_up' } });
  await dispatch(submit);
  const preview = submit.payload.embeds[0].toJSON();
  assert.match(preview.title, /راجع الإجراء/);
  assert(preview.fields.some(f => f.value.includes('2026-09-30')), 'التاريخ لم يُطبَّع');
  assert(preview.fields.some(f => f.value.includes('متابعة')), 'الاختيار لم يُعرض باسمه');
  const runId = submit.payload.components[0].components[0].data.custom_id;
  assert.match(runId, new RegExp(`^wizard:run:${token}:1$`));

  const run = interaction({ customId: runId, level: LEVELS.MANAGEMENT });
  await dispatch(run);
  const task = getDb().prepare('SELECT * FROM staff_tasks').get();
  assert.equal(task.title, 'متابعة العميل ٧');
  assert.equal(task.due_date, '2026-09-30');
  assert.equal(task.task_type, 'follow_up');
  assert.equal(task.user_id, IDS.target);
  assert.match(run.payload.embeds[0].toJSON().description, new RegExp(`#${task.id}`));

  const replay = interaction({ customId: runId, level: LEVELS.MANAGEMENT });
  await dispatch(replay);
  assert.match(replay.payload.embeds[0].toJSON().description, /استخدام هذا التأكيد|استُخدمت|قديمة/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM staff_tasks').get().c, 1, 'التكرار أنشأ مهمة ثانية');
});

test('يرفض المدخلات الخاطئة ويحفظها لتصحيحها دون تنفيذ', async () => {
  const i = interaction({ level: LEVELS.MANAGEMENT });
  await wizard.start(i, 'assign-task');
  const token = i.modal.toJSON().custom_id.match(/:([a-f0-9]{16}):0:form:[a-f0-9]{16}$/)[1];
  const cases = [
    [{ selects: { type: 'nope' }, users: { user: { id: IDS.target } }, texts: { title: 'س' } }, /قيمة (صالحة|من القائمة)/],
    [{ selects: { type: 'general' }, users: { user: { id: IDS.target } }, texts: { title: 'س', due: '32/13/2026' } }, /راجع تاريخ/],
    [{ selects: { type: 'general' }, users: { user: { id: IDS.target } }, texts: { title: '' } }, /أكمل/],
    [{ selects: { type: 'general' }, users: {}, texts: { title: 'س' } }, /لم تختر|اختر/],
  ];
  for (const [values, pattern] of cases) {
    const submit = interaction({ customId: `wizard:submit:${token}:0`, level: LEVELS.MANAGEMENT, ...values });
    await dispatch(submit);
    assert.match(submit.payload.embeds[0].toJSON().description, pattern);
    assert(submit.payload.components?.[0]?.components[0].data.custom_id.startsWith('wizard:reopen:'), 'لا يوجد زر تصحيح');
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM staff_tasks').get().c, 0, 'نُفّذ إجراء رغم الخطأ');
  }
  // زر التصحيح يعيد فتح النموذج نفسه بالبيانات المدخلة، ومعاينة قديمة لا تُنفَّذ بعد تعديل الخيارات.
  const retry = interaction({ customId: `wizard:reopen:${token}:0`, level: LEVELS.MANAGEMENT });
  await dispatch(retry);
  assert(retry.modal, 'لم يُعَد فتح النموذج');
  assert.match(retry.modal.toJSON().custom_id, new RegExp(`^wizard:submit:${token}:0:form:[a-f0-9]{16}$`));
  const stale = interaction({ customId: `wizard:run:${token}:0`, level: LEVELS.MANAGEMENT });
  await dispatch(stale);
  assert.match(stale.payload.embeds[0].toJSON().description, /أكمل الخيارات المطلوبة/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM staff_tasks').get().c, 0, 'نُفِّذ أمر بخيارات ناقصة');
});

test('المعالج يعيد فحص الصلاحيات والفريق والإيقاف عند كل خطوة', async () => {
  const lowLevel = interaction({ level: LEVELS.STAFF, team: 'support' });
  await wizard.start(lowLevel, 'assign-task');
  assert.equal(lowLevel.modal, undefined);
  assert.match(lowLevel.payload.embeds[0].toJSON().description, /متاح لـ/);
  const outsider = interaction({ level: LEVELS.MANAGEMENT, team: 'support' });
  await wizard.start(outsider, 'log-action');
  assert.match(outsider.payload.embeds[0].toJSON().description, /الإشراف|خاص بـ/);
  assert.equal(outsider.modal, undefined);

  const admin = interaction({ level: LEVELS.BOSS, admin: false });
  await wizard.start(admin, 'setup');
  assert.equal(admin.modal, undefined);
  assert.match(admin.payload.embeds[0].toJSON().description, /Administrator/);

  getDb().prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)').run(IDS.user, 'me', 'support', 'Support', 'suspended');
  const suspended = interaction({ level: LEVELS.MANAGEMENT });
  await wizard.start(suspended, 'assign-task');
  assert.match(suspended.payload.embeds[0].toJSON().description, /موقوف/);
});

test('ينتهي النموذج بعد صلاحيته ويُرفض بعد انتهاء الجلسة أو مع مستخدم آخر', async () => {
  const i = interaction({ level: LEVELS.MANAGEMENT });
  await wizard.start(i, 'assign-task');
  const token = i.modal.toJSON().custom_id.match(/:([a-f0-9]{16}):0:form:[a-f0-9]{16}$/)[1];
  const other = interaction({ customId: `wizard:submit:${token}:0`, level: LEVELS.MANAGEMENT });
  other.user = { id: IDS.target };
  await dispatch(other);
  assert.match(other.payload.embeds[0].toJSON().description, /انتهت (جلسة|صلاحية)/);
  const unknown = interaction({ customId: `wizard:submit:${'f'.repeat(16)}:0`, level: LEVELS.MANAGEMENT });
  await dispatch(unknown);
  assert.match(unknown.payload.embeds[0].toJSON().description, /انتهت (جلسة|صلاحية)/);
  assert.equal(forms.TTL, 15 * 60 * 1000);
});

test('نماذج الأوامر الحقيقية: الخطأ يُصحَّح بزر واحد والنجاح يغلق الجلسة', async () => {
  const open = interaction({ level: LEVELS.STAFF });
  open.options = { getString: () => 'normal' };
  await commands.get('request-leave').execute(open);
  const formToken = (await openLeaveModal(open)).toJSON().custom_id.match(/:form:([a-f0-9]{16})$/)[1];
  const bad = interaction({ customId: `leave:modal:normal:form:${formToken}`, level: LEVELS.STAFF, texts: { reason: 'ظرف عائلي', start: '32/13/2026', end: '2026-10-05' } });
  await dispatch(bad);
  assert.match(bad.payload.embeds[0].toJSON().description, /تاريخ|صيغة/);
  assert.equal(bad.payload.components?.[0]?.components[0].data.custom_id, `form:retry:${formToken}`, 'لا يوجد زر تصحيح للنموذج القديم');
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0, 'أُنشئ طلب رغم خطأ التاريخ');
  const retry = interaction({ customId: `form:retry:${formToken}`, level: LEVELS.STAFF });
  await dispatch(retry);
  assert.equal(retry.modal.toJSON().components[0].component.value, 'ظرف عائلي', 'لم تُحفظ القيم للتصحيح');
  const good = interaction({ customId: `leave:modal:normal:form:${formToken}`, level: LEVELS.STAFF, texts: { reason: 'ظرف عائلي', start: '2026-10-01', end: '2026-10-05' } });
  await dispatch(good);
  assert.equal(forms.lookup({ customId: `form:retry:${formToken}`, user: { id: IDS.user }, guildId: IDS.guild }), null, 'بقيت جلسة النموذج بعد الإرسال');
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0, 'بطاقة المراجعة لا تنشئ الطلب');
  // الإرسال النهائي من بطاقة المراجعة (المسودة) هو ما ينشئ الطلب.
  const draftId = good.payload.components[0].components[0].data.custom_id;
  assert.match(draftId, /^leave:draft-submit:[a-f0-9]{16}$/);
  const confirm = interaction({ customId: draftId, level: LEVELS.STAFF });
  await dispatch(confirm);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 1);
  assert.match(confirm.payload.embeds[0].toJSON().title, /تم إرسال طلبك/);
  await dispatch(interaction({ customId: draftId, level: LEVELS.STAFF }));
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 1, 'النقر المتكرر لا يكرر الطلب');
});

test('كل أوامر السجل قابلة للفتح من المعالج أو تُرشد إلى الأمر الأصلي دون استثناء', async () => {
  for (const [name, command] of commands) {
    const i = interaction({ level: LEVELS.BOSS, team: command.team || 'support' });
    await wizard.start(i, name);
    if (i.modal) {
      const modal = i.modal.toJSON();
      assert(modal.components.length <= 5, `${name}: أكثر من 5 حقول`);
      assert(modal.components.filter(c => c.type !== ComponentType.TextDisplay).every(c => c.type === ComponentType.Label && c.description), `${name}: حقول بلا وصف`);
    } else {
      assert(i.payload?.embeds?.length, `${name}: لا نموذج ولا رد`);
    }
  }
});
