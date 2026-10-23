'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const load = require('../src/services/load');
const reports = require('../src/services/reports');
const settings = require('../src/services/settings');
const clock = require('../src/clock');
const taskService = require('../src/services/tasks');
const scheduler = require('../src/scheduler');
const recognition = require('../src/commands/recognition');
const appeals = require('../src/commands/appeals');
const health = require('../src/health');
const { RESIGNATION_GLOBAL } = require('../src/constants');
const { today } = require('../src/utils');

function seedStaff(id, team, rank, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)`)
    .run(id, id, team, rank, status);
  return getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

beforeEach(() => openMemoryDb());

describe('المرحلة 3 — شفافية وتقارير العمل', () => {
  test('يحسب اتجاه الأسبوع من نافذة سابقة لا من نفس البيانات', () => {
    const staff = seedStaff('trend', 'support', 'Support');
    const db = getDb();
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('trend', '1', 'staff', 1, date('now'), datetime('now'))`).run();
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('trend', '1', 'staff', 1, date('now', '-10 days'), datetime('now', '-10 days'))`).run();
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('trend', '2', 'staff', 1, date('now', '-11 days'), datetime('now', '-11 days'))`).run();
    const current = reports.getRaw(staff.user_id, 7);
    const previous = reports.getRaw(staff.user_id, 7, 7);
    assert.equal(current.messages, 1);
    assert.equal(previous.messages, 2);
    const trend = reports.personalTrend(staff);
    assert.equal(trend.currentActiveDays, 1);
    assert.equal(trend.previousActiveDays, 2);
  });

  test('واجهات أوزان Score القديمة غير متاحة', () => {
    assert.equal(settings.scoreWeights, undefined);
    assert.equal(settings.setScoreWeights, undefined);
  });

  test('يرسل تذكير التأهيل مرة واحدة ويميز المهمة عند نجاح الرسالة', async () => {
    const task = taskService.create({ userId: 'reminder', title: 'مهمة موعدها اليوم', taskType: 'onboarding', dueDate: today(), assignedBy: 'system' });
    const sent = [];
    const client = { users: { fetch: async () => ({ send: async payload => sent.push(payload) }) } };
    assert.equal(await scheduler.processTaskReminders(client), 1);
    assert.equal(sent.length, 1);
    assert.ok(taskService.get(task.id).reminder_sent_at);
    assert.equal(await scheduler.processTaskReminders(client), 0);
  });

  test('ينشئ مهام تسليم مرتبطة بآخر يوم الاستقالة', () => {
    const tasks = RESIGNATION_GLOBAL.handoverTasks.map(title => taskService.create({ userId: 'offboard', title: `استقالة #7: ${title}`, taskType: 'offboarding', dueDate: '2026-09-30', assignedBy: 'manager' }));
    assert.equal(tasks.length, RESIGNATION_GLOBAL.handoverTasks.length);
    assert.deepEqual(taskService.listByType('offboarding').map(t => t.due_date), tasks.map(() => '2026-09-30'));
  });

  test('يعتمد ترشيح التقدير مرة واحدة ولا يمنح نقاطاً (نظام النقاط أُزيل)', async () => {
    seedStaff('nominator', 'support', 'Support');
    seedStaff('winner', 'support', 'Support');
    const result = getDb().prepare('INSERT INTO recognition_nominations (nominator_id, target_id, reason, day) VALUES (?, ?, ?, ?)').run('nominator', 'winner', 'حل مشكلة صعبة', clock.today());
    const client = { users: { fetch: async () => ({ send: async () => {} }) } };
    // reply مطلوب لأن الاعتماد مرّ تكراراً والثاني يردّ نتيجة لا تُحدّث الرسالة.
    // deferUpdate/editReply/followUp: decide يؤجّل قبل النشر في staff-wins ثم ينهي
    // بـ editReply، وثاني نداء يقع على حارس «تمت مراجعته» فيصير followUp لأن
    // التفاعل صار مُقرَّراً. البصمة الناقصة كانت تُسقط الاختبار بـ TypeError
    // لا بفشل سلوك.
    const interaction = {
      user: { id: 'manager' }, channelId: 'review', client,
      update: async () => {}, reply: async () => {}, followUp: async () => {},
      async deferUpdate() { this.replied = true; this.deferred = true; },
      async editReply() { assert(this.replied, 'editReply بلا تأجيل'); },
    };
    await recognition.components['recognition:approve'](interaction, [String(result.lastInsertRowid)]);
    const nomination = getDb().prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(nomination.status, 'approved');
    // الاعتماد لا يكتب نقاطاً إطلاقاً — لا دفتر ولا عمود. يبقى points_awarded صفراً دائماً.
    assert.equal(nomination.points_awarded, 0);
    // الاعتماد الثاني لا يفعل شيئاً: الحالة لا تعود إلى pending.
    await recognition.components['recognition:approve'](interaction, [String(result.lastInsertRowid)]);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM recognition_nominations WHERE id = ? AND reviewed_by = ?').get(result.lastInsertRowid, 'manager').c, 1);
  });

  test('يقبل استئناف الإنذار ويلغي أثره من العد', async () => {
    seedStaff('warned', 'moderation', 'Moderator');
    const warning = getDb().prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)').run('warned', 'formal', 'سبب', 'manager');
    const appeal = getDb().prepare('INSERT INTO warning_appeals (warning_id, user_id, reason) VALUES (?, ?, ?)').run(warning.lastInsertRowid, 'warned', 'لدي دليل');
    const client = { users: { fetch: async () => ({ send: async () => {} }) } };
    const interaction = { user: { id: 'manager-2' }, channelId: 'review', client, update: async () => {} };
    await appeals.components['appeal:approve'](interaction, [String(appeal.lastInsertRowid)]);
    const row = getDb().prepare('SELECT * FROM warnings WHERE id = ?').get(warning.lastInsertRowid);
    const reviewed = getDb().prepare('SELECT * FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid);
    assert.ok(row.voided_at);
    assert.equal(reviewed.status, 'approved');
    // الإنذار الملغى لا يُحتسب في Score — وهذا أثره الفعلي بعد إزالة نظام النقاط.
    assert.equal(reports.getRaw('warned').warnings, 0);
  });

  test('يحسب حمل الفريق من التكتات والإجراءات ويستبعد التجربة', () => {
    seedStaff('s1', 'support', 'Support');
    seedStaff('s2', 'support', 'Support');
    seedStaff('trial', 'support', 'Helper', 'probation');
    const db = getDb();
    const insert = db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, rating, duration, logged_by, closed_at)
      VALUES (?, 'owner', ?, ?, 5, ?, 'manager', datetime('now', '-1 day'))`);
    insert.run('t1', 's1', 's1', 12);
    insert.run('t2', 's1', 's1', 8);
    const rows = load.teamLoad('support', 7);
    assert.deepEqual(rows.map(r => r.staff.user_id), ['s1', 's2']);
    assert.equal(rows[0].work.closed, 2);
    assert.equal(rows[0].work.avgDuration, 10);
    assert.deepEqual(load.fairness(rows).idle, ['s2']);
  });
});

describe('المرحلة 4 — التشغيل والمراقبة', () => {
  test('يبقي قناة staff-wins اختيارية ولا يخفض اكتمال الإعداد', () => {
    assert.equal(settings.CHANNEL_KEYS.includes('staff-wins'), false);
    settings.setChannel('staff-wins', '123456');
    assert.equal(settings.channelId('staff-wins'), '123456');
    assert.equal(settings.status().channelsTotal, settings.CHANNEL_KEYS.length);
  });

  test('يعرض healthz وmetrics حالة المهام وقاعدة البيانات', () => {
    const scheduler = { status: () => ({ daily: { finishedAt: '2026-09-18 09:00:00', ok: true, error: null } }) };
    const snapshot = health.snapshot(scheduler);
    assert.equal(snapshot.status, 'ok');
    assert.equal(snapshot.database.sizeMb, 0);
    assert.equal(snapshot.failedJobs.length, 0);
    assert.match(health.metrics(scheduler), /staff_manager_uptime_seconds/);
    assert.match(health.metrics(scheduler), /job_last_run_ok\{job="daily"\} 1/);
  });
});
