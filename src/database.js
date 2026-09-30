'use strict';
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const config = require('./config');

let db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS staff_members (
   user_id TEXT PRIMARY KEY,
   username TEXT,
   team TEXT NOT NULL,            -- support | moderation
   rank TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'active',
   joined_at TEXT NOT NULL DEFAULT (datetime('now')),
   rank_since TEXT NOT NULL DEFAULT (datetime('now')),
   last_activity TEXT,
   absence_alert_level INTEGER NOT NULL DEFAULT 0, -- 0 none, 1 dm sent, 2 staff alert sent
   probation_exempt INTEGER NOT NULL DEFAULT 0,
   supervisor_rating INTEGER,     -- تقييم المشرف (5-25)
   team_interaction INTEGER,      -- التفاعل مع الفريق (5-25)
   response_speed INTEGER,        -- سرعة الاستجابة للإشراف (5-25)
   onboarding_ready INTEGER NOT NULL DEFAULT 0,
   onboarding_approved_by TEXT,
   onboarding_approved_at TEXT,
   mentor_id TEXT,                -- معرف المرشد للتأهيل
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- تاريخ الرتب: الترقيات والتنزيلات والإزالة — كانت الرتب تُكتب فوق نفسها فلا يمكن
-- الإجابة على «من رقّى مَن ومتى؟»
CREATE TABLE IF NOT EXISTS staff_rank_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  team TEXT,
  from_rank TEXT,
  to_rank TEXT,
  change_type TEXT NOT NULL,     -- promote | demote | reassign | remove | reinstate
  reason TEXT,
  actor_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rank_history_user ON staff_rank_history(user_id, created_at);

-- تجميع شهري للنشاط: يبقى بعد تقليم السجلات الخام
CREATE TABLE IF NOT EXISTS activity_monthly (
  user_id TEXT NOT NULL,
  month TEXT NOT NULL,           -- YYYY-MM
  messages INTEGER NOT NULL DEFAULT 0,
  weighted REAL NOT NULL DEFAULT 0,
  active_days INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, month)
);

-- نتيجة فحص سلامة كل نسخة احتياطية: نسخة لم تُختبر ليست نسخة
CREATE TABLE IF NOT EXISTS backup_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT,
  size_bytes INTEGER,
  checked_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_type TEXT NOT NULL,     -- ticket | staff | moderation | general
  weight REAL NOT NULL,
  content_hash TEXT,
  day TEXT NOT NULL,              -- YYYY-MM-DD
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_activity_user_day ON activity_logs(user_id, day);

CREATE TABLE IF NOT EXISTS ticket_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id TEXT NOT NULL,
  ticket_owner TEXT NOT NULL,
  claimer TEXT NOT NULL,
  closer TEXT NOT NULL,
  rating INTEGER,
  duration INTEGER,
  logged_by TEXT NOT NULL,
  reopened INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual', -- manual | external_log
  source_message_id TEXT,
  source_channel_id TEXT,
  source_url TEXT,
  ticket_url TEXT,
  closed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ticket_claimer ON ticket_metrics(claimer, closed_at);

-- تقييمات مستقلة عن التكتات: لا يمكن ربط الرسالة بتكت بدون معرف موثوق.
CREATE TABLE IF NOT EXISTS support_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  staff_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  stars INTEGER NOT NULL CHECK(stars BETWEEN 1 AND 5),
  source_message_id TEXT NOT NULL UNIQUE,
  source_channel_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  source_bot_id TEXT NOT NULL,
  rated_at TEXT NOT NULL,
  imported_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_support_ratings_staff_date ON support_ratings(staff_id, rated_at);

CREATE TABLE IF NOT EXISTS mod_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  moderator_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  action_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  duration TEXT,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mod_actions_mod ON mod_actions(moderator_id, created_at);

CREATE TABLE IF NOT EXISTS leave_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  leave_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | ended | cancelled
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  reminders_sent TEXT NOT NULL DEFAULT '', -- csv: start,end,overdue,role_added,role_removed
  role_applied_at TEXT,
  role_removed_at TEXT,
  cancelled_by TEXT,
  cancelled_at TEXT,
  cancel_reason TEXT,
  duration_days INTEGER,                -- مدة الطلب محسوبة
  notice_hours INTEGER,                 -- كم ساعة قبل البداية قُدّم الطلب
  attachment_url TEXT,                  -- رابط تقرير طبي/ إثبات (اختياري)
  role_grant_at TEXT,                   -- التاريخ المخطط لتفعيل الرتبة فيه
  extended_count INTEGER NOT NULL DEFAULT 0,
  extends_from INTEGER,                 -- الطلب الذي مُدِّد منه
  end_reason TEXT,                      -- auto | early | resignation | admin
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leave_user_dates ON leave_requests(user_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_leave_status_dates ON leave_requests(status, start_date, end_date);

CREATE TABLE IF NOT EXISTS resignations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  last_day TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | accepted | rejected | on_hold | withdrawn
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  reminders_sent TEXT NOT NULL DEFAULT '', -- csv: three_day,one_day,overdue
  withdrawn_by TEXT,
  withdrawn_at TEXT,
  withdraw_reason TEXT,
  roles_removed_at TEXT,
  reason_category TEXT,                 -- مفتاح من RESIGNATION_REASONS للتحليلات
  notice_days INTEGER,                 -- فترة الإشعار الفعلية
  remove_roles_at TEXT,                -- تاريخ تنفيذ الإزالة (فارغ = فور القبول)
  exit_interview TEXT,                 -- ملاحظة الإدارة بعد القرار
  notified_reviewers TEXT NOT NULL DEFAULT '',  -- csv: تصعيد تم
  team TEXT,
  rank TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_resignation_status_day ON resignations(status, last_day);

CREATE TABLE IF NOT EXISTS warnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  warning_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  issued_by TEXT NOT NULL,
  voided_at TEXT,
  voided_by TEXT,
  void_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warnings_user ON warnings(user_id, created_at);

CREATE TABLE IF NOT EXISTS warning_appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warning_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by TEXT,
  review_reason TEXT,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_warning_appeals_status ON warning_appeals(status, created_at);

CREATE TABLE IF NOT EXISTS staff_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  note_type TEXT NOT NULL,       -- positive | negative
  content TEXT NOT NULL,
  is_secret INTEGER NOT NULL DEFAULT 0,
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  is_important INTEGER NOT NULL DEFAULT 0,
  created_by TEXT NOT NULL,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL,          -- create | edit | delete
  title TEXT,
  content TEXT,
  category_id INTEGER,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS policy_acknowledgements (
  entry_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  acknowledged_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (entry_id, user_id)
);

CREATE TABLE IF NOT EXISTS faq_panels (
  message_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  created_by TEXT NOT NULL,
  template_id INTEGER NOT NULL DEFAULT 0, -- 0 = اللوحة الافتراضية
  label TEXT,                             -- اسم يميّز اللوحة (مثال: روم الدعم العام)
  sync_status TEXT NOT NULL DEFAULT 'ok', -- ok | error
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category_ids TEXT NOT NULL DEFAULT '[]', -- JSON: التصنيفات التي تظهر في هذا القالب
  pinned_ids TEXT NOT NULL DEFAULT '[]',   -- JSON: مدخلات تظهر أولاً في هذا القالب فقط
  excluded_ids TEXT NOT NULL DEFAULT '[]', -- JSON: مدخلات مخفية في هذا القالب فقط
  note TEXT,                              -- ملاحظة خاصة باللوحة (تظهر لكل من في هذا الروم وحده)
  color INTEGER NOT NULL DEFAULT 5793266,
  created_by TEXT NOT NULL,
  updated_by TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS faq_template_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  action TEXT NOT NULL, -- create | edit | delete
  name TEXT,
  title TEXT,
  description TEXT,
  category_ids TEXT,
  color INTEGER,
  changed_by TEXT NOT NULL,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_faq_template_history ON faq_template_history(template_id, version);

CREATE TABLE IF NOT EXISTS promotion_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  from_rank TEXT NOT NULL,
  to_rank TEXT NOT NULL,
  note TEXT,
  snapshot TEXT,                 -- JSON لحالة الشروط وقت الطلب
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected
  reviewed_by TEXT,
  review_reason TEXT,
  message_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  reviewed_at TEXT
);

CREATE TABLE IF NOT EXISTS promotion_approvals (
  request_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  approved_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (request_id, user_id)      -- صوت واحد لكل شخص لكل طلب
);
CREATE INDEX IF NOT EXISTS idx_promo_approvals_req ON promotion_approvals(request_id);

CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type TEXT NOT NULL,     -- daily | weekly | monthly
  period TEXT NOT NULL,
  data TEXT NOT NULL,            -- JSON
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,
  actor_id TEXT,
  target_id TEXT,
  details TEXT,
  channel_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_id, created_at);

CREATE TABLE IF NOT EXISTS staff_tasks (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   user_id TEXT NOT NULL,
   title TEXT NOT NULL,
   description TEXT,
   task_type TEXT NOT NULL DEFAULT 'general', -- general | onboarding | follow_up | mission | recurring
   due_date TEXT,
   status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | cancelled
   assigned_by TEXT,
   completed_at TEXT,
   reminder_sent_at TEXT,
   mission_id TEXT,          -- reference to mission template
   team_id TEXT,             -- team mission identifier
   priority TEXT DEFAULT 'normal', -- low | normal | high | urgent
   tags TEXT,                -- JSON array of tags
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tasks_user_status ON staff_tasks(user_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON staff_tasks(mission_id);
CREATE INDEX IF NOT EXISTS idx_tasks_team ON staff_tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON staff_tasks(priority, due_date);

-- قوالب المهام — مجموعات مهام محددة مسبقاً يمكن تعيينها لعدة أعضاء
CREATE TABLE IF NOT EXISTS mission_templates (
   id TEXT PRIMARY KEY,           -- unique identifier like 'onboarding_v2', 'security_baseline'
   name TEXT NOT NULL,
   description TEXT NOT NULL,
   category TEXT NOT NULL,        -- onboarding | security | performance | compliance | development
   team TEXT,                     -- applies to specific team or null for all
   tasks TEXT NOT NULL,           -- JSON array of {title, description, due_offset, priority}
   created_by TEXT NOT NULL,
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   is_active INTEGER NOT NULL DEFAULT 1,
   repeat_interval TEXT           -- recurrence: 'weekly', 'monthly', 'quarterly'
);
CREATE INDEX IF NOT EXISTS idx_mission_templates_active ON mission_templates(is_active, category);

-- سجل تنفيذ المهام الجماعية — يتبع تقدم الفريق ككل
CREATE TABLE IF NOT EXISTS mission_progress (
   id INTEGER PRIMARY KEY AUTOINCREMENT,
   mission_id TEXT NOT NULL,
   team_id TEXT,
   user_id TEXT NOT NULL,
   status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | skipped
   completed_at TEXT,
   assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
   FOREIGN KEY (mission_id) REFERENCES mission_templates(id),
   FOREIGN KEY (user_id) REFERENCES staff_members(user_id)
);
CREATE INDEX IF NOT EXISTS idx_mission_progress_mission ON mission_progress(mission_id, user_id);
CREATE INDEX IF NOT EXISTS idx_mission_progress_team ON mission_progress(team_id, status);

-- قوالب طلبات الإجازة — لتسهيل الطلبات المتكررة
CREATE TABLE IF NOT EXISTS leave_templates (
   id TEXT PRIMARY KEY,           -- معرّف القالب مثل 'weekly_family', 'monthly_medical'
   user_id TEXT NOT NULL,         -- صاحب القالب
   name TEXT NOT NULL,            -- اسم القالب المعروض للمستخدم
   description TEXT,              -- وصف القالب
   leave_type TEXT NOT NULL,      -- نوع الإجازة
   default_duration INTEGER,      -- المدة الافتراضية بالأيام
   default_reason TEXT,          -- السبب الافتراضي
   is_public INTEGER NOT NULL DEFAULT 0, -- 0 = خاص، 1 = عام للجميع
   created_at TEXT NOT NULL DEFAULT (datetime('now')),
   updated_at TEXT NOT NULL DEFAULT (datetime('now')),
   FOREIGN KEY (user_id) REFERENCES staff_members(user_id)
);
CREATE INDEX IF NOT EXISTS idx_leave_templates_user ON leave_templates(user_id);
CREATE INDEX IF NOT EXISTS idx_leave_templates_public ON leave_templates(is_public);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- سجل تشغيل المهام المجدولة (يُقرأ في /status)
CREATE TABLE IF NOT EXISTS job_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER NOT NULL DEFAULT 1,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_job ON job_runs(job, id);
`;

function migrate(database) {
  // ترقية قواعد البيانات القديمة بدون فقدان أي سجل.
  const columns = new Set(database.prepare('PRAGMA table_info(ticket_metrics)').all().map(c => c.name));
  const additions = [
    ['source', "TEXT NOT NULL DEFAULT 'manual'"],
    ['source_message_id', 'TEXT'],
    ['source_channel_id', 'TEXT'],
    ['source_url', 'TEXT'],
    ['ticket_url', 'TEXT'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE ticket_metrics ADD COLUMN ${name} ${definition}`);
  }

  const panelColumns = new Set(database.prepare('PRAGMA table_info(faq_panels)').all().map(c => c.name));
  if (!panelColumns.has('template_id')) database.exec('ALTER TABLE faq_panels ADD COLUMN template_id INTEGER NOT NULL DEFAULT 0');
  const addTableColumns = (table, additions) => {
    const existing = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name));
    for (const [name, definition] of additions) if (!existing.has(name)) database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  };
  addTableColumns('leave_requests', [
    ['role_applied_at', 'TEXT'], ['role_removed_at', 'TEXT'], ['cancelled_by', 'TEXT'],
    ['cancelled_at', 'TEXT'], ['cancel_reason', 'TEXT'], ['duration_days', 'INTEGER'],
    ['notice_hours', 'INTEGER'], ['attachment_url', 'TEXT'], ['role_grant_at', 'TEXT'],
    ['extended_count', 'INTEGER NOT NULL DEFAULT 0'], ['extends_from', 'INTEGER'],
    ['end_reason', 'TEXT'],
  ]);
  addTableColumns('resignations', [
    ['reminders_sent', "TEXT NOT NULL DEFAULT ''"], ['withdrawn_by', 'TEXT'],
    ['withdrawn_at', 'TEXT'], ['withdraw_reason', 'TEXT'], ['roles_removed_at', 'TEXT'],
    ['reason_category', 'TEXT'], ['notice_days', 'INTEGER'], ['remove_roles_at', 'TEXT'],
    ['exit_interview', 'TEXT'], ['notified_reviewers', "TEXT NOT NULL DEFAULT ''"],
  ]);
  addTableColumns('faq_templates', [
    ['pinned_ids', "TEXT NOT NULL DEFAULT '[]'"], ['excluded_ids', "TEXT NOT NULL DEFAULT '[]'"],
    ['note', 'TEXT'],
  ]);
  addTableColumns('faq_panels', [
    ['label', 'TEXT'], ['sync_status', "TEXT NOT NULL DEFAULT 'ok'"], ['last_synced_at', 'TEXT'],
  ]);
  database.exec('CREATE INDEX IF NOT EXISTS idx_faq_panels_template ON faq_panels(template_id)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_leave_user_dates ON leave_requests(user_id, start_date, end_date)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_leave_status_dates ON leave_requests(status, start_date, end_date)');
  database.exec('CREATE INDEX IF NOT EXISTS idx_resignation_status_day ON resignations(status, last_day)');
  database.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_ticket_source_message ON ticket_metrics(source_message_id) WHERE source_message_id IS NOT NULL');

  // عمود الإيقاف المؤقت: يمنع بقاء العضو موقوفاً للأبد (كان لا يوجد مسار إلغاء إيقاف)
  addTableColumns('staff_members', [['suspended_until', 'TEXT'], ['onboarding_ready', 'INTEGER NOT NULL DEFAULT 0'], ['onboarding_approved_by', 'TEXT'], ['onboarding_approved_at', 'TEXT'], ['mentor_id', 'TEXT']]);
  addTableColumns('warnings', [['voided_at', 'TEXT'], ['voided_by', 'TEXT'], ['void_reason', 'TEXT']]);
  addTableColumns('ticket_metrics', [['duration_source', 'TEXT'], ['claimed_at', 'TEXT']]);
  // اقتراح تواريخ بديلة من المراجع: لا يغيّر الحالة، ويصل لصاحب الطلب كرسالة خاصة.
  addTableColumns('leave_requests', [['suggested_start', 'TEXT'], ['suggested_end', 'TEXT'], ['suggested_note', 'TEXT'], ['suggested_by', 'TEXT'], ['suggested_at', 'TEXT'],
    // كان يُستخدم في التمديد وقبول الاقتراح دون أن يوجد العمود → خطأ SQL عند التمديد.
    ['updated_at', 'TEXT']]);
  addTableColumns('staff_tasks', [['cancelled_by', 'TEXT'], ['cancelled_at', 'TEXT'], ['reminder_sent_at', 'TEXT'], ['priority', "TEXT NOT NULL DEFAULT 'normal'"], ['tags', "TEXT DEFAULT '[]'"], ['mission_id', 'TEXT'], ['team_id', 'TEXT']]);

// جدول قوالب المهام
const missionTableExists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_templates'`).get();
if (missionTableExists) {
  const columns = new Set(database.prepare('PRAGMA table_info(mission_templates)').all().map(c => c.name));
  const additions = [
    ['category', "TEXT NOT NULL DEFAULT 'general'"],
    ['team', 'TEXT'],
    ['is_active', 'INTEGER NOT NULL DEFAULT 1'],
    ['repeat_interval', 'TEXT'],
    ['updated_at', 'TEXT NOT NULL DEFAULT (datetime(\'now\'))'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE mission_templates ADD COLUMN ${name} ${definition}`);
  }
}

// جدول تقدم المهام الجماعية
const progressTableExists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='mission_progress'`).get();
if (progressTableExists) {
  const columns = new Set(database.prepare('PRAGMA table_info(mission_progress)').all().map(c => c.name));
  const additions = [
    ['assigned_at', 'TEXT NOT NULL DEFAULT (datetime(\'now\'))'],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) database.exec(`ALTER TABLE mission_progress ADD COLUMN ${name} ${definition}`);
  }
database.exec('CREATE INDEX IF NOT EXISTS idx_mission_progress_mission ON mission_progress(mission_id, user_id)');
database.exec('CREATE INDEX IF NOT EXISTS idx_mission_progress_team ON mission_progress(team_id, status)');
}

// جدول قوالب الإجازات
const leaveTemplatesTableExists = database.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='leave_templates'`).get();
if (leaveTemplatesTableExists) {
   const columns = new Set(database.prepare('PRAGMA table_info(leave_templates)').all().map(c => c.name));
   const additions = [
     ['created_at', "TEXT NOT NULL DEFAULT (datetime('now'))"],
     ['updated_at', "TEXT NOT NULL DEFAULT (datetime('now'))"],
   ];
   for (const [name, definition] of additions) {
     if (!columns.has(name)) database.exec(`ALTER TABLE leave_templates ADD COLUMN ${name} ${definition}`);
   }
}
  // تاريخ آخر تقييم بشري: يمنع الاعتماد على تقييم قديم لا يصف الحاضر
  addTableColumns('staff_members', [['human_ratings_at', 'TEXT']]);

  migrateFaqCategories(database);
}

/**
 * ترحيل تصنيفات FAQ: أُزيل تصنيف «قوانين فريق الإشراف» (2) ودُمجت مدخلاته في
 * «قوانين الإدارة» (1)، وأُعيد ترقيم ما بعده ليبقى الترقيم متصلاً 1..10.
 *
 * يعمل مرة واحدة فقط (علامة في جدول settings) حتى لا يُعاد الترقيم مرتين،
 * وكل التغييرات داخل معاملة واحدة: إمّا أن تكتمل أو لا يحدث شيء.
 * جداول السجل (faq_history وfaq_template_history) لا تُمسّ — تبقى كما كُتبت وقتها.
 */
const FAQ_CATEGORY_REMAP = { 1: 1, 2: 1, 3: 2, 4: 3, 5: 4, 6: 5, 7: 6, 8: 7, 9: 8, 10: 9, 11: 10 };
const FAQ_MIGRATION_KEY = 'schema_faq_categories';
const FAQ_MIGRATION_VERSION = '2';

function migrateFaqCategories(database) {
  const done = database.prepare('SELECT value FROM settings WHERE key = ?').get(FAQ_MIGRATION_KEY);
  if (done?.value === FAQ_MIGRATION_VERSION) return;

  const parseIds = (raw) => {
    try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v.map(Number) : []; } catch { return []; }
  };
  const remap = (ids) => [...new Set(ids.map(id => FAQ_CATEGORY_REMAP[id]).filter(id => Number.isInteger(id)))];

  const run = database.transaction(() => {
    const entries = database.prepare('SELECT id, category_id FROM faq_entries').all();
    const moveEntry = database.prepare('UPDATE faq_entries SET category_id = ? WHERE id = ?');
    let moved = 0;
    for (const row of entries) {
      const next = FAQ_CATEGORY_REMAP[row.category_id];
      if (next != null && next !== row.category_id) { moveEntry.run(next, row.id); moved++; }
    }
    // قوالب FAQ تخزّن التصنيفات كمصفوفة JSON — نُعيد ترقيمها بالقاعدة نفسها،
    // فالتصنيف المحذوف (2) يصبح «قوانين الإدارة» (1) بدل أن يختفي محتوى القالب.
    const rows = database.prepare('SELECT id, category_ids FROM faq_templates').all();
    const moveTemplate = database.prepare('UPDATE faq_templates SET category_ids = ? WHERE id = ?');
    for (const row of rows) {
      const before = parseIds(row.category_ids);
      const after = remap(before);
      if (JSON.stringify(before) !== JSON.stringify(after)) moveTemplate.run(JSON.stringify(after), row.id);
    }
    return moved;
  });
  const moved = run();

  database.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(FAQ_MIGRATION_KEY, FAQ_MIGRATION_VERSION);
  if (moved) console.log(`[migrate] FAQ: أُعيد ترقيم ${moved} مدخلاً بعد إزالة تصنيف «قوانين فريق الإشراف».`);
}

function getDb() {
  if (db) return db;
  const dir = path.dirname(config.dbPath);
  if (config.dbPath !== ':memory:' && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

/** لأغراض الاختبار */
function openMemoryDb() {
  db = new Database(':memory:');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

module.exports = { getDb, openMemoryDb, migrateFaqCategories, FAQ_CATEGORY_REMAP };
