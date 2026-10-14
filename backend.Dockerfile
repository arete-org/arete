FROM python:3.12-slim AS base

# Install uv
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

# Dependencies first (cache layer). README is needed by hatchling but must not bust the deps layer.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Project sources
COPY README.md ./
COPY src/ src/
COPY scripts/ scripts/
RUN uv sync --frozen --no-dev
# The MotherDuck extension ships in the image rather than downloading at boot
RUN /app/.venv/bin/python scripts/bundle_duckdb_extensions.py
RUN /app/.venv/bin/python scripts/bundle_ocr_data.py

# Data directory (mounted as a volume in docker-compose)
RUN mkdir -p data

EXPOSE 8000

CMD ["/app/.venv/bin/uvicorn", "arete.api.main:app", "--host", "0.0.0.0", "--port", "8000"]
