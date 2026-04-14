---
name: skill-creator
description: Design and author OpenCode skill bundles for Open Cowork, including SKILL.md and any supporting reference files.
---

# Skill Creator

Use this skill when a user wants to create or update an OpenCode skill for Open Cowork.

## Purpose

- Turn a rough workflow idea into a reusable skill bundle.
- Keep the skill aligned with the OpenCode skill standard: one `SKILL.md` entrypoint plus optional extra files.
- Add extra files only when they materially improve the skill, such as templates, examples, references, or helper assets.

## Workflow

1. Confirm the skill's job:
   - what it helps with
   - when it should be used
   - what tools it expects or teaches
2. Choose a clean skill id:
   - lowercase
   - hyphenated
   - stable and descriptive
3. Draft `SKILL.md` with:
   - frontmatter `name`
   - frontmatter `description`
   - a short purpose section
   - a workflow section
   - tool guidance if relevant
   - guardrails if misuse is likely
4. Decide whether the bundle needs extra files:
   - `references/*.md` for longer usage notes
   - `examples/*.md` for worked examples
   - `templates/*` for reusable output scaffolds
   - avoid extra files if the skill is simple enough to live in `SKILL.md`
5. Use the `skills` MCP tools to save the bundle:
   - `get_skill_bundle` before editing an existing skill
   - `save_skill_bundle` to create or update the bundle
   - `list_skill_bundles` to inspect what already exists
6. Summarize what was created:
   - skill id
   - main purpose
   - any extra files added

## Guardrails

- Do not create vague skills that duplicate general assistant behavior.
- Prefer one focused skill over a broad catch-all.
- Keep instructions operational and reusable.
- If a skill depends on a tool or MCP, state that clearly.
- If no extra files are needed, do not invent them.

## Output

- Brief explanation of the skill’s purpose.
- The saved skill id.
- A short note on any supporting files added to the bundle.
