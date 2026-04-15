import type { SessionView } from '@open-cowork/shared'
import { getClientForDirectory, getRuntimeHomeDir, getV2ClientForDirectory } from './runtime.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import { projectSessionHistory } from './session-history-projector.ts'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { measureAsyncPerf } from './perf-metrics.ts'
import { listPendingQuestions } from './question-client.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { sessionEngine } from './session-engine.ts'
import { getSessionRecord, updateSessionRecord } from './session-registry.ts'
import { createSessionSyncCoordinator } from './session-sync-coordinator.ts'

type SessionSyncOptions = {
  force?: boolean
  activate?: boolean
}

function logHistoryError(scope: string, sessionId: string, err: unknown) {
  const message = err instanceof Error
    ? err.message
    : typeof err === 'string'
      ? err
      : JSON.stringify(err)
  log('error', `${scope} ${shortSessionId(sessionId)} failed: ${message}`)
}

async function getSessionClient(sessionId: string) {
  const record = getSessionRecord(sessionId)
  if (!record) {
    throw new Error(`Unknown Open Cowork session: ${sessionId}`)
  }
  const directory = record.opencodeDirectory || getRuntimeHomeDir()
  await ensureRuntimeContextDirectory(directory)
  const client = getClientForDirectory(directory)
  const questionClient = getV2ClientForDirectory(directory)
  if (!client || !questionClient) throw new Error('Runtime not started')
  return { client, questionClient, record }
}

export async function loadSessionHistory(sessionId: string) {
  return measureAsyncPerf('session.history.load', async () => {
    const { client, questionClient } = await getSessionClient(sessionId)
    const [rootMessagesResult, rootTodosResult, childrenResult, statusResult, questionResult] = await Promise.all([
      client.session.messages({
        throwOnError: true,
        path: { id: sessionId },
      }),
      client.session.todo({ path: { id: sessionId } }).catch((err) => {
        logHistoryError('session:messages todo', sessionId, err)
        return { data: [] }
      }),
      client.session.children({ path: { id: sessionId } }).catch((err) => {
        logHistoryError('session:messages children', sessionId, err)
        return { data: [] }
      }),
      client.session.status().catch((err) => {
        logHistoryError('session:messages status', sessionId, err)
        return { data: {} }
      }),
      listPendingQuestions(questionClient).catch((err: unknown) => {
        logHistoryError('session:messages questions', sessionId, err)
        return { data: [] }
      }),
    ])

    const rootMessages = (rootMessagesResult.data as any[]) || []
    const rootTodos = ((rootTodosResult as any)?.data as any[]) || []
    const children = (((childrenResult as any)?.data as any[]) || [])
    const statuses = (((statusResult as any)?.data as Record<string, any>) || {})
    const questions = ((((questionResult as any)?.data as any[]) || [])
      .filter((question: any) => question?.sessionID === sessionId)
      .map((question: any) => ({
        id: String(question.id),
        sessionId,
        questions: Array.isArray(question.questions)
          ? question.questions.map((entry: any) => ({
              header: String(entry?.header || ''),
              question: String(entry?.question || ''),
              options: Array.isArray(entry?.options)
                ? entry.options.map((option: any) => ({
                    label: String(option?.label || ''),
                    description: String(option?.description || ''),
                  }))
                : [],
              multiple: Boolean(entry?.multiple),
              custom: entry?.custom !== false,
            }))
          : [],
        tool: question.tool
          ? {
              messageId: String(question.tool.messageID || ''),
              callId: String(question.tool.callID || ''),
            }
          : undefined,
      })))
    const cachedModelId = getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || ''

    const items = await projectSessionHistory({
      sessionId,
      cachedModelId,
      rootMessages,
      rootTodos,
      children,
      statuses,
      loadChildSnapshot: async (childId) => {
        const [result, childTodoResult] = await Promise.all([
          client.session.messages({
            throwOnError: true,
            path: { id: childId },
          }),
          client.session.todo({ path: { id: childId } }).catch((err) => {
            logHistoryError('session:messages child todo', childId, err)
            return { data: [] }
          }),
        ])
        return {
          messages: (result.data as any[]) || [],
          todos: (((childTodoResult as any)?.data as any[]) || []),
        }
      },
    })
    const latestModeledItem = [...items]
      .reverse()
      .find((item) => item.providerId || item.modelId) || null
    if (latestModeledItem) {
      updateSessionRecord(sessionId, {
        providerId: latestModeledItem.providerId || null,
        modelId: latestModeledItem.modelId || null,
      })
    }
    return { items, questions }
  }, {
    slowThresholdMs: 250,
    slowData: { sessionId: shortSessionId(sessionId) },
  })
}

async function performSessionSync(sessionId: string, options?: SessionSyncOptions): Promise<SessionView> {
  const shouldActivate = options?.activate !== false
  const metric = options?.force
    ? 'session.sync.force'
    : sessionEngine.isHydrated(sessionId)
      ? 'session.sync.warm'
      : 'session.sync.cold'

  return measureAsyncPerf(metric, async () => {
    if (shouldActivate) {
      sessionEngine.activateSession(sessionId)
    }
    if (options?.force || !sessionEngine.isHydrated(sessionId)) {
      const { items, questions } = await loadSessionHistory(sessionId)
      sessionEngine.setSessionFromHistory(sessionId, items as any, { force: options?.force })
      sessionEngine.setPendingQuestions(sessionId, questions)
    }
    return sessionEngine.getSessionView(sessionId)
  }, {
    slowThresholdMs: options?.force ? 300 : 150,
    slowData: {
      sessionId: shortSessionId(sessionId),
      force: Boolean(options?.force),
      activate: shouldActivate,
    },
  })
}

const runSessionSync = createSessionSyncCoordinator<SessionView>((sessionId, options) =>
  performSessionSync(sessionId, options),
)

export async function syncSessionView(sessionId: string, options?: SessionSyncOptions): Promise<SessionView> {
  return runSessionSync(sessionId, options)
}
