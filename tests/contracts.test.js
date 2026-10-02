'use strict';
// ثلاث اتفاقيات صغيرة، كل منها يجب أن تفشل فعلاً إن Breaking.
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { test, describe } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb } = require('../src/database');
const { SCORE_WEIGHTS } = require('../src/constants');
const settings = require('../src/services/settings');
const { commands, validateRegistry } = require('../src/commands');

const ROOT = path.join(__dirname, '..');
const START = '<!-- COMMANDS:START -->';
const END = '<!-- COMMANDS:END -->';

openMemoryDb();

/** أسماء الأوامر المذكورة فعلياً في جدول README. */
function readmeCommandNames() {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  const from = readme.indexOf(START);
  const to = readme.indexOf(END);
  assert.ok(from >= 0 && to > from, 'جدول الأوامر غير موجود في README أو محدّاته ناقصة');
  const names = [];
  for (const line of readme.slice(from, to).split('\n')) {
    const m = /^\|\s*`\/([a-z0-9-]+)`\s*\|/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

describe('عقود المشروع', () => {
  describe('أوزان التقييم', () => {
    test('مجموع أوزان كل فريق في SCORE_WEIGHTS يساوي 100 بالضبط', () => {
      const bad = [];
      for (const [team, weights] of Object.entries(SCORE_WEIGHTS)) {
        const total = Object.values(weights).reduce((a, b) => a + Number(b), 0);
        if (total !== 100) bad.push(`${team}: ${total} (${JSON.stringify(weights)})`);
      }
      assert.equal(bad.length, 0, `أوزان لا تساوي 100 — الترتيب بين الفرق يصبح غير قابل للمقارنة:\n  ${bad.join('\n  ')}`);
    });

    test('scoreWeights(team) في الخدمة تُعيد أوزاناً مجموعها 100 لكل فريق', () => {
      // العقد الحقيقي ليس في الثوابت فقط: settings.scoreWeights هي ما يقرأه
      // score.js فعلياً، وقد تدمج تعديلاً محفوظاً فوق الأساس.
      const bad = [];
      for (const team of Object.keys(SCORE_WEIGHTS)) {
        const weights = settings.scoreWeights(team);
        const total = Object.values(weights).reduce((a, b) => a + Number(b), 0);
        if (total !== 100) bad.push(`${team}: ${total}`);
      }
      assert.equal(bad.length, 0, `scoreWeights لا تعيد مجموعاً = 100:\n  ${bad.join('\n  ')}`);
    });

    test('setScoreWeights يرفض أي مجموعة لا تساوي 100', () => {
      // الطرف المقابل: لو مرّ مجموع خاطئ من هنا، فالثابت أعلاه ينهار لاحقاً.
      const team = Object.keys(SCORE_WEIGHTS)[0];
      const good = { ...SCORE_WEIGHTS[team] };
      const bad = { ...good };
      bad[Object.keys(bad)[0]] = Number(bad[Object.keys(bad)[0]]) + 1;
      assert.equal(settings.setScoreWeights(team, good).ok, true, 'رفض مجموعة صحيحة — الحارس صار أضيق من العقد');
      assert.equal(settings.setScoreWeights(team, bad).ok, false, 'قَبِل أوزاناً مجموعها ليس 100');
    });
  });

  describe('سجل الأوامر', () => {
    test('validateRegistry() يرجع قائمة فراغية', () => {
      const problems = validateRegistry();
      assert.deepEqual(problems, [], `مشاكل في السجل:\n  ${problems.join('\n  ')}`);
    });

    test('كل أمر في السجل مذكور في جدول README', () => {
      const inReadme = new Set(readmeCommandNames());
      const missing = [...commands.keys()].filter(n => !inReadme.has(n));
      assert.equal(missing.length, 0, `أوامر مسجّلة وغير مذكورة في README: ${missing.join(', ')}`);
    });

    test('كل أمر في جدول README يُحلّ في السجل', () => {
      // الاتجاه المعاكس: أمر باقٍ في README بعد حذفه من السجل يضلّل الفريق.
      const unknown = readmeCommandNames().filter(n => !commands.has(n));
      assert.equal(unknown.length, 0, `أوامر في README لا وجود لها في السجل: ${unknown.join(', ')}`);
    });

    test('جدول README مطابق تماماً للمولّد (الوصف والصلاحية أيضاً)', () => {
      // مصدر واحد للحقيقة: نفس أمر --check الذي يشغّله CI. توحيد السطور
      // (CRLF مقابل LF) مُجرى داخل السكربت نفسه، فالنتيجة لا تختلف باختلاف
      // core.autocrlf عند المطوّر ولا باختلاف سطر نهاية المحرار.
      const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'gen-readme-commands.js'), '--check'], {
        cwd: ROOT, encoding: 'utf8',
      });
      assert.equal(res.status, 0,
        `جدول README لا يطابق المولّد — شغّل npm run docs:commands\n${res.stderr || res.stdout || ''}`);
    });
  });
});