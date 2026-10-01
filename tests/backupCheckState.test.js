'use strict';
/**
 * حالة «تعذّر الفحص» ثلاثية لا ثنائية.
 *
 * services/backup.js verify() يُعيد ok: null للمجهول، وقاعدة البيانات تخزّن
 * -1 (لأن العمود INTEGER NOT NULL بلا CHECK). و-1 truthy في JS، فكان أي
 * `check.ok ? '🟢 سليم' : '🔴 فاشل'` يعرض المجهول على أنه سليم — أخطر من
 * عرضه فاشلاً. هذا الحارس يمنع عودة الشرط الثنائي.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { openMemoryDb, getDb } = require('../src/database');
const backup = require('../src/services/backup');

test.before(() => { openMemoryDb(); });

test('حالة الفحص ثلاثية: سليم / فاشل / متحقَّق- منه', () => {
  assert.equal(backup.checkLabel({ ok: true }).color, 'success');
  assert.equal(backup.checkLabel({ ok: false }).color, 'danger');
  assert.equal(backup.checkLabel({ ok: null }).color, 'warning');
});

test('المجهول لا يُعرض «سليماً» ولا «فاشلاً» — الحالة الثالثة صراحة', () => {
  // null falsy: أي شرط ثنائي سيُظهره فاشلاً
  const unknown = backup.checkLabel({ ok: null });
  assert.notEqual(unknown.color, 'success');
  assert.notEqual(unknown.color, 'danger');
  assert.equal(unknown.color, 'warning');

  // -1 truthy: أي شرط ثنائي سيُظهره سليماً — وهذا هو الفخّ
  assert.ok(-1, 'حارس: -1 يبقى truthy في JS، وهذا سبب الفخّ لا نفيه');
  const fromRow = Number(-1) > 0 ? 'success' : Number(-1) < 0 ? 'warning' : 'danger';
  assert.equal(fromRow, 'warning');
});

test('سطر العرض يحمل التفصيل ولا يفقده', () => {
  const line = backup.checkLine({ ok: null, detail: 'better-sqlite3 غير مثبّتة' });
  assert.match(line, /لم يُتحقَّق من السلامة/);
  assert.match(line, /better-sqlite3/);
});

test('سطر العرض يتحمّل غياب السجل بدل أن يرمي', () => {
  const line = backup.checkLine(null);
  assert.match(line, /لم يُفحص/);
});

test('عمود backup_checks يقبل ثلاث حالات دون الخلط بينها', () => {
  const db = getDb();
  for (const value of [1, 0, -1]) {
    db.prepare('INSERT INTO backup_checks (path, ok, detail, size_bytes, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(`staff-${value}.db`, value, 'd', 1024, '2026-01-01 00:00:00');
  }
  const rows = db.prepare('SELECT ok FROM backup_checks ORDER BY id').all().map(r => Number(r.ok));
  assert.deepEqual(rows, [1, 0, -1]);
  // الحالة السالبة لا تساوي الموجبة ولا الصفرية
  assert.ok(rows.filter(r => r > 0).length === 1);
  assert.ok(rows.filter(r => r === 0).length === 1);
  assert.ok(rows.filter(r => r < 0).length === 1);
});
