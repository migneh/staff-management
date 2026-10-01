'use strict';
/**
 * FAQ category migration: the version marker protects the data, the body is
 * loaded from a per-version table.
 *
 * The old shape was one string ('2') guarding one map stuffed in one variable.
 * Whoever needs a second category remap must bump that string to '3' — and the
 * v2 map necessarily stays where it is, so v2 runs again over data it already
 * remapped. That map is not idempotent (3 -> 2 -> 1): the structure collapses
 * toward 1 irreversibly. The marker meant to protect the data is the very thing
 * being edited.
 *
 * These tests pin the separation: a database already at 2 is not touched, and a
 * database moving to 3 gets map 3, never map 2.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const {
  openMemoryDb, getDb, migrate, migrateFaqCategories,
  FAQ_MIGRATION_KEY, FAQ_MIGRATION_VERSION, FAQ_MIGRATIONS, FAQ_CATEGORY_REMAP,
  pendingFaqVersions, applyFaqMigrations, readFaqMigrationVersion, runFaqStep,
  duplicateTicketSources, ensureTicketSourceUniqueness, schemaFaults,
} = require('../src/database');

const KEY = FAQ_MIGRATION_KEY;

function seedCategories(db, pairs) {
  const ins = db.prepare('INSERT INTO faq_entries (category_id, title, content, created_by) VALUES (?, ?, ?, ?)');
  for (const [title, category] of pairs) ins.run(category, title, 'c', 'u');
}
const cats = (db) => db.prepare('SELECT category_id FROM faq_entries ORDER BY title').all().map(r => r.category_id);
const templateIds = (db) => db.prepare('SELECT category_ids FROM faq_templates ORDER BY name').all().map(r => r.category_ids);
const setVersion = (db, v) => db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(KEY, String(v));

/** A database in its post-v2 state: marker present, categories already remapped. */
function seedAtV2() {
  const db = openMemoryDb(); // migrate() writes marker 2 and applies map 2
  seedCategories(db, [['a', 1], ['b', 1], ['c', 2], ['d', 4], ['e', 8]]);
  db.prepare('INSERT INTO faq_templates (name, title, description, category_ids, created_by) VALUES (?, ?, ?, ?, ?)')
    .run('t1', 't', 'd', JSON.stringify([1, 2, 5]), 'u');
  return db;
}

describe('per-version migration table: a database already at 2 is left alone', () => {
  test('marker 2: a full re-run of migrate() changes no category byte', () => {
    const db = seedAtV2();
    assert.equal(readFaqMigrationVersion(db), 2);
    const before = cats(db);
    const beforeTemplates = templateIds(db);
    assert.ok(before.length, 'no entries seeded - the comparison would prove nothing');

    migrate(db);
    migrate(db);

    assert.deepEqual(cats(db), before, 'categories moved although the migration was already done');
    assert.deepEqual(templateIds(db), beforeTemplates, 'FAQ templates moved although the migration was already done');
    assert.equal(readFaqMigrationVersion(db), 2);
  });

  test('marker 2: calling migrateFaqCategories directly also changes nothing', () => {
    const db = seedAtV2();
    const before = cats(db);
    migrateFaqCategories(db);
    migrateFaqCategories(db);
    assert.deepEqual(cats(db), before);
  });

  test('a database at the newest defined version has no pending steps', () => {
    const db = seedAtV2();
    assert.deepEqual(pendingFaqVersions(readFaqMigrationVersion(db)), []);
  });

  test('map 2 is unchanged - it is pinned, not edited in place', () => {
    assert.equal(FAQ_MIGRATION_VERSION, 2);
    assert.deepEqual(FAQ_MIGRATIONS[2].remap,
      { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 11: 10 });
    assert.deepEqual(FAQ_CATEGORY_REMAP, FAQ_MIGRATIONS[2].remap);
  });
});

describe('per-version migration table: bumping the version runs a NEW map', () => {
  // step2 is the real v2 map. step3 stands in for the map a future change adds.
  const step2 = { remap: FAQ_MIGRATIONS[2].remap, applyEntries: true, applyTemplates: true };
  const step3 = {
    remap: { 1: 1, 2: 1, 3: 1, 4: 1, 5: 1, 6: 1, 7: 1, 8: 1, 9: 1, 10: 1 },
    applyEntries: true,
    applyTemplates: true,
  };

  test('a database at 2 skips straight to step 3 - step 2 is not re-run', () => {
    const db = seedAtV2();
    const before = cats(db);
    assert.deepEqual(pendingFaqVersions(2, { 2: step2, 3: step3 }), [3],
      'pending steps include v2 for a database that already ran it');

    const moved = applyFaqMigrations(db, { 2: step2, 3: step3 }, 3);

    assert.ok(moved > 0, 'nothing ran - bumping to 3 activated nothing');
    assert.deepEqual(cats(db), [1, 1, 1, 1, 1], 'map 3 was not applied');
    assert.notDeepEqual(cats(db), before, 'nothing changed - this test would prove nothing');
    assert.equal(readFaqMigrationVersion(db), 3);
  });

  test('the hazard itself: applying v2 to v2 output shifts every category again', () => {
    // This is literally what bumping the string to '3' did under the old shape:
    // the v2 body stayed in place and ran a second time.
    const db = seedAtV2();
    const before = cats(db);
    runFaqStep(db, step2);
    assert.deepEqual(cats(db), [1, 1, 1, 3, 7],
      'v2 on its own output no longer shifted categories - the hazard would be gone');
    assert.notDeepEqual(cats(db), before, 'nothing moved - the test would prove nothing');
  });

  test('a fresh database at 0 still gets v2 (first-run behaviour unchanged)', () => {
    const db = openMemoryDb();
    db.prepare('DELETE FROM settings WHERE key = ?').run(KEY);
    seedCategories(db, [['a', 3], ['b', 5], ['c', 11]]);
    const moved = applyFaqMigrations(db, { 2: step2 }, 2);
    assert.equal(moved, 3, 'v2 did not run on a database at 0');
    assert.deepEqual(cats(db), [2, 4, 10]);
    assert.equal(readFaqMigrationVersion(db), 2);
  });

  test('a database ahead of the newest step is not downgraded', () => {
    const db = seedAtV2();
    setVersion(db, 5);
    const before = cats(db);
    applyFaqMigrations(db, { 2: step2 }, 2);
    assert.equal(readFaqMigrationVersion(db), 5, 'marker of an ahead-of-us database was downgraded');
    assert.deepEqual(cats(db), before);
  });
});

describe('duplicate source_message_id: reported, enforced, and never fatal at boot', () => {
  const insRow = (db, id, msg) => db.prepare(`INSERT INTO ticket_metrics
    (ticket_id, ticket_owner, claimer, closer, logged_by, source_message_id) VALUES (?, 'o', 'c', 'c', 'l', ?)`)
    .run(id, msg);

  test('a real duplicate is detected and its ids are reported', () => {
    const db = openMemoryDb();
    db.exec('DROP INDEX IF EXISTS idx_ticket_source_message');
    insRow(db, 't1', '900000000000000001');
    insRow(db, 't2', '900000000000000001');
    insRow(db, 't3', '900000000000000002');
    insRow(db, 't4', '900000000000000002');

    const duplicates = duplicateTicketSources(db);
    assert.equal(duplicates.length, 2, `detected ${duplicates.length} duplicate ids`);
    assert.deepEqual(duplicates.map(d => d.source_message_id).sort(),
      ['900000000000000001', '900000000000000002']);
    assert.ok(duplicates.every(d => d.copies === 2), 'copy count is wrong');

    // العطل يُسجَّل باسمه لا مرمياً: البوت يقلع، والسبب في مكان يُقرأ منه.
    ensureTicketSourceUniqueness(db);
    const fault = schemaFaults(db).find(f => f.step === 'ticket_source_unique');
    assert.ok(fault, 'لم يُسجَّل العطل');
    assert.match(fault.detail, /900000000000000001/, 'the message does not name the duplicate id');
    assert.match(fault.detail, /idx_ticket_source_message/, 'the message does not name the index');
    assert.match(fault.remediation, /DELETE FROM ticket_metrics/i, 'no remediation SQL for the operator');
  });

  test('a clean database: no duplicate, no fault, migrate() builds the index', () => {
    const db = openMemoryDb();
    insRow(db, 't1', '900000000000000001');
    assert.deepEqual(duplicateTicketSources(db), []);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_ticket_source_message'").get(),
      'the unique index is missing');
    assert.deepEqual(schemaFaults(db), []);
    assert.equal(ensureTicketSourceUniqueness(db).enforced, 'index');
  });

  test('several NULL source_message_id rows are not duplicates', () => {
    const db = openMemoryDb();
    db.exec('DROP INDEX IF EXISTS idx_ticket_source_message');
    insRow(db, 't1', null);
    insRow(db, 't2', null);
    insRow(db, 't3', null);
    assert.deepEqual(duplicateTicketSources(db), [], 'NULL was treated as a duplicate');
    migrate(db); // the partial index is built and still allows them
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='idx_ticket_source_message'").get());
  });

  test('booting onto a database with a duplicate still boots, and the cause is legible', () => {
    const db = openMemoryDb();
    db.exec('DROP INDEX IF EXISTS idx_ticket_source_message');
    insRow(db, 't1', '900000000000000001');
    insRow(db, 't2', '900000000000000001');
    // هذا كان مسار الإقلاع: getDb -> migrate -> CREATE UNIQUE INDEX، وكان يرمي
    // فيخرج من index.js بـ process.exit(1): بوت لا يقلع ولا شفاء ذاتي.
    let thrown = null;
    try { migrate(db); } catch (e) { thrown = e; }
    assert.equal(thrown, null, `البوت يرفض الإقلاع على بيانات قابلة للإصلاح: ${thrown && thrown.message}`);

    // والحارس البديل يحفظ الضمان نفسه: نفس الرسالة لا تُحتسب مرتين.
    assert.throws(() => insRow(db, 't3', '900000000000000001'),
      'uniqueness was silently dropped - the same external message can be counted twice');
    // والعطل مرئي على مسار الصحة بدل أن يختفي.
    const fault = schemaFaults(db).find(f => f.step === 'ticket_source_unique');
    assert.match(fault.detail, /900000000000000001/);
    assert.match(fault.detail, /source_message_id/);
    assert.doesNotMatch(fault.detail, /^SQLITE_/, 'still an opaque SQLite message');
  });
});

describe('schema sanity after all of the above', () => {
  test('mission_progress accepts either parent and requires one', () => {
    const db = openMemoryDb();
    const info = db.prepare('PRAGMA table_info(mission_progress)').all();
    const byName = Object.fromEntries(info.map(c => [c.name, c]));
    assert.ok(byName.task_id, 'task_id column is missing');
    assert.equal(byName.mission_id.notnull, 0, 'mission_id is still NOT NULL');
    assert.equal(byName.user_id.notnull, 1);
    assert.ok(getDb());
  });
});