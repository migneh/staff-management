'use strict';
/**
 * حارس الخصوصية للعقوبات والملاحظات.
 *
 * نظام النقاط أُزيل من المشروع، وواجهتا /warn و /note كانتا لا تزالان
 * تَعِدان الإداري بخصم أو إضافة نقاط. كما أن إشعار العضو كان يُرسَل مرتين
 * للملاحظة العادية، ومرة واحدة بنصّها الكامل حتى للملاحظة السرية.
 *
 * هذه الاختبارات تقرأ النص من الملف نفسه (لا من نسخة) وتُشغّل المسار الكامل
 * حتى التأكيد، فتفشل إن عاد أي ادّاء عنPoints أو عن الإرسال غير المشروط.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const fs = require('node:fs');
const path = require('node:path');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const { LEVELS } = require('../src/constants');
const { commands, resolveComponent } = require('../src/commands');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'punishments.js'), 'utf8');
const IDS = {
  target: '1005171993940852796',
  actor: '1490787800168005713',
  channel: '223456789012345678',
  guild: '323456789012345678',
};
const SECRET_TEXT = 'ملاحظة سرية لا يطّلع عليها إلا الإدارة';

/** وارد يهمس بكل ما يُرسَل عبر utils.dm (يمرّ عبر client.users.fetch). */
function recorder() {
  const dms = [];
  const client = {
    users: {
      fetch: async (id) => ({
        id,
        send: async (payload) => {
          const embeds = (payload.embeds || []).map(e => (typeof e.toJSON === 'function' ? e.toJSON() : e));
          dms.push({ id, text: embeds.map(e => `${e.title || ''} ${e.description || ''} ${(e.fields || []).map(f => f.value).join(' ')}`).join('\n') });
          return { id: 'dm-1' };
        },
      }),
    },
    channels: { fetch: async (id) => ({ id, send: async () => ({ id: 'msg-1' }) }) },
  };
  return { client, dms };
}

function interaction(client, fields = {}) {
  const i = {
    client,
    user: { id: IDS.actor },
    guildId: IDS.guild,
    channelId: IDS.channel,
    staffLevel: LEVELS.BOSS,
    fields: { getTextInputValue: (id) => fields[id] || '' },
    async reply(p) { this.payload = p; this.replied = true; },
    async update(p) { this.payload = p; this.replied = true; },
    // punish:notekok / punish:warningok يؤجّلان قبل النشر في قناة السجلات ثم
    // ينهيان بـ editReply، ويبقى التأكيد الخاص للإداري followUp. البصمة
    // الناقصة هنا كانت تُسقط الاختبارات بـ TypeError لا بفشل سلوك.
    async deferUpdate() { this.deferred = true; this.replied = true; },
    async deferReply() { this.deferred = true; this.replied = true; },
    async editReply(p) { this.payload = p; this.replied = true; },
    async followUp(p) { this.follow = p; },
  };
  return i;
}

function seedTarget() {
  getDb().prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, ?, ?)')
    .run(IDS.target, 'member', 'moderation', 'Moderator', 'active');
}

beforeEach(() => {
  openMemoryDb();
  settings.setChannel('staff-logs', IDS.channel);
  seedTarget();
});

/** يمرّ بالمسار الكامل: إرسال النموذج ثم ضغط «تأكيد التسجيل». */
async function addNote({ content = 'ملاحظة اعتيادية', secret = false } = {}) {
  const { client, dms } = recorder();
  const modal = interaction(client, { target: IDS.target, content, secret: secret ? 'true' : 'false' });
  await resolveComponent('punish:note:negative').handler(modal, ['negative']);
  const token = modal.payload.components[0].toJSON().components[0].custom_id.split(':').pop();
  const confirm = interaction(client);
  await resolveComponent('punish:notekok').handler(confirm, [token]);
  return { dms, confirm, modal, content, secret };
}

test('الملاحظة السرية لا تُرسل نصها إلى العضو إطلاقاً', async () => {
  const { dms, confirm } = await addNote({ content: SECRET_TEXT, secret: true });
  for (const d of dms) {
    assert.ok(!d.text.includes(SECRET_TEXT), 'تسرّب نص الملاحظة السرية إلى العضو عبر الخاص');
  }
  assert.equal(dms.length, 0, `الملاحظة السرية يجب ألا ترسل أي خاص، وصل ${dms.length}`);
  // العلامة تبقى في تأكيد الإدارة فقط.
  assert.match(confirm.follow.embeds[0].toJSON().description, /🔒/);
  assert.equal(getDb().prepare('SELECT is_secret s FROM staff_notes').get().s, 1);
});

test('الملاحظة العادية تُرسل للعضو مرة واحدة بالضبط', async () => {
  const { dms, content } = await addNote({ content: 'تحسّن ملحوظ في الردود' });
  assert.equal(dms.length, 1, `توقّعنا إشعاراً واحداً، وصل ${dms.length}`);
  assert.equal(dms[0].id, IDS.target);
  assert.ok(dms[0].text.includes(content));
});

test('لا نصّ في punishments.js يشير إلى نظام النقاط المحذوف', () => {
  const MENTIONS = /نقاط|نقطة|\bpoints?\b/;
  // الصياغة الوحيدة المسموحة: النفي الصريح المطابق لما في logging.js:51.
  const HONEST = 'لا تُمنح نقاط لهذا الإجراء في النظام الحالي.';
  const offenders = SRC.split('\n')
    .map((line, n) => [n + 1, line])
    .filter(([, line]) => MENTIONS.test(line) && !line.includes(HONEST))
    .map(([n, line]) => `س${n}: ${line.trim()}`);
  assert.deepEqual(offenders, [], 'إشارات باقية لنظام النقاط:\n' + offenders.join('\n'));
  assert.ok(!/\bpoints?\b/.test(SRC), 'اسم points ما زال ظاهراً في المصدر');
});

test('خيارات أوامر /warn و /note لا تعد بنقاط', () => {
  for (const name of ['warn', 'note']) {
    const json = commands.get(name).data.toJSON();
    const choices = json.options.flatMap(o => o.choices || []);
    assert.ok(choices.length, `${name} بلا خيارات`);
    for (const c of choices) {
      assert.ok(!/نقطة|\+\d|-\d/.test(c.name), `خيار يَعِد بالنقاط: ${c.name}`);
    }
  }
});

test('نصوص البطاقات والإشعارات صادقة بعد حذف نظام النقاط', async () => {
  const { client, dms } = recorder();
  const warn = interaction(client, { target: IDS.target, preset: 'تجاهل الأنظمة', reason: '' });
  await resolveComponent('punish:warning:verbal').handler(warn, ['verbal']);
  const pending = warn.payload.embeds[0].toJSON();
  // يُسمح بذكر «النقاط» مرة واحدة وبصيغة النفي المطابقة لـ logging.js:51.
  const note = pending.fields.find(f => f.name.includes('ملاحظة')).value;
  assert.equal(note, 'لا تُمنح نقاط لهذا الإجراء في النظام الحالي.');
  assert.equal((JSON.stringify(pending).match(/نقاط|نقطة/g) || []).length, 1, 'ذكر إضافي للنقاط في بطاقة الإنذار');

  const token = warn.payload.components[0].toJSON().components[0].custom_id.split(':').pop();
  const confirm = interaction(client);
  await resolveComponent('punish:warningok').handler(confirm, [token]);
  assert.equal(dms.length, 1, 'الإنذار يرسل إشعاراً واحداً');

  const cancel = interaction(client);
  await resolveComponent('punish:warningcancel').handler(cancel, ['deadbeefdeadbeef']);
  const cancelled = cancel.payload.embeds[0].toJSON();
  assert.ok(!/نقاط|نقطة/.test(cancelled.description), 'إشعار الإلغاء يذكر خصم النقاط');
  assert.match(cancelled.description, /لم يُسجَّل أي إنذار/);
});
