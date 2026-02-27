# Refactoring.Guru Playbook

Use this only for refactoring work. Keep feature work in a separate change.

## Non-negotiables

- Refactor != feature work. Do not mix behavior changes into a refactor change.
- Work in small steps. Keep tests passing and run the relevant tests after each meaningful step.
- Present refactor guidance as `Smell -> Technique -> Steps`.
- Treat patterns as optional. Use a pattern only with explicit justification versus a simpler refactor or built-in language feature.

## Required output format (for AI assistants)

- **Smell(s)**: <Refactoring.Guru smell name(s)> (and smell group if known)
- **Technique(s)**: <Refactoring.Guru technique name(s)>
- **Steps**: 2-6 small steps, each with:
  - technique name
  - intended improvement
  - verification (tests/commands to run; keep tests green)
- **Behavior change**: `none` (default) or explicitly described
- **Pattern gate**: default `no pattern`; if `yes`, justify vs a simpler refactor or language feature

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

## RAG links

- https://refactoring.guru/refactoring
- https://refactoring.guru/refactoring/how-to
- https://refactoring.guru/refactoring/catalog
- https://refactoring.guru/refactoring/smells
- https://refactoring.guru/refactoring/techniques
- https://refactoring.guru/design-patterns
- https://refactoring.guru/design-patterns/criticism
