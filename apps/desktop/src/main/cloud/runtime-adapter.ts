import type { CloudProjectedSessionEventType } from '@open-cowork/shared'
import { normalizeSessionInfo } from '../opencode-adapter.ts'

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
  }): Promise<CloudPromptResult | void>
  abortSession(input: { sessionId: string, context?: CloudRuntimeExecutionContext | null }): Promise<void>
  replyToQuestion?(input: { requestId: string, answers: unknown[], context?: CloudRuntimeExecutionContext | null }): Promise<void>
  rejectQuestion?(input: { requestId: string, context?: CloudRuntimeExecutionContext | null }): Promise<void>
  respondToPermission?(input: { permissionId: string, allowed: boolean, context?: CloudRuntimeExecutionContext | null }): Promise<void>
  subscribeEvents?: (
    listener: CloudRuntimeEventListener,
    options?: CloudRuntimeSubscribeOptions,
  ) => Promise<() => void> | (() => void)
  close?: () => Promise<void> | void
}

type SdkLikeClient = {
  session: {
    create(input?: Record<string, never>, options?: { throwOnError?: boolean }): Promise<{ data: unknown }>
    promptAsync(input: {
      sessionID: string
      parts: CloudRuntimePromptPart[]
      agent: string
    }, options?: { throwOnError?: boolean }): Promise<unknown>
    abort(input: { sessionID: string }): Promise<unknown>
  }
  question?: {
    reply?: unknown
    reject?: unknown
  }
  permission?: {
    reply?: unknown
  }
}

function toIsoTimestamp(value: unknown) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString()
  if (typeof value === 'string' && value.trim()) return value
  return new Date().toISOString()
}

export function createSdkCloudRuntimeAdapter(client: SdkLikeClient): CloudRuntimeAdapter {
  return {
    async createSession() {
      const result = await client.session.create({}, { throwOnError: true })
      const session = normalizeSessionInfo(result.data)
      if (!session) throw new Error('OpenCode returned an invalid session payload.')
      return {
        id: session.id,
        title: session.title || 'New session',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
      }
    },
    async promptSession(input) {
      await client.session.promptAsync({
        sessionID: input.sessionId,
        parts: input.parts,
        agent: input.agent,
      }, { throwOnError: true })
    },
    async abortSession(input) {
      await client.session.abort({ sessionID: input.sessionId })
    },
    async replyToQuestion(input) {
      if (typeof client.question?.reply !== 'function') throw new Error('OpenCode question replies are not available.')
      const reply = client.question.reply as (
        request: { requestID: string, answers: unknown[] },
        options?: { throwOnError?: boolean },
      ) => Promise<unknown>
      await reply.call(client.question, {
        requestID: input.requestId,
        answers: input.answers,
      }, { throwOnError: true })
    },
    async rejectQuestion(input) {
      if (typeof client.question?.reject !== 'function') throw new Error('OpenCode question rejection is not available.')
      const reject = client.question.reject as (
        request: { requestID: string },
        options?: { throwOnError?: boolean },
      ) => Promise<unknown>
      await reject.call(client.question, {
        requestID: input.requestId,
      }, { throwOnError: true })
    },
    async respondToPermission(input) {
      if (typeof client.permission?.reply !== 'function') throw new Error('OpenCode permission responses are not available.')
      const reply = client.permission.reply as (
        request: { requestID: string, reply: 'once' | 'reject' },
        options?: { throwOnError?: boolean },
      ) => Promise<unknown>
      await reply.call(client.permission, {
        requestID: input.permissionId,
        reply: input.allowed ? 'once' : 'reject',
      }, { throwOnError: true })
    },
  }
}
