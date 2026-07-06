import {
  WORKSPACE_SUPPORT_APIS,
  coordinationCapabilityFromWorkspaceApi,
  coordinationCapabilityStatus,
  workspaceApiSupportContextForAuthority,
} from '@open-cowork/shared'
import { log } from './logger.ts'
import { createKeyedSerializer } from './keyed-serializer.ts'
import type {
  AddCloudWorkspaceInput,
  AddGatewayWorkspaceInput,
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
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
  WorkspaceProductSurface,
  WorkspaceExecutionAuthority,
  WorkspaceStatus,
  WorkspaceSyncResult,
  ScopedArtifactRef,
  DesktopPairingPublicRecord,
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
  CloudTransportWorkspaceEvent,
} from '@open-cowork/cloud-server/transport-adapter'
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
import {
  createGatewayWorkspaceAdapter,
  type GatewayWorkspaceStatusAdapter,
} from './gateway-workspace-adapter.ts'
import {
  createFileGatewayWorkspaceRegistry,
  gatewayWorkspaceIdForBaseUrl,
  normalizeGatewayWorkspaceBaseUrl,
  type GatewayWorkspaceConnectionRecord,
  type GatewayWorkspaceRegistry,
} from './gateway-workspace-registry.ts'
import {
  createFileGatewayWorkspaceCredentialStore,
  type GatewayWorkspaceCredentialStore,
} from './gateway-workspace-credentials.ts'
import { DEFAULT_CONFIG, type CloudDesktopConfig } from '@open-cowork/shared'
import { createCloudSessionGateway } from './workspace-gateway-cloud-sessions.ts'
import { createCloudWorkflowGateway } from './workspace-gateway-cloud-workflows.ts'
import { createCloudThreadGateway } from './workspace-gateway-cloud-threads.ts'
import { createCloudArtifactGateway } from './workspace-gateway-cloud-artifacts.ts'
import { CloudSubscriptionManager } from './cloud-subscription-manager.ts'

export const LOCAL_WORKSPACE_ID = 'local'

type WorkspaceRegistration = Omit<WorkspaceInfo, 'active'>

type WorkspaceEventLike = { sender?: { id?: number } } | null | undefined

export type WorkspaceGatewayOptions = {
  workspaces?: WorkspaceRegistration[]
  cloudDesktop?: CloudDesktopConfig
  cloudRegistry?: CloudWorkspaceRegistry | null
  cloudCredentialStore?: CloudWorkspaceCredentialStore | null
  cloudCache?: CloudWorkspaceCache | null
  cloudAdapterFactory?: (connection: CloudWorkspaceConnectionRecord, accessToken?: string | null) => CloudWorkspaceSessionAdapter
  cloudLogin?: (connection: CloudWorkspaceConnectionRecord) => Promise<CloudWorkspaceLoginResult>
  cloudRefresh?: (connection: CloudWorkspaceConnectionRecord, refreshToken: string) => Promise<CloudWorkspaceLoginResult>
  cloudLoginBrandName?: string
  gatewayRegistry?: GatewayWorkspaceRegistry | null
  gatewayCredentialStore?: GatewayWorkspaceCredentialStore | null
  gatewayAdapterFactory?: (connection: GatewayWorkspaceConnectionRecord, token?: string | null) => GatewayWorkspaceStatusAdapter
  desktopPairingProvider?: (() => DesktopPairingPublicRecord[]) | null
  cloudReconnectBaseMs?: number
  cloudReconnectMaxMs?: number
  cloudReconnectMaxAttempts?: number
}

const LOCAL_WORKSPACE: WorkspaceRegistration = {
  id: LOCAL_WORKSPACE_ID,
  kind: 'local',
  authority: 'desktop_local',
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

const DISABLED_REMOTE_POLICY: WorkspacePolicy = {
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
    authority: 'cloud_worker',
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

function gatewayRegistrationFromConnection(
  connection: GatewayWorkspaceConnectionRecord,
  status: WorkspaceStatus = 'auth_required',
): WorkspaceRegistration {
  return {
    id: connection.id,
    kind: 'gateway',
    authority: 'gateway_standalone',
    label: connection.label,
    status,
    baseUrl: connection.baseUrl,
    lastSyncedAt: connection.lastSyncedAt,
    error: status === 'auth_required' ? 'Add a Gateway workspace token to enable this private Gateway connection.' : null,
  }
}

function gatewayConnectionFromWorkspace(workspace: WorkspaceRegistration): GatewayWorkspaceConnectionRecord {
  if (workspace.kind !== 'gateway' || !workspace.baseUrl) {
    throw new Error('Gateway workspace requires a base URL.')
  }
  const timestamp = new Date(0).toISOString()
  return {
    id: workspace.id,
    baseUrl: normalizeGatewayWorkspaceBaseUrl(workspace.baseUrl),
    label: workspace.label,
    lastSyncedAt: workspace.lastSyncedAt || null,
    createdAt: timestamp,
    updatedAt: timestamp,
  }
}

function pairedWorkspaceId(pairingId: string) {
  return `paired-desktop:${pairingId}`
}

function pairedRegistrationFromRecord(record: DesktopPairingPublicRecord): WorkspaceRegistration {
  const isOnline = record.enabled && !record.revokedAt && record.status === 'paired_online'
  const isRevoked = record.revokedAt || record.status === 'revoked'
  const status: WorkspaceStatus = isRevoked
    ? 'disabled'
    : isOnline
      ? 'online'
      : record.enabled
        ? 'offline'
        : 'disabled'
  const allowedSessions = record.allowedSessionIds === null
    ? 'all allowed sessions'
    : `${record.allowedSessionIds.length} allowed session${record.allowedSessionIds.length === 1 ? '' : 's'}`
  return {
    id: pairedWorkspaceId(record.id),
    kind: 'paired_desktop',
    authority: 'desktop_paired',
    label: record.label || record.deviceName || 'Paired Desktop',
    status,
    lastSyncedAt: record.lastHeartbeatAt || record.lastConnectedAt || null,
    error: isRevoked
      ? 'This Desktop pairing has been revoked.'
      : record.error || (status === 'offline' ? 'Paired Desktop connector is offline; remote mutations are disabled.' : null),
    profileName: allowedSessions,
  }
}

export class WorkspaceGateway {
  private readonly workspaces = new Map<string, WorkspaceRegistration>()
  private readonly cloudConnections = new Map<string, CloudWorkspaceConnectionRecord>()
  private readonly gatewayConnections = new Map<string, GatewayWorkspaceConnectionRecord>()
  private readonly cloudAdapters = new Map<string, CloudWorkspaceSessionAdapter>()
  private readonly gatewayAdapters = new Map<string, GatewayWorkspaceStatusAdapter>()
  private readonly cloudSubscriptions: CloudSubscriptionManager
  private readonly managedCloudWorkspaceIds = new Set<string>()
  private readonly activeBySender = new Map<number, string>()
  private readonly syncedAtByWorkspace = new Map<string, string>()
  private readonly cloudDesktopConfig: CloudDesktopConfig
  private readonly cloudRegistry: CloudWorkspaceRegistry | null
  private readonly cloudCredentialStore: CloudWorkspaceCredentialStore | null
  private readonly gatewayRegistry: GatewayWorkspaceRegistry | null
  private readonly gatewayCredentialStore: GatewayWorkspaceCredentialStore | null
  private cloudCache: CloudWorkspaceCache | null | undefined
  // Serializes the cloud item-setting read-modify-write per (workspace, settings-key) (audit P1-X1).
  // The RMW spans awaits, so without this two concurrent saves would last-write-win and silently
  // drop a saved agent/MCP/skill.
  private readonly itemSettingSerializer = createKeyedSerializer()
  private readonly cloudAdapterFactory: (connection: CloudWorkspaceConnectionRecord, accessToken?: string | null) => CloudWorkspaceSessionAdapter
  private readonly gatewayAdapterFactory: (connection: GatewayWorkspaceConnectionRecord, token?: string | null) => GatewayWorkspaceStatusAdapter
  private desktopPairingProvider: (() => DesktopPairingPublicRecord[]) | null
  private readonly cloudLogin: (connection: CloudWorkspaceConnectionRecord) => Promise<CloudWorkspaceLoginResult>
  private readonly cloudRefresh: (connection: CloudWorkspaceConnectionRecord, refreshToken: string) => Promise<CloudWorkspaceLoginResult>
  private readonly cloudReconnectBaseMs: number
  private readonly cloudReconnectMaxMs: number
  private readonly cloudReconnectMaxAttempts: number
  private readonly cloudSessions = createCloudSessionGateway({
    resolveAdapter: (event, workspaceIdInput) => this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput)),
    resolveWorkspaceAndAdapter: async (event, workspaceIdInput) => {
      const workspace = this.resolveWorkspace(event, workspaceIdInput)
      const adapter = await this.requireCloudAdapter(workspace)
      return { workspaceId: workspace.id, adapter }
    },
    onSessionImported: (workspaceId, syncedAt) => {
      this.syncedAtByWorkspace.set(workspaceId, syncedAt)
      this.cloudRegistry?.touchSync(workspaceId, syncedAt)
    },
  })
  private readonly cloudWorkflows = createCloudWorkflowGateway(
    (event, workspaceIdInput) => this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput)),
  )
  private readonly cloudThreads = createCloudThreadGateway(
    (event, workspaceIdInput) => this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput)),
  )
  private readonly cloudArtifacts = createCloudArtifactGateway(
    (event, workspaceIdInput) => this.requireCloudAdapter(this.resolveWorkspace(event, workspaceIdInput)),
  )

  constructor(options: WorkspaceGatewayOptions = {}) {
    this.cloudDesktopConfig = options.cloudDesktop || DEFAULT_CONFIG.cloudDesktop
    this.cloudRegistry = options.cloudRegistry === undefined ? createFileCloudWorkspaceRegistry() : options.cloudRegistry
    this.cloudCredentialStore = options.cloudCredentialStore === undefined ? createFileCloudWorkspaceCredentialStore() : options.cloudCredentialStore
    this.gatewayRegistry = options.gatewayRegistry === undefined ? createFileGatewayWorkspaceRegistry() : options.gatewayRegistry
    this.gatewayCredentialStore = options.gatewayCredentialStore === undefined ? createFileGatewayWorkspaceCredentialStore() : options.gatewayCredentialStore
    this.cloudCache = options.cloudCache
    this.cloudAdapterFactory = options.cloudAdapterFactory || ((connection, accessToken) => createCloudWorkspaceAdapter(connection, accessToken, {
      cache: this.getCloudCache(),
      cacheMode: this.cloudDesktopConfig.cacheMode,
      cacheEncryptionFallback: this.cloudDesktopConfig.cacheEncryptionFallback,
    }))
    this.gatewayAdapterFactory = options.gatewayAdapterFactory || ((connection, token) => createGatewayWorkspaceAdapter(connection, token))
    this.desktopPairingProvider = options.desktopPairingProvider || null
    const authenticator = createCloudWorkspaceDesktopAuthenticator({
      brandName: options.cloudLoginBrandName || DEFAULT_CONFIG.branding.name,
    })
    this.cloudLogin = options.cloudLogin || ((connection) => authenticator.login(connection))
    this.cloudRefresh = options.cloudRefresh || ((connection, refreshToken) => authenticator.refresh(connection, refreshToken))
    this.cloudReconnectBaseMs = Math.max(0, options.cloudReconnectBaseMs ?? 500)
    this.cloudReconnectMaxMs = Math.max(this.cloudReconnectBaseMs, options.cloudReconnectMaxMs ?? 10_000)
    this.cloudReconnectMaxAttempts = Math.max(0, options.cloudReconnectMaxAttempts ?? 8)
    this.cloudSubscriptions = new CloudSubscriptionManager({
      resolveWorkspace: (event, workspaceIdInput) => this.resolveWorkspace(event, workspaceIdInput),
      getWorkspace: (workspaceId) => this.workspaces.get(workspaceId),
      requireCloudAdapter: (workspace) => this.requireCloudAdapter(workspace),
      reconnectBaseMs: this.cloudReconnectBaseMs,
      reconnectMaxMs: this.cloudReconnectMaxMs,
      reconnectMaxAttempts: this.cloudReconnectMaxAttempts,
    })
    this.registerWorkspace(LOCAL_WORKSPACE)
    for (const connection of this.gatewayRegistry?.list() || []) {
      this.gatewayConnections.set(connection.id, connection)
      this.registerWorkspace(this.applyGatewayCredentialStatus(gatewayRegistrationFromConnection(connection)))
    }
    for (const workspace of options.workspaces || []) {
      if (workspace.kind !== 'cloud') this.registerWorkspace(workspace)
    }
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
    if (workspace.kind === 'gateway' && workspace.baseUrl && !this.gatewayConnections.has(workspace.id)) {
      this.gatewayConnections.set(workspace.id, gatewayConnectionFromWorkspace(workspace))
    }
  }

  setDesktopPairingProvider(provider: (() => DesktopPairingPublicRecord[]) | null) {
    this.desktopPairingProvider = provider
  }

  list(event?: WorkspaceEventLike): WorkspaceInfo[] {
    const activeId = this.activeWorkspaceId(event)
    const registrations = new Map(this.workspaces)
    for (const pairing of this.desktopPairingProvider?.() || []) {
      const paired = pairedRegistrationFromRecord(pairing)
      registrations.set(paired.id, paired)
    }
    return Array.from(registrations.values()).map((workspace) => this.toInfo(workspace, workspace.id === activeId))
  }

  activate(event: WorkspaceEventLike, workspaceIdInput: string): WorkspaceInfo {
    const workspace = this.getWorkspace(workspaceIdInput)
    const sender = senderKey(event)
    const previousWorkspaceId = this.activeBySender.get(sender)
    this.activeBySender.set(sender, workspace.id)
    if (
      previousWorkspaceId
      && previousWorkspaceId !== workspace.id
      && previousWorkspaceId !== LOCAL_WORKSPACE_ID
      && !this.hasActiveSenderForWorkspace(previousWorkspaceId)
    ) {
      this.closeCloudSubscriptionsForWorkspace(previousWorkspaceId)
    }
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

  addGateway(event: WorkspaceEventLike, input: AddGatewayWorkspaceInput): WorkspaceInfo {
    if (!input || typeof input.baseUrl !== 'string' || !input.baseUrl.trim()) {
      throw new Error('Gateway workspace URL is required.')
    }
    const baseUrl = normalizeGatewayWorkspaceBaseUrl(input.baseUrl)
    const connection = this.gatewayRegistry?.upsert({
      baseUrl,
      label: input.label,
    }) || {
      id: gatewayWorkspaceIdForBaseUrl(baseUrl),
      baseUrl,
      label: input.label?.trim() || new URL(baseUrl).host,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastSyncedAt: null,
    }
    this.gatewayConnections.set(connection.id, connection)
    if (input.token?.trim()) {
      if (!this.gatewayCredentialStore) throw new Error('Gateway workspace credential storage is not configured.')
      this.gatewayCredentialStore.save({
        workspaceId: connection.id,
        token: input.token,
      })
    }
    const workspace = this.applyGatewayCredentialStatus(gatewayRegistrationFromConnection(connection))
    this.registerWorkspace(workspace)
    return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
  }

  remove(event: WorkspaceEventLike, workspaceIdInput: string): boolean {
    const workspaceId = normalizeWorkspaceId(workspaceIdInput)
    if (!workspaceId || workspaceId === LOCAL_WORKSPACE_ID) return false
    if (this.cloudDesktopConfig.requireManagedOrg && this.managedCloudWorkspaceIds.has(workspaceId)) return false
    const connection = this.cloudConnections.get(workspaceId)
    const gatewayConnection = this.gatewayConnections.get(workspaceId)
    const removed = this.workspaces.delete(workspaceId)
    const persistedRemoved = this.cloudRegistry?.remove(workspaceId) || false
    const gatewayPersistedRemoved = this.gatewayRegistry?.remove(workspaceId) || false
    this.cloudCredentialStore?.remove(workspaceId)
    this.gatewayCredentialStore?.remove(workspaceId)
    this.clearCloudCache(connection)
    this.cloudConnections.delete(workspaceId)
    this.gatewayConnections.delete(workspaceId)
    this.cloudAdapters.delete(workspaceId)
    this.gatewayAdapters.delete(workspaceId)
    this.closeCloudSubscriptionsForWorkspace(workspaceId)
    for (const [sender, activeWorkspaceId] of this.activeBySender.entries()) {
      if (activeWorkspaceId === workspaceId) this.activeBySender.set(sender, LOCAL_WORKSPACE_ID)
    }
    this.syncedAtByWorkspace.delete(workspaceId)
    // Resolve the active workspace for this sender so callers see a stable
    // local fallback after removing a selected cloud placeholder.
    this.activeWorkspaceId(event)
    return removed || persistedRemoved || gatewayPersistedRemoved || Boolean(gatewayConnection)
  }

  async login(event: WorkspaceEventLike, workspaceIdInput: string): Promise<WorkspaceInfo> {
    const workspace = this.getWorkspace(workspaceIdInput)
    if (workspace.kind === 'local') return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
    if (workspace.kind === 'gateway') {
      throw new Error('Gateway workspaces use stored workspace tokens. Update the Gateway connection instead of starting Cloud login.')
    }
    if (workspace.kind === 'paired_desktop') {
      throw new Error('Paired Desktop workspaces are controlled by the local pairing connector.')
    }
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
    if (workspace.kind === 'gateway') {
      this.gatewayCredentialStore?.remove(workspace.id)
      this.gatewayAdapters.delete(workspace.id)
      const next = {
        ...workspace,
        status: 'auth_required',
        error: 'Add a Gateway workspace token to enable this private Gateway connection.',
      } satisfies WorkspaceRegistration
      this.workspaces.set(workspace.id, next)
      return this.toInfo(next, workspace.id === this.activeWorkspaceId(event))
    }
    if (workspace.kind === 'paired_desktop') {
      return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
    }
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
    if (workspace.kind === 'local') return LOCAL_WORKSPACE_POLICY
    if (workspace.kind === 'cloud') return DISABLED_CLOUD_POLICY
    return DISABLED_REMOTE_POLICY
  }

  async cloudPolicy(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspacePolicy> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'local') return LOCAL_WORKSPACE_POLICY
    if (workspace.kind !== 'cloud') return DISABLED_REMOTE_POLICY
    try {
      return (await this.requireCloudAdapter(workspace)).policy()
    } catch (error) {
      // Fail closed to the disabled policy, but log — otherwise a transient cloud
      // outage (network/adapter failure) is indistinguishable from a real policy
      // denial, so a workspace silently loses capabilities with no diagnostic trail.
      log('workspace-gateway', `Cloud policy lookup failed for workspace ${workspace.id}; using disabled policy: ${error instanceof Error ? error.message : String(error)}`)
      return DISABLED_CLOUD_POLICY
    }
  }

  async supportMatrix(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceApiSupport[]> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'local') {
      return WORKSPACE_SUPPORT_APIS.map((api) => ({
        api,
        ...this.localSupportForApi(api, workspace.status),
      }))
    }
    if (workspace.kind === 'gateway') {
      return this.remoteSupportMatrix({
        authority: 'gateway_standalone',
        surface: 'gateway_standalone',
        workspace,
        deferredReason: 'Desktop Gateway sessions are deferred until Standalone Gateway exposes a Desktop-safe session and projection API.',
        pathReason: 'Gateway workspaces do not expose private Gateway host paths to Desktop.',
        workflowReason: 'Gateway workflow control from Desktop is deferred until the Standalone Gateway API is available.',
        artifactReason: 'Gateway artifact browsing from Desktop is deferred until the Standalone Gateway artifact API is available.',
        settingsReason: 'Gateway runtime settings stay owned by the Standalone Gateway deployment.',
        customContentReason: 'Gateway custom content stays owned by the Standalone Gateway deployment.',
        capabilitiesReason: 'Gateway capability catalog sync is deferred until the Standalone Gateway API is available.',
      })
    }
    if (workspace.kind === 'paired_desktop') {
      const pairingReason = workspace.status === 'online'
        ? 'Paired Desktop workspace browsing is deferred until the edge registration API is available.'
        : 'Paired Desktop connector is offline or disabled.'
      return this.remoteSupportMatrix({
        authority: 'desktop_paired',
        surface: 'desktop_paired',
        workspace,
        deferredReason: pairingReason,
        pathReason: 'Paired Desktop workspaces redact local paths from remote surfaces by default.',
        workflowReason: 'Paired Desktop workflow control is deferred until pairing workflow policy exists.',
        artifactReason: 'Paired Desktop exposes redacted artifact metadata only until artifact-body policy is explicit.',
        settingsReason: 'Paired Desktop settings remain local to the owning Desktop.',
        customContentReason: 'Paired Desktop custom content remains local to the owning Desktop.',
        capabilitiesReason: 'Paired Desktop capability sync is deferred until remote projection policy exists.',
      })
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
      context: workspaceApiSupportContextForAuthority('cloud_worker', {
        surface: 'desktop_cloud',
        onlineState: workspace.status,
        status,
        pathExposure: status === 'not_supported' ? 'not_exposed' : 'cloud_safe_refs',
        ...(api === 'artifacts.reveal' ? { artifactReveal: 'none' as const } : {}),
        ...(reason
          ? {
              blockedReason: {
                allowed: status === 'supported' || status === 'read_only',
                reason,
                policyCode: status,
              },
            }
          : {}),
      }),
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
      cloudSupport('coordination.projects', 'deferred', 'Cloud project coordination is deferred until the shared coordination control plane is available.'),
      cloudSupport('coordination.tasks', 'deferred', 'Cloud task coordination is deferred until the shared coordination control plane is available.'),
      supportedIf('coordination.runs', feature('workflows'), 'Cloud coordination runs are disabled by this workspace policy.'),
      supportedIf('coordination.schedules', feature('workflows'), 'Cloud schedules are disabled by this workspace policy.'),
      cloudSupport('coordination.watches', 'deferred', 'Cloud watch management is deferred in the desktop Cloud surface until the WorkspaceGateway adapter is wired.'),
      cloudSupport('coordination.delegation', 'deferred', 'Cloud delegation coordination is deferred until the shared coordination control plane is available.'),
      supportedIf('artifacts.list', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.index', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.status', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.upload', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      supportedIf('artifacts.download', feature('artifacts'), 'Cloud artifacts are disabled by this workspace policy.'),
      cloudSupport('artifacts.reveal', 'not_supported', 'Cloud artifacts cannot be revealed in the local filesystem. Export the artifact instead.'),
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

  private localSupportForApi(api: string, workspaceStatus: WorkspaceStatus): Omit<WorkspaceApiSupport, 'api'> {
    const capability = coordinationCapabilityFromWorkspaceApi(api)
    const status = capability ? coordinationCapabilityStatus('desktop_local', capability) : 'supported'
    const reason = this.localSupportReason(api, status)
    return {
      status,
      verdict: {
        allowed: status === 'supported' || status === 'read_only',
        reason,
        ...(reason ? { policyCode: status } : {}),
      },
      context: workspaceApiSupportContextForAuthority('desktop_local', {
        surface: 'desktop_local',
        onlineState: workspaceStatus,
        status,
        ...(reason
          ? {
              blockedReason: {
                allowed: status === 'supported' || status === 'read_only',
                reason,
                policyCode: status,
              },
            }
          : {}),
      }),
    }
  }

  private localSupportReason(api: string, status: WorkspaceApiSupportStatus): string | null {
    if (status === 'supported' || status === 'read_only') return null
    if (api === 'coordination.watches') return 'Desktop Local watch subscriptions require a channel delivery target.'
    if (status === 'deferred') return 'This Desktop Local capability is deferred until its product surface is implemented.'
    return 'This Desktop Local capability is not supported.'
  }

  private remoteSupportMatrix(input: {
    authority: WorkspaceExecutionAuthority
    surface: WorkspaceProductSurface
    workspace: WorkspaceRegistration
    deferredReason: string
    pathReason: string
    workflowReason: string
    artifactReason: string
    settingsReason: string
    customContentReason: string
    capabilitiesReason: string
  }): WorkspaceApiSupport[] {
    const remoteSupport = (
      api: string,
      status: WorkspaceApiSupportStatus,
      reason: string | null,
      options: {
        artifactBody?: 'gateway_artifact_store' | 'redacted_metadata_only' | 'none'
        artifactReveal?: 'gateway_artifact_store' | 'redacted_metadata_only' | 'none'
      } = {},
    ): WorkspaceApiSupport => ({
      api,
      status,
      verdict: {
        allowed: status === 'supported' || status === 'read_only',
        reason,
        ...(reason ? { policyCode: status === 'deferred' ? 'workspace.deferred' : 'workspace.not_supported' } : {}),
      },
      context: workspaceApiSupportContextForAuthority(input.authority, {
        surface: input.surface,
        onlineState: input.workspace.status,
        status,
        pathExposure: 'redacted_remote',
        pairingState: input.authority === 'desktop_paired'
          ? input.workspace.status === 'online' ? 'paired_online' : input.workspace.status === 'offline' ? 'paired_offline' : 'pairing_required'
          : 'not_applicable',
        workflows: status === 'deferred' ? 'deferred' : 'not_supported',
        ...(options.artifactBody ? { artifactBody: options.artifactBody } : {}),
        ...(options.artifactReveal ? { artifactReveal: options.artifactReveal } : {}),
        ...(reason
          ? {
              blockedReason: {
                allowed: false,
                reason,
                policyCode: status === 'deferred' ? 'workspace.deferred' : 'workspace.not_supported',
              },
            }
          : {}),
      }),
    })

    return [
      remoteSupport('sessions.list', 'deferred', input.deferredReason),
      remoteSupport('sessions.create', 'deferred', input.deferredReason),
      remoteSupport('sessions.activate', 'deferred', input.deferredReason),
      remoteSupport('sessions.get', 'deferred', input.deferredReason),
      remoteSupport('sessions.prompt', 'deferred', input.deferredReason),
      remoteSupport('sessions.abort', 'deferred', input.deferredReason),
      remoteSupport('sessions.fileSnippet', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
      remoteSupport('sessions.diff', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
      remoteSupport('threads.search', 'deferred', input.deferredReason),
      remoteSupport('threads.tags', 'deferred', input.deferredReason),
      remoteSupport('threads.smartFilters', 'deferred', input.deferredReason),
      remoteSupport('workflows.list', 'deferred', input.workflowReason),
      remoteSupport('workflows.run', 'deferred', input.workflowReason),
      remoteSupport('coordination.projects', 'deferred', input.deferredReason),
      remoteSupport('coordination.tasks', 'deferred', input.deferredReason),
      remoteSupport('coordination.runs', 'deferred', input.deferredReason),
      remoteSupport('coordination.schedules', 'deferred', input.workflowReason),
      remoteSupport('coordination.watches', 'deferred', input.deferredReason),
      remoteSupport('coordination.delegation', 'deferred', input.deferredReason),
      remoteSupport('artifacts.list', 'deferred', input.artifactReason, {
        artifactBody: input.authority === 'gateway_standalone' ? 'gateway_artifact_store' : 'redacted_metadata_only',
        artifactReveal: 'none',
      }),
      remoteSupport('artifacts.index', 'deferred', input.artifactReason, { artifactBody: 'redacted_metadata_only', artifactReveal: 'none' }),
      remoteSupport('artifacts.status', 'deferred', input.artifactReason, { artifactBody: 'redacted_metadata_only', artifactReveal: 'none' }),
      remoteSupport('artifacts.upload', 'deferred', input.artifactReason, { artifactReveal: 'none' }),
      remoteSupport('artifacts.download', 'deferred', input.artifactReason, {
        artifactBody: input.authority === 'gateway_standalone' ? 'gateway_artifact_store' : 'redacted_metadata_only',
        artifactReveal: 'none',
      }),
      remoteSupport('artifacts.reveal', 'not_supported', 'Remote workspace artifacts cannot be revealed in the local filesystem.', { artifactBody: 'none', artifactReveal: 'none' }),
      remoteSupport('settings.portable', 'not_supported', input.settingsReason),
      remoteSupport('customContent.agents', 'not_supported', input.customContentReason),
      remoteSupport('customContent.skills', 'not_supported', input.customContentReason),
      remoteSupport('customContent.mcps', 'not_supported', input.customContentReason),
      remoteSupport('capabilities.catalog', 'deferred', input.capabilitiesReason),
      remoteSupport('localFiles', 'not_supported', input.pathReason, { artifactBody: 'none', artifactReveal: 'none' }),
      remoteSupport('localStdioMcps', 'not_supported', 'Remote workspaces do not execute this Desktop app\'s local stdio MCPs.'),
      remoteSupport('machineRuntimeConfig', 'not_supported', 'Remote workspaces do not use this Desktop app\'s machine-native runtime config.'),
    ]
  }

  async sync(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceSyncResult> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind === 'cloud') {
      const adapter = await this.requireCloudAdapter(workspace)
      if (adapter.sync) {
        await adapter.sync()
      } else {
        await adapter.listSessions()
      }
    } else if (workspace.kind === 'gateway') {
      await this.syncGatewayWorkspace(workspace)
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
    } else if (workspace.kind === 'gateway') {
      this.gatewayRegistry?.touchSync(workspace.id, syncedAt)
      const latestWorkspace = this.workspaces.get(workspace.id) || workspace
      this.workspaces.set(workspace.id, {
        ...latestWorkspace,
        lastSyncedAt: syncedAt,
        status: 'online',
        error: null,
      })
    }
    return { ok: true, syncedAt }
  }

  activeWorkspaceId(event?: WorkspaceEventLike) {
    const active = this.activeBySender.get(senderKey(event))
    return active && this.workspaceExists(active) ? active : LOCAL_WORKSPACE_ID
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
    return this.cloudSessions.listSessions(event, workspaceIdInput)
  }

  async createCloudSession(
    event: WorkspaceEventLike,
    workspaceIdInput?: string | null,
    input: { projectSource?: CloudProjectSourceInput | null } = {},
  ): Promise<SessionInfo> {
    return this.cloudSessions.createSession(event, workspaceIdInput, input)
  }

  async validateCloudProjectSource(
    event: WorkspaceEventLike,
    workspaceIdInput: string | null | undefined,
    projectSource: CloudProjectSourceInput,
  ): Promise<CloudProjectSourcePolicyVerdict> {
    return this.cloudSessions.validateProjectSource(event, workspaceIdInput, projectSource)
  }

  async uploadCloudProjectSnapshot(
    event: WorkspaceEventLike,
    workspaceIdInput: string | null | undefined,
    input: CloudProjectSnapshotUploadInput,
  ): Promise<CloudProjectSnapshotUploadResult> {
    return this.cloudSessions.uploadProjectSnapshot(event, workspaceIdInput, input)
  }

  async importLocalSessionToCloud(
    event: WorkspaceEventLike,
    input: SessionImportRequest,
    workspaceIdInput: string,
  ): Promise<SessionImportResult & { view: SessionView }> {
    return this.cloudSessions.importSession(event, input, workspaceIdInput)
  }

  async getCloudSessionInfo(event: WorkspaceEventLike, sessionId: string, workspaceIdInput?: string | null): Promise<SessionInfo | null> {
    return this.cloudSessions.getSessionInfo(event, sessionId, workspaceIdInput)
  }

  async getCloudSessionView(event: WorkspaceEventLike, sessionId: string, workspaceIdInput?: string | null): Promise<SessionView> {
    return this.cloudSessions.getSessionView(event, sessionId, workspaceIdInput)
  }

  async promptCloudSession(
    event: WorkspaceEventLike,
    sessionId: string,
    input: CloudPromptInput,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await this.cloudSessions.promptSession(event, sessionId, input, workspaceIdInput)
  }

  async abortCloudSession(
    event: WorkspaceEventLike,
    sessionId: string,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await this.cloudSessions.abortSession(event, sessionId, workspaceIdInput)
  }

  async replyCloudQuestion(
    event: WorkspaceEventLike,
    sessionId: string,
    requestId: string,
    answers: unknown[],
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await this.cloudSessions.replyToQuestion(event, sessionId, requestId, answers, workspaceIdInput)
  }

  async rejectCloudQuestion(
    event: WorkspaceEventLike,
    sessionId: string,
    requestId: string,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await this.cloudSessions.rejectQuestion(event, sessionId, requestId, workspaceIdInput)
  }

  async respondCloudPermission(
    event: WorkspaceEventLike,
    sessionId: string,
    permissionId: string,
    allowed: boolean,
    workspaceIdInput?: string | null,
  ): Promise<void> {
    await this.cloudSessions.respondToPermission(event, sessionId, permissionId, allowed, workspaceIdInput)
  }

  async listCloudWorkflows(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkflowListPayload> {
    return this.cloudWorkflows.list(event, workspaceIdInput)
  }

  async getCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    return this.cloudWorkflows.get(event, workflowId, workspaceIdInput)
  }

  async runCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowRun | null> {
    return this.cloudWorkflows.run(event, workflowId, workspaceIdInput)
  }

  async pauseCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    return this.cloudWorkflows.pause(event, workflowId, workspaceIdInput)
  }

  async resumeCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    return this.cloudWorkflows.resume(event, workflowId, workspaceIdInput)
  }

  async archiveCloudWorkflow(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowDetail | null> {
    return this.cloudWorkflows.archive(event, workflowId, workspaceIdInput)
  }

  async searchCloudThreads(
    event: WorkspaceEventLike,
    query?: ThreadSearchQuery,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSearchResult> {
    return this.cloudThreads.search(event, query, workspaceIdInput)
  }

  async cloudThreadFacets(
    event: WorkspaceEventLike,
    query?: ThreadSearchQuery,
    workspaceIdInput?: string | null,
  ): Promise<ThreadFacetSummary> {
    return this.cloudThreads.facets(event, query, workspaceIdInput)
  }

  async listCloudThreadTags(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadTag[]> {
    return this.cloudThreads.listTags(event, workspaceIdInput)
  }

  async createCloudThreadTag(
    event: WorkspaceEventLike,
    input: ThreadTagInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadTag> {
    return this.cloudThreads.createTag(event, input, workspaceIdInput)
  }

  async updateCloudThreadTag(
    event: WorkspaceEventLike,
    tagId: string,
    input: ThreadTagInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadTag | null> {
    return this.cloudThreads.updateTag(event, tagId, input, workspaceIdInput)
  }

  async deleteCloudThreadTag(
    event: WorkspaceEventLike,
    tagId: string,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.cloudThreads.deleteTag(event, tagId, workspaceIdInput)
  }

  async applyCloudThreadTags(
    event: WorkspaceEventLike,
    sessionIds: string[],
    tagIds: string[],
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.cloudThreads.applyTags(event, sessionIds, tagIds, workspaceIdInput)
  }

  async removeCloudThreadTags(
    event: WorkspaceEventLike,
    sessionIds: string[],
    tagIds: string[],
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.cloudThreads.removeTags(event, sessionIds, tagIds, workspaceIdInput)
  }

  async listCloudThreadSmartFilters(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<ThreadSmartFilter[]> {
    return this.cloudThreads.listSmartFilters(event, workspaceIdInput)
  }

  async createCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    input: ThreadSmartFilterInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSmartFilter> {
    return this.cloudThreads.createSmartFilter(event, input, workspaceIdInput)
  }

  async updateCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    filterId: string,
    input: ThreadSmartFilterInput,
    workspaceIdInput?: string | null,
  ): Promise<ThreadSmartFilter | null> {
    return this.cloudThreads.updateSmartFilter(event, filterId, input, workspaceIdInput)
  }

  async deleteCloudThreadSmartFilter(
    event: WorkspaceEventLike,
    filterId: string,
    workspaceIdInput?: string | null,
  ): Promise<boolean> {
    return this.cloudThreads.deleteSmartFilter(event, filterId, workspaceIdInput)
  }

  async listCloudArtifacts(
    event: WorkspaceEventLike,
    sessionId: string,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifact[]> {
    return this.cloudArtifacts.list(event, sessionId, workspaceIdInput)
  }

  async indexCloudArtifacts(
    event: WorkspaceEventLike,
    request: ArtifactIndexRequest,
    workspaceIdInput?: string | null,
  ): Promise<ArtifactIndexPayload> {
    return this.cloudArtifacts.index(event, request, workspaceIdInput)
  }

  async launchpadFeed(
    event: WorkspaceEventLike,
    request: LaunchpadFeedRequest,
    workspaceIdInput?: string | null,
  ): Promise<LaunchpadFeedPayload> {
    return this.cloudArtifacts.launchpadFeed(event, request, workspaceIdInput)
  }

  async updateCloudArtifactStatus(
    event: WorkspaceEventLike,
    request: ArtifactStatusUpdateRequest,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifact> {
    return this.cloudArtifacts.updateStatus(event, request, workspaceIdInput)
  }

  async uploadCloudArtifact(
    event: WorkspaceEventLike,
    input: SessionArtifactUploadRequest,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifact> {
    return this.cloudArtifacts.upload(event, input, workspaceIdInput)
  }

  async readCloudArtifactAttachment(
    event: WorkspaceEventLike,
    sessionId: string,
    filePathOrArtifactId: string,
    workspaceIdInput?: string | null,
  ): Promise<SessionArtifactAttachment> {
    return this.cloudArtifacts.readAttachment(event, sessionId, filePathOrArtifactId, workspaceIdInput)
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
    return this.cloudSubscriptions.subscribeSessionEvents(event, sessionId, input)
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
    return this.cloudSubscriptions.subscribeWorkspaceEvents(event, input)
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
    if (workspace) return workspace
    const paired = this.resolvePairedWorkspace(workspaceId)
    if (paired) return paired
    throw new Error(`Unknown workspace: ${workspaceId}`)
  }

  private workspaceExists(workspaceId: string) {
    if (this.workspaces.has(workspaceId)) return true
    return Boolean(this.resolvePairedWorkspace(workspaceId))
  }

  private resolvePairedWorkspace(workspaceId: string): WorkspaceRegistration | null {
    for (const pairing of this.desktopPairingProvider?.() || []) {
      if (pairedWorkspaceId(pairing.id) === workspaceId) return pairedRegistrationFromRecord(pairing)
    }
    return null
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

  private requireGatewayAdapter(workspace: WorkspaceRegistration): GatewayWorkspaceStatusAdapter {
    if (workspace.kind !== 'gateway') throw new Error('This action requires a Gateway workspace.')
    const connection = this.gatewayConnections.get(workspace.id)
    if (!connection) throw new Error('Gateway workspace connection is missing.')
    const token = this.gatewayCredentialStore?.getToken(workspace.id) || null
    if (!token) {
      const latestWorkspace = this.workspaces.get(workspace.id) || workspace
      throw new Error(latestWorkspace.error || 'Gateway workspace token is required.')
    }
    const existing = this.gatewayAdapters.get(workspace.id)
    if (existing) return existing
    const adapter = this.gatewayAdapterFactory(connection, token)
    this.gatewayAdapters.set(workspace.id, adapter)
    return adapter
  }

  private async syncGatewayWorkspace(workspace: WorkspaceRegistration) {
    try {
      await this.requireGatewayAdapter(workspace).sync()
      this.workspaces.set(workspace.id, {
        ...workspace,
        status: 'online',
        error: null,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.gatewayAdapters.delete(workspace.id)
      const missingToken = /token is required|credential|authorization|unauthorized|401|403/i.test(message)
      this.workspaces.set(workspace.id, {
        ...workspace,
        status: missingToken ? 'auth_required' : 'offline',
        error: missingToken
          ? 'Add a Gateway workspace token to enable this private Gateway connection.'
          : message || 'Gateway workspace is offline or unavailable. Retry when the connection recovers.',
      })
      throw error
    }
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

  private closeCloudSubscriptionsForWorkspace(workspaceId: string) {
    this.cloudSubscriptions.closeForWorkspace(workspaceId)
  }

  private hasActiveSenderForWorkspace(workspaceId: string) {
    for (const activeWorkspaceId of this.activeBySender.values()) {
      if (activeWorkspaceId === workspaceId) return true
    }
    return false
  }

  private async readCloudItemsSetting<T extends { name: string }>(
    event: WorkspaceEventLike,
    keyName: string,
    workspaceIdInput?: string | null,
  ): Promise<T[]> {
    const setting = await this.getCloudSetting(event, keyName, workspaceIdInput)
    return Array.isArray(setting?.value.items) ? setting.value.items as T[] : []
  }

  // Serialize a read-modify-write on one cloud item-setting per (workspace, key) (audit P1-X1).
  private serializeCloudItemSetting<T>(
    event: WorkspaceEventLike,
    keyName: string,
    workspaceIdInput: string | null | undefined,
    task: () => Promise<T>,
  ): Promise<T> {
    const lockKey = `${this.resolveWorkspace(event, workspaceIdInput).id}\u0000${keyName}`
    return this.itemSettingSerializer.run(lockKey, task)
  }

  private async upsertCloudItemSetting<T extends { name: string; scope?: string; directory?: string | null }>(
    event: WorkspaceEventLike,
    keyName: string,
    item: T,
    workspaceIdInput?: string | null,
  ) {
    return this.serializeCloudItemSetting(event, keyName, workspaceIdInput, async () => {
      const items = await this.readCloudItemsSetting<T>(event, keyName, workspaceIdInput)
      const next = [
        ...items.filter((entry) => !this.sameScopedName(entry, item)),
        item,
      ].sort((left, right) => left.name.localeCompare(right.name))
      await this.setCloudSetting(event, keyName, { items: next }, workspaceIdInput)
    })
  }

  private async removeCloudItemSetting(
    event: WorkspaceEventLike,
    keyName: string,
    target: ScopedArtifactRef,
    workspaceIdInput?: string | null,
  ) {
    return this.serializeCloudItemSetting(event, keyName, workspaceIdInput, async () => {
      const items = await this.readCloudItemsSetting<ScopedArtifactRef>(event, keyName, workspaceIdInput)
      const next = items.filter((entry) => !this.sameScopedName(entry, target))
      if (next.length === items.length) return false
      await this.setCloudSetting(event, keyName, { items: next }, workspaceIdInput)
      return true
    })
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

  private applyGatewayCredentialStatus(workspace: WorkspaceRegistration): WorkspaceRegistration {
    if (workspace.kind !== 'gateway') return workspace
    const token = this.gatewayCredentialStore?.getToken(workspace.id)
    if (!token) return workspace
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
