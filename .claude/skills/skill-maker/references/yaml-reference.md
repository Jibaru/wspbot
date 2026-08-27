# YAML Frontmatter Reference

Complete reference for SKILL.md YAML frontmatter configuration.

## Minimal Required Example

```yaml
---
name: my-skill-name
description: What it does. Use when user asks to [trigger phrases].
---
```

## Complete Example with All Fields

```yaml
---
name: comprehensive-skill
description: Analyzes data and generates reports. Use when user asks to analyze data, create reports, or visualize information.
license: MIT
compatibility: Claude.ai or MCP environments
metadata:
  author: Your Name
  company: Your Company
  version: 1.0.0
  mcp-server: my-mcp-server
  tags:
    - data-analysis
    - reporting
    - visualization
  homepage: https://github.com/yourusername/your-skill
  repository: https://github.com/yourusername/your-skill
---
```

## Required Fields

### name

**Type:** String
**Required:** Yes
**Format:** kebab-case (lowercase with hyphens)

The unique identifier for your skill.

**Valid examples:**
```yaml
name: my-skill
name: data-analyzer
name: github-pr-reviewer
name: multi-step-workflow
```

**Invalid examples:**
```yaml
name: MySkill              # Not kebab-case
name: my_skill             # Underscores not allowed
name: My Skill             # Spaces not allowed
name: MYSKILL              # Not kebab-case
```

**Rules:**
- Must be lowercase
- Use hyphens to separate words
- No spaces, underscores, or special characters
- Should match the folder name
- Keep it concise but descriptive

---

### description

**Type:** String
**Required:** Yes
**Max Length:** 1024 characters
**Forbidden Characters:** `<` `>`

The description that helps Claude decide when to activate this skill.

**Structure:**
1. First part: What the skill does
2. Second part: When to use it (trigger phrases)

**Good examples:**

```yaml
description: Analyzes Figma design files and generates developer handoff documentation. Use when user uploads .fig files or asks for design specs.
```

```yaml
description: Manages Linear project workflows including sprint planning and ticket creation. Use when user mentions sprint planning or creating tickets.
```

```yaml
description: Reviews pull requests for code quality, security issues, and best practices. Use when user asks to review PR, check code quality, or analyze pull requests.
```

**Bad examples:**

```yaml
description: Helps with stuff.
# Too vague - what stuff? when to use?
```

```yaml
description: Implements advanced polymorphic entity relationship mapping for distributed microservice architectures.
# Too technical - not user-facing language
```

```yaml
description: A skill for doing things
# No trigger phrases - when should it activate?
```

**Best practices:**
- Use natural language users would actually say
- Include 3-5 trigger phrases
- Be specific about what the skill does
- Focus on user outcomes, not implementation
- Keep under 500 characters when possible
- Test trigger phrases with real users

**Trigger phrase patterns:**

```yaml
# Direct command pattern
description: ... Use when user asks to "create a skill", "build a skill", or "make a new skill".

# Question pattern
description: ... Use when user asks "how do I...", "what's the best way to...", or "can you help me...".

# Context pattern
description: ... Use when user mentions sprint planning, ticket creation, or project management.

# File-based pattern
description: ... Use when user uploads .pdf files, shares design files, or provides mockups.
```

---

## Optional Fields

### license

**Type:** String
**Required:** No
**Default:** Not specified

The license under which the skill is distributed.

**Common values:**
```yaml
license: MIT
license: Apache-2.0
license: GPL-3.0
license: BSD-3-Clause
license: Proprietary
```

---

### compatibility

**Type:** String
**Required:** No
**Default:** All environments

Specifies where the skill can run.

**Examples:**
```yaml
compatibility: Claude.ai
compatibility: Claude Code
compatibility: Claude API
compatibility: MCP environments
compatibility: Claude.ai or MCP environments
compatibility: Requires Claude Code
```

---

### metadata

**Type:** Object
**Required:** No

Additional information about the skill.

#### metadata.author

**Type:** String

Name of the skill creator.

```yaml
metadata:
  author: Jane Doe
  author: Acme Corp
  author: jane@example.com
```

#### metadata.company

**Type:** String

Organization that created the skill.

```yaml
metadata:
  company: Acme Corporation
```

#### metadata.version

**Type:** String
**Format:** Semantic versioning (MAJOR.MINOR.PATCH)

Current version of the skill.

```yaml
metadata:
  version: 1.0.0
  version: 2.1.3
  version: 0.1.0-beta
```

**Version guidelines:**
- Start at 1.0.0 for first stable release
- Use 0.x.x for beta versions
- Increment MAJOR for breaking changes
- Increment MINOR for new features
- Increment PATCH for bug fixes

#### metadata.mcp-server

**Type:** String

Name of the MCP server this skill enhances.

```yaml
metadata:
  mcp-server: github
  mcp-server: linear
  mcp-server: my-custom-server
```

#### metadata.tags

**Type:** Array of strings

Searchable tags for categorizing the skill.

```yaml
metadata:
  tags:
    - workflow
    - automation
    - productivity
```

**Common tag categories:**

```yaml
# By function
tags: [data-analysis, reporting, visualization]

# By domain
tags: [finance, healthcare, education]

# By technology
tags: [python, javascript, api]

# By use case
tags: [debugging, testing, deployment]
```

#### metadata.homepage

**Type:** String (URL)

Link to skill documentation or homepage.

```yaml
metadata:
  homepage: https://github.com/username/skill-name
  homepage: https://docs.example.com/skills/my-skill
```

#### metadata.repository

**Type:** String (URL)

Link to source code repository.

```yaml
metadata:
  repository: https://github.com/username/skill-name
  repository: https://gitlab.com/username/skill-name
```

---

## Advanced Metadata Fields

These are custom fields you can add for your own organizational purposes:

```yaml
metadata:
  # Skill relationships
  requires-skills:
    - base-skill
    - helper-skill

  # Environment requirements
  min-claude-version: 1.5.0
  requires-mcp: true
  requires-scripts: true

  # Usage tracking
  category: workflow-automation
  complexity: advanced
  estimated-time: 5-10 minutes

  # Support information
  documentation: https://docs.example.com
  support-email: support@example.com
  issues: https://github.com/user/skill/issues

  # Lifecycle
  status: stable
  deprecated: false
  maintenance-mode: false

  # Technical details
  platforms:
    - linux
    - macos
    - windows
  dependencies:
    - node: ">=18"
    - python: ">=3.9"
```

---

## YAML Syntax Rules

### Spacing

```yaml
# Correct - colon followed by space
name: my-skill

# Wrong - no space after colon
name:my-skill
```

### Multiline Strings

```yaml
# Using literal block (preserves line breaks)
description: |
  First line.
  Second line.
  Third line.

# Using folded block (wraps lines)
description: >
  This long description
  will be wrapped into
  a single line.

# Using quotes for inline
description: "Single line with \"quotes\" inside"
```

### Arrays

```yaml
# Array syntax option 1
tags:
  - workflow
  - automation
  - testing

# Array syntax option 2 (inline)
tags: [workflow, automation, testing]
```

### Objects

```yaml
# Object syntax
metadata:
  author: John Doe
  version: 1.0.0
  tags:
    - tag1
    - tag2
```

### Special Characters

```yaml
# Escape special characters with quotes
description: "Skills can't use < or > characters"

# Or use literal block
description: |
  Skills can't use < or > characters
  But this is okay in literal blocks
```

### Comments

```yaml
---
# This is a comment
name: my-skill  # Inline comment

# Multi-line comment:
# Line 1
# Line 2

description: Does things
---
```

---

## Validation Checklist

Before finalizing your YAML frontmatter:

- [ ] name is kebab-case
- [ ] description is under 1024 characters
- [ ] description includes trigger phrases
- [ ] No `< >` characters in description
- [ ] YAML syntax is valid (proper spacing, quotes)
- [ ] All URLs are valid and accessible
- [ ] Version follows semantic versioning
- [ ] Tags are relevant and searchable
- [ ] Required fields are present
- [ ] Frontmatter starts and ends with `---`

---

## Common YAML Errors

### Error: Invalid YAML

```yaml
# Wrong - missing space after colon
name:my-skill

# Correct
name: my-skill
```

### Error: Invalid frontmatter delimiters

```yaml
# Wrong - only one delimiter
---
name: my-skill
description: Does things

# Correct - opening and closing
---
name: my-skill
description: Does things
---
```

### Error: Special characters

```yaml
# Wrong - unescaped special chars
description: Use when user asks to <create> something

# Correct - avoid < > entirely
description: Use when user asks to create something

# Correct - use quotes if needed
description: "Use when user provides input: value"
```

### Error: Improper nesting

```yaml
# Wrong - inconsistent indentation
metadata:
  author: John
   version: 1.0.0

# Correct - consistent 2-space indentation
metadata:
  author: John
  version: 1.0.0
```

---

## Testing Your YAML

Use the validation script:

```bash
node scripts/validate-skill.js path/to/your-skill
```

Or test manually:

1. Copy your frontmatter
2. Paste into YAML validator (yamllint.com)
3. Check for syntax errors
4. Verify all required fields present

---

## Complete Examples by Category

### Category 1: Document & Asset Creation

```yaml
---
name: ui-component-generator
description: Generates React UI components from design specifications with TypeScript and Tailwind CSS. Use when user asks to create components, generate UI code, or convert designs to code.
license: MIT
metadata:
  author: Design Systems Team
  version: 1.2.0
  tags:
    - react
    - typescript
    - tailwind
    - ui-components
---
```

### Category 2: Workflow Automation

```yaml
---
name: release-manager
description: Automates software release process including changelog generation, version bumping, and deployment. Use when user asks to create release, publish version, or deploy to production.
license: Apache-2.0
compatibility: Claude Code
metadata:
  author: DevOps Team
  version: 2.0.0
  tags:
    - deployment
    - automation
    - cicd
---
```

### Category 3: MCP Enhancement

```yaml
---
name: github-pr-reviewer
description: Conducts comprehensive pull request reviews including code quality, security, and best practices using GitHub MCP. Use when user asks to review PR, check pull request, or analyze code changes.
compatibility: MCP environments
metadata:
  author: Code Quality Team
  version: 1.5.0
  mcp-server: github
  tags:
    - code-review
    - github
    - quality-assurance
---
```

This reference covers all aspects of YAML frontmatter configuration for Claude skills. Use it as a guide when creating or updating your skills.
