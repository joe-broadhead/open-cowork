export const DEFAULT_THRESHOLDS = {
  avgMultiplier: 1.2,
  p95Multiplier: 1.25,
  // Low-millisecond benchmark averages on shared CI runners vary ~±0.7ms
  // between runs of identical code (runner class, cache state, neighbors) —
  // observed 2.15ms vs 2.77ms on back-to-back runs of the same commit. The
  // multiplier still catches proportional regressions on slower benchmarks.
  avgAbsoluteFloorMs: 1,
  // Sub-millisecond benchmarks on shared CI runners routinely spike p95 by ~1ms on a
  // single GC/scheduling event (a 0.6ms op reading 1.4ms is noise, not regression).
  // The multiplier still catches proportional regressions on the slower benchmarks.
  p95AbsoluteFloorMs: 1.5,
  jitterAllowanceMs: 0.05,
}

export const CROSS_ENVIRONMENT_FLOORS = {
  avgAbsoluteFloorMs: 1,
  p95AbsoluteFloorMs: 2.5,
}
