'use strict';
const { accessContext, SUSPENDED_ALLOWED_COMPONENT_PREFIXES } = require('./commandAccess');
const { LEVEL_LABELS } = require('./permissions');
const { LEVELS, TEAMS } = require('../constants');
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
  const { entry } = route;
  const context = accessContext(i);
  if (entry.adminOnly && !context.admin) return replyEphemeral(i, 'هذا الإجراء متاح لمن يملك صلاحية Administrator فقط.', COLORS.danger);
  if (!entry.adminOnly) {
    if (entry.serverManagerOnly && !context.serverManager) return replyEphemeral(i, 'هذا الإجراء متاح لـ Server Manager أو General Manager فقط.', COLORS.danger);
    if ((context.level || (context.serverManager ? LEVELS.GENERAL_MANAGER : 0)) < (entry.level || 0)) return replyEphemeral(i, `هذا الإجراء يتطلب **${LEVEL_LABELS[entry.level] || 'صلاحية أعلى'}**.`, COLORS.danger);
    if (entry.team && context.team !== entry.team && !context.serverManager) return replyEphemeral(i, `هذا الإجراء خاص بـ **${TEAMS[entry.team]}**.`, COLORS.danger);
    // فتح نموذج قبل الإيقاف لا يعطي حق إرساله بعد الإيقاف. القائمة مشتركة مع
    // أوامر / المعلّقة — البادئات الجديدة يجب أن تُضاف إلى هناك وتُختبر.
    if (context.suspended && SUSPENDED_ALLOWED_COMPONENT_PREFIXES.some(p => id.startsWith(p))) return replyEphemeral(i, 'حسابك الإداري موقوف. يمكنك مراجعة /my-record.', COLORS.danger);
  }
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
