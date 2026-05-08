import type {
  PendingApproval,
  PendingQuestion,
  SessionError,
  SessionView,
  TodoItem,
} from '@open-cowork/shared'
import {
  MAX_WARM_SESSION_DETAILS,
  beginCompactionNotice,
  buildSessionStateFromItems,
  deriveVisibleSessionPatch,
  finishCompactionNotice,
  getOrCreateSessionState,
  nextSeq,
  nowTs,
  pruneSessionDetailCache,
  refreshContextState,
  upsertTaskRunList,
  withMessageText,
  withTaskRun,
  withTaskTranscript,
  type HistoryItem,
  type SessionViewState,
} from '../lib/session-view-model.ts'
import type { RuntimeSessionEvent } from './session-event-dispatcher.ts'
import type { SessionUsageSummary } from '@open-cowork/shared'
import { buildSessionUsageSummary } from './session-usage-summary.ts'
import { SessionCostEventTracker } from './session-cost-event-tracker.ts'
import { createRootToolCall, getLatestHistoryEventAt } from './session-engine-helpers.ts'
import { applyCostEventToSessionState } from './session-engine-costs.ts'
import {
  buildPendingApproval,
  buildPendingQuestion,
  buildTaskRunUpdate,
  normalizeToolStatus,
} from './session-engine-events.ts'

export { MAX_SEEN_COST_EVENT_IDS_PER_SESSION } from './session-cost-event-tracker.ts'

type CachedSessionView = {
  revision: number
  lastEventAt: number
  busy: boolean
  awaitingPermission: boolean
  view: SessionView
}

export class SessionEngine {
  private sessionStateById: Record<string, SessionViewState> = {}
  private busySessions = new Set<string>()
  private awaitingPermissionSessions = new Set<string>()
  private currentSessionId: string | null = null
  private viewCacheById = new Map<string, CachedSessionView>()
  private costEventTracker = new SessionCostEventTracker()

  private invalidateView(sessionId: string) {
    this.viewCacheById.delete(sessionId)
  }

  private maybePrune() {
    const keepBudget = MAX_WARM_SESSION_DETAILS
      + this.busySessions.size
      + (this.currentSessionId ? 1 : 0)
    if (Object.keys(this.sessionStateById).length <= keepBudget) return
    this.sessionStateById = pruneSessionDetailCache(this.sessionStateById, this.currentSessionId, this.busySessions)
  }

  activateSession(sessionId: string) {
    this.currentSessionId = sessionId
    const existing = this.sessionStateById[sessionId] || getOrCreateSessionState(this.sessionStateById, sessionId)
    const hadSession = Boolean(this.sessionStateById[sessionId])
    this.sessionStateById[sessionId] = {
      ...existing,
      lastViewedAt: nowTs(),
    }
    if (!hadSession) {
      this.maybePrune()
    }
  }

  isHydrated(sessionId: string) {
    return Boolean(this.sessionStateById[sessionId]?.hydrated)
  }

  setSessionFromHistory(
    sessionId: string,
    items: HistoryItem[],
    options?: { force?: boolean },
  ) {
    const existing = this.sessionStateById[sessionId]
    if (existing?.hydrated && !options?.force) {
      return
    }
    const preserveStreamingState = Boolean(
      existing
      && existing.lastEventAt > 0
      && existing.lastEventAt > getLatestHistoryEventAt(items),
    )
    const next = buildSessionStateFromItems(items, existing, {
      preserveStreamingState,
    })
    const hadSession = Boolean(this.sessionStateById[sessionId])
    this.sessionStateById[sessionId] = next
    this.invalidateView(sessionId)
    if (!hadSession) {
      this.maybePrune()
    }
  }

  getSessionView(sessionId: string): SessionView {
    const state = getOrCreateSessionState(this.sessionStateById, sessionId)
    const busy = this.busySessions.has(sessionId)
    const awaitingPermission = this.awaitingPermissionSessions.has(sessionId)
    const cached = this.viewCacheById.get(sessionId)
    if (
      cached
      && cached.revision === state.revision
      && cached.lastEventAt === state.lastEventAt
      && cached.busy === busy
      && cached.awaitingPermission === awaitingPermission
    ) {
      return cached.view
    }

    const view = deriveVisibleSessionPatch(state, sessionId, this.busySessions, this.awaitingPermissionSessions)
    this.viewCacheById.set(sessionId, {
      revision: state.revision,
      lastEventAt: state.lastEventAt,
      busy,
      awaitingPermission,
      view,
    })
    return view
  }

  getSessionMeta(sessionId: string) {
    const state = getOrCreateSessionState(this.sessionStateById, sessionId)
    return {
      revision: state.revision,
      lastEventAt: state.lastEventAt,
    }
  }

  getSessionUsageSummary(sessionId: string): SessionUsageSummary | null {
    const state = this.sessionStateById[sessionId]
    if (!state?.hydrated) return null
    return buildSessionUsageSummary(this.getSessionView(sessionId))
  }

  removeSession(sessionId: string) {
    const next = { ...this.sessionStateById }
    delete next[sessionId]
    this.sessionStateById = next
    this.invalidateView(sessionId)
    this.costEventTracker.forgetSession(sessionId)
    this.busySessions.delete(sessionId)
    this.awaitingPermissionSessions.delete(sessionId)
    if (this.currentSessionId === sessionId) {
      this.currentSessionId = null
    }
  }

  addApproval(approval: Omit<PendingApproval, 'order'>) {
    this.awaitingPermissionSessions.add(approval.sessionId)
    this.invalidateView(approval.sessionId)
    this.updateSessionState(approval.sessionId, (current) => ({
      ...current,
      pendingApprovals: [
        ...current.pendingApprovals.filter((entry) => entry.id !== approval.id),
        { ...approval, order: nextSeq() },
      ],
    }))
  }

  setPendingApprovals(sessionId: string, approvals: Omit<PendingApproval, 'order'>[]) {
    if (approvals.length > 0) {
      this.awaitingPermissionSessions.add(sessionId)
    } else {
      this.awaitingPermissionSessions.delete(sessionId)
    }
    this.invalidateView(sessionId)
    this.updateSessionState(sessionId, (current) => {
      const existingById = new Map(current.pendingApprovals.map((approval) => [approval.id, approval]))
      return {
        ...current,
        pendingApprovals: approvals.map((approval) => {
          const existing = existingById.get(approval.id)
          return {
            ...approval,
            order: existing?.order ?? nextSeq(),
          }
        }),
      }
    })
  }

  resolveApproval(id: string) {
    let resolvedSessionId: string | null = null
    for (const [sessionId, current] of Object.entries(this.sessionStateById)) {
      const nextApprovals = current.pendingApprovals.filter((entry) => entry.id !== id)
      if (nextApprovals.length === current.pendingApprovals.length) continue
      resolvedSessionId = sessionId
      this.updateSessionState(sessionId, () => ({
        ...current,
        pendingApprovals: nextApprovals,
      }))
      if (nextApprovals.length === 0) {
        this.awaitingPermissionSessions.delete(sessionId)
        this.invalidateView(sessionId)
      }
      break
    }
    return resolvedSessionId
  }

  setPendingQuestions(sessionId: string, questions: PendingQuestion[]) {
    this.updateSessionState(sessionId, (current) => ({
      ...current,
      pendingQuestions: questions,
    }))
  }

  applyStreamEvent(event: RuntimeSessionEvent) {
    const sessionId = event.sessionId
    const data = event.data
    if (!sessionId || !data?.type) return

    switch (data.type) {
      case 'text':
        this.updateSessionState(sessionId, (current) => {
          if (data.taskRunId) {
            return {
              ...current,
              taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
                ...withTaskTranscript(taskRun, data.partId || data.messageId || `${data.taskRunId}:live`, data.content || '', {
                  replace: data.mode === 'replace',
                }),
              })),
              lastItemWasTool: true,
            }
          }
          return {
            ...current,
            ...withMessageText(current, {
              messageId: data.messageId || `${sessionId}:assistant:live`,
              role: data.role === 'user' ? 'user' : 'assistant',
              content: data.content || '',
              segmentId: data.partId || data.messageId || `${sessionId}:segment:live`,
              attachments: data.attachments,
              replace: data.mode === 'replace',
            }),
            lastItemWasTool: false,
          }
        })
        break
      case 'tool_call':
        this.updateSessionState(sessionId, (current) => {
          const toolId = typeof data.id === 'string' ? data.id : `${sessionId}:tool:${nowTs()}`
          const toolStatus = normalizeToolStatus(data.status)
          const toolName = typeof data.name === 'string' ? data.name : undefined
          if (data.taskRunId) {
            return {
              ...current,
              taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => {
                const existing = taskRun.toolCalls.find((tool) => tool.id === toolId)
                const nextTool = createRootToolCall(toolId, {
                  name: toolName,
                  input: data.input,
                  status: toolStatus,
                  output: data.output,
                  attachments: data.attachments,
                  agent: data.agent || taskRun.agent,
                  sourceSessionId: data.sourceSessionId || taskRun.sourceSessionId,
                })
                return {
                  ...taskRun,
                  toolCalls: existing
                    ? taskRun.toolCalls.map((tool) => tool.id === toolId ? { ...tool, ...nextTool, order: tool.order } : tool)
                    : [...taskRun.toolCalls, { ...nextTool, order: nextSeq() }],
                }
              }),
              lastItemWasTool: true,
            }
          }

          const existing = current.toolCalls.find((tool) => tool.id === toolId)
          const nextTool = createRootToolCall(toolId, {
            name: toolName,
            input: data.input,
            status: toolStatus,
            output: data.output,
            attachments: data.attachments,
            agent: data.agent,
            sourceSessionId: data.sourceSessionId,
          })
          return {
            ...current,
            toolCalls: existing
              ? current.toolCalls.map((tool) => tool.id === toolId ? { ...tool, ...nextTool, order: tool.order } : tool)
              : [...current.toolCalls, { ...nextTool, order: nextSeq() }],
            lastItemWasTool: true,
          }
        })
        break
      case 'task_run':
        this.updateSessionState(sessionId, (current) => ({
          ...current,
          taskRuns: upsertTaskRunList(current.taskRuns, buildTaskRunUpdate(sessionId, data)),
          lastItemWasTool: true,
        }))
        break
      case 'cost':
        if (!this.costEventTracker.mark(sessionId, typeof data.id === 'string' ? data.id : null)) {
          break
        }
        this.updateSessionState(sessionId, (current) => applyCostEventToSessionState(current, data))
        break
      case 'agent':
        this.updateSessionState(sessionId, (current) => ({
          ...current,
          activeAgent: data.name || current.activeAgent,
        }))
        break
      case 'todos':
        this.updateSessionState(sessionId, (current) => {
          if (data.taskRunId) {
            return {
              ...current,
              taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
                ...taskRun,
                todos: (data.todos || []) as TodoItem[],
              })),
            }
          }
          return {
            ...current,
            todos: (data.todos || []) as TodoItem[],
          }
        })
        break
      case 'compaction':
        this.updateSessionState(sessionId, (current) => {
          if (data.taskRunId) {
            return {
              ...current,
              taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
                ...taskRun,
                compactions: beginCompactionNotice(taskRun.compactions, {
                  id: data.id || undefined,
                  auto: data.auto,
                  overflow: data.overflow,
                  sourceSessionId: data.sourceSessionId || taskRun.sourceSessionId,
                }),
              })),
              lastItemWasTool: true,
            }
          }
          return {
            ...current,
            compactions: beginCompactionNotice(current.compactions, {
              id: data.id || undefined,
              auto: data.auto,
              overflow: data.overflow,
              sourceSessionId: data.sourceSessionId || null,
            }),
            contextState: 'compacting',
            lastItemWasTool: true,
          }
        })
        break
      case 'compacted':
        this.updateSessionState(sessionId, (current) => {
          if (data.taskRunId) {
            const taskRuns = withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
              ...taskRun,
              compactions: finishCompactionNotice(taskRun.compactions, {
                id: data.id || undefined,
                auto: data.auto,
                overflow: data.overflow,
                sourceSessionId: data.sourceSessionId || taskRun.sourceSessionId,
              }),
            }))
            return {
              ...current,
              taskRuns,
              lastItemWasTool: true,
            }
          }
          const compactions = finishCompactionNotice(current.compactions, {
            id: data.id || undefined,
            auto: data.auto,
            overflow: data.overflow,
            sourceSessionId: data.sourceSessionId || null,
          })
          const next = {
            ...current,
            compactions,
            compactionCount: current.compactionCount + 1,
            lastCompactedAt: data.completedAt || new Date().toISOString(),
            lastItemWasTool: true,
          }
          next.contextState = refreshContextState(next)
          return next
        })
        break
      case 'busy':
        this.busySessions.add(sessionId)
        this.awaitingPermissionSessions.delete(sessionId)
        this.invalidateView(sessionId)
        break
      case 'awaiting_permission':
        this.awaitingPermissionSessions.add(sessionId)
        this.invalidateView(sessionId)
        break
      case 'done':
        this.busySessions.delete(sessionId)
        this.awaitingPermissionSessions.delete(sessionId)
        this.invalidateView(sessionId)
        this.updateSessionState(sessionId, (current) => ({
          ...current,
          activeAgent: null,
        }))
        break
      case 'error':
        this.busySessions.delete(sessionId)
        this.awaitingPermissionSessions.delete(sessionId)
        this.invalidateView(sessionId)
        this.updateSessionState(sessionId, (current) => {
          const nextError: SessionError = {
            id: crypto.randomUUID(),
            sessionId,
            message: data.message || 'An error occurred',
            order: nextSeq(),
          }
          if (data.taskRunId) {
            return {
              ...current,
              taskRuns: withTaskRun(current.taskRuns, data.taskRunId, (taskRun) => ({
                ...taskRun,
                error: nextError.message,
                status: 'error',
              })),
              errors: [...current.errors, nextError],
            }
          }
          return {
            ...current,
            errors: [...current.errors, nextError],
          }
        })
        break
      case 'approval':
        this.addApproval(buildPendingApproval(sessionId, data))
        break
      case 'question_asked':
        this.updateSessionState(sessionId, (current) => {
          const nextQuestion = buildPendingQuestion(sessionId, data)
          return {
            ...current,
            pendingQuestions: current.pendingQuestions.some((question) => question.id === nextQuestion.id)
              ? current.pendingQuestions.map((question) => question.id === nextQuestion.id ? nextQuestion : question)
              : [...current.pendingQuestions, nextQuestion],
          }
        })
        break
      case 'question_resolved':
        this.updateSessionState(sessionId, (current) => ({
          ...current,
          pendingQuestions: current.pendingQuestions.filter((question) => question.id !== data.id),
        }))
        break
      case 'approval_resolved':
        if (typeof data.id === 'string') {
          this.resolveApproval(data.id)
        }
        break
      default:
        break
    }
  }

  private updateSessionState(sessionId: string, updater: (current: SessionViewState) => SessionViewState) {
    const hadSession = Boolean(this.sessionStateById[sessionId])
    const current = this.sessionStateById[sessionId] || getOrCreateSessionState(this.sessionStateById, sessionId)
    const updated = updater(current)
    this.sessionStateById[sessionId] = {
      ...updated,
      revision: current.revision + 1,
      lastEventAt: nowTs(),
    }
    this.invalidateView(sessionId)
    if (!hadSession) {
      this.maybePrune()
    }
  }
}

export const sessionEngine = new SessionEngine()
