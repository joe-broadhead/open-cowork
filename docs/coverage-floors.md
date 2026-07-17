# Coverage floors (JOE-874 / JOE-871 / JOE-867)

Authoritative ratchets live in `scripts/coverage-summary.mjs`.

| Suite | Goal | Notes |
| --- | --- | --- |
| Workspace Node | ≥60% lines long-term; current combined floor is a smoke floor | Dominated by gateway/MCP dist; raise only after measured gains |
| MCP Handlers | Raise via **in-process** pure helper tests (e.g. clock `time-math`) plus contract spawns | Dist-only LCOV is a boot smoke signal — see KNOWN LIMITATION in coverage-summary |
| Cloud client | Function coverage on domain clients via mocked `request` | Prefer sessions/channels/threads first |

## Adding coverage safely

1. Prefer pure modules imported by tests with `node:test` (no Electron).
2. For MCP: extract helpers next to handlers and test them; keep contract spawns.
3. Ratchet floors **down** never? Ratchet **up** only after `pnpm test:coverage` shows headroom.
4. Product-critical suites take CI priority over architecture meta (JOE-895).
