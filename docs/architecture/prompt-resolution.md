# Prompt Resolution Order

This is the canonical order Footnote uses to build runtime prompt text.

1. Load shared base prompts from `packages/prompts/src/defaults.yaml`.
2. Apply optional `PROMPT_CONFIG_PATH` overrides by prompt key (full key replacement, not line-by-line merge).
3. Interpolate prompt variables for the selected key.
4. For Discord runtime paths that support vendoring, apply the profile overlay (`BOT_PROFILE_PROMPT_OVERLAY` or `BOT_PROFILE_PROMPT_OVERLAY_PATH`):
   - Reflect path prepends one system overlay message.
   - Image/realtime/provenance paths append one overlay block to the prompt body.

## Operator Notes

- `PROMPT_CONFIG_PATH` is shared by backend and Discord bot runtimes.
- `BOT_PROFILE_*` overlay settings are Discord bot runtime specific and additive on top of the selected rendered prompt.
- Base Footnote safety/provenance constraints remain authoritative over conflicting overlay text.
