# Prompt Resolution Order

This is the canonical order Footnote uses to build runtime prompt text.

1. Load shared base prompts from `packages/prompts/src/defaults.yaml`.
2. Apply optional `PROMPT_CONFIG_PATH` overrides by prompt key (full key replacement, not line-by-line merge).
3. Interpolate prompt variables for the selected key.
4. For Discord runtime paths that support vendoring, resolve profile overlay input in this order:
   - If `BOT_PROFILE_PROMPT_OVERLAY` is non-empty, use it.
   - Else, if `BOT_PROFILE_PROMPT_OVERLAY_PATH` is set and readable, use that file.
   - Else, apply no profile overlay.
5. Apply the resolved profile overlay:
   - Reflect path prepends one system overlay message.
   - Image/realtime/provenance paths append one overlay block to the prompt body.

## Operator Notes

- `PROMPT_CONFIG_PATH` is shared by backend and Discord bot runtimes.
- `PROMPT_CONFIG_PATH` applies before Discord profile overlay composition.
- `BOT_PROFILE_*` overlay settings are Discord bot runtime specific and additive on top of the selected rendered prompt.
- If both `BOT_PROFILE_PROMPT_OVERLAY` and `BOT_PROFILE_PROMPT_OVERLAY_PATH` are set, inline text wins and the file path is ignored.
- Base Footnote safety/provenance constraints remain authoritative over conflicting overlay text.
- Copy/paste-ready persona overlay template paths:
  - `packages/prompts/src/profile-overlays/danny.md`
  - `packages/prompts/src/profile-overlays/myuri.md`
