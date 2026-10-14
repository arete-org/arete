# Session retrieval experiment

**Preferred candidate for the next design review: Typed.** On the complete
20-case holdout, typed access and typed access with relationships each scored
16/20, versus 2/20 for the baseline and 12/20 for curated SQL. Typed has less
interface complexity, roughly half the baseline's median latency and 64% fewer
held-out input tokens. The experiment itself changed no production retrieval tool.

Following explicit owner approval, the PR adds **typed-only production access**
through `query_training`; see [its contract](typed-training-retrieval.md).
Relationship traversal and agent-written SQL remain isolated benchmark candidates.
The frozen results below describe the synthetic candidate interfaces, not a live
evaluation of the production adapter. No paid cases were rerun after this decision.

This is a narrow pilot, not a general winner claim. Differences among the new
candidates remain statistically inconclusive, and the holdout contains only two
synthetic histories. Isolation/source-exclusion tests passed, but the corpus
and strict evidence grading have the limitations described below.

The machine-readable [report](session-retrieval-results.json) contains all 60
offline outcomes and all 240 live case/variant outcomes, raw answers, resource
usage, the frozen scoreboard and separately labelled sensitivity diagnostics.
The live run used 539 model requests and 357 tool executions in 14m 46s.
Reported spend was **$0.165331**, against **$1.365204** conservatively reserved
and the agreed $2 cap. Twelve rate-limit failures occurred in development
(three per variant); they were not retried. Every held-out case completed.

## Frozen corpus and common evidence

`tests/data/session_retrieval_cases.jsonl` was frozen before candidate
implementation. Its SHA-256 is
`081f72ea0abad7fc287f07c2d780489c5517d6564375a409d4a88e339a398708`.
The runner verifies the digest and never regenerates cases while evaluating.
`scripts/retrieval_eval/prepare.py` documents their deterministic construction.

There are six synthetic September histories and ten French questions per
history: four histories/40 questions for development, two histories/20 questions
held out. Nine question types concern longitudinal data: volume and pace period
changes, pace after short sleep, daily HRV, adherence, hilly-run GAP, heart rate
in heat, strength volume and coach feedback coverage. Named-session lookup is
the regression slice. Gold values and contributing IDs were computed with
Python arithmetic independently of the SQL/typed candidate execution.

`scripts/retrieval_eval/catalog.json` declares fields, units, grains, provenance
and joins. Candidate snapshots resolve completion links from
`plans.actual_id`; proposed session plan IDs without a confirmed completion are
not treated as authoritative edges. Sessions and plans retain authoritative
IDs; daily observations are stored once; strength sets are represented by their pre-aggregated session
volume. Dates are athlete-local and sleep belongs to the recorded waking day.
Missing values remain NULL. Terrain/weather are stored measurements; feedback
is explicitly coach interpretation. The corpus has no athlete-statement claims.
No association is evidence of a causal effect.

The baseline populates a disposable application-schema database and calls the
existing analytics, planning and strength read tools. It therefore reuses the
existing calculators for those tools. Candidates read the same stored metric
facts; they do not introduce alternative GAP or training-load formulas.
Snapshot construction removes other athletes and excluded Strava sources before
any candidate receives evidence. Scope rejection is covered by ordinary tests.

## Candidates and limits

| Variant | Access |
| --- | --- |
| Baseline | Existing analytics, planned-session and strength read tools; production BM25 retrieval implementation over synthetic passages |
| Typed | BM25 plus declared filters, up to two grouping dimensions and sum/average/min/max/count |
| Typed + relationships | Typed access plus BM25 expansion and one-hop traversal of authoritative plan/completion/day links; at most 20 seeds and 40 nodes |
| Curated SQL | BM25 plus model-written flat SELECTs on the same four declared tables |

All candidates receive the same catalog and bounded initial lexical evidence;
relationship expansion is the explicit treatment difference. Tools return IDs,
units/catalog metadata and coverage/limit indicators. Results exceeding 100 rows
or 24 KB fail explicitly. Invalid queries are reported to the model and counted;
they never become empty successful context.

SQL is executed in a disposable non-root Docker container: no network, no host
mounts or credentials, read-only filesystem, 512 MiB memory, one CPU, 64 PIDs,
dropped capabilities and no privilege escalation. Input is synthetic JSON on
stdin, capped at 2 MB. DuckDB uses one thread, a 256 MiB internal memory limit,
disabled external access/extensions and locked settings. A two-second query
interrupt and a 15-second container-start/execution deadline are separate;
cleanup forcibly removes an orphan container if the Docker client times out.

The AST validator permits one flat SELECT, declared tables/functions and at
most two declared foreign-key joins. It rejects external reads, writes, CTEs,
subqueries, cross joins and daily aggregates through session joins. The
container remains necessary: DuckDB explicitly treats SQL as executable code
and requires an operating-system boundary for untrusted execution.
See [DuckDB's security model](https://duckdb.org/security).

Live settings are pinned to `z-ai/glm-5.3-flash`, low reasoning, temperature 0,
2,048 output tokens, 60-second timeout, zero retries and zero provider/model
fallbacks. Existing $0.15/$0.50 per million input/output price caps apply.
Each case/variant allows four model calls and six executed tools. The runner
reserves conservative worst-case cost before dispatch using a UTF-8-byte token
upper bound, never refunds reservations, and stops at $2, 960 model requests or
two hours including offline checks. Four consecutive infrastructure errors also stop
the experiment. No model judge or production retrieval integration is used.

Numerical correctness with source support is primary: tolerance is 0.1 absolute
or 0.1% relative, at least 80% gold-source recall, no unsupported source IDs and
no asserted causal claim. Reports retain raw answers, numerical correctness,
evidence recall, unsupported claims, query failures, model/tool calls, token
usage and latency. A complete paired 20-case holdout gets a deterministic
2,000-resample bootstrap interval for the correctness difference. A positive
interval only requests review of isolation and cost/latency trade-offs; it does
not automatically install a winner.

## Live results

The primary score requires the correct number, at least 80% gold-source recall,
valid JSON and no unsupported cited IDs/claims. Infrastructure failures are
excluded from quality denominators. Each development denominator is 37; all
held-out denominators are 20.

| Variant | Development | Held out | Held-out median latency | Model/tool calls on holdout | Held-out input/output tokens |
| --- | ---: | ---: | ---: | ---: | ---: |
| Baseline | 6/37 | 2/20 (10%) | 5.223 s | 47 / 37 | 213,146 / 7,176 |
| Typed | 31/37 | 16/20 (80%) | 2.407 s | 43 / 27 | 76,984 / 4,854 |
| Typed + relationships | 33/37 | 16/20 (80%) | 2.326 s | 42 / 26 | 82,013 / 4,769 |
| Curated SQL | 28/37 | 12/20 (60%) | 3.498 s | 46 / 30 | 83,187 / 4,934 |

Latencies include model/tool execution but exclude constructing the synthetic
application database. Totals across all attempts were 1,359,063 reported input
tokens and 60,445 reported output tokens. The reported monetary total is from
provider response metadata; per-variant actual billing was not retained.

On the holdout, final citation recall was 13.35%, 82.75%, 82.75% and 62.75%
respectively. Unsupported-source/claim flags were 3, 0, 0 and 5. Query failures
were 0, 1, 0 and 3; the baseline also exhausted its six-tool budget once. Across
all 60 cases, query failures were 0, 1, 0 and 10. These counts include raised
exceptions and oversized results; native error payloads are not separately
classified. Full retrieved tool-evidence traces were not retained: citation
recall is distinct from the initial lexical retrieval recall below.

The paired 2,000-resample case bootstrap gives typed versus baseline **+70
percentage points [50, 90]**, relationships versus baseline **+70 [50, 90]**,
and SQL versus baseline **+50 [30, 70]**. Typed versus relationships is **0
[-15, 15]**; typed versus SQL is **+20 [-5, 45]**. Thus the pilot supports richer
metric access over the current baseline, but does not establish a quality
ranking among the new candidates. These are case-level intervals: correlated
questions from only two held-out histories limit population inference.

Prefer typed access as the simpler candidate to validate next. Relationships
showed no held-out correctness gain, and SQL added query failures and container
execution without a demonstrated numerical advantage. This is not evidence
that graphs or SQL are generally inferior; this corpus often allows answers
from one pre-aligned table. Do not integrate a candidate automatically.

### Scoring sensitivity, without changing the frozen result

A separate read-only analysis extracts a leading JSON object when the model
appended prose. It does not validate that prose or promote a failed answer.
Under this diagnostic, correct numbers occurred in **6/20 baseline** cases and
**20/20 for each new candidate**. Correct numbers with the frozen source support
occurred in **4/20, 18/20, 18/20 and 13/20** respectively. Format-only failures
account for two baseline, two typed, two relationship and one SQL held-out case.

Both feedback-count questions expose a gold-evidence limitation: the frozen
oracle sums a 0/1 field across every session and expects every inspected ID,
while a valid filtered count can cite only positive matches. This penalizes
otherwise correct counts in all three new candidates. Keep those frozen scores
visible; improve evidence equivalence in a new, separately frozen benchmark
before treating this pilot as a production-quality ranking. No prompt, candidate
or grader was tuned during the live run.

## Observed offline results

| Check | Development | Held out |
| --- | ---: | ---: |
| Typed query vs independent numeric/evidence gold | 40/40 | 20/20 |
| SQL oracle in restricted container vs the same gold | 40/40 | 20/20 |
| Initial BM25 evidence recall | 16.03% | 16.03% |
| Initial BM25 with relationship expansion evidence recall | 16.03% | 16.03% |
| Attempted live case/variant runs | 160 | 80 |
| Successful infrastructure outcomes | 148 | 80 |

The final offline run took approximately 18.6 seconds in SQL oracle container
invocations, with median 252 ms per case (period comparisons use two queries).
Initial BM25 retrieval median was 0.59 ms. These timings include local container
overhead and are not model-answer latency or deployment capacity estimates.
Resource ceilings were enforced; peak RSS/CPU utilization were not measured.

Oracle success establishes that the declared operations can compute the gold
answers. It does **not** establish that an agent can select those operations or
answer correctly. The 16% recall only describes initial lexical selection before
tool use, not the baseline agent's eventual evidence recall. Unchanged expansion
recall is not evidence against explicit link traversal after a targeted query.

The dataset is intentionally small, with ten templates repeated across six
histories. It checks missing observations and repeated daily sessions but does
not establish generalization to arbitrary athlete language, DST conversion,
real provider outages or causal reasoning in unrestricted prose. Those limits make broader generalization and quality differences among the
new candidates inconclusive; the recommendation above is for the next design
review, not automatic production adoption.

## Reproduce

From the repository root:

```sh
uv sync --dev
docker build -t arete-retrieval-eval:1 scripts/retrieval_eval
uv run python scripts/retrieval_eval/run.py --sql-oracles
uv run pytest tests/test_session_retrieval_eval.py
```

For the opt-in model run, configure `OPENROUTER_API_KEY` in the ignored local
environment, then run:

```sh
ARETE_EVAL=1 uv run python scripts/retrieval_eval/run.py --sql-oracles --live
```

The runner writes `.context/session-retrieval-report.json` after each live case.
Reservations are also persisted before dispatch in
`.context/session-retrieval-budget.json`. A second paid invocation is refused
while that ledger exists: reconcile prior spend before deliberately starting a
new experiment. Interrupted requests are never automatically replayed. Do not
run `prepare.py` to improve candidate results or reinterpret oracle checks as held-out model evaluation.
Normal CI uses synthetic data and mocks, with no live model or Docker requirement.

Reproduce the separately labelled diagnostics without sending requests:

```sh
uv run python scripts/retrieval_eval/report.py --input docs/session-retrieval-results.json --output .context/retrieval-diagnostics.json
```
