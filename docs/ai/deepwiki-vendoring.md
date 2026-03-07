# DeepWiki Note: Discord Bot Vendoring

This note exists so DeepWiki and other repo readers can describe the current multi-bot model accurately.

## Core model

- `Footnote` is the default persona and baseline behavior.
- Vendored Discord bots are created by adding per-runtime profile configuration on top of that baseline.
- Multiple Discord bot machines can share the same backend.
- Persona customization is local to the bot runtime. It is not a backend schema change.

## Current operator flow

To run a vendored bot:

1. Start from the normal Footnote setup in the root `README.md`.
2. Configure a bot-specific profile:
   - `BOT_PROFILE_ID`
   - `BOT_PROFILE_DISPLAY_NAME`
   - `BOT_PROFILE_PROMPT_OVERLAY` or `BOT_PROFILE_PROMPT_OVERLAY_PATH`
   - `BOT_PROFILE_MENTION_ALIASES` when plaintext vendor-name engagement is needed
3. Point that bot runtime at the same backend as other bot machines.
4. Run each bot with its own env file or deployment-specific secret set.

## Important behavior

- Overlay precedence is inline text over file-path text.
- Invalid or missing overlay config fails open to base Footnote behavior.
- Profile overlays must never leak into logs as raw text.
- Mention aliases are profile-scoped configuration, not a global shared bot-name list.

## Terminology

- `base persona`: the default Footnote identity and behavior constraints
- `vendor overlay`: optional per-bot identity and prompt instructions
- `profile mention aliases`: plaintext names that should count as addressing that specific bot runtime

## What not to say

- Do not describe `Ari` as the default Footnote bot identity.
- Do not describe vendoring as a backend fork or backend-specific persona mode.
- Do not imply that one bot machine's overlay affects another bot machine.
