# Arete — Claude coding-session guide

Read and follow [AGENTS.md](AGENTS.md), the shared repository instructions, and
[docs/architecture.md](docs/architecture.md), the implemented architecture.

The key pattern is explicit ownership and dependency direction:

```text
coaching.py → agent/factory.py → runtime + context + models + capabilities
                               + tools + hooks + backends + profiles
HTTP adapters / tools / completion steps → domain services → repositories/clients
```

The composition root supplies dependencies; the factory assembles. Runtime policy
owns permissions and limits. The context builder owns prompt ordering and request
budgets. The capability catalog declares tools and their instructions once.
Middlewares adapt hooks; services never depend on agent frameworks or HTTP routes.
Preserve journal injection, per-turn date context and optional LangSmith tracing
through these owners. Schemas live beside their owning contract. Avoid file moves that do not improve a
boundary, and do not add speculative folders or catch-all shared modules.

The current profiles are chat, daily briefing, session feedback and weekly review. Browser threads
remain authoritative. Background profiles cannot write training data; chat retains
direct writes with its toolkits preloaded. Follow-up suggestions are fixed
page-aware lists in the browser, never a model request. Preserve these behaviors
when changing assembly, prompts, tools, SSE or browser storage.

Use `make dev` locally and `make check` before handing off. The full check includes
lint, mypy, backend/frontend tests, dependency-boundary tests and a frontend build.
Normal tests mock external calls; live model evaluations use a database copy.

Never stage the whole working tree, read/commit `.env`, commit personal data, or
open the live DuckDB as a second writer. Commits and each push require explicit user
authorization. Keep the current branch name unless asked to rename it. UI copy is
French; code and commits are English. See AGENTS.md for the full workflow and
runtime constraints.

<!-- OPENWIKI:START -->

## OpenWiki

@AGENTS.md

<!-- OPENWIKI:END -->
