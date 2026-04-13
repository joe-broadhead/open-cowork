# Performance Benchmarks

Open Cowork now ships a local synthetic benchmark runner so session-engine changes can be checked against a fixed baseline.

## Commands

- `pnpm perf:bench`
  Runs the benchmark suite and prints the current numbers.
- `pnpm perf:baseline`
  Runs the suite and rewrites [perf-baseline.json](/Users/joe/Documents/Joe/Github/opencowork/benchmarks/perf-baseline.json).
- `pnpm perf:check`
  Runs the suite and compares the current results against the checked-in baseline.

## Coverage

The current suite measures:

- large history projection
- engine hydration from projected history
- repeated view derivation from a hydrated session
- mixed streaming event reduction through the session engine

## Usage Notes

- Run `pnpm perf:check` on an otherwise idle machine or at least not in parallel with `test`, `typecheck`, or `build`.
- The baseline is machine-specific enough that it should be refreshed intentionally after major local environment changes.
- If the architecture changes enough that the workload is no longer representative, update the fixture generator in [scripts/perf-benchmark.ts](/Users/joe/Documents/Joe/Github/opencowork/scripts/perf-benchmark.ts) before refreshing the baseline.
