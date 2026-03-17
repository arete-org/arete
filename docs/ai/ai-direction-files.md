# Footnote AI Direction Files Index

_Coordinated guidance for AI assistants and developers._

## 📋 Single Source of Truth

### `cursor.rules` - **Complete Development Rules**

- Footnote principles, module tagging, scoped logger patterns, and TypeScript standards
- All other files reference this as the authoritative source

## 🤖 AI Assistant Files

- **`cursor.rules`** - Complete development rules (single source of truth)
- **`.codexrules`** - Points to cursor.rules for Codex
- **`.github/copilot-instructions.md`** - GitHub Copilot instructions
- **`docs/ai/contributing_cursor.md`** - Detailed Cursor guide
- **`cursor.dictionary`** - Project terminology
- **`.cursor/README.md`** - Cursor IDE configuration
- **`docs/decisions/2026-03-voltagent-runtime-adoption.md`** - Runtime-boundary decision for VoltAgent adoption
- **`docs/status/voltagent-reflect-runtime-status.md`** - Working status doc for the reflect runtime migration

## 🎯 Usage

**AI Assistants**: Use `.codexrules` or `copilot-instructions.md` (both point to `cursor.rules`)
**Developers**: Start with `docs/ai/contributing_cursor.md` → Reference `cursor.rules`

## 🔧 Maintenance

All rules changes go in `cursor.rules`. Update references when needed.
Keep the runtime-boundary docs in sync when the agent-runtime direction changes.
