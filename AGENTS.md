# Footnote Agent Contract

This is the main guidance file for AI coding agents in this repo.
Keep it short, clear, and current.

## Rule Architecture

- `AGENTS.md` is the canonical ruleset.
- Tool-specific files (for example `cursor.rules`, `.codexrules`, `.github/copilot-instructions.md`) are thin adapters.
- Adapters should only point to this file and include tool-only details when absolutely needed.

## Project Stage

Footnote is pre-1.0 and changing quickly.
Prefer fast, correct, small-scope delivery over broad compatibility planning.
Do not add migrations, backfills, or compatibility layers unless the user asks.

## What This Repo Is

Footnote is a transparency- and provenance-focused AI framework.
Main surfaces:

- `packages/backend`
- `packages/discord-bot`
- `packages/web`
- `packages/contracts`
- `packages/api-client`
- `packages/agent-runtime`
- `packages/prompts`

## Non-Negotiables

- Use `pnpm` commands.
- Use explicit TypeScript types. Avoid `any`.
- Use structured logging from `packages/discord-bot/src/utils/logger.ts`.
- Keep fail-open behavior: if uncertain, do not block execution.
- Preserve provenance comments and license headers.
- Keep `packages/backend` as the public runtime boundary for web and discord-bot.
- Keep Footnote provenance/trace/auth/incident/review semantics outside framework-specific adapters.
- Keep backend as the authority for LLM cost recording. Discord/web should display cost data already computed by backend or shared pricing helpers.
- Keep public interfaces serializable.

## Required Module Header Format

Use this exact order and include a short rationale on risk and ethics lines.

```ts
/**
 * @description: <1-3 lines>
 * @footnote-scope: <core|utility|interface|web|test>
 * @footnote-module: <ModuleName>
 * @footnote-risk: <low|medium|high> - <technical blast radius>
 * @footnote-ethics: <low|medium|high> - <human/governance impact>
 */
```

## API Boundary Rule

For API boundary changes, keep links in sync:

- code annotations: `@api.operationId` and `@api.path`
- OpenAPI refs: `x-codeRefs` in `docs/api/openapi.yaml`

## Validation Commands

After edits:

- `pnpm lint:fix`

Before final handoff:

- `pnpm lint`

Conditional (must explain if skipped):

- `pnpm validate-footnote-tags`
- `pnpm validate-openapi-links` (API boundary changes)
- `pnpm review` (required for review-ready code changes; explain if skipped)
- `docker compose -f deploy/compose.yml build` (required for startup, provider, env, deploy, or runtime packaging impact; explain if skipped)

## Working Style

- Prefer small, focused diffs.
- Edit only files needed for the task.
- If the task starts touching multiple concepts, packages, or behavior surfaces, stop, report the scope expansion, and wait for confirmation before continuing.
- Follow the user’s requested change, but preserve existing project boundaries unless the prompt explicitly asks to change them. If the prompt appears to conflict with core Footnote semantics, stop and ask before rewriting those semantics.
- Use repo code/docs as primary context; use MCP/external tools only to verify third-party APIs, UI behavior, secrets, or issue state.
- For non-trivial structural refactors, include 1-2 example evidence links using `pnpm refactor:lookup`.
- Do not invent runtime facts, command output, or test results.
- If a check was not run, say that clearly.

## Repomix Context Use

Use normal file reads for small, local edits.

Use Repomix when a task spans multiple packages, touches workflow/trace/provenance behavior, or needs architecture context before editing. Prefer the existing focused presets first, then expand only if the pack is missing needed context.

When using Repomix MCP, pack a focused slice, then use grep/read tools against that output before creating another pack. Avoid whole-repo packs unless the task is explicitly broad review or planning.

Do not paste Repomix bundle contents into chat unless asked. Review bundles before sharing them outside the project.

The `pnpm repomix:*` scripts are available for local CLI use. If your agent environment has the Repomix MCP configured, prefer MCP grep/read tools after creating a focused pack.

## Communication Style

Write for a junior contributor:

- Plain language first.
- Short sentences.
- Concrete action words.
- Add JSDoc or comments for exported boundary functions, workflow/orchestrator/provider/provenance logic, fail-open behavior, and authority decisions.
- Do not add comments that only restate obvious code.
