export const CONNECTIONS_GOVERNANCE_NAV_FEATURE_GATE_KEY = 'open-cowork.feature.connectionsGovernanceNav'

type StorageLike = Pick<Storage, 'getItem'> | null | undefined

export function isConnectionsGovernanceNavEnabled(storage: StorageLike = typeof window !== 'undefined' ? window.localStorage : null) {
  try {
    return storage?.getItem(CONNECTIONS_GOVERNANCE_NAV_FEATURE_GATE_KEY) === 'true'
  } catch {
    return false
  }
}
