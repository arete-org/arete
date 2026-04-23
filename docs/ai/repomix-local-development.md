# Repomix Local Development Setup

Use this guide to set up and run Repomix locally for maintainers who need
focused AI context bundles.

This is optional tooling. It does not change runtime behavior for Footnote.

## 1. Install

From repo root:

```bash
pnpm add -D repomix
```

If dependencies are already installed and `repomix` is already in
`devDependencies`, skip this step.

## 2. Verify CLI

```bash
pnpm exec repomix --version
```

## 3. Create Local Outputs Directory

Use one local output root for generated bundles:

```bash
mkdir -p artifacts/repomix
```

The `artifacts/repomix/` path is intended for generated outputs and should
remain gitignored via the `.gitignore` `artifacts/repomix/` rule.

## 4. Run Project Presets

Use the repo presets for stable, reviewable bundles:

```bash
pnpm repomix:workflow-trace
pnpm repomix:docs-proposal
```

Or run both:

```bash
pnpm repomix:all
```

Generated outputs:

- `artifacts/repomix/workflow-trace/repomix-workflow-trace.xml`
- `artifacts/repomix/docs-proposal/repomix-docs-proposal.xml`

## 5. Safety Review Before Sharing

Repomix security checks help, but do not replace human review. Always check
bundles for sensitive content before sharing with outside tools.

Minimum review checklist:

- no `.env` values
- no private keys or secrets
- no local data dumps
- no deployment-only confidential material

## 6. Ad Hoc Bundles (Optional)

If you need a one-off bundle outside preset scope, run Repomix directly:

```bash
pnpm exec repomix . --include "docs/architecture/**/*.md,packages/backend/src/services/workflow*.ts,packages/backend/src/http/traceRoutes.ts" --ignore "docs/status/archive/**" --output artifacts/repomix/local-starter.xml --style xml --compress
```

Prefer presets first. They are easier to review and keep aligned with Footnote
architecture boundaries.

Preset intent:

- `workflow-trace`: architecture + contracts + backend/web trace anchors
- `docs-proposal`: architecture docs + active proposals + minimal code anchors

Important:

These presets are intentionally narrow starter bundles. They are not
authoritative slices of the full system. Expand include paths for task-specific
work when needed, but keep bundles focused and reviewable.

## 7. Troubleshooting

- Command not found:
    - Run `pnpm install` and retry `pnpm exec repomix --version`.
- Bundle too large/noisy:
    - tighten include paths and ignore patterns before sharing.
- Unclear boundaries:
    - start from `docs/architecture/README.md` and include only code needed to
      anchor those docs.
