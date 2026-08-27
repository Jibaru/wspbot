#!/usr/bin/env python3

"""
Interactive Skill Information Gathering Script (Python version)

This script helps gather all necessary information to create a new skill.
Run it to interactively collect skill requirements.

Usage:
    python gather-info.py

Output:
    skill-config.json with all gathered information
"""

import json
import re
import sys
from pathlib import Path


def validate_kebab_case(name):
    """Validate that a string is in kebab-case format."""
    pattern = r'^[a-z0-9]+(-[a-z0-9]+)*$'
    return bool(re.match(pattern, name))


def get_input(prompt, default=None, validator=None):
    """Get user input with optional default and validation."""
    while True:
        if default:
            user_input = input(f"{prompt} [{default}]: ").strip()
            if not user_input:
                return default
        else:
            user_input = input(f"{prompt}: ").strip()

        if validator:
            if validator(user_input):
                return user_input
            else:
                print("❌ Invalid input. Please try again.")
        else:
            return user_input


def get_yes_no(prompt):
    """Get yes/no input from user."""
    while True:
        response = input(f"{prompt} (y/n): ").strip().lower()
        if response in ['y', 'yes']:
            return True
        elif response in ['n', 'no']:
            return False
        else:
            print("Please enter 'y' or 'n'")


def get_list_input(prompt, min_items=0, max_items=None):
    """Get a list of inputs from user."""
    items = []
    print(f"\n{prompt}")

    i = 1
    while True:
        if max_items and i > max_items:
            break

        item = input(f"  {i}. (or press Enter to finish): ").strip()

        if not item:
            if i > min_items:
                break
            else:
                print(f"Please provide at least {min_items} item(s)")
                continue

        items.append(item)
        i += 1

    return items


def main():
    """Main function to gather skill information."""
    print("\n" + "="*50)
    print("Claude Skill Maker - Information Gathering")
    print("="*50 + "\n")

    skill_info = {}

    # Basic Information
    print("📋 BASIC INFORMATION\n")

    skill_info['name'] = get_input(
        "Skill name (kebab-case, e.g., my-skill-name)",
        validator=validate_kebab_case
    )

    skill_info['purpose'] = get_input(
        "\nWhat is the main purpose of this skill?"
    )

    # Use Cases
    print("\n📝 USE CASES\n")
    print("Provide 2-3 specific scenarios where this skill will be used")

    skill_info['use_cases'] = get_list_input(
        "Enter use cases:",
        min_items=2,
        max_items=3
    )

    # Trigger Phrases
    print("\n🎯 TRIGGER PHRASES\n")
    print("What phrases should activate this skill?")

    skill_info['triggers'] = get_list_input(
        "Enter trigger phrases:",
        min_items=1,
        max_items=5
    )

    # Category
    print("\n📂 CATEGORY\n")
    print("1. Document & Asset Creation (generating consistent output)")
    print("2. Workflow Automation (multi-step processes)")
    print("3. MCP Enhancement (enhancing MCP integrations)")

    categories = {
        '1': 'Document & Asset Creation',
        '2': 'Workflow Automation',
        '3': 'MCP Enhancement'
    }

    category_choice = get_input("\nSelect category (1-3)", default='2')
    skill_info['category'] = categories.get(category_choice, 'Workflow Automation')

    # Dependencies
    print("\n🔧 DEPENDENCIES\n")

    skill_info['needs_mcp'] = get_yes_no("Requires MCP server?")
    if skill_info['needs_mcp']:
        skill_info['mcp_server'] = get_input("MCP server name")

    skill_info['needs_scripts'] = get_yes_no("Needs custom scripts?")
    skill_info['needs_references'] = get_yes_no("Needs reference documentation?")
    skill_info['needs_assets'] = get_yes_no("Needs templates/assets?")

    # Success Criteria
    print("\n✅ SUCCESS CRITERIA\n")

    skill_info['success_criteria'] = get_input(
        "How will you know this skill works well?"
    )

    # Additional Information
    print("\n📚 ADDITIONAL INFORMATION\n")

    skill_info['author'] = get_input("Author name", default="Anonymous")
    skill_info['license'] = get_input("License", default="MIT")

    # Generate description
    trigger_text = (
        f'Use when user asks to "{skill_info["triggers"][0]}"'
        if skill_info['triggers']
        else 'Use when appropriate'
    )
    skill_info['description'] = f"{skill_info['purpose']}. {trigger_text}"

    # Summary
    print("\n" + "="*50)
    print("SUMMARY")
    print("="*50 + "\n")
    print(json.dumps(skill_info, indent=2))

    # Confirmation
    if get_yes_no("\nSave this configuration?"):
        output_path = Path.cwd() / 'skill-config.json'
        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(skill_info, f, indent=2)

        print(f"\n✅ Configuration saved to: {output_path}")
        print("\nNext steps:")
        print("1. Review the configuration")
        print("2. Use this information to create your SKILL.md")
        print("3. Set up folder structure")
        print("4. Test the skill\n")
    else:
        print("\n❌ Configuration not saved.\n")


if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        print("\n\n❌ Operation cancelled by user.\n")
        sys.exit(1)
    except Exception as e:
        print(f"\n❌ Error: {str(e)}\n")
        sys.exit(1)
