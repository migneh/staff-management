'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const scheduler = require('../src/scheduler');

const RealDate = Date;
async function withDate(iso, fn) {
  const fixed = new RealDate(iso);
  global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fixed])); }
    static now() { return fixed.getTime(); }
  };
  try { return await fn(); } finally { global.Date = RealDate; }
}

beforeEach(() => openMemoryDb());

function staff(id, team = 'support') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since)
    VALUES (?, ?, ?, ?, 'active', '2020-01-01 00:00:00')`)
    .run(id, id, team, team === 'support' ? 'Support' : 'Moderator');
}

test('dailyPresence awards the just-ended local day, not the new day', async () => {
  withDate('2026-03-01T21:30:00.000Z', async () => {
    staff('daily-user');
    const activity = getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES (?, 'work', 'chat', 1, ?, ?)`);
    activity.run('daily-user', '2026-03-01', '2026-03-01 20:00:00');
    activity.run('daily-user', '2026-03-02', '2026-03-01 21:00:00');
    await scheduler.dailyPresence({});
    const rows = getDb().prepare(`SELECT ref_id FROM promotion_points WHERE user_id = 'daily-user'`).all();
    assert.deepEqual(rows.map(r => r.ref_id), ['2026-03-01']);
  });
});

test('monthlyBest evaluates and awards the complete previous month at a year boundary', async () => {
  await withDate('2026-01-01T12:00:00.000Z', async () => {
    staff('month-user');
    const activity = getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('month-user', 'work', 'chat', 1, ?, ?)`);
    for (let day = 1; day <= 20; day++) {
      const date = `2025-12-${String(day).padStart(2, '0')}`;
      activity.run(date, `${date} 12:00:00`);
    }
    getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch, created_at)
      VALUES ('month-user', 12, 'faq_contrib', 'seed', 'seed', 'month-seed', 0, '2025-12-15 12:00:00')`).run();
    await scheduler.monthlyBest({});
    const award = getDb().prepare(`SELECT ref_id, created_at FROM promotion_points WHERE reason_key = 'best_month'`).get();
    assert.ok(award, 'the qualifying previous-month member should be awarded');
    assert.equal(award.ref_id, '2025-12-01');
    assert.match(award.created_at, /^2026-/);
  });
});
