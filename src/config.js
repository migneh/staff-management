'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');

const configPath = path.join(__dirname, '..', 'config.json');
const examplePath = path.join(__dirname, '..', 'config.example.json');

let fileConfig = {};
if (fs.existsSync(configPath)) {
  fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} else if (fs.existsSync(examplePath)) {
  console.warn('⚠️  لم يتم العثور على config.json — سيتم استخدام config.example.json (المعرفات وهمية).');
  fileConfig = JSON.parse(fs.readFileSync(examplePath, 'utf8'));
}

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  guildId: process.env.GUILD_ID,
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'staff.db'),
  roles: fileConfig.roles || { support: {}, moderation: {}, general_management: {}, governance: {}, system: {} },
  channels: fileConfig.channels || {},
  activityChannels: fileConfig.activityChannels || { ticket: [], staff: [], moderation: [] },
  // اختياري: إذا تم تحديده فلن يقرأ البوت سجلات التكتات إلا من هذا البوت.
  ticketLogBotId: (() => {
    const val = process.env.TICKET_LOG_BOT_ID || fileConfig.ticketLogBotId || '';
    return /^\d+$/.test(val) ? val : null;
  })(),
  leave: { maxDays: 30, maxConcurrent: 3, ...(fileConfig.leave || {}) },
  resignation: { noticeDays: 3, ...(fileConfig.resignation || {}) },
  backup: { dir: process.env.BACKUP_DIR || fileConfig.backup?.dir || path.join(__dirname, '..', 'backups'), keep: Number(process.env.BACKUP_KEEP || fileConfig.backup?.keep || 14) },
};
