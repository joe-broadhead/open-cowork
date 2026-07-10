# Performance model

One page on how Open Cowork keeps the chat responsive and the app
quick under scale. The short version: avoid re-parsing markdown on
every stream patch, virtualize long lists, keep main-process state
pruned, and enforce the whole thing with a CI perf gate.

## Markdown patching without re-parsing

Chat messages stream character-by-character while the model responds.
Naïvely, each patch would re-run the markdown parser + `rehype` +
`DOMPurify` pipeline over the full message — O(total message length)
per patch, O(n²) for the full render. That falls over at ~2k tokens.

Instead:

- `packages/app/src/components/chat/MarkdownContent.tsx`
  caches the rendered HTML per message id in
  an LRU of size 200.
- New patches render the **append** into the existing DOM via
  `morphdom`, which diffs the old and new HTML and patches only the
  changed subtree.
- The cached HTML is reused on re-mount (sidebar tab switch, thread
  reload) so there's zero re-parse for past messages.

Net: streaming stays at a flat ~1ms/patch regardless of message
size, and cached messages render instantly.

## Sidebar virtualization

The thread list uses `@tanstack/react-virtual` above a 50-row
threshold. Below it, plain rendering is a wash — the DOM cost is
negligible at small sizes and virtualization adds measurement
overhead.

At 500+ threads:
- Only rows in view + an 8-row overscan are in the DOM.
- Scroll is O(visible) not O(total).
- Active-thread changes still scroll into view via the virtualizer's
  `scrollToIndex` API, preserving the one-click-lands-active-thread
  UX.

The chat transcript also uses `@tanstack/react-virtual` above an
80-item threshold. Short threads stay on the plain DOM path because the
mount cost is low and simpler scrolling feels better. Long threads keep
only visible timeline rows plus overscan mounted, and active task /
approval jumps route through the virtualizer so drill-ins still land on
the right row.

## Chat transcript virtualization

Long chat transcripts use the same virtualizer strategy as the sidebar:
timeline rows are keyed by session-view item id, measured after mount,
and kept to visible rows plus overscan. The virtualizer is disabled for
short transcripts so common small chats avoid absolute-positioned rows
and keep simple native scroll behavior.

Because assistant messages can grow while streaming, row measurement is
allowed to settle after each patch. That keeps active approval jumps,
task drill-ins, and scroll-to-bottom behavior stable while avoiding a
10k-message DOM cliff.

## List virtualization audit

Every long, unbounded renderer list is either virtualized or bounded at
the source:

| List | Where | Strategy |
|------|-------|----------|
| Sidebar threads / sessions | `ThreadList.tsx` | Virtualized above 50 rows |
| Chat transcript | `ChatView.tsx` | Virtualized above 80 items |
| Audit log | `admin/AuditSection.tsx` | Virtualized above 60 rows (accumulates via "Load more") |
| Members / roles / policies | `admin/*Section.tsx` | Server-bounded admin tables |
| Artifacts | `ui/ArtifactsLibrarySurface.tsx` | Server index capped at 200 with a truncated flag |
| Channels agents/bindings/people | `studio/StudioUtilityPages.tsx` | Server `limit` (100–500) |
| Capabilities tools / skills | `capabilities/CapabilitiesPage.tsx` | Bounded by the installed catalog |

The audit log is the one list that grows unboundedly on the client — each
"Load more" appends another 50-row server page onto the DOM — so it uses
the same `@tanstack/react-virtual` window as the sidebar and transcript
above a 60-row threshold, rendered as an ARIA grid so tabular semantics
survive the absolute positioning. Below the threshold it stays a plain
semantic `<table>` because the DOM cost is negligible.

## Main-process session eviction

`SessionEngine.maybePrune()` keeps `MAX_WARM_SESSION_DETAILS` (12)
session view states in memory, plus any session that is currently
busy or currently selected. Everything else is evicted. The session
registry on disk is the system of record; warm view state is
regenerated from disk on demand via `session-history-loader.ts`.

Consequence: memory usage stays flat even with thousands of
persisted sessions, because only a dozen are live at any moment.

## Live session events

Chat subscribes to `session:patch` / `sessionUpdated` /
`sessionDeleted` events. Streamed `session:patch` text is buffered and
flushed on an animation frame at a minimum `STREAM_FLUSH_INTERVAL_MS`
(~32ms) interval, while certain patches commit immediately. Bursts (a
single assistant turn fires many patches) coalesce into frame-aligned
refreshes rather than an 800ms debounce.

## Cloud API query guardrails

Cloud control-plane APIs must stay cursor-paginated, indexed, and bounded.
Routes should validate/authenticate/parse, then delegate to stores or services
that own the exact query shape.

Current production rules:

- session list APIs use cursor pagination and clamp page size to 500 rows
- unbounded tenant/user lists are compatibility helpers, not public scaling
  APIs
- session event replay and workspace event replay use monotonic sequence
  cursors
- worker claim loops, scheduler due-run claims, command claims, and gateway
  delivery claims use bounded batches and `FOR UPDATE SKIP LOCKED`
- Postgres indexes must match hot predicates for session cursors, event
  replay, command availability/runnable scans, workflow claims, channel
  deliveries, usage events, worker pools, managed workers, and heartbeats
- claim loops scale from queue age, claim latency, and bounded backlog estimates
  rather than CPU alone; hot claim paths must not run full-table counts just to
  emit queue-depth metrics

Text `query` search in cloud session lists is a beta convenience filter. It is
bounded by tenant/user scope and page size, but it is not yet the large-org
search path. Large searchable thread history belongs in the thread index and
smart-filter surfaces, not in a full scan over every cloud session row.

Static guardrails in `tests/cloud-modularity-boundaries.test.ts` assert the
required Postgres index names and key SQL snippets. Real Postgres concurrency
tests protect lease, claim, workflow, and stale-owner behavior where database
semantics matter.

## Perf benchmark gate

`scripts/perf-benchmark.ts` runs benchmarks that mirror the hot paths:

| Benchmark | Approximate target | What it exercises |
|------------|--------------------|-------------------|
| `history.project.large` | sub-2 ms avg | Session history → TaskRun tree |
| `engine.hydrate.large` | sub-1 ms avg | Main-process hydration |
| `engine.view.large` | sub-0.5 ms avg | Cached `SessionView` snapshot reads |
| `engine.stream.mixed` | sub-2 ms avg | Mixed-event stream projection |
| `runtime.permission.downstreamCatalog` | sub-0.1 ms avg | Runtime permission generation for a large downstream catalog |
| `agents.catalog.downstreamCatalog` | sub-0.5 ms avg | OpenCode-native agent config generation for a large downstream catalog |
| `capabilities.map.downstreamCatalog` | sub-3 ms avg | Tools & Skills capability-map grouping |
| `catalog.relationship.downstreamCatalog` | sub-1 ms avg | Custom agent / tool / skill relationship summarization |
| `agents.preview.downstreamCatalog` | sub-0.1 ms avg | Agent-builder preview compilation |
| `threads.search.downstreamHistory` | platform baseline | SQLite-backed thread search and facets over 5,000 seeded threads |
| `launchpad.feed.syntheticScale` | platform baseline | Launchpad feed assembly over synthetic projects, tasks, waiting interactions, and artifacts |
| `artifacts.localIndex.writeScale` | platform baseline | Local artifact index write path over hundreds of artifacts and task provenance records |
| `workflows.recentRuns.batchScale` | platform baseline | Batched workflow recent-run listing across many workflows with deep run history |
| `cloud.launchpadSummaries.queryScale` | platform baseline | Cloud launchpad summary list path over a large pending-work index |
| `cloud.artifactIndex.queryScale` | platform baseline | Cloud artifact index filtering by project/task and updated-time ordering |

`pnpm perf:check` first selects the matching
`benchmarks/perf-baseline.<platform>-<arch>-node<major>.json`, then falls
back to the nearest same-platform baseline and finally to
`benchmarks/perf-baseline.json`. It enforces avg 1.2× and p95 1.25×
regression thresholds, with wider absolute floors when the runner OS,
architecture, or Node major differs from the stored baseline. Refresh the
baseline intentionally with `pnpm perf:baseline` when a known-good
regression is accepted.

## Enforced budgets

Discipline only holds if it's a CI gate. Three budgets fail the build on
regression so "blazing fast & non-bloated" stays true (issue #900):

### Startup budget

Startup-to-interactive is gated from both ends:

- **Renderer side (parse/eval bytes):** the gzipped eager startup graph
  the browser fetches on first load. `scripts/check-bundle-size.mjs`
  walks the `browser.html` entry's static-import closure plus its single
  bootstrap dynamic import and sums the gzipped bytes. Budget: **220 KB**
  (current ~216 KB). Lazy route views and chart/diagram vendors are
  excluded — they load on demand and must not count against startup.
- **Main-process side (init to first interactive session):**
  `tests/startup-budget.test.ts` measures a fresh `SessionEngine`
  hydrating a realistic session from projected history and producing the
  first `getSessionView()` — the work the main process must finish before
  the renderer can paint an interactive transcript. It gates the median
  sample against a **12 ms** absolute ceiling (~40× current headroom): it
  never flakes on slow CI, but a catastrophic regression (an accidental
  `O(n²)` hydrate turning a sub-millisecond path into tens of ms) fails
  hard.

### Per-route bundle budgets

Each lazily-loaded feature page has its own gzipped budget in
`scripts/check-bundle-size.mjs` so no single route can balloon on demand:

| Route chunk | Budget | Current |
|-------------|--------|---------|
| `ChatView` | 47 KB | ~42.6 KB |
| `CapabilitiesPage` | 28 KB | ~25.3 KB |
| `AgentsPage` | 27 KB | ~24.3 KB |
| `SettingsPanel` | 21 KB | ~18.7 KB |
| `StudioUtilityPages` (artifacts/approvals/channels) | 15 KB | ~12.9 KB |
| `AdminPage` | 13 KB | ~11.1 KB |
| `KnowledgePage` | 10 KB | ~8.0 KB |

The heavyweight lazy chart/diagram vendors (`vega`, `cytoscape`, `katex`)
also carry generous ceilings that catch gross bloat — a duplicated copy
or a version that doubles the engine — without tripping on routine
dependabot patch bumps.

All three checks run under `tests/bundle-size-budget.test.ts`
(`pnpm check:bundle-size` locally), which is part of `pnpm test` in CI.
Set budgets just above the measured size and ratchet them **down** as
things shrink; only raise a budget with a note explaining the growth.

### Memory ceiling

`tests/session-engine.test.ts` soaks the main-process growth path — 2,000
session activations with interleaved view materialization — and asserts
the hydrated set stays at a hard ceiling of `MAX_WARM_SESSION_DETAILS + 1`
(the warm budget plus the active session), regardless of how many sessions
were ever activated. That proves main-process session memory is
`O(budget)`, not `O(sessions-ever-seen)`; the view cache is pruned in
lockstep because `maybePrune()` drops materialized views for any session
that leaves the warm set.

## What's NOT optimized (yet)

- **Server-side chart rendering** — charts render client-side today,
  so large datasets block the renderer briefly during the initial
  paint. A main-process `chart:render-svg` IPC (`chart-renderer.ts`)
  already exists and backs the sandboxed render path; what is not yet
  optimized is defaulting large-dataset display to server-side
  rendering.
- **Session registry indexing** — 10k sessions on disk read linearly
  on every boot. Needs a lightweight index (SQLite or a sidecar
  B-tree) before the app targets long-term heavy users.
- **Per-org concurrency-counter write ceiling** — cloud concurrency
  quotas are kept in `cloud_concurrency_counters` as one row per
  `(org, counter_key)`, giving O(1) quota reads. The write side is a
  deliberate tradeoff: transactions that change an org's active count
  serialize on that single row's lock until commit. The trigger only
  fires on genuine active-count transitions (queued/running boundary
  crossings), and each update is sub-millisecond, so this is a
  per-**org** write-throughput ceiling, not a cross-org or read
  concern. **Threshold:** it only matters when a *single* org sustains
  roughly thousands of active-count transitions per second (many
  hundreds of concurrent sessions/commands churning at once); typical
  multi-org load never approaches it because contention is per-org.
  **Mitigation when hit:** shard the counter into
  `(org, counter_key, bucket)` with the bucket chosen by
  `hash(session_id) % N` and `SUM` the buckets on read (the read stays
  O(N buckets)), or move that org to a batched/approximate gauge. The
  trigger and read paths are the only sites that change.

If you hit a performance issue that isn't covered here, please open
an issue with the `performance` label and attach the diagnostics
bundle (Settings → Export diagnostics).
