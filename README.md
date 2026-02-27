# ARETE

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/arete-org/arete)

**Mindful and honest AI.**  
Transparent, private, easy to run yourself — under your rules.

**Try the demo:** [https://ai.jordanmakes.dev](https://ai.jordanmakes.dev)

---

## What is ARETE?

> Assistant for Realtime Ethical Thought and Evaluation  

ARETE is an AI assistant that tries to show its work — Its responses carry trace metadata you can easily inspect, unlike other assistants which give you polished answers but hide the trail.  

Every response includes:

- how confident it is
- what sources it relied on
- what trade-offs it considered
- what constraints and safety checks were applied
- a trace artifact suitable for review or audit

ARETE is built for human oversight, rather than “just believe me.”

---

## What you can try today

ARETE is a working prototype delivering these core features:

- **Response traces** (artifacts + metadata) stored for later inspection
- **Risk tiering** and citations
- **Web demo** with a quick “ask” flow with provenance data
- **Discord bot** provides provenance as first-class while preserving usability
- **Self-hosting** via Docker (recommended for easiest setup), or to the cloud via Fly

---

## Architecture at a glance

ARETE is three small services that work together:

- **Discord bot**  
  Conversational interface in Discord (chat, images, voice)

- **Web interface**  
  Public-facing site with a quick chat demo and trace viewer.

- **Backend API**  
  Central brains: handles traces, configuration, rate limits, etc.
  OpenAI is currently the only LLM provider. A provider pipeline (cloud + local) is planned.

---

## Getting Started

### Option A: Docker (recommended)

For the minimum DIY experience, run via Docker and open the web UI.

1. Clone the repository 
  ```bash
  git clone https://github.com/arete-org/arete.git && cd arete
  ```

2. Create a config file
  ```bash
  cp .env.example .env
  ```

3. Start via Docker / Compose
  (See [deploy/](deploy/) for the current compose topology and commands)

4. Open the web UI (the default URL is typically [http://localhost:5173](http://localhost:5173))

### Option B: Local dev (pnpm)

1. Install dependencies
  ```bash
  pnpm install
  ```
  
  > If pnpm isn't available yet, run `corepack enable` once (Node 16.10+), then re-run `pnpm install`.

3. Configure environment variables

  ```bash
  cp .env.example .env
  ```
  
  At minimum:
  ```
  DISCORD_TOKEN=...
  DISCORD_CLIENT_ID=...
  DISCORD_GUILD_ID=...
  DISCORD_USER_ID=...
  OPENAI_API_KEY=...
  TRACE_API_TOKEN=...
  INCIDENT_PSEUDONYMIZATION_SECRET=...
  ```
  
  > See [.env.example](.env.example) for the full list and descriptions of optional settings.

3. Run the services
  Start the backend and web interface:
  ```bash
  pnpm start:dev
  ```
  In another terminal, start the Discord bot (optional):
  ```bash
  pnpm start:bot
  ```

---

## License

ARETE is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See our [license strategy](docs/LICENSE_STRATEGY.md) for details.

---

## Contributing

Contribution guidelines are still being drafted.

For now, thoughtful discussion, critique, and experimentation are welcome via Discussions and Issues on this repo.
