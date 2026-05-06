// Aggregate diff stats for a session, mirroring SDK Session.summary (additions
// + deletions + file count across the session's snapshot diff). Distinct from
// SessionUsageSummary below, which is our product-side cost/token rollup.
export interface SessionChangeSummary {
  additions: number
  deletions: number
  files: number
}

// Per-file diff entry, mirroring SDK SnapshotFileDiff. `patch` is a unified
// diff (git-style hunks) produced by OpenCode's snapshot engine.
export interface SessionFileDiff {
  file: string
  patch: string
  additions: number
  deletions: number
  status?: 'added' | 'deleted' | 'modified'
}

export interface SessionInfo {
  id: string
  title?: string
  directory?: string | null
  createdAt: string
  updatedAt: string
  kind?: 'interactive' | 'automation'
  automationId?: string | null
  runId?: string | null
  // Parent session when this was created via session:fork. Stable once set.
  parentSessionId?: string | null
  // Condensed diff summary (no per-file patches) from SDK Session.summary.
  // Refreshed when we call session.get; sidebar renders without a full diff.
  changeSummary?: SessionChangeSummary | null
  // When present, the session is currently reverted to the message with this
  // id. Cleared on unrevert. From SDK Session.revert.messageID.
  revertedMessageId?: string | null
}

export interface SessionChildInfo {
  id: string
  title?: string
  directory?: string | null
  createdAt?: string
  updatedAt?: string
  parentID?: string | null
  parentId?: string | null
  parentSessionId?: string | null
  time?: {
    created?: number
    updated?: number
  }
}

export type DashboardTimeRangeKey = 'last7d' | 'last30d' | 'ytd' | 'all'

// Usage attributed to a single sub-agent across the aggregation window.
// Populated by summing task runs whose `agent` matches the entry's name.
// The primary orchestrator is represented as `agent: null` when we want
// to attribute everything not routed through a sub-agent task.
export interface AgentUsageEntry {
  agent: string | null
  taskRuns: number
  cost: number
  tokens: SessionTokens
}

export interface SessionUsageSummary {
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
  // Per-agent cost/token breakdown. Optional so older persisted summaries
  // (without the field) keep deserialising — the dashboard recomputes on
  // backfill so stale summaries gain the breakdown automatically.
  agentBreakdown?: AgentUsageEntry[]
}

export interface DashboardTimeRange {
  key: DashboardTimeRangeKey
  label: string
  startAt: string | null
  endAt: string
}

export interface DashboardSessionSummary extends SessionInfo {
  providerId?: string | null
  modelId?: string | null
  usage: SessionUsageSummary
}

export interface DashboardSummary {
  range: DashboardTimeRange
  totals: SessionUsageSummary & { threads: number }
  recentSessions: DashboardSessionSummary[]
  // Aggregated per-agent usage across the window, sorted by cost desc.
  // Named agents only — the primary orchestrator ("build"/"plan") rolls
  // up under `agent: null` so it doesn't dominate the chart.
  topAgents: AgentUsageEntry[]
  generatedAt: string
  backfilledSessions: number
  // Sessions whose usage summaries could not be reconstructed THIS CALL.
  // The dashboard surfaces a subtle warning chip so users know totals
  // may be understated until the underlying error is resolved. Distinct
  // from `backfillPendingCount`, which tracks sessions still being drained
  // on a background queue after the main response returned.
  backfillFailedCount?: number
  backfillPendingCount?: number
}

export interface MessageAttachment {
  mime: string
  url: string
  filename?: string
}

export interface MessageSegment {
  id: string
  content: string
  order: number
}

export interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  attachments?: MessageAttachment[]
  segments?: MessageSegment[]
  timestamp?: string | null
  providerId?: string | null
  modelId?: string | null
  order: number
}

export interface ToolCall {
  id: string
  name: string
  input: Record<string, unknown>
  status: 'running' | 'complete' | 'error'
  output?: unknown
  attachments?: MessageAttachment[]
  agent?: string | null
  sourceSessionId?: string | null
  order: number
}

export interface CompactionNotice {
  id: string
  status: 'compacting' | 'compacted'
  auto: boolean
  overflow: boolean
  sourceSessionId?: string | null
  order: number
}

export interface TaskTranscriptSegment {
  id: string
  content: string
  order: number
}

export interface TodoItem {
  content: string
  status: string
  priority: string
  id?: string
}

export interface ExecutionPlanItem {
  content: string
  status: string
  priority: string
  id?: string
}

export interface SessionTokens {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export interface TaskRun {
  id: string
  title: string
  agent: string | null
  status: 'queued' | 'running' | 'complete' | 'error'
  sourceSessionId: string | null
  // The session id of the task that spawned this one, when a sub-agent
  // delegates further. Lets the orchestration UI render a 2-level tree
  // (root task → spawned child). Null for tasks launched directly by
  // the primary agent. Resolved from OpenCode `session.created.parentID`
  // in the main process via `event-task-state.ts` lineage tracking.
  parentSessionId?: string | null
  content: string
  transcript: TaskTranscriptSegment[]
  toolCalls: ToolCall[]
  compactions: CompactionNotice[]
  todos: TodoItem[]
  error: string | null
  sessionCost: number
  sessionTokens: SessionTokens
  order: number
  // ISO timestamps for the elapsed-clock UX. Main-process live events set
  // startedAt when the task is first registered/observed and finishedAt when
  // it reaches `complete` or `error`. Both are optional so older persisted
  // state without these fields keeps deserializing.
  startedAt?: string | null
  finishedAt?: string | null
}

export interface PendingApproval {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
  order: number
}

export interface QuestionOption {
  label: string
  description: string
}

export interface PendingQuestionPrompt {
  header: string
  question: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export interface PendingQuestion {
  id: string
  sessionId: string
  sourceSessionId?: string | null
  questions: PendingQuestionPrompt[]
  tool?: {
    messageId: string
    callId: string
  }
}

export interface SessionError {
  id: string
  sessionId: string | null
  message: string
  order: number
}

export interface SessionView {
  messages: Message[]
  toolCalls: ToolCall[]
  taskRuns: TaskRun[]
  compactions: CompactionNotice[]
  pendingApprovals: PendingApproval[]
  pendingQuestions: PendingQuestion[]
  errors: SessionError[]
  todos: TodoItem[]
  executionPlan: ExecutionPlanItem[]
  sessionCost: number
  sessionTokens: SessionTokens
  lastInputTokens: number
  contextState: 'idle' | 'measured' | 'compacting' | 'compacted'
  compactionCount: number
  lastCompactedAt: string | null
  activeAgent: string | null
  lastItemWasTool: boolean
  revision: number
  lastEventAt: number
  isGenerating: boolean
  isAwaitingPermission: boolean
  isAwaitingQuestion: boolean
}

export interface SessionMessageTextPatch {
  type: 'message_text'
  sessionId: string
  messageId: string
  segmentId: string
  content: string
  mode: 'append' | 'replace'
  role?: 'user' | 'assistant'
  attachments?: MessageAttachment[]
  eventAt: number
}

export interface SessionTaskTextPatch {
  type: 'task_text'
  sessionId: string
  taskRunId: string
  segmentId: string
  content: string
  mode: 'append' | 'replace'
  eventAt: number
}

export type SessionPatch = SessionMessageTextPatch | SessionTaskTextPatch

export interface RuntimeNotification {
  type: 'done' | 'error'
  sessionId?: string | null
  synthetic?: boolean
  message?: string
}
