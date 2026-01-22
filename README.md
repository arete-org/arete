# ARETE

> Assistant for Realtime Ethical Thought and Evaluation

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT) [![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)

**Mindful and honest AI.**  
Transparent, private, easy to run yourself — under your rules.

- **Try the demo:** [https://arete-web.fly.dev](https://arete-web.fly.dev)
- **Setup (self-host):** [https://arete-web.fly.dev/invite](https://arete-web.fly.dev/invite)
- **API spec:** [openapi.yaml](docs/api/openapi.yaml)

---

## What is ARETE?

ARETE is an AI assistant that tries to **show its work**.

Most assistants give you polished answers but hide the trail. ARETE is built around **structured provenance**: its responses carry trace metadata you can easily inspect.

For each response, ARETE aims to surface:

- what it concluded, and how confident it is
- what sources it relied on (when browsing)
- what trade-offs it considered
- what constraints and safety checks were applied
- a trace artifact suitable for review or audit

ARETE is a working prototype and runs today as a web interface and Discord bot.

---

## What you can try today

- **Web demo** with a quick “ask” flow with provenance data
- **Discord bot** with the same provenance-first output style
- **Response traces** (artifacts + metadata) stored for later inspection
- **Risk tiering** and citations
- **Self-hosting** via Docker (recommended for easiest setup), or to the cloud via Fly

OpenAI is currently the only LLM provider. A provider pipeline (cloud + local) is planned.

---

## Architecture at a glance

ARETE is three small services that work together:

- **Discord bot**  
  Conversational interface in Discord (chat, images, voice)

- **Web interface**  
  Public-facing site with a quick chat demo and trace viewer.

- **Backend API**  
  Central brains: handles traces, configuration, rate limits, etc.

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
