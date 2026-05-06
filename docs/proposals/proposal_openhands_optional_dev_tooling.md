# Feature Proposal: Optional OpenHands Development Tooling

**Last Updated:** 2026-05-06

---

## Overview

Footnote may be worth trying with OpenHands as an optional development tool.

This is a repo workflow question, not a runtime question.

The product already has its main boundaries:

- `packages/backend` is the public control-plane boundary
- `@footnote/agent-runtime` is the replaceable runtime seam
- provenance, trace, review, auth, and cost semantics stay Footnote-owned

OpenHands does not compete with that. It would sit in the same general space as
other coding assistants people might use while working on the repo.

The proposal is simple:

- support OpenHands in a small, explicit way
- try it on real Footnote tasks
- keep it only if it makes review easier rather than harder

---

## Why Try It

The main reason is not architecture. The architecture is already fine without
it.

The reason to try OpenHands is that it gives us another way to work on real
repo tasks and compare the result against the standards we already have.

That comparison is useful for a few reasons.

First, it tells us whether the current repo guidance actually travels well
across tools. `AGENTS.md` is supposed to be the source of truth. A second tool
is a good way to find out whether that claim holds up in practice or whether
the current setup quietly depends on one tool's habits.

Second, it gives maintainers a better feel for review cost. A tool can look
impressive in a demo and still produce changes that are annoying to merge. The
real question is not "can it edit files?" The real question is whether its
changes survive review without dragging reviewers through cleanup.

Third, a failed trial is still useful. If OpenHands produces noisy diffs,
misses project boundaries, or encourages sloppy repo habits, that is worth
learning early and cheaply.

---

## Footnote Context

Footnote already has a clean rule structure for AI-assisted work.

`AGENTS.md` is the canonical contract. The other tool-facing files are thin
adapters. That is one of the better parts of the current setup. It keeps repo
policy in one place and makes it easier to change later.

OpenHands fits that structure well enough to test.

Its current docs support a root `AGENTS.md` file for persistent repo guidance
and also support repo-level skills. That means we would not need to invent a
second policy system just to try it.

That matters because "supporting another tool" is only a good idea if the repo
does not end up with three half-maintained rule layers all saying slightly
different things.

---

## Where It Fits

The clean fit is at the repo edge.

OpenHands should help people work on Footnote. It should not become part of how
Footnote itself runs.

That means no runtime package changes just to satisfy OpenHands, no new product
surface for it, and no movement of authority away from backend code.

It also means we should be careful about the social framing. This should not be
presented as an open invitation for low-review generated patches. If we support
OpenHands at all, it should be in the same spirit as the rest of the repo's AI
guidance: useful when used carefully, not an excuse to lower standards.

This is also why OpenHands is different from VoltAgent.

VoltAgent is part of the product's internal execution layer. OpenHands would be
part of contributor workflow. They use similar language, but they do different
jobs.

---

## Current Shape Of OpenHands

OpenHands looks mature enough to evaluate.

It supports local use, a local GUI server, cloud-hosted use, repo-level
guidance, and repo-level skills. That is enough for a real trial.

Its limits matter too.

The current docs still treat ordinary local or self-hosted use as basically
single-user oriented. That is fine here because Footnote does not need a shared
OpenHands service. We would be trying it as a developer tool, not as project
infrastructure.

There are also a couple of practical caveats worth stating plainly.

The CLI docs currently tell Windows users to run through WSL. If we document
OpenHands support, that detail should be near the top rather than hidden in a
setup footnote.

Pricing is also not stable enough to build a case around. Some current docs
advertise free hosted usage of one model for a limited time, while other pages
describe paid credits and subscriptions. That makes the free tier a nice extra
if it exists, not a reason to adopt the tool.

---

## Small First Step

The first version should stay boring.

If we try this, the initial repo support should probably be:

1. a small OpenHands-specific repo note that points back to `AGENTS.md`
2. a short setup page under `docs/ai/`
3. a short note on when it is a good fit and when it is not

That is enough to learn something real.

It is not a reason to add new deploy defaults, build a custom integration
layer, or spread OpenHands-specific config across the repo before anyone has
shown that it helps.

---

## How To Judge It

The right measure is review quality.

If OpenHands is useful, maintainers should feel it in a few concrete places:

- faster path from first draft to merge-ready change
- fewer cleanup commits after review
- fewer missed boundary rules
- fewer "looks fine until you read closely" diffs
- enough repeat use that maintainers choose it again

If none of that shows up, the trial did its job anyway. It told us the tool is
not earning its place.

That is the standard this should be held to. Not novelty. Not model branding.
Not whether it can produce a nice-looking demo diff.

---

## Risks

The main risks are predictable.

The repo could pick up another instruction surface that drifts from
`AGENTS.md`. People could read "supported" as "blessed for broad use." Reviewers
could end up spending time cleaning up plausible but shallow changes. Cloud use
could blur lines around secrets, repo access, or cost.

Those are manageable if the trial stays narrow.

The guardrails are straightforward:

- keep `AGENTS.md` canonical
- keep support optional
- document credential and local setup expectations clearly
- keep normal review standards exactly where they are

---

## Recommendation

Try OpenHands as a small maintainer-focused experiment.

Keep the support light. Keep the scope at the repo edge. Judge it by review
cost and merge quality. Remove it if it creates more cleanup than value.

That is enough reason to write the experiment down and run it. It does not need
to be more ambitious than that.

---

## References And Notes

- Footnote agent contract: `AGENTS.md`
- Footnote AI assistance guide: `docs/ai/README.md`
- VoltAgent runtime adoption:
  `docs/decisions/2026-03-voltagent-runtime-adoption.md`
- OpenHands microagents overview:
  https://docs.openhands.dev/openhands/usage/prompting/microagents-overview
- OpenHands quick start:
  https://docs.openhands.dev/overview/quickstart
- OpenHands CLI quick start:
  https://docs.openhands.dev/openhands/usage/cli/quick-start
- OpenHands FAQs:
  https://docs.openhands.dev/overview/faqs
- OpenHands Cloud:
  https://docs.openhands.dev/usage/cloud/openhands-cloud
- OpenHands API key settings:
  https://docs.openhands.dev/openhands/usage/settings/api-keys-settings

---

_Prepared for later implementation planning and community discussion within
Footnote._
