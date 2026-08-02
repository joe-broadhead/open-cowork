# Command Inventory

The generated [CLI Reference](cli.md) is authoritative. This page groups the
stable product surfaces by user value.

| Value | CLI surface | Other interfaces |
| --- | --- | --- |
| Install diagnostics | `version`, `self-check`, `doctor` | n/a |
| Create and browse knowledge | `setup`, `init`, `page`, `pages`, `search`, `ask`, `think`, `recall` | Web, HTTP, MCP |
| Govern changes | `propose-edit`, `proposal`, `policy`, `spaces`, `auth` | Web, HTTP, MCP |
| Agent composition | `agent`, `mcp`, `integrate` | stdio and Streamable HTTP MCP |
| Canonical history | `git`, `sync`, `commit`, `history`, `diff`, `changes`, `events`, `audit` | HTTP |
| Automation | `inbox`, `runs`, `run`, `worker`, `service`, `dream` | HTTP, MCP |
| Recovery | `backup` | HTTP |
| Public read-only output | `export static`, `publish static` | Static artifacts |
| Source-operated runtime | `serve`, `doctor --profile hosted` | Web, HTTP, MCP |

The CLI intentionally has no registry self-update command or platform
provisioning command. Install a known GitHub release tarball explicitly and use
runtime diagnostics plus operator-owned infrastructure checks.
