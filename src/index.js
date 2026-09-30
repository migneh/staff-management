'use strict';
console.log(`[startup] Starting Staff Manager Bot (${process.version}); entry: src/index.js`);
console.log('[startup] Loading Discord library...');
const { Client, GatewayIntentBits, Partials, Events, PermissionFlagsBits } = require('discord.js');
console.log('[startup] Loading configuration...');
const config = require('./config');
console.log('[startup] Loading database module and application services...');
const { getDb } = require('./database');
const { commands, validateRegistry } = require('./commands');
const { resolveStaff, isServerManager } = require('./services/permissions');
const logger = require('./logger');
const staffService = require('./services/staff');
const { accessContext, commandAccessError } = require('./services/commandAccess');
const activity = require('./services/activity');
const ticketLogs = require('./services/ticketLogs');
const supportRatings = require('./services/supportRatings');
const forms = require('./ui/forms');
const { dispatch: dispatchComponent } = require('./services/componentDispatch');
const audit = require('./services/audit');
const scheduler = require('./scheduler');
const health = require('./health');
const settings = require('./services/settings');
const { deployCommands } = require('./deploy-commands');
const { embed: buildEmbed, replyEphemeral, COLORS, log: logToChannel, embed, sendToChannel } = require('./utils');
const { TEAMS, LEVELS } = require('./constants');

console.log('[startup] Application modules loaded; checking required configuration...');
if (!config.token) { console.error('❌ DISCORD_TOKEN غير موجود في .env'); process.exit(1); }
if (!config.guildId) { console.error('❌ GUILD_ID غير موجود في .env'); process.exit(1); }

// فشل سريع وواضح إن كان سجل الأوامر/المكوّنات غير سليم
try {
  validateRegistry();
} catch (e) {
  console.error(`❌ ${e.message}`);
  process.exit(1);
}

console.log('[startup] Opening SQLite database and applying migrations...');
try {
  getDb();
} catch (e) {
  console.error('[startup] Database initialization failed:', e.message);
  console.error('[startup] If native bindings are missing, approve the better-sqlite3 install script and run npm rebuild better-sqlite3. Also check DB_PATH and directory write permissions.');
  process.exit(1);
}
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent, GatewayIntentBits.DirectMessages],
  partials: [Partials.Channel],
});

// ===== عكس تحذيرات/أخطاء المسجّل إلى قناة السجلات =====
logger.setMirror((level, scope, message) => {
  const color = level === 'error' ? COLORS.danger : COLORS.warning;
  const emoji = level === 'error' ? '❌' : '⚠️';
  sendToChannel(client, 'staff-logs', { embeds: [buildEmbed(`${emoji} ${scope}`, message.slice(0, 1800), color)] }).catch(() => {});
});

let loginWarningTimer;
client.once(Events.ClientReady, async (c) => {
  clearTimeout(loginWarningTimer);
  console.log(`✅ ${c.user.tag} جاهز — Staff Manager Bot`);

  // تسجيل أوامر السلاش تلقائياً عند كل تشغيل.
  if (process.env.SKIP_DEPLOY !== 'true') {
    try {
      if (!config.clientId) config.clientId = c.user.id;
      await deployCommands();
    } catch (e) { logger.log('deploy').error('فشل تسجيل الأوامر:', e); }
  }

  const st = settings.status();
  if (!st.complete) console.log(`⚙️  الإعداد غير مكتمل (رتب ${st.rolesDone}/${st.rolesTotal} • قنوات ${st.channelsDone}/${st.channelsTotal}) — استخدم /setup داخل السيرفر.`);
  if (!st.ticketSourceConfigured) console.log('🎫 التسجيل التلقائي للتكتات غير مفعل — حدد قناة سجل البوت الخارجي من /setup.');
  scheduler.start(client);
  if (process.env.HEALTH_PORT) {
    try {
      healthServer = health.start({ scheduler });
      console.log(`🩺 Health endpoint يعمل على ${process.env.HEALTH_HOST || '127.0.0.1'}:${process.env.HEALTH_PORT}`);
    } catch (e) { logger.log('health').error('فشل تشغيل Health endpoint:', e); }
  }
});

let healthServer = null;

// ===== قراءة سجل التكتات من قناة البوت الخارجي =====
async function importExternalTicketLog(msg) {
  if (msg.author?.id === client.user?.id) return;
  const parsed = ticketLogs.parseExternalTicketMessage(msg);
  if (!parsed) return false;
  await ticketLogs.enrichDuration(msg, parsed); // يحسب زمن الاستجابة إن لم يذكر البوت المدة
  const result = ticketLogs.recordTicket(parsed);
  if (result.duplicate) return true;

  audit.record({
    action: 'ticket_auto_logged', actorId: parsed.loggedBy, targetId: parsed.claimer,
    details: { ticketId: parsed.ticketId, sourceMessageId: parsed.sourceMessageId, rowId: result.row.id, reopened: result.reopened },
    channelId: msg.channelId,
  });

  const durationText = parsed.duration == null ? 'غير مذكورة'
    : `${parsed.duration} دقيقة${parsed.durationSource === 'computed' ? ' (محسوبة من سجل القناة)' : ''}`;
  const e = embed(`🎫 تم تسجيل التكت تلقائياً ${result.reopened ? '♻️' : '✅'}`,
    `تمت قراءة سجل **${parsed.ticketId}** من البوت الخارجي بدون تدخل يدوي.\n\n👤 المستلم: <@${parsed.claimer}>\n🔒 الذي أغلقه: <@${parsed.closer}>\n⭐ التقييم: ${parsed.rating ?? '—'}\n⏱️ مدة الحل: ${durationText}\n🔗 [فتح سجل التكت](${parsed.ticketUrl || parsed.sourceUrl || msg.url})`,
    result.reopened ? COLORS.warning : COLORS.success).setFooter({ text: `السجل #${result.row.id} • المصدر: ${msg.author.tag || msg.author.id}` });
  await sendToChannel(client, 'ticket-logs', { embeds: [e] });
  return true;
}

// ===== تتبع النشاط التلقائي + استيراد سجل التكتات =====
client.on(Events.MessageCreate, async (msg) => {
  try {
    if (!msg.guild || msg.guild.id !== config.guildId) return;
    if (msg.author.bot) {
      await supportRatings.importMessage(msg, client.user?.id);
      await importExternalTicketLog(msg);
      return;
    }
    const info = resolveStaff(msg.member);
    if (!info) return;
    const s = staffService.ensure(msg.member);
    if (s?.isNew) await logToChannel(client, '🆕 إداري جديد', `<@${msg.author.id}> — ${s.rank} (${TEAMS[s.team]}) — تم تسجيله تلقائياً${s.status === 'probation' ? ' بحالة تجريبية' : ''}.`, COLORS.success);
    staffService.touchActivity(msg.author.id);
    activity.record(msg.author.id, msg.channel, msg.content);
  } catch (e) { logger.log('bot').error('خطأ في تتبع الرسالة:', e); }
});

// ===== تحديث الرتبة عند تغيير رتب الديسكورد =====
client.on(Events.GuildMemberUpdate, async (oldM, newM) => {
  try {
    if (newM.guild.id !== config.guildId) return;
    const info = resolveStaff(newM);
    if (info) return void staffService.ensure(newM);
    // لم تبقَ أي رتبة إدارية: نحدّث الحالة بدل ترك العضو "نشطاً" للأبد
    const departure = staffService.syncDeparture(newM);
    if (departure) {
      audit.record({ action: 'staff_roles_removed', targetId: newM.id, details: departure });
      await logToChannel(client, '🚪 خروج من الفريق', `<@${newM.id}> — ${departure.rank} — نُزعت رتبه الإدارية يدوياً.\nالحالة: **${departure.previous} → ${departure.next}**`, COLORS.warning);
    }
  } catch (e) { logger.log('bot').error('خطأ في مزامنة الرتبة:', e); }
});

// ===== مغادرة السيرفر =====
client.on(Events.GuildMemberRemove, async (member) => {
  try {
    if (member.guild.id !== config.guildId) return;
    const departure = staffService.markLeft(member.id);
    if (!departure) return;
    audit.record({ action: 'staff_left_guild', targetId: member.id, details: departure });
    await logToChannel(client, '👋 مغادرة السيرفر', `<@${member.id}> غادر السيرفر — ${departure.rank} (${TEAMS[departure.team] || departure.team}).\nتم تحديث حالته إلى **${departure.next}**.`, COLORS.danger);
  } catch (e) { logger.log('bot').error('خطأ في معالجة المغادرة:', e); }
});

// ===== الأوامر والمكونات =====
client.on(Events.InteractionCreate, async (i) => {
  try {
    if (!i.inGuild() || i.guildId !== config.guildId) return;

    const isAdmin = i.member.permissions.has(PermissionFlagsBits.Administrator);
    const serverManager = isServerManager(i.member);
    const originalId = forms.lookup(i)?.originalId || i.customId;
    const isSetup = (i.isChatInputCommand() && i.commandName === 'setup') || originalId?.startsWith('setup:');
    let info = null;

    if (isSetup) {
      if (!isAdmin) return replyEphemeral(i, '❌ الإعداد متاح لمن يملك صلاحية **Administrator** فقط.', COLORS.danger);
    } else {
      info = resolveStaff(i.member);
      if (!info && !serverManager) {
        const st = settings.status();
        if (!st.anyRole && isAdmin) return replyEphemeral(i, '👋 **أهلاً!** البوت لم يُعدّ بعد.\nاستخدم **`/setup`** لتحديد الرتب والقنوات بقوائم اختيار سهلة (دقيقتان).', COLORS.warning);
        return replyEphemeral(i, '❌ هذا البوت مخصص للإداريين فقط.', COLORS.danger);
      }
      if (info) {
        staffService.ensure(i.member);
        i.staffInfo = info;
        i.staffLevel = info.level;
      } else {
        // مالك السيرفر/Server Manager يمكنه استعمال أوامر الإدارة المخصصة حتى دون رتبة فريق.
        i.staffLevel = LEVELS.GENERAL_MANAGER;
      }
    }

    if (i.isChatInputCommand()) {
      const cmd = commands.get(i.commandName);
      if (!cmd) return;
      if (isSetup) return await cmd.execute(i);
      const denied = commandAccessError(cmd, accessContext(i));
      if (denied) return replyEphemeral(i, `❌ ${denied}`, COLORS.danger);
      return await cmd.execute(i);
    }

    if (i.isButton() || i.isAnySelectMenu() || i.isModalSubmit()) {
      return await dispatchComponent(i);
    }
  } catch (e) {
    logger.log('commands').error(`خطأ في التفاعل ${i.commandName || i.customId}:`, e);
    try { await replyEphemeral(i, '❌ حدث خطأ غير متوقع. تم تسجيله.', COLORS.danger); } catch {}
  }
});

// ===== معالجة الأخطاء على مستوى العميل والمسار =====
client.on(Events.Error, (e) => logger.log('discord').error('خطأ من ديسكورد:', e));
client.on(Events.Warn, (m) => logger.log('discord').warn(m));

process.on('unhandledRejection', (e) => logger.log('process').error('unhandledRejection:', e));
process.on('uncaughtException', (e) => {
  logger.log('process').error('uncaughtException:', e);
  // لا نُسقط البوت بسبب استثناء واحد؛ نسجّل ونستمر، وإن تكّرر يُرى في #staff-logs.
});

// ===== إغلاق لطيف: إيقاف المهام وإغلاق قاعدة البيانات =====
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 إغلاق (${signal})...`);
  try { scheduler.clearRunningTasks(); } catch (e) { logger.log('shutdown').error(e.message); }
  try { scheduler.stop(); } catch (e) { logger.log('shutdown').error(e.message); }
  try { healthServer?.close(); } catch { /* ignore */ }
  try { client.destroy(); } catch { /* ignore */ }
  try { getDb().close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.on(Events.ShardReady, (id) => console.log(`[discord] Shard ${id} connected.`));
client.on(Events.ShardReconnecting, (id) => console.warn(`[discord] Shard ${id} reconnecting...`));
client.on(Events.ShardDisconnect, (event, id) => {
  console.warn(`[discord] Shard ${id} disconnected (code ${event.code}).`);
  if (event.code === 4014) logger.log('discord').error('[discord] Enable Server Members Intent and Message Content Intent in Discord Developer Portal > Bot.');
});
client.on(Events.ShardError, (e, id) => logger.log('discord').error(`Shard ${id} connection error:`, e));

console.log('[startup] Connecting to Discord...');
loginWarningTimer = setTimeout(() => {
  console.warn('[startup] Discord has not reported ready after 60 seconds. Check host connectivity to Discord HTTPS/WebSocket endpoints, privileged intents, and any connection errors above.');
}, 60_000);
loginWarningTimer.unref();
client.login(config.token).catch((e) => {
  clearTimeout(loginWarningTimer);
  console.error(`❌ فشل تسجيل الدخول: ${e.message}`);
  console.error('[startup] Check DISCORD_TOKEN, enable Server Members Intent and Message Content Intent in Discord Developer Portal > Bot, and check host connectivity to Discord.');
  process.exit(1);
});
