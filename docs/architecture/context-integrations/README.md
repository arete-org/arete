# Context Integrations

Context integrations are outside systems the backend can call during a
request.

They can add context, evidence, references, or other useful signals.

Footnote still decides how to handle the request. The outside system does not
choose the action, end execution, or change policy and verification rules.

This category exists because it is easy for an outside system to start as
"extra evidence" and slowly turn into a hidden decision-maker. For example,
Footnote might first use a web search result only to show a few extra links in
the trace. Later, it might use the same result to decide which sources look
strongest, whether enough evidence was found, or whether another search step
should run. After that, it is a short step to using the same result to change
routing, skip verification, or otherwise shape execution policy. At that point,
the outside system is no longer just adding context, but starting to decide
more than it should.

## How outside data can be used

Context integrations can still influence a request in limited ways.

The backend may use approved integration outputs through backend-owned
mappings, rules, and checks. That can help with things like evidence views,
trace detail, or other bounded context signals.

That means outside data can affect execution, but only through backend-owned
interpretations of that data.

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
may have a fairly good idea of the kinds of inputs, prompts, and runtime
behavior the backend expects. If a raw outside result can directly trigger
execution behavior, then a public-facing integration can start shaping
decisions in ways the backend no longer fully owns.

| Use         | Example                                                           | Why                                                                                                     |
| ----------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Allowed     | `outside source link -> trace link list`                          | The outside result adds context for the reviewer, but Footnote still decides how to handle the request. |
| Allowed     | `coverage estimate -> trace note that evidence may be incomplete` | The outside result can help describe the evidence without taking control of execution.                  |
| Not allowed | `outside confidence score -> skip verification`                   | The outside system would be deciding a backend policy outcome.                                          |

The guardrail is a combination of design, policy, and implementation:

- by design, the integration is advisory
- by policy, some decisions stay backend-owned
- by implementation, only reviewed outputs should flow into bounded internal
  views

## What stays local

Some parts of the request stay backend-owned.

| Question                                         | Who stays in charge                        | What that means in practice                                                                       |
| ------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| What kind of response should this request get?   | backend contract and orchestration         | Outside systems do not choose the action, route, or response shape.                               |
| Is this request allowed to take a certain path?  | backend policy and execution rules         | Outside systems do not relax limits, verification, or safety rules.                               |
| When is execution finished?                      | backend runtime                            | Outside systems do not get terminal authority.                                                    |
| What evidence or context may be considered?      | backend-owned integration seam             | Outside systems can provide limited input, but only through governed mappings and reviewed rules. |
| What should a reviewer be able to see afterward? | backend provenance and observability paths | If outside context mattered, Footnote should record that clearly.                                 |

## Failure handling

These integrations usually need two different kinds of failure handling.

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

## Current docs

- [TrustGraph](./trustgraph.md)
- [Weather Forecast](./weather-forecast.md)
