'use strict';
/**
 * Tests for the activityTracking feature toggle.
 *
 * The key was advertised in /config and writable, but nothing read it:
 * settings.js:106 said so in a comment, config.js:22 told the operator
 * "⚠️ غير مربوط: إيقافه لا يوقف تسجيل النشاط بعد" — a switch that lies.
 *
 * Decision under test: the toggle is WIRED, and it gates the single write
 * path (src/index.js:124 → activity.record). What it does NOT do is delete or
 * rewrite history, and it does not suspend the readers. The invariant asserted
 * here is deliberately narrow and observable:
 *
 *   disabled ⇒ no new row is written, and the row counter never moves.
 *
 * Everything else (which features then read incomplete data) is blast radius,
 * documented in the report and in src/services/activity.js — not a second
 * copy of the switch somewhere else.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openMemoryDb, getDb } = require('../src/database');
const activity = require('../src/services/activity');
const settings = require('../src/services/settings');
const { commands } = require('../src/commands');
const { SPAM } = require('../src/constants');

const ACTIVITY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'services', 'activity.js'), 'utf8');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'config.js'), 'utf8');

const ME = '1005171993940852796';
const CH = { id: '9001', name: 'general' };
const count = () => getDb().prepare('SELECT COUNT(*) c FROM activity_logs').get().c;

function fakeInteraction({ id = ME } = {}) {
  const calls = { reply: [] };
  return {
    user: { id, tag: id }, guildId: '1', channelId: '2',
    staffLevel: 0, staffInfo: null, member: { id, permissions: { has: () => false }, roles: { cache: new Map() } },
    calls,
    async reply(p) { calls.reply.push(p); return p; },
  };
}
const embedText = calls => JSON.stringify((calls.reply[0]?.embeds || []).map(e => e.toJSON ? e.toJSON() : e));

beforeEach(() => { openMemoryDb(); settings.resetFeatureToggles(); });

describe('the toggle exists and is on by default', () => {
  test('declared as a feature toggle, default true', () => {
    assert.ok(settings.isFeatureToggle('activityTracking'), 'the key is not a known toggle');
    assert.equal(settings.FEATURE_TOGGLES_DEFAULTS.activityTracking, true);
    assert.equal(settings.featureToggle('activityTracking'), true);
    assert.equal(activity.isTrackingEnabled(), true);
  });

  test('it is the same key /config offers, so the operator toggle is this one', () => {
    const configModule = require('../src/commands/config');
    assert.ok(configModule.FEATURES.some(f => f.key === 'activityTracking'), '/config does not offer the key');
  });
});

describe('disabled ⇒ nothing is recorded (the invariant)', () => {
  test('record() writes no row and says why', () => {
    settings.setFeatureToggle('activityTracking', false);
    const res = activity.record(ME, CH, 'رسالة طويلة وعادية بما يكفي');

    assert.equal(res.counted, false, 'a row was written while tracking was off');
    assert.equal(res.reason, 'tracking_disabled', 'the refusal reason is not distinguishable from spam/duplicates');
    assert.equal(count(), 0);
  });

  test('a flood of messages moves the counter zero times', () => {
    settings.setFeatureToggle('activityTracking', false);
    for (let k = 0; k < 50; k++) activity.record(ME, CH, `رسالة مطوّلة ومختلفة رقم ${k} هنا`);
    assert.equal(count(), 0, 'rows appeared while tracking was off');
  });

  test('the gate short-circuits before any accounting: the daily cap is not consumed', () => {
    settings.setFeatureToggle('activityTracking', false);
    for (let k = 0; k < SPAM.maxGeneralPerDay + 5; k++) activity.record(ME, CH, `رسالة مطوّلة رقم ${k} لاختبار السقف`);
    settings.setFeatureToggle('activityTracking', true);

    const res = activity.record(ME, CH, 'أول رسالة بعد إعادة التفعيل');

    assert.equal(res.counted, true, 'the cap was spent while tracking was off');
    assert.equal(count(), 1);
  });

  test('re-enabling resumes recording, and the message skipped while off is not shadowed as a duplicate', () => {
    settings.setFeatureToggle('activityTracking', false);
    activity.record(ME, CH, 'نص كبير بما يكفي لتجاوز حد الطول الأدنى');
    settings.setFeatureToggle('activityTracking', true);

    const res = activity.record(ME, CH, 'نص كبير بما يكفي لتجاوز حد الطول الأدنى');

    assert.equal(res.counted, true, 'duplicate detection saw a row that was never written');
    assert.equal(count(), 1);
  });
});

describe('reads are untouched: the toggle gates writes, it does not rewrite history', () => {
  test('history recorded before the toggle was off stays readable', () => {
    for (let k = 0; k < 3; k++) activity.record(ME, CH, `رسالة قبل الإيقاف رقم ${k} هنا`);
    assert.equal(count(), 3);

    settings.setFeatureToggle('activityTracking', false);
    const stats = activity.stats(ME, 30);

    assert.equal(stats.messages, 3, 'existing rows were dropped or hidden');
  });

  test('the Score engine still reads whatever history exists (blast radius, not a second switch)', () => {
    for (let k = 0; k < 10; k++) activity.record(ME, CH, `رسالة قبل الإيقاف رقم ${k} هنا`);
    settings.setFeatureToggle('activityTracking', false);
    getDb().prepare("INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, 'me', 'support', 'Support', 'active')").run(ME);
    const score = require('../src/services/score');

    const raw = score.monthlyRaw(ME);

    assert.equal(raw.messages, 10, 'the score raw data stopped seeing existing rows');
  });
});

describe('no dead switch: the key has a reader', () => {
  test('src/services/activity.js reads the key', () => {
    assert.ok(/featureToggle\(\s*'activityTracking'\s*\)/.test(ACTIVITY_SRC),
      'no reader for activityTracking in src/services/activity.js');
  });

  test('the gate is inside record(), the single write path', () => {
    const body = ACTIVITY_SRC.slice(ACTIVITY_SRC.indexOf('function record('), ACTIVITY_SRC.indexOf('/** إحصائيات نشاط'));
    assert.ok(/isTrackingEnabled\(\)/.test(body), 'record() does not consult the toggle');
    assert.ok(/return\s*\{\s*counted:\s*false/.test(body), 'record() cannot refuse');
    // the refusal must come before the INSERT, not after it
    assert.ok(body.indexOf('isTrackingEnabled()') < body.indexOf('INSERT INTO activity_logs'),
      'the gate runs after the row is written');
  });

  // NOTE: src/commands/config.js is outside this change's edit scope, so its
  // hint for this key still reads "⚠️ غير مربوط: إيقافه لا يوقف تسجيل النشاط
  // بعد" — which is now FALSE. Fixing that one Arabic string in config.js:22
  // is a required follow-up by whoever owns that file. The behaviour is
  // pinned here instead, so the toggle cannot silently become a no-op again.
});

describe('the member sees that their record is incomplete', () => {
  test('/my-record warns while tracking is off and stays silent while it is on', async () => {
    settings.setFeatureToggle('activityTracking', false);
    const off = fakeInteraction();
    await commands.get('my-record').execute(off);
    assert.match(embedText(off.calls), /النشاط متوقف/, 'no warning shown to the member');

    settings.setFeatureToggle('activityTracking', true);
    const on = fakeInteraction();
    await commands.get('my-record').execute(on);
    assert.doesNotMatch(embedText(on.calls), /تتبع النشاط/, 'a warning is shown while tracking works');
  });
});
