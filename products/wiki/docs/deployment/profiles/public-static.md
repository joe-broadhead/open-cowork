# public-static

Use this for public read-only publishing with no server write surface.

## Quickstart

```sh
openwiki --root ./wiki index
openwiki --root ./wiki export static --out-dir public --base-url https://example.com
```

Publish `public/` to GitHub Pages or any static host.

## Preflight

```sh
openwiki --root ./wiki deploy preflight \
  --deploy-profile public-static \
  --public-origin https://example.com \
  --out-dir public
```

## Security Notes

- Static export has no authenticated server and no server-side writes.
- Publish only paths intended for public readers.
- Use hosted server profiles for permission-filtered private search or proposal
  workflows.

## Readiness Checks

```sh
test -f public/index.html
test -f public/search-index.json
test -f public/graph.json
test -f public/graph-report.json
test -f public/agents/index.md
test -f public/static-export-report.json
```

## Backup And Restore

Back up the source Git repository, not just generated static files. Regenerate
the site from Git after restore.

## Rollback

Roll back the source Git repository to the previous published commit and rerun
static export. For GitHub Pages, redeploy the last known-good artifact or rerun
the static workflow at the previous commit. Do not edit generated static files
as the source of truth.

## MCP

Static hosts do not run MCP. Point agents at the machine or CI job that owns the
source checkout, or publish machine-readable static artifacts for read-only
retrieval.
