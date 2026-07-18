# ADR: Deferred engineering, gated on need (issue #199)

- **Status:** Accepted
- **Date:** 2026-07-08
- **Issue:** [#199 — Deferred engineering (gated on need)](https://github.com/joe-broadhead/opencode-gateway/issues/199)
- **Parent roadmap:** [#200](https://github.com/joe-broadhead/opencode-gateway/issues/200)

## Context

Three engineering items were bracketed by the world-class-gap audit as
**do-only-when-a-product-goal-needs-them**, not speculatively. Building ahead of
need is exactly the "process theater" a prior audit removed, so each item is held
until its gate is demonstrably met. This record fixes, for each item, the gate,
whether it is met today, the evidence behind that call, and the concrete trigger
that would flip a deferred item to "do".

The strongest evidence available is real usage, not a scenario:
[the 25-day dogfood case study](../history/dogfood-case-study.md). A single
operator's live instance after ~25 days of delegated work: 7 Initiatives,
19 Issues, **156 agent runs**, a **270 MB** `gateway.db` with ~13,400 workflow
events and ~305,000 hash-chained audit-ledger rows, and a **55% run-error rate**
whose cause was one misbehaving profile (`implementer`, 24% completion, 94% of
spend) — **not** event-loop starvation or store contention.

## Decisions at a glance

| Item | Gate | Met today? | Decision |
| --- | --- | --- | --- |
| `worker_thread` SQLite offload | Concurrency/latency actually pushes the event loop at real single-operator scale | No | **Defer** |
| HTTP `/v1` versioning + generated OpenAPI clients | A real external client/consumer of the HTTP API exists | No | **Defer** |
| `work-store.ts` decomposition | It becomes genuine change-friction, not just navigation friction | Yes (arguably) | **Do a bounded, safe first step now; track the rest** |

---

## 1. `worker_thread` SQLite offload — DEFER

**What it is:** move the synchronous `node:sqlite` store off the main event loop
onto a worker thread, so a store operation can never block request handling.

**Gate:** concurrency/latency actually pushes the event loop at real
single-operator scale.

**Met? No.**

**Evidence:**

- The store is a single-operator, single-writer local SQLite database. Reads are
  windowed and index-served: the mutation/scheduler hot path materializes only a
  bounded live window (running runs + `currentRunId` + a recent terminal slice,
  `LIVE_RECENT_TERMINAL_RUNS`) rather than the full run history, and the
  run-analytics and run-usage aggregates bound their scan to the indexed
  `started_at` window (`idx_runs_started_at`). The result is that hot-path
  materialization latency is flat with respect to cumulative history, which is
  what a 270 MB / 156-run store needs — see
  [`work-store-run-windowing.test.ts`](https://github.com/joe-broadhead/opencode-gateway/blob/main/src/__tests__/work-store-run-windowing.test.ts).
- The dogfood run (25 days, 156 runs, 270 MB store, ~305k audit rows) is bounded
  by **OpenCode agent errors**, not by event-loop starvation or store
  contention. The single most important operational fact — a 55% error rate
  concentrated in one profile — has nothing to do with where SQLite runs.
- There is exactly **one operator and one writer**. Moving a fast, bounded,
  synchronous store onto a worker thread adds a serialization boundary,
  message-passing overhead, and lifecycle/error-surface complexity for no
  measured benefit.

**Trigger that would flip this to "do":** a **measured** event-loop signal under
normal operation — e.g. sustained event-loop lag above a small threshold (single-
digit-to-tens of milliseconds) attributable to store calls, captured by the
observability layer rather than assumed — **or** a second concurrent operator /
concurrent-writer requirement that makes a single synchronous writer a real
contention point. Until one of those is observed, the offload is speculative.

---

## 2. HTTP `/v1` versioning + generated OpenAPI clients — DEFER

**What it is:** a stable, versioned, client-generating HTTP contract — a `/v1`
route prefix plus generated typed clients that external consumers build against.

**Gate:** an actual external client/consumer of the HTTP API exists.

**Met? No.**

**Evidence:**

- OpenAPI is **already generated as a docs artifact**:
  [`docs/api/openapi.json`](../api/openapi.json) is an OpenAPI 3.1 document
  covering the full route table (123 paths at the time of writing), regenerated
  by `npm run docs:api` and drift-checked in CI so the spec and the route table
  stay in sync.
- The routes are **already documented as v1**: the
  [HTTP API reference](../api/http-api.md) states that routes are served
  unprefixed and are treated as v1, that the generated `openapi.json` documents
  the v1 surface as it exists today, and that a `/v1` alias prefix (keeping the
  unprefixed routes working as back-compat aliases) is a planned **additive**
  change in the daemon router.
- There is **no external client today**. The consumers are the operator's own
  CLI, dashboard, MCP tools, and channel adapters — all in-repo, all versioned
  together with the daemon, none of which need a frozen wire contract or a
  generated SDK to build.

The remaining work (a `/v1` alias prefix + generated typed clients) is a stable
contract for **third parties**. Freezing and versioning a contract with no
external consumer only adds a compatibility surface to maintain.

**Trigger that would flip this to "do":** the first real external client or
integration that builds against the HTTP API out-of-tree (a third-party script,
a partner integration, or a published SDK consumer). At that point the `/v1`
alias prefix and generated clients become a stability contract someone actually
depends on.

---

## 3. `work-store.ts` decomposition — GATE MET; do a bounded, safe first step

**What it is:** split the large, central `work-store.ts` module along its
already-declared repository domains.

**Gate:** it becomes genuine change-friction (it was navigation friction, not a
defect).

**Met? Yes, arguably.**

**Evidence:**

- At the point of this assessment `work-store.ts` was **~8,509 lines** — the
  largest and most central file in the codebase.
- It **grew this cycle**: #193 added the run-analytics query surface and #194
  added `planInitiative`, both landing in `work-store.ts`.
- It is the shared object nearly every sub-issue in this roadmap had to navigate,
  and every reviewer had to page through it to review unrelated changes. That is
  change-friction, not merely navigation friction.

### Decision: bounded, safe extraction now — not a full decomposition

`work-store.ts` is the most safety-critical file in the tree (it owns the
transactional mutation core, schema initialization, and the audit-ledger write
path). A **full** decomposition is a large mechanical refactor and is essentially
pure churn; bundling it into a feature PR harms reviewability. So this cycle does
a **bounded, clearly-safe** extraction that demonstrably shrinks the file and
improves navigation **without touching the transactional core**, and the
remainder is tracked as a dedicated pure-refactor issue.

### What was extracted (this PR)

The **read-only run-aggregate query surface** — the cohesive, recently-added,
self-contained cluster from #193 — moved into
[`src/work-store/analytics-queries.ts`](https://github.com/joe-broadhead/opencode-gateway/blob/main/src/work-store/analytics-queries.ts):

- Run-usage totals: `getRunCostTokenTotals`, `getRunUsageTotalsBatch`,
  `runUsageTotalsOnDb`, and the `RunUsageTotals` / `RunUsageQuery` types.
- Run-analytics: `getRunAnalyticsGroups`, `getRunAnalyticsUsageTotals`,
  `getRunAnalyticsBundle`, the `runAnalyticsWhere` / `runAnalyticsDimensionExpr`
  helpers, the `*OnDb` aggregate functions, the shared SQL constants, and the
  `RunAnalytics*` types.

Why this cluster: it is **read-only**, cohesive, and self-contained — every
function opens a read-only connection, runs a single indexed aggregate, and never
materializes the run array or mutates state. Nothing in the transactional core
depends on it.

**Properties preserved (pure move, zero behavior change):**

- Exact function signatures and exported names are unchanged.
- The submodule reuses the same connection/row helpers from `work-store.ts`
  (`withWorkDbReadOnly`, `getRow`, `queryRows`, `workStatePath`) rather than
  re-implementing them.
- Importers (`analytics.ts`, `governance.ts`, and the analytics /
  governance-usage / run-windowing tests) were updated to import the moved
  symbols directly from the submodule. This deliberately avoids re-exporting
  through `work-store.ts`, which would create a `work-store.ts` ↔ submodule
  dependency **cycle** — and the module-boundary cycle budget is already at its
  cap of 4.
- The new submodule stays inside the `work_store` domain, so module-boundary
  ownership rules stay green.

**Result:** `work-store.ts` went from **8,509 → 8,170 lines (−339 net)**: 343
lines of the read-only query surface moved out, offset by a 4-line doc comment on
the now-exported `withWorkDbReadOnly` read-only helper the submodule reuses. The
full test suite — including the DELETE-trigger hot-mutation, multi-process,
stress, analytics, and run-windowing tests — passes unchanged.

### Remaining work (tracked)

This bounded extraction is a **start, not the whole thing**. The remaining
decomposition is tracked as a dedicated, separately-reviewed pure-refactor issue:
[#206](https://github.com/joe-broadhead/opencode-gateway/issues/206). Each future
step continues along the declared `work_store` repository domains, one cohesive
low-coupling cluster per PR, behavior-preserving, with the mutation core left in
`work-store.ts` until a dedicated step moves it.

**Trigger for the mutation-core split (the higher-risk remainder):** genuine
change-friction *inside the transactional core itself* — e.g. a mutation change
that is hard to review because unrelated mutation domains are interleaved in one
file. Read-only and low-coupling clusters come out first; the transactional core
moves only under its own reviewable PR.

## Consequences

- Two of the three items stay explicitly deferred with a written, evidence-based
  trigger, so the work is not lost and is not built prematurely.
- The third item makes concrete, low-risk progress (−343 lines, a new cohesive
  read-only submodule) while the risky bulk is correctly routed to a stand-alone
  refactor PR (#206).
- No public claim, release wording, or product capability changes as a result of
  this record.
