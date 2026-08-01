import {
  FEATURE_VALUE_SURFACES,
  type FeatureValueEventInput,
  type FeatureValueSurface,
  type FeatureValueStage,
} from '@open-cowork/shared'

const STORAGE_KEY = 'open-cowork.feature-value.v1'
const MAX_LOCAL_ACTIVATIONS = 2

type FeatureState = {
  discovered: boolean
  activations: number
}

type TrackerState = Partial<Record<FeatureValueSurface, FeatureState>>

type FeatureValueTrackerDeps = {
  load: () => unknown
  save: (state: TrackerState) => void
  emit: (event: FeatureValueEventInput) => boolean | Promise<boolean>
}

function normalizeState(value: unknown): TrackerState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const state: TrackerState = {}
  for (const feature of FEATURE_VALUE_SURFACES) {
    const candidate = input[feature]
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue
    const record = candidate as Record<string, unknown>
    const activations = typeof record.activations === 'number'
      && Number.isSafeInteger(record.activations)
      && record.activations >= 0
      ? Math.min(record.activations, MAX_LOCAL_ACTIVATIONS)
      : 0
    state[feature] = {
      discovered: record.discovered === true,
      activations,
    }
  }
  return state
}

export function createFeatureValueTracker(deps: FeatureValueTrackerDeps) {
  let state: TrackerState
  try {
    state = normalizeState(deps.load())
  } catch {
    state = {}
  }

  let queue = Promise.resolve()

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation, operation)
    queue = next.then(() => undefined, () => undefined)
    return next
  }

  function persist() {
    try {
      deps.save(state)
    } catch {
      // Telemetry must never break the product path.
    }
  }

  async function emit(feature: FeatureValueSurface, stage: FeatureValueStage): Promise<boolean> {
    try {
      return await deps.emit({ feature, stage }) === true
    } catch {
      // Best-effort and content-free; product actions remain authoritative.
      return false
    }
  }

  async function discoverNow(feature: FeatureValueSurface): Promise<boolean> {
    const previous = state[feature] || { discovered: false, activations: 0 }
    if (previous.discovered) return false
    if (!await emit(feature, 'discovered')) return false
    state = { ...state, [feature]: { ...previous, discovered: true } }
    persist()
    return true
  }

  function discover(feature: FeatureValueSurface): Promise<boolean> {
    return enqueue(() => discoverNow(feature))
  }

  function activate(feature: FeatureValueSurface): Promise<FeatureValueStage | null> {
    return enqueue(async () => {
      if (!state[feature]?.discovered && !await discoverNow(feature)) return null
      const previous = state[feature] || { discovered: true, activations: 0 }
      if (previous.activations >= MAX_LOCAL_ACTIVATIONS) return null
      const stage: FeatureValueStage = previous.activations > 0 ? 'repeated' : 'activated'
      if (!await emit(feature, stage)) return null
      state = {
        ...state,
        [feature]: {
          discovered: true,
          activations: previous.activations + 1,
        },
      }
      persist()
      return stage
    })
  }

  return { discover, activate }
}

function readBrowserState(): unknown {
  if (typeof window === 'undefined') return {}
  const raw = window.localStorage?.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

const tracker = createFeatureValueTracker({
  load: readBrowserState,
  save: (state) => {
    if (typeof window === 'undefined') return
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state))
  },
  emit: (event) => {
    if (typeof window === 'undefined') return false
    return window.coworkApi?.adoption?.featureValue(event) ?? false
  },
})

export function recordFeatureValueDiscovery(feature: FeatureValueSurface) {
  void tracker.discover(feature)
}

export function recordFeatureValueActivation(feature: FeatureValueSurface) {
  void tracker.activate(feature)
}
