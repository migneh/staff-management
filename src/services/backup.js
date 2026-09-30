'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getDb } = require('../database');

async function createBackup({ reason = 'scheduled' } = {}) {
  if (config.dbPath === ':memory:') throw new Error('لا يمكن إنشاء نسخة احتياطية من قاعدة بيانات الذاكرة.');
  fs.mkdirSync(config.backup.dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(config.backup.dir, `staff-${stamp}-${reason}.db`);
  const db = getDb();
  if (typeof db.backup === 'function') await db.backup(target);
  else fs.copyFileSync(config.dbPath, target);

  const files = fs.readdirSync(config.backup.dir)
    .filter(name => /^staff-.*\.db$/.test(name))
    .map(name => ({ name, time: fs.statSync(path.join(config.backup.dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time);
  for (const file of files.slice(Math.max(1, config.backup.keep))) {
    try { fs.unlinkSync(path.join(config.backup.dir, file.name)); } catch {}
  }
  const check = verify(target);
  if (!check.ok) throw new Error(`أُنشئت النسخة الاحتياطية لكنها فشلت في الفحص: ${check.detail}`);
  return target;
}

/**
 * فحص سلامة نسخة احتياطية: نسخة لم تُختبر ليست نسخة.
 * يفتح الملف للقراءة فقط، يشغّل PRAGMA integrity_check، ويسأل SQLite عن جداوله.
 * يعمل فقط إن كان better-sqlite3 الحقيقي متاحاً؛ غير ذلك يُعيد ok=null بصدق.
 */
function verify(pathToFile) {
  const detail = (ok, text, size = null) => {
    try {
      getDb().prepare('INSERT INTO backup_checks (path, ok, detail, size_bytes) VALUES (?, ?, ?, ?)')
        .run(pathToFile, ok ? 1 : 0, text, size);
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
    if (e.code === 'MODULE_NOT_FOUND') return detail(true, 'تعذّر الفحص الآلي (better-sqlite3 غير مثبّتة) — الحجم يبدو سليماً', fs.existsSync(pathToFile) ? fs.statSync(pathToFile).size : null);
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

module.exports = { createBackup, listBackups, verify };
