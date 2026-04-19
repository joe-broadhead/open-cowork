# Your first contribution

This page is for someone who just cloned the repo and wants to land
a small change. Five minutes end-to-end.

## Before you start

You need:

- Node `>= 22` (tracked in `.nvmrc`).
- pnpm `>= 10` (`brew install pnpm` or the pnpm install script).
- macOS or Linux. Windows isn't supported yet.

No API keys required to run the dev server. Actual LLM calls need
an OpenRouter key or another provider's credential,
entered through the in-app Settings panel.

## Clone, install, run

```bash
git clone https://github.com/joe-broadhead/open-cowork.git
cd open-cowork
pnpm install
pnpm dev
```

The Vite dev server boots, Electron wraps it, and the app opens.
HMR picks up renderer changes immediately. Main-process changes
need a full relaunch (kill `pnpm dev`, start again).

## Find something to work on

**Looking for a first issue:** the `good-first-issue` label on
the issue tracker surfaces scoped tasks that don't require deep
context. Work items tagged `help-wanted` are slightly larger but
still self-contained.

**Found a bug yourself?** Open an issue first so we can confirm the
scope before you sink time into a fix. "Reproduced on my end,
please PR" is the fastest path to a green merge.

## Run the checks before you push

```bash
pnpm typecheck    # TypeScript strict mode across all workspaces
pnpm test         # repo unit/integration test suite
pnpm lint         # ESLint + security rules + repo-specific checks
pnpm perf:check   # Regression gate against benchmarks/perf-baseline.json
```

All four run on every PR in CI, so pushing green locally saves a
round trip. If `perf:check` regresses and the regression is known-
acceptable (e.g. you added a new benchmark case), refresh the
baseline with `pnpm perf:baseline` and commit the updated JSON.

## Playwright smoke tests

End-to-end smoke tests live in `apps/desktop/tests/*.smoke.test.ts`
and run in CI via the macOS desktop job's `pnpm test:e2e` gate. They
exercise the full Electron stack — main process + renderer +
runtime — against real IPC. Locally they take ~60 seconds; skip
them during iteration and let CI catch regressions unless your
change is on a smoke-tested flow.

## Commit style

Conventional commits aren't strictly enforced but are preferred:

- `feat: ...` new user-facing behaviour
- `fix: ...` bug fix
- `chore: ...` repo hygiene
- `docs: ...` documentation only
- `refactor: ...` internal restructure, no behaviour change

Reference the issue number in the body. Keep commits focused — one
concept per commit makes review much faster. Use a
`Co-Authored-By:` trailer if pairing.

## Where to look when orienting

- [Architecture overview](architecture.md) — the ownership split
  between OpenCode and Cowork, the main-process layers.
- [Configuration](configuration.md) — how `open-cowork.config.json`
  shapes everything user-visible, including downstream overlays.
- [Downstream customization](downstream.md) — how a company forks
  the project for their own distribution.
- [Performance model](performance.md) — where the hot paths are and
  what's enforced in CI.
- [Troubleshooting](troubleshooting.md) — common issues and the
  diagnostic paths.
- [Release checklist](release-checklist.md) — what has to be true
  before tagging a release.

## Single-command release checklist

If you're landing a change that touches a release-visible surface
(build scripts, CI, changelog, docs), run through the checklist:

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm perf:check && mkdocs build --strict
```

That runs every gate that also runs on a release tag push.

## Questions

Open an issue with the `question` label, or drop a comment on an
existing issue you're touching. Quick questions on draft PRs
(`[draft]` in the title) are fine — we'd rather answer before you
invest another hour.
