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

The `artifacts/` path is intended for generated outputs and should remain
gitignored.

## 4. Run A Starter Bundle

Before repo preset scripts are added, you can run Repomix directly against this
repo:

```bash
pnpm exec repomix . --output artifacts/repomix/local-starter.xml --style xml --compress
```

This produces one local bundle you can inspect or share after review.

## 5. Safety Review Before Sharing

Repomix security checks help, but do not replace human review. Always check
bundles for sensitive content before sharing with outside tools.

Minimum review checklist:

- no `.env` values
- no private keys or secrets
- no local data dumps
- no deployment-only confidential material

## 6. Preferred Workflow In Footnote

When project scripts are available, prefer named preset scripts over ad hoc
commands. Presets are easier to review and keep aligned with Footnote
architecture boundaries.

Expected preset intent:

- `workflow-trace`: architecture + contracts + backend/web trace anchors
- `docs-proposal`: architecture docs + active proposals + minimal code anchors

## 7. Troubleshooting

- Command not found:
    - Run `pnpm install` and retry `pnpm exec repomix --version`.
- Bundle too large/noisy:
    - tighten include paths and ignore patterns before sharing.
- Unclear boundaries:
    - start from `docs/architecture/README.md` and include only code needed to
      anchor those docs.
