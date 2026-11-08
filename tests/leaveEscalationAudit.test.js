'use strict';
/**
 * سجل التدقيق يجب أن يقول ما حدث فعلاً.
 *
 * كان المجدول يسجّل `leave_escalated` (صُعّد الطلب) قبل أن يعرف هل وصل
 * التنبيه إلى قناة leave-requests أصلاً. `sendToChannel` في utils.js يُعيد
 * null عند الفشل (قناة محذوفة، أو خطأ في الإرسال) — فكان السطر يُكتب
 * «صُعّد» بينما لم يُرسل شيء، فيقرأ المراجع سجلاً يدّعي تصعيداً لم يحدث،
 * ولا يجد في السجل ما يفسّر why الطلب ما زال معلّقاً.
 *
 * القاعدة: نجاح الإرسال ← leave_escalated. فشله ← leave_escalation_failed
 * (سطر واحد بالضبط)، ولا يُكتب leave_escalated إطلاقاً. سياسة إعادة
 * المحاولة (claimReminder) لم تتغيّر: الفشل يُسجَّل ولا يُعاد الإرسال.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const scheduler = require('../src/scheduler');
const { today, addDays } = require('../src/utils');

const USER = 'u-escalation';
const D = (offset) => addDays(today(), offset);

/** عميل ديسكورد وهمي: `channelMode` يتحكم في مصير الإرسال إلى القنوات. */
function makeClient({ channelMode = 'ok' } = {}) {
  const state = { channels: [], dms: [] };
  const client = {
    channels: {
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          if (channelMode === 'throw') throw new Error('Missing Access');
          if (channelMode === 'null') return null; // فشل إرسال يعيد null
          state.channels.push({ channel: id, payload });
          return { id: `m${state.channels.length}` };
        },
      }),
    },
    users: { fetch: async (id) => ({ id, send: async (p) => { state.dms.push({ user: id, payload: p }); return true; } }) },
  };
  return { client, state };
}

function seedPendingLeave() {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, 'tester', 'support', 'Support', 'active')`)
    .run(USER);
  const res = db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status, created_at)
    VALUES (?, 'normal', 'سبب', ?, ?, 'pending', datetime('now', '-30 hours'))`).run(USER, D(5), D(6));
  return Number(res.lastInsertRowid);
}

const countAudit = (action) => getDb().prepare('SELECT COUNT(*) c FROM audit_logs WHERE action = ?').get(action).c;
const escalationRows = () => getDb().prepare("SELECT * FROM audit_logs WHERE action IN ('leave_escalated', 'leave_escalation_failed')").all();

beforeEach(() => {
  openMemoryDb();
  scheduler.clearRunningTasks();
  settings.setChannel('leave-requests', 'C-leave');
  settings.setChannel('staff-alerts', 'C-alerts');
  settings.setChannel('staff-logs', 'C-logs');
});

test('فشل الإرسال: لا leave_escalated، وleave_escalation_failed سطر واحد بالضبط', async () => {
  seedPendingLeave();
  const { client, state } = makeClient({ channelMode: 'null' });

  await scheduler.processLeaves(client);

  assert.equal(countAudit('leave_escalated'), 0, 'سُجّل تصعيد لم يُسلَّم');
  assert.equal(countAudit('leave_escalation_failed'), 1, 'لم يُسجَّل فشل التصعيد — أو سُجّل أكثر من مرة');
  const rows = escalationRows();
  assert.equal(rows.length, 1, 'وقع أكثر من سطر تصعيد لفشل واحد');
  assert.equal(rows[0].action, 'leave_escalation_failed');
  assert.ok(rows[0].details.includes('requestId'), 'السجل لا يربط الفشل بالطلب');
  assert.equal(state.channels.length, 0, 'وصل شيء إلى القناة رغم فشل الإرسال');
});

test('فشل الإرسال بخطأ استثناء: نفس العقد — فشل واحد، لا تصعيد', async () => {
  seedPendingLeave();
  const { client } = makeClient({ channelMode: 'throw' });

  await scheduler.processLeaves(client);

  assert.equal(countAudit('leave_escalated'), 0, 'سُجّل تصعيد رغم رمي الاستثناء');
  assert.equal(countAudit('leave_escalation_failed'), 1, 'الاستثناء لم يُسجَّل كفشل تصعيد واحد');
});

test('نجاح الإرسال: leave_escalated سطر واحد، ولا leave_escalation_failed', async () => {
  seedPendingLeave();
  const { client, state } = makeClient({ channelMode: 'ok' });

  await scheduler.processLeaves(client);

  assert.equal(countAudit('leave_escalated'), 1, 'نجاح الإرسال لم يُسجَّل تصعيداً');
  assert.equal(countAudit('leave_escalation_failed'), 0, 'نُسجِّل فشلاً لم يحدث');
  assert.equal(state.channels.length, 1, 'لم يصل التصعيد إلى القناة');
  assert.ok(state.channels[0].payload.components?.length, 'التصعيد يحمل أزرار المراجعة');
});

test('الجريان معاً: تصعيد ناجح واحد وسطر فشل واحد — بلا خلط بينهما', async () => {
  // طلبان: الأول تُسلَّم قناة escalation له، والثاني تفشل. القناة الواحدة
  // تخدم الطلبين، لكن كل سطر في السجل يجب أن ينتمي إلى طلبه.
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, 'tester', 'support', 'Support', 'active')`)
    .run(USER);
  for (const start of [D(5), D(8)]) {
    db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status, created_at)
      VALUES (?, 'normal', 'سبب', ?, ?, 'pending', datetime('now', '-30 hours'))`).run(USER, start, addDays(start, 1));
  }
  let calls = 0;
  const client = {
    channels: {
      fetch: async (id) => ({
        id,
        send: async () => { calls++; return calls === 1 ? { id: 'm1' } : null; },
      }),
    },
    users: { fetch: async (id) => ({ id, send: async () => true }) },
  };

  await scheduler.processLeaves(client);

  assert.equal(countAudit('leave_escalated'), 1, 'عدد التصعيدات الناجحة خاطئ');
  assert.equal(countAudit('leave_escalation_failed'), 1, 'عدد إخفاقات التصعيد خاطئ');
  const rows = escalationRows();
  assert.equal(rows.length, 2);
  const ids = new Set(rows.map(r => JSON.parse(r.details).requestId));
  assert.equal(ids.size, 2, 'سطران لطلب واحد أو طلب بلا سطر');
});
