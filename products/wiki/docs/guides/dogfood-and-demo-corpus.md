# Dogfood And Demo Corpus

Use these paths before public releases to prove OpenWiki with real-feeling data
instead of hand-picked happy paths.

## Personal Wiki Dogfood

For the local transcript inbox workflow, use
[Local Transcript Inbox Dogfood](local-transcript-inbox-dogfood.md).

This path validates the owner workflow: local knowledge, local stdio MCP agents,
proposal review, manual apply, and backup/restore.

1. Create a personal wiki and local agent config:

```sh
openwiki setup personal ~/openwiki-personal \
  --title "Personal OpenWiki" \
  --agent opencode \
  --transport stdio \
  --tools proposal \
  --config-out ~/openwiki-personal/opencode.openwiki.json \
  --create-token \
  --token-out ~/openwiki-personal/.openwiki-agent-token \
  --json
```

2. Add or import initial knowledge:

```sh
openwiki --root ~/openwiki-personal source ingest \
  --title "Initial Notes" \
  --source-type manual \
  --content-file ~/notes/initial-openwiki-notes.md \
  --json
openwiki --root ~/openwiki-personal synthesize \
  --title "Personal Knowledge Index" \
  --body-file ~/notes/personal-knowledge-index.md \
  --apply \
  --json
```

3. Build local derived stores and serve the full site:

```sh
openwiki --root ~/openwiki-personal index --json
openwiki --root ~/openwiki-personal db rebuild --json
openwiki --root ~/openwiki-personal serve --host 127.0.0.1 --port 3030
```

4. Connect the local MCP agent in proposal mode. The generated config points the
   agent at stdio MCP and the generated token file. Ask the agent to search,
   read, cite sources, and propose edits rather than editing files directly.

5. Review and apply manually:

```sh
openwiki --root ~/openwiki-personal proposal list --status open --json
openwiki --root ~/openwiki-personal proposal detail proposal:... --json
openwiki --root ~/openwiki-personal proposal review proposal:... \
  --decision accepted \
  --rationale "Accurate and scoped." \
  --json
openwiki --root ~/openwiki-personal proposal apply proposal:... --commit --json
```

6. Back up and restore:

```sh
openwiki --root ~/openwiki-personal backup create --out-dir ~/openwiki-backups --json
openwiki --root ~/openwiki-personal backup verify latest --out-dir ~/openwiki-backups --json
openwiki --root ~/openwiki-personal backup restore latest \
  --out-dir ~/openwiki-backups \
  --target-root /tmp/openwiki-restore-check \
  --force \
  --json
openwiki --root /tmp/openwiki-restore-check db check --json
```

## Enterprise Demo Corpus

The deterministic enterprise corpus is designed for public demos and regression
checks. It includes:

- public, internal, and private Spaces;
- pages, sources, claims, proposals, decisions, events, and runs;
- finance, HR, executive, platform-admin, engineering, product, and support
  knowledge;
- stale-claim, missing-source, broken-link, and orphan-page governance fixtures;
- public static export sentinels and private leakage sentinels.

Generate it:

```sh
pnpm demo:enterprise -- \
  --root artifacts/enterprise-demo-wiki \
  --force \
  --with-derived \
  --with-static \
  --with-backup \
  --json
```

Serve the full site:

```sh
openwiki --root artifacts/enterprise-demo-wiki serve \
  --host 127.0.0.1 \
  --port 3030 \
  --role admin
```

Run the deterministic eval:

```sh
pnpm eval:enterprise-demo -- --json
```

The eval checks corpus shape, governance detectors, permission-filtered search
and reads, MCP read/proposal modes, UI routes, static export filtering, and
backup/restore. The local report is written to
`evals/enterprise-demo/latest.json` and is gitignored.

Run UI smoke and quality gates against the same corpus:

```sh
OPENWIKI_UI_FIXTURE=enterprise-demo pnpm test:ui
OPENWIKI_UI_FIXTURE=enterprise-demo pnpm test:ui-quality
```

Generate screenshots against the enterprise corpus:

```sh
OPENWIKI_SCREENSHOT_FIXTURE=enterprise-demo pnpm screenshots
```

The screenshots land in `artifacts/openwiki-screenshots/`. They are local
review artifacts, not committed source files.
