# Contracts

## Policy keys (`settings.policy`)

| Key | Type | Default | Bounds |
|---|---|---|---|
| `absenceDays` | int | 14 | 3–60 |
| `promotion.mode` | `'points'\|'score'\|'both'` | `'points'` | enum |
| `promotion.bothLogic` | `'all'\|'any'` | `'all'` | enum |
| `promotion.rule.<team>.<fromRank>` | JSON partial of rule | `{}` | per-field, see below |

Rule fields overridable (all, per Q3): `pointsThreshold` (1–10000), `scoreThreshold` (1–100), `months` (0–36), `actions` (0–1000), `minMessages` (0–5000), `minActiveDays` (0–windowDays), `maxWarnings` (0–10), `rating` (1–5), `windowDays` (7–365), `approvals` (1–3). `score.weights` optional policy: object of non-negative numbers summing to 100.

## Service API

```js
// src/services/promotionRules.js
getMode() -> 'points'|'score'|'both'
ruleFor(team, fromRank) -> { ...constantsRule, pointsThreshold, scoreThreshold }   // merged + validated
setRule(team, fromRank, partial, actorId) -> { ok, errors? }
resetRule(team, fromRank) ; setMode(mode)

// src/services/score.js  (pure)
computeScore(raw, team, opts?) -> { total: 0..100, parts: {name: points} }
```

## Ledger

Compensation row: `reason_key 'absence_reversal'`, `ref_type 'absence'`, `ref_id` = original anchor, `rank_epoch` = original row's epoch, points = `-original.points`, `added_by 'system'`. Add to `POINTS_DEFAULTS`-style labels used by `/my-points`.

## Audit actions

`absence_days_updated`, `promotion_mode_updated`, `promotion_rules_updated`, `promotion_rules_reset`, `absence_penalties_reversed`.

## State

Mode switch takes effect on next `evaluate()`; pending promotion requests keep their stored snapshot.
