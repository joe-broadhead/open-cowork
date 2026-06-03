import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_SUPPORT_APIS,
  deriveWorkspaceSupportFlags,
  supportAllows,
  unavailableWorkspaceSupport,
  useWorkspaceSupportStore,
} from './workspace-support'
import { LOCAL_WORKSPACE_ID } from './session-workspace-keys'

function resetWorkspaceSupportStore() {
  useWorkspaceSupportStore.setState({
    supportByWorkspace: {},
    loadedByWorkspace: {},
    loadingByWorkspace: {},
    errorByWorkspace: {},
  })
}

function installWorkspaceSupportLoader(support: (workspaceId: string) => Promise<unknown>) {
  Object.defineProperty(window, 'coworkApi', {
    value: {
      workspace: {
        support,
      },
    },
    configurable: true,
  })
}

describe('workspace support store', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceSupportStore()
  })

  it('treats missing support entries as denied capabilities', () => {
    const flags = deriveWorkspaceSupportFlags([])

    expect(supportAllows(undefined)).toBe(false)
    expect(flags.canCreateSession).toBe(false)
    expect(flags.canPrompt).toBe(false)
    expect(flags.canRunWorkflow).toBe(false)
    expect(flags.canDownloadArtifact).toBe(false)
    expect(flags.canRevealArtifact).toBe(false)
  })

  it('builds a complete fail-closed support payload when policy is unavailable', () => {
    const support = unavailableWorkspaceSupport('support unavailable')
    const flags = deriveWorkspaceSupportFlags(support)

    expect(support.map((entry) => entry.api)).toEqual([...WORKSPACE_SUPPORT_APIS])
    expect(support.every((entry) => entry.status === 'blocked_by_policy')).toBe(true)
    expect(support.every((entry) => entry.verdict?.allowed === false)).toBe(true)
    expect(flags.canPrompt).toBe(false)
    expect(flags.canRunWorkflow).toBe(false)
    expect(flags.canDownloadArtifact).toBe(false)
    expect(flags.canRevealArtifact).toBe(false)
    expect(flags.reasons.prompt).toBe('support unavailable')
    expect(flags.reasons.runWorkflow).toBe('support unavailable')
    expect(flags.reasons.downloadArtifact).toBe('support unavailable')
  })

  it('fails closed when a non-local support load rejects', async () => {
    const supportLoader = vi.fn(async () => {
      throw new Error('support service unavailable')
    })
    installWorkspaceSupportLoader(supportLoader)

    const support = await useWorkspaceSupportStore.getState().loadWorkspaceSupport('cloud:test')
    const flags = deriveWorkspaceSupportFlags(support)
    const state = useWorkspaceSupportStore.getState()

    expect(supportLoader).toHaveBeenCalledWith('cloud:test')
    expect(support).toHaveLength(WORKSPACE_SUPPORT_APIS.length)
    expect(support.every((entry) => entry.status === 'blocked_by_policy')).toBe(true)
    expect(flags.canPrompt).toBe(false)
    expect(flags.canRunWorkflow).toBe(false)
    expect(flags.canDownloadArtifact).toBe(false)
    expect(flags.canRevealArtifact).toBe(false)
    expect(flags.reasons.prompt).toBe('support service unavailable')
    expect(state.loadedByWorkspace['cloud:test']).toBe(true)
    expect(state.loadingByWorkspace['cloud:test']).toBe(false)
    expect(state.errorByWorkspace['cloud:test']).toBe('support service unavailable')
  })

  it('fails closed for an empty non-local support payload', async () => {
    const supportLoader = vi.fn(async () => [])
    installWorkspaceSupportLoader(supportLoader)

    const support = await useWorkspaceSupportStore.getState().loadWorkspaceSupport('cloud:test')
    const flags = deriveWorkspaceSupportFlags(support)
    const state = useWorkspaceSupportStore.getState()

    expect(supportLoader).toHaveBeenCalledWith('cloud:test')
    expect(support).toHaveLength(WORKSPACE_SUPPORT_APIS.length)
    expect(support.every((entry) => entry.status === 'blocked_by_policy')).toBe(true)
    expect(flags.canPrompt).toBe(false)
    expect(flags.canRunWorkflow).toBe(false)
    expect(flags.canDownloadArtifact).toBe(false)
    expect(flags.reasons.prompt).toContain('Workspace support could not be loaded')
    expect(state.loadedByWorkspace['cloud:test']).toBe(true)
    expect(state.errorByWorkspace['cloud:test']).toBeNull()
  })

  it('preserves the implied workspace authority when support is unavailable', async () => {
    const supportLoader = vi.fn(async () => [])
    installWorkspaceSupportLoader(supportLoader)

    const gatewaySupport = await useWorkspaceSupportStore.getState().loadWorkspaceSupport('gateway:test')
    const pairedSupport = await useWorkspaceSupportStore.getState().loadWorkspaceSupport('paired-desktop:device-1')

    expect(deriveWorkspaceSupportFlags(gatewaySupport).authority).toBe('gateway_standalone')
    expect(deriveWorkspaceSupportFlags(pairedSupport).authority).toBe('desktop_paired')
  })

  it('keeps local support allowed without calling the support API', async () => {
    const supportLoader = vi.fn(async () => [])
    installWorkspaceSupportLoader(supportLoader)

    const support = await useWorkspaceSupportStore.getState().loadWorkspaceSupport(LOCAL_WORKSPACE_ID)
    const flags = deriveWorkspaceSupportFlags(support)

    expect(supportLoader).not.toHaveBeenCalled()
    expect(flags.canCreateSession).toBe(true)
    expect(flags.canPrompt).toBe(true)
    expect(flags.canRunWorkflow).toBe(true)
    expect(flags.canDownloadArtifact).toBe(true)
  })
})
