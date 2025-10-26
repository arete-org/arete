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
- **Testing**: All new functionality must include appropriate tests
- **Documentation**: Update relevant docs when adding new features

## Cost Awareness
- **Session tracking**: Use `/cost-summary` command to check LLM spending
- **Budget limits**: Respect cognitive budget constraints in production
- **Transparency**: All costs are logged and auditable

## Ethics Integration
- **Risk assessment**: Modules are tagged with structured annotations separating technical risk (`@arete-risk`) from ethical sensitivity (`@arete-ethics`). See the tagging format in `cursor.rules` for details.
- **Governance**: Decision-making modules require extra scrutiny
- **Accountability**: All changes must maintain audit trails

### ARETE Module Tagging
- `@arete-risk`: Technical fragility (critical, high, moderate, low)
- `@arete-ethics`: Human impact sensitivity (critical, high, moderate, low)
- `@arete-scope`: Logical role (core, utility, interface, test)
- `@description`: 1-3 line summary of module purpose
- `@impact`: Separate Risk and Ethics impact statements
