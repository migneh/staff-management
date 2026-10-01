'use strict';
/**
 * المعاينة على `/maintenance` كانت تُضخّم عدد الأشهر مئة ضعف.
 *
 * العيب: `rollupActivity` كان يُعيد `{months: rows.length}` في المسار الجاف
 * و`{months: <عدد الأشهر المتمايزة>}` في مسار النجاح — **المفتاح نفسه بمعنيين
 * مختلفين**. rows.length عدد الصفوف (عضو × شهر)، أي 120 إدارياً × 12 شهراً =
 * 1,440، فيُطبع على الشاشة `سيُجمَّع في 1,440 شهراً`. وهذه بالضبط الشاشة
 * التي يبني عليها المشغّل قرار حذف غير قابل للتراجع، ويُخالف بها التقرير
 * الحقيقي الذي يطبع 12 بعد دقائق — تناقض بين معاينة ونتيجة على نفس البيانات.
 *
 * الطبقة الأولى: الشكل — months يجب أن يعني أشهراً متمايزة في المسارين، فلا
 * ينجو الاختبار لو عاد أحد إلى الخلط. الأرقام في test أدناه تفترق بأكثر من
 * عشرة أضعاف (12 شهراً مقابل 1,440 صفاً) فلا ينجح صدفةً.
 * الطبقة الثانية: الشاشة نفسها — المعاينة والتنفيذ يقرآن المعنى نفسه.
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
 * البذرة: `MONTHS` شهراً سابقاً *لحدّ التقليم* مباشرة، × `MEMBERS` عضواً.
 * cutoff = cutoffMonth(ACTIVITY_RETENTION_MONTHS=12) → الشهر M-12،
 * والمؤهل هو `day < cutoff-01` أي الشهور الأقدم تماماً: M-13 … M-(12+MONTHS).
 * فنبذرة MONTHS=13 شهراً تعطي 13 شهراً متمايزاً و13×60=780 صفاً.
 */
const MEMBERS = 60;
const MONTHS = 13;
const EXPECTED_MONTHS = MONTHS;         // 13 شهراً متمايزاً
const EXPECTED_ROWS = MONTHS * MEMBERS; // 780 صفاً (عضو × شهر)

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
      for (let d = 1; d <= 3; d++) ins.run(`u${user}`, `${ym}-${String(d).padStart(2, '0')}`);
    }
  }
  db.exec('COMMIT');
}

describe('rollupActivity: months يعني أشهراً متمايزة في المسارين', () => {
  beforeEach(() => { openMemoryDb(); seedSpread(); });

  test('المعاينة: months = 13 لا 780 — الأرقام تفترق 60 ضعفاً فلا تصادف', () => {
    const r = retention.rollupActivity({ dryRun: true });
    assert.equal(r.rows, EXPECTED_ROWS, `rows=${r.rows} المتوقّع ${EXPECTED_ROWS}`);
    assert.equal(r.months, EXPECTED_MONTHS, `months=${r.months} المتوقّع ${EXPECTED_MONTHS} — رجع عدد الصفوف؟`);
    // الشرط الحاسم: لو عاد الخلط لصار months === rows ونجح الاختبار زوراً.
    assert.notEqual(r.months, r.rows, 'months = rows — الخلط الأصلي عاد');
    assert.ok(r.rows / r.months > 10, 'الرقمان لا يفترقان بأكثر من 10 أضعاف — الاختبار لا يميّز');
  });

  test('التنفيذ: نفس الشكل ونفس الرقم — months لا يتغيّر بين المسارين', () => {
    const dry = retention.rollupActivity({ dryRun: true });
    const real = retention.rollupActivity({ dryRun: false });
    assert.equal(real.months, EXPECTED_MONTHS, `months=${real.months}`);
    assert.equal(real.rows, EXPECTED_ROWS);
    assert.deepEqual(Object.keys(dry).sort(), Object.keys(real).sort(), 'شكل مختلف بين المسارين');
    assert.equal(dry.months, real.months, 'months اختلف بين المعاينة والتنفيذ');
    assert.equal(dry.rows, real.rows, 'rows اختلف بين المعاينة والتنفيذ');
  });

  test('قاعدة فارغة: الصفر في المسارين — لا month واحد زائف', () => {
    openMemoryDb();
    const r = retention.rollupActivity({ dryRun: true });
    assert.deepEqual(r, { months: 0, rows: 0, cutoff: r.cutoff });
  });

  test('عضو واحد عبر MONTHS شهراً: months = MONTHS و rows = MONTHS — التمييز من تعدّد الأعضاء', () => {
    openMemoryDb();
    const db = getDb();
    const ins = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
      VALUES ('solo', 'c', 'staff', 0.25, ?)`);
    const firstEligible = retention.ACTIVITY_RETENTION_MONTHS + 1;
    for (let k = 0; k < MONTHS; k++) ins.run(`${monthBack(firstEligible + k)}-05`);
    const r = retention.rollupActivity({ dryRun: true });
    assert.equal(r.months, MONTHS, `months=${r.months} المتوقّع ${MONTHS}`);
    assert.equal(r.rows, MONTHS, `rows=${r.rows} — عضو واحد × ${MONTHS} شهراً`);
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
  /** يستخرج الرقم قبل «شهر» من سطر التجميع */
  const monthsShown = text => {
    const m = text.match(/(\d+)\s*\((?:شهر واحد|شهران|\d+ أشهر|\d+ شهراً)\)/);
    return m ? Number(m[1]) : null;
  };

  test('معاينة /maintenance تعرض 13 شهراً لا 780 صفاً', async () => {
    const i = fakeInteraction(false);
    await commands.get('maintenance').execute(i);
    const desc = descriptionOf(i);
    assert.ok(desc, 'لم يُرسَم الرد');
    assert.equal(monthsShown(desc), EXPECTED_MONTHS,
      `الشاشة تعرض ${monthsShown(desc)} بدل ${EXPECTED_MONTHS}:\n${desc}`);
    // 780 هنا عدد الصفوف وهو صحيح. الخطب هو أن يظهر 780 كعدد للأشهر.
    const monthWordShown = desc.match(/\d+\s*\((?:شهر واحد|شهران|\d+ أشهر|\d+ شهراً)\)/);
    assert.ok(monthWordShown, `لا يظهر عدد الأشهر بصيغته:\n${desc}`);
    assert.doesNotMatch(monthWordShown[0], /780|720|1440/, `عدد الصفوف يظهر充当 عدد الأشهر: ${monthWordShown[0]}`);
    // والسطر يذكر العددين بمعنيين مختلفين — هكذا يقرأه المشغّل
    assert.match(desc, new RegExp(`ستُجمَّع في ${EXPECTED_MONTHS} \\(${EXPECTED_MONTHS} شهراً\\) \\(${EXPECTED_ROWS} سجل\\)`),
      `السطر لا يفصل الأشهر عن الصفوف:\n${desc}`);
    // لا يُحذف شيء في المعاينة
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM activity_logs').get().c, EXPECTED_ROWS * 3);
  });

  test('معاينة وتنفيذ: نفس رقم الأشهر في الرسمين', async () => {
    const dry = fakeInteraction(false);
    await commands.get('maintenance').execute(dry);
    const real = fakeInteraction(true);
    await commands.get('maintenance').execute(real);
    const d = monthsShown(descriptionOf(dry));
    const r = monthsShown(descriptionOf(real));
    assert.equal(d, EXPECTED_MONTHS, `معاينة=${d}`);
    assert.equal(r, EXPECTED_MONTHS, `تنفيذ=${r}`);
    assert.equal(d, r, `الشاشتان تتناقضان: معاينة=${d} تنفيذ=${r}`);
  });

  test('العدّ العربي سليم: شهر واحد متمايز — لا «1 شهراً»', async () => {
    openMemoryDb();
    const firstEligible = retention.ACTIVITY_RETENTION_MONTHS + 1;
    getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day)
      VALUES ('u', 'c', 'staff', 0.25, ?)`).run(`${monthBack(firstEligible)}-05`);
    const i = fakeInteraction(false);
    await commands.get('maintenance').execute(i);
    const desc = descriptionOf(i);
    assert.match(desc, /شهر واحد/, `العدّ غير صحيح لشهر واحد:\n${desc}`);
    assert.doesNotMatch(desc, /1 شهراً/, '«1 شهراً» بدل «شهر واحد»');
  });
});