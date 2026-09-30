'use strict';
const { randomBytes } = require('node:crypto');
const { ModalBuilder, LabelBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, CommandInteractionOptionResolver, ApplicationCommandOptionType: Type, escapeMarkdown } = require('discord.js');
const forms = require('../ui/forms');
const { accessContext, commandAccessError } = require('../services/commandAccess');
const { embed, COLORS, replyEphemeral, normalizeDigits, isValidDate } = require('../utils');
const { homeRow } = require('../ui/navigation');
const { trim } = require('../ui/kit');

const drafts = new Map();
const ADMIN_ONLY = new Set(['setup']); // إعداد السيرفر يظل مقصوراً على Administrator حتى عبر المعالج.
const DATE_OPTIONS = new Set(['start', 'end', 'date', 'due', 'new_end']);
function command(name) { return require('./index').commands.get(name); }
function get(i, token) {
  const d = drafts.get(token);
  return d && d.owner === i.user.id && d.guild === i.guildId && d.expires > Date.now() ? d : null;
}
/** خطأ قابل للتصحيح: يعيد فتح النموذج بالقيم المدخلة بدل إرغام المستخدم على البدء من جديد. */
async function fail(i, draft, message) {
  return i.reply({ embeds: [embed('راجع البيانات قبل المتابعة', message, COLORS.danger)], components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`wizard:reopen:${draft.token}:${draft.revision}`).setLabel('تصحيح البيانات').setEmoji('✏️').setStyle(ButtonStyle.Primary))], ephemeral: true });
}
async function guard(i, token) {
  const d = get(i, token);
  if (!d) { await replyEphemeral(i, 'انتهت جلسة الإجراء. افتح /help لاختيار الأمر من جديد.', COLORS.warning); return null; }
  const denied = ADMIN_ONLY.has(d.name) && !accessContext(i).admin ? 'الإعداد متاح لمن يملك صلاحية Administrator فقط.' : commandAccessError(command(d.name), accessContext(i));
  if (denied) { await replyEphemeral(i, denied, COLORS.danger); return null; }
  if (d.used) { await replyEphemeral(i, 'تم استخدام هذا التأكيد بالفعل. راجع نتيجة الإجراء قبل بدء طلب جديد.', COLORS.info); return null; }
  return d;
}
function schema(d) { return command(d.name).data.toJSON().options || []; }
function form(d) {
  const modal = new ModalBuilder().setCustomId(`wizard:submit:${d.token}:${d.revision}`).setTitle('إعداد الإجراء');
  for (const o of schema(d)) {
    const selected = d.options.find(v => v.name === o.name);
    const label = trim(o.description, 45);
    const description = `${o.required ? 'مطلوب' : 'اختياري؛ فارغ = الإعداد الافتراضي'} · /${d.name}`;
    if (o.type === Type.User) {
      modal.addLabelComponents(forms.userLabel({ id: o.name, label, required: !!o.required, value: selected?.value, description }));
    } else if (o.type === Type.Channel) {
      const select = new ChannelSelectMenuBuilder().setCustomId(o.name).setRequired(!!o.required).setMinValues(o.required ? 1 : 0).setMaxValues(1);
      if (o.channel_types?.length) select.addChannelTypes(...o.channel_types);
      if (selected) select.setDefaultChannels(selected.value);
      modal.addLabelComponents(new LabelBuilder().setLabel(label).setDescription(description).setChannelSelectMenuComponent(select));
    } else if (o.choices || o.type === Type.Boolean) {
      const options = o.choices?.map(c => ({ label: c.name, value: String(c.value) })) || [{ label: 'نعم', value: 'true' }, { label: 'لا', value: 'false' }];
      modal.addLabelComponents(forms.selectLabel({ id: o.name, label, options, required: !!o.required, values: selected ? [String(selected.value)] : [], description }));
    } else {
      const input = new TextInputBuilder().setCustomId(o.name).setRequired(!!o.required)
        .setStyle(o.type === Type.String && (o.max_length || 0) > 150 ? TextInputStyle.Paragraph : TextInputStyle.Short)
        .setMaxLength(Math.min(o.max_length || (o.type === Type.Integer ? 16 : 1000), 4000));
      if (o.min_length) input.setMinLength(o.min_length);
      if (selected) input.setValue(String(selected.value));
      let hint = description;
      if (o.type === Type.Integer) hint += ` · عدد صحيح${o.min_value != null ? ` من ${o.min_value}` : ''}${o.max_value != null ? ` إلى ${o.max_value}` : ''}؛ تقبل الأرقام العربية.`;
      if (DATE_OPTIONS.has(o.name)) { input.setMaxLength(20); hint += ' · سنة-شهر-يوم، يوم/شهر/سنة، اليوم أو غدا.'; }
      modal.addLabelComponents(new LabelBuilder().setLabel(label).setDescription(trim(hint, 100)).setTextInputComponent(input));
    }
  }
  return modal;
}
function preview(d) {
  const fields = schema(d).map(o => {
    const selected = d.options.find(v => v.name === o.name);
    let value = 'الإعداد الافتراضي';
    if (selected) value = o.type === Type.User ? `<@${selected.value}>` : o.type === Type.Channel ? `<#${selected.value}>`
      : o.type === Type.Boolean ? (selected.value ? 'نعم' : 'لا')
        : o.choices?.find(c => c.value === selected.value)?.name || escapeMarkdown(String(selected.value));
    return { name: trim(o.description, 200), value: trim(value, 800) };
  });
  const e = embed('راجع الإجراء قبل التنفيذ', `**/${d.name}**\n${command(d.name).data.description}\n\nلم يتم تنفيذ شيء بعد. تحقق من العضو والتفاصيل، ثم اضغط «متابعة التنفيذ».`, COLORS.warning);
  if (fields.length) e.addFields(fields);
  const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`wizard:run:${d.token}:${d.revision}`).setLabel('متابعة التنفيذ').setStyle(ButtonStyle.Primary));
  if (schema(d).length) row.addComponents(new ButtonBuilder().setCustomId(`wizard:edit:${d.token}`).setLabel('تعديل الخيارات').setStyle(ButtonStyle.Secondary));
  row.addComponents(new ButtonBuilder().setCustomId(`wizard:cancel:${d.token}`).setLabel('إلغاء').setStyle(ButtonStyle.Secondary));
  return { embeds: [e], components: [row], allowedMentions: { parse: [] } };
}
async function start(i, name) {
  const c = command(name);
  if (ADMIN_ONLY.has(name) && !accessContext(i).admin) return replyEphemeral(i, 'الإعداد متاح لمن يملك صلاحية Administrator فقط.', COLORS.danger);
  const denied = commandAccessError(c, accessContext(i));
  if (denied) return replyEphemeral(i, denied, COLORS.danger);
  const options = c.data.toJSON().options || [];
  if (options.length > 5 || options.some(o => ![Type.String, Type.Integer, Type.Boolean, Type.User, Type.Channel].includes(o.type))) return replyEphemeral(i, `استخدم /${name} لإدخال خيارات هذا الأمر.`, COLORS.info);
  for (const [key, d] of drafts) if (d.expires <= Date.now()) drafts.delete(key);
  if (drafts.size >= 300) drafts.delete(drafts.keys().next().value);
  const token = randomBytes(8).toString('hex');
  const draft = { token, name, owner: i.user.id, guild: i.guildId, expires: Date.now() + forms.TTL, options: [], used: false, revision: 0 };
  drafts.set(token, draft);
  return options.length ? forms.show(i, form(draft)) : i.reply({ ...preview(draft), ephemeral: true });
}
module.exports = {
  start,
  components: {
    'wizard:submit': async (i, [token, revision]) => {
      const d = await guard(i, token); if (!d) return;
      if (String(d.revision) !== revision || d.used) return fail(i, d, 'تغيّرت مسودة الإجراء. راجع القيم الحالية ثم أرسلها من جديد.');
      const options = [];
      for (const o of schema(d)) {
        const entry = { name: o.name, type: o.type };
        if ([Type.User, Type.Channel].includes(o.type)) {
          const collection = o.type === Type.User ? i.fields.getSelectedUsers(o.name) : i.fields.getSelectedChannels(o.name);
          const selected = collection?.first();
          if (!selected) { if (o.required) return fail(i, d, `لم تختر قيمة لحقل «${o.description}».`); continue; }
          if (o.type === Type.Channel && o.channel_types?.length && !o.channel_types.includes(selected.type)) return fail(i, d, 'نوع القناة غير مناسب لهذا الإجراء.');
          entry.value = selected.id;
          entry[o.type === Type.User ? 'user' : 'channel'] = selected;
        } else {
          const raw = o.choices || o.type === Type.Boolean ? i.fields.getStringSelectValues(o.name)[0] || '' : i.fields.getTextInputValue(o.name).trim();
          if (!raw) { if (o.required) return fail(i, d, `أكمل حقل «${o.description}».`); continue; }
          entry.value = o.type === Type.Boolean ? raw === 'true' : o.type === Type.Integer ? Number(normalizeDigits(raw)) : raw;
          if (o.type === Type.Boolean && !['true', 'false'].includes(raw)) return fail(i, d, 'اختر «نعم» أو «لا» من القائمة.');
          if (o.type === Type.Integer && (!/^-?\d+$/.test(normalizeDigits(raw)) || !Number.isSafeInteger(entry.value) || (o.min_value != null && entry.value < o.min_value) || (o.max_value != null && entry.value > o.max_value))) return fail(i, d, `راجع الرقم في «${o.description}»: يجب أن يكون صحيحاً ضمن الحدود الموضحة.`);
          if (o.choices && !o.choices.some(c => c.value === entry.value)) return fail(i, d, `اختر قيمة من القائمة لحقل «${o.description}».`);
          if (o.type === Type.String && (entry.value.length < (o.min_length || 0) || entry.value.length > (o.max_length || 6000))) return fail(i, d, `راجع طول النص في «${o.description}».`);
          if (DATE_OPTIONS.has(o.name)) {
            entry.value = forms.normalizeDate(raw);
            if (!isValidDate(entry.value)) return fail(i, d, `راجع تاريخ «${o.description}». مثال: 2026-09-30.`);
          }
        }
        options.push(entry);
      }
      d.options = options;
      d.revision += 1;
      return i.reply({ ...preview(d), ephemeral: true });
    },
    'wizard:edit': async (i, [token]) => { const d = await guard(i, token); if (d) return forms.show(i, form(d)); },
    'wizard:reopen': async (i, [token]) => { const d = await guard(i, token); if (d) return forms.show(i, form(d)); },
    'wizard:cancel': async (i, [token]) => {
      const d = await guard(i, token); if (!d) return;
      drafts.delete(token);
      return i.update({ embeds: [embed('تم الإلغاء', 'لم يُنفّذ أي إجراء. يمكنك العودة إلى الدليل.', COLORS.gray)], components: [homeRow()] });
    },
    'wizard:run': async (i, [token, revision]) => {
      const d = await guard(i, token); if (!d) return;
      if (d.used || String(d.revision) !== revision) return replyEphemeral(i, 'هذه البطاقة قديمة أو استُخدمت بالفعل. راجع أحدث نتيجة للإجراء.', COLORS.warning);
      // حماية أخيرة: لا يُنفَّذ أمر بخيارات مطلوبة ناقصة (بطاقة قديمة أو تسليم جزئي).
      const missing = (schema(d) || []).filter(o => o.required && !d.options.some(v => v.name === o.name));
      if (missing.length) return replyEphemeral(i, `أكمل الخيارات المطلوبة قبل التنفيذ: ${missing.map(o => o.description).join('، ')}`, COLORS.warning);
      d.used = true; // قبل أي await: النقر المكرر لا يكرر العملية الحساسة.
      i.options = new CommandInteractionOptionResolver(i.client, d.options);
      return command(d.name).execute(i);
    },
  },
};
