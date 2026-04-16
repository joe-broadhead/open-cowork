import type { PendingQuestion, SessionView } from '@open-cowork/shared'
import { getClientForDirectory, getRuntimeHomeDir, getV2ClientForDirectory } from './runtime.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import {
  normalizeSessionMessages,
  normalizeSessionStatuses,
  readRecord,
  readRecordArray,
  readRecordValue,
  readStringValue,
} from './opencode-adapter.ts'
import { projectSessionHistory } from './session-history-projector.ts'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { measureAsyncPerf } from './perf-metrics.ts'
import { listPendingQuestions } from './question-client.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { sessionEngine } from './session-engine.ts'
import { getSessionRecord, updateSessionRecord } from './session-registry.ts'
import { createSessionSyncCoordinator } from './session-sync-coordinator.ts'
import { buildSessionUsageSummary } from './session-usage-summary.ts'

type SessionSyncOptions = {
  force?: boolean
  activate?: boolean
}

function readResponseData(value: unknown) {
  return readRecordValue(value, 'data')
}

function normalizeQuestionOptions(value: unknown) {
  return readRecordArray({ options: value }, 'options').map((option) => {
    const record = readRecord(option)
    return {
      label: readStringValue(record.label) || '',
      description: readStringValue(record.description) || '',
    }
  })
}

function normalizePendingQuestions(value: unknown, sessionId: string): PendingQuestion[] {
  return readRecordArray({ questions: value }, 'questions')
    .map((entry) => readRecord(entry))
    .filter((question) => question.sessionID === sessionId)
    .map((question) => ({
      id: readStringValue(question.id) || '',
      sessionId,
      questions: readRecordArray(question, 'questions').map((entry) => {
        const record = readRecord(entry)
        return {
          header: readStringValue(record.header) || '',
          question: readStringValue(record.question) || '',
          options: normalizeQuestionOptions(record.options),
          multiple: Boolean(record.multiple),
          custom: record.custom !== false,
        }
      }),
      tool: question.tool && typeof question.tool === 'object'
        ? {
            messageId: readStringValue(readRecord(question.tool).messageID) || '',
            callId: readStringValue(readRecord(question.tool).callID) || '',
          }
        : undefined,
    }))
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

type SessionHistoryServiceDeps = {
  getSessionClient: typeof getSessionClient
  listPendingQuestions: typeof listPendingQuestions
  projectSessionHistory: typeof projectSessionHistory
  getCachedModelId: () => string
  updateSessionRecord: typeof updateSessionRecord
  buildSessionUsageSummary: typeof buildSessionUsageSummary
  sessionEngine: Pick<
    typeof sessionEngine,
    'isHydrated' | 'activateSession' | 'setSessionFromHistory' | 'setPendingQuestions' | 'getSessionView'
  >
}

const defaultSessionHistoryServiceDeps: SessionHistoryServiceDeps = {
  getSessionClient,
  listPendingQuestions,
  projectSessionHistory,
  getCachedModelId: () => getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || '',
  updateSessionRecord,
  buildSessionUsageSummary,
  sessionEngine,
}

export function createSessionHistoryService(
  deps: SessionHistoryServiceDeps = defaultSessionHistoryServiceDeps,
) {
  async function loadSessionHistory(sessionId: string) {
    return measureAsyncPerf('session.history.load', async () => {
      const { client, questionClient } = await deps.getSessionClient(sessionId)
      const [rootMessagesResult, rootTodosResult, childrenResult, statusResult, questionResult] = await Promise.all([
        client.session.messages({
          sessionID: sessionId,
        }, {
          throwOnError: true,
        }),
        client.session.todo({ sessionID: sessionId }).catch((err) => {
          logHistoryError('session:messages todo', sessionId, err)
          return { data: [] }
        }),
        client.session.children({ sessionID: sessionId }).catch((err) => {
          logHistoryError('session:messages children', sessionId, err)
          return { data: [] }
        }),
        client.session.status().catch((err) => {
          logHistoryError('session:messages status', sessionId, err)
          return { data: {} }
        }),
        deps.listPendingQuestions(questionClient).catch((err: unknown) => {
          logHistoryError('session:messages questions', sessionId, err)
          return { data: [] }
        }),
      ])

      const rootMessages = normalizeSessionMessages(rootMessagesResult.data)
      const rootTodos = readRecordArray({ value: readResponseData(rootTodosResult) }, 'value')
      const children = readRecordArray({ value: readResponseData(childrenResult) }, 'value')
        .map((entry) => readRecord(entry))
        .map((entry) => ({
          id: readStringValue(entry.id) || '',
          title: readStringValue(entry.title) || undefined,
          time: {
            created: typeof readRecord(entry.time).created === 'number' ? readRecord(entry.time).created as number : undefined,
            updated: typeof readRecord(entry.time).updated === 'number' ? readRecord(entry.time).updated as number : undefined,
          },
        }))
        .filter((entry) => entry.id)
      const statuses = normalizeSessionStatuses(readResponseData(statusResult))
      const questions = normalizePendingQuestions(readResponseData(questionResult), sessionId)
      const cachedModelId = deps.getCachedModelId()

      const items = await deps.projectSessionHistory({
        sessionId,
        cachedModelId,
        rootMessages,
        rootTodos,
        children,
        statuses,
        loadChildSnapshot: async (childId) => {
          const [result, childTodoResult] = await Promise.all([
            client.session.messages({
              sessionID: childId,
            }, {
              throwOnError: true,
            }),
            client.session.todo({ sessionID: childId }).catch((err) => {
              logHistoryError('session:messages child todo', childId, err)
              return { data: [] }
            }),
          ])
          return {
            messages: normalizeSessionMessages(result.data),
            todos: readRecordArray({ value: readResponseData(childTodoResult) }, 'value'),
          }
        },
      })
      const latestModeledItem = [...items]
        .reverse()
        .find((item) => item.providerId || item.modelId) || null
      if (latestModeledItem) {
        deps.updateSessionRecord(sessionId, {
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
      : deps.sessionEngine.isHydrated(sessionId)
        ? 'session.sync.warm'
        : 'session.sync.cold'

    return measureAsyncPerf(metric, async () => {
      if (shouldActivate) {
        deps.sessionEngine.activateSession(sessionId)
      }
      if (options?.force || !deps.sessionEngine.isHydrated(sessionId)) {
        const { items, questions } = await loadSessionHistory(sessionId)
        deps.sessionEngine.setSessionFromHistory(sessionId, items, {
          force: options?.force,
        })
        deps.sessionEngine.setPendingQuestions(sessionId, questions)
      }
      const view = deps.sessionEngine.getSessionView(sessionId)
      deps.updateSessionRecord(sessionId, {
        summary: deps.buildSessionUsageSummary(view),
      })
      return view
    }, {
      slowThresholdMs: options?.force ? 300 : 150,
      slowData: {
        sessionId: shortSessionId(sessionId),
        force: Boolean(options?.force),
        activate: shouldActivate,
      },
    })
  }

  const runSessionSync = createSessionSyncCoordinator<SessionView, SessionSyncOptions>((sessionId, options) =>
    performSessionSync(sessionId, options),
  )

  return {
    loadSessionHistory,
    syncSessionView(sessionId: string, options?: SessionSyncOptions) {
      return runSessionSync(sessionId, options)
    },
  }
}

const sessionHistoryService = createSessionHistoryService()

export const loadSessionHistory = sessionHistoryService.loadSessionHistory
export const syncSessionView = sessionHistoryService.syncSessionView
