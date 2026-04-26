# @open-cowork/shared

Shared TypeScript contracts for Open Cowork.

This package owns the renderer/main-process IPC types, capability metadata
shapes, and shortcut helpers that need to be consumed from more than one
workspace package. It intentionally does not contain Electron runtime logic,
filesystem access, or OpenCode execution behavior.

## Development

```bash
pnpm --filter @open-cowork/shared build
```

Keep exported types backwards-compatible unless the desktop app and docs are
updated in the same change.
