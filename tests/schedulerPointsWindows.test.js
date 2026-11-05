'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const scheduler = require('../src/scheduler');
const retention = require('../src/services/retention');
const settings = require('../src/services/settings');

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

test('absencePenalty subtracts once per episode, not once per day (D9)', async () => {
  await withDate('2026-03-15T12:00:00.000Z', async () => {
    // المصدر الدائم staff_members.last_activity، والصف بالسجل المقلَّم يقف
    // معه طبيعياً (كل رسالة إداري تدسّ العمودين معاً).
    getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, last_activity)
      VALUES ('gone-user', 'gone-user', 'support', 'Support', 'active', '2020-01-01 00:00:00', '2026-02-20 12:00:00')`).run();
    getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('gone-user', 'work', 'chat', 1, '2026-02-20', '2026-02-20 12:00:00')`).run();

    await scheduler.absencePenalty({}); // يوم الكشف الأول: خصم واحد
    await scheduler.absencePenalty({}); // إعادة تشغيل في نفس اليوم: لا جديد
    await withDate('2026-03-16T12:00:00.000Z', async () => {
      await scheduler.absencePenalty({}); // اليوم التالي: نفس الفترة → لا خصم ثانٍ
    });

    const rows = getDb().prepare(`SELECT ref_id, points FROM promotion_points
      WHERE user_id = 'gone-user' AND reason_key = 'absence_10d'`).all();
    assert.equal(rows.length, 1, 'صف واحد لكل فترة غياب مهما تعددت أيام الكشف');
    assert.equal(rows[0].ref_id, '2026-02-20', 'الإمضاء آخر يوم نشاط لا تاريخ اليوم');
    assert.equal(rows[0].points, -50, 'خصم الفترة الواحد');
  });
});

test('تقليم activity_logs لا يذيب هويّة فترة غياب قُضي فيها (D9 ضد عُزَّر الاحتفاظ)', async () => {
  await withDate('2026-03-15T12:00:00.000Z', async () => {
    // فترة فعّالة قديمة: آخر نشاط ديسمبر 2025 في الجدول المقلَّم وفي العمود الدائم معاً
    getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, joined_at, last_activity)
      VALUES ('pruned-user', 'pruned-user', 'support', 'Support', 'active', '2020-01-01 00:00:00', '2025-01-10 09:00:00', '2025-12-20 18:00:00')`).run();
    getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
      VALUES ('pruned-user', 'work', 'chat', 1, '2025-12-20', '2025-12-20 18:00:00')`).run();

    await scheduler.absencePenalty({}); // الفترة الأولى: إمضاء آخر نشاط حقيقي

    // التقليم الشهري (حد الاحتفاظ شهراً) يصادر كل صفوف العضو الغائب — وهو ما
    // كان يجعل MAX(day) يتبخر والهوية تنتقل إلى joined_at فتُخصم الفترة مرة ثالثة.
    const pruned = retention.pruneActivity({ months: 1 });
    assert.equal(pruned.deleted, 1);

    await withDate('2026-03-16T12:00:00.000Z', () => scheduler.absencePenalty({}));
    await withDate('2026-03-17T12:00:00.000Z', () => scheduler.absencePenalty({}));

    const rows = getDb().prepare(`SELECT ref_id, points FROM promotion_points
      WHERE user_id = 'pruned-user' AND reason_key = 'absence_10d'`).all();
    assert.equal(rows.length, 1, 'فترة حُسِبت بإمضاء دائم لا تُعاد عند عُزَّر الاحتفاظ');
    assert.equal(rows[0].ref_id, '2025-12-20', 'الإمضاء بعد التقليم ما زال آخر يوم نشاط لا تاريخ الدخول المصادر');
    assert.equal(rows[0].points, -50);
  });
});

test('never-active member: penalty anchored at onboarding, stable across days (D9)', async () => {
  await withDate('2026-03-15T12:00:00.000Z', async () => {
    getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, joined_at)
      VALUES ('fresh-user', 'fresh-user', 'support', 'Support', 'active', '2020-01-01 00:00:00', '2026-01-10 09:00:00')`).run();
    await scheduler.absencePenalty({});
    await withDate('2026-03-16T12:00:00.000Z', async () => {
      await scheduler.absencePenalty({});
    });
    const rows = getDb().prepare(`SELECT ref_id FROM promotion_points
      WHERE user_id = 'fresh-user' AND reason_key = 'absence_10d'`).all();
    assert.equal(rows.length, 1, 'بلا نشاط قط: الإمضاء تاريخ الدخول الثابت لا نافذة متحركة');
    assert.equal(rows[0].ref_id, '2026-01-10');
  });
});

test('monthlyBest evaluates and awards the complete previous month at a year boundary', async () => {  await withDate('2026-01-01T12:00:00.000Z', async () => {
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

// ===== بوابة الملاحظة (الإصلاح الجديد): عضو حديث/ضليل مستهلك لا يُعاقب =====

/** عميل وهمي يلتقط الرسائل الخاصة والتحذيرات القنوية نصياً. */
function stubClient() {
  const dms = [];
  const alerts = [];
  const capture = (bag) => (payload) => {
    if (payload && payload.embeds && payload.embeds[0]) bag.push(`${payload.embeds[0].data?.title || ''}\n${payload.embeds[0].data?.description || ''}`);
    return Promise.resolve();
  };
  return {
    dms, alerts,
    users: { fetch: async () => ({ send: capture(dms) }) },
    channels: { fetch: async () => ({ send: capture(alerts) }) },
  };
}

/** إداري مسجَّل بتاريخ دخول نعرفه وآخر نشاط (اختياري) بالأيام قبل اليوم. */
function joinedMember(id, { joinedDaysAgo = 0, lastActivityDaysAgo = null, at = '2026-03-15' } = {}) {
  const dayAt = (d, daysAgo) => {
    const dt = new Date(`${d}T12:00:00.000Z`);
    dt.setUTCDate(dt.getUTCDate() - daysAgo);
    return dt.toISOString().replace('T', ' ').slice(0, 19);
  };
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, joined_at, last_activity)
    VALUES (?, ?, 'support', 'Support', 'active', '2020-01-01 00:00:00', ?, ?)`)
    .run(id, id, dayAt(at, joinedDaysAgo), lastActivityDaysAgo === null ? null : dayAt(at, lastActivityDaysAgo));
}

test('بوابة الملاحظة: عضو جديد يوم 0 و13 لا تخصمه عقوبة الغياب إطلاقاً', async () => {
  await withDate('2026-03-15T12:00:00.000Z', async () => {
    joinedMember('day0-user', { joinedDaysAgo: 0 });
    joinedMember('day13-user', { joinedDaysAgo: 13 });
    await scheduler.absencePenalty({});
    const rows = getDb().prepare(`SELECT COUNT(*) c FROM promotion_points WHERE reason_key = 'absence_10d'`).get().c;
    assert.equal(rows, 0, 'العضو غير المُلاحَظ العتبة كاملة لا سجل له لا خصم');
  });
});

test('يوم 14 بعد الدخول: صف واحد بالضبط بإمضاء تاريخ الدخول', async () => {
  await withDate('2026-03-15T12:00:00.000Z', async () => {
    joinedMember('day14-user', { joinedDaysAgo: 14 });
    const client = stubClient();
    await scheduler.absencePenalty(client);
    const rows = getDb().prepare(`SELECT ref_id, points FROM promotion_points WHERE reason_key = 'absence_10d' AND user_id = 'day14-user'`).all();
    assert.equal(rows.length, 1, 'يوم 14 بالضبط هو أول يوم عقوبة');
    assert.equal(rows[0].ref_id, '2026-03-01', 'الإمضاء تاريخ الدخول 2026-03-15 ناقص 14');
    assert.equal(rows[0].points, -50);
    // النصوص تُظهر العتبة المضبوطة (14) لا القيمة الصالحة القديمة
    const said = [...client.dms, ...client.alerts].join('\n');
    assert.match(said, /14 أيام/, 'خصم العتبة الحية 14 في رسالة التنبيه');
    assert.doesNotMatch(said, /منذ \*\*10 أيام/, 'لا أثر للعتبة الصالحة 10 في النصوص');
  });
});

test('عتبة قابلة للضبط: صمت 5 أيام يقبل العقوبة بعد خفضها إلى 3 وتُنصَّ بالرقم', async () => {
  try {
    await withDate('2026-03-15T12:00:00.000Z', async () => {
      // آخر نشاط قبل 5 أيام: أقل من العتبة الافتراضية 14
      joinedMember('quiet-user', { joinedDaysAgo: 60, lastActivityDaysAgo: 5 });
      await scheduler.absencePenalty({});
      let rows = getDb().prepare(`SELECT COUNT(*) c FROM promotion_points WHERE reason_key = 'absence_10d' AND user_id = 'quiet-user'`).get().c;
      assert.equal(rows, 0, '5 أيام صمت دون العتبة الافتراضية 14 → لا عقوبة');

      // خفض العتبة إلى 3: صمت 5 أيام يقبلها فتنطبق العقوبة
      settings.setPolicy('absenceDays', 3);
      const client = stubClient();
      await scheduler.absencePenalty(client);
      rows = getDb().prepare(`SELECT ref_id FROM promotion_points WHERE reason_key = 'absence_10d' AND user_id = 'quiet-user'`).all();
      assert.equal(rows.length, 1, 'خفض العتبة إلى 3 يجعل صمت 5 أيام خاضعاً للعقوبة');
      assert.equal(rows[0].ref_id, '2026-03-10', 'الإمضاء آخر يوم نشاط لا تاريخ الدخول');
      const said = [...client.dms, ...client.alerts].join('\n');
      assert.match(said, /3 أيام/, 'النصوص تعرض العتبة المضبوطة 3');
    });
  } finally {
    settings.resetPolicy('absenceDays');
  }
});

test('قيمة سياسة غريبة تعود إلى الافتراضي والقيمة المنطقية تُقيَّد داخل 3–60', async () => {
  try {
    assert.equal(settings.absenceDays(), 14, 'بلا إعداد: 14');
    settings.setPolicy('absenceDays', 'ما لا يعده');
    assert.equal(settings.absenceDays(), 14, 'نص عشوائي → الافتراضي 14');
    settings.setPolicy('absenceDays', 100);
    assert.equal(settings.absenceDays(), 60, 'الحد العلوي يدفع 100 إلى 60');
    settings.setPolicy('absenceDays', 1);
    assert.equal(settings.absenceDays(), 3, 'الحد الأدنى يدفع 1 إلى 3');
    settings.resetPolicy('absenceDays');
    assert.equal(settings.absenceDays(), 14, 'إعادة الضبط تعود إلى الافتراضي');
  } finally {
    settings.resetPolicy('absenceDays');
  }
});
