# @open-cowork/shared

Shared TypeScript contracts for Open Cowork.

This package owns the renderer/main-process IPC types, capability metadata
shapes, and shortcut helpers that need to be consumed from more than one
workspace package. The root entry point is environment-agnostic and contains no
Electron, filesystem, or OpenCode execution logic; Node-only helpers
(checked/atomic filesystem IO, logger, the workflow webhook server, and injected
Electron safeStorage/shell seams) live behind the separate
`@open-cowork/shared/node` entry point.

## Development

```bash
pnpm --filter @open-cowork/shared build
```

Keep exported types backwards-compatible unless the desktop app and docs are
updated in the same change.
