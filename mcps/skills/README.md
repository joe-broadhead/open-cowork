# @open-cowork/mcp-skills

Bundled MCP server for reading and writing user-authored OpenCode skill
bundles.

The server manages the writable custom-skill layer only. Product-shipped
skills are discovered by OpenCode through runtime config and are not copied
through this MCP.

## Environment

`OPEN_COWORK_CUSTOM_SKILLS_DIR` must point at the directory where custom
skill bundles are stored. The server creates the directory when it starts.
The path must be absolute and app-managed; filesystem roots, the user's
home directory, and relative paths are rejected at startup.

## Security Model

- Bundle file paths must be relative.
- Absolute paths, empty segments, `..` traversal, and Windows backslash
  traversal are rejected before writing.
- `SKILL.md` is always written at the bundle root; supporting files are
  written only after the path policy passes.

## Development

```bash
pnpm --filter ./mcps/skills build
pnpm test -- tests/skills-mcp-path-policy.test.ts
```
