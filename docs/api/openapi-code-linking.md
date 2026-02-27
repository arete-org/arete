# OpenAPI Code Linking

This document defines the lightweight convention for linking code to the
authoritative API spec at [openapi.yaml](./openapi.yaml).

## Goal

- Keep `docs/api/openapi.yaml` as the source of truth for the wire contract.
- Make code navigation fast in IDEs and PR reviews.
- Reduce drift between route implementations, client usage, and contracts.

## Required Tags

Use these tags in route-related code blocks:

- `@api.operationId: <operationId from openapi.yaml>`
- `@api.path: <METHOD /path>`

Example:

```ts
/**
 * @api.operationId: getTrace
 * @api.path: GET /api/traces/{responseId}
 */
export type GetTraceResponse = ResponseMetadata;
```

## Naming Convention

For route-specific payload types, derive names from `operationId`:

- `postReflect` -> `PostReflectRequest`, `PostReflectResponse`
- `getTrace` -> `GetTraceResponse`, `GetTraceStaleResponse`
- `getRuntimeConfig` -> `GetRuntimeConfigResponse`

Shared sub-models can stay domain-shaped:

- `BlogAuthor`
- `BlogPostMetadata`
- `BlogPost`

## Scope

This convention is intentionally minimal for now.
Future updates may add validation and generated mapping artifacts.
