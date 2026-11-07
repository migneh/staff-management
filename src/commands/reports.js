'use strict';
const { homeRow } = require('../ui/navigation');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS, WARNING_TYPES } = require('../constants');
const reports = require('../services/reports');
const load = require('../services/load');
const staffService = require('../services/staff');
const taskService = require('../services/tasks');
const points = require('../services/points');
const { getDb } = require('../database');
const promotionRules = require('../services/promotionRules');
const { embed, COLORS, replyEphemeral, progressBar } = require('../utils');
const kit = require('../ui/kit');

/** النافذة الموحّدة للترتيب — أسبوعان أعدل من 7 أيام في الفرق الصغيرة */
const LEADERBOARD_WINDOW_DAYS = 14;

/** الحالات التي لا يُنبَّه فيها على الخمول — العضو غير موجود أصلاً في القائمة */
const ABSENT_OK_STATUSES = ['on_leave', 'resigned', 'removed', 'suspended'];

/** تنبيه الخمول: بلا عمل مُسجّل منذ ثلاثة أيام */
const IDLE_WARNING_HOURS = 72;

/**
 * تقرير فريق — صف واحد لكل إداري.
 *
 * عقد الصفوف هو عقد reports.individual: { staff, raw, ... } وليس { staff, work }
 * (هذا شكل load.teamLoad). كان الكود يقرأ r.work فسقط على أول صف بـ TypeError
 * لكل حجم فريق مهما صغر. والبناء يمرّ عبر addLineFields لا عبر addFields مباشرة،
 * لأن ديسكورد يرفض ما زاد على 25 حقلاً أو 6000 حرف — وكان الفريق بـ 376 عضواً
 * يُسقط الرد كاملاً. من لا يتّسع حقاً يُعلن في حقل مستقل بدل إخفائه صامتاً.
 */
function teamEmbed(teamKey, rows) {
  const list = Array.isArray(rows) ? rows : [];
  const workMap = list.map(r => {
    const staff = r?.staff || {};
    const raw = r?.raw || {};
    // الدعم يُقاس بالتكتات المغلقة، والإشراف بالإجراءات — لا بخلط الحقلين.
    const count = staff.team === 'support' ? num(raw.tickets) : num(raw.actions);
    return {
      user: staff.user_id, rank: staff.rank, status: staff.status, work: count,
      idleHours: num(r?.lastActivityHours),
    };
  });
  const avg = workMap.length ? Math.round(workMap.reduce((s, r) => s + r.work, 0) / workMap.length) : 0;
  const e = embed(`👥 تقرير ${TEAMS[teamKey] || teamKey}`, `الأعضاء: **${list.length}** • متوسط العمل: **${avg}**`, COLORS.info);
  const lines = workMap
    .sort((a, b) => b.work - a.work)
    .map(r => `<@${r.user}> • ${r.rank || '—'} • **${r.work}** • ${STATUS[r.status] || r.status || '—'}`
      + (!ABSENT_OK_STATUSES.includes(r.status) && r.idleHours > IDLE_WARNING_HOURS ? ' ⚠️' : ''));

  // 22 حقلاً + حقل الإخفاء = 24، فتبقى حاشية تحت حد الـ 25 حتى لو أُضيف حقل لاحقاً.
  const { lines: shown } = addLineFields(e, 'الأعضاء', lines, { max: 22, budget: EMBED_TOTAL_LIMIT - 400 });
  const omitted = lines.length - shown;
  if (omitted > 0) {
    e.addFields({
      name: '⚠️ أعضاء لم يظهروا',
      value: `لم يظهر **${omitted}** عضواً من أصل **${lines.length}** — حد ديسكورد 25 حقلاً و6000 حرف للرسالة الواحدة.`,
      inline: false,
    });
  }
  return e;
}

/** قراءة رقم من سجل قد يعود نصاً أو null (SQLite REAL/INTEGER) */
const num = value => Number(value) || 0;

/** ميداليات بدل أرقام: التمييز البصري في جدول الترتيب مقصود */
const MEDALS = ['🥇', '🥈', '🥉'];

/** الحد الأعلى لطول الرسالة كاملة في ديسكورد — نُبقي عليه هامش للعنوان والتذييل */
const EMBED_TOTAL_LIMIT = 6000;

/**
 * حقول متتابعة: يقسّم الأسطر على حد ديسكورد للحقل (1024 حرفاً) وعلى حد 25 حقلاً،
 * ويستخدم محرف المسافة الصفرية كاسم للحقول التكميلية حتى لا يفسد تنسيق الشبكة.
 * يوقف الإضافة عند بلوغ حد 6000 حرف للرسالة كاملة حتى لا يُرفض الرد بالكامل.
 * يُرجع { fields, lines }: عدد الحقول المضافة وعدد **الأسطر** التي ظهرت فعلاً،
 * ليمكن للمُنشئ أن يصرّح بما سقط بدل إنكاره.
 */
function addLineFields(e, name, lines, { inline = false, max = 25, budget = EMBED_TOTAL_LIMIT - 1200 } = {}) {
  const blocks = kit.chunkLines(lines, 1000);
  if (!blocks.length) return { fields: 0, lines: 0 };
  let label = name;
  let used = 0;
  let added = 0;
  let rendered = 0;
  for (const block of blocks) {
    if (added >= max) break;
    const spent = used + block.length + 260;
    if (added > 0 && spent > budget) break;
    e.addFields({ name: label, value: kit.clip(block, 1024), inline });
    rendered += block.split('\n').length;
    used = spent;
    added += 1;
    label = '\u200b';
  }
  return { fields: added, lines: rendered };
}

/** سطر «متوسط المدة / التقييم» لفريق الدعم — الحقول نفسها في تقرير الفريق */
function supportDetailLine(raw) {
  return `${num(raw.tickets)} تكت • متوسط ${raw.avgDuration ?? '—'} د • ${raw.avgRating ?? '—'} ⭐\nمعاد فتح: **${num(raw.reopened)}** • تقييمات: **${num(raw.ratingCount)}**`;
}

/** أسطر الإنذارات المسجّلة — كل عنصر { warning_type, c } يُترجم من WARNING_TYPES */
function warningLines(warnings) {
  return (Array.isArray(warnings) ? warnings : []).map(w => {
    const type = WARNING_TYPES[w.warning_type];
    return `${type ? type.emoji : '⚠️'} ${type ? type.label : w.warning_type} × ${num(w.c)}`;
  });
}

/**
 * تقرير أداء فردي — بطاقة واحدة تُبنى لكل عضو.
 * scheduler.js يرسل واحدة بالخاص لكل إداري، فلا يجوز أن تضم أكثر من شخص.
 */
function performanceEmbed(data, days = 30) {
  const staff = data?.staff || {};
  const raw = data?.raw || {};
  const isSupport = staff.team === 'support';
  const work = isSupport ? `${num(raw.tickets)} تكت` : `${num(raw.actions)} إجراء`;

  // Weekly reports supply the balance from their batch query; other callers read it directly.
  const totalPoints = data?.points ?? points.getBalance(staff.user_id);
  const currentRank = staff.rank;
  const pointsThreshold = promotionRules.ruleFor(staff.team, staff.rank)?.pointsThreshold || 0;

  // Color based on points progress toward next threshold
  const progressPercent = pointsThreshold > 0 ? Math.min(100, Math.round((totalPoints / pointsThreshold) * 100)) : 0;
  const color = progressPercent >= 100 ? COLORS.success : progressPercent >= 75 ? COLORS.info : progressPercent >= 50 ? COLORS.warning : COLORS.danger;

  const e = embed(
    `📊 تقرير أداء — ${staff.username ? `**${staff.username}**` : `<@${staff.user_id}>`}`,
    `**${staff.rank || '—'}** • ${TEAMS[staff.team] || '—'} • ${STATUS[staff.status] || staff.status || '—'}\n`
    + `بالرتبة ${kit.tsRelative(staff.rank_since)} • آخر نشاط ${kit.tsRelative(staff.last_activity)}\n`
    + `النافذة: ${kit.daysWord(days)} • ${work} • أيام نشطة: **${num(raw.activeDays)}**`,
    color,
  );

  e.addFields(
    { name: '💯 نقاط الترقية', value: `**${num(totalPoints)}** / ${num(pointsThreshold) || '—'}\n${progressBar(progressPercent, 100, 10)}`, inline: true },
    { name: '📅 الحضور', value: `غياب **${num(data?.absentDays)}** يوم\nإجازات **${num(raw.leaveDays)}** يوم`, inline: true },
  );

  if (isSupport) e.addFields({ name: '🎫 تفاصيل التذاكر', value: kit.clip(supportDetailLine(raw), 1024), inline: false });

  const warns = warningLines(data?.warnings);
  e.addFields({ name: '⚠️ الإنذارات', value: kit.clip(warns.length ? warns.join('\n') : 'لا توجد إنذارات مسجّلة في هذه النافذة.', 1024), inline: false });

    // addLineFields(e, '\u200b', factors, { max: 18 });
  // }

  // Show promotion requirements instead of the retired composite performance factors
  if (data?.staff && !data.skipPromotionEvaluation) {
    const promo = require('../services/promotions');
    const promoEval = promo.evaluate(data.staff);
    if (promoEval.checks.length > 0) {
      const reqLines = promoEval.checks.map(c => {
        const icon = c.pass ? '✅' : '❌';
        return `${icon} **${c.label}**: ${c.actual} / ${c.required}`;
      }).join('\n');
      e.addFields({ name: '📈 متطلبات الترقية', value: kit.clip(reqLines, 1024), inline: false });
    }
  }

  e.setFooter({ text: kit.footerLine('التقرير محسوب على النشاط المسجّل في قاعدة البيانات') });
  return e;
}

/**
 * ترتيب فريق بالنقاط — صف واحد لكل إداري في العصر الحالي.
 * يعرض: النقاط الإجمالية، الرتبة، الحالة، وعلامة التجميد.
 */
function leaderboardEmbed(rows, title, days = LEADERBOARD_WINDOW_DAYS) {
  const list = Array.isArray(rows) ? rows : [];
  const e = embed(title || '🏆 الترتيب', `النافذة: ${kit.daysWord(days)} • **${list.length}** إدارياً في العصر الحالي`, COLORS.primary);

  if (!list.length) {
    e.addFields({ name: 'النتيجة', value: 'لا يوجد أعضاء بنقاط في هذه الحقبة بعد.' });
  } else {
    const lines = list.map((r, index) => {
      const medal = MEDALS[index] || `${index + 1}.`;
      const frozenMark = r.frozen ? ' ❄️' : '';
      return `${medal} <@${r.user_id}> • **${num(r.total)}** pts • ${r.rank || '—'} • ${TEAMS[r.team] || r.team || '—'}${frozenMark}`;
    });
    addLineFields(e, 'الترتيب', lines, { max: 20 });
  }

  e.setFooter({ text: kit.footerLine('الترتيب على نقاط الترقية (الحقبة الحالية)') });
  return e;
}

/** توزيع حمل الفريق + مؤشر العدالة — بلا خصم أو عقوبة، تنبيه إداري فقط */
function loadEmbed(teamKey, rows, days = 7) {
  const list = Array.isArray(rows) ? rows : [];
  const fair = load.fairness(list);
  const isSupport = teamKey === 'support';
  const unit = isSupport ? 'تكت' : 'إجراء';
  const count = r => r.work.closed ?? r.work.actions ?? 0;
  const peak = Math.max(...list.map(count), 0);
  const e = embed(
    `⚖️ توزيع الحمل — ${TEAMS[teamKey] || '—'}`,
    `النافذة: ${kit.daysWord(days)} • **${list.length}** إدارياً • الإجمالي **${fair.total}** ${unit} • المتوسط **${fair.average}**`,
    fair.imbalance >= 2 ? COLORS.warning : COLORS.info,
  );

  const topRow = list.find(r => r.staff.user_id === fair.busiest);
  const topCount = topRow ? num(count(topRow)) : 0;
  e.addFields(
    {
      name: '👤 الأعلى حملاً',
      value: topRow ? `<@${fair.busiest}> • **${topCount}** ${unit}\n${progressBar(topCount, peak, 10)}` : 'لا يوجد عمل مسجّل.',
      inline: true,
    },
    {
      name: '⚖️ مؤشر العدالة',
      value: fair.total ? `أعلى عضو = **${fair.imbalance}**× المتوسط\nرقم 1 يعني توزيعاً متساوياً.` : 'لا توجد بيانات كافية لقياس العدالة.',
      inline: true,
    },
  );

  if (fair.idle.length) {
    const idle = fair.idle.slice(0, 20).map(id => `<@${id}>`).join(' • ');
    e.addFields({ name: '😴 بلا عمل مسجّل', value: kit.clip(`${fair.idle.length} إداري بلا عمل في النافذة:\n${idle}`, 1024), inline: false });
  }

  const lines = list.map((r, index) => {
    const c = count(r);
    const detail = isSupport
      ? `متوسط ${r.work.avgDuration ?? '—'} د • ${r.work.avgRating ?? '—'} ⭐`
      : `${num(r.work.activeDays)} أيام عمل`;
    return `${index + 1}. <@${r.staff.user_id}> • ${r.staff.rank || '—'} • **${c}** ${unit} • ${detail}`;
  });
  addLineFields(e, '📋 التوزيع', lines, { max: 20 });

  e.setFooter({ text: kit.footerLine('توزيع العمل المسجّل — مؤشر للعدالة، بلا خصم تلقائي') });
  return e;
}

function reportsCsv(rows) {
  const cell = value => `"${String(value ?? '').replace(/"/g, '""')}"`;
  return `\ufeff${['id', 'report_type', 'period', 'created_at', 'data'].map(cell).join(',')}\n${rows.map(r => [r.id, r.report_type, r.period, r.created_at, r.data].map(cell).join(',')).join('\n')}\n`;
}

// `modals` يحوي بناة المواصفات التي تُمرَّر إلى forms.open فقط.
// دوال البطاقات (performanceEmbed وغيرها) ليست مواصفات نماذج، وتصدَّر منفصلة
// في module.exports — وجودها هنا يجعل اختبار المواصفات يتعامل معها كنموذج.
const modals = {
};

module.exports = {
  modals,
  commands: [
    {
      data: new SlashCommandBuilder().setName('my-performance').setDescription('عرض تقرير أدائك الشخصي'),
      level: LEVELS.STAFF,
      async execute(i) {
        const s = staffService.get(i.user.id);
        if (!s) return replyEphemeral(i, '❌ غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], components: [homeRow()], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('staff-report').setDescription('عرض تقرير أداء إداري معين')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const s = staffService.get(i.options.getUser('user').id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        return i.reply({ embeds: [performanceEmbed(reports.individual(s))], ephemeral: true });
      },
    },
    {
      data: new SlashCommandBuilder().setName('team-report').setDescription('تقرير الفريق')
        .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        // deferReply يؤجّل **الردّ** لا **تنفيذ الكود** — reports.team متزامن
        // وبلا await، فيبقى حلقة الأحداث محجوبة أثناء بناء كل فريق. نبضة
        // واحدة بين الفريقين تمنح البوابة فرصة لتلتقط حدثاً آخر.
        const yieldTick = () => new Promise(resolve => { setTimeout(resolve, 0); });
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team');
        const teams = team ? [team] : ['support', 'moderation'];
        const embeds = [];
        for (const t of teams) {
          // reports.team يقرأ المواد الخام مرة واحدة لكل فريق (7 عبارات بدل 7N).
          embeds.push(teamEmbed(t, reports.team(t)));
          await yieldTick();
        }
        return i.editReply({ embeds });
      },
     },
     {
       data: new SlashCommandBuilder().setName('leaderboard').setDescription('ترتيب الإداريين (للإدارة فقط)')
         .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' }, { name: 'عام', value: 'all' })),
       level: LEVELS.SUPERVISOR,
        async execute(i) {
          // deferReply يؤجّل **الردّ** لا **تنفيذ الكود**: البناء كله متزامن بلا
          // await، فيبقى حلقة الأحداث محجوبة طواله فلا تستقبل البوابة حدثاً آخر.
          // نمدّدها بأنفسنا بنبضة واحدة بعد بناء كل فريق.
          const yieldTick = () => new Promise(resolve => { setTimeout(resolve, 0); });
          await i.deferReply({ ephemeral: true });
          const team = i.options.getString('team') || 'all';
          if (team === 'all') {
            // points.leaderboard يقبل team filter، نستدعي لكل فريق
            const support = points.leaderboard({ team: 'support', limit: 20 });
            await yieldTick();
            const moderation = points.leaderboard({ team: 'moderation', limit: 20 });
            return i.editReply({ embeds: [
              leaderboardEmbed(support, '🏆 ترتيب فريق الدعم الفني'),
              leaderboardEmbed(moderation, '🏆 ترتيب فريق الإشراف'),
            ] });
          }
          const rows = points.leaderboard({ team, limit: 20 });
          await yieldTick();
          return i.editReply({ embeds: [leaderboardEmbed(rows, `🏆 ترتيب ${TEAMS[team]}`)] });
        },
     },
     {
       data: new SlashCommandBuilder().setName('team-load').setDescription('توزيع العمل المسجل ومؤشر العدالة للفريق')
         .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'الدعم الفني', value: 'support' }, { name: 'الإشراف', value: 'moderation' }))
         .addIntegerOption(o => o.setName('days').setDescription('النافذة بالأيام (1-90)').setMinValue(1).setMaxValue(90)),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team') || i.staffInfo?.team;
        if (!['support', 'moderation'].includes(team)) return i.editReply({ embeds: [embed('⚖️ توزيع الحمل', 'اختر فريقاً صالحاً.', COLORS.danger)] });
        const days = i.options.getInteger('days') || 7;
        return i.editReply({ embeds: [loadEmbed(team, load.teamLoad(team, days), days)] });
      },
    },
    {
      data: new SlashCommandBuilder().setName('report-export').setDescription('تصدير التقارير المحفوظة بصيغة CSV')
        .addStringOption(o => o.setName('type').setDescription('نوع التقرير').setRequired(true).addChoices({ name: 'يومي', value: 'daily' }, { name: 'أسبوعي', value: 'weekly' }, { name: 'شهري', value: 'monthly' }))
        .addStringOption(o => o.setName('period').setDescription('الفترة أو جزء منها — اختياري').setMaxLength(30)),
      level: LEVELS.GENERAL_MANAGER,
      serverManagerOnly: true,
      async execute(i) {
        const type = i.options.getString('type');
        const period = i.options.getString('period');
        const rows = getDb().prepare(`SELECT * FROM saved_reports WHERE report_type = ? ${period ? 'AND period LIKE ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(period ? [type, `%${period}%`] : [type]));
        if (!rows.length) return replyEphemeral(i, '❌ لا توجد تقارير محفوظة بهذا الفلتر.', COLORS.warning);
        const file = new AttachmentBuilder(Buffer.from(reportsCsv(rows), 'utf8'), { name: `staff-reports-${type}.csv` });
        return i.reply({ content: `📊 تم تصدير ${rows.length} تقريراً.`, files: [file], ephemeral: true });
      },
    },
   ],
   components: {
   },
   performanceEmbed, leaderboardEmbed, teamEmbed, loadEmbed, LEADERBOARD_WINDOW_DAYS,
};
