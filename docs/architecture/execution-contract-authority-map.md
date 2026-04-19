# Execution Contract Authority Map

## Purpose

Define one stable authority model for chat execution in Footnote.

The short version is simple: the contract governs and the orchestrator
executes.

## Canonical Terms

`Execution Contract` is the backend contract for allowed execution behavior,
limits, verification expectations, and fail-open semantics.
`chatOrchestrator` carries out one request under that contract.
`planner` can propose action details, but it cannot change the rules.
`workflow profile` is the named step pattern selected under the contract.
`trace/provenance` records what happened.

Implementation note:
Current code still uses `ExecutionContract` naming for the main contract module.
That module is still the main Execution Contract module.

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

The Execution Contract is the governing contract for execution behavior. The
orchestrator coordinates the request at runtime. Planner is a bounded helper,
not a second orchestrator, and its output is advisory. Workflow profiles stay
inside the contract. External evidence systems such as TrustGraph can inform
execution, but they do not become routing or terminal authorities. Provenance
records decisions after execution; it does not become a second decision engine.

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
