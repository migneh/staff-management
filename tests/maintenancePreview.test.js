'use strict';
/**
 * شاشة `/maintenance`: التعداد العربي على شاشة يبني عليها المشغّل قرار حذف
 * غير قابل للتراجع.
 *
 * تاريخياً كان الاختبار يحمي من خلط `months` في تقرير التجميع (صفوف تُطبع
 * كأشهر). وبعد إلغاء التجميع الشهري صارت شاشة المعاينة تعرض الحذف نفسه الذي
 * سيقع: عدد صفوف النشاط الخام أقدم من الحدّ، وتحذيراً صريحاً بأن لا تجميع
 * يحفظها. ثلاث قواعد تُثبَّت هنا:
 *   1) العدد المعروض = عدد الصفوف الفعلي المؤهل للحذف، مكتوباً بصيغته العربية
 *      الصحيحة (سجل واحد / سجلان / N سجلات / N سجلاً) — فالرقم يُبنى عليه قرار.
 *   2) المعاينة لا تحذف شيئاً ولا تنشئ جدولاً، والتنفيذ يتطلب confirm صريحاً.
 *   3) لا جدول شهري: `retention.run()` لا يكتب في `activity_monthly` لأنها
 *      غير موجودة في المخطط أصلاً، والتقرير بلا حقل rollup.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const retention = require('../src/services/retention');
const { commands } = require('../src/commands');

/**
 * البذرة: `MONTHS` شهراً سابقاً *لحدّ التقليم* مباشرة، × `MEMBERS` عضواً
 * × ثلاثة أيام في الشهر. cutoff = cutoffMonth(ACTIVITY_RETENTION_MONTHS=12)
 * → الشهر M-12، والمؤهل هو `day < cutoff-01` أي الشهور الأقدم تماماً:
 * M-13 … M-(12+MONTHS)، فنبذّر 13 شهراً تعطي 13 شهراً متمايزة.
 */
const MEMBERS = 60;
const MONTHS = 13;
const DAYS_PER_MONTH = 3;
const EXPECTED_OLD_ROWS = MEMBERS * MONTHS * DAYS_PER_MONTH; // 2340 صف خام قديم

/** الشهر YYYY-MM بعد إزاحة `back` شهراً للخلف عن الشهر الحالي */
function monthBack(back) {
  const [y, m] = retention.cutoffMonth(0).split('-').map(Number);
  const total = y * 12 + (m - 1) - back;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

function seedSpread() {
  const db = getDb();
  const ins = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
    VALUES (?, 'c', 'staff', 0.25, ?)`);
  const firstEligible = retention.ACTIVITY_RETENTION_MONTHS + 1; // M-13
  db.exec('BEGIN');
  for (let user = 0; user < MEMBERS; user++) {
    for (let k = 0; k < MONTHS; k++) {
      const ym = monthBack(firstEligible + k); // M-13 … M-25
      for (let d = 1; d <= DAYS_PER_MONTH; d++) ins.run(`u${user}`, `${ym}-${String(d).padStart(2, '0')}`);
    }
  }
  db.exec('COMMIT');
}

/** المخطط الحيّ لا يحمل جدول التجميع المُلغى — لا في إنشاء ولا بعد أي كتابة */
function assertMonthlyTableAbsent(db, label) {
  const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='activity_monthly'").get();
  assert.equal(t, undefined, `${label}: activity_monthly موجودة رغم إلغائها`);
}

describe('التقليم بلا تجميع: العدد واحد في المسارين ولا جدول يُنشأ', () => {
  beforeEach(() => { openMemoryDb(); seedSpread(); });

  test('المعاينة: pending = عدد الصفوف القديمة فعلاً، وبدون حقل rollup ولا جدول', () => {
    const r = retention.run({ dryRun: true });
    assert.equal(r.activity.pending, EXPECTED_OLD_ROWS, `pending=${r.activity.pending} المتوقّع ${EXPECTED_OLD_ROWS}`);
    assert.equal(r.activity.deleted, 0, 'المعاينة أعلنت حذفاً لم يقع');
    assert.equal('rollup' in r, false, 'حقل rollup عاد إلى تقرير الصيانة');
    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c, EXPECTED_OLD_ROWS, 'المعاينة حذفت شيئاً');
    assertMonthlyTableAbsent(db, 'المعاينة');
  });

  test('التنفيذ: يحذف العدد نفسه ولا يكتب في أي جدول شهري', () => {
    const dry = retention.run({ dryRun: true });
    const real = retention.run({ dryRun: false });
    assert.equal(real.activity.deleted, dry.activity.pending, `التنفيذ حذف ${real.activity.deleted} والمعاينة أعلنت ${dry.activity.pending}`);
    assert.equal(real.activity.deleted, EXPECTED_OLD_ROWS);
    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c, 0, 'صف قديم نجا من الحذف');
    assert.equal('rollup' in real, false, 'حقل rollup عاد');
    assertMonthlyTableAbsent(db, 'التنفيذ');
    // تقرير الشكل: حقول run() فقط — لا مفتاح مفقود ولا زائد يتوقعه قارئ
    assert.deepEqual(Object.keys(real).sort(), ['activity', 'audit', 'dryRun', 'ops', 'sizeAfterMb', 'sizeBeforeMb', 'vacuumed']);
  });

  test('قاعدة فارغة: الصفر في المسارين — لا عدد زائف ولا جدول يُنشأ للصفر', () => {
    openMemoryDb();
    const dry = retention.run({ dryRun: true });
    assert.equal(dry.activity.pending, 0);
    const real = retention.run({ dryRun: false });
    assert.equal(real.activity.deleted, 0);
    assertMonthlyTableAbsent(getDb(), 'قاعدة فارغة');
  });

  test('عضو واحد عبر MONTHS شهراً: pending = 13 صفاً خاماً — العدّاد صفوف لا مجموعات', () => {
    openMemoryDb();
    const db = getDb();
    const ins = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
      VALUES ('solo', 'c', 'staff', 0.25, ?)`);
    const firstEligible = retention.ACTIVITY_RETENTION_MONTHS + 1;
    for (let k = 0; k < MONTHS; k++) ins.run(`${monthBack(firstEligible + k)}-05`);
    const r = retention.run({ dryRun: true });
    assert.equal(r.activity.pending, MONTHS, `pending=${r.activity.pending} المتوقّع ${MONTHS} — عضو واحد × ${MONTHS} شهراً`);
    assert.equal(r.activity.cutoff, `${monthBack(retention.ACTIVITY_RETENTION_MONTHS)}-01`, 'الحدّ المعروض ليس أول الشهر المحتسب');
  });
});

describe('/maintenance: المعاينة والتنفيذ يقرآن المعنى نفسه', () => {
  beforeEach(() => { openMemoryDb(); seedSpread(); });

  function fakeInteraction(confirm) {
    return {
      user: { id: 'boss1' },
      channelId: 'c1',
      guildId: 'g1',
      replied: false, deferred: false,
      options: { getBoolean: name => (name === 'confirm' ? confirm : null), getString: () => null },
      async deferReply() { this.deferred = true; },
      async editReply(p) { this.payload = p; },
      async reply(p) { this.payload = p; },
    };
  }

  // embed() يُعيد EmbedBuilder — نُسلسله كما تفعل بقية الاختبارات
  const descriptionOf = i => i.payload.embeds[0].toJSON().description;
  /** العدد المكتوب بصيغة «N سجلاً» في أي من الشاشتين */
  const pruneCountShown = text => {
    const m = text.match(/(?:سيُحذف|حُذف) \*\*(\d+) سجلاً\*\*/);
    return m ? Number(m[1]) : null;
  };

  test('معاينة /maintenance تعرض الحذف الحقيقي: 2340 سجلاً وتحذيراً، لا وعداً بتجميع', async () => {
    const i = fakeInteraction(false);
    await commands.get('maintenance').execute(i);
    const desc = descriptionOf(i);
    assert.ok(desc, 'لم يُرسَم الرد');
    assert.equal(pruneCountShown(desc), EXPECTED_OLD_ROWS,
      `الشاشة تعرض ${pruneCountShown(desc)} بدل ${EXPECTED_OLD_ROWS}:\n${desc}`);
    // حدّ الحذف معلن تاريخياً — المشغّل يرى ماذا يعني «أقدم من»
    assert.match(desc, /أقدم من \d{4}-\d{2}-01/, `لا يظهر حدّ الحذف بالتاريخ:\n${desc}`);
    // لا وعد تجميع — التجميع أُلغي ومنعه منعاً صريحاً
    assert.doesNotMatch(desc, /ستُجمَّع|جُمّع/, `الشاشة ما زالت تعد بتجميع مُلغى:\n${desc}`);
    // تحذير الحذف النهائي وشرط التنفيذ صريحان
    assert.match(desc, /غير قابل للتراجع/, `تحذير الحذف النهائي مفقود:\n${desc}`);
    assert.match(desc, /confirm: true/, `شرط التنفيذ الصريح مفقود:\n${desc}`);
    // لا يُحذف شيء في المعاينة ولا يُنشأ جدول
    const db = getDb();
    assert.equal(db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c, EXPECTED_OLD_ROWS);
    assertMonthlyTableAbsent(db, 'معاينة /maintenance');
  });

  test('معاينة وتنفيذ: نفس العدد في الشاشتين، والتنفيذ يحذف فعلاً', async () => {
    const dry = fakeInteraction(false);
    await commands.get('maintenance').execute(dry);
    const real = fakeInteraction(true);
    await commands.get('maintenance').execute(real);
    const d = pruneCountShown(descriptionOf(dry));
    const r = pruneCountShown(descriptionOf(real));
    assert.equal(d, EXPECTED_OLD_ROWS, `معاينة=${d}`);
    assert.equal(r, EXPECTED_OLD_ROWS, `تنفيذ=${r}`);
    assert.equal(d, r, `الشاشتان تتناقضان: معاينة=${d} تنفيذ=${r}`);
    // والتنفيذ نفّذه: الصفوف القديمة كلها ذهبت
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM activity_logs').get().c, 0);
    assertMonthlyTableAbsent(getDb(), 'تنفيذ /maintenance');
  });

  test('العدّ العربي سليم: سجل واحد مميز — لا «1 سجلاً»', async () => {
    openMemoryDb();
    const firstEligible = retention.ACTIVITY_RETENTION_MONTHS + 1;
    getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
      VALUES ('u', 'c', 'staff', 0.25, ?)`).run(`${monthBack(firstEligible)}-05`);
    const i = fakeInteraction(false);
    await commands.get('maintenance').execute(i);
    const desc = descriptionOf(i);
    assert.match(desc, /سجل واحد/, `العدّ غير صحيح لسجل واحد:\n${desc}`);
    assert.doesNotMatch(desc, /1 سجلاً/, '«1 سجلاً» بدل «سجل واحد»');
  });
});
