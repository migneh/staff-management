'use strict';
const { getDb } = require('../database');
const staffService = require('./staff');
const settings = require('./settings');
const { today, daysBetween, isValidDate, addDays } = require('../utils');
const { TEAMS, WEEKDAYS_AR } = require('../constants');
const audit = require('./audit');

const APPROVED = "status = 'approved'";
const PENDING_OR_APPROVED = "status IN ('pending', 'approved')";

// ===== استعلامات أساسية =====
function concurrentApproved(start, end, excludeId = null) {
  const params = [end, start];
  let sql = `SELECT COUNT(DISTINCT user_id) c FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(sql).get(...params).c;
}

function userHasOverlap(userId, start, end, { excludeId = null, includePending = true } = {}) {
  const params = [userId, end, start];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${includePending ? PENDING_OR_APPROVED : APPROVED}
    AND start_date <= ? AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date LIMIT 1`).get(...params) || null;
}

function approvedForUser(userId, { onOrAfter = today(), excludeId = null } = {}) {
  const params = [userId, onOrAfter];
  let sql = `SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ?`;
  if (excludeId != null) { sql += ' AND id != ?'; params.push(Number(excludeId)); }
  return getDb().prepare(`${sql} ORDER BY start_date`).all(...params);
}

function activeForUser(userId, date = today()) {
  return getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND ${APPROVED}
    AND start_date <= ? AND end_date >= ? ORDER BY end_date DESC`).all(userId, date, date);
}

function pendingForUser(userId) {
  return getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status = 'pending' ORDER BY start_date`).all(userId);
}

function get(id) {
  return getDb().prepare('SELECT * FROM leave_requests WHERE id = ?').get(Number(id)) || null;
}

function list({ status = null, userId = null, page = 1, perPage = 10 } = {}) {
  let sql = 'SELECT * FROM leave_requests WHERE 1=1';
  const params = [];
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (userId) { sql += ' AND user_id = ?'; params.push(userId); }
  sql += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'approved\' THEN 1 ELSE 2 END, start_date DESC, id DESC';
  const all = getDb().prepare(sql).all(...params);
  const total = all.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const current = Math.min(Math.max(Number(page) || 1, 1), pages);
  const items = all.slice((current - 1) * perPage, current * perPage);
  return { items, total, pages, page: current };
}

function hasApprovedCover(userId, date = today(), excludeId = null) {
  return approvedForUser(userId, { onOrAfter: date, excludeId }).some(r => r.start_date <= date && r.end_date >= date);
}

// ===== قواعد واشتقاقات =====
function durationDays(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) return null;
  return daysBetween(start, end) + 1;
}

function noticeHours(start, nowIso = new Date().toISOString()) {
  const target = Date.parse(`${start}T00:00:00Z`);
  const now = Date.parse(nowIso);
  if (Number.isNaN(target) || Number.isNaN(now)) return null;
  return Math.floor((target - now) / 3600000);
}

function daysInRangeForUser(userId, start, end) {
  // مجموع أيام الإجازات المعتمدة خلال 90 يوماً قبل نهاية النطاق
  const windowStart = new Date(`${end}T00:00:00Z`);
  windowStart.setUTCDate(windowStart.getUTCDate() - 89);
  const ws = windowStart.toISOString().slice(0, 10);
  const rows = getDb().prepare(`SELECT start_date, end_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ? AND start_date <= ?`).all(userId, ws, end);
  let days = 0;
  for (const r of rows) {
    const s = r.start_date < ws ? ws : r.start_date;
    const e = r.end_date > end ? end : r.end_date;
    const d = daysBetween(s, e);
    if (d >= 0) days += d + 1;
  }
  return days;
}


// ===== أيام العمل والرصيد =====
/** أيام الراحة الأسبوعية المفعّلة (0 = الأحد … 6 = السبت). */
function weeklyOffDays(policy = settings.leavePolicy()) {
  return Array.isArray(policy.weeklyOffDays) ? policy.weeklyOffDays : Array.isArray(policy.weeklyOff) ? policy.weeklyOff : [];
}
function weekdayOf(date) {
  const t = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(t) ? null : new Date(t).getUTCDay();
}
function isWeeklyOff(date, offDays) {
  const day = weekdayOf(date);
  return day != null && offDays.includes(day);
}
/** عدد الأيام التقويمية داخل النطاق (شامل الطرفين). */
function spanDays(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) return null;
  return daysBetween(start, end) + 1;
}
/** الأيام المحتسبة فعلياً: تقويمية، أو أيام عمل فقط عند تفعيل الإعداد. */
function countedDays(start, end, policy = settings.leavePolicy()) {
  const span = spanDays(start, end);
  if (span == null || span < 1) return span;
  if (!policy?.workdayCounting) return span;
  const off = weeklyOffDays(policy);
  if (!off.length) return span;
  let count = 0;
  for (let day = start; day <= end; day = addDays(day, 1)) if (!isWeeklyOff(day, off)) count += 1;
  return count;
}
/** الأيام غير المحتسبة داخل النطاق (راحة أسبوعية) — للعرض فقط. */
function skippedOffDays(start, end, policy = settings.leavePolicy()) {
  const span = spanDays(start, end);
  if (span == null || span < 1) return [];
  const off = weeklyOffDays(policy);
  if (!policy?.workdayCounting || !off.length) return [];
  const days = [];
  for (let day = start; day <= end; day = addDays(day, 1)) if (isWeeklyOff(day, off)) days.push(day);
  return days;
}
function offDaysLabel(days) {
  const names = [...new Set(days.map(weekdayOf))].filter(day => day != null).map(day => WEEKDAYS_AR[day]);
  return names.length ? names.join('، ') : '—';
}

function clipRange(start, end, from, to) {
  const s = start < from ? from : start;
  const e = end > to ? to : end;
  return s <= e ? { start: s, end: e } : null;
}

/** استخدام النطاق (آخر 90 يوماً أو أي نطاق) مقسّماً حسب النوع وحالة الطلب. */
function usageInRange(userId, from, to, { excludeId = null, days = null } = {}) {
  const policy = settings.leavePolicy();
  const rows = getDb().prepare(`SELECT * FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved','ended')
    AND start_date <= ? AND end_date >= ?`).all(userId, to, from);
  const types = {};
  const totals = { used: 0, pending: 0 };
  for (const row of rows) {
    if (excludeId != null && row.id === Number(excludeId)) continue;
    const clipped = clipRange(row.start_date, row.end_date, from, to);
    if (!clipped) continue;
    const daysCounted = days != null ? days : countedDays(clipped.start, clipped.end, policy);
    if (daysCounted == null || daysCounted < 1) continue;
    const bucket = types[row.leave_type] || (types[row.leave_type] = { used: 0, pending: 0, requests: 0 });
    bucket.requests += 1;
    if (row.status === 'pending') { bucket.pending += daysCounted; totals.pending += daysCounted; }
    else { bucket.used += daysCounted; totals.used += daysCounted; }
  }
  return { types, totals };
}

/** الرصيد السنوي (اختياري): يُفرض فقط عندما يكون annualDays أكبر من صفر. */
function annualUsage(userId, date = today(), { excludeId = null } = {}) {
  const policy = settings.leavePolicy();
  const year = String(date).slice(0, 4);
  const row = usageInRange(userId, `${year}-01-01`, `${year}-12-31`, { excludeId });
  const cap = policy.annualDays || 0;
  const used = row.totals.used;
  const pending = row.totals.pending;
  return {
    year, cap, used, pending,
    remaining: cap ? Math.max(0, cap - used) : null,
    afterPending: cap ? Math.max(0, cap - used - pending) : null,
    byType: row.types,
  };
}

/** لوحة رصيد جاهزة للعرض: 90 يوماً لكل نوع + الرصيد السنوي + أقرب تاريخ مسموح. */
function allowance(userId, { date = today(), excludeId = null } = {}) {
  const policy = settings.leavePolicy();
  const from = addDays(date, -89);
  const window = usageInRange(userId, from, date, { excludeId });
  const types = {};
  for (const [type, rule] of Object.entries(policy.rules || {})) {
    const used = window.types[type]?.used || 0;
    const pending = window.types[type]?.pending || 0;
    const cap = Number(rule.maxDaysPer90 || policy.maxDaysPer90) || policy.maxDaysPer90;
    types[type] = { cap90: cap, used90: used, pending90: pending, remaining90: Math.max(0, cap - used), requests: window.types[type]?.requests || 0 };
  }
  const annual = annualUsage(userId, date, { excludeId });
  const rule = policy.minGapDays > 0
    ? getDb().prepare(`SELECT MAX(end_date) last FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date >= ?`).get(userId, date)
    : null;
  const nextAllowedStart = rule?.last ? addDays(rule.last, Number(policy.minGapDays) + 1) : null;
  return {
    date, from, types, annual,
    totalUsed90: window.totals.used, totalPending: window.totals.pending,
    maxConcurrent: policy.maxConcurrent, maxDays: policy.maxDays,
    nextAllowedStart: nextAllowedStart && nextAllowedStart > date ? nextAllowedStart : null,
  };
}

/** تغطية الفرق خلال نطاق: أدنى عدد حاضر لكل فريق، وأيام الخطر. */
function teamCoverage(start, end, { excludeUserId = null } = {}) {
  const policy = settings.leavePolicy();
  const required = policy.teamCover;
  const rows = getDb().prepare(`SELECT r.user_id, r.leave_type, r.start_date, r.end_date, s.team
    FROM leave_requests r LEFT JOIN staff_members s ON s.user_id = r.user_id
    WHERE r.status = 'approved' AND r.start_date <= ? AND r.end_date >= ?`).all(end, start)
    .filter(r => !excludeUserId || r.user_id !== excludeUserId);
  const roster = getDb().prepare("SELECT team, COUNT(*) c FROM staff_members WHERE team IN ('support','moderation') AND status NOT IN ('resigned','left') AND (suspended_until IS NULL OR suspended_until <= datetime('now')) GROUP BY team").all();
  const strengths = Object.fromEntries(roster.map(r => [r.team, r.c]));
  const shared = []; // من هم في إجازة معتمدة يغطون أكثر من فريق (نادر) — نحتسبهم للفريق المسجل
  const teams = {};
  for (const [team] of Object.entries(TEAMS)) {
    const size = strengths[team] || 0;
    if (!size) continue;
    let min = size;
    let worstDay = start;
    const away = rows.filter(r => r.team === team);
    for (let day = start; day <= end; day = addDays(day, 1)) {
      const count = size - away.filter(r => r.start_date <= day && r.end_date >= day).length;
      if (count < min) { min = count; worstDay = day; }
    }
    teams[team] = { size, min, worstDay, away: away.length, below: min < required };
    shared.push({ team, ...teams[team] });
  }
  const below = shared.filter(t => t.below);
  return { start, end, required, teams, below, worstTeam: below[0] || null, enforce: !!policy.enforceTeamCover };
}

/** أثر اعتماد طلب هذا العضو على تغطية فريقه. */
function teamImpact(userId, start, end, { excludeId = null } = {}) {
  const member = staffService.get(userId);
  const team = member?.team;
  if (!team || !TEAMS[team]) return null;
  const policy = settings.leavePolicy();
  const size = getDb().prepare("SELECT COUNT(*) c FROM staff_members WHERE team = ? AND status NOT IN ('resigned','left') AND (suspended_until IS NULL OR suspended_until <= datetime('now'))").get(team).c;
  const away = getDb().prepare(`SELECT COUNT(*) c FROM leave_requests WHERE user_id = ? AND status = 'approved' AND start_date <= ? AND end_date >= ? ${excludeId ? 'AND id != ?' : ''}`)
    .get(userId, end, start, ...(excludeId ? [Number(excludeId)] : []));
  const others = teamCoverage(start, end, { excludeUserId: userId });
  const current = others.teams[team]?.min ?? size;
  const after = Math.max(0, current - (away.c ? 0 : 1));
  return { team, size, required: policy.teamCover, current, after, below: after < policy.teamCover, enforce: !!policy.enforceTeamCover };
}

/** سجل مختصر يساعد المراجع قبل القرار. */
function memberHistory(userId, { limit = 3 } = {}) {
  const recent = getDb().prepare(`SELECT id, leave_type, start_date, end_date, status, duration_days FROM leave_requests
    WHERE user_id = ? ORDER BY id DESC LIMIT ?`).all(userId, Math.max(1, Math.min(Number(limit) || 3, 10)));
  const stats = getDb().prepare(`SELECT
    SUM(status = 'approved') approved, SUM(status = 'rejected') rejected, SUM(status = 'cancelled') cancelled,
    SUM(status IN ('approved','ended')) counted FROM leave_requests WHERE user_id = ?`).get(userId);
  const row = getDb().prepare(`SELECT COUNT(*) c FROM leave_requests WHERE user_id = ? AND status IN ('pending','approved')`).get(userId);
  return {
    recent, approved: stats.approved || 0, rejected: stats.rejected || 0, cancelled: stats.cancelled || 0,
    countedRequests: stats.counted || 0, openRequests: row.c,
    activeToday: activeForUser(userId).length, used90: usageInRange(userId, addDays(today(), -89), today()).totals.used,
    next: approvedForUser(userId)[0] || null,
  };
}

function minGapViolated(userId, start, end, excludeId = null) {
  const policy = settings.leavePolicy();
  const gap = Number(policy.minGapDays || 1);
  if (gap <= 0) return null;
  // أقرب إجازة معتمدة قبل البداية وبعد النهاية
  const before = getDb().prepare(`SELECT end_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND end_date < ? ${excludeId ? 'AND id != ?' : ''} ORDER BY end_date DESC LIMIT 1`)
    .get(userId, start, ...(excludeId ? [Number(excludeId)] : []));
  if (before) {
    const g = daysBetween(before.end_date, start) - 1;
    if (g < gap) return { side: 'before', gap: g, required: gap, neighbour: before.end_date };
  }
  const after = getDb().prepare(`SELECT start_date FROM leave_requests WHERE user_id = ? AND ${APPROVED} AND start_date > ? ${excludeId ? 'AND id != ?' : ''} ORDER BY start_date LIMIT 1`)
    .get(userId, end, ...(excludeId ? [Number(excludeId)] : []));
  if (after) {
    const g = daysBetween(end, after.start_date) - 1;
    if (g < gap) return { side: 'after', gap: g, required: gap, neighbour: after.start_date };
  }
  return null;
}

/**
 * تحقق شامل قبل إنشاء الطلب أو اعتماده.
 * يرجع { ok: true } أو { ok: false, code, message, hint }
 */
function validate({ userId, leaveType, start, end, excludeId = null, atApproval = false }) {
  const policy = settings.leavePolicy(leaveType);
  const global = settings.leavePolicy();

  if (!isValidDate(start) || !isValidDate(end)) return { ok: false, code: 'date_format', message: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD.', hint: 'مثال: 2026-09-20' };
  const span = spanDays(start, end);
  if (span == null || span < 1) return { ok: false, code: 'date_order', message: 'تاريخ النهاية قبل البداية.' };
  const dur = countedDays(start, end, global);
  if (dur < 1) return { ok: false, code: 'no_workdays', message: 'الفترة المختارة كلها أيام راحة أسبوعية — لا يوجد يوم عمل يُحتسب.', hint: `أيام الراحة المضبوطة: ${offDaysLabel(weeklyOffDays(global))}. اختر أيام عمل أو عدّل الإعداد من /setup.` };
  if (end < today() && !atApproval) return { ok: false, code: 'in_past', message: 'لا يمكن طلب إجازة في الماضي.' };
  const spanNote = span === dur ? '' : ` (${span} يوماً تقويمياً)`;
  if (dur > policy.maxDays) return { ok: false, code: 'type_cap', message: `إجازة «${policy.emoji || ''} ${leaveType}» لا تتجاوز ${policy.maxDays} يوم عمل (طلبت ${dur}${spanNote}).`, hint: policy.note };
  if (dur > global.maxDays) return { ok: false, code: 'global_cap', message: `الحد الأقصى العام لأي إجازة هو ${global.maxDays} يوم عمل.` };

  const nh = noticeHours(start);
  if (policy.minNoticeHours > 0 && nh != null && nh < policy.minNoticeHours && !atApproval) {
    return { ok: false, code: 'notice', message: `هذا النوع يحتاج إشعاراً قبل ${policy.minNoticeHours} ساعة.`, hint: `تبقى ${Math.max(0, nh)} ساعة فقط — اختر بداية لاحقة أو نوعاً طارئاً.` };
  }

  // سقف 90 يوماً لكل نوع — يُحسب على الأيام المحتسبة فعلياً (أيام العمل عند تفعيل الإعداد).
  const window90 = usageInRange(userId, addDays(end, -89), end, { excludeId });
  const used90 = window90.types[leaveType]?.used || 0;
  const wouldBe = used90 + dur;
  const cap90 = policy.maxDaysPer90 || global.maxDaysPer90;
  if (cap90 && wouldBe > cap90) {
    return { ok: false, code: 'rolling_cap', message: `تجاوزت سقف ${cap90} يوم خلال 90 يوماً لهذا النوع (المستخدم ${used90} + ${dur} = ${wouldBe}).`, hint: `المتبقي لك حالياً ${Math.max(0, cap90 - used90)} يوم — قلّل المدة أو أجّل البداية.` };
  }

  // الرصيد السنوي يُفرض فقط عندما يضبطه المسؤول (annualDays > 0).
  let annual = null;
  if (global.annualDays > 0) {
    annual = annualUsage(userId, end, { excludeId });
    if (annual.used + dur > annual.cap) {
      return { ok: false, code: 'annual_cap', message: `تجاوزت رصيدك السنوي ${annual.cap} يوم لعام ${annual.year} (المستخدم ${annual.used}، المطلوب ${dur}).`, hint: `المتبقي من رصيدك ${annual.remaining} يوم — قلّل المدة أو راجع الإدارة.` };
    }
  }

  const overlap = userHasOverlap(userId, start, end, { excludeId, includePending: !atApproval });
  if (overlap) return { ok: false, code: 'overlap', message: `لديك طلب متداخل #${overlap.id} (${overlap.start_date} → ${overlap.end_date}).`, hint: 'عدّل التواريخ أو ألغِ الطلب المتداخل.' };

  const gap = minGapViolated(userId, start, end, excludeId);
  if (gap) {
    const side = gap.side === 'before' ? 'تنتهي إجازتك السابقة' : 'تبدأ إجازتك اللاحقة';
    return { ok: false, code: 'gap', message: `${side} في ${gap.neighbour} — تحتاج ${gap.required} يوم راحة (لديك ${gap.gap}).`, hint: 'أجّل البداية يوماً أو أكثر.' };
  }

  if (atApproval) {
    const c = concurrentApproved(start, end, excludeId);
    if (c >= global.maxConcurrent) return { ok: false, code: 'concurrent', message: `تم بلوغ الحد الأقصى (${global.maxConcurrent}) للمجازين في هذه الفترة.`, hint: `يوجد ${c} مجازين — جرّب فترة أخرى.` };
    if (global.enforceTeamCover && global.teamCover > 0) {
      const impact = teamImpact(userId, start, end, { excludeId });
      if (impact?.below) return { ok: false, code: 'team_cover', message: `اعتماد الطلب يخفض تغطية ${TEAMS[impact.team] || impact.team} إلى ${impact.after} (الحد الأدنى ${impact.required}).`, hint: 'أعد جدولة التواريخ أو اعتمد طلباً آخر لنفس الفترة.' };
    }
  }

  return { ok: true, durationDays: dur, calendarDays: span, noticeHours: nh, annual, skippedOffDays: skippedOffDays(start, end, global) };
}

/**
 * بطاقة ما قبل الإرسال: تحقق + رصيد + تغطية + أثر الفريق + تحذيرات، بلا أي كتابة في القاعدة.
 * الهدف: ألا يكتشف العضو مشكلة الحدود بعد إرسال الطلب.
 */
function previewRequest({ userId, leaveType, start, end, excludeId = null }) {
  const policy = settings.leavePolicy(leaveType);
  const global = settings.leavePolicy();
  const vr = validate({ userId, leaveType, start, end, excludeId });
  const span = spanDays(start, end);
  const counted = vr.durationDays ?? countedDays(start, end, global);
  if (!vr.ok) return { ok: false, error: vr, policy, span, counted };
  const coverage = coverageBetween(start, end);
  const impact = teamImpact(userId, start, end, { excludeId });
  const warnings = [];
  if (coverage.peak >= coverage.max) warnings.push(`التغطية العامة ممتلئة (${coverage.peak}/${coverage.max}) — الطلب قد يُرفض.`);
  else if (coverage.peak >= coverage.max - 1) warnings.push(`التغطية العامة شبه ممتلئة (${coverage.peak}/${coverage.max}).`);
  if (impact?.below) warnings.push(`تغطية ${TEAMS[impact.team] || impact.team} ستنخفض إلى ${impact.after} (الحد الأدنى ${impact.required}).`);
  const skipped = vr.skippedOffDays || [];
  if (skipped.length) warnings.push(`لن تُحتسب أيام الراحة الأسبوعية: ${offDaysLabel(skipped)} (${skipped.length} يوم).`);
  return {
    ok: true, error: null, policy, global, span, counted, skipped, warnings,
    noticeHours: vr.noticeHours, annual: vr.annual,
    allowance: allowance(userId, { excludeId }),
    coverage, impact,
  };
}

// ===== اقتراح تواريخ بديلة من المراجع =====
function clearSuggestion(id) {
  getDb().prepare('UPDATE leave_requests SET suggested_start = NULL, suggested_end = NULL, suggested_note = NULL, suggested_by = NULL, suggested_at = NULL WHERE id = ?').run(Number(id));
}
function suggestRequest({ id, actorId, start, end, note = null }) {
  const row = get(id);
  if (!row) return { ok: false, code: 'not_found', message: 'الطلب غير موجود.' };
  if (row.status !== 'pending') return { ok: false, code: 'status', message: 'الاقتراح يعمل على الطلبات المعلّقة فقط.' };
  if (!isValidDate(start) || !isValidDate(end)) return { ok: false, code: 'date_format', message: 'صيغة التاريخ غير صحيحة — استخدم YYYY-MM-DD.' };
  if (end < start) return { ok: false, code: 'date_order', message: 'تاريخ النهاية قبل البداية.' };
  const vr = validate({ userId: row.user_id, leaveType: row.leave_type, start, end, excludeId: row.id });
  if (!vr.ok) return { ok: false, code: vr.code, message: `التواريخ المقترحة غير صالحة: ${vr.message}`, hint: vr.hint };
  getDb().prepare(`UPDATE leave_requests SET suggested_start = ?, suggested_end = ?, suggested_note = ?, suggested_by = ?, suggested_at = datetime('now') WHERE id = ?`)
    .run(start, end, note || null, actorId, row.id);
  audit.record({ action: 'leave_suggestion_sent', actorId, targetId: row.user_id, details: { requestId: row.id, start, end } });
  return { ok: true, row: get(row.id) };
}
function acceptSuggestion({ id, userId }) {
  const row = get(id);
  if (!row || row.user_id !== Number(userId) && row.user_id !== userId) return { ok: false, code: 'not_found', message: 'الطلب غير موجود.' };
  if (row.status !== 'pending') return { ok: false, code: 'status', message: 'الطلب لم يعد معلقاً.' };
  if (!row.suggested_start || !row.suggested_end) return { ok: false, code: 'no_suggestion', message: 'لا يوجد اقتراح على هذا الطلب.' };
  const vr = validate({ userId: row.user_id, leaveType: row.leave_type, start: row.suggested_start, end: row.suggested_end, excludeId: row.id });
  if (!vr.ok) return { ok: false, code: vr.code, message: `تعذّر تطبيق التواريخ المقترحة: ${vr.message}`, hint: vr.hint };
  getDb().prepare(`UPDATE leave_requests SET start_date = ?, end_date = ?, duration_days = ?, notice_hours = ?, updated_at = datetime('now') WHERE id = ?`)
    .run(row.suggested_start, row.suggested_end, vr.durationDays, vr.noticeHours, row.id);
  clearSuggestion(row.id);
  audit.record({ action: 'leave_suggestion_accepted', actorId: row.user_id, targetId: row.user_id, details: { requestId: row.id, start: row.suggested_start, end: row.suggested_end } });
  return { ok: true, row: get(row.id) };
}
function declineSuggestion({ id, userId }) {
  const row = get(id);
  if (!row || row.user_id !== userId) return { ok: false, code: 'not_found', message: 'الطلب غير موجود.' };
  if (!row.suggested_start) return { ok: false, code: 'no_suggestion', message: 'لا يوجد اقتراح على هذا الطلب.' };
  clearSuggestion(row.id);
  audit.record({ action: 'leave_suggestion_declined', actorId: userId, targetId: userId, details: { requestId: row.id } });
  return { ok: true, row: get(row.id) };
}

// ===== تغطية اليوم والنطاق =====
function coverageFor(date = today()) {
  const rows = getDb().prepare(`SELECT user_id, leave_type, start_date, end_date FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`).all(date, date);
  return { date, count: rows.length, max: settings.leavePolicy().maxConcurrent, rows };
}

function coverageBetween(start, end) {
  // أقصى تداخل يومي خلال النطاق (مبسّط: كل تواريخ البداية/النهاية)
  const bounds = new Set([start, end]);
  for (const r of getDb().prepare(`SELECT start_date, end_date FROM leave_requests WHERE ${APPROVED} AND start_date <= ? AND end_date >= ?`).all(end, start)) {
    bounds.add(r.start_date); bounds.add(r.end_date);
  }
  let peak = 0; let peakDay = start;
  for (const d of [...bounds].sort()) {
    if (d < start || d > end) continue;
    const c = concurrentApproved(d, d);
    if (c > peak) { peak = c; peakDay = d; }
  }
  return { start, end, peak, peakDay, max: settings.leavePolicy().maxConcurrent };
}

// ===== إنشاء وتمديد وإنهاء =====
function createRequest({ userId, leaveType, reason, start, end, attachmentUrl = null }) {
  const vr = validate({ userId, leaveType, start, end });
  if (!vr.ok) return vr;
  const grantTiming = settings.leavePolicy().vacationRoleTiming || 'at_start';
  const db = getDb();
  const res = db.prepare(`INSERT INTO leave_requests (user_id, leave_type, reason, start_date, end_date, duration_days, notice_hours, attachment_url, role_grant_at, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).run(userId, leaveType, reason, start, end, vr.durationDays, vr.noticeHours, attachmentUrl, grantTiming === 'at_approval' ? start : start);
  return { ok: true, row: get(res.lastInsertRowid) };
}

function extendRequest({ id, userId, newEnd, actorId }) {
  const row = get(id);
  if (!row || row.user_id !== userId) return { ok: false, code: 'not_found', message: 'الطلب غير موجود.' };
  if (!['pending', 'approved'].includes(row.status)) return { ok: false, code: 'status', message: 'يمكن تمديد الطلبات المعلقة أو المعتمدة فقط.' };
  if (!isValidDate(newEnd)) return { ok: false, code: 'date_format', message: 'صيغة التاريخ غير صحيحة.' };
  if (newEnd <= row.end_date) return { ok: false, code: 'date_order', message: 'تاريخ التمديد يجب أن يكون بعد النهاية الحالية.' };
  if (row.extended_count >= 2) return { ok: false, code: 'extend_limit', message: 'لا يمكن تمديد هذا الطلب أكثر من مرتين.' };
  const vr = validate({ userId: row.user_id, leaveType: row.leave_type, start: row.start_date, end: newEnd, excludeId: row.id, atApproval: row.status === 'approved' });
  if (!vr.ok) return vr;
  const db = getDb();
  db.prepare(`UPDATE leave_requests SET end_date = ?, duration_days = ?, extended_count = extended_count + 1, updated_at = datetime('now') WHERE id = ?`).run(newEnd, vr.durationDays, row.id);
  audit.record({ action: 'leave_extended', actorId, targetId: row.user_id, details: { requestId: row.id, from: row.end_date, to: newEnd } });
  return { ok: true, row: get(row.id) };
}

async function syncVacationRole(member, date = today()) {
  if (!member) return { ok: true, skipped: true };
  const timing = settings.leavePolicy().vacationRoleTiming || 'at_start';
  if (timing === 'at_approval') {
    // يوجد طلب معتمد يغطي اليوم أو سيبدأ مستقبلاً
    const hasAnyApproved = getDb().prepare(`SELECT 1 FROM leave_requests WHERE user_id = ? AND ${APPROVED} LIMIT 1`).get(member.id);
    return hasAnyApproved ? staffService.addVacationRole(member) : staffService.removeVacationRole(member);
  }
  // at_start: فقط عندما تكون الإجازة نشطة فعلياً
  const shouldHave = hasApprovedCover(member.id, date) || false;
  // لكن لا تُزلها إن كان هناك إجازة معتمدة قادمة خلال 24 ساعة ويُعتمد أن الرتبة تبقى
  if (!shouldHave && approvedForUser(member.id, { onOrAfter: date }).some(r => r.start_date > date)) {
    // اتركها إن كان بالفعل يملكها تجنباً للوميض
    try { if (member.roles?.cache?.has?.(settings.vacationRoleId())) return { ok: true, keep: true }; } catch {}
  }
  return shouldHave ? staffService.addVacationRole(member) : staffService.removeVacationRole(member);
}

function markReminder(id, current, key) {
   const sent = new Set(String(current || '').split(',').filter(Boolean));
   if (sent.has(key)) return false;
   sent.add(key);
   getDb().prepare('UPDATE leave_requests SET reminders_sent = ? WHERE id = ?').run([...sent].join(','), id);
   return true;
}

/**
 * إنشاء قالب إجازة جديد
 */
function createLeaveTemplate({ id, userId, name, description, leaveType, defaultDuration, defaultReason, isPublic = 0 }) {
   const db = getDb();
   const result = db.prepare(`
      INSERT INTO leave_templates (id, user_id, name, description, leave_type, default_duration, default_reason, is_public, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))
   `).run(id, userId, name, description, leaveType, defaultDuration, defaultReason, isPublic);
   
   return result.changes > 0 ? getLeaveTemplate(id) : null;
}

/**
 * الحصول على قالب إجازة بالمعرف
 */
function getLeaveTemplate(id) {
   return getDb().prepare('SELECT * FROM leave_templates WHERE id = ?').get(id) || null;
}

/**
 * قائمة قوالب الإجازات لمستخدم معين (أو القوالب العامة إذا لم يحدد المستخدم)
 */
function listLeaveTemplates({ userId = null, includePublic = true } = {}) {
   let sql = 'SELECT * FROM leave_templates WHERE 1=1';
   const params = [];
   
   if (userId) {
      sql += ' AND user_id = ?';
      params.push(userId);
   } else if (includePublic) {
      sql += ' AND is_public = 1';
   }
   
   sql += ' ORDER BY name';
   return getDb().prepare(sql).all(...params);
}

/**
 * حذف قالب إجازة
 */
function deleteLeaveTemplate(id, userId) {
   const db = getDb();
   const result = db.prepare('DELETE FROM leave_templates WHERE id = ? AND user_id = ?').run(id, userId);
   return result.changes > 0;
}

/**
 * استخدام قالب إجازة لإنشاء طلب إجازة جديد (يعيد بيانات الطلب المعبأ مسبقاً)
 */
function useLeaveTemplate(templateId, userId, overrides = {}) {
   const template = getLeaveTemplate(templateId);
   if (!template) return null;
   
   // التحقق من الصلاحية: إما أن يكون القالب خاصاً للمستخدم أو عاماً
   if (template.user_id !== userId && template.is_public !== 1) {
      return null;
   }
   
   return {
      id: template.id,
      user_id: userId,
      name: template.name,
      description: template.description,
      leave_type: overrides.leave_type || template.leave_type,
      start_date: overrides.start_date || null, // سيحتاج المستخدم لتحديد التواريخ
      end_date: overrides.end_date || null,     // سيحتاج المستخدم لتحديد التواريخ
      reason: overrides.reason || template.default_reason,
      duration_days: overrides.duration_days || template.default_duration,
      is_public: 0, // الطلبات الجديدة تكون خاصة دائماً
      created_at: null,
      updated_at: null
   };
}

module.exports = {
   concurrentApproved, userHasOverlap, approvedForUser, activeForUser, pendingForUser, get, list,
   hasApprovedCover, syncVacationRole, markReminder,
   durationDays, noticeHours, daysInRangeForUser, minGapViolated, validate, previewRequest,
   spanDays, countedDays, skippedOffDays, weeklyOffDays, offDaysLabel,
   usageInRange, annualUsage, allowance, teamCoverage, teamImpact, memberHistory,
   suggestRequest, acceptSuggestion, declineSuggestion, clearSuggestion,
   coverageFor, coverageBetween, createRequest, extendRequest,
   createLeaveTemplate, getLeaveTemplate, listLeaveTemplates, deleteLeaveTemplate, useLeaveTemplate,
};
