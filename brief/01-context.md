# Context: staff-management (Discord staff bot, Arabic UI)

## Stack

- Node 22, discord.js v14, better-sqlite3 (CJS), node-cron, ESLint 9, `node --test`.
- Run: `npm ci` · `npm start` · `npm test` · `npm run lint` · `npm run check`.
- Sandbox note: `npm ci` needs `--ignore-scripts` here (no native build); tests then use the `node:sqlite` shim (`tests/sqlite-compat.js`). 1 test (`retentionVacuum` "live DB file replace") fails only because of the shim — pre-existing, not ours.

## Codebase map (files that matter)

| Path | Role |
|---|---|
| `src/scheduler.js` | `absencePenalty` (~L853), cron table (~L1165), `bootstrap`, `pointsEpochFlag` |
| `src/services/points.js` | Ledger. `POINTS_DEFAULTS` (`absence_10d: -50`), `getBalance`, `add` |
| `src/services/promotions.js` | `evaluate()` gates, `effectivePointsThreshold`, `stability`, `FAST_RESPONSE` |
| `src/constants.js` | `SUPPORT_PROMOTIONS`, `MOD_PROMOTIONS`, `POINTS_THRESHOLDS`, `PROBATION`, `ABSENCE` |
| `src/services/settings.js` | `policy(key, fallback)`, `setPolicy`, `resetPolicy` — stored as `settings.policy.<key>` JSON |
| `src/services/reports.js` | `getRaw`, `rawBatch` — raw factors for a window (messages, tickets, rating, warnings, notes…) |
| `src/commands/promotions.js`, `promotion-progress.js`, `my-points.js`, `my-status.js`, `reports.js`, `help.js` | consumers of thresholds / `evaluate` |
| `src/commands/setup.js`, `src/ui/forms.js` | existing modal/policy editing pattern (`leavePolicy`, `resignPolicy`) |
| `src/commands/index.js` | command + component registry (`validateRegistry`) |
| `src/database.js` | schema + `runMigrationStep` idempotent migrations |
| `tests/schedulerPointsWindows.test.js` | existing absence tests (withDate helper) |

## The 3 files that matter most

1. `src/scheduler.js` — bug A lives in `absencePenalty`.
2. `src/services/promotions.js` — mode logic and rule lookup plug in `evaluate()`.
3. `src/services/settings.js` — the only sanctioned override mechanism; reuse, don't invent another.

## Existing patterns to follow

- **Overrides:** `settings.policy('x', default)` + `setPolicy`/`resetPolicy`; precedent `leavePolicy()` merges constants → config → policy and coerces/clamps numbers.
- **Modals:** spec objects in `forms.js`/`modals` — never hand-built; `tests/modals.test.js` enforces Discord limits.
- **Commands:** `{ data, level, execute }` + `components` map; access via `commandAccess` only. After adding, `npm run validate` and `npm run docs:commands`.
- **Audit:** `audit.record({ action, actorId, details })` for every settings change.
- **Time:** use `clock.*` / `stampLocalDay` / `daysBetween`; never raw `new Date()` date math (UTC vs Riyadh traps).
- **Comments** are Arabic and explain *why*; keep that style.

## Current behavior of the bug

First boot → members registered (`staff.ensure`, `joined_at = now`, `last_activity = NULL`) → 01:00 cron → no activity rows → `recentActivity` empty → `already` empty → `points.add(-50, refId = stampLocalDay(joined_at))`. Every member, day 0.

## Gotchas

- Ledger is append-only with unique index `(reason_key, ref_type, ref_id)`; reverse by compensating rows, never DELETE.
- Keep reason key `absence_10d` (existing rows, `/my-points` labels, tests) — only the *days* become configurable.
- `rank_epoch`: balance counts current-epoch rows only; a compensating row must use the same epoch as the original.
- Score references in comments (`score.js:51/69/108/145`) are stale; fix them when the file exists.
- `POINTS_TRANSITION_DAYS` ramp applies to the *points* threshold; score is not ramped (decision in 05-plan).
