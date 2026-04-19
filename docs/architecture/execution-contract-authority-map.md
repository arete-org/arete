# Execution Contract Authority Map

## Purpose

Define one stable authority model for chat execution in Footnote.

Target statement:

`The contract governs. The orchestrator executes.`

## Canonical Terms

- `Execution Contract`: the governing backend contract for allowed execution shape, limits, verification expectations, and fail-open semantics.
- `chatOrchestrator`: the runtime coordinator that carries out one request under the contract.
- `planner`: a bounded workflow step owned by workflow logic; it can propose action details but cannot mutate hard execution authority.
- `workflow profile`: a named workflow shape selected under the contract.
- `trace/provenance`: evidence of what happened relative to contract-governed execution.

Implementation note:
Current code still uses `ExecutionContract` naming for the main contract module.
That module is the Execution Contract authority surface.

## Ownership

| Concern                           | Governing Authority                                                       | Runtime Executor                                       | Notes                                                                                                |
| --------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Execution rules and legal shape   | Execution Contract (`packages/backend/src/services/executionContract.ts`) | `chatOrchestrator` + workflow runtime                  | Runtime must satisfy contract fields; runtime does not redefine ontology.                            |
| Request execution coordination    | Execution Contract (policy bounds)                                        | `packages/backend/src/services/chatOrchestrator.ts`    | Orchestrator selects/coordinates steps inside contract limits.                                       |
| Planner step invocation           | Workflow-owned planner boundary under Execution Contract bounds           | `chatPlanner` invoked by `chatOrchestrator` today      | Planner output is advisory. Planner-as-workflow-step is future direction, not current runtime shape. |
| Workflow/profile semantics        | Execution Contract response/limit constraints + workflow profile contract | `workflowProfileRegistry` + `workflowEngine`           | Profiles are named execution shapes, not competing policy authorities.                               |
| Model/provider/tool selection     | Execution Contract routing intent and limits                              | orchestrator + resolver/services + runtime adapters    | Selection details are execution assembly under contract constraints.                                 |
| Trace and provenance recording    | Execution Contract requirement to track provenance                        | `chatService`, trace store, response metadata emitters | Provenance records what happened; it does not set policy.                                            |
| TrustGraph evidence intake        | Execution Contract boundary rules                                         | `executionContractTrustGraph` seam modules             | Advisory evidence can influence bounded views, never control execution authority.                    |
| Breaker/safety action application | Deterministic safety contract + backend policy boundary                   | orchestrator/service enforcement path                  | Planner hints are advisory only.                                                                     |

## Boundaries

- The Execution Contract is the single governing contract for execution shape.
- The orchestrator is the request-time execution coordinator.
- Planner is a bounded helper with workflow-owned boundaries, not a second orchestrator.
- Planner outputs are advisory and cannot directly override Execution Contract authority.
- Workflow profiles remain named shapes selected under the contract.
- External evidence systems (including TrustGraph) never become routing or terminal authorities.
- Provenance explains decisions after execution; it does not become a second decision engine.

## Non-Goals

- Turn the Execution Contract into a general runtime engine.
- Replace orchestrator control flow with a contract interpreter.
- Introduce user-defined workflow programming in this phase.
- Treat provider abstraction as solved by this authority-map document.

## Extension Checklist

When adding execution behavior:

1. Add or update the Execution Contract field first when governance changes.
2. Keep runtime wiring (`chatOrchestrator`, workflow engine, services) as implementation under that field.
3. Add/adjust tests that prove authority does not drift.
4. Update this authority map when module ownership changes.
