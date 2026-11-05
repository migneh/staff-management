# Examples

## Example 1 — the bug (reproduced)

Insert one `active` support member with no activity, joined now; run `scheduler.absencePenalty({})`.
**Today:** `promotion_points` gets `{ points: -50, reason_key: 'absence_10d', ref_id: <today> }`.
**Expected:** no row. At `joined_at + 13d` none; at `+14d` exactly one (anchor = `joined_at` day).

## Example 2 — active member, quiet 13 days

`last_activity` 13 days ago → no penalty. 14 days ago, no leave → one row, anchor = that day, never again for the same episode (existing D9 tests keep passing, with 14 instead of 10).

## Example 3 — promotion modes (numbers illustrative, final per Q1–Q3)

Support → Support Expert, member has 520 points, score 71:
- `points` (threshold 500): gate ✅
- `score` (threshold e.g. 75): gate ❌ "71 / 75+"
- `both`: ❌ (AND) or ✅ (OR) per Q2

## Example 4 — admin edit

`/promotion-settings` → mode `both` → edit "Support → Support Expert": points 450, score 70 → saved, audit row `promotion_rules_updated`, `/promotion-info` shows 450 / 70 immediately.

## Counter-example

**Bad:** just change `10` → `14` in `scheduler.js`. Fresh members would still be penalised on day 0.
**Bad:** add `if (mode === 'score')` in each command. Gates must come from `evaluate()` only.
**Bad:** DELETE the wrongly created -50 rows. Ledger is append-only; compensate.
