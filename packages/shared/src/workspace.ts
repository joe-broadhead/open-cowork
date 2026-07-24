export type WorkspaceKind = 'local' | 'cloud' | 'gateway' | 'paired_desktop'

export type WorkspaceStatus = 'online' | 'offline' | 'auth_required' | 'disabled' | 'error'

export const WORKSPACE_EXECUTION_AUTHORITIES = [
  'desktop_local',
  'gateway_standalone',
  'desktop_paired',
  'cloud_worker',
  'cloud_channel_gateway',
] as const

export type WorkspaceExecutionAuthority = typeof WORKSPACE_EXECUTION_AUTHORITIES[number]

export const OPENCODE_RUNTIME_AUTHORITIES = [
  'desktop_local',
  'gateway_standalone',
  'cloud_worker',
] as const

export type OpencodeRuntimeAuthority = typeof OPENCODE_RUNTIME_AUTHORITIES[number]

export const WORKSPACE_STATE_OWNERS = [
  'desktop_local_store',
  'gateway_control_plane',
  'cloud_control_plane',
  'desktop_pairing_connector',
  'cloud_channel_gateway',
  'none',
] as const

export type WorkspaceStateOwner = typeof WORKSPACE_STATE_OWNERS[number]

export const WORKSPACE_API_SUPPORT_STATUSES = [
  'supported',
  'read_only',
  'blocked_by_policy',
  'not_supported',
  'deferred',
] as const

export type WorkspaceApiSupportStatus = typeof WORKSPACE_API_SUPPORT_STATUSES[number]

export const WORKSPACE_PRODUCT_SURFACES = [
  'desktop_local',
  'desktop_cloud',
  'cloud_web',
  'cloud_channel_gateway',
  'gateway_standalone',
  'desktop_paired',
  'admin_operator',
] as const

export type WorkspaceProductSurface = typeof WORKSPACE_PRODUCT_SURFACES[number]

export const WORKSPACE_CONTRACT_REASON_CODES = [
  'workspace.auth_required',
  'workspace.offline_read_only',
  'workspace.local_only',
  'workspace.cloud_only',
  'workspace.policy_disabled',
  'workspace.quota_denied',
  'workspace.capacity_denied',
  'workspace.billing_denied',
  'workspace.not_supported',
  'workspace.deferred',
  'workspace.pairing_required',
  'workspace.pairing_offline',
  'workspace.authority_mismatch',
  'workspace.remote_approval_required',
] as const

export type WorkspaceContractReasonCode = typeof WORKSPACE_CONTRACT_REASON_CODES[number]

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
  'coordination.projects',
  'coordination.tasks',
  'coordination.runs',
  'coordination.schedules',
  'coordination.watches',
  'coordination.delegation',
  'artifacts.list',
  'artifacts.index',
  'artifacts.status',
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
  'voice.capture',
  'voice.stt',
  'voice.tts',
  'voice.conversation',
] as const

export type WorkspaceSupportApi = typeof WORKSPACE_SUPPORT_APIS[number]

export type WorkspaceMutationSupport = 'supported' | 'read_only' | 'blocked' | 'not_supported' | 'deferred'

export type WorkspaceArtifactAccess = 'local_filesystem' | 'cloud_object_store' | 'gateway_artifact_store' | 'channel_delivery' | 'redacted_metadata_only' | 'none'

export type WorkspaceInteractionAuthority = 'desktop_local' | 'gateway_standalone' | 'cloud_control_plane' | 'remote_pairing_policy' | 'not_supported'

export type WorkspaceWorkflowSupport = 'supported' | 'read_only' | 'blocked' | 'not_supported' | 'deferred'

export type WorkspacePathExposure = 'local_private' | 'cloud_safe_refs' | 'redacted_remote' | 'not_exposed'

export type WorkspacePairingState = 'not_applicable' | 'unpaired' | 'pairing_required' | 'paired_online' | 'paired_offline' | 'revoked'

export type WorkspaceAuthorityOwnership = {
  sessions: WorkspaceStateOwner
  events: WorkspaceStateOwner
  projections: WorkspaceStateOwner
  workflows: WorkspaceStateOwner
  artifacts: WorkspaceStateOwner
  settings: WorkspaceStateOwner
  credentials: WorkspaceStateOwner
  approvals: WorkspaceStateOwner
  questions: WorkspaceStateOwner
  audit: WorkspaceStateOwner
}

export type WorkspaceAuthorityContract = {
  authority: WorkspaceExecutionAuthority
  runtimeAuthority: OpencodeRuntimeAuthority
  durableStateOwner: WorkspaceStateOwner
  ownership: WorkspaceAuthorityOwnership
  defaultSurface: WorkspaceProductSurface
  defaultPathExposure: WorkspacePathExposure
  defaultPairingState: WorkspacePairingState
  defaultArtifactAccess: WorkspaceArtifactAccess
  defaultApprovals: WorkspaceInteractionAuthority
  defaultQuestions: WorkspaceInteractionAuthority
  defaultWorkflows: WorkspaceWorkflowSupport
}

export const WORKSPACE_AUTHORITY_CONTRACTS: Record<WorkspaceExecutionAuthority, WorkspaceAuthorityContract> = {
  desktop_local: {
    authority: 'desktop_local',
    runtimeAuthority: 'desktop_local',
    durableStateOwner: 'desktop_local_store',
    ownership: {
      sessions: 'desktop_local_store',
      events: 'desktop_local_store',
      projections: 'desktop_local_store',
      workflows: 'desktop_local_store',
      artifacts: 'desktop_local_store',
      settings: 'desktop_local_store',
      credentials: 'desktop_local_store',
      approvals: 'desktop_local_store',
      questions: 'desktop_local_store',
      audit: 'desktop_local_store',
    },
    defaultSurface: 'desktop_local',
    defaultPathExposure: 'local_private',
    defaultPairingState: 'not_applicable',
    defaultArtifactAccess: 'local_filesystem',
    defaultApprovals: 'desktop_local',
    defaultQuestions: 'desktop_local',
    defaultWorkflows: 'supported',
  },
  gateway_standalone: {
    authority: 'gateway_standalone',
    runtimeAuthority: 'gateway_standalone',
    durableStateOwner: 'gateway_control_plane',
    ownership: {
      sessions: 'gateway_control_plane',
      events: 'gateway_control_plane',
      projections: 'gateway_control_plane',
      workflows: 'gateway_control_plane',
      artifacts: 'gateway_control_plane',
      settings: 'gateway_control_plane',
      credentials: 'gateway_control_plane',
      approvals: 'gateway_control_plane',
      questions: 'gateway_control_plane',
      audit: 'gateway_control_plane',
    },
    defaultSurface: 'gateway_standalone',
    defaultPathExposure: 'redacted_remote',
    defaultPairingState: 'not_applicable',
    defaultArtifactAccess: 'gateway_artifact_store',
    defaultApprovals: 'gateway_standalone',
    defaultQuestions: 'gateway_standalone',
    defaultWorkflows: 'supported',
  },
  desktop_paired: {
    authority: 'desktop_paired',
    runtimeAuthority: 'desktop_local',
    durableStateOwner: 'desktop_local_store',
    ownership: {
      sessions: 'desktop_local_store',
      events: 'desktop_local_store',
      projections: 'desktop_local_store',
      workflows: 'desktop_local_store',
      artifacts: 'desktop_local_store',
      settings: 'desktop_local_store',
      credentials: 'desktop_local_store',
      approvals: 'desktop_local_store',
      questions: 'desktop_local_store',
      audit: 'desktop_local_store',
    },
    defaultSurface: 'desktop_paired',
    defaultPathExposure: 'redacted_remote',
    defaultPairingState: 'pairing_required',
    defaultArtifactAccess: 'redacted_metadata_only',
    defaultApprovals: 'remote_pairing_policy',
    defaultQuestions: 'remote_pairing_policy',
    defaultWorkflows: 'deferred',
  },
  cloud_worker: {
    authority: 'cloud_worker',
    runtimeAuthority: 'cloud_worker',
    durableStateOwner: 'cloud_control_plane',
    ownership: {
      sessions: 'cloud_control_plane',
      events: 'cloud_control_plane',
      projections: 'cloud_control_plane',
      workflows: 'cloud_control_plane',
      artifacts: 'cloud_control_plane',
      settings: 'cloud_control_plane',
      credentials: 'cloud_control_plane',
      approvals: 'cloud_control_plane',
      questions: 'cloud_control_plane',
      audit: 'cloud_control_plane',
    },
    defaultSurface: 'desktop_cloud',
    defaultPathExposure: 'cloud_safe_refs',
    defaultPairingState: 'not_applicable',
    defaultArtifactAccess: 'cloud_object_store',
    defaultApprovals: 'cloud_control_plane',
    defaultQuestions: 'cloud_control_plane',
    defaultWorkflows: 'supported',
  },
  cloud_channel_gateway: {
    authority: 'cloud_channel_gateway',
    runtimeAuthority: 'cloud_worker',
    durableStateOwner: 'cloud_control_plane',
    ownership: {
      sessions: 'cloud_control_plane',
      events: 'cloud_control_plane',
      projections: 'cloud_control_plane',
      workflows: 'cloud_control_plane',
      artifacts: 'cloud_control_plane',
      settings: 'cloud_control_plane',
      credentials: 'cloud_channel_gateway',
      approvals: 'cloud_control_plane',
      questions: 'cloud_control_plane',
      audit: 'cloud_control_plane',
    },
    defaultSurface: 'cloud_channel_gateway',
    defaultPathExposure: 'redacted_remote',
    defaultPairingState: 'not_applicable',
    defaultArtifactAccess: 'channel_delivery',
    defaultApprovals: 'cloud_control_plane',
    defaultQuestions: 'cloud_control_plane',
    defaultWorkflows: 'supported',
  },
}

export type WorkspaceInfo = {
  id: string
  kind: WorkspaceKind
  authority?: WorkspaceExecutionAuthority
  label: string
  status: WorkspaceStatus
  active: boolean
  tenantId?: string
  userId?: string
  baseUrl?: string
  profileName?: string
  lastSyncedAt?: string | null
  error?: string | null
}

export type WorkspaceRef = {
  workspaceId: string
  sessionId?: string
}

export type WorkspaceScoped<T> = T & {
  workspaceId?: string
}

export type WorkspaceOptions = {
  workspaceId?: string
}

export type WorkspacePolicy = {
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
  localFiles: 'enabled' | 'disabled'
  localStdioMcps: 'enabled' | 'disabled' | 'allowlisted'
  machineRuntimeConfig: 'disabled' | 'allowlisted'
}

// Org-managed workspace & desktop policy (#898). A single org-scoped record the
// control plane owns and the desktop enforces. The permission ceilings clamp the
// runtime-host permission maxima TIGHTER (never looser); the allow/deny lists scope
// providers/models; the extension classes gate custom providers/MCPs/skills; and the
// update channel pins auto-update. Shared so the control-plane record, the cloud
// delivery response, the runtime-host clamping path, and the desktop can agree on one
// authoritative shape. Individuals with no org receive the unrestricted defaults, so
// there is no behavioural change for them.
export type ManagedPolicyPermissionCeiling = 'allow' | 'ask' | 'deny'

// The permission dimensions a policy can clamp, aligned with the runtime-host
// permission model (bash / file-write / web / web-search / task / mcp / external dir).
export const MANAGED_POLICY_PERMISSION_DIMENSIONS = [
  'bash',
  'fileWrite',
  'web',
  'webSearch',
  'task',
  'mcp',
  'externalDirectory',
] as const

export type ManagedPolicyPermissionDimension = typeof MANAGED_POLICY_PERMISSION_DIMENSIONS[number]

export type ManagedPolicyPermissionCeilings = Record<ManagedPolicyPermissionDimension, ManagedPolicyPermissionCeiling>

// Whether members must bring their own key, use an org-managed key, or either.
export const MANAGED_POLICY_KEY_MANAGEMENT_VALUES = ['any', 'byok_required', 'org_managed_required'] as const
export type ManagedPolicyKeyManagement = typeof MANAGED_POLICY_KEY_MANAGEMENT_VALUES[number]

// The classes of user-authored extensions a policy can enable/disable wholesale.
export type ManagedPolicyExtensionClasses = {
  customProviders: boolean
  customMcps: boolean
  customSkills: boolean
}

// The enforcement-relevant policy shape delivered to the desktop. Excludes the
// control-plane bookkeeping (orgId / timestamps) the record carries.
export type ManagedDesktopPolicy = {
  allowedProviders: string[] | null
  deniedProviders: string[]
  allowedModels: string[] | null
  deniedModels: string[]
  keyManagement: ManagedPolicyKeyManagement
  extensions: ManagedPolicyExtensionClasses
  features: Record<string, boolean>
  permissionCeilings: ManagedPolicyPermissionCeilings
  updateChannel: string | null
}

// The machine-readable transparency signal a surface renders as "Managed by your
// organization". Keyed by control id (permission dimension, extension class, or
// 'providers'/'models'); present only for controls the policy actively restricts.
export const MANAGED_POLICY_DISABLED_REASON = 'Managed by your organization'

export type ManagedPolicyControlStatus = {
  disabledByPolicy: true
  reason: string
}

export type ManagedPolicyDisabledControls = Record<string, ManagedPolicyControlStatus>

// The delivered view: the effective policy plus the transparency map of the controls
// the policy restricts relative to an unrestricted baseline.
export type ManagedDesktopPolicyView = ManagedDesktopPolicy & {
  disabledByPolicy: ManagedPolicyDisabledControls
}

export type WorkspaceActionVerdict = {
  allowed: boolean
  reason: string | null
  policyCode?: WorkspaceContractReasonCode | string
}

export type WorkspaceApiSupportContext = {
  authority: WorkspaceExecutionAuthority
  runtimeAuthority: OpencodeRuntimeAuthority
  surface: WorkspaceProductSurface
  durableStateOwner: WorkspaceStateOwner
  ownership: WorkspaceAuthorityOwnership
  onlineState: WorkspaceStatus
  mutation: WorkspaceMutationSupport
  artifacts: {
    metadata: WorkspaceMutationSupport
    body: WorkspaceArtifactAccess
    reveal: WorkspaceArtifactAccess
  }
  approvals: WorkspaceInteractionAuthority
  questions: WorkspaceInteractionAuthority
  workflows: WorkspaceWorkflowSupport
  pathExposure: WorkspacePathExposure
  pairingState: WorkspacePairingState
  blockedReason?: WorkspaceActionVerdict
}

export type WorkspaceApiSupport = {
  api: string
  status: WorkspaceApiSupportStatus
  verdict?: WorkspaceActionVerdict
  context?: WorkspaceApiSupportContext
}

export type WorkspaceSurfaceSupport = {
  surface: WorkspaceProductSurface
  api: string
  status: WorkspaceApiSupportStatus
  reasonCode?: WorkspaceContractReasonCode | string
  notes?: string
}

export type AddCloudWorkspaceInput = {
  baseUrl: string
  label?: string
}

export type AddGatewayWorkspaceInput = {
  baseUrl: string
  label?: string
  token?: string
}

export type WorkspaceSyncResult = {
  ok: true
  syncedAt: string
}

export function workspaceAuthorityContract(authority: WorkspaceExecutionAuthority): WorkspaceAuthorityContract {
  return WORKSPACE_AUTHORITY_CONTRACTS[authority]
}

export function workspaceMutationSupportFromStatus(status: WorkspaceApiSupportStatus): WorkspaceMutationSupport {
  switch (status) {
    case 'supported':
      return 'supported'
    case 'read_only':
      return 'read_only'
    case 'blocked_by_policy':
      return 'blocked'
    case 'deferred':
      return 'deferred'
    case 'not_supported':
    default:
      return 'not_supported'
  }
}

export function workspaceApiSupportContextForAuthority(
  authority: WorkspaceExecutionAuthority,
  input: {
    status?: WorkspaceApiSupportStatus
    surface?: WorkspaceProductSurface
    onlineState?: WorkspaceStatus
    pairingState?: WorkspacePairingState
    pathExposure?: WorkspacePathExposure
    workflows?: WorkspaceWorkflowSupport
    artifactBody?: WorkspaceArtifactAccess
    artifactReveal?: WorkspaceArtifactAccess
    blockedReason?: WorkspaceActionVerdict
  } = {},
): WorkspaceApiSupportContext {
  const contract = workspaceAuthorityContract(authority)
  const mutation = workspaceMutationSupportFromStatus(input.status || 'supported')
  return {
    authority,
    runtimeAuthority: contract.runtimeAuthority,
    surface: input.surface || contract.defaultSurface,
    durableStateOwner: contract.durableStateOwner,
    ownership: contract.ownership,
    onlineState: input.onlineState || 'online',
    mutation,
    artifacts: {
      metadata: mutation,
      body: input.artifactBody || contract.defaultArtifactAccess,
      reveal: input.artifactReveal || contract.defaultArtifactAccess,
    },
    approvals: contract.defaultApprovals,
    questions: contract.defaultQuestions,
    workflows: input.workflows || (mutation === 'supported' ? contract.defaultWorkflows : mutation),
    pathExposure: input.pathExposure || contract.defaultPathExposure,
    pairingState: input.pairingState || contract.defaultPairingState,
    ...(input.blockedReason ? { blockedReason: input.blockedReason } : {}),
  }
}

export type WorkspaceSessionsUpdatedEvent = {
  workspaceId: string
  sessions: Array<import('./session.js').SessionInfo>
  lastEventSequence?: number | null
  syncedAt: string
}

export interface SkillImportSelection {
  token: string
  directory: string
}

export interface SandboxStorageStats {
  root: string
  totalBytes: number
  workspaceCount: number
  referencedWorkspaceCount: number
  unreferencedWorkspaceCount: number
  staleWorkspaceCount: number
  staleThresholdDays: number
}

export interface SandboxCleanupResult {
  mode: 'old-unreferenced' | 'all-unreferenced'
  removedWorkspaces: number
  removedBytes: number
}
