# CLI Static Export

## 14. CLI Adapter

The CLI wraps the same operations as MCP and HTTP.

Required commands:

```text
openwiki init <path> --template team-wiki|basic|personal-wiki|company-wiki|public-encyclopedia|github-pages
openwiki index
openwiki search <query> --persona <persona> --type <record-type> --mode lexical|hybrid --fuzzy --offset <n> --highlights --json
openwiki page read <id> --json
openwiki source read <id> --json
openwiki source content <id> --max-bytes <bytes> --json
openwiki source ingest --title <title> --json
openwiki source propose --title <title> --url <url> --json
openwiki source fetch --title <title> --url <url> --connector <id> --credential-ref <ref> --enqueue --json
openwiki source fetch --title <title> --connector-kind github --connector <id> --credential-ref <ref> --github-owner <owner> --github-repo <repo> --source-path <path> --ref <ref> --enqueue --json
openwiki source fetch --title <title> --connector-kind gitlab --connector <id> --credential-ref <ref> --gitlab-project <group/project> --source-path <path> --ref <ref> --enqueue --json
openwiki claim read <id> --json
openwiki claim trace <id> --json
openwiki decision read <id> --json
openwiki topics --json
openwiki questions --json
openwiki graph report --json
openwiki history <id> --json
openwiki diff <id> --from <ref> --to <ref> --json
openwiki changes --json
openwiki git status --json
openwiki git pull --remote <remote> --branch <branch> --json
openwiki git push --remote <remote> --branch <branch> --json
openwiki commit --message <message> --all|--path <path> --json
openwiki events --json
openwiki runs --json
openwiki run index|export|lint --enqueue --json
openwiki run index|export|lint --json
openwiki worker --once --json
openwiki ask <question> --citations --json
openwiki propose-edit <page-id> --json
openwiki synthesize --title <title> --body-file <path> --json
openwiki synthesize --title <title> --body-file <path> --apply --json
openwiki proposal list --status open --json
openwiki proposal detail <proposal-id> --json
openwiki proposal diff <proposal-id> --json
openwiki proposal snapshot <proposal-id> --json
openwiki proposal validation <proposal-id> --json
openwiki proposal comment <proposal-id> --body-file <path> --json
openwiki proposal review <proposal-id> --json
openwiki proposal apply <proposal-id> --json
openwiki integrate opencode
openwiki serve --role <role>|--scope <scope>|--token-env <env>|--token-file <path>
openwiki mcp --stdio --tools read|proposal|write
openwiki export static
openwiki publish static --json
```

CLI JSON output MUST match the corresponding operation response schema.

## 15. Static Export

Every build SHOULD emit a machine-readable static export.

```text
public/
  index.html
  search-index.json
  search-records.jsonl
  pages.jsonl
  sources.jsonl
  claims.jsonl
  proposals.jsonl
  proposal-comments.jsonl
  proposals.json
  decisions.jsonl
  decisions.json
  events.jsonl
  runs.jsonl
  recent-changes.json
  events.json
  runs.json
  topics.json
  open-questions.json
  graph.json
  graph-report.json
  graph-report.html
  agents/index.md
  llms.txt
  llms-full.txt
  sitemap.xml
  openapi.json
  mcp-manifest.json
  concepts/agent-memory.md
  concepts/agent-memory.json
  sources/2026-05-21-001.json
  claims/2026-05-21-001.json
  proposals/2026-05-21-001.json
  decisions/2026-05-21-001.json
```

Static export supports:

- read/search through generated site assets
- agent crawling through JSONL and `llms.txt`
- public wiki hosting through GitHub Pages or equivalent
- edit suggestions through Issues, PRs, or external proposal services

GitHub-hosted repositories SHOULD provide workflow entry points for:

- building static site artifacts
- running deterministic OpenWiki lint
- collecting proposal review artifacts such as detail, diff, snapshot, and
  validation report JSON

Static export does not support live write operations by itself.

The `wiki.publish` operation wraps static export as a governed workflow: it
generates the site, records `publish.completed`, regenerates the derived export
so event artifacts and public search records include the publish event, and then
returns the file list plus event record.

`search-index.json` SHOULD be generated from the same logical record builder as
the runtime search index. It MAY omit private source fragments and raw event
metadata in public exports, but it SHOULD preserve searchable public text,
canonical IDs, URIs, citations/source IDs, and record types. `search-records.jsonl`
SHOULD contain the same records in line-oriented form for static agents and
simple shell tools.
