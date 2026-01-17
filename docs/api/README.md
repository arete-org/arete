# API Spec

## Location

Canonical OpenAPI spec: `docs/api/openapi.yaml`.

## Versioning

PATCH: doc fixes or clarifications with no wire change.
MINOR: backward-compatible additions (new fields/endpoints).
MAJOR: breaking changes to paths, auth, or response/request shapes.
Update `info.version` manually when the wire contract changes.

## Reflection Endpoint

Reflection is the trimmed-down, web-facing slice of the full AI chat system, designed for
embeddable UI flows. It returns a concise response plus provenance metadata, and is protected by
Turnstile + configured rate limits.

This endpoint is served at `POST /api/reflect` with a JSON body and is separate from the Discord
bot pipeline, which uses its own context building and OpenAI orchestration.
