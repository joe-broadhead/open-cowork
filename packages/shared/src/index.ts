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
  // Parent session when this was created via session:fork. Stable once set.
  parentSessionId?: string | null
  // Condensed diff summary (no per-file patches) from SDK Session.summary.
  // Refreshed when we call session.get; sidebar renders without a full diff.
  changeSummary?: SessionChangeSummary | null
  // When present, the session is currently reverted to the message with this
  // id. Cleared on unrevert. From SDK Session.revert.messageID.
  revertedMessageId?: string | null
}

export type DashboardTimeRangeKey = 'last7d' | 'last30d' | 'ytd' | 'all'

export interface SessionUsageSummary {
  messages: number
  userMessages: number
  assistantMessages: number
  toolCalls: number
  taskRuns: number
  cost: number
  tokens: SessionTokens
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
  generatedAt: string
  backfilledSessions: number
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
  content: string
  transcript: TaskTranscriptSegment[]
  toolCalls: ToolCall[]
  compactions: CompactionNotice[]
  todos: TodoItem[]
  error: string | null
  sessionCost: number
  sessionTokens: SessionTokens
  order: number
  // ISO timestamps for the live elapsed-clock UX. startedAt is set when the
  // task first enters the `running` state; finishedAt is set when it leaves
  // it (either `complete` or `error`). Both are optional so older persisted
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

export interface PerfCounterSnapshot {
  kind: 'counter'
  name: string
  value: number
  updatedAt: string
}

export interface PerfDistributionSnapshot {
  kind: 'distribution'
  name: string
  unit: 'ms' | 'count'
  count: number
  samplesTracked: number
  total: number
  avg: number
  min: number
  max: number
  p50: number
  p95: number
  last: number
  slowCount: number
  updatedAt: string
}

export interface PerfSnapshot {
  capturedAt: string
  counters: PerfCounterSnapshot[]
  distributions: PerfDistributionSnapshot[]
}

export interface RuntimeStatus {
  ready: boolean
  error?: string | null
}

export interface RuntimeInputDiagnostics {
  opencodeVersion: string | null
  providerId: string | null
  providerName: string | null
  providerPackage: string | null
  modelId: string | null
  runtimeModel: string | null
  defaultProviderId: string | null
  defaultModelId: string | null
  providerSource: 'settings' | 'default' | 'fallback'
  modelSource: 'settings' | 'default' | 'fallback'
  providerOptions: Record<string, unknown>
  credentialOverrideKeys: string[]
}

export interface ToolListOptions {
  sessionId?: string
  directory?: string | null
  provider?: string | null
  model?: string | null
}

export interface RuntimeContextOptions {
  sessionId?: string
  directory?: string | null
}

export interface SkillImportSelection {
  token: string
  directory: string
}

export interface SandboxStorageStats {
  root: string
  totalBytes: number
  workspaceCount: number
  referencedWorkspaceCount: number
  unreferencedWorkspaceCount: number
  staleWorkspaceCount: number
  staleThresholdDays: number
}

export interface SandboxCleanupResult {
  mode: 'old-unreferenced' | 'all-unreferenced'
  removedWorkspaces: number
  removedBytes: number
}

// ── Explorer (SDK find.* + file.*) ────────────────────────────────────────
// Contract between the main-process explorer handlers and the renderer's
// Explorer panel. Names mirror the SDK's FileNode / FileContent / File /
// Symbol shapes but normalized (camelCase, flattened ranges, stable arrays)
// so the renderer never touches SDK snake_case.

export interface FileNode {
  name: string
  path: string
  absolute: string
  type: 'file' | 'directory'
  ignored: boolean
}

export interface FileContent {
  type: 'text' | 'binary'
  content: string
  diff?: string | null
  patch?: string | null
  encoding?: string | null
}

export interface FileStatus {
  path: string
  added: number
  removed: number
  status: 'added' | 'deleted' | 'modified'
}

export interface ExplorerRangePos {
  line: number
  col: number
}

export interface ExplorerSymbol {
  name: string
  kind: number
  path: string
  range: {
    start: ExplorerRangePos
    end: ExplorerRangePos
  }
}

export interface TextMatch {
  path: string
  lineNumber: number
  lineText: string
  submatches: Array<{ text: string; start: number; end: number }>
}

export interface FindFilesOptions {
  query: string
  dirs?: boolean
  type?: 'file' | 'directory'
  limit?: number
}

export interface SessionArtifactRequest {
  sessionId: string
  filePath: string
}

export interface SessionArtifactExportRequest extends SessionArtifactRequest {
  suggestedName?: string
}

export interface SessionArtifact {
  id: string
  toolId: string
  toolName: string
  filePath: string
  filename: string
  order: number
  taskRunId?: string | null
}

export type DestructiveAction =
  | 'session.delete'
  | 'agent.remove'
  | 'mcp.remove'
  | 'skill.remove'

export type DestructiveConfirmationRequest =
  | {
      action: 'session.delete'
      sessionId: string
    }
  | {
      action: 'agent.remove' | 'mcp.remove' | 'skill.remove'
      target: ScopedArtifactRef
    }

export interface DestructiveConfirmationGrant {
  token: string
  expiresAt: string
}

export interface ToolCallEvent {
  type: 'tool_call'
  id: string
  name: string
  input: Record<string, unknown>
}

export interface ToolResultEvent {
  type: 'tool_result'
  id: string
  name: string
  output: unknown
  isError: boolean
}

export interface PermissionRequest {
  id: string
  sessionId: string
  taskRunId?: string | null
  tool: string
  input: Record<string, unknown>
  description: string
}

export interface McpStatus {
  name: string
  connected: boolean
  rawStatus?: string
}

export interface CustomMcpConfig {
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  label?: string
  description?: string
  type: 'stdio' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface CustomMcpTestResult {
  ok: boolean
  methods: Array<{
    id: string
    description: string
  }>
  authRequired?: boolean
  error?: string | null
}

export interface CustomSkillConfig {
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  content: string
  files?: Array<{
    path: string
    content: string
  }>
}

export type AgentColor = 'primary' | 'warning' | 'accent' | 'success' | 'info' | 'secondary'

// Inference tuning fields forwarded to OpenCode's AgentConfig. Every field is
// optional; unset fields inherit session defaults. `options` is a passthrough
// bag for provider-specific knobs (reasoning effort, max_tokens, cache
// controls) that don't have dedicated AgentConfig top-level slots.
export interface AgentInferenceOptions {
  model?: string | null
  variant?: string | null
  temperature?: number | null
  top_p?: number | null
  steps?: number | null
  options?: Record<string, unknown> | null
}

export interface CustomAgentConfig extends AgentInferenceOptions {
  scope: 'machine' | 'project'
  directory?: string | null
  name: string
  description: string
  instructions: string
  skillNames: string[]
  toolIds: string[]
  enabled: boolean
  color: AgentColor
}

export interface CustomAgentIssue {
  code: string
  message: string
}

export interface CustomAgentSummary extends CustomAgentConfig {
  writeAccess: boolean
  valid: boolean
  issues: CustomAgentIssue[]
}

export interface ScopedArtifactRef {
  name: string
  scope: 'machine' | 'project'
  directory?: string | null
}

export interface AgentCatalogTool {
  id: string
  name: string
  icon: string
  description: string
  supportsWrite: boolean
  source: 'builtin' | 'custom'
  patterns: string[]
}

export interface AgentCatalogSkill {
  name: string
  label: string
  description: string
  source: 'builtin' | 'custom'
  origin?: 'open-cowork' | 'custom'
  scope?: 'machine' | 'project' | null
  location?: string | null
  toolIds?: string[]
}

export interface AgentCatalog {
  tools: AgentCatalogTool[]
  skills: AgentCatalogSkill[]
  reservedNames: string[]
  colors: AgentColor[]
}

export interface BuiltInAgentDetail extends AgentInferenceOptions {
  name: string
  label: string
  source: 'open-cowork' | 'opencode'
  mode: 'primary' | 'subagent'
  hidden: boolean
  disabled: boolean
  color: string
  description: string
  instructions: string
  skills: string[]
  toolAccess: string[]
  nativeToolIds: string[]
  configuredToolIds: string[]
}

// Config override for one of the four Cowork built-in agents. Every field
// is optional — downstream distributions can disable an agent entirely,
// swap its model, or retune inference without replacing the prompt.
export interface BuiltInAgentOverride extends AgentInferenceOptions {
  disable?: boolean
  hidden?: boolean
  description?: string
  instructions?: string
  color?: string
}

export interface RuntimeAgentDescriptor {
  name: string
  mode?: 'primary' | 'subagent' | 'all' | null
  description?: string | null
  model?: string | null
  color?: string | null
  disabled?: boolean
}

export interface CredentialField {
  key: string
  label: string
  description: string
  placeholder?: string
  secret?: boolean
  required?: boolean
  env?: string
  runtimeKey?: string
}

// Per-model pricing + context info cached by the main process after
// fetching `client.provider.list()`. The renderer uses this to render
// per-message cost estimates and context-usage hints. Identical shape to
// what `runtime.ts:getModelInfo()` returns; kept here so the preload /
// renderer boundary has a stable contract.
export interface ModelPricing {
  inputPer1M: number
  outputPer1M: number
  cachePer1M?: number
}

export interface ModelInfoSnapshot {
  pricing: Record<string, ModelPricing>
  contextLimits: Record<string, number>
}

export interface ProviderModelDescriptor {
  id: string
  name: string
  description?: string
  // Set on models defined directly in `providers.descriptors[x].models` so
  // the picker pins them above dynamically-fetched catalog entries. Lets
  // downstream distributions keep a curated set of defaults on top while
  // still exposing the full catalog below.
  featured?: boolean
  // Optional context window (tokens). Populated from dynamic catalogs when
  // the upstream response includes it. Used by the picker to surface "long
  // context" capability at a glance.
  contextLength?: number
}

export interface ProviderDescriptor {
  id: string
  name: string
  description: string
  credentials: CredentialField[]
  models: ProviderModelDescriptor[]
}

export interface BrandingConfig {
  name: string
  appId: string
  dataDirName: string
  helpUrl: string
}

export interface PublicAppConfig {
  branding: BrandingConfig
  auth: {
    mode: 'none' | 'google-oauth'
    enabled: boolean
  }
  providers: {
    available: ProviderDescriptor[]
    defaultProvider: string | null
    defaultModel: string | null
  }
}

export interface AppSettings {
  selectedProviderId: string | null
  selectedModelId: string | null
  providerCredentials: Record<string, Record<string, string>>
  integrationCredentials: Record<string, Record<string, string>>
  enableBash: boolean
  enableFileWrite: boolean
}

export interface EffectiveAppSettings extends AppSettings {
  effectiveProviderId: string | null
  effectiveModel: string | null
}

export interface AuthState {
  authenticated: boolean
  email: string | null
}

export type {
  CapabilityToolEntry,
  CapabilitySkill,
  CapabilityTool,
  CapabilitySkillBundle,
  CapabilitySkillBundleFile,
} from './capabilities.js'

export interface OpenCoworkAPI {
  auth: {
    status: () => Promise<AuthState>
    login: () => Promise<AuthState>
  }
  session: {
    create: (directory?: string) => Promise<SessionInfo>
    activate: (sessionId: string, options?: { force?: boolean }) => Promise<SessionView>
    prompt: (sessionId: string, text: string, attachments?: Array<{ mime: string; url: string; filename?: string }>, agent?: string) => Promise<void>
    list: () => Promise<SessionInfo[]>
    get: (id: string) => Promise<SessionInfo | null>
    abort: (sessionId: string) => Promise<void>
    rename: (sessionId: string, title: string) => Promise<boolean>
    delete: (sessionId: string, confirmationToken?: string | null) => Promise<boolean>
    export: (sessionId: string) => Promise<string | null>
    fork: (sessionId: string, messageId?: string) => Promise<SessionInfo | null>
    share: (sessionId: string) => Promise<string | null>
    unshare: (sessionId: string) => Promise<boolean>
    summarize: (sessionId: string) => Promise<{ ok: true } | { ok: false, message: string }>
    revert: (sessionId: string, messageId?: string) => Promise<boolean>
    unrevert: (sessionId: string) => Promise<boolean>
    children: (sessionId: string) => Promise<any[]>
    diff: (sessionId: string, messageId?: string) => Promise<SessionFileDiff[]>
    todo: (sessionId: string) => Promise<any[]>
  }
  permission: {
    respond: (id: string, allowed: boolean) => Promise<void>
  }
  question: {
    reply: (sessionId: string, requestId: string, answers: string[][]) => Promise<void>
    reject: (sessionId: string, requestId: string) => Promise<void>
  }
  settings: {
    get: () => Promise<EffectiveAppSettings>
    set: (updates: Partial<AppSettings>) => Promise<EffectiveAppSettings>
  }
  mcp: {
    auth: (mcpName: string) => Promise<boolean>
    connect: (name: string) => Promise<void>
    disconnect: (name: string) => Promise<void>
  }
  dialog: {
    selectDirectory: () => Promise<string | null>
  }
  chart: {
    renderSvg: (spec: Record<string, unknown>) => Promise<string>
  }
  artifact: {
    export: (request: SessionArtifactExportRequest) => Promise<string | null>
    reveal: (request: SessionArtifactRequest) => Promise<boolean>
    storageStats: () => Promise<SandboxStorageStats>
    cleanup: (mode: SandboxCleanupResult['mode']) => Promise<SandboxCleanupResult>
  }
  confirm: {
    requestDestructive: (request: DestructiveConfirmationRequest) => Promise<DestructiveConfirmationGrant>
  }
  model: {
    info: () => Promise<ModelInfoSnapshot>
  }
  tools: {
    list: (options?: ToolListOptions) => Promise<any[]>
  }
  command: {
    list: () => Promise<Array<{ name: string; description?: string; source?: string }>>
    run: (sessionId: string, name: string) => Promise<boolean>
  }
  provider: {
    list: () => Promise<any[]>
  }
  runtime: {
    status: () => Promise<RuntimeStatus>
  }
  diagnostics: {
    perf: () => Promise<PerfSnapshot>
  }
  app: {
    config: () => Promise<PublicAppConfig>
    builtinAgents: () => Promise<BuiltInAgentDetail[]>
    dashboardSummary: (range?: DashboardTimeRangeKey) => Promise<DashboardSummary>
    runtimeInputs: () => Promise<RuntimeInputDiagnostics>
    refreshProviderCatalog: (providerId: string) => Promise<ProviderModelDescriptor[]>
  }
  agents: {
    catalog: (options?: RuntimeContextOptions) => Promise<AgentCatalog>
    list: (options?: RuntimeContextOptions) => Promise<CustomAgentSummary[]>
    runtime: () => Promise<RuntimeAgentDescriptor[]>
    create: (agent: CustomAgentConfig) => Promise<boolean>
    update: (target: ScopedArtifactRef, agent: CustomAgentConfig) => Promise<boolean>
    remove: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
  }
  capabilities: {
    tools: (options?: ToolListOptions) => Promise<import('./capabilities').CapabilityTool[]>
    tool: (id: string, options?: ToolListOptions) => Promise<import('./capabilities').CapabilityTool | null>
    skills: (options?: RuntimeContextOptions) => Promise<import('./capabilities').CapabilitySkill[]>
    skillBundle: (skillName: string, options?: RuntimeContextOptions) => Promise<import('./capabilities').CapabilitySkillBundle | null>
  }
  explorer: {
    fileList: (path: string, directory?: string | null) => Promise<FileNode[]>
    fileRead: (path: string, directory?: string | null) => Promise<FileContent | null>
    fileStatus: (directory?: string | null) => Promise<FileStatus[]>
    findFiles: (options: FindFilesOptions, directory?: string | null) => Promise<string[]>
    findSymbols: (query: string, directory?: string | null) => Promise<ExplorerSymbol[]>
    findText: (pattern: string, directory?: string | null) => Promise<TextMatch[]>
  }
  custom: {
    listMcps: (options?: RuntimeContextOptions) => Promise<CustomMcpConfig[]>
    addMcp: (mcp: CustomMcpConfig) => Promise<boolean>
    removeMcp: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
    testMcp: (mcp: CustomMcpConfig) => Promise<CustomMcpTestResult>
    listSkills: (options?: RuntimeContextOptions) => Promise<CustomSkillConfig[]>
    addSkill: (skill: CustomSkillConfig) => Promise<boolean>
    selectSkillDirectoryImport: () => Promise<SkillImportSelection | null>
    importSkillDirectory: (selectionToken: string, target: ScopedArtifactRef) => Promise<CustomSkillConfig>
    removeSkill: (target: ScopedArtifactRef, confirmationToken?: string | null) => Promise<boolean>
  }
  on: {
    sessionPatch: (callback: (patch: SessionPatch) => void) => () => void
    notification: (callback: (event: RuntimeNotification) => void) => () => void
    sessionView: (callback: (data: { sessionId: string; view: SessionView }) => void) => () => void
    permissionRequest: (callback: (request: PermissionRequest) => void) => () => void
    mcpStatus: (callback: (statuses: McpStatus[]) => void) => () => void
    authExpired: (callback: () => void) => () => void
    menuAction: (callback: (action: string) => void) => () => void
    menuNavigate: (callback: (view: string) => void) => () => void
    runtimeReady: (callback: () => void) => () => void
    sessionUpdated: (callback: (data: {
      id: string
      title: string | null
      parentSessionId?: string | null
      changeSummary?: SessionChangeSummary | null
      revertedMessageId?: string | null
    }) => void) => () => void
    sessionDeleted: (callback: (data: { id: string }) => void) => () => void
  }
}

export type CoworkAPI = OpenCoworkAPI

declare global {
  interface Window {
    openCowork: OpenCoworkAPI
  }
}

export * from './shortcuts.js'
