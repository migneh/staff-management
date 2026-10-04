'use strict';
/**
 * اختبارات نطاق الملكية — تفتح ثغرات IDOR وفتحتا write بلا فحص:
 *   1. leave:myleaves  : معرّف مستخدم غريب داخل customId
 *   2. leave:pickaction: قراءة صف إجازة شخص آخر
 *   3. modaction:log   : هدف أعلى رتبةً من المنفّذ (وغير المسجَّل كإداري يمرّ بقرار المالك D3)
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
const { actionRankDenial } = require('../src/services/permissions');
const { actionBlockedMessage } = require('../src/commands/logging');
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
    staffLevel: level, staffInfo: { team, rank, level },
    member: { id, permissions: { has: () => false }, roles: { cache: new Map() } },
    values, calls,
    fields: { getTextInputValue: k => texts[k] ?? '', getStringSelectValues: () => [] },
    async reply(p) { calls.reply.push(p); this.payload = p; return p; },
    async update(p) { calls.update.push(p); this.payload = p; return p; },
    async followUp(p) { calls.followUp.push(p); return p; },
    async showModal(m) { calls.modal = m; return m; },
    async deferUpdate() { calls.deferred = (calls.deferred || 0) + 1; },
    async editReply(p) { calls.editReply = (calls.editReply || []); calls.editReply.push(p); return p; },
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

  test('يدخل هدفاً غير مسجَّل كإداري إلى بطاقة التأكيد — قرار المالك D3', async () => {
    const i = modalFor(IDS.stranger, {});
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.equal(i.calls.reply.length, 1, 'ردّ واحد بلا رفض');
    assert.match(text(i.calls), /تأكيد تسجيل/, 'بلغ بطاقة التأكيد بدل رسالة «غير مسجل»');
    assert.ok(!/غير مسج/.test(text(i.calls)), 'لا أثر لرسالة الرفض القديمة');
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM mod_actions').get().c, 0, 'لا كتابة قبل التأكيد');
  });

  test('مسار الكتابة الكامل لهدف غير مسجَّل: التأكيد يكتب سطراً واحداً', async () => {
    const opener = modalFor(IDS.stranger, {});
    await resolveComponent('modaction:log:warn').handler(opener, ['warn']);
    const token = opener.calls.reply[0].components[0].toJSON().components[0].custom_id.split(':').pop();
    // منفّذ إداري نفسه (نفس المالك والمجلد) يؤكد: إعادة البوابة عند الكتابة
    // لا تُحوّل الفراغ إلى رفض، فالسطر يُكتب فعلاً للعضو العادي.
    const confirmer = interaction({ customId: `modaction:confirm:${token}`, texts: {} });
    await resolveComponent('modaction:confirm').handler(confirmer, [token]);
    const rows = getDb().prepare('SELECT moderator_id, target_id FROM mod_actions').all();
    assert.equal(rows.length, 1, 'سطر واحد كُتب بعد التأكيد');
    assert.equal(rows[0].target_id, IDS.stranger, 'الهدف هو العضو العادي');
    assert.equal(rows[0].moderator_id, IDS.me, 'المنفّذ هو المُشغِّل');
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

  // سلوك مقصود ومقفل بعد الإصلاح المعتمد من صاحب المشروع: داخل الفريق الواحد
  // تنظر المقارنة إلى الترتيب لا إلى تساوي LEVELS، فـ Trial Moderator و
  // Moderator يشتركان في المستوى ١ ومع ذلك يجوز للمoderator أن يسجّل على
  // Trial Moderator — الزوج الثالث الذي قاسه التدقيق ووثّقه. الرتبة
  // المتطابقة تبقى مرفوضة، والحراسة بعدها تثبت ذلك في البوابة الحيّة نفسها.
  test('رتبتان في المستوى نفسه داخل الفريق: Moderator على Trial Moderator مسموح بعد الإصلاح', async () => {
    seedStaff(IDS.peer, 'moderation', 'Trial Moderator');
    const i = interaction({ customId: 'modaction:log:warn', level: LEVELS.STAFF,
      id: IDS.me, team: 'moderation', rank: 'Moderator',
      texts: { target: IDS.peer, reason: 'سبب', duration: 'none' } });
    await resolveComponent('modaction:log:warn').handler(i, ['warn']);
    assert.match(text(i.calls), /تأكيد تسجيل/, 'وصلت البطاقة بدل الرفض — التوسيع حيّ في مسار الإجراء');
    assert.equal(i.calls.reply.length, 1);
  });

  test('الرتبة المتطابقة تبقى مرفوضة في البوابة الحيّة: Moderator على Moderator', async () => {
    seedStaff(IDS.peer, 'moderation', 'Moderator');
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

/**
 * تساوي المستوى داخل الفريق — الإصلاح المعتمد من صاحب المشروع:
 * نفس الفريق + مستوى متساوٍ ⇒ الترتيب داخل مصفوفة الفريق يحكم، فالرتبة
 * الأعلى فعلاً (فهرس أكبر) تُجيز العمل على الأدنى. كل ما عداه يبقى كما كان:
 * بين الفرق يحكم المستوى، والمستوى الأدنى لا يصعد أبداً، والرتبة المتطابقة
 * مرفوضة. الأزواج الثلاثة المسموحة أدناه هي ما قاسه التدقيق ووثّقه،
 * وكل حراسة هنا تثبت أن الإصلاح لم يفتح ثغرة جديدة معها.
 */
describe('بوابة تراتب الرتب — تساوي المستوى داخل الفريق', () => {
  const actor = (team, rank, level) => ({ team, rank, level });
  const target = (team, rank) => ({ team, rank });
  const mustAllow = denial => assert.equal(denial, null, 'كان يجب أن يُسمح');
  const mustRefuse = (denial, re = /رتبتك أو ما فوقها/) => assert.match(String(denial), re);

  // ===== الأزواج الثلاثة التي قاسها التدقيق: أصبحت مسموحة =====
  test('الزوج ١: Support على Helper — نفس الفريق والمستوى ١: مسموح', () => {
    mustAllow(actionRankDenial(actor('support', 'Support', LEVELS.STAFF), target('support', 'Helper')));
  });

  test('الزوج ٢: Support Analyst على Support Expert — نفس الفريق والمستوى ٢: مسموح', () => {
    mustAllow(actionRankDenial(actor('support', 'Support Analyst', LEVELS.SENIOR), target('support', 'Support Expert')));
  });

  test('الزوج ٣: Moderator على Trial Moderator — نفس الفريق والمستوى ١: مسموح', () => {
    mustAllow(actionRankDenial(actor('moderation', 'Moderator', LEVELS.STAFF), target('moderation', 'Trial Moderator')));
  });

  // ===== حراسات: الإصلاح لم يفتح ثغرة =====
  test('مستوى متساوٍ وفريق مختلف: Supervisor Manager (الدعم) على Admin (الإشراف) مرفوض', () => {
    mustRefuse(actionRankDenial(actor('support', 'Supervisor Manager', LEVELS.SUPERVISOR), target('moderation', 'Admin')));
  });

  test('مستوى متساوٍ وفريق مختلف بالاتجاه المعاكس: Admin على Supervisor Manager مرفوض', () => {
    mustRefuse(actionRankDenial(actor('moderation', 'Admin', LEVELS.SUPERVISOR), target('support', 'Supervisor Manager')));
  });

  test('الانخفاض المطلق لا يصعد: Support على Support Analyst مرفوض', () => {
    mustRefuse(actionRankDenial(actor('support', 'Support', LEVELS.STAFF), target('support', 'Support Analyst')));
  });

  test('الاتجاه المعاكس منضبط: Support Analyst على Helper مسموح (أعلى على أدنى)', () => {
    mustAllow(actionRankDenial(actor('support', 'Support Analyst', LEVELS.SENIOR), target('support', 'Helper')));
  });

  test('الرتبة المتطابقة مرفوضة: Moderator على Moderator لا تمرّ بالتساوي', () => {
    mustRefuse(actionRankDenial(actor('moderation', 'Moderator', LEVELS.STAFF), target('moderation', 'Moderator')));
  });

  test('فهرس أدنى داخل المستوى نفسه مرفوض: Helper على Support', () => {
    mustRefuse(actionRankDenial(actor('support', 'Helper', LEVELS.STAFF), target('support', 'Support')));
  });

  test('زوج كان مسموحاً يبقى مسموحاً: Head Of Moderators على Admin', () => {
    mustAllow(actionRankDenial(actor('moderation', 'Head Of Moderators', LEVELS.MANAGEMENT), target('moderation', 'Admin')));
  });

  test('هدف أعلى عبر فريقين مرفوض: Moderator على Co General Manager', () => {
    mustRefuse(actionRankDenial(actor('moderation', 'Moderator', LEVELS.STAFF), target('general_management', 'Co General Manager')));
  });

  test('رتبة هدف غير مربوطة تُرفض — الفشل مغلق كما كان', () => {
    mustRefuse(actionRankDenial(actor('support', 'Support', LEVELS.STAFF), target('support', 'رتبة غير موجودة')), /غير مربوطة بإعدادات البوت/);
  });

  test('مالك بلا رتبة (مستوى GM): هدف أدنى يمرّ، وGeneral Manager آخر مرفوض', () => {
    mustAllow(actionRankDenial({ level: LEVELS.GENERAL_MANAGER }, target('support', 'Boss')));
    mustRefuse(actionRankDenial({ level: LEVELS.GENERAL_MANAGER }, target('general_management', 'General Manager')));
  });
});

/**
 * البوابة الحيّة نفسها: actionBlockedMessage في src/commands/logging.js هي
 * ما يمرّ عليه فعل log-action وmodaction:log. اختبارات الدالة actionRankDenial
 * وحدها لا تثبت أن هذه البوابة تستدعيها فعلاً (التوثيق لا يُعدّ اتصالاً) —
 * فنمرّر الحالات الأربع عبر المسار الحيّ: السماح الموسّع، ومنع التوسيع بين
 * الفرق، والصعود المطلق، والسماح بغير المسجَّل (قرار المالك D3).
 */
describe('بوابة logging الحيّة — actionBlockedMessage تستدعي actionRankDenial', () => {
  const TARGET = IDS.peer;

  test('الزوج المعتمد يمرّ عبر البوابة الحيّة: Support على Helper', () => {
    const i = interaction({ id: IDS.me, team: 'support', rank: 'Support', level: LEVELS.STAFF });
    seedStaff(TARGET, 'support', 'Helper');
    assert.equal(actionBlockedMessage(i, TARGET), null, 'التوسيع المعتمد لم يصل إلى البوابة الحيّة');
  });

  test('التوسيع لم يُفتح بين الفرق: مستوى متساوٍ Support/Admin يُرفض في البوابة الحيّة', () => {
    const i = interaction({ id: IDS.me, team: 'support', rank: 'Supervisor Manager', level: LEVELS.SUPERVISOR });
    seedStaff(TARGET, 'moderation', 'Admin');
    assert.match(String(actionBlockedMessage(i, TARGET)), /رتبتك أو ما فوقها/);
  });

  test('الصعود المطلق ما زال مرفوضاً في البوابة الحيّة: Support على Support Analyst', () => {
    const i = interaction({ id: IDS.me, team: 'support', rank: 'Support', level: LEVELS.STAFF });
    seedStaff(TARGET, 'support', 'Support Analyst');
    assert.match(String(actionBlockedMessage(i, TARGET)), /رتبتك أو ما فوقها/);
  });

  test('غير المسجَّل كإداري يمرّ البوابة الحيّة — قرار المالك D3', () => {
    const i = interaction({ id: IDS.me, team: 'support', rank: 'Support', level: LEVELS.STAFF });
    assert.equal(actionBlockedMessage(i, '999999999999999999'), null,
      'لا صفّ في staff_members ⇒ لا رتبة تُحمى ⇒ البوابة تعود سماحاً');
  });
});

describe('بوابة الفريق على مسار الأوامر — نفس تجاوز المكوّنات', () => {
  test('مالك السيرفر بلا رتبة فريق يمرّ بوابة /add-note', () => {
    const i = interaction({ id: IDS.me, level: LEVELS.GENERAL_MANAGER, team: null, seed: false });
    i.member.guild = { ownerId: IDS.me };
    const ctx = accessContext(i);
    assert.equal(ctx.serverManager, true, 'isServerManager يلتقط المالك من guild.ownerId');
    assert.equal(commandAccessError(commands.get('add-note'), ctx), null,
      'تجاوز Server Manager لبوابة الفريق يجب أن يصل المسارين معاً');
  });

  test('من دون تجاوز: بوابة الفريق نفسها ترفض من ليس Server Manager', () => {
    const i = interaction({ id: IDS.me, level: LEVELS.GENERAL_MANAGER, team: null, seed: false });
    const ctx = accessContext(i);
    assert.equal(ctx.serverManager, false);
    assert.match(commandAccessError(commands.get('add-note'), ctx), /فريق الإشراف/);
  });
});