# Refactoring.Guru Playbook

Use this for structural improvement decisions.
You may use micro-refactors during regular feature work if they are behavior-preserving and scoped to touched code.

## Non-negotiables

- Refactor != feature work. Do not mix behavior changes into a refactor change.
- Work in small steps. Keep tests passing and run the relevant tests after each meaningful step.
- Present refactor guidance as `Smell -> Technique -> Steps`.
- Treat patterns as optional. Use a pattern only with explicit justification versus a simpler refactor or built-in language feature.
- For non-trivial structural changes, include 1-2 evidence links from `pnpm refactor:lookup`.

## Required output format (for AI assistants)

- **Smell(s)**: <Refactoring.Guru smell name(s)> (and smell group if known)
- **Technique(s)**: <Refactoring.Guru technique name(s)>
- **Steps**: 2-6 small steps, each with:
    - technique name
    - intended improvement
    - verification (tests/commands to run; keep tests green)
- **Behavior change**: `none` (default) or explicitly described
- **Pattern gate**: default `no pattern`; if `yes`, justify vs a simpler refactor or language feature

## Mixed-Work Rule

- During regular feature work, small cleanup refactors are allowed when they do not change behavior.
- If a refactor becomes broad or risky, split it into a separate pass.
- Always state behavior impact explicitly: `none` or a concrete behavior-change statement.

## Worked Example

- **Smell(s)**: Long Method (Bloater)
- **Technique(s)**: Extract Method
- **Steps**:
    - Extract input normalization from handler into a helper to reduce branching noise.
    - Extract response-shaping branch into a dedicated formatter helper.
    - Keep orchestration in the original function and remove duplicate local blocks.
    - Verify with existing handler tests and lint checks.
- **Behavior change**: `none`
- **Evidence**:
    - `pnpm refactor:lookup --kind technique --query \"extract method\"`
    - Use 1-2 returned links in the PR summary.

## Smell groups

### Bloaters

### OO Abusers

### Change Preventers

### Dispensables

### Couplers

## Technique groups

### Composing Methods

### Moving Features between Objects

### Organizing Data

### Simplifying Conditional Expressions

### Simplifying Method Calls

### Dealing with Generalization

## Reference links

- https://refactoring.guru/refactoring
- https://refactoring.guru/refactoring/how-to
- https://refactoring.guru/refactoring/catalog
- https://refactoring.guru/refactoring/smells
- https://refactoring.guru/refactoring/techniques
- https://refactoring.guru/design-patterns
- https://refactoring.guru/design-patterns/criticism
