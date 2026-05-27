import type { SessionCommandRecord, SessionRecord } from './control-plane-store.ts'
import type { CloudSessionView } from './session-service.ts'
import {
  cloudArtifactFilePath,
  cloudArtifactIdFromFilePath,
} from '@open-cowork/shared'
import type {
  CapabilitySkill,
  CapabilitySkillBundle,
  CapabilityTool,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkflowTriggerType,
  SessionArtifact,
  SessionArtifactAttachment,
  SessionArtifactUploadRequest,
  ThreadFacetSummary,
  ThreadListItem,
  ThreadSearchQuery,
  ThreadSearchResult,
  ThreadSmartFilter,
  ThreadSmartFilterInput,
  ThreadTag,
  ThreadTagInput,
} from '@open-cowork/shared'

export type CloudRuntimeStatus = {
  role: string
  profileName: string
  canExecute: boolean
  commandProcessing: 'inline' | 'durable' | 'delegated'
  checkpoints: boolean
  heartbeats: unknown[]
}

export type CloudTransportConfig = {
  role: string
  profileName: string
  features: Record<string, boolean>
  allowedAgents: string[] | null
  allowedTools: string[] | null
  allowedMcps: string[] | null
}

export type CloudTransportResponse<T> = {
  status: number
  body: T
}

export type CloudTransportFetch = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: string
    credentials?: 'include'
    signal?: AbortSignal
  },
) => Promise<{
  ok: boolean
  status: number
  text(): Promise<string>
  body?: ReadableStream<Uint8Array> | null
}>

export type CloudTransportEventSource = new (
  url: string,
  init?: { withCredentials?: boolean },
) => {
  close(): void
  addEventListener(type: string, listener: (event: { data: string, lastEventId?: string }) => void): void
  onmessage: ((event: { data: string, lastEventId?: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type CloudTransportAdapterOptions = {
  baseUrl?: string
  fetch?: CloudTransportFetch
  eventSource?: CloudTransportEventSource
  csrfToken?: string | null
  credentials?: 'include'
  headers?: Record<string, string>
}

export type CloudTransportSubscription = {
  close(): void
}

export type CloudTransportSessionEvent = {
  tenantId?: string
  sessionId?: string
  eventId: string
  sequence: number
  entityType?: string
  entityId?: string
  operation?: string
  projectionVersion?: number
  type: string
  payload: Record<string, unknown>
  createdAt?: string
}

export type CloudTransportWorkspaceEvent = CloudTransportSessionEvent

export type CloudTransportSettingMetadata = {
  tenantId?: string
  userId?: string | null
  key: string
  value: Record<string, unknown>
  updatedAt: string
}

export type CloudTransportAdapter = {
  getConfig(): Promise<CloudTransportConfig>
  getRuntimeStatus(): Promise<CloudRuntimeStatus>
  listSessions(): Promise<SessionRecord[]>
  createSession(input?: { profileName?: string | null }): Promise<CloudSessionView>
  getSession(sessionId: string): Promise<CloudSessionView>
  promptSession(sessionId: string, input: { text: string, agent?: string | null }): Promise<{
    command: SessionCommandRecord
    processed: number
    view: CloudSessionView
  }>
  abortSession(sessionId: string): Promise<{ command: SessionCommandRecord, processed: number, view: CloudSessionView }>
  replyToQuestion(sessionId: string, input: { requestId: string, answers: unknown[] }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  rejectQuestion(sessionId: string, input: { requestId: string }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  respondToPermission(sessionId: string, input: { permissionId: string, response: unknown }): Promise<{
    command: SessionCommandRecord
    processed: number
  }>
  listWorkflows?(): Promise<WorkflowListPayload>
  getWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  runWorkflow?(workflowId: string, input?: { triggerType?: WorkflowTriggerType, triggerPayload?: Record<string, unknown> | null }): Promise<WorkflowRun | null>
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
  uploadArtifact?(sessionId: string, input: Omit<SessionArtifactUploadRequest, 'sessionId' | 'workspaceId'>): Promise<SessionArtifact>
  readArtifactAttachment?(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
  listCapabilityTools?(): Promise<CapabilityTool[]>
  getCapabilityTool?(toolId: string): Promise<CapabilityTool | null>
  listCapabilitySkills?(): Promise<CapabilitySkill[]>
  getCapabilitySkillBundle?(skillName: string): Promise<CapabilitySkillBundle | null>
  readCapabilitySkillBundleFile?(skillName: string, filePath: string): Promise<string | null>
  listSettings?(): Promise<CloudTransportSettingMetadata[]>
  getSetting?(key: string): Promise<CloudTransportSettingMetadata | null>
  setSetting?(key: string, value: Record<string, unknown>): Promise<CloudTransportSettingMetadata>
  workspaceEventsUrl(afterSequence?: number): string
  sessionEventsUrl(sessionId: string, afterSequence?: number): string
  subscribeWorkspaceEvents(input: {
    afterSequence?: number
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  }): CloudTransportSubscription
  subscribeSessionEvents(
    sessionId: string,
    input: {
      afterSequence?: number
      onEvent: (event: CloudTransportSessionEvent) => void
      onError?: (error: unknown) => void
    },
  ): CloudTransportSubscription
}

type ApiErrorPayload = {
  error?: string
}

function normalizeBaseUrl(baseUrl: string | undefined) {
  return (baseUrl || '').replace(/\/+$/, '')
}

function encodePath(value: string) {
  return encodeURIComponent(value)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function readString(value: unknown, fallback = '') {
  return typeof value === 'string' && value.trim() ? value : fallback
}

function readNullableString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value : null
}

function readNumber(value: unknown, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeThreadTag(value: unknown): ThreadTag {
  const record = asRecord(value)
  const id = readString(record.id, readString(record.tagId))
  return {
    id,
    name: readString(record.name, 'Tag'),
    color: readString(record.color, '#64748b'),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadSmartFilter(value: unknown): ThreadSmartFilter {
  const record = asRecord(value)
  return {
    id: readString(record.id, readString(record.filterId)),
    name: readString(record.name, 'Smart filter'),
    query: asRecord(record.query) as ThreadSearchQuery,
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function normalizeThreadStatus(value: unknown): ThreadListItem['status'] {
  if (value === 'running') return 'running'
  if (value === 'errored' || value === 'error') return 'error'
  return 'idle'
}

function normalizeThreadListItem(value: unknown): ThreadListItem {
  const record = asRecord(value)
  const tags = Array.isArray(record.tags) ? record.tags.map(normalizeThreadTag) : []
  return {
    sessionId: readString(record.sessionId),
    title: readString(record.title, 'New session'),
    directory: null,
    projectLabel: null,
    providerId: null,
    modelId: null,
    status: normalizeThreadStatus(record.status),
    createdAt: readString(record.createdAt, new Date(0).toISOString()),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
    parentSessionId: null,
    workflowId: null,
    runId: null,
    revertedMessageId: null,
    tags,
    actualAgents: readNullableString(record.profileName) ? [{ name: readString(record.profileName), count: 1 }] : [],
    actualTools: [],
    suggestions: [],
    usage: {
      messages: 0,
      toolCalls: 0,
      taskRuns: 0,
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    changeSummary: null,
  }
}

function normalizeThreadSearchResult(value: unknown): ThreadSearchResult {
  const record = asRecord(value)
  const threads = Array.isArray(record.threads) ? record.threads.map(normalizeThreadListItem) : []
  return {
    threads,
    nextCursor: readNullableString(record.nextCursor),
    totalEstimate: readNumber(record.totalEstimate, threads.length),
  }
}

function normalizeCloudArtifact(value: unknown, fallbackOrder = 0): SessionArtifact {
  const record = asRecord(value)
  const artifactId = readString(record.artifactId, readString(record.cloudArtifactId, readString(record.id)))
  const filename = readString(record.filename, 'artifact')
  return {
    id: artifactId,
    toolId: readString(record.toolId, 'cloud-artifact'),
    toolName: readString(record.toolName, 'cloud.artifact'),
    filePath: readString(record.filePath, cloudArtifactFilePath(artifactId, filename)),
    filename,
    order: readNumber(record.order, fallbackOrder),
    source: 'cloud',
    cloudArtifactId: artifactId,
    taskRunId: readNullableString(record.taskRunId),
    mime: readNullableString(record.mime) || readNullableString(record.contentType) || undefined,
    size: readNumber(record.size),
    createdAt: readNullableString(record.createdAt) || undefined,
  }
}

function normalizeCloudArtifactAttachment(value: unknown): SessionArtifactAttachment {
  const record = asRecord(value)
  const artifact = asRecord(record.artifact || record)
  const mime = readNullableString(artifact.contentType) || readNullableString(artifact.mime) || 'application/octet-stream'
  const dataBase64 = readString(artifact.dataBase64)
  return {
    mime,
    url: `data:${mime};base64,${dataBase64}`,
    filename: readString(artifact.filename, 'artifact'),
  }
}

function normalizeSettingMetadata(value: unknown): CloudTransportSettingMetadata | null {
  const record = asRecord(value)
  const key = readString(record.key)
  if (!key) return null
  return {
    tenantId: readNullableString(record.tenantId) || undefined,
    userId: readNullableString(record.userId),
    key,
    value: asRecord(record.value),
    updatedAt: readString(record.updatedAt, new Date(0).toISOString()),
  }
}

function eventUrl(baseUrl: string, sessionId: string, afterSequence = 0) {
  const path = `${baseUrl}/api/sessions/${encodePath(sessionId)}/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

function workspaceEventUrl(baseUrl: string, afterSequence = 0) {
  const path = `${baseUrl}/api/events`
  return afterSequence > 0 ? `${path}?after=${afterSequence}` : path
}

const CLOUD_EVENT_TYPES = [
  'session.created',
  'prompt.submitted',
  'assistant.message',
  'tool.call',
  'task.run',
  'permission.requested',
  'permission.resolved',
  'question.asked',
  'question.resolved',
  'todos.updated',
  'cost.updated',
  'artifact.created',
  'session.status',
  'session.idle',
  'session.aborted',
  'runtime.error',
  'snapshot.required',
] as const

function subscribeEventSource(
  EventSourceImpl: CloudTransportEventSource,
  url: string,
  input: {
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  },
) {
  const source = new EventSourceImpl(url, {
    withCredentials: input.credentials === 'include',
  })
  const onEvent = (event: { data: string }) => {
    const parsed = JSON.parse(event.data) as CloudTransportWorkspaceEvent
    input.onEvent(parsed)
  }
  source.onmessage = onEvent
  for (const type of CLOUD_EVENT_TYPES) source.addEventListener(type, onEvent)
  source.onerror = (error) => input.onError?.(error)
  return {
    close() {
      source.close()
    },
  }
}

function subscribeFetchSse(
  fetcher: CloudTransportFetch,
  url: string,
  input: {
    headers?: Record<string, string>
    credentials?: 'include'
    onEvent: (event: CloudTransportWorkspaceEvent) => void
    onError?: (error: unknown) => void
  },
) {
  const controller = new AbortController()
  let closed = false

  const dispatch = (dataLines: string[]) => {
    if (dataLines.length === 0) return
    const parsed = JSON.parse(dataLines.join('\n')) as CloudTransportWorkspaceEvent
    input.onEvent(parsed)
  }

  void (async () => {
    const response = await fetcher(url, {
      method: 'GET',
      headers: {
        ...(input.headers || {}),
        accept: 'text/event-stream',
      },
      credentials: input.credentials,
      signal: controller.signal,
    })
    if (!response.ok) {
      throw new Error(`Cloud transport SSE subscription failed with HTTP ${response.status}: ${url}`)
    }
    if (!response.body) {
      throw new Error('Cloud transport SSE response did not include a readable stream.')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let dataLines: string[] = []

    const processLine = (rawLine: string) => {
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
      if (line === '') {
        dispatch(dataLines)
        dataLines = []
        return
      }
      if (line.startsWith(':')) return
      const delimiter = line.indexOf(':')
      const field = delimiter === -1 ? line : line.slice(0, delimiter)
      const value = delimiter === -1
        ? ''
        : line.slice(delimiter + 1).replace(/^ /, '')
      if (field === 'data') dataLines.push(value)
    }

    try {
      while (!closed) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffered += decoder.decode(chunk.value, { stream: true })
        let newlineIndex = buffered.indexOf('\n')
        while (newlineIndex >= 0) {
          processLine(buffered.slice(0, newlineIndex))
          buffered = buffered.slice(newlineIndex + 1)
          newlineIndex = buffered.indexOf('\n')
        }
      }
      buffered += decoder.decode()
      if (buffered) processLine(buffered)
      dispatch(dataLines)
    } finally {
      reader.releaseLock()
    }
  })().catch((error) => {
    if (!closed) input.onError?.(error)
  })

  return {
    close() {
      closed = true
      controller.abort()
    },
  }
}

function queryString(input: Record<string, unknown>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string' && entry) params.append(key, entry)
      }
    } else if (typeof value === 'string' && value) {
      params.set(key, value)
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      params.set(key, String(value))
    }
  }
  const serialized = params.toString()
  return serialized ? `?${serialized}` : ''
}

async function parseJson<T>(response: Awaited<ReturnType<CloudTransportFetch>>, url: string): Promise<T> {
  const text = await response.text()
  const body = text ? JSON.parse(text) as T & ApiErrorPayload : {} as T & ApiErrorPayload
  if (!response.ok) {
    throw new Error(body.error || `Cloud transport request failed with HTTP ${response.status}: ${url}`)
  }
  return body
}

export function createHttpSseCloudTransportAdapter(
  options: CloudTransportAdapterOptions = {},
): CloudTransportAdapter {
  const baseUrl = normalizeBaseUrl(options.baseUrl)
  const fetcher = options.fetch || (globalThis.fetch as unknown as CloudTransportFetch)
  const headers = {
    ...(options.headers || {}),
  }

  async function request<T>(path: string, init: {
    method?: string
    body?: unknown
  } = {}) {
    const method = init.method || 'GET'
    const nextHeaders: Record<string, string> = {
      ...headers,
    }
    let body: string | undefined
    if (init.body !== undefined) {
      nextHeaders['content-type'] = 'application/json'
      body = JSON.stringify(init.body)
    }
    if (method !== 'GET' && options.csrfToken) {
      nextHeaders['x-csrf-token'] = options.csrfToken
    }
    return parseJson<T>(await fetcher(`${baseUrl}${path}`, {
      method,
      headers: nextHeaders,
      body,
      credentials: options.credentials,
    }), path)
  }

  return {
    getConfig() {
      return request<CloudTransportConfig>('/api/config')
    },
    getRuntimeStatus() {
      return request<CloudRuntimeStatus>('/api/runtime/status')
    },
    async listSessions() {
      return (await request<{ sessions: SessionRecord[] }>('/api/sessions')).sessions
    },
    createSession(input = {}) {
      return request<CloudSessionView>('/api/sessions', {
        method: 'POST',
        body: input,
      })
    },
    getSession(sessionId) {
      return request<CloudSessionView>(`/api/sessions/${encodePath(sessionId)}`)
    },
    promptSession(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/prompt`, {
        method: 'POST',
        body: input,
      })
    },
    abortSession(sessionId) {
      return request(`/api/sessions/${encodePath(sessionId)}/abort`, {
        method: 'POST',
        body: {},
      })
    },
    replyToQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reply`, {
        method: 'POST',
        body: input,
      })
    },
    rejectQuestion(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/question-reject`, {
        method: 'POST',
        body: input,
      })
    },
    respondToPermission(sessionId, input) {
      return request(`/api/sessions/${encodePath(sessionId)}/permission-respond`, {
        method: 'POST',
        body: input,
      })
    },
    listWorkflows() {
      return request<WorkflowListPayload>('/api/workflows')
    },
    async getWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}`)).workflow
    },
    async runWorkflow(workflowId, input = {}) {
      return (await request<{ run: WorkflowRun | null }>(`/api/workflows/${encodePath(workflowId)}/run`, {
        method: 'POST',
        body: input,
      })).run
    },
    async pauseWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/pause`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async resumeWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/resume`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async archiveWorkflow(workflowId) {
      return (await request<{ workflow: WorkflowDetail | null }>(`/api/workflows/${encodePath(workflowId)}/archive`, {
        method: 'POST',
        body: {},
      })).workflow
    },
    async searchThreads(query = {}) {
      const result = await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`)
      return normalizeThreadSearchResult(result)
    },
    async threadFacets(query = {}) {
      const result = normalizeThreadSearchResult(await request<unknown>(`/api/threads${queryString({
        limit: query.limit,
        tagId: query.tagIds || [],
      })}`))
      const tags = (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
      const tagCounts = new Map<string, { label: string, color?: string, count: number }>()
      for (const thread of result.threads) {
        for (const tag of thread.tags || []) {
          const existing = tagCounts.get(tag.id) || { label: tag.name, color: tag.color, count: 0 }
          existing.count += 1
          tagCounts.set(tag.id, existing)
        }
      }
      return {
        projects: [],
        providers: [],
        models: [],
        agents: [],
        tools: [],
        mcps: [],
        statuses: [],
        tags: tags.map((tag) => ({
          value: tag.id,
          label: tag.name,
          color: tag.color,
          count: tagCounts.get(tag.id)?.count || 0,
        })),
      }
    },
    async listThreadTags() {
      return (await request<{ tags: unknown[] }>('/api/threads/tags')).tags.map(normalizeThreadTag)
    },
    async createThreadTag(input) {
      return normalizeThreadTag((await request<{ tag: unknown }>('/api/threads/tags', {
        method: 'POST',
        body: input,
      })).tag)
    },
    async updateThreadTag(tagId, input) {
      const tag = (await request<{ tag: unknown | null }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'PATCH',
        body: input,
      })).tag
      return tag ? normalizeThreadTag(tag) : null
    },
    async deleteThreadTag(tagId) {
      return (await request<{ deleted: boolean }>(`/api/threads/tags/${encodePath(tagId)}`, {
        method: 'DELETE',
      })).deleted
    },
    async applyThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/apply`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async removeThreadTags(sessionIds, tagIds) {
      for (const tagId of tagIds) {
        await request<{ ok: true }>(`/api/threads/tags/${encodePath(tagId)}/remove`, {
          method: 'POST',
          body: { sessionIds },
        })
      }
      return true
    },
    async listThreadSmartFilters() {
      return (await request<{ filters: unknown[] }>('/api/threads/smart-filters')).filters.map(normalizeThreadSmartFilter)
    },
    async createThreadSmartFilter(input) {
      return normalizeThreadSmartFilter((await request<{ filter: unknown }>('/api/threads/smart-filters', {
        method: 'POST',
        body: input,
      })).filter)
    },
    async updateThreadSmartFilter(filterId, input) {
      const filter = (await request<{ filter: unknown | null }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'PATCH',
        body: input,
      })).filter
      return filter ? normalizeThreadSmartFilter(filter) : null
    },
    async deleteThreadSmartFilter(filterId) {
      return (await request<{ deleted: boolean }>(`/api/threads/smart-filters/${encodePath(filterId)}`, {
        method: 'DELETE',
      })).deleted
    },
    async listArtifacts(sessionId) {
      return (await request<{ artifacts: unknown[] }>(`/api/sessions/${encodePath(sessionId)}/artifacts`))
        .artifacts
        .map((artifact, index) => normalizeCloudArtifact(artifact, index))
    },
    async uploadArtifact(sessionId, input) {
      return normalizeCloudArtifact((await request<{ artifact: unknown }>(`/api/sessions/${encodePath(sessionId)}/artifacts`, {
        method: 'POST',
        body: {
          filename: input.filename,
          contentType: input.contentType || null,
          dataBase64: input.dataBase64,
        },
      })).artifact)
    },
    async readArtifactAttachment(sessionId, filePathOrArtifactId) {
      const artifactId = cloudArtifactIdFromFilePath(filePathOrArtifactId) || filePathOrArtifactId.trim()
      if (!artifactId) throw new Error('Cloud artifact id is required.')
      return normalizeCloudArtifactAttachment(await request<{ artifact: unknown }>(
        `/api/sessions/${encodePath(sessionId)}/artifacts/${encodePath(artifactId)}`,
      ))
    },
    async listCapabilityTools() {
      return (await request<{ tools: CapabilityTool[] }>('/api/capabilities/tools')).tools
    },
    async getCapabilityTool(toolId) {
      const response = await request<{ tool: CapabilityTool }>(`/api/capabilities/tools/${encodePath(toolId)}`)
      return response.tool || null
    },
    async listCapabilitySkills() {
      return (await request<{ skills: CapabilitySkill[] }>('/api/capabilities/skills')).skills
    },
    async getCapabilitySkillBundle(skillName) {
      const response = await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)
      return response.bundle || null
    },
    async readCapabilitySkillBundleFile(skillName, filePath) {
      const bundle = (await request<{ bundle: CapabilitySkillBundle | null }>(`/api/capabilities/skills/${encodePath(skillName)}/bundle`)).bundle
      const file = bundle?.files.find((entry) => entry.path === filePath) as { content?: unknown } | undefined
      return typeof file?.content === 'string' ? file.content : null
    },
    async listSettings() {
      return (await request<{ settings: unknown[] }>('/api/settings')).settings
        .map(normalizeSettingMetadata)
        .filter((setting): setting is CloudTransportSettingMetadata => Boolean(setting))
    },
    async getSetting(key) {
      const setting = normalizeSettingMetadata((await request<{ setting: unknown | null }>(`/api/settings/${encodePath(key)}`)).setting)
      return setting
    },
    async setSetting(key, value) {
      const setting = normalizeSettingMetadata((await request<{ setting: unknown }>(`/api/settings/${encodePath(key)}`, {
        method: 'PUT',
        body: { value },
      })).setting)
      if (!setting) throw new Error('Cloud setting response was invalid.')
      return setting
    },
    workspaceEventsUrl(afterSequence = 0) {
      return workspaceEventUrl(baseUrl, afterSequence)
    },
    sessionEventsUrl(sessionId, afterSequence = 0) {
      return eventUrl(baseUrl, sessionId, afterSequence)
    },
    subscribeWorkspaceEvents(input) {
      if (Object.keys(headers).length > 0) {
        return subscribeFetchSse(fetcher, workspaceEventUrl(baseUrl, input.afterSequence), {
          headers,
          credentials: options.credentials,
          onEvent: input.onEvent,
          onError: input.onError,
        })
      }
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
      return subscribeEventSource(EventSourceImpl, workspaceEventUrl(baseUrl, input.afterSequence), {
        credentials: options.credentials,
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
    subscribeSessionEvents(sessionId, input) {
      if (Object.keys(headers).length > 0) {
        return subscribeFetchSse(fetcher, eventUrl(baseUrl, sessionId, input.afterSequence), {
          headers,
          credentials: options.credentials,
          onEvent: input.onEvent,
          onError: input.onError,
        })
      }
      const EventSourceImpl = options.eventSource || (globalThis as unknown as { EventSource?: CloudTransportEventSource }).EventSource
      if (!EventSourceImpl) throw new Error('EventSource is not available for cloud transport subscriptions.')
      return subscribeEventSource(EventSourceImpl, eventUrl(baseUrl, sessionId, input.afterSequence), {
        credentials: options.credentials,
        onEvent: input.onEvent,
        onError: input.onError,
      })
    },
  }
}
