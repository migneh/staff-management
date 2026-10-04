'use strict';
/**
 * فحص بنية حمولة أوامر Discord قبل أن تُدفع للشبكة.
 *
 * الغرض مزدوج: سطر أخطاء عربية مقروءة بدل DiscordAPIError[50035] الغامض،
 * وبوابة تُستدعى من المسارين معاً — validate في CI عند كل دمج، وdeploy
 * عند كل إقلاع على المضيف (المستخدم يرفع الشجرة بلا CI، والفشل عند PUT
 * لا يُكتشف إلا هناك). القواعد مأخوذة من توثيق Discord الرسمي؛ الأخطاء
 * الإنتاجية التي فتحت هذا الملف اثنان: خيار مطلوب بعد اختياري داخل
 * subcommand، وخيار مستوى أمر مختلط مع subcommands.
 *
 * الدالة تقبل JSON النهائي (ما ينتجه toJSON) لا نية البناء — لأن
 * SlashCommandBuilder يمنع أصغر القواعد وأكبرها يعبر الشبكة صامتاً.
 */

// 1 = SUB_COMMAND, 2 = SUB_COMMAND_GROUP — بمقدار discord.js وثيقة Discord.
const SUB_OPTION_TYPES = new Set([1, 2]);
// أسماء CHAT_INPUT: صغيرة/Lm/N/لاتيني-ذي-خط-قابل-للتصغير + Devanagari/Thai + _-
// (توثيق Discord: «إن وُجد محرف صغير فإلزمه» — الفرق عن \p{L} الواسع مقصود).
const OPTION_NAME_RE = /^[\p{Ll}\p{Lm}\p{Lo}\p{N}\p{sc=Devanagari}\p{sc=Thai}_-]+$/u;

const badLength = (v, min, max) => typeof v === 'string' && (v.length < min || v.length > max);

/**
 * @param {Array<{name:string, type?:number, description?:string, options?:Array}>} payload
 *   الحمولة كما تُرفع — مخرجات toJSON لكل أمر.
 * @returns {string[]} مشاكل بالعربية، فارغة إذا كانت الحمولة مقبولة.
 */
function structuralProblems(payload) {
  const problems = [];
  // فريدة لكل scope — الأوامر هنا guild واحدة. الـ Map يضمنها عند التحميل
  // (index.js يرمي عند الاسم المكرر)، فهي كابل أمان لو استُبدل المحمّل.
  const seenCommandNames = new Set();

  for (const cmd of payload) {
    const isChatInput = (cmd.type || 1) === 1;
    const cmdKey = `${cmd.name}:${cmd.type || 1}`;
    if (seenCommandNames.has(cmdKey)) problems.push(`اسم أمر مكرر في الحمولة «/${cmd.name}» — الأسماء فريدة لكل scope.`);
    seenCommandNames.add(cmdKey);

    // USER/MESSAGE (قوائم السياق) تقبل المسافا والحالة المختلطة ولا تحمل خيارات.
    if (isChatInput) {
      if (!OPTION_NAME_RE.test(cmd.name || '') || (cmd.name || '').length > 32) problems.push(`اسم أمر غير صالح «/${cmd.name}».`);
      if (badLength(cmd.description, 1, 100)) problems.push(`وصف أمر «/${cmd.name}» خارج حد 1-100.`);
    }

    // حد الحجم المركّب 8000 حرف (APPLICATION_COMMAND_TOO_LARGE) — البناء لا يفحصه أبداً.
    let size = (cmd.name || '').length + (cmd.description || '').length;
    const scan = (opts, where, parentType) => {
      if (opts.length > 25) problems.push(`/${cmd.name}${where}: ${opts.length} خيارات — الحد الذي يقبله Discord هو 25.`);
      if (parentType === 2 && opts.some(o => o.type !== 1)) problems.push(`/${cmd.name}${where}: مجموعة فرعية تحمل ما دون SUB_COMMAND — شكل التعشيش مرفوض (50035).`);
      if (parentType === 1 && opts.some(o => SUB_OPTION_TYPES.has(o.type))) problems.push(`/${cmd.name}${where}: subcommand يحتوي subcommand/group — عمق إضافي مرفوض (50035).`);
      if (!parentType) {
        const subs = opts.filter(o => SUB_OPTION_TYPES.has(o.type)).length;
        if (subs > 0 && subs !== opts.length) problems.push(`/${cmd.name}${where}: خيارات فرعية مختلطة بأنواع أخرى — SUB_COMMAND/SUB_COMMAND_GROUP متنافران مع كل الأنواع (50035 TYPE_INVALID).`);
      }
      const names = new Set();
      let sawOptional = false;
      for (const o of opts) {
        size += (o.name || '').length + (o.description || '').length;
        if (!OPTION_NAME_RE.test(o.name || '') || (o.name || '').length > 32) problems.push(`/${cmd.name}${where}: اسم خيار غير صالح «${o.name}».`);
        if (badLength(o.description, 1, 100)) problems.push(`/${cmd.name}${where}: وصف «${o.name}» خارج حد 1-100.`);
        if (names.has(o.name)) problems.push(`/${cmd.name}${where}: اسم خيار مكرر «${o.name}».`);
        names.add(o.name);
        const choices = o.choices || [];
        if (choices.length > 25) problems.push(`/${cmd.name}${where}: خيارات «${o.name}» تجاوزت 25 اختياراً.`);
        if (o.autocomplete === true && choices.length) problems.push(`/${cmd.name}${where}: «${o.name}» تجمع autocomplete مع choices — متنافران.`);
        if (o.min_length !== undefined && o.max_length !== undefined && o.min_length > o.max_length) problems.push(`/${cmd.name}${where}: «${o.name}» min_length أكبر من max_length.`);
        if (o.min_value !== undefined && o.max_value !== undefined && o.min_value > o.max_value) problems.push(`/${cmd.name}${where}: «${o.name}» min_value أكبر من max_value.`);
        for (const c of choices) {
          size += String(c.name ?? '').length + String(c.value ?? '').length;
          if (badLength(String(c.name ?? ''), 1, 100)) problems.push(`/${cmd.name}${where}: اسم اختيار غير صالح في «${o.name}».`);
          if (o.type === 4 && !Number.isInteger(c.value)) problems.push(`/${cmd.name}${where}: اختيار INTEGER غير صحيح في «${o.name}».`);
          if (o.type === 3 && String(c.value).length > 100) problems.push(`/${cmd.name}${where}: قيمة اختيار نصي تتجاوز 100 في «${o.name}».`);
        }
        if (o.required === true && sawOptional) problems.push(`/${cmd.name}${where}: الخيار المطلوب «${o.name}» جاء بعد خيار اختياري (50035 REQUIRED_INVALID).`);
        if (o.required !== true) sawOptional = true;
        if (SUB_OPTION_TYPES.has(o.type) && Array.isArray(o.options)) scan(o.options, `${where}/${o.name}`, o.type);
      }
    };
    scan(Array.isArray(cmd.options) ? cmd.options : [], '', undefined);
    if (size > 8000) problems.push(`/${cmd.name}: الحجم المركّب ${size} حرف — الحد 8000 (APPLICATION_COMMAND_TOO_LARGE).`);
  }
  return problems;
}

module.exports = { structuralProblems };
