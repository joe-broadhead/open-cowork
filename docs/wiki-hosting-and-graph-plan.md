---
title: Wiki Hosting & Obsidian-style Graph — Detailed Plan
description: Plan to make OpenWiki hostable and shareable across teams/orgs, and to bring an Obsidian-like graph experience into the desktop Wiki surface.
---

# Wiki Hosting & Obsidian-style Graph — Detailed Plan

Status: **Draft for decision**. Covers two asks: (1) host and share the wiki
across teams and orgs; (2) make the wiki experience Obsidian-like (graph,
backlinks, wikilinks). This plan is grounded in the current codebase (verified
2026-08) and deliberately builds on what already exists instead of inventing a
parallel product.

---

## Status log

- **2026-08-07 — Phase 1 (Desktop Obsidian-lite) DELIVERED & verified.**
  - Shared types: `WikiGraph`, `WikiGraphNode`, `WikiGraphEdge`, `WikiGraphNeighbors` in
    `packages/shared/src/wiki.ts` + `CoworkAPI.wiki.graph` / `graphNeighbors`.
  - Desktop IPC: `wiki:graph` + `wiki:graph-neighbors` (shell out to the existing
    `openwiki graph edges|neighbors` CLI) in `wiki-handlers.ts`; preload channels + browser
    stub added.
  - Wiki surface (`WikiPage.tsx`): a **Browse | Graph** toggle, an interactive **canvas
    graph** (`WikiGraphView.tsx`: force layout, pan/zoom, drag, search filter, pages-only,
    fit, focus + neighbour emphasis, click-node-to-open), and a right rail with **Linked
    mentions / Outgoing links / Related** panels populated from the per-page neighborhood.
  - **Wikilinks** (`[[...]]`) rewrite to in-app anchors and open the target page
    (`rewriteWikiWikilinks` + `buildWikilinkResolver`); `MarkdownContent` gains
    `rewrite` + `onInternalWikiLink` props (unit-verified).
  - Verification: shared/app/desktop typechecks pass; `check-shared-dist` clean;
    preload-channel check clean; purity 27/27; capability-claims unchanged; E2E smoke
    (`tests/wiki-ui.smoke.test.ts`) passes (page graph + graph canvas + counters +
    backlink panels; screenshots `/tmp/wiki-view.png`, `/tmp/wiki-graph.png`). Dev app is
    live with the new Wiki UI.
  - **Next (Phase 2):** hosted wiki server packaging (OCI image + Postgres + backups +
    git service), then Phase 3 remote desktop connector.

- **2026-08-07 — Phase 2 (Hosted wiki server packaging) DELIVERED (defaults: Docker Compose + Postgres, generic OIDC/SSO via trusted header + OAuth 2.1 agent tokens, Git as source of truth).**
  - New `products/wiki/packaging/`: `Dockerfile` (one image, roles `serve`/`worker`/`cron`,
    CLI built from the monorepo lockfile; git + openssh + tini runtime),
    `entrypoint.sh` (boot: `init` → git bootstrap → `index` + `db rebuild` → Postgres
    `db migrate` → optional `backup configure local` → exec role),
    `docker-compose.yml` (postgres:16 + wiki + worker + cron; `--profile s3` MinIO
    backups; `--profile git` on-prem SSH git server), `.env.example` (origin/DB/
    identity/rate-limit/sync contract), `README.md` runbook (identity, git sync,
    backups, upgrade/rollback, scaling), `smoke-hosted-compose.mjs`, and `git-server/`
    (bare SSH repo container).
  - Docs: `docs/deployment/profiles/hosted-compose.md` (+ mkdocs nav); pnpm
    `smoke:wiki-standalone` script; root `.dockerignore` + `.gitignore` additions.
  - Verified locally (no Docker on this machine): the REAL entrypoint boot path on a
    temp wiki passes livez/readyz(200)/healthz/api + web UI HTML; `doctor --profile
    hosted` parses; `sh -n` both scripts; compose YAML parses; wiki typecheck and
    dead-code check clean; mkdocs `--strict` build passes. The Docker-gated
    `node packaging/smoke-hosted-compose.mjs --docker` will run the full compose stack
    on a machine with a Docker daemon (not yet run here).
  - Next: Phase 3 (desktop remote-wiki connector: OAuth PKCE client + single
    `WikiSource` local|remote) — hold for the user to run the Docker smoke or green-light.

- **2026-08-07 — Phase 2 (Hosted wiki server packaging) DELIVERED & verified (build-level).**
  - `products/wiki/packaging/`: Docker Compose all-in-one (+ Postgres) reference, generic OIDC
    via SSO-at-proxy + signed `x-openwiki-*` headers, OAuth 2.0 service-account tokens
    (`openwiki auth token create --scope wiki:read --scope wiki:search`), Git as source of truth.
  - `.env.example`, `Dockerfile`, `docker-compose.yml`, `smoke-hosted-compose.mjs` ready; the
    `--docker` smoke must run on a Docker host (`node products/wiki/packaging/smoke-hosted-compose.mjs --docker`).
  - Readiness endpoint requires BOTH derived stores (search index + db rebuild) before `/readyz` is 200.
- **2026-08-07 — Phase 3 (Desktop remote-wiki connector) DELIVERED & E2E-verified (token path).**
  - `apps/desktop/src/main/wiki/remote.ts`: `RemoteWikiStore` (encrypted token persistence via
    `safeStorage`, per-connection health probes, active-source state in `wiki-remote-state.json`)
    + `RemoteWikiClient` (Bearer-token reads of `/api/v1/health|records|pages|search|graph|graph-neighbors`)
    + OAuth PKCE connector (RFC 7591 dynamic client registration, loopback redirect RFC 8252,
    scope `wiki:read wiki:search`) + token connector (health-probe validated before persist).
  - `graph-mappers.ts` shared by local CLI + remote client; wiki data handlers route by the
    active source (`wiki:source-get`, `wiki:remote-list|set-active|remove|connect|connect-token`
    channels; `set-active` accepts null → local, via `optionalStringArg`).
  - UI: `WikiSourceDialog.tsx` (local row, connection rows with OAuth/Token badge + status,
    add-hosted form with origin/label/token, "Connect with OAuth (browser)" / "Connect with
    token"); `WikiPage.tsx` header source chip (Local/Remote + origin) + **Sources** action.
  - Verification: shared/app/desktop typechecks; node suite 3104 pass / 5 pre-existing
    environment-gated fails (Docker/cloud/dist builds); IPC registration 8/8; i18n 4/4;
    preload-channel check clean; **desktop smoke `wiki-remote.smoke.test.ts` PASSES**
    (spawn hosted wiki → UI token connect → remote overview/pages/graph/search → dialog
    lists connection → switch back to local). OAuth PKCE needs a real browser SSO session
    (consent page), exercised only in main-process unit tests.

## 0. Executive summary

Both asks are **largely unblocked by existing code** — the real work is
integration, packaging, org modeling, and client plumbing, not greenfield
research:

- **Obsidian-like features already exist in the OpenWiki web UI**: an
  interactive canvas graph (zoom/fit/search/legend/scope/orphans), per-page
  local graph, backlinks + related panels, and `[[wikilink]]` resolution.
  The **desktop app surface does not use any of them** (it is a bare
  list + markdown reader, and its markdown renderer does not resolve
  `[[...]]`).
- **Hosted operation already exists in OpenWiki**: Postgres + worker runtime
  (`hosted`/`enterprise` profiles), HTTP API (OpenAPI 3.1), remote MCP with
  OAuth 2.1 (ADR 0008), SSO-via-trusted-headers (ADR 0004), service accounts,
  git sync to private remotes, backups, rate limiting, write coordination.
  What is missing for "share across teams and orgs" is a **packaged,
  operator-friendly distribution**, an **org/team/member model**, a
  **desktop remote-wiki connector**, and (optionally) **real-time
  collaboration**.

Recommended shape: two tracks that share one data model.

- **Track A — Hosted wiki**: turn the existing hosted runtime into a
  deployable service (OCI image + Postgres), add org/team/member records and
  org-level roles, then connect the desktop app (and its agents) to remote
  wikis over HTTP API + OAuth MCP. Later: fold the wiki into the Open Cowork
  Cloud control plane as a tenant-scoped service.
- **Track B — Obsidian-like desktop wiki**: expose the existing graph index
  and wikilink machinery through the desktop surface — graph view, backlinks,
  related pages, clickable wikilinks — first for local wikis, then for remote.

---

## 1. Current state (verified in code, 2026-08)

### 1.1 OpenWiki (`products/wiki`, `@openwiki/*`)

**Core model**
- Git is the canonical ledger; pages, sources, claims, proposals, decisions,
  and audit events are versioned records.
- **Spaces** scope who can read / propose / review / maintain / administer
  (policy package + `spaces preview`); writes go through **proposals and
  reviews** (governance workflows).
- Search is explainable fusion over lexical + graph + semantic + governance
  signals; every statement traces to evidence (sources/claims).

**Serving layers (all read the same records)**
- Server-rendered **web UI** (`packages/web`): Pages, Proposals, Admin
  (Spaces, Service Accounts, Operations).
- **CLI** (`cowork-wiki` / `openwiki`): `setup`, `page(s)`, `search`, `ask`,
  `think`, `recall`, `propose-edit`, `proposal`, `policy`, `spaces`, `auth`,
  `agent`, `mcp`, `integrate`, `git`, `sync`, `commit`, `history`, `diff`,
  `changes`, `events`, `audit`, `inbox`, `runs`, `run`, `worker`, `service`,
  `dream`, `backup`, `export static`, `publish static`, `serve`, `doctor`.
- **HTTP API** (`packages/http-api`, OpenAPI 3.1) — same operations, plus
  graph endpoints (`/api/v1/graph/<id>/neighbors`).
- **MCP server** (`packages/mcp-server`): read / proposal / write tiers with
  per-operation policy authorization; stdio locally, Streamable HTTP when
  hosted.
- **Static export**: read-only HTML + machine-readable graph/search artifacts.

**Graph & links (already Obsidian-like, in the web UI)**
- Graph index (`@openwiki/index-store`/search per ADR 0006) materializes
  page/source/claim/topic/proposal/governance edges.
- Interactive canvas graph client (`packages/web/src/client/graph/*`): zoom,
  fit, reset, fullscreen, search, depth, node/edge legends, scope controls,
  orphan toggle, node list.
- Per-page **local graph** panel + **Backlinks** + **Related** lists
  (`http-api/src/renderers/graph.ts`).
- **Wikilinks**: `[[target]]` syntax with `resolveWikiLink` in the web
  markdown renderer; link extraction gazetteer + link-suggestion workflow.

**Hosted runtime (exists, operator-operated)**
- Runtime profiles: `local` / `team` / `hosted` / `enterprise`
  (`runtime.profile`), with Postgres-backed read/search/queue/operational
  state required for hosted/enterprise.
- Postgres write coordination, workers/queues (`@openwiki/jobs`), rate
  limiting, backup/restore, observability, operations runbooks.
- Perf harnesses: `perf:scale:10k / 100k / 1m`.

**Auth model (by design, ADRs)**
- Humans authenticate at a trusted proxy/SSO/IAP boundary; OpenWiki accepts
  trusted identity headers (shared proxy secret) — ADR 0004 (no native login).
- Remote MCP/API clients use the hosted **OAuth 2.1 provider** (PKCE, refresh,
  revocation, token introspection) with scoped policy bounds — ADR 0008.
- Service-account bearer tokens for automation.
- **Explicitly not shipped today**: a packaged hosting distribution
  ("source-operated hosted runtime"; no OCI image/helm/managed service).

### 1.2 Open Cowork (`apps/desktop`, `packages/*`, cloud)

- **Desktop** runs local workspaces or connects to a **Cloud workspace**
  (tenant-scoped control plane: sessions, events, projections, artifacts,
  workflows, settings, policy). **Gateway** is a headless channel client
  (Slack/Telegram/email/...).
- Coordination model nouns exist (projects, tasks, workflows, runs,
  schedules, watches, delegation, artifacts, questions) with workspace
  authority semantics (`product-contract.md`).
- **Wiki today is local-only in the app**:
  - `mcps/wiki` — pass-through stdio MCP launcher (newline-delimited JSON,
    no framing translation), machine-scoped custom MCP registration.
  - Desktop IPC `wiki-handlers.ts` — `wiki:overview / list-pages / read-page
    / search`, spawning the local CLI against `~/Open Wiki`; private-space
    classification from `policy/sections.json`; grants enforced by the CLI.
  - `WikiPage.tsx` — list + markdown reader; **no graph, no backlinks, no
    wikilink resolution** (desktop `MarkdownContent` does not resolve
    `[[...]]`).
  - Product posture (`docs/openwiki.md`): wiki is an optional sibling; the
    default config must NOT register a wiki MCP (purity test); users add it
    as a user-managed custom MCP.
- **The app already supports remote (HTTP) custom MCPs**
  (`CustomMcpConfig.type: 'stdio' | 'http'`, url/headers/allowPrivateNetwork)
  — so a hosted wiki can be attached as a remote MCP today, modulo OAuth
  client flow and UI.

---

## 2. Gap analysis

### 2.1 Hosted & shared across teams/orgs

| # | Gap | Evidence | Effort |
| --- | --- | --- | --- |
| G1 | No packaged, operator-friendly distribution (image/helm/managed) | README: "no packaged hosting distribution is supplied"; deployment is source-operated | M |
| G2 | No org/team/member model (invites, membership, org-level roles) | Auth maps identities (SSO/headers/tokens) but there is no org→member record or org admin UX | L |
| G3 | No real-time multi-user collaboration (git-based, diverged = manual resolve) | `sync` status model; write-coordination ops doc | L (optional in v1) |
| G4 | Desktop cannot connect to a remote wiki (IPC is local-CLI only; no OAuth client flow; no discovery) | `wiki-handlers.ts` resolves local CLI only; app never uses wiki HTTP API | M |
| G5 | Wiki not a tenant-scoped record in Open Cowork Cloud (no org wiki management in cloud web) | Cloud control plane covers sessions/artifacts, not wiki | L (later) |
| G6 | Hosted ops maturity is "evaluation" grade | `deployment/operations/*` docs, no SLA/DR story | M |

### 2.2 Obsidian-like experience (desktop surface)

| # | Gap | Evidence | Effort |
| --- | --- | --- | --- |
| G7 | No graph view in desktop | Web UI has interactive graph; desktop WikiPage has none | M |
| G8 | No backlinks / related panels in desktop | Web UI renders them; desktop doesn't | S |
| G9 | Wikilinks `[[...]]` not clickable in desktop reader | Desktop `MarkdownContent` has no `resolveWikiLink` | S |
| G10 | Local IPC lacks graph/neighbors/backlinks endpoints | Only overview/list/read/search registered | S |
| G11 | No tags/properties display, quick switcher, unlinked mentions | Not present anywhere in desktop wiki | S–M (stretch) |

---

## 3. Proposed architecture

### 3.1 Shared data & access model (both tracks)

Introduce a single **`WikiSource`** abstraction in the app that unifies
access to any wiki:

```
WikiSource
 ├─ kind: 'local'    -> existing CLI IPC path (mcps/wiki + wiki-handlers)
 └─ kind: 'remote'   -> HTTP API client (same operations + graph), OAuth 2.1
                        PKCE; optionally also a remote HTTP MCP for agents
```

- One set of shared types (`packages/shared/src/wiki.ts`, already created) —
  extend with graph/neighbor/backlink shapes.
- One IPC surface (`wiki:*`), with the handler dispatching to local CLI or
  HTTP client based on the active source. Graph operations go through the
  same source so the UI is identical for local and hosted wikis.
- Permissions stay server/CLI-side: the UI renders what the source returns;
  it never bypasses grants.

### 3.2 Track A — Hosted wiki server

**A1. Packaged distribution (closes G1, G6)**
- Add an OCI image build (mirror the Open Cowork cloud roles):
  `all-in-one`, `web`, `worker` (`cowork-wiki serve` split roles; existing
  `jobs`/`service` worker machinery).
- Postgres as the shared serving/runtime store (existing `hosted` profile),
  object storage for backups (existing backup adapters), git remote service
  on the server (bare repo host + push/pull endpoints for `sync`).
- Env-config contract + `doctor --profile hosted` gates; deploy templates
  (compose/helm reference) + runbooks; smoke/validate in CI.

**A2. Org/team/member model (closes G2)**
- New records in the ledger: `org`, `team`, `membership`, `invite`;
  org-level roles `owner / admin / editor / viewer`; map org roles onto
  per-space grants (existing `spaces` + policy engine) and onto MCP tool-mode
  tiers.
- Invite flow (link + token, expiry, audit); SSO group → org-role mapping
  (extend `deployment/identity-mapping.md`); Admin UI in the web surface
  (existing Admin) + API/CLI (`spaces`-style `org` commands).
- Human auth remains at the trusted proxy/SSO boundary (ADR 0004) — no
  native login stack; the org model consumes verified identity.

**A3. Desktop remote-wiki connector (closes G4)**
- `wiki:connect` IPC + settings record: origin, OAuth PKCE client flow
  (against the wiki OAuth 2.1 provider), scopes; store refresh token via the
  app's existing secret storage (never in `opencode.json`).
- `WikiSource.kind === 'remote'` client for read + graph over the HTTP API.
- Agents: register the hosted wiki as a **remote MCP** using the app's
  existing `type:'http'` custom-MCP support, with OAuth (verify OpenCode
  runtime MCP OAuth handling as a checkpoint).
- Discovery (stretch): org registry endpoint so the app can list "wikis
  available to you" per org.

**A4. Sync & collaboration (closes G3, partially)**
- Keep Git canonical; the hosted server is the shared remote. Desktop/CLI
  wikis `sync connect git` to the server remote; `sync now --push|--pull`
  (existing) keeps nodes moving; proposals + reviews remain the async
  multi-writer safety path (existing governance).
- v1: no OT/CRDT. Optional real-time layer (SSE events for page/proposal
  updates + presence) layered on Postgres write coordination; document
  "diverged" handling clearly.
- Desktop: surface sync state in the Wiki page header (clean/ahead/behind/
  diverged) via `sync status --json`.

**A5. Open Cowork Cloud integration (closes G5; later)**
- Wiki becomes a tenant-scoped service in the cloud control plane: org wiki
  records, management UI in cloud web, cloud-side OAuth/SSO, artifact/backup
  integration, gateway notifications for proposal reviews (stretch).

### 3.3 Track B — Obsidian-like desktop wiki

**B1. WikiPage v2 (local first, then remote; closes G7–G9, part of G10)**
- **Backlinks + Related panel** in the right rail: from graph-neighbors
  (incoming `page_link` edges → "Linked mentions"; plus related nodes).
- **Clickable wikilinks**: add `resolveWikiLink` to the desktop markdown
  renderer (resolve `[[title]]` / `[[id#section]]` / `[[title|alias]]`
  against the page index; open in-app, render unresolved as styled missing
  links).
- **Page properties/frontmatter + tags** display; breadcrumbs (space/section
  from `sections.json`); private badge (already present).

**B2. Graph view (closes G7, G10)**
- New IPC: `wiki:graph` (global or space-scoped) + `wiki:graph-neighbors`
  (per page), backed by the existing graph index (local: CLI/`@openwiki`
  graph commands; remote: HTTP API).
- New app surface: **Wiki Graph** mode in the Wiki view (route stays `wiki`;
  add a view toggle: Browse | Graph), implemented as a React canvas:
  - Port the existing web graph renderer/controls (canvas, force layout,
    zoom/fit/reset, search, node/edge legends, scope, orphans) — reuse the
    same graph JSON contract so local and remote behave identically.
  - Click node → open page; keep it dependency-light (no heavy graph libs;
    repo style prefers zero/minimal deps; the web client is already custom).
- Stretch: global graph filters by space/tag/record-type; unlinked mentions;
  quick switcher (⌘P) over the page index.

**B3. Write path stays governed** — reading and browsing are free; edits go
through proposals (existing). Optionally surface "Propose edit" from the page
later (agent-side already has propose tools).

---

## 4. Phased milestones

Each phase ends with verification gates: `pnpm typecheck`, `pnpm lint`,
`pnpm test`, targeted smoke/e2e, and (where touched) `pnpm perf:check`.
Purity contract stays: **default config never registers a wiki MCP; the wiki
remains an optional user-managed sibling** (existing tests guard this).

### Phase 0 — Decisions & foundations (0.5–1 wk)
- Ratify this plan; write ADRs for: (a) wiki source abstraction,
  (b) hosted OCI roles, (c) org/member model, (d) collaboration scope
  (async-first), (e) desktop graph approach (port web renderer).
- Baseline: run existing wiki perf (`perf:scale:10k`) + hosted doctor on
  Postgres to size Phase 2.
- Checkpoint: verify OpenCode runtime's remote-MCP OAuth handling.

### Phase 1 — Desktop Obsidian-lite, local (1.5–2.5 wks)  *(highest visible value)*
- Extend shared types + IPC: `wiki:graph`, `wiki:graph-neighbors`,
  `wiki:backlinks`, `wiki:related` (wrap local CLI/index-store; reuses graph
  index).
- WikiPage v2: right-rail Backlinks/Related, clickable wikilinks in
  `MarkdownContent`, frontmatter/tags/breadcrumbs.
- Wiki Graph mode (canvas, neighbors + global; local wikis).
- Smoke test coverage for graph + backlinks + wikilink navigation.

### Phase 2 — Hosted wiki server packaging (2–3 wks)
- OCI image (all-in-one/web/worker) + compose/helm reference; Postgres
  migration/init; object-storage backups; git remote service; env contract;
  `doctor --profile hosted` as readiness gate; CI smoke (`smoke:wiki-
  standalone` + hosted profile test with Postgres).
- Deploy runbooks + threat-model update; load test (`perf:scale:100k`).

### Phase 3 — Desktop remote connector (2–3 wks)
- `wiki:connect` (origin + OAuth PKCE, secret storage), `WikiSource` remote
  client (read/graph/search over HTTP API), remote MCP registration for
  agents, sync-state display in the Wiki header.
- Remote wiki browse + graph in desktop; e2e against a local hosted instance.

### Phase 4 — Orgs, teams, members (3–4 wks)
- Org/team/member/invite records + org-level roles + SSO group mapping;
  org admin API/CLI + web Admin UI; audit events; invite UX.
- Desktop: org wiki discovery + "join org wiki" flow.

### Phase 5 — Collaboration & cloud integration (4–6 wks)
- Optional real-time: SSE page/proposal events + presence; diverged-handling
  UX; proposal review notifications.
- Open Cowork Cloud: wiki as tenant-scoped service, cloud web management UI,
  gateway notifications for reviews (stretch), backups/DR story.

### Phase 6 — Hardening & release (2–3 wks)
- Scale benchmarks (10k/100k/1m), security review (threat model, OAuth,
  git service), rate limiting tune, observability dashboards, docs
  (`docs/wiki-hosting-and-graph-plan.md` → operational guides), release
  packaging (`wiki@v*`).

---

## 5. Key design decisions (recommendations)

| # | Decision | Recommendation | Rationale |
| --- | --- | --- | --- |
| D1 | Ledger | Keep Git canonical; Postgres is derived serving (ADR 0005/0006) | Already decided and working |
| D2 | Hosting shape | Self-hosted wiki server first (Phase 2), then Open Cowork Cloud managed (Phase 5) | Fastest path; reuses existing hosted runtime |
| D3 | Real-time editing | v1 = async (git sync + proposals); SSE presence later; no OT/CRDT | Matches existing governance; low risk |
| D4 | Identity | SSO/OIDC at proxy (ADR 0004) + OAuth 2.1 for API/MCP (ADR 0008); org model consumes verified identity | Already decided; no native login |
| D5 | Graph | Reuse graph index + port web canvas renderer into React; one graph JSON contract for local/remote | Zero new data model; consistent UX |
| D6 | Desktop access | Single `WikiSource` abstraction (local CLI \| remote HTTP) | One UI, both hosting modes |
| D7 | Writes | UI read-only in v1; edits via proposals | Reuses governance; safety |

## 6. Open questions for decision

1. **Hosting target** — self-hosted wiki server only, managed inside Open
   Cowork Cloud, or both (staged)? (Recommend both, staged.)
2. **Identity** — which SSO/OIDC provider(s) must work first (Google, Entra,
   Okta, Keycloak, generic OIDC)? Or start with open-cowork cloud accounts?
3. **Real-time collaboration** — is async (git + proposals) acceptable for
   v1, or is collaborative live editing a launch requirement?
4. **Graph priority** — local-first Obsidian-lite (Phase 1) before any hosted
   work, or hosted server first?
5. **Scale** — target page counts, team sizes, and concurrent writers
   (drives Postgres sizing, worker counts, caching).
6. **Write UX** — keep the desktop wiki surface read-only with proposals as
   the edit path, or add in-app "propose edit" affordances early?
7. **Branding** — keep "OpenWiki"/`cowork-wiki` as the product name, or fold
   into the Open Cowork "Wiki" surface branding (docs already call it Wiki)?
8. **Graph fidelity** — port the existing web graph renderer as-is vs a
   lighter first version (neighbors-only local graph) in Phase 1?

## 7. Risks & mitigations

- **OpenCode remote-MCP OAuth** (checkpoint in Phase 0): if the runtime does
  not drive OAuth for remote MCPs, fall back to scoped service-account tokens
  (existing) or a long-lived header config until verified.
- **Git diverged UX**: mitigation = clear sync-status UI + proposals-first
  write path; document conflict resolution (existing docs).
- **Purity/claims tests**: every new surface must keep manifest-driven
  catalog counts stable; wiki stays `availability:'always'`, `featureKey:null`
  unless a product decision says otherwise.
- **Secret handling**: OAuth tokens in app secret storage, never in
  `opencode.json` or git.
- **Graph perf at scale**: leverage existing 10k/100k/1m benchmarks; make
  graph APIs paginated/neighborhood-scoped (already neighbor-based).
