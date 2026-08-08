# @open-cowork/shared

Shared TypeScript contracts for Open Cowork.

This package owns the renderer/main-process IPC types, capability metadata
shapes, and shortcut helpers that need to be consumed from more than one
workspace package. The root entry point is environment-agnostic and contains no
Electron, filesystem, or OpenCode execution logic; Node-only helpers
(checked/atomic filesystem IO, logger, the workflow webhook server, and injected
Electron safeStorage/shell seams) live behind the separate
`@open-cowork/shared/node` entry point.

Public entry points are intentionally small:

- `@open-cowork/shared` is the browser-safe product-contract barrel.
- `@open-cowork/shared/progress-watchdog` exposes the pure, environment-agnostic
  progress vocabulary and state calculations shared by Cloud and Gateway.
- `@open-cowork/shared/ipc-security-errors` exposes the bounded IPC error
  contract without pulling in the wider barrel.
- `@open-cowork/shared/node` is the Node-only runtime substrate and must not be
  imported by browser bundles.

## Development

```bash
pnpm --filter @open-cowork/shared build
```

Keep exported types backwards-compatible unless the desktop app and docs are
updated in the same change.
