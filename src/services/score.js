'use strict';
module.exports = {
  compute: () => ({ score: 0, factors: [], raw: null, assessedMax: 0 }),
  monthlyRaw: () => ({ messages: 0, weightedMessages: 0, activeDays: 0, tickets: 0, avgRating: null, ratingCount: 0, avgDuration: null, reopened: 0, actions: 0, warnings: 0, positiveNotes: 0, negativeNotes: 0, leaveDays: 0 }),
  grade: () => '—',
  tier: () => 0,
};
