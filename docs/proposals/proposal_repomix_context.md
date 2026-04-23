# Feature Proposal: Repomix for AI Context Bundles and Maintainer Handoffs

**Last Updated:** 2026-04-23

---

## Overview

We should try **Repomix** as optional maintainer tooling for Footnote.

Footnote has important architectural detail spread across code, contracts, docs, and a moving backlog. That works fine when the person doing the work already knows the repo well. It gets much messier when we want to hand a focused slice of the repo to Codex, Claude, or another maintainer without dragging along a pile of unrelated files.

Repomix looks useful because it can package a repository into AI-friendly output with configurable includes, excludes, output formats, compression, and custom instructions.

This is a tooling proposal, not a product proposal:

- local maintainer tooling first;
- no runtime or product impact;
- no replacement for maintained docs;
- no CI or MCP workflow unless local use proves worthwhile.

---

## Why This Is Needed

A lot of Footnote work starts the same way: the code and docs we need are spread across several places, and the important boundary is usually subtle.

That shows up in a few common kinds of work:

- workflow tickets that need contracts, backend services, trace UI, and architecture docs at the same time;
- proposal work that needs current docs and a few code anchors, not a whole-repo dump;
- review work that needs changed files plus a small amount of context;
- AI-assisted work where the prompt gets weaker as soon as the context is assembled from memory instead of from the repo.

We can keep doing that by hand, but it is slow and easy to get wrong.

Repomix is worth trying because it gives us a repeatable way to package a small, task-shaped slice of the repo for investigation, review, proposal writing, and AI-assisted implementation.

---

## Footnote Context

Footnote already tries to keep a few things clear:

- backend owns execution behavior;
- contracts own shared semantics;
- architecture docs are maintained as current truth;
- old rollout notes and stale status docs should not pretend to be current architecture;
- trace and provenance are product surfaces, not random debug output.

Repomix should support that discipline, not blur it.

The boundary is simple: Repomix can package context, but it should not become a second documentation system or a source of truth.

If a maintainer wants to know how workflow works, the answer should still come from `docs/architecture/workflow.md` and the code it points to.

---

## Why Repomix Fits

Repomix fits this repo because the problem is not “we need more docs.” The problem is “we need a cleaner way to gather the right slice of the repo for a specific piece of work.”

That is a narrow job, and Repomix is built for it.

It also fits because it can stay optional. We can start with one config and a couple of scripts. If that turns out to be useful, we can add a little more around it. If it does not help, it is easy to remove.

Repomix also has built-in security checks, output filtering, and support for custom instruction text. Those are useful in a repo like Footnote, where architecture boundaries matter and packed output may be shared with AI tools.

---

## What To Avoid

Repomix should not become:

- a replacement for architecture docs,
- a required part of normal development,
- a build or runtime dependency,
- an excuse to stop writing and maintaining clear docs,
- or a giant whole-repo dump step that we run by default.

The value here is not “more packed output.” The value is sharper, smaller, repeatable context bundles for work that already needs repo-wide context.

If the bundle is broad enough that nobody can tell what matters, the tool is not helping.

---

## How This Fits Footnote

The cleanest fit is a small set of repo-local configs and scripts.

A likely first pass would be a few focused bundle targets, for example:

- a workflow and trace bundle,
- a docs and proposal bundle,
- a review bundle for changed files plus a small amount of architecture context.

A workflow bundle might include:

- `docs/architecture/workflow.md`
- `docs/architecture/response-metadata.md`
- `docs/architecture/execution-contract-authority-map.md`
- `packages/contracts/src/ethics-core/**/*`
- `packages/web/src/pages/TracePage.tsx`
- selected backend workflow/chat services
- Discord provenance surfaces when relevant

A docs or proposal bundle might include:

- current architecture docs,
- selected decision notes if they still matter,
- proposal docs under active discussion,
- a few code files that anchor the proposal to current repo reality.

A review bundle might include:

- changed files,
- a few load-bearing docs,
- a short instruction block describing the boundaries that matter for that review.

The common pattern is the same: use current architecture docs first, then the code that makes them real.

---

## Security And Privacy

We should start conservative here.

Repomix security checks are useful, but they do not remove the need for human review. We still need to decide what should never be bundled for outside tooling.

That likely means ignoring:

- `.env` files,
- local state,
- generated credentials,
- secrets,
- deployment-only material,
- anything else that would be a problem if copied into an AI context bundle.

That should be handled through repo config and explicit ignore rules, not wishful thinking.

The same rule applies to remote or CI-produced bundles: packed output is still something that should be reviewed before sharing.

---

## How To Start

Start locally. The first step should be a root config and a couple of scripts, enough to answer the question of whether this makes maintainer and AI-assisted work easier or is just one more tool nobody uses.

A reasonable first pass would be:

1. add a repo-local Repomix config;
2. create one or two focused bundle targets;
3. add a short maintainer note explaining what they are for;
4. use them in real workflow/docs/proposal work for a bit;
5. decide whether the tool is worth keeping and extending.

If that works, optional later steps might include:

- CI-generated review bundles for selected PRs,
- topic-specific bundle configs for recurring work,
- MCP-based editor integration for people who want it.

Local usefulness has to come first.

---

## What Comes Later

If Repomix proves useful, a few later steps make sense:

- PR review bundles in CI for architecture-heavy or docs-heavy changes;
- a small set of named bundle configs for recurring work such as workflow, trace/provenance, proposals, or focused review bundles;
- editor or agent integration through MCP.

None of that needs to happen immediately, and none of it should become required for ordinary coding. The tool only earns that extra process if it saves real time and reduces context mistakes.

---

## When To Stop

This becomes a bad idea if:

- the bundles are so broad that they become noisy whole-repo dumps,
- the config becomes harder to maintain than the work it saves,
- people start treating packed output as the source of truth instead of the repo,
- security review gets replaced by “the tool probably caught it,”
- CI starts producing artifacts nobody actually uses.

If that happens, the right answer is to scale it back or remove it.

The point is to reduce context assembly work without making the repo harder to understand.

---

## Proposed Direction

Try Repomix as optional maintainer tooling.

The first implementation path should be:

1. add a repo-local config;
2. create a small number of focused bundle targets;
3. document how maintainers should use them;
4. evaluate local use before adding CI or MCP workflow;
5. keep it only if it actually improves investigation, review, and proposal work.

Repomix should package context. It should not replace architecture docs, runtime behavior, or project truth.
