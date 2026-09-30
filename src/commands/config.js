'use strict';
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const settings = require('../services/settings');
const { embed, COLORS, replyEphemeral } = require('../utils');
const kit = require('../ui/kit');

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
.addChoices(
             { name: 'نقاط تلقائية من التكتات', value: 'autoTicketPoints' },
             { name: 'تقارير أسبوعية تلقائية', value: 'weeklyReports' },
             { name: 'تقارير شهرية تلقائية', value: 'monthlyReports' },
             { name: 'تتبع النشاط', value: 'activityTracking' },
             { name: 'نظام العقوبات', value: 'punishmentSystem' },
             { name: 'حالة النظام التفصيلية', value: 'detailedSystemStatus' },
             { name: 'أمر تقدم الترقية', value: 'promotionProgress' },
             { name: 'أمر حالتي الحالية', value: 'myStatusCommand' },
            { name: 'تصدير سجلات التدقيق', value: 'auditExport' },
            { name: 'نسخ احتياطية تلقائية', value: 'autoBackups' }
          )),
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
};

async function viewConfig(i) {
  const toggles = {};
  const featureNames = {
    autoTicketPoints: 'نقاط تلقائية من التكتات',
    weeklyReports: 'تقارير أسبوعية تلقائية',
    monthlyReports: 'تقارير شهرية تلقائية',
    activityTracking: 'تتبع النشاط',
punishmentSystem: 'نظام العقوبات',
     detailedSystemStatus: 'حالة النظام التفصيلية',
     promotionProgress: 'أمر تقدم الترقية',
     myStatusCommand: 'أمر حالتي الحالية',
     auditExport: 'تصدير سجلات التدقيق',
     autoBackups: 'نسخ احتياطية تلقائية',
   };
  
  for (const [key, name] of Object.entries(featureNames)) {
    toggles[name] = settings.featureToggle(key) ? '✅ مفعل' : '❌ معطل';
  }
  
  const e = kit.card({
    title: '⚙️ حالة ميزات البوت',
    description: 'استخدم `/config enable <الميزة>` أو `/config disable <الميزة>` لتغيير الحالة',
    fields: [
      { name: '🎫 نظام التكتات', value: `${toggles['نقاط تلقائية من التكتات']}\n${toggles['نسخ احتياطية تلقائية']}` },
      { name: '📊 التقارير والأوامر', value: `${toggles['تقارير أسبوعية تلقائية']}\n${toggles['تقارير شهرية تلقائية']}\n${toggles['أوامر تاريخ النقاط']}\n${toggles['أمر تقدم الترقية']}\n${toggles['أمر حالتي الحالية']}` },
      { name: '🛡️ النظام والأمان', value: `${toggles['نظام العقوبات']}\n${toggles['تصدر سجلات التدقيق']}\n${toggles['حالة النظام التفصيلية']}` },
      { name: '📈 التتبع والنقاط', value: `${toggles['تتبع النشاط']}` },
    ],
    color: COLORS.info,
    footer: kit.footerLine('التغييرات تؤثر فوراً على جميع الخدمات'),
  });
  
  return i.reply({ embeds: [e], ephemeral: true });
}

async function setFeature(i, feature, value) {
  const featureNames = {
autoTicketPoints: 'نقاط تلقائية من التكتات',
     weeklyReports: 'تقارير أسبوعية تلقائية',
     monthlyReports: 'تقارير شهرية تلقائية',
     activityTracking: 'تتبع النشاط',
     punishmentSystem: 'نظام العقوبات',
     detailedSystemStatus: 'حالة النظام التفصيلية',
     promotionProgress: 'أمر تقدم الترقية',
     myStatusCommand: 'أمر حالتي الحالية',
     auditExport: 'تصدر سجلات التدقيق',
     autoBackups: 'نسخ احتياطية تلقائية',
  };
  
  const name = featureNames[feature] || feature;
  const oldValue = settings.featureToggle(feature);
  const newValue = settings.setFeatureToggle(feature, value);
  
  const actionText = value ? 'تم تفعيل' : 'تم تعطيل';
  const emoji = value ? '✅' : '❌';
  
  const e = kit.card({
    title: `${emoji} ${actionText} الميزة`,
    description: `${name}\n${value ? 'ستكون الميزة نشطة من الآن فصاعداً' : 'ستكون الميزة متوقفة من الآن فصاعداً'}`,
    color: value ? COLORS.success : COLORS.danger,
    footer: kit.footerLine(`الحالة السابقة: ${oldValue ? 'مفعلة' : 'معطلة'}`),
  });
  
  return i.reply({ embeds: [e], ephemeral: true });
}

async function resetConfig(i) {
  settings.resetFeatureToggles();
  
  const e = kit.card({
    title: '🔄 تم إعادة تعيين الميزات',
    description: 'تم إعادة جميع الميزات إلى الإعدادات الافتراضية',
    color: COLORS.warning,
    footer: kit.footerLine('يمكنك الآن إعادة تفعيل الميزات التي تحتاجها'),
  });
  
  return i.reply({ embeds: [e], ephemeral: true });
}