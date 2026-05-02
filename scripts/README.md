# Scripts

Repository automation scripts for release, packaging, documentation,
notices, performance, and CI support.

Most scripts are called through `package.json` commands or GitHub
Actions. Prefer the package scripts where available so local and CI
behavior stay aligned:

```bash
pnpm lint
pnpm perf:check
pnpm notices
pnpm --dir apps/desktop dist:ci
```

Release-sensitive scripts should stay deterministic, avoid network calls
unless the caller clearly expects them, and produce actionable errors for
CI logs.
