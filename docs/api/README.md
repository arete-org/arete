# API Spec

## Location

Canonical OpenAPI spec: `docs/api/openapi.yaml`.

## Versioning

PATCH: doc fixes or clarifications with no wire change.
MINOR: backward-compatible additions (new fields/endpoints).
MAJOR: breaking changes to paths, auth, or response/request shapes.
Update `info.version` manually when the wire contract changes.

## Validation

Run `pnpm validate-openapi-links` to verify:
- spec -> code (`x-codeRefs` point to real files/symbols)
- code -> spec (`@api.operationId` tags map to real OpenAPI operationIds)

For routes with runtime validation, the current pattern is:

- compile-time types in `packages/contracts/src/web/types.ts`
- runtime schemas in `packages/contracts/src/web/schemas.ts`
- shared client response validation in `packages/contracts/src/web/client-core.ts`

For now, backend request validation for the same routes uses a temporary copy in
`packages/backend/src/contracts/webSchemas.ts`.
See `docs/api/openapi-code-linking.md` for the short maintainer note.

## Reflection Endpoint

Reflection is the trimmed-down, web-facing slice of the full AI chat system, designed for
embeddable UI flows. It returns a concise response plus provenance metadata, and is protected by
Turnstile + configured rate limits. When needed, send `X-Session-Id` and `X-Turnstile-Token`
headers. `X-Session-Id` is a client-generated session identifier that scopes rate limits; if you
omit it, the server falls back to IP-based limits.

This endpoint is served at `POST /api/reflect` with a JSON body and is separate from the Discord
bot pipeline, which uses its own context building and OpenAI orchestration.
