'use strict';
/**
 * ثلاث عيوب في المجدول، جميعها من نوع «يبدو ناجحاً»:
 *
 *  C2 — إشعار الغياب 72 ساعة كان غير قابل للوصول. `if (staff96) … else if (dm72) …`
 *       يجعل من يُرصد أول مرة عند 100 ساعة يأخذ فرع التنبيه الإداري، فيُرفع إلى
 *       المستوى 2 ولا تصله الرسالة التي تعده بطريقة تقديم طلب إجازة. يحدث عند
 *       كل إعادة تشغيل بوت فيها غائب >96 ساعة، وعند كل انقطاع لمهمة الغياب >24 ساعة.
 *
 *  C3 — تذكير المهمة المتأخرة يُعاد إلى الأبد. `utils.dm()` يبتلع كل خطأ
 *       ويعيد false، و`reminder_sent_at` يبقى NULL، فمهمة واحدة لعضو مغلق
 *       الرسائل = نداء API ميّت كل يوم الساعة 08:00 بلا نهاية وبلا أثر.
 *
 *  P8 — `status()` كان 1 + N استعلامات على مسار /healthz.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const staffService = require('../src/services/staff');
const settings = require('../src/services/settings');
const leaveService = require('../src/services/leaves');
const taskService = require('../src/services/tasks');
const scheduler = require('../src/scheduler');
const health = require('../src/health');
const { today } = require('../src/utils');

/** عميل مزيف: رسالة خاصة تنجح أو تفشل حسب `dmFails`، وقنوات تُحصى. */
function fakeClient({ dmFails = false } = {}) {
  const sent = { dm: [], channel: {}, dmCalls: 0 };
  const client = {
    users: {
      fetch: async () => ({
        send: async (payload) => {
          sent.dmCalls++;                       // dm() يبتلع الخطأ: عدّادنا هو الدليل
          if (dmFails) throw new Error('Cannot send messages to this user');
          sent.dm.push({ payload });
          return { id: '1' };
        },
      }),
    },
    channels: {
      fetch: async (id) => ({
        send: async (payload) => { sent.channel[id] = (sent.channel[id] || 0) + 1; sent.channel.last = payload; return { id: '1' }; },
        id,
      }),
    },
  };
  return { client, sent };
}

function seedMember(id, { hoursSinceActivity, level = 0, status = 'active' } = {}) {
  const db = getDb();
  const stamp = db.prepare("SELECT datetime('now', ?) v").get(`-${hoursSinceActivity} hours`).v;
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, last_activity, absence_alert_level)
    VALUES (?, ?, 'support', 'Support', ?, ?, ?)`).run(id, id, status, stamp, level);
  return staffService.get(id);
}

beforeEach(() => {
  openMemoryDb();
  settings.resetFeatureToggles();
  settings.setChannel('staff-alerts', 'alerts-chan');
  settings.setChannel('staff-logs', 'logs-chan');
});

describe('C2 — إشعار الغياب 72 ساعة يُرسَل حتى مع تنبيه الإداري', () => {
  const dmTitle = (payload) => JSON.stringify(payload || {}).includes('تنبيه غياب');
  const alertTitle = (payload) => JSON.stringify(payload || {}).includes('غياب 96 ساعة');

  test('أول رصد عند 100 ساعة: الرسالة الخاصة للتنبيه الإداري معاً، لا أحدهما بدل الآخر', async () => {
    const m = seedMember('a100', { hoursSinceActivity: 100, level: 0 });
    const { client, sent } = fakeClient();

    await scheduler.checkAbsence(client);

    assert.ok(dmTitle(sent.dm[0]?.payload), `لم تصل رسالة 72 ساعة: ${JSON.stringify(sent.dm)}`);
    assert.ok(alertTitle(sent.channel.last), 'لم يصل تنبيه الإدارة');
    assert.equal(sent.channel['alerts-chan'], 1, 'تنبيه الإدارة أُرسل أكثر من مرّة');
    assert.equal(staffService.get(m.user_id).absence_alert_level, 2, 'المستوى الإداري لم يُحدَّث');
    assert.ok(staffService.get(m.user_id).absence_dm_sent_at, 'لم يُسجَّل أن رسالة 72 ساعة رُسلت');
  });

  test('عند 73 ساعة: الرسالة الخاصة فقط، بلا تنبيه إداري', async () => {
    seedMember('a73', { hoursSinceActivity: 73, level: 0 });
    const { client, sent } = fakeClient();
    await scheduler.checkAbsence(client);
    assert.equal(sent.dm.length, 1, 'لم تصل رسالة 72 ساعة عند 73 ساعة');
    assert.ok(dmTitle(sent.dm[0].payload));
    assert.ok(!alertTitle(sent.channel.last), 'تنبيه 96 ساعة أُرسل عند 73 ساعة');
  });

  test('عند 95 ساعة: الرسالة الخاصة فقط، بلا تنبيه إداري', async () => {
    seedMember('a95', { hoursSinceActivity: 95, level: 0 });
    const { client, sent } = fakeClient();
    await scheduler.checkAbsence(client);
    assert.equal(sent.dm.length, 1);
    assert.ok(!alertTitle(sent.channel.last), 'تنبيه 96 ساعة أُرسل عند 95 ساعة');
  });

  test('لا تكرار: الدورة التالية عند 100 ساعة لا تعيد إرسال شيء', async () => {
    seedMember('a100b', { hoursSinceActivity: 100, level: 0 });
    const { client, sent } = fakeClient();
    await scheduler.checkAbsence(client);
    await scheduler.checkAbsence(client);
    assert.equal(sent.dm.length, 1, 'رسالة 72 ساعة أُرسلت مرتين');
    assert.equal(sent.channel['alerts-chan'], 1, 'تنبيه الإدارة أُرسل مرتين');
  });

  test('عودة النشاط تصفّر العلمين معاً، فالحلقة التالية تبدأ من جديد', async () => {
    // العلامة القديمة كانت absence_alert_level وحده:_services/staff.js touchActivity
    // يصفّره (وهي ليست ملفنا)، فأي علامة جديدة بلا مالكها تبقى معلّقة إلى الأبد.
    const m = seedMember('a_back', { hoursSinceActivity: 100 });
    const { client, sent } = fakeClient();
    await scheduler.checkAbsence(client);
    assert.ok(staffService.get(m.user_id).absence_dm_sent_at);

    staffService.touchActivity(m.user_id);                 // العائد ينشط من جديد
    await scheduler.checkAbsence(client);
    assert.equal(staffService.get(m.user_id).absence_dm_sent_at, null,
      'علامة الرسالة الخاصة بقيت بعد عودة النشاط — لن تتلقى رسالة 72 ساعة أبداً مرة أخرى');
    assert.equal(staffService.get(m.user_id).absence_alert_level, 0);
    assert.equal(sent.dm.length, 1, 'جرى إرسال أثناء hoursSince < 72');

    // ثم يغيب من جديد 100 ساعة: يجب أن تصل الرسالة مرة أخرى.
    getDb().prepare("UPDATE staff_members SET last_activity = datetime('now', '-100 hours') WHERE user_id = ?").run(m.user_id);
    await scheduler.checkAbsence(client);
    assert.equal(sent.dm.length, 2, 'الحلقة الجديدة لم ترسل رسالة 72 ساعة');
  });

  test('من هو في إجازة أو موقوف لا يُرسَل إليه شيء', async () => {
    const m = seedMember('onleave', { hoursSinceActivity: 100 });
    getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status)
      VALUES (?, 'normal', 'r', '2020-01-01', '2099-01-01', 'approved')`).run(m.user_id);
    assert.ok(leaveService.activeForUser(m.user_id).length, 'الإجازة ليست فعّالة — الاختبار لا يثبت شيئاً');
    const { client, sent } = fakeClient();
    await scheduler.checkAbsence(client);
    assert.equal(sent.dm.length, 0, 'رسالة غياب لمُجاز');
    assert.equal(sent.channel['alerts-chan'] || 0, 0, 'تنبيه غياب لمُجاز');
  });
});

describe('C3 — تذكير المهمة له حدّ محاولات ونهاية مرئية', () => {
  const overdueOnboarding = (id) => taskService.create({
    userId: id, title: 'مهمة تأهيل', taskType: 'onboarding', dueDate: today(), assignedBy: 'system',
  });

  test('عضو رسائله مغلقة: يتوقف التذكير بعد الحدّ ويُسجَّل الاستسلام', async () => {
    const task = overdueOnboarding('closed');
    const { client, sent } = fakeClient({ dmFails: true });
    const max = scheduler.TASK_REMINDER_MAX_ATTEMPTS;

    for (let run = 1; run < max; run++) {
      await scheduler.processTaskReminders(client);
      assert.equal(taskService.get(task.id).reminder_attempts, run, `المحاولة ${run} لم تُسجَّل`);
      assert.equal(taskService.get(task.id).reminder_given_up_at, null, `استُسلم قبل الحد (${run})`);
    }

    // المحاولة الأخيرة تُنهي السلسلة بدل أن تتركها معلّقة.
    await scheduler.processTaskReminders(client);
    const givenUp = taskService.get(task.id);
    assert.equal(givenUp.reminder_attempts, max);
    assert.ok(givenUp.reminder_given_up_at, 'لا أثر للاستسلام — التذكير اختفى بصمت');
    assert.equal(givenUp.reminder_sent_at, null);

    // ومن بعد ذلك لا نداءات أخرى: بلا نهاية.
    const callsBefore = sent.dmCalls;
    const processed = await scheduler.processTaskReminders(client);
    assert.equal(processed, 0, 'المهمة المعطوبة ما زالت تُختار');
    assert.equal(sent.dmCalls, callsBefore, `جرى ${sent.dmCalls - callsBefore} نداء رسالة خاصة بعد الاستسلام`);
    assert.equal(sent.channel['alerts-chan'] || 0, 1, 'الاستسلام لم يُعلَن للإدارة');
  });

  test('نجاح المحاولة الثانية: ليس مُستسلماً ولا متروكاً', async () => {
    const task = overdueOnboarding('opens_late');
    let calls = 0;
    const client = {
      users: {
        fetch: async () => ({
          send: async () => {
            calls++;
            if (calls === 1) throw new Error('Cannot send messages to this user');
            return { id: '1' };
          },
        }),
      },
      channels: { fetch: async () => ({ send: async () => ({ id: '1' }) }) },
    };

    await scheduler.processTaskReminders(client);
    assert.equal(taskService.get(task.id).reminder_sent_at, null);
    await scheduler.processTaskReminders(client);

    const after = taskService.get(task.id);
    assert.equal(after.reminder_attempts, 2);
    assert.ok(after.reminder_sent_at, 'نجاح المحاولة الثانية لم يُثبَّت');
    assert.equal(after.reminder_given_up_at, null, 'ناجٍ وُسم مستسلماً');
    assert.equal(await scheduler.processTaskReminders(client), 0, 'المهمة المُبلَّغ بنجاح ما زالت تُختار');
  });

  test('الاستسلام مرئي للإدارة: رسالة في قناة التنبيهات وسطر في سجل التدقيق', async () => {
    const task = overdueOnboarding('audited');
    const { client, sent } = fakeClient({ dmFails: true });
    for (let i = 0; i <= scheduler.TASK_REMINDER_MAX_ATTEMPTS; i++) await scheduler.processTaskReminders(client);

    assert.equal(sent.channel['alerts-chan'], 1, 'لا إشعار استسلام في قناة الإدارة');
    const body = JSON.stringify(sent.channel.last);
    assert.match(body, /audited/, 'الإشعار لا يذكر من تعذّر الوصول إليه');
    assert.match(body, new RegExp(String(task.id)), 'الإشعار لا يذكر رقم المهمة');
    const audited = getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='task_reminder_given_up'").get().c;
    assert.equal(audited, 1, 'لا أثر في سجل التدقيق');
    assert.equal(scheduler.reminderGiveUps().length, 1, 'الاستسلام غير معروض في قائمة يقرأها المشغّل');
  });

  test('قائمة الاستسلام لا تكرّر stesso المهمة كل يوم', async () => {
    const task = overdueOnboarding('listed');
    const { client } = fakeClient({ dmFails: true });
    for (let i = 0; i <= scheduler.TASK_REMINDER_MAX_ATTEMPTS + 2; i++) await scheduler.processTaskReminders(client);
    assert.deepEqual(scheduler.reminderGiveUps().map(t => t.id), [task.id]);
  });
});

describe('P8 — status() استعلام واحد على مسار /healthz', () => {
  test('مهما بلغ عدد المهام: جملة واحدة', () => {
    const db = getDb();
    for (const job of ['absence', 'leaves', 'backup', 'weekly-report', 'maintenance']) {
      db.prepare('INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 1)')
        .run(job, '2026-09-18 09:00:00', '2026-09-18 09:00:01');
      db.prepare('INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 0)')
        .run(job, '2026-09-25 09:00:00', '2026-09-25 09:00:01');
    }

    let statements = 0;
    const prepare = db.prepare.bind(db);
    const exec = db.exec.bind(db);
    db.prepare = (sql) => { statements++; return prepare(sql); };
    db.exec = (sql) => { statements++; return exec(sql); };
    try {
      const last = scheduler.status();
      assert.equal(statements, 1, `status() نفّذت ${statements} جمل — مسار الصحة لا يفعل 11× عمله`);
      assert.deepEqual(Object.keys(last).sort(), ['absence', 'backup', 'leaves', 'maintenance', 'weekly-report']);
      // آخر صف لكل مهمة هو الفاشل (MAX(id)) — لا الأول.
      assert.equal(last.absence.ok, false, 'لم يُقرأ آخر تشغيل الفاشل للمهمة');
      assert.equal(last.leaves.ok, false);
      assert.equal(last.leaves.finishedAt, '2026-09-25 09:00:01');
      assert.equal(last[scheduler.SCHEMA_FAULT_JOB], undefined, 'قاعدة بلا أعطال أدرجت مهمة مخطط وهمية');
    } finally {
      db.prepare = prepare;
      db.exec = exec;
    }
  });

  test('نتيجة status() كما يراها /healthz: العطل في المخطط يقلب الحالة إلى degraded', () => {
    // هذا هو شرط «يقلع صامتاً بدل أن يرفض الإقلاع»: العطل يُقرأ من مسار الصحة.
    const db = getDb();
    db.prepare('INSERT INTO job_runs (job, started_at, finished_at, ok) VALUES (?, ?, ?, 1)')
      .run('absence', '2026-09-18 09:00:00', '2026-09-18 09:00:01');
    assert.equal(health.snapshot(scheduler).status, 'ok', 'قاعدة سليمة يجب أن تكون ok');

    db.prepare(`INSERT INTO schema_faults (step, kind, detail, remediation) VALUES (?, 'data', ?, ?)`)
      .run('ticket_source_unique', 'تكرار في ticket_metrics.source_message_id', 'DELETE FROM ticket_metrics WHERE ...');

    const snapshot = health.snapshot(scheduler);
    assert.equal(snapshot.status, 'degraded', 'عطل مخطط لم يخفض الحالة — المشغّل لا يعرف');
    assert.ok(snapshot.failedJobs.includes(scheduler.SCHEMA_FAULT_JOB), 'العطل غير معروف لـ /healthz');
    assert.match(JSON.stringify(snapshot), /ticket_source_unique/, 'التفاصيل لا تذكر الخطوة');
  });
});