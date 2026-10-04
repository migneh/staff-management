'use strict';
/**
 * بوابة بنية حمولة Discord — تُبقي ما أوقف تسجيل الإنتاج مقفولاً:
 *   1. خيار مطلوب بعد اختياري داخل subcommand (APPLICATION_COMMAND_OPTIONS_REQUIRED_INVALID)
 *   2. خيار مستوى أمر مختلط مع subcommands (APPLICATION_COMMAND_OPTIONS_TYPE_INVALID)
 * وتثبّت حمولة اليوم خالية، وتغطي حدوداً لا يمسّها SlashCommandBuilder إلا
 * صامتاً (الحجم 8000، العمق الزائد، قوائم السياق).
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { commands } = require('../src/commands');
const { structuralProblems } = require('../src/services/commandStructure');

const payload = () => [...commands.values()].map(c => c.data.toJSON());
const find = name => payload().find(c => c.name === name);

test('حمولة اليوم كاملة بلا مشاكل بنية — ما يرفعه deploy صالح', () => {
  assert.deepEqual(structuralProblems(payload()), []);
});

describe('خطا المضيف 50035 يُكشفان قبل الشبكة', () => {
  test('المطلوب بعد الاختياري داخل sub — REQUIRED_INVALID', () => {
    const bad = { name: 'probe', description: 'x', options: [
      { type: 1, name: 'grp', description: 'g', options: [
        { type: 3, name: 'opt', description: 'o', required: false },
        { type: 3, name: 'req', description: 'r', required: true },
      ] },
    ] };
    const p = structuralProblems([bad]);
    assert.equal(p.length, 1, `المفروض خطأ واحد فقط: ${p.join(' | ')}`);
    assert.match(p[0], /REQUIRED_INVALID/);
  });

  test('خيار مستوى أمر مختلط مع subcommands — TYPE_INVALID', () => {
    const bad = { name: 'probe', description: 'x', options: [
      { type: 1, name: 'grp', description: 'g', options: [] },
      { type: 5, name: 'flag', description: 'f' },
    ] };
    const p = structuralProblems([bad]);
    assert.equal(p.length, 1, `المفروض خطأ واحد فقط: ${p.join(' | ')}`);
    assert.match(p[0], /TYPE_INVALID/);
  });
});

describe('تثبيت الإصلاحين في الحمولة الحقيقية', () => {
  test('/templates create: المطلوبات كلها قبل الاختياريات', () => {
    const cmd = find('templates');
    const create = cmd.options.find(o => o.name === 'create');
    const required = create.options.map(o => !!o.required);
    const firstOptional = required.findIndex(r => !r);
    assert.ok(firstOptional > 0, 'يجب أن يسبق المطلوبات اختيارياً واحداً');
    assert.ok(required.slice(firstOptional).every(r => !r),
      'خيار مطلوب تسلل بعد اختياري — خطأ المضيف الأول');
  });

  test('/missions: خيارات المستوى العليا كلها subcommands وdetailed داخل list', () => {
    const cmd = find('missions');
    assert.ok(cmd.options.length > 0);
    assert.ok(cmd.options.every(o => o.type === 1 || o.type === 2),
      'خيار عادي تسلل إلى المستوى العليا — خطأ المضيف الثاني');
    const list = cmd.options.find(o => o.name === 'list');
    assert.ok(list.options.some(o => o.name === 'detailed'),
      'detailed يجب أن يسكن sub list الذي يقرأه execute');
  });
});

describe('حدود يتجاوزها البناء صامتاً', () => {
  test('حجم مركّب يتجاوز 8000 حرف يُكشف (APPLICATION_COMMAND_TOO_LARGE)', () => {
    const choices = Array.from({ length: 25 }, () => ({ name: 'n'.repeat(100), value: 'v'.repeat(100) }));
    const opt = i => ({ type: 3, name: `o${i}`, description: 'd'.repeat(100), choices });
    const big = { name: 'probe', description: 'd'.repeat(100), options: [opt(1), opt(2)] };
    assert.ok(structuralProblems([big]).some(m => /APPLICATION_COMMAND_TOO_LARGE/.test(m)));
  });

  test('قوائم السياق تتجاوز قيد اسم CHAT_INPUT — مختلطة الحالة والمسافة مقبولة', () => {
    assert.deepEqual(structuralProblems([{ name: 'User Profile', type: 2 }]), []);
  });

  test('عمق زائد: subcommand يحوي subcommand يُكشف (شكل التعشيش)', () => {
    const bad = { name: 'probe', description: 'x', options: [
      { type: 1, name: 'outer', description: 'o', options: [
        { type: 1, name: 'inner', description: 'i', options: [] },
      ] },
    ] };
    assert.ok(structuralProblems([bad]).some(m => /عمق إضافي/.test(m)));
  });
});
