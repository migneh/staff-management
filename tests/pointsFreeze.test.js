'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const points = require('../src/services/points');
const supportRatings = require('../src/services/supportRatings');
const clock = require('../src/clock');

beforeEach(() => openMemoryDb());

function seedStaff(id) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since)
    VALUES (?, ?, 'support', 'Support', 'active', '2020-01-01 00:00:00')`).run(id, id);
}

test('freeze/isFrozen/unfreeze — الميكانيكا: صف واحد، بدائل لا تراكم، انقضاء عند القراءة (D1)', () => {
  seedStaff('u1');
  const fr = points.freeze('u1', 14, 'إنذار أول سبب');
  assert.match(fr.until, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, 'الانتهاء طابع بطول ثابت');

  let f = points.isFrozen('u1');
  assert.equal(f.frozen, true);
  assert.equal(f.until, fr.until);
  assert.match(f.reason, /إنذار أول/);

  // تجميد جديد يلغي القديم بدل التراكب: صف واحد دائماً والسؤال جواب واحد
  const fr2 = points.freeze('u1', 7, 'إمضاء أحدث');
  const rows = getDb().prepare(`SELECT user_id, COUNT(*) n FROM point_freezes GROUP BY user_id`).all();
  assert.equal(rows.length, 1, 'صف واحد لكل عضو');
  f = points.isFrozen('u1');
  assert.equal(f.until, fr2.until, 'الإمضاء الأحدث هو الحاكم');

  // الانقضاء عند القراءة لا بمهمة تنظيف: طلب قديم فترةً صارت ماضية
  getDb().prepare(`UPDATE point_freezes SET until = '2000-01-01 00:00:00' WHERE user_id = 'u1'`).run();
  f = points.isFrozen('u1');
  assert.equal(f.frozen, false, 'طلما انقضى لا يجمّد بعد اليوم');
  assert.equal(f.expired, true, 'الانقضاء يُقرأ، فالرسالة لا تكذب');

  // الرفع يزيل؛ ولا يزيل مرتين
  assert.equal(points.unfreeze('u1'), true);
  assert.equal(points.unfreeze('u1'), false, 'لا تكرار رفع');
  assert.equal(points.isFrozen('u1').frozen, false);
});

test('freeze — التجميد يقفز المكسب من المنبع: add ترفض والتاريخ يبقى (D1)', () => {
  seedStaff('u2');
  const before = points.getBalance('u2');
  points.freeze('u2', 7, 'تجربة');
  const r = points.add({ userId: 'u2', reasonKey: 'chat_help', refType: 'chat', refId: 'x1', addedBy: 'auto' });
  assert.equal(r.ok, false, 'مجمّد لا يكسب لا يُهمَل بصمت');
  assert.ok(r.until, 'الرفض يحمل حتى متى التجميد — الفراغ الصامت يُمنع');
  assert.match(r.reason, /مجم/, 'reason يذكر التجميد');
  assert.equal(points.getBalance('u2'), before, 'التراكم متوقف والرصيد القائم لم يُمس.');
});

test('supportRatings — ثلاث تقييمات سلبية في أسبوع تجمد 7 أيام، واثنتان لا (D1)', () => {
  seedStaff('u3');
  const ratingStamp = `${clock.today()} 12:00:00`;
  const mk = (i) => ({
    guildId: 'g', messageId: `m${i}`, channelId: 'c', botId: 'b',
    reviewerId: 'r-x', staffId: 'u3', stars: 2,
    ratedAt: ratingStamp,
  });
  // ٢ سلبية: لا تجميد
  assert.equal(supportRatings.record(mk(1)).saved, true);
  assert.equal(supportRatings.record(mk(2)).saved, true);
  assert.equal(points.isFrozen('u3').frozen, false, 'ليس بعد العتبة');

  // الثالثة تُجمّد — العتبة تنطلق عند الوصول لا عن انتظار الرابعة
  assert.equal(supportRatings.record(mk(3)).saved, true);
  const f = points.isFrozen('u3');
  assert.equal(f.frozen, true, 'الثالثة في الأسبوع بلغت العتبة');
  assert.match(f.reason, /ثلاث تقييمات سلبية/, 'سبب التجميد واقعي باسمه');

  // الرابعة في نفس النافذة تعيد اختيار الحدّ (بدل لا تتراكم صفوفاً)
  assert.equal(supportRatings.record(mk(4)).saved, true);
  const rows = getDb().prepare(`SELECT COUNT(*) n FROM point_freezes WHERE user_id = 'u3'`).get().n;
  assert.equal(rows, 1, 'صف واحد لا تراكم');
});
