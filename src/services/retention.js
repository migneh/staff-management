'use strict';
/**
 * صيانة البيانات: جدول `activity_logs` يسجّل **صفاً لكل رسالة**، وبلا
 * تقليم يتحول إلى قنبلة موقوتة. هنا نُجمّع الأشهر القديمة في `activity_monthly`
 * ثم نحذف الصفوف الخام، ونقلّم سجل العمليات القديم، ثم نسترجع المساحة.
 *
 * مبدأ الأمان: لا يُحذف أي شيء قبل نجاح التجميع، ويمكن التشغيل بوضع المعاينة
 * (dryRun) لعرض ما سيحدث قبل حدوثه.
 *
 * ★ الذرّية: `run()` ليست معاملة واحدة — كانت هذه العبارة توحي بغير ذلك. هي
 * خمس وحدات، **كل وحدة ذرّية وحدها لا مجتمعة**:
 *   1) التجميع  — كل الـ upserts داخل `db.transaction` واحدة: كلّها أو لا شيء.
 *   2) حذف النشاط — `DELETE` واحد: ذرّي بذاته.
 *   3) حذف سجل العمليات — `DELETE` واحد: ذرّي بذاته.
 *   4) حذف فحوص النسخ — `DELETE` واحد: ذرّي بذاته.
 *   5) استرجاع المساحة — خارج أي معاملة، لأن VACUUM وincremental_vacuum
 *      يرفضان العمل داخل معاملة أصلاً (SQLITE_ERROR). ولهذا يستحيل دمجها.
 * فالانقطاع بين 2 و3 يترك activity_logs مقصوصة وسجل العمليات باقياً: ناقص لا
 * متناقض. والترتيب بين 1 و2 مقصود: لا يُحذف صف قبل نجاح تجميعه، فإعادة التشغيل
 * تلتقط ما لم يُحذف. أما استعادة «كل شيء ذرّي» فتحتاجVACUUM معاملات — أي تغيير
 * في ملف قاعدة البيانات (لا أملكه) لإعادة فتح الاتصال بعد الاستبدال.
 *
 * ★ استرجاع المساحة: كان `VACUUM` الكلاسيكي يُجمّد حلقة الأحداث: على قاعدة
 * 1,748 م.ب قِيس 106 ثانية، فلا رسالة ولا تفاعل ولا نبضة بوابة Discord. البديل
 * وتفاصيل الأمان في `vacuum()`.
 */
const fs = require('fs');
const { getDb } = require('../database');
const config = require('../config');
const logger = require('../logger').log('retention');
const clock = require('../clock');

/** كم شهراً نحتفظ فيه بالرسائل الخام (بعدها تُجمَّع وتُحذف) */
const ACTIVITY_RETENTION_MONTHS = 12;
/** كم شهراً نحتفظ فيه بسجل العمليات (audit_logs) */
const AUDIT_RETENTION_MONTHS = 18;
/** كم شهراً نحتفظ فيه بفحوص النسخ (بيانات تشخيصية فقط) */
const BACKUP_CHECK_RETENTION_MONTHS = 6;

/**
 * حدود استرجاع المساحة — كلها «لا تفعل» قبل بلوغها: الأصل كان يُجمّد بلا داعٍ.
 *
 * MIN_SIZE_MB   تحت هذا الحجم لا نسترجع أصلاً: إعادة كتابة ملف صغير لا تستحق
 *               قفلاً حصرياً على القاعدة، بعدد صفوف محذوف لا يستحق ثوانٍ من
 *               تجميد البوت كله.
 * MIN_FREE_MB   لا نسترجع إلا إن كانت الصفحات الحرة تُعوّض الجهد. VACUUM يعيد
 *               كتابة الملف كله ليعيد `freelist_count` صفحة؛ فإن كان الحرة 4 م.ب
 *               مقابل 1,700 م.ب نكتب 1,700 لأربعة.
 * CONVERT_MAX_MB التحويل لمرة واحدة إلى auto_vacuum=INCREMENTAL (انظر vacuum())
 *               يتطلّب VACUUM كاملاً، ونُجريه فقط تحت هذا الحجم لأن ثمنه-cheap
 *               وصغير؛ فوقه يُبلَّغ المشغّل بالخطوة اليدوية بدل تجميد بوت كبير.
 */
const VACUUM_MIN_SIZE_MB = 64;
const VACUUM_MIN_FREE_MB = 16;
const VACUUM_CONVERT_MAX_MB = 256;
/** عدد الصفحات في شريحة الاسترجاع الواحدة — ميزانية زمنية ضئيلة للحدث */
const VACUUM_SLICE_PAGES = 256;

/** أول يوم من الشهر الذي نبدأ قبله التقليم (YYYY-MM) */
function cutoffMonth(months = ACTIVITY_RETENTION_MONTHS, from = clock.today()) {
  const [y, m] = from.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/**
 * يجمع أشهر النشاط القديمة في جدول التجميع.
 *
 * شكل الإرجاع واحد في المسارين — وهذا أصل العطب: المسار الجاف كان يُعيد
 * `months: rows.length` (عدد **الصفوف**) وناجح `months: <عدد الأشهر>`، فكان
 * `/maintenance` يطبع على شاشة المشغّل «سيُجمَّع في 1,440 شهراً» بدل 12، وهو
 * بالضبط Screen الذي يُبنى عليه قرار حذف غير قابل للتراجع.
 * الآن المعنى واحد:
 *   months = عدد **الأشهر المتمايزة**
 *   rows   = عدد **مجموعات (عضو × شهر)** المُدخلة
 * @returns {{months:number, rows:number, cutoff:string}} نفس الشكل دائماً
 */
function rollupActivity({ months = ACTIVITY_RETENTION_MONTHS, dryRun = false } = {}) {
  const db = getDb();
  const cutoff = cutoffMonth(months);
  const rows = db.prepare(`SELECT user_id, substr(day, 1, 7) month, COUNT(*) messages,
      COALESCE(SUM(weight), 0) weighted, COUNT(DISTINCT day) active_days
    FROM activity_logs WHERE day < ? GROUP BY user_id, month`).all(`${cutoff}-01`);
  const shape = { months: new Set(rows.map(r => r.month)).size, rows: rows.length, cutoff };
  if (dryRun || !rows.length) return shape;
  const upsert = db.prepare(`INSERT INTO activity_monthly (user_id, month, messages, weighted, active_days)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET
      messages = excluded.messages, weighted = excluded.weighted, active_days = excluded.active_days`);
  const run = db.transaction((items) => {
    for (const r of items) upsert.run(r.user_id, r.month, r.messages, Math.round(r.weighted * 100) / 100, r.active_days);
  });
  run(rows);
  return shape;
}

/** يحذف الصفوف الخام التي جُمّعت فعلاً */
function pruneActivity({ months = ACTIVITY_RETENTION_MONTHS, dryRun = false } = {}) {
  const db = getDb();
  const cutoff = `${cutoffMonth(months)}-01`;
  const { c } = db.prepare('SELECT COUNT(*) c FROM activity_logs WHERE day < ?').get(cutoff);
  if (dryRun || !c) return { deleted: 0, pending: c, cutoff };
  const res = db.prepare('DELETE FROM activity_logs WHERE day < ?').run(cutoff);
  return { deleted: res.changes, pending: c, cutoff };
}

/** تقليم سجل العمليات — أقدم من المدة المحددة */
function pruneAudit({ months = AUDIT_RETENTION_MONTHS, dryRun = false } = {}) {
  const db = getDb();
  const cutoff = `${cutoffMonth(months)}-01 00:00:00`;
  const { c } = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE created_at < ?').get(cutoff);
  if (dryRun || !c) return { deleted: 0, pending: c, cutoff };
  const res = db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
  return { deleted: res.changes, pending: c, cutoff };
}

/**
 * تقليم فحوص النسخ القديمة (بيانات تشخيصية فقط).
 *
 * شكل الإرجاع مطابق لأخويها الآن: `{deleted, pending, cutoff}`. كان يعيد
 * `{backupChecks, pending}` — مفتاح باسم مختلف وبلا `deleted`، فكل قارئ
 * `.deleted` كان يحصل على `undefined` لهذا الشقيق وحده.
 * وكان الحدّ مكتوباً `datetime('now','-180 days')` ثابتاً هنا بينما كل
 * دالة مجاورة تمرّ عبر cutoffMonth()، فأي تغيير في tz أو policy لا يبلغه.
 */
function pruneOperational({ dryRun = false, months = BACKUP_CHECK_RETENTION_MONTHS } = {}) {
  const db = getDb();
  const cutoff = `${cutoffMonth(months)}-01 00:00:00`;
  const { c } = db.prepare('SELECT COUNT(*) c FROM backup_checks WHERE created_at < ?').get(cutoff);
  if (dryRun || !c) return { deleted: 0, pending: c, cutoff };
  const res = db.prepare('DELETE FROM backup_checks WHERE created_at < ?').run(cutoff);
  return { deleted: res.changes, pending: c, cutoff };
}

/** حجم قاعدة البيانات بالميغابايت (0 لقاعدة الذاكرة) */
function dbSizeMb() {
  try {
    if (config.dbPath === ':memory:' || !fs.existsSync(config.dbPath)) return 0;
    return Math.round((fs.statSync(config.dbPath).size / 1024 / 1024) * 100) / 100;
  } catch { return 0; }
}

/** عدد الصفوف لكل جدول — للعرض في /system-status */
function tableCounts() {
  const db = getDb();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    try { out[name] = db.prepare(`SELECT COUNT(*) c FROM ${name}`).get().c; } catch { out[name] = null; }
  }
  return out;
}

/**
 * استرجاع المساحة بعد الحذف — خارج أي معاملة (راجع الذرّية في أعلى الملف).
 *
 * ★ لماذا لم ننفّذ `VACUUM INTO` + استبدال الملف بالاسم، وهو الحلّ الظاهر:
 *   لأن الاستبدال نفسه غير آمن هنا، والقياس على هذا المشروع أسقطه:
 *   1) الملف مفتوح: `fs.rename` فوق قاعدة مفتوحة فشل بـ EPERM على ويندوز. وعلى
 *      POSIX كان سينجح مع بقاء المقبض على الملف القديم — فيكتب البوت الجديد في
 *      الملف اليتيم بينما كل قارئ جديد يفتح الجديد: انقسام صامت. استبدال ملف
 *      SQLite تحت اتصال حيّ خطأ يُفسد القاعدة، وفاسد أسوأ من بطيء.
 *   2) حتى لو أُغلق الاتصال: `getDb()` في database.js يحفظ اتصالاً واحداً في
 *      متغير وحدة، ولا يصدّر إعادة فتح — فاستبداله يحتاج تعديل database.js
 *      وهو خارج نطاق هذا الملف. وVACUUM INTO لا يعمل داخل معاملة، فخلال
 *      الإغلاق يفتح البوت writers جدداً على الملف القديم.
 *   3) `VACUUM INTO` في خيط عامل (worker) يبقي حلقة الحدث حرة فعلاً (قِيس: 13
 *      نبضة أثناء 252 مللي ثانية) — لكنه يبني ملفاً جديداً ولا يستطيع تركيبه،
 *      فلا جواب عن سؤال المساحة الحرة.
 * قرار: **لا استبدال، ولا تجميد**. نسترجع المساحة شريحةً شريحة عبر
 * `PRAGMA incremental_vacuum` بعد تحويل القاعدة لمرة واحدة إلى
 * `auto_vacuum=INCREMENTAL`. كل شريحة 256 صفحة = 1 م.ب ≈ 1–4 مللي ثانية على
 * 18 م.ب، فالتجميد ينعدم — وهذا هو الهدف الحقيقي، لا مجرّد faster VACUUM.
 *
 * التحويل لمرة واحدة يتطلّب VACUUM كاملاً، فمقيَّد بـ VACUUM_CONVERT_MAX_MB:
 * تحت 256 م.ب ثمنه بضع ميلي ثانية، فوقه نُبلغ المشغّل ولا نُجمد بوتاً كبيراً.
 * القاعدة القديمة —随访: أضف `PRAGMA auto_vacuum=INCREMENTAL` في database.js
 * لقواعد جديدة فيتولّى هذا الملف التحويل تلقائياً بلا تجميد من أول مرة.
 *
 * @returns {boolean} هل استُرجعت المساحة فعلاً
 */
function vacuum() {
  if (config.dbPath === ':memory:') return false;
  const db = getDb();
  try {
    const pageSize = db.pragma('page_size', { simple: true }) || 4096;
    const freePages = db.pragma('freelist_count', { simple: true }) || 0;
    const freeMb = Math.round((freePages * pageSize) / 1048576 * 100) / 100;
    const sizeMb = dbSizeMb();

    if (sizeMb < VACUUM_MIN_SIZE_MB) return false;
    if (freeMb < VACUUM_MIN_FREE_MB) return false;

    // القواعد التي لم تُحوَّل بعد: تحويل لمرة واحدة، يُؤجَّل بلا تجميد.
    if (db.pragma('auto_vacuum', { simple: true }) !== 2) {
      if (sizeMb <= VACUUM_CONVERT_MAX_MB) {
        db.pragma('auto_vacuum = INCREMENTAL');
        db.exec('VACUUM');
        logger.info(`🧬 حُوّلت القاعدة إلى الاسترجاع التدريجي (${sizeMb} م.ب) — صيانة الأشهر القادمة بلا تجميد.`);
      } else {
        logger.warn(`⏭️ تخطّي استرجاع المساحة: القاعدة ${sizeMb} م.ب تحتاج VACUUM كاملاً لتحويلها إلى استرجاع تدريجي.`
          + ' شغّله يدوياً في نافذة صيانة (البوت متوقّف) أو ارفع VACUUM_CONVERT_MAX_MB بعد تقييم الزمن.');
        return false;
      }
    }

    // شرائح محدودة: كل نداء عملية واحدة قصيرة، فحلقة الحدث تتنفّس بينها.
    let guard = 0;
    while ((db.pragma('freelist_count', { simple: true }) || 0) > 0 && guard++ < 4096) {
      db.exec(`PRAGMA incremental_vacuum(${VACUUM_SLICE_PAGES})`);
    }
    return true;
  } catch (e) {
    logger.warn(`تعذّر استرجاع المساحة: ${e.message}`);
    return false;
  }
}

/**
 * صيانة كاملة: تجميع ثم تقليم ثم استرجاع مساحة — خمس وحدات ذرّية منفصلة
 * (انظر أعلى الملف). المعاينة (dryRun) لا تكتب شيئاً وتُبلّغ بنفس الأرقام.
 */
function run({ dryRun = false, months = ACTIVITY_RETENTION_MONTHS, auditMonths = AUDIT_RETENTION_MONTHS } = {}) {
  const before = dbSizeMb();
  const rollup = rollupActivity({ months, dryRun });
  const activity = pruneActivity({ months, dryRun });
  const audit = pruneAudit({ months: auditMonths, dryRun });
  const ops = pruneOperational({ dryRun });
  const vacuumed = dryRun ? false : vacuum();
  const report = { rollup, activity, audit, ops, vacuumed, sizeBeforeMb: before, sizeAfterMb: dbSizeMb(), dryRun };
  if (!dryRun) {
    logger.info(`🧹 صيانة البيانات: جُمّع ${rollup.rows} سجل في ${rollup.months} شهراً • حُذف ${activity.deleted} صف نشاط • ${audit.deleted} سجل عمليات • ${ops.deleted} فحص نسخة • الحجم ${report.sizeBeforeMb} → ${report.sizeAfterMb} م.ب${vacuumed ? ' (استُرجعت المساحة)' : ''}`);
  }
  return report;
}

module.exports = {
  ACTIVITY_RETENTION_MONTHS, AUDIT_RETENTION_MONTHS, BACKUP_CHECK_RETENTION_MONTHS,
  VACUUM_MIN_SIZE_MB, VACUUM_MIN_FREE_MB, VACUUM_CONVERT_MAX_MB, VACUUM_SLICE_PAGES,
  cutoffMonth, rollupActivity, pruneActivity, pruneAudit, pruneOperational,
  run, dbSizeMb, tableCounts, vacuum,
};
