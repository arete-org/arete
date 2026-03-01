# Footnote Pre-Review Checklist

Use this checklist before opening a PR to ensure your code meets the project's standards and is ready for Cursor's automated analysis.

## Automated Validation (Run First)

- [ ] **`@footnote-*` Module Tags**: `pnpm validate-footnote-tags` passes
- [ ] **OpenAPI Linking**: `pnpm validate-openapi-links` passes (for API boundary changes)
- [ ] **TypeScript**: `pnpm type-check` passes
- [ ] **Linting**: `pnpm lint-check` passes
- [ ] **Quick Check**: `pnpm pre-review` passes

## Project-Specific Requirements

### Module Documentation

- [ ] **Module Header**: Contains all required tags (`@footnote-module`, `@footnote-risk`, `@footnote-ethics`, `@footnote-scope`)
- [ ] **Risk Level**: Accurately reflects technical fragility (critical/high/moderate/low)
- [ ] **Ethics Level**: Accurately reflects human/governance impact (critical/high/moderate/low)
- [ ] **Scope**: Correctly categorized (core/utility/interface/test)
- [ ] **Description**: 1-3 lines explaining what the module does
- [ ] **Impact**: Clear explanation of risks and ethical implications

### Code Quality

- [ ] **Structured Logging**: Uses `logger.ts` for all log statements
- [ ] **Cost Tracking**: All LLM interactions use `ChannelContextManager.recordLLMUsage()`
- [ ] **Fail-Open Design**: Uncertain operations don't block execution
- [ ] **Error Handling**: Risky operations wrapped in `try/catch` with informative messages
- [ ] **TypeScript**: Explicit types everywhere, no `any` usage

### Comments & Documentation

- [ ] **Meaningful Comments**: Explain "why" and "what", not just "how"
- [ ] **Business Logic**: Complex algorithms and decisions are documented
- [ ] **Edge Cases**: Workarounds and potential gotchas are explained
- [ ] **External Dependencies**: API behaviors and context are documented
- [ ] **Technical Terms**: Parenthetical explanations provided (e.g., `technicalTerm (plainEnglish)`)

### Project Framework Compliance

- [ ] **Utility Reuse**: Existing utilities used before adding new modules
- [ ] **RAM-Only Buffers**: No persistence to disk or database
- [ ] **Serializable Interfaces**: Public interfaces can be serialized for web UI
- [ ] **Provenance**: All licensing headers and provenance comments preserved
- [ ] **Backward Compatibility**: Maintained unless explicitly breaking for versioned release

### Testing & Validation

- [ ] **Tests Added**: New functionality includes appropriate tests
- [ ] **Test Patterns**: Follows existing test utilities and patterns
- [ ] **Deterministic Tests**: External services mocked where possible
- [ ] **Risk/Ethics Audit**: `npm run ethics-check && npm run risk-check` passes

## Pre-Cursor Analysis Questions

Before using Cursor's automated review, ask yourself:

### Complexity Check

- [ ] **Single Responsibility**: Does each function do one thing well?
- [ ] **Conditional Depth**: Are nested conditions reasonable (< 3 levels)?
- [ ] **Data Flow**: Is the flow of data clear and traceable?
- [ ] **Function Size**: Are functions focused and not overly long?

### Future Compatibility

- [ ] **API Boundaries**: Would this survive a modular ethics-core refactor?
- [ ] **Scalability**: How would this scale with additional model providers?
- [ ] **Generalization**: Can this be generalized for multi-lens reasoning?
- [ ] **Integration**: Does this maintain clean separation of concerns?

### Ethical Considerations

- [ ] **Transparency**: Are all AI interactions traceable and explainable?
- [ ] **Privacy**: Is user data handled appropriately?
- [ ] **Fairness**: Are there any potential biases or unfair outcomes?
- [ ] **Accountability**: Are all decisions auditable and reversible?

## Cursor Integration Commands

After completing the checklist, use these Cursor features:

1. **Automated Analysis**: Use Cursor's Bugbot (Review PR) feature
2. **Inline Questions**: Use `Ctrl+K` to ask specific questions about complex areas
3. **Codebase Chat**: Use `Ctrl+L` for broader architectural questions
4. **Explain Changes**: Generate summaries of modifications

## Success Criteria

Your code is ready for human review when:

- ✅ All automated checks pass
- ✅ Project-specific requirements are met
- ✅ Cursor analysis shows no major issues
- ✅ Comments explain the "why" behind decisions
- ✅ Risk and ethics implications are clearly documented

## Common Issues to Avoid

- **Missing `@footnote-*` tags** - Run `pnpm validate-footnote-tags` first
- **Inadequate comments** - Focus on business logic and decisions
- **Inconsistent logging** - Use structured logger throughout
- **Missing cost tracking** - All LLM calls must be tracked
- **Overly complex functions** - Break down into smaller, focused functions
- **Inadequate error handling** - Wrap risky operations in try/catch

---

**Remember**: This checklist ensures Cursor can focus on architectural and complexity analysis while human reviewers focus on logic, ethics, and integration decisions.

