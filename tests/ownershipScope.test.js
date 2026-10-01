'use strict';
/**
 * اختبارات نطاق الملكية — تفتح ثغرات IDOR وفتحتا write بلا فحص:
 *   1. leave:myleaves  : معرّف مستخدم غريب داخل customId
 *   2. leave:pickaction: قراءة صف إجازة شخص آخر
 *   3. modaction:log   : هدف غير مسجَّل أو أعلى رتبةً من المنفّذ
 *   4. /add-note       : بوابة الفريق المفقودة مقارنةً بـ /note
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
const { commands, resolveComponent } = require('../src/commands');
const { accessContext, commandAccessError } = require('../src/services/commandAccess');
const { LEVELS } = require('../src/constants');
const { today, addDays } = require('../src/utils');

const IDS = {
  me: '1005171993940852796',
  peer: '1490787800168005713',
  boss: '223456789012345678',
  gm: '323456789012345678',
  stranger: '112233445566778899',
  channel: '423456789012345678',
  guild: '523456789012345678',
};
const D = offset => addDays(today(), offset);

function seedStaff(id, team, rank, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, rank = excluded.rank, status = excluded.status`)
    .run(id, id, team, rank, status);
}
function seedLeave(userId, status = 'approved') {
  const res = getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, status)
    VALUES (?, 'normal', 'سبب', ?, ?, 3, ?)`).run(userId, D(5), D(7), status);
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(res.lastInsertRowid);
}

/** تفاعل وهمي بحدود أوسع من tests/leave.test.js: نحتاج showModal وfollowUp معاً. */
function interaction({ customId = '', id = IDS.me, level = LEVELS.STAFF, team = 'support', rank = 'Support',
  status = 'active', texts = {}, values = [], seed = true } = {}) {
  if (seed) seedStaff(id, team, rank, status);
  const calls = { reply: [], update: [], modal: null, followUp: [] };
  const i = {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel,
    client: {
      channels: { fetch: async () => ({ send: async p => ({ id: '1', payload: p }) }) },
      users: { fetch: async () => ({ send: async () => {} }) },
    },
    staffLevel: level, staffInfo: { team, level },
    member: { id, permissions: { has: () => false }, roles: { cache: new Map() } },
    values, calls,
    fields: { getTextInputValue: k => texts[k] ?? '', getStringSelectValues: () => [] },
    async reply(p) { calls.reply.push(p); this.payload = p; return p; },
    async update(p) { calls.update.push(p); this.payload = p; return p; },
    async followUp(p) { calls.followUp.push(p); return p; },
    async showModal(m) { calls.modal = m; return m; },
  };
  return i;
}
/** Reply text: replyEphemeral puts the message in an EmbedBuilder, not in content. */
const text = calls => JSON.stringify(calls.reply.concat(calls.update).map(c => {
  const embeds = (c.embeds || []).map(e => { const d = e.toJSON ? e.toJSON() : e; return `${d.title || ''} ${d.description || ''}`; }).join(' ');
  return `${c.content || ''} ${embeds}`;
}));

beforeEach(() => { openMemoryDb(); settings.set('test', true); });

describe('leave:myleaves — معرّف غريب داخل customId', () => {
  test('يُمنع على إداري عادي: لا يقرأ إجازات غيره', async () => {
    seedStaff(IDS.peer, 'support', 'Support');
    seedLeave(IDS.peer);
    const i = interaction({ customId: `leave:myleaves:1:${IDS.peer}`, level: LEVELS.STAFF });
    await resolveComponent(`leave:myleaves:1:${IDS.peer}`).handler(i, ['1', IDS.peer]);
    assert.equal(i.calls.update.length, 0, 'لا يحدّث البطاقة باسم غيره');
    assert.match(text(i.calls), /لا تملك الصلاحية/);
  });

  test('staffLevel غير المعرَّف لا يفتح الباب: الفحص يفشل مغلقاً', async () => {
    // i.staffLevel غير معرّف => المقارنة القديمة `undefined < 4` = false => تجاوز.
    seedStaff(IDS.peer, 'support', 'Support');
    seedLeave(IDS.peer);
    const i = interaction({ customId: `leave:myleaves:1:${IDS.peer}` });
    i.staffLevel = undefined;
    await resolveComponent(`leave:myleaves:1:${IDS.peer}`).handler(i, ['1', IDS.peer]);
    assert.equal(i.calls.update.length, 0);
    assert.match(text(i.calls), /لا تملك الصلاحية/);
  });

  test('مسموح للمراجع الأعلى (MANAGEMENT) بالإشراف', async () => {
    seedStaff(IDS.peer, 'support', 'Support');
    const row = seedLeave(IDS.peer);
    const i = interaction({ customId: `leave:myleaves:1:${IDS.peer}`, id: IDS.boss,
      level: LEVELS.MANAGEMENT, team: 'moderation', rank: 'Head Of Moderators' });
    await resolveComponent(`leave:myleaves:1:${IDS.peer}`).handler(i, ['1', IDS.peer]);
    assert.equal(i.calls.reply.length, 0, 'لا رفض');
    assert.equal(i.calls.update.length, 1, 'يعرض بطاقة إجازات العضو');
    const card = i.calls.update[0].embeds[0].toJSON();
    assert.equal(card.title, '🏖️ إجازاتي');
    assert.ok(JSON.stringify(card.fields).includes(`#${row.id}`), 'يعرض طلبات العضو المطلوب');
  });

  test('صاحب الطلب يقرأ صفحاته بالمعرّف المضمّن — المسار الطبيعي سليم', async () => {
    seedLeave(IDS.me);
    const i = interaction({ customId: `leave:myleaves:1:${IDS.me}` });
    await resolveComponent(`leave:myleaves:1:${IDS.me}`).handler(i, ['1', IDS.me]);
    assert.equal(i.calls.reply.length, 0);
    assert.equal(i.calls.update.length, 1);
  });
});

describe('leave:pickaction — نطاق فرع التمديد', () => {
  test('لا يفتح نموذج تمديد لطلب شخص آخر', async () => {
    seedStaff(IDS.peer, 'support', 'Support');
    const row = seedLeave(IDS.peer, 'approved');
    const i = interaction({ customId: 'leave:pickaction:1', values: [`${row.id}:approved`] });
    await resolveComponent('leave:pickaction:1').handler(i, ['1']);
    assert.equal(i.calls.modal, null, 'لم يُفتح نموذج لغير المالك');
    assert.match(text(i.calls), /ليس من طلباتك/);
  });

  test('يبقى سليماً للمالك: الفرع يفتح النموذج ويأخذ تاريخ النهاية الصحيح', async () => {
    const row = seedLeave(IDS.me, 'approved');
    const i = interaction({ customId: 'leave:pickaction:1', values: [`${row.id}:approved`] });
    await resolveComponent('leave:pickaction:1').handler(i, ['1']);
    assert.ok(i.calls.modal, 'النموذج يُفتح لصاحبه');
    assert.match(i.calls.modal.toJSON().custom_id, new RegExp(`^leave:extendmodal:${row.id}`));
  });

  test('معرّف طلب غير موجود يُرفض بدل فتح نموذج فارغ', async () => {
    const i = interaction({ customId: 'leave:pickaction:1', values: ['99999:approved'] });
    await resolveComponent('leave:pickaction:1').handler(i, ['1']);
    assert.equal(i.calls.modal, null);
  });
});

describe('/log-action — بوابة الهدف قبل الكتابة', () => {
  const modalFor = (target, extra = {}) => interaction({ customId: 'modaction:log:warn',
    texts: { target, reason: 'سبب', duration: 'none', ...extra } });

  test('يرفض هدفاً غير مسجَّل كإداري', async () => {
    const i = modalFor(IDS.stranger, {});
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(text(i.calls), /غير مسجّل كإداري|غير مسجل كإداري/);
    assert.equal(i.calls.reply.length, 1);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM mod_actions').get().c, 0);
  });

  test('يرفض هدفاً مساوياً في الرتبة — التساوي مرفوض أيضاً', async () => {
    // المنفّذ Supervisor Manager (مستوى 3)، والهدف Co General Manager (مستوى 6)
    seedStaff(IDS.peer, 'general_management', 'Co General Manager');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.SUPERVISOR,
      id: IDS.me, team: 'support', rank: 'Supervisor Manager',
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(text(i.calls), /رتبتك أو ما فوقها/);
    assert.equal(i.calls.reply.length, 1, 'لا بطاقة تأكيد');
    assert.equal(i.calls.update.length, 0);
  });

  test('يرفض General Manager (أعلى مستوى) على مشرف إشراف', async () => {
    seedStaff(IDS.gm, 'general_management', 'General Manager');
    const i = interaction({ customId: 'modaction:log:ban', level: LEVELS.SUPERVISOR,
      id: IDS.me, team: 'moderation', rank: 'Admin',
      texts: { target: IDS.gm, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:ban').handler(i, ['ban']);
    assert.match(text(i.calls), /رتبتك أو ما فوقها/);
  });

  test('رتبة أعلى فعلاً مسموحة: Head Of Moderators (٤) على Admin (٣)', async () => {
    seedStaff(IDS.peer, 'moderation', 'Admin');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.MANAGEMENT,
      id: IDS.me, team: 'moderation', rank: 'Head Of Moderators',
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.equal(i.calls.reply.length, 1);
    const card = i.calls.reply[0].embeds[0].toJSON();
    assert.match(card.title, /تأكيد تسجيل/, 'وصل إلى بطاقة التأكيد');
    assert.match(card.description, /لن يُكتب أي شيء/);
  });

  test('مستوى أدنى من المنفّذ مسموح: Admin (٣) على Trial Moderator (١)', async () => {
    seedStaff(IDS.peer, 'moderation', 'Trial Moderator');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.SUPERVISOR,
      id: IDS.me, team: 'moderation', rank: 'Admin',
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(i.calls.reply[0].embeds[0].toJSON().title, /تأكيد تسجيل/);
  });

  // سلوك مقصود ومقفل: المقارنة على سُلّم LEVELS لا على ترتيب الرتب داخل الفريق،
  // فـ Trial Moderator و Moderator يشتركان في المستوى ١ — وهما متساويان إذن والمرفوض بينهما.
  test('رتبتان في المستوى نفسه تُعامَلان كمتساويتين — Moderator على Trial Moderator مرفوض', async () => {
    seedStaff(IDS.peer, 'moderation', 'Trial Moderator');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.STAFF,
      id: IDS.me, team: 'moderation', rank: 'Moderator',
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(text(i.calls), /رتبتك أو ما فوقها/);
    assert.equal(i.calls.reply.length, 1);
    assert.equal(i.calls.update.length, 0, 'لا بطاقة تأكيد');
  });

  test('رتبة غير مربوطة بإعدادات البوت تُرفض بدل المرور', async () => {
    seedStaff(IDS.peer, 'support', 'رتبة غير موجودة');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.STAFF,
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(text(i.calls), /غير مربوطة بإعدادات البوت/);
  });
});

describe('/add-note — بوابة الفريق كما في /note', () => {
  test('الفرق بين /note و /add-note في team = null و /note moderation', () => {
    assert.equal(commands.get('note').team, 'moderation', '/note محصور بالإشراف');
    assert.equal(commands.get('add-note').team, 'moderation', '/add-note يطابقه');
    assert.equal(commands.get('add-note').level, commands.get('note').level, 'نفس المستوى');
  });

  test('مشرف الدعم يُمنع من إضافة ملاحظة سلبية لأحد الإشراف', () => {
    const i = interaction({ id: IDS.me, level: LEVELS.SUPERVISOR, team: 'support', rank: 'Supervisor Manager' });
    const err = commandAccessError(commands.get('add-note'), accessContext(i));
    assert.match(err, /فريق الإشراف/);
  });

  test('مشرف الإشراف مسموح له', () => {
    const i = interaction({ id: IDS.me, level: LEVELS.SUPERVISOR, team: 'moderation', rank: 'Admin' });
    assert.equal(commandAccessError(commands.get('add-note'), accessContext(i)), null);
  });

  test('كلا الأمرين يبقيان مكتبة الملاحظات واحدة — لا مسار ثالث للتحايل', () => {
    // /note و /add-note يكتبان في staff_notes نفسه، وبوابة الفريق مطبَّقة على كليهما.
    assert.equal(commands.get('note').team, 'moderation');
    assert.equal(commands.get('warn').team, 'moderation');
  });
});

describe('سلامة ما بعد الإصلاح', () => {
  test('allowance يبقى يعمل للمالك بعد تضييق الاستعلام', () => {
    seedLeave(IDS.me, 'approved');
    assert.ok(leavesService.allowance(IDS.me));
    assert.equal(leavesService.pendingForUser(IDS.me).length, 0);
  });
});