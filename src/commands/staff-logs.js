'use strict';
/**
 * ‎/staff-logs — سجل عمليات الفريق مع تصفية وترقيم صفحات حقيقي.
 *
 * كان معالج الترقيم `deferUpdate()` فقط بلا حلّ، فتدور القائمة حتى يموت رمز
 * التفاعل بعد 15 دقيقة ويظهر «This interaction failed». والقائمة كانت تعرض
 * صفحتين فقط (الأولى والأخيرة)، وقصّ 1024 حرفاً على النص كله فأسقط ~90 صفاً
 * من مئة مُجلب بينما العنوان يقول «آخر 100 سجلات».
 *
 * الحلّ يتبع نمط tasks.js وleaves.js: ‎kit.navRow‎ ومعالجٌ بلا حالة يُعيد اشتقاق
 * كل شيء من قاعدة البيانات عند كل ضغطة، والفلاتر تُحمل في معرّف المكوّن. لا
 * staleness ولا رمز معلّق.
 *
 * دُمج معه ‎/audit-log‎ و‎/audit-export‎ (كانا نفس الجدول ونفس الصلاحية في
 * ملفَّن مكرَّرين): بقي أمر واحد هو هذا، وسقف واحد ‎WINDOW‎ للعرض والتصدير
 * معاً، وزر «تصدير CSV» في صف التنقّل نفسه.
 */
const { SlashCommandBuilder, AttachmentBuilder, ButtonStyle } = require('discord.js');
const { LEVELS } = require('../constants');
const audit = require('../services/audit');
const staffService = require('../services/staff');
const settings = require('../services/settings');
const { COLORS, arDigits } = require('../utils');
const kit = require('../ui/kit');
const clock = require('../clock');

/**
 * السقف الوحيد لعدد الصفوف: النافذة المعروضة وتصدير CSV يستخدمان هذا الثابت
 * معاً — ثابت واحد لا يمكن أن يتباعد عن نفسه بعد الدمج (كان ‎/audit-log‎
 * بسقف 25 وطلب ‎/audit-export‎ بـ 1000 يقتطعه الخدمة إلى 100).
 * ‎audit.list‎ يحدّ الجلب عند 100 صف ولا يقبل OFFSET (انظر src/services/audit.js)،
 * فالنافذة القابلة للتصفح هي أحدث 100 سجل مطابق. نعلن ذلك صراحةً بدل أن نكتب
 * «من أصل 500» ونعرض مئة صامتة.
 */
const WINDOW = 100;
const DEFAULT_PAGE_SIZE = 10;
/**
 * أقصى عدد صفوف في الصفحة: 15 صفاً × ‎ROW_TOTAL_CLIP‎ (250) = 3750 حرفاً،
 * أي أربعة حقول على الأكثر — بهامش 2000 حرف تحت حد 6000. السقف منخفض عمداً:
 * أي رقم أكبر يُجبرنا على قصّ صفوف في منتصف الطريق، وهو العطل الذي أصلحناه.
 */
const MAX_PAGE_SIZE = 15;
/** أقصى طول لسطر السجل — التفاصيل الكاملة غير المقصوصة في تصدير CSV */
const ROW_DETAIL_CLIP = 140;
/** حارس إضافي: حقول السجلات لا تتجاوز هذا العدد ولا ميزانية الأحرف */
const ROW_FIELDS_MAX = 6;
const ROW_BUDGET = 5400;

const titleize = action => String(action || '').split('_')
  .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

/**
 * اسم الإجراء يدخل معرّف المكوّن المفتاح للترقيم، فلا يجوز أن يحمل «:» (يكسر
 * تفكيك المعرّف) أو محارف غريبة. يُنقّى مرة واحدة هنا فيُستعمل في الاستعلام
 * وفي المعرّف معاً، فتبقى الصفحة الثانية مطابقة للصفحة الأولى.
 */
function cleanAction(value) {
  return String(value ?? '').trim().replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 40);
}

/**
 * مُرشِّح المستخدم: لا يُوضع نص المستخدم في ‎<@...>‎ قبل أن يُطابق إدارياً
 * مُسجّلاً — المنشن الخام كان يجعل ‎<@some-name>‎ يظهر كحرفة في العنوان.
 */
function resolveTarget(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return { id: '', label: '', unknown: false };
  const cleaned = text.replace(/[<@>]/g, '');
  const byId = /^\d{15,22}$/.test(cleaned) ? staffService.get(cleaned) : null;
  if (byId?.user_id) return { id: String(byId.user_id), label: `<@${byId.user_id}>`, unknown: false };
  const q = text.toLowerCase();
  const match = staffService.all().find(m => String(m.username).toLowerCase() === q
    || String(m.user_id).toLowerCase() === q);
  if (match) return { id: String(match.user_id), label: `<@${match.user_id}>`, unknown: false };
  return { id: '', label: '', unknown: true };
}

/** حالة الصفحة — تُشتق بالكامل من خيارات الأمر أو من معرّف المكوّن */
function normalize({ page, size, days, action, targetId, detailed } = {}) {
  return {
    page: Math.max(1, Math.trunc(Number(page) || 1)),
    size: Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(Number(size) || DEFAULT_PAGE_SIZE))),
    days: Math.min(365, Math.max(0, Math.trunc(Number(days) || 0))),
    action: cleanAction(action),
    targetId: /^\d{15,22}$/.test(String(targetId || '')) ? String(targetId) : '',
    detailed: detailed === '1' || detailed === true,
  };
}

const sinceFor = days => (days ? clock.addDays(clock.today(), -days) : null);

/**
 * سطر سجل واحد. رأس السطر (المعرّف + الإجراء + الوقت + الطرفان) يُركّب كاملاً
 * ولا يُقصّ أبداً حتى لا ينقطع ‎<t:...>‎ أو منشن فينتهي كحرف عربي عادي؛
 * التفاصيل وحدها هي التي تُقتطع، وداخل كتلة JSON أو بعد تهريب الأقواس.
 */
function rowLine(log, detailed) {
  const actor = log.actor_id ? `<@${log.actor_id}>` : 'النظام';
  const target = log.target_id ? `<@${log.target_id}>` : '—';
  const head = `**#${log.id}** • ${titleize(log.action)}\n${clock.discordTs(log.created_at, 'R')} • بواسطة: ${actor} → ${target}`;
  if (!detailed || !log.details) return head;
  const parsed = audit.parseDetails(log.details);
  // JSON داخل كتلة كود: لا يُفسَّر كمنشن. النص الحر يُهرَّب أولاً ثم يُقتطع.
  const body = typeof parsed === 'string'
    ? parsed.replace(/</g, '(').replace(/>/g, ')')
    : `\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\``;
  return `${head}\n${kit.clip(body, ROW_DETAIL_CLIP)}`;
}

/** حقول السجلات على حدود الأسطر — لا تُقصّ إلا عند حد 1024 حرفاً للحقل */
function addLogFields(e, rows) {
  const blocks = kit.chunkLines(rows, 1000);
  let label = '📝 سجلات الصفحة';
  let used = 0;
  let added = 0;
  for (const block of blocks) {
    if (added >= ROW_FIELDS_MAX) break;
    const spent = used + block.length + 60;
    if (added > 0 && spent > ROW_BUDGET) break;
    e.addFields({ name: label, value: kit.clip(block, 1024), inline: false });
    used = spent;
    added += 1;
    label = '\u200b';
  }
  return added;
}

/**
 * خلية CSV واحدة: كل خلية بين اقتباسين، وشرط داخلها يُضاعف. الخلية التي
 * تبدأ بعلامة معادلة (= + - @) تسبق بعلامة اقتباس حتى لا تنفّذها Excel
 * كمعادلة عند فتح الملف.
 */
function csvCell(value) {
  let s = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * ملف CSV بنفس أعمدة مُصدِّر ‎/audit-export‎ القديم بعد دمجه هنا.
 * التفاصيل تمرّ عبر audit.parseDetails لا JSON.parse خاماً — التفاصيل
 * التالفة كانت ترمي داخل المعالج وتقضي على التفاعل كله.
 */
function buildCsv(rows) {
  const lines = ['ID,الإجراء,المنفذ,الهدف,التفاصيل,تاريخ الإنشاء'];
  for (const r of rows) {
    const details = audit.parseDetails(r.details);
    const summary = typeof details === 'string' ? details
      : details && typeof details === 'object' ? JSON.stringify(details)
        : details == null ? '' : String(details);
    const actor = r.actor_id ? `<@${r.actor_id}>` : 'النظام';
    const target = r.target_id ? `<@${r.target_id}>` : '';
    lines.push([r.id, r.action, actor, target, summary, r.created_at].map(csvCell).join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** فلاتر موحّدة: نفس المعاملات للعرض والتصدير — مسار واحد لا نسختان */
function filtersFor(state) {
  return {
    actorId: state.targetId || null,
    targetId: state.targetId || null,
    action: state.action || null,
    since: sinceFor(state.days),
  };
}

/** الجلب نفسه في العرض وفي تصدير CSV — السقف في الحالتين هو WINDOW */
function fetchRows(state) {
  return audit.list({ ...filtersFor(state), limit: WINDOW });
}

/** يجمع حالة الأمر من خياراته ثم يبني الحمولة (إمبد + صفوف تنقّل) */
function buildPayload(state, { targetUnknown = false } = {}) {
  const filters = filtersFor(state);
  const windowRows = fetchRows(state);
  const total = audit.count(filters);
  if (!windowRows.length) {
    return {
      embeds: [kit.notice('warning', 'لا توجد سجلات', 'لا توجد سجلات مطابقة لمعايير البحث.', { color: COLORS.gray })],
      components: [],
    };
  }

  const slice = kit.paginate(windowRows, state.page, state.size);
  const target = state.targetId ? `<@${state.targetId}>` : '';
  const title = `📋 سجلات الفريق${target ? ` — ${target}` : ''}${state.action ? ` — ${state.action}` : ''}`;

  // العدّاد يصف ما رُسم فعلاً، لا ما جُلب: «عرض 10 من أصل 30» مع 10 صفوف فقط.
  const notes = [`عرض ${slice.items.length} من أصل ${total} سجل`];
  if (state.days) notes.push(`النافذة: آخر ${state.days} يوم`);
  if (targetUnknown) notes.push('المرشّح لم يطابق أي إداري مُسجّل فلم يُطبَّق');
  if (total > WINDOW) notes.push(`النافذة تعرض أحدث ${WINDOW} سجلاً فقط — ${total - WINDOW} سجلاً أقدم خارجها`);

  const e = kit.card({ title, description: notes.join(' • '), color: COLORS.info });

  const counts = new Map();
  for (const log of windowRows) counts.set(log.action, (counts.get(log.action) || 0) + 1);
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([action, c]) => `${titleize(action)}: ${arDigits(c)}`).join(' • ');
  e.addFields({ name: '📊 أكثر الإجراءات تكراراً (ضمن النافذة)', value: summary || 'لا يوجد', inline: false });

  addLogFields(e, slice.items.map(log => rowLine(log, state.detailed)));
  e.setFooter({ text: kit.footerLine(`صفحة ${slice.page}/${slice.pages} • أحدث ${slice.items.length} سجلاً معروضاً`) });

  const args = [state.size, state.days, state.action, state.targetId, state.detailed ? '1' : '0'];
  // صف واحد يجمع التنقّل و«تصدير CSV»: المعاملات نفسها في المعرّفين، فالزر
  // يُصدّر بالضبط ما تعرضه الصفحة من فلاتر.
  const exportBtn = kit.button(`staff-logs:export:${args.join(':')}`, 'تصدير CSV', '📤', ButtonStyle.Success);
  const components = [kit.navRow({ prefix: 'staff-logs:page', page: slice.page, pages: slice.pages, args, extra: [exportBtn] })];
  return { embeds: [e], components };
}

module.exports = {
  commands: [
    {
      data: new SlashCommandBuilder().setName('staff-logs').setDescription('عرض سجلات الفريق مع التصفية والبحث')
        .addStringOption(o => o.setName('action').setDescription('تصفية حسب الإجراء (مثل: staff_warning_issued, task_assigned)').setMaxLength(64))
        .addStringOption(o => o.setName('user').setDescription('تصفية حسب المستخدم (معرّف أو اسم)').setMaxLength(64))
        .addIntegerOption(o => o.setName('limit').setDescription(`عدد السجلات في الصفحة (1-${MAX_PAGE_SIZE}، الافتراضي: ${DEFAULT_PAGE_SIZE})`).setMinValue(1).setMaxValue(MAX_PAGE_SIZE))
        // الوصف يقول ما يفعله الكود فعلاً: بلا days = بلا فلتر زمني (كل السجلات).
        .addIntegerOption(o => o.setName('days').setDescription('عدد الأيام السابقة — بلا فلتر افتراضياً (كل السجلات)').setMinValue(1).setMaxValue(365))
        .addBooleanOption(o => o.setName('detailed').setDescription('عرض تفاصيل JSON (مقتطعة)')),
      // سجل التدقيق يحتوي إنذارات وملاحظات سرية وأسباب استقالات — الإدارة العليا
      // فقط. هذه هي الصلاحية ذاتها التي كان يفرضها /audit-log المُدمَج
      // (LEVELS.MANAGEMENT) — الدمج لا يوسّع الوصول.
      level: LEVELS.MANAGEMENT,
      async execute(i) {
        if (!settings.featureToggle('auditExport')) {
          return i.reply({ embeds: [kit.notice('error', 'هذا الأمر معطّل حالياً.')], ephemeral: true });
        }
        const state = normalize({
          size: i.options.getInteger('limit'),
          days: i.options.getInteger('days'),
          action: i.options.getString('action'),
          detailed: i.options.getBoolean('detailed') ? '1' : '0',
        });
        const { id, unknown } = resolveTarget(i.options.getString('user'));
        return i.reply({ ...buildPayload({ ...state, targetId: id }, { targetUnknown: unknown }), ephemeral: true });
      },
    },
  ],

  components: {
    /**
     * بلا حالة: كل نقرة تعيد قراءة القاعدة بفلاتر معرّف المكوّن نفسه. لا مخزن،
     * لا رمز معلّق — و‎i.update‎ يُنهي التفاعل فوراً بدل أن يدور حتى ينتهي الرمز.
     */
    'staff-logs:page': async (i, [page, size, days, action, targetId, detailed]) => {
      if (!settings.featureToggle('auditExport')) {
        return i.update({ embeds: [kit.notice('error', 'هذا الأمر معطّل حالياً.')], components: [] });
      }
      return i.update(buildPayload(normalize({ page, size, days, action, targetId, detailed })));
    },

    /**
     * تصدير CSV لنفس الفلاتر ونفس سقف WINDOW — الزر يحمل معاملات الصفحة
     * نفسها، فالناتج هو ما تعرضه القائمة لا عيّنة منفصلة. الرد رسالة جديدة
     * (reply) تبقى فيها القائمة ظاهرة خلفها.
     */
    'staff-logs:export': async (i, [size, days, action, targetId, detailed]) => {
      if (!settings.featureToggle('auditExport')) {
        return i.reply({ embeds: [kit.notice('error', 'هذا الأمر معطّل حالياً.')], ephemeral: true });
      }
      const rows = fetchRows(normalize({ size, days, action, targetId, detailed }));
      if (!rows.length) {
        return i.reply({ embeds: [kit.notice('warning', 'لا توجد سجلات', 'لا توجد سجلات مطابقة للتصدير.', { color: COLORS.gray })], ephemeral: true });
      }
      const file = new AttachmentBuilder(Buffer.from(buildCsv(rows), 'utf-8'), {
        name: `staff-logs-${new Date().toISOString().slice(0, 10)}.csv`,
      });
      return i.reply({ content: `📤 تم تصدير ${arDigits(rows.length)} سجلاً إلى ملف CSV`, files: [file], ephemeral: true });
    },
  },

  // مُصدَّرة للاختبار: تثبت أن البناء يبقى داخل حدود ديسكورد مهما كبرت النافذة
  __testing: { buildPayload, normalize, rowLine, buildCsv, fetchRows, MAX_PAGE_SIZE, WINDOW },
};
