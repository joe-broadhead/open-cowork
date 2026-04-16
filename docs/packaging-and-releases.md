# Packaging and Releases

## Packaging targets

Open Cowork packages desktop artifacts with Electron Builder.

Current release targets:

### macOS

- `.zip`
- `.dmg`
- `x64`
- `arm64`

### Linux

- `.AppImage`
- `.deb`
- `x64`

## Local packaging

From the repository root:

```bash
pnpm --dir apps/desktop dist:ci:mac
pnpm --dir apps/desktop dist:ci:linux
```

Artifacts are written to:

```text
apps/desktop/release/
```

## CI workflow

The repository includes:

- `ci.yml`
  - lint
  - tests
  - typecheck
  - perf gate
  - docs build

- `docs.yml`
  - builds and deploys MkDocs documentation

- `release.yml`
  - builds release artifacts for macOS and Linux
  - uploads workflow artifacts on manual runs
  - creates GitHub Releases automatically for version tags

## Release flow

Recommended release flow:

1. Merge validated changes to `main`
2. Create and push a version tag like `v0.2.0`
3. Let `release.yml` build platform artifacts
4. GitHub Release is created automatically with attached binaries

## Signing and notarization

The upstream workflow currently builds unsigned artifacts by default.

That is acceptable for:
- internal testing
- development builds
- downstream customization work

For public production distribution, downstream maintainers should add:
- macOS code signing
- macOS notarization
- any Linux package signing they require

## Notes

The packaged app bundles:
- the desktop renderer and main/preload code
- Open Cowork config and schema
- bundled skills
- bundled MCP packages
- the OpenCode CLI/runtime dependency needed by the desktop app
