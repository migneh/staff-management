#!/usr/bin/env node
'use strict';
/**
 * ترحيل اختياري: توحيد عمود activity_logs.day مع توقيت السيرفر (TZ).
 *
 * لماذا؟ قبل توحيد التواريخ كان اليوم يُكتب بـ toISOString() أي بتوقيت UTC،
 * فالنشاط الذي يجري بين منتصف الليل والساعة 3 فجراً بتوقيت الرياض كان يُسجَّل
 * في «يوم أمس» — وهذا يفسد التواجد (activeDays) وتقارير الشهر وحد 20 رسالة.
 *
 * الاستخدام:
 *   node scripts/migrate-activity-timezone.js --dry-run     # عرض ما سيتغير فقط
 *   node scripts/migrate-activity-timezone.js               # تنفيذ الترحيل
 *
 * آمن: يشتغل داخل معاملة واحدة، ويأخذ نسخة احتياطية من قاعدة البيانات أولاً،
 * ولا يمسّ الصفوف التي يومها مطابق أصلاً.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { getDb } = require('../src/database');
const clock = require('../src/clock');
const backup = require('../src/services/backup');

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) c FROM activity_logs').get().c;
  const rows = db.prepare('SELECT id, created_at, day FROM activity_logs').all();

  // يوم created_at (UTC) مقابل اليوم الصحيح بتوقيت السيرفر
  const fix = [];
  for (const row of rows) {
    if (!row.created_at) continue;
    const localDay = clock.dayOf(clock.parseStamp(row.created_at));
    if (localDay && localDay !== row.day) fix.push({ id: row.id, from: row.day, to: localDay });
  }

  console.log(`📊 قاعدة البيانات: ${total} سجل نشاط • المنطقة الزمنية: ${clock.TZ}`);
  if (!fix.length) { console.log('✅ لا شيء للترحيل — كل الأيام مطابقة لتوقيت السيرفر.'); return; }
  console.log(`🔧 سيُصحَّح ${fix.length} سجل (${((fix.length / (total || 1)) * 100).toFixed(1)}%).`);
  for (const f of fix.slice(0, 5)) console.log(`   #${f.id}: ${f.from} → ${f.to}`);
  if (fix.length > 5) console.log(`   ... و${fix.length - 5} سجل آخر.`);
  if (dryRun) { console.log('🧪 وضع المعاينة — لم يُكتب أي تغيير. أعد الأمر بدون --dry-run للتنفيذ.'); return; }

  const backupPath = await backup.createBackup({ reason: 'pre-tz-migration' });
  console.log(`💾 نسخة احتياطية: ${backupPath || 'تعذّر إنشاء النسخة (تحقق من مجلد data/)'}`);

  const update = db.prepare('UPDATE activity_logs SET day = ? WHERE id = ?');
  const run = db.transaction((items) => { for (const it of items) update.run(it.to, it.id); });
  run(fix);
  console.log(`✅ تم تصحيح ${fix.length} سجل. أعد تشغيل البوت ليعمل على التواريخ الصحيحة.`);
}

main().catch((e) => {
  console.error(`❌ فشل الترحيل: ${e.message}`);
  process.exit(1);
});
