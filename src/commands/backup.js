'use strict';
const { SlashCommandBuilder } = require('discord.js');
const { LEVELS } = require('../constants');
const config = require('../config');
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
          const label = backup.checkLabel(check);
          audit.record({ action: 'database_backup', actorId: i.user.id, details: { file, verified: check.ok === true, verificationState: label.color }, channelId: i.channelId });
          return i.editReply({
            embeds: [embed('✅ تم إنشاء النسخة الاحتياطية', `${divider}\n\`${file.split(/[\\/]/).pop()}\` • ${sizeMb(check.size)}\n${backup.checkLine(check)}\n\n> نسخة لم تُختبر ليست نسخة — تُسجَّل نتيجة كل فحص في \`backup_checks\`.`, COLORS[label.color] || COLORS.info)],
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
        const label = backup.checkLabel(check);
        const rows = files.slice(0, 10).map(f => `• \`${f.name}\` — ${sizeMb(f.size)} • ${kit.tsRelative(f.modifiedAt)}`);
        // خطوات الاسترجاع تستهدف المسار الذي يفتحه البوت فعلاً، لا مساراً مثالياً:
        // كان النصّ يثبّت `data/staff.db` بينما systemd وCompose يشغّلان البوت على
        // قاعدة أخرى (DB_PATH) — فالنسخ مكان ذلك الملف كان يسترجع ملفاً لا يفتحه
        // البوت أبداً. المصدر الآن config.dbPath، وهو نفس القيمة التي يقرأها
        // src/database.js — فالنصّ والقاعدة لا يختلفان أبداً.
        const dbPath = config.dbPath;
        return i.editReply({
          embeds: [embed(`🗄️ النسخ الاحتياطية (${files.length})`,
            `${rows.join('\n')}${files.length > 10 ? `\n… و${files.length - 10} نسخة أخرى` : ''}\n${divider}\n**فحص أحدث نسخة:** ${label.emoji} ${check.detail}\n\n**خطوات الاسترجاع:** أوقف البوت ← احتفظ بـ \`${dbPath}\` جانباً ← انسخ النسخة مكانه ← \`PRAGMA integrity_check\` ← ثم شغّل البوت وتحقّق بـ \`/system-status\``,
            COLORS[label.color] || COLORS.info).setFooter({ text: `آخر فحص: ${clock.nowIso()} بتوقيت UTC` })],
        });
      },
    },
    {
      data: new SlashCommandBuilder().setName('maintenance').setDescription('صيانة البيانات: تقليم النشاط والسجلات القديمة (مع معاينة)')
        .addBooleanOption(o => o.setName('dry_run').setDescription('عرض ما سيُحذف دون تنفيذ (الافتراضي: نعم)'))
        .addBooleanOption(o => o.setName('confirm').setDescription('تأكيد التنفيذ الفعلي')),
      level: LEVELS.BOSS,
      serverManagerOnly: true,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const dryRun = !(i.options.getBoolean('confirm') || false);
        const r = retention.run({ dryRun });
        // الصياغة العربية للعدد: سجل واحد / سجلان / N سجلات / N سجلاً — والصفر
        // يعود «0 سجل» لا «0 سجلاً». الرقم يظهر داخل الكلمة نفسها فلا تكرار.
        const recordsWord = n => (n === 0 ? '0 سجل' : kit.plural(n, 'سجل واحد', 'سجلان', '{n} سجلات', '{n} سجلاً'));
        if (dryRun) {
          return i.editReply({
            embeds: [embed('🧪 معاينة صيانة البيانات', `${divider}\n`
              + `📦 **الرسائل الخام أقدم من ${r.activity.cutoff}:** سيُحذف **${recordsWord(r.activity.pending)}** من النشاط — بلا تجميع يحفظها\n`
              + `📝 **سجل العمليات أقدم من ${r.audit.cutoff.slice(0, 7)}:** ${r.audit.pending} سجل\n`
              + `🗄️ **حجم القاعدة:** ${r.sizeBeforeMb} م.ب\n\n`
              + '⚠️ الحذف غير قابل للتراجع: ما تجاوز الحدّ لن يبقى في أي جدول ولا في تقرير شهري — التجميع الشهري أُلغي.\n'
              + 'لم يُحذف أي شيء. للتنفيذ: أعد الأمر مع `confirm: true`.', COLORS.info)],
          });
        }
        audit.record({ action: 'data_maintenance', actorId: i.user.id, details: r, channelId: i.channelId });
        return i.editReply({
          embeds: [embed('🧹 تمت صيانة البيانات', `${divider}\n`
            + `🗑️ حُذف **${recordsWord(r.activity.deleted)}** نشاط خام أقدم من **${r.activity.cutoff}** — بلا تجميع يحفظها\n`
            + `🗑️ حُذف **${r.audit.deleted}** سجل عمليات\n`
            + `🗄️ الحجم: ${r.sizeBeforeMb} → **${r.sizeAfterMb}** م.ب${r.vacuumed ? ' (استُرجعت المساحة)' : ''}`, COLORS.success)],
        });
      },
    },
  ],
  components: {},
};
