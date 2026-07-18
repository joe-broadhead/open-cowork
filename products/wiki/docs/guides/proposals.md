# Proposals

Proposals are the governed write path. They let contributors and agents suggest
changes without mutating canonical files immediately.

Use proposals whenever a human or agent should suggest a change that needs
review, audit history, or permission checks before it becomes canonical.

## Typical Flow

1. Create a proposal for a page, source, synthesis, or policy change.
2. Inspect detail, diff, snapshot, and validation artifacts.
3. Review the proposal as accepted, rejected, or needing changes.
4. Apply accepted proposals to the repository.
5. Commit the resulting canonical files when Git history is enabled.

Proposal artifacts are intentionally readable by humans and automation.

## CLI Examples

Create a page edit proposal:

```sh
openwiki --root ./wiki propose-edit page:concept:agent-memory --json
```

Inspect and review a proposal:

```sh
openwiki --root ./wiki proposal detail proposal:2026-05-28-001 --json
openwiki --root ./wiki proposal diff proposal:2026-05-28-001 --json
openwiki --root ./wiki proposal review proposal:2026-05-28-001 --decision accepted --rationale "Looks correct." --json
openwiki --root ./wiki proposal apply proposal:2026-05-28-001 --json
```

Create a source proposal before ingesting evidence:

```sh
openwiki --root ./wiki source propose --title "Vendor Security Note" --url https://example.com/security --json
```

## Agent Access

Agents should normally use proposal-mode tools rather than write-mode tools:

```sh
openwiki --root ./wiki mcp --stdio --tools proposal
```

For hosted agents, create a scoped proposal token and send it as a bearer token
to `/mcp`:

```sh
openwiki --root ./wiki auth token create --profile proposal-agent --expires-in-days 30
```

See [MCP And Agents](mcp-and-agents.md) for stdio and Streamable HTTP MCP setup.

## Review Semantics

- `accepted` means a reviewer approved the proposal for application.
- `rejected` records a negative decision and leaves canonical content unchanged.
- `needs_changes` keeps the proposal open for follow-up edits or supersession.

Applying a proposal reruns validation, verifies the stored base commit when Git
history is available, writes only governed target files, and records audit
events. Hosted deployments should use the write coordinator described in
[Operations](../deployment/operations.md) before running multiple writers.
