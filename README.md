# Footnote

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Hippocratic License HL3-CORE](https://img.shields.io/static/v1?label=Hippocratic%20License&message=HL3-CORE&labelColor=5e2751&color=bc8c3d)](https://firstdonoharm.dev/version/3/0/core.html)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/footnote-ai/footnote)

Footnote is an AI assistant that helps you see what is behind an answer.

Ask a question and Footnote gives you a response with receipts: source links, confidence and safety notes, and a trace page for digging deeper.

You can use Footnote in the browser, or run your own copy from this repo.

<img width="761" height="344" alt="image" src="https://github.com/user-attachments/assets/706ea443-7085-41c0-a7ee-06633f196acd" />

[Demo](https://ai.jordanmakes.dev) · [Reading a response](#reading-a-response) · [Quickstart](#quickstart) · [Docs](#docs)

---

## Why Footnote

Most AI tools give you a finished answer and leave the messy part out of view: where the answer came from, what was checked, and how confident the system should really sound.

Footnote keeps more of that context attached to the response. It will not make every answer correct, and it does not pretend to. It gives you more to inspect before you decide what to do with the answer.

## Reading a response

A Footnote response can include:

- the answer
- source links
- confidence and safety notes
- tradeoffs or constraints when they matter
- a trace page with more detail about the run

The trace helps you review the answer; it does not prove the answer is right. For the technical model, see [Response Metadata](docs/architecture/response-metadata.md).

## Quickstart

This starts the local backend and web app.

1. Run local setup:

```bash
pnpm setup
```

> If `pnpm` is not available yet, run `corepack enable` once, then run `pnpm setup`.

`pnpm setup` will:

- create `.env` from `.env.example` when missing
- generate local development secrets when missing
- install dependencies

The generated local secrets include `INCIDENT_PSEUDONYMIZATION_SECRET` and `TRACE_API_TOKEN`.

To enable generation features, configure at least one provider:

```env
# Option A: OpenAI-backed providers
OPENAI_API_KEY=...

# Option B: Ollama-backed text runtime
OLLAMA_LOCAL_INFERENCE_ENABLED=true
OLLAMA_BASE_URL=http://localhost:11434
```

2. Start backend and web:

```bash
pnpm dev
```

3. Open the web app:

`http://localhost:8080`

### More setup options

- [Deployment guide](deploy/README.md)
- [Prompt/profile configuration](docs/architecture/prompt-resolution.md)
- [Documentation](docs/README.md)

## License

Footnote is dual-licensed under MIT and the Hippocratic License v3 (HL3-CORE).

See [license strategy](docs/LICENSE_STRATEGY.md) for details.
