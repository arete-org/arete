# Execution Contract TrustGraph Architecture

## What This Is

This subsystem lets the backend ask an external TrustGraph service for extra evidence during a chat request.

That evidence can improve context, but it is never allowed to take control of the request. TrustGraph does not decide what action to take, does not decide when execution is done, and does not get to relax verification. The backend keeps those jobs.

In practical terms, this is an optional evidence lookup step inside the chat pipeline, wrapped in a lot of guardrails because the cost of getting scope or authority wrong is high.

If you are new to this code, the easiest mental model is:

- The **Execution Contract** is the backend's rulebook for what is allowed to happen during execution.
- **`executionContractTrustGraph`** is a narrow integration seam that lets the backend borrow outside evidence under that rulebook.
- **TrustGraph** is a retrieval source, not a planner, not a router, not a workflow engine, and not an authority.

## 1. System Identity And Authoritative Terminology

These terms matter and should stay stable in code and docs:

- **Execution Contract**: the backend-owned contract that decides what transitions are legal, what terminal states mean, when verification is required, and how fail-open / fail-closed behavior works.
- **`executionContractTrustGraph`**: the backend module that retrieves and sanitizes advisory TrustGraph evidence under Execution Contract rules.
- **TrustGraph**: an external evidence source. It can contribute bounded signal. It cannot take over execution.
- **provenance**: the record of what evidence was used, what was ignored, and why. In this subsystem, provenance is how a reviewer can reconstruct TrustGraph's influence after the fact.

## 2. Request Walkthrough First

Before the deeper architecture sections, here is the request flow in plain English.

Concrete example:

- A Discord request comes in with `surfaceContext.userId=user_1` and `surfaceContext.channelId=project_1`.
- The backend may ask TrustGraph for evidence scoped to that user and project.
- Even if TrustGraph returns useful evidence, the backend still decides what response to send.

### Normal success path

1. A chat request enters the backend.
2. The orchestrator decides what kind of response to produce. That decision stays local.
3. If the request includes explicit scope inputs, the backend builds a TrustGraph scope tuple.
4. The scope is validated. Ownership is checked through a trusted backend tenancy validator.
5. If scope is valid, the adapter makes one bounded TrustGraph call.
6. The returned bundle is sanitized.
7. Only governed fields are mapped into the backend's predicate views.
8. The response still comes from the normal backend path. TrustGraph only adds advisory context and provenance.

### Scope-denied path

1. A chat request reaches the same backend path.
2. Scope is missing, malformed, ambiguous, conflicting, or fails ownership validation.
3. External retrieval is denied immediately.
4. The backend still completes the chat request locally.
5. The denial is recorded with explicit reason codes so reviewers can see why retrieval did not run.

### Adapter timeout or error path

1. Scope passes validation.
2. The backend calls TrustGraph with a timeout budget and cancellation signal.
3. The adapter times out or fails.
4. External evidence is dropped.
5. The backend still produces the local response.
6. Logs and provenance reason codes record that the external call timed out or errored.

Why the split matters:

- External retrieval is **fail-closed** because scope mistakes can leak data across tenants.
- Local chat execution is **fail-open** because users should still get a response when external retrieval is unavailable.

## 3. Mission And Engineering Ethos Alignment

Footnote cares about transparency, provenance, bounded behavior, and clear authority boundaries.

This integration exists to improve context without quietly changing who is in charge. That sounds simple, but it is easy to get wrong. Retrieval systems tend to spread. First they provide evidence, then someone uses one extra field for ranking, then someone else starts using that ranking to skip review. This design is built to stop that progression early.

What this design protects:

- Extra evidence can be used without giving away execution control.
- Tenant boundaries are checked before any external retrieval happens.
- Reviewers can see what outside evidence influenced the request.
- Local behavior keeps working when external dependencies fail.

What this design explicitly rejects:

- TrustGraph deciding what action to take
- TrustGraph deciding whether execution is finished
- raw adapter payload reaching decision logic
- confidence scores acting like policy thresholds
- silent scope broadening
- hidden retries or loops that make retrieval operationally mandatory

## 4. Historical Design Evolution

This subsystem did not start in its current shape.

Early design work used the EPC framing and `epcTrustGraph` naming. That naming was eventually dropped because it was not clear enough about the real governing idea: the backend owns an **Execution Contract**, and TrustGraph lives underneath that contract as a constrained external dependency.

There was also temporary "Pattern A" language during exploration. That was removed because it added taxonomy without adding clarity.

The important review findings from earlier iterations were concrete:

- raw adapter payload was too close to execution-facing logic
- ownership validation was too easy for callers to skip
- bypass behavior was too easy to misconfigure
- timeout handling did not actually stop adapter work
- poisoned evidence could still leave stale aggregate influence behind
- some naming made TrustGraph sound more central than it really was

The hardening work that followed did not redesign the system. It tightened the seam:

- only governed fields can influence predicate views
- ownership validation became explicit and fail-closed
- bypass behavior moved behind trusted policy objects and capabilities
- timeouts now trigger cancellation
- dropped evidence neutralizes aggregate influence
- provenance became more specific and reviewer-readable
- runtime wiring was added so the rules were enforced in the real request path, not just seam tests

## 5. Governing Execution Contract Model

The Execution Contract is the governing layer here. TrustGraph sits underneath it.

### What the Execution Contract is responsible for

- deciding what execution path is legal
- keeping routing decisions in backend code
- keeping terminal decisions in backend code
- requiring verification regardless of adapter signals
- choosing when to fail open and when to fail closed
- preserving provenance for any external influence

### What it is not responsible for

It is not a generic retrieval abstraction and it is not a place to dump arbitrary adapter data. If a new field matters to runtime behavior, it must be explicitly governed.

### Influence vs authority

This distinction is the core of the design.

- **Influence** means TrustGraph can contribute bounded evidence that the backend may consider through governed views.
- **Authority** means deciding what to do, when to stop, what counts as valid state, or whether verification is needed.

TrustGraph is allowed to influence a narrow set of evidence-related views. It is not allowed to hold authority.

### Why this rule exists - Influence vs authority

Without this boundary, retrieval systems become stealth decision systems. The failure mode is not dramatic. It usually looks like "we only used one extra field" or "we only skipped one check when confidence was high." That is exactly how architecture drifts into something no one meant to build.

### Common mistake - Influence vs authority

Adding a new adapter field and threading it into runtime logic "just for ranking" or "just for better defaults." If that field is not explicitly governed, it is a design break, not a convenience.

## 6. Trust Model And Safety Boundaries

This section explains the rules that keep the integration safe.

### 6.1 Why raw adapter payload is forbidden

Raw adapter payload is dangerous because it creates hidden control channels.

If raw fields reach execution-facing logic, future edits can start depending on them by accident. That is how an external system quietly gains influence nobody reviewed.

The runtime therefore exposes only:

- governed predicate views
- bounded provenance summaries
- explicit status and reason codes

It does not expose raw adapter bundles to decision logic.

### 6.2 Governed fields and the mapping registry

TrustGraph data only matters after it passes through an explicit mapping registry.

If you are new to the naming here:

- `P_SUFF` is the backend's sufficiency view. It answers "does this evidence look broad or complete enough to be useful?"
- `P_EVID` is the backend's evidence view. It carries reviewer-facing source and trace references.

These are called **predicate views** because they are shaped for narrow backend checks, not because TrustGraph is evaluating policy on its own.

Today the approved mappings are:

- `coverageEstimate.value` -> `P_SUFF`
- `coverageEstimate.evaluationUnit` -> `P_SUFF`
- `conflictSignals` -> `P_SUFF`, `P_EVID`
- `items[].sourceRef` -> `P_EVID`
- `items[].provenancePathRef` -> `P_EVID`
- `traceRefs` -> `P_EVID`

These mappings are immutable at runtime.

Fields that are explicitly forbidden as direct control inputs include:

- `confidenceScore`
- `items[].confidenceScore`
- raw adapter ranking fields
- any unregistered field

### Why this rule exists - Confidence handling

Confidence is especially easy to misuse. A confidence score looks numeric and useful, so engineers naturally want to threshold on it. But that turns opaque adapter behavior into backend policy. This design blocks that on purpose.

Concrete bad example:

- "If confidence is above 0.9, skip verification."

That would look harmless in a code review and would be a direct architecture violation.

### Common mistake - Confidence handling

Treating "confidence" as if it means "safe to trust." It does not. At best it is an advisory retrieval-side signal.

### 6.3 Scope and tenancy model

External retrieval can only run when the **scope tuple** is both valid and owned by the caller.

A scope tuple is the small set of IDs that defines what the adapter is allowed to look at. In practice that means `userId` plus either a `projectId` or `collectionId`, depending on the request.

That means:

- `userId` must be present and well-formed
- `projectId` and `collectionId` must be well-formed if present
- ambiguous or conflicting tuples are denied
- ownership validation must pass when policy requires it

There is no fallback from a narrow scope to a broader one.

For example:

- "user + project" is okay if ownership validates
- "user + collection" is okay if ownership validates
- "user only" is denied when project-or-collection scope is required
- "user + project + collection" is denied when the tuple is ambiguous

### Why this rule exists - Scope and tenancy

Scope mistakes are data boundary mistakes. If the system guesses, broadens, or silently falls back, the bug is no longer just "retrieval quality." It becomes a tenant-isolation failure.

### Common mistake - Scope and tenancy

Trying to improve retrieval hit rate by relaxing scope validation or by backfilling missing scope from unrelated request fields.

### 6.4 Ownership validation and bypass hardening

Ownership validation is controlled by an explicit typed policy: `TrustGraphOwnershipValidationPolicy`.

In runtime production wiring, the policy is **required** mode. That means:

- external retrieval cannot proceed without an ownership decision
- a missing validator denies retrieval
- an untrusted validator source denies retrieval
- malformed validator results deny retrieval

There is also an `explicitly_none` bypass mode in core types, but runtime production wiring does not use it.

### Why this rule exists - Ownership validation

"Optional if the caller remembers" is not a real safety boundary. If ownership validation matters, the integration seam has to enforce it.

### Common mistake - Ownership validation

Passing an ad hoc validator from a random call site because it matches the interface shape. The contract is stricter than shape alone. Source trust matters too.

Another easy mistake is thinking "deny retrieval" means "deny the chat request." It does not. Ownership failures block external retrieval only. The local chat path still runs.

### 6.5 Timeout, cancellation, and poisoned evidence

The adapter runs with a timeout budget and `AbortSignal`.

If it times out:

- cancellation is requested
- timeout reason codes are recorded
- local execution continues

If evidence items are invalid or poisoned:

- they are dropped
- dropped IDs are recorded
- aggregate coverage/conflict signals are neutralized if the remaining bundle can no longer support them

### Why this rule exists - Timeout and cancellation

Two quiet failure modes are being prevented here:

- a timed-out dependency that keeps running in the background and ties up resources
- a filtered bundle that still leaves behind stale aggregate values, making it look stronger than the surviving evidence supports

## 7. Current Runtime Architecture

This is the actual request path as implemented today.

### 7.1 Runtime config surface

The backend config section is `executionContractTrustGraph`.

It includes:

- `enabled`
- `killSwitchExternalRetrieval`
- `policyId`
- `timeoutMs`
- `maxCalls`
- `adapter`
- `ownership`

Adapter mode is one of:

- `none`: no adapter wired
- `stub`: test or local development behavior
- `http`: real HTTP adapter wiring

Ownership binding mode is one of:

- `none`
- `http`

### 7.2 Runtime wiring

`resolveExecutionContractTrustGraphRuntimeOptions` is the place where config becomes live runtime behavior.

It does a few important things:

- returns `undefined` when the feature is disabled
- returns `undefined` when the kill switch is active
- creates the required ownership-validation policy
- wires the adapter based on config
- wires the tenancy ownership validator when configured
- threads timeout budget into ownership validation as well as adapter retrieval
- logs how the runtime was wired

### Why this rule exists - Runtime wiring

This keeps risky enablement decisions in one place. If wiring is scattered across `server.ts`, handlers, and services, it becomes much easier to accidentally run with the wrong combination of policy, adapter, and validator.

### Common mistake - Runtime wiring

Adding a shortcut path that injects an adapter directly into a caller without going through runtime wiring.

### 7.3 Server and handler path

- [server.ts](../../../packages/backend/src/server.ts) builds runtime config and passes resolved TrustGraph options into the chat handler.
- [chat.ts](../../../packages/backend/src/handlers/chat.ts) keeps transport concerns separate and passes the TrustGraph options into orchestration.

Nothing about HTTP transport changes TrustGraph's role. It still remains a bounded retrieval seam.

### 7.4 Orchestrator path

[chatOrchestrator.ts](../../../packages/backend/src/services/chatOrchestrator.ts) is still the authority for action selection.

It builds a TrustGraph scope tuple only from explicit scope-bearing request fields. It does not repurpose `sessionId` as retrieval scope. `sessionId` stays what it should be: a correlation/conversation field.

If no valid scope input exists, the orchestrator does not invent one.

This is a place where junior engineers often get tripped up: the orchestrator is allowed to decide whether retrieval is attempted, but it is not allowed to let TrustGraph decide what action the user gets back. Those are separate concerns.

### Why this rule exists - Orchestrator scope

Correlation IDs and retrieval scope mean different things. Reusing one as the other is convenient, but wrong.

### Common mistake - Orchestrator scope

Using `sessionId`, message IDs, or other request correlation fields as a shortcut for project scope.

### 7.5 Chat service path

[chatService.ts](../../../packages/backend/src/services/chatService.ts) calls `runEvidenceIngestion` when both of these exist:

- runtime TrustGraph options
- a TrustGraph context from the orchestrator

If ingestion succeeds:

- the service attaches a bounded `trustGraph` metadata envelope
- the service keeps local response generation unchanged
- the service can derive evidence score from governed sufficiency data

If ingestion fails or retrieval is denied:

- the chat request still completes
- the local response path stays intact
- logs record what happened

The public metadata path redacts scope values and does not expose raw scope tuples inside provenance joins.

Why this matters:

- public trace metadata may be visible in places where raw tenant or Discord identifiers should not leak
- debugging convenience is not a good enough reason to expose those identifiers

### 7.6 Scope, ownership, adapter, and provenance internals

The main module responsibilities are:

- [scopeValidator.ts](../../../packages/backend/src/services/executionContractTrustGraph/scopeValidator.ts): validates scope shape, ambiguity rules, ownership requirements, and ownership timeout handling
- [tenancyOwnershipValidator.ts](../../../packages/backend/src/services/executionContractTrustGraph/tenancyOwnershipValidator.ts): adapts a backend tenancy service into the validator contract
- [tenancyOwnershipHttpService.ts](../../../packages/backend/src/services/executionContractTrustGraph/tenancyOwnershipHttpService.ts): performs HTTP ownership checks with timeout and cancellation
- [trustGraphHttpAdapter.ts](../../../packages/backend/src/services/executionContractTrustGraph/trustGraphHttpAdapter.ts): performs the TrustGraph HTTP evidence call with response validation
- [trustGraphEvidenceIngestion.ts](../../../packages/backend/src/services/executionContractTrustGraph/trustGraphEvidenceIngestion.ts): runs the bounded ingestion pipeline
- [provenanceJoin.ts](../../../packages/backend/src/services/executionContractTrustGraph/provenanceJoin.ts): builds the reviewer-facing external artifact join

### 7.7 Kill switch behavior

`killSwitchExternalRetrieval=true` disables adapter injection at the runtime wiring boundary.

That means:

- no external retrieval is attempted
- local behavior continues normally
- rollback is immediate and simple

## 8. Provenance And Observability

### 8.1 Provenance

The provenance join is there so a reviewer can answer a basic question: "What outside evidence affected this run, and how?"

That sounds abstract, so here is the concrete use case: a future reviewer should be able to inspect a response and tell which governed TrustGraph fields were consumed, which evidence items were dropped, and whether retrieval was denied, timed out, or succeeded.

The join records:

- `externalEvidenceBundleId`
- `externalTraceRefs`
- `adapterVersion`
- `consumedGovernedFieldPaths`
- `consumedByConsumers`
- `droppedEvidenceIds`
- `reasonCodes`

The public metadata path does not include raw scope identifiers inside the provenance join.

### Why this rule exists - Provenance join

Without a readable join, outside influence becomes hard to audit. A trace that technically exists but is not understandable is not good enough.

### 8.2 Observability

Current runtime logging covers:

- whether the adapter was invoked or skipped
- adapter success, timeout, and error states
- scope denial reason codes
- ownership denial classification
- bypass denial flags
- provenance reason codes

What it does not yet provide is a mature metrics layer with counters, dashboards, and SLIs.

That gap matters because logs are good for debugging one incident, but they are weaker for answering questions like "how often is ownership denial happening?" across a week of traffic.

## 9. Test Coverage And Proven Guarantees

This subsystem has meaningful test coverage, but it is important to separate what is actually proven from what is only assumed.

### 9.1 Seam-level contract tests

[trustGraphContract.test.ts](../../../packages/backend/test/trustGraphContract.test.ts) covers:

- raw adapter payload staying out of execution-facing surfaces
- mapping registry immutability
- unregistered fields staying inert
- scope rejection paths
- ownership required / pass / fail behavior
- bypass hardening
- adapter timeout cancellation
- ownership timeout cancellation
- poisoned evidence neutralization
- provenance join detail
- ON/OFF authority stability
- adapter bundle scope mismatch denial

### 9.2 Service, orchestrator, and handler tests

- [chatService.test.ts](../../../packages/backend/test/chatService.test.ts): metadata integration, public redaction, and ON/OFF authority stability
- [chatOrchestratorExecutionContractTrustGraph.test.ts](../../../packages/backend/test/chatOrchestratorExecutionContractTrustGraph.test.ts): real orchestrator path behavior, including the `sessionId` regression guard
- [chatHandler.test.ts](../../../packages/backend/test/chatHandler.test.ts): HTTP/runtime path behavior, ownership denial, timeout/error fail-open behavior, disable/kill-switch behavior, and observability event emission

### 9.3 What is proven

The current tests prove:

- TrustGraph does not take routing authority in the local runtime path
- TrustGraph does not take terminal authority in the local runtime path
- external retrieval denies access on invalid scope or failed ownership validation
- local execution continues on adapter timeout or error
- raw adapter payload does not escape into tested execution-facing surfaces
- public metadata redacts scope-sensitive data

That is a good level of confidence for the seam and the runtime path, but it is still not the same thing as proving the external services are production-safe.

### 9.4 What is not proven

The current tests do not prove:

- real production tenancy service correctness
- real TrustGraph service quality or retrieval quality
- operational reliability under live traffic
- mature alerting and SLI coverage

That is why the production-readiness recommendation is still conservative.

## 10. Production-Readiness Status

Current recommendation: **ready behind flag**.

That means the code path is real, tested, and intentionally wired into the runtime, but it should still be deployed as a controlled feature with clear operational ownership.

### Current Rollout Boundary

- Backend runtime-path integration is implemented in this repo.
- External TrustGraph service implementation is not implemented in this repo.
- Current rollout-prep work hardens backend config/runtime behavior and documentation.
- Full deployment rollout is blocked on a pinned external TrustGraph service contract:
- image/repository source
- endpoint path contract
- auth/token contract
- health/readiness contract
- first-pass persistence expectations (stateless or not)

### What is already in good shape

- runtime integration exists
- safety boundaries are implemented in code
- kill switch exists
- external retrieval fails closed when scope safety breaks
- local chat execution keeps working when retrieval fails

### What still needs care

- real tenancy ownership service deployment and monitoring
- real TrustGraph adapter deployment and monitoring
- production config hygiene
- better operational metrics

### What remains fail-closed

- malformed scope
- ambiguous or conflicting scope
- missing validator under required mode
- untrusted validator under required mode
- malformed validator result
- adapter bundle scope mismatch

### What misconfiguration looks like today

- If the adapter is unset or miswired, TrustGraph retrieval simply does not help. Local responses still work.
- If ownership validation is required but not wired, external retrieval is denied.
- If the kill switch is on, the system immediately falls back to local-only behavior.
- If `stub` mode leaks into a production-like environment, tests may still pass while real external value is absent. That is why `stub` should stay non-production.

This is an important theme in the whole design: most bad runtime configurations fail safe, but they can still hide the fact that the external system is providing no real benefit.

### Deployment Next Steps

1. Pin the external TrustGraph service contract (image + HTTP + health + auth).
2. Add local Docker service wiring only after that contract is pinned.
3. Add private Fly app wiring only after that contract is pinned.
4. Validate local and Fly behavior parity with `enabled`, `kill switch`, ownership denial, and adapter timeout/error paths.
5. Keep backend kill switch as the canonical rollback control during rollout.

## 11. Known Risks And Non-Goals

### Sequencing posture (roadmap guardrail)

This subsystem is intentionally positioned as **foundation and seam hardening**, not near-term architectural centrality.

In concrete roadmap terms:

- Execution-spine contract/orchestrator work remains the primary center in this phase.
- TrustGraph foundation work should track that spine and avoid forcing architecture around itself.
- Activation should happen only when pinned external service contracts and operations are ready.
- Expansion into broad evidence-platform work is out of scope until the execution spine is stable.

### Remaining risks

- This is still an in-process trust boundary. A careless future edit can bypass the intended seam because all of this code lives in the same backend process.
- Operational misconfiguration can silently reduce external benefit while staying fail-safe.
- Observability is still log-first rather than metric-first.

### Non-goals

This subsystem is not trying to solve:

- TrustGraph-based routing
- TrustGraph-based terminal decisions
- implicit goal creation
- accepted-fact promotion from retrieval output
- hidden background retries or workflow-like orchestration

## 12. Architectural Lies We Eliminated

These are the false but tempting ideas the current design had to stamp out.

1. "Confidence can double as policy confidence."
   Why it was wrong:
   Confidence came from the adapter, not from backend governance. Treating it like policy input would have handed too much control to an external system.

2. "Ownership checks are fine as optional caller behavior."
   Why it was wrong:
   Optional security checks are usually forgotten checks. The seam now enforces the rule instead of trusting call sites to remember it.

3. "Timeout means we can move on even if the adapter keeps running."
   Why it was wrong:
   That leaks work into the background and hides resource problems. The timeout path now requests cancellation.

4. "Dropped evidence can still leave useful aggregate signals behind."
   Why it was wrong:
   Once the underlying evidence is removed, the aggregate can become misleading. The implementation now neutralizes those stale signals.

5. "A seam test is enough even if runtime wiring is separate."
   Why it was wrong:
   A subsystem is not safe just because its isolated helper passes tests. The real request path had to be wired and tested too.

## 13. Most Likely Regression Points

These are the places future edits are most likely to break the design.

1. Adding a new adapter field and consuming it without explicit mapping governance.
2. Relaxing scope validation for convenience.
3. Reintroducing raw payload exposure for debugging.
4. Letting adapter status influence routing or terminal behavior.
5. Reusing correlation fields as retrieval scope.
6. Adding retry loops around adapter HTTP calls and quietly turning retrieval into orchestration.
7. Weakening provenance detail because the payload feels too large.
8. Exposing raw tenant or Discord identifiers through public metadata.

If you touch one of these areas, slow down and re-check the governing rules before you merge.

## 14. Design Rules Future Changes Must Not Violate

These are the hard lines.

1. No raw payload escape hatches into execution-facing decision logic.
2. No TrustGraph routing authority.
3. No TrustGraph terminal authority.
4. No verification suppression from adapter signals.
5. No implicit scope broadening.
6. No hidden retries, loops, or orchestration creep.
7. No accidental bypass enablement.
8. No unguided accepted-fact promotion or implicit goal creation from retrieval output.
9. No provenance weakening that hides consumed fields, consumers, dropped evidence, or reason codes.
10. No naming drift that makes TrustGraph sound more authoritative than it is.
