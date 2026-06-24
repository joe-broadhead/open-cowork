import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import type {
  ArtifactIndexEntry,
  ArtifactIndexPayload,
  CoordinationBoardPayload,
  CoordinationTask,
  LaunchpadFeedPayload,
  LaunchpadFeedRequest,
  LaunchpadFreshArtifactItem,
  LaunchpadInProgressItem,
  LaunchpadWaitingItem,
  SessionView,
} from '@open-cowork/shared'
import { cloudSessionViewToSessionView, type CloudSessionViewRecord } from '@open-cowork/shared'
import { listLocalArtifactIndex } from '../artifact-index.js'
import {
  listCoordinationBoard,
  listCoordinationProjects,
  listCoordinationTasks,
} from '../coordination/coordination-service.js'
import { sessionEngine } from '../session-engine.js'
import { syncSessionView } from '../session-history-loader.js'
import { listSessionRecords, type SessionRecord } from '../session-registry.js'

const LOCAL_WORKSPACE_ID = 'local'
const DEFAULT_SECTION_LIMIT = 8
const MAX_SECTION_LIMIT = 50
const DEFAULT_SESSION_SCAN_LIMIT = 100
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'cancelled'])

export type LaunchpadSessionSnapshot = {
  sessionId: string
  title?: string | null
  createdAt?: string | null
  updatedAt?: string | null
  runId?: string | null
  view: SessionView | null
}

type LaunchpadSourceInput = {
  request?: LaunchpadFeedRequest
  workspaceId?: string | null
  board: CoordinationBoardPayload
  sessions: LaunchpadSessionSnapshot[]
  sessionsTruncated?: boolean | null
  artifacts: ArtifactIndexEntry[]
  artifactTotal?: number | null
  artifactTruncated?: boolean | null
  generatedAt?: string
}

type LaunchpadRuntimeDeps = {
  listSessionRecords: typeof listSessionRecords
  isHydrated: (sessionId: string) => boolean
  getSessionView: (sessionId: string) => SessionView
  syncSessionView: typeof syncSessionView
  listCoordinationBoard: typeof listCoordinationBoard
  listCoordinationProjects: typeof listCoordinationProjects
  listCoordinationTasks: typeof listCoordinationTasks
  listArtifactIndex: typeof listLocalArtifactIndex
  nowIso: () => string
}

let runtimeDepsForTests: LaunchpadRuntimeDeps | null = null

function runtimeDeps(): LaunchpadRuntimeDeps {
  return runtimeDepsForTests || {
    listSessionRecords,
    isHydrated: (sessionId) => sessionEngine.isHydrated(sessionId),
    getSessionView: (sessionId) => sessionEngine.getSessionView(sessionId),
    syncSessionView,
    listCoordinationBoard,
    listCoordinationProjects,
    listCoordinationTasks,
    listArtifactIndex: listLocalArtifactIndex,
    nowIso: () => new Date().toISOString(),
  }
}

export function setLaunchpadRuntimeDepsForTests(deps: LaunchpadRuntimeDeps | null) {
  runtimeDepsForTests = deps
}

function workspaceId(value: string | null | undefined) {
  const trimmed = value?.trim()
  return trimmed || LOCAL_WORKSPACE_ID
}

function normalizeLimit(value: unknown, fallback = DEFAULT_SECTION_LIMIT) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) return fallback
  return Math.min(MAX_SECTION_LIMIT, Math.max(1, Math.floor(number)))
}

function sectionLimits(request: LaunchpadFeedRequest = {}) {
  const base = normalizeLimit(request.limit)
  return {
    inProgress: normalizeLimit(request.inProgressLimit, base),
    waitingOnYou: normalizeLimit(request.waitingLimit, base),
    freshArtifacts: normalizeLimit(request.artifactsLimit, base),
  }
}

function timestampMs(value: string | null | undefined) {
  const ms = value ? new Date(value).getTime() : NaN
  return Number.isFinite(ms) ? ms : 0
}

function compareNewest(left: { when: string; updatedAt?: string | null }, right: { when: string; updatedAt?: string | null }) {
  return timestampMs(right.when || right.updatedAt) - timestampMs(left.when || left.updatedAt)
}

function projectTitle(board: CoordinationBoardPayload, projectId: string | null | undefined) {
  if (!projectId) return null
  return board.projects.find((project) => project.id === projectId)?.title || null
}

function tasksByWork(board: CoordinationBoardPayload) {
  const byId = new Map<string, CoordinationTask>()
  const bySession = new Map<string, CoordinationTask>()
  const byRun = new Map<string, CoordinationTask>()
  for (const task of board.tasks) {
    byId.set(task.id, task)
    if (task.assignedSessionId) bySession.set(task.assignedSessionId, task)
    if (task.assignedRunId) byRun.set(task.assignedRunId, task)
  }
  return { byId, bySession, byRun }
}

function taskForWork(
  maps: ReturnType<typeof tasksByWork>,
  options: { taskId?: string | null; sessionId?: string | null; runId?: string | null },
) {
  if (options.taskId && maps.byId.has(options.taskId)) return maps.byId.get(options.taskId) || null
  if (options.runId && maps.byRun.has(options.runId)) return maps.byRun.get(options.runId) || null
  if (options.sessionId && maps.bySession.has(options.sessionId)) return maps.bySession.get(options.sessionId) || null
  if (options.runId?.startsWith('child:')) {
    const childSessionId = options.runId.slice('child:'.length)
    if (maps.bySession.has(childSessionId)) return maps.bySession.get(childSessionId) || null
  }
  return null
}

function taskMatchesProject(task: CoordinationTask | null, projectId: string | null | undefined) {
  return !projectId || task?.projectId === projectId
}

function isTaskInProgress(task: CoordinationTask) {
  if (task.status === 'running') return true
  if (task.column !== 'doing') return false
  return !TERMINAL_TASK_STATUSES.has(task.status)
}

function inProgressItem(board: CoordinationBoardPayload, task: CoordinationTask): LaunchpadInProgressItem {
  return {
    id: task.id,
    kind: 'task',
    title: task.title,
    projectId: task.projectId,
    projectTitle: projectTitle(board, task.projectId),
    taskId: task.id,
    taskTitle: task.title,
    sessionId: task.assignedSessionId || null,
    runId: task.assignedRunId || null,
    assigneeAgent: task.assigneeAgent || null,
    status: task.status,
    priority: task.priority,
    when: task.updatedAt,
    updatedAt: task.updatedAt,
  }
}

function waitingItemsForSession(
  board: CoordinationBoardPayload,
  maps: ReturnType<typeof tasksByWork>,
  snapshot: LaunchpadSessionSnapshot,
  projectId: string | null | undefined,
): LaunchpadWaitingItem[] {
  const view = snapshot.view
  if (!view) return []
  const items: LaunchpadWaitingItem[] = []
  const fallbackWhen = snapshot.updatedAt || snapshot.createdAt || new Date(0).toISOString()
  for (const approval of view.pendingApprovals || []) {
    const task = taskForWork(maps, {
      sessionId: approval.sessionId || snapshot.sessionId,
      runId: approval.taskRunId || snapshot.runId,
    })
    if (!taskMatchesProject(task, projectId)) continue
    const title = approval.description || `Permission requested for ${approval.tool || 'tool'}`
    items.push({
      id: `permission:${approval.sessionId || snapshot.sessionId}:${approval.id}`,
      kind: 'permission',
      status: 'pending',
      title,
      projectId: task?.projectId || null,
      projectTitle: projectTitle(board, task?.projectId),
      taskId: task?.id || null,
      taskTitle: task?.title || null,
      sessionId: approval.sessionId || snapshot.sessionId,
      runId: approval.taskRunId || snapshot.runId || null,
      assigneeAgent: task?.assigneeAgent || null,
      when: fallbackWhen,
      updatedAt: fallbackWhen,
    })
  }
  for (const question of view.pendingQuestions || []) {
    const task = taskForWork(maps, {
      sessionId: question.sourceSessionId || question.sessionId || snapshot.sessionId,
      runId: snapshot.runId,
    })
    if (!taskMatchesProject(task, projectId)) continue
    const prompt = question.questions?.[0]
    const title = prompt?.question || prompt?.header || 'Question waiting for answer'
    items.push({
      id: `question:${question.sessionId || snapshot.sessionId}:${question.id}`,
      kind: 'question',
      status: 'pending',
      title,
      projectId: task?.projectId || null,
      projectTitle: projectTitle(board, task?.projectId),
      taskId: task?.id || null,
      taskTitle: task?.title || null,
      sessionId: question.sessionId || snapshot.sessionId,
      runId: snapshot.runId || null,
      assigneeAgent: task?.assigneeAgent || null,
      when: fallbackWhen,
      updatedAt: fallbackWhen,
    })
  }
  return items
}

function artifactTitle(artifact: ArtifactIndexEntry) {
  return artifact.filename || artifact.sessionTitle || 'Artifact'
}

function localPathLike(value: string | null | undefined) {
  if (!value) return false
  return isAbsolute(value) || win32.isAbsolute(value)
}

function opaqueArtifactId(artifact: ArtifactIndexEntry) {
  const digest = createHash('sha256')
    .update(artifact.workspaceId || '')
    .update('\0')
    .update(artifact.sessionId)
    .update('\0')
    .update(artifact.id)
    .update('\0')
    .update(artifact.filePath || '')
    .digest('hex')
    .slice(0, 16)
  return `local-artifact-${digest}`
}

function publicArtifactId(artifact: ArtifactIndexEntry) {
  return artifact.cloudArtifactId || artifact.id
}

function launchpadArtifactId(artifact: ArtifactIndexEntry) {
  if (artifact.cloudArtifactId || artifact.source === 'cloud') return publicArtifactId(artifact)
  if (localPathLike(artifact.filePath)) return opaqueArtifactId(artifact)
  return publicArtifactId(artifact)
}

function freshArtifactItem(
  board: CoordinationBoardPayload,
  maps: ReturnType<typeof tasksByWork>,
  artifact: ArtifactIndexEntry,
): LaunchpadFreshArtifactItem {
  const publicId = launchpadArtifactId(artifact)
  const task = taskForWork(maps, {
    taskId: artifact.taskId,
    sessionId: artifact.sessionId,
    runId: artifact.taskRunId,
  })
  const taskProjectId = artifact.projectId || task?.projectId || null
  return {
    id: `artifact:${artifact.sessionId}:${publicId}`,
    artifactId: publicId,
    kind: artifact.kind || 'draft',
    status: artifact.status || 'draft',
    title: artifactTitle(artifact),
    projectId: taskProjectId,
    projectTitle: projectTitle(board, taskProjectId),
    taskId: artifact.taskId || task?.id || null,
    taskTitle: task?.title || null,
    sessionId: artifact.sessionId,
    runId: artifact.taskRunId || null,
    assigneeAgent: artifact.authorAgentId || task?.assigneeAgent || null,
    authorAgentId: artifact.authorAgentId || task?.assigneeAgent || null,
    when: artifact.updatedAt || artifact.createdAt || new Date(0).toISOString(),
    createdAt: artifact.createdAt || null,
    updatedAt: artifact.updatedAt || null,
  }
}

function cap<T>(items: T[], limit: number) {
  return {
    items: items.slice(0, limit),
    total: items.length,
    truncated: items.length > limit,
  }
}

export function buildLaunchpadFeedFromSources(input: LaunchpadSourceInput): LaunchpadFeedPayload {
  const request = input.request || {}
  const projectId = request.projectId || null
  const limits = sectionLimits(request)
  const maps = tasksByWork(input.board)
  const inProgressAll = input.board.tasks
    .filter((task) => isTaskInProgress(task))
    .filter((task) => !projectId || task.projectId === projectId)
    .map((task) => inProgressItem(input.board, task))
    .sort(compareNewest)
  const waitingAll = input.sessions
    .flatMap((snapshot) => waitingItemsForSession(input.board, maps, snapshot, projectId))
    .sort(compareNewest)
  const freshArtifactsAll = input.artifacts
    .map((artifact) => freshArtifactItem(input.board, maps, artifact))
    .filter((artifact) => !projectId || artifact.projectId === projectId)
    .sort(compareNewest)

  const inProgress = cap(inProgressAll, limits.inProgress)
  const waitingOnYou = cap(waitingAll, limits.waitingOnYou)
  const freshArtifacts = cap(freshArtifactsAll, limits.freshArtifacts)
  const sessionsTruncated = input.sessionsTruncated === true
  const displayedWaitingTotal = sessionsTruncated && waitingOnYou.total <= waitingOnYou.items.length
    ? waitingOnYou.items.length + 1
    : waitingOnYou.total
  const artifactIndexTruncated = input.artifactTruncated === true
  const artifactTotal = Math.max(input.artifactTotal ?? freshArtifactsAll.length, freshArtifactsAll.length)
  const displayedFreshTotal = artifactIndexTruncated && artifactTotal <= freshArtifacts.items.length
    ? freshArtifacts.items.length + 1
    : artifactTotal

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    inProgress: inProgress.items,
    waitingOnYou: waitingOnYou.items,
    freshArtifacts: freshArtifacts.items,
    totals: {
      inProgress: inProgress.total,
      waitingOnYou: displayedWaitingTotal,
      freshArtifacts: Math.max(freshArtifacts.total, displayedFreshTotal),
    },
    truncated: {
      inProgress: inProgress.truncated,
      waitingOnYou: waitingOnYou.truncated || sessionsTruncated,
      freshArtifacts: freshArtifacts.truncated || artifactIndexTruncated || artifactTotal > limits.freshArtifacts,
    },
  }
}

export function listLaunchpadCoordinationBoard(options: {
  workspaceId?: string | null
  projectId?: string | null
  limit?: number
}, deps = runtimeDeps()): CoordinationBoardPayload {
  const workspace = workspaceId(options.workspaceId)
  const limit = options.limit || 500
  const projectId = options.projectId?.trim() || null
  if (!projectId) {
    return deps.listCoordinationBoard({
      workspaceId: workspace,
      limit,
    })
  }
  return {
    projects: deps.listCoordinationProjects({
      workspaceId: workspace,
      limit,
    }).filter((project) => project.id === projectId),
    tasks: deps.listCoordinationTasks({
      workspaceId: workspace,
      projectId,
      limit,
    }),
  }
}

async function sessionSnapshot(record: SessionRecord, deps: LaunchpadRuntimeDeps): Promise<LaunchpadSessionSnapshot> {
  let view: SessionView | null
  if (deps.isHydrated(record.id)) {
    view = deps.getSessionView(record.id)
  } else {
    try {
      view = await deps.syncSessionView(record.id, { activate: false })
    } catch {
      view = null
    }
  }
  return {
    sessionId: record.id,
    title: record.title || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    runId: record.runId,
    view,
  }
}

export async function listLocalLaunchpadFeed(request: LaunchpadFeedRequest = {}): Promise<LaunchpadFeedPayload> {
  const deps = runtimeDeps()
  const workspace = workspaceId(request.workspaceId)
  const limits = sectionLimits(request)
  const board = listLaunchpadCoordinationBoard({
    workspaceId: workspace,
    projectId: request.projectId || null,
    limit: Math.max(500, limits.inProgress * 4),
  }, deps)
  const allRecords = deps.listSessionRecords()
  const records = allRecords.slice(0, DEFAULT_SESSION_SCAN_LIMIT)
  const sessions = await Promise.all(records.map((record) => sessionSnapshot(record, deps)))
  const artifactIndex: ArtifactIndexPayload = await deps.listArtifactIndex({
    workspaceId: workspace,
    projectId: request.projectId || null,
    taskIds: request.projectId ? board.tasks.map((task) => task.id) : null,
    limit: limits.freshArtifacts + 1,
  })
  return buildLaunchpadFeedFromSources({
    request,
    workspaceId: workspace,
    board,
    sessions,
    sessionsTruncated: allRecords.length > records.length,
    artifacts: artifactIndex.artifacts,
    artifactTotal: artifactIndex.total,
    artifactTruncated: artifactIndex.truncated,
    generatedAt: deps.nowIso(),
  })
}

export async function cloudLaunchpadSessionSnapshots(input: {
  sessions: Array<{ sessionId: string; title?: string | null; createdAt?: string | null; updatedAt?: string | null }>
  getSessionView: (sessionId: string) => Promise<CloudSessionViewRecord>
  limit?: number
}): Promise<LaunchpadSessionSnapshot[]> {
  const sessions = input.sessions.slice(0, input.limit || DEFAULT_SESSION_SCAN_LIMIT)
  const snapshots = await Promise.all(sessions.map(async (session) => {
    try {
      const cloudView = await input.getSessionView(session.sessionId)
      return {
        sessionId: session.sessionId,
        title: session.title || null,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        runId: null,
        view: cloudSessionViewToSessionView(cloudView),
      }
    } catch {
      return {
        sessionId: session.sessionId,
        title: session.title || null,
        createdAt: session.createdAt || null,
        updatedAt: session.updatedAt || null,
        runId: null,
        view: null,
      }
    }
  }))
  return snapshots
}
