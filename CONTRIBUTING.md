# Contributing to Open Cowork

Thanks for contributing.

## Project philosophy

Open Cowork is a product layer on top of OpenCode.

That means contributions should preserve this split:
- OpenCode owns execution, sessions, MCP calls, approvals, and agent runtime behavior.
- Open Cowork owns composition, configuration, UI, packaging, and product ergonomics.

Good changes usually make Open Cowork:
- thinner
- clearer
- more configurable
- more testable

Bad changes usually:
- duplicate OpenCode runtime behavior
- add prompt-only behavior where code/config should be the source of truth
- hardcode downstream assumptions into the upstream app

## Development setup

Requirements:
- Node `>=22`
- pnpm `>=10`
- Python `>=3.11` for docs work

Install:

```bash
pnpm install
```

## Common commands

Validate the repo:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm perf:check
```

Run the desktop app in development:

```bash
pnpm dev
```

## Tooling overview

- **TypeScript** `strict` mode across all packages (see `tsconfig.base.json`).
- **ESLint** with `@typescript-eslint`, `eslint-plugin-security`, and
  `eslint-plugin-no-unsanitized` for the renderer. Config lives in
  `eslint.config.mjs`. `pnpm lint` runs ESLint (`--max-warnings 0`)
  followed by `scripts/lint.mjs` for repo-specific checks (trailing
  whitespace, tabs, final newlines).
- **Tests** run with Node's built-in runner via
  `--experimental-strip-types`. No Jest / Vitest dependency.
- **Perf gate**: `scripts/perf-benchmark.ts` compares against
  `benchmarks/perf-baseline.json`. Refresh the baseline intentionally
  with `pnpm perf:baseline` after major environment or workload changes.
- **Dependabot** is configured for monthly npm and GitHub Actions
  updates (`.github/dependabot.yml`) so maintenance lands in deliberate,
  reviewable batches instead of a constant stream of tiny PRs.
- **EditorConfig** is present at the repo root for consistent
  indentation and line endings across editors.

Build the app:

```bash
pnpm build
pnpm --dir apps/desktop dist:ci:mac
pnpm --dir apps/desktop dist:ci:linux
```

Build docs:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```

## Contribution guidelines

### 1. Prefer code and config over prompt patches

If runtime behavior changes, prefer:
- code
- configuration
- generated agent config

Do not patch prompt text alone when the real source of truth belongs in code.

### 2. Keep the main runtime model aligned with OpenCode

Custom MCPs, skills, and agents should stay OpenCode-native in shape.

Avoid inventing parallel runtime abstractions unless there is a strong product reason.

### 3. Keep public-repo quality high

Before opening a PR or checkpointing a large change, run:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm perf:check
git diff --check
```

### 4. Document non-obvious changes

Update docs when you change:
- configuration shape
- packaging or release behavior
- contributor workflow
- user-facing desktop behavior

### 5. Add focused tests

Prefer tests around:
- main-process helpers
- runtime composition
- event projection
- IPC behavior
- renderer utility seams

## Pull requests

Good pull requests are:
- small enough to review
- explicit about why a change exists
- backed by tests where behavior changed
- clear about user-visible impact

Include:
- what changed
- why it changed
- how it was validated
- any remaining caveats

## Public release checklist

Before cutting a public release:
- CI is green
- docs build cleanly
- release workflow succeeds
- packaged app launches cleanly
- no debug-only config or local paths leaked into docs or UI

## Questions

If a change feels like it is turning Open Cowork into a second runtime instead of a product layer over OpenCode, stop and simplify first.
