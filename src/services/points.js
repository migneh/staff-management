'use strict';
const { getDb } = require('../database');
const clock = require('../clock');
const { INACTIVE_STATUSES } = require('../constants');

/**
 * نظام نقاط الترقيات — دفتر حركة لا رصيدٌ يُعدَّل.
 *
 * القاعدة الحاكمة: الرصيد ليس رقماً يُخزَّن، بل مجموع صفوف `promotion_points`.
 * كل منح أو خصم صفٌ يحمل سببه ومصدره، فأي سؤال من نوع «لماذا صار رصيدي كذا؟»
 * أو «هل أُضيفت لي هذه التكتة مرتين؟» يُجاب عنه من الجدول لا من الذاكرة.
 * ثمن ذلك أن القراءة استعلامٌ لا قراءة عمود — مقبول لأن الجدول مفهرس على
 * (user_id, rank_epoch) وهو ما تجري عليه كل استعلامات الرصيد.
 *
 * `rank_epoch` هو ما يجعل «الترقية تصفّر النقاط» ممكناً بلا حذف سجلات: العصر
 * يتغيّر عند الترقية، والرصيد يُحسب على صفوف العصر الحالي فقط. الصفوف القديمة
 * تبقى — فهي سجل الفترة السابقة، وحذفها يُفقد «كم كان رصيده قبل الترقية».
 *
 * قيم النقاط ثابتة في الكود (POINTS_DEFAULTS): آلية الضبط عبر policy
 * أُزيلت بقرار المالك (ورقة قرارات D4، 2026-10-24) — القرّاء كانت فضاءً ميتاً:
 * مكشوفة في القراءة بلا كاتبٍ ولا حدود، فيبدو نظاماً قابلاً للضبط ولا يمكن
 * ضبطه فعلاً. لا يُستعاد المسار إلا عبر واجهة إدارة موثّقة بحدود رقمية لكل سبب.
 */

/** قيم كل سبب — ثابتة هنا؛ قرار المالك D4: لا تجاوزات بلا واجهة إدارة موثّقة */
const POINTS_DEFAULTS = {
  // ===== الدعم الفني =====
  ticket_close: 2,          // تكتة مغلقة بنجاح
  ticket_escalated: 4,      // تكتة مُصعَّدة حُلَّت (أصعب من العادية)
  rating_positive: 2,       // تقييم عميل 4-5 نجوم
  rating_negative: -2,      // تقييم عميل 1-2 نجوم
  chat_help: 1,             // مساعدة في قناة الشات
  daily_active: 1,          // يوم حضور فعّال
  shift_cover: 3,           // تغطية شفت زميل
  faq_contrib: 5,           // إضافة/تحديث قاعدة المعرفة

  // ===== الإشراف =====
  mod_action: 2,            // معالجة مخالفة
  report_resolve: 3,        // حل بلاغ
  bug_found: 5,             // الإبلاغ عن ثغرة

  // ===== المكافآت =====
  star_week: 10,            // نجم الأسبوع
  best_month: 50,           // الأفضل في الشهر

  // ===== العقوبات =====
  absence_10d: -50,         // غياب 10 أيام بلا إجازة
};

/**
 * سقوف يومية: سببٌ واحد لا يمنح أكثر من هذا في اليوم.
 *
 * لماذا سقف على الشات وحده: الشات هو السبب الوحيد القابل للتكرار الآلي —
 * رسالةٌ كل بضع ثوانٍ. أما التذكرة والتقييم والإجراء فلكل منها مرجع فريد
 * يمنع التكرار بنفسه (انظر idx_points_unique_ref)، فسقفها اليومي زائد.
 */
const DAILY_CAPS_DEFAULTS = {
  chat_help: 5,
};

// Manual ticket logging is self-service; these fixed limits cannot be raised
// through policy settings. They cap total positive ticket points per member.
const TICKET_POINTS_DAILY_CAP = 20;
const TICKET_POINTS_WEEKLY_CAP = 60;
const TICKET_REASON_KEYS = ['ticket_close', 'ticket_escalated', 'rating_positive'];

/** يقرأ قيمة سبب واحد من المدوّنات فقط — لا تجاوزات إعدادات (قرار المالك D4). */
function pointsFor(reasonKey) {
  const n = Number(POINTS_DEFAULTS[reasonKey]);
  return Number.isFinite(n) ? n : 0;
}

/** سقف اليوم لسبب واحد (0 = بلا سقف) — ثابت من المدوّنات (قرار المالك D4). */
function dailyCapFor(reasonKey) {
  const n = Number(DAILY_CAPS_DEFAULTS[reasonKey]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * رصيد العضو في عصره الحالي.
 *
 * العصر يُقرأ من staff_members لا يُمرَّر: تمريره من المتصل يجعل كل متصل
 * يحمل رأياً في «أي عصر»، وأول اختلاف بين متصلين ينتج رصيدين مختلفين لنفس
 * العضو في نفس اللحظة. المصدر واحد هنا.
 */
function getBalance(userId) {
  const db = getDb();
  const row = db.prepare(`SELECT rank_epoch FROM staff_members WHERE user_id = ?`).get(userId);
  if (!row) return 0;
  const sum = db.prepare(`SELECT COALESCE(SUM(points), 0) total FROM promotion_points WHERE user_id = ? AND rank_epoch = ?`)
    .get(userId, row.rank_epoch ?? 0).total;
  return Number(sum) || 0;
}

/**
 * هل العضو مجمَّد الآن؟ التجميد يُوقف تراكم النقاط، ولا يمسّ الرصيد القائم.
 *
 * المقارنة على الطابع الخام (UTC) لا على تاريخ اليوم: `until` كُتب
 * datetime('now') فهي طابع UTC، ومقارنتها بـ clock.today() (تاريخ بتوقيت TZ)
 * تخلط بين ساعتين مختلفين — وهي بالضبط القاعدة التي يوثّقها clock.js.
 */
function isFrozen(userId) {
  const row = getDb().prepare(`SELECT until, reason FROM point_freezes WHERE user_id = ?`).get(userId);
  if (!row) return { frozen: false };
  const expired = String(row.until) <= clock.nowIso();
  if (expired) return { frozen: false, expired: true };
  return { frozen: true, until: row.until, reason: row.reason };
}

/**
 * كم مُنح من هذا السبب اليوم — أساس السقف اليومي.
 *
 * النافذة من clock.dayWindow لا من مقارنة خام: `day` تاريخ بتوقيت TZ والطابع
 * المخزَّن UTC، فالبحث عن «يوم واحد» يحتاج حدَّي البدء والنهاية الصريحين.
 */
function awardedToday(userId, reasonKey) {
  const { start, endExclusive } = clock.dayWindow(clock.today(), clock.today()) || {};
  if (!start) return 0;
  const row = getDb().prepare(`SELECT COALESCE(SUM(points), 0) total FROM promotion_points
    WHERE user_id = ? AND reason_key = ? AND created_at >= ? AND created_at < ?`)
    .get(userId, reasonKey, start, endExclusive);
  return Number(row.total) || 0;
}

function ticketPointsAwarded(userId, start, endExclusive) {
  // الأقواس حرفيّة بعدد TICKET_REASON_KEYS (٣) حتى يفحص حارس المخطط الجملة
  // ساكنةً بلا ثقب غير قابل للحسم. إن نما القائمة دون تحديث الجملة، يرمي
  // ربط المعاملات فوراً على أول استدعاء — غلطة صاخبة لا انحراف صامت.
  const row = getDb().prepare(`SELECT COALESCE(SUM(points), 0) total FROM promotion_points
    WHERE user_id = ? AND reason_key IN (?, ?, ?) AND points > 0
      AND created_at >= ? AND created_at < ?`)
    .get(userId, ...TICKET_REASON_KEYS, start, endExclusive);
  return Number(row.total) || 0;
}

/**
 * منح أو خصم نقاط.
 *
 * @param {object} args
 * @param {string} args.userId العضو
 * @param {string} args.reasonKey مفتاح السبب من POINTS_DEFAULTS
 * @param {string} [args.reason] نص يظهر في السجل — يُشتق من المفتاح إن غاب
 * @param {string} [args.refType] نوع المرجع (ticket / rating / week / …)
 * @param {string} [args.refId] معرّف المرجع — وجوده يفعّل الحماية من التكرار
 * @param {string} [args.addedBy] من سجّل العملية (بوت أو إداري)
 * @returns {{ok:boolean, reason?:string, points?:number, balance?:number}}
 *
 * ثلاث حالات فشل صريحة لا تُبلع: مجمَّد، تجاوز السقف اليومي، مرجع مكرَّر.
 * كلها تعيد سبباً مقروءاً لأن المتصل يعرضه للإداري — والفرق بين «لم تُمنح
 * لأنك مجمَّد» و«لم تُمنح لسبب مجهول» هو الفرق بين نظام يُتصدَّق له وآخر لا.
 */
function add({ userId, reasonKey, reason = null, refType = null, refId = null, addedBy = null }) {
  if (!userId || !reasonKey) return { ok: false, reason: 'بيانات ناقصة' };

  const frozen = isFrozen(userId);
  if (frozen.frozen) return { ok: false, reason: 'مجمَّد', until: frozen.until, freezeReason: frozen.reason };

  const value = pointsFor(reasonKey);
  if (!value) return { ok: false, reason: `سبب غير معروف: ${reasonKey}` };

  // The ticket cap is hard policy (not settings-controlled), covering all
  // ticket-related positive awards together across ticket identifiers.
  if (value > 0 && TICKET_REASON_KEYS.includes(reasonKey)) {
    const today = clock.today();
    const day = clock.dayWindow(today, today);
    const week = clock.dayWindow(clock.addDays(today, -6), today);
    const daily = day && ticketPointsAwarded(userId, day.start, day.endExclusive);
    const weekly = week && ticketPointsAwarded(userId, week.start, week.endExclusive);
    if (daily + value > TICKET_POINTS_DAILY_CAP) return { ok: false, reason: 'سقف يومي للتكتات', cap: TICKET_POINTS_DAILY_CAP };
    if (weekly + value > TICKET_POINTS_WEEKLY_CAP) return { ok: false, reason: 'سقف أسبوعي للتكتات', cap: TICKET_POINTS_WEEKLY_CAP };
  }

  // السقف على المقدار الممنوح لا على الرصيد: خصمٌ لا يُحرك عدّاد السقف.
  if (value > 0) {
    const cap = dailyCapFor(reasonKey);
    if (cap && awardedToday(userId, reasonKey) >= cap) {
      return { ok: false, reason: 'سقف يومي', cap };
    }
  }

  const db = getDb();
  const epochRow = db.prepare(`SELECT rank_epoch FROM staff_members WHERE user_id = ?`).get(userId);
  if (!epochRow) return { ok: false, reason: 'غير مسجل كإداري' };

  try {
    db.prepare(`INSERT INTO promotion_points (user_id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(userId, value, reasonKey, reason || reasonKey, refType, refId, addedBy, epochRow.rank_epoch ?? 0);
  } catch (e) {
    // الفهرس الفريد (reason_key, ref_type, ref_id) هو الحماية من المنح المزدوج:
    // نفس التكتة أو نفس التقييم لا يُمنح مرتين ولو أُعيد تشغيل الوصف أو الرسالة.
    if (String(e.message).includes('UNIQUE')) return { ok: false, reason: 'مكرَّر', duplicate: true };
    throw e;
  }

  return { ok: true, points: value, balance: getBalance(userId) };
}

/** سجل حركة العضو — الأحدث أولاً. */
function history(userId, limit = 20) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  return getDb().prepare(`SELECT id, points, reason_key, reason, ref_type, ref_id, added_by, rank_epoch, created_at
    FROM promotion_points WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, safeLimit);
}

/**
 * طابع انتهاء التجميد بنفس تنسيق بقية أعمدة الطابع (UTC، 19 محرفاً، بفاصل مسافة).
 *
 * لماذا لا clock.addDays مباشرة: addDays يعيد تاريخاً (YYYY-MM-DD) لا طابعاً،
 * وهو الصحيح لمنطق الإجازات الذي يقارن أياماً. لكن `until` هنا يُقارن بـ
 * clock.nowIso() نصياً، فتاريخ مجرّد بطول 10 محرف أمام طابع بطول 19 يجعل
 * المقارنة تنتهي عند منتصف ليل يومه — تجميد سبعة أيام ينتهي فجراً بدل أن
 * يُكمل مدته. parseStamp هو محوّل المشروع نفسه (يقبل الفاصلين)، فالحساب يجري
 * عليه ثم يُعاد الطابع بنفس صيغة nowIso لا بصيغة toISOString.
 */
function freezeStamp(days) {
  const end = clock.parseStamp(clock.nowIso());
  end.setUTCDate(end.getUTCDate() + Math.trunc(days));
  return end.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * تجميد العضو لأيام.
 * صف واحد لكل عضو (user_id أساسي): التجميد الجديد يلغي القديم بدل أن يتراكما،
 * فتاريخ الانتهاء واحد ومعروف — وتراكب صفوف يجعل «هل هو مجمَّد؟» سؤالاً بلا
 * جواب واحد.
 */
function freeze(userId, days, reason) {
  const until = freezeStamp(Number(days) || 7);
  getDb().prepare(`INSERT INTO point_freezes (user_id, until, reason) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at`)
    .run(userId, until, reason || 'تجميد');
  return { until, reason };
}

/** رفع التجميد فوراً. */
function unfreeze(userId) {
  return getDb().prepare(`DELETE FROM point_freezes WHERE user_id = ?`).run(userId).changes > 0;
}

/**
 * ترتيب الفريق بالنقاط في العصر الحالي.
 * المجمَّدون يظهرون بعلامة: ترتيبٌ يخفي عقوبةً يبدو كأنها لم تُطبَّق.
 */
function leaderboard({ team = null, limit = 20 } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const db = getDb();
  const rows = db.prepare(`
    SELECT p.user_id, SUM(p.points) total, m.team, m.rank, m.status,
           (SELECT COUNT(*) FROM point_freezes f WHERE f.user_id = p.user_id AND f.until > ?) frozen
    FROM promotion_points p JOIN staff_members m ON m.user_id = p.user_id
    WHERE m.rank_epoch = p.rank_epoch
      AND m.status NOT IN (${INACTIVE_STATUSES.map(() => '?').join(', ')}) ${team ? 'AND m.team = ?' : ''}
    GROUP BY p.user_id, p.rank_epoch
    ORDER BY total DESC LIMIT ?`)
    .all(clock.nowIso(), ...INACTIVE_STATUSES, ...(team ? [team] : []), safeLimit);
  return rows.map(r => ({ ...r, frozen: Number(r.frozen) > 0 }));
}

module.exports = {
  POINTS_DEFAULTS, DAILY_CAPS_DEFAULTS,
  pointsFor, dailyCapFor, getBalance, isFrozen, add, history, freeze, unfreeze, leaderboard, awardedToday,
};
