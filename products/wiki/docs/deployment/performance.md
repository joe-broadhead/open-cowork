# Performance And Scale

Performance claims are scoped to executable local benchmarks. They are not a
hosted-capacity or provider guarantee.

## Fast Blocking Gate

```sh
pnpm --filter cowork-wiki-workspace perf:check
```

The default smoke builds a synthetic 1k-record workspace and checks bounded
index, search, graph, and export behavior. It is suitable for regular local and
CI feedback.

## Larger Diagnostic Runs

```sh
pnpm --filter cowork-wiki-workspace perf:scale:10k
pnpm --filter cowork-wiki-workspace perf:scale:100k
pnpm --filter cowork-wiki-workspace perf:scale:1m
```

These runs are diagnostic and machine-dependent. Record Node version, commit,
fixture size, hardware, elapsed time, and memory before comparing results. Use
`OPENWIKI_SCALE_ENFORCE=1` only when the current environment has an owned,
documented budget.

The scale runner emits JSON artifacts for inspection. Generated artifacts are
local evidence and are not committed documentation.

## Source-Hosted Scale Path

Postgres is the active shared-store path for a source-operated hosted runtime:

```sh
OPENWIKI_RUNTIME_MODE=hosted
OPENWIKI_DATABASE_URL=postgres://...
OPENWIKI_READ_BACKEND=postgres
OPENWIKI_SEARCH_BACKEND=postgres
OPENWIKI_QUEUE_BACKEND=postgres
OPENWIKI_WRITE_COORDINATOR_BACKEND=postgres
OPENWIKI_OPERATIONAL_STATE_BACKEND=postgres
```

`hosted` and `enterprise` modes fail readiness when required shared stores are
missing. They disable request-path SQLite index rebuilds and full-repository
search fallbacks so a stale derived store cannot turn each request into an
unbounded scan. Run migrations and full Postgres synchronization before
serving traffic.

The Postgres search runtime performs database-side lexical retrieval with
policy prefiltering. Its capability response reports unsupported retrievers;
callers must not infer fuzzy, n-gram, or graph retrieval when the runtime does
not advertise them.

## Useful Diagnostics

Search responses may include bounded timing and candidate diagnostics such as
`candidate_count`, `permission_filtered_count`, `retrieval_ms`, and
`elapsed_ms`. They must never expose hidden records.

When a workload misses its budget, identify whether the cost is indexing,
database synchronization, retrieval, policy filtering, rendering, or static
export before changing a limit. Optimize only the active bottleneck and keep
the blocking smoke small enough for rapid feedback.
