import type { OpencodeClient, QuestionRequest } from '@opencode-ai/sdk/v2'
import type { PendingQuestion, SessionView } from '@open-cowork/shared'
import { getClientForDirectory, getRuntimeHomeDir, getV2ClientForDirectory } from './runtime.ts'
import { getBrandName } from './config-loader.ts'
import { getEffectiveSettings, loadSettings } from './settings.ts'
import {
  normalizeSessionInfo,
  normalizeSessionMessages,
  normalizeSessionStatuses,
  asRecord,
  readRecordArray,
  readRecordValue,
  readString,
} from './opencode-adapter.ts'
import { projectSessionHistory } from './session-history-projector.ts'
import { log } from './logger.ts'
import { shortSessionId } from './log-sanitizer.ts'
import { measureAsyncPerf } from './perf-metrics.ts'
import { ensureRuntimeContextDirectory } from './runtime-context.ts'
import { sessionEngine } from './session-engine.ts'
import { getSessionRecord, updateSessionRecord } from './session-registry.ts'
import { createSessionSyncCoordinator } from './session-sync-coordinator.ts'
import { buildSessionUsageSummary } from './session-usage-summary.ts'

type QuestionListResult = { data?: QuestionRequest[] }

async function listPendingQuestions(client: OpencodeClient): Promise<QuestionListResult> {
  return client.question.list(undefined, { throwOnError: true })
}

type SessionSyncOptions = {
  force?: boolean
  activate?: boolean
}

function readResponseData(value: unknown) {
  return readRecordValue(value, 'data')
}

function normalizeQuestionOptions(value: unknown) {
  return readRecordArray({ options: value }, 'options').map((option) => {
    const record = asRecord(option)
    return {
      label: readString(record.label) || '',
      description: readString(record.description) || '',
    }
  })
}

function normalizePendingQuestions(value: unknown, sessionId: string): PendingQuestion[] {
  return readRecordArray({ questions: value }, 'questions')
    .map((entry) => asRecord(entry))
    .filter((question) => question.sessionID === sessionId)
    .map((question) => ({
      id: readString(question.id) || '',
      sessionId,
      questions: readRecordArray(question, 'questions').map((entry) => {
        const record = asRecord(entry)
        return {
          header: readString(record.header) || '',
          question: readString(record.question) || '',
          options: normalizeQuestionOptions(record.options),
          multiple: Boolean(record.multiple),
          custom: record.custom !== false,
        }
      }),
      tool: question.tool && typeof question.tool === 'object'
        ? {
            messageId: readString(asRecord(question.tool).messageID) || '',
            callId: readString(asRecord(question.tool).callID) || '',
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
    throw new Error(`Unknown ${getBrandName()} session: ${sessionId}`)
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
      const [rootMessagesResult, rootTodosResult, childrenResult, statusResult, questionResult, sessionInfoResult] = await Promise.all([
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
        // Pull SDK-owned session fields (summary, revert, parentID) so the
        // sidebar chip + header linkage stay in sync with what OpenCode knows
        // without needing an extra round-trip from the renderer.
        client.session.get({ sessionID: sessionId }).catch((err) => {
          logHistoryError('session:messages get', sessionId, err)
          return { data: null }
        }),
      ])

      const rootMessages = normalizeSessionMessages(rootMessagesResult.data)
      const rootTodos = readRecordArray({ value: readResponseData(rootTodosResult) }, 'value')
      const children = readRecordArray({ value: readResponseData(childrenResult) }, 'value')
        .map((entry) => asRecord(entry))
        .map((entry) => ({
          id: readString(entry.id) || '',
          title: readString(entry.title) || undefined,
          time: {
            created: typeof asRecord(entry.time).created === 'number' ? asRecord(entry.time).created as number : undefined,
            updated: typeof asRecord(entry.time).updated === 'number' ? asRecord(entry.time).updated as number : undefined,
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
      const sessionInfo = normalizeSessionInfo(sessionInfoResult?.data)
      if (sessionInfo) {
        // parentSessionId is stable once set at fork time. If SDK's session.get
        // omits parentID on a later refresh (it has in practice), don't erase
        // the value we already persisted — only write when we have one.
        deps.updateSessionRecord(sessionId, {
          ...(sessionInfo.parentID ? { parentSessionId: sessionInfo.parentID } : {}),
          changeSummary: sessionInfo.summary,
          revertedMessageId: sessionInfo.revertedMessageId,
          ...(sessionInfo.title ? { title: sessionInfo.title } : {}),
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
