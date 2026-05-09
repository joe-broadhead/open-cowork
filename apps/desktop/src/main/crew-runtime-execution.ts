import { getEffectiveSettings } from './settings.ts'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.ts'
import { normalizeSessionInfo } from './opencode-adapter.ts'
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
  }
}
