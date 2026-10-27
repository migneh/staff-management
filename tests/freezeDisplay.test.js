'use strict';
// حارس ثابت: طابع التجميد لا يُعرض خاماً في أي رسالة (بند ⑭).
// dateLine وضعت تحكم القارئ: ترويه محلياً + نسبة زمنية، لا نص خام بجناح مساحة UTC.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const FREEZE_DISPLAY_SITES = [
  'commands/punishments.js',
  'commands/cover-shift.js',
  'commands/my-points.js',
  'commands/points-admin.js',
];
// كل استيفاء لـ .until في رسالة يجب أن يمرّ من kit.dateLine لا النص الخام
const RAW_UNTIL = /حتى \$\{(fr|r|freeze)\.until\}/;

const read = rel => fs.readFileSync(path.join(SRC, ...rel.split('/')), 'utf8');

describe('عرض التجميد — لا النص الخام (⑭)', () => {
  test('كل موقع عرض يجري kit.dateLine ولا يعود يستوفي النص الخام', () => {
    for (const site of FREEZE_DISPLAY_SITES) {
      const src = read(site);
      assert.ok(src.includes('kit.dateLine('), `${site} يجب أن يستخدم kit.dateLine للعرض`);
      assert.ok(!RAW_UNTIL.test(src), `${site} يستوفي التاج الخام لـ .until — يمنع`);
    }
  });

  test('تعليق activity خالٍ من النص اللاتيني المزروع', () => {
    const src = read('services/activity.js');
    assert.ok(!src.includes('alcance'), 'لقطة قزمية مزروعة في التعليق — تُستبدل');
    assert.ok(src.includes('لا يستطيع الفهرس أن يتقدّمه'), 'التعليق بصياغة سليمة');
  });
});
