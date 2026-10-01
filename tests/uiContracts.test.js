'use strict';
/**
 * عقود الواجهة: لا شيء يطبع «undefined» في وجه المستخدم، ولا شيء يَعِد
 * المشغّل في /config بإيقاف مهمة لا تتوقف.
 *
 * هذه الاختبارات حاجزة ضد نوعين من الانحدار:
 *  1) خريطة الحالة في /me لا تغطي كل مفاتيح constants.STATUS (كانت ناقصة `removed`).
 *  2) /config يبني خريطة مفاتيحها من أسماء عربية مترجمة، فأي اسم لا يطابق
 *     يُطبع `undefined` (كان حال «أوامر تاريخ النقاط» و«تصدر سجلات التدقيق»).
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { openMemoryDb } = require('../src/database');
const { STATUS } = require('../src/constants');
const settings = require('../src/services/settings');
const help = require('../src/commands/help');
const configModule = require('../src/commands/config');
const scheduler = require('../src/scheduler');
const { commands } = require('../src/commands');

const HELP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'help.js'), 'utf8');
const CONFIG_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'commands', 'config.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'scheduler.js'), 'utf8');

beforeEach(() => { openMemoryDb(); settings.resetFeatureToggles(); });

/** كل نصوص أي إيمبد عشوائية تُلتقط للبحث عن «undefined». */
function embedStrings(payload) {
  const out = [];
  const walk = (node) => {
    if (node == null) return;
    if (typeof node === 'string') { out.push(node); return; }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (typeof node === 'object') {
      if (typeof node.toJSON === 'function') { walk(node.toJSON()); return; }
      Object.values(node).forEach(walk);
    }
  };
  walk(payload);
  return out;
}

/** تفاعل وهمي يلتقط الردّ بدل إرساله. */
function stubInteraction({ action = 'view', feature = null } = {}) {
  const captured = [];
  const i = {
    user: { id: '1', tag: 'boss' },
    member: { id: '1' },
    options: { getString: name => (name === 'action' ? action : feature) },
    reply: async (payload) => { captured.push(payload); return payload; },
  };
  return { i, captured };
}

describe('عقد حالة العضو في /me', () => {
  test('كل حالة في constants.STATUS لها رمز حقيقي في خريطة help.js', () => {
    const keys = Object.keys(STATUS);
    assert.ok(keys.length >= 7, `عدد الحالات غير متوقع: ${keys.length}`);
    for (const key of keys) {
      const glyph = help.statusGlyph(key);
      assert.equal(typeof glyph, 'string', `رمز الحالة "${key}" ليس نصاً`);
      assert.ok(glyph.length > 0, `الحالة "${key}" بلا رمز`);
      assert.notEqual(glyph, 'undefined', `الحالة "${key}" تطبع undefined`);
      assert.equal(help.RESOLVED_STATUS_GLYPHS[key], glyph);
    }
  });

  test('الحالة التي كانت تُنتج undefined في العنوان لها رمز الآن', () => {
    // keys المعروضة للتسجيل في التقرير
    const table = Object.fromEntries(Object.keys(STATUS).map(k => [k, help.statusGlyph(k)]));
    assert.deepEqual(table, {
      active: '🟢', inactive: '🟠', on_leave: '🏖️', probation: '🧪',
      suspended: '⛔', resigned: '⚫', removed: '🚪',
    });
    // عنوان اللوحة يبني من نفس الدالة، فلا يمرّ undefined
    const title = `${help.statusGlyph('removed')} لوحتي الشخصية`;
    assert.ok(!title.includes('undefined'), title);
  });

  test('حالة غير معروفة تسقط إلى رمز محايد بدل undefined', () => {
    for (const bogus of ['unknown', '', null, undefined, 'REMOVED']) {
      assert.equal(help.statusGlyph(bogus), '▫️');
    }
  });

  test('الخريطة مشتقّة من STATUS فلا تنحرف عند إضافة حالة جديدة', () => {
    // أي مفتاح في STATUS لا بدّ أن يكون مغطّى، والخريطة لا تحوي مفتاحاً خارج STATUS.
    for (const key of Object.keys(STATUS)) assert.ok(help.RESOLVED_STATUS_GLYPHS[key] !== undefined, key);
    for (const key of Object.keys(help.RESOLVED_STATUS_GLYPHS)) assert.ok(STATUS[key] !== undefined, `مفتاح زائد: ${key}`);
  });
});

describe('عقد مفاتيح /config', () => {
  test('لا مفتاح في العرض خارج FEATURE_TOGGLES_DEFAULTS', () => {
    const declared = new Set(Object.keys(settings.FEATURE_TOGGLES_DEFAULTS));
    const used = configModule.FEATURES.map(f => f.key);
    for (const key of used) assert.ok(declared.has(key), `مفتاح غير معلن في settings: ${key}`);
    // والعكس: ميزة معرّفة في settings ومعروضة للمشغّل
    for (const key of declared) assert.ok(used.includes(key), `ميزة لا تظهر في /config: ${key}`);
    assert.ok(!used.includes('autoTicketPoints'), 'مفتاح النقاط المحذوف عاد');
    assert.deepEqual(used, [...new Set(used)], 'مفتاح مكرر');
  });

  test('اختيارات الأمر مطابقة تماماً لقائمة الميزات', () => {
    const cmd = commands.get('config');
    const option = cmd.data.options.find(o => o.name === 'feature');
    const values = option.choices.map(c => c.value);
    assert.deepEqual(values, configModule.FEATURES.map(f => f.key));
    // الاسم المعروض يأتي من نفس العنصر — لا سلسلة عربية ثانية قد تنحرف
    const labels = option.choices.map(c => c.name);
    assert.deepEqual(labels, configModule.FEATURES.map(f => f.label));
  });

  test('كل مجموعة عرض تحتوي على الأقل ميزة واحدة', () => {
    const groups = new Set(configModule.FEATURES.map(f => f.group));
    const source = CONFIG_SRC;
    for (const g of groups) assert.ok(source.includes(`group: '${g}'`), `المجموعة ${g} بلا أعضاء`);
  });

  test('لا بحث في خريطة بالاسم العربي (السبب الجذري لـ undefined)', () => {
    // التعليقات تُزال أولاً: الكود لا يُحاسَب على شرحه.
    const code = CONFIG_SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/toggles\[/.test(code), 'ما زال هناك فهرسة بخريطة الترجمة');
    assert.ok(!/featureNames\[/.test(code), 'ما زال هناك بحث بالاسم المترجم');
  });

  test('عرض الحالة لا يطبع undefined لأي حالة من مفاتيح الميزات', async () => {
    for (const key of Object.keys(settings.FEATURE_TOGGLES_DEFAULTS)) {
      settings.setFeatureToggle(key, false);
    }
    const { i, captured } = stubInteraction({ action: 'view' });
    await commands.get('config').execute(i);
    assert.equal(captured.length, 1);
    const text = embedStrings(captured[0]);
    assert.ok(text.length > 0, 'لا يوجد نص للبحث فيه');
    for (const line of text) {
      assert.ok(!line.includes('undefined'), `ظهر undefined في: ${line}`);
      assert.ok(!/\[object Object\]/.test(line), `ظهر [object Object] في: ${line}`);
    }
    // كل ميزة ظاهرة مرة واحدة على الأقل بحالتها الصحيحة
    const all = text.join('\n');
    for (const f of configModule.FEATURES) {
      assert.ok(all.includes(f.label), `الميزة غير ظاهرة: ${f.label}`);
      assert.ok(all.includes(`${f.label}: ❌ معطل`), `حالة خاطئة للميزة: ${f.label}`);
    }
  });

  test('تفعيل/إيقاف ميزة يعرض حالتها ولا يطبع undefined', async () => {
    for (const f of configModule.FEATURES) {
      const { i, captured } = stubInteraction({ action: 'disable', feature: f.key });
      await commands.get('config').execute(i);
      assert.equal(settings.featureToggle(f.key), false, f.key);
      const text = embedStrings(captured[0]).join('\n');
      assert.ok(!text.includes('undefined'), `undefined عند إيقاف ${f.key}`);
      assert.ok(text.includes(f.label), `الاسم العربي مفقود لـ ${f.key}`);
    }
  });

  test('مفتاح غير معروف يُرفض ولا يُكتب في الإعدادات', async () => {
    const { i, captured } = stubInteraction({ action: 'disable', feature: 'autoTicketPoints' });
    await commands.get('config').execute(i);
    const text = embedStrings(captured[0]).join('\n');
    assert.ok(!text.includes('undefined'), text);
    assert.match(text, /ميزة غير معروفة/);
    assert.throws(() => settings.setFeatureToggle('autoTicketPoints', false), /مفتاح ميزة غير معروف/);
    assert.equal(settings.featureToggle('autoTicketPoints'), undefined);
  });

  test('إعادة التعيين تُبقي كل شيء مفعّلاً افتراضياً', async () => {
    settings.setFeatureToggle('punishmentSystem', false);
    const { i } = stubInteraction({ action: 'reset' });
    await commands.get('config').execute(i);
    assert.equal(settings.featureToggle('punishmentSystem'), true);
    for (const key of Object.keys(settings.FEATURE_TOGGLES_DEFAULTS)) {
      assert.equal(settings.featureToggle(key), true, `${key} يجب أن يعود مفعّلاً`);
    }
  });
});

describe('عقد مهام المجدول والتبديل', () => {
  test('كل مهمة مرتبطة بمفتاح تبديل موجود في settings', () => {
    for (const [job, key] of Object.entries(scheduler.JOB_TOGGLES)) {
      assert.ok(settings.isFeatureToggle(key), `مفتاح غير معروف للمهمة ${job}: ${key}`);
    }
    assert.equal(scheduler.JOB_TOGGLES['weekly-report'], 'weeklyReports');
    assert.equal(scheduler.JOB_TOGGLES['monthly-report'], 'monthlyReports');
    assert.equal(scheduler.JOB_TOGGLES.backup, 'autoBackups');
  });

  test('الافتراضي: كل مهام المجدول مشغّلة — لا يُعطَّل cron بلا سبب', () => {
    for (const job of Object.keys(scheduler.JOB_TOGGLES)) {
      assert.equal(scheduler.jobEnabled(job), true, `${job} معطّلة افتراضياً`);
    }
    // مهام بلا مفتاح تبديل تبقى مشغّلة دائماً
    for (const job of ['absence', 'suspensions', 'leaves', 'resignations', 'task-reminders', 'daily-report', 'maintenance']) {
      assert.equal(scheduler.jobEnabled(job), true, job);
    }
  });

  test('إيقاف الميزة يوقف المهمة فعلاً، وإعادة التشغيل تُعيدها', () => {
    for (const [job, key] of Object.entries(scheduler.JOB_TOGGLES)) {
      settings.setFeatureToggle(key, false);
      assert.equal(scheduler.jobEnabled(job), false, `${job} لم تتوقف بعد إيقاف ${key}`);
      settings.setFeatureToggle(key, true);
      assert.equal(scheduler.jobEnabled(job), true, `${job} لم تُعد بعد تفعيل ${key}`);
    }
  });

  test('كل مفاتيح الميزات مفعّلة افتراضياً', () => {
    for (const key of Object.keys(settings.FEATURE_TOGGLES_DEFAULTS)) {
      assert.equal(settings.featureToggle(key), true, `${key} يجب أن يبدأ مفعّلاً`);
    }
  });

  test('لا مهام مجدولة معلنة بلا قارئ لمفتاحها', () => {
    // أي مفتاح في JOB_TOGGLES يجب أن يُذكر في src/scheduler.js عند تعريفه
    for (const key of Object.values(scheduler.JOB_TOGGLES)) {
      assert.ok(SCHEDULER_SRC.includes(key), `المفتاح ${key} غير مستعمل في scheduler.js`);
    }
  });

  test('لا awards من نظام النقاط المحذوف ولا فروع ميتة', () => {
    // لا مكافآت أسبوعية/شهرية من نظام النقاط، ولا ifs فارغة مكانها.
    assert.ok(!/week_above_80/.test(SCHEDULER_SRC), 'مكافأة أسبوعية عادت');
    assert.ok(!/if \(sc >= 80\)/.test(SCHEDULER_SRC), 'الفرع الميت عاد');
    assert.ok(!/best_of_month/.test(SCHEDULER_SRC), 'مكافأة الشهر عادت');
    // منطق المراجعة البشرية باقٍ: sc < 50 فقط
    assert.ok(/if \(sc < 50\) below\.push/.test(SCHEDULER_SRC), 'قائمة المراجعة الأسبوعية تغيّرت');
  });
});