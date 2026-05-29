# Performance Benchmarks

Open Cowork now ships a local synthetic benchmark runner so session-engine changes can be checked against a fixed baseline.

## Commands

- `pnpm perf:bench`
  Runs the benchmark suite and prints the current numbers.
- `pnpm perf:baseline`
  Runs the suite and rewrites the environment-specific baseline for the
  current platform, architecture, and Node major version.
- `pnpm perf:check`
  Runs the suite and compares the current results against the checked-in
  environment-specific baseline when one exists, falling back first to the
  nearest same-platform/architecture baseline and then to
  [perf-baseline.json](perf-baseline.json).

## Coverage

The current suite measures:

- large history projection
- engine hydration from projected history
- repeated view derivation from a hydrated session
- mixed streaming event reduction through the session engine
- downstream-sized catalog work: runtime permission generation, agent
  catalog construction, capability map grouping, capability relationship
  summarization, and agent preview compilation with roughly 60 skills, 18
  tools, and 12 custom agents
- thread-index search/facet reads over 5,000 seeded historical threads

## Usage Notes

- Run `pnpm perf:check` on an otherwise idle machine or at least not in parallel with `test`, `typecheck`, or `build`.
- The gate uses relative thresholds plus small absolute floors and a 0.05 ms
  jitter allowance so low-millisecond benchmarks do not fail on hosted-runner
  timer noise.
- Baselines are environment-specific. CI uses `perf-baseline.linux-x64-node22.json`;
  local runs prefer a matching `perf-baseline.<platform>-<arch>-node<major>.json`
  before falling back to another baseline from the same platform and architecture,
  then the generic fallback.
- The baseline is machine-specific enough that it should be refreshed intentionally after major local environment changes.
- If the architecture changes enough that the workload is no longer representative, update the fixture generator in [scripts/perf-benchmark.ts](../scripts/perf-benchmark.ts) before refreshing the baseline.
