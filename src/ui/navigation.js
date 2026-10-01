'use strict';
const {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder,
  CommandInteractionOptionResolver, ApplicationCommandOptionType,
} = require('discord.js');
const { embed, COLORS, replyEphemeral } = require('../utils');
const { accessContext, commandAccessError } = require('../services/commandAccess');
const { LEVEL_LABELS } = require('../services/permissions');
const { TEAMS } = require('../constants');

const PAGE_SIZE = 6;
const SECTIONS = [
  { id: 'start', label: 'ابدأ من هنا', emoji: '🏠', desc: 'لوحتك، مهامك، وأهم الإجراءات اليومية' },
  { id: 'work', label: 'العمل والمهام', emoji: '📋', desc: 'تسجيل العمل، المهام، وتقدير الزملاء' },
  { id: 'requests', label: 'الإجازات والاستقالة', emoji: '📨', desc: 'تقديم طلب ومتابعته أو إلغاؤه' },
  { id: 'promotion', label: 'الترقية', emoji: '📈', desc: 'الشروط، تقدمك، وتقديم الطلب' },
  { id: 'faq', label: 'قاعدة المعرفة', emoji: '📚', desc: 'القوانين والتعليمات وقوالب المعرفة' },
  { id: 'manage', label: 'إدارة الفريق', emoji: '👥', desc: 'المراجعات والتقارير والإجراءات الإدارية' },
  { id: 'system', label: 'إعدادات البوت', emoji: '⚙️', desc: 'الإعداد، الصيانة، والنسخ الاحتياطية' },
];
const GROUPS = {
   work: ['my-tasks', 'log-ticket', 'log-action', 'shoutout'],
   requests: ['request-leave', 'my-leaves', 'leave-balance', 'leave-calendar', 'extend-leave', 'cancel-leave', 'end-leave', 'resign', 'my-resignations', 'withdraw-resignation'],
   promotion: ['promotion-status', 'request-promotion', 'promotion-info'],
   system: ['setup', 'system-status', 'backup', 'backup-list', 'maintenance'],
};
// PERSONAL = أوامر لا معنى لها لمن بلا فريق (مالك السيرفر مثلاً): لا مهام له ولا إجازات.
// `me` و`my-record` و`my-performance` كانت غائبة، فيرى مالك السيرفر أوامر لا تخصّه.
const PERSONAL = new Set([
  ...GROUPS.requests,
  'my-tasks', 'promotion-status', 'request-promotion',
  'me', 'my-record', 'my-performance',
]);
// اختصارات يومية مباشرة؛ بقية الأوامر تمر بمعالج خيارات ومراجعة قبل التنفيذ.
const QUICK_ACTIONS = {
   'my-ratings': 'تقييمات العملاء', me: 'لوحتي الشخصية', 'my-tasks': 'مهامي', faq: 'تصفح المعرفة', 'faq-list': 'قائمة التعليمات',
   'my-record': 'سجلي',
   'request-leave': 'طلب إجازة', 'my-leaves': 'متابعة إجازاتي', 'leave-balance': 'رصيد إجازاتي',
   resign: 'بدء طلب استقالة', 'my-resignations': 'متابعة استقالاتاتي',
   'promotion-status': 'شروط ترقيتي', 'request-promotion': 'طلب ترقية',
   'log-action': 'تسجيل إجراء إشرافي', 'log-ticket': 'تسجيل تكت يدوي',
   'review-leaves': 'مراجعة الإجازات', 'review-promotion': 'مراجعة الترقيات',
   'review-resignations': 'مراجعة الاستقالات',
};

const registry = () => require('../commands').commands;
function visibleCommands(context) {
  return [...registry().values()].filter(c => !commandAccessError(c, context)
    && (context.team || !PERSONAL.has(c.data.name)));
}
function category(name) {
  if (name.startsWith('faq')) return 'faq';
  return Object.keys(GROUPS).find(id => GROUPS[id].includes(name)) || 'manage';
}
function normalizeSearch(value) {
  return String(value).trim().toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/[\u064B-\u065F\u0670ـ]/g, '').replace(/^\//, '').trim();
}
function quickRow(names, context, placeholder = 'اختر إجراءً لفتحه مباشرة…') {
  const available = new Set(visibleCommands(context).map(c => c.data.name));
  const options = names.filter(name => available.has(name))
    .map(name => ({ label: Object.hasOwn(QUICK_ACTIONS, name) ? QUICK_ACTIONS[name] : registry().get(name).data.description.slice(0, 100), value: name, description: `/${name}` }));
  if (!options.length) return null;
  return new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId('nav:action').setPlaceholder(placeholder).addOptions(options.slice(0, 25)));
}
function homeRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('me:home').setLabel('لوحتي').setEmoji('🏠').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('help:open').setLabel('دليل الاستخدام').setEmoji('🧭').setStyle(ButtonStyle.Secondary),
  );
}
function helpPayload(i, id = 'start', page = 0, query = null) {
  const context = accessContext(i);
  const available = visibleCommands(context);
  const sections = SECTIONS.filter(s => s.id === 'start' || available.some(c => category(c.data.name) === s.id && c.data.name !== 'help'));
  const current = sections.find(s => s.id === id) || sections[0];
  const start = context.team
    ? ['me', 'my-tasks', 'faq', 'request-leave', 'promotion-status']
    : ['manage-general', 'system-status', 'faq', 'setup'];
  const search = query !== null;
  const term = search ? normalizeSearch(query) : '';
  const entries = search
    ? (term ? available.filter(c => normalizeSearch(`${c.data.name} ${c.data.description}`).includes(term)) : [])
    : current.id === 'start' ? start.map(name => available.find(c => c.data.name === name)).filter(Boolean)
      : available.filter(c => c.data.name !== 'help' && category(c.data.name) === current.id);
  const pages = Math.max(1, Math.ceil(entries.length / PAGE_SIZE));
  const selectedPage = search ? 0 : Math.max(0, Math.min(Number.isSafeInteger(Number(page)) ? Number(page) : 0, pages - 1));
  const shown = entries.slice(selectedPage * PAGE_SIZE, (selectedPage + 1) * PAGE_SIZE);
  const description = search
    ? (entries.length ? `وجدنا **${entries.length}** نتيجة.${entries.length > PAGE_SIZE ? ` نعرض أول ${PAGE_SIZE}؛ ابحث بكلمة أدق لتقليل النتائج.` : ''}` : 'لا توجد نتائج متاحة لصلاحيتك. جرّب كلمة مثل «إجازة» أو «مهام» أو اسم الأمر بالإنجليزية.')
    : current.id === 'start' ? 'ماذا تريد أن تفعل اليوم؟ اختر إجراءً من القائمة، أو انتقل إلى قسم محدد.\nهذه الشاشة خاصة بك؛ بعض الإجراءات ترسل طلبات أو سجلات للإدارة.'
      : `${current.desc}.\nاختر من الاختصارات أدناه، أو اكتب الأمر لإدخال خياراته.`;
  const e = embed(search ? '🔎 نتائج البحث' : `${current.emoji} ${current.label}`, description, COLORS.primary);
  for (const c of shown) {
    const required = (c.data.toJSON().options || []).filter(o => o.required);
    e.addFields({ name: `/${c.data.name}`, value: `${c.data.description}${required.length ? `\nالمدخلات المطلوبة: ${required.map(o => o.description).join(' • ')}` : ''}` });
  }
  if (!search && current.id === 'work' && context.team === 'support') {
    e.addFields({ name: 'التكتات تُسجّل تلقائياً', value: 'استخدم /log-ticket فقط عند تعطل سجل بوت التكتات الخارجي.' });
  }
  e.setFooter({ text: `${search ? 'بحث' : `صفحة ${selectedPage + 1} من ${pages}`} • ${LEVEL_LABELS[context.level] || 'إدارة السيرفر'} • ${TEAMS[context.team] || 'بدون رتبة فريق'}` });
  const menu = new StringSelectMenuBuilder().setCustomId('help:section').setPlaceholder('انتقل إلى قسم…')
    .addOptions(sections.map(s => ({ label: s.label, value: s.id, description: s.desc, emoji: s.emoji, default: !search && current.id === s.id })));
  const nav = new ActionRowBuilder();
  if (!search && pages > 1) nav.addComponents(
    new ButtonBuilder().setCustomId(`help:page:${current.id}:${selectedPage - 1}`).setLabel('السابق').setStyle(ButtonStyle.Secondary).setDisabled(selectedPage === 0),
    new ButtonBuilder().setCustomId(`help:page:${current.id}:${selectedPage + 1}`).setLabel('التالي').setStyle(ButtonStyle.Secondary).setDisabled(selectedPage === pages - 1),
  );
  nav.addComponents(new ButtonBuilder().setCustomId('help:search').setLabel('بحث عن أمر').setEmoji('🔎').setStyle(ButtonStyle.Primary));
  if (context.team) nav.addComponents(new ButtonBuilder().setCustomId('me:home').setLabel('لوحتي').setEmoji('🏠').setStyle(ButtonStyle.Secondary));
  const quick = quickRow(shown.map(c => c.data.name), context);
  const configurable = shown.filter(c => Object.hasOwn(QUICK_ACTIONS, c.data.name) && c.data.toJSON().options?.length);
  const configure = configurable.length ? new ActionRowBuilder().addComponents(new StringSelectMenuBuilder().setCustomId('nav:configure').setPlaceholder('خيارات إضافية: تخصيص الإجراء أو التصفية…')
    .addOptions(configurable.map(c => ({ label: QUICK_ACTIONS[c.data.name], value: c.data.name, description: 'فتح جميع خيارات الأمر قبل تنفيذه' })))) : null;
  return { embeds: [e], components: [new ActionRowBuilder().addComponents(menu), ...(quick ? [quick] : []), ...(configure ? [configure] : []), nav] };
}

async function runQuickAction(i, name, value) {
  const command = registry().get(name);
  const context = accessContext(i);
  const denied = commandAccessError(command, context);
  if (denied) return replyEphemeral(i, `❌ ${denied}`, COLORS.warning);
  if (!context.team && PERSONAL.has(name)) {
    return replyEphemeral(i, 'هذا الاختصار غير متاح. افتح /help لاختيار الإجراء المناسب.', COLORS.warning);
  }
  if (!Object.hasOwn(QUICK_ACTIONS, name)) return require('../commands/wizard').start(i, name);
  const schema = command.data.toJSON().options || [];
  const required = schema.filter(o => o.required);
  let options = [];
  // اختصار بخيار نصي محدَّد القيم: نتحقق من القيمة حتى لو كان الخيار نفسه اختيارياً.
  if (value !== undefined && !required.length) {
    const match = schema.find(o => o.type === ApplicationCommandOptionType.String && o.choices?.length && o.choices.some(c => c.value === value));
    if (!match) return replyEphemeral(i, 'الخيار غير صالح. افتح الإجراء من الدليل مجدداً.', COLORS.warning);
    options = [{ name: match.name, type: match.type, value }];
  }
  if (required.length) {
    const option = required[0];
    if (required.length !== 1 || option.type !== ApplicationCommandOptionType.String || !option.choices?.length || option.choices.length > 25) {
      return replyEphemeral(i, `استخدم /${name} لإكمال المدخلات المطلوبة.`, COLORS.info);
    }
    if (value === undefined) {
      const select = new StringSelectMenuBuilder().setCustomId(`nav:choice:${name}`).setPlaceholder(option.description)
        .addOptions(option.choices.map(c => ({ label: c.name, value: c.value })));
      return i.reply({ embeds: [embed(QUICK_ACTIONS[name], 'الخطوة ١ من ٢: اختر النوع.\nالخطوة ٢: أكمل النموذج وراجعه قبل الإرسال.\nلم يتم إرسال أي طلب بعد.')], components: [new ActionRowBuilder().addComponents(select), homeRow()], ephemeral: true });
    }
    if (!option.choices.some(c => c.value === value)) return replyEphemeral(i, 'الخيار غير صالح. افتح الإجراء من الدليل مجدداً.', COLORS.warning);
    options = [{ name: option.name, type: option.type, value }];
  }
  // التفاعل الحقيقي يُستخدم كما هو (بما فيه حالتا replied/deferred)، مع محلل خيارات Discord الرسمي.
  i.options = new CommandInteractionOptionResolver(i.client, options);
  return command.execute(i);
}

module.exports = { helpPayload, quickRow, homeRow, runQuickAction, visibleCommands, normalizeSearch, QUICK_ACTIONS };
