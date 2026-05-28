import type { IpcMainInvokeEvent } from 'electron'
import type {
  AddCloudWorkspaceInput,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  CustomAgentConfig,
  CustomMcpConfig,
  CustomSkillConfig,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionImportRequest,
  SessionImportResult,
  SessionArtifactUploadRequest,
  SessionInfo,
  SessionView,
  ThreadFacetSummary,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkspaceInfo,
  WorkspaceApiSupport,
  WorkspaceApiSupportStatus,
  WorkspacePolicy,
  WorkspaceStatus,
  WorkspaceSyncResult,
  ScopedArtifactRef,
} from '@open-cowork/shared'
import {
  cloudWorkspaceCacheKey,
  createCloudWorkspaceAdapter,
  type CloudPromptInput,
  type CloudWorkspaceSessionAdapter,
} from './cloud-workspace-adapter.ts'
import {
  createCloudWorkspaceDesktopAuthenticator,
  type CloudWorkspaceLoginResult,
} from './cloud-workspace-auth.ts'
import type {
  CloudTransportSettingMetadata,
  CloudTransportSessionEvent,
  CloudTransportSubscription,
  CloudTransportWorkspaceEvent,
} from './cloud/transport-adapter.ts'
import {
  cloudWorkspaceIdForBaseUrl,
  createFileCloudWorkspaceRegistry,
  normalizeCloudWorkspaceBaseUrl,
  type CloudWorkspaceConnectionRecord,
  type CloudWorkspaceRegistry,
} from './cloud-workspace-registry.ts'
import {
  createFileCloudWorkspaceCredentialStore,
  type CloudWorkspaceCredentialStore,
} from './cloud-workspace-credentials.ts'
import {
  createFileCloudWorkspaceCache,
  type CloudWorkspaceCache,
} from './cloud-workspace-cache.ts'
import { DEFAULT_CONFIG, type CloudDesktopConfig } from './config-types.ts'

export const LOCAL_WORKSPACE_ID = 'local'

type WorkspaceRegistration = Omit<WorkspaceInfo, 'active'>

type WorkspaceEventLike = Pick<IpcMainInvokeEvent, 'sender'> | null | undefined

export type WorkspaceGatewayOptions = {
  workspaces?: WorkspaceRegistration[]
  cloudDesktop?: CloudDesktopConfig
  cloudRegistry?: CloudWorkspaceRegistry | null
  cloudCredentialStore?: CloudWorkspaceCredentialStore | null
  cloudCache?: CloudWorkspaceCache | null
  cloudAdapterFactory?: (connection: CloudWorkspaceConnectionRecord, accessToken?: string | null) => CloudWorkspaceSessionAdapter
  cloudLogin?: (connection: CloudWorkspaceConnectionRecord) => Promise<CloudWorkspaceLoginResult>
  cloudRefresh?: (connection: CloudWorkspaceConnectionRecord, refreshToken: string) => Promise<CloudWorkspaceLoginResult>
}

const LOCAL_WORKSPACE: WorkspaceRegistration = {
  id: LOCAL_WORKSPACE_ID,
  kind: 'local',
  label: 'Local',
  status: 'online',
  lastSyncedAt: null,
}

const LOCAL_WORKSPACE_POLICY: WorkspacePolicy = {
  features: {
    sessions: true,
    threads: true,
    workflows: true,
    artifacts: true,
    settings: true,
    customContent: true,
    capabilities: true,
  },
  allowedAgents: null,
  allowedTools: null,
  allowedMcps: null,
  localFiles: 'enabled',
  localStdioMcps: 'enabled',
  machineRuntimeConfig: 'allowlisted',
}

const DISABLED_CLOUD_POLICY: WorkspacePolicy = {
  features: {
    sessions: false,
    threads: false,
    workflows: false,
    artifacts: false,
    settings: false,
    customContent: false,
    capabilities: false,
  },
  allowedAgents: [],
  allowedTools: [],
  allowedMcps: [],
  localFiles: 'disabled',
  localStdioMcps: 'disabled',
  machineRuntimeConfig: 'disabled',
}

const WORKSPACE_SUPPORT_APIS = [
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
  'settings.portable',
  'customContent.agents',
  'customContent.skills',
  'customContent.mcps',
  'capabilities.catalog',
  'localFiles',
  'localStdioMcps',
  'machineRuntimeConfig',
] as const

const CLOUD_CUSTOM_AGENTS_KEY = 'custom-agents'
const CLOUD_CUSTOM_MCPS_KEY = 'custom-mcps'
const CLOUD_CUSTOM_SKILLS_KEY = 'custom-skills'

function cloudRefreshErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function isCredentialRefreshAuthFailure(error: unknown) {
  const message = cloudRefreshErrorMessage(error).toLowerCase()
  return /\b(invalid_grant|invalid_token|invalid_request|unauthorized_client|access_denied)\b/.test(message)
    || /\bhttp\s+(400|401|403)\b/.test(message)
}

function senderKey(event: WorkspaceEventLike) {
  const id = event?.sender?.id
  return typeof id === 'number' && Number.isFinite(id) ? id : 0
}

function normalizeWorkspaceId(workspaceId?: string | null) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return null
  const trimmed = workspaceId.trim()
  if (!trimmed) return null
  if (Buffer.byteLength(trimmed, 'utf8') > 512) {
    throw new Error('Workspace id is too large.')
  }
  return trimmed
}

export function readWorkspaceIdOption(input: unknown): string | null {
  if (input === undefined || input === null) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Workspace options must be an object when provided.')
  }
  const workspaceId = (input as { workspaceId?: unknown }).workspaceId
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') return null
  if (typeof workspaceId !== 'string') throw new Error('Workspace id must be a string.')
  return normalizeWorkspaceId(workspaceId)
}

function cloudRegistrationFromConnection(connection: CloudWorkspaceConnectionRecord): WorkspaceRegistration {
  return {
    id: connection.id,
    kind: 'cloud',
    label: connection.label,
    status: 'auth_required',
    baseUrl: connection.baseUrl,
    tenantId: connection.tenantId,
    userId: connection.userId,
    profileName: connection.profileName,
    lastSyncedAt: connection.lastSyncedAt,
    error: 'Sign in to this cloud workspace to enable sync.',
  }
}

function connectionFromWorkspace(workspace: WorkspaceRegistration): CloudWorkspaceConnectionRecord {
  if (workspace.kind !== 'cloud' || !workspace.baseUrl) {
    throw new Error('Cloud workspace requires a base URL.')
  }
  const timestamp = new Date(0).toISOString()
  return {
    id: workspace.id,
    baseUrl: normalizeCloudWorkspaceBaseUrl(workspace.baseUrl),
    label: workspace.label,
    tenantId: workspace.tenantId,
    userId: workspace.userId,
    profileName: workspace.profileName,
    lastSyncedAt: workspace.lastSyncedAt || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

export class WorkspaceGateway {
  private readonly workspaces = new Map<string, WorkspaceRegistration>()
  private readonly cloudConnections = new Map<string, CloudWorkspaceConnectionRecord>()
  private readonly cloudAdapters = new Map<string, CloudWorkspaceSessionAdapter>()
  private readonly cloudSessionSubscriptions = new Map<string, CloudTransportSubscription>()
  private readonly cloudWorkspaceSubscriptions = new Map<string, CloudTransportSubscription>()
  private readonly managedCloudWorkspaceIds = new Set<string>()
  private readonly activeBySender = new Map<number, string>()
  private readonly syncedAtByWorkspace = new Map<string, string>()
  private readonly cloudDesktopConfig: CloudDesktopConfig
  private readonly cloudRegistry: CloudWorkspaceRegistry | null
  private readonly cloudCredentialStore: CloudWorkspaceCredentialStore | null
  private cloudCache: CloudWorkspaceCache | null | undefined
  private readonly cloudAdapterFactory: (connection: CloudWorkspaceConnectionRecord, accessToken?: string | null) => CloudWorkspaceSessionAdapter
  private readonly cloudLogin: (connection: CloudWorkspaceConnectionRecord) => Promise<CloudWorkspaceLoginResult>
  private readonly cloudRefresh: (connection: CloudWorkspaceConnectionRecord, refreshToken: string) => Promise<CloudWorkspaceLoginResult>

  constructor(options: WorkspaceGatewayOptions = {}) {
    this.cloudDesktopConfig = options.cloudDesktop || DEFAULT_CONFIG.cloudDesktop
    this.cloudRegistry = options.cloudRegistry === undefined ? createFileCloudWorkspaceRegistry() : options.cloudRegistry
    this.cloudCredentialStore = options.cloudCredentialStore === undefined ? createFileCloudWorkspaceCredentialStore() : options.cloudCredentialStore
    this.cloudCache = options.cloudCache
    this.cloudAdapterFactory = options.cloudAdapterFactory || ((connection, accessToken) => createCloudWorkspaceAdapter(connection, accessToken, {
      cache: this.getCloudCache(),
      cacheMode: this.cloudDesktopConfig.cacheMode,
      cacheEncryptionFallback: this.cloudDesktopConfig.cacheEncryptionFallback,
    }))
    const authenticator = createCloudWorkspaceDesktopAuthenticator()
    this.cloudLogin = options.cloudLogin || ((connection) => authenticator.login(connection))
    this.cloudRefresh = options.cloudRefresh || ((connection, refreshToken) => authenticator.refresh(connection, refreshToken))
    this.registerWorkspace(LOCAL_WORKSPACE)
    if (!this.cloudDesktopConfig.enabled) return
    const persistedConnections = new Map((this.cloudRegistry?.list() || []).map((connection) => [connection.id, connection]))
    for (const preconfigured of this.cloudDesktopConfig.preconfiguredConnections) {
      const baseUrl = normalizeCloudWorkspaceBaseUrl(preconfigured.baseUrl)
      const id = cloudWorkspaceIdForBaseUrl(baseUrl)
      const persisted = persistedConnections.get(id)
      const connection: CloudWorkspaceConnectionRecord = {
        id,
        baseUrl,
        label: preconfigured.label?.trim() || persisted?.label || new URL(baseUrl).host,
        tenantId: persisted?.tenantId,
        userId: persisted?.userId,
        profileName: persisted?.profileName,
        lastSyncedAt: persisted?.lastSyncedAt || null,
        createdAt: persisted?.createdAt || new Date(0).toISOString(),
        updatedAt: persisted?.updatedAt || new Date(0).toISOString(),
      }
      this.managedCloudWorkspaceIds.add(id)
      this.cloudConnections.set(connection.id, connection)
      this.registerWorkspace(this.applyCredentialStatus(cloudRegistrationFromConnection(connection)))
    }
    for (const connection of this.cloudRegistry?.list() || []) {
      if (this.cloudDesktopConfig.requireManagedOrg && !this.managedCloudWorkspaceIds.has(connection.id)) continue
      if (this.cloudConnections.has(connection.id)) continue
      this.cloudConnections.set(connection.id, connection)
      this.registerWorkspace(this.applyCredentialStatus(cloudRegistrationFromConnection(connection)))
    }
    for (const workspace of options.workspaces || []) {
      this.registerWorkspace(workspace)
    }
  }

  registerWorkspace(workspace: WorkspaceRegistration) {
    this.workspaces.set(workspace.id, { ...workspace })
    if (workspace.kind === 'cloud' && workspace.baseUrl && !this.cloudConnections.has(workspace.id)) {
      this.cloudConnections.set(workspace.id, connectionFromWorkspace(workspace))
    }
  }

  list(event?: WorkspaceEventLike): WorkspaceInfo[] {
    const activeId = this.activeWorkspaceId(event)
    return Array.from(this.workspaces.values()).map((workspace) => this.toInfo(workspace, workspace.id === activeId))
  }

  activate(event: WorkspaceEventLike, workspaceIdInput: string): WorkspaceInfo {
    const workspace = this.getWorkspace(workspaceIdInput)
    this.activeBySender.set(senderKey(event), workspace.id)
    return this.toInfo(workspace, true)
  }

  addCloud(event: WorkspaceEventLike, input: AddCloudWorkspaceInput): WorkspaceInfo {
    if (!this.cloudDesktopConfig.enabled) {
      throw new Error('Cloud workspaces are disabled by this build configuration.')
    }
    if (!this.cloudDesktopConfig.allowUserAddedConnections || this.cloudDesktopConfig.requireManagedOrg) {
      throw new Error('User-added cloud workspaces are disabled by this build configuration.')
    }
    if (!input || typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) {
      throw new Error('Cloud workspace URL is required.')
    }
    const baseUrl = normalizeCloudWorkspaceBaseUrl(input.baseUrl)
    const connection = this.cloudRegistry?.upsert({
      baseUrl,
      label: input.label,
    }) || {
      id: cloudWorkspaceIdForBaseUrl(baseUrl),
      baseUrl,
      label: input.label?.trim() || new URL(baseUrl).host,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSyncedAt: null,
    }
    const workspace = this.applyCredentialStatus(cloudRegistrationFromConnection(connection))
    this.registerWorkspace(workspace)
    return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
  }

  remove(event: WorkspaceEventLike, workspaceIdInput: string): boolean {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput)
    if (!workspaceId || workspaceId === LOCAL_WORKSPACE_ID) return false
    if (this.cloudDesktopConfig.requireManagedOrg && this.managedCloudWorkspaceIds.has(workspaceId)) return false
    const connection = this.cloudConnections.get(workspaceId)
    const removed = this.workspaces.delete(workspaceId)
    const persistedRemoved = this.cloudRegistry?.remove(workspaceId) || false
    this.cloudCredentialStore?.remove(workspaceId)
    this.clearCloudCache(connection)
    this.cloudConnections.delete(workspaceId)
    this.cloudAdapters.delete(workspaceId)
    this.closeCloudSubscriptionsForWorkspace(workspaceId)
    for (const [sender, activeWorkspaceId] of this.activeBySender.entries()) {
      if (activeWorkspaceId === workspaceId) this.activeBySender.set(sender, LOCAL_WORKSPACE_ID)
    }
    this.syncedAtByWorkspace.delete(workspaceId)
    // Resolve the active workspace for this sender so callers see a stable
    // local fallback after removing a selected cloud placeholder.
    this.activeWorkspaceId(event)
    return removed || persistedRemoved
  }

  async login(event: WorkspaceEventLike, workspaceIdInput: string): Promise<WorkspaceInfo> {
    const workspace = this.getWorkspace(workspaceIdInput)
    if (workspace.kind === 'local') return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
    const connection = this.cloudConnections.get(workspace.id)
    if (!connection) throw new Error('Cloud workspace connection is missing.')
    if (!this.cloudCredentialStore) throw new Error('Cloud workspace credential storage is not configured.')
    const loggedIn = await this.cloudLogin(connection)
    this.cloudCredentialStore.save({
      workspaceId: workspace.id,
      accessToken: loggedIn.accessToken,
      refreshToken: loggedIn.refreshToken,
      expiresAt: loggedIn.expiresAt,
    })
    const updatedConnection = this.cloudRegistry?.upsert({
      baseUrl: connection.baseUrl,
      label: workspace.label,
      tenantId: loggedIn.tenantId || connection.tenantId,
      userId: loggedIn.userId || connection.userId,
      profileName: loggedIn.profileName || connection.profileName,
      lastSyncedAt: connection.lastSyncedAt,
    }) || {
      ...connection,
      tenantId: loggedIn.tenantId || connection.tenantId,
      userId: loggedIn.userId || connection.userId,
      profileName: loggedIn.profileName || connection.profileName,
      updatedAt: new Date().toISOString(),
    }
    this.cloudConnections.set(workspace.id, updatedConnection)
    this.cloudAdapters.delete(workspace.id)
    const next = {
      ...workspace,
      tenantId: updatedConnection.tenantId,
      userId: updatedConnection.userId,
      profileName: updatedConnection.profileName,
      status: 'online',
      error: null,
    } satisfies WorkspaceRegistration
    this.workspaces.set(workspace.id, next)
    return this.toInfo(next, workspace.id === this.activeWorkspaceId(event))
  }

  logout(event: WorkspaceEventLike, workspaceIdInput: string): WorkspaceInfo {
    const workspace = this.getWorkspace(workspaceIdInput)
    if (workspace.kind === 'local') return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
    this.cloudCredentialStore?.remove(workspace.id)
    this.cloudAdapters.delete(workspace.id)
    this.closeCloudSubscriptionsForWorkspace(workspace.id)
    const next = {
      ...workspace,
      status: 'auth_required',
      userId: undefined,
      error: 'Sign in to this cloud workspace to enable sync.',
    } satisfies WorkspaceRegistration
    this.workspaces.set(workspace.id, next)
    return this.toInfo(next, workspace.id === this.activeWorkspaceId(event))
  }

  policy(event: WorkspaceEventLike, workspaceIdInput?: string | null): WorkspacePolicy {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    return workspace.kind === 'local' ? LOCAL_WORKSPACE_POLICY : DISABLED_CLOUD_POLICY
  }

  async cloudPolicy(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspacePolicy> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'local') return LOCAL_WORKSPACE_POLICY
    try {
      return (await this.requireCloudAdapter(workspace)).policy()
    } catch {
      return DISABLED_CLOUD_POLICY
    }
  }

  async supportMatrix(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceApiSupport[]> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'local') {
      return WORKSPACE_SUPPORT_APIS.map((api) => ({
        api,
        status: 'supported',
        verdict: { allowed: true, reason: null },
      }))
    }
    const policy = await this.cloudPolicy(event, workspace.id)
    const feature = (key: string, fallback = false) => policy.features[key] ?? fallback
    const cloudSupport = (api: string, status: WorkspaceApiSupportStatus, reason: string | null = null): WorkspaceApiSupport => ({
      api,
      status,
      verdict: {
        allowed: status === 'supported' || status === 'read_only',
        reason,
        ...(reason ? { policyCode: status } : {}),
      },
    })
    const supportedIf = (api: string, allowed: boolean, reason: string): WorkspaceApiSupport => (
      allowed ? cloudSupport(api, 'supported') : cloudSupport(api, 'blocked_by_policy', reason)
    )
    const chatEnabled = feature('chat', feature('sessions', true))
    return [
      supportedIf('sessions.list', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      supportedIf('sessions.create', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      supportedIf('sessions.activate', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      supportedIf('sessions.get', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      supportedIf('sessions.prompt', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      supportedIf('sessions.abort', chatEnabled, 'Cloud chat is disabled by this workspace policy.'),
      cloudSupport('sessions.fileSnippet', 'not_supported', 'Cloud workspaces cannot read arbitrary local host paths.'),
      cloudSupport('sessions.diff', 'not_supported', 'Cloud workspaces cannot diff arbitrary local host paths.'),
      supportedIf('threads.search', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
      supportedIf('threads.tags', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
      supportedIf('threads.smartFilters', feature('threadIndex'), 'Cloud thread index is disabled by this workspace policy.'),
      supportedIf('workflows.list', feature('workflows'), 'Cloud workflows are disabled by this workspace policy.'),
      supportedIf('workflows.run', feature('workflows'), 'Cloud workflows are disabled by this workspace policy.'),
      supportedIf('artifacts.list', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.upload', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.download', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('settings.portable', feature('settings'), 'Cloud portable settings are disabled by this workspace policy.'),
      supportedIf('customContent.agents', feature('customAgents'), 'Cloud custom agents are disabled by this workspace policy.'),
      supportedIf('customContent.skills', feature('customSkills'), 'Cloud custom skills are disabled by this workspace policy.'),
      supportedIf('customContent.mcps', feature('customMcps'), 'Cloud custom MCPs are disabled by this workspace policy.'),
      supportedIf('capabilities.catalog', feature('agents'), 'Cloud capability catalog is disabled by this workspace policy.'),
      cloudSupport('localFiles', 'not_supported', 'Cloud workspaces do not implicitly upload local files.'),
      cloudSupport('localStdioMcps', 'not_supported', 'Cloud workspaces do not execute arbitrary local stdio MCPs.'),
      cloudSupport('machineRuntimeConfig', 'not_supported', 'Cloud workspaces do not use machine-native runtime config.'),
    ]
  }

  async sync(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceSyncResult> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'cloud') {
      await this.requireCloudAdapter(workspace)
    }
    const syncedAt = new Date().toISOString()
    this.syncedAtByWorkspace.set(workspace.id, syncedAt)
    if (workspace.kind === 'cloud') {
      this.cloudRegistry?.touchSync(workspace.id, syncedAt)
      const latestWorkspace = this.workspaces.get(workspace.id) || workspace
      this.workspaces.set(workspace.id, {
        ...latestWorkspace,
        lastSyncedAt: syncedAt,
      })
    }
    return { ok: true, syncedAt }
  }

  activeWorkspaceId(event?: WorkspaceEventLike) {
    const active = this.activeBySender.get(senderKey(event))
    return active && this.workspaces.has(active) ? active : LOCAL_WORKSPACE_ID
  }

  assertLocalWorkspace(event: WorkspaceEventLike, workspaceIdInput?: string | null): WorkspaceInfo {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind !== 'local') {
      throw new Error('This desktop action is only available in the Local workspace.')
    }
    return this.toInfo(workspace, true)
  }

  isLocalWorkspace(event: WorkspaceEventLike, workspaceIdInput?: string | null): boolean {
    return this.resolveWorkspace(event, workspaceIdInput).kind === 'local'
  }

  async listCloudSessions(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<SessionInfo[]> {
    return (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).listSessions()
  }

  async createCloudSession(
    event: WorkspaceEventLike,
    workspaceIdInput?: string | null,
    input: { projectSource?: CloudProjectSourceInput | null } = {},
  ): Promise<SessionInfo> {
    return (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).createSession(input)
  }

  async validateCloudProjectSource(
    event: WorkspaceEventLike,
    workspaceIdInput: string | null | undefined,
    projectSource: CloudProjectSourceInput,
  ): Promise<CloudProjectSourcePolicyVerdict> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.validateProjectSource) {
      return { allowed: false, reason: 'Cloud workspace does not support project source validation.' }
    }
    return adapter.validateProjectSource(projectSource)
  }

  async uploadCloudProjectSnapshot(
    event: WorkspaceEventLike,
    workspaceIdInput: string | null | undefined,
    input: CloudProjectSnapshotUploadInput,
  ): Promise<CloudProjectSnapshotUploadResult> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.uploadProjectSnapshot) {
      throw new Error('Cloud workspace does not support project snapshot uploads.')
    }
    return adapter.uploadProjectSnapshot(input)
  }

  async importLocalSessionToCloud(
    event: WorkspaceEventLike,
    input: SessionImportRequest,
    workspaceIdInput: string,
  ): Promise<SessionImportResult & { view: SessionView }> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    const adapter = await this.requireCloudAdapter(workspace)
    const imported = await adapter.importSession(input)
    const syncedAt = new Date().toISOString()
    this.syncedAtByWorkspace.set(workspace.id, syncedAt)
    this.cloudRegistry?.touchSync(workspace.id, syncedAt)
    return {
      workspaceId: workspace.id,
      sessionId: imported.session.id,
      title: imported.session.title || input.title,
      importedAt: imported.session.createdAt,
      itemCounts: input.itemCounts,
      view: imported.view,
    }
  }

  async getCloudSessionInfo(event: WorkspaceEventLike, sessionId: string, workspaceIdInput?: string | null): Promise<SessionInfo | null> {
    return (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).getSessionInfo(sessionId)
  }

  async getCloudSessionView(event: WorkspaceEventLike, sessionId: string, workspaceIdInput?: string | null): Promise<SessionView> {
    return (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).getSessionView(sessionId)
  }

  async promptCloudSession(
    event: WorkspaceEventLike,
    sessionId: string,
    input: CloudPromptInput,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).promptSession(sessionId, input)
  }

  async abortCloudSession(
    event: WorkspaceEventLike,
    sessionId: string,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await (await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))).abortSession(sessionId)
  }

  async replyCloudQuestion(
    event: WorkspaceEventLike,
    sessionId: string,
    requestId: string,
    answers: unknown[],
    workspaceIdInput?: string | null,
  ): Promise<void> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.replyToQuestion) throw new Error('Cloud question replies are not supported by this workspace.')
    await adapter.replyToQuestion(sessionId, requestId, answers)
  }

  async rejectCloudQuestion(
    event: WorkspaceEventLike,
    sessionId: string,
    requestId: string,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.rejectQuestion) throw new Error('Cloud question rejection is not supported by this workspace.')
    await adapter.rejectQuestion(sessionId, requestId)
  }

  async respondCloudPermission(
    event: WorkspaceEventLike,
    sessionId: string,
    permissionId: string,
    allowed: boolean,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.respondToPermission) throw new Error('Cloud permission responses are not supported by this workspace.')
    await adapter.respondToPermission(sessionId, permissionId, allowed)
  }

  async listCloudWorkflows(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkflowListPayload> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listWorkflows) throw new Error('Cloud workflows are not supported by this workspace.')
    return adapter.listWorkflows()
  }

  async getCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.getWorkflow) throw new Error('Cloud workflows are not supported by this workspace.')
    return adapter.getWorkflow(workflowId)
  }

  async runCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowRun | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.runWorkflow) throw new Error('Cloud workflow runs are not supported by this workspace.')
    return adapter.runWorkflow(workflowId)
  }

  async pauseCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.pauseWorkflow) throw new Error('Cloud workflow pause is not supported by this workspace.')
    return adapter.pauseWorkflow(workflowId)
  }

  async resumeCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.resumeWorkflow) throw new Error('Cloud workflow resume is not supported by this workspace.')
    return adapter.resumeWorkflow(workflowId)
  }

  async archiveCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.archiveWorkflow) throw new Error('Cloud workflow archive is not supported by this workspace.')
    return adapter.archiveWorkflow(workflowId)
  }

  async searchCloudThreads(
    event: WorkspaceEventLike,
    query?: ThreadSearchQuery,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSearchResult> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.searchThreads) throw new Error('Cloud thread search is not supported by this workspace.')
    return adapter.searchThreads(query)
  }

  async cloudThreadFacets(
    event: WorkspaceEventLike,
    query?: ThreadSearchQuery,
    workspaceIdInput?: string | null,
  ): Promise<ThreadFacetSummary> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.threadFacets) throw new Error('Cloud thread facets are not supported by this workspace.')
    return adapter.threadFacets(query)
  }

  async listCloudThreadTags(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadTag[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.listThreadTags()
  }

  async createCloudThreadTag(
    event: WorkspaceEventLike,
    input: ThreadTagInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadTag> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.createThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.createThreadTag(input)
  }

  async updateCloudThreadTag(
    event: WorkspaceEventLike,
    tagId: string,
    input: ThreadTagInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadTag | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.updateThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.updateThreadTag(tagId, input)
  }

  async deleteCloudThreadTag(
    event: WorkspaceEventLike,
    tagId: string,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.deleteThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.deleteThreadTag(tagId)
  }

  async applyCloudThreadTags(
    event: WorkspaceEventLike,
    sessionIds: string[],
    tagIds: string[],
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.applyThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.applyThreadTags(sessionIds, tagIds)
  }

  async removeCloudThreadTags(
    event: WorkspaceEventLike,
    sessionIds: string[],
    tagIds: string[],
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.removeThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return adapter.removeThreadTags(sessionIds, tagIds)
  }

  async listCloudThreadSmartFilters(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadSmartFilter[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listThreadSmartFilters) throw new Error('Cloud smart filters are not supported by this workspace.')
    return adapter.listThreadSmartFilters()
  }

  async createCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    input: ThreadSmartFilterInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSmartFilter> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.createThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return adapter.createThreadSmartFilter(input)
  }

  async updateCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    filterId: string,
    input: ThreadSmartFilterInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSmartFilter | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.updateThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return adapter.updateThreadSmartFilter(filterId, input)
  }

  async deleteCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    filterId: string,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.deleteThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return adapter.deleteThreadSmartFilter(filterId)
  }

  async listCloudArtifacts(
    event: WorkspaceEventLike,
    sessionId: string,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifact[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listArtifacts) throw new Error('Cloud artifacts are not supported by this workspace.')
    return adapter.listArtifacts(sessionId)
  }

  async uploadCloudArtifact(
    event: WorkspaceEventLike,
    input: SessionArtifactUploadRequest,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifact> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.uploadArtifact) throw new Error('Cloud artifact uploads are not supported by this workspace.')
    return adapter.uploadArtifact(input)
  }

  async readCloudArtifactAttachment(
    event: WorkspaceEventLike,
    sessionId: string,
    filePathOrArtifactId: string,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifactAttachment> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.readArtifactAttachment) throw new Error('Cloud artifact downloads are not supported by this workspace.')
    return adapter.readArtifactAttachment(sessionId, filePathOrArtifactId)
  }

  async listCloudCapabilityTools(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CapabilityTool[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listCapabilityTools) throw new Error('Cloud capabilities are not supported by this workspace.')
    return adapter.listCapabilityTools()
  }

  async getCloudCapabilityTool(
    event: WorkspaceEventLike,
    toolId: string,
    workspaceIdInput?: string | null,
  ): Promise<CapabilityTool | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.getCapabilityTool) throw new Error('Cloud capabilities are not supported by this workspace.')
    return adapter.getCapabilityTool(toolId)
  }

  async listCloudCapabilitySkills(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CapabilitySkill[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listCapabilitySkills) throw new Error('Cloud capabilities are not supported by this workspace.')
    return adapter.listCapabilitySkills()
  }

  async getCloudCapabilitySkillBundle(
    event: WorkspaceEventLike,
    skillName: string,
    workspaceIdInput?: string | null,
  ): Promise<CapabilitySkillBundle | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.getCapabilitySkillBundle) throw new Error('Cloud capabilities are not supported by this workspace.')
    return adapter.getCapabilitySkillBundle(skillName)
  }

  async readCloudCapabilitySkillBundleFile(
    event: WorkspaceEventLike,
    skillName: string,
    filePath: string,
    workspaceIdInput?: string | null,
  ): Promise<string | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.readCapabilitySkillBundleFile) throw new Error('Cloud capability bundle files are not supported by this workspace.')
    return adapter.readCapabilitySkillBundleFile(skillName, filePath)
  }

  async listCloudSettings(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CloudTransportSettingMetadata[]> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.listSettings) throw new Error('Cloud settings are not supported by this workspace.')
    return adapter.listSettings()
  }

  async getCloudSetting(
    event: WorkspaceEventLike,
    key: string,
    workspaceIdInput?: string | null,
  ): Promise<CloudTransportSettingMetadata | null> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.getSetting) throw new Error('Cloud settings are not supported by this workspace.')
    return adapter.getSetting(key)
  }

  async setCloudSetting(
    event: WorkspaceEventLike,
    key: string,
    value: Record<string, unknown>,
    workspaceIdInput?: string | null,
  ): Promise<CloudTransportSettingMetadata> {
    const adapter = await this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput))
    if (!adapter.setSetting) throw new Error('Cloud settings are not supported by this workspace.')
    return adapter.setSetting(key, value)
  }

  async listCloudCustomAgents(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CustomAgentConfig[]> {
    return this.readCloudItemsSetting<CustomAgentConfig>(event, CLOUD_CUSTOM_AGENTS_KEY, workspaceIdInput)
  }

  async saveCloudCustomAgent(
    event: WorkspaceEventLike,
    agent: CustomAgentConfig,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    await this.upsertCloudItemSetting(event, CLOUD_CUSTOM_AGENTS_KEY, agent, workspaceIdInput)
    return true
  }

  async removeCloudCustomAgent(
    event: WorkspaceEventLike,
    target: ScopedArtifactRef,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.removeCloudItemSetting(event, CLOUD_CUSTOM_AGENTS_KEY, target, workspaceIdInput)
  }

  async listCloudCustomMcps(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CustomMcpConfig[]> {
    return this.readCloudItemsSetting<CustomMcpConfig>(event, CLOUD_CUSTOM_MCPS_KEY, workspaceIdInput)
  }

  async saveCloudCustomMcp(
    event: WorkspaceEventLike,
    mcp: CustomMcpConfig,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    await this.upsertCloudItemSetting(event, CLOUD_CUSTOM_MCPS_KEY, mcp, workspaceIdInput)
    return true
  }

  async removeCloudCustomMcp(
    event: WorkspaceEventLike,
    target: ScopedArtifactRef,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.removeCloudItemSetting(event, CLOUD_CUSTOM_MCPS_KEY, target, workspaceIdInput)
  }

  async listCloudCustomSkills(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CustomSkillConfig[]> {
    return this.readCloudItemsSetting<CustomSkillConfig>(event, CLOUD_CUSTOM_SKILLS_KEY, workspaceIdInput)
  }

  async saveCloudCustomSkill(
    event: WorkspaceEventLike,
    skill: CustomSkillConfig,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    await this.upsertCloudItemSetting(event, CLOUD_CUSTOM_SKILLS_KEY, skill, workspaceIdInput)
    return true
  }

  async removeCloudCustomSkill(
    event: WorkspaceEventLike,
    target: ScopedArtifactRef,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.removeCloudItemSetting(event, CLOUD_CUSTOM_SKILLS_KEY, target, workspaceIdInput)
  }

  async subscribeCloudSessionEvents(
    event: WorkspaceEventLike,
    sessionId: string,
    input: {
      workspaceId?: string | null
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): Promise<void> {
    const workspace = this.resolveWorkspace(event, input.workspaceId)
    const adapter = await this.requireCloudAdapter(workspace)
    if (!adapter.subscribeSessionEvents) return
    const key = this.cloudSessionSubscriptionKey(workspace.id, sessionId)
    if (this.cloudSessionSubscriptions.has(key)) return
    let subscription: CloudTransportSubscription | null = null
    let failedDuringSubscribe = false
    const onError = (error: unknown) => {
      failedDuringSubscribe = true
      if (subscription && this.cloudSessionSubscriptions.get(key) === subscription) {
        this.cloudSessionSubscriptions.delete(key)
        try { subscription.close() } catch { /* best effort */ }
      }
      input.onError?.(error)
    }
    subscription = adapter.subscribeSessionEvents(sessionId, {
      afterSequence: input.afterSequence,
      onEvent: input.onEvent,
      onError,
    })
    if (failedDuringSubscribe) {
      try { subscription.close() } catch { /* best effort */ }
      return
    }
    this.cloudSessionSubscriptions.set(key, subscription)
  }

  async subscribeCloudWorkspaceEvents(
    event: WorkspaceEventLike,
    input: {
      workspaceId?: string | null
      afterSequence?: number
      onEvent: (event: CloudTransportWorkspaceEvent) => void
      onError?: (error: unknown) => void
    },
  ): Promise<void> {
    const workspace = this.resolveWorkspace(event, input.workspaceId)
    const adapter = await this.requireCloudAdapter(workspace)
    if (!adapter.subscribeWorkspaceEvents) return
    const key = this.cloudWorkspaceSubscriptionKey(workspace.id, senderKey(event))
    if (this.cloudWorkspaceSubscriptions.has(key)) return
    let subscription: CloudTransportSubscription | null = null
    let failedDuringSubscribe = false
    const onError = (error: unknown) => {
      failedDuringSubscribe = true
      if (subscription && this.cloudWorkspaceSubscriptions.get(key) === subscription) {
        this.cloudWorkspaceSubscriptions.delete(key)
        try { subscription.close() } catch { /* best effort */ }
      }
      input.onError?.(error)
    }
    subscription = adapter.subscribeWorkspaceEvents({
      afterSequence: input.afterSequence,
      onEvent: input.onEvent,
      onError,
    })
    if (failedDuringSubscribe) {
      try { subscription.close() } catch { /* best effort */ }
      return
    }
    this.cloudWorkspaceSubscriptions.set(key, subscription)
  }

  private resolveWorkspace(event: WorkspaceEventLike, workspaceIdInput?: string | null): WorkspaceRegistration {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput) || this.activeWorkspaceId(event)
    return this.getWorkspace(workspaceId)
  }

  private getCloudCache() {
    if (this.cloudCache !== undefined) return this.cloudCache
    this.cloudCache = createFileCloudWorkspaceCache({
      mode: this.cloudDesktopConfig.cacheMode,
      encryptionFallback: this.cloudDesktopConfig.cacheEncryptionFallback,
    })
    return this.cloudCache
  }

  private clearCloudCache(connection?: CloudWorkspaceConnectionRecord) {
    if (!connection) return
    try {
      this.getCloudCache()?.removeWorkspace(cloudWorkspaceCacheKey(connection))
    } catch {
      // Cache cleanup is best-effort; credential and registry removal still
      // need to complete if secure storage is unavailable or the cache is corrupt.
    }
  }

  private getWorkspace(workspaceIdInput: string): WorkspaceRegistration {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput)
    if (!workspaceId) throw new Error('Workspace id is required.')
    const workspace = this.workspaces.get(workspaceId)
    if (!workspace) throw new Error(`Unknown workspace: ${workspaceId}`)
    return workspace
  }

  private async requireCloudAdapter(workspace: WorkspaceRegistration): Promise<CloudWorkspaceSessionAdapter> {
    if (workspace.kind !== 'cloud') throw new Error('This action requires a Cloud workspace.')
    const connection = this.cloudConnections.get(workspace.id)
    if (!connection) throw new Error('Cloud workspace connection is missing.')
    const accessToken = await this.ensureCloudAccessToken(workspace, connection)
    if (!accessToken) {
      const latestWorkspace = this.workspaces.get(workspace.id) || workspace
      throw new Error(latestWorkspace.error || 'Cloud workspace is not available.')
    }
    const existing = this.cloudAdapters.get(workspace.id)
    if (existing) return existing
    const adapter = this.cloudAdapterFactory(connection, accessToken)
    this.cloudAdapters.set(workspace.id, adapter)
    return adapter
  }

  private async ensureCloudAccessToken(
    workspace: WorkspaceRegistration,
    connection: CloudWorkspaceConnectionRecord,
  ) {
    const current = this.cloudCredentialStore?.getUsableAccessToken(workspace.id) || null
    if (current) return current
    const credential = this.cloudCredentialStore?.get(workspace.id)
    if (!credential?.refreshToken || !this.cloudCredentialStore) return null
    try {
      const refreshed = await this.cloudRefresh(connection, credential.refreshToken)
      this.cloudCredentialStore.save({
        workspaceId: workspace.id,
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken || credential.refreshToken,
        expiresAt: refreshed.expiresAt,
      })
      const nextConnection = this.cloudRegistry?.upsert({
        baseUrl: connection.baseUrl,
        label: connection.label,
        tenantId: refreshed.tenantId || connection.tenantId,
        userId: refreshed.userId || connection.userId,
        profileName: refreshed.profileName || connection.profileName,
        lastSyncedAt: connection.lastSyncedAt,
      }) || {
        ...connection,
        tenantId: refreshed.tenantId || connection.tenantId,
        userId: refreshed.userId || connection.userId,
        profileName: refreshed.profileName || connection.profileName,
        updatedAt: new Date().toISOString(),
      }
      this.cloudConnections.set(workspace.id, nextConnection)
      this.cloudAdapters.delete(workspace.id)
      this.workspaces.set(workspace.id, {
        ...workspace,
        tenantId: nextConnection.tenantId,
        userId: nextConnection.userId,
        profileName: nextConnection.profileName,
        status: 'online',
        error: null,
      })
      return refreshed.accessToken
    } catch (error) {
      this.cloudAdapters.delete(workspace.id)
      if (isCredentialRefreshAuthFailure(error)) {
        this.cloudCredentialStore.remove(workspace.id)
        this.workspaces.set(workspace.id, {
          ...workspace,
          status: 'auth_required',
          error: 'Sign in to this cloud workspace to enable sync.',
        })
      } else {
        this.workspaces.set(workspace.id, {
          ...workspace,
          status: 'offline',
          error: 'Cloud workspace is offline or unavailable. Retry when the connection recovers.',
        })
      }
      return null
    }
  }

  private cloudSessionSubscriptionKey(workspaceId: string, sessionId: string) {
    return `${workspaceId}:${sessionId}`
  }

  private cloudWorkspaceSubscriptionKey(workspaceId: string, senderId: number) {
    return `${workspaceId}:${senderId}`
  }

  private closeCloudSubscriptionsForWorkspace(workspaceId: string) {
    for (const [key, subscription] of this.cloudSessionSubscriptions.entries()) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      try { subscription.close() } catch { /* best effort */ }
      this.cloudSessionSubscriptions.delete(key)
    }
    for (const [key, subscription] of this.cloudWorkspaceSubscriptions.entries()) {
      if (!key.startsWith(`${workspaceId}:`)) continue
      try { subscription.close() } catch { /* best effort */ }
      this.cloudWorkspaceSubscriptions.delete(key)
    }
  }

  private async readCloudItemsSetting<T extends { name: string }>(
    event: WorkspaceEventLike,
    keyName: string,
    workspaceIdInput?: string | null,
  ): Promise<T[]> {
    const setting = await this.getCloudSetting(event, keyName, workspaceIdInput)
    return Array.isArray(setting?.value.items) ? setting.value.items as T[] : []
  }

  private async upsertCloudItemSetting<T extends { name: string; scope?: string; directory?: string | null }>(
    event: WorkspaceEventLike,
    keyName: string,
    item: T,
    workspaceIdInput?: string | null,
  ) {
    const items = await this.readCloudItemsSetting<T>(event, keyName, workspaceIdInput)
    const next = [
      ...items.filter((entry) => !this.sameScopedName(entry, item)),
      item,
    ].sort((left, right) => left.name.localeCompare(right.name))
    await this.setCloudSetting(event, keyName, { items: next }, workspaceIdInput)
  }

  private async removeCloudItemSetting(
    event: WorkspaceEventLike,
    keyName: string,
    target: ScopedArtifactRef,
    workspaceIdInput?: string | null,
  ) {
    const items = await this.readCloudItemsSetting<ScopedArtifactRef>(event, keyName, workspaceIdInput)
    const next = items.filter((entry) => !this.sameScopedName(entry, target))
    if (next.length === items.length) return false
    await this.setCloudSetting(event, keyName, { items: next }, workspaceIdInput)
    return true
  }

  private sameScopedName(
    left: { name: string; scope?: string; directory?: string | null },
    right: { name: string; scope?: string; directory?: string | null },
  ) {
    return left.name === right.name
      && (left.scope || 'machine') === (right.scope || 'machine')
      && (left.directory || null) === (right.directory || null)
  }

  private applyCredentialStatus(workspace: WorkspaceRegistration): WorkspaceRegistration {
    if (workspace.kind !== 'cloud') return workspace
    const accessToken = this.cloudCredentialStore?.getUsableAccessToken(workspace.id)
    const credential = accessToken ? null : this.cloudCredentialStore?.get(workspace.id)
    if (!accessToken && !credential?.refreshToken) return workspace
    return {
      ...workspace,
      status: 'online',
      error: null,
    }
  }

  private toInfo(workspace: WorkspaceRegistration, active: boolean): WorkspaceInfo {
    return {
      ...workspace,
      active,
      lastSyncedAt: this.syncedAtByWorkspace.get(workspace.id) || workspace.lastSyncedAt || null,
      status: workspace.status as WorkspaceStatus,
    }
  }
}

export function createWorkspaceGateway(options?: WorkspaceGatewayOptions) {
  return new WorkspaceGateway(options)
}
