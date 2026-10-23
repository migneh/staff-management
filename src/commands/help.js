'use strict';
const forms = require('../ui/forms');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const { accessContext } = require('../services/commandAccess');
const { helpPayload, quickRow, runQuickAction } = require('../ui/navigation');

/** كل نماذج الأمر معرّفة هنا: الاسم في Label، والصيغة في الشرح. */
const modals = {
  search: () => ({
    id: 'help:searchmodal',
    title: '🔍 بحث عن أمر',
    fields: [forms.field({
      id: 'query', label: 'ما الذي تريد فعله؟', min: 2, max: 80,
      description: 'اكتب كلمة من اسم الأمر أو وصفه: إجازة، مهام، ترقية.',
      placeholder: 'مثال: إجازة، مهام، ترقية',
    })],
    note: 'البحث يعرض الأوامر المتاحة لك فقط حسب رتبتك وفريقك.',
  }),
};
const { tsRelative } = require('../ui/kit');
const staffService = require('../services/staff');
const reports = require('../services/reports');
const promo = require('../services/promotions');
const points = require('../services/points');
const faq = require('../services/faq');
const taskService = require('../services/tasks');
const { getDb } = require('../database');
const { userEmbed, COLORS, progressBar, hoursSince, replyEphemeral } = require('../utils');

/**
 * رمز كل حالة في constants.STATUS — مصدر واحد لكل ما يرسم حالة عضو.
 * كان `/me` يحمل خريطة داخلية ناقصة `removed`، فكان عنوان اللوحة يطبع
 * «undefined لوحتي الشخصية». الخريطة هنا مشتقّة من مفاتيح STATUS نفسها،
 * وأي حالة جديدة بلا رمز تسقط إلى ▫️ بدل undefined.
 * القيم نفسها موحّدة مع CHIP في src/ui/kit.js.
 */
const STATUS_GLYPHS = {
  active: '🟢',
  inactive: '🟠',
  on_leave: '🏖️',
  probation: '🧪',
  suspended: '⛔',
  resigned: '⚫',
  removed: '🚪',
};

/**
 * خريطة الرموز المدمجة: كل مفتاح في constants.STATUS مربوط برمز، وأي مفتاح
 * بلا رمز تسقط إلى ▫️. تُبنى مرة واحدة وتُصدَّر للاختبار التعاقدي.
 */
const RESOLVED_STATUS_GLYPHS = {
  ...Object.fromEntries(Object.keys(STATUS).map(key => [key, '▫️'])),
  ...STATUS_GLYPHS,
};

/** رمز الحالة — لا يعيد undefined أبداً، حتى لو ظهرت حالة جديدة في قاعدة البيانات. */
function statusGlyph(status) {
  return RESOLVED_STATUS_GLYPHS[status] || '▫️';
}

function dashboard(i) {
  const s = staffService.get(i.user.id);
  const totalPoints = points.getBalance(i.user.id);
  const frozen = points.isFrozen(i.user.id).frozen;
  const ev = promo.evaluate(s);
  const unread = faq.unreadFor(i.user.id).length;
  const db = getDb();
  const pendingLeave = db.prepare(`SELECT id FROM leave_requests WHERE user_id = ? AND status = 'pending'`).get(i.user.id);
  const pendingPromo = promo.pendingRequest(i.user.id);
  const pendingTasks = taskService.pendingCount(i.user.id);
  const h = hoursSince(s.last_activity);
  const blocker = ev.checks.find(c => !c.pass);

  const statusIcon = statusGlyph(s.status);
  const alerts = [];
  if (pendingTasks) alerts.push(`📋 **${pendingTasks}** مهمة معلّقة — افتح «مهامي» للمتابعة.`);
  if (unread) alerts.push(`📌 **${unread}** تعليمات مهمة بانتظار القراءة.`);
  if (h > 48 && s.status !== 'on_leave') alerts.push(`⏰ آخر نشاط ${tsRelative(s.last_activity)} — سجّل حضورك بالعمل المعتاد.`);
  if (ev.eligible && !pendingPromo) alerts.push('🎉 أنت مؤهل للترقية! اختر «طلب ترقية» من قائمة الإجراءات.');

  const currentRank = s.rank;
  const e = userEmbed(i.member, `${statusIcon} لوحتي الشخصية`,
    `**${s.rank}** • ${TEAMS[s.team]} • **${STATUS[s.status]}**\nبالرتبة ${tsRelative(s.rank_since)}`, COLORS.primary);
  e.addFields(
    { name: '🎯 ابدأ بهذه الخطوة', value: alerts[0] || (blocker ? `للاقتراب من الترقية: **${blocker.label}** — الحالي ${blocker.actual} / المطلوب ${blocker.required}.` : '✅ لا توجد إجراءات عاجلة. يمكنك مراجعة أدائك أو تصفح المعرفة.') },
    { name: `💯 نقاط الترقية`, value: `**${totalPoints} pts** — ${currentRank}\n${progressBar(Math.min(totalPoints, 1500), 1500, 10)}`, inline: true },
    { name: '📅 النشاط', value: `**الرتبة الحالية:** ${currentRank}${frozen ? ' ❄️' : ''}`, inline: true },
  );
  if (ev.rule) {
    const passed = ev.checks.filter(c => c.pass).length;
    e.addFields({ name: `📈 الترقية القادمة: ${ev.rule.to}`, value: `${progressBar(passed, ev.checks.length, 10)} **${passed}/${ev.checks.length}** شرط مكتمل.\n${blocker ? `المتبقي أولاً: **${blocker.label}** — ${blocker.actual} / ${blocker.required}.` : '✅ الشروط مكتملة.'}` });
  }
  const waiting = [];
  if (pendingLeave) waiting.push(`🏖️ إجازة #${pendingLeave.id} — بانتظار مراجعة الإدارة، لا يلزم طلب جديد.`);
  if (pendingPromo) waiting.push(`📈 ترقية #${pendingPromo.id} — بانتظار مراجعة الإدارة.`);
  if (alerts.length > 1) e.addFields({ name: '📌 تذكيرات أخرى', value: alerts.slice(1).join('\n') });
  if (waiting.length) e.addFields({ name: '⏳ قيد المتابعة', value: waiting.join('\n') });
  e.setFooter({ text: 'لوحة خاصة بك • التفاصيل في قائمة الإجراءات • استخدم تحديث لعرض آخر حالة' });

const context = accessContext(i);
   const quick = quickRow(['my-ratings', 'my-performance', 'my-record', 'promotion-status', 'request-promotion', 'request-leave', 'my-leaves', 'leave-balance', 'my-resignations'], context, 'تقاريري وطلباتي…');
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('nav:run:my-tasks').setLabel(pendingTasks ? `مهامي (${pendingTasks})` : 'مهامي').setEmoji('📋').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('faq:unread').setLabel(unread ? `للقراءة (${unread})` : 'غير المقروءة').setEmoji('📚').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('me:home').setLabel('تحديث').setEmoji('🔄').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help:open').setLabel('كل الأقسام').setEmoji('🧭').setStyle(ButtonStyle.Secondary),
  );
  return { embeds: [e], components: [...(quick ? [quick] : []), row] };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('help').setDescription('❓ دليل استخدام البوت'),
      level: LEVELS.STAFF,
      async execute(i) { return i.reply({ ...helpPayload(i), ephemeral: true }); },
    },
    {
      data: new SlashCommandBuilder().setName('me').setDescription('🏠 لوحتك الشخصية: الحالة، النقاط، الترقية، المهام'),
      level: LEVELS.STAFF,
      async execute(i) {
        if (!i.staffInfo) return replyEphemeral(i, 'ℹ️ لا توجد لك بطاقة إداري لأنك تستخدم صلاحية Server Manager فقط.', COLORS.info);
        return i.reply({ ...dashboard(i), ephemeral: true });
      },
    },
  ],
  modals,
  statusGlyph,
  RESOLVED_STATUS_GLYPHS,
  components: {
    'help:section': async (i) => i.update(helpPayload(i, i.values[0])),
    'help:page': async (i, [section, page]) => i.update(helpPayload(i, section, page)),
    'help:open': async (i) => i.update(helpPayload(i)),
    'help:search': async (i) => forms.open(i, modals.search()),
    'help:searchmodal': async (i) => i.update(helpPayload(i, 'start', 0, i.fields.getTextInputValue('query'))),
    'me:home': async (i) => {
      if (!i.staffInfo) return i.update(helpPayload(i));
      return i.update(dashboard(i));
    },
    'nav:configure': async (i) => require('./wizard').start(i, i.values[0]),
    'nav:action': async (i) => runQuickAction(i, i.values[0]),
    'nav:run': async (i, [name]) => runQuickAction(i, name),
    'nav:choice': async (i, [name]) => runQuickAction(i, name, i.values[0]),
    // توافق مع الأزرار المنشورة قبل تحديث الواجهة.
    'me:perf': async (i) => runQuickAction(i, 'my-performance'),
    'me:record': async (i) => runQuickAction(i, 'my-record'),
    'me:promo': async (i) => runQuickAction(i, 'promotion-status'),
  },
};
