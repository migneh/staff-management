'use strict';
/**
 * ⑯ — تغطية enrichDuration في services/ticketLogs.js.
 * حين لا يذكر الإغلاق المدة، تُحسب من فرق الوقت بين رسالة المطالبة السابقة
 * (أقرب رسالة تشير إلى رقم التكت) ورسالة الإغلاق، بالدقائق، مع وسم
 * durationSource='computed'. لا قاعدة بيانات: المُختبَر تحليل الرسائل فقط.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const ticketLogs = require('../src/services/ticketLogs');

/** رسالة إغلاق فوق قناة بمحفوظات تقول كلامها. */
function closingMessage({ history = [], closeAt = 1735689600000, fail = false } = {}) {
  return {
    id: 'closing-1',
    createdTimestamp: closeAt,
    channel: {
      messages: {
        fetch: async () => {
          if (fail) throw new Error('history down');
          return history;
        },
      },
    },
  };
}

/** رسالة مطالبة سابقة في المحفوظات تشير إلى التكت بنصها أو إمبدها. */
function claimMessage({ id = 'claim-1', at = 1735689600000, ticketId = 'TKT-100', embedFields = false } = {}) {
  return {
    id,
    createdTimestamp: at,
    content: embedFields ? 'نص لا يذكّر بشيء' : `تم الاستلام للبيكات ${ticketId}`,
    embeds: embedFields
      ? [{ title: 'بلا رقم', description: 'شكوى بلا رقم', url: null, fields: [{ name: 'التكت', value: ticketId }] }]
      : [],
  };
}

describe('ticketLogs.enrichDuration — حساب المدة من القناة (⑯)', () => {
  test('تجد رسالة المطالبة بالنص: المدة بالدقائق ومصدّها computed', async () => {
    const closeAt = 1735689600000;
    const parse = { ticketId: 'TKT-100', ticketUrl: null, duration: null };
    const result = await ticketLogs.enrichDuration(closingMessage({
      closeAt,
      history: [claimMessage({ at: closeAt - 90 * 60000 })],
    }), parse);
    assert.equal(result.duration, 90);
    assert.equal(result.durationSource, 'computed');
    assert.match(result.claimedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  test('المطالبة في إمبد لا نصّ: الرقم يُلتقط من حقل إمبد أيضاً', async () => {
    const closeAt = 1735689600000;
    const result = await ticketLogs.enrichDuration(closingMessage({
      closeAt,
      history: [claimMessage({ at: closeAt - 30 * 60000, ticketId: 'TKT-200', embedFields: true })],
    }), { ticketId: 'TKT-200', ticketUrl: null, duration: null });
    assert.equal(result.duration, 30);
    assert.equal(result.durationSource, 'computed');
  });

  test('رسالة مطالبة صريحة مدتها معروفة لا تُمسّ: التسجيل اليدوي هو الأصدق', async () => {
    const closeAt = 1735689600000;
    const result = await ticketLogs.enrichDuration(closingMessage({
      history: [claimMessage({ at: closeAt - 90 * 60000 })],
    }), { ticketId: 'TKT-300', duration: 5 });
    assert.equal(result.duration, 5);
    assert.equal(result.durationSource, undefined);
    assert.equal(result.claimedAt, undefined);
  });

  test('بلا مطابقة في المحفوظات: المدة تبقى فارغة بلا وسم computed', async () => {
    const closeAt = 1735689600000;
    const parse = { ticketId: 'TKT-400', ticketUrl: null, duration: null };
    const result = await ticketLogs.enrichDuration(closingMessage({
      closeAt,
      history: [claimMessage({ at: closeAt - 20 * 60000, ticketId: 'OTHER-1' })],
    }), parse);
    assert.equal(result.duration, null);
    assert.equal(result.durationSource, undefined);
  });

  test('قناة بلا محفوظات أو بلا مفتاح تكت: تعود الصيغة كما وردت, بلا زمن', async () => {
    const parse = { ticketId: null, ticketUrl: null, duration: null };
    assert.deepEqual(await ticketLogs.enrichDuration(closingMessage({}), parse), parse);
    const parse2 = { ticketId: 'TKT-500', ticketUrl: null, duration: null };
    assert.deepEqual(await ticketLogs.enrichDuration({ id: 'x' }, parse2), parse2);
    assert.equal(parse2.duration, null);
  });

  test('فشل جلب المحفوظات يُبتلع: تعود الصيغة كما وردت بلا قذف', async () => {
    const closeAt = 1735689600000;
    const parse = { ticketId: 'TKT-600', ticketUrl: null, duration: null };
    const result = await ticketLogs.enrichDuration(closingMessage({ fail: true }), parse);
    assert.equal(result.duration, null);
    assert.equal(result.durationSource, undefined);
    assert.deepEqual(result, parse);
  });
});
