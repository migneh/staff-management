#!/usr/bin/env node
'use strict';
/**
 * بوابة سلامة: تتأكد أن كل أمر وكل مكوّن (زر/قائمة/نموذج) معرّف ومحمي بصلاحية،
 * وأن كل customId مُعلن في COMPONENT_ACCESS له معالج فعلاً.
 * تفشل العملية (exit 1) عند أي تعارض — تُستخدم في CI قبل الدمج.
 */
require('../tests/sqlite-compat').install();

let commands;
let validateRegistry;
let COMPONENT_ACCESS;
try {
  const registry = require('../src/commands');
  commands = registry.commands;
  validateRegistry = registry.validateRegistry;
  COMPONENT_ACCESS = registry.COMPONENT_ACCESS;
} catch (e) {
  console.error(`❌ تعذّر تحميل سجل الأوامر: ${e.message}`);
  process.exit(1);
}

const problems = validateRegistry();
if (problems.length) {
  console.error(`❌ ${problems.length} مشكلة في السجل:`);
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}

/**
 * قواعد بنية حمولة Discord: بوابة الصلاحيات لا ترى ما يرفضه الـ API في شكل
 * الخيارات — الخطأان اللذان أوقفا تسجيل الإنتاج (DiscordAPIError[50035]) كانا
 * هنا: خيار مطلوب بعد اختياري داخل sub، وخيار على مستوى الأمر مختلط مع
 * subcommands. تُفحص البنية نفسها التي يبنيها deploy-commands.js قبل أن تُدفع
 * للشبكة، لأن التسجيل يحدث عند كل إقلاع ولا يُكشف الفشل إلا على المضيف.
 * باقي القواعد (الحجم 8000، أسماء الأوامر الفريدة، شكل التعشيش، حدود القيم)
 * موثّقة على discord.com/developers ويفشل فيها SlashCommandBuilder صامتاً —
 * فهي تُفحص على JSON النهائي لا على نية البناء.
 */
const SUB_OPTION_TYPES = new Set([1, 2]); // 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP
const OPTION_NAME_RE = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}\p{sc=Devanagari}\p{sc=Thai}_-]+$/u;
const badLength = (v, min, max) => typeof v === 'string' && (v.length < min || v.length > max);
const structural = [];
const seenCommandNames = new Set();

for (const entry of commands.values()) {
  const cmd = entry.data.toJSON();
  const cmdKey = `${cmd.name}:${cmd.type || 1}`;
  if (seenCommandNames.has(cmdKey)) structural.push(`اسم أمر مكرر في الحمولة «/${cmd.name}» — الأسماء فريدة لكل scope.`);
  seenCommandNames.add(cmdKey);
  if (!OPTION_NAME_RE.test(cmd.name || '') || (cmd.name || '').length > 32) structural.push(`اسم أمر غير صالح «/${cmd.name}».`);
  if (badLength(cmd.description, 1, 100)) structural.push(`وصف أمر «/${cmd.name}» خارج حد 1-100.`);

  // حد الحجم المركّب 8000 حرف (APPLICATION_COMMAND_TOO_LARGE) — البناء لا يفحصه أبداً.
  let size = (cmd.name || '').length + (cmd.description || '').length;
  const scan = (opts, where, parentType) => {
    if (opts.length > 25) structural.push(`/${cmd.name}${where}: ${opts.length} خيارات — الحد الذي يقبله Discord هو 25.`);
    if (parentType === 2 && opts.some(o => o.type !== 1)) structural.push(`/${cmd.name}${where}: مجموعة فرعية تحمل ما دون SUB_COMMAND — شكل التعشيش مرفوض (50035).`);
    if (parentType === 1 && opts.some(o => SUB_OPTION_TYPES.has(o.type))) structural.push(`/${cmd.name}${where}: subcommand يحتوي subcommand/group — عمق إضافي مرفوض (50035).`);
    if (!parentType) {
      const subs = opts.filter(o => SUB_OPTION_TYPES.has(o.type)).length;
      if (subs > 0 && subs !== opts.length) structural.push(`/${cmd.name}${where}: خيارات فرعية مختلطة بأنواع أخرى — SUB_COMMAND/SUB_COMMAND_GROUP متنافران مع كل الأنواع (50035 TYPE_INVALID).`);
    }
    const names = new Set();
    let sawOptional = false;
    for (const o of opts) {
      size += (o.name || '').length + (o.description || '').length;
      if (!OPTION_NAME_RE.test(o.name || '') || (o.name || '').length > 32) structural.push(`/${cmd.name}${where}: اسم خيار غير صالح «${o.name}».`);
      if (badLength(o.description, 1, 100)) structural.push(`/${cmd.name}${where}: وصف «${o.name}» خارج حد 1-100.`);
      if (names.has(o.name)) structural.push(`/${cmd.name}${where}: اسم خيار مكرر «${o.name}».`);
      names.add(o.name);
      const choices = o.choices || [];
      if (choices.length > 25) structural.push(`/${cmd.name}${where}: خيارات «${o.name}» تجاوزت 25 اختياراً.`);
      if (o.autocomplete === true && choices.length) structural.push(`/${cmd.name}${where}: «${o.name}» تجمع autocomplete مع choices — متنافران.`);
      if (o.min_length !== undefined && o.max_length !== undefined && o.min_length > o.max_length) structural.push(`/${cmd.name}${where}: «${o.name}» min_length أكبر من max_length.`);
      if (o.min_value !== undefined && o.max_value !== undefined && o.min_value > o.max_value) structural.push(`/${cmd.name}${where}: «${o.name}» min_value أكبر من max_value.`);
      for (const c of choices) {
        size += String(c.name ?? '').length + String(c.value ?? '').length;
        if (badLength(String(c.name ?? ''), 1, 100)) structural.push(`/${cmd.name}${where}: اسم اختيار غير صالح في «${o.name}».`);
        if (o.type === 4 && !Number.isInteger(c.value)) structural.push(`/${cmd.name}${where}: اختيار INTEGER غير صحيح في «${o.name}».`);
        if (o.type === 3 && String(c.value).length > 100) structural.push(`/${cmd.name}${where}: قيمة اختيار نصي تتجاوز 100 في «${o.name}».`);
      }
      if (o.required === true && sawOptional) structural.push(`/${cmd.name}${where}: الخيار المطلوب «${o.name}» جاء بعد خيار اختياري (50035 REQUIRED_INVALID).`);
      if (o.required !== true) sawOptional = true;
      if (SUB_OPTION_TYPES.has(o.type) && Array.isArray(o.options)) scan(o.options, `${where}/${o.name}`, o.type);
    }
  };
  scan(cmd.options || [], '', undefined);
  if (size > 8000) structural.push(`/${cmd.name}: الحجم المركّب ${size} حرف — الحد 8000 (APPLICATION_COMMAND_TOO_LARGE).`);
}
if (structural.length) {
  console.error(`❌ ${structural.length} مشكلة في بنية حمولة Discord:`);
  for (const s of structural) console.error(`   • ${s}`);
  process.exit(1);
}

const byLevel = {};
for (const entry of Object.values(COMPONENT_ACCESS)) {
  const key = entry.adminOnly ? 'adminOnly' : `level${entry.level}`;
  byLevel[key] = (byLevel[key] || 0) + 1;
}

console.log(`✅ سجل سليم: ${commands.size} أمر • ${Object.keys(COMPONENT_ACCESS).length} مكوّن`);
console.log(`   التوزيع: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' • ')}`);
