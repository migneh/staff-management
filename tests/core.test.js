'use strict';
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const activity = require('../src/services/activity');
const score = require('../src/services/score');
const promo = require('../src/services/promotions');
const faq = require('../src/services/faq');
const reports = require('../src/services/reports');
const clock = require('../src/clock');
const { resolveComponent } = require('../src/commands');

function seedStaff(id, team, rank, extra = {}) {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, 'u' + id, team, rank, extra.status || 'active', extra.since || '2025-01-01 00:00:00', extra.since || '2025-01-01 00:00:00', extra.last || '2026-09-12 00:00:00');
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

// ===== أدوات بوابات الترقية =====
// كل حالة تُزرع في قاعدة بيانات جديدة (openMemoryDb) بتواريخ محسوبة من اليوم
// فلا تتقادم البيانات ولا تتداخل حالتان في صفوف بعضهما أبداً.

/** عائلات الترقيات: كل بوابة تُختبر داخل الرتبة التي تُفعّلها فعلاً */
const PROMO_FAMILIES = {
  // إشراف: الإجراءات المعالجة، القرارات الخاطئة، سرعة «تقييم المشرف»، الأداء المستقر
  modTrial: { team: 'moderation', rank: 'Trial Moderator', sinceDays: 60 },
  modSenior: { team: 'moderation', rank: 'Moderator', sinceDays: 120 },
  modAdmin: { team: 'moderation', rank: 'Admin', sinceDays: 210, actions: 65, savedScore: 80 },
  // دعم: الرسائل، تقييم العملاء، سرعة «متوسط التكتات»، تقييم المشرف
  supExpert: { team: 'support', rank: 'Support', sinceDays: 120 },
  supHelper: { team: 'support', rank: 'Helper', sinceDays: 90 },
};

/**
 * يزرع عضواً ومادّة شروط ترقيته كاملة — القيم الافتراضية تجتز كل بوابات عائلته.
 * النشاط يُكتب بعمود day داخل نافذة الـScore وcreated_at افتراضي «الآن» داخل
 * نافذة البوابة، فيقرأه الطرفان معاً بلا إزاحة توقيت.
 * @param {string} family مفتاح PROMO_FAMILIES
 * @param {object} overrides مادّة بوابة واحدة مفسودة (أو `{}` لحالة الصحة)
 * @param {string} id معرّف فريد داخل قاعدتها الجديدة
 * @returns {object} صف staff_members بعد كل التعديلات
 */
function seedPromoMember(family, overrides = {}, id = `gate_${family}`) {
  openMemoryDb();
  const cfg = {
    status: 'active', activeDays: 28, rowsPerDay: 6,
    actions: 60, responseSpeed: 25, warnings: 0, negativeNotes: 0,
    tickets: 50, duration: 4, ratingCount: 5, stars: 5,
    teamInteraction: 25, supervisorRating: 20, savedScore: null,
    ...PROMO_FAMILIES[family], ...overrides,
  };
  const db = getDb();
  const since = clock.addDays(clock.today(), -cfg.sinceDays);
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, id, cfg.team, cfg.rank, cfg.status, since, since);

  const activity = db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES (?, '1', 'staff', 0.25, ?)`);
  for (let d = 0; d < cfg.activeDays; d++) {
    const day = clock.addDays(clock.today(), -d);
    for (let k = 0; k < cfg.rowsPerDay; k++) activity.run(id, day);
  }

  if (cfg.team === 'moderation') {
    const act = db.prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason) VALUES (?, 'x', 'warn', 'r')`);
    for (let k = 0; k < cfg.actions; k++) act.run(id);
    db.prepare(`UPDATE staff_members SET response_speed = ? WHERE user_id = ?`).run(cfg.responseSpeed, id);
  } else {
    const tick = db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, duration, logged_by) VALUES (?, ?, ?, ?, ?, 'log')`);
    for (let k = 0; k < cfg.tickets; k++) tick.run(`${id}_t${k}`, id, id, id, cfg.duration);
    const ratedAt = `${clock.today()} 12:00:00`;
    const rating = db.prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, rated_at, source_message_id, source_channel_id, source_guild_id, source_bot_id) VALUES (?, 'rev', ?, ?, ?, 'c', 'g', 'b')`);
    for (let k = 0; k < cfg.ratingCount; k++) rating.run(id, cfg.stars, ratedAt, `${id}_r${k}`);
    if (family === 'supHelper') {
      db.prepare(`UPDATE staff_members SET team_interaction = ?, supervisor_rating = ? WHERE user_id = ?`)
        .run(cfg.teamInteraction, cfg.supervisorRating, id);
    }
  }

  const warn = db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES (?, 'first', 'r', 'b')`);
  for (let k = 0; k < cfg.warnings; k++) warn.run(id);
  const note = db.prepare(`INSERT INTO staff_notes (user_id, note_type, content, added_by) VALUES (?, 'negative', 'قرار خاطئ', 'mgr')`);
  for (let k = 0; k < cfg.negativeNotes; k++) note.run(id);

  if (cfg.savedScore != null) {
    const period = `${clock.today().slice(0, 7)}:${cfg.team}`;
    db.prepare(`INSERT INTO saved_reports (report_type, period, data) VALUES ('monthly', ?, ?)`)
      .run(period, JSON.stringify({ members: [{ user: id, score: cfg.savedScore, rank: cfg.rank }] }));
  }

  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

/** يوحّد لاحقة النافذة «(30 يوم)» — تسمية البوابة نفسها لا رقم نافذتها */
const stripWindow = label => label.replace(/\s*\(\d[^)]*\)\s*$/, '');

/** يطابق تسمية بوابة داخل مصفوفة checks مع مواصفة الحالة (مع استثناء نص إن وُجد) */
const matchGate = (label, spec) => label.includes(spec.gate) && (!spec.gateNot || !label.includes(spec.gateNot));

/** حالات الفشل المستقلة: كل حالة تُفسد مادّة بوابة واحدة فقط */
const PROMO_GATE_CASES = [
  { gate: 'مدة الخدمة بالرتبة', family: 'modTrial', bad: { sinceDays: 10 } },
  { gate: 'تقييم الأداء Score', family: 'modTrial', bad: { actions: 20, activeDays: 18, responseSpeed: 1 } },
  { gate: 'الرسائل', family: 'supExpert', bad: { rowsPerDay: 2 } },
  { gate: 'تقييم العملاء', family: 'supExpert', bad: { stars: 3 } },
  { gate: 'تقييم المشرف', family: 'supHelper', bad: { supervisorRating: null } },
  { gate: 'الإجراءات المعالجة', family: 'modSenior', bad: { actions: 10 } },
  { gate: 'التواجد', family: 'modTrial', bad: { activeDays: 10, rowsPerDay: 17 } },
  { gate: 'الإنذارات الرسمية', family: 'modTrial', bad: { warnings: 1 } },
  { name: 'سرعة الاستجابة (تقييم المشرف)', gate: 'سرعة الاستجابة (تقييم المشرف)', family: 'modSenior', bad: { responseSpeed: 10 } },
  { name: 'سرعة الاستجابة (متوسط التكتات)', gate: 'سرعة الاستجابة', gateNot: 'تقييم المشرف', family: 'supExpert', bad: { duration: 120 } },
  { gate: 'القرارات الخاطئة', family: 'modTrial', bad: { negativeNotes: 1 } },
  { gate: 'الأداء المستقر', family: 'modAdmin', bad: { savedScore: 50 } },
  { gate: 'الحالة', family: 'modTrial', bad: { status: 'on_leave' } },
];

beforeEach(() => openMemoryDb());

describe('فلتر السبام', () => {
  test('يرفض الرسائل القصيرة والإيموجي والرموز والتكرار', () => {
    assert.equal(activity.spamReason('hi'), 'short');
    assert.equal(activity.spamReason('😀😀😀😀😀😀😀😀'), 'emoji_only');
    assert.equal(activity.spamReason('!!!???...---'), 'symbols_only');
    assert.equal(activity.spamReason('aaaaaaaaaaaa'), 'repeated_char');
    assert.equal(activity.spamReason('السلام عليكم ورحمة الله'), null);
  });
  test('يتجاهل الرسالة المكررة خلال دقيقتين ويطبق حد 20 رسالة عامة', () => {
    const ch = { id: '1', name: 'general' };
    assert.equal(activity.record('u1', ch, 'رسالة طبيعية طويلة').counted, true);
    assert.equal(activity.record('u1', ch, 'رسالة طبيعية طويلة').reason, 'duplicate');
    for (let k = 0; k < 19; k++) activity.record('u1', ch, `رسالة مختلفة رقم ${k} هنا`);
    assert.equal(activity.record('u1', ch, 'رسالة إضافية بعد الحد').reason, 'daily_cap');
    assert.equal(activity.record('u1', { id: '2', name: 'ticket-0001' }, 'قنوات التكتات بلا حد').counted, true);
  });
  test('يصنف قنوات التكتات بالاسم والوزن الصحيح', () => {
    assert.equal(activity.classifyChannel({ id: 'x', name: 'ticket-0042' }), 'ticket');
    assert.equal(activity.classifyChannel({ id: 'x', name: 'chat' }), 'general');
  });
});

describe('Score', () => {
  test('Helper يُحسب بدون تكتات، والتقييم الغائب لا يمنح نقاطاً مجانية', () => {
    const s = seedStaff('h1', 'support', 'Helper');
    const r = score.compute(s, { messages: 200, activeDays: 26, tickets: 0 });
    assert.equal(r.factors.length, 4);
    assert.equal(r.factors[0].pts, 25);
    assert.equal(r.factors[1].pts, 25);
    // تفاعل الفريق وتقييم المشرف غير مُقيَّمين: وزنهما (50) خارج المقام
    assert.equal(r.assessedMax, 50);
    assert.equal(r.factors[2].assessed, false);
    assert.equal(r.factors[3].assessed, false);
    assert.equal(r.score, 100); // (25+25) / 50
    // عند وجود تقييم مشرف يحتسب مقامه ويُنقص النسبة فعلياً
    // التقييمات البشرية على سلم 5-25 (كما في قاعدة البيانات)، فيدخل وزنها في المقام
    const rated = score.compute({ ...s, supervisor_rating: 20 }, { messages: 200, activeDays: 26, tickets: 0 });
    assert.equal(rated.assessedMax, 75);
    assert.equal(rated.score, Math.round(((25 + 25 + 20) / 75) * 100));
  });
  test('Support يُحسب بالتكتات والسرعة', () => {
    const s = seedStaff('s1', 'support', 'Support');
    const r = score.compute(s, { messages: 150, activeDays: 21, tickets: 50, avgDuration: 4, avgRating: 4.6 });
    assert.equal(r.score, 30 + 25 + 20 + 16);
    assert.equal(score.grade(r.score), 'ممتاز');
  });
  test('الإشراف يُحسب بالمخالفات، وسرعة الاستجابة غير المُقيَّمة تُستثنى من المقام', () => {
    const s = seedStaff('m1', 'moderation', 'Moderator');
    const r = score.compute(s, { messages: 10, activeDays: 5, actions: 60 });
    assert.equal(r.factors[0].pts, 30);
    assert.equal(r.factors[1].assessed, false); // response_speed فارغ
    assert.equal(r.assessedMax, 75);            // 30 + 25 + 20
    assert.equal(r.score, Math.round(((30 + 5 + 4) / 75) * 100)); // = 52
  });
});

describe('الترقيات', () => {
  test('يقيّم كل الشروط بدقة', () => {
    const s = seedStaff('t1', 'moderation', 'Trial Moderator', { since: '2025-01-01 00:00:00' });
    let ev = promo.evaluate(s);
    assert.equal(ev.rule.to, 'Moderator');
    assert.equal(ev.eligible, false);
    const db = getDb();
    for (let k = 0; k < 60; k++) db.prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason) VALUES (?, 'x', 'warn', 'r')`).run('t1');
    for (let k = 0; k < 200; k++) db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES ('t1', '1', 'staff', 0.25, ?)`).run(`2026-09-${String((k % 28) + 1).padStart(2, '0')}`);
    db.prepare(`UPDATE staff_members SET response_speed = 25 WHERE user_id = 't1'`).run();
    ev = promo.evaluate(s);
    assert.ok(ev.score >= 60, `score ${ev.score}`);
    assert.equal(ev.eligible, true, JSON.stringify(ev.checks));
    // إنذار رسمي يمنع الترقية
    db.prepare(`INSERT INTO warnings (user_id, warning_type, reason, issued_by) VALUES ('t1', 'first', 'r', 'b')`).run();
    ev = promo.evaluate(s);
    assert.equal(ev.eligible, false);
    assert.equal(ev.checks.find(c => c.label.startsWith('الإنذارات الرسمية')).pass, false);
    // كل شرط يعرض قيمته الفعلية والمطلوبة (لا رسائل مبهمة)
    for (const c of ev.checks) { assert.ok(c.actual != null && c.required != null, `شرط ناقص العرض: ${c.label}`); }
  });
  test('Boss لا يملك ترقية', () => {
    const s = seedStaff('b1', 'support', 'Boss');
    assert.equal(promo.evaluate(s).rule, null);
  });

  // ===== كل بوابة ترقية تفشل وحدها =====
  // لكل بوابة: عضوٌ يجتز كل شروط الترقية الأخرى، ثم تُفسَد مادّة بوابة واحدة
  // فقط. لا يُقبل الفشل إلا بسقوط بوابة واحدة بالضبط وبإبطال الأهلية — وإلا
  // كانت البوابة زينة لا تُسقط الترقية إلا متى سقطت معها بقية الشروط.
  // بوابتان خارج التغطية لأن promotions.js لا تُخرجهما أصلاً:
  //  • «حل النزاعات»: السطر يقرأ rule.requireConflictResolution والثوابت تكتب
  //    requiresConflictResolution — تطابق الاسم لا يحدث فالبوابة لا تظهر أبداً.
  //  • «مساعدة عضو جديد»: الثابت requiresHelpedNewbee لا يقرؤه promotions.js.
  //    عقد التغطية أسفله يفشل بصراحة إن صدرت بوابة جديدة بلا حالة فشل.
  test('كل بوابة ترقية يمكن أن تفشل مستقلاً', async (t) => {
    for (const [i, spec] of PROMO_GATE_CASES.entries()) {
      await t.test(spec.name || spec.gate, () => {
        const show = checks => checks.map(c => `${c.pass ? '✔' : '✘'} ${c.label} — ${c.actual} / المطلوب ${c.required}`).join('\n');
        // الحالة الصحية أولاً: لو لم يجتز الأساس كل البوابات فهو ليس أساساً
        const good = promo.evaluate(seedPromoMember(spec.family, spec.good || {}, `gate_ok_${i}`));
        assert.equal(good.eligible, true, `الأساس الصحيح يجب أن يجتز كل البوابات:\n${show(good.checks)}`);
        const goodGate = good.checks.find(c => matchGate(c.label, spec));
        assert.ok(goodGate && goodGate.pass, `البوابة «${spec.gate}» يجب أن تنجح في الأساس الصحيح`);

        // ثم مادّة البوابة وحدها مفسودة: تسقط هي وحدها وتُبطل الأهلية
        const bad = promo.evaluate(seedPromoMember(spec.family, spec.bad, `gate_bad_${i}`));
        assert.equal(bad.eligible, false, `الملف المفسود لا يجوز أن يكون مؤهلاً:\n${show(bad.checks)}`);
        const gate = bad.checks.find(c => matchGate(c.label, spec));
        assert.ok(gate, `البوابة «${spec.gate}» غير مضافة في checks:\n${show(bad.checks)}`);
        const failing = bad.checks.filter(c => !c.pass);
        assert.equal(failing.length, 1, `يجب أن تسقط بوابة واحدة فقط — سقطت ${failing.length}:\n${failing.map(c => `${c.label} (${c.actual} / ${c.required})`).join('\n')}`);
        assert.ok(matchGate(failing[0].label, spec), `البوابة الفاشلة «${failing[0].label}» ليست «${spec.gate}»`);
      });
    }

    // عقد التغطية: كل بوابة يُصدرها promotions.js يجب أن تملك حالة فشل مستقلة
    await t.test('كل بوابة يُصدرها promotions.js لها حالة فشل مستقلة', () => {
      const seen = new Set();
      for (const family of Object.keys(PROMO_FAMILIES)) {
        const ev = promo.evaluate(seedPromoMember(family, {}, `gate_cov_${family}`));
        for (const c of ev.checks) seen.add(stripWindow(c.label));
      }
      const covered = new Set(PROMO_GATE_CASES.map(c => stripWindow(c.gate)));
      assert.deepEqual([...covered].sort(), [...seen].sort(),
        'البوابات المغطاة تختلف عن البوابات الفعلية — أضِف حالة فشل أو صحّح التسمية');
    });
  });
});

describe('FAQ', () => {
  test('إضافة/تعديل/حذف مع التاريخ ونظام القراءة', () => {
    const e = faq.add({ categoryId: 1, title: 'قانون', content: 'محتوى', important: true, userId: 'a' });
    assert.equal(faq.unreadFor('u1').length, 1);
    faq.acknowledge(e.id, 'u1', e.version);
    assert.equal(faq.hasRead(e.id, 'u1'), true);
    assert.equal(faq.unreadFor('u1').length, 0);
    const e2 = faq.edit(e.id, { title: 'قانون معدل', userId: 'a' });
    assert.equal(e2.version, 2);
    assert.equal(faq.hasRead(e.id, 'u1'), false, 'التعديل يتطلب قراءة جديدة');
    assert.equal(faq.history(e.id).length, 2);
    assert.equal(faq.search('معدل').length, 1);
    faq.remove(e.id, 'a');
    assert.equal(faq.get(e.id), null);
    assert.equal(faq.history(e.id).length, 3);
  });
});

describe('قوالب FAQ', () => {
  test('كل قالب مستقل ويمكن نشره وتعديله دون تغيير القوالب الأخرى', () => {
    const faq = require('../src/services/faq');
    const first = faq.addTemplate({ name: 'الدعم', title: 'دليل الدعم', description: 'للدعم فقط', categoryIds: [1, 2], color: 0x123456, userId: 'a' });
    const second = faq.addTemplate({ name: 'التكتات', title: 'دليل التكتات', description: 'للتكتات فقط', categoryIds: [3], color: 0x654321, userId: 'a' });
    faq.addPanel('message-1', 'channel-1', 'a', first.id);
    faq.addPanel('message-2', 'channel-2', 'a', second.id);
    assert.deepEqual(faq.templateCategories(first.id).map(c => c.id), [1, 2]);
    assert.deepEqual(faq.templateCategories(second.id).map(c => c.id), [3]);
    faq.editTemplate(first.id, { title: 'دليل دعم معدل', categoryIds: [4], userId: 'b' });
    assert.equal(faq.template(second.id).title, 'دليل التكتات');
    assert.deepEqual(faq.panels().map(p => p.template_id), [first.id, second.id]);
  });
});

describe('دورة الإجازات والاستقالات', () => {
  test('يتحقق من التواريخ الميلادية بدقة', () => {
    const { isValidDate } = require('../src/utils');
    assert.equal(isValidDate('2026-02-28'), true);
    assert.equal(isValidDate('2026-02-30'), false);
    assert.equal(isValidDate('not-a-date'), false);
  });

  test('يمنع تداخل طلبات العضو ويحسب حد الإجازات المتزامنة', () => {
    const leaves = require('../src/services/leaves');
    const db = getDb();
    db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status) VALUES ('u1', 'normal', 'r', '2026-09-15', '2026-09-20', 'pending')`).run();
    assert.equal(leaves.userHasOverlap('u1', '2026-09-20', '2026-09-22').id, 1);
    assert.equal(leaves.userHasOverlap('u2', '2026-09-20', '2026-09-22'), null);
    db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status) VALUES ('u2', 'normal', 'r', '2026-09-16', '2026-09-18', 'approved')`).run();
    db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status) VALUES ('u3', 'normal', 'r', '2026-09-17', '2026-09-19', 'approved')`).run();
    assert.equal(leaves.concurrentApproved('2026-09-17', '2026-09-17'), 2);
    assert.equal(leaves.approvedForUser('u2', { onOrAfter: '2026-09-17' }).length, 1);
  });

  test('يدعم سحب الاستقالة وتسجيل التذكيرات والحقول الجديدة', () => {
    const db = getDb();
    const result = db.prepare(`INSERT INTO resignations (user_id, reason, last_day, status) VALUES ('u1', 'r', '2026-09-30', 'pending')`).run();
    db.prepare(`UPDATE resignations SET status = 'withdrawn', withdrawn_by = ?, withdrawn_at = datetime('now'), withdraw_reason = ? WHERE id = ?`).run('u1', 'تراجع', result.lastInsertRowid);
    const row = db.prepare('SELECT * FROM resignations WHERE id = ?').get(result.lastInsertRowid);
    assert.equal(row.status, 'withdrawn');
    assert.equal(row.withdraw_reason, 'تراجع');
    assert.equal(row.reminders_sent, '');
  });

  test('يحافظ على رتبة in vacation مع الإجازة القادمة ويزيلها بعد انتهائها', async () => {
    const settings = require('../src/services/settings');
    const leaves = require('../src/services/leaves');
    const { today, addDays } = require('../src/utils');
    const role = { id: 'vac-role', name: 'in vacation' };
    const roleCache = new Map([[role.id, role]]);
    const member = {
      id: 'u1',
      guild: { roles: { cache: roleCache } },
      roles: {
        cache: new Map(),
        async add(r) { this.cache.set(r.id, r); },
        async remove(r) { this.cache.delete(r.id); },
      },
    };
    settings.setRole('system', 'in vacation', role.id);
    const start = today();
    const end = addDays(start, 1);
    getDb().prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status) VALUES ('u1', 'normal', 'r', ?, ?, 'approved')`).run(start, end);
    assert.equal((await leaves.syncVacationRole(member)).ok, true);
    assert.equal(member.roles.cache.has(role.id), true);
    getDb().prepare("UPDATE leave_requests SET status = 'ended' WHERE user_id = 'u1'").run();
    assert.equal((await leaves.syncVacationRole(member)).ok, true);
    assert.equal(member.roles.cache.has(role.id), false);
  });
});

describe('التقارير والـ Leaderboard', () => {
  test('جائزة الشهر لا تُمنح بلا عمل أو أثناء الإجازة', () => {
    const rows = [
      { staff: { user_id: 'idle', team: 'support', rank: 'Support', status: 'active' }, score: 95, raw: { tickets: 0 } },
      { staff: { user_id: 'working', team: 'support', rank: 'Support', status: 'active' }, score: 80, raw: { tickets: 10 } },
      { staff: { user_id: 'leave', team: 'support', rank: 'Support', status: 'on_leave' }, score: 100, raw: { tickets: 50 } },
    ];
    assert.equal(reports.bestOfMonth(rows).staff.user_id, 'working');
  });

  test('يستبعد Boss والمجازين', () => {
    seedStaff('b', 'support', 'Boss');
    seedStaff('l', 'support', 'Support', { status: 'on_leave' });
    seedStaff('s', 'support', 'Support');
    seedStaff('m', 'moderation', 'Admin');
    // بلا نشاط: لا أحد مؤهل للترتيب، والجميع في قائمة «غير مصنّف» بدل ظهورهم بأرقام وهمية
    const lb = reports.leaderboard('support');
    assert.deepEqual(lb.map(r => r.staff.user_id), []);
    assert.deepEqual(lb.unranked.map(r => r.staff.user_id), ['s']);
    assert.equal(reports.leaderboard().length, 0);
    assert.equal(reports.leaderboard().unranked.length, 2);
    // بعد نشاط حقيقي يظهر في الترتيب
    for (let k = 0; k < 8; k++) getDb().prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES ('s', '1', 'staff', 0.25, ?)`).run(`2026-09-0${k + 1}`);
    const after = reports.leaderboard('support');
    assert.deepEqual(after.map(r => r.staff.user_id), ['s']);
    assert.equal(after[0].qualified, true);
    const d = reports.daily();
    assert.equal(d.total, 4);
    assert.equal(d.onLeave, 1);
  });
});

describe('راوتر المكونات', () => {
  test('يفكك customId مع المعاملات', () => {
    const r = resolveComponent('faq:ack:12');
    assert.ok(r);
    assert.deepEqual(r.args, ['12']);
    assert.ok(resolveComponent('modaction:log:ban'));
    assert.equal(resolveComponent('unknown:x'), null);
  });
});

describe('الإعدادات (/setup)', () => {
  test('تُحفظ في قاعدة البيانات وتُقرأ فوراً وتُحسب الحالة', () => {
    const settings = require('../src/services/settings');
    const setup = require('../src/commands/setup');
    let st = settings.status();
    assert.equal(st.rolesDone, 0);
    assert.equal(st.complete, false);
    settings.setRole('support', 'Helper', '111');
    settings.setRole('system', 'in vacation', 'vac-role');
    settings.setChannel('staff-faq', '222');
    settings.setActivity('ticket', ['333']);
    assert.equal(settings.roleId('support', 'Helper'), '111');
    assert.equal(settings.vacationRoleId(), 'vac-role');
    assert.equal(settings.channelId('staff-faq'), '222');
    assert.deepEqual(settings.activityChannels().ticket, ['333']);
    st = settings.status();
    assert.equal(st.rolesDone, 1);
    assert.equal(st.channelsDone, 1);
    assert.equal(st.missingChannels.length, 9);
    // الرئيسية المختصرة: خطوة تالية وقائمة أقسام بدل صفوف الأزرار
    const home = setup.homePage();
    assert.equal(home.components.length, 2);
  });
});

describe('مهام التأهيل', () => {
  test('تحتاج اكتمال المهام ثم اعتماداً بشرياً قبل النشاط', () => {
    const tasks = require('../src/services/tasks');
    const db = getDb();
    db.prepare("INSERT INTO staff_members (user_id, username, team, rank, status) VALUES ('new', 'new', 'support', 'Helper', 'probation')").run();
    tasks.ensureOnboarding('new');
    assert.equal(tasks.list('new').length, 3);
    for (const task of tasks.list('new')) assert.ok(tasks.complete(task.id, 'new'));
    assert.equal(db.prepare("SELECT status, onboarding_ready FROM staff_members WHERE user_id = 'new'").get().status, 'probation');
    assert.equal(tasks.approveOnboarding('new', 'manager').status, 'active');
    assert.equal(db.prepare("SELECT onboarding_approved_by FROM staff_members WHERE user_id = 'new'").get().onboarding_approved_by, 'manager');
  });
});

describe('استيراد سجل التكتات الخارجي', () => {
  test('يحلل رسالة البوت ويسجلها مرة واحدة فقط', () => {
    const settings = require('../src/services/settings');
    const ticketLogs = require('../src/services/ticketLogs');
    settings.setChannel('ticket-source-logs', '999');
    // البوت الخارجي مقيّد بمعرّفه: لازم نثبّته صراحةً حتى لا يتسرّب من config.json.
    settings.setTicketLogBotId('777');
    const message = {
      id: '123456789012345678',
      url: 'https://discord.com/channels/g/c/m',
      author: { bot: true, id: '777', tag: 'Ticket Bot' },
      channel: { id: '999' },
      embeds: [{ title: 'سجل التكت رقم close-2127', description: 'صاحب التكت : <@1504915482904363099>\\nمستلم التذكرة : <@1005171993940852796>\\nالي قفل التكت : <@1442619466973980735>\\nرقم التكت : #close-2127\\nجميع الرسائل : [اضغط هنا](https://example.com/close-2127.html)' }],
    };
    const parsed = ticketLogs.parseExternalTicketMessage(message);
    assert.equal(parsed.ticketId, 'close-2127');
    assert.equal(parsed.claimer, '1005171993940852796');
    assert.equal(parsed.closer, '1442619466973980735');
    const first = ticketLogs.recordTicket(parsed);
    assert.equal(first.duplicate, false);
    // لا سجل نقاط بعد: التستدعاء يسجّل القياس فقط ويمنع التكرار بمصدره.
    assert.equal(first.earned, undefined);
    // المدة تُحلل إلى دقائق ولو جاءت بصيغة ساعة:دقيقة
    assert.equal(ticketLogs.parseDuration('01:23'), 83);
    assert.equal(ticketLogs.parseDuration('00:07:30'), 8);
    assert.equal(ticketLogs.parseDuration('45 دقيقة'), 45);
    assert.equal(ticketLogs.parseDuration('2 ساعات'), 120);
    assert.equal(ticketLogs.parseDuration(''), null);
    const second = ticketLogs.recordTicket(parsed);
    assert.equal(second.duplicate, true);
    const manualFallback = ticketLogs.recordTicket({ ...parsed, source: 'manual', sourceMessageId: null });
    assert.equal(manualFallback.duplicate, true);
    assert.equal(manualFallback.manualDuplicate, true);
    assert.equal(getDb().prepare('SELECT COUNT(*) c FROM ticket_metrics').get().c, 1);
  });
});
