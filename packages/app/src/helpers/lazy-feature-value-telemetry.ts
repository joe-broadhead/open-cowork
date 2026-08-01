import type { FeatureValueSurface } from '@open-cowork/shared'

// Voice controls live in eager hooks. Keep the optional tracker
// behind a dynamic boundary so an off-by-default analytics channel does not
// consume startup bytes or block product interactions if its chunk fails.
function loadTracker() {
  return import('./feature-value-telemetry')
}

export function recordFeatureValueDiscovery(feature: FeatureValueSurface) {
  void loadTracker()
    .then((tracker) => tracker.recordFeatureValueDiscovery(feature))
    .catch(() => {
      // Best-effort only.
    })
}

export function recordFeatureValueActivation(feature: FeatureValueSurface) {
  void loadTracker()
    .then((tracker) => tracker.recordFeatureValueActivation(feature))
    .catch(() => {
      // Best-effort only.
    })
}
