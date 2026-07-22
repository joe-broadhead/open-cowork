/**
 * Shared workspace session port (audit 2026-07-21 P2-8 / JOE-921).
 *
 * Local Durable session engines, Desktop pairing executors, and cloud workspace
 * adapters all own session/workflow surfaces. Product code should depend on this
 * port for the common surface so fixes land once at the interface and each
 * adapter only translates transport.
 *
 * Core session methods are required. Interaction, workflow, import, artifact, and
 * sync methods are optional so limited transports (gateway status-only, partial
 * mocks) can still satisfy `mode: 'core'`; `CloudWorkspaceAdapter` implements the
 * full surface (`mode: 'full'`).
 *
 * Inventory: `docs/evidence/workspace-session-port-inventory-2026-07-21.md`.
 */
import {
  emptySessionImportItemCounts,
  emptySessionView,
  type MessageAttachment,
  type SessionArtifact,
  type SessionArtifactAttachment,
  type SessionArtifactUploadRequest,
  type SessionImportRequest,
  type SessionInfo,
  type SessionView,
  type WorkflowDetail,
  type WorkflowListPayload,
  type WorkflowRun,
  type WorkspacePolicy,
} from '@open-cowork/shared'

/** Prompt payload shared by cloud and gateway workspace session ports. */
export type WorkspaceSessionPromptInput = {
  text: string
  agent?: string | null
  model?: string
  variant?: string
  attachments?: MessageAttachment[]
  [key: string]: unknown
}

export type WorkspaceSessionImportResult = {
  session: SessionInfo
  view: SessionView
}

/**
 * Minimal session surface shared by cloud and local workspace paths.
 * Adapters may expose additional product-specific methods beyond this port.
 */
export interface WorkspaceSessionPort {
  policy(): Promise<WorkspacePolicy>
  listSessions(): Promise<SessionInfo[]>
  createSession(input?: { projectSource?: unknown }): Promise<SessionInfo>
  getSessionInfo(sessionId: string): Promise<SessionInfo | null>
  getSessionView(sessionId: string): Promise<SessionView>
  promptSession(sessionId: string, input: WorkspaceSessionPromptInput): Promise<void>
  abortSession(sessionId: string): Promise<void>
  /** Optional — cloud adapters implement; limited mocks may omit. */
  replyToQuestion?(sessionId: string, requestId: string, answers: unknown[]): Promise<void>
  rejectQuestion?(sessionId: string, requestId: string): Promise<void>
  respondToPermission?(sessionId: string, permissionId: string, allowed: boolean): Promise<void>
  listWorkflows?(): Promise<WorkflowListPayload>
  getWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  runWorkflow?(workflowId: string): Promise<WorkflowRun | null>
  pauseWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  resumeWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  archiveWorkflow?(workflowId: string): Promise<WorkflowDetail | null>
  /** Dual-path ops promoted onto the port (JOE-967). */
  importSession?(input: SessionImportRequest): Promise<WorkspaceSessionImportResult>
  listArtifacts?(sessionId: string): Promise<SessionArtifact[]>
  uploadArtifact?(input: SessionArtifactUploadRequest): Promise<SessionArtifact>
  readArtifactAttachment?(sessionId: string, filePathOrArtifactId: string): Promise<SessionArtifactAttachment>
  sync?(): Promise<void>
}

/** Core methods every WorkspaceSessionPort implementation must provide. */
export const WORKSPACE_SESSION_PORT_CORE_METHODS = [
  'policy',
  'listSessions',
  'createSession',
  'getSessionInfo',
  'getSessionView',
  'promptSession',
  'abortSession',
] as const

/** Interaction + workflow methods shared by full cloud adapters. */
export const WORKSPACE_SESSION_PORT_INTERACTION_METHODS = [
  'replyToQuestion',
  'rejectQuestion',
  'respondToPermission',
  'listWorkflows',
  'getWorkflow',
  'runWorkflow',
  'pauseWorkflow',
  'resumeWorkflow',
  'archiveWorkflow',
] as const

/** Dual-path extensions (import, artifacts, sync) promoted in JOE-967. */
export const WORKSPACE_SESSION_PORT_EXTENDED_METHODS = [
  'importSession',
  'listArtifacts',
  'uploadArtifact',
  'readArtifactAttachment',
  'sync',
] as const

/** Full method set implemented by CloudWorkspaceAdapter. */
export const WORKSPACE_SESSION_PORT_FULL_METHODS = [
  ...WORKSPACE_SESSION_PORT_CORE_METHODS,
  ...WORKSPACE_SESSION_PORT_INTERACTION_METHODS,
  ...WORKSPACE_SESSION_PORT_EXTENDED_METHODS,
] as const

export type WorkspaceSessionPortMethod =
  | (typeof WORKSPACE_SESSION_PORT_CORE_METHODS)[number]
  | (typeof WORKSPACE_SESSION_PORT_INTERACTION_METHODS)[number]
  | (typeof WORKSPACE_SESSION_PORT_EXTENDED_METHODS)[number]

/**
 * Type guard for the shared port. Checks core session methods by default.
 * Pass `mode: 'full'` to require the complete CloudWorkspaceAdapter surface
 * (session + interaction + workflow + import/artifacts/sync).
 */
export function assertWorkspaceSessionPort(
  value: unknown,
  options: { mode?: 'core' | 'full' } = {},
): asserts value is WorkspaceSessionPort {
  if (!value || typeof value !== 'object') {
    throw new Error('WorkspaceSessionPort required')
  }
  const port = value as WorkspaceSessionPort
  const methods = options.mode === 'full'
    ? WORKSPACE_SESSION_PORT_FULL_METHODS
    : WORKSPACE_SESSION_PORT_CORE_METHODS
  for (const method of methods) {
    if (typeof (port as unknown as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`WorkspaceSessionPort missing method: ${method}`)
    }
  }
}

/** Empty policy used by local/memory fixtures when no managed policy applies. */
export const WORKSPACE_SESSION_PORT_LOCAL_POLICY: WorkspacePolicy = {
  features: {},
  allowedAgents: null,
  allowedTools: null,
  allowedMcps: null,
  localFiles: 'enabled',
  localStdioMcps: 'enabled',
  machineRuntimeConfig: 'allowlisted',
}

/**
 * In-memory WorkspaceSessionPort for contract/parity tests and local-path
 * scaffolding. Implements the full method set so local and cloud fixtures share
 * one contract runner without partial-mock theater.
 */
export function createMemoryWorkspaceSessionPort(
  options: {
    policy?: WorkspacePolicy
    initialSessions?: SessionInfo[]
  } = {},
): WorkspaceSessionPort {
  const policy = options.policy ?? WORKSPACE_SESSION_PORT_LOCAL_POLICY
  const sessions = new Map<string, SessionInfo>()
  const views = new Map<string, SessionView>()
  const artifacts = new Map<string, SessionArtifact[]>()
  let seq = 0

  for (const session of options.initialSessions ?? []) {
    sessions.set(session.id, session)
    views.set(session.id, emptySessionView())
  }

  function requireSession(sessionId: string): SessionInfo {
    const session = sessions.get(sessionId)
    if (!session) throw new Error(`Unknown session: ${sessionId}`)
    return session
  }

  const port: WorkspaceSessionPort = {
    async policy() {
      return policy
    },
    async listSessions() {
      return [...sessions.values()]
    },
    async createSession() {
      seq += 1
      const id = `mem-session-${seq}`
      const now = new Date().toISOString()
      const session: SessionInfo = {
        id,
        title: `Memory ${seq}`,
        createdAt: now,
        updatedAt: now,
      }
      sessions.set(id, session)
      views.set(id, emptySessionView())
      return session
    },
    async getSessionInfo(sessionId) {
      return sessions.get(sessionId) ?? null
    },
    async getSessionView(sessionId) {
      requireSession(sessionId)
      return views.get(sessionId) ?? emptySessionView()
    },
    async promptSession(sessionId) {
      requireSession(sessionId)
      const view = views.get(sessionId) ?? emptySessionView()
      views.set(sessionId, {
        ...view,
        revision: view.revision + 1,
        lastEventAt: Date.now(),
      })
    },
    async abortSession(sessionId) {
      requireSession(sessionId)
    },
    async replyToQuestion(sessionId) {
      requireSession(sessionId)
    },
    async rejectQuestion(sessionId) {
      requireSession(sessionId)
    },
    async respondToPermission(sessionId) {
      requireSession(sessionId)
    },
    async listWorkflows() {
      return { workflows: [], runs: [], nextCursor: null }
    },
    async getWorkflow() {
      return null
    },
    async runWorkflow() {
      return null
    },
    async pauseWorkflow() {
      return null
    },
    async resumeWorkflow() {
      return null
    },
    async archiveWorkflow() {
      return null
    },
    async importSession(input) {
      seq += 1
      const id = `mem-import-${seq}`
      const now = new Date().toISOString()
      const session: SessionInfo = {
        id,
        title: input.title || `Imported ${seq}`,
        createdAt: now,
        updatedAt: now,
      }
      const view = emptySessionView()
      sessions.set(id, session)
      views.set(id, view)
      return { session, view }
    },
    async listArtifacts(sessionId) {
      requireSession(sessionId)
      return artifacts.get(sessionId) ?? []
    },
    async uploadArtifact(input) {
      requireSession(input.sessionId)
      const artifact: SessionArtifact = {
        id: `mem-art-${++seq}`,
        toolId: 'memory-upload',
        toolName: 'memory-upload',
        filePath: input.filename,
        filename: input.filename,
        order: (artifacts.get(input.sessionId)?.length ?? 0) + 1,
        source: 'local',
        kind: input.kind ?? undefined,
        status: input.status === 'draft' || input.status === 'in-review' || input.status === 'final'
          ? input.status
          : 'draft',
        createdAt: new Date().toISOString(),
      }
      const list = artifacts.get(input.sessionId) ?? []
      list.push(artifact)
      artifacts.set(input.sessionId, list)
      return artifact
    },
    async readArtifactAttachment(sessionId, filePathOrArtifactId) {
      requireSession(sessionId)
      return {
        mime: 'text/plain',
        url: `data:text/plain;base64,${Buffer.from('memory-artifact').toString('base64')}`,
        filename: filePathOrArtifactId,
        chart: null,
      } satisfies SessionArtifactAttachment
    },
    async sync() {
      // no-op for memory fixture
    },
  }

  assertWorkspaceSessionPort(port, { mode: 'full' })
  return port
}

/**
 * Drive every full-port method once. Used by parity tests for cloud + memory
 * adapters so missing methods fail closed (not spy theater).
 */
export async function exerciseWorkspaceSessionPort(port: WorkspaceSessionPort): Promise<{
  sessionId: string
  methodCount: number
}> {
  assertWorkspaceSessionPort(port, { mode: 'full' })
  await port.policy()
  const created = await port.createSession()
  const sessions = await port.listSessions()
  if (!sessions.some((entry) => entry.id === created.id)) {
    throw new Error('listSessions did not include createSession result')
  }
  const info = await port.getSessionInfo(created.id)
  if (!info || info.id !== created.id) {
    throw new Error('getSessionInfo missed created session')
  }
  await port.getSessionView(created.id)
  await port.promptSession(created.id, { text: 'contract-prompt' })
  await port.abortSession(created.id)
  await port.replyToQuestion!(created.id, 'q1', ['a'])
  await port.rejectQuestion!(created.id, 'q1')
  await port.respondToPermission!(created.id, 'p1', false)
  await port.listWorkflows!()
  await port.getWorkflow!('wf-1')
  await port.runWorkflow!('wf-1')
  await port.pauseWorkflow!('wf-1')
  await port.resumeWorkflow!('wf-1')
  await port.archiveWorkflow!('wf-1')
  const imported = await port.importSession!({
    source: { kind: 'local-session', fingerprint: 'contract-fp', title: 'Imported contract' },
    title: 'Imported contract',
    selection: { includeMessages: true },
    itemCounts: emptySessionImportItemCounts({ messages: 1 }),
  })
  await port.listArtifacts!(imported.session.id)
  await port.uploadArtifact!({
    sessionId: imported.session.id,
    filename: 'contract.txt',
    dataBase64: Buffer.from('hello').toString('base64'),
  })
  await port.readArtifactAttachment!(imported.session.id, 'contract.txt')
  await port.sync!()
  return {
    sessionId: created.id,
    methodCount: WORKSPACE_SESSION_PORT_FULL_METHODS.length,
  }
}

/**
 * Progressive local WorkspaceSessionPort (post-#959 JOE-921 residual).
 * Wraps an engine-like object already used by desktop IPC so call sites can
 * migrate off raw sessionEngine without inventing a second implementation.
 * Full IPC cutover remains progressive; this port is the contract boundary.
 */
export function createLocalWorkspaceSessionPort(engine: {
  policy?: () => Promise<WorkspacePolicy> | WorkspacePolicy
  createSession?: (input?: { projectSource?: unknown }) => Promise<SessionInfo> | SessionInfo
  listSessions?: () => Promise<SessionInfo[]> | SessionInfo[]
  getSessionInfo?: (sessionId: string) => Promise<SessionInfo | null> | SessionInfo | null
  getSessionView?: (sessionId: string) => Promise<SessionView> | SessionView
  promptSession?: (sessionId: string, input: WorkspaceSessionPromptInput) => Promise<void> | void
  abortSession?: (sessionId: string) => Promise<void> | void
}): WorkspaceSessionPort {
  const call = async <T>(name: string, fn: (() => Promise<T> | T) | undefined, fallback?: () => Promise<T>): Promise<T> => {
    if (typeof fn === 'function') return await fn()
    if (fallback) return await fallback()
    throw new Error(`Local WorkspaceSessionPort method not available: ${name}`)
  }
  return {
    async policy() {
      return await call('policy', engine.policy ? () => engine.policy!() : undefined, async (): Promise<WorkspacePolicy> => ({
        features: {},
        allowedAgents: null,
        allowedTools: null,
        allowedMcps: null,
        localFiles: 'enabled',
        localStdioMcps: 'enabled',
        machineRuntimeConfig: 'allowlisted',
      }))
    },
    async createSession(input) {
      return await call('createSession', engine.createSession ? () => engine.createSession!(input) : undefined)
    },
    async listSessions() {
      return await call('listSessions', engine.listSessions ? () => engine.listSessions!() : undefined, async () => [])
    },
    async getSessionInfo(sessionId) {
      return await call('getSessionInfo', engine.getSessionInfo ? () => engine.getSessionInfo!(sessionId) : undefined, async () => null)
    },
    async getSessionView(sessionId) {
      return await call('getSessionView', engine.getSessionView ? () => engine.getSessionView!(sessionId) : undefined)
    },
    async promptSession(sessionId, input) {
      return await call('promptSession', engine.promptSession ? () => engine.promptSession!(sessionId, input) : undefined, async () => undefined)
    },
    async abortSession(sessionId) {
      return await call('abortSession', engine.abortSession ? () => engine.abortSession!(sessionId) : undefined, async () => undefined)
    },
  }
}
