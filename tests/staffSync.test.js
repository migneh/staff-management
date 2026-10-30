'use strict';
/**
 * ⑯ — أول تغطية لمسارات staffSync.syncGuild وsnapshot.
 * سابقاً كان المغطّى تجميل reportEmbed فقط (embeds.test.js)، بينما قلب المزامنة
 * (تسجيل من حمل رتبة، نزع الرتب، تخطي البوتات، فشل الجلب) كانت بلا اختبار.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const staffService = require('../src/services/staff');
const staffSync = require('../src/services/staffSync');

/** عضو وهمي: الرتب عبر cache.has كما تقرأها resolveStaff. */
function member(id, roleIds = [], username = id, bot = false) {
  return { id, user: { bot, username }, roles: { cache: new Set(roleIds) } };
}

const guildOf = members => ({ members: { fetch: async () => members } });

/** يربط رتبتين تنفيذيتين كي يقرأهما resolveStaff بأسمائها الصحيحة. */
function bindKnownRanks() {
  settings.setRole('support', 'Support', 'r-support');
  settings.setRole('moderation', 'Moderator', 'r-mod');
}

/** زرع صف إداري مباشرة بلا مرور بـ ensure. */
function seedStaffRow(id, team, rank, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, ?, ?, ?)`).run(id, `u-${id}`, team, rank, status);
}

beforeEach(() => {
  openMemoryDb();
  bindKnownRanks();
});

describe('staffSync.syncGuild — التسجيل من رتب الديسكورد (⑯)', () => {
  test('يزامن أول دفعة: يُسجّل من حمل رتبة، ويُتجاهل البوت، ولا يسجل من لا رتبة له', async () => {
    const carrying = member('8101', ['r-support']);
    const but = member('8102', ['r-support'], 'robot', true);
    const nobody = member('8103', []);
    const report = await staffSync.syncGuild(guildOf([carrying, but, nobody]));

    assert.deepEqual(report.registered.map(r => r.id), ['8101']);
    assert.equal(report.bots, 1, 'البوت يُعدّ ويُتجاهل قبل العد');
    assert.equal(report.scanned, 2, 'البوت لا يُحسب مفحوصاً');
    const row = getDb().prepare('SELECT team, rank, status FROM staff_members WHERE user_id = ?').get('8101');
    assert.equal(row.team, 'support');
    assert.equal(row.rank, 'Support');
    assert.equal(row.status, 'probation', 'الدخول من الرتب يفتح على فترة تجريبية');
    assert.deepEqual(report.departures, []);
    assert.equal(settings.policy('staffLastSyncAt') != null, true, 'نجاح المزامنة يختم الوقت');
    assert.equal(settings.policy('staffLastSyncBy'), 'auto', 'بلا منفّذ يعرف تلقائياً');
  });

  test('تغيّر الرتبة أو الفريق يظهر في report.updated بصيغة من ← إلى', async () => {
    seedStaffRow('8122', 'support', 'Support');
    const moved = member('8122', ['r-mod']);
    const report = await staffSync.syncGuild(guildOf([moved]));

    assert.deepEqual(report.updated.map(u => u.id), ['8122']);
    assert.equal(report.updated[0].from, 'Support (active)');
    assert.equal(report.updated[0].to, 'Moderator (active)');
    assert.equal(report.registered.length, 0);
    const row = getDb().prepare('SELECT team, rank FROM staff_members WHERE user_id = ?').get('8122');
    assert.deepEqual([row.team, row.rank], ['moderation', 'Moderator']);
  });

  test('بلا تغيير: العضو المطابق لصفه يُعدّ unchanged ويظهر «✅ لا جديد» في التقرير', async () => {
    seedStaffRow('8133', 'support', 'Support');
    const same = member('8133', ['r-support'], 'u-8133');
    const report = await staffSync.syncGuild(guildOf([same]));

    assert.equal(report.unchanged, 1);
    assert.equal(report.updated.length, 0);
    assert.equal(report.registered.length, 0);
    const e = staffSync.reportEmbed(report).toJSON();
    assert.ok(e.fields.some(f => f.name === '✅ لا جديد'), 'التقرير يجب أن يطمئن بنص صريح');
  });

  test('نُزعت الرتب الإدارية: مسجّل نشط يخرج removed ويُوثَّق، وon_leave يبقى ساكناً بلا قيد', async () => {
    seedStaffRow('8141', 'moderation', 'Moderator');
    seedStaffRow('8142', 'moderation', 'Moderator', 'on_leave');
    const report = await staffSync.syncGuild(guildOf([member('8141', []), member('8142', [])]));

    assert.deepEqual(report.departures.map(d => ({ id: d.id, next: d.next })), [
      { id: '8141', next: 'removed' },
    ], 'on_leave يبقى على حالته فلا يُدخل قائمة النزع');
    assert.equal(getDb().prepare('SELECT status FROM staff_members WHERE user_id = ?').get('8141').status, 'removed');
    assert.equal(getDb().prepare('SELECT status FROM staff_members WHERE user_id = ?').get('8142').status, 'on_leave');
  });

  test('مخروج لم يكن مسجّلاً أصلاً لا يُنشئ صفاً ولا يُدخل قائمة النزع', async () => {
    const report = await staffSync.syncGuild(guildOf([member('8188', [])]));
    assert.equal(report.departures.length, 0);
    assert.equal(staffService.all({ includeResigned: true }).length, 0);
  });

  test('فشل قراءة الأعضاء: تقرير خطأ صريح ولا ختم مزامنة يُكتب', async () => {
    seedStaffRow('8151', 'support', 'Support');
    const broken = { members: { fetch: async () => { throw new Error('websocket down'); } } };
    const report = await staffSync.syncGuild(broken, { actorId: 'boss' });

    assert.match(report.error, /تعذّر قراءة الأعضاء/);
    assert.ok(report.error.includes('websocket down'), 'يجب أن يَحمِل سبب الخطأ في التقرير');
    assert.equal(report.total, 1, 'عند الفشل يبقى العدد المسجّل فقط');
    assert.ok(settings.policy('staffLastSyncAt') == null, 'الختم لا يُكتب في مزامنة فاشلة');
  });
});

describe('staffSync.snapshot — عدّة الحالة في /setup (⑯)', () => {
  test('يُعدّ الحالات ويشير إلى من فريقه بلا رتبة مربوطة', () => {
    seedStaffRow('8201', 'support', 'Support');
    seedStaffRow('8202', 'moderation', 'Moderator', 'probation');
    seedStaffRow('8203', 'moderation', 'Moderator', 'suspended');
    seedStaffRow('8204', 'support', 'Support', 'on_leave');
    seedStaffRow('8205', 'moderation', 'Moderator', 'resigned');
    assert.deepEqual(staffSync.snapshot(), {
      total: 5, active: 1, probation: 1, away: 2, out: 1, unknown: 0, lastSync: null,
    }, 'بلا نزع رتب افتراضياً: كل الصفوف معروفة الرتبة');

    settings.setRole('moderation', 'Moderator', null);
    const snap = staffSync.snapshot();
    assert.equal(snap.unknown, 3, 'فكّ ربط رتبة واحدة يجعل صفوفها الثلاثة مجهولة الرتبة');
    assert.equal(snap.total, 5, 'فكّ الربط لا يغيّر عدد المجموع');
  });
});
