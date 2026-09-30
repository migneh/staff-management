'use strict';
const http = require('http');
const config = require('./config');
const retention = require('./services/retention');

function authOk(req) {
  const expected = process.env.HEALTH_TOKEN;
  if (!expected) return true;
  return req.headers.authorization === `Bearer ${expected}`;
}

function lastBackup() {
  try {
    const file = require('./services/backup').listBackups()[0];
    if (!file) return null;
    return { ...file, ageSeconds: Math.max(0, Math.round((Date.now() - Date.parse(file.modifiedAt)) / 1000)) };
  } catch { return null; }
}

function snapshot(scheduler) {
  const jobs = scheduler.status();
  const backup = lastBackup();
  const failedJobs = Object.entries(jobs).filter(([, run]) => !run.ok).map(([name]) => name);
  const payload = {
    status: failedJobs.length ? 'degraded' : 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    timezone: require('./clock').TZ,
    database: { path: config.dbPath, sizeMb: retention.dbSizeMb() },
    backup: backup ? { name: backup.name, ageSeconds: backup.ageSeconds, sizeBytes: backup.size } : null,
    jobs,
    failedJobs,
  };
  return payload;
}

function metricName(value) {
  return String(value).replace(/[^a-zA-Z0-9_:]/g, '_');
}

function metrics(scheduler) {
  const data = snapshot(scheduler);
  const lines = [
    '# HELP staff_manager_uptime_seconds Process uptime in seconds.',
    '# TYPE staff_manager_uptime_seconds gauge',
    `staff_manager_uptime_seconds ${data.uptimeSeconds}`,
    '# HELP staff_manager_database_size_bytes SQLite database size in bytes.',
    '# TYPE staff_manager_database_size_bytes gauge',
    `staff_manager_database_size_bytes ${Math.round(data.database.sizeMb * 1024 * 1024)}`,
  ];
  if (data.backup) {
    lines.push('# HELP staff_manager_backup_age_seconds Age of the newest backup.', '# TYPE staff_manager_backup_age_seconds gauge', `staff_manager_backup_age_seconds ${data.backup.ageSeconds}`);
  }
  for (const [job, run] of Object.entries(data.jobs)) {
    const name = metricName(job);
    const timestamp = run.finishedAt ? Math.floor(Date.parse(run.finishedAt) / 1000) : 0;
    lines.push(`staff_manager_job_last_run_timestamp{job="${name}"} ${timestamp}`, `staff_manager_job_last_run_ok{job="${name}"} ${run.ok ? 1 : 0}`);
  }
  return `${lines.join('\n')}\n`;
}

function start({ scheduler, host = process.env.HEALTH_HOST || '127.0.0.1', port = Number(process.env.HEALTH_PORT || 0) } = {}) {
  if (!scheduler) throw new Error('health server requires scheduler');
  const server = http.createServer((req, res) => {
    if (!authOk(req)) {
      res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(JSON.stringify({ error: 'unauthorized' }));
    }
    if (req.url === '/healthz') {
      const body = snapshot(scheduler);
      res.writeHead(body.status === 'ok' ? 200 : 503, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(JSON.stringify(body));
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      return res.end(metrics(scheduler));
    }
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'not_found' }));
  });
  server.listen(port, host);
  return server;
}

module.exports = { authOk, lastBackup, snapshot, metrics, start };