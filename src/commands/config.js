'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const settings = require('../services/settings');
const { COLORS, replyEphemeral } = require('../utils');
const kit = require('../ui/kit');

/**
 * ميزات /config — مصدر واحد لقائمة الأمر والعرض والتبديل.
 *
 * كان العرض يبني خريطة حالات مسمّاة بالعربية ثم يقرأ منها بنفس تلك الأسماء،
 * فأي اسم لا يطابق (أو ميزة حُذفت مثل «أوامر تاريخ النقاط») كان يُطبع
 * `undefined` داخل الحقل. الآن لا يوجد بحث بالاسم إطلاقاً: كل حقل يرسم
 * `FEATURES` مباشرةً، والتسمية تُقرأ من المفتاح لا من نص مُترجم.
 *
 * المفاتيح تأتي من services/settings (المصدر الوحيد لـ FEATURE_TOGGLES_DEFAULTS)،
 * والتعليق يوضّح ما يفعله الإيقاف فعلاً حتى لا نعد بما لا نفّذه.
 */
const FEATURES = [
  { key: 'weeklyReports', label: 'تقارير أسبوعية تلقائية', group: 'reports', hint: 'يُوقف التقرير الأسبوعي المجدول' },
  { key: 'monthlyReports', label: 'تقارير شهرية تلقائية', group: 'reports', hint: 'يُوقف التقرير الشهري المجدول' },
  { key: 'activityTracking', label: 'تتبع النشاط', group: 'tracking', hint: '⚠️ غير مربوط: إيقافه لا يوقف تسجيل النشاط بعد' },
  { key: 'punishmentSystem', label: 'نظام العقوبات', group: 'system', hint: 'يُوقف /warn و /note' },
  { key: 'detailedSystemStatus', label: 'حالة النظام التفصيلية', group: 'system', hint: 'يُوقف الوضع التفصيلي في /system-status' },
  { key: 'promotionProgress', label: 'أمر تقدم الترقية', group: 'commands', hint: 'يُوقف أمر تقدم الترقية' },
  { key: 'myStatusCommand', label: 'أمر حالتي الحالية', group: 'commands', hint: 'يُوقف أمر حالتي' },
  { key: 'auditExport', label: 'تصدير سجلات التدقيق', group: 'commands', hint: 'يُوقف /audit وسجل العمليات' },
  { key: 'autoBackups', label: 'نسخ احتياطية تلقائية', group: 'tracking', hint: 'يُوقف النسخ الاحتياطي المجدول' },
];

const FEATURE_LABELS = Object.freeze(Object.fromEntries(FEATURES.map(f => [f.key, f.label])));

/** ترتيب وحقول العرض — كل حقل يذكر ميزات موجودة فعلاً في FEATURES. */
const VIEW_FIELDS = [
  { name: '📊 التقارير المجدولة', group: 'reports' },
  { name: '🗂️ النسخ والتتبع', group: 'tracking' },
  { name: '⚡ الأوامر', group: 'commands' },
  { name: '🛡️ النظام', group: 'system' },
];

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('config').setDescription('إدارة ميزات البوت (تشغيل/إيقاف)')
        .addStringOption(o => o.setName('action').setDescription('الإجراء').setRequired(true)
          .addChoices(
            { name: 'عرض الحالة', value: 'view' },
            { name: 'تشغيل ميزة', value: 'enable' },
            { name: 'إيقاف ميزة', value: 'disable' },
            { name: 'إعادة الإعدادات الافتراضية', value: 'reset' }
          ))
        .addStringOption(o => o.setName('feature').setDescription('الميزة')
          // الاختيارات تُبنى من FEATURES: لا يمكن عرض ميزة غير معرّفة ولا نسيان ميزة.
          .addChoices(...FEATURES.map(f => ({ name: f.label, value: f.key })))),
      level: LEVELS.BOSS, // فقط Boss أو Server Manager
      async execute(i) {
        const action = i.options.getString('action');
        const feature = i.options.getString('feature');

        switch (action) {
          case 'view':
            return viewConfig(i);
          case 'enable':
            if (!feature) return replyEphemeral(i, '❌ يجب تحديد الميزة', COLORS.danger);
            return setFeature(i, feature, true);
          case 'disable':
            if (!feature) return replyEphemeral(i, '❌ يجب تحديد الميزة', COLORS.danger);
            return setFeature(i, feature, false);
          case 'reset':
            return resetConfig(i);
          default:
            return replyEphemeral(i, '❌ إجراء غير صالح', COLORS.danger);
        }
      },
    },
  ],

  components: {},
  FEATURES,
  FEATURE_LABELS,
};

async function viewConfig(i) {
  const state = key => settings.featureToggle(key) ? '✅ مفعل' : '❌ معطل';

  const fields = VIEW_FIELDS.map(field => ({
    name: field.name,
    value: FEATURES.filter(f => f.group === field.group)
      .map(f => `${f.label}: ${state(f.key)}`)
      .join('\n'),
  }));
  // حارس: كل حقل يجب أن يحمل سطراً واحداً على الأقل، وإلا فهو حقل فارغ بلا فائدة.
  for (const f of fields) if (!f.value) f.value = '—';

  const e = kit.card({
    title: '⚙️ حالة ميزات البوت',
    description: 'استخدم `/config enable <الميزة>` أو `/config disable <الميزة>` لتغيير الحالة',
    fields,
    color: COLORS.info,
    footer: kit.footerLine('التغييرات تؤثر فوراً على جميع الخدمات'),
  });

  return i.reply({ embeds: [e], ephemeral: true });
}

async function setFeature(i, feature, value) {
  const found = FEATURES.find(f => f.key === feature);
  // مفتاح غير معروف كان يُحفظ في الإعدادات ويظهر للمشغّل كمفتاحه الخام.
  if (!found) return replyEphemeral(i, `❌ ميزة غير معروفة: \`${String(feature).slice(0, 40)}\` — استخدم \`/config\` لعرض القائمة.`, COLORS.danger);

  const oldValue = settings.featureToggle(found.key);
  settings.setFeatureToggle(found.key, value);

  const actionText = value ? 'تم تفعيل' : 'تم تعطيل';
  const emoji = value ? '✅' : '❌';

  const e = kit.card({
    title: `${emoji} ${actionText} الميزة`,
    description: `${found.label}\n${value ? 'ستكون الميزة نشطة من الآن فصاعداً' : 'ستكون الميزة متوقفة من الآن فصاعداً'}\n${found.hint}`,
    color: value ? COLORS.success : COLORS.danger,
    footer: kit.footerLine(`الحالة السابقة: ${oldValue ? 'مفعلة' : 'معطلة'}`),
  });

  return i.reply({ embeds: [e], ephemeral: true });
}

async function resetConfig(i) {
  settings.resetFeatureToggles();

  const e = kit.card({
    title: '🔄 تم إعادة تعيين الميزات',
    description: 'تم إعادة جميع الميزات إلى الإعدادات الافتراضية (كلها مفعّلة)',
    color: COLORS.warning,
    footer: kit.footerLine('يمكنك الآن إعادة تفعيل الميزات التي تحتاجها'),
  });

  return i.reply({ embeds: [e], ephemeral: true });
}