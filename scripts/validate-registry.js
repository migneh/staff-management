#!/usr/bin/env node
'use strict';
/**
 * بوابة سلامة: تتأكد أن كل أمر وكل مكوّن (زر/قائمة/نموذج) معرّف ومحمي بصلاحية،
 * وأن كل customId مُعلن في COMPONENT_ACCESS له معالج فعلاً.
 * تفشل العملية (exit 1) عند أي تعارض — تُستخدم في CI قبل الدمج.
 */
require('../tests/sqlite-compat').install();

let commands;
let validateRegistry;
let COMPONENT_ACCESS;
try {
  const registry = require('../src/commands');
  commands = registry.commands;
  validateRegistry = registry.validateRegistry;
  COMPONENT_ACCESS = registry.COMPONENT_ACCESS;
} catch (e) {
  console.error(`❌ تعذّر تحميل سجل الأوامر: ${e.message}`);
  process.exit(1);
}

const problems = validateRegistry();
if (problems.length) {
  console.error(`❌ ${problems.length} مشكلة في السجل:`);
  for (const p of problems) console.error(`   • ${p}`);
  process.exit(1);
}

const byLevel = {};
for (const entry of Object.values(COMPONENT_ACCESS)) {
  const key = entry.adminOnly ? 'adminOnly' : `level${entry.level}`;
  byLevel[key] = (byLevel[key] || 0) + 1;
}

console.log(`✅ سجل سليم: ${commands.size} أمر • ${Object.keys(COMPONENT_ACCESS).length} مكوّن`);
console.log(`   التوزيع: ${Object.entries(byLevel).map(([k, v]) => `${k}=${v}`).join(' • ')}`);
