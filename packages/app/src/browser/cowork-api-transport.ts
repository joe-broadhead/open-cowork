// Browser cloud transport + SSE event hub for the cowork API facade.
// Extracted from cowork-api.ts (JOE-884).

import {
  cloudSessionViewToSessionView,
  emptySessionView,
  type SessionInfo,
  type SessionPatch,
  type SessionView,
  type WorkspaceSessionsUpdatedEvent,
} from '@open-cowork/shared'
import { createCloudTranscriptProjector, type CloudTranscriptProjector } from './cowork-api-transcript'

export type BrowserCoworkApiBootstrap = {
  api?: Array<{ id: string; path: string }>
  sessionEventTypes?: string[]
  authRequired?: boolean
  csrfToken?: string | null
}

type QueryValue = string | number | boolean | null | undefined | Array<string | null | undefined>

type RequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  body?: unknown
  headers?: Record<string, string>
}

// Canonical endpoint paths. The cloud server stays the source of truth: the
// bootstrap blob it injects (when present) overrides each path at runtime. These
// inline defaults keep the browser shim self-contained so it has no build-time
// dependency on the server package.
const DEFAULT_ENDPOINTS: Record<string, string> = {
  authMe: '/auth/me',
  authLogout: '/auth/logout',
  config: '/api/config',
  workspace: '/api/workspace',
  settings: '/api/settings',
  setting: '/api/settings/:settingKey',
  sessions: '/api/sessions',
  sessionView: '/api/sessions/:sessionId/view',
  sessionActivate: '/api/sessions/:sessionId/activate',
  sessionEvents: '/api/sessions/:sessionId/events',
  sessionPrompt: '/api/sessions/:sessionId/prompt',
  sessionAbort: '/api/sessions/:sessionId/abort',
  sessionPermissionRespond: '/api/sessions/:sessionId/permission-respond',
  sessionQuestionReply: '/api/sessions/:sessionId/question-reply',
  sessionQuestionReject: '/api/sessions/:sessionId/question-reject',
  sessionArtifacts: '/api/sessions/:sessionId/artifacts',
  sessionArtifact: '/api/sessions/:sessionId/artifacts/:artifactId',
  sessionArtifactStatus: '/api/sessions/:sessionId/artifacts/:artifactId/status',
  sessionArtifactFinalize: '/api/sessions/:sessionId/artifacts/:artifactId/finalize',
  artifactsIndex: '/api/artifacts',
  launchpadFeed: '/api/launchpad/feed',
  knowledgeSnapshot: '/api/knowledge',
  knowledgeSpaceCreate: '/api/knowledge/spaces',
  knowledgeProposalCreate: '/api/knowledge/proposals',
  knowledgeProposalAccept: '/api/knowledge/proposals/:proposalId/accept',
  knowledgeProposalDecline: '/api/knowledge/proposals/:proposalId/decline',
  knowledgePageHistory: '/api/knowledge/pages/:pageId/history',
  knowledgePageRestore: '/api/knowledge/pages/:pageId/restore',
  capabilitiesCatalog: '/api/capabilities',
  capabilityTools: '/api/capabilities/tools',
  capabilityTool: '/api/capabilities/tools/:toolId',
  capabilitySkills: '/api/capabilities/skills',
  capabilitySkill: '/api/capabilities/skills/:skillName',
  capabilitySkillBundle: '/api/capabilities/skills/:skillName/bundle',
  workflows: '/api/workflows',
  workflow: '/api/workflows/:workflowId',
  workflowRun: '/api/workflows/:workflowId/run',
  workflowPause: '/api/workflows/:workflowId/pause',
  workflowResume: '/api/workflows/:workflowId/resume',
  workflowArchive: '/api/workflows/:workflowId/archive',
  coordinationBoard: '/api/coordination/board',
  coordinationProjects: '/api/coordination/projects',
  coordinationProjectCreate: '/api/coordination/projects',
  coordinationProject: '/api/coordination/projects/:projectId',
  coordinationPlanWithCleo: '/api/coordination/projects/:projectId/plan-with-cleo',
  coordinationTasks: '/api/coordination/tasks',
  coordinationTaskCreate: '/api/coordination/tasks',
  coordinationTask: '/api/coordination/tasks/:taskId',
  coordinationTaskMove: '/api/coordination/tasks/:taskId/move',
  coordinationTaskAssign: '/api/coordination/tasks/:taskId/assign',
  coordinationTaskLinkWork: '/api/coordination/tasks/:taskId/link-work',
  coordinationTaskWorkTarget: '/api/coordination/tasks/:taskId/work-target',
  coordinationWatches: '/api/coordination/watches',
  coordinationWatchCreate: '/api/coordination/watches',
  coordinationWatch: '/api/coordination/watches/:watchId',
  coordinationWatchPause: '/api/coordination/watches/:watchId/pause',
  coordinationWatchResume: '/api/coordination/watches/:watchId/resume',
  coordinationWatchDelete: '/api/coordination/watches/:watchId',
  projectSourceValidate: '/api/project-sources/validate',
  projectSnapshots: '/api/project-sources/snapshots',
  channelProviders: '/api/channels/providers',
  channelAgents: '/api/channels/agents',
  channelAgentCreate: '/api/channels/agents',
  channelAgentUpdate: '/api/channels/agents/:agentId',
  channelBindings: '/api/channels/bindings',
  channelBindingCreate: '/api/channels/bindings',
  channelBindingUpdate: '/api/channels/bindings/:bindingId',
  channelIdentities: '/api/channels/identities',
  channelIdentityResolve: '/api/channels/identities/resolve',
  channelDeliveries: '/api/channels/deliveries',
  channelDeliveryRetry: '/api/channels/deliveries/:deliveryId/retry',
  channelDeliveryDeadLetter: '/api/channels/deliveries/:deliveryId/dead-letter',
  threadsSearch: '/api/threads/search',
  threadsFacets: '/api/threads/facets',
  workspaceEvents: '/api/events',
  runtimeStatus: '/api/runtime/status',
  diagnostics: '/api/diagnostics',
}

const BROWSER_UNAVAILABLE_AUTH_EVENT = 'open-cowork-cloud-auth-required'

export function browserUnavailable(name: string): never {
  throw new Error(`${name} is not available in the browser build.`)
}

// Decode the renderer's base64 artifact payload into raw bytes for a direct PUT to object
// storage. The artifact upload API hands us base64 (or base64url); the object store wants the
// bytes themselves. Used only by the presigned-upload fast path; the buffered path posts the
// base64 string unchanged through the cloud API.
function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

// Shape of the cloud "begin presigned upload" response (POST /artifacts?transfer=presigned).
type PresignedUploadBegin = {
  transfer?: string
  artifactId?: string
  uploadUrl?: string
  uploadMethod?: string
  uploadHeaders?: Record<string, string>
  uploadExpiresAt?: string
}

export function readBootstrapFromWindow(): BrowserCoworkApiBootstrap | null {
  if (typeof document === 'undefined') return null
  // The cloud server injects the bootstrap blob into <script id="cowork-bootstrap">
  // (see packages/cloud-server/src/browser-renderer-app.ts). browser-main.tsx
  // normally reads it and passes it in; this is the no-arg fallback.
  const node = document.getElementById('cowork-bootstrap')
  if (!node?.textContent) return null
  try {
    return JSON.parse(node.textContent) as BrowserCoworkApiBootstrap
  } catch {
    return null
  }
}

/**
 * Build the self-contained transport: a `request` (fetch + CSRF + 401) and a
 * `stream` (EventSource) bound to the resolved endpoint registry. This browser
 * shim, talking to the cloud server's same-origin /api, /auth and /events routes,
 * is the canonical web client — there is no separate website implementation.
 */
// Exported for white-box transport tests (CSRF fetch/attach/retry). Not part of
// the public CoworkAPI surface — callers use createBrowserCoworkApi.
export function createTransport(bootstrap: BrowserCoworkApiBootstrap) {
  // CSRF: the cloud uses double-submit CSRF. The token is NOT carried in the
  // bootstrap; we fetch it from /auth/me at runtime (the server's intended
  // design) and send it as x-csrf-token on every mutation. Without this, an
  // authenticated cookie/OIDC deployment rejects every mutating request 403.
  let csrfToken: string | null = bootstrap.csrfToken ?? null
  let csrfPromise: Promise<void> | null = null

  const registry = new Map<string, string>()
  for (const [id, path] of Object.entries(DEFAULT_ENDPOINTS)) registry.set(id, path)
  for (const entry of bootstrap.api || []) {
    if (entry?.id && entry.path) registry.set(entry.id, entry.path)
  }

  const sessionEventTypes = bootstrap.sessionEventTypes || []

  const endpoint = (id: keyof typeof DEFAULT_ENDPOINTS | string, params: Record<string, string | number> = {}) => {
    let path = registry.get(id) || DEFAULT_ENDPOINTS[id] || ''
    for (const [key, value] of Object.entries(params)) {
      path = path.replace(`:${key}`, encodeURIComponent(String(value)))
    }
    return path
  }

  const withQuery = (path: string, query: Record<string, QueryValue> = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(query)) {
      if (value === null || value === undefined || value === '') continue
      if (Array.isArray(value)) {
        for (const entry of value) {
          if (entry) params.append(key, entry)
        }
      } else {
        params.set(key, String(value))
      }
    }
    const text = params.toString()
    return text ? `${path}?${text}` : path
  }

  const rawRequest = async <T = unknown>(path: string, options: RequestOptions = {}): Promise<T> => {
    const hasBody = options.body !== undefined
    const response = await fetch(path, {
      method: options.method || (hasBody ? 'POST' : 'GET'),
      credentials: 'same-origin',
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...(csrfToken ? { 'x-csrf-token': csrfToken } : {}),
        ...(options.headers || {}),
      },
      body: hasBody ? JSON.stringify(options.body) : undefined,
    })
    if (!response.ok) {
      let message = `Request failed with status ${response.status}`
      let body: unknown = null
      try {
        body = await response.json()
        const errorMessage = (body as { error?: string } | null)?.error
        if (errorMessage) message = errorMessage
      } catch {
        // Preserve the status-based fallback.
      }
      const error = new Error(message) as Error & { status?: number; body?: unknown }
      error.status = response.status
      error.body = body
      if (response.status === 401) {
        csrfToken = null
        if (typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent(BROWSER_UNAVAILABLE_AUTH_EVENT, { detail: { path } }))
          // The renderer owns the signed-out UI state. Do not redirect from the
          // transport: doing so made initial 401s race the app bootstrap and
          // prevented the LoginScreen from ever rendering. The explicit login
          // action still navigates to /auth/login through auth.login().
        }
      }
      throw error
    }
    if (response.status === 204) return undefined as T
    const text = await response.text()
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }

  // Fetch the double-submit CSRF token from /auth/me (a GET, so it carries no
  // token itself). Memoized so concurrent first mutations share one fetch; the
  // memo is reset to force a refetch after a 403. The ephemeral auth=none cloud
  // returns csrfToken:null and does not enforce CSRF, so a null token is fine.
  const fetchCsrf = async () => {
    try {
      const me = await rawRequest<{ csrfToken?: string | null }>(endpoint('authMe'), { method: 'GET' })
      csrfToken = typeof me?.csrfToken === 'string' && me.csrfToken ? me.csrfToken : null
    } catch {
      // Leave csrfToken null; a subsequent mutation 403 triggers a retry.
    }
  }
  const ensureCsrf = () => {
    if (!csrfPromise) csrfPromise = fetchCsrf()
    return csrfPromise
  }

  const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

  const request = async <T = unknown>(path: string, options: RequestOptions = {}): Promise<T> => {
    const method = options.method || (options.body !== undefined ? 'POST' : 'GET')
    if (MUTATING_METHODS.has(method) && csrfToken === null) await ensureCsrf()
    try {
      return await rawRequest<T>(path, { ...options, method })
    } catch (error) {
      const status = (error as { status?: number } | null)?.status
      // A 403 on a mutation usually means a stale/absent CSRF token — refetch it
      // once and retry. (401 is handled in rawRequest: redirect to login.)
      if (status === 403 && MUTATING_METHODS.has(method)) {
        csrfPromise = null
        csrfToken = null
        await ensureCsrf()
        return await rawRequest<T>(path, { ...options, method })
      }
      throw error
    }
  }

  return {
    request,
    endpoint,
    withQuery,
    sessionEventTypes,
  }
}

type Transport = ReturnType<typeof createTransport>

// ---------------------------------------------------------------------------
// SSE event demux
// ---------------------------------------------------------------------------

type SseEvent = { type: string; data: Record<string, unknown> }

type Listener<T> = (value: T) => void

function parseSseEvent(event: MessageEvent, type: string): SseEvent {
  let data: unknown = event.data
  if (typeof event.data === 'string' && event.data.trim()) {
    try {
      data = JSON.parse(event.data)
    } catch {
      data = event.data
    }
  }
  const record = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  return { type, data: record }
}

export { createCloudTranscriptProjector, type CloudTranscriptProjector }

/**
 * Owns the cloud SSE streams (workspace + per-session) and fans each incoming
 * cloud session event out to the registered `on.*` callbacks — demultiplexing
 * the single `{ type, data }` SSE shape back into the per-channel callbacks the
 * renderer registered, so it sees the same event surface as the Electron bridge.
 */
export class CloudEventHub {
  private workspaceSource: EventSource | null = null
  // Per-session SSE streams, opened lazily when a session view is first observed
  // via activate(). Insertion order is the LRU order: re-activating a session moves
  // it to the end, and once MAX_TRACKED_SESSIONS is reached the least-recently
  // activated stream is closed and evicted. Without this bound, every thread ever
  // viewed leaked a client connection AND a held-open server-side subscription (#905).
  private readonly sessionSources = new Map<string, EventSource>()
  private static readonly MAX_TRACKED_SESSIONS = 24
  // Accumulates streamed assistant text per session so each delta SSE event becomes a
  // full-text REPLACE sessionPatch (PERF-2). See createCloudTranscriptProjector.
  private readonly transcriptProjector = createCloudTranscriptProjector()

  readonly listeners = {
    sessionPatch: new Set<Listener<SessionPatch>>(),
    sessionView: new Set<Listener<{ sessionId: string; workspaceId?: string | null; view: SessionView }>>(),
    sessionUpdated: new Set<Listener<{
      id: string
      workspaceId?: string | null
      title: string | null
      parentSessionId?: string | null
      changeSummary?: SessionChangeSummary | null
      revertedMessageId?: string | null
      composerAgentName?: string | null
      composerModelId?: string | null
      composerReasoningVariant?: string | null
    }>>(),
    sessionDeleted: new Set<Listener<{ id: string; workspaceId?: string | null }>>(),
    permissionRequest: new Set<Listener<PermissionRequest>>(),
    workspaceSessionsUpdated: new Set<Listener<WorkspaceSessionsUpdatedEvent>>(),
    coordinationUpdated: new Set<Listener<void>>(),
    workflowUpdated: new Set<Listener<void>>(),
    knowledgeUpdated: new Set<Listener<void>>(),
    mcpStatus: new Set<Listener<McpStatus[]>>(),
    notification: new Set<Listener<RuntimeNotification>>(),
    runtimeReady: new Set<Listener<void>>(),
    runtimeLoadingStatus: new Set<Listener<RuntimeLoadingStatus>>(),
    authExpired: new Set<Listener<void>>(),
    authLogout: new Set<Listener<void>>(),
    menuAction: new Set<Listener<string>>(),
    menuNavigate: new Set<Listener<string>>(),
  }

  constructor(private readonly transport: Transport) {
    if (typeof window !== 'undefined') {
      window.addEventListener(BROWSER_UNAVAILABLE_AUTH_EVENT, () => {
        for (const listener of this.listeners.authExpired) listener()
      })
    }
  }

  /** Lazily open the workspace SSE stream once any channel needs it. */
  private ensureWorkspaceStream() {
    if (this.workspaceSource || typeof EventSource === 'undefined') return
    const path = this.transport.endpoint('workspaceEvents')
    const source = new EventSource(path, { withCredentials: true })
    const dispatch = (event: MessageEvent, type: string) => this.dispatchSessionEvent(parseSseEvent(event, type))
    source.onmessage = (event) => dispatch(event, 'message')
    for (const type of this.transport.sessionEventTypes) {
      source.addEventListener(type, (event) => dispatch(event as MessageEvent, type))
    }
    source.addEventListener('snapshot.required', () => {
      // Hint to consumers that they should re-hydrate; the renderer re-fetches
      // session/workspace state on the workspaceSessionsUpdated channel.
      for (const listener of this.listeners.workspaceSessionsUpdated) {
        listener({ workspaceId: '', sessions: [], syncedAt: new Date().toISOString() })
      }
    })
    this.workspaceSource = source
  }

  /** Open a per-session SSE stream so message/tool patches flow for it. */
  trackSession(sessionId: string) {
    if (!sessionId || typeof EventSource === 'undefined') return
    const existing = this.sessionSources.get(sessionId)
    if (existing) {
      // Already streaming — mark as most-recently-used (Map preserves insertion order).
      this.sessionSources.delete(sessionId)
      this.sessionSources.set(sessionId, existing)
      return
    }
    // Evict the least-recently-activated stream(s) before opening a new one so the
    // number of live EventSource connections (and server subscriptions) stays bounded.
    while (this.sessionSources.size >= CloudEventHub.MAX_TRACKED_SESSIONS) {
      const oldest = this.sessionSources.keys().next().value
      if (oldest === undefined) break
      this.untrackSession(oldest)
    }
    const path = this.transport.endpoint('sessionEvents', { sessionId })
    const source = new EventSource(path, { withCredentials: true })
    const dispatch = (event: MessageEvent, type: string) => this.dispatchSessionEvent(parseSseEvent(event, type), sessionId)
    source.onmessage = (event) => dispatch(event, 'message')
    for (const type of this.transport.sessionEventTypes) {
      source.addEventListener(type, (event) => dispatch(event as MessageEvent, type))
    }
    this.sessionSources.set(sessionId, source)
  }

  /** Close and evict a per-session SSE stream (LRU eviction or session deletion). */
  untrackSession(sessionId: string) {
    const source = this.sessionSources.get(sessionId)
    if (!source) return
    source.close()
    this.sessionSources.delete(sessionId)
    this.transcriptProjector.forget(sessionId)
  }

  /**
   * Map a single cloud session event to the renderer's per-channel callbacks.
   * The cloud session event contract (CLOUD_SESSION_EVENT_TYPES) is the source
   * vocabulary; we translate it to the renderer's `on.*` vocabulary.
   */
  private dispatchSessionEvent(event: SseEvent, sessionId?: string) {
    const payload = event.data
    const eventSessionId = sessionId || (typeof payload.sessionId === 'string' ? payload.sessionId : '')
    const workspaceId = typeof payload.workspaceId === 'string' ? payload.workspaceId : null
    switch (event.type) {
      case 'assistant.message': {
        // Route the streamed assistant delta through the renderer's batched sessionPatch
        // path (the same 32ms coalescer + incremental session-view-reducer the desktop
        // uses) so the transcript advances LIVE and many tokens fold into one reducer
        // pass — instead of the empty-view nudge, which never carried the new text and so
        // only advanced the transcript on thread re-open (PERF-2). A non-mappable event
        // (no messageId) falls back to the view nudge.
        const patch = this.transcriptProjector.patchFor(payload, eventSessionId, workspaceId)
        if (patch) {
          for (const listener of this.listeners.sessionPatch) listener(patch)
        } else if (eventSessionId) {
          for (const listener of this.listeners.sessionView) {
            listener({ sessionId: eventSessionId, workspaceId, view: emptySessionView() })
          }
        }
        for (const listener of this.listeners.workspaceSessionsUpdated) {
          listener({ workspaceId: workspaceId || '', sessions: [], syncedAt: new Date().toISOString() })
        }
        break
      }
      case 'tool.call':
      case 'task.run':
      case 'cost.updated':
      case 'todos.updated':
      case 'session.status':
      case 'session.idle':
      case 'session.created':
      case 'session.imported':
      case 'artifact.created':
      case 'artifact.updated': {
        // Non-text projected events invalidate the session view. The cloud delivers the
        // canonical projection on the `/view` envelope, so the renderer refreshes; here we
        // emit a best-effort empty-view nudge keyed by session so the view subscriber
        // re-pulls. The renderer's sessionView handler is keyed on sessionId.
        if (eventSessionId) {
          for (const listener of this.listeners.sessionView) {
            listener({ sessionId: eventSessionId, workspaceId, view: emptySessionView() })
          }
        }
        for (const listener of this.listeners.workspaceSessionsUpdated) {
          listener({ workspaceId: workspaceId || '', sessions: [], syncedAt: new Date().toISOString() })
        }
        break
      }
      case 'permission.requested': {
        const request = this.toPermissionRequest(payload, eventSessionId, workspaceId)
        if (request) for (const listener of this.listeners.permissionRequest) listener(request)
        break
      }
      case 'session.aborted':
      case 'runtime.error':
      case 'permission.resolved':
      case 'question.asked':
      case 'question.resolved': {
        if (eventSessionId) {
          for (const listener of this.listeners.sessionView) {
            listener({ sessionId: eventSessionId, workspaceId, view: emptySessionView() })
          }
        }
        if (event.type === 'runtime.error') {
          for (const listener of this.listeners.notification) {
            listener({ type: 'error', sessionId: eventSessionId || null, workspaceId })
          }
        }
        if (event.type === 'session.aborted') {
          for (const listener of this.listeners.notification) {
            listener({ type: 'done', sessionId: eventSessionId || null, workspaceId })
          }
        }
        break
      }
      case 'channel.delivery':
        // Channel deliveries aren't part of the renderer's `on.*` surface.
        break
      default:
        break
    }
  }

  private toPermissionRequest(
    payload: Record<string, unknown>,
    sessionId: string,
    workspaceId: string | null,
  ): PermissionRequest | null {
    const id = typeof payload.id === 'string' ? payload.id : typeof payload.permissionId === 'string' ? payload.permissionId : ''
    if (!id || !sessionId) return null
    return {
      id,
      sessionId,
      workspaceId,
      taskRunId: typeof payload.taskRunId === 'string' ? payload.taskRunId : null,
      tool: typeof payload.tool === 'string' ? payload.tool : '',
      input: (payload.input && typeof payload.input === 'object' ? payload.input : {}) as Record<string, unknown>,
      description: typeof payload.description === 'string' ? payload.description : '',
    }
  }

  subscribe<K extends keyof CloudEventHub['listeners']>(
    channel: K,
    callback: CloudEventHub['listeners'][K] extends Set<infer L> ? L : never,
  ): () => void {
    this.ensureWorkspaceStream()
    const set = this.listeners[channel] as Set<unknown>
    set.add(callback)
    return () => {
      set.delete(callback)
    }
  }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

export function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>)[key]
    if (inner !== undefined) return inner as T
  }
  return fallback
}

export function cloudViewToSessionInfo(view: unknown): SessionInfo {
  const record = (view && typeof view === 'object' ? view : {}) as Record<string, unknown>
  const session = (record.session && typeof record.session === 'object' ? record.session : record) as Record<string, unknown>
  const id = typeof session.sessionId === 'string'
    ? session.sessionId
    : typeof session.id === 'string'
      ? session.id
      : ''
  const now = new Date().toISOString()
  return {
    id,
    title: typeof session.title === 'string' ? session.title : undefined,
    directory: null,
    createdAt: typeof session.createdAt === 'string' ? session.createdAt : now,
    updatedAt: typeof session.updatedAt === 'string' ? session.updatedAt : now,
    profileName: typeof session.profileName === 'string' ? session.profileName : undefined,
  } as SessionInfo
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
