# Task: Fix absence penalty + make promotion system configurable

**Status:** implemented & committed — steps 1–8 done (`npm run check` green: 659/659 tests, 49 warnings / 0 errors, registry 79 • 159) · **Owner:** migneh · **Last updated:** 2026-11-07

## Goal

1. A freshly started bot no longer deducts -50 points from every staff member, and the absence threshold becomes 14 days (editable).
2. Admins choose how promotion eligibility is measured — **points only**, **score only**, or **both** — and edit the thresholds from Discord, without touching code.

## Background

- Bug (reproduced, see `03-examples.md`): `scheduler.absencePenalty` (cron `0 1 * * *`) only asks "any row in `activity_logs` in the last 10 days?". A member registered minutes ago has no rows, so they are penalised immediately (`absence_10d`, -50, anchored at today). It never checks how long the member has actually been *observed*. The repo has a single commit that deleted `data/`, so a fresh DB is the normal first-run state.
- 10 days is hardcoded in 4 places (`tenDaysAgo`, DM text, alert text, reason key `absence_10d`).
- Promotions: "points only" is hardcoded (owner decision, comments in `services/promotions.js` ~L150). Thresholds live in `constants.js` (`POINTS_THRESHOLDS`) and the 60-day transition ramp is a constant. Only `promotion.fastResponse.<team>` is overridable today via `settings.policy`.
- **Score does not exist in the repo.** `services/score.js` is referenced in many comments but the file is gone. Leftovers: `staff_members.supervisor_rating` (/25), `response_speed` (/25), `human_ratings_at`, `reports.getRaw/rawBatch` (raw factors). Its formula must be decided (Q1).

## Scope

### In scope

- **A. Absence fix:** observation-window gate; threshold from policy (default **14**); texts use the live value; one-time repair of wrongly applied penalties (Q4).
- **B. Score:** `src/services/score.js` — pure, tested, 0–100 composite built from `reports.getRaw` (Q1).
- **C. Promotion mode:** `promotion.mode` = `points` | `score` | `both` (default `points` = today's behaviour, so nothing changes until an admin switches it).
- **D. Editable rules:** `src/services/promotionRules.js` merges `constants.js` defaults + `settings.policy` overrides, with validated bounds; `evaluate()` and every display (`/promotion-info`, `/promotion-status`, `/promotion-progress`, `/my-points`, `/me`, reports) read only from it (Q3).
- **E. Admin UI:** Boss-level command to view/edit mode and thresholds per rank, reset to defaults, audit-logged (Q5).
- README + command table regenerated (`npm run docs:commands`).

### Out of scope

- Changing approval quorum logic, probation rules, leave/resignation systems.
- Rewriting the points ledger or its `rank_epoch` semantics.
- New dependencies.

## Users / entry points

Boss / Server Manager edit settings; all staff see results in `/promotion-info`, `/promotion-status`, `/promotion-progress`, `/my-points`.

## Acceptance criteria

- [x] Fresh DB + newly registered members: `absencePenalty` writes **0** rows, on day 0 and day 13 after registration.
- [x] A member with no activity for 14 observed days (and no leave) gets exactly one -50 row per absence episode (D9 anchoring preserved). Day 13 → none, day 14 → one.
- [x] Absence days editable (bounds 3–60) and DM/alert text shows the configured number.
- [x] Wrongly applied penalties are reversed per Q4, idempotently, and audit-logged.
- [x] `promotion.mode=points` → `evaluate()` output identical to today (existing tests unchanged).
- [x] `mode=score` → score gate replaces the points gate; `mode=both` → combined per Q2; gate rows show actual vs required.
- [x] Thresholds/rules editable from Discord; invalid values rejected with Arabic error; reset restores constants.
- [x] Every screen shows the same threshold the gate uses (one source of truth).

> Evidence per criterion: `05-plan.md` step notes (steps 1–6 own the absence/mode/display criteria; step 7 owns the Discord-editable one). Reverse-grip proofs and test counts recorded there.

## Definition of done

- [x] `npm run check` passes (lint 0 errors, tests, validate, docs check) — latest run: `49 problems (0 errors, 49 warnings)` · `tests 659 / pass 659 / fail 0` · `سجل سليم: 79 أمر • 159 مكوّناً` (79 • 159) · exit 0.
- [x] New tests for each criterion above.
- [x] README updated (Arabic, matching existing style).
- [x] No new dependencies.

## Open questions

All 5 answered — see `05-plan.md → Decisions`.
