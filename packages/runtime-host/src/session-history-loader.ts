import { normalizeSessionInfo, normalizeSessionMessages, normalizeSessionStatuses, type NormalizedSessionMessage } from '@open-cowork/runtime-host'
import { shortSessionId, asRecord, readRecordArray, readRecordValue, readString } from '@open-cowork/shared'
import type { OpencodeClient, PermissionRequest, QuestionRequest } from '@opencode-ai/sdk/v2'
import type { PendingApproval, PendingQuestion, SessionView } from '@open-cowork/shared'
import { getClientForDirectory, getRuntimeHomeDir, getV2ClientForDirectory } from './runtime.js'
import { getBrandName } from '@open-cowork/runtime-host/config'
import { getEffectiveSettings, loadSettings } from './settings.js'
import { isInternalCoworkMessage } from './internal-message-utils.js'
import { projectSessionHistory } from './session-history-projector.js'
import { log } from '@open-cowork/shared/node'
import { measureAsyncPerf } from './perf-metrics.js'
import { ensureRuntimeContextDirectory } from './runtime-context.js'
import { sessionEngine } from './session-engine.js'
import { getSessionRecord, updateSessionRecord } from './session-registry.js'
import { createSessionSyncCoordinator } from './session-sync-coordinator.js'
import { buildSessionUsageSummary } from './session-usage-summary.js'
import { mergeSessionDiffsWithSynthetic, normalizeSessionFileDiffs, summarizeSessionDiffs } from './session-diff-fallback.js'
import { sdkErrorMessage } from './sdk-error.js'

type QuestionListResult = { data?: QuestionRequest[] }
type PermissionListResult = { data?: PermissionRequest[] }

async function listPendingQuestions(client: OpencodeClient): Promise<QuestionListResult> {
  return client.question.list(undefined, { throwOnError: true })
}

async function listPendingPermissions(client: OpencodeClient): Promise<PermissionListResult> {
  return client.permission.list(undefined, { throwOnError: true })
}

type SessionSyncOptions = {
  force?: boolean
  activate?: boolean
  progressive?: boolean
}

type LoadSessionHistoryOptions = {
  includeChildren?: boolean
}

const CHILD_SNAPSHOT_PREFETCH_CONCURRENCY = 8

type ChildSessionRecord = {
  id: string
  title?: string
  time?: {
    created?: number
    updated?: number
  }
  parentSessionId?: string | null
}

type ChildSnapshot = { messages: unknown[]; todos: unknown[] }

export function createBoundedChildSnapshotLoader(options: {
  ids: string[]
  concurrency?: number
  load: (id: string) => Promise<ChildSnapshot>
}) {
  const concurrency = Math.max(1, Math.floor(options.concurrency || CHILD_SNAPSHOT_PREFETCH_CONCURRENCY))
  const entries = new Map<string, {
    started: boolean
    promise: Promise<ChildSnapshot>
    resolve: (value: ChildSnapshot) => void
    reject: (error: unknown) => void
  }>()
  const queue: string[] = []
  let active = 0

  const schedule = () => {
    while (active < concurrency && queue.length > 0) {
      const id = queue.shift()
      if (!id) continue
      const entry = entries.get(id)
      if (!entry || entry.started) continue
      entry.started = true
      active += 1
      void options.load(id).then(entry.resolve, entry.reject).finally(() => {
        active -= 1
        schedule()
      })
    }
  }

  const ensure = (id: string) => {
    const existing = entries.get(id)
    if (existing) return existing.promise

    let resolveEntry!: (value: ChildSnapshot) => void
    let rejectEntry!: (error: unknown) => void
    const promise = new Promise<ChildSnapshot>((resolve, reject) => {
      resolveEntry = resolve
      rejectEntry = reject
    })
    entries.set(id, {
      started: false,
      promise,
      resolve: resolveEntry,
      reject: rejectEntry,
    })
    queue.push(id)
    schedule()
    return promise
  }

  return {
    prefetch(ids = options.ids) {
      for (const id of ids) void ensure(id).catch(() => undefined)
    },
    load(id: string) {
      return ensure(id)
    },
  }
}

const DEFAULT_SDK_SESSION_TITLE_RE = /^New session(?: - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?)?$/i
const FALLBACK_SESSION_TITLE_MAX_CHARS = 80

function readResponseData(value: unknown) {
  return readRecordValue(value, 'data')
}

function isDefaultSdkSessionTitle(title?: string | null) {
  const trimmed = (title || '').trim()
  return !trimmed || DEFAULT_SDK_SESSION_TITLE_RE.test(trimmed)
}

function nonDefaultPersistedSessionTitle(title?: string | null) {
  const trimmed = title?.trim()
  return trimmed && !isDefaultSdkSessionTitle(trimmed) ? trimmed : null
}

function truncateFallbackSessionTitle(title: string) {
  if (title.length <= FALLBACK_SESSION_TITLE_MAX_CHARS) return title
  const trimmed = title.slice(0, FALLBACK_SESSION_TITLE_MAX_CHARS - 3).trimEnd()
  return `${trimmed}...`
}

function fallbackSessionTitleFromHistory(messages: NormalizedSessionMessage[]) {
  for (const message of messages) {
    const role = message.info.role || message.role
    if (role !== 'user') continue
    const text = message.parts
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (text && !isInternalCoworkMessage(text)) return truncateFallbackSessionTitle(text)
  }
  return null
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

function normalizePendingQuestions(value: unknown, sessionId: string, descendantSessionIds: Set<string>): PendingQuestion[] {
  return readRecordArray({ questions: value }, 'questions')
    .map((entry) => asRecord(entry))
    .filter((question) => {
      const sourceSessionId = readString(question.sessionID)
      return Boolean(sourceSessionId && descendantSessionIds.has(sourceSessionId))
    })
    .map((question) => ({
      id: readString(question.id) || '',
      sessionId,
      sourceSessionId: readString(question.sessionID) || null,
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

function normalizePendingApprovals(
  value: unknown,
  sessionId: string,
  descendantSessionIds: Set<string>,
): Array<Omit<PendingApproval, 'order'>> {
  return readRecordArray({ approvals: value }, 'approvals')
    .map((entry) => asRecord(entry))
    .map((approval) => {
      const sourceSessionId = readString(approval.sessionID)
      return {
        sourceSessionId,
        id: readString(approval.id) || '',
        permission: readString(approval.permission) || 'permission',
        tool: readString(approval.tool),
        metadata: asRecord(approval.metadata),
      }
    })
    .filter((approval) => Boolean(
      approval.id
      && approval.sourceSessionId
      && descendantSessionIds.has(approval.sourceSessionId),
    ))
    .map((approval) => ({
      id: approval.id,
      sessionId,
      taskRunId: approval.sourceSessionId !== sessionId
        ? `child:${approval.sourceSessionId}`
        : null,
      tool: approval.tool || approval.permission,
      input: approval.metadata,
      description: approval.sourceSessionId !== sessionId
        ? `Sub-Agent: ${approval.tool || approval.permission}`
        : `Permission requested for ${approval.tool || approval.permission}`,
    }))
}

function logHistoryError(scope: string, sessionId: string, err: unknown) {
  const message = sdkErrorMessage(err, 'Session history SDK request failed')
  log('error', `${scope} ${shortSessionId(sessionId)} failed: ${message}`)
}

function normalizeChildSessionRecord(entry: unknown, parentSessionId: string): ChildSessionRecord | null {
  const info = normalizeSessionInfo(entry)
  if (info?.id) {
    return {
      id: info.id,
      title: info.title || undefined,
      time: {
        created: info.time.created,
        updated: info.time.updated,
      },
      parentSessionId: info.parentID || parentSessionId,
    }
  }

  const record = asRecord(entry)
  const id = readString(record.id)
  if (!id) return null
  const time = asRecord(record.time)
  return {
    id,
    title: readString(record.title) || undefined,
    time: {
      created: typeof time.created === 'number' ? time.created : undefined,
      updated: typeof time.updated === 'number' ? time.updated : undefined,
    },
    parentSessionId,
  }
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
  listPendingPermissions: typeof listPendingPermissions
  projectSessionHistory: typeof projectSessionHistory
  getCachedModelId: () => string
  updateSessionRecord: typeof updateSessionRecord
  buildSessionUsageSummary: typeof buildSessionUsageSummary
  sessionEngine: Pick<
    typeof sessionEngine,
    'isHydrated' | 'activateSession' | 'setSessionFromHistory' | 'setPendingQuestions' | 'setPendingApprovals' | 'getSessionView'
  >
}

const defaultSessionHistoryServiceDeps: SessionHistoryServiceDeps = {
  getSessionClient,
  listPendingQuestions,
  listPendingPermissions,
  projectSessionHistory,
  getCachedModelId: () => getEffectiveSettings().effectiveModel || loadSettings().selectedModelId || '',
  updateSessionRecord,
  buildSessionUsageSummary,
  sessionEngine,
}

export function createSessionHistoryService(
  deps: SessionHistoryServiceDeps = defaultSessionHistoryServiceDeps,
) {
  const partiallyHydratedSessions = new Set<string>()

  async function loadChildSessionsRecursive(
    client: OpencodeClient,
    parentSessionId: string,
    seen = new Set<string>(),
  ): Promise<ChildSessionRecord[]> {
    if (seen.has(parentSessionId)) return []
    seen.add(parentSessionId)

    const childrenResult = await client.session.children({ sessionID: parentSessionId }).catch((err) => {
      logHistoryError('session:messages children', parentSessionId, err)
      return { data: [] }
    })

    const directChildren = readRecordArray({ value: readResponseData(childrenResult) }, 'value')
      .map((entry) => normalizeChildSessionRecord(entry, parentSessionId))
      .filter((entry): entry is ChildSessionRecord => Boolean(entry))
      .filter((entry) => !seen.has(entry.id))

    const nestedChildren = await Promise.all(
      directChildren.map(async (child) => loadChildSessionsRecursive(client, child.id, seen)),
    )

    return directChildren.concat(nestedChildren.flat())
  }

  async function loadSessionHistory(sessionId: string, options: LoadSessionHistoryOptions = {}) {
    const includeChildren = options.includeChildren !== false
    return measureAsyncPerf(includeChildren ? 'session.history.load' : 'session.history.load.root', async () => {
      const { client, questionClient, record } = await deps.getSessionClient(sessionId)
      const [
        rootMessagesResult,
        rootTodosResult,
        statusResult,
        questionResult,
        permissionResult,
        sessionInfoResult,
      ] = await Promise.all([
        client.session.messages({
          sessionID: sessionId,
        }, {
          throwOnError: true,
        }),
        client.session.todo({ sessionID: sessionId }).catch((err) => {
          logHistoryError('session:messages todo', sessionId, err)
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
        deps.listPendingPermissions(questionClient).catch((err: unknown) => {
          logHistoryError('session:messages permissions', sessionId, err)
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
      const children = includeChildren
        ? await loadChildSessionsRecursive(client, sessionId)
        : []
      const statuses = normalizeSessionStatuses(readResponseData(statusResult))
      const descendantSessionIds = new Set([sessionId, ...children.map((child) => child.id)])
      const questions = normalizePendingQuestions(readResponseData(questionResult), sessionId, descendantSessionIds)
      const approvals = normalizePendingApprovals(readResponseData(permissionResult), sessionId, descendantSessionIds)
      const cachedModelId = deps.getCachedModelId()
      const childSnapshotLoader = createBoundedChildSnapshotLoader({
        ids: children.map((child) => child.id),
        concurrency: CHILD_SNAPSHOT_PREFETCH_CONCURRENCY,
        load: async (childId) => {
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
      if (includeChildren) {
        childSnapshotLoader.prefetch()
      }

      const items = await deps.projectSessionHistory({
        sessionId,
        cachedModelId,
        rootMessages,
        rootTodos,
        children,
        statuses,
        loadChildSnapshot: childSnapshotLoader.load,
        fallbackTimestampMs: record ? Date.parse(record.createdAt) : 0,
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
        let title = sessionInfo.title
        if (isDefaultSdkSessionTitle(title)) {
          const fallbackTitle = nonDefaultPersistedSessionTitle(record?.title)
            || fallbackSessionTitleFromHistory(rootMessages)
          if (fallbackTitle) {
            try {
              await client.session.update({ sessionID: sessionId, title: fallbackTitle })
              title = fallbackTitle
              log('session', `Auto-renamed ${shortSessionId(sessionId)} from default SDK title`)
            } catch (err) {
              logHistoryError('session:title fallback', sessionId, err)
            }
          }
        }
        // parentSessionId is stable once set at fork time. If SDK's session.get
        // omits parentID on a later refresh (it has in practice), don't erase
        // the value we already persisted — only write when we have one.
        deps.updateSessionRecord(sessionId, {
          ...(sessionInfo.parentID ? { parentSessionId: sessionInfo.parentID } : {}),
          changeSummary: sessionInfo.summary,
          revertedMessageId: sessionInfo.revertedMessageId,
          ...(title ? { title } : {}),
        })
      }
      return { items, questions, approvals }
    }, {
      slowThresholdMs: includeChildren ? 250 : 100,
      slowData: {
        sessionId: shortSessionId(sessionId),
        includeChildren,
      },
    })
  }

  async function performSessionSync(sessionId: string, options?: SessionSyncOptions): Promise<SessionView> {
    const shouldActivate = options?.activate !== false
    const progressive = Boolean(options?.progressive && !options.force)
    const metric = options?.force
      ? 'session.sync.force'
      : progressive
        ? 'session.sync.progressive'
      : deps.sessionEngine.isHydrated(sessionId)
        ? 'session.sync.warm'
        : 'session.sync.cold'

    return measureAsyncPerf(metric, async () => {
      if (shouldActivate) {
        deps.sessionEngine.activateSession(sessionId)
      }
      if (options?.force || !deps.sessionEngine.isHydrated(sessionId)) {
        const { items, questions, approvals } = await loadSessionHistory(sessionId, {
          includeChildren: !progressive,
        })
        deps.sessionEngine.setSessionFromHistory(sessionId, items, {
          force: options?.force,
        })
        deps.sessionEngine.setPendingQuestions(sessionId, questions)
        deps.sessionEngine.setPendingApprovals(sessionId, approvals)
        if (progressive) {
          partiallyHydratedSessions.add(sessionId)
        } else {
          partiallyHydratedSessions.delete(sessionId)
        }
      }
      const view = deps.sessionEngine.getSessionView(sessionId)
      const patch: Parameters<typeof deps.updateSessionRecord>[1] = {
        summary: deps.buildSessionUsageSummary(view),
      }

      if (!progressive) {
        try {
          const { client, record } = await deps.getSessionClient(sessionId)
          const diffResult = await client.session.diff({
            sessionID: sessionId,
          }).catch((err) => {
            logHistoryError('session:diff summary', sessionId, err)
            return { data: [] }
          })
          const sdkDiffs = normalizeSessionFileDiffs(Array.isArray(diffResult.data) ? diffResult.data : [])
          const rootDir = record?.opencodeDirectory || getRuntimeHomeDir()
          patch.changeSummary = summarizeSessionDiffs(
            mergeSessionDiffsWithSynthetic(sdkDiffs, view, rootDir),
          )
        } catch (err) {
          logHistoryError('session:diff summary client', sessionId, err)
        }
      }

      deps.updateSessionRecord(sessionId, patch)
      return view
    }, {
      slowThresholdMs: options?.force ? 300 : 150,
      slowData: {
        sessionId: shortSessionId(sessionId),
        force: Boolean(options?.force),
        activate: shouldActivate,
        progressive,
      },
    })
  }

  const runSessionSync = createSessionSyncCoordinator<SessionView, SessionSyncOptions>((sessionId, options) =>
    performSessionSync(sessionId, options),
  )

  return {
    loadSessionHistory,
    isSessionPartiallyHydrated(sessionId: string) {
      return partiallyHydratedSessions.has(sessionId)
    },
    syncSessionView(sessionId: string, options?: SessionSyncOptions) {
      return runSessionSync(sessionId, options)
    },
  }
}

const sessionHistoryService = createSessionHistoryService()

export const loadSessionHistory = sessionHistoryService.loadSessionHistory
export const isSessionPartiallyHydrated = sessionHistoryService.isSessionPartiallyHydrated
export const syncSessionView = sessionHistoryService.syncSessionView
