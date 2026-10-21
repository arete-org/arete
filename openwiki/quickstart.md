---
type: guide
title: Quickstart
DESCRIPTION: Guide new contributors through setting up the development environment and running the application, then routing them to key documentation for understanding the system architecture and components.
tags: [getting-started, setup, development, environment]
verified:
  - by: openwiki/0.7.1
    at: 2026-10-21T06:33:32.768Z
sources:
  - id: openwiki-source-5f5b95b3d6a215fa02ceb945
    resource: repo://.env.example
  - id: openwiki-source-b79fbbd921df689b4bbdc82f
    resource: repo://docker-compose.yml
  - id: openwiki-source-1047363cf615000e4c9bb694
    resource: repo://frontend/package.json
  - id: openwiki-source-012f2c78e3b1446dfc35803f
    resource: repo://Makefile
  - id: openwiki-source-05ccef8d4cf1698187f20464
    resource: repo://pyproject.toml
  - id: openwiki-source-3ea4ae9b4b98a62545a81494
    resource: repo://src/arete/api/main.py
  - id: openwiki-source-b465357f807c83adb7d1fddf
    resource: repo://src/arete/config.py
generated: { by: "openwiki/0.7.1", at: "2026-10-21T06:33:32.768Z" }
---

# Quickstart

Welcome to Arete! This guide will help you set up your development environment and run the application. After getting started, we'll route you to key documentation for understanding the system architecture and components.

## Prerequisites

Before you begin, ensure you have the following installed:

- **Python 3.12** or higher
- **Node.js** (for frontend)
- **Git**
- **Docker** (optional, for production deployment)

## Development Setup

### 1. Install Dependencies

The project uses a Makefile to manage dependencies. Run:

```bash
make install
```

This will:
- Copy `.env.example` to `.env` (you can edit this file later)
- Install Python dependencies with `uv sync --extra dev`
- Install Node.js dependencies in the frontend directory
- Prepare OCR data

### 2. Configure Environment

The application reads configuration from environment variables. Copy the example:

```bash
cp .env.example .env
```

Edit `.env` to suit your needs:

- **Database**: `ARETE_DB=data/arete.duckdb` (default) or `md:your_database` for MotherDuck
- **LLM Provider**: `LLM_PROVIDER=ollama` (options: ollama, openrouter, github)
- **Ollama URL**: `OLLAMA_BASE_URL=http://localhost:11434/v1` (if using Ollama)
- **Frontend URL**: `FRONTEND_URL=http://localhost:3080` (optional, for production)

Refer to `.env.example` for all available configuration options.

### 3. Start the Application

#### Local Development

Run the full development stack with API and frontend:

```bash
make dev
```

This starts:
- **Backend API** on port 8000 (with auto-reload)
- **Frontend** on port 5173 (with Hot Module Replacement)

Press Ctrl-C to stop both servers.

#### API Only

If you only need the API:

```bash
make backend
```

#### Frontend Only

If you only need the frontend:

```bash
make frontend
```

#### Production with Docker

For a production-like setup:

```bash
make docker
```

This builds and runs the backend and frontend in separate containers.

## Testing and Validation

After setup, run the validation suite:

```bash
make check
```

This runs:
- Linting and formatting checks (`ruff`)
- Type checking (`mypy`)
- Backend tests (`pytest`)
- Frontend tests and build

## Key Documentation

Now that you have the application running, here's how to navigate the codebase:

### System Architecture

<!-- openwiki: broken internal link [/openwiki/architecture.md] link "/openwiki/architecture.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Read [System Architecture](/openwiki/architecture.md) to understand:
- The coaching stack and component responsibilities
- How agents, profiles, and capabilities interact
- The execution model and runtime contracts
- Dependency boundaries and ownership patterns

### Configuration Management

<!-- openwiki: broken internal link [/openwiki/configuration.md] link "/openwiki/configuration.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Study [Configuration Management](/openwiki/configuration.md) to learn about:
- Environment variable structure
- Configuration validation and defaults
- Database configuration (local vs remote)
- Key configuration areas (database, backend, LLM provider)

### Coaching Runtime & Agent System

<!-- openwiki: broken internal link [/openwiki/coaching.md] link "/openwiki/coaching.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Explore [Coaching Runtime & Agent System](/openwiki/coaching.md) for:
- Agent framework overview with LangChain
- Profile definitions (chat, briefing, feedback, review)
- Capability registration and loading
- Runtime context and execution flow

### Services Layer

<!-- openwiki: broken internal link [/openwiki/services.md] link "/openwiki/services.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Examine [Services Layer](/openwiki/services.md) to understand:
- Domain services (briefing, planning, coaching, scheduling, memory)
- Service contracts and interactions
- Data persistence and lifecycle management

### Operations & Deployment

<!-- openwiki: broken internal link [/openwiki/operations.md] link "/openwiki/operations.md" is root-absolute, which no real consumer resolves against the repository root (not a coding agent reading the page, not GitHub's Markdown renderer, not a local viewer); use a path relative to this file instead. Fix the href or restore the target, then delete this comment. -->
Check [Operations & Deployment](/openwiki/operations.md) for:
- Development setup procedures
- Containerized production deployment
- Service dependencies and configurations
- Health checks and monitoring

### Additional Resources

- **Design System**: `design.md` contains UI design tokens and components
- **Multi-athlete setup**: `docs/multi-athlete.md` for setup with multiple athletes
- **Google Calendar integration**: `docs/google-calendar.md` for calendar features
- **Document imports**: `docs/document-imports.md` for import functionality

## Quick Reference Commands

| Task | Command |
|------|---------|
| Install all dependencies | `make install` |
| Run development stack | `make dev` |
| Run API only | `make backend` |
| Run frontend only | `make frontend` |
| Production deployment | `make docker` |
| Run validation suite | `make check` |
| Run linting | `make lint` |
| Run type checking | `make typecheck` |
| Run backend tests | `make test` |

## Next Steps

1. **Start development**: `make dev` to run both API and frontend
2. **Validate setup**: `make check` to ensure everything works
3. **Explore architecture**: Read the architecture documentation
4. **Understand configuration**: Review configuration management docs
5. **Learn coaching system**: Study the agent runtime and profiles

The Arete system is designed with clear ownership boundaries. Each component has a single responsibility, and the codebase follows a modular pattern that's easier to understand and maintain. Use the documentation links above to build a comprehensive mental model of how everything fits together.

Happy coding! 🎯
