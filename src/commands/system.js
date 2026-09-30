'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const scheduler = require('../scheduler');
const backup = require('../services/backup');
const settings = require('../services/settings');
const clock = require('../clock');
const retention = require('../services/retention');
const { getDb } = require('../database');
const { embed, COLORS, divider, arDigits, replyEphemeral } = require('../utils');
const kit = require('../ui/kit');

const JOB_LABELS = {
  absence: 'فحص الغياب',
  suspensions: 'رفع الإيقاف المنتهي',
  leaves: 'الإجازات',
  resignations: 'الاستقالات',
  'task-reminders': 'تذكيرات المهام',
  backup: 'النسخ الاحتياطي',
  'daily-report': 'التقرير اليومي',
  'weekly-report': 'التقرير الأسبوعي',
  'monthly-report': 'التقرير الشهري',
  maintenance: 'صيانة البيانات',
};

/** صحة النظام: آخر تشغيل لكل مهمة + قاعدة البيانات + آخر نسخة احتياطية */
module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('system-status').setDescription('صحة البوت: المهام المجدولة، قاعدة البيانات، آخر نسخة احتياطية')
        .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفصيلي أكثر لقاعدة البيانات')),
      level: LEVELS.STAFF, serverManagerOnly: true,
      async execute(i) {
        const detailed = i.options.getBoolean('detailed') || false;
        if (detailed && !settings.featureToggle('detailedSystemStatus')) return replyEphemeral(i, '❌ هذا الوضع التفصيلي معطّل حالياً.', COLORS.danger);
        const runs = scheduler.status();
        const jobs = scheduler.JOBS || [];
        const lines = jobs.map(j => {
          const last = runs[j.name];
          if (!last) return `⚪ **${JOB_LABELS[j.name] || j.name}** — لم يعمل بعد (${clock.TZ}: \`${j.expr}\`)`;
          const ok = last.ok ? '🟢' : '🔴';
          const when = kit.tsRelative(last.finishedAt);
          return `${ok} **${JOB_LABELS[j.name] || j.name}** — ${when}${last.error ? `\n> ${String(last.error).slice(0, 120)}` : ''}`;
        });

        const db = getDb();
        const counts = retention.tableCounts();
        const sizeMb = retention.dbSizeMb();
        const lastCheck = db.prepare('SELECT * FROM backup_checks ORDER BY id DESC LIMIT 1').get() || null;
        const rolledMonths = new Set(db.prepare('SELECT DISTINCT month FROM activity_monthly').all().map(r => r.month)).size;
        const lastBackup = backup.listBackups()[0];
        const st = settings.status();

        // Database size status
        let sizeStatus = '🟢 طبيعي';
        let sizeWarning = '';
        if (sizeMb > 100) { // Warning at 100MB
          sizeStatus = '🟡 كبير';
          sizeWarning = `\n⚠️ حجم قاعدة البيانات كبير (>100 م.ب) - فكر في تشغيل الصيانة`;
        }
        if (sizeMb > 500) { // Critical at 500MB
          sizeStatus = '🔴 خطر';
          sizeWarning = `\n⛔ حجم قاعدة البيانات خطر (>500 م.ب) - مطلوب تنظيف فوري`;
        }

        const e = embed('🩺 صحة النظام', `${divider}`, COLORS.primary)
          .addFields(
            { name: '⏰ المهام المجدولة', value: lines.length ? lines.join('\n') : 'لا توجد مهام مسجّلة (المجدول لم يبدأ بعد).' },
            { name: '🗄️ قاعدة البيانات', value: `الحجم: **${sizeMb} م.ب** ${sizeStatus}${sizeWarning}\nإداريون: **${counts.staff_members}** • نشاط خام: **${counts.activity_logs}** • أشهر مُجمَّعة: **${rolledMonths}**\nتكتات: **${counts.ticket_metrics}** • عمليات: **${counts.audit_logs}**\nسجل الرتب: **${counts.staff_rank_history}** • فحوص النسخ: **${counts.backup_checks}**`, inline: false },
          );

        // Add detailed database info if requested
        if (detailed) {
          const tableDetails = Object.entries(counts)
            .filter(([table, count]) => count !== null && count > 0)
            .map(([table, count]) => {
              const tableNames = {
                staff_members: '👥 الإداريون',
                activity_logs: '📝 نشاط خام',
                activity_monthly: '📊 نشاط شهري',
                ticket_metrics: '🎫 تكتات',
                audit_logs: '📒 سجل العمليات',
                staff_rank_history: '📜 تاريخ الرتب',
                backup_checks: '💾 فحوص النسخ',
                promotion_requests: '📈 طلبات الترقية',
                promotion_approvals: '👍 موافقات الترقية',
                promotion_cooldowns: '⏳ فترات التبريد',
                warnings: '⚠️ إنذارات',
                staff_notes: '📝 ملاحظات',
                leave_requests: '🏖️ طلبات إجازة',
                resignations: '📤 طلبات استقالة',
                staff_tasks: '📋 مهامstaff',
                settings: '⚙️ الإعدادات',
                job_runs: '⏰ تشغيل المهام',
                saved_reports: '📊 تقارير محفوظة',
                support_ratings: '⭐ تقييمات الدعم',
                mod_actions: '🛡️ إجراءات إشرافية',
                ticket_source_logs: '🤖 سجلات تكت خارجية',
              };
              const tableName = tableNames[table] || table;
              return `${tableName}: **${arDigits(count)}** صف`;
            })
            .join(' • ');
          
          e.addFields({
            name: '📊 تفاصيل الجداول',
            value: tableDetails.length > 0 ? tableDetails : 'لا توجد بيانات جدولية',
          });
        }

        e.addFields(
          { name: '💾 آخر نسخة احتياطية', value: lastBackup ? `${kit.tsRelative(lastBackup.modifiedAt)} · ${(lastBackup.size / 1024 / 1024).toFixed(2)} م.ب${lastCheck ? `\n${lastCheck.ok ? '🟢 فحص سليم' : '🔴 فحص فاشل'} — ${String(lastCheck.detail).slice(0, 70)}` : ''}` : 'لا توجد — شغّل `/backup`', inline: true },
          { name: '⚙️ الإعداد', value: `رتب ${st.rolesDone}/${st.rolesTotal} • قنوات ${st.channelsDone}/${st.channelsTotal}`, inline: true },
        )
        .setFooter({ text: `المنطقة الزمنية: ${clock.TZ} • آخر تحديث` });
        return i.reply({ embeds: [e], ephemeral: true });
      },
    },
  ],
};
