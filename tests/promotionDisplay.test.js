'use strict';
// مُستهلكو العرض يقرؤون عتباتهم من طبقة القواعد: التجاوز الحيّ يبنى في البطاقات
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const settings = require('../src/services/settings');
const { commands } = require('../src/commands');
const rules = require('../src/services/promotionRules');
const { arDigits } = require('../src/utils');

beforeEach(() => {
  openMemoryDb();
  settings.set('test', true); // تبطل كاش الإعدادات بين قواعد الاختبار
  settings.resetPolicy('points_epoch_started_at'); // لا عتبة انتقالية هنا
  rules.resetRule('support', 'Support');
  rules.resetRule('moderation', 'Moderator');
});

/** عضو إشراف برتبته منذ 120 يوماً كي تمر بوابة المدة وحدها */
function seedMember(id, team = 'moderation', rank = 'Moderator') {
  const since = clock.addDays(clock.today(), -120);
  return getDb().prepare(`INSERT OR REPLACE INTO staff_members
    (user_id, username, team, rank, status, joined_at, rank_since, rank_epoch)
    VALUES (?, ?, ?, ?, 'active', ?, ?, 0)`).run(id, 'tester', team, rank, since, since);
}

const asJson = i => JSON.stringify((i.payload.embeds || []).map(e => e.toJSON()));
async function replyI(name, id) {
  const i = {
    user: { id }, client: {}, staffLevel: 3,
    options: { getBoolean: () => false },
    async reply(p) { this.payload = p; return p; },
  };
  await commands.get(name).execute(i);
  assert(i.payload, `${name} لم يرد`);
  return i;
}

test('لوحة /promotion-info تعكس تجاوز عتبة النقاط حياً ثم تعود إلى الثوابت', async () => {
  const base = asJson(await replyI('promotion-info', 'p1'));
  assert.match(base, new RegExp(`نقاط ${arDigits(500)}\\+`)); // عتبة Support الثابتة
  rules.setRule('support', 'Support', { pointsThreshold: 800 });
  const over = asJson(await replyI('promotion-info', 'p1'));
  assert.match(over, new RegExp(`نقاط ${arDigits(800)}\\+`));
  assert.equal(over.includes(`نقاط ${arDigits(500)}+`), false);
  rules.resetRule('support', 'Support');
  assert.match(asJson(await replyI('promotion-info', 'p1')), new RegExp(`نقاط ${arDigits(500)}\\+`));
});

test('بطاقة /promotion-progress تقرأ عتبتها من قاعدة التقييم لا من الثوابت', async () => {
  seedMember('p2');
  let i = await replyI('promotion-progress', 'p2');
  assert.match(asJson(i), new RegExp(` / ${arDigits(550)}`));
  rules.setRule('moderation', 'Moderator', { pointsThreshold: 700 });
  i = await replyI('promotion-progress', 'p2');
  assert.match(asJson(i), new RegExp(` / ${arDigits(700)}`));
  assert.equal(asJson(i).includes(` / ${arDigits(550)}`), false);
  rules.resetRule('moderation', 'Moderator');
  assert.match(asJson(await replyI('promotion-progress', 'p2')), new RegExp(` / ${arDigits(550)}`));
});

test('دفتر /my-points يبني بند التقدم من العتبة الحيّة', async () => {
  seedMember('p3');
  rules.setRule('moderation', 'Moderator', { pointsThreshold: 700 });
  let i = await replyI('my-points', 'p3');
  assert.match(asJson(i), new RegExp(`عتبة اليوم: \\*\\*${arDigits(700)}\\*\\*`));
  rules.resetRule('moderation', 'Moderator');
  i = await replyI('my-points', 'p3');
  assert.match(asJson(i), new RegExp(`عتبة اليوم: \\*\\*${arDigits(550)}\\*\\*`));
});

test('تقرير الأداء الشخصي يحسب نسبة تقدمه من العتبة الحيّة', async () => {
  seedMember('p4');
  rules.setRule('moderation', 'Moderator', { pointsThreshold: 700 });
  let i = await replyI('my-performance', 'p4');
  let fields = (i.payload.embeds || []).map(e => e.toJSON())
    .flatMap(e => e.fields || []);
  const field = fields.find(f => f.name.includes('نقاط الترقية'));
  assert(field, JSON.stringify((i.payload.embeds || []).map(e => e.toJSON())));
  assert.equal(field.value.includes(' / 700'), true);
  assert.equal(field.value.includes(' / 550'), false);
  rules.resetRule('moderation', 'Moderator');
  i = await replyI('my-performance', 'p4');
  fields = (i.payload.embeds || []).map(e => e.toJSON()).flatMap(e => e.fields || []);
  assert.equal(fields.find(f => f.name.includes('نقاط الترقية')).value.includes(' / 550'), true);
});
