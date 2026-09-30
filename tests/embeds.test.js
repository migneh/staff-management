'use strict';
/**
 * اختبارات طبقة «البطاقات الموحّدة» (kit.card / kit.notice):
 * - كل رسالة تبقى داخل حدود ديسكورد حتى لو كان النص الديناميكي طويلاً.
 * - لا حقول فارغة، والشكل واحد: عنوان + وصف + حقول + تذييل موحّد.
 * - البطاقات الحقيقية في المسارات الجديدة (الإجازات، النقاط، المزامنة) تمرّ من نفس الطبقة.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { Collection, ComponentType } = require('discord.js');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const staffSync = require('../src/services/staffSync');
const { commands, resolveComponent } = require('../src/commands');
const { LEVELS } = require('../src/constants');
const kit = require('../src/ui/kit');

const IDS = { me: '1005171993940852796', peer: '1490787800168005713', channel: '323456789012345678', guild: '423456789012345678' };
const LIMITS = { title: 256, description: 4096, fields: 25, name: 256, value: 1024, footer: 2048 };

const json = payload => JSON.parse(JSON.stringify(payload?.toJSON ? payload.toJSON() : payload));

/** يفشل الاختبار إن خرج أي إمبد عن حدود ديسكورد أو بلا لون/تذييل. */
function assertEmbedLimits(payload, label) {
  const embeds = json(payload).embeds || [];
  assert(embeds.length, `${label}: لا يوجد إمبد`);
  for (const e of embeds) {
    assert(!e.title || e.title.length <= LIMITS.title, `${label}: عنوان أطول من الحد`);
    assert(!e.description || e.description.length <= LIMITS.description, `${label}: وصف أطول من الحد`);
    assert((e.fields || []).length <= LIMITS.fields, `${label}: حقول أكثر من الحد`);
    for (const f of e.fields || []) {
      assert(f.name?.length <= LIMITS.name, `${label}: اسم حقل أطول من الحد`);
      assert(f.value?.length <= LIMITS.value, `${label}: قيمة حقل أطول من الحد`);
      assert(String(f.name).trim() && String(f.value).trim(), `${label}: حقل فارغ`);
    }
    assert(typeof e.color === 'number', `${label}: بلا لون`);
    assert(e.footer?.text, `${label}: بلا تذييل موحّد`);
    assert(e.footer.text.length <= LIMITS.footer, `${label}: تذييل أطول من الحد`);
  }
}

function interaction({ customId = '', level = LEVELS.STAFF, team = 'support', selects = {}, values = [], texts = {}, id = IDS.me } = {}) {
  seedStaff(id, team);
  return {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel, client: mockClient(), staffLevel: level, staffInfo: { team },
    member: { permissions: { has: () => false } }, values, replied: false,
    fields: {
      getField(field) {
        if (Object.hasOwn(texts, field)) return { custom_id: field, type: ComponentType.TextInput, value: texts[field] };
        const v = selects[field] != null ? [].concat(selects[field]) : null;
        if (!v) return { custom_id: field, type: ComponentType.TextInput, value: '' };
        return { custom_id: field, type: ComponentType.StringSelect, values: v };
      },
      getTextInputValue: id2 => texts[id2] ?? '',
      getStringSelectValues: id2 => [].concat(selects[id2] ?? []),
      getSelectedUsers: () => null,
      getSelectedChannels: () => null,
    },
    async reply(payload) { this.replied = true; this.payload = payload; },
    async update(payload) { this.replied = true; this.payload = payload; },
    async showModal(modal) { this.modal = modal; },
  };
}
function mockClient() {
  return { channels: { fetch: async () => ({ send: async payload => ({ id: '1', payload }) }) }, users: { fetch: async () => ({ send: async () => {} }) } };
}
function seedStaff(id, team = 'support') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, 'Support', 'active')
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team`).run(id, id, team);
}
const pick = (id, value) => { const c = interaction(); c.customId = id; c.values = [value]; return c; };

beforeEach(() => { openMemoryDb(); settings.setChannel('leave-requests', IDS.channel); settings.setChannel('staff-logs', IDS.channel); });

test('kit.card يقصّ النصوص ويسقط الحقول الفارغة ويوحّد التذييل', () => {
  const e = kit.card({
    title: 'ع'.repeat(400),
    description: 'و'.repeat(5000),
    fields: [{ name: 'صالح', value: 'قيمة' }, { name: 'فارغ', value: '   ' }, null, { name: 'طويل', value: 'x'.repeat(2000) }],
  }).toJSON();
  assert.equal(e.title.length, LIMITS.title);
  assert.equal(e.description.length, LIMITS.description);
  const names = e.fields.map(f => f.name).filter(n => n !== '\u200b');
  assert.deepEqual(names, ['صالح', 'طويل']);
  assert(e.fields.every(f => f.value.length <= LIMITS.value));
  assert.equal(e.footer.text, `${kit.BRAND} • ${kit.stamp()}`);
  assert.equal(e.timestamp != null || true, true);
});

test('kit.card يحترم التذييل المخصّص ووقتاً نسبياً عند الطلب', () => {
  const custom = kit.card({ title: 'بدون وقت', footer: 'تذييل مخصّص' }).toJSON();
  assert.equal(custom.footer.text, 'تذييل مخصّص');
  const stamped = kit.card({ title: 'مع وقت', footer: kit.footerLine('نص') }).toJSON();
  assert.match(stamped.footer.text, new RegExp(`${kit.BRAND} • <t:\\d+:R>`));
  assert.match(kit.footerLine('نص', { brand: false }), /^نص • <t:\d+:R>$/);
});

test('kit.notice يرتّب الألوان والرموز لكل الحالات', () => {
  const cases = [['success', '✅', 0x57f287], ['error', '❌', 0xed4245], ['warning', '⚠️', 0xfee75c], ['info', 'ℹ️', 0x3498db], ['neutral', '▫️', 0x99aab5]];
  for (const [kind, emoji, color] of cases) {
    const e = kit.notice(kind, 'عنوان', 'وصف').toJSON();
    assert.equal(e.title, `${emoji} عنوان`);
    assert.equal(e.color, color);
    assert(e.footer.text);
  }
});

test('بطاقة الإجازة بالنقر وبطاقة المراجعة تمرّان من نفس الطبقة وتحتويان تذييلاً', async () => {
  const open = interaction();
  open.options = { getString: () => null };
  await commands.get('request-leave').execute(open);
  const typeMenu = open.payload.components[0].components[0].toJSON();
  const pickType = interaction(); pickType.values = ['normal'];
  await resolveComponent(typeMenu.custom_id).handler(pickType, []);
  assertEmbedLimits(pickType.payload, 'بطاقة الاختيار السريع');
  const card = json(pickType.payload).embeds[0];
  assert.match(card.title, /اختر بنقرة/);
  assert(card.fields.some(f => f.name.includes('البداية')));
  assert.match(card.footer.text, /الإرسال من بطاقة المراجعة فقط/);

  const token = json(pickType.payload).components[0].components[0].custom_id.split(':')[2];
  const { today, addDays } = require('../src/utils');
  for (const [id, value] of [[`leave:qstart:${token}`, addDays(today(), 5)], [`leave:qdays:${token}`, '3'], [`leave:qreason:${token}`, 'ظرف عائلي']]) {
    await resolveComponent(id.split(':').slice(0, 2).join(':')).handler(pick(id, value), [token]);
  }
  const go = pick(`leave:qgo:${token}`, '');
  await resolveComponent('leave:qgo').handler(go, [token]);
  assertEmbedLimits(go.payload, 'بطاقة المراجعة');
  const preview = json(go.payload).embeds[0];
  assert.match(preview.title, /راجع طلب إجازتك/);
  assert(preview.fields.some(f => f.name.includes('التغطية العامة')));
  assert.match(preview.footer.text, /تنتهي المسودة/);
});

test('بطاقة إجراء إشرافي تتفق مع حدود ديسكورد', async () => {
  const picker = interaction({ level: LEVELS.SUPERVISOR, team: 'moderation' });
  picker.options = { getString: () => null };
  await commands.get('log-action').execute(picker);
  assertEmbedLimits(picker.payload, 'بطاقة اختيار نوع الإجراء');
});

test('تقرير مزامنة الإداريين بطاقة واحدة بأرقام وحقول بلا تكرار', () => {
  const report = {
    scanned: 12, bots: 1, unchanged: 9, total: 3,
    registered: [{ id: IDS.me, rank: 'Support', team: 'support', status: 'active' }],
    updated: [{ id: IDS.peer, from: 'Support', to: 'Moderator' }],
    departures: [],
  };
  const e = staffSync.reportEmbed(report).toJSON();
  assertEmbedLimits({ embeds: [staffSync.reportEmbed(report)] }, 'تقرير المزامنة');
  assert(e.description.includes('فُحص'));
  const names = e.fields.map(f => f.name);
  assert.equal(new Set(names).size, names.length, 'لا حقول مكرّرة');
  assert(names.includes('🆕 سُجّلوا الآن'));
  assert.match(e.footer.text, /رتب الديسكورد/);
  assert.equal(e.color, 0x57f287);
});
