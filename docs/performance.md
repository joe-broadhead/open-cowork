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

- `MarkdownContent.tsx` caches the rendered HTML per message id in
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

The chat transcript is **not yet** virtualized. A 10k-message thread
will render all bubbles, and each stream patch causes a re-flow.
This hasn't bitten in practice because real chats rarely cross 500
messages — but it's a known scale cliff and tracked for a follow-up.

## Main-process session eviction

`SessionEngine.maybePrune()` keeps `MAX_WARM_SESSION_DETAILS` (12)
session view states in memory, plus any session that is currently
busy or currently selected. Everything else is evicted. The session
registry on disk is the system of record; warm view state is
regenerated from disk on demand via `session-history-loader.ts`.

Consequence: memory usage stays flat even with thousands of
persisted sessions, because only a dozen are live at any moment.

## Dashboard backfill queue

`getDashboardSummary()` fast-paths up to 12 summary-missing sessions
inline, returns the partial result, and kicks off a background
drainer that processes the rest on `setImmediate` ticks with a 25ms
delay between sessions. When the drainer makes progress it emits a
`dashboard:summary-updated` IPC; the renderer listens and silently
refreshes.

This keeps the dashboard's first paint fast (a few hundred
milliseconds even on histories with hundreds of sessions) while
still ensuring every session eventually contributes to totals.

## Live session events

The dashboard and chat subscribe to `session:patch` /
`sessionUpdated` / `sessionDeleted` events with an 800ms debounce.
Bursts (a single assistant turn fires many patches) coalesce into
one refresh; intermittent events refresh within a second.

## Perf benchmark gate

`scripts/perf-benchmark.ts` runs four benchmarks that mirror the
hot paths:

| Benchmark                    | Target           | What it exercises              |
|------------------------------|------------------|--------------------------------|
| `history.project.large`      | ~0.4 ms avg      | Session history → TaskRun tree |
| `engine.hydrate.large`       | ~0.5 ms avg      | Main-process hydration         |
| `engine.view.large`          | ~0.01 ms avg     | SessionView snapshot           |
| `engine.stream.mixed`        | ~0.8 ms avg      | Mixed-event stream projection  |

`pnpm perf:check` enforces regression thresholds against
`benchmarks/perf-baseline.json` (avg 1.2×, p95 1.25×). Every PR runs
it in CI. Refresh the baseline intentionally with `pnpm perf:baseline`
when a known-good regression is accepted.

## What's NOT optimized (yet)

- **Chat transcript virtualization** — see note above.
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
