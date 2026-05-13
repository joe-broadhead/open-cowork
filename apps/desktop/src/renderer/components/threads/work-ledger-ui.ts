export const WORK_LEDGER_FEATURE_GATE_KEY = 'open-cowork.feature.workLedgerV1'

function storageOrNull(storage?: Storage | null) {
  if (storage) return storage
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function isWorkLedgerV1Enabled(storage?: Storage | null) {
  const target = storageOrNull(storage)
  if (!target) return false
  try {
    return target.getItem(WORK_LEDGER_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}
