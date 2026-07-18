# Search Permission Evals

This corpus validates that OpenWiki search and adjacent read paths do not leak private company knowledge across common enterprise sections.

Sections covered:

- Public
- HR
- Finance
- Engineering
- Admin
- Private Executive

The corpus is intentionally small and deterministic. Each page has a unique sentinel term plus the shared `openwiki-enterprise-permission-sentinel` term. Tests materialize the corpus into a real Git-backed OpenWiki workspace and assert that search, ask, graph, source reads, proposal queues, and policy preview only return records visible to each subject.

Run from the repo root:

```sh
pnpm test -- tests/search-permissions.test.ts
```

This is the baseline for future generated corpora at 10k, 100k, and 1M pages. Generated suites should preserve the same invariants: permission prefiltering before fusion, denial-safe graph traversal, no hidden titles in results, and proposal visibility derived from target paths.
