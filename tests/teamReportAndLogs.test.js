'use strict';
/**
 * اختبارات سقف تقرير الفريق (‎/team-report‎) وترقيم صفحات سجلات الفريق (‎/staff-logs‎).
 *
 * علة 1: teamEmbed كان يمرّ بـ addFields مباشرة بلا سقف حقول ولا قصّ 1024 حرفاً،
 *        فكان عدد الحقول يتجاوز 25 (يرمي) ومجموع الأحرف يتجاوز 6000 (يُرفض الرد)،
 *        وكان يقرأ r.work بينما reports.team يُرجع r.raw فيسقط على أول صف.
 * علة 2: ‎/staff-logs‎ كان يعرض قائمتين لا غير (الأولى والأخيرة)، ومعالجتها
 *        deferUpdate() فقط بلا حل، وقصّ 100 حرف على النص كله لا على عدد الصفوف.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { openMemoryDb, getDb } = require('../src/database');
const reportsService = require('../src/services/reports');
const audit = require('../src/services/audit');
const staffService = require('../src/services/staff');
const reports = require('../src/commands/reports');
const staffLogs = require('../src/commands/staff-logs');
const { commands, resolveComponent } = require('../src/commands');
const { commandAccessError, componentAccessError } = require('../src/services/commandAccess');
const { LEVELS } = require('../src/constants');

const IDS = { me: '1005171993940852796', peer: '1490787800168005713', channel: '323456789012345678', guild: '423456789012345678' };
const LIMITS = { fields: 25, name: 256, value: 1024, total: 6000 };
const json = payload => JSON.parse(JSON.stringify(payload?.toJSON ? payload.toJSON() : payload));

/** مجموع كل نص في الإمبد — هذا ما يتحقق منه ديسكورد عند حد 6000 حرف. */
function embedCharTotal(e) {
  return (e.title || '').length + (e.description || '').length + (e.footer?.text || '').length
    + (e.author?.name || '').length
    + (e.fields || []).reduce((s, f) => s + f.name.length + f.value.length, 0);
}

function assertWithinDiscordLimits(e, label) {
  assert((e.fields || []).length <= LIMITS.fields, `${label}: ${(e.fields || []).length} حقل > 25`);
  for (const f of e.fields || []) {
    assert(f.name.length <= LIMITS.name, `${label}: اسم حقل أطول من 256`);
    assert(f.value.length <= LIMITS.value, `${label}: قيمة حقل ${f.value.length} حرف > 1024`);
    assert(f.name.trim() && f.value.trim(), `${label}: حقل فارغ`);
  }
  const total = embedCharTotal(e);
  assert(total <= LIMITS.total, `${label}: ${total} حرف > 6000`);
  return total;
}

/**
 * صفوف بالشكل الذي يرجعه reports.individual فعلياً: { staff, raw, ... }.
 * هذا هو عقد الخدمة الحقيقي، وهو ما كان teamEmbed يخرئه (قرأ r.work لا r.raw).
 */
function rawRows(n, team = 'support') {
  return Array.from({ length: n }, (_, k) => ({
    staff: {
      user_id: `1000000000000${String(k).padStart(4, '0')}`, username: `staff${k}`,
      team, rank: team === 'support' ? 'Support' : 'Moderator', status: 'active',
      rank_since: '2026-01-01', last_activity: '2026-09-30',
    },
    raw: {
      messages: 40 + k, weightedMessages: 12.5, activeDays: (k % 21) + 1, leaveDays: k % 3,
      tickets: (k * 7) % 120, avgRating: 4.35, ratingCount: 6, avgDuration: 47, reopened: 2,
      actions: (k * 11) % 150, warnings: 0, positiveNotes: 1, negativeNotes: 0,
    },
    warnings: [], absentDays: 4, lastActivityHours: 6,
  }));
}

/** صفوف بالشكل البديل (load.teamLoad → { staff, work }) — حارس ضد أي عقد قادم. */
function workRows(n, team = 'support') {
  return Array.from({ length: n }, (_, k) => ({
    staff: {
      user_id: `2000000000000${String(k).padStart(4, '0')}`, username: `load${k}`,
      team, rank: 'Support', status: 'active', last_activity: '2026-09-30',
    },
    work: { closed: (k * 3) % 97, actions: (k * 5) % 131, activeDays: (k % 20) + 1, avgDuration: 42, avgRating: 4.2 },
  }));
}

beforeEach(() => { openMemoryDb(); });

// ===== علة 1: سقف تقرير الفريق =====

test('teamEmbed لا يرمي ويبقى داخل حدود ديسكورد عند 100 و200 و400 و1000 عضو', () => {
  const report = [];
  for (const n of [100, 200, 400, 1000]) {
    for (const team of ['support', 'moderation']) {
      let e;
      // الرمي نفسه هو العطل المُبلَّغ عنه: نمرّره عبر ديسكورد نفسها لا عبر toJSON فقط.
      assert.doesNotThrow(() => { e = reports.teamEmbed(team, rawRows(n, team)).toJSON(); },
        `n=${n} ${team}: teamEmbed يرمي`);
      const total = assertWithinDiscordLimits(e, `n=${n} ${team}`);
      report.push(`n=${n} ${team}: ${(e.fields || []).length} حقل / ${total} حرف`);
    }
  }
  // الفريق الضخم يجب ألا يُقصّ صامتاً: إمّا يُعرض أو يُعلن عدد المُسقَط.
  const big = reports.teamEmbed('support', rawRows(1000, 'support')).toJSON();
  const shown = (big.fields || []).filter(f => f.value.includes('<@')).join('\n');
  assert(shown.length > 0, 'يظهر عضو واحد على الأقل');
});

test('تقرير الفريق يقرأ العقد الحقيقي { staff, raw } ولا يسقط على أول صف', () => {
  // العقد الفعلي من الخدمة: raw لا work. كان الكود يقرأ r.work فكان يرمي
  // "Cannot read properties of undefined (reading 'closed')" لكل حجم فريق.
  const rows = rawRows(5, 'moderation');
  const e = reports.teamEmbed('moderation', rows).toJSON();
  assertWithinDiscordLimits(e, 'raw-5');
  const body = e.fields.map(f => f.value).join('\n');
  for (const r of rows) assert(body.includes(`<@${r.staff.user_id}>`), `العضو ${r.staff.user_id} ظاهر`);
  // الإجراء للمشرفين يأتي من raw.actions لا raw.tickets — نتأكد أن كل صف يحمل رقمه الصحيح
  for (const r of rows) {
    const line = body.split('\n').find(l => l.includes(`<@${r.staff.user_id}>`));
    assert(line.includes(`**${r.raw.actions}**`), `الرقم الصحيح ${r.raw.actions} في سطر ${r.staff.user_id}: ${line}`);
  }
  // لا تكتات في تقرير الإشراف
  assert(!body.includes('تكت'), 'لا خلط بين تكتات الدعم وإجراءات الإشراف');
});

test('تقرير الفريق لا يتجاوز السقف حتى لو جاء بصفوف بالشكل البديل { staff, work }', () => {
  // حارس ضد أي عقد قادم: أي صفوف تدخل teamEmbed يجب ألا تُنتج أكثر من 25 حقلاً
  // ولا أكثر من 6000 حرف. هذا هو ما كان يفشل عند 200 صف.
  for (const n of [100, 200, 400, 1000]) {
    const e = reports.teamEmbed('support', workRows(n)).toJSON();
    assertWithinDiscordLimits(e, `work-${n}`);
  }
});

test('التقرير الذي لا يتّسع يصرّح بعدد الأعضاء المُسقَطين بالعربية', () => {
  const n = 1000;
  const e = reports.teamEmbed('support', rawRows(n, 'support')).toJSON();
  const omitted = (e.fields || []).find(f => f.value.includes('لم يظهر'));
  assert(omitted, `يجب أن يوجد حقل يعلن الإخفاء — الحقول: ${(e.fields || []).map(f => f.name).join(' | ')}`);
  assert.match(omitted.value, /لم يظهر/, 'نص عربي يصرّح بالإخفاء');
  // لا بد أن يذكر العدد صراحةً برقم
  assert.match(omitted.value, /[٠-٩0-9]/, 'يظهر عدد');
  // وعدد ما ظهر فعلاً + ما أُخفي = الإجمالي
  const shownMentions = (e.fields || []).filter(f => f.value.includes('<@'))
    .flatMap(f => f.value.split('\n')).filter(l => l.includes('<@')).length;
  const reported = Number((omitted.value.match(/(\d+)/) || [])[1]);
  assert.equal(shownMentions + reported, n, 'المعروض + المُعلن = الإجمالي');
});

test('التقرير الكامل يذكر العدد الحقيقي للأعضاء حتى مع وجود إخفاء', () => {
  const e = reports.teamEmbed('support', rawRows(1000, 'support')).toJSON();
  assert.match(e.description, /الأعضاء: \*\*1000\*\*/, 'الوصف يذكر العدد الحقيقي لا عدد ما ظهر');
});

test('تقرير الفريق الحقيقي من قاعدة البيانات يُبنى بلا رمي', () => {
  const db = getDb();
  const ins = db.prepare(`INSERT INTO staff_members (user_id, username, team, rank, status, rank_since, last_activity)
    VALUES (?, ?, 'support', 'Support', 'active', '2026-01-01', '2026-09-30')`);
  for (let k = 0; k < 30; k++) ins.run(`3000000000000${String(k).padStart(4, '0')}`, `real${k}`);
  const rows = reportsService.team('support');
  assert.equal(rows.length, 30, 'الخدمة رجعت 30 صفاً');
  const e = reports.teamEmbed('support', rows).toJSON();
  assertWithinDiscordLimits(e, 'db-30');
  assert.equal(staffService.all({ team: 'support' }).length >= 30, true);
});

// ===== علة 2: ترقيم صفحات سجلات الفريق =====

function seedLogs(n) {
  const db = getDb();
  for (let k = 1; k <= n; k++) {
    db.prepare(`INSERT INTO audit_logs (action, actor_id, target_id, details, channel_id, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now', ?))`)
      .run(k % 2 ? 'staff_warning_issued' : 'task_assigned', IDS.me, IDS.peer,
        JSON.stringify({ note: `سجل رقم ${k}` }), IDS.channel, `-${k} minutes`);
  }
}
function seedStaff(id, team = 'support') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, ?, ?, 'Support', 'active')
    ON CONFLICT(user_id) DO UPDATE SET team = excluded.team`).run(id, id, team);
}
function interaction({ customId = '', level = LEVELS.MANAGEMENT, id = IDS.me, strings = {}, integers = {}, booleans = {} } = {}) {
  seedStaff(id);
  return {
    customId, user: { id }, guildId: IDS.guild, channelId: IDS.channel, staffLevel: level, staffInfo: { team: 'support' },
    member: { permissions: { has: () => false } }, values: [], replied: false, deferred: false,
    client: { channels: { fetch: async () => ({ send: async () => ({ id: '1' }) }) } },
    options: {
      getString: name => (name in strings ? strings[name] : null),
      getInteger: name => (name in integers ? integers[name] : null),
      getBoolean: name => (name in booleans ? booleans[name] : null),
      getUser: () => null,
    },
    async reply(p) { this.replied = true; this.payload = p; },
    async update(p) { this.replied = true; this.updated = true; this.payload = p; },
    async deferReply() { this.deferred = true; },
    async deferUpdate() { this.deferred = true; },
  };
}
const buttonIds = payload => json(payload).components.flatMap(r => r.components).map(c => c.custom_id);
/** أرقام الصفحات المتاحة في صف التنقّل (زر «noop» معطّل وتحمله كلمة لا رقم) */
const pageNumbers = payload => buttonIds(payload)
  .filter(id => id.startsWith('staff-logs:page:'))
  .map(id => Number(id.split(':')[2]))
  .filter(n => Number.isInteger(n) && n > 0);
const rowsShown = payload => {
  const text = json(payload).embeds[0].fields.filter(f => f.value.includes('**#'))
    .map(f => f.value).join('\n');
  return [...text.matchAll(/\*\*#(\d+)\*\*/g)].map(m => Number(m[1]));
};

test('/staff-logs يعرض كل صفحة كاملة بدل قصّ 1024 حرف على النص كله', async () => {
  seedLogs(30);
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);
  const payload = json(i.payload);
  const shown = rowsShown(i.payload);
  assert.equal(shown.length, 10, `عُرض ${shown.length} صفاً بدل 10`);
  // الأحدث أولاً: أعلى المعرّفات
  assert.deepEqual(shown, [30, 29, 28, 27, 26, 25, 24, 23, 22, 21]);
  // لا قطع في التوكن الزمني ولا في المنشن: نزيل التوكنات السليمة ثم نبحث عن بادئات معلّقة
  for (const f of payload.embeds[0].fields) {
    const stripped = f.value
      .replace(/<t:\d+:[A-Za-z]>/g, '')
      .replace(/<@!?\d{15,22}>/g, '')
      .replace(/<#\d+>/g, '')
      .replace(/<a:[\w]+:\d+>/g, '')
      .replace(/<:[\w]+:\d+>/g, '');
    assert(!/<\/?(t:|@!?|#|a:)/.test(stripped), `توكن معلّق: ${stripped.slice(-60)}`);
  }
  assertWithinDiscordLimits(payload.embeds[0], 'staff-logs p1');
});

test('/staff-logs يرقّم الصفحات فعلياً ويعرض كل سجل مُجلب عبر الصفحات', async () => {
  seedLogs(30);
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);
  const navIds = buttonIds(i.payload).filter(id => id.startsWith('staff-logs:page:'));
  assert(navIds.length, 'يوجد صف تنقّل');
  const next = navIds.find(id => /:2:/.test(id));
  assert(next, `زر الصفحة 2 موجود: ${navIds.join(', ')}`);

  const seen = new Set(rowsShown(i.payload));
  const p2 = interaction({ customId: next });
  await resolveComponent(next).handler(p2, resolveComponent(next).args);
  assert.equal(p2.deferred, false, 'المعالج ينهي التفاعل ولا يتركه معلّقاً');
  assert(p2.payload, 'الصفحة 2 تُرسم');
  const shown2 = rowsShown(p2.payload);
  assert.equal(shown2.length, 10, `الصفحة 2 تعرض ${shown2.length} صفاً`);
  assert.deepEqual(shown2, [20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
  for (const id2 of shown2) seen.add(id2);
  // 20 صفاً من أصل 30 — ولا صف يُعرض مرتين ولا يُسقط
  assert.equal(seen.size, 20, `مجموع الصفحتين ${seen.size}`);
  assertWithinDiscordLimits(json(p2.payload).embeds[0], 'staff-logs p2');
});

test('صفحة /staff-logs تُعلن عدد الصفوف المعروضة فعلاً لا عدد السجلات الكلّي', async () => {
  seedLogs(30);
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);

  // صف التنقّل لا يقفز إلى الصفحة الأخيرة مباشرة، فنتقدّم «التالي» حتى يعطَّل.
  const pages = [];
  let current = i;
  for (let guard = 0; guard < 10; guard++) {
    const e = json(current.payload).embeds[0];
    pages.push({ shown: rowsShown(current.payload), e });
    const here = Number((e.footer.text.match(/صفحة (\d+)\//) || [])[1]);
    // زر «التالي» هو الذي رقم صفحته here+1 — لا أول زر مفعّل (وإلا تناوب مع «السابق»)
    const next = json(current.payload).components.flatMap(r => r.components)
      .find(c => !c.disabled && Number(c.custom_id?.split(':')[2]) === here + 1);
    if (!next) break;
    const clicked = interaction({ customId: next.custom_id });
    await resolveComponent(next.custom_id).handler(clicked, resolveComponent(next.custom_id).args);
    current = clicked;
  }

  // ثلاث صفحات × 10 صفوف = 30 سجلاً بلا نقص ولا تكرار
  assert.equal(pages.length, 3, `عدد الصفحات ${pages.length}`);
  for (const [n, p] of pages.entries()) {
    const declared = Number((p.e.description.match(/عرض\s*(\d+)/) || [])[1]);
    assert.equal(declared, p.shown.length, `صفحة ${n + 1}: الوعد ${declared} والحقيقة ${p.shown.length}`);
    assert.match(p.e.footer.text, new RegExp(`صفحة ${n + 1}/3`), 'التذييل يحمل رقم الصفحة');
    assertWithinDiscordLimits(p.e, `page ${n + 1}`);
  }
  assert.equal(pages[2].shown.length, 10, 'الصفحة الأخيرة ممتلئة');
  assert.equal(pages.flatMap(p => p.shown).length, 30, 'كل السجلات ظهرت مرة واحدة');
});

test('/staff-logs يختار خيارات عدد صحيحة محدودة بدل نص يُحلَّل يدوياً', () => {
  const data = commands.get('staff-logs').data.toJSON();
  const opt = name => data.options.find(o => o.name === name);
  // 3 = STRING، 4 = INTEGER في تعداد ApplicationCommandOptionType
  assert.equal(opt('limit').type, 4, 'limit عدد صحيح');
  assert.equal(opt('limit').min_value, 1);
  // السقف منخفض عمداً: صفحة أكبر من ذلك تُجبر البناء على قصّ صفوف.
  assert.equal(opt('limit').max_value, staffLogs.__testing.MAX_PAGE_SIZE);
  assert.equal(opt('days').type, 4, 'days عدد صحيح');
  assert.equal(opt('days').min_value, 1);
  assert.equal(opt('days').max_value, 365);
  // الوصف يجب أن يطابق السلوك: لا فلتر افتراضي على الأيام
  assert(!/الافتراضي:\s*7/.test(opt('days').description), `وصف days يكذب: ${opt('days').description}`);
  assert.match(opt('days').description, /بلا فلتر افتراضياً/);
});

test('/staff-logs لا يسقط أي صف مُجلب في أي صفحة مهما بلغ العدد', async () => {
  // 137 سجلاً = نافذة (100) + 37 خارجها. كل صفحة يجب أن تعرض ما تعدّ به،
  // ومجموع الصفحات يجب أن يغطّي النافذة كاملة بلا تكرار ولا نقص.
  seedLogs(137);
  const seen = [];
  let customId = null;
  for (let page = 1; page <= 7; page++) {
    const i = customId
      ? interaction({ customId })
      : interaction({ integers: { limit: 15 } });
    if (customId) await resolveComponent(customId).handler(i, resolveComponent(customId).args);
    else await commands.get('staff-logs').execute(i);
    const e = json(i.payload).embeds[0];
    const shown = rowsShown(i.payload);
    const declared = Number((e.description.match(/عرض\s*(\d+)/) || [])[1]);
    assert.equal(declared, shown.length, `صفحة ${page}: الوعد ${declared} والحقيقة ${shown.length}`);
    seen.push(...shown);
    assertWithinDiscordLimits(e, `staff-logs page ${page}`);
    const nav = buttonIds(i.payload).filter(id => id.startsWith('staff-logs:page:'));
    const nextPage = nav.map(id => Number(id.split(':')[2])).filter(n => n === page + 1)[0];
    if (!nextPage) break;
    customId = nav.find(id => id.split(':')[2] === String(nextPage));
  }
  assert.equal(seen.length, 100, `مجموع ما ظهر ${seen.length} من نافذة 100`);
  assert.equal(new Set(seen).size, 100, 'لا تكرار بين الصفحات');
  assert.deepEqual(seen.slice().sort((a, b) => a - b), Array.from({ length: 100 }, (_, k) => k + 38),
    'يغطي الأحدث 100 مرتّبة من 137 نزولاً إلى 38');
});

test('صفحة /staff-logs الأخيرة لا تترك تفاعلاً معلّقاً', async () => {
  seedLogs(30);
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);
  const navIds = buttonIds(i.payload).filter(id => id.startsWith('staff-logs:page:'));
  const last = Math.max(...pageNumbers(i.payload));
  const target = navIds.find(id => id.split(':')[2] === String(last));
  const p = interaction({ customId: target });
  await resolveComponent(target).handler(p, resolveComponent(target).args);
  assert.equal(p.deferred, false, 'لا deferUpdate معلّق');
  assert.equal(p.updated, true, 'استُعمل update');
  assertWithinDiscordLimits(json(p.payload).embeds[0], 'staff-logs last');
});

test('/staff-logs يتحقق من مُرشِّح المستخدم ولا يضع نصاً خاماً في منشن', async () => {
  seedStaff(IDS.peer);
  seedLogs(3);
  const i = interaction({ strings: { user: 'not-a-real-user' } });
  await commands.get('staff-logs').execute(i);
  const text = JSON.stringify(json(i.payload).embeds[0]);
  assert(!text.includes('<@not-a-real-user>'), `منشن خام: ${text.slice(0, 200)}`);
});

test('معالج ترقيم /staff-logs محمي بصلاحية الإدارة العليا', () => {
  const entry = resolveComponent('staff-logs:page:2');
  assert(entry, 'المكوّن مسجّل');
  assert.equal(entry.entry.level, LEVELS.MANAGEMENT, `المستوى ${entry.entry.level}`);
});

// ===== دمج /audit-log و/audit-export في /staff-logs =====

test('السجل بعد الدمج: بقي /staff-logs وأُزيل الأوامر المكرّرة', () => {
  assert(commands.has('staff-logs'), 'الأمر الناجي موجود');
  assert(!commands.has('audit-log'), 'أُزيل /audit-log المكرّر');
  assert(!commands.has('audit-export'), 'أُزيل /audit-export — استُوعب في زر التصدير');
});

test('الترقيم بعد الدمج: زر التصدير لا يزاحم مسار الصفحات', async () => {
  seedLogs(30);
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);

  // زر التصدير ظاهر في نفس صف التنقّل ومعاملاته مطابقة لمعاملات العرض.
  const exportId = buttonIds(i.payload).find(id => id.startsWith('staff-logs:export:'));
  assert(exportId, `زر التصدير موجود: ${buttonIds(i.payload).join(', ')}`);

  // كل مسار يُحلّ إلى معالجه الخاص — لا تداخل بين المعرّفين.
  const page = resolveComponent('staff-logs:page:2:10:0:::0');
  const exp = resolveComponent(exportId);
  assert(page && page.handler, 'مسار الصفحات يُوجَد');
  assert(exp && exp.handler, 'مسار التصدير يُوجَد');
  assert.notEqual(page.handler, exp.handler, 'مساران مختلفان لا معالج واحد');

  const p = interaction({ customId: 'staff-logs:page:2:10:0:::0' });
  await page.handler(p, page.args);
  assert(p.updated, 'الصفحة 2 تُنهي التفاعل بالتحديث');
  assert(p.payload?.embeds?.length, 'الصفحة 2 تُرسم');
  assert.deepEqual(rowsShown(p.payload), [20, 19, 18, 17, 16, 15, 14, 13, 12, 11]);
});

test('تصدير CSV بعد الدمج يُنتج ملفاً بصفوف حقيقية من الخدمة نفسها', async () => {
  // البذور عبر الخدمة الحقيقية لا عبر SQL مباشر — نفس مسار الإنتاج.
  for (let k = 1; k <= 3; k++) {
    audit.record({
      action: 'staff_warning_issued', actorId: IDS.me, targetId: IDS.peer,
      details: { note: `سجل تصدير ${k}` }, channelId: IDS.channel,
    });
  }
  const i = interaction({ integers: { limit: 10 } });
  await commands.get('staff-logs').execute(i);
  const exportId = buttonIds(i.payload).find(id => id.startsWith('staff-logs:export:'));
  assert(exportId, 'زر التصدير موجود');

  const resolved = resolveComponent(exportId);
  const e = interaction({ customId: exportId });
  await resolved.handler(e, resolved.args);

  const file = e.payload.files?.[0];
  assert(file, 'الرد يحمل ملفاً');
  assert.match(file.name, /^staff-logs-\d{4}-\d{2}-\d{2}\.csv$/, `اسم الملف: ${file.name}`);
  const csv = Buffer.isBuffer(file.attachment) ? file.attachment.toString('utf-8') : String(file.attachment);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4, `رأس + ثلاثة صفوف، حصلنا على ${lines.length}`);
  assert.ok(lines[0].includes('الإجراء') && lines[0].includes('المنفذ'), `الرأس: ${lines[0]}`);
  assert.equal((csv.match(/staff_warning_issued/g) || []).length, 3, 'الصفوف الثلاث في الملف');
  assert.ok(csv.includes(`<@${IDS.peer}>`), 'الهدف في الملف');
});

test('الدمج لا يوسّع الوصول: بقيت صلاحية /audit-log القديمة بالضبط', () => {
  // المستوى القديم المسجَّل لـ /audit-log قبل الدمج: LEVELS.MANAGEMENT (4) —
  // ومستوى /audit-export المُزيل كان الموقف نفسه.
  const cmd = commands.get('staff-logs');
  assert.equal(cmd.level, LEVELS.MANAGEMENT, `مستوى الأمر الناجي: ${cmd.level}`);

  const low = { level: LEVELS.STAFF, team: 'support', admin: false, serverManager: false, suspended: false };
  const ok = { ...low, level: LEVELS.MANAGEMENT };
  assert.ok(commandAccessError(cmd, low), 'إداري بمستوى أدنى يُرفض');
  assert.equal(commandAccessError(cmd, ok), null, 'الإدارة العليا تمر');

  for (const id of ['staff-logs:page:2:10:0:::0', 'staff-logs:export:10:0:::0']) {
    const entry = resolveComponent(id);
    assert(entry, `${id} مسجّل`);
    assert.equal(entry.entry.level, LEVELS.MANAGEMENT, `${id}: ${entry.entry.level}`);
    assert.ok(componentAccessError(entry.entry, low, id), `${id} يرفض مستوى أدنى`);
    assert.equal(componentAccessError(entry.entry, ok, id), null, `${id} يمرّ للإدارة العليا`);
  }
});
