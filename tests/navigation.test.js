'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const { commands, resolveComponent, validateRegistry } = require('../src/commands');
const { LEVELS, SUPPORT_RANKS, MOD_RANKS, GENERAL_MANAGEMENT_RANKS } = require('../src/constants');
const settings = require('../src/services/settings');
const tasks = require('../src/services/tasks');
const { accessContext, commandAccessError } = require('../src/services/commandAccess');
const { helpPayload, runQuickAction, visibleCommands, normalizeSearch, QUICK_ACTIONS } = require('../src/ui/navigation');
const { taskPayload } = require('../src/commands/tasks');
const { homePage } = require('../src/commands/setup');

beforeEach(() => { openMemoryDb(); settings.set('test', true); }); // Invalidate settings cache between databases.

function interaction({ team = 'support', level = LEVELS.STAFF, owner = false, admin = false, id = 'user1', status = 'active' } = {}) {
  if (team) getDb().prepare('INSERT OR REPLACE INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'tester', team, team === 'support' ? 'Helper' : team === 'moderation' ? 'Moderator' : 'Co General Manager', status);
  const i = {
    user: { id }, client: {}, staffLevel: level, staffInfo: team ? { team, level } : undefined,
    member: { id, displayName: 'Tester', guild: { ownerId: owner ? id : 'owner' }, roles: { cache: new Map() }, permissions: { has: () => admin } },
    async reply(payload) { assert(!this.replied); this.replied = true; this.payload = payload; return payload; },
    async update(payload) { this.payload = payload; return payload; },
    async showModal(modal) { this.modal = modal; return modal; },
  };
  return i;
}
function json(payload) {
  return { ...payload, embeds: payload.embeds?.map(e => e.toJSON()), components: payload.components?.map(c => c.toJSON()) };
}
function validatePayload(payload) {
  const p = json(payload);
  let length = 0;
  for (const e of p.embeds || []) {
    assert((e.title || '').length <= 256);
    assert((e.description || '').length <= 4096);
    assert((e.fields || []).length <= 25);
    length += (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length + (e.author?.name || '').length;
    for (const f of e.fields || []) {
      assert(f.name.length <= 256);
      assert(f.value.length > 0 && f.value.length <= 1024);
      length += f.name.length + f.value.length;
    }
  }
  assert(length <= 6000);
  assert((p.components || []).length <= 5);
  for (const row of p.components || []) {
    assert(row.components.length > 0 && row.components.length <= 5);
    for (const c of row.components) {
      assert(c.custom_id.length <= 100);
      assert(resolveComponent(c.custom_id), c.custom_id);
      if (c.type === 3) {
        assert(row.components.length === 1);
        assert(c.options.length > 0 && c.options.length <= 25);
        assert(new Set(c.options.map(o => o.value)).size === c.options.length);
        assert(c.options.filter(o => o.default).length <= 1);
      }
    }
  }
  return p;
}
const names = payload => json(payload).embeds.flatMap(e => e.fields || []).map(f => f.name);

test('الدليل يستمد الأوامر من السجل ويخفي صلاحيات الإدارة والفريق الآخر', () => {
  const i = interaction();
  const visible = visibleCommands(accessContext(i)).map(c => c.data.name);
  assert(visible.includes('request-leave'));
  for (const name of ['setup', 'manage-general', 'review-leaves', 'faq-add', 'log-action']) assert(!visible.includes(name), name);
  assert(names(helpPayload(i, 'work')).includes('/log-ticket'));
  assert(!names(helpPayload(i, 'faq')).includes('/faq-add'));
  const boss = interaction({ level: LEVELS.BOSS });
  assert(!visibleCommands(accessContext(boss)).some(c => c.data.name === 'request-promotion'));
});

test('كل صفحات الدليل تحترم حدود Discord والتصفح لا يكرر الأوامر أو يسقطها', () => {
  for (const context of [{}, { team: 'moderation' }, { team: 'general_management', level: LEVELS.GENERAL_MANAGEMENT }, { owner: true, admin: true, level: LEVELS.GENERAL_MANAGER }, { team: null, owner: true, level: LEVELS.GENERAL_MANAGER }]) {
    const i = interaction(context);
    const initial = validatePayload(helpPayload(i));
    const sections = initial.components[0].components[0].options.map(o => o.value).filter(id => id !== 'start');
    const seen = [];
    for (const section of sections) {
      let page = 0;
      for (;;) {
        const p = validatePayload(helpPayload(i, section, page));
        seen.push(...names(helpPayload(i, section, page)).filter(n => n.startsWith('/')).map(n => n.slice(1)));
        const next = p.components.flatMap(r => r.components).find(c => c.label === 'التالي');
        if (!next || next.disabled) break;
        assert(++page < 20);
      }
    }
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual(seen.sort(), visibleCommands(accessContext(i)).map(c => c.data.name).filter(n => n !== 'help').sort());
  }
});

test('المساعدة تعمل لمالك السيرفر بلا بطاقة إداري ومع قيم صفحات قديمة أو غير صالحة', async () => {
  const i = interaction({ team: null, owner: true, level: LEVELS.GENERAL_MANAGER });
  for (const page of [-99, 'NaN', 1.5, 999999]) validatePayload(helpPayload(i, 'manage', page));
  validatePayload(helpPayload(i, 'unknown'));
  i.values = ['requests'];
  await resolveComponent('help:section').handler(i);
  validatePayload(i.payload);
  assert(!JSON.stringify(json(i.payload)).includes('undefined'));
  assert(!visibleCommands(accessContext(i)).some(c => c.data.name === 'me'));
});

test('البحث يقبل العربية والأمر مع الشرطة المائلة ويعطي حالة فارغة واضحة', () => {
  const i = interaction();
  assert.equal(normalizeSearch('إِجَازَة'), normalizeSearch('اجازة'));
  assert(names(helpPayload(i, 'start', 0, 'اجازة')).includes('/request-leave'));
  assert(names(helpPayload(i, 'start', 0, '/my-tasks')).includes('/my-tasks'));
  const empty = validatePayload(helpPayload(i, 'start', 0, '   '));
  assert.match(empty.embeds[0].description, /لا توجد نتائج/);
  assert(!names(helpPayload(i, 'start', 0, 'faq-add')).includes('/faq-add'));
});

test('البحث والتنقل يحدثان الرسالة نفسها والنموذج صالح', async () => {
  const i = interaction();
  await resolveComponent('help:search').handler(i);
  assert.match(i.modal.toJSON().custom_id, /^help:searchmodal:form:[a-f0-9]{16}$/);
  i.fields = { getTextInputValue: () => 'مهام' };
  await resolveComponent('help:searchmodal').handler(i);
  validatePayload(i.payload);
  assert(!i.replied);
  await resolveComponent('help:open').handler(i);
  assert.equal(json(i.payload).embeds[0].title, '🏠 ابدأ من هنا');
});

test('اختصار الإجازة يختار النوع ثم يبني الطلب بنقرات دون كتابة تواريخ', async () => {
  const i = interaction();
  await runQuickAction(i, 'request-leave');
  const payload = validatePayload(i.payload);
  assert.equal(payload.ephemeral, true);
  assert(!i.modal);
  const menu = payload.components[0].components[0];
  const submit = interaction();
  submit.values = [menu.options[0].value];
  const route = resolveComponent(menu.custom_id);
  await route.handler(submit, route.args);
  // بطاقة الاختيار السريع: يوم البداية + المدة + السبب، والطلب لا يُرسل من هنا.
  const card = submit.payload.embeds[0].toJSON();
  assert.match(card.title, /اختر بنقرة/);
  const ids = submit.payload.components.map(r => r.components[0].data.custom_id.split(':').slice(0, 2).join(':'));
  assert.deepEqual(ids.slice(0, 3), ['leave:qstart', 'leave:qdays', 'leave:qreason']);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0);
  const token = submit.payload.components[0].components[0].data.custom_id.split(':')[2];
  const { today: todayStr, addDays } = require('../src/utils');
  const start = addDays(todayStr(), 5);   // «عادية» تتطلب إشعاراً، فالتاريخ القريب يُرفض عمداً
  const pick = (id, value) => { const c = interaction(); c.customId = id; c.values = [value]; return c; };
  // الأيام الأقرب من مهلة الإشعار تُعلَّم بالأسباب داخل القائمة
  const early = pick(`leave:qstart:${token}`, todayStr()); await resolveComponent('leave:qstart').handler(early, [token]);
  assert.match(early.payload.embeds[0].toJSON().description, /أقرب يوم مسموح/);
  const startOptions = early.payload.components[0].components[0].toJSON().options;
  assert(startOptions.some(o => /أقل من مهلة الإشعار/.test(o.description || '')), 'الأيام المتأخرة عن الإشعار تُعلَّم');
  for (const [id, value] of [[`leave:qstart:${token}`, start], [`leave:qdays:${token}`, '3'], [`leave:qreason:${token}`, 'ظرف عائلي']]) {
    const c = pick(id, value); await resolveComponent(id).handler(c, [token]);
  }
  const go = pick(`leave:qgo:${token}`, '');
  await resolveComponent('leave:qgo').handler(go, [token]);
  const preview = go.payload.embeds[0].toJSON();
  assert.match(preview.title, /راجع طلب إجازتك/);
  assert.match(preview.description, /المحتسب/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0, 'لم يُنشأ الطلب قبل الإرسال');
  const submitBtn = go.payload.components[0].components.find(b => b.data.custom_id.startsWith('leave:draft-submit:'));
  const final = interaction(); final.customId = submitBtn.data.custom_id;
  await resolveComponent('leave:draft-submit').handler(final, [submitBtn.data.custom_id.split(':')[2]]);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 1, 'لم يُنشأ الطلب بعد التأكيد');
});

test('الاختصارات تدعم خيارات الأوامر الاختيارية وحالة التفاعل الحقيقية', async () => {
  const i = interaction();
  await runQuickAction(i, 'my-leaves');
  assert(i.replied);
  assert.equal(i.options.getInteger('page'), null);
  assert(i.payload.ephemeral);
  validatePayload(i.payload);
});

test('لا يمكن تجاوز الصلاحية أو الفريق أو الإيقاف أو قائمة السماح بالاختصار', async () => {
  for (const name of ['review-leaves', 'log-action', 'manage-general', 'setup', 'not-a-command', 'constructor', 'toString']) {
    const i = interaction();
    await runQuickAction(i, name);
    assert(!i.modal);
    assert(i.payload.ephemeral);
    assert(!i.options, name);
  }
  const owner = interaction({ owner: true, admin: true, level: LEVELS.GENERAL_MANAGER });
  await runQuickAction(owner, 'backup'); // Even authorized operations are not arbitrary shortcuts.
  assert(!owner.options);
  const suspended = interaction({ status: 'suspended' });
  await runQuickAction(suspended, 'request-leave', 'regular');
  assert(!suspended.modal);
  assert.match(json(suspended.payload).embeds[0].description, /موقوف/);
  const limited = interaction({ level: LEVELS.BOSS });
  await runQuickAction(limited, 'request-promotion');
  assert(!limited.modal);
  assert(!limited.options);
  const invalid = interaction();
  await runQuickAction(invalid, 'request-leave', 'invalid');
  assert(!invalid.modal);
  assert(!invalid.options);
});

test('إعادة فحص الصلاحية عند اختيار النوع تمنع النماذج بعد الإيقاف', async () => {
  const i = interaction();
  await runQuickAction(i, 'request-leave');
  getDb().prepare("UPDATE staff_members SET status = 'suspended' WHERE user_id = ?").run(i.user.id);
  const choice = { ...i, replied: false };
  await runQuickAction(choice, 'request-leave', json(i.payload).components[0].components[0].options[0].value);
  assert(!choice.modal);
  assert.match(json(choice.payload).embeds[0].description, /موقوف/);
});

test('سياسة الوصول تغطي المدير وAdministrator والحدود العليا والدنيا', () => {
  const base = { level: LEVELS.STAFF, team: 'support' };
  assert(commandAccessError(commands.get('review-leaves'), base));
  assert.equal(commandAccessError(commands.get('review-leaves'), { ...base, level: LEVELS.MANAGEMENT }), null);
  assert(commandAccessError(commands.get('manage-general'), { ...base, level: LEVELS.GENERAL_MANAGER }));
  assert.equal(commandAccessError(commands.get('manage-general'), { ...base, serverManager: true }), null);
  assert(commandAccessError(commands.get('setup'), { ...base, serverManager: true }));
  assert.equal(commandAccessError(commands.get('setup'), { ...base, admin: true }), null);
  assert(commandAccessError(commands.get('request-promotion'), { ...base, level: LEVELS.BOSS }));
  assert.equal(commandAccessError(commands.get('my-record'), { ...base, suspended: true }), null);
});

test('لوحتي تعرض أولوية واحدة وتفصل طلبات المتابعة وتتيح العودة والتحديث', async () => {
  const i = interaction();
  tasks.create({ userId: i.user.id, title: 'أكمل التأهيل', taskType: 'onboarding' });
  await commands.get('me').execute(i);
  const p = validatePayload(i.payload);
  assert.match(p.embeds[0].fields[0].value, /مهمة معلّقة/);
  await resolveComponent('me:home').handler(i);
  validatePayload(i.payload);
  assert(p.components.flatMap(r => r.components).some(c => c.custom_id === 'me:home'));
});

test('كل الاختصارات المسموحة تشير إلى أوامر موجودة ومدخلاتها قابلة للاختيار', () => {
  for (const name of Object.keys(QUICK_ACTIONS)) {
    const c = commands.get(name);
    assert(c, name);
    const required = (c.data.toJSON().options || []).filter(o => o.required);
    assert(required.length <= 1);
    if (required.length) assert(required[0].choices?.length <= 25);
  }
  assert.deepEqual(validateRegistry(), []);
});

test('الإعداد يعرض أول رتبة ناقصة ثم الإجازة ثم القنوات ويحافظ على الأقسام', async () => {
  let p = validatePayload(homePage());
  assert.equal(p.components.length, 2);
  assert.equal(p.components[0].components[0].custom_id, 'setup:roles:support:0');
  for (const [team, ranks] of Object.entries({ support: SUPPORT_RANKS, moderation: MOD_RANKS, general_management: GENERAL_MANAGEMENT_RANKS })) {
    ranks.forEach((r, index) => settings.setRole(team, r.name, `${team}-${index}`));
  }
  assert.equal(json(homePage()).components[0].components[0].custom_id, 'setup:roles:system:0');
  settings.setRole('system', 'in vacation', 'vacation');
  assert.equal(json(homePage()).components[0].components[0].custom_id, 'setup:channels:0');
  settings.CHANNEL_KEYS.forEach((key, index) => settings.setChannel(key, String(100000000000000000n + BigInt(index))));
  assert.match(json(homePage()).embeds[0].description, /مكتمل/);
  for (const option of p.components[1].components[0].options) {
    const i = interaction({ admin: true }); i.values = [option.value];
    await resolveComponent('setup:section').handler(i);
    validatePayload(i.payload);
  }
  assert(resolveComponent('setup:section').entry.adminOnly);
});

test('قائمة المهام تقسم النصوص الطويلة وتتيح الوصول لكل المهام دون كشف مهام الآخرين', async () => {
  const i = interaction();
  for (let n = 0; n < 27; n++) tasks.create({ userId: i.user.id, title: `المهمة ${n}`, description: 'ت'.repeat(500) });
  tasks.create({ userId: 'other', title: 'مهمة سرية' });
  const seen = new Set();
  for (let page = 1; page <= 6; page++) {
    const payload = validatePayload(taskPayload(i.user.id, false, page));
    for (const field of payload.embeds[0].fields) { assert(!seen.has(field.name)); seen.add(field.name); }
    assert(!JSON.stringify(payload).includes('مهمة سرية'));
  }
  assert.equal(seen.size, 27);
  const last = json(taskPayload(i.user.id, false, 6)).components[0].components[0].custom_id;
  const route = resolveComponent(last);
  await route.handler(i, route.args);
  assert.equal(tasks.pendingCount(i.user.id), 26);
  validatePayload(i.payload);
  const foreign = tasks.list('other')[0];
  const denied = interaction({ id: i.user.id });
  await resolveComponent('task:complete').handler(denied, [String(foreign.id)]);
  assert.equal(tasks.get(foreign.id).status, 'pending');
  validatePayload(taskPayload(i.user.id, false, 'bad'));
  validatePayload(taskPayload(i.user.id, false, 999));
  const empty = validatePayload(taskPayload('nobody'));
  assert.match(empty.embeds[0].description, /لا توجد مهام/);
  assert.equal(empty.components[0].components[0].custom_id, 'me:home');
});
