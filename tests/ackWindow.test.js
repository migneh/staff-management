'use strict';
/**
 * حارس نافذة الثلاث ثوانٍ: لا استدعاء شبكي قبل الإقرار.
 *
 * المشكلة التي يحرسها هذا الملف: أزرار ونماذج «مُعدِّلة» كانت تنفّذ استدعاءات
 * ديسكورد متسلسلة (members.fetch ثم roles.add ثم channels.fetch ثم DM) قبل أن
 * تُجيب بـ i.update. توكن التفاعل يعيش ثلاث ثوانٍ فقط؛ تجاوزها يعني أن يرى
 * المستخدم «This interaction failed» — والكتابة على القرص قد تكون landed سلفاً.
 * أسوأ ما في خطأ الموافقة: لا يستطيع المستخدم تمييز «لم يحدث» من «حدث ولا أعرف».
 *
 * شكل الفحص مأخوذ من governance.js:32-38 داخل المشروع نفسه — الفحوص المحلية
 * (SQLite) تبقى قبل التأجيل، والتأجيل يأتي قبل أول استدعاء شبكي، وكل جواب
 * بعد التأجيل يُعدّل الرسالة المؤجلة بـ editReply لا update ولا reply.
 *
 * ما يُفحص لكل معالج، على المسار الناجح:
 *   1. أول نداء على التفاعل هو deferUpdate (زر/قائمة) أو deferReply (modal).
 *   2. الإقرار يقع قبل أول استدعاء شبكي مُؤجَّل (ترتيب مسجَّل لا مُخمَّن).
 *   3. لا reply ولا update بعد الإقرار — فلا «Already acknowledged» ولا
 *      إقرار مزدوج — ويخرج المعالج بنهاية واحدة editReply.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const leavesService = require('../src/services/leaves');
const promo = require('../src/services/promotions');
const { resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');
const { today, addDays } = require('../src/utils');

const IDS = {
  approver: '1005171993940852796',
  target: '1490787800168005713',
  peer: '223456789012345678',
  second: '323456789012345678',
  channel: '423456789012345678',
  guild: '523456789012345678',
};
const D = offset => addDays(today(), offset);
/** كل استدعاء شبكة يُحلّ على نبضة متأخرة، فأي إقرار بعده كان متأخراً فعلاً. */
const NET_DELAY_MS = 3;
const sleep = () => new Promise(resolve => setTimeout(resolve, NET_DELAY_MS));

// ===== جهاز القياس: سجل واحد للنداءات الشبكية ونداءات التفاعل =====

function probe() {
  const calls = [];
  const note = name => { calls.push(name); };
  const tick = async name => { note(name); await sleep(); };
  return { calls, note, tick };
}

/** دور صلاحيات فيها رتبة in vacation وSupport — كي تمسّ roles.add/remove فعلاً. */
function roleCache() {
  const list = [{ id: 'r-vacation', name: 'in vacation' }, { id: 'r-support', name: 'Support' }];
  list.get = id => list.find(r => r.id === id) || null;
  return list;
}

function fakeMember(p, id) {
  const member = {
    id,
    displayName: `member-${id}`,
    guild: { id: IDS.guild, roles: { cache: roleCache() } },
    roles: {
      // لا نضع رتبة in vacation هنا عمداً: addVacationRole تكتفي بـ roles.add
      // إن لم تكن الرتبة موجودة، ووجودها مُسبقاً يجعلها تُرجع already بلا شبكة
      // فيمرّ الاختبار دون أن يلمس ترتيب الإقرار أصلاً.
      cache: new Map([['r-support', { id: 'r-support' }]]),
      add: async (role) => { await p.tick('net:roles.add'); return member; },
      remove: async (role) => { await p.tick('net:roles.remove'); return member; },
    },
  };
  return member;
}

function fakeClient(p) {
  const channel = {
    id: IDS.channel,
    send: async payload => { await p.tick('net:channel.send'); return { id: 'm-1', payload }; },
    messages: {
      fetch: async id => {
        await p.tick('net:messages.fetch');
        return { id, edit: async payload => { await p.tick('net:message.edit'); return payload; } };
      },
    },
  };
  return {
    channels: { fetch: async id => { await p.tick('net:channels.fetch'); return channel; } },
    users: { fetch: async id => ({ id, send: async payload => { await p.tick('net:user.send'); return payload; } }) },
  };
}

/**
 * تفاعل Staff Management كما يتصرّف discord.js فعلاً بعد الإقرار:
 * deferUpdate/deferReply يرفعان deferred و replied معاً، فأي reply بعدها يرمي
 * «Already acknowledged» — وهذا بالضبط ما نريد كشفه.
 */
function fakeInteraction(p, { id = IDS.approver, level = LEVELS.MANAGEMENT, team = 'support',
  rank = 'Support', status = 'active', texts = {}, modal = false, customId = '', values = [] } = {}) {
  const member = fakeMember(p, id);
  const i = {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel,
    client: fakeClient(p), staffLevel: level, staffInfo: { team, level },
    member: { id, displayName: 'boss', guild: { ownerId: 'someone-else' }, roles: { cache: new Map() }, permissions: { has: () => false } },
    guild: {
      members: {
        // يعيد عضواً للمعرّف المطلوب فعلاً: fetch صاحب الإجازة/الاستقالة هو
        // الهدف لا صاحب التفاعل، ولو أرجعنا عضواً واحداً لابتلعت كل مسارات
        // addVacationRole/removeAllStaffRoles قيمة null فيمرّ الاختبار بلا شبكة.
        fetch: async uid => { await p.tick('net:members.fetch'); return fakeMember(p, uid); },
      },
    },
    values, deferred: false, replied: false,
    fields: {
      getTextInputValue: key => texts[key] ?? '',
      getField: key => ({ custom_id: key, type: 4, value: texts[key] ?? '', values: [] }),
    },
    isModalSubmit: () => modal,
    async deferUpdate() { p.note('deferUpdate'); i.deferred = true; i.replied = true; },
    async deferReply(options) { p.note('deferReply'); i.deferOptions = options || null; i.deferred = true; i.replied = true; },
    async reply(payload) {
      p.note('reply');
      assert(!i.replied, 'reply بعد الإقرار ⇒ Already acknowledged');
      i.replied = true; i.payload = payload; return payload;
    },
    async update(payload) {
      p.note('update');
      assert(!i.replied, 'update بعد الإقرار ⇒ Already acknowledged');
      i.replied = true; i.payload = payload; return payload;
    },
    async editReply(payload) {
      p.note('editReply');
      assert(i.replied, 'editReply بلا تأجيل ⇒ لا يوجد ردّ مؤجَّل لتعديله');
      i.payload = payload; return payload;
    },
    async followUp(payload) { p.note('followUp'); i.followed = (i.followed || []).concat([payload]); return payload; },
    async showModal(m) { p.note('showModal'); i.modal = m; return m; },
  };
  return i;
}

/** العقد الذي يجب أن يفي به كل معالج مُصلَح على المسار الناجح. */
function assertAcknowledgedBeforeNetwork(label, p, expected) {
  const { calls } = p;
  const seq = calls.join(' → ');
  assert.equal(calls[0], expected, `${label}: أول نداء ليس ${expected}\n  ${seq}`);
  const ackAt = 0;
  const firstNetAt = calls.findIndex(c => c.startsWith('net:'));
  assert.ok(firstNetAt === -1 || ackAt < firstNetAt, `${label}: الإقرار بعد أول استدعاء شبكي\n  ${seq}`);
  assert.ok(calls.some(c => c.startsWith('net:')), `${label}: الاختبار لم يمسّ شبكة إطلاقاً — لا يثبت شيئاً\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'reply').length, 0, `${label}: reply بعد الإقرار\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'update').length, 0, `${label}: update بعد deferUpdate (ينتج Already acknowledged)\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'deferUpdate' || c === 'deferReply').length, 1, `${label}: أكثر من إقرار واحد\n  ${seq}`);
  const finishes = calls.filter(c => c === 'editReply').length;
  assert.equal(finishes, 1, `${label}: يجب أن ينتهي المعالج بـ editReply واحد بالضبط (وُجد ${finishes})\n  ${seq}`);
  return seq;
}

// ===== تهيئة قاعدة البيانات =====

function seedStaff(id, team = 'support', rank = 'Support', status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, ?, ?, ?, '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, rank = excluded.rank, status = excluded.status`)
    .run(id, id, team, rank, status);
}

function seedLeave({ userId = IDS.target, status = 'pending', start = D(10), end = D(12) } = {}) {
  const res = getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, status)
    VALUES (?, 'normal', 'سبب', ?, ?, ?, ?)`).run(userId, start, end, leavesService.spanDays(start, end), status);
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
}

function seedResignation({ userId = IDS.target, status = 'pending', lastDay = D(20) } = {}) {
  const res = getDb().prepare(`INSERT INTO resignations (user_id, reason, last_day, reason_category, team, rank)
    VALUES (?, 'سبب', ?, 'other', 'support', 'Support')`).run(userId, lastDay);
  return getDb().prepare('SELECT * FROM resignations WHERE id = ?').get(res.lastInsertRowid);
}

/** موظف مؤهَّل للترقية من Helper إلى Support (نصاب موافقة واحد). */
function seedPromotion(userId = IDS.target) {
  seedStaff(userId, 'support', 'Helper');
  const s = getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(userId);
  const ev = promo.evaluate(s);
  const id = promo.createRequest(s, ev, 'سبب');
  return promo.getRequest(id);
}

beforeEach(() => {
  openMemoryDb();
  settings.set('test', true);
  for (const key of ['leave-requests', 'staff-logs', 'manager-review', 'staff-wins', 'mod-logs', 'ticket-logs', 'resignation-requests']) {
    settings.setChannel(key, IDS.channel);
  }
  settings.setRole('system', 'in vacation', 'r-vacation');
  settings.setRole('support', 'Support', 'r-support');
  seedStaff(IDS.approver, 'support', 'Support');
  seedStaff(IDS.target, 'support', 'Support');
});

const run = (id, i, args = []) => resolveComponent(id).handler(i, args);

// ===== leaves.js =====

test('leave:approve — الإقرار قبل members.fetch وroles.add', async () => {
  // بداية اليوم تجعل فرع تفعيل الرتبة يعمل تحت إعدادَي التوقيت كليهما
  // (at_start و at_approval)، وإلا لتجاوز الاختبار الشبكةَ ولم يثبت شيئاً عن
  // ترتيب الإقرار أمام roles.add.
  const request = seedLeave({ start: D(0), end: D(2) });
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT });
  await run('leave:approve', i, [String(request.id)]);
  const seq = assertAcknowledgedBeforeNetwork('leave:approve', p, 'deferUpdate');
  assert.match(seq, /net:members\.fetch/);
  assert.match(seq, /net:roles\.add/, 'لم تُمسّ رتبة الإجازة — لا يثبت ترتيب الشبكة');
  assert.equal(leavesService.get(request.id).status, 'approved');
});

test('leave:rejectmodal — modal فيؤجّل بـ deferReply قبل تعديل رسالة الطلب', async () => {
  const request = seedLeave();
  getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', request.id);
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true, texts: { reason: 'تعارض' } });
  await run('leave:rejectmodal', i, [String(request.id)]);
  const seq = assertAcknowledgedBeforeNetwork('leave:rejectmodal', p, 'deferReply');
  assert.match(seq, /net:messages\.fetch/);
  assert.equal(leavesService.get(request.id).status, 'rejected');
});

test('leave:cancelquick — الإقرار قبل تعديل رسالة الطلب ثم الخاص', async () => {
  const request = seedLeave();
  getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', request.id);
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT });
  await run('leave:cancelquick', i, [String(request.id)]);
  assertAcknowledgedBeforeNetwork('leave:cancelquick', p, 'deferUpdate');
  assert.equal(leavesService.get(request.id).status, 'cancelled');
});

test('leave:confirmcancel — الإقرار قبل members.fetch ومزامنة الرتبة', async () => {
  const request = seedLeave({ userId: IDS.approver, start: D(-1), end: D(1) });
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF });
  await run('leave:confirmcancel', i, [String(request.id)]);
  const seq = assertAcknowledgedBeforeNetwork('leave:confirmcancel', p, 'deferUpdate');
  assert.match(seq, /net:members\.fetch/);
  assert.equal(leavesService.get(request.id).status, 'cancelled');
});

// ===== resignations.js =====

test('resign:rejectmodal — decide يؤجّل بـ deferReply قبل تعديل الرسالة ثم الخاص', async () => {
  const request = seedResignation();
  getDb().prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run('m-1', request.id);
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true, texts: { reason: 'مدة إشعار غير مكتملة' } });
  await run('resign:rejectmodal', i, [String(request.id)]);
  const seq = assertAcknowledgedBeforeNetwork('resign:rejectmodal', p, 'deferReply');
  assert.match(seq, /net:messages\.fetch/);
  assert.equal(getDb().prepare('SELECT status FROM resignations WHERE id = ?').get(request.id).status, 'rejected');
});

/**
 * كان هنا اختبار توثيقي للعطل: `staffService.recordRankChange` غير مُصدَّر من
 * src/services/staff.js، فيرمي resignations.js:99 استثناءً بعد أن كتب
 * setStatus('resigned') — قبول الاستقالة ينهار *بعد* الكتابة.
 *
 * أُصلح: أُعيد التصدير باسم appendRankChange (وهو الاسم الموجود فعلاً) وحُوِّلت
 * مواضع الاستدعاء الأربعة إلى توقيع الكائن. حارس إعادة_delay موجود في
 * tests/staffServiceSurface.test.js، وغياب هذا الاختبار الآن مقصود: لا نُبقي
 * اختباراً يصف عطلاً غير موجود.
 */
test('resign:acceptmodal — القبول يكتب سطر التاريخ بلا استثناء', async () => {
  const request = seedResignation();
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.BOSS, modal: true, texts: { reason: 'وداع' } });
  await run('resign:acceptmodal', i, [String(request.id)]);
  assert.equal(p.calls[0], 'deferReply', `التأجيل لم يسبق التنفيذ: ${p.calls.join(' → ')}`);
  assert.equal(getDb().prepare('SELECT status FROM resignations WHERE id = ?').get(request.id).status, 'accepted');
  const hist = getDb().prepare('SELECT * FROM staff_rank_history WHERE user_id = ? AND change_type = ?')
    .get(request.user_id, 'remove');
  assert.ok(hist, 'لم يُكتب سطر إزالة الرتبة — كانت هذه هي الكتابة المفقودة أصلاً');
});

test('resign:confirmwithdraw — الإقرار قبل تعديل رسالة الطلب', async () => {
  const request = seedResignation({ userId: IDS.approver });
  getDb().prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run('m-1', request.id);
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF });
  await run('resign:confirmwithdraw', i, [String(request.id)]);
  assertAcknowledgedBeforeNetwork('resign:confirmwithdraw', p, 'deferUpdate');
  assert.equal(getDb().prepare('SELECT status FROM resignations WHERE id = ?').get(request.id).status, 'withdrawn');
});

test('resign:interviewmodal — modal فيؤجّل قبل تعديل الرسالة ثم الخاص', async () => {
  const request = seedResignation();
  getDb().prepare('UPDATE resignations SET message_id = ? WHERE id = ?').run('m-1', request.id);
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true, texts: { exit_interview: 'ملاحظة' } });
  await run('resign:interviewmodal', i, [String(request.id)]);
  assertAcknowledgedBeforeNetwork('resign:interviewmodal', p, 'deferReply');
  assert.equal(getDb().prepare('SELECT exit_interview FROM resignations WHERE id = ?').get(request.id).exit_interview, 'ملاحظة');
});

// ===== promotions.js =====

test('promo:approve — الإقرار قبل members.fetch وتطبيق الرتب', async () => {
  const request = seedPromotion();
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.SUPERVISOR });
  await run('promo:approve', i, [String(request.id)]);
  const seq = assertAcknowledgedBeforeNetwork('promo:approve', p, 'deferUpdate');
  assert.match(seq, /net:members\.fetch/);
  assert.equal(promo.getRequest(request.id).status, 'approved');
});

test('promo:rejectmodal — modal فيؤجّل قبل تعديل البطاقة ثم الخاص', async () => {
  const request = seedPromotion();
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.SUPERVISOR, modal: true, texts: { reason: 'لم تكتمل المؤشرات' } });
  await run('promo:rejectmodal', i, [String(request.id)]);
  assertAcknowledgedBeforeNetwork('promo:rejectmodal', p, 'deferReply');
  assert.equal(promo.getRequest(request.id).status, 'rejected');
});

// ===== punishments.js =====

async function openWarningDraft(p, i) {
  const modal = fakeInteraction(p, { ...i, modal: true, texts: { target: IDS.target, preset: 'تجاهل الأنظمة', reason: '' } });
  await run('punish:warning:verbal', modal, ['verbal']);
  const token = modal.payload.components[0].toJSON().components[0].custom_id.split(':').pop();
  p.calls.length = 0; // نقيس المسار المُصلَح وحده، لا فتح المسودة
  return token;
}

test('punish:warningok — الإقرار قبل النشر في قناة السجلات', async () => {
  const p = probe();
  const setup = probe();
  const token = await openWarningDraft(setup, { id: IDS.approver, level: LEVELS.BOSS, team: 'moderation', rank: 'Admin' });
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.BOSS, team: 'moderation', rank: 'Admin' });
  await run('punish:warningok', i, [token]);
  const seq = assertAcknowledgedBeforeNetwork('punish:warningok', p, 'deferUpdate');
  assert.match(seq, /net:channel\.send/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM warnings').get().c, 1);
});

test('punish:notekok — الإقرار قبل النشر في قناة السجلات', async () => {
  const p = probe();
  const setup = probe();
  const modal = fakeInteraction(setup, { id: IDS.approver, level: LEVELS.BOSS, team: 'moderation', rank: 'Admin',
    modal: true, texts: { target: IDS.target, content: 'تحسّن', secret: 'false' } });
  await run('punish:note:positive', modal, ['positive']);
  const token = modal.payload.components[0].toJSON().components[0].custom_id.split(':').pop();
  p.calls.length = 0;
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.BOSS, team: 'moderation', rank: 'Admin' });
  await run('punish:notekok', i, [token]);
  const seq = assertAcknowledgedBeforeNetwork('punish:notekok', p, 'deferUpdate');
  assert.match(seq, /net:channel\.send/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM staff_notes').get().c, 1);
});

// ===== logging.js =====

test('modaction:confirm — الإقرار قبل النشر في mod-logs ثم الخاص', async () => {
  const setup = probe();
  const modal = fakeInteraction(setup, { id: IDS.approver, level: LEVELS.SUPERVISOR, team: 'moderation', rank: 'Admin',
    modal: true, texts: { target: IDS.target, reason: 'سبب', duration: 'none' } });
  await run('modaction:log:warn', modal, ['warn']);
  const token = modal.payload.components[0].toJSON().components[0].custom_id.split(':').pop();

  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.SUPERVISOR, team: 'moderation', rank: 'Admin' });
  await run('modaction:confirm', i, [token]);
  const seq = assertAcknowledgedBeforeNetwork('modaction:confirm', p, 'deferUpdate');
  assert.match(seq, /net:channel\.send/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM mod_actions').get().c, 1);
});

test('ticket:log (modal) — saveTicket يؤجّل بـ deferReply قبل النشر', async () => {
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF, modal: true,
    texts: { ticket_id: 'ticket-77', owner: IDS.target, duration: '45' } });
  await run('ticket:log', i, []);
  const seq = assertAcknowledgedBeforeNetwork('ticket:log', p, 'deferReply');
  assert.match(seq, /net:channel\.send/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 1);
});

// ===== recognition.js =====

test('recognition:approve — الإقرار قبل النشر في staff-wins ثم الخاص', async () => {
  seedStaff(IDS.peer, 'support', 'Support');
  const res = getDb().prepare('INSERT INTO recognition_nominations (nominator_id, target_id, reason, day) VALUES (?, ?, ?, ?)')
    .run(IDS.peer, IDS.target, 'إنجاز', require('../src/clock').today());
  const p = probe();
  const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT });
  await run('recognition:approve', i, [String(res.lastInsertRowid)]);
  const seq = assertAcknowledgedBeforeNetwork('recognition:approve', p, 'deferUpdate');
  assert.match(seq, /net:channel\.send/);
  assert.equal(getDb().prepare('SELECT status FROM recognition_nominations WHERE id = ?').get(res.lastInsertRowid).status, 'approved');
});
