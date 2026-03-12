# Prompt Resolution Order

This is the canonical order Footnote uses to build runtime prompt text.

1. Load shared base prompts from `packages/prompts/src/defaults.yaml`.
2. Apply optional `PROMPT_CONFIG_PATH` overrides by prompt key (full key replacement, not line-by-line merge).
3. Select the core system prompt key for the request path.
4. Resolve the active persona layer in this order:
   - If `BOT_PROFILE_PROMPT_OVERLAY` is non-empty, use it.
   - Else, if `BOT_PROFILE_PROMPT_OVERLAY_PATH` is set and readable, use that file.
   - Else, use the default Footnote persona prompt key for that surface.
5. Compose prompts by path:
   - Reflect/Discord chat paths: `core system prompt + exactly one active persona system prompt` (overlay replaces default persona when present).
   - Image/realtime/provenance paths: `core prompt + exactly one active persona layer` (overlay replaces default persona when present).
6. Interpolate prompt variables for selected keys.

## Operator Notes

- `PROMPT_CONFIG_PATH` is shared by backend and Discord bot runtimes.
- `PROMPT_CONFIG_PATH` applies before Discord profile overlay composition.
- `BOT_PROFILE_*` overlay settings are Discord bot runtime specific.
- If both `BOT_PROFILE_PROMPT_OVERLAY` and `BOT_PROFILE_PROMPT_OVERLAY_PATH` are set, inline text wins and the file path is ignored.
- All bot paths now run with one active persona layer, not stacked personas.
- Copy/paste-ready persona overlay template paths:
  - `packages/prompts/src/profile-overlays/danny.md`
  - `packages/prompts/src/profile-overlays/myuri.md`
