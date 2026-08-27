# Advanced Skill Patterns

This document covers advanced patterns for building sophisticated Claude skills.

## Pattern 1: Multi-Step Workflows with Validation Gates

Use this pattern when each step must be validated before proceeding.

### Structure

```markdown
### Step 1: Initial Action
[Instructions]

Validation:
- Check 1
- Check 2

If validation fails: [Recovery steps]

### Step 2: Next Action (only if Step 1 validated)
[Instructions dependent on Step 1]
```

### Example Use Case

Database migration skill:
1. Backup current database → Validate backup exists
2. Run migration → Validate schema changes
3. Test connections → Validate application works
4. Clean up → Validate cleanup completed

## Pattern 2: Context-Aware Tool Selection

Use this when the same goal can be achieved with different tools based on context.

### Structure

```markdown
### Step 1: Analyze Context

Determine:
- File size
- File type
- User permissions
- Performance requirements

### Step 2: Select Appropriate Tool

If [condition A]:
  Use tool X because [reason]

If [condition B]:
  Use tool Y because [reason]

### Step 3: Execute with Selected Tool
[Tool-specific instructions]
```

### Example Use Case

File upload skill:
- Small files (< 10MB) → Direct upload
- Medium files (10-100MB) → Chunked upload
- Large files (> 100MB) → Cloud storage with link

## Pattern 3: Iterative Refinement Loop

Use this for tasks requiring quality improvements through iteration.

### Structure

```markdown
### Step 1: Generate Initial Draft
[Creation instructions]

### Step 2: Validation Pass
Run validation:
- Check 1
- Check 2
- Check 3

### Step 3: Improvement Loop
For each failed check:
1. Identify issue
2. Apply fix
3. Re-validate

Continue until all checks pass OR max iterations reached.

### Step 4: Final Verification
[Comprehensive validation]
```

### Example Use Case

Code review skill:
1. Generate review comments
2. Check coverage (functions, edge cases, style)
3. Add missing comments
4. Re-check until comprehensive
5. Format and present

## Pattern 4: Multi-Service Orchestration

Use this when coordinating actions across multiple external services.

### Structure

```markdown
### Step 1: Service A Operation
[Service A specific instructions]

Output: [What to capture]

### Step 2: Service B Operation (using Service A output)
Input from Step 1: [specific data]

[Service B specific instructions]

Output: [What to capture]

### Step 3: Combine and Process
Using outputs from Step 1 and Step 2:
[Integration logic]

### Step 4: Final Synchronization
Update both services with combined result.
```

### Example Use Case

Project setup skill (GitHub + Linear + Slack):
1. Create GitHub repo → Capture repo URL
2. Create Linear project → Capture project ID
3. Create Slack channel → Capture channel ID
4. Link all services together
5. Post setup summary to Slack

## Pattern 5: Conditional Branching

Use this when workflow paths diverge based on user input or system state.

### Structure

```markdown
### Step 1: Gather Information
Ask user:
- Question 1
- Question 2

### Step 2: Determine Path

Path A: If [condition]
  - Step 2A.1
  - Step 2A.2

Path B: If [other condition]
  - Step 2B.1
  - Step 2B.2

### Step 3: Common Finalization
[Steps that apply regardless of path]
```

### Example Use Case

Deployment skill:
- Production deploy → Full tests + approval + gradual rollout
- Staging deploy → Basic tests + direct deploy
- Development deploy → Skip tests + force deploy

## Pattern 6: Error Recovery and Fallbacks

Use this for robust workflows that handle failures gracefully.

### Structure

```markdown
### Step 1: Primary Approach
Try: [Preferred method]

If error [specific error]:
  → Fallback to Step 1B

If error [other error]:
  → Fallback to Step 1C

### Step 1B: Fallback Method 1
[Alternative approach]

### Step 1C: Fallback Method 2
[Another alternative]

### Step 2: Verify Success
Regardless of path taken, verify:
- Check 1
- Check 2
```

### Example Use Case

Data fetch skill:
1. Try API endpoint
   - If rate limited → Use cache
   - If 404 → Try alternative endpoint
   - If timeout → Retry with backoff
2. Validate data received
3. Process data

## Pattern 7: Progressive Data Collection

Use this when building up context through multiple queries.

### Structure

```markdown
### Step 1: Collect Basic Information
Ask:
- Essential question 1
- Essential question 2

### Step 2: Conditional Deep Dive
Based on Step 1 answers:

If [answer indicates complexity]:
  Ask follow-up questions:
  - Detail question 1
  - Detail question 2

### Step 3: Use Collected Data
Apply all gathered information to:
[Final action]
```

### Example Use Case

Bug report skill:
1. Basic info (what broke, when)
2. If critical → Get detailed repro steps
3. If user-facing → Get affected user count
4. Generate prioritized ticket with all context

## Pattern 8: Parallel Execution with Aggregation

Use this when independent tasks can run simultaneously.

### Structure

```markdown
### Step 1: Identify Independent Tasks
List tasks that don't depend on each other:
- Task A
- Task B
- Task C

### Step 2: Execute in Parallel
[Instructions for parallel execution]

### Step 3: Aggregate Results
Combine outputs:
- Result A + Result B + Result C
- Apply aggregation logic

### Step 4: Process Combined Result
[Final processing]
```

### Example Use Case

Research compilation skill:
1. Identify research topics
2. Search multiple sources simultaneously
3. Aggregate findings
4. Remove duplicates
5. Synthesize report

## Best Practices for Complex Patterns

### 1. State Management

Always track:
- Current step
- Completed steps
- Failed steps
- Retry attempts

### 2. Clear Exit Conditions

Define when to:
- Continue iteration
- Stop and succeed
- Stop and fail
- Ask for user intervention

### 3. Error Messages

Provide:
- What went wrong
- Why it went wrong
- What the skill will try next
- What the user can do

### 4. Progress Indicators

For long workflows:
- Show current step
- Show total steps
- Indicate completion percentage
- Estimate remaining time (optional)

### 5. Rollback Capabilities

For destructive operations:
- Document what was changed
- Provide rollback instructions
- Save state before changes
- Verify rollback success

## Combining Patterns

Patterns can be combined for sophisticated workflows:

**Example: Deployment Skill**
- Pattern 4 (Multi-Service): GitHub + Cloud + Monitoring
- Pattern 5 (Conditional): Different paths for prod/staging
- Pattern 6 (Error Recovery): Fallbacks for failed deployments
- Pattern 3 (Iterative): Retry failed deployment steps

**Example: Content Creation Skill**
- Pattern 3 (Iterative): Improve content quality
- Pattern 2 (Context-Aware): Choose format based on platform
- Pattern 7 (Progressive Collection): Gather requirements incrementally
- Pattern 1 (Validation Gates): Check quality before publishing

## Testing Complex Patterns

### Unit Testing
Test each step in isolation:
- Step completes correctly
- Error handling works
- Outputs are correct format

### Integration Testing
Test step transitions:
- Output of step N feeds step N+1
- State carries forward correctly
- Branching logic works

### End-to-End Testing
Test complete workflows:
- Happy path completes
- Error paths recover
- Edge cases handled
- Performance acceptable

## Performance Considerations

### Token Efficiency
- Keep SKILL.md instructions concise
- Move detailed examples to references/
- Use progressive disclosure
- Avoid redundant information

### Execution Speed
- Minimize API calls
- Use parallel execution where possible
- Cache repeated operations
- Batch similar operations

### Context Management
- Don't load unnecessary references
- Link to files instead of embedding
- Use clear section markers
- Make it easy to skip irrelevant sections

## Advanced YAML Configuration

### Multiple Trigger Categories

```yaml
---
name: advanced-skill
description: Primary description. Use when [triggers].
metadata:
  alternate-triggers:
    - category: data-analysis
      phrases: ["analyze data", "create report"]
    - category: visualization
      phrases: ["create chart", "visualize data"]
---
```

### Skill Dependencies

```yaml
---
name: advanced-skill
description: ...
metadata:
  requires-skills:
    - skill-a
    - skill-b
  mcp-servers:
    - server-1
    - server-2
---
```

### Version Constraints

```yaml
---
name: advanced-skill
description: ...
metadata:
  version: 2.0.0
  min-claude-version: 1.5.0
  compatibility: Claude.ai, API
---
```

These patterns provide a foundation for building sophisticated, production-ready skills that handle complex workflows reliably.
