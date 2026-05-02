# Open Cowork Desktop

Electron desktop app for Open Cowork.

This workspace owns the product shell around OpenCode: the main process,
preload bridge, renderer UI, packaged resources, smoke tests, and
Electron Builder configuration. OpenCode still owns runtime execution,
sessions, permissions, MCP execution, native skills, and streaming
events.

Key paths:

- `src/main/` — Electron main process, OpenCode runtime composition, IPC
  handlers, storage, auth, automation control plane
- `src/preload/` — typed `window.coworkApi` bridge
- `src/renderer/` — React renderer and app UI
- `runtime-config/` — generated runtime instructions and runtime-facing
  defaults
- `tests/` — Electron and packaged-app smoke tests
- `resources/` — packaging icons, entitlements, and static resources

Common commands from the repo root:

```bash
pnpm dev
pnpm --dir apps/desktop test:e2e
pnpm --dir apps/desktop dist:ci:mac
pnpm --dir apps/desktop dist:ci:linux
```

Read the broader architecture in
[`docs/architecture.md`](../../docs/architecture.md).
