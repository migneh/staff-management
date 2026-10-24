'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const settings = require('../services/settings');
const points = require('../services/points');
const staffService = require('../services/staff');
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

/** بطاقة السجل كاملة — نقية، يُختبر عليها العقد. */
function renderLedger({ member, rows, balance, freeze }) {
  const lines = rows.map(r => ledgerLine(r, member.rank_epoch ?? 0));
  const history = lines.length
    ? truncate(lines.join('\n'), 900)
    : 'لا حركات بعد — النشاط في قنوات العمل يبدأ الدفتر.';
  const frozen = freeze.frozen;
  return kit.card({
    title: `🧾 سجل نقاطك — <@${member.user_id}>`,
    description: `${member.rank} • العصر الحالي: ${member.rank_epoch ?? 0}`,
    fields: [
      { name: '💯 الرصيد (هذا العصر)', value: `**${arDigits(balance)}** نقطة`, inline: true },
      { name: '❄️ التجميد', value: frozen
        ? `مجمَّد حتى ${freeze.until}\nالسبب: ${freeze.reason}`
        : 'لا تجميد', inline: true },
      { name: '📜 آخر الحركات', value: history, inline: false },
    ],
    color: frozen ? COLORS.warning : COLORS.info,
    footer: kit.footerLine('آخر 15 حركة من الدفتر • السجل يحكم لا الذاكرة'),
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

        const card = renderLedger({
          member,
          rows: points.history(userId, 15),
          balance: points.getBalance(userId),
          freeze: points.isFrozen(userId),
        });
        return replyEphemeral(i, card);
      },
    },
  ],
};
