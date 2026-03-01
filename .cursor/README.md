# Footnote Cursor Configuration

This directory contains Cursor-specific configuration files for the Footnote project.

## Files Overview

- **`config.json`** - Main Cursor configuration with context mapping and prompts
- **`context-map.json`** - Import aliases and symbol resolution
- **`tasks.json`** - Available commands and tasks for development
- **`typescript.json`** - TypeScript-specific settings and preferences
- **`style.json`** - Code formatting and naming conventions
- **`patterns.json`** - Project-specific code patterns and anti-patterns
- **`snippets.json`** - Code snippets for common project patterns

## Key Features

### Risk/Ethics Tags

All modules are tagged with `@arete-risk` and `@arete-ethics` levels:

- **Critical**: Core system functionality, voice processing, AI interactions
- **High**: Important utilities, command handlers, session management
- **Medium**: News processing, trace storage, prompt management
- **Low**: Simple utilities, configuration files

### Domain Dictionary

The `cursor.dictionary` file contains project-specific terms to prevent auto-correction:

- Class names (VoiceSessionManager, AudioCaptureHandler, etc.)
- Domain concepts (Footnote, RolyBot, Daneel, etc.)
- Technical terms (RealtimeAudioHandler, ChannelContextManager, etc.)

### Code Patterns

- Structured logging with `logger.ts` and scoped loggers
- Cost tracking with `ChannelContextManager.recordLLMUsage()`
- Error handling with try/catch and informative messages
- Risk/ethics tags in module headers
- Scoped logger tagging with `@arete-logger` and `@logs`
- Async/await over promises

### Available Tasks

- `/cost-summary` - Check LLM cost summary
- `/risk-audit` - Audit risk tags for accuracy
- `/ethics-audit` - Audit ethics tags for accuracy
- `/format-code` - Format code with Prettier
- `/type-check` - Run TypeScript type checking
- `pre-review` task - Run full pre-review checks (`@arete-*` tags, OpenAPI links, types, lint)

## Usage

Cursor will automatically use these configurations when working in the Footnote project. The AI will:

- Understand Footnote's ethical framework and principles
- Maintain risk/ethics tags when making changes
- Follow established code patterns and conventions
- Use appropriate logging and error handling with scoped loggers
- Respect the domain-specific vocabulary
- Apply proper formatting standards for module and logger headers
