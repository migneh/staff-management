'use strict';
const { getDb } = require('../database');
const { nowIso, today, addDays } = require('../utils');
const staffService = require('./staff');

function ensureOnboarding(userId) {
  const db = getDb();
  const existing = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding'").get(userId).c;
  if (existing) return;
  
  // Get mentor info if assigned
  const staffMember = db.prepare("SELECT mentor_id FROM staff_members WHERE user_id = ?").get(userId);
  const mentorId = staffMember?.mentor_id;
  
  const insert = db.prepare('INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by) VALUES (?, ?, ?, \'onboarding\', ?, ?)');
  const start = today();
  const seed = db.transaction(() => {
    insert.run(userId, 'قراءة قاعدة المعرفة الأساسية', 'اقرأ القوانين والسياسات المهمة من /faq.', addDays(start, 2), mentorId || null);
    insert.run(userId, 'قراءة نظام الأداء والترقيات', 'راجع /promotion-info وافهم طريقة احتساب Score والنقاط.', addDays(start, 4), mentorId || null);
    insert.run(userId, 'تأكيد الجاهزية واجتماع مع المرشد', 'أكمل الخطوتين ثم احجز اجتماعاً مع مرشدك لتقييم الجاهزية. بعد ذلك، يراجع المدير جاهزيتك قبل التحويل من التجربة إلى نشط.', addDays(start, 7), mentorId || null);
  });
  seed();
}

/**
 * تعيين مرشد لموظف جديد
 */
function assignMentor(userId, mentorId) {
  const db = getDb();
  // Verify both users exist and are active staff
  const user = db.prepare("SELECT * FROM staff_members WHERE user_id = ? AND status IN ('active', 'probation')").get(userId);
  const mentor = db.prepare("SELECT * FROM staff_members WHERE user_id = ? AND status = 'active'").get(mentorId);
  
  if (!user) return { ok: false, error: 'الموظف غير موجود أو غير نشط' };
  if (!mentor) return { ok: false, error: 'المرشد غير موجود أو غير نشط' };
  if (user.team !== mentor.team) return { ok: false, error: 'يجب أن يكون المرشد من نفس الفريق' };
  
  db.prepare("UPDATE staff_members SET mentor_id = ?, updated_at = ? WHERE user_id = ?")
    .run(mentorId, nowIso(), userId);
    
  return { ok: true, mentor: mentor };
}

/**
 * إزالة مرشد من موظف
 */
function removeMentor(userId) {
  const db = getDb();
  db.prepare("UPDATE staff_members SET mentor_id = NULL, updated_at = ? WHERE user_id = ?")
    .run(nowIso(), userId);
  return { ok: true };
}

/**
 * إنشاء مهمة من قالب
 */
function createFromTemplate(userId, templateId, assignedBy = null) {
  const db = getDb();
  const template = db.prepare('SELECT * FROM mission_templates WHERE id = ? AND is_active = 1').get(templateId);
  if (!template) return null;
  
  const tasks = JSON.parse(template.tasks);
  const startDate = today();
  const createdTasks = [];
  
  const insert = db.prepare('INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by, mission_id, priority, tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  
  for (const taskDef of tasks) {
    const dueDate = taskDef.due_offset ? addDays(startDate, taskDef.due_offset) : null;
    const result = insert.run(
      userId,
      taskDef.title,
      taskDef.description,
      'mission',
      dueDate,
      assignedBy || null,
      templateId,
      taskDef.priority || 'normal',
      '[]'
    );
    createdTasks.push(get(result.lastInsertRowid));
  }
  
  return createdTasks;
}

/**
 * إنشاء مهمة متكررة
 */
function createRecurring(userId, title, description, recurrence, startDate, assignedBy = null) {
  const result = getDb().prepare(`INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by, tags) 
    VALUES (?, ?, ?, 'recurring', ?, ?, ?)`)
    .run(userId, title, description, startDate, assignedBy || null, JSON.stringify({ recurrence }));
  return get(result.lastInsertRowid);
}

function create({ userId, title, description, taskType = 'general', dueDate = null, assignedBy = null, priority = 'normal', tags = [], missionId = null, teamId = null }) {
  const result = getDb().prepare(`INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by, priority, tags, mission_id, team_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, title, description || null, taskType, dueDate || null, assignedBy || null, priority, JSON.stringify(tags), missionId || null, teamId || null);
  return get(result.lastInsertRowid);
}

function get(id) {
  return getDb().prepare('SELECT * FROM staff_tasks WHERE id = ?').get(Number(id)) || null;
}

function list(userId, { includeCompleted = false, limit = 20, offset = 0, taskType = null, missionId = null, teamId = null, priority = null } = {}) {
  let sql = `SELECT * FROM staff_tasks WHERE user_id = ?`;
  const params = [userId];
  
  if (!includeCompleted) sql += " AND status = 'pending'";
  if (taskType) { sql += " AND task_type = ?"; params.push(taskType); }
  if (missionId) { sql += " AND mission_id = ?"; params.push(missionId); }
  if (teamId) { sql += " AND team_id = ?"; params.push(teamId); }
  if (priority) { sql += " AND priority = ?"; params.push(priority); }
  
  sql += ` ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, COALESCE(due_date, '9999-12-31'), id DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);
  
  return getDb().prepare(sql).all(...params);
}

function listPage(userId, { includeCompleted = false, page = 1, taskType = null, missionId = null, teamId = null, priority = null } = {}) {
  let sql = `SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ?`;
  const params = [userId];
  
  if (!includeCompleted) sql += " AND status = 'pending'";
  if (taskType) { sql += " AND task_type = ?"; params.push(taskType); }
  if (missionId) { sql += " AND mission_id = ?"; params.push(missionId); }
  if (teamId) { sql += " AND team_id = ?"; params.push(teamId); }
  if (priority) { sql += " AND priority = ?"; params.push(priority); }
  
  const total = getDb().prepare(sql).all(...params)[0].c;
  const pages = Math.max(1, Math.ceil(total / 5));
  const current = Math.min(Math.max(Number.isSafeInteger(Number(page)) ? Number(page) : 1, 1), pages);
  return { 
    items: list(userId, { includeCompleted, limit: 5, offset: (current - 1) * 5, taskType, missionId, teamId, priority }), 
    page: current, 
    pages, 
    total 
  };
}

function pendingCount(userId, { taskType = null, missionId = null } = {}) {
  let sql = "SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND status = 'pending' AND task_type != 'points_appeal'";
  const params = [userId];
  
  if (taskType) { sql += " AND task_type = ?"; params.push(taskType); }
  if (missionId) { sql += " AND mission_id = ?"; params.push(missionId); }
  
  return getDb().prepare(sql).get(...params).c;
}

/**
 * جلب المهام حسب النوع.
 * ⚠️ userId اختياري لكنه آمن بشكل افتراضي: تمريره يحدّ النتائج لصاحب واحد فقط.
 *    فقط الاستدعاءات التي تحتاج بيانات مستخدمين آخرين (مراجعة تسليم الاستقالة)
 *    تعتمد على حذف هذا الفلتر بشكل صريح عبر allowAllUsers.
 */
function listByType(taskType, { includeCompleted = false, limit = 50, userId = null, allowAllUsers = false } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const scoped = !allowAllUsers && userId !== null && userId !== undefined;
  return getDb().prepare(`SELECT * FROM staff_tasks WHERE task_type = ? ${scoped ? 'AND user_id = ?' : ''} ${includeCompleted ? "" : "AND status = 'pending'"}
    ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, id DESC LIMIT ?`)
    .all(...(scoped ? [taskType, String(userId), safeLimit] : [taskType, safeLimit]));
}

/**
 * إنشاء مهمة جماعية لفريق
 */
function createTeamMission(teamId, title, description, dueDate, assignedBy = null, tags = []) {
  const db = getDb();

  // ⚠️ staff_tasks.user_id هو NOT NULL بلا قيمة افتراضية، لكن المهمة الجماعية "الأم"
  // لا تخصّ شخصاً واحداً — الصف الحقيقي هو الصفوف التي تُنشأ لكل عضو بعده.
  // نستخدم معرّفاً وهمياً "team:<teamId>" كـ user_id للأم حتى:
  //   1) لا ينكسر القيد NOT NULL.
  //   2) لا تظهر الأم في قائمة مهام أي عضو حقيقي (بخلاف استخدام اسم المُنشئ كـ user_id،
  //      وهو كان سيُظهر مهمة إضافية غير قابلة للإلغاء في /missions list للمنشئ).
  const parentUserId = `team:${teamId}`;

  const create = db.transaction(() => {
    const result = db.prepare(`INSERT INTO staff_tasks (user_id, team_id, title, description, task_type, due_date, assigned_by, priority, tags)
    VALUES (?, ?, ?, ?, 'mission', ?, ?, ?, ?)`)
    .run(parentUserId, teamId, title, description, dueDate, assignedBy || null, 'normal', JSON.stringify(tags));

    const taskId = result.lastInsertRowid;
    const teamMembers = staffService.all({ team: teamId });

    // تعيين المهمة لكل عضو في الفريق
    const insert = db.prepare(`INSERT INTO staff_tasks (user_id, title, description, task_type, due_date, assigned_by, mission_id, priority, tags, team_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    teamMembers.forEach(member => {
      insert.run(
        member.user_id,
        title,
        description,
        'mission',
        dueDate,
        assignedBy || null,
        taskId,
        'normal',
        JSON.stringify(tags),
        teamId
      );
    });

    return taskId;
  });

  return get(create());
}

/**
 * إكمال مهمة جماعية وتحديث التقدم
 */
function completeTeamMission(teamMissionId, userId) {
  const db = getDb();
  
  // إكمال المهمة الجماعية الرئيسية
  const teamTask = db.prepare('SELECT * FROM staff_tasks WHERE id = ? AND task_type = \'mission\' AND team_id IS NOT NULL').get(teamMissionId);
  if (!teamTask) return null;
  
  db.prepare("UPDATE staff_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), teamMissionId);
    
  // إنشاء أو تحديث سجل التقدم
  const existingProgress = db.prepare('SELECT * FROM mission_progress WHERE mission_id = ? AND user_id = ?').get(teamTask.mission_id, userId);
  if (existingProgress) {
    db.prepare('UPDATE mission_progress SET status = \'completed\', completed_at = ? WHERE mission_id = ? AND user_id = ?')
      .run(nowIso(), teamTask.mission_id, userId);
  } else {
    db.prepare('INSERT INTO mission_progress (mission_id, team_id, user_id, status, completed_at) VALUES (?, ?, ?, \'completed\', ?)')
      .run(teamTask.mission_id, teamTask.team_id, userId, nowIso());
  }
  
  // فحص إكتمال المهمة الجماعية
  const completedCount = db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE mission_id = ? AND status = \'completed\'').get(teamTask.mission_id).c;
  const totalAssigned = db.prepare('SELECT COUNT(*) c FROM mission_progress WHERE mission_id = ?').get(teamTask.mission_id).c;
  
  if (completedCount === totalAssigned && totalAssigned > 0) {
    // مهمة جماعية مكتملة بالكامل
    db.prepare("UPDATE staff_tasks SET status = 'completed', completed_at = ? WHERE id = ?")
      .run(nowIso(), teamMissionId);
    return { task: get(teamMissionId), missionCompleted: true };
  }
  
  return { task: get(teamMissionId), missionCompleted: false };
}

/**
 * معالجة المهام المتكررة (يجب تشغيلها يومياً من المجدول)
 */
function processRecurringTasks() {
  const db = getDb();
  const todayDate = today();
  
  // البحث عن المهام المتكررة التي تحتاج للتكرار اليوم
  const recurringTasks = db.prepare(`
    SELECT * FROM staff_tasks 
    WHERE task_type = 'recurring' 
      AND status = 'completed'
      AND due_date <= ?
  `).all(todayDate);
  
  const created = [];
  for (const task of recurringTasks) {
    try {
      const tags = JSON.parse(task.tags || '{}');
      const recurrence = tags.recurrence;
      
      let nextDate = null;
      if (recurrence === 'daily') {
        nextDate = addDays(task.due_date, 1);
      } else if (recurrence === 'weekly') {
        nextDate = addDays(task.due_date, 7);
      } else if (recurrence === 'monthly') {
        nextDate = addDays(task.due_date, 30); // تقريبي
      }
      
      if (nextDate && nextDate >= todayDate) {
        const newTask = createRecurring(
          task.user_id,
          task.title,
          task.description,
          recurrence,
          nextDate,
          task.assigned_by
        );
        if (newTask) created.push(newTask);
      }
    } catch (e) {
      console.error(`خطأ في معالجة المهمة المتكررة ${task.id}:`, e);
    }
  }
  
  return created;
}

function approveOnboarding(userId, approvedBy) {
  const db = getDb();
  const target = db.prepare("SELECT * FROM staff_members WHERE user_id = ? AND status = 'probation'").get(userId);
  if (!target || !target.onboarding_ready) return null;
  const pending = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding' AND status = 'pending'").get(userId).c;
  if (pending) return null;
  db.prepare("UPDATE staff_members SET status = 'active', onboarding_ready = 0, onboarding_approved_by = ?, onboarding_approved_at = ?, updated_at = ? WHERE user_id = ?")
    .run(approvedBy || null, nowIso(), nowIso(), userId);
  return db.prepare('SELECT * FROM staff_members WHERE user_id = ?').get(userId);
}

function complete(id, userId) {
  const db = getDb();
  const task = db.prepare("SELECT * FROM staff_tasks WHERE id = ? AND user_id = ? AND status = 'pending'").get(Number(id), userId);
  if (!task) return null;
  db.prepare("UPDATE staff_tasks SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), task.id);
  if (task.task_type === 'onboarding') {
    const remaining = db.prepare("SELECT COUNT(*) c FROM staff_tasks WHERE user_id = ? AND task_type = 'onboarding' AND status = 'pending'").get(userId).c;
    if (!remaining) db.prepare("UPDATE staff_members SET onboarding_ready = 1, updated_at = ? WHERE user_id = ?").run(nowIso(), userId);
  }
  return get(task.id);
}

/** إلغاء مهمة مع تسجيل مَن ألغاها ومتى — كان المعامل actorId مُهمَلاً سابقاً */
function cancel(id, actorId = null) {
  const res = getDb().prepare(`UPDATE staff_tasks SET status = 'cancelled', cancelled_by = ?, cancelled_at = ?, updated_at = ?
    WHERE id = ? AND status = 'pending'`).run(actorId, nowIso(), nowIso(), Number(id));
  return res.changes > 0;
}

module.exports = { 
  ensureOnboarding, 
  create, 
  get, 
  list, 
  listPage, 
  listByType, 
  pendingCount, 
  approveOnboarding, 
  complete, 
  cancel,
  createFromTemplate,
  createRecurring,
  processRecurringTasks,
  createTeamMission,
  completeTeamMission,
  assignMentor,
  removeMentor
};
