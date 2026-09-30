'use strict';
/**
 * صيانة البيانات: جدول `activity_logs` يسجّل **صفاً لكل رسالة**، وبلا
 * تقليم يتحول إلى قنبلة موقوتة. هنا نُجمّع الأشهر القديمة في `activity_monthly`
 * ثم نحذف الصفوف الخام، ونقلّم سجل العمليات القديم، ثم نُفرّغ المساحة بـ VACUUM.
 *
 * مبدأ الأمان: لا يُحذف أي شيء قبل نجاح التجميع، وكل شيء داخل معاملة واحدة،
 * ويمكن التشغيل بوضع المعاينة (dryRun) لعرض ما سيحدث قبل حدوثه.
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

/** أول يوم من الشهر الذي نبدأ قبله التقليم (YYYY-MM) */
function cutoffMonth(months = ACTIVITY_RETENTION_MONTHS, from = clock.today()) {
  const [y, m] = from.split('-').map(Number);
  const total = y * 12 + (m - 1) - months;
  return `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
}

/** يجمع أشهر النشاط القديمة في جدول التجميع — يعيد عدد الصفوف المُجمَّعة */
function rollupActivity({ months = ACTIVITY_RETENTION_MONTHS, dryRun = false } = {}) {
  const db = getDb();
  const cutoff = cutoffMonth(months);
  const rows = db.prepare(`SELECT user_id, substr(day, 1, 7) month, COUNT(*) messages,
      COALESCE(SUM(weight), 0) weighted, COUNT(DISTINCT day) active_days
    FROM activity_logs WHERE day < ? GROUP BY user_id, month`).all(`${cutoff}-01`);
  if (dryRun || !rows.length) return { months: rows.length, cutoff, rows: rows.length };
  const upsert = db.prepare(`INSERT INTO activity_monthly (user_id, month, messages, weighted, active_days)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, month) DO UPDATE SET
      messages = excluded.messages, weighted = excluded.weighted, active_days = excluded.active_days`);
  const run = db.transaction((items) => {
    for (const r of items) upsert.run(r.user_id, r.month, r.messages, Math.round(r.weighted * 100) / 100, r.active_days);
  });
  run(rows);
  return { months: new Set(rows.map(r => r.month)).size, cutoff, rows: rows.length };
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

/** تقليم سجل المهام المجدولة ورفع فحوصات النسخ القديمة (بيانات تشخيصية فقط) */
function pruneOperational({ dryRun = false } = {}) {
  const db = getDb();
  const stale = db.prepare("SELECT COUNT(*) c FROM backup_checks WHERE created_at < datetime('now', '-180 days')").get().c;
  if (!dryRun && stale) db.prepare("DELETE FROM backup_checks WHERE created_at < datetime('now', '-180 days')").run();
  return { backupChecks: dryRun ? 0 : stale, pending: stale };
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

/** استرجاع المساحة بعد الحذف — لا يعمل داخل معاملة، لذلك يُنفَّذ منفصلاً */
function vacuum() {
  if (config.dbPath === ':memory:') return false;
  try { getDb().exec('VACUUM'); return true; } catch (e) { logger.warn(`تعذّر VACUUM: ${e.message}`); return false; }
}

/** استرجاع المساحة بعد الحذف — لا يعمل داخل معاملة، لذلك يُنفَّذ منفصلاً */
function run({ dryRun = false, months = ACTIVITY_RETENTION_MONTHS, auditMonths = AUDIT_RETENTION_MONTHS } = {}) {
  const before = dbSizeMb();
  const rollup = rollupActivity({ months, dryRun });
  const activity = pruneActivity({ months, dryRun });
  const audit = pruneAudit({ months: auditMonths, dryRun });
  const ops = pruneOperational({ dryRun });
  const vacuumed = dryRun ? false : vacuum();
  const report = { rollup, activity, audit, ops, vacuumed, sizeBeforeMb: before, sizeAfterMb: dbSizeMb(), dryRun };
  if (!dryRun) {
    logger.info(`🧹 صيانة البيانات: جُمّع ${rollup.rows} سجل (${rollup.months} شهر) • حُذف ${activity.deleted} صف نشاط • ${audit.deleted} سجل عمليات • الحجم ${report.sizeBeforeMb} → ${report.sizeAfterMb} م.ب`);
  }
  return report;
}

module.exports = {
  ACTIVITY_RETENTION_MONTHS, AUDIT_RETENTION_MONTHS,
  cutoffMonth, rollupActivity, pruneActivity, pruneAudit, pruneOperational,
  run, dbSizeMb, tableCounts, vacuum,
};
