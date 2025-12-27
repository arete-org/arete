# ARETE
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
> Assistant for Realtime Ethical Thought and Evaluation

An ethics-first, transparent reasoning assistant — built to be self-hosted by anyone.

## Overview
ARETE is a transparent reasoning assistant for open reasoning and ethical reflection.
It helps make reasoning traceable, decisions explainable, and reflection part of the process rather than an afterthought.

Instead of chasing speed or persuasion like other AI systems, ARETE values clarity. You can view exactly how each response is formed—sources, confidence, trade-offs, and ethical constraints—so you can see not just *what* it thinks, but *why*.

## Key Principles
- Ethics-first design — Every feature should help people think more clearly about what matters.
- Transparency & provenance — Reasoning is transparent; traces its chain of thought and source.
- Humility and pluralism — Expresses uncertainty and welcomes alternate perspectives.
- Auditability — Decisions are logged and explainable, not ephemeral.
- Responsiveness — Transparency must invite reflection and correction, not just observation.
- Human oversight — ARETE can guide reflection, but never replace it.
- Open and self-hostable — Anyone can inspect, modify, and run their own instance.

## Documentation

| Document  | Description |
| ------------- | ------------- |
| [PHILOSOPHY.md](docs/PHILOSOPHY.md)  | Founding letter and moral charter. |
| [SECURITY.md](docs/SECURITY.md) | Security and ethical safety policy. |
| [LICENSE_STRATEGY.md](docs/LICENSE_STRATEGY.md) | Dual-license rationale. |

## Quickstart
You can deploy ARETE locally or on Fly.io (either path uses the same environment configuration).
1. Clone the repository
```
git clone https://github.com/arete-org/arete.git
cd arete
```
2. Install dependencies
```
npm install
```
3. Configure environment
```
DISCORD_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
OPENAI_API_KEY=your_openai_api_key
TURNSTILE_SITE_KEY=your_turnstile_site_key
TURNSTILE_SECRET_KEY=your_turnstile_secret_key
GITHUB_WEBHOOK_SECRET=your_github_webhook_secret
```
> See `.env.example` for optional parameters (e.g. rate limitting, engagement rules)

**Required Services:**
- Discord Bot Token and Client ID
- OpenAI API Key

**Optional Services:**
- Cloudflare Turnstile CAPTCHA keys (for web API abuse protection; requires both site + secret keys)
- GitHub webhook secret (for blog sync via GitHub Discussions)

**Cloudflare Turnstile Setup:**
1. Navigate to the [Cloudflare Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
2. Create a new site with **Widget Mode set to "Invisible"** for seamless UX with no visible UI
3. Copy the Site Key and Secret Key
4. Add them to your `.env` file as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
   - The site key is served to the web app at runtime via `/config.json`
   - If either key is omitted, CAPTCHA checks are skipped (fail-open)
5. **Important**: Widget type must be "Invisible" in Cloudflare dashboard (not "Managed"). Ensure the site key includes your production domain (e.g., `ai.jordanmakes.dev`) in the allowlist. Site key and secret key must be from the same Turnstile widget configuration.

**Development Testing:**
For local development, you can use Cloudflare's test keys:
- Test site key: `1x00000000000000000000AA` (always passes)
- Test secret key: `1x0000000000000000000000000000000AA` (always passes)

⚠️ **Never use test keys in production!**

4. Run locally
(starts the backend, Discord bot, and web server in development mode)
```
npm run dev
```
5. Deploy to Fly.io (optional)
See `deploy/README.md` for the multi-service Fly setup.

**Fly.io Deployment Notes:**
- The Turnstile site key is served at runtime via `/config.json` (no build-time env required)
- If CAPTCHA is enabled, set `TURNSTILE_SECRET_KEY` as a Fly secret for runtime verification
- Use `fly secrets set` to configure sensitive environment variables

**Provenance Storage:**
ARETE persists response traces for transparency and auditability. By default, traces are stored in a SQLite database:
```bash
PROVENANCE_SQLITE_PATH=/data/provenance.db
```

On Fly.io, `/data` is backed by a persistent volume defined in `deploy/fly.backend.toml`. For bare-metal deployments, ensure the path points to a persistent location.

**Persistent Storage:**
- ARETE uses a SQLite database at `/data/provenance.db` for trace storage
- The Fly.io volume `provenance_data` is mounted at `/data` (see `deploy/fly.backend.toml`)
- Traces persist across redeploys and container restarts
- To inspect the database: `flyctl ssh console` then `sqlite3 /data/provenance.db`

## Monorepo Structure
This repository houses all major packages:
```
packages/
  backend/        -> API server + ethics core + shared utilities
  discord-bot/    -> conversational interface for Discord
  web/            -> public landing page & explain viewer
docs/             -> philosophy, governance, ethics logs, and framework specs
examples/         -> demo scenarios
```

## License

Dual-licensed under MIT + Hippocratic License v3.

The HL3 clauses prohibit unethical use (violations of human rights, state violence, labor exploitation, etc.).

See [LICENSE_STRATEGY.md](docs/LICENSE_STRATEGY.md) for details.

## Contributing

We welcome thoughtful contributions of all kinds. 
Guidelines and governance structure are documented (COMING SOON) in:
- CONTRIBUTING.md — workflow and ethics review notes
- GOVERNANCE.md — decision-making processes
- CODE_OF_CONDUCT.md — expectations for dialogue and collaboration
  
For now: open a Discussion to propose ideas, or pick a good-first-task issue from the tracker.


