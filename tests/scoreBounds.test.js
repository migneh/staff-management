'use strict';
/**
 * Score لا يتجاوز ١٠٠ — إثبات البنية لا وجود مِنحدِس.
 *
 * سببوجوده: الإيجاد رقم 3 من تدقيق الاختبارات. طفرة إضافة
 * `Math.min(100, …)` إلى score.compute نجحت 400/400 — لا شيء يثبّت
 * الحدّ. لكن قبل كتابة الاختبار سُئلت: هل تجاوز ١٠٠ ممتعَض أصلاً؟
 *
 * الجواب من الشيفرة: **لا، بنيوياً.** كل نسبة تمرّ إلى factor()
 * مغلّفة بـ clamp01 (score.js:29,31,32,33,35) والأوزان صحيحة مجموعها
 * 100 (ثابت contracts)، فـ earned ≤ assessedMax دائماً. هذا يعني أن
 * المِنحدِس الإضافي يضيف حماية ميتة — والخطر الحقيقي هو من **يزيل**
 * clamp01 واحداً من ستة، فلا يبدو شيء حتى ١٠٠.
 *
 * لذلك الاختبار في جزأين:
 *   (أ) تشبع حقيقي عبر الجداول الحيّة: عضو يتجاوز كل الأهداف ⇒ Score
 *       عالٍ فعلاً (لا اختبار فارغ يمر لأن الدرجة صفر) لكن ≤ ١٠٠.
 *   (ب) مُدخلات عدائية مباشرة إلى compute(): لو زيل أي clamp01 من
 *       النسب الست، تنتفخ نسبة وتتجاوز ١٠٠ هنا — دون تحرير أي شيفرة.
 */
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
require('./sqlite-compat').install();

const { test, describe } = require('node:test');
const assert = require('node:assert');
const { openMemoryDb, getDb } = require('../src/database');
const score = require('../src/services/score');
const { today, addDays } = require('../src/utils');

openMemoryDb();

/** أيام النافذة الافتراضية (30 يوماً): 27 يوماً نشطاً تُشبع هدف 26 */
const activeDays = () => {
  const rows = [];
  for (let i = 0; i < 27; i++) rows.push(addDays(today(), -i - 1));
  return rows;
};

function seedStaff(id, team, rank, extra = {}) {
  const db = getDb();
  db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, joined_at, rank_since, last_activity, response_speed, team_interaction, supervisor_rating) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`)
    .run(id, 'u' + id, team, rank, '2026-06-01 00:00:00', '2026-06-01 00:00:00', '2026-10-01 00:00:00',
      extra.responseSpeed ?? null, extra.teamInteraction ?? null, extra.supervisorRating ?? null);
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(id);
}

/** تشبع حقيقي: رسائل + أيام نشطة + مصادر كل فريق فوق أهدافها */
function saturate(id, team) {
  const db = getDb();
  for (const day of activeDays()) {
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES (?, '1', 'staff', 0.25, ?)`).run(id, day);
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES (?, '1', 'staff', 0.25, ?)`).run(id, day);
  }
  // 27 يوم × صفين + 150 إضافية = 204 رسالة (الهدف 187.5)
  for (let k = 0; k < 150; k++) {
    db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, day) VALUES (?, '1', 'staff', 0.25, ?)`).run(id, addDays(today(), -(k % 27) - 1));
  }
  if (team === 'moderation') {
    // هدف الإجراءات 60
    for (let k = 0; k < 65; k++) {
      db.prepare(`INSERT INTO mod_actions (moderator_id, target_id, action_type, reason) VALUES (?, 'x', 'warn', 'r')`).run(id);
    }
  } else if (team === 'support') {
    // هدف التكتات 50: مغلقة خلال 5 دقائق (نسبة السرعة 1.0)
    for (let k = 0; k < 55; k++) {
      db.prepare(`INSERT INTO ticket_metrics (ticket_id, ticket_owner, claimer, closer, closed_at, duration, logged_by) VALUES (?, ?, ?, ?, ?, 5, ?)`)
        .run(id + '_t' + k, id, id, id, addDays(today(), -1), id);
    }
    // تقييم خارجي 5 نجوم (نسبة التقييم مكبوسة عند 1)
    for (let k = 0; k < 6; k++) {
      db.prepare(`INSERT INTO support_ratings (staff_id, reviewer_id, stars, rated_at, source_message_id, source_channel_id, source_guild_id, source_bot_id) VALUES (?, 'r', 5, ?, ?, '1', '1', '1')`)
        .run(id, addDays(today(), -2), id + '_r' + k);
    }
  }
}

/** مُدخلات عدائية: تفوق كل هدف بضِعف مرات — لا تُحجب إلا بالقيود */
const ADVERSARIAL = {
  messages: 1_000_000, weightedMessages: 1_000_000, activeDays: 1_000_000_000,
  tickets: 1_000_000, avgRating: 999, ratingCount: 10, avgDuration: -500,
  reopened: 0, actions: 1_000_000, warnings: 0, positiveNotes: 0,
  negativeNotes: 0, leaveDays: 0,
};

describe('حد Score الأعلى', () => {
  test('عضو مشبع عبر الجداول الحيّة: درجة عالية فعلاً لكن لا تتجاوز ١٠٠', () => {
    const cases = [
      { id: 'sb_mod', team: 'moderation', rank: 'Moderator', extra: { responseSpeed: 25 } },
      { id: 'sb_sup', team: 'support', rank: 'Support', extra: {} },
      { id: 'sb_help', team: 'support', rank: 'Helper', extra: { teamInteraction: 25, supervisorRating: 25 } },
    ];
    for (const c of cases) {
      const staff = seedStaff(c.id, c.team, c.rank, c.extra);
      saturate(c.id, c.team);
      const r = score.compute(staff);
      // التشبّع شرط — وإلا كان اختباراً فارغاً يمر لأن الدرجة 0
      assert.ok(r.score >= 95, `${c.id}: لم يتشبّع (${r.score}/100) — الاختبار لا يمسّ المسار`);
      assert.ok(r.score <= 100, `${c.id}: تجاوز Score حد ١٠٠ → ${r.score}`);
      assert.ok(r.assessedMax > 0, `${c.id}: لا مقام — تحقّق فارغ`);
    }
  });

  test('مُدخلات عدائية: أي clamp01 يُزَل فتنتفخ الدرجة فوق ١٠٠ هنا', () => {
    // الأعمدة البشرية تتجاوز 25 عمداً: المخطط لا يضع CHECK عليها
    // (database.js:26-28 تعليق فقط)، فيلزف humanRatio بلا clamp01.
    const cases = [
      { id: 'adv_mod', team: 'moderation', rank: 'Moderator', extra: { responseSpeed: 999 } },
      { id: 'adv_sup', team: 'support', rank: 'Support', extra: {} },
      { id: 'adv_help', team: 'support', rank: 'Helper', extra: { teamInteraction: 999, supervisorRating: 999 } },
    ];
    for (const c of cases) {
      const staff = seedStaff(c.id, c.team, c.rank, c.extra);
      const r = score.compute(staff, { ...ADVERSARIAL });
      assert.ok(r.assessedMax > 0, `${c.id}: لا مقام — الاختبار فارغ`);
      assert.ok(r.score <= 100, `${c.id}: مُدخلات عدائية زحفت فوق ١٠٠ → ${r.score} — أحد clamp01 الستة مفقود`);
    }
  });
});
