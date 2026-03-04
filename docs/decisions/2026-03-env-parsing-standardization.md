# Environment Parsing Standardization

**Decision:** Standardize environment parsing into package-owned configuration modules and remove routine `process.env` reads from runtime code.  
**Date:** 2026-03-03

---

## 1. Context

We currently read and parse environment variables in more than one style.

For the `backend`, some values already flow through a central config module, while others are still parsed inside startup code, handlers, auth helpers, rate-limit helpers, storage factories, and logging setup.  
The `discord-bot` already has a strong central env module, but a smaller set of features still reaches into `process.env` directly.  
In the `web` package, client runtime config is already fairly centralized, but build-time env and package naming are not yet aligned with the same monorepo pattern.

That split causes a few practical problems:

- It is harder to see the full runtime configuration surface in one place.
- Similar values are parsed in slightly different ways depending on who needed them first.
- Invalid values can fall back differently in different modules.
- Engineers have to remember whether a setting belongs in config or whether it is still being read ad hoc.
- Refactors become riskier because env behavior is spread across the codebase.

This is a maintenance and correctness problem. We want the configuration layer to be easy to inspect/explain, and predictable for contributors.

---

## 2. Decision

Use one consistent rule:

**Read and parse environment variables once, near startup, inside package config modules.**  
Normal runtime code should use typed config values instead of reading `process.env` directly.

Package-level config should use the same name (`runtimeConfig`) so contributors see the same pattern in each package.

The project will keep its current **fail-open** posture; If a non-critical env value is missing or invalid, use a safe default and warn.

---

## 3. Rationale

Each package gets one obvious place to define env-backed behavior.  
This change makes configuration easier to find, explain, and trust.  
Runtime code can focus on application behavior rather than raw env handling.  
Defaults, warnings, and parsing rules stay consistent instead of drifting across modules.

---

## 4. Alternatives Considered

- Create one shared monorepo env module: Too centralized for packages with different lifecycles and needs.
- Fail fast on most invalid env values: A possible future direction, but outside the scope of this standardization pass.

---

## 5. Consequences

- Runtime modules will become simpler because they receive already-parsed values.
- Configuration behavior will become easier to test in isolation.
- Some startup and helper code will need mechanical cleanup as direct env reads are removed.
- Future env-backed features should be added to config first, not parsed ad hoc.
- Package-level config naming will become more consistent across the monorepo.

---

## 6. Implementation Notes

- Each package should have one main config entrypoint called `runtimeConfig`.
- `@footnote/config-spec` is the shared package for env names, defaults, and descriptions.
- Inside that package, `env-spec.ts` is the main reference file.
- At the repo level, `env-spec.source.ts` is the entrypoint used by docs and tooling.
- Each package `config.ts` file is still the place that reads raw env values and turns them into the values the app uses.
- Feature-specific config files are still fine when they make the code easier to understand. The image config is the main example.
- Startup helpers such as dotenv loading can stay separate if that keeps startup behavior easier to follow.
- The backend should still look like it has one public `config.ts`, even if the real work is split into smaller files behind it.
- The `web` package should keep browser runtime config separate from Vite/build-time env.
- Normal runtime code should not read `process.env` directly.
- Non-critical env values should be parsed once, fall back clearly, and warn once when invalid.
- `.env.example` is still manual for now. We can add generation or validation later.
- This pass is about consistency first. Stronger schema validation can come later if we want it.

Examples:

- Env spec entry: `{ key: 'PORT', kind: 'integer', defaultValue: literal(3000) }`
- Parsed runtime value: `runtimeConfig.server.port: number`
- Parsed list value: `runtimeConfig.cors.allowedOrigins: string[]`
