# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

Footnote is an AI assistant that tries to show its work — it returns trace metadata you can easily inspect.

Every response includes:

- how confident it is
- what sources it relied on
- what trade-offs it considered
- what constraints and safety checks were applied

![footnote_chat](https://github.com/user-attachments/assets/963e6144-7d83-4d90-a580-7fc5a01d3566)

Built for human oversight, rather than “just believe me.”

**Try the demo:** [https://ai.jordanmakes.dev](https://ai.jordanmakes.dev)

---

## Try it today

Footnote is a working prototype with:

- **Web demo** with a quick “ask” flow
- **Discord bot** provides seamless and rich interaction
- **Self-hosting** via Docker, or in the cloud (Fly.io)

---

## Getting Started

1. Install dependencies

```bash
pnpm install
```

> If pnpm isn't available yet, run `corepack enable` once (Node 16.10+), then `pnpm install`

2. Set environment variables

Copy `.env.example` to a new `.env`, edit:

```
DISCORD_TOKEN=...
DISCORD_CLIENT_ID=...
DISCORD_GUILD_ID=...
DISCORD_USER_ID=...
OPENAI_API_KEY=...
TRACE_API_TOKEN=...
INCIDENT_PSEUDONYMIZATION_SECRET=...
```

> This is the minimum config—See [.env.example](.env.example) for the full list.

> Current deployments still rely on an OpenAI-backed runtime for several paths—broader runtime/provider support is planned.

3. Start all services (backend/web/Discord bot)

```bash
pnpm start:all
```

## Vendoring and Multiple Discord Bots

We treat `Footnote` as the default Discord persona, which is used if you do nothing beyond the base setup.

If you want a vendored bot identity on top, configure the runtime with profile env vars:

```env
BOT_PROFILE_ID=acme-bot
BOT_PROFILE_DISPLAY_NAME=Acme Assistant
BOT_PROFILE_MENTION_ALIASES=acme,a-bot
BOT_PROFILE_PROMPT_OVERLAY=
BOT_PROFILE_PROMPT_OVERLAY_PATH=
```

If you omit these values, the runtime falls back to the default Footnote identity.

Recommended vendoring workflow:

1. Set a unique `BOT_PROFILE_ID` for the bot machine.
2. Set `BOT_PROFILE_DISPLAY_NAME` for the visible identity.
3. Add either [1] `BOT_PROFILE_PROMPT_OVERLAY` or [2] `BOT_PROFILE_PROMPT_OVERLAY_PATH` for persona-specific instructions (1 takes priority over 2).
4. Add `BOT_PROFILE_MENTION_ALIASES` when the bot should respond to vendor-specific plaintext names.

Persona overlay templates are available:

```env
BOT_PROFILE_ID=danny
BOT_PROFILE_DISPLAY_NAME=Danny
BOT_PROFILE_PROMPT_OVERLAY_PATH=packages/prompts/src/profile-overlays/danny.md
```
```env
BOT_PROFILE_ID=myuri
BOT_PROFILE_DISPLAY_NAME=Myuri
BOT_PROFILE_PROMPT_OVERLAY_PATH=packages/prompts/src/profile-overlays/myuri.md
```

Precedence rules are documented in [`prompt-resolution.md`](docs/architecture/prompt-resolution.md).

---

## Documentation

The docs are split by purpose:

- architecture: stable system design
- decisions: durable technical choices and rationale
- status: implementation progress for active work

Start here: [Documentation Map](docs/README.md)

---

## License

Footnote is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See our [license strategy](docs/LICENSE_STRATEGY.md) for details.

---

## Contributing

Contribution guidelines are still being drafted.

For now, thoughtful discussion, critique, and experimentation are welcome via Discussions and Issues on this repo.
