'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS } = require('../constants');
const settings = require('../services/settings');
const activity = require('../services/activity');
const staffService = require('../services/staff');
const promotions = require('../services/promotions');
const score = require('../services/score');
const clock = require('../clock');
const tasks = require('../services/tasks');
const leaveService = require('../services/leaves');
const { embed, COLORS, replyEphemeral, arDigits, progressBar, tsRelative } = require('../utils');
const kit = require('../ui/kit');

module.exports = {
  commands: [
    {
    data: new SlashCommandBuilder().setName('my-status').setDescription('عرض حالتك الحالية: النشاط، المهام، الإجازات، والترقية')
         .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفصيلي أكثر')),
      level: LEVELS.STAFF,
  async execute(i) {
         if (!settings.featureToggle('myStatusCommand')) return replyEphemeral(i, '❌ هذا الأمر معطّل حالياً.', COLORS.danger);
         const detailed = i.options.getBoolean('detailed') || false;
        const userId = i.user.id;
        const member = staffService.get(userId);
        if (!member) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        
        // Get activity stats for last 30 days
        const activityStats = activity.stats(userId, 30);
        const today = clock.today();
        const lastActivityHours = clock.hoursSince(member.last_activity || member.joined_at);
        
        // Calculate absence status
        let absenceStatus = 'نشط';
        let absenceColor = COLORS.success;
        if (lastActivityHours >= 96) {
          absenceStatus = 'تحذير absence (96+ ساعة)';
          absenceColor = COLORS.danger;
        } else if (lastActivityHours >= 72) {
          absenceStatus = 'تحذير initial (72+ ساعة)';
          absenceColor = COLORS.warning;
}
        
        // Get current rank
        const currentRank = member.rank;
        const currentTeam = member.team;
        
        // Get promotion evaluation
        const promoEval = promotions.evaluate(member);
        const pointsToNextRank = 0;
        const monthsInRank = clock.monthsSince(member.rank_since);
        
        // Get current score
        const currentScoreObj = score.compute(member);
        const currentScore = currentScoreObj.score;
        
        // Get current tasks
        const pendingTasks = tasks.list(userId, { includeCompleted: false, limit: 10 });
        const pendingTaskCount = pendingTasks.length;
        const onboardingTasks = pendingTasks.filter(t => t.task_type === 'onboarding');
        const generalTasks = pendingTasks.filter(t => t.task_type === 'general');
        const followUpTasks = pendingTasks.filter(t => t.task_type === 'follow_up');
        
        // Get leave info
        const allowance = leaveService.allowance(userId);
        const activeLeaves = leaveService.activeForUser(userId, today);
        const pendingLeaves = leaveService.pendingForUser(userId);
        const approvedLeaves = leaveService.approvedForUser(userId, { onOrAfter: today });
        
        // Build embed
        const e = kit.card({
          title: `📊 حالتك الحالية — <@${userId}>`,
          description: `${member.rank} • ${TEAMS[member.team] || member.team} • ${STATUS[member.status] || member.status}`,
          fields: [
            { name: '💯 نقاط الترقية', value: `${arDigits(currentScoreObj.raw?.messages || 0)}`, inline: true },
            { name: '📈 تقييمك (Score)', value: `${currentScore}/100 (${score.grade(currentScore)})`, inline: true },
            { name: '📅 النشاط (30 يوم)', value: `${arDigits(activityStats.activeDays)} يوم`, inline: true },
            { name: '💬 الرسائل (30 يوم)', value: `${arDigits(activityStats.messages)}`, inline: true },
            { name: '🎯 النقاط المرجحة (30 يوم)', value: `${arDigits(activityStats.weighted)}`, inline: true },
            { name: '⏰ آخر نشاط', value: `${tsRelative(member.last_activity || member.joined_at)}`, inline: true },
            { name: '🚦 حالة الغياب', value: absenceStatus, inline: true },
            { name: '📆 الوقت في الرتبة', value: `${monthsInRank.toFixed(1)} شهر`, inline: true },
          ],
          color: absenceColor,
          footer: kit.footerLine(`الحالة العامة: ${absenceStatus === 'نشط' ? 'جيد' : 'يحتاج اهتمام'} • ${clock.nowIso()}`),
        });
        
        // Add tasks info
        if (pendingTaskCount > 0) {
          const taskSummary = [];
          if (onboardingTasks.length) taskSummary.push(`📚 تأهيل: ${onboardingTasks.length}`);
          if (generalTasks.length) taskSummary.push(`📋 عامة: ${generalTasks.length}`);
          if (followUpTasks.length) taskSummary.push(`🔄 متابعة: ${followUpTasks.length}`);
          
          const nextTask = pendingTasks
            .filter(t => t.due_date)
            .sort((a, b) => new Date(a.due_date) - new Date(b.due_date))[0];
          
          let taskValue = `**${pendingTaskCount}** مهام معلقة\n${taskSummary.join(' • ')}`;
          if (nextTask) {
            const dueIn = clock.daysBetween(today(), nextTask.due_date);
            taskValue += `\n⏳ القادمة: #${nextTask.id} — ${nextTask.title.slice(0, 50)} (${dueIn >= 0 ? `${dueIn} يوم متبقي` : `${Math.abs(dueIn)} يوم متأخر`})`;
          }
          
          e.addFields({ name: '📋 مهامك الحالية', value: taskValue, inline: false });
        } else {
          e.addFields({ name: '📋 مهامك الحالية', value: '✅ لا توجد مهام معلقة', inline: false });
        }
        
        // Add leave balance info
        const leaveBalance = [];
        for (const [type, data] of Object.entries(allowance.types)) {
          if (data.cap90 > 0) {
            leaveBalance.push(`${type}: ${data.remaining90}/${data.cap90} (90يوم) ${data.pending90 > 0 ? `+${data.pending90} معلق` : ''}`);
          }
        }
        
        if (activeLeaves.length > 0) {
          const activeLeave = activeLeaves[0];
          leaveBalance.unshift(`🏖️ **في إجازة حالياً** (${activeLeave.leave_type}: ${activeLeave.start_date} → ${activeLeave.end_date})`);
        }
        
        if (pendingLeaves.length > 0) {
          const pl = pendingLeaves[0];
          leaveBalance.unshift(`⏳ **معلق**: ${pl.leave_type} (${pl.start_date} → ${pl.end_date})`);
        }
        
        if (leaveBalance.length > 0) {
          e.addFields({ name: '🏖️ رصيد الإجازات', value: leaveBalance.slice(0, 8).join('\n'), inline: false });
        }
        
        // Add promotion info if applicable
        if (promoEval.rule) {
          const passedChecks = promoEval.checks.filter(c => c.pass).length;
          const totalChecks = promoEval.checks.length;
          const progressPercent = Math.round((passedChecks / totalChecks) * 100);
          
e.addFields({
              name: `🎯 الترقية القادمة: ${promoEval.rule.to}`,
              value: `${progressBar(passedChecks, totalChecks, 10)} **${passedChecks}/${totalChecks}** شرط مكتمل (${progressPercent}%)\n${promoEval.eligible ? '✅ مؤهل للتقدم' : '❌ غير مؤهل actuellement'}\n${promoEval.eligible ? '✅ متوافق مع متطلبات الترقية' : '❌ تحتاج لتحسين الأداء للترقية'}`,
            });
            
          if (detailed) {
            // Add detailed requirement breakdown
            const reqDetails = promoEval.checks.map(check => {
              const statusIcon = check.pass ? '✅' : '❌';
              return `${statusIcon} **${check.label}**: ${check.actual} / ${check.required}`;
            }).join('\n');
            
            e.addFields({
              name: '📋 تفاصيل المتطلبات',
              value: reqDetails.slice(0, 1024),
            });
          }
        } else {
          e.addFields({
            name: '🏆 الترقية',
            value: 'لا توجد ترقية تلقائية لهذه الرتبة (يدوية بقرار Boss)',
          });
        }
        
        // Add onboarding progress if in probation
        if (member.status === 'probation') {
          const completedOnboarding = onboardingTasks.filter(t => t.status === 'completed').length;
          const totalOnboarding = onboardingTasks.length + completedOnboarding;
          if (totalOnboarding > 0) {
            e.addFields({
              name: '📚 تقدم التأهيل',
              value: `${progressBar(completedOnboarding, totalOnboarding, 10)} **${completedOnboarding}/${totalOnboarding}** مهام مكتملة\n${member.onboarding_ready ? '✅ جاهز للمراجعة الإدارية' : '⏳ أكمل المهام المتبقية'}`,
              inline: false
            });
          }
        }
        
        // Add absence warning info if applicable
        if (lastActivityHours >= 72) {
          const hoursUntilWarning = 96 - lastActivityHours;
          const hoursUntilAlert = 96 - lastActivityHours;
          
          e.addFields({
            name: '⚠️ تحذيرات الغياب',
            value: lastActivityHours >= 96 
              ? `⛔ لديك تحذير absence منذ ${Math.floor(lastActivityHours - 96)} ساعات\n⚠️ سيتم تنبيه الفريق إذا لم تكن نشطاً خلال ${Math.max(0, 96 - lastActivityHours)} ساعات القادمة`
              : `⚠️ ستحصل على تحذير absence خلال ${Math.floor(hoursUntilWarning)} ساعات إذا لم تكن نشطاً\n🚨 سيحصل الفريق على تنبيه خلال ${Math.max(0, hoursUntilAlert)} ساعات إذا لم تكن نشطاً`,
          });
}
        
        // Add detailed section if requested
        if (detailed) {
          // Get recent activity by channel type
          e.addFields({
            name: '📊 تفصيل النشاط (30 يوم)',
            value: Object.entries(activityStats.byChannel).map(([type, count]) => {
              const typeName = {
                'support': '🎫 تكت',
                'moderation': '🛡️ إجراء',
                'chat': '💬 شات',
                'voice': '🔊 صوت',
                'screen': '🖥️ مشاركة شاشة',
                'game': '🎮 لعبة'
              }[type] || type;
              return `${typeName}: **${arDigits(count)}**`;
            }).join('\n'),
          });
          
          // Add score factor breakdown
          if (currentScoreObj.factors) {
            const factorDetails = currentScoreObj.factors.map(f => {
              const icon = f.assessed ? '✅' : '⏳';
              return `${icon} **${f.name}**: ${f.pts}/${f.max} — ${f.detail}`;
            }).join('\n');
            e.addFields({
              name: '📈 تفصيل Score',
              value: factorDetails.slice(0, 1024),
            });
          }
        }
        
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
  
  components: {},
};