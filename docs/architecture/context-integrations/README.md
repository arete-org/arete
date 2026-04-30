# Context Integrations

Context integrations are outside systems the backend can call during a
request.

They can add context, evidence, references, or other useful signals.

Footnote still decides how to handle the request. The outside system does not
choose the action, end execution, or change policy and verification rules.

This category exists because an outside system can start as "extra evidence"
and gradually become a hidden decision-maker. A web search result might begin
as a few trace links, then start influencing source choice, evidence judgment,
or whether another step runs. If that raw output starts changing routing,
verification, or execution policy on its own, the backend has given up too
much control.

## How outside data can be used

Context integrations can still influence a request in limited ways.

The backend may use approved integration outputs through backend-owned
mappings, rules, and checks. That can help with things like evidence views,
trace detail, or other bounded context signals.

So outside data can affect execution, but only through backend-owned
interpretations.

For example, a public code-search or web-search API might return links,
snippets, or coverage-like signals. Footnote may use those results as one
input to a backend-owned judgment. The backend might turn them into a limited
internal view such as "supporting material may exist" or "another review step
may be useful." That internal view can influence later behavior, but only
because Footnote interprets it through its own rules.

What should not happen is direct authority. Raw integration output should not
decide routing, terminal states, verification, or policy on its own. In
practice, that means no outside field should act like a switch such as
`confidence > threshold -> skip review` or `top result present -> do not
search again`.

Footnote is open source, so this boundary needs extra care. Outside systems
may have a decent idea of the inputs, prompts, and runtime behavior the
backend expects. If a raw outside result can directly trigger execution
behavior, a public-facing integration can start shaping decisions the backend
no longer fully owns.

| Use         | Example                                                           | Why                                                                                                     |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Allowed     | `outside source link -> trace link list`                          | The outside result adds context for the reviewer, but Footnote still decides how to handle the request. |
| Allowed     | `coverage estimate -> trace note that evidence may be incomplete` | The outside result can help describe the evidence without taking control of execution.                  |
| Not allowed | `outside confidence score -> skip verification`                   | The outside system would be deciding a backend policy outcome.                                          |

The guardrail has three parts: by design, the integration is advisory; by
policy, some decisions stay backend-owned; and by implementation, only
reviewed outputs should flow into bounded internal views.

## What stays local

Some parts of the request stay backend-owned:

| Question                                         | Who stays in charge                        | What that means in practice                                                                       |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| What kind of response should this request get?   | backend contract and orchestration         | Outside systems do not choose the action, route, or response shape.                               |
| Is this request allowed to take a certain path?  | backend policy and execution rules         | Outside systems do not relax limits, verification, or safety rules.                               |
| When is execution finished?                      | backend runtime                            | Outside systems do not get terminal authority.                                                    |
| What evidence or context may be considered?      | backend-owned integration seam             | Outside systems can provide limited input, but only through governed mappings and reviewed rules. |
| What should a reviewer be able to see afterward? | backend provenance and observability paths | If outside context mattered, Footnote should record that clearly.                                 |

## Failure handling

These integrations usually need two kinds of failure handling.

Sometimes the backend should refuse to use the outside result at all. This
happens when scope, tenancy, safety boundaries, or contract safety look wrong.

Sometimes the backend should ignore the outside failure and keep serving the
local request. This happens when the external system is slow, unavailable,
disabled, or otherwise not required for the base response path.

The exact boundary depends on the integration. Footnote still decides which
failure becomes a hard stop and which one only drops outside context.

## Provenance and observability

If a context integration influences a run, that influence should be visible
after the fact.

In practice, that usually means:

| Record             | What it shows                                                                                       |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| bounded metadata   | a small response-facing summary of the outside influence, without dumping the full external payload |
| provenance records | the reviewer-facing record of what outside context was used, denied, dropped, or ignored            |
| status codes       | whether the integration ran, failed, timed out, was skipped, or was denied                          |
| reason codes       | why the integration ended in that state                                                             |
| structured logs    | machine-readable records that help operators debug the path later                                   |

A reviewer should be able to tell whether outside context was used, denied,
dropped, or ignored.

## Integration patterns

Context integrations use different patterns today. They are not fully unified
under one path.

### Workflow context-step execution

`weather_forecast` uses the workflow context-step execution path for
bounded-review modes (`balanced` and `grounded`). In this pattern:

- Executes through `workflowEngine` with an injected `ContextStepExecutor`
- Executes before the `generate` step in bounded-review workflows
- Handles clarification, failure, and success through the workflow termination
  flow
- Preserves fail-open semantics

The adapter `toolRegistryContextStepAdapter.ts` implements this pattern while
keeping the workflow engine provider-neutral.

### Evidence ingestion seam

`TrustGraph` uses a separate evidence-ingestion seam. It is not implemented as
a workflow context-step executor. In this pattern:

- Flows through `chatService` evidence ingestion, not workflowEngine
- Handles scope validation and ownership separately from workflow execution
- Records provenance separately from workflow step records
- Is documented in [trustgraph.md](./trustgraph.md)

### Tool-registry path

`web_search` and other tools still use the traditional tool-registry path
instead of workflow context-step execution.

## Current docs

- [TrustGraph](./trustgraph.md)
- [Weather Forecast](./weather-forecast.md)
