'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ComponentType } = require('discord.js');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const leaves = require('../src/services/leaves');
const scheduler = require('../src/scheduler');
const { commands, resolveComponent } = require('../src/commands');
const { dispatch } = require('../src/services/componentDispatch');
const { LEVELS } = require('../src/constants');
const { today, addDays } = require('../src/utils');

const IDS = { me: '1005171993940852796', peer: '1490787800168005713', boss: '223456789012345678', channel: '323456789012345678', guild: '423456789012345678' };
const D = (offset) => addDays(today(), offset);
let nextId = 1n;

function seedStaff(id = IDS.me, team = 'support', rank = 'Support', status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, rank = excluded.rank, status = excluded.status`).run(id, id, team, rank, status);
}
function seedLeave({ userId = IDS.peer, type = 'normal', start = D(5), end = D(7), status = 'approved', created = null } = {}) {
  const res = getDb().prepare('INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime(\'now\')))')
    .run(userId, type, 'سبب', start, end, leaves.spanDays(start, end), status, created);
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
}
function interaction({ customId = '', level = LEVELS.STAFF, team = 'support', status = 'active', texts = {}, users = {}, channels = {}, selects = {}, values = [], admin = false, id = IDS.me } = {}) {
  seedStaff(id, team, team === 'support' ? 'Support' : 'Moderator', status);
  return {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel, client: mockClient(), staffLevel: level, staffInfo: { team },
    member: { permissions: { has: () => admin } }, values, replied: false,
    fields: {
      getField(field) {
        if (Object.hasOwn(texts, field)) return { custom_id: field, type: ComponentType.TextInput, value: texts[field] };
        const values = selects[field] != null ? [].concat(selects[field]) : users[field] ? [users[field].id] : channels[field] ? [channels[field].id] : null;
        if (!values) return { custom_id: field, type: ComponentType.TextInput, value: '' };
        return { custom_id: field, type: users[field] ? ComponentType.UserSelect : channels[field] ? ComponentType.ChannelSelect : ComponentType.StringSelect, values };
      },
      getTextInputValue: id2 => texts[id2] ?? '',
      getStringSelectValues: id2 => [].concat(selects[id2] ?? []),
      getSelectedUsers: id2 => (users[id2] ? new Collection([[users[id2].id, users[id2]]]) : null),
      getSelectedChannels: id2 => (channels[id2] ? new Collection([[channels[id2].id, channels[id2]]]) : null),
    },
    async reply(payload) { this.replied = true; this.payload = payload; },
    async update(payload) { this.replied = true; this.updated = true; this.payload = payload; },
    async followUp(payload) { this.replied = true; this.followUpPayload = payload; },
    async showModal(modal) { this.modal = modal; },
  };
}
function mockClient() {
  return {
    channels: { fetch: async () => ({ send: async payload => ({ id: String(nextId++), payload }) }) },
    users: { fetch: async () => ({ send: async payload => { mockClient.sent.push(payload); } }) },
  };
}
mockClient.sent = [];
const json = payload => JSON.parse(JSON.stringify(payload?.toJSON ? payload.toJSON() : payload));
const field = (payload, name) => json(payload).embeds[0].fields.find(f => f.name.includes(name));

/** يفتح نموذج التواريخ المخصصة من بطاقة الاختيار السريع (المسار اليدوي). */
async function openCustomModal(open) {
  const card = json(open.payload);
  const token = card.components[0].components[0].custom_id.split(':')[2];
  const custom = interaction({ level: open.staffLevel, customId: `leave:qstart:${token}`, values: ['custom'] });
  await resolveComponent(`leave:qstart:${token}`).handler(custom, [token]);
  return custom.modal.toJSON();
}

const buttonIds = payload => json(payload).components.flatMap(row => row.components || []).map(c => c.custom_id);

beforeEach(() => {
  openMemoryDb();
  mockClient.sent.length = 0;
  settings.setChannel('leave-requests', IDS.channel);
  settings.setChannel('staff-logs', IDS.channel);
  settings.setChannel('moderators-logs', IDS.channel);
});

test('الاحتساب افتراضياً تقويمي، ومع أيام الراحة يستثنيها ويرفض الفترة الفارغة', () => {
  seedStaff();
  assert.equal(leaves.countedDays(D(1), D(3)), 3);
  settings.setPolicy('leaveWorkdayCounting', true);
  settings.setPolicy('leaveWeeklyOff', [5, 6]); // الجمعة والسبت
  const friday = (() => { let day = D(1); while (new Date(`${day}T00:00:00Z`).getUTCDay() !== 5) day = addDays(day, 1); return day; })();
  const saturday = addDays(friday, 1);
  const sunday = addDays(friday, 2);
  assert.equal(leaves.spanDays(friday, sunday), 3);
  assert.equal(leaves.countedDays(friday, sunday), 1, 'الجمعة والسبت لا تُحتسب');
  assert.deepEqual(leaves.skippedOffDays(friday, sunday), [friday, saturday]);
  assert.match(leaves.offDaysLabel(leaves.skippedOffDays(friday, sunday)), /الجمعة، السبت/);
  const empty = leaves.validate({ userId: IDS.me, leaveType: 'normal', start: friday, end: saturday });
  assert.equal(empty.ok, false);
  assert.equal(empty.code, 'no_workdays');
  const ok = leaves.validate({ userId: IDS.me, leaveType: 'normal', start: sunday, end: addDays(sunday, 2) });
  assert.equal(ok.ok, true);
  assert.equal(ok.durationDays, 3);
});

test('سقف 90 يوماً والرصيد السنوي يُحسبان على الأيام المحتسبة وتظهر القيم في الرصيد', () => {
  seedStaff();
  seedLeave({ userId: IDS.me, type: 'normal', start: D(-40), end: D(-36) }); // 5 أيام معتمدة
  const allow = leaves.allowance(IDS.me);
  assert.equal(allow.types.normal.used90, 5);
  assert.equal(allow.types.normal.remaining90, 25);
  assert.equal(allow.types.normal.pending90, 0);
  assert.equal(allow.totalUsed90, 5);
  const over = leaves.validate({ userId: IDS.me, leaveType: 'normal', start: D(10), end: D(45) });
  assert.equal(over.ok, false);
  assert.equal(over.code, 'type_cap', 'الحد لكل طلب يمنع 36 يوماً');
  settings.setPolicy('leaveAnnualDays', 6);
  const annual = leaves.validate({ userId: IDS.me, leaveType: 'normal', start: D(10), end: D(13) });
  assert.equal(annual.ok, false);
  assert.equal(annual.code, 'annual_cap');
  assert(leaves.allowance(IDS.me).annual.cap === 6);
  assert.equal(leaves.allowance(IDS.me).annual.used, 5);
  assert.equal(leaves.allowance(IDS.me).annual.remaining, 1);
  settings.setPolicy('leaveAnnualDays', 0);
  assert.equal(leaves.validate({ userId: IDS.me, leaveType: 'normal', start: D(10), end: D(13) }).ok, true);
});

test('بطاقة ما قبل الإرسال تجمع المدة والتغطية وأثر الفريق دون كتابة أي طلب', () => {
  seedStaff(IDS.me, 'support');
  seedStaff(IDS.peer, 'support');
  seedLeave({ userId: IDS.peer, start: D(5), end: D(9) });
  const preview = leaves.previewRequest({ userId: IDS.me, leaveType: 'normal', start: D(6), end: D(8) });
  assert.equal(preview.ok, true);
  assert.equal(preview.counted, 3);
  assert.equal(preview.span, 3);
  assert.equal(preview.coverage.peak, 1);
  assert.equal(preview.impact.team, 'support');
  assert.equal(preview.impact.size, 2);
  assert.equal(preview.impact.after, 0, 'سيبقى عضو واحد ثم يصبح صفراً');
  assert.equal(preview.impact.below, true);
  assert(preview.warnings.some(w => w.includes('تغطية')));
  assert.equal(preview.allowance.types.normal.used90, 0);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests WHERE user_id = ?').get(IDS.me).c, 0, 'البطاقة لا تنشئ طلباً');
  const bad = leaves.previewRequest({ userId: IDS.me, leaveType: 'normal', start: D(1), end: D(60) });
  assert.equal(bad.ok, false);
  assert.equal(bad.error.code, 'type_cap');
});

test('طلب الإجازة يمر بمراجعة ثم إرسال، ولا يتكرر بالنقر مرتين', async () => {
  seedStaff(IDS.me, 'support');
  const open = interaction({ level: LEVELS.STAFF });
  open.options = { getString: () => 'normal' };
  await commands.get('request-leave').execute(open);
  assert(!open.modal, 'الشاشة الأولى بلا كتابة تواريخ');
  assert.match(json(open.payload).embeds[0].title, /اختر بنقرة/);
  const modalId = (await openCustomModal(open)).custom_id;
  assert.match(modalId, /^leave:modal:normal:form:[a-f0-9]{16}$/);
  const formToken = modalId.match(/:form:([a-f0-9]{16})$/)[1];
  const submit = interaction({ customId: modalId, texts: { reason: 'ظرف عائلي', start: D(4), end: D(6), attachment: '' } });
  await dispatch(submit);
  const preview = submit.payload;
  assert.match(json(preview).embeds[0].title, /راجع طلب إجازتك/);
  assert.match(json(preview).embeds[0].description, /لم يُرسل شيء بعد/);
  assert.ok(buttonIds(preview).some(id => id.startsWith('leave:draft-edit:')));
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0);
  const submitBtn = buttonIds(preview).find(id => id.startsWith('leave:draft-submit:'));
  const confirm = interaction({ customId: submitBtn });
  await dispatch(confirm);
  const rows = getDb().prepare('SELECT * FROM leave_requests').all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');
  assert.equal(rows[0].duration_days, 3);
  assert.equal(rows[0].message_id, '1', 'نُشرت بطاقة المراجعة في قناة الطلبات');
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'leave_requested'").get().c, 1);
  const again = interaction({ customId: submitBtn });
  await dispatch(again);
  assert.match(json(again.payload).embeds[0].description, /انتهت صلاحية هذه المسودة/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 1, 'لم يتكرر الطلب');
});

test('تعديل المسودة لا يفقد البيانات، ومسودة عضو آخر لا تُقرأ', async () => {
  seedStaff(IDS.me);
  seedStaff(IDS.peer);
  const open = interaction({ level: LEVELS.STAFF });
  open.options = { getString: () => 'sick' };
  await commands.get('request-leave').execute(open);
  const modalId = (await openCustomModal(open)).custom_id;
  const submit = interaction({ customId: modalId, texts: { reason: 'مرض', start: D(3), end: D(4) } });
  await dispatch(submit);
  const editId = buttonIds(submit.payload).find(id => id.startsWith('leave:draft-edit:'));
  const edit = interaction({ customId: editId });
  await dispatch(edit);
  const label = edit.modal.toJSON().components[0];
  assert.equal(label.component.value, 'مرض', 'السبب محفوظ في النموذج');
  assert.equal(label.component.custom_id, 'reason');
  const token = editId.split(':')[2];
  const intruder = interaction({ customId: `leave:draft-submit:${token}`, id: IDS.peer });
  await dispatch(intruder);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0);
  const cancelId = buttonIds(submit.payload).find(id => id.startsWith('leave:draft-cancel:'));
  const cancel = interaction({ customId: cancelId });
  await dispatch(cancel);
  assert.match(json(cancel.payload).embeds[0].title, /تم الإلغاء/);
  const after = interaction({ customId: `leave:draft-submit:${token}` });
  await dispatch(after);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM leave_requests').get().c, 0);
});

test('لوحة الإجازات الشخصية تعرض الرصيد والتغطية وأزرار الإجراءات', async () => {
  seedStaff(IDS.me);
  seedLeave({ userId: IDS.me, type: 'normal', start: D(-10), end: D(-8) });
  seedLeave({ userId: IDS.me, type: 'sick', start: D(6), end: D(7) });
  const i = interaction();
  i.options = { getInteger: () => null };
  await commands.get('my-leaves').execute(i);
  const payload = json(i.payload);
  assert.equal(payload.embeds[0].title, '🏖️ إجازاتي');
  assert.match(field(payload, 'الرصيد').value, /متبقٍ/);
  assert.match(field(payload, 'حالتك اليوم').value, /متاح اليوم/);
  assert.match(field(payload, 'إجازتك القادمة').value, /تبدأ خلال/);
  assert.ok(buttonIds(payload).includes('leave:newrequest'));
  assert.ok(buttonIds(payload).includes('leave:balance'));
  const balance = interaction();
  balance.options = { getUser: () => null };
  await commands.get('leave-balance').execute(balance);
  assert.match(json(balance.payload).embeds[0].title, /رصيد الإجازات/);
  const other = interaction({ level: LEVELS.STAFF });
  other.options = { getUser: () => ({ id: IDS.peer }) };
  await commands.get('leave-balance').execute(other);
  assert.match(json(other.payload).embeds[0].description, /مراجعين/);
});

test('طالب إجازة معلّق يحصل على زر السحب بدل رفض صامت', async () => {
  seedStaff(IDS.me);
  const pending = seedLeave({ userId: IDS.me, status: 'pending', start: D(3), end: D(4) });
  const i = interaction();
  i.options = { getString: () => 'normal' };
  await commands.get('request-leave').execute(i);
  assert.equal(i.modal, undefined);
  assert.equal(buttonIds(i.payload)[0], `leave:mine:${pending.id}`);
  const row = json(i.payload).components[0].components;
  assert.ok(row.some(c => c.custom_id === `leave:confirmcancel:${pending.id}`));
});

test('المراجع يرى التغطية وسجل صاحب الطلب ويستطيع اقتراح تواريخ ثم يتابع القرار', async () => {
  seedStaff(IDS.me, 'support');
  seedStaff(IDS.peer, 'support');
  seedStaff(IDS.boss, 'support', 'Boss');
  const request = seedLeave({ userId: IDS.peer, status: 'pending', start: D(8), end: D(10) });
  const i = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss });
  await resolveComponent('leave:details').handler(i, [String(request.id)]);
  const card = json(i.payload);
  assert.match(card.embeds[0].fields.map(f => f.name).join(' '), /التغطية العامة/);
  assert.match(card.embeds[0].fields.map(f => f.name).join(' '), /سجل صاحب الطلب/);
  assert.ok(buttonIds(card).includes(`leave:suggest:${request.id}`));

  const modalInvite = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss });
  await resolveComponent('leave:suggest').handler(modalInvite, [String(request.id)]);
  assert.equal(modalInvite.modal.toJSON().components[0].component.value, request.start_date);
  const suggested = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss, texts: { start: D(12), end: D(14), note: 'الفريق ناقص في تواريخك' } });
  await resolveComponent('leave:suggestmodal').handler(suggested, [String(request.id)]);
  const updated = leaves.get(request.id);
  assert.equal(updated.suggested_start, D(12));
  assert.equal(updated.suggested_by, IDS.boss);
  assert.equal(mockClient.sent.length, 1, 'وصل الاقتراح كرسالة خاصة');
  assert.match(json(mockClient.sent[0]).embeds[0].title, /اقترحت الإدارة/);

  const accept = interaction({ id: IDS.peer, level: LEVELS.STAFF });
  await resolveComponent('leave:acceptsuggest').handler(accept, [String(request.id)]);
  const finalRow = leaves.get(request.id);
  assert.equal(finalRow.start_date, D(12));
  assert.equal(finalRow.end_date, D(14));
  assert.equal(finalRow.suggested_start, null);
  assert.equal(finalRow.status, 'pending', 'يبقى معلقاً حتى قرار المراجع');
  const outsider = interaction({ id: '999999999999999999', level: LEVELS.STAFF });
  await resolveComponent('leave:declinesuggest').handler(outsider, [String(request.id)]);
  assert.match(json(outsider.payload).embeds[0].description, /الطلب غير موجود/);
});

test('فرض تغطية الفريق يمنع الاعتماد، والتحذير وحده لا يمنع', async () => {
  seedStaff(IDS.me, 'support');
  seedStaff(IDS.peer, 'support');
  const request = seedLeave({ userId: IDS.me, status: 'pending', start: D(20), end: D(21) });
  seedLeave({ userId: IDS.peer, status: 'approved', start: D(20), end: D(21) });
  settings.setPolicy('leaveTeamCover', 1);
  const approver = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss });
  await resolveComponent('leave:approve').handler(approver, [String(request.id)]);
  assert.equal(leaves.get(request.id).status, 'approved', 'التحذير لا يمنع الاعتماد افتراضياً');
  const second = seedLeave({ userId: IDS.peer, status: 'pending', start: D(25), end: D(26) });
  settings.setPolicy('leaveEnforceTeamCover', true);
  settings.setPolicy('leaveTeamCover', 3);
  const blocked = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss });
  await resolveComponent('leave:approve').handler(blocked, [String(second.id)]);
  assert.match(json(blocked.payload).embeds[0].description, /تغطية/);
  assert.equal(leaves.get(second.id).status, 'pending');
  const preview = leaves.previewRequest({ userId: IDS.peer, leaveType: 'normal', start: D(30), end: D(31) });
  assert(preview.warnings.some(w => w.includes('الحد الأدنى')) || preview.warnings.length > 0);
});

test('لوحة الإدارة تُصفّي وتتنقّل وتفتح بطاقة الطلب', async () => {
  seedStaff(IDS.boss, 'support', 'Boss');
  seedStaff(IDS.peer);
  for (let n = 0; n < 12; n++) seedLeave({ userId: IDS.peer, status: n % 2 ? 'pending' : 'approved', start: D(10 + n), end: D(11 + n) });
  const i = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss, selects: { status: 'all', type: 'all' } });
  i.options = { getString: () => null };
  await commands.get('leave-dashboard').execute(i);
  const page1 = json(i.payload);
  assert.match(page1.embeds[0].description, /معلّقة/);
  assert.equal(page1.embeds[0].footer.text.includes('صفحة 1/2'), true, 'صفحتان لـ 12 طلباً');
  const navIds = json(i.payload).components.flatMap(r => r.components).map(c => c.custom_id).filter(id => id.startsWith('leave:dashpage:'));
  assert(navIds.some(id => id.includes(':2:')), `أزرار الصفحات موجودة: ${navIds.join(', ')}`);
  const next = navIds.find(id => id.includes(':2:'));
  const paged = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss, customId: next, selects: { status: 'all', type: 'all' } });
  await resolveComponent(next).handler(paged, resolveComponent(next).args);
  assert.match(json(paged.payload).embeds[0].footer.text, /صفحة 2\/2/);
  const filtered = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss, values: ['pending'], selects: { status: 'all', type: 'normal' } });
  await resolveComponent('leave:dashstatus').handler(filtered, ['normal', '1']);
  assert.match(json(filtered.payload).embeds[0].title, /معلّق/);
  const openId = json(filtered.payload).components.flatMap(r => r.components).find(c => c.custom_id === 'leave:reviewopen');
  assert(openId, 'قائمة فتح الطلبات موجودة');
  const requestId = openId.options[0].value;
  const opened = interaction({ level: LEVELS.MANAGEMENT, id: IDS.boss, values: [requestId] });
  await resolveComponent('leave:reviewopen').handler(opened, []);
  assert.match(json(opened.payload).embeds[0].title, new RegExp(`#${requestId}`));
  const denied = interaction({ level: LEVELS.STAFF, id: IDS.peer, values: [requestId] });
  await resolveComponent('leave:reviewopen').handler(denied, []);
  assert.match(json(denied.payload).embeds[0].description, /مراجعين/);
});

test('التقويم يتنقّل بين الفترات ويعرض أيام الراحة وإجازة صاحبه', async () => {
  seedStaff(IDS.me);
  seedLeave({ userId: IDS.me, status: 'approved', start: D(2), end: D(3) });
  const i = interaction();
  i.options = { getString: () => null, getInteger: () => null };
  await commands.get('leave-calendar').execute(i);
  const payload = json(i.payload);
  assert.match(payload.embeds[0].title, /تقويم الإجازات/);
  assert.match(payload.embeds[0].description, /⭐/);
  const navIds = buttonIds(payload);
  assert(navIds.some(id => id.startsWith('leave:cal:')));
  const next = interaction({ customId: navIds.find(id => id.startsWith('leave:cal:')) });
  await resolveComponent('leave:cal').handler(next, resolveComponent(navIds.find(id => id.startsWith('leave:cal:'))).args);
  assert.match(json(next.payload).embeds[0].title, /تقويم الإجازات/);
  const tooLong = interaction();
  await resolveComponent('leave:cal').handler(tooLong, [today(), '999']);
  assert.match(json(tooLong.payload).embeds[0].title, /تقويم الإجازات/);
});

test('تصعيد الطلب المعلّق يُرسل مرة واحدة ويحمل أزرار القرار', async () => {
  seedStaff(IDS.peer);
  seedLeave({ userId: IDS.peer, status: 'pending', start: D(2), end: D(3), created: null });
  getDb().prepare("UPDATE leave_requests SET created_at = datetime('now', '-30 hours')").run();
  const sent = [];
  const client = { channels: { fetch: async () => ({ send: async payload => { sent.push(payload); return { id: '1' }; } }) }, users: { fetch: async () => ({ send: async () => {} }) } };
  await scheduler.processLeaves(client);
  const escalations = sent.filter(p => json(p).embeds?.[0]?.title?.includes('بانتظار القرار'));
  assert.equal(escalations.length, 1);
  assert.ok(json(escalations[0]).components[0].components.some(c => c.custom_id.startsWith('leave:approve:')));
  await scheduler.processLeaves(client);
  assert.equal(sent.filter(p => json(p).embeds?.[0]?.title?.includes('بانتظار القرار')).length, 1, 'لا يتكرر التصعيد');
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'leave_escalated'").get().c, 1);
});

test('قواعد الإجازات المتقدمة تُحفظ من /setup وتظهر في سياسة الإجازات', async () => {
  const i = interaction({ level: LEVELS.BOSS, admin: true, selects: { weeklyOff: ['5', '6'], enforceTeamCover: ['yes'] }, texts: { annualDays: '٣٠', teamCover: '2', escalateHours: '48' } });
  i.message = { edit: async () => true };
  await resolveComponent('setup:policies-advanced-modal').handler(i, []);
  const policy = settings.leavePolicy();
  assert.equal(policy.annualDays, 30, 'تُقبل الأرقام العربية');
  assert.equal(policy.teamCover, 2);
  assert.equal(policy.pendingEscalateHours, 48);
  assert.deepEqual(policy.weeklyOffDays, [5, 6]);
  assert.equal(policy.workdayCounting, true);
  assert.equal(policy.enforceTeamCover, true);
  const bad = interaction({ level: LEVELS.BOSS, admin: true, selects: { weeklyOff: [], enforceTeamCover: ['no'] }, texts: { annualDays: 'kt', teamCover: '2', escalateHours: '48' } });
  await resolveComponent('setup:policies-advanced-modal').handler(bad, []);
  assert.match(json(bad.payload).embeds[0].description, /رقماً صحيحاً/);
  assert.equal(settings.leavePolicy().annualDays, 30, 'القيمة القديمة لم تتغير');
  const advanced = resolveComponent('setup:policies-advanced').entry;
  assert.equal(advanced.adminOnly, true);
  const shown = interaction({ level: LEVELS.BOSS, admin: true });
  await resolveComponent('setup:policies-advanced').handler(shown, []);
  assert(shown.modal.toJSON().components.length <= 5, 'النموذج داخل حد Discord');
  assert.equal(shown.modal.toJSON().components.filter(c => c.type === ComponentType.Label).length, 5);
});
