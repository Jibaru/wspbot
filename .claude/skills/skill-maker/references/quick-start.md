# Quick Start Guide

Get your first skill up and running in 10 minutes.

## Prerequisites

- Basic understanding of Markdown
- Text editor
- Claude.ai account OR Claude Code installed

## Step-by-Step

### 1. Create Skill Folder (2 minutes)

```bash
# Create folder with kebab-case name
mkdir my-first-skill
cd my-first-skill
```

**Important:** Folder name must be kebab-case (lowercase with hyphens).

### 2. Create SKILL.md (5 minutes)

Create a file named exactly `SKILL.md` (uppercase) with this content:

```markdown
---
name: my-first-skill
description: A simple skill that demonstrates the basic structure. Use when user asks to test a skill or create a hello world skill.
---

# My First Skill

A simple demonstration skill.

## Instructions

### Step 1: Greet the User

When activated, respond with:
"Hello! This is your first Claude skill working successfully."

### Step 2: Show Skill Info

Display:
- Skill name: my-first-skill
- Purpose: Demonstrate skill basics
- Status: Active and working

## Example

User says:
```
test my skill
```

Response:
```
Hello! This is your first Claude skill working successfully.

Skill name: my-first-skill
Purpose: Demonstrate skill basics
Status: Active and working
```
```

### 3. Validate Structure (1 minute)

Use the validation script:

```bash
# From the skills directory
node skill-maker/scripts/validate-skill.js my-first-skill
```

Fix any errors reported.

### 4. Test the Skill (2 minutes)

**Option A: Claude.ai**

1. Zip your skill folder
2. Go to Claude.ai → Settings → Capabilities → Skills
3. Upload the zip file
4. Start a new conversation
5. Say "test my skill"

**Option B: Claude Code**

1. Place skill folder in: `~/.claude/skills/`
2. Restart Claude Code
3. Say "test my skill"

### 5. Verify It Works

You should see:
- Skill activates when you use trigger phrases
- Instructions are followed
- Output matches expectations

## Next Steps

### Expand Your Skill

Add more functionality:

```markdown
### Step 3: Provide Help

When user asks "what can you do?", explain:
- Feature 1
- Feature 2
- Feature 3
```

### Add Examples

Include more usage scenarios:

```markdown
## Examples

### Example 2: Advanced Usage

User says: "..."
Actions: ...
Result: ...
```

### Add Scripts

Create `scripts/` folder for automation:

```bash
mkdir scripts
# Add your scripts here
```

### Add References

Create `references/` for detailed docs:

```bash
mkdir references
# Add documentation here
```

### Add Assets

Create `assets/` for templates:

```bash
mkdir assets
# Add templates here
```

## Common Issues

### Issue: Skill won't upload

**Solution:** Check that:
- File is named `SKILL.md` (exact case)
- YAML frontmatter starts and ends with `---`
- Folder name is kebab-case

### Issue: Skill doesn't trigger

**Solution:**
- Add more trigger phrases to description
- Make description more specific
- Test with exact phrases from description

### Issue: YAML error

**Solution:**
- Check spacing after colons: `name: value`
- Ensure frontmatter starts/ends with `---`
- Remove `< >` characters
- Validate at yamllint.com

## Quick Reference

### Required Structure
```
my-skill/
└── SKILL.md (required)
```

### Minimum SKILL.md
```yaml
---
name: my-skill
description: What it does. Use when [triggers].
---

# My Skill

## Instructions

### Step 1
[What to do]
```

### Validation Command
```bash
node skill-maker/scripts/validate-skill.js path/to/skill
```

### Installation
1. Zip skill folder
2. Upload to Claude.ai
3. Test with trigger phrases

## Learning Resources

- Full guide: `skill-maker/README.md`
- Templates: `skill-maker/assets/`
- Advanced patterns: `skill-maker/references/advanced-patterns.md`
- YAML reference: `skill-maker/references/yaml-reference.md`

## 10-Minute Challenge

Can you create a skill that:
1. Has a creative name
2. Uses 3 trigger phrases
3. Performs 2-3 actions
4. Includes an example
5. Passes validation

Try it now! The best way to learn is by doing.

---

**Congratulations!** You've created your first Claude skill. Now you can:
- Customize it for your needs
- Create more complex skills
- Share with your team
- Contribute to the community

Happy skill building! 🚀
