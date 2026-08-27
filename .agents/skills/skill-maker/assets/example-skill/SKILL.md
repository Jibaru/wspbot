---
name: markdown-formatter
description: Formats and validates Markdown documents according to best practices and common standards. Use when user asks to format markdown, clean up MD files, or validate markdown syntax.
license: MIT
metadata:
  author: Skill Maker Team
  version: 1.0.0
  tags:
    - markdown
    - formatting
    - documentation
---

# Markdown Formatter

Professional Markdown formatting and validation for documentation projects.

## Instructions

### Step 1: Analyze the Document

When the user provides a Markdown file or content:

1. Read the entire document
2. Identify formatting issues:
   - Inconsistent heading levels
   - Missing blank lines
   - Incorrect list indentation
   - Code block formatting
   - Link syntax errors

### Step 2: Apply Formatting Rules

Format the document according to these standards:

**Headings:**
- H1 (`#`) - Only one per document (title)
- H2 (`##`) - Main sections
- H3 (`###`) - Subsections
- Blank line before and after headings

**Lists:**
- Use `-` for unordered lists
- Use `1.` for ordered lists
- 2-space indentation for nested items
- Blank line before and after lists

**Code Blocks:**
- Use triple backticks with language identifier
- Examples: `python`, `javascript`, `bash`, `markdown`
- Blank line before and after code blocks

**Links:**
- Inline: `[text](url)`
- Reference: `[text][ref]` with `[ref]: url` at bottom
- Check for broken reference links

**Emphasis:**
- Bold: `**text**`
- Italic: `*text*`
- Code: `` `text` ``

### Step 3: Validate Content

Check for:
- [ ] One H1 heading
- [ ] Proper heading hierarchy (no skipped levels)
- [ ] Consistent list markers
- [ ] Valid link syntax
- [ ] Properly closed code blocks
- [ ] No trailing whitespace
- [ ] File ends with newline

### Step 4: Present Results

Show:
1. List of issues found
2. Formatted version of the document
3. Summary of changes made

## Examples

### Example 1: Format Messy Markdown

User provides:
```markdown
#heading
no blank lines
##another heading
- list item
* different marker
- item 3
```

Action:
1. Identify issues (missing spaces, inconsistent markers, no blank lines)
2. Apply formatting rules
3. Generate clean output

Result:
```markdown
# Heading

No blank lines

## Another Heading

- List item
- Different marker
- Item 3
```

### Example 2: Validate Documentation

User says: "Check if my README.md follows best practices"

Actions:
1. Read README.md
2. Validate against checklist
3. Report issues
4. Suggest improvements

Result:
- Issues found: 3
- Missing: License section
- Issue: Multiple H1 headings
- Issue: Code blocks without language identifiers

## Formatting Checklist

When formatting any Markdown document:

**Structure:**
- [ ] Single H1 title at top
- [ ] Logical heading hierarchy
- [ ] Table of contents (for docs > 500 lines)

**Spacing:**
- [ ] Blank line before headings
- [ ] Blank line after headings
- [ ] Blank line before lists
- [ ] Blank line after lists
- [ ] Blank line before code blocks
- [ ] Blank line after code blocks

**Syntax:**
- [ ] Consistent list markers (use `-`)
- [ ] Proper link syntax
- [ ] Code blocks have language tags
- [ ] Tables properly formatted

**Content:**
- [ ] No trailing whitespace
- [ ] File ends with single newline
- [ ] No tabs (use spaces)
- [ ] 80-100 char line length (optional)

## Best Practices

### Document Structure

```markdown
# Document Title

Brief introduction paragraph.

## Section 1

Content here.

### Subsection 1.1

More details.

## Section 2

Another main section.
```

### Code Blocks

Always specify language:

````markdown
```python
def hello():
    print("Hello, World!")
```
````

Not:

````markdown
```
def hello():
    print("Hello, World!")
```
````

### Lists

Consistent and clear:

```markdown
- First item
- Second item
  - Nested item
  - Another nested item
- Third item
```

### Links

Inline for short documents:
```markdown
Visit [GitHub](https://github.com) for more.
```

Reference for long documents:
```markdown
Visit [GitHub][gh] for more.

[gh]: https://github.com
```

## Troubleshooting

### Issue: Heading Hierarchy Broken

Error: H3 follows H1 (skipped H2)

Solution:
```markdown
# Main Title
## First Section    ← Add this
### Subsection
```

### Issue: List Formatting

Error: Mixed list markers

Solution:
```markdown
<!-- Wrong -->
- Item 1
* Item 2
+ Item 3

<!-- Correct -->
- Item 1
- Item 2
- Item 3
```

### Issue: Code Block Not Rendering

Error: Missing closing backticks

Solution:
````markdown
<!-- Check you have 3 backticks at start and end -->
```language
code here
```
````

## Advanced Usage

### Custom Rules

You can specify custom formatting rules:

```markdown
User: "Format this but use * for lists"
```

Adapt formatting to user preferences while maintaining consistency.

### Batch Processing

For multiple files:
1. Process each file
2. Track issues per file
3. Report summary at end

### Integration

Can be combined with:
- Linters (markdownlint)
- Documentation generators
- Static site generators
- CI/CD validation

## Output Example

When formatting is complete:

```
✅ Markdown Formatting Complete

Issues Found: 8
- Missing blank lines: 5
- Inconsistent list markers: 2
- Code block without language: 1

Changes Applied:
✓ Added blank lines around headings
✓ Standardized list markers to `-`
✓ Added language identifier to code block
✓ Fixed heading hierarchy

Document Statistics:
- Headings: 1 H1, 3 H2, 5 H3
- Lists: 4 unordered, 2 ordered
- Code blocks: 6
- Links: 12 (all valid)

Your formatted document is ready!
```

---

This skill ensures consistent, professional Markdown formatting across all your documentation.
