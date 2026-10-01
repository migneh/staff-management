'use strict';
/**
 * اختبارات سلامة البيانات على مستوى القواعد:
 *   1) تذكيرات الإجازة تُرسل مرة واحدة لكل (طلب، نوع) مهما تكرّر التشغيل.
 *   2) النسخة الاحتياطية لا تُقلّم النسخ السليمة قبل أن تنجح نسخة جديدة.
 *   3) التشغيل الأولي للمجدول يمرّ بالحارس: الفشل يُسجَّل ولا يوقف الباقي.
 *   4) إزالة رتبة الإجازة تنتهي عند عضو غادر السيرفر بدل أن تُعاد إلى الأبد.
 */
require('./sqlite-compat').install();
process.env.DB_PATH = ':memory:';
process.env.DOTENV_CONFIG_QUIET = 'true';

const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const { openMemoryDb, getDb } = require('../src/database');
const settings = require('../src/services/settings');
const leaves = require('../src/services/leaves');
const scheduler = require('../src/scheduler');
const backup = require('../src/services/backup');
const config = require('../src/config');
const { today, addDays } = require('../src/utils');

const TMP = () => fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'staff-dl-'));

// ===== عميل ديسكورد وهمي: نعدّ ما يُرسَل فعلاً =====

/**
 * @param {'present'|'gone'|'transient'} state.memberMode
 *   present   → العضو موجود ومعه رتبه
 *   gone      → ديسكورد: Unknown Member (10007) أي غادر السيرفر
 *   transient → خطأ عابر (لا رمز «عضو غير موجود») فيجب إعادة المحاولة
 */
function makeClient(state = {}) {
  state.dms = [];
  state.channels = [];
  state.memberFetches = [];
  const roleCache = new Map([['vac-role', { id: 'vac-role', name: 'in vacation' }]]);
  const member = {
    id: 'u1',
    guild: { roles: { cache: roleCache } },
    roles: { cache: new Map(), async add(r) { this.cache.set(r.id, r); }, async remove(r) { this.cache.delete(r.id); } },
  };
  const guild = {
    members: {
      cache: new Map(),
      fetch: async (id) => {
        state.memberFetches.push(id);
        if (state.memberMode === 'present') return member;
        if (state.memberMode === 'transient') { const e = new Error('ECONNRESET'); e.code = 50001; throw e; }
        const e = new Error('Unknown Member'); e.code = 10007; throw e;
      },
    },
  };
  const client = {
    guilds: { cache: new Map([[config.guildId || 'g1', guild]]) },
    channels: {
      fetch: async (id) => ({
        id,
        send: async (payload) => { state.channels.push({ channel: id, payload }); return { id: `m${state.channels.length}` }; },
        messages: { fetch: async () => ({ edit: async () => {} }) },
      }),
    },
    users: { fetch: async (id) => ({ id, send: async (payload) => { state.dms.push({ user: id, payload }); return true; } }) },
  };
  return { client, state, member };
}

const title = (payload) => String(payload?.embeds?.[0]?.data?.title || '');
const countDms = (state, needle) => state.dms.filter(d => title(d.payload).includes(needle)).length;
const countChannel = (state, needle) => state.channels.filter(c => title(c.payload).includes(needle)).length;

function addStaff(userId = 'u1', status = 'active') {
  getDb().prepare(`INSERT INTO staff_members (user_id, username, team, rank, status) VALUES (?, 'tester', 'support', 'Support', ?)`)
    .run(userId, status);
}

function addLeave({ userId = 'u1', status = 'approved', start, end, createdAt = null }) {
  const db = getDb();
  const res = db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, status)
    VALUES (?, 'normal', 'سبب', ?, ?, ?)`).run(userId, start, end, status);
  if (createdAt) db.prepare('UPDATE leave_requests SET created_at = ? WHERE id = ?').run(createdAt, res.lastInsertRowid);
  return Number(res.lastInsertRowid);
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').slice(0, 19);

/** محاكاة مرور يوم: نفس ما يفعله التقويم للتواريخ المخزّنة. */
function shiftLeave(id, days) {
  const db = getDb();
  const row = db.prepare('SELECT start_date, end_date FROM leave_requests WHERE id = ?').get(id);
  db.prepare('UPDATE leave_requests SET start_date = ?, end_date = ? WHERE id = ?')
    .run(addDays(row.start_date, days), addDays(row.end_date, days), id);
}

beforeEach(() => {
  openMemoryDb();
  scheduler.clearRunningTasks();
  settings.setChannel('leave-requests', 'C-leave');
  settings.setChannel('staff-alerts', 'C-alerts');
  settings.setChannel('staff-logs', 'C-logs');
});

// ===== 1) تذكيرات الإجازة: مرة واحدة لكل نوع =====

test('تذكير البداية والنهاية يُرسَلان مرة واحدة عبر تشغيل ثانٍ في اليوم التالي', async () => {
  const { client, state } = makeClient({ memberMode: 'gone' });
  addStaff();
  const t = today();
  const id = addLeave({ start: addDays(t, 1), end: addDays(t, 2) });

  await scheduler.processLeaves(client);            // اليوم 0: تذكير بداية
  assert.equal(countDms(state, 'تذكير بداية الإجازة'), 1);
  assert.equal(countDms(state, 'تذكير نهاية الإجازة'), 0);

  await scheduler.processLeaves(client);            // اليوم 0 مرة أخرى
  assert.equal(countDms(state, 'تذكير بداية الإجازة'), 1, 'تكرار في نفس اليوم');

  shiftLeave(id, -1);                               // اليوم 1: تنتهي غداً
  await scheduler.processLeaves(client);
  assert.equal(countDms(state, 'تذكير نهاية الإجازة'), 1);
  await scheduler.processLeaves(client);
  assert.equal(countDms(state, 'تذكير نهاية الإجازة'), 1, 'تكرار في نفس اليوم');

  shiftLeave(id, -1);                               // اليوم 2: الإجازة سارية
  await scheduler.processLeaves(client);
  shiftLeave(id, -1);                               // اليوم 3: انتهت + تنبيه عدم العودة
  await scheduler.processLeaves(client);
  assert.equal(countChannel(state, 'لم يعد من الإجازة'), 1);

  const kinds = leaves.remindersFor(id);
  assert.equal(new Set(kinds).size, kinds.length, `تكرار في يوميات الطلب: ${kinds.join(',')}`);
  for (const kind of ['start', 'end', 'overdue']) assert.ok(kinds.includes(kind), `لم يُسجَّل تذكير ${kind}`);
});

test('إجازة يوم واحد: تذكيرا البداية والنهاية لا يمحو أحدهما الآخر', async () => {
  // العيب: 'start' ثم 'end' في الدورة نفسها، وكلاهما كان يكتب من لقطة واحدة،
  // فتمحو الثانيةُ الأولى، فتبعث الدورة التالية تذكير البداية **مرة ثانية**.
  const { client, state } = makeClient({ memberMode: 'gone' });
  addStaff();
  const t = today();
  const id = addLeave({ start: addDays(t, 1), end: addDays(t, 1) });

  await scheduler.processLeaves(client);
  assert.equal(countDms(state, 'تذكير بداية الإجازة'), 1);
  assert.equal(countDms(state, 'تذكير نهاية الإجازة'), 1);

  await scheduler.processLeaves(client);            // الدورة الثانية في اليوم نفسه
  assert.equal(countDms(state, 'تذكير بداية الإجازة'), 1, 'تذكير بداية مكرّر في يوم واحد');
  assert.equal(countDms(state, 'تذكير نهاية الإجازة'), 1, 'تذكير نهاية مكرّر في يوم واحد');
  assert.deepEqual(leaves.remindersFor(id).sort(), ['end', 'start']);
});

test('التصعيد يُرسل مرة واحدة بزروف مراجعة حيّة مهما تكرّر تشغيل المهمة', async () => {
  const { client, state } = makeClient({ memberMode: 'gone' });
  const t = today();
  const id = addLeave({ status: 'pending', start: addDays(t, 5), end: addDays(t, 6), createdAt: daysAgo(3) });

  await scheduler.processLeaves(client);
  const escalations = state.channels.filter(c => c.payload.components?.length);
  assert.equal(escalations.length, 1, 'التصعيد الأول يجب أن يحمل أزرار مراجعة');
  assert.equal(escalations[0].channel, 'C-leave');

  await scheduler.processLeaves(client);
  await scheduler.processLeaves(client);
  assert.equal(state.channels.filter(c => c.payload.components?.length).length, 1, 'تصعيد مكرّر بأزرار حيّة');
  assert.equal(leaves.remindersFor(id).includes('escalate'), true);
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='leave_escalated'").get().c, 1);
});

test('لا تصعيد ولا أزرار مراجعة لطلب سقط في نفس الدورة قبل تصعيده', async () => {
  const { client, state } = makeClient({ memberMode: 'gone' });
  const t = today();
  // طلب انتهت مدته: الخطوة 0 تلغيه، ثم كان الكود القديم يصعّده من مصفوفة
  // `pendingRows` القديمة — فيصل المراجع أزرار approve/reject لطلبٍ ملغى.
  const id = addLeave({ status: 'pending', start: addDays(t, -3), end: addDays(t, -1), createdAt: daysAgo(3) });
  await scheduler.processLeaves(client);
  assert.equal(getDb().prepare('SELECT status FROM leave_requests WHERE id = ?').get(id).status, 'cancelled');
  assert.equal(state.channels.filter(c => c.payload.components?.length).length, 0, 'أُرسلت أزرار مراجعة لطلب ملغى');
  assert.equal(leaves.remindersFor(id).includes('escalate'), false);
});

test('مطالبات متداخلة لنفس الطلب: تسجيل واحد لكل نوع بلا تكرار في العمود', () => {
  const t = today();
  const id = addLeave({ start: addDays(t, 1), end: addDays(t, 3) });
  // ترتيب يصلح سباق الكتابة: نوع أ، ثم نوع ب، ثم النوع أ مرة أخرى.
  assert.equal(leaves.claimReminder(id, 'start'), true);
  assert.equal(leaves.claimReminder(id, 'end'), true);
  assert.equal(leaves.claimReminder(id, 'start'), false, 'مطالبة ثانية لنفس النوع');
  assert.equal(leaves.claimReminder(id, 'end'), false);
  assert.equal(leaves.claimReminder(id, 'overdue'), true);
  assert.deepEqual(leaves.remindersFor(id), ['start', 'end', 'overdue']);

  // اللقطة القديمة المُمرَّرة من المجدول لا تصنع «حقاً جديداً» بالإرسال:
  assert.equal(leaves.markReminder(id, 'start', 'start'), false, 'لقطة قديمة أعادت تذكيراً مُرسَلاً');
  assert.equal(leaves.markReminder(id, '', 'start'), false, 'لقطة فارغة أعادت تذكيراً مُرسَلاً');
  // مفتاح مركّب لا يخترق فحص الفواصل:
  assert.equal(leaves.claimReminder(id, 'start,end'), false);
  // طلب غير موجود: لا مطالبة (لا إرسال لشيء لا وجود له):
  assert.equal(leaves.claimReminder(999999, 'start'), false);
  assert.deepEqual(leaves.remindersFor(id), ['start', 'end', 'overdue']);
});

// ===== 2) النسخ الاحتياطي: الفحص قبل التقليم =====

function withBackupEnv(fn) {
  const dir = TMP();
  const saved = { dbPath: config.dbPath, dir: config.backup.dir, keep: config.backup.keep };
  config.dbPath = path.join(dir, 'staff.db');
  config.backup.dir = path.join(dir, 'backups');
  config.backup.keep = 2;
  fs.mkdirSync(config.backup.dir, { recursive: true });
  const restore = () => { config.dbPath = saved.dbPath; config.backup.dir = saved.dir; config.backup.keep = saved.keep; };
  const cleanup = () => { restore(); fs.rmSync(dir, { recursive: true, force: true }); };
  try { return Promise.resolve(fn(dir, cleanup)).finally(cleanup); } catch (e) { cleanup(); throw e; }
}

/**
 * يجعل النسخة الجديدة تفشل الفحص: نُخفي `db.backup` على النسخة本身 فنقع في
 * مسار النسخ العادي، ومصدره ملف فارغ ← «الملف فارغ» ← ok=false.
 * الحجب على نسخة الكائن لا يمسّ أي شيء آخر.
 */
function makeNextBackupUnverifiable() {
  const db = getDb();
  Object.defineProperty(db, 'backup', { value: undefined, configurable: true });
  fs.writeFileSync(config.dbPath, Buffer.alloc(0));
  return () => { delete db.backup; };
}

/** قاعدة sqlite صالحة كمصدر للنسخة (تحاكي data/staff.db). */
function writeValidSourceDb() {
  const DB = require('better-sqlite3');
  const disk = new DB(config.dbPath);
  try {
    disk.exec('CREATE TABLE staff_members (user_id TEXT PRIMARY KEY)');
    disk.prepare('INSERT INTO staff_members (user_id) VALUES (?)').run('u1');
  } finally { disk.close(); }
}

function writeOldBackup(name, mtimeMs) {
  const file = path.join(config.backup.dir, name);
  fs.writeFileSync(file, Buffer.from('old'));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

const OLD = ['staff-2026-01-01T00-00-00-000Z-a.db', 'staff-2026-01-02T00-00-00-000Z-b.db', 'staff-2026-01-03T00-00-00-000Z-c.db'];
const seedOldBackups = () => OLD.forEach((name, i) => writeOldBackup(name, Date.now() - (10 - i) * 60000));

test('نسخة جديدة تفشل فحصها: النسخ السابقة كلها تبقى على القرص', async () => {
  await withBackupEnv(async (dir) => {
    seedOldBackups();
    const restore = makeNextBackupUnverifiable();
    try {
      // keep=2: الكود القديم كان يحذف ثلث النسخ السليمة **قبل** الفحص.
      await assert.rejects(backup.createBackup({ reason: 'test' }));
    } finally { restore(); }
    for (const name of OLD) {
      assert.equal(fs.existsSync(path.join(dir, 'backups', name)), true, `حُذفت النسخة السليمة ${name} قبل التحقق من الجديدة`);
    }
  });
});

test('نسخة جديدة سليمة: التقليم يعمل (الحماية لم تُعطّل التدوير)', async () => {
  await withBackupEnv(async (dir) => {
    seedOldBackups();
    writeValidSourceDb();
    const db = getDb();
    Object.defineProperty(db, 'backup', { value: undefined, configurable: true });
    try {
      const file = await backup.createBackup({ reason: 'ok' });
      assert.equal(backup.verify(file).ok, true, 'النسخة السليمة يجب أن تفحص بنجاح');
    } finally { delete db.backup; }
    const left = fs.readdirSync(path.join(dir, 'backups')).filter(n => /^staff-.*\.db$/.test(n));
    assert.equal(left.length, 2, `التقليم لم يعمل: ${left.length} نسخة باقية (المتوقع 2)`);
  });
});

test('نسخة لم يُتحقَّق منها تُبلّغ «غير معروف» لا «سليمة»', () => {
  const dir = TMP();
  try {
    const file = path.join(dir, 'staff-unknown.db');
    fs.writeFileSync(file, Buffer.alloc(64));
    const original = Module._load;
    Module._load = function (request, ...rest) {
      if (request === 'better-sqlite3') { const e = new Error("Cannot find module 'better-sqlite3'"); e.code = 'MODULE_NOT_FOUND'; throw e; }
      return original.call(this, request, ...rest);
    };
    let check;
    try { check = backup.verify(file); } finally { Module._load = original; }
    assert.equal(check.ok, null, `نسخة لم تُفحص|report ok=${check.ok}`);
    assert.match(check.detail, /لم يُتحقَّق/);
    const row = getDb().prepare('SELECT ok FROM backup_checks ORDER BY id DESC LIMIT 1').get();
    assert.equal(row.ok, -1, 'يجب حفظ «غير معروف» بقيمة منفصلة عن 0 و1');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ===== 3) التشغيل الأولي يمرّ بالحارس =====

test('فشل مهمة في التشغيل الأولي يُسجَّل في job_runs ولا يوقف الباقي', async () => {
  const { client } = makeClient({ memberMode: 'gone' });
  addStaff();
  // نكسر مهمة واحدة فقط: جدول المهام مفقود ⇒ processTaskReminders يرمي.
  getDb().exec('DROP TABLE staff_tasks');

  // الدوال الخام (السلوك القديم): الفشل يختفي بلا أثر — لا سجل، ولا
  // /system-status، ولا degraded في /healthz.
  await assert.rejects(scheduler.processTaskReminders(client), /staff_tasks/);
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM job_runs').get().c, 0, 'فشل التشغيل الأولي الخام ترك أثراً؟');

  await scheduler.bootstrap(client);
  const runs = scheduler.status();
  assert.equal(runs['task-reminders'].ok, false, 'المهمة الفاشلة لم تُسجَّل فاشلة');
  assert.match(String(runs['task-reminders'].error), /staff_tasks/);
  for (const name of ['absence', 'suspensions', 'leaves', 'resignations']) {
    assert.equal(runs[name]?.ok, true, `المهمة ${name} لم تعمل رغم فشل أخرى`);
  }
  assert.deepEqual(
    getDb().prepare('SELECT job FROM job_runs WHERE ok = 0').all().map(r => r.job),
    ['task-reminders'],
  );
});

test('قفل منع التكرار: تشغيل أولي متداخل لا يعمل مرتين ولا يضاعف الرسائل', async () => {
  const { client, state } = makeClient({ memberMode: 'gone' });
  addStaff();
  // عضو غائب فعلاً حتى يُرسل فحص الغياب تنبيهاً قابلاً للعدّ.
  getDb().prepare('UPDATE staff_members SET last_activity = ?, joined_at = ? WHERE user_id = ?')
    .run(daysAgo(5), daysAgo(5), 'u1');
  // نُبطئ أول إرسال على القناة حتى تبقى الدورة الأولى في flight عند إطلاق الثانية.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const realFetch = client.channels.fetch;
  let waits = 0;
  client.channels.fetch = async (id) => {
    waits += 1;
    if (waits === 1) await gate;
    return realFetch(id);
  };
  const first = scheduler.bootstrap(client);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const second = scheduler.bootstrap(client);
  release();
  await Promise.all([first, second]);

  // بلا القفل: فحص الغياب مرتان ⇒ تنبيهان عن العضو نفسه في القناة نفسها.
  assert.equal(countChannel(state, 'غياب 96 ساعة'), 1);
  // والقفل على مستوى الاسم: الدورة الثانية لا تُسجَّل أصلاً (تخطّي لا فشل).
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM job_runs WHERE job = 'absence'").get().c, 1);
});

test('stop() يلغي مؤقّت التشغيل الأولي فلا يعمل مرتين', () => {
  const realSet = global.setTimeout;
  const realClear = global.clearTimeout;
  const created = [];
  global.setTimeout = (cb, ms, ...args) => {
    if (ms === 10_000) { const h = { ms, cleared: false }; created.push(h); return h; }
    return realSet(cb, ms, ...args);
  };
  global.clearTimeout = (h) => {
    if (h && typeof h === 'object' && h.ms === 10_000) { h.cleared = true; return; }
    return realClear(h);
  };
  try {
    const { client } = makeClient({ memberMode: 'gone' });
    scheduler.start(client);
    scheduler.stop();
  } finally {
    global.setTimeout = realSet;
    global.clearTimeout = realClear;
  }
  assert.equal(created.length, 1, 'لم يُجدوَل مؤقّت التشغيل الأولي');
  assert.equal(created[0].cleared, true, 'stop() لم يلغِ مؤقّت التشغيل الأولي — سيعمل مرة أخرى بعد start');
  assert.equal(getDb().prepare('SELECT COUNT(*) c FROM job_runs').get().c, 0, 'عمل التشغيل الأولي قبل إلغائه');
});

// ===== 4) إنهاء إزالة الرتبة عند مغادرة العضو للسيرفر =====

test('عضو غادر السيرفر أثناء إجازته: تُغلق العملية ولا تُعاد كل يوم', async () => {
  const { client, state } = makeClient({ memberMode: 'gone' });
  const t = today();
  addLeave({ status: 'ended', start: addDays(t, -10), end: addDays(t, -8) });
  addLeave({ status: 'cancelled', start: addDays(t, -30), end: addDays(t, -29) });

  await scheduler.processLeaves(client);
  const afterFirst = state.memberFetches.length;
  assert.ok(afterFirst > 0, 'لم يُجلب العضو أصلاً');
  const closed = getDb().prepare("SELECT reminders_sent FROM leave_requests WHERE status IN ('ended','cancelled')").all();
  assert.ok(closed.every(r => r.reminders_sent.includes('role_gone')), 'لم تُغلق طلبات عضو غادر السيرفر');
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='leave_role_cleanup_resolved'").get().c, 2);

  await scheduler.processLeaves(client);
  assert.equal(state.memberFetches.length, afterFirst, 'العضو المغادر يُجلب كل يوم إلى الأبد بلا فائدة');
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM audit_logs WHERE action='leave_role_cleanup_resolved'").get().c, 2);
});

test('تعذّر الجلب مؤقتاً لا يُغلق الطلب: يُعاد في الدورة التالية', async () => {
  const { client, state } = makeClient({ memberMode: 'transient' });
  const t = today();
  addLeave({ status: 'ended', start: addDays(t, -10), end: addDays(t, -8) });

  await scheduler.processLeaves(client);
  assert.equal(state.memberFetches.length, 1);
  assert.equal(getDb().prepare("SELECT COUNT(*) c FROM leave_requests WHERE reminders_sent LIKE '%role_gone%'").get().c, 0,
    'خطأ شبكة عابر لا يجوز أن يُقرأ «غادر السيرفر» فيُغلق الطلب نهائياً');

  await scheduler.processLeaves(client);
  assert.equal(state.memberFetches.length, 2, 'لم تُعد المحاولة في الدورة التالية');
});
