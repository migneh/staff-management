'use strict';
// فحص جودة كل نماذج البوت: تُبنى من مواصفات Label، وتخضع لحدود ديسكورد، ولا يُبنى نموذج يدوياً خارج الطبقة الموحّدة.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { ComponentType } = require('discord.js');
const forms = require('../src/ui/forms');
const { components: registry, modules } = require('../src/commands');
const { LEVELS } = require('../src/constants');

require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';

const ROOT = path.join(__dirname, '..');
/** مصادر يجوز فيها بناء Modal/TextInput يدوياً: طبقة النماذج ومعالج الخيارات الديناميكي. */
const ALLOWED = new Set(['src/ui/forms.js', 'src/commands/wizard.js']);
const PROBES = [
  {},
  { id: 7 },
  { id: 7, type: 'normal', prefill: {} },
  { action: 'reject', id: 7 },
  { cat: 'voluntary', noticeDays: 3, label: 'طوعية', emoji: '🔹' },
  { team: 'support', labels: [['tickets', 'التكتات']], current: { tickets: 60 } },
  { to: 'Support' },
  { entries: [], current: [] },
  { templateId: 2 },
  { type: 'timeout' },
  { action: 'accept', id: 7 },
  { action: 'hold', id: 7 },
  { policy: { maxConcurrent: 3, maxDays: 30, maxDaysPer90: 30, pendingExpireDays: 7, noticeDays: 7, escalateDays: 3 } },
  { supervisor: true },
  { id: 7, entries: [{ id: 1, title: 'مدخل للفحص' }], current: [1] },
];

function walk(dir, out = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) walk(full, out);
    else if (item.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function specsOf() {
  const list = [];
  for (const mod of modules || []) {
    for (const [key, build] of Object.entries(mod.modals || {})) {
      const seen = new Set();
      let found = false;
      for (const probe of PROBES) {
        let spec = null;
        try { spec = build(probe); } catch { spec = null; }
        if (!spec || !spec.fields || seen.has(spec.id)) continue;
        seen.add(spec.id);
        found = true;
        list.push({ key, spec });
      }
      if (!found) list.push({ key, spec: null });
    }
  }
  return list;
}

test('كل نموذج مبني من مواصفات Label وبحدود ديسكورد', () => {
  const list = specsOf();
  assert(list.length >= 12, `عدد النماذج المكتشفة ${list.length}`);
  const problems = [];
  for (const { key, spec } of list) {
    if (!spec) { problems.push(`${key}: لم تُبنَ المواصفة`); continue; }
    problems.push(...forms.auditSpec(spec));
    let modal;
    try { modal = forms.build(spec).toJSON(); } catch (e) { problems.push(`${key}: لا يُبنى — ${e.message}`); continue; }
    if (modal.title.length > 45) problems.push(`${key}: العنوان ${modal.title.length} حرفاً`);
    assert(modal.components.length <= 5, `${key}: أكثر من 5 مكونات`);
    for (const c of modal.components) {
      assert([ComponentType.Label, ComponentType.TextDisplay].includes(c.type), `${key}: مكون قديم (${c.type})`);
      if (c.type !== ComponentType.Label) continue;
      assert(c.label && c.description, `${key}: Label بلا اسم أو شرح`);
      if (c.component.type === ComponentType.TextInput && c.component.style === 2) {
        assert(c.component.max_length >= 100, `${key}: ${c.label} نص طويل بحد ضيق`);
      }
    }
    const fieldIds = modal.components.filter(c => c.component).map(c => c.component.custom_id);
    assert.equal(new Set(fieldIds).size, fieldIds.length, `${key}: معرفات مكررة`);
  }
  assert.deepEqual(problems, [], `ملاحظات على النماذج:\n${problems.join('\n')}`);
});

test('لا يُبنى أي نموذج يدوياً خارج طبقة النماذج', () => {
  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(ROOT, file).split(path.sep).join('/');
    if (ALLOWED.has(rel)) continue;
    const source = fs.readFileSync(file, 'utf8');
    if (/new\s+ModalBuilder\s*\(/.test(source)) offenders.push(`${rel}: ModalBuilder`);
    if (/new\s+TextInputBuilder\s*\(/.test(source)) offenders.push(`${rel}: TextInputBuilder`);
    if (/\.addComponents\(\s*new\s+ActionRowBuilder/.test(source)) offenders.push(`${rel}: ActionRow داخل نموذج`);
  }
  assert.deepEqual(offenders, [], `نماذج خارج الطبقة الموحّدة:\n${offenders.join('\n')}`);
});

test('كل معرف نموذج في السجل مغطّى بمواصفة', () => {
  const covered = new Set();
  for (const { spec } of specsOf()) {
    if (!spec) continue;
    const parts = String(spec.id).split(':');
    for (let n = parts.length; n >= 1; n--) {
      const key = parts.slice(0, n).join(':');
      if (registry.has(key)) { covered.add(key); break; }
    }
  }
  const missing = [...registry.keys()].filter(k => /modal/.test(k) && !covered.has(k));
  assert.deepEqual(missing, [], `معرفات نماذج بلا مواصفة مفحوصة: ${missing.join(', ')}`);
});

test('النماذج تُفتح بجلسة قابلة للتصحيح وتُغلق عند النجاح', async () => {
  const spec = { key: 'probe', id: 'probe:modal', title: 'نموذج فحص', fields: [forms.field({ id: 'reason', label: 'السبب', description: 'اكتب السبب.', max: 100 })] };
  const shown = { user: { id: 'u1' }, guildId: 'g1', customId: '', fields: { getTextInputValue: () => 'لأنني أفحص' }, async showModal(m) { this.modal = m; } };
  await forms.open(shown, spec);
  const token = forms.tokenOf({ customId: shown.modal.toJSON().custom_id });
  assert.match(shown.modal.toJSON().custom_id, /^probe:modal:form:[a-f0-9]{16}$/);
  const session = forms.lookup({ user: { id: 'u1' }, guildId: 'g1', customId: `probe:modal:form:${token}` });
  assert(session, 'بلا جلسة للنموذج');
  const submit = { user: { id: 'u1' }, guildId: 'g1', customId: `probe:modal:form:${token}`, fields: {
    getField: id => ({ custom_id: id, type: ComponentType.TextInput, value: 'لأنني أفحص' }),
    getTextInputValue: () => 'لأنني أفحص',
  } };
  assert.equal(forms.capture(submit, session), null, 'رُفض إدخال صحيح');
  assert.equal(submit.fields.getTextInputValue('reason'), 'لأنني أفحص');
  const row = forms.retryRow(submit);
  assert(row, 'لا يوجد زر تصحيح بعد الخطأ');
  assert.equal(row.components[0].data.custom_id, `form:retry:${token}`);
  forms.finish(submit, session);   // ما زال قابلاً للتصحيح: تبقى الجلسة حتى ينقر الزر
  assert(forms.lookup({ user: { id: 'u1' }, guildId: 'g1', customId: `probe:modal:form:${token}` }), 'ضاعت جلسة التصحيح');
  session.retryable = false;
  forms.finish(submit, session);   // نجاح: تُغلق الجلسة
  assert.equal(forms.lookup({ user: { id: 'u1' }, guildId: 'g1', customId: `probe:modal:form:${token}` }), null, 'بقيت الجلسة بعد النجاح');
  assert.equal(LEVELS.STAFF >= 1, true);
});
