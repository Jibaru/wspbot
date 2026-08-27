---
name: skill-maker
description: Guide users through creating new Claude skills with proper structure, YAML frontmatter, and best practices. Use when user asks to "create a skill", "build a new skill", "make a skill", "help me with a skill", or "skill creator".
---

# Skill Maker

A comprehensive guide and toolset for creating well-structured Claude skills.

## Instructions

When a user wants to create a new skill, follow this workflow:

### Step 1: Gather Requirements

Ask the user about their skill using the interactive gathering process:

1. **Skill Purpose**: What should this skill do?
2. **Use Cases**: What are 2-3 specific scenarios where this skill will be used?
3. **Trigger Phrases**: What phrases should activate this skill?
4. **Category**: Which category does this fit?
   - Category 1: Document & Asset Creation
   - Category 2: Workflow Automation
   - Category 3: MCP Enhancement
5. **Dependencies**: Does it require MCP servers, external tools, or scripts?
6. **Success Criteria**: How will we know the skill works well?

### Step 2: Generate Skill Structure

Create the folder structure based on requirements:

```
skill-name/
├── SKILL.md          (Required - main instructions)
├── scripts/          (Optional - executable code)
├── references/       (Optional - documentation)
└── assets/           (Optional - templates, files)
```

**Critical Rules:**
- Folder name MUST be kebab-case (e.g., `my-skill-name`)
- File MUST be named exactly `SKILL.md` (not `skill.md` or `SKILL.MD`)
- No `README.md` files inside skill folder

### Step 3: Create SKILL.md

Generate SKILL.md with:

**Required YAML Frontmatter:**
```yaml
---
name: skill-name
description: What it does. Use when user asks to [specific trigger phrases].
---
```

**Optional frontmatter fields:**
```yaml
license: MIT
compatibility: Claude.ai or MCP environments
metadata:
  author: Your Name
  version: 1.0.0
  mcp-server: server-name (if applicable)
```

**Body Structure:**
```markdown
# Skill Name

## Instructions

### Step 1: [First Action]
Clear explanation of what to do.

Example:
\`\`\`bash
command to run
\`\`\`

Expected output:
...

### Step 2: [Next Action]
Continue with clear, actionable steps.

## Examples

### Example Scenario 1
User says: "..."

Actions:
1. Action one
2. Action two

Result: Expected outcome

## Troubleshooting

### Common Error 1
Error message: `...`

Solution:
- Step to fix
```

### Step 4: Add Supporting Files

Based on skill category and requirements:

**For scripts/**
- Python scripts for data processing
- Bash scripts for automation
- Validation scripts

**For references/**
- API documentation
- Extended examples
- Domain-specific knowledge

**For assets/**
- Document templates
- Configuration files
- Style guides

### Step 5: Validate & Test

Before finalizing:

**Structure Validation:**
- [ ] Folder uses kebab-case naming
- [ ] SKILL.md exists with exact casing
- [ ] YAML frontmatter is valid
- [ ] Description includes trigger phrases
- [ ] Description under 1024 characters
- [ ] No `< >` characters in description

**Content Validation:**
- [ ] Instructions are clear and actionable
- [ ] Examples show realistic use cases
- [ ] Troubleshooting covers common issues
- [ ] Referenced files exist in correct folders

**Trigger Testing:**
- [ ] Test with expected trigger phrases
- [ ] Verify skill activates correctly
- [ ] Check for false positives

### Step 6: Provide Usage Instructions

Tell the user how to install:

1. Zip the skill folder
2. Open Claude Settings → Capabilities → Skills
3. Upload the zipped folder
4. Test with trigger phrases

## Best Practices

### Writing Effective Descriptions

**Good examples:**
```yaml
description: Analyzes Figma design files and generates developer handoff documentation. Use when user uploads .fig files or asks for design specs.
```

```yaml
description: Manages Linear project workflows including sprint planning and ticket creation. Use when user mentions sprint planning or creating tickets.
```

**Bad examples:**
- Too vague: "Helps with projects"
- Too technical: "Implements project entity models"
- No triggers: "A useful skill"

### Description Guidelines

- First sentence: What the skill does
- Second sentence: "Use when user asks to [specific phrases]"
- Be specific about triggers
- Under 1024 characters
- No HTML special characters (`< >`)
- Focus on user-facing functionality

### Instruction Guidelines

- Use numbered steps for sequential workflows
- Include code examples with syntax highlighting
- Show expected outputs
- Explain what each step accomplishes
- Keep main instructions under 5000 words
- Move detailed docs to references/

### Progressive Disclosure

**Level 1 - YAML frontmatter:**
Minimal metadata for skill activation

**Level 2 - SKILL.md body:**
Core instructions and workflows

**Level 3 - Linked files:**
Detailed documentation, examples, scripts

This keeps the skill efficient while maintaining deep expertise.

## Skill Patterns

### Pattern 1: Sequential Workflow
For step-by-step processes:
1. Action A
2. Action B (depends on A)
3. Action C (depends on B)

### Pattern 2: Multi-Service Coordination
Orchestrating across multiple tools:
1. Service A
2. Service B
3. Combine results

### Pattern 3: Iterative Refinement
Loop until quality threshold:
1. Generate
2. Validate
3. Improve
4. Repeat if needed

### Pattern 4: Context-Aware Selection
Decision trees based on inputs:
- If condition X → use tool A
- If condition Y → use tool B

### Pattern 5: Domain Intelligence
Embedding expert knowledge:
1. Compliance checks
2. Best practices
3. Domain-specific validation

## Common Issues

### Issue: Skill won't trigger
**Cause:** Description doesn't match user intent

**Solution:**
- Add more trigger phrases to description
- Test with realistic user queries
- Make description more specific

### Issue: Skill triggers too often
**Cause:** Description is too broad

**Solution:**
- Add negative triggers: "Do NOT use for..."
- Be more specific about use cases
- Narrow the scope

### Issue: Large context problems
**Symptoms:** Slow responses, degraded output

**Solution:**
- Move content to references/
- Keep SKILL.md under 5000 words
- Use progressive disclosure
- Link to files instead of embedding

### Issue: Instructions unclear
**Cause:** Missing examples or expected outputs

**Solution:**
- Add concrete examples
- Show expected results
- Include troubleshooting section
- Test with someone unfamiliar

## Templates Reference

Use the templates in `assets/` folder:
- `skill-template.md` - Complete SKILL.md template
- `script-template.py` - Python script template
- `reference-template.md` - Reference doc template

## Quality Checklist

Before considering a skill complete:

**Structure:**
- [ ] Kebab-case folder name
- [ ] SKILL.md present (exact casing)
- [ ] Valid YAML frontmatter
- [ ] Optional folders used appropriately

**Content:**
- [ ] Clear, specific description
- [ ] Trigger phrases included
- [ ] Step-by-step instructions
- [ ] Examples provided
- [ ] Troubleshooting section

**Testing:**
- [ ] Triggers on expected phrases
- [ ] Doesn't trigger on unrelated queries
- [ ] Workflow completes successfully
- [ ] Error handling works

**Performance:**
- [ ] SKILL.md under 5000 words
- [ ] Large content in references/
- [ ] No redundant information

## Tips for Success

1. **Start with use cases** - Define 2-3 concrete scenarios first
2. **Write for composability** - Assume other skills may be active
3. **Test early and often** - Don't wait until it's "perfect"
4. **Iterate based on feedback** - Skills improve with real usage
5. **Keep it focused** - Better to do one thing well than many things poorly
6. **Document assumptions** - Make implicit knowledge explicit
7. **Think progressive disclosure** - Not everything needs to be in SKILL.md

## Next Steps

After creating a skill:
1. Test thoroughly with realistic queries
2. Collect user feedback
3. Monitor trigger accuracy
4. Iterate and improve
5. Consider sharing with community

## Resources

- Full guide: `skill-maker/references/complete-guide.md`
- Quick start: `skill-maker/references/quick-start.md`
- YAML reference: `skill-maker/references/yaml-reference.md`
- Advanced patterns: `skill-maker/references/advanced-patterns.md`
- Templates: `skill-maker/assets/`
- Interactive gathering: `node skill-maker/scripts/gather-info.js`
- Validation: `node skill-maker/scripts/validate-skill.js <path>`
- Examples: Official Anthropic skills repo
