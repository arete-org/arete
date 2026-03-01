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
- You don’t have to rely only on prompt tweaks to get consistent results.

Steerability is broader than transparency. The point isn’t just to see what happened after the fact, but to make it easier to guide the system on purpose.

### Answers you can check

“Checkable” means you can tell what an answer is based on, and what would change it.

Depending on the question, that can include:

- sources used (or a clear note that no sources were used),
- key assumptions,
- configuration/defaults, when explicitly recorded,
- uncertainty when it’s guessing.

Links: [trace page source](../packages/web/src/pages/TracePage.tsx), [OpenAPI trace definitions](./api/openapi.yaml), [citation handling](../packages/discord-bot/src/utils/openaiService.ts)

#### Tiny example

**Not checkable:**

> “Yes, that’s true.”

**More checkable:**

> “Yes—based on the cited source (if any) and the stored trace. I’m assuming you mean the current implementation. If the deployed version or date is different, the answer changes.”

## Why build it this way

A lot of assistants fail in a predictable way: they give an answer that sounds fine, but they don’t leave you anything to follow.

When you can’t see the basis, people usually end up either:

- trusting it too much because it sounds confident, or
- treating it like a slot machine and disengaging.

Footnote is trying to make a third option feel normal: useful answers with a trail you can follow when it matters.

## Design constraints

This only works if the system is built with some constraints in mind:

- be plain about limits and uncertainty,
- avoid coercive certainty on value-laden questions,
- protect privacy and make review possible,
- surface trade-offs and let the user choose when values are involved,
- leave enough traceability that someone else can inspect what happened.

## Profiles are rulesets (not characters)

**Ari** is the current baseline configuration.

If/when a multi-profile system is shipped, a profile would be a bundle of defaults:

- enforceable constraints where possible (policy rules),
- plus style guidance for the model.

Current baseline prompt references: [discord-bot defaults](../packages/discord-bot/src/utils/prompts/defaults.yaml), [backend defaults](../packages/backend/src/services/prompts/defaults.yaml)

## What’s planned

Planned direction (subject to change as the project evolves):

- More checks and enforcement outside the model.
- Stronger “lookup required” behavior for time-sensitive queries.
- A multi-profile system with explicit profiles, clearer policy controls, and enforceable tool permissions where possible.
- Profile export/diff/sharing, if a multi-profile system becomes a shipped feature.

## How to tell if it’s working

Footnote is doing its job if you can answer:

- Why did it say this?
- What did it use?
- What did it assume?
- What configuration was active (when recorded)?
- What would I change to get a different result?

If you can’t answer those, that’s not a nice-to-have. That’s the point.

## Related work

Some projects focus on explaining predictive ML models (“why did the model predict X?”). Footnote’s focus is different: “why did the assistant say X, and what shaped that result?”

Related areas include explainable ML, provenance/audit trails, and model cards.

## Where to go next

- Project history: [History.md](./History.md)
- Architecture: [docs/architecture](./architecture/)
- Roadmap/issues: [GitHub issues](https://github.com/arete-org/arete/issues), [GitHub discussions](https://github.com/arete-org/arete/discussions)
- Licensing: [LICENSE_STRATEGY.md](./LICENSE_STRATEGY.md)
