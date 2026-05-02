# Tests

Repo-level Node test suite for main-process logic, shared contracts,
runtime composition, OpenCode event projection, automation state, MCP
policies, and security-sensitive helpers.

Run from the repo root:

```bash
pnpm test
```

Related suites:

- `pnpm test:renderer` — Vitest/jsdom renderer component tests
- `pnpm test:e2e` — Electron smoke tests in `apps/desktop/tests/`
- `OPEN_COWORK_PACKAGED_EXECUTABLE="$(node scripts/find-macos-packaged-executable.mjs)" pnpm test:e2e:packaged` — packaged-app relaunch smoke test after a local packaged build

Add the narrowest test that proves the behavior you changed. Runtime
execution should remain OpenCode-owned; tests here should validate Open
Cowork's composition, projection, policy, and UI contracts.
