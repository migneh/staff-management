'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const settings = require('../services/settings');
const staffService = require('../services/staff');
const promotions = require('../services/promotions');
const score = require('../services/score');
const clock = require('../clock');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative, tsDate } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('promotion-progress').setDescription('عرض تفصيلي لتقدمك نحو الترقية القادمة')
        .addBooleanOption(o => o.setName('show-remaining').setDescription('عرض المتطلبات المتبقية فقط')),
      level: LEVELS.STAFF,
  async execute(i) {
         if (!settings.featureToggle('promotionProgress')) return replyEphemeral(i, '❌ هذا الأمر معطّل حالياً.', COLORS.danger);
         const showRemainingOnly = i.options.getBoolean('show-remaining') || false;
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        
        const promoEval = promotions.evaluate(member);
        if (!promoEval.rule) {
          return i.reply({ embeds: [kit.card({
            title: '📈 حالة الترقية',
            description: `رتبتك الحالية: **${member.rank}**\n${promoEval.reason}`,
            color: COLORS.info,
            footer: kit.footerLine(`لا توجد ترقية تلقائية لهذه الرتبة`),
          })], ephemeral: true });
        }
        
        const rule = promoEval.rule;
        const passedChecks = promoEval.checks.filter(c => c.pass).length;
        const totalChecks = promoEval.checks.length;
        const progressPercent = Math.round((passedChecks / totalChecks) * 100);
        const monthsInRank = clock.monthsSince(member.rank_since);
        const monthsToNextRank = Math.max(0, rule.months - monthsInRank);
        
        // Build requirement details
        const requirementDetails = promoEval.checks.map(check => {
          const statusIcon = check.pass ? '✅' : '❌';
          const checkBar = progressBar(
            typeof check.actual === 'number' && typeof check.required === 'number' 
              ? Math.min(check.actual, check.required) 
              : check.pass ? 1 : 0,
            typeof check.required === 'number' ? check.required : 100,
            10
          );
          
          let actualValue = check.actual;
          if (typeof actualValue === 'number') {
            actualValue = arDigits(actualValue);
          }
          
          return `${statusIcon} **${check.label}**: ${actualValue} / ${check.required} ${checkBar}`;
        }).join('\n');
        
        // Build embed
        const e = kit.card({
          title: `📈 تقدم الترقية: ${member.rank} → ${rule.to}`,
          description: `المتطلبات المكتملة: **${passedChecks}/${totalChecks}** (${progressPercent}%)`,
          fields: [
            { name: '⏱️ الوقت في الرتبة', value: `${arDigits(monthsInRank.toFixed(1))} شهر / ${rule.months} شهر` },
            { name: '📈 التقييم (Score)', value: `${score.compute(member).score}/100` },
            { name: '📋 متطلبات الترقية', value: requirementDetails.slice(0, 1024) },
          ],
          color: promoEval.eligible ? COLORS.success : COLORS.warning,
  footer: kit.footerLine(
            promoEval.eligible 
              ? `✅ مؤهل للترقية! استخدم \`/request-promotion\` للتقديم` 
              : `⏳ المتبقّي: ${monthsToNextRank > 0 ? `${arDigits(monthsToNextRank)} شهر` : '—'}${
                  promoEval.checks.some(c => !c.pass && c.label.includes('التقييم')) ? ' | التقييم غير كافٍ' : ''
                }`
          ),
        });
        
        // Add remaining requirements section if requested
        if (showRemainingOnly) {
          const remainingChecks = promoEval.checks.filter(c => !c.pass);
          if (remainingChecks.length > 0) {
            const remainingDetails = remainingChecks.map(check => {
              const needed = typeof check.required === 'number' 
                ? `${arDigits(Math.max(0, check.required - (typeof check.actual === 'number' ? check.actual : 0)))}` 
                : check.required;
              
              return `❌ **${check.label}**: لا زلت بحاجة إلى ${needed}`;
            }).join('\n');
            
            e.addFields({
              name: '🔴 المتطلبات المتبقية',
              value: remainingDetails.slice(0, 1024),
            });
          }
        }
        
        // Add time-based estimates
        const timeEstimates = [];
        if (monthsToNextRank > 0) {
          timeEstimates.push(`⏰ الوقت المطلوب في الرتبة: ${arDigits(monthsToNextRank)} شهر`);
        }
        
        if (timeEstimates.length > 0) {
          e.addFields({
            name: '📅 التقديرات الزمنية',
            value: timeEstimates.join('\n'),
          });
        }
        
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
  
  components: {},
};