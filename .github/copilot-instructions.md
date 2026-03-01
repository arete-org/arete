# Footnote Project - Copilot Instructions

This project follows strict project framework principles for ethical AI development.

## Key Rules:

- Always include the current module annotations (@arete-module, @arete-risk, @arete-ethics, @arete-scope)
- Use structured logging with scoped loggers (@arete-logger, @logs)
- Follow TypeScript best practices
- Maintain cost tracking for all LLM interactions

## Reference Files:

- `cursor.rules` - Complete development rules (authoritative source)
- `.codexrules` - Points to cursor.rules for AI assistants
- `cursor.dictionary` - Project-specific terminology
- `docs/ai/contributing_cursor.md` - Detailed Cursor configuration guide

## Critical Requirements:

1. Every module must have proper `@arete-*` annotations
2. All LLM calls must record costs via ChannelContextManager
3. Use fail-open design patterns
4. Maintain backward compatibility
5. Include comprehensive error handling

See `cursor.rules` for complete guidelines.
