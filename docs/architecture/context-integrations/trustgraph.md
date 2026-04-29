# TrustGraph

TrustGraph is an optional context integration for Footnote.

It lets the backend ask an external service for extra evidence during a chat
request. That evidence can improve context, but it does not get to decide what
response Footnote sends, when execution is done, or whether verification still
applies.

Today this path exists in code, but it is not yet a central or fully activated
part of the product. The shared rules for context integrations are in the
parent [README](./README.md).

## Request path

| Case             | What happens                                                                                                                                                                                                        | What Footnote still decides                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Normal retrieval | The orchestrator builds a TrustGraph scope tuple from explicit request inputs. Scope and ownership pass. The adapter makes one bounded call. Returned evidence is sanitized and mapped into governed backend views. | The normal backend path still decides the final response.                                |
| Scope denied     | Scope is missing, malformed, ambiguous, conflicting, or fails ownership validation. External retrieval does not run.                                                                                                | The backend still completes the local chat request and records why retrieval was denied. |
| Timeout or error | Scope passes, but the adapter times out or fails. External evidence is dropped.                                                                                                                                     | The backend still produces the local response and records what failed.                   |

## Scope and ownership

External retrieval can run only when the scope tuple is both valid and owned by
the caller.

In practice that means:

- `userId` must be present and well-formed
- `projectId` or `collectionId` must be well-formed when present
- ambiguous or conflicting tuples are denied
- ownership validation must pass when policy requires it

There is no fallback from a narrow scope to a broader one.

| Scope shape                   | Result                                              |
| ----------------------------- | --------------------------------------------------- |
| `user + project`              | allowed when ownership validates                    |
| `user + collection`           | allowed when ownership validates                    |
| `user only`                   | denied when project-or-collection scope is required |
| `user + project + collection` | denied when the tuple is ambiguous                  |

## Allowed inputs

TrustGraph data matters only after it passes through governed backend mappings.

| Use         | Example                                              | Why                                                                                |
| ----------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Allowed     | `items[].sourceRef -> evidence view shown in trace`  | TrustGraph can add reviewer-facing evidence context without deciding execution.    |
| Allowed     | `coverageEstimate.value -> bounded sufficiency view` | The backend still decides what that sufficiency view means and how it may be used. |
| Not allowed | `confidenceScore -> skip verification`               | TrustGraph would be deciding a backend policy outcome.                             |

The current predicate views are:

- `P_SUFF`: sufficiency view
- `P_EVID`: evidence view

Current approved mappings include:

- `coverageEstimate.value` -> `P_SUFF`
- `coverageEstimate.evaluationUnit` -> `P_SUFF`
- `conflictSignals` -> `P_SUFF`, `P_EVID`
- `items[].sourceRef` -> `P_EVID`
- `items[].provenancePathRef` -> `P_EVID`
- `traceRefs` -> `P_EVID`

Raw adapter fields must not escape into execution-facing decision logic. That
includes raw payload bundles, raw ranking fields, `confidenceScore`,
`items[].confidenceScore`, and any unregistered field.

Confidence is the easiest example to misuse. It is tempting to treat a
numeric field like policy input, even when it only reflects opaque adapter
behavior. TrustGraph confidence is not backend policy confidence.

## Runtime wiring

The backend config surface is `executionContractTrustGraph`.

It currently includes fields such as:

- `enabled`
- `killSwitchExternalRetrieval`
- `policyId`
- `timeoutMs`
- `maxCalls`
- `adapter`
- `ownership`

In the current implementation:

- `server.ts` resolves runtime options
- the chat handler passes those options into orchestration
- the orchestrator decides whether retrieval is even attempted
- `chatService` calls evidence ingestion only when runtime options and a valid
  TrustGraph context both exist

The kill switch lives at the runtime wiring boundary. If it is on, no external
retrieval is attempted and local behavior continues normally.

`chatOrchestrator` is still the authority for action selection. It may:

- decide whether retrieval is attempted
- build a TrustGraph scope tuple from explicit scope-bearing request fields
- pass bounded TrustGraph context to downstream services

It may not:

- invent retrieval scope from unrelated correlation fields
- repurpose `sessionId` as retrieval scope
- let TrustGraph decide what action the user gets back

Code references:

- [server.ts](../../../packages/backend/src/server.ts)
- [chat.ts](../../../packages/backend/src/handlers/chat.ts)
- [chatOrchestrator.ts](../../../packages/backend/src/services/chatOrchestrator.ts)
- [chatService.ts](../../../packages/backend/src/services/chatService.ts)

## Recorded afterward

If TrustGraph influences a run, that influence should be visible afterward.

| Record          | What it shows                                                     |
| --------------- | ----------------------------------------------------------------- |
| public metadata | a bounded `trustGraph` metadata envelope attached to the response |
| provenance join | what outside evidence was consumed, dropped, denied, or ignored   |
| reason codes    | why retrieval succeeded, failed, timed out, or was denied         |
| structured logs | machine-readable runtime detail for operators and debugging       |

The current provenance join records fields such as:

- `externalEvidenceBundleId`
- `externalTraceRefs`
- `adapterVersion`
- `consumedGovernedFieldPaths`
- `consumedByConsumers`
- `droppedEvidenceIds`
- `reasonCodes`

Public metadata redacts scope-sensitive values. It does not expose raw scope
tuples or raw tenant identifiers in provenance joins.

## Current state

Current tests cover the seam and the real runtime path well enough to prove a
few important things:

- TrustGraph does not take routing authority in the local runtime path
- TrustGraph does not take terminal authority in the local runtime path
- external retrieval is denied on invalid scope or failed ownership validation
- local execution continues on adapter timeout or error
- raw adapter payload does not escape into tested execution-facing surfaces
- public metadata redacts scope-sensitive data

Useful test entrypoints include:

- [trustGraphContract.test.ts](../../../packages/backend/test/trustGraphContract.test.ts)
- [chatService.test.ts](../../../packages/backend/test/chatService.test.ts)
- [chatOrchestratorExecutionContractTrustGraph.test.ts](../../../packages/backend/test/chatOrchestratorExecutionContractTrustGraph.test.ts)
- [chatHandler.test.ts](../../../packages/backend/test/chatHandler.test.ts)

The current tests do not prove:

- real production tenancy service correctness
- real TrustGraph service quality
- operational reliability under live traffic
- mature metrics, dashboards, or alerting

That is why the activation story should stay conservative.

Today this is a real seam with guarded runtime wiring, not yet a fully
activated product dependency.

What is already in good shape:

- runtime integration exists
- bounded authority rules are implemented
- kill switch exists
- unsafe retrieval paths fail closed
- local chat execution keeps working when retrieval fails

What still needs care before broader activation:

- real TrustGraph service deployment details
- real tenancy ownership service deployment details
- production config hygiene
- stronger operational observability

## Related docs

- [Context Integrations](./README.md)
- [Workflow](../workflow.md)
- [Answer Posture And Control Influence](../answer-posture-and-control-influence.md)
