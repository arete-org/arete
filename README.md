# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

Footnote is an AI assistant that tries to show its work — its responses carry trace metadata you can easily inspect.  

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

> OpenAI is currently the only LLM provider—Broader model/provider support is planned.

3. Start the backend and web app

```bash
pnpm dev
```

4. Optionally, in another terminal, start the Discord bot

```bash
pnpm dev:bot
```

---

## License

Footnote is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See our [license strategy](docs/LICENSE_STRATEGY.md) for details.

---

## Contributing

Contribution guidelines are still being drafted.

For now, thoughtful discussion, critique, and experimentation are welcome via Discussions and Issues on this repo.
