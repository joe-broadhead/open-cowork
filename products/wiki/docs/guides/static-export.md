# Static Export

Static export is the safest public release path for read-only knowledge bases.
It emits a browser-readable site and complete machine-readable artifacts.

```sh
openwiki --root examples/basic-wiki export static \
  --out-dir public \
  --base-url https://example.com/wiki
```

The export includes:

- HTML pages when the corpus is under the configured page ceiling
- Markdown and JSON representations for public pages
- JSONL feeds for pages, sources, claims, proposals, decisions, events, and runs
- `search-index.json` and `search-records.jsonl`
- `graph.json`, `graph-report.json`, and `agents/index.md`
- `openapi.json`
- `mcp-manifest.json`
- `llms.txt` and bounded `llms-full.txt`
- sitemap index and shards

Output paths are constrained to safe child directories inside the workspace.
Pass `--out-dir` as a workspace-relative path such as `public`, not an absolute
path. Absolute paths, traversal, reserved repository directories, and symlink
escapes are rejected before files are removed or written.
