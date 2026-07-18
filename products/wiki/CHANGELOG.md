# Changelog

All notable changes to OpenWiki will be documented in this file.

## Unreleased

No changes yet.

## 0.0.0 - 2026-07-04

### Added

- MkDocs Material documentation scaffold and docs CI.
- Public release roadmap issues and release-readiness documentation.
- Docker context sentinel check for ignored/generated artifacts.
- Browser write-origin protection for hosted write-capable server routes.
- Versioned page, source, claim, proposal, comment, decision, event, run, policy,
  registry, and graph record formats.
- `team-wiki`, `basic`, `personal-wiki`, `company-wiki`,
  `public-encyclopedia`, and `github-pages` first-workspace templates.
- CLI workflows for init, search, ask, page/source/claim reads, proposals,
  decisions, policy previews, graph inspection, runs, jobs, backup/restore,
  static export, Git sync, and server startup.
- HTTP API, server-rendered web UI, OpenAPI document, MCP manifest, and MCP tool
  modes for read, proposal, and trusted write access.
- Spaces & Permissions UI with `/spaces`, compatibility `/policy` route, trusted
  identity display, and advanced admin surface.
- Local SQLite search and SQLite index-store serving layer with graph, topic,
  permission, record, and proposal projections.
- Postgres runtime schema, importer, incremental sync, queue adapter, and
  opt-in hosted read/search/queue backends.
- Static export for public HTML, JSON, JSONL, Markdown, OpenAPI, MCP manifest,
  `llms.txt`, sitemap, graph, recent changes, and bounded full-text artifacts.
- Source ingestion through local content capture, object storage, HTTP connector
  policy, GitHub/GitLab connector references, and prompt-injection warnings.
- Governance detectors for stale claims, missing sources, broken links, and
  orphan pages.
- Local job runner and worker support for lint, index rebuilds, static export,
  and source fetch runs.
- OpenCode and Open Cowork integration packs plus maintainer job harness.
- Docker, Compose, Helm, Kubernetes, Terraform, Umbrel, GitHub Pages, image
  publish, docs, Postgres, and release-readiness workflows.
- UI smoke, screenshot, UI-quality, bundle-size, operation-contract, schema,
  deployment, integration, storage, and Postgres test coverage.

### Changed

- README shortened into a public repository landing page.
- Product shell repositioned around a private team wiki: search, read, inline
  links, proposals, review history, Spaces, and agent access.
- Server navigation simplified to Home, Pages, Proposals, and Admin while graph,
  runs, policy internals, OpenAPI, MCP manifest, health, and metrics moved under
  advanced/admin paths.
- Shared audit filtering, timeline pagination, policy validation, source-fetch
  run constants, and Node SQLite type handling were consolidated to reduce
  duplicate maintenance surfaces.
- Build tooling now removes stale hashed web assets before writing the current
  manifest.
- Centralized shared OpenWiki pagination, tokenization, file-exists,
  atomic-write, and MCP manifest constants used across workspace packages.
- Tightened internal package exports and stale hardening docs found by the
  dead/stale-code audit.
- Added HTTP graceful shutdown/draining, bounded in-memory operational maps, and
  CLI process failure handlers for long-running server deployments.
- Added `.editorconfig` and `.nvmrc` developer-environment defaults.
- Extracted the shared derived-record/search-document builders into
  `@openwiki/repo` so the SQLite and Postgres store engines no longer maintain
  duplicate, drifting copies.
- Pinned `esbuild` to an exact version for byte-stable published bundles, and
  added per-package coverage floors and a Postgres-backed coverage CI job.

### Security

- Static export output directories are validated before deletion or writes.
- Docker image builds now use explicit source copy paths instead of `COPY . .`.
- Git revision arguments are validated and passed after `--end-of-options` to
  prevent option injection.
- Service-account tokens use SHA-256 hashes and timing-safe comparison.
- Trusted identity headers require a shared proxy secret.
- Source fetching validates and pins DNS answers, blocks private/metadata
  addresses, disables redirects, and keeps connector secrets out of repository
  records.
- Browser-origin write protection gates hosted form mutations.
- Helm/Kubernetes defaults run non-root with dropped capabilities, read-only root
  filesystem support, writable cache/data mounts, and resource defaults.
- Streamable HTTP MCP transport support with protocol negotiation, session
  headers, server-to-client SSE, and hosted-agent authentication docs.
- Release-readiness hardening for minimum Node version docs, Compose secrets,
  deployment image tags, Kubernetes token mounts, storage TLS, and security
  reporting channels.
- Restricted configurable Git remote URLs to `https`/`http`/`ssh` (plus scp-like
  and local paths), rejecting command-executing `ext::` transport-helper remotes
  and `file://` remotes, and hardened every Git invocation with
  `protocol.ext.allow=never`, `protocol.file.allow=user`, and
  `GIT_TERMINAL_PROMPT=0`.
- Documented the default anonymous `viewer` read posture in `SECURITY.md`.
