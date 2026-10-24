'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, POINTS_THRESHOLDS } = require('../constants');
const settings = require('../services/settings');
const points = require('../services/points');
const { POINTS_TRANSITION_DAYS, effectivePointsThreshold } = require('../services/promotions');
const staffService = require('../services/staff');
const clock = require('../clock');
const { COLORS, replyEphemeral, arDigits, truncate } = require('../utils');
const kit = require('../ui/kit');
const { tsRelative } = require('../ui/kit');

/**
 * /my-points — سجل النقاط الشخصي (قرار المالك D3).
 *
 * النظام نقاطي، فالسؤال «رصيدي من كم؟» ليس ترفاً بل عدالة: كل صف في دفتر
 * promotion_points يحمل سببه، والعضو يستحق قراءة ما يُحاسَب عليه. السطح
 * يعرض الرصيد في العصر الحالي وحالة التجميد وآخر الحركات بأحدثها — لا
 * تحرير ولا تصفية؛ ما هو في الدفتر هو ما يظهر، والعناوين القديمة من عصر
 * رتبة سابق تُعلَّم صريحاً بدل أن تُخفى.
 */

/** تحصيل الحركة إلى سطر — دالّة نقية كي يتحقق على العقد بلا ديسكورد. */
function ledgerLine(row, currentEpoch) {
  const sign = row.points > 0 ? '🟢' : '🔴';
  const old = row.rank_epoch !== currentEpoch ? ' (عصر سابق)' : '';
  const amount = `**${arDigits(row.points)}** نقطة`;
  return `${sign} ${amount} — ${row.reason}${old} • ${tsRelative(row.created_at)}`;
}

/** بطاقة السجل كاملة — نقية، يُختبر عليها العقد.
 *
 * `progress` اختياري (يبقى العقد القديم سليماً بلا وسيط): يحمل عتبة الرتبة
 * القادمة ووتيرة الأسبوع — محسوبَين عند المتصل لأن الحساب يحتاج قاعدة
 * البيانات والسياسة، بينما البطاقة تعرض فقط. غير موجود = الرتبة بلا عتبة
 * (تعيين يدوي) فلا حقل «إلى العتبة» أصلاً.
 */
function renderLedger({ member, rows, balance, freeze, progress }) {
  const lines = rows.map(r => ledgerLine(r, member.rank_epoch ?? 0));
  const history = lines.length
    ? truncate(lines.join('\n'), 900)
    : 'لا حركات بعد — النشاط في قنوات العمل يبدأ الدفتر.';
  const frozen = freeze.frozen;
  const fields = [
    { name: '💯 الرصيد (هذا العصر)', value: `**${arDigits(balance)}** نقطة`, inline: true },
    { name: '❄️ التجميد', value: frozen
      ? `مجمَّد حتى ${freeze.until}\nالسبب: ${freeze.reason}`
      : 'لا تجميد', inline: true },
  ];
  if (progress) {
    const parts = [];
    parts.push(`عتبة اليوم: **${arDigits(progress.threshold)}**${progress.transitional ? ` (انتقالية — الكاملة ${arDigits(progress.base)} بعد ${arDigits(progress.daysLeft)} يوم)` : ''}`);
    if (progress.remaining > 0) {
      parts.push(`نقصك: **${arDigits(progress.remaining)}** نقطة`);
      if (progress.weeks != null && progress.frozen !== true) {
        parts.push(`وتيرتك آخر 4 أسابيع ~${arDigits(progress.perWeek)}/أسبوع → تقدير ~${arDigits(progress.weeks)} أسبوع`);
      } else if (progress.frozen === true) {
        parts.push('وتيرة الحساب متوقفة أثناء التجميد');
      } else if (progress.past === 0) {
        parts.push('لا حركات في آخر 4 أسابيع — الوتيرة تُبنى من نشاطك القادم');
      }
    } else {
      parts.push('✅ بلغت العتبة — عدّلت شروط الترقية الباقية تنقلك');
    }
    fields.push({ name: '🎯 إلى عتبة الترقية', value: parts.join('\n'), inline: false });
  }
  fields.push({ name: '📜 آخر الحركات', value: history, inline: false });
  return kit.card({
    title: `🧾 سجل نقاطك — <@${member.user_id}>`,
    description: `${member.rank} • العصر الحالي: ${member.rank_epoch ?? 0}`,
    fields,
    color: frozen ? COLORS.warning : COLORS.info,
    footer: kit.footerLine('آخر 15 حركة • سقوف: تكتات 20/يوم و60/أسبوع • شات 5/يوم • تغطية 2/يوم • السجل يحكم لا الذاكرة'),
  });
}

module.exports = {
  renderLedger,
  commands: [
    {
      data: new SlashCommandBuilder()
        .setName('my-points')
        .setDescription('سجل نقاطك: رصيدك هذا العصر، التجميد، وآخر الحركات بسببنها'),
      level: LEVELS.STAFF,
      async execute(i) {
        if (!settings.featureToggle('myPointsCommand')) {
          return replyEphemeral(i, '❌ هذا الأمر معطّل حالياً.', COLORS.danger);
        }
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, 'لست مسجلاً في سجل الإداريين بعد — لا نقاط تُعرض.', COLORS.warning);

        const userPoints = points.getBalance(userId);
        const freezeState = points.isFrozen(userId);

        // إلى العتبة: إن كانت لرتبته عتبة نُبني بند التقدم — الوتيرة من آخر
        // 4 أسابيع داخل العصر الحالي (تقدير لا وعد: وعدٌ «بتاريخ» يكذب).
        const base = POINTS_THRESHOLDS[member.team]?.[member.rank];
        let progress = null;
        if (base != null) {
          const eff = effectivePointsThreshold(base, clock.today());
          const remaining = Math.max(0, eff.threshold - userPoints);
          const past = points.sumInWindow(userId, 28);
          const perWeek = Math.round(Math.max(past, 0) / 4);
          progress = {
            base,
            threshold: eff.threshold,
            transitional: eff.transitional,
            daysLeft: eff.transitional ? POINTS_TRANSITION_DAYS - eff.day : 0,
            remaining,
            past,
            perWeek,
            weeks: perWeek > 0 && remaining > 0 ? Math.ceil(remaining / perWeek) : null,
            frozen: freezeState.frozen,
          };
        }

        const card = renderLedger({
          member,
          rows: points.history(userId, 15),
          balance: userPoints,
          freeze: freezeState,
          progress,
        });
        return replyEphemeral(i, card);
      },
    },
  ],
};
