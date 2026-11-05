# Constraints

## Must

- Default behaviour after upgrade = today's behaviour except: absence = 14 days and no penalty for unobserved members.
- One source of truth for thresholds/rules: `promotionRules` service. No screen may read `POINTS_THRESHOLDS` directly afterwards.
- Reuse `settings.policy` storage; numbers coerced and clamped like `leavePolicy()`.
- All settings changes audit-logged; Boss / Server Manager only.
- Arabic user-facing text; follow `kit.card` / `forms` layers.
- Ledger stays append-only and idempotent (unique `ref_id`).

## Must not

- No new dependencies; no hand-built modals; no second override mechanism.
- Don't rename `absence_10d` or touch the ledger schema.
- Don't change approval quorum, probation, leave or resignation logic.
- Don't edit unrelated lint warnings in this PR (separate cleanup).

## Code style

- Match surrounding CommonJS, `'use strict'`, small pure functions with tests; Arabic "why" comments.

## Security & privacy

- Validate every admin input at the boundary (numbers, rank names must exist in `SUPPORT_RANKS`/`MOD_RANKS`).
- Never log member DMs content; audit details contain keys/values only.

## Compatibility

- Existing tests stay green (except the known shim failure). New tests use `tests/sqlite-compat.js` + `withDate`.

## Non-goals

- UI redesign, new reports, lint cleanup.
