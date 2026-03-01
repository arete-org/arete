# Philosophy

Footnote is an experiment in **steerable AI**—assistants you can guide and inspect.

(Last updated: 2026-02-28)

## What Footnote is today

Footnote is currently:

- a Discord bot,
- a web interface, and
- a backend API.

Current features include stored response traces and provenance metadata, citations and risk tiering, and self-hosting support. The user-facing experience today centers on Discord interaction (chat, voice, and commands), the web demo, and trace inspection (what shaped the reply, within privacy constraints).

Demo: [ai.jordanmakes.dev](https://ai.jordanmakes.dev)

## The goal

### Steerable AI

In this project, “steerable” is the target shape:

- Defaults and constraints are explicit.
- Changing those settings predictably changes behavior.

Steerability is broader than transparency. The point isn’t just to see what happened after the fact, but to make it easier to guide the system on purpose.

### Answers you can check

“Checkable” means you can tell what an answer is based on, and what would change it.

Depending on the question, that can include:

- configuration/defaults,
- sources used (if any),
- key assumptions,
- uncertainty when it’s filling in gaps.

**Not checkable:**

> “Yes, that’s true.”

**More checkable:**

> “Yes—based on the cited source and the stored trace. I’m assuming you mean the current implementation; if the deployed version or date is different, the answer changes.”

Links: [trace page source](../packages/web/src/pages/TracePage.tsx), [OpenAPI trace definitions](./api/openapi.yaml), [citation handling](../packages/discord-bot/src/utils/openaiService.ts)

## Why build it this way

A lot of assistants fail in a predictable way: they give an answer that sounds fine, but they don’t leave you anything to follow, and may be wrong in subtle ways. Footnote is about creating useful answers with a trail you can follow when it matters.

## Design constraints

This only works if the system is built with some constraints in mind:

- be plain about limits and uncertainty,
- protect privacy and make review possible,
- avoid coercive certainty on value-laden questions,
- surface trade-offs and let the user choose when values are involved,
- leave enough traceability that someone else can inspect what happened.

### Openness and choice

A few constraints matter beyond the assistant’s output:

- **Open development.** Footnote is developed in the open, with an emphasis on self-hosting and inspectability. (See [LICENSE_STRATEGY.md](./LICENSE_STRATEGY.md) for the exact terms)
- **Plurality.** The system should make room for different value frameworks and user goals, especially when questions involve trade-offs.
- **Accessibility.** Where possible, users should have practical options: how they host, which model/provider they use, and what costs they take on.

### Profiles as rulesets

**Ari** is the current baseline configuration.

If/when a multi-profile system is shipped, a profile would be a bundle of defaults:

- enforceable constraints (policy rules)
- style guidance for the model.

Current baseline prompt reference: [defaults.yaml](../packages/discord-bot/src/utils/prompts/defaults.yaml)

## What’s planned

Planned direction, subject to change as the project evolves:

- More checks and enforcement outside the model.
- Stronger “lookup required” behavior for time-sensitive queries.
- A multi-profile system with clearer policy controls, enforceable tool permissions, and export/diff/sharing.
- Broader model/provider support over time, including paths for local or low-cost deployments where feasible.

## How to tell if it’s working

Footnote is doing its job if you can answer:

- Why did it say this?
- What did it use?
- What did it assume?
- What configuration was active?
- What would I change to get a different result?

## Related work

There’s a lot of adjacent work in “explainability,” “transparency,” and “governance,” but it often targets a different object.

Many explainability tools focus on predictive ML models: “why did the model predict X?” That’s useful for supervised models and decision pipelines, where the goal is to understand feature influence and sensitivity.

Footnote’s focus is different: “why did the assistant say X, and what shaped that result?” Here the unit is the _interaction_: the prompt/context, any retrieval/citations, the assistant’s chosen framing, and the trace/provenance artifacts that let a human review what happened after the fact.

This puts Footnote closer to work on:

- **Provenance and audit trails**: capturing artifacts that let someone inspect a response later, especially when the answer matters or is disputed.
- **Human-in-the-loop oversight**: designing systems that expect review, correction, and escalation instead of assuming a single-shot answer is enough.
- **Model documentation practices** (e.g., model cards): making limits and intended use explicit, even when the underlying system is probabilistic.

Some open-source projects (for example, initiatives like “Facet” in the explainability space) aim to make model behavior more interpretable. That work can complement Footnote: model interpretability helps answer “what patterns does this model rely on?”, while Footnote is primarily about making _assistant behavior and outputs_ reviewable and steerable through traces, provenance, and user-facing inspection surfaces.

## Where to go next

- Project history: [History.md](./History.md)
- Architecture: [docs/architecture](./architecture/)
- Key decisions: [docs/decisions](./decisions/)
- Roadmap: [GitHub issues](https://github.com/footnote-ai/footnote/issues), [GitHub discussions](https://github.com/footnote-ai/footnote/discussions)
- Licensing: [LICENSE_STRATEGY.md](./LICENSE_STRATEGY.md) (MIT + HL3)
