'use strict';
// حارس إنفاذ الصلاحيات على مسار المكوّنات.
//
// هذا الملف وُجد لأن تدقيقاً أثبت أن حذف `componentDispatch.js:18-26` بالكامل
// يُبقي كل الاختبارات خضراء: لا يوجد أي اختبار يمرّ عبر `dispatch`. الفحوص هنا
// تستدعي `dispatch` نفسها — لا `commandAccessError` مباشرة — لأن الغائب كان
// الاستدعاء لا السياسة.
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const staffService = require('../src/services/staff');
const { LEVELS } = require('../src/constants');
const { COMPONENT_ACCESS, components } = require('../src/commands');
const { dispatch } = require('../src/services/componentDispatch');
const { SUSPENDED_ALLOWED_COMPONENT_PREFIXES } = require('../src/services/commandAccess');

beforeEach(() => { openMemoryDb(); settings.set('test', true); }); // Invalidate the settings cache between databases.

const IDS = Object.keys(COMPONENT_ACCESS);
const SUSPENDED_TOKEN = 'abcdef0123456789';

/**
 * تفاعل Staff Management مصغّر. ما يهمّ الفحص هنا: المستوى والفريق وحالة
 * الإيقاف (تقرأها accessContext) — لا الحمولة.
 */
function interaction({ id = 'u1', level = LEVELS.STAFF, team = 'support', status = 'active', admin = false } = {}) {
  if (team) {
    getDb().prepare(`INSERT OR REPLACE INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity)
      VALUES (?, 'tester', ?, ?, ?, '2025-01-01 00:00:00', '2025-01-01 00:00:00', '2026-09-12 00:00:00')`)
      .run(id, team, team === 'moderation' ? 'Admin' : 'Support', status);
  }
  return {
    user: { id }, client: {}, guildId: 'g1', staffLevel: level, staffInfo: team ? { team, level } : undefined,
    // لا owner ولا رتبة إدارة عامة: isServerManager يبقى false فلا يُخفَّض الفحص إلى GM
    member: { id, displayName: 'Tester', guild: { ownerId: 'someone-else' }, roles: { cache: new Map() }, permissions: { has: () => admin } },
    async reply(payload) { assert(!this.replied, 'ردّ مزدوج على تفاعل واحد'); this.replied = true; this.payload = payload; return payload; },
    async followUp(payload) { this.followed = payload; return payload; },
    async update(payload) { this.payload = payload; return payload; },
    async showModal(modal) { this.modal = modal; return modal; },
  };
}

/** customId واقعية: زرّ التصحيح يحمل رمز جلسة، وسائر المكوّنات تحمل معاملات. */
const customIdFor = id => (id === 'form:retry' ? `form:retry:${SUSPENDED_TOKEN}` : `${id}:1`);

/** يستبدل معالج المكوّن بعدّاد دخول، فنسأل «هل بلغ المعالج؟» لا «ماذا فعل». */
function spyOn(id) {
  const entry = components.get(id);
  assert(entry, `مكوّن غير مسجّل: ${id}`);
  const original = entry.handle;
  const calls = [];
  entry.handle = (i, args) => { calls.push(args); return Promise.resolve(); };
  return { calls, restore: () => { entry.handle = original; } };
}

const textOf = i => String(i.payload?.embeds?.[0]?.toJSON?.().description || '');

/** مُدخل بلا أي صف staff: ليس إدارياً، ولا مالكاً، ولا Administrator. */
const outsider = (extra = {}) => interaction({ id: 'outsider', level: 0, team: null, ...extra });

test('لا مدخل من COMPONENT_ACCESS يفتح معالجه أمام تفاعل بمستوى صفر', async () => {
  const skipped = [];
  for (const id of IDS) {
    // `form:retry` معلن level: 0 عمداً (بلذة التصحيح بعد رفض) ⇒ يُستثنى من فحص
    // المستوى هنا ويُختبر أدناه بنوعه: الإيقاف + انتهاء صلاحية الجلسة.
    if (COMPONENT_ACCESS[id].level === 0 && !COMPONENT_ACCESS[id].adminOnly) { skipped.push(id); continue; }
    const i = outsider();
    i.customId = customIdFor(id);
    assert.equal(staffService.get(i.user.id), null, `${id}: تفاعل المستوى صفر يجب ألا يكون له صف staff`);
    const spy = spyOn(id);
    try {
      await dispatch(i);
      assert.equal(spy.calls.length, 0, `${id}: مستخدم غير إداري بلغ المعالج — إنفاذ فارغ`);
      assert(i.replied, `${id}: الرفض لم يصل للمستخدم`);
      assert.doesNotMatch(textOf(i), /undefined/, `${id}: رسالة رفض ناقصة`);
    } finally { spy.restore(); }
  }
  // الاستثناء الوحيد المعلن، لا استثناء صامت: أي مدخل آخر level: 0 يقع في الفحص أعلاه.
  assert.deepEqual(skipped, ['form:retry']);
});

test('المكوّن الوحيد المفتوح عند المستوى صفر لا يتجاوز بوابة الإيقاف', async () => {
  // جلسة قديمة + موقوف ⇒ لا معالج. البقية من الإيقاف عبر allow-list في الاختبار التالي.
  const i = outsider({ level: LEVELS.STAFF, team: 'support', status: 'suspended' });
  i.customId = customIdFor('form:retry');
  const spy = spyOn('form:retry');
  try {
    await dispatch(i);
    assert.equal(spy.calls.length, 0, 'موقوف دخل form:retry');
    assert.match(textOf(i), /انتهت صلاحية النموذج/);
  } finally { spy.restore(); }
});

test('موقوف: كل مكوّن خارج قائمة السماح ممنوع، وكل بادئة مسموحة تصل معالجها', async () => {
  let allowed = 0, denied = 0;
  for (const id of IDS) {
    const entry = COMPONENT_ACCESS[id];
    const customId = customIdFor(id);
    // موقوف بأعلى صلاحية ممكنة وفي فريق المكوّن ⇒ كل رفض لاحق سببه الإيقاف وحده.
    const i = interaction({ id: 'susp', level: LEVELS.GENERAL_MANAGER, team: entry.team || 'support', status: 'suspended' });
    i.customId = customId;
    assert.equal(staffService.get('susp').status, 'suspended', `${id}: الإعداد فشل — الاختبار بلا موقوف فعلي`);
    const spy = spyOn(id);
    try {
      await dispatch(i);
      if (entry.adminOnly) {
        // بوابة Administrator تُقصي كل ما بعدها — وهذا هو سلوك مسار الأوامر أيضاً.
        assert.equal(spy.calls.length, 0, `${id}: مدخل Administrator وصل بلا صلاحية`);
        assert.match(textOf(i), /Administrator/);
      } else if (id === 'form:retry') {
        // بوابة انتهاء الجلسة تسبق فحص الصلاحية هنا، فالموقوف لا يصل المعالج —
        // لكن لسببٍ غير الإيقاف. مغطّى على حدة في الاختبار السابق.
        assert.equal(spy.calls.length, 0, `${id}: موقوف وصل معالج التصحيح`);
        assert.match(textOf(i), /انتهت صلاحية النموذج/);
      } else if (SUSPENDED_ALLOWED_COMPONENT_PREFIXES.some(p => customId.startsWith(p))) {
        assert.equal(spy.calls.length, 1, `${id}: بادئة مسموحة — كان يجب أن يصل المعالج`);
        assert.equal(i.replied, undefined, `${id}: المعالج نُفِّذ بعد الردّ`);
        allowed++;
      } else {
        assert.equal(spy.calls.length, 0, `${id}: الموقوف بلغ المعالج — تسريب صلاحية`);
        assert.match(textOf(i), /موقوف/, `${id}: سبب الرفض ليس الإيقاف`);
        denied++;
      }
    } finally { spy.restore(); }
  }
  assert.ok(allowed >= 10, `قائمة السماح فقدت بادئات (المسموح ${allowed})`);
  assert.ok(denied > 100, `الرفض شمل ${denied} مدخلاً فقط — القائمة نفدت؟`);
});

test('كل بادئة في قائمة السماح تطابق مكوّناً مسجّلاً فعلاً', () => {
  // خطأ إملائي في بادئة = اسم لا يطابق شيئاً = مافيش تغطية بدون أن يظهر
  for (const p of SUSPENDED_ALLOWED_COMPONENT_PREFIXES) {
    assert.ok(IDS.some(id => customIdFor(id).startsWith(p)), `بادئة في قائمة السماح لا تطابق أي مكوّن: ${p}`);
  }
});

test('الحد الأعلى maxLevel مُطبَّق على المكوّنات — النسخة المنسوخة كانت تسقطه', async () => {
  // لا مدخل في COMPONENT_ACCESS يحمل maxLevel اليوم، فالحارس يثبّت سلوك المحوّل:
  // يحقن حداً أعلى على مدخل حيّ ويمرّره عبر dispatch. أي نسخ يدوي future
  // يفقد maxLevel يجعل هذا الاختبار أحمر — وهو بالضبط ما حدث مع /promotion-request.
  const id = 'task:complete';
  const entry = components.get(id);
  const original = entry.maxLevel;
  try {
    entry.maxLevel = LEVELS.MANAGEMENT;
    // الحدّ الأعلى يمنع من هم *فوقه*: BOSS أعلى من MANAGEMENT ⇒ يُمنع.
    const above = interaction({ id: 'above', level: LEVELS.BOSS, team: 'support' });
    above.customId = `${id}:1`;
    const spyAbove = spyOn(id);
    try {
      await dispatch(above);
      assert.equal(spyAbove.calls.length, 0, 'maxLevel ابتلعته النسخة المنسوخة — المسار غير مقيَّد');
      assert.match(textOf(above), /رتبتك/);
    } finally { spyAbove.restore(); }

    const atCap = interaction({ id: 'atcap', level: LEVELS.MANAGEMENT, team: 'support' });
    atCap.customId = `${id}:1`;
    const spyAtCap = spyOn(id);
    try {
      await dispatch(atCap);
      assert.equal(spyAtCap.calls.length, 1, 'الحد الأعلى رفض رتبةً على الحدّ بالضبط');
    } finally { spyAtCap.restore(); }
  } finally { entry.maxLevel = original; }
});

test('maxLevel صفر يُنفَّذ ولا يُبتلع كـ falsy — الدرس الموثّق في commandAccess', async () => {
  // `maxLevel: 0` قيمةٌ ذات معنى لا قيمةٌ ناقصة: الشرط `maxLevel != null` يمنع
  // ابتلاعها falsy كما كان يفعل `command.maxLevel &&`، فتصير النتيجة «المستوى
  // يجب أن يبقى ≤ صفر» بدل «بلا حدّ أعلى إطلاقاً». نثبّت الحدّ الأدنى عند صفر
  // أيضاً حتى لا يتداخل الفحصان، ثم نقرأ الحدّ الأعلى وحده.
  const id = 'task:complete';
  const entry = components.get(id);
  const original = { level: entry.level, maxLevel: entry.maxLevel };
  try {
    entry.level = 0;
    entry.maxLevel = 0;
    for (const level of [LEVELS.STAFF, LEVELS.SUPERVISOR, LEVELS.MANAGEMENT, LEVELS.BOSS, LEVELS.GENERAL_MANAGEMENT, LEVELS.GENERAL_MANAGER]) {
      const i = interaction({ id: `lvl${level}`, level, team: 'support' });
      i.customId = `${id}:1`;
      const spy = spyOn(id);
      try {
        await dispatch(i);
        assert.equal(spy.calls.length, 0, `maxLevel: 0 لم يمنع المستوى ${level} — الصفر ابتلع كـ falsy`);
        assert.match(textOf(i), /رتبتك/);
      } finally { spy.restore(); }
    }
    // المستوى صفر وحده يمرّ — نثبت بذلك أن المنع أتى من الحدّ الأعلى لا من حدّ أدنى.
    const zero = interaction({ id: 'lvlzero', level: 0, team: 'support' });
    zero.customId = `${id}:1`;
    const spyZero = spyOn(id);
    try {
      await dispatch(zero);
      assert.equal(spyZero.calls.length, 1, 'maxLevel: 0 أغلق الباب على المستوى صفر نفسه');
    } finally { spyZero.restore(); }
  } finally { entry.level = original.level; entry.maxLevel = original.maxLevel; }
});

// ===== تجاوز Server Manager لبوابة الفريق على مسار المكوّنات =====
// النسخة اليدوية القديمة من الفحوص في componentDispatch كانت تحمل
// `&& !context.serverManager` على فحص الفريق، وضاعت عند التوحيد مع
// commandAccess. المالك/الدور الحاكم يُصرَّف له الزرّ كما يُصرَّف له الأمر.

test('مالك السيرفر بلا رتبة فريق يصل إلى مكوّن خاص بفريق آخر — التجاوز مستعاد', async () => {
  // السياق الواقعي كما يبنيه index.js:178-181 لمالك بلا رتبة فريق:
  // staffLevel = GENERAL_MANAGER وstaffInfo غير معرَّف ⇒ context.team فارغ.
  const i = interaction({ id: 'owner-sm', level: LEVELS.GENERAL_MANAGER, team: null });
  i.member.guild = { ownerId: i.user.id };
  i.customId = customIdFor('modaction:log');
  const spy = spyOn('modaction:log');
  try {
    await dispatch(i);
    assert.equal(spy.calls.length, 1, 'تجاوز Server Manager لبوابة الفريق مفقود — الزرّ رُفض رغم سماح مسار الأوامر');
    assert.equal(i.replied, undefined, 'لا ردّ رفض بعد السماح');
  } finally { spy.restore(); }
});

test('الدور الحاكم المعدّ في /setup يحصل على نفس التجاوز بلا رتبة فريق', async () => {
  settings.setGovernanceRole('gov-role-1');
  const i = interaction({ id: 'gov-sm', level: LEVELS.GENERAL_MANAGER, team: null });
  i.member.roles.cache.set('gov-role-1', true);
  i.customId = customIdFor('modaction:log');
  const spy = spyOn('modaction:log');
  try {
    await dispatch(i);
    assert.equal(spy.calls.length, 1, 'isServerManager عبر الدور الحاكم لا ينفع على مسار المكوّنات');
    assert.equal(i.replied, undefined, 'لا ردّ رفض بعد السماح');
  } finally { spy.restore(); }
});

test('لا يمتد تجاوز Server Manager إلى عضو بلا أي رتبة', async () => {
  const i = outsider();
  i.customId = customIdFor('modaction:log');
  const spy = spyOn('modaction:log');
  try {
    await dispatch(i);
    assert.equal(spy.calls.length, 0, 'عضو بلا رتبة بلغ معالجاً خاصاً بفريق آخر');
    assert.match(textOf(i), /كل الإداريين/, 'سبب الرفض هو الباب العمومي لا تجاوز المالك');
  } finally { spy.restore(); }
});

test('لا يمتد تجاوز Server Manager إلى إداري فريق آخر — بوابة الفريق تبقى مطبقة', async () => {
  const i = interaction({ id: 'supporter', level: LEVELS.STAFF, team: 'support' });
  i.customId = customIdFor('modaction:log');
  const spy = spyOn('modaction:log');
  try {
    await dispatch(i);
    assert.equal(spy.calls.length, 0, 'إداري دعم بلغ معالج إشراف — التجاوز اتّسع للجميع بدل المالك وحده');
    assert.match(textOf(i), /فريق الإشراف/, 'سبب الرفض هو بوابة الفريق');
  } finally { spy.restore(); }
});