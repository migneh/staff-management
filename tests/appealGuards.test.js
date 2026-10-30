'use strict';
/**
 * ⑯ — حراس الاستئناف الأمنيون في commands/appeals.js.
 * المسار السعيد (قبول الاستئناف وإلغاء الإنذار) مغطّى في phase3-4. هنا نغطّي
 * ما لا يجوز أن يمرّ: مراجعة معرّف مجهول، مراجعة استئنافك، مراجعة استئناف
 * إنذار أصدرته أنت، قبول استئناف لعضو غير مسجّل، ورفض الاستئناف.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';

const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const appeals = require('../src/commands/appeals');
const { commands } = require('../src/commands');
const settings = require('../src/services/settings');

/** مراجع وهمي: reply وupdate يلتقطان نصّ الردّ، والعميل يوصل القنوات والرسائل. */
function reviewer(id) {
  return {
    user: { id },
    channelId: 'review',
    client: {
      channels: { fetch: async () => ({ send: async () => {} }) },
      users: { fetch: async () => ({ send: async () => {} }) },
    },
    async reply(payload) { this.payload = payload; },
    async update(payload) { this.payload = payload; },
  };
}

/** نص ردّ الرفض: replyEphemeral يصدّر إمبد ووصفه هو النص. */
const textOf = payload => payload.embeds?.[0].toJSON().description || '';

function seedWarning(userId, issuedBy) {
  return getDb().prepare('INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, ?, ?, ?)')
    .run(userId, 'formal', 'سبب معياري', issuedBy);
}

function seedAppeal(warningId, userId) {
  return getDb().prepare('INSERT INTO warning_appeals (warning_id, user_id, reason) VALUES (?, ?, ?)')
    .run(warningId, userId, 'لدي دليل');
}

function seedStaff(id, team = 'moderation') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status)
    VALUES (?, ?, ?, 'Moderator', 'active')`).run(id, `u-${id}`, team);
}

beforeEach(() => {
  openMemoryDb();
  settings.setChannel('manager-review', 'ch-1');
});

describe('استئنافات الإنذار — ما لا يجوز أن يمرّ (⑯)', () => {
  test('معرّف مجهول في قرار الاستئناف: نص الحراس الصريح ولا تغيير', async () => {
    const actor = reviewer('other-1');
    await appeals.components['appeal:approve'](actor, ['999']);
    assert.match(textOf(actor.payload), /الاستئناف غير موجود أو تمت مراجعته/);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM warning_appeals').get().c, 0);
  });

  test('مقدّم الاستئناف لا يقرر مصير استئنافه', async () => {
    seedStaff('warned');
    const warning = seedWarning('warned', 'issuer-1');
    const appeal = seedAppeal(warning.lastInsertRowid, 'warned');
    const self = reviewer('warned');
    await appeals.components['appeal:approve'](self, [String(appeal.lastInsertRowid)]);
    const row = getDb().prepare('SELECT status, reviewed_by FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid);
    assert.equal(row.status, 'pending', 'قرار صاحب الاستئناف لا يُعمَّل أبداً');
    assert.equal(row.reviewed_by, null);
    assert.match(textOf(self.payload), /لا يمكنك مراجعة استئنافك الخاص/);
  });

  test('مُصدر الإنذار لا يحكم على استئناف إنذاره', async () => {
    seedStaff('warned');
    const warning = seedWarning('warned', 'issuer-1');
    const appeal = seedAppeal(warning.lastInsertRowid, 'warned');
    const issuer = reviewer('issuer-1');
    await appeals.components['appeal:reject'](issuer, [String(appeal.lastInsertRowid)]);
    const row = getDb().prepare('SELECT status, reviewed_by FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid);
    assert.equal(row.status, 'pending', 'حُكم مُصدر الإنذار على استئنافه لا يُعمَّل');
    assert.equal(row.reviewed_by, null);
    assert.match(textOf(issuer.payload), /مراجعة استئناف إنذار أصدرته أنت/);
  });

  test('قبول استئناف لعضو غير مسجّل: الحارس يحجبه والإنذار لا يُلغى', async () => {
    const warning = seedWarning('ghost-1', 'issuer-1'); // ghost-1 بلا صف إداري
    const appeal = seedAppeal(warning.lastInsertRowid, 'ghost-1');
    const actor = reviewer('other-2');
    await appeals.components['appeal:approve'](actor, [String(appeal.lastInsertRowid)]);
    assert.match(textOf(actor.payload), /العضو غير مسجل حالياً/);
    const warningRow = getDb().prepare('SELECT voided_at FROM warnings WHERE id = ?').get(warning.lastInsertRowid);
    assert.equal(warningRow.voided_at, null, 'قبول محجوب لا يُلغي الإنذار');
    assert.equal(getDb().prepare('SELECT status FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid).status, 'pending');
  });

  test('مسار الرفض: حالة rejected والإنذار باقٍ ولا يُلغى', async () => {
    seedStaff('warned');
    const warning = seedWarning('warned', 'issuer-1');
    const appeal = seedAppeal(warning.lastInsertRowid, 'warned');
    const actor = reviewer('other-3');
    await appeals.components['appeal:reject'](actor, [String(appeal.lastInsertRowid)]);
    const appealRow = getDb().prepare('SELECT * FROM warning_appeals WHERE id = ?').get(appeal.lastInsertRowid);
    assert.equal(appealRow.status, 'rejected');
    assert.equal(appealRow.reviewed_by, 'other-3');
    const warningRow = getDb().prepare('SELECT voided_at FROM warnings WHERE id = ?').get(warning.lastInsertRowid);
    assert.equal(warningRow.voided_at, null, 'الرفض لا يمسّ الإنذار نفسه');
  });
});

describe('أمر استئناف الإنذار — طلب العضو نفسه (⑯)', () => {
  test('إنذار غير موجود أو مُلغى مسبقاً: نص الحراس الصريح بلا دلالة مزدوجة', async () => {
    seedStaff('warned');
    const actor = reviewer('warned');
    actor.options = { getInteger: k => (k === 'warning_id' ? 777 : null), getString: k => (k === 'reason' ? 'سبب' : null) };
    await commands.get('appeal-warning').execute(actor);
    assert.match(textOf(actor.payload), /الإنذار غير موجود في سجلك/);
  });

  test('منع استئناف مكرّر: استئناف مفتوح واحد لكل إنذار', async () => {
    seedStaff('warned');
    const warning = seedWarning('warned', 'issuer-1');
    const first = reviewer('warned');
    first.options = { getInteger: k => (k === 'warning_id' ? Number(warning.lastInsertRowid) : null), getString: k => (k === 'reason' ? 'سبب أول' : null) };
    await commands.get('appeal-warning').execute(first);
    assert.match(textOf(first.payload), /تم تسجيل الاستئناف/);

    const duplicate = reviewer('warned');
    duplicate.options = { getInteger: k => (k === 'warning_id' ? Number(warning.lastInsertRowid) : null), getString: k => (k === 'reason' ? 'سبب ثاني' : null) };
    await commands.get('appeal-warning').execute(duplicate);
    assert.match(textOf(duplicate.payload), /يوجد استئناف مفتوح مسبقاً/);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM warning_appeals').get().c, 1);
  });
});
