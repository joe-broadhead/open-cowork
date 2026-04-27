# Contributing

Open Cowork is a product layer on top of OpenCode. Contributions should
preserve that split: OpenCode owns execution, sessions, MCP calls,
approvals, and agent runtime behavior; Open Cowork owns composition,
configuration, UI, packaging, and product ergonomics.

## Setup

Requirements:

- Node `>=22`
- pnpm `>=10`
- Python `>=3.11` for docs work

Install dependencies:

```bash
pnpm install
```

Run the desktop app:

```bash
pnpm dev
```

## Validation

Before opening a pull request, run the relevant subset of:

```bash
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm perf:check
git diff --check
```

Build docs with:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```

## Pull Requests

The repository uses a single `master` line. Create a short-lived branch
for each change, open a pull request back to `master`, and keep the
branch focused enough that it can be squash-merged or rebased cleanly.

Good pull requests explain:

- what changed
- why it changed
- how it was validated
- any remaining caveats

The full contributor guide also lives at the repository root:
[`CONTRIBUTING.md`](https://github.com/joe-broadhead/open-cowork/blob/master/CONTRIBUTING.md).
