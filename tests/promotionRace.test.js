'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const promo = require('../src/services/promotions');
const audit = require('../src/services/audit');
const { resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');

const IDS = {
  approver: '1005171993940852796',
  target: '1490787800168005713',
  rival: '424242424242424242',
  channel: '523456789012345678',
  guild: '623456789012345678',
};

// ===== سباق الترقيات — الفصل المحاري وقراءة حية بعد التأجيل (تقرير التدقيق) =====
// نمط الإجازات نفسه: نحرّك الصف داخل تأجيل الخاسر (بين قراءته/تسجيل موافقته
// والفصل)، ثم نجزم أن فصل المتسبق باقٍ وأن الخاسر سقط من مساره كل آثاره
// المتصاعدة (رتبة، سجل تدقيق، خاص، نشر قنوات، فرع النصاب المتأجل) ويرى الحالة
// الحقيقية ببطاقة بلا أزرار مراجعة.

function seedStaff(id, rank = 'Helper', team = 'support') {
  // joined_at/rank_since/last_activity كأقران ackWindow: nextPromotion يقرأ
  // الرتبة الحية (لا اللقطة)، وبوابة الأشهر تُحسب من rank_since.
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, ?, ?, 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')`)
    .run(id, id, team, rank);
}

/** طلب ترقية بـ to_rank من القاعدة الحية لرتبة العضو الحالية — بما يحكم عليه promo:approve */
function seedPromotion(id) {
  const s = getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
  return promo.getRequest(promo.createRequest(s, promo.evaluate(s), 'سبب'));
}

function mockClient() {
  return {
    channels: { fetch: async () => ({ send: async payload => { mockClient.sent.push(payload); return { id: 'm-1', payload }; } }) },
    users: { fetch: async uid => ({ id: uid, send: async payload => { mockClient.dms.push({ id: uid, payload }); } }) },
  };
}
mockClient.sent = [];
mockClient.dms = [];

function interaction({ id = IDS.approver, level = LEVELS.SUPERVISOR, texts = {}, modal = false } = {}, inject) {
  const i = {
    customId: '', user: { id }, guildId: IDS.guild, channelId: IDS.channel,
    client: mockClient(), staffLevel: level, staffInfo: { team: 'support', level },
    member: { id, displayName: 'm', guild: { ownerId: 'someone-else' }, roles: { cache: new Map() }, permissions: { has: () => false } },
    // applyRankRoles تُتخطى هنا (عضو تعذّر جلبه) — الكتابة على الترقية قاعدة
    // البيانات وحدّها، فالسباق لا يتأثر بذريعة غياب العضو.
    guild: { members: { fetch: async () => null } },
    values: [], deferred: false, replied: false, followUps: [],
    fields: {
      getTextInputValue: key => texts[key] ?? '',
      getField: key => ({ custom_id: key, type: 4, value: texts[key] ?? '', values: [] }),
    },
    isModalSubmit: () => modal,
    async reply(payload) { assert(!i.replied, 'reply بعد الإقرار'); i.replied = true; i.payload = payload; },
    async deferUpdate() { i.deferred = true; i.replied = true; if (inject) await inject(); },
    async deferReply() { i.deferred = true; i.replied = true; if (inject) await inject(); },
    async editReply(payload) { assert(i.replied, 'editReply بلا تأجيل'); i.payload = payload; },
    async followUp(payload) { assert(i.replied, 'followUp بلا تأجيل'); i.followUps.push(payload); },
    async showModal(modalSpec) { i.modal = modalSpec; },
  };
  return i;
}

const json = p => JSON.parse(JSON.stringify(p));
// بطابات البناء (EmbedBuilder) لا تُكشف حقولها كأعضاء — التسلسل يفجّرها
const embedText = p => JSON.parse(JSON.stringify(p.embeds || [])).map(e => `${e.title || ''}\n${e.description || ''}`).join('\n');
const voteRow = (reqId, userId) => getDb().prepare('SELECT user_id FROM promotion_approvals WHERE request_id = ? AND user_id = ?').get(reqId, userId);

beforeEach(() => {
  openMemoryDb();
  mockClient.sent = [];
  mockClient.dms = [];
  for (const key of ['manager-review', 'staff-updates', 'staff-logs', 'moderators-logs']) {
    settings.setChannel(key, IDS.channel);
  }
  seedStaff(IDS.target);
});

describe('سباق مراجعة الترقيات', () => {
  test('موافقة سباق (نصاب فردي): فاز بالفصل مراجعٌ آخر — الخاسر بلا ترقية ولا خاص ولا نشر ولا سجل', async () => {
    const req = seedPromotion(IDS.target); // Helper→Support — نصاب 1، أهلية SUPERVISOR
    const loser = interaction({ id: IDS.approver, level: LEVELS.SUPERVISOR }, async () => {
      // المتسابق أنهى الفصل داخل نافذة تأجيل الخاسر (وقفل) ورقّى العضو.
      promo.review(req.id, 'approved', IDS.rival, null);
      getDb().prepare(`UPDATE staff_members SET rank = 'Support' WHERE user_id = ?`).run(IDS.target);
    });
    await resolveComponent('promo:approve').handler(loser, [String(req.id)]);

    const row = promo.getRequest(req.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.reviewed_by, IDS.rival, 'فصل المتسبق باقٍ — الخاسر لم يمسه');
    assert.equal(getDb().prepare('SELECT rank FROM staff_members WHERE user_id = ?').get(IDS.target).rank, 'Support', 'ترقية المتسبق باقية');
    assert.equal(audit.count({ action: 'promotion_approved', actorId: IDS.approver }), 0, 'الخاسر لم يسجّل ترقية المتسبق باسمه');
    assert.equal(audit.count({ action: 'promotion_approval_recorded', actorId: IDS.approver }), 0, 'الخاسر لم يمشي فرع النصاب المتأجل');
    assert.equal(mockClient.dms.length, 0, 'الخاسر لم يبعث «مبروك» لترقية نافذها غيره');
    assert.equal(mockClient.sent.length, 0, 'الخاسر لم ينشر ترقية المتسبق في القنوات');
    assert.equal(loser.followUps.length, 0, 'لا «بانتظار موافقة إضافية» على طلب مقفل أصلاً');
    assert.ok(voteRow(req.id, IDS.approver), 'موافقة الخاسر تبقى محفوظة في الدفاتر فلا يُعاد الفصل عنها');
    assert.match(loser.payload.content, /لم يُنفَّذ شيء من نقرتك/, 'الرد الصادق يخبره أن نقرته سقطت');
    assert.match(embedText(loser.payload), /✅ مقبول/, 'البطاقة تعرض الحالة الحقيقية');
    assert.equal(json(loser.payload).components.length, 0, 'لا أزرار مراجعة على بطاقة انتهت مراجعتها');
  });

  test('نصاب ثنائي سباق: خاسرٌ سجّلت موافقته ثم فاز المتسرع بالفصل داخل نافذته — لا «بانتظار موافقة» ولا أزرار على بطاقة معتمدة', async () => {
    const req = seedPromotion(IDS.target); // Support→Support Expert — نصاب 2، أهلية MANAGEMENT
    const loser = interaction({ id: IDS.approver, level: LEVELS.MANAGEMENT }, async () => {
      // أثناء نافذة تأجيل الخاسر: المتسابق يسجّل ثاني موافقة ثم يقفل الطلب —
      // عدّ الخاسر القديم (1/2) كان سيُخدعه إلى فرع «بانتظار موافقة إضافية»
      // بأزرار مراجعة على بطاقة معتمدة.
      promo.recordApproval(req.id, IDS.rival);
      promo.review(req.id, 'approved', IDS.rival, null);
    });
    await resolveComponent('promo:approve').handler(loser, [String(req.id)]);

    const row = promo.getRequest(req.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.reviewed_by, IDS.rival);
    assert.equal(promo.approvalsCount(req.id), 2, 'مؤجّلُ الموافقة + المتسابق — يُصبح هذا النصاب حقيقياً');
    assert.ok(voteRow(req.id, IDS.approver), 'موافقة الخاسر محفوظة');
    assert.equal(audit.count({ action: 'promotion_approval_recorded', actorId: IDS.approver }), 0, 'لا تسجيل «موافقة مُسجّلة» على طلب مقفل');
    assert.equal(loser.followUps.length, 0, 'لا «بانتظار موافقة إضافية»');
    assert.equal(mockClient.dms.length, 0);
    assert.equal(mockClient.sent.length, 0);
    assert.match(loser.payload.content, /لم يُنفَّذ شيء من نقرتك/);
    assert.match(embedText(loser.payload), /✅ مقبول/, 'البطاقة الحقيقية بلا أزرار مراجعة');
    assert.equal(json(loser.payload).components.length, 0);
  });

  test('رفض متزامن: مراجعُ آخر سبق — الخاسر بلا سجل رفض ولا خاص بمسببه ولا سبب يمسح مراجعة الغير', async () => {
    const req = seedPromotion(IDS.target);
    const loser = interaction({ id: IDS.approver, level: LEVELS.MANAGEMENT, modal: true, texts: { reason: 'سبب الخاسر' } }, async () => {
      promo.review(req.id, 'rejected', IDS.rival, 'قرار الخصم المتزامن');
    });
    await resolveComponent('promo:rejectmodal').handler(loser, [String(req.id)]);

    const row = promo.getRequest(req.id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.reviewed_by, IDS.rival);
    assert.equal(row.review_reason, 'قرار الخصم المتزامن', 'سبب الخاسر لم يمسح مراجعة الغير');
    assert.equal(audit.count({ action: 'promotion_rejected', actorId: IDS.approver }), 0, 'الخاسر لم يسجّل رفضاً مزدوجاً');
    assert.equal(mockClient.dms.length, 0, 'الخاسر لم يبعث للعضو برفض لم يصدر عنه');
    assert.equal(mockClient.sent.length, 0, 'الخاسر لم ينشر رفضاً في سجلات القناة');
    assert.match(loser.payload.content, /لم يُسجَّل سبب رفضك/);
    assert.match(embedText(loser.payload), /❌ مرفوض/, 'البطاقة تعرض الحالة الحقيقية');
  });

  test('مسار الفائز سليم بلا سباق: فصل واحد ورتبة وخاص ونشر وسجل — بلا فرع مؤجل', async () => {
    const req = seedPromotion(IDS.target); // Helper→Support
    const approver = interaction({ id: IDS.approver, level: LEVELS.SUPERVISOR });
    await resolveComponent('promo:approve').handler(approver, [String(req.id)]);

    const row = promo.getRequest(req.id);
    assert.equal(row.status, 'approved');
    assert.equal(row.reviewed_by, IDS.approver);
    assert.equal(getDb().prepare('SELECT rank FROM staff_members WHERE user_id = ?').get(IDS.target).rank, 'Support', 'الترقية تطبّقت');
    assert.equal(audit.count({ action: 'promotion_approved', actorId: IDS.approver }), 1);
    assert.equal(audit.count({ action: 'promotion_approved', actorId: IDS.rival }), 0);
    assert.equal(mockClient.dms.length, 1, 'مبروك ترقية واحد بالخاص');
    assert.equal(mockClient.sent.length, 2, 'القناتان: staff-updates + staff-logs');
    assert.ok(mockClient.sent.some(s => embedText(s).includes('ترقية')), 'النشر المنشور هو بطاقة الترقية');
    assert.equal(approver.followUps.length, 0, 'الفصل لا يمر بفرع انتظار النصاب');
    assert.match(embedText(approver.payload), /✅ مقبول/, 'بطاقة الفائز تُعتمد الترقية');
  });
});
