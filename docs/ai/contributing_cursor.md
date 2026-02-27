# AI-Assisted Development in ARETE

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
- **Risk annotations**: Preserve all ARETE module annotations (`@arete-module`, `@arete-risk`, `@arete-ethics`, `@arete-scope`, `@description`, `@impact`)
- **Licensing**: Maintain all license headers and provenance comments

## Process

- **Human review**: Mandatory before merging AI-generated code
- **Incremental changes**: Prefer small, well-scoped diffs over large refactors
- **Refactors**: Follow Refactoring.Guru discipline (`Smell -> Technique -> Steps`; keep tests green)
- **Testing**: All new functionality must include appropriate tests
- **Documentation**: Update relevant docs when adding new features
- **Validation**: Run `pnpm pre-review` before review; this includes OpenAPI
  code-link validation via `pnpm validate-openapi-links`
- **Communication style**: Prefer a junior-friendly teaching tone by default
  (plain language first, then technical detail)

## Cost Awareness

- **Session tracking**: Use `/cost-summary` command to check LLM spending
- **Budget limits**: Respect cognitive budget constraints in production
- **Transparency**: All costs are logged and auditable

## Ethics Integration

- **Risk assessment**: Modules are tagged with structured annotations separating technical risk (`@arete-risk`) from ethical sensitivity (`@arete-ethics`). See the tagging format in `cursor.rules` for details.
- **Governance**: Decision-making modules require extra scrutiny
- **Accountability**: All changes must maintain audit trails

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

### ARETE Module Tagging

- `@arete-risk`: Technical fragility (high, high, moderate, low)
- `@arete-ethics`: Human impact sensitivity (high, high, moderate, low)
- `@arete-scope`: Logical role (core, utility, interface, test)
- `@description`: 1-3 line summary of module purpose
- `@impact`: Separate Risk and Ethics impact statements

**Formatting Standards:**

```typescript
/**
 * @arete-module: <ModuleName>
 * @arete-risk: <high|high|moderate|low>
 * @arete-ethics: <high|high|moderate|low>
 * @arete-scope: <core|utility|interface|test>
 *
 * @description: <1-3 lines summarizing what this module does.>
 *
 * @impact
 * Risk: <What could break or be compromised if mishandled.>
 * Ethics: <What human or governance effect errors could cause.>
 */
```

### ARETE Scoped Logger Tagging

- `@arete-logger`: Logger module identifier (matches the child logger name)
- `@logs`: What specific operations, events, or data this logger logs
- `@impact`: Separate Risk and Ethics impact statements for logging concerns

**Formatting Standards:**

```typescript
/**
 * @arete-logger: <loggerName>
 *
 * @logs
 * <What this scoped logger tracks and logs>
 *
 * @impact
 * Risk: <Logging-specific risks if any>
 * Ethics: <Logging-specific ethical impacts if any>
 */
const <loggerName>Logger = logger.child({ module: '<loggerName>' });
```
