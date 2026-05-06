# Feature Proposal: Optional OpenHands Development Tooling

**Last Updated:** 2026-05-06

---

## Overview

This proposal recommends trying **OpenHands** as an optional development tool
for Footnote contributors and maintainers.

This is not a runtime proposal. It does not change Footnote's product
architecture, backend authority, provenance model, review semantics, or public
API boundaries.

The point is simpler than that: OpenHands may be a useful extra way to work on
the repo. We should try it in a narrow, reversible way and keep it only if it
helps produce cleaner changes with less review churn.

---

## Why This Is Worth Trying

Footnote already has a clear repo contract for AI-assisted work. `AGENTS.md` is
the canonical guidance file, and tool-specific adapters stay thin on purpose.

That gives us a good base for a controlled experiment.

We do not need OpenHands because it changes the architecture. It does not. We
do not need it as a contributor-growth campaign either. That would be the wrong
reason to do this.

The real value is practical:

- see how another coding tool handles real Footnote tasks,
- measure how often its changes survive review,
- learn where repo rules are clear or weak,
- and decide with evidence whether it is worth keeping around.

If the result is noisy diffs, shallow fixes, or extra reviewer cleanup, that is
still useful information. It tells us not to invest further.

---

## What This Is Not

This proposal is easy to misread if we do not draw the line clearly.

It is not:

- a replacement for VoltAgent,
- a change to Footnote runtime execution,
- a new public service inside Footnote,
- a signal that maintainers want low-review AI-generated contributions,
- or a commitment to support every OpenHands feature or hosting mode.

VoltAgent and OpenHands live at different layers.

VoltAgent is part of Footnote's internal runtime seam behind `packages/backend`
and `@footnote/agent-runtime`. OpenHands would sit at the repo tooling edge,
alongside other coding assistants people may choose to use while working on the
codebase.

---

## Why OpenHands Fits Better Than A Random Tool Addition

OpenHands fits the repo shape we already have.

Its current docs explicitly recommend a root `AGENTS.md` file for permanent
repository-wide guidance, and support repo-level skills through
`.agents/skills/`. That matches Footnote's existing approach closely enough
that we can try it without inventing a second policy system.

That does not make OpenHands special by itself. The important part is that it
can be introduced with low blast radius:

- keep `AGENTS.md` as the source of truth,
- add only the minimum OpenHands-specific repo files if needed,
- avoid pushing repo policy into multiple instruction systems,
- and remove the experiment cleanly if it does not help.

That matters because the project should not accumulate "AI tool support" as a
pile of half-maintained config files with overlapping rules.

---

## Current OpenHands Shape

OpenHands looks mature enough to evaluate, but its shape matters.

It supports:

- local CLI use,
- a local GUI server,
- repo-level always-on guidance through `AGENTS.md`,
- repo-level skills,
- cloud-hosted usage,
- and optional deeper enterprise deployment paths.

At the same time, its own docs still frame the normal self-hosted/local path as
single-user oriented rather than a shared multi-tenant deployment model.

That is fine for Footnote's use here. We are not evaluating OpenHands as
infrastructure to run the product. We are evaluating it as an optional
development tool for people working on the repo.

One practical caveat is worth calling out for local use: current OpenHands CLI
docs say Windows users should run it through WSL rather than native Windows.
That is not a blocker, but it should be documented plainly if we support it.

Another caveat is pricing. Current docs advertise free hosted usage of one
model for a limited time, while other cloud billing pages describe paid credits
and subscriptions. We should treat that as a moving target and not make the
proposal depend on the free tier being generous or stable.

---

## How This Fits Footnote's Boundaries

The right fit is narrow.

If we try OpenHands, it should live in contributor workflow and repo docs, not
in runtime packages or deploy defaults.

That means:

- no changes to `packages/backend` behavior just to suit OpenHands,
- no special public API surface for OpenHands,
- no shift of provenance, trace, auth, review, or cost authority away from the
  backend,
- no assumption that OpenHands becomes a required tool for contributors,
- and no project messaging that lowers review expectations for generated code.

Put plainly: OpenHands can help edit the repo. It should not shape what
Footnote is.

---

## Smallest Useful Trial

The first pass should stay small.

Reasonable scope:

1. Add a short OpenHands-specific repo note that points back to `AGENTS.md`.
2. Document a supported local setup path.
3. Document a short "when to use / when not to use" guide for this repo.
4. Keep it optional and maintainer-focused at first.

That likely means a small addition such as:

- a repo-level OpenHands note or skill file if needed,
- a short `docs/ai/openhands.md` page,
- and maybe one helper script for setup if it actually reduces friction.

It does not mean building a custom OpenHands integration layer, changing Docker
deploy defaults, or adding broad automation around it before we know it helps.

---

## How To Evaluate The Trial

The decision should be based on repo outcomes, not novelty.

Use a short pilot window and track a few things that reviewers will actually
feel:

- time from first draft to merge-ready PR,
- number of review rounds needed,
- number of rule violations against `AGENTS.md`,
- number of follow-up cleanup commits,
- regression rate on touched paths,
- and whether maintainers choose to use it again after the pilot.

Those metrics are not perfect, but they are enough to answer the real question:
did this tool make useful work easier, or did it create more cleanup?

If the answer is "more cleanup," the experiment should end.

---

## Risks And Failure Modes

A few risks are predictable.

- The repo may collect one more instruction surface that drifts from
  `AGENTS.md`.
- People may read "supported" as "endorsed for broad unsupervised use."
- Generated diffs may look plausible while quietly missing Footnote boundary
  rules.
- Local setup may be rough enough that nobody serious wants to use it.
- Cloud-hosted usage may create confusion around secrets, repo permissions, or
  cost expectations.

These are all manageable if the first pass is strict and small.

The main guardrails should be:

- `AGENTS.md` stays canonical,
- support stays optional,
- setup docs are explicit about local risk and credential handling,
- and review standards do not soften just because a different tool produced the
  diff.

---

## Recommendation

Proceed with a narrow OpenHands experiment.

Add only enough repo support to let maintainers try it under the existing
Footnote rules. Keep the trial small, measure the review burden honestly, and
remove it if it does not earn its place.

The case for OpenHands is not that it changes the product or solves some major
architectural gap. The case is that it may become a useful extra tool for repo
work, and Footnote can test that cheaply without putting runtime boundaries at
risk.

---

## References And Notes

- Footnote agent contract: `AGENTS.md`
- Footnote AI assistance guide: `docs/ai/README.md`
- VoltAgent runtime adoption:
  `docs/decisions/2026-03-voltagent-runtime-adoption.md`
- OpenHands skills and permanent context:
  https://docs.openhands.dev/openhands/usage/prompting/microagents-overview
- OpenHands quick start:
  https://docs.openhands.dev/overview/quickstart
- OpenHands CLI quick start:
  https://docs.openhands.dev/openhands/usage/cli/quick-start
- OpenHands FAQs:
  https://docs.openhands.dev/overview/faqs
- OpenHands Cloud:
  https://docs.openhands.dev/usage/cloud/openhands-cloud
- OpenHands Cloud billing/settings note:
  https://docs.openhands.dev/openhands/usage/settings/api-keys-settings

---

_Prepared for later implementation planning and community discussion within
Footnote._
