# Footnote-Specific Cursor Prompts

This file contains reusable prompts for Cursor's inline chat (`Ctrl+K`) and codebase chat (`Ctrl+L`) that are specifically tailored to Footnote's architecture, ethics framework, and development standards.

## Module Analysis Prompts

### `@arete-*` Tagging Compliance

```
Check this function/module for `@arete-*` module tagging compliance. Does it have:
- @arete-module tag with descriptive name
- @arete-risk level (critical/high/moderate/low)
- @arete-ethics level (critical/high/moderate/low)
- @arete-scope (core/utility/interface/test)
- @description explaining what it does
- @impact explaining risks and ethical implications
```

### Risk Assessment

```
Analyze the risk level for this module. Consider:
- Technical fragility (stability, security, data integrity)
- Potential for system-wide impact if this fails
- Complexity and maintainability concerns
- External dependencies and failure modes
```

### Ethics Assessment

```
Analyze the ethical implications of this module. Consider:
- Privacy and data handling implications
- Potential for bias or unfair outcomes
- Transparency and explainability requirements
- Social harm or governance impacts
```

## Code Quality Prompts

### Complexity Analysis

```
Analyze this function for complexity issues:
- Does it do too many things? Should it be broken down?
- Are there deep nested conditionals that could be simplified?
- Is the data flow clear and traceable?
- Would a new contributor understand this logic?
```

### Comment Quality

```
Review the comments in this code. Do they:
- Explain the "why" and "what" rather than just "how"?
- Document business logic and important decisions?
- Explain edge cases and potential gotchas?
- Provide context for external dependencies?
- Use parenthetical explanations for technical terms?
```

### Project Framework Compliance

```
Check this code for project framework compliance:
- Does it use the structured logger (utils/logger.ts)?
- Are all LLM interactions tracked with ChannelContextManager.recordLLMUsage()?
- Does it follow fail-open design (don't block when uncertain)?
- Are all buffers RAM-only (no persistence)?
- Are public interfaces serializable for web UI?
```

## Architecture & Design Prompts

### Future Compatibility

```
Analyze this code for future compatibility:
- Would this API boundary survive a modular ethics-core refactor?
- Can this function be generalized for multi-lens reasoning?
- How would this scale with additional model providers?
- Does this maintain clean separation of concerns?
- Would this work with different AI model backends?
```

### Integration Analysis

```
Review this code for integration concerns:
- Does it maintain backward compatibility?
- Are there any breaking changes that need versioning?
- Does it properly handle errors and edge cases?
- Is the interface clean and well-defined?
- Would this integrate well with the web UI components?
```

### Performance & Scalability

```
Analyze this code for performance and scalability:
- Are there any obvious performance bottlenecks?
- Does it handle concurrent operations safely?
- Are there memory leaks or resource management issues?
- Would this scale with increased load?
- Are expensive operations properly cached or optimized?
```

## Testing & Validation Prompts

### Test Coverage

```
Review the test coverage for this module:
- Are all new functions tested?
- Do tests cover edge cases and error conditions?
- Are external services properly mocked?
- Are tests deterministic and reliable?
- Do tests follow existing patterns in the codebase?
```

### Validation Scripts

```
Check if this code needs updates to validation scripts:
- Should validate-arete-tags.js catch any issues here?
- Are there new patterns that need automated checking?
- Should this trigger any CI/CD validation steps?
- Are there any manual checks that could be automated?
```

## Ethics & Safety Prompts

### Ethical Safety Review

```
Perform an ethical safety review of this code:
- Are there any potential privacy violations?
- Could this code be misused or cause harm?
- Are all AI interactions properly logged and auditable?
- Does this maintain user agency and control?
- Are there any bias or fairness concerns?
```

### Transparency & Auditability

```
Check this code for transparency and auditability:
- Are all decisions logged with structured data?
- Is the reasoning behind choices documented?
- Can the system's behavior be explained to users?
- Are there audit trails for important operations?
- Is the code readable and well-documented?
```

## Project-Specific Components

### Discord Bot Analysis

```
Analyze this Discord bot code for:
- Proper rate limiting and abuse prevention
- Message handling and response patterns
- Voice channel integration safety
- User privacy and data protection
- Error handling and graceful degradation
```

### Web UI Analysis

```
Review this web UI code for:
- User experience and accessibility
- Security considerations (XSS, CSRF, etc.)
- Performance and loading optimization
- Responsive design and mobile compatibility
- Integration with the ethics core
```

### Ethics Core Analysis

```
Analyze this ethics core code for:
- Reasoning transparency and explainability
- Cost tracking and budget management
- Model provider abstraction
- Risk assessment accuracy
- Integration with external ethics frameworks
```

## Quick Reference Commands

### For Inline Chat (`Ctrl+K`)

- "Check `@arete-*` tagging compliance"
- "Analyze complexity and suggest simplifications"
- "Review comments for quality and completeness"
- "Check fail-open design compliance"
- "Verify cost tracking implementation"

### For Codebase Chat (`Ctrl+L`)

- "How does this integrate with Footnote's ethics framework?"
- "What are the potential risks of this change?"
- "How would this scale with additional model providers?"
- "Are there any ethical implications I should consider?"
- "Does this maintain Footnote's transparency requirements?"

## Usage Tips

1. **Be Specific**: Include context about what you're trying to achieve
2. **Reference Standards**: Mention specific project requirements when relevant
3. **Ask Follow-ups**: Use multiple prompts to drill down into specific areas
4. **Combine Analysis**: Use multiple prompts together for comprehensive review
5. **Document Findings**: Keep notes on what Cursor discovers for human review

## Example Workflow

1. **Start with tagging**: "Check `@arete-*` tagging compliance"
2. **Analyze complexity**: "Analyze this function for complexity issues"
3. **Review comments**: "Review the comments in this code"
4. **Check compliance**: "Check this code for project framework compliance"
5. **Future-proofing**: "Analyze this code for future compatibility"
6. **Ethics review**: "Perform an ethical safety review of this code"

This systematic approach ensures comprehensive analysis while leveraging Cursor's capabilities effectively.
