# Tests

Repo-level Node test suite for main-process logic, shared contracts,
runtime composition, OpenCode event projection, workflow state, MCP
policies, and security-sensitive helpers.

Run from the repo root:

```bash
pnpm test
```

Related suites:

- `pnpm test:renderer` — Vitest/jsdom renderer component tests
- `pnpm test:e2e` — Electron smoke tests in `apps/desktop/tests/`; each file gets one explicit retry before the command fails
- `OPEN_COWORK_PACKAGED_EXECUTABLE="$(node scripts/find-macos-packaged-executable.mjs)" pnpm test:e2e:packaged` — release-grade packaged-app relaunch smoke test after a local packaged build; the command fails before discovery when the executable is missing or invalid
- `pnpm test:e2e:packaged:optional` — broad packaged-test discovery path that keeps file-level skips when no packaged executable is available; do not use this as a release gate

Add the narrowest test that proves the behavior you changed. Runtime
execution should remain OpenCode-owned; tests here should validate Open
Cowork's composition, projection, policy, and UI contracts.
