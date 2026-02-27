# OpenAPI Code Linking

This document defines the lightweight convention for linking code to the
authoritative API spec at [openapi.yaml](./openapi.yaml).

## Goal

- Keep `docs/api/openapi.yaml` as the source of truth for the wire contract.
- Make code navigation fast in IDEs and PR reviews.
- Reduce drift between route implementations, client usage, and contracts.

## Two Separate Jobs

There are two related things to keep in sync:

- OpenAPI linking (`@api.operationId`, `@api.path`, `x-codeRefs`)
- Runtime validation (Zod schemas + client/server validation hooks)

They solve different problems:

- OpenAPI linking helps you find the route in code.
- Runtime validation checks that the data actually matches the contract.

OpenAPI linking is for navigation and drift checks.
Runtime validation is for safety at the package boundary.

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

## Runtime Validation Pattern

For routes with runtime validation:

- Keep the TypeScript request/response names in `packages/contracts/src/web/types.ts`
- Put the matching Zod schemas in `packages/contracts/src/web/schemas.ts`
- Use the shared transport hook in `packages/contracts/src/web/client-core.ts`
  to validate client responses
- Validate backend request payloads before the route does its main work

Current scope:

- `POST /api/reflect`
- `POST /api/traces`
- `GET /api/traces/{responseId}`

In plain English:

- types are the names other code imports
- schemas are the runtime checkers
- transport validation protects web/bot from bad responses
- backend validation protects the server from bad requests

## Temporary Backend Schema Mirror

Right now the backend keeps a local schema mirror at:

- `packages/backend/src/contracts/webSchemas.ts`

This is temporary.

Why it exists:

- the web/bot clients can cleanly consume runtime schemas from
  `@arete/contracts/web/schemas`
- the backend's current TypeScript/module setup does not yet consume those same
  runtime schemas cleanly without widening build/config scope

What to do for now:

- keep the backend mirror aligned with `packages/contracts/src/web/schemas.ts`
- keep the shared route shapes small and explicit
- prefer updating both files in the same PR when runtime route validation changes

In other words: this is a temporary duplicate.
For now, update both files together.
Later, we should remove the duplicate and use one shared runtime schema source.

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

This convention is intentionally lightweight.
Validation is enforced by `pnpm validate-openapi-links`.
Future hardening: evaluate Spectral-based OpenAPI lint rules so baseline spec
validation is tool-driven and this custom script stays focused on repo-specific
linking checks.
