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
| [PHILOSOPHY.md](PHILOSOPHY.md)  | Founding letter and moral charter. |
| [SECURITY.md](SECURITY.md) | Security and ethical safety policy. |
| [LICENSE_STRATEGY.md](LICENSE_STRATEGY.md)  | Dual-license rationale (MIT + Hippocratic License v3). |

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
VITE_TURNSTILE_SITE_KEY=your_turnstile_site_key
```
> See `.env.example` for optional parameters (e.g. rate limitting, engagement rules)

**Required Services:**
- Discord Bot Token and Client ID
- OpenAI API Key
- Cloudflare Turnstile CAPTCHA keys (for web API security)

**Cloudflare Turnstile Setup:**
1. Navigate to the [Cloudflare Turnstile dashboard](https://dash.cloudflare.com/?to=/:account/turnstile)
2. Create a new site with **Widget Mode set to "Invisible"** for seamless UX with no visible UI
3. Copy the Site Key and Secret Key
4. Add them to your `.env` file as `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`
5. **Important**: Widget type must be "Invisible" in Cloudflare dashboard (not "Managed"). Ensure the site key includes your production domain (e.g., `ai.jordanmakes.dev`) in the allowlist. Site key and secret key must be from the same Turnstile widget configuration.

**Development Testing:**
For local development, you can use Cloudflare's test keys:
- Test site key: `1x00000000000000000000AA` (always passes)
- Test secret key: `1x0000000000000000000000000000000AA` (always passes)

⚠️ **Never use test keys in production!**

4. Run locally
(starts the ethics core, Discord bot, and web server in development mode)
```
npm run dev
```
5. Deploy to Fly.io (optional)
```
flyctl launch
flyctl secrets set TURNSTILE_SITE_KEY=your_turnstile_site_key
flyctl secrets set TURNSTILE_SECRET_KEY=your_turnstile_secret_key
flyctl deploy
```
This launches ARETE as a self-contained service in the cloud.

**Fly.io Deployment Notes:**
- The Turnstile site key is baked into the frontend build during Docker build
- The Turnstile secret key must be set as a Fly.io secret for runtime verification
- Use `flyctl secrets set` to configure sensitive environment variables

## Monorepo Structure
This repository houses all major packages:
```
packages/
  ethics-core/    → reasoning engine, provenance, circuit breakers
  discord-bot/    → conversational interface for Discord
  web/            → public landing page & explain viewer
docs/             → philosophy, governance, ethics logs, and framework specs
examples/         → demo scenarios
```

## License

Dual-licensed under MIT + Hippocratic License v3.

The HL3 clauses prohibit unethical use (violations of human rights, state violence, labor exploitation, etc.).

See [LICENSE_STRATEGY.md](LICENSE_STRATEGY.md) for details.

## Contributing

ARETE welcomes thoughtful contributions — technical, philosophical, or editorial.

Guidelines and governance structure are documented (COMING SOON) in:
- CONTRIBUTING.md — workflow and ethics review notes
- GOVERNANCE.md — decision-making processes
- CODE_OF_CONDUCT.md — expectations for dialogue and collaboration
  
For now: open a Discussion to propose ideas, or pick a good-first-task issue from the tracker.
