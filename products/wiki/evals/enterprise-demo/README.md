# Enterprise Demo Eval

This eval generates a deterministic company-style OpenWiki workspace and proves
the main product surfaces against it:

- public, internal, and private Spaces;
- pages, sources, claims, proposals, decisions, events, and runs;
- governance detector fixtures for stale claims, missing sources, broken links,
  and orphan pages;
- read-mode and proposal-mode MCP agent workflows;
- server-rendered UI smoke routes;
- static export filtering for private content;
- backup and restore.

Run it locally:

```sh
pnpm eval:enterprise-demo -- --json
```

The latest local report is written to `evals/enterprise-demo/latest.json` and is
gitignored because it includes temporary workspace paths.
