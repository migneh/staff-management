'use strict';
/**
 * كل اسم يُستدعى من services/staff.js يجب أن يكون مُصدَّراً فعلاً.
 *
 * كان `recordRankChange` مستدعى في أربعة مواضع (resignations.js, governance.js ×2,
 * scheduler.js) وغير مُصدَّر إطلاقاً، فكان كل استدعاء يرمي
 * `TypeError: staffService.recordRankChange is not a function` — بعد أن تكون
 * الكتابة قد نجحت فعلاً: القبول كان يلتزم setStatus('resigned') ثم يرمي، فيرى
 * المستخدم "فشل" على عملية تمت. هذا هو أسوأ شكل للخلل: يُبلَّغ عن الفشل-alert
 * والبيانات قد تغيّرت.
 *
 * حارسان: تصديرٌ صحيح، وأسماء مستدعاة لا تسقط.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { openMemoryDb, getDb } = require('../src/database');
const staff = require('../src/services/staff');

const SRC = path.join(__dirname, '..', 'src');

/** كل ملفات JS في src/، عدا node_modules */
function jsFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

test.before(() => { openMemoryDb(); });

test('appendRankChange مُصدَّر ويستقبل التوقيع الكائني', () => {
  assert.equal(typeof staff.appendRankChange, 'function');
  staff.appendRankChange({
    userId: 'u1', team: 'support', fromRank: 'Support', toRank: 'Support',
    changeType: 'remove', reason: 'اختبار', actorId: 'admin',
  });
  const row = getDb().prepare('SELECT * FROM staff_rank_history WHERE user_id = ?').get('u1');
  assert.ok(row, 'لم يُكتب سطر في تاريخ الرتب');
  assert.equal(row.change_type, 'remove');
  assert.equal(row.team, 'support');
  assert.equal(row.actor_id, 'admin');
  assert.equal(row.reason, 'اختبار');
});

test('toRank = null افتراضياً — الإزالة لا تكتب رتبة جديدة', () => {
  staff.appendRankChange({ userId: 'u2', team: 'support', fromRank: 'Support', changeType: 'remove' });
  const row = getDb().prepare('SELECT * FROM staff_rank_history WHERE user_id = ?').get('u2');
  assert.equal(row.to_rank, null);
});

test('كل اسم يُستدعى على staffService موجود في التصدير', () => {
  // eslint-disable-next-line global-require
  const re = /staffService\s*\.\s*([A-Za-z_$][\w$]*)/g;
  const missing = new Map();
  for (const file of jsFiles()) {
    const src = fs.readFileSync(file, 'utf8');
    for (const m of src.matchAll(re)) {
      const name = m[1];
      if (staff[name] !== undefined) continue;
      // selfHeal/hiddenHits وأسماء من كائنات أخرى لا تمرّ على staffService
      if (!missing.has(name)) missing.set(name, []);
      missing.get(name).push(`${path.relative(SRC, file)}:${src.slice(0, m.index).split('\n').length}`);
    }
  }
  const bad = [...missing.entries()].filter(([n]) => !['then', 'catch', 'constructor'].includes(n));
  assert.deepEqual(bad, [], `أسماء غير مُصدَّرة: ${bad.map(([n, s]) => `${n} (${s.join(', ')})`).join(' | ')}`);
});

test('appendRankChange يكتب داخل معاملة مع تحديثه إن وُجد', () => {
  // setRank وsyncDeparture وmarkLeft يغلّفون التحديث + السجل في معاملة واحدة؛
  // نتأكد أن appendRankChange ما زالت صالحة للاستدعاء المستقل.
  const before = getDb().prepare('SELECT COUNT(*) c FROM staff_rank_history').get().c;
  staff.appendRankChange({ userId: 'u3', team: 'moderation', fromRank: 'Trial', toRank: 'Moderator', changeType: 'promote' });
  const after = getDb().prepare('SELECT COUNT(*) c FROM staff_rank_history').get().c;
  assert.equal(after, before + 1);
});
