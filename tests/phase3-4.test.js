'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const score = require('../src/services/score');
const load = require('../src/services/load');
const reports = require('../src/services/reports');
const settings = require('../src/services/settings');
const points = require('../src/services/points');
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
    const current = score.monthlyRaw(staff.user_id, 7);
    const previous = score.monthlyRaw(staff.user_id, 7, 7);
    assert.equal(current.messages, 1);
    assert.equal(previous.messages, 1);
    const trend = reports.personalTrend(staff);
    assert.equal(trend.currentActiveDays, 1);
    assert.equal(trend.previousActiveDays, 1);
  });

  test('يطبق أوزان Score المخصصة مع مجموع ثابت من 100', () => {
    const staff = seedStaff('weighted', 'support', 'Support');
    settings.setScoreWeights('support', { tickets: 50, speed: 10, chat: 20, presence: 20 });
    const result = score.compute(staff, { messages: 200, activeDays: 26, tickets: 50, avgDuration: 4, avgRating: 4.6 });
    assert.deepEqual(result.factors.map(f => f.max), [50, 10, 20, 20]);
    assert.equal(result.assessedMax, 100);
    assert.equal(result.score, 100);
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

  test('يعتمد ترشيح التقدير ويمنح نقاطه مرة واحدة', async () => {
    seedStaff('nominator', 'support', 'Support');
    seedStaff('winner', 'support', 'Support');
    const result = getDb().prepare('INSERT INTO recognition_nominations (nominator_id, target_id, reason) VALUES (?, ?, ?)').run('nominator', 'winner', 'حل مشكلة صعبة');
    const client = { users: { fetch: async () => ({ send: async () => {} }) } };
    const interaction = { user: { id: 'manager' }, channelId: 'review', client, update: async () => {} };
    await recognition.components['recognition:approve'](interaction, [String(result.lastInsertRowid)]);
    const nomination = getDb().prepare('SELECT * FROM recognition_nominations WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(nomination.status, 'approved');
    assert.equal(nomination.points_awarded, 5);
    assert.equal(getDb().prepare("SELECT SUM(points) total FROM promotion_points WHERE user_id = 'winner'").get().total, 5);
  });

  test('يقبل استئناف الإنذار ويلغي أثره من العد والنقاط', async () => {
    seedStaff('warned', 'moderation', 'Moderator');
    const warning = getDb().prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)').run('warned', 'formal', 'سبب', 'manager');
    const ledger = points.add('warned', 'formal_warning', 'moderation', { refType: 'warning', refId: warning.lastInsertRowid, addedBy: 'manager' });
    const appeal = getDb().prepare('INSERT INTO warning_appeals (warning_id, user_id, reason) VALUES (?, ?, ?)').run(warning.lastInsertRowid, 'warned', 'لدي دليل');
    const client = { users: { fetch: async () => ({ send: async () => {} }) } };
    const interaction = { user: { id: 'manager-2' }, channelId: 'review', client, update: async () => {} };
    await appeals.components['appeal:approve'](interaction, [String(appeal.lastInsertRowid)]);
    const row = getDb().prepare('SELECT * FROM warnings WHERE id = ?').get(warning.lastInsertRowid);
    const reviewed = getDb().prepare('SELECT * FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid);
    assert.ok(row.voided_at);
    assert.equal(reviewed.status, 'approved');
    assert.equal(score.monthlyRaw('warned').warnings, 0);
    assert.equal(points.total('warned'), ledger + (-ledger));
  });

  test('يحفظ اعتراض النقاط كمهمة إدارة ولا يظهر كمهمة عادية للعضو', () => {
    seedStaff('appeal', 'support', 'Support');
    const point = points.add('appeal', 'ticket_closed', 'support', { refType: 'ticket', refId: 'T-1', addedBy: 'manager' });
    assert.equal(point, 2);
    const history = points.history('appeal', 10);
    assert.equal(history[0].reason_key, 'ticket_closed');
    const task = taskService.create({ userId: 'appeal', title: 'اعتراض على حركة النقاط #1', description: 'سبب', taskType: 'points_appeal', assignedBy: 'appeal' });
    assert.equal(taskService.listByType('points_appeal').length, 1);
    assert.equal(taskService.pendingCount('appeal'), 0);
    assert.equal(taskService.list('appeal').length, 0);
    assert.equal(taskService.complete(task.id, 'appeal'), null);
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
