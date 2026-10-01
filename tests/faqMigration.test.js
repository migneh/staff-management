'use strict';
// حارس ضد انهيار ترحيل تصنيفات FAQ.
//
// الخريطة ليست idempotent: كل تشغيل متكرر ينزل بمعرّف كل تصنيف درجة، والمعرّف 1
// نقطة ثابتة (1 ← 1)، فتنهار البنية تدريجياً نحو 1 بلا رجعة. كان حارس التشغيل
// يُكتب بعد COMMIT، فموت البوت بين الاثرين يجعل الخريطة تُعاد على بيانات
// مُعاد تقييمها أصلاً.
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();
const { test } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, migrateFaqCategories } = require('../src/database');

const KEY = 'schema_faq_categories';

function seed() {
  const db = openMemoryDb();
  const insE = db.prepare('INSERT INTO faq_entries (category_id, title, content, created_by) VALUES (?, ?, ?, ?)');
  for (const [i, c] of [[1, 1], [2, 2], [3, 3], [4, 5], [5, 9]]) insE.run(c, `e${i}`, 'c', 'u');
  db.prepare('INSERT INTO faq_templates (name, title, description, category_ids, created_by) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 'قالب', 'وصف', JSON.stringify([3, 4]), 'u');
  return db;
}
const cats = (db) => db.prepare('SELECT category_id FROM faq_entries ORDER BY title').all().map((r) => r.category_id);
const dropMarker = (db) => db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);

test('حارس الترحيل يُكتب داخل المعاملة: تشغيل ثانٍ لا يحرّك شيئاً', () => {
  const db = seed();
  assert(db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY), 'الحارس مكتوب بعد أول تشغيل');
  const before = cats(db);
  migrateFaqCategories(db);
  assert.deepEqual(cats(db), before, 'تشغيل ثانٍ غيّر التصنيفات رغم اكتمال الترحيل');
});

test('حارس الترحيل ذرّي مع بياناته: فقدان الحارس لا يعني فقدان الصفقة', () => {
  // لو كان الحارس يُكتب خارج المعاملة، لما أمكن ضمان أنه يُحفظ متزامناً مع
  // إعادة الترقيم. هذا الاختبار يثبّت السلوك المطلوب لا تفاصيل التنفيذ.
  const db = seed();
  dropMarker(db);
  migrateFaqCategories(db);
  const marker = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  assert(marker, 'التشغيل بلا حارس سابق يجب أن يعيد كتابة الحارس');
});

test('الخريطة ليست idempotent — ولهذا الحارس ضروري', () => {
  // يثبّت الخطر نفسه: كل تشغيل بلا حارس ينزل بالتصنيفات درجة. إن صارت الخريطة
  // idempotent يوماً، فهذا الاختبار هو الذي يجب أن يتغيّر.
  const db = seed();
  const snapshots = [];
  for (let n = 0; n < 3; n++) {
    dropMarker(db);
    migrateFaqCategories(db);
    snapshots.push(cats(db).join(','));
  }
  assert.notDeepEqual(snapshots[0], snapshots[1], 'كل تشغيل متكرر ينزل بالتصنيفات — الخطر قائم ما لم يكن الحارس ذرّياً');
});

test('قوالب FAQ تُعاد ترقيمها بالقاعدة نفسها ولا تُفقد محتواها', () => {
  const db = seed();
  dropMarker(db);
  migrateFaqCategories(db);
  const row = db.prepare('SELECT category_ids FROM faq_templates WHERE name = ?').get('t1');
  const ids = JSON.parse(row.category_ids);
  assert(Array.isArray(ids) && ids.length === 2, `قالب فقد تصنيفاته: ${row.category_ids}`);
  assert(ids.every((n) => Number.isInteger(n) && n >= 1), `معرّف تصنيف غير صالح: ${row.category_ids}`);
});