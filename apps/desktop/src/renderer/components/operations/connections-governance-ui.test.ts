import { describe, expect, it } from 'vitest'
import {
  CONNECTIONS_GOVERNANCE_NAV_FEATURE_GATE_KEY,
  isConnectionsGovernanceNavEnabled,
} from './connections-governance-ui'

describe('connections-governance-ui', () => {
  it('keeps Connections and Governance navigation behind a default-off feature gate', () => {
    window.localStorage.removeItem(CONNECTIONS_GOVERNANCE_NAV_FEATURE_GATE_KEY)
    expect(isConnectionsGovernanceNavEnabled()).toBe(false)

    window.localStorage.setItem(CONNECTIONS_GOVERNANCE_NAV_FEATURE_GATE_KEY, 'true')
    expect(isConnectionsGovernanceNavEnabled()).toBe(true)
  })
})
