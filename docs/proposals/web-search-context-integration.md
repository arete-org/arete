# Feature Proposal: Web Search Context Integration

**Last Updated:** 2026-04-30

---

## Overview

Search is one of the places where Footnote's architecture has to be especially
careful.

A weather forecast can come from one provider response. Web search is messier.
A query may go through one provider, fall back to another, return a list of
possible sources, pass only some of those into generation, and cite only a
subset in the final answer. If that chain is hidden inside runtime behavior,
Footnote cannot explain it well.

This proposal moves `web_search` toward the same workflow context-step plane
now used by `weather_forecast`. Planner can continue to express the need for
search as `generation.search`, but execution becomes explicit: which provider
was tried, what it returned, what was injected into generation, and what was
later cited.

The working rule is that **search discovery is not source reading**. Search
results give Footnote candidate sources. Reading and quoting those sources is a
later, stronger step.

---

## Why This Matters For Footnote

Search is where Footnote's provenance ideals meet the open web.

If retrieval stays hidden inside a model runtime, the system can report that
search happened, but it cannot clearly explain what was searched, which
provider was used, what was discovered, what was shown to the model, and what
the final answer relied on. That is a weak fit for a project that wants answers
to be checkable.

Workflow-owned context-step execution is a better fit because it makes the
search chain inspectable. It gives Footnote one place to record request
intent, provider attempts, discovered records, injected context, and later
citation reconciliation.

---

## Current Problem

The current chat path still splits search behavior across multiple layers.
Planner emits `generation.search`. Retrieval runs inside provider/runtime paths
when supported. `chatService` then infers retrieval usage from runtime signals,
citations, and provenance.

That arrangement works, but it is harder to review than the weather
context-step path. It also leaves more room for ambiguity around basic
questions such as:

- what search was requested
- which provider path actually ran
- what the provider returned
- what went into generation
- what the final answer cited

`web_search` is not yet a workflow context-step execution path.
`weather_forecast` is the current concrete example of that path.

SearXNG and Brave provider clients do not exist in the repo yet.

---

## Scope And Boundaries

This proposal covers a workflow context-step integration capability named
`web_search`. Provider choice stays behind that capability boundary.

Planner timing does not move here. Planner continues to emit
`generation.search`, and orchestration continues to apply policy before
execution.

This proposal also does not implement full page reading in the first phase.
Discovery records can include URL, title, snippet, provider, rank, and
retrieved timestamp. Reading page content is later work.

---

## Provider Philosophy

The first search providers should reflect two needs: operator control and
practical reliability.

SearXNG is a good fit as an optional primary provider because it can be
self-hosted and configured by the operator. That makes it easier to inspect,
tune, and explain than a search path hidden inside a model provider. It also
keeps Footnote from depending on one commercial search API as the default path
to grounded answers. The trade-off is that quality and reliability depend on
configuration, upstream engines, and deployment.

Brave is a useful companion provider because it offers a structured search API
with more predictable availability. It can act as a fallback when SearXNG is
unavailable, or as a primary provider for deployments that prefer a hosted API.
Because it is vendor-backed and API-key-based, its use should be explicit in
configuration and visible in trace metadata.

Model-native search is different again. It may be useful, but it should not be
treated as equivalent unless it returns auditable source records. If a model
can search but cannot expose usable URLs or source records, it should not
satisfy the same contract as `web_search`.

Provider assumptions should stay conservative:

- SearXNG exposes HTTP search endpoints (`/` and `/search`) and can return JSON
  when configured.
- SearXNG is a metasearch layer; downstream websites are the source
  authorities.
- Brave Search API is API-key-backed and returns structured web result records.

References:

- <https://docs.searxng.org/dev/search_api>
- <https://api-dashboard.search.brave.com/app/documentation/web-search/codes>
- <https://brave.com/search/api/>

---

## Target Shape

`web_search` remains the integration capability. SearXNG, Brave, and
model-native search sit behind it as strategies.

The intended flow is:

```text
planner emits generation.search
workflow converts search need to web_search context-step request
context integration adapter chooses provider strategy
provider returns normalized source records
workflow injects compact source block into generation
response metadata reconciles which injected records were cited
```

This moves search into the same workflow-owned plane used for other context
integrations while keeping `workflowEngine` provider-neutral.

---

## Data Shape Draft (High-Level)

The first implementation does not need a large citation redesign. It needs
enough structure to preserve the search chain. The types below show the
intended shape rather than a final contract.

```ts
type WebSearchProviderName = 'searxng' | 'brave' | 'model_native';

type WebSearchAttemptStatus =
    | 'executed_with_results'
    | 'executed_empty'
    | 'skipped'
    | 'failed';

type WebSearchProviderSkipOrFailReason =
    | 'provider_not_configured'
    | 'provider_disabled_by_policy'
    | 'provider_missing_api_key'
    | 'provider_timeout'
    | 'provider_invalid_response'
    | 'model_native_sources_unavailable'
    | 'tool_unavailable'
    | 'unspecified_tool_outcome';

type WebSearchContextStepRequest =
    | {
          integrationName: 'web_search';
          requested: true;
          eligible: true;
          input: {
              query: string; // non-empty
              intent: 'repo_explainer' | 'current_facts';
              contextSize: 'low' | 'medium' | 'high';
              repoHints?: string[];
              topicHints?: string[];
          };
          providerPolicy: WebSearchProviderPolicy;
      }
    | {
          integrationName: 'web_search';
          requested: boolean;
          eligible: false;
          reasonCode?: ToolInvocationReasonCode;
          input?: undefined;
          providerPolicy?: WebSearchProviderPolicy;
      };

type WebSearchProviderPolicy = {
    providerPriority: WebSearchProviderName[];
    allowModelNativeSearch: boolean;
    requireAuditableModelNativeSources: boolean;
    maxResults?: number;
    timeoutMs?: number;
};

type WebSearchProviderAttempt = {
    provider: WebSearchProviderName;
    status: WebSearchAttemptStatus;
    reasonCode?: WebSearchProviderSkipOrFailReason;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    resultCount?: number;
};

type WebSearchSourceRecord = {
    id: string;
    url: string;
    title?: string;
    snippet?: string;
    label?: string;
    rank?: number;
    provider: WebSearchProviderName;
    retrievedAt: string;
};

type WebSearchContextStepResult = {
    executionContext: ToolExecutionContext;
    attempts: WebSearchProviderAttempt[];
    discovered: WebSearchSourceRecord[];
    injected: WebSearchSourceRecord[];
    contextMessages?: string[];
};
```

- `discovered` and `injected` belong to context-step output.
- final `cited` ownership belongs to response metadata / post-generation
  reconciliation.

---

## Mode Fit

Search should be available to all chat modes through workflow infrastructure
when policy and provider configuration allow it. That includes `fast`, with
strict budgets, because targeted grounding can be better than no grounding.

This proposal intentionally avoids detailed budget tables. Mode-level numeric
budgets should be defined in implementation policy and profile config.

---

## Provenance, Trace, And Citation Semantics

Provider transparency should be explicit in trace and details. Citation
authority should remain with discovered source URLs, not provider names.

Trace/details should be able to show:

- search query and high-level policy context
- provider attempts and outcomes
- discovered records
- injected records
- how final citations map back to injected/discovered records

That matters because search results are only one part of the chain. A snippet
can help Footnote decide where to look, but it is not the same thing as
reading the page.

---

## Privacy And Security Note

Search queries may be sent to configured external providers. Provider choice
and enablement should therefore remain explicitly policy/config controlled.

Defaults should be conservative. If search is unavailable, the system should
say so or continue with clear limits rather than pretending it searched. Trace
output should avoid exposing secrets or raw provider credentials.

---

## Rollout Path

The rollout should stay small:

1. Keep this proposal and add tests that pin current search behavior.
2. Introduce provider-neutral search context-step types/interfaces with no
   behavior change.
3. Add SearXNG adapter behind config.
4. Add Brave adapter and deterministic fallback handling behind config.
5. Add workflow context-step execution for `web_search` behind feature flag.
6. Prefer explicit context-step retrieval signals over heuristic inference when
   available.
7. Add later page-fetch/context-read integration as separate follow-up work.
8. Add later model-native reconciliation rules.

---

## Risks

The main risk is overstating what search results prove. A snippet can help
decide where to look, but it is not the same thing as reading the page. Early
versions should label search records as discovered or injected context, not as
fully verified evidence.

Provider fallback needs care too. If SearXNG fails and Brave succeeds, that is
a useful recovery path, but it should be visible in trace. Otherwise fallback
hides the actual route the answer took.

Fast mode also needs strict budgets. Search can make fast answers more
grounded, but it can also add latency and provider dependency. Fast should use
small result counts and short timeouts rather than bypassing search entirely.

Model-native search remains another risk area. It may be convenient, but it
should not count as the same class of integration unless it returns auditable
source records.

Open questions remain:

- When both are configured, which provider should be default primary?
- Should fast mode search be default with strict limits, or opt-in by profile?
- When are discovered records sufficient, and when should page fetch be
  required?
- What is the exact auditable minimum for model-native search records?
- Which provider-attempt fields should be user-visible vs trace-only?
