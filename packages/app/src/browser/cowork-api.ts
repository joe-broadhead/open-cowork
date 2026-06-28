// Browser implementation of the renderer's `window.coworkApi` bridge.
//
// The desktop renderer is written entirely against the fully-typed `CoworkAPI`
// surface (see `@open-cowork/shared` → `CoworkAPI`). On Electron the preload
// supplies that object over IPC. This module supplies the SAME `CoworkAPI`
// backed by the cloud HTTP + SSE API, so a browser build of the renderer can
// run unchanged against the cloud control plane.
//
// IMPORTANT: this file must ONLY be imported by the future browser entry point.
// It must never be reachable from the Electron renderer (`index.tsx`) or any
// module the Electron build loads — it speaks `fetch`/`EventSource`, not IPC.
//
// Design notes:
//   * Self-contained transport. The minimal fetch/CSRF/401 + SSE helpers live
//     here so the renderer's browser build depends only on the cloud HTTP API
//     surface, never on a server-side package.
//   * Envelope (un)wrapping. The cloud routes return data in their own
//     envelopes (`{ providers }`, `{ session, projection, view }`, …); each
//     method unwraps/rewraps to the shape `CoworkAPI` declares.
//   * Events. The cloud exposes a workspace SSE stream + per-session SSE
//     streams. We multiplex those into the per-channel `on.*` callbacks the
//     renderer subscribes to — the same `window.coworkApi.on.*` surface the
//     Electron preload bridge supplies on desktop.
//   * Electron-only methods (native dialogs, runtime restart, desktop pairing,
//     updates, local OAuth, FS imports, app reset) have no cloud equivalent.
//     They are implemented as signature-satisfying stubs that either use a
//     browser primitive where one exists, or reject/no-op with a clear
//     "unavailable in the browser build" message.

import {
  cloudArtifactIdFromFilePath,
  cloudSessionViewToSessionView,
  emptySessionView,
  WORKSPACE_SUPPORT_APIS,
  type AgentCatalog,
  type AppMetadata,
  type ArtifactIndexPayload,
  type AuthState,
  type ChannelApiSurface,
  type CloudProjectSnapshotInventory,
  type CloudProjectSnapshotUploadResult,
  type CloudProjectSourcePolicyVerdict,
  type CoordinationBoardPayload,
  type CoordinationProject,
  type CoordinationTask,
  type CoordinationWatch,
  type CoworkAPI,
  type DesktopPairingAuditEvent,
  type DesktopPairingCreated,
  type DesktopPairingPublicRecord,
  type DesktopPairingStatusSnapshot,
  type DestructiveConfirmationGrant,
  type EffectiveAppSettings,
  type KnowledgePageVersion,
  type KnowledgeProposal,
  type KnowledgeSnapshotPayload,
  type KnowledgeSpace,
  type LaunchpadFeedPayload,
  type McpStatus,
  type ModelInfoSnapshot,
  type PermissionRequest,
  type ProviderAuthMethod,
  type PublicAppConfig,
  type RuntimeLoadingStatus,
  type RuntimeNotification,
  type RuntimeStatus,
  type SessionArtifact,
  type SessionArtifactAttachment,
  type SessionChangeSummary,
  type SessionInfo,
  type SessionPatch,
  type SessionView,
  type ThreadFacetSummary,
  type ThreadSearchResult,
  type UpdateInstallStatus,
  type WorkflowDetail,
  type WorkflowListPayload,
  type WorkflowRun,
  type WorkspaceApiSupport,
  type WorkspaceInfo,
  type WorkspaceSessionsUpdatedEvent,
} from '@open-cowork/shared'

// ---------------------------------------------------------------------------
// Bootstrap + transport
// ---------------------------------------------------------------------------

/**
 * The minimal shape of the server-embedded bootstrap blob this adapter reads.
 * The cloud server renders it into `<script id="cowork-bootstrap">` (see
 * packages/cloud-server/src/browser-renderer-app.ts). We only need the optional
 * endpoint registry, the per-session SSE event types, and an optional CSRF
 * token; everything else is ignored here.
 */
export type BrowserCoworkApiBootstrap = {
  api?: Array<{ id: string; path: string }>
  sessionEventTypes?: string[]
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

function browserUnavailable(name: string): never {
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

function readBootstrapFromWindow(): BrowserCoworkApiBootstrap | null {
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
          // Cloud auth is server-driven: a 401 means the session is missing or
          // expired, so send the browser to the OIDC login, which redirects back
          // authenticated. (The ephemeral auth=none cloud returns 200 on /auth/me,
          // so this never fires there.) Skip when already on the auth path to
          // avoid a redirect loop.
          if (!window.location.pathname.startsWith('/auth/')) {
            window.location.assign('/auth/login')
          }
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

export type CloudTranscriptProjector = {
  patchFor(record: Record<string, unknown>, sessionId: string, workspaceId: string | null): SessionPatch | null
}

/**
 * Project cloud `assistant.message` SSE events into renderer `SessionPatch`es so the
 * streamed transcript flows through the SAME batched path the desktop uses (the 32ms
 * coalescer in useOpenCodeEvents + the incremental session-view-reducer) instead of an
 * O(M²) full-view rebuild per event (PERF-2). `record` is the full SSE data envelope
 * `{ sessionId, sequence, payload: { messageId, content, mode } }`.
 *
 * Byte-identical guarantee: the cloud projection models each message as ONE monolithic
 * content blob built by plain concatenation of the append deltas (see
 * reduceCloudSessionProjectionEvent → 'assistant.message'). We mirror that exactly: this
 * projector accumulates the deltas by plain concatenation and emits a REPLACE patch
 * carrying the FULL message text each time. The reducer's replace branch sets the segment
 * content directly — it does NOT run the desktop's `mergeStreamingText` overlap heuristic,
 * which is tuned for cumulative SDK text and would otherwise dedupe a coincidental
 * delta-boundary overlap. The streamed transcript is therefore identical to the canonical
 * `/view`, regardless of how the deltas were chunked or coalesced upstream (PERF-1). A
 * full snapshot (`mode` absent) carries the canonical text and is adopted verbatim.
 * eventAt is the projection `sequence`, matching the cloud session view's `lastEventAt`
 * scale so buffer pruning and the streaming-state merge stay consistent. Exported for
 * white-box reducer tests.
 */
export function createCloudTranscriptProjector(): CloudTranscriptProjector {
  // One accumulator per session — overwritten when a new message starts, so memory is
  // bounded by the number of tracked sessions rather than the message count.
  const bySession = new Map<string, { messageId: string; content: string }>()

  const patchFor = (
    record: Record<string, unknown>,
    sessionId: string,
    workspaceId: string | null,
  ): SessionPatch | null => {
    if (!sessionId) return null
    const projected = record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {}
    const messageId = typeof projected.messageId === 'string' && projected.messageId ? projected.messageId : ''
    if (!messageId) return null
    const delta = typeof projected.content === 'string' ? projected.content : ''
    const isAppend = projected.mode === 'append'
    const sequence = typeof record.sequence === 'number' && Number.isFinite(record.sequence) ? record.sequence : 0

    const prior = bySession.get(sessionId)
    const content = isAppend
      ? (prior && prior.messageId === messageId ? prior.content + delta : delta)
      : delta
    // An append delta that hasn't produced any text yet carries no transcript change.
    if (isAppend && !content) return null
    bySession.set(sessionId, { messageId, content })

    return {
      type: 'message_text',
      sessionId,
      workspaceId,
      messageId,
      segmentId: messageId,
      content,
      mode: 'replace',
      role: 'assistant',
      eventAt: sequence,
    }
  }

  return { patchFor }
}

/**
 * Owns the cloud SSE streams (workspace + per-session) and fans each incoming
 * cloud session event out to the registered `on.*` callbacks — demultiplexing
 * the single `{ type, data }` SSE shape back into the per-channel callbacks the
 * renderer registered, so it sees the same event surface as the Electron bridge.
 */
class CloudEventHub {
  private workspaceSource: EventSource | null = null
  private readonly sessionSources = new Map<string, EventSource>()
  // Sessions the renderer currently cares about (one per `on.sessionView`-style
  // subscription is overkill, so we open a per-session stream lazily when a
  // session view is first observed via activate()).
  private readonly trackedSessions = new Set<string>()
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
    if (!sessionId || this.trackedSessions.has(sessionId) || typeof EventSource === 'undefined') return
    this.trackedSessions.add(sessionId)
    const path = this.transport.endpoint('sessionEvents', { sessionId })
    const source = new EventSource(path, { withCredentials: true })
    const dispatch = (event: MessageEvent, type: string) => this.dispatchSessionEvent(parseSseEvent(event, type), sessionId)
    source.onmessage = (event) => dispatch(event, 'message')
    for (const type of this.transport.sessionEventTypes) {
      source.addEventListener(type, (event) => dispatch(event as MessageEvent, type))
    }
    this.sessionSources.set(sessionId, source)
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

function unwrap<T>(value: unknown, key: string, fallback: T): T {
  if (value && typeof value === 'object' && key in (value as Record<string, unknown>)) {
    const inner = (value as Record<string, unknown>)[key]
    if (inner !== undefined) return inner as T
  }
  return fallback
}

function cloudViewToSessionInfo(view: unknown): SessionInfo {
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

export function createBrowserCoworkApi(bootstrap?: BrowserCoworkApiBootstrap): CoworkAPI {
  const resolvedBootstrap = bootstrap || readBootstrapFromWindow() || {}
  const transport = createTransport(resolvedBootstrap)
  const { request, endpoint, withQuery } = transport
  const hub = new CloudEventHub(transport)

  const channels: ChannelApiSurface = {
    providers: async (options) =>
      unwrap(await request(withQuery(endpoint('channelProviders'), { workspaceId: options?.workspaceId })), 'providers', []),
    agents: async (options) =>
      unwrap(await request(withQuery(endpoint('channelAgents'), { workspaceId: options?.workspaceId, limit: options?.limit ?? 100 })), 'agents', []),
    createAgent: async (input) => unwrap(await request(endpoint('channelAgentCreate'), { method: 'POST', body: input }), 'agent', null as never),
    updateAgent: async (agentId, input) =>
      unwrap(await request(endpoint('channelAgentUpdate', { agentId }), { method: 'PATCH', body: input }), 'agent', null),
    bindings: async (options) =>
      unwrap(await request(withQuery(endpoint('channelBindings'), { workspaceId: options?.workspaceId, agentId: options?.agentId, limit: options?.limit ?? 100 })), 'bindings', []),
    connectBinding: async (input) => unwrap(await request(endpoint('channelBindingCreate'), { method: 'POST', body: input }), 'binding', null as never),
    updateBinding: async (bindingId, input) =>
      unwrap(await request(endpoint('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: input }), 'binding', null),
    disconnectBinding: async (bindingId) =>
      unwrap(await request(endpoint('channelBindingUpdate', { bindingId }), { method: 'PATCH', body: { status: 'disabled' } }), 'binding', null),
    people: async (options) =>
      unwrap(await request(withQuery(endpoint('channelIdentities'), {
        workspaceId: options?.workspaceId,
        provider: options?.provider,
        externalWorkspaceId: options?.externalWorkspaceId,
        role: options?.role,
        status: options?.status,
        limit: options?.limit ?? 100,
      })), 'identities', []),
    resolvePerson: async (input) => unwrap(await request(endpoint('channelIdentityResolve'), { method: 'POST', body: input }), 'identity', null as never),
    deliveries: async (options) =>
      unwrap(await request(withQuery(endpoint('channelDeliveries'), {
        workspaceId: options?.workspaceId,
        deliveryId: options?.deliveryId,
        status: options?.status,
        channelBindingId: options?.channelBindingId,
        limit: options?.limit ?? 50,
      })), 'deliveries', []),
    retryDelivery: async (deliveryId) => unwrap(await request(endpoint('channelDeliveryRetry', { deliveryId }), { method: 'POST' }), 'delivery', null),
    deadLetterDelivery: async (deliveryId, input) =>
      unwrap(await request(endpoint('channelDeliveryDeadLetter', { deliveryId }), { method: 'POST', body: input || {} }), 'delivery', null),
    watches: (options) =>
      request<CoordinationWatch[]>(withQuery(endpoint('coordinationWatches'), {
        workspaceId: options?.workspaceId,
        targetKind: options?.targetKind,
        targetId: options?.targetId,
        status: options?.status,
        limit: options?.limit ?? 500,
      })),
    createWatch: (input) => request<CoordinationWatch>(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
    updateWatch: (watchId, input) => request<CoordinationWatch | null>(endpoint('coordinationWatch', { watchId }), { method: 'POST', body: input }),
    pauseWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchPause', { watchId }), { method: 'POST' }),
    resumeWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchResume', { watchId }), { method: 'POST' }),
    deleteWatch: async (watchId) =>
      Boolean(unwrap(await request(endpoint('coordinationWatchDelete', { watchId }), { method: 'DELETE' }), 'deleted', true)),
  }

  return {
    // -- workspace ---------------------------------------------------------
    workspace: {
      list: async () => {
        // The cloud serves a single signed-in workspace; the renderer expects
        // an array of WorkspaceInfo. Map the cloud /api/workspace record.
        const raw = await request<Record<string, unknown>>(endpoint('workspace'))
        const id = typeof raw?.workspaceId === 'string' ? raw.workspaceId : typeof raw?.id === 'string' ? raw.id : 'cloud'
        const info: WorkspaceInfo = {
          id,
          kind: 'cloud',
          authority: 'cloud_worker',
          label: typeof raw?.label === 'string' ? raw.label : typeof raw?.tenantName === 'string' ? raw.tenantName : 'Cloud',
          status: 'online',
          active: true,
          tenantId: typeof raw?.tenantId === 'string' ? raw.tenantId : undefined,
          profileName: typeof raw?.profileName === 'string' ? raw.profileName : undefined,
        }
        return [info]
      },
      activate: async (workspaceId) => {
        const list = await request<Record<string, unknown>>(endpoint('workspace'))
        return {
          id: workspaceId,
          kind: 'cloud',
          authority: 'cloud_worker',
          label: typeof list?.label === 'string' ? list.label : 'Cloud',
          status: 'online',
          active: true,
        }
      },
      addCloud: () => browserUnavailable('workspace.addCloud'),
      addGateway: () => browserUnavailable('workspace.addGateway'),
      remove: () => browserUnavailable('workspace.remove'),
      login: () => browserUnavailable('workspace.login'),
      logout: () => browserUnavailable('workspace.logout'),
      policy: async () => {
        const config = await request<{ features?: Record<string, boolean> }>(endpoint('config'))
        return {
          features: config?.features || {},
          allowedAgents: null,
          allowedTools: null,
          allowedMcps: null,
          localFiles: 'disabled',
          localStdioMcps: 'disabled',
          machineRuntimeConfig: 'disabled',
        }
      },
      support: async (): Promise<WorkspaceApiSupport[]> => {
        // The cloud control plane supports the data APIs; only the local-only
        // surfaces (local files / stdio MCPs / machine runtime config) are
        // unavailable in a hosted browser session.
        const localOnly = new Set<string>(['localFiles', 'localStdioMcps', 'machineRuntimeConfig'])
        return WORKSPACE_SUPPORT_APIS.map((api) => ({
          api,
          status: localOnly.has(api) ? 'not_supported' : 'supported',
        }))
      },
      sync: async () => ({ ok: true, syncedAt: new Date().toISOString() }),
    },

    // -- desktopPairing (Electron-only; no cloud equivalent) ---------------
    desktopPairing: {
      list: async (): Promise<DesktopPairingPublicRecord[]> => browserUnavailable('desktopPairing.list'),
      create: (): Promise<DesktopPairingCreated> => browserUnavailable('desktopPairing.create'),
      update: (): Promise<DesktopPairingPublicRecord> => browserUnavailable('desktopPairing.update'),
      connect: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.connect'),
      disconnect: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.disconnect'),
      revoke: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.revoke'),
      sync: (): Promise<DesktopPairingStatusSnapshot> => browserUnavailable('desktopPairing.sync'),
      audit: async (): Promise<DesktopPairingAuditEvent[]> => browserUnavailable('desktopPairing.audit'),
    },

    // -- auth --------------------------------------------------------------
    auth: {
      status: async (): Promise<AuthState> => {
        try {
          const me = await request<{ principal?: { email?: string | null } }>(endpoint('authMe'))
          const email = me?.principal?.email || null
          return { authenticated: Boolean(me?.principal), email }
        } catch {
          return { authenticated: false, email: null }
        }
      },
      login: async (): Promise<AuthState> => {
        // Browser auth is a full-page redirect to the cloud OIDC login.
        if (typeof window !== 'undefined') window.location.assign('/auth/login')
        return { authenticated: false, email: null }
      },
      logout: async (): Promise<AuthState> => {
        try {
          await request(endpoint('authLogout'), { method: 'POST', body: {} })
        } catch {
          // Best-effort; clear local state regardless.
        }
        for (const listener of hub.listeners.authLogout) listener()
        return { authenticated: false, email: null }
      },
    },

    // -- session -----------------------------------------------------------
    session: {
      create: async (_directory, options) => {
        const created = await request<unknown>(endpoint('sessions'), {
          method: 'POST',
          body: { profileName: null, projectSource: options?.projectSource ?? null },
        })
        const info = cloudViewToSessionInfo(created)
        if (info.id) hub.trackSession(info.id)
        return info
      },
      activate: async (sessionId): Promise<SessionView> => {
        hub.trackSession(sessionId)
        const envelope = await request<unknown>(endpoint('sessionView', { sessionId }))
        const view = unwrap<SessionView | undefined>(envelope, 'view', undefined)
        if (view) return view
        // Fall back to projecting the cloud view envelope locally.
        return cloudSessionViewToSessionView(envelope as Parameters<typeof cloudSessionViewToSessionView>[0])
      },
      prompt: async (sessionId, text, _attachments, agent) => {
        await request(endpoint('sessionPrompt', { sessionId }), { method: 'POST', body: { text, agent } })
      },
      setComposerPreferences: async () => null,
      list: async (): Promise<SessionInfo[]> => {
        const page = await request<{ sessions?: unknown[] }>(endpoint('sessions'))
        const sessions = Array.isArray(page?.sessions) ? page.sessions : []
        return sessions.map(cloudViewToSessionInfo)
      },
      get: async (id): Promise<SessionInfo | null> => {
        try {
          const view = await request<unknown>(endpoint('sessionView', { sessionId: id }))
          return cloudViewToSessionInfo(view)
        } catch {
          return null
        }
      },
      importInventory: () => browserUnavailable('session.importInventory'),
      copyToCloud: () => browserUnavailable('session.copyToCloud'),
      abort: async (sessionId) => {
        await request(endpoint('sessionAbort', { sessionId }), { method: 'POST', body: {} })
      },
      abortTask: () => browserUnavailable('session.abortTask'),
      rename: () => browserUnavailable('session.rename'),
      delete: () => browserUnavailable('session.delete'),
      export: async () => null,
      fork: async () => null,
      share: async () => null,
      unshare: () => browserUnavailable('session.unshare'),
      summarize: async () => ({ ok: false as const, message: 'Summaries are not available in the browser build.' }),
      revert: () => browserUnavailable('session.revert'),
      unrevert: () => browserUnavailable('session.unrevert'),
      children: async () => [],
      diff: async () => [],
      fileSnippet: async () => [],
      todo: async () => [],
    },

    // -- projectSource -----------------------------------------------------
    projectSource: {
      validate: (input) =>
        request<CloudProjectSourcePolicyVerdict>(endpoint('projectSourceValidate'), { method: 'POST', body: input }),
      snapshotInventory: (): Promise<CloudProjectSnapshotInventory> => browserUnavailable('projectSource.snapshotInventory'),
      uploadSnapshot: (): Promise<CloudProjectSnapshotUploadResult> => browserUnavailable('projectSource.uploadSnapshot'),
    },

    // -- coordination ------------------------------------------------------
    coordination: {
      board: (options) =>
        request<CoordinationBoardPayload>(withQuery(endpoint('coordinationBoard'), {
          workspaceId: options?.workspaceId,
          projectId: options?.projectId,
          limit: options?.limit,
        })),
      listProjects: (options) =>
        request<CoordinationProject[]>(withQuery(endpoint('coordinationProjects'), { workspaceId: options?.workspaceId, limit: 100 })),
      createProject: (input) => request<CoordinationProject>(endpoint('coordinationProjectCreate'), { method: 'POST', body: input }),
      updateProject: (projectId, input) =>
        request<CoordinationProject | null>(endpoint('coordinationProject', { projectId }), { method: 'POST', body: input }),
      planWithCleo: (projectId, input) =>
        request(endpoint('coordinationPlanWithCleo', { projectId }), { method: 'POST', body: input || {} }),
      listTasks: (options) =>
        request<CoordinationTask[]>(withQuery(endpoint('coordinationTasks'), {
          workspaceId: options?.workspaceId,
          projectId: options?.projectId,
          limit: options?.limit ?? 500,
        })),
      createTask: (input) => request<CoordinationTask>(endpoint('coordinationTaskCreate'), { method: 'POST', body: input }),
      updateTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTask', { taskId }), { method: 'POST', body: input }),
      moveTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskMove', { taskId }), { method: 'POST', body: input }),
      assignTask: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskAssign', { taskId }), { method: 'POST', body: input }),
      linkTaskWork: (taskId, input) => request<CoordinationTask | null>(endpoint('coordinationTaskLinkWork', { taskId }), { method: 'POST', body: input }),
      taskWorkTarget: (taskId, options) =>
        request<SessionInfo | null>(withQuery(endpoint('coordinationTaskWorkTarget', { taskId }), { workspaceId: options?.workspaceId })),
      listWatches: (options) =>
        request<CoordinationWatch[]>(withQuery(endpoint('coordinationWatches'), {
          workspaceId: options?.workspaceId,
          targetKind: options?.targetKind,
          targetId: options?.targetId,
          status: options?.status,
          limit: options?.limit ?? 500,
        })),
      createWatch: (input) => request<CoordinationWatch>(endpoint('coordinationWatchCreate'), { method: 'POST', body: input }),
      updateWatch: (watchId, input) => request<CoordinationWatch | null>(endpoint('coordinationWatch', { watchId }), { method: 'POST', body: input }),
      pauseWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchPause', { watchId }), { method: 'POST' }),
      resumeWatch: (watchId) => request<CoordinationWatch | null>(endpoint('coordinationWatchResume', { watchId }), { method: 'POST' }),
      deleteWatch: async (watchId) =>
        Boolean(unwrap(await request(endpoint('coordinationWatchDelete', { watchId }), { method: 'DELETE' }), 'deleted', true)),
    },

    // -- channels ----------------------------------------------------------
    channels,

    // -- launchpad ---------------------------------------------------------
    launchpad: {
      feed: (req) =>
        request<LaunchpadFeedPayload>(withQuery(endpoint('launchpadFeed'), { workspaceId: req?.workspaceId })),
    },

    // -- knowledge ---------------------------------------------------------
    knowledge: {
      snapshot: (options) =>
        request<KnowledgeSnapshotPayload>(withQuery(endpoint('knowledgeSnapshot'), {
          workspaceId: options?.workspaceId,
          spaceId: options?.spaceId,
          limit: options?.limit,
        })),
      createSpace: (input) => request<KnowledgeSpace>(endpoint('knowledgeSpaceCreate'), { method: 'POST', body: input }),
      propose: (input) => request<KnowledgeProposal>(endpoint('knowledgeProposalCreate'), { method: 'POST', body: input }),
      acceptProposal: (proposalId, input) =>
        request<{ proposal: KnowledgeProposal; page: KnowledgePageVersion }>(endpoint('knowledgeProposalAccept', { proposalId }), { method: 'POST', body: input || {} }),
      declineProposal: (proposalId, input) =>
        request<KnowledgeProposal>(endpoint('knowledgeProposalDecline', { proposalId }), { method: 'POST', body: input || {} }),
      history: (pageId, options) =>
        request<KnowledgePageVersion[]>(withQuery(endpoint('knowledgePageHistory', { pageId }), {
          workspaceId: options?.workspaceId,
          spaceId: options?.spaceId,
          limit: options?.limit,
        })),
      restoreVersion: (pageId, versionId, input) =>
        request<{ page: KnowledgePageVersion }>(endpoint('knowledgePageRestore', { pageId }), { method: 'POST', body: { ...(input || {}), versionId } }),
    },

    // -- permission --------------------------------------------------------
    permission: {
      respond: async (id, allowed, sessionId) => {
        if (!sessionId) return
        await request(endpoint('sessionPermissionRespond', { sessionId }), {
          method: 'POST',
          body: { permissionId: id, response: { allowed } },
        })
      },
    },

    // -- question ----------------------------------------------------------
    question: {
      reply: async (sessionId, requestId, answers) => {
        await request(endpoint('sessionQuestionReply', { sessionId }), { method: 'POST', body: { requestId, answers } })
      },
      reject: async (sessionId, requestId) => {
        await request(endpoint('sessionQuestionReject', { sessionId }), { method: 'POST', body: { requestId } })
      },
    },

    // -- settings ----------------------------------------------------------
    settings: {
      get: async (): Promise<EffectiveAppSettings> => {
        const raw = await request<Partial<EffectiveAppSettings>>(endpoint('settings'))
        return (raw || {}) as EffectiveAppSettings
      },
      getProviderCredentials: async () => ({}),
      getIntegrationCredentials: async () => ({}),
      set: async (updates): Promise<EffectiveAppSettings> => {
        const raw = await request<Partial<EffectiveAppSettings>>(endpoint('settings'), { method: 'PUT', body: updates })
        return (raw || {}) as EffectiveAppSettings
      },
    },

    // -- mcp (read/connect; cloud has no per-MCP control surface) ----------
    mcp: {
      auth: async () => browserUnavailable('mcp.auth'),
      connect: async () => browserUnavailable('mcp.connect'),
      disconnect: async () => browserUnavailable('mcp.disconnect'),
      preflight: () => browserUnavailable('mcp.preflight'),
    },

    // -- dialog (Electron-only native pickers) -----------------------------
    dialog: {
      selectDirectory: async () => null,
      selectImage: async () => null,
      openJson: async () => null,
      saveText: async () => null,
    },

    // -- chart -------------------------------------------------------------
    chart: {
      renderSvg: () => browserUnavailable('chart.renderSvg'),
      saveArtifact: (): Promise<SessionArtifact> => browserUnavailable('chart.saveArtifact'),
    },

    // -- artifact ----------------------------------------------------------
    artifact: {
      list: async (req): Promise<SessionArtifact[]> =>
        unwrap(await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { limit: 100 })), 'artifacts', []),
      index: (req) =>
        request<ArtifactIndexPayload>(withQuery(endpoint('artifactsIndex'), { workspaceId: req?.workspaceId })),
      updateStatus: async (req): Promise<SessionArtifact> =>
        unwrap(
          await request(endpoint('sessionArtifactStatus', { sessionId: req.sessionId, artifactId: req.artifactId }), { method: 'POST', body: req }),
          'artifact',
          null as never,
        ),
      upload: async (req): Promise<SessionArtifact> => {
        // Buffered upload: base64 the whole artifact through the cloud API. This is the
        // default-safe path and the unchanged behaviour the renderer has always seen.
        const bufferedUpload = async (): Promise<SessionArtifact> =>
          unwrap(await request(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { method: 'POST', body: req }), 'artifact', null as never)

        // Cloud/browser optimization: when the server advertises presigned upload support, push
        // the bytes straight to object storage (begin -> direct PUT -> finalize) so they never
        // base64-buffer through the web pod. The buffered path remains the fallback whenever the
        // server says "unsupported" (non-S3 / no static creds), the begin call errors (e.g. an
        // older server), or the direct PUT fails. (Electron implements `upload` over IPC and
        // never reaches this code; the public method signature + return shape are unchanged.)
        let begun: PresignedUploadBegin | null
        try {
          begun = unwrap<PresignedUploadBegin | null>(
            await request(withQuery(endpoint('sessionArtifacts', { sessionId: req.sessionId }), { transfer: 'presigned' }), {
              method: 'POST',
              body: { filename: req.filename, contentType: req.contentType ?? null },
            }),
            'upload',
            null,
          )
        } catch {
          return bufferedUpload()
        }
        if (!begun || begun.transfer !== 'presigned' || !begun.uploadUrl || !begun.artifactId) {
          return bufferedUpload()
        }

        let putOk: boolean
        try {
          const putResponse = await fetch(begun.uploadUrl, {
            method: begun.uploadMethod || 'PUT',
            headers: begun.uploadHeaders || {},
            // Uint8Array is a valid runtime BodyInit; the cast bridges the typed-array generics
            // friction in the DOM lib's BufferSource definition.
            body: base64ToBytes(req.dataBase64) as unknown as BodyInit,
          })
          putOk = putResponse.ok
        } catch {
          putOk = false
        }
        if (!putOk) return bufferedUpload()

        // The bytes are in the store; record the metadata row. Finalize errors propagate (a
        // buffered retry here would re-upload the bytes under a second artifact id).
        return unwrap(
          await request(endpoint('sessionArtifactFinalize', { sessionId: req.sessionId, artifactId: begun.artifactId }), {
            method: 'POST',
            body: {
              filename: req.filename,
              contentType: req.contentType ?? null,
              kind: req.kind ?? null,
              status: req.status ?? null,
              authorAgentId: req.authorAgentId ?? null,
              projectId: req.projectId ?? null,
              taskId: req.taskId ?? null,
              statusUpdatedBy: req.statusUpdatedBy ?? null,
              statusUpdatedAt: req.statusUpdatedAt ?? null,
            },
          }),
          'artifact',
          null as never,
        )
      },
      open: async () => null,
      export: async () => null,
      reveal: async () => false,
      readAttachment: async (req): Promise<SessionArtifactAttachment> => {
        // The renderer addresses cloud artifacts by their synthetic file path
        // (see cloudArtifactFilePath); recover the artifactId and resolve the
        // cloud artifact body, then shape it as a SessionArtifactAttachment.
        const artifactId = cloudArtifactIdFromFilePath(req.filePath) || req.filePath
        const envelope = await request<{ artifact?: Record<string, unknown> }>(
          endpoint('sessionArtifact', { sessionId: req.sessionId, artifactId }),
        )
        const artifact = (envelope?.artifact || {}) as Record<string, unknown>
        const mime = typeof artifact.contentType === 'string' && artifact.contentType ? artifact.contentType : 'application/octet-stream'
        const dataBase64 = typeof artifact.dataBase64 === 'string' ? artifact.dataBase64 : ''
        const filename = typeof artifact.filename === 'string' ? artifact.filename : 'artifact'
        return {
          mime,
          url: dataBase64 ? `data:${mime};base64,${dataBase64}` : '',
          filename,
          chart: null,
        }
      },
      storageStats: () => browserUnavailable('artifact.storageStats'),
      cleanup: () => browserUnavailable('artifact.cleanup'),
    },

    // -- confirm (no native dialog; grant a short-lived local token) -------
    confirm: {
      requestDestructive: async (): Promise<DestructiveConfirmationGrant | null> => null,
    },

    // -- clipboard (browser primitive) ------------------------------------
    clipboard: {
      writeText: async (text) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) {
            await navigator.clipboard.writeText(text)
            return true
          }
        } catch {
          // Fall through to failure.
        }
        return false
      },
    },

    // -- model (no cloud route; empty pricing snapshot) --------------------
    model: {
      info: async (): Promise<ModelInfoSnapshot> => ({ pricing: {}, contextLimits: {} }),
    },

    // -- tools (no cloud route) -------------------------------------------
    tools: {
      list: async () => [],
    },

    // -- command (no cloud route) -----------------------------------------
    command: {
      list: async () => [],
      run: () => browserUnavailable('command.run'),
    },

    // -- provider (read via config; authorize/callback are local OAuth) ----
    provider: {
      list: async () => {
        const config = await request<{ providers?: { available?: unknown[] } }>(endpoint('config'))
        const available = Array.isArray(config?.providers?.available) ? config.providers.available : []
        return available.map((entry) => {
          const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
          return {
            id: typeof record.id === 'string' ? record.id : undefined,
            name: typeof record.name === 'string' ? record.name : undefined,
            connected: typeof record.connected === 'boolean' ? record.connected : undefined,
          }
        })
      },
      authMethods: async (): Promise<Record<string, ProviderAuthMethod[]>> => ({}),
      testConnection: async (providerId, modelId) => ({ ok: false, providerId, modelId }),
      authorize: () => browserUnavailable('provider.authorize'),
      callback: () => browserUnavailable('provider.callback'),
      logout: () => browserUnavailable('provider.logout'),
    },

    // -- runtime (status from cloud; restart/await are Electron-only) ------
    runtime: {
      status: async (): Promise<RuntimeStatus> => {
        try {
          const raw = await request<Partial<RuntimeStatus>>(endpoint('runtimeStatus'))
          return { ready: Boolean(raw?.ready), error: raw?.error ?? null, ...raw }
        } catch {
          return { ready: true, error: null }
        }
      },
      awaitInitialization: async (): Promise<RuntimeLoadingStatus> => ({
        phase: 'ready',
        message: '',
        ready: true,
        error: null,
        updatedAt: new Date().toISOString(),
      }),
      restart: () => browserUnavailable('runtime.restart'),
    },

    // -- projects (no cloud route; recent-project navigation is local) -----
    projects: {
      list: async () => [],
      switchByIndex: async () => null,
    },

    // -- diagnostics -------------------------------------------------------
    diagnostics: {
      perf: () => browserUnavailable('diagnostics.perf'),
      reportRendererError: () => {
        // Fire-and-forget; the browser build relies on platform error reporting.
      },
    },

    // -- app ---------------------------------------------------------------
    app: {
      metadata: async (): Promise<AppMetadata> => ({ version: '0.0.0', preview: false }),
      // The cloud /api/config returns a different shape than the renderer's
      // PublicAppConfig; default every required field (the renderer hard-reads
      // config.auth.enabled) and let the cloud response override what it provides.
      config: async (): Promise<PublicAppConfig> => {
        const raw = await request<Record<string, unknown>>(endpoint('config')).catch(() => ({} as Record<string, unknown>))
        const merged: Record<string, unknown> = {
          branding: { name: 'Open Cowork' },
          providers: { available: [], defaultProvider: null, defaultModel: null },
          permissions: { bash: 'ask', fileWrite: 'ask', task: 'ask', web: 'ask', webSearch: false },
          agentStarterTemplates: [],
          ...raw,
          auth: (raw.auth as PublicAppConfig['auth'] | undefined) ?? { mode: 'none', enabled: false },
        }
        return merged as unknown as PublicAppConfig
      },
      builtinAgents: async () => [],
      runtimeInputs: () => browserUnavailable('app.runtimeInputs'),
      refreshProviderCatalog: async () => [],
      exportDiagnostics: async () => {
        try {
          return JSON.stringify(await request(endpoint('diagnostics')))
        } catch {
          return null
        }
      },
      checkUpdates: async () => ({ status: 'disabled', currentVersion: '0.0.0', message: 'Updates are managed by the browser deployment.' }),
      reset: () => browserUnavailable('app.reset'),
    },

    // -- updates (Electron-only auto-updater) ------------------------------
    updates: {
      installCapability: async () => ({
        supported: false,
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
        releaseSource: null,
      }),
      checkInstallable: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      download: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      quitAndInstall: async (): Promise<UpdateInstallStatus> => ({
        status: 'unsupported',
        reason: 'platform',
        currentVersion: '0.0.0',
        manualReleaseUrl: null,
      }),
      onInstallEvent: () => () => {},
    },

    // -- workflows ---------------------------------------------------------
    workflows: {
      list: () => request<WorkflowListPayload>(endpoint('workflows')),
      get: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflow', { workflowId })), 'workflow', null),
      startDraft: () => browserUnavailable('workflows.startDraft'),
      runNow: async (workflowId): Promise<WorkflowRun | null> =>
        unwrap(await request(endpoint('workflowRun', { workflowId }), { method: 'POST', body: {} }), 'run', null),
      pause: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowPause', { workflowId }), { method: 'POST' }), 'workflow', null),
      resume: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowResume', { workflowId }), { method: 'POST' }), 'workflow', null),
      archive: async (workflowId): Promise<WorkflowDetail | null> =>
        unwrap(await request(endpoint('workflowArchive', { workflowId }), { method: 'POST' }), 'workflow', null),
      regenerateWebhookSecret: () => browserUnavailable('workflows.regenerateWebhookSecret'),
    },

    // -- threads -----------------------------------------------------------
    threads: {
      search: (query) =>
        request<ThreadSearchResult>(endpoint('threadsSearch'), { method: 'POST', body: query || {} }),
      facets: (query) =>
        request<ThreadFacetSummary>(endpoint('threadsFacets'), { method: 'POST', body: query || {} }),
      tags: {
        list: async () => [],
        create: () => browserUnavailable('threads.tags.create'),
        update: () => browserUnavailable('threads.tags.update'),
        delete: () => browserUnavailable('threads.tags.delete'),
        apply: () => browserUnavailable('threads.tags.apply'),
        remove: () => browserUnavailable('threads.tags.remove'),
      },
      smartFilters: {
        list: async () => [],
        create: () => browserUnavailable('threads.smartFilters.create'),
        update: () => browserUnavailable('threads.smartFilters.update'),
        delete: () => browserUnavailable('threads.smartFilters.delete'),
      },
      suggestions: {
        accept: () => browserUnavailable('threads.suggestions.accept'),
        edit: () => browserUnavailable('threads.suggestions.edit'),
        dismiss: () => browserUnavailable('threads.suggestions.dismiss'),
      },
      reindex: async () => false,
    },

    // -- agents (read via capabilities catalog; mutations Electron-only) ---
    agents: {
      catalog: async (): Promise<AgentCatalog> => {
        const catalog = await request<Partial<AgentCatalog>>(endpoint('capabilitiesCatalog'))
        return {
          tools: Array.isArray(catalog?.tools) ? catalog.tools : [],
          skills: Array.isArray(catalog?.skills) ? catalog.skills : [],
          reservedNames: Array.isArray(catalog?.reservedNames) ? catalog.reservedNames : [],
          colors: Array.isArray(catalog?.colors) ? catalog.colors : [],
        }
      },
      list: async () => [],
      runtime: async () => [],
      create: () => browserUnavailable('agents.create'),
      update: () => browserUnavailable('agents.update'),
      remove: () => browserUnavailable('agents.remove'),
    },

    // -- capabilities ------------------------------------------------------
    capabilities: {
      tools: async (options) =>
        unwrap(await request(withQuery(endpoint('capabilityTools'), { workspaceId: options?.workspaceId })), 'tools', []),
      tool: async (id, options) =>
        unwrap(await request(withQuery(endpoint('capabilityTool', { toolId: id }), { workspaceId: options?.workspaceId })), 'tool', null),
      skills: async (options) =>
        unwrap(await request(withQuery(endpoint('capabilitySkills'), { workspaceId: options?.workspaceId })), 'skills', []),
      skillBundle: async (skillName, options) =>
        unwrap(await request(withQuery(endpoint('capabilitySkillBundle', { skillName }), { workspaceId: options?.workspaceId })), 'bundle', null),
      skillBundleFile: async () => null,
    },

    // -- explorer (local filesystem; not available in the browser) ---------
    explorer: {
      fileList: async () => [],
      fileRead: async () => null,
      fileStatus: async () => [],
      findFiles: async () => [],
      findSymbols: async () => [],
      findText: async () => [],
    },

    // -- custom (local FS imports + custom content mutations) --------------
    custom: {
      listMcps: async () => [],
      addMcp: () => browserUnavailable('custom.addMcp'),
      removeMcp: () => browserUnavailable('custom.removeMcp'),
      testMcp: () => browserUnavailable('custom.testMcp'),
      listSkills: async () => [],
      addSkill: () => browserUnavailable('custom.addSkill'),
      selectSkillDirectoryImport: async () => null,
      importSkillDirectory: async () => null,
      removeSkill: () => browserUnavailable('custom.removeSkill'),
    },

    // -- on.* (SSE demux) --------------------------------------------------
    on: {
      sessionPatch: (callback) => hub.subscribe('sessionPatch', callback),
      notification: (callback) => hub.subscribe('notification', callback),
      sessionView: (callback) => hub.subscribe('sessionView', callback),
      permissionRequest: (callback) => hub.subscribe('permissionRequest', callback),
      mcpStatus: (callback) => hub.subscribe('mcpStatus', callback),
      authExpired: (callback) => hub.subscribe('authExpired', callback),
      authLogout: (callback) => hub.subscribe('authLogout', callback),
      menuAction: (callback) => hub.subscribe('menuAction', callback),
      menuNavigate: (callback) => hub.subscribe('menuNavigate', callback),
      runtimeReady: (callback) => hub.subscribe('runtimeReady', callback),
      runtimeLoadingStatus: (callback) => hub.subscribe('runtimeLoadingStatus', callback),
      sessionUpdated: (callback) => hub.subscribe('sessionUpdated', callback),
      sessionDeleted: (callback) => hub.subscribe('sessionDeleted', callback),
      workspaceSessionsUpdated: (callback) => hub.subscribe('workspaceSessionsUpdated', callback),
      workflowUpdated: (callback) => hub.subscribe('workflowUpdated', callback),
      coordinationUpdated: (callback) => hub.subscribe('coordinationUpdated', callback),
      knowledgeUpdated: (callback) => hub.subscribe('knowledgeUpdated', callback),
    },
  }
}
