# Contributing

The canonical contributor guide — scope, development setup, source layout,
product boundaries, the pull-request checklist, and the release flow — lives in
[`CONTRIBUTING.md`](https://github.com/joe-broadhead/open-cowork/blob/master/products/gateway/CONTRIBUTING.md)
at the repository root. That file is the single source of truth; this page only
collects the documentation-site commands so they are reachable from the nav.

## Docs Workflow

Install docs dependencies:

```bash
python -m pip install -r docs/requirements.txt
```

Preview locally:

```bash
mkdocs serve
```

Validate (the same strict build CI runs):

```bash
mkdocs build --strict
```

For larger changes, start with [Architecture](../concepts/architecture.md#core-domain-navigation)
and the [Architecture Handoff Map](architecture-handoff-map.md) before editing code.
