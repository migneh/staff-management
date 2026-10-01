'use strict';
const { accessContext, componentAccessError } = require('./commandAccess');
const { replyEphemeral, COLORS } = require('../utils');
const forms = require('../ui/forms');

async function dispatch(i) {
  const session = forms.lookup(i);
  if ((forms.tokenOf(i) || i.customId?.startsWith('form:retry:')) && !session) {
    return replyEphemeral(i, 'انتهت صلاحية النموذج أو لم يعد متاحاً. افتح الأمر من جديد من /help. لم يتم إرسال بيانات جديدة.', COLORS.warning);
  }
  const id = session?.originalId || i.customId;
  const route = require('../commands').resolveComponent(id);
  if (!route) return replyEphemeral(i, 'هذا الإجراء لم يعد متاحاً. افتح /help للبدء من جديد.', COLORS.warning);
  // سياسة الوصول واحدة للأوامر والمكوّنات: `commandAccess` هو المرجع الوحيد.
  // هنا كان هناك نسخة مكتوبة يدوياً من نفس الفحوص، ففقد `maxLevel` وحدّ الفريق.
  const denial = componentAccessError(route.entry, accessContext(i), id);
  if (denial) return replyEphemeral(i, `❌ ${denial}`, COLORS.danger);
  if (session) {
    if (session.busy) return replyEphemeral(i, 'النموذج قيد المعالجة. انتظر النتيجة قبل المحاولة مجدداً.', COLORS.info);
    if (i.customId.startsWith('form:retry:')) return forms.reopen(i, session);
    session.busy = true;
    try {
      const error = forms.capture(i, session);
      // capture وحده يقرّر مصير الجلسة: رفض ⇒ تبقى الجلسة ويصعد ردّ الخطر بزرّ «تصحيح»،
      // ونجاح ⇒ نُسقط الجلسة فوراً فلا يُعاد فتح نموذج اكتمل ولا يتكرر إرساله.
      if (error) return replyEphemeral(i, error, COLORS.danger).finally(() => forms.finish(i, session, true));
      const result = await route.handler(i, route.args);
      forms.finish(i, session, false);
      return result;
    } catch (e) { forms.finish(i, session, true); throw e; }
  }
  return route.handler(i, route.args);
}
module.exports = { dispatch };
