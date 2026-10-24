'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const ratings = require('../src/services/supportRatings');
const reports = require('../src/services/reports');
const { commands, resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');
const IDS = { staff: '1005171993940852796', reviewer: '1490787800168005713', bot: '123456789012345678', channel: '223456789012345678', guild: '323456789012345678' };
const example = `- > ** تم تقييم الاداري **\n\nا <@${IDS.staff}>\n\n\n- > ** العضو الي قييم **\n\nا <@${IDS.reviewer}>\n\n\n- > عدد النجوم : ⭐⭐⭐⭐⭐`;
let next = 423456789012345678n;
function message(extra = {}) {
  return { content: example, id: String(next++), author: { id: IDS.bot, bot: true }, channelId: IDS.channel, guildId: IDS.guild, createdTimestamp: Date.now(), ...extra };
}
function staff(id = IDS.staff, team = 'support', status = 'active') {
  getDb().prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)').run(id, 'tester', team, team === 'support' ? 'Support' : 'Moderator', status);
}
// البوت مضبوط في كل اختبار — البوابة مغلقة افتراضياً بعد إغلاقها (تقرير التدقيق):
// غياب بوت مضبوط يعني «لا استيراد» لا «أي بوت يمر».
beforeEach(() => { openMemoryDb(); settings.setChannel('support-rating-logs', IDS.channel); settings.setPolicy('ratingBotId', IDS.bot); });

test('يحلل صيغة المستخدم حرفياً ويربط كل منشن بعنوانه', () => {
  const parsed = ratings.parse(message());
  assert.equal(parsed.staffId, IDS.staff);
  assert.equal(parsed.reviewerId, IDS.reviewer);
  assert.equal(parsed.stars, 5);
  assert.equal(parsed.channelId, IDS.channel);
});

test('يدعم HTML وembeds والهمزات والتشكيل والتباعد دون احتساب نجوم الزينة', () => {
  assert.equal(ratings.parse(message({ content: example.replace(/</g, '&lt;').replace(/>/g, '&gt;') })).stars, 5);
  for (let stars = 1; stars <= 5; stars++) {
    const parsed = ratings.parse(message({ content: '', embeds: [{ title: '⭐ تقييم عميل', fields: [
      { name: '** العضو الذي قيّم **', value: `<@!${IDS.reviewer}>` },
      { name: '** تم تقييم الإداري **', value: `<@${IDS.staff}>` },
      { name: 'عدد النجوم', value: '⭐️'.repeat(stars) },
    ], footer: { text: 'شكراً على تقييمك' } }] }));
    assert.equal(parsed.stars, stars);
    assert.equal(parsed.staffId, IDS.staff);
  }
});

test('يرفض القناة الخطأ والبشر والبوت غير المسموح والتقييم الذاتي والرسائل الملتبسة', () => {
  assert.equal(ratings.parse(message({ channelId: 'elsewhere' })), null);
  assert.equal(ratings.parse(message({ author: { bot: false, id: IDS.reviewer } })), null);
  for (const text of [example.replace(IDS.reviewer, IDS.staff), example.replace('⭐⭐⭐⭐⭐', '⭐⭐⭐⭐⭐⭐'), example.replace('⭐⭐⭐⭐⭐', ''), example.replace('⭐⭐⭐⭐⭐', '5'), example.replace('العضو الي قييم', 'شيء آخر'), example.replace(`<@${IDS.staff}>`, `<@${IDS.staff}> <@${IDS.reviewer}>`), example.replace(`<@${IDS.staff}>`, `<@${IDS.staff}`), example + '\nعدد النجوم : ⭐']) {
    assert.equal(ratings.parse(message({ content: text })), null, text);
  }
  settings.setPolicy('ratingBotId', IDS.reviewer);
  assert.equal(ratings.parse(message()), null);
  settings.setPolicy('ratingBotId', IDS.bot);
  assert(ratings.parse(message()));
  settings.setChannel('support-rating-logs', null);
  assert.equal(ratings.parse(message()), null);
});

test('بوابة البوت مغلقة افتراضياً: بلا بوت مضبوط لا استيراد، وغير المضبوط مرفوض', () => {
  settings.setPolicy('ratingBotId', null);
  assert.equal(ratings.parse(message()), null, 'غياب تعريف البوت يجب أن يغلق التتبع لا أن يقبل أي بوت');
  settings.setPolicy('ratingBotId', '999888777666555444');
  assert.equal(ratings.parse(message()), null, 'بوت غير المضبوط يجب رفض تقييماته');
  settings.setPolicy('ratingBotId', IDS.bot);
  assert(ratings.parse(message()), 'بوت التقييم المضبوط نفسه يمر من البوابة');
});

test('يسجل التقييم مرة واحدة مع التدقيق دون إنشاء تكت أو نقاط', () => {
  staff();
  const parsed = ratings.parse(message());
  assert(ratings.record(parsed).saved);
  assert(ratings.record(parsed).duplicate);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM support_ratings').get().c, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM audit_logs').get().c, 1);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 0);
  assert.equal(ratings.summary(IDS.staff).average, 5);
  const row = ratings.summary(IDS.staff).recent[0];
  assert.equal(ratings.sourceUrl(row), `https://discord.com/channels/${IDS.guild}/${IDS.channel}/${parsed.messageId}`);
});

test('يتجاهل غير المسجل وغير فريق الدعم والمستقيل والقيم غير الصالحة', () => {
  const parsed = ratings.parse(message());
  assert.equal(ratings.record(parsed).ignored, 'not_support');
  staff(IDS.staff, 'moderation');
  assert.equal(ratings.record(parsed).ignored, 'not_support');
  getDb().prepare("UPDATE staff_members SET team='support', status='resigned'").run();
  assert.equal(ratings.record(parsed).ignored, 'not_support');
  assert.equal(ratings.record({ ...parsed, stars: 2.5 }).ignored, 'invalid');
});

test('يعتمد متوسط المصدر الخارجي عند وجوده دون جمعه مع تقييمات التكت المكررة', () => {
  staff();
  getDb().prepare("INSERT INTO ticket_metrics (ticket_id,ticket_owner,claimer,closer,rating,duration,logged_by) VALUES ('t1', ?, ?, ?, 1, 3, ?)").run(IDS.reviewer, IDS.staff, IDS.staff, IDS.bot);
  let raw = reports.getRaw(IDS.staff);
  assert.equal(raw.avgRating, 1);
  assert.equal(raw.ratingSource, 'tickets');
  ratings.record(ratings.parse(message()));
  ratings.record(ratings.parse(message({ content: example.replace('⭐⭐⭐⭐⭐', '⭐⭐⭐') })));
  raw = reports.getRaw(IDS.staff);
  assert.equal(raw.tickets, 1);
  assert.equal(raw.avgRating, 4);
  assert.equal(raw.ratingCount, 2);
  assert.equal(raw.ratingSource, 'external');
  assert.equal(reports.getRaw(IDS.staff, 7, 7).avgRating, null);
  const summary = ratings.summary(IDS.staff);
  assert.equal(summary.reviewers, 1);
  assert.equal(summary.count, 2);
});

test('الاستيراد يزامن رتبة الدعم الحالية ويمنع بوتنا ومغادري الفريق وإعادة التسليم', async () => {
  settings.setRole('support', 'Support', 'role-support');
  const member = { id: IDS.staff, user: { username: 'new' }, roles: { cache: new Map([['role-support', {}]]) } };
  const m = message({ guild: { id: IDS.guild, members: { fetch: async () => member } } });
  assert.equal(await ratings.importMessage(m, IDS.bot), null);
  assert((await ratings.importMessage(m, 'our-bot')).saved);
  assert.equal(getDb().prepare('SELECT team FROM staff_members WHERE user_id=?').get(IDS.staff).team, 'support');
  assert((await ratings.importMessage(m, 'our-bot')).duplicate);
  member.roles.cache.clear();
  assert.equal((await ratings.importMessage({ ...m, id: String(next++) }, 'our-bot')).ignored, 'not_support');
  const unavailable = message({ guild: { members: { fetch: async () => { throw new Error('missing'); } } } });
  assert.equal((await ratings.importMessage(unavailable, 'our-bot')).ignored, 'member_unavailable');
});

test('الواجهة تظهر حالة فارغة وتمنع غير المشرف من تصفح تقييمات الآخرين', async () => {
  staff();
  const i = { user: { id: IDS.staff }, staffLevel: LEVELS.STAFF, async reply(p) { this.payload = p; }, async update(p) { this.payload = p; } };
  await commands.get('my-ratings').execute(i);
  assert.match(i.payload.embeds[0].toJSON().fields[0].name, /لا توجد تقييمات/);
  await resolveComponent('ratings:period').handler(i, [IDS.reviewer, '30']);
  assert.match(i.payload.embeds[0].toJSON().description, /لا يمكنك/);
  ratings.record(ratings.parse(message()));
  await resolveComponent('ratings:period').handler(i, [IDS.staff, '7']);
  assert.equal(i.payload.embeds[0].toJSON().fields[0].value, '**5/5**');
});
