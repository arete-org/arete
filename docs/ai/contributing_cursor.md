# AI-Assisted Development in Footnote

Cursor and Traycer are configured to follow the project's ethical and technical principles.

## Philosophy

- **Interpretability**: All AI interactions must be traceable and explainable
- **Traceability**: Every decision and cost must be logged with structured data
- **Fail-open behavior**: When uncertain, do not block execution

## Configuration

- **Context mapping**: See `.cursor/config.json` for context mapping and priority settings
- **Development standards**: See `cursor.rules` for coding guidelines
- **Domain vocabulary**: See `cursor.dictionary` for project-specific terms
- **Symbol resolution**: See `.cursor/context-map.json` for import aliases

## Safety Requirements

- **Structured logging**: All AI edits must preserve existing logging patterns
- **Cost tracking**: Never remove `ChannelContextManager.recordLLMUsage()` calls
- **Risk annotations**: Preserve the required module annotations (`@description`, `@footnote-scope`, `@footnote-module`, `@footnote-risk`, `@footnote-ethics`)
- **Licensing**: Maintain all license headers and provenance comments

## Process

- **Human review**: Mandatory before merging AI-generated code
- **Incremental changes**: Prefer small, well-scoped diffs over large refactors
- **Refactors**: Follow Refactoring.Guru discipline (`Smell -> Technique -> Steps`; keep tests green)
- **Testing**: All new functionality must include appropriate tests
- **Documentation**: Update relevant docs when adding new features
- **Validation**: Run `pnpm review` before review; this includes OpenAPI
  code-link validation via `pnpm validate-openapi-links`
- **Communication style**: Prefer a junior-friendly teaching tone by default
  (plain language first, then technical detail)

## Commenting And JSDoc

- **Bias toward more explanation**: AI assistants should slightly over-index on useful comments rather than leaving non-obvious logic undocumented.
- **Quality over quota**: Prefer high-quality comments and JSDoc over numeric coverage targets. Avoid adding repetitive or low-signal documentation just to hit a percentage.
- **JSDoc bias**: Use more JSDoc than default AI output, especially on exported functions, exported types/interfaces, and substantive modules, within reason.
- **Prioritize architectural seams**: Prefer JSDoc on public APIs, runtime boundaries, provenance/trace code, policy logic, and other exported symbols where readers benefit from hover documentation and intent.
- **Junior-friendly wording**: Prefer plain language over compressed technical shorthand when the longer wording better explains intent, trigger, and consequence.
- **Stay selective**: Do not force JSDoc onto tiny, obvious local helpers or trivial data containers whose names already explain the behavior.

## Runtime Boundary Rules

- **Backend stays public**: Keep `packages/backend` as the only public runtime entrypoint for `web` and `discord-bot` unless a decision doc explicitly says otherwise.
- **Framework code stays isolated**: Put framework-specific runtime integrations (for example VoltAgent) behind an internal package or boundary instead of spreading them through backend handlers.
- **Product semantics stay Footnote-owned**: Provenance, trace, auth, incident, and review semantics should stay outside framework-specific adapters.
- **Contracts stay stable**: Avoid leaking framework-native types into Footnote's public contracts when Footnote-owned interfaces already exist.

## Cost Awareness

- **Session tracking**: Use `/cost-summary` command to check LLM spending
- **Budget limits**: Respect cognitive budget constraints in production
- **Transparency**: All costs are logged and auditable

## Ethics Integration

- **Risk assessment**: Modules are tagged with structured annotations separating technical risk (`@footnote-risk`) from ethical sensitivity (`@footnote-ethics`). See the tagging format in `cursor.rules` for details.
- **Governance**: Decision-making modules require extra scrutiny
- **Accountability**: All changes must maintain audit trails

### Current runtime-boundary context

- The runtime-boundary direction is documented in `docs/decisions/2026-03-voltagent-runtime-adoption.md`.
- Active implementation staging for that work lives in `docs/status/voltagent-reflect-runtime-status.md`.

### API Linking

For API boundary changes, keep OpenAPI and code links aligned:

- `@api.operationId` and `@api.path` in route/client/contract code
- `x-codeRefs` for each operation in `docs/api/openapi.yaml`

## CodeRabbit CLI

- CodeRabbit is available in the terminal for review support.
- Run `cr -h` to inspect available commands.
- Prefer prompt-only mode for shareable review text:
    - `coderabbit --prompt-only -t uncommitted`
- Limit CodeRabbit to 3 runs max per set of changes.

### Current `@footnote-*` Module Tagging

- `@footnote-risk`: Technical blast radius (low, medium, high)
- `@footnote-ethics`: User-facing or governance harm (low, medium, high)
- `@footnote-scope`: Logical role (`core`, `utility`, `interface`, `web`, `test`)
- `@description`: 1-3 line summary of module purpose

**Required module header format:**

```typescript
/**
 * @description: <1-3 lines summarizing what this module does.>
 * @footnote-scope: <core|utility|interface|web|test>
 * @footnote-module: <ModuleName>
 * @footnote-risk: <low|medium|high> - <What could break or be compromised if mishandled.>
 * @footnote-ethics: <low|medium|high> - <What human or governance effect errors could cause.>
 */
```

### Current `@footnote-*` Scoped Logger Tagging

- `@footnote-logger`: Logger module identifier (matches the child logger name)
- `@logs`: What specific operations, events, or data this logger logs
- `@footnote-risk`: Technical blast radius if logging is missing, noisy, misleading, or leaks data
- `@footnote-ethics`: User-facing or governance harm if logging behavior weakens privacy, transparency, or accountability

Logger annotations are documentation conventions for scoped loggers (not currently enforced by validation).

**Scoped logger documentation format:**

```typescript
/**
 * @footnote-logger: <loggerName>
 * @logs: <What this scoped logger tracks and logs.>
 * @footnote-risk: <low|medium|high> - <What could go wrong if this logger is noisy, missing, or leaks data.>
 * @footnote-ethics: <low|medium|high> - <What privacy, transparency, or governance harm poor logging could cause.>
 */
const <loggerName>Logger = logger.child({ module: '<loggerName>' });
```

**Rubric reminders:**

- Use `@footnote-risk` for technical blast radius if the module fails or is misused.
- Use `@footnote-ethics` for user-facing or governance harm if the module behaves incorrectly.
- `low`: e.g. localized helper or presentation issues
- `medium`: e.g. feature-level disruption, hidden metadata, or misleading UI
- `high`: e.g. core flow failure, provenance loss, privacy harm, or major trust damage
