'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const clock = require('../src/clock');
const settings = require('../src/services/settings');
const reports = require('../src/services/reports');
const { SCORE_DEFAULTS, resolveWeights, scoreWeights, computeScore } = require('../src/services/score');

beforeEach(() => openMemoryDb());

test('جدول الأوزان الافتراضي: تجاوز متَّخذ وحدود تُحترم وقيم غريبة تُتجاهَل', () => {
  assert.ok(Object.isFrozen(SCORE_DEFAULTS), 'جدول الافتراضات مجمّد');
  assert.equal(resolveWeights({ activity: 50 }).activity, 50, 'وزن صحيح يُعتمد كما هو');
  assert.equal(resolveWeights({ activity: 500 }).activity, 100, 'السقف 100');
  assert.equal(resolveWeights({ activity: -3 }).activity, 30, 'السالب يعود إلى الافتراضي');
  assert.equal(resolveWeights({ productivity: 'abc' }).productivity, 25, 'النص الغريب يُتجاهَل');
  assert.equal(resolveWeights({ rating: null }).rating, 20, 'المفتاح الخالي فراغ سياسة لا صفر مرايا');
  assert.deepEqual(resolveWeights('not-an-object'), SCORE_DEFAULTS.weights, 'تجاوز غير كائن = لا تجاوز');
  assert.deepEqual(
    resolveWeights({ activity: 0, productivity: 0, rating: 0, speed: 0, discipline: 0 }),
    SCORE_DEFAULTS.weights,
    'مجموع صفر لا يهدم المقياس — يعود الجدول الافتراضي كله');
  // الصفر الصريح صالح إذا بقي المجموع موجباً: استبعاد عامل بالميزان مطلوب مشروع.
  const partial = resolveWeights({ activity: 0, productivity: 50 });
  assert.equal(partial.activity, 0);
  assert.equal(partial.productivity, 50);
  assert.equal(partial.rating, 20);
});

test('الأوزان الحيّة من السياسة: تجاوز تجاري وقيمة غريبة تعود للافتراضي', () => {
  settings.setPolicy('score.weights', { activity: 50, productivity: 0, rating: 0, speed: 0, discipline: 0 });
  const live = scoreWeights();
  assert.equal(live.activity, 50);
  assert.equal(live.speed, 0, 'الصفر المصرَّح في السياسة وزنٌ معتمد لا مجاهلة');
  assert.deepEqual(
    Object.keys(live).sort(),
    Object.keys(SCORE_DEFAULTS.weights).sort(),
    'مفاتيح الخمسة لا تفقد ولا تزد');
  // قيمة غير رقمية في كل مفاتيح السياسة: يعود الجدول الافتراضي كاملاً
  settings.setPolicy('score.weights', { activity: 'x', productivity: 'x', rating: 'x', speed: 'x', discipline: 'x' });
  assert.deepEqual(scoreWeights(), SCORE_DEFAULTS.weights);
  settings.resetPolicy('score.weights');
  assert.deepEqual(scoreWeights(), SCORE_DEFAULTS.weights, 'بعد المسح يعود الافتراضي');
});

test('الحصيلة القصوى 100: كل عامل في سعته الكاملة', () => {
  const res = computeScore(
    { weightedMessages: 150, activeDays: 30, tickets: 100, avgRating: 5, ratingCount: 3, avgDuration: 0 },
    { team: 'support' }, { windowDays: 30 });
  assert.equal(res.score, 100);
  assert.deepEqual(res.parts, { activity: 1, productivity: 1, rating: 1, speed: 1, discipline: 1 });
  assert.deepEqual(res.evidence.dropped, [], 'حصيلة مكتملة لا عامل بلا شاهد فيها');
  assert.equal(res.evidence.rating, 'customer');
});

test('الحصيلة الصفرية: لا نشاط ولا إنتاجية ولا انضباط → صفر', () => {
  const res = computeScore({ weightedMessages: 0, activeDays: 5, tickets: 0, warnings: 4 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(res.score, 0);
  // الحصيلة بلا مخالفات ليست صفراً بالتصميم: غياب المخالفة شاهد على الانضباط
  // الكامل (عامل الانضباط = 1)، فيبقى 15/70 من المقياس يمنحها رقمًا موجباً.
  const noViolations = computeScore({ weightedMessages: 0, activeDays: 5, tickets: 0 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(noViolations.parts.discipline, 1);
  assert.ok(noViolations.score > 0, 'نضباط بلا ذنب يُبقي رقمًا موجباً — تصرف مقصود لا فراغ حسابي');
});

test('التطبيع: فقدان شاهدَي الجودة والسرعة يستبعد وزنهما ويُطبَّع الباقي', () => {
  // النشاط مشبع (150/(5×30)) = 1، الإنتاجية 15/30 = 0.5، الانضباط 1،
  // الشاهدان الجودة والسرعة غائبان — الأوزان تبقى صاحبة 70 فقط.
  const res = computeScore(
    { weightedMessages: 150, activeDays: 30, tickets: 15 },
    { team: 'support' }, { windowDays: 30 });
  assert.equal(res.score, 82.1, '(30×1 + 25×0.5 + 15×1) ÷ 70 = 82.1');
  assert.equal(res.parts.rating, null);
  assert.equal(res.parts.speed, null);
  assert.deepEqual(res.evidence.dropped, ['rating', 'speed']);
});

test('شواهد المشرف: تقييم إداري 5–25 وسرعة استجابة 5–25 بديلان مرئيان', () => {
  const adminRated = computeScore({ weightedMessages: 0, activeDays: 5 }, { team: 'support', supervisor_rating: 25 }, { windowDays: 30 });
  assert.equal(adminRated.parts.rating, 1);
  assert.equal(adminRated.evidence.rating, 'supervisor');
  const mid = computeScore({ weightedMessages: 0, activeDays: 5 }, { team: 'support', supervisor_rating: 15 }, { windowDays: 30 });
  assert.equal(mid.parts.rating, 0.5, 'وسط المدى: (15−5)/20 = 0.5');
  // تقييم العملاء له الأولوية عندما يوجد شاهدان معاً
  const customerWins = computeScore({ avgRating: 4, ratingCount: 1 }, { team: 'support', supervisor_rating: 25 }, { windowDays: 30 });
  assert.equal(customerWins.evidence.rating, 'customer');
  // سرعة الاستجابة الإدارية تسبق متوسط مدة التكتات
  const fastAdmin = computeScore({ avgDuration: 59 }, { team: 'support', response_speed: 25 }, { windowDays: 30 });
  assert.equal(fastAdmin.evidence.speed, 'response_speed');
  assert.equal(fastAdmin.parts.speed, 1);
  // مدة التكتات البديلة: صفر دقيقة 1، ونصف نقطة الصفر (30 دقيقة) 0.5
  const duration = computeScore({ avgDuration: 30 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(duration.evidence.speed, 'duration');
  assert.ok(Math.abs(duration.parts.speed - 0.5) < 0.01, '30 دقيقة من سقف 60 تُعطي 0.5');
  const zeroSpeed = computeScore({ avgDuration: 60 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(zeroSpeed.parts.speed, 0, 'نقطة الصفر هي 60 دقيقة تماماً');
  // ومدة غريبة ليس شاهداً: يُستبعد ولا يُصمَّر صفراً
  const weirdDuration = computeScore({ avgDuration: 'banana' }, { team: 'support' }, { windowDays: 30 });
  assert.deepEqual(weirdDuration.evidence.dropped, ['rating', 'speed']);
});

test('نافذة الإنتاجية تتحرك مع windowDays لا مع الثلاثين الثابتة', () => {
  // 15 تكتة في 30 يوماً → 0.5 للمقياس اليومي للدعم (1 تكتة/يوم)
  const month = computeScore({ tickets: 15 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(month.parts.productivity, 0.5);
  // وفي نافذة أقصر: مشبعة 1
  const short = computeScore({ tickets: 15 }, { team: 'support' }, { windowDays: 10 });
  assert.equal(short.parts.productivity, 1);
  // فريق الإشراف يُقاس بالإجراءات بسقف 2/يوم: 30/(2×30) = 0.5
  const mod = computeScore({ actions: 30 }, { team: 'moderation' }, { windowDays: 30 });
  assert.equal(mod.parts.productivity, 0.5);
  // والفريق العام على سقف الدعم البديل 0.5/يوم: 15/(0.5×30) = 1
  const general = computeScore({ tickets: 15 }, { team: 'general_management' }, { windowDays: 30 });
  assert.equal(general.parts.productivity, 1);
});

test('تقييد القيم: خارج [0,1] يرشَّ بالحد، ووزن صفر يُخرِج الجزء من الحساب لا من القيمة', () => {
  const res = computeScore(
    { weightedMessages: 1500, activeDays: 30, avgRating: 6, ratingCount: 3, avgDuration: 0 },
    { team: 'support' }, { windowDays: 30 });
  assert.equal(res.parts.activity, 1, 'رسائل فوق المرآة تُرشَّ إلى 1');
  assert.equal(res.parts.rating, 1, 'تقييم فوق سقف 5 تُرشَّ');
  assert.equal(res.parts.speed, 1, 'مدة سالب المنأى (0) تتشبَّع');
  // وزن صفر مصرَّح: الجزء له قيمة محسوبة لكنه خارج الجمع
  const noRating = computeScore(
    { weightedMessages: 150, activeDays: 30, avgRating: 5, ratingCount: 3 },
    { team: 'support' },
    { weights: { activity: 100, productivity: 0, rating: 0, speed: 0, discipline: 0 }, windowDays: 30 });
  assert.equal(noRating.score, 100, 'النشاط وحده هو الحصيلة بعد تصفير بقية الأوزان');
  assert.equal(noRating.evidence.rating, 'customer', 'شاهد التقييم مرئياً حتى لو خرج من الحساب');
  assert.deepEqual(noRating.evidence.dropped, ['speed'], 'السرعة استُبعدت لغياب شاهدها؛ التقييم بقي ذات شاهد وإن خرج بالوزن');
  // مخالفات متراكمة تجمع الخصم ثم ترشَّ
  const penalized = computeScore({ warnings: 5 }, { team: 'support' }, { windowDays: 30 });
  assert.equal(penalized.parts.discipline, 0, 'خمسة إنذارات تعبر سقف الخصم → 0');
});

test('تكامل حيّ — reports.getRaw يغذّي computeScore والنقطة تنبَّؤ بالحساب اليدوي', () => {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since)
    VALUES ('u-int', 'u-int', 'support', 'Agent', 'active', '2020-01-01 00:00:00')`).run();
  // الرسائل: أوزان 1+2+1 في يومين → متوسط يومي 4 → عامل النشاط 4/(5×2) = 0.4
  const start = clock.addDays(clock.today(), -29); // بداية نافذة 30 يوماً كما يحسبها reports
  const next = clock.addDays(start, 1);
  const act = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day, created_at)
    VALUES ('u-int', 'work', 'chat', ?, ?, ?)`);
  act.run(1, start, `${start} 10:00:00`);
  act.run(2, start, `${start} 11:00:00`);
  act.run(1, next, `${next} 10:00:00`);
  // 5 تكتات مقرَّرة 5 نجوم ومدة 10 دقائق: إنتاجية 5/(1×30)، جودة 1، سرعة 1−10/60
  const closeDay = clock.addDays(start, 5);
  const tick = db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, rating, duration, logged_by, closed_at)
    VALUES (?, 'owner', 'u-int', 'closer', 5, 10, 'sys', ?)`);
  for (let i = 0; i < 5; i++) tick.run(`t-${i}`, `${closeDay} 10:0${i}:00`);
  // إنذار واحد — خصم انضباط 0.25
  db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by, created_at)
    VALUES ('u-int', 'attendance', 'غياب', 'sys', ?)`).run(`${closeDay} 09:00:00`);

  const raw = reports.getRaw('u-int', 30);
  assert.deepEqual(
    { weightedMessages: raw.weightedMessages, activeDays: raw.activeDays, tickets: raw.tickets,
      avgRating: raw.avgRating, avgDuration: raw.avgDuration, warnings: raw.warnings },
    { weightedMessages: 4, activeDays: 2, tickets: 5, avgRating: 5, avgDuration: 10, warnings: 1 });

  const res = computeScore(raw, { team: 'support' }, { windowDays: 30 });
  // 30×0.4 + 25×(5/30) + 20×1 + 10×(1−10/60) + 15×0.75 = 55.75 — والقرار الكسري
  // يُقرب إلى منزلة واحدة، فنقيس بحر signed لا بمعادلة تقريب هشة.
  assert.ok(Math.abs(res.score - 55.75) <= 0.1);
  assert.equal(res.evidence.rating, 'customer');
  assert.equal(res.evidence.speed, 'duration');
  assert.deepEqual(res.evidence.dropped, []);
  assert.ok(Math.abs(res.parts.productivity - 5 / 30) < 0.001);
  assert.ok(Math.abs(res.parts.speed - (1 - 10 / 60)) < 0.001);
  assert.equal(res.parts.discipline, 0.75);
});
