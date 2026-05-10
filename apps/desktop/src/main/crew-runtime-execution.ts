import type { OutputFormat } from '@opencode-ai/sdk/v2'
import { getEffectiveSettings } from './settings.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { normalizeSessionInfo, normalizeSessionMessages } from './opencode-adapter.ts'
import { toIsoTimestamp } from './task-run-utils.ts'
import { trackParentSession } from './event-task-state.ts'
import {
  toSessionRecord,
  upsertSessionRecord,
  updateSessionRecord,
} from './session-registry.ts'
import { getThreadIndexService } from './thread-index-service.ts'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'

export type CrewRuntimeSession = {
  id: string
}

export type CrewRuntimeExecutionDriver = {
  createRootSession: (input: { title: string; agentName: string }) => Promise<CrewRuntimeSession>
  prompt: (input: { sessionId: string; agentName: string; prompt: string }) => Promise<void>
  evaluateOutcome: (input: {
    title: string
    agentName: string
    prompt: string
    format: OutputFormat
  }) => Promise<{
    sessionId: string
    structured: unknown
    text: string
  }>
}

export function createOpenCodeCrewRuntimeDriver(): CrewRuntimeExecutionDriver {
  const directory = getRuntimeHomeDir()

  function getRuntimeClient() {
    const client = getClientForDirectory(directory)
    if (!client) throw new Error('Runtime not started')
    return client
  }

  return {
    async createRootSession(input) {
      const client = getRuntimeClient()
      const settings = getEffectiveSettings()
      const result = await client.session.create({}, { throwOnError: true })
      const session = normalizeSessionInfo(result.data)
      if (!session) throw new Error('Runtime returned an invalid session payload')

      try {
        await client.session.update({ sessionID: session.id, title: input.title })
      } catch (error) {
        log('crew', `Could not title crew root session ${shortSessionId(session.id)}: ${error instanceof Error ? error.message : String(error)}`)
      }

      trackParentSession(session.id)
      const record = upsertSessionRecord(toSessionRecord({
        id: session.id,
        title: input.title || session.title || 'Crew run',
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        opencodeDirectory: directory,
        providerId: settings.effectiveProviderId || null,
        modelId: settings.effectiveModel || null,
        kind: 'interactive',
      }))
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
      log('crew', `Created crew root session ${shortSessionId(session.id)} with lead agent ${input.agentName}`)
      return { id: session.id }
    },

    async prompt(input) {
      const client = getRuntimeClient()
      await client.session.promptAsync({
        sessionID: input.sessionId,
        parts: [{ type: 'text', text: input.prompt }],
        agent: input.agentName,
      }, {
        throwOnError: true,
      })
      const record = updateSessionRecord(input.sessionId, {
        updatedAt: new Date().toISOString(),
      })
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)
      log('crew', `Submitted crew prompt to ${shortSessionId(input.sessionId)} as ${input.agentName}`)
    },

    async evaluateOutcome(input) {
      const client = getRuntimeClient()
      const settings = getEffectiveSettings()
      const result = await client.session.create({}, { throwOnError: true })
      const session = normalizeSessionInfo(result.data)
      if (!session) throw new Error('Runtime returned an invalid evaluator session payload')

      const title = `Crew evaluator: ${input.title}`
      try {
        await client.session.update({ sessionID: session.id, title })
      } catch (error) {
        log('crew', `Could not title crew evaluator session ${shortSessionId(session.id)}: ${error instanceof Error ? error.message : String(error)}`)
      }

      trackParentSession(session.id)
      const record = upsertSessionRecord(toSessionRecord({
        id: session.id,
        title,
        createdAt: toIsoTimestamp(session.time.created),
        updatedAt: toIsoTimestamp(session.time.updated || session.time.created),
        opencodeDirectory: directory,
        providerId: settings.effectiveProviderId || null,
        modelId: settings.effectiveModel || null,
        kind: 'interactive',
      }))
      if (record) getThreadIndexService().upsertThreadFromSessionRecord(record)

      await client.session.prompt({
        sessionID: session.id,
        parts: [{ type: 'text', text: input.prompt }],
        agent: input.agentName,
        format: input.format,
      }, {
        throwOnError: true,
      })

      const messages = normalizeSessionMessages((await client.session.messages({ sessionID: session.id }, { throwOnError: true })).data)
      const assistant = [...messages].reverse().find((message) => message.role === 'assistant') || null
      const text = assistant?.parts
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text?.trim() || '')
        .filter(Boolean)
        .join('\n\n') || ''
      const updated = updateSessionRecord(session.id, { updatedAt: new Date().toISOString() })
      if (updated) getThreadIndexService().upsertThreadFromSessionRecord(updated)
      log('crew', `Recorded crew evaluator output from ${shortSessionId(session.id)} as ${input.agentName}`)
      return {
        sessionId: session.id,
        structured: assistant?.structured,
        text,
      }
    },
  }
}
