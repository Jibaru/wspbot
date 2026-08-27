#!/usr/bin/env node

/**
 * Skill Structure Validator
 *
 * Validates that a skill folder follows Claude's skill requirements.
 *
 * Usage:
 *   node validate-skill.js <path-to-skill-folder>
 *
 * Checks:
 *   - Folder naming (kebab-case)
 *   - SKILL.md exists with exact casing
 *   - Valid YAML frontmatter
 *   - Description requirements
 *   - File structure
 */

const fs = require('fs');
const path = require('path');

class SkillValidator {
  constructor(skillPath) {
    this.skillPath = skillPath;
    this.errors = [];
    this.warnings = [];
    this.passed = [];
  }

  validate() {
    console.log('\n🔍 Validating skill structure...\n');
    console.log(`Path: ${this.skillPath}\n`);

    this.checkFolderExists();
    this.checkFolderNaming();
    this.checkSkillMdExists();
    this.checkSkillMdContent();
    this.checkNoReadme();
    this.checkOptionalFolders();

    this.printResults();
  }

  checkFolderExists() {
    if (!fs.existsSync(this.skillPath)) {
      this.errors.push('Folder does not exist');
      return false;
    }

    if (!fs.statSync(this.skillPath).isDirectory()) {
      this.errors.push('Path is not a directory');
      return false;
    }

    this.passed.push('✓ Folder exists');
    return true;
  }

  checkFolderNaming() {
    const folderName = path.basename(this.skillPath);
    const kebabCasePattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;

    if (!kebabCasePattern.test(folderName)) {
      this.errors.push(`Folder name "${folderName}" is not kebab-case. Use lowercase with hyphens (e.g., my-skill-name)`);
    } else {
      this.passed.push('✓ Folder name is kebab-case');
    }
  }

  checkSkillMdExists() {
    const skillMdPath = path.join(this.skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      this.errors.push('SKILL.md not found. File must be named exactly "SKILL.md" (uppercase)');

      // Check for common mistakes
      if (fs.existsSync(path.join(this.skillPath, 'skill.md'))) {
        this.errors.push('Found "skill.md" but it must be "SKILL.md" (uppercase)');
      }
      if (fs.existsSync(path.join(this.skillPath, 'Skill.md'))) {
        this.errors.push('Found "Skill.md" but it must be "SKILL.md" (all caps)');
      }

      return false;
    }

    this.passed.push('✓ SKILL.md exists with correct casing');
    return true;
  }

  checkSkillMdContent() {
    const skillMdPath = path.join(this.skillPath, 'SKILL.md');

    if (!fs.existsSync(skillMdPath)) {
      return; // Already reported in previous check
    }

    const content = fs.readFileSync(skillMdPath, 'utf-8');

    // Check for YAML frontmatter
    const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);

    if (!frontmatterMatch) {
      this.errors.push('SKILL.md missing YAML frontmatter (must start with --- and end with ---)');
      return;
    }

    this.passed.push('✓ YAML frontmatter present');

    const frontmatter = frontmatterMatch[1];

    // Check for required fields
    const hasName = /^name:\s*.+/m.test(frontmatter);
    const hasDescription = /^description:\s*.+/m.test(frontmatter);

    if (!hasName) {
      this.errors.push('YAML frontmatter missing required field: name');
    } else {
      this.passed.push('✓ "name" field present');

      // Validate name format
      const nameMatch = frontmatter.match(/^name:\s*(.+)/m);
      if (nameMatch) {
        const name = nameMatch[1].trim();
        const kebabPattern = /^[a-z0-9]+(-[a-z0-9]+)*$/;
        if (!kebabPattern.test(name)) {
          this.errors.push(`Name "${name}" is not kebab-case`);
        } else {
          this.passed.push('✓ Name is kebab-case');
        }
      }
    }

    if (!hasDescription) {
      this.errors.push('YAML frontmatter missing required field: description');
    } else {
      this.passed.push('✓ "description" field present');

      // Validate description
      const descMatch = frontmatter.match(/^description:\s*(.+)/m);
      if (descMatch) {
        const description = descMatch[1].trim();

        if (description.length > 1024) {
          this.errors.push(`Description is ${description.length} characters (max 1024)`);
        } else {
          this.passed.push('✓ Description under 1024 characters');
        }

        if (/<|>/.test(description)) {
          this.errors.push('Description contains < or > characters (not allowed)');
        } else {
          this.passed.push('✓ Description has no forbidden characters');
        }

        if (!description.toLowerCase().includes('use when')) {
          this.warnings.push('Description should include trigger guidance (e.g., "Use when user asks to...")');
        } else {
          this.passed.push('✓ Description includes trigger guidance');
        }
      }
    }

    // Check content length
    const wordCount = content.split(/\s+/).length;
    if (wordCount > 5000) {
      this.warnings.push(`SKILL.md is ${wordCount} words. Consider keeping under 5000 words for better performance.`);
    } else {
      this.passed.push('✓ SKILL.md word count reasonable');
    }
  }

  checkNoReadme() {
    const readmePath = path.join(this.skillPath, 'README.md');

    if (fs.existsSync(readmePath)) {
      this.errors.push('README.md found in skill folder. Skills should not have README.md - use SKILL.md instead');
    } else {
      this.passed.push('✓ No README.md (correct)');
    }
  }

  checkOptionalFolders() {
    const optionalFolders = ['scripts', 'references', 'assets'];
    const foundFolders = [];

    optionalFolders.forEach(folder => {
      const folderPath = path.join(this.skillPath, folder);
      if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
        foundFolders.push(folder);
      }
    });

    if (foundFolders.length > 0) {
      this.passed.push(`✓ Optional folders: ${foundFolders.join(', ')}`);
    }
  }

  printResults() {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (this.passed.length > 0) {
      console.log('✅ PASSED CHECKS:\n');
      this.passed.forEach(pass => console.log(`  ${pass}`));
      console.log();
    }

    if (this.warnings.length > 0) {
      console.log('⚠️  WARNINGS:\n');
      this.warnings.forEach(warning => console.log(`  ⚠️  ${warning}`));
      console.log();
    }

    if (this.errors.length > 0) {
      console.log('❌ ERRORS:\n');
      this.errors.forEach(error => console.log(`  ❌ ${error}`));
      console.log();
    }

    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    if (this.errors.length === 0) {
      console.log('🎉 Skill structure is valid!\n');
      console.log('Next steps:');
      console.log('  1. Test the skill in Claude');
      console.log('  2. Verify trigger phrases work');
      console.log('  3. Validate workflow completion');
      console.log('  4. Zip and upload to Claude.ai\n');
    } else {
      console.log('❌ Skill has errors that need to be fixed.\n');
      process.exit(1);
    }
  }
}

// Main execution
const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('\nUsage: node validate-skill.js <path-to-skill-folder>\n');
  console.log('Example:');
  console.log('  node validate-skill.js ../my-skill-name\n');
  process.exit(1);
}

const skillPath = path.resolve(args[0]);
const validator = new SkillValidator(skillPath);
validator.validate();
