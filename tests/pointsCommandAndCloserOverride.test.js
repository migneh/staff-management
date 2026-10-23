'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const { commands } = require('../src/commands');
const logging = require('../src/commands/logging');
const points = require('../src/services/points');
const { LEVELS } = require('../src/constants');

const ACTOR = '111111111111111111';
const CLOSER = '222222222222222222';
const OWNER = '333333333333333333';

function addStaff(id, rank) {
  getDb().prepare('INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, \'support\', ?, \'active\')')
    .run(id, id, rank);
}

beforeEach(() => {
  openMemoryDb();
  addStaff(ACTOR, 'Support Expert');
  addStaff(CLOSER, 'Support Office');
  addStaff(OWNER, 'Helper');
});

test('لوحة /me و/my-status تعرضان الحالة دون balance غير معرّف', async () => {
  const interaction = {
    user: { id: ACTOR }, member: { id: ACTOR, displayName: 'Tester' }, staffInfo: { team: 'support' },
    options: { getBoolean: () => false },
    async reply(payload) { this.payload = payload; },
  };
  points.freeze(ACTOR, 1, 'test');
  await commands.get('me').execute(interaction);
  assert.match(interaction.payload.embeds[0].toJSON().fields.map(f => f.value).join(' '), /❄️/);
  await commands.get('my-status').execute(interaction);
  assert.match(interaction.payload.embeds[0].toJSON().fields.map(f => f.value).join(' '), /❄️/);
});

test('تسجيل التكت يرفض تجاوز رتبة المُغلق ويحد تقييم override إلى 1 أو 2', async () => {
  const fields = values => ({ getTextInputValue: key => values[key] ?? '' });
  const interaction = (rating) => ({
    user: { id: ACTOR }, staffLevel: LEVELS.SENIOR, channelId: 'channel',
    fields: fields({ ticket_id: 'ticket-1', owner: OWNER, rating: String(rating) }),
    async reply(payload) { this.payload = payload; },
  });

  const deniedRank = interaction(1);
  await logging.components['ticket:log'](deniedRank, [CLOSER]);
  assert.match(deniedRank.payload.embeds[0].toJSON().description, /لا يمكنك تسجيل إجراء/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 0);

  getDb().prepare("UPDATE staff_members SET rank = 'Helper' WHERE user_id = ?").run(CLOSER);
  const badRating = interaction(5);
  await logging.components['ticket:log'](badRating, [CLOSER]);
  assert.match(badRating.payload.embeds[0].toJSON().description, /1 أو 2/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 0);
});
