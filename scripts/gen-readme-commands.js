#!/usr/bin/env node
'use strict';
/**
 * يولّد جدول الأوامر في README.md من سجل الأوامر الفعلي (مصدر حقيقة واحد).
 * التشغيل: npm run docs:commands        (يكتب الجدول)
 *          npm run docs:commands -- --check   (يفشل إن كان الجدول قديماً — لـ CI)
 *
 * السبب: الجدول اليدوي كان يقول 40 أمراً بينما البوت يسجّل 54، فيضيع الفريق.
 */
const fs = require('fs');
const path = require('path');
require('../tests/sqlite-compat').install();

const root = path.join(__dirname, '..');
const START = '<!-- COMMANDS:START -->';
const END = '<!-- COMMANDS:END -->';

const { commands } = require(path.join(root, 'src/commands'));
const { LEVEL_LABELS } = require(path.join(root, 'src/services/permissions'));
const { TEAMS } = require(path.join(root, 'src/constants'));

// نستثني الأوامر الإدارية الداخلية (تظهر في /help) من العرض العام
const rows = [...commands.entries()]
  .map(([name, cmd]) => ({
    name,
    desc: cmd.data.description || '',
    level: cmd.adminOnly ? 'Administrator'
      : cmd.serverManagerOnly ? 'Server Manager / GM'
        : (cmd.level == null ? 'الكل' : (LEVEL_LABELS[cmd.level] || `مستوى ${cmd.level}`)),
    team: cmd.team ? TEAMS[cmd.team] || cmd.team : '',
  }))
  .sort((a, b) => a.name.localeCompare(b.name, 'en'));

const table = [
  START,
  `إجمالي الأوامر المسجّلة فعلياً: **${rows.length}** (يُولَّد هذا الجدول بـ \`npm run docs:commands\`).`,
  '',
  '| الأمر | الوصف | الصلاحية |',
  '|-------|-------|----------|',
  ...rows.map(r => `| \`/${r.name}\` | ${r.desc}${r.team ? ` • ${r.team}` : ''} | ${r.level} |`),
  END,
].join('\n');

const readmePath = path.join(root, 'README.md');
const readme = fs.readFileSync(readmePath, 'utf8');
const hasMarkers = readme.includes(START) && readme.includes(END);
const next = hasMarkers
  ? readme.replace(new RegExp(`${START}[\\s\\S]*?${END}`), table)
  : `${readme.replace(/\n## ⏰ المهام التلقائية/, `\n${table}\n\n## ⏰ المهام التلقائية`)}`;

if (next === readme) {
  console.log('✅ جدول الأوامر في README محدّث بالفعل.');
  process.exit(0);
}
if (process.argv.includes('--check')) {
  console.error(`❌ جدول الأوامر في README قديم (المتوقع ${rows.length} أمراً). شغّل: npm run docs:commands`);
  process.exit(1);
}
fs.writeFileSync(readmePath, next);
console.log(`✅ تم تحديث جدول الأوامر (${rows.length} أمراً).`);
