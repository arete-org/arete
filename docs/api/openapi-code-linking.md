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

## Spec-Side Code References

Each operation in `openapi.yaml` should include an `x-codeRefs` list with
repo-root-relative references to implementation and contract locations.

Example:

```yaml
get:
    operationId: getTrace
    x-codeRefs:
        - packages/backend/src/handlers/trace.ts#handleTraceRequest
        - packages/web/src/utils/api.ts#getTrace
        - packages/contracts/src/web/types.ts#GetTraceResponse
```

This enables navigation from spec -> code and provides input for drift checks.

## Naming Convention

For route-specific payload types, derive names from `operationId`:

- `postReflect` -> `PostReflectRequest`, `PostReflectResponse`
- `getTrace` -> `GetTraceResponse`, `GetTraceStaleResponse`
- `getRuntimeConfig` -> `GetRuntimeConfigResponse`

Shared sub-models (reused across multiple operations) can stay domain-shaped:

- `BlogAuthor`
- `BlogPostMetadata`
- `BlogPost`

## Scope

This convention is intentionally minimal for now.
Future updates may add validation and generated mapping artifacts.
