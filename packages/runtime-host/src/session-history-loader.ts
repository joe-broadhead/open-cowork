import { normalizeSessionInfo, normalizeSessionMessages, type NormalizedSessionMessage } from './opencode-adapter.js'
import {
  getNativeSession,
  listNativeActiveSessionIds,
  listNativePendingPermissions,
  listNativePendingQuestions,
  listNativeSessions,
  listNativeSessionMessages,
} from './opencode-v2.js'
import { shortSessionId, asRecord, readRecordArray, readRecordValue, readString } from '@open-cowork/shared'
import type { OpencodeClient, PermissionV2Request, QuestionV2Request } from '@opencode-ai/sdk/v2'
import type { PendingApproval, PendingQuestion, SessionView } from '@open-cowork/shared'
import { getClientForDirectory, getRuntimeHomeDir } from './runtime.js'
import { getBrandName } from './config-loader-core.js'
import { getEffectiveSettings, loadSettings } from './settings.js'
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
import {
  timingFromChild,
  type ChildSessionRecord,
  type TaskStatus,
} from './session-history-task-binding.js'

type QuestionListResult = { data?: QuestionV2Request[] }
type PermissionListResult = { data?: PermissionV2Request[] }

async function listPendingQuestions(client: OpencodeClient): Promise<QuestionListResult> {
  return { data: await listNativePendingQuestions(client) }
}

async function listPendingPermissions(client: OpencodeClient): Promise<PermissionListResult> {
  return { data: await listNativePendingPermissions(client) }
}

type SessionSyncOptions = {
  force?: boolean
  activate?: boolean
  progressive?: boolean
}

type LoadSessionHistoryOptions = {
  includeChildren?: boolean
  includeChildTranscripts?: boolean
}

export type SessionHistoryChildLineageSeed = {
  id: string
  parentSessionId?: string | null
  title?: string | null
  agent?: string | null
  status?: TaskStatus | null
  startedAt?: string | null
  finishedAt?: string | null
}

export type SessionHistoryChildLineageSeedHandler = (input: {
  rootSessionId: string
  children: SessionHistoryChildLineageSeed[]
}) => void

export type SessionHistoryViewIndexHandler = (input: {
  sessionId: string
  view: SessionView
}) => void | Promise<void>

const CHILD_SNAPSHOT_PREFETCH_CONCURRENCY = 8

type ChildSnapshot = { messages: unknown[]; todos: unknown[] }

let sessionHistoryChildLineageSeedHandler: SessionHistoryChildLineageSeedHandler | null = null
let sessionHistoryViewIndexHandler: SessionHistoryViewIndexHandler | null = null

export function setSessionHistoryChildLineageSeedHandler(handler: SessionHistoryChildLineageSeedHandler | null) {
  sessionHistoryChildLineageSeedHandler = handler
}

export function setSessionHistoryViewIndexHandler(handler: SessionHistoryViewIndexHandler | null) {
  sessionHistoryViewIndexHandler = handler
}

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
    if (text) return truncateFallbackSessionTitle(text)
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

function isChildQuestion(sessionId: string, question: PendingQuestion) {
  return Boolean(question.sourceSessionId && question.sourceSessionId !== sessionId)
}

function isChildApproval(sessionId: string, approval: PendingApproval | Omit<PendingApproval, 'order'>) {
  return Boolean(approval.sourceSessionId && approval.sourceSessionId !== sessionId)
    || Boolean(approval.taskRunId?.startsWith('child:'))
}

function dropApprovalOrder(approval: PendingApproval): Omit<PendingApproval, 'order'> {
  const { order: _order, ...rest } = approval
  return rest
}

function mergePendingQuestions(
  loaded: PendingQuestion[],
  existing: PendingQuestion[],
  sessionId: string,
  preserve: 'none' | 'children' | 'all',
) {
  if (preserve === 'none' || existing.length === 0) return loaded
  const loadedIds = new Set(loaded.map((question) => question.id))
  const preserved = existing.filter((question) => {
    if (loadedIds.has(question.id)) return false
    return preserve === 'all' || isChildQuestion(sessionId, question)
  })
  return loaded.concat(preserved)
}

function mergePendingApprovals(
  loaded: Array<Omit<PendingApproval, 'order'>>,
  existing: PendingApproval[],
  sessionId: string,
  preserve: 'none' | 'children' | 'all',
) {
  if (preserve === 'none' || existing.length === 0) return loaded
  const loadedIds = new Set(loaded.map((approval) => approval.id))
  const preserved = existing.filter((approval) => {
    if (loadedIds.has(approval.id)) return false
    return preserve === 'all' || isChildApproval(sessionId, approval)
  })
  return loaded.concat(preserved.map(dropApprovalOrder))
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
        permission: readString(approval.action) || readString(approval.permission) || 'permission',
        tool: readString(approval.tool),
        metadata: {
          ...asRecord(approval.metadata),
          ...(Array.isArray(approval.resources) ? { resources: approval.resources } : {}),
          ...(Array.isArray(approval.save) ? { save: approval.save } : {}),
          ...(Object.keys(asRecord(approval.source)).length > 0 ? { source: asRecord(approval.source) } : {}),
        },
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
      sourceSessionId: approval.sourceSessionId,
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

function seedSessionHistoryChildLineage(rootSessionId: string, children: SessionHistoryChildLineageSeed[]) {
  if (children.length === 0 || !sessionHistoryChildLineageSeedHandler) return
  try {
    sessionHistoryChildLineageSeedHandler({ rootSessionId, children })
  } catch (err) {
    logHistoryError('session:history child lineage seed', rootSessionId, err)
  }
}

function buildChildLineageSeeds(
  rootSessionId: string,
  children: ChildSessionRecord[],
  items: Awaited<ReturnType<typeof projectSessionHistory>>,
): SessionHistoryChildLineageSeed[] {
  if (children.length === 0) return []
  const childIds = new Set(children.map((child) => child.id))
  const taskRunByChildId = new Map<string, NonNullable<(typeof items)[number]['taskRun']>>()
  for (const item of items) {
    const taskRun = item.taskRun
    if (!taskRun?.sourceSessionId || !childIds.has(taskRun.sourceSessionId)) continue
    taskRunByChildId.set(taskRun.sourceSessionId, taskRun)
  }
  return children.map((child) => {
    const taskRun = taskRunByChildId.get(child.id)
    const status = taskRun?.status || 'queued'
    const fallbackTiming = timingFromChild(child, status)
    return {
      id: child.id,
      parentSessionId: child.parentSessionId || rootSessionId,
      title: taskRun?.title || child.title || null,
      agent: taskRun?.agent || null,
      status,
      startedAt: taskRun?.startedAt ?? fallbackTiming.startedAt,
      finishedAt: taskRun?.finishedAt ?? fallbackTiming.finishedAt,
    }
  })
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
  const questionClient = getClientForDirectory(directory)
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
  seedChildSessionLineage?: (rootSessionId: string, children: SessionHistoryChildLineageSeed[]) => void
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
  seedChildSessionLineage: seedSessionHistoryChildLineage,
  sessionEngine,
}

export function createSessionHistoryService(
  deps: SessionHistoryServiceDeps = defaultSessionHistoryServiceDeps,
) {
  const partiallyHydratedSessions = new Set<string>()

  async function loadChildSessionsRecursive(
    client: OpencodeClient,
    parentSessionId: string,
    directory: string,
  ): Promise<{ children: ChildSessionRecord[]; complete: boolean }> {
    const sessions = await listNativeSessions(client, { directory }).catch((err) => {
      logHistoryError('session:messages children', parentSessionId, err)
      return null
    })
    if (!sessions) return { children: [], complete: false }
    const byParent = new Map<string, ChildSessionRecord[]>()
    for (const entry of sessions) {
      const parentID = entry.parentID
      if (!parentID) continue
      const child = normalizeChildSessionRecord(entry, parentID)
      if (!child) continue
      const existing = byParent.get(parentID)
      if (existing) existing.push(child)
      else byParent.set(parentID, [child])
    }
    const children: ChildSessionRecord[] = []
    const seen = new Set<string>([parentSessionId])
    const queue = [...(byParent.get(parentSessionId) || [])]
    while (queue.length > 0) {
      const child = queue.shift()
      if (!child || seen.has(child.id)) continue
      seen.add(child.id)
      children.push(child)
      queue.push(...(byParent.get(child.id) || []))
    }
    return { children, complete: true }
  }

  async function loadSessionHistory(sessionId: string, options: LoadSessionHistoryOptions = {}) {
    const includeChildGraph = options.includeChildren !== false
    const includeChildTranscripts = includeChildGraph && options.includeChildTranscripts !== false
    return measureAsyncPerf(includeChildTranscripts ? 'session.history.load' : 'session.history.load.root', async () => {
      const { client, questionClient, record } = await deps.getSessionClient(sessionId)
      const [
        rootMessagesResult,
        rootTodosResult,
        statusResult,
        questionResult,
        permissionResult,
        sessionInfoResult,
      ] = await Promise.all([
        listNativeSessionMessages(client, sessionId),
        // OpenCode 1.17.20 has no native `/api/session/:id/todo` equivalent.
        // Keep its current classic `/session/:id/todo` API because omitting it
        // would break todo reopen parity; this is an explicit native-v2 gap.
        client.session.todo({ sessionID: sessionId }, { throwOnError: true }).catch((err) => {
          logHistoryError('session:messages todo', sessionId, err)
          return { data: [] }
        }),
        listNativeActiveSessionIds(client).catch((err) => {
          logHistoryError('session:messages status', sessionId, err)
          return null as Set<string> | null
        }),
        deps.listPendingQuestions(questionClient).then((result) => ({
          complete: true,
          result,
        })).catch((err: unknown) => {
          logHistoryError('session:messages questions', sessionId, err)
          return { complete: false, result: { data: [] } }
        }),
        deps.listPendingPermissions(questionClient).then((result) => ({
          complete: true,
          result,
        })).catch((err: unknown) => {
          logHistoryError('session:messages permissions', sessionId, err)
          return { complete: false, result: { data: [] } }
        }),
        // Pull SDK-owned session fields (summary, revert, parentID) so the
        // sidebar chip + header linkage stay in sync with what OpenCode knows
        // without needing an extra round-trip from the renderer.
        getNativeSession(client, sessionId).catch((err) => {
          logHistoryError('session:messages get', sessionId, err)
          return null
        }),
      ])

      const rootMessages = normalizeSessionMessages(rootMessagesResult)
      const rootTodos = readRecordArray({ value: readResponseData(rootTodosResult) }, 'value')
      const childGraph = includeChildGraph
        ? await loadChildSessionsRecursive(
            client,
            sessionId,
            record?.opencodeDirectory || getRuntimeHomeDir(),
          )
        : { children: [], complete: true }
      const children = childGraph.children
      const descendantSessionIds = new Set([sessionId, ...children.map((child) => child.id)])
      const statuses = Object.fromEntries(
        Array.from(descendantSessionIds, (id) => [id, {
          type: statusResult ? (statusResult.has(id) ? 'busy' : 'idle') : null,
        }]),
      )
      const questions = normalizePendingQuestions(readResponseData(questionResult.result), sessionId, descendantSessionIds)
      const approvals = normalizePendingApprovals(readResponseData(permissionResult.result), sessionId, descendantSessionIds)
      const cachedModelId = deps.getCachedModelId()
      const projectedChildren = includeChildTranscripts ? children : []
      const childSnapshotLoader = createBoundedChildSnapshotLoader({
        ids: projectedChildren.map((child) => child.id),
        concurrency: CHILD_SNAPSHOT_PREFETCH_CONCURRENCY,
        load: async (childId) => {
          const [result, childTodoResult] = await Promise.all([
            listNativeSessionMessages(client, childId),
            // Same explicit native-v2 capability gap as the root todo load.
            client.session.todo({ sessionID: childId }, { throwOnError: true }).catch((err) => {
              logHistoryError('session:messages child todo', childId, err)
              return { data: [] }
            }),
          ])
          return {
            messages: normalizeSessionMessages(result),
            todos: readRecordArray({ value: readResponseData(childTodoResult) }, 'value'),
          }
        },
      })
      if (includeChildTranscripts) {
        childSnapshotLoader.prefetch()
      }

      const items = await deps.projectSessionHistory({
        sessionId,
        cachedModelId,
        rootMessages,
        rootTodos,
        children: projectedChildren,
        statuses,
        loadChildSnapshot: childSnapshotLoader.load,
        fallbackTimestampMs: record ? Date.parse(record.createdAt) : 0,
      })
      const childLineage = buildChildLineageSeeds(sessionId, children, items)
      const latestModeledItem = [...items]
        .reverse()
        .find((item) => item.providerId || item.modelId) || null
      if (latestModeledItem) {
        deps.updateSessionRecord(sessionId, {
          providerId: latestModeledItem.providerId || null,
          modelId: latestModeledItem.modelId || null,
        })
      }
      const sessionInfo = normalizeSessionInfo(sessionInfoResult)
      if (sessionInfo) {
        let title = sessionInfo.title
        if (isDefaultSdkSessionTitle(title)) {
          const fallbackTitle = nonDefaultPersistedSessionTitle(record?.title)
            || fallbackSessionTitleFromHistory(rootMessages)
          if (fallbackTitle) {
            try {
              // Session V2 has no title/update endpoint in 1.17.20.
              await client.session.update(
                { sessionID: sessionId, title: fallbackTitle },
                { throwOnError: true },
              )
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
      return {
        items,
        questions,
        approvals,
        childGraphComplete: childGraph.complete,
        pendingQuestionsComplete: questionResult.complete,
        pendingApprovalsComplete: permissionResult.complete,
        childLineage,
      }
    }, {
      slowThresholdMs: includeChildTranscripts ? 250 : 100,
      slowData: {
        sessionId: shortSessionId(sessionId),
        includeChildGraph,
        includeChildTranscripts,
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
        const {
          items,
          questions,
          approvals,
          childGraphComplete,
          pendingQuestionsComplete,
          pendingApprovalsComplete,
          childLineage,
        } = await loadSessionHistory(sessionId, {
          includeChildren: true,
          includeChildTranscripts: !progressive,
        })
        deps.seedChildSessionLineage?.(sessionId, childLineage)
        deps.sessionEngine.setSessionFromHistory(sessionId, items, {
          force: options?.force,
        })
        const currentView = deps.sessionEngine.getSessionView(sessionId)
        const questionPreserveMode = !pendingQuestionsComplete
          ? 'all'
          : childGraphComplete ? 'none' : 'children'
        const approvalPreserveMode = !pendingApprovalsComplete
          ? 'all'
          : childGraphComplete ? 'none' : 'children'
        deps.sessionEngine.setPendingQuestions(
          sessionId,
          mergePendingQuestions(questions, currentView.pendingQuestions || [], sessionId, questionPreserveMode),
        )
        deps.sessionEngine.setPendingApprovals(
          sessionId,
          mergePendingApprovals(approvals, currentView.pendingApprovals || [], sessionId, approvalPreserveMode),
        )
        const hydrationComplete = childGraphComplete
          && pendingQuestionsComplete
          && pendingApprovalsComplete
        if (progressive || !hydrationComplete) {
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
          // Session V2 has no diff endpoint in 1.17.20.
          const diffResult = await client.session.diff({
            sessionID: sessionId,
          }, { throwOnError: true }).catch((err) => {
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
      try {
        await sessionHistoryViewIndexHandler?.({ sessionId, view })
      } catch (err) {
        logHistoryError('session:index artifacts', sessionId, err)
      }
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
