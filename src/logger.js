'use strict';
/**
 * مسجّل بسيط: مستويات + نطاق (scope) + إمكانية عكس الأخطاء إلى ديسكورد.
 * الهدف: ألا يكون الخطأ مرئياً فقط لمن يراقب الطرفية.
 */
const SEVERITY = { debug: 10, info: 20, warn: 30, error: 40 };
const LABEL = { debug: '🔍', info: 'ℹ️', warn: '⚠️', error: '❌' };

let threshold = SEVERITY[String(process.env.LOG_LEVEL || '').toLowerCase()] ?? SEVERITY.info;
let mirror = null;
const lastMirrorAt = new Map();
const MIRROR_COOLDOWN_MS = 60_000;

/** يُسجّل دالة إرسال إلى قناة السجلات: (level, scope, message) => void */
function setMirror(fn) {
  mirror = typeof fn === 'function' ? fn : null;
}

function setLevel(level) {
  if (SEVERITY[level]) threshold = SEVERITY[level];
}

function format(args) {
  return args.map(a => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === 'object' && a !== null) {
      try { return JSON.stringify(a); } catch { return String(a); }
    }
    return String(a);
  }).join(' ');
}

function write(level, scope, args) {
  if (SEVERITY[level] < threshold) return;
  const line = format(args);
  const out = level === 'debug' ? console.log : console[level];
  out(`${LABEL[level]} [${scope}] ${line}`);

  if (!mirror || SEVERITY[level] < SEVERITY.warn) return;
  const key = `${scope}`;
  const now = Date.now();
  if ((lastMirrorAt.get(key) || 0) + MIRROR_COOLDOWN_MS > now) return; // منع الإغراق
  lastMirrorAt.set(key, now);
  try { mirror(level, scope, line); } catch { /* لا نُفشل التسجيل أبداً */ }
}

/** يعيد مسجّلاً لنطاق معيّن: log('scheduler').error('...') */
function log(scope = 'app') {
  return {
    debug: (...a) => write('debug', scope, a),
    info: (...a) => write('info', scope, a),
    warn: (...a) => write('warn', scope, a),
    error: (...a) => write('error', scope, a),
  };
}

module.exports = { log, setMirror, setLevel, SEVERITY };
