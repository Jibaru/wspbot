
# The Complete Guide to Building Skills for Claude

## Contents

* Introduction
* Fundamentals
* Planning and design
* Testing and iteration
* Distribution and sharing
* Patterns and troubleshooting
* Resources and references

---

# Introduction

A skill is a set of instructions — packaged as a simple folder — that teaches Claude how to handle specific tasks or workflows. Skills are one of the most powerful ways to customize Claude for your specific needs. Instead of re-explaining your preferences, processes, and domain expertise in every conversation, skills let you teach Claude once and benefit every time.

Skills are powerful when you have repeatable workflows: generating frontend designs from specs, conducting research with consistent methodology, creating documents that follow your team's style guide, or orchestrating multi-step processes. They work well with Claude's built-in capabilities like code execution and document creation.

For those building MCP integrations, skills add another powerful layer helping turn raw tool access into reliable, optimized workflows.

This guide covers everything you need to know to build effective skills — from planning and structure to testing and distribution.

## What you'll learn

* Technical requirements and best practices for skill structure
* Patterns for standalone skills and MCP-enhanced workflows
* Patterns that work across different use cases
* How to test, iterate, and distribute skills

## Who this is for

* Developers who want Claude to follow specific workflows consistently
* Power users who want Claude to follow specific workflows
* Teams looking to standardize how Claude works across their organization

## Two Paths Through This Guide

**Standalone skills**

Focus on:

* Fundamentals
* Planning and Design

**MCP-enhanced workflows**

Focus on:

* Skills + MCP sections
* Category 3 use cases

Both paths share the same technical requirements.

---

# Fundamentals

## What is a skill?

A skill is a folder containing:

```
your-skill-name/
├── SKILL.md
├── scripts/
├── references/
└── assets/
```

### Required

```
SKILL.md
```

Instructions in Markdown with YAML frontmatter.

### Optional

**scripts/**
Executable code.

Examples:

* Python
* Bash

**references/**
Documentation Claude loads when needed.

**assets/**
Templates, fonts, icons used in output.

---

## Core design principles

### Progressive Disclosure

Skills use a **three-level system**:

**Level 1 — YAML frontmatter**

Always loaded into Claude's system prompt.

Purpose:

* Minimal metadata
* Decide when to activate skill

**Level 2 — SKILL.md body**

Loaded when Claude determines the skill is relevant.

Contains:

* instructions
* workflows
* guidance

**Level 3 — Linked files**

Files inside the skill directory that Claude explores only when necessary.

Examples:

```
references/
scripts/
assets/
```

Purpose:

* reduce token usage
* keep expertise available

---

### Composability

Claude can load **multiple skills simultaneously**.

Your skill should:

* work alongside other skills
* avoid assumptions that it is the only capability

---

### Portability

Skills work across:

* Claude.ai
* Claude Code
* Claude API

No modification required if dependencies are supported.

---

# Skills + MCP

If you already have an MCP server, skills provide the **knowledge layer**.

### Kitchen analogy

**MCP**

Professional kitchen:

* tools
* ingredients
* equipment

**Skills**

Recipes:

* step-by-step instructions
* workflows
* best practices

Together they allow complex workflows.

---

## How they work together

| MCP                         | Skills                         |
| --------------------------- | ------------------------------ |
| Connects Claude to services | Teaches Claude how to use them |
| Provides tool access        | Encodes workflows              |
| Enables data access         | Provides best practices        |

---

## Why this matters

### Without skills

* Users don't know what to do with the integration
* Many support questions
* Conversations restart workflows
* Inconsistent results

### With skills

* Pre-built workflows
* Consistent tool usage
* Embedded best practices
* Lower learning curve

---

# Planning and Design

## Start with use cases

Before writing code define **2–3 concrete use cases**.

Example:

### Use Case: Sprint Planning

Trigger

User says:

* "help me plan this sprint"
* "create sprint tasks"

Steps

1. Fetch project status from Linear
2. Analyze team capacity
3. Suggest prioritization
4. Create tasks

Result

Fully planned sprint.

---

### Questions to ask

* What does the user want to accomplish?
* What workflow steps are required?
* Which tools are needed?
* What domain knowledge should be embedded?

---

# Skill Categories

## Category 1 — Document & Asset Creation

Used for generating consistent output:

Examples:

* documents
* apps
* designs
* code
* presentations

Key techniques:

* style guides
* templates
* quality checklists

No external tools required.

---

## Category 2 — Workflow Automation

Multi-step processes.

Example: **skill-creator**

Techniques:

* step-by-step flows
* validation gates
* templates
* iterative improvement

---

## Category 3 — MCP Enhancement

Skills that enhance MCP integrations.

Example:

Sentry code review skill.

Techniques:

* multiple MCP calls
* domain expertise
* contextual knowledge
* error handling

---

# Define Success Criteria

## Quantitative metrics

Example targets:

* Skill triggers on **90%** of relevant queries
* Workflow completed with fewer tool calls
* **0 failed API calls**

---

## Qualitative metrics

* User does not need to ask for next steps
* Workflows complete without correction
* Results consistent across sessions

---

# Technical Requirements

## File structure

```
your-skill-name/
├── SKILL.md
├── scripts/
│   ├── process_data.py
│   └── validate.sh
├── references/
│   ├── api-guide.md
│   └── examples/
└── assets/
    └── report-template.md
```

---

## Critical rules

### SKILL.md naming

Must be exactly:

```
SKILL.md
```

Not allowed:

```
skill.md
SKILL.MD
```

---

### Folder naming

Use **kebab-case**

Correct:

```
notion-project-setup
```

Incorrect:

```
NotionProjectSetup
notion_project_setup
Notion Project Setup
```

---

### No README.md

Inside skill folder:

❌ Not allowed.

Use:

* SKILL.md
* references/

---

# YAML Frontmatter

Minimal example:

```yaml
---
name: your-skill-name
description: What it does. Use when user asks to [specific phrases].
---
```

---

## Required fields

### name

Rules:

* kebab-case
* no spaces
* no capitals

---

### description

Must include:

* What the skill does
* When to use it

Limits:

* under 1024 characters
* no `< >`

---

## Optional fields

```yaml
license: MIT

compatibility: Claude.ai or MCP environments

metadata:
  author: Company
  version: 1.0.0
  mcp-server: server-name
```

---

# Writing Effective Skills

## Good description examples

```yaml
description: Analyzes Figma design files and generates developer handoff documentation. Use when user uploads .fig files or asks for design specs.
```

```yaml
description: Manages Linear project workflows including sprint planning and ticket creation. Use when user mentions sprint planning or creating tickets.
```

---

## Bad examples

Too vague:

```
Helps with projects.
```

Too technical:

```
Implements project entity models.
```

---

# SKILL.md Instruction Structure

Recommended template:

```markdown
---
name: your-skill
description: ...
---

# Skill Name

## Instructions

### Step 1
Explain step.

Example:

python scripts/fetch_data.py

Expected output:
...
```

---

## Examples section

Example scenario:

User says:

```
Set up marketing campaign
```

Actions:

1. Fetch campaigns
2. Create new campaign

Result:

Campaign created.

---

## Troubleshooting section

Example:

Error:

```
Connection refused
```

Solution:

* Verify server
* Reconnect

---

# Testing and Iteration

Testing approaches:

1. Manual testing in Claude
2. Scripted testing
3. API evaluation suites

---

## Testing areas

### Trigger tests

Ensure skill loads correctly.

Example triggers:

* "Create project workspace"
* "Initialize project"

Non triggers:

* weather
* unrelated coding

---

### Functional tests

Validate:

* outputs
* API calls
* error handling

---

### Performance comparison

Example:

| Without Skill  | With Skill |
| -------------- | ---------- |
| 15 messages    | 2 messages |
| 3 API failures | 0 failures |
| 12k tokens     | 6k tokens  |

---

# Distribution

Users install skills by:

1. Download skill folder
2. Zip folder
3. Upload to Claude

Location:

```
Claude Settings → Capabilities → Skills
```

---

## Organization deployment

Admins can deploy skills across workspaces.

---

# Using Skills via API

API features:

* `/v1/skills` endpoint
* `container.skills` parameter
* version management

---

## Best surface

| Use Case          | Best Surface |
| ----------------- | ------------ |
| Manual workflows  | Claude.ai    |
| Testing           | Claude.ai    |
| Production agents | API          |

---

# Skill Patterns

## Pattern 1 — Sequential workflow

Step-by-step processes.

Example:

1. Create account
2. Setup payment
3. Create subscription
4. Send email

---

## Pattern 2 — Multi-MCP coordination

Workflow across services:

1. Figma
2. Drive
3. Linear
4. Slack

---

## Pattern 3 — Iterative refinement

Workflow loop:

1. Generate draft
2. Validate
3. Improve
4. Repeat

---

## Pattern 4 — Context-aware tool selection

Decision tree based on:

* file size
* file type

Example:

* large → cloud storage
* collaborative → docs platform

---

## Pattern 5 — Domain intelligence

Example:

Financial compliance workflow.

Steps:

1. Compliance checks
2. Process payment
3. Create audit trail

---

# Troubleshooting

## Skill won't upload

Error:

```
Could not find SKILL.md
```

Fix:

Ensure file name is exactly:

```
SKILL.md
```

---

## Invalid frontmatter

Correct format:

```yaml
---
name: my-skill
description: Does things
---
```

---

## Skill not triggering

Improve description:

* add trigger phrases
* specify tasks

---

## Skill triggers too often

Add negative triggers:

```
Do NOT use for simple data exploration.
```

---

# Large Context Issues

Symptoms:

* slow responses
* degraded output

Solutions:

* keep SKILL.md < 5000 words
* move docs to references
* reduce enabled skills

---

# Resources

Official docs:

* Skills documentation
* API reference
* MCP documentation

Example skills:

* anthropics/skills GitHub repo

Tools:

**skill-creator**

Used for:

* generating skills
* reviewing skills
* improving structure

Example prompt:

```
Help me build a skill using skill-creator
```

---

# Quick Checklist

## Before starting

* define use cases
* identify tools
* plan structure

---

## During development

* kebab-case folder
* SKILL.md present
* valid YAML
* clear instructions

---

## Before upload

* trigger tests
* functional tests
* tool integration verified

---

## After upload

* monitor triggers
* collect feedback
* iterate
