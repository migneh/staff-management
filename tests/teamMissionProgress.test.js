'use strict';
/**
 * سلامة المهمة الجماعية: من هو «الأب» فعلاً، ومن يرجع إليه سجل التقدّم.
 *
 * كان createTeamMission يضع mission_id = mission.id (رقم staff_tasks.id) في عمود
 * نصي، فيخزّن «3.0»؛ و completeTeamMission يقرأ mission_id من الأم (فارغ) ثم
 * يُدرج في mission_progress فيرمي SQLITE_CONSTRAINT_NOTNULL على كل نداء. ولو
 * أُصلح ذلك وحده لوقع القيد الأجنبي: 3.0 ليست mission_templates.id.
 *
 * القرار المطبَّق: (ب) — الأم صفٌّ في staff_tasks. القالب شيء آخر (مجموعة مهام
 * معرَّفة مسبقاً يقرؤها tasks.createFromTemplate)، فحشر مهمة جماعية في
 * mission_templates كان ترحيلاً للواقع داخل دليل بيانات حقيقي.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb, migrate, migrateLegacyTeamChildren } = require('../src/database');
const tasks = require('../src/services/tasks');

const TEAM = 'support';

function seedStaff(...ids) {
  const db = getDb();
  for (const id of ids) {
    db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
      VALUES (?, ?, ?, 'Support', 'active')
      ON CONFLICT(user_id) DO UPDATE SET team = excluded.team, status = 'active'`).run(id, id, TEAM);
  }
}

/** Someone outside the team: a staff member, but not on this mission's roster. */
function seedOtherTeamStaff(id) {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'moderation', 'Moderator', 'active')`).run(id, id);
}

const progress = (taskId) => getDb().prepare('SELECT * FROM mission_progress WHERE task_id = ? ORDER BY user_id').all(taskId);
const childrenOf = (id) => getDb().prepare('SELECT * FROM staff_tasks WHERE parent_task_id = ? ORDER BY user_id').all(id);

/** Helper: aggregates mission_progress exactly the way /missions progress does. */
const teamProgressCounts = (team) => {
  const db = getDb();
  return {
    total: db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE team_id = ?').get(team).c,
    completed: db.prepare("SELECT COUNT(*) c FROM mission_progress WHERE team_id = ? AND status = 'completed'").get(team).c,
    pending: db.prepare("SELECT COUNT(*) c FROM mission_progress WHERE team_id = ? AND status = 'pending'").get(team).c,
  };
};

describe('المهمة الجماعية: الإنشاء ثم الإكمال لا يرمي', () => {
  beforeEach(() => { openMemoryDb(); });

  test('createTeamMission ثم completeTeamMission يُنجزان بلا استثناء', () => {
    seedStaff('u1', 'u2');
    const parent = tasks.createTeamMission(TEAM, 'تنظيف الدفتر', 'وصف', '2026-12-01', 'boss');
    assert.ok(parent?.id, 'لم يُنشأ الصف الأم');
    assert.equal(childrenOf(parent.id).length, 2, 'لم يُنشأ صف لكل عضو');

    let thrown = null;
    let result = null;
    try { result = tasks.completeTeamMission(parent.id, 'u1'); } catch (e) { thrown = e; }
    assert.equal(thrown, null, `completeTeamMission رماها: ${thrown && thrown.message}`);
    assert.ok(result && result.task, 'لم يُعَد سجل المهمة');
    assert.equal(result.missionCompleted, false, 'لا يُعلن اكتمال المهمة الجماعية بعد أول عضو');
  });

  test('الأبناء يحملون parent_task_id ويتركون mission_id مرجعاً للقوالب فقط', () => {
    seedStaff('u1', 'u2');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    for (const child of childrenOf(parent.id)) {
      assert.equal(child.mission_id, null, `ابن المهمة يحمل mission_id = ${child.mission_id} — مرجع قالب لا رقم مهمة`);
      assert.equal(child.parent_task_id, parent.id);
    }
    assert.equal(tasks.get(parent.id).mission_id, null, 'الأم لا تحمل مرجع قالب');
  });

  test('سجل التقدّم يشير إلى mission_progress.task_id حقيقي، لا إلى mission_templates', () => {
    seedStaff('u1', 'u2');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    const rows = progress(parent.id);
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.task_id, parent.id);
      assert.equal(row.mission_id, null);
      assert.equal(row.status, 'pending');
    }
  });

  test('the parent reference is really constrained: a bogus parent id is rejected', () => {
    seedStaff('u1');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    const db = getDb();
    let thrown = null;
    try {
      db.prepare("INSERT INTO mission_progress (task_id, team_id, user_id, status) VALUES (999999, ?, 'u1', 'pending')")
        .run(TEAM);
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'قُبل معرّف أم غير موجود — القيد الأجنبي على task_id غير مفعّل');
    assert.match(thrown.code || '', /FOREIGNKEY/, `الخطأ ليس قيداً أجنبياً: ${thrown && thrown.message}`);
    assert.equal(progress(parent.id).length, 1, 'الصف المرفوض يجب ألا يكون قد أُدخل');
  });

  test('لا صف تقدّم بلا أب: mission_id و task_id فارغان معاً يُرفضان', () => {
    seedStaff('u1');
    let thrown = null;
    try {
      getDb().prepare("INSERT INTO mission_progress (team_id, user_id, status) VALUES (?, 'u1', 'pending')").run(TEAM);
    } catch (e) { thrown = e; }
    assert.ok(thrown, 'قُبل صف بلا أي مرجع — القيد CHECK غير موجود');
  });

  test('العدّ الجماعي صحيح: لا يُعلن الاكتمال إلا بعد آخر عضو', () => {
    seedStaff('u1', 'u2', 'u3');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    assert.deepEqual(teamProgressCounts(TEAM), { total: 3, completed: 0, pending: 3 });

    const first = tasks.completeTeamMission(parent.id, 'u1');
    assert.equal(first.missionCompleted, false);
    assert.equal(tasks.get(parent.id).status, 'pending', 'الأم تُعلَّم مكتملة قبل اكتمال الجموع');

    tasks.completeTeamMission(parent.id, 'u2');
    const last = tasks.completeTeamMission(parent.id, 'u3');
    assert.equal(last.missionCompleted, true, 'آخر عضو يجب أن يُغلق المهمة الجماعية');
    assert.equal(tasks.get(parent.id).status, 'completed');
    assert.deepEqual(teamProgressCounts(TEAM), { total: 3, completed: 3, pending: 0 });
  });

  test('الإكمال مرن: يُقبل صف عضو فيُرجع إلى أمّه', () => {
    seedStaff('u1', 'u2');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    const child = childrenOf(parent.id)[0];
    const result = tasks.completeTeamMission(child.id, child.user_id);
    assert.equal(result.task.id, parent.id, 'أُعيد صف الأم لا صف العضو');
    assert.equal(progress(parent.id).find(r => r.user_id === child.user_id).status, 'completed');
  });

  test('عضو خارج كشف الإسناد لا يُحتسب ولا يُنهي المهمة الجماعية', () => {
  seedStaff('u1', 'u2');
  seedOtherTeamStaff('outsider');
  const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
  assert.equal(progress(parent.id).length, 2, 'الكشف يجب أن يحوي عضوين فقط');

  const result = tasks.completeTeamMission(parent.id, 'outsider');
  assert.equal(result.recorded, false, 'كُتب تقدّم لعضو ليس على الكشف');
  assert.equal(result.missionCompleted, false);
  assert.equal(progress(parent.id).length, 2, 'أُضيف صف جديد للكشف');
  assert.equal(tasks.get(parent.id).status, 'pending');
});

test('مهمة جماعية قديمة بلا كشف إسناد تُسجَّل عند أول إكمال', () => {
  // team mission created before this fix: no mission_progress rows at all.
  seedStaff('u1', 'u2');
  const db = getDb();
  const parentId = Number(db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, team_id)
    VALUES ('team:support', 'قديمة', 'mission', ?)`).run(TEAM).lastInsertRowid);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE task_id = ?').get(parentId).c, 0);

  const result = tasks.completeTeamMission(parentId, 'u1');
  assert.equal(result.recorded, true, 'مهمة بلا كشف لم تُسجَّل');
  assert.equal(result.missionCompleted, true);
});

test('إكمال صف ليس مهمة جماعية يعيد null ولا يكتب شيئاً', () => {
    seedStaff('u1');
    const solo = tasks.create({ userId: 'u1', title: 'مهمة عامة', taskType: 'general' });
    assert.equal(tasks.completeTeamMission(solo.id, 'u1'), null);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM mission_progress').get().c, 0);
  });
});

describe('المهمة الجماعية: المسار القابل للوصول فعلاً', () => {
  beforeEach(() => { openMemoryDb(); });

  test('إنهاء العضو لصفه عبر complete() يسجّل تقدّمه — وهو ما يقرأه /missions progress', () => {
    // mission:complete في src/commands/missions.js:94 يستدعي complete لا
    // completeTeamMission، فبلا هذا الربط تبقى كل الصفوف عند 'pending' للأبد
    // ويعرض /missions progress نسبة 0% مهما اكتمل كل شيء.
    seedStaff('u1', 'u2');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    const child = childrenOf(parent.id)[0];

    const before = teamProgressCounts(TEAM);
    assert.deepEqual(before, { total: 2, completed: 0, pending: 2 });
    tasks.complete(child.id, child.user_id);

    const after = teamProgressCounts(TEAM);
    assert.equal(after.completed, 1, 'إنهاء العضو لصفه لم يُسجَّل في mission_progress');
    assert.equal(after.pending, 1);
  });

  test('complete() لا يمس صف تقدّم لغير مهمة جماعية', () => {
    seedStaff('u1');
    const solo = tasks.create({ userId: 'u1', title: 'عامة', taskType: 'general' });
    tasks.complete(solo.id, 'u1');
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM mission_progress').get().c, 0);
  });
});

describe('ترقية قاعدة قديمة: mission_progress بمفتاح أجنبي على القوالب', () => {
  // The shipped schema had `mission_id TEXT NOT NULL REFERENCES mission_templates(id)`.
  // ALTER TABLE cannot lift NOT NULL or a foreign key in SQLite, so this shape is
  // upgraded by rebuilding the table - a path openMemoryDb() never exercises,
  // because it builds the new shape from the start. Without this test the
  // migration that every live database actually needs would ship untested.
  const LEGACY_DDL = `CREATE TABLE mission_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT NOT NULL,
      team_id TEXT,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      completed_at TEXT,
      assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (mission_id) REFERENCES mission_templates(id),
      FOREIGN KEY (user_id) REFERENCES staff_members(user_id)
    )`;

  function legacyDb() {
    const db = openMemoryDb();
    db.exec('DROP TABLE mission_progress;');
    db.exec(LEGACY_DDL);
    db.prepare(`INSERT INTO mission_templates (id, name, description, category, tasks, created_by)
      VALUES ('security_baseline', 'q', 'd', 'security', '[]', 'boss')`).run();
    db.prepare("INSERT INTO staff_members (user_id, username, team, rank, status) VALUES ('u1','u1','support','Support','active')").run();
    return db;
  }

  test('الجدول القديم يُعاد بناؤه: task_id يظهر و mission_id يفقد NOT NULL', () => {
    const db = legacyDb();
    db.prepare("INSERT INTO mission_progress (mission_id, team_id, user_id) VALUES ('security_baseline', ?, 'u1')").run(TEAM);

    migrate(db);

    const info = Object.fromEntries(db.prepare('PRAGMA table_info(mission_progress)').all().map(c => [c.name, c]));
    assert.ok(info.task_id, 'task_id لم يظهر بعد إعادة البناء');
    assert.equal(info.mission_id.notnull, 0, 'mission_id ما زال NOT NULL');
    const kept = db.prepare('SELECT * FROM mission_progress').all();
    assert.equal(kept.length, 1, 'الصف الصالح ضاع');
    assert.equal(kept[0].mission_id, 'security_baseline', 'مرجع القالب تغيّر');
    assert.equal(kept[0].task_id, null);
    assert.equal(kept[0].id, 1, 'المعرّف الأصلي لم يُحفظ');
  });

  test('صف لا قالب له ولا عضو يُسقَط بدل أن يوقف الإقلاع', () => {
    const db = legacyDb();
    db.prepare("INSERT INTO mission_progress (mission_id, team_id, user_id) VALUES ('security_baseline', ?, 'u1')").run(TEAM);
    // A legacy row can only exist like this: written while foreign_keys was off,
    // or written when the template it names was still there.
    db.pragma('foreign_keys = OFF');
    db.prepare("INSERT INTO mission_progress (mission_id, team_id, user_id) VALUES ('ghost_template', ?, 'u1')").run(TEAM);
    db.pragma('foreign_keys = ON');

    let thrown = null;
    try { migrate(db); } catch (e) { thrown = e; }
    assert.equal(thrown, null, `migrate رماها: ${thrown && thrown.message}`);
    const kept = db.prepare('SELECT * FROM mission_progress').all();
    assert.equal(kept.length, 1, 'الصف اليتيم بقي أو الصف السليم ضاع');
    assert.equal(kept[0].mission_id, 'security_baseline');
  });

  test('الفهرس على task_id موجود بعد إعادة البناء، والترحيل لا يتكرر', () => {
    const db = legacyDb();
    migrate(db);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_mission_progress_task'").get(),
      'فهرس task_id غير موجود');
    const sql = db.prepare("SELECT sql FROM sqlite_master WHERE name='mission_progress'").get().sql;
    migrate(db);
    assert.equal(db.prepare("SELECT sql FROM sqlite_master WHERE name='mission_progress'").get().sql, sql,
      'أُعيد البناء في التشغيل الثاني');
  });

  test('بعد الترقية تُقبل مهمة جماعية (task_id) وتُرفض قالب وهمي', () => {
    const db = legacyDb();
    migrate(db);
    seedStaff('u2');
    const parent = tasks.createTeamMission(TEAM, 'مهمة', 'وصف', null, 'boss');
    assert.equal(progress(parent.id).length, 2, 'التقدّم لم يُسجَّل بعد الترقية');
    assert.throws(() => db.prepare("INSERT INTO mission_progress (mission_id, user_id) VALUES ('ghost', 'u1')").run(),
      /FOREIGN KEY/, 'قيد القالب لم يبقَ مفعّلاً بعد إعادة البناء');
  });
});

describe('ترحيل الصفوف القديمة التي كتبها mission_id', () => {
  beforeEach(() => { openMemoryDb(); });

  test('صف ابن قديم (= mission_id نصّي مثل «1.0») ينتقل إلى parent_task_id', () => {
    seedStaff('u1', 'u2');
    const db = getDb();
    // Mirror what createTeamMission wrote before the fix: the parent has no mission_id,
    // and each child carries mission_id = mission.id stored as text.
    const parentId = Number(db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, team_id)
      VALUES ('team:support', 'مهمة جماعية قديمة', 'mission', ?)`).run(TEAM).lastInsertRowid);
    db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, team_id, mission_id)
      VALUES ('u1', 'مهمة جماعية قديمة', 'mission', ?, '1.0')`).run(TEAM);
    db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, team_id, mission_id)
      VALUES ('u2', 'مهمة جماعية قديمة', 'mission', ?, '1.0')`).run(TEAM);
    assert.equal(db.prepare('SELECT mission_id FROM staff_tasks WHERE user_id = ?').get('u1').mission_id, '1.0');

    migrateLegacyTeamChildren(db);

    const children = childrenOf(parentId);
    assert.equal(children.length, 2, 'لم يُنقل الابنان إلى الأم');
    for (const child of children) assert.equal(child.mission_id, null, 'بقي مرجع القالب الوهمي في mission_id');
    assert.equal(db.prepare('SELECT mission_id FROM staff_tasks WHERE id = ?').get(parentId).mission_id, null);
  });

  test('الترحيل آمن على التكرار: التشغيل الثاني لا يحرّك شيئاً', () => {
    seedStaff('u1');
    const db = getDb();
    db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, team_id, mission_id)
      VALUES ('u1', 'قديمة', 'mission', ?, '1.0')`).run(TEAM);
    migrateLegacyTeamChildren(db);
    const first = db.prepare('SELECT parent_task_id, mission_id FROM staff_tasks WHERE user_id = ?').get('u1');
    migrateLegacyTeamChildren(db);
    const second = db.prepare('SELECT parent_task_id, mission_id FROM staff_tasks WHERE user_id = ?').get('u1');
    assert.deepEqual(second, first);
    assert.equal(second.parent_task_id, 1);
    assert.equal(second.mission_id, null);
  });

  test('مرجع قالب حقيقي في mission_id لا يُلمس', () => {
    seedStaff('u1');
    const db = getDb();
    db.prepare(`INSERT INTO mission_templates (id, name, description, category, tasks, created_by)
      VALUES ('security_baseline', 'قالب', 'وصف', 'security', '[]', 'boss')`).run();
    db.prepare(`INSERT INTO staff_tasks (user_id, title, task_type, mission_id)
      VALUES ('u1', 'من قالب', 'mission', 'security_baseline')`).run();
    migrateLegacyTeamChildren(db);
    const row = db.prepare('SELECT mission_id FROM staff_tasks WHERE user_id = ?').get('u1');
    assert.equal(row.mission_id, 'security_baseline', 'الترحيل أكل مرجع قالب شرعي');
  });

  test('مهمة من قالب تسلك المسار الصحيح: mission_id قالب، لا رقم', () => {
    seedStaff('u1');
    const db = getDb();
    db.prepare(`INSERT INTO mission_templates (id, name, description, category, tasks, created_by)
      VALUES ('onboarding_v2', 'قالب', 'وصف', 'onboarding', ?, 'boss')`).run(JSON.stringify([{ title: 'خطوة' }]));
    const [task] = tasks.createFromTemplate('u1', 'onboarding_v2', 'boss');
    assert.equal(task.mission_id, 'onboarding_v2');
    assert.equal(task.parent_task_id, null, 'مهمة القالب ليست ابن مهمة جماعية');
  });
});
