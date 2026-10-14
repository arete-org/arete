# Typed training retrieval

The analytics capability exposes `query_training(request)` to personal coaching.
Its schema accepts declared entities, fields, filters and aggregates. The domain
service owns all SQL; callers cannot supply SQL, joins or athlete identities.
Existing BM25 memory, activity detail, fitness and workload tools remain available.
Background briefings and feedback still bind no tools.

| Entity | Observation | Values |
| --- | --- | --- |
| `sessions` | Completed session | Distance (m), duration (s), HR (bpm), pace/GAP (s/km), ascent (m), temperature (°C), RPE, presence of coach feedback |
| `days` | Stored local day | Sleep duration (s), HRV (ms), resting HR (bpm), sleep/readiness scores |
| `plans` | Prescription | Target distance (km), duration (min), status, completed (0/1) |
| `strength` | Logged strength session | Duration (s), RPE, working-set volume (kg·reps) |

`services/training_query.py` declares the production catalog, units and permitted
projections. Sleep is attributed to its recorded waking day. Session dates use
the stored athlete-local date, not a new conversion of a possibly UTC timestamp.
Daily measurements can filter sessions (for example, running pace after short
sleep), but daily aggregates require `entity="days"`, so two sessions cannot
count the same night's sleep twice. These are associations, not causal evidence.

Terrain, weather and feedback join by actual session ID, each at most once.
Plan completion uses the authoritative actual-session link: multiple completed
sessions linked to one plan count that plan once; a status label or a proposed
match alone is insufficient. Model-excluded activities cannot establish completion.
Strength uses the existing volume calculator on non-warmup sets before session
aggregation. An unknown weight makes that session's volume unknown, rather than
silently zero. A linked strength session is excluded when its actual session is
excluded or no longer visible. Strength and cardio are separate entities, so
cross-entity totals must not double-count linked sessions.

Nulls remain unknown. Aggregates report known/missing observation counts; an
empty/all-unknown sum is null, while count is zero. Means are unweighted.
RPE and strength logs are athlete statements; feedback is coach interpretation;
terrain is calculated and weather is an external estimate. Existing specialized
tools own CTL/ATL/ACWR and stream calculations; this service does not reimplement them.

Queries require inclusive start/end dates covering at most 366 days. They allow
eight filters, eight projected fields, and one metric with sum/avg/min/max/count,
optionally grouped by day, Monday-based week, month, sport or status. Compare two
periods with two calls. Sport equality on running/cycling expands the shared aliases.
All private relations use the scoped live views; source exclusions also apply to
joined recovery and completion evidence. String filter values are bound parameters.

Reads stop at 2,000 observations and 20,000 working sets. Exceeding a bound returns
an error asking for a smaller window, without a partial aggregate. Row results
are paginated in stable date/ID order, at most 50 per call, with `has_more` and
`next_offset`; aggregates refuse more than 50 groups. The normal 32,000-character
tool output cap returns an explicit error rather than silently dropping evidence.
Each result includes units, source IDs, dates and coverage. Database observations
do not prove provider completeness; Garmin freshness context supplies that separately.

Example: running distance by week in September:

```json
{
  "request": {
    "entity": "sessions",
    "start_date": "2026-09-01",
    "end_date": "2026-09-30",
    "filters": [{"field": "sport", "op": "eq", "value": "running"}],
    "metric": "distance_m",
    "aggregate": "sum",
    "group_by": "week"
  }
}
```

The [frozen experiment](session-retrieval-evaluation.md) motivated typed access.
The production adapter has real-schema isolation, source, date, missing-value,
join-grain and bound tests. Its interface differs from the synthetic candidate;
the pilot's 16/20 score is not a measured production accuracy guarantee.
