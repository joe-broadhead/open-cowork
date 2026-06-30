export const DEFAULT_THRESHOLDS = {
  avgMultiplier: 1.2,
  p95Multiplier: 1.25,
  avgAbsoluteFloorMs: 0.5,
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
