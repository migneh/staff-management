'use strict';
// واجهة الضبط في /setup تعمل عبر طبقة القواعد: اختيار النمط والمنطق،
// تعديل قاعدة رتبة من النوافذ، واستعادتها للثوابت.
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.TZ = 'Asia/Riyadh';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const rules = require('../src/services/promotionRules');
const setup = require('../src/commands/setup');
const { commands, resolveComponent } = require('../src/commands');
const { arDigits } = require('../src/utils');

beforeEach(() => {
  openMemoryDb();
  settings.set('test', true); // تبطل كاش الإعدادات بين قواعد الاختبار
  rules.resetRule('support', 'Support');
  rules.resetRule('moderation', 'Moderator');
});

const asJson = p => JSON.stringify((p.embeds || []).map(e => e.toJSON()));

/** تفاعل مكون وهمي: قوائم/نصوص + reply/update/editReply كما يزوّدها ديسكورد. */
function interaction({ customId = '', values = [], texts = {} } = {}) {
  return {
    customId, values, user: { id: 'setup-admin' }, replied: false,
    fields: {
      getTextInputValue: id => texts[id] ?? '',
      getStringSelectValues: id => [].concat(texts[id] ?? []),
    },
    async reply(payload) { this.replied = true; this.payload = payload; },
    async replyEphemeral(payload) { this.replied = true; this.payload = payload; },
    async update(payload) { this.updated = true; this.payload = payload; },
    async deferUpdate() { this.replied = true; },
    async editReply(payload) { this.payload = payload; },
    async showModal(modal) { this.modal = modal; },
    async followUp(payload) { this.followUpPayload = payload; },
  };
}

const handler = (id, args = []) => resolveComponent(id).handler;

test('خيار «بوابات الترقيات» يفتح صفحة النمط والمنطق ومسارات الترقية', async () => {
  const cmd = commands.get('setup');
  const entry = resolveComponent('setup:section');
  const i = interaction({ values: ['promotions'] });
  await entry.handler(i);
  const payload = asJson(i.payload);
  assert.match(payload, /بوابات الترقيات/);
  assert.match(payload, /نمط البوابة:\*\* النقاط/); // الافتراضي points
  assert.match(payload, /Trial Moderator → Moderator/); // مسار إشراف
  assert.match(payload, /Helper → Support/); // مسار دعم
  const ids = JSON.stringify(i.payload);
  assert(ids.includes('setup:promomode'), 'قائمة النمط مربوطة في الصفحة');
  assert(ids.includes('setup:promologic'), 'قائمة المنطق مربوطة في الصفحة');
  assert(ids.includes('setup:promorule'), 'قائمة المسارات مربوطة في الصفحة');
  assert.equal(cmd.data.name, 'setup'); // النمط: أمر /setup بلا اوامر غير مستخدمة
});

test('تبديل النمط والمنطق من القوائم يسجل في دفتر التدقيق بالفعل الافتراضي', async () => {
  await resolveComponent('setup:promomode').handler(interaction({ values: ['both'] }));
  assert.equal(rules.getMode(), 'both');
  await resolveComponent('setup:promologic').handler(interaction({ values: ['any'] }));
  assert.equal(rules.getBothLogic(), 'any');
  const rows = getDb().prepare("SELECT actor_id, details FROM audit_logs WHERE action = 'promotion_mode_updated'").all();
  assert.equal(rows.length, 2, 'سجلان: النمط والدمج');
  assert.equal(rows[0].actor_id, 'setup-admin');
  // العودة للافتراضي عبر نفس القائمات — بلا إعادة تشغيل
  await resolveComponent('setup:promomode').handler(interaction({ values: ['points'] }));
  assert.equal(rules.getMode(), 'points');
  await resolveComponent('setup:promologic').handler(interaction({ values: ['all'] }));
  assert.equal(rules.getBothLogic(), 'all');
});

test('صفحة المسار تفتح من قائمة المسارات وتظهر «أساس» عند تجاوز حيّ', async () => {
  const i = interaction({ values: ['moderation:Moderator'] });
  await resolveComponent('setup:promorule').handler(i);
  let payload = asJson(i.payload);
  assert.match(payload, /قاعدة الترقية — Moderator → Senior Moderator/);
  assert(payload.includes('الثوابت، لا تجاوز مفعّل') || payload.includes('الثوابت'), payload);
  rules.setRule('moderation', 'Moderator', { pointsThreshold: 700 });
  const outlined = interaction({ values: ['moderation:Moderator'] });
  await resolveComponent('setup:promorule').handler(outlined);
  payload = asJson(outlined.payload);
  assert.match(payload, new RegExp(`\\(أساس: ${arDigits(550)}\\)`), 'هامش الأساس يظهر بجانب التجاوز');
  assert.match(payload, new RegExp(`عتبة النقاط: \\*\\*${arDigits(700)}\\*\\*`));
});

test('نموذج القاعدة المشتركة يفتح من زر المسار ويحوي الحقول الخمسة', async () => {
  const i = interaction();
  await resolveComponent('setup:promobase').handler(i, ['support', 'Helper']);
  const json = i.modal.toJSON();
  assert.ok(json.custom_id.startsWith('setup:promobase-modal'), 'معرف النموذج يلتحق توكم الجلسة');
  assert.equal(json.components.length, 5, 'الحد الأقصى للنوافذ');
  const ids = json.components.map(c => c.component.custom_id);
  assert.deepEqual(ids, ['months', 'pointsThreshold', 'scoreThreshold', 'approvals', 'maxWarnings']);
});

test('إرسال القاعدة المشتركة: تجاوز عتبة النقاط يُحفظ حيّاً ثم يعود بالزر', async () => {
  await resolveComponent('setup:promobase-modal').handler(
    interaction({ texts: { pointsThreshold: '700' } }), ['moderation', 'Moderator']);
  assert.equal(rules.ruleFor('moderation', 'Moderator').pointsThreshold, 700);
  const rows = getDb().prepare("SELECT actor_id, target_id, details FROM audit_logs WHERE action = 'promotion_rules_updated'").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].actor_id, 'setup-admin');
  assert.match(rows[0].details, /pointsThreshold/);
  await resolveComponent('setup:promoreset').handler(interaction(), ['moderation', 'Moderator']);
  assert.equal(rules.ruleFor('moderation', 'Moderator').pointsThreshold, 550);
  assert(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action = 'promotion_rules_reset'").get().c >= 1);
});

test('إرسال شرط الفريق: أرقام عربية تُقبل وخطا القيمة لا يغيّر شيئاً', async () => {
  await resolveComponent('setup:promoteam-modal').handler(
    interaction({ texts: { rating: '٤٫٥', minActiveDays: '٢٥' } }), ['support', 'Helper']);
  const rule = rules.ruleFor('support', 'Helper');
  assert.equal(rule.rating, 4.5);
  assert.equal(rule.minActiveDays, 25);
  // إدخال غير رقمي: رفض ظاهر، والقيم القديمة باقية
  const bad = interaction({ texts: { rating: 'kt' } });
  await resolveComponent('setup:promoteam-modal').handler(bad, ['support', 'Helper']);
  assert.match(JSON.stringify(bad.payload), /ليست رقماً/);
  assert.equal(rules.ruleFor('support', 'Helper').rating, 4.5);
  // إدخال فراغ كامل: رسالة عدم تغيير بلا كتابة
  const empty = interaction({ texts: {} });
  await resolveComponent('setup:promoteam-modal').handler(empty, ['support', 'Helper']);
  assert.match(JSON.stringify(empty.payload), /لم تُرسل قيماً/);
});

test('سجل المكوّانات: لا تعارض بادئات وتُحل المسارات الديناميكية', () => {
  const r1 = resolveComponent('setup:promoreset:support:Support Expert');
  assert.deepEqual(r1.args, ['support', 'Support Expert']);
  assert.equal(r1.entry.adminOnly, true);
  const r2 = resolveComponent('setup:promoteam-modal:support:Helper');
  assert.ok(r2, 'معرف الإرسال يعمل مع معاملاته الديناميكية');
  const r3 = resolveComponent('setup:promobase');
  assert.equal(r3.args.length, 0);
});
