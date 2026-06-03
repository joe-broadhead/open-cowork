import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import {
  WORKSPACE_SUPPORT_APIS,
  workspaceApiSupportContextForAuthority,
  type WorkspaceApiSupport,
  type WorkspaceApiSupportContext,
  type WorkspaceApiSupportStatus,
  type WorkspaceExecutionAuthority,
} from '@open-cowork/shared'
import { useSessionStore } from './session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from './session-workspace-keys'

export { WORKSPACE_SUPPORT_APIS } from '@open-cowork/shared'

const LOCAL_SUPPORT: WorkspaceApiSupport[] = WORKSPACE_SUPPORT_APIS.map((api) => ({
  api,
  status: 'supported',
  verdict: { allowed: true, reason: null },
  context: workspaceApiSupportContextForAuthority('desktop_local', {
    surface: 'desktop_local',
    onlineState: 'online',
    status: 'supported',
  }),
}))

type WorkspaceSupportState = {
  supportByWorkspace: Record<string, WorkspaceApiSupport[]>
  loadedByWorkspace: Record<string, boolean>
  loadingByWorkspace: Record<string, boolean>
  errorByWorkspace: Record<string, string | null>
  setWorkspaceSupport: (workspaceId: string, support: WorkspaceApiSupport[]) => void
  loadWorkspaceSupport: (workspaceId: string, options?: { force?: boolean }) => Promise<WorkspaceApiSupport[]>
}

function describeSupportError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

const WORKSPACE_SUPPORT_UNAVAILABLE_REASON = 'Workspace support could not be loaded. Mutating and file actions are disabled until policy is available.'

function unavailableSupportAuthorityForWorkspace(workspaceId: string): WorkspaceExecutionAuthority {
  if (workspaceId.startsWith('gateway:')) return 'gateway_standalone'
  if (workspaceId.startsWith('paired-desktop:')) return 'desktop_paired'
  return 'cloud_worker'
}

function unavailableSupportSurface(authority: WorkspaceExecutionAuthority) {
  if (authority === 'gateway_standalone') return 'gateway_standalone'
  if (authority === 'desktop_paired') return 'desktop_paired'
  if (authority === 'cloud_channel_gateway') return 'cloud_channel_gateway'
  return 'desktop_cloud'
}

export function unavailableWorkspaceSupport(
  reason = WORKSPACE_SUPPORT_UNAVAILABLE_REASON,
  options: { authority?: WorkspaceExecutionAuthority } = {},
): WorkspaceApiSupport[] {
  const authority = options.authority || 'cloud_worker'
  return WORKSPACE_SUPPORT_APIS.map((api) => {
    const verdict = {
      allowed: false,
      reason,
      policyCode: 'workspace.policy_unavailable',
    }
    return {
      api,
      status: 'blocked_by_policy',
      verdict,
      context: workspaceApiSupportContextForAuthority(authority, {
        status: 'blocked_by_policy',
        surface: unavailableSupportSurface(authority),
        onlineState: 'error',
        pathExposure: 'not_exposed',
        artifactBody: 'none',
        artifactReveal: 'none',
        workflows: 'blocked',
        blockedReason: verdict,
      }),
    }
  })
}

function supportForWorkspace(
  workspaceId: string,
  support: WorkspaceApiSupport[] | undefined,
  options: { loaded?: boolean; error?: string | null } = {},
) {
  if (workspaceId === LOCAL_WORKSPACE_ID) {
    return support && support.length > 0 ? support : LOCAL_SUPPORT
  }
  if (support && support.length > 0) {
    return support
  }
  if (options.loaded || options.error) {
    return unavailableWorkspaceSupport(options.error || undefined, {
      authority: unavailableSupportAuthorityForWorkspace(workspaceId),
    })
  }
  return []
}

export function supportEntry(support: WorkspaceApiSupport[] | undefined, api: string) {
  return (support || []).find((entry) => entry.api === api)
}

export function supportAllows(entry: WorkspaceApiSupport | undefined, options: { mutation?: boolean } = {}) {
  if (!entry) return false
  if (options.mutation && entry.status !== 'supported') return false
  return entry.status === 'supported' || entry.status === 'read_only' || entry.verdict?.allowed === true
}

export function supportReason(
  support: WorkspaceApiSupport[] | undefined,
  api: string,
  fallback = 'This action is disabled by this workspace policy.',
) {
  return supportEntry(support, api)?.verdict?.reason || fallback
}

export function supportContext(support: WorkspaceApiSupport[] | undefined): WorkspaceApiSupportContext | null {
  return support?.find((entry) => entry.context)?.context || null
}

export function supportAuthority(support: WorkspaceApiSupport[] | undefined): WorkspaceExecutionAuthority | null {
  return supportContext(support)?.authority || null
}

function statusIsUnavailable(status?: WorkspaceApiSupportStatus) {
  return status === 'blocked_by_policy' || status === 'not_supported' || status === 'deferred'
}

export function deriveWorkspaceSupportFlags(support: WorkspaceApiSupport[] | undefined) {
  const context = supportContext(support)
  const entry = (api: string) => supportEntry(support, api)
  const mutation = (api: string) => supportAllows(entry(api), { mutation: true })
  const readable = (api: string) => supportAllows(entry(api))
  const localFiles = entry('localFiles')
  const reveal = entry('artifacts.reveal')
  const machineRuntimeConfig = entry('machineRuntimeConfig')
  const cloudProfileReason = supportReason(
    support,
    'machineRuntimeConfig',
    'This cloud profile manages model and runtime configuration.',
  )

  return {
    authority: context?.authority || null,
    runtimeAuthority: context?.runtimeAuthority || null,
    durableStateOwner: context?.durableStateOwner || null,
    pathExposure: context?.pathExposure || null,
    pairingState: context?.pairingState || null,
    canExposeLocalPaths: context?.pathExposure === 'local_private',
    canMutateAuthority: context?.mutation === 'supported',
    canCreateSession: mutation('sessions.create'),
    canPrompt: mutation('sessions.prompt'),
    canAbort: mutation('sessions.abort'),
    canAttachFiles: mutation('localFiles'),
    canUseLocalFiles: readable('localFiles'),
    canListWorkflows: readable('workflows.list'),
    canRunWorkflow: mutation('workflows.run'),
    canDownloadArtifact: readable('artifacts.download'),
    canRevealArtifact: mutation('artifacts.reveal') || mutation('localFiles'),
    canUseMachineRuntimeConfig: readable('machineRuntimeConfig') && !statusIsUnavailable(machineRuntimeConfig?.status),
    canUsePortableSettings: readable('settings.portable'),
    reasons: {
      createSession: supportReason(support, 'sessions.create', 'Thread creation is disabled by this workspace policy.'),
      prompt: supportReason(support, 'sessions.prompt', 'Prompting is disabled by this workspace policy.'),
      attachFiles: localFiles?.verdict?.reason || 'This workspace does not implicitly upload local files.',
      runWorkflow: supportReason(support, 'workflows.run', 'Workflow runs are disabled by this workspace policy.'),
      listWorkflows: supportReason(support, 'workflows.list', 'Workflows are disabled by this workspace policy.'),
      downloadArtifact: supportReason(support, 'artifacts.download', 'Artifact downloads are disabled by this workspace policy.'),
      revealArtifact: reveal?.verdict?.reason || localFiles?.verdict?.reason || 'Cloud artifacts cannot be revealed in the local filesystem.',
      machineRuntimeConfig: cloudProfileReason,
      settingsPortable: supportReason(support, 'settings.portable', 'Portable cloud settings are disabled by this workspace policy.'),
    },
  }
}

export const useWorkspaceSupportStore = create<WorkspaceSupportState>((set, get) => ({
  supportByWorkspace: { [LOCAL_WORKSPACE_ID]: LOCAL_SUPPORT },
  loadedByWorkspace: { [LOCAL_WORKSPACE_ID]: true },
  loadingByWorkspace: {},
  errorByWorkspace: {},
  setWorkspaceSupport: (workspaceId, support) => set((state) => {
    const normalized = normalizeWorkspaceId(workspaceId)
    const effectiveSupport = supportForWorkspace(normalized, support, { loaded: true })
    return {
      supportByWorkspace: { ...state.supportByWorkspace, [normalized]: effectiveSupport },
      loadedByWorkspace: { ...state.loadedByWorkspace, [normalized]: true },
      loadingByWorkspace: { ...state.loadingByWorkspace, [normalized]: false },
      errorByWorkspace: { ...state.errorByWorkspace, [normalized]: null },
    }
  }),
  loadWorkspaceSupport: async (workspaceId, options) => {
    const normalized = normalizeWorkspaceId(workspaceId)
    if (normalized === LOCAL_WORKSPACE_ID) {
      get().setWorkspaceSupport(normalized, LOCAL_SUPPORT)
      return LOCAL_SUPPORT
    }
    const state = get()
    if (!options?.force && state.loadedByWorkspace[normalized] && state.supportByWorkspace[normalized]) {
      return state.supportByWorkspace[normalized]
    }
    if (!options?.force && state.loadingByWorkspace[normalized] && state.supportByWorkspace[normalized]) {
      return state.supportByWorkspace[normalized]
    }
    set((current) => ({
      loadingByWorkspace: { ...current.loadingByWorkspace, [normalized]: true },
      errorByWorkspace: { ...current.errorByWorkspace, [normalized]: null },
    }))
    try {
      const support = await window.coworkApi.workspace.support(normalized)
      const effectiveSupport = supportForWorkspace(normalized, support, { loaded: true })
      get().setWorkspaceSupport(normalized, effectiveSupport)
      return effectiveSupport
    } catch (error) {
      const reason = describeSupportError(error)
      const support = unavailableWorkspaceSupport(reason)
      set((current) => ({
        supportByWorkspace: { ...current.supportByWorkspace, [normalized]: support },
        loadedByWorkspace: { ...current.loadedByWorkspace, [normalized]: true },
        loadingByWorkspace: { ...current.loadingByWorkspace, [normalized]: false },
        errorByWorkspace: { ...current.errorByWorkspace, [normalized]: reason },
      }))
      return support
    }
  },
}))

export function useActiveWorkspaceSupport() {
  const activeWorkspaceId = useSessionStore((state) => normalizeWorkspaceId(state.activeWorkspaceId))
  const rawSupport = useWorkspaceSupportStore((state) => state.supportByWorkspace[activeWorkspaceId])
  const loaded = useWorkspaceSupportStore((state) => state.loadedByWorkspace[activeWorkspaceId] === true)
  const loading = useWorkspaceSupportStore((state) => state.loadingByWorkspace[activeWorkspaceId] === true)
  const error = useWorkspaceSupportStore((state) => state.errorByWorkspace[activeWorkspaceId] || null)
  const loadWorkspaceSupport = useWorkspaceSupportStore((state) => state.loadWorkspaceSupport)

  useEffect(() => {
    void loadWorkspaceSupport(activeWorkspaceId)
  }, [activeWorkspaceId, loadWorkspaceSupport])

  const support = useMemo(
    () => supportForWorkspace(activeWorkspaceId, rawSupport, { loaded, error }),
    [activeWorkspaceId, error, loaded, rawSupport],
  )

  const flags = useMemo(() => {
    const next = deriveWorkspaceSupportFlags(support)
    if (activeWorkspaceId === LOCAL_WORKSPACE_ID || loaded) return next
    const checkingReason = 'Checking workspace policy.'
    return {
      ...next,
      canCreateSession: false,
      canPrompt: false,
      canAbort: false,
      canAttachFiles: false,
      canUseLocalFiles: false,
      canListWorkflows: false,
      canRunWorkflow: false,
      canDownloadArtifact: false,
      canRevealArtifact: false,
      canUseMachineRuntimeConfig: false,
      canUsePortableSettings: false,
      reasons: {
        ...next.reasons,
        createSession: checkingReason,
        prompt: checkingReason,
        attachFiles: checkingReason,
        runWorkflow: checkingReason,
        downloadArtifact: checkingReason,
        revealArtifact: checkingReason,
        machineRuntimeConfig: checkingReason,
        settingsPortable: checkingReason,
      },
    }
  }, [activeWorkspaceId, loaded, support])

  return {
    workspaceId: activeWorkspaceId,
    support,
    loaded,
    loading,
    error,
    flags,
    isLocal: activeWorkspaceId === LOCAL_WORKSPACE_ID,
  }
}
