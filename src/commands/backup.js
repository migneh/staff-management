'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const backup = require('../services/backup');
const retention = require('../services/retention');
const audit = require('../services/audit');
const clock = require('../clock');
const { embed, COLORS, divider } = require('../utils');
const kit = require('../ui/kit');

function sizeMb(bytes) { return `${(Number(bytes || 0) / 1024 / 1024).toFixed(2)} م.ب`; }

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('backup').setDescription('إنشاء نسخة احتياطية آمنة من بيانات البوت + عرض حالة النسخ'),
      level: LEVELS.STAFF,
      serverManagerOnly: true,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        try {
          const file = await backup.createBackup({ reason: `manual-${i.user.id}` });
          const check = backup.verify(file);
          audit.record({ action: 'database_backup', actorId: i.user.id, details: { file, verified: check.ok }, channelId: i.channelId });
          return i.editReply({
            embeds: [embed('✅ تم إنشاء النسخة الاحتياطية', `${divider}\n\`${file.split(/[\\/]/).pop()}\` • ${sizeMb(check.size)}\n${check.ok ? '🟢 **فحص السلامة:** ' : '🔴 **الفحص:** '}${check.detail}\n\n> نسخة لم تُختبر ليست نسخة — تُسجَّل نتيجة كل فحص في \`backup_checks\`.`, check.ok ? COLORS.success : COLORS.danger)],
          });
        } catch (e) {
          return i.editReply({ embeds: [embed('❌ فشل النسخ الاحتياطي', e.message, COLORS.danger)] });
        }
      },
    },
    {
      data: new SlashCommandBuilder().setName('backup-list').setDescription('عرض النسخ الاحتياطية وفحص سلامة أحدثها'),
      level: LEVELS.STAFF,
      serverManagerOnly: true,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const files = backup.listBackups();
        if (!files.length) return i.editReply({ embeds: [embed('🗄️ لا توجد نسخ احتياطية', 'شغّل `/backup` لإنشاء أول نسخة.', COLORS.warning)] });
        const newest = files[0];
        const check = backup.verify(newest.path);
        const rows = files.slice(0, 10).map(f => `• \`${f.name}\` — ${sizeMb(f.size)} • ${kit.tsRelative(f.modifiedAt)}`);
        return i.editReply({
          embeds: [embed(`🗄️ النسخ الاحتياطية (${files.length})`,
            `${rows.join('\n')}${files.length > 10 ? `\n… و${files.length - 10} نسخة أخرى` : ''}\n${divider}\n**فحص أحدث نسخة:** ${check.ok ? '🟢' : '🔴'} ${check.detail}\n\n**خطوات الاسترجاع:** أوقف البوت ← احتفظ بـ \`data/staff.db\` جانباً ← انسخ النسخة مكانه ← \`PRAGMA integrity_check\` ← ثم شغّل البوت وتحقّق بـ \`/system-status\``,
            check.ok ? COLORS.success : COLORS.danger).setFooter({ text: `آخر فحص: ${clock.nowIso()} بتوقيت UTC` })],
        });
      },
    },
    {
      data: new SlashCommandBuilder().setName('maintenance').setDescription('صيانة البيانات: تجميع النشاط القديم وتقليم السجلات (مع معاينة)')
        .addBooleanOption(o => o.setName('dry_run').setDescription('عرض ما سيُحذف دون تنفيذ (الافتراضي: نعم)'))
        .addBooleanOption(o => o.setName('confirm').setDescription('تأكيد التنفيذ الفعلي')),
      level: LEVELS.BOSS,
      serverManagerOnly: true,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const dryRun = !(i.options.getBoolean('confirm') || false);
        const r = retention.run({ dryRun });
        if (dryRun) {
          return i.editReply({
            embeds: [embed('🧪 معاينة صيانة البيانات', `${divider}\n`
              + `📦 **الرسائل الخام قبل ${r.rollup.cutoff}:** ستُجمَّع في ${r.rollup.months} شهراً ثم تُحذف (${r.activity.pending} صف)\n`
              + `📝 **سجل العمليات قبل ${r.audit.cutoff.slice(0, 7)}:** ${r.audit.pending} سجل\n`
              + `🗄️ **حجم القاعدة:** ${r.sizeBeforeMb} م.ب\n\n`
              + 'لم يُحذف أي شيء. للتنفيذ: أعد الأمر مع `confirm: true`.', COLORS.info)],
          });
        }
        audit.record({ action: 'data_maintenance', actorId: i.user.id, details: r, channelId: i.channelId });
        return i.editReply({
          embeds: [embed('🧹 تمت صيانة البيانات', `${divider}\n`
            + `📦 جُمّع **${r.rollup.rows}** سجل نشاط في **${r.rollup.months}** شهراً\n`
            + `🗑️ حُذف **${r.activity.deleted}** صف نشاط خام و**${r.audit.deleted}** سجل عمليات\n`
            + `🗄️ الحجم: ${r.sizeBeforeMb} → **${r.sizeAfterMb}** م.ب${r.vacuumed ? ' (VACUUM)' : ''}`, COLORS.success)],
        });
      },
    },
  ],
  components: {},
};
