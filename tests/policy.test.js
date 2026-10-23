'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const staffService = require('../src/services/staff');
const retention = require('../src/services/retention');
const promotions = require('../src/services/promotions');
const { LEVELS, SUPPORT_PROMOTIONS, MOD_PROMOTIONS, INACTIVE_STATUSES } = require('../src/constants');
const { COMPONENT_ACCESS, commands, resolveComponent, validateRegistry } = require('../src/commands');

beforeEach(() => openMemoryDb());

function seedStaff(id, team, rank, extra = {}) {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'u' + id, team, rank, extra.status || 'active', extra.since || '2025-01-01 00:00:00', extra.since || '2025-01-01 00:00:00', extra.last || '2026-09-12 00:00:00');
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

describe('الساعة (clock)', () => {
  test('يحسب اليوم بتوقيت المنطقة الزمنية لا UTC', () => {
    // 22:30 UTC = 01:30 في الرياض من اليوم التالي
    assert.equal(clock.dayOf(new Date('2026-09-17T22:30:00Z')), '2026-09-18');
    assert.equal(clock.dayOf(new Date('2026-09-17T20:59:00Z')), '2026-09-17');
  });
  test('addDays يعبر الشهر والسنة والسنة الكبيسة', () => {
    assert.equal(clock.addDays('2026-09-25', 10), '2026-10-05');
    assert.equal(clock.addDays('2026-01-01', -1), '2025-12-31');
    assert.equal(clock.addDays('2024-02-28', 1), '2024-02-29');
    assert.equal(clock.addDays('ليس-تاريخاً', 1), null);
  });
  test('previousMonth وisValidDate', () => {
    assert.equal(clock.previousMonth('2026-01'), '2025-12');
    assert.equal(clock.previousMonth('2026-03'), '2026-02');
    assert.equal(clock.isValidDate('2026-02-30'), false);
    assert.equal(clock.isValidDate('2026-02-28'), true);
  });
  test('الطابع الزمني المتوافق مع SQLite', () => {
    assert.match(clock.nowIso(), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });
});

describe('أمان المكوّنات (الصلاحيات المركزية)', () => {
  test('كل مكوّن معلن وله معالج، ولا تعارض في البادئات', () => {
    assert.deepEqual(validateRegistry(), []);
  });
  test('المكونات الحساسة محمية بالمستوى الصحيح', () => {
    const mustBeManagement = ['promo:reject', 'promo:rejectmodal', 'faq:hist', 'leave:pending', 'leave:details'];
    for (const id of mustBeManagement) {
      assert.ok(COMPONENT_ACCESS[id], `غير معلن: ${id}`);
      assert.ok(COMPONENT_ACCESS[id].level >= LEVELS.MANAGEMENT, `${id} يجب أن يكون للإدارة العليا`);
    }
    assert.equal(resolveComponent('setup:roles').entry.adminOnly, true);
  });
  test('الراوتر يفكك المعاملات ويُعيد null لما لا معالج له', () => {
    assert.deepEqual(resolveComponent('promo:reject:12').args, ['12']);
    assert.equal(resolveComponent('unknown:x'), null);
    assert.ok(commands.has('system-status'));
  });
});

describe('بوابات الترقية ونصابها', () => {
  test('مستوى الموافقة لكل ترقية متسق مع من أُعلن', () => {
    const gates = Object.fromEntries([...SUPPORT_PROMOTIONS, ...MOD_PROMOTIONS].map(r => [`${r.from}→${r.to}`, r]));
    // Admin في فريق الإشراف = مستوى 3، فلا يكفي لبوابة مستوى 4
    assert.equal(gates['Admin→Head Of Moderators'].approvalLevel, LEVELS.MANAGEMENT);
    assert.equal(gates['Admin→Head Of Moderators'].approvals, 2);
    assert.equal(gates['Senior Moderator→Admin'].approvalLevel, LEVELS.MANAGEMENT);
    assert.equal(gates['Trial Moderator→Moderator'].approvalLevel, LEVELS.SUPERVISOR);
    assert.equal(gates['Supervisor Manager→Support Office'].approvalLevel, LEVELS.BOSS);
    // كل ترقية معلنة بتوقيعين يجب أن تمر ببوابة الإدارة العليا على الأقل
    for (const r of Object.values(gates)) {
      if (r.approvals > 1) assert.ok(r.approvalLevel >= LEVELS.MANAGEMENT, `${r.from}→${r.to}: توقيعان ببوابة أدنى`);
    }
  });
  test('نصاب الموافقات: صوت واحد لكل شخص، والترقية لا تكتمل قبل النصاب', () => {
    const s = seedStaff('m1', 'moderation', 'Moderator', { since: '2024-01-01 00:00:00' });
    const ev = { rule: promotions.nextPromotion(s), checks: [] };
    const id = promotions.createRequest(s, ev, 'طلب');
    assert.equal(promotions.approvalsCount(id), 0);
    assert.equal(promotions.recordApproval(id, 'boss1').count, 1);
    const again = promotions.recordApproval(id, 'boss1');
    assert.equal(again.recorded, false, 'نفس الشخص لا يصوّت مرتين');
    assert.equal(again.count, 1);
    assert.equal(promotions.recordApproval(id, 'boss2').count, 2);
    assert.equal(promotions.approvalsList(id).length, 2);
    promotions.review(id, 'approved', 'boss2', null);
    assert.equal(promotions.getRequest(id).status, 'approved');
  });
  test('شرط تقييم المشرف مانع حقيقي، والتقييم القديم لا يُحتسب', () => {
    const s = seedStaff('h1', 'support', 'Helper', { since: '2024-01-01 00:00:00' });
    let check = promotions.evaluate(s).checks.find(c => c.label === 'تقييم المشرف');
    assert.ok(check, 'الشرط يجب أن يظهر في التقييم');
    assert.equal(check.pass, false);
    assert.equal(promotions.evaluate(s).eligible, false);

    const db = getDb();
    const stale = clock.addDays(clock.today(), -(promotions.RATING_VALID_DAYS + 30));
    db.prepare("UPDATE staff_members SET supervisor_rating = 20, human_ratings_at = ? WHERE user_id = 'h1'").run(`${stale} 00:00:00`);
    check = promotions.evaluate(staffService.get('h1')).checks.find(c => c.label === 'تقييم المشرف');
    assert.equal(check.pass, false, 'التقييم الأقدم من المدة لا يُحتسب');
    assert.match(check.actual, /قديم/);

    db.prepare('UPDATE staff_members SET human_ratings_at = ? WHERE user_id = ?').run(`${clock.today()} 00:00:00`, 'h1');
    check = promotions.evaluate(staffService.get('h1')).checks.find(c => c.label === 'تقييم المشرف');
    assert.equal(check.pass, true, 'التقييم الحديث يُحتسب');
  });
  test('الأداء المستقر يُقرأ من التقارير الشهرية المحفوظة', () => {
    seedStaff('s9', 'support', 'Support Analyst', { since: '2024-01-01 00:00:00' });
    const db = getDb();
    const save = (period, points) => db.prepare(`INSERT INTO saved_reports (report_type, period, data) VALUES ('monthly', ?, ?)`)
      .run(period, JSON.stringify({ members: [{ user: 's9', points }] }));
    save('2026-06', 80); save('2026-07', 75); save('2026-08', 72);
    const st = promotions.stability('s9', 3, 70);
    assert.equal(st.passed, true);
    assert.deepEqual(st.periods, ['2026-08', '2026-07', '2026-06']);
    // تقرير واحد ضعيف يُسقط الشرط
    save('2026-05', 40);
    assert.equal(promotions.stability('s9', 4, 70).passed, false);
  });
});

describe('تاريخ الرتب وعصور النقاط (Phase 2)', () => {
  test('تغيير الرتبة يُوثَّق: من، إلى، من نفّذ، ولماذا', () => {
    seedStaff('m2', 'moderation', 'Senior Moderator', { since: '2024-01-01 00:00:00' });
    const res = staffService.setRank('m2', 'moderation', 'Admin', { actorId: 'BOSS1', reason: 'ترقية معتمدة (طلب #7)', changeType: 'promote' });
    assert.equal(res.fromRank, 'Senior Moderator');
    assert.equal(res.changeType, 'promote');
    const [row] = staffService.rankHistory('m2');
    assert.equal(row.from_rank, 'Senior Moderator');
    assert.equal(row.to_rank, 'Admin');
    assert.equal(row.actor_id, 'BOSS1');
    assert.match(row.reason, /طلب #7/);
    assert.equal(staffService.get('m2').rank, 'Admin');
    assert.ok(staffService.get('m2').rank_since);
  });
});

describe('صيانة البيانات (Phase 2)', () => {
  test('الأشهر القديمة تُحذف نهائياً ولا يبقى منها جدول شهري', () => {
    const db = getDb();
    const ins = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES ('u','1','staff',0.25,?)`);
    for (let d = 1; d <= 10; d++) ins.run(`2024-01-${String(d).padStart(2, '0')}`);
    for (let d = 1; d <= 3; d++) ins.run(`${clock.today().slice(0, 7)}-0${d}`);

    const dry = retention.run({ dryRun: true });
    assert.equal(dry.activity.pending, 10, 'المعاينة تعرض ما سيُحذف');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c, 13, 'المعاينة لا تحذف شيئاً');
    assert.equal('rollup' in dry, false, 'حقل التجميع المُلغى عاد إلى التقرير');

    const r = retention.run({ dryRun: false });
    assert.equal(r.activity.deleted, 10, 'الصفوف الأقدم من الحدّ لم تُحذف');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c, 3, 'يبقى النشاط داخل النافذة');
    // جدول التجميع الشهري أُلغي: غائب من المخطط الحيّ بعد أي مسار تشغيل
    const monthly = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_monthly'").get();
    assert.equal(monthly, undefined, 'activity_monthly ما زال موجوداً رغم إلغائه');
  });
  test('التقليم يعمل على سجل العمليات فقط بعد المدة المحددة', () => {
    const db = getDb();
    db.prepare("INSERT INTO audit_logs (action, created_at) VALUES ('old', '2020-01-01 00:00:00')").run();
    db.prepare("INSERT INTO audit_logs (action) VALUES ('new')").run();
    const r = retention.pruneAudit({ dryRun: false });
    assert.equal(r.deleted, 1);
    assert.deepEqual(db.prepare('SELECT action FROM audit_logs').all().map(x => x.action), ['new']);
  });
});

describe('دورة الاستقالة وإعادة التعيين', () => {
  test('التفاعل العابر لا يعيد مفعول استقالة بإزالة رتب مؤجلة', () => {
    const settings = require('../src/services/settings');
    settings.setRole('support', 'Support', 'support-role');
    seedStaff('resigned-user', 'support', 'Support', { status: 'resigned' });
    const member = {
      id: 'resigned-user',
      user: { username: 'resigned-user' },
      roles: { cache: new Map([['support-role', { id: 'support-role' }]]) },
    };
    assert.equal(staffService.ensure(member).status, 'resigned');
    assert.equal(staffService.get('resigned-user').status, 'resigned');
    assert.equal(staffService.ensure(member, { reinstate: true }).status, 'active');
  });
});

describe('الإيقاف المؤقت', () => {
  test('يُرفع تلقائياً عند انتهاء المدة ويُبلّغ بالقائمة', () => {
    seedStaff('u1', 'support', 'Support');
    seedStaff('u2', 'support', 'Support');
    staffService.suspend('u1', '2026-09-10');
    staffService.suspend('u2', clock.addDays(clock.today(), 5));
    const lifted = staffService.liftExpiredSuspensions('2026-09-11');
    assert.deepEqual(lifted.map(l => l.user_id), ['u1']);
    assert.equal(staffService.get('u1').status, 'active');
    assert.equal(staffService.get('u1').suspended_until, null);
    assert.equal(staffService.get('u2').status, 'suspended');
    // لا يُرفع مرتين
    assert.equal(staffService.liftExpiredSuspensions('2026-09-11').length, 0);
  });
  test('الإزالة والمغادرة تُوثَّق في تاريخ الرتب', () => {
    seedStaff('u4', 'moderation', 'Admin');
    const dep = staffService.markLeft('u4');
    assert.equal(dep.previous, 'active');
    const [row] = staffService.rankHistory('u4');
    assert.equal(row.change_type, 'left_guild');
    assert.equal(row.from_rank, 'Admin');
    assert.match(row.reason, /غادر/);
    assert.ok(staffService.REMOVAL_TYPES.includes('left_guild'));
  });
  test('المغادرة ونزع الرتب تُحدّث الحالة بدل بقائها نشطة', () => {
    seedStaff('u3', 'support', 'Support');
    const left = staffService.markLeft('u3');
    assert.equal(left.previous, 'active');
    assert.equal(staffService.get('u3').status, 'removed');
    assert.equal(staffService.markLeft('u3'), null, 'لا تكرار');
    assert.ok(INACTIVE_STATUSES.includes('removed'));
  });
});
