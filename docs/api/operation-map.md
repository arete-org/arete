# Operation Map

Source of truth:

- Spec: [openapi.yaml](./openapi.yaml)
- Convention: [openapi-code-linking.md](./openapi-code-linking.md)

This file is a quick, clickable index from operationId to key code locations.

| operationId         | path                           | code refs                                                                                                                                                                                                                             |
| ------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postReflect`       | `POST /api/reflect`            | `packages/backend/src/handlers/reflect.ts#createReflectHandler`, `packages/web/src/utils/api.ts#reflectQuestion`, `packages/contracts/src/web/types.ts#PostReflectRequest`, `packages/contracts/src/web/types.ts#PostReflectResponse` |
| `optionsReflect`    | `OPTIONS /api/reflect`         | `packages/backend/src/handlers/reflect.ts#createReflectHandler`                                                                                                                                                                       |
| `postTraces`        | `POST /api/traces`             | `packages/backend/src/handlers/trace.ts#handleTraceUpsertRequest`                                                                                                                                                                     |
| `getTrace`          | `GET /api/traces/{responseId}` | `packages/backend/src/handlers/trace.ts#handleTraceRequest`, `packages/web/src/utils/api.ts#getTrace`, `packages/contracts/src/web/types.ts#GetTraceResponse`, `packages/contracts/src/web/types.ts#GetTraceStaleResponse`            |
| `listBlogPosts`     | `GET /api/blog-posts`          | `packages/backend/src/handlers/blog.ts#handleBlogIndexRequest`, `packages/web/src/utils/api.ts#getBlogIndex`, `packages/contracts/src/web/types.ts#ListBlogPostsResponse`                                                             |
| `getBlogPost`       | `GET /api/blog-posts/{postId}` | `packages/backend/src/handlers/blog.ts#handleBlogPostRequest`, `packages/web/src/utils/api.ts#getBlogPost`, `packages/contracts/src/web/types.ts#GetBlogPostResponse`                                                                 |
| `postGitHubWebhook` | `POST /api/webhook/github`     | `packages/backend/src/handlers/webhook.ts#createWebhookHandler`                                                                                                                                                                       |
| `getRuntimeConfig`  | `GET /config.json`             | `packages/backend/src/handlers/config.ts#createRuntimeConfigHandler`, `packages/web/src/utils/api.ts#getRuntimeConfig`, `packages/contracts/src/web/types.ts#GetRuntimeConfigResponse`                                                |
