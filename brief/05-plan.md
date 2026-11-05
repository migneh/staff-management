# Plan

**Status:** approved — implementing (owner approved 2026-11-05; /setup stays Administrator-gated) · **Author:** agent · **Last updated:** 2026-11-05

## Approach

Fix the bug at its cause (no "observed long enough" gate), make the threshold a policy, then introduce a single `promotionRules` layer between `constants.js` and every consumer so mode/thresholds are data, not code. Score is rebuilt as a pure function so it is testable and can be toggled independently of points.

## Steps (one commit each)

1. **Absence gate + 14 days** — `scheduler.js`, `settings.js` (`absenceDays()`), `constants.js` (`ABSENCE.penaltyDays: 14`). Observed-since = `last_activity || joined_at`; skip until `daysBetween(...) >= days`. Texts use the value. Tests: day 0 / 13 / 14, fresh DB, existing D9 tests updated.
2. **Repair wrongly applied penalties** — idempotent `runMigrationStep('absence_reversal_v1')` (or Boss command per Q4): for each `absence_10d` row whose anchor is within N days of the member's `joined_at` and who has no activity gap proving absence → compensating row. Audit summary.
3. **`score.js`** — pure `computeScore`, weights per Q1, uses `reports.rawBatch/getRaw`. Tests with fixed raw inputs, bounds 0–100.
4. **`promotionRules.js`** — merge/validate/clamp, `getMode`, `ruleFor`, setters, reset. Tests for bounds and precedence (policy > constants).
5. **`evaluate()` integration** — mode switch, points gate (with transition ramp) and/or score gate; all other gates read `ruleFor`. Snapshot test: `points` mode identical to current output.
6. **Consumers** — `/promotion-info`, `-status`, `-progress`, `/my-points`, `/me`, `/my-status`, reports, help: replace direct `POINTS_THRESHOLDS` reads.
7. **Admin UI** (Q5) — command + modal specs + registry + audit; `validate`, `docs:commands`.
8. **Docs** — README section "كيف تعمل الترقيات" + absence 14 days; stale `score.js` comments.

## Milestones

- [ ] M1: steps 1–2 (bug fixed, can ship alone)
- [ ] M2: steps 3–5 (modes work via policy rows)
- [ ] M3: steps 6–8 (UI + docs)

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Score formula disagrees with owner's expectation | High | Q1; weights are one editable table; default mode stays `points` |
| Reversal touches legit penalties | Med | Only rows provably within observation window; dry-run report in audit first |
| Many consumers drift from the gate | Med | Remove direct `POINTS_THRESHOLDS` imports; test greps for them |
| Discord modal limits (5 fields) | Low | One modal per rank, specs validated by `modals.test.js` |

## Test plan

- Unit: absence boundaries, score bounds, rule validation, mode logic.
- Integration: `evaluate()` for points/score/both on a seeded DB; registry validation.
- Manual: switch mode in a test guild, verify `/promotion-status`.

## Decisions

Answered by the owner on 2026-11-05:

- **Q1 Score:** rebuilt from scratch as a pure 0–100 composite from `reports.getRaw` factors (activity/messages, tickets or mod actions, customer rating, response speed, warnings/negative notes). Weights live in ONE table in `score.js` and are overridable via policy `score.weights`. Supervisor rating/speed (/25 columns) feed the rating and speed parts when present.
- **Q2 both:** `promotion.bothLogic` = `all` (AND, default) | `any` (OR), selectable in settings.
- **Q3 scope:** ALL promotion rule fields are editable per rank (points/score thresholds, months, actions, minMessages, minActiveDays, maxWarnings, rating, windowDays, approvals). Needs two modal pages per rank (Discord max 5 fields per modal).
- **Q4 repair:** automatic one-time idempotent migration adds compensating +50 rows for provably wrong penalties; summary written to audit log and staff-logs.
- **Q5 UI:** a section inside `/setup`. ⚠ `/setup` is gated to Discord **Administrator** (see `src/index.js` `isSetup`), not Boss. Default decision: keep that gate, as the other policy editors there do; say so if you want Boss/Server Manager to edit too (would need a small access change in `index.js`).

Defaults I chose without asking (shout if wrong):
- Reason key stays `absence_10d`; `absenceDays` policy default 14, editable 3–60 from the same `/setup` section.
- Absence "observed since" = `last_activity || joined_at`; probation members are NOT exempt unless `probation_exempt` (unchanged).
- Transition-ramp (60 days, 1/3→full) stays for points only; score thresholds are not ramped.
- Default `promotion.mode = points`, so nothing changes in promotions until an admin switches it.

## Rollback

All behaviour is behind policy defaults; revert per commit. Reversal rows are compensating — a second compensating row restores the original state.
