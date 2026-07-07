import type {
  ArtifactIndexPayload,
  ArtifactIndexRequest,
  ArtifactStatusUpdateRequest,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
  MessageAttachment,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  CloudProjectSnapshotUploadInput,
  CloudProjectSnapshotUploadResult,
  CloudProjectSourceInput,
  CloudProjectSourcePolicyVerdict,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionImportRequest,
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
  WorkspacePolicy,
  ManagedDesktopPolicyView,
} from '@open-cowork/shared'
import { setActiveManagedPolicy } from '@open-cowork/runtime-host/managed-policy'
import type { SessionRecord } from '@open-cowork/cloud-server/control-plane-store'
import { cloudSessionViewToSessionView } from '@open-cowork/cloud-server/session-view-contract'
import {
  createHttpSseCloudTransportAdapter,
  type CloudTransportAdapter,
  type CloudTransportConfig,
  type CloudTransportSettingMetadata,
  type CloudTransportSessionEvent,
  type CloudTransportSubscription,
  type CloudTransportWorkspaceEvent,
} from '@open-cowork/cloud-server/transport-adapter'
import type { CloudWorkspaceConnectionRecord } from './cloud-workspace-registry.ts'
import {
  createFileCloudWorkspaceCache,
  type CloudWorkspaceCache,
  type CloudWorkspaceCacheEncryptionFallback,
  type CloudWorkspaceCacheMode,
} from './cloud-workspace-cache.ts'

export type CloudPromptInput = {
  text: string
  agent?: string | null
  attachments?: MessageAttachment[]
}

export type CloudWorkspaceSessionAdapter = {
  policy(): Promise<WorkspacePolicy>
  sync?(): Promise<void>
  listSessions(): Promise<SessionInfo[]>
  createSession(input?: { projectSource?: CloudProjectSourceInput | null }): Promise<SessionInfo>
  validateProjectSource?(input: CloudProjectSourceInput): Promise<CloudProjectSourcePolicyVerdict>
  uploadProjectSnapshot?(input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult>
  importSession(input: SessionImportRequest): Promise<{ session: SessionInfo, view: SessionView }>
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>
  getSessionView(sessionId: string): Promise<SessionView>
  promptSession(sessionId: string, input: CloudPromptInput): Promise<void>
  abortSession(sessionId: string): Promise<void>
  replyToQuestion?(sessionId: string, requestId: string, answers: unknown[]): Promise<void>
  rejectQuestion?(sessionId: string, requestId: string): Promise<void>
  respondToPermission?(sessionId: string, permissionId: string, allowed: boolean): Promise<void>
  listWorkflows?(): Promise<WorkflowListPayload>
  getWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  runWorkflow?(workflowId: string): Promise<WorkflowRun | null>
  pauseWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  resumeWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  archiveWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  searchThreads?(query?: ThreadSearchQuery): Promise<ThreadSearchResult>
  threadFacets?(query?: ThreadSearchQuery): Promise<ThreadFacetSummary>
  listThreadTags?(): Promise<ThreadTag[]>
  createThreadTag?(input: ThreadTagInput): Promise<ThreadTag>
  updateThreadTag?(tagId: string, input: ThreadTagInput): Promise<ThreadTag | null>
  deleteThreadTag?(tagId: string): Promise<boolean>
  applyThreadTags?(sessionIds: string[], tagIds: string[]): Promise<boolean>
  removeThreadTags?(sessionIds: string[], tagIds: string[]): Promise<boolean>
  listThreadSmartFilters?(): Promise<ThreadSmartFilter[]>
  createThreadSmartFilter?(input: ThreadSmartFilterInput): Promise<ThreadSmartFilter>
  updateThreadSmartFilter?(filterId: string, input: ThreadSmartFilterInput): Promise<ThreadSmartFilter | null>
  deleteThreadSmartFilter?(filterId: string): Promise<boolean>
  listArtifacts?(sessionId: string): Promise<SessionArtifact[]>
  indexArtifacts?(request?: ArtifactIndexRequest): Promise<ArtifactIndexPayload>
  launchpadFeed?(request?: LaunchpadFeedRequest): Promise<LaunchpadFeedPayload>
  updateArtifactStatus?(request: ArtifactStatusUpdateRequest): Promise<SessionArtifact>
  uploadArtifact?(input: SessionArtifactUploadRequest): Promise<SessionArtifact>
  readArtifactAttachment?(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
  listCapabilityTools?(): Promise<CapabilityTool[]>
  getCapabilityTool?(toolId: string): Promise<CapabilityTool | null>
  listCapabilitySkills?(): Promise<CapabilitySkill[]>
  getCapabilitySkillBundle?(skillName: string): Promise<CapabilitySkillBundle | null>
  readCapabilitySkillBundleFile?(skillName: string, filePath: string): Promise<string | null>
  listSettings?(): Promise<CloudTransportSettingMetadata[]>
  getSetting?(key: string): Promise<CloudTransportSettingMetadata | null>
  setSetting?(key: string, value: Record<string, unknown>): Promise<CloudTransportSettingMetadata>
  subscribeWorkspaceEvents?(input: {
    afterSequence?: number
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeSessionEvents?(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription
}

export type CloudWorkspaceAdapterOptions = {
  connection: CloudWorkspaceConnectionRecord
  transport?: CloudTransportAdapter
  accessToken?: string | null
  cache?: CloudWorkspaceCache | null
  cacheMode?: CloudWorkspaceCacheMode
  cacheEncryptionFallback?: CloudWorkspaceCacheEncryptionFallback
}

const CLOUD_SYNC_SESSION_PAGE_SIZE = 100
const CLOUD_SYNC_MAX_SESSION_PAGES = 5
const CLOUD_SYNC_MAX_VIEW_REFRESHES = 100
const CLOUD_SYNC_MAX_ARTIFACT_REFRESHES = 100
const CLOUD_SYNC_VIEW_CONCURRENCY = 8
const CLOUD_SYNC_ARTIFACT_CONCURRENCY = 4
const CLOUD_SYNC_RETRY_BACKOFF_MS = 100

function toSessionInfo(record: SessionRecord): SessionInfo {
  return {
    id: record.sessionId,
    title: record.title || 'New session',
    directory: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: 'interactive',
    projectSource: record.projectSource || null,
  }
}

function policyFromConfig(config: CloudTransportConfig): WorkspacePolicy {
  return {
    features: config.features || {},
    allowedAgents: config.allowedAgents,
    allowedTools: config.allowedTools,
    allowedMcps: config.allowedMcps,
    localFiles: 'disabled',
    localStdioMcps: 'disabled',
    machineRuntimeConfig: 'disabled',
  }
}

// Map the delivered policy view onto the enforcement shape (dropping the transparency
// map) and hand it to the runtime-host singleton, which persists it for offline-safety.
export function applyManagedPolicyFromConfig(view: ManagedDesktopPolicyView): void {
  setActiveManagedPolicy({
    allowedProviders: view.allowedProviders,
    deniedProviders: view.deniedProviders,
    allowedModels: view.allowedModels,
    deniedModels: view.deniedModels,
    keyManagement: view.keyManagement,
    extensions: view.extensions,
    features: view.features,
    permissionCeilings: view.permissionCeilings,
    updateChannel: view.updateChannel,
  })
}

export function cloudWorkspaceCacheKey(connection: CloudWorkspaceConnectionRecord) {
  return [
    `connection:${connection.id}`,
    `workspace:${connection.id}`,
    `tenant:${connection.tenantId || 'unknown'}`,
    `user:${connection.userId || 'unknown'}`,
    `profile:${connection.profileName || 'default'}`,
  ].join('|')
}

async function settleWithConcurrency<T>(
  items: T[],
  concurrency: number,
  task: (item: T, index: number) => Promise<void>,
): Promise<PromiseSettledResult<void>[]> {
  const results: PromiseSettledResult<void>[] = new Array(items.length)
  let nextIndex = 0
  const workerCount = Math.min(Math.max(1, concurrency), items.length)
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        await task(items[index]!, index)
        results[index] = { status: 'fulfilled', value: undefined }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }))
  return results
}

async function retrySyncRefresh(task: () => Promise<unknown>) {
  try {
    await task()
  } catch {
    await new Promise((resolve) => setTimeout(resolve, CLOUD_SYNC_RETRY_BACKOFF_MS))
    await task()
  }
}

export class CloudWorkspaceAdapter implements CloudWorkspaceSessionAdapter {
  private readonly transport: CloudTransportAdapter
  private readonly connection: CloudWorkspaceConnectionRecord
  private readonly cache: CloudWorkspaceCache | null
  private readonly inFlightSessionViews = new Map<string, Promise<SessionView>>()
  private readonly inFlightArtifactLists = new Map<string, Promise<SessionArtifact[]>>()
  private syncGeneration = 0

  constructor(options: CloudWorkspaceAdapterOptions) {
    this.connection = options.connection
    this.cache = options.cache === undefined
      ? createFileCloudWorkspaceCache({
          mode: options.cacheMode,
          encryptionFallback: options.cacheEncryptionFallback,
        })
      : options.cache
    this.transport = options.transport || createHttpSseCloudTransportAdapter({
      baseUrl: options.connection.baseUrl,
      headers: options.accessToken
        ? { authorization: `Bearer ${options.accessToken}` }
        : undefined,
    })
  }

  async policy(): Promise<WorkspacePolicy> {
    const config = await this.transport.getConfig()
    // Push the org-managed policy (#898) into the runtime-host enforcement singleton so
    // the local runtime clamps its permission maxima and scopes providers/models to it.
    // A server that predates the policy omits the field — leave the last-known (offline-
    // safe) policy in place rather than clearing enforcement. When offline this call
    // never runs (getConfig throws), so the persisted policy keeps enforcing.
    if (config.managedPolicy) applyManagedPolicyFromConfig(config.managedPolicy)
    return policyFromConfig(config)
  }

  async listSessions(): Promise<SessionInfo[]> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const records: SessionRecord[] = []
      if (this.transport.listSessionsPage) {
        let cursor: string | null = null
        do {
          const page = await this.transport.listSessionsPage({ limit: 500, cursor })
          records.push(...page.sessions)
          if (page.nextCursor === cursor) break
          cursor = page.nextCursor
        } while (cursor)
      } else {
        records.push(...await this.transport.listSessions())
      }
      const sessions = records.map(toSessionInfo)
      this.cache?.upsertSessionList(cacheKey, sessions)
      return sessions
    } catch (error) {
      const cached = this.cache?.listSessions(cacheKey)
      if (cached) return cached
      throw error
    }
  }

  private async listSessionsForSync(cacheKey: string, generation: number): Promise<{
    viewRefreshCandidates: SessionInfo[]
    artifactRefreshCandidates: SessionInfo[]
  }> {
    const cachedSessions = new Map((this.cache?.listSessions(cacheKey) || []).map((session) => [session.id, session]))
    const cachedViews = new Set<string>()
    const cachedArtifacts = new Set<string>()
    for (const sessionId of cachedSessions.keys()) {
      if (this.cache?.getSessionView(cacheKey, sessionId)) cachedViews.add(sessionId)
      if (this.cache?.listArtifacts(cacheKey, sessionId)) cachedArtifacts.add(sessionId)
    }
    const sessions: SessionInfo[] = []
    if (this.transport.listSessionsPage) {
      let cursor: string | null = null
      for (let page = 0; page < CLOUD_SYNC_MAX_SESSION_PAGES && generation === this.syncGeneration; page += 1) {
        const result = await this.transport.listSessionsPage({
          limit: CLOUD_SYNC_SESSION_PAGE_SIZE,
          cursor,
        })
        sessions.push(...result.sessions.map(toSessionInfo))
        if (!result.nextCursor || result.nextCursor === cursor) {
          cursor = null
          break
        }
        cursor = result.nextCursor
      }
      if (cursor === null) {
        this.cache?.upsertSessionList(cacheKey, sessions)
      } else {
        for (const session of sessions) this.cache?.upsertSessionInfo(cacheKey, session)
      }
    } else {
      sessions.push(...(await this.transport.listSessions()).map(toSessionInfo))
      this.cache?.upsertSessionList(cacheKey, sessions)
    }
    const changedSessions = sessions.filter((session) => {
      const cached = cachedSessions.get(session.id)
      return !cached || cached.updatedAt !== session.updatedAt || !cachedViews.has(session.id)
    })
    const artifactSessions = sessions.filter((session) => {
      const cached = cachedSessions.get(session.id)
      return !cached || cached.updatedAt !== session.updatedAt || !cachedArtifacts.has(session.id)
    })
    return {
      viewRefreshCandidates: changedSessions.slice(0, CLOUD_SYNC_MAX_VIEW_REFRESHES),
      artifactRefreshCandidates: artifactSessions.slice(0, CLOUD_SYNC_MAX_ARTIFACT_REFRESHES),
    }
  }

  async createSession(input: { projectSource?: CloudProjectSourceInput | null } = {}): Promise<SessionInfo> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const session = toSessionInfo((await this.transport.createSession(input)).session)
    this.cache?.upsertSessionInfo(cacheKey, session)
    return session
  }

  validateProjectSource(input: CloudProjectSourceInput): Promise<CloudProjectSourcePolicyVerdict> {
    return this.transport.validateProjectSource(input)
  }

  uploadProjectSnapshot(input: CloudProjectSnapshotUploadInput): Promise<CloudProjectSnapshotUploadResult> {
    return this.transport.uploadProjectSnapshot(input)
  }

  async importSession(input: SessionImportRequest): Promise<{ session: SessionInfo, view: SessionView }> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const imported = await this.transport.importSession(input)
    const session = toSessionInfo(imported.session)
    const view = cloudSessionViewToSessionView(imported)
    this.cache?.upsertSessionInfo(cacheKey, session)
    this.cache?.upsertSessionView(cacheKey, session.id, view)
    const sessions = this.cache?.listSessions(cacheKey)
    if (sessions) {
      this.cache?.upsertSessionList(cacheKey, [
        session,
        ...sessions.filter((entry) => entry.id !== session.id),
      ])
    }
    return { session, view }
  }

  async getSessionInfo(sessionId: string): Promise<SessionInfo | null> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const session = toSessionInfo((await this.transport.getSession(sessionId)).session)
      this.cache?.upsertSessionInfo(cacheKey, session)
      return session
    } catch (error) {
      const cached = this.cache?.getSessionInfo(cacheKey, sessionId)
      if (cached) return cached
      throw error
    }
  }

  async getSessionView(sessionId: string): Promise<SessionView> {
    const inFlight = this.inFlightSessionViews.get(sessionId)
    if (inFlight) return inFlight
    const fetch = this.fetchSessionView(sessionId)
      .finally(() => {
        if (this.inFlightSessionViews.get(sessionId) === fetch) {
          this.inFlightSessionViews.delete(sessionId)
        }
      })
    this.inFlightSessionViews.set(sessionId, fetch)
    return fetch
  }

  private async fetchSessionView(sessionId: string): Promise<SessionView> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const view = cloudSessionViewToSessionView(await this.transport.getSession(sessionId))
      const cached = this.cache?.getSessionView(cacheKey, sessionId)
      if (cached && cached.revision > view.revision) return cached
      this.cache?.upsertSessionView(cacheKey, sessionId, view)
      return view
    } catch (error) {
      const cached = this.cache?.getSessionView(cacheKey, sessionId)
      if (cached) return cached
      throw error
    }
  }

  async promptSession(sessionId: string, input: CloudPromptInput): Promise<void> {
    if (input.attachments && input.attachments.length > 0) {
      throw new Error('Cloud workspace prompts do not support local attachments yet.')
    }
    await this.transport.promptSession(sessionId, {
      text: input.text,
      agent: input.agent || null,
    })
  }

  async abortSession(sessionId: string): Promise<void> {
    await this.transport.abortSession(sessionId)
  }

  async replyToQuestion(sessionId: string, requestId: string, answers: unknown[]): Promise<void> {
    await this.transport.replyToQuestion(sessionId, { requestId, answers })
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    await this.transport.rejectQuestion(sessionId, { requestId })
  }

  async respondToPermission(sessionId: string, permissionId: string, allowed: boolean): Promise<void> {
    await this.transport.respondToPermission(sessionId, {
      permissionId,
      response: { allowed },
    })
  }

  async listWorkflows(): Promise<WorkflowListPayload> {
    if (!this.transport.listWorkflows) throw new Error('Cloud workflows are not supported by this workspace.')
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const workflows = await this.transport.listWorkflows()
      this.cache?.upsertWorkflowList(cacheKey, workflows)
      return workflows
    } catch (error) {
      const cached = this.cache?.getWorkflowList(cacheKey)
      if (cached) return cached
      throw error
    }
  }

  async getWorkflow(workflowId: string): Promise<WorkflowDetail | null> {
    if (!this.transport.getWorkflow) throw new Error('Cloud workflows are not supported by this workspace.')
    return this.transport.getWorkflow(workflowId)
  }

  async runWorkflow(workflowId: string): Promise<WorkflowRun | null> {
    if (!this.transport.runWorkflow) throw new Error('Cloud workflow runs are not supported by this workspace.')
    return this.transport.runWorkflow(workflowId, {
      triggerType: 'manual',
      triggerPayload: {
        source: 'desktop',
        requestedAt: new Date().toISOString(),
      },
    })
  }

  async pauseWorkflow(workflowId: string): Promise<WorkflowDetail | null> {
    if (!this.transport.pauseWorkflow) throw new Error('Cloud workflow pause is not supported by this workspace.')
    return this.transport.pauseWorkflow(workflowId)
  }

  async resumeWorkflow(workflowId: string): Promise<WorkflowDetail | null> {
    if (!this.transport.resumeWorkflow) throw new Error('Cloud workflow resume is not supported by this workspace.')
    return this.transport.resumeWorkflow(workflowId)
  }

  async archiveWorkflow(workflowId: string): Promise<WorkflowDetail | null> {
    if (!this.transport.archiveWorkflow) throw new Error('Cloud workflow archive is not supported by this workspace.')
    return this.transport.archiveWorkflow(workflowId)
  }

  async searchThreads(query?: ThreadSearchQuery): Promise<ThreadSearchResult> {
    if (!this.transport.searchThreads) throw new Error('Cloud thread search is not supported by this workspace.')
    return this.transport.searchThreads(query)
  }

  async threadFacets(query?: ThreadSearchQuery): Promise<ThreadFacetSummary> {
    if (!this.transport.threadFacets) throw new Error('Cloud thread facets are not supported by this workspace.')
    return this.transport.threadFacets(query)
  }

  async listThreadTags(): Promise<ThreadTag[]> {
    if (!this.transport.listThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.listThreadTags()
  }

  async createThreadTag(input: ThreadTagInput): Promise<ThreadTag> {
    if (!this.transport.createThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.createThreadTag(input)
  }

  async updateThreadTag(tagId: string, input: ThreadTagInput): Promise<ThreadTag | null> {
    if (!this.transport.updateThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.updateThreadTag(tagId, input)
  }

  async deleteThreadTag(tagId: string): Promise<boolean> {
    if (!this.transport.deleteThreadTag) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.deleteThreadTag(tagId)
  }

  async applyThreadTags(sessionIds: string[], tagIds: string[]): Promise<boolean> {
    if (!this.transport.applyThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.applyThreadTags(sessionIds, tagIds)
  }

  async removeThreadTags(sessionIds: string[], tagIds: string[]): Promise<boolean> {
    if (!this.transport.removeThreadTags) throw new Error('Cloud thread tags are not supported by this workspace.')
    return this.transport.removeThreadTags(sessionIds, tagIds)
  }

  async listThreadSmartFilters(): Promise<ThreadSmartFilter[]> {
    if (!this.transport.listThreadSmartFilters) throw new Error('Cloud smart filters are not supported by this workspace.')
    return this.transport.listThreadSmartFilters()
  }

  async createThreadSmartFilter(input: ThreadSmartFilterInput): Promise<ThreadSmartFilter> {
    if (!this.transport.createThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return this.transport.createThreadSmartFilter(input)
  }

  async updateThreadSmartFilter(filterId: string, input: ThreadSmartFilterInput): Promise<ThreadSmartFilter | null> {
    if (!this.transport.updateThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return this.transport.updateThreadSmartFilter(filterId, input)
  }

  async deleteThreadSmartFilter(filterId: string): Promise<boolean> {
    if (!this.transport.deleteThreadSmartFilter) throw new Error('Cloud smart filters are not supported by this workspace.')
    return this.transport.deleteThreadSmartFilter(filterId)
  }

  async listArtifacts(sessionId: string): Promise<SessionArtifact[]> {
    if (!this.transport.listArtifacts) throw new Error('Cloud artifacts are not supported by this workspace.')
    const inFlight = this.inFlightArtifactLists.get(sessionId)
    if (inFlight) return inFlight
    const fetch = this.fetchArtifactList(sessionId)
      .finally(() => {
        if (this.inFlightArtifactLists.get(sessionId) === fetch) {
          this.inFlightArtifactLists.delete(sessionId)
        }
      })
    this.inFlightArtifactLists.set(sessionId, fetch)
    return fetch
  }

  private async fetchArtifactList(sessionId: string): Promise<SessionArtifact[]> {
    if (!this.transport.listArtifacts) throw new Error('Cloud artifacts are not supported by this workspace.')
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const artifacts = await this.transport.listArtifacts(sessionId)
      this.cache?.upsertArtifactList(cacheKey, sessionId, artifacts)
      return artifacts
    } catch (error) {
      const cached = this.cache?.listArtifacts(cacheKey, sessionId)
      if (cached) return cached
      throw error
    }
  }

  async indexArtifacts(request: ArtifactIndexRequest = {}): Promise<ArtifactIndexPayload> {
    if (!this.transport.indexArtifacts) throw new Error('Cloud artifact index is not supported by this workspace.')
    const payload = await this.transport.indexArtifacts(request)
    return {
      ...payload,
      artifacts: payload.artifacts.map((artifact) => ({
        ...artifact,
        workspaceId: this.connection.id,
      })),
    }
  }

  async launchpadFeed(request: LaunchpadFeedRequest = {}): Promise<LaunchpadFeedPayload> {
    if (!this.transport.launchpadFeed) throw new Error('Cloud launchpad feed is not supported by this workspace.')
    return this.transport.launchpadFeed(request)
  }

  async updateArtifactStatus(request: ArtifactStatusUpdateRequest): Promise<SessionArtifact> {
    if (!this.transport.updateArtifactStatus) throw new Error('Cloud artifact status updates are not supported by this workspace.')
    const artifact = await this.transport.updateArtifactStatus(request)
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const existing = this.cache?.listArtifacts(cacheKey, request.sessionId) || []
    if (existing.length > 0) {
      this.cache?.upsertArtifactList(cacheKey, request.sessionId, [
        ...existing.filter((entry) => entry.id !== artifact.id),
        artifact,
      ])
    }
    return artifact
  }

  async uploadArtifact(input: SessionArtifactUploadRequest): Promise<SessionArtifact> {
    if (!this.transport.uploadArtifact) throw new Error('Cloud artifact uploads are not supported by this workspace.')
    const artifact = await this.transport.uploadArtifact(input.sessionId, {
      filename: input.filename,
      contentType: input.contentType || null,
      dataBase64: input.dataBase64,
      kind: input.kind || null,
      status: input.status || null,
      authorAgentId: input.authorAgentId || null,
      projectId: input.projectId || null,
      taskId: input.taskId || null,
      statusUpdatedBy: input.statusUpdatedBy || null,
      statusUpdatedAt: input.statusUpdatedAt || null,
    })
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const existing = this.cache?.listArtifacts(cacheKey, input.sessionId) || []
    this.cache?.upsertArtifactList(cacheKey, input.sessionId, [
      ...existing.filter((entry) => entry.id !== artifact.id),
      artifact,
    ])
    return artifact
  }

  async readArtifactAttachment(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment> {
    if (!this.transport.readArtifactAttachment) throw new Error('Cloud artifact downloads are not supported by this workspace.')
    return this.transport.readArtifactAttachment(sessionId, filePathOrArtifactId)
  }

  async listCapabilityTools(): Promise<CapabilityTool[]> {
    if (!this.transport.listCapabilityTools) throw new Error('Cloud capabilities are not supported by this workspace.')
    return this.transport.listCapabilityTools()
  }

  async getCapabilityTool(toolId: string): Promise<CapabilityTool | null> {
    if (!this.transport.getCapabilityTool) throw new Error('Cloud capabilities are not supported by this workspace.')
    return this.transport.getCapabilityTool(toolId)
  }

  async listCapabilitySkills(): Promise<CapabilitySkill[]> {
    if (!this.transport.listCapabilitySkills) throw new Error('Cloud capabilities are not supported by this workspace.')
    return this.transport.listCapabilitySkills()
  }

  async getCapabilitySkillBundle(skillName: string): Promise<CapabilitySkillBundle | null> {
    if (!this.transport.getCapabilitySkillBundle) throw new Error('Cloud capabilities are not supported by this workspace.')
    return this.transport.getCapabilitySkillBundle(skillName)
  }

  async readCapabilitySkillBundleFile(skillName: string, filePath: string): Promise<string | null> {
    if (!this.transport.readCapabilitySkillBundleFile) throw new Error('Cloud capability bundle files are not supported by this workspace.')
    return this.transport.readCapabilitySkillBundleFile(skillName, filePath)
  }

  async listSettings(): Promise<CloudTransportSettingMetadata[]> {
    if (!this.transport.listSettings) throw new Error('Cloud settings are not supported by this workspace.')
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const settings = await this.transport.listSettings()
      this.cache?.upsertSettings(cacheKey, settings)
      return settings
    } catch (error) {
      const cached = this.cache?.listSettings(cacheKey)
      if (cached) return cached
      throw error
    }
  }

  async getSetting(key: string): Promise<CloudTransportSettingMetadata | null> {
    if (!this.transport.getSetting) throw new Error('Cloud settings are not supported by this workspace.')
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const setting = await this.transport.getSetting(key)
      if (setting) this.cache?.upsertSetting(cacheKey, setting)
      return setting
    } catch (error) {
      const cached = this.cache?.getSetting(cacheKey, key)
      if (cached) return cached
      throw error
    }
  }

  async setSetting(key: string, value: Record<string, unknown>): Promise<CloudTransportSettingMetadata> {
    if (!this.transport.setSetting) throw new Error('Cloud settings are not supported by this workspace.')
    const setting = await this.transport.setSetting(key, value)
    this.cache?.upsertSetting(cloudWorkspaceCacheKey(this.connection), setting)
    return setting
  }

  async sync(): Promise<void> {
    const generation = ++this.syncGeneration
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const plan = await this.listSessionsForSync(cacheKey, generation)
    if (generation !== this.syncGeneration) return
    // Coalesce every per-session view/artifact upsert this pass performs into one durable cache
    // read + write (P1-E): otherwise each of up to 100 upserts re-serializes + encrypts + fsyncs
    // the whole transcript cache on the Electron main thread (O(n^2)).
    this.cache?.beginCacheBatch()
    try {
      await settleWithConcurrency(plan.viewRefreshCandidates, CLOUD_SYNC_VIEW_CONCURRENCY, async (session) => {
        if (generation !== this.syncGeneration) return
        await retrySyncRefresh(() => this.getSessionView(session.id))
      })
      if (generation !== this.syncGeneration) return
      if (this.transport.listArtifacts) {
        await settleWithConcurrency(plan.artifactRefreshCandidates, CLOUD_SYNC_ARTIFACT_CONCURRENCY, async (session) => {
          if (generation !== this.syncGeneration) return
          await retrySyncRefresh(() => this.listArtifacts(session.id))
        })
      }
      if (generation !== this.syncGeneration) return
      if (this.transport.listWorkflows) {
        await this.listWorkflows().catch(() => undefined)
      }
      if (generation !== this.syncGeneration) return
      if (this.transport.listSettings) {
        await this.listSettings().catch(() => undefined)
      }
    } finally {
      this.cache?.endCacheBatch()
    }
  }

  subscribeWorkspaceEvents(
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportWorkspaceEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const afterSequence = input.afterSequence ?? this.cache?.getEventCursor(cacheKey, 'workspace') ?? undefined
    // Sequence per subscription (audit P1-X2): each event's async handling (notably the
    // snapshot.required sync()) must complete before the next event is delivered, otherwise event N's
    // await wouldn't gate N+1 and input.onEvent could fire out of order — letting a stale snapshot
    // overwrite a newer one downstream. A tail-promise chain serializes handling without dropping events.
    let tail: Promise<void> = Promise.resolve()
    return this.transport.subscribeWorkspaceEvents({
      afterSequence,
      onEvent: (event) => {
        tail = tail.then(async () => {
          try {
            if (event.type === 'snapshot.required') {
              await this.sync()
              this.cache?.resetEventCursor(cacheKey, 'workspace', 0)
              input.onEvent(event)
              return
            }
            this.cache?.setEventCursor(cacheKey, 'workspace', event.sequence)
            input.onEvent(event)
          } catch (error) {
            input.onError?.(error)
          }
        })
      },
      onError: input.onError,
    })
  }

  subscribeSessionEvents(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    // Session events also hydrate the main-process SessionEngine. After an
    // app restart that engine is empty even when the durable cache has a
    // later cursor, so replay from the beginning unless the caller explicitly
    // supplies a cursor for a known-hydrated stream.
    const afterSequence = input.afterSequence
    return this.transport.subscribeSessionEvents(sessionId, {
      afterSequence,
      onEvent: (event) => {
        this.cache?.setEventCursor(cacheKey, `session:${sessionId}`, event.sequence)
        input.onEvent(event)
      },
      onError: input.onError,
    })
  }
}

export function createCloudWorkspaceAdapter(
  connection: CloudWorkspaceConnectionRecord,
  accessToken?: string | null,
  options: {
    cache?: CloudWorkspaceCache | null
    cacheMode?: CloudWorkspaceCacheMode
    cacheEncryptionFallback?: CloudWorkspaceCacheEncryptionFallback
  } = {},
) {
  return new CloudWorkspaceAdapter({
    connection,
    accessToken,
    cache: options.cache,
    cacheMode: options.cacheMode,
    cacheEncryptionFallback: options.cacheEncryptionFallback,
  })
}
