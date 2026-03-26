# Runtime Boundary Cleanup Status

## Last Updated

2026-03-25

## Summary

This cleanup workstream is complete. The goal was to stabilize the runtime boundary before deeper provider and product work, and all four planned cleanup items are now done.

## Completed Work

1. **Legacy OpenAI runtime deletion**  
   The legacy text runtime path was removed so VoltAgent is now the single text-runtime path. This also removed the old export and its legacy test surface.

2. **Discord bot entrypoint split**  
   `packages/discord-bot/src/index.ts` now acts as a router. Interaction logic lives in focused modules (`selectMenuHandlers.ts`, `modalSubmitHandlers.ts`, `buttonHandlers.ts`), and button logic is further split under `packages/discord-bot/src/interactions/button/`.

3. **OpenAI SDK imports removed from Discord image error/type handling**  
   `packages/discord-bot/src/commands/image/errors.ts` and `packages/discord-bot/src/commands/image/types.ts` now use provider-neutral local shapes instead of OpenAI SDK type imports.

4. **Optional VoltOps tracing enablement**  
   VoltOps key wiring is now in place behind optional config. Tracing is enabled only when both `VOLTAGENT_PUBLIC_KEY` and `VOLTAGENT_SECRET_KEY` are present, and remains disabled otherwise.
