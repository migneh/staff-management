'use strict';
const crypto = require('crypto');
const { getDb } = require('../database');
const settings = require('./settings');
const { ACTIVITY_WEIGHTS, SPAM } = require('../constants');
const clock = require('../clock');
const points = require('./points');
const staff = require('./staff');

// ===== تصنيف القناة =====
function classifyChannel(channel) {
  if (!channel) return 'general';
  const ids = [channel.id, channel.parentId, channel.parent?.parentId].filter(Boolean);
  for (const type of ['ticket', 'staff', 'moderation']) {
    const list = settings.activityChannels()[type] || [];
    if (ids.some(id => list.includes(id))) return type;
  }
  // احتياط: قنوات التكتات عادة تبدأ بـ ticket-
  if (/^(ticket|تكت)/i.test(channel.name || '')) return 'ticket';
  return 'general';
}

// ===== فلتر السبام =====
const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\u200d|\ufe0f|<a?:\w+:\d+>|\s)+$/u;
const SYMBOLS_ONLY = /^[\p{P}\p{S}\s\d]+$/u;

/**
 * @returns {string|null} سبب الرفض أو null إن كانت الرسالة صالحة
 */
function spamReason(content) {
  const text = (content || '').trim();
  if (text.length < SPAM.minLength) return 'short';
  if (EMOJI_ONLY.test(text)) return 'emoji_only';
  if (SYMBOLS_ONLY.test(text)) return 'symbols_only';
  const compact = text.replace(/\s/g, '');
  if (compact.length && /^(.)\1+$/u.test(compact)) return 'repeated_char';
  const uniq = new Set(compact).size;
  if (compact.length >= 8 && uniq <= 2) return 'repeated_char';
  return null;
}

function hash(content) {
  return crypto.createHash('sha1').update(content.trim().toLowerCase()).digest('hex');
}

/**
 * هل تتبّع النشاط مفعّلاً؟ مفتاح `activityTracking` في services/settings.
 * كان يُعرض في /config ويُكتب بلا قارئ — مفتاح يَعِد المشغّل بإيقاف مهمة
 * لا تتوقف. الآن هو البوابة الوحيدة لكتابة activity_logs.
 */
function isTrackingEnabled() {
  return settings.featureToggle('activityTracking') !== false;
}

/**
 * تسجيل رسالة كنشاط. يعيد {counted:boolean, reason?:string, type:string|null}
 *
 * البوابة على الكتابة لا على القراءة: إيقاف التتبّع يوقف صفوفاً جديدة فقط،
 * وما سُجّل سابقاً يبقى يُقرأ. ما يتأثر بالإيقاف — ولا بدّ من ذكره صراحة:
 *   • Score: عوامل «الرسائل» و«التواصل»/«النشاط»/«الالتزام»
 *     (src/services/score.js:51) تقرأ activity_logs، فالنوافذ الجديدة تُحسب
 *     على نشاط ناقص؛ والنوافذ المنتهية قبل الإيقاف تبقى صحيحة.
 *   • بوابات الترقية: `minMessages` و`activeDays` (src/services/promotions.js:148,177).
 *   • كشف الغياب بعد الإجازة (src/scheduler.js:154) و«سلسلة الأسابيع النشطة»
 *     في التقارير (src/services/reports.js:42).
 *   • /activity و/my-status (stats) وتقارير retention وحجم القاعدة في /system-status.
 * أي إيقاف مطوّل يعني أرقاماً ناقصة في كل ما سبق — لهذا يُعرض التنبيه في
 * /my-record على العضو نفسه لا في سجل الخادم وحده.
 */
function record(userId, channel, content) {
  if (!isTrackingEnabled()) return { counted: false, reason: 'tracking_disabled', type: null };
  const type = classifyChannel(channel);
  const reason = spamReason(content);
  if (reason) return { counted: false, reason, type };

  const db = getDb();
  const h = hash(content);
  const dup = db.prepare(`SELECT 1 FROM activity_logs WHERE user_id = ? AND content_hash = ?
    AND created_at >= datetime('now', ?) LIMIT 1`).get(userId, h, `-${Math.floor(SPAM.duplicateWindowMs / 1000)} seconds`);
  if (dup) return { counted: false, reason: 'duplicate', type };

  const day = clock.today();
  if (type === 'general') {
    const { c } = db.prepare(`SELECT COUNT(*) c FROM activity_logs WHERE user_id = ? AND day = ? AND channel_type = 'general'`).get(userId, day);
    if (c >= SPAM.maxGeneralPerDay) return { counted: false, reason: 'daily_cap', type };
  }

  db.prepare(`INSERT INTO activity_logs (user_id, channel_id, channel_type, weight, content_hash, day) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(userId, channel?.id || '0', type, ACTIVITY_WEIGHTS[type], h, day);

  // منح نقاط chat_help لقنوات العمل (ليس general) — والموقوف لا يكسب (قرار
  // المالك D12): يبقى نشاطه مُسجَّلاً للأرقام، لكن العطف التراكمي يتوقف حتى
  // تُرفع الإيقاف، بتماسكٍ مع استثناء نفس الحالة من التقارير واللوحات.
  let earned = 0;
  if (type !== 'general') {
    const staffRow = staff.get(String(userId));
    if (staffRow && staffRow.status !== 'suspended') {
      const r = points.add({ userId, reasonKey: 'chat_help', refType: 'chat', refId: h, addedBy: 'auto' });
      if (r.ok) earned += r.points;
    }
  }

  return { counted: true, type, earned };
}

/**
 * إحصائيات نشاط خلال نافذة **أيام تقويمية** (بالأيام) — آخر `days` يوم منطقي.
 *
 * النافذة على عمود `day` المفهرس مع `user_id` (idx_activity_user_day)، لا على
 * `created_at`. السبب في clock.dayWindow: `day` تاريخ مجرّد (YYYY-MM-DD) مخزَّن
 * بتوقيت السيرفر عبر clock.today، فمقارنته نصّيةً على فهرس B-tree حدٌّ صالح —
 * بخلاف `created_at >= datetime('now', ?)` الذي لا يستطيع الفهرس أن يتقدّمه
 * معرّف المستخدم، فكان SQLite يقرأ **كل** الصفوف المحفوظة لذلك العضو ويدفعها
 * عبر شجرة B-tree مؤقتة للتجميع: 236 مللي ثانية و146 ألف صف ليعطي جواب 6 آلاف.
 *
 * الحدّان `>=` و`<=` على عمود تاريخ مجرّد: `day` لا يحمل جزءاً زمنياً فلا فخّ
 * 23:59:59 هنا أصلاً (عكس أعمدة created_at في clock.dayWindow)، ويبقى آخر يوم
 * مشمولاً بالكامل. وهذا هو نفسه تعريف النافذة في services/score.js
 * monthlyRaw — فالتقارير كلها تجيب عن الفترة نفسها.
 */
function stats(userId, days = 30) {
  const db = getDb();
  const windowDays = Math.max(1, Number(days) || 30);
  const end = clock.today();
  const start = clock.addDays(end, -(windowDays - 1));
  const rows = db.prepare(`SELECT channel_type, COUNT(*) c, SUM(weight) w FROM activity_logs
    WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY channel_type`).all(userId, start, end);
  const { d } = db.prepare('SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND day >= ? AND day <= ?')
    .get(userId, start, end);
  const byType = {};
  let messages = 0, weighted = 0;
  for (const r of rows) { byType[r.channel_type] = r.c; messages += r.c; weighted += r.w; }
  return { messages, weighted: Math.round(weighted * 100) / 100, activeDays: d, byType };
}

function activeDaysInMonth(userId, yyyymm) {
  const { d } = getDb().prepare(`SELECT COUNT(DISTINCT day) d FROM activity_logs WHERE user_id = ? AND day LIKE ?`).get(userId, `${yyyymm}%`);
  return d;
}

module.exports = { classifyChannel, spamReason, record, stats, activeDaysInMonth, isTrackingEnabled };
