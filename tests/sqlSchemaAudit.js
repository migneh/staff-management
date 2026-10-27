'use strict';
/**
 * محقّق المخطط: يتأكد أن كل جملة SQL في src/ تذكر فقط جداول وأعمدة
 * موجودة فعلاً في مخطط قاعدة البيانات الحيّ.
 *
 * لماذا هذا الملف موجود: job الأسبوعي كان ينهار كل جمعة لأنه استعلام جدولاً
 * وعموداً لا وجود لهما، والخطأ ابتلعته job_runs(ok=0) فلم يلتقطه أحد، ولم
 * يبقَ على الجرح إلا /healthz يقول «degraded» إلى الأبد.
 *
 * كيف يعمل: نجمع كل `db.prepare(...)` عبر src/، ونحلّ الأجزاء المبنية
 * ديناميكياً من قيمها الثابتة الحقيقية في نفس الملف، ثم نمرّر كل جملة إلى
 * SQLite نفسها عبر db.prepare على قاعدة ذاكرة حيّة. SQLite هي المرجع:
 * من لا يعرف الجدول أو العمود يرمي "no such table/column".
 *
 * لا نعيد كتابة مُحلِّل SQL هنا: لو كتبناه لأصبح لدينا تطبيقان لنفس القاعدة،
 * ولا بد أن ينحرف أحدهما عن الآخر بصمت.
 *
 * مواقع لا نستطيع حسمها بثقة تُتخطّى وتُسجَّل في EXPECTED_SKIPS adناه،
 * لا بصمت. اختبار مطابقة التخطّي يمنع تضخّمها الصامت.
 */
const fs = require('fs');
const path = require('path');

const HOLE = '\u0000'; // عنصر نائب عن كل ${...}
const QUOTES = new Set(["'", '"', '`']);

/**
 * مواقع يتعذّر حسمها بالتحليل الساكن، موثّقة مفتاحَها الملف والعدد.
 *
 * نعدّ بالملف لا برقم السطر عمداً: سطر جديد في نفس الملف يجب ألا يكسر هذا
 * الاختبار، لكن موقعاً متخطّى جديداً في ذلك الملف يجب أن يكسره.
 */
const EXPECTED_SKIPS = new Map([
  // PRAGMA يرجع صفوفاً فارغة لجدول غير موجود بدل أن يرمي، فلا يصلح حارساً
  // على الوجود. أما جداول الترحيل نفسها فمغطاةٌ في auditMigrationTables.
  ['src/database.js', { count: 6, reason: /PRAGMA/ }],
  ['src/services/backup.js', { count: 1, reason: /PRAGMA/ }],
  // اسم جدول يأتي من sqlite_master وقت التشغيل: نفحص كل جدول في المخطط.
  ['src/services/retention.js', { count: 1, reason: /قائمة صلبة/ }],
  // `SET ${sets}` مبنية من Object.keys: نفحص كل عمود في staff_members.
  // و⑬: ترحيل الإيقاف القديم يبني إزاحة الرياض من clock.LOCAL_UTC_OFFSET_HOURS
  // (ثابت وحدة واحدة مصدَر من clock) — التحليل الساكن لا يستطيع تقييمه
  // فتُتخطّى الجملة بسببه، والعدّ يمنع نمو التخطي الصامت في هذا الملف.
  ['src/services/staff.js', { count: 3, reason: /قائمة صلبة|مبني بمتغير/ }],
  // و⑬: أيام النشاط بحدّ الرياض — strftime تُبنى بإزاحة من
  // clock.LOCAL_UTC_OFFSET_HOURS والتحليل الساكن لا يستطيع تقييم معرّف
  // مستورد ساكناً في نص الوحدة، فالثقب موثّق هنا بسببه الحقيقي:
  ['src/services/load.js', { count: 1, reason: /ثقب غير محلول: clock\.LOCAL_UTC_OFFSET_HOURS/ }],
  // فلتر اللوحة يبني IN (...) من ثابت مشترك INACTIVE_STATUSES (قرار المالك
  // D6): مصدر الحقيقة واحدة لا تتضاعف، والحارس لا يستطيع تقييم معرّف
  // مستورد ساكناً — فالثقب موثّق هنا بسببه الحقيقي، وحارس العدد يمنع نموه
  // الصامت في هذا الملف.
  ['src/services/points.js', { count: 1, reason: /ثقب غير محلول/ }],
]);

/** دوال الترحيل في database.js: جداولها يجب أن تكون جداول حقيقية. */
const MIGRATION_TABLE_FNS = ['addTableColumns', 'addMigrationColumns'];

/** ملفات src/ التي يفحصها هذا الحارس — لا غيرها. */
function srcFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
  };
  walk(path.join(root, 'src'));
  return out;
}

/**
 * يقرأ قيمة نصية حرفية عند موضع معيّن. يفكّ الـ escapes ويحفظ استبدالات
 * ${...} كثقوب داخل `holes` بدل نصّها.
 */
function literalAt(text, from) {
  const quote = text[from];
  if (!QUOTES.has(quote)) return null;
  let out = '';
  const holes = [];
  let i = from + 1;
  while (i < text.length) {
    const ch = text[i];
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      const holeStart = i;
      while (i < text.length && depth > 0) {
        const c = text[i];
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (!depth) break; }
        i++;
      }
      holes.push(text.slice(holeStart, i).trim().replace(/\s+/g, ' '));
      out += HOLE;
      i++;
      continue;
    }
    if (ch === quote) return { text: out, holes, end: i + 1 };
    if (ch === '\\') { out += text[i + 1]; i += 2; continue; }
    out += ch;
    i++;
  }
  return null;
}

/** كل مواقع `.prepare(...)` في ملف: حرفية، أو مبنية على متغير محلي. */
function extractSites(src) {
  const sites = [];
  const re = /\.prepare\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split('\n').length;
    const start = m.index + m[0].length;
    const lit = literalAt(src, start);
    if (!lit) {
      const id = /^[\s]*([A-Za-z_$][\w$]*)/.exec(src.slice(start));
      sites.push({ kind: 'ident', line, offset: m.index, name: id ? id[1] : null });
      continue;
    }
    sites.push({ kind: 'lit', line, offset: m.index, sql: lit.text, holes: lit.holes });
  }
  return sites;
}

/** قيمة ثابت نصي مُعرَّف في نفس الملف قبل موضع معيّن. */
function readTextBinding(src, name, beforeOffset) {
  const re = new RegExp(`(?:^|[\\s;{}(,])(?:const|let|var)\\s+${name}\\s*=\\s*`, 'gm');
  let last = null;
  let m;
  while ((m = re.exec(src)) && m.index < beforeOffset) last = m;
  if (!last) return null;
  const lit = literalAt(src, last.index + last[0].length);
  if (!lit || lit.holes.length) return null;
  return lit.text;
}

/**
 * يجمّع استعلاماً يُبنى بالدمج: `let sql = '...'` ثم `sql += '...'`.
 * نأخذ أقصى تركيب ممكن (كل الأجزاء الإضافية) لا تركيب فرع واحد: هكذا
 * يغطي الفحص كل عمود قد يُذكر في أي فرع من فروع الشرط.
 */
function readBuiltQuery(src, name, beforeOffset) {
  const decl = new RegExp(`(?:^|[\\s;{}(,])(?:let|const|var)\\s+${name}\\s*=\\s*`, 'gm');
  const add = new RegExp(`\\b${name}\\s*\\+=\\s*`, 'gm');
  let start = null;
  let m;
  while ((m = decl.exec(src)) && m.index < beforeOffset) start = m;
  if (!start) return null;
  const first = literalAt(src, start.index + start[0].length);
  if (!first) return null;
  let text = first.text;
  const holes = [...first.holes];
  add.lastIndex = first.end;
  let addMatch;
  while ((addMatch = add.exec(src)) && addMatch.index < beforeOffset) {
    const lit = literalAt(src, addMatch.index + addMatch[0].length);
    if (!lit) break;
    text += lit.text;
    holes.push(...lit.holes);
    add.lastIndex = lit.end;
  }
  return { text, holes };
}

/** هل التعبير ثلاثي `cond ? A : B`؟ نمسح الأقواس حتى لا نلتقط ? داخل نص. */
function isTernary(expr) {
  let depth = 0;
  for (const c of expr) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '?' && depth === 0) return true;
  }
  return false;
}

/** يقسم ثلاثة إلى (الشرط، الفرع الأول، الفرع الثاني). */
function splitTernary(expr) {
  let depth = 0;
  let qMark = -1;
  let colon = -1;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '?' && depth === 0 && qMark < 0) qMark = i;
    else if (c === ':' && depth === 0 && qMark >= 0) { colon = i; break; }
  }
  if (qMark < 0 || colon < 0) return null;
  return [expr.slice(0, qMark), expr.slice(qMark + 1, colon), expr.slice(colon + 1)];
}

/**
 * يحلّ تعبيراً داخل ${...} إلى قائمة قيم نصية تُفحص جميعها.
 * `allowlisted: true` تعني أن القيم تأتي من قائمة داخل الكود لا من المخطط،
 * فالفحص يغطّي أمثلة من القائمة لا كل التغليفات الممكنة — والتخطي موثّق.
 */
function resolveExpr(db, expr, ctx, depth) {
  const hole = expr.trim();

  // استعلام مبني بمتغير محلي: نجمع أجزاؤه ونحلّلها، لا نتخطّى الموقع كله.
  if (/^(sql|query)$/.test(hole)) {
    const built = readBuiltQuery(ctx.src, hole, ctx.offset);
    if (!built) return { fail: hole };
    return { values: [built] };
  }

  // فرع نصي حرفي: `cond ? 'AND x = ?' : ''` — قيمته هي النص نفسه.
  if (QUOTES.has(hole[0])) {
    const lit = literalAt(hole, 0);
    if (lit && lit.holes.length === 0 && lit.end === hole.length) return { values: [lit.text] };
  }

  // ثلاثة: `cond ? A : B` — نفحص كلا الفرعين. الفرعان قد يكونان نصوصاً
  // حرفية (تقسيم شرطي على SQL) أو معرّفين لثوابت (APPROVED و
  // PENDING_OR_APPROVED في leaves.js)، وكلاهما شائع في المشروع.
  if (isTernary(hole)) {
    const ternary = splitTernary(hole);
    if (!ternary) return { fail: hole };
    const left = resolveExpr(db, ternary[1], ctx, depth + 1);
    const right = resolveExpr(db, ternary[2], ctx, depth + 1);
    if (left.fail || right.fail) return { fail: left.fail || right.fail };
    // ternary اختيار لا دمج: إمّا هذا الفرع أو ذاك، لا كلاهما معاً.
    return {
      values: [...left.values, ...right.values],
      allowlisted: left.allowlisted || right.allowlisted,
    };
  }

  // قائمة قيم نائبة: `ids.map(() => '?').join(',')`
  if (/\.map\(\(\)\s*=>\s*'\?'\)\.join\(','\)/.test(hole)) return { values: ['?'] };

  // اسم جدول من قائمة صلبة داخل الكود: نفحص كل جدول في المخطط.
  if (hole === 'name' || hole === 'table') {
    return {
      values: db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name),
      allowlisted: true,
    };
  }

  // `SET ${sets}` مبنية من Object.keys — نفحص كل عمود في الجدول.
  if (hole === 'sets') {
    return {
      values: db.prepare('PRAGMA table_info(staff_members)').all().map(c => `${c.name} = ?`),
      allowlisted: true,
    };
  }

  const bound = readTextBinding(ctx.src, hole, ctx.offset);
  if (bound != null) return { values: [bound] };
  return { fail: hole };
}

/**
 * يبني كل الجمل الممكنة لجملة ذات ثقوب، بأخذ حاصل الضرب بين قيم كل ثقب.
 */
function buildVariants(db, text, holes, ctx, depth = 0) {
  if (!holes.length) return { variants: [text] };
  if (depth > 3) return { fail: 'تتداخل ثقب داخل ثقب أعمق من 3' };
  const groups = [];
  let allowlisted = false;
  for (const hole of holes) {
    const resolved = resolveExpr(db, hole, ctx, depth);
    if (resolved.fail) return { fail: resolved.fail };
    if (resolved.allowlisted) allowlisted = true;
    groups.push(resolved.values);
  }
  let combos = [[]];
  for (const group of groups) combos = combos.flatMap(c => group.map(v => [...c, v]));
  if (combos.length > 64) return { fail: `تركيبات كثيرة: ${combos.length}` };
  const segments = text.split(HOLE);
  const variants = [];
  for (const combo of combos) {
    let sql = '';
    for (let k = 0; k < segments.length; k++) {
      sql += segments[k];
      if (k >= combo.length) continue;
      const part = combo[k];
      if (part && part.text !== undefined && Array.isArray(part.holes)) {
        const nested = buildVariants(db, part.text, part.holes, ctx, depth + 1);
        if (nested.fail) return { fail: nested.fail };
        sql += nested.variants[0];
      } else {
        sql += part;
      }
    }
    variants.push(sql);
  }
  return { variants, allowlisted };
}

/**
 * يمشي على src/ كله ويقابل كل جملة بالمخطط الحيّ.
 */
function auditSchema(root, db) {
  let checked = 0;
  const statements = [];
  const findings = [];
  const skips = [];

  for (const file of srcFiles(root)) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(root, file).replace(/\\/g, '/');
    for (const site of extractSites(src)) {
      const ctx = { src, offset: site.offset };
      let text;
      let holes;
      if (site.kind === 'lit') {
        text = site.sql;
        holes = site.holes;
      } else {
        const built = site.name ? readBuiltQuery(src, site.name, site.offset) : null;
        if (!built) {
          skips.push({ site: `${rel}:${site.line}`, file: rel, reason: 'استعلام مبني بمتغير يتعذّر جمع أجزائه' });
          continue;
        }
        text = built.text;
        holes = built.holes;
      }
      const built = buildVariants(db, text, holes, ctx);
      if (built.fail) {
        skips.push({ site: `${rel}:${site.line}`, file: rel, reason: `ثقب غير محلول: ${built.fail}` });
        continue;
      }
      if (/^\s*PRAGMA/i.test(built.variants[0])) {
        skips.push({ site: `${rel}:${site.line}`, file: rel, reason: 'PRAGMA لا يتحقق من وجود جدول' });
        continue;
      }
      for (const sql of built.variants) {
        statements.push(sql);
        try {
          db.prepare(sql);
          checked++;
        } catch (err) {
          const missing = /no such (table|column): (\S+)/i.exec(err.message);
          if (missing) {
            findings.push({
              site: `${rel}:${site.line}`,
              file: rel,
              kind: missing[1].toLowerCase(),
              name: missing[2],
              sql: sql.replace(/\s+/g, ' ').trim(),
            });
          } else {
            skips.push({ site: `${rel}:${site.line}`, file: rel, reason: `SQL غير محسوم: ${err.message}` });
          }
        }
      }
      if (built.allowlisted) {
        skips.push({ site: `${rel}:${site.line}`, file: rel, reason: 'اسم جدول أو عمود من قائمة صلبة — فُحص على كل قيم القائمة' });
      }
    }
  }
  return { checked, statements, findings, skips };
}

/**
 * جداول دوال الترحيل في database.js يجب أن تكون جداول حقيقية. الدالة
 * نفسها تحمي نفسها بـ PRAGMA، لكن خطأً في الاسم يجعل الترحيل صامتاً.
 */
function auditMigrationTables(root, db) {
  const src = fs.readFileSync(path.join(root, 'src', 'database.js'), 'utf8');
  const real = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
  const missing = [];
  const seen = [];
  for (const fn of MIGRATION_TABLE_FNS) {
    const re = new RegExp(`${fn}\\(\\s*['"]([A-Za-z_][\\w]*)['"]`, 'g');
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      seen.push({ name, line: src.slice(0, m.index).split('\n').length });
      if (!real.has(name)) missing.push({ name, line: seen[seen.length - 1].line });
    }
  }
  return { missing, seen };
}

module.exports = {
  auditSchema,
  auditMigrationTables,
  EXPECTED_SKIPS,
  srcFiles,
  extractSites,
  buildVariants,
  resolveExpr,
  readBuiltQuery,
  readTextBinding,
  literalAt,
};