'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../database');

/**
 * قائمة ملفات النسخ مرتّبة من الأحدث إلى الأقدم (mtime وقت الكتابة).
 * تُلتقط بعد نجاح فحص النسخة الجديدة فقط.
 */
function snapshotBackups() {
  return fs.readdirSync(config.backup.dir)
    .filter(name => /^staff-.*\.db$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(config.backup.dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
}

/** تقليم النسخ القديمة الزائدة عن `keep` — بعد نجاح فحص النسخة الجديدة فقط. */
function pruneBackups(files) {
  for (const file of files.slice(Math.max(1, config.backup.keep))) {
    try { fs.unlinkSync(path.join(config.backup.dir, file.name)); } catch {}
  }
}

async function createBackup({ reason = 'scheduled' } = {}) {
  if (config.dbPath === ':memory:') throw new Error('لا يمكن إنشاء نسخة احتياطية من قاعدة بيانات الذاكرة.');
  fs.mkdirSync(config.backup.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(config.backup.dir, `staff-${stamp}-${reason}.db`);
  const db = getDb();
  if (typeof db.backup === 'function') await db.backup(target);
  else fs.copyFileSync(config.dbPath, target);

  // الفحص **قبل** التقليم. كان التقليم يسبق الفحص: إن اقتطع القرص الكتابة
  // (السبب الأشيع لهذه الحالة) حُذفت النسخ السليمة القديمة قبل أن يكتشف أحد
  // أن النسخة الجديدة غير صالحة — فيضيع الصالح وينجو الفاسد.
  const check = verify(target);
  if (check.ok === false) {
    throw new Error(`أُنشئت النسخة الاحتياطية لكنها فشلت في الفحص: ${check.detail} — لم تُحذف أي نسخة سابقة.`);
  }
  if (check.ok !== true) {
    // لا نعرف. «نسخة لم تُختبر ليست نسخة»: لا ندّعي أنها سليمة، ولا نترك
    // لدينا نسخة لم يُعرف حالتها. لا تقليم في الحالتين.
    throw new Error(`تعذّر التحقق من النسخة الاحتياطية: ${check.detail} — لم تُحذف أي نسخة سابقة.`);
  }
  pruneBackups(snapshotBackups());
  return target;
}

/**
 * فحص سلامة نسخة احتياطية: نسخة لم تُختبر ليست نسخة.
 * يفتح الملف للقراءة فقط، يشغّل PRAGMA integrity_check، ويسأل SQLite عن جداوله.
 * `ok === null` يعني «تعذّر الفحص» — لا سلامة ولا فساد، ويجب ألا يُعرض
 * كسليم. كان يُعيد `ok: true` في هذه الحالة فتقول «سليمة» نسخة لم تُفحص.
 */
function verify(pathToFile) {
  // ok في القاعدة: 1 سليم، 0 فاشل، -1 غير معروف (العمود NOT NULL بلا CHECK).
  const stored = (ok) => (ok === null ? -1 : (ok ? 1 : 0));
  const detail = (ok, text, size = null) => {
    try {
      getDb().prepare('INSERT INTO backup_checks (path, ok, detail, size_bytes) VALUES (?, ?, ?, ?)')
        .run(pathToFile, stored(ok), text, size);
    } catch { /* قاعدة الذاكرة أو جدول مفقود: نتجاهل التسجيل */ }
    return { ok, detail: text, size };
  };
  try {
    if (!fs.existsSync(pathToFile)) return detail(false, 'الملف غير موجود');
    const size = fs.statSync(pathToFile).size;
    if (size === 0) return detail(false, 'الملف فارغ', size);
    const Database = require('better-sqlite3');
    const probe = new Database(pathToFile, { readonly: true, fileMustExist: true });
    try {
      const integrity = probe.prepare('PRAGMA integrity_check').get();
      const result = Object.values(integrity || {})[0];
      const tables = probe.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type = 'table'").get().c;
      const staff = probe.prepare('SELECT COUNT(*) c FROM staff_members').get().c;
      if (String(result).toLowerCase() !== 'ok') return detail(false, `integrity_check: ${result}`, size);
      return detail(true, `سليمة • ${tables} جدولاً • ${staff} إدارياً`, size);
    } finally { probe.close(); }
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
      // الحجم وحده ليس سلامة: نترك السؤال بلا جواب صريح.
      return detail(null, 'تعذّر الفحص الآلي (better-sqlite3 غير مثبّتة) — لم يُتحقَّق من السلامة', fs.existsSync(pathToFile) ? fs.statSync(pathToFile).size : null);
    }
    return detail(false, `فشل الفحص: ${e.message}`);
  }
}

function listBackups() {
  if (!fs.existsSync(config.backup.dir)) return [];
  return fs.readdirSync(config.backup.dir)
    .filter(name => /^staff-.*\.db$/.test(name))
    .map(name => {
      const file = path.join(config.backup.dir, name);
      const stat = fs.statSync(file);
      return { name, path: file, size: stat.size, modifiedAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/**
 * ثلاث حالات لا حالتان. `verify()` يُعيد `ok: null` حين يتعذّر الفحص الآلي، و`null`
 * falsy — فأي `check.ok ? ... : 'فشل'` كان سيعرض «لم يُفحص» على أنه «فاشل».
 * كل استدعاء يعرض نتيجة الفحص يمرّ من هنا حتى لا تتباعد المواضع الثلاثة.
 */
function checkLabel(check) {
  if (!check) return { emoji: '⚪', label: 'لم يُفحص', color: 'unknown' };
  if (check.ok === true) return { emoji: '🟢', label: 'فحص السلامة', color: 'success' };
  if (check.ok === false) return { emoji: '🔴', label: 'فشل الفحص', color: 'danger' };
  return { emoji: '🟠', label: 'لم يُتحقَّق من السلامة', color: 'warning' };
}

/** سطر جاهز للعرض: «🟢 فحص السلامة: <التفاصيل>» */
function checkLine(check) {
  const c = checkLabel(check);
  return `${c.emoji} **${c.label}:** ${check ? check.detail : 'لا يوجد سجل فحص'}`;
}

module.exports = { createBackup, listBackups, verify, checkLabel, checkLine };
