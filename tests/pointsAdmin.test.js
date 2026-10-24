'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const { commands } = require('../src/commands');
const points = require('../src/services/points');

// عقود /points-admin (واجهة D4 الموثّقة): القيمة ثابتة من POINTS_DEFAULTS،
// السبب محصور، والمرجع الإلزامي يمنع منح نفس الثغرة مرتين.

beforeEach(() => openMemoryDb());

const M = '777888999000111222'; // المانح (الإدارة)
const TARGET = '999888777666555444';
const cmd = commands.get('points-admin');
assert.ok(cmd, 'الأمر مسجّل في السجل');

function seedStaff(id, status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, 'support', 'Support Expert', ?)`).run(id, id, status);
}

function interaction(targetId, ref = 'bug-2026-014') {
  const bag = {
    user: { id: M },
    channelId: 'ch1',
    options: {
      getUser: () => (targetId ? { id: targetId } : null),
      getString: key => {
        if (key === 'reason') return 'bug_found';
        if (key === 'ref') return ref;
        if (key === 'note') return 'ثغرة صلاحيات في لوحة التدقيق';
        return null;
      },
    },
    reply: async p => { bag.last = p; },
  };
  return bag;
}

const textOf = bag => bag.last.embeds[0].toJSON().description;

test('منح موثّق يمنح +5 بمرجع الحالة ويحدّث الرصيد', async () => {
  seedStaff(M);
  seedStaff(TARGET);
  const bag = interaction(TARGET);
  await cmd.execute(bag);
  assert.match(textOf(bag), /مُنح/);
  assert.match(textOf(bag), /bug-2026-014/, 'المرجع يظهر في الرد ليُقارن به السجل');
  assert.equal(points.getBalance(TARGET), 5, 'قيمة bug_found ثابتة 5');
  // الأثر في الدفتر بمرجع فريد قياساً مستقبلاً
  const row = getDb().prepare(`SELECT ref_type, ref_id, added_by FROM promotion_points WHERE user_id = ?`).get(TARGET);
  assert.equal(row.ref_type, 'bug');
  assert.equal(row.ref_id, 'bug-2026-014');
  assert.equal(row.added_by, M);
});

test('نفس المرجع لا يُكرّر المنح — الثغرة الواحدة مكافأة واحدة', async () => {
  seedStaff(M);
  seedStaff(TARGET);
  await cmd.execute(interaction(TARGET));
  const again = interaction(TARGET);
  await cmd.execute(again);
  assert.match(textOf(again), /ممنوح من قبل/);
  assert.equal(points.getBalance(TARGET), 5, 'الرصيد ثابت بعد محاولة التكرار');
});

test('غير المسجل يُرفض بلا كتابة في الدفتر', async () => {
  seedStaff(M);
  const bag = interaction('11199988877766655');
  await cmd.execute(bag);
  assert.match(textOf(bag), /ليس في سجل الإداريين/);
});

test('المجمَّد تُعطَّل المنحة بسببه الصريح ولا يُمنح شيء', async () => {
  seedStaff(M);
  seedStaff(TARGET);
  points.freeze(TARGET, 5, 'مخالفة جسيمة');
  const bag = interaction(TARGET);
  await cmd.execute(bag);
  assert.match(textOf(bag), /مجمّدة/);
  assert.equal(points.getBalance(TARGET), 0);
});
