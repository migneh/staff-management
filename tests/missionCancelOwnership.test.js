'use strict';
/**
 * Tests for mission cancel ownership.
 *
 * The ownerId check already existed in tasks.cancel (optional arg appended to
 * WHERE, mirroring complete()), but the only caller in the codebase was
 * `missions.cancel(Number(id), i.user.id)`: the actor in the second slot,
 * ownerId never passed — so the scope was decorative.
 *
 * Practical result: mission:cancel is registered at MANAGEMENT with no
 * owner:'self' (src/commands/index.js:50), so any manager could cancel any
 * member's pending task.
 *
 * Oversight of other members' tasks is intended and is preserved here. What is
 * not intended is cancelling an **onboarding** task owned by someone else:
 * approveOnboarding (src/services/tasks.js:306) counts pending rows only, so
 * cancelling the last pending onboarding task drops it out of the count the
 * gate reads.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openMemoryDb, getDb } = require('../src/database');
const tasks = require('../src/services/tasks');
const { commands, resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');

const ME = '1005171993940852796';
const PEER = '1490787800168005713';
const BOSS = '223456789012345678';

const TASKS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'tasks.js'), 'utf8');
const MISSIONS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'missions.js'), 'utf8');

function seedStaff(id, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Support', ?)
    ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, onboarding_ready = 0`).run(id, id, status);
}

const row = id => getDb().prepare('SELECT * FROM staff_tasks WHERE id = ?').get(Number(id));
const memberRow = id => getDb().prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);

/** Fake interaction swallowing reply/update/followUp, same shape as ownershipScope.test.js */
function interaction({ id, level = LEVELS.MANAGEMENT, team = 'moderation', rank = 'Head Of Moderators', customId = '' } = {}) {
  const calls = { reply: [], update: [], followUp: [] };
  const i = {
    customId, user: { id, tag: id }, guildId: '1', channelId: '2',
    client: {
      channels: { fetch: async () => ({ send: async p => ({ id: '1', payload: p }) }) },
      users: { fetch: async () => ({ send: async () => {} }) },
    },
    staffLevel: level, staffInfo: { team, level },
    member: { id, permissions: { has: () => false }, roles: { cache: new Map() } },
    options: { getUser: () => null, getString: () => null },
    calls,
    async reply(p) { calls.reply.push(p); return p; },
    async update(p) { calls.update.push(p); return p; },
    async followUp(p) { calls.followUp.push(p); return p; },
  };
  return i;
}
const text = calls => JSON.stringify(calls.reply.concat(calls.update).map(c => {
  const embeds = (c.embeds || []).map(e => { const d = e.toJSON ? e.toJSON() : e; return `${d.title || ''} ${d.description || ''}`; }).join(' ');
  return `${c.content || ''} ${embeds}`;
}));

beforeEach(() => { openMemoryDb(); });

describe('tasks.cancel — an onboarding task is protected from non-owner cancel', () => {
  test('management cannot cancel another member\'s onboarding task', () => {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    const target = tasks.list(PEER, { taskType: 'onboarding' })[0];

    const res = tasks.cancel(target.id, BOSS, PEER);

    assert.equal(res.ok, false, 'a foreign onboarding task was cancelled');
    assert.equal(row(target.id).status, 'pending', 'the row was cancelled anyway');
    assert.equal(row(target.id).cancelled_by, null, 'cancelled_by recorded an actor that did not act');
  });

  test('refusal reason is specific: onboarding_protected, not a false success or not_found', () => {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    const target = tasks.list(PEER, { taskType: 'onboarding' })[0];

    const res = tasks.cancel(target.id, BOSS, PEER);

    assert.equal(res.reason, 'onboarding_protected');
  });

  test('the owner can cancel their own onboarding task, attributed to them', () => {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    const target = tasks.list(PEER, { taskType: 'onboarding' })[0];

    const res = tasks.cancel(target.id, PEER, PEER);

    assert.equal(res.ok, true);
    assert.equal(row(target.id).status, 'cancelled');
    assert.equal(row(target.id).cancelled_by, PEER);
    assert.ok(row(target.id).cancelled_at, 'no cancel timestamp recorded');
  });

  test('a missing or non-pending task fails with no side effect', () => {
    seedStaff(PEER);
    const done = tasks.create({ userId: PEER, title: 'done', taskType: 'general' });
    tasks.complete(done.id, PEER);

    assert.equal(tasks.cancel(999999, PEER, PEER).reason, 'not_found');
    assert.equal(tasks.cancel(done.id, PEER, PEER).reason, 'not_pending');
    assert.equal(row(done.id).status, 'completed');
  });
});

describe('oversight of other members\' tasks is preserved', () => {
  test('management can cancel a mission task belonging to another member', () => {
    seedStaff(PEER);
    const t = tasks.create({ userId: PEER, title: 'mission task', taskType: 'mission', assignedBy: BOSS });

    const res = tasks.cancel(t.id, BOSS, PEER);

    assert.equal(res.ok, true, 'oversight of non-onboarding tasks must stay possible');
    assert.equal(row(t.id).status, 'cancelled');
    assert.equal(row(t.id).cancelled_by, BOSS);
  });

  test('component mission:cancel from management on a non-onboarding task succeeds', async () => {
    seedStaff(PEER);
    const t = tasks.create({ userId: PEER, title: 'mission task', taskType: 'mission' });
    const i = interaction({ id: BOSS, customId: `mission:cancel:${t.id}` });

    await resolveComponent(`mission:cancel:${t.id}`).handler(i, [String(t.id)]);

    assert.equal(row(t.id).status, 'cancelled');
    assert.equal(i.calls.update.length, 1, 'the message was not updated on success');
  });

  test('component mission:cancel on a foreign onboarding task is refused', async () => {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    const target = tasks.list(PEER, { taskType: 'onboarding' })[0];
    const i = interaction({ id: BOSS, customId: `mission:cancel:${target.id}` });

    await resolveComponent(`mission:cancel:${target.id}`).handler(i, [String(target.id)]);

    assert.equal(row(target.id).status, 'pending', 'the button cancelled a foreign onboarding task');
    assert.equal(i.calls.update.length, 0, 'it reported success');
    assert.match(text(i.calls), /تأهيل/);
  });

  test('the button still works on the actor\'s own onboarding task', async () => {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    const target = tasks.list(PEER, { taskType: 'onboarding' })[0];
    const i = interaction({ id: PEER, level: LEVELS.MANAGEMENT, customId: `mission:cancel:${target.id}` });

    await resolveComponent(`mission:cancel:${target.id}`).handler(i, [String(target.id)]);

    assert.equal(row(target.id).status, 'cancelled');
    assert.equal(i.calls.update.length, 1);
  });
});

describe('cancelling an onboarding task cannot open the probation→active gate', () => {
  /** Member finished onboarding (onboarding_ready=1), then an extra pending onboarding task blocks approval */
  async function memberBlockedFromApproval() {
    seedStaff(PEER, 'probation');
    tasks.ensureOnboarding(PEER);
    for (const t of tasks.list(PEER, { taskType: 'onboarding' })) tasks.complete(t.id, PEER);
    assert.equal(memberRow(PEER).onboarding_ready, 1, 'the member never became ready');
    const blocker = tasks.create({ userId: PEER, title: 'read the new policy', taskType: 'onboarding', assignedBy: BOSS });
    return blocker;
  }

  const approve = async () => {
    const i = interaction({ id: BOSS, customId: 'approve-onboarding' });
    i.options = { getUser: () => ({ id: PEER }), getString: () => null };
    await commands.get('approve-onboarding').execute(i);
    return text(i.calls);
  };

  test('before any cancel: approval is refused while an onboarding task is pending', async () => {
    await memberBlockedFromApproval();
    assert.match(await approve(), /لم تكتمل مهام التأهيل/);
    assert.equal(memberRow(PEER).status, 'probation');
  });

  test('a management cancel does not remove the task from the approval count', async () => {
    const blocker = await memberBlockedFromApproval();
    const i = interaction({ id: BOSS, customId: `mission:cancel:${blocker.id}` });

    await resolveComponent(`mission:cancel:${blocker.id}`).handler(i, [String(blocker.id)]);

    assert.equal(row(blocker.id).status, 'pending', 'the pending count would drain to zero');
    assert.match(await approve(), /لم تكتمل مهام التأهيل/, 'approval went through with an unfinished onboarding task');
    assert.equal(memberRow(PEER).status, 'probation', 'the member was promoted to active');
  });

  test('the onboarding dashboard stops claiming every task is done after the refusal', async () => {
    const blocker = await memberBlockedFromApproval();
    const i = interaction({ id: BOSS, customId: `mission:cancel:${blocker.id}` });
    await resolveComponent(`mission:cancel:${blocker.id}`).handler(i, [String(blocker.id)]);

    const dash = interaction({ id: BOSS, customId: 'onboarding:dashboard' });
    dash.options = { getSubcommand: () => 'dashboard', getUser: () => ({ id: PEER }) };
    await commands.get('onboarding').execute(dash);

    const shown = JSON.stringify(dash.calls.reply[0].embeds[0].toJSON());
    assert.ok(!shown.includes('جميع مهام التأهيل مكتملة'), 'the dashboard claimed completion falsely');
  });
});

describe('source contract: the check lives in the service, the caller passes the owner', () => {
  test('tasks.cancel inspects task_type before writing — not only in the UPDATE WHERE', () => {
    const body = TASKS_SRC.slice(TASKS_SRC.indexOf('function cancel('), TASKS_SRC.indexOf('module.exports'));
    assert.ok(/task_type\s*===\s*'onboarding'/.test(body), 'no task_type check inside cancel');
    assert.ok(/const task = get\(id\)/.test(body), 'cancel does not read the row through get() first');
    assert.ok(/task\.status\s*!==\s*'pending'/.test(body), 'cancel does not reject a non-pending row');
    assert.ok(!/DELETE/i.test(body), 'cancel deletes');
  });

  test('the single caller in missions.js passes the task owner through', () => {
    const call = MISSIONS_SRC.match(/missions\.cancel\([^)]*\)/);
    assert.ok(call, 'missions.cancel is no longer called');
    assert.ok(/,\s*i\.user\.id\s*,\s*task\.user_id\s*\)/.test(call[0]),
      `ownerId is not passed: ${call[0]} — the ownership scope in the service stays inert`);
  });

  test('ME exists so the fixture constants are not accidental duplicates', () => {
    assert.notEqual(ME, PEER);
    assert.notEqual(ME, BOSS);
  });
});
