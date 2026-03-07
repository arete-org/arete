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
- **`docs/ai/deepwiki-vendoring.md`** - Vendoring/system note for DeepWiki and repo explainer tooling
- **`cursor.dictionary`** - Project terminology
- **`.cursor/README.md`** - Cursor IDE configuration

## 🎯 Usage

**AI Assistants**: Use `.codexrules` or `copilot-instructions.md` (both point to `cursor.rules`)
**Developers**: Start with `docs/ai/contributing_cursor.md` → Reference `cursor.rules`

## 🔧 Maintenance

All rules changes go in `cursor.rules`. Update references when needed.
