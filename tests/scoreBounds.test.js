'use strict';
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const points = require('../src/services/points');
const clock = require('../src/clock');

beforeEach(() => {
  openMemoryDb();
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES ('member-1', 'u1', 'support', 'Helper', 'active')`).run();
});

describe('دفتر نقاط الترقية', () => {
  test('يسجّل المنحة ويمنع تكرار المرجع', () => {
    const grant = points.add({ userId: 'member-1', reasonKey: 'faq_contrib', refType: 'faq', refId: 'faq-1' });
    assert.equal(grant.ok, true);
    assert.equal(grant.points, 5);
    assert.equal(points.getBalance('member-1'), 5);

    const duplicate = points.add({ userId: 'member-1', reasonKey: 'faq_contrib', refType: 'faq', refId: 'faq-1' });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(points.getBalance('member-1'), 5);
  });

  test('يسمح بالمرجع المشترك نفسه لمستخدمين مختلفين', () => {
    getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
      VALUES ('member-2', 'u2', 'support', 'Helper', 'active')`).run();
    const first = points.add({ userId: 'member-1', reasonKey: 'star_week', refType: 'week', refId: '2026-W42' });
    const second = points.add({ userId: 'member-2', reasonKey: 'star_week', refType: 'week', refId: '2026-W42' });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(getDb().prepare('PRAGMA index_info(idx_points_unique_user_ref)').all().map(c => c.name),
      ['user_id', 'reason_key', 'ref_type', 'ref_id']);
  });

  test('يفرض سقفاً يومياً وأسبوعياً ثابتاً على نقاط التكتات', () => {
    const db = getDb();
    const insertAward = db.prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch, created_at)
      VALUES ('member-1', ?, 'ticket_close', 'ticket', 'ticket', ?, 0, ?)`);
    // «ظهيرة» الرياض = 09:00 UTC (UTC+3): البذرة داخل يوم الرياض الحقيقي
    // لا داخل يوم UTC — والحدوس الرياضية هي عقود dayWindow (علة 2026-10-25).
    insertAward.run(20, 'prior-day', `${clock.today()} 09:00:00`);
    const dailyDenied = points.add({ userId: 'member-1', reasonKey: 'ticket_close', refType: 'ticket', refId: 'today-ticket' });
    assert.equal(dailyDenied.ok, false);
    assert.equal(dailyDenied.reason, 'سقف يومي للتكتات');

    db.prepare(`DELETE FROM promotion_points WHERE ref_id = 'prior-day'`).run();
    insertAward.run(60, 'prior-week', `${clock.addDays(clock.today(), -3)} 09:00:00`);
    const weeklyDenied = points.add({ userId: 'member-1', reasonKey: 'ticket_close', refType: 'ticket', refId: 'week-ticket' });
    assert.equal(weeklyDenied.ok, false);
    assert.equal(weeklyDenied.reason, 'سقف أسبوعي للتكتات');
  });

  test('يحسب الرصيد على حقبة الرتبة الحالية فقط', () => {
    // البذرة القديمة بنصف إبانها — يوم مضى — كي لا تقع في نافذة «اليوم» التي
    // يجمع فيها عدّاد السقف اليومي (faq_contrib أصبح سقفه منذ تقرير التدقيق).
    const past = clock.dayWindow(clock.addDays(clock.today(), -2), clock.addDays(clock.today(), -2)).start;
    getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, rank_epoch, created_at)
      VALUES ('member-1', 40, 'faq_contrib', 'old epoch', 'faq', 'old-1', 0, ?)`).run(past);
    getDb().prepare(`UPDATE staff_members SET rank_epoch = 1 WHERE user_id = 'member-1'`).run();

    assert.equal(points.getBalance('member-1'), 0);
    const grant = points.add({ userId: 'member-1', reasonKey: 'faq_contrib', refType: 'faq', refId: 'new-1' });
    assert.equal(grant.ok, true, `يجب المنح: ${grant.reason}`);
    assert.equal(grant.balance, 5);
    assert.equal(points.getBalance('member-1'), 5);
  });
});
