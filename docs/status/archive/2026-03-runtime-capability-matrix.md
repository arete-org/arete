# Runtime Capability Matrix

This is a dated capability snapshot from 2026-03-27.

Keep it as historical rollout context, not as the main current-architecture
entrypoint.

## Date

2026-03-27

## Owners

- `docs`: runtime capability matrix maintenance
- `packages/backend`: runtime behavior authority for public/trusted routes, planning, incidents, and metadata
- `packages/agent-runtime`: provider/runtime adapter behavior authority

## Purpose

Single current source of truth for runtime capabilities across provider, tool, and workflow surfaces.

## Scope

- `packages/backend`
- `packages/agent-runtime`
- `docs/status`

## Status Legend

- `Supported`: implemented and wired in current backend runtime path
- `Conditional`: implemented, but availability depends on runtime config or profile capability
- `Gap`: intentionally not implemented yet

## Capability Matrix

| Surface                                     | Route / entrypoint                                     | Runtime path                                                                                                            | Provider/tool support                                                                             | Status                                        | Code evidence                                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Chat text generation                        | `POST /api/chat`                                       | Backend planner + orchestrator + `GenerationRuntime`                                                                    | `openai` and `ollama` providers via VoltAgent runtime adapter                                     | Conditional (provider configuration required) | `packages/backend/src/server.ts`, `packages/backend/src/services/chatOrchestrator.ts`, `packages/agent-runtime/src/voltagentRuntime.ts`                    |
| Planner execution                           | backend-internal planner call                          | Planner uses same `GenerationRuntime` seam as response generation                                                       | Search intent can be produced by planner output; execution gated later by profile/tool capability | Supported                                     | `packages/backend/src/services/chatPlanner.ts`, `packages/backend/src/services/chatOrchestrator.ts`                                                        |
| Web search tool forwarding                  | chat generation request with `generation.search`       | VoltAgent provider-tool registry mapping                                                                                | `web_search` mapping exists for `openai`; no `ollama` mapping                                     | Conditional                                   | `packages/agent-runtime/src/voltagentRuntime.ts`                                                                                                           |
| Search capability policy                    | profile selection + fallback policy in orchestrator    | Search allowed only when selected/effective profile supports `canUseSearch`; otherwise reroute or drop with reason code | Profile-aware reroute/drop with metadata and telemetry                                            | Supported                                     | `packages/backend/src/services/chatOrchestrator.ts`, `packages/backend/src/config/model-profiles.defaults.yaml`                                            |
| Internal news task                          | `POST /api/internal/text` (`task: news`)               | Backend task service -> shared `GenerationRuntime` with required search intent                                          | Depends on generation runtime availability                                                        | Conditional                                   | `packages/backend/src/handlers/internalText.ts`, `packages/backend/src/services/internalText.ts`                                                           |
| Internal image description task             | `POST /api/internal/text` (`task: image_description`)  | Backend task service -> OpenAI image-description adapter                                                                | OpenAI-only path                                                                                  | Conditional (`OPENAI_API_KEY` required)       | `packages/backend/src/server.ts`, `packages/backend/src/services/internalText.ts`, `packages/backend/src/services/internalImageDescription.ts`             |
| Internal image generation task              | `POST /api/internal/image`                             | Backend image task service -> `ImageGenerationRuntime` (`openai-image`)                                                 | OpenAI image tool path; supports NDJSON partial-image streaming                                   | Conditional (`OPENAI_API_KEY` required)       | `packages/backend/src/server.ts`, `packages/backend/src/handlers/internalImage.ts`, `packages/agent-runtime/src/openAiImageRuntime.ts`                     |
| Internal voice TTS task                     | `POST /api/internal/voice/tts`                         | Backend voice task service -> `TextToSpeechRuntime` (`openai-tts`)                                                      | OpenAI TTS models/voices via contracts                                                            | Conditional (`OPENAI_API_KEY` required)       | `packages/backend/src/server.ts`, `packages/backend/src/handlers/internalVoiceTts.ts`, `packages/agent-runtime/src/openAiTtsRuntime.ts`                    |
| Internal realtime voice session             | `GET /api/internal/voice/realtime` (websocket upgrade) | Backend realtime handler -> `RealtimeVoiceRuntime` (`openai-realtime`)                                                  | OpenAI realtime websocket session with backend event mapping                                      | Conditional (`OPENAI_API_KEY` required)       | `packages/backend/src/server.ts`, `packages/backend/src/handlers/internalVoiceRealtime.ts`, `packages/agent-runtime/src/openAiRealtimeVoiceRuntime.ts`     |
| Incident reporting/review workflow          | `/api/incidents` routes                                | Backend handlers + service + sqlite incident store                                                                      | Report/list/detail/status/notes/remediation + audit events                                        | Supported                                     | `packages/backend/src/handlers/incidents.ts`, `packages/backend/src/services/incidents.ts`, `packages/backend/src/storage/incidents/`                      |
| Deterministic risk/breaker enforcement gate | chat orchestration decision boundary                   | Current evaluator runs in observe-only mode; no final breaker block/redirect gate                                       | Breaker actions from architecture target are not enforced in response gate                        | Gap                                           | `packages/backend/src/services/chatOrchestrator.ts`, `packages/backend/src/ethics-core/evaluators.ts`, `docs/architecture/risk-evaluation-and-breakers.md` |

## Known Gaps

- Final deterministic breaker authority path is not wired as the pre-response enforcement gate.
- Provider tool registry only maps `web_search` for `openai`; `ollama` has no provider tool mapping.
- Multi-step workflow execution lineage is not emitted yet (tracked TODO in response metadata assembly).

## Next Gates

1. Wire deterministic breaker action enforcement in chat orchestration before final response emission.
2. Decide provider-tool expansion plan (`ollama` mapping and any additional tools) or keep explicit no-tool posture.
3. Extend execution metadata lineage when multi-step workflows are enabled.

## Maintenance Rule

When runtime behavior changes in `packages/backend` or `packages/agent-runtime`, update this matrix in the same PR.
