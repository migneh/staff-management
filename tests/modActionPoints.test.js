'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const logging = require('../src/commands/logging');
const points = require('../src/services/points');

// عقود منح نقاط الإجراءات الجادّة (موجة نقاط 2026-10-24):
// المرجع هو صف mod_actions نفسه، والروتين اليومي بلا نقاط.

beforeEach(() => openMemoryDb());

const MOD = '111111111111111111';

function seedStaff(id, team = 'moderation', rank = 'Moderator') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, ?, ?, 'active')`).run(id, id, team, rank);
}

function addAction(modId, type = 'warn') {
  return Number(getDb().prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason)
    VALUES (?, '999888777666555444', ?, 'سبب اختبار')`).run(modId, type).lastInsertRowid);
}

test('إجراء جادّ يمنح +2 بمرجع الصف، وإعادة نفس المرجع لا تمنح مرتين', () => {
  seedStaff(MOD);
  const rowId = addAction(MOD, 'warn');
  const r = logging.awardModActionPoints({ moderatorId: MOD, rowId, actionType: 'warn' });
  assert.equal(r.ok, true, `يجب أن يُمنح: ${r.reason}`);
  assert.equal(r.points, 2, 'قيمة mod_action ثابتة عند 2 (CONSTANTS لا إعدادات)');
  assert.equal(points.getBalance(MOD), 2);

  const again = logging.awardModActionPoints({ moderatorId: MOD, rowId, actionType: 'warn' });
  assert.equal(again.ok, false, 'فهرس UNIQUE على reason/ref يمنع المنح المزدوج');
  assert.match(String(again.reason), /مكر/);
  assert.equal(points.getBalance(MOD), 2, 'الرصيد ثابت بعد محاولة التكرار');
});

test('الروتين اليومي (حذف/فويس/اسم) بلا نقاط — لا راتب حضور', () => {
  seedStaff(MOD);
  const rowId = addAction(MOD, 'delete');
  const r = logging.awardModActionPoints({ moderatorId: MOD, rowId, actionType: 'delete' });
  assert.equal(r.ok, false);
  assert.equal(r.routine, true, 'الروتين وسام صريح لا رفض مجهول');
  assert.equal(points.getBalance(MOD), 0);
});

test('كل الإجراءات الجادّة الأربعة تمنح بقيمتها — قائمة واحدة للنقاط والنزاعات', () => {
  seedStaff(MOD);
  for (const type of ['warn', 'timeout', 'kick', 'ban']) {
    const r = logging.awardModActionPoints({ moderatorId: MOD, rowId: addAction(MOD, type), actionType: type });
    assert.equal(r.ok, true, `${type} جادّ ويُمنح: ${r.reason}`);
  }
  assert.equal(points.getBalance(MOD), 8, 'أربعة إجراءات × 2');
});

test('المجمَّد لا يجمع — المنح يُرفض بسببه صريحاً', () => {
  seedStaff(MOD);
  points.freeze(MOD, 7, 'مخالفة جسيمة');
  const r = logging.awardModActionPoints({ moderatorId: MOD, rowId: addAction(MOD, 'warn'), actionType: 'warn' });
  assert.equal(r.ok, false);
  assert.match(String(r.reason), /مج/);
  assert.equal(r.freezeReason, 'مخالفة جسيمة', 'سبب التجميد يرجع كما هو ليعرض');
  assert.equal(points.getBalance(MOD), 0);
});

test('غير المسجل في الدفتر رفضه صريح لا صامت', () => {
  const r = logging.awardModActionPoints({ moderatorId: '222222222222222222', rowId: 1, actionType: 'warn' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'غير مسجل كإداري');
});
