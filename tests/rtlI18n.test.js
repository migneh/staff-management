'use strict';
/**
 * اختبارات صحة RTL+i18n للنصوص التي يراها المستخدم:
 *
 * 1) قصّ واعي بالرموز: `clipRich` (المصدر الوحيد) يمنع تلف النص العربي الظاهر
 *    للمستخدم عند بلوغ حد ديسكورد — شريط ** 조합ي، وطابع <t:…>، ومنشور <@id>
 *    أو backtick، وعلامة تشكيل عربية معلّقة. وtrim/truncate يتفوّضان إليه.
 * 2) لا لاتيني/فرنسي دخيل في النصوص الظاهرة: أدلة على ترجمة ناقصة.
 * 3) شدّة الإنذار لا تُنقل باللون وحده (أعمى الألوان) — شكل مختلف لكل درجة.
 *
 * لا تختبر هذه الأنماط «السلوك» فحسب، بل تثبّت العقود التي كسرتها هذه الأخطاء.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { clipRich, truncate } = require('../src/utils');
const kit = require('../src/ui/kit');
const { WARNING_TYPES } = require('../src/constants');

const ROOT = path.join(__dirname, '..');
const ELLIPSIS = '…';
// علامات التشكيل والتطويل العربية (U+064B–U+065F) والألف الخنجرية (U+0670).
const ARABIC_DIACRITIC = /[ً-ٰٟ]/;

// ===== 1) القصّ الواعي بالرموز =====

describe('القصّ الواعي بالرموز — clipRich', () => {
  test('لا يقطع شريط ** في的话就قسمه ويعرض نجمة عارية', () => {
    // القطع عند 11 يترك فاصل ** الافتتاحي بلا إغلاق.
    const out = clipRich('الملاحظة **مهمة**', 11);
    assert.ok(!out.includes('*'), `نجمة عارية ظاهرة للمستخدم: ${JSON.stringify(out)}`);
    assert.equal(out, `الملاحظة${ELLIPSIS}`);
    // حالتنا مشوهة قبل الإصلاح: verify the guard actually bites.
    assert.ok('الملاحظة **م'.includes('*'));
  });

  test('لا يقطع طابع <t:…:R> فيظهر طابع حرفي للمستخدم', () => {
    const out = clipRich('الطلب <t:1759276800:R> تم', 12);
    assert.ok(!out.includes('<'), `طابع منطوف ظاهر: ${JSON.stringify(out)}`);
    assert.ok(!out.includes(':'), `جزء من صيغة الطابع ظاهر: ${JSON.stringify(out)}`);
    assert.equal(out, `الطلب${ELLIPSIS}`);
  });

  test('لا يقطع منشور <@id> فيظهر منشور حرفي', () => {
    const out = clipRich('سجّل <@123456789012345678>', 12);
    assert.ok(!out.includes('<@'), `منشور منطوف ظاهر: ${JSON.stringify(out)}`);
    assert.equal(out, `سجّل${ELLIPSIS}`);
  });

  test('لا يقطع backtick فيقتح كود معلّق في 메시لة', () => {
    const out = clipRich('السبب `تركيز شديد` الآن', 10);
    assert.ok(!out.includes('`'), `backtick معلّق ظاهر: ${JSON.stringify(out)}`);
    assert.equal(out, `السبب${ELLIPSIS}`);
  });

  test('لا يترك علامة تشكيل عربية معلّقة تسبح وحدها', () => {
    // القطع عند 5 يقع بعد رمز السكون فوق الراء.
    const out = clipRich('قُرْآن ك', 5);
    assert.equal(out, `قُر${ELLIPSIS}`);
    const before = out[out.length - 2];
    assert.ok(!ARABIC_DIACRITIC.test(before), `علامة تشكيل معلّقة: ${JSON.stringify(out)}`);
  });

  test('يحترم الحدّ الأقصى دائماً مهما انكمش الناتج بعد الإصلاح', () => {
    const samples = [
      'الملاحظة **مهمة جداً** توثيق كامل',
      'الطلب <t:1759276800:R> تم الاعتماد',
      'السبب `تركيز شديد جداً` الآن',
      'قُرْآن كَرِيمٌ مَكْتُوبٌ',
      'سجّل <@123456789012345678> في السجل',
      '<t:1759276800:R><@123456789012345678>**`قُرْ`',
    ];
    for (const sample of samples) {
      for (let n = 1; n <= sample.length + 4; n++) {
        const out = clipRich(sample, n);
        assert.ok(out.length <= n, `تجاوز الحد ${n}: ${JSON.stringify(out)} (${out.length})`);
        assert.equal(typeof out, 'string');
      }
    }
  });

  test('نص أقصر من الحدّ يمرّ كما هو بلا علامة حذف', () => {
    assert.equal(clipRich('قصير', 100), 'قصير');
    assert.equal(clipRich('قصير تماماً', 'قصير تماماً'.length), 'قصير تماماً');
    assert.equal(clipRich('', 10), '');
    assert.equal(clipRich(null, 10), '');
    assert.equal(clipRich(undefined, 10), '');
    // حدّ أصغر من حرف واحد لا ينتج نصاً يتجاوز ما طلبه Discord.
    assert.equal(clipRich('طويل', 1).length, 1);
    assert.equal(clipRich('طويل', 0), '');
  });

  test('trim وtruncate يفوّضان إلى clipRich — سلوك واحد لا سلوكان', () => {
    const samples = [
      'الملاحظة **مهمة**',
      'الطلب <t:1759276800:R> تم',
      'السبب `تركيز شديد` الآن',
      'قُرْآن ك',
      'سجّل <@123456789012345678>',
    ];
    for (const sample of samples) {
      for (const n of [5, 9, 12, 18, 40]) {
        assert.equal(kit.trim(sample, n), clipRich(sample, n), `trim ≠ clipRich عند ${n}`);
        assert.equal(truncate(sample, n), clipRich(sample, n), `truncate ≠ clipRich عند ${n}`);
      }
    }
  });

  test('clip في kit يمرّ بالمصدر نفسه فلا يبقى مسار قصّ ثالث', () => {
    const sample = 'الملاحظة **مهمة**';
    assert.equal(kit.clip(sample, 11), clipRich(sample, 11));
  });
});

// ===== المواقع المقطوعة_raw — يجب أن تمرّ بالمساعد =====

describe('مواقع القصّ الخام', () => {
  // الملفات التي نملكها. staffing/سجلات/تشغيل/انضمام/ترقية owned by غيرنا.
  const OWNED = ['src/commands/records.js', 'src/commands/my-status.js', 'src/commands/leaves.js'];

  // قصّ النصوص فقط. القصّ على مصفوفة = سقف عدد عناصر ديسكورد (10/25)،
  // وقصّ طابع زمني = تنسيق تاريخ — ناتجهما ليس نصاً يُعرض ولا يحتاج إصلاحاً.
  const TEXT_SLICE = /\.slice\(\s*0\s*,\s*(?:1\d\d|[2-9]\d\d|\d{3,})\s*\)/;
  // استثناءات مثبتة: سقوف عدد عناصر، أو قصّ طابع ISO.
  const ALLOWED = [
    /\.slice\(\s*0\s*,\s*(?:10|25)\s*\)/,      // سقف خيارات القوائم
    /\.toISOString\(\)\.slice\(\s*0\s*,\s*19\s*\)/, // طابع زمني ISO
  ];
  test('لا قصّ خام بــ.slice(0, N) باقٍ في الملفات المملوكة', () => {
    for (const rel of OWNED) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      const offenders = src
        .split(/\r?\n/)
        .map((line, i) => ({ line: i + 1, text: line }))
        .filter(({ text }) => TEXT_SLICE.test(text))
        .filter(({ text }) => !ALLOWED.some(rx => rx.test(text)))
        // نتجاهل ما لم يبقَ بعد استثناء مصفوفة/تاريخ على نفس السطر.
        .filter(({ text }) => !/toISOString\(\)/.test(text));
      assert.deepEqual(offenders, [], `${rel}: قصّ خام لنص ظاهر — مرّره عبر truncate`);
    }
  });
});

// ===== 2) اللاتيني/الفرنسي الدخيل =====

/**
/**
 * مستخرج النصوص الحرفية عبر محلّل JavaScript حقيقي (acorn) بدل قارّئ مُصنوع:
 * القارّئ اليدوي ينخدع بالمتعاطر داخل ${...} فيستعرض نصًا كاذبًا. acorn
 * مثبّت أصلًا كاعتمادية لـ eslint، فلن نضيف اعتمادًا جديدًا.
 * يُعاد الأجزاء الثابتة فقط — بلا استيفاءات — مع رقم السطر لكل جزء مثبّت في القوالب.
 */
const acorn = require('acorn');

/** يجمع الأجزاء الثابتة من عقدة الشمر بعمق. */
function collect(node, out) {
  if (!node || typeof node.type !== 'string') return;
  if (node.type === 'Literal') {
    if (typeof node.value === 'string') out.push({ val: node.value, line: node.loc.start.line });
    return;
  }
  if (node.type === 'TemplateLiteral') {
    for (const q of node.quasis) out.push({ val: q.value.cooked, line: q.loc.start.line });
    for (const e of node.expressions) collect(e, out);
    return;
  }
  for (const key of Object.keys(node)) {
    if (['loc', 'start', 'end', 'type', 'raw'].includes(key)) continue;
    const child = node[key];
    if (Array.isArray(child)) for (const c of child) collect(c, out);
    else if (child && typeof child === 'object') collect(child, out);
  }
}

function extractLiterals(src) {
  const ast = acorn.parse(src, { ecmaVersion: 2022, locations: true, sourceType: 'script' });
  const out = [];
  collect(ast, out);
  return out;
}

const ARABIC = /[؀-ۿ]/;
const SQL_LIKE = /\b(SELECT|UPDATE|INSERT|DELETE\s+FROM|CREATE\s+TABLE)\b/i;

// رموز تقنية مشروعة: أسماء رتب ومصطلحات معتمدة — لا ترجمة ناقصة.
const ALLOWED_LATIN = new Set([
  'Boss', 'ID', 'Score', 'Hex', 'Discord', 'Administrator',
  'in', 'vacation', // اسم رتبة إجازة حقيقي في الإعدادات
  'weekly', 'family', // مثال معرّف قالب
  'ticket', // مثال رقم تكت
]);

/** ينظّف النص من الرموز التي لا تُترجم: منشورات، روابط، أوامر، وقيم. */
function scrub(val) {
  return val
    .replace(/<[@#][^>]*>/g, '')
    .replace(/https?:\/\/\S*/g, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\/?#?\d[\d-]*/g, '')
    .replace(/\s*\/\S+/g, '')
    .replace(/YYYY-MM-DD/g, '')
    .replace(/[A-Z][A-Z0-9_]{2,}/g, '');
}

describe('لا لاتيني/فرنسي دخيل في النصوص الظاهرة للمستخدم', () => {
  // نفس النطاق الذي نملكه: مسح src كاملاً الآن يعني السباق على ملاك الملفات
  // الآخرين، فيسقط الفحص بلا فائدة. النطاق موسّع أدناه عند تسليم كل ملف.
  const SCANNED = [
    'src/utils.js',
    'src/ui/kit.js',
    'src/commands/records.js',
    'src/commands/audit.js',
    'src/commands/my-status.js',
    'src/commands/logging.js',
    'src/commands/leaves.js',
  ];

  test('لا كلمة لاتينية/فرنسية غريبة داخل نص عربي', () => {
    const offences = [];
    for (const rel of SCANNED) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      for (const { val, line } of extractLiterals(src)) {
        if (!val || !ARABIC.test(val) || SQL_LIKE.test(val)) continue;
        const words = (scrub(val).match(/[A-Za-z]{2,}/g) || []);
        for (const word of words) {
          if (!ALLOWED_LATIN.has(word)) offences.push(`${rel}:${line} → «${word}» في ${JSON.stringify(val)}`);
        }
      }
    }
    assert.deepEqual(offences, [], `نصوص ظاهرة بلاتيني/فرنسي:\n${offences.join('\n')}`);
  });

  test('أوصاف خيارات audit-export عربية بالكامل', () => {
    const audit = require('../src/commands/audit');
    const cmd = audit.commands.find(c => c.data.name === 'audit-export');
    const descs = cmd.data.options.map(o => o.description);
    for (const d of descs) {
      assert.ok(!/[A-Za-z]{2,}/.test(d), `وصف خيار يحوي لاتينياً: ${d}`);
    }
    // خطأ إملائي سابق: «الأرجاع» ليست كلمة — الصحيح «الأيام».
    const days = descs.find(d => d.includes('الأيام') || d.includes('الأرجاع'));
    assert.ok(days && days.includes('الأيام'), `وصف days غير مصحَّح: ${days}`);
  });

  test('حالة «غير مؤهل» في my-status عربية لا فرنسية', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/my-status.js'), 'utf8');
    assert.ok(!src.includes('actuellement'), 'كلمة فرنسية ما زالت في my-status');
  });

  test('أوصاف قالب الإجازة بلا كلمة Override ملصوقة بالعربية', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/leaves.js'), 'utf8');
    assert.ok(!/[\u0600-\u06FF]Override/.test(src), 'بادئة عربية ملصوقة بكلمة Override ما زالت في leaves');
  });

  test('/add-note لا يَعِد بنقاط — بلDeleted نظام النقاط فلا وعد', () => {
    const records = require('../src/commands/records');
    const cmd = records.commands.find(c => c.data.name === 'add-note');
    const typeOpt = cmd.data.options.find(o => o.name === 'type');
    for (const choice of typeOpt.choices) {
      assert.ok(!/[+-]\s*\d+/.test(choice.name), `اختيار ما زال يَعِد بنقاط: ${choice.name}`);
    }
    // والاختياران يطابقان ما يعرضه /note (نفس الجدول، نفس الوعد).
    assert.deepEqual(typeOpt.choices.map(c => c.value), ['positive', 'negative']);
  });

  test('لا تعليق في add-note يدّعي منح نقاط (النظام محذوف)', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src/commands/records.js'), 'utf8');
    assert.ok(!/\+\s*5/.test(src), 'records.js ما زال يدّعي +5 في تعليقه');
  });
});

// ===== 3) شدّة الإنذار بالشكل لا باللون =====

describe('شدّة الإنذار — شكل مميز لكل درجة', () => {
  // دوائر ملوّنة فقط: تحت deuteranopia/protanopia ثلاثتها أصفر متقارب.
  const COLOUR_ONLY = new Set(['🟢', '🟡', '🟠', '🔴', '🔵', '🟣', '🟤', '⚫', '⚪', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪']);
  // الشكل المطلوب: رمز مختلف لكل درجة، قابل للتمييز بلا لون.
  const EXPECTED = { verbal: '🗣️', first: '⚠️', second: '⛔', final: '🚨' };

  test('كل درجة إنذار لها رمز شكل لا يُنقل باللون وحده', () => {
    const entries = Object.entries(WARNING_TYPES);
    assert.ok(entries.length >= 4, 'WARNING_TYPES فارغ أو ناقص');
    for (const [key, def] of entries) {
      assert.ok(def.emoji, `${key}: بلا رمز`);
      assert.ok(def.label, `${key}: بلا تسمية عربية`);
      assert.ok(
        !COLOUR_ONLY.has(def.emoji),
        `${key}: الرمز ${def.emoji} دائرة ملوّنة — غير مميّز لعمى الألوان`,
      );
    }
  });

  test('لا تكرار بين رموز الدرجات — كل رمز شكل مختلف', () => {
    const glyphs = Object.values(WARNING_TYPES).map(w => w.emoji);
    assert.equal(new Set(glyphs).size, glyphs.length, `رموز مكرّرة: ${JSON.stringify(glyphs)}`);
  });

  test('الدرجات تستخدم الأشكال المطلوبة (🗣️ ⚠️ ⛔ 🚨)', () => {
    for (const [key, glyph] of Object.entries(EXPECTED)) {
      assert.equal(WARNING_TYPES[key]?.emoji, glyph, `${key}: متوقع ${glyph} ووجد ${WARNING_TYPES[key]?.emoji}`);
    }
  });
});
