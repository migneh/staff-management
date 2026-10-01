'use strict';
const forms = require('../ui/forms');
const { homeRow } = require('../ui/navigation');
const { SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { LEVELS, TEAMS, STATUS, WARNING_TYPES } = require('../constants');
const reports = require('../services/reports');
const load = require('../services/load');
const staffService = require('../services/staff');
const taskService = require('../services/tasks');
const settings = require('../services/settings');
const audit = require('../services/audit');
const { getDb } = require('../database');
const { embed, COLORS, replyEphemeral, progressBar, divider, nowIso } = require('../utils');
const kit = require('../ui/kit');

/** النافذة الموحّدة للترتيب — أسبوعان أعدل من 7 أيام في الفرق الصغيرة */
const LEADERBOARD_WINDOW_DAYS = 14;

function teamEmbed(teamKey, rows) {
  const workMap = rows.map(r => {
    const count = r.work.closed ?? r.work.actions ?? 0;
    const detail = r.staff.team === 'support'
      ? `${count} تكت مغلق • متوسط ${r.work.avgDuration ?? '—'} د • ${r.work.avgRating ?? '—'} ⭐`
      : `${count} إجراء • ${r.work.activeDays} أيام عمل`;
    return { user: r.staff.user_id, rank: r.staff.rank, status: r.staff.status, work: count, detail };
  });
  const avg = rows.length ? Math.round(rows.reduce((s, r) => s + r.work.closed + r.work.actions, 0) / rows.length) : 0;
  const e = embed(`👥 تقرير ${TEAMS[teamKey]}`, `الأعضاء: **${rows.length}** • متوسط العمل: **${avg}**`, COLORS.info);
  const lines = workMap.sort((a, b) => b.work - a.work).map(r => `<@${r.user}> • ${r.rank} • **${r.work}** • ${STATUS[r.status]}${r.status !== 'on_leave' && r.status !== 'resigned' && r.status !== 'removed' && r.status !== 'suspended' && hoursSinceFromMember(r) > 72 ? ' ⚠️' : ''}`);
  for (let k = 0; k < lines.length; k += 15) e.addFields({ name: k === 0 ? 'الأعضاء' : '\u200b', value: lines.slice(k, k + 15).join('\n') });
  return e;
}

function hoursSinceFromMember(r) {
  return 0;
}

/** قراءة رقم من سجل قد يعود نصاً أو null (SQLite REAL/INTEGER) */
const num = value => Number(value) || 0;

/** لون النتيجة: نفس منطق لوحة «/me» بلا الاعتماد على أي وحدة خارجية */
function scoreColor(score) {
  if (score >= 80) return COLORS.success;
  if (score >= 60) return COLORS.info;
  if (score >= 40) return COLORS.warning;
  return COLORS.danger;
}

/** ميداليات بدل أرقام: التمييز البصري في جدول الترتيب مقصود */
const MEDALS = ['🥇', '🥈', '🥉'];

/** الحد الأعلى لطول الرسالة كاملة في ديسكورد — نُبقي عليه هامش للعنوان والتذييل */
const EMBED_TOTAL_LIMIT = 6000;

/**
 * حقول متتابعة: يقسّم الأسطر على حد ديسكورد للحقل (1024 حرفاً) وعلى حد 25 حقلاً،
 * ويستخدم محرف المسافة الصفرية كاسم للحقول التكميلية حتى لا يفسد تنسيق الشبكة.
 * يوقف الإضافة عند بلوغ حد 6000 حرف للرسالة كاملة حتى لا يُرفض الرد بالكامل.
 */
function addLineFields(e, name, lines, { inline = false, max = 25, budget = EMBED_TOTAL_LIMIT - 1200 } = {}) {
  const blocks = kit.chunkLines(lines, 1000);
  if (!blocks.length) return 0;
  let label = name;
  let used = 0;
  let added = 0;
  for (const block of blocks) {
    if (added >= max) break;
    const spent = used + block.length + 260;
    if (added > 0 && spent > budget) break;
    e.addFields({ name: label, value: kit.clip(block, 1024), inline });
    used = spent;
    added += 1;
    label = '\u200b';
  }
  return added;
}

/** سطر «متوسط المدة / التقييم» لفريق الدعم — الحقول نفسها في تقرير الفريق */
function supportDetailLine(raw) {
  return `${num(raw.tickets)} تكت • متوسط ${raw.avgDuration ?? '—'} د • ${raw.avgRating ?? '—'} ⭐\nمعاد فتح: **${num(raw.reopened)}** • تقييمات: **${num(raw.ratingCount)}**`;
}

/** تفصيل عوامل Score كما يحسبها reports.individual — شكل العنصر: { name, pts, max, detail, assessed } */
function factorLines(factors) {
  return (Array.isArray(factors) ? factors : []).map(f => {
    const icon = f.assessed === false ? '⏳' : '✅';
    const detail = f.detail ? ` — ${f.detail}` : '';
    return `${icon} **${f.name ?? '—'}**: ${num(f.pts)}/${num(f.max)}${detail}`;
  });
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
  const score = num(data?.score);
  const isSupport = staff.team === 'support';
  const work = isSupport ? `${num(raw.tickets)} تكت` : `${num(raw.actions)} إجراء`;
  const e = embed(
    `📊 تقرير أداء — ${staff.username ? `**${staff.username}**` : `<@${staff.user_id}>`}`,
    `**${staff.rank || '—'}** • ${TEAMS[staff.team] || '—'} • ${STATUS[staff.status] || staff.status || '—'}\n`
    + `بالرتبة ${kit.tsRelative(staff.rank_since)} • آخر نشاط ${kit.tsRelative(staff.last_activity)}\n`
    + `النافذة: ${kit.daysWord(days)} • ${work} • أيام نشطة: **${num(raw.activeDays)}**`,
    scoreColor(score),
  );

  e.addFields(
    { name: '🎯 درجة الأداء (Score)', value: `**${score}/100** • ${data?.grade || '—'}\n${progressBar(score, 100, 10)}`, inline: true },
    { name: '📅 الحضور', value: `غياب **${num(data?.absentDays)}** يوم\nإجازات **${num(raw.leaveDays)}** يوم`, inline: true },
  );

  if (isSupport) e.addFields({ name: '🎫 تفاصيل التذاكر', value: kit.clip(supportDetailLine(raw), 1024), inline: false });

  const warns = warningLines(data?.warnings);
  e.addFields({ name: '⚠️ الإنذارات', value: kit.clip(warns.length ? warns.join('\n') : 'لا توجد إنذارات مسجّلة في هذه النافذة.', 1024), inline: false });

  const factors = factorLines(data?.factors);
  if (factors.length) {
    e.addFields({ name: '📈 تفصيل Score', value: kit.clip(`المعتمد من الحد الأقصى: **${num(data?.assessedMax)}** نقطة`, 1024), inline: false });
    addLineFields(e, '\u200b', factors, { max: 18 });
  }

  e.setFooter({ text: kit.footerLine('التقرير محسوب على النشاط المسجّل في قاعدة البيانات') });
  return e;
}

/**
 * ترتيب فريق — صف واحد لكل إداري، وقائمة «غير مصنّفين» لمن لم يبلغ حد المشاركة
 * حتى لا ينافس على الميداليات من لم يعمل فعلاً (انظر reports.leaderboard).
 */
function leaderboardEmbed(rows, title, days = LEADERBOARD_WINDOW_DAYS) {
  const list = Array.isArray(rows) ? rows : [];
  const unranked = Array.isArray(rows?.unranked) ? rows.unranked : [];
  const e = embed(title || '🏆 الترتيب', `النافذة: ${kit.daysWord(days)} • **${list.length}** إدارياً مصنّفاً`, COLORS.primary);

  if (!list.length) {
    e.addFields({ name: 'النتيجة', value: 'لا يوجد أعضاء مصنّفون في هذه النافذة بعد. النافذة الأطول تعطي صورة أدق — راجع الترتيب بعد أسبوع عمل.' });
  } else {
    const lines = list.map((r, index) => {
      const medal = MEDALS[index] || `${index + 1}.`;
      const primary = r.staff.team === 'support' ? `${num(r.primary ?? r.raw?.tickets)} تكت` : `${num(r.primary ?? r.raw?.actions)} إجراء`;
      return `${medal} <@${r.staff.user_id}> • **${num(r.score)}** • ${primary} • ${num(r.raw?.activeDays)} يوم نشط`;
    });
    addLineFields(e, 'الترتيب', lines, { max: 20 });
  }

  if (unranked.length) {
    const idle = unranked.map((r, index) => `${index + 1}. <@${r.staff.user_id}> • ${num(r.raw?.activeDays)} يوم نشط • Score ${num(r.score)}`);
    e.addFields({ name: '🧪 غير مصنّفين', value: kit.clip(`لم يبلغوا حد المشاركة، ويظهرون للعلم دون منافسة:\n${idle.join('\n')}`, 1024), inline: false });
  }

  e.setFooter({ text: kit.footerLine('الترتيب على درجة Score — النافذة موحّدة لكل الفرق') });
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

/** أسماء أوزان كل فريق — مطابقة تماماً لمفاتيح SCORE_WEIGHTS ومفتاح النموذج `score:weightsmodal` */
const WEIGHT_FIELDS = {
  helper: [
    { id: 'chat', label: 'الدردشة', hint: 'وزن نشاط الدردشة في القنوات.' },
    { id: 'presence', label: 'الحضور', hint: 'وزن تسجيل الحضور والانضباط اليومي.' },
    { id: 'teamInteraction', label: 'التفاعل مع الفريق', hint: 'وزن التعاون مع بقية الإداريين.' },
    { id: 'supervisorRating', label: 'تقييم المشرف', hint: 'وزن التقييم اليدوي من المشرف.' },
  ],
  support: [
    { id: 'tickets', label: 'التكتات', hint: 'وزن عدد التكتات المغلقة.' },
    { id: 'speed', label: 'سرعة الاستجابة', hint: 'وزن متوسط زمن إغلاق التكت.' },
    { id: 'chat', label: 'الدردشة', hint: 'وزن نشاط الدردشة مع الأعضاء.' },
    { id: 'presence', label: 'الحضور', hint: 'وزن تسجيل الحضور اليومي.' },
  ],
  moderation: [
    { id: 'actions', label: 'الإجراءات', hint: 'وزن عدد إجراءات الإشراف.' },
    { id: 'speed', label: 'سرعة الاستجابة', hint: 'وزن سرعة التعامل مع المخالفات.' },
    { id: 'activity', label: 'النشاط', hint: 'وزن تغطية الأيام النشطة.' },
    { id: 'commitment', label: 'الالتزام', hint: 'وزن الالتزام بالورديات والقوانين.' },
  ],
};

// `modals` يحوي بناة المواصفات التي تُمرَّر إلى forms.open فقط.
// دوال البطاقات (performanceEmbed وغيرها) ليست مواصفات نماذج، وتصدَّر منفصلة
// في module.exports — وجودها هنا يجعل اختبار المواصفات يتعامل معها كنموذج.
const modals = {
  /** نموذج تعيين أوزان Score — القيم الافتراضية تأتي من الأوزان المحفوظة حالياً */
  weights: ({ team, current = {} } = {}) => {
    // فريق غير معروف خطأ برمجي لا مُدخل مستخدم: يُرمى بدل بناء نموذج بلا حقول.
    const defs = WEIGHT_FIELDS[team];
    if (!defs) throw new Error(`فريق غير معروف لنموذج الأوزان: ${team}`);
    return {
      id: `score:weightsmodal:${team}`,
      title: `⚖️ أوزان Score — ${TEAMS[team] || team}`,
      fields: defs.map(f => forms.field({
        id: f.id, label: f.label, max: 3, value: num(current[f.id]) || 0,
        description: `${f.hint} رقم بين 0 و100، ومجموع الأوزان يجب أن يساوي 100.`,
      })),
      note: 'المجموع يجب أن يساوي 100 بالضبط، وإلا تُرفض الأوزان ولا يتغيّر شيء.',
    };
  },
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
        await i.deferReply({ ephemeral: true });
        const team = i.options.getString('team');
        const teams = team ? [team] : ['support', 'moderation'];
        return i.editReply({ embeds: teams.map(t => teamEmbed(t, reports.team(t))) });
},
     },
     {
       data: new SlashCommandBuilder().setName('leaderboard').setDescription('ترتيب الإداريين (للإدارة فقط)')
         .addStringOption(o => o.setName('team').setDescription('الفريق').addChoices({ name: 'فريق الدعم الفني', value: 'support' }, { name: 'فريق الإشراف', value: 'moderation' }, { name: 'عام', value: 'all' })),
       level: LEVELS.SUPERVISOR,
       async execute(i) {
         await i.deferReply({ ephemeral: true });
         const team = i.options.getString('team') || 'all';
         if (team === 'all') return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard('support', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الدعم الفني'), leaderboardEmbed(reports.leaderboard('moderation', LEADERBOARD_WINDOW_DAYS), '🏆 ترتيب فريق الإشراف')] });
         return i.editReply({ embeds: [leaderboardEmbed(reports.leaderboard(team, LEADERBOARD_WINDOW_DAYS), `🏆 ترتيب ${TEAMS[team]}`)] });
       },
     },
      {
        data: new SlashCommandBuilder().setName('score-weights')
          .setDescription('عرض أو تعديل أوزان حساب Score')
          .addStringOption(o => o.setName('action').setDescription('الإجراء').setRequired(true)
            .addChoices(
              { name: 'عرض الأوزان الحالية', value: 'view' },
              { name: 'تعيين أوزان فريق', value: 'set' }
            ))
          .addStringOption(o => o.setName('team').setDescription('الفريق (required for set action)')
            .addChoices(
              { name: 'Helper', value: 'helper' },
              { name: 'Support', value: 'support' },
              { name: 'الإشراف', value: 'moderation' }
            ))
        , level: LEVELS.BOSS,
        async execute(i) {
          const action = i.options.getString('action');
          if (action === 'view') {
            const supportWeights = settings.scoreWeights('support');
            const moderationWeights = settings.scoreWeights('moderation');
            const helperWeights = settings.scoreWeights('helper');
            const e = kit.card({
              title: '⚖️ أوزان حساب Score الحالية',
              fields: [
                { name: '🎫 فريق الدعم', value: Object.entries(supportWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
                { name: '🛡️ فريق الإشراف', value: Object.entries(moderationWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
                { name: '🎯 فريق المساعد', value: Object.entries(helperWeights).map(([k, v]) => `${k}: ${v}`).join('\n') },
              ],
              color: COLORS.info,
              footer: kit.footerLine('استخدم `/score-weights set <الفريق>` لتعديل الأوزان عبر النموذج')
            });
            return i.reply({ embeds: [e], ephemeral: true });
          }
          if (action === 'set') {
            const team = i.options.getString('team');
            const current = settings.scoreWeights(team);
            return forms.open(i, modals.weights({ team, current }));
          }
          return replyEphemeral(i, '❌ إجراء غير صالح', COLORS.danger);
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
    {
      data: new SlashCommandBuilder().setName('rate-staff').setDescription('تقييم يدوي لإداري (يدخل في حساب Score)')
        .addUserOption(o => o.setName('user').setDescription('الإداري').setRequired(true))
        .addStringOption(o => o.setName('factor').setDescription('العامل').setRequired(true).addChoices(
          { name: 'تقييم المشرف (Helper)', value: 'supervisor_rating' }, { name: 'التفاعل مع الفريق (Helper)', value: 'team_interaction' }, { name: 'سرعة الاستجابة (الإشراف)', value: 'response_speed' }))
        .addStringOption(o => o.setName('grade').setDescription('التقدير').setRequired(true).addChoices(
          { name: 'ممتاز (25)', value: '25' }, { name: 'جيد جداً (20)', value: '20' }, { name: 'جيد (15)', value: '15' }, { name: 'مقبول (10)', value: '10' }, { name: 'ضعيف (5)', value: '5' })),
      level: LEVELS.SUPERVISOR,
      async execute(i) {
        const user = i.options.getUser('user');
        const s = staffService.get(user.id);
        if (!s) return replyEphemeral(i, '❌ هذا العضو غير مسجل كإداري.', COLORS.danger);
        // هذا التقييم يدخل مباشرة في حساب Score — لا يمكن للمشرف تقييم نفسه لرفع رصيده.
        if (user.id === i.user.id) return replyEphemeral(i, '❌ لا يمكنك تقييم نفسك.', COLORS.danger);
        const factor = i.options.getString('factor');
        // دفاع إضافي: factor يُستخدم كاسم عمود في تحديث SQL ديناميكي — يُقيَّد بقائمة صريحة
        // حتى مع ضمان Discord لقيم addChoices، لمنع أي حقن لو تغيّر مصدر القيمة مستقبلاً.
        if (!['supervisor_rating', 'team_interaction', 'response_speed'].includes(factor)) {
          return replyEphemeral(i, '❌ عامل تقييم غير صحيح.', COLORS.danger);
        }
        staffService.update(user.id, { [factor]: Number(i.options.getString('grade')), human_ratings_at: nowIso() });
        return replyEphemeral(i, `✅ تم تحديث التقييم لـ <@${user.id}>.`, COLORS.success);
      },
},
   ],
   components: {
    'score:weightsmodal': async (i, [team]) => {
      const keys = { helper: ['chat', 'presence', 'teamInteraction', 'supervisorRating'], support: ['tickets', 'speed', 'chat', 'presence'], moderation: ['actions', 'speed', 'activity', 'commitment'] }[team];
      if (!keys) return replyEphemeral(i, '❌ الفئة غير صحيحة.', COLORS.danger);
      const values = Object.fromEntries(keys.map(key => [key, Number(i.fields.getTextInputValue(key))]));
      if (Object.values(values).some(v => !Number.isInteger(v) || v < 0 || v > 100) || Object.values(values).reduce((sum, v) => sum + v, 0) !== 100) {
        return replyEphemeral(i, '❌ يجب أن تكون كل الأوزان أرقاماً بين 0 و100 ومجموعها يساوي 100.', COLORS.danger);
      }
settings.setScoreWeights(team, values);
       audit.record({ action: 'score_weights_updated', actorId: i.user.id, details: { team, values }, channelId: i.channelId });
       return replyEphemeral(i, `✅ تم حفظ أوزان **${team}**. سيظهر أثرها في التقارير الجديدة فوراً.`, COLORS.success);
},
   },
   performanceEmbed, leaderboardEmbed, teamEmbed, loadEmbed, LEADERBOARD_WINDOW_DAYS,
};
