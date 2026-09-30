'use strict';
/**
 * مصدر واحد للوقت والتواريخ في البوت.
 *
 * القاعدة (لا تُخلط بين الاثنين):
 *  • "التاريخ" (YYYY-MM-DD) يُحسب بتوقيت السيرفر المضبوط في TZ — لأن منطق
 *    الإجازات والاستقالات والتقارير يقارن أياماً، ومهام cron تعمل بتوقيت TZ.
 *    هذا ما يمنع تشغيل مهام منتصف الليل على "يوم أمس".
 *  • "الطابع الزمني" (YYYY-MM-DD HH:MM:SS) يبقى بتوقيت UTC كما يخزّنه SQLite
 *    عبر datetime('now')، حتى تبقى كل استعلامات المقارنة في SQL صحيحة
 *    (created_at >= datetime('now','-7 days')). لا تُغيّر هذا دون ترحيل البيانات.
 */
const TZ = process.env.TZ || 'Asia/Riyadh';

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
});

/** يحوّل كائن تاريخ إلى YYYY-MM-DD بتوقيت السيرفر (مفصولة للاختبار) */
function dayOf(date = new Date()) {
  return dayFormatter.format(date);
}

/** اليوم الحالي بتوقيت السيرفر */
function today() {
  return dayOf(new Date());
}

/** طابع زمني UTC متوافق تماماً مع SQLite datetime('now') */
function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** يحوّل نص تاريخ/طابع زمني إلى كائن تاريخ بثبات (التواريخ المجرّدة = منتصف ليل UTC) */
function parseStamp(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const str = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(`${str}T00:00:00Z`);
  const iso = str.replace(' ', 'T');
  return new Date(iso.length <= 19 ? `${iso}Z` : iso);
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function addDays(dateStr, days) {
  const d = parseStamp(dateStr);
  if (!d || Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + Math.trunc(days));
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const da = parseStamp(a);
  const db = parseStamp(b);
  if (!da || !db) return null;
  return Math.round((db.getTime() - da.getTime()) / 86400000);
}

function hoursSince(isoDate) {
  if (!isoDate) return Infinity;
  const d = parseStamp(isoDate);
  if (!d || Number.isNaN(d.getTime())) return Infinity;
  return (Date.now() - d.getTime()) / 3600000;
}

function monthsSince(isoDate) {
  const d = parseStamp(isoDate);
  if (!d || Number.isNaN(d.getTime())) return 0;
  return (Date.now() - d.getTime()) / (30.44 * 86400000);
}

/** <t:...:D> — يعرضه ديسكورد بتوقيت جهاز القارئ */
function discordTs(value, style = 'D') {
  const d = parseStamp(value);
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `<t:${Math.floor(d.getTime() / 1000)}:${style}>`;
}

/** أول يوم في الشهر السابق لـ YYYYMM */
function previousMonth(yyyymm) {
  const first = `${yyyymm}-01`;
  return addDays(first, -1).slice(0, 7);
}

module.exports = {
  TZ, dayOf, today, nowIso, parseStamp, isValidDate, addDays, daysBetween,
  hoursSince, monthsSince, discordTs, previousMonth,
};
