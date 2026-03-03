# Environment Parsing Standardization

**Decision:** Standardize environment parsing into package-owned configuration modules and remove routine `process.env` reads from runtime code.  
**Date:** 2026-03-03

---

## 1. Context

We currently read and parse environment variables in more than one style.

On the `backend`, some values already flow through a central config module, while others are parsed directly inside startup code, handlers, auth helpers, rate-limit helpers, storage factories, and logging setup.  
On the `discord-bot` side, there is already a strong central env module, but a smaller set of features still reaches into `process.env` directly.  
On the `web` side, client runtime config is already fairly centralized, but build-time env and package naming are not yet aligned with the same monorepo pattern.

That split causes a few practical problems:

- It is harder to see the full runtime configuration surface in one place.
- Similar values are parsed in slightly different ways depending on who needed them first.
- Invalid values can fall back differently in different modules.
- Engineers have to remember whether a setting belongs in config or whether it is still being read ad hoc.
- Refactors become riskier because env behavior is spread across the codebase.

This is a maintenance and correctness problem. We want the configuration layer to be easy to inspect/explain, and predictable for contributors.

---

## 2. Decision

Adopt a consistent rule:

**Environment variables are parsed once, near startup, inside package-owned configuration modules.**  
Normal runtime code should consume typed config objects instead of reading `process.env` directly.

The final shape will be:

- **Backend:** one main runtime config module owns `backend` env parsing.
- **Discord bot:** one main runtime config module owns `discord-bot`-wide env parsing.
- **Web:** one main runtime config module owns `web` runtime configuration, while Vite/build-time env stays in bootstrap or build config.
- **Domain-specific exceptions:** feature-local config modules are allowed when they keep a feature cohesive and avoid awkward imports. The image configuration module is the existing example of this pattern.
- **Bootstrap remains separate:** dotenv loading and similar startup bootstrapping may still happen in dedicated bootstrap code.

Package-level config should use the same naming pattern, such as `runtimeConfig`, so contributors do not have to relearn a different entrypoint in each package.

The project will keep its current **fail-open** posture for operational tuning values.  
If a non-critical env value is missing or invalid, the config layer should use a safe default and emit a clear warning once, rather than making every downstream caller rediscover the same problem.

---

## 3. Rationale

This change makes configuration easier to find, easier to explain, and easier to trust.

- Each package gets one obvious place to define env-backed behavior.
- Defaults, warnings, and parsing rules stay consistent instead of drifting across modules.
- Runtime code can focus on application behavior rather than raw env handling.

---

## 4. Alternatives Considered

- **Create one shared monorepo env module:** too centralized for packages with different lifecycles and needs.
- **Fail fast on most invalid env values:** a possible future direction, but outside the scope of this standardization pass.

---

## 5. Consequences

- Runtime modules will become simpler because they receive already-parsed values.
- Configuration behavior will become easier to test in isolation.
- Some startup and helper code will need mechanical cleanup as direct env reads are removed.
- Future env-backed features should be added to config first, not parsed ad hoc.
- Package-level config naming will become more consistent across the monorepo.

---

## 6. Implementation Notes

- The `backend`, `discord-bot`, and `web` packages should each expose one main `runtimeConfig` entrypoint for package-level runtime settings.
- The `web` package is already close to this shape. Client code should keep using typed runtime config, while Vite-specific env stays in build/bootstrap config.
- Domain-local config modules are still allowed when they make a feature boundary cleaner.
- Raw `process.env` reads should be limited to bootstrap and config modules.
- Parsing should happen once during config construction, with clear defaults and one warning for invalid non-critical values.
- This pass is about standardization first. A later pass may harden these config boundaries further with schema-based validation such as Zod, similar to patterns already used elsewhere in the project.
