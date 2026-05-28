import type {
  MessageAttachment,
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
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
} from '@open-cowork/shared'
import type { SessionRecord } from './cloud/control-plane-store.ts'
import { cloudSessionViewToSessionView } from './cloud/session-view-contract.ts'
import {
  createHttpSseCloudTransportAdapter,
  type CloudTransportAdapter,
  type CloudTransportConfig,
  type CloudTransportSettingMetadata,
  type CloudTransportSessionEvent,
  type CloudTransportSubscription,
  type CloudTransportWorkspaceEvent,
} from './cloud/transport-adapter.ts'
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
  listSessions(): Promise<SessionInfo[]>
  createSession(): Promise<SessionInfo>
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

function toSessionInfo(record: SessionRecord): SessionInfo {
  return {
    id: record.sessionId,
    title: record.title || 'New session',
    directory: null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    kind: 'interactive',
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

export function cloudWorkspaceCacheKey(connection: CloudWorkspaceConnectionRecord) {
  return [
    `connection:${connection.id}`,
    `workspace:${connection.id}`,
    `tenant:${connection.tenantId || 'unknown'}`,
    `user:${connection.userId || 'unknown'}`,
    `profile:${connection.profileName || 'default'}`,
  ].join('|')
}

export class CloudWorkspaceAdapter implements CloudWorkspaceSessionAdapter {
  private readonly transport: CloudTransportAdapter
  private readonly connection: CloudWorkspaceConnectionRecord
  private readonly cache: CloudWorkspaceCache | null

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
    return policyFromConfig(await this.transport.getConfig())
  }

  async listSessions(): Promise<SessionInfo[]> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const sessions = (await this.transport.listSessions()).map(toSessionInfo)
      this.cache?.upsertSessionList(cacheKey, sessions)
      return sessions
    } catch (error) {
      const cached = this.cache?.listSessions(cacheKey)
      if (cached) return cached
      throw error
    }
  }

  async createSession(): Promise<SessionInfo> {
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    const session = toSessionInfo((await this.transport.createSession()).session)
    this.cache?.upsertSessionInfo(cacheKey, session)
    return session
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
    const cacheKey = cloudWorkspaceCacheKey(this.connection)
    try {
      const view = cloudSessionViewToSessionView(await this.transport.getSession(sessionId))
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

  async uploadArtifact(input: SessionArtifactUploadRequest): Promise<SessionArtifact> {
    if (!this.transport.uploadArtifact) throw new Error('Cloud artifact uploads are not supported by this workspace.')
    const artifact = await this.transport.uploadArtifact(input.sessionId, {
      filename: input.filename,
      contentType: input.contentType || null,
      dataBase64: input.dataBase64,
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

  private async refreshWorkspaceSnapshot(): Promise<void> {
    const sessions = await this.listSessions()
    await Promise.allSettled(sessions.map((session) => this.getSessionView(session.id)))
    if (this.transport.listArtifacts) {
      await Promise.allSettled(sessions.map((session) => this.listArtifacts(session.id)))
    }
    if (this.transport.listWorkflows) {
      await this.listWorkflows().catch(() => undefined)
    }
    if (this.transport.listSettings) {
      await this.listSettings().catch(() => undefined)
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
    return this.transport.subscribeWorkspaceEvents({
      afterSequence,
      onEvent: (event) => {
        void (async () => {
          try {
            if (event.type === 'snapshot.required') {
              await this.refreshWorkspaceSnapshot()
              this.cache?.resetEventCursor(cacheKey, 'workspace', 0)
              input.onEvent(event)
              return
            }
            this.cache?.setEventCursor(cacheKey, 'workspace', event.sequence)
            input.onEvent(event)
          } catch (error) {
            input.onError?.(error)
          }
        })()
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
