'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const promo = require('../src/services/promotions');
const audit = require('../src/services/audit');
const { resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');

// عقود حراسة هوية الترقيات (موجة نقاط 2026-10-24 — البند ⑩):
// • مودال الطلب من خارج الدفتر (مسار Server Manager: i.staffLevel=GM بلا صف
//   إداري وبوابة promo:modal دنيا): رفضٌ صريح بلا طلب مكتوب — لا انهيار ولا منحة.
// • الموافقة علبها الحارس نفسه: صاحب الطلب بلا صف ⇒ توقف صريح، والمعلَّق
//   يبقى معلَّقاً (طرده المتاهة المجدولة، لا قرار الأزرار) بلا رتبة ولا أثر متصاعد.
// • الطالب السليم يكمل مساره عاديًّا — الحراسات لا تعطل المنح الجائز.

const IDS = {
  gm: '333000000000000000', // Server Manager بلا صف إداري في staff_members
  approver: '100000000000000005',
  target: '100000000000000113',
  orphan: '111000000000000000', // صاحب طلب يتيم بلا صف دفتر
  channel: '700000000000000002',
  guild: '800000000000000003',
};

beforeEach(() => {
  openMemoryDb();
  for (const key of ['manager-review', 'staff-updates', 'staff-logs', 'moderators-logs']) {
    settings.setChannel(key, IDS.channel);
  }
});

function seedStaff(id, rank = 'Helper', team = 'support') {
  // joined_at/rank_since/last_activity كأقران promotionRace: nextPromotion يقرأ
  // الرتبة الحية وبوابة الأشهر تُحسب من rank_since.
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, ?, ?, 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')`)
    .run(id, id, team, rank);
}

/** طلب يتيم: صاحبه بلا صف في staff_members — زرعٌ خام لأثر خارج الكود */
function seedOrphanRequest(userId, fromRank, toRank) {
  const res = getDb().prepare(`INSERT INTO promotion_requests (user_id, from_rank, to_rank, note, snapshot)
    VALUES (?, ?, ?, 'طلب يتيم', NULL)`).run(userId, fromRank, toRank);
  return Number(res.lastInsertRowid);
}

function mockClient() {
  const client = {
    channels: { fetch: async () => ({ send: async payload => { client.sent.push(payload); return { id: 'm-1' }; } }) },
    users: { fetch: async uid => ({ id: uid, send: async payload => { client.dms.push({ id: uid, payload }); } }) },
  };
  client.sent = [];
  client.dms = [];
  return client;
}

function interaction({ id, level, staffInfo } = {}) {
  const i = {
    customId: '', user: { id }, guildId: IDS.guild, channelId: IDS.channel,
    client: mockClient(), staffLevel: level,
    // فرع التجاوز (index.js) يمنح staffLevel وحده دون staffInfo — تعبيها إلا عند ورودها.
    staffInfo: staffInfo === undefined ? null : staffInfo,
    member: { id, displayName: 'm', guild: { ownerId: 'someone-else' }, roles: { cache: new Map() }, permissions: { has: () => false } },
    guild: { members: { fetch: async () => null } },
    deferred: false, replied: false, followUps: [],
    fields: {
      getTextInputValue: key => texts[key] ?? '',
      getField: key => ({ custom_id: key, type: 4, value: texts[key] ?? '', values: [] }),
    },
    async reply(payload) { assert(!i.replied, 'reply بعد الإقرار'); i.replied = true; i.payload = payload; },
    async deferUpdate() { i.deferred = true; i.replied = true; },
    async deferReply() { i.deferred = true; i.replied = true; },
    async editReply(payload) { assert(i.replied, 'editReply بلا تأجيل'); i.payload = payload; },
    async followUp(payload) { assert(i.replied, 'followUp بلا تأجيل'); i.followUps.push(payload); },
    async showModal() {},
  };
  return i;
}

const texts = {};
const textOf = p => JSON.parse(JSON.stringify(p.embeds || [])).map(e => `${e.title || ''}\n${e.description || ''}`).join('\n');

test('مودال بلا صف دفتر (مسار Server Manager): رفض صريح — لا انهيار ولا صف ترقية', async () => {
  const bag = interaction({ id: IDS.gm, level: LEVELS.GENERAL_MANAGER }); // بلا بذرة عضو
  await resolveComponent('promo:modal').handler(bag, []);
  assert.ok(bag.replied, 'ردٌّ لطيف يصل المُقدِّم بدل الانفجار');
  assert.match(textOf(bag.payload), /لا ترقية تُقَدَّم من خارج الدفتر/, 'الرد يشرح القاعدة لا يخفيها');
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM promotion_requests WHERE user_id = ?').get(IDS.gm).c, 0, 'لا صف ترقية لغير أهل الدفتر');
  assert.equal(bag.client.sent.length, 0, 'لا بطاقة مراجعة تُنشر في قناة الإدارة عن شخص خارج الدفتر');
});

test('موافقة على طلب صاحبه بلا صف دفتر: توقف صريح — المعلَّق يبقى معلَّقاً بلا رتبة ولا أثر', async () => {
  const id = seedOrphanRequest(IDS.orphan, 'Helper', 'Support');
  const bag = interaction({ id: IDS.approver, level: LEVELS.SUPERVISOR });
  await resolveComponent('promo:approve').handler(bag, [String(id)]);
  assert.ok(bag.replied);
  assert.match(textOf(bag.payload), /لا تُنفَّذ بلا صف أهلية/, 'الرفض يبدّد العلة (بلا صف أهلية) صراحة');
  assert.equal(promo.getRequest(id).status, 'pending', 'التوقف لا قرار — الطرد لمسار مجدوله المسؤول');
  assert.equal(audit.count({ action: 'promotion_approved', actorId: IDS.approver }), 0, 'الموافقة على بلا صف لا تتسجيل بلا نفاذة');
  assert.equal(bag.client.dms.length, 0, 'لا «مبروك» يبعث لمن ليس في الدفتر');
  assert.equal(bag.client.sent.length, 0, 'لا نشر ترفيع في القنوات');
});

test('الطالب السليم يكمل مساره بعد الحرسات: رتبة مكتوبة وحالة مقبولة وخاص وتدقيق', async () => {
  seedStaff(IDS.target);
  const s = getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(IDS.target);
  const req = promo.getRequest(promo.createRequest(s, promo.evaluate(s), 'سبب'));
  const bag = interaction({ id: IDS.approver, level: LEVELS.SUPERVISOR, staffInfo: { team: 'support', level: LEVELS.SUPERVISOR } });
  await resolveComponent('promo:approve').handler(bag, [String(req.id)]);
  const row = promo.getRequest(req.id);
  assert.equal(row.status, 'approved');
  assert.equal(getDb().prepare('SELECT rank FROM staff_members WHERE user_id = ?').get(IDS.target).rank, 'Support', 'الترقية كُتبت لا مرفوعة');
  assert.equal(audit.count({ action: 'promotion_approved', actorId: IDS.approver }), 1);
  assert.equal(bag.client.dms.length, 1, 'الترقية الجائزة تصلك خبرها كما دائماً');
});
