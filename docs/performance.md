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
`sessionDeleted` events with an 800ms debounce. Bursts (a single
assistant turn fires many patches) coalesce into
one refresh; intermittent events refresh within a second.

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

`pnpm perf:check` first selects the matching
`benchmarks/perf-baseline.<platform>-<arch>-node<major>.json`, then falls
back to the nearest same-platform baseline and finally to
`benchmarks/perf-baseline.json`. It enforces avg 1.2× and p95 1.25×
regression thresholds, with wider absolute floors when the runner OS,
architecture, or Node major differs from the stored baseline. Refresh the
baseline intentionally with `pnpm perf:baseline` when a known-good
regression is accepted.

## What's NOT optimized (yet)

- **Server-side chart rendering** — charts render client-side today,
  so large datasets block the renderer briefly during the initial
  paint. Server-side SVG rendering is supported via
  `chart-renderer.ts` but not plumbed as an option.
- **Session registry indexing** — 10k sessions on disk read linearly
  on every boot. Needs a lightweight index (SQLite or a sidecar
  B-tree) before the app targets long-term heavy users.

If you hit a performance issue that isn't covered here, please open
an issue with the `performance` label and attach the diagnostics
bundle (Settings → Export diagnostics).
