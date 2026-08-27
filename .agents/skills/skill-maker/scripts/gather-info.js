#!/usr/bin/env node

/**
 * Interactive Skill Information Gathering Script
 *
 * This script helps gather all necessary information to create a new skill.
 * Run it to interactively collect skill requirements.
 *
 * Usage:
 *   node gather-info.js
 *
 * Output:
 *   skill-config.json with all gathered information
 */

const readline = require('readline');
const fs = require('fs');
const path = require('path');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function question(prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve);
  });
}

async function gatherSkillInfo() {
  console.log('\n=== Claude Skill Maker - Information Gathering ===\n');

  const skillInfo = {};

  // Basic Information
  console.log('📋 BASIC INFORMATION\n');

  skillInfo.name = await question('Skill name (kebab-case, e.g., my-skill-name): ');
  while (!skillInfo.name.match(/^[a-z0-9]+(-[a-z0-9]+)*$/)) {
    console.log('❌ Invalid name. Must be kebab-case (lowercase, hyphens only)');
    skillInfo.name = await question('Skill name (kebab-case): ');
  }

  skillInfo.purpose = await question('\nWhat is the main purpose of this skill? ');

  // Use Cases
  console.log('\n📝 USE CASES (provide 2-3 specific scenarios)\n');

  skillInfo.useCases = [];
  for (let i = 1; i <= 3; i++) {
    const useCase = await question(`Use case ${i} (or press Enter to skip): `);
    if (useCase.trim()) {
      skillInfo.useCases.push(useCase);
    }
  }

  // Trigger Phrases
  console.log('\n🎯 TRIGGER PHRASES\n');
  console.log('What phrases should activate this skill?');

  skillInfo.triggers = [];
  for (let i = 1; i <= 5; i++) {
    const trigger = await question(`Trigger phrase ${i} (or press Enter to finish): `);
    if (trigger.trim()) {
      skillInfo.triggers.push(trigger);
    } else if (i > 1) {
      break;
    }
  }

  // Category
  console.log('\n📂 CATEGORY\n');
  console.log('1. Document & Asset Creation (generating consistent output)');
  console.log('2. Workflow Automation (multi-step processes)');
  console.log('3. MCP Enhancement (enhancing MCP integrations)');

  const categoryChoice = await question('\nSelect category (1-3): ');
  const categories = {
    '1': 'Document & Asset Creation',
    '2': 'Workflow Automation',
    '3': 'MCP Enhancement'
  };
  skillInfo.category = categories[categoryChoice] || 'Workflow Automation';

  // Dependencies
  console.log('\n🔧 DEPENDENCIES\n');

  skillInfo.needsMCP = await question('Requires MCP server? (y/n): ') === 'y';
  if (skillInfo.needsMCP) {
    skillInfo.mcpServer = await question('MCP server name: ');
  }

  skillInfo.needsScripts = await question('Needs custom scripts? (y/n): ') === 'y';
  skillInfo.needsReferences = await question('Needs reference documentation? (y/n): ') === 'y';
  skillInfo.needsAssets = await question('Needs templates/assets? (y/n): ') === 'y';

  // Success Criteria
  console.log('\n✅ SUCCESS CRITERIA\n');

  skillInfo.successCriteria = await question('How will you know this skill works well? ');

  // Additional Information
  console.log('\n📚 ADDITIONAL INFORMATION\n');

  skillInfo.author = await question('Author name (optional): ') || 'Anonymous';
  skillInfo.license = await question('License (default: MIT): ') || 'MIT';

  // Generate description
  const triggerText = skillInfo.triggers.length > 0
    ? `Use when user asks to "${skillInfo.triggers[0]}"`
    : 'Use when appropriate';
  skillInfo.description = `${skillInfo.purpose}. ${triggerText}`;

  // Summary
  console.log('\n=== SUMMARY ===\n');
  console.log(JSON.stringify(skillInfo, null, 2));

  const confirm = await question('\nSave this configuration? (y/n): ');

  if (confirm.toLowerCase() === 'y') {
    const outputPath = path.join(process.cwd(), 'skill-config.json');
    fs.writeFileSync(outputPath, JSON.stringify(skillInfo, null, 2));
    console.log(`\n✅ Configuration saved to: ${outputPath}`);
    console.log('\nNext steps:');
    console.log('1. Review the configuration');
    console.log('2. Use this information to create your SKILL.md');
    console.log('3. Set up folder structure');
    console.log('4. Test the skill');
  } else {
    console.log('\n❌ Configuration not saved.');
  }

  rl.close();
}

// Run the script
gatherSkillInfo().catch(error => {
  console.error('Error:', error.message);
  rl.close();
  process.exit(1);
});
