'use strict';
/**
 * بوابة الإجازات المتزامنة — اختبار في حالة الرفض، لا في حالة العدّ.
 *
 * سببوجوده: الإيجاد رقم 4 من تدقيق الاختبارات. الاختبار القائم يعدّ
 * concurrentApproved() وينجح، لكن طفرة على البوابة نفسها
 * (`if (c >= global.maxConcurrent)` ← `if (false)`) كانت تمرر 400/400 —
 * أي أن الحد يمكن حذفه والاختبار يبقى أخضر. عدّ الشيء لا يحرس رفضه.
 *
 * يثبّت ثلاثة أمور:
 *   (أ) البوابة ترفض فعلاً عند البلوغ إلى الحد (حالة الرفض).
 *   (ب) الرفض مقنون بـ atApproval: طلب العضو مسموح، الاعتماد هو
 *       الممنوع — قرار مقصود في src/services/leaves.js:338.
 *   (ج) سلوك الحدّ نفسه: عند العدّ == الحد يُرفض، وعند الحد - 1 يمر —
 *       يميّز `>=` عن `>`.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const leaves = require('../src/services/leaves');
const settings = require('../src/services/settings');
const { today, addDays } = require('../src/utils');

openMemoryDb();

const approveLeave = (userId, start, end) =>
  getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status) VALUES (?, 'normal', 'r', ?, ?, 'approved')`)
    .run(userId, start, end);

describe('بوابة الإجازات المتزامنة', () => {
  test('ترفض الاعتماد عند بلوغ الحد، وتبقى مسارَ الطلب مفتوحاً', () => {
    settings.setPolicy('leaveMaxConcurrent', 1);
    const start = addDays(today(), 7);
    const end = addDays(today(), 8);
    const atApproval = () => leaves.validate({ userId: 'u2', leaveType: 'normal', start, end, atApproval: true });

    // ضابط: قبل أي إجازة معتمدة، البوابة لا ترفض — وإلا كان الرفض
    // الآتي من بوابة أخرى والاختبار لا يثبت شيئاً.
    const control = atApproval();
    assert.equal(control.ok, true, `الضابط فشل — الرفض لا مصدره الحد: ${JSON.stringify(control)}`);

    approveLeave('u1', start, end);

    const rejected = atApproval();
    assert.equal(rejected.ok, false, 'البوابة لم ترفض مع بلوغ الحد');
    assert.equal(rejected.code, 'concurrent', `الرفض من بوابة أخرى: ${JSON.stringify(rejected)}`);

    // قرار مقصود: الحد يمنع الاعتماد لا إيداع الطلب (leaves.js:338).
    const requested = leaves.validate({ userId: 'u2', leaveType: 'normal', start, end, atApproval: false });
    assert.equal(requested.ok, true, `طلب العضو كان يجب أن يمر: ${JSON.stringify(requested)}`);
  });

  test('تقارن >= لا >: عند العدد == الحد ترفض، وعند الحد - 1 تمر', () => {
    const start = addDays(today(), 20);
    const end = addDays(today(), 21);
    approveLeave('u1', start, end);
    approveLeave('u3', start, end); // عدّان متداخلان في الفترة نفسها

    const probe = () => leaves.validate({ userId: 'u4', leaveType: 'normal', start, end, atApproval: true });

    settings.setPolicy('leaveMaxConcurrent', 3);
    const below = probe();
    assert.equal(below.ok, true, `العدد 2 والحد 3 كان يجب أن يمر: ${JSON.stringify(below)}`);

    settings.setPolicy('leaveMaxConcurrent', 2);
    const atCap = probe();
    assert.equal(atCap.ok, false, 'العدد == الحد كان يجب أن يُرفض');
    assert.equal(atCap.code, 'concurrent', `رفض من بوابة أخرى: ${JSON.stringify(atCap)}`);
  });
});
