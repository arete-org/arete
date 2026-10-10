# Local entry points. `make dev` runs the API with auto-reload and the Vite dev
# server (hot module replacement) side by side; Docker (`make docker`) is the
# always-on, nginx-served build instead. Never run both backends at once:
# DuckDB allows a single writer on data/arete.duckdb.

BACKEND_PORT  ?= 8000
FRONTEND_PORT ?= 5173
BASE          ?= origin/main

# 127.0.0.1, not localhost: uvicorn binds IPv4 only and Node may resolve
# localhost to ::1 first, which turns every proxied /api call into a 502.
# .venv/bin, not `uv run`: uv forwards SIGTERM to the reloader, which also gets
# the process group's own SIGTERM (how Conductor stops a run script), and the
# doubled signal leaves uvicorn's --reload supervisor hanging. The .venv
# prerequisite already keeps the environment synced with uv.lock.
BACKEND_CMD  = .venv/bin/uvicorn arete.api.main:app --app-dir src \
	--host 127.0.0.1 --port $(BACKEND_PORT) --reload --reload-dir src
# --strictPort: fail on a taken port instead of silently moving to another one.
FRONTEND_CMD = cd frontend && node scripts/prepare-ocr.mjs && VITE_API_TARGET=http://127.0.0.1:$(BACKEND_PORT) \
	exec ./node_modules/.bin/vite --port $(FRONTEND_PORT) --strictPort

.DEFAULT_GOAL := help
.PHONY: help install hooks dev backend frontend test lint typecheck check check-changed review-plan docker

help: ## List targets
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

install: .env .venv frontend/node_modules hooks ocr-data ## Python + npm dependencies, .env from the example

hooks: ## Use the versioned git hooks (pre-push: format + lint)
	@git config core.hooksPath .githooks

.env:
	cp .env.example .env

# Stamps: reinstall only when a lockfile changes.
.venv: pyproject.toml uv.lock
	uv sync --extra dev
	@touch .venv

frontend/node_modules: frontend/package-lock.json
	npm --prefix frontend ci
	@touch frontend/node_modules

# Both servers are children of one shell: Ctrl-C stops both, and when either
# exits (taken port, crash at import) the other is stopped too rather than
# left serving a half-dead stack. Polled once a second because macOS
# /bin/sh is bash 3.2, which has no `wait -n`.
dev: install ## API (auto-reload) + frontend (Vite HMR); Ctrl-C stops both
	@$(BACKEND_CMD) & backend=$$!; \
	( $(FRONTEND_CMD) ) & frontend=$$!; \
	trap 'kill $$backend $$frontend 2>/dev/null; wait' EXIT; \
	trap 'exit 130' INT TERM; \
	while kill -0 $$backend 2>/dev/null && kill -0 $$frontend 2>/dev/null; do sleep 1; done; \
	echo "make dev: a server exited, stopping the other" >&2; exit 1

backend: .venv ocr-data ## API only (auto-reload), /docs on BACKEND_PORT
	$(BACKEND_CMD)

frontend: frontend/node_modules ## Vite dev server only (HMR) on FRONTEND_PORT
	$(FRONTEND_CMD)

test: .venv ocr-data ## pytest
	uv run pytest tests/ --tb=short --durations=20

lint: .venv frontend/node_modules ## ruff + eslint
	uv run ruff check src tests scripts/ci
	uv run ruff format --check src tests scripts/ci
	npm --prefix frontend run lint

typecheck: .venv ## mypy
	uv run mypy src/arete

check: lint typecheck test ## Static checks, unit tests and frontend build (browser tests separate)
	uv run python -m unittest discover -s scripts/ci -p 'test_*.py'
	node --test scripts/openwiki/transport.test.mjs
	npm --prefix frontend test
	npm --prefix frontend run build

review-plan: ## Explain affected checks against BASE, including uncommitted files
	python3 scripts/ci/check_changed.py --base "$(BASE)"

check-changed: ## Run affected PR checks (dependencies must already be installed)
	python3 scripts/ci/check_changed.py --base "$(BASE)" --run

docker: .env ## Production-like stack: frontend :3080, API :8001
	docker compose up --build

.PHONY: ocr-data
ocr-data: ## Prepare checksum-verified server OCR languages
	python3 scripts/bundle_ocr_data.py
