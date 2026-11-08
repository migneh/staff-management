'use strict';
/**
 * خطوات الاسترجاع يجب أن تستهدف القاعدة التي يفتحها البوت فعلاً.
 *
 * كان `/backup-list` يطبع في خطوات الاسترجاع مساراً مثالياً ثابتاً
 * (`data/staff.db`) — بينما `deploy/staff-manager.service` يشغّل البوت على
 * `DB_PATH=/var/lib/staff-manager/staff.db`. من ينفّذ الخطوات الموثّقة على
 * ذلك النشر ينسخ النسخة فوق ملف لا يفتحه البوت أبداً، فيبقى البوت يعمل على
 * قاعدة قديمة أو تالفة. المبدأ: مسار القاعدة في النصّ هو نفسه مسار القاعدة
 * في الكود — مصدر واحد، `config.dbPath`.
 */
process.env.DB_PATH = '/var/lib/staff-manager/staff.db';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../src/config');
const backup = require('../src/services/backup');
const { commands } = require('../src/commands/backup');

const cmd = commands.find(c => c.data.name === 'backup-list');
assert.ok(cmd, 'أمر /backup-list غير موجود');

/** تفاعل وهمي يلتقط ما يُرسَل إلى Discord. */
function fakeInteraction() {
  const sent = { embeds: [] };
  return {
    sent,
    user: { id: '111' },
    channelId: '222',
    async deferReply() {},
    async editReply(payload) {
      if (payload && payload.embeds) sent.embeds.push(...payload.embeds);
      return payload;
    },
  };
}

function descriptionOf(i) {
  return i.sent.embeds.map(e => e.data?.description || e.description || '').join('\n');
}

test('خطوات الاسترجاع في /backup-list تستهدف مسار القاعدة المُهيَّأ', async () => {
  const originalList = backup.listBackups;
  const originalVerify = backup.verify;
  backup.listBackups = () => [{
    name: 'staff-2026-11-08T00-00-00-000Z-manual-1.db',
    path: '/tmp/staff-2026-11-08T00-00-00-000Z-manual-1.db',
    size: 4096,
    modifiedAt: '2026-11-08T00:00:00.000Z',
  }];
  backup.verify = () => ({ ok: true, detail: 'سليمة • 30 جدولاً • 12 إدارياً', size: 4096 });

  try {
    const i = fakeInteraction();
    await cmd.execute(i);
    const text = descriptionOf(i);

    assert.ok(text.length > 0, 'لم يُرسَل أي نصّ — الاختبار لا يفحص شيئاً');
    assert.ok(
      text.includes(config.dbPath),
      `خطوات الاسترجاع لا تذكر مسار القاعدة المُهيَّأ (${config.dbPath}):\n${text}`,
    );
    assert.ok(
      !text.includes('data/staff.db'),
      `خطوات الاسترجاع ما زالت تذكر مساراً مثالياً ثابتاً (data/staff.db):\n${text}`,
    );
    assert.ok(
      !text.includes('data\\staff.db'),
      `خطوات الاسترجاع ما زالت تذكر مساراً مثالياً ثابتاً (data\\staff.db):\n${text}`,
    );
  } finally {
    backup.listBackups = originalList;
    backup.verify = originalVerify;
  }
});
