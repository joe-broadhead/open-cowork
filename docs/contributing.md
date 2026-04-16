# Contributing

This documentation page is a short version of the contributor guide.

For the full repository guide, see the root `CONTRIBUTING.md` file in the repository.

## Core expectations

- Keep Open Cowork as a product layer on top of OpenCode
- Prefer code/config changes over prompt-only patches
- Keep downstream customization in config and shipped content where possible
- Add focused tests when behavior changes

## Validation before merge

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm perf:check
git diff --check
```

## Docs

Docs are built with MkDocs:

```bash
python -m pip install -r docs/requirements.txt
mkdocs build --strict
```
