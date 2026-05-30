import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import type { WorkspaceApiSupport, WorkspaceApiSupportStatus } from '@open-cowork/shared'
import { useSessionStore } from './session'
import { LOCAL_WORKSPACE_ID, normalizeWorkspaceId } from './session-workspace-keys'

export const WORKSPACE_SUPPORT_APIS = [
  'sessions.list',
  'sessions.create',
  'sessions.activate',
  'sessions.get',
  'sessions.prompt',
  'sessions.abort',
  'sessions.fileSnippet',
  'sessions.diff',
  'threads.search',
  'threads.tags',
  'threads.smartFilters',
  'workflows.list',
  'workflows.run',
  'artifacts.list',
  'artifacts.upload',
  'artifacts.download',
  'artifacts.reveal',
  'settings.portable',
  'customContent.agents',
  'customContent.skills',
  'customContent.mcps',
  'capabilities.catalog',
  'localFiles',
  'localStdioMcps',
  'machineRuntimeConfig',
] as const

const LOCAL_SUPPORT: WorkspaceApiSupport[] = WORKSPACE_SUPPORT_APIS.map((api) => ({
  api,
  status: 'supported',
  verdict: { allowed: true, reason: null },
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

export function supportEntry(support: WorkspaceApiSupport[] | undefined, api: string) {
  return (support || []).find((entry) => entry.api === api)
}

export function supportAllows(entry: WorkspaceApiSupport | undefined, options: { mutation?: boolean } = {}) {
  if (!entry) return true
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

function statusIsUnavailable(status?: WorkspaceApiSupportStatus) {
  return status === 'blocked_by_policy' || status === 'not_supported' || status === 'deferred'
}

export function deriveWorkspaceSupportFlags(support: WorkspaceApiSupport[] | undefined) {
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
    return {
      supportByWorkspace: { ...state.supportByWorkspace, [normalized]: support },
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
      get().setWorkspaceSupport(normalized, support)
      return support
    } catch (error) {
      set((current) => ({
        loadedByWorkspace: { ...current.loadedByWorkspace, [normalized]: true },
        loadingByWorkspace: { ...current.loadingByWorkspace, [normalized]: false },
        errorByWorkspace: { ...current.errorByWorkspace, [normalized]: describeSupportError(error) },
      }))
      return []
    }
  },
}))

export function useActiveWorkspaceSupport() {
  const activeWorkspaceId = useSessionStore((state) => normalizeWorkspaceId(state.activeWorkspaceId))
  const support = useWorkspaceSupportStore((state) => state.supportByWorkspace[activeWorkspaceId])
  const loaded = useWorkspaceSupportStore((state) => state.loadedByWorkspace[activeWorkspaceId] === true)
  const loading = useWorkspaceSupportStore((state) => state.loadingByWorkspace[activeWorkspaceId] === true)
  const error = useWorkspaceSupportStore((state) => state.errorByWorkspace[activeWorkspaceId] || null)
  const loadWorkspaceSupport = useWorkspaceSupportStore((state) => state.loadWorkspaceSupport)

  useEffect(() => {
    void loadWorkspaceSupport(activeWorkspaceId)
  }, [activeWorkspaceId, loadWorkspaceSupport])

  const flags = useMemo(() => {
    const next = deriveWorkspaceSupportFlags(support)
    if (activeWorkspaceId === LOCAL_WORKSPACE_ID || loaded) return next
    const checkingReason = 'Checking cloud workspace policy.'
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
    support: support || (activeWorkspaceId === LOCAL_WORKSPACE_ID ? LOCAL_SUPPORT : []),
    loaded,
    loading,
    error,
    flags,
    isLocal: activeWorkspaceId === LOCAL_WORKSPACE_ID,
  }
}
