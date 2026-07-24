import {
  createNativeSession,
  findNativePermissionSession,
  findNativeQuestionSession,
  interruptNativeSession,
  listNativePendingPermissions,
  listNativePendingQuestions,
  normalizeSessionInfo,
  promptNativeSession,
  type NativePromptModel,
} from '@open-cowork/runtime-host'
import type { OpencodeClient } from '@opencode-ai/sdk/v2'
import type { CloudProjectedSessionEventType } from '@open-cowork/shared'
export type CloudRuntimeSession = {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

export type CloudRuntimePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; url: string; filename?: string }

export type CloudRuntimeEvent = {
  /** Stable for retries within the receiving process; never derived from payload secrets. */
  eventId?: string
  type: CloudProjectedSessionEventType
  payload: Record<string, unknown>
}

export type CloudRuntimeEventListener = (event: CloudRuntimeEvent) => void | Promise<void>

export type CloudRuntimeDroppedEvent = {
  sdkEventType: string | null
  reason: 'invalid-envelope' | 'unknown-event-type' | 'no-projected-events'
}

export type CloudRuntimeSubscribeOptions = {
  signal?: AbortSignal
  onError?: (error: unknown) => void
  onDroppedEvent?: (event: CloudRuntimeDroppedEvent) => void
}

export type CloudPromptResult = {
  events?: CloudRuntimeEvent[]
  admissionId?: string
  admittedSequence?: number
}

export type CloudRuntimeExecutionContext = {
  tenantId: string
  sessionId: string
  profileName?: string | null
}

export type CloudRuntimeAdapter = {
  requiresWorkerContext?: boolean
  createSession(input?: { profileName?: string | null, context?: CloudRuntimeExecutionContext | null }): Promise<CloudRuntimeSession>
  promptSession(input: {
    sessionId: string
    parts: CloudRuntimePromptPart[]
    agent: string
    context?: CloudRuntimeExecutionContext | null
    messageId?: string
    signal?: AbortSignal
  }): Promise<CloudPromptResult | void>
  abortSession(input: { sessionId: string, context?: CloudRuntimeExecutionContext | null, signal?: AbortSignal }): Promise<void>
  replyToQuestion?(input: { requestId: string, answers: unknown[], context?: CloudRuntimeExecutionContext | null, signal?: AbortSignal }): Promise<void>
  rejectQuestion?(input: { requestId: string, context?: CloudRuntimeExecutionContext | null, signal?: AbortSignal }): Promise<void>
  respondToPermission?(input: { permissionId: string, allowed: boolean, context?: CloudRuntimeExecutionContext | null, signal?: AbortSignal }): Promise<void>
  subscribeEvents?: (
    listener: CloudRuntimeEventListener,
    options?: CloudRuntimeSubscribeOptions,
  ) => Promise<() => void> | (() => void)
  close?: () => Promise<void> | void
}

function toIsoTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value.trim()) return value
  return new Date().toISOString()
}

function opencodeMessageId(value: string | null | undefined) {
  return typeof value === 'string' && value.startsWith('msg') ? value : null
}

function normalizeV2QuestionAnswers(value: unknown[]): string[][] {
  return value.map((answer) => (
    Array.isArray(answer)
      ? answer.filter((entry): entry is string => typeof entry === 'string')
      : typeof answer === 'string'
        ? [answer]
        : []
  ))
}

/**
 * Parse OpenCode config model strings like `or/deepseek/deepseek-v4-flash`
 * into a V2 ModelRef. First path segment is the provider; the rest is the model id.
 */
export function parseCloudRuntimeModelRef(model: string | null | undefined): NativePromptModel | null {
  const trimmed = model?.trim()
  if (!trimmed) return null
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return null
  return {
    providerID: trimmed.slice(0, slash),
    id: trimmed.slice(slash + 1),
  }
}

export function createSdkCloudRuntimeAdapter(
  client: OpencodeClient,
  location: { directory: string },
  options?: { defaultModel?: string | null },
): CloudRuntimeAdapter {
  const defaultModel = parseCloudRuntimeModelRef(options?.defaultModel)
  return {
    async createSession() {
      const session = normalizeSessionInfo(await createNativeSession(client, {
        location,
        ...(defaultModel
          ? {
            model: {
              providerID: defaultModel.providerID,
              id: defaultModel.id || defaultModel.modelID || '',
            },
          }
          : {}),
      }))
      if (!session) throw new Error('OpenCode returned an invalid session payload.')
      return {
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
      }
    },
    async promptSession(input) {
      const messageId = opencodeMessageId(input.messageId)
      const admitted = await promptNativeSession(client, {
        sessionID: input.sessionId,
        parts: input.parts,
        agent: input.agent,
        model: defaultModel,
        messageID: messageId,
        signal: input.signal,
      })
      return {
        admissionId: admitted.id,
        admittedSequence: admitted.admittedSeq,
      }
    },
    async abortSession(input) {
      await interruptNativeSession(client, input.sessionId, input.signal)
    },
    async replyToQuestion(input) {
      const sourceSessionId = findNativeQuestionSession(
        await listNativePendingQuestions(client),
        input.requestId,
      ) || input.context?.sessionId
      if (!sourceSessionId) throw new Error(`OpenCode question ${input.requestId} is no longer pending.`)
      await client.v2.session.question.reply({
        sessionID: sourceSessionId,
        requestID: input.requestId,
        questionV2Reply: { answers: normalizeV2QuestionAnswers(input.answers) },
      }, { throwOnError: true, signal: input.signal })
    },
    async rejectQuestion(input) {
      const sourceSessionId = findNativeQuestionSession(
        await listNativePendingQuestions(client),
        input.requestId,
      ) || input.context?.sessionId
      if (!sourceSessionId) throw new Error(`OpenCode question ${input.requestId} is no longer pending.`)
      await client.v2.session.question.reject({
        sessionID: sourceSessionId,
        requestID: input.requestId,
      }, { throwOnError: true, signal: input.signal })
    },
    async respondToPermission(input) {
      const sourceSessionId = findNativePermissionSession(
        await listNativePendingPermissions(client),
        input.permissionId,
      ) || input.context?.sessionId
      if (!sourceSessionId) throw new Error(`OpenCode permission ${input.permissionId} is no longer pending.`)
      await client.v2.session.permission.reply({
        sessionID: sourceSessionId,
        requestID: input.permissionId,
        reply: input.allowed ? 'once' : 'reject',
      }, { throwOnError: true, signal: input.signal })
    },
  }
}
