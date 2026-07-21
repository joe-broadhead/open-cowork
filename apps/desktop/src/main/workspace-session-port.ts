/**
 * Shared workspace session port (audit 2026-07-21 P2-8).
 *
 * Local Durable Gateway bridges (`workspace-gateway.ts`) and cloud workspace
 * adapters (`cloud-workspace-adapter.ts`) both implement session/workflow
 * operations. Product code should depend on this port for the common surface
 * so fixes land once at the interface and each adapter only translates
 * transport.
 *
 * Core session methods are required. Interaction (question/permission) and
 * workflow methods are optional so partial mocks and limited transports can
 * still satisfy the port; full `CloudWorkspaceAdapter` implements all of them.
 */
import type {
  MessageAttachment,
  SessionInfo,
  SessionView,
  WorkflowDetail,
  WorkflowListPayload,
  WorkflowRun,
  WorkspacePolicy,
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

/**
 * Minimal session surface shared by cloud and gateway workspace paths.
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

/** Full method set implemented by CloudWorkspaceAdapter. */
export const WORKSPACE_SESSION_PORT_FULL_METHODS = [
  ...WORKSPACE_SESSION_PORT_CORE_METHODS,
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

/**
 * Type guard for the shared port. Checks core session methods by default.
 * Pass `mode: 'full'` to require the complete CloudWorkspaceAdapter surface.
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
    if (typeof (port as Record<string, unknown>)[method] !== 'function') {
      throw new Error(`WorkspaceSessionPort missing method: ${method}`)
    }
  }
}
