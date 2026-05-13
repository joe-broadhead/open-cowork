import type { OperationsQueueStatus } from '@open-cowork/shared'

export const OPERATIONS_COMMAND_CENTER_FEATURE_GATE_KEY = 'open-cowork.feature.operationsCommandCenter'
export const OPERATIONS_PREFERENCE_KEY = 'open-cowork.operations.preferences'

export type OperationsViewMode = 'table' | 'list'
export type OperationsSavedFilterId = 'all' | 'attention' | 'active' | 'failures' | 'deliveries'

export interface OperationsPreference {
  savedFilter?: OperationsSavedFilterId
  viewMode?: OperationsViewMode
}

export const OPERATIONS_SAVED_FILTERS: Array<{
  id: OperationsSavedFilterId
  label: string
  statuses?: OperationsQueueStatus[]
}> = [
  { id: 'all', label: 'All work' },
  { id: 'attention', label: 'Needs attention', statuses: ['needs_review', 'waiting_on_user', 'blocked'] },
  { id: 'active', label: 'Active work', statuses: ['running', 'blocked'] },
  { id: 'failures', label: 'Failures', statuses: ['failed'] },
  { id: 'deliveries', label: 'Deliveries', statuses: ['delivered'] },
]

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isOperationsCommandCenterEnabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(OPERATIONS_COMMAND_CENTER_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}

export function readOperationsPreference(storage?: Storage | null): OperationsPreference {
  const target = storageOrNull(storage)
  if (!target) return {}
  try {
    const raw = target.getItem(OPERATIONS_PREFERENCE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as OperationsPreference
    return {
      savedFilter: OPERATIONS_SAVED_FILTERS.some((filter) => filter.id === parsed.savedFilter) ? parsed.savedFilter : undefined,
      viewMode: parsed.viewMode === 'list' || parsed.viewMode === 'table' ? parsed.viewMode : undefined,
    }
  } catch {
    return {}
  }
}

export function writeOperationsPreference(preference: OperationsPreference, storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return
  try {
    target.setItem(OPERATIONS_PREFERENCE_KEY, JSON.stringify(readOperationsPreferenceFromValue(preference)))
  } catch {
    // Renderer preferences are best-effort.
  }
}

function readOperationsPreferenceFromValue(preference: OperationsPreference): OperationsPreference {
  return {
    savedFilter: OPERATIONS_SAVED_FILTERS.some((filter) => filter.id === preference.savedFilter) ? preference.savedFilter : undefined,
    viewMode: preference.viewMode === 'list' || preference.viewMode === 'table' ? preference.viewMode : undefined,
  }
}
