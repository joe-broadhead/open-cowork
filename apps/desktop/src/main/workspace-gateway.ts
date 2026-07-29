import { log } from '@open-cowork/shared/node'
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
  WorkflowWebhookSecretMutationResult,
  WorkspaceInfo,
  WorkspaceApiSupport,
  WorkspacePolicy,
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
  assertWorkspaceSessionPort,
  type WorkspaceSessionPort,
} from './workspace-session-port.ts'
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
import {
  applyGatewayCredentialStatus,
  assertGatewayCredentialCleared,
  GatewayCredentialStorageReadError,
  gatewayConnectionFromWorkspace,
  gatewayCredentialFailureWorkspaceStatus,
  gatewayCredentialReadError,
  gatewayRegistrationFromConnection,
  resetGatewayCredentialWorkspaceStates,
  type WorkspaceRegistration,
} from './workspace/workspace-gateway-credential-state.ts'
import { DEFAULT_CONFIG, type CloudDesktopConfig } from '@open-cowork/shared'
import { createCloudSessionGateway } from './workspace-gateway-cloud-sessions.ts'
import { createCloudWorkflowGateway } from './workspace-gateway-cloud-workflows.ts'
import { createCloudThreadGateway } from './workspace-gateway-cloud-threads.ts'
import { createCloudArtifactGateway } from './workspace-gateway-cloud-artifacts.ts'
import { CloudSubscriptionManager } from './cloud-subscription-manager.ts'
import {
  LOCAL_WORKSPACE,
  LOCAL_WORKSPACE_ID,
  cloudConnectionFromWorkspace,
  cloudRegistrationFromConnection,
  normalizeDesktopWorkspaceId,
  pairedRegistrationFromRecord,
  pairedWorkspaceId,
  readWorkspaceIdOption,
} from './workspace/workspace-registration.ts'
import {
  workspacePolicyForKind,
  workspaceSupportMatrix,
} from './workspace/workspace-support-matrix.ts'

export { LOCAL_WORKSPACE_ID, readWorkspaceIdOption }

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
      this.registerWorkspace(applyGatewayCredentialStatus(
        gatewayRegistrationFromConnection(connection),
        this.gatewayCredentialStore,
      ))
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
      this.cloudConnections.set(workspace.id, cloudConnectionFromWorkspace(workspace))
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
      // A same-id update must never retain an adapter that captured the old
      // token. Drop it immediately after the replacement is durable.
      this.gatewayAdapters.delete(connection.id)
    }
    const workspace = applyGatewayCredentialStatus(
      gatewayRegistrationFromConnection(connection),
      this.gatewayCredentialStore,
    )
    this.registerWorkspace(workspace)
    return this.toInfo(workspace, workspace.id === this.activeWorkspaceId(event))
  }

  remove(event: WorkspaceEventLike, workspaceIdInput: string): boolean {
    const workspaceId = normalizeDesktopWorkspaceId(workspaceIdInput)
    if (!workspaceId || workspaceId === LOCAL_WORKSPACE_ID) return false
    if (this.cloudDesktopConfig.requireManagedOrg && this.managedCloudWorkspaceIds.has(workspaceId)) return false
    const workspace = this.workspaces.get(workspaceId)
    if (workspace?.kind === 'gateway' && this.gatewayCredentialStore) {
      assertGatewayCredentialCleared(this.gatewayCredentialStore.clear(workspaceId))
    }
    const connection = this.cloudConnections.get(workspaceId)
    const gatewayConnection = this.gatewayConnections.get(workspaceId)
    const removed = this.workspaces.delete(workspaceId)
    const persistedRemoved = this.cloudRegistry?.remove(workspaceId) || false
    const gatewayPersistedRemoved = this.gatewayRegistry?.remove(workspaceId) || false
    this.cloudCredentialStore?.remove(workspaceId)
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
      if (this.gatewayCredentialStore) {
        assertGatewayCredentialCleared(this.gatewayCredentialStore.clear(workspace.id))
      }
      this.gatewayAdapters.delete(workspace.id)
      const next = {
        ...workspace,
        status: 'auth_required',
        gatewayCredentialStatus: 'missing',
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

  resetUnreadableGatewayCredentials(): boolean {
    if (!this.gatewayCredentialStore) {
      throw new Error('Gateway workspace credential storage is not configured.')
    }
    const result = this.gatewayCredentialStore.resetUnreadable()
    if (result.status === 'readable') {
      throw new Error('Gateway credential storage is readable. No stored credentials were changed.')
    }
    if (result.status === 'unavailable') {
      throw new Error(
        result.reason === 'recovery-failed'
          ? 'Gateway credential recovery could not quarantine the unreadable store. No stored credentials were changed.'
          : 'Gateway credential recovery could not access the stored file. No stored credentials were changed.',
      )
    }

    // The reset quarantines the entire unreadable document, so every cached
    // Gateway adapter must drop its captured token and every registered
    // Gateway must return to an explicit token-required state.
    this.gatewayAdapters.clear()
    resetGatewayCredentialWorkspaceStates(this.workspaces)
    return true
  }

  policy(event: WorkspaceEventLike, workspaceIdInput?: string | null): WorkspacePolicy {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    return workspacePolicyForKind(workspace.kind)
  }

  async cloudPolicy(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspacePolicy> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind !== 'cloud') return workspacePolicyForKind(workspace.kind)
    try {
      return (await this.requireCloudAdapter(workspace)).policy()
    } catch (error) {
      // Fail closed to the disabled policy, but log — otherwise a transient cloud
      // outage (network/adapter failure) is indistinguishable from a real policy
      // denial, so a workspace silently loses capabilities with no diagnostic trail.
      log('workspace-gateway', `Cloud policy lookup failed for workspace ${workspace.id}; using disabled policy: ${error instanceof Error ? error.message : String(error)}`)
      return workspacePolicyForKind('cloud')
    }
  }

  // Admin control plane (#896). Resolve the active cloud workspace's adapter so the
  // admin IPC handlers can call the admin surface. Admin is cloud-only: a local or
  // gateway workspace has no control plane to administer, so this fails clearly.
  async cloudAdmin(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<CloudWorkspaceSessionAdapter> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind !== 'cloud') {
      throw new Error('Admin controls are only available in a cloud workspace.')
    }
    return this.requireCloudAdapter(workspace)
  }

  async supportMatrix(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceApiSupport[]> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    if (workspace.kind !== 'cloud') return workspaceSupportMatrix(workspace)
    return workspaceSupportMatrix(workspace, await this.cloudPolicy(event, workspace.id))
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

  async rotateCloudWorkflowWebhookSecret(
    event: WorkspaceEventLike,
    workflowId: string,
    workspaceIdInput?: string | null,
  ): Promise<WorkflowWebhookSecretMutationResult | null> {
    return this.cloudWorkflows.rotateWebhookSecret(event, workflowId, workspaceIdInput)
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
    const workspaceId = normalizeDesktopWorkspaceId(workspaceIdInput) || this.activeWorkspaceId(event)
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
    const workspaceId = normalizeDesktopWorkspaceId(workspaceIdInput)
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

  /**
   * Resolve the cloud session adapter for a workspace.
   * Guarantees the shared {@link WorkspaceSessionPort} contract (audit P2-8).
   */
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
    if (existing) {
      assertWorkspaceSessionPort(existing)
      return existing
    }
    const adapter = this.cloudAdapterFactory(connection, accessToken)
    assertWorkspaceSessionPort(adapter)
    this.cloudAdapters.set(workspace.id, adapter)
    return adapter
  }

  /** Public session-port accessor for cloud workspaces (shared local/cloud contract). */
  async cloudSessionPort(event: WorkspaceEventLike, workspaceIdInput?: string | null): Promise<WorkspaceSessionPort> {
    const workspace = this.resolveWorkspace(event, workspaceIdInput)
    return this.requireCloudAdapter(workspace)
  }

  private requireGatewayAdapter(workspace: WorkspaceRegistration): GatewayWorkspaceStatusAdapter {
    if (workspace.kind !== 'gateway') throw new Error('This action requires a Gateway workspace.')
    const connection = this.gatewayConnections.get(workspace.id)
    if (!connection) throw new Error('Gateway workspace connection is missing.')
    const tokenResult = this.gatewayCredentialStore?.getToken(workspace.id) || { status: 'missing' as const }
    if (tokenResult.status === 'unavailable' || tokenResult.status === 'corrupt') {
      throw new GatewayCredentialStorageReadError(tokenResult)
    }
    if (tokenResult.status === 'missing') {
      const latestWorkspace = this.workspaces.get(workspace.id) || workspace
      throw new Error(latestWorkspace.error || 'Gateway workspace token is required.')
    }
    const existing = this.gatewayAdapters.get(workspace.id)
    if (existing) return existing
    const adapter = this.gatewayAdapterFactory(connection, tokenResult.token)
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
      const credentialStorageFailure = error instanceof GatewayCredentialStorageReadError
        ? error.failure
        : null
      const missingToken = !credentialStorageFailure
        && /token is required|credential|authorization|unauthorized|401|403/i.test(message)
      this.workspaces.set(workspace.id, {
        ...workspace,
        status: credentialStorageFailure
          ? gatewayCredentialFailureWorkspaceStatus(credentialStorageFailure)
          : missingToken ? 'auth_required' : 'offline',
        gatewayCredentialStatus: credentialStorageFailure?.status
          || (missingToken ? 'missing' : workspace.gatewayCredentialStatus),
        error: credentialStorageFailure
          ? gatewayCredentialReadError(credentialStorageFailure)
          : missingToken
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
