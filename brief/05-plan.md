# Brief 05 — Plan: fix deep-debug audit findings

Context: read-only multi-agent audit (2026-11-08). Baseline `npm run check` green (661/661 tests, validate + docs check). No data migration required; production DB untouched. Four adjudicated findings, one step each.

## Steps

| # | Title | Tags | Command | Status |
|---|---|---|---|---|
| 1 | Restore runbook targets the active DB path | fix | `/orch-fix-defect` | emitted |
| 2 | Leave escalation audit reflects delivery | fix | `/orch-fix-defect` | emitted |
| 3 | TZ-derived local UTC offset | fix | `/orch-fix-defect` | emitted |
| 4 | Document HEALTH_TOKEN requirement | docs | `/update-docs` | BLOCKED (manual) |

## Step 1 — Restore runbook targets the active DB path

Intent: `/backup-list` restore instructions hardcode `data/staff.db` (`src/commands/backup.js:48`) while `deploy/staff-manager.service:13` sets `DB_PATH=/var/lib/staff-manager/staff.db`, honored by `src/config.js:21`. Following the documented restore on that deployment restores a file the bot never opens.

Files: `src/commands/backup.js` (+ regression test).

Acceptance:
- The backup-list embed contains the configured `dbPath` and no bare `data/staff.db` reference (regression test).
- `npm run check` passes.

Out of scope: backup engine changes; `deploy/staff-manager.service` edits.

## Step 2 — Leave escalation audit reflects delivery

Intent: `claimReminder` persists before send (`src/services/leaves.js:481-517`, intentional duplicate suppression) and `sendToChannel` maps failures to null (`src/utils.js:129-139`); the scheduler records `leave_escalated` regardless of send outcome (`src/scheduler.js:150-156`), so the audit can claim an escalation that never delivered.

Files: `src/scheduler.js` (+ test; extend `tests/schedulerResilience.test.js` or add a focused file).

Acceptance:
- Failing `leave-requests` channel send: no `leave_escalated`, exactly one `leave_escalation_failed`.
- Successful send still records `leave_escalated`.
- `npm run check` passes.

Out of scope: retry policy changes; resignation reminder paths.

## Step 3 — TZ-derived local UTC offset

Intent: `README.md:261` documents `TZ` as configurable and `clock.js` uses it for calendar days (`src/clock.js:13-17`), but `LOCAL_UTC_OFFSET_HOURS = 3` is hardcoded (`src/clock.js:72-78`) and feeds `dayStartStamp` plus the SQL in `src/services/load.js:34` and `src/services/staff.js:122`. Any non-+3 fixed-offset zone produces day windows that disagree with local dates.

Files: `src/clock.js` (+ new `tests/clockTzOffset.test.js`).

Acceptance:
- With `TZ=UTC`, `dayStartStamp('2026-09-18')` is `'2026-09-18 00:00:00'`; the `Asia/Riyadh` default still yields `'2026-09-17 21:00:00'`.
- `npm run check` passes.

Out of scope: DST zone support; data migration.

## Step 4 — Document HEALTH_TOKEN requirement (manual)

Intent: `src/health.js:6-12` returns 401 without `HEALTH_TOKEN`; `deploy/staff-manager.service:15-16` sets host/port only; `README.md:120` calls the token optional without saying probes fail without it.

Manual handling: update the README health section; optionally add a commented `# Environment=HEALTH_TOKEN=` hint to the unit.

Status: BLOCKED for orchestration — `/update-docs` carries no step scope.
