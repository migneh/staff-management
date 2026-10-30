'use strict';
/**
 * ⑯ — أول تغطية لمسجّل logger.js: العتبة، وصياغة السطور، والانعكاس إلى ديسكورد.
 * الانعكاس يخصّ الحالتين warn وerror فقط، ولها تبريد 60 ثانية لكل نطاق كي
 * لا يُغرق القناة. لا قاعدة بيانات هنا: المُختبَر مخرجات الطرفية ودالة
 * العكس المُزوَّدة فقط.
 */
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../src/logger');

const SCOPE_COOLDOWN_MS = 60_000;

const originalConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };
let terminal = [];

beforeEach(() => {
  terminal = [];
  console.log = (...a) => terminal.push(['debug', a.join(' ')]);
  console.info = (...a) => terminal.push(['info', a.join(' ')]);
  console.warn = (...a) => terminal.push(['warn', a.join(' ')]);
  console.error = (...a) => terminal.push(['error', a.join(' ')]);
  logger.setMirror(null);
});

afterEach(() => {
  console.log = originalConsole.log;
  console.info = originalConsole.info;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
});

describe('مستوى الظهور على الطرفية', () => {
  test('العتبة تُخفي الأقل من الحد ولا تُخفي ما يساويه', () => {
    logger.setLevel('warn');
    logger.log('app').debug('تعقّب');
    logger.log('app').info('معلومة');
    logger.log('app').warn('تحذير');
    logger.setLevel('error');
    logger.log('app').warn('تحذير ثانٍ');
    logger.log('app').error('خَطَأ');
    assert.deepEqual(terminal.map(l => l[0]), ['warn', 'error']);
  });

  test('setLevel بقيمة غريبة لا يغيّر العتبة الحالية', () => {
    logger.setLevel('error');
    logger.setLevel('بقيمة لا معنى لها');
    logger.log('app').info('معلومة');
    logger.log('app').warn('تحذير');
    logger.log('app').error('خطأ');
    assert.deepEqual(terminal.map(l => l[0]), ['error'], 'بقيت العتبة على error فالمعلومة والتحذير ساقطان');
  });

  test('عتبة الافتراضي تأتي من LOG_LEVEL، والقيمة الغريبة تعود إلى info', () => {
    process.env.LOG_LEVEL = 'error';
    delete require.cache[require.resolve('../src/logger')];
    const fresh = require('../src/logger');
    fresh.log('f1').info('معلومة محجوبة');
    fresh.log('f1').error('خطأ ظاهر');
    assert.deepEqual(terminal.map(l => l[0]), ['error']);
    process.env.LOG_LEVEL = 'loud';
    delete require.cache[require.resolve('../src/logger')];
    const fresh2 = require('../src/logger');
    fresh2.log('f2').info('معلومة ظاهرة');
    assert.deepEqual(terminal.map(l => l[0]), ['error', 'info']);
    delete process.env.LOG_LEVEL;
  });

  test('صياغة السطر: الخطأ يظهر بكامل جسده والكائن يصير نصَّ JSON مع سلسلة', () => {
    logger.setLevel('debug');
    logger.log('app').error(new Error('قول القول'), { where: 'هنا' }, 'متتالية');
    const [line] = terminal;
    assert.equal(line[0], 'error');
    assert.match(line[1], /\[app\]/);
    assert.match(line[1], /Error: قول القول/);
    assert.match(line[1], /"where":"هنا"/);
    assert.match(line[1], /متتالية/);
  });
});

describe('الانعكاس من الطرفية إلى ديسكورد', () => {
  /** مُسجّل انعكاس بسيط يجمع النداءات (level, scope, line). */
  let mirrorCalls;

  beforeEach(() => {
    mirrorCalls = [];
    logger.setMirror((...a) => mirrorCalls.push(a));
  });

  test('warn وerror فقط ينعكسان، وinfo/debug لا يسري عليهما', () => {
    logger.log('f1').info('معلومة');
    logger.log('f1').error('خطأ');
    logger.log('f2').warn('تحذير');
    assert.equal(mirrorCalls.length, 2);
    assert.equal(mirrorCalls[0][0], 'error');
    assert.equal(mirrorCalls[1][0], 'warn');
  });

  test('التبريد 60 ثانية لكل نطاق: سطر واحد لكل نطاق أثناءه، والنطاق الآخر مستقل', () => {
    logger.log('s1').error('أول');
    logger.log('s1').error('ثانٍ محجوب بالتبريد');
    logger.log('s1').warn('تحذير محجوب أيضاً');
    logger.log('s2').warn('نطاق آخر بلا تبريد');
    assert.deepEqual(mirrorCalls.map(c => c[1]), ['s1', 's2']);

    logger.log('s3').error('أول في نطاقه');
    logger.log('s3').error('ثانٍ محجوب');
    assert.deepEqual(mirrorCalls.map(c => c[1]), ['s1', 's2', 's3']);
    assert.equal(SCOPE_COOLDOWN_MS, 60_000, 'عقد التبريد ثابت في المصدر');
  });

  test('عاكس يرمي استثناء: التسجيل على الطرفية لا يفشل معه', () => {
    logger.setMirror(() => { throw new Error('فشل العاكس'); });
    logger.log('f2').error('خطأ يُطبع');
    assert.equal(terminal.length, 1, 'الطرفية استقبلت السطر رغم فشل العاكس');
  });

  test('تمرير غير دالة إلى setMirror يسقط في لا-عاكس بلا أذى', () => {
    logger.setMirror('ليست دالة');
    logger.log('f3').error('خطأ');
    assert.equal(terminal.length, 1, 'الخطأ يُطبع رغم فشل الإعداد');
    logger.setMirror((...a) => mirrorCalls.push(a));
    logger.log('f3').error('خطأ ثانٍ');
    assert.equal(mirrorCalls.length, 1, 'إعادة الإعداد بدالة سليمة تعيد العكس للعمل');
  });
});
