'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const clock = require('../src/clock');
const cmd = require('../src/commands/promotion-progress');

const IDS_A = '160001';
const IDS_B = '160002';

// عتبة النقاط في بطاقة /promotion-progress: يجب أن تحكم بهيئتها الفهنية
// (العتبة الانتقالية المخفَّضة خلال نافذة الستين يوماً) كما في بوابة الترقية
// و/my-points — لا بالقيمة الخام القادمة بعد النافذة التي لن تعمل إلا بعدها.

// حالة الاختبار السابق لا تُحمل إلى ما بعده — إبطال صريح لمفتاح النافذة الانتقالية
beforeEach(() => {
  openMemoryDb();
  settings.resetPolicy('points_epoch_started_at');
});

function seedStaff(id, rank = 'Helper') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
    VALUES (?, ?, 'support', ?, 'active', '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')`)
    .run(id, id, rank);
}

function seedBalance(id, points) {
  getDb().prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, rank_epoch, created_at)
    VALUES (?, ?, 'faq_contrib', 'مقال معرفة', 0, datetime('now'))`).run(id, points);
}

async function cardFor(id) {
  const replies = [];
  await cmd.commands[0].execute({
    user: { id }, options: { getBoolean: () => false },
    reply: async p => { replies.push(p); },
  });
  return replies[0].embeds[0].toJSON();
}

describe('عتبة النقاط في /promotion-progress', () => {
  test('نافذة الانتقال: البطاقة تحكم بعتبة اليوم المخفَّضة ومنشرةَ صراحةً بأيام بقائها (Helper: 66 بدل 200)', async () => {
    seedStaff(IDS_A);
    seedBalance(IDS_A, 70); // يجاوز عتبة اليوم الفهنية (66) دون العتبة الخام (200)
    settings.setPolicy('points_epoch_started_at', clock.addDays(clock.today(), -10));

    const card = await cardFor(IDS_A);
    const pointsField = card.fields.find(f => f.name.includes('نقاط الترقية'));
    assert.ok(pointsField, 'حقل نقاط الترقية موجود');
    assert.match(pointsField.value, /عتبة انتقالية/, 'الحالة الانتقالية معلنة صريحة كما في البوابة و/my-points');
    assert.match(pointsField.value, /الكاملة/, 'العتبة الكاملة القادمة معلنة بعدَ إقفال النافذة');
    assert.match(pointsField.value, /66/, 'عتبة اليوم الفهنية 66 (max(⌊200·10/60⌋=33، ثلث العتبة=66)) بأرقام غربية');
    assert.match(pointsField.value, /بعد 50 يوم/, 'عدد الأيام المتبقٍية من النافذة (60-10)');
    assert.match(pointsField.value, /200/, 'العتبة الكاملة (200) ظاهرة كمرجع لا كحاجز');
    assert.match(pointsField.value, /70/, 'رصيد العضو بأرقام غربية');
  });

  test('بلا نافذة انتقالية: العتبة الكاملة كما هي — علامة انتقالية لا تُختلق', async () => {
    seedStaff(IDS_B);
    seedBalance(IDS_B, 70);
    // points_epoch_started_at غير مضبوط → يوم null → العتبة الكاملة non-transitional

    const card = await cardFor(IDS_B);
    const pointsField = card.fields.find(f => f.name.includes('نقاط الترقية'));
    assert.ok(pointsField);
    assert.doesNotMatch(pointsField.value, /عتبة انتقالية/, 'لا وسم انتقالة حين غابت الانطلاقة');
    assert.match(pointsField.value, /200/, 'العتبة الخام في صورتها الكاملة');
    assert.match(pointsField.value, /70/);
  });
});
