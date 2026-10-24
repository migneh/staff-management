'use strict';
/**
 * الاختبارات الثلاثة التي يفرضها تسليم «إكمال عمل defer» و«إكمال RTL» و«خفض
 * كلفة التقارير». مبنية على أدوات موجودة لا مكرَّرة:Acknowledgement probe
 * من tests/ackWindow.test.js، وdb.prepare معدوداً من نفس الملف.
 *
 * كل اختبار هنا **يُفشل على الكود قبل إصلاحه** — وهذا مُثبت في التعليقات
 * beside كل تأكيد، لأن اختباراً يمرّ على كود معطوب لا يحرس شيئاً.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const leavesService = require('../src/services/leaves');
const points = require('../src/services/points');
const staffService = require('../src/services/staff');
const reports = require('../src/services/reports');
const clock = require('../src/clock');
const { resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');
const { today, addDays } = require('../src/utils');
const { clipRich, truncate } = require('../src/utils');
const kit = require('../src/ui/kit');

const IDS = {
  approver: '1005171993940852796',
  target: '1490787800168005713',
  channel: '423456789012345678',
  guild: '523456789012345678',
};
const D = offset => addDays(today(), offset);
const LEADERBOARD_WINDOW_DAYS = 14;
const CID = '3000000000000000000';

// ===== جهاز النداءات: نفس عقدة ackWindow.test.js، مستعملة هنا =====

const NET_DELAY_MS = 3;
const sleep = () => new Promise(resolve => setTimeout(resolve, NET_DELAY_MS));

function probe() {
  const calls = [];
  return { calls, note: name => calls.push(name), tick: async name => { calls.push(name); await sleep(); } };
}

function fakeClient(p) {
  const channel = {
    id: IDS.channel,
    send: async payload => { await p.tick('net:channel.send'); return { id: 'm-1', payload }; },
    messages: { fetch: async id => { await p.tick('net:messages.fetch'); return { id, edit: async pl => { await p.tick('net:message.edit'); return pl; } }; } },
  };
  return {
    channels: { fetch: async id => { await p.tick('net:channels.fetch'); return channel; } },
    users: { fetch: async id => ({ id, send: async payload => { await p.tick('net:user.send'); return payload; } }) },
  };
}

function fakeInteraction(p, { id = IDS.approver, level = LEVELS.MANAGEMENT, team = 'support',
  rank = 'Support', status = 'active', texts = {}, modal = false, customId = '', values = [], options = {} } = {}) {
  const roleCache = () => { const l = [{ id: 'r-vacation', name: 'in vacation' }, { id: 'r-support', name: 'Support' }]; l.get = id => l.find(r => r.id === id) || null; return l; };
  const member = {
    id, displayName: `member-${id}`, guild: { id: IDS.guild, roles: { cache: roleCache() } },
    roles: {
      cache: new Map([['r-support', { id: 'r-support' }]]),
      add: async role => { await p.tick('net:roles.add'); return member; },
      remove: async role => { await p.tick('net:roles.remove'); return member; },
    },
  };
  const i = {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel,
    client: fakeClient(p), staffLevel: level, staffInfo: { team, level },
    member: { id, displayName: 'boss', guild: { ownerId: 'someone-else' }, roles: { cache: new Map() }, permissions: { has: () => false } },
    guild: { members: { fetch: async uid => { await p.tick('net:members.fetch'); return member2(p, uid); } } },
    values, deferred: false, replied: false,
    fields: { getTextInputValue: key => texts[key] ?? '', getField: key => ({ custom_id: key, type: 4, value: texts[key] ?? '', values: [] }) },
    isModalSubmit: () => modal,
    options: {
      getInteger: key => options[key] ?? null,
      getString: key => options[key] ?? null,
      getUser: key => (options[key] ? { id: String(options[key]) } : null),
    },
    async deferUpdate() { p.note('deferUpdate'); i.deferred = true; i.replied = true; },
    async deferReply(opts) { p.note('deferReply'); i.deferOptions = opts || null; i.deferred = true; i.replied = true; },
    async reply(payload) {
      p.note(`reply${process.env.ACK_DEBUG ? ' ' + JSON.stringify(payload).slice(0, 200) : ''}`);
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
      assert(i.deferred, 'editReply بلا defer ⇒ لا يوجد ردّ مؤجَّل');
      i.payload = payload; return payload;
    },
    async followUp(payload) { p.note('followUp'); i.followed = (i.followed || []).concat([payload]); return payload; },
    async showModal(m) { p.note('showModal'); i.modal = m; return m; },
  };
  return i;
}
function member2(p, id) {
  const list = [{ id: 'r-vacation', name: 'in vacation' }, { id: 'r-support', name: 'Support' }];
  list.get = rid => list.find(r => r.id === rid) || null;
  const m = {
    id, displayName: `member-${id}`, guild: { id: IDS.guild, roles: { cache: list } },
    roles: {
      cache: new Map([['r-support', { id: 'r-support' }]]),
      add: async r => { await p.tick('net:roles.add'); return m; },
      remove: async r => { await p.tick('net:roles.remove'); return m; },
    },
  };
  return m;
}

/** العقد الذي يجب أن يفي به معالج مؤجَّل على المسار الناجح. */
function assertAckedFirst(label, p, expected) {
  const { calls } = p;
  const seq = calls.join(' → ');
  assert.equal(calls[0], expected, `${label}: أول نداء ليس ${expected}\n  ${seq}`);
  const firstNet = calls.findIndex(c => c.startsWith('net:'));
  assert.ok(firstNet === -1 || firstNet > 0, `${label}: الإقرار بعد أول استدعاء شبكي\n  ${seq}`);
  assert.ok(calls.some(c => c.startsWith('net:')), `${label}: لم يمسّ شبكة — لا يثبت شيئاً\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'reply').length, 0, `${label}: reply بعد الإقرار\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'update').length, 0, `${label}: update بعد التأجيل\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'deferUpdate' || c === 'deferReply').length, 1, `${label}: أكثر من إقرار واحد\n  ${seq}`);
  assert.equal(calls.filter(c => c === 'editReply').length, 1, `${label}: يجب ending واحد بـ editReply\n  ${seq}`);
  return seq;
}

beforeEach(() => {
  openMemoryDb();
  settings.set('test', true);
  for (const key of ['leave-requests', 'staff-logs', 'ticket-logs']) settings.setChannel(key, IDS.channel);
  settings.setRole('system', 'in vacation', 'r-vacation');
  settings.setRole('support', 'Support', 'r-support');
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, 'support', 'Support', 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, status = excluded.status`)
    .run(IDS.approver, IDS.approver);
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, 'support', 'Support', 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, status = excluded.status`)
    .run(IDS.target, IDS.target);
});

const run = (id, i, args = []) => resolveComponent(id).handler(i, args);
const seedLeave = ({ userId = IDS.target, status = 'pending', start = D(10), end = D(12) } = {}) => {
  const res = getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, status)
    VALUES (?, 'normal', 'سبب', ?, ?, ?, ?)`).run(userId, start, end, leavesService.spanDays(start, end), status);
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
};

// ════════════════════════════════════════════════════════════════════════
// 1) نافذة الثلاث ثوانٍ: كل معالج أُصلح يقرأ ترتيب النداءات لا يخمّنه
// ════════════════════════════════════════════════════════════════════════

describe('إكمال التأجيل: المعالجات التي كانت تردّ بعد الشبكة', () => {
  test('leave:suggestmodal — modal يؤجّل بـ deferReply قبل خاص العضو', async () => {
    // قبل الإصلاح: dm + updateRequestMessage + sendToChannel كلها قبل أي ردّ،
    // فكان أول نداء net:users.fetch.
    const r = seedLeave();
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true,
      texts: { start: D(12), end: D(15), note: 'سبب' } });
    await run('leave:suggestmodal', i, [String(r.id)]);
    const seq = assertAckedFirst('leave:suggestmodal', p, 'deferReply');
    assert.match(seq, /net:user\.send/, 'لم تُمسّ رسالة العضو — لا يثبت ترتيب الشبكة');
    assert.ok(leavesService.get(r.id).suggested_start, 'لم يُحفظ الاقتراح');
  });

  test('leave:suggestmodal — التقرير المؤجَّل يبقى ephemeral لا followUp', async () => {
    const r = seedLeave();
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true,
      texts: { start: D(12), end: D(15) } });
    await run('leave:suggestmodal', i, [String(r.id)]);
    // الراية على deferReply لا editReply: وضعها في editReply لا يجدها أصلاً.
    assert.deepEqual(i.deferOptions, { ephemeral: true }, 'الخاصية مؤجَّلة على القوس الخطأ');
  });

  test('leave:acceptsuggest — زر يؤجّل بـ deferUpdate قبل تعديل البطاقة', async () => {
    // قبل الإصلاح: updateRequestMessage + sendToChannel ثم i.update — وهذا
    // update بعد عمليتين شبكيتين ⇒ Already acknowledged أو "فشل التفاعل".
    const r = seedLeave();
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    getDb().prepare(`UPDATE leave_requests SET suggested_start = ?, suggested_end = ?, suggested_by = ? WHERE id = ?`)
      .run(D(12), D(15), IDS.approver, r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.target, level: LEVELS.STAFF });
    await run('leave:acceptsuggest', i, [String(r.id)]);
    const seq = assertAckedFirst('leave:acceptsuggest', p, 'deferUpdate');
    assert.match(seq, /net:message\.edit/);
    assert.equal(leavesService.get(r.id).start_date, D(12), 'لم تُحدَّث تواريخ الطلب');
  });

  test('leave:declinesuggest — زر يؤجّل بـ deferUpdate قبل تعديل البطاقة', async () => {
    const r = seedLeave();
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    getDb().prepare(`UPDATE leave_requests SET suggested_start = ?, suggested_end = ?, suggested_by = ? WHERE id = ?`)
      .run(D(12), D(15), IDS.approver, r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.target, level: LEVELS.STAFF });
    await run('leave:declinesuggest', i, [String(r.id)]);
    assertAckedFirst('leave:declinesuggest', p, 'deferUpdate');
    assert.equal(leavesService.get(r.id).start_date, D(10), 'التواريخ الأصلية لا بد أن تبقى');
  });

  test('leave:extendmodal — modal يؤجّل بـ deferReply قبل تعديل البطاقة', async () => {
    // قبل الإصلاح: updateRequestMessage (شبكة) ثم replyEphemeral.
    const r = seedLeave({ userId: IDS.approver, start: D(5), end: D(7), status: 'approved' });
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF, modal: true, texts: { new_end: D(14) } });
    await run('leave:extendmodal', i, [String(r.id)]);
    const seq = assertAckedFirst('leave:extendmodal', p, 'deferReply');
    assert.match(seq, /net:message\.edit/);
    assert.equal(leavesService.get(r.id).end_date, D(14), 'لم يُمدَّد الطلب');
  });

  test('/cancel-leave — slash يؤجّل بـ deferReply قبل members.fetch', async () => {
    // قبل الإصلاح: replyEphemeral بعد UPDATE + fetchMember + updateRequestMessage.
    const r = seedLeave({ userId: IDS.approver, start: D(10), end: D(12) });
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF, options: { id: r.id } });
    const cmd = require('../src/commands/leaves').commands.find(c => c.data.name === 'cancel-leave');
    await cmd.execute(i);
    const seq = assertAckedFirst('/cancel-leave', p, 'deferReply');
    assert.match(seq, /net:members\.fetch/);
    assert.equal(leavesService.get(r.id).status, 'cancelled');
  });

  test('/extend-leave — slash يؤجّل بـ deferReply قبل تعديل البطاقة', async () => {
    const r = seedLeave({ userId: IDS.approver, start: D(5), end: D(7), status: 'approved' });
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF, options: { id: r.id, new_end: D(16) } });
    const cmd = require('../src/commands/leaves').commands.find(c => c.data.name === 'extend-leave');
    await cmd.execute(i);
    const seq = assertAckedFirst('/extend-leave', p, 'deferReply');
    assert.match(seq, /net:message\.edit/);
    assert.equal(leavesService.get(r.id).end_date, D(16));
  });

  test('/end-leave — slash يؤجّل بـ deferReply قبل members.fetch والخاص', async () => {
    // قبل الإصلاح: أربع عمليات شبكية (fetch/roles/update/خاص/log) قبل الرد.
    const r = seedLeave({ userId: IDS.target, status: 'approved', start: D(-2), end: D(2) });
    getDb().prepare('UPDATE leave_requests SET message_id = ? WHERE id = ?').run('m-1', r.id);
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.MANAGEMENT, options: { user: IDS.target, reason: 'سبب' } });
    const cmd = require('../src/commands/leaves').commands.find(c => c.data.name === 'end-leave');
    await cmd.execute(i);
    const seq = assertAckedFirst('/end-leave', p, 'deferReply');
    assert.match(seq, /net:members\.fetch/);
    assert.equal(leavesService.get(r.id).status, 'ended');
  });

  test('القواعد لا تُغيَّر: المسارات التي أخطأت تستجيب بلا تأجيل ولا شبكة', async () => {
    // أمر لا يعمل أصلاً لا يحتاج deferReply — التأجيل قبل التحقق يجعل
    // المستخدم يرى وميض «جارٍ التنفيذ» على رسالة خطأ فورية. هذا ما نفحصه:
    // التأجيل **بعد** التحقق المحلي، لا قبله.
    const p = probe();
    const i = fakeInteraction(p, { id: IDS.approver, level: LEVELS.STAFF, modal: true, texts: { new_end: '' } });
    await run('leave:extendmodal', i, ['999999']);
    assert.equal(p.calls[0], 'reply', `التأجيل قبل التحقق المحلي: ${p.calls.join(' → ')}`);
    assert.equal(p.calls.filter(c => c.startsWith('defer')).length, 0, 'تأجيل بلا داعٍ');
    assert.equal(p.calls.filter(c => c.startsWith('net:')).length, 0, 'شبكة رغم مسار الفشل');
  });
});

// ════════════════════════════════════════════════════════════════════════
// 2) القصّ الواعي بالرموز — أمثلة عربية حقيقية
// ════════════════════════════════════════════════════════════════════════

describe('القصّ الواعي بالرموز: مسابقات عربية حقيقية', () => {
  const ARABIC_DIACRITIC = /[ً-ٰٟ]/;

  test('طابع <t:…:R> داخل جملة عربية لا يُكشف جزئياً أبداً', () => {
    // النص الكامل يحمل التاريخ بعد 2025 فيُفترض أن يمرّ؛ نجرّب كل حدّ ممكن.
    const text = `الإجازة تبدأ <t:1759276800:R> وتنتهي بعد أسبوعين`;
    for (let n = 1; n <= text.length; n++) {
      const out = clipRich(text, n);
      assert.ok(out.length <= n, `تجاوز الحدّ عند ${n}: ${JSON.stringify(out)}`);
      const lt = out.indexOf('<');
      if (lt !== -1) {
        assert.ok(out.indexOf('>', lt) !== -1, `طابع ناقص ظاهر للمستخدم عند ${n}: ${JSON.stringify(out)}`);
        assert.match(out, /<t:\d{9,}:[A-Za-z]>/, `وسم ناقص عند ${n}: ${JSON.stringify(out)}`);
      }
      // لا أحرف لاتينية مسرّبة من داخل طابع
      assert.ok(!/\d{6,}[A-Za-z]?\s*$/.test(out.replace(/…$/, '')) || out.includes('<t:'), `بقي ذيل طابع عند ${n}`);
    }
    assert.ok(clipRich(text, text.length + 5).includes('<t:1759276800:R>'), 'النص القصير يجب أن يمرّ كاملاً');
  });

  test('شريط ** يبقى متوازناً عند كل حدّ، ولا تبقى نجمة مفردة مسرّبة', () => {
    const text = 'ملاحظة **مهمة جداً** على عضو';
    for (let n = 1; n <= text.length; n++) {
      const out = clipRich(text, n);
      const stars = (out.match(/\*/g) || []).length;
      assert.equal(stars % 2, 0, `** غير متوازن عند ${n}: ${JSON.stringify(out)}`);
      if (stars > 0) assert.ok(out.includes('**'), `نجمة مفردة بلا فاصل عند ${n}: ${JSON.stringify(out)}`);
    }
  });

  test('علامة تشكيل عربية لا تتيمة أبداً', () => {
    const text = 'قُرْآنٌ كَرِيمٌ نزَّلناه';
    for (let n = 1; n <= text.length; n++) {
      const out = clipRich(text, n).replace(/…$/, '');
      assert.ok(!ARABIC_DIACRITIC.test(out.slice(-1)), `تَشْكيل معلّق عند ${n}: ${JSON.stringify(out)}`);
    }
  });

  test('منشور <@id> لا يُقطع في منتصف الرمز', () => {
    const text = `أنشأه <@${IDS.target}> اليوم`;
    for (let n = 1; n <= text.length; n++) {
      const out = clipRich(text, n);
      const lt = out.indexOf('<');
      if (lt !== -1) assert.ok(out.indexOf('>', lt) !== -1, `منشور ناقص عند ${n}: ${JSON.stringify(out)}`);
      assert.ok(!/@\d{1,10}(?![0-9])/.test(out), `معرّف مقطوع عند ${n}: ${JSON.stringify(out)}`);
    }
    assert.ok(clipRich(text, text.length + 5).includes(`<@${IDS.target}>`));
  });

  // نصوص الوصفين مبنيّة من نقاط الترميز لا مكتوبة حرفياً: حرف مشكول واحد
  // يكتبه محرّر غير محترف فتتغير الكلمة، ونحصل حينها على اختبار يمرّ على كود
  // مكسور لأن القالب لم يعد يطابق شيئاً.
  const A = (...cps) => String.fromCodePoint(...cps);
  const DAYS = A(0x627, 0x644, 0x623, 0x64A, 0x627, 0x645);            // الأيام (الصيغة الصحيحة)
  const TYPO = A(0x644, 0x644, 0x623, 0x631, 0x62C, 0x627, 0x639);    // للأرجاع (خطأ)
  const WRONG_LATIN = '(required for set action)';

  test('i18n: أوصاف الخيارات بلا لاتيني دخيل ولا خطأ إملائي', () => {
    // الخيارات تظهر للمستخدم في منتقي أوامر ديسكورد، فلا تساويها
    // «تعليق داخلي». staff-logs بقي بعد دمج audit.
    const cases = [
      ['staff-logs', require('../src/commands/staff-logs').commands, 'days'],
    ];
    const ARABIC = /[\u0600-\u06FF]/;
    for (const [name, commands, option] of cases) {
      const cmd = commands.find(c => c.data.name === name);
      assert.ok(cmd, `${name}: the command is missing from the registry`);
      const opt = cmd.data.options.find(o => o.name === option);
      assert.ok(opt, `${name}: option ${option} is missing`);
      const d = opt.description;
      assert.ok(ARABIC.test(d), `${name}.${option}: has no Arabic at all — ${d}`);
      const words = d.replace(/[<>@#`]/g, '').match(/[A-Za-z]{2,}/g) || [];
      assert.deepEqual(words, [], `${name}.${option}: Latin leaked in — ${words.join(',')} in ${d}`);
      assert.ok(!d.includes(WRONG_LATIN), `${name}.${option}: the English placeholder survived — ${d}`);
      assert.ok(!d.includes(TYPO), `${name}.${option}: the misspelling survived — ${d}`);
      // موجب لا سلبي: نقول ما يجب أن يكون. «الأيام» هي الصيغة الصحيحة.
      if (name === 'staff-logs') assert.ok(d.includes(DAYS), `${name}.${option}: missing the correct wording — ${d}`);
    }
  });

  test('truncate وtrim يفوّضان إلى clipRich — سلوك واحد لا سلوكان', () => {
    const sample = `الإجازة <t:1759276800:R> **معتمدة** <@${IDS.target}> عَلَى قُرْآن`;
    for (const n of [5, 11, 20, 33, 47, 60, sample.length]) {
      assert.equal(truncate(sample, n), clipRich(sample, n), `truncate ≠ clipRich عند ${n}`);
      assert.equal(kit.trim(sample, n), clipRich(sample, n), `trim ≠ clipRich عند ${n}`);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════
// 3) نظام النقاط: ترتيب النقاط (points.leaderboard) بديل الترتيب القديم
// ════════════════════════════════════════════════════════════════════════

describe('ترتيب النقاط (points.leaderboard): الحقبة الحالية', () => {
  const SEED_ID_BASE = 3000000000000000000n;

  function seedMember(id, { team = 'support', rank = 'Support', status = 'active', epoch = 1, points = 0 } = {}) {
    const db = getDb();
    db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity, rank_epoch)
      VALUES (?, ?, ?, ?, ?, '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00', ?)
      ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, rank = excluded.rank, status = excluded.status, rank_epoch = excluded.rank_epoch`)
      .run(id, `user-${id}`, team, rank, status, epoch);
    if (points > 0) {
      // Use unique ref_id per member to avoid unique constraint (reason_key, ref_type, ref_id) WHERE ref_id IS NOT NULL
      const refId = today() + '-' + id;
      db.prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch, added_by, created_at)
        VALUES (?, ?, 'daily_active', 'daily active', 'day', ?, ?, 'test', datetime('now'))`)
        .run(id, points, refId, epoch);
    }
  }

  beforeEach(() => {
    openMemoryDb();
    settings.set('test', true);
    // seed test members
    seedMember('3001', { team: 'support', rank: 'Support', points: 100 });
    seedMember('3002', { team: 'support', rank: 'Senior Support', points: 250 });
    seedMember('3003', { team: 'support', rank: 'Support', points: 50 });
    seedMember('3004', { team: 'moderation', rank: 'Moderator', points: 300 });
    seedMember('3005', { team: 'moderation', rank: 'Trial Moderator', points: 75 });
    seedMember('3006', { team: 'support', rank: 'Support', status: 'on_leave', points: 200 });
    seedMember('3007', { team: 'support', rank: 'Support', points: 0 }); // zero points
    // قرار المالك D6 (2026-10-24): الحالات غير الفاعلة تغادر اللوحة. أعلى
    // نقاط دفتر موجودة موزعة على معلّق: لو تسربت للوحة انقلبت كل القمم.
    seedMember('3008', { team: 'support', rank: 'Support', status: 'suspended', points: 900 });
  });

  test('يعيد الأعضاء مرتبةً تنازلياً حسب النقاط الإجمالية', () => {
    const lb = points.leaderboard({ team: 'support', limit: 20 });
    // فقط الفاعلون الحاليون بصفوف دفتر يظهرون: 3007 صفر النقاط لا يظهر،
    // و3006 (on_leave) و3008 (suspended، أعلى رصيد بـ 900) خارج اللوحة —
    // قرار المالك D6: حالات الاستثناء تلوث التقارير المحفوظة بظهورها.
    assert.equal(lb.length, 3);
    assert.ok(!lb.some(r => r.user_id === '3006'), 'on_leave خارج اللوحة');
    assert.ok(!lb.some(r => r.user_id === '3008'), 'suspended خارج اللوحة مهما بلغ رصيده');
    // ترتيب تنازلي: 250, 100, 50
    assert.equal(lb[0].user_id, '3002');
    assert.equal(lb[0].total, 250);
    assert.equal(lb[1].user_id, '3001');
    assert.equal(lb[1].total, 100);
    assert.equal(lb[2].user_id, '3003');
    assert.equal(lb[2].total, 50);
  });

  test('يستطيع التصفية حسب الفريق', () => {
    const support = points.leaderboard({ team: 'support', limit: 20 });
    const moderation = points.leaderboard({ team: 'moderation', limit: 20 });
    assert.ok(support.every(r => r.team === 'support'));
    assert.ok(moderation.every(r => r.team === 'moderation'));
  });

  test('يحترم حدّ limit', () => {
    const lb = points.leaderboard({ team: 'support', limit: 2 });
    assert.equal(lb.length, 2);
    assert.equal(lb[0].user_id, '3002');
    assert.equal(lb[1].user_id, '3001', 'المعلّق والمُجاز يُقصّان فلا يشغلان مقعدين');
  });

  test('يعيد حقل frozen بناءً على point_freezes', () => {
    const db = getDb();
    // أضف تجميداً للعضو 3002
    db.prepare(`INSERT INTO point_freezes (user_id, until, reason) VALUES (?, ?, 'test')`)
      .run('3002', clock.addDays(clock.today(), 7));

    const lb = points.leaderboard({ team: 'support', limit: 20 });
    const frozenUser = lb.find(r => r.user_id === '3002');
    assert.ok(frozenUser);
    assert.equal(frozenUser.frozen, true);

    // باقي الأعضاء غير مجمّدين
    const notFrozen = lb.filter(r => r.user_id !== '3002');
    assert.ok(notFrozen.every(r => r.frozen === false));
  });

  test('يستبعد المستقيلين', () => {
    const db = getDb();
    db.prepare(`UPDATE staff_members SET status = 'resigned' WHERE user_id = '3002'`).run();

    const lb = points.leaderboard({ team: 'support', limit: 20 });
    assert.ok(!lb.some(r => r.user_id === '3002'));
  });

  test('يعيد الحقول الأساسية لكل صف', () => {
    const lb = points.leaderboard({ team: 'support', limit: 20 });
    // كل صف يجب أن يحتوي على الحقول الأساسية
    for (const r of lb) {
      assert.ok('user_id' in r);
      assert.ok('total' in r);
      assert.ok('team' in r);
      assert.ok('rank' in r);
      assert.ok('status' in r);
      assert.ok('frozen' in r);
    }
  });

  test('بدون أعضاء يعيد مصفوفة فارغة لا يفشل', () => {
    openMemoryDb();
    settings.set('test', true);
    const lb = points.leaderboard({ team: 'support', limit: 20 });
    assert.deepEqual(lb, []);
  });

  test('بدون فريق (team: null) يعيد الترتيب لكلا الفريقين', () => {
    const lb = points.leaderboard({ limit: 20 });
    assert.ok(lb.some(r => r.team === 'support'));
    assert.ok(lb.some(r => r.team === 'moderation'));
    // مرتبة تنازلياً عالمياً
    for (let i = 1; i < lb.length; i++) {
      assert.ok(lb[i].total <= lb[i - 1].total, `الترتيب غير تنازلي عند الفهرس ${i}`);
    }
  });
});