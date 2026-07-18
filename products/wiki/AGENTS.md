# AGENTS.md

Guidance for coding agents working in this repository.

## Project Shape

OpenWiki is a pnpm TypeScript monorepo. Git-backed repository files are
canonical. SQLite, Postgres, search, static export, HTTP, MCP, and web UI layers
are derived or adapter layers.

## Guardrails

- Read the relevant package before editing.
- Keep changes scoped to the active issue.
- Use fast text search such as `rg` when available.
- Use the active environment's patch/edit tool for manual file edits.
- Do not revert user changes.
- Preserve strict TypeScript and avoid type escape hatches.
- Run focused tests first, then broader validation before finalizing.

## High-Risk Areas

- Git command argument handling
- filesystem deletion/write paths
- source fetching and SSRF controls
- auth, policy, trusted headers, and browser write protection
- schema/protocol contracts
- deployment manifests and image publishing

## Useful Commands

```sh
pnpm typecheck
pnpm test
pnpm validate
python3 -m pip install -r docs/requirements.txt
mkdocs build --strict
```
